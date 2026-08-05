'use strict';

const assert = require('assert');
const { selectedValuation } = require('./primary-valuation-engine');

function makeStock(impliedGrowth) {
  return {
    ticker: 'EXPECT', sector: 'Technology', industry: 'Software',
    price: { current: 200 },
    financials: { years: [
      { revenue: 20, fcf: 5, netIncome: 4.5, sharesOutTTM: 1, roic: .22 },
      { revenue: 22, fcf: 5.7, netIncome: 5.1, sharesOutTTM: .99, roic: .23 },
    ] },
    capitalAllocationScore: 75,
    valuation: {
      industryModel: { model: 'software' }, dividendYield: 0,
      forwardPe: 30, evRevenue: 7, marketImpliedGrowth: impliedGrowth,
      moat: { score: 78 }, pricingPowerV2: { score: 75 },
      businessProfile: { premiumPersistence: .72, forecastReliability: .80 },
      economicQuality: { overall: 78 }, compounder: { score: 80 },
    },
  };
}
const lifecycle = { stage: 'Compounder', forwardGrowth: .12, growthPersistenceScore: 75 };
const model = { projection: [
  { year: 2027, revenue: 24, fcfMargin: .27, netMargin: .23, shares: .98 },
  { year: 2028, revenue: 26.6, fcfMargin: .275, netMargin: .235, shares: .97 },
  { year: 2029, revenue: 29.4, fcfMargin: .28, netMargin: .24, shares: .96 },
  { year: 2030, revenue: 32.3, fcfMargin: .28, netMargin: .24, shares: .95 },
  { year: 2031, revenue: 35.2, fcfMargin: .28, netMargin: .24, shares: .94 },
] };
const methods = {
  dcf: { fairValuePerShare: 260, exitPricePerShare: 390 },
  dcfSBCAdjusted: { fairValuePerShare: 240, exitPricePerShare: 360 },
  ownerEarnings: { fairValuePerShare: 250, exitPricePerShare: 375 },
  revenueExit: { fairValuePerShare: 245, exitPricePerShare: 365 },
  epsExit: { fairValuePerShare: 270, exitPricePerShare: 400 },
  ebitdaExit: { fairValuePerShare: 255, exitPricePerShare: 380 },
};

const underpricedExpectations = selectedValuation({ stock: makeStock(.04), category: 'Compounder', lifecycle, methodResults: methods, model });
const demandingExpectations = selectedValuation({ stock: makeStock(.20), category: 'Compounder', lifecycle, methodResults: methods, model });
assert.ok(underpricedExpectations.marketExpectationsAdjustment > 0, 'low priced-in growth should receive only a modest positive credit');
assert.ok(underpricedExpectations.marketExpectationsAdjustment <= .018 + 1e-12, 'positive expectations credit must be capped');
assert.ok(demandingExpectations.marketExpectationsAdjustment < 0, 'demanding priced-in growth should reduce the operating anchor');
assert.ok(demandingExpectations.expectedCAGR < underpricedExpectations.expectedCAGR, 'higher market expectations must reduce expected CAGR all else equal');
assert.ok(demandingExpectations.version.includes('v51'), 'V51 valuation version should be active');
console.log('V51 expectations calibration passed', {
  favorable: underpricedExpectations.expectedCAGR,
  demanding: demandingExpectations.expectedCAGR,
  favorableAdjustment: underpricedExpectations.marketExpectationsAdjustment,
  demandingAdjustment: demandingExpectations.marketExpectationsAdjustment,
});
