'use strict';

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

function classifyLifecycle(stock) {
  const ys = stock.financials?.years || [];
  const recent = ys.slice(-7);
  const last = recent.at(-1) || {};
  const rates = growthRates(recent);
  const historical = median(rates.slice(-5)) ?? 0;
  const historicalMean = mean(rates.slice(-5)) ?? historical;
  const growthVolatility = volatility(rates.slice(-5));
  const e = stock.analystEstimates || {};
  const forward1 = e.revenueGrowthCurrentYear ?? e.revenueGrowthFwd ?? stock.growthYear1 ?? historical;
  const forward2 = e.revenueGrowthNextYear ?? forward1;
  const forward = mean([forward1, forward2].filter(Number.isFinite)) ?? 0;
  const avgRoic = mean(recent.slice(-4).map(y => y.roic).filter(Number.isFinite));
  const positiveFcf = recent.length ? recent.filter(y => (y.fcf || 0) > 0).length / recent.length : 0;
  const op = recent.map(y => y.opMargin ?? (y.revenue > 0 && y.operatingIncome != null ? y.operatingIncome / y.revenue : null)).filter(Number.isFinite);
  const gross = recent.map(y => y.grossMargin).filter(Number.isFinite);
  const marginVolatility = volatility(op.slice(-5));
  const marginRecovery = op.length >= 3 && op.at(-1) > median(op.slice(0, -1)) + 0.02;
  const revenueDrawdown = rates.some(g => g < -0.08);
  const latestGrowth = rates.at(-1) ?? historical;
  const industry = stock.valuation?.industryModel?.model || '';
  const sector = String(stock.sector || '').toLowerCase();
  const dividendYield = stock.valuation?.dividendYield || 0;
  const marketCap = stock.valuation?.marketCap || 0;
  const fcfMargins = recent.map(y => y.revenue > 0 && y.fcf != null ? y.fcf / y.revenue : null).filter(Number.isFinite);
  const fcfStability = 1 - clamp(volatility(fcfMargins) / 0.18, 0, 1);

  const structuralFinancial = ['financials', 'reit', 'utilities'].includes(industry);
  const cyclicalIndustry = ['energy', 'materials', 'industrials', 'semiconductors-hardware'].includes(industry);
  const matureStaple = industry === 'consumer-staples' && forward < 0.12;

  // Detect a one-year disruption separately from structural deterioration. This is
  // useful for distribution/inventory events such as CELH: reported growth can drop
  // sharply while consensus, margins and the longer-term business remain intact.
  const temporaryDisruption = (
    latestGrowth < historicalMean - 0.10 || forward1 < historicalMean - 0.10
  ) && forward2 > forward1 + 0.04 && (gross.length < 2 || gross.at(-1) >= median(gross.slice(-4)) - 0.035) && positiveFcf >= 0.50;

  let stage;
  if (industry === 'financials') stage = 'Financial';
  else if (industry === 'reit') stage = 'Asset Heavy';
  else if (industry === 'utilities') stage = 'Utility';
  else if (temporaryDisruption && forward2 >= 0.10) stage = 'Temporary Disruption';
  else if (revenueDrawdown && marginRecovery && forward >= 0 && !cyclicalIndustry) stage = 'Turnaround';
  else if (cyclicalIndustry && (growthVolatility >= 0.12 || marginVolatility >= 0.055 || revenueDrawdown)) stage = 'Cyclical';
  else if (forward >= 0.25 && positiveFcf >= 0.40 && !matureStaple && !structuralFinancial) stage = 'Hyper Growth';
  else if (forward >= 0.14 && !matureStaple && !structuralFinancial) stage = 'Growth';
  else if (forward >= 0.075 && avgRoic != null && avgRoic >= 0.18 && positiveFcf >= 0.75 && fcfStability >= 0.45) stage = 'Elite Compounder';
  else if (forward >= 0.045 && avgRoic != null && avgRoic >= 0.10 && positiveFcf >= 0.60) stage = 'Compounder';
  else if (dividendYield >= 0.025 && forward < 0.08) stage = 'Dividend Compounder';
  else if (cyclicalIndustry) stage = 'Cyclical';
  else stage = 'Mature';

  // Mega-caps with moderate growth should not be labelled hyper-growth from a noisy
  // one-year estimate. Size changes the plausible growth duration and exit multiple.
  if (marketCap >= 150e9 && stage === 'Hyper Growth' && forward < 0.32) stage = 'Growth';
  if (marketCap >= 500e9 && stage === 'Growth' && forward < 0.16 && avgRoic >= 0.18) stage = 'Elite Compounder';

  const config = {
    'Hyper Growth': { forecastYears: 10, fadeYears: 12, terminalGrowth: 0.035, multipleFade: 'slow' },
    Growth: { forecastYears: 9, fadeYears: 11, terminalGrowth: 0.032, multipleFade: 'slow' },
    'Temporary Disruption': { forecastYears: 8, fadeYears: 10, terminalGrowth: 0.030, multipleFade: 'moderate-slow' },
    'Elite Compounder': { forecastYears: 8, fadeYears: 14, terminalGrowth: 0.032, multipleFade: 'very-slow' },
    Compounder: { forecastYears: 7, fadeYears: 11, terminalGrowth: 0.028, multipleFade: 'slow' },
    'Dividend Compounder': { forecastYears: 7, fadeYears: 9, terminalGrowth: 0.023, multipleFade: 'moderate' },
    Turnaround: { forecastYears: 6, fadeYears: 6, terminalGrowth: 0.022, multipleFade: 'moderate' },
    Cyclical: { forecastYears: 6, fadeYears: 5, terminalGrowth: 0.018, multipleFade: 'fast' },
    Financial: { forecastYears: 6, fadeYears: 8, terminalGrowth: 0.022, multipleFade: 'moderate' },
    Utility: { forecastYears: 6, fadeYears: 9, terminalGrowth: 0.022, multipleFade: 'moderate' },
    'Asset Heavy': { forecastYears: 6, fadeYears: 7, terminalGrowth: 0.018, multipleFade: 'fast' },
    Mature: { forecastYears: 5, fadeYears: 7, terminalGrowth: 0.022, multipleFade: 'moderate' },
  }[stage];

  const confidence = clamp(
    0.30 + (e.numAnalysts || 0) / 90 + Math.min(recent.length, 6) * 0.045 + positiveFcf * 0.14
      - growthVolatility * 0.45 - marginVolatility * 0.60,
    0.30,
    0.95
  );

  return {
    stage,
    ...config,
    forwardGrowth: forward,
    forwardGrowthYear1: forward1,
    forwardGrowthYear2: forward2,
    historicalGrowth: historical,
    historicalMeanGrowth: historicalMean,
    avgRoic,
    positiveFcfRate: positiveFcf,
    growthVolatility,
    marginVolatility,
    temporaryDisruption,
    normalizeMargins: stage === 'Cyclical' || stage === 'Turnaround' || stage === 'Financial',
    confidence,
    diagnostics: { industry, sector, marketCap, revenueDrawdown, marginRecovery, fcfStability },
  };
}

module.exports = { classifyLifecycle };
