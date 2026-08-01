'use strict';

const { buildReturnAttribution } = require('./return-attribution-engine');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function finite(x) { return Number.isFinite(Number(x)); }

function forecastStability(stock, scenario) {
  const projection = stock?.valuation?.projection || [];
  const growth = projection.map(x => Number(x.growth)).filter(finite);
  const margins = projection.map(x => Number(x.fcfMargin)).filter(finite);
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
  const dataPenalty = (1 - (integrity?.score ?? 50) / 100) * 0.08;
  const riskAdjustedCAGR = expected - downsidePenalty - uncertaintyPenalty - instabilityPenalty - dataPenalty;
  const returnQualityScore = Math.round(clamp(
    ((riskAdjustedCAGR - 0.04) / 0.22) * 66 +
    evidenceConfidence * 24 +
    ((integrity?.score ?? 50) / 100) * 10,
    0, 100
  ));

  const attribution = buildReturnAttribution(stock, primary, scenario);

  return {
    expectedCAGR: expected,
    baseCAGR: primary.expectedCAGR ?? base?.cagr ?? null,
    bearCAGR: bear,
    bullCAGR: bull,
    riskAdjustedCAGR,
    returnQualityScore,
    downsidePenalty,
    uncertaintyPenalty,
    instabilityPenalty,
    dataPenalty,
    evidenceConfidence,
    forecastStability: stability,
    returnAttribution: attribution,
  };
}

module.exports = { computeExpectedReturnProfile, forecastStability };
