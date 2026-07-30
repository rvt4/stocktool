'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function assessCompetitivePressure(stock,profile={},pricing={}){
 const moat=(stock.valuation?.moat?.score??(profile.moatScore??.5)*100)/100;
 const pp=(pricing.score??stock.valuation?.pricingPowerV2?.score??stock.pricingPowerScore??50)/100;
 const margins=(stock.financials?.years||[]).slice(-5).map(y=>y.grossMargin).filter(Number.isFinite);
 const erosion=margins.length>1?Math.max(0,margins[0]-margins.at(-1)):0;
 const pressure=clamp((1-moat)*.42+(1-pp)*.33+clamp(erosion/.08,0,1)*.25,0,1);
 return {score:Math.round((1-pressure)*100),pressure,annualMarginFade:clamp(pressure*.008,0,.008),growthFadeMultiplier:1+pressure*.55,premiumRetentionMultiplier:clamp(1-pressure*.38,.62,1)};
}
module.exports={assessCompetitivePressure};
