'use strict';
/**
 * v12.55.7 Historical Share Count Recovery Audit
 *
 * Targets the dominant v12.55.6 failure: missing historical share denominators.
 * It compares the prior conservative SEC recovery against an enhanced, still-PIT
 * hierarchy: expanded diluted-share labels -> same-filing NI/diluted EPS -> basic
 * weighted-average shares -> same-filing NI/basic EPS -> filing cover-page period-end
 * shares. Every fallback is tagged and the production model must still emit a finite
 * expected CAGR before an observation counts as recovered.
 */
const fs=require('fs'),path=require('path');
const {fetchSecFactsByCik,fetchBacktestHistory,normalizeSecTicker,parseAnnualFinancials}=require('./data-fetchers');
const {loadCachedIsharesSnapshots,historicalStockFromData,factsAsOf}=require('./backtest');
const {recoverAnnualFinancialsByCik,mergeAnnualHistories}=require('./historical-fundamentals-recovery');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');

const START=Number(process.env.SHARE_RECOVERY_START||2007),END=Number(process.env.SHARE_RECOVERY_END||2011);
const FREQUENCY=String(process.env.SHARE_RECOVERY_FREQUENCY||'quarterly').toLowerCase();
const DELAY=Number(process.env.SHARE_RECOVERY_DELAY_MS||75),LIMIT=Number(process.env.SHARE_RECOVERY_LIMIT||0)||null;
const OUT=path.join(__dirname,'data','historical-share-count-recovery-audit.json');
const HISTORY_YEARS=Math.max(18,new Date().getUTCFullYear()-START+5);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pct=(a,b)=>b?a/b:null;
function dates(){const out=[];for(let y=START;y<=END;y++){if(FREQUENCY==='annual')out.push(`${y}-12-31`);else for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);}return out;}
function runModel(stock){if(!stock)return {ok:false,reason:'historical_stock_unavailable'};try{const f=buildForecast(stock),q=computeQuality(stock,f),v=valuate(stock,f,q),d=rateStock(stock,f,q,v);return Number.isFinite(v.expectedCAGR)?{ok:true,expectedCAGR:v.expectedCAGR,rating:d?.rating||null}:{ok:false,reason:'missing_expected_cagr'};}catch(e){return {ok:false,reason:'model_failure',error:e.message};}}
function primaryTicker(h){return normalizeSecTicker(h.historicalTicker||h.ticker||h.resolvedTicker||'');}
function blankDiag(){return {usableFinancialHistory:0,insufficientFinancialHistory:0,historicalPriceFound:0,missingHistoricalPrice:0,shareCountFound:0,missingShareCount:0};}
function diagReason(d,model){if(d.insufficientFinancialHistory>0)return 'insufficient_financial_history';if(d.missingHistoricalPrice>0)return 'missing_historical_price';if(d.missingShareCount>0)return 'missing_share_count';return model?.reason||'historical_stock_unavailable_other';}
function add(o,k,n=1){o[k]=(o[k]||0)+n;}
function sourceForMergedLatest(facts,asOf,recoveredYears){try{const primary=parseAnnualFinancials(factsAsOf(facts,asOf));const merged=mergeAnnualHistories(primary,recoveredYears||[]);const last=merged.at(-1)||{};return last.sharesSource||last.periodEndSharesSource||null;}catch{return null;}}
function summarizeYear(rows){const m=new Map();for(const r of rows){const y=r.asOf.slice(0,4);if(!m.has(y))m.set(y,[]);m.get(y).push(r);}return [...m].map(([year,x])=>{const holdings=x.reduce((a,r)=>a+r.holdings,0),resolved=x.reduce((a,r)=>a+r.identityResolved,0),prior=x.reduce((a,r)=>a+r.priorRecoveredModelable,0),enh=x.reduce((a,r)=>a+r.enhancedShareRecoveredModelable,0),inc=x.reduce((a,r)=>a+r.incrementalShareRecovered,0);return {year,snapshots:x.length,holdings,identityResolved:resolved,priorRecoveredModelable:prior,priorRecoveredModelableRate:pct(prior,holdings),enhancedShareRecoveredModelable:enh,enhancedShareRecoveredModelableRate:pct(enh,holdings),incrementalShareRecovered:inc,incrementalShareRecoveryRate:pct(inc,holdings)};});}

async function main(){
  if(START>END||END>2018)throw new Error(`Invalid range ${START}-${END}.`);
  const requested=dates(),dir=path.join(__dirname,'data','historical-universe');
  const available=requested.filter(d=>fs.existsSync(path.join(dir,`iwb-${d}.json`))),unavailable=requested.filter(d=>!available.includes(d));
  if(!available.length)throw new Error('No validated historical universe snapshots in requested range.');
  const cached=loadCachedIsharesSnapshots(available,new Map());
  if(cached.missing.length)throw new Error(`Invalid historical cache: ${cached.missing.join(', ')}`);
  const coverage=new Map();
  for(const d of available){const hs=cached.out.get(d)?.holdings||[];coverage.set(d,{asOf:d,holdings:hs.length,identityResolved:hs.filter(h=>h.secCik).length,priorRecoveredModelable:0,enhancedShareRecoveredModelable:0,incrementalShareRecovered:0,shareRecoveryAttempts:0,shareRecoverySuccesses:0,recoveryMethods:{},failureReasons:{},examples:[]});}
  const jobs=[];for(const d of available)for(const h of cached.out.get(d)?.holdings||[])if(h.secCik)jobs.push({asOf:d,h});let work=jobs;if(LIMIT)work=work.slice(0,LIMIT);
  const groups=new Map();for(const job of work){const cik=job.h.secCik;if(!groups.has(cik))groups.set(cik,[]);groups.get(cik).push(job);}
  let processed=0;
  for(const [cik,cikJobs] of groups){
    const ticker=primaryTicker(cikJobs[0].h)||cik;let facts=null;try{facts=await fetchSecFactsByCik(cik,ticker);}catch{}
    let history=[];try{history=await fetchBacktestHistory(ticker,HISTORY_YEARS);}catch{}
    const priorCache=new Map(),enhancedCache=new Map();
    for(const {asOf,h} of cikJobs){processed++;const c=coverage.get(asOf);const t=primaryTicker(h);if(!t){add(c.failureReasons,'no_historical_ticker');continue;}if(!facts){add(c.failureReasons,'sec_facts_unavailable');continue;}if(!history?.length){add(c.failureReasons,'price_series_unavailable_primary');continue;}
      let d0=blankDiag();let s0=historicalStockFromData(t,h.sector,facts,history,asOf,d0);let m0=runModel(s0);
      let priorYears=null;
      if(!m0.ok&&(d0.insufficientFinancialHistory>0||d0.missingShareCount>0)){
        if(!priorCache.has(asOf)){let r;try{r=await recoverAnnualFinancialsByCik(cik,asOf,{maxFilings:3,delayMs:0,enhancedShares:false});}catch{r={years:[]};}priorCache.set(asOf,r);}
        priorYears=priorCache.get(asOf)?.years||[];
        if(priorYears.length){d0=blankDiag();s0=historicalStockFromData(t,h.sector,facts,history,asOf,d0,priorYears);m0=runModel(s0);}
      }
      if(m0.ok){c.priorRecoveredModelable++;c.enhancedShareRecoveredModelable++;continue;}
      const priorReason=diagReason(d0,m0);
      if(priorReason!=='missing_share_count'){add(c.failureReasons,priorReason);continue;}
      c.shareRecoveryAttempts++;
      if(!enhancedCache.has(asOf)){let r;try{r=await recoverAnnualFinancialsByCik(cik,asOf,{maxFilings:3,delayMs:0,enhancedShares:true});}catch{r={years:[]};}enhancedCache.set(asOf,r);}
      const enhancedYears=enhancedCache.get(asOf)?.years||[];
      let d1=blankDiag(),s1=historicalStockFromData(t,h.sector,facts,history,asOf,d1,enhancedYears),m1=runModel(s1);
      if(m1.ok){
        c.enhancedShareRecoveredModelable++;c.incrementalShareRecovered++;c.shareRecoverySuccesses++;
        const method=sourceForMergedLatest(facts,asOf,enhancedYears)||'unknown_share_source';add(c.recoveryMethods,method);
        if(c.examples.length<12)c.examples.push({cik,asOf,ticker:t,shareSource:method,expectedCAGR:m1.expectedCAGR,rating:m1.rating});
      }else add(c.failureReasons,diagReason(d1,m1));
      if(DELAY)await sleep(DELAY);
      if(processed%250===0||processed===work.length)console.log(`Share-count audit ${processed}/${work.length}`);
    }
    facts=null;history=null;priorCache.clear();enhancedCache.clear();
  }
  const rows=[...coverage.values()];const holdings=rows.reduce((a,r)=>a+r.holdings,0),resolved=rows.reduce((a,r)=>a+r.identityResolved,0),prior=rows.reduce((a,r)=>a+r.priorRecoveredModelable,0),enh=rows.reduce((a,r)=>a+r.enhancedShareRecoveredModelable,0),inc=rows.reduce((a,r)=>a+r.incrementalShareRecovered,0),attempts=rows.reduce((a,r)=>a+r.shareRecoveryAttempts,0),successes=rows.reduce((a,r)=>a+r.shareRecoverySuccesses,0);const methods={},failures={};for(const r of rows){for(const [k,v] of Object.entries(r.recoveryMethods))add(methods,k,v);for(const [k,v] of Object.entries(r.failureReasons))add(failures,k,v);}
  const report={generatedAt:new Date().toISOString(),version:'v12.55.7-historical-share-count-recovery-audit',requested:{startYear:START,endYear:END,frequency:FREQUENCY,requestedSnapshots:requested.length,auditedSnapshots:rows.length,unavailableSnapshots:unavailable,limit:LIMIT},guardrails:['Point-in-time IWB membership comes only from validated historical-universe caches.','SEC Company Facts and legacy 10-Ks remain limited to information filed on or before each snapshot.','Enhanced share recovery is attempted only after the prior pipeline fails specifically for missing share count.','Diluted weighted-average shares and same-filing NI/diluted-EPS evidence are preferred over basic-share fallbacks.','Basic weighted-average shares or NI/basic-EPS are used only when no stronger denominator exists and are explicitly tagged.','Cover-page shares outstanding are a last-resort same-filing period-end denominator and are explicitly tagged; no current share count or current market-cap reconciliation is used.','Recovered observations must still pass the unchanged production forecast, quality, valuation, and rating pipeline with finite expected CAGR.','Large SEC facts, price histories, and filing caches are processed one CIK at a time to stay within GitHub Actions memory limits.'],summary:{holdingObservations:holdings,identityResolved:resolved,identityResolvedRate:pct(resolved,holdings),priorRecoveredModelable:prior,priorRecoveredModelableRate:pct(prior,holdings),enhancedShareRecoveredModelable:enh,enhancedShareRecoveredModelableRate:pct(enh,holdings),incrementalShareRecovered:inc,incrementalShareRecoveryRate:pct(inc,holdings),shareRecoveryAttempts:attempts,shareRecoverySuccesses:successes,shareRecoveryAttemptSuccessRate:pct(successes,attempts),recoveryMethods:methods,failureReasons:failures},byYear:summarizeYear(rows),coverage:rows};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT+'.tmp',JSON.stringify(report,null,2));fs.renameSync(OUT+'.tmp',OUT);console.log(`Wrote ${path.relative(__dirname,OUT)}; prior=${prior}, enhanced=${enh}, incremental=${inc}.`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});
module.exports={diagReason,sourceForMergedLatest,summarizeYear};
