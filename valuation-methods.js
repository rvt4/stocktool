/**
 * FreeScreener valuation engine v5
 *
 * Core design:
 *  1. Build one auditable five-year operating projection.
 *  2. Use analyst estimates for years 1-2 when available.
 *  3. Fade growth by business category, but do NOT force year-5 growth to terminal growth.
 *  4. Apply DCF, Revenue, EPS, and EV/EBITDA methods to the same projection.
 *  5. Weight methods by category and reliability instead of deleting methods merely
 *     because they disagree with DCF.
 */

const { getDiscountRate, solveImpliedGrowth } = require('./dcf');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function cagr(first, last, years) {
  if (first == null || last == null || first <= 0 || last <= 0 || years <= 0) return null;
  return Math.pow(last / first, 1 / years) - 1;
}
function weightedAverage(items) {
  const valid = items.filter(x => x.value != null && Number.isFinite(x.value) && x.weight > 0);
  const totalWeight = valid.reduce((s, x) => s + x.weight, 0);
  return totalWeight ? valid.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight : null;
}
function smoothedBase(yrs, getter) {
  const recent = yrs.slice(-3).map(getter).filter(x => x != null && Number.isFinite(x));
  if (!recent.length) return null;
  if (recent.length === 1) return recent[0];
  const weights = recent.length === 3 ? [0.2, 0.3, 0.5] : [0.4, 0.6];
  return recent.reduce((sum, value, i) => sum + value * weights[i], 0);
}

// ---------- Category used by the valuation engine ----------
// Kept local so the valuation pass does not depend on scoring-engine.js and create a cycle.
function inferValuationCategory(stock) {
  const yrs = stock.financials?.years || [];
  if (yrs.length < 3) return 'Value';
  const last = yrs[yrs.length - 1];
  const first = yrs[Math.max(0, yrs.length - 4)];
  const revCagr3y = cagr(first.revenue, last.revenue, Math.min(3, yrs.length - 1));
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(x => x != null));
  const dividendYield = stock.valuation?.dividendYield || 0;
  const margins = yrs.slice(-3).map(y => y.opMargin).filter(x => x != null);
  const marginInflecting = margins.length >= 2 && margins[margins.length - 1] > margins[0] + 0.01;
  const revenueHadDecline = yrs.slice(-4, -1).some((y, i, arr) => i > 0 && y.revenue < arr[i - 1].revenue);

  if (revenueHadDecline && marginInflecting) return 'Turnaround';
  if (avgRoic != null && avgRoic > 0.15 && revCagr3y != null && revCagr3y > 0.08) return 'Compounder';
  if (revCagr3y != null && revCagr3y > 0.15) return 'Growth';
  if (dividendYield > 0.02) return 'Dividend';
  return 'Value';
}

// ---------- Dilution ----------
function estimateDilutionRate(stock) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const marketCap = stock.valuation.marketCap;

  // Prefer actual historical diluted-share CAGR because it already reflects SBC AND buybacks.
  const shares = yrs.slice(-4).map(y => y.sharesOutTTM).filter(x => x != null && x > 0);
  const historical = shares.length >= 2 ? cagr(shares[0], shares[shares.length - 1], shares.length - 1) : null;
  const sbcImplied = last.sbc != null && marketCap ? last.sbc / marketCap : null;

  if (historical != null && sbcImplied != null) {
    return clamp(historical * 0.70 + sbcImplied * 0.30, -0.10, 0.12);
  }
  if (historical != null) return clamp(historical, -0.10, 0.12);
  if (sbcImplied != null) return clamp(sbcImplied, 0, 0.12);
  return 0.01;
}

// ---------- Analyst-aware growth path ----------
const CATEGORY_YEAR5_GROWTH = {
  Growth:      { floor: 0.10, retention: 0.50, cap: 0.20 },
  Compounder:  { floor: 0.08, retention: 0.55, cap: 0.18 },
  Turnaround:  { floor: 0.05, retention: 0.40, cap: 0.14 },
  Dividend:    { floor: 0.03, retention: 0.35, cap: 0.08 },
  Value:       { floor: 0.03, retention: 0.35, cap: 0.10 },
};

function historicalRevenueGrowth(stock) {
  const yrs = stock.financials.years;
  const rates = [];
  for (let i = 1; i < yrs.length; i++) {
    if (yrs[i - 1].revenue > 0 && yrs[i].revenue != null) rates.push(yrs[i].revenue / yrs[i - 1].revenue - 1);
  }
  return median(rates.slice(-5));
}

function buildGrowthPath(stock, category, years = 5) {
  const estimates = stock.analystEstimates || {};
  const fallback = stock.growthYear1 ?? historicalRevenueGrowth(stock) ?? 0.05;
  const year1 = clamp(estimates.revenueGrowthCurrentYear ?? estimates.revenueGrowthFwd ?? fallback, -0.25, 0.60);

  let year2 = estimates.revenueGrowthNextYear;
  if (year2 == null && estimates.revenueCurrentYear > 0 && estimates.revenueNextYear > 0) {
    year2 = estimates.revenueNextYear / estimates.revenueCurrentYear - 1;
  }
  if (year2 == null) year2 = year1 * (category === 'Growth' || category === 'Compounder' ? 0.90 : 0.80);
  year2 = clamp(year2, -0.20, 0.50);

  const cfg = CATEGORY_YEAR5_GROWTH[category] || CATEGORY_YEAR5_GROWTH.Value;
  const anchor = Math.max(year1, year2);
  const sustainableGrowth = (() => {
    const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
    const reinvestmentRate = stock.reinvestmentRate != null ? stock.reinvestmentRate : 0.45;
    return avgRoic != null ? clamp(avgRoic, 0, 0.35) * clamp(reinvestmentRate, 0, 1) : null;
  })();
  const categoryYear5 = clamp(anchor * cfg.retention, cfg.floor, cfg.cap);
  const year5 = sustainableGrowth != null
    ? clamp(categoryYear5 * 0.75 + sustainableGrowth * 0.25, cfg.floor, cfg.cap)
    : categoryYear5;

  const path = [year1, year2];
  for (let t = 3; t <= years; t++) {
    const progress = (t - 2) / Math.max(1, years - 2);
    // Smooth-step fade: retains more growth early and fades more near the end.
    const smooth = progress * progress * (3 - 2 * progress);
    path.push(year2 + (year5 - year2) * smooth);
  }

  return {
    path: path.slice(0, years),
    source: estimates.revenueGrowthCurrentYear != null || estimates.revenueGrowthFwd != null
      ? 'analyst_consensus_plus_category_fade'
      : 'sec_history_plus_category_fade',
    assumptions: { year1, year2, year5, sustainableGrowth, category },
  };
}

// ---------- One shared five-year financial projection ----------
function projectFinancials(stock, growthInput = null, years = 5) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const category = inferValuationCategory(stock);
  const growthModel = buildGrowthPath(stock, category, years);
  if (growthInput != null && stock.analystEstimates?.revenueGrowthCurrentYear == null && stock.analystEstimates?.revenueGrowthFwd == null) {
    growthModel.path[0] = clamp(growthInput, -0.25, 0.60);
  }

  const dilutionRate = estimateDilutionRate(stock);
  const estimates = stock.analystEstimates || {};

  const ebitdaMargins = yrs.slice(-4).map(y => y.ebitda != null && y.revenue ? y.ebitda / y.revenue : null).filter(x => x != null);
  const fcfMargins = yrs.slice(-4).map(y => y.fcf != null && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  const netMargins = yrs.slice(-4).map(y => y.netIncome != null && y.revenue ? y.netIncome / y.revenue : null).filter(x => x != null);

  const startEbitdaMargin = last.ebitda != null && last.revenue ? last.ebitda / last.revenue : median(ebitdaMargins) ?? 0.10;
  const startFcfMargin = last.fcf != null && last.revenue ? last.fcf / last.revenue : median(fcfMargins) ?? 0.08;
  const startNetMargin = last.netIncome != null && last.revenue ? last.netIncome / last.revenue : median(netMargins) ?? 0.06;

  const marginTrend = (arr, maxAnnual) => arr.length >= 2
    ? clamp((arr[arr.length - 1] - arr[0]) / (arr.length - 1), -maxAnnual, maxAnnual)
    : 0;

  const ebitdaTrend = marginTrend(ebitdaMargins, 0.025);
  const fcfTrend = marginTrend(fcfMargins, 0.025);
  const netTrend = marginTrend(netMargins, 0.025);

  let revenue = last.revenue;
  let shares = last.sharesOutTTM;
  const projection = [];

  for (let t = 1; t <= years; t++) {
    const growth = growthModel.path[t - 1];

    // Use analyst revenue dollars when available; otherwise compound the modeled path.
    if (t === 1 && estimates.revenueCurrentYear > 0) revenue = estimates.revenueCurrentYear;
    else if (t === 2 && estimates.revenueNextYear > 0) revenue = estimates.revenueNextYear;
    else revenue *= (1 + growth);

    shares *= (1 + dilutionRate);

    const ebitdaMargin = clamp(startEbitdaMargin + ebitdaTrend * t, -0.05, 0.60);
    const fcfMargin = clamp(startFcfMargin + fcfTrend * t, -0.10, 0.50);
    let netMargin = clamp(startNetMargin + netTrend * t, -0.20, 0.50);

    let eps = shares ? revenue * netMargin / shares : null;
    if (t === 1 && estimates.epsCurrentYear != null) {
      eps = estimates.epsCurrentYear;
      netMargin = revenue ? (eps * shares) / revenue : netMargin;
    } else if (t === 2 && estimates.epsNextYear != null) {
      eps = estimates.epsNextYear;
      netMargin = revenue ? (eps * shares) / revenue : netMargin;
    }

    const ebitda = revenue * ebitdaMargin;
    const fcf = revenue * fcfMargin;
    const netIncome = revenue * netMargin;

    projection.push({
      year: t,
      // Anchor forecast labels to the latest reported fiscal year, not the
      // current calendar year. This keeps a 2025 fiscal base labeled 2026-2030.
      calendarYear: Number(last.year) + t,
      growth,
      revenue,
      ebitdaMargin,
      ebitda,
      fcfMargin,
      fcf,
      netMargin,
      netIncome,
      eps,
      shares,
    });
  }

  return {
    projection,
    category,
    dilutionRate,
    growthModel,
    startingValues: {
      revenue: last.revenue,
      ebitda: last.ebitda,
      fcf: last.fcf,
      netIncome: last.netIncome,
      shares: last.sharesOutTTM,
      ebitdaMargin: startEbitdaMargin,
      fcfMargin: startFcfMargin,
      netMargin: startNetMargin,
    },
    marginAssumptions: { ebitdaTrend, fcfTrend, netTrend },
  };
}

// ---------- Sector multiples ----------
function computeSectorExitMultiples(stocks) {
  const bySector = {};
  for (const stock of stocks) {
    const sector = stock.sector || 'Unknown';
    const bucket = bySector[sector] ||= { pe: [], evRevenue: [], evEbitda: [] };
    const last = stock.financials.years[stock.financials.years.length - 1] || {};
    if (stock.valuation.pe > 0 && stock.valuation.pe < 120) bucket.pe.push(stock.valuation.pe);
    if (stock.valuation.ev && last.revenue > 0) {
      const x = stock.valuation.ev / last.revenue;
      if (x > 0 && x < 50) bucket.evRevenue.push(x);
    }
    if (stock.valuation.evEbitda > 0 && stock.valuation.evEbitda < 100) bucket.evEbitda.push(stock.valuation.evEbitda);
  }

  const out = {};
  for (const [sector, b] of Object.entries(bySector)) {
    out[sector] = {
      pe: median(b.pe),
      evRevenue: median(b.evRevenue),
      evEbitda: median(b.evEbitda),
      sampleSize: Math.max(b.pe.length, b.evRevenue.length, b.evEbitda.length),
    };
  }
  return out;
}

function qualityPremiumWeight(stock, exitGrowth) {
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
  const roicScore = clamp(((avgRoic ?? 0.08) - 0.08) / 0.22, 0, 1);
  const growthScore = clamp(((exitGrowth ?? 0.05) - 0.04) / 0.16, 0, 1);
  const pricingPowerScore = clamp((stock.pricingPowerScore ?? 50) / 100, 0, 1);
  return clamp(0.30 + (roicScore * 0.50 + growthScore * 0.35 + pricingPowerScore * 0.15) * 0.60, 0.30, 0.90);
}

function meanRevertedMultiple(currentMultiple, ownHistoricalMultiples, stockOrRoic, exitGrowth) {
  if (currentMultiple == null || currentMultiple <= 0) return { multiple: null, target: null, weight: null };
  const historicalMedian = ownHistoricalMultiples?.length ? median(ownHistoricalMultiples) : null;
  const stock = stockOrRoic && stockOrRoic.financials ? stockOrRoic : null;
  const weight = stock ? qualityPremiumWeight(stock, exitGrowth) : 0.55;
  const target = historicalMedian ?? currentMultiple;
  return { multiple: target + weight * (currentMultiple - target), target, weight };
}

// ---------- DCF on the same operating projection ----------
function dcfFromProjection(stock, model, { sbcAdjusted = false, terminalGrowth = 0.03 } = {}) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const discountRate = getDiscountRate(stock.sector);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const baseSbc = last.sbc || 0;
  const baseRevenue = last.revenue || 1;
  const sbcMargin = clamp(baseSbc / baseRevenue, 0, 0.30);

  let pvExplicitFCF = 0;
  const yearly = model.projection.map(row => {
    const rawFcf = row.fcf;
    const adjustedFcf = sbcAdjusted ? rawFcf - row.revenue * sbcMargin : rawFcf;
    const pv = adjustedFcf / Math.pow(1 + discountRate, row.year);
    pvExplicitFCF += pv;
    return { year: row.year, fcf: adjustedFcf, discountFactor: Math.pow(1 + discountRate, row.year), presentValue: pv };
  });

  const finalFcf = yearly[yearly.length - 1]?.fcf;
  if (!(finalFcf > 0) || !(last.sharesOutTTM > 0) || discountRate <= terminalGrowth) {
    return { fairValuePerShare: null, audit: { reason: 'non-positive terminal FCF or missing shares', yearly } };
  }

  const terminalValue = finalFcf * (1 + terminalGrowth) / (discountRate - terminalGrowth);
  const pvTerminalValue = terminalValue / Math.pow(1 + discountRate, model.projection.length);
  const enterpriseValue = pvExplicitFCF + pvTerminalValue;
  const equityValue = enterpriseValue - netDebt;
  // This is a present-value equity value, so divide by today's diluted share
  // count. Exit-period shares belong in future exit-price methods, not a DCF
  // fair value stated in today's dollars.
  const fairValuePerShare = equityValue / last.sharesOutTTM;

  return {
    fairValuePerShare: fairValuePerShare > 0 ? fairValuePerShare : null,
    audit: {
      method: sbcAdjusted ? 'DCF (SBC-adjusted)' : 'DCF (FCF)',
      discountRate,
      terminalGrowth,
      pvExplicitFCF,
      terminalValue,
      pvTerminalValue,
      terminalValueShareOfEnterpriseValue: enterpriseValue ? pvTerminalValue / enterpriseValue : null,
      enterpriseValue,
      netDebt,
      equityValue,
      currentDilutedShares: last.sharesOutTTM,
      projectedSharesAtExit: model.projection[model.projection.length - 1].shares,
      yearly,
    },
  };
}

function pvDividendStream(stock, years, discountRate) {
  const yieldNow = stock.valuation.dividendYield || 0;
  const price = stock.price.current;
  if (!yieldNow || !price) return 0;
  let pv = 0;
  let dividend = price * yieldNow;
  for (let t = 1; t <= years; t++) {
    dividend *= 1.03;
    pv += dividend / Math.pow(1 + discountRate, t);
  }
  return pv;
}

function exitMethod(stock, model, sectorMultiples, type) {
  const exit = model.projection[model.projection.length - 1];
  const last = stock.financials.years[stock.financials.years.length - 1];
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const exitGrowth = exit.growth;
  const discountRate = getDiscountRate(stock.sector);
  const years = model.projection.length;
  const dividends = pvDividendStream(stock, years, discountRate);

  let rawMultiple;
  let historical;
  let exitEnterpriseValue = null;
  let exitEquityValue = null;
  let exitPricePerShare = null;
  let metricValue = null;

  if (type === 'revenueExit') {
    rawMultiple = sectorMultiples?.evRevenue;
    historical = stock.historicalMultiples?.evRevenue;
    metricValue = exit.revenue;
  } else if (type === 'epsExit') {
    rawMultiple = sectorMultiples?.pe;
    historical = stock.historicalMultiples?.forwardPe;
    metricValue = exit.eps;
  } else {
    rawMultiple = sectorMultiples?.evEbitda;
    historical = stock.historicalMultiples?.evEbitda;
    metricValue = exit.ebitda;
  }

  if (!(rawMultiple > 0) || metricValue == null || (type === 'epsExit' && metricValue <= 0)) {
    return { fairValuePerShare: null, exitPricePerShare: null, audit: { reason: 'missing multiple or exit metric' } };
  }

  const reverted = meanRevertedMultiple(rawMultiple, historical, stock, exitGrowth);
  const exitMultiple = reverted.multiple;

  if (type === 'epsExit') {
    exitPricePerShare = metricValue * exitMultiple;
    exitEquityValue = exitPricePerShare * exit.shares;
  } else {
    exitEnterpriseValue = metricValue * exitMultiple;
    exitEquityValue = exitEnterpriseValue - netDebt;
    exitPricePerShare = exit.shares ? exitEquityValue / exit.shares : null;
  }

  const pvExitPrice = exitPricePerShare != null ? exitPricePerShare / Math.pow(1 + discountRate, years) : null;
  const fairValuePerShare = pvExitPrice != null ? pvExitPrice + dividends : null;

  return {
    fairValuePerShare: fairValuePerShare > 0 ? fairValuePerShare : null,
    exitPricePerShare: exitPricePerShare > 0 ? exitPricePerShare : null,
    audit: {
      type,
      years,
      exitMetric: metricValue,
      rawSectorMultiple: rawMultiple,
      historicalMedianMultiple: reverted.target,
      qualityPremiumRetained: reverted.weight,
      exitMultiple,
      exitEnterpriseValue,
      netDebt,
      exitEquityValue,
      sharesAtExit: exit.shares,
      exitPricePerShare,
      discountRate,
      pvExitPrice,
      pvDividends: dividends,
      fairValuePerShare,
    },
  };
}

// ---------- Category-aware method weights ----------
const CATEGORY_METHOD_WEIGHTS = {
  Growth:     { dcf: 0.16, dcfSBCAdjusted: 0.09, revenueExit: 0.30, epsExit: 0.30, ebitdaExit: 0.15 },
  Compounder: { dcf: 0.22, dcfSBCAdjusted: 0.13, revenueExit: 0.15, epsExit: 0.30, ebitdaExit: 0.20 },
  Value:      { dcf: 0.28, dcfSBCAdjusted: 0.17, revenueExit: 0.05, epsExit: 0.20, ebitdaExit: 0.30 },
  Dividend:   { dcf: 0.32, dcfSBCAdjusted: 0.13, revenueExit: 0.05, epsExit: 0.25, ebitdaExit: 0.25 },
  Turnaround: { dcf: 0.18, dcfSBCAdjusted: 0.07, revenueExit: 0.15, epsExit: 0.20, ebitdaExit: 0.40 },
};

function combineValuations(methods, category = 'Value') {
  const baseWeights = CATEGORY_METHOD_WEIGHTS[category] || CATEGORY_METHOD_WEIGHTS.Value;
  const available = Object.entries(methods).filter(([, value]) => value != null && value > 0 && Number.isFinite(value));
  if (!available.length) return { blendedFairValue: null, agreementScore: null, methodCount: 0, effectiveWeights: {}, reliabilityFlags: [] };

  const center = median(available.map(([, value]) => value));
  const reliabilityFlags = [];
  const weighted = available.map(([key, value]) => {
    const ratio = center > 0 ? Math.max(value / center, center / value) : 1;
    // Do not delete a method. Smoothly reduce its influence as it moves away from consensus.
    const reliability = ratio <= 1.5 ? 1 : ratio <= 2 ? 0.75 : ratio <= 3 ? 0.45 : 0.20;
    if (reliability < 1) reliabilityFlags.push({ method: key, value, consensusMedian: center, ratio, reliability });
    return { key, value, weight: (baseWeights[key] || 0) * reliability };
  });

  const blendedFairValue = weightedAverage(weighted);
  const effectiveWeightTotal = weighted.reduce((s, x) => s + x.weight, 0);
  const effectiveWeights = Object.fromEntries(weighted.map(x => [x.key, effectiveWeightTotal ? x.weight / effectiveWeightTotal : 0]));

  const values = available.map(([, value]) => value);
  const avg = mean(values);
  const stdev = values.length >= 2 ? Math.sqrt(mean(values.map(v => (v - avg) ** 2))) : 0;
  const cv = avg > 0 ? stdev / avg : 1;
  const agreementScore = Math.round(clamp(100 - cv * 120, 0, 100));

  return { blendedFairValue, agreementScore, methodCount: values.length, effectiveWeights, reliabilityFlags };
}

function fiveYearPriceTargetCAGR(stock, model, exitResults, effectiveWeights) {
  const currentPrice = stock.price.current;
  if (!(currentPrice > 0)) return { cagr: null, exitPrice: null, methodsUsed: 0 };

  const futureItems = Object.entries(exitResults)
    .filter(([, result]) => result?.exitPricePerShare > 0)
    .map(([key, result]) => ({ value: result.exitPricePerShare, weight: effectiveWeights[key] || 0 }));

  const exitPrice = weightedAverage(futureItems);
  if (!(exitPrice > 0)) return { cagr: null, exitPrice: null, methodsUsed: 0 };

  const years = model.projection.length;
  const dividendYield = stock.valuation.dividendYield || 0;
  const dividendsReceived = dividendYield * currentPrice * years;
  const totalFutureValue = exitPrice + dividendsReceived;
  const cagrValue = Math.pow(totalFutureValue / currentPrice, 1 / years) - 1;

  return {
    cagr: cagrValue,
    exitPrice,
    dividendsReceived,
    totalFutureValue,
    methodsUsed: futureItems.length,
    currentPrice,
    years,
  };
}

function valuateStock(stock, sectorExitMultiples) {
  const category = inferValuationCategory(stock);
  const sectorMultiples = sectorExitMultiples[stock.sector] || sectorExitMultiples.Unknown || {};
  const model = projectFinancials(stock, stock.growthYear1, 5);

  const dcf = dcfFromProjection(stock, model, { sbcAdjusted: false });
  const dcfSBCAdjusted = dcfFromProjection(stock, model, { sbcAdjusted: true });
  const revenueExit = exitMethod(stock, model, sectorMultiples, 'revenueExit');
  const epsExit = exitMethod(stock, model, sectorMultiples, 'epsExit');
  const ebitdaExit = exitMethod(stock, model, sectorMultiples, 'ebitdaExit');

  const methods = {
    dcf: dcf.fairValuePerShare,
    dcfSBCAdjusted: dcfSBCAdjusted.fairValuePerShare,
    revenueExit: revenueExit.fairValuePerShare,
    epsExit: epsExit.fairValuePerShare,
    ebitdaExit: ebitdaExit.fairValuePerShare,
  };

  const combined = combineValuations(methods, category);
  const exitResults = { revenueExit, epsExit, ebitdaExit };
  const fiveYearPriceTarget = fiveYearPriceTargetCAGR(stock, model, exitResults, combined.effectiveWeights);

  const currentPrice = stock.price.current;
  const marginOfSafety = combined.blendedFairValue && currentPrice
    ? (combined.blendedFairValue - currentPrice) / combined.blendedFairValue
    : null;

  let marketImpliedGrowth = null;
  let marketImpliedGrowthNote = null;
  const last = stock.financials.years[stock.financials.years.length - 1];
  if (last?.fcf > 0 && last?.sharesOutTTM > 0 && currentPrice > 0) {
    const implied = solveImpliedGrowth({
      fcfBase: last.fcf,
      terminalGrowth: 0.03,
      discountRate: getDiscountRate(stock.sector),
      years: 10,
      netDebt: (last.longTermDebt || 0) - (last.cash || 0),
      sharesOut: last.sharesOutTTM,
      targetPricePerShare: currentPrice,
    });
    marketImpliedGrowth = implied.impliedGrowth;
    marketImpliedGrowthNote = implied.reason !== 'converged' ? implied.reason : null;
  }

  return {
    category,
    methods,
    blendedFairValue: combined.blendedFairValue,
    agreementScore: combined.agreementScore,
    methodCount: combined.methodCount,
    effectiveWeights: combined.effectiveWeights,
    reliabilityFlags: combined.reliabilityFlags,
    outlierFlags: combined.reliabilityFlags, // backward-compatible frontend field; no method is excluded
    marginOfSafety,
    fiveYearPriceTarget,
    marketImpliedGrowth,
    marketImpliedGrowthNote,
    dilutionRate: model.dilutionRate,
    sbcIntensity: last?.sbcIntensity ?? null,
    projection: model.projection,
    projectionAssumptions: {
      category,
      growthModel: model.growthModel,
      startingValues: model.startingValues,
      marginAssumptions: model.marginAssumptions,
    },
    methodAudits: {
      dcf: dcf.audit,
      dcfSBCAdjusted: dcfSBCAdjusted.audit,
      revenueExit: revenueExit.audit,
      epsExit: epsExit.audit,
      ebitdaExit: ebitdaExit.audit,
    },
  };
}

const api = {
  computeSectorExitMultiples,
  valuateStock,
  projectFinancials,
  estimateDilutionRate,
  combineValuations,
  meanRevertedMultiple,
  qualityPremiumWeight,
  fiveYearPriceTargetCAGR,
  inferValuationCategory,
  buildGrowthPath,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ValuationMethods = api;
