'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}
function scoreHigher(value, poor, strong) {
  if (!Number.isFinite(value)) return 50;
  return Math.round(clamp((value - poor) / (strong - poor), 0, 1) * 100);
}
function scoreLower(value, strong, poor) {
  if (!Number.isFinite(value)) return 50;
  return Math.round(clamp((poor - value) / (poor - strong), 0, 1) * 100);
}
function annualizedVolatility(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 3) return null;
  const avg = mean(clean);
  return Math.sqrt(mean(clean.map(v => (v - avg) ** 2)));
}

/**
 * Stable business-quality layer.  It deliberately excludes current price,
 * fair value and expected return so valuation changes cannot rewrite quality.
 */
function computeEconomicQuality(stock, pricingPower, compounder, industryModel) {
  const years = stock.financials?.years || [];
  const recent = years.slice(-5);
  const last = recent.at(-1) || {};
  const revenues = recent.map(y => y.revenue).filter(v => v > 0);
  const fcfMargins = recent.map(y => y.revenue > 0 ? y.fcf / y.revenue : null).filter(Number.isFinite);
  const opMargins = recent.map(y => y.revenue > 0 ? y.operatingIncome / y.revenue : y.opMargin).filter(Number.isFinite);
  const roics = recent.map(y => y.roic).filter(Number.isFinite).map(v => Math.abs(v) > 2 ? v / 100 : v);
  const debtToEbitda = Number(last.debtToEbitda ?? stock.metrics?.debtToEbitda);
  const interestCoverage = Number(last.interestCoverage ?? stock.metrics?.interestCoverage);
  const positiveFcfRate = recent.length ? recent.filter(y => Number(y.fcf) > 0).length / recent.length : null;
  const marginVolatility = annualizedVolatility(opMargins);
  const dilution = recent.length >= 2 && recent[0].sharesOutTTM > 0 && last.sharesOutTTM > 0
    ? Math.pow(last.sharesOutTTM / recent[0].sharesOutTTM, 1 / Math.max(1, recent.length - 1)) - 1
    : null;

  const durability = Math.round(
    scoreHigher(mean(roics), 0.05, 0.25) * 0.34 +
    scoreHigher(positiveFcfRate, 0.40, 1.00) * 0.25 +
    scoreLower(marginVolatility, 0.01, 0.12) * 0.18 +
    scoreHigher(Number(compounder?.score) / 100, 0.35, 0.85) * 0.23
  );
  const balanceSheet = Math.round(
    scoreLower(debtToEbitda, 0.5, 4.5) * 0.55 +
    scoreHigher(interestCoverage, 2, 15) * 0.30 +
    scoreHigher(Number(last.cash) - Number(last.longTermDebt || 0), -Math.abs(Number(last.revenue || 1)), Math.abs(Number(last.revenue || 1))) * 0.15
  );
  const cashEconomics = Math.round(
    scoreHigher(mean(fcfMargins), 0.02, 0.25) * 0.45 +
    scoreHigher(positiveFcfRate, 0.40, 1.00) * 0.35 +
    scoreLower(dilution, -0.02, 0.08) * 0.20
  );
  const pricing = Math.round(clamp(Number(pricingPower?.score ?? 50), 0, 100));
  const reinvestment = Math.round(clamp(
    scoreHigher(mean(roics), 0.05, 0.25) * 0.60 +
    scoreHigher(Number(compounder?.growthQualityScore ?? compounder?.score) / 100, 0.35, 0.85) * 0.40,
    0, 100
  ));
  const overall = Math.round(
    durability * 0.28 + balanceSheet * 0.17 + cashEconomics * 0.21 +
    pricing * 0.17 + reinvestment * 0.17
  );

  return {
    version: 'economic-quality-v1',
    overall,
    durability,
    balanceSheet,
    cashEconomics,
    pricingPower: pricing,
    reinvestment,
    positiveFcfRate,
    averageRoic: mean(roics),
    averageFcfMargin: mean(fcfMargins),
    operatingMarginVolatility: marginVolatility,
    annualDilution: dilution,
    industry: industryModel?.model || industryModel?.key || 'general',
    evidenceYears: recent.length,
  };
}

module.exports = { computeEconomicQuality };
