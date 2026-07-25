/**
 * FreeScreener Scoring Engine
 * Category-first, sector-relative, pricing-power-aware stock scoring.
 * Works in Node (nightly job) and browser (frontend) — no dependencies.
 *
 * INPUT SHAPE expected per stock (see data-fetchers.js for how this gets built):
 * {
 *   ticker, sector,
 *   financials: { years: [ {year, revenue, netIncome, fcf, grossMargin, opMargin,
 *                           roic, sharesOutTTM, eps, dividendPerShare, ebitda,
 *                           inventoryTurnover, debtToEbitda} ... ] }, // oldest->newest, ~10yrs if available
 *   valuation: { pe, forwardPe, evEbitda, evFcf, fcfYield, marketCap, ev },
 *   price: { current },
 *   quarterly: [ {quarter, revenue, grossMargin, unitsGrowth (optional), inventoryTurnover} ... ], // last 8 qtrs
 *   earningsCallText: "..." // optional, concatenated recent transcripts
 * }
 */

// ---------- Utilities ----------

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}
function cagr(first, last, years) {
  if (first == null || last == null || first <= 0 || years <= 0) return null;
  return Math.pow(last / first, 1 / years) - 1;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
// Map a raw value to 0-100 using a sigmoid-ish clamp around a target
function scoreBand(value, poor, excellent) {
  if (value == null) return 50; // neutral if unknown
  const t = clamp((value - poor) / (excellent - poor), 0, 1);
  return Math.round(t * 100);
}

// ---------- 1. Category Classification (do this FIRST) ----------

function classifyCategory(stock) {
  const yrs = stock.financials.years;
  if (!yrs || yrs.length < 3) return 'Unknown';
  const last = yrs[yrs.length - 1];
  const first3ago = yrs[Math.max(0, yrs.length - 4)];
  const revCagr3y = cagr(first3ago.revenue, last.revenue, Math.min(3, yrs.length - 1));
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(x => x != null));
  const divYield = stock.valuation.dividendYield || 0;
  const fcfPayout = last.dividendPerShare && last.fcf && last.sharesOutTTM
    ? (last.dividendPerShare * last.sharesOutTTM) / last.fcf : null;

  // Turnaround: recent earnings/margin inflection after a down period
  const marginsLast2 = yrs.slice(-2).map(y => y.grossMargin);
  const marginInflecting = marginsLast2.length === 2 && marginsLast2[1] > marginsLast2[0];
  const revDeclinedEarlier = yrs.length >= 4 && yrs[yrs.length - 3].revenue < yrs[yrs.length - 4].revenue;

  if (revDeclinedEarlier && marginInflecting && revCagr3y != null && revCagr3y > -0.05) {
    return 'Turnaround';
  }
  if (avgRoic != null && avgRoic > 0.15 && revCagr3y != null && revCagr3y > 0.08) {
    return 'Compounder';
  }
  if (revCagr3y != null && revCagr3y > 0.15) {
    return 'Growth';
  }
  if (divYield > 0.02 && fcfPayout != null && fcfPayout < 0.75) {
    return 'Dividend';
  }
  return 'Value';
}

// ---------- 2. Category-Specific Sub-Scores ----------

const CATEGORY_METRICS = {
  Compounder: (s) => {
    const yrs = s.financials.years;
    const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(x => x != null));
    const roicScore = scoreBand(avgRoic, 0.08, 0.30);
    const grossMargins = yrs.slice(-5).map(y => y.grossMargin).filter(x => x != null);
    const marginStability = grossMargins.length > 1 ? 100 - clamp((stdev(grossMargins) || 0) * 1000, 0, 100) : 50;
    const reinvestRate = s.reinvestmentRate != null ? scoreBand(s.reinvestmentRate, 0.1, 0.6) : 50;
    return { roicScore, marginStability, reinvestRate,
      composite: Math.round(roicScore * 0.5 + marginStability * 0.25 + reinvestRate * 0.25) };
  },
  Growth: (s) => {
    const yrs = s.financials.years;
    const last = yrs[yrs.length - 1], first = yrs[Math.max(0, yrs.length - 4)];
    const revCagr = cagr(first.revenue, last.revenue, Math.min(3, yrs.length - 1));
    const revScore = scoreBand(revCagr, 0.05, 0.35);
    const fcfMargins = yrs.slice(-3).map(y => y.fcf && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
    const fcfExpanding = fcfMargins.length >= 2 && (fcfMargins[fcfMargins.length - 1] - fcfMargins[0]);
    const fcfExpansionScore = scoreBand(fcfExpanding, -0.02, 0.10);
    const ruleOf40 = (revCagr || 0) * 100 + (fcfMargins.length ? fcfMargins[fcfMargins.length - 1] * 100 : 0);
    const ruleOf40Score = scoreBand(ruleOf40, 20, 60);
    return { revScore, fcfExpansionScore, ruleOf40Score,
      composite: Math.round(revScore * 0.4 + fcfExpansionScore * 0.3 + ruleOf40Score * 0.3) };
  },
  Value: (s) => valueTurnaroundScore(s),
  Turnaround: (s) => valueTurnaroundScore(s),
  Dividend: (s) => {
    const yrs = s.financials.years;
    const last = yrs[yrs.length - 1];
    const fcfPayout = last.dividendPerShare && last.fcf && last.sharesOutTTM
      ? (last.dividendPerShare * last.sharesOutTTM) / last.fcf : null;
    const payoutScore = fcfPayout != null ? 100 - scoreBand(fcfPayout, 0.4, 1.0) : 50;
    const divHistory = yrs.slice(-5).map(y => y.dividendPerShare).filter(x => x != null);
    const divCagr = divHistory.length >= 2 ? cagr(divHistory[0], divHistory[divHistory.length - 1], divHistory.length - 1) : null;
    const divCagrScore = scoreBand(divCagr, 0.0, 0.12);
    const debtToEbitda = last.debtToEbitda;
    const leverageScore = debtToEbitda != null ? 100 - scoreBand(debtToEbitda, 1.5, 4.0) : 50;
    return { payoutScore, divCagrScore, leverageScore,
      composite: Math.round(payoutScore * 0.4 + divCagrScore * 0.35 + leverageScore * 0.25) };
  },
};

function valueTurnaroundScore(s) {
  const yrs = s.financials.years;
  const last = yrs[yrs.length - 1];
  // EV/EBITDA vs own 5yr historical median (historical self-comparison)
  const histEvEbitda = s.historicalMultiples?.evEbitda || [];
  const medianEvEbitda = histEvEbitda.length ? median(histEvEbitda) : null;
  const currentEvEbitda = s.valuation.evEbitda;
  const discountToHistory = medianEvEbitda && currentEvEbitda
    ? (medianEvEbitda - currentEvEbitda) / medianEvEbitda : null;
  const discountScore = scoreBand(discountToHistory, -0.2, 0.4);
  const fcfYield = s.valuation.fcfYield;
  const fcfYieldScore = scoreBand(fcfYield, 0.03, 0.10);
  // Piotroski-lite: count positive signals available from our data
  let piotroski = 0;
  if (last.netIncome > 0) piotroski++;
  if (last.fcf > 0) piotroski++;
  if (yrs.length >= 2 && last.roic > yrs[yrs.length - 2].roic) piotroski++;
  if (yrs.length >= 2 && last.grossMargin >= yrs[yrs.length - 2].grossMargin) piotroski++;
  if (last.debtToEbitda != null && yrs.length >= 2 && last.debtToEbitda <= (yrs[yrs.length - 2].debtToEbitda ?? 999)) piotroski++;
  const piotroskiScore = scoreBand(piotroski, 1, 5);
  return { discountScore, fcfYieldScore, piotroskiScore,
    composite: Math.round(discountScore * 0.4 + fcfYieldScore * 0.35 + piotroskiScore * 0.25) };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- 3. Sector-Relative Z-Score Normalization ----------
// Call this AFTER scoring the whole universe, to re-rank within sector.
function applySectorZScores(scoredStocks) {
  // Group by (sector, category) together, not sector alone. Different categories use
  // entirely different scoring formulas (see CATEGORY_METRICS) that aren't on a
  // comparable scale — a Growth stock's Rule-of-40-driven composite score and a Value
  // stock's discount-to-historical-multiple composite score are answering different
  // questions with different typical ranges. Z-scoring them together as if they were
  // the same measurement systematically advantages whichever category's formula tends
  // to score higher, regardless of which stock is actually the better opportunity.
  const groups = {};
  for (const s of scoredStocks) {
    const key = `${s.sector}|${s.category}`;
    (groups[key] = groups[key] || []).push(s);
  }
  for (const key in groups) {
    const group = groups[key];
    const vals = group.map(s => s.categoryComposite);
    const m = mean(vals), sd = stdev(vals) || 1;
    for (const s of group) {
      s.sectorZScore = (s.categoryComposite - m) / sd;
      s.sectorRelativeScore = clamp(Math.round(50 + s.sectorZScore * 15), 0, 100);
      s.comparisonGroupSize = group.length; // small groups make z-scores noisy — surfaced for transparency
    }
  }
  return scoredStocks;
}

// ---------- 4. Pricing Power Score ----------

const PRICING_KEYWORDS = ['pricing', 'price realization', 'elasticity', 'premium products',
  'higher mix', 'increased pricing', 'price increases', 'value-based pricing'];

function scorePricingPower(s) {
  const yrs = s.financials.years;
  if (!yrs || yrs.length < 2) return { score: 50, signals: [] };
  const signals = [];
  let points = 0, maxPoints = 0;

  // Gross margin trend
  maxPoints += 20;
  const gm = yrs.slice(-3).map(y => y.grossMargin).filter(x => x != null);
  if (gm.length >= 2 && gm[gm.length - 1] > gm[0]) { points += 20; signals.push('Gross margin expanding'); }

  // Operating margin stability during inflationary periods (proxy: didn't compress even as revenue grew)
  maxPoints += 15;
  const om = yrs.slice(-3).map(y => y.opMargin).filter(x => x != null);
  if (om.length >= 2 && om[om.length - 1] >= om[0] - 0.01) { points += 15; signals.push('Operating margin resilient'); }

  // Revenue growth vs unit/volume growth (price > volume driven growth)
  maxPoints += 20;
  const q = s.quarterly || [];
  const withUnits = q.filter(x => x.unitsGrowth != null && x.revenue != null);
  if (withUnits.length) {
    const last = withUnits[withUnits.length - 1];
    if (last.revenueGrowth != null && last.unitsGrowth != null && last.revenueGrowth - last.unitsGrowth > 0.03) {
      points += 20; signals.push('Revenue growth outpacing unit growth (price-led)');
    }
  } else { maxPoints -= 20; } // no data available, don't penalize

  // FCF margin expanding
  maxPoints += 15;
  const fcfMargins = yrs.slice(-3).map(y => y.fcf && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  if (fcfMargins.length >= 2 && fcfMargins[fcfMargins.length - 1] > fcfMargins[0]) {
    points += 15; signals.push('FCF margin expanding');
  }

  // Inventory turnover stable/improving while margins expand (not just stuffing channel)
  maxPoints += 10;
  const invTurns = yrs.slice(-2).map(y => y.inventoryTurnover).filter(x => x != null);
  if (invTurns.length === 2 && invTurns[1] >= invTurns[0] * 0.95) {
    points += 10; signals.push('Inventory turnover stable/improving');
  }

  // Earnings call keyword scan (simple free NLP — no paid AI needed)
  maxPoints += 20;
  if (s.earningsCallText) {
    const text = s.earningsCallText.toLowerCase();
    const hits = PRICING_KEYWORDS.filter(k => text.includes(k));
    if (hits.length) {
      const kwScore = clamp(hits.length * 5, 0, 20);
      points += kwScore;
      signals.push(`Earnings call mentions: ${hits.join(', ')}`);
    }
  } else { maxPoints -= 20; }

  const score = maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 50;
  return { score, signals };
}

// ---------- 5. Dynamic Margin of Safety ----------

function dynamicMOS(category, roic) {
  // High-ROIC compounders need less margin of safety; low-quality value/turnaround needs more.
  if (category === 'Compounder' && roic != null) {
    // 25% ROIC -> ~10% MOS ... 15% ROIC -> ~20% MOS
    return clamp(0.35 - roic * 1.0, 0.10, 0.25);
  }
  if (category === 'Growth') return 0.15;
  if (category === 'Dividend') return 0.15;
  if (category === 'Turnaround') return 0.30;
  return 0.20; // Value default
}

// ---------- 6. Expected CAGR Model ----------
// Expected CAGR = Revenue growth x Margin expansion x Share count reduction x Dividend yield x Valuation multiple reversion
function expectedCAGR(s, category) {
  const yrs = s.financials.years;
  const last = yrs[yrs.length - 1];

  // Every component below is clamped to a generous-but-sane band. Raw SEC XBRL
  // data (esp. share counts around splits/offerings, or FCF in a low-revenue year)
  // can produce huge single-year swings that are real but shouldn't be
  // extrapolated forward as a steady annual rate — clamping prevents a single
  // noisy data point from producing a nonsensical -400% or +8000% "expected CAGR".

  const rawRevGrowth = s.analystEstimates?.revenueGrowthFwd
    ?? cagr(yrs[Math.max(0, yrs.length - 4)].revenue, last.revenue, Math.min(3, yrs.length - 1))
    ?? 0.05;
  const forwardRevGrowth = clamp(rawRevGrowth, -0.30, 0.60);

  const margins3y = yrs.slice(-3).map(y => y.fcf && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  const rawMarginExpansion = margins3y.length >= 2
    ? (margins3y[margins3y.length - 1] - margins3y[0]) / Math.max(1, margins3y.length - 1) : 0;
  const marginExpansionAnnualized = clamp(rawMarginExpansion, -0.15, 0.15);

  const shares = yrs.slice(-3).map(y => y.sharesOutTTM).filter(x => x != null);
  const rawShareCountCagr = shares.length >= 2 ? cagr(shares[0], shares[shares.length - 1], shares.length - 1) : 0;
  const shareCountReduction = clamp(rawShareCountCagr != null ? -rawShareCountCagr : 0, -0.20, 0.20);

  const dividendYield = clamp(s.valuation.dividendYield || 0, 0, 0.15);

  // Valuation multiple reversion: expected annualized re-rating toward historical median over ~5yrs
  const histMult = median(s.historicalMultiples?.forwardPe || []);
  const currentMult = s.valuation.forwardPe;
  let multipleReversionAnnualized = 0;
  if (histMult && currentMult) {
    const totalReversion = (histMult - currentMult) / currentMult;
    multipleReversionAnnualized = clamp(totalReversion / 5, -0.10, 0.10); // spread over 5 years
  }

  // Flag results built on noisy inputs so the frontend / you can treat them with
  // appropriately less confidence, rather than silently trusting a clamped-down number.
  const clampedInputs = [
    rawRevGrowth !== forwardRevGrowth,
    rawMarginExpansion !== marginExpansionAnnualized,
    (rawShareCountCagr != null ? -rawShareCountCagr : 0) !== shareCountReduction,
  ].some(Boolean);

  const total = clamp(
    forwardRevGrowth + marginExpansionAnnualized + shareCountReduction + dividendYield + multipleReversionAnnualized,
    -0.50, 1.00 // belt-and-suspenders clamp on the combined total
  );
  return { expectedCAGR: total, lowConfidence: clampedInputs, breakdown: {
    forwardRevGrowth, marginExpansionAnnualized, shareCountReduction, dividendYield, multipleReversionAnnualized
  } };
}

// ---------- 7. Master Scoring Function ----------

function scoreStock(stock) {
  const category = classifyCategory(stock);
  const catFn = CATEGORY_METRICS[category] || CATEGORY_METRICS.Value;
  const catResult = catFn(stock);
  const pricingPower = scorePricingPower(stock);
  const { expectedCAGR: expCagr, breakdown, lowConfidence } = expectedCAGR(stock, category);
  const lastRoic = mean(stock.financials.years.slice(-3).map(y => y.roic).filter(x => x != null));
  const requiredMOS = dynamicMOS(category, lastRoic);

  const currentPrice = stock.price.current;
  const fairValue = stock.valuation.fairValueEstimate; // computed upstream if available
  const rawMarginOfSafety = fairValue ? (fairValue - currentPrice) / fairValue : null;
  // Clamp the *displayed* number — when fair value is small relative to price (common
  // for cyclical/inflecting names where the DCF's trailing-growth input badly
  // undershoots the market's forward view), the raw percentage can swing to
  // meaningless extremes like -400%. The underlying "this is overvalued" signal is
  // still correct at the extremes; the exact magnitude past ±100% isn't meaningful.
  const marginOfSafety = rawMarginOfSafety != null ? clamp(rawMarginOfSafety, -1.0, 1.0) : null;
  const marginOfSafetyDistorted = rawMarginOfSafety != null && rawMarginOfSafety !== marginOfSafety;
  const meetsRequiredMOS = marginOfSafety != null ? marginOfSafety >= requiredMOS : null;

  const meetsCAGRTarget = expCagr >= 0.15;
  const marketImpliedGrowth = stock.valuation.marketImpliedGrowth ?? null;
  const growthGap = marketImpliedGrowth != null ? marketImpliedGrowth - breakdown.forwardRevGrowth : null;

  return {
    ticker: stock.ticker,
    sector: stock.sector,
    category,
    categoryComposite: catResult.composite,
    categoryBreakdown: catResult,
    pricingPowerScore: pricingPower.score,
    pricingPowerSignals: pricingPower.signals,
    expectedCAGR: expCagr,
    lowConfidence,
    cagrBreakdown: breakdown,
    growthSource: stock.valuation.growthSource ?? null,
    marketImpliedGrowth,
    marketImpliedGrowthNote: stock.valuation.marketImpliedGrowthNote ?? null,
    growthGap,
    requiredMOS,
    marginOfSafety,
    marginOfSafetyDistorted,
    meetsRequiredMOS,
    meetsCAGRTarget,
    qualifiesForBuyList: !!(meetsCAGRTarget && meetsRequiredMOS),
    valuationMethods: stock.valuation.valuationMethods ?? null,
    methodAgreementScore: stock.valuation.methodAgreementScore ?? null,
    methodCount: stock.valuation.methodCount ?? 0,
    dilutionRate: stock.valuation.dilutionRate ?? null,
    sbcIntensity: stock.valuation.sbcIntensity ?? null,
  };
}

// ---------- 8. Percentile-Based Rating (apply after scoring full universe) ----------

function applyPercentileRatings(scoredStocks) {
  // Split into stocks that actually clear your bar (CAGR + confirmed MOS) and everyone
  // else. Percentile ranking now happens WITHIN the qualifying pool only, to decide
  // Strong Buy vs Buy — not across the whole 891-stock universe. The previous version
  // required a stock to be BOTH in the global top 15% AND meet the absolute CAGR/MOS
  // thresholds — two independent hard filters stacked together, which is far stricter
  // than either alone and is what collapsed the Buy list down to 2-3 names. A stock that
  // clearly clears your explicit bar shouldn't also have to out-rank hundreds of stocks
  // that don't even qualify.
  const qualifiers = scoredStocks.filter(s => s.qualifiesForBuyList && s.expectedCAGR >= 0);
  const nonQualifiers = scoredStocks.filter(s => !(s.qualifiesForBuyList && s.expectedCAGR >= 0));

  const sortedQualifiers = [...qualifiers].sort((a, b) => b.sectorRelativeScore - a.sectorRelativeScore);
  const qn = sortedQualifiers.length;
  sortedQualifiers.forEach((s, i) => {
    const pct = qn > 0 ? i / qn : 0;
    let rating = pct <= 0.30 ? 'Strong Buy' : 'Buy'; // top 30% of QUALIFIERS, not the whole universe
    // lowConfidence means multiple CAGR inputs hit their sanity clamp simultaneously —
    // a sign the underlying data for this specific stock is broadly unreliable, not
    // just one noisy year. Don't let that produce a Strong Buy / Buy badge.
    if (s.lowConfidence) rating = 'Hold/Watch';
    // If 2+ valuation methods substantially disagree with each other, a confident buy
    // call shouldn't rest on one method's answer when the others say something very
    // different — even though this stock nominally "qualifies" on the blended number.
    if (s.methodCount >= 2 && s.methodAgreementScore != null && s.methodAgreementScore < 40) rating = 'Hold/Watch';
    s.sectorPercentileTier = pct <= 0.30 ? 'Strong Buy' : 'Buy';
    s.rating = rating;
  });

  // Non-qualifiers: rank by sectorRelativeScore to distinguish "reasonable, just short
  // of your bar" (Hold/Watch) from "weak across the board" (Avoid). Negative expected
  // CAGR is always Avoid regardless of rank — never label a negative expected return
  // as merely "watch."
  const sortedNonQualifiers = [...nonQualifiers].sort((a, b) => b.sectorRelativeScore - a.sectorRelativeScore);
  const nqN = sortedNonQualifiers.length;
  sortedNonQualifiers.forEach((s, i) => {
    const pct = nqN > 0 ? i / nqN : 0;
    s.sectorPercentileTier = pct <= 0.65 ? 'Hold/Watch' : 'Avoid';
    s.rating = s.expectedCAGR < 0 ? 'Avoid' : s.sectorPercentileTier;
  });

  return [...sortedQualifiers, ...sortedNonQualifiers];
}

// ---------- Public API ----------

function scoreUniverse(stocks) {
  const scored = stocks.map(scoreStock);
  applySectorZScores(scored);
  return applyPercentileRatings(scored);
}

const api = {
  classifyCategory, scoreStock, scoreUniverse,
  applySectorZScores, applyPercentileRatings,
  scorePricingPower, dynamicMOS, expectedCAGR,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ScoringEngine = api;
