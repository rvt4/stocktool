'use strict';
/**
 * v12.55 Historical Coverage Audit
 *
 * Purpose:
 *   Probe iShares' own historical IWB holdings archive before the SEC N-PORT era,
 *   save only validated point-in-time constituent snapshots, and quantify how much
 *   of that older universe can still be resolved through the free SEC ticker map.
 *
 * This script does NOT change any investment rule. It is infrastructure/audit only.
 * A pre-2019 snapshot is written only when >=500 equity tickers are returned.
 *
 * v12.55.1: iShares JSON responses may begin with a UTF-8 BOM and numeric cells
 * are often wrapped as {display,raw}. Parse both forms, record response diagnostics,
 * and reject exact duplicate holdings fingerprints across distant snapshot dates.
 *
 * v12.55.2: the legacy iShares AJAX archive now returns an HTML product page in
 * GitHub Actions. Prefer BlackRock/iShares Product Data v2 (same official IWB
 * product, explicit asOfDate), fall back across iShares + BlackRock hosts, and only
 * then probe the legacy endpoint for diagnostics. Reject any Product Data response
 * whose returned holdings date is outside the requested seven-day lookback window.
 */
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const START=Number(process.env.COVERAGE_START||2007);
const END=Math.min(2018,Number(process.env.COVERAGE_END||2018));
const FREQUENCY=String(process.env.COVERAGE_FREQUENCY||'quarterly').toLowerCase();
const DELAY_MS=Math.max(0,Number(process.env.COVERAGE_DELAY_MS||450));
const REQUEST_TIMEOUT_MS=Math.max(5000,Number(process.env.REQUEST_TIMEOUT_MS||25000));
const SEC_USER_AGENT=process.env.SEC_USER_AGENT||'FreeScreener historical-coverage-audit contact@example.com';
const IWB_ROOT='https://www.ishares.com/us/products/239707/ishares-russell-1000-etf';
const IWB_AJAX='1467271812596.ajax';
const PRODUCT_DATA_PATH='/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data';
const PRODUCT_DATA_HOSTS=['https://www.ishares.com','https://www.blackrock.com'];
const DATA_DIR=path.join(__dirname,'data');
const CACHE_DIR=path.join(DATA_DIR,'historical-universe');

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function normalizeTicker(x){return String(x||'').trim().toUpperCase().replaceAll('.','-');}
function normalizeSectorName(s){
  const x=String(s||'').trim();
  const map={'Information Technology':'Technology','Health Care':'Healthcare','Communication':'Communication Services','Communication Services':'Communication Services'};
  return map[x]||x||'Unknown';
}
function requestedDates(){
  const out=[];
  for(let y=START;y<=END;y++){
    if(FREQUENCY==='quarterly')for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);
    else out.push(`${y}-12-31`);
  }
  return out;
}
function addDays(date,delta){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
function candidateSourceDates(asOf){
  // iShares expects an actual holdings/business date. Try the requested date and
  // walk backward through the prior week so weekend/holiday quarter ends resolve.
  return Array.from({length:8},(_,i)=>addDays(asOf,-i));
}
async function fetchWithTimeout(url,options={}){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{return await fetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);}
}
function isharesCell(x){
  if(x==null)return '';
  if(typeof x==='object'){
    if(x.display!=null)return String(x.display).trim();
    if(x.raw!=null)return String(x.raw).trim();
  }
  return String(x).trim();
}
function cleanIsharesJsonText(text){
  let s=String(text||'');
  // iShares historical JSON has commonly shipped with a UTF-8 BOM. Python's
  // bytes-aware json loader tolerates it; JSON.parse on a JS string does not.
  s=s.replace(/^\uFEFF/,'').replace(/^\xEF\xBB\xBF/,'').trimStart();
  // Be defensive against a short anti-XSSI/preamble while refusing to scan an
  // arbitrary HTML page for JSON.
  if(!s.startsWith('{')&&!s.startsWith('[')){
    const obj=s.indexOf('{'),arr=s.indexOf('[');
    const candidates=[obj,arr].filter(i=>i>=0&&i<=32);
    if(candidates.length)s=s.slice(Math.min(...candidates));
  }
  return s;
}
function parseIsharesResponseText(text){
  return JSON.parse(cleanIsharesJsonText(text));
}
function parseIsharesHoldingsJson(json){
  const aa=Array.isArray(json?.aaData)?json.aaData:[];
  const rows=[],unresolved=[];
  for(const x of aa){
    if(!Array.isArray(x))continue;
    const ticker=normalizeTicker(isharesCell(x[0]));
    const name=isharesCell(x[1]);
    const sector=normalizeSectorName(isharesCell(x[2]));
    const assetClass=isharesCell(x[3]);
    const cusip=isharesCell(x[8]).toUpperCase();
    if(!/^Equity$/i.test(assetClass))continue;
    if(/^[A-Z0-9-]{1,12}$/.test(ticker)&&ticker!=='-'&&ticker!=='USD')rows.push({ticker,name,sector,cusip});
    else if(cusip&&cusip!=='-')unresolved.push({name,sector,cusip});
  }
  const holdings=[...new Map(rows.map(r=>[r.ticker,r])).values()];
  return {holdings,unresolved,rawRowCount:aa.length};
}

function productDataUrl(sourceDate,host=PRODUCT_DATA_HOSTS[0]){
  const params=new URLSearchParams({
    appType:'PRODUCT_PAGE',
    appSubType:'ISHARES',
    targetSite:'us-ishares',
    locale:'en_US',
    portfolioId:'239707',
    userType:'individual',
    component:'holdings',
    asOfDate:String(sourceDate).replaceAll('-','')
  });
  return `${host}${PRODUCT_DATA_PATH}?${params}`;
}
function productDataValues(dataPoints,name){
  const point=dataPoints&&typeof dataPoints==='object'?dataPoints[name]:null;
  if(!point||typeof point!=='object')return [];
  if(Array.isArray(point.value))return point.value;
  if(Array.isArray(point.formattedValue))return point.formattedValue;
  return [];
}
function productDataScalar(dataPoints,name){
  const point=dataPoints&&typeof dataPoints==='object'?dataPoints[name]:null;
  if(!point||typeof point!=='object')return null;
  const value=point.value??point.formattedValue;
  if(Array.isArray(value))return value[0]??null;
  return value??null;
}
function parseProductDataDate(value,fallback){
  const text=String(value??fallback??'').trim();
  if(/^\d{8}$/.test(text))return `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}`;
  const d=new Date(text);
  if(Number.isNaN(d.getTime()))throw new Error(`Product Data holdings payload missing/invalid as-of date: ${text||'(blank)'}`);
  return d.toISOString().slice(0,10);
}
function parseProductDataHoldingsJson(json,{requestedSourceDate=null}={}){
  const dataPoints=json?.componentsByNameMap?.holdings?.containersByNameMap?.all?.dataPointsByNameMap;
  if(!dataPoints||typeof dataPoints!=='object')throw new Error('Product Data payload missing holdings data points');
  const sourceAsOf=parseProductDataDate(productDataScalar(dataPoints,'asOfDate'),requestedSourceDate);
  const tickers=productDataValues(dataPoints,'ticker');
  if(!tickers.length)throw new Error('Product Data holdings payload contained no tickers');
  const names=productDataValues(dataPoints,'issueName');
  const sectors=productDataValues(dataPoints,'sectorName');
  const assetClasses=productDataValues(dataPoints,'assetClass');
  const cusips=productDataValues(dataPoints,'cusip');
  const rows=[],unresolved=[];
  for(let i=0;i<tickers.length;i++){
    const ticker=normalizeTicker(isharesCell(tickers[i]));
    const name=isharesCell(names[i]);
    const sector=normalizeSectorName(isharesCell(sectors[i]));
    const assetClass=isharesCell(assetClasses[i])||'Equity';
    const cusip=isharesCell(cusips[i]).toUpperCase();
    if(!/^Equity$/i.test(assetClass))continue;
    if(/^[A-Z0-9-]{1,12}$/.test(ticker)&&ticker!=='-'&&ticker!=='USD')rows.push({ticker,name,sector,cusip});
    else if(cusip&&cusip!=='-')unresolved.push({name,sector,cusip});
  }
  const holdings=[...new Map(rows.map(r=>[r.ticker,r])).values()];
  return {sourceAsOf,holdings,unresolved,rawRowCount:tickers.length};
}
function daysBetween(a,b){return Math.round((Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000);}
function sourceDateIsValidForRequest(requestedAsOf,sourceAsOf){
  const delta=daysBetween(requestedAsOf,sourceAsOf);
  return Number.isFinite(delta)&&delta>=0&&delta<=7;
}
function holdingsFingerprint(holdings){
  const canonical=(holdings||[]).map(h=>`${normalizeTicker(h.ticker)}|${String(h.cusip||'').toUpperCase()}`).sort().join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
function responsePrefix(text){
  return String(text||'').slice(0,160).replace(/[\r\n\t]+/g,' ').replace(/[^\x20-\x7E]/g,'?');
}
async function fetchIsharesSnapshot(asOf){
  const attempts=[];
  for(const sourceDate of candidateSourceDates(asOf)){
    // First try BlackRock/iShares' current official Product Data v2 endpoint.
    for(const host of PRODUCT_DATA_HOSTS){
      const url=productDataUrl(sourceDate,host);
      try{
        const res=await fetchWithTimeout(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; FreeScreener/12.55.2)','Accept':'application/json,text/plain,*/*','Referer':IWB_ROOT}});
        const text=await res.text();
        const attempt={source:'product_data_v2',host,sourceDate,status:res.status,bytes:Buffer.byteLength(text,'utf8'),contentType:res.headers.get('content-type')||null,prefix:responsePrefix(text)};
        attempts.push(attempt);
        if(!res.ok)continue;
        let json;
        try{json=parseIsharesResponseText(text);}catch(e){attempt.parseError=e.message;continue;}
        let parsed;
        try{parsed=parseProductDataHoldingsJson(json,{requestedSourceDate:sourceDate});}catch(e){attempt.parseError=e.message;continue;}
        attempt.returnedAsOf=parsed.sourceAsOf;
        attempt.rawRows=parsed.rawRowCount;
        attempt.equityTickers=parsed.holdings.length;
        if(!sourceDateIsValidForRequest(asOf,parsed.sourceAsOf)){
          attempt.parseError=`returned holdings date ${parsed.sourceAsOf} is outside requested lookback for ${asOf}`;
          continue;
        }
        if(parsed.holdings.length>=500){
          const fingerprint=holdingsFingerprint(parsed.holdings);
          attempt.fingerprint=fingerprint.slice(0,16);
          return {asOf,sourceAsOf:parsed.sourceAsOf,sourceKind:'blackrock_product_data_v2',status:'usable',httpStatus:res.status,fingerprint,...parsed,attempts};
        }
        attempt.parseError=`parsed ${parsed.holdings.length} tickered equities from ${parsed.rawRowCount} Product Data rows`;
      }catch(e){attempts.push({source:'product_data_v2',host,sourceDate,status:'error',error:e.message});}
      await sleep(DELAY_MS);
    }

    // Legacy endpoint retained as a diagnostic fallback. In 2026 this may return
    // a full HTML product page with HTTP 200; that is never accepted as holdings.
    const ymd=sourceDate.replaceAll('-','');
    const url=`${IWB_ROOT}/${IWB_AJAX}?fileType=json&tab=all&asOfDate=${ymd}`;
    try{
      const res=await fetchWithTimeout(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; FreeScreener/12.55.2)','Accept':'application/json,text/plain,*/*','Referer':IWB_ROOT}});
      const text=await res.text();
      const attempt={source:'legacy_ajax',sourceDate,status:res.status,bytes:Buffer.byteLength(text,'utf8'),contentType:res.headers.get('content-type')||null,prefix:responsePrefix(text)};
      attempts.push(attempt);
      if(!res.ok)continue;
      let json;
      try{json=parseIsharesResponseText(text);}catch(e){attempt.parseError=e.message;continue;}
      const parsed=parseIsharesHoldingsJson(json);
      attempt.rawRows=parsed.rawRowCount;
      attempt.equityTickers=parsed.holdings.length;
      if(parsed.holdings.length>=500){
        const fingerprint=holdingsFingerprint(parsed.holdings);
        attempt.fingerprint=fingerprint.slice(0,16);
        return {asOf,sourceAsOf:sourceDate,sourceKind:'legacy_ishares_ajax',status:'usable',httpStatus:res.status,fingerprint,...parsed,attempts};
      }
      attempt.parseError=`parsed ${parsed.holdings.length} tickered equities from ${parsed.rawRowCount} aaData rows`;
    }catch(e){attempts.push({source:'legacy_ajax',sourceDate,status:'error',error:e.message});}
    await sleep(DELAY_MS);
  }
  return {asOf,status:'unavailable',holdings:[],unresolved:[],attempts};
}

async function secTickerMap(){
  const res=await fetchWithTimeout('https://www.sec.gov/files/company_tickers.json',{headers:{'User-Agent':SEC_USER_AGENT,'Accept':'application/json'}});
  if(!res.ok)throw new Error(`SEC ticker map HTTP ${res.status}`);
  const json=await res.json(),set=new Set();
  for(const row of Object.values(json||{})){const t=normalizeTicker(row?.ticker);if(t)set.add(t);}
  return set;
}
function writeSnapshot(snapshot){
  fs.mkdirSync(CACHE_DIR,{recursive:true});
  const p=path.join(CACHE_DIR,`iwb-${snapshot.asOf}.json`),tmp=p+'.tmp';
  const payload={schemaVersion:2,provider:'BlackRock/iShares official holdings history',fund:'IWB',asOf:snapshot.asOf,sourceAsOf:snapshot.sourceAsOf,sourceType:snapshot.sourceKind||'ISHARES_ARCHIVE',count:snapshot.holdings.length,holdings:snapshot.holdings};
  fs.writeFileSync(tmp,JSON.stringify(payload));fs.renameSync(tmp,p);return p;
}
async function main(){
  if(START>END)throw new Error(`Coverage range must be <=2018 and start <= end; got ${START}-${END}`);
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const secMap=await secTickerMap();
  const coverage=[],dates=requestedDates(),fingerprints=new Map();
  console.log(`v12.55.2 historical coverage audit: probing ${dates.length} ${FREQUENCY} IWB snapshots from ${START}-${END} via Product Data v2 first.`);
  for(let i=0;i<dates.length;i++){
    const asOf=dates[i],snap=await fetchIsharesSnapshot(asOf);
    if(snap.status==='usable'){
      const prior=fingerprints.get(snap.fingerprint);
      // Exact full-universe equality across distant quarter snapshots is a strong
      // sign that iShares ignored asOfDate and returned one current response.
      if(prior){
        const days=Math.abs((Date.parse(`${asOf}T00:00:00Z`)-Date.parse(`${prior.asOf}T00:00:00Z`))/86400000);
        if(days>35){
          prior.row.status='suspicious_duplicate_response';
          prior.row.guardrailReason=`same holdings fingerprint as ${asOf}`;
          if(prior.row.cachePath){try{fs.unlinkSync(path.join(__dirname,prior.row.cachePath));}catch{} delete prior.row.cachePath;}
          coverage.push({asOf,sourceAsOf:snap.sourceAsOf,sourceKind:snap.sourceKind,status:'suspicious_duplicate_response',holdings:snap.holdings.length,fingerprint:snap.fingerprint.slice(0,16),guardrailReason:`same holdings fingerprint as ${prior.asOf}`,attempts:snap.attempts});
          console.log(`[${i+1}/${dates.length}] ${asOf}: rejected suspicious duplicate of ${prior.asOf} (${snap.holdings.length} holdings).`);
          if(DELAY_MS)await sleep(DELAY_MS);
          continue;
        }
      }
      const secResolvable=snap.holdings.filter(h=>secMap.has(normalizeTicker(h.ticker))).length;
      const cachePath=writeSnapshot(snap);
      const row={asOf,sourceAsOf:snap.sourceAsOf,sourceKind:snap.sourceKind,status:'usable',holdings:snap.holdings.length,fingerprint:snap.fingerprint.slice(0,16),unresolvedRows:snap.unresolved.length,secTickerResolvable:secResolvable,secTickerResolvableRate:secResolvable/snap.holdings.length,cachePath:path.relative(__dirname,cachePath),attempts:snap.attempts};
      coverage.push(row); fingerprints.set(snap.fingerprint,{asOf,row});
      console.log(`[${i+1}/${dates.length}] ${asOf}: ${snap.holdings.length} holdings from ${snap.sourceAsOf}; current SEC ticker-map coverage ${(100*secResolvable/snap.holdings.length).toFixed(1)}%.`);
    }else{
      coverage.push({asOf,status:'unavailable',holdings:0,attempts:snap.attempts});
      const last=snap.attempts.at(-1);
      console.log(`[${i+1}/${dates.length}] ${asOf}: unavailable${last?.parseError?` (${last.parseError})`:''}.`);
    }
    if(DELAY_MS)await sleep(DELAY_MS);
  }
  const usable=coverage.filter(x=>x.status==='usable');
  let firstContinuous=null;
  for(let i=0;i<coverage.length;i++)if(coverage.slice(i).every(x=>x.status==='usable')){firstContinuous=coverage[i].asOf;break;}
  const report={generatedAt:new Date().toISOString(),version:'v12.55.2-historical-coverage-audit',requested:{startYear:START,endYear:END,frequency:FREQUENCY},source:{provider:'BlackRock/iShares official holdings history',fund:'IWB',archiveEndpointPattern:'Product Data v2 first; legacy iShares AJAX diagnostic fallback',pointInTime:true},guardrails:['No current-constituent fallback.','A snapshot is cached only with >=500 equity tickers.','Weekend/holiday snapshot dates may use the nearest prior holdings date within seven calendar days.','SEC ticker-map resolvability is diagnostic only; it does not silently substitute securities.','Product Data responses are accepted only when the returned as-of date is within the requested seven-day lookback window.','Exact duplicate full-holdings fingerprints across distant snapshots are rejected as likely asOfDate failures.'],summary:{requestedSnapshots:coverage.length,usableSnapshots:usable.length,usableRate:coverage.length?usable.length/coverage.length:null,firstUsable:usable[0]?.asOf||null,lastUsable:usable.at(-1)?.asOf||null,firstContinuousThroughEnd:firstContinuous,meanHoldings:usable.length?usable.reduce((a,x)=>a+x.holdings,0)/usable.length:null,meanCurrentSecTickerResolvableRate:usable.length?usable.reduce((a,x)=>a+x.secTickerResolvableRate,0)/usable.length:null,minCurrentSecTickerResolvableRate:usable.length?Math.min(...usable.map(x=>x.secTickerResolvableRate)):null},coverage};
  const p=path.join(DATA_DIR,'historical-coverage-audit.json'),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2));fs.renameSync(tmp,p);
  console.log(`Wrote ${path.relative(__dirname,p)}. Usable ${usable.length}/${coverage.length}; first continuous=${firstContinuous||'none'}.`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});
module.exports={normalizeTicker,requestedDates,candidateSourceDates,cleanIsharesJsonText,parseIsharesResponseText,parseIsharesHoldingsJson,productDataUrl,parseProductDataHoldingsJson,sourceDateIsValidForRequest,holdingsFingerprint,fetchIsharesSnapshot};
