'use strict';
const assert = require('assert');
const { applyDecisionSystemV30 } = require('./decision-system-v30');

function compactStock(ticker, capitalScore) {
  return {
    ticker,
    category: 'Compounder',
    rating: 'Hold',
    capitalAllocationScore: capitalScore,
    capitalAllocation: {
      version: 'capital-allocation-v4',
      score: capitalScore,
      evidenceScore: 82,
      signals: capitalScore > 70 ? ['Share count is shrinking'] : [],
      flags: capitalScore < 40 ? ['Persistent share dilution'] : [],
    },
    businessQualityScore: capitalScore > 70 ? 82 : 48,
    pricingPowerV2Score: capitalScore > 70 ? 78 : 42,
    confidenceScore: 80,
    downsideProtectionScore: 70,
    expectedReturn: .14,
    riskAdjustedReturn: .13,
    probabilityWeightedCAGR: .14,
    baseCAGR: .14,
    bearCAGR: .08,
    bullCAGR: .20,
    marginOfSafety: .18,
    requiredMOS: .10,
    valuation: {
      economicQuality: { businessEconomics: { overall: capitalScore > 70 ? 82 : 48, moat: 75, pricingPower: 72 } },
      moat: { score: 75 },
      pricingPowerV2: { score: capitalScore > 70 ? 78 : 42 },
      expectedReturnProfile: { expectedCAGR: .14, riskAdjustedCAGR: .13 },
      downside: { score: 70 },
    },
  };
}

const strong = compactStock('GOOD', 84);
const weak = compactStock('BAD', 31);
const out = applyDecisionSystemV30([strong, weak]);
const good = out.find(x => x.ticker === 'GOOD');
const bad = out.find(x => x.ticker === 'BAD');
assert.strictEqual(good.capitalAllocationScore, 84, 'canonical strong score must survive compact scoring record');
assert.strictEqual(bad.capitalAllocationScore, 31, 'canonical weak score must survive compact scoring record');
assert.notStrictEqual(good.capitalAllocationScore, bad.capitalAllocationScore, 'capital allocation must remain differentiated');
assert(Number.isFinite(good.expectedAlpha), 'expected alpha should be emitted');
console.log('V45 regression test passed:', { good: good.capitalAllocationScore, bad: bad.capitalAllocationScore, alpha: good.expectedAlpha });
