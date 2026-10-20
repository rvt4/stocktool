'use strict';
/** v12.55.6.1 Historical Price & Delisting Recovery Audit
 * Measures the exact post-fundamentals bottleneck and safely retries price history
 * only across ticker aliases already attached to the SAME point-in-time holding/CIK.
 */
const fs=require('fs'),path=require('path');
const {fetchSecFactsByCik,fetchBacktestHistory,normalizeSecTicker}=require('./data-fetchers');
const {loadCachedIsharesSnapshots,historicalStockFromData}=require('./backtest');
const {recoverAnnualFinancialsByCik}=require('./historical-fundamentals-recovery');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const START=Number(process.env.PRICE_RECOVERY_START||2007),END=Number(process.env.PRICE_RECOVERY_END||2011);
const FREQUENCY=String(process.env.PRICE_RECOVERY_FREQUENCY||'quarterly').toLowerCase();
const DELAY=Number(process.env.PRICE_RECOVERY_DELAY_MS||75),LIMIT=Number(process.env.PRICE_RECOVERY_LIMIT||0)||null;
const OUT=path.join(__dirname,'data','historical-price-delisting-recovery-audit.json');
const HISTORY_YEARS=Math.max(18,new Date().getUTCFullYear()-START+5);
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const pct=(a,b)=>b?a/b:null;
function dates(){const out=[];for(let y=START;y<=END;y++){if(FREQUENCY==='annual')out.push(`${y}-12-31`);else for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);}return out;}
function runModel(stock){if(!stock)return {ok:false,reason:'historical_stock_unavailable'};try{const f=buildForecast(stock),q=computeQuality(stock,f),v=valuate(stock,f,q),d=rateStock(stock,f,q,v);return Number.isFinite(v.expectedCAGR)?{ok:true,expectedCAGR:v.expectedCAGR,rating:d?.rating||null}:{ok:false,reason:'missing_expected_cagr'};}catch(e){return {ok:false,reason:'model_failure',error:e.message};}}
function aliasesFor(h){const vals=[h.historicalTicker,h.ticker,h.resolvedTicker,h.secTicker,h.openFigiTicker,h.currentTicker].filter(Boolean).map(normalizeSecTicker).filter(Boolean);return [...new Set(vals)];}
function diagReason(d){if(d.insufficientFinancialHistory>0)return 'insufficient_financial_history';if(d.missingHistoricalPrice>0)return 'missing_historical_price';if(d.missingShareCount>0)return 'missing_share_count';return 'historical_stock_unavailable_other';}
function add(o,k,n=1){o[k]=(o[k]||0)+n;}
async function historyForAliases(aliases,cache){for(const ticker of aliases){if(!cache.has(ticker)){let h=[];try{h=await fetchBacktestHistory(ticker,HISTORY_YEARS);}catch{}cache.set(ticker,h||[]);}const h=cache.get(ticker);if(h?.length)return {ticker,history:h};}return {ticker:aliases[0]||null,history:[]};}
function summarizeYear(rows){const m=new Map();for(const r of rows){const y=r.asOf.slice(0,4);if(!m.has(y))m.set(y,[]);m.get(y).push(r);}return [...m].map(([year,x])=>{const holdings=x.reduce((a,r)=>a+r.holdings,0),resolved=x.reduce((a,r)=>a+r.identityResolved,0),base=x.reduce((a,r)=>a+r.baselineModelable,0),rec=x.reduce((a,r)=>a+r.recoveredModelable,0),alias=x.reduce((a,r)=>a+r.aliasRecoveredModelable,0);return {year,snapshots:x.length,holdings,identityResolved:resolved,baselineModelable:base,recoveredModelable:rec,recoveredModelableRate:pct(rec,holdings),aliasRecoveredModelable:alias,aliasRecoveredModelableRate:pct(alias,holdings),incrementalAliasRecovered:alias-rec};});}
async function main(){
 if(START>END||END>2018)throw new Error(`Invalid range ${START}-${END}.`);
 const requested=dates(),dir=path.join(__dirname,'data','historical-universe'); const available=requested.filter(d=>fs.existsSync(path.join(dir,`iwb-${d}.json`))),unavailable=requested.filter(d=>!available.includes(d)); if(!available.length)throw new Error('No validated historical universe snapshots in requested range.');
 const cached=loadCachedIsharesSnapshots(available,new Map()); if(cached.missing.length)throw new Error(`Invalid historical cache: ${cached.missing.join(', ')}`);
 const coverage=new Map(); for(const d of available){const hs=cached.out.get(d)?.holdings||[];coverage.set(d,{asOf:d,holdings:hs.length,identityResolved:hs.filter(h=>h.secCik).length,baselineModelable:0,recoveredModelable:0,aliasRecoveredModelable:0,aliasRecoveryAttempts:0,aliasRecoverySuccesses:0,failureReasons:{},aliasExamples:[]});}
 const jobs=[];for(const d of available)for(const h of cached.out.get(d)?.holdings||[])if(h.secCik)jobs.push({asOf:d,h}); let work=jobs;if(LIMIT)work=work.slice(0,LIMIT);
 // v12.55.6.1 memory fix: SEC Company Facts payloads can be many MB each. Keeping
 // every CIK plus every price history in process exhausted GitHub's ~4 GB V8 heap
 // after only a few hundred observations. Group observations by CIK, fetch facts once,
 // process all of that security's snapshots, then release facts/history/recovery data
 // before moving to the next CIK. This changes only memory lifetime, not audit logic.
 const groups=new Map();for(const job of work){const cik=job.h.secCik;if(!groups.has(cik))groups.set(cik,[]);groups.get(cik).push(job);}
 let processed=0;
 for(const [cik,cikJobs] of groups){
   const sample=cikJobs[0]?.h;const sampleAliases=sample?aliasesFor(sample):[];const label=sampleAliases[0]||cik;
   let facts=null;try{facts=await fetchSecFactsByCik(cik,label);}catch{}
   // These caches are intentionally scoped to ONE CIK so large SEC payloads and
   // historical price arrays become garbage-collectable between securities.
   const historyCache=new Map(),recoveryCache=new Map();
   for(const {asOf,h} of cikJobs){processed++;const c=coverage.get(asOf),aliases=aliasesFor(h);if(!aliases.length){add(c.failureReasons,'no_historical_ticker');continue;} const primary=aliases[0];
     if(!facts){add(c.failureReasons,'sec_facts_unavailable');continue;}
     let ph=await historyForAliases([primary],historyCache); if(!ph.history.length){add(c.failureReasons,'price_series_unavailable_primary'); if(aliases.length>1){c.aliasRecoveryAttempts++;ph=await historyForAliases(aliases.slice(1),historyCache);if(ph.history.length)c.aliasRecoverySuccesses++;}}
     if(!ph.history.length){add(c.failureReasons,'price_series_unavailable_all_same_cik_aliases');continue;}
     let diag={usableFinancialHistory:0,insufficientFinancialHistory:0,historicalPriceFound:0,missingHistoricalPrice:0,shareCountFound:0,missingShareCount:0}; let stock=historicalStockFromData(primary,h.sector,facts,ph.history,asOf,diag);let model=runModel(stock);
     if(model.ok){c.baselineModelable++;c.recoveredModelable++;c.aliasRecoveredModelable++;continue;}
     if(diag.insufficientFinancialHistory>0){const rk=asOf;let rec=recoveryCache.get(rk);if(!rec){try{rec=await recoverAnnualFinancialsByCik(cik,asOf,{maxFilings:3,delayMs:0});}catch{rec={years:[]};}recoveryCache.set(rk,rec);} if(rec.years?.length>=2){diag={usableFinancialHistory:0,insufficientFinancialHistory:0,historicalPriceFound:0,missingHistoricalPrice:0,shareCountFound:0,missingShareCount:0};stock=historicalStockFromData(primary,h.sector,facts,ph.history,asOf,diag,rec.years);model=runModel(stock);if(model.ok){c.recoveredModelable++;c.aliasRecoveredModelable++;continue;}}}
     // Critical v12.55.6 diagnostic: a null recovered stock is classified by the
     // production constructor's counters, rather than mislabeled as a price failure.
     const reason=stock?(model.reason||'model_failure'):diagReason(diag);add(c.failureReasons,reason);
     // If the primary series exists but has no quote on/before the snapshot, retry only
     // aliases bound to this exact holding/CIK. This cannot introduce current membership.
     if(diag.missingHistoricalPrice>0&&aliases.length>1){c.aliasRecoveryAttempts++;const alt=await historyForAliases(aliases.slice(1),historyCache);if(alt.history.length){let d2={usableFinancialHistory:0,insufficientFinancialHistory:0,historicalPriceFound:0,missingHistoricalPrice:0,shareCountFound:0,missingShareCount:0};let recYears=null;if(recoveryCache.has(asOf))recYears=recoveryCache.get(asOf)?.years||null;const s2=historicalStockFromData(primary,h.sector,facts,alt.history,asOf,d2,recYears);const m2=runModel(s2);if(m2.ok){c.aliasRecoverySuccesses++;c.aliasRecoveredModelable++;if(c.aliasExamples.length<10)c.aliasExamples.push({cik,asOf,primaryTicker:primary,recoveredPriceTicker:alt.ticker});}}}
     if(DELAY)await sleep(DELAY);
     if(processed%250===0||processed===work.length)console.log(`Price/delisting audit ${processed}/${work.length}`);
   }
   // Drop references explicitly; actual reclamation remains V8's responsibility.
   facts=null;historyCache.clear();recoveryCache.clear();
 }
 const rows=[...coverage.values()];const holdings=rows.reduce((a,r)=>a+r.holdings,0),resolved=rows.reduce((a,r)=>a+r.identityResolved,0),base=rows.reduce((a,r)=>a+r.baselineModelable,0),rec=rows.reduce((a,r)=>a+r.recoveredModelable,0),alias=rows.reduce((a,r)=>a+r.aliasRecoveredModelable,0);const failures={};for(const r of rows)for(const [k,v] of Object.entries(r.failureReasons))add(failures,k,v);
 const report={generatedAt:new Date().toISOString(),version:'v12.55.6.1-historical-price-delisting-recovery-audit',requested:{startYear:START,endYear:END,frequency:FREQUENCY,requestedSnapshots:requested.length,auditedSnapshots:rows.length,unavailableSnapshots:unavailable,limit:LIMIT},guardrails:['Point-in-time IWB membership comes only from validated historical-universe caches.','Price alias retries are restricted to ticker aliases already attached to the same historical holding and SEC CIK.','No current-constituent membership fallback or unrelated successor-company substitution is permitted.','Historical valuation uses a quote on or before the snapshot; future prices cannot repair an earlier snapshot.','Legacy fundamentals recovery retains the v12.55.5 filing-date guardrails.','Null historical stocks are classified by production diagnostics so missing share count or fundamentals cannot be mislabeled as a price failure.','Large SEC facts and price payloads are processed one CIK at a time and released between securities; this is a memory-management change only.'],summary:{holdingObservations:holdings,identityResolved:resolved,identityResolvedRate:pct(resolved,holdings),baselineModelable:base,recoveredModelable:rec,recoveredModelableRate:pct(rec,holdings),aliasRecoveredModelable:alias,aliasRecoveredModelableRate:pct(alias,holdings),incrementalAliasRecovered:alias-rec,failureReasons:failures},byYear:summarizeYear(rows),coverage:rows};
 fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT+'.tmp',JSON.stringify(report,null,2));fs.renameSync(OUT+'.tmp',OUT);console.log(`Wrote ${path.relative(__dirname,OUT)}; recovered=${rec}, aliasRecovered=${alias}.`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});
module.exports={aliasesFor,diagReason,summarizeYear};
