'use strict';
const { clamp, INVESTOR_ALPHA_HURDLE, INVESTOR_MARGIN_OF_SAFETY, MANUAL_CORPORATE_ACTIONS }=require('./config');

const H=INVESTOR_ALPHA_HURDLE; // single source of truth for all return tiers
function requiredMOS(){return INVESTOR_MARGIN_OF_SAFETY;}

// Build 60: analysts' estimates that include a pending or just-closed acquisition. Consensus revenue
// jumps far beyond the company's history while consensus EPS grows less than half as fast (new shares
// or debt pay for it). The SEC history and the forecast's share count/debt do not include the deal
// yet, so per-share value is overstated (KMB/Kenvue: revenue +70%, shares unchanged). Detected cases
// on results (31) were mostly real deals: KMB, KDP, OMC, SWKS, FITB, WAT, SNPS, ALSN, AMCR, RYN, IESC.
function consensusCorporateAction(stock){
  const a=stock?.analystEstimates||{}, ys=(stock?.financials?.years||[]).filter(y=>Number(y?.revenue)>0).slice(-6);
  if(ys.length<3)return null;
  const n=ys.length-1, hist=Math.pow(Number(ys.at(-1).revenue)/Number(ys[0].revenue),1/n)-1;
  for(const [rk,ek,label] of [['revenueGrowthCurrentYear','epsGrowthCurrentYear','current year'],['revenueGrowthNextYear','epsGrowthNextYear','next year']]){
    const r=Number(a[rk]), e=Number(a[ek]);
    if(Number.isFinite(r)&&Number.isFinite(e)&&r>=.35&&r>=hist+.25&&e<.5*r)
      return {period:label,consensusRevenueGrowth:r,consensusEPSGrowth:e,historicalRevenueCAGR:hist,
        reason:`Analysts expect revenue ${Math.round(r*100)}% higher (${label}) but EPS only ${Math.round(e*100)}%, versus ${Math.round(hist*100)}%/yr history: likely a pending or recent acquisition the filings don't reflect yet`};
  }
  return null;
}

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
  const underwritingCAGR=Number.isFinite(v.underwrittenCAGR)?v.underwrittenCAGR:c;
  const underwritingFlags=v.underwriting?.flags||[];

  // Recommendation contract: a stock is not a Buy until today's price is at/below
  // the STRESSED-case 11% hurdle price AFTER the investor's additional margin of safety (10%).
  let rating='Unrated';
  if(!Number.isFinite(c)||!Number.isFinite(mos)) rating='Unrated';
  else if(c<0) rating='Sell';
  else if(c<Math.min(.08,H-.03)) rating='Avoid';
  else if(meetsFinalBuyPrice&&c>=H+.03&&q>=82&&conf>=75&&agreement>=68&&independent>=3&&forecastConf>=68) rating='Exceptional Buy';
  else if(meetsFinalBuyPrice&&c>=H&&q>=72&&conf>=65&&agreement>=55&&independent>=2&&forecastConf>=60) rating='Strong Buy';
  else if(meetsFinalBuyPrice&&c>=H&&q>=58&&conf>=55&&forecastConf>=52) rating='Buy';
  else if((c>=H||meetsHurdlePrice)&&mos>0) rating='Watch';
  else rating='Hold';

  // Trust guardrails remain recommendation gates. They intentionally do not become
  // large additive ranking weights: the validation lab showed that evidence/confidence
  // is most useful after an attractive expected-return opportunity already exists.
  if(v.modelSupport==='unsupported') rating='Unrated';
  // A Buy must survive the same stressed scenario used for the investor entry price.
  if(['Buy','Strong Buy','Exceptional Buy'].includes(rating)&&underwritingCAGR<H) rating='Watch';
  if(['Strong Buy','Exceptional Buy'].includes(rating)&&underwritingFlags.length>=2) rating='Buy';
  if(v.modelSupport==='limited'&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(forecastConf<45&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(v.extremeReturnFlag&&Number.isFinite(c)&&c>.35) rating='Watch';
  if(stock.sector!=='Financials'&&methodCount===1&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  if(agreement<35&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  // A premium Buy requires some resilience to a 20% terminal-multiple miss.
  // Methods are correlated (they share the same operating forecast), so agreement
  // alone cannot substitute for this downside sensitivity check.
  const stressedCAGR=v.multipleSensitivity?.down20CAGR;
  if(['Exceptional Buy','Strong Buy'].includes(rating)&&Number.isFinite(stressedCAGR)&&stressedCAGR<H) rating='Buy';
  if(rating==='Buy'&&Number.isFinite(stressedCAGR)&&stressedCAGR<H-.05) rating='Watch';
  // Extraordinary modeled returns warrant independent assumption review even when
  // their algebra is internally consistent.
  if(v.extremeReturnFlag&&Number.isFinite(c)&&c>.22&&forecastConf<70&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';

  // Build 29: a Buy cannot rest on a fair value the market's own analysts put at less than half.
  if(v.analystCheck?.divergence==='model_far_above_analysts'&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  // A large implied re-rating is not independent confirmation from three methods:
  // all methods share the same operating forecast and related exit assumptions.
  // Keep such names researchable, but do not label them decision-ready Buys.
  if(v.reratingRelianceFlag&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';
  // The five-year checkpoint is a diagnostic, not a separate investment thesis.
  // Large disagreement means the timing of returns is too uncertain for a premium label.
  if(v.horizonDivergenceFlag&&['Exceptional Buy','Strong Buy'].includes(rating)) rating='Buy';
  const manual=MANUAL_CORPORATE_ACTIONS?.[String(stock?.ticker||'').toUpperCase()];
  const filed=stock?.filingCorporateAction?.pending?{source:'sec_8k_item_2.01',reason:stock.filingCorporateAction.reason,events:stock.filingCorporateAction.events}:null;
  const corporateAction=manual?{manual:true,reason:manual}:(filed||consensusCorporateAction(stock));
  if(corporateAction&&['Buy','Strong Buy','Exceptional Buy'].includes(rating)) rating='Watch';

  // v12.37 hierarchical ranking architecture.
  // 1) Opportunity comes first. Expected CAGR is deliberately dominant; MOS and entry
  //    readiness add context without allowing a wonderful-but-expensive company to win.
  const returnScore=Number.isFinite(underwritingCAGR)?clamp((underwritingCAGR-.04)/.20,0,1)*100:0; // 4% -> 0, 24% -> 100
  const mosScore=Number.isFinite(mos)?clamp(mos/.35,0,1)*100:0;
  const entryScore=meetsFinalBuyPrice?100:meetsHurdlePrice?70:(Number.isFinite(c)&&c>=H&&mos>0?45:15);
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
    underwrittenCAGR:underwritingCAGR,underwritingFlags,
    expectedAlpha:Number.isFinite(c)?c-INVESTOR_ALPHA_HURDLE:null,
    corporateAction
  };
}
module.exports={rateStock,requiredMOS,consensusCorporateAction};
