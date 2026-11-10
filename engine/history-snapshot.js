'use strict';
const fs=require('fs');
const path=require('path');
function finite(v){return Number.isFinite(Number(v))?Number(v):null;}
function compact(s){return {
  ticker:s.ticker,sector:s.sector,rank:s.overallRank,rating:s.rating,price:finite(s.currentPrice),
  investmentScore:finite(s.investmentScore),expectedCAGR:finite(s.expectedReturn),expectedAlpha:finite(s.expectedAlpha),
  fiveYearExpectedCAGR:finite(s.fiveYearExpectedCAGR),bearCAGR:finite(s.bearCAGR),bullCAGR:finite(s.bullCAGR),
  fairValue:finite(s.fairValueEstimate),buyPrice:finite(s.requiredReturnBuyPrice),marginOfSafety:finite(s.marginOfSafety),
  qualityScore:finite(s.qualityScore),moatScore:finite(s.moatScore),pricingPowerScore:finite(s.pricingPowerV2Score),
  capitalAllocationScore:finite(s.capitalAllocationScore),forecastConfidence:finite(s.forecastReliabilityScore??s.forecastConfidenceScore),
  valuationConfidence:finite(s.valuationConfidenceScore),methodAgreement:finite(s.methodAgreementScore),methodCount:finite(s.methodCount),
  independentEvidenceFamilies:finite(s.independentMethodCount),modelSupport:s.modelSupport||null,
  portfolioAction:s.portfolioAction||null,newPositionAction:s.newPositionAction||null,existingHolderAction:s.existingHolderAction||null,
  suggestedInitialWeight:finite(s.suggestedInitialWeight),rideWinner:s.rideWinner===true,
  momentumRel6:finite(s.momentum?.rel6),momentumRel12:finite(s.momentum?.rel12),
  // Build 65: saved nightly so estimate REVISIONS (the earliest growth signal) become testable over time,
  // and the Growth Inflection list builds a real-time track record.
  est:s.analystEstimates?{eps0:finite(s.analystEstimates.epsCurrentYear),eps1:finite(s.analystEstimates.epsNextYear),
    rev0:finite(s.analystEstimates.revenueCurrentYear),rev1:finite(s.analystEstimates.revenueNextYear),
    tgt:finite(s.analystEstimates.analystTargetMean),n:finite(s.analystEstimates.numAnalysts)}:null,
  growthScore:finite(s.growth?.score),growthRank:finite(s.growth?.rank)
};}
function writeProspectiveSnapshot(root,output){
  if(!output?.generatedAt||!Array.isArray(output.stocks))return null;
  const day=String(output.generatedAt).slice(0,10),dir=path.join(root,'data','history');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`${day}.json`),tmp=file+'.tmp';
  const body={generatedAt:output.generatedAt,modelVersion:output.modelVersion,count:output.stocks.length,mode:'live_full_model',stocks:output.stocks.map(compact)};
  fs.writeFileSync(tmp,JSON.stringify(body));fs.renameSync(tmp,file);return file;
}
module.exports={writeProspectiveSnapshot};
