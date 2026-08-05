'use strict';

const assert = require('assert');
const { selectedValuation } = require('./primary-valuation-engine');

const stock = {
  ticker: 'LINK',
  sector: 'Technology',
  industry: 'Software',
  price: { current: 250 },
  financials: { years: [
    { revenue: 20, fcf: 8, netIncome: 7, sharesOutTTM: 1, roic: .28, sbc: .4 },
    { revenue: 22, fcf: 9, netIncome: 8, sharesOutTTM: .98, roic: .29, sbc: .42 },
  ] },
  valuation: {
    industryModel: { model: 'software' }, dividendYield: 0,
    forwardPe: 22, evRevenue: 6,
    moat: { score: 82 }, pricingPowerV2: { score: 78 },
    businessProfile: { premiumPersistence: .78, forecastReliability: .82 },
    economicQuality: { overall: 82 }, compounder: { score: 84 },
  },
};
const lifecycle = { stage: 'Compounder', forwardGrowth: .11, growthPersistenceScore: 80 };
const model = { projection: [
  { year: 2027, revenue: 24, fcfMargin: .41, netMargin: .36, shares: .97 },
  { year: 2028, revenue: 26.5, fcfMargin: .41, netMargin: .36, shares: .96 },
  { year: 2029, revenue: 29.2, fcfMargin: .405, netMargin: .355, shares: .95 },
  { year: 2030, revenue: 32.1, fcfMargin: .40, netMargin: .35, shares: .94 },
  { year: 2031, revenue: 35.2, fcfMargin: .40, netMargin: .35, shares: .93 },
] };
const methods = {
  dcf: { fairValuePerShare: 700, exitPricePerShare: 850 },
  dcfSBCAdjusted: { fairValuePerShare: 575, exitPricePerShare: 720 },
  ownerEarnings: { fairValuePerShare: 535, exitPricePerShare: 680 },
  revenueExit: { fairValuePerShare: 405, exitPricePerShare: 620 },
  epsExit: { fairValuePerShare: 735, exitPricePerShare: 900 },
  ebitdaExit: { fairValuePerShare: 585, exitPricePerShare: 760 },
};

const result = selectedValuation({ stock, category: 'Compounder', lifecycle, methodResults: methods, model });
assert.ok(result && result.unifiedForecastLinkedValuation, 'V50 linked valuation must be active');
assert.ok(result.actionableExitValue > result.fairValueToday,
  'For a zero-dividend stock with a positive discount rate, the future target must exceed fair value today');
const reconstructed = result.actionableExitValue / Math.pow(1 + result.impliedDiscountRate, result.years);
assert.ok(Math.abs(reconstructed - result.fairValueToday) < 1e-8,
  'Fair value today must be the present value of the canonical future target');
const reconstructedCagr = Math.pow(result.actionableExitValue / stock.price.current, 1 / result.years) - 1;
assert.ok(Math.abs(reconstructedCagr - result.expectedCAGR) < 1e-10,
  'Displayed expected CAGR and future target must describe the same outcome');
assert.ok(result.methodBlendFairValueToday > 0,
  'Legacy method blend should remain available as a diagnostic');

console.log('V50 valuation-link regression passed', {
  fairValueToday: result.fairValueToday,
  futureTarget: result.actionableExitValue,
  discountRate: result.impliedDiscountRate,
  expectedCAGR: result.expectedCAGR,
});
