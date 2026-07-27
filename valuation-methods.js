/**
 * FreeScreener V3.5 valuation engine
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

// ---------- Growth path ----------
const GROWTH_CONFIG = {
  'Hyper Growth': { floor: 0.12, retention: 0.42, cap: 0.24 },
  Growth:         { floor: 0.08, retention: 0.42, cap: 0.18 },
  Compounder:     { floor: 0.07, retention: 0.50, cap: 0.16 },
  Turnaround:     { floor: 0.03, retention: 0.30, cap: 0.10 },
  Cyclical:       { floor: 0.02, retention: 0.20, cap: 0.08 },
  Dividend:       { floor: 0.02, retention: 0.35, cap: 0.07 },
  Value:          { floor: 0.02, retention: 0.30, cap: 0.08 },
};

function buildGrowthPath(stock, category, years = 5) {
  const e = stock.analystEstimates || {};
  const fallback = stock.growthYear1 ?? historicalMedianGrowth(stock.financials.years) ?? 0.05;
  const year1 = clamp(e.revenueGrowthCurrentYear ?? e.revenueGrowthFwd ?? fallback, -0.25, 0.65);
  let year2 = e.revenueGrowthNextYear;
  if (year2 == null && e.revenueCurrentYear > 0 && e.revenueNextYear > 0) year2 = e.revenueNextYear / e.revenueCurrentYear - 1;
  if (year2 == null) year2 = year1 * (['Hyper Growth', 'Growth', 'Compounder'].includes(category) ? 0.88 : 0.75);
  year2 = clamp(year2, -0.20, 0.55);

  const cfg = GROWTH_CONFIG[category] || GROWTH_CONFIG.Value;
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const reinvest = clamp(stock.reinvestmentRate ?? 0.40, 0.10, 0.80);
  const sustainable = avgRoic != null ? clamp(avgRoic, 0, 0.35) * reinvest : null;
  const anchor = Math.max(0, mean([year1, year2]) ?? year1);
  const categoryTarget = clamp(anchor * cfg.retention, cfg.floor, cfg.cap);
  const year5 = sustainable != null
    ? clamp(categoryTarget * 0.80 + sustainable * 0.20, cfg.floor, cfg.cap)
    : categoryTarget;

  const path = [year1, year2];
  for (let t = 3; t <= years; t++) {
    const p = (t - 2) / Math.max(1, years - 2);
    const smooth = p * p * (3 - 2 * p);
    path.push(year2 + (year5 - year2) * smooth);
  }
  return {
    path: path.slice(0, years),
    source: e.revenueGrowthCurrentYear != null || e.revenueGrowthFwd != null
      ? 'analyst_consensus_plus_v3_fade'
      : 'sec_history_plus_v3_fade',
    assumptions: { year1, year2, year5, sustainableGrowth: sustainable, category },
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
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const roic = clamp(((avgRoic ?? 0.08) - 0.06) / 0.24, 0, 1);
  const growth = clamp(((exitGrowth ?? 0.04) - 0.02) / 0.16, 0, 1);
  const pricing = clamp((stock.pricingPowerScore ?? 50) / 100, 0, 1);
  const fcfMargins = yrs.slice(-3).map(y => y.fcf != null && y.revenue ? y.fcf / y.revenue : null).filter(Number.isFinite);
  const conversion = clamp(((median(fcfMargins) ?? 0.05) - 0.02) / 0.23, 0, 1);
  return clamp(roic * 0.40 + growth * 0.30 + pricing * 0.15 + conversion * 0.15, 0, 1);
}
function qualityPremiumWeight(stock, exitGrowth) {
  return clamp(0.30 + qualityScore01(stock, exitGrowth) * 0.55, 0.30, 0.85);
}

function companyCurrentMultiple(stock, type) {
  const last = stock.financials.years.at(-1) || {};
  if (type === 'epsExit') return stock.valuation.forwardPe ?? stock.valuation.pe ?? null;
  if (type === 'ebitdaExit') return stock.valuation.evEbitda ?? null;
  if (type === 'revenueExit' && stock.valuation.ev > 0 && last.revenue > 0) return stock.valuation.ev / last.revenue;
  return null;
}

function intelligentExitMultiple(stock, type, sectorMultiple, exitGrowth) {
  if (!(sectorMultiple > 0)) return { multiple: null };
  const current = companyCurrentMultiple(stock, type);
  const quality = qualityScore01(stock, exitGrowth);
  const growthPremium = clamp((exitGrowth - 0.04) * (type === 'revenueExit' ? 2.8 : 2.0), -0.20, 0.55);
  const qualityPremium = (quality - 0.50) * 0.55;
  const qualityAdjustedSector = sectorMultiple * clamp(1 + growthPremium + qualityPremium, 0.60, 1.65);
  const boundedCurrent = current > 0 ? clamp(current, sectorMultiple * 0.45, sectorMultiple * 2.0) : null;
  const retain = qualityPremiumWeight(stock, exitGrowth);
  const multiple = boundedCurrent != null
    ? qualityAdjustedSector * (1 - retain) + boundedCurrent * retain
    : qualityAdjustedSector;
  return {
    multiple: clamp(multiple, sectorMultiple * 0.50, sectorMultiple * 1.85),
    sectorMultiple,
    companyCurrentMultiple: current,
    boundedCompanyMultiple: boundedCurrent,
    qualityAdjustedSector,
    qualityPremiumRetained: retain,
    qualityScore: quality,
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

function exitMethod(stock, model, sectorMultiples, type) {
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
  const multipleModel = intelligentExitMultiple(stock, type, sectorMultiple, exit.growth);
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
  'Hyper Growth': { dcf: 0.09, dcfSBCAdjusted: 0.05, ownerEarnings: 0.10, revenueExit: 0.25, epsExit: 0.34, ebitdaExit: 0.17 },
  Growth:         { dcf: 0.12, dcfSBCAdjusted: 0.06, ownerEarnings: 0.12, revenueExit: 0.21, epsExit: 0.31, ebitdaExit: 0.18 },
  Compounder:     { dcf: 0.17, dcfSBCAdjusted: 0.08, ownerEarnings: 0.18, revenueExit: 0.10, epsExit: 0.27, ebitdaExit: 0.20 },
  Value:          { dcf: 0.24, dcfSBCAdjusted: 0.10, ownerEarnings: 0.20, revenueExit: 0.03, epsExit: 0.20, ebitdaExit: 0.23 },
  Dividend:       { dcf: 0.27, dcfSBCAdjusted: 0.08, ownerEarnings: 0.22, revenueExit: 0.02, epsExit: 0.20, ebitdaExit: 0.21 },
  Turnaround:     { dcf: 0.16, dcfSBCAdjusted: 0.06, ownerEarnings: 0.12, revenueExit: 0.08, epsExit: 0.20, ebitdaExit: 0.38 },
  Cyclical:       { dcf: 0.17, dcfSBCAdjusted: 0.06, ownerEarnings: 0.12, revenueExit: 0.05, epsExit: 0.18, ebitdaExit: 0.42 },
};

function methodSpecificReliability(stock, key, value, center) {
  const last = stock.financials.years.at(-1) || {};
  const analyst = analystReliability(stock);
  const ratio = Math.max(value / center, center / value);
  let r = ratio <= 1.35 ? 1 : ratio <= 1.75 ? 0.82 : ratio <= 2.4 ? 0.58 : 0.32;
  if (key === 'epsExit') r *= analyst;
  if (key === 'revenueExit') r *= clamp(0.65 + analyst * 0.35, 0.55, 1);
  if ((key === 'dcf' || key === 'dcfSBCAdjusted') && !(last.fcf > 0)) r *= 0.25;
  if (key === 'ownerEarnings' && !(last.netIncome > 0)) r *= 0.35;
  const sbcIntensity = last.sbc != null && last.revenue > 0 ? last.sbc / last.revenue : 0;
  if (key === 'dcf' && sbcIntensity > 0.10) r *= 0.70;
  if (key === 'dcfSBCAdjusted' && sbcIntensity < 0.02) r *= 0.75;
  return clamp(r, 0.15, 1);
}

function combineValuations(methods, category = 'Value', stock = null) {
  const base = CATEGORY_METHOD_WEIGHTS[category] || CATEGORY_METHOD_WEIGHTS.Value;
  const available = Object.entries(methods).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!available.length) return { blendedFairValue: null, agreementScore: null, methodCount: 0, effectiveWeights: {}, reliabilityFlags: [] };
  const center = median(available.map(([, v]) => v));
  const reliabilityFlags = [];
  const weighted = available.map(([key, value]) => {
    const reliability = stock ? methodSpecificReliability(stock, key, value, center) : 1;
    if (reliability < 0.98) reliabilityFlags.push({ method: key, value, consensusMedian: center, ratio: Math.max(value / center, center / value), reliability });
    return { key, value, weight: (base[key] || 0) * reliability };
  });
  const blendedFairValue = weightedAverage(weighted);
  const total = weighted.reduce((sum, x) => sum + x.weight, 0);
  const effectiveWeights = Object.fromEntries(weighted.map(x => [x.key, total ? x.weight / total : 0]));
  const robustDeviations = available.map(([, v]) => Math.abs(v - center) / center);
  const agreementScore = Math.round(clamp(100 - (median(robustDeviations) || 0) * 150, 0, 100));
  return { blendedFairValue, agreementScore, methodCount: available.length, effectiveWeights, reliabilityFlags };
}

function fiveYearPriceTargetCAGR(stock, model, exitResults, effectiveWeights) {
  const currentPrice = stock.price.current;
  if (!(currentPrice > 0)) return { cagr: null, exitPrice: null, methodsUsed: 0 };
  const future = Object.entries(exitResults)
    .filter(([, r]) => r?.exitPricePerShare > 0)
    .map(([key, r]) => ({ value: r.exitPricePerShare, weight: effectiveWeights[key] || 0 }));
  const exitPrice = weightedAverage(future);
  if (!(exitPrice > 0)) return { cagr: null, exitPrice: null, methodsUsed: 0 };
  const years = model.projection.length;
  const dividendsReceived = (stock.valuation.dividendYield || 0) * currentPrice * years;
  const totalFutureValue = exitPrice + dividendsReceived;
  return {
    cagr: Math.pow(totalFutureValue / currentPrice, 1 / years) - 1,
    exitPrice, dividendsReceived, totalFutureValue, methodsUsed: future.length, currentPrice, years,
  };
}

function valuateStock(stock, sectorExitMultiples) {
  const category = inferValuationCategory(stock);
  const sectorMultiples = sectorExitMultiples[stock.sector] || sectorExitMultiples.Unknown || {};
  const model = projectFinancials(stock, stock.growthYear1, 5);
  const dcf = dcfFromProjection(stock, model, { sbcAdjusted: false });
  const dcfSBCAdjusted = dcfFromProjection(stock, model, { sbcAdjusted: true });
  const ownerEarnings = ownerEarningsFromProjection(stock, model);
  const revenueExit = exitMethod(stock, model, sectorMultiples, 'revenueExit');
  const epsExit = exitMethod(stock, model, sectorMultiples, 'epsExit');
  const ebitdaExit = exitMethod(stock, model, sectorMultiples, 'ebitdaExit');
  const methods = {
    dcf: dcf.fairValuePerShare, dcfSBCAdjusted: dcfSBCAdjusted.fairValuePerShare, ownerEarnings: ownerEarnings.fairValuePerShare,
    revenueExit: revenueExit.fairValuePerShare, epsExit: epsExit.fairValuePerShare, ebitdaExit: ebitdaExit.fairValuePerShare,
  };
  const combined = combineValuations(methods, category, stock);
  const exitResults = { revenueExit, epsExit, ebitdaExit };
  const fiveYearPriceTarget = fiveYearPriceTargetCAGR(stock, model, exitResults, combined.effectiveWeights);
  const currentPrice = stock.price.current;
  const marginOfSafety = combined.blendedFairValue && currentPrice
    ? (combined.blendedFairValue - currentPrice) / combined.blendedFairValue : null;

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

  return {
    category, methods, blendedFairValue: combined.blendedFairValue,
    agreementScore: combined.agreementScore, methodCount: combined.methodCount,
    effectiveWeights: combined.effectiveWeights, reliabilityFlags: combined.reliabilityFlags,
    outlierFlags: combined.reliabilityFlags, marginOfSafety, fiveYearPriceTarget,
    marketImpliedGrowth, marketImpliedGrowthNote, reverseDCFGap: marketImpliedGrowth != null ? model.growthModel.assumptions.year1 - marketImpliedGrowth : null,
    capitalAllocation: capitalAllocationScore(stock), analystReliability: analystReliability(stock),
    dilutionRate: model.dilutionRate,
    sbcIntensity: last.sbcIntensity ?? (last.sbc != null && last.revenue > 0 ? last.sbc / last.revenue : null),
    projection: model.projection,
    projectionAssumptions: {
      version: '3.5', category, discountRate, terminalGrowth, analystReliability: analystReliability(stock), capitalAllocation: capitalAllocationScore(stock),
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
  inferValuationCategory, buildGrowthPath, intelligentExitMultiple, analystReliability, capitalAllocationScore, ownerEarningsFromProjection,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ValuationMethods = api;
