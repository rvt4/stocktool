'use strict';
function assignSelectiveRatings(stocks){
 const e=stocks.filter(s=>s.qualifiesForBuyList&&s.dataIntegrity?.isUsable!==false&&Number.isFinite(s.riskAdjustedReturn)&&s.riskAdjustedReturn>0).sort((a,b)=>(b.portfolioManagerScore-a.portfolioManagerScore)||(b.businessQualityScore-a.businessQualityScore)),n=stocks.length,ex=Math.max(1,Math.floor(n*.01)),sb=Math.max(3,Math.floor(n*.05)),buy=Math.max(10,Math.floor(n*.20));
 e.forEach((s,i)=>{const hx=s.businessQualityScore>=82&&s.compounderScore>=78&&s.confidenceScore>=72&&s.downsideProtectionScore>=55&&s.riskAdjustedReturn>=.15,hs=s.businessQualityScore>=72&&s.compounderScore>=68&&s.confidenceScore>=62&&s.downsideProtectionScore>=42&&s.riskAdjustedReturn>=.12;s.rating=i<ex&&hx?'Exceptional':i<sb&&hs?'Strong Buy':i<buy&&s.businessQualityScore>=62&&s.riskAdjustedReturn>=.10?'Buy':'Hold/Watch';});
 const set=new Set(e);for(const s of stocks)if(!set.has(s)){const neg=(s.riskAdjustedReturn??s.expectedReturn??-1)<0,over=s.marginOfSafety!=null&&s.marginOfSafety<-.20,high=(s.downsideRiskScore??50)>=72;s.rating=neg||over||high?'Avoid':'Hold/Watch';}const t={Exceptional:5,'Strong Buy':4,Buy:3,'Hold/Watch':2,Avoid:1};return [...stocks].sort((a,b)=>(t[b.rating]-t[a.rating])||(b.portfolioManagerScore-a.portfolioManagerScore)||(b.businessQualityScore-a.businessQualityScore));
}
module.exports={assignSelectiveRatings};
