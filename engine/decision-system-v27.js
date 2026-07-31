'use strict';

const { computeCapitalAllocationV2 } = require('./capital-allocation-v2');
const { sectorAdjustedComposite } = require('./sector-model-engine');
const { computeProbabilityProfile, assignProbabilityRating } = require('./probability-rating-engine');
const { buildDecisionExplanation } = require('./explainability-engine');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function n(v, d = null) { v = Number(v); return Number.isFinite(v) ? v : d; }
function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const RETURN_CEILINGS = {
  'Compounder': .32,
  'Value': .35,
  'Growth': .30,
  'Hyper Growth': .32,
  'Dividend': .27,
  'Turnaround': .25,
  'Cyclical': .25,
  'Unknown': .24,
};

const MOS_CEILINGS = {
  'Compounder': .55,
  'Value': .65,
  'Growth': .50,
  'Hyper Growth': .50,
  'Dividend': .55,
  'Turnaround': .50,
  'Cyclical': .45,
  'Unknown': .40,
};

function buildActionableReturn(stock) {
  const raw = n(stock.probabilityWeightedCAGR, n(stock.expectedReturn, null));
  const base = n(stock.baseCAGR, null);
  const canonical = n(stock.fiveYearPriceTarget?.cagr, null);
  const riskAdjusted = n(stock.expectedReturnProfile?.riskAdjustedCAGR, null);
  const anchor = median([raw, base, canonical, riskAdjusted]);
  const confidence = clamp(n(stock.confidenceScore, 50), 0, 100);
  const agreement = clamp(n(stock.methodAgreementScore, n(stock.valuation?.methodAgreementScore, 50)), 0, 100);

  // Confidence-weighted shrinkage prevents a single optimistic method or malformed
  // price/share input from driving the displayed return and rating.
  const evidence = clamp(.30 + confidence / 250 + agreement / 500, .35, .90);
  let actionable = raw == null ? anchor : (anchor == null ? raw : anchor + (raw - anchor) * evidence);
  const ceiling = RETURN_CEILINGS[stock.category] ?? .30;
  const extremeInput = [raw, base, canonical].some(v => Number.isFinite(v) && (v > .75 || v < -.75));
  const wasCapped = Number.isFinite(actionable) && actionable > ceiling;
  actionable = Number.isFinite(actionable) ? clamp(actionable, -.35, ceiling) : null;

  return { raw, anchor, actionable, ceiling, wasCapped, extremeInput, evidence };
}

function buildActionableMOS(stock) {
  const raw = n(stock.marginOfSafety, null);
  if (raw == null) return { raw: null, actionable: null, ceiling: null, wasCapped: false };
  const ceiling = MOS_CEILINGS[stock.category] ?? .50;
  const confidence = clamp(n(stock.confidenceScore, 50), 0, 100);
  const agreement = clamp(n(stock.methodAgreementScore, n(stock.valuation?.methodAgreementScore, 50)), 0, 100);
  const reliability = clamp(.45 + confidence / 500 + agreement / 1000, .50, .78);
  // Haircut only the positive valuation surplus. Negative MOS is left unchanged.
  const haircut = raw > 0 ? raw * reliability : raw;
  const actionable = clamp(haircut, -1, ceiling);
  return { raw, actionable, ceiling, wasCapped: actionable !== raw, reliability };
}

function valuationScore(stock, actionableReturn, actionableMOS) {
  const agreement = n(stock.methodAgreementScore, n(stock.valuation?.methodAgreementScore, 50));
  return Math.round(clamp(50 + n(actionableMOS, 0) * 65 + (n(actionableReturn, 0) - .10) * 110 + (agreement - 50) * .16, 0, 100));
}

function growthScore(stock) {
  const g = stock.valuation?.growthQuality?.score ?? stock.scenarioAnalysis?.growthQuality?.score ?? n(stock.fundamentalGrowthRate, 0) * 220 + 45;
  return Math.round(clamp(n(g, 50), 0, 100));
}

function applyScarcityGuard(stocks) {
  const byScore = [...stocks].sort((a, b) =>
    (b.sectorAdjustedDecisionScore - a.sectorAdjustedDecisionScore) ||
    (b.businessQualityScore - a.businessQualityScore) ||
    (b.decisionExpectedReturn - a.decisionExpectedReturn)
  );
  const exceptionalLimit = Math.max(1, Math.min(3, Math.floor(stocks.length * .0035)));
  const strongLimit = Math.max(10, Math.min(25, Math.floor(stocks.length * .026)));

  let exceptionalSeen = 0;
  let strongSeen = 0;
  for (const stock of byScore) {
    if (stock.rating === 'Exceptional Buy') {
      exceptionalSeen += 1;
      if (exceptionalSeen > exceptionalLimit) {
        stock.rating = 'Strong Buy';
        stock.ratingReason = 'High-conviction candidate, but ranked below the current Exceptional Buy scarcity cutoff.';
      }
    }
    if (stock.rating === 'Strong Buy') {
      strongSeen += 1;
      if (strongSeen > strongLimit) {
        stock.rating = 'Buy';
        stock.ratingReason = 'Attractive candidate, but ranked below the current Strong Buy scarcity cutoff.';
      }
    }
  }
}

function applyDecisionSystemV27(stocks) {
  for (const stock of stocks) {
    const capital = computeCapitalAllocationV2(stock);
    const quality = Math.round(clamp(n(stock.valuation?.economicQuality?.overall, n(stock.businessQualityScore, 50)) * .82 + capital.score * .18, 0, 100));
    const returnProfile = buildActionableReturn(stock);
    const mosProfile = buildActionableMOS(stock);

    stock.rawProbabilityWeightedCAGR = stock.probabilityWeightedCAGR;
    stock.rawMarginOfSafety = stock.marginOfSafety;
    stock.decisionExpectedReturn = returnProfile.actionable;
    stock.probabilityWeightedCAGR = returnProfile.actionable;
    stock.expectedReturn = returnProfile.actionable;
    stock.marginOfSafety = mosProfile.actionable;
    stock.returnPlausibilityAdjusted = returnProfile.wasCapped || returnProfile.extremeInput;
    stock.marginOfSafetyAdjusted = mosProfile.wasCapped;

    if (returnProfile.extremeInput) {
      stock.confidenceScore = Math.min(n(stock.confidenceScore, 50), 55);
      stock.dataIntegrity = { ...(stock.dataIntegrity || {}), decisionIntegrityWarning: 'Extreme return input; verify price, share count and ticker mapping.' };
    }

    // Scenarios are retained in order, but compressed around the actionable base so
    // the table cannot show 70%-120% annualized outcomes as ordinary estimates.
    if (Number.isFinite(returnProfile.actionable)) {
      const rawBase = n(stock.baseCAGR, returnProfile.actionable);
      const rawBear = n(stock.bearCAGR, rawBase - .05);
      const rawBull = n(stock.bullCAGR, rawBase + .06);
      const bearSpread = clamp(rawBase - rawBear, .035, .12);
      const bullSpread = clamp(rawBull - rawBase, .045, .14);
      stock.baseCAGR = clamp((returnProfile.actionable + rawBase) / 2, -.35, returnProfile.ceiling + .02);
      stock.bearCAGR = clamp(stock.baseCAGR - bearSpread, -.40, stock.baseCAGR - .02);
      stock.bullCAGR = clamp(stock.baseCAGR + bullSpread, stock.baseCAGR + .02, returnProfile.ceiling + .08);
    }

    const components = {
      quality,
      growth: growthScore(stock),
      valuation: valuationScore(stock, returnProfile.actionable, mosProfile.actionable),
      risk: clamp(n(stock.downsideRiskScore, n(stock.valuation?.downside?.score, 50)), 0, 100),
      confidence: clamp(n(stock.confidenceScore, 50), 0, 100),
    };
    const composite = sectorAdjustedComposite(stock, components);
    const probability = computeProbabilityProfile(stock, components);
    const decision = assignProbabilityRating(stock, components, probability);

    stock.rating = decision.rating;
    stock.ratingReason = decision.ratingReason;
    if (returnProfile.extremeInput && ['Exceptional Buy', 'Strong Buy', 'Buy'].includes(stock.rating)) {
      stock.rating = 'Hold';
      stock.ratingReason = 'Extreme return input requires price/share-count verification before a buy rating.';
    }
    stock.v27 = {
      version: 'v27-business-first-plausibility', components,
      sectorModel: composite.model.key,
      sectorAdjustedScore: composite.score,
      sectorGates: decision.sectorGates,
      capitalAllocation: capital,
      probability,
      returnProfile,
      mosProfile,
    };
    stock.probabilityProfile = probability;
    stock.capitalAllocationScore = capital.score;
    stock.sectorAdjustedDecisionScore = composite.score;
    stock.decisionExplanation = buildDecisionExplanation(stock, components, probability, capital);
  }

  applyScarcityGuard(stocks);
  const rank = { 'Exceptional Buy': 6, 'Strong Buy': 5, 'Buy': 4, 'Hold': 3, 'Avoid': 2, 'Sell': 1 };
  return [...stocks].sort((a, b) =>
    (rank[b.rating] - rank[a.rating]) ||
    (b.sectorAdjustedDecisionScore - a.sectorAdjustedDecisionScore) ||
    (b.businessQualityScore - a.businessQualityScore) ||
    (b.decisionExpectedReturn - a.decisionExpectedReturn)
  );
}

module.exports = { applyDecisionSystemV27, buildActionableReturn, buildActionableMOS };
