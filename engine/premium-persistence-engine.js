'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function median(a){const v=(a||[]).filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}
function computePremiumPersistence(stock, profile={}, lifecycle={}, moat={}){
  const years=(stock.financials?.years||[]).slice(-7);
  const roics=years.map(y=>y.roic).filter(Number.isFinite);
  const gross=years.map(y=>y.grossMargin).filter(Number.isFinite);
  const op=years.map(y=>y.operatingMargin).filter(Number.isFinite);
  const fcf=years.map(y=>y.fcfMargin ?? (y.revenue>0&&Number.isFinite(y.fcf)?y.fcf/y.revenue:null)).filter(Number.isFinite);
  const recurring=clamp(profile.recurringRevenue ?? profile.recurringRevenueScore ?? .5,0,1);
  const moat01=clamp((moat.score ?? profile.moatScore*100 ?? 50)/100,0,1);
  const pricing=clamp((stock.valuation?.pricingPowerV2?.score ?? stock.pricingPowerScore ?? 50)/100,0,1);
  const roicMed=median(roics); const roicScore=roicMed==null?.5:clamp((roicMed-.08)/.32,0,1);
  const stability=a=>{if(a.length<3)return .5;const avg=a.reduce((s,x)=>s+x,0)/a.length;const dev=Math.sqrt(a.reduce((s,x)=>s+(x-avg)**2,0)/a.length);return clamp(1-dev/.10,0,1);};
  const marginStability=(stability(gross)+stability(op)+stability(fcf))/3;
  const reliability=clamp(profile.forecastReliability ?? .5,0,1);
  const capitalLight=clamp(1-(profile.capitalIntensity ?? .5),0,1);
  const stage=lifecycle.stage||lifecycle.name||'';
  const stageAdj=/Hyper Growth|Growth|Compounder|Elite/.test(stage)?.05:/Cyclical|Turnaround/.test(stage)?-.06:0;
  const score=clamp(moat01*.24+pricing*.16+roicScore*.18+marginStability*.14+recurring*.12+reliability*.10+capitalLight*.06+stageAdj,0,1);
  return {score,retainedPremium:clamp(.18+score*.68,.18,.86),expectedFade:1-clamp(.18+score*.68,.18,.86),components:{moat:moat01,pricingPower:pricing,roicPersistence:roicScore,marginStability,recurringRevenue:recurring,forecastReliability:reliability,capitalLight}};
}
module.exports={computePremiumPersistence};
