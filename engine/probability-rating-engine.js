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
  const expectationRisk=n(stock.expectationRiskScore, n(stock.valuation?.expectationRisk?.score,50));
  // V43: probabilities are deliberately conservative. Expected return drives the
  // result, while quality and evidence can only modestly raise conviction. This
  // prevents ordinary good companies from displaying 97-99% certainty.
  const z =
    (er-.10)*7.0 + mos*1.15 + (quality-70)/30 + (confidence-65)/38 +
    (agreement-55)/55 - (risk-45)/30 - (expectationRisk-45)/48;
  const evidence = clamp((confidence*.45 + agreement*.35 + quality*.20)/100, .25, .95);
  const shrink = p => .50 + (p-.50) * (.45 + evidence*.45);
  const pOutperform=clamp(shrink(logistic(z)),.05,.95);
  const pPermanentLoss=clamp(logistic((risk-55)/15-(mos+.05)*2.4-(quality-70)/35),.02,.75);
  const pBeat15=clamp(shrink(logistic(z-(.15-er)*8.5)),.03,.94);
  const marketBenchmarkCAGR=.10;
  const pBeatMarket=clamp(shrink(logistic(z-(marketBenchmarkCAGR-er)*8.5)),.05,.95);
  return {version:'probability-profile-v4-expectation-risk',pPositiveReturn:pOutperform,pBeatMarket,pBeat15Cagr:pBeat15,pPermanentLoss,marketBenchmarkCAGR,modelKey:model.key,inputs:{er,mos,quality,confidence,risk,agreement,expectationRisk}};
}

function assignProbabilityRating(stock, components, probability) {
  const { model }=sectorAdjustedComposite(stock,components); const g=model.gates;
  const er=probability.inputs.er, mos=probability.inputs.mos, q=components.quality, c=components.confidence, r=components.risk;
  const bear=n(stock.scenarioAnalysis?.downsideCAGR,n(stock.valuation?.scenarioAnalysis?.downsideCAGR,-.20));
  const agreement=n(stock.methodAgreementScore,n(stock.valuation?.methodAgreementScore,0));
  const expectationRisk=n(stock.expectationRiskScore,n(stock.valuation?.expectationRisk?.score,50));
  const ic=n(stock.investmentCommitteeScore,n(stock.icScore,70));
  const years=stock.financials?.years||[];
  const recent=years.slice(-5);
  const positiveFcfRate=recent.length?recent.filter(y=>n(y.fcf,0)>0).length/recent.length:0;
  const absurdMargin=recent.some(y=>{
    const rev=n(y.revenue,0), fcf=n(y.fcf,null), ni=n(y.netIncome,null);
    return rev>0&&((fcf!=null&&Math.abs(fcf/rev)>1.5)||(ni!=null&&Math.abs(ni/rev)>1.5));
  });
  const integrityWarning=!!(stock.dataIntegrity?.decisionIntegrityWarning||stock.returnPlausibilityAdjusted||absurdMargin);
  const fragileValuation=agreement<45||integrityWarning||expectationRisk>=78;
  const highGrowth=stock.category==='Hyper Growth'||stock.category==='Growth';
  const highGrowthEvidence=!highGrowth||(positiveFcfRate>=.60&&agreement>=55&&c>=72);
  const exceptionalEvidence=agreement>=65&&ic>=70&&!integrityWarning&&highGrowthEvidence;
  const strongEvidence=agreement>=50&&ic>=60&&!integrityWarning&&highGrowthEvidence;
  // V60 rating invariants. A high-conviction label must satisfy the actual return
  // and margin-of-safety hurdle shown in the screener, not merely a sector-relative
  // composite. This prevents 14% names from becoming Strong Buy and prevents a Buy
  // when the displayed MOS is below that company's required MOS.
  const requiredMos=n(stock.requiredMarginOfSafety, n(stock.valuation?.businessEconomics?.requiredMarginOfSafety, .15));
  const exceptionalReturn=Math.max(.18,n(g.exceptionalCagr,.18));
  const strongReturn=Math.max(.15,n(g.strongCagr,.15));
  const buyReturn=.12;
  const mosPass=mos>=requiredMos;
  const exceptionalMosPass=mos>=Math.max(requiredMos,.20);
  let rating='Hold'; let reason='Expected return and evidence do not clear a higher-conviction threshold.';
  if(probability.pPermanentLoss>.52 || er<-.06 || mos<-.40){rating='Sell';reason='Downside or overvaluation risk dominates the modeled return.';}
  else if(q>=g.exceptionalQuality&&er>=exceptionalReturn&&exceptionalMosPass&&c>=78&&r<=g.maxRisk&&probability.pBeat15Cagr>=.72&&bear>=-.05&&exceptionalEvidence&&expectationRisk<55){rating='Exceptional Buy';reason='Exceptional quality, return, required margin of safety, valuation agreement and downside resilience clear every high-conviction gate.';}
  else if(q>=g.strongQuality&&er>=strongReturn&&mosPass&&c>=68&&r<=g.maxRisk+8&&probability.pBeat15Cagr>=.62&&strongEvidence&&expectationRisk<68){rating='Strong Buy';reason='Quality, at least 15% expected return, required margin of safety and evidence clear the Strong Buy gates.';}
  else if(er>=buyReturn&&mosPass&&q>=62&&c>=55&&probability.pPositiveReturn>=.58&&!fragileValuation){rating='Buy';reason='Expected return and required margin of safety are attractive, but one or more high-conviction gates remain below Strong Buy levels.';}
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
