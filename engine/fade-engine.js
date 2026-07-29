'use strict';
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
function deriveExitMultiple({current,sector,exitGrowth,lifecycle,moat,type}){
 if(!(sector>0)) return {multiple:null,reason:'missing sector anchor'};
 const stage=lifecycle?.stage||'Mature', m=clamp((moat?.score??50)/100,0,1), g=clamp((exitGrowth??.03)/.25,0,1);
 const structuralPremium=clamp((m-.45)*1.35+(g-.2)*(type==='revenueExit'?.9:.65),-.35,1.65);
 const durableAnchor=sector*(1+structuralPremium);
 const retentionBase={ 'Hyper Growth':.72,'Growth':.62,'Elite Compounder':.68,'Compounder':.55,'Dividend Compounder':.34,'Turnaround':.25,'Cyclical':.18,'Mature':.30,'Financial':.28,'Utility':.28,'Asset Heavy':.20 }[stage]??.30;
 const moatBoost=(m-.5)*.28;
 const growthBoost=g*.12;
 const retention=clamp(retentionBase+moatBoost+growthBoost,.10,.82);
 const currentBound=current>0?clamp(current,sector*.45,sector*(stage==='Hyper Growth'?4.5:stage==='Growth'?3.5:stage==='Elite Compounder'?3.2:2.4)):null;
 let multiple=currentBound?durableAnchor*(1-retention)+currentBound*retention:durableAnchor;
 const max=sector*(stage==='Hyper Growth'?4.0:stage==='Growth'?3.2:stage==='Elite Compounder'?3.0:stage==='Compounder'?2.5:1.9);
 multiple=clamp(multiple,sector*.45,max);
 return {multiple,currentMultiple:currentBound,sectorMultiple:sector,durableAnchor,retention,structuralPremium,lifecycleStage:stage,moatScore:moat?.score??null,reason:'lifecycle-moat fade'};
}
module.exports={deriveExitMultiple};
