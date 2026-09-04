'use strict';
/** v12.55.5 Historical Fundamentals Recovery Audit */
const fs=require('fs'),path=require('path');
const {fetchSecFactsByCik,fetchBacktestHistory,normalizeSecTicker}=require('./data-fetchers');
const {loadCachedIsharesSnapshots,historicalStockFromData}=require('./backtest');
const {recoverAnnualFinancialsByCik}=require('./historical-fundamentals-recovery');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const START=Number(process.env.RECOVERY_START||2007),END=Number(process.env.RECOVERY_END||2011);
const FREQUENCY=String(process.env.RECOVERY_FREQUENCY||'quarterly').toLowerCase();
const DELAY=Number(process.env.RECOVERY_DELAY_MS||75),LIMIT=Number(process.env.RECOVERY_LIMIT||0)||null;
const OUT=path.join(__dirname,'data','historical-fundamentals-recovery-audit.json');
const HISTORY_YEARS=Math.max(18,new Date().getUTCFullYear()-START+5);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pct=(a,b)=>b?a/b:null;
function dates(){const out=[];for(let y=START;y<=END;y++){if(FREQUENCY==='annual')out.push(`${y}-12-31`);else for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);}return out;}
function runModel(stock){if(!stock)return {ok:false,reason:'historical_stock_unavailable'};try{const f=buildForecast(stock),q=computeQuality(stock,f),v=valuate(stock,f,q),d=rateStock(stock,f,q,v);return Number.isFinite(v.expectedCAGR)?{ok:true,expectedCAGR:v.expectedCAGR,rating:d?.rating||null}:{ok:false,reason:'missing_expected_cagr'};}catch(e){return {ok:false,reason:'model_failure',error:e.message};}}
function summarizeYear(rows){const m=new Map();for(const r of rows){const y=r.asOf.slice(0,4);if(!m.has(y))m.set(y,[]);m.get(y).push(r);}return [...m].map(([year,x])=>{const holdings=x.reduce((a,r)=>a+r.holdings,0),resolved=x.reduce((a,r)=>a+r.identityResolved,0),base=x.reduce((a,r)=>a+r.baselineModelable,0),rec=x.reduce((a,r)=>a+r.recoveredModelable,0);return {year,snapshots:x.length,holdings,identityResolved:resolved,baselineModelable:base,baselineModelableRate:pct(base,holdings),recoveredModelable:rec,recoveredModelableRate:pct(rec,holdings),incrementalRecovered:rec-base,incrementalRecoveryRate:pct(rec-base,holdings)};});}
async function main(){
  if(START>END||END>2018)throw new Error(`Invalid recovery range ${START}-${END}.`);
  const requested=dates(),cacheDir=path.join(__dirname,'data','historical-universe');
  const available=requested.filter(d=>fs.existsSync(path.join(cacheDir,`iwb-${d}.json`))),unavailable=requested.filter(d=>!available.includes(d));
  if(!available.length)throw new Error('No validated historical universe snapshots in requested range.');
  const cached=loadCachedIsharesSnapshots(available,new Map());if(cached.missing.length)throw new Error(`Invalid historical cache: ${cached.missing.join(', ')}`);
  const coverage=new Map();for(const d of available){const snap=cached.out.get(d);coverage.set(d,{asOf:d,sourceAsOf:snap.sourceAsOf||snap.asOf||d,holdings:(snap.holdings||[]).length,identityResolved:(snap.holdings||[]).filter(h=>h.secCik).length,baselineModelable:0,recoveryAttempted:0,recoveryYearsFound:0,recoveryFilingsParsed:0,recoveredModelable:0,incrementalRecovered:0,failureReasons:{}});}
  const jobs=new Map();for(const d of available)for(const h of cached.out.get(d)?.holdings||[]){if(!h.secCik)continue;const ticker=normalizeSecTicker(h.ticker||h.historicalTicker);const k=`${h.secCik}|${ticker}`;if(!jobs.has(k))jobs.set(k,{cik:h.secCik,ticker,dates:[]});jobs.get(k).dates.push({asOf:d,holding:h});}
  let work=[...jobs.values()];if(LIMIT)work=work.slice(0,LIMIT);const examples=[],fetchErrors=[];
  for(let i=0;i<work.length;i++){
    const job=work[i];let facts=null,history=[];
    try{facts=await fetchSecFactsByCik(job.cik,job.ticker);}catch(e){fetchErrors.push({ticker:job.ticker,cik:job.cik,stage:'companyfacts',error:e.message});}
    try{history=await fetchBacktestHistory(job.ticker,HISTORY_YEARS);}catch(e){fetchErrors.push({ticker:job.ticker,cik:job.cik,stage:'price',error:e.message});}
    for(const {asOf,holding} of job.dates){const c=coverage.get(asOf);if(!facts||!history?.length){c.failureReasons.fetch_unavailable=(c.failureReasons.fetch_unavailable||0)+1;continue;}
      const diag={usableFinancialHistory:0,insufficientFinancialHistory:0,historicalPriceFound:0,missingHistoricalPrice:0,shareCountFound:0,missingShareCount:0};
      const baseStock=historicalStockFromData(job.ticker,holding.sector,facts,history,asOf,diag);const base=runModel(baseStock);
      if(base.ok){c.baselineModelable++;c.recoveredModelable++;continue;}
      // Recovery is only invoked when the production path is blocked by insufficient
      // annual history. Other failures remain visible and are not papered over.
      if(!(diag.insufficientFinancialHistory>0)){const r=base.reason||'baseline_other_failure';c.failureReasons[r]=(c.failureReasons[r]||0)+1;continue;}
      c.recoveryAttempted++;
      let rec;try{rec=await recoverAnnualFinancialsByCik(job.cik,asOf,{maxFilings:3,delayMs:0});}catch(e){c.failureReasons.recovery_fetch_failed=(c.failureReasons.recovery_fetch_failed||0)+1;if(examples.length<40)examples.push({ticker:job.ticker,asOf,reason:'recovery_fetch_failed',error:e.message});continue;}
      c.recoveryYearsFound+=rec.years.length;c.recoveryFilingsParsed+=rec.filingsParsed;
      if(rec.years.length<2){c.failureReasons.recovery_insufficient_years=(c.failureReasons.recovery_insufficient_years||0)+1;continue;}
      const recoveredStock=historicalStockFromData(job.ticker,holding.sector,facts,history,asOf,null,rec.years);const rr=runModel(recoveredStock);
      if(rr.ok){c.recoveredModelable++;c.incrementalRecovered++;if(examples.length<40)examples.push({ticker:job.ticker,asOf,recoveredYears:rec.years.map(y=>y.year),expectedCAGR:rr.expectedCAGR,rating:rr.rating});}
      else{const reason=`recovery_${rr.reason||'model_unavailable'}`;c.failureReasons[reason]=(c.failureReasons[reason]||0)+1;}
    }
    if((i+1)%20===0||i===work.length-1)console.log(`Recovery ${i+1}/${work.length}; incremental modelable=${[...coverage.values()].reduce((a,r)=>a+r.incrementalRecovered,0)}.`);
    if(DELAY)await sleep(DELAY);
  }
  const rows=[...coverage.values()].map(r=>({...r,identityResolvedRate:pct(r.identityResolved,r.holdings),baselineModelableRate:pct(r.baselineModelable,r.holdings),recoveredModelableRate:pct(r.recoveredModelable,r.holdings),incrementalRecoveryRate:pct(r.incrementalRecovered,r.holdings),recoverySuccessRate:pct(r.incrementalRecovered,r.recoveryAttempted)}));
  const holdings=rows.reduce((a,r)=>a+r.holdings,0),resolved=rows.reduce((a,r)=>a+r.identityResolved,0),base=rows.reduce((a,r)=>a+r.baselineModelable,0),rec=rows.reduce((a,r)=>a+r.recoveredModelable,0),attempts=rows.reduce((a,r)=>a+r.recoveryAttempted,0);
  const report={generatedAt:new Date().toISOString(),version:'v12.55.5-historical-fundamentals-recovery',requested:{startYear:START,endYear:END,frequency:FREQUENCY,requestedSnapshots:requested.length,auditedSnapshots:rows.length,unavailableSnapshots:unavailable,limit:LIMIT||null},guardrails:['Point-in-time IWB membership comes only from validated historical-universe caches.','Only SEC 10-K/10-K/A filings filed on or before each snapshot may contribute recovered fundamentals.','Later filings are never used to repair an earlier snapshot.','Legacy filing data only fills missing Company Facts fields; it never overwrites an already-available production fact.','Recovery is attempted only for rows blocked by insufficient annual financial history; other model failures remain failures.','Recovered rows must still pass the unchanged production forecast, quality, valuation, and rating pipeline with a finite expected CAGR.'],summary:{holdingObservations:holdings,identityResolved:resolved,identityResolvedRate:pct(resolved,holdings),baselineModelable:base,baselineModelableRate:pct(base,holdings),recoveryAttempted:attempts,recoveredModelable:rec,recoveredModelableRate:pct(rec,holdings),incrementalRecovered:rec-base,incrementalRecoveryRate:pct(rec-base,holdings),recoveryAttemptSuccessRate:pct(rec-base,attempts)},byYear:summarizeYear(rows),coverage:rows,representativeRecoveries:examples,fetchErrors:fetchErrors.slice(0,200)};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT+'.tmp',JSON.stringify(report,null,2));fs.renameSync(OUT+'.tmp',OUT);console.log(`Wrote ${path.relative(__dirname,OUT)}. Baseline ${base}/${holdings}; recovered ${rec}/${holdings}; +${rec-base}.`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});
module.exports={runModel,summarizeYear};
