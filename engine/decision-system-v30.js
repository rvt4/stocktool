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
    (n(b.investmentScore, 0) - n(a.investmentScore, 0)) ||
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

function applyDecisionSystemV30(stocks) {
  for (const stock of stocks) {
    if (!stock || typeof stock !== 'object') continue;
    // Some valid records (especially limited-history companies) reach the
    // decision layer without a valuation audit object. Component scores are
    // still useful, so create the container instead of crashing the run.
    stock.valuation = stock.valuation && typeof stock.valuation === 'object'
      ? stock.valuation
      : {};

    // scoreUniverse intentionally emits a compact public record and no longer
    // carries the raw financial statements. Recomputing capital allocation here
    // therefore used an empty history and returned the same neutral-ish 55 for
    // every company. Reuse the canonical pre-scoring result when present; only
    // recompute when this function receives a raw record with actual history.
    const existingCapital = stock.capitalAllocation || stock.valuation?.capitalAllocation || null;
    const hasRawCapitalHistory = Array.isArray(stock.financials?.years) && stock.financials.years.length >= 2;
    const computedCapital = hasRawCapitalHistory ? computeCapitalAllocationV2(stock) : null;
    const capitalSource = computedCapital || existingCapital || {
      version: 'capital-allocation-unavailable', score: n(stock.capitalAllocationScore, 50),
      evidenceScore: 0, signals: [], flags: ['Capital-allocation evidence unavailable'],
    };
    const capital = {
      ...capitalSource,
      score: Math.round(clamp(n(capitalSource.score, n(stock.capitalAllocationScore, 50)), 0, 100)),
      signals: Array.isArray(capitalSource.signals) ? capitalSource.signals : [],
      flags: Array.isArray(capitalSource.flags) ? capitalSource.flags : [],
    };
    stock.capitalAllocation = capital;
    stock.valuation.capitalAllocation = capital;
    const economics = stock.valuation?.economicQuality?.businessEconomics || stock.valuation?.businessEconomics || null;
    const economicQuality = n(economics?.overall, n(stock.valuation?.economicQuality?.overall, n(stock.businessQualityScore, 50)));
    const quality = Math.round(clamp(economicQuality * .90 + capital.score * .10, 0, 100));
    const returnProfile = buildActionableReturn(stock);
    const mosProfile = buildActionableMOS(stock);

    stock.rawProbabilityWeightedCAGR = stock.probabilityWeightedCAGR;
    stock.rawMarginOfSafety = stock.marginOfSafety;
    stock.decisionExpectedReturn = returnProfile.actionable;
    stock.probabilityWeightedCAGR = returnProfile.actionable;
    stock.expectedReturn = returnProfile.actionable;
    stock.expectedAlpha = Number.isFinite(returnProfile.actionable) ? returnProfile.actionable - 0.10 : null;
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
    const financialStrength = Math.round(clamp(
      n(stock.balanceSheetScore, n(stock.valuation?.balanceSheetScore, 50)) * .55 +
      components.risk * .25 + components.confidence * .20, 0, 100));
    stock.componentScores = {
      moat: Math.round(clamp(n(economics?.moat, n(stock.valuation?.moat?.score, quality)), 0, 100)),
      pricingPower: Math.round(clamp(n(economics?.pricingPower, n(stock.valuation?.pricingPowerV2?.score, 50)), 0, 100)),
      durability: Math.round(clamp(n(economics?.durability, quality), 0, 100)),
      reinvestmentRunway: Math.round(clamp(n(economics?.reinvestmentRunway, components.growth), 0, 100)),
      growth: Math.round(components.growth),
      capitalAllocation: Math.round(capital.score),
      financialStrength,
      valuation: Math.round(components.valuation),
      economicQuality: Math.round(economicQuality),
    };
    stock.requiredMarginOfSafety = n(economics?.requiredMarginOfSafety, stock.requiredMarginOfSafety);
    stock.valuation.componentScores = stock.componentScores;
    const composite = sectorAdjustedComposite(stock, components);
    // V30 quality-first underwriting: cheapness cannot overcome a mediocre business.
    // Expected return remains important, but business quality is the largest single
    // input and confidence acts as a tie-breaker rather than a source of optimism.
    const returnScore = clamp(50 + (n(returnProfile.actionable, 0) - .10) * 220, 0, 100);
    const qualityFirstScore = Math.round(clamp(
      quality * .45 + returnScore * .30 + components.valuation * .15 + components.confidence * .10,
      0, 100
    ));
    composite.score = Math.round(clamp(composite.score * .45 + qualityFirstScore * .55, 0, 100));

    // V41 Investment Score: a deliberately wider, quality-aware ranking scale.
    // Return and MOS matter, but only after evidence quality and downside resilience.
    const mosScore = clamp(50 + n(mosProfile.actionable, 0) * 100, 0, 100);
    const moatScore = clamp(n(economics?.moat, n(stock.valuation?.moat?.score, 50)), 0, 100);
    const durableReturn = returnScore * clamp((quality * .42 + components.confidence * .28 + moatScore * .18 + capital.score * .12) / 100, .35, 1);
    const recentYears = (stock.financials?.years || []).slice(-5);
    const negativeFcfRate = recentYears.length ? recentYears.filter(y => n(y.fcf, 0) <= 0).length / recentYears.length : .35;
    const dilution = n(capital.annualDilution, 0);
    const evidencePenalty = clamp((55 - n(capital.evidenceScore, 55)) * .08, 0, 4);
    const fundamentalPenalty = negativeFcfRate * 8 + clamp((dilution - .02) * 120, 0, 7) + evidencePenalty;
    const pricingPower = clamp(n(economics?.pricingPower, n(stock.pricingPowerV2Score, 50)), 0, 100);
    const investmentRaw = durableReturn * .33 + quality * .22 + mosScore * .16 +
      components.confidence * .08 + moatScore * .07 + capital.score * .08 +
      pricingPower * .05 + components.risk * .01 - fundamentalPenalty;
    // Wider, intuitive distribution: elite setups can reach the 80s/90s while
    // mediocre and destructive cases separate cleanly below 50.
    const investmentScore = Math.round(clamp(50 + (investmentRaw - 50) * 1.55, 0, 97));
    stock.investmentScore = investmentScore;
    stock.portfolioManagerScore = investmentScore;
    stock.investmentScoreBreakdown = {
      durableReturn: Math.round(durableReturn), quality: Math.round(quality),
      marginOfSafety: Math.round(mosScore), confidence: Math.round(components.confidence),
      moat: Math.round(moatScore), capitalAllocation: Math.round(capital.score),
      pricingPower: Math.round(pricingPower),
      downsideProtection: Math.round(components.risk), fundamentalPenalty: Math.round(fundamentalPenalty * 10) / 10, raw: investmentRaw,
    };

    const probability = computeProbabilityProfile(stock, components);
    const decision = assignProbabilityRating(stock, components, probability);

    stock.rating = decision.rating;
    stock.ratingReason = decision.ratingReason;

    // V29 committee gate: a high composite score cannot conceal a failed
    // valuation or risk vote. Strong Buy requires four affirmative members;
    // Exceptional Buy requires unanimity. Buy requires at least three yes votes
    // and no fatal rejection from valuation/risk.
    const committee = stock.valuation?.investmentCommittee || stock.investmentCommittee || null;
    if (committee) {
      stock.investmentCommitteeScore = committee.score;
      stock.icScore = committee.score;
      stock.investmentCommitteeVotes = committee.members;
      const topRating = ['Exceptional Buy', 'Strong Buy'].includes(stock.rating);
      if (stock.rating === 'Exceptional Buy' && !committee.unanimous) {
        stock.rating = committee.yesVotes >= 4 && !committee.fatalNo ? 'Strong Buy' : 'Buy';
        stock.ratingReason = 'The return case is attractive, but the five-member committee was not unanimous.';
      } else if (stock.rating === 'Strong Buy' && (committee.yesVotes < 4 || committee.fatalNo || quality < 72 || n(stock.confidenceScore, 50) < 72)) {
        stock.rating = committee.yesVotes >= 3 && !committee.fatalNo ? 'Buy' : 'Hold';
        stock.ratingReason = committee.fatalNo
          ? 'Valuation or permanent-loss risk failed the investment-committee gate.'
          : 'Fewer than four committee members supported a high-conviction rating.';
      } else if (stock.rating === 'Buy' && (committee.yesVotes < 3 || committee.fatalNo)) {
        stock.rating = 'Hold';
        stock.ratingReason = committee.fatalNo
          ? 'Valuation or permanent-loss risk failed the investment-committee gate.'
          : 'The investment committee did not produce three affirmative votes.';
      }
    }
    if (returnProfile.extremeInput && ['Exceptional Buy', 'Strong Buy', 'Buy'].includes(stock.rating)) {
      stock.rating = 'Hold';
      stock.ratingReason = 'Extreme return input requires price/share-count verification before a buy rating.';
    }
    stock.v27 = {
      version: 'v37-business-economics-quality-first', components,
      sectorModel: composite.model.key,
      sectorAdjustedScore: composite.score,
      sectorGates: decision.sectorGates,
      capitalAllocation: capital,
      probability,
      returnProfile,
      mosProfile,
    };
    stock.probabilityProfile = probability;
    const baseScenario = n(stock.baseCAGR, returnProfile.actionable);
    const bearScenario = n(stock.bearCAGR, baseScenario - .05);
    const bullScenario = n(stock.bullCAGR, baseScenario + .06);
    const scenarioRange = Math.max(0, bullScenario - bearScenario);
    const forecastEvidence = clamp(
      components.confidence * .46 + n(stock.methodAgreementScore, n(stock.valuation?.methodAgreementScore, 50)) * .24 +
      quality * .18 + (100 - clamp(scenarioRange * 220, 0, 100)) * .12,
      0, 100
    );
    stock.forecastConfidenceScore = Math.round(forecastEvidence);
    stock.forecastConfidenceLabel = forecastEvidence >= 86 ? 'Very High'
      : forecastEvidence >= 74 ? 'High'
        : forecastEvidence >= 60 ? 'Medium'
          : forecastEvidence >= 45 ? 'Low' : 'Speculative';
    stock.scenarioAsymmetry = {
      downsideSpread: baseScenario - bearScenario,
      upsideSpread: bullScenario - baseScenario,
      skew: (bullScenario - baseScenario) - (baseScenario - bearScenario),
      range: scenarioRange,
    };
    stock.beatMarketProbability = Math.round((probability.pBeatMarket ?? probability.pPositiveReturn) * 100);
    // Preserve the legacy field for compatibility, but make its meaning explicit
    // and actionable in the dashboard.
    stock.successProbability = stock.beatMarketProbability;
    stock.capitalAllocationScore = capital.score;
    stock.capitalAllocationSignals = [...(capital.signals || []), ...(capital.flags || []).map(x => `Warning: ${x}`)];
    stock.sectorAdjustedDecisionScore = composite.score;
    stock.decisionExplanation = buildDecisionExplanation(stock, components, probability, capital);
  }

  applyScarcityGuard(stocks);
  const rank = { 'Exceptional Buy': 6, 'Strong Buy': 5, 'Buy': 4, 'Hold': 3, 'Avoid': 2, 'Sell': 1 };
  return [...stocks].sort((a, b) =>
    (rank[b.rating] - rank[a.rating]) ||
    (n(b.investmentScore, 0) - n(a.investmentScore, 0)) ||
    (b.sectorAdjustedDecisionScore - a.sectorAdjustedDecisionScore) ||
    (b.businessQualityScore - a.businessQualityScore) ||
    (b.decisionExpectedReturn - a.decisionExpectedReturn)
  );
}

module.exports = { applyDecisionSystemV30, buildActionableReturn, buildActionableMOS };
