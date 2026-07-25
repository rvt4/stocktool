/**
 * Multi-method valuation. Runs as a SECOND PASS after every ticker in the watchlist
 * has been fetched (see run-screener.js) — exit-multiple methods need to know what
 * peers are currently trading at (sector median EV/Revenue, P/E, EV/EBITDA), which
 * isn't knowable until the whole universe is assembled.
 *
 * Four methods, each answering a different question:
 *   1. DCF (FCF-based)       — "what is this business worth from its cash generation?"
 *   2. Revenue exit multiple  — "what would this be worth if revenue hits target and
 *                                the market pays today's typical sector multiple for it?"
 *   3. EPS exit multiple      — same idea, anchored to earnings instead of revenue.
 *   4. EV/EBITDA exit multiple — same idea, anchored to EBITDA (more capital-structure-
 *                                aware than the revenue or P/E methods).
 *
 * All four explicitly model share dilution from SBC rather than assuming a flat share
 * count, since dilution is a real cost that erodes per-share value even when the
 * underlying business is compounding nicely.
 */

const { reverseDCF, getDiscountRate, solveImpliedGrowth } = require('./dcf');

// ---------- Dilution modeling ----------

// Estimate ongoing share dilution rate from SBC intensity: SBC / market cap approximates
// "what % of the company is being paid out in new shares each year", which is a more
// robust free-data proxy than historical share-count deltas (those mix in buybacks,
// secondary offerings, and the cover-page noise that caused problems earlier). Falls
// back to historical diluted share CAGR if SBC or market cap isn't available.
function estimateDilutionRate(stock) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const marketCap = stock.valuation.marketCap;

  if (last.sbc != null && marketCap) {
    return clamp(last.sbc / marketCap, -0.05, 0.15); // SBC-implied dilution, sanity-bounded
  }
  const shares = yrs.slice(-3).map(y => y.sharesOutTTM).filter(x => x != null);
  if (shares.length >= 2) {
    const cagr = Math.pow(shares[shares.length - 1] / shares[0], 1 / (shares.length - 1)) - 1;
    return clamp(cagr, -0.10, 0.15); // negative = net buybacks outpacing dilution
  }
  return 0.02; // modest default assumption if no data at all
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---------- Shared multi-year projection ----------

// Projects revenue, EBITDA, FCF, and diluted share count forward `years`, with growth
// fading from growthYear1 down to a medium-term rate, and margins drifting toward the
// company's own recent trend (capped so a single good/bad year can't dominate).
function projectFinancials(stock, growthYear1, years = 7) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const dilutionRate = estimateDilutionRate(stock);
  const mediumTermGrowth = clamp((growthYear1 ?? 0.05) * 0.4, 0.02, 0.15); // growth decays toward ~40% of its starting rate

  const ebitdaMargins = yrs.slice(-3).map(y => y.ebitda != null && y.revenue ? y.ebitda / y.revenue : null).filter(x => x != null);
  const marginTrend = ebitdaMargins.length >= 2 ? clamp((ebitdaMargins[ebitdaMargins.length - 1] - ebitdaMargins[0]) / (ebitdaMargins.length - 1), -0.03, 0.03) : 0;
  const startMargin = last.ebitda != null && last.revenue ? last.ebitda / last.revenue : 0.10;

  const fcfMargins = yrs.slice(-3).map(y => y.fcf != null && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  const avgFcfConversion = fcfMargins.length ? fcfMargins.reduce((a, b) => a + b, 0) / fcfMargins.length : 0.10;

  const projection = [];
  let revenue = last.revenue, shares = last.sharesOutTTM;
  for (let t = 1; t <= years; t++) {
    const g = (growthYear1 ?? mediumTermGrowth) + (mediumTermGrowth - (growthYear1 ?? mediumTermGrowth)) * ((t - 1) / Math.max(1, years - 1));
    revenue = revenue * (1 + g);
    shares = shares * (1 + dilutionRate);
    const margin = clamp(startMargin + marginTrend * t, 0.02, 0.60);
    const ebitda = revenue * margin;
    const fcf = revenue * clamp(avgFcfConversion + marginTrend * t, 0.01, 0.45);
    const netIncome = fcf * 0.75; // rough EBITDA-to-earnings proxy when a direct projection isn't available
    const eps = shares ? netIncome / shares : null;
    projection.push({ year: t, revenue, ebitda, fcf, eps, shares });
  }
  return { projection, dilutionRate, startMargin, marginTrend };
}

// ---------- Sector cross-sectional exit multiples ----------

// Computes each sector's median current P/E, EV/Revenue, and EV/EBITDA across the whole
// fetched universe. Used as the assumed multiple for exit-multiple valuation methods —
// i.e. "assume the market keeps paying roughly what it pays today for this sector",
// which avoids needing an external data source for "the right multiple" while still
// being grounded in real, current cross-sectional data rather than a hardcoded guess.
function computeSectorExitMultiples(stocks) {
  const bySector = {};
  stocks.forEach(s => {
    const sector = s.sector || 'Unknown';
    (bySector[sector] = bySector[sector] || { pe: [], evRevenue: [], evEbitda: [] });
    if (s.valuation.pe > 0 && s.valuation.pe < 100) bySector[sector].pe.push(s.valuation.pe);
    if (s.valuation.marketCap && s.financials.years.length) {
      const lastRev = s.financials.years[s.financials.years.length - 1].revenue;
      if (lastRev > 0) {
        const evRev = (s.valuation.ev ?? s.valuation.marketCap) / lastRev;
        if (evRev > 0 && evRev < 50) bySector[sector].evRevenue.push(evRev);
      }
    }
    if (s.valuation.evEbitda > 0 && s.valuation.evEbitda < 80) bySector[sector].evEbitda.push(s.valuation.evEbitda);
  });

  const medians = {};
  for (const sector in bySector) {
    medians[sector] = {
      pe: median(bySector[sector].pe),
      evRevenue: median(bySector[sector].evRevenue),
      evEbitda: median(bySector[sector].evEbitda),
      sampleSize: bySector[sector].pe.length,
    };
  }
  return medians;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- Valuation methods ----------

// Method 1: DCF, using FCF (the existing conservative-clamped estimateFairValue logic).
// Also runs an SBC-adjusted variant that treats SBC as a real economic cost.
function dcfMethods(stock, growthYear1) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const discountRate = getDiscountRate(stock.sector);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const clampedGrowth = growthYear1 != null ? clamp(growthYear1, -0.10, 0.35) : growthYear1;

  const standard = reverseDCF({ fcfBase: last.fcf, growthYear1: clampedGrowth, discountRate, netDebt, sharesOut: last.sharesOutTTM });
  const sbcAdjusted = last.fcfSBCAdjusted != null
    ? reverseDCF({ fcfBase: last.fcfSBCAdjusted, growthYear1: clampedGrowth, discountRate, netDebt, sharesOut: last.sharesOutTTM })
    : { fairValuePerShare: null };

  return {
    dcf: standard.fairValuePerShare ?? null,
    dcfSBCAdjusted: sbcAdjusted.fairValuePerShare ?? null,
  };
}

// Method 2: Revenue exit multiple. Projects revenue N years out, applies the sector's
// current median EV/Revenue as the assumed exit multiple, discounts back, adds PV of
// interim dividends (not retained FCF — that's already reflected in the higher exit
// value, so adding it too would double-count).
function revenueExitMethod(stock, growthYear1, sectorMultiples, years = 7) {
  const exitMultiple = sectorMultiples?.evRevenue;
  if (!exitMultiple) return null;
  const { projection } = projectFinancials(stock, growthYear1, years);
  const exitYear = projection[projection.length - 1];
  const last = stock.financials.years[stock.financials.years.length - 1];
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);

  const exitEV = exitYear.revenue * exitMultiple;
  const exitEquity = exitEV - netDebt;
  const exitPricePerShare = exitYear.shares ? exitEquity / exitYear.shares : null;
  if (exitPricePerShare == null) return null;

  const discountRate = getDiscountRate(stock.sector);
  const pvExitPrice = exitPricePerShare / Math.pow(1 + discountRate, years);
  const pvDividends = pvDividendStream(stock, years, discountRate);
  return pvExitPrice + pvDividends;
}

// Method 3: EPS exit multiple (P/E based).
function epsExitMethod(stock, growthYear1, sectorMultiples, years = 7) {
  const exitMultiple = sectorMultiples?.pe;
  if (!exitMultiple) return null;
  const { projection } = projectFinancials(stock, growthYear1, years);
  const exitYear = projection[projection.length - 1];
  if (exitYear.eps == null || exitYear.eps <= 0) return null; // P/E is meaningless on negative earnings

  const exitPricePerShare = exitYear.eps * exitMultiple;
  const discountRate = getDiscountRate(stock.sector);
  const pvExitPrice = exitPricePerShare / Math.pow(1 + discountRate, years);
  const pvDividends = pvDividendStream(stock, years, discountRate);
  return pvExitPrice + pvDividends;
}

// Method 4: EV/EBITDA exit multiple.
function ebitdaExitMethod(stock, growthYear1, sectorMultiples, years = 7) {
  const exitMultiple = sectorMultiples?.evEbitda;
  if (!exitMultiple) return null;
  const { projection } = projectFinancials(stock, growthYear1, years);
  const exitYear = projection[projection.length - 1];
  const last = stock.financials.years[stock.financials.years.length - 1];
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);

  const exitEV = exitYear.ebitda * exitMultiple;
  const exitEquity = exitEV - netDebt;
  const exitPricePerShare = exitYear.shares ? exitEquity / exitYear.shares : null;
  if (exitPricePerShare == null) return null;

  const discountRate = getDiscountRate(stock.sector);
  const pvExitPrice = exitPricePerShare / Math.pow(1 + discountRate, years);
  const pvDividends = pvDividendStream(stock, years, discountRate);
  return pvExitPrice + pvDividends;
}

function pvDividendStream(stock, years, discountRate) {
  const divYield = stock.valuation.dividendYield || 0;
  const price = stock.price.current;
  if (!divYield || !price) return 0;
  let pv = 0;
  let divPerShare = price * divYield;
  for (let t = 1; t <= years; t++) {
    pv += divPerShare / Math.pow(1 + discountRate, t);
  }
  return pv;
}

// ---------- Combine methods ----------

// Blends methods via a WEIGHTED average, not an unweighted median. An unweighted median
// across dcf/dcfSBCAdjusted/revenueExit/epsExit/ebitdaExit systematically biased low:
// dcf and dcfSBCAdjusted are nearly identical to each other (same methodology, one
// subtracts SBC), while the three exit-multiple methods are independently more
// conservative by construction (5-year horizon vs DCF's 10-year, and they assume NO
// multiple expansion from today's level). That's effectively "2 correlated votes vs 3
// independently-conservative votes," and a median mechanically favors whichever side
// has more members — it doesn't average anything, it just picks a side. Weighting fixes
// this: DCF methods (better-tested, longer horizon) get more combined weight than any
// single exit-multiple method, without discarding the exit-multiple perspective entirely.
const METHOD_WEIGHTS = { dcf: 0.28, dcfSBCAdjusted: 0.17, revenueExit: 0.20, epsExit: 0.20, ebitdaExit: 0.15 };

function combineValuations(methods) {
  const available = Object.entries(methods).filter(([, v]) => v != null && v > 0);
  if (!available.length) return { blendedFairValue: null, agreementScore: null, methodCount: 0 };

  const totalWeight = available.reduce((sum, [k]) => sum + (METHOD_WEIGHTS[k] || 0), 0);
  const blendedFairValue = totalWeight > 0
    ? available.reduce((sum, [k, v]) => sum + v * (METHOD_WEIGHTS[k] || 0), 0) / totalWeight
    : median(available.map(([, v]) => v)); // fallback if weights are somehow all zero

  const values = available.map(([, v]) => v);
  let agreementScore = 100;
  if (values.length >= 2) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    const coefficientOfVariation = mean > 0 ? stdev / mean : 1;
    agreementScore = Math.round(clamp(100 - coefficientOfVariation * 150, 0, 100));
  }
  return { blendedFairValue, agreementScore, methodCount: values.length };
}

// ---------- Main entry point: valuate one stock given the full universe's exit multiples ----------

function valuateStock(stock, sectorExitMultiples) {
  const growthYear1 = stock.growthYear1;
  const sectorMultiples = sectorExitMultiples[stock.sector] || sectorExitMultiples['Unknown'];

  const { dcf, dcfSBCAdjusted } = dcfMethods(stock, growthYear1);
  const methods = {
    dcf,
    dcfSBCAdjusted,
    revenueExit: revenueExitMethod(stock, growthYear1, sectorMultiples),
    epsExit: epsExitMethod(stock, growthYear1, sectorMultiples),
    ebitdaExit: ebitdaExitMethod(stock, growthYear1, sectorMultiples),
  };
  const { blendedFairValue, agreementScore, methodCount } = combineValuations(methods);

  const currentPrice = stock.price.current;
  const marginOfSafety = blendedFairValue && currentPrice ? (blendedFairValue - currentPrice) / blendedFairValue : null;

  let marketImpliedGrowth = null, marketImpliedGrowthNote = null;
  if (marginOfSafety != null) {
    const last = stock.financials.years[stock.financials.years.length - 1];
    const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
    const impliedResult = solveImpliedGrowth({
      fcfBase: last.fcf, terminalGrowth: 0.025, discountRate: getDiscountRate(stock.sector),
      years: 10, netDebt, sharesOut: last.sharesOutTTM, targetPricePerShare: currentPrice,
    });
    marketImpliedGrowth = impliedResult.impliedGrowth;
    marketImpliedGrowthNote = impliedResult.reason !== 'converged' ? impliedResult.reason : null;
  }

  return {
    methods,
    blendedFairValue,
    agreementScore,
    methodCount,
    marginOfSafety,
    marketImpliedGrowth,
    marketImpliedGrowthNote,
    dilutionRate: estimateDilutionRate(stock),
    sbcIntensity: stock.financials.years[stock.financials.years.length - 1]?.sbcIntensity ?? null,
  };
}

const api = { computeSectorExitMultiples, valuateStock, projectFinancials, estimateDilutionRate, combineValuations };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
