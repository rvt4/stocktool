'use strict';
const { bucketSize } = require('./learning-engine');

function compactStock(stock) {
  const growth = stock.valuation?.projectionAssumptions?.growthModel?.assumptions || {};
  const last = stock.financials?.years?.at(-1) || {};
  const current = Number(stock.price?.current ?? stock.currentPrice);
  const dividendYield = Number(stock.valuation?.dividendYield || 0);
  return {
    ticker: stock.ticker,
    price: Number.isFinite(current) ? current : null,
    datePriceCaptured: new Date().toISOString(),
    category: stock.valuation?.category ?? stock.category ?? null,
    industry: stock.valuation?.industryModel?.model ?? stock.valuation?.industryModel?.key ?? 'general',
    marketCap: stock.valuation?.marketCap ?? stock.marketCap ?? null,
    sizeBucket: bucketSize(stock.valuation?.marketCap ?? stock.marketCap),
    economicQuality: stock.valuation?.economicQuality ?? null,
    expectedCAGR: stock.valuation?.expectedReturnProfile?.expectedCAGR ?? stock.expectedReturn ?? null,
    riskAdjustedCAGR: stock.valuation?.expectedReturnProfile?.riskAdjustedCAGR ?? null,
    scenarioCAGRs: {
      bear: stock.valuation?.scenarioAnalysis?.downsideCAGR ?? null,
      base: stock.valuation?.scenarioAnalysis?.baseCAGR ?? null,
      bull: stock.valuation?.scenarioAnalysis?.upsideCAGR ?? null,
    },
    fairValue: stock.valuation?.fairValueEstimate ?? null,
    rating: stock.rating ?? null,
    baseRevenue: last.revenue ?? null,
    forecastGrowth: growth.year1 ?? null,
    analystGrowth: growth.analyst1 ?? stock.analystEstimates?.revenueGrowthCurrentYear ?? null,
    historicalGrowth: growth.historical ?? null,
    methodFairValues: stock.valuation?.valuationMethods ?? null,
    effectiveWeights: stock.valuation?.effectiveWeights ?? null,
    dividendsPerShare: Number.isFinite(dividendYield) && Number.isFinite(current) ? dividendYield * current : 0,
    forecastVersion: stock.valuation?.projectionAssumptions?.version ?? null,
    engineVersion: '23.0-self-calibrating-foundation',
  };
}

function updateForecastHistory(history, stocks, date = new Date()) {
  const out = history && Array.isArray(history.snapshots) ? history : { version: 3, snapshots: [] };
  out.version = 3;
  const last = out.snapshots.at(-1);
  const daysSince = last ? (date - new Date(last.date)) / 86400000 : Infinity;
  if (daysSince < 27) return out;
  out.snapshots.push({ date: date.toISOString(), engineVersion: '23.0-self-calibrating-foundation', stocks: stocks.map(compactStock) });
  out.snapshots = out.snapshots.filter(s => (date - new Date(s.date)) / 86400000 <= 365 * 7);
  return out;
}
module.exports = { updateForecastHistory, compactStock };
