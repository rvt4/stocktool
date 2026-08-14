'use strict';
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const {validateStock}=require('./engine/validation');

function stock({ticker='TEST',sector='Technology',price=100,growth=.10,margin=.20,roic=.20,dividend=0,dilution=0}){
  const years=[];let revenue=8e9,shares=200e6;
  for(let i=0;i<5;i++){revenue*=1+growth;shares*=1+dilution;years.push({year:2021+i,revenue,fcf:revenue*margin,fcfSBCAdjusted:revenue*(margin-.01),ebitda:revenue*(margin+.08),netIncome:revenue*(margin-.03),operatingIncome:revenue*(margin+.05),sharesOutTTM:shares,roic,opMargin:margin+.05,totalDebt:1e9,cash:1.5e9,dividendPerShare:dividend,sbcIntensity:.02});}
  return{ticker,sector,financials:{years,dataQuality:{}},analystEstimates:{revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth*.9,numAnalysts:25},growthYear1:growth,price:{current:price},valuation:{dividendYield:dividend/price,growthSource:'test'}};
}
function run(s){const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q),d=rateStock(s,f,q,v);const pub={ticker:s.ticker,currentPrice:s.price.current,totalShareholderValue:v.totalShareholderValue,expectedReturn:v.expectedCAGR,bearCAGR:v.bearCAGR,baseCAGR:v.baseCAGR,bullCAGR:v.bullCAGR,fairValueEstimate:v.fairValueEstimate,marginOfSafety:v.marginOfSafety,rating:d.rating};assert.deepStrictEqual(validateStock(pub),[]);assert(v.bearCAGR<=v.baseCAGR&&v.baseCAGR<=v.bullCAGR);assert(Math.abs((1-s.price.current/v.fairValueEstimate)-v.marginOfSafety)<1e-10);return{f,q,v,d};}
const compounder=run(stock({ticker:'COMPOUNDER',price:180,growth:.11,margin:.30,roic:.30,dilution:-.01}));
const expensive=run(stock({ticker:'EXPENSIVE',price:1000,growth:.25,margin:.20,roic:.24,dilution:.02}));
const dividend=run(stock({ticker:'DIVIDEND',sector:'Consumer Staples',price:80,growth:.04,margin:.14,roic:.18,dividend:3}));
assert(Number.isFinite(compounder.v.expectedCAGR));assert(Number.isFinite(expensive.v.expectedCAGR));assert(Number.isFinite(dividend.v.expectedCAGR));

// Forward-looking forecast sanity checks: one-time acquisition-style revenue jumps must
// reset the revenue base without becoming the organic run-rate, and real operating
// leverage is allowed to expand margins when the financial evidence supports it.
const acquisitionLike=stock({ticker:'ACQ',price:100,growth:.04,margin:.14,roic:.18});
acquisitionLike.financials.years.at(-1).revenue*=1.35;
acquisitionLike.financials.years.at(-1).fcfSBCAdjusted*=1.35;
acquisitionLike.financials.years.at(-1).fcf*=1.35;
acquisitionLike.analystEstimates.revenueGrowthCurrentYear=.06;
acquisitionLike.analystEstimates.revenueGrowthNextYear=.05;
acquisitionLike.quarterly=[{end:'2025-03-31',val:100},{end:'2026-03-31',val:105}];
const acqForecast=buildForecast(acquisitionLike);
assert(acqForecast.forecastFlags.includes('structural_revenue_step_up_detected'));
assert(acqForecast.revenueGrowthAnchor<.12,'one-time revenue step-up leaked into forward organic growth');

const leverage=stock({ticker:'LEVERAGE',price:100,growth:.12,margin:.18,roic:.24});
for(let i=0;i<leverage.financials.years.length;i++){
  const y=leverage.financials.years[i], m=.13+i*.018;
  y.fcfSBCAdjusted=y.revenue*m; y.fcf=y.revenue*(m+.01); y.operatingIncome=y.revenue*(m+.07); y.opMargin=m+.07;
}
const levForecast=buildForecast(leverage);
assert(levForecast.marginTargets.fcf>=levForecast.marginAssumptions.fcf,'supported operating leverage should not be forced back to historical margins');


// A very expensive but modelable company must remain rated rather than disappearing as
// Unrated merely because its canonical downside exceeds the old plausibility band.
const extreme=stock({ticker:'EXTREME',price:5000,growth:.12,margin:.18,roic:.22,dilution:.01});
const extremeRun=run(extreme);
assert(Number.isFinite(extremeRun.v.expectedCAGR),'extreme canonical return should still publish');
assert.notStrictEqual(extremeRun.d.rating,'Unrated','modelable extreme valuation should still receive a rating');
assert(extremeRun.v.extremeReturnFlag===true,'extreme return should be explicitly flagged for review');

// A growth company with temporarily unusable earnings/FCF should fall back to an
// EV/Sales bridge instead of becoming Unrated.
const preProfit=stock({ticker:'PREPROFIT',price:100,growth:.22,margin:.10,roic:.05,dilution:.03});
for(const y of preProfit.financials.years){y.fcf=-Math.abs(y.fcf);y.fcfSBCAdjusted=-Math.abs(y.fcfSBCAdjusted);y.netIncome=-Math.abs(y.netIncome);y.ebitda=-Math.abs(y.ebitda);}
const ppF=buildForecast(preProfit), ppQ=computeQuality(preProfit,ppF), ppV=valuate(preProfit,ppF,ppQ), ppD=rateStock(preProfit,ppF,ppQ,ppV);
assert(ppV.methods.some(m=>m.name==='EV/Sales fallback'),'pre-profit company should use EV/Sales fallback');
assert(Number.isFinite(ppV.expectedCAGR),'fallback valuation should publish a canonical return');
assert.notStrictEqual(ppD.rating,'Unrated','fallback-valued company should receive a rating');

console.log('Model smoke test passed: canonical return, MOS, scenario ordering, extreme-return publication, and valuation fallback are internally consistent.');
