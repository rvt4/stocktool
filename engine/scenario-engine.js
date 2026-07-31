'use strict';
const { normalizeCycle } = require('./cycle-normalization-engine');
const { assessCapitalIntensity } = require('./capital-intensity-engine');
const { assessCompetitivePressure } = require('./competitive-pressure-engine');
const { computeGrowthQuality } = require('./growth-quality-engine');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function finite(x) { return Number.isFinite(Number(x)); }

const SPREAD = {
  'Hyper Growth': { g: .10, m: .035, x: .24 },
  Growth:         { g: .07, m: .025, x: .18 },
  Compounder:     { g: .045, m: .018, x: .13 },
  Dividend:       { g: .025, m: .012, x: .10 },
  Value:          { g: .035, m: .018, x: .14 },
  Turnaround:     { g: .07, m: .04, x: .22 },
  Cyclical:       { g: .09, m: .05, x: .25 },
};

function probs(stock, integrity, profile, cycle, gq) {
  const reliability = profile?.forecastReliability ?? .5;
  const analyst = stock.valuation?.analystReliability ?? .5;
  const moat = profile?.moatScore ?? .5;
  const data = (integrity?.score ?? 50) / 100;
  const conf = clamp(reliability * .24 + analyst * .18 + moat * .18 + data * .22 + (gq?.score ?? 50) / 100 * .18, 0, 1);
  const base = clamp(.46 + (conf - .5) * .34 - cycle.cyclicality * .07, .36, .66);
  const bear = clamp(.34 - (conf - .5) * .18 + cycle.cyclicality * .08, .18, .43);
  return { bear, base, bull: Math.max(0.05, 1 - base - bear), confidence: conf };
}

// Build a scenario as a multiplicative deviation from the base revenue path.
// This is important because analyst-anchored revenue can be inconsistent with the
// stored growth field. Recomputing from scenario growth alone could therefore make
// a "bear" path finish above the base path.
function scenarioProjection(base, kind, spread, cycle, capital, competition) {
  let cumulativeRevenueRatio = 1;
  return base.map((r, i) => {
    const t = i + 1;
    const fade = Math.exp(-t * (kind === 'bull' ? .18 : .26) * competition.growthFadeMultiplier);
    const growthDelta = kind === 'bear'
      ? -spread.g * (.65 + .35 * cycle.cyclicality) * fade
      : kind === 'bull'
        ? spread.g * (.60 + .30 * (1 - cycle.cyclicality)) * fade
        : 0;
    const baseGrowth = clamp(Number(r.growth) || 0, -.25, .65);
    const growth = clamp(baseGrowth + growthDelta, -.25, .65);
    cumulativeRevenueRatio *= (1 + growth) / Math.max(.25, 1 + baseGrowth);

    // Explicitly preserve scenario ordering at every projected year.
    if (kind === 'bear') cumulativeRevenueRatio = Math.min(cumulativeRevenueRatio, 0.999);
    if (kind === 'bull') cumulativeRevenueRatio = Math.max(cumulativeRevenueRatio, 1.001);
    const revenue = Math.max(0, (Number(r.revenue) || 0) * cumulativeRevenueRatio);

    const marginDelta = kind === 'bear'
      ? -spread.m * (.6 + .4 * competition.pressure)
      : kind === 'bull'
        ? spread.m * (.55 + .25 * capital.fcfConversion)
        : 0;
    const fcfMargin = clamp((r.fcfMargin ?? 0) + marginDelta - competition.annualMarginFade * t, -.2, .5);
    const netMargin = clamp((r.netMargin ?? 0) + marginDelta * .75, -.25, .5);
    const ebitdaMargin = clamp((r.ebitdaMargin ?? 0) + marginDelta * .9, -.1, .6);

    return {
      ...r,
      growth,
      revenue,
      fcfMargin,
      fcf: revenue * fcfMargin,
      netMargin,
      netIncome: revenue * netMargin,
      ebitdaMargin,
      ebitda: revenue * ebitdaMargin,
    };
  });
}

function terminalFundamentalRatio(scenario, base) {
  const s = scenario?.at(-1) || {};
  const b = base?.at(-1) || {};
  const ratios = [];
  const add = (sv, bv, weight) => {
    if (finite(sv) && finite(bv) && Number(sv) > 0 && Number(bv) > 0) ratios.push({ ratio: Number(sv) / Number(bv), weight });
  };
  add(s.fcf, b.fcf, .42);
  add(s.netIncome, b.netIncome, .33);
  add(s.ebitda, b.ebitda, .15);
  add(s.revenue, b.revenue, .10);
  if (!ratios.length) return 1;
  const total = ratios.reduce((a, x) => a + x.weight, 0);
  return clamp(ratios.reduce((a, x) => a + x.ratio * x.weight, 0) / total, .20, 2.50);
}

function orderedScenarioValues({ current, years, baseExit, dividends, rawBearExit, rawBullExit }) {
  const baseTotal = Math.max(.01, baseExit + dividends);
  // Require at least a 50bp CAGR separation. This is a safety invariant, not a
  // substitute for scenario assumptions; it prevents rounding/data oddities from
  // presenting bear >= base or bull <= base.
  const minStep = Math.pow(1.005, years);
  const maxBearTotal = baseTotal / minStep;
  const minBullTotal = baseTotal * minStep;
  const bearDividends = dividends * .75;
  const bullDividends = dividends * 1.10;
  const bearTotal = Math.min(Math.max(.01, rawBearExit + bearDividends), maxBearTotal);
  const bullTotal = Math.max(rawBullExit + bullDividends, minBullTotal);
  const bearExit = Math.max(.01, bearTotal - bearDividends);
  const bullExit = Math.max(.01, bullTotal - bullDividends);
  return {
    bearExit,
    bullExit,
    baseCAGR: Math.pow(baseTotal / current, 1 / years) - 1,
    bearCAGR: Math.pow((bearExit + bearDividends) / current, 1 / years) - 1,
    bullCAGR: Math.pow((bullExit + bullDividends) / current, 1 / years) - 1,
  };
}

function buildScenarios(stock, v, integrity) {
  const category = typeof v.category === 'string' ? v.category : (v.category?.name || v.category?.stage || stock.valuation?.category || 'Value');
  const spread = SPREAD[category] || SPREAD.Value;
  const profile = v.businessProfile || {};
  const base = v.projection || [];
  const current = Number(stock.price?.current);
  const years = Number(v.fiveYearPriceTarget?.years) || Number(v.ownerEarningsReturn?.years) || Math.min(5, base.length) || 5;
  // Use the unified/actionable target first. Owner earnings remains an input and a
  // validation method, but no longer overrides the complete valuation ensemble.
  const institutionalBaseCAGR = Number(v.returnEngineV2?.expectedCAGR);
  const dividends = Number(v.fiveYearPriceTarget?.dividendsReceived) || Number(v.ownerEarningsReturn?.dividendsReceived) || 0;
  // Rebuild the scenario base exit from the canonical lifecycle/reality-checked CAGR.
  // This prevents a raw valuation target or owner-earnings fallback from bypassing
  // the central return safeguards.
  const canonicalTotalFutureValue = Number.isFinite(institutionalBaseCAGR) && current > 0
    ? current * Math.pow(1 + institutionalBaseCAGR, years)
    : null;
  const canonicalExit = canonicalTotalFutureValue != null
    ? Math.max(.01, canonicalTotalFutureValue - dividends)
    : null;
  const baseExit = canonicalExit || Number(v.fiveYearPriceTarget?.exitPrice) || Number(v.ownerEarningsReturn?.exitPrice);
  const cycle = normalizeCycle(stock);
  const capital = assessCapitalIntensity(stock, base);
  const competition = assessCompetitivePressure(stock, profile, stock.valuation?.pricingPowerV2);
  const growthQuality = computeGrowthQuality(stock, cycle, capital, competition);
  const p = probs(stock, integrity, profile, cycle, growthQuality);

  if (!(current > 0) || !(baseExit > 0) || !base.length) {
    return { probabilities: p, scenarios: null, expectedCAGR: null, cycleNormalization: cycle, capitalIntensity: capital, competitivePressure: competition, growthQuality };
  }

  const bearProj = scenarioProjection(base, 'bear', spread, cycle, capital, competition);
  const bullProj = scenarioProjection(base, 'bull', spread, cycle, capital, competition);
  const bearFund = Math.min(.999, terminalFundamentalRatio(bearProj, base));
  const bullFund = Math.max(1.001, terminalFundamentalRatio(bullProj, base));
  const uncertainty = 1 - p.confidence;
  const rawBearExit = Math.max(.01, baseExit * bearFund * (1 - spread.x * (.75 + competition.pressure * .35 + uncertainty * .35)));
  const rawBullExit = baseExit * bullFund * (1 + spread.x * (.60 + competition.premiumRetentionMultiplier * .35 - uncertainty * .18));
  const ordered = orderedScenarioValues({ current, years, baseExit, dividends, rawBearExit, rawBullExit });
  const baseC = ordered.baseCAGR;
  const bearC = Math.min(ordered.bearCAGR, baseC - .005);
  const bullC = Math.max(ordered.bullCAGR, baseC + .005);
  const bearDividends = dividends * .75;
  const bullDividends = dividends * 1.10;
  const rawExpected = clamp(bearC * p.bear + baseC * p.base + bullC * p.bull, -.6, 1);
  // Probability weighting should refine, not overthrow, the central underwriting.
  // Limit the weighted result to ±250 bps around the canonical base CAGR.
  const expected = clamp(rawExpected, baseC - .025, baseC + .025);

  return {
    probabilities: p,
    scenarios: {
      bear: { probability: p.bear, cagr: clamp(bearC, -.6, 1), exitPrice: ordered.bearExit, dividendsReceived: bearDividends, totalFutureValue: ordered.bearExit + bearDividends, projection: bearProj, description: 'Lower growth, weaker margins and faster multiple fade' },
      base: { probability: p.base, cagr: clamp(baseC, -.6, 1), exitPrice: baseExit, dividendsReceived: dividends, totalFutureValue: baseExit + dividends, projection: base, description: 'Unified base valuation and operating forecast' },
      bull: { probability: p.bull, cagr: clamp(bullC, -.6, 1.2), exitPrice: ordered.bullExit, dividendsReceived: bullDividends, totalFutureValue: ordered.bullExit + bullDividends, projection: bullProj, description: 'Stronger execution, margins and premium retention' },
    },
    expectedCAGR: expected,
    probabilityWeightedCAGR: expected,
    rawProbabilityWeightedCAGR: rawExpected,
    downsideCAGR: clamp(bearC, -.6, 1),
    baseCAGR: clamp(baseC, -.6, 1),
    upsideCAGR: clamp(bullC, -.6, 1.2),
    years,
    scenarioOrderingValid: bearC < baseC && baseC < bullC,
    cycleNormalization: cycle,
    capitalIntensity: capital,
    competitivePressure: competition,
    growthQuality,
  };
}

module.exports = { buildScenarios, scenarioProjection, terminalFundamentalRatio, orderedScenarioValues };
