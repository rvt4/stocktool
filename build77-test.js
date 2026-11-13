'use strict';
// Build 77: unspent cash counts in P/E and FCF exits; net margin capped by operations; D&A from more SEC tags.
const assert=require('assert');
const D=require('./data-fetchers');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');

// 1) D&A resolver: MSFT-style tag, depreciation+amortization pieces, and priority over a later fallback tag.
const fact=(y,v)=>({form:'10-K',fp:'FY',fy:y,start:`${y}-01-01`,end:`${y}-12-31`,filed:`${y+1}-02-01`,val:v});
const tag=pairs=>({units:{USD:pairs.map(([y,v])=>fact(y,v))}});
const base=y=>[[2022,y],[2023,y*1.1],[2024,y*1.2]];
const facts=extra=>({facts:{'us-gaap':{Revenues:tag(base(1000)),OperatingIncomeLoss:tag(base(200)),NetIncomeLoss:tag(base(150)),...extra}}});
const yrs=f=>D.parseAnnualFinancials(f);
let a=yrs(facts({DepreciationAmortizationAndOther:tag(base(50))}));
assert.strictEqual(a.at(-1).da,60);assert.strictEqual(a.at(-1).ebitda,240+60,'EBITDA from the MSFT-style tag');
a=yrs(facts({Depreciation:tag(base(30)),AmortizationOfIntangibleAssets:tag(base(10))}));
assert.strictEqual(a.at(-1).da,48,'depreciation + amortization summed');
a=yrs(facts({DepreciationDepletionAndAmortization:tag(base(40)),DepreciationAmortizationAndAccretionNet:tag(base(99))}));
assert.strictEqual(a.at(-1).da,48,'priority tag wins; the old code let the fallback overwrite it');
assert(!Object.keys(a.at(-1)).some(k=>/^_da|^_dep|^_amort/.test(k)),'scratch fields cleaned up');

// Shared fixture: a cash-rich, steady compounder.
function co({ticker='C',net=[.20,.20,.20,.20,.20,.20],op=[.25,.25,.25,.25,.25,.25],cash=1e9,debt=0}){
  const years=[];let R=5e9;
  for(let i=0;i<6;i++){years.push({year:2020+i,revenue:R,grossProfit:R*.6,operatingIncome:R*op[i],opMargin:op[i],netIncome:R*net[i],ebitda:R*(op[i]+.04),da:R*.04,
    fcf:R*(op[i]*.8),cfo:R*(op[i]*.8+.04),operatingCashFlow:R*(op[i]*.8+.04),capex:R*.04,sbc:R*.01,sbcIntensity:.01,sharesOutTTM:1e9,dilutedEPS:R*net[i]/1e9,roic:.3,totalDebt:debt,cash,taxRate:.21});R*=1.08;}
  return {ticker,sector:'Technology',price:{current:R*net[5]/1e9*22},financials:{years,dataQuality:{}},valuation:{dividendYield:0},analystEstimates:null};
}
const run=s=>{const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return {f,q,v};};

// 2) Cash build counted in EPS and FCF exits (EV exits already counted it through net debt).
{
  const {f,v}=run(co({}));
  const T=f.rows.at(-1),nd0=v.netDebt,cps=(nd0-T.netDebt)/T.shares;
  assert(cps>0,'a cash-generative company builds cash over 10 years');
  const audits=Object.fromEntries((v.methods||[]).map(m=>[m.name,m.audit]));
  assert(audits['EPS exit']&&audits['FCF exit'],'fixture should produce both exits');
  for(const name of ['EPS exit','FCF exit']){const au=audits[name];
    assert(Math.abs(au.cashBuildPerShare-cps)<1e-6,name+' records the cash build');}
  const eps=(v.methods||[]).find(m=>m.name==='EPS exit');
  if(eps)assert(eps.target>eps.audit.metric*eps.audit.exitMultiple,'EPS exit target includes the cash build');
}
// 3) One-off gain in recent net income isn't carried forward (AMZN-style): net margin capped by operations.
{
  const clean=run(co({})).f, gain=run(co({net:[.20,.20,.20,.20,.30,.32]})).f;   // op margin unchanged at 25%
  assert(gain.forecastFlags.includes('net_margin_capped_by_operations'));
  // Build 77c: year 1 keeps half of last year's non-operating income, year 2 a quarter, then the 5-yr typical level.
  const t=.21, ceilNet=(.25+.01)*(1-t)+.02;   // op + typical non-op + 1pt, after tax (+ slack)
  gain.rows.forEach((r,i)=>{if(i>=2)assert(r.gaapNetMargin<=ceilNet,`year ${i+1} GAAP net ${r.gaapNetMargin}`);});
  assert(gain.rows[0].gaapNetMargin<.32-.05&&gain.rows[0].gaapNetMargin>gain.rows[2].gaapNetMargin,'the gain fades: year 1 below last year, above year 3');
  assert(gain.rows[4].gaapNetMargin<=clean.rows[4].gaapNetMargin+.03,'one-off gain mostly gone by year 5');
  assert(!clean.forecastFlags.includes('net_margin_capped_by_operations'),'a normal company is untouched');
}

// 4) Build 77b (AMD-shaped): analysts expect a big margin step-up. The P&L must stay coherent — operating and
// EBITDA margins rise with the analyst-led earnings, GAAP net never sits above what operations support —
// and year-1 cash margin starts from the latest reported, not a blend with older years.
{
  const years=[];let R=20e9;const sh=1.6e9,hist=[[.02,.04,.03],[.05,.08,.06],[.08,.10,.10],[.10,.12,.14],[.12,.13,.16]]; // [net, op, ownerFCF]
  hist.forEach(([n,o,f],i)=>{R*=1.15;years.push({year:2021+i,revenue:R,grossProfit:R*.5,operatingIncome:R*o,opMargin:o,netIncome:R*n,ebitda:R*(o+.08),da:R*.08,
    fcf:R*(f+.04),fcfSBCAdjusted:R*f,cfo:R*(f+.07),operatingCashFlow:R*(f+.07),capex:R*.03,sbc:R*.04,sbcIntensity:.04,sharesOutTTM:sh,roic:.12,totalDebt:2e9,cash:5e9,taxRate:.15,intangibleAmortization:R*.06});});
  const r1=R*1.5,r2=r1*1.8;
  const s={ticker:'AMDX',sector:'Technology',financials:{years,dataQuality:{}},price:{current:200},valuation:{dividendYield:0},growthYear1:.5,
    analystEstimates:{numAnalysts:40,revenueCurrentYear:r1,revenueNextYear:r2,revenueGrowthCurrentYear:.5,revenueGrowthNextYear:.8,epsCurrentYear:.20*r1/sh,epsNextYear:.30*r2/sh,epsGrowthCurrentYear:.9,epsGrowthNextYear:1.2}};
  const f=buildForecast(s);
  f.rows.forEach((r,i)=>{
    if(Number.isFinite(r.gaapNetMargin)&&Number.isFinite(r.operatingMargin)) assert(r.gaapNetMargin<=r.operatingMargin+.005,`year ${i+1}: GAAP net ${r.gaapNetMargin.toFixed(3)} above operating ${r.operatingMargin.toFixed(3)}`);
    if(Number.isFinite(r.ebitdaMargin)&&Number.isFinite(r.operatingMargin)) assert(r.ebitdaMargin>=r.operatingMargin-.001,`year ${i+1}: EBITDA below operating`);
  });
  assert(f.rows[2].operatingMargin>.20,'operating margin follows the analyst-led earnings step-up: '+f.rows[2].operatingMargin);
  assert(Math.abs(f.rows[0].fcfMargin-.16)<.015,'year-1 owner cash margin starts from the latest (16%), got '+f.rows[0].fcfMargin);
  // Build 77c: consensus that excludes SBC AND acquisition amortization is recognised, so the owner net margin
  // (GAAP + amortization add-back) can't exceed analysts' own non-GAAP margin (it used to: AMD 27.5% vs ~25%).
  const anc=JSON.stringify(f).match(/"consensusBasis":"([a-z_]+)"/);
  assert(anc,'anchor diagnostics present');assert.strictEqual(anc[1],'excludes_sbc_and_amortization');
  [0,1].forEach(i=>assert(f.rows[i].netMargin<=[.20,.30][i]+.01,`year ${i+1} owner net ${f.rows[i].netMargin.toFixed(3)} above analysts' non-GAAP margin`));
  // net follows operating margin smoothly: no dip-and-recover
  const nm=f.rows.map(r=>r.gaapNetMargin),om=f.rows.map(r=>r.operatingMargin);
  nm.forEach((v,i)=>assert(v<=om[i]+.005&&v>=(om[i]-.12),`year ${i+1} net ${v.toFixed(3)} vs op ${om[i].toFixed(3)}`));
  for(let i=1;i<10;i++)assert(Math.abs(f.rows[i].ebitdaMargin-f.rows[i-1].ebitdaMargin)<=Math.abs(om[i]-om[i-1])+.02,'EBITDA moves with operating margin, no wobble');
}
console.log('build77 tests passed');
