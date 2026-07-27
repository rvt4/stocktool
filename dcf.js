/** FreeScreener DCF helpers — V3.5 */
const SECTOR_BASE_DISCOUNT_RATES = {
  'Technology': 0.095,
  'Consumer Discretionary': 0.098,
  'Consumer Staples': 0.082,
  'Healthcare': 0.090,
  'Financials': 0.100,
  'Industrials': 0.092,
  'Energy': 0.108,
  'Materials': 0.102,
  'Utilities': 0.078,
  'Real Estate': 0.090,
  'Communication Services': 0.092,
  'Unknown': 0.097,
};
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function getDiscountRate(sector) { return SECTOR_BASE_DISCOUNT_RATES[sector] ?? SECTOR_BASE_DISCOUNT_RATES.Unknown; }

function getDynamicDiscountRate(stock, category = 'Value') {
  let rate = getDiscountRate(stock?.sector);
  const yrs = stock?.financials?.years || [];
  const last = yrs.at(-1) || {};
  const marketCap = stock?.valuation?.marketCap || 0;
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const debtToEbitda = last.debtToEbitda;
  const interestCoverage = last.interestCoverage ?? stock?.valuation?.interestCoverage ?? null;
  const beta = stock?.valuation?.beta ?? null;
  const positiveYears = yrs.slice(-5).filter(y => y.netIncome > 0).length;
  const fcfPositiveYears = yrs.slice(-5).filter(y => y.fcf > 0).length;
  const opMargins = yrs.slice(-5).map(y => y.opMargin).filter(Number.isFinite);
  const marginVolatility = opMargins.length >= 2
    ? Math.sqrt(mean(opMargins.map(x => (x - mean(opMargins)) ** 2))) : 0.03;

  if (marketCap > 200e9) rate -= 0.006;
  else if (marketCap > 50e9) rate -= 0.003;
  else if (marketCap && marketCap < 5e9) rate += 0.008;

  if (avgRoic != null && avgRoic >= 0.25) rate -= 0.005;
  else if (avgRoic != null && avgRoic < 0.08) rate += 0.006;

  if (debtToEbitda != null) {
    if (debtToEbitda > 4) rate += 0.012;
    else if (debtToEbitda > 2.5) rate += 0.006;
    else if (debtToEbitda < 1) rate -= 0.002;
  }
  if (positiveYears <= 2 || fcfPositiveYears <= 2) rate += 0.010;
  if (interestCoverage != null) { if (interestCoverage < 2) rate += 0.012; else if (interestCoverage > 8) rate -= 0.003; }
  if (beta != null) rate += clamp((beta - 1) * 0.008, -0.006, 0.012);
  if (marginVolatility > 0.08) rate += 0.008;
  else if (marginVolatility < 0.025) rate -= 0.002;

  if (category === 'Hyper Growth') rate += 0.006;
  if (category === 'Turnaround') rate += 0.010;
  if (category === 'Cyclical') rate += 0.012;
  if (category === 'Dividend') rate -= 0.002;
  return clamp(rate, 0.075, 0.125);
}

function getDynamicTerminalGrowth(stock, category = 'Value') {
  const baseBySector = {
    'Utilities': 0.020, 'Real Estate': 0.020, 'Consumer Staples': 0.023,
    'Energy': 0.020, 'Materials': 0.021, 'Industrials': 0.023,
    'Financials': 0.023, 'Consumer Discretionary': 0.024,
    'Healthcare': 0.026, 'Communication Services': 0.027,
    'Technology': 0.028, 'Unknown': 0.024,
  };
  let g = baseBySector[stock?.sector] ?? baseBySector.Unknown;
  const yrs = stock?.financials?.years || [];
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(Number.isFinite));
  const pricing = stock?.pricingPowerScore ?? 50;
  if (avgRoic != null && avgRoic >= 0.20) g += 0.003;
  if (pricing >= 75) g += 0.002;
  if (category === 'Compounder') g += 0.002;
  if (category === 'Hyper Growth' || category === 'Growth') g += 0.001;
  if (category === 'Turnaround' || category === 'Cyclical') g -= 0.002;
  return clamp(g, 0.018, 0.035);
}

function reverseDCF({ fcfBase, growthYear1, terminalGrowth = 0.025, discountRate = 0.095, years = 5, netDebt = 0, sharesOut }) {
  if (!(fcfBase > 0) || !(sharesOut > 0) || discountRate <= terminalGrowth) return { fairValuePerShare: null, reason: 'invalid DCF inputs' };
  const g1 = growthYear1 ?? terminalGrowth;
  let fcf = fcfBase, pvSum = 0;
  for (let t = 1; t <= years; t++) {
    const p = (t - 1) / Math.max(1, years - 1);
    const g = g1 + (terminalGrowth - g1) * p;
    fcf *= 1 + g;
    pvSum += fcf / Math.pow(1 + discountRate, t);
  }
  const terminalValue = fcf * (1 + terminalGrowth) / (discountRate - terminalGrowth);
  const pvTerminal = terminalValue / Math.pow(1 + discountRate, years);
  const enterpriseValue = pvSum + pvTerminal;
  const equityValue = enterpriseValue - netDebt;
  return {
    fairValuePerShare: equityValue / sharesOut, enterpriseValue, equityValue,
    pvExplicitFCF: pvSum, pvTerminalValue: pvTerminal,
    terminalValueShareOfTotal: pvTerminal / enterpriseValue,
    assumptions: { growthYear1: g1, terminalGrowth, discountRate, years, netDebt },
  };
}

function estimateFairValue(stock, growthYear1) {
  const last = stock.financials.years.at(-1) || {};
  const category = 'Value';
  const discountRate = getDynamicDiscountRate(stock, category);
  const terminalGrowth = getDynamicTerminalGrowth(stock, category);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const dcf = reverseDCF({ fcfBase: last.fcf, growthYear1: clamp(growthYear1 ?? 0.05, -0.10, 0.35), terminalGrowth, discountRate, netDebt, sharesOut: last.sharesOutTTM, years: 5 });
  if (!dcf.fairValuePerShare) return dcf;
  const currentPrice = stock.price.current;
  return { ...dcf, marginOfSafety: currentPrice ? (dcf.fairValuePerShare - currentPrice) / dcf.fairValuePerShare : null, currentPrice };
}

function solveImpliedGrowth({ fcfBase, terminalGrowth = 0.025, discountRate = 0.095, years = 10, netDebt = 0, sharesOut, targetPricePerShare }) {
  if (!(fcfBase > 0) || !(sharesOut > 0) || !(targetPricePerShare > 0)) return { impliedGrowth: null, reason: 'missing inputs' };
  const LO = -0.50, HI = 1.50;
  const valueAt = g => reverseDCF({ fcfBase, growthYear1: g, terminalGrowth, discountRate, years, netDebt, sharesOut }).fairValuePerShare;
  if (valueAt(HI) < targetPricePerShare) return { impliedGrowth: null, reason: 'exceeds_search_range_high' };
  if (valueAt(LO) > targetPricePerShare) return { impliedGrowth: null, reason: 'exceeds_search_range_low' };
  let lo = LO, hi = HI;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (valueAt(mid) < targetPricePerShare) lo = mid; else hi = mid;
  }
  return { impliedGrowth: (lo + hi) / 2, reason: 'converged' };
}

const api = {
  reverseDCF, estimateFairValue, getDiscountRate, getDynamicDiscountRate,
  getDynamicTerminalGrowth, solveImpliedGrowth, SECTOR_DISCOUNT_RATES: SECTOR_BASE_DISCOUNT_RATES,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DCF = api;
