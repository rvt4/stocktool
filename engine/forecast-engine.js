'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function historicalGrowth(years) {
  const rates = [];
  for (let i = 1; i < years.length; i++) {
    if (years[i - 1].revenue > 0 && years[i].revenue > 0) {
      rates.push(years[i].revenue / years[i - 1].revenue - 1);
    }
  }
  return median(rates.slice(-5));
}

function trendGrowth(years) {
  const rates = [];
  for (let i = 1; i < years.length; i++) {
    if (years[i - 1].revenue > 0 && years[i].revenue > 0) {
      rates.push(years[i].revenue / years[i - 1].revenue - 1);
    }
  }
  if (!rates.length) return null;
  const recent = rates.slice(-3);
  const weights = recent.map((_, i) => i + 1);
  return mean(recent.map((g, i) => g * weights[i])) / mean(weights);
}

const STAGE = {
  'Hyper Growth': {
    longRunFloor: 0.085,
    longRunCap: 0.22,
    excessRetention: 0.52,
    maxRevenueMultiple: 9.0,
    scaleCaps: [[1.8, 0.55], [2.8, 0.40], [4.5, 0.30], [6.5, 0.23], [9.0, 0.18], [Infinity, 0.13]],
  },
  Growth: {
    longRunFloor: 0.06,
    longRunCap: 0.16,
    excessRetention: 0.48,
    maxRevenueMultiple: 6.5,
    scaleCaps: [[1.7, 0.38], [2.5, 0.29], [3.8, 0.22], [5.0, 0.17], [6.5, 0.13], [Infinity, 0.10]],
  },
  'Elite Compounder': {
    longRunFloor: 0.055,
    longRunCap: 0.14,
    excessRetention: 0.60,
    maxRevenueMultiple: 4.8,
    scaleCaps: [[1.7, 0.27], [2.5, 0.20], [3.5, 0.15], [4.8, 0.115], [Infinity, 0.085]],
  },
  'Temporary Disruption': {
    longRunFloor: 0.055,
    longRunCap: 0.16,
    excessRetention: 0.52,
    maxRevenueMultiple: 5.0,
    scaleCaps: [[1.7, 0.34], [2.5, 0.27], [3.6, 0.20], [5.0, 0.14], [Infinity, 0.10]],
  },
  Compounder: {
    longRunFloor: 0.045,
    longRunCap: 0.13,
    excessRetention: 0.58,
    maxRevenueMultiple: 4.5,
    scaleCaps: [[1.6, 0.25], [2.4, 0.18], [3.3, 0.14], [4.5, 0.11], [Infinity, 0.08]],
  },
  Turnaround: {
    longRunFloor: 0.025,
    longRunCap: 0.10,
    excessRetention: 0.42,
    maxRevenueMultiple: 3.0,
    scaleCaps: [[1.5, 0.22], [2.1, 0.15], [3.0, 0.10], [Infinity, 0.07]],
  },
  Cyclical: {
    longRunFloor: 0.015,
    longRunCap: 0.075,
    excessRetention: 0.34,
    maxRevenueMultiple: 2.4,
    scaleCaps: [[1.4, 0.16], [1.9, 0.10], [2.4, 0.07], [Infinity, 0.05]],
  },
  'Dividend Compounder': {
    longRunFloor: 0.018,
    longRunCap: 0.065,
    excessRetention: 0.48,
    maxRevenueMultiple: 2.5,
    scaleCaps: [[1.5, 0.13], [2.0, 0.09], [2.5, 0.065], [Infinity, 0.045]],
  },
  Mature: {
    longRunFloor: 0.015,
    longRunCap: 0.07,
    excessRetention: 0.38,
    maxRevenueMultiple: 2.4,
    scaleCaps: [[1.4, 0.13], [1.9, 0.09], [2.4, 0.065], [Infinity, 0.04]],
  },
  Financial: {
    longRunFloor: 0.02,
    longRunCap: 0.09,
    excessRetention: 0.40,
    maxRevenueMultiple: 2.6,
    scaleCaps: [[1.5, 0.15], [2.0, 0.10], [2.6, 0.075], [Infinity, 0.05]],
  },
  Utility: {
    longRunFloor: 0.018,
    longRunCap: 0.065,
    excessRetention: 0.45,
    maxRevenueMultiple: 2.2,
    scaleCaps: [[1.4, 0.11], [1.8, 0.075], [2.2, 0.055], [Infinity, 0.04]],
  },
  'Asset Heavy': {
    longRunFloor: 0.012,
    longRunCap: 0.07,
    excessRetention: 0.34,
    maxRevenueMultiple: 2.3,
    scaleCaps: [[1.4, 0.14], [1.8, 0.09], [2.3, 0.06], [Infinity, 0.04]],
  },
  Dividend: {
    longRunFloor: 0.018,
    longRunCap: 0.065,
    excessRetention: 0.48,
    maxRevenueMultiple: 2.5,
    scaleCaps: [[1.5, 0.13], [2.0, 0.09], [2.5, 0.065], [Infinity, 0.045]],
  },
  Value: {
    longRunFloor: 0.018,
    longRunCap: 0.08,
    excessRetention: 0.40,
    maxRevenueMultiple: 2.6,
    scaleCaps: [[1.5, 0.15], [2.0, 0.10], [2.6, 0.075], [Infinity, 0.05]],
  },
};

function scaleGrowthCap(config, revenueMultiple) {
  for (const [limit, cap] of config.scaleCaps) {
    if (revenueMultiple <= limit) return cap;
  }
  return config.scaleCaps.at(-1)[1];
}

function cumulativeExpansionDamping(config, projectedMultiple) {
  const softStart = config.maxRevenueMultiple * 0.72;
  if (projectedMultiple <= softStart) return 1;
  const progress = (projectedMultiple - softStart) / Math.max(0.1, config.maxRevenueMultiple - softStart);
  return clamp(1 - progress * 0.70, 0.18, 1);
}

function generateForecast(stock, category, years = 5, calibration = null) {
  const e = stock.analystEstimates || {};
  const financials = stock.financials?.years || [];
  const lastRevenue = financials.at(-1)?.revenue || 1;
  const hist = historicalGrowth(financials);
  const trend = trendGrowth(financials);
  const fallback = stock.growthYear1 ?? hist ?? 0.05;

  let analyst1 = e.revenueGrowthCurrentYear ?? e.revenueGrowthFwd ?? null;
  let analyst2 = e.revenueGrowthNextYear ?? null;
  if (analyst2 == null && e.revenueCurrentYear > 0 && e.revenueNextYear > 0) {
    analyst2 = e.revenueNextYear / e.revenueCurrentYear - 1;
  }

  const avgRoic = mean(financials.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const reinvest = clamp(stock.reinvestmentRate ?? 0.40, 0.10, 0.80);
  const sustainable = avgRoic != null ? clamp(avgRoic, 0, 0.40) * reinvest : null;
  const analystRel = clamp((e.numAnalysts || 0) / 25, 0.20, 1);
  const shockGap = analyst1 != null && hist != null ? analyst1 - hist : 0;
  const regimeShift = Math.abs(shockGap) >= 0.10;
  const industry = stock.valuation?.industryModel?.model || 'general';
  const cal = calibration?.forecastByIndustry?.[industry] || calibration?.forecastOverall || {};
  const analystBias = Number(cal.analystBias) || 0;
  const historyBias = Number(cal.historyBias) || 0;
  const ownBias = Number(cal.ownBias) || 0;

  let weights = {
    analyst: analyst1 != null ? 0.46 : 0,
    history: hist != null ? 0.22 : 0,
    trend: trend != null ? 0.12 : 0,
    sustainable: sustainable != null ? 0.20 : 0,
  };
  if (regimeShift) {
    weights.analyst += 0.16;
    weights.history *= 0.55;
    weights.trend *= 0.55;
  }
  if (analystRel < 0.45) {
    weights.analyst *= 0.72;
    weights.history *= 1.15;
    weights.sustainable *= 1.10;
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  Object.keys(weights).forEach(k => { weights[k] /= total; });

  const corrected = {
    analyst: analyst1 == null ? null : analyst1 + analystBias,
    history: hist == null ? null : hist + historyBias,
    trend: trend == null ? null : trend + historyBias,
    sustainable: sustainable == null ? null : sustainable + ownBias,
  };

  const y1 = clamp(
    Object.entries(weights).reduce((s, [k, w]) => s + (corrected[k] ?? 0) * w, 0),
    -0.30,
    0.70
  );
  const raw2 = analyst2 != null
    ? analyst2 + analystBias
    : y1 * (['Hyper Growth', 'Growth', 'Temporary Disruption', 'Elite Compounder', 'Compounder'].includes(category) ? 0.82 : 0.70);
  let y2 = clamp(raw2, -0.25, 0.60);
  if (category === 'Temporary Disruption' && analyst2 != null) {
    y2 = clamp(analyst2 + analystBias, -0.15, 0.45);
  }

  const cfg = STAGE[category] || STAGE.Value;
  const normalizedInputs = [hist, sustainable, trend, y2]
    .filter(Number.isFinite)
    .map(x => clamp(x, -0.10, cfg.longRunCap));
  const longRunAnchor = clamp(
    mean(normalizedInputs) ?? cfg.longRunFloor,
    cfg.longRunFloor,
    cfg.longRunCap
  );

  const path = [y1];
  if (years >= 2) path.push(y2);
  let projectedRevenue = lastRevenue * (1 + Math.max(-0.95, y1));
  if (years >= 2) projectedRevenue *= (1 + Math.max(-0.95, y2));
  let previous = y2;
  let maxProjectedMultiple = projectedRevenue / lastRevenue;
  let scaleAdjustments = 0;

  for (let t = 3; t <= years; t++) {
    // Multi-stage fade: near-term analyst acceleration is allowed, but the excess
    // above a sustainable anchor decays quickly as the revenue base expands.
    let growth = longRunAnchor + (previous - longRunAnchor) * cfg.excessRetention;

    const currentMultiple = projectedRevenue / lastRevenue;
    growth = Math.min(growth, scaleGrowthCap(cfg, currentMultiple));

    const undampedMultiple = currentMultiple * (1 + Math.max(-0.95, growth));
    const damping = cumulativeExpansionDamping(cfg, undampedMultiple);
    if (damping < 0.999) scaleAdjustments += 1;
    growth = longRunAnchor + (growth - longRunAnchor) * damping;

    // Once the soft cumulative ceiling has been reached, permit continued growth,
    // but require it to converge toward mature growth rather than compounding an
    // implausibly large profit pool indefinitely.
    if (undampedMultiple > cfg.maxRevenueMultiple) {
      const matureAnchor = Math.max(0.035, cfg.longRunFloor * 0.75);
      growth = Math.min(growth, matureAnchor + 0.015);
      scaleAdjustments += 1;
    }

    growth = clamp(growth, -0.20, 0.55);
    path.push(growth);
    projectedRevenue *= (1 + Math.max(-0.95, growth));
    maxProjectedMultiple = Math.max(maxProjectedMultiple, projectedRevenue / lastRevenue);
    previous = growth;
  }

  const expansionRatio = projectedRevenue / lastRevenue;
  const excessExpansion = Math.max(0, expansionRatio / cfg.maxRevenueMultiple - 1);
  const plausibilityScore = Math.round(clamp(
    100 - excessExpansion * 70 - scaleAdjustments * 2.5 - Math.max(0, (path.at(-1) || 0) - 0.20) * 130,
    20,
    100
  ));

  return {
    path: path.slice(0, years),
    source: 'v10_multistage_scale_aware_forecast',
    assumptions: {
      analyst1,
      analyst2,
      historical: hist,
      trend,
      sustainable,
      weights,
      regimeShift,
      shockGap,
      analystReliability: analystRel,
      calibrationApplied: !!calibration?.isCalibrated,
      year1: y1,
      year2: y2,
      longRunAnchor,
      projectedRevenueMultiple: expansionRatio,
      maximumPreferredRevenueMultiple: cfg.maxRevenueMultiple,
      scaleAdjustments,
      plausibilityScore,
    },
  };
}

module.exports = { generateForecast, historicalGrowth, trendGrowth };
