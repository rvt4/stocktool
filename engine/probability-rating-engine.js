'use strict';
const { resolveSectorModel, sectorAdjustedComposite } = require('./sector-model-engine');
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function logistic(x){return 1/(1+Math.exp(-x));}
function n(v,d=0){v=Number(v);return Number.isFinite(v)?v:d;}

function computeProbabilityProfile(stock, components) {
  const model=resolveSectorModel(stock);
  const er=n(stock.riskAdjustedExpectedReturn, n(stock.expectedReturn, n(stock.valuation?.expectedReturnProfile?.riskAdjustedCAGR,0)));
  const mos=n(stock.marginOfSafety,0);
  const quality=components.quality;
  const confidence=components.confidence;
  const risk=components.risk;
  const agreement=n(stock.methodAgreementScore, n(stock.valuation?.methodAgreementScore,50));
  const z =
    (er-.10)*9.5 + mos*2.2 + (quality-70)/18 + (confidence-65)/24 + (agreement-55)/35 - (risk-45)/24;
  const pOutperform=clamp(logistic(z),.01,.99);
  const pPermanentLoss=clamp(logistic((risk-52)/13-(mos+.05)*3.0-(quality-70)/30),.01,.85);
  const pBeat15=clamp(logistic(z-(.15-er)*7.5),.01,.99);
  return {version:'probability-profile-v1',pPositiveReturn:pOutperform,pBeat15Cagr:pBeat15,pPermanentLoss,modelKey:model.key,inputs:{er,mos,quality,confidence,risk,agreement}};
}

function assignProbabilityRating(stock, components, probability) {
  const { model }=sectorAdjustedComposite(stock,components); const g=model.gates;
  const er=probability.inputs.er, mos=probability.inputs.mos, q=components.quality, c=components.confidence, r=components.risk;
  const bear=n(stock.scenarioAnalysis?.downsideCAGR,n(stock.valuation?.scenarioAnalysis?.downsideCAGR,-.20));
  const agreement=n(stock.methodAgreementScore,n(stock.valuation?.methodAgreementScore,0));
  const ic=n(stock.investmentCommitteeScore,n(stock.icScore,70));
  const years=stock.financials?.years||[];
  const recent=years.slice(-5);
  const positiveFcfRate=recent.length?recent.filter(y=>n(y.fcf,0)>0).length/recent.length:0;
  const absurdMargin=recent.some(y=>{
    const rev=n(y.revenue,0), fcf=n(y.fcf,null), ni=n(y.netIncome,null);
    return rev>0&&((fcf!=null&&Math.abs(fcf/rev)>1.5)||(ni!=null&&Math.abs(ni/rev)>1.5));
  });
  const integrityWarning=!!(stock.dataIntegrity?.decisionIntegrityWarning||stock.returnPlausibilityAdjusted||absurdMargin);
  const fragileValuation=agreement<45||integrityWarning;
  const highGrowth=stock.category==='Hyper Growth'||stock.category==='Growth';
  const highGrowthEvidence=!highGrowth||(positiveFcfRate>=.60&&agreement>=55&&c>=72);
  const exceptionalEvidence=agreement>=65&&ic>=70&&!integrityWarning&&highGrowthEvidence;
  const strongEvidence=agreement>=50&&ic>=60&&!integrityWarning&&highGrowthEvidence;
  let rating='Hold'; let reason='Expected return and evidence do not clear a higher-conviction threshold.';
  if(probability.pPermanentLoss>.52 || er<-.06 || mos<-.40){rating='Sell';reason='Downside or overvaluation risk dominates the modeled return.';}
  else if(q>=g.exceptionalQuality&&er>=g.exceptionalCagr&&mos>=.20&&c>=78&&r<=g.maxRisk&&probability.pBeat15Cagr>=.72&&bear>=-.05&&exceptionalEvidence){rating='Exceptional Buy';reason='Exceptional quality, valuation agreement, downside resilience and return probability all clear the high-conviction gates.';}
  else if(q>=g.strongQuality&&er>=g.strongCagr&&mos>=.12&&c>=68&&r<=g.maxRisk+8&&probability.pBeat15Cagr>=.62&&strongEvidence){rating='Strong Buy';reason='Quality, valuation agreement and probability-weighted return clear the sector-specific high-conviction gates.';}
  else if(er>=.115&&q>=62&&c>=55&&probability.pPositiveReturn>=.58&&!fragileValuation){rating='Buy';reason='Expected return is attractive, but one or more conviction gates remain below Strong Buy levels.';}
  else if(fragileValuation&&er>=.075){rating='Hold';reason='The modeled return may be attractive, but valuation agreement or data integrity is too weak for a Buy rating.';}
  // Distinguish a poor business from an excellent business at an unattractive
  // price. High-quality companies with a non-negative modeled return remain Hold
  // unless permanent-loss risk is genuinely elevated.
  else if(q>=80 && er>=0 && probability.pPermanentLoss<.30){rating='Hold';reason='High-quality business, but the current valuation does not offer enough expected return for new capital.';}
  else if(probability.pPermanentLoss>.36 || er<.04){rating='Avoid';reason='The risk-adjusted return is insufficient for new capital.';}
  else if(er>=.075&&probability.pPositiveReturn>=.50){rating='Hold';reason='The company may be investable, but the current price does not offer enough return or certainty.';}
  return {rating,ratingReason:reason,sectorGates:g};
}
module.exports={computeProbabilityProfile,assignProbabilityRating};
