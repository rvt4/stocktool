'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const ABSOLUTE_CAPS = {
  revenueExit: { 'Hyper Growth': 12, Growth: 9, 'Elite Compounder': 8, Compounder: 7, Mature: 5.5 },
  epsExit: { 'Hyper Growth': 48, Growth: 40, 'Elite Compounder': 38, Compounder: 34, Mature: 28 },
  ebitdaExit: { 'Hyper Growth': 30, Growth: 25, 'Elite Compounder': 24, Compounder: 21, Mature: 17 },
};

function deriveExitMultiple({ current, sector, exitGrowth, valuationGrowth = null, lifecycle, moat, type, revenueScale = 1, forecastYears = 5, premiumPersistence = null }) {
  if (!(sector > 0)) return { multiple: null, reason: 'missing sector anchor' };

  const stage = lifecycle?.stage || 'Mature';
  const m = clamp((moat?.score ?? 50) / 100, 0, 1);
  const growth = clamp(exitGrowth ?? 0.03, -0.10, 0.35);
  // Terminal-year growth can understate the economics of a business that is still
  // transitioning toward maturity. Use a smoothed valuation growth signal when
  // available, while still keeping the final-year rate influential.
  const valueGrowth = clamp(valuationGrowth ?? growth, -0.10, 0.35);
  const effectiveGrowth = clamp(growth * 0.55 + valueGrowth * 0.45, -0.10, 0.35);
  const g = clamp(effectiveGrowth / 0.22, 0, 1.25);
  const persistence = clamp(premiumPersistence ?? ((moat?.score ?? 50) / 100), 0, 1);

  // Sector is an anchor, not a destination. A durable company can retain a
  // premium, but that premium must decline as the projected enterprise becomes
  // enormous and the forecast horizon advances toward maturity.
  const structuralPremium = clamp(
    (m - 0.48) * 1.10 + (g - 0.20) * (type === 'revenueExit' ? 0.72 : 0.52),
    -0.30,
    1.20
  );
  const durableAnchor = sector * (1 + structuralPremium);

  const retentionBase = {
    'Hyper Growth': 0.54,
    Growth: 0.46,
    'Elite Compounder': 0.52,
    Compounder: 0.42,
    'Dividend Compounder': 0.28,
    Turnaround: 0.20,
    Cyclical: 0.14,
    Mature: 0.24,
    Financial: 0.22,
    Utility: 0.22,
    'Asset Heavy': 0.16,
  }[stage] ?? 0.24;

  const moatBoost = (m - 0.50) * 0.22;
  const persistenceBoost = (persistence - 0.50) * 0.20;
  const growthBoost = clamp(effectiveGrowth - 0.05, 0, 0.20) * 0.65;
  const horizonPenalty = clamp((forecastYears - 5) * 0.025, 0, 0.18);
  const scalePenalty = clamp(Math.log2(Math.max(1, revenueScale)) * 0.075, 0, 0.28);
  const retention = clamp(retentionBase + moatBoost + persistenceBoost + growthBoost - horizonPenalty - scalePenalty, 0.08, 0.74);

  const stageCurrentCap = stage === 'Hyper Growth' ? 3.2
    : stage === 'Growth' ? 2.7
      : stage === 'Elite Compounder' ? 2.6
        : stage === 'Compounder' ? 2.2
          : 1.8;
  const currentBound = current > 0 ? clamp(current, sector * 0.45, sector * stageCurrentCap) : null;
  let multiple = currentBound
    ? durableAnchor * (1 - retention) + currentBound * retention
    : durableAnchor;

  // A company projected to become many times larger cannot simultaneously retain
  // an early-stage multiple. This is the missing maturity/scale penalty that
  // caused AMD's prior output to explode.
  const maturityMultiplier = clamp(
    1 - Math.max(0, revenueScale - 3) * 0.035 - Math.max(0, forecastYears - 7) * 0.018,
    0.55,
    1
  );
  multiple *= maturityMultiplier;

  const stageCaps = ABSOLUTE_CAPS[type] || ABSOLUTE_CAPS.epsExit;
  const absoluteCap = stageCaps[stage] ?? stageCaps.Mature;
  const growthAdjustedCap = type === 'revenueExit'
    ? clamp(2.0 + Math.max(0, effectiveGrowth) * 36 + m * 2.5 + persistence * 1.2, 2.5, absoluteCap)
    : type === 'epsExit'
      ? clamp(16 + Math.max(0, effectiveGrowth) * 95 + m * 8 + persistence * 5, 18, absoluteCap)
      : clamp(9 + Math.max(0, effectiveGrowth) * 58 + m * 5 + persistence * 3, 10, absoluteCap);

  const max = Math.min(
    sector * (stage === 'Hyper Growth' ? 2.8 : stage === 'Growth' ? 2.4 : stage === 'Elite Compounder' ? 2.3 : stage === 'Compounder' ? 2.0 : 1.65),
    growthAdjustedCap
  );
  const floor = type === 'revenueExit' ? 0.8 : type === 'epsExit' ? 8 : 5;
  multiple = clamp(multiple, Math.max(floor, sector * 0.45), Math.max(floor, max));

  return {
    multiple,
    currentMultiple: currentBound,
    sectorMultiple: sector,
    durableAnchor,
    retention,
    structuralPremium,
    premiumPersistence: persistence,
    valuationGrowth: valueGrowth,
    effectiveGrowth,
    maturityMultiplier,
    scalePenalty,
    horizonPenalty,
    revenueScale,
    forecastYears,
    growthAdjustedCap,
    lifecycleStage: stage,
    moatScore: moat?.score ?? null,
    reason: 'lifecycle-moat-scale fade',
  };
}

module.exports = { deriveExitMultiple };
