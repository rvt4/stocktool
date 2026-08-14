'use strict';
const { HORIZON_YEARS, sectorConfig, clamp, rate, median } = require('./config');

function cagr(a, b, years) {
  if (!(a > 0) || !(b > 0) || !(years > 0)) return null;
  return Math.pow(b / a, 1 / years) - 1;
}

function yoySeries(years, field) {
  const out = [];
  for (let i = 1; i < years.length; i++) {
    const a = Number(years[i - 1]?.[field]);
    const b = Number(years[i]?.[field]);
    if (a > 0 && Number.isFinite(b)) out.push(b / a - 1);
  }
  return out;
}

function trendRate(years, field, lo, hi) {
  const vals = years.slice(-4).map(y => Number(y?.[field])).filter(Number.isFinite);
  if (vals.length < 2 || Math.abs(vals[0]) < 1e-9) return 0;
  return clamp((vals[vals.length - 1] - vals[0]) / Math.max(1, vals.length - 1), lo, hi) || 0;
}

function normalizedMargin(years, field, fallback = 0) {
  const vals = years.slice(-4).map(y => Number(y?.[field])).filter(Number.isFinite);
  if (!vals.length) return fallback;
  const med = median(vals);
  const latest = vals[vals.length - 1];
  return 0.6 * latest + 0.4 * med;
}

function classifyCategory(growth, qualityHint, dividendYield) {
  if (growth >= 0.25) return 'Hyper Growth';
  if (growth >= 0.12) return 'Growth';
  if (qualityHint >= 0.75 && growth >= 0.05) return 'Compounder';
  if (dividendYield >= 0.025) return 'Dividend';
  return 'Value';
}

function buildForecast(stock) {
  const years = stock.financials?.years || [];
  const last = years[years.length - 1] || {};
  const prev = years[years.length - 2] || {};
  const cfg = sectorConfig(stock.sector);
  const analyst = stock.analystEstimates || {};

  const histYoY = yoySeries(years.slice(-5), 'revenue').filter(x => x > -0.8 && x < 2.0);
  const histMedianGrowth = median(histYoY);
  const histCagr = years.length >= 3 ? cagr(Number(years[Math.max(0, years.length - 4)]?.revenue), Number(last.revenue), Math.min(3, years.length - 1)) : null;
  const historicalAnchor = clamp(median([histMedianGrowth, histCagr].filter(Number.isFinite)) ?? 0.04, -0.10, 0.35);

  const a1 = rate(analyst.revenueGrowthCurrentYear ?? analyst.revenueGrowthFwd);
  const a2 = rate(analyst.revenueGrowthNextYear);
  const y1 = clamp(a1 != null ? 0.75 * a1 + 0.25 * historicalAnchor : (rate(stock.growthYear1) ?? historicalAnchor), -0.20, 0.45);
  const y2 = clamp(a2 != null ? 0.80 * a2 + 0.20 * historicalAnchor : 0.72 * y1 + 0.28 * historicalAnchor, -0.15, 0.40);

  const latestROIC = Number(last.roic);
  const latestFCFMargin = Number(last.revenue) > 0 && Number.isFinite(Number(last.fcf)) ? Number(last.fcf) / Number(last.revenue) : null;
  const qualityHint = clamp((Number.isFinite(latestROIC) ? clamp(latestROIC / 0.25, 0, 1) : 0.45) * 0.55 + (latestFCFMargin > 0 ? 0.45 : 0.15), 0, 1) || 0.5;
  const terminalGrowth = clamp(cfg.terminalGrowth + (qualityHint - 0.5) * 0.012, 0.015, 0.055);

  const growthPath = [y1, y2];
  for (let i = 2; i < HORIZON_YEARS; i++) {
    const t = (i - 1) / (HORIZON_YEARS - 2);
    const target = terminalGrowth + Math.max(0, y2 - terminalGrowth) * 0.35;
    growthPath.push(clamp(y2 * (1 - t) + target * t, -0.10, 0.35));
  }

  const latestRev = Number(last.revenue);
  const startRev = latestRev > 0 ? latestRev : null;
  const rawFCFMargin = normalizedMargin(years.map(y => ({ x: Number(y.revenue) > 0 && Number.isFinite(Number(y.fcfSBCAdjusted ?? y.fcf)) ? Number(y.fcfSBCAdjusted ?? y.fcf) / Number(y.revenue) : null })).map(x => ({ margin: x.x })), 'margin', 0.05);
  const rawEBITDAMargin = normalizedMargin(years.map(y => ({ margin: Number(y.revenue) > 0 && Number.isFinite(Number(y.ebitda)) ? Number(y.ebitda) / Number(y.revenue) : null })), 'margin', 0.10);
  const rawNetMargin = normalizedMargin(years.map(y => ({ margin: Number(y.revenue) > 0 && Number.isFinite(Number(y.netIncome)) ? Number(y.netIncome) / Number(y.revenue) : null })), 'margin', 0.06);

  const fcfTrend = trendRate(years.map(y => ({ margin: Number(y.revenue) > 0 && Number.isFinite(Number(y.fcfSBCAdjusted ?? y.fcf)) ? Number(y.fcfSBCAdjusted ?? y.fcf) / Number(y.revenue) : null })), 'margin', -0.015, 0.015);
  const ebitdaTrend = trendRate(years.map(y => ({ margin: Number(y.revenue) > 0 && Number.isFinite(Number(y.ebitda)) ? Number(y.ebitda) / Number(y.revenue) : null })), 'margin', -0.012, 0.012);
  const netTrend = trendRate(years.map(y => ({ margin: Number(y.revenue) > 0 && Number.isFinite(Number(y.netIncome)) ? Number(y.netIncome) / Number(y.revenue) : null })), 'margin', -0.012, 0.012);

  const shareGrowthHist = yoySeries(years.slice(-4), 'sharesOutTTM');
  const dilutionRate = clamp(median(shareGrowthHist) ?? 0, -0.05, 0.08);
  const startShares = Number(last.sharesOutTTM) > 0 ? Number(last.sharesOutTTM) : null;
  const startDividend = Math.max(0, Number(last.dividendPerShare) || 0);
  const dividendGrowth = clamp(Math.min(Math.max(y2, 0), 0.06), 0, 0.06);

  const rows = [];
  let revenue = startRev;
  let shares = startShares;
  let dividend = startDividend;
  for (let i = 0; i < HORIZON_YEARS; i++) {
    if (revenue != null) revenue *= 1 + growthPath[i];
    if (shares != null) shares *= 1 + dilutionRate;
    dividend *= 1 + dividendGrowth;

    const fade = (i + 1) / HORIZON_YEARS;
    const fcfMargin = clamp(rawFCFMargin + fcfTrend * (i + 1) * 0.45, -0.08, cfg.maxFCFMargin);
    const ebitdaMargin = clamp(rawEBITDAMargin + ebitdaTrend * (i + 1) * 0.45, -0.05, Math.min(0.65, cfg.maxFCFMargin + 0.18));
    const netMargin = clamp(rawNetMargin + netTrend * (i + 1) * 0.35, -0.08, Math.min(0.50, cfg.maxFCFMargin + 0.08));
    const fcf = revenue != null ? revenue * fcfMargin : null;
    const ebitda = revenue != null ? revenue * ebitdaMargin : null;
    const netIncome = revenue != null ? revenue * netMargin : null;
    const eps = shares > 0 && netIncome != null ? netIncome / shares : null;
    const fcfPerShare = shares > 0 && fcf != null ? fcf / shares : null;
    rows.push({ year: (Number(last.year) || new Date().getFullYear()) + i + 1, revenueGrowth: growthPath[i], revenue, fcfMargin, ebitdaMargin, netMargin, fcf, ebitda, netIncome, shares, eps, fcfPerShare, dividendPerShare: dividend, fade });
  }

  const category = classifyCategory(y1, qualityHint, Number(stock.valuation?.dividendYield) || 0);
  return {
    horizonYears: HORIZON_YEARS,
    category,
    rows,
    terminalGrowth,
    revenueGrowthAnchor: y1,
    historicalGrowth: historicalAnchor,
    dilutionRate,
    startRevenue: startRev,
    startShares,
    marginAssumptions: { fcf: rawFCFMargin, ebitda: rawEBITDAMargin, net: rawNetMargin },
    analystUsed: a1 != null || a2 != null,
  };
}

module.exports = { buildForecast };
