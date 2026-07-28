'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function computeExpectedReturnProfile(stock, scenarioAnalysis, integrity) {
  const base = stock.valuation?.fiveYearPriceTarget;
  const scenario = scenarioAnalysis || {};
  const expected = scenario.expectedCAGR ?? base?.cagr ?? null;
  const bear = scenario.downsideCAGR ?? null;
  const bull = scenario.upsideCAGR ?? null;
  const confidence = scenario.probabilities?.confidence ?? 0.5;

  if (expected == null) {
    return { expectedCAGR: null, riskAdjustedCAGR: null, returnQualityScore: 0 };
  }

  const downsidePenalty = bear == null ? 0.04 : Math.max(0, -bear) * 0.35;
  const uncertaintyPenalty = bull != null && bear != null ? Math.max(0, bull - bear - 0.45) * 0.08 : 0.02;
  const dataPenalty = (1 - integrity.score / 100) * 0.08;
  const riskAdjustedCAGR = expected - downsidePenalty - uncertaintyPenalty - dataPenalty;
  const returnQualityScore = Math.round(clamp(
    ((riskAdjustedCAGR - 0.04) / 0.22) * 70 +
    confidence * 20 +
    (integrity.score / 100) * 10,
    0, 100
  ));

  return {
    expectedCAGR: expected,
    baseCAGR: base?.cagr ?? null,
    bearCAGR: bear,
    bullCAGR: bull,
    riskAdjustedCAGR,
    returnQualityScore,
    downsidePenalty,
    uncertaintyPenalty,
    dataPenalty,
  };
}

module.exports = { computeExpectedReturnProfile };
