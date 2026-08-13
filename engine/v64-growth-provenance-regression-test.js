'use strict';
const assert = require('assert');
const { generateBusinessForecast, assessGrowthProvenance, deriveBusinessState } = require('./business-forecast-engine');
function stock(acquisitive=false){
  const years=[];
  for(let i=0;i<6;i++){
    const revenue=1000*Math.pow(1.10,i);
    years.push({year:2020+i,revenue,fcf:revenue*.12,netIncome:revenue*.10,grossMargin:.55,opMargin:.14,roic:.20,sharesOutTTM:100,acquisitions:acquisitive&&i===5?revenue*.85:0,totalDebt:acquisitive&&i===5?revenue*.35:100});
  }
  return {ticker:acquisitive?'ACQ':'ORG',financials:{years},analystEstimates:{revenueGrowthCurrentYear:.24,revenueGrowthNextYear:.22,numAnalysts:18},valuation:{marketCap:12000,pricingPowerV2:{score:70},moat:{score:70}},reinvestmentRate:.35};
}
const organic=stock(false), acquired=stock(true);
const po=assessGrowthProvenance(organic,deriveBusinessState(organic));
const pa=assessGrowthProvenance(acquired,deriveBusinessState(acquired));
assert(pa.acquisitionDependence > po.acquisitionDependence + .25,'material acquisition should raise acquisition dependence');
const fo=generateBusinessForecast(organic,null,5,null);
const fa=generateBusinessForecast(acquired,null,5,null);
assert(fa.assumptions.provenanceHaircut > fo.assumptions.provenanceHaircut,'acquisitive growth should receive larger provenance haircut');
assert(fa.path[1] < fo.path[1],'unproven purchased growth should be underwritten below equivalent organic-looking growth');
assert(fa.assumptions.plausibilityScore < fo.assumptions.plausibilityScore,'acquisition dependence should reduce forecast plausibility until proven');
console.log('V64 growth provenance regression passed',{organic:po.acquisitionDependence,acquired:pa.acquisitionDependence,organicY2:fo.path[1],acquiredY2:fa.path[1]});
