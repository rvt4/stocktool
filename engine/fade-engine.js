'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const ABSOLUTE_CAPS = {
  revenueExit: { 'Hyper Growth': 13, Growth: 10, 'Elite Compounder': 9, Compounder: 7.5, Mature: 5.5 },
  epsExit: { 'Hyper Growth': 54, Growth: 45, 'Elite Compounder': 42, Compounder: 36, Mature: 28 },
  ebitdaExit: { 'Hyper Growth': 34, Growth: 28, 'Elite Compounder': 26, Compounder: 22, Mature: 17 },
};

function deriveExitMultiple({ current, sector, exitGrowth, valuationGrowth = null, lifecycle, moat, type, revenueScale = 1, forecastYears = 5, premiumPersistence = null, futureEconomics = null }) {
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
  const econ = futureEconomics || {};
  const pricing = clamp(Number(econ.pricing ?? .50), 0, 1);
  const roicQuality = clamp(Number(econ.roicQuality ?? .50), 0, 1);
  const marginDurability = clamp(Number(econ.marginDurability ?? .50), 0, 1);
  const recurring = clamp(Number(econ.recurringRevenue ?? .50), 0, 1);
  const capitalAllocation = clamp(Number(econ.capitalAllocation ?? .50), 0, 1);
  const balanceSheet = clamp(Number(econ.balanceSheet ?? .50), 0, 1);
  const dilutionPenalty = clamp(Number(econ.dilutionPenalty ?? 0), 0, 1);
  const cyclicalityPenalty = clamp(Number(econ.cyclicalityPenalty ?? 0), 0, 1);
  const futureQuality = clamp(
    m * .18 + persistence * .18 + pricing * .12 + roicQuality * .16 +
    marginDurability * .12 + recurring * .08 + capitalAllocation * .08 +
    balanceSheet * .08 - dilutionPenalty * .12 - cyclicalityPenalty * .10,
    0, 1
  );

  // Sector is an anchor, not a destination. A durable company can retain a
  // premium, but that premium must decline as the projected enterprise becomes
  // enormous and the forecast horizon advances toward maturity.
  // Dynamic justified premium: growth matters, but durable quality determines
  // how much of that premium survives. A high current multiple is never used as
  // the sole justification for a high exit multiple.
  const qualityPremium = (m - 0.48) * .72 + (persistence - 0.45) * .68 + (futureQuality - .50) * 1.35;
  const growthPremium = (g - 0.20) * (type === 'revenueExit' ? 0.78 : 0.58);
  const structuralPremium = clamp(qualityPremium + growthPremium, -0.32, 1.45);
  const durableAnchor = sector * (1 + structuralPremium);

  const retentionBase = {
    'Hyper Growth': 0.60,
    Growth: 0.54,
    'Elite Compounder': 0.60,
    Compounder: 0.48,
    'Dividend Compounder': 0.28,
    Turnaround: 0.20,
    Cyclical: 0.14,
    Mature: 0.24,
    Financial: 0.22,
    Utility: 0.22,
    'Asset Heavy': 0.16,
  }[stage] ?? 0.24;

  const moatBoost = (m - 0.50) * 0.20;
  const persistenceBoost = (persistence - 0.50) * 0.22;
  const futureQualityBoost = (futureQuality - .50) * .34;
  const growthBoost = clamp(effectiveGrowth - 0.05, 0, 0.22) * 0.72;
  const horizonPenalty = clamp((forecastYears - 5) * 0.018, 0, 0.12);
  // Scale matters, but V34 penalized fast-growing businesses twice: once through
  // revenue scale and again through horizon maturity. The new penalty is gentler
  // when moat and persistence are strong.
  const rawScalePenalty = clamp(Math.log2(Math.max(1, revenueScale)) * 0.055, 0, 0.22);
  const scaleRelief = clamp((m - .55) * .22 + (persistence - .50) * .20, 0, .10);
  const scalePenalty = Math.max(0, rawScalePenalty - scaleRelief);
  const retention = clamp(retentionBase + moatBoost + persistenceBoost + futureQualityBoost + growthBoost - horizonPenalty - scalePenalty, 0.08, 0.82);

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
  const maturityRelief = clamp((m - .55) * .10 + (persistence - .50) * .10 + (futureQuality - .55) * .22, 0, .16);
  const maturityMultiplier = clamp(
    1 - Math.max(0, revenueScale - 3) * 0.022 - Math.max(0, forecastYears - 7) * 0.012 + maturityRelief,
    0.64,
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
    qualityPremium,
    futureQuality,
    futureEconomics: econ,
    growthPremium,
    scaleRelief,
    maturityRelief,
    reason: 'quality-persistence-growth fade',
  };
}

module.exports = { deriveExitMultiple };
