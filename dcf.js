/**
 * Simple reverse-DCF fair value estimator. No external dependencies.
 *
 * Method: project FCF forward `years` (default 10), with growth fading
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

function reverseDCF({ fcfBase, growthYear1, terminalGrowth = 0.025, discountRate = 0.095, years = 10, netDebt = 0, sharesOut }) {
  if (fcfBase == null || fcfBase <= 0 || !sharesOut) {
    return { fairValuePerShare: null, reason: 'missing or non-positive FCF / share count' };
  }
  // Clamp growth inputs to sane bounds so one bad data point doesn't blow up the model
  const g1 = Math.max(-0.10, Math.min(0.35, growthYear1 ?? terminalGrowth));

  let fcf = fcfBase;
  let pvSum = 0;
  for (let t = 1; t <= years; t++) {
    const g = g1 + (terminalGrowth - g1) * ((t - 1) / (years - 1)); // linear fade to terminal growth
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

// Convenience wrapper that pulls what it needs off a stock record
// (matches the shape built by data-fetchers.js) and returns fair value + margin of safety.
function estimateFairValue(stock, growthYear1) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const discountRate = getDiscountRate(stock.sector);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);

  const dcf = reverseDCF({
    fcfBase: last.fcf,
    growthYear1,
    discountRate,
    netDebt,
    sharesOut: last.sharesOutTTM,
  });

  if (!dcf.fairValuePerShare) return dcf;

  const currentPrice = stock.price.current;
  const marginOfSafety = currentPrice ? (dcf.fairValuePerShare - currentPrice) / dcf.fairValuePerShare : null;
  return { ...dcf, marginOfSafety, currentPrice };
}

const api = { reverseDCF, estimateFairValue, getDiscountRate, SECTOR_DISCOUNT_RATES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DCF = api;
