'use strict';

const assert = require('assert');
const {
  INVESTMENT_HORIZON_YEARS,
  convertTerminalValueToInvestmentHorizon,
  cagrFromOutcome,
  auditCanonicalReturn,
} = require('./return-contract');
const { buildActionableReturn } = require('./decision-system-v30');
const { validate } = require('./validation-suite');
const { fiveYearPriceTargetCAGR } = require('../valuation-methods');

function near(a, b, eps = 1e-10) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
}

// A seven-year terminal value must be converted to a five-year value before it
// can participate in the screener's canonical expected return.
const present = 100;
const terminal7 = 210;
const fiveYear = convertTerminalValueToInvestmentHorizon(present, terminal7, 7);
near(fiveYear, present * Math.pow(terminal7 / present, 5 / 7));
assert.equal(INVESTMENT_HORIZON_YEARS, 5);

// Exercise the real legacy/all-method target builder as well: a seven-year
// terminal method must become a genuine five-year exit before CAGR is computed.
const targetStock = {
  price: { current: 100 },
  valuation: { dividendYield: 0 },
  financials: { years: [{ revenue: 100, netIncome: 10, sharesOutTTM: 10 }] },
};
const targetModel = {
  projection: Array.from({ length: 7 }, (_, i) => ({
    year: i + 1, revenue: 100 * Math.pow(1.08, i + 1), netMargin: .10, shares: 10,
  })),
};
const actualTarget = fiveYearPriceTargetCAGR(
  targetStock,
  targetModel,
  { dcf: { fairValuePerShare: 100, exitPricePerShare: 210 } },
  { dcf: 1 },
);
near(actualTarget.exitPrice, fiveYear);
near(actualTarget.cagr, cagrFromOutcome(100, fiveYear, 0, 5));
assert.equal(actualTarget.years, 5);

const current = 100;
const dividends = 5;
const cagr = cagrFromOutcome(current, fiveYear, dividends, 5);
const target = { years: 5, exitPrice: fiveYear, dividendsReceived: dividends, cagr };
assert.equal(auditCanonicalReturn(target, current).valid, true);

// The decision layer may observe a much more optimistic scenario-weighted return,
// but it must consume the canonical five-year return unchanged.
const candidate = {
  currentPrice: current,
  expectedReturn: cagr,
  probabilityWeightedCAGR: .42,
  expectedReturnProfile: { riskAdjustedCAGR: .31 },
  fiveYearPriceTarget: target,
  returnIntegrityError: false,
};
const decisionReturn = buildActionableReturn(candidate);
near(decisionReturn.actionable, cagr);
assert.equal(decisionReturn.wasCapped, false);

// A sub-15% canonical CAGR can never coexist with a Buy badge in published data.
const low = .144;
const lowExit = current * Math.pow(1 + low, 5);
const badPublished = {
  ticker: 'TEST', rating: 'Buy', currentPrice: current,
  expectedReturn: low, decisionExpectedReturn: low, expectedAlpha: low - .10,
  fiveYearPriceTarget: { years: 5, exitPrice: lowExit, dividendsReceived: 0, cagr: low },
  marginOfSafety: .30, requiredMOS: .20,
  meetsCAGRTarget: false, meetsRequiredMOS: true, qualifiesForBuyList: false,
  returnIntegrityError: false,
  bearCAGR: .08, baseCAGR: low, bullCAGR: .20,
};
const report = validate([badPublished]);
assert.equal(report.passed, false);
assert.ok(report.issues.some(x => x.type === 'buy_rating_contract_violation'));

// A mathematically inconsistent CAGR/exit pair must also fail publication validation.
const mismatch = {
  ...badPublished,
  ticker: 'MISMATCH', rating: 'Hold', expectedReturn: .20, decisionExpectedReturn: .20,
  expectedAlpha: .10, meetsCAGRTarget: true, qualifiesForBuyList: false,
  fiveYearPriceTarget: { years: 5, exitPrice: 150, dividendsReceived: 0, cagr: .20 },
};
const mismatchReport = validate([mismatch]);
assert.equal(mismatchReport.passed, false);
assert.ok(mismatchReport.issues.some(x => x.type === 'canonical_return_math_mismatch'));

console.log('V68 canonical return contract regression tests passed.');


// V69 regression: a fallback path may internally use a different dividend
// convention, but the published canonical target must always recompute CAGR from
// the exact serialized exit price + serialized dividend dollars. This is the class
// of bug that surfaced on MPT/LBTYA/LBTYK/LBRDA in the first V68 full-universe run.
const highYieldCurrent = 100;
const highYieldExit = 125;
const publishedDividends = 60; // e.g. 12%/yr * 5 after canonical dividend discipline
const staleUpstreamCagr = cagrFromOutcome(highYieldCurrent, highYieldExit, 90, 5); // deliberately different upstream convention
const canonicalRecomputed = cagrFromOutcome(highYieldCurrent, highYieldExit, publishedDividends, 5);
assert.ok(Math.abs(staleUpstreamCagr - canonicalRecomputed) > 1e-3);
const canonicalHighYieldTarget = {
  years: 5,
  exitPrice: highYieldExit,
  dividendsReceived: publishedDividends,
  cagr: canonicalRecomputed,
};
assert.equal(auditCanonicalReturn(canonicalHighYieldTarget, highYieldCurrent).valid, true);

console.log('V69 final canonicalization regression passed.');
