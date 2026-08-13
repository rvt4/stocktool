'use strict';
const fs = require('fs');
const path = require('path');
const { auditCanonicalReturn } = require('./return-contract');

const BUY_RATINGS = new Set(['Exceptional Buy', 'Strong Buy', 'Buy']);
function finite(v) { return Number.isFinite(Number(v)); }

function validate(stocks) {
  const issues = [];
  const counts = {};

  for (const s of stocks) {
    counts[s.rating] = (counts[s.rating] || 0) + 1;
    const target = s.fiveYearPriceTarget || s.valuation?.fiveYearPriceTarget || null;
    const audit = target ? auditCanonicalReturn(target, s.currentPrice ?? s.price?.current) : null;
    const canonical = Number(target?.cagr);
    const displayed = Number(s.expectedReturn);
    const decision = Number(s.decisionExpectedReturn);
    const alpha = Number(s.expectedAlpha);
    const buyRated = BUY_RATINGS.has(s.rating);

    // Hard architectural invariants. These are not subjective model-quality checks;
    // any failure means the published dashboard is internally contradictory.
    if (target && !audit.valid) {
      issues.push({ ticker: s.ticker, type: 'canonical_return_math_mismatch', reasons: audit.reasons, audit });
    }
    if (target && finite(canonical) && (!finite(displayed) || Math.abs(displayed - canonical) > 1e-6)) {
      issues.push({ ticker: s.ticker, type: 'displayed_return_not_canonical', expectedReturn: s.expectedReturn, canonicalCAGR: target.cagr });
    }
    if (target && finite(canonical) && finite(decision) && Math.abs(decision - canonical) > 1e-6) {
      issues.push({ ticker: s.ticker, type: 'decision_return_not_canonical', decisionExpectedReturn: s.decisionExpectedReturn, canonicalCAGR: target.cagr });
    }
    if (finite(displayed) && finite(alpha) && Math.abs(alpha - (displayed - .10)) > 1e-6) {
      issues.push({ ticker: s.ticker, type: 'alpha_return_mismatch', expectedReturn: displayed, expectedAlpha: alpha });
    }
    if (buyRated && (s.returnIntegrityError || !s.meetsCAGRTarget || !s.meetsRequiredMOS || !s.qualifiesForBuyList || !(displayed >= .15))) {
      issues.push({
        ticker: s.ticker, type: 'buy_rating_contract_violation', rating: s.rating,
        expectedReturn: s.expectedReturn, marginOfSafety: s.marginOfSafety,
        requiredMOS: s.requiredMOS, meetsCAGRTarget: s.meetsCAGRTarget,
        meetsRequiredMOS: s.meetsRequiredMOS, qualifiesForBuyList: s.qualifiesForBuyList,
        returnIntegrityError: s.returnIntegrityError,
      });
    }
    if (finite(s.bearCAGR) && finite(s.baseCAGR) && finite(s.bullCAGR) && !(s.bearCAGR < s.baseCAGR && s.baseCAGR < s.bullCAGR)) {
      issues.push({ ticker: s.ticker, type: 'scenario_ordering_violation', bear: s.bearCAGR, base: s.baseCAGR, bull: s.bullCAGR });
    }
  }

  const total = stocks.length || 1;
  return {
    version: 'validation-v68-canonical-return-contract',
    generatedAt: new Date().toISOString(),
    stocks: stocks.length,
    ratingDistribution: counts,
    exceptionalShare: (counts['Exceptional Buy'] || 0) / total,
    strongOrBetterShare: ((counts['Exceptional Buy'] || 0) + (counts['Strong Buy'] || 0)) / total,
    issues,
    passed: issues.length === 0,
  };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data', 'results.json'), 'utf8'));
  const report = validate(data.stocks || []);
  fs.writeFileSync(path.join(root, 'data', 'validation-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
module.exports = { validate };
