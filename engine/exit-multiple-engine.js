'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
const CEILINGS={
  epsExit:[[0.05,18],[0.08,22],[0.12,28],[0.18,35],[0.25,45],[1,55]],
  ebitdaExit:[[0.05,10],[0.08,13],[0.12,17],[0.18,22],[0.25,28],[1,34]],
  revenueExit:[[0.05,2.5],[0.08,4],[0.12,6],[0.18,9],[0.25,13],[1,18]],
};
function growthCeiling(type,g){const rows=CEILINGS[type]||CEILINGS.epsExit;const x=Math.max(-.2,g||0);for(const [cut,cap] of rows)if(x<=cut)return cap;return rows.at(-1)[1];}
function applyExitMultipleDiscipline({type,rawMultiple,exitGrowth,quality=0.5,forecastReliability=0.5,industry=null}){
 if(!(rawMultiple>0))return {multiple:null,rawMultiple,ceiling:null,wasCapped:false};
 let ceiling=growthCeiling(type,exitGrowth);
 const qualityAdj=clamp(0.86+quality*0.22+forecastReliability*0.08,0.82,1.14);
 ceiling*=qualityAdj;
 if(industry==='semiconductors-hardware') {
   const durableLeader = quality >= 0.72 && forecastReliability >= 0.58 && exitGrowth >= 0.10;
   ceiling *= type==='revenueExit' ? (durableLeader ? 0.96 : 0.86) : (durableLeader ? 1.05 : 0.94);
 }
 if(industry==='financials'&&type==='revenueExit') ceiling*=0.55;
 const floor=type==='epsExit'?7:type==='ebitdaExit'?5:0.7;
 const multiple=clamp(rawMultiple,floor,ceiling);
 return {multiple,rawMultiple,ceiling,wasCapped:multiple<rawMultiple,qualityAdj};
}
module.exports={growthCeiling,applyExitMultipleDiscipline};
