/**
 * StockTool category engine v1.0
 *
 * Categories describe the BUSINESS, not whether the shares are cheap today.
 * Classification uses a multi-year operating profile plus forward estimates.
 * Valuation is deliberately excluded except for the Value and Dividend styles.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CategoryEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const median = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const stdev = a => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
  };
  const cagr = (a, b, n) => a > 0 && b > 0 && n > 0 ? Math.pow(b / a, 1 / n) - 1 : null;
  const finite = x => Number.isFinite(x);
  const series = (yrs, key, n = yrs.length) => yrs.slice(-n).map(y => y?.[key]).filter(finite);
  const growthRates = (yrs, key, n = 8) => {
    const a = yrs.slice(-(n + 1));
    const out = [];
    for (let i = 1; i < a.length; i++) {
      const p = a[i - 1]?.[key], v = a[i]?.[key];
      if (p > 0 && v > 0) out.push(v / p - 1);
    }
    return out;
  };
  const pct = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

  const CYCLICAL_SECTORS = new Set(['Energy', 'Materials']);
  const CYCLICAL_INDUSTRY_WORDS = /steel|metal|mining|oil|gas|drilling|chemical|paper|lumber|airline|auto manufacturer|semiconductor equipment|homebuild|shipping|freight|commodity/i;
  const DEFENSIVE_INDUSTRY_WORDS = /utility|regulated|telecom|reit|pipeline|tobacco|consumer staple|beverage|food|household products/i;

  function buildCategoryProfile(stock) {
    const yrs = stock?.financials?.years || [];
    const recent = yrs.slice(-5);
    const revRates = growthRates(yrs, 'revenue', 8);
    const epsRates = growthRates(yrs, 'eps', 8);
    const rev3 = yrs.length >= 4 ? cagr(yrs.at(-4)?.revenue, yrs.at(-1)?.revenue, 3) : median(revRates.slice(-3));
    const rev5 = yrs.length >= 6 ? cagr(yrs.at(-6)?.revenue, yrs.at(-1)?.revenue, 5) : median(revRates.slice(-5));
    const revMedian = median(revRates.slice(-5));
    const revVol = stdev(revRates.slice(-6));
    const roic = series(yrs, 'roic', 5);
    const opMargins = series(yrs, 'opMargin', 6);
    const grossMargins = series(yrs, 'grossMargin', 6);
    const fcfMargins = recent.map(y => y.revenue > 0 && finite(y.fcf) ? y.fcf / y.revenue : null).filter(finite);
    const shares = series(yrs, 'sharesOutTTM', 5);
    const positiveFcfRate = recent.length ? recent.filter(y => y.fcf > 0).length / recent.length : 0.5;
    const positiveIncomeRate = recent.length ? recent.filter(y => y.netIncome > 0).length / recent.length : 0.5;

    const e = stock?.analystEstimates || {};
    const y1 = e.revenueGrowthCurrentYear ?? e.revenueGrowthFwd ?? stock?.growthYear1 ?? revMedian ?? 0;
    const y2 = e.revenueGrowthNextYear ?? y1;
    const forwardGrowth = mean([y1, y2].filter(finite)) ?? 0;
    const growthAcceleration = finite(rev3) ? forwardGrowth - rev3 : 0;

    const avgRoic = mean(roic);
    const marginStability = grossMargins.length >= 3 ? 1 - pct(stdev(grossMargins) || 0, 0.015, 0.12) : 0.5;
    const opMarginTrend = opMargins.length >= 3 ? (opMargins.at(-1) - opMargins[0]) / (opMargins.length - 1) : 0;
    const fcfMarginTrend = fcfMargins.length >= 3 ? (fcfMargins.at(-1) - fcfMargins[0]) / (fcfMargins.length - 1) : 0;
    const shareTrend = shares.length >= 2 ? cagr(shares[0], shares.at(-1), shares.length - 1) : 0;
    const revenueDeclineYears = revRates.slice(-5).filter(x => x < -0.025).length;
    const recentRevenueDeclineYears = revRates.slice(-3).filter(x => x < -0.025).length;
    const severeDecline = revRates.slice(-4).some(x => x < -0.10);
    const recentSevereDecline = revRates.slice(-2).some(x => x < -0.10);
    const priorDeterioration = revenueDeclineYears >= 1 || (opMargins.length >= 4 && Math.min(...opMargins.slice(0, -1)) < opMargins[0] - 0.025);
    const recoveryEvidence = priorDeterioration && ((opMarginTrend > 0.008) || (fcfMarginTrend > 0.008) || growthAcceleration > 0.05) && forwardGrowth > -0.02;

    const valuation = stock?.valuation || {};
    const fcfYield = valuation.fcfYield;
    const earningsYield = valuation.forwardPe > 0 ? 1 / valuation.forwardPe : valuation.pe > 0 ? 1 / valuation.pe : null;
    const dividendYield = valuation.dividendYield || 0;
    const latestRevenue = Number(yrs.at(-1)?.revenue) || 0;
    const payout = (() => {
      const last = yrs.at(-1) || {};
      return last.fcf > 0 && last.sharesOutTTM > 0 && finite(last.dividendPerShare)
        ? last.dividendPerShare * last.sharesOutTTM / last.fcf : null;
    })();

    const industryText = `${stock?.industry || ''} ${stock?.sector || ''} ${valuation?.industryModel?.model || ''}`;
    const cyclicalIndustry = CYCLICAL_SECTORS.has(stock?.sector) || CYCLICAL_INDUSTRY_WORDS.test(industryText);
    const defensiveIndustry = DEFENSIVE_INDUSTRY_WORDS.test(industryText);

    return {
      years: yrs.length, forwardGrowth, y1, y2, rev3, rev5, revMedian, revVol,
      growthAcceleration, avgRoic, marginStability, opMarginTrend, fcfMarginTrend,
      positiveFcfRate, positiveIncomeRate, shareTrend, revenueDeclineYears, recentRevenueDeclineYears,
      severeDecline, recentSevereDecline, priorDeterioration, recoveryEvidence, fcfYield, earningsYield,
      dividendYield, payout, latestRevenue, cyclicalIndustry, defensiveIndustry,
      sector: stock?.sector || '', industryText,
    };
  }

  function scoreArchetypes(p) {
    const growthDurability = 0.45 * pct(p.rev5 ?? p.rev3 ?? p.forwardGrowth, 0.03, 0.18)
      + 0.25 * pct(p.forwardGrowth, 0.04, 0.20)
      + 0.15 * p.marginStability + 0.15 * p.positiveFcfRate;

    const compounder = 100 * (
      0.30 * pct(p.avgRoic ?? 0.08, 0.08, 0.28) +
      0.20 * p.marginStability +
      0.18 * growthDurability +
      0.14 * p.positiveFcfRate +
      0.10 * pct(p.forwardGrowth, 0.04, 0.14) +
      0.08 * (1 - pct(Math.max(p.shareTrend || 0, 0), 0.01, 0.08))
    );

    const growth = 100 * (
      0.34 * pct(p.forwardGrowth, 0.08, 0.25) +
      0.24 * pct(p.rev3 ?? p.forwardGrowth, 0.06, 0.25) +
      0.14 * pct(p.growthAcceleration, -0.05, 0.10) +
      0.12 * p.positiveFcfRate +
      0.10 * p.marginStability +
      0.06 * pct(p.avgRoic ?? 0.08, 0.05, 0.22)
    );

    const hyperGrowth = 100 * (
      0.48 * pct(p.forwardGrowth, 0.18, 0.40) +
      0.24 * pct(p.rev3 ?? p.forwardGrowth, 0.15, 0.35) +
      0.12 * pct(p.growthAcceleration, -0.03, 0.12) +
      0.08 * p.positiveFcfRate +
      0.08 * p.marginStability
    );

    const turnaround = 100 * (
      0.22 * (p.priorDeterioration ? 1 : 0) +
      0.28 * (p.recoveryEvidence ? 1 : 0) +
      0.28 * ((p.recentRevenueDeclineYears > 0 || p.recentSevereDecline || p.positiveIncomeRate < .60) ? 1 : 0) +
      0.14 * pct(p.growthAcceleration, 0, 0.12) +
      0.10 * pct(p.opMarginTrend, 0, 0.025) +
      0.08 * pct(p.fcfMarginTrend, 0, 0.025)
    );

    const cyclical = 100 * (
      0.32 * (p.cyclicalIndustry ? 1 : 0) +
      0.24 * pct(p.revVol ?? 0.08, 0.08, 0.35) +
      0.16 * pct(p.revenueDeclineYears, 0, 2) +
      0.12 * (p.severeDecline ? 1 : 0) +
      0.10 * (1 - p.marginStability) +
      0.06 * (1 - p.positiveIncomeRate)
    );

    const dividend = 100 * (
      0.45 * pct(p.dividendYield, 0.018, 0.055) +
      0.18 * p.positiveFcfRate +
      0.12 * p.marginStability +
      0.10 * (p.defensiveIndustry ? 1 : 0) +
      0.15 * (p.payout == null ? 0.5 : 1 - pct(p.payout, 0.45, 1.10))
    );

    const value = 100 * (
      0.35 * pct(p.fcfYield ?? 0.04, 0.035, 0.11) +
      0.25 * pct(p.earningsYield ?? 0.04, 0.035, 0.10) +
      0.14 * p.positiveFcfRate +
      0.10 * pct(p.avgRoic ?? 0.08, 0.04, 0.18) +
      0.10 * (1 - pct(p.forwardGrowth, 0.10, 0.25)) +
      0.06 * p.marginStability
    );

    return { Compounder: compounder, Growth: growth, 'Hyper Growth': hyperGrowth,
      Turnaround: turnaround, Cyclical: cyclical, Dividend: dividend, Value: value };
  }

  function classifyStock(stock) {
    const p = buildCategoryProfile(stock);
    if (p.years < 3) return { category: 'Unknown', confidence: 0, scores: {}, profile: p, reason: 'Insufficient history' };
    const scores = scoreArchetypes(p);

    // Hard gates prevent one noisy analyst estimate from creating a Hyper Growth label.
    // Hyper Growth requires both high forward growth and demonstrated multi-year growth,
    // plus cash-flow evidence. Financials and mature staples are classified by their
    // economics rather than by a temporary revenue spike.
    const financialSector = /financial/i.test(p.sector);
    const staplesSector = /consumer staples/i.test(p.sector);
    const hyperEligible = p.forwardGrowth >= 0.22 &&
      (p.rev3 ?? p.forwardGrowth) >= 0.16 &&
      p.y2 >= 0.18 && p.positiveFcfRate >= 0.60 &&
      !financialSector && !staplesSector;
    if (!hyperEligible) scores['Hyper Growth'] *= 0.22;
    // A turnaround requires a CURRENT operating impairment, not merely one weak
    // comparison year. This prevents healthy secular growers coming out of a cycle
    // (for example a semiconductor company with positive FCF and strong forward
    // growth) from being mislabeled as Turnaround.
    const marginStillImpaired = p.opMarginTrend < -0.006 || p.fcfMarginTrend < -0.006;
    const unresolvedRevenueWeakness = p.recentRevenueDeclineYears > 0 &&
      (p.forwardGrowth < .04 || marginStillImpaired || p.positiveIncomeRate < .80);
    const activeImpairment = p.recentSevereDecline ||
      (p.positiveIncomeRate < .60 && p.forwardGrowth < .08) || unresolvedRevenueWeakness;
    if (!(p.priorDeterioration && p.recoveryEvidence && activeImpairment)) scores.Turnaround *= 0.16;
    if (!(p.cyclicalIndustry || (p.revVol ?? 0) >= 0.18)) scores.Cyclical *= 0.45;
    if (!(p.dividendYield >= 0.022 && (p.payout == null || p.payout <= 1.10))) scores.Dividend *= 0.45;
    if (!((p.fcfYield ?? 0) >= 0.045 || (p.earningsYield ?? 0) >= 0.05)) scores.Value *= 0.55;
    if (!(p.avgRoic >= 0.12 && p.positiveFcfRate >= 0.60 && p.forwardGrowth >= 0.025)) scores.Compounder *= 0.60;

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    let [category, top] = ranked[0];
    const second = ranked[1]?.[1] ?? 0;

    // Prefer durable business labels over valuation styles when evidence is close.
    if (category === 'Value' || category === 'Dividend') {
      const durable = ranked.find(([k]) => ['Compounder', 'Growth', 'Hyper Growth'].includes(k));
      if (durable && durable[1] >= top - 8) [category, top] = durable;
    }
    // A mature high-quality grower is a compounder, not generic Growth.
    if (category === 'Growth' && scores.Compounder >= scores.Growth - 5 && p.avgRoic >= 0.16 && p.positiveFcfRate >= 0.8) {
      category = 'Compounder'; top = scores.Compounder;
    }

    // Mature, cash-generative growers should read as Compounders. This catches large
    // established platforms whose current growth is healthy but no longer hyper-growth.
    const matureCompounder = p.forwardGrowth < 0.20 && p.positiveFcfRate >= 0.80 &&
      p.positiveIncomeRate >= 0.80 && (p.avgRoic ?? 0) >= 0.14 && p.marginStability >= 0.60;
    if ((category === 'Growth' || category === 'Hyper Growth') && matureCompounder &&
        scores.Compounder >= scores.Growth - 10) {
      category = 'Compounder'; top = scores.Compounder;
    }

    // Financial businesses are never labeled Hyper Growth by revenue alone.
    if (financialSector && category === 'Hyper Growth') {
      category = scores.Compounder >= scores.Value ? 'Compounder' : 'Value';
      top = scores[category];
    }

    // Turnaround is a current operating condition, not a memory of an old weak
    // period. Durable businesses with healthy forward growth, consistently
    // positive cash flow, and no recent impairment remain Compounders/Growth.
    if (category === 'Turnaround' && !activeImpairment && p.forwardGrowth >= .07 &&
        p.positiveFcfRate >= .80 && p.positiveIncomeRate >= .80 && (p.avgRoic ?? 0) >= .12) {
      const durable = scores.Compounder >= scores.Growth ? 'Compounder' : 'Growth';
      category = durable;
      top = scores[durable];
    }

    // Final secular-grower safeguard. A business with strong forward growth,
    // consistently positive cash generation and acceptable ROIC should not carry
    // Turnaround's 30% required MOS simply because its history contains a cyclical
    // down year. This is fundamentals-based rather than ticker-specific.
    const healthySecularGrower = p.forwardGrowth >= .10 &&
      p.positiveFcfRate >= .80 && p.positiveIncomeRate >= .80 &&
      (p.avgRoic ?? 0) >= .12 && !p.recentSevereDecline && !marginStillImpaired;
    if (category === 'Turnaround' && healthySecularGrower) {
      const durable = scores.Compounder >= scores.Growth ? 'Compounder' : 'Growth';
      category = durable;
      top = scores[durable];
    }

    // Lifecycle overrides use business maturity rather than temporary valuation.
    // Large, consistently profitable platforms with sub-25% forward growth are
    // compounders even when a strong current year would otherwise trigger Hyper Growth.
    const establishedPlatform = p.latestRevenue >= 20e9 && p.years >= 5 &&
      p.forwardGrowth < .25 && p.positiveFcfRate >= .80 && p.positiveIncomeRate >= .80 &&
      ((p.avgRoic ?? 0) >= .12 || (p.marginStability >= .70 && p.forwardGrowth < .20));
    if ((category === 'Growth' || category === 'Hyper Growth') && establishedPlatform) {
      category = 'Compounder';
      top = scores.Compounder;
    }

    // Defensive staples with a meaningful, covered dividend are income compounders,
    // not generic Value names. Keep the public category vocabulary stable by using
    // Dividend while the lifecycle engine can still describe them as compounders.
    if (staplesSector && p.dividendYield >= .02 && p.positiveFcfRate >= .80 &&
        (p.payout == null || p.payout <= 1.10) && p.y2 < .16 && (p.rev3 ?? 0) < .12) {
      category = 'Dividend';
      top = scores.Dividend;
    }

    const dataCoverage = clamp((p.years - 2) / 6, 0, 1);
    const separation = clamp((top - second) / 25, 0, 1);
    const confidence = Math.round(100 * (0.55 * dataCoverage + 0.45 * separation));
    return { category, confidence, scores: Object.fromEntries(Object.entries(scores).map(([k,v]) => [k, Math.round(v)])), profile: p };
  }

  const classifyCategory = stock => classifyStock(stock).category;
  return { buildCategoryProfile, scoreArchetypes, classifyStock, classifyCategory };
});
