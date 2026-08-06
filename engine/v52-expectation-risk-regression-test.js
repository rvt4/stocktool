'use strict';
const assert = require('assert');
const { computeExpectationRisk } = require('./expectation-risk-engine');

function stock(pe = 30, industry = 'software') {
  return {
    pe,
    valuation: {
      currentPE: pe,
      industryModel: { model: industry },
      moat: { score: 75 },
      valuationConsensus: { agreementScore: 70 },
    },
  };
}
const model = { projection: [{ growth: .20 }, { growth: .15 }, { growth: .11 }] };
const durable = computeExpectationRisk(
  stock(28), model,
  { impliedRevenueGrowth: .10, modeledYear1Growth: .20, modeledYear5Growth: .11 },
  { probabilityWeightedValuationDrag: -.02 },
  { stage: 'Compounder', confidence: .82 },
  { forecastReliability: .82, premiumPersistence: .78 }
);
const demanding = computeExpectationRisk(
  stock(58, 'semiconductors-hardware'), model,
  { impliedRevenueGrowth: .29, modeledYear1Growth: .20, modeledYear5Growth: .11 },
  { probabilityWeightedValuationDrag: -.10 },
  { stage: 'Hyper Growth', confidence: .60 },
  { forecastReliability: .60, premiumPersistence: .55 }
);
assert.ok(demanding.score > durable.score + 25, `expected demanding risk > durable risk; ${demanding.score} vs ${durable.score}`);
assert.ok(demanding.cagrPenalty > durable.cagrPenalty, 'demanding expectations should receive a larger CAGR penalty');
assert.ok(demanding.positionSizeMultiplier < durable.positionSizeMultiplier, 'demanding expectations should lower suggested sizing');
console.log('V52 expectation-risk regression passed', { durable: durable.score, demanding: demanding.score });
