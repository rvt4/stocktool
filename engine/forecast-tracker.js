'use strict';

function compactStock(stock) {
  const growth = stock.valuation?.projectionAssumptions?.growthModel?.assumptions || {};
  const last = stock.financials?.years?.at(-1) || {};
  return {
    ticker: stock.ticker,
    price: stock.price?.current ?? stock.currentPrice ?? null,
    category: stock.valuation?.category ?? stock.category ?? null,
    industry: stock.valuation?.industryModel?.model ?? stock.valuation?.industryModel?.key ?? null,
    expectedCAGR: stock.valuation?.expectedReturnProfile?.expectedCAGR ?? stock.expectedReturn ?? null,
    riskAdjustedCAGR: stock.valuation?.expectedReturnProfile?.riskAdjustedCAGR ?? null,
    fairValue: stock.valuation?.fairValueEstimate ?? null,
    rating: stock.rating ?? null,
    baseRevenue: last.revenue ?? null,
    forecastGrowth: growth.year1 ?? null,
    analystGrowth: growth.analyst1 ?? stock.analystEstimates?.revenueGrowthCurrentYear ?? null,
    historicalGrowth: growth.historical ?? null,
    methodFairValues: stock.valuation?.valuationMethods ?? null,
    effectiveWeights: stock.valuation?.effectiveWeights ?? null,
    forecastVersion: stock.valuation?.projectionAssumptions?.version ?? null,
  };
}
function updateForecastHistory(history, stocks, date = new Date()) {
  const out = history && Array.isArray(history.snapshots) ? history : { version: 2, snapshots: [] };
  out.version = 2;
  const last = out.snapshots.at(-1);
  const daysSince = last ? (date - new Date(last.date)) / 86400000 : Infinity;
  if (daysSince < 27) return out;
  out.snapshots.push({ date: date.toISOString(), stocks: stocks.map(compactStock) });
  out.snapshots = out.snapshots.filter(s => (date - new Date(s.date)) / 86400000 <= 365 * 5);
  return out;
}
module.exports = { updateForecastHistory };
