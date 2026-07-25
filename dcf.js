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
  // No clamping here — this is the raw calculator. Clamping happens in estimateFairValue()
  // (the "give me a conservative number" path). solveImpliedGrowth() intentionally calls
  // this directly, unclamped, because its whole purpose is to find the TRUE growth rate
  // implied by the market price, even if that rate is unrealistic — that gap IS the signal.
  const g1 = growthYear1 ?? terminalGrowth;

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
// This is where growth gets clamped to a CONSERVATIVE band [-10%, 35%] — deliberately
// tighter than the Expected CAGR headline's clamps. A recent-quarter spike (e.g. from
// an acquisition, like CELH's Alani Nu deal) can be a legitimate near-term growth driver
// worth showing in the CAGR estimate, but shouldn't be treated as a 10-year sustained
// rate in the valuation *gate* — that's how a one-time step-change turns into an inflated
// fair value and an unrealistic margin of safety.
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
  });

  if (!dcf.fairValuePerShare) return dcf;

  const currentPrice = stock.price.current;
  const marginOfSafety = currentPrice ? (dcf.fairValuePerShare - currentPrice) / dcf.fairValuePerShare : null;
  return { ...dcf, marginOfSafety, currentPrice };
}

// Given a target price, solve for the year-1 growth rate that would make the DCF's
// fair value equal that price — i.e. "what is the market currently pricing in?"
// Useful as a transparency check: compare this to your own growth estimate rather
// than letting a single DCF fair-value number silently assert overvaluation.
// fairValuePerShare increases monotonically with growthYear1 (given discountRate >
// terminalGrowth, which always holds here), so binary search is safe.
function solveImpliedGrowth({ fcfBase, terminalGrowth = 0.025, discountRate = 0.095, years = 10, netDebt = 0, sharesOut, targetPricePerShare }) {
  if (fcfBase == null || fcfBase <= 0 || !sharesOut || !targetPricePerShare) return { impliedGrowth: null, reason: 'missing inputs' };
  const LO = -0.50, HI = 1.50;

  const valueAt = (g) => reverseDCF({ fcfBase, growthYear1: g, terminalGrowth, discountRate, years, netDebt, sharesOut }).fairValuePerShare;
  const fvAtLo = valueAt(LO), fvAtHi = valueAt(HI);

  if (fvAtHi != null && fvAtHi < targetPricePerShare) {
    // Price exceeds what even 150%/yr sustained growth can justify — a real, useful
    // signal (this is a "growth priced beyond any reasonable DCF path" situation),
    // not a specific number. Report it as infeasible rather than returning 150% as
    // if it were a precise answer.
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
