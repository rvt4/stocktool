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
  fetchSecFacts, parseAnnualFinancials, parseQuarterlyRevenue, recentQuarterYoYGrowth,
  blendedForwardGrowth, fetchBacktestHistory, latestDilutedSharesFromFacts,
  normalizeHistoryForCorporateAction, normalizeSecTicker
}=require('./data-fetchers');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');

const MODEL_VERSION='simple-v12.29-thesis-hold-portfolio';
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
function addMonths(date,months){const d=new Date(date+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+months);return d.toISOString().slice(0,10);}

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
  ticker:stock.ticker,sector:stock.sector,price:stock.price.current,rating:d.rating,
  investmentScore:d.investmentScore,expectedCAGR:v.expectedCAGR,expectedAlpha:d.expectedAlpha,
  fiveYearExpectedCAGR:v.fiveYearExpectedCAGR,bearCAGR:v.bearCAGR,bullCAGR:v.bullCAGR,
  fairValue:v.fairValueEstimate,buyPrice:v.requiredReturnBuyPrice,marginOfSafety:v.marginOfSafety,
  qualityScore:q.qualityScore,moatScore:q.moatScore,pricingPowerScore:q.pricingPowerScore,
  capitalAllocationScore:q.capitalAllocationScore,compounderScore:q.compounderScore,growthQualityScore:q.growthQualityScore,
  protectionScore:q.protectionScore,forecastConfidence:f.forecastReliabilityScore,
  valuationConfidence:v.valuationConfidenceScore,methodAgreement:v.methodAgreementScore,
  methodCount:(v.methods||[]).length,independentEvidenceFamilies:v.independentMethodCount,
  modelSupport:v.modelSupport
};}
function rank(rows){const s=[...rows].sort((a,b)=>(b.investmentScore||0)-(a.investmentScore||0));s.forEach((x,i)=>x.rank=i+1);rows.forEach(x=>x.universeSize=rows.length);}
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
function dailyPortfolioRisk(tickers,startDate,endDate,historyByTicker,spyHistory){
  const series=[];
  for(const ticker of tickers){
    const h=historyByTicker.get(ticker)||[];
    const start=seriesPointOnOrAfter(h,addDays(startDate,1));
    if(!(finite(start?.adjustedClose)>0))continue;
    const points=(h||[]).filter(p=>p.date>=start.date&&p.date<=addDays(endDate,7)&&finite(p.adjustedClose)>0);
    if(points.length<2)continue;
    series.push({ticker,startPx:finite(start.adjustedClose),byDate:new Map(points.map(p=>[p.date,finite(p.adjustedClose)]))});
  }
  const spyStart=seriesPointOnOrAfter(spyHistory,addDays(startDate,1)),spyStartPx=finite(spyStart?.adjustedClose);
  const spyEnd=seriesPointOnOrAfter(spyHistory,addDays(endDate,1));
  const dates=(spyHistory||[]).filter(p=>p.date>=(spyStart?.date||startDate)&&p.date<=(spyEnd?.date||endDate)&&finite(p.adjustedClose)>0).map(p=>p.date);
  if(!series.length||!(spyStartPx>0)||!dates.length)return null;
  let peak=1,maxDrawdown=0,spyPeak=1,spyMaxDrawdown=0,lastVals=new Map();
  for(const date of dates){
    const ratios=[];
    for(const s of series){const px=s.byDate.get(date);if(px>0)lastVals.set(s.ticker,px);const use=lastVals.get(s.ticker);if(use>0)ratios.push(use/s.startPx);}
    if(!ratios.length)continue;
    const wealth=mean(ratios);peak=Math.max(peak,wealth);maxDrawdown=Math.min(maxDrawdown,wealth/peak-1);
    const spy=priceOnOrBefore(spyHistory,date,5,'adjustedClose');if(spy>0){const sw=spy/spyStartPx;spyPeak=Math.max(spyPeak,sw);spyMaxDrawdown=Math.min(spyMaxDrawdown,sw/spyPeak-1);}
  }
  return {dailyMaxDrawdown:maxDrawdown,spyDailyMaxDrawdown:spyMaxDrawdown,seriesCount:series.length};
}
function eligibleForStrategy(snap,{topN=20,minAlpha=.10,requireTopRank=false}={}){
  return (snap?.rows||[])
    .filter(r=>Number.isFinite(r.expectedAlpha))
    .filter(r=>r.expectedAlpha>=minAlpha)
    .filter(r=>!requireTopRank||r.rank<=Math.ceil((r.universeSize||snap.rows.length)*.20))
    .sort((a,b)=>(a.rank||Infinity)-(b.rank||Infinity))
    .slice(0,topN);
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
    periods.push({
      asOf:snap.asOf,startDate:snap.asOf,endDate,startTradeDate:commonStart||spy.startTradeDate,endTradeDate:commonEnd||spy.endTradeDate,
      startYear:Number(String(snap.asOf).slice(0,4)),holdings:tickers.length,tickers,
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
  stats.totalTransactionCost=periods.reduce((a,y)=>a+(y.transactionCost||0),0);
  return {name,topN,minAlpha,requireTopRank,transactionCostBps,rebalanceFrequency:FREQUENCY,...stats};
}

function isBuyRating(r){return ['Buy','Strong Buy','Exceptional Buy'].includes(String(r?.rating||''));}
function thesisSellReason(current,entry,{sellExpectedCAGR=.08}={}){
  if(!current)return 'universe_or_model_exit';
  if(String(current.modelSupport||'')==='unsupported')return 'model_support_lost';
  if(Number.isFinite(current.expectedCAGR)&&current.expectedCAGR<sellExpectedCAGR)return 'forward_return_below_hold_floor';
  const q0=finite(entry?.qualityScore),q=finite(current.qualityScore);
  if(q0!=null&&q!=null&&q<60&&q<=q0-15)return 'quality_thesis_deteriorated';
  const p0=finite(entry?.protectionScore),pr=finite(current.protectionScore);
  if(p0!=null&&pr!=null&&pr<50&&pr<=p0-20)return 'protection_thesis_deteriorated';
  if(Number.isFinite(current.forecastConfidence)&&current.forecastConfidence<40)return 'forecast_support_deteriorated';
  return null;
}
function thesisBuyCandidates(snap,held,{minAlpha=.10}={}){
  return (snap?.rows||[]).filter(r=>!held.has(r.ticker)&&isBuyRating(r)&&Number.isFinite(r.expectedAlpha)&&r.expectedAlpha>=minAlpha)
    .sort((a,b)=>(a.rank||Infinity)-(b.rank||Infinity));
}
function simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name='Thesis hold',topN=20,minAlpha=.10,sellExpectedCAGR=.08,transactionCostBps=10}={}){
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  let weights=new Map(),entries=new Map(),cash=1,totalSells=0,totalBuys=0,holdingQuarterSum=0,closedHolds=0;
  const periods=[],sellReasons={};
  for(let i=0;i<snaps.length;i++){
    const snap=snaps[i],next=snaps[i+1]; if(!next)break;
    const rowMap=new Map((snap.rows||[]).map(r=>[r.ticker,r]));
    let turnover=0,freed=0,sells=[];
    // Existing positions are reviewed, not mechanically reranked. Missing membership/model
    // is treated as an exit because the historical strategy can no longer verify the thesis.
    for(const [t,w] of [...weights]){
      const reason=thesisSellReason(rowMap.get(t),entries.get(t),{sellExpectedCAGR});
      if(reason){weights.delete(t);freed+=w;turnover+=w;sells.push({ticker:t,reason});sellReasons[reason]=(sellReasons[reason]||0)+1;totalSells++;const e=entries.get(t);if(e){holdingQuarterSum+=i-e.snapshotIndex;closedHolds++;}entries.delete(t);}
    }
    cash+=freed;
    const vacancies=Math.max(0,topN-weights.size),cands=thesisBuyCandidates(snap,new Set(weights.keys()),{minAlpha}).slice(0,vacancies);
    if(cands.length&&cash>0){const each=cash/cands.length;for(const r of cands){weights.set(r.ticker,each);entries.set(r.ticker,{...r,snapshotIndex:i,entryAsOf:snap.asOf});turnover+=each;totalBuys++;}cash=0;}
    // If fewer than topN qualifying ideas exist, residual capital stays in cash rather than
    // weakening the purchase hurdle simply to remain fully invested.
    const stockReturns=new Map(); let commonStart=null,commonEnd=null;
    for(const [t] of weights){const x=adjustedReturnBetween(historyByTicker.get(t)||[],snap.asOf,next.asOf,{executeAfterStart:true});if(x){stockReturns.set(t,x.return);commonStart=commonStart||x.startTradeDate;commonEnd=commonEnd||x.endTradeDate;}}
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,next.asOf,{executeAfterStart:true});if(!spy)continue;
    let grossReturn=0,endTotal=cash;
    for(const [t,w] of weights){const rr=stockReturns.get(t);const end=w*(1+(Number.isFinite(rr)?rr:0));grossReturn+=w*(Number.isFinite(rr)?rr:0);weights.set(t,end);endTotal+=end;}
    if(endTotal>0){for(const [t,w] of weights)weights.set(t,w/endTotal);cash/=endTotal;}
    const transactionCost=turnover*(transactionCostBps/10000),portfolioReturn=grossReturn-transactionCost;
    const risk=dailyPortfolioRisk([...weights.keys()],snap.asOf,next.asOf,historyByTicker,spyHistory);
    periods.push({asOf:snap.asOf,startDate:snap.asOf,endDate:next.asOf,startTradeDate:commonStart||spy.startTradeDate,endTradeDate:commonEnd||spy.endTradeDate,startYear:Number(snap.asOf.slice(0,4)),holdings:weights.size,tickers:[...weights.keys()],cashWeight:cash,grossReturn,portfolioReturn,spyReturn:spy.return,excessReturn:portfolioReturn-spy.return,turnover,transactionCost,transactionCostBps,buys:cands.map(r=>r.ticker),sells,dailyMaxDrawdown:risk?.dailyMaxDrawdown??null});
  }
  const stats=portfolioStats(periods,{periodsPerYear:4});
  stats.dailyMaxDrawdown=periods.map(x=>x.dailyMaxDrawdown).filter(Number.isFinite).reduce((m,x)=>Math.min(m,x),0);
  stats.averageTurnover=mean(periods.map(x=>x.turnover));stats.annualizedTurnover=stats.averageTurnover*4;stats.totalBuys=totalBuys;stats.totalSells=totalSells;stats.sellReasons=sellReasons;stats.averageClosedHoldingYears=closedHolds?holdingQuarterSum/closedHolds/4:null;stats.endingHoldings=weights.size;stats.endingCashWeight=cash;
  return {name,topN,minAlpha,sellExpectedCAGR,transactionCostBps,reviewFrequency:FREQUENCY,philosophy:'buy_strict_hold_loose_sell_on_return_or_thesis_break',...stats};
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
function buildPortfolioSimulation(snapshotOutput,historyByTicker,spyHistory){
  const rules=[
    {name:'Top 10 · Alpha ≥10%',topN:10,minAlpha:.10},
    {name:'Top 20 · Alpha ≥10%',topN:20,minAlpha:.10},
    {name:'Top 30 · Alpha ≥10%',topN:30,minAlpha:.10},
    {name:'Top 20 rank · no Alpha gate',topN:20,minAlpha:-10}
  ];
  const transactionCostBps=Math.max(0,finite(process.env.BACKTEST_TRANSACTION_COST_BPS)??10);
  const strategies=rules.map(x=>simulateInvestablePortfolio(snapshotOutput,historyByTicker,spyHistory,{...x,transactionCostBps}));
  for(const s of strategies){
    s.development=periodStats(s,2019,2021);
    s.validation=periodStats(s,2022,2025);
  }
  const cohortStrategies=rules.map(x=>simulateOneYearCohorts(snapshotOutput,x));
  const thesisHoldStrategies=[10,20,30].map(topN=>simulateThesisHoldPortfolio(snapshotOutput,historyByTicker,spyHistory,{name:`Thesis hold · max ${topN}`,topN,minAlpha:.10,sellExpectedCAGR:.08,transactionCostBps}));
  for(const s of thesisHoldStrategies){s.development=periodStats(s,2019,2021);s.validation=periodStats(s,2022,2025);}
  return {
    description:`Chronological ${FREQUENCY} portfolio tests. Mechanical strategies rebalance each snapshot. Thesis-hold strategies buy only qualifying Buy/Strong Buy/Exceptional Buy names with Alpha >=10%, then keep them through rerankings until expected CAGR falls below 8% or model evidence indicates material thesis deterioration. Trades execute after the snapshot and ${transactionCostBps} bp one-way costs are charged.`,
    thesisHoldRules:{buy:'Buy/Strong Buy/Exceptional Buy + expected Alpha >=10%; fill only open slots by rank',hold:'Do not sell merely because rank changes or a better-ranked stock appears',valuationSell:'Expected CAGR <8%',fundamentalSell:'Model support lost, quality falls >=15 points to <60, protection falls >=20 points to <50, or forecast confidence <40',cash:'If no qualifying replacement exists, proceeds remain in cash',reviewFrequency:FREQUENCY},
    robustness:{development:'2019-2021 review periods',validation:'2022-2025 review periods',survivorship:'Point-in-time IWB holdings are required for every historical snapshot. No current-watchlist fallback is permitted.',execution:'First trading day after each snapshot; no same-close execution.',transactionCosts:`${transactionCostBps} bp × one-way turnover.`},
    strategies,thesisHoldStrategies,cohortStrategies
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
  return {description:'Point-in-time signal validation. Excess return is realized split/dividend-adjusted stock total-return CAGR minus SPY total-return CAGR over the same horizon.',byHorizon};
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
      const [facts,history]=await Promise.all([fetchSecFacts(sec),fetchBacktestHistory(sec,HISTORY_YEARS)]);
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
  const output={
    generatedAt:new Date().toISOString(),modelVersion:MODEL_VERSION,backtestMode:'historical_core_point_in_time',frequency:FREQUENCY,requestedStartYear:START,startYear:historicalUniverse.effectiveStart||START,effectiveStartYear:historicalUniverse.effectiveStart||START,effectiveStartDate:historicalUniverse.effectiveStartDate||`${historicalUniverse.effectiveStart||START}-01-01`,endYear:END,
    assumptions:{analystEstimates:'excluded_historical_unavailable',universe:'historical_iwb_holdings_required_fail_closed_no_current_watchlist_fallback',returns:'Yahoo adjusted-close total return where available; Stooq price-only fallback is explicitly flagged',benchmark:'SPY adjusted-close total return',valuationPrice:'raw historical close',secCutoff:'facts must be filed by as-of date'},
    observations:flat.length,historicalUniverse:{provider:historicalUniverse.provider||'SEC N-PORT / IWB',coverage:historicalUniverse.coverage,uniqueTickers:historicalUniverse.union.length,note:'Point-in-time IWB membership is required for every snapshot. SEC N-PORT supplies historical CUSIPs; OpenFIGI maps those CUSIPs to historical/current equity symbols. No current-watchlist membership fallback is permitted. Residual bias can remain for identifiers OpenFIGI cannot resolve or price histories unavailable from free sources.'},diagnostics,skipExamples,summary1Y:summarize(flat,'realized1YTotalReturnCAGR'),summary3Y:summarize(flat,'realized3YTotalReturnCAGR'),summary5Y:summarize(flat,'realized5YTotalReturnCAGR'),signalAnalysis:buildSignalAnalysis(flat),portfolioSimulation:buildPortfolioSimulation(snapshotOutput,historyByTicker,spyHistory),errors:errors.slice(0,500),snapshots:snapshotOutput
  };
  const p=path.join(__dirname,'data','backtest-results.json'),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(output));fs.renameSync(tmp,p);
  console.log(`Done. Wrote ${flat.length} historical observations to data/backtest-results.json.`);
}
if(require.main===module) main().catch(e=>{console.error(e);process.exit(1);});
module.exports={factsAsOf,priceOnOrBefore,totalReturnCAGR,snapshotDates,parseNportHoldingsXml,accessionFromHit,parseSecSeriesAtom,chooseOpenFigiTicker,mapCusipsToTickers,buildHistoricalUniverse,historicalStockFromData,alphaBucket,summarize,buildSignalAnalysis,portfolioStats,adjustedReturnBetween,equalWeightTurnover,endWeightsFromReturns,dailyPortfolioRisk,simulateInvestablePortfolio,simulateThesisHoldPortfolio,thesisSellReason,simulateOneYearCohorts,buildPortfolioSimulation};
