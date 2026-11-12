'use strict';
// Build 66: forecast scorecard. Did the projections come true?
//
// The backtest already asks "did the ranked stocks beat SPY?". It never asked whether the
// forecasts behind those ranks were right. This module answers that with data already in
// the backtest: at every point-in-time snapshot it saves the model's year 1-5 revenue, GAAP net
// margin and FCF margin, then compares them with what the company later reported (SEC facts
// from the latest filings), next to three naive forecasts that need no model at all:
//
//   trend : revenue keeps growing at its trailing 3-year CAGR (clamped -30%..+50%)
//   fade  : that growth fades in a straight line to 4% by year 5      (the usual analyst-free baseline)
//   flat  : revenue stays where it is                                   (sanity floor)
//   margins: last year's margin persists / the 3-year median persists
//
// If the model can't beat "fade" and "3-year median margin", its extra rules are adding noise.
// The by-flag table shows, for every rule that fires (peak_margin_reversion, margin_evidence_ceiling,
// structural_revenue_step_up_detected ...), whether the stocks it fired on were forecast better
// or worse than the naive baseline. That is the evidence for keeping, retuning or removing a rule.
//
// Caveat: historical snapshots have no analyst estimates, so rules that need consensus
// (analyst margin anchor, long-term consensus growth, consensus dip) cannot fire here. Those are
// measured going forward by track-forecasts.js.
//
// Revenue error  = ln(actual / forecast)  (positive = model too LOW)
// Margin error   = actual - forecast, in margin points (0.02 = 2 points; positive = model too LOW)

const finite=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const median=a=>{const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const mean=a=>{const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;};
const r4=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;

const HORIZONS=[1,2,3,4,5];
const FADE_TARGET=.04;
const MIN_GROUP=25;

function margin(num,rev){num=finite(num);rev=finite(rev);return num!=null&&rev>0?num/rev:null;}

// Snapshot-time inputs for the naive baselines, from the same point-in-time history the model saw.
function baselineInputs(years){
  const ys=(years||[]).filter(y=>finite(y.revenue)>0&&!y.revenueIsProxy);
  if(ys.length<2)return null;
  const last=ys.at(-1),lb=Math.min(3,ys.length-1),first=ys[ys.length-1-lb];
  const g3=Math.pow(last.revenue/first.revenue,1/lb)-1;
  const recent=ys.slice(-3);
  const net=recent.map(y=>margin(y.netIncome,y.revenue)),fcf=recent.map(y=>margin(y.fcf,y.revenue));
  return {baseYear:finite(last.year),baseRevenue:last.revenue,g3:Number.isFinite(g3)?clamp(g3,-.30,.50):null,
    lastNet:net.at(-1),medNet:median(net),lastFcf:fcf.at(-1),medFcf:median(fcf)};
}

// Called once per (ticker, snapshot) right after buildForecast. Small on purpose.
function captureForecast(stock,f,asOf){
  const b=baselineInputs(stock?.financials?.years);
  const rows=f?.rows||[];
  if(!b||b.baseYear==null||!rows.length)return null;
  const h=HORIZONS.map(k=>{const r=rows[k-1];if(!r)return null;
    return [finite(r.year),finite(r.revenue),finite(r.gaapNetMargin??r.netMargin),finite(r.preSbcFcfMargin??r.fcfMargin)];});
  if(!h[0]||h[0][0]!==b.baseYear+1)return null; // year labels must line up with the reported base year
  // Build 75b: where the steady-margin-climb rule changed the forecast, also keep the forecast without it.
  let alt=null;
  if((f.forecastFlags||[]).includes('steady_margin_climb_applied')){
    try{const f2=require('./engine/forecast-engine').buildForecast(stock,{marginTrend:false});const r2=f2?.rows||[];
      alt=HORIZONS.map(k=>{const r=r2[k-1];return r?[finite(r.year),finite(r.gaapNetMargin??r.netMargin),finite(r.preSbcFcfMargin??r.fcfMargin)]:null;});}catch(e){alt=null;}
  }
  return {ticker:stock.ticker,asOf,sector:stock.sector||'Unknown',category:f.category||null,
    reliability:finite(f.forecastReliabilityScore),flags:[...new Set(f.forecastFlags||[])],...b,h,alt};
}

function baselineRevenue(b,k){
  if(b.g3==null)return {trend:null,fade:null,flat:b.baseRevenue};
  let fade=b.baseRevenue;for(let i=1;i<=k;i++)fade*=1+b.g3+(FADE_TARGET-b.g3)*Math.min(1,i/5);
  return {trend:b.baseRevenue*Math.pow(1+b.g3,k),fade,flat:b.baseRevenue};
}

// Compare captured forecasts with the reported years (parsed from the company's full, latest facts).
function scoreForecasts(observations,actualYears){
  const byYear=new Map();
  for(const y of actualYears||[]){if(finite(y.year)!=null&&finite(y.revenue)>0&&!y.revenueIsProxy)byYear.set(Number(y.year),y);}
  const out=[];
  for(const o of observations||[]){
    if(!o)continue;
    HORIZONS.forEach((k,i)=>{
      const fc=o.h[i];if(!fc)return;
      const [year,rev,net,fcf]=fc,a=byYear.get(year);if(!a||!(rev>0))return;
      const ar=a.revenue,an=margin(a.netIncome,ar),af=margin(a.fcf,ar);
      const base=baselineRevenue(o,k);
      const le=(act,fc)=>act>0&&fc>0?Math.log(act/fc):null;
      // Margin points; extreme ratios (tiny revenue, tagging accidents) are capped so medians stay honest.
      const pe=(act,fc)=>act!=null&&fc!=null?clamp(act,-1,1)-clamp(fc,-1,1):null;
      out.push({t:o.ticker,asOf:o.asOf,k,rank:null,sector:o.sector,category:o.category,reliability:o.reliability,flags:o.flags,
        fg:Math.pow(rev/o.baseRevenue,1/k)-1,bg:base.fade>0?Math.pow(base.fade/o.baseRevenue,1/k)-1:null,ag:Math.pow(ar/o.baseRevenue,1/k)-1,
        rev:{model:le(ar,rev),trend:le(ar,base.trend),fade:le(ar,base.fade),flat:le(ar,base.flat)},
        net:{model:pe(an,net),last:pe(an,o.lastNet),median3:pe(an,o.medNet)},
        fcf:{model:pe(af,fcf),last:pe(af,o.lastFcf),median3:pe(af,o.medFcf)},
        alt:o.alt&&o.alt[i]&&o.alt[i][0]===year?{net:pe(an,o.alt[i][1]),fcf:pe(af,o.alt[i][2])}:null});
    });
  }
  return out;
}

// One metric (rev / net / fcf) for a list of scored rows.
function metricStats(rows,metric,baselines){
  const v=rows.filter(r=>Number.isFinite(r[metric].model));
  if(!v.length)return null;
  const errs=v.map(r=>r[metric].model),abs=errs.map(Math.abs);
  const s={n:v.length,bias:r4(median(errs)),medianAbsError:r4(median(abs)),meanAbsError:r4(mean(abs))};
  if(metric==='rev'){s.within10pct=r4(abs.filter(x=>x<=Math.log(1.10)).length/abs.length);s.offByMoreThan2x=r4(abs.filter(x=>x>Math.log(2)).length/abs.length);}
  else s.within2pts=r4(abs.filter(x=>x<=.02).length/abs.length);
  s.vs={};
  for(const b of baselines){
    const pair=v.filter(r=>Number.isFinite(r[metric][b]));if(!pair.length)continue;
    const mAbs=median(pair.map(r=>Math.abs(r[metric].model))),bAbs=median(pair.map(r=>Math.abs(r[metric][b])));
    s.vs[b]={baselineMedianAbsError:r4(bAbs),
      skill:bAbs>0?r4(1-mAbs/bAbs):null,                                    // >0 = model beats baseline
      modelCloserRate:r4(pair.filter(r=>Math.abs(r[metric].model)<Math.abs(r[metric][b])).length/pair.length)};
  }
  return s;
}
const REV_BASE=['fade','trend','flat'],MARGIN_BASE=['median3','last'];
function block(rows){return {n:rows.length,revenue:metricStats(rows,'rev',REV_BASE),netMargin:metricStats(rows,'net',MARGIN_BASE),fcfMargin:metricStats(rows,'fcf',MARGIN_BASE)};}
function groupBy(rows,keyFn,min=MIN_GROUP){
  const g={};for(const r of rows){const ks=[].concat(keyFn(r)).filter(x=>x!=null);for(const k of ks)(g[k]??=[]).push(r);}
  return Object.fromEntries(Object.entries(g).filter(([,v])=>v.length>=min).sort((a,b)=>b[1].length-a[1].length).map(([k,v])=>[k,block(v)]));
}
function rankBucket(r){if(!Number.isFinite(r))return null;return r<=20?'1-20':r<=50?'21-50':r<=100?'51-100':r<=250?'101-250':'251+';}
// Build 71: for each live-rank bucket, how optimistic was the model vs what happened (median forecast vs actual CAGR)?
function byRankTable(rows){
  const order=['1-20','21-50','51-100','101-250','251+'],g={};
  for(const r of rows){const b=rankBucket(r.rank);if(b)(g[b]??=[]).push(r);}
  return order.filter(b=>g[b]&&g[b].length>=10).map(b=>{const v=g[b],x=block(v);
    return {rank:b,n:v.length,medianForecastCAGR:r4(median(v.map(r=>r.fg))),medianActualCAGR:r4(median(v.map(r=>r.ag))),
      revenueBias:x.revenue?.bias??null,revenueSkillVsFade:x.revenue?.vs?.fade?.skill??null,netMarginBias:x.netMargin?.bias??null,
      netMarginMedianAbsError:x.netMargin?.medianAbsError??null,fcfMarginBias:x.fcfMargin?.bias??null};});
}
function growthBucket(g){if(!Number.isFinite(g))return null;return g<0?'<0%':g<.05?'0-5%':g<.10?'5-10%':g<.20?'10-20%':g<.30?'20-30%':'30%+';}
function reliabilityBucket(x){if(!Number.isFinite(x))return null;const v=x>1?x:x*100;return v<40?'<40':v<55?'40-55':v<70?'55-70':v<85?'70-85':'85+';}

// Growth calibration: within each forecast-growth bucket, what did companies actually grow?
// A well-calibrated model has median actual ~= median forecast in every bucket.
function calibration(rows){
  const g={};for(const r of rows){const b=growthBucket(r.fg);if(b)(g[b]??=[]).push(r);}
  const order=['<0%','0-5%','5-10%','10-20%','20-30%','30%+'];
  return order.filter(b=>g[b]).map(b=>({forecastCAGR:b,n:g[b].length,medianForecastCAGR:r4(median(g[b].map(r=>r.fg))),medianActualCAGR:r4(median(g[b].map(r=>r.ag))),
    medianFadeBaselineCAGR:r4(median(g[b].map(r=>r.bg)))}));
}

// Per-rule verdict at one horizon: does the cohort a flag fires on get forecast better than the
// naive baseline, and better than stocks where the flag did NOT fire?
function flagTable(rows){
  const all=new Set();for(const r of rows)for(const f of r.flags||[])all.add(f);
  const out=[];
  for(const flag of all){
    const on=rows.filter(r=>r.flags.includes(flag)),off=rows.filter(r=>!r.flags.includes(flag));
    if(on.length<MIN_GROUP)continue;
    const b=block(on),c=block(off);
    out.push({flag,n:on.length,
      revenueBias:b.revenue?.bias??null,revenueSkillVsFade:b.revenue?.vs?.fade?.skill??null,revenueSkillVsFadeWhenOff:c.revenue?.vs?.fade?.skill??null,
      netMarginBias:b.netMargin?.bias??null,netMarginSkillVsMedian3:b.netMargin?.vs?.median3?.skill??null,netMarginSkillVsMedian3WhenOff:c.netMargin?.vs?.median3?.skill??null,
      fcfMarginBias:b.fcfMargin?.bias??null,fcfMarginSkillVsMedian3:b.fcfMargin?.vs?.median3?.skill??null});
  }
  return out.sort((a,b)=>b.n-a.n);
}

function verdictLines(byH){
  const lines=[];
  for(const [h,b] of Object.entries(byH)){
    const rv=b.revenue,nm=b.netMargin;if(!rv)continue;
    const fade=rv.vs.fade?.skill,med=nm?.vs?.median3?.skill;
    lines.push(`${h}: revenue off by a median ${(100*(Math.exp(rv.medianAbsError)-1)).toFixed(1)}% (bias ${(100*(Math.exp(rv.bias)-1)).toFixed(1)}%, `+
      `${fade==null?'n/a':fade>=0?`${(100*fade).toFixed(0)}% better than`:`${(-100*fade).toFixed(0)}% WORSE than`} the naive fade); `+
      (nm?`net margin off by ${(100*nm.medianAbsError).toFixed(1)} pts (bias ${(100*nm.bias).toFixed(1)} pts, `+
      `${med==null?'n/a':med>=0?`${(100*med).toFixed(0)}% better than`:`${(-100*med).toFixed(0)}% WORSE than`} "3-yr median margin persists")`:'net margin n/a'));
  }
  return lines;
}

// Build 75b: same companies and dates, forecast with vs without the steady-margin-climb rule.
function marginTrendTest(scored){
  const out={};
  for(const k of HORIZONS){
    const rows=scored.filter(r=>r.k===k&&r.alt);
    const pair=(m)=>{const v=rows.filter(r=>Number.isFinite(r[m].model)&&Number.isFinite(r.alt[m]));if(!v.length)return null;
      const w=v.map(r=>r[m].model),wo=v.map(r=>r.alt[m]);
      const mae=a=>r4(median(a.map(Math.abs)));
      return {n:v.length,withRule:{bias:r4(median(w)),medianAbsError:mae(w)},withoutRule:{bias:r4(median(wo)),medianAbsError:mae(wo)},
        ruleCloserRate:r4(v.filter(r=>Math.abs(r[m].model)<Math.abs(r.alt[m])).length/v.length)};};
    if(rows.length)out[`year ${k}`]={netMargin:pair('net'),fcfMargin:pair('fcf')};
  }
  return {readMe:'Forecasts where the rule fired, scored with and without it against what the companies reported. Lower medianAbsError and ruleCloserRate > 0.5 = the rule helps. Bias > 0 = forecast too LOW.',byHorizon:out};
}

function buildScorecard(scored,{modelVersion=null}={}){
  const byHorizon={};for(const k of HORIZONS){const rows=scored.filter(r=>r.k===k);if(rows.length)byHorizon[`year ${k}`]=block(rows);}
  const h3=scored.filter(r=>r.k===3),h1=scored.filter(r=>r.k===1);
  const focus=h3.length>=MIN_GROUP*4?h3:h1,focusLabel=focus===h3?'year 3':'year 1';
  return {
    generatedAt:new Date().toISOString(),modelVersion,
    readMe:['Revenue error = ln(actual/forecast); bias > 0 means the model forecast too LOW. Margin errors are in margin points (0.02 = 2 pts).',
      'skill = 1 - model median abs error / baseline median abs error. Positive = the model beats that naive forecast; negative = the naive forecast was more accurate.',
      'Baselines: fade = trailing 3-yr revenue CAGR fading to 4% by year 5; trend = trailing CAGR held; flat = no growth; median3 / last = margin persists.',
      'Historical runs have no analyst estimates, so consensus-based rules are not tested here (see forecast-accuracy.json for live tracking).',
      `Group tables (by growth, sector, category, reliability, flag, snapshot year) use the ${focusLabel} horizon.`],
    observations:scored.length,uniqueTickers:new Set(scored.map(r=>r.t)).size,
    headline:verdictLines(byHorizon),
    byHorizon,
    growthCalibration:{horizon:focusLabel,rows:calibration(focus)},
    byForecastGrowth:groupBy(focus,r=>growthBucket(r.fg)),
    byReliabilityScore:groupBy(focus,r=>reliabilityBucket(r.reliability)),
    byCategory:groupBy(focus,r=>r.category||'unknown'),
    bySector:groupBy(focus,r=>r.sector||'Unknown'),
    bySnapshotYear:groupBy(focus,r=>String(r.asOf).slice(0,4)),
    byFlag:{horizon:focusLabel,rows:flagTable(focus)},
    marginTrendTest:marginTrendTest(scored),
    byRank:{horizon:focusLabel,note:'Live rank at the snapshot (owner rule). Negative bias = model too optimistic.',rows:byRankTable(focus)},
    worstRevenueMisses:focus.filter(r=>Number.isFinite(r.rev.model)).sort((a,b)=>Math.abs(b.rev.model)-Math.abs(a.rev.model)).slice(0,30)
      .map(r=>({ticker:r.t,asOf:r.asOf,forecastCAGR:r4(r.fg),actualCAGR:r4(r.ag),fadeBaselineError:r4(r.rev.fade),modelError:r4(r.rev.model),flags:r.flags}))
  };
}

module.exports={marginTrendTest,captureForecast,scoreForecasts,buildScorecard,baselineInputs,baselineRevenue,HORIZONS};
