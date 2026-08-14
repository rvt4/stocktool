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
console.log('Model smoke test passed: canonical return, MOS, and scenario ordering are internally consistent.');
