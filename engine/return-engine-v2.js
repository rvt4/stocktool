'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function computeReturnEngineV2(stock,model,marketExitPrice,consensus){
 const current=stock.price?.current; const years=model.projection?.length||5; if(!(current>0))return {expectedCAGR:null};
 const last=stock.financials.years.at(-1)||{}, exit=model.projection.at(-1)||{};
 const rev=last.revenue>0&&exit.revenue>0?Math.pow(exit.revenue/last.revenue,1/years)-1:0;
 const startMargin=last.revenue>0?last.netIncome/last.revenue:null;
 const margin=startMargin>0&&exit.netMargin>0?Math.pow(exit.netMargin/startMargin,1/years)-1:0;
 const shares=last.sharesOutTTM>0&&exit.shares>0?Math.pow(last.sharesOutTTM/exit.shares,1/years)-1:0;
 const dividend=clamp(stock.valuation?.dividendYield||0,0,.08);
 const fundamental=clamp(rev,-.15,.30)+clamp(margin,-.05,.06)+clamp(shares,-.05,.06)+dividend;
 let marketCagr=marketExitPrice>0?Math.pow((marketExitPrice+current*dividend*years)/current,1/years)-1:null;
 let multiple=marketCagr==null?0:marketCagr-fundamental;
 multiple=clamp(multiple,-.08,.10);
 let expected=clamp(fundamental+multiple,-.35,.35);
 if(consensus?.agreementRegime==='extreme-disagreement')expected=clamp(expected,-.25,.25);
 if(consensus?.agreementRegime==='large-disagreement')expected=clamp(expected,-.30,.30);
 const multipleShare=Math.abs(expected)>1e-6?Math.abs(multiple/expected):0;
 return {expectedCAGR:expected,uncappedMarketCAGR:marketCagr,fundamentalCAGR:fundamental,breakdown:{revenueGrowth:rev,marginExpansion:margin,shareCountEffect:shares,dividendContribution:dividend,multipleRerating:multiple},multipleDominated:multipleShare>.5,multipleShare};
}
module.exports={computeReturnEngineV2};
