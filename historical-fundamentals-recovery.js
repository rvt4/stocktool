'use strict';
/**
 * v12.55.5 Historical Fundamentals Recovery
 *
 * Conservative SEC 10-K fallback for pre-/early-XBRL history. It only uses filings
 * that were filed on or before the requested historical snapshot. The parser reads
 * comparative annual statement tables from the filing HTML and produces normalized
 * annual rows that can fill gaps in Company Facts. It never changes universe
 * membership and never uses a later filing to repair an earlier snapshot.
 */
const {fetchWithTimeout,fetchSecSubmissionsByCik}=require('./data-fetchers');

const SEC_HEADERS={
  'User-Agent':process.env.SEC_USER_AGENT||'FreeScreener historical research contact@example.com',
  'Accept-Encoding':'gzip, deflate',
  'Accept':'text/html,application/xhtml+xml,application/json,text/plain,*/*'
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const submissionsCache=new Map();
const filingParseCache=new Map();
function padCik(cik){const s=String(cik||'').replace(/\D/g,'');return s?String(Number(s)).padStart(10,'0'):null;}
function accessionNoDashes(x){return String(x||'').replace(/-/g,'');}
function secArchiveDocUrl(cik,accession,primaryDocument){
  const c=String(Number(String(cik).replace(/\D/g,'')));
  return `https://www.sec.gov/Archives/edgar/data/${c}/${accessionNoDashes(accession)}/${primaryDocument}`;
}
function htmlDecode(s){return String(s||'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCharCode(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCharCode(Number(x)));}
function cleanCell(s){return htmlDecode(String(s||'').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
function parseNumber(s){
  let t=cleanCell(s);if(!t||/^[-–—]$/.test(t))return null;
  const neg=/^\s*\(/.test(t)&&/\)\s*$/.test(t);
  t=t.replace(/[$,%]/g,'').replace(/[()]/g,'').replace(/,/g,'').replace(/\s+/g,'');
  if(!/^-?\d+(?:\.\d+)?$/.test(t))return null;
  const n=Number(t);return Number.isFinite(n)?(neg?-Math.abs(n):n):null;
}
function yearTokens(cells){
  return cells.map((c,i)=>({i,y:(cleanCell(c).match(/\b(19|20)\d{2}\b/)||[])[0]})).filter(x=>x.y).map(x=>({i:x.i,year:Number(x.y)}));
}
function fieldForLabel(label){
  const x=label.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const tests=[
    ['revenue',/^(net )?(sales|revenues?|operating revenues?|total revenues?|net revenues?)\b/],
    ['netIncome',/^(net income|net earnings|net loss)( attributable to .* shareholders)?\b/],
    ['operatingIncome',/^(income from operations|operating income|operating profit|operating loss)\b/],
    ['grossProfit',/^gross profit\b/],
    ['cfo',/^(net cash (provided by|from) operating activities|cash flows? from operating activities)\b/],
    ['capex',/^(capital expenditures|purchases? of property.*equipment|additions? to property.*equipment)\b/],
    ['sharesOutTTM',/^(weighted average.*diluted.*shares|diluted weighted average.*shares|weighted average number of diluted shares)\b/],
    ['dilutedEPS',/^(diluted (earnings|income|loss) per (common )?share|earnings per share.*diluted)\b/],
    ['cash',/^(cash and cash equivalents|cash equivalents and short term investments)\b/],
    ['longTermDebt',/^(long term debt|long term borrowings|long term obligations)( less current portion)?\b/],
    ['stockholdersEquity',/^(stockholders equity|shareholders equity|total stockholders equity|total shareholders equity)\b/],
    ['dividendsPaid',/^(cash dividends paid|dividends paid)\b/],
    ['dividendPerShare',/^(cash dividends.*per share|dividends.*per share)\b/],
    ['da',/^(depreciation and amortization|depreciation amortization and accretion)\b/]
  ];
  for(const [f,re] of tests)if(re.test(x))return f;return null;
}
function tableScale(tableHtml){
  const head=cleanCell(tableHtml.slice(0,Math.min(tableHtml.length,6000))).toLowerCase();
  if(/\bin billions\b|\$ in billions/.test(head))return 1e9;
  if(/\bin millions\b|\$ in millions/.test(head))return 1e6;
  if(/\bin thousands\b|\$ in thousands/.test(head))return 1e3;
  return 1;
}
function postProcess(rows){
  const out=[...rows.values()].sort((a,b)=>a.year-b.year);
  for(const y of out){
    if(y.cfo!=null&&y.capex!=null)y.fcf=y.cfo-Math.abs(y.capex);
    y.fcfIsProxy=false;
    if(y.cfo!=null&&y.capex==null)y.fcfUnavailableReason='missing_capex';
    if(y.revenue>0){
      if(y.grossProfit!=null)y.grossMargin=y.grossProfit/y.revenue;
      if(y.operatingIncome!=null)y.operatingMargin=y.operatingIncome/y.revenue;
      if(y.netIncome!=null)y.netMargin=y.netIncome/y.revenue;
      if(y.fcf!=null)y.fcfMargin=y.fcf/y.revenue;
    }
    if(y.netIncome!=null&&y.dilutedEPS!=null&&Math.abs(y.dilutedEPS)>1e-6){
      const implied=Math.abs(y.netIncome/y.dilutedEPS);
      if(!(y.sharesOutTTM>1e5)&&implied>1e5)y.sharesOutTTM=implied;
    }
    if(y.sharesOutTTM>0)y.sharesSource='legacy_10k_comparative_statement';
    if(y.operatingIncome!=null&&y.da!=null)y.ebitda=y.operatingIncome+Math.abs(y.da);
    y.recoverySource='sec_10k_html';
  }
  return out;
}
function parseLegacy10KAnnuals(html,{filed=null,accession=null}={}){
  const rows=new Map();let extractedFields=0;
  const tables=String(html||'').match(/<table\b[\s\S]*?<\/table>/gi)||[];
  for(const table of tables){
    const scale=tableScale(table);const trs=table.match(/<tr\b[\s\S]*?<\/tr>/gi)||[];let headerYears=[];
    for(const tr of trs){
      const cells=(tr.match(/<(?:td|th)\b[\s\S]*?<\/(?:td|th)>/gi)||[]).map(cleanCell).filter(Boolean);
      if(cells.length<2)continue;
      const yrs=yearTokens(cells);if(yrs.length>=2){headerYears=yrs.map(x=>x.year);continue;}
      if(!headerYears.length)continue;
      const field=fieldForLabel(cells[0]);if(!field)continue;
      const nums=cells.slice(1).map(parseNumber).filter(v=>v!=null);
      if(nums.length<headerYears.length)continue;
      const vals=nums.slice(0,headerYears.length);
      for(let i=0;i<headerYears.length;i++){
        const year=headerYears[i],raw=vals[i];if(!year||raw==null)continue;
        let value=raw;
        if(!['dilutedEPS','dividendPerShare'].includes(field))value*=scale;
        const r=rows.get(year)||{year};
        // Prefer first clean row for a field inside a filing; duplicate totals/segments
        // are common and later duplicates are more likely to be partial subtotals.
        if(r[field]==null){r[field]=value;r[`${field}Source`]='legacy_10k_html';extractedFields++;}
        r.recoveryFiled=filed||null;r.recoveryAccession=accession||null;rows.set(year,r);
      }
    }
  }
  return {years:postProcess(rows),extractedFields,tableCount:tables.length};
}
async function loadSubmissionFiles(sub){
  const out=[sub];
  for(const f of sub?.filings?.files||[]){
    if(!f?.name)continue;
    try{const r=await fetchWithTimeout(`https://data.sec.gov/submissions/${f.name}`,{headers:SEC_HEADERS},`SEC submissions ${f.name}`);if(r.ok)out.push(await r.json());}catch(_e){}
  }
  return out;
}
function filingRows(subs,asOf){
  const rows=[];
  for(const sub of subs){const r=sub?.filings?.recent||sub;const n=Math.max(r?.form?.length||0,r?.accessionNumber?.length||0);
    for(let i=0;i<n;i++){
      const form=String(r.form?.[i]||'');const filed=String(r.filingDate?.[i]||'');const doc=String(r.primaryDocument?.[i]||'');const acc=String(r.accessionNumber?.[i]||'');
      if(!/^10-K(?:\/A)?$/.test(form)||!filed||filed>asOf||!doc||!acc)continue;
      rows.push({form,filed,primaryDocument:doc,accession:acc,reportDate:String(r.reportDate?.[i]||'')});
    }}
  return rows.sort((a,b)=>b.filed.localeCompare(a.filed));
}
async function recoverAnnualFinancialsByCik(cik,asOf,{maxFilings=3,delayMs=120}={}){
  const normalized=padCik(cik);if(!normalized)return {years:[],filingsTried:0,filingsParsed:0,errors:['invalid_cik']};
  let subs=submissionsCache.get(normalized);
  if(!subs){const sub=await fetchSecSubmissionsByCik(normalized);if(!sub)return {years:[],filingsTried:0,filingsParsed:0,errors:['submissions_unavailable']};subs=await loadSubmissionFiles(sub);submissionsCache.set(normalized,subs);}
  if(!subs)return {years:[],filingsTried:0,filingsParsed:0,errors:['submissions_unavailable']};
  const filings=filingRows(subs,asOf).slice(0,maxFilings);const byYear=new Map();const errors=[];let parsed=0;
  for(const f of filings){
    try{const cacheKey=`${normalized}|${f.accession}`;let p=filingParseCache.get(cacheKey);if(!p){const url=secArchiveDocUrl(normalized,f.accession,f.primaryDocument);const r=await fetchWithTimeout(url,{headers:SEC_HEADERS},`SEC legacy 10-K ${normalized}`);if(!r.ok)throw new Error(`HTTP ${r.status}`);const html=await r.text();p=parseLegacy10KAnnuals(html,{filed:f.filed,accession:f.accession});filingParseCache.set(cacheKey,p);}if(p.years.length)parsed++;
      for(const y of p.years){if(new Date(`${y.year}-12-31`) > new Date(asOf)&&y.year>Number(asOf.slice(0,4)))continue;const cur=byYear.get(y.year)||{year:y.year};for(const [k,v] of Object.entries(y))if(k!=='year'&&cur[k]==null&&v!=null)cur[k]=v;byYear.set(y.year,cur);}
    }catch(e){errors.push(`${f.accession}: ${e.message}`);}if(delayMs)await sleep(delayMs);
  }
  return {years:postProcess(byYear),filingsTried:filings.length,filingsParsed:parsed,errors};
}
function mergeAnnualHistories(primary,supplemental){
  const m=new Map();for(const y of primary||[])m.set(y.year,{...y});
  for(const y of supplemental||[]){const r=m.get(y.year)||{year:y.year};for(const [k,v] of Object.entries(y))if(k!=='year'&&(r[k]==null||!Number.isFinite(Number(r[k])))&&v!=null)r[k]=v;m.set(y.year,r);}
  return [...m.values()].sort((a,b)=>a.year-b.year).slice(-10);
}
module.exports={parseNumber,fieldForLabel,parseLegacy10KAnnuals,filingRows,recoverAnnualFinancialsByCik,mergeAnnualHistories,secArchiveDocUrl};
