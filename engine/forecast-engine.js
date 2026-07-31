'use strict';

const {
  generateBusinessForecast,
  deriveBusinessState,
  annualGrowthRates,
} = require('./business-forecast-engine');

function historicalGrowth(years) {
  const rates = annualGrowthRates(years || []).map(x => x.value);
  if (!rates.length) return null;
  const sorted = [...rates.slice(-5)].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function trendGrowth(years) {
  const rates = annualGrowthRates(years || []).map(x => x.value).slice(-3);
  if (!rates.length) return null;
  const weights = rates.map((_, i) => i + 1);
  return rates.reduce((s, x, i) => s + x * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
}

function generateForecast(stock, categoryOrLifecycle, years = 5, calibration = null) {
  const lifecycle = typeof categoryOrLifecycle === 'object' && categoryOrLifecycle
    ? categoryOrLifecycle
    : stock.valuation?.lifecycle || { stage: categoryOrLifecycle || null };
  return generateBusinessForecast(stock, lifecycle, years, calibration);
}

module.exports = { generateForecast, historicalGrowth, trendGrowth, deriveBusinessState };
