/**
 * Simple reverse-DCF fair value estimator. No external dependencies.
 *
 * Method: project FCF forward `years` (default 5), with growth fading
 * linearly from `growthYear1` down to `terminalGrowth`, discount each
 * year's FCF back at `discountRate`, add a Gordon-growth terminal value,
 * subtract net debt, divide by shares outstanding.
 *
 * This is intentionally simple (single discount rate, linear growth fade,
 * FCF growth = revenue growth proxy) — good enough for a first-pass
 * screen, not a substitute for per-company modeling on names you're
 * seriously considering.
 */

// Rough sector risk-premium map -> discount rate. Edit these to taste.
const SECTOR_DISCOUNT_RATES = {
  'Technology': 0.095,
  'Consumer Discretionary': 0.10,
  'Consumer Staples': 0.075,
  'Healthcare': 0.085,
  'Financials': 0.10,
  'Industrials': 0.09,
  'Energy': 0.11,
  'Materials': 0.10,
  'Utilities': 0.07,
  'Real Estate': 0.085,
  'Communication Services': 0.09,
  'Unknown': 0.095,
};

function getDiscountRate(sector) {
  return SECTOR_DISCOUNT_RATES[sector] ?? SECTOR_DISCOUNT_RATES.Unknown;
}

function reverseDCF({ fcfBase, growthYear1, terminalGrowth = 0.025, discountRate = 0.095, years = 5, netDebt = 0, sharesOut }) {
  if (fcfBase == null || fcfBase <= 0 || !sharesOut) {
    return { fairValuePerShare: null, reason: 'missing or non-positive FCF / share count' };
  }
  const g1 = growthYear1 ?? terminalGrowth;

  let fcf = fcfBase;
  let pvSum = 0;
  for (let t = 1; t <= years; t++) {
    const g = g1 + (terminalGrowth - g1) * ((t - 1) / (years - 1));
    fcf = fcf * (1 + g);
    pvSum += fcf / Math.pow(1 + discountRate, t);
  }
  const terminalValue = (fcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
  const pvTerminal = terminalValue / Math.pow(1 + discountRate, years);

  const enterpriseValue = pvSum + pvTerminal;
  const equityValue = enterpriseValue - netDebt;
  const fairValuePerShare = equityValue / sharesOut;

  return {
    fairValuePerShare,
    enterpriseValue,
    equityValue,
    pvExplicitFCF: pvSum,
    pvTerminalValue: pvTerminal,
    terminalValueShareOfTotal: pvTerminal / enterpriseValue,
    assumptions: { growthYear1: g1, terminalGrowth, discountRate, years, netDebt },
  };
}

function estimateFairValue(stock, growthYear1) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const discountRate = getDiscountRate(stock.sector);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const clampedGrowth = growthYear1 != null ? Math.max(-0.10, Math.min(0.35, growthYear1)) : growthYear1;

  const dcf = reverseDCF({
    fcfBase: last.fcf,
    growthYear1: clampedGrowth,
    discountRate,
    netDebt,
    sharesOut: last.sharesOutTTM,
    years: 5, // explicit, not relying on reverseDCF's default — this is what populates
              // stock.valuation.fairValueEstimate, which needs to match the 5-year
              // horizon every other valuation method now uses.
  });

  if (!dcf.fairValuePerShare) return dcf;

  const currentPrice = stock.price.current;
  const marginOfSafety = currentPrice ? (dcf.fairValuePerShare - currentPrice) / dcf.fairValuePerShare : null;
  return { ...dcf, marginOfSafety, currentPrice };
}

function solveImpliedGrowth({ fcfBase, terminalGrowth = 0.025, discountRate = 0.095, years = 5, netDebt = 0, sharesOut, targetPricePerShare }) {
  if (fcfBase == null || fcfBase <= 0 || !sharesOut || !targetPricePerShare) return { impliedGrowth: null, reason: 'missing inputs' };
  const LO = -0.50, HI = 1.50;

  const valueAt = (g) => reverseDCF({ fcfBase, growthYear1: g, terminalGrowth, discountRate, years, netDebt, sharesOut }).fairValuePerShare;
  const fvAtLo = valueAt(LO), fvAtHi = valueAt(HI);

  if (fvAtHi != null && fvAtHi < targetPricePerShare) {
    return { impliedGrowth: null, reason: 'exceeds_search_range_high', boundFairValue: fvAtHi };
  }
  if (fvAtLo != null && fvAtLo > targetPricePerShare) {
    return { impliedGrowth: null, reason: 'exceeds_search_range_low', boundFairValue: fvAtLo };
  }

  let lo = LO, hi = HI;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fv = valueAt(mid);
    if (fv == null) return { impliedGrowth: null, reason: 'dcf_error' };
    if (fv < targetPricePerShare) lo = mid; else hi = mid;
  }
  return { impliedGrowth: (lo + hi) / 2, reason: 'converged' };
}

const api = { reverseDCF, estimateFairValue, getDiscountRate, solveImpliedGrowth, SECTOR_DISCOUNT_RATES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DCF = api;
