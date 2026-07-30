'use strict';

const { assessReturnQuality } = require('./reality-check-engine');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function finite(x) { return Number.isFinite(Number(x)); }

/**
 * Canonical investor-return engine.
 *
 * Investor CAGR is ALWAYS calculated from today's price, a modeled exit price,
 * and cash dividends. Business growth is retained as an explanatory diagnostic;
 * it is never substituted for investor return and never used to manufacture a
 * positive CAGR when the modeled price target implies a loss.
 */
function computeReturnEngineV2(stock, model, marketExitPrice, consensus, lifecycle = null) {
  const current = Number(stock.price?.current);
  const years = Number(model.projection?.length) || 5;
  if (!(current > 0) || !(years > 0) || !(Number(marketExitPrice) > 0)) {
    return { expectedCAGR: null, actionableCAGR: null, rawMarketCAGR: null, actionableExitPrice: null };
  }

  const exitPrice = Number(marketExitPrice);
  const last = stock.financials?.years?.at(-1) || {};
  const exit = model.projection?.at(-1) || {};
  const dividendYield = clamp(Number(stock.valuation?.dividendYield) || 0, 0, 0.12);
  // Simple cash-dividend convention. This is transparent and consistent with the
  // scenario engine. It can later be replaced with a projected dividend schedule.
  const dividendsReceived = current * dividendYield * years;
  const totalFutureValue = exitPrice + dividendsReceived;
  const investorCAGR = totalFutureValue > 0
    ? Math.pow(totalFutureValue / current, 1 / years) - 1
    : null;

  if (!finite(investorCAGR)) {
    return { expectedCAGR: null, actionableCAGR: null, rawMarketCAGR: null,
      actionableExitPrice: exitPrice, rawMarketExitPrice: exitPrice, dividendsReceived };
  }

  const revenueGrowth = last.revenue > 0 && exit.revenue > 0
    ? Math.pow(exit.revenue / last.revenue, 1 / years) - 1 : null;
  const startMargin = last.revenue > 0 ? last.netIncome / last.revenue : null;
  const marginExpansion = startMargin > 0 && exit.netMargin > 0
    ? Math.pow(exit.netMargin / startMargin, 1 / years) - 1 : null;
  const shareCountEffect = last.sharesOutTTM > 0 && exit.shares > 0
    ? Math.pow(last.sharesOutTTM / exit.shares, 1 / years) - 1 : null;

  const history = (stock.financials?.years || []).slice(-3);
  const perShareHistory = history.map(y => {
    const economic = y.netIncome > 0 ? y.netIncome : y.fcf > 0 ? y.fcf : null;
    return economic != null && y.sharesOutTTM > 0 ? economic / y.sharesOutTTM : null;
  }).filter(finite).sort((a, b) => a - b);
  const startPerShare = perShareHistory.length
    ? perShareHistory[Math.floor(perShareHistory.length / 2)]
    : null;
  const exitEconomic = exit.netIncome > 0 ? exit.netIncome : exit.fcf > 0 ? exit.fcf : null;
  const exitPerShare = exitEconomic != null && exit.shares > 0 ? exitEconomic / exit.shares : null;
  const geometricPerShareCAGR = startPerShare > 0 && exitPerShare > 0
    ? Math.pow(exitPerShare / startPerShare, 1 / years) - 1
    : null;
  const fundamentalCAGR = finite(geometricPerShareCAGR)
    ? Number(geometricPerShareCAGR) + dividendYield
    : [revenueGrowth, marginExpansion, shareCountEffect, dividendYield]
        .filter(finite).reduce((a, b) => a + Number(b), 0);
  const multipleRerating = investorCAGR - fundamentalCAGR;

  // Reality checks now score/flag the return; they do not rewrite it. Rewriting a
  // price-derived CAGR was the source of contradictions such as a $485 stock with a
  // $517 five-year target being displayed as a 13.5% CAGR.
  const reality = assessReturnQuality({
    stock,
    lifecycle,
    rawCAGR: investorCAGR,
    fundamentalCAGR,
    multipleRerating,
    agreementScore: consensus?.agreementScore ?? consensus?.methodAgreementScore ?? 50,
    forecastPlausibility: model.growthModel?.assumptions?.plausibilityScore ?? 70,
  });

  // Extreme values normally indicate split/unit corruption. Do not silently cap them
  // into plausible-looking recommendations; mark them invalid for rating purposes.
  const integrityInvalid = investorCAGR < -0.95 || investorCAGR > 2.00;

  return {
    expectedCAGR: integrityInvalid ? null : investorCAGR,
    actionableCAGR: integrityInvalid ? null : investorCAGR,
    rawMarketCAGR: investorCAGR,
    uncappedMarketCAGR: investorCAGR,
    rawMarketExitPrice: exitPrice,
    actionableExitPrice: exitPrice,
    dividendsReceived,
    totalFutureValue,
    wasCapped: false,
    capApplied: null,
    integrityInvalid,
    fundamentalCAGR,
    geometricPerShareCAGR,
    normalizedStartingPerShare: startPerShare,
    operatingCAGR: reality.operatingCAGR,
    returnQualityScore: integrityInvalid ? 0 : reality.returnQualityScore,
    returnQualityFlags: [
      ...(reality.flags || []),
      ...(integrityInvalid ? ['Investor CAGR failed the split/unit integrity range'] : []),
    ],
    reratingClosureFactor: reality.closureFactor,
    lifecycleReturnBand: reality.lifecycleBand,
    breakdown: {
      revenueGrowth,
      marginExpansion,
      shareCountEffect,
      dividendContribution: dividendYield,
      multipleRerating,
    },
    multipleDominated: Math.abs(investorCAGR) > 1e-6
      ? Math.abs(multipleRerating / investorCAGR) > 0.50
      : false,
    multipleShare: Math.abs(investorCAGR) > 1e-6
      ? Math.abs(multipleRerating / investorCAGR)
      : 0,
    realityCheck: reality,
  };
}

module.exports = { computeReturnEngineV2 };
