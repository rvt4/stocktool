'use strict';
function assignSelectiveRatings(stocks){
 const eligible=stocks.filter(s=>s.qualifiesForBuyList&&s.dataIntegrity?.isUsable!==false&&Number.isFinite(s.expectedReturn)&&s.expectedReturn>0)
  .sort((a,b)=>(b.portfolioManagerScore-a.portfolioManagerScore)||(b.businessQualityScore-a.businessQualityScore));
 const n=stocks.length, exceptionalSlots=Math.max(1,Math.floor(n*.005)), strongSlots=Math.max(2,Math.floor(n*.025)), buySlots=Math.max(8,Math.floor(n*.14));
 eligible.forEach((s,i)=>{
  const rq=s.returnQualityScore??s.returnEngineV2?.returnQualityScore??70;
  const multipleDominated=s.returnEngineV2?.multipleDominated===true;
  const agreement=s.methodAgreementScore??50;
  const integrity=s.dataIntegrity?.score??60;
  const success=s.successProbability??50;
  const noExtremeFlags=!(s.marginOfSafetyDistorted||s.lowConfidence);
  const exceptional=s.businessQualityScore>=88&&s.compounderScore>=82&&s.confidenceScore>=82&&s.downsideProtectionScore>=62&&s.expectedReturn>=.17&&rq>=72&&agreement>=55&&integrity>=75&&success>=72&&!multipleDominated&&noExtremeFlags;
  const strong=s.businessQualityScore>=76&&s.compounderScore>=70&&s.confidenceScore>=72&&s.downsideProtectionScore>=50&&s.expectedReturn>=.135&&rq>=60&&agreement>=35&&integrity>=65&&success>=62&&!multipleDominated;
  const buy=s.businessQualityScore>=64&&s.confidenceScore>=62&&s.downsideProtectionScore>=38&&s.expectedReturn>=.105&&rq>=50&&agreement>=20&&integrity>=55;
  s.rating=i<exceptionalSlots&&exceptional?'Exceptional':i<strongSlots&&strong?'Strong Buy':i<buySlots&&buy?'Buy':'Hold';
 });
 const set=new Set(eligible);
 for(const s of stocks) if(!set.has(s)){
  const neg=(s.expectedReturn??-1)<0, over=s.marginOfSafety!=null&&s.marginOfSafety<-.20, high=(s.downsideRiskScore??50)>=72;
  s.rating=neg||over||high?'Sell':'Hold';
 }
 for(const s of stocks){
  const er=s.expectedReturn, rank={Exceptional:6,'Strong Buy':5,Buy:4,Hold:3,Watch:2,Sell:1}[s.rating]||0;
  if(Number.isFinite(er)&&er>=.18&&rank<=3){
   s.ratingReturnMismatchReason=(s.marginOfSafety!=null&&s.marginOfSafety<0)
    ?'Modeled long-run return is positive, but the current price is above actionable fair value; valuation risk prevents a Buy rating.'
    :'High modeled return did not earn a Buy rating because quality, confidence, downside protection, valuation agreement, or return quality was insufficient.';
  }
 }
 const tier={Exceptional:6,'Strong Buy':5,Buy:4,Hold:3,Watch:2,Sell:1};
 return [...stocks].sort((a,b)=>(tier[b.rating]-tier[a.rating])||(b.portfolioManagerScore-a.portfolioManagerScore)||(b.businessQualityScore-a.businessQualityScore));
}
module.exports={assignSelectiveRatings};
