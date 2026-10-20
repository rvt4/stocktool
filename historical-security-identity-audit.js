'use strict';
/**
 * v12.55.3 Historical Security Identity Audit
 *
 * Enriches validated pre-2019 IWB cache rows with stable SEC CIKs where they can
 * be resolved without using today's constituents as a membership fallback.
 * Membership remains the point-in-time iShares snapshot; today's SEC map is only
 * an identity bridge. CUSIPs are also mapped through OpenFIGI to catch ticker
 * changes that still lead to a currently resolvable SEC registrant.
 */
const fs=require('fs');
const path=require('path');
const CACHE_DIR=path.join(__dirname,'data','historical-universe');
const OUT=path.join(__dirname,'data','historical-security-identity.json');
const SEC_USER_AGENT=process.env.SEC_USER_AGENT||'FreeScreener historical identity audit contact@example.com';
const DELAY=Math.max(0,Number(process.env.IDENTITY_DELAY_MS||350));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const norm=x=>String(x||'').trim().toUpperCase().replaceAll('.','-');
const validTicker=x=>/^[A-Z0-9-]{1,12}$/.test(norm(x))&&!['','-','USD'].includes(norm(x));
async function fetchJson(url,options={},label='request'){
  let err;
  for(let a=0;a<6;a++){
    const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),30000);
    try{
      const r=await fetch(url,{...options,signal:ac.signal});
      const text=await r.text();
      if(r.ok)return JSON.parse(text.replace(/^\uFEFF/,''));
      err=new Error(`${label} HTTP ${r.status}`);
      if(![429,500,502,503,504].includes(r.status))throw err;
    }catch(e){err=e;}finally{clearTimeout(timer);}
    await sleep(Math.min(12000,1000*Math.pow(2,a)));
  }
  throw err||new Error(`${label} failed`);
}
async function secMap(){
  const j=await fetchJson('https://www.sec.gov/files/company_tickers.json',{headers:{'User-Agent':SEC_USER_AGENT,'Accept':'application/json'}},'SEC ticker map');
  const m=new Map();
  for(const r of Object.values(j||{})){
    const t=norm(r?.ticker),c=Number(r?.cik_str);
    if(t&&Number.isFinite(c))m.set(t,String(c).padStart(10,'0'));
  }
  return m;
}
function chooseFigi(row){
  const bad=/future|option|warrant|swap|forward|right|preferred|convertible|bond|note|debt|fund|etf|etn/i;
  const good=/common stock|ordinary share|reit|depositary receipt|adr|gdr/i;
  const rows=(row?.data||[]).filter(x=>validTicker(x?.ticker)&&String(x?.marketSector||'').toLowerCase()==='equity'&&!bad.test(String(x?.securityType2||x?.securityType||'')));
  rows.sort((a,b)=>((good.test(String(b?.securityType2||b?.securityType||''))?5:0)+(String(b?.exchCode||'').toUpperCase()==='US'?3:0))-((good.test(String(a?.securityType2||a?.securityType||''))?5:0)+(String(a?.exchCode||'').toUpperCase()==='US'?3:0)));
  return rows[0]?norm(rows[0].ticker):null;
}
async function figiMap(cusips){
  const key=String(process.env.OPENFIGI_API_KEY||'').trim(),size=key?100:10,out=new Map();
  for(let i=0;i<cusips.length;i+=size){
    const batch=cusips.slice(i,i+size);
    const headers={'Content-Type':'application/json','Accept':'application/json'};if(key)headers['X-OPENFIGI-APIKEY']=key;
    let data=null,err=null;
    for(let a=0;a<6;a++){
      try{
        const r=await fetch('https://api.openfigi.com/v3/mapping',{method:'POST',headers,body:JSON.stringify(batch.map(idValue=>({idType:'ID_CUSIP',idValue})))});
        const text=await r.text();
        if(r.ok){data=JSON.parse(text);break;}
        err=new Error(`OpenFIGI HTTP ${r.status}`);
        const reset=Number(r.headers.get('ratelimit-reset')||r.headers.get('retry-after'));
        await sleep(Number.isFinite(reset)&&reset>0?reset*1000:Math.min(15000,1500*Math.pow(2,a)));
      }catch(e){err=e;await sleep(Math.min(15000,1500*Math.pow(2,a)));}
    }
    if(!data)throw err||new Error('OpenFIGI mapping failed');
    batch.forEach((c,j)=>{const t=chooseFigi(data[j]);if(t)out.set(c,t);});
    console.log(`OpenFIGI identity mapping ${Math.min(i+size,cusips.length)}/${cusips.length}; resolved=${out.size}.`);
    if(DELAY)await sleep(DELAY);
  }
  return out;
}
async function main(){
  if(!fs.existsSync(CACHE_DIR))throw new Error('data/historical-universe is missing. Run Historical Coverage Audit first.');
  const files=fs.readdirSync(CACHE_DIR).filter(x=>/^iwb-20(0[7-9]|1[0-8])-\d\d-\d\d\.json$/.test(x)).sort();
  if(!files.length)throw new Error('No validated pre-2019 IWB cache files found.');
  const snaps=files.map(file=>({file,j:JSON.parse(fs.readFileSync(path.join(CACHE_DIR,file),'utf8'))}));
  const cusips=[...new Set(snaps.flatMap(s=>(s.j.holdings||[]).map(h=>String(h.cusip||'').trim().toUpperCase()).filter(c=>/^[A-Z0-9]{8,9}$/.test(c))))];
  const sm=await secMap(),fm=await figiMap(cusips);
  let total=0,direct=0,viaFigi=0,resolved=0,changed=0;
  const coverage=[];
  for(const s of snaps){
    let sr=0,sd=0,sf=0;
    for(const h of s.j.holdings||[]){
      total++;const original=norm(h.ticker),cusip=String(h.cusip||'').trim().toUpperCase();
      const figi=fm.get(cusip)||null;
      const directCik=sm.get(original)||null,figiCik=figi?sm.get(figi)||null:null;
      const cik=directCik||figiCik||null,resolvedTicker=directCik?original:(figiCik?figi:original);
      h.historicalTicker=original;h.resolvedTicker=resolvedTicker;h.secCik=cik;h.identitySource=directCik?'historical_ticker_current_sec_map':figiCik?'cusip_openfigi_to_current_sec_map':'unresolved';
      if(directCik){direct++;sd++;}else if(figiCik){viaFigi++;sf++;}
      if(cik){resolved++;sr++;}
    }
    const p=path.join(CACHE_DIR,s.file),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s.j));fs.renameSync(tmp,p);changed++;
    coverage.push({asOf:s.j.asOf||s.file.slice(4,14),holdings:(s.j.holdings||[]).length,secCikResolved:sr,secCikResolvedRate:(s.j.holdings||[]).length?sr/s.j.holdings.length:null,directTicker:sd,cusipViaOpenFigi:sf});
  }
  const report={generatedAt:new Date().toISOString(),version:'v12.55.3-historical-security-identity',guardrails:['Point-in-time membership is never replaced with current constituents.','Current SEC ticker data is used only as an identity bridge to CIK.','OpenFIGI CUSIP mapping is used only to resolve security identity, never membership.','Unresolved historical securities remain explicitly unresolved and are not silently substituted.'],summary:{snapshots:snaps.length,rows:total,uniqueCusips:cusips.length,secCikResolved:resolved,secCikResolvedRate:total?resolved/total:null,directHistoricalTickerResolved:direct,cusipOpenFigiResolved:viaFigi,cacheFilesEnriched:changed,minSnapshotResolvedRate:coverage.length?Math.min(...coverage.map(x=>x.secCikResolvedRate)):null,meanSnapshotResolvedRate:coverage.length?coverage.reduce((a,x)=>a+x.secCikResolvedRate,0)/coverage.length:null},coverage};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(report,null,2));
  console.log(`Wrote ${path.relative(__dirname,OUT)}. SEC CIK resolved ${resolved}/${total} (${(100*resolved/total).toFixed(1)}%).`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});
module.exports={chooseFigi};
