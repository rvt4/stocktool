'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

const METHOD_KEYS = ['dcf', 'dcfSBCAdjusted', 'ownerEarnings', 'revenueExit', 'epsExit', 'ebitdaExit'];

const INDUSTRY_BASE_WEIGHTS = {
  'semiconductors-hardware': { dcf: .45, dcfSBCAdjusted: .20, ownerEarnings: .03, revenueExit: .02, epsExit: .16, ebitdaExit: .14 },
  software:                  { dcf: .24, dcfSBCAdjusted: .16, ownerEarnings: .08, revenueExit: .20, epsExit: .18, ebitdaExit: .14 },
  financials:                { dcf: .25, dcfSBCAdjusted: .03, ownerEarnings: .12, revenueExit: .01, epsExit: .39, ebitdaExit: .20 },
  reit:                      { dcf: .23, dcfSBCAdjusted: .03, ownerEarnings: .15, revenueExit: .03, epsExit: .08, ebitdaExit: .48 },
  utilities:                 { dcf: .39, dcfSBCAdjusted: .05, ownerEarnings: .17, revenueExit: .01, epsExit: .16, ebitdaExit: .22 },
  energy:                    { dcf: .25, dcfSBCAdjusted: .04, ownerEarnings: .11, revenueExit: .02, epsExit: .13, ebitdaExit: .45 },
  communications:            { dcf: .31, dcfSBCAdjusted: .09, ownerEarnings: .15, revenueExit: .08, epsExit: .17, ebitdaExit: .20 },
  'consumer-staples':        { dcf: .30, dcfSBCAdjusted: .06, ownerEarnings: .20, revenueExit: .05, epsExit: .22, ebitdaExit: .17 },
  'consumer-discretionary':  { dcf: .29, dcfSBCAdjusted: .07, ownerEarnings: .16, revenueExit: .07, epsExit: .23, ebitdaExit: .18 },
  'healthcare-innovation':   { dcf: .29, dcfSBCAdjusted: .12, ownerEarnings: .08, revenueExit: .12, epsExit: .23, ebitdaExit: .16 },
  'healthcare-services':     { dcf: .32, dcfSBCAdjusted: .06, ownerEarnings: .18, revenueExit: .04, epsExit: .22, ebitdaExit: .18 },
  industrials:               { dcf: .30, dcfSBCAdjusted: .05, ownerEarnings: .17, revenueExit: .05, epsExit: .18, ebitdaExit: .25 },
  materials:                 { dcf: .25, dcfSBCAdjusted: .04, ownerEarnings: .13, revenueExit: .03, epsExit: .15, ebitdaExit: .40 },
  general:                   { dcf: .30, dcfSBCAdjusted: .08, ownerEarnings: .15, revenueExit: .08, epsExit: .21, ebitdaExit: .18 },
};

function normalize(weights) {
  const total = METHOD_KEYS.reduce((sum, key) => sum + Math.max(0, weights[key] || 0), 0);
  const out = {};
  for (const key of METHOD_KEYS) out[key] = total > 0 ? Math.max(0, weights[key] || 0) / total : 0;
  return out;
}

function consistency(values, floor = .05) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return .55;
  const avg = mean(clean);
  const variance = mean(clean.map(v => (v - avg) ** 2));
  const cv = Math.sqrt(variance) / Math.max(Math.abs(avg), floor);
  return clamp(1 - cv * .8, .15, 1);
}

function dataSuitability(stock, category, industry) {
  const years = stock.financials?.years || [];
  const recent = years.slice(-5);
  const last = recent.at(-1) || {};
  const analyst = stock.analystEstimates || {};
  const profile = stock.valuation?.businessProfile || {};

  const positiveFcfRate = recent.length ? recent.filter(y => Number.isFinite(y.fcf) && y.fcf > 0).length / recent.length : .4;
  const fcfMargins = recent.map(y => y.revenue > 0 && Number.isFinite(y.fcf) ? y.fcf / y.revenue : null).filter(Number.isFinite);
  const fcfStability = consistency(fcfMargins, .04);
  const positiveIncomeRate = recent.length ? recent.filter(y => Number.isFinite(y.netIncome) && y.netIncome > 0).length / recent.length : .4;
  const ebitdaCoverage = recent.length ? recent.filter(y => Number.isFinite(y.ebitda) && y.ebitda > 0).length / recent.length : .3;
  const hasDandA = Number.isFinite(last.da) || (Number.isFinite(last.ebitda) && Number.isFinite(last.operatingIncome));
  const hasCapex = Number.isFinite(last.capex);
  const ownerInputQuality = hasDandA && hasCapex ? 1 : hasDandA || hasCapex ? .42 : .15;
  const sbcIntensity = last.revenue > 0 && Number.isFinite(last.sbc) ? clamp(last.sbc / last.revenue, 0, .30) : 0;
  const hasEpsForecast = Number.isFinite(analyst.epsCurrentYear) || Number.isFinite(analyst.epsNextYear) || Number.isFinite(analyst.epsEstimateCurrentYear) || Number.isFinite(analyst.epsEstimateNextYear);
  const forecastReliability = clamp(profile.forecastReliability ?? .55, .15, 1);
  const growthStage = category === 'Hyper Growth' ? 1 : category === 'Growth' ? .85 : category === 'Compounder' ? .70 : .45;

  const suitability = {
    dcf: clamp(.35 + positiveFcfRate * .35 + fcfStability * .20 + forecastReliability * .10, .10, 1),
    dcfSBCAdjusted: clamp((.30 + positiveFcfRate * .30 + fcfStability * .15 + forecastReliability * .10) * (sbcIntensity > .02 ? 1 : .60), .08, 1),
    ownerEarnings: clamp(ownerInputQuality * (.45 + positiveIncomeRate * .35 + fcfStability * .20), .05, 1),
    revenueExit: clamp(.22 + growthStage * .35 + forecastReliability * .25 + (industry === 'software' ? .15 : 0), .10, 1),
    epsExit: clamp(.25 + positiveIncomeRate * .30 + forecastReliability * .25 + (hasEpsForecast ? .20 : 0), .10, 1),
    ebitdaExit: clamp(.20 + ebitdaCoverage * .35 + forecastReliability * .20 + (['industrials','materials','energy','reit'].includes(industry) ? .20 : .05), .10, 1),
  };

  // Fabless chip companies can have economically meaningful owner earnings, but the
  // standard D&A-minus-maintenance-capex shortcut is weak when those inputs are absent.
  if (industry === 'semiconductors-hardware') {
    suitability.ownerEarnings = Math.min(suitability.ownerEarnings, hasDandA && hasCapex ? .55 : .18);
    suitability.revenueExit *= .65;
  }
  if (industry === 'financials') {
    suitability.revenueExit = .08;
    suitability.ebitdaExit *= .65;
  }

  return {
    suitability,
    diagnostics: {
      positiveFcfRate, fcfStability, positiveIncomeRate, ebitdaCoverage,
      ownerInputQuality, hasDandA, hasCapex, sbcIntensity,
      hasEpsForecast, forecastReliability,
    },
  };
}

function selectValuationMethods(stock, category, methods) {
  const industry = stock.valuation?.industryModel?.model || 'general';
  const base = { ...(INDUSTRY_BASE_WEIGHTS[industry] || INDUSTRY_BASE_WEIGHTS.general) };
  const { suitability, diagnostics } = dataSuitability(stock, category, industry);
  const rawWeights = {};
  const excludedMethods = [];

  // V57: method applicability is a gate, not merely a soft weight. A valuation
  // method that is economically mismatched to the business cannot influence fair value.
  const applicabilityFloor = 0.25;

  for (const key of METHOD_KEYS) {
    const available = Number.isFinite(methods?.[key]) && methods[key] > 0;
    const applicable = available && (suitability[key] || 0) >= applicabilityFloor;
    rawWeights[key] = applicable ? (base[key] || 0) * (suitability[key] || .1) : 0;
    if (!available) excludedMethods.push({ method: key, reason: 'No valid valuation produced' });
    else if (!applicable) excludedMethods.push({ method: key, reason: 'Economically inapplicable', suitability: suitability[key], hardExcluded: true });
  }

  // V18 business-aware method weighting. High-quality scaling brands and innovation
  // businesses receive more weight on forward revenue/earnings methods; mature and
  // capital-intensive companies lean toward cash flow and EBITDA. This is systematic
  // by economics and industry, not by ticker.
  const lifecycle = stock.valuation?.lifecycle || {};
  const embeddedMoat = Number.isFinite(stock.valuation?.businessProfile?.moatScore) ? stock.valuation.businessProfile.moatScore * 100 : null;
  const moatScore = (stock.valuation?.moat?.score ?? embeddedMoat ?? 50) / 100;
  const pricingScore = (stock.valuation?.pricingPowerV2?.score ?? 50) / 100;
  const persistence = (lifecycle.growthPersistenceScore ?? lifecycle.compoundingPotential ?? 50) / 100;
  const highQualityGrowth = clamp((moatScore + pricingScore + persistence) / 3, 0, 1);
  const archetype=lifecycle.archetype||lifecycle.economicModel?.archetype||'';
  const consumerBrand = archetype==='Scaling Consumer Brand' || (['consumer-staples','consumer-discretionary'].includes(industry)
    && (lifecycle.forwardGrowth ?? 0) >= .10 && highQualityGrowth >= .48);
  const innovation = ['software','healthcare-innovation'].includes(industry);
  const matureCash = ['utilities','financials','reit','energy','materials'].includes(industry)
    || ['Mature','Dividend Compounder','Cyclical'].includes(lifecycle.stage);

  if (consumerBrand) {
    rawWeights.revenueExit *= archetype==='Scaling Consumer Brand'?2.25:1.75;
    rawWeights.epsExit *= archetype==='Scaling Consumer Brand'?1.55:1.25;
    rawWeights.dcf *= 1.12;
    rawWeights.ownerEarnings *= archetype==='Scaling Consumer Brand'?.55:.72;
  }
  if (innovation && highQualityGrowth >= .55) {
    rawWeights.revenueExit *= 1.45;
    rawWeights.dcfSBCAdjusted *= 1.15;
    rawWeights.ownerEarnings *= .70;
  }
  if (matureCash) {
    rawWeights.dcf *= 1.15;
    rawWeights.ownerEarnings *= 1.18;
    rawWeights.ebitdaExit *= 1.12;
    rawWeights.revenueExit *= .55;
  }

  const weights = normalize(rawWeights);
  const ranked = METHOD_KEYS
    .filter(k => weights[k] > 0)
    .sort((a, b) => weights[b] - weights[a]);

  return {
    version: 'business-model-first-v57',
    industry,
    category,
    primaryMethod: ranked[0] || null,
    supportingMethods: ranked.slice(1, 4),
    weakMethods: ranked.slice(4),
    baseWeights: normalize(base),
    suitability,
    effectiveStartingWeights: weights,
    diagnostics: { ...diagnostics, highQualityGrowth, consumerBrand, innovation, matureCash, archetype },
    excludedMethods,
  };
}

module.exports = { selectValuationMethods, INDUSTRY_BASE_WEIGHTS };
