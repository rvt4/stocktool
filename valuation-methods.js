/**
 * FreeScreener V7.0 core valuation engine
 *
 * V3.0 principles:
 *  - one shared five-year operating projection for every valuation method
 *  - analyst estimates anchor years 1-2 when available
 *  - category-aware growth fade and margin normalization
 *  - company-specific, risk-aware discount rates and terminal growth
 *  - exit multiples blend company, sector, quality, and growth persistence
 *  - no valuation method is deleted solely for disagreeing with DCF
 */

const {
  solveImpliedGrowth,
  getDynamicDiscountRate,
  getDynamicTerminalGrowth,
} = require('./dcf');
const { applyExitMultipleDiscipline } = require('./engine/exit-multiple-engine');
const { buildValuationConsensus } = require('./engine/valuation-consensus');
const { computeReturnEngineV2 } = require('./engine/return-engine-v2');
const { buildMarketExpectations } = require('./engine/market-expectations');
const { simulateReturns } = require('./engine/monte-carlo-engine');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function cagr(first, last, years) {
  if (!(first > 0) || !(last > 0) || !(years > 0)) return null;
  return Math.pow(last / first, 1 / years) - 1;
}
function weightedAverage(items) {
  const valid = items.filter(x => Number.isFinite(x.value) && x.value > 0 && x.weight > 0);
  const total = valid.reduce((s, x) => s + x.weight, 0);
  return total ? valid.reduce((s, x) => s + x.value * x.weight, 0) / total : null;
}
function historicalMedianGrowth(yrs) {
  const rates = [];
  for (let i = 1; i < yrs.length; i++) {
    if (yrs[i - 1].revenue > 0 && yrs[i].revenue > 0) rates.push(yrs[i].revenue / yrs[i - 1].revenue - 1);
  }
  return median(rates.slice(-5));
}

// ---------- V3 category inference ----------
function inferValuationCategory(stock) {
  const yrs = stock.financials?.years || [];
  if (yrs.length < 3) return 'Value';
  const last = yrs[yrs.length - 1];
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const histGrowth = historicalMedianGrowth(yrs);
  const analystGrowth = stock.analystEstimates?.revenueGrowthCurrentYear
    ?? stock.analystEstimates?.revenueGrowthFwd
    ?? stock.growthYear1
    ?? histGrowth
    ?? 0;
  const nextGrowth = stock.analystEstimates?.revenueGrowthNextYear ?? analystGrowth;
  const forwardGrowth = mean([analystGrowth, nextGrowth].filter(Number.isFinite)) ?? 0;
  const divYield = stock.valuation?.dividendYield || 0;

  const opMargins = yrs.slice(-4).map(y => y.opMargin).filter(Number.isFinite);
  const marginRecovery = opMargins.length >= 2 && opMargins[opMargins.length - 1] > opMargins[0] + 0.015;
  const recentRevenueDecline = yrs.slice(-4).some((y, i, a) => i > 0 && y.revenue < a[i - 1].revenue * 0.97);
  const earningsVolatile = yrs.slice(-4).filter(y => y.netIncome > 0).length <= 2;

  // A genuinely fast-growing business is not a turnaround merely because an old base year was weak.
  if (forwardGrowth >= 0.25) return 'Hyper Growth';
  if (forwardGrowth >= 0.15) return 'Growth';
  if (avgRoic != null && avgRoic >= 0.15 && forwardGrowth >= 0.08) return 'Compounder';
  if (recentRevenueDecline && marginRecovery && forwardGrowth < 0.12) return 'Turnaround';
  if (earningsVolatile && forwardGrowth < 0.08 && recentRevenueDecline) return 'Cyclical';
  if (divYield >= 0.025) return 'Dividend';
  return 'Value';
}

// ---------- Dilution ----------
function estimateDilutionRate(stock) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1] || {};
  const shares = yrs.slice(-4).map(y => y.sharesOutTTM).filter(x => x > 0);
  const historical = shares.length >= 2 ? cagr(shares[0], shares[shares.length - 1], shares.length - 1) : null;
  const sbcImplied = last.sbc != null && stock.valuation.marketCap > 0 ? last.sbc / stock.valuation.marketCap : null;
  if (historical != null && sbcImplied != null) return clamp(historical * 0.75 + sbcImplied * 0.25, -0.08, 0.10);
  if (historical != null) return clamp(historical, -0.08, 0.10);
  if (sbcImplied != null) return clamp(sbcImplied, 0, 0.10);
  return 0.01;
}

// ---------- Growth path (V4 business-model persistence) ----------
const GROWTH_CONFIG = {
  'Hyper Growth': { floor: 0.10, cap: 0.26, historyWeight: 0.25, sustainableWeight: 0.20, persistenceWeight: 0.30, analystWeight: 0.25 },
  Growth:         { floor: 0.07, cap: 0.18, historyWeight: 0.25, sustainableWeight: 0.20, persistenceWeight: 0.30, analystWeight: 0.25 },
  Compounder:     { floor: 0.055, cap: 0.14, historyWeight: 0.25, sustainableWeight: 0.25, persistenceWeight: 0.30, analystWeight: 0.20 },
  Turnaround:     { floor: 0.025, cap: 0.11, historyWeight: 0.20, sustainableWeight: 0.15, persistenceWeight: 0.20, analystWeight: 0.45 },
  Cyclical:       { floor: 0.015, cap: 0.08, historyWeight: 0.15, sustainableWeight: 0.15, persistenceWeight: 0.15, analystWeight: 0.55 },
  Dividend:       { floor: 0.018, cap: 0.07, historyWeight: 0.25, sustainableWeight: 0.25, persistenceWeight: 0.20, analystWeight: 0.30 },
  Value:          { floor: 0.018, cap: 0.09, historyWeight: 0.25, sustainableWeight: 0.20, persistenceWeight: 0.20, analystWeight: 0.35 },
};

function growthPersistenceScore(stock, category, year1, year2) {
  const yrs = stock.financials?.years || [];
  const recent = yrs.slice(-4);
  const avgRoic = mean(recent.map(y => y.roic).filter(Number.isFinite));
  const grossMargins = recent.map(y => y.grossMargin).filter(Number.isFinite);
  const grossMarginStability = grossMargins.length >= 2
    ? 1 - clamp((Math.max(...grossMargins) - Math.min(...grossMargins)) / 0.12, 0, 1)
    : 0.5;
  const fcfPositiveRate = recent.length ? recent.filter(y => y.fcf > 0).length / recent.length : 0.5;
  const pricing = clamp((stock.pricingPowerScore ?? stock.pricingPower?.score ?? 50) / 100, 0, 1);
  const analyst = analystReliability(stock);
  const capAlloc = clamp((capitalAllocationScore(stock).score ?? 50) / 100, 0, 1);
  const roicScore = avgRoic == null ? 0.5 : clamp((avgRoic - 0.05) / 0.25, 0, 1);
  const forwardConsistency = 1 - clamp(Math.abs(year1 - year2) / 0.50, 0, 1);
  const categoryBoost = category === 'Hyper Growth' ? 0.05 : category === 'Compounder' ? 0.04 : 0;
  return clamp(
    roicScore * 0.24 + grossMarginStability * 0.14 + fcfPositiveRate * 0.14 +
    pricing * 0.14 + analyst * 0.14 + capAlloc * 0.10 +
    forwardConsistency * 0.10 + categoryBoost,
    0, 1
  );
}

function buildGrowthPath(stock, category, years = 5) {
  const e = stock.analystEstimates || {};
  const histMedian = historicalMedianGrowth(stock.financials.years);
  const fallback = stock.growthYear1 ?? histMedian ?? 0.05;
  const year1 = clamp(e.revenueGrowthCurrentYear ?? e.revenueGrowthFwd ?? fallback, -0.25, 0.65);
  let year2 = e.revenueGrowthNextYear;
  if (year2 == null && e.revenueCurrentYear > 0 && e.revenueNextYear > 0) year2 = e.revenueNextYear / e.revenueCurrentYear - 1;
  if (year2 == null) year2 = year1 * (['Hyper Growth', 'Growth', 'Compounder'].includes(category) ? 0.88 : 0.75);
  year2 = clamp(year2, -0.20, 0.55);

  const cfg = GROWTH_CONFIG[category] || GROWTH_CONFIG.Value;
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const reinvest = clamp(stock.reinvestmentRate ?? 0.40, 0.10, 0.80);
  const sustainable = avgRoic != null ? clamp(avgRoic, 0, 0.35) * reinvest : null;
  const persistence = growthPersistenceScore(stock, category, year1, year2);

  const analystAnchor = clamp(Math.max(0, year2), cfg.floor, cfg.cap);
  const historyAnchor = clamp(Math.max(0, histMedian ?? year2), cfg.floor, cfg.cap);
  const sustainableAnchor = clamp(Math.max(0, sustainable ?? cfg.floor), cfg.floor, cfg.cap);
  const persistenceAnchor = cfg.floor + (cfg.cap - cfg.floor) * persistence;

  let year5 = analystAnchor * cfg.analystWeight + historyAnchor * cfg.historyWeight +
    sustainableAnchor * cfg.sustainableWeight + persistenceAnchor * cfg.persistenceWeight;
  const forwardAnchor = Math.max(0, mean([year1, year2]) ?? year1);
  const maxRetention = category === 'Hyper Growth' ? 0.58
    : category === 'Growth' ? 0.62
    : category === 'Compounder' ? 0.72
    : 0.85;
  year5 = clamp(year5, cfg.floor, Math.min(cfg.cap, Math.max(cfg.floor, forwardAnchor * maxRetention)));

  const path = [year1, year2];
  for (let t = 3; t <= years; t++) {
    const p = (t - 2) / Math.max(1, years - 2);
    const exponent = category === 'Hyper Growth' ? 1.55
      : category === 'Growth' ? 1.35
      : category === 'Compounder' ? 1.15
      : category === 'Turnaround' ? 0.90
      : 1.0;
    const eased = Math.pow(p, exponent);
    path.push(year2 + (year5 - year2) * eased);
  }

  return {
    path: path.slice(0, years),
    source: e.revenueGrowthCurrentYear != null || e.revenueGrowthFwd != null
      ? 'analyst_consensus_plus_v3_7_persistence_fade'
      : 'sec_history_plus_v3_7_persistence_fade',
    assumptions: {
      year1, year2, year5, sustainableGrowth: sustainable,
      historicalMedianGrowth: histMedian, persistenceScore: persistence,
      analystAnchor, historyAnchor, sustainableAnchor, persistenceAnchor, category,
    },
  };
}

// ---------- Margin targets ----------
function marginSeries(yrs, getter) {
  return yrs.slice(-5).map(getter).filter(Number.isFinite);
}
function marginTarget(start, series, category, kind) {
  const med = median(series) ?? start;
  const best = series.length ? Math.max(...series) : start;
  const recentTrend = series.length >= 3 ? (series[series.length - 1] - series[0]) / (series.length - 1) : 0;
  const recoveryAllowance = category === 'Turnaround' ? 0.035
    : ['Hyper Growth', 'Growth'].includes(category) ? 0.030
    : category === 'Compounder' ? 0.020
    : 0.012;
  const trendContribution = clamp(recentTrend * 2.0, -0.03, recoveryAllowance);
  const normalizedAnchor = med * 0.60 + best * 0.40;
  let target = Math.max(start + trendContribution, normalizedAnchor);

  const caps = kind === 'fcf'
    ? { low: -0.10, high: 0.42 }
    : kind === 'net'
      ? { low: -0.20, high: 0.45 }
      : { low: -0.05, high: 0.55 };
  // Mature/value companies should not receive five straight years of unchecked margin expansion.
  if (['Value', 'Dividend', 'Cyclical'].includes(category)) target = Math.min(target, start + 0.018);
  return clamp(target, caps.low, caps.high);
}

// ---------- Shared five-year projection ----------
function projectFinancials(stock, growthInput = null, years = 5) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const category = inferValuationCategory(stock);
  const growthModel = buildGrowthPath(stock, category, years);
  if (growthInput != null && stock.analystEstimates?.revenueGrowthCurrentYear == null && stock.analystEstimates?.revenueGrowthFwd == null) {
    growthModel.path[0] = clamp(growthInput, -0.25, 0.65);
  }

  const estimates = stock.analystEstimates || {};
  const dilutionRate = estimateDilutionRate(stock);
  const ebitdaMargins = marginSeries(yrs, y => y.ebitda != null && y.revenue ? y.ebitda / y.revenue : null);
  const fcfMargins = marginSeries(yrs, y => y.fcf != null && y.revenue ? y.fcf / y.revenue : null);
  const netMargins = marginSeries(yrs, y => y.netIncome != null && y.revenue ? y.netIncome / y.revenue : null);

  const startEbitdaMargin = last.ebitda != null && last.revenue ? last.ebitda / last.revenue : median(ebitdaMargins) ?? 0.10;
  const startFcfMargin = last.fcf != null && last.revenue ? last.fcf / last.revenue : median(fcfMargins) ?? 0.08;
  const startNetMargin = last.netIncome != null && last.revenue ? last.netIncome / last.revenue : median(netMargins) ?? 0.06;
  const targetEbitdaMargin = marginTarget(startEbitdaMargin, ebitdaMargins, category, 'ebitda');
  const targetFcfMargin = marginTarget(startFcfMargin, fcfMargins, category, 'fcf');
  const targetNetMargin = marginTarget(startNetMargin, netMargins, category, 'net');

  let revenue = last.revenue;
  let shares = last.sharesOutTTM;
  const projection = [];
  for (let t = 1; t <= years; t++) {
    const growth = growthModel.path[t - 1];
    if (t === 1 && estimates.revenueCurrentYear > 0) revenue = estimates.revenueCurrentYear;
    else if (t === 2 && estimates.revenueNextYear > 0) revenue = estimates.revenueNextYear;
    else revenue *= 1 + growth;
    shares *= 1 + dilutionRate;

    const p = t / years;
    const smooth = p * p * (3 - 2 * p);
    const ebitdaMargin = startEbitdaMargin + (targetEbitdaMargin - startEbitdaMargin) * smooth;
    const fcfMargin = startFcfMargin + (targetFcfMargin - startFcfMargin) * smooth;
    let netMargin = startNetMargin + (targetNetMargin - startNetMargin) * smooth;
    let eps = shares ? revenue * netMargin / shares : null;

    if (t === 1 && estimates.epsCurrentYear != null) {
      eps = estimates.epsCurrentYear;
      netMargin = revenue && shares ? eps * shares / revenue : netMargin;
    } else if (t === 2 && estimates.epsNextYear != null) {
      eps = estimates.epsNextYear;
      netMargin = revenue && shares ? eps * shares / revenue : netMargin;
    }

    projection.push({
      year: t,
      calendarYear: Number(last.year) + t,
      growth,
      revenue,
      ebitdaMargin,
      ebitda: revenue * ebitdaMargin,
      fcfMargin,
      fcf: revenue * fcfMargin,
      netMargin,
      netIncome: revenue * netMargin,
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
      revenue: last.revenue, ebitda: last.ebitda, fcf: last.fcf, netIncome: last.netIncome,
      shares: last.sharesOutTTM, ebitdaMargin: startEbitdaMargin, fcfMargin: startFcfMargin, netMargin: startNetMargin,
    },
    marginAssumptions: {
      startEbitdaMargin, targetEbitdaMargin,
      startFcfMargin, targetFcfMargin,
      startNetMargin, targetNetMargin,
    },
  };
}


// ---------- V4 business model profiles ----------
const BUSINESS_MODELS = {
  'Hyper Growth': { engine: 'operating-growth', abnormalYears: 7, premiumFloor: 0.42, premiumCeiling: 0.78, moatBase: 0.48 },
  Growth:         { engine: 'growth-quality', abnormalYears: 6, premiumFloor: 0.34, premiumCeiling: 0.70, moatBase: 0.52 },
  Compounder:     { engine: 'durable-compounder', abnormalYears: 8, premiumFloor: 0.40, premiumCeiling: 0.76, moatBase: 0.62 },
  Value:          { engine: 'normalized-earnings', abnormalYears: 4, premiumFloor: 0.12, premiumCeiling: 0.42, moatBase: 0.35 },
  Dividend:       { engine: 'cash-yield', abnormalYears: 5, premiumFloor: 0.16, premiumCeiling: 0.46, moatBase: 0.44 },
  Turnaround:     { engine: 'recovery', abnormalYears: 4, premiumFloor: 0.10, premiumCeiling: 0.38, moatBase: 0.28 },
  Cyclical:       { engine: 'mid-cycle', abnormalYears: 3, premiumFloor: 0.08, premiumCeiling: 0.30, moatBase: 0.24 },
};

function buildBusinessProfile(stock, category, model = null) {
  const cfg = BUSINESS_MODELS[category] || BUSINESS_MODELS.Value;
  const yrs = stock.financials?.years || [];
  const recent = yrs.slice(-5);
  const last = recent.at(-1) || {};
  const avgRoic = mean(recent.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const gross = recent.map(y => y.grossMargin).filter(Number.isFinite);
  const fcfMargins = recent.map(y => y.revenue > 0 && Number.isFinite(y.fcf) ? y.fcf / y.revenue : null).filter(Number.isFinite);
  const opMargins = recent.map(y => y.opMargin).filter(Number.isFinite);
  const roicQuality = avgRoic == null ? 0.45 : clamp((avgRoic - 0.04) / 0.28, 0, 1);
  const marginDurability = gross.length >= 2 ? clamp(1 - (Math.max(...gross) - Math.min(...gross)) / 0.16, 0, 1) : 0.50;
  const cashQuality = clamp(((median(fcfMargins) ?? 0.04) - 0.01) / 0.24, 0, 1);
  const earningsStability = opMargins.length >= 2 ? clamp(1 - (Math.max(...opMargins) - Math.min(...opMargins)) / 0.18, 0, 1) : 0.45;
  const pricing = clamp((stock.pricingPowerScore ?? 50) / 100, 0, 1);
  const capital = clamp(capitalAllocationScore(stock).score / 100, 0, 1);
  const analyst = analystReliability(stock);
  const growthPersistence = model?.growthModel?.assumptions?.persistenceScore ?? 0.5;
  const balanceSheet = last.ebitda > 0
    ? clamp(1 - Math.max(0, (last.longTermDebt || 0) - (last.cash || 0)) / (last.ebitda * 5), 0, 1)
    : 0.45;
  const moatScore = clamp(
    cfg.moatBase * 0.18 + roicQuality * 0.22 + marginDurability * 0.14 +
    cashQuality * 0.12 + earningsStability * 0.10 + pricing * 0.12 +
    capital * 0.07 + balanceSheet * 0.05, 0, 1
  );
  const premiumPersistence = clamp(
    cfg.premiumFloor + (cfg.premiumCeiling - cfg.premiumFloor) *
    (moatScore * 0.48 + growthPersistence * 0.27 + analyst * 0.15 + capital * 0.10),
    cfg.premiumFloor, cfg.premiumCeiling
  );
  const forecastReliability = clamp(analyst * 0.35 + earningsStability * 0.20 + marginDurability * 0.15 + cashQuality * 0.15 + balanceSheet * 0.15, 0, 1);
  return {
    category, engine: cfg.engine, abnormalGrowthYears: cfg.abnormalYears,
    moatScore, premiumPersistence, forecastReliability,
    components: { roicQuality, marginDurability, cashQuality, earningsStability, pricing, capitalAllocation: capital, analystReliability: analyst, growthPersistence, balanceSheet },
  };
}

// ---------- Sector statistics ----------
function computeSectorExitMultiples(stocks) {
  const bySector = {};
  for (const stock of stocks) {
    const sector = stock.sector || 'Unknown';
    const b = bySector[sector] ||= { pe: [], evRevenue: [], evEbitda: [] };
    const last = stock.financials.years.at(-1) || {};
    if (stock.valuation.pe > 0 && stock.valuation.pe < 120) b.pe.push(stock.valuation.pe);
    if (stock.valuation.ev > 0 && last.revenue > 0) {
      const x = stock.valuation.ev / last.revenue;
      if (x > 0 && x < 40) b.evRevenue.push(x);
    }
    if (stock.valuation.evEbitda > 0 && stock.valuation.evEbitda < 80) b.evEbitda.push(stock.valuation.evEbitda);
  }
  const out = {};
  for (const [sector, b] of Object.entries(bySector)) {
    out[sector] = {
      pe: median(b.pe), evRevenue: median(b.evRevenue), evEbitda: median(b.evEbitda),
      sampleSize: Math.max(b.pe.length, b.evRevenue.length, b.evEbitda.length),
    };
  }
  return out;
}

function qualityScore01(stock, exitGrowth) {
  const yrs = stock.financials.years;
  const last = yrs.at(-1) || {};
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const roic = clamp(((avgRoic ?? 0.08) - 0.06) / 0.24, 0, 1);
  const growth = clamp(((exitGrowth ?? 0.04) - 0.02) / 0.18, 0, 1);
  const pricing = clamp((stock.pricingPowerScore ?? 50) / 100, 0, 1);
  const fcfMargins = yrs.slice(-3).map(y => y.fcf != null && y.revenue ? y.fcf / y.revenue : null).filter(Number.isFinite);
  const conversion = clamp(((median(fcfMargins) ?? 0.05) - 0.02) / 0.23, 0, 1);
  const grossMargins = yrs.slice(-4).map(y => y.grossMargin).filter(Number.isFinite);
  const marginDurability = grossMargins.length >= 2
    ? clamp(1 - (Math.max(...grossMargins) - Math.min(...grossMargins)) / 0.18, 0, 1)
    : 0.50;
  const capitalAllocation = clamp((capitalAllocationScore(stock).score || 50) / 100, 0, 1);
  const balanceSheet = last.ebitda > 0
    ? clamp(1 - Math.max(0, (last.longTermDebt || 0) - (last.cash || 0)) / (last.ebitda * 5), 0, 1)
    : 0.45;
  return clamp(
    roic * 0.27 + growth * 0.22 + pricing * 0.14 + conversion * 0.13 +
    marginDurability * 0.09 + capitalAllocation * 0.09 + balanceSheet * 0.06,
    0, 1
  );
}
function qualityPremiumWeight(stock, exitGrowth) {
  // Retain only part of today's company-specific premium. This is deliberately lower
  // than V3.5 so a temporarily euphoric current multiple cannot dominate the terminal value.
  return clamp(0.18 + qualityScore01(stock, exitGrowth) * 0.42, 0.18, 0.60);
}

function companyCurrentMultiple(stock, type) {
  const last = stock.financials.years.at(-1) || {};
  if (type === 'epsExit') return stock.valuation.forwardPe ?? stock.valuation.pe ?? null;
  if (type === 'ebitdaExit') return stock.valuation.evEbitda ?? null;
  if (type === 'revenueExit' && stock.valuation.ev > 0 && last.revenue > 0) return stock.valuation.ev / last.revenue;
  return null;
}

function intelligentExitMultiple(stock, type, sectorMultiple, exitGrowth, businessProfile = null) {
  if (!(sectorMultiple > 0)) return { multiple: null };
  const current = companyCurrentMultiple(stock, type);
  const category = inferValuationCategory(stock);
  const profile = businessProfile || buildBusinessProfile(stock, category);
  const quality = qualityScore01(stock, exitGrowth);
  const growthScore = clamp(((exitGrowth ?? 0.04) - 0.02) / 0.20, 0, 1);

  // V4 separates operating maturity from valuation-premium persistence. Durable
  // compounders can mature operationally without automatically reverting to an average multiple.
  const durablePremiumPct = clamp(
    (profile.moatScore - 0.45) * 1.05 + (growthScore - 0.35) * (type === 'revenueExit' ? 0.62 : 0.46),
    -0.38, category === 'Hyper Growth' ? 1.30 : category === 'Growth' ? 1.00 : category === 'Compounder' ? 0.90 : 0.55
  );
  const qualityAdjustedSector = sectorMultiple * (1 + durablePremiumPct);
  const currentCap = category === 'Hyper Growth' ? 3.0 : category === 'Growth' ? 2.45 : category === 'Compounder' ? 2.25 : category === 'Dividend' ? 1.65 : 1.55;
  const boundedCurrent = current > 0 ? clamp(current, sectorMultiple * 0.45, sectorMultiple * currentCap) : null;
  let retain = profile.premiumPersistence;
  if (type === 'revenueExit' && category === 'Compounder') retain *= 0.90;
  if (['Value', 'Dividend', 'Turnaround', 'Cyclical'].includes(category)) retain *= 0.72;
  retain = clamp(retain, 0.08, 0.80);
  const multiple = boundedCurrent != null
    ? qualityAdjustedSector * (1 - retain) + boundedCurrent * retain
    : qualityAdjustedSector;
  const maxVsSector = category === 'Hyper Growth' ? 2.80 : category === 'Growth' ? 2.35 : category === 'Compounder' ? 2.15 : category === 'Dividend' ? 1.60 : 1.50;
  const preDisciplineMultiple = clamp(multiple, sectorMultiple * 0.45, sectorMultiple * maxVsSector);
  const disciplined = applyExitMultipleDiscipline({
    type, rawMultiple: preDisciplineMultiple, exitGrowth,
    quality, forecastReliability: profile.forecastReliability,
    industry: stock.valuation?.industryModel?.model || null,
  });
  return {
    multiple: disciplined.multiple,
    rawMultipleBeforeGrowthCeiling: preDisciplineMultiple,
    growthBasedCeiling: disciplined.ceiling,
    multipleWasCapped: disciplined.wasCapped,
    sectorMultiple, companyCurrentMultiple: current, boundedCompanyMultiple: boundedCurrent,
    qualityAdjustedSector, qualityPremiumRetained: retain, premiumPersistence: profile.premiumPersistence,
    moatScore: profile.moatScore, forecastReliability: profile.forecastReliability,
    qualityScore: quality, durablePremiumPct, growthPremiumScore: growthScore, valuationEngine: profile.engine,
  };
}

// Backward-compatible export name.
function meanRevertedMultiple(currentMultiple, ownHistoricalMultiples, stockOrRoic, exitGrowth) {
  const stock = stockOrRoic?.financials ? stockOrRoic : null;
  if (!stock) return { multiple: currentMultiple, target: currentMultiple, weight: 0.5 };
  const result = intelligentExitMultiple(stock, 'epsExit', currentMultiple, exitGrowth);
  return { multiple: result.multiple, target: result.qualityAdjustedSector, weight: result.qualityPremiumRetained };
}

// ---------- V3.5 reliability + capital allocation ----------
function analystReliability(stock) {
  const e = stock.analystEstimates || {};
  const n = Number(e.numAnalysts || 0);
  const meanTarget = e.analystTargetMean;
  const low = e.analystTargetLow;
  const high = e.analystTargetHigh;
  const coverage = clamp(n / 25, 0.25, 1);
  const dispersion = meanTarget > 0 && low > 0 && high > 0
    ? clamp((high - low) / meanTarget, 0, 2) : 0.55;
  const dispersionScore = clamp(1 - dispersion / 1.25, 0.20, 1);
  const twoYear = e.revenueGrowthCurrentYear != null && e.revenueGrowthNextYear != null ? 1 : 0.72;
  return clamp(coverage * 0.45 + dispersionScore * 0.35 + twoYear * 0.20, 0.25, 1);
}

function capitalAllocationScore(stock) {
  const yrs = stock.financials?.years || [];
  if (yrs.length < 2) return { score: 50, signals: ['Limited capital-allocation history'] };
  const last = yrs.at(-1) || {};
  const prev = yrs.at(-2) || {};
  const signals = [];
  let score = 50;
  const shares = yrs.slice(-4).map(y => y.sharesOutTTM).filter(x => x > 0);
  const dilution = shares.length >= 2 ? cagr(shares[0], shares.at(-1), shares.length - 1) : null;
  if (dilution != null && dilution <= -0.01) { score += 15; signals.push('Net share count declining'); }
  else if (dilution != null && dilution >= 0.03) { score -= 18; signals.push('Meaningful shareholder dilution'); }
  const debtChange = prev.longTermDebt > 0 ? (last.longTermDebt - prev.longTermDebt) / prev.longTermDebt : null;
  if (debtChange != null && debtChange <= -0.10) { score += 10; signals.push('Debt declining'); }
  else if (debtChange != null && debtChange >= 0.25) { score -= 10; signals.push('Debt rising quickly'); }
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(Number.isFinite));
  if (avgRoic != null && avgRoic >= 0.20) { score += 15; signals.push('High returns on invested capital'); }
  else if (avgRoic != null && avgRoic < 0.06) { score -= 12; signals.push('Low returns on invested capital'); }
  const payout = stock.valuation?.dividendYield || 0;
  if (payout > 0.02 && last.fcf > 0) { score += 5; signals.push('Dividend supported by free cash flow'); }
  const sbcIntensity = last.sbc != null && last.revenue > 0 ? last.sbc / last.revenue : 0;
  if (sbcIntensity > 0.12) { score -= 12; signals.push('Heavy stock-based compensation'); }
  return { score: Math.round(clamp(score, 0, 100)), signals };
}

function ownerEarningsFromProjection(stock, model) {
  const last = stock.financials.years.at(-1) || {};
  const discountRate = getDynamicDiscountRate(stock, model.category);
  const terminalGrowth = getDynamicTerminalGrowth(stock, model.category);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const daMargin = last.da != null && last.revenue > 0 ? clamp(last.da / last.revenue, 0, 0.25)
    : last.ebitda != null && last.operatingIncome != null && last.revenue > 0
      ? clamp((last.ebitda - last.operatingIncome) / last.revenue, 0, 0.25) : 0.04;
  const capexMargin = last.capex != null && last.revenue > 0 ? clamp(last.capex / last.revenue, 0, 0.30) : daMargin;
  const maintenanceCapexMargin = Math.min(capexMargin, daMargin * 1.10);
  const sbcMargin = last.sbc != null && last.revenue > 0 ? clamp(last.sbc / last.revenue, 0, 0.25) : 0;
  let pvExplicit = 0;
  const yearly = model.projection.map(row => {
    const ownerEarnings = row.netIncome + row.revenue * daMargin - row.revenue * maintenanceCapexMargin - row.revenue * sbcMargin;
    const presentValue = ownerEarnings / Math.pow(1 + discountRate, row.year);
    pvExplicit += presentValue;
    return { year: row.year, ownerEarnings, presentValue };
  });
  const finalOE = yearly.at(-1)?.ownerEarnings;
  if (!(finalOE > 0) || !(last.sharesOutTTM > 0) || discountRate <= terminalGrowth) {
    return { fairValuePerShare: null, audit: { reason: 'non-positive owner earnings', yearly, discountRate, terminalGrowth } };
  }
  const terminalValue = finalOE * (1 + terminalGrowth) / (discountRate - terminalGrowth);
  const pvTerminalValue = terminalValue / Math.pow(1 + discountRate, model.projection.length);
  const enterpriseValue = pvExplicit + pvTerminalValue;
  const equityValue = enterpriseValue - netDebt;
  return { fairValuePerShare: equityValue > 0 ? equityValue / last.sharesOutTTM : null, audit: {
    method: 'Owner Earnings DCF', discountRate, terminalGrowth, daMargin, maintenanceCapexMargin, sbcMargin,
    pvExplicitOwnerEarnings: pvExplicit, terminalValue, pvTerminalValue,
    terminalValueShareOfEnterpriseValue: enterpriseValue ? pvTerminalValue / enterpriseValue : null,
    enterpriseValue, netDebt, equityValue, currentDilutedShares: last.sharesOutTTM, yearly,
  }};
}

// ---------- DCF ----------
function dcfFromProjection(stock, model, { sbcAdjusted = false } = {}) {
  const last = stock.financials.years.at(-1) || {};
  const discountRate = getDynamicDiscountRate(stock, model.category);
  const terminalGrowth = getDynamicTerminalGrowth(stock, model.category);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const sbcMargin = last.sbc != null && last.revenue > 0 ? clamp(last.sbc / last.revenue, 0, 0.25) : 0;
  let pvExplicitFCF = 0;
  const yearly = model.projection.map(row => {
    const fcf = sbcAdjusted ? row.fcf - row.revenue * sbcMargin : row.fcf;
    const presentValue = fcf / Math.pow(1 + discountRate, row.year);
    pvExplicitFCF += presentValue;
    return { year: row.year, fcf, discountFactor: Math.pow(1 + discountRate, row.year), presentValue };
  });
  const finalFcf = yearly.at(-1)?.fcf;
  if (!(finalFcf > 0) || !(last.sharesOutTTM > 0) || discountRate <= terminalGrowth) {
    return { fairValuePerShare: null, audit: { reason: 'non-positive terminal FCF or missing shares', yearly, discountRate, terminalGrowth } };
  }
  const terminalValue = finalFcf * (1 + terminalGrowth) / (discountRate - terminalGrowth);
  const pvTerminalValue = terminalValue / Math.pow(1 + discountRate, model.projection.length);
  const enterpriseValue = pvExplicitFCF + pvTerminalValue;
  const equityValue = enterpriseValue - netDebt;
  // Present equity value is divided by current diluted shares. Exit share count is already reflected in projected per-share exit methods.
  const fairValuePerShare = equityValue / last.sharesOutTTM;
  return {
    fairValuePerShare: fairValuePerShare > 0 ? fairValuePerShare : null,
    audit: {
      method: sbcAdjusted ? 'DCF (SBC-adjusted)' : 'DCF (FCF)', discountRate, terminalGrowth,
      pvExplicitFCF, terminalValue, pvTerminalValue,
      terminalValueShareOfEnterpriseValue: enterpriseValue ? pvTerminalValue / enterpriseValue : null,
      enterpriseValue, netDebt, equityValue,
      currentDilutedShares: last.sharesOutTTM,
      sharesAtExit: model.projection.at(-1).shares,
      yearly,
    },
  };
}

function pvDividendStream(stock, years, discountRate) {
  const yieldNow = stock.valuation.dividendYield || 0;
  const price = stock.price.current;
  if (!(yieldNow > 0) || !(price > 0)) return 0;
  let dividend = price * yieldNow;
  let pv = 0;
  for (let t = 1; t <= years; t++) {
    dividend *= 1.03;
    pv += dividend / Math.pow(1 + discountRate, t);
  }
  return pv;
}

function exitMethod(stock, model, sectorMultiples, type, businessProfile = null) {
  const exit = model.projection.at(-1);
  const last = stock.financials.years.at(-1) || {};
  const discountRate = getDynamicDiscountRate(stock, model.category);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const years = model.projection.length;
  let sectorMultiple, metricValue;
  if (type === 'revenueExit') { sectorMultiple = sectorMultiples?.evRevenue; metricValue = exit.revenue; }
  else if (type === 'epsExit') { sectorMultiple = sectorMultiples?.pe; metricValue = exit.eps; }
  else { sectorMultiple = sectorMultiples?.evEbitda; metricValue = exit.ebitda; }
  if (!(sectorMultiple > 0) || !Number.isFinite(metricValue) || (type === 'epsExit' && metricValue <= 0)) {
    return { fairValuePerShare: null, exitPricePerShare: null, audit: { reason: 'missing multiple or exit metric' } };
  }
  const multipleModel = intelligentExitMultiple(stock, type, sectorMultiple, exit.growth, businessProfile);
  const exitMultiple = multipleModel.multiple;
  let exitEnterpriseValue = null, exitEquityValue = null, exitPricePerShare = null;
  if (type === 'epsExit') {
    exitPricePerShare = metricValue * exitMultiple;
    exitEquityValue = exitPricePerShare * exit.shares;
  } else {
    exitEnterpriseValue = metricValue * exitMultiple;
    exitEquityValue = exitEnterpriseValue - netDebt;
    exitPricePerShare = exit.shares ? exitEquityValue / exit.shares : null;
  }
  const pvExitPrice = exitPricePerShare > 0 ? exitPricePerShare / Math.pow(1 + discountRate, years) : null;
  const pvDividends = pvDividendStream(stock, years, discountRate);
  const fairValuePerShare = pvExitPrice != null ? pvExitPrice + pvDividends : null;
  return {
    fairValuePerShare: fairValuePerShare > 0 ? fairValuePerShare : null,
    exitPricePerShare: exitPricePerShare > 0 ? exitPricePerShare : null,
    audit: {
      type, years, exitMetric: metricValue, exitMultiple, ...multipleModel,
      exitEnterpriseValue, netDebt, exitEquityValue, sharesAtExit: exit.shares,
      exitPricePerShare, discountRate, pvExitPrice, pvDividends, fairValuePerShare,
    },
  };
}

const CATEGORY_METHOD_WEIGHTS = {
  'Hyper Growth': { dcf: 0.13, dcfSBCAdjusted: 0.08, ownerEarnings: 0.08, revenueExit: 0.24, epsExit: 0.27, ebitdaExit: 0.20 },
  Growth:         { dcf: 0.19, dcfSBCAdjusted: 0.09, ownerEarnings: 0.10, revenueExit: 0.17, epsExit: 0.25, ebitdaExit: 0.20 },
  Compounder:     { dcf: 0.27, dcfSBCAdjusted: 0.10, ownerEarnings: 0.15, revenueExit: 0.07, epsExit: 0.21, ebitdaExit: 0.20 },
  Value:          { dcf: 0.31, dcfSBCAdjusted: 0.10, ownerEarnings: 0.15, revenueExit: 0.02, epsExit: 0.18, ebitdaExit: 0.24 },
  Dividend:       { dcf: 0.35, dcfSBCAdjusted: 0.09, ownerEarnings: 0.16, revenueExit: 0.01, epsExit: 0.17, ebitdaExit: 0.22 },
  Turnaround:     { dcf: 0.22, dcfSBCAdjusted: 0.07, ownerEarnings: 0.10, revenueExit: 0.05, epsExit: 0.18, ebitdaExit: 0.38 },
  Cyclical:       { dcf: 0.22, dcfSBCAdjusted: 0.07, ownerEarnings: 0.10, revenueExit: 0.03, epsExit: 0.15, ebitdaExit: 0.43 },
};

const INDUSTRY_METHOD_OVERRIDES = {
  // Cash generation is the primary anchor for capital-intensive/cyclical chip names.
  // Revenue multiples remain corroborative, not decisive.
  'semiconductors-hardware': { dcf: 0.34, dcfSBCAdjusted: 0.11, ownerEarnings: 0.16, revenueExit: 0.05, epsExit: 0.16, ebitdaExit: 0.18 },
  software:                  { dcf: 0.22, dcfSBCAdjusted: 0.12, ownerEarnings: 0.09, revenueExit: 0.23, epsExit: 0.18, ebitdaExit: 0.16 },
  financials:                { dcf: 0.28, dcfSBCAdjusted: 0.05, ownerEarnings: 0.22, revenueExit: 0.02, epsExit: 0.28, ebitdaExit: 0.15 },
  utilities:                 { dcf: 0.38, dcfSBCAdjusted: 0.06, ownerEarnings: 0.18, revenueExit: 0.01, epsExit: 0.17, ebitdaExit: 0.20 },
  energy:                    { dcf: 0.25, dcfSBCAdjusted: 0.06, ownerEarnings: 0.14, revenueExit: 0.02, epsExit: 0.13, ebitdaExit: 0.40 },
  reit:                      { dcf: 0.24, dcfSBCAdjusted: 0.04, ownerEarnings: 0.18, revenueExit: 0.03, epsExit: 0.11, ebitdaExit: 0.40 },
};

function normalizedWeights(weights) {
  const total = Object.values(weights).reduce((a, b) => a + Math.max(0, b || 0), 0);
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, total ? Math.max(0, v || 0) / total : 0]));
}

function businessSpecificWeights(category, profile, industryModel = null) {
  const modelName = industryModel?.model || null;
  const starting = INDUSTRY_METHOD_OVERRIDES[modelName] || CATEGORY_METHOD_WEIGHTS[category] || CATEGORY_METHOD_WEIGHTS.Value;
  const base = { ...starting };
  const moat = profile?.moatScore ?? 0.5;
  const reliability = profile?.forecastReliability ?? 0.5;

  if (!INDUSTRY_METHOD_OVERRIDES[modelName]) {
    if (category === 'Hyper Growth') {
      base.revenueExit += 0.025 * reliability; base.epsExit += 0.02 * reliability;
    } else if (category === 'Compounder') {
      base.ownerEarnings += 0.025 * moat; base.dcf += 0.025 * reliability;
    } else if (category === 'Dividend') {
      base.dcf += 0.04; base.ownerEarnings += 0.025;
    } else if (category === 'Turnaround' || category === 'Cyclical') {
      base.ebitdaExit += 0.035;
    }
  }
  return normalizedWeights(base);
}

function cashFlowAnchor(methods) {
  const values = ['dcf', 'dcfSBCAdjusted', 'ownerEarnings']
    .map(k => methods[k])
    .filter(v => Number.isFinite(v) && v > 0);
  return values.length ? median(values) : null;
}

function methodSpecificReliability(stock, key, value, center, anchor = null) {
  const last = stock.financials.years.at(-1) || {};
  const analyst = analystReliability(stock);
  const ratio = Math.max(value / center, center / value);
  let r = ratio <= 1.35 ? 1 : ratio <= 1.75 ? 0.82 : ratio <= 2.4 ? 0.55 : 0.25;

  if (key === 'epsExit') r *= analyst;
  if (key === 'revenueExit') r *= clamp(0.58 + analyst * 0.32, 0.50, 0.90);
  if ((key === 'dcf' || key === 'dcfSBCAdjusted') && !(last.fcf > 0)) r *= 0.25;
  if (key === 'ownerEarnings' && !(last.netIncome > 0)) r *= 0.25;
  if (key === 'ownerEarnings') r *= 0.90;

  const sbcIntensity = last.sbc != null && last.revenue > 0 ? last.sbc / last.revenue : 0;
  if (key === 'dcf' && sbcIntensity > 0.10) r *= 0.70;
  if (key === 'dcfSBCAdjusted' && sbcIntensity < 0.02) r *= 0.75;

  // When all three exit methods cluster together at a much higher value than the
  // independently calculated cash-flow methods, the ordinary cross-method median is
  // misleading. Penalize the exit method against the cash-flow anchor as well. This
  // directly addresses AMAT-like cases where $800-$1,000 exit values overwhelm a
  // roughly $350-$400 DCF merely because there are more exit methods than DCF methods.
  if (anchor > 0 && ['revenueExit', 'epsExit', 'ebitdaExit'].includes(key)) {
    const anchorRatio = value / anchor;
    const anchorPenalty = anchorRatio <= 1.35 ? 1
      : anchorRatio <= 1.75 ? 0.78
      : anchorRatio <= 2.25 ? 0.48
      : anchorRatio <= 3.0 ? 0.25
      : 0.12;
    r *= anchorPenalty;
  }

  const industry = stock.valuation?.industryModel?.model;
  if (industry === 'semiconductors-hardware') {
    if (key === 'revenueExit') r *= 0.65;
    if (key === 'epsExit' || key === 'ebitdaExit') r *= 0.85;
  } else if (industry === 'software' && key === 'revenueExit') {
    r *= 1.08;
  } else if (industry === 'financials' && key === 'revenueExit') {
    r *= 0.35;
  }

  return clamp(r, 0.05, 1);
}

function redistributeCaps(normalized, caps) {
  // Iteratively cap methods and redistribute excess to uncapped methods in proportion
  // to their existing weights. This preserves a 100% total without letting a single
  // assumption-sensitive method dominate the blended fair value.
  for (let pass = 0; pass < 4; pass++) {
    let excess = 0;
    const receivers = [];
    for (const item of normalized) {
      const cap = caps[item.key];
      if (cap != null && item.normalizedWeight > cap) {
        excess += item.normalizedWeight - cap;
        item.normalizedWeight = cap;
      } else {
        receivers.push(item);
      }
    }
    if (excess <= 1e-12 || !receivers.length) break;
    const receiverTotal = receivers.reduce((sum, x) => sum + x.normalizedWeight, 0);
    if (receiverTotal <= 0) break;
    receivers.forEach(x => { x.normalizedWeight += excess * x.normalizedWeight / receiverTotal; });
  }
  const total = normalized.reduce((sum, x) => sum + x.normalizedWeight, 0);
  if (total > 0) normalized.forEach(x => { x.normalizedWeight /= total; });
  return normalized;
}

function combineValuations(methods, category = 'Value', stock = null, businessProfile = null) {
  const base = businessSpecificWeights(category, businessProfile, stock?.valuation?.industryModel);
  const available = Object.entries(methods).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!available.length) return { blendedFairValue: null, agreementScore: null, methodCount: 0, effectiveWeights: {}, reliabilityFlags: [] };
  const center = median(available.map(([, v]) => v));
  const anchor = cashFlowAnchor(methods);
  const reliabilityFlags = [];
  const weighted = available.map(([key, value]) => {
    const reliability = stock ? methodSpecificReliability(stock, key, value, center, anchor) : 1;
    if (reliability < 0.98) reliabilityFlags.push({
      method: key, value, consensusMedian: center, cashFlowAnchor: anchor,
      ratio: Math.max(value / center, center / value),
      anchorRatio: anchor > 0 ? value / anchor : null,
      reliability,
    });
    return { key, value, weight: (base[key] || 0) * reliability };
  });
  const total = weighted.reduce((sum, x) => sum + x.weight, 0);
  let normalized = weighted.map(x => ({ ...x, normalizedWeight: total ? x.weight / total : 0 }));

  const industry = stock?.valuation?.industryModel?.model;
  const caps = {
    ownerEarnings: 0.15,
    revenueExit: industry === 'software' ? 0.28 : industry === 'semiconductors-hardware' ? 0.08 : 0.18,
    epsExit: industry === 'semiconductors-hardware' ? 0.18 : 0.30,
    ebitdaExit: industry === 'semiconductors-hardware' ? 0.22 : 0.42,
  };
  normalized = redistributeCaps(normalized, caps);

  const blendedFairValue = normalized.reduce((sum, x) => sum + x.value * x.normalizedWeight, 0);
  const effectiveWeights = Object.fromEntries(normalized.map(x => [x.key, x.normalizedWeight]));
  const robustDeviations = available.map(([, v]) => Math.abs(v - center) / center);
  const anchorDivergence = anchor > 0
    ? available.filter(([k]) => ['revenueExit', 'epsExit', 'ebitdaExit'].includes(k))
      .map(([, v]) => Math.abs(v - anchor) / anchor)
    : [];
  const disagreement = Math.max(median(robustDeviations) || 0, (median(anchorDivergence) || 0) * 0.65);
  const agreementScore = Math.round(clamp(100 - disagreement * 150, 0, 100));
  return { blendedFairValue, agreementScore, methodCount: available.length, effectiveWeights, reliabilityFlags, cashFlowAnchor: anchor };
}

function fiveYearPriceTargetCAGR(stock, model, exitResults, effectiveWeights) {
  const currentPrice = stock.price.current;
  if (!(currentPrice > 0)) return { cagr: null, exitPrice: null, methodsUsed: 0 };
  const future = Object.entries(exitResults)
    .filter(([, r]) => r?.exitPricePerShare > 0)
    .map(([key, r]) => ({ value: r.exitPricePerShare, weight: effectiveWeights[key] || 0 }));
  const rawExitPrice = weightedAverage(future);
  if (!(rawExitPrice > 0)) return { cagr: null, exitPrice: null, methodsUsed: 0 };
  const years = model.projection.length;
  const dividendsReceived = (stock.valuation.dividendYield || 0) * currentPrice * years;
  const totalFutureValue = rawExitPrice + dividendsReceived;
  const rawCagr = Math.pow(totalFutureValue / currentPrice, 1 / years) - 1;

  // Data/split errors can otherwise create four-digit expected CAGRs. Preserve the raw
  // value for audit, but cap the actionable screener signal at a generous 60% annually.
  const cagrValue = clamp(rawCagr, -0.75, 0.60);
  const last = stock.financials.years.at(-1) || {};
  const exit = model.projection.at(-1) || {};
  const startRevenue = last.revenue;
  const startNetMargin = last.revenue > 0 ? last.netIncome / last.revenue : null;
  const startShares = last.sharesOutTTM;
  const revenueGrowth = cagr(startRevenue, exit.revenue, years);
  const marginExpansion = startNetMargin > 0 && exit.netMargin > 0
    ? Math.pow(exit.netMargin / startNetMargin, 1 / years) - 1 : null;
  const shareCountEffect = startShares > 0 && exit.shares > 0
    ? Math.pow(startShares / exit.shares, 1 / years) - 1 : null;
  const dividendContribution = clamp(stock.valuation.dividendYield || 0, 0, 0.20);
  const operatingContribution = [revenueGrowth, marginExpansion, shareCountEffect]
    .filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const multipleRerating = Number.isFinite(operatingContribution)
    ? cagrValue - operatingContribution - dividendContribution : null;

  return {
    cagr: cagrValue, rawCagr, cagrWasCapped: rawCagr !== cagrValue,
    exitPrice: rawExitPrice, dividendsReceived, totalFutureValue,
    methodsUsed: future.length, currentPrice, years,
    breakdown: {
      revenueGrowth, marginExpansion, shareCountEffect,
      dividendContribution, multipleRerating,
    },
  };
}

function valuateStock(stock, sectorExitMultiples) {
  const category = inferValuationCategory(stock);
  const sectorMultiples = sectorExitMultiples[stock.sector] || sectorExitMultiples.Unknown || {};
  const model = projectFinancials(stock, stock.growthYear1, 5);
  const businessProfile = buildBusinessProfile(stock, category, model);
  const dcf = dcfFromProjection(stock, model, { sbcAdjusted: false });
  const dcfSBCAdjusted = dcfFromProjection(stock, model, { sbcAdjusted: true });
  const ownerEarnings = ownerEarningsFromProjection(stock, model);
  const revenueExit = exitMethod(stock, model, sectorMultiples, 'revenueExit', businessProfile);
  const epsExit = exitMethod(stock, model, sectorMultiples, 'epsExit', businessProfile);
  const ebitdaExit = exitMethod(stock, model, sectorMultiples, 'ebitdaExit', businessProfile);
  const methods = {
    dcf: dcf.fairValuePerShare, dcfSBCAdjusted: dcfSBCAdjusted.fairValuePerShare, ownerEarnings: ownerEarnings.fairValuePerShare,
    revenueExit: revenueExit.fairValuePerShare, epsExit: epsExit.fairValuePerShare, ebitdaExit: ebitdaExit.fairValuePerShare,
  };
  const combined = combineValuations(methods, category, stock, businessProfile);
  const consensus = buildValuationConsensus(methods, combined.agreementScore, combined.effectiveWeights);
  const exitResults = { revenueExit, epsExit, ebitdaExit };
  const legacyPriceTarget = fiveYearPriceTargetCAGR(stock, model, exitResults, combined.effectiveWeights);
  const returnEngineV2 = computeReturnEngineV2(stock, model, legacyPriceTarget.exitPrice, consensus);
  const fiveYearPriceTarget = {
    ...legacyPriceTarget,
    cagr: returnEngineV2.expectedCAGR,
    rawCagr: returnEngineV2.uncappedMarketCAGR,
    cagrWasCapped: returnEngineV2.uncappedMarketCAGR != null && returnEngineV2.uncappedMarketCAGR !== returnEngineV2.expectedCAGR,
    breakdown: returnEngineV2.breakdown,
    returnEngineVersion: 'institutional-v2',
    multipleDominated: returnEngineV2.multipleDominated,
  };
  const currentPrice = stock.price.current;
  const finalFairValue = consensus.actionableFairValue ?? combined.blendedFairValue;
  const marginOfSafety = finalFairValue && currentPrice
    ? (finalFairValue - currentPrice) / finalFairValue : null;

  const last = stock.financials.years.at(-1) || {};
  const discountRate = getDynamicDiscountRate(stock, category);
  const terminalGrowth = getDynamicTerminalGrowth(stock, category);
  let marketImpliedGrowth = null, marketImpliedGrowthNote = null;
  if (last.fcf > 0 && last.sharesOutTTM > 0 && currentPrice > 0) {
    const implied = solveImpliedGrowth({
      fcfBase: last.fcf, terminalGrowth, discountRate, years: 10,
      netDebt: (last.longTermDebt || 0) - (last.cash || 0), sharesOut: last.sharesOutTTM,
      targetPricePerShare: currentPrice,
    });
    marketImpliedGrowth = implied.impliedGrowth;
    marketImpliedGrowthNote = implied.reason !== 'converged' ? implied.reason : null;
  }

  const marketExpectations = buildMarketExpectations(stock, model, marketImpliedGrowth, returnEngineV2);
  const monteCarlo = simulateReturns(stock, returnEngineV2, combined.agreementScore, Math.round((businessProfile.forecastReliability || 0.5) * 100));

  return {
    category, businessProfile, methods, blendedFairValue: finalFairValue,
    intrinsicValue: consensus.intrinsicValue,
    marketValue: consensus.marketValue,
    valuationConsensus: consensus,
    returnEngineV2,
    marketExpectations,
    monteCarlo,
    agreementScore: combined.agreementScore, methodCount: combined.methodCount,
    effectiveWeights: combined.effectiveWeights, reliabilityFlags: combined.reliabilityFlags,
    outlierFlags: combined.reliabilityFlags, marginOfSafety, fiveYearPriceTarget,
    marketImpliedGrowth, marketImpliedGrowthNote, reverseDCFGap: marketImpliedGrowth != null ? model.growthModel.assumptions.year1 - marketImpliedGrowth : null,
    capitalAllocation: capitalAllocationScore(stock), analystReliability: analystReliability(stock),
    dilutionRate: model.dilutionRate,
    sbcIntensity: last.sbcIntensity ?? (last.sbc != null && last.revenue > 0 ? last.sbc / last.revenue : null),
    projection: model.projection,
    projectionAssumptions: {
      version: '7.0-milestone-4', category, businessProfile, discountRate, terminalGrowth, analystReliability: analystReliability(stock), capitalAllocation: capitalAllocationScore(stock),
      growthModel: model.growthModel, startingValues: model.startingValues, marginAssumptions: model.marginAssumptions,
    },
    methodAudits: {
      dcf: dcf.audit, dcfSBCAdjusted: dcfSBCAdjusted.audit, ownerEarnings: ownerEarnings.audit,
      revenueExit: revenueExit.audit, epsExit: epsExit.audit, ebitdaExit: ebitdaExit.audit,
    },
  };
}

const api = {
  computeSectorExitMultiples, valuateStock, projectFinancials, estimateDilutionRate,
  combineValuations, meanRevertedMultiple, qualityPremiumWeight, fiveYearPriceTargetCAGR,
  inferValuationCategory, buildGrowthPath, buildBusinessProfile, businessSpecificWeights, intelligentExitMultiple, analystReliability, capitalAllocationScore, ownerEarningsFromProjection,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ValuationMethods = api;
