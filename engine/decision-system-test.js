'use strict';

const assert = require('assert');
const { applyDecisionSystemV26 } = require('./decision-system-v26');
const { validate } = require('./validation-suite');

function stock(overrides = {}) {
  return {
    ticker: 'TEST',
    sector: 'Technology',
    industry: 'Software',
    expectedReturn: 0.16,
    riskAdjustedExpectedReturn: 0.15,
    marginOfSafety: 0.18,
    confidenceScore: 75,
    methodAgreementScore: 75,
    downsideRiskScore: 35,
    businessQualityScore: 80,
    fundamentalGrowthRate: 0.16,
    valuation: {
      economicQuality: { overall: 82 },
      growthQuality: { score: 78 },
      methodAgreementScore: 75,
      downside: { score: 35 },
      scenarioAnalysis: { downsideCAGR: -0.05 },
      capitalAllocation: { score: 72 },
    },
    financials: {
      years: [
        { roic: 0.18, sharesOutTTM: 100, totalDebt: 40, fcf: 10 },
        { roic: 0.20, sharesOutTTM: 99, totalDebt: 36, fcf: 12 },
        { roic: 0.22, sharesOutTTM: 98, totalDebt: 32, fcf: 14 },
      ],
    },
    ...overrides,
  };
}

const exceptional = stock({
  ticker: 'GREAT',
  expectedReturn: 0.24,
  riskAdjustedExpectedReturn: 0.22,
  marginOfSafety: 0.28,
  confidenceScore: 88,
  methodAgreementScore: 86,
  downsideRiskScore: 24,
  valuation: {
    economicQuality: { overall: 91 },
    growthQuality: { score: 88 },
    methodAgreementScore: 86,
    downside: { score: 24 },
    scenarioAnalysis: { downsideCAGR: -0.03 },
    capitalAllocation: { score: 86 },
  },
});

const weak = stock({
  ticker: 'WEAK',
  expectedReturn: 0.02,
  riskAdjustedExpectedReturn: -0.01,
  marginOfSafety: -0.25,
  confidenceScore: 52,
  methodAgreementScore: 35,
  downsideRiskScore: 78,
  valuation: {
    economicQuality: { overall: 48 },
    growthQuality: { score: 38 },
    methodAgreementScore: 35,
    downside: { score: 78 },
    scenarioAnalysis: { downsideCAGR: -0.35 },
    capitalAllocation: { score: 40 },
  },
});

const ranked = applyDecisionSystemV26([weak, exceptional]);
assert.strictEqual(ranked[0].ticker, 'GREAT', 'stronger company should rank first');
assert.ok(['Exceptional Buy', 'Strong Buy'].includes(ranked[0].rating), 'strong fixture should receive a high-conviction rating');
assert.ok(['Avoid', 'Sell'].includes(ranked[1].rating), 'weak fixture should receive a defensive rating');
assert.ok(ranked[0].probabilityProfile.pBeat15Cagr > ranked[1].probabilityProfile.pBeat15Cagr, 'probability should be monotonic');
assert.ok(ranked[0].decisionExplanation.strengths.length > 0, 'explanation should contain strengths');

const report = validate(ranked);
assert.strictEqual(report.passed, true, JSON.stringify(report.issues));
console.log('V26 decision-system smoke test passed.');
