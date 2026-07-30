'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function computeGrowthQuality(stock,cycle,capital,competition){
 const yrs=(stock.financials?.years||[]).slice(-5); const positive=yrs.length?yrs.filter(y=>y.revenue>0).length/yrs.length:.5;
 const cash=yrs.length?yrs.filter(y=>y.fcf>0).length/yrs.length:.5;
 const gm=yrs.map(y=>y.grossMargin).filter(Number.isFinite); const stability=gm.length>1?clamp(1-(Math.max(...gm)-Math.min(...gm))/.18,0,1):.5;
 const pricing=(stock.valuation?.pricingPowerV2?.score??stock.pricingPowerScore??50)/100;
 const score=Math.round(clamp(positive*15+cash*20+stability*18+pricing*17+(capital?.score??50)*.15+(competition?.score??50)*.15,0,100));
 return {score,grade:score>=85?'A':score>=75?'B+':score>=65?'B':score>=50?'C':'D',cashConversionQuality:cash,marginStability:stability,pricingContribution:pricing,cycleQuality:cycle?.quality??50};
}
module.exports={computeGrowthQuality};
