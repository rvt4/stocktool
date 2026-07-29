'use strict';
function buildMarketExpectations(stock,model,marketImpliedGrowth,returnV2){
 const exit=model.projection.at(-1)||{}; const last=stock.financials.years.at(-1)||{};
 return {impliedRevenueGrowth:marketImpliedGrowth,modeledYear1Growth:model.growthModel?.assumptions?.year1??null,modeledYear5Growth:exit.growth??null,currentNetMargin:last.revenue>0?last.netIncome/last.revenue:null,targetNetMargin:exit.netMargin??null,multipleReratingContribution:returnV2?.breakdown?.multipleRerating??null,summary:marketImpliedGrowth==null?'Market-implied growth unavailable.':`Current price implies roughly ${(marketImpliedGrowth*100).toFixed(1)}% annual FCF growth versus ${(model.growthModel?.assumptions?.year1*100).toFixed(1)}% modeled near-term revenue growth.`};
}
module.exports={buildMarketExpectations};
