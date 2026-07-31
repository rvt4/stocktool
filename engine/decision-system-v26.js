'use strict';
const { computeCapitalAllocationV2 }=require('./capital-allocation-v2');
const { sectorAdjustedComposite }=require('./sector-model-engine');
const { computeProbabilityProfile,assignProbabilityRating }=require('./probability-rating-engine');
const { buildDecisionExplanation }=require('./explainability-engine');
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function n(v,d=50){v=Number(v);return Number.isFinite(v)?v:d;}
function valuationScore(stock){
  const mos=n(stock.marginOfSafety,0); const er=n(stock.riskAdjustedExpectedReturn,n(stock.expectedReturn,0)); const agreement=n(stock.methodAgreementScore,n(stock.valuation?.methodAgreementScore,50));
  return Math.round(clamp(50+mos*75+(er-.10)*135+(agreement-50)*.18,0,100));
}
function growthScore(stock){
  const g=stock.valuation?.growthQuality?.score??stock.scenarioAnalysis?.growthQuality?.score??stock.fundamentalGrowthRate*220+45;
  return Math.round(clamp(n(g,50),0,100));
}
function applyDecisionSystemV26(stocks){
  for(const stock of stocks){
    const capital=computeCapitalAllocationV2(stock);
    const quality=Math.round(clamp(n(stock.valuation?.economicQuality?.overall,n(stock.businessQualityScore,50))*.82+capital.score*.18,0,100));
    const components={quality,growth:growthScore(stock),valuation:valuationScore(stock),risk:clamp(n(stock.downsideRiskScore,n(stock.valuation?.downside?.score,50)),0,100),confidence:clamp(n(stock.confidenceScore,50),0,100)};
    const composite=sectorAdjustedComposite(stock,components);
    const probability=computeProbabilityProfile(stock,components);
    const decision=assignProbabilityRating(stock,components,probability);
    stock.rating=decision.rating; stock.ratingReason=decision.ratingReason;
    stock.v25={version:'v26-phase-1-2-combined',components,sectorModel:composite.model.key,sectorAdjustedScore:composite.score,sectorGates:decision.sectorGates,capitalAllocation:capital,probability};
    stock.probabilityProfile=probability;
    stock.capitalAllocationScore=capital.score;
    stock.sectorAdjustedDecisionScore=composite.score;
    stock.decisionExplanation=buildDecisionExplanation(stock,components,probability,capital);
  }
  const rank={"Exceptional Buy":6,"Strong Buy":5,"Buy":4,"Hold":3,"Avoid":2,"Sell":1};
  return [...stocks].sort((a,b)=>(rank[b.rating]-rank[a.rating])||(b.sectorAdjustedDecisionScore-a.sectorAdjustedDecisionScore)||(b.expectedReturn-a.expectedReturn));
}
module.exports={applyDecisionSystemV26};
