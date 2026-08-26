'use strict';
const { clamp }=require('./config');

function requiredMOS(){return .20;}

function rateStock(stock,forecast,quality,v){
  const c=v.expectedCAGR, mos=v.marginOfSafety, req=requiredMOS(), q=quality.qualityScore||0;
  const price=Number(stock?.price?.current), finalBuyPrice=Number(v.requiredReturnBuyPrice), hurdlePrice=Number(v.hurdleReturnPrice);
  const meetsFinalBuyPrice=price>0&&finalBuyPrice>0&&price<=finalBuyPrice;
  const meetsHurdlePrice=price>0&&hurdlePrice>0&&price<=hurdlePrice;
  const rawConf=quality.confidenceScore||0;
  const agreement=Number.isFinite(v.methodAgreementScore)?v.methodAgreementScore:50;
  const conf=v.valuationConfidenceScore??rawConf;
  const methodCount=(v.methods||[]).length, independent=v.independentMethodCount??methodCount;
  const forecastConf=forecast.forecastReliabilityScore??rawConf;

  // The recommendation contract is intentionally stricter than the valuation contract:
  // a stock is not a Buy until today's price is at/below the 15% CAGR hurdle price AFTER
  // the investor's additional 20% margin of safety. Stocks that are attractive but have
  // not reached that entry price are Watch, not Buy.
  let rating='Unrated';
  if(!Number.isFinite(c)||!Number.isFinite(mos)) rating='Unrated';
  else if(c<0) rating='Sell';
  else if(c<.08) rating='Avoid';
  else if(meetsFinalBuyPrice&&c>=.18&&q>=82&&conf>=75&&agreement>=68&&independent>=3&&forecastConf>=68) rating='Exceptional Buy';
  else if(meetsFinalBuyPrice&&c>=.15&&q>=72&&conf>=65&&agreement>=55&&independent>=2&&forecastConf>=60) rating='Strong Buy';
  else if(meetsFinalBuyPrice&&c>=.15&&q>=58&&conf>=55&&forecastConf>=52) rating='Buy';
  else if((c>=.15||meetsHurdlePrice)&&mos>0) rating='Watch';
  else rating='Hold';

  // Trust guardrails. Fragile valuation architecture can remain useful for research,
  // but cannot become an actionable Buy solely because its point estimate is large.
  if(v.modelSupport==='unsupported') rating='Unrated';
  if(v.modelSupport==='limited'&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(forecastConf<45&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(v.extremeReturnFlag&&Number.isFinite(c)&&c>.35) rating='Watch';
  if(stock.sector!=='Financials'&&methodCount===1&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(agreement<35&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';

  // Evidence-adjusted research score. Expected upside matters, but corroboration,
  // business quality and forecast reliability matter more than a fragile headline CAGR.
  const agreementFactor=clamp((Number.isFinite(agreement)?agreement:50)/100,.25,1);
  const breadthFactor=clamp(independent/3,.20,1);
  const forecastFactor=clamp(forecastConf/100,.30,1);
  const confidenceFactor=clamp(conf/100,.30,1);
  const evidenceFactor=clamp(.30*confidenceFactor+.25*forecastFactor+.25*breadthFactor+.20*agreementFactor,.25,1);

  const returnScore=clamp((c+.02)/.24,0,1)*100;
  const fairValueScore=clamp((mos+.05)/.40,0,1)*100;
  // Entry readiness is deliberately binary-ish: reaching the MOS-adjusted buy price is
  // meaningful, while merely reaching the raw 15% hurdle price is useful but not a Buy.
  const entryScore=meetsFinalBuyPrice?100:meetsHurdlePrice?65:(c>=.15&&mos>0?45:20);
  const rawInvestment=.20*returnScore+.08*fairValueScore+.30*q+.10*(quality.moatScore||50)+.12*forecastConf+.10*conf+.10*entryScore;
  const evidenceMultiplier=.55+.45*evidenceFactor;
  const investmentScore=Number.isFinite(c)?Math.round(clamp(rawInvestment*evidenceMultiplier,0,100)):0;

  return {
    rating,requiredMOS:req,investmentScore,
    qualifiesForBuyList:['Buy','Strong Buy','Exceptional Buy'].includes(rating),
    meetsInvestorBuyPrice:meetsFinalBuyPrice,
    meetsHurdlePrice,
    evidenceScore:Math.round(evidenceFactor*100),
    expectedAlpha:Number.isFinite(c)?c-.10:null
  };
}
module.exports={rateStock,requiredMOS};
