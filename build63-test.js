'use strict';
// Build 63: stock-based pay is a real cost, counted exactly once (expensed), and the analyst anchor
// compares like with like (it used to pull a normalized margin toward a GAAP figure, taking SBC out twice).
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
function co({t,rev=13.3e9,g=.21,gaap=.13,sbc=.15,fcfPre=.33,amort=.01,price=102.76,shares=1.05e9,dil=.012,eps1,eps2,n=40}){
  const years=[];const r0=rev/Math.pow(1+g,4);
  for(let i=0;i<5;i++){const R=r0*Math.pow(1+g,i),op=gaap*1.15,sh=shares*Math.pow(1+dil,i-4);
    years.push({year:2021+i,revenue:R,grossProfit:R*.79,operatingIncome:R*op,opMargin:op,netIncome:R*gaap,ebitda:R*(op+.05),fcf:R*fcfPre,
      operatingCashFlow:R*(fcfPre+.07),capex:R*.07,sbc:R*sbc,sbcIntensity:sbc,amortization:R*amort,sharesOutTTM:sh,dilutedEPS:R*gaap/sh,roic:.25,totalDebt:2e9,cash:10e9});}
  const rev1=rev*(1+g),rev2=rev1*(1+g*.85);
  return {ticker:t,sector:'Technology',price:{current:price},financials:{years,dataQuality:{}},valuation:{},
    analystEstimates:{numAnalysts:n,revenueGrowthCurrentYear:g,revenueGrowthNextYear:g*.85,revenueCurrentYear:rev1,revenueNextYear:rev2,epsCurrentYear:eps1,epsNextYear:eps2,
      epsGrowthCurrentYear:eps1?.12:null,epsGrowthNextYear:eps1&&eps2?eps2/eps1-1:null}};
}
// 1) NOW-like: consensus EPS excludes SBC. GAAP margin must stay near its 13% history (was dipping to ~10%).
const now=buildForecast(co({t:'NOWX',eps1:3.95,eps2:4.80}));
assert.strictEqual(now.forecastBridge.margins.analystMarginAnchor.consensusBasis,'excludes_sbc');
assert(now.rows.every(r=>r.gaapNetMargin>.115),'GAAP margin dipped (SBC deducted twice): '+now.rows.map(r=>r.gaapNetMargin.toFixed(3)).join(' '));
// 2) Owner basis: FCF carries the full SBC cost, net margin is GAAP + after-tax amortization, and the share
//    path drops the grant slice of dilution.
assert.strictEqual(now.earningsBasis,'owner_sbc_expensed');
for(const r of now.rows){
  assert(Math.abs(r.preSbcFcfMargin-r.sbcMargin-r.fcfMargin)<1e-9,'FCF not after full SBC');
  assert(Math.abs(r.netMargin-(r.gaapNetMargin+r.intangibleAmortizationMargin*(1-r.taxRate)))<1e-9,'net margin not GAAP + amortization');
}
assert(now.dilutionRate<now.grossDilutionRate&&now.sbcDilution>.015,'grant dilution still charged');
// 3) Valuation: no EPS add-back, DCF works from after-SBC cash flow.
const s=co({t:'NOWX',eps1:3.95,eps2:4.80}),q=computeQuality(s,now),v=valuate(s,now,q);
const eps=v.methods.find(m=>m.name==='EPS exit');
assert(eps&&eps.audit.sbcAddBackFraction===0,'EPS add-back still applied');
// 4) Heavy SBC (25% of revenue, consensus-free) is valued lower than before; low SBC barely moves.
const heavy=co({t:'HEVY',sbc:.25,gaap:.05,fcfPre:.30,g:.25,price:60,shares:2e9,dil:.03});
const fh=buildForecast(heavy),vh=valuate(heavy,fh,computeQuality(heavy,fh));
assert(fh.rows.at(-1).fcfMargin<fh.rows.at(-1).preSbcFcfMargin-.15,'heavy SBC not charged to FCF');
assert(vh.expectedCAGR<.13,'heavy SBC issuer still valued as if SBC were free: '+vh.expectedCAGR);
console.log('Build 63 SBC-expensed owner-earnings tests passed',JSON.stringify({nowGaapY1:+now.rows[0].gaapNetMargin.toFixed(3),nowFcf10:+now.rows.at(-1).fcfMargin.toFixed(3),heavyCAGR:+vh.expectedCAGR.toFixed(3)}));
