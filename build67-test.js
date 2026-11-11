'use strict';
// Build 67: forecast calibration from the Build 66 scorecard.
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const CFG=require('./engine/config');

function co({t,g,n=0,a1=null,a2=null,fcf=.15,fcfPath=null,net=.12,sector='Technology'}){
  const years=[];let R=2e9;
  for(let i=0;i<6;i++){const f=fcfPath?fcfPath[i]:fcf;
    years.push({year:2020+i,revenue:R,grossProfit:R*.55,operatingIncome:R*(net+.04),opMargin:net+.04,netIncome:R*net,ebitda:R*(net+.08),fcf:R*f,
      operatingCashFlow:R*(f+.04),capex:R*.04,sbc:R*.02,sbcIntensity:.02,sharesOutTTM:1e8,dilutedEPS:R*net/1e8,roic:.20,totalDebt:3e8,cash:4e8});
    if(i<5)R*=1+g;}
  return {ticker:t,sector,price:{current:R*net/1e8*30},financials:{years,dataQuality:{}},valuation:{},
    analystEstimates:n?{numAnalysts:n,revenueGrowthCurrentYear:a1,revenueGrowthNextYear:a2}:null};
}
const run=s=>{const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return {f,v};};
const M=CFG.GROWTH_CALIBRATION.anchor;

// 1) Fast grower without consensus: year 1 unchanged, later years pulled toward the anchor by KEEP.
{
  const {f}=run(co({t:'FAST',g:.25}));
  const raw=f.forecastBridge.revenue.calibration.uncalibratedYears1to5,cal=f.rows.slice(0,5).map(r=>r.revenueGrowth);
  assert.strictEqual(cal[0],raw[0],'year 1 must not be calibrated');
  for(let i=1;i<5;i++){
    const expect=M+CFG.GROWTH_CALIBRATION.keep[i]*(raw[i]-M);
    assert(Math.abs(cal[i]-expect)<1e-12,`year ${i+1}: ${cal[i]} vs ${expect}`);
    assert(cal[i]<raw[i],'fast grower should be pulled down');
  }
}
// 2) Shrinking company is pulled UP toward the anchor (shrinking forecasts grew ~4.6%/yr in the backtest).
{
  const {f}=run(co({t:'SHRINK',g:-.06}));
  const raw=f.forecastBridge.revenue.calibration.uncalibratedYears1to5;
  assert(f.rows[2].revenueGrowth>raw[2],'shrinking path should be pulled toward the anchor');
}
// 3) Year-2 consensus: thin coverage keeps 90% of the distance, deep coverage (30+) keeps all of it.
{
  const thin=run(co({t:'THIN',g:.20,n:6,a1:.25,a2:.30})).f, deep=run(co({t:'DEEP',g:.20,n:40,a1:.25,a2:.30})).f;
  const rt=thin.forecastBridge.revenue.calibration.uncalibratedYears1to5[1],rd=deep.forecastBridge.revenue.calibration.uncalibratedYears1to5[1];
  assert(Math.abs(thin.rows[1].revenueGrowth-(M+.90*(rt-M)))<1e-12,'thin coverage year 2');
  assert(Math.abs(deep.rows[1].revenueGrowth-rd)<1e-12,'deep coverage year 2 should be untouched');
}
// 4) FCF targets move part-way toward the 3-year median FCF margin; a rising path still rises; CFO follows.
{
  const flat=run(co({t:'FCFLOW',g:.08,fcf:.10})).f;
  assert(flat.forecastFlags.includes('fcf_blended_with_3yr_median'));
  assert(Math.abs(flat.forecastBridge.margins.fcfMedian3-.10)<1e-12);
  // The blend keeps the shape of the path: the start-to-year-5 slope shrinks by (1 - weight), never flips sign.
  const W=CFG.FCF_MEDIAN_BLEND,saved={...W};
  const stk=()=>co({t:'RISE',g:.12,fcfPath:[.06,.08,.10,.12,.14,.16]});
  W.start=W.year5=W.mature=0;const off=run(stk()).f.forecastBridge.margins;Object.assign(W,saved);
  const mb=run(stk()).f.forecastBridge.margins;
  const slopeOff=off.fcfTarget-off.fcfStart,slopeOn=mb.fcfTarget-mb.fcfStart;
  assert(Math.sign(slopeOn)===Math.sign(slopeOff)&&Math.abs(slopeOn)<Math.abs(slopeOff)+1e-9,`path shape changed: ${slopeOff} -> ${slopeOn}`);
  assert(Math.abs(mb.fcfTarget-(mb.cfoTarget-mb.capexTarget))<1e-10,'FCF target no longer reconciles to CFO - capex');
}
// 5) Switch-off: KEEP all 1 reproduces the uncalibrated path.
{
  const saved=CFG.GROWTH_CALIBRATION.keep.slice();
  CFG.GROWTH_CALIBRATION.keep.fill(1);
  const {f}=run(co({t:'OFF',g:.25}));
  const raw=f.forecastBridge.revenue.calibration.uncalibratedYears1to5;
  f.rows.slice(0,5).forEach((r,i)=>assert(Math.abs(r.revenueGrowth-raw[i])<1e-12,'switch-off failed'));
  CFG.GROWTH_CALIBRATION.keep.splice(0,5,...saved);
}
// 6) Build 67b: an empty analyst record (yfinance row with numAnalysts 0, nulls, revenue 0) must give exactly the
//    same forecast and valuation as no analyst record at all (ROKU was read as "0% growth" and rated Sell).
{
  const empty={revenueGrowthFwd:null,revenueGrowthCurrentYear:null,revenueGrowthNextYear:null,revenueCurrentYear:0,revenueNextYear:0,
    epsGrowthFwd:null,epsGrowthCurrentYear:null,epsGrowthNextYear:null,epsCurrentYear:null,epsNextYear:null,epsGrowthLongTerm:null,
    analystTargetMean:null,numAnalysts:0,source:'yfinance'};
  const none=run(co({t:'R',g:.15})),withEmpty=run({...co({t:'R',g:.15}),analystEstimates:empty});
  assert.deepStrictEqual(withEmpty.f.rows.map(r=>r.revenueGrowth),none.f.rows.map(r=>r.revenueGrowth),'empty analyst record changed growth');
  assert.strictEqual(withEmpty.f.forecastBridge.revenue.analystCurrent,null);
  assert(Math.abs(withEmpty.v.expectedCAGR-none.v.expectedCAGR)<1e-9,`empty analyst record changed expected return ${withEmpty.v.expectedCAGR} vs ${none.v.expectedCAGR}`);
  // A placeholder 0% with no revenue estimate is ignored even when analysts are counted (pre-revenue names).
  const ph=run({...co({t:'P',g:.15}),analystEstimates:{numAnalysts:5,revenueGrowthCurrentYear:0,revenueGrowthNextYear:0,revenueCurrentYear:null}});
  assert.deepStrictEqual(ph.f.rows.slice(0,2).map(r=>r.revenueGrowth),none.f.rows.slice(0,2).map(r=>r.revenueGrowth));
  // A real 0% (with a revenue estimate) is still used.
  const real=run({...co({t:'Z',g:.15}),analystEstimates:{numAnalysts:12,revenueGrowthCurrentYear:0,revenueGrowthNextYear:0,revenueCurrentYear:5e9,revenueNextYear:5e9}});
  assert(real.f.rows[0].revenueGrowth<none.f.rows[0].revenueGrowth,'real 0% consensus should still pull growth down');
}
console.log('build67-test OK');
