'use strict';

const { classifyBusinessArchetype } = require('./business-archetype-engine');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function growthRates(years) {
  const r = [];
  for (let i = 1; i < years.length; i++) {
    if (years[i - 1].revenue > 0 && years[i].revenue > 0) r.push(years[i].revenue / years[i - 1].revenue - 1);
  }
  return r;
}
function volatility(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map(v => (v - m) ** 2)) || 0);
}
function cagr(years, lookback) {
  const slice = years.slice(-(lookback + 1));
  if (slice.length < 2 || !(slice[0].revenue > 0) || !(slice.at(-1).revenue > 0)) return null;
  return Math.pow(slice.at(-1).revenue / slice[0].revenue, 1 / (slice.length - 1)) - 1;
}

function classifyLifecycle(stock) {
  const ys = stock.financials?.years || [];
  const recent = ys.slice(-11);
  const rates = growthRates(recent);
  const e = stock.analystEstimates || {};
  const industry = stock.valuation?.industryModel?.model || 'general';
  const marketCap = stock.valuation?.marketCap || 0;
  const dividendYield = stock.valuation?.dividendYield || 0;
  const forward1 = e.revenueGrowthCurrentYear ?? e.revenueGrowthFwd ?? stock.growthYear1 ?? median(rates.slice(-3)) ?? 0;
  const forward2 = e.revenueGrowthNextYear ?? forward1;
  const analystForward = mean([forward1, forward2].filter(Number.isFinite)) ?? 0;
  const growth3 = cagr(recent, 3);
  const growth5 = cagr(recent, 5);
  const growth10 = cagr(recent, 10);
  const historicalMedian = median(rates.slice(-7)) ?? 0;
  const persistenceGrowth =
    analystForward * .30 +
    (growth3 ?? historicalMedian) * .24 +
    (growth5 ?? historicalMedian) * .26 +
    (growth10 ?? growth5 ?? historicalMedian) * .20;

  const roics = recent.slice(-6).map(y => y.roic).filter(Number.isFinite);
  const avgRoic = median(roics);
  const positiveFcf = recent.length ? recent.filter(y => (y.fcf || 0) > 0).length / recent.length : 0;
  const op = recent.map(y => y.opMargin ?? y.operatingMargin ?? (y.revenue > 0 && y.operatingIncome != null ? y.operatingIncome / y.revenue : null)).filter(Number.isFinite);
  const gross = recent.map(y => y.grossMargin).filter(Number.isFinite);
  const fcfMargins = recent.map(y => y.fcfMargin ?? (y.revenue > 0 && Number.isFinite(y.fcf) ? y.fcf / y.revenue : null)).filter(Number.isFinite);
  const growthVolatility = volatility(rates.slice(-7));
  const marginVolatility = volatility(op.slice(-6));
  const grossStability = 1 - clamp(volatility(gross.slice(-6)) / .10, 0, 1);
  const fcfStability = 1 - clamp(volatility(fcfMargins.slice(-6)) / .16, 0, 1);
  const pricing = clamp((stock.valuation?.pricingPowerV2?.score ?? stock.pricingPowerScore ?? 50) / 100, 0, 1);
  const embeddedMoat = Number.isFinite(stock.valuation?.businessProfile?.moatScore) ? stock.valuation.businessProfile.moatScore * 100 : null;
  const moat = clamp((stock.valuation?.moat?.score ?? embeddedMoat ?? 50) / 100, 0, 1);
  const roicScore = avgRoic == null ? .45 : clamp((avgRoic - .06) / .28, 0, 1);
  const scalePenalty = marketCap >= 500e9 ? .16 : marketCap >= 150e9 ? .10 : marketCap >= 50e9 ? .05 : 0;
  const persistenceScore = clamp(
    .28 * clamp((persistenceGrowth + .02) / .24, 0, 1) +
    .20 * roicScore + .14 * positiveFcf + .10 * grossStability + .10 * fcfStability +
    .09 * pricing + .09 * moat - .12 * clamp(growthVolatility / .25, 0, 1) - scalePenalty,
    0, 1
  );
  const compoundingPotential = Math.round(persistenceScore * 100);

  const latestGrowth = rates.at(-1) ?? historicalMedian;
  const revenueDrawdown = rates.some(g => g < -.08);
  const marginRecovery = op.length >= 3 && op.at(-1) > median(op.slice(0, -1)) + .02;
  const archetype = classifyBusinessArchetype(stock, { analystForward, growth5 });
  const cyclicalIndustry = ['energy', 'materials'].includes(industry) || (['industrials', 'semiconductors-hardware'].includes(industry) && archetype.cyclicalBias >= .60);
  const structuralFinancial = ['financials', 'reit', 'utilities'].includes(industry);
  const temporaryDisruption = (latestGrowth < historicalMedian - .10 || forward1 < historicalMedian - .10)
    && forward2 > forward1 + .04
    && (gross.length < 2 || gross.at(-1) >= median(gross.slice(-4)) - .035)
    && positiveFcf >= .50;

  let stage;
  if (archetype.archetype === 'Scaling Consumer Brand') stage = analystForward >= .24 && persistenceScore >= .60 ? 'Hyper Growth' : 'Growth';
  else if (archetype.archetype === 'Secular Compute Platform') stage = analystForward >= .24 && persistenceScore >= .62 ? 'Hyper Growth' : 'Growth';
  else if (archetype.archetype === 'Software Platform Growth') stage = analystForward >= .22 && persistenceScore >= .60 ? 'Hyper Growth' : 'Growth';
  else if (archetype.archetype === 'Stable Dividend Compounder') stage = 'Dividend Compounder';
  else if (archetype.archetype === 'Stable Consumer Compounder') stage = 'Compounder';
  else if (archetype.archetype === 'Consumer Brand Compounder' || archetype.archetype === 'Industrial Compounder' || archetype.archetype === 'Software Compounder' || archetype.archetype === 'Healthcare Compounder' || archetype.archetype === 'Network Compounder') stage = persistenceScore >= .68 ? 'Elite Compounder' : 'Compounder';
  else if (archetype.archetype === 'Digital Financial Platform') stage = analystForward >= .20 ? 'Growth' : 'Compounder';
  else if (industry === 'financials') stage = 'Financial';
  else if (industry === 'reit') stage = 'Asset Heavy';
  else if (industry === 'utilities') stage = 'Utility';
  else if (temporaryDisruption && forward2 >= .10 && industry !== 'semiconductors-hardware') stage = 'Temporary Disruption';
  else if (revenueDrawdown && marginRecovery && analystForward >= 0 && !cyclicalIndustry) stage = 'Turnaround';
  else if (cyclicalIndustry && (growthVolatility >= .14 || marginVolatility >= .06 || revenueDrawdown) && persistenceScore < .72) stage = 'Cyclical';
  else if (analystForward >= .24 && persistenceGrowth >= .16 && persistenceScore >= .58 && !structuralFinancial && industry !== 'consumer-staples') stage = 'Hyper Growth';
  else if (analystForward >= .13 && persistenceGrowth >= .09 && persistenceScore >= .50 && !structuralFinancial) stage = 'Growth';
  else if (dividendYield >= .025 && persistenceGrowth < .075) stage = 'Dividend Compounder';
  else if (persistenceScore >= .68 && avgRoic != null && avgRoic >= .16 && positiveFcf >= .70) stage = 'Elite Compounder';
  else if (persistenceScore >= .48 && positiveFcf >= .55) stage = 'Compounder';
  else if (cyclicalIndustry) stage = 'Cyclical';
  else stage = 'Mature';

  // Stable staples and large established businesses require persistent, not merely
  // current, growth before receiving a high-growth label. This prevents acquisition/
  // pricing spikes from turning companies such as beverage staples into Hyper Growth.
  if (industry === 'consumer-staples' && ['Hyper Growth', 'Growth'].includes(stage) && archetype.archetype !== 'Scaling Consumer Brand') {
    stage = dividendYield >= .018 ? 'Dividend Compounder' : 'Compounder';
  }
  if (marketCap >= 150e9 && stage === 'Hyper Growth' && persistenceGrowth < .20) stage = 'Growth';
  if (marketCap >= 500e9 && stage === 'Growth' && persistenceGrowth < .13 && roicScore >= .55) stage = 'Elite Compounder';

  const config = {
    'Hyper Growth': { forecastYears: 10, fadeYears: 12, terminalGrowth: .035, multipleFade: 'slow' },
    Growth: { forecastYears: 9, fadeYears: 11, terminalGrowth: .032, multipleFade: 'slow' },
    'Temporary Disruption': { forecastYears: 8, fadeYears: 10, terminalGrowth: .030, multipleFade: 'moderate-slow' },
    'Elite Compounder': { forecastYears: 8, fadeYears: 14, terminalGrowth: .032, multipleFade: 'very-slow' },
    Compounder: { forecastYears: 7, fadeYears: 11, terminalGrowth: .028, multipleFade: 'slow' },
    'Dividend Compounder': { forecastYears: 7, fadeYears: 9, terminalGrowth: .023, multipleFade: 'moderate' },
    Turnaround: { forecastYears: 6, fadeYears: 6, terminalGrowth: .022, multipleFade: 'moderate' },
    Cyclical: { forecastYears: 6, fadeYears: 5, terminalGrowth: .018, multipleFade: 'fast' },
    Financial: { forecastYears: 6, fadeYears: 8, terminalGrowth: .022, multipleFade: 'moderate' },
    Utility: { forecastYears: 6, fadeYears: 9, terminalGrowth: .022, multipleFade: 'moderate' },
    'Asset Heavy': { forecastYears: 6, fadeYears: 7, terminalGrowth: .018, multipleFade: 'fast' },
    Mature: { forecastYears: 5, fadeYears: 7, terminalGrowth: .022, multipleFade: 'moderate' },
  }[stage];

  const confidence = clamp(.30 + (e.numAnalysts || 0) / 90 + Math.min(recent.length, 7) * .04 + positiveFcf * .14
    + grossStability * .06 + fcfStability * .06 - growthVolatility * .45 - marginVolatility * .60, .30, .95);

  return {
    stage, ...config,
    forwardGrowth: analystForward,
    forwardGrowthYear1: forward1,
    forwardGrowthYear2: forward2,
    historicalGrowth: historicalMedian,
    historicalMeanGrowth: mean(rates.slice(-5)) ?? historicalMedian,
    growth3, growth5, growth10,
    growthPersistenceScore: compoundingPotential,
    compoundingPotential,
    persistenceGrowth,
    avgRoic, positiveFcfRate: positiveFcf, growthVolatility, marginVolatility,
    temporaryDisruption,
    normalizeMargins: stage === 'Cyclical' || stage === 'Turnaround' || stage === 'Financial',
    confidence,
    archetype: archetype.archetype, economicModel: archetype,
    diagnostics: { industry, marketCap, revenueDrawdown, marginRecovery, fcfStability, grossStability, pricing, moat, scalePenalty, archetype },
  };
}
module.exports = { classifyLifecycle };
