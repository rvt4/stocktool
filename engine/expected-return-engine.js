'use strict';

const { buildReturnAttribution } = require('./return-attribution-engine');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function finite(x) { return Number.isFinite(Number(x)); }

function forecastStability(stock, scenario) {
  const projection = stock?.valuation?.projection || [];
  const growth = projection.map(x => Number(x.growth)).filter(finite);
  const financial = stock?.valuation?.businessArchetype === 'Digital Financial Platform' ||
    stock?.valuation?.lifecycle?.archetype === 'Digital Financial Platform' ||
    /financial/i.test(String(stock?.sector || ''));
  const margins = projection.map(x => Number(financial ? x.netMargin : x.fcfMargin)).filter(finite);
  const variability = values => {
    if (values.length < 2) return .12;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / values.length);
  };
  const growthVol = variability(growth);
  const marginVol = variability(margins);
  const range = finite(scenario?.upsideCAGR) && finite(scenario?.downsideCAGR)
    ? Number(scenario.upsideCAGR) - Number(scenario.downsideCAGR) : .30;
  const score = clamp(1 - growthVol * 2.2 - marginVol * 2.8 - Math.max(0, range - .12) * .75, 0, 1);
  return { score, growthVolatility: growthVol, marginVolatility: marginVol, scenarioRange: range };
}

function computeExpectedReturnProfile(stock, scenarioAnalysis, integrity) {
  const base = stock.valuation?.fiveYearPriceTarget;
  const primary = stock.valuation?.returnEngineV2 || stock.valuation?.ownerEarningsReturn || {};
  const scenario = scenarioAnalysis || {};
  const expected = primary.expectedCAGR ?? scenario.expectedCAGR ?? base?.cagr ?? null;
  const bear = scenario.downsideCAGR ?? null;
  const bull = scenario.upsideCAGR ?? null;
  const scenarioConfidence = scenario.probabilities?.confidence ?? 0.5;
  const stability = forecastStability(stock, scenario);
  const evidenceConfidence = clamp(
    scenarioConfidence * .55 + stability.score * .30 + ((integrity?.score ?? 50) / 100) * .15,
    0, 1
  );

  if (expected == null) {
    return { expectedCAGR: null, riskAdjustedCAGR: null, returnQualityScore: 0, forecastStability: stability };
  }

  const downsidePenalty = bear == null ? 0.04 : Math.max(0, -bear) * 0.35;
  const uncertaintyPenalty = bull != null && bear != null ? Math.max(0, bull - bear - 0.30) * 0.10 : 0.02;
  const instabilityPenalty = (1 - stability.score) * 0.035;
  const financial = stock?.valuation?.businessArchetype === 'Digital Financial Platform' ||
    stock?.valuation?.lifecycle?.archetype === 'Digital Financial Platform';
  const dataPenalty = (1 - (integrity?.score ?? 50) / 100) * (financial ? 0.055 : 0.08);
  // Weak economics should reduce the return estimate itself, not merely its
  // confidence score. This prevents fragile high-growth forecasts from receiving
  // the same actionable CAGR as durable compounders.
  const moat = Number(stock?.valuation?.moat?.score ?? stock?.componentScores?.moat ?? 50);
  const growthQuality = Number(stock?.valuation?.growthQuality?.score ?? stock?.growthQuality?.score ?? 50);
  const capitalAllocation = Number(stock?.capitalAllocationScore ?? stock?.valuation?.capitalAllocation?.score ?? 50);
  const durabilityComposite = clamp(moat * .45 + growthQuality * .35 + capitalAllocation * .20, 0, 100);
  const qualityHaircut = clamp((68 - durabilityComposite) / 100 * .09, 0, .045);
  const expectationRisk = stock?.valuation?.expectationRisk || {};
  const expectationRiskPenalty = clamp(Number(expectationRisk.cagrPenalty || 0), 0, .025);
  const riskAdjustedCAGR = expected - downsidePenalty - uncertaintyPenalty - instabilityPenalty - dataPenalty - qualityHaircut - expectationRiskPenalty;
  const attribution = buildReturnAttribution(stock, primary, scenario);
  const attr = attribution?.components || {};
  const positiveReturn = Math.max(0.01, Number(expected) || 0.01);
  const reratingDependence = clamp(Math.max(0, Number(attr.valuationChange) || 0) / positiveReturn, 0, 1.5);
  const dividendDependence = clamp(Math.max(0, Number(attr.dividends) || 0) / positiveReturn, 0, 1.5);
  const operatingContribution = (Number(attr.revenueGrowth) || 0) + (Number(attr.growthFade) || 0) +
    (Number(attr.marginChange) || 0) + (Number(attr.shareCountChange) || 0);
  const operatingSupport = clamp(operatingContribution / positiveReturn, -1, 1.5);
  const revenueGrowth = stock?.valuation?.projectionAssumptions?.year1 ?? stock?.valuation?.projection?.[0]?.growth ?? null;
  const lowGrowthYieldRisk = finite(revenueGrowth) && Number(revenueGrowth) < .035 && dividendDependence > .28;
  const sanityClampCount = Number(stock?.valuation?.fundamentalGrowthDiagnostics?.sanityClampCount ?? stock?.fundamentalGrowthBreakdown?.sanityClampCount ?? stock?.cagrBreakdown?.sanityClampCount ?? 0);
  const agreement01 = clamp(Number(stock?.valuation?.methodAgreementScore ?? 50) / 100, 0, 1);
  // Rerating is a legitimate source of return, but it is less robust than operating
  // compounding. Penalize dependence progressively, and more when valuation methods disagree.
  const reratingFragility = reratingDependence <= .30 ? 0 : Math.pow(reratingDependence - .30, 1.25);
  const disagreementInteraction = reratingDependence > .45 ? reratingDependence * (1 - agreement01) : 0;
  const clampRobustnessPenalty = sanityClampCount <= 0 ? 0 : sanityClampCount === 1 ? 3 : sanityClampCount === 2 ? 8 : 14;

  // Return quality measures how robust the *source* of the return is, not merely
  // how high the modeled CAGR is. Operating compounding and evidence are rewarded;
  // dependence on rerating or yield in a stagnant business is penalized.
  const returnQualityScore = Math.round(clamp(
    48 + evidenceConfidence * 24 + ((integrity?.score ?? 50) / 100) * 10 +
    clamp(operatingSupport, -1, 1) * 18 - reratingDependence * 18 - reratingFragility * 24 -
    disagreementInteraction * 18 - clampRobustnessPenalty - (lowGrowthYieldRisk ? 14 : 0),
    0, 100
  ));
  const returnQualityLabel = returnQualityScore >= 80 ? 'Robust' : returnQualityScore >= 65 ? 'Good'
    : returnQualityScore >= 50 ? 'Mixed' : returnQualityScore >= 35 ? 'Fragile' : 'Speculative';

  return {
    expectedCAGR: expected,
    baseCAGR: primary.expectedCAGR ?? base?.cagr ?? null,
    bearCAGR: bear,
    bullCAGR: bull,
    riskAdjustedCAGR,
    returnQualityScore,
    returnQualityLabel,
    returnQualityDiagnostics: { reratingDependence, dividendDependence, operatingSupport, lowGrowthYieldRisk, reratingFragility, disagreementInteraction, sanityClampCount, clampRobustnessPenalty },
    downsidePenalty,
    uncertaintyPenalty,
    instabilityPenalty,
    dataPenalty,
    qualityHaircut,
    expectationRiskPenalty,
    expectationRiskScore: expectationRisk.score ?? null,
    durabilityComposite,
    evidenceConfidence,
    forecastStability: stability,
    returnAttribution: attribution,
  };
}

module.exports = { computeExpectedReturnProfile, forecastStability };
