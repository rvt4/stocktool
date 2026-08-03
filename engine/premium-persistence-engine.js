'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));
const median = values => {
  const a = (values || []).filter(finite).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const stability = values => {
  const a = (values || []).filter(finite).map(Number);
  if (a.length < 3) return .50;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
  return clamp(1 - sd / .12, 0, 1);
};

const INDUSTRY_ANCHORS = {
  software: .62,
  'healthcare-innovation': .54,
  'healthcare-services': .43,
  'consumer-staples': .44,
  'consumer-discretionary': .42,
  communications: .38,
  'semiconductors-hardware': .46,
  industrials: .31,
  utilities: .25,
  financials: .22,
  reit: .22,
  energy: .12,
  materials: .14,
  general: .34,
};

/**
 * Estimates how much of a company's quality premium can survive through the
 * forecast horizon. This is deliberately business-quality driven rather than
 * ticker specific. The output is consumed by the exit-multiple engine.
 */
function computePremiumPersistence(stock, profile = {}, lifecycle = {}, moat = {}) {
  const years = (stock?.financials?.years || []).slice(-8);
  const last = years.at(-1) || {};
  const industry = stock?.valuation?.industryModel?.model || 'general';

  const roicMed = median(years.map(y => y.roic));
  const gross = years.map(y => y.grossMargin);
  const operating = years.map(y => y.operatingMargin ?? y.opMargin);
  const fcfMargins = years.map(y => y.fcfMargin ?? (y.revenue > 0 && finite(y.fcf) ? y.fcf / y.revenue : null));
  const revenueGrowth = [];
  for (let i = 1; i < years.length; i++) {
    if (years[i - 1]?.revenue > 0 && years[i]?.revenue > 0) revenueGrowth.push(years[i].revenue / years[i - 1].revenue - 1);
  }

  const moat01 = clamp((moat.score ?? (finite(profile.moatScore) ? profile.moatScore * 100 : 50)) / 100, 0, 1);
  const pricing = clamp((stock?.valuation?.pricingPowerV2?.score ?? stock?.pricingPowerScore ?? 50) / 100, 0, 1);
  const roic = roicMed == null ? .45 : clamp((roicMed - .05) / .30, 0, 1);
  const marginStability = (stability(gross) + stability(operating) + stability(fcfMargins)) / 3;
  const growthStability = stability(revenueGrowth);
  const recurring = clamp(profile.recurringRevenue ?? profile.recurringRevenueScore ?? .45, 0, 1);
  const reliability = clamp(profile.forecastReliability ?? lifecycle.confidence ?? .50, 0, 1);
  const growthPersistence = clamp((lifecycle.growthPersistenceScore ?? profile.growthPersistenceScore ?? 50) / 100, 0, 1);
  const capitalLight = clamp(1 - (profile.capitalIntensity ?? .50), 0, 1);
  const capitalAllocation = clamp((stock?.valuation?.capitalAllocation?.score ?? 50) / 100, 0, 1);

  const netDebt = Math.max(0, Number(last.longTermDebt || 0) - Number(last.cash || 0));
  const ebitda = Math.max(0, Number(last.ebitda || 0));
  const balanceSheet = ebitda > 0 ? clamp(1 - netDebt / (ebitda * 5), 0, 1) : .50;
  const dilution = clamp(Number(stock?.valuation?.dilutionRate ?? 0), -.10, .25);
  const dilutionScore = clamp(1 - Math.max(0, dilution) / .08, 0, 1);
  const cyclicality = clamp(profile.cyclicality ?? lifecycle.cyclicality ?? (['energy', 'materials'].includes(industry) ? .75 : .30), 0, 1);

  const stage = lifecycle.stage || '';
  const stageAdjustment = /Elite Compounder/.test(stage) ? .09
    : /Compounder/.test(stage) ? .06
      : /Hyper Growth|Growth|Temporary Disruption/.test(stage) ? .05
        : /Cyclical|Turnaround/.test(stage) ? -.06 : 0;

  const economicModel = lifecycle.economicModel || {};
  const industryAnchor = finite(economicModel.premiumAnchor)
    ? Number(economicModel.premiumAnchor)
    : (INDUSTRY_ANCHORS[industry] ?? INDUSTRY_ANCHORS.general);

  const secularBonus = economicModel.secular ? clamp(.03 + Number(economicModel.quality || 0) * .06, 0, .10) : 0;
  const grossMedian = median(gross) ?? 0;
  const scalingBrand = economicModel.archetype === 'Scaling Consumer Brand';
  const brandBonus = ['consumer-staples', 'consumer-discretionary'].includes(industry)
    ? clamp((grossMedian - .35) * .30, 0, .08) + clamp((Number(lifecycle.forwardGrowth || 0) - .10) * .18, 0, .06) + (scalingBrand ? .06 : 0)
    : 0;

  const economics = stock?.valuation?.economicQuality?.businessEconomics || stock?.valuation?.businessEconomics || null;
  const economics01 = clamp(Number(economics?.overall ?? 50) / 100, 0, 1);
  const economicsRetention = clamp(Number(economics?.premiumRetentionMultiplier ?? 1), .50, 1.08);

  const rawQualityPersistence = clamp(
    moat01 * .16 + pricing * .12 + roic * .13 + marginStability * .10 + growthStability * .05 +
    recurring * .07 + reliability * .07 + growthPersistence * .08 + capitalLight * .04 +
    capitalAllocation * .03 + balanceSheet * .03 + dilutionScore * .04 + (1 - cyclicality) * .04 +
    economics01 * .12 + stageAdjustment + secularBonus + brandBonus,
    0,
    1
  );
  const qualityPersistence = clamp(rawQualityPersistence * economicsRetention, 0, 1);

  // Retained premium is intentionally nonlinear. Elite businesses receive a
  // meaningful premium runway, while mediocre companies do not receive a free
  // valuation uplift merely because they currently trade at a high multiple.
  const floor = ['energy', 'materials'].includes(industry) ? .08 : .16;
  const ceiling = ['software', 'healthcare-innovation', 'semiconductors-hardware'].includes(industry)
    ? .86 : economicModel.secular ? .80 : scalingBrand ? .78 : .72;
  // Persistence is intentionally convex: merely decent businesses retain only
  // a modest premium, while truly exceptional economics can preserve a large
  // portion of their sector premium. This prevents average companies from
  // receiving a free uplift and avoids forcing elite compounders back to the
  // sector median.
  const persistenceCurve = Math.pow(qualityPersistence, 1.35);
  const retainedPremium = clamp(
    industryAnchor * .24 + persistenceCurve * .76,
    floor,
    ceiling
  );
  const multiplePersistenceScore = Math.round(retainedPremium * 100);

  return {
    version: 'v37-business-economics-persistence',
    score: qualityPersistence,
    qualityPersistence,
    retainedPremium,
    multiplePersistenceScore,
    persistenceCurve,
    expectedFade: 1 - retainedPremium,
    industryAnchor,
    secularBonus,
    brandBonus,
    archetype: economicModel.archetype || null,
    components: {
      moat: moat01,
      pricingPower: pricing,
      roicPersistence: roic,
      marginStability,
      growthStability,
      recurringRevenue: recurring,
      forecastReliability: reliability,
      growthPersistence,
      capitalLight,
      capitalAllocation,
      balanceSheet,
      dilutionDiscipline: dilutionScore,
      cyclicalityResistance: 1 - cyclicality,
      businessEconomics: economics01,
      economicsRetentionMultiplier: economicsRetention,
    },
  };
}

module.exports = { computePremiumPersistence, INDUSTRY_ANCHORS };
