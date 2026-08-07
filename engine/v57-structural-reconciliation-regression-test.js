'use strict';
const assert = require('assert');
const { selectValuationMethods } = require('./method-selection-engine');
const { combineValuations } = require('../valuation-methods');

function baseStock() {
  return {
    sector: 'Technology', price: { current: 100 }, analystEstimates: {},
    financials: { years: [
      { revenue:100, fcf:12, netIncome:10, ebitda:18, sharesOutTTM:10 },
      { revenue:110, fcf:13, netIncome:11, ebitda:19, sharesOutTTM:10 },
      { revenue:121, fcf:15, netIncome:12, ebitda:21, sharesOutTTM:10 },
      { revenue:133, fcf:16, netIncome:13, ebitda:23, sharesOutTTM:10 },
      { revenue:146, fcf:18, netIncome:15, ebitda:26, sharesOutTTM:10 },
    ]},
    valuation: { marketCap: 1000, industryModel:{model:'semiconductors-hardware'}, businessProfile:{forecastReliability:.8}, lifecycle:{stage:'Growth',growthPersistenceScore:65,compoundingPotential:65}, moat:{score:60}, pricingPowerV2:{score:55} }
  };
}
const stock=baseStock();
const methods={dcf:100,dcfSBCAdjusted:95,ownerEarnings:1000,revenueExit:500,epsExit:110,ebitdaExit:105};
const sel=selectValuationMethods(stock,'Growth',methods);
assert(sel.effectiveStartingWeights.ownerEarnings===0, 'low-suitability owner earnings must be hard excluded');
const blended=combineValuations(methods,'Growth',stock,stock.valuation.businessProfile,null);
assert(blended.fairValueRange && blended.fairValueRange.low < blended.blendedFairValue && blended.fairValueRange.high > blended.blendedFairValue, 'fair value range required');
assert(Math.abs(Object.values(blended.effectiveWeights).reduce((a,b)=>a+b,0)-1)<1e-9, 'weights must normalize');
console.log('V57 structural reconciliation regression test passed');
