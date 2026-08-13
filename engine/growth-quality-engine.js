'use strict';
const { assessGrowthProvenance, deriveBusinessState } = require('./business-forecast-engine');
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function computeGrowthQuality(stock,cycle,capital,competition){
 const yrs=(stock.financials?.years||[]).slice(-5); const positive=yrs.length?yrs.filter(y=>y.revenue>0).length/yrs.length:.5;
 const cash=yrs.length?yrs.filter(y=>y.fcf>0).length/yrs.length:.5;
 const gm=yrs.map(y=>y.grossMargin).filter(Number.isFinite); const stability=gm.length>1?clamp(1-(Math.max(...gm)-Math.min(...gm))/.18,0,1):.5;
 const pricing=(stock.valuation?.pricingPowerV2?.score??stock.pricingPowerScore??50)/100;
 const lifecycle=stock.valuation?.lifecycle||{};
 let cashEvidence=cash;
 let inflectionCredit=0;
 if(lifecycle.profitabilityInflection&&yrs.length>=3){
   const recent=yrs.slice(-3); const recentCash=recent.filter(y=>Number(y.fcf)>0).length/recent.length;
   cashEvidence=clamp(cash*.35+recentCash*.65,0,1);
   const first=recent[0], last=recent.at(-1);
   const firstMargin=first?.revenue>0?Number(first.fcf||0)/first.revenue:null;
   const lastMargin=last?.revenue>0?Number(last.fcf||0)/last.revenue:null;
   if(Number.isFinite(firstMargin)&&Number.isFinite(lastMargin)&&lastMargin>firstMargin+.02) inflectionCredit=6;
 }
 const provenance=assessGrowthProvenance(stock, deriveBusinessState(stock, lifecycle));
 const provenancePenalty=clamp(provenance.acquisitionDependence*16,0,16);
 const score=Math.round(clamp(positive*15+cashEvidence*20+stability*18+pricing*17+(capital?.score??50)*.15+(competition?.score??50)*.15+inflectionCredit-provenancePenalty,0,100));
 return {score,grade:score>=85?'A':score>=75?'B+':score>=65?'B':score>=50?'C':'D',cashConversionQuality:cashEvidence,historicalCashPositiveRate:cash,profitabilityInflection:!!lifecycle.profitabilityInflection,inflectionCredit,marginStability:stability,pricingContribution:pricing,cycleQuality:cycle?.quality??50,growthProvenance:provenance,provenancePenalty};
}
module.exports={computeGrowthQuality};
