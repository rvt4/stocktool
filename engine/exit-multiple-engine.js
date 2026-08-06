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
  futureQuality = null,
  businessArchetype = null,
  currentMultiple = null,
}) {
  if (!(rawMultiple > 0)) return { multiple: null, rawMultiple, ceiling: null, wasCapped: false };

  const effectiveGrowth = clamp((Number(exitGrowth || 0) * .45) + (Number(valuationGrowth ?? exitGrowth ?? 0) * .55), -.20, .50);
  const persistence = clamp(Number(premiumPersistence || 0), 0, 1);
  const q = clamp(Number(quality || 0), 0, 1);
  const reliability = clamp(Number(forecastReliability || 0), 0, 1);
  const fq = clamp(Number(futureQuality ?? q), 0, 1);

  let ceiling = growthCeiling(type, effectiveGrowth);
  // Quality can expand the cap, but only when persistence and forecast evidence
  // jointly support it. This is intentionally less punitive than V34 for elite
  // businesses and more punitive for low-quality high-multiple stocks.
  const qualitySupport = clamp((q - .50) * .70 + (fq - .50) * 1.20 + (persistence - .45) * .75 + (reliability - .50) * .45, -.25, .70);
  ceiling *= clamp(1 + qualitySupport, .78, 1.42);

  if (industry === 'semiconductors-hardware') {
    const durable = q >= .65 && persistence >= .55 && reliability >= .50;
    ceiling *= type === 'revenueExit' ? (durable ? 1.02 : .86) : (durable ? 1.12 : .94);
  }
  if (industry === 'financials' && type === 'revenueExit') ceiling *= .50;

  const genericFloor = type === 'epsExit' ? 7 : type === 'ebitdaExit' ? 5 : .7;
  const archetype = String(businessArchetype || '').toLowerCase();
  const digitalFinancial = archetype.includes('digital financial');

  // Digital financial platforms deserve a distinct terminal-multiple framework.
  // They often begin at a premium, so this does NOT preserve today's multiple.
  // Instead it estimates the sustainable premium from exit growth, profitability
  // evidence, durability, and forecast reliability. This allows compression when
  // today's premium is excessive without forcing the company to a mature-bank P/E.
  let justifiedArchetypeMultiple = null;
  if (digitalFinancial && type === 'epsExit') {
    justifiedArchetypeMultiple = clamp(
      13.5 + Math.max(0, effectiveGrowth) * 38 + q * 4.0 + fq * 4.5 + persistence * 3.0 + reliability * 2.0,
      16,
      30
    );
    ceiling = Math.max(ceiling, justifiedArchetypeMultiple * 1.08);
  } else if (digitalFinancial && type === 'revenueExit') {
    justifiedArchetypeMultiple = clamp(
      1.35 + Math.max(0, effectiveGrowth) * 8.5 + q * .75 + fq * .85 + persistence * .55 + reliability * .35,
      1.8,
      5.5
    );
    ceiling = Math.max(ceiling, justifiedArchetypeMultiple * 1.10);
  }

  const durableStage = ['Growth', 'Hyper Growth', 'Elite Compounder', 'Compounder', 'Temporary Disruption'].includes(lifecycleStage);
  const support = clamp((q - .55) * .65 + (fq - .52) * 1.35 + (persistence - .50) * .85 + (reliability - .50) * .55, 0, 1);
  let premiumFloor = genericFloor;
  if (digitalFinancial && justifiedArchetypeMultiple > 0) {
    // Keep a modest discount to the justified value so the floor is a guardrail,
    // not a target. Weak quality/reliability still produces a lower multiple.
    premiumFloor = Math.max(premiumFloor, justifiedArchetypeMultiple * (.84 + .08 * support));
  }
  if (durableStage && sectorMultiple > 0 && support > 0) {
    const retention = type === 'epsExit' ? .62 + .28 * support
      : type === 'ebitdaExit' ? .60 + .25 * support
        : .55 + .22 * support;
    premiumFloor = Math.max(premiumFloor, sectorMultiple * retention);
  }

  // V40 valuation-support discipline. A high current multiple is not evidence
  // that the same premium should survive. When the stock begins far above the
  // growth-based ceiling, require unusually strong quality, persistence and
  // reliability before allowing a generous exit multiple. Elite businesses keep
  // room for a justified premium; ordinary high-multiple stocks compress faster.
  const current = Number(currentMultiple);
  const currentPremium = current > 0 ? Math.max(0, current / Math.max(ceiling, genericFloor) - 1) : 0;
  const premiumEvidence = clamp(q * .30 + fq * .30 + persistence * .25 + reliability * .15, 0, 1);
  const unsupportedPremium = currentPremium * (1 - Math.pow(premiumEvidence, 1.35));
  const valuationSupportFactor = clamp(1 - unsupportedPremium * .32, .72, 1);
  ceiling *= valuationSupportFactor;

  // Terminal-maturity fade: premium businesses may retain a justified premium,
  // but a 5-7 year exit multiple must reflect that today's hyper-growth company
  // will be larger and slower by the end of the forecast. This is applied after
  // quality support, so elite compounders are treated more gently than speculative
  // high-multiple names.
  const eliteEvidence = clamp(q * .35 + fq * .30 + persistence * .20 + reliability * .15, 0, 1);
  let maturityFadeFactor = 1;
  if (lifecycleStage === 'Hyper Growth') {
    maturityFadeFactor = clamp(.82 + eliteEvidence * .12 + Math.max(0, effectiveGrowth - .18) * .20, .82, .95);
  } else if (lifecycleStage === 'Growth') {
    maturityFadeFactor = clamp(.89 + eliteEvidence * .08, .89, .97);
  } else if (lifecycleStage === 'Temporary Disruption') {
    maturityFadeFactor = clamp(.92 + eliteEvidence * .06, .92, .98);
  } else if (lifecycleStage === 'Compounder' || lifecycleStage === 'Elite Compounder') {
    maturityFadeFactor = clamp(.96 + eliteEvidence * .04, .96, 1);
  }
  ceiling *= maturityFadeFactor;
  premiumFloor *= clamp(maturityFadeFactor + .03, .86, 1);

  // V52 expectation-risk maturity rule. Very expensive businesses whose exit
  // growth falls below 30% cannot preserve a 40x+ terminal earnings multiple
  // unless exceptional durability evidence supports it.
  let slowingGrowthCompression = 1;
  if (type === 'epsExit' && current > 40 && effectiveGrowth < .30) {
    const justifiedMax = 30 + Math.max(0, effectiveGrowth - .15) * 35 + eliteEvidence * 5;
    ceiling = Math.min(ceiling, clamp(justifiedMax, 28, 38));
    slowingGrowthCompression = clamp(ceiling / Math.max(rawMultiple, 1), .55, 1);
  }
  if (type === 'ebitdaExit' && current > 30 && effectiveGrowth < .25) {
    const justifiedMax = 18 + Math.max(0, effectiveGrowth - .12) * 28 + eliteEvidence * 4;
    ceiling = Math.min(ceiling, clamp(justifiedMax, 17, 27));
    slowingGrowthCompression = clamp(ceiling / Math.max(rawMultiple, 1), .55, 1);
  }

  const boundedCeiling = Math.max(ceiling, premiumFloor);
  const multiple = clamp(rawMultiple, premiumFloor, boundedCeiling);
  return {
    version: 'v52-expectation-risk-exit-discipline',
    multiple,
    rawMultiple,
    ceiling: boundedCeiling,
    premiumFloor,
    wasCapped: multiple < rawMultiple,
    wasFloored: multiple > rawMultiple,
    effectiveGrowth,
    qualitySupport,
    futureQuality: fq,
    premiumPersistence: persistence,
    businessArchetype,
    justifiedArchetypeMultiple,
    currentMultiple: current > 0 ? current : null,
    currentPremium,
    premiumEvidence,
    unsupportedPremium,
    valuationSupportFactor,
    maturityFadeFactor,
    eliteEvidence,
    slowingGrowthCompression,
  };
}

module.exports = { growthCeiling, applyExitMultipleDiscipline };
