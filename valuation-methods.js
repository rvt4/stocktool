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
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// ---------- Shared multi-year projection ----------

// Projects revenue, EBITDA, FCF, and diluted share count forward `years`, with growth
// fading from growthYear1 down to a medium-term rate, and margins drifting toward the
// company's own recent trend (capped so a single good/bad year can't dominate).
function projectFinancials(stock, growthYear1, years = 5) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const dilutionRate = estimateDilutionRate(stock);
  const mediumTermGrowth = clamp((growthYear1 ?? 0.05) * 0.25, 0.02, 0.08); // decays toward ~25% of its starting rate, capped at 8% — meaningfully closer to DCF's 2.5% terminal assumption than a 35% grower fading only to ~14% would be

  const ebitdaMargins = yrs.slice(-3).map(y => y.ebitda != null && y.revenue ? y.ebitda / y.revenue : null).filter(x => x != null);
  const marginTrend = ebitdaMargins.length >= 2 ? clamp((ebitdaMargins[ebitdaMargins.length - 1] - ebitdaMargins[0]) / (ebitdaMargins.length - 1), -0.03, 0.03) : 0;
  const startMargin = last.ebitda != null && last.revenue ? last.ebitda / last.revenue : 0.10;

  const fcfMargins = yrs.slice(-3).map(y => y.fcf != null && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  const avgFcfConversion = fcfMargins.length ? fcfMargins.reduce((a, b) => a + b, 0) / fcfMargins.length : 0.10;

  // Net margin projected from the company's OWN trailing net margin + trend — the same
  // approach already used for EBITDA. Previously EPS was derived as fcf * 0.75, a flat
  // ratio applied to every stock regardless of its real FCF-to-earnings relationship.
  // For any company where that relationship isn't actually ~0.75 (heavy capex, heavy
  // SBC, early-stage names with real FCF but thin GAAP earnings), that proxy produces
  // a fictional EPS — which is what fed a nonsensically low P/E-based exit value even
  // while the FCF-based DCF looked reasonable for the same company.
  const netMargins = yrs.slice(-3).map(y => y.netIncome != null && y.revenue ? y.netIncome / y.revenue : null).filter(x => x != null);
  const netMarginTrend = netMargins.length >= 2 ? clamp((netMargins[netMargins.length - 1] - netMargins[0]) / (netMargins.length - 1), -0.03, 0.03) : 0;
  const startNetMargin = last.netIncome != null && last.revenue ? last.netIncome / last.revenue : null;

  const projection = [];
  let revenue = last.revenue, shares = last.sharesOutTTM;
  for (let t = 1; t <= years; t++) {
    const g = (growthYear1 ?? mediumTermGrowth) + (mediumTermGrowth - (growthYear1 ?? mediumTermGrowth)) * ((t - 1) / Math.max(1, years - 1));
    revenue = revenue * (1 + g);
    shares = shares * (1 + dilutionRate);
    const margin = clamp(startMargin + marginTrend * t, 0.02, 0.60);
    const ebitda = revenue * margin;
    const fcf = revenue * clamp(avgFcfConversion + marginTrend * t, 0.01, 0.45);
    // Net margin allowed to go negative (unlike EBITDA/FCF margins) — an early-stage or
    // reinvestment-heavy company can be GAAP-unprofitable while still cash-generative;
    // forcing a positive floor would misrepresent exactly the companies where this
    // distinction matters most.
    const netMargin = startNetMargin != null
      ? clamp(startNetMargin + netMarginTrend * t, -0.15, 0.45)
      : clamp(margin * 0.65, -0.15, 0.45); // fallback proxy only if no net income data exists at all
    const netIncome = revenue * netMargin;
    const eps = shares ? netIncome / shares : null;
    projection.push({ year: t, revenue, ebitda, fcf, eps, shares });
  }
  return { projection, dilutionRate, startMargin, marginTrend, mediumTermGrowth };
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

// ---------- Mean reversion for exit multiples ----------

// Assuming today's sector multiple persists unchanged 7 years out overstates fair value
// whenever that multiple is currently elevated — multiples compress toward normal far
// more often, over long horizons, than they stay rich indefinitely. But collapsing every
// stock's exit multiple straight to "sector normal" would punish genuinely elite,
// durably-growing businesses that have earned — and can plausibly sustain — a premium.
//
// Approach: blend TODAY's sector multiple with a REVERSION TARGET (this specific stock's
// own long-run historical multiple, if we have it — reverting toward what the market has
// actually been willing to pay for THIS business is more grounded than reverting toward
// a generic sector-wide number that mixes in every quality tier). How much of the gap
// between today's multiple and that target survives into the exit year is set by a 0-1
// quality score built from ROIC and growth durability: highly profitable, durably-growing
// businesses keep most of their premium; everyone else reverts most of the way toward
// their own normal.
function qualityPremiumWeight(avgRoic, growthYear1) {
  const roicScore = clamp(((avgRoic ?? 0.08) - 0.08) / (0.30 - 0.08), 0, 1);       // 8% ROIC -> 0, 30%+ -> 1
  const growthScore = clamp(((growthYear1 ?? 0.05) - 0.05) / (0.25 - 0.05), 0, 1); // 5% growth -> 0, 25%+ -> 1
  const quality = roicScore * 0.6 + growthScore * 0.4;
  // Even the very best businesses see SOME multiple compression over a 7-year horizon
  // (cycles, competition, the arithmetic of getting larger); even weak businesses retain
  // some of today's multiple rather than snapping instantly to a textbook average. Floor
  // and ceiling keep the blend from ever being "no reversion" or "total reversion."
  return clamp(0.30 + quality * 0.55, 0.30, 0.85); // fraction of (current - target) retained
}

function meanRevertedMultiple(currentMultiple, ownHistoricalMultiples, avgRoic, growthYear1) {
  if (currentMultiple == null) return { multiple: null, target: null, weight: null };
  const historicalMedian = ownHistoricalMultiples?.length ? median(ownHistoricalMultiples) : null;
  // No historical benchmark for this specific stock (e.g. recent IPO) — nothing sound to
  // revert toward, so fall back to the un-reverted current multiple rather than guessing.
  const target = historicalMedian ?? currentMultiple;
  const weight = qualityPremiumWeight(avgRoic, growthYear1);
  const multiple = target + weight * (currentMultiple - target);
  return { multiple, target, weight };
}

// ---------- Valuation methods ----------

// Method 1: DCF, using FCF (the existing conservative-clamped estimateFairValue logic).
// Also runs an SBC-adjusted variant that treats SBC as a real economic cost.
//
// growthYear1 arrives HERE already clamped to [-0.10, 0.35] by valuateStock — the same
// clamped value every other method receives (see note there). This function no longer
// clamps independently; it just uses what it's given.
function dcfMethods(stock, growthYear1, years = 5) {
  const yrs = stock.financials.years;
  const last = yrs[yrs.length - 1];
  const discountRate = getDiscountRate(stock.sector);
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);

  // Smooth the FCF base over the last up-to-3 years (weighted toward the most recent)
  // instead of anchoring to a single year. A single depressed year — e.g. a heavy
  // capex/AI-infrastructure buildout year — otherwise crushes the DCF fair value while
  // EBITDA-based exit multiples (which aren't hit by capex) look normal. That mismatch
  // is exactly the pattern showing up as DCF-lowest / EV-EBITDA-highest on large,
  // capital-intensive compounders.
  const fcfBase = smoothedBase(yrs, y => y.fcf) ?? last.fcf;
  const sbcAdjustedBase = smoothedBase(yrs, y => y.fcfSBCAdjusted) ?? last.fcfSBCAdjusted;

  // years=5 passed explicitly so DCF projects over the SAME horizon as the exit-multiple
  // methods below — see the note in valuateStock for the dcf.js-side change this requires.
  const standard = reverseDCF({ fcfBase, growthYear1, discountRate, netDebt, sharesOut: last.sharesOutTTM, years });
  const sbcAdjusted = sbcAdjustedBase != null
    ? reverseDCF({ fcfBase: sbcAdjustedBase, growthYear1, discountRate, netDebt, sharesOut: last.sharesOutTTM, years })
    : { fairValuePerShare: null };

  return {
    dcf: standard.fairValuePerShare ?? null,
    dcfSBCAdjusted: sbcAdjusted.fairValuePerShare ?? null,
  };
}

// Weighted 3-year average of a per-year metric (most recent year weighted heaviest),
// falling back gracefully as fewer years are available. Reduces the influence of any
// single one-off year (capex spike, a working-capital swing, a bad quarter) on a value
// that then gets compounded forward for a decade.
function smoothedBase(yrs, getter) {
  const recent = yrs.slice(-3).map(getter).filter(x => x != null);
  if (!recent.length) return null;
  if (recent.length === 1) return recent[0];
  const weights = recent.length === 3 ? [0.2, 0.3, 0.5] : [0.4, 0.6];
  return recent.reduce((sum, v, i) => sum + v * weights[i], 0);
}

// Method 2: Revenue exit multiple. Projects revenue N years out, applies the sector's
// current median EV/Revenue as the assumed exit multiple, discounts back, adds PV of
// interim dividends (not retained FCF — that's already reflected in the higher exit
// value, so adding it too would double-count).
function revenueExitMethod(stock, growthYear1, sectorMultiples, years = 5) {
  const rawMultiple = sectorMultiples?.evRevenue;
  if (!rawMultiple) return null;
  const { projection, mediumTermGrowth } = projectFinancials(stock, growthYear1, years);
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
  // Use mediumTermGrowth (what growth has decayed TO by the exit year), not growthYear1
  // (today's peak rate). A rich multiple justified by today's 30%+ growth doesn't
  // transfer to year 5 once that growth has already faded toward its medium-term rate —
  // applying today's growth-implied premium to a company that's since decelerated is
  // exactly what was inflating every exit-multiple value even after horizon alignment.
  const { multiple: exitMultiple } = meanRevertedMultiple(
    rawMultiple, stock.historicalMultiples?.evRevenue, avgRoic, mediumTermGrowth
  );
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
function epsExitMethod(stock, growthYear1, sectorMultiples, years = 5) {
  const rawMultiple = sectorMultiples?.pe;
  if (!rawMultiple) return null;
  const { projection, mediumTermGrowth } = projectFinancials(stock, growthYear1, years);
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
  const { multiple: exitMultiple } = meanRevertedMultiple(
    rawMultiple, stock.historicalMultiples?.forwardPe, avgRoic, mediumTermGrowth
  );
  const exitYear = projection[projection.length - 1];
  if (exitYear.eps == null || exitYear.eps <= 0) return null; // P/E is meaningless on negative earnings

  const exitPricePerShare = exitYear.eps * exitMultiple;
  const discountRate = getDiscountRate(stock.sector);
  const pvExitPrice = exitPricePerShare / Math.pow(1 + discountRate, years);
  const pvDividends = pvDividendStream(stock, years, discountRate);
  return pvExitPrice + pvDividends;
}

// Method 4: EV/EBITDA exit multiple.
function ebitdaExitMethod(stock, growthYear1, sectorMultiples, years = 5) {
  const rawMultiple = sectorMultiples?.evEbitda;
  if (!rawMultiple) return null;
  const { projection, mediumTermGrowth } = projectFinancials(stock, growthYear1, years);
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
  const { multiple: exitMultiple } = meanRevertedMultiple(
    rawMultiple, stock.historicalMultiples?.evEbitda, avgRoic, mediumTermGrowth
  );
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

// ---------- Explicit 5-year price-target CAGR ----------

// A direct, auditable answer to "what CAGR does this imply over the next 5 years" —
// project revenue/EBITDA/EPS 5 years out, apply the SAME mean-reverted exit multiples
// as the methods above, and take the CAGR from today's price to that undiscounted
// year-5 value (plus dividends collected along the way, added simply rather than
// reinvested). Deliberately simpler than blendedFairValue: one horizon, one number,
// every step from today's price to the year-5 answer is visible and checkable by hand.
function fiveYearPriceTargetCAGR(stock, growthYear1, sectorMultiples) {
  const years = 5;
  const currentPrice = stock.price.current;
  if (!currentPrice) return { cagr: null, exitPrice: null, methodsUsed: 0 };

  const { projection, mediumTermGrowth } = projectFinancials(stock, growthYear1, years);
  const exitYear = projection[projection.length - 1];
  const last = stock.financials.years[stock.financials.years.length - 1];
  const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
  const avgRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));

  const exitPrices = [];
  if (sectorMultiples?.evRevenue && exitYear.shares) {
    const { multiple } = meanRevertedMultiple(sectorMultiples.evRevenue, stock.historicalMultiples?.evRevenue, avgRoic, mediumTermGrowth);
    const price = (exitYear.revenue * multiple - netDebt) / exitYear.shares;
    if (price > 0) exitPrices.push(price);
  }
  if (sectorMultiples?.evEbitda && exitYear.shares) {
    const { multiple } = meanRevertedMultiple(sectorMultiples.evEbitda, stock.historicalMultiples?.evEbitda, avgRoic, mediumTermGrowth);
    const price = (exitYear.ebitda * multiple - netDebt) / exitYear.shares;
    if (price > 0) exitPrices.push(price);
  }
  if (sectorMultiples?.pe && exitYear.eps > 0) {
    const { multiple } = meanRevertedMultiple(sectorMultiples.pe, stock.historicalMultiples?.forwardPe, avgRoic, mediumTermGrowth);
    const price = exitYear.eps * multiple;
    if (price > 0) exitPrices.push(price);
  }
  if (!exitPrices.length) return { cagr: null, exitPrice: null, methodsUsed: 0 };

  const exitPrice = mean(exitPrices);
  const divYield = stock.valuation.dividendYield || 0;
  const dividendsReceived = divYield * currentPrice * years; // simple, non-reinvested approximation
  const totalFutureValue = exitPrice + dividendsReceived;
  const cagr = Math.pow(totalFutureValue / currentPrice, 1 / years) - 1;
  return { cagr, exitPrice, dividendsReceived, methodsUsed: exitPrices.length };
}

function valuateStock(stock, sectorExitMultiples) {
  // Clamp ONCE, here, and hand the same value to every method. Previously dcfMethods
  // clamped growthYear1 to [-10%, 35%] internally, but revenueExit/epsExit/ebitdaExit
  // received the raw, unclamped value straight from upstream (which can run as high as
  // 60% — see scoring-engine's blended growth clamp) and compounded it for 5 years
  // before applying today's sector multiple. That asymmetry alone — not just "methods
  // naturally disagree" — is a structural reason exit-multiple methods have been running
  // systematically higher than DCF, especially on higher-growth-estimate names.
  const rawGrowthYear1 = stock.growthYear1;
  const growthYear1 = rawGrowthYear1 != null ? clamp(rawGrowthYear1, -0.10, 0.35) : rawGrowthYear1;
  const sectorMultiples = sectorExitMultiples[stock.sector] || sectorExitMultiples['Unknown'];

  const { dcf, dcfSBCAdjusted } = dcfMethods(stock, growthYear1);
  const rawExitMethods = {
    revenueExit: revenueExitMethod(stock, growthYear1, sectorMultiples),
    epsExit: epsExitMethod(stock, growthYear1, sectorMultiples),
    ebitdaExit: ebitdaExitMethod(stock, growthYear1, sectorMultiples),
  };

  // GUARDRAIL: historicalMultiples (data-fetchers.js) is currently always empty for
  // every stock — the "backfill from priceHistory" it depends on was never implemented.
  // That silently disables meanRevertedMultiple's reversion entirely (target always
  // collapses to today's raw sector multiple, see the comment there), so every
  // exit-multiple method right now applies an un-reverted, often ill-fitting sector-wide
  // multiple to whatever business it's valuing — no correction for how well that sector
  // number actually fits THIS stock (e.g. a low-margin insurer getting a biotech-heavy
  // "Healthcare" sector's EV/Revenue multiple). Until the real backfill exists, treat any
  // exit-multiple result that lands wildly far from the DCF anchor — which doesn't depend
  // on a peer multiple at all — as more likely a sector-multiple mismatch than a genuine
  // second opinion, and exclude it from the blend rather than average it in uncritically.
  const OUTLIER_MULTIPLE = 3;
  const dcfValues = [dcf, dcfSBCAdjusted].filter(v => v != null && v > 0);
  const dcfAnchor = dcfValues.length ? mean(dcfValues) : null;

  const outlierFlags = [];
  const methods = { dcf, dcfSBCAdjusted };
  for (const [key, value] of Object.entries(rawExitMethods)) {
    if (value != null && dcfAnchor != null && (value > dcfAnchor * OUTLIER_MULTIPLE || value < dcfAnchor / OUTLIER_MULTIPLE)) {
      outlierFlags.push({ method: key, value, dcfAnchor, reason: 'exit_multiple_outlier_vs_dcf' });
      methods[key] = null; // excluded from the blend; raw value still returned below for transparency
    } else {
      methods[key] = value;
    }
  }

  const { blendedFairValue, agreementScore, methodCount } = combineValuations(methods);

  // Surfaced for transparency (e.g. a "why" detail panel): how much of today's multiple
  // premium this stock's quality score let it retain, 0.30 (mostly reverted to its own
  // historical normal) to 0.85 (mostly kept today's rich multiple).
  const avgRoicForQuality = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
  const qualityPremiumRetained = qualityPremiumWeight(avgRoicForQuality, growthYear1);

  const currentPrice = stock.price.current;
  const marginOfSafety = blendedFairValue && currentPrice ? (blendedFairValue - currentPrice) / blendedFairValue : null;

  // A direct, auditable answer to "what CAGR does this imply over the next 5 years,"
  // separate from the discounted, weighted blendedFairValue above. One horizon (5yr,
  // matching every method now), one undiscounted exit-price calculation, dividends
  // added simply rather than reinvested — every step visible end to end.
  const fiveYearPriceTarget = fiveYearPriceTargetCAGR(stock, growthYear1, sectorMultiples);

  let marketImpliedGrowth = null, marketImpliedGrowthNote = null;
  if (marginOfSafety != null) {
    const last = stock.financials.years[stock.financials.years.length - 1];
    const netDebt = (last.longTermDebt || 0) - (last.cash || 0);
    // years: 10 here — deliberately NOT matched to the 5-year horizon the other methods
    // use. This metric answers "what does the market need to believe, full stop" —
    // a richly-priced durable compounder's valuation is normally justified by growth
    // spread across 10-15 years, not compressed into 5. Forcing a 5-year window here
    // made every richly-valued stock's implied growth read as an absurd, uninformative
    // ">150%/yr" — that was the wrong fix. Method-comparison horizons and "what's the
    // market pricing in" horizons are different questions and don't need to match.
    const impliedResult = solveImpliedGrowth({
      fcfBase: last.fcf, terminalGrowth: 0.025, discountRate: getDiscountRate(stock.sector),
      years: 10, netDebt, sharesOut: last.sharesOutTTM, targetPricePerShare: currentPrice,
    });
    marketImpliedGrowth = impliedResult.impliedGrowth;
    marketImpliedGrowthNote = impliedResult.reason !== 'converged' ? impliedResult.reason : null;
  }

  return {
    methods: { dcf, dcfSBCAdjusted, ...rawExitMethods }, // raw values for display — unfiltered, even excluded ones
    outlierFlags, // which of the above (if any) were excluded from blendedFairValue and why
    blendedFairValue,
    agreementScore,
    methodCount,
    qualityPremiumRetained,
    marginOfSafety,
    fiveYearPriceTarget,
    marketImpliedGrowth,
    marketImpliedGrowthNote,
    dilutionRate: estimateDilutionRate(stock),
    sbcIntensity: stock.financials.years[stock.financials.years.length - 1]?.sbcIntensity ?? null,
  };
}

const api = { computeSectorExitMultiples, valuateStock, projectFinancials, estimateDilutionRate, combineValuations, meanRevertedMultiple, qualityPremiumWeight, fiveYearPriceTargetCAGR };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
