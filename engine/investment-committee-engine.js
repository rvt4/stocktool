'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function scoreReturn(r){return clamp((r+.01)/.22*100,0,100);}
function computeInvestmentCommitteeScore(stock,scenario,growthQuality,capital,competition){
 const expected=scenario?.expectedCAGR??scenario?.probabilityWeightedCAGR??stock.valuation?.returnEngineV2?.expectedCAGR??0;
 const bear=scenario?.downsideCAGR??expected-.08;
 const confidence=(scenario?.probabilities?.confidence??stock.valuation?.lifecycle?.confidence??.5)*100;
 const quality=stock.valuation?.compounder?.score??stock.valuation?.businessProfile?.qualityScore??50;
 const moat=stock.valuation?.moat?.score??50;
 const pricing=stock.valuation?.pricingPowerV2?.score??50;
 const allocation=stock.valuation?.capitalAllocation?.score??stock.valuation?.capitalAllocation??50;
 const balance=stock.valuation?.businessProfile?.balanceSheetScore??stock.balanceSheetScore??50;
 const compounding=stock.valuation?.lifecycle?.compoundingPotential??stock.valuation?.lifecycle?.growthPersistenceScore??50;
 const fv=stock.valuation?.intrinsicValue??stock.valuation?.blendedFairValue??stock.valuation?.fairValueEstimate;
 const price=stock.price?.current??stock.price;
 const mos=fv>0&&price>0?(fv-price)/fv:0;
 const downside=clamp((bear+.12)/.20*100,0,100);
 const mosScore=clamp((mos+.10)/.50*100,0,100);
 const score=Math.round(clamp(
   quality*.25 + scoreReturn(expected)*.22 + confidence*.13 + moat*.08 + pricing*.08 +
   compounding*.08 + mosScore*.07 + downside*.04 + clamp(Number(allocation)||50,0,100)*.03 +
   clamp(Number(balance)||50,0,100)*.02,
 0,100));
 return {score,grade:score>=90?'A+':score>=82?'A':score>=74?'B+':score>=66?'B':score>=54?'C':'D',components:{businessQuality:quality,expectedReturn:scoreReturn(expected),confidence,moat,pricingPower:pricing,compoundingPotential:compounding,marginOfSafety:mosScore,downsideProtection:downside,capitalAllocation:clamp(Number(allocation)||50,0,100),balanceSheet:clamp(Number(balance)||50,0,100),growthQuality:growthQuality?.score??50,capitalIntensity:capital?.score??50,competitiveDurability:competition?.score??50}};
}
module.exports={computeInvestmentCommitteeScore};
