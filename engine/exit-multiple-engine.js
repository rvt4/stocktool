'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
const CEILINGS={
  epsExit:[[0.05,18],[0.08,22],[0.12,28],[0.18,35],[0.25,45],[1,55]],
  ebitdaExit:[[0.05,10],[0.08,13],[0.12,17],[0.18,22],[0.25,28],[1,34]],
  revenueExit:[[0.05,2.5],[0.08,4],[0.12,6],[0.18,9],[0.25,13],[1,18]],
};
function growthCeiling(type,g){const rows=CEILINGS[type]||CEILINGS.epsExit;const x=Math.max(-.2,g||0);for(const [cut,cap] of rows)if(x<=cut)return cap;return rows.at(-1)[1];}
function applyExitMultipleDiscipline({type,rawMultiple,exitGrowth,valuationGrowth=null,quality=0.5,forecastReliability=0.5,premiumPersistence=0.5,lifecycleStage='Mature',sectorMultiple=null,industry=null}){
 if(!(rawMultiple>0))return {multiple:null,rawMultiple,ceiling:null,wasCapped:false};
 const effectiveGrowth=clamp((exitGrowth??0)*0.55+(valuationGrowth??exitGrowth??0)*0.45,-0.2,0.5);
 let ceiling=growthCeiling(type,effectiveGrowth);
 const persistence=clamp(premiumPersistence,0,1);
 const qualityAdj=clamp(0.84+quality*0.20+forecastReliability*0.07+persistence*0.13,0.82,1.22);
 ceiling*=qualityAdj;
 if(industry==='semiconductors-hardware') {
   const durableLeader = quality >= 0.68 && forecastReliability >= 0.52 && (effectiveGrowth >= 0.08 || persistence >= 0.58);
   ceiling *= type==='revenueExit' ? (durableLeader ? 0.96 : 0.86) : (durableLeader ? 1.05 : 0.94);
 }
 if(industry==='financials'&&type==='revenueExit') ceiling*=0.55;
 const genericFloor=type==='epsExit'?7:type==='ebitdaExit'?5:0.7;
 // Premium-persistence floor: elite businesses should not be forced all the way
 // to a generic sector multiple merely because the explicit forecast reaches a
 // slower terminal year. The floor is deliberately modest and only activates
 // when quality, persistence and reliability jointly support it.
 const durableStage=['Growth','Hyper Growth','Elite Compounder','Compounder','Temporary Disruption'].includes(lifecycleStage);
 const support=clamp((quality-0.55)*1.35+(persistence-0.50)*1.15+(forecastReliability-0.50)*0.65,0,1);
 let premiumFloor=genericFloor;
 if(durableStage&&sectorMultiple>0&&support>0){
   const sectorRetention=type==='epsExit' ? (0.58+0.24*support) : type==='ebitdaExit' ? (0.56+0.22*support) : (0.52+0.20*support);
   premiumFloor=Math.max(premiumFloor,sectorMultiple*sectorRetention);
 }
 const boundedCeiling=Math.max(ceiling,premiumFloor);
 const multiple=clamp(rawMultiple,premiumFloor,boundedCeiling);
 return {multiple,rawMultiple,ceiling:boundedCeiling,premiumFloor,wasCapped:multiple<rawMultiple,wasFloored:multiple>rawMultiple,qualityAdj,effectiveGrowth,premiumPersistence:persistence};
}
module.exports={growthCeiling,applyExitMultipleDiscipline};
