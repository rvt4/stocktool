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
  const yrs = stock.financials?.years || [];
  if (yrs.length < 3) return 'Unknown';
  const last = yrs[yrs.length - 1];
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(x => x != null));
  const divYield = stock.valuation?.dividendYield || 0;

  const histRates = [];
  for (let i = 1; i < yrs.length; i++) {
    if (yrs[i - 1].revenue > 0 && yrs[i].revenue > 0) histRates.push(yrs[i].revenue / yrs[i - 1].revenue - 1);
  }
  const historicalGrowth = histRates.length ? median(histRates.slice(-5)) : null;
  const currentForward = stock.analystEstimates?.revenueGrowthCurrentYear
    ?? stock.analystEstimates?.revenueGrowthFwd
    ?? stock.growthYear1
    ?? historicalGrowth
    ?? 0;
  const nextForward = stock.analystEstimates?.revenueGrowthNextYear ?? currentForward;
  const forwardGrowth = mean([currentForward, nextForward].filter(x => x != null)) ?? 0;

  const opMargins = yrs.slice(-4).map(y => y.opMargin).filter(x => x != null);
  const marginRecovery = opMargins.length >= 2 && opMargins[opMargins.length - 1] > opMargins[0] + 0.015;
  const recentRevenueDecline = yrs.slice(-4).some((y, i, arr) => i > 0 && y.revenue < arr[i - 1].revenue * 0.97);
  const positiveIncomeYears = yrs.slice(-4).filter(y => y.netIncome > 0).length;

  // Category is a business description, not a one-year analyst-growth label.
  // Require persistence and sector fit before assigning Hyper Growth. This prevents
  // acquisitive industrials, financials and staples with a temporary estimate spike
  // from receiving the same underwriting treatment as a durable secular grower.
  const sectorText = [stock.sector, stock.industry, stock.valuation?.industryModel?.model]
    .filter(Boolean).join(' ').toLowerCase();
  const isFinancial = /financial|bank|insurance|credit|capital market|asset management/.test(sectorText);
  const isStaples = /consumer staples|consumer defensive|staples|beverage|food|household/.test(sectorText);
  const positiveFcfRate = yrs.slice(-5).length
    ? yrs.slice(-5).filter(y => Number(y.fcf) > 0).length / yrs.slice(-5).length : 0;
  const historicalMedianGrowth = historicalGrowth ?? 0;
  const bothForwardYearsStrong = currentForward >= 0.20 && nextForward >= 0.18;
  const durableHyperGrowth = forwardGrowth >= 0.22 && bothForwardYearsStrong &&
    historicalMedianGrowth >= 0.10 && positiveFcfRate >= 0.60 && !isFinancial &&
    (!isStaples || historicalMedianGrowth >= 0.16);

  if (durableHyperGrowth) return 'Hyper Growth';
  if (forwardGrowth >= 0.13 && !isFinancial) return 'Growth';
  if (avgRoic != null && avgRoic >= 0.15 && forwardGrowth >= 0.08) return 'Compounder';
  if (recentRevenueDecline && marginRecovery && forwardGrowth < 0.12) return 'Turnaround';
  if (recentRevenueDecline && positiveIncomeYears <= 2 && forwardGrowth < 0.08) return 'Cyclical';
  if (divYield >= 0.025) return 'Dividend';
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
  } else {
    // Software/ad-tech/platform businesses structurally don't report physical unit
    // volumes, so this signal is unreachable for them even though the underlying
    // question — is growth price-led or volume-led — still applies. If ARPU (average
    // revenue per user) is available as a digital-native proxy, use revenue growth vs.
    // ARPU growth the same way hardware/retail names use revenue growth vs. units growth.
    // Falls back to excluding the category (no penalty) if neither is available.
    const withArpu = q.filter(x => x.arpuGrowth != null && x.revenue != null);
    if (withArpu.length) {
      const last = withArpu[withArpu.length - 1];
      if (last.revenueGrowth != null && last.revenueGrowth - last.arpuGrowth > 0.03) {
        points += 20; signals.push('Revenue growth outpacing ARPU growth (price-led)');
      }
    } else {
      maxPoints -= 20; // no unit or ARPU data available — exclude, don't penalize
    }
  }

  // FCF margin expanding
  maxPoints += 15;
  const fcfMargins = yrs.slice(-3).map(y => y.fcf && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  if (fcfMargins.length >= 2 && fcfMargins[fcfMargins.length - 1] > fcfMargins[0]) {
    points += 15; signals.push('FCF margin expanding');
  }

  // Inventory turnover stable/improving while margins expand (not just stuffing channel).
  // Only counts toward the denominator when inventory data actually exists — asset-light
  // businesses (software, ad-tech, services) structurally carry no inventory, and
  // previously this 10-point category stayed in maxPoints even for them, silently
  // capping their achievable score below companies that happen to sell physical goods.
  const invTurns = yrs.slice(-2).map(y => y.inventoryTurnover).filter(x => x != null);
  if (invTurns.length === 2) {
    maxPoints += 10;
    if (invTurns[1] >= invTurns[0] * 0.95) {
      points += 10; signals.push('Inventory turnover stable/improving');
    }
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
  if (category === 'Hyper Growth') return 0.20;
  if (category === 'Growth') return 0.15;
  if (category === 'Dividend') return 0.15;
  if (category === 'Turnaround') return 0.30;
  if (category === 'Cyclical') return 0.30;
  return 0.20; // Value default
}

// ---------- 6. Expected CAGR Model ----------

// Blends up to 4 independent growth signals instead of leaning on a single source.
// Pure analyst-estimate-or-fallback lets one optimistic analyst on a thin-coverage
// name (small caps especially — BMNR, FRHC, CRDO-type names) become the ENTIRE growth
// assumption. Blending means no single input can single-handedly produce a 60-95%
// "expected CAGR" — it gets pulled back toward the other, typically more conservative,
// signals. Weights favor analyst estimates (most forward-looking) but meaningfully
// discount them with historical reality, internally-financeable growth, and what the
// market is already pricing in.
// Median of year-over-year revenue growth rates, rather than a 2-point CAGR between
// the oldest and newest year. A straight CAGR(start, end) rests entirely on whichever
// single year happens to be the start point — if that year was a cyclical trough (a bad
// underwriting year for an insurer, a demand air-pocket for an industrial/trucker), the
// resulting "3yr CAGR" can look like 40-60% for an otherwise perfectly ordinary mature
// business, purely as an artifact of the low anchor. The median of individual YoY growth
// rates uses every year's information and isn't dominated by any single distorted one.
function robustHistoricalGrowth(yrs) {
  const yoyRates = [];
  for (let i = 1; i < yrs.length; i++) {
    const prev = yrs[i - 1].revenue, curr = yrs[i].revenue;
    if (prev != null && curr != null && prev > 0) yoyRates.push(curr / prev - 1);
  }
  const recentRates = yoyRates.slice(-5); // up to the last 5 YoY readings
  if (!recentRates.length) return null;
  const sorted = [...recentRates].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function blendedRevenueGrowth(s, yrs, last) {
  const analystG = s.analystEstimates?.revenueGrowthFwd ?? null;
  const historicalG = robustHistoricalGrowth(yrs);
  // Kept only for the confidence-score distortion check below — NOT used in the blend.
  const naiveCagr = cagr(yrs[Math.max(0, yrs.length - 4)].revenue, last.revenue, Math.min(3, yrs.length - 1));

  // Reinvestment-capacity-implied growth: a Gordon-growth-style ceiling on how fast a
  // business can plausibly grow itself. ROIC x reinvestment rate ≈ the sustainable
  // organic growth rate fundable from internally generated returns — independent of
  // what any analyst is modeling. A company earning 20% ROIC reinvesting half its
  // earnings can sustainably compound ~10%/yr from its own economics.
  const avgRoic = mean(yrs.slice(-3).map(y => y.roic).filter(x => x != null));
  const reinvestRate = s.reinvestmentRate != null ? clamp(s.reinvestmentRate, 0, 1) : 0.4;
  // Cap the ROIC INPUT (not just the output) before multiplying. Asset-light compounders
  // can post 50-90%+ ROIC that's real but not indicative of a sustainable reinvestment
  // opportunity at that scale — capital gets harder to deploy at the same return as a
  // business grows. Without this cap, exactly the highest-quality names quietly re-inflate
  // their own growth estimate through this "objective" ROIC-based channel.
  const cappedRoicForGrowth = avgRoic != null ? clamp(avgRoic, 0, 0.35) : null;
  const reinvestG = cappedRoicForGrowth != null ? clamp(cappedRoicForGrowth * reinvestRate, -0.10, 0.25) : null;

  const marketImpliedG = s.valuation.marketImpliedGrowth ?? null;

  // V41: forward-first blend. Historical growth remains a reality check, but no
  // longer gets enough weight to bury high-quality businesses at an inflection.
  // Market-implied growth is deliberately capped and treated as a constraint—not a
  // forecast—so expensive stocks cannot justify themselves through their own price.
  const cappedMarketImplied = marketImpliedG == null ? null : clamp(marketImpliedG, -0.10, 0.35);
  const components = [
    { key: 'analyst', value: analystG, weight: 0.35 },
    { key: 'historical', value: historicalG, weight: 0.20 },
    { key: 'reinvestment', value: reinvestG, weight: 0.25 },
    { key: 'marketImplied', value: cappedMarketImplied, weight: 0.20 },
  ].filter(c => c.value != null);

  if (!components.length) return { blended: 0.05, sourcesUsed: 0, sourcesAvailable: [] };

  // Re-normalize weights across whatever's actually available, rather than diluting
  // toward zero when a source is missing.
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const blended = components.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight;
  // How much a naive 2-point CAGR would have diverged from the robust median — a large
  // gap is the signature of a cyclical trough base year distorting the historical
  // growth read, even though it's no longer what actually feeds the blend.
  const cagrDistortion = naiveCagr != null && historicalG != null ? Math.abs(naiveCagr - historicalG) : null;
  return { blended, sourcesUsed: components.length, sourcesAvailable: components.map(c => c.key), cagrDistortion };
}

// Expected CAGR = Revenue growth x Margin expansion x Share count reduction x Dividend yield x Valuation multiple reversion
function expectedCAGR(s, category) {
  const yrs = s.financials.years;
  const last = yrs[yrs.length - 1];

  // Every component below is clamped to a generous-but-sane band. Raw SEC XBRL
  // data (esp. share counts around splits/offerings, or FCF in a low-revenue year)
  // can produce huge single-year swings that are real but shouldn't be
  // extrapolated forward as a steady annual rate — clamping prevents a single
  // noisy data point from producing a nonsensical -400% or +8000% "expected CAGR".

  const { blended: rawRevGrowth, sourcesUsed: revGrowthSources, sourcesAvailable: revGrowthSourcesUsed, cagrDistortion } =
    blendedRevenueGrowth(s, yrs, last);
  const forwardRevGrowth = clamp(rawRevGrowth, -0.30, 0.60);

  const margins3y = yrs.slice(-3).map(y => y.fcf && y.revenue ? y.fcf / y.revenue : null).filter(x => x != null);
  const rawMarginExpansion = margins3y.length >= 2
    ? (margins3y[margins3y.length - 1] - margins3y[0]) / Math.max(1, margins3y.length - 1) : 0;
  const marginExpansionAnnualized = clamp(rawMarginExpansion, -0.15, 0.15);

  const shares = yrs.slice(-3).map(y => y.sharesOutTTM).filter(x => x != null);
  const rawShareCountCagr = shares.length >= 2 ? cagr(shares[0], shares[shares.length - 1], shares.length - 1) : 0;
  const shareCountReduction = clamp(rawShareCountCagr != null ? -rawShareCountCagr : 0, -0.20, 0.20);

  const dividendYield = clamp(s.valuation.dividendYield || 0, 0, 0.15);

  // NOTE: "multiple reversion" used to live here, comparing the stock's OWN historical
  // forward P/E band to its current forward P/E. That's a self-referential check — it
  // reads ~0% whenever a stock is trading in line with its own history, even when it's
  // badly overvalued relative to intrinsic (DCF/exit-multiple) fair value. That's how a
  // stock like AMD could show a high "Expected CAGR" while every valuation method in
  // valuation-methods.js said it was trading well above blended fair value: this
  // function never saw that gap.
  //
  // Removed entirely. This function now answers a narrower, deliberately price-agnostic
  // question: how fast does the business's own per-share economic value compound,
  // regardless of what you pay for it. The real "what do I actually earn from today's
  // price" answer lives in fiveYearPriceTargetCAGR() (valuation-methods.js), which
  // starts at current price and converges to a mean-reverted sector exit multiple —
  // surfaced as `expectedReturn` in scoreStock() below.

  // Flag results built on noisy inputs so the frontend / you can treat them with
  // appropriately less confidence, rather than silently trusting a clamped-down number.
  const clampedInputs = [
    rawRevGrowth !== forwardRevGrowth,
    rawMarginExpansion !== marginExpansionAnnualized,
    (rawShareCountCagr != null ? -rawShareCountCagr : 0) !== shareCountReduction,
  ].some(Boolean);

  // Sustainable per-share value growth is not the simple sum of every favorable
  // input. Revenue growth carries most of the economics; margin expansion, buybacks,
  // and dividends are incremental contributors whose persistence is much lower.
  // This prevents temporary estimate spikes (KDP-like cases) from producing 30%+
  // fundamental CAGRs and prevents financials from being treated like asset-light SaaS.
  const sector = String(s.sector || '');
  const isFinancial = /financial/i.test(sector);
  const isStaples = /consumer staples/i.test(sector);
  const isCyclical = category === 'Cyclical' || /energy|materials/i.test(sector);
  const positiveFcfRate = yrs.length
    ? yrs.slice(-5).filter(y => Number(y.fcf) > 0).length / Math.min(5, yrs.length)
    : 0.5;
  const roics = yrs.slice(-5).map(y => y.roic).filter(Number.isFinite);
  const avgRoic = mean(roics);
  const normalizedRoic = avgRoic == null ? 0.10 : (Math.abs(avgRoic) > 2 ? avgRoic / 100 : avgRoic);
  const durabilitySignal = clamp(
    0.45 * clamp((normalizedRoic - 0.05) / 0.25, 0, 1) +
    0.35 * positiveFcfRate +
    0.20 * clamp((s.valuation?.compounder?.score ?? 50) / 100, 0, 1),
    0, 1
  );

  const organicGrowth = forwardRevGrowth;
  const marginContribution = clamp(marginExpansionAnnualized * 0.45, -0.05, 0.05);
  const capitalReturnContribution = clamp(shareCountReduction, -0.08, 0.06) + dividendYield;
  const rawFundamentalGrowth = organicGrowth + marginContribution + capitalReturnContribution;

  let baseCap = category === 'Hyper Growth' ? 0.24
    : category === 'Growth' ? 0.20
    : category === 'Compounder' ? 0.18
    : category === 'Dividend' ? 0.14
    : category === 'Value' ? 0.15
    : category === 'Turnaround' ? 0.14
    : 0.13;
  // Elite economics can earn a modestly higher cap; weak durability lowers it.
  baseCap += (durabilitySignal - 0.55) * 0.08;
  if (isFinancial) baseCap = Math.min(baseCap, 0.16);
  if (isStaples) baseCap = Math.min(baseCap, 0.145);
  if (isCyclical) baseCap = Math.min(baseCap, 0.13);
  const sustainableCap = clamp(baseCap, 0.09, 0.25);
  const total = clamp(rawFundamentalGrowth, -0.35, sustainableCap);
  const sustainabilityCapped = rawFundamentalGrowth > sustainableCap + 1e-9;

  return { fundamentalGrowthRate: total, lowConfidence: clampedInputs || sustainabilityCapped, revGrowthSources, revGrowthSourcesUsed, cagrDistortion, breakdown: {
    forwardRevGrowth, marginExpansionAnnualized, marginContribution,
    shareCountReduction, dividendYield, rawFundamentalGrowth,
    sustainableCap, durabilitySignal, sustainabilityCapped
  } };
}

// ---------- 6b. Confidence Score ----------
// Turns the scattered reliability signals we already compute (thin history, missing
// analyst data, single-method valuation, method disagreement, cyclicality, negative
// FCF, heavy SBC, single-source growth) into one visible 0-100 score with itemized
// deductions, instead of a single opaque lowConfidence boolean. This is what should
// actually gate a Strong Buy — a stock can clear the CAGR/MOS bar on paper and still
// be resting on data too thin to trust.
function computeConfidenceScore(s, category, revGrowthSources, methodAgreementScore, methodCount, growthGap, marginOfSafetyDistorted, cagrDistortion) {
  const yrs = s.financials.years || [];
  const last = yrs[yrs.length - 1] || {};
  let score = 100;
  const deductions = [];

  const ded = (points, reason) => { score -= points; deductions.push({ points, reason }); };

  const yearsOfHistory = yrs.length;
  if (yearsOfHistory < 5) ded(15, `Only ${yearsOfHistory} year(s) of financial history`);

  // NOTE: previously docked -10 for "no analyst estimates available." Removed — with
  // the current FMP free-tier data source, this fires on essentially every stock
  // (AMZN and META included), which means it isn't measuring anything about THIS
  // stock's reliability specifically; it's a permanent, universal tax that just lowers
  // every confidence score by the same amount for no differentiating reason. If a paid
  // tier or alternate analyst-estimate source gets added later, this is worth
  // reinstating as a real per-stock signal.

  if (methodCount <= 1) {
    ded(15, `Only ${methodCount} valuation method produced a value`);
  } else if (methodAgreementScore != null) {
    // Continuous scaling instead of a hard "< 40" cliff — an agreement score of 39 and
    // one of 42 reflect basically the same amount of disagreement between methods and
    // shouldn't land on opposite sides of a penalty. Full 100/100 agreement = 0 deduction,
    // 0/100 agreement = 25-point deduction, linear in between.
    const agreementDeduction = Math.round(clamp((100 - methodAgreementScore) / 100 * 25, 0, 25));
    if (agreementDeduction > 0) ded(agreementDeduction, `Valuation methods disagree (agreement ${methodAgreementScore}/100)`);
  }

  // Market-implied growth vs. the model's own blended growth estimate is the single
  // most direct "does this story hold together" check available — if the price only
  // makes sense assuming 90%+ growth while the model itself is only projecting 30%,
  // that gap matters more than almost any individual input clamp.
  if (growthGap != null) {
    const gapDeduction = Math.round(clamp((Math.abs(growthGap) - 0.15) / 0.15 * 20, 0, 20));
    if (gapDeduction > 0) ded(gapDeduction, `Market-implied growth diverges sharply from modeled growth (gap ${(growthGap * 100).toFixed(0)}pp)`);
  }

  if (marginOfSafetyDistorted) ded(10, 'Raw margin of safety was an extreme value before clamping — fair value estimate is likely unreliable here');

  // A naive 2-point CAGR diverging sharply from the median YoY growth rate is the
  // signature of a cyclical trough base year (a bad underwriting year, a demand
  // air-pocket) inflating the historical-growth read — common for mature/cyclical
  // industrials and insurers that show up with implausible 40-60% "expected CAGR."
  if (cagrDistortion != null) {
    const distortionDeduction = Math.round(clamp((cagrDistortion - 0.10) / 0.10 * 15, 0, 15));
    if (distortionDeduction > 0) ded(distortionDeduction, `Historical growth looks distorted by a cyclical base-year effect (naive vs. median YoY growth diverge by ${(cagrDistortion * 100).toFixed(0)}pp)`);
  }

  const netIncomes = yrs.slice(-5).map(y => y.netIncome).filter(x => x != null);
  if (netIncomes.some(x => x < 0) && netIncomes.some(x => x > 0)) {
    ded(10, 'Cyclical earnings — net income has swung positive/negative recently');
  }

  const negativeFcfYears = yrs.slice(-3).filter(y => y.fcf != null && y.fcf < 0).length;
  if (negativeFcfYears > 0) ded(negativeFcfYears * 5, `${negativeFcfYears} negative FCF year(s) in the last 3`);

  if (s.recentAcquisition) ded(10, 'Recent acquisition distorts year-over-year comparability');

  const marketCap = s.valuation?.marketCap;
  const sbcIntensity = last.sbc != null && marketCap ? last.sbc / marketCap : (last.sbcIntensity ?? null);
  if (sbcIntensity != null && sbcIntensity > 0.05) ded(10, `Heavy SBC (${(sbcIntensity * 100).toFixed(1)}% of market cap)`);

  if (revGrowthSources <= 1) ded(10, 'Growth estimate rests on a single data source');

  if (s.accountingFlag) ded(20, 'Accounting irregularity flagged');

  return { score: clamp(Math.round(score), 0, 100), deductions };
}


function scoreConsistency(values, tolerance) {
  const clean = values.filter(x => x != null && Number.isFinite(x));
  if (clean.length < 2) return 50;
  const avg = mean(clean);
  const sd = stdev(clean) || 0;
  return clamp(Math.round(100 - (sd / Math.max(Math.abs(avg), tolerance)) * 75), 0, 100);
}


// ---------- V41 Future Quality Score ----------
// Measures where the business is heading, independent of its current stock price.
// Every input is already available in the free-data pipeline; missing inputs revert
// toward neutral rather than becoming accidental zeroes.
function computeFutureQualityScore(stock, pricingPowerScore, confidenceScore) {
  const yrs = stock.financials?.years || [];
  const recent = yrs.slice(-5);
  const last = recent.at(-1) || {};
  const profile = stock.valuation?.businessProfile || {};
  const estimates = stock.analystEstimates || {};

  const revRates = [];
  const epsRates = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].revenue > 0 && recent[i].revenue > 0)
      revRates.push(recent[i].revenue / recent[i - 1].revenue - 1);
    if (recent[i - 1].eps > 0 && recent[i].eps > 0)
      epsRates.push(recent[i].eps / recent[i - 1].eps - 1);
  }

  const histRev = robustHistoricalGrowth(recent);
  const analystRev = mean([
    estimates.revenueGrowthCurrentYear,
    estimates.revenueGrowthNextYear,
    estimates.revenueGrowthFwd,
  ].filter(x => x != null));
  const analystEps = mean([
    estimates.epsGrowthCurrentYear,
    estimates.epsGrowthNextYear,
    estimates.epsGrowthFwd,
  ].filter(x => x != null));
  const forwardGrowth = analystRev ?? histRev ?? 0.05;
  const growthAcceleration = forwardGrowth - (histRev ?? forwardGrowth);

  const opMargins = recent.map(y => y.opMargin).filter(x => x != null);
  const fcfMargins = recent.map(y => y.revenue > 0 && y.fcf != null ? y.fcf / y.revenue : null).filter(x => x != null);
  const marginTrend = mean([
    opMargins.length >= 3 ? (opMargins.at(-1) - opMargins[0]) / (opMargins.length - 1) : null,
    fcfMargins.length >= 3 ? (fcfMargins.at(-1) - fcfMargins[0]) / (fcfMargins.length - 1) : null,
  ].filter(x => x != null)) ?? 0;

  const shares = recent.map(y => y.sharesOutTTM).filter(x => x > 0);
  const shareCagr = shares.length >= 2 ? cagr(shares[0], shares.at(-1), shares.length - 1) : 0;
  const positiveFcfRate = recent.length ? recent.filter(y => y.fcf > 0).length / recent.length : 0.5;
  const roic = mean(recent.map(y => y.roic).filter(x => x != null));

  const moat = clamp((profile.moatScore ?? stock.valuation?.moat?.score / 100 ?? .50) * 100, 0, 100);
  const persistence = clamp((profile.premiumPersistence ?? .50) * 100, 0, 100);
  const forecastReliability = clamp((profile.forecastReliability ?? confidenceScore / 100) * 100, 0, 100);
  const capitalAllocation = clamp(stock.valuation?.capitalAllocation?.score ?? 50, 0, 100);
  const compounder = clamp(stock.valuation?.compounder?.score ?? 50, 0, 100);
  const analystReliability = clamp(stock.valuation?.analystReliability?.score ?? stock.valuation?.analystReliability ?? 55, 0, 100);

  const momentumScore = clamp(
    scoreBand(forwardGrowth, 0.02, 0.24) * 0.58 +
    scoreBand(growthAcceleration, -0.08, 0.10) * 0.20 +
    scoreConsistency(revRates, 0.10) * 0.22, 0, 100);
  const earningsScore = analystEps == null
    ? clamp(scoreBand(median(epsRates) ?? forwardGrowth, -0.03, 0.25), 0, 100)
    : clamp(scoreBand(analystEps, -0.03, 0.28), 0, 100);
  const operatingLeverageScore = clamp(scoreBand(marginTrend, -0.02, 0.025), 0, 100);
  const buybackQualityScore = clamp(
    scoreBand(-shareCagr, -0.05, 0.05) * 0.65 + positiveFcfRate * 35, 0, 100);
  const runwayScore = clamp(
    scoreBand(roic ?? .08, .06, .28) * 0.42 + persistence * 0.34 + compounder * 0.24, 0, 100);

  // Cyclicality is a confidence modifier, not an automatic quality failure.
  const cyclicalityPenalty = clamp((stock.valuation?.businessProfile?.cyclicality ?? 0) * 12, 0, 12);
  const raw =
    momentumScore * 0.20 +
    earningsScore * 0.10 +
    operatingLeverageScore * 0.10 +
    pricingPowerScore * 0.10 +
    moat * 0.12 +
    runwayScore * 0.16 +
    buybackQualityScore * 0.07 +
    capitalAllocation * 0.07 +
    analystReliability * 0.04 +
    forecastReliability * 0.04 - cyclicalityPenalty;

  return {
    score: Math.round(clamp(50 + (raw - 50) * 1.22, 0, 100)),
    rawScore: Math.round(clamp(raw, 0, 100)),
    momentumScore: Math.round(momentumScore),
    earningsScore: Math.round(earningsScore),
    operatingLeverageScore: Math.round(operatingLeverageScore),
    pricingPowerScore: Math.round(pricingPowerScore),
    moatScore: Math.round(moat),
    runwayScore: Math.round(runwayScore),
    buybackQualityScore: Math.round(buybackQualityScore),
    capitalAllocationScore: Math.round(capitalAllocation),
    analystReliabilityScore: Math.round(analystReliability),
    forecastReliabilityScore: Math.round(forecastReliability),
    forwardGrowth,
    growthAcceleration,
    marginTrend,
    shareCagr,
    cyclicalityPenalty,
  };
}

function computeV6QualityScore(stock, categoryComposite, pricingPowerScore, confidenceScore) {
  const yrs = stock.financials?.years || [];
  const recent = yrs.slice(-5);
  const last = recent[recent.length - 1] || {};
  const profile = stock.valuation?.businessProfile || {};
  const capitalAllocation = stock.valuation?.capitalAllocation?.score ?? 50;
  const moat = clamp((profile.moatScore ?? 0.5) * 100, 0, 100);
  const durability = clamp((profile.premiumPersistence ?? 0.45) * 100, 0, 100);
  const forecast = clamp((profile.forecastReliability ?? confidenceScore / 100) * 100, 0, 100);

  const roics = recent.map(y => y.roic).filter(x => x != null);
  const avgRoic = mean(roics);
  const roicScore = scoreBand(avgRoic, 0.04, 0.30);

  const fcfMargins = recent.map(y => y.fcf != null && y.revenue > 0 ? y.fcf / y.revenue : null).filter(x => x != null);
  const avgFcfMargin = mean(fcfMargins);
  const fcfMarginScore = scoreBand(avgFcfMargin, 0.00, 0.25);
  const fcfPositiveRate = recent.length ? recent.filter(y => y.fcf != null && y.fcf > 0).length / recent.length : 0.5;
  const fcfConsistencyScore = Math.round(fcfPositiveRate * 65 + scoreConsistency(fcfMargins, 0.05) * 0.35);

  const opMargins = recent.map(y => y.opMargin).filter(x => x != null);
  const grossMargins = recent.map(y => y.grossMargin).filter(x => x != null);
  const marginLevel = Math.max(mean(opMargins) ?? 0, (mean(grossMargins) ?? 0) * 0.45);
  const marginLevelScore = scoreBand(marginLevel, 0.04, 0.30);
  const marginStabilityScore = Math.round((scoreConsistency(opMargins, 0.05) * 0.6) + (scoreConsistency(grossMargins, 0.10) * 0.4));

  const debtToEbitda = last.debtToEbitda;
  const balanceSheetScore = debtToEbitda == null ? 60 : clamp(Math.round(100 - scoreBand(debtToEbitda, 0.5, 5.0)), 0, 100);

  const revenueRates = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].revenue > 0 && recent[i].revenue > 0) revenueRates.push(recent[i].revenue / recent[i - 1].revenue - 1);
  }
  const growthQualityScore = revenueRates.length
    ? Math.round(scoreBand(median(revenueRates), -0.02, 0.22) * 0.65 + scoreConsistency(revenueRates, 0.08) * 0.35)
    : 50;

  // V6 quality is explicitly price-agnostic. Durable economics receive the majority
  // of the weight; category-specific opportunity metrics are intentionally secondary.
  const rawQuality =
    moat * 0.22 +
    roicScore * 0.17 +
    fcfConsistencyScore * 0.13 +
    fcfMarginScore * 0.08 +
    marginLevelScore * 0.10 +
    marginStabilityScore * 0.08 +
    pricingPowerScore * 0.08 +
    capitalAllocation * 0.07 +
    balanceSheetScore * 0.04 +
    durability * 0.02 +
    growthQualityScore * 0.01;

  // Quality must be selective. The previous 1.38x expansion pushed many merely good
  // companies into the 95-100 range. A convex curve keeps average businesses near the
  // middle while reserving 95+ for unusually complete evidence across moat, ROIC, cash
  // conversion, margins, and capital allocation.
  const normalizedQuality = clamp(rawQuality / 100, 0, 1);
  let expandedQuality = 100 * Math.pow(normalizedQuality, 1.22);
  const eliteDimensions = [moat, roicScore, fcfConsistencyScore, marginStabilityScore,
    pricingPowerScore, capitalAllocation].filter(v => v >= 82).length;
  if (expandedQuality > 94 && eliteDimensions < 4) expandedQuality = 94;
  if (expandedQuality > 97 && eliteDimensions < 5) expandedQuality = 97;
  expandedQuality = clamp(expandedQuality, 0, 100);

  return {
    score: Math.round(expandedQuality),
    rawScore: Math.round(rawQuality),
    moatScore: Math.round(moat),
    roicScore,
    fcfConsistencyScore,
    fcfMarginScore,
    marginLevelScore,
    marginStabilityScore,
    pricingPowerScore: Math.round(pricingPowerScore),
    capitalAllocationScore: Math.round(capitalAllocation),
    balanceSheetScore,
    durabilityScore: Math.round(durability),
    forecastScore: Math.round(forecast),
    growthQualityScore,
    categoryComposite: categoryComposite,
  };
}

function computeInvestmentScore(stock, categoryComposite, pricingPowerScore, confidenceScore, expectedReturn, marginOfSafety) {
  const profile = stock.valuation?.businessProfile || {};
  const ca = stock.valuation?.capitalAllocation?.score ?? 50;
  const moat = clamp((profile.moatScore ?? .5) * 100, 0, 100);
  const forecast = clamp((profile.forecastReliability ?? confidenceScore / 100) * 100, 0, 100);
  const quality = computeV6QualityScore(stock, categoryComposite, pricingPowerScore, confidenceScore);
  const future = computeFutureQualityScore(stock, pricingPowerScore, confidenceScore);
  const comp = stock.valuation?.compounder?.score ?? 50;
  const protect = stock.valuation?.downside?.protectionScore ?? 50;
  const integrity = stock.dataIntegrity?.score ?? 60;
  const ret = expectedReturn == null ? 35 : clamp((expectedReturn - .04) / .22 * 100, 0, 100);
  const val = marginOfSafety == null ? 40 : clamp((marginOfSafety + .05) / .45 * 100, 0, 100);

  // Opportunity remains price-aware. Future Quality prevents a cheap but eroding
  // business from outranking a durable compounder solely because its modeled MOS is large.
  const opportunity = Math.round(clamp(
    ret * .42 + val * .22 + future.score * .14 + confidenceScore * .10 +
    protect * .07 + integrity * .05, 0, 100));
  const success = Math.round(clamp(
    future.score * .25 + quality.score * .22 + comp * .14 + confidenceScore * .16 +
    forecast * .08 + moat * .06 + protect * .06 + integrity * .03, 5, 95));

  // V41 Future Return Score: expected return is multiplied by evidence quality rather
  // than merely added to it. This keeps fragile 20% forecasts below credible 15% ones.
  const expectedReturnPct = expectedReturn == null ? 4 : expectedReturn * 100;
  const evidenceMultiplier = clamp(
    (future.score / 100) * .35 + (confidenceScore / 100) * .25 +
    (quality.score / 100) * .25 + (protect / 100) * .15, .20, 1.00);
  const futureReturnScore = clamp(expectedReturnPct * evidenceMultiplier, -35, 35);
  const returnRankScore = clamp((futureReturnScore + 5) / 30 * 100, 0, 100);

  const score = Math.round(clamp(
    future.score * .27 + quality.score * .23 + opportunity * .20 +
    returnRankScore * .12 + comp * .08 + pricingPowerScore * .04 +
    protect * .03 + ca * .02 + confidenceScore * .01, 0, 100));

  return {
    score, portfolioManagerScore: score,
    futureReturnScore,
    returnEvidenceMultiplier: evidenceMultiplier,
    returnRankScore: Math.round(returnRankScore),
    futureQualityScore: future.score,
    futureQualityBreakdown: future,
    businessQualityScore: quality.score,
    valuationAttractivenessScore: opportunity,
    qualityBreakdown: quality,
    moatScore: Math.round(moat), forecastScore: Math.round(forecast),
    returnScore: Math.round(ret), valuationScore: Math.round(val),
    capitalAllocationScore: Math.round(ca), compounderScore: Math.round(comp),
    downsideProtectionScore: Math.round(protect), dataIntegrityScore: Math.round(integrity),
    successProbability: success,
    probabilityAdjustedReturn: expectedReturn == null ? null : expectedReturn * success / 100,
    downsideRisk: 100 - Math.round(protect),
  };
}

// ---------- 7. Master Scoring Function ----------

function scoreStock(stock) {
  const category = classifyCategory(stock);
  const catFn = CATEGORY_METRICS[category] || (category === 'Hyper Growth' ? CATEGORY_METRICS.Growth : category === 'Cyclical' ? CATEGORY_METRICS.Value : CATEGORY_METRICS.Value);
  const catResult = catFn(stock);
  const pricingPower = scorePricingPower(stock);
  const { fundamentalGrowthRate, breakdown, lowConfidence, revGrowthSources, cagrDistortion } = expectedCAGR(stock, category);
  // Price-aware expected return: starts at TODAY'S actual price and converges to a
  // mean-reverted sector exit multiple 5 years out (fiveYearPriceTargetCAGR in
  // valuation-methods.js). This is what should gate "is this a buy at today's price" —
  // fundamentalGrowthRate deliberately does not know the price you'd pay.
  // Requires `stock.valuation.fiveYearPriceTarget` to be populated upstream (same place
  // that already sets `fairValueEstimate` and `valuationMethods` below) — verify
  // run-screener.js maps the fiveYearPriceTarget object from valuateStock() through.
  const v7Return = stock.valuation.expectedReturnProfile ?? null;
  const expectedReturn = v7Return?.expectedCAGR ?? stock.valuation.fiveYearPriceTarget?.cagr ?? null;
  const riskAdjustedReturn = v7Return?.riskAdjustedCAGR ?? expectedReturn;
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
  // MOS is non-negative by definition. Overvaluation is tracked separately as a premium.
  const marginOfSafety = rawMarginOfSafety != null ? clamp(rawMarginOfSafety, 0, 1.0) : null;
  const premiumToFairValue = rawMarginOfSafety != null && rawMarginOfSafety < 0 ? -rawMarginOfSafety : 0;
  const marginOfSafetyDistorted = rawMarginOfSafety != null && (rawMarginOfSafety > 1.0 || rawMarginOfSafety < -1.0);
  const meetsRequiredMOS = marginOfSafety != null ? marginOfSafety >= requiredMOS : null;

  const marketImpliedGrowth = stock.valuation.marketImpliedGrowth ?? null;
  const growthGap = marketImpliedGrowth != null ? marketImpliedGrowth - breakdown.forwardRevGrowth : null;

  const confidence = computeConfidenceScore(
    stock, category, revGrowthSources,
    stock.valuation.methodAgreementScore ?? null, stock.valuation.methodCount ?? 0,
    growthGap, marginOfSafetyDistorted, cagrDistortion
  );

  // V61: business confidence and valuation confidence answer different questions.
  // Keep both visible so method disagreement cannot be mistaken for uncertainty about
  // the quality of the underlying company (and vice versa).
  const lifecycleConfidenceRaw = Number(stock.valuation.lifecycle?.confidence);
  const lifecycleConfidence = Number.isFinite(lifecycleConfidenceRaw)
    ? (lifecycleConfidenceRaw <= 1 ? lifecycleConfidenceRaw * 100 : lifecycleConfidenceRaw) : 50;
  const integrityConfidence = clamp(Number(stock.dataIntegrity?.score ?? 65), 0, 100);
  const analystConfidence = clamp(Number(stock.valuation.analystReliability ?? 55), 0, 100);
  const economicsConfidence = clamp(Number(stock.valuation.economicQuality?.forecastReliability ?? 55), 0, 100);
  const businessConfidenceScore = Math.round(clamp(
    lifecycleConfidence * .35 + integrityConfidence * .25 + analystConfidence * .20 + economicsConfidence * .20, 0, 100
  ));
  const agreementConfidence = clamp(Number(stock.valuation.methodAgreementScore ?? 35), 0, 100);
  const methodBreadth = clamp((Number(stock.valuation.methodCount ?? 0) / 4) * 100, 0, 100);
  const valuationConfidenceScore = Math.round(clamp(
    agreementConfidence * .55 + methodBreadth * .20 + analystConfidence * .10 + lifecycleConfidence * .15, 0, 100
  ));

  // Fall back to fundamentalGrowthRate only when a price target genuinely couldn't be
  // computed (e.g. insufficient exit-multiple data), so stocks don't silently vanish
  // from qualifying — but this is the weaker, price-agnostic signal, so flag it.
  const usedFallbackForCAGRTarget = expectedReturn == null;
  const meetsCAGRTarget = (expectedReturn ?? fundamentalGrowthRate) >= 0.15;
  const investment = computeInvestmentScore(stock, catResult.composite, pricingPower.score, confidence.score, riskAdjustedReturn ?? fundamentalGrowthRate, marginOfSafety);

  return {
    ticker: stock.ticker,
    sector: stock.sector,
    category,
    categoryComposite: catResult.composite,
    investmentScore: investment.score,
    portfolioManagerScore: investment.portfolioManagerScore,
    futureQualityScore: investment.futureQualityScore,
    futureQualityBreakdown: investment.futureQualityBreakdown,
    futureReturnScore: investment.futureReturnScore,
    returnEvidenceMultiplier: investment.returnEvidenceMultiplier,
    compounderScore: stock.valuation.compounder?.score ?? investment.compounderScore,
    compounderGrade: stock.valuation.compounder?.grade ?? null,
    compounderBreakdown: stock.valuation.compounder ?? null,
    pricingPowerV2Score: stock.valuation.pricingPowerV2?.score ?? pricingPower.score,
    pricingPowerV2: stock.valuation.pricingPowerV2 ?? null,
    downsideRiskScore: stock.valuation.downside?.score ?? investment.downsideRisk,
    downsideProtectionScore: stock.valuation.downside?.protectionScore ?? investment.downsideProtectionScore,
    permanentLossProbability: stock.valuation.downside?.permanentLossProbability ?? null,
    downsideAnalysis: stock.valuation.downside ?? null,
    industryModel: stock.valuation.industryModel ?? null,
    businessQualityScore: investment.businessQualityScore,
    valuationAttractivenessScore: investment.valuationAttractivenessScore,
    successProbability: investment.successProbability,
    probabilityAdjustedReturn: investment.probabilityAdjustedReturn,
    qualityBreakdown: investment.qualityBreakdown,
    investmentBreakdown: investment,
    businessProfile: stock.valuation.businessProfile ?? null,
    categoryBreakdown: catResult,
    pricingPowerScore: pricingPower.score,
    pricingPowerSignals: pricingPower.signals,
    capitalAllocationScore: stock.valuation.capitalAllocation?.score ?? null,
    capitalAllocationSignals: stock.valuation.capitalAllocation?.signals ?? [],
    // Preserve the full canonical object for the post-scoring decision layer.
    // V44 only kept the scalar score, so decision-system-v30 recomputed from a
    // stripped record with no financial history and collapsed every company to 55.
    capitalAllocation: stock.valuation.capitalAllocation ?? null,
    analystReliability: stock.valuation.analystReliability ?? null,
    reverseDCFGap: stock.valuation.reverseDCFGap ?? null,
    fundamentalGrowthRate,
    expectedReturn,
    // Expected excess return versus the model's long-run 10% equity hurdle.
    expectedAlpha: expectedReturn != null ? expectedReturn - 0.10 : null,
    riskAdjustedReturn,
    scenarioAnalysis: stock.valuation.scenarioAnalysis ?? null,
    // V61: preserve the full probabilistic/economic-quality layer in the compact
    // public record. The nightly runner computed these fields correctly, but V60
    // dropped them during scoreUniverse(), leaving the dashboard full of em dashes.
    scenarioProbabilities: stock.valuation.scenarioAnalysis?.probabilities ?? null,
    growthQuality: stock.valuation.growthQuality ?? stock.valuation.scenarioAnalysis?.growthQuality ?? null,
    capitalIntensity: stock.valuation.capitalIntensity ?? stock.valuation.scenarioAnalysis?.capitalIntensity ?? null,
    competitivePressure: stock.valuation.competitivePressure ?? stock.valuation.scenarioAnalysis?.competitivePressure ?? null,
    cycleNormalization: stock.valuation.cycleNormalization ?? stock.valuation.scenarioAnalysis?.cycleNormalization ?? null,
    lifecycle: stock.valuation.lifecycle ?? stock.valuation.projectionAssumptions?.lifecycle ?? null,
    moat: stock.valuation.moat ?? null,
    investmentCommittee: stock.valuation.investmentCommittee ?? null,
    monteCarlo: stock.valuation.monteCarlo ?? null,
    economicQuality: stock.valuation.economicQuality ?? null,
    businessEconomics: stock.valuation.businessEconomics ?? stock.valuation.economicQuality?.businessEconomics ?? null,
    expectedReturnProfile: stock.valuation.expectedReturnProfile ?? null,
    marketExpectations: stock.valuation.marketExpectations ?? null,
    expectationRisk: stock.valuation.expectationRisk ?? null,
    expectationRiskScore: stock.valuation.expectationRisk?.score ?? null,
    returnAttribution: stock.valuation.expectedReturnProfile?.returnAttribution ?? null,
    dataIntegrity: stock.dataIntegrity ?? null,
    investmentThesis: stock.valuation.investmentThesis ?? null,
    investmentGrade: investment.score >= 88 ? 'A+' : investment.score >= 80 ? 'A' : investment.score >= 73 ? 'B+' : investment.score >= 65 ? 'B' : investment.score >= 55 ? 'C' : investment.score >= 42 ? 'D' : 'F',
    usedFallbackForCAGRTarget,
    lowConfidence,
    confidenceScore: confidence.score,
    businessConfidenceScore,
    valuationConfidenceScore,
    confidenceDeductions: confidence.deductions,
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
    outlierFlags: stock.valuation.outlierFlags ?? [],
    methodAgreementScore: stock.valuation.methodAgreementScore ?? null,
    methodCount: stock.valuation.methodCount ?? 0,
    effectiveWeights: stock.valuation.effectiveWeights ?? null,
    reliabilityFlags: stock.valuation.reliabilityFlags ?? [],
    valuationProjection: stock.valuation.projection ?? null,
    projectionAssumptions: stock.valuation.projectionAssumptions ?? null,
    valuationMethodAudits: stock.valuation.methodAudits ?? null,
    fiveYearPriceTarget: stock.valuation.fiveYearPriceTarget ?? null,
    primaryValuation: stock.valuation.primaryValuation ?? stock.valuation.fiveYearPriceTarget?.primaryValuation ?? null,
    valuationConsensus: stock.valuation.valuationConsensus ?? null,
    intrinsicValue: stock.valuation.intrinsicValue ?? null,
    marketValue: stock.valuation.marketValue ?? null,
    ownerEarningsReturn: stock.valuation.ownerEarningsReturn ?? null,
    portfolioProfile: stock.valuation.portfolioProfile ?? null,
    methodSelection: stock.valuation.methodSelection ?? null,
    analystEstimates: stock.analystEstimates ?? null,
    currentPrice: stock.price.current ?? null,
    fairValueEstimate: stock.valuation.fairValueEstimate ?? null,
    dilutionRate: stock.valuation.dilutionRate ?? null,
    sbcIntensity: stock.valuation.sbcIntensity ?? null,
  };
}

// ---------- 7b. Selective Ratings ----------

function assignSelectiveRatings(scoredStocks) {
  const sorted = [...scoredStocks].sort((a, b) =>
    ((b.investmentScore ?? -Infinity) - (a.investmentScore ?? -Infinity)) ||
    ((b.futureReturnScore ?? -Infinity) - (a.futureReturnScore ?? -Infinity)) ||
    ((b.futureQualityScore ?? -Infinity) - (a.futureQualityScore ?? -Infinity)) ||
    ((b.businessQualityScore ?? -Infinity) - (a.businessQualityScore ?? -Infinity)) ||
    ((b.confidenceScore ?? -Infinity) - (a.confidenceScore ?? -Infinity))
  );

  const total = sorted.length;
  if (!total) return scoredStocks;

  sorted.forEach((stock, index) => {
    const percentile = (index + 1) / total;
    const expectedReturn = stock.riskAdjustedReturn ?? stock.expectedReturn ?? stock.fundamentalGrowthRate ?? null;
    const confidence = stock.confidenceScore ?? 0;
    const quality = stock.businessQualityScore ?? 0;
    const downsideProtection = stock.downsideProtectionScore ?? 50;
    const qualifies = stock.qualifiesForBuyList === true;

    // Ratings are selective by both rank and absolute underwriting quality.
    // A stock cannot earn a top rating solely because it ranks well in a weak universe.
    if (
      percentile <= 0.01 &&
      qualifies &&
      expectedReturn != null && expectedReturn >= 0.15 &&
      confidence >= 75 &&
      quality >= 75 &&
      (stock.futureQualityScore ?? 0) >= 72 &&
      downsideProtection >= 55
    ) {
      stock.rating = 'Exceptional';
    } else if (
      percentile <= 0.05 &&
      qualifies &&
      expectedReturn != null && expectedReturn >= 0.13 &&
      confidence >= 68 &&
      quality >= 68 &&
      (stock.futureQualityScore ?? 0) >= 65
    ) {
      stock.rating = 'Strong Buy';
    } else if (
      percentile <= 0.20 &&
      qualifies &&
      expectedReturn != null && expectedReturn >= 0.10 &&
      confidence >= 58
    ) {
      stock.rating = 'Buy';
    } else if (
      expectedReturn != null && expectedReturn < 0 ||
      stock.marginOfSafety != null && stock.marginOfSafety < -0.35 ||
      stock.downsideRiskScore != null && stock.downsideRiskScore >= 80
    ) {
      stock.rating = 'Sell';
    } else if (
      percentile > 0.80 ||
      stock.marginOfSafety != null && stock.marginOfSafety < -0.15 ||
      confidence < 35
    ) {
      stock.rating = 'Avoid';
    } else {
      stock.rating = 'Hold';
    }
  });

  return scoredStocks;
}

// ---------- 8. Percentile-Based Rating (apply after scoring full universe) ----------

function applyPercentileRatings(scoredStocks) {
  const qualifiers = scoredStocks.filter(s => s.qualifiesForBuyList && (s.expectedReturn ?? s.fundamentalGrowthRate) >= 0);
  const nonQualifiers = scoredStocks.filter(s => !(s.qualifiesForBuyList && (s.expectedReturn ?? s.fundamentalGrowthRate) >= 0));

  function assignRank(list, field, rankField, pctField, leaderField) {
    const sorted = [...list].sort((a, b) =>
      ((b[field] ?? -Infinity) - (a[field] ?? -Infinity)) ||
      (b.confidenceScore - a.confidenceScore)
    );
    sorted.forEach((s, i) => {
      s[rankField] = i + 1;
      s[pctField] = sorted.length <= 1 ? 0 : i / (sorted.length - 1);
      s[leaderField] = Math.round((1 - s[pctField]) * 100);
    });
  }

  // Independent global leaderboards: quality ignores price, opportunity focuses on
  // return/MOS. This makes it obvious whether a stock is a great business, a cheap
  // security, or both.
  assignRank(scoredStocks, 'futureQualityScore', 'qualityRank', 'qualityPercentile', 'qualityLeaderScore');
  assignRank(scoredStocks, 'valuationAttractivenessScore', 'opportunityRank', 'opportunityPercentile', 'opportunityLeaderScore');
  assignRank(scoredStocks, 'investmentScore', 'overallRank', 'overallPercentile', 'overallLeaderScore');
  for (const s of scoredStocks) s.globalUniverseSize = scoredStocks.length;

  const categoryRanks = new Map();
  for (const s of scoredStocks) {
    const bucket = categoryRanks.get(s.category) || [];
    bucket.push(s);
    categoryRanks.set(s.category, bucket);
  }
  for (const bucket of categoryRanks.values()) {
    bucket.sort((a, b) =>
      (b.investmentScore - a.investmentScore) ||
      (b.futureQualityScore - a.futureQualityScore) ||
      (b.businessQualityScore - a.businessQualityScore) ||
      (b.valuationAttractivenessScore - a.valuationAttractivenessScore) ||
      (b.confidenceScore - a.confidenceScore)
    );
    bucket.forEach((s, i) => {
      s.categoryRank = i + 1;
      s.categoryUniverseSize = bucket.length;
      s.categoryPercentile = bucket.length <= 1 ? 0 : i / (bucket.length - 1);
      s.categoryLeaderScore = Math.round((1 - s.categoryPercentile) * 100);
    });
  }

  return assignSelectiveRatings(scoredStocks);

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
  scorePricingPower, dynamicMOS, expectedCAGR, computeInvestmentScore, computeV6QualityScore, computeFutureQualityScore,
  blendedRevenueGrowth, computeConfidenceScore,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ScoringEngine = api;
