'use strict';

const { assessReturnQuality } = require('./reality-check-engine');

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function computeReturnEngineV2(stock, model, rawMarketExitPrice, consensus, lifecycle = null) {
  const current = stock.price?.current;
  const years = model.projection?.length || 5;
  if (!(current > 0) || !(years > 0)) {
    return { expectedCAGR: null, actionableCAGR: null, actionableExitPrice: null };
  }

  const last = stock.financials?.years?.at(-1) || {};
  const exit = model.projection?.at(-1) || {};
  const revenueGrowth = last.revenue > 0 && exit.revenue > 0
    ? Math.pow(exit.revenue / last.revenue, 1 / years) - 1 : 0;
  const startMargin = last.revenue > 0 ? last.netIncome / last.revenue : null;
  const marginExpansion = startMargin > 0 && exit.netMargin > 0
    ? Math.pow(exit.netMargin / startMargin, 1 / years) - 1 : 0;
  const shareCountEffect = last.sharesOutTTM > 0 && exit.shares > 0
    ? Math.pow(last.sharesOutTTM / exit.shares, 1 / years) - 1 : 0;
  const dividendContribution = clamp(stock.valuation?.dividendYield || 0, 0, 0.08);
  const dividendsReceived = current * dividendContribution * years;
  const rawMarketCAGR = rawMarketExitPrice > 0
    ? Math.pow((rawMarketExitPrice + dividendsReceived) / current, 1 / years) - 1 : null;

  if (!Number.isFinite(rawMarketCAGR)) {
    return { expectedCAGR: null, actionableCAGR: null, rawMarketCAGR: null, actionableExitPrice: null,
      rawMarketExitPrice: rawMarketExitPrice ?? null, dividendsReceived,
      breakdown: { revenueGrowth, marginExpansion, shareCountEffect, dividendContribution, multipleRerating: null } };
  }

  // Use geometric per-share earnings compounding as the primary fundamental signal.
  // Adding revenue, margin and buyback CAGRs can materially overstate business-value
  // growth when several high-growth assumptions overlap.
  const startPerShare = last.sharesOutTTM > 0
    ? ((last.netIncome > 0 ? last.netIncome : last.fcf > 0 ? last.fcf : null) / last.sharesOutTTM)
    : null;
  const exitPerShare = exit.shares > 0
    ? ((exit.netIncome > 0 ? exit.netIncome : exit.fcf > 0 ? exit.fcf : null) / exit.shares)
    : null;
  const geometricPerShareCAGR = startPerShare > 0 && exitPerShare > 0
    ? Math.pow(exitPerShare / startPerShare, 1 / years) - 1
    : null;
  const additiveFallback = clamp(revenueGrowth, -0.15, 0.28)
    + clamp(marginExpansion, -0.05, 0.055)
    + clamp(shareCountEffect, -0.05, 0.05);
  const stage = lifecycle?.stage || 'Mature';
  const operatingCaps = {
    Mature: 0.14, 'Dividend Compounder': 0.15, Financial: 0.16, Utility: 0.13,
    'Asset Heavy': 0.16, Cyclical: 0.18, Turnaround: 0.20, Compounder: 0.19,
    'Elite Compounder': 0.21, Growth: 0.23, 'Temporary Disruption': 0.21,
    'Hyper Growth': 0.27,
  };
  let operatingFundamental = Number.isFinite(geometricPerShareCAGR) ? geometricPerShareCAGR : additiveFallback;
  const marketCap = stock.valuation?.marketCap || 0;
  let operatingCap = operatingCaps[stage] ?? 0.16;
  if (marketCap >= 300e9) operatingCap -= 0.015;
  if (marketCap >= 800e9) operatingCap -= 0.015;
  operatingFundamental = clamp(operatingFundamental, -0.20, operatingCap);
  const fundamentalCAGR = operatingFundamental + dividendContribution;
  const rawMultipleRerating = rawMarketCAGR - fundamentalCAGR;
  const reality = assessReturnQuality({
    stock,
    lifecycle,
    rawCAGR: rawMarketCAGR,
    fundamentalCAGR,
    multipleRerating: rawMultipleRerating,
    agreementScore: consensus?.agreementScore ?? consensus?.methodAgreementScore ?? 50,
    forecastPlausibility: model.growthModel?.assumptions?.plausibilityScore ?? 70,
  });

  const actionableCAGR = reality.adjustedCAGR;
  const actionableTotalFutureValue = current * Math.pow(1 + actionableCAGR, years);
  const actionableExitPrice = Math.max(0, actionableTotalFutureValue - dividendsReceived);
  const multipleRerating = reality.adjustedRerating;

  return {
    expectedCAGR: actionableCAGR,
    actionableCAGR,
    rawMarketCAGR,
    uncappedMarketCAGR: rawMarketCAGR,
    rawMarketExitPrice,
    actionableExitPrice,
    dividendsReceived,
    wasCapped: Math.abs(actionableCAGR - rawMarketCAGR) > 1e-12,
    capApplied: reality.lifecycleBand?.ceiling ?? null,
    fundamentalCAGR,
    geometricPerShareCAGR,
    operatingCAGR: reality.operatingCAGR,
    returnQualityScore: reality.returnQualityScore,
    returnQualityFlags: reality.flags,
    reratingClosureFactor: reality.closureFactor,
    lifecycleReturnBand: reality.lifecycleBand,
    breakdown: { revenueGrowth, marginExpansion, shareCountEffect, dividendContribution, multipleRerating },
    multipleDominated: reality.reratingShare > 0.50,
    multipleShare: reality.reratingShare,
    realityCheck: reality,
  };
}

module.exports = { computeReturnEngineV2 };
