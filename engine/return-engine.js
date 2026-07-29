'use strict';

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Institutional price-target return engine.
 *
 * Important invariant:
 *   expectedCAGR must always be the CAGR from currentPrice to actionableExitPrice
 *   including the modeled dividends. Previously the engine rebuilt CAGR from
 *   operating-growth components, so the displayed CAGR could disagree with the
 *   displayed five-year target (for example, AMD showed 19.3% even though
 *   $437.91 -> $485.36 is only about 2.1% annually).
 */
function computeReturnEngineV2(stock, model, rawMarketExitPrice, consensus) {
  const current = stock.price?.current;
  const years = model.projection?.length || 5;
  if (!(current > 0) || !(years > 0)) {
    return { expectedCAGR: null, actionableCAGR: null, actionableExitPrice: null };
  }

  const last = stock.financials?.years?.at(-1) || {};
  const exit = model.projection?.at(-1) || {};

  const revenueGrowth = last.revenue > 0 && exit.revenue > 0
    ? Math.pow(exit.revenue / last.revenue, 1 / years) - 1
    : 0;

  const startMargin = last.revenue > 0 ? last.netIncome / last.revenue : null;
  const marginExpansion = startMargin > 0 && exit.netMargin > 0
    ? Math.pow(exit.netMargin / startMargin, 1 / years) - 1
    : 0;

  const shareCountEffect = last.sharesOutTTM > 0 && exit.shares > 0
    ? Math.pow(last.sharesOutTTM / exit.shares, 1 / years) - 1
    : 0;

  const dividendContribution = clamp(stock.valuation?.dividendYield || 0, 0, 0.08);
  const dividendsReceived = current * dividendContribution * years;

  const rawMarketCAGR = rawMarketExitPrice > 0
    ? Math.pow((rawMarketExitPrice + dividendsReceived) / current, 1 / years) - 1
    : null;

  if (!Number.isFinite(rawMarketCAGR)) {
    return {
      expectedCAGR: null,
      actionableCAGR: null,
      rawMarketCAGR: null,
      actionableExitPrice: null,
      rawMarketExitPrice: rawMarketExitPrice ?? null,
      dividendsReceived,
      breakdown: {
        revenueGrowth,
        marginExpansion,
        shareCountEffect,
        dividendContribution,
        multipleRerating: null,
      },
    };
  }

  // Only constrain truly extreme targets. The cap changes the target price as well as
  // the CAGR, preserving the mathematical relationship shown in the audit.
  let upperCap = 0.40;
  const regime = consensus?.agreementRegime;
  if (regime === 'extreme-disagreement') upperCap = 0.25;
  else if (regime === 'large-disagreement') upperCap = 0.30;
  else if (regime === 'moderate-disagreement') upperCap = 0.35;

  const actionableCAGR = clamp(rawMarketCAGR, -0.75, upperCap);
  const wasCapped = Math.abs(actionableCAGR - rawMarketCAGR) > 1e-12;

  // Solve the target price backward from the actionable CAGR so the displayed target
  // and displayed CAGR can never contradict each other.
  const actionableTotalFutureValue = current * Math.pow(1 + actionableCAGR, years);
  const actionableExitPrice = Math.max(0, actionableTotalFutureValue - dividendsReceived);

  const fundamentalCAGR =
    clamp(revenueGrowth, -0.15, 0.30) +
    clamp(marginExpansion, -0.05, 0.06) +
    clamp(shareCountEffect, -0.05, 0.06) +
    dividendContribution;

  const multipleRerating = actionableCAGR - fundamentalCAGR;
  const multipleShare = Math.abs(actionableCAGR) > 1e-6
    ? Math.abs(multipleRerating / actionableCAGR)
    : 0;

  return {
    // `expectedCAGR` is the exact return implied by `actionableExitPrice`.
    expectedCAGR: actionableCAGR,
    actionableCAGR,
    rawMarketCAGR,
    uncappedMarketCAGR: rawMarketCAGR,
    rawMarketExitPrice,
    actionableExitPrice,
    dividendsReceived,
    wasCapped,
    capApplied: wasCapped ? upperCap : null,
    fundamentalCAGR,
    breakdown: {
      revenueGrowth,
      marginExpansion,
      shareCountEffect,
      dividendContribution,
      multipleRerating,
    },
    multipleDominated: multipleShare > 0.5,
    multipleShare,
  };
}

module.exports = { computeReturnEngineV2 };
