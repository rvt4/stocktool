'use strict';
const { clamp }=require('./config');
function requiredMOS(category,q){let m=category==='Hyper Growth'?.225:category==='Growth'?.175:category==='Dividend'?.15:category==='Compounder'?.12:.20;if((q.qualityScore||50)>=85&&(q.moatScore||50)>=80)m-=.02;if((q.confidenceScore||50)<60)m+=.025;return clamp(m,.10,.30);}
function rateStock(stock,forecast,quality,v){
  const c=v.expectedCAGR,mos=v.marginOfSafety,req=requiredMOS(forecast.category,quality),q=quality.qualityScore||0;
  const rawConf=quality.confidenceScore||0,agreement=Number.isFinite(v.methodAgreementScore)?v.methodAgreementScore:50,conf=v.valuationConfidenceScore??rawConf;
  const methodCount=(v.methods||[]).length, independent=v.independentMethodCount??methodCount;
  const forecastConf=forecast.forecastReliabilityScore??rawConf;
  let rating='Unrated';
  if(!Number.isFinite(c)||!Number.isFinite(mos))rating='Unrated';
  else if(c<0)rating='Sell';
  else if(c<.08)rating='Avoid';
  else if(c<.12||mos<=0)rating='Hold';
  else if(c>=.18&&mos>=.20&&q>=78&&conf>=72&&agreement>=65&&independent>=3&&forecastConf>=65)rating='Exceptional Buy';
  else if(c>=.15&&mos>=req&&q>=68&&conf>=62&&agreement>=52&&independent>=2&&forecastConf>=58)rating='Strong Buy';
  else if(c>=.12&&mos>0&&q>=52&&conf>=52&&forecastConf>=48)rating='Buy';
  else rating='Hold';

  // Trust guardrails: weak valuation architecture may publish an estimate, but it cannot
  // receive a high-conviction recommendation.
  if(v.modelSupport==='unsupported') rating='Unrated';
  if(v.modelSupport==='limited'&&['Buy','Strong Buy','Exceptional Buy'].includes(rating))rating='Hold';
  if(forecastConf<45&&['Buy','Strong Buy','Exceptional Buy'].includes(rating))rating='Hold';
  if(v.extremeReturnFlag&&Number.isFinite(c)&&c>.35)rating='Hold';
  if(stock.sector!=='Financials'&&methodCount===1){
    const only=v.methods?.[0]?.name||'';
    if(/fallback|sales/i.test(only)&&['Buy','Strong Buy','Exceptional Buy'].includes(rating))rating='Hold';
    else if(['Strong Buy','Exceptional Buy'].includes(rating))rating='Buy';
  }
  if(agreement<35&&['Strong Buy','Exceptional Buy'].includes(rating))rating='Buy';
  if(agreement<35&&['Buy','Strong Buy','Exceptional Buy'].includes(rating))rating='Hold';

  const agreementFactor=clamp((Number.isFinite(agreement)?agreement:50)/100,.30,1);
  const methodBreadth=clamp(independent/3,0,1);
  const evidenceFactor=clamp((conf/100)*(.55+.45*methodBreadth)*(.72+.28*agreementFactor),.25,1);
  const rawInvestment=.22*clamp((c+.02)/.24,0,1)*100+.14*clamp((mos+.05)/.40,0,1)*100+.31*q+.11*(quality.moatScore||50)+.22*conf;
  // Ranking rewards returns that are both attractive and corroborated. A fragile
  // one-method point estimate should not outrank a slightly lower, well-evidenced return.
  const evidenceMultiplier=.62+.38*evidenceFactor;
  const investmentScore=Number.isFinite(c)?Math.round(clamp(rawInvestment*evidenceMultiplier,0,100)):0;
  return {rating,requiredMOS:req,investmentScore,qualifiesForBuyList:['Buy','Strong Buy','Exceptional Buy'].includes(rating),expectedAlpha:Number.isFinite(c)?c-.10:null};
}
module.exports={rateStock,requiredMOS};
