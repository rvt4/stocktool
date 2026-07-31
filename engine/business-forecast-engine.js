'use strict';

/**
 * Business Forecast Engine V34
 *
 * Forecasts the operating business first and leaves category/lifecycle as a
 * diagnostic rather than the primary forecast driver. The engine distinguishes:
 *   - durable secular growth
 *   - acceleration / inflection
 *   - normalization after a temporary spike
 *   - cyclical recovery
 *   - mature steady-state growth
 *
 * It uses up to ten annual observations, available quarterly momentum, two years
 * of analyst estimates, returns on capital, margin behavior, cash conversion,
 * dilution, scale, and forecast breadth. All important inputs and adjustments are
 * returned for audit in results.json.
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)) || 0);
};
const weightedMean = items => {
  const valid = items.filter(x => finite(x.value) && finite(x.weight) && x.weight > 0);
  const total = valid.reduce((s, x) => s + x.weight, 0);
  return total ? valid.reduce((s, x) => s + Number(x.value) * x.weight, 0) / total : null;
};
const cagr = (a, b, n) => a > 0 && b > 0 && n > 0 ? Math.pow(b / a, 1 / n) - 1 : null;

function annualGrowthRates(years) {
  const out = [];
  for (let i = 1; i < years.length; i++) {
    const a = Number(years[i - 1]?.revenue);
    const b = Number(years[i]?.revenue);
    if (a > 0 && b > 0) out.push({ year: years[i].year, value: b / a - 1 });
  }
  return out;
}

function robustRate(values) {
  const v = values.filter(finite).map(Number);
  if (!v.length) return null;
  const center = median(v);
  const deviations = v.map(x => Math.abs(x - center));
  const mad = median(deviations) || 0.04;
  const lo = center - Math.max(0.10, mad * 3.5);
  const hi = center + Math.max(0.10, mad * 3.5);
  return weightedMean(v.map((x, i) => ({ value: clamp(x, lo, hi), weight: i + 1 })));
}

function linearSlope(values) {
  const y = values.filter(finite).map(Number);
  if (y.length < 3) return 0;
  const xMean = (y.length - 1) / 2;
  const yMean = mean(y);
  let numerator = 0, denominator = 0;
  for (let i = 0; i < y.length; i++) {
    numerator += (i - xMean) * (y[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function quarterlyMomentum(stock) {
  const q = stock.financials?.quarterly || stock.financials?.quarters || [];
  if (!Array.isArray(q) || q.length < 5) return null;
  const rows = [...q]
    .filter(x => finite(x.revenue ?? x.val) && Number(x.revenue ?? x.val) > 0)
    .sort((a, b) => String(a.end || a.date || '').localeCompare(String(b.end || b.date || '')));
  if (rows.length < 5) return null;
  const yoy = [];
  for (let i = 4; i < rows.length; i++) {
    const a = Number(rows[i - 4].revenue ?? rows[i - 4].val);
    const b = Number(rows[i].revenue ?? rows[i].val);
    if (a > 0 && b > 0) yoy.push(b / a - 1);
  }
  if (!yoy.length) return null;
  return {
    latest: yoy.at(-1),
    recentAverage: mean(yoy.slice(-2)),
    acceleration: yoy.length >= 2 ? yoy.at(-1) - yoy.at(-2) : 0,
    observations: yoy.length,
  };
}

function marginSeries(years, field) {
  return years.map(y => {
    if (field === 'operating') {
      if (finite(y.opMargin)) return Number(y.opMargin);
      if (finite(y.operatingMargin)) return Number(y.operatingMargin);
      if (Number(y.revenue) > 0 && finite(y.operatingIncome)) return Number(y.operatingIncome) / Number(y.revenue);
      return null;
    }
    if (field === 'gross') return finite(y.grossMargin) ? Number(y.grossMargin) : null;
    if (field === 'fcf') return Number(y.revenue) > 0 && finite(y.fcf) ? Number(y.fcf) / Number(y.revenue) : null;
    if (field === 'net') return Number(y.revenue) > 0 && finite(y.netIncome) ? Number(y.netIncome) / Number(y.revenue) : null;
    if (field === 'ebitda') return Number(y.revenue) > 0 && finite(y.ebitda) ? Number(y.ebitda) / Number(y.revenue) : null;
    return null;
  }).filter(finite);
}

function deriveBusinessState(stock, lifecycle = null) {
  const years = (stock.financials?.years || []).slice(-11);
  const rates = annualGrowthRates(years).map(x => x.value);
  const estimates = stock.analystEstimates || {};
  const qMomentum = quarterlyMomentum(stock);
  const recent3 = rates.slice(-3);
  const prior3 = rates.slice(-6, -3);
  const recentRate = robustRate(recent3);
  const longRate = robustRate(rates.slice(-8));
  const growth3 = years.length >= 4 ? cagr(years.at(-4).revenue, years.at(-1).revenue, 3) : null;
  const growth5 = years.length >= 6 ? cagr(years.at(-6).revenue, years.at(-1).revenue, 5) : null;
  const trendSlope = linearSlope(rates.slice(-5));

  let analyst1 = estimates.revenueGrowthCurrentYear ?? estimates.revenueGrowthFwd ?? null;
  let analyst2 = estimates.revenueGrowthNextYear ?? null;
  if (!finite(analyst2) && Number(estimates.revenueCurrentYear) > 0 && Number(estimates.revenueNextYear) > 0) {
    analyst2 = Number(estimates.revenueNextYear) / Number(estimates.revenueCurrentYear) - 1;
  }
  analyst1 = finite(analyst1) ? Number(analyst1) : null;
  analyst2 = finite(analyst2) ? Number(analyst2) : null;

  const op = marginSeries(years, 'operating');
  const gross = marginSeries(years, 'gross');
  const fcf = marginSeries(years, 'fcf');
  const net = marginSeries(years, 'net');
  const roics = years.slice(-6).map(y => y.roic).filter(finite).map(Number);
  const avgRoic = median(roics);
  const positiveFcfRate = years.length ? years.filter(y => Number(y.fcf) > 0).length / years.length : 0.5;
  const positiveIncomeRate = years.length ? years.filter(y => Number(y.netIncome) > 0).length / years.length : 0.5;
  const growthVolatility = stdev(rates.slice(-7));
  const marginVolatility = stdev(op.slice(-6));
  const grossStability = 1 - clamp(stdev(gross.slice(-6)) / 0.10, 0, 1);
  const fcfStability = 1 - clamp(stdev(fcf.slice(-6)) / 0.16, 0, 1);
  const analystBreadth = clamp((Number(estimates.numAnalysts) || 0) / 24, 0.15, 1);
  const forecastAgreement = analyst1 != null && analyst2 != null
    ? 1 - clamp(Math.abs(analyst2 - analyst1) / 0.24, 0, 1)
    : 0.5;
  const roicQuality = avgRoic == null ? 0.48 : clamp((avgRoic - 0.04) / 0.28, 0, 1);
  const pricing = clamp((stock.valuation?.pricingPowerV2?.score ?? stock.pricingPowerScore ?? 50) / 100, 0, 1);

  const priorAverage = mean(prior3) ?? longRate ?? 0;
  const currentOperatingRate = weightedMean([
    { value: analyst1, weight: analyst1 == null ? 0 : 0.42 },
    { value: qMomentum?.recentAverage, weight: qMomentum ? 0.23 : 0 },
    { value: recentRate, weight: recentRate == null ? 0 : 0.23 },
    { value: growth3, weight: growth3 == null ? 0 : 0.12 },
  ]) ?? longRate ?? 0.04;
  const forwardAverage = mean([analyst1, analyst2].filter(finite)) ?? currentOperatingRate;
  const inflection = currentOperatingRate - priorAverage;
  const deceleration = (recentRate ?? currentOperatingRate) - (longRate ?? currentOperatingRate);
  const marginTrend = linearSlope(op.slice(-5));
  const fcfTrend = linearSlope(fcf.slice(-5));
  const grossTrend = linearSlope(gross.slice(-5));

  const consistency = rates.length
    ? rates.slice(-6).filter(g => g > -0.02).length / Math.min(6, rates.length)
    : 0.5;
  const persistenceScore = clamp(
    0.20 * clamp((forwardAverage + 0.01) / 0.28, 0, 1) +
    0.15 * consistency +
    0.14 * roicQuality +
    0.10 * positiveFcfRate +
    0.07 * positiveIncomeRate +
    0.09 * grossStability +
    0.08 * fcfStability +
    0.07 * pricing +
    0.06 * analystBreadth +
    0.04 * forecastAgreement -
    0.10 * clamp(growthVolatility / 0.28, 0, 1),
    0, 1
  );

  const structuralInflection = inflection >= 0.07 &&
    (marginTrend >= -0.005 || grossTrend >= -0.005) &&
    (analyst2 == null || analyst2 >= currentOperatingRate - 0.06);
  const recovery = priorAverage < 0.04 && currentOperatingRate >= priorAverage + 0.06 &&
    (marginTrend > 0.005 || fcfTrend > 0.007 || positiveIncomeRate >= 0.5);
  const normalization = (longRate ?? 0) >= 0.18 && forwardAverage < (longRate ?? 0) - 0.08 &&
    forwardAverage > 0.03;
  const deterioration = forwardAverage < Math.min(0.03, (longRate ?? 0.03) - 0.07) &&
    marginTrend < -0.005;

  let regime = 'steady';
  if (deterioration) regime = 'deteriorating';
  else if (recovery) regime = 'recovery';
  else if (structuralInflection) regime = 'inflecting';
  else if (normalization) regime = 'normalizing';
  else if (trendSlope > 0.018 && forwardAverage > (longRate ?? 0) + 0.03) regime = 'accelerating';
  else if (trendSlope < -0.018 && forwardAverage < (longRate ?? 0) - 0.03) regime = 'decelerating';

  return {
    years, rates, analyst1, analyst2, qMomentum, recentRate, longRate, growth3, growth5,
    trendSlope, currentOperatingRate, forwardAverage, priorAverage, inflection, deceleration,
    avgRoic, positiveFcfRate, positiveIncomeRate, growthVolatility, marginVolatility,
    grossStability, fcfStability, analystBreadth, forecastAgreement, roicQuality, pricing,
    opMargins: op, grossMargins: gross, fcfMargins: fcf, netMargins: net,
    marginTrend, fcfTrend, grossTrend, persistenceScore, regime,
    lifecycleStage: lifecycle?.stage || null,
  };
}

function scaleAndRunway(stock, state) {
  const marketCap = Number(stock.valuation?.marketCap) || 0;
  const revenue = Number(state.years.at(-1)?.revenue) || 1;
  const scale = marketCap >= 1e12 ? 0.72 : marketCap >= 400e9 ? 0.78 : marketCap >= 150e9 ? 0.84
    : marketCap >= 50e9 ? 0.90 : marketCap >= 15e9 ? 0.95 : 1;
  const revenueScale = revenue >= 300e9 ? 0.78 : revenue >= 100e9 ? 0.84 : revenue >= 30e9 ? 0.90
    : revenue >= 10e9 ? 0.95 : 1;
  const runway = clamp(
    state.persistenceScore * 0.62 +
    clamp((state.forwardAverage + 0.01) / 0.30, 0, 1) * 0.25 +
    state.roicQuality * 0.13,
    0.20, 1
  );
  return { marketCap, revenue, scale, revenueScale, runway, combined: scale * revenueScale };
}

function terminalAnchor(stock, state, scale) {
  const industry = stock.valuation?.industryModel?.model || 'general';
  const structuralFloor = ['software', 'semiconductors-hardware'].includes(industry) ? 0.045
    : ['financials', 'utilities', 'reit'].includes(industry) ? 0.022 : 0.030;
  const sustainable = state.avgRoic == null
    ? null
    : clamp(state.avgRoic, 0, 0.35) * clamp(Number(stock.reinvestmentRate) || 0.35, 0.08, 0.75);
  const anchor = weightedMean([
    { value: state.growth5, weight: state.growth5 == null ? 0 : 0.24 },
    { value: state.longRate, weight: state.longRate == null ? 0 : 0.18 },
    { value: sustainable, weight: sustainable == null ? 0 : 0.24 },
    { value: state.forwardAverage * (0.42 + state.persistenceScore * 0.25), weight: 0.34 },
  ]) ?? structuralFloor;
  const maxAnchor = 0.045 + 0.105 * state.persistenceScore * scale.combined;
  return clamp(anchor, structuralFloor, maxAnchor);
}

function generateBusinessForecast(stock, lifecycle = null, years = 5, calibration = null) {
  const state = deriveBusinessState(stock, lifecycle);
  const scale = scaleAndRunway(stock, state);
  const calibrationGroup = stock.valuation?.industryModel?.model || 'general';
  const cal = calibration?.forecastByIndustry?.[calibrationGroup] || calibration?.forecastOverall || {};
  const analystBias = Number(cal.analystBias) || 0;
  const historyBias = Number(cal.historyBias) || 0;
  const terminal = terminalAnchor(stock, state, scale);

  const analystWeight1 = state.analyst1 == null ? 0 : clamp(0.58 + state.analystBreadth * 0.20, 0.58, 0.78);
  const momentumWeight = state.qMomentum ? 0.12 : 0;
  const historicalWeight = ['inflecting', 'recovery', 'accelerating'].includes(state.regime) ? 0.05 : 0.14;
  const stateWeight = Math.max(0, 1 - analystWeight1 - momentumWeight - historicalWeight);

  let y1 = weightedMean([
    { value: state.analyst1 == null ? null : state.analyst1 + analystBias, weight: analystWeight1 },
    { value: state.qMomentum?.recentAverage, weight: momentumWeight },
    { value: state.recentRate == null ? null : state.recentRate + historyBias, weight: historicalWeight },
    { value: state.currentOperatingRate, weight: stateWeight },
  ]) ?? state.currentOperatingRate;

  let y2 = state.analyst2 == null
    ? weightedMean([
        { value: y1, weight: 0.56 },
        { value: state.forwardAverage, weight: 0.29 },
        { value: terminal, weight: 0.15 },
      ])
    : weightedMean([
        { value: state.analyst2 + analystBias, weight: clamp(0.66 + state.analystBreadth * 0.16, 0.66, 0.82) },
        { value: y1, weight: 0.16 },
        { value: terminal, weight: 0.10 },
      ]);

  if (['inflecting', 'accelerating'].includes(state.regime)) {
    y1 += clamp(state.inflection * 0.10, 0, 0.025);
    y2 += clamp(state.inflection * 0.07, 0, 0.018);
  } else if (state.regime === 'normalizing') {
    y1 = Math.min(y1, Math.max(state.forwardAverage, terminal + 0.06));
    y2 = Math.min(y2, y1 - 0.01);
  } else if (state.regime === 'deteriorating') {
    y1 = Math.min(y1, state.forwardAverage);
    y2 = Math.min(y2, y1 + 0.02);
  }

  const nearTermCap = 0.34 + 0.30 * state.persistenceScore * scale.combined;
  y1 = clamp(y1, -0.35, nearTermCap);
  y2 = clamp(y2, -0.28, Math.max(0.22, nearTermCap - 0.015));

  // Convert persistence into an explicit abnormal-growth runway. The old V30
  // formula applied the terminal anchor immediately in year three, which caused
  // 40%+ growers to collapse to roughly 12-15% in one step. Runway determines how
  // long the competitive-growth phase lasts before terminal convergence begins.
  let persistenceYears = Math.round(clamp(
    1.5 + state.persistenceScore * 4.5 + scale.runway * 1.5 +
    (['inflecting', 'accelerating'].includes(state.regime) ? 1.0 : 0) -
    (state.regime === 'normalizing' ? 1.0 : 0),
    2, Math.min(7, Math.max(2, years - 1))
  ));
  if (state.analyst2 != null && state.analyst2 >= 0.25) persistenceYears = Math.max(persistenceYears, 4);

  // The bridge anchor is an intermediate operating rate, not the terminal rate.
  // It incorporates current evidence and persistence, then converges to terminal
  // only in the final phase of the forecast.
  const bridgeAnchor = clamp(weightedMean([
    { value: state.forwardAverage, weight: 0.34 },
    { value: state.recentRate, weight: state.recentRate == null ? 0 : 0.18 },
    { value: state.growth3, weight: state.growth3 == null ? 0 : 0.16 },
    { value: terminal + (y2 - terminal) * (0.28 + 0.38 * state.persistenceScore), weight: 0.32 },
  ]) ?? terminal, terminal + 0.01, Math.max(terminal + 0.01, y2));

  const maxAnnualDrop = clamp(
    0.045 + (1 - state.persistenceScore) * 0.055 +
    (state.regime === 'normalizing' ? 0.035 : 0) +
    (state.regime === 'deteriorating' ? 0.045 : 0),
    0.045, 0.15
  );
  const maxAnnualIncrease = clamp(0.045 + state.persistenceScore * 0.035, 0.045, 0.08);

  const path = [y1];
  if (years >= 2) path.push(y2);
  let previous = y2;
  let revenueMultiple = (1 + Math.max(-0.95, y1)) * (years >= 2 ? 1 + Math.max(-0.95, y2) : 1);

  for (let t = 3; t <= years; t++) {
    const inPersistencePhase = t <= persistenceYears;
    const target = inPersistencePhase ? bridgeAnchor : terminal;
    const phaseLength = inPersistencePhase
      ? Math.max(1, persistenceYears - 1)
      : Math.max(1, years - persistenceYears);
    const phaseProgress = inPersistencePhase
      ? clamp((t - 2) / phaseLength, 0, 1)
      : clamp((t - persistenceYears) / phaseLength, 0, 1);
    const easing = phaseProgress * phaseProgress * (3 - 2 * phaseProgress);

    // During persistence, decay only partway toward the bridge anchor. During
    // convergence, move gradually from the bridge anchor to terminal.
    let desired = inPersistencePhase
      ? y2 + (bridgeAnchor - y2) * easing
      : bridgeAnchor + (terminal - bridgeAnchor) * easing;

    if (state.regime === 'inflecting' && t <= Math.min(4, persistenceYears)) {
      desired += clamp(state.inflection * 0.05, 0, 0.010);
    }
    if (state.regime === 'recovery' && t <= Math.min(4, persistenceYears)) {
      desired += clamp(state.marginTrend * 0.20, 0, 0.008);
    }

    // Continuity invariant: absent a deterioration/normalization regime, no
    // central forecast may drop dozens of percentage points in a single year.
    let next = clamp(desired, previous - maxAnnualDrop, previous + maxAnnualIncrease);

    // Revenue-base discipline remains gradual and scale-aware.
    const maxGrowthAtScale = clamp(
      0.34 * scale.combined * scale.runway / Math.pow(Math.max(1, revenueMultiple), 0.18),
      0.055, 0.40
    );
    // The scale cap may slow the path, but it may not violate the continuity
    // invariant by forcing an artificial one-year cliff.
    const continuityFloor = previous - maxAnnualDrop;
    next = Math.min(next, Math.max(terminal, maxGrowthAtScale, continuityFloor));
    next = clamp(next, -0.18, 0.55);
    path.push(next);
    revenueMultiple *= 1 + Math.max(-0.95, next);
    previous = next;
  }

  const annualChanges = path.slice(1).map((x, i) => x - path[i]);
  const continuityBreaches = annualChanges.filter(x => x < -maxAnnualDrop - 1e-9 || x > maxAnnualIncrease + 1e-9).length;
  const evidenceCompleteness = clamp(
    Math.min(state.years.length, 8) / 8 * 0.34 +
    (state.analyst1 != null ? 0.18 : 0) +
    (state.analyst2 != null ? 0.14 : 0) +
    state.analystBreadth * 0.14 +
    (state.qMomentum ? 0.10 : 0) +
    state.positiveFcfRate * 0.10,
    0, 1
  );
  const pathSmoothness = 1 - clamp(stdev(annualChanges) / 0.10, 0, 1);
  const plausibilityScore = Math.round(clamp(
    100 * (0.36 * evidenceCompleteness + 0.31 * state.persistenceScore + 0.20 * pathSmoothness + 0.13 * scale.runway) - continuityBreaches * 20,
    25, 98
  ));

  return {
    path,
    source: 'v31_three_phase_persistence_runway_forecast',
    assumptions: {
      version: '31.0',
      regime: state.regime,
      analyst1: state.analyst1,
      analyst2: state.analyst2,
      quarterlyMomentum: state.qMomentum,
      recentHistoricalGrowth: state.recentRate,
      longHistoricalGrowth: state.longRate,
      growth3: state.growth3,
      growth5: state.growth5,
      trendSlope: state.trendSlope,
      currentOperatingRate: state.currentOperatingRate,
      priorOperatingRate: state.priorAverage,
      inflection: state.inflection,
      persistenceScore: state.persistenceScore,
      persistenceYears,
      bridgeOperatingAnchor: bridgeAnchor,
      terminalOperatingAnchor: terminal,
      maxAnnualGrowthDrop: maxAnnualDrop,
      maxAnnualGrowthIncrease: maxAnnualIncrease,
      annualGrowthChanges: annualChanges,
      continuityBreaches,
      scale,
      projectedRevenueMultiple: revenueMultiple,
      analystReliability: state.analystBreadth,
      calibrationApplied: !!calibration?.isCalibrated,
      year1: path[0],
      year2: path[1] ?? null,
      longRunAnchor: terminal,
      plausibilityScore,
      state,
    },
  };
}

function forecastMarginPaths(stock, growthModel, years = 5, lifecycle = null) {
  const ys = (stock.financials?.years || []).slice(-9);
  const state = growthModel?.assumptions?.state || deriveBusinessState(stock, lifecycle);
  const estimates = stock.analystEstimates || {};
  const fields = ['ebitda', 'fcf', 'net'];
  const bounds = {
    ebitda: [-0.10, 0.58],
    fcf: [-0.15, 0.46],
    net: [-0.25, 0.48],
  };
  const paths = {};
  const targets = {};
  const starts = {};
  const diagnostics = {};

  const growthPath = (growthModel?.path || []).slice(0, years);
  const avgGrowth3 = mean(growthPath.slice(0, Math.min(3, years))) ?? 0;
  const avgGrowth5 = mean(growthPath) ?? avgGrowth3;
  const durableGrowth = clamp((avgGrowth3 - 0.05) / 0.25, 0, 1);
  const pricing = clamp(state.pricing ?? 0.5, 0, 1);
  const roicQuality = clamp(state.roicQuality ?? 0.5, 0, 1);
  const persistence = clamp(state.persistenceScore ?? 0.5, 0, 1);
  const broadLeverageSignal = clamp(
    durableGrowth * 0.38 + pricing * 0.20 + roicQuality * 0.18 +
    persistence * 0.18 + clamp((state.grossTrend ?? 0) / 0.02, -1, 1) * 0.06,
    0, 1
  );
  const deterioration = state.regime === 'deteriorating' ||
    ((state.grossTrend ?? 0) < -0.012 && (state.marginTrend ?? 0) < -0.012);
  const positiveOperatingSetup = !deterioration && avgGrowth3 >= 0.15 &&
    pricing >= 0.50 && roicQuality >= 0.45 && (state.grossTrend ?? 0) >= -0.008;

  // Estimate future diluted shares only to translate analyst EPS into an implied
  // net-margin anchor. This is deliberately conservative and capped.
  const latest = ys.at(-1) || {};
  const historicalShareRates = [];
  for (let i = 1; i < ys.length; i++) {
    const a = Number(ys[i - 1]?.sharesOutTTM);
    const b = Number(ys[i]?.sharesOutTTM);
    if (a > 0 && b > 0) historicalShareRates.push(b / a - 1);
  }
  const shareGrowth = clamp(robustRate(historicalShareRates.slice(-5)) ?? 0, -0.08, 0.10);
  const startShares = Number(latest.sharesOutTTM) || Number(latest.shares) || null;
  const rev1 = Number(estimates.revenueCurrentYear) > 0
    ? Number(estimates.revenueCurrentYear)
    : Number(latest.revenue) * (1 + (growthPath[0] ?? 0));
  const rev2 = Number(estimates.revenueNextYear) > 0
    ? Number(estimates.revenueNextYear)
    : rev1 * (1 + (growthPath[1] ?? growthPath[0] ?? 0));
  const shares1 = startShares ? startShares * (1 + shareGrowth) : null;
  const shares2 = shares1 ? shares1 * (1 + shareGrowth) : null;
  const analystNet1 = finite(estimates.epsCurrentYear) && rev1 > 0 && shares1 > 0
    ? Number(estimates.epsCurrentYear) * shares1 / rev1 : null;
  const analystNet2 = finite(estimates.epsNextYear) && rev2 > 0 && shares2 > 0
    ? Number(estimates.epsNextYear) * shares2 / rev2 : null;

  function historicalIncrementalMargin(field) {
    const points = [];
    for (let i = 1; i < ys.length; i++) {
      const r0 = Number(ys[i - 1]?.revenue);
      const r1 = Number(ys[i]?.revenue);
      if (!(r0 > 0 && r1 > r0 * 1.01)) continue;
      const getProfit = y => {
        if (field === 'ebitda') return Number(y?.ebitda);
        if (field === 'fcf') return Number(y?.fcf);
        return Number(y?.netIncome);
      };
      const p0 = getProfit(ys[i - 1]);
      const p1 = getProfit(ys[i]);
      if (finite(p0) && finite(p1)) points.push((p1 - p0) / (r1 - r0));
    }
    const center = robustRate(points.slice(-6));
    return center == null ? null : clamp(center, -0.20, 0.80);
  }

  for (const field of fields) {
    const series = marginSeries(ys, field);
    const latestMargin = series.at(-1);
    const recentMedian = median(series.slice(-3));
    const longMedian = median(series.slice(-6));
    const start = latestMargin ?? recentMedian ?? longMedian ??
      (field === 'ebitda' ? 0.10 : field === 'fcf' ? 0.07 : 0.05);
    const recentTrend = linearSlope(series.slice(-5));
    const incremental = historicalIncrementalMargin(field);
    const best = series.length ? Math.max(...series.slice(-6)) : start;
    const worst = series.length ? Math.min(...series.slice(-6)) : start;

    // Economic target: use incremental economics and operating leverage rather
    // than automatically reverting a fast-growing business to its old median.
    const fieldSensitivity = field === 'ebitda' ? 0.105 : field === 'fcf' ? 0.075 : 0.085;
    const leverageExpansion = fieldSensitivity * broadLeverageSignal *
      clamp((avgGrowth5 - 0.04) / 0.24, 0, 1);
    const trendContribution = clamp(recentTrend * Math.min(4, years) * 0.55, -0.035, 0.055);
    const incrementalContribution = incremental == null ? 0 : clamp(
      (incremental - start) * 0.18 * persistence,
      -0.025, 0.055
    );

    let target = start + leverageExpansion + trendContribution + incrementalContribution;

    // Analyst EPS anchors are the best available near-term net-margin evidence.
    // Blend them into the sustainable target, but do not extrapolate a one-year
    // spike forever.
    if (field === 'net') {
      const analystAnchor = weightedMean([
        { value: analystNet1, weight: analystNet1 == null ? 0 : 0.35 },
        { value: analystNet2, weight: analystNet2 == null ? 0 : 0.65 },
      ]);
      if (analystAnchor != null) {
        const normalizedAnalyst = clamp(analystAnchor, Math.max(-0.20, start - 0.08), Math.min(0.48, start + 0.20));
        target = weightedMean([
          { value: target, weight: 0.48 },
          { value: normalizedAnalyst, weight: 0.52 },
        ]);
      }
    }

    if (deterioration) {
      target = Math.min(target, Math.max(worst, (longMedian ?? start) * 0.75 + start * 0.25));
    } else if (state.regime === 'normalizing') {
      target = Math.min(target, Math.max(start - 0.035, longMedian ?? start));
    } else if (positiveOperatingSetup) {
      // Directional consistency invariant: broad-based compression is not a
      // valid central case when growth, pricing power, ROIC and gross-margin
      // evidence all point to operating leverage.
      const minimumExpansion = field === 'ebitda'
        ? 0.012 + 0.035 * broadLeverageSignal
        : field === 'fcf'
          ? 0.004 + 0.022 * broadLeverageSignal
          : 0.002 + 0.025 * broadLeverageSignal;
      target = Math.max(target, start + minimumExpansion);
    } else if (!lifecycle?.normalizeMargins) {
      // Stable businesses may mean-revert gently, but never snap back to an old
      // median merely because older low-margin years exist in the history.
      const floor = Math.min(start, recentMedian ?? start) - 0.015;
      target = Math.max(target, floor);
    }

    if (lifecycle?.normalizeMargins && !positiveOperatingSetup) {
      target = longMedian ?? start;
    }

    // Keep targets economically plausible relative to observed history, while
    // permitting genuine mix improvement above the old peak.
    const expansionAbovePeak = field === 'ebitda' ? 0.10 : field === 'fcf' ? 0.07 : 0.08;
    target = Math.min(target, Math.max(start + expansionAbovePeak, best + expansionAbovePeak * 0.55));
    const [lo, hi] = bounds[field];
    target = clamp(target, lo, hi);

    starts[field] = start;
    targets[field] = target;
    paths[field] = [];

    // Net margin gets explicit analyst-led years 1-2, then a smooth bridge to
    // the sustainable target. EBITDA and FCF use a gradual S-curve from today.
    if (field === 'net' && analystNet1 != null) {
      paths[field].push(clamp(analystNet1, lo, hi));
      if (years >= 2) paths[field].push(clamp(analystNet2 ?? analystNet1, lo, hi));
      for (let t = 3; t <= years; t++) {
        const p = (t - 2) / Math.max(1, years - 2);
        const smooth = p * p * (3 - 2 * p);
        const raw = paths[field][1] + (target - paths[field][1]) * smooth;
        const prior = paths[field][t - 2];
        const annualLimit = 0.040;
        paths[field].push(clamp(raw, prior - annualLimit, prior + annualLimit));
      }
    } else {
      for (let t = 1; t <= years; t++) {
        const p = t / years;
        const smooth = p * p * (3 - 2 * p);
        const raw = start + (target - start) * smooth;
        const annualLimit = field === 'ebitda' ? 0.030 : 0.025;
        const prior = t === 1 ? start : paths[field][t - 2];
        paths[field].push(clamp(raw, prior - annualLimit, prior + annualLimit));
      }
    }

    diagnostics[field] = {
      latestMargin,
      recentMedian,
      longMedian,
      recentTrend,
      incrementalMargin: incremental,
      leverageExpansion,
      trendContribution,
      incrementalContribution,
      positiveOperatingSetup,
      broadLeverageSignal,
      analystNet1: field === 'net' ? analystNet1 : null,
      analystNet2: field === 'net' ? analystNet2 : null,
    };
  }

  // Cross-margin integrity check. When all operating evidence is positive, do
  // not permit EBITDA, FCF and net margins to all finish below their starting
  // levels. This catches exactly the AMD/PLTR failure mode seen in V33.
  const broadCompression = fields.every(field => targets[field] < starts[field] - 0.002);
  if (positiveOperatingSetup && broadCompression) {
    for (const field of fields) {
      targets[field] = Math.max(targets[field], starts[field]);
      const first = paths[field][0];
      for (let t = 0; t < years; t++) {
        const p = (t + 1) / years;
        const smooth = p * p * (3 - 2 * p);
        paths[field][t] = first + (targets[field] - first) * smooth;
      }
    }
  }

  return {
    paths,
    starts,
    targets,
    diagnostics,
    assumptions: {
      version: '34.0',
      avgGrowth3,
      avgGrowth5,
      durableGrowth,
      broadLeverageSignal,
      positiveOperatingSetup,
      deterioration,
      analystNet1,
      analystNet2,
      shareGrowth,
    },
    source: 'v34_incremental_margin_and_operating_leverage_forecast',
  };
}
module.exports = {
  generateBusinessForecast,
  forecastMarginPaths,
  deriveBusinessState,
  annualGrowthRates,
  quarterlyMomentum,
};
