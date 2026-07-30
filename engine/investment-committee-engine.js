'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function scoreReturn(r){return clamp((r+.02)/.24*100,0,100);}
function computeInvestmentCommitteeScore(stock,scenario,growthQuality,capital,competition){
 const expected=scenario?.expectedCAGR??stock.valuation?.returnEngineV2?.expectedCAGR??0;
 const bear=scenario?.downsideCAGR??expected-.08; const confidence=(scenario?.probabilities?.confidence??.5)*100;
 const quality=stock.valuation?.compounder?.score??50; const mos=stock.valuation?.fairValueEstimate>0?(stock.valuation.fairValueEstimate-stock.price.current)/stock.valuation.fairValueEstimate:0;
 const downside=clamp((bear+.15)/.22*100,0,100); const mosScore=clamp((mos+.15)/.55*100,0,100);
 const score=Math.round(clamp(scoreReturn(expected)*.30+confidence*.18+quality*.16+mosScore*.13+(growthQuality?.score??50)*.10+downside*.08+(capital?.score??50)*.03+(competition?.score??50)*.02,0,100));
 return {score,grade:score>=88?'A+':score>=80?'A':score>=72?'B+':score>=64?'B':score>=52?'C':'D',components:{expectedReturn:scoreReturn(expected),confidence,quality,marginOfSafety:mosScore,growthQuality:growthQuality?.score??50,downsideProtection:downside,capitalIntensity:capital?.score??50,competitiveDurability:competition?.score??50}};
}
module.exports={computeInvestmentCommitteeScore};
