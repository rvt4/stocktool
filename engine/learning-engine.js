'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(a) { const c = a.filter(Number.isFinite); return c.length ? c.reduce((s, x) => s + x, 0) / c.length : null; }
function median(a) { const c = a.filter(Number.isFinite).sort((x,y)=>x-y); if(!c.length)return null; const m=Math.floor(c.length/2); return c.length%2?c[m]:(c[m-1]+c[m])/2; }
function annualized(start, end, days, cash = 0) {
  if (!(start > 0) || !(end + cash > 0) || !(days >= 180)) return null;
  return Math.pow((end + cash) / start, 365 / days) - 1;
}
function bucketSize(marketCap) {
  if (!(marketCap > 0)) return 'unknown';
  if (marketCap < 2e9) return 'small';
  if (marketCap < 10e9) return 'mid';
  if (marketCap < 100e9) return 'large';
  return 'mega';
}
function summarize(rows, minN = 12) {
  const errors = rows.map(r => r.error).filter(Number.isFinite);
  const n = errors.length;
  const bias = mean(errors);
  const mae = mean(errors.map(Math.abs));
  return { observations: n, bias, medianBias: median(errors), mae, adjustment: n >= minN ? clamp((bias || 0) * 0.18, -0.03, 0.025) : 0 };
}
function grouped(rows, key, minN) {
  const out = {};
  for (const name of new Set(rows.map(r => r[key] || 'unknown'))) out[name] = summarize(rows.filter(r => (r[key] || 'unknown') === name), minN);
  return out;
}

function buildLearningModel(history, currentByTicker, now = new Date()) {
  const returns = [], methods = [], forecasts = [];
  for (const snap of history?.snapshots || []) {
    const ageDays = (now - new Date(snap.date)) / 86400000;
    if (ageDays < 330) continue;
    for (const old of snap.stocks || []) {
      const cur = currentByTicker.get(old.ticker);
      const currentPrice = Number(cur?.price?.current);
      if (!(currentPrice > 0) || !(old.price > 0)) continue;
      const realized = annualized(old.price, currentPrice, ageDays, Number(old.dividendsPerShare || 0));
      if (!Number.isFinite(realized)) continue;
      const industry = old.industry || 'general';
      const category = old.category || 'Unknown';
      const size = old.sizeBucket || bucketSize(old.marketCap);
      if (Number.isFinite(old.expectedCAGR)) returns.push({ industry, category, size, horizonDays: ageDays, error: realized - old.expectedCAGR });

      const horizonYears = ageDays / 365;
      for (const [method, fairValue] of Object.entries(old.methodFairValues || {})) {
        if (!(fairValue > 0)) continue;
        const implied = Math.pow(fairValue / old.price, 1 / Math.max(1, horizonYears)) - 1;
        if (Number.isFinite(implied)) methods.push({ industry, category, size, method, error: realized - implied });
      }

      const currentRevenue = Number(cur.financials?.years?.at(-1)?.revenue);
      if (old.baseRevenue > 0 && currentRevenue > 0) {
        const actualGrowth = Math.pow(currentRevenue / old.baseRevenue, 365 / ageDays) - 1;
        for (const [source, predicted] of [['own', old.forecastGrowth], ['analyst', old.analystGrowth], ['history', old.historicalGrowth]]) {
          if (Number.isFinite(predicted)) forecasts.push({ industry, category, source, error: actualGrowth - predicted });
        }
      }
    }
  }

  const methodAccuracy = {};
  for (const industry of new Set(methods.map(r => r.industry))) {
    methodAccuracy[industry] = {};
    for (const method of new Set(methods.filter(r => r.industry === industry).map(r => r.method))) {
      methodAccuracy[industry][method] = summarize(methods.filter(r => r.industry === industry && r.method === method), 20);
    }
  }
  const forecastAccuracy = {};
  for (const industry of new Set(forecasts.map(r => r.industry))) {
    forecastAccuracy[industry] = {};
    for (const source of ['own','analyst','history']) forecastAccuracy[industry][source] = summarize(forecasts.filter(r => r.industry === industry && r.source === source), 16);
  }

  return {
    version: 'learning-model-v1', generatedAt: now.toISOString(),
    matureReturnObservations: returns.length,
    learningActive: returns.length >= 100,
    overall: summarize(returns, 100),
    byIndustry: grouped(returns, 'industry', 30),
    byCategory: grouped(returns, 'category', 30),
    bySize: grouped(returns, 'size', 30),
    methodAccuracy,
    forecastAccuracy,
    safeguards: { minimumMatureReturnObservations: 100, minimumMethodObservations: 20, maxReturnAdjustment: 0.03 },
  };
}

function applyLearnedReturnCalibration(profile, stock, model) {
  if (!profile || !Number.isFinite(profile.expectedCAGR)) return { ...profile, calibrationAdjustment: 0, calibrationActive: false };
  const industry = stock.valuation?.industryModel?.model || 'general';
  const category = stock.valuation?.category || stock.category || 'Unknown';
  const size = bucketSize(stock.valuation?.marketCap || stock.marketCap);
  if (!model?.learningActive) return { ...profile, calibrationAdjustment: 0, calibrationActive: false, calibrationObservationCount: model?.matureReturnObservations || 0 };
  const parts = [
    [model.byIndustry?.[industry], .45],
    [model.byCategory?.[category], .25],
    [model.bySize?.[size], .15],
    [model.overall, .15],
  ];
  const adjustment = clamp(parts.reduce((s,[x,w]) => s + (Number(x?.adjustment) || 0) * w, 0), -0.03, 0.025);
  return {
    ...profile,
    uncalibratedExpectedCAGR: profile.expectedCAGR,
    uncalibratedRiskAdjustedCAGR: profile.riskAdjustedCAGR,
    expectedCAGR: profile.expectedCAGR + adjustment,
    riskAdjustedCAGR: Number.isFinite(profile.riskAdjustedCAGR) ? profile.riskAdjustedCAGR + adjustment : null,
    calibrationAdjustment: adjustment,
    calibrationActive: true,
    calibrationObservationCount: model.matureReturnObservations,
  };
}

module.exports = { buildLearningModel, applyLearnedReturnCalibration, bucketSize };
