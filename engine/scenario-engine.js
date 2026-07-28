'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

const CATEGORY_SPREAD = {
  'Hyper Growth': { growth: 0.10, margin: 0.035, multiple: 0.24 },
  Growth:         { growth: 0.07, margin: 0.025, multiple: 0.18 },
  Compounder:     { growth: 0.04, margin: 0.018, multiple: 0.12 },
  Dividend:       { growth: 0.025, margin: 0.012, multiple: 0.10 },
  Value:          { growth: 0.035, margin: 0.018, multiple: 0.14 },
  Turnaround:     { growth: 0.07, margin: 0.040, multiple: 0.22 },
  Cyclical:       { growth: 0.09, margin: 0.050, multiple: 0.25 },
};

function scenarioProbabilities(stock, integrity, profile) {
  const reliability = profile?.forecastReliability ?? 0.5;
  const analyst = stock.valuation?.analystReliability ?? 0.5;
  const quality = profile?.moatScore ?? 0.5;
  const data = integrity.score / 100;

  const confidence = clamp(reliability * 0.32 + analyst * 0.22 + quality * 0.20 + data * 0.26, 0, 1);
  const base = clamp(0.48 + (confidence - 0.5) * 0.30, 0.38, 0.64);
  const bear = clamp(0.34 - (confidence - 0.5) * 0.20, 0.18, 0.40);
  const bull = 1 - base - bear;
  return { bear, base, bull, confidence };
}

function buildScenarios(stock, valuationResult, integrity) {
  const category = valuationResult.category || 'Value';
  const spread = CATEGORY_SPREAD[category] || CATEGORY_SPREAD.Value;
  const profile = valuationResult.businessProfile || {};
  const projection = valuationResult.projection || [];
  const baseTarget = valuationResult.fiveYearPriceTarget || {};
  const currentPrice = stock.price?.current;
  const years = baseTarget.years || 5;
  const baseExit = baseTarget.exitPrice;
  const dividends = baseTarget.dividendsReceived || 0;

  if (!(currentPrice > 0) || !(baseExit > 0)) {
    return { probabilities: scenarioProbabilities(stock, integrity, profile), scenarios: null, expectedCAGR: null };
  }

  const p = scenarioProbabilities(stock, integrity, profile);
  const pricing = (stock.pricingPowerScore ?? stock.pricingPower?.score ?? 50) / 100;
  const moat = profile.moatScore ?? 0.5;
  const fragility = 1 - clamp((pricing + moat + p.confidence) / 3, 0, 1);

  const bearGrowthPenalty = spread.growth * (0.80 + fragility * 0.50);
  const bullGrowthBoost = spread.growth * (0.75 + moat * 0.40);
  const bearMultiple = 1 - spread.multiple * (0.90 + fragility * 0.45);
  const bullMultiple = 1 + spread.multiple * (0.70 + pricing * 0.45);

  const baseCagr = Math.pow((baseExit + dividends) / currentPrice, 1 / years) - 1;
  const bearExit = Math.max(0.01, baseExit * bearMultiple * Math.pow(1 - bearGrowthPenalty, years));
  const bullExit = baseExit * bullMultiple * Math.pow(1 + bullGrowthBoost, years);

  const bearCagr = Math.pow((bearExit + dividends * 0.75) / currentPrice, 1 / years) - 1;
  const bullCagr = Math.pow((bullExit + dividends * 1.10) / currentPrice, 1 / years) - 1;
  const expectedCAGR = bearCagr * p.bear + baseCagr * p.base + bullCagr * p.bull;

  return {
    probabilities: p,
    scenarios: {
      bear: {
        probability: p.bear,
        cagr: clamp(bearCagr, -0.60, 1.00),
        exitPrice: bearExit,
        description: 'Lower growth, weaker margins, and multiple compression',
      },
      base: {
        probability: p.base,
        cagr: clamp(baseCagr, -0.60, 1.00),
        exitPrice: baseExit,
        description: 'Unified five-year operating forecast and mean-reverted exit multiple',
      },
      bull: {
        probability: p.bull,
        cagr: clamp(bullCagr, -0.60, 1.20),
        exitPrice: bullExit,
        description: 'Stronger growth persistence, operating leverage, and premium retention',
      },
    },
    expectedCAGR: clamp(expectedCAGR, -0.60, 1.00),
    expectedFutureValue:
      currentPrice * Math.pow(1 + clamp(expectedCAGR, -0.60, 1.00), years),
    downsideCAGR: clamp(bearCagr, -0.60, 1.00),
    upsideCAGR: clamp(bullCagr, -0.60, 1.20),
    years,
    drivers: {
      category,
      forecastConfidence: p.confidence,
      moat,
      pricingPower: pricing,
      baseProjectionYears: projection.length,
    },
  };
}

module.exports = { buildScenarios };
