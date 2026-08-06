'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));

function band(score) {
  if (score >= 80) return 'Very High';
  if (score >= 65) return 'High';
  if (score >= 45) return 'Medium';
  if (score >= 25) return 'Low';
  return 'Very Low';
}

/**
 * Measures how much operating perfection is already embedded in the share price.
 * High score = demanding expectations / fragile underwriting.
 */
function computeExpectationRisk(stock, model, marketExpectations, primaryValuation, lifecycle = {}, businessProfile = {}) {
  const implied = Number(marketExpectations?.impliedRevenueGrowth);
  const modeled1 = Number(marketExpectations?.modeledYear1Growth);
  const modeled5 = Number(marketExpectations?.modeledYear5Growth);
  const gap = finite(implied) && finite(modeled1) ? implied - modeled1 : 0;
  const valuationContribution = Number(primaryValuation?.probabilityWeightedValuationDrag ?? primaryValuation?.rawValuationDrag ?? 0);
  const currentPe = Number(stock?.valuation?.currentPE ?? stock?.pe ?? stock?.metrics?.pe);
  const agreement = Number(stock?.valuation?.valuationConsensus?.agreementScore ?? stock?.valuation?.agreementScore ?? 50);
  const confidence = Number(businessProfile?.forecastReliability ?? lifecycle?.confidence ?? .50);
  const persistence = Number(businessProfile?.premiumPersistence ?? .50);
  const moat = Number(stock?.valuation?.moat?.score ?? 50) / 100;
  const industry = stock?.valuation?.industryModel?.model || 'general';
  const stage = lifecycle?.stage || '';

  const expectationsPressure = clamp((gap + .02) / .18, 0, 1);
  const multiplePressure = currentPe > 0 ? clamp((currentPe - 24) / 36, 0, 1) : 0;
  const reratingDependence = clamp(Math.abs(valuationContribution) / .12, 0, 1);
  const maturityMismatch = clamp((modeled1 - modeled5 - .06) / .20, 0, 1);
  const weakEvidence = clamp(1 - (agreement / 100 * .45 + confidence * .30 + persistence * .15 + moat * .10), 0, 1);

  let industryRisk = 0;
  if (industry === 'healthcare-innovation') industryRisk += .16;
  if (industry === 'semiconductors-hardware') industryRisk += .08;
  if (/Hyper Growth/.test(stage)) industryRisk += .08;
  if (/Turnaround|Cyclical/.test(stage)) industryRisk += .07;

  const score01 = clamp(
    expectationsPressure * .34 + multiplePressure * .18 + reratingDependence * .17 +
    maturityMismatch * .11 + weakEvidence * .12 + industryRisk,
    0, 1
  );
  const score = Math.round(score01 * 100);

  const warnings = [];
  if (gap > .04) warnings.push('Current price requires materially more growth than the central forecast.');
  if (multiplePressure > .65) warnings.push('Starting valuation leaves limited room for execution misses.');
  if (maturityMismatch > .55) warnings.push('Growth is expected to slow materially before the terminal year.');
  if (industry === 'healthcare-innovation') warnings.push('Pipeline, patent and product-concentration risk may not be fully visible in financial statements.');
  if (reratingDependence > .60) warnings.push('A large portion of modeled return depends on valuation change.');

  return {
    version: 'v52-expectation-risk-1',
    score,
    level: band(score),
    expectationsGap: finite(implied) && finite(modeled1) ? modeled1 - implied : null,
    impliedGrowth: finite(implied) ? implied : null,
    modeledYear1Growth: finite(modeled1) ? modeled1 : null,
    modeledYear5Growth: finite(modeled5) ? modeled5 : null,
    components: { expectationsPressure, multiplePressure, reratingDependence, maturityMismatch, weakEvidence, industryRisk },
    warnings,
    confidenceMultiplier: clamp(1 - score01 * .28, .72, 1),
    cagrPenalty: clamp(Math.max(0, score01 - .35) * .035, 0, .022),
    positionSizeMultiplier: clamp(1 - score01 * .45, .50, 1),
  };
}

module.exports = { computeExpectationRisk };
