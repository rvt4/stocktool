'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function finite(x) { return Number.isFinite(Number(x)); }
function firstFinite(...values) { for (const v of values) if (finite(v)) return Number(v); return null; }
function mean(values) { const clean = values.filter(finite).map(Number); return clean.length ? clean.reduce((s, x) => s + x, 0) / clean.length : null; }
function cagr(a, b, n) { return a > 0 && b > 0 && n > 0 ? Math.pow(b / a, 1 / n) - 1 : null; }
function normalizeRate(v) { if (!finite(v)) return null; v = Number(v); return Math.abs(v) > 2 ? v / 100 : v; }
function band(v, poor, good, fallback = 50) {
  if (!finite(v) || good === poor) return fallback;
  return Math.round(clamp((Number(v) - poor) / (good - poor), 0, 1) * 100);
}
function latestSeries(years, aliases, positiveOnly = false) {
  return years.map(y => firstFinite(...aliases.map(k => y?.[k])))
    .filter(v => finite(v) && (!positiveOnly || v > 0));
}

/**
 * Scores how effectively management converts internally generated cash into
 * per-share value. Missing free-data inputs regress toward neutral, but the
 * score still differentiates companies using ROIC, dilution, FCF consistency,
 * leverage direction and payout discipline.
 */
function computeCapitalAllocationV2(stock) {
  const years = (stock.financials?.years || []).slice(-8);
  const roics = years.map(y => normalizeRate(firstFinite(y.roic, y.returnOnInvestedCapital, y.roicTTM))).filter(finite);
  const shares = latestSeries(years, ['sharesOutTTM', 'sharesOutstanding', 'weightedAverageShsOut', 'weightedAverageShsOutDil'], true);
  const debt = latestSeries(years, ['totalDebt', 'longTermDebt', 'longTermDebtTotal', 'netDebt']);
  const fcf = latestSeries(years, ['fcf', 'freeCashFlow', 'freeCashFlowTTM']);
  const netIncome = latestSeries(years, ['netIncome', 'netIncomeTTM', 'netIncomeApplicableToCommon']);
  const dividends = latestSeries(years, ['dividendsPaid', 'commonStockDividendsPaid', 'dividendPaid']);

  const avgRoic = mean(roics);
  const roicTrend = roics.length >= 3 ? roics.at(-1) - roics[0] : null;
  const dilution = shares.length >= 2 ? cagr(shares[0], shares.at(-1), shares.length - 1) : normalizeRate(stock.valuation?.dilutionRate ?? stock.dilutionRate);
  const debtTrend = debt.length >= 2 && Math.abs(debt[0]) > 0 ? (debt.at(-1) - debt[0]) / Math.abs(debt[0]) : null;
  const positiveFcfRate = years.length ? years.filter(y => firstFinite(y.fcf, y.freeCashFlow, y.freeCashFlowTTM) > 0).length / years.length : null;
  const fcfConversion = (() => {
    const pairs = years.map(y => {
      const f = firstFinite(y.fcf, y.freeCashFlow, y.freeCashFlowTTM);
      const ni = firstFinite(y.netIncome, y.netIncomeTTM, y.netIncomeApplicableToCommon);
      return finite(f) && finite(ni) && Math.abs(ni) > 0 ? clamp(f / Math.abs(ni), -1, 3) : null;
    }).filter(finite);
    return mean(pairs);
  })();

  const reinvestmentScore = Math.round(
    band(avgRoic, .04, .25) * .72 + band(roicTrend, -.06, .08) * .28
  );
  // -3% annual share shrinkage is excellent; +5% dilution is poor.
  const shareholderYieldScore = band(finite(dilution) ? -dilution : null, -.05, .03);
  const debtDiscipline = finite(debtTrend) ? band(-debtTrend, -.80, .35) : 50;
  const cashConversionScore = Math.round(
    band(positiveFcfRate, .40, 1) * .58 + band(fcfConversion, .35, 1.25) * .42
  );

  // Reward dividends only when they are supported by FCF; do not penalize firms
  // that rationally retain all cash at high ROIC.
  let payoutDiscipline = 50;
  if (dividends.length && fcf.length && Math.abs(fcf.at(-1)) > 0) {
    const payout = Math.abs(dividends.at(-1)) / Math.abs(fcf.at(-1));
    payoutDiscipline = payout <= .65 ? 75 : payout <= .90 ? 58 : payout <= 1.10 ? 35 : 15;
  } else if (finite(avgRoic)) {
    payoutDiscipline = avgRoic >= .18 ? 72 : avgRoic >= .10 ? 60 : 48;
  }

  const legacy = firstFinite(stock.valuation?.capitalAllocation?.score, stock.capitalAllocationScore);
  const evidenceCount = [avgRoic, dilution, debtTrend, positiveFcfRate, fcfConversion].filter(finite).length;
  const evidenceWeight = clamp(evidenceCount / 5, .45, 1);
  const raw = reinvestmentScore * .34 + shareholderYieldScore * .25 + debtDiscipline * .14 +
    cashConversionScore * .19 + payoutDiscipline * .08;
  const score = Math.round(clamp(raw * evidenceWeight + (finite(legacy) ? legacy : 50) * (1 - evidenceWeight), 0, 100));

  const flags = [];
  const signals = [];
  if (finite(dilution) && dilution > .035) flags.push('Persistent share dilution');
  if (finite(dilution) && dilution < -.015) signals.push('Meaningful net share repurchases');
  if (finite(roicTrend) && roicTrend < -.04) flags.push('ROIC has deteriorated');
  if (finite(roicTrend) && roicTrend > .025) signals.push('ROIC trend is improving');
  if (finite(debtTrend) && debtTrend > .75) flags.push('Debt increased materially');
  if (finite(debtTrend) && debtTrend < -.25) signals.push('Balance-sheet deleveraging');
  if (finite(positiveFcfRate) && positiveFcfRate >= .85) signals.push('Consistently positive free cash flow');

  return {
    version: 'capital-allocation-v3', score, evidenceCount,
    reinvestmentScore, shareholderYieldScore, buybackQuality: shareholderYieldScore,
    debtDiscipline, cashConversionScore, cashDiscipline: cashConversionScore,
    payoutDiscipline, avgRoic, incrementalRoic: roicTrend,
    annualDilution: dilution, debtTrend, positiveFcfRate, fcfConversion,
    flags, signals,
  };
}

module.exports = { computeCapitalAllocationV2 };
