'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function finite(x){return Number.isFinite(Number(x));}
function buildMarketExpectations(stock,model,marketImpliedGrowth,returnV2){
 const exit=model.projection.at(-1)||{}; const last=stock.financials.years.at(-1)||{};
 const modeledYear1=model.growthModel?.assumptions?.year1??model.growthModel?.path?.[0]??null;
 const modeledYear5=exit.growth??null;
 const gap=finite(marketImpliedGrowth)&&finite(modeledYear1)?Number(modeledYear1)-Number(marketImpliedGrowth):null;
 const pressure=gap==null?null:clamp(-gap/.20,-1,1);
 let interpretation='Market-implied growth unavailable.';
 if(gap!=null){
   interpretation=gap>=.06?'The operating forecast is materially above growth embedded in the price; upside exists only if execution is credible.'
    :gap>=.015?'The forecast modestly exceeds priced-in growth.'
    :gap<=-.06?'The market price requires materially more growth than the central forecast; valuation risk is elevated.'
    :gap<=-.015?'The market requires somewhat more growth than the model forecasts.'
    :'The central forecast is close to the growth already embedded in the price.';
 }
 return {
  impliedRevenueGrowth:marketImpliedGrowth,
  modeledYear1Growth:modeledYear1,
  modeledYear5Growth:modeledYear5,
  expectationsGap:gap,
  expectationsPressure:pressure,
  currentNetMargin:last.revenue>0?last.netIncome/last.revenue:null,
  targetNetMargin:exit.netMargin??null,
  multipleReratingContribution:returnV2?.breakdown?.multipleRerating??null,
  interpretation,
  summary:marketImpliedGrowth==null?'Market-implied growth unavailable.':`Current price implies roughly ${(marketImpliedGrowth*100).toFixed(1)}% annual revenue growth versus ${(Number(modeledYear1)*100).toFixed(1)}% modeled near-term revenue growth. ${interpretation}`
 };
}
module.exports={buildMarketExpectations};
