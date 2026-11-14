'use strict';
// Build 82: exit P/E on the table's EPS basis, clean P/E anchor, current-year consensus weight, one-off
// share issuance cap, and the growth / exit-multiple experiment.
const assert=require('assert');
const {buildSimplePath,calculateSimple}=require('./engine/simple-path');
const {buildForecast}=require('./engine/forecast-engine');
const {returnVariantTest}=require('./owner-strategy-lab');

// 1) Simple table: a GAAP P/E is converted to analysts' basis (consensus excludes stock pay).
{
  const rows=[];let R=40e9;const S=1e9;
  for(let i=0;i<10;i++){R*=1.08;rows.push({year:2027+i,revenue:R,revenueGrowth:.08,shares:S,actualDilution:0,gaapNetMargin:.20,netMargin:.20,
    sbcMargin:.07,intangibleAmortizationMargin:0,taxRate:.2,fcfMargin:.30,preSbcFcfMargin:.30,dividendPerShare:0,nonOperatingMargin:0});}
  const st=b=>({price:{current:220},analystEstimates:{numAnalysts:40,revenueCurrentYear:rows[0].revenue,revenueNextYear:rows[1].revenue,
    epsCurrentYear:.27*rows[0].revenue/S,epsNextYear:.27*rows[1].revenue/S}});
  const val={methods:[{name:'EPS exit',audit:{exitMultiple:20}}],netDebt:0};
  const fc=basis=>({rows,forecastBridge:{margins:{analystMarginAnchor:{consensusBasis:basis}}}});
  const ex=buildSimplePath(st(),fc('excludes_sbc'),val), inc=buildSimplePath(st(),fc('includes_sbc'),val);
  assert(ex.basisFactor<.8&&ex.basisFactor>.7,'GAAP 20% / analyst ~27% margin: '+ex.basisFactor);
  assert(Math.abs(ex.exitPE-20*ex.basisFactor)<1e-9,'exit P/E converted');
  assert.strictEqual(inc.basisFactor,1);assert.strictEqual(inc.exitPE,20);
  // no EPS-exit multiple (fallback): no conversion
  const fb=buildSimplePath(st(),fc('excludes_sbc'),{methods:[],netDebt:0});
  assert.strictEqual(fb.basisFactor,1);
}

// 2-4) Engine: synthetic company.
function company({taxCharge=0,shareJump=0,cy=null,n=0}={}){
  const years=[];let revenue=50e9,shares=1e9;
  for(let i=0;i<6;i++){revenue*=1.1;const last=i===5;if(last)shares*=1+shareJump;
    const op=revenue*.30,ni=op*.85-(last?taxCharge*revenue:0);
    years.push({year:2020+i,revenue,operatingIncome:op,netIncome:ni,pretaxIncome:op,incomeTaxExpense:op*.15+(last?taxCharge*revenue:0),
      ebitda:op+revenue*.05,cfo:ni+revenue*.08,capex:revenue*.04,fcf:ni+revenue*.04,sbc:revenue*.02,sbcIntensity:.02,sharesOutTTM:shares,
      totalDebt:10e9,cash:20e9,grossProfit:revenue*.6,dilutedEPS:ni/shares});}
  const r1=revenue*1.1,r2=r1*1.1;
  const a=n?{numAnalysts:n,revenueCurrentYear:r1,revenueNextYear:r2,epsCurrentYear:cy*r1/shares,epsNextYear:cy*r2/shares,
    revenueGrowthCurrentYear:.1,revenueGrowthNextYear:.1,epsGrowthCurrentYear:.1,epsGrowthNextYear:.1}:{numAnalysts:0};
  return {ticker:'TST',sector:'Technology',financials:{years,dataQuality:{}},growthYear1:.1,price:{current:300},valuation:{dividendYield:0,growthSource:'test'},analystEstimates:a};
}
{ // 3) current-year consensus weight
  const f=buildForecast(company({cy:.18,n:24}));
  const A=f.forecastBridge.margins.analystMarginAnchor;
  assert(A.startWeight>A.weight&&A.startWeight<=.85,'start weight above the general anchor weight: '+A.startWeight+' vs '+A.weight);
}
{ // 4) one-off issuance capped for a self-funding company
  const f=buildForecast(company({shareJump:.07}));
  assert((f.forecastFlags||[]).includes('one_off_share_issuance_capped'),'flag expected');
  assert(f.rows[0].actualDilution<=.03,'year-1 dilution capped: '+f.rows[0].actualDilution);
}
{ // 2) clean P/E anchor: a one-off tax charge must not raise the exit multiple
  const {computeQuality}=require('./engine/quality-engine');const {valuate}=require('./engine/valuation-engine');
  const run=c=>{const s=company({taxCharge:c});const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return v.methods.find(m=>m.name==='EPS exit')?.audit;};
  const clean=run(0),hit=run(.06);
  assert(clean&&hit,'EPS exit expected');assert(hit.anchorMultiple<=clean.anchorMultiple*1.05,'one-off charge inflated the P/E anchor: '+clean.anchorMultiple+' vs '+hit.anchorMultiple);
}
// 5) growth / exit experiment scoring
{
  const snaps=[];for(const d of ['2019-12-31','2020-12-31','2022-12-31','2023-12-31'])snaps.push({asOf:d,rows:Array.from({length:40},(_,i)=>{const real=.02+i*.004;
    return {expectedCAGR:real+.05,altExpectedCAGR:real+.01,realized3YTotalReturnCAGR:real,realized5YTotalReturnCAGR:real};})});
  const t=returnVariantTest(snaps);
  assert(t['3Y'].variant.medianAbsError<t['3Y'].model.medianAbsError&&t.adopt===true);
  const t2=returnVariantTest(snaps.map(s=>({...s,rows:s.rows.map(r=>({...r,altExpectedCAGR:r.realized3YTotalReturnCAGR+.08}))})));
  assert.strictEqual(t2.adopt,false);
}
console.log('build82 tests passed');
