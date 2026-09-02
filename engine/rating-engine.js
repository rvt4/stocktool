'use strict';
const { clamp, INVESTOR_ALPHA_HURDLE }=require('./config');

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

  // Recommendation contract: a stock is not a Buy until today's price is at/below
  // the 15% CAGR hurdle price AFTER the investor's additional 20% margin of safety.
  let rating='Unrated';
  if(!Number.isFinite(c)||!Number.isFinite(mos)) rating='Unrated';
  else if(c<0) rating='Sell';
  else if(c<.08) rating='Avoid';
  else if(meetsFinalBuyPrice&&c>=.18&&q>=82&&conf>=75&&agreement>=68&&independent>=3&&forecastConf>=68) rating='Exceptional Buy';
  else if(meetsFinalBuyPrice&&c>=.15&&q>=72&&conf>=65&&agreement>=55&&independent>=2&&forecastConf>=60) rating='Strong Buy';
  else if(meetsFinalBuyPrice&&c>=.15&&q>=58&&conf>=55&&forecastConf>=52) rating='Buy';
  else if((c>=.15||meetsHurdlePrice)&&mos>0) rating='Watch';
  else rating='Hold';

  // Trust guardrails remain recommendation gates. They intentionally do not become
  // large additive ranking weights: the validation lab showed that evidence/confidence
  // is most useful after an attractive expected-return opportunity already exists.
  if(v.modelSupport==='unsupported') rating='Unrated';
  if(v.modelSupport==='limited'&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(forecastConf<45&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(v.extremeReturnFlag&&Number.isFinite(c)&&c>.35) rating='Watch';
  if(stock.sector!=='Financials'&&methodCount===1&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(agreement<35&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';

  // v12.37 hierarchical ranking architecture.
  // 1) Opportunity comes first. Expected CAGR is deliberately dominant; MOS and entry
  //    readiness add context without allowing a wonderful-but-expensive company to win.
  const returnScore=Number.isFinite(c)?clamp((c-.04)/.20,0,1)*100:0; // 4% -> 0, 24% -> 100
  const mosScore=Number.isFinite(mos)?clamp(mos/.35,0,1)*100:0;
  const entryScore=meetsFinalBuyPrice?100:meetsHurdlePrice?70:(Number.isFinite(c)&&c>=.15&&mos>0?45:15);
  const opportunityScore=.78*returnScore+.17*mosScore+.05*entryScore;

  // 2) Business quality differentiates genuinely attractive opportunities. The weights
  //    are intentionally broad/economic rather than optimized to the validation sample.
  const opportunityQualityScore=
      .20*(quality.qualityScore||50)
    + .20*(quality.growthQualityScore||50)
    + .18*(quality.moatScore||50)
    + .15*(quality.compounderScore||50)
    + .10*(quality.pricingPowerScore||50)
    + .10*(quality.capitalAllocationScore||50)
    + .07*(quality.protectionScore||50);

  // Quality influence ramps in only as expected return becomes compelling. This avoids
  // rewarding quality by itself when price leaves too little prospective return.
  // 13% CAGR -> no quality tilt; 20% CAGR -> full quality tilt; smooth in between.
  const qualityActivation=Number.isFinite(c)?clamp((c-.13)/.07,0,1):0;
  const activatedQuality=50+qualityActivation*(opportunityQualityScore-50);

  // 3) Reliability is a small modifier, not a primary source of rank. Existing hard
  //    recommendation guardrails above still block fragile valuations from becoming Buys.
  const breadthScore=clamp(independent/3,0,1)*100;
  const reliabilityScore=.50*forecastConf+.25*conf+.15*agreement+.10*breadthScore;
  const reliabilityMultiplier=.985+.03*clamp(reliabilityScore/100,0,1); // only +/-1.5%

  let rawInvestment=(.78*opportunityScore+.22*activatedQuality)*reliabilityMultiplier;
  if(v.modelSupport==='limited') rawInvestment*=.94;
  if(v.modelSupport==='unsupported') rawInvestment=0;
  const investmentScore=Number.isFinite(c)?Math.round(clamp(rawInvestment,0,100)):0;

  // Retain a diagnostic evidence score for UI/auditing, but do not let it dominate rank.
  const evidenceScore=Math.round(clamp(.40*forecastConf+.25*conf+.20*breadthScore+.15*agreement,0,100));

  return {
    rating,requiredMOS:req,investmentScore,
    opportunityScore:Math.round(clamp(opportunityScore,0,100)),
    opportunityQualityScore:Math.round(clamp(opportunityQualityScore,0,100)),
    activatedQualityScore:Math.round(clamp(activatedQuality,0,100)),
    qualityActivation,
    reliabilityScore:Math.round(clamp(reliabilityScore,0,100)),
    qualifiesForBuyList:['Buy','Strong Buy','Exceptional Buy'].includes(rating),
    meetsInvestorBuyPrice:meetsFinalBuyPrice,
    meetsHurdlePrice,
    evidenceScore,
    expectedAlpha:Number.isFinite(c)?c-INVESTOR_ALPHA_HURDLE:null
  };
}
module.exports={rateStock,requiredMOS};
