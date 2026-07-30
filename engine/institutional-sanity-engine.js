'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function applyInstitutionalSanity(stock, scenario, agreementScore=50){
  if(!scenario||!Number.isFinite(scenario.probabilityWeightedCAGR)) return scenario;
  const marketCap=stock.valuation?.marketCap ?? stock.marketCap ?? 0;
  const category=stock.valuation?.category || 'Value';
  const methodAgreement=clamp((agreementScore??50)/100,0,1);
  const confidence=clamp(scenario.probabilities?.confidence??.5,0,1);
  let ceiling=/Hyper Growth/.test(category)?.30:/Growth/.test(category)?.25:/Cyclical|Turnaround/.test(category)?.22:.20;
  if(marketCap>150e9) ceiling-=.025; else if(marketCap>50e9) ceiling-=.015; else if(marketCap>15e9) ceiling-=.005;
  if(methodAgreement>.75&&confidence>.72) ceiling+=.02;
  if(methodAgreement<.50) ceiling-=.025;
  const raw=scenario.probabilityWeightedCAGR;
  const adjusted=Math.min(raw,ceiling);
  return {...scenario,rawProbabilityWeightedCAGR:raw,probabilityWeightedCAGR:adjusted,expectedCAGR:adjusted,plausibilityCeiling:ceiling,plausibilityCapped:adjusted<raw-1e-9};
}
module.exports={applyInstitutionalSanity};
