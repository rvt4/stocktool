'use strict';
const assert = require('assert');
const { canonicalizePublishedReturn, auditCanonicalReturn } = require('./return-contract');
const { applyDecisionSystemV30 } = require('./decision-system-v30');
const { validate } = require('./validation-suite');

function malformed(ticker) {
  return {
    ticker,
    category: 'Value',
    currentPrice: 25,
    expectedReturn: .42,
    decisionExpectedReturn: .42,
    expectedAlpha: .32,
    marginOfSafety: 0,
    requiredMOS: .20,
    confidenceScore: 70,
    businessQualityScore: 60,
    downsideRiskScore: 50,
    capitalAllocationScore: 50,
    fiveYearPriceTarget: { years: 5, exitPrice: null, dividendsReceived: 0, cagr: .42 },
    valuation: {},
  };
}

for (const ticker of ['MPT','LBTYA','LBTYK','LBRDA']) {
  const s = malformed(ticker);
  s.valuation.fiveYearPriceTarget = s.fiveYearPriceTarget;
  canonicalizePublishedReturn(s);
  assert.strictEqual(s.expectedReturn, null, `${ticker}: unavailable return must be null`);
  assert.strictEqual(s.decisionExpectedReturn, null, `${ticker}: decision return must be null`);
  assert.strictEqual(s.expectedAlpha, null, `${ticker}: alpha must be null`);
  assert.strictEqual(s.returnIntegrityError, true, `${ticker}: must be quarantined`);
  assert.strictEqual(s.returnIntegrityUnavailable, true, `${ticker}: unavailable flag missing`);
  assert.strictEqual(s.fiveYearPriceTarget.integrityUnavailable, true);
  assert.strictEqual(auditCanonicalReturn(s.fiveYearPriceTarget, s.currentPrice).valid, false);

  const [rated] = applyDecisionSystemV30([s]);
  canonicalizePublishedReturn(rated);
  assert.strictEqual(rated.qualifiesForBuyList, false, `${ticker}: unavailable return can never qualify for Buy`);
  assert.ok(!['Exceptional Buy','Strong Buy','Buy'].includes(rated.rating), `${ticker}: unavailable return received Buy rating`);
  const report = validate([rated]);
  assert.strictEqual(report.passed, true, `${ticker}: unavailable outcome should not abort the whole universe: ${JSON.stringify(report.issues)}`);
}

// A true contradiction with a valid exit remains a hard validation failure.
const contradicted = {
  ticker: 'TEST', currentPrice: 100, expectedReturn: .25, decisionExpectedReturn: .25, expectedAlpha: .15,
  rating: 'Avoid', marginOfSafety: 0, requiredMOS: .2,
  fiveYearPriceTarget: { years: 5, exitPrice: 120, dividendsReceived: 0, cagr: .25 },
};
const bad = validate([contradicted]);
assert.ok(bad.issues.some(x => x.type === 'canonical_return_math_mismatch'));
console.log('V71 return quarantine regression passed.');
