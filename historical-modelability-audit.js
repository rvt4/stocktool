'use strict';
/**
 * v12.55.4 Historical Modelability Audit
 *
 * Measures how much of the validated 2007-2018 point-in-time IWB universe can
 * actually pass the production historical model pipeline without substituting
 * current constituents or silently dropping unresolved identities.
 *
 * This is an audit only: it does not change ranking, valuation, selection, or
 * portfolio logic. Missing requested archive snapshots are reported and skipped by
 * this audit rather than filled with current or future membership.
 */
const fs=require('fs');
const path=require('path');
const {
  fetchSecFactsByCik, fetchBacktestHistory, normalizeSecTicker
}=require('./data-fetchers');
const {
  loadCachedIsharesSnapshots, historicalStockFromData
}=require('./backtest');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');

const START=Math.max(2007,Number(process.env.MODELABILITY_START||2007));
const END=Math.min(2018,Number(process.env.MODELABILITY_END||2018));
const FREQUENCY=String(process.env.MODELABILITY_FREQUENCY||'quarterly').toLowerCase();
const LIMIT=Math.max(0,Number(process.env.MODELABILITY_LIMIT||0));
const DELAY=Math.max(0,Number(process.env.MODELABILITY_DELAY_MS||150));
const HISTORY_YEARS=Math.max(12,new Date().getUTCFullYear()-START+2);
const OUT=path.join(__dirname,'data','historical-modelability-audit.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const finite=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};

function snapshotDates(){
  const out=[];
  for(let y=START;y<=END;y++){
    if(FREQUENCY==='quarterly')for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);
    else out.push(`${y}-12-31`);
  }
  return out;
}
function rowWeight(h){
  // v12.55.2 cache rows did not preserve Product Data weights, but support them
  // automatically if a future coverage refresh does. Percent values may be 0-100.
  for(const key of ['holdingPercent','weight','portfolioWeight']){
    const n=finite(h?.[key]);
    if(n!=null&&n>=0)return n>1?n/100:n;
  }
  const mv=finite(h?.marketValue);
  return mv!=null&&mv>=0?mv:null;
}
function inferFailure(before,after){
  if((after.insufficientFinancialHistory||0)>(before.insufficientFinancialHistory||0))return 'insufficient_financial_history';
  if((after.missingHistoricalPrice||0)>(before.missingHistoricalPrice||0))return 'missing_historical_price';
  if((after.missingShareCount||0)>(before.missingShareCount||0))return 'missing_share_count';
  return 'historical_stock_unavailable';
}
function pct(n,d){return d>0?n/d:null;}
function blankSnapshot(asOf,source){
  return {asOf,sourceAsOf:source?.reportDate||null,membershipSourceDate:source?.membershipSourceDate||null,sourceType:source?.sourceType||null,holdings:0,identityResolved:0,identityResolvedRate:null,secFactsAvailable:0,secFactsAvailableRate:null,priceHistoryAvailable:0,priceHistoryAvailableRate:null,usableFinancialHistory:0,usableFinancialHistoryRate:null,shareCountAvailable:0,shareCountAvailableRate:null,modelRuns:0,modelable:0,modelableRate:null,weightedCoverageAvailable:false,modelableWeightCoverage:null,failureReasons:{}};
}
function addReason(s,reason,n=1){s.failureReasons[reason]=(s.failureReasons[reason]||0)+n;}
function summarizeYear(rows){
  const groups=new Map();
  for(const r of rows){const y=r.asOf.slice(0,4);if(!groups.has(y))groups.set(y,[]);groups.get(y).push(r);}
  return [...groups.entries()].map(([year,x])=>{
    const holdings=x.reduce((a,r)=>a+r.holdings,0),modelable=x.reduce((a,r)=>a+r.modelable,0),identityResolved=x.reduce((a,r)=>a+r.identityResolved,0);
    return {year,snapshots:x.length,holdings,identityResolved,identityResolvedRate:pct(identityResolved,holdings),modelable,modelableRate:pct(modelable,holdings),minSnapshotModelableRate:Math.min(...x.map(r=>r.modelableRate??1)),meanSnapshotModelableRate:x.reduce((a,r)=>a+(r.modelableRate||0),0)/x.length};
  });
}
async function main(){
  if(START>END)throw new Error(`Invalid modelability range ${START}-${END}.`);
  const identityPath=path.join(__dirname,'data','historical-security-identity.json');
  if(!fs.existsSync(identityPath))throw new Error('Run Historical Security Identity Audit first; data/historical-security-identity.json is missing.');
  const identity=JSON.parse(fs.readFileSync(identityPath,'utf8'));
  if(!String(identity.version||'').startsWith('v12.55.3'))throw new Error(`Historical identity audit is stale (${identity.version||'unknown'}). Expected v12.55.3.`);

  const requestedDates=snapshotDates();
  const cacheDir=path.join(__dirname,'data','historical-universe');
  const dates=requestedDates.filter(d=>fs.existsSync(path.join(cacheDir,`iwb-${d}.json`)));
  const unavailableSnapshots=requestedDates.filter(d=>!dates.includes(d));
  if(!dates.length)throw new Error('No exact validated historical-universe cache snapshots exist in the requested range.');
  const cached=loadCachedIsharesSnapshots(dates,new Map());
  if(cached.missing.length)throw new Error(`Validated historical universe cache invalid for: ${cached.missing.join(', ')}.`);

  const snapshots=new Map();
  for(const asOf of dates){
    const snap=cached.out.get(asOf); const s=blankSnapshot(asOf,snap); snapshots.set(asOf,s);
    for(const h of snap?.holdings||[]){
      s.holdings++;
      if(h.secCik)s.identityResolved++;else addReason(s,'identity_unresolved');
    }
    s.identityResolvedRate=pct(s.identityResolved,s.holdings);
  }

  // Fetch once per CIK+ticker pair. SEC facts are stable by CIK; price history is
  // symbol-specific, so share classes remain distinct rather than being collapsed.
  const work=new Map();
  for(const asOf of dates){
    const snap=cached.out.get(asOf);
    for(const h of snap?.holdings||[]){
      if(!h.secCik)continue;
      const ticker=normalizeSecTicker(h.ticker||h.historicalTicker);
      const key=`${h.secCik}|${ticker}`;
      if(!work.has(key))work.set(key,{key,cik:h.secCik,ticker,dates:[]});
      work.get(key).dates.push({asOf,holding:h});
    }
  }
  let jobs=[...work.values()]; if(LIMIT)jobs=jobs.slice(0,LIMIT);
  const allowedKeys=new Set(jobs.map(x=>x.key));
  if(LIMIT){
    // Diagnostic-only test mode: remove unprocessed resolved rows from denominators
    // rather than misclassifying them as failures.
    for(const asOf of dates){
      const snap=cached.out.get(asOf),s=snapshots.get(asOf); let omitted=0;
      for(const h of snap?.holdings||[]){if(h.secCik&&!allowedKeys.has(`${h.secCik}|${normalizeSecTicker(h.ticker||h.historicalTicker)}`))omitted++;}
      if(omitted){s.holdings-=omitted;s.identityResolved-=omitted;s.identityResolvedRate=pct(s.identityResolved,s.holdings);s.limitOmitted=omitted;}
    }
  }

  const fetchErrors=[];
  const examples=[];
  for(let i=0;i<jobs.length;i++){
    const job=jobs[i]; let facts=null,history=null;
    try{facts=await fetchSecFactsByCik(job.cik,job.ticker);}catch(e){fetchErrors.push({ticker:job.ticker,cik:job.cik,stage:'sec_facts',error:e.message});}
    if(facts){
      for(const d of job.dates)if(allowedKeys.has(job.key))snapshots.get(d.asOf).secFactsAvailable++;
    }
    try{history=await fetchBacktestHistory(job.ticker,HISTORY_YEARS);}catch(e){fetchErrors.push({ticker:job.ticker,cik:job.cik,stage:'price_history',error:e.message});history=[];}
    if(history?.length){for(const d of job.dates)if(allowedKeys.has(job.key))snapshots.get(d.asOf).priceHistoryAvailable++;}

    for(const {asOf,holding} of job.dates){
      if(!allowedKeys.has(job.key))continue;
      const s=snapshots.get(asOf);
      if(!facts){addReason(s,'sec_facts_fetch_failed');continue;}
      if(!history?.length){addReason(s,'price_history_empty');continue;}
      const diagnostics={usableFinancialHistory:0,insufficientFinancialHistory:0,historicalPriceFound:0,missingHistoricalPrice:0,shareCountFound:0,missingShareCount:0};
      const before={...diagnostics};
      let stock=null;
      try{stock=historicalStockFromData(job.ticker,holding.sector,facts,history,asOf,diagnostics);}catch(e){addReason(s,'historical_stock_exception');if(examples.length<30)examples.push({ticker:job.ticker,asOf,reason:'historical_stock_exception',error:e.message});continue;}
      if(diagnostics.usableFinancialHistory>0)s.usableFinancialHistory++;
      if(diagnostics.shareCountFound>0)s.shareCountAvailable++;
      if(!stock){const reason=inferFailure(before,diagnostics);addReason(s,reason);if(examples.length<30)examples.push({ticker:job.ticker,asOf,reason});continue;}
      s.modelRuns++;
      try{
        const f=buildForecast(stock),q=computeQuality(stock,f),v=valuate(stock,f,q),d=rateStock(stock,f,q,v);
        if(!Number.isFinite(v.expectedCAGR)){addReason(s,'missing_expected_cagr');if(examples.length<30)examples.push({ticker:job.ticker,asOf,reason:'missing_expected_cagr',rating:d?.rating||null});continue;}
        s.modelable++;
      }catch(e){addReason(s,'model_failure');if(examples.length<30)examples.push({ticker:job.ticker,asOf,reason:'model_failure',error:e.message});}
    }
    if((i+1)%25===0||i===jobs.length-1)console.log(`Modelability fetch ${i+1}/${jobs.length}; completed snapshot observations=${[...snapshots.values()].reduce((a,s)=>a+s.modelable,0)}.`);
    if(DELAY)await sleep(DELAY);
  }

  const coverage=[];
  for(const asOf of dates){
    const snap=cached.out.get(asOf),s=snapshots.get(asOf);
    s.secFactsAvailableRate=pct(s.secFactsAvailable,s.holdings);
    s.priceHistoryAvailableRate=pct(s.priceHistoryAvailable,s.holdings);
    s.usableFinancialHistoryRate=pct(s.usableFinancialHistory,s.holdings);
    s.shareCountAvailableRate=pct(s.shareCountAvailable,s.holdings);
    s.modelableRate=pct(s.modelable,s.holdings);

    const weights=(snap?.holdings||[]).map(h=>({h,w:rowWeight(h)}));
    const present=weights.filter(x=>x.w!=null);
    if(present.length===s.holdings&&s.holdings>0){
      const usingMarketValue=present.some(x=>finite(x.h?.marketValue)!=null)&&!present.some(x=>finite(x.h?.holdingPercent)!=null||finite(x.h?.weight)!=null||finite(x.h?.portfolioWeight)!=null);
      const denom=present.reduce((a,x)=>a+x.w,0);
      // We deliberately do not attempt to reconstruct per-row modelability here
      // unless cache weights are available and the row is represented by a modelable
      // key in a future enriched cache. Current v12.55.2 caches omit weights.
      s.weightedCoverageAvailable=denom>0;
      s.weightBasis=usingMarketValue?'market_value':'portfolio_weight';
    }
    coverage.push(s);
  }

  const totalHoldings=coverage.reduce((a,s)=>a+s.holdings,0),totalResolved=coverage.reduce((a,s)=>a+s.identityResolved,0),totalModelable=coverage.reduce((a,s)=>a+s.modelable,0);
  const report={
    generatedAt:new Date().toISOString(),version:'v12.55.4-historical-modelability-audit',requested:{startYear:START,endYear:END,frequency:FREQUENCY,limit:LIMIT||null,requestedSnapshots:requestedDates.length,unavailableSnapshots},
    guardrails:[
      'Point-in-time IWB membership is read only from validated historical-universe cache files.',
      'No current-constituent membership fallback is permitted.',
      'Unresolved historical identities count against modelability coverage rather than being silently removed.',
      'SEC facts are filtered by the historical model using filing/end dates as of each snapshot.',
      'A row is modelable only when the production forecast, quality, valuation, and rating pipeline returns a finite expected CAGR.',
      'Missing requested snapshots are reported and excluded; the audit never carries membership forward across an unavailable quarter.'
    ],
    summary:{requestedSnapshots:requestedDates.length,auditedSnapshots:coverage.length,unavailableSnapshots,holdingObservations:totalHoldings,identityResolved:totalResolved,identityResolvedRate:pct(totalResolved,totalHoldings),modelable:totalModelable,modelableRate:pct(totalModelable,totalHoldings),minSnapshotModelableRate:Math.min(...coverage.map(s=>s.modelableRate??1)),meanSnapshotModelableRate:coverage.reduce((a,s)=>a+(s.modelableRate||0),0)/coverage.length,weightedCoverageAvailable:coverage.some(s=>s.weightedCoverageAvailable),weightedCoverageNote:coverage.some(s=>s.weightedCoverageAvailable)?'Historical cache contains weight/value fields; inspect per-snapshot fields.':'v12.55.2 historical cache rows do not preserve IWB holding weights/market values, so count-weighted modelability is authoritative for this run. No weights were fabricated.'},
    byYear:summarizeYear(coverage),coverage,representativeFailures:examples,fetchErrors:fetchErrors.slice(0,200)
  };
  fs.mkdirSync(path.dirname(OUT),{recursive:true});const tmp=OUT+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2));fs.renameSync(tmp,OUT);
  console.log(`Wrote ${path.relative(__dirname,OUT)}. Modelable ${totalModelable}/${totalHoldings} (${(100*totalModelable/totalHoldings).toFixed(1)}%).`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});
module.exports={rowWeight,inferFailure,summarizeYear};
