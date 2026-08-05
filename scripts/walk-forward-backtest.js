'use strict';

const fs = require('fs');
const path = require('path');

function mean(xs) { const a = xs.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function median(xs) { const a = xs.filter(Number.isFinite).sort((x,y)=>x-y); if (!a.length) return null; const i=Math.floor(a.length/2); return a.length%2?a[i]:(a[i-1]+a[i])/2; }
function std(xs) { const m = mean(xs); return m == null ? null : Math.sqrt(mean(xs.map(x => (x - m) ** 2))); }
function corr(a,b){const p=a.map((x,i)=>[x,b[i]]).filter(([x,y])=>Number.isFinite(x)&&Number.isFinite(y));if(p.length<3)return null;const mx=mean(p.map(x=>x[0])),my=mean(p.map(x=>x[1]));const num=p.reduce((s,[x,y])=>s+(x-mx)*(y-my),0);const dx=Math.sqrt(p.reduce((s,[x])=>s+(x-mx)**2,0)),dy=Math.sqrt(p.reduce((s,[,y])=>s+(y-my)**2,0));return dx&&dy?num/(dx*dy):null;}
function parseArgs() {
  const args = Object.fromEntries(process.argv.slice(2).map(x => x.split('=')));
  return { topN: Number(args['--top'] || 20), minConfidence: Number(args['--min-confidence'] || 60), horizon: Number(args['--horizon'] || 12) };
}
function config(){const url=String(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,'').replace(/\/rest\/v1$/,'');const key=String(process.env.SUPABASE_SERVICE_KEY||'').trim();if(!url||!key)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');return{url,key};}
async function loadOutcomes(horizon) {
  const {url,key}=config();
  const endpoint = new URL(`${url}/rest/v1/prediction_outcomes`);
  endpoint.searchParams.set('select', '*,model_predictions(investment_score,confidence,margin_of_safety,quality_score,moat_score,capital_allocation_score,pricing_score)');
  endpoint.searchParams.set('horizon_months', `eq.${horizon}`);
  endpoint.searchParams.set('order', 'snapshot_date.asc');
  endpoint.searchParams.set('limit', '100000');
  const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
function score(row) {
  const p = row.model_predictions || {};
  const investment = Number(p.investment_score) || 0;
  const expected = Number(row.expected_cagr) || -1;
  const confidence = Number(p.confidence) || 0;
  const mos = Number(p.margin_of_safety) || 0;
  return investment * .62 + expected * 100 * .23 + confidence * .10 + Math.max(-25, Math.min(25, mos * 100)) * .05;
}
function summarize(rows){
  const realized=rows.map(r=>Number(r.realized_cagr)); const expected=rows.map(r=>Number(r.expected_cagr));
  const alpha=rows.map(r=>Number(r.realized_alpha)); const qalpha=rows.map(r=>Number(r.alpha_vs_qqq));
  return { observations:rows.length, expectedCAGR:mean(expected), realizedCAGR:mean(realized), medianRealizedCAGR:median(realized),
    alphaVsSPY:mean(alpha), alphaVsQQQ:mean(qalpha), beatSPYRate:mean(alpha.map(x=>x>0?1:0)), beatQQQRate:mean(qalpha.filter(Number.isFinite).map(x=>x>0?1:0)),
    bias:mean(realized.map((x,i)=>x-expected[i])), mae:mean(realized.map((x,i)=>Math.abs(x-expected[i]))), correlation:corr(expected,realized), volatility:std(realized)};
}
function group(rows,key){const out={};for(const v of [...new Set(rows.map(r=>r[key]||'Unknown'))])out[v]=summarize(rows.filter(r=>(r[key]||'Unknown')===v));return out;}
function deciles(rows){const sorted=[...rows].sort((a,b)=>score(b)-score(a));const out={};for(let d=0;d<10;d++){const lo=Math.floor(sorted.length*d/10),hi=Math.floor(sorted.length*(d+1)/10);out[`D${d+1}`]=summarize(sorted.slice(lo,hi));}return out;}
async function main() {
  const { topN, minConfidence, horizon } = parseArgs();
  const rows = await loadOutcomes(horizon);
  const eligible = rows.filter(r => Number.isFinite(Number(r.realized_cagr)) && Number(r.model_predictions?.confidence || 0) >= minConfidence);
  const dates = [...new Set(eligible.map(r => r.snapshot_date))].sort();
  const cohorts = [];
  for (const date of dates) {
    const universe = eligible.filter(r => r.snapshot_date === date);
    const selected = [...universe].sort((a,b)=>score(b)-score(a)).slice(0,topN);
    if (!selected.length) continue;
    cohorts.push({ snapshotDate:date, holdings:selected.length, ...summarize(selected), tickers:selected.map(r=>r.ticker) });
  }
  const report = {
    generatedAt:new Date().toISOString(), methodology:'Independent point-in-time cohorts using stored predictions and fixed post-snapshot horizons. Cohorts are not chained into a misleading equity curve.',
    horizonMonths:horizon, topN, minConfidence, observations:eligible.length, cohortCount:cohorts.length,
    allEligible:summarize(eligible), topPortfolio:summarize(cohorts.flatMap(c=>eligible.filter(r=>r.snapshot_date===c.snapshotDate).sort((a,b)=>score(b)-score(a)).slice(0,topN))),
    byRating:group(eligible,'rating'), byCategory:group(eligible,'category'), byIndustry:group(eligible,'industry'), byEngineVersion:group(eligible,'engine_version'),
    investmentScoreDeciles:deciles(eligible), cohorts,
  };
  const d1=report.investmentScoreDeciles.D1, d10=report.investmentScoreDeciles.D10;
  report.topMinusBottomSpread = d1?.realizedCAGR != null && d10?.realizedCAGR != null ? d1.realizedCAGR-d10.realizedCAGR : null;
  const out=path.join(__dirname,'..','data','walk-forward-backtest.json'); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,JSON.stringify(report,null,2));
  console.log(JSON.stringify({horizonMonths:horizon,observations:eligible.length,cohorts:cohorts.length,allEligible:report.allEligible,topMinusBottomSpread:report.topMinusBottomSpread},null,2));
}
main().catch(error=>{console.error(error);process.exit(1);});
