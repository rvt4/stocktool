'use strict';

function compactStock(stock) {
  return {
    ticker: stock.ticker,
    price: stock.price?.current ?? stock.currentPrice ?? null,
    category: stock.valuation?.category ?? stock.category ?? null,
    industry: stock.valuation?.industryModel?.key ?? stock.valuation?.industryModel?.industry ?? stock.industryModel?.key ?? stock.industryModel?.industry ?? null,
    expectedCAGR: stock.valuation?.expectedReturnProfile?.expectedCAGR ?? stock.expectedReturnProfile?.expectedCAGR ?? stock.expectedReturn ?? null,
    riskAdjustedCAGR: stock.valuation?.expectedReturnProfile?.riskAdjustedCAGR ?? stock.expectedReturnProfile?.riskAdjustedCAGR ?? stock.riskAdjustedReturn ?? null,
    fairValue: stock.valuation?.fairValueEstimate ?? stock.fairValueEstimate ?? null,
    rating: stock.rating ?? null,
  };
}

function updateForecastHistory(history, stocks, date = new Date()) {
  const out = history && Array.isArray(history.snapshots) ? history : { version: 1, snapshots: [] };
  const iso = date.toISOString();
  const last = out.snapshots.at(-1);
  const daysSince = last ? (date - new Date(last.date)) / 86400000 : Infinity;
  if (daysSince < 27) return out;
  out.snapshots.push({ date: iso, stocks: stocks.map(compactStock) });
  // Keep five years of monthly snapshots.
  out.snapshots = out.snapshots.filter(s => (date - new Date(s.date)) / 86400000 <= 365 * 5);
  return out;
}

module.exports = { updateForecastHistory };
