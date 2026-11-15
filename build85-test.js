'use strict';
// Build 85: one forecast. The table's autofill = the model's path and the model's return; analyst view kept
// as a reference. Near-term dip measured on margins, not on EPS growth from a tax-flattered year.
const assert=require('assert');
const {buildSimplePath,calculateSimple}=require('./engine/simple-path');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');

function company({taxBenefit=0,cy=null,n=0}={}){
  const years=[];let revenue=40e9;const shares=2e9;
  for(let i=0;i<6;i++){revenue*=1.12;const last=i===5;const op=revenue*.12;const pre=op+revenue*.01;
    const tax=last?pre*.10-taxBenefit*revenue:pre*.10;
    years.push({year:2020+i,revenue,operatingIncome:op,pretaxIncome:pre,incomeTaxExpense:tax,netIncome:pre-tax,ebitda:op+revenue*.03,
      cfo:op*1.2,capex:revenue*.01,fcf:op*1.1,sbc:revenue*.03,sharesOutTTM:shares,totalDebt:10e9,cash:15e9,grossProfit:revenue*.4,dilutedEPS:(pre-tax)/shares});}
  const r1=revenue*1.12,r2=r1*1.12;
  const a=n?{numAnalysts:n,revenueCurrentYear:r1,revenueNextYear:r2,epsCurrentYear:cy*r1/shares,epsNextYear:cy*1.1*r2/shares,
    revenueGrowthCurrentYear:.12,revenueGrowthNextYear:.12,epsGrowthCurrentYear:cy*r1/shares/(years[5].netIncome/shares)-1,epsGrowthNextYear:.2}:{numAnalysts:0};
  return {ticker:'UBR',sector:'Technology',financials:{years,dataQuality:{}},growthYear1:.12,price:{current:70},valuation:{dividendYield:0,growthSource:'test'},analystEstimates:a};
}
const run=s=>{const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return {f,v,sp:buildSimplePath(s,f,v)};};

// 1) The table's autofill reproduces the model's return; edits move it.
{
  const {f,v,sp}=run(company({cy:.105,n:30}));
  assert.strictEqual(sp.basis,'model');
  const r=calculateSimple(sp);
  assert(Math.abs(r.cagr-v.expectedCAGR)<1e-4,'table return = model return: '+r.cagr+' vs '+v.expectedCAGR);
  for(let i=0;i<10;i++)assert(Math.abs(sp.years[i].eps-f.rows[i].eps)<1e-9,'model EPS each year');
  if(Array.isArray(sp.ndModel))assert(Math.abs(r.years[9].netDebt-sp.ndModel[9])<1,'follows the model net debt');
  const up=calculateSimple(sp,{revenueGrowth:sp.years.map(y=>y.revenueGrowth+.02),netMargin:sp.years.map(y=>y.netMargin)});
  assert(up.cagr>r.cagr,'faster growth -> higher return');
  assert(sp.analystView&&Number.isFinite(sp.analystView.cagr),'analyst reference kept');
}
// 2) A tax-flattered last year must not turn into an operating-margin dip when consensus margins match today's.
{
  const base=run(company({cy:.105,n:30})).f, hit=run(company({taxBenefit:.08,cy:.105,n:30})).f;
  for(let i=0;i<5;i++){
    assert(Math.abs(hit.rows[i].operatingMargin-base.rows[i].operatingMargin)<.01,'year '+(i+1)+' operating margin: '+hit.rows[i].operatingMargin+' vs '+base.rows[i].operatingMargin);
    assert(Math.abs(hit.rows[i].gaapNetMargin-base.rows[i].gaapNetMargin)<.01,'year '+(i+1)+' net margin: '+hit.rows[i].gaapNetMargin+' vs '+base.rows[i].gaapNetMargin);
  }
}
console.log('build85 tests passed');
