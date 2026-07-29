'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

function realizedAnnualizedReturn(startPrice, currentPrice, days) {
  if (!(startPrice > 0) || !(currentPrice > 0) || !(days >= 90)) return null;
  return Math.pow(currentPrice / startPrice, 365 / days) - 1;
}

function buildCalibration(history, currentByTicker, now = new Date()) {
  const observations = [];
  for (const snap of history?.snapshots || []) {
    const ageDays = (now - new Date(snap.date)) / 86400000;
    if (ageDays < 270) continue;
    for (const old of snap.stocks || []) {
      const current = currentByTicker.get(old.ticker);
      const realized = realizedAnnualizedReturn(old.price, current?.price?.current, ageDays);
      if (!Number.isFinite(realized) || !Number.isFinite(old.expectedCAGR)) continue;
      observations.push({
        ticker: old.ticker,
        category: old.category || 'Unknown',
        industry: old.industry || 'unknown',
        forecast: old.expectedCAGR,
        realized,
        error: realized - old.expectedCAGR,
      });
    }
  }

  const group = key => {
    const out = {};
    for (const o of observations) (out[o[key]] ||= []).push(o.error);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, {
      observations: v.length,
      bias: mean(v),
      adjustment: v.length >= 8 ? clamp(mean(v) * 0.35, -0.06, 0.04) : 0,
    }]));
  };

  const overallBias = mean(observations.map(o => o.error));
  return {
    generatedAt: now.toISOString(),
    observationCount: observations.length,
    isCalibrated: observations.length >= 25,
    overall: {
      observations: observations.length,
      bias: overallBias,
      adjustment: observations.length >= 25 ? clamp(overallBias * 0.25, -0.05, 0.03) : 0,
    },
    byCategory: group('category'),
    byIndustry: group('industry'),
  };
}

function applyCalibration(profile, stock, calibration) {
  if (!profile || !Number.isFinite(profile.expectedCAGR)) return { ...profile, calibrationAdjustment: 0 };
  const industry = stock.valuation?.industryModel?.key || stock.valuation?.industryModel?.industry || 'unknown';
  const category = stock.valuation?.category || stock.category || 'Unknown';
  const industryAdj = calibration?.byIndustry?.[industry]?.adjustment || 0;
  const categoryAdj = calibration?.byCategory?.[category]?.adjustment || 0;
  const overallAdj = calibration?.overall?.adjustment || 0;
  const adjustment = clamp(industryAdj * 0.50 + categoryAdj * 0.30 + overallAdj * 0.20, -0.06, 0.04);
  return {
    ...profile,
    uncalibratedExpectedCAGR: profile.expectedCAGR,
    uncalibratedRiskAdjustedCAGR: profile.riskAdjustedCAGR,
    expectedCAGR: clamp(profile.expectedCAGR + adjustment, -0.60, 1.00),
    riskAdjustedCAGR: Number.isFinite(profile.riskAdjustedCAGR)
      ? clamp(profile.riskAdjustedCAGR + adjustment, -0.60, 1.00)
      : null,
    calibrationAdjustment: adjustment,
    calibrationObservationCount: calibration?.observationCount || 0,
    calibrationActive: !!calibration?.isCalibrated,
  };
}

module.exports = { buildCalibration, applyCalibration, realizedAnnualizedReturn };
