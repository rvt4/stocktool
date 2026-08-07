'use strict';

const { computeCapitalAllocationV2 } = require('./capital-allocation-v2');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));
const clean = a => (a || []).filter(finite).map(Number);
const mean = a => { const c = clean(a); return c.length ? c.reduce((s, x) => s + x, 0) / c.length : null; };
const median = a => { const c = clean(a).sort((x, y) => x - y); if (!c.length) return null; const m = Math.floor(c.length / 2); return c.length % 2 ? c[m] : (c[m - 1] + c[m]) / 2; };
const volatility = a => { const c = clean(a); if (c.length < 3) return null; const m = mean(c); return Math.sqrt(mean(c.map(x => (x - m) ** 2))); };
const higher = (v, poor, strong, fallback = 50) => finite(v) ? Math.round(clamp((Number(v) - poor) / (strong - poor), 0, 1) * 100) : fallback;
const lower = (v, strong, poor, fallback = 50) => finite(v) ? Math.round(clamp((poor - Number(v)) / (poor - strong), 0, 1) * 100) : fallback;

function growthRates(years, field = 'revenue') {
  const out = [];
  for (let i = 1; i < years.length; i++) {
    const a = Number(years[i - 1]?.[field]);
    const b = Number(years[i]?.[field]);
    if (a > 0 && b > 0) out.push(b / a - 1);
  }
  return out;
}

function computeDurability(stock, pricingPower, compounder, lifecycle = null) {
  const years = (stock.financials?.years || []).slice(-8);
  const opMargins = years.map(y => y.operatingMargin ?? y.opMargin);
  const grossMargins = years.map(y => y.grossMargin);
  const industry = stock.valuation?.industryModel?.model || 'general';
  const financialStructure = industry === 'financials';
  // For asset-heavy reinvesters, reported FCF can be negative because growth capex is
  // buying productive assets. Use a maintenance-capex owner-cash proxy for durability
  // when CFO and earnings are positive and capex materially exceeds D&A.
  const normalizedCashMargins = years.map(y => {
    if (!(y.revenue > 0)) return null;
    const raw = finite(y.fcf) ? Number(y.fcf) / y.revenue : null;
    const da = finite(y.da) ? Math.abs(Number(y.da)) : (finite(y.ebitda) && finite(y.operatingIncome) ? Math.max(0, Number(y.ebitda) - Number(y.operatingIncome)) : null);
    const capex = finite(y.capex) ? Math.abs(Number(y.capex)) : null;
    const growthCapexPattern = finite(y.cfo) && Number(y.cfo) > 0 && finite(y.netIncome) && Number(y.netIncome) > 0 && da != null && capex != null && capex > da * 1.35;
    if (growthCapexPattern) return (Number(y.cfo) - Math.min(capex, da * 1.10)) / y.revenue;
    return raw;
  });
  const fcfMargins = financialStructure ? years.map(y => y.revenue > 0 && finite(y.netIncome) ? Number(y.netIncome) / y.revenue : null) : normalizedCashMargins;
  const revenueGrowth = growthRates(years);
  const positiveFcf = years.length ? years.filter((y,i) => financialStructure ? Number(y.netIncome) > 0 : Number(normalizedCashMargins[i]) > 0).length / years.length : null;
  const positiveIncome = years.length ? years.filter(y => Number(y.netIncome) > 0).length / years.length : null;
  const marginStability = Math.round((lower(volatility(opMargins), .01, .12) + lower(volatility(grossMargins), .01, .12) + lower(volatility(fcfMargins), .015, .16)) / 3);
  const growthStability = lower(volatility(revenueGrowth), .025, .22);
  let recessionResistance = higher(financialStructure ? (positiveIncome ?? .5) : Math.min(positiveFcf ?? .5, positiveIncome ?? .5), .35, 1);
  // V61: for verified profitability inflections, the distant loss years describe
  // the old investment phase rather than current durability. Blend in the most
  // recent three-year cash/earnings record instead of treating the sign change as
  // evidence of ordinary cyclicality.
  if (lifecycle?.profitabilityInflection && years.length >= 3) {
    const latest3 = years.slice(-3);
    const recentFcf = latest3.filter(y => Number(y.fcf) > 0).length / latest3.length;
    const recentIncome = latest3.filter(y => Number(y.netIncome) > 0).length / latest3.length;
    const recentResistance = higher(Math.min(recentFcf, recentIncome), .35, 1);
    recessionResistance = Math.round(recessionResistance * .35 + recentResistance * .65);
  }
  const pricing = clamp(Number(pricingPower?.score ?? 50), 0, 100);
  const compound = clamp(Number(compounder?.score ?? 50), 0, 100);
  const score = Math.round(clamp(marginStability * .28 + growthStability * .20 + recessionResistance * .22 + pricing * .14 + compound * .16, 0, 100));
  return { score, marginStability, growthStability, recessionResistance, positiveFcfRate: positiveFcf, positiveIncomeRate: positiveIncome };
}

function computeRunway(stock, lifecycle, compounder) {
  const years = (stock.financials?.years || []).slice(-6);
  const recentGrowth = mean(growthRates(years).slice(-3));
  const forwardGrowth = Number(lifecycle?.forwardGrowth ?? stock.analystEstimates?.revenueGrowthNextFY ?? recentGrowth);
  const persistence = Number(lifecycle?.growthPersistenceScore ?? compounder?.growthQualityScore ?? compounder?.score ?? 50);
  const scale = Number(stock.marketCap ?? stock.profile?.marketCapitalization ?? 0);
  const scalePenalty = scale > 1e12 ? 18 : scale > 3e11 ? 12 : scale > 1e11 ? 7 : scale > 3e10 ? 3 : 0;
  const reinvestment = higher(median(years.map(y => Math.abs(Number(y.roic)) > 2 ? Number(y.roic) / 100 : Number(y.roic))), .04, .25);
  const forward = higher(forwardGrowth, .03, .22);
  const score = Math.round(clamp(forward * .42 + clamp(persistence, 0, 100) * .32 + reinvestment * .26 - scalePenalty, 0, 100));
  return { score, forwardGrowth: finite(forwardGrowth) ? forwardGrowth : null, persistenceScore: clamp(persistence, 0, 100), scalePenalty };
}

function computeIndustryStructure(industryModel = {}) {
  const model = industryModel.model || industryModel.key || 'general';
  const anchors = {
    software: 86, 'healthcare-innovation': 76, 'healthcare-services': 65,
    financials: 63, communications: 66, 'consumer-staples': 72,
    'consumer-discretionary': 58, 'semiconductors-hardware': 68,
    industrials: 57, utilities: 64, reit: 55, energy: 38, materials: 42, general: 55,
  };
  const base = anchors[model] ?? anchors.general;
  const competitive = finite(industryModel.competitiveIntensity) ? (1 - clamp(Number(industryModel.competitiveIntensity), 0, 1)) * 100 : 50;
  const regulation = finite(industryModel.regulatoryDurability) ? clamp(Number(industryModel.regulatoryDurability), 0, 1) * 100 : 50;
  const score = Math.round(clamp(base * .70 + competitive * .20 + regulation * .10, 0, 100));
  return { score, model, base, competitiveStructure: Math.round(competitive), regulatoryDurability: Math.round(regulation) };
}

function computeCapitalIntensity(stock, industryModel = {}) {
  const years = (stock.financials?.years || []).slice(-6);
  const capexMargins = years.map(y => y.revenue > 0 && finite(y.capex) ? Math.abs(Number(y.capex)) / Number(y.revenue) : null);
  const daMargins = years.map(y => y.revenue > 0 && finite(y.depreciationAndAmortization) ? Math.abs(Number(y.depreciationAndAmortization)) / Number(y.revenue) : null);
  const capex = median(capexMargins);
  const da = median(daMargins);
  const industry = industryModel.model || industryModel.key || 'general';
  const industryFallback = ['software', 'financials', 'communications'].includes(industry) ? 78 : ['utilities', 'energy', 'materials'].includes(industry) ? 28 : 52;
  const score = finite(capex) ? lower(capex, .015, .18) : industryFallback;
  return { score, capitalLightScore: score, capexMargin: capex, depreciationMargin: da };
}

function computeForecastReliability(stock, durability) {
  const analyst = stock.analystEstimates || stock.analyst || {};
  const coverage = Number(analyst.analystCount ?? analyst.numberOfAnalysts ?? stock.valuation?.analystReliability?.analystCount ?? 0);
  const coverageScore = higher(coverage, 2, 20, 35);
  const years = (stock.financials?.years || []).slice(-8);
  const evidence = higher(years.length, 2, 7);
  const estimateReliability = clamp(Number(stock.valuation?.analystReliability?.score ?? stock.valuation?.analystReliability ?? 50), 0, 100);
  const score = Math.round(clamp(coverageScore * .22 + evidence * .18 + durability.score * .34 + estimateReliability * .26, 0, 100));
  return { score, analystCoverage: coverageScore, evidenceDepth: evidence, estimateReliability };
}

/**
 * Business economics layer. It intentionally excludes current price and fair
 * value. The output should change only when the business economics or evidence
 * changes, not when the stock quote moves.
 */
function computeBusinessEconomics(stock, inputs = {}) {
  const pricingPower = inputs.pricingPower || stock.valuation?.pricingPowerV2 || { score: 50 };
  const moat = inputs.moat || stock.valuation?.moat || { score: 50 };
  const compounder = inputs.compounder || stock.valuation?.compounder || { score: 50 };
  const lifecycle = inputs.lifecycle || stock.valuation?.lifecycle || {};
  const industryModel = inputs.industryModel || stock.valuation?.industryModel || {};
  const capitalAllocation = computeCapitalAllocationV2(stock);
  const durability = computeDurability(stock, pricingPower, compounder, lifecycle);
  const runway = computeRunway(stock, lifecycle, compounder);
  const industryStructure = computeIndustryStructure(industryModel);
  const capitalIntensity = computeCapitalIntensity(stock, industryModel);
  const forecastReliability = computeForecastReliability(stock, durability);

  const moatScore = clamp(Number(moat.score ?? 50), 0, 100);
  const pricingScore = clamp(Number(pricingPower.score ?? 50), 0, 100);
  const overall = Math.round(clamp(
    moatScore * .23 + pricingScore * .15 + capitalAllocation.score * .15 +
    durability.score * .18 + runway.score * .12 + industryStructure.score * .07 +
    capitalIntensity.score * .05 + forecastReliability.score * .05,
    0, 100
  ));

  const growthFadeMultiplier = clamp(.58 + overall / 240 + runway.score / 500, .62, .96);
  const premiumRetentionMultiplier = clamp(.45 + overall / 180 + durability.score / 500, .50, 1.08);
  const requiredMos = overall >= 88 ? .10 : overall >= 78 ? .15 : overall >= 66 ? .20 : overall >= 52 ? .25 : .30;

  return {
    version: 'business-economics-v1',
    overall,
    grade: overall >= 88 ? 'Exceptional' : overall >= 78 ? 'High Quality' : overall >= 66 ? 'Good' : overall >= 52 ? 'Average' : 'Weak',
    moat: moatScore,
    pricingPower: pricingScore,
    capitalAllocation: capitalAllocation.score,
    durability: durability.score,
    reinvestmentRunway: runway.score,
    industryStructure: industryStructure.score,
    capitalLight: capitalIntensity.score,
    forecastReliability: forecastReliability.score,
    growthFadeMultiplier,
    premiumRetentionMultiplier,
    requiredMarginOfSafety: requiredMos,
    components: { capitalAllocation, durability, runway, industryStructure, capitalIntensity, forecastReliability },
  };
}

module.exports = { computeBusinessEconomics };
