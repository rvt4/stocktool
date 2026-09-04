'use strict';
/**
 * FreeScreener point-in-time historical CORE backtest.
 *
 * Purpose:
 *   Re-run today's model architecture on historical dates using only SEC facts that
 *   had actually been filed by each as-of date plus historical market prices.
 *
 * Important limitations (published in the output too):
 *   - Historical analyst consensus is intentionally NOT reconstructed. The backtest
 *     therefore exercises the model's SEC/history fallback path, while live forward
 *     snapshots preserve the complete analyst-assisted production model.
 *   - Historical IWB holdings are required at every snapshot. The robustness backtest
 *     fails closed if archived membership cannot be retrieved; there is no fallback to
 *     today's watchlist. Residual survivorship bias can remain for unresolved delistings.
 *   - Realized returns use Yahoo adjusted close when available (split/dividend adjusted),
 *     with explicitly flagged Stooq price-only fallback. SPY uses adjusted close.
 *
 * Usage examples:
 *   node backtest.js
 *   BACKTEST_START=2018 BACKTEST_END=2025 BACKTEST_FREQUENCY=annual node backtest.js
 *   BACKTEST_FREQUENCY=quarterly BACKTEST_LIMIT=100 node backtest.js
 */
const fs=require('fs');
const path=require('path');
const {
  fetchSecFacts, fetchSecSubmissions, classifyCompanyMetadata, parseAnnualFinancials, parseQuarterlyRevenue, recentQuarterYoYGrowth,
  blendedForwardGrowth, fetchBacktestHistory, latestDilutedSharesFromFacts,
  normalizeHistoryForCorporateAction, normalizeSecTicker
}=require('./data-fetchers');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const {applyModelDRanking,percentileRanks}=require('./engine/ranking-engine');
const {isValuationBuyRating,ratingAlphaSizingTarget}=require('./engine/portfolio-policy');

const MODEL_VERSION='simple-v12.51-dynamic-margin-of-safety-entry';
const watchlist=JSON.parse(fs.readFileSync(path.join(__dirname,'watchlist.json'),'utf8'));
const START=Number(process.env.BACKTEST_START||2016);
const END=Number(process.env.BACKTEST_END||new Date().getUTCFullYear()-1);
const FREQUENCY=String(process.env.BACKTEST_FREQUENCY||'annual').toLowerCase();
const LIMIT=Math.max(0,Number(process.env.BACKTEST_LIMIT||0));
const RATE_LIMIT_DELAY_MS=Number(process.env.BACKTEST_RATE_LIMIT_DELAY_MS||350);
const HISTORY_YEARS=Math.max(12,new Date().getUTCFullYear()-START+2);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function cagr(a,b,n){return a>0&&b>0&&n>0?Math.pow(b/a,1/n)-1:null;}
function median(a){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}
function isoDate(d){return new Date(d).toISOString().slice(0,10);}

function snapshotDates(){
  const out=[];
  for(let y=START;y<=END;y++){
    if(FREQUENCY==='quarterly'){
      for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);
    }else out.push(`${y}-12-31`);
  }
  return out.filter(d=>new Date(d)<=new Date());
}

// Keep only facts that were publicly filed by the simulated date. This is the core
// look-ahead-bias guardrail. We also reject facts whose period ends after the date.
function factsAsOf(raw,asOf){
  const cutoff=String(asOf);
  const out={...raw,facts:{}};
  for(const [taxonomy,tags] of Object.entries(raw?.facts||{})){
    out.facts[taxonomy]={};
    for(const [tag,obj] of Object.entries(tags||{})){
      const units={};
      for(const [unit,arr] of Object.entries(obj?.units||{})){
        units[unit]=(arr||[]).filter(x=>{
          if(x?.filed&&String(x.filed)>cutoff)return false;
          if(x?.end&&String(x.end)>cutoff)return false;
          // If a fact lacks a filing date, require a conservative reporting lag.
          if(!x?.filed&&x?.end){const lag=(new Date(cutoff)-new Date(x.end))/86400000;if(lag<45)return false;}
          return true;
        });
      }
      out.facts[taxonomy][tag]={...obj,units};
    }
  }
  return out;
}
function priceOnOrBefore(history,date,maxGapDays=12,field='close'){
  const t=new Date(date).getTime(); let best=null;
  for(const p of history||[]){const pt=new Date(p.date).getTime();if(pt<=t&&(!best||pt>best.pt))best={t,pt,p};}
  if(!best)return null;
  const v=finite(best.p?.[field]);
  return (best.t-best.pt)/86400000<=maxGapDays?v:null;
}
function totalReturnCAGR(history,startDate,endDate,years){
  const a=priceOnOrBefore(history,startDate,12,'adjustedClose'),b=priceOnOrBefore(history,endDate,12,'adjustedClose');
  return a>0&&b>0?cagr(a,b,years):null;
}

function addYears(date,years){const d=new Date(date+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()+years);return d.toISOString().slice(0,10);}
function addDays(date,days){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function addMonths(date,months){const d=new Date(date+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString().slice(0,10);}

const IWB_SERIES_ID='S000004347';
const IWB_TRUST_CIK='1100663';
const SEC_EFTS='https://efts.sec.gov/LATEST/search-index';
const SEC_BROWSE='https://www.sec.gov/cgi-bin/browse-edgar';
const SEC_ARCHIVES='https://www.sec.gov/Archives/edgar/data';
const OPENFIGI_MAPPING='https://api.openfigi.com/v3/mapping';

function normalizeSectorName(s){
  const x=String(s||'').trim();
  const map={
    'Information Technology':'Technology','Health Care':'Healthcare','Communication Services':'Communication Services',
    'Consumer Discretionary':'Consumer Discretionary','Consumer Staples':'Consumer Staples','Financials':'Financials',
    'Industrials':'Industrials','Energy':'Energy','Materials':'Materials','Real Estate':'Real Estate','Utilities':'Utilities'
  };
  return map[x]||x||'Unknown';
}
function xmlDecode(x){return String(x||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
function xmlTag(block,tag){const m=String(block||'').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?xmlDecode(m[1].replace(/<[^>]+>/g,'').trim()):null;}
function normalizeTickerSymbol(ticker){
  return String(ticker||'').trim().toUpperCase().replaceAll('.','-');
}
function validEquityTicker(ticker){
  const t=normalizeTickerSymbol(ticker);
  return !!t&&t!=='-'&&t!=='N/A'&&t!=='USD'&&/^[A-Z0-9-]{1,12}$/.test(t);
}
function parseNportHoldingsXml(xml,currentMap=new Map()){
  const text=String(xml||'');
  const reportDate=xmlTag(text,'repPd')||xmlTag(text,'repPdDate')||xmlTag(text,'periodOfReport');
  const holdings=[],unresolved=[];
  const blocks=text.match(/<invstOrSec\b[\s\S]*?<\/invstOrSec>/gi)||[];
  for(const block of blocks){
    const name=xmlTag(block,'name')||'';
    const title=xmlTag(block,'title')||'';
    const assetCat=String(xmlTag(block,'assetCat')||'').toUpperCase();
    const units=String(xmlTag(block,'units')||'').toUpperCase();
    const cusip=String(xmlTag(block,'cusip')||'').trim().toUpperCase();
    if(/cash|currency|future|swap|collateral|treasury bill/i.test(`${name} ${title}`))continue;
    // IWB common-stock positions are reported as equity-category securities.
    // Derivatives are the rare N-PORT rows that actually carry <ticker>; most
    // stocks carry CUSIP/ISIN only, so ticker-only parsing incorrectly found 2 rows.
    if(assetCat&&assetCat!=='EC')continue;
    if(units&&units!=='NS')continue;
    let ticker=null;
    const attr=block.match(/<ticker\b[^>]*\bvalue=["']([^"']+)["'][^>]*\/?\s*>/i);
    if(attr)ticker=attr[1];
    if(!ticker)ticker=xmlTag(block,'ticker');
    ticker=normalizeTickerSymbol(ticker);
    if(validEquityTicker(ticker)){
      holdings.push({ticker,sector:currentMap.get(ticker)?.sector||'Unknown',name,title,cusip});
      continue;
    }
    if(/^[A-Z0-9]{8,9}$/.test(cusip)&&cusip!=='N/A')unresolved.push({cusip,name,title,assetCat,units});
  }
  const dedup=[...new Map(holdings.map(h=>[h.ticker,h])).values()];
  const unresolvedDedup=[...new Map(unresolved.map(h=>[h.cusip,h])).values()];
  return {reportDate,holdings:dedup,unresolved:unresolvedDedup};
}
function accessionFromHit(hit){
  const blob=JSON.stringify(hit||{});
  const m=blob.match(/\b\d{10}-\d{2}-\d{6}\b/);
  return m?m[0]:null;
}
function parseSecSeriesAtom(atom){
  const text=String(atom||'');
  const out=[];
  const entries=text.match(/<entry\b[\s\S]*?<\/entry>/gi)||[];
  for(const entry of entries){
    const href=(entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)||[])[1]||'';
    const accession=accessionFromHit(href)||accessionFromHit(entry);
    const updated=(entry.match(/<updated>([^<]+)<\/updated>/i)||[])[1]||null;
    const title=(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'';
    if(accession)out.push({accession,updated,title:xmlDecode(title)});
  }
  return [...new Map(out.map(x=>[x.accession,x])).values()];
}
let lastSecRequestAt=0;
async function secFetchText(url,label='SEC request',accept='application/json,text/xml,text/plain,*/*'){
  // EDGAR is intentionally conservative about automated traffic. The historical
  // universe pass can make dozens of archive requests in a short burst, which was
  // triggering intermittent 503s on GitHub Actions. Pace every SEC request and
  // retry transient server/rate-limit responses instead of treating them as missing data.
  const ua=process.env.SEC_USER_AGENT||'FreeScreener research contact@example.com';
  const retryable=new Set([429,500,502,503,504]);
  let lastErr=null;
  for(let attempt=0;attempt<6;attempt++){
    const now=Date.now();
    const wait=Math.max(0,275-(now-lastSecRequestAt));
    if(wait)await sleep(wait);
    lastSecRequestAt=Date.now();
    const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),30000);
    try{
      const res=await fetch(url,{headers:{'User-Agent':ua,'Accept-Encoding':'gzip, deflate','Accept':accept},signal:ac.signal,redirect:'follow'});
      const text=await res.text();
      if(res.ok)return text;
      lastErr=new Error(`${label} HTTP ${res.status}`);
      if(!retryable.has(res.status))throw lastErr;
    }catch(e){
      lastErr=e;
      if(attempt===5)break;
    }finally{clearTimeout(timer);}
    // Exponential-ish backoff: 1s, 2s, 4s, 8s, 12s. This keeps us well
    // below SEC fair-access limits when the service is under load.
    await sleep(Math.min(12000,1000*Math.pow(2,attempt)));
  }
  throw lastErr||new Error(`${label} failed after retries`);
}
async function discoverIwbNportFilings(startYear,endYear){
  // Use EDGAR's series-filtered browse feed rather than full-text search. EFTS
  // does not reliably index Series IDs inside investment-company submissions,
  // which previously yielded zero IWB accessions even though the filings exist.
  const url=new URL(SEC_BROWSE);
  url.searchParams.set('action','getcompany');
  url.searchParams.set('CIK',IWB_SERIES_ID);
  url.searchParams.set('type','NPORT-P');
  url.searchParams.set('owner','exclude');
  url.searchParams.set('count','100');
  url.searchParams.set('output','atom');
  const raw=await secFetchText(url.toString(),'SEC EDGAR IWB series feed','application/atom+xml,application/xml,text/xml,*/*');
  const entries=parseSecSeriesAtom(raw);
  const accessions=entries.map(x=>x.accession).filter(Boolean);
  if(accessions.length)return [...new Set(accessions)];

  // Defensive fallback only: keep EFTS as a secondary discovery route. It may
  // work in some SEC deployments, but series-feed discovery is authoritative.
  const params=new URLSearchParams({q:IWB_SERIES_ID,forms:'NPORT-P',dateRange:'custom',startdt:`${Math.max(2019,startYear)}-01-01`,enddt:`${endYear+1}-12-31`,from:'0',size:'100'});
  const eft=await secFetchText(`${SEC_EFTS}?${params.toString()}`,'SEC EFTS IWB NPORT fallback');
  const j=JSON.parse(eft); const hits=j?.hits?.hits||j?.hits||[];
  const fallback=[...new Set(hits.map(accessionFromHit).filter(Boolean))];
  if(!fallback.length)throw new Error('SEC series feed and EFTS both returned no IWB NPORT-P filings.');
  return fallback;
}
let lastOpenFigiRequestAt=0;
function chooseOpenFigiTicker(result){
  const rows=result?.data||[];
  // OpenFIGI's marketSector can still be "Equity" for equity-index futures and
  // other derivative instruments. Do not merely down-rank those rows: reject
  // them outright so a CUSIP can never resolve to something like ESH26.
  const prohibited=/future|option|warrant|swap|forward|right|preferred|convertible|bond|note|debt|fund|etf|etn|closed-end|open-end/i;
  const preferred=/common stock|ordinary share|reit|depositary receipt|adr|gdr/i;
  const acceptable=rows.filter(x=>{
    if(!validEquityTicker(x?.ticker))return false;
    if(String(x?.marketSector||'').toLowerCase()!=='equity')return false;
    const st=String(x?.securityType2||x?.securityType||'').trim();
    if(prohibited.test(st))return false;
    // If OpenFIGI supplies a security type, require it to look like an actual
    // common-equity instrument. Blank types are retained as a lower-confidence
    // fallback because some older CUSIPs have sparse metadata.
    if(st&&!preferred.test(st))return false;
    return true;
  });
  const score=x=>{
    let n=0;
    const st=String(x?.securityType2||x?.securityType||'').toLowerCase();
    if(preferred.test(st))n+=5;
    if(String(x?.exchCode||'').toUpperCase()==='US')n+=3;
    if(x?.compositeFIGI)n+=1;
    return n;
  };
  acceptable.sort((a,b)=>score(b)-score(a));
  return acceptable.length?normalizeTickerSymbol(acceptable[0].ticker):null;
}
async function openFigiFetchBatch(cusips){
  const apiKey=String(process.env.OPENFIGI_API_KEY||'').trim();
  // OpenFIGI is free without a key: 25 requests/minute and up to 10 mapping jobs
  // per request. A free key is optional and only increases throughput.
  const minGap=apiKey?300:2500;
  const jobs=cusips.map(idValue=>({idType:'ID_CUSIP',idValue,marketSecDes:'Equity',includeUnlistedEquities:true}));
  let lastErr=null;
  for(let attempt=0;attempt<6;attempt++){
    const wait=Math.max(0,minGap-(Date.now()-lastOpenFigiRequestAt));
    if(wait)await sleep(wait);
    lastOpenFigiRequestAt=Date.now();
    const headers={'Content-Type':'application/json','Accept':'application/json'};
    if(apiKey)headers['X-OPENFIGI-APIKEY']=apiKey;
    try{
      const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),30000);
      let res;
      try{res=await fetch(OPENFIGI_MAPPING,{method:'POST',headers,body:JSON.stringify(jobs),signal:ac.signal});}
      finally{clearTimeout(timer);}
      const text=await res.text();
      if(res.ok){
        const json=JSON.parse(text);
        return cusips.map((cusip,i)=>({cusip,ticker:chooseOpenFigiTicker(json?.[i]),raw:json?.[i]}));
      }
      lastErr=new Error(`OpenFIGI HTTP ${res.status}`);
      if(![429,500,502,503,504].includes(res.status))throw lastErr;
      const retryAfter=Number(res.headers.get('ratelimit-reset')||res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:Math.min(15000,1500*Math.pow(2,attempt)));
    }catch(e){
      lastErr=e;
      if(attempt===5)break;
      await sleep(Math.min(15000,1500*Math.pow(2,attempt)));
    }
  }
  throw lastErr||new Error('OpenFIGI mapping failed');
}
async function mapCusipsToTickers(cusips){
  const unique=[...new Set((cusips||[]).filter(x=>/^[A-Z0-9]{8,9}$/.test(String(x||''))))];
  const out=new Map();
  const apiKey=String(process.env.OPENFIGI_API_KEY||'').trim();
  const batchSize=apiKey?100:10;
  for(let i=0;i<unique.length;i+=batchSize){
    const batch=unique.slice(i,i+batchSize);
    const mapped=await openFigiFetchBatch(batch);
    for(const row of mapped)if(validEquityTicker(row.ticker))out.set(row.cusip,row.ticker);
    if((i+batchSize)%500===0||i+batchSize>=unique.length)console.log(`OpenFIGI CUSIP mapping: ${Math.min(i+batchSize,unique.length)}/${unique.length}, resolved=${out.size}.`);
  }
  return out;
}
async function loadIwbNportSnapshots(dates,currentMap){
  const accessions=await discoverIwbNportFilings(Number(dates[0].slice(0,4)),Number(dates.at(-1).slice(0,4)));
  console.log(`SEC IWB discovery found ${accessions.length} NPORT-P accession(s).`);
  const rawReports=[];
  let fetched=0,seriesMatches=0,fetchFailures=0;
  const failureExamples=[];
  for(let i=0;i<accessions.length;i++){
    const acc=accessions[i],compact=acc.replaceAll('-','');
    try{
      const xml=await secFetchText(`${SEC_ARCHIVES}/${IWB_TRUST_CIK}/${compact}/primary_doc.xml`,`IWB NPORT ${acc}`);
      fetched++;
      if(!xml.includes(IWB_SERIES_ID))continue;
      seriesMatches++;
      const parsed=parseNportHoldingsXml(xml,currentMap);
      if(parsed.reportDate)rawReports.push({accession:acc,...parsed});
      else if(failureExamples.length<5)failureExamples.push(`${acc}: missing report date`);
    }catch(e){
      fetchFailures++;
      if(failureExamples.length<5)failureExamples.push(`${acc}: ${e.message}`);
    }
  }
  const uniqueCusips=[...new Set(rawReports.flatMap(r=>r.unresolved.map(x=>x.cusip)))];
  console.log(`SEC IWB archive diagnostics: fetched=${fetched}, seriesMatches=${seriesMatches}, reports=${rawReports.length}, unresolvedStockCUSIPs=${uniqueCusips.length}, fetchFailures=${fetchFailures}.`);
  if(failureExamples.length)console.log(`SEC IWB sample issues: ${failureExamples.join(' | ')}`);
  if(!rawReports.length)return {byReport:new Map(),out:new Map(),accessions};

  // N-PORT generally omits exchange tickers for cash equities and reports CUSIP/ISIN
  // instead. Resolve those identifiers with OpenFIGI rather than treating the two
  // derivative ticker tags in the filing as the whole portfolio.
  const cusipMap=await mapCusipsToTickers(uniqueCusips);
  const byReport=new Map();
  let unresolvedAfterMap=0,tooSmall=0;
  for(const report of rawReports){
    const holdings=[...report.holdings];
    for(const row of report.unresolved){
      const ticker=cusipMap.get(row.cusip);
      if(!validEquityTicker(ticker)){unresolvedAfterMap++;continue;}
      holdings.push({ticker,sector:currentMap.get(ticker)?.sector||'Unknown',name:row.name,title:row.title,cusip:row.cusip});
    }
    const dedup=[...new Map(holdings.map(h=>[h.ticker,h])).values()];
    if(dedup.length>=500)byReport.set(report.reportDate,{accession:report.accession,reportDate:report.reportDate,holdings:dedup});
    else{
      tooSmall++;
      if(failureExamples.length<8)failureExamples.push(`${report.accession}: report=${report.reportDate}, resolvedHoldings=${dedup.length}, rawCUSIPs=${report.unresolved.length}`);
    }
  }
  console.log(`SEC IWB resolved diagnostics: usableReports=${byReport.size}, tooSmall=${tooSmall}, unresolvedCUSIPRows=${unresolvedAfterMap}, mappedUniqueCUSIPs=${cusipMap.size}/${uniqueCusips.length}.`);
  if(failureExamples.length)console.log(`SEC IWB sample issues: ${failureExamples.join(' | ')}`);
  const out=new Map();
  for(const asOf of dates){
    const candidates=[...byReport.keys()].filter(d=>d<=asOf).sort().reverse();
    const exact=byReport.get(asOf);
    const chosen=exact||byReport.get(candidates[0]);
    if(chosen){
      const gap=(new Date(asOf)-new Date(chosen.reportDate))/86400000;
      if(gap>=0&&gap<=100)out.set(asOf,chosen);
    }
  }
  return {byReport,out,accessions};
}
async function buildHistoricalUniverse(dates){
  // Free, machine-readable point-in-time IWB holdings are reliably available from
  // SEC Form N-PORT beginning in 2019. We intentionally do NOT fall back to today's
  // watchlist for 2016-2018 because that reintroduces survivorship bias.
  const supported=dates.filter(d=>Number(d.slice(0,4))>=2019);
  if(!supported.length)throw new Error('Survivorship-reduced historical universe requires 2019 or later (SEC N-PORT era).');
  if(supported.length!==dates.length){
    console.log(`Historical universe note: ${dates.length-supported.length} pre-2019 snapshots excluded; free SEC N-PORT point-in-time IWB holdings begin in 2019.`);
    dates.splice(0,dates.length,...supported);
  }
  const current=new Map(watchlist.map(x=>[x.ticker,x]));
  console.log(`Loading point-in-time Russell 1000 proxy membership from SEC N-PORT IWB filings for ${dates.length} snapshot dates...`);
  const loaded=await loadIwbNportSnapshots(dates,current);

  // N-PORT became effective in 2019, but an individual fund's first usable filing can
  // be later than 2019-01-01. IWB's archive begins at 2019-09-30. Treat snapshots
  // before the first actually available report as outside the supported backtest era,
  // rather than calling them data failures. Once the archive begins, however, every
  // requested snapshot must still resolve or the backtest fails closed.
  const usableReportDates=[...loaded.byReport.keys()].sort();
  if(!usableReportDates.length){
    throw new Error('SEC N-PORT IWB archive contained no usable equity reports after CUSIP mapping.');
  }
  const firstUsableReportDate=usableReportDates[0];
  const effectiveDates=dates.filter(d=>d>=firstUsableReportDate);
  if(effectiveDates.length!==dates.length){
    console.log(`Historical universe note: ${dates.length-effectiveDates.length} snapshot(s) before IWB's first usable SEC N-PORT report (${firstUsableReportDate}) excluded.`);
    dates.splice(0,dates.length,...effectiveDates);
  }
  if(!dates.length)throw new Error(`Requested backtest period ends before IWB's first usable SEC N-PORT report (${firstUsableReportDate}).`);

  // A requested calendar endpoint can be later than the latest N-PORT report that is
  // safely usable under the 100-day staleness rule. That is a trailing data-availability
  // boundary, not an interior coverage failure. Exclude only those unavailable tail
  // snapshots; never substitute today's watchlist. Any missing date *inside* the usable
  // historical span still fails closed below.
  const resolvableDates=dates.filter(d=>loaded.out.get(d)?.holdings?.length>=500);
  if(!resolvableDates.length){
    throw new Error('SEC N-PORT IWB archive could not resolve any requested snapshot date with at least 500 holdings.');
  }
  const lastResolvableDate=resolvableDates.at(-1);
  const tailTrimmedDates=dates.filter(d=>d<=lastResolvableDate);
  if(tailTrimmedDates.length!==dates.length){
    const excluded=dates.filter(d=>d>lastResolvableDate);
    console.log(`Historical universe note: ${excluded.length} trailing snapshot(s) after the latest safely resolvable IWB membership date (${lastResolvableDate}) excluded: ${excluded.join(', ')}.`);
    dates.splice(0,dates.length,...tailTrimmedDates);
  }

  const byDate=new Map(),coverage=[],failures=[];
  for(const asOf of dates){
    const snap=loaded.out.get(asOf);
    if(snap?.holdings?.length>=500){
      byDate.set(asOf,new Map(snap.holdings.map(x=>[x.ticker,x])));
      coverage.push({asOf,sourceAsOf:snap.reportDate,sourceType:'SEC NPORT-P',accession:snap.accession,count:snap.holdings.length,status:'sec_nport_iwb_history'});
    }else{
      const detail={asOf,count:0,status:'sec_nport_iwb_history_unavailable'};coverage.push(detail);failures.push(detail);
    }
  }
  if(failures.length){
    const err=new Error(`SEC N-PORT IWB membership unavailable for ${failures.length}/${dates.length} supported snapshot dates. Backtest aborted; no current-watchlist fallback. Missing: ${failures.map(x=>x.asOf).join(', ')}`);
    err.historicalUniverseCoverage=coverage;throw err;
  }
  const union=new Map();
  for(const m of byDate.values())for(const [ticker,x] of m)if(!union.has(ticker))union.set(ticker,{ticker,sector:x.sector||current.get(ticker)?.sector||'Unknown'});
  return {byDate,coverage,union:[...union.values()],provider:'SEC N-PORT IWB holdings + OpenFIGI CUSIP-to-ticker mapping',requestedStart:START,effectiveStart:Number(dates[0].slice(0,4)),effectiveStartDate:dates[0]};
}

function historicalStockFromData(ticker,sector,rawFacts,priceHistory,asOf,diagnostics=null){
  const facts=factsAsOf(rawFacts,asOf);
  const years=parseAnnualFinancials(facts);
  const quarters=parseQuarterlyRevenue(facts);
  if(years.length<2){ if(diagnostics) diagnostics.insufficientFinancialHistory++; return null; }
  if(diagnostics) diagnostics.usableFinancialHistory++;
  const currentPrice=priceOnOrBefore(priceHistory,asOf);
  if(!(currentPrice>0)){ if(diagnostics) diagnostics.missingHistoricalPrice++; return null; }
  if(diagnostics) diagnostics.historicalPriceFound++;
  normalizeHistoryForCorporateAction(years,latestDilutedSharesFromFacts(facts));
  const last=years.at(-1)||{};

  // Historical runs cannot use today's market-cap reconciliation. Prefer reported
  // diluted shares; repair only with NI / diluted EPS when those two filed facts agree.
  if(Number(last.netIncome)!==0&&Number.isFinite(Number(last.dilutedEPS))&&Math.abs(Number(last.dilutedEPS))>1e-6){
    const implied=Math.abs(Number(last.netIncome)/Number(last.dilutedEPS));
    const reported=Number(last.sharesOutTTM);
    const mismatch=reported>0&&implied>0?Math.max(reported/implied,implied/reported):null;
    if(implied>1e5&&implied<1e12&&(!reported||(mismatch!=null&&mismatch>=3.5))){
      last.sharesOutTTM=implied; last.sharesSource='historical_net_income_div_diluted_eps_repair';
    }
  }
  const shares=finite(last.sharesOutTTM);
  if(!(shares>0)){ if(diagnostics) diagnostics.missingShareCount++; return null; }
  if(diagnostics) diagnostics.shareCountFound++;
  const marketCap=currentPrice*shares;
  const eps=finite(last.netIncome)!=null?finite(last.netIncome)/shares:null;
  const pe=eps?currentPrice/eps:null;
  const ev=marketCap+(finite(last.longTermDebt)||0)-(finite(last.cash)||0);
  const evEbitda=finite(last.ebitda)>0?ev/finite(last.ebitda):null;
  const dividendYield=finite(last.dividendPerShare)>0?finite(last.dividendPerShare)/currentPrice:0;
  const fcfYield=finite(last.fcf)!=null&&marketCap>0?finite(last.fcf)/marketCap:null;
  for(const y of years)y.debtToEbitda=finite(y.longTermDebt)!=null&&finite(y.ebitda)>0?finite(y.longTermDebt)/finite(y.ebitda):null;

  let growthYear1=null;
  if(years.length>=2){
    const lookback=Math.min(3,years.length-1), first=years[years.length-1-lookback];
    const trailing=first.revenue>0?Math.pow(last.revenue/first.revenue,1/lookback)-1:null;
    growthYear1=blendedForwardGrowth(trailing,recentQuarterYoYGrowth(quarters));
  }
  const revenueSource=String(last.revenueSource||'');
  const financialLikeRevenue=/PremiumsEarnedNet|InvestmentIncomeInterestAndDividend|InterestAndDividendIncomeOperating|InterestIncomeExpenseNonoperatingNet|RevenuesNetOfInterestExpense/i.test(revenueSource);
  const nciIncomeShare=finite(last.noncontrollingIncomeShare),nci=finite(last.noncontrollingInterest),eq=finite(last.stockholdersEquity);
  const nciBalanceShare=nci!=null&&eq!=null&&Math.abs(eq)+Math.abs(nci)>0?Math.abs(nci)/(Math.abs(eq)+Math.abs(nci)):null;
  const materialNci=(nciIncomeShare!=null&&nciIncomeShare>=.20)||(nciBalanceShare!=null&&nciBalanceShare>=.20);
  return {
    ticker,sector:sector||'Unknown',asOf,
    financials:{years,dataQuality:{
      revenueProxyYears:years.filter(y=>y.revenueIsProxy).length,
      fcfProxyYears:years.filter(y=>y.fcfIsProxy).length,
      missingCapexYears:years.filter(y=>y.fcfUnavailableReason==='missing_capex').length,
      missingEbitdaYears:years.filter(y=>y.operatingIncome!=null&&y.ebitda==null).length,
      shareDenominatorReliable:true,shareDenominatorReason:'point_in_time_sec_or_eps',financialLikeRevenue,
      materialNoncontrollingInterest:materialNci,noncontrollingIncomeShare:nciIncomeShare,
      noncontrollingBalanceShare:nciBalanceShare,latestRevenueSource:revenueSource||null
    }},
    valuation:{pe,forwardPe:pe,evEbitda,fcfYield,marketCap,ev,dividendYield,growthSource:'point_in_time_sec_history'},
    growthYear1,analystEstimates:null,price:{current:currentPrice},quarterly:quarters,
    corporateActionNormalization:null,shareCountReconciliation:{reliable:true,applied:false,reason:'historical_point_in_time'},
    historicalMultiples:{evEbitda:[],forwardPe:[]},earningsCallText:null
  };
}

function compactModel(stock,f,q,v,d){return {
  ticker:stock.ticker,name:stock.name||stock.ticker,sector:stock.sector,industry:stock.industry||null,sic:stock.sic||null,isBiopharma:!!stock.isBiopharma,marketCap:stock.valuation?.marketCap??null,category:f.category||null,dividendYield:stock.valuation?.dividendYield??0,price:stock.price.current,rating:d.rating,
  investmentScore:d.investmentScore,opportunityScore:d.opportunityScore,opportunityQualityScore:d.opportunityQualityScore,activatedQualityScore:d.activatedQualityScore,qualityActivation:d.qualityActivation,reliabilityScore:d.reliabilityScore,expectedCAGR:v.expectedCAGR,expectedAlpha:d.expectedAlpha,
  fiveYearExpectedCAGR:v.fiveYearExpectedCAGR,bearCAGR:v.bearCAGR,bullCAGR:v.bullCAGR,
  fairValue:v.fairValueEstimate,buyPrice:v.requiredReturnBuyPrice,marginOfSafety:v.marginOfSafety,
  horizonYears:v.horizonYears||10,totalShareholderValue:v.totalShareholderValue,modeledRevenueCAGR:v.modeledRevenueCAGR,
  revenueGrowthAnchor:f.revenueGrowthAnchor,year5OperatingGrowth:f.year5OperatingGrowth,
  targetFcfMargin:f.marginTargets?.fcf??null,targetNetMargin:f.marginTargets?.net??null,
  qualityScore:q.qualityScore,moatScore:q.moatScore,pricingPowerScore:q.pricingPowerScore,
  capitalAllocationScore:q.capitalAllocationScore,compounderScore:q.compounderScore,growthQualityScore:q.growthQualityScore,
  protectionScore:q.protectionScore,forecastConfidence:f.forecastReliabilityScore,
  valuationConfidence:v.valuationConfidenceScore,methodAgreement:v.methodAgreementScore,
  methodCount:(v.methods||[]).length,independentEvidenceFamilies:v.independentMethodCount,
  modelSupport:v.modelSupport
};}
function rank(rows){applyModelDRanking(rows,{rankField:'rank',universeSizeField:'universeSize'});}
function attachRealized(row,history,spyHistory,asOf){
  for(const n of [1,3,5,10]){
    const end=addYears(asOf,n), endPx=priceOnOrBefore(history,end), spy0=priceOnOrBefore(spyHistory,asOf), spy1=priceOnOrBefore(spyHistory,end);
    const priceRealized=endPx>0?cagr(row.price,endPx,n):null, priceBench=spy0>0&&spy1>0?cagr(spy0,spy1,n):null;
    row[`realized${n}YPriceCAGR`]=priceRealized; row[`spy${n}YPriceCAGR`]=priceBench;
    row[`excess${n}YPriceCAGR`]=priceRealized!=null&&priceBench!=null?priceRealized-priceBench:null;
    const totalRealized=totalReturnCAGR(history,asOf,end,n), totalBench=totalReturnCAGR(spyHistory,asOf,end,n);
    row[`realized${n}YTotalReturnCAGR`]=totalRealized; row[`spy${n}YTotalReturnCAGR`]=totalBench;
    row[`excess${n}YTotalReturnCAGR`]=totalRealized!=null&&totalBench!=null?totalRealized-totalBench:null;
  }
}
function alphaBucket(a){if(!Number.isFinite(a))return 'N/A';if(a>=.10)return '>= +10%';if(a>=.05)return '+5% to +10%';if(a>=0)return '0% to +5%';if(a>=-.05)return '-5% to 0%';return '< -5%';}
function summarize(rows,field='realized1YPriceCAGR'){
  const valid=rows.filter(r=>Number.isFinite(r[field]));
  const by=(keyFn)=>Object.entries(valid.reduce((m,r)=>{const k=keyFn(r);(m[k]??=[]).push(r[field]);return m;},{})).map(([bucket,v])=>({bucket,n:v.length,median:median(v),mean:v.reduce((a,b)=>a+b,0)/v.length}));
  return {n:valid.length,byRating:by(r=>r.rating),byAlpha:by(r=>alphaBucket(r.expectedAlpha)),byRankQuintile:by(r=>`Q${Math.min(5,Math.ceil((r.rank/r.universeSize)*5))}`)};
}

function mean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;}
function pctTrue(a){return a.length?a.filter(Boolean).length/a.length:null;}
function percentileSorted(v,p){if(!v.length)return null;const i=(v.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return lo===hi?v[lo]:v[lo]+(v[hi]-v[lo])*(i-lo);}
function outcomeStats(rows,n){
  const excess=`excess${n}YTotalReturnCAGR`,realized=`realized${n}YTotalReturnCAGR`;
  const v=rows.filter(r=>Number.isFinite(r[excess])&&Number.isFinite(r[realized]));
  return {n:v.length,medianRealized:median(v.map(r=>r[realized])),medianExcess:median(v.map(r=>r[excess])),meanExcess:mean(v.map(r=>r[excess])),beatSpyRate:pctTrue(v.map(r=>r[excess]>0)),hit10Rate:pctTrue(v.map(r=>r[realized]>=.10)),hit15Rate:pctTrue(v.map(r=>r[realized]>=.15))};
}
function groupedOutcome(rows,keyFn,n){
  const groups={}; for(const r of rows){const k=keyFn(r);if(k==null)continue;(groups[k]??=[]).push(r);}
  return Object.entries(groups).map(([bucket,v])=>({bucket,...outcomeStats(v,n)}));
}
function scoreDeciles(rows,field,n){
  const vals=rows.map(r=>finite(r[field])).filter(Number.isFinite).sort((a,b)=>a-b); if(vals.length<10)return [];
  const cuts=Array.from({length:9},(_,i)=>percentileSorted(vals,(i+1)/10));
  return groupedOutcome(rows,r=>{const x=finite(r[field]);if(x==null)return null;let d=1;while(d<=9&&x>cuts[d-1])d++;return `D${d}`;},n).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1)));
}
function portfolioStats(periods,{periodsPerYear=1}={}){
  const valid=(periods||[]).filter(y=>Number.isFinite(y.portfolioReturn)&&Number.isFinite(y.spyReturn));
  if(!valid.length)return {periods:[],years:[],periodCount:0,yearCount:0};
  let wealth=1,spyWealth=1,peak=1,maxPeriodEndDrawdown=0;
  const curve=[];
  for(const y of valid){
    wealth*=1+y.portfolioReturn; spyWealth*=1+y.spyReturn;
    peak=Math.max(peak,wealth); maxPeriodEndDrawdown=Math.min(maxPeriodEndDrawdown,wealth/peak-1);
    curve.push({...y,wealth,spyWealth});
  }
  const n=valid.length,years=n/periodsPerYear;
  const portfolioCAGR=years>0?Math.pow(wealth,1/years)-1:null;
  const spyCAGR=years>0?Math.pow(spyWealth,1/years)-1:null;
  const rets=valid.map(y=>y.portfolioReturn),meanRet=mean(rets);
  const variance=rets.length>1?rets.reduce((sum,x)=>sum+(x-meanRet)**2,0)/(rets.length-1):0;
  return {
    periods:curve,years:curve,periodCount:n,yearCount:years,portfolioCAGR,spyCAGR,annualizedExcess:portfolioCAGR-spyCAGR,
    cumulativeReturn:wealth-1,spyCumulativeReturn:spyWealth-1,
    annualVolatility:Math.sqrt(variance*periodsPerYear),periodEndMaxDrawdown:maxPeriodEndDrawdown,yearEndMaxDrawdown:maxPeriodEndDrawdown,
    beatSpyRate:pctTrue(valid.map(y=>y.portfolioReturn>y.spyReturn)),
    positivePeriodRate:pctTrue(valid.map(y=>y.portfolioReturn>0)),positiveYearRate:pctTrue(valid.map(y=>y.portfolioReturn>0)),
    worstPeriod:valid.reduce((a,b)=>!a||b.portfolioReturn<a.portfolioReturn?b:a,null),
    bestPeriod:valid.reduce((a,b)=>!a||b.portfolioReturn>a.portfolioReturn?b:a,null),
    averageHoldings:mean(valid.map(y=>y.holdings)),finalWealth10k:10000*wealth,spyFinalWealth10k:10000*spyWealth
  };
}
function seriesPointOnOrAfter(history,date,maxGapDays=12){
  const t=new Date(date).getTime(); let best=null;
  for(const p of history||[]){const pt=new Date(p.date).getTime();if(pt>=t&&(!best||pt<best.pt))best={t,pt,p};}
  if(!best||(best.pt-best.t)/86400000>maxGapDays)return null;
  return best.p;
}
function adjustedReturnBetween(history,startDate,endDate,{executeAfterStart=true,maxGapDays=12}={}){
  const startTarget=executeAfterStart?addDays(startDate,1):startDate;
  const a=seriesPointOnOrAfter(history,startTarget,maxGapDays);
  const b=seriesPointOnOrAfter(history,addDays(endDate,1),maxGapDays);
  const ap=finite(a?.adjustedClose),bp=finite(b?.adjustedClose);
  if(!(ap>0&&bp>0))return null;
  return {return:bp/ap-1,startPrice:ap,endPrice:bp,startTradeDate:a.date,endTradeDate:b.date};
}
function equalWeightTurnover(targetTickers,priorEndWeights){
  const tickers=[...new Set(targetTickers||[])];
  if(!tickers.length)return 0;
  if(!priorEndWeights||!priorEndWeights.size)return 1;
  const targetW=1/tickers.length,all=new Set([...tickers,...priorEndWeights.keys()]);
  let gross=0;
  for(const t of all)gross+=Math.abs((tickers.includes(t)?targetW:0)-(priorEndWeights.get(t)||0));
  return gross/2;
}
function endWeightsFromReturns(tickers,returnsByTicker){
  const valid=(tickers||[]).filter(t=>Number.isFinite(returnsByTicker.get(t)));
  if(!valid.length)return new Map();
  const startW=1/valid.length,raw=new Map();let total=0;
  for(const t of valid){const v=startW*(1+returnsByTicker.get(t));raw.set(t,v);total+=v;}
  if(!(total>0))return new Map();
  return new Map([...raw].map(([t,v])=>[t,v/total]));
}
function dailyPortfolioRisk(tickersOrWeights,startDate,endDate,historyByTicker,spyHistory){
  const weighted=tickersOrWeights instanceof Map;
  const positions=weighted?[...tickersOrWeights.entries()].map(([ticker,weight])=>({ticker,weight})):(tickersOrWeights||[]).map(ticker=>({ticker,weight:null}));
  const equalWeight=!weighted&&positions.length?1/positions.length:0;
  const series=[];
  for(const pos of positions){
    const ticker=pos.ticker,h=historyByTicker.get(ticker)||[];
    const start=seriesPointOnOrAfter(h,addDays(startDate,1));
    if(!(finite(start?.adjustedClose)>0))continue;
    const points=(h||[]).filter(p=>p.date>=start.date&&p.date<=addDays(endDate,7)&&finite(p.adjustedClose)>0);
    if(points.length<2)continue;
    series.push({ticker,weight:weighted?(finite(pos.weight)||0):equalWeight,startPx:finite(start.adjustedClose),byDate:new Map(points.map(p=>[p.date,finite(p.adjustedClose)]))});
  }
  const spyStart=seriesPointOnOrAfter(spyHistory,addDays(startDate,1)),spyStartPx=finite(spyStart?.adjustedClose);
  const spyEnd=seriesPointOnOrAfter(spyHistory,addDays(endDate,1));
  const dates=(spyHistory||[]).filter(p=>p.date>=(spyStart?.date||startDate)&&p.date<=(spyEnd?.date||endDate)&&finite(p.adjustedClose)>0).map(p=>p.date);
  if(!series.length||!(spyStartPx>0)||!dates.length)return null;
  const investedWeight=series.reduce((a,x)=>a+x.weight,0),cashWeight=Math.max(0,1-investedWeight);
  let peak=1,maxDrawdown=0,spyPeak=1,spyMaxDrawdown=0,lastVals=new Map();
  for(const date of dates){
    let wealth=cashWeight,seenWeight=0;
    for(const s of series){const px=s.byDate.get(date);if(px>0)lastVals.set(s.ticker,px);const use=lastVals.get(s.ticker);if(use>0){wealth+=s.weight*(use/s.startPx);seenWeight+=s.weight;}}
    if(!(seenWeight>0))continue;
    peak=Math.max(peak,wealth);maxDrawdown=Math.min(maxDrawdown,wealth/peak-1);
    const spy=priceOnOrBefore(spyHistory,date,5,'adjustedClose');if(spy>0){const sw=spy/spyStartPx;spyPeak=Math.max(spyPeak,sw);spyMaxDrawdown=Math.min(spyMaxDrawdown,sw/spyPeak-1);}
  }
  return {dailyMaxDrawdown:maxDrawdown,spyDailyMaxDrawdown:spyMaxDrawdown,seriesCount:series.length};
}
function economicSecurityGroup(ticker){
  const t=String(ticker||'').toUpperCase();
  if(t==='GOOG'||t==='GOOGL')return 'ALPHABET';
  return t;
}
function dedupeEconomicSecurities(rows){
  const out=[],seen=new Set();
  for(const r of rows||[]){
    const g=economicSecurityGroup(r?.ticker);
    if(!g||seen.has(g))continue;
    seen.add(g);out.push(r);
  }
  return out;
}

function eligibleForStrategy(snap,{topN=20,minAlpha=.10,requireTopRank=false}={}){
  const ranked=(snap?.rows||[])
    .filter(r=>Number.isFinite(r.expectedAlpha))
    .filter(r=>r.expectedAlpha>=minAlpha)
    .filter(r=>!requireTopRank||r.rank<=Math.ceil((r.universeSize||snap.rows.length)*.20))
    .sort((a,b)=>(a.rank||Infinity)-(b.rank||Infinity));
  return dedupeEconomicSecurities(ranked).slice(0,topN);
}
function simulateInvestablePortfolio(snapshotOutput,historyByTicker,spyHistory,{name,topN=20,minAlpha=.10,requireTopRank=false,transactionCostBps=10}={}){
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  const periods=[];let priorEndWeights=new Map();
  for(let i=0;i<snaps.length;i++){
    const snap=snaps[i],endDate=snaps[i+1]?.asOf||addMonths(snap.asOf,3);
    if(new Date(endDate)>new Date())continue;
    const selected=eligibleForStrategy(snap,{topN,minAlpha,requireTopRank});
    if(!selected.length)continue;
    const stockReturns=new Map();let commonStart=null,commonEnd=null;
    for(const r of selected){
      const x=adjustedReturnBetween(historyByTicker.get(r.ticker)||[],snap.asOf,endDate,{executeAfterStart:true});
      if(!x)continue;stockReturns.set(r.ticker,x.return);commonStart=commonStart||x.startTradeDate;commonEnd=commonEnd||x.endTradeDate;
    }
    const tickers=selected.map(r=>r.ticker).filter(t=>stockReturns.has(t));
    if(!tickers.length)continue;
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,endDate,{executeAfterStart:true});if(!spy)continue;
    const grossReturn=mean(tickers.map(t=>stockReturns.get(t)));
    const turnover=equalWeightTurnover(tickers,priorEndWeights);
    const transactionCost=turnover*(transactionCostBps/10000);
    const portfolioReturn=grossReturn-transactionCost;
    const risk=dailyPortfolioRisk(tickers,snap.asOf,endDate,historyByTicker,spyHistory);
    const sectorCounts={};for(const r of selected.filter(r=>tickers.includes(r.ticker))){const sk=String(r.sector||'Unknown');sectorCounts[sk]=(sectorCounts[sk]||0)+1;}
    const maxSectorWeight=tickers.length&&Object.keys(sectorCounts).length?Math.max(...Object.values(sectorCounts))/tickers.length:0;
    periods.push({
      asOf:snap.asOf,startDate:snap.asOf,endDate,startTradeDate:commonStart||spy.startTradeDate,endTradeDate:commonEnd||spy.endTradeDate,
      startYear:Number(String(snap.asOf).slice(0,4)),holdings:tickers.length,tickers,cashWeight:0,maxHoldingWeight:tickers.length?1/tickers.length:0,maxSectorWeight,
      grossReturn,portfolioReturn,spyReturn:spy.return,excessReturn:portfolioReturn-spy.return,
      turnover,transactionCost,transactionCostBps,dailyMaxDrawdown:risk?.dailyMaxDrawdown??null,spyDailyMaxDrawdown:risk?.spyDailyMaxDrawdown??null
    });
    priorEndWeights=endWeightsFromReturns(tickers,stockReturns);
  }
  const periodsPerYear=FREQUENCY==='quarterly'?4:1,stats=portfolioStats(periods,{periodsPerYear});
  stats.dailyMaxDrawdown=periods.map(y=>y.dailyMaxDrawdown).filter(Number.isFinite).reduce((m,x)=>Math.min(m,x),0);
  stats.spyDailyMaxDrawdown=periods.map(y=>y.spyDailyMaxDrawdown).filter(Number.isFinite).reduce((m,x)=>Math.min(m,x),0);
  stats.averageTurnover=mean(periods.map(y=>y.turnover));
  stats.annualizedTurnover=stats.averageTurnover*periodsPerYear;
  stats.averageCashWeight=0;
  stats.maxObservedHoldingWeight=periods.length?Math.max(...periods.map(y=>y.maxHoldingWeight||0)):0;
  stats.maxObservedSectorWeight=periods.length?Math.max(...periods.map(y=>y.maxSectorWeight||0)):0;
  stats.totalTransactionCost=periods.reduce((a,y)=>a+(y.transactionCost||0),0);
  return {name,topN,minAlpha,requireTopRank,transactionCostBps,rebalanceFrequency:FREQUENCY,...stats};
}

function thesisEntryEligible(r,{minExpectedCAGR=.15,maxRank=25,minMarketCap=0,excludeBiopharma=false}={}){
  return !!r&&Number.isFinite(r.expectedCAGR)&&r.expectedCAGR>=minExpectedCAGR&&Number.isFinite(r.rank)&&r.rank<=maxRank&&String(r.modelSupport||'')!=='unsupported'&&(!minMarketCap||(Number.isFinite(r.marketCap)&&r.marketCap>=minMarketCap))&&(!excludeBiopharma||!r.isBiopharma);
}
function thesisTargetWeight(r,{maxInitialWeight=.10}={}){
  // Transparent conviction sizing: rank establishes the base size, while unusually
  // strong/weak evidence nudges it by only 1 percentage point. Expected CAGR is an
  // entry hurdle, not an excuse to lever the highest forecast.
  const rank=Number(r?.rank),fc=finite(r?.forecastConfidence),vc=finite(r?.valuationConfidence),q=finite(r?.qualityScore),pr=finite(r?.protectionScore);
  let w=rank<=5?.10:rank<=10?.08:rank<=15?.06:rank<=20?.05:.03;
  const evidence=[fc,vc,q,pr].filter(Number.isFinite);
  const avg=evidence.length?mean(evidence):null;
  if(avg!=null&&avg>=85)w+=.01;
  else if(avg!=null&&avg<65)w-=.01;
  return Math.max(.02,Math.min(maxInitialWeight,w));
}
function trailingAdjustedReturn(history,asOf,months){
  const a=priceOnOrBefore(history,addMonths(asOf,-months),20,'adjustedClose');
  const b=priceOnOrBefore(history,asOf,12,'adjustedClose');
  if(!(a>0&&b>0))return null;
  return b/a-1;
}
function winnerMomentum(ticker,asOf,historyByTicker,spyHistory){
  const h=historyByTicker?.get(ticker)||[];
  const stock3=trailingAdjustedReturn(h,asOf,3),stock6=trailingAdjustedReturn(h,asOf,6),stock12=trailingAdjustedReturn(h,asOf,12);
  const spy6=trailingAdjustedReturn(spyHistory,asOf,6),spy12=trailingAdjustedReturn(spyHistory,asOf,12);
  const rel6=Number.isFinite(stock6)&&Number.isFinite(spy6)?stock6-spy6:null;
  const rel12=Number.isFinite(stock12)&&Number.isFinite(spy12)?stock12-spy12:null;
  // A valuation-stretched winner earns a ride only when its recent tape is still
  // healthy and it is outperforming the market over both medium and long windows.
  // Requiring one of those relative spreads to be >=5 points avoids treating a
  // barely-positive drift as a momentum trend.
  const strong=Number.isFinite(stock3)&&stock3>0&&Number.isFinite(rel6)&&rel6>0&&Number.isFinite(rel12)&&rel12>0&&(rel6>=.05||rel12>=.05);
  return {strong,stock3,stock6,stock12,spy6,spy12,rel6,rel12};
}
function thesisSellReason(current,entry,{sellExpectedCAGR=.06,rideMomentum=false,momentum=null}={}){
  // Missing universe membership/model coverage is NOT a sell signal. A real owner
  // would keep the shares until the thesis can be evaluated again.
  if(!current)return null;
  if(String(current.modelSupport||'')==='unsupported')return null;
  const q0=finite(entry?.qualityScore),q=finite(current.qualityScore);
  if(q0!=null&&q!=null&&q<60&&q<=q0-15)return 'quality_thesis_deteriorated';
  const p0=finite(entry?.protectionScore),pr=finite(current.protectionScore);
  if(p0!=null&&pr!=null&&pr<50&&pr<=p0-20)return 'protection_thesis_deteriorated';
  if(Number.isFinite(current.forecastConfidence)&&current.forecastConfidence<40)return 'forecast_support_deteriorated';
  if(Number.isFinite(current.expectedCAGR)&&current.expectedCAGR<sellExpectedCAGR){
    if(rideMomentum&&momentum?.strong)return null;
    return rideMomentum?'low_return_momentum_broken':'forward_return_below_hold_floor';
  }
  return null;
}
function thesisBuyCandidates(snap,held,{minExpectedCAGR=.15,maxRank=25,minMarketCap=0,excludeBiopharma=false,excludedTickers=null}={}){
  const excluded=excludedTickers instanceof Set?excludedTickers:new Set(excludedTickers||[]);
  const heldGroups=new Set([...held].map(economicSecurityGroup));
  const ranked=(snap?.rows||[]).filter(r=>!held.has(r.ticker)&&!excluded.has(r.ticker)&&!heldGroups.has(economicSecurityGroup(r.ticker))&&thesisEntryEligible(r,{minExpectedCAGR,maxRank,minMarketCap,excludeBiopharma}))
    .sort((a,b)=>(a.rank||Infinity)-(b.rank||Infinity));
  return dedupeEconomicSecurities(ranked);
}
function simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name='Sized thesis hold',topN=20,minExpectedCAGR=.15,maxRank=25,minMarketCap=0,excludeBiopharma=false,sellExpectedCAGR=.06,maxInitialWeight=.10,rideMomentum=false,sellPolicy='current',lowReturnConfirmations=1,forecastConfirmations=1,rotationMinExpectedCAGR=.15,transactionCostBps=10,excludedTickers=null,computeDailyRisk=true,initialDeploymentCap=1,sectorPurchaseCap=1,hardHoldingCap=1,scaleInitialBatch=false}={}){
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  const excluded=excludedTickers instanceof Set?excludedTickers:new Set(excludedTickers||[]);
  let weights=new Map(),entries=new Map(),reviewState=new Map(),cash=1,totalSells=0,totalRotations=0,totalThesisSells=0,totalBuys=0,totalAdds=0,totalTrims=0,totalRideReviews=0,holdingQuarterSum=0,closedHolds=0,initialized=false;
  const periods=[],sellReasons={};
  for(let i=0;i<snaps.length;i++){
    const snap=snaps[i],next=snaps[i+1]; if(!next)break;
    const rowMap=new Map((snap.rows||[]).map(r=>[r.ticker,r]));
    let turnover=0,freed=0,sells=[],buys=[],adds=[],buyTrades=[],addTrades=[];
    const rides=[];
    for(const [t,w] of [...weights]){
      if(excluded.has(t)){weights.delete(t);freed+=w;turnover+=w;entries.delete(t);continue;}
      const current=rowMap.get(t);
      const momentum=rideMomentum&&Number.isFinite(current?.expectedCAGR)&&current.expectedCAGR<sellExpectedCAGR?winnerMomentum(t,snap.asOf,historyByTicker,spyHistory):null;
      const st=reviewState.get(t)||{lowReturn:0,forecastWeak:0};
      const c=finite(current?.expectedCAGR),fc=finite(current?.forecastConfidence);
      st.lowReturn=(c!=null&&c<sellExpectedCAGR)?st.lowReturn+1:0;
      st.forecastWeak=(fc!=null&&fc<40)?st.forecastWeak+1:0;
      reviewState.set(t,st);
      let reason=thesisSellReason(current,entries.get(t),{sellExpectedCAGR,rideMomentum,momentum});
      if(reason==='forecast_support_deteriorated'&&st.forecastWeak<forecastConfirmations)reason=null;
      if(reason==='low_return_momentum_broken'&&st.lowReturn<lowReturnConfirmations)reason=null;
      if(reason==='forward_return_below_hold_floor'&&st.lowReturn<lowReturnConfirmations)reason=null;
      if(sellPolicy==='thesis_only'&&(reason==='low_return_momentum_broken'||reason==='forward_return_below_hold_floor'))reason=null;
      if(sellPolicy==='strict_thesis_only'&&(reason==='forecast_support_deteriorated'||reason==='low_return_momentum_broken'||reason==='forward_return_below_hold_floor'))reason=null;
      if(sellPolicy==='rotation_separated'){
        // Forecast weakness is not itself a broken business thesis. Treat it as a
        // possible capital-rotation event only when the held name no longer clears
        // the entry hurdle and a genuinely eligible replacement exists today.
        if(reason==='low_return_momentum_broken'||reason==='forward_return_below_hold_floor')reason=null;
        if(reason==='forecast_support_deteriorated'){
          const heldNow=new Set(weights.keys()); heldNow.delete(t);
          const replacement=thesisBuyCandidates(snap,heldNow,{minExpectedCAGR:rotationMinExpectedCAGR,maxRank,minMarketCap,excludeBiopharma,excludedTickers:excluded})[0]||null;
          const replacementCAGR=finite(replacement?.expectedCAGR??replacement?.expectedReturn);
          if(st.forecastWeak>=forecastConfirmations&&c!=null&&c<rotationMinExpectedCAGR&&replacementCAGR!=null&&replacementCAGR>=rotationMinExpectedCAGR&&replacementCAGR>c){
            reason='rotation_forecast_support_deteriorated';
          }else reason=null;
        }
      }
      if(sellPolicy==='extreme_valuation_confirmed'&&(reason==='low_return_momentum_broken'||reason==='forward_return_below_hold_floor')){
        if(!(c!=null&&c<0&&st.lowReturn>=lowReturnConfirmations))reason=null;
        else reason='extreme_valuation_confirmed';
      }
      if(!reason&&momentum?.strong){rides.push({ticker:t,expectedCAGR:current.expectedCAGR,...momentum});totalRideReviews++;}
      if(reason){weights.delete(t);freed+=w;turnover+=w;const exitType=reason.startsWith('rotation_')?'ROTATE':'SELL';sells.push({ticker:t,reason,exitType,momentum,confirmations:{...st}});sellReasons[reason]=(sellReasons[reason]||0)+1;totalSells++;if(exitType==='ROTATE')totalRotations++;else totalThesisSells++;const e=entries.get(t);if(e){holdingQuarterSum+=i-e.snapshotIndex;closedHolds++;}entries.delete(t);reviewState.delete(t);}
    }
    cash+=freed;
    // The practical-construction challenger lets winners run, but applies only a very
    // high hard concentration guardrail. This is not routine rebalancing: nothing is
    // trimmed merely for drifting above its entry target.
    const trims=[];
    if(Number.isFinite(hardHoldingCap)&&hardHoldingCap<1){
      for(const [t,w] of [...weights]){
        if(w<=hardHoldingCap)continue;
        const amt=w-hardHoldingCap;
        weights.set(t,hardHoldingCap);cash+=amt;turnover+=amt;totalTrims++;trims.push({ticker:t,weight:amt,reason:'hard_concentration_cap'});
      }
    }
    const sectorKey=r=>String(r?.sector||'Unknown');
    const sectorWeight=sector=>{
      let total=0;
      for(const [t,w] of weights){const r=rowMap.get(t)||entries.get(t);if(sectorKey(r)===sector)total+=w;}
      return total;
    };
    // Add new positions by conviction-sized target rather than equal weighting. The
    // optional starter rule deploys only a predeclared fraction on the first review and
    // spreads that deployment across all selected names instead of filling slots one by one.
    const vacancies=Math.max(0,topN-weights.size);
    const cands=thesisBuyCandidates(snap,new Set(weights.keys()),{minExpectedCAGR,maxRank,minMarketCap,excludeBiopharma,excludedTickers:excluded}).slice(0,vacancies);
    const firstBatch=!initialized&&weights.size===0&&cands.length>0;
    const rawTargets=cands.map(r=>thesisTargetWeight(r,{maxInitialWeight}));
    const rawTotal=rawTargets.reduce((a,b)=>a+b,0);
    const batchScale=firstBatch&&scaleInitialBatch&&rawTotal>0?Math.min(1,Math.max(0,initialDeploymentCap)/rawTotal):1;
    for(let ci=0;ci<cands.length;ci++){
      const r=cands[ci]; if(cash<=1e-9)break;
      const target=rawTargets[ci]*batchScale;
      const sector=sectorKey(r),sectorRoom=Number.isFinite(sectorPurchaseCap)?Math.max(0,sectorPurchaseCap-sectorWeight(sector)):cash;
      const deploymentRoom=firstBatch?Math.max(0,initialDeploymentCap-(1-cash)):cash;
      const amt=Math.min(cash,target,sectorRoom,deploymentRoom);
      if(amt<.005)continue;
      weights.set(r.ticker,amt);entries.set(r.ticker,{...r,snapshotIndex:i,entryAsOf:snap.asOf});reviewState.set(r.ticker,{lowReturn:0,forecastWeak:0});cash-=amt;turnover+=amt;totalBuys++;buys.push(r.ticker);buyTrades.push({ticker:r.ticker,weight:amt,targetWeight:target,rank:r.rank,expectedCAGR:r.expectedCAGR,sector});
    }
    if(firstBatch)initialized=true;
    // A qualifying holding may be topped up toward today's justified target when cash is
    // available. Sector caps apply to purchases only; existing winners are not forcibly
    // sold because their sector or stock weight later drifts higher.
    const addable=firstBatch?[]:dedupeEconomicSecurities([...weights.keys()].map(t=>rowMap.get(t)).filter(r=>r&&!excluded.has(r.ticker)&&thesisEntryEligible(r,{minExpectedCAGR,maxRank,minMarketCap,excludeBiopharma})).sort((a,b)=>(a.rank||Infinity)-(b.rank||Infinity)));
    for(const r of addable){
      if(cash<=1e-9)break;
      const cur=weights.get(r.ticker)||0,target=thesisTargetWeight(r,{maxInitialWeight});
      const sector=sectorKey(r),sectorRoom=Number.isFinite(sectorPurchaseCap)?Math.max(0,sectorPurchaseCap-sectorWeight(sector)):cash;
      const amt=Math.min(cash,Math.max(0,target-cur),sectorRoom);
      if(amt>=.005){weights.set(r.ticker,cur+amt);cash-=amt;turnover+=amt;totalAdds++;adds.push(r.ticker);addTrades.push({ticker:r.ticker,weight:amt,targetWeight:target,rank:r.rank,expectedCAGR:r.expectedCAGR,sector});}
    }
    const periodStartWeights=new Map(weights);
    const stockReturns=new Map(); let commonStart=null,commonEnd=null;
    for(const [t] of weights){const x=adjustedReturnBetween(historyByTicker.get(t)||[],snap.asOf,next.asOf,{executeAfterStart:true});if(x){stockReturns.set(t,x.return);commonStart=commonStart||x.startTradeDate;commonEnd=commonEnd||x.endTradeDate;}}
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,next.asOf,{executeAfterStart:true});if(!spy)continue;
    let grossReturn=0,endTotal=cash;
    const tickerContributions=[];
    for(const [t,w] of weights){
      const rr=stockReturns.get(t),realized=Number.isFinite(rr)?rr:0;
      const end=w*(1+realized);grossReturn+=w*realized;
      tickerContributions.push({ticker:t,startWeight:w,stockReturn:realized,returnContribution:w*realized,activeContribution:w*(realized-spy.return)});
      weights.set(t,end);endTotal+=end;
    }
    const cashActiveContribution=cash*(0-spy.return);
    if(endTotal>0){for(const [t,w] of weights)weights.set(t,w/endTotal);cash/=endTotal;}
    const transactionCost=turnover*(transactionCostBps/10000),portfolioReturn=grossReturn-transactionCost;
    const risk=computeDailyRisk?dailyPortfolioRisk(periodStartWeights,snap.asOf,next.asOf,historyByTicker,spyHistory):null;
    const endSectorWeights={};for(const [t,w] of weights){const r=rowMap.get(t)||entries.get(t);const sk=String(r?.sector||'Unknown');endSectorWeights[sk]=(endSectorWeights[sk]||0)+w;}
    const maxHoldingWeight=weights.size?Math.max(...weights.values()):0,maxSectorWeight=Object.keys(endSectorWeights).length?Math.max(...Object.values(endSectorWeights)):0;
    periods.push({asOf:snap.asOf,startDate:snap.asOf,endDate:next.asOf,startTradeDate:commonStart||spy.startTradeDate,endTradeDate:commonEnd||spy.endTradeDate,startYear:Number(snap.asOf.slice(0,4)),holdings:weights.size,tickers:[...weights.keys()],cashWeight:cash,maxHoldingWeight,maxSectorWeight,sectorWeights:endSectorWeights,grossReturn,portfolioReturn,spyReturn:spy.return,excessReturn:portfolioReturn-spy.return,turnover,transactionCost,transactionCostBps,buys,adds,trims,rides,buyTrades,addTrades,sells,tickerContributions,cashActiveContribution,dailyMaxDrawdown:risk?.dailyMaxDrawdown??null});
  }
  const stats=portfolioStats(periods,{periodsPerYear:4});
  stats.dailyMaxDrawdown=periods.map(x=>x.dailyMaxDrawdown).filter(Number.isFinite).reduce((m,x)=>Math.min(m,x),0);
  stats.averageTurnover=mean(periods.map(x=>x.turnover));stats.annualizedTurnover=stats.averageTurnover*4;stats.averageCashWeight=mean(periods.map(x=>x.cashWeight));stats.maxObservedHoldingWeight=periods.length?Math.max(...periods.map(x=>x.maxHoldingWeight||0)):0;stats.maxObservedSectorWeight=periods.length?Math.max(...periods.map(x=>x.maxSectorWeight||0)):0;stats.totalBuys=totalBuys;stats.totalAdds=totalAdds;stats.totalTrims=totalTrims;stats.totalSells=totalSells;stats.totalThesisSells=totalThesisSells;stats.totalRotations=totalRotations;stats.totalRideReviews=totalRideReviews;stats.sellReasons=sellReasons;stats.averageClosedHoldingYears=closedHolds?holdingQuarterSum/closedHolds/4:null;stats.endingHoldings=weights.size;stats.endingCashWeight=cash;
  return {name,topN,minExpectedCAGR,maxRank,minMarketCap,excludeBiopharma,sellExpectedCAGR,maxInitialWeight,rideMomentum,sellPolicy,lowReturnConfirmations,forecastConfirmations,rotationMinExpectedCAGR,transactionCostBps,initialDeploymentCap,sectorPurchaseCap,hardHoldingCap,scaleInitialBatch,reviewFrequency:FREQUENCY,philosophy:rideMomentum?'15pct_cagr_top25_sized_ride_winners':'15pct_cagr_top25_conviction_sized_buy_hold_loose',...stats};
}

function forwardCAGRFromSignal(history,startDate,years){
  const months=Math.round(Number(years)*12);
  const endDate=Number.isInteger(Number(years))?addYears(startDate,Number(years)):addMonths(startDate,months);
  const x=adjustedReturnBetween(history||[],startDate,endDate,{executeAfterStart:true,maxGapDays:30});
  if(!x||!Number.isFinite(x.return)||x.return<=-1)return null;
  return {cagr:Math.pow(1+x.return,1/years)-1,totalReturn:x.return,startTradeDate:x.startTradeDate,endTradeDate:x.endTradeDate,endDate};
}
function replacementBasketCAGR(trades,historyByTicker,startDate,years){
  const valid=[];
  for(const tr of trades||[]){
    const x=forwardCAGRFromSignal(historyByTicker.get(tr.ticker)||[],startDate,years);
    const w=finite(tr.weight);
    if(x&&Number.isFinite(w)&&w>0)valid.push({ticker:tr.ticker,weight:w,...x});
  }
  if(!valid.length)return null;
  const sumW=valid.reduce((a,x)=>a+x.weight,0);
  if(!(sumW>0))return null;
  const terminal=valid.reduce((a,x)=>a+(x.weight/sumW)*(1+x.totalReturn),0);
  return {cagr:terminal>0?Math.pow(terminal,1/years)-1:null,tickers:valid.map(x=>x.ticker),count:valid.length};
}
function buildSellDecisionAudit(strategy,historyByTicker,spyHistory,{horizons=[.25,.5,1,2]}={}){
  const events=[];
  for(const period of strategy?.periods||[]){
    if(!(period.sells||[]).length)continue;
    // New buys made at the same review are the cleanest observable replacement set.
    // Adds are reported separately and are not treated as a replacement purchase.
    const replacements=period.buyTrades||[];
    for(const sale of period.sells){
      const evt={asOf:period.asOf,ticker:sale.ticker,reason:sale.reason,replacements:replacements.map(x=>x.ticker),horizons:{}};
      for(const years of horizons){
        const sold=forwardCAGRFromSignal(historyByTicker.get(sale.ticker)||[],period.asOf,years);
        const spy=forwardCAGRFromSignal(spyHistory,period.asOf,years);
        const repl=replacementBasketCAGR(replacements,historyByTicker,period.asOf,years);
        const soldCAGR=sold?.cagr??null,spyCAGR=spy?.cagr??null,replacementCAGR=repl?.cagr??null;
        evt.horizons[years]={soldCAGR,spyCAGR,replacementCAGR,soldVsSpy:Number.isFinite(soldCAGR)&&Number.isFinite(spyCAGR)?soldCAGR-spyCAGR:null,replacementVsSold:Number.isFinite(replacementCAGR)&&Number.isFinite(soldCAGR)?replacementCAGR-soldCAGR:null,replacementCount:repl?.count||0};
      }
      events.push(evt);
    }
  }
  const byReason={};
  for(const evt of events){
    const bucket=byReason[evt.reason]||(byReason[evt.reason]={reason:evt.reason,count:0,horizons:{}});bucket.count++;
    for(const years of horizons){
      const h=evt.horizons[years]||{};const b=bucket.horizons[years]||(bucket.horizons[years]={n:0,meanSoldCAGR:null,meanSoldVsSpy:null,meanReplacementVsSold:null,missedWinnerRate:null,avoidedUnderperformerRate:null,_sold:[],_svs:[],_rvs:[],_miss:[],_avoid:[]});
      if(Number.isFinite(h.soldCAGR))b._sold.push(h.soldCAGR);
      if(Number.isFinite(h.soldVsSpy)){b._svs.push(h.soldVsSpy);b._miss.push(h.soldVsSpy>.02);b._avoid.push(h.soldVsSpy<-.02);}
      if(Number.isFinite(h.replacementVsSold))b._rvs.push(h.replacementVsSold);
    }
  }
  for(const bucket of Object.values(byReason))for(const years of horizons){const b=bucket.horizons[years];b.n=b._sold.length;b.meanSoldCAGR=mean(b._sold);b.meanSoldVsSpy=mean(b._svs);b.meanReplacementVsSold=mean(b._rvs);b.missedWinnerRate=b._miss.length?pctTrue(b._miss):null;b.avoidedUnderperformerRate=b._avoid.length?pctTrue(b._avoid):null;delete b._sold;delete b._svs;delete b._rvs;delete b._miss;delete b._avoid;}
  const summary={sellCount:events.length,horizons:{}};
  for(const years of horizons){
    const hs=events.map(e=>e.horizons[years]).filter(Boolean),svs=hs.map(x=>x.soldVsSpy).filter(Number.isFinite),rvs=hs.map(x=>x.replacementVsSold).filter(Number.isFinite);
    summary.horizons[years]={n:hs.filter(x=>Number.isFinite(x.soldCAGR)).length,meanSoldCAGR:mean(hs.map(x=>x.soldCAGR).filter(Number.isFinite)),meanSoldVsSpy:mean(svs),meanReplacementVsSold:mean(rvs),missedWinnerRate:svs.length?pctTrue(svs.map(x=>x>.02)):null,avoidedUnderperformerRate:svs.length?pctTrue(svs.map(x=>x<-.02)):null};
  }
  return {description:'Post-sale audit. Sold-stock and same-review replacement-buy CAGRs are measured from the first trading day after the review, without assuming the later portfolio actions were known at the sale date.',events,byReason:Object.values(byReason),summary};
}

// Retain the overlapping one-year cohort test as a diagnostic only. It must never be
// compounded into a wealth curve because quarterly start cohorts overlap in time.
function simulateOneYearCohorts(snapshotOutput,{name,topN=20,minAlpha=.10,requireTopRank=false}={}){
  const cohorts=[];
  for(const snap of snapshotOutput||[]){
    const eligible=eligibleForStrategy(snap,{topN,minAlpha,requireTopRank})
      .filter(r=>Number.isFinite(r.realized1YTotalReturnCAGR)&&Number.isFinite(r.spy1YTotalReturnCAGR));
    if(!eligible.length)continue;
    const portfolioReturn=mean(eligible.map(r=>r.realized1YTotalReturnCAGR));
    const spyReturn=median(eligible.map(r=>r.spy1YTotalReturnCAGR));
    cohorts.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:eligible.length,portfolioReturn,spyReturn,excessReturn:portfolioReturn-spyReturn});
  }
  return {name,cohortCount:cohorts.length,meanPortfolioReturn:mean(cohorts.map(x=>x.portfolioReturn)),meanSpyReturn:mean(cohorts.map(x=>x.spyReturn)),meanExcess:mean(cohorts.map(x=>x.excessReturn)),beatSpyRate:pctTrue(cohorts.map(x=>x.excessReturn>0)),cohorts};
}
function periodStats(strategy,startYear,endYear){
  const periods=(strategy?.periods||strategy?.years||[]).filter(y=>y.startYear>=startYear&&y.startYear<=endYear);
  return {...portfolioStats(periods,{periodsPerYear:FREQUENCY==='quarterly'?4:1}),startYear,endYear};
}

function safeRatio(a,b){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(b)>1e-12?a/b:null;}
function contributionConcentration(strategy){
  const byTicker=new Map(); let cashActive=0,cost=0;
  for(const p of strategy?.periods||[]){
    for(const c of p.tickerContributions||[]){
      const x=byTicker.get(c.ticker)||{ticker:c.ticker,activeContribution:0,returnContribution:0,periodsHeld:0};
      x.activeContribution+=finite(c.activeContribution)||0;x.returnContribution+=finite(c.returnContribution)||0;x.periodsHeld++;byTicker.set(c.ticker,x);
    }
    cashActive+=finite(p.cashActiveContribution)||0;cost+=finite(p.transactionCost)||0;
  }
  const ranked=[...byTicker.values()].sort((a,b)=>b.activeContribution-a.activeContribution);
  const positiveTotal=ranked.filter(x=>x.activeContribution>0).reduce((a,x)=>a+x.activeContribution,0);
  const signedStockActive=ranked.reduce((a,x)=>a+x.activeContribution,0);
  const shareTop=n=>safeRatio(ranked.slice(0,n).filter(x=>x.activeContribution>0).reduce((a,x)=>a+x.activeContribution,0),positiveTotal);
  return {description:'Active contribution is start-of-period portfolio weight × (stock return − SPY return). Shares use positive stock active contribution as denominator; cash drag and transaction costs are shown separately.',tickerCount:ranked.length,signedStockActiveContribution:signedStockActive,cashActiveContribution:cashActive,transactionCostDrag:cost,positiveStockActiveContribution:positiveTotal,top1ShareOfPositiveActive:shareTop(1),top5ShareOfPositiveActive:shareTop(5),top10ShareOfPositiveActive:shareTop(10),topContributors:ranked.slice(0,20)};
}
function leaveWinnersOut(snapshotOutput,historyByTicker,spyHistory,baseStrategy,{transactionCostBps=10}={}){
  const c=contributionConcentration(baseStrategy),leaders=c.topContributors.filter(x=>x.activeContribution>0).map(x=>x.ticker);
  const configs=[{label:'exclude_top_1',tickers:leaders.slice(0,1)},{label:'exclude_top_5',tickers:leaders.slice(0,5)}];
  const runs=[];
  for(const cfg of configs){
    if(!cfg.tickers.length)continue;
    const r=simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:`Robustness · ${cfg.label}`,topN:baseStrategy.topN,minExpectedCAGR:baseStrategy.minExpectedCAGR,maxRank:baseStrategy.maxRank,minMarketCap:baseStrategy.minMarketCap||0,excludeBiopharma:!!baseStrategy.excludeBiopharma,sellExpectedCAGR:baseStrategy.sellExpectedCAGR,maxInitialWeight:baseStrategy.maxInitialWeight,rideMomentum:!!baseStrategy.rideMomentum,transactionCostBps,excludedTickers:new Set(cfg.tickers),computeDailyRisk:false});
    runs.push({label:cfg.label,excludedTickers:cfg.tickers,portfolioCAGR:r.portfolioCAGR,spyCAGR:r.spyCAGR,annualizedExcess:r.annualizedExcess,periodCount:r.periodCount,development:periodStats(r,2019,2021),validation:periodStats(r,2022,2025)});
  }
  return {concentration:c,runs};
}
function buildParameterStability(snapshotOutput,historyByTicker,spyHistory,{transactionCostBps=10}={}){
  const portfolioSizes=[10,15,20,25,30,40,50],cagrGates=[.05,.075,.10,.125,.15,.175,.20],rankCaps=[10,20,25,50];
  const cells=[];
  for(const topN of portfolioSizes)for(const minExpectedCAGR of cagrGates)for(const maxRank of rankCaps){
    const r=simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'parameter_cell',topN,minExpectedCAGR,maxRank,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps,computeDailyRisk:false});
    const development=periodStats(r,2019,2021),validation=periodStats(r,2022,2025);
    cells.push({topN,minExpectedCAGR,maxRank,portfolioCAGR:r.portfolioCAGR,spyCAGR:r.spyCAGR,annualizedExcess:r.annualizedExcess,periodCount:r.periodCount,averageHoldings:r.averageHoldings,development:{portfolioCAGR:development.portfolioCAGR,spyCAGR:development.spyCAGR,annualizedExcess:development.annualizedExcess,periodCount:development.periodCount},validation:{portfolioCAGR:validation.portfolioCAGR,spyCAGR:validation.spyCAGR,annualizedExcess:validation.annualizedExcess,periodCount:validation.periodCount}});
  }
  const validVal=cells.filter(x=>Number.isFinite(x.validation.annualizedExcess));
  const positiveValidationRate=validVal.length?pctTrue(validVal.map(x=>x.validation.annualizedExcess>0)):null;
  const medianValidationExcess=median(validVal.map(x=>x.validation.annualizedExcess));
  return {description:'Frozen ride-winner thesis logic swept across portfolio-size, expected-CAGR entry gate, and rank-cap dimensions. A broad plateau is healthier than a single isolated peak. Daily drawdown is skipped in grid cells for speed; return/execution/cost logic is unchanged.',portfolioSizes,cagrGates,rankCaps,cellCount:cells.length,positiveValidationRate,medianValidationExcess,cells};
}
function monotonicitySummary(deciles){
  const pts=(deciles||[]).map(x=>({d:Number(String(x.bucket).replace('D','')),y:finite(x.meanExcess)})).filter(x=>Number.isFinite(x.d)&&Number.isFinite(x.y));
  if(pts.length<2)return {n:pts.length,slopePerDecile:null,spearmanLikeCorrelation:null};
  const mx=mean(pts.map(x=>x.d)),my=mean(pts.map(x=>x.y));
  const cov=mean(pts.map(x=>(x.d-mx)*(x.y-my))),vx=mean(pts.map(x=>(x.d-mx)**2)),vy=mean(pts.map(x=>(x.y-my)**2));
  return {n:pts.length,slopePerDecile:vx>0?cov/vx:null,spearmanLikeCorrelation:vx>0&&vy>0?cov/Math.sqrt(vx*vy):null,interpretation:'Because D1 is best rank, a negative slope/correlation is the desired direction.'};
}
function buildScoreGeneralization(rows,n=1){
  const split=(start,end)=>rows.filter(r=>{const y=Number(String(r.asOf||'').slice(0,4));return y>=start&&y<=end;});
  const calc=rs=>{const d=groupedOutcome(rs,r=>`D${Math.min(10,Math.max(1,Math.ceil((r.rank/r.universeSize)*10)))}`,n).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1)));return {overall:outcomeStats(rs,n),rankDeciles:d,monotonicity:monotonicitySummary(d)};};
  return {description:`Per-snapshot model-rank deciles using ${n}Y realized total-return excess. D1 is the model's highest-ranked 10%. Development and validation are reported separately.`,development:{years:'2019-2021',...calc(split(2019,2021))},validation:{years:'2022-2025',...calc(split(2022,2025))}};
}

const FACTOR_LAB_SPECS=[
  {key:'expectedAlpha',label:'Expected alpha',higherBetter:true},
  {key:'expectedCAGR',label:'Expected CAGR',higherBetter:true},
  {key:'marginOfSafety',label:'Margin of safety',higherBetter:true},
  {key:'rankScore',label:'Model D rank score',higherBetter:true},
  {key:'investmentScore',label:'Legacy v12.37 hierarchical score',higherBetter:true},
  {key:'opportunityScore',label:'Opportunity score',higherBetter:true},
  {key:'opportunityQualityScore',label:'Opportunity quality',higherBetter:true},
  {key:'reliabilityScore',label:'Reliability modifier',higherBetter:true},
  {key:'qualityScore',label:'Quality',higherBetter:true},
  {key:'moatScore',label:'Moat',higherBetter:true},
  {key:'pricingPowerScore',label:'Pricing power',higherBetter:true},
  {key:'capitalAllocationScore',label:'Capital allocation',higherBetter:true},
  {key:'compounderScore',label:'Compounder',higherBetter:true},
  {key:'growthQualityScore',label:'Growth quality',higherBetter:true},
  {key:'protectionScore',label:'Protection',higherBetter:true},
  {key:'forecastConfidence',label:'Forecast confidence',higherBetter:true},
  {key:'valuationConfidence',label:'Valuation confidence',higherBetter:true},
  {key:'methodAgreement',label:'Method agreement',higherBetter:true},
  {key:'methodCount',label:'Valuation method count',higherBetter:true},
  {key:'independentEvidenceFamilies',label:'Independent evidence families',higherBetter:true},
];
function factorValue(r,key){
  const aliases={forecastConfidence:['forecastConfidence','forecastReliabilityScore','forecastConfidenceScore'],valuationConfidence:['valuationConfidence','valuationConfidenceScore','confidenceScore'],methodAgreement:['methodAgreement','methodAgreementScore'],methodCount:['methodCount','independentMethodCount'],independentEvidenceFamilies:['independentEvidenceFamilies','independentMethodCount']};
  for(const k of aliases[key]||[key]){const v=finite(r?.[k]);if(v!=null)return v;}
  return null;
}
function assignFactorDeciles(rows,spec){
  const byDate=new Map();
  for(const r of rows||[]){const v=factorValue(r,spec.key);if(v==null)continue;const k=String(r.asOf||'');if(!byDate.has(k))byDate.set(k,[]);byDate.get(k).push({r,v});}
  const out=[];
  for(const arr of byDate.values()){
    arr.sort((a,b)=>spec.higherBetter?(b.v-a.v):(a.v-b.v));
    const n=arr.length;
    arr.forEach((x,i)=>out.push({...x.r,_factorDecile:Math.min(10,Math.max(1,Math.floor(i*10/Math.max(1,n))+1)),_factorValue:x.v}));
  }
  return out;
}
function factorDiagnostics(rows,spec,horizon=1){
  const ranked=assignFactorDeciles(rows,spec);
  const d=groupedOutcome(ranked,r=>`D${r._factorDecile}`,horizon).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1)));
  const m=monotonicitySummary(d),d1=d.find(x=>x.bucket==='D1'),d10=d.find(x=>x.bucket==='D10');
  return {key:spec.key,label:spec.label,n:ranked.filter(r=>Number.isFinite(r[`excess${horizon}YTotalReturnCAGR`])).length,d1MeanExcess:d1?.meanExcess??null,d10MeanExcess:d10?.meanExcess??null,d1VsD10MeanSpread:Number.isFinite(d1?.meanExcess)&&Number.isFinite(d10?.meanExcess)?d1.meanExcess-d10.meanExcess:null,d1MedianExcess:d1?.medianExcess??null,d1BeatSpyRate:d1?.beatSpyRate??null,slopePerDecile:m.slopePerDecile,spearmanLikeCorrelation:m.spearmanLikeCorrelation,deciles:d};
}
function buildPredictivePowerLab(rows,horizon=1){
  const year=r=>Number(String(r.asOf||'').slice(0,4));
  const dev=(rows||[]).filter(r=>year(r)>=2019&&year(r)<=2021),val=(rows||[]).filter(r=>year(r)>=2022&&year(r)<=2025);
  const runSet=rs=>FACTOR_LAB_SPECS.map(spec=>factorDiagnostics(rs,spec,horizon));
  const conditionalSets=[
    {key:'alpha_ge_10',label:'Expected alpha ≥5%',filter:r=>finite(r.expectedAlpha)!=null&&r.expectedAlpha>=.05},
    {key:'alpha_ge_10_top20pct',label:'Expected alpha ≥5% + top-20% overall rank',filter:r=>finite(r.expectedAlpha)!=null&&r.expectedAlpha>=.05&&finite(r.rank)!=null&&finite(r.universeSize)!=null&&r.rank<=Math.ceil(r.universeSize*.20)},
  ];
  const conditionals=conditionalSets.map(c=>({key:c.key,label:c.label,development:runSet(dev.filter(c.filter)),validation:runSet(val.filter(c.filter))}));
  return {description:`Predictive-power laboratory using point-in-time, within-snapshot factor deciles and ${horizon}Y realized total-return excess vs SPY. D1 is the factor's most attractive decile. D1>D10, negative decile slope/correlation, and validation persistence are desirable. Conditional tests ask whether quality/evidence factors add value after expected-return gating.`,horizonYears:horizon,developmentYears:'2019-2021',validationYears:'2022-2025',factors:FACTOR_LAB_SPECS.map(x=>({key:x.key,label:x.label,higherBetter:x.higherBetter})),development:runSet(dev),validation:runSet(val),conditionals};
}


// Frozen five-model challenger test. Every challenger uses the SAME expected-alpha >=10%
// eligible universe, so quality only gets credit when it improves ordering after the
// expected-return hurdle has already been cleared. Scores are built from within-snapshot
// percentile ranks to avoid scale artifacts; no weights are optimized to the backtest.
const CHALLENGER_SPECS=[
  {key:'alpha_only',label:'A · Expected Alpha only'},
  {key:'alpha_quality',label:'B · 50% Alpha + 50% Quality'},
  {key:'alpha_growth_quality',label:'C · 50% Alpha + 50% Growth Quality'},
  {key:'alpha_quality_basket',label:'D · 50% Alpha + 50% quality basket · LIVE v12.38'},
  {key:'hierarchical_v1237',label:'E · Legacy v12.37 hierarchical score'},
];
function challengerRows(rows){
  const byDate=new Map();
  for(const r of rows||[]){
    if((finite(r.expectedAlpha)??-Infinity)<.05)continue;
    const k=String(r.asOf||''); if(!byDate.has(k))byDate.set(k,[]); byDate.get(k).push(r);
  }
  const out=[];
  for(const arr of byDate.values()){
    const alpha=percentileRanks(arr.map(r=>r.expectedAlpha));
    const quality=percentileRanks(arr.map(r=>r.qualityScore));
    const growth=percentileRanks(arr.map(r=>r.growthQualityScore));
    const moat=percentileRanks(arr.map(r=>r.moatScore));
    const compounder=percentileRanks(arr.map(r=>r.compounderScore));
    const current=percentileRanks(arr.map(r=>r.investmentScore));
    arr.forEach((r,i)=>{
      const basket=[quality[i],moat[i],growth[i],compounder[i]].filter(Number.isFinite);
      const basketScore=basket.length?mean(basket):null;
      const scores={
        alpha_only:alpha[i],
        alpha_quality:Number.isFinite(alpha[i])&&Number.isFinite(quality[i])?.5*alpha[i]+.5*quality[i]:null,
        alpha_growth_quality:Number.isFinite(alpha[i])&&Number.isFinite(growth[i])?.5*alpha[i]+.5*growth[i]:null,
        alpha_quality_basket:Number.isFinite(alpha[i])&&Number.isFinite(basketScore)?.5*alpha[i]+.5*basketScore:null,
        hierarchical_v1237:current[i],
      };
      out.push({...r,_challengerScores:scores});
    });
  }
  return out;
}
function challengerDiagnostics(rows,spec,horizon=1){
  const prepared=challengerRows(rows).filter(r=>Number.isFinite(r._challengerScores?.[spec.key]));
  const byDate=new Map();
  for(const r of prepared){const k=String(r.asOf||'');if(!byDate.has(k))byDate.set(k,[]);byDate.get(k).push(r);}
  const ranked=[];
  for(const arr of byDate.values()){
    arr.sort((a,b)=>b._challengerScores[spec.key]-a._challengerScores[spec.key]);
    const n=arr.length;
    arr.forEach((r,i)=>ranked.push({...r,_challengerDecile:Math.min(10,Math.max(1,Math.floor(i*10/Math.max(1,n))+1))}));
  }
  const d=groupedOutcome(ranked,r=>`D${r._challengerDecile}`,horizon).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1)));
  const m=monotonicitySummary(d),d1=d.find(x=>x.bucket==='D1'),d10=d.find(x=>x.bucket==='D10');
  return {key:spec.key,label:spec.label,n:ranked.filter(r=>Number.isFinite(r[`excess${horizon}YTotalReturnCAGR`])).length,d1MeanExcess:d1?.meanExcess??null,d10MeanExcess:d10?.meanExcess??null,d1VsD10MeanSpread:Number.isFinite(d1?.meanExcess)&&Number.isFinite(d10?.meanExcess)?d1.meanExcess-d10.meanExcess:null,d1MedianExcess:d1?.medianExcess??null,d1BeatSpyRate:d1?.beatSpyRate??null,slopePerDecile:m.slopePerDecile,spearmanLikeCorrelation:m.spearmanLikeCorrelation,deciles:d};
}
function buildChallengerLab(rows,horizon=1){
  const year=r=>Number(String(r.asOf||'').slice(0,4));
  const dev=(rows||[]).filter(r=>year(r)>=2019&&year(r)<=2021),val=(rows||[]).filter(r=>year(r)>=2022&&year(r)<=2025);
  const run=rs=>CHALLENGER_SPECS.map(spec=>challengerDiagnostics(rs,spec,horizon));
  return {description:'Frozen challenger comparison on one common eligible universe: Expected Alpha >=5% (15% hurdle scale). A is the return-only baseline; B/C/D add simple, predeclared quality terms; E is the legacy v12.37 score; D is the promoted live v12.38 ranking rule. All blends use within-snapshot percentiles and fixed 50/50 weights. No parameter search or validation tuning is performed.',horizonYears:horizon,eligibility:'expectedAlpha >= 5% (15% hurdle scale)',developmentYears:'2019-2021',validationYears:'2022-2025',models:CHALLENGER_SPECS,development:run(dev),validation:run(val)};
}



function dynamicMosProfile(r){
  const q=finite(r?.qualityScore),moat=finite(r?.moatScore),comp=finite(r?.compounderScore),fc=finite(r?.forecastConfidence),vc=finite(r?.valuationConfidence),support=String(r?.modelSupport||'standard');
  if(support==='unsupported')return {tier:'Unsupported',requiredMOS:null,eligibleQuality:false};
  if(q!=null&&q>=80&&moat!=null&&moat>=75&&comp!=null&&comp>=75&&fc!=null&&fc>=60&&vc!=null&&vc>=65&&support!=='limited')return {tier:'Elite established compounder',requiredMOS:.05,eligibleQuality:true};
  if(q!=null&&q>=72&&moat!=null&&moat>=65&&comp!=null&&comp>=68&&fc!=null&&fc>=55&&vc!=null&&vc>=60&&support!=='limited')return {tier:'Strong established business',requiredMOS:.10,eligibleQuality:true};
  if(q!=null&&q>=58&&fc!=null&&fc>=50&&vc!=null&&vc>=55&&support!=='limited')return {tier:'Standard quality',requiredMOS:.20,eligibleQuality:true};
  if(fc!=null&&fc>=45&&vc!=null&&vc>=45)return {tier:'Higher uncertainty',requiredMOS:.25,eligibleQuality:true};
  return {tier:'Insufficient confidence',requiredMOS:.30,eligibleQuality:false};
}
function ownerDynamicEntryEligible(r,{minExpectedCAGR=.15,minAlpha=0,maxRank=25}={}){
  const p=dynamicMosProfile(r),mos=finite(r?.marginOfSafety);
  return p.eligibleQuality&&Number.isFinite(r?.expectedAlpha)&&r.expectedAlpha>=minAlpha&&Number.isFinite(r?.expectedCAGR)&&r.expectedCAGR>=minExpectedCAGR&&Number.isFinite(r?.dynamicRank)&&r.dynamicRank<=maxRank&&Number.isFinite(mos)&&mos>=p.requiredMOS&&String(r?.modelSupport||'')!=='unsupported';
}
function dynamicRankSnapshotRows(rows){const cloned=(rows||[]).map(r=>({...r}));applyModelDRanking(cloned,{rankField:'dynamicRank',universeSizeField:null,alphaGate:0});return cloned;}
function buildDynamicMosEntryLab(snapshotOutput){
  const specs=[
    {key:'fixed20',label:'A · Fixed 20% CAGR control',pick:rows=>{const c=rows.map(r=>({...r}));applyModelDRanking(c,{rankField:'testRank',universeSizeField:null,alphaGate:.05});return dedupeEconomicSecurities(c.filter(r=>Number.isFinite(r.testRank)&&r.testRank<=25&&Number.isFinite(r.expectedCAGR)&&r.expectedCAGR>=.20&&String(r.modelSupport||'')!=='unsupported').sort((a,b)=>a.testRank-b.testRank)).slice(0,15)}},
    {key:'dynamic_mos',label:'B · 15% CAGR + dynamic MOS',pick:rows=>dedupeEconomicSecurities(dynamicRankSnapshotRows(rows).filter(ownerDynamicEntryEligible).sort((a,b)=>a.dynamicRank-b.dynamicRank)).slice(0,15)}
  ];
  const results=[];
  for(const spec of specs){const cohorts=[];for(const snap of snapshotOutput||[]){const picks=spec.pick(snap.rows||[]);const valid=picks.filter(r=>Number.isFinite(r.realized5YTotalReturnCAGR)&&Number.isFinite(r.spy5YTotalReturnCAGR));if(!valid.length)continue;const portfolioCAGR=equalWeightFixedHoldCAGR(valid,5),spyCAGR=cohortSpyCAGR(valid,5);cohorts.push({asOf:snap.asOf,holdings:valid.length,portfolioCAGR,spyCAGR,excessCAGR:portfolioCAGR-spyCAGR,beatSpy:portfolioCAGR>spyCAGR,hit15:portfolioCAGR>=.15,tickers:valid.map(r=>r.ticker),members:valid.map(r=>({ticker:r.ticker,cagr:r.realized5YTotalReturnCAGR,tier:dynamicMosProfile(r).tier,requiredMOS:dynamicMosProfile(r).requiredMOS,marginOfSafety:r.marginOfSafety,expectedCAGR:r.expectedCAGR}))});}
    results.push({key:spec.key,label:spec.label,cohortCount:cohorts.length,meanHoldings:mean(cohorts.map(x=>x.holdings)),meanPortfolioCAGR:mean(cohorts.map(x=>x.portfolioCAGR)),medianPortfolioCAGR:median(cohorts.map(x=>x.portfolioCAGR)),meanSpyCAGR:mean(cohorts.map(x=>x.spyCAGR)),meanExcessCAGR:mean(cohorts.map(x=>x.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(x=>x.beatSpy).length/cohorts.length:null,hit15Rate:cohorts.length?cohorts.filter(x=>x.hit15).length/cohorts.length:null,worstCohort:cohorts.reduce((a,b)=>!a||b.portfolioCAGR<a.portfolioCAGR?b:a,null),cohorts});}
  const a=results[0],b=results[1],replacements=[];if(a&&b){const am=new Map(a.cohorts.map(c=>[c.asOf,c])),bm=new Map(b.cohorts.map(c=>[c.asOf,c]));for(const [date,bc] of bm){const ac=am.get(date);if(!ac)continue;const aset=new Set(ac.tickers),bset=new Set(bc.tickers),added=bc.members.filter(x=>!aset.has(x.ticker)),removed=ac.cohorts?[]:ac.members?.filter(x=>!bset.has(x.ticker))||[];replacements.push({asOf:date,added,removed});}}
  return {description:'v12.51 predeclared entry-policy test. The investor hurdle is 15% expected CAGR. Margin of safety is separate and scales with uncertainty: Elite established compounder 5%, Strong established business 10%, Standard quality 20%, Higher uncertainty 25%. Insufficient-confidence and unsupported names cannot enter. The dynamic challenger reranks the >=15% CAGR candidate universe with the same Model-D formula; no sell or weighting rule is changed.',tiers:[{tier:'Elite established compounder',requiredMOS:.05},{tier:'Strong established business',requiredMOS:.10},{tier:'Standard quality',requiredMOS:.20},{tier:'Higher uncertainty',requiredMOS:.25}],results,replacements};
}

function ownerValuationEntryEligible(r,{minAlpha=.05,minExpectedCAGR=.20,maxRank=25}={}){
  return isValuationBuyRating(r?.rating)&&Number.isFinite(r?.expectedAlpha)&&r.expectedAlpha>=minAlpha&&Number.isFinite(r?.expectedCAGR)&&r.expectedCAGR>=minExpectedCAGR&&Number.isFinite(r?.rank)&&r.rank<=maxRank&&String(r?.modelSupport||'')!=='unsupported';
}

function longTermOwnerOutcomeStats(rows,horizon){
  const stockField=`realized${horizon}YTotalReturnCAGR`,spyField=`spy${horizon}YTotalReturnCAGR`,excessField=`excess${horizon}YTotalReturnCAGR`;
  const valid=(rows||[]).filter(r=>Number.isFinite(r[stockField])&&Number.isFinite(r[spyField])&&Number.isFinite(r[excessField]));
  const excess=valid.map(r=>r[excessField]),stock=valid.map(r=>r[stockField]);
  return {n:valid.length,meanStockCAGR:mean(stock),medianStockCAGR:median(stock),meanExcessCAGR:mean(excess),medianExcessCAGR:median(excess),beatSpyRate:valid.length?valid.filter(r=>r[excessField]>0).length/valid.length:null,hit15CAGRRate:valid.length?valid.filter(r=>r[stockField]>=.15).length/valid.length:null,lossRate:valid.length?valid.filter(r=>r[stockField]<0).length/valid.length:null};
}
function longTermOwnerGrouped(rows,keyFn,horizon){
  const groups=new Map();
  for(const r of rows||[]){const k=keyFn(r);if(k==null||k==='')continue;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  return [...groups.entries()].map(([bucket,rs])=>({bucket,...longTermOwnerOutcomeStats(rs,horizon)}));
}
function equalWeightFixedHoldCAGR(rows,horizon){
  const f=`realized${horizon}YTotalReturnCAGR`;
  const vals=(rows||[]).map(r=>r[f]).filter(Number.isFinite);
  if(!vals.length)return null;
  // Exact equal-weight buy-and-hold terminal wealth, then annualize. Arithmetic
  // averaging of individual CAGRs is not the same thing as portfolio CAGR.
  const terminal=mean(vals.map(x=>Math.pow(Math.max(0,1+x),horizon)));
  return terminal>=0?Math.pow(terminal,1/horizon)-1:null;
}
function cohortSpyCAGR(rows,horizon){
  const f=`spy${horizon}YTotalReturnCAGR`;
  const vals=(rows||[]).map(r=>r[f]).filter(Number.isFinite);
  return vals.length?mean(vals):null;
}
function fixedHoldCohorts(snapshotOutput,{topN=15,minAlpha=.10,minExpectedCAGR=.15,maxRank=25,horizons=[3,5]}={}){
  const out={};
  for(const horizon of horizons){
    const cohorts=[];
    for(const snap of snapshotOutput||[]){
      const eligible=dedupeEconomicSecurities((snap.rows||[]).filter(r=>ownerValuationEntryEligible(r,{minAlpha,minExpectedCAGR,maxRank})).sort((a,b)=>a.rank-b.rank)).slice(0,topN);
      const valid=eligible.filter(r=>Number.isFinite(r[`realized${horizon}YTotalReturnCAGR`])&&Number.isFinite(r[`spy${horizon}YTotalReturnCAGR`]));
      if(!valid.length)continue;
      const stockCAGR=equalWeightFixedHoldCAGR(valid,horizon);
      const spyCAGR=cohortSpyCAGR(valid,horizon);
      cohorts.push({asOf:snap.asOf,holdings:valid.length,stockCAGR,spyCAGR,excessCAGR:stockCAGR-spyCAGR,beatSpy:stockCAGR>spyCAGR,hit15:stockCAGR>=.15,tickers:valid.map(r=>r.ticker),members:valid.map(r=>({ticker:r.ticker,cagr:r[`realized${horizon}YTotalReturnCAGR`]}))});
    }
    out[`${horizon}Y`]={horizonYears:horizon,cohortCount:cohorts.length,meanHoldings:mean(cohorts.map(x=>x.holdings)),meanPortfolioCAGR:mean(cohorts.map(x=>x.stockCAGR)),medianPortfolioCAGR:median(cohorts.map(x=>x.stockCAGR)),meanSpyCAGR:mean(cohorts.map(x=>x.spyCAGR)),meanExcessCAGR:mean(cohorts.map(x=>x.excessCAGR)),medianExcessCAGR:median(cohorts.map(x=>x.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(x=>x.beatSpy).length/cohorts.length:null,hit15CAGRRate:cohorts.length?cohorts.filter(x=>x.hit15).length/cohorts.length:null,cohorts};
  }
  return out;
}
function nonOverlappingCohorts(cohorts,horizon){
  const sorted=[...(cohorts||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  const out=[];let nextAllowed='0000-00-00';
  for(const c of sorted){if(String(c.asOf)<nextAllowed)continue;out.push(c);nextAllowed=addYears(c.asOf,horizon);}
  return {count:out.length,starts:out.map(x=>x.asOf),meanPortfolioCAGR:mean(out.map(x=>x.stockCAGR)),meanSpyCAGR:mean(out.map(x=>x.spyCAGR)),meanExcessCAGR:mean(out.map(x=>x.excessCAGR)),beatSpyRate:out.length?out.filter(x=>x.beatSpy).length/out.length:null};
}
function firstSignalPerSecurity(rows,horizon){
  const f=`realized${horizon}YTotalReturnCAGR`,sf=`spy${horizon}YTotalReturnCAGR`,ef=`excess${horizon}YTotalReturnCAGR`;
  const seen=new Set(),chosen=[];
  for(const r of [...(rows||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||a.rank-b.rank)){
    const g=economicSecurityGroup(r.ticker);if(seen.has(g)||!Number.isFinite(r[f])||!Number.isFinite(r[sf])||!Number.isFinite(r[ef]))continue;
    seen.add(g);chosen.push(r);
  }
  return {uniqueSecurities:chosen.length,...longTermOwnerOutcomeStats(chosen,horizon)};
}
function recurrenceAudit(cohorts){
  const counts=new Map(),total=(cohorts||[]).reduce((a,c)=>a+(c.tickers||[]).length,0);
  for(const c of cohorts||[])for(const t of c.tickers||[]){const g=economicSecurityGroup(t);counts.set(g,(counts.get(g)||0)+1);}
  const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
  const share=n=>total?ranked.slice(0,n).reduce((a,x)=>a+x[1],0)/total:null;
  return {totalPortfolioSlots:total,uniqueEconomicSecurities:ranked.length,top5SlotShare:share(5),top10SlotShare:share(10),mostRecurring:ranked.slice(0,10).map(([security,appearances])=>({security,appearances,slotShare:total?appearances/total:null}))};
}
function winnerRemovalAudit(cohorts,horizon){
  const calc=(c,removeN)=>{
    const ms=[...(c.members||[])].sort((a,b)=>b.cagr-a.cagr).slice(removeN);
    if(!ms.length)return null;
    const terminal=mean(ms.map(x=>Math.pow(Math.max(0,1+x.cagr),horizon)));
    return Math.pow(terminal,1/horizon)-1;
  };
  const rows=(cohorts||[]).map(c=>({asOf:c.asOf,full:c.stockCAGR,minusTop1:calc(c,1),minusTop3:calc(c,3),spy:c.spyCAGR}));
  const summarize=k=>({meanCAGR:mean(rows.map(x=>x[k]).filter(Number.isFinite)),meanExcess:mean(rows.filter(x=>Number.isFinite(x[k])&&Number.isFinite(x.spy)).map(x=>x[k]-x.spy)),beatSpyRate:rows.length?rows.filter(x=>Number.isFinite(x[k])&&x[k]>x.spy).length/rows.filter(x=>Number.isFinite(x[k])).length:null});
  return {cohortCount:rows.length,full:summarize('full'),removeBest1:summarize('minusTop1'),removeBest3:summarize('minusTop3')};
}
function makeRng(seed=1242){let x=seed>>>0;return()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296;};}
function percentile(xs,p){const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(i-lo);}
function securityBootstrap(firstRows,horizon,reps=5000){
  const ef=`excess${horizon}YTotalReturnCAGR`,vals=(firstRows||[]).map(r=>r[ef]).filter(Number.isFinite);if(!vals.length)return {n:0};
  const rng=makeRng(1242+horizon),means=[];
  for(let b=0;b<reps;b++){let z=0;for(let i=0;i<vals.length;i++)z+=vals[Math.floor(rng()*vals.length)];means.push(z/vals.length);}
  return {n:vals.length,reps,meanExcess:mean(vals),ci95Low:percentile(means,.025),ci95High:percentile(means,.975),probabilityMeanExcessPositive:means.filter(x=>x>0).length/means.length,note:'Resamples unique economic securities from their first qualifying signal. This addresses repeated-name inflation but does not create missing historical market regimes.'};
}
function startYearClusterBootstrap(cohorts,reps=5000){
  const groups=new Map();for(const c of cohorts||[]){const y=String(c.asOf).slice(0,4);if(!groups.has(y))groups.set(y,[]);groups.get(y).push(c.excessCAGR);}
  const blocks=[...groups.entries()].map(([year,x])=>({year,meanExcess:mean(x)}));if(!blocks.length)return {startYearBlocks:0};
  const rng=makeRng(4200+blocks.length),means=[];
  for(let b=0;b<reps;b++){let z=0;for(let i=0;i<blocks.length;i++)z+=blocks[Math.floor(rng()*blocks.length)].meanExcess;means.push(z/blocks.length);}
  return {startYearBlocks:blocks.length,years:blocks.map(x=>x.year),reps,meanBlockExcess:mean(blocks.map(x=>x.meanExcess)),ci95Low:percentile(means,.025),ci95High:percentile(means,.975),probabilityMeanExcessPositive:means.filter(x=>x>0).length/means.length,note:'Cluster bootstrap over calendar start years. With very few completed 5Y start-year blocks, this interval is intentionally coarse and should not be treated as a full regime-robust confidence interval.'};
}
function regimeSlice(cohorts){
  const groups=[['2019-2020',c=>Number(String(c.asOf).slice(0,4))<=2020],['2021',c=>String(c.asOf).startsWith('2021')],['2022+',c=>Number(String(c.asOf).slice(0,4))>=2022]];
  return groups.map(([label,fn])=>{const x=(cohorts||[]).filter(fn);return {period:label,cohortCount:x.length,meanPortfolioCAGR:mean(x.map(c=>c.stockCAGR)),meanSpyCAGR:mean(x.map(c=>c.spyCAGR)),meanExcessCAGR:mean(x.map(c=>c.excessCAGR)),beatSpyRate:x.length?x.filter(c=>c.beatSpy).length/x.length:null};});
}
function buildOwnerRobustnessAudit(eligible,fixedHold15){
  const out={description:'v12.42 independence/robustness audit of the frozen v12.41 owner selection rule. No ranking, Alpha, CAGR, or entry thresholds are retuned.',methodologyNotes:['Fixed-hold portfolio CAGR uses exact equal-weight terminal wealth, not the arithmetic mean of member CAGRs.','Non-overlapping cohorts expose how little independent time evidence is available.','First-signal analysis counts each economic security once.','Winner-removal tests ask whether results survive without the strongest holdings.','Bootstraps quantify sampling uncertainty but cannot manufacture pre-2019 market regimes.']};
  for(const h of [3,5]){
    const key=`${h}Y`,cohorts=fixedHold15?.[key]?.cohorts||[];
    const seen=new Set(),first=[];
    for(const r of [...eligible].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||a.rank-b.rank)){const g=economicSecurityGroup(r.ticker);if(seen.has(g)||!Number.isFinite(r[`excess${h}YTotalReturnCAGR`]))continue;seen.add(g);first.push(r);}
    out[key]={nonOverlapping:nonOverlappingCohorts(cohorts,h),firstSignalPerSecurity:firstSignalPerSecurity(eligible,h),recurrence:recurrenceAudit(cohorts),winnerRemoval:winnerRemovalAudit(cohorts,h),securityBootstrap:securityBootstrap(first,h),startYearClusterBootstrap:startYearClusterBootstrap(cohorts),regimeSlices:regimeSlice(cohorts)};
  }
  return out;
}

function historyForEconomicSecurity(ticker,historyByTicker){
  if(historyByTicker?.has(ticker))return historyByTicker.get(ticker);
  const g=economicSecurityGroup(ticker);
  if(g==='ALPHABET')return historyByTicker?.get('GOOG')||historyByTicker?.get('GOOGL')||null;
  return null;
}
function yearsBetweenDates(a,b){const x=new Date(a).getTime(),y=new Date(b).getTime();return Number.isFinite(x)&&Number.isFinite(y)&&y>=x?(y-x)/(365.25*86400000):null;}
function ownerBreakFlags(entry,review){
  const q0=finite(entry?.qualityScore),p0=finite(entry?.protectionScore),q=finite(review?.qualityScore),p=finite(review?.protectionScore);
  const qualityBreak=q0!=null&&q!=null&&q<=q0-15&&q<60;
  const protectionBreak=p0!=null&&p!=null&&p<=p0-20&&p<50;
  return {qualityBreak,protectionBreak,eitherBreak:qualityBreak||protectionBreak,dualBreak:qualityBreak&&protectionBreak};
}
const OWNER_EXIT_RULES=[
  {key:'never_sell',label:'A · Never sell (5Y hold control)',kind:'never'},
  {key:'quality_break',label:'B · Quality thesis break',kind:'quality'},
  {key:'protection_break',label:'C · Protection thesis break',kind:'protection'},
  {key:'either_break',label:'D · Either thesis break · immediate',kind:'either'},
  {key:'confirmed_either_break',label:'E · Either thesis break · 2-review confirmation',kind:'confirmedEither'},
  {key:'dual_break',label:'F · Quality + protection break together',kind:'dual'}
];
function ownerExitSignal(entry,reviews,rule){
  if(rule.kind==='never')return null;
  let priorEither=false;
  for(const x of reviews||[]){
    const f=ownerBreakFlags(entry,x.row);
    let hit=false,reason=null;
    if(rule.kind==='quality'&&f.qualityBreak){hit=true;reason='quality_deterioration';}
    if(rule.kind==='protection'&&f.protectionBreak){hit=true;reason='protection_deterioration';}
    if(rule.kind==='either'&&f.eitherBreak){hit=true;reason=f.dualBreak?'quality_and_protection_deterioration':f.qualityBreak?'quality_deterioration':'protection_deterioration';}
    if(rule.kind==='dual'&&f.dualBreak){hit=true;reason='quality_and_protection_deterioration';}
    if(rule.kind==='confirmedEither'&&f.eitherBreak&&priorEither){hit=true;reason='confirmed_thesis_deterioration';}
    if(hit)return {asOf:x.asOf,row:x.row,reason,flags:f};
    priorEither=f.eitherBreak;
  }
  return null;
}
function buildOwnerReviewIndex(snapshotOutput){
  const byGroup=new Map();
  for(const snap of snapshotOutput||[]){
    for(const row of snap.rows||[]){
      const g=economicSecurityGroup(row.ticker);if(!byGroup.has(g))byGroup.set(g,[]);
      byGroup.get(g).push({asOf:snap.asOf,row});
    }
  }
  for(const xs of byGroup.values())xs.sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||(finite(a.row.rank)??9999)-(finite(b.row.rank)??9999));
  return byGroup;
}
function evaluateOwnerExit(entry,entryAsOf,rule,reviewIndex,historyByTicker,spyHistory,horizon=5){
  const endDate=addYears(entryAsOf,horizon),group=economicSecurityGroup(entry.ticker);
  const reviews=(reviewIndex.get(group)||[]).filter(x=>String(x.asOf)>String(entryAsOf)&&String(x.asOf)<String(endDate));
  const signal=ownerExitSignal(entry,reviews,rule);
  const history=historyForEconomicSecurity(entry.ticker,historyByTicker);if(!history)return null;
  const hold=adjustedReturnBetween(history,entryAsOf,endDate,{executeAfterStart:true});
  const spyFull=adjustedReturnBetween(spyHistory,entryAsOf,endDate,{executeAfterStart:true});
  if(!hold||!spyFull)return null;
  const holdWealth=1+hold.return,holdCAGR=Math.pow(Math.max(0,holdWealth),1/horizon)-1,spyCAGR=Math.pow(Math.max(0,1+spyFull.return),1/horizon)-1;
  if(!signal)return {ticker:entry.ticker,security:group,entryDate:entryAsOf,exitDate:null,reason:null,triggered:false,entryQuality:finite(entry.qualityScore),entryProtection:finite(entry.protectionScore),exitQuality:null,exitProtection:null,yearsHeld:horizon,holdCAGR,strategyCAGR:holdCAGR,deltaVsHoldCAGR:0,spyCAGR,postExitStockCAGR:null,postExitSpyCAGR:null,postExitExcessCAGR:null,improvedVsHold:false};
  const pre=adjustedReturnBetween(history,entryAsOf,signal.asOf,{executeAfterStart:true});
  const spyAfter=adjustedReturnBetween(spyHistory,signal.asOf,endDate,{executeAfterStart:true});
  const stockAfter=adjustedReturnBetween(history,signal.asOf,endDate,{executeAfterStart:true});
  if(!pre||!spyAfter)return null;
  const strategyWealth=(1+pre.return)*(1+spyAfter.return),strategyCAGR=Math.pow(Math.max(0,strategyWealth),1/horizon)-1;
  const postYears=yearsBetweenDates(signal.asOf,endDate);
  const postStockCAGR=stockAfter&&postYears>0?Math.pow(Math.max(0,1+stockAfter.return),1/postYears)-1:null;
  const postSpyCAGR=postYears>0?Math.pow(Math.max(0,1+spyAfter.return),1/postYears)-1:null;
  return {ticker:entry.ticker,security:group,entryDate:entryAsOf,exitDate:signal.asOf,reason:signal.reason,triggered:true,entryQuality:finite(entry.qualityScore),entryProtection:finite(entry.protectionScore),exitQuality:finite(signal.row.qualityScore),exitProtection:finite(signal.row.protectionScore),yearsHeld:yearsBetweenDates(entryAsOf,signal.asOf),holdCAGR,strategyCAGR,deltaVsHoldCAGR:strategyCAGR-holdCAGR,spyCAGR,postExitStockCAGR:postStockCAGR,postExitSpyCAGR:postSpyCAGR,postExitExcessCAGR:Number.isFinite(postStockCAGR)&&Number.isFinite(postSpyCAGR)?postStockCAGR-postSpyCAGR:null,improvedVsHold:strategyCAGR>holdCAGR};
}
function summarizeOwnerExitEvaluations(evals){
  const v=(evals||[]).filter(Boolean),sales=v.filter(x=>x.triggered),helpful=sales.filter(x=>x.deltaVsHoldCAGR>0),mistakes=sales.filter(x=>x.deltaVsHoldCAGR<=0),sortedMistakes=[...mistakes].sort((a,b)=>a.deltaVsHoldCAGR-b.deltaVsHoldCAGR),top3=sortedMistakes.slice(0,3);
  return {eligiblePositions:v.length,sellCount:sales.length,sellRate:v.length?sales.length/v.length:null,meanHoldCAGR:mean(v.map(x=>x.holdCAGR)),meanStrategyCAGR:mean(v.map(x=>x.strategyCAGR)),meanDeltaVsHoldCAGR:mean(v.map(x=>x.deltaVsHoldCAGR)),medianDeltaVsHoldCAGR:median(v.map(x=>x.deltaVsHoldCAGR)),improvedExitRate:sales.length?sales.filter(x=>x.improvedVsHold).length/sales.length:null,correctSellRate:sales.filter(x=>Number.isFinite(x.postExitExcessCAGR)).length?sales.filter(x=>Number.isFinite(x.postExitExcessCAGR)&&x.postExitExcessCAGR<0).length/sales.filter(x=>Number.isFinite(x.postExitExcessCAGR)).length:null,meanPostExitExcessCAGR:mean(sales.map(x=>x.postExitExcessCAGR)),meanYearsHeld:mean(sales.map(x=>x.yearsHeld)),meanHelpfulBenefitCAGR:mean(helpful.map(x=>x.deltaVsHoldCAGR)),meanMistakeDamageCAGR:mean(mistakes.map(x=>x.deltaVsHoldCAGR)),worstMistakenSell:sortedMistakes[0]||null,top3MistakenSellDamageCAGR:top3.length?top3.reduce((a,x)=>a+x.deltaVsHoldCAGR,0):null,top3MistakenSells:top3.map(x=>({ticker:x.ticker,entryDate:x.entryDate,exitDate:x.exitDate,deltaVsHoldCAGR:x.deltaVsHoldCAGR,holdCAGR:x.holdCAGR,strategyCAGR:x.strategyCAGR,postExitExcessCAGR:x.postExitExcessCAGR})),sales};
}
function ownerExitPortfolioComparison(fixedHold5,entryLookup,rule,reviewIndex,historyByTicker,spyHistory){
  const cohorts=[];
  for(const c of fixedHold5?.cohorts||[]){
    const evals=[];
    for(const t of c.tickers||[]){const entry=entryLookup.get(`${c.asOf}|${economicSecurityGroup(t)}`);if(!entry)continue;const e=evaluateOwnerExit(entry,c.asOf,rule,reviewIndex,historyByTicker,spyHistory,5);if(e)evals.push(e);}
    if(!evals.length)continue;
    const wealth=mean(evals.map(x=>Math.pow(Math.max(0,1+x.strategyCAGR),5))),holdWealth=mean(evals.map(x=>Math.pow(Math.max(0,1+x.holdCAGR),5)));
    const portfolioCAGR=Math.pow(Math.max(0,wealth),1/5)-1,holdCAGR=Math.pow(Math.max(0,holdWealth),1/5)-1,spyCAGR=mean(evals.map(x=>x.spyCAGR));
    cohorts.push({asOf:c.asOf,holdings:evals.length,portfolioCAGR,holdCAGR,deltaVsHoldCAGR:portfolioCAGR-holdCAGR,spyCAGR,excessCAGR:portfolioCAGR-spyCAGR,sellCount:evals.filter(x=>x.triggered).length,sales:evals.filter(x=>x.triggered)});
  }
  return {cohortCount:cohorts.length,meanPortfolioCAGR:mean(cohorts.map(x=>x.portfolioCAGR)),medianPortfolioCAGR:median(cohorts.map(x=>x.portfolioCAGR)),meanHoldCAGR:mean(cohorts.map(x=>x.holdCAGR)),meanDeltaVsHoldCAGR:mean(cohorts.map(x=>x.deltaVsHoldCAGR)),meanSpyCAGR:mean(cohorts.map(x=>x.spyCAGR)),meanExcessCAGR:mean(cohorts.map(x=>x.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(x=>x.portfolioCAGR>x.spyCAGR).length/cohorts.length:null,totalSales:cohorts.reduce((a,x)=>a+x.sellCount,0),averageSalesPerCohort:mean(cohorts.map(x=>x.sellCount)),cohorts};
}
function buildOwnerExitLab(eligible,snapshotOutput,historyByTicker,spyHistory,fixedHold15){
  const reviewIndex=buildOwnerReviewIndex(snapshotOutput),entryLookup=new Map();
  for(const r of eligible||[])entryLookup.set(`${r.asOf}|${economicSecurityGroup(r.ticker)}`,r);
  const first=[];const seen=new Set();
  for(const r of [...(eligible||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||(finite(a.rank)??9999)-(finite(b.rank)??9999))){const g=economicSecurityGroup(r.ticker);if(seen.has(g)||!Number.isFinite(r.realized5YTotalReturnCAGR))continue;seen.add(g);first.push(r);}
  const rules=OWNER_EXIT_RULES.map(rule=>{
    const evals=first.map(r=>evaluateOwnerExit(r,r.asOf,rule,reviewIndex,historyByTicker,spyHistory,5)).filter(Boolean);
    return {key:rule.key,label:rule.label,firstSignalAudit:summarizeOwnerExitEvaluations(evals),portfolioAudit:ownerExitPortfolioComparison(fixedHold15?.['5Y'],entryLookup,rule,reviewIndex,historyByTicker,spyHistory)};
  });
  return {description:'v12.43 frozen 5-year owner exit lab. Entry ranking and thresholds are unchanged. Thesis-break rules use deterioration from the original purchase quality/protection baseline. When a rule sells, proceeds move to SPY for the remainder of the original 5-year horizon so the test isolates the exit decision instead of adding a cash-timing bet.',horizonYears:5,entryRuleFrozen:true,thresholds:{qualityBreak:'quality falls >=15 points from entry and is <60',protectionBreak:'protection falls >=20 points from entry and is <50',confirmation:'two consecutive quarterly reviews satisfy either thesis-break condition'},rules};
}


const ALPHA_EXIT_RULES=[
  {key:'never_sell',label:'A · Never sell (5Y hold control)',kind:'never',confirmations:0},
  // Exact economic equivalent of v12.44's promising old-Alpha <0% x4 rule after rebasing Alpha by -5 points.
  {key:'alpha_below_minus5_4q',label:'B · Alpha <-5% · 4 reviews',kind:'alpha',threshold:-.05,confirmations:4},
  {key:'alpha_below_0_4q',label:'C · Alpha <0% · 4 reviews',kind:'alpha',threshold:0,confirmations:4},
  {key:'alpha_below_minus5_2q',label:'D · Alpha <-5% · 2 reviews',kind:'alpha',threshold:-.05,confirmations:2},
  {key:'alpha0_outcome_break_2q',label:'E · Alpha <0% + model outcome deterioration · 2 reviews',kind:'outcome',threshold:0,confirmations:2,outcomeAnnualizedMax:-.03},
  {key:'alpha0_forecast_break_2q',label:'F · Alpha <0% + operating forecast deterioration · 2 reviews',kind:'forecast',threshold:0,confirmations:2,forecastDrop:.03},
  {key:'alpha0_shadow50_4q',label:'G · Alpha <0% + shadow rank >50 · 4 reviews',kind:'rankAlpha',threshold:0,confirmations:4,minShadowRank:50},
  {key:'alpha_minus5_shadow100_2q',label:'H · Alpha <-5% + shadow rank >100 · 2 reviews',kind:'rankAlpha',threshold:-.05,confirmations:2,minShadowRank:100},
  // v12.48 predeclared composite challengers. These are deliberately sparse rather than a threshold grid.
  {key:'composite_review_4q',label:'I · Composite SELL REVIEW · Alpha <-5%, Alpha down >=20pp, rank >100, rank percentile down >25pp · 4 reviews',kind:'composite',threshold:-.05,confirmations:4,minShadowRank:100,minAlphaDrop:.20,minShadowPctDrop:.25},
  {key:'strong_composite_review_4q',label:'J · Strong SELL REVIEW · Alpha <-15%, rank >100, rank percentile down >25pp · 4 reviews',kind:'strongComposite',threshold:-.15,confirmations:4,minShadowRank:100,minShadowPctDrop:.25}
];
function impliedShareholderOutcome(row){
  const direct=finite(row?.totalShareholderValue);if(Number.isFinite(direct)&&direct>0)return direct;
  const p=finite(row?.price),c=finite(row?.expectedCAGR),h=finite(row?.horizonYears)||10;
  return p>0&&Number.isFinite(c)&&h>0?p*Math.pow(Math.max(.000001,1+c),h):null;
}
function ownerAlphaDecomposition(entry,row){
  const h=finite(row?.horizonYears)||finite(entry?.horizonYears)||10;
  const ep=finite(entry?.price),cp=finite(row?.price),eo=impliedShareholderOutcome(entry),co=impliedShareholderOutcome(row);
  const annual=(ratio)=>ratio>0&&h>0?Math.pow(ratio,1/h)-1:null;
  const outcomeAnnualizedChange=eo>0&&co>0?annual(co/eo):null;
  const priceAnnualizedChange=ep>0&&cp>0?annual(cp/ep):null;
  return {
    entryPrice:ep,currentPrice:cp,entryOutcome:eo,currentOutcome:co,
    outcomeAnnualizedChange,priceAnnualizedChange,
    entryExpectedCAGR:finite(entry?.expectedCAGR),currentExpectedCAGR:finite(row?.expectedCAGR),
    expectedCAGRChange:Number.isFinite(finite(entry?.expectedCAGR))&&Number.isFinite(finite(row?.expectedCAGR))?finite(row.expectedCAGR)-finite(entry.expectedCAGR):null,
    revenueGrowthAnchorChange:Number.isFinite(finite(entry?.revenueGrowthAnchor))&&Number.isFinite(finite(row?.revenueGrowthAnchor))?finite(row.revenueGrowthAnchor)-finite(entry.revenueGrowthAnchor):null,
    year5OperatingGrowthChange:Number.isFinite(finite(entry?.year5OperatingGrowth))&&Number.isFinite(finite(row?.year5OperatingGrowth))?finite(row.year5OperatingGrowth)-finite(entry.year5OperatingGrowth):null,
    targetFcfMarginChange:Number.isFinite(finite(entry?.targetFcfMargin))&&Number.isFinite(finite(row?.targetFcfMargin))?finite(row.targetFcfMargin)-finite(entry.targetFcfMargin):null,
    targetNetMarginChange:Number.isFinite(finite(entry?.targetNetMargin))&&Number.isFinite(finite(row?.targetNetMargin))?finite(row.targetNetMargin)-finite(entry.targetNetMargin):null
  };
}
function ownerAlphaRulePass(entry,row,rule){
  if(rule.kind==='never')return false;
  const a=finite(row?.expectedAlpha);if(!Number.isFinite(a)||a>=rule.threshold)return false;
  if(rule.kind==='alpha')return true;
  if(rule.kind==='rankAlpha')return Number.isFinite(finite(row?.ownerShadowRank))&&finite(row.ownerShadowRank)>rule.minShadowRank;
  if(rule.kind==='composite'||rule.kind==='strongComposite'){
    const sr=finite(row?.ownerShadowRank),su=finite(row?.ownerShadowUniverse),er=finite(entry?.ownerEntryShadowRank),eu=finite(entry?.ownerEntryShadowUniverse);
    if(!(Number.isFinite(sr)&&sr>rule.minShadowRank&&Number.isFinite(su)&&su>0&&Number.isFinite(er)&&Number.isFinite(eu)&&eu>0))return false;
    const shadowPctDrop=sr/su-er/eu;
    if(!(shadowPctDrop>rule.minShadowPctDrop))return false;
    if(rule.kind==='composite'){
      const entryAlpha=finite(entry?.expectedAlpha);
      if(!(Number.isFinite(entryAlpha)&&entryAlpha-a>=rule.minAlphaDrop))return false;
    }
    return true;
  }
  const d=ownerAlphaDecomposition(entry,row);
  if(rule.kind==='outcome')return Number.isFinite(d.outcomeAnnualizedChange)&&d.outcomeAnnualizedChange<=rule.outcomeAnnualizedMax;
  if(rule.kind==='forecast'){
    const drops=[d.revenueGrowthAnchorChange,d.year5OperatingGrowthChange,d.targetFcfMarginChange,d.targetNetMarginChange].filter(Number.isFinite);
    return drops.some(x=>x<=-rule.forecastDrop);
  }
  return false;
}
function ownerAlphaExitSignal(entry,reviews,rule){
  if(rule.kind==='never'||!rule.confirmations)return null;
  let streak=0;
  for(const x of reviews||[]){
    const pass=ownerAlphaRulePass(entry,x.row,rule);streak=pass?streak+1:0;
    if(streak>=rule.confirmations){
      const d=ownerAlphaDecomposition(entry,x.row);
      return {asOf:x.asOf,row:x.row,reason:rule.key,expectedAlpha:finite(x.row?.expectedAlpha),streak,decomposition:d};
    }
  }
  return null;
}
function evaluateOwnerAlphaExit(entry,entryAsOf,rule,reviewIndex,historyByTicker,spyHistory,horizon=5){
  const endDate=addYears(entryAsOf,horizon),group=economicSecurityGroup(entry.ticker),groupReviews=reviewIndex.get(group)||[];
  const entryReview=groupReviews.find(x=>String(x.asOf)===String(entryAsOf));
  const entryForRule={...entry,ownerEntryShadowRank:finite(entryReview?.row?.ownerShadowRank),ownerEntryShadowUniverse:finite(entryReview?.row?.ownerShadowUniverse)};
  const reviews=groupReviews.filter(x=>String(x.asOf)>String(entryAsOf)&&String(x.asOf)<String(endDate));
  const signal=ownerAlphaExitSignal(entryForRule,reviews,rule);
  const history=historyForEconomicSecurity(entry.ticker,historyByTicker);if(!history)return null;
  const hold=adjustedReturnBetween(history,entryAsOf,endDate,{executeAfterStart:true});
  const spyFull=adjustedReturnBetween(spyHistory,entryAsOf,endDate,{executeAfterStart:true});
  if(!hold||!spyFull)return null;
  const holdWealth=1+hold.return,holdCAGR=Math.pow(Math.max(0,holdWealth),1/horizon)-1,spyCAGR=Math.pow(Math.max(0,1+spyFull.return),1/horizon)-1;
  if(!signal)return {ticker:entry.ticker,security:group,entryDate:entryAsOf,exitDate:null,reason:null,triggered:false,entryAlpha:finite(entry.expectedAlpha),exitAlpha:null,exitShadowRank:null,yearsHeld:horizon,holdCAGR,strategyCAGR:holdCAGR,deltaVsHoldCAGR:0,spyCAGR,postExitStockCAGR:null,postExitSpyCAGR:null,postExitExcessCAGR:null,improvedVsHold:false,decomposition:null};
  const pre=adjustedReturnBetween(history,entryAsOf,signal.asOf,{executeAfterStart:true});
  const spyAfter=adjustedReturnBetween(spyHistory,signal.asOf,endDate,{executeAfterStart:true});
  const stockAfter=adjustedReturnBetween(history,signal.asOf,endDate,{executeAfterStart:true});
  if(!pre||!spyAfter)return null;
  const strategyWealth=(1+pre.return)*(1+spyAfter.return),strategyCAGR=Math.pow(Math.max(0,strategyWealth),1/horizon)-1;
  const postYears=yearsBetweenDates(signal.asOf,endDate);
  const postStockCAGR=stockAfter&&postYears>0?Math.pow(Math.max(0,1+stockAfter.return),1/postYears)-1:null;
  const postSpyCAGR=postYears>0?Math.pow(Math.max(0,1+spyAfter.return),1/postYears)-1:null;
  const er=finite(entryForRule.ownerEntryShadowRank),eu=finite(entryForRule.ownerEntryShadowUniverse),sr=finite(signal.row?.ownerShadowRank),su=finite(signal.row?.ownerShadowUniverse);
  return {ticker:entry.ticker,security:group,entryDate:entryAsOf,exitDate:signal.asOf,reason:signal.reason,triggered:true,entryAlpha:finite(entry.expectedAlpha),exitAlpha:finite(signal.row?.expectedAlpha),alphaChange:Number.isFinite(finite(entry.expectedAlpha))&&Number.isFinite(finite(signal.row?.expectedAlpha))?finite(signal.row.expectedAlpha)-finite(entry.expectedAlpha):null,entryShadowRank:er,exitShadowRank:sr,shadowPctChange:Number.isFinite(er)&&Number.isFinite(eu)&&eu>0&&Number.isFinite(sr)&&Number.isFinite(su)&&su>0?sr/su-er/eu:null,yearsHeld:yearsBetweenDates(entryAsOf,signal.asOf),holdCAGR,strategyCAGR,deltaVsHoldCAGR:strategyCAGR-holdCAGR,spyCAGR,postExitStockCAGR:postStockCAGR,postExitSpyCAGR:postSpyCAGR,postExitExcessCAGR:Number.isFinite(postStockCAGR)&&Number.isFinite(postSpyCAGR)?postStockCAGR-postSpyCAGR:null,improvedVsHold:strategyCAGR>holdCAGR,decomposition:signal.decomposition};
}
function ownerAlphaExitPortfolioComparison(fixedHold5,entryLookup,rule,reviewIndex,historyByTicker,spyHistory){
  const cohorts=[];
  for(const c of fixedHold5?.cohorts||[]){
    const evals=[];
    for(const t of c.tickers||[]){const entry=entryLookup.get(`${c.asOf}|${economicSecurityGroup(t)}`);if(!entry)continue;const e=evaluateOwnerAlphaExit(entry,c.asOf,rule,reviewIndex,historyByTicker,spyHistory,5);if(e)evals.push(e);}
    if(!evals.length)continue;
    const wealth=mean(evals.map(x=>Math.pow(Math.max(0,1+x.strategyCAGR),5))),holdWealth=mean(evals.map(x=>Math.pow(Math.max(0,1+x.holdCAGR),5)));
    const portfolioCAGR=Math.pow(Math.max(0,wealth),1/5)-1,holdCAGR=Math.pow(Math.max(0,holdWealth),1/5)-1,spyCAGR=mean(evals.map(x=>x.spyCAGR));
    cohorts.push({asOf:c.asOf,holdings:evals.length,portfolioCAGR,holdCAGR,deltaVsHoldCAGR:portfolioCAGR-holdCAGR,spyCAGR,excessCAGR:portfolioCAGR-spyCAGR,sellCount:evals.filter(x=>x.triggered).length,sales:evals.filter(x=>x.triggered)});
  }
  return {cohortCount:cohorts.length,meanPortfolioCAGR:mean(cohorts.map(x=>x.portfolioCAGR)),medianPortfolioCAGR:median(cohorts.map(x=>x.portfolioCAGR)),meanHoldCAGR:mean(cohorts.map(x=>x.holdCAGR)),meanDeltaVsHoldCAGR:mean(cohorts.map(x=>x.deltaVsHoldCAGR)),meanSpyCAGR:mean(cohorts.map(x=>x.spyCAGR)),meanExcessCAGR:mean(cohorts.map(x=>x.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(x=>x.portfolioCAGR>x.spyCAGR).length/cohorts.length:null,totalSales:cohorts.reduce((a,x)=>a+x.sellCount,0),averageSalesPerCohort:mean(cohorts.map(x=>x.sellCount)),worstCohort:cohorts.reduce((a,b)=>!a||b.portfolioCAGR<a.portfolioCAGR?b:a,null),cohorts};
}

function buildOwnerReviewIndexWithShadowRank(snapshotOutput){
  const byGroup=new Map();
  for(const snap of snapshotOutput||[]){
    const cloned=(snap.rows||[]).map(r=>({...r}));
    // Diagnostic-only rank: preserve Model-D's 50/50 Alpha + quality-basket architecture,
    // but remove the hard Alpha gate so a held stock can still have a meaningful relative rank
    // after its Alpha falls below the new-money threshold.
    applyModelDRanking(cloned,{rankField:'ownerShadowRank',universeSizeField:'ownerShadowUniverse',alphaGate:-10});
    for(const row of cloned){
      const g=economicSecurityGroup(row.ticker);if(!byGroup.has(g))byGroup.set(g,[]);
      byGroup.get(g).push({asOf:snap.asOf,row});
    }
  }
  for(const xs of byGroup.values())xs.sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||(finite(a.row.ownerShadowRank)??9999)-(finite(b.row.ownerShadowRank)??9999));
  return byGroup;
}
function sellCheckpoint(entry,entryAsOf,review,historyByTicker,spyHistory,horizon=5,trajectory=null){
  const endDate=addYears(entryAsOf,horizon),history=historyForEconomicSecurity(entry.ticker,historyByTicker);if(!history)return null;
  const pre=adjustedReturnBetween(history,entryAsOf,review.asOf,{executeAfterStart:true});
  const hold=adjustedReturnBetween(history,entryAsOf,endDate,{executeAfterStart:true});
  const stockAfter=adjustedReturnBetween(history,review.asOf,endDate,{executeAfterStart:true});
  const spyAfter=adjustedReturnBetween(spyHistory,review.asOf,endDate,{executeAfterStart:true});
  if(!pre||!hold||!stockAfter||!spyAfter)return null;
  const postYears=yearsBetweenDates(review.asOf,endDate);if(!(postYears>0))return null;
  const holdCAGR=Math.pow(Math.max(0,1+hold.return),1/horizon)-1;
  const strategyCAGR=Math.pow(Math.max(0,(1+pre.return)*(1+spyAfter.return)),1/horizon)-1;
  const postExitStockCAGR=Math.pow(Math.max(0,1+stockAfter.return),1/postYears)-1;
  const postExitSpyCAGR=Math.pow(Math.max(0,1+spyAfter.return),1/postYears)-1;
  const d=ownerAlphaDecomposition(entry,review.row);
  return {ticker:entry.ticker,security:economicSecurityGroup(entry.ticker),entryDate:entryAsOf,reviewDate:review.asOf,entryAlpha:finite(entry.expectedAlpha),alpha:finite(review.row.expectedAlpha),entryRank:finite(entry.rank),shadowRank:finite(review.row.ownerShadowRank),shadowUniverse:finite(review.row.ownerShadowUniverse),quality:finite(review.row.qualityScore),protection:finite(review.row.protectionScore),holdCAGR,strategyCAGR,deltaVsHoldCAGR:strategyCAGR-holdCAGR,postExitStockCAGR,postExitSpyCAGR,postExitExcessCAGR:postExitStockCAGR-postExitSpyCAGR,sellWouldHelp:strategyCAGR>holdCAGR,decomposition:d,...(trajectory||{})};
}
function summarizeSellCheckpoints(rows){
  const v=(rows||[]).filter(Boolean);return {n:v.length,helpRate:v.length?v.filter(x=>x.sellWouldHelp).length/v.length:null,meanDeltaVsHoldCAGR:mean(v.map(x=>x.deltaVsHoldCAGR)),meanPostExitExcessCAGR:mean(v.map(x=>x.postExitExcessCAGR)),meanAlpha:mean(v.map(x=>x.alpha)),meanAlphaChange:mean(v.map(x=>x.alphaChange)),meanShadowRank:mean(v.map(x=>x.shadowRank)),meanEntryShadowRank:mean(v.map(x=>x.entryShadowRank)),meanShadowRankChange:mean(v.map(x=>x.shadowRankChange)),meanShadowPctChange:mean(v.map(x=>x.shadowPctChange)),meanNegativeAlphaStreak:mean(v.map(x=>x.negativeAlphaStreak)),meanJointBadStreak:mean(v.map(x=>x.jointBadStreak)),meanOutcomeAnnualizedChange:mean(v.map(x=>x.decomposition?.outcomeAnnualizedChange)),meanPriceAnnualizedChange:mean(v.map(x=>x.decomposition?.priceAnnualizedChange))};
}
function groupSellCheckpoints(rows,keyFn){
  const m=new Map();for(const r of rows||[]){const k=keyFn(r);if(k==null)continue;if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return [...m.entries()].map(([bucket,x])=>({bucket,...summarizeSellCheckpoints(x)}));
}
function buildSellDiagnosticLab(eligible,snapshotOutput,historyByTicker,spyHistory){
  const reviewIndex=buildOwnerReviewIndexWithShadowRank(snapshotOutput),first=[];const seen=new Set();
  for(const r of [...(eligible||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||(finite(a.rank)??9999)-(finite(b.rank)??9999))){const g=economicSecurityGroup(r.ticker);if(seen.has(g)||!Number.isFinite(r.realized5YTotalReturnCAGR))continue;seen.add(g);first.push(r);}
  const firstNegative=[],allNegative=[];
  for(const entry of first){
    const group=economicSecurityGroup(entry.ticker),end=addYears(entry.asOf,5),allReviews=(reviewIndex.get(group)||[]).filter(x=>String(x.asOf)>=String(entry.asOf)&&String(x.asOf)<String(end));
    const entryReview=allReviews.find(x=>String(x.asOf)===String(entry.asOf))||null;
    const er=finite(entryReview?.row?.ownerShadowRank),eu=finite(entryReview?.row?.ownerShadowUniverse),ep=Number.isFinite(er)&&Number.isFinite(eu)&&eu>0?er/eu:null;
    let negStreak=0,jointStreak=0,added=false;
    for(const review of allReviews){
      if(String(review.asOf)<=String(entry.asOf))continue;
      const a=finite(review.row.expectedAlpha),sr=finite(review.row.ownerShadowRank),su=finite(review.row.ownerShadowUniverse),sp=Number.isFinite(sr)&&Number.isFinite(su)&&su>0?sr/su:null;
      negStreak=Number.isFinite(a)&&a<0?negStreak+1:0;
      jointStreak=Number.isFinite(a)&&a<0&&Number.isFinite(sr)&&sr>100?jointStreak+1:0;
      if(!(Number.isFinite(a)&&a<0))continue;
      const trajectory={entryShadowRank:er,entryShadowUniverse:eu,entryShadowPct:ep,shadowPct:sp,shadowRankChange:Number.isFinite(er)&&Number.isFinite(sr)?sr-er:null,shadowPctChange:Number.isFinite(ep)&&Number.isFinite(sp)?sp-ep:null,alphaChange:Number.isFinite(finite(entry.expectedAlpha))?a-finite(entry.expectedAlpha):null,negativeAlphaStreak:negStreak,jointBadStreak:jointStreak,yearsSinceEntry:yearsBetweenDates(entry.asOf,review.asOf)};
      const c=sellCheckpoint(entry,entry.asOf,review,historyByTicker,spyHistory,5,trajectory);if(!c)continue;allNegative.push(c);if(!added){firstNegative.push(c);added=true;}
    }
  }
  const alphaBucketFn=r=>r.alpha<-.10?'Alpha <-10%':r.alpha<-.05?'Alpha -10% to -5%':'Alpha -5% to 0%';
  const rankBucketFn=r=>r.shadowRank<=50?'Shadow rank 1-50':r.shadowRank<=100?'Shadow rank 51-100':'Shadow rank >100';
  const alphaChangeBucketFn=r=>!Number.isFinite(r.alphaChange)?null:r.alphaChange<=-.20?'Alpha deterioration >20pp':r.alphaChange<=-.10?'Alpha deterioration 10-20pp':'Alpha deterioration <10pp';
  const rankPctChangeBucketFn=r=>!Number.isFinite(r.shadowPctChange)?null:r.shadowPctChange>.25?'Rank percentile deterioration >25pp':r.shadowPctChange>.10?'Rank percentile deterioration 10-25pp':'Rank percentile deterioration <=10pp';
  const rankChangeBucketFn=r=>!Number.isFinite(r.shadowRankChange)?null:r.shadowRankChange>200?'Rank fell >200 places':r.shadowRankChange>100?'Rank fell 101-200':r.shadowRankChange>50?'Rank fell 51-100':'Rank fell <=50 places';
  const persistenceBucketFn=r=>r.negativeAlphaStreak>=4?'Negative Alpha 4q+':r.negativeAlphaStreak===3?'Negative Alpha 3q':r.negativeAlphaStreak===2?'Negative Alpha 2q':'Negative Alpha 1q';
  const crossFn=r=>`${alphaBucketFn(r)} · ${rankBucketFn(r)}`;
  const trajectoryCrossFn=r=>`${alphaChangeBucketFn(r)} · ${rankPctChangeBucketFn(r)}`;
  const helpful=firstNegative.filter(x=>x.sellWouldHelp),harmful=firstNegative.filter(x=>!x.sellWouldHelp);
  const trajectorySummary=(rows)=>({overall:summarizeSellCheckpoints(rows),byAlphaChange:groupSellCheckpoints(rows,alphaChangeBucketFn),byRankChange:groupSellCheckpoints(rows,rankChangeBucketFn),byRankPercentileChange:groupSellCheckpoints(rows,rankPctChangeBucketFn),byPersistence:groupSellCheckpoints(rows,persistenceBucketFn),byAlphaChangeAndRankPercentile:groupSellCheckpoints(rows,trajectoryCrossFn)});
  return {description:'v12.48 preserved sell diagnostic dataset from v12.47. No new automatic exit rule is promoted. It extends the v12.46 negative-Alpha checkpoints with rank trajectory from the original owner entry: entry shadow rank, current shadow rank, absolute rank change, percentile-rank deterioration, Alpha deterioration, negative-Alpha persistence and joint Alpha<0 + shadow-rank>100 persistence. This is designed to learn what separates helpful sells from costly false positives before predeclaring another exit rule.',firstNegativeAlpha:{overall:summarizeSellCheckpoints(firstNegative),byAlpha:groupSellCheckpoints(firstNegative,alphaBucketFn),byShadowRank:groupSellCheckpoints(firstNegative,rankBucketFn),byAlphaAndShadowRank:groupSellCheckpoints(firstNegative,crossFn),...trajectorySummary(firstNegative),helpfulProfile:summarizeSellCheckpoints(helpful),harmfulProfile:summarizeSellCheckpoints(harmful),rows:firstNegative},allNegativeAlphaReviews:{overall:summarizeSellCheckpoints(allNegative),byAlpha:groupSellCheckpoints(allNegative,alphaBucketFn),byShadowRank:groupSellCheckpoints(allNegative,rankBucketFn),byAlphaAndShadowRank:groupSellCheckpoints(allNegative,crossFn),...trajectorySummary(allNegative)}};
}

function buildOwnerAlphaExitLab(eligible,snapshotOutput,historyByTicker,spyHistory,fixedHold15){
  const reviewIndex=buildOwnerReviewIndexWithShadowRank(snapshotOutput),entryLookup=new Map();
  for(const r of eligible||[])entryLookup.set(`${r.asOf}|${economicSecurityGroup(r.ticker)}`,r);
  const first=[];const seen=new Set();
  for(const r of [...(eligible||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf))||(finite(a.rank)??9999)-(finite(b.rank)??9999))){const g=economicSecurityGroup(r.ticker);if(seen.has(g)||!Number.isFinite(r.realized5YTotalReturnCAGR))continue;seen.add(g);first.push(r);}
  const rules=ALPHA_EXIT_RULES.map(rule=>{
    const evals=first.map(r=>evaluateOwnerAlphaExit(r,r.asOf,rule,reviewIndex,historyByTicker,spyHistory,5)).filter(Boolean);
    return {key:rule.key,label:rule.label,kind:rule.kind,threshold:rule.threshold??null,confirmations:rule.confirmations,firstSignalAudit:summarizeOwnerExitEvaluations(evals),portfolioAudit:ownerAlphaExitPortfolioComparison(fixedHold15?.['5Y'],entryLookup,rule,reviewIndex,historyByTicker,spyHistory)};
  });
  return {description:'v12.48 frozen 15%-hurdle composite sell challenger. Prior rules A-H remain unchanged as controls. I requires Alpha <-5%, Alpha deterioration >=20pp from entry, shadow rank >100, shadow-rank percentile deterioration >25pp, all for four consecutive quarterly reviews. J requires Alpha <-15%, shadow rank >100 and shadow-rank percentile deterioration >25pp for four consecutive reviews. Missing/nonqualifying reviews reset confirmation. Sales move to SPY through the original 5-year endpoint. Unique-security audits now include false-positive damage, including mean mistake cost, worst mistaken sell and top-3 mistake damage.',horizonYears:5,alphaHurdle:.15,entryRuleFrozen:true,rules};
}
function alphaSizingTarget(alpha){
  if(!Number.isFinite(alpha))return 4.5;
  if(alpha>=.35)return 8.5;if(alpha>=.25)return 7.5;if(alpha>=.15)return 6.5;if(alpha>=.10)return 5.5;return 4.5;
}
function ownerConviction01(r){
  const xs=[r.qualityScore,r.moatScore,r.growthQualityScore,r.compounderScore,r.forecastConfidence,r.valuationConfidence].map(finite).filter(Number.isFinite).map(x=>Math.max(0,Math.min(100,x))/100);
  return xs.length?mean(xs):.5;
}
function normalizeRawWeights(items,rawFn){
  const raw=items.map(r=>Math.max(.0001,rawFn(r))),sum=raw.reduce((a,b)=>a+b,0);
  return raw.map(x=>x/sum);
}
function weightedHoldCAGR(items,weights,horizon=5){
  let terminal=0;for(let i=0;i<items.length;i++){const c=items[i][`realized${horizon}YTotalReturnCAGR`];if(!Number.isFinite(c))continue;terminal+=weights[i]*Math.pow(Math.max(0,1+c),horizon);}return Math.pow(Math.max(0,terminal),1/horizon)-1;
}
function weightingWinnerRemoval(items,weights,horizon=5,removeN=1){
  const idx=items.map((r,i)=>({i,c:r[`realized${horizon}YTotalReturnCAGR`]})).filter(x=>Number.isFinite(x.c)).sort((a,b)=>b.c-a.c).slice(removeN).map(x=>x.i);
  const sum=idx.reduce((a,i)=>a+weights[i],0);if(!idx.length||sum<=0)return null;
  let terminal=0;for(const i of idx)terminal+=(weights[i]/sum)*Math.pow(Math.max(0,1+items[i][`realized${horizon}YTotalReturnCAGR`]),horizon);
  return Math.pow(Math.max(0,terminal),1/horizon)-1;
}
function buildOwnerWeightingLab(snapshotOutput){
  const specs=[
    {key:'equal',label:'A · Equal weight',raw:r=>1},
    {key:'alpha_mild',label:'B · Mild Alpha weighting · CURRENT LEADER',raw:r=>alphaSizingTarget(finite(r.expectedAlpha))},
    {key:'conviction_mild',label:'C · Mild Alpha + old conviction',raw:r=>alphaSizingTarget(finite(r.expectedAlpha))*(.85+.30*ownerConviction01(r))},
    {key:'rating_alpha',label:'D · Valuation Rating + Alpha weighting · v12.50 CHALLENGER',raw:r=>ratingAlphaSizingTarget(r)}
  ];
  const results=[];
  for(const spec of specs){
    const cohorts=[];
    for(const snap of snapshotOutput||[]){
      const eligible=dedupeEconomicSecurities((snap.rows||[]).filter(r=>ownerValuationEntryEligible(r)).sort((a,b)=>a.rank-b.rank)).slice(0,15);
      const items=eligible.filter(r=>Number.isFinite(r.realized5YTotalReturnCAGR)&&Number.isFinite(r.spy5YTotalReturnCAGR));if(!items.length)continue;
      const weights=normalizeRawWeights(items,spec.raw),portfolioCAGR=weightedHoldCAGR(items,weights,5),spyCAGR=cohortSpyCAGR(items,5);
      const terminalVals=items.map((r,i)=>weights[i]*Math.pow(Math.max(0,1+r.realized5YTotalReturnCAGR),5)),terminalTotal=terminalVals.reduce((a,b)=>a+b,0);
      const terminalWeights=terminalVals.map(x=>terminalTotal>0?x/terminalTotal:0);
      cohorts.push({asOf:snap.asOf,holdings:items.length,portfolioCAGR,spyCAGR,excessCAGR:portfolioCAGR-spyCAGR,beatSpy:portfolioCAGR>spyCAGR,initialMinWeight:Math.min(...weights),initialMaxWeight:Math.max(...weights),terminalMaxWeight:Math.max(...terminalWeights),removeBest1CAGR:weightingWinnerRemoval(items,weights,5,1),removeBest3CAGR:weightingWinnerRemoval(items,weights,5,3),allocations:items.map((r,i)=>({ticker:r.ticker,rank:r.rank,rating:r.rating,expectedAlpha:r.expectedAlpha,qualityScore:r.qualityScore,forecastConfidence:r.forecastConfidence,valuationConfidence:r.valuationConfidence,initialWeight:weights[i],realized5YCAGR:r.realized5YTotalReturnCAGR,terminalWeight:terminalWeights[i]}))});
    }
    const meanSpy=mean(cohorts.map(c=>c.spyCAGR));
    results.push({key:spec.key,label:spec.label,cohortCount:cohorts.length,meanPortfolioCAGR:mean(cohorts.map(c=>c.portfolioCAGR)),medianPortfolioCAGR:median(cohorts.map(c=>c.portfolioCAGR)),meanSpyCAGR:meanSpy,meanExcessCAGR:mean(cohorts.map(c=>c.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(c=>c.beatSpy).length/cohorts.length:null,worstCohort:cohorts.reduce((a,b)=>!a||b.portfolioCAGR<a.portfolioCAGR?b:a,null),meanInitialMaxWeight:mean(cohorts.map(c=>c.initialMaxWeight)),meanTerminalMaxWeight:mean(cohorts.map(c=>c.terminalMaxWeight)),meanRemoveBest1CAGR:mean(cohorts.map(c=>c.removeBest1CAGR)),meanRemoveBest1Excess:mean(cohorts.map(c=>c.removeBest1CAGR-c.spyCAGR)),meanRemoveBest3CAGR:mean(cohorts.map(c=>c.removeBest3CAGR)),meanRemoveBest3Excess:mean(cohorts.map(c=>c.removeBest3CAGR-c.spyCAGR)),cohorts});
  }
  return {description:'v12.50 valuation-rating weighting lab. Every method owns the exact same up-to-15 stocks that clear the frozen rank/Alpha/CAGR gates AND the existing point-in-time Valuation Rating of Buy, Strong Buy, or Exceptional Buy. No portfolio-specific rating is manufactured. Every method then holds unchanged for five years; only initial weights differ.',methods:{equal:'Equal weight.',alpha_mild:'Current leader control: Alpha bucket targets of 4.5/5.5/6.5/7.5/8.5 for entry Alpha 5-10/10-15/15-25/25-35/35%+ on the 15% hurdle scale, normalized to 100%.',conviction_mild:'Old challenger: Mild Alpha multiplied by a bounded 0.85-1.15 generic conviction adjustment.',rating_alpha:'v12.50 challenger: the existing Valuation Rating sets the sizing band—Buy = 4.5-6 raw points, Strong Buy = 6-8, Exceptional Buy = 8-10—and Alpha determines position within that band before normalization.'},results};
}
function buildAlphaGateRecalibrationLab(snapshotOutput){
  const gates=[
    {key:'alpha_ge_0',label:'Alpha >=0% (>=15% expected CAGR)',gate:0},
    {key:'alpha_ge_5',label:'Alpha >=5% (>=20% expected CAGR)',gate:.05},
    {key:'alpha_ge_10',label:'Alpha >=10% (>=25% expected CAGR)',gate:.10}
  ];
  const results=[];
  for(const spec of gates){
    const cohorts=[];const individual=[];
    for(const snap of snapshotOutput||[]){
      const cloned=(snap.rows||[]).map(r=>({...r}));
      applyModelDRanking(cloned,{rankField:'recalRank',universeSizeField:null,alphaGate:spec.gate});
      const picks=dedupeEconomicSecurities(cloned.filter(r=>r.rankEligible===true&&Number.isFinite(r.recalRank)&&r.recalRank<=25&&String(r.modelSupport||'')!=='unsupported').sort((a,b)=>a.recalRank-b.recalRank)).slice(0,15);
      const completed=picks.filter(r=>Number.isFinite(r.realized5YTotalReturnCAGR)&&Number.isFinite(r.spy5YTotalReturnCAGR));
      if(completed.length){
        const portfolioCAGR=equalWeightFixedHoldCAGR(completed,5),spyCAGR=cohortSpyCAGR(completed,5);
        cohorts.push({asOf:snap.asOf,holdings:completed.length,portfolioCAGR,spyCAGR,excessCAGR:portfolioCAGR-spyCAGR,beatSpy:portfolioCAGR>spyCAGR,tickers:completed.map(r=>r.ticker)});
        individual.push(...completed);
      }
    }
    const uniq=[];const seen=new Set();
    for(const r of individual){const g=economicSecurityGroup(r.ticker);if(seen.has(g))continue;seen.add(g);uniq.push(r);}
    results.push({key:spec.key,label:spec.label,alphaGate:spec.gate,cohortCount:cohorts.length,meanPortfolioCAGR:mean(cohorts.map(x=>x.portfolioCAGR)),medianPortfolioCAGR:median(cohorts.map(x=>x.portfolioCAGR)),meanSpyCAGR:mean(cohorts.map(x=>x.spyCAGR)),meanExcessCAGR:mean(cohorts.map(x=>x.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(x=>x.beatSpy).length/cohorts.length:null,worstCohort:cohorts.reduce((a,b)=>!a||b.portfolioCAGR<a.portfolioCAGR?b:a,null),uniqueSecurities:uniq.length,uniqueMeanStockCAGR:mean(uniq.map(r=>r.realized5YTotalReturnCAGR)),uniqueMeanExcessCAGR:mean(uniq.map(r=>r.excess5YTotalReturnCAGR)),uniqueBeatSpyRate:uniq.length?uniq.filter(r=>Number.isFinite(r.excess5YTotalReturnCAGR)&&r.excess5YTotalReturnCAGR>0).length/uniq.filter(r=>Number.isFinite(r.excess5YTotalReturnCAGR)).length:null,cohorts});
  }
  return {description:'v12.45 Alpha-gate recalibration after redefining Alpha as expected CAGR minus the user\'s 15% hurdle. Each gate reruns the same Model-D percentile ranking within that gate, then selects up to the top 15 among rank<=25. This is a small predeclared 0/5/10-point comparison, not a threshold sweep.',alphaHurdle:.15,results};
}

function buildLongTermOwnerLab(rows,snapshotOutput,historyByTicker=null,spyHistory=null){
  const dynamicSnapshots=(snapshotOutput||[]).map(s=>({...s,rows:dynamicRankSnapshotRows(s.rows||[]).map(r=>({...r,asOf:s.asOf}))}));
  const eligible=dynamicSnapshots.flatMap(s=>s.rows).filter(r=>ownerDynamicEntryEligible(r));
  const horizons={};
  for(const h of [1,3,5]){
    horizons[`${h}Y`]={
      overall:longTermOwnerOutcomeStats(eligible,h),
      byEntryRank:longTermOwnerGrouped(eligible,r=>r.rank<=5?'Rank 1-5':r.rank<=10?'Rank 6-10':r.rank<=15?'Rank 11-15':'Rank 16-25',h),
      byCategory:longTermOwnerGrouped(eligible,r=>r.category||'Unclassified',h).sort((a,b)=>b.n-a.n),
      bySector:longTermOwnerGrouped(eligible,r=>r.sector||'Unknown',h).sort((a,b)=>b.n-a.n),
      byAlpha:longTermOwnerGrouped(eligible,r=>r.expectedAlpha>=.15?'Alpha >=15%':r.expectedAlpha>=.10?'Alpha 10-15%':'Alpha 5-10%',h),
      byDividend:longTermOwnerGrouped(eligible,r=>(finite(r.dividendYield)||0)>=.03?'Yield >=3%':(finite(r.dividendYield)||0)>=.01?'Yield 1-3%':'Yield <1%',h)
    };
  }
  const fixedHold15={}; for(const h of [3,5]){const cohorts=[];for(const snap of dynamicSnapshots){const picks=dedupeEconomicSecurities((snap.rows||[]).filter(ownerDynamicEntryEligible).sort((a,b)=>a.dynamicRank-b.dynamicRank)).slice(0,15);const valid=picks.filter(r=>Number.isFinite(r[`realized${h}YTotalReturnCAGR`])&&Number.isFinite(r[`spy${h}YTotalReturnCAGR`]));if(!valid.length)continue;const stockCAGR=equalWeightFixedHoldCAGR(valid,h),spyCAGR=cohortSpyCAGR(valid,h);cohorts.push({asOf:snap.asOf,holdings:valid.length,stockCAGR,spyCAGR,excessCAGR:stockCAGR-spyCAGR,beatSpy:stockCAGR>spyCAGR,hit15:stockCAGR>=.15,tickers:valid.map(r=>r.ticker),members:valid.map(r=>({ticker:r.ticker,cagr:r[`realized${h}YTotalReturnCAGR`]}))});}fixedHold15[`${h}Y`]={horizonYears:h,cohortCount:cohorts.length,meanHoldings:mean(cohorts.map(x=>x.holdings)),meanPortfolioCAGR:mean(cohorts.map(x=>x.stockCAGR)),medianPortfolioCAGR:median(cohorts.map(x=>x.stockCAGR)),meanSpyCAGR:mean(cohorts.map(x=>x.spyCAGR)),meanExcessCAGR:mean(cohorts.map(x=>x.excessCAGR)),medianExcessCAGR:median(cohorts.map(x=>x.excessCAGR)),beatSpyRate:cohorts.length?cohorts.filter(x=>x.beatSpy).length/cohorts.length:null,hit15CAGRRate:cohorts.length?cohorts.filter(x=>x.hit15).length/cohorts.length:null,cohorts};}
  return {
    description:'v12.51 long-term-owner test. Entry requires >=15% expected CAGR, dynamic Model-D rank <=25, supported valuation, and a quality/confidence-scaled margin of safety. Elite established compounders need 5% MOS, strong established businesses 10%, standard quality 20%, and higher-uncertainty names 25%. Outcomes are measured from the original purchase signal with no rank-based selling.',
    intendedUse:'Approximately 15 growth/value/dividend holdings; high hurdle to buy; 5+ year ownership intent; quarterly thesis review; rank changes alone are not a sell signal.',
    entryRule:{maxRank:25,minExpectedAlpha:0,minExpectedCAGR:.15,dynamicMarginOfSafety:true,modelSupport:'supported',portfolioTarget:15},
    eligibleObservations:eligible.length,horizons,fixedHold15,
    robustnessAudit:buildOwnerRobustnessAudit(eligible,fixedHold15),
    exitLab:historyByTicker&&spyHistory?buildOwnerExitLab(eligible,snapshotOutput,historyByTicker,spyHistory,fixedHold15):null,
    alphaExitLab:historyByTicker&&spyHistory?buildOwnerAlphaExitLab(eligible,snapshotOutput,historyByTicker,spyHistory,fixedHold15):null,
    sellDiagnosticLab:historyByTicker&&spyHistory?buildSellDiagnosticLab(eligible,snapshotOutput,historyByTicker,spyHistory):null,
    weightingLab:buildOwnerWeightingLab(snapshotOutput),
    alphaGateRecalibrationLab:buildAlphaGateRecalibrationLab(snapshotOutput),
    dynamicMosEntryLab:buildDynamicMosEntryLab(snapshotOutput)
  };
}

function buildPortfolioSimulation(snapshotOutput,historyByTicker,spyHistory){
  const rules=[
    {name:'Top 10 · Alpha ≥5%',topN:10,minAlpha:.05},
    {name:'Top 20 · Alpha ≥5%',topN:20,minAlpha:.05},
    {name:'Top 30 · Alpha ≥5%',topN:30,minAlpha:.05},
    {name:'Top 20 rank · no Alpha gate',topN:20,minAlpha:-10}
  ];
  const transactionCostBps=Math.max(0,finite(process.env.BACKTEST_TRANSACTION_COST_BPS)??10);
  const strategies=rules.map(x=>simulateInvestablePortfolio(snapshotOutput,historyByTicker,spyHistory,{...x,transactionCostBps}));
  for(const s of strategies){
    s.development=periodStats(s,2019,2021);
    s.validation=periodStats(s,2022,2025);
  }
  const cohortStrategies=rules.map(x=>simulateOneYearCohorts(snapshotOutput,x));
  const thesisHoldStrategies=[
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Control · hard <6% sell · max 15',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:false,transactionCostBps}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Ride winners · max 10',topN:10,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Ride winners · max 15',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Ride winners · max 15 · $2B+',topN:15,minExpectedCAGR:.15,maxRank:25,minMarketCap:2e9,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Ride winners · max 15 · $5B+',topN:15,minExpectedCAGR:.15,maxRank:25,minMarketCap:5e9,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Ride winners · max 15 · $10B+',topN:15,minExpectedCAGR:.15,maxRank:25,minMarketCap:1e10,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'Ride winners · max 15 · ex-biotech/pharma',topN:15,minExpectedCAGR:.15,maxRank:25,excludeBiopharma:true,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,transactionCostBps})
  ];
  for(const s of thesisHoldStrategies){s.development=periodStats(s,2019,2021);s.validation=periodStats(s,2022,2025);s.sellDecisionAudit=buildSellDecisionAudit(s,historyByTicker,spyHistory);}
  const primaryThesis=thesisHoldStrategies.find(s=>s.name==='Ride winners · max 15')||thesisHoldStrategies[0];
  // Frozen sell/hold challenger: entry/ranking/sizing are identical in every arm. Only the exit rule changes.
  // These rules are deliberately predeclared rather than parameter-searched.
  const sellHoldChallengers=[
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'A · Current ride-winner rule',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'current',transactionCostBps,computeDailyRisk:false}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'B · Patient · 2-review confirmation',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'current',lowReturnConfirmations:2,forecastConfirmations:2,transactionCostBps,computeDailyRisk:false}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'C · Thesis breaks only',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'thesis_only',forecastConfirmations:2,transactionCostBps,computeDailyRisk:false}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'D · Thesis + confirmed extreme valuation',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'extreme_valuation_confirmed',lowReturnConfirmations:2,forecastConfirmations:2,transactionCostBps,computeDailyRisk:false})
  ];
  for(const s of sellHoldChallengers){s.development=periodStats(s,2019,2021);s.validation=periodStats(s,2022,2025);s.sellDecisionAudit=buildSellDecisionAudit(s,historyByTicker,spyHistory);}
  const sellHoldLab={description:'Frozen sell/hold challenger. v12.38 entry ranking, 15% expected-CAGR entry hurdle, Top-25 eligibility, sizing, execution and costs are held constant. Only exit policy changes. No sell-rule parameter search is performed.',developmentYears:'2019-2021',validationYears:'2022-2025',challengers:sellHoldChallengers};
  // v12.39: explicitly separate true thesis exits from capital rotation. The old D rule
  // is frozen as the control; no threshold search is performed.
  const sellRotateChallengers=[
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'D control · thesis + confirmed extreme valuation',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'extreme_valuation_confirmed',lowReturnConfirmations:2,forecastConfirmations:2,transactionCostBps,computeDailyRisk:false}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'E · Strict thesis breaks only',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'strict_thesis_only',forecastConfirmations:2,transactionCostBps,computeDailyRisk:false}),
    simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'F · Thesis sells + forecast rotation',topN:15,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:true,sellPolicy:'rotation_separated',forecastConfirmations:2,rotationMinExpectedCAGR:.15,transactionCostBps,computeDailyRisk:false})
  ];
  for(const s of sellRotateChallengers){s.development=periodStats(s,2019,2021);s.validation=periodStats(s,2022,2025);s.sellDecisionAudit=buildSellDecisionAudit(s,historyByTicker,spyHistory);}
  const sellRotateLab={description:'Frozen v12.39 SELL-vs-ROTATE challenger. D is the unchanged v12.38 control. E permits only quality/protection thesis breaks. F also permits a forecast-weak holding to rotate only after two weak reviews, only after its expected CAGR falls below the 15% entry hurdle, and only when a different Top-25 >=15% expected-CAGR replacement exists. Low expected return or extreme valuation alone is never a SELL in E/F. No parameter search is performed.',developmentYears:'2019-2021',validationYears:'2022-2025',challengers:sellRotateChallengers};
  // v12.40: one frozen real-world portfolio-construction challenger. The simple Top-10
  // mechanical strategy is the control. The practical arm uses the already-validated
  // v12.38 entry rank and strict-thesis ownership policy, but changes only construction:
  // 12 slots, conviction/evidence sizing, 80% starter deployment, 30% sector purchase cap,
  // additions only while the holding still clears the entry rule, and a 20% hard stock cap.
  // No sector is forced into the portfolio and no position is trimmed back to its entry target.
  const simplePortfolioControl=strategies.find(x=>x.name==='Top 10 · Alpha ≥5%')||strategies[0];
  const practicalPortfolio=simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:'B · Practical 12-stock owner portfolio',topN:12,minExpectedCAGR:.15,maxRank:25,sellExpectedCAGR:.06,maxInitialWeight:.10,rideMomentum:false,sellPolicy:'strict_thesis_only',forecastConfirmations:2,initialDeploymentCap:.80,sectorPurchaseCap:.30,hardHoldingCap:.20,scaleInitialBatch:true,transactionCostBps,computeDailyRisk:true});
  practicalPortfolio.development=periodStats(practicalPortfolio,2019,2021);practicalPortfolio.validation=periodStats(practicalPortfolio,2022,2025);practicalPortfolio.sellDecisionAudit=buildSellDecisionAudit(practicalPortfolio,historyByTicker,spyHistory);
  const portfolioConstructionLab={
    description:'Frozen v12.40 portfolio-construction challenger. A is the existing equal-weight Top-10 Alpha>=5% quarterly rebalance. B uses the frozen v12.38 Model-D/Top-25 >=15% expected-CAGR entry rule plus strict-thesis ownership: 12 slots, confidence-aware conviction sizing, 80% initial deployment, 30% sector cap on purchases, 10% max initial stock size, 20% hard stock concentration cap, additions only while a holding still qualifies, no forced sector diversification, no rank-based rotation, and residual cash when opportunities are insufficient. No construction parameter search is performed.',
    developmentYears:'2019-2021',validationYears:'2022-2025',
    challengers:[simplePortfolioControl,practicalPortfolio]
  };
  const parameterStability=buildParameterStability(snapshotOutput,historyByTicker,spyHistory,{transactionCostBps});
  const contributionRobustness=leaveWinnersOut(snapshotOutput,historyByTicker,spyHistory,primaryThesis,{transactionCostBps});
  return {
    description:`Chronological ${FREQUENCY} portfolio tests. Mechanical strategies rebalance each snapshot. The primary thesis strategy buys Top-25 names at >=15% expected CAGR, conviction-sizes them, and lets valuation-stretched winners keep running while their price momentum remains strong. The old hard <6% valuation exit is retained as a control. Trades execute after the snapshot and ${transactionCostBps} bp one-way costs are charged.`,
    thesisHoldRules:{buy:'Expected CAGR >=15% + overall rank <=25; the extra 20% MOS/Buy rating is not required',sizing:'Initial target 3/5/6/8/10% by rank bands, nudged +/-1 point by evidence; max initial size 10%. Existing winners are not trimmed back to target.',hold:'Do not sell merely because rank changes, a better-ranked stock appears, IWB membership changes, or model coverage is temporarily unavailable',rideWinner:'When expected CAGR falls below 6%, keep holding if 3M stock return is positive, 6M and 12M relative returns versus SPY are both positive, and at least one relative window leads SPY by >=5 points.',valuationSell:'Below 6% expected CAGR becomes a valuation warning. Sell only when the Ride Winner momentum test is not/ceases to be satisfied.',fundamentalSell:'Quality falls >=15 points to <60, protection falls >=20 points to <50, or forecast confidence <40; fundamental thesis breaks override momentum.',cash:'If no qualifying opportunity exists, residual capital remains in cash',reviewFrequency:FREQUENCY,shareClassRule:'Economically equivalent Alphabet share classes are mutually exclusive: if both GOOG and GOOGL qualify, only the better-ranked class may be purchased.'},
    robustness:{development:'2019-2021 review periods',validation:'2022-2025 review periods',survivorship:'Point-in-time IWB holdings are required for every historical snapshot. No current-watchlist fallback is permitted.',execution:'First trading day after each snapshot; no same-close execution.',transactionCosts:`${transactionCostBps} bp × one-way turnover.`},
    strategies,thesisHoldStrategies,sellHoldLab,sellRotateLab,portfolioConstructionLab,cohortStrategies,parameterStability,contributionRobustness
  };
}

function compactPeriodStats(x){
  if(!x||typeof x!=='object')return x||null;
  const keys=['periodCount','yearCount','portfolioCAGR','spyCAGR','annualizedExcess','cumulativeReturn','spyCumulativeReturn','annualVolatility','periodEndMaxDrawdown','yearEndMaxDrawdown','dailyMaxDrawdown','spyDailyMaxDrawdown','beatSpyRate','positivePeriodRate','positiveYearRate','averageHoldings','averageCashWeight','averageTurnover','annualizedTurnover','finalWealth10k','spyFinalWealth10k','maxObservedStockWeight','maxObservedSectorWeight','totalBuys','totalAdds','totalSells','totalThesisSells','totalRotations','totalHardCapTrims','totalTransactionCost'];
  return Object.fromEntries(keys.filter(k=>x[k]!==undefined).map(k=>[k,x[k]]));
}
function compactStrategy(x){
  if(!x||typeof x!=='object')return null;
  const configKeys=['name','topN','minAlpha','minExpectedCAGR','maxRank','sellExpectedCAGR','maxInitialWeight','initialDeploymentCap','sectorPurchaseCap','hardHoldingCap','sellPolicy','transactionCostBps','reviewFrequency','philosophy'];
  const out=Object.fromEntries(configKeys.filter(k=>x[k]!==undefined).map(k=>[k,x[k]]));
  Object.assign(out,compactPeriodStats(x));
  if(x.development)out.development=compactPeriodStats(x.development);
  if(x.validation)out.validation=compactPeriodStats(x.validation);
  if(x.sellReasons)out.sellReasons=x.sellReasons;
  if(x.sellDecisionAudit){
    const a=x.sellDecisionAudit;
    out.sellDecisionAudit={};
    for(const k of ['sellCount','auditedSells','missedWinnerRate','meanSoldVsSpy','meanReplacementVsSold','medianSoldVsSpy','medianReplacementVsSold','byHorizon'])if(a[k]!==undefined)out.sellDecisionAudit[k]=a[k];
  }
  return out;
}
function compactLab(lab){
  if(!lab||typeof lab!=='object')return lab||null;
  const out={};
  for(const k of ['description','developmentYears','validationYears'])if(lab[k]!==undefined)out[k]=lab[k];
  if(Array.isArray(lab.challengers))out.challengers=lab.challengers.map(compactStrategy);
  return out;
}
function buildBacktestSummary(output){
  const p=output.portfolioSimulation||{};
  return {
    generatedAt:output.generatedAt,modelVersion:output.modelVersion,backtestMode:output.backtestMode,frequency:output.frequency,
    requestedStartYear:output.requestedStartYear,startYear:output.startYear,effectiveStartYear:output.effectiveStartYear,effectiveStartDate:output.effectiveStartDate,endYear:output.endYear,
    assumptions:output.assumptions,observations:output.observations,historicalUniverse:output.historicalUniverse,diagnostics:output.diagnostics,
    summary1Y:output.summary1Y,summary3Y:output.summary3Y,summary5Y:output.summary5Y,
    challengerLab:output.challengerLab,longTermOwnerLab:output.longTermOwnerLab,
    portfolioSimulation:{
      description:p.description,thesisHoldRules:p.thesisHoldRules,robustness:p.robustness,
      strategies:(p.strategies||[]).map(compactStrategy),thesisHoldStrategies:(p.thesisHoldStrategies||[]).map(compactStrategy),
      sellHoldLab:compactLab(p.sellHoldLab),sellRotateLab:compactLab(p.sellRotateLab),portfolioConstructionLab:compactLab(p.portfolioConstructionLab),
      cohortStrategies:(p.cohortStrategies||[]).map(x=>({name:x.name,cohortCount:x.cohortCount,meanPortfolioReturn:x.meanPortfolioReturn,meanSpyReturn:x.meanSpyReturn,meanExcess:x.meanExcess,beatSpyRate:x.beatSpyRate})),
      parameterStability:p.parameterStability?{description:p.parameterStability.description,portfolioSizes:p.parameterStability.portfolioSizes,cagrGates:p.parameterStability.cagrGates,rankCaps:p.parameterStability.rankCaps,cellCount:p.parameterStability.cellCount,positiveValidationRate:p.parameterStability.positiveValidationRate,medianValidationExcess:p.parameterStability.medianValidationExcess}:null,
      contributionRobustness:p.contributionRobustness
    }
  };
}

function buildSignalAnalysis(rows){
  const horizons=[1,3,5];
  const metrics=['expectedAlpha','investmentScore','qualityScore','moatScore','capitalAllocationScore','compounderScore','growthQualityScore','pricingPowerScore','protectionScore','forecastConfidence','valuationConfidence','marginOfSafety'];
  const byHorizon={};
  for(const n of horizons){
    byHorizon[n]={
      overall:outcomeStats(rows,n),
      alphaBuckets:groupedOutcome(rows,r=>alphaBucket(r.expectedAlpha),n),
      rankDeciles:groupedOutcome(rows,r=>`D${Math.min(10,Math.max(1,Math.ceil((r.rank/r.universeSize)*10)))}`,n).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1))),
      ratings:groupedOutcome(rows,r=>r.rating,n),
      metrics:Object.fromEntries(metrics.map(m=>[m,scoreDeciles(rows,m,n)])),
      alphaRank:groupedOutcome(rows,r=>{const a=finite(r.expectedAlpha);if(a==null)return null;const ab=a>=.10?'Alpha >=10%':a>=.05?'Alpha 5-10%':a>=0?'Alpha 0-5%':'Alpha <0%';const rd=Math.min(10,Math.max(1,Math.ceil((r.rank/r.universeSize)*10)));const rb=rd<=2?'Top 20% rank':rd<=5?'Rank 21-50%':'Bottom 50% rank';return `${ab} | ${rb}`;},n),
      alphaQualityConfidence:groupedOutcome(rows,r=>{const a=finite(r.expectedAlpha),q=finite(r.qualityScore),fc=finite(r.forecastConfidence),vc=finite(r.valuationConfidence);if([a,q,fc,vc].some(x=>x==null))return null;return a>=.05&&q>=75&&fc>=75&&vc>=70?'Alpha>=5 + Q>=75 + Conf strong':a>=.05?'Alpha>=5 other':'Alpha<5';},n),
      byCohort:groupedOutcome(rows,r=>String(r.asOf||'').slice(0,4),n).sort((a,b)=>a.bucket.localeCompare(b.bucket))
    };
  }
  return {description:'Point-in-time signal validation. Excess return is realized split/dividend-adjusted stock total-return CAGR minus SPY total-return CAGR over the same horizon.',byHorizon,scoreGeneralization1Y:buildScoreGeneralization(rows,1)};
}

async function main(){
  fs.mkdirSync(path.join(__dirname,'data'),{recursive:true});
  const dates=snapshotDates();
  console.log(`Loading point-in-time Russell 1000 proxy membership from historical IWB holdings for ${dates.length} snapshot dates...`);
  const historicalUniverse=await buildHistoricalUniverse(dates);
  const universe=LIMIT?historicalUniverse.union.slice(0,LIMIT):historicalUniverse.union;
  console.log(`Historical core backtest: ${universe.length} unique historical/current tickers across ${dates.length} ${FREQUENCY} dates (${dates[0]} to ${dates.at(-1)}).`);
  console.log('Historical analyst estimates are intentionally excluded to avoid look-ahead bias.');
  console.log('Historical universe coverage:', JSON.stringify(historicalUniverse.coverage));
  const spyHistory=await fetchBacktestHistory('SPY',HISTORY_YEARS);
  if(!spyHistory.length) throw new Error('SPY historical price history was empty; cannot benchmark backtest.');
  const snapshots=new Map(dates.map(d=>[d,[]])); const errors=[]; const historyByTicker=new Map();
  const diagnostics={
    tickerDateAttempts:0,tickersFetched:0,tickerFetchFailures:0,
    usableFinancialHistory:0,insufficientFinancialHistory:0,
    historicalPriceFound:0,missingHistoricalPrice:0,
    shareCountFound:0,missingShareCount:0,
    modelRuns:0,modelFailures:0,missingExpectedCAGR:0,modeledObservations:0
  };
  const skipExamples=[];
  for(let i=0;i<universe.length;i++){
    const {ticker,sector}=universe[i];
    try{
      const sec=normalizeSecTicker(ticker);
      const [facts,submissions,history]=await Promise.all([fetchSecFacts(sec),fetchSecSubmissions(sec).catch(()=>null),fetchBacktestHistory(sec,HISTORY_YEARS)]);
      historyByTicker.set(ticker,history);
      diagnostics.tickersFetched++;
      if(!history.length && skipExamples.length<20) skipExamples.push({ticker,reason:'empty_stooq_history'});
      for(const asOf of dates){
        const membership=historicalUniverse.byDate.get(asOf);
        if(!membership?.has(ticker))continue;
        diagnostics.tickerDateAttempts++;
        const before={...diagnostics};
        const asOfSector=membership.get(ticker)?.sector||sector;
        const stock=historicalStockFromData(ticker,asOfSector,facts,history,asOf,diagnostics);
        if(stock){ const meta=classifyCompanyMetadata(facts,submissions,asOfSector); stock.name=meta.name||ticker; stock.industry=meta.industry; stock.sic=meta.sic; stock.isBiopharma=meta.isBiopharma; }
        if(!stock){
          if(skipExamples.length<20){
            let reason='historical_stock_unavailable';
            if(diagnostics.insufficientFinancialHistory>before.insufficientFinancialHistory) reason='insufficient_financial_history';
            else if(diagnostics.missingHistoricalPrice>before.missingHistoricalPrice) reason='missing_historical_price';
            else if(diagnostics.missingShareCount>before.missingShareCount) reason='missing_share_count';
            skipExamples.push({ticker,asOf,reason});
          }
          continue;
        }
        try{
          diagnostics.modelRuns++;
          const f=buildForecast(stock),q=computeQuality(stock,f),v=valuate(stock,f,q),d=rateStock(stock,f,q,v);
          if(!Number.isFinite(v.expectedCAGR)){ diagnostics.missingExpectedCAGR++; if(skipExamples.length<20)skipExamples.push({ticker,asOf,reason:'missing_expected_cagr'}); continue; }
          const row=compactModel(stock,f,q,v,d); attachRealized(row,history,spyHistory,asOf); snapshots.get(asOf).push(row); diagnostics.modeledObservations++;
        }catch(e){diagnostics.modelFailures++;errors.push({ticker,asOf,error:e.message}); if(skipExamples.length<20)skipExamples.push({ticker,asOf,reason:'model_failure',error:e.message});}
      }
    }catch(e){diagnostics.tickerFetchFailures++;errors.push({ticker,error:e.message}); if(skipExamples.length<20)skipExamples.push({ticker,reason:'ticker_fetch_failure',error:e.message});}
    if((i+1)%25===0){
      console.log(`Fetched ${i+1}/${universe.length}; modeled ${diagnostics.modeledObservations} point-in-time observations.`);
      console.log(`  diagnostics: attempts=${diagnostics.tickerDateAttempts}, financials=${diagnostics.usableFinancialHistory}, prices=${diagnostics.historicalPriceFound}, shares=${diagnostics.shareCountFound}, modelRuns=${diagnostics.modelRuns}, failures=${diagnostics.modelFailures}`);
    }
    if(RATE_LIMIT_DELAY_MS>0)await sleep(RATE_LIMIT_DELAY_MS);
  }
  console.log('Backtest diagnostics:', JSON.stringify(diagnostics));
  if(skipExamples.length) console.log('Representative skips:', JSON.stringify(skipExamples.slice(0,10)));
  const flat=[]; const snapshotOutput=[];
  for(const asOf of dates){const rows=snapshots.get(asOf);rank(rows);flat.push(...rows.map(r=>({...r,asOf})));snapshotOutput.push({asOf,count:rows.length,rows});}
  const longTermOwnerLab=buildLongTermOwnerLab(flat,snapshotOutput,historyByTicker,spyHistory);
  const output={
    generatedAt:new Date().toISOString(),modelVersion:MODEL_VERSION,backtestMode:'historical_core_point_in_time',frequency:FREQUENCY,requestedStartYear:START,startYear:historicalUniverse.effectiveStart||START,effectiveStartYear:historicalUniverse.effectiveStart||START,effectiveStartDate:historicalUniverse.effectiveStartDate||`${historicalUniverse.effectiveStart||START}-01-01`,endYear:END,
    assumptions:{analystEstimates:'excluded_historical_unavailable',universe:'historical_iwb_holdings_required_fail_closed_no_current_watchlist_fallback',returns:'Yahoo adjusted-close total return where available; Stooq price-only fallback is explicitly flagged',benchmark:'SPY adjusted-close total return',valuationPrice:'raw historical close',secCutoff:'facts must be filed by as-of date'},
    observations:flat.length,longTermOwnerLab,historicalUniverse:{provider:historicalUniverse.provider||'SEC N-PORT / IWB',coverage:historicalUniverse.coverage,uniqueTickers:historicalUniverse.union.length,note:'Point-in-time IWB membership is required for every snapshot. SEC N-PORT supplies historical CUSIPs; OpenFIGI maps those CUSIPs to historical/current equity symbols. No current-watchlist membership fallback is permitted. Residual bias can remain for identifiers OpenFIGI cannot resolve or price histories unavailable from free sources.'},diagnostics,skipExamples,summary1Y:summarize(flat,'realized1YTotalReturnCAGR'),summary3Y:summarize(flat,'realized3YTotalReturnCAGR'),summary5Y:summarize(flat,'realized5YTotalReturnCAGR'),signalAnalysis:buildSignalAnalysis(flat),predictivePowerLab:buildPredictivePowerLab(flat,1),challengerLab:buildChallengerLab(flat,1),portfolioSimulation:buildPortfolioSimulation(snapshotOutput,historyByTicker,spyHistory),errors:errors.slice(0,500),snapshots:snapshotOutput
  };
  const p=path.join(__dirname,'data','backtest-results.json'),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(output));fs.renameSync(tmp,p);
  const summary=buildBacktestSummary(output),sp=path.join(__dirname,'data','backtest-summary.json'),stmp=sp+'.tmp';fs.writeFileSync(stmp,JSON.stringify(summary,null,2));fs.renameSync(stmp,sp);
  console.log(`Done. Wrote ${flat.length} historical observations to data/backtest-results.json.`);
  console.log(`Wrote compact analysis output to data/backtest-summary.json (${(fs.statSync(sp).size/1024).toFixed(1)} KiB).`);
}
if(require.main===module) main().catch(e=>{console.error(e);process.exit(1);});
module.exports={factsAsOf,priceOnOrBefore,totalReturnCAGR,snapshotDates,parseNportHoldingsXml,accessionFromHit,parseSecSeriesAtom,chooseOpenFigiTicker,mapCusipsToTickers,buildHistoricalUniverse,historicalStockFromData,alphaBucket,summarize,buildSignalAnalysis,portfolioStats,adjustedReturnBetween,equalWeightTurnover,endWeightsFromReturns,dailyPortfolioRisk,simulateInvestablePortfolio,simulateThesisHoldPortfolio,thesisSellReason,winnerMomentum,trailingAdjustedReturn,thesisEntryEligible,thesisTargetWeight,forwardCAGRFromSignal,replacementBasketCAGR,buildSellDecisionAudit,simulateOneYearCohorts,contributionConcentration,leaveWinnersOut,buildParameterStability,monotonicitySummary,buildScoreGeneralization,buildPredictivePowerLab,buildLongTermOwnerLab,buildOwnerRobustnessAudit,buildOwnerExitLab,buildOwnerAlphaExitLab,ownerAlphaRulePass,ownerAlphaExitSignal,summarizeOwnerExitEvaluations,buildOwnerWeightingLab,fixedHoldCohorts,buildPortfolioSimulation,economicSecurityGroup,dedupeEconomicSecurities,ownerValuationEntryEligible,ownerDynamicEntryEligible,dynamicMosProfile,buildDynamicMosEntryLab};
