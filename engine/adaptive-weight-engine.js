'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

const INDUSTRY_PRIORS = {
  software: { dcf: .22, dcfSBCAdjusted: .25, ownerEarnings: .13, revenueExit: .18, epsExit: .14, ebitdaExit: .08 },
  'semiconductors-hardware': { dcf: .29, dcfSBCAdjusted: .24, ownerEarnings: .10, revenueExit: .06, epsExit: .17, ebitdaExit: .14 },
  financials: { dcf: .10, dcfSBCAdjusted: .04, ownerEarnings: .16, revenueExit: .03, epsExit: .42, ebitdaExit: .25 },
  utilities: { dcf: .36, dcfSBCAdjusted: .08, ownerEarnings: .20, revenueExit: .03, epsExit: .18, ebitdaExit: .15 },
  general: { dcf: .26, dcfSBCAdjusted: .18, ownerEarnings: .13, revenueExit: .10, epsExit: .17, ebitdaExit: .16 },
};

function normalize(weights, availableKeys) {
  const out = {};
  let total = 0;
  for (const key of availableKeys) {
    out[key] = Math.max(0, Number(weights[key]) || 0);
    total += out[key];
  }
  if (!(total > 0)) {
    for (const key of availableKeys) out[key] = 1 / availableKeys.length;
    return out;
  }
  for (const key of availableKeys) out[key] /= total;
  return out;
}

/**
 * Learns slowly.  Priors remain dominant until a method has at least 20 mature
 * observations in the same industry.  This prevents one unusual year from
 * yo-yoing the engine.
 */
function adaptiveMethodWeights({ industry, category, startingWeights, availableKeys, calibration }) {
  const prior = { ...(INDUSTRY_PRIORS[industry] || INDUSTRY_PRIORS.general), ...(startingWeights || {}) };
  const learned = calibration?.methodAccuracy?.[industry] || {};
  const raw = {};
  const audit = {};

  for (const key of availableKeys) {
    const stats = learned[key] || {};
    const n = Math.max(0, Number(stats.observations) || 0);
    const mae = Number(stats.mae);
    const bias = Number(stats.bias);
    const evidence = clamp(n / 80, 0, 0.75); // never let learned data fully erase priors
    const accuracyScore = Number.isFinite(mae) ? clamp(1 / (0.12 + mae), 0.45, 3.0) : 1;
    const biasPenalty = Number.isFinite(bias) ? clamp(1 - Math.abs(bias) * 1.5, 0.55, 1) : 1;
    const learnedMultiplier = accuracyScore * biasPenalty;
    const shrunkMultiplier = (1 - evidence) + evidence * learnedMultiplier;
    raw[key] = (Number(prior[key]) || 0) * shrunkMultiplier;
    audit[key] = { observations: n, mae: Number.isFinite(mae) ? mae : null, bias: Number.isFinite(bias) ? bias : null, evidence, shrunkMultiplier };
  }

  return {
    weights: normalize(raw, availableKeys),
    prior: normalize(prior, availableKeys),
    audit,
    category,
    industry,
    learningActive: Object.values(audit).some(x => x.observations >= 20),
  };
}

module.exports = { adaptiveMethodWeights, INDUSTRY_PRIORS };
