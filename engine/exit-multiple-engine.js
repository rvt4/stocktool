'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const CEILINGS = {
  epsExit: [[.05, 18], [.08, 23], [.12, 29], [.18, 37], [.25, 46], [1, 58]],
  ebitdaExit: [[.05, 10], [.08, 14], [.12, 18], [.18, 23], [.25, 29], [1, 36]],
  revenueExit: [[.05, 2.5], [.08, 4.2], [.12, 6.4], [.18, 9.5], [.25, 13.5], [1, 18]],
};

function growthCeiling(type, growth) {
  const rows = CEILINGS[type] || CEILINGS.epsExit;
  const g = Math.max(-.20, Number(growth || 0));
  for (const [cut, cap] of rows) if (g <= cut) return cap;
  return rows.at(-1)[1];
}

/**
 * Final guardrail after the dynamic multiple model. It permits durable quality
 * premiums, but prevents a high current multiple from becoming its own proof.
 */
function applyExitMultipleDiscipline({
  type,
  rawMultiple,
  exitGrowth,
  valuationGrowth = null,
  quality = .50,
  forecastReliability = .50,
  premiumPersistence = .50,
  lifecycleStage = 'Mature',
  sectorMultiple = null,
  industry = null,
}) {
  if (!(rawMultiple > 0)) return { multiple: null, rawMultiple, ceiling: null, wasCapped: false };

  const effectiveGrowth = clamp((Number(exitGrowth || 0) * .45) + (Number(valuationGrowth ?? exitGrowth ?? 0) * .55), -.20, .50);
  const persistence = clamp(Number(premiumPersistence || 0), 0, 1);
  const q = clamp(Number(quality || 0), 0, 1);
  const reliability = clamp(Number(forecastReliability || 0), 0, 1);

  let ceiling = growthCeiling(type, effectiveGrowth);
  // Quality can expand the cap, but only when persistence and forecast evidence
  // jointly support it. This is intentionally less punitive than V34 for elite
  // businesses and more punitive for low-quality high-multiple stocks.
  const qualitySupport = clamp((q - .50) * 1.25 + (persistence - .45) * 1.10 + (reliability - .50) * .55, -.25, .55);
  ceiling *= clamp(1 + qualitySupport, .78, 1.42);

  if (industry === 'semiconductors-hardware') {
    const durable = q >= .65 && persistence >= .55 && reliability >= .50;
    ceiling *= type === 'revenueExit' ? (durable ? 1.02 : .86) : (durable ? 1.12 : .94);
  }
  if (industry === 'financials' && type === 'revenueExit') ceiling *= .50;

  const genericFloor = type === 'epsExit' ? 7 : type === 'ebitdaExit' ? 5 : .7;
  const durableStage = ['Growth', 'Hyper Growth', 'Elite Compounder', 'Compounder', 'Temporary Disruption'].includes(lifecycleStage);
  const support = clamp((q - .55) * 1.45 + (persistence - .50) * 1.35 + (reliability - .50) * .75, 0, 1);
  let premiumFloor = genericFloor;
  if (durableStage && sectorMultiple > 0 && support > 0) {
    const retention = type === 'epsExit' ? .62 + .28 * support
      : type === 'ebitdaExit' ? .60 + .25 * support
        : .55 + .22 * support;
    premiumFloor = Math.max(premiumFloor, sectorMultiple * retention);
  }

  const boundedCeiling = Math.max(ceiling, premiumFloor);
  const multiple = clamp(rawMultiple, premiumFloor, boundedCeiling);
  return {
    version: 'v35-exit-discipline',
    multiple,
    rawMultiple,
    ceiling: boundedCeiling,
    premiumFloor,
    wasCapped: multiple < rawMultiple,
    wasFloored: multiple > rawMultiple,
    effectiveGrowth,
    qualitySupport,
    premiumPersistence: persistence,
  };
}

module.exports = { growthCeiling, applyExitMultipleDiscipline };
