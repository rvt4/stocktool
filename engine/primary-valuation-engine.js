'use strict';

/**
 * V33 primary valuation engine.
 *
 * Core rule: do not average every valuation model. Select the methods that fit
 * the business economics, require corroboration, and calculate present value
 * and future exit value from the same selected method set.
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));

function agreementInfluence(score) {
  const s = clamp(Number(score || 0), 0, 100);
  if (s < 20) return 0.15;
  if (s < 40) return 0.28;
  if (s < 60) return 0.45;
  if (s < 80) return 0.68;
  if (s < 90) return 0.85;
  return 1.00;
}
const { resolveInstitutionalValuationModel, specialistReliabilityAdjustment } = require('./institutional-valuation-dispatcher');
const { adaptiveMethodWeights } = require('./adaptive-weight-engine');
const median = values => {
  const a = values.filter(finite).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};


function weightedMedian(rows, field = 'presentValue') {
  const a = (rows || []).filter(x => finite(x?.[field]) && Number(x.weight) > 0)
    .map(x => ({ value: Number(x[field]), weight: Number(x.weight) }))
    .sort((x, y) => x.value - y.value);
  const total = a.reduce((s, x) => s + x.weight, 0);
  if (!(total > 0)) return null;
  let running = 0;
  for (const x of a) {
    running += x.weight;
    if (running >= total / 2) return x.value;
  }
  return a.at(-1)?.value ?? null;
}

function weightedAverageRows(rows, field) {
  const prepared = (rows || []).filter(x => finite(x?.[field]) && Number(x.weight) > 0);
  const total = prepared.reduce((sum, x) => sum + Number(x.weight), 0);
  return total > 0 ? prepared.reduce((sum, x) => sum + Number(x[field]) * Number(x.weight), 0) / total : null;
}

function robustWeightedValue(rows, field) {
  const center = weightedMedian(rows, field);
  if (!(center > 0)) return null;
  // Winsorize each method around the weighted median before using a geometric
  // blend. This preserves method information while preventing a single heroic
  // or broken valuation from dominating the fair value.
  const prepared = rows.filter(x => finite(x?.[field]) && Number(x[field]) > 0 && Number(x.weight) > 0)
    .map(x => ({ value: clamp(Number(x[field]), center * .45, center * 2.20), weight: Number(x.weight) }));
  const total = prepared.reduce((s, x) => s + x.weight, 0);
  if (!(total > 0)) return null;
  return Math.exp(prepared.reduce((s, x) => s + (x.weight / total) * Math.log(x.value), 0));
}

function reratingProbability({ rawValuationDrag, agreementScore, quality, premiumPersistence, forecastReliability, extremeValuation, profileName }) {
  if (!finite(rawValuationDrag) || Math.abs(rawValuationDrag) < .002) return 0;
  const agreement = clamp(Number(agreementScore || 0) / 100, 0, 1);
  const q = clamp(Number(quality || 0), 0, 1);
  const persistence = clamp(Number(premiumPersistence || 0), 0, 1);
  const reliability = clamp(Number(forecastReliability || 0), 0, 1);
  const extreme = clamp(Number(extremeValuation || 0), 0, 1);
  const isNegative = rawValuationDrag < 0;

  if (isNegative) {
    // Compression is not certain. It becomes more likely when valuation is truly
    // extreme and methods agree, and less likely for durable premium businesses.
    const premiumDefense = q * .30 + persistence * .35 + reliability * .20 +
      (/quality-compounder|software|innovation/.test(String(profileName || '')) ? .10 : 0);
    return clamp(.18 + agreement * .34 + extreme * .34 - premiumDefense * .34, .10, .82);
  }
  // Positive rerating also deserves skepticism; cheapness must be corroborated.
  return clamp(.14 + agreement * .42 + reliability * .15 + q * .08 - extreme * .08, .10, .72);
}

const METHOD_LABELS = {
  dcf: 'DCF', dcfSBCAdjusted: 'SBC-adjusted DCF', ownerEarnings: 'Owner Earnings',
  revenueExit: 'Revenue Exit', epsExit: 'EPS Exit', ebitdaExit: 'EV/EBITDA Exit',
};

function profileFor(stock, category, lifecycle = {}) {
  const specialist = resolveInstitutionalValuationModel(stock, category, lifecycle);
  stock.valuation = stock.valuation || {};
  if (lifecycle?.archetype) stock.valuation.businessArchetype = lifecycle.archetype;
  if (specialist) return {
    name: specialist.key,
    label: specialist.label,
    primary: specialist.primary,
    support: specialist.support,
    weights: specialist.weights,
    maxBase: specialist.maxBase,
    maxRerating: specialist.maxRerating,
    invalidMethods: specialist.invalidMethods || [],
    specialistNotes: specialist.notes || [],
    useNetMarginForBridge: !!specialist.useNetMarginForBridge,
    specialist: true,
  };
  const industry = stock?.valuation?.industryModel?.model || 'general';
  const stage = lifecycle.stage || category || 'Value';
  const archetype = lifecycle.archetype || lifecycle.economicModel?.archetype || '';
  const growth = Number(lifecycle.forwardGrowth ?? stock?.valuation?.businessForecast?.currentOperatingRate ?? stock?.growthYear1 ?? 0);
  const persistence = Number(lifecycle.growthPersistenceScore ?? lifecycle.compoundingPotential ?? 50) / 100;
  const sbc = Number(stock?.valuation?.sbcIntensity ?? stock?.financials?.years?.at(-1)?.sbcIntensity ?? 0);

  if (industry === 'financials') return {
    name: 'financial-earnings', primary: ['epsExit', 'dcf'], support: ['ownerEarnings'],
    weights: { epsExit: .40, dcf: .35, ownerEarnings: .25 }, maxBase: .18, maxRerating: .035,
  };
  if (industry === 'reit') return {
    name: 'asset-income', primary: ['ebitdaExit', 'dcf'], support: ['ownerEarnings'],
    weights: { ebitdaExit: .38, dcf: .37, ownerEarnings: .25 }, maxBase: .16, maxRerating: .025,
  };
  if (industry === 'utilities' || stage === 'Utility') return {
    name: 'regulated-cash-flow', primary: ['dcf', 'ownerEarnings'], support: ['ebitdaExit'],
    weights: { dcf: .50, ownerEarnings: .38, ebitdaExit: .12 }, maxBase: .14, maxRerating: .020,
  };
  if (['energy', 'materials'].includes(industry) || ['Cyclical', 'Asset Heavy'].includes(stage)) return {
    name: 'cycle-normalized', primary: ['dcf', 'ebitdaExit'], support: ['ownerEarnings'],
    weights: { dcf: .47, ebitdaExit: .28, ownerEarnings: .25 }, maxBase: .17, maxRerating: .025,
  };
  if (industry === 'semiconductors-hardware') return {
    name: 'innovation-cash-flow', primary: ['dcf', 'dcfSBCAdjusted'], support: ['epsExit', 'revenueExit'],
    weights: growth >= .18 && persistence >= .55
      ? { dcf: .43, dcfSBCAdjusted: .30, ownerEarnings: .12, epsExit: .10, revenueExit: .05 }
      : { dcf: .48, dcfSBCAdjusted: .27, ownerEarnings: .15, epsExit: .08, ebitdaExit: .02 },
    maxBase: growth >= .18 ? .24 : .19, maxRerating: .045,
  };
  if (industry === 'software') return {
    name: 'software-growth-quality', primary: ['dcfSBCAdjusted', 'dcf'], support: ['revenueExit', 'epsExit'],
    weights: growth >= .18
      ? { dcfSBCAdjusted: .35, dcf: .30, ownerEarnings: .15, revenueExit: .10, epsExit: .10 }
      : { dcfSBCAdjusted: .35, dcf: .30, ownerEarnings: .22, epsExit: .13 },
    maxBase: growth >= .18 ? .25 : .20, maxRerating: .045,
  };
  if (['Dividend Compounder', 'Mature'].includes(stage) || category === 'Dividend') return {
    name: 'mature-owner-cash-flow', primary: ['dcf', 'ownerEarnings'], support: ['epsExit'],
    weights: { dcf: .45, ownerEarnings: .43, epsExit: .12 }, maxBase: .15, maxRerating: .020,
  };
  if (['Growth', 'Hyper Growth', 'Temporary Disruption'].includes(stage) || growth >= .15) return {
    name: 'growth-quality', primary: ['dcf', 'epsExit'], support: ['dcfSBCAdjusted', 'revenueExit'],
    weights: sbc > .03
      ? { dcf: .32, dcfSBCAdjusted: .30, ownerEarnings: .18, epsExit: .12, revenueExit: .08 }
      : { dcf: .42, ownerEarnings: .25, epsExit: .18, ebitdaExit: .10, revenueExit: .05 },
    maxBase: growth >= .25 ? .26 : .22, maxRerating: .045,
  };
  if (['Elite Compounder', 'Compounder'].includes(stage) || category === 'Compounder') return {
    name: 'quality-compounder', primary: ['dcf', 'ownerEarnings'], support: ['epsExit'],
    weights: { dcf: .43, ownerEarnings: .37, epsExit: .15, ebitdaExit: .05 }, maxBase: .19, maxRerating: .030,
  };
  return {
    name: 'value-cash-flow', primary: ['dcf', 'ownerEarnings'], support: ['epsExit', 'ebitdaExit'],
    weights: { dcf: .43, ownerEarnings: .35, epsExit: .12, ebitdaExit: .10 }, maxBase: .18, maxRerating: .030,
  };
}

function reliability(method, presentValue, futureValue, centerPresent, centerFuture, profile, stock) {
  if (!(presentValue > 0) || !(futureValue > 0)) return 0;
  if (profile.invalidMethods?.includes(method)) return 0;
  let r = specialistReliabilityAdjustment(profile.specialist ? {
    key: profile.name, invalidMethods: profile.invalidMethods
  } : null, method, stock);
  const pRatio = Math.max(presentValue / centerPresent, centerPresent / presentValue);
  const fRatio = Math.max(futureValue / centerFuture, centerFuture / futureValue);
  if (pRatio > 3 || fRatio > 3) r *= .20;
  else if (pRatio > 2 || fRatio > 2) r *= .45;
  else if (pRatio > 1.6 || fRatio > 1.6) r *= .72;

  const years = stock?.financials?.years || [];
  const recent = years.slice(-5);
  const positiveFcf = recent.length ? recent.filter(y => Number(y.fcf) > 0).length / recent.length : .5;
  const positiveIncome = recent.length ? recent.filter(y => Number(y.netIncome) > 0).length / recent.length : .5;
  const last = recent.at(-1) || {};
  const sbcIntensity = last.revenue > 0 ? Number(last.sbc || 0) / last.revenue : 0;

  if (method === 'ownerEarnings' && positiveFcf < .8) r *= .50;
  if (method === 'epsExit' && positiveIncome < .8) r *= .55;
  if (method === 'dcf' && positiveFcf < .6) r *= .60;
  if (method === 'dcfSBCAdjusted' && sbcIntensity < .01) r *= .70;
  if (method === 'revenueExit' && !profile.name.includes('growth') && !profile.name.includes('innovation')) r *= .35;
  return clamp(r, .05, 1);
}

function normalizeRows(rows) {
  const total = rows.reduce((s, x) => s + x.rawWeight, 0);
  return rows.map(x => ({ ...x, weight: total > 0 ? x.rawWeight / total : 0 }));
}

// V53: no valuation method should silently become the entire model merely
// because the alternatives are missing or receive low reliability scores.
// This preserves specialist models that intentionally use two methods while
// preventing CAR-like 90%+ DCF concentration from masquerading as consensus.
function capMethodConcentration(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const maxWeight = rows.length >= 4 ? .55 : rows.length === 3 ? .65 : .78;
  let prepared = rows.map(x => ({ ...x, rawWeight: Math.max(0, Number(x.rawWeight) || 0) }));
  let remaining = 1;
  const result = [];
  const pending = [...prepared];
  while (pending.length) {
    const total = pending.reduce((sum, x) => sum + x.rawWeight, 0);
    if (!(total > 0)) {
      const equal = remaining / pending.length;
      result.push(...pending.map(x => ({ ...x, weight: equal })));
      break;
    }
    const over = pending.find(x => remaining * x.rawWeight / total > maxWeight + 1e-12);
    if (!over) {
      result.push(...pending.map(x => ({ ...x, weight: remaining * x.rawWeight / total })));
      break;
    }
    result.push({ ...over, weight: maxWeight });
    remaining -= maxWeight;
    pending.splice(pending.indexOf(over), 1);
  }
  return result;
}

function maxCrediblePositiveRerating({ operatingAnchor, quality, agreementScore, methodConcentration, profileMaxRerating }) {
  const op = Number(operatingAnchor);
  const q = clamp(Number(quality || 0), 0, 1);
  const agreement = clamp(Number(agreementScore || 0) / 100, 0, 1);
  const concentration = clamp(Number(methodConcentration || 0), 0, 1);
  const profileAllowance = clamp(Number(profileMaxRerating || .03), .005, .085);

  // Slow or non-compounding businesses must not receive high-teens or 30%+
  // annual returns purely from theoretical valuation normalization. Stronger
  // operating businesses earn more rerating room, but still need corroboration.
  let base;
  if (!finite(op) || op <= .025) base = .055;
  else if (op <= .06) base = .070;
  else if (op <= .10) base = .085;
  else if (op <= .16) base = .105;
  else base = .125;

  const qualityCredit = clamp((q - .50) * .055, -.018, .025);
  const evidenceAdjustment = clamp((agreement - .60) * .035, -.020, .014);
  const concentrationPenalty = concentration > .80 ? .025 : concentration > .68 ? .014 : 0;
  return clamp(Math.max(profileAllowance, base + qualityCredit + evidenceAdjustment - concentrationPenalty), .035, .14);
}

function qualityContext(stock, lifecycle = {}) {
  const moat = clamp(Number(stock?.valuation?.moat?.score ?? 50) / 100, 0, 1);
  const pricing = clamp(Number(stock?.valuation?.pricingPowerV2?.score ?? stock?.pricingPowerScore ?? 50) / 100, 0, 1);
  const lifecyclePersistence = Number.isFinite(Number(lifecycle?.growthPersistenceScore)) ? Number(lifecycle.growthPersistenceScore) / 100 : .50;
  const persistence = clamp(Number(stock?.valuation?.businessProfile?.premiumPersistence ?? lifecyclePersistence), 0, 1);
  const reliability = clamp(Number(stock?.valuation?.businessProfile?.forecastReliability ?? .50), 0, 1);
  const economic = clamp(Number(stock?.valuation?.economicQuality?.overall ?? 50) / 100, 0, 1);
  const compounder = clamp(Number(stock?.valuation?.compounder?.score ?? 50) / 100, 0, 1);
  const quality = clamp(moat * .24 + pricing * .16 + persistence * .22 + reliability * .14 + economic * .14 + compounder * .10, 0, 1);
  return { quality, moat, pricing, persistence, reliability, economic, compounder };
}

function selectedValuation({ stock, category, lifecycle, methodResults, model, calibration = null }) {
  const profile = profileFor(stock, category, lifecycle);
  const fullForecastYears = Math.max(1, Number(model?.projection?.length) || 5);
  const investmentYears = Math.min(5, fullForecastYears);
  const all = Object.entries(methodResults).map(([key, result]) => {
    const presentValue = Number(result?.fairValuePerShare);
    const terminalExitValue = Number(result?.exitPricePerShare);
    // Valuation methods are often projected to the lifecycle horizon (7-10 years),
    // while the screener promises a five-year expected return. Convert every method
    // to a consistent five-year exit value instead of annualizing a nine-year target
    // and labeling it five-year.
    const horizonExitValue = presentValue > 0 && terminalExitValue > 0
      ? presentValue * Math.pow(terminalExitValue / presentValue, investmentYears / fullForecastYears)
      : terminalExitValue;
    return { key, presentValue, futureValue: horizonExitValue, terminalExitValue };
  }).filter(x => x.presentValue > 0 && x.futureValue > 0 && (profile.weights[x.key] || 0) > 0);

  if (all.length < 2) return null;
  const centerPresent = median(all.map(x => x.presentValue));
  const centerFuture = median(all.map(x => x.futureValue));
  const adaptive = adaptiveMethodWeights({
    industry: stock?.valuation?.industryModel?.model || 'general',
    category,
    startingWeights: profile.weights,
    availableKeys: all.map(x => x.key),
    calibration,
  });
  let rows = all.map(x => ({
    ...x,
    reliability: reliability(x.key, x.presentValue, x.futureValue, centerPresent, centerFuture, profile, stock),
  })).map(x => ({ ...x, rawWeight: (adaptive.weights[x.key] || 0) * x.reliability }));
  rows = normalizeRows(rows).filter(x => x.weight >= .035);
  rows = capMethodConcentration(rows);
  const maxMethodWeight = rows.reduce((m, x) => Math.max(m, Number(x.weight) || 0), 0);

  const methodBlendFairValueToday = robustWeightedValue(rows, 'presentValue');
  const rawExitValue = robustWeightedValue(rows, 'futureValue');
  const currentPrice = Number(stock?.price?.current);
  const years = investmentYears;
  const dividendYield = clamp(Number(stock?.valuation?.dividendYield || 0), 0, .12);
  const dividends = currentPrice * dividendYield * years;
  const rawCAGR = currentPrice > 0 && rawExitValue > 0
    ? Math.pow((rawExitValue + dividends) / currentPrice, 1 / years) - 1
    : null;

  const exit = model?.projection?.[Math.max(0, investmentYears - 1)] || model?.projection?.at(-1) || {};
  const start = stock?.financials?.years?.at(-1) || {};

  // V40: calculate the operating anchor from the actual projected business at the
  // investment horizon. Do not let a temporarily depressed FCF/net-income base make
  // a mature company appear capable of compounding at 30%+ for five years.
  const startRevenue = Number(start.revenue);
  const exitRevenue = Number(exit.revenue);
  const startShares = Number(start.sharesOutTTM);
  const exitShares = Number(exit.shares);
  const startFcfMargin = startRevenue > 0 ? Number(start.fcf || 0) / startRevenue : null;
  const exitFcfMargin = Number(exit.fcfMargin);
  const startNetMargin = startRevenue > 0 ? Number(start.netIncome || 0) / startRevenue : null;
  const exitNetMargin = Number(exit.netMargin);

  const revenueCAGR = startRevenue > 0 && exitRevenue > 0
    ? Math.pow(exitRevenue / startRevenue, 1 / years) - 1 : null;
  const shareCAGR = startShares > 0 && exitShares > 0
    ? Math.pow(startShares / exitShares, 1 / years) - 1 : null;

  // Prefer FCF margins when both endpoints are usable. Fall back to net margins.
  const forceNetMarginBridge = !!profile.useNetMarginForBridge;
  const marginStart = !forceNetMarginBridge && startFcfMargin > .005 && exitFcfMargin > .005 ? startFcfMargin
    : startNetMargin > .005 && exitNetMargin > .005 ? startNetMargin : null;
  const marginEnd = !forceNetMarginBridge && startFcfMargin > .005 && exitFcfMargin > .005 ? exitFcfMargin
    : startNetMargin > .005 && exitNetMargin > .005 ? exitNetMargin : null;
  const rawMarginCAGR = marginStart > 0 && marginEnd > 0
    ? Math.pow(marginEnd / marginStart, 1 / years) - 1 : 0;

  // Component discipline: a five-year central case should not be driven by an
  // extreme starting margin or heroic buybacks. These are annual contribution caps,
  // not arbitrary CAGR overrides; the final CAGR still maps exactly to the final
  // actionable exit price below.
  const revenueContribution = finite(revenueCAGR) ? clamp(revenueCAGR, -.12, .30) : null;
  const marginContribution = clamp(rawMarginCAGR || 0, -.04, .045);
  const shareContribution = finite(shareCAGR) ? clamp(shareCAGR, -.04, .035) : 0;
  const rawOperatingCAGR = finite(revenueContribution)
    ? revenueContribution + marginContribution + shareContribution : null;
  const quality = qualityContext(stock, lifecycle);

  // V51 market-expectations calibration. Reverse-DCF implied growth is not used
  // as a target forecast; it is a price-expectations reference. When the market
  // already requires more growth than the unified forecast, the operating anchor
  // receives a meaningful haircut. When the forecast exceeds priced-in growth,
  // only a small, reliability-weighted credit is granted to avoid double-counting
  // valuation upside already represented by the selected methods.
  const marketImpliedGrowth = Number(stock?.valuation?.marketImpliedGrowth);
  const modeledGrowthAnchor = finite(revenueCAGR)
    ? Number(revenueCAGR)
    : Number(lifecycle?.forwardGrowth ?? stock?.valuation?.businessForecast?.currentOperatingRate);
  const expectationsGap = finite(marketImpliedGrowth) && finite(modeledGrowthAnchor)
    ? modeledGrowthAnchor - marketImpliedGrowth : null;
  const expectationsReliability = clamp(
    quality.reliability * .55 + quality.persistence * .25 + quality.quality * .20,
    .20, 1
  );
  let marketExpectationsAdjustment = 0;
  if (finite(expectationsGap)) {
    if (expectationsGap < 0) {
      marketExpectationsAdjustment = clamp(expectationsGap * (.30 + .25 * (1 - expectationsReliability)), -.045, 0);
    } else {
      marketExpectationsAdjustment = clamp(expectationsGap * (.10 + .10 * expectationsReliability), 0, .018);
    }
  }
  const operatingCAGR = finite(rawOperatingCAGR)
    ? rawOperatingCAGR + marketExpectationsAdjustment : null;
  const disagreement = median(rows.map(x => Math.abs(x.presentValue - methodBlendFairValueToday) / methodBlendFairValueToday)) || 0;
  const agreementScore = Math.round(clamp(100 - disagreement * 180, 0, 100));
  const agreementWeight = agreementInfluence(agreementScore);
  const valuationTrust = clamp(
    agreementWeight * .66 + quality.reliability * .34,
    .12, 1
  );

  // Mature businesses cannot earn 30%+ central returns from rerating. Growth
  // businesses can earn more, but only when operating value creation supports it.
  let adjustedCAGR = rawCAGR;
  const qualityPremium = clamp((quality.quality - .55) * .08 + (quality.persistence - .50) * .05, -.025, .055);
  const dynamicReratingAllowance = clamp(profile.maxRerating + qualityPremium, .005, .085);
  const dynamicBaseCeiling = clamp(profile.maxBase + Math.max(0, qualityPremium * .65), profile.maxBase, .30);
  let valuationDragFloor = null;
  let rawValuationDrag = null;
  let maxTrustedNegativeDrag = null;
  const forwardGrowth = Number(lifecycle?.forwardGrowth ?? stock?.valuation?.businessForecast?.currentOperatingRate ?? 0);
  const eliteOperatingSetup = quality.quality >= .65 && quality.reliability >= .52 &&
    quality.persistence >= .52 && forwardGrowth >= .20;

  // Valuation rerating is probabilistic, not certain. Separate the operating
  // return anchor from the raw valuation contribution, then probability-weight
  // that contribution based on agreement, forecast evidence, valuation extremity,
  // and premium persistence.
  let disagreementShrinkApplied = false;
  let preAgreementCAGR = adjustedCAGR;
  let reratingProbabilityValue = null;
  let probabilityWeightedValuationDrag = null;
  let operatingAnchorForRerating = null;
  const forwardPeForProbability = Number(stock?.valuation?.forwardPe ?? stock?.valuation?.pe ?? 0);
  const evRevenueForProbability = Number(stock?.valuation?.evRevenue ?? 0);
  const extremeValuationForProbability = clamp(Math.max(
    forwardPeForProbability > 0 ? (forwardPeForProbability - 38) / 82 : 0,
    evRevenueForProbability > 0 ? (evRevenueForProbability - 8) / 24 : 0
  ), 0, 1);
  if (finite(adjustedCAGR) && finite(operatingCAGR)) {
    operatingAnchorForRerating = clamp(operatingCAGR + dividendYield, -.25, dynamicBaseCeiling);
    const fullValuationDrag = adjustedCAGR - operatingAnchorForRerating;
    reratingProbabilityValue = reratingProbability({
      rawValuationDrag: fullValuationDrag,
      agreementScore,
      quality: quality.quality,
      premiumPersistence: quality.persistence,
      forecastReliability: quality.reliability,
      extremeValuation: extremeValuationForProbability,
      profileName: profile.name,
    });
    probabilityWeightedValuationDrag = fullValuationDrag * reratingProbabilityValue;
    adjustedCAGR = operatingAnchorForRerating + probabilityWeightedValuationDrag;
    disagreementShrinkApplied = Math.abs(adjustedCAGR - preAgreementCAGR) > 1e-9;
  }

  if (finite(adjustedCAGR)) {
    if (finite(operatingCAGR)) {
      const maxFromOperations = operatingCAGR + dynamicReratingAllowance + dividendYield;
      adjustedCAGR = Math.min(adjustedCAGR, maxFromOperations);

      // Mature/compounder sanity ceiling. Very high modeled returns must be earned by
      // projected revenue, margins, and per-share economics—not by valuation-method
      // outliers or a low comparison base. Hyper-growth profiles retain more room.
      const profileCeiling = profile.name.includes('software') || profile.name.includes('innovation')
        ? .30 : profile.name.includes('growth') ? .27
          : profile.name.includes('quality-compounder') ? .22
            : profile.name.includes('financial') ? .20 : .19;
      const evidenceCeiling = clamp(maxFromOperations + Math.max(0, quality.quality - .70) * .04,
        -.20, profileCeiling);
      adjustedCAGR = Math.min(adjustedCAGR, evidenceCeiling);

      // V36: valuation is evidence, not certainty. When a high-quality, high-growth
      // business has a credible operating forecast, an internally disputed set of
      // valuation methods cannot impose unlimited negative multiple drag. Extreme
      // valuations may still produce low or negative returns, but the burden of
      // proof rises with disagreement and forecast quality.
      const profitableDigitalFinancial = profile.name === 'digital-financial-platform' &&
        revenueContribution >= .12 && exitNetMargin >= .08 &&
        Number(exit.eps) > 0 && agreementScore >= 55;

      if (eliteOperatingSetup || profitableDigitalFinancial) {
        const businessAnchor = Math.min(operatingCAGR, dynamicBaseCeiling);
        rawValuationDrag = rawCAGR - businessAnchor;
        const forwardPe = Number(stock?.valuation?.forwardPe ?? stock?.valuation?.pe ?? 0);
        const evRevenue = Number(stock?.valuation?.evRevenue ?? 0);
        const extremeValuation = clamp(Math.max(
          forwardPe > 0 ? (forwardPe - 55) / 95 : 0,
          evRevenue > 0 ? (evRevenue - 12) / 28 : 0
        ), 0, 1);
        const profileDragBase = profile.name === 'digital-financial-platform' ? .10
          : profile.name.includes('software') ? .19
            : profile.name.includes('innovation') ? .17
              : profile.name.includes('growth') ? .16 : .12;
        maxTrustedNegativeDrag = clamp(
          profileDragBase * (.42 + .58 * valuationTrust) + extremeValuation * .10,
          profile.name === 'digital-financial-platform' ? .075 : .07,
          profile.name === 'digital-financial-platform' ? .18 : .28
        );
        valuationDragFloor = businessAnchor - maxTrustedNegativeDrag;
        adjustedCAGR = Math.max(adjustedCAGR, valuationDragFloor);
      }
    }
    // V53 return-driver plausibility guard. Fair value can still display large
    // theoretical upside, but central expected CAGR may not assume that all of
    // that gap closes within five years. This specifically prevents weak/flat
    // businesses from posting 30%+ expected returns almost entirely from rerating.
    if (finite(operatingAnchorForRerating) && adjustedCAGR > operatingAnchorForRerating) {
      const crediblePositiveRerating = maxCrediblePositiveRerating({
        operatingAnchor: operatingAnchorForRerating,
        quality: quality.quality,
        agreementScore,
        methodConcentration: maxMethodWeight,
        profileMaxRerating: profile.maxRerating,
      });
      adjustedCAGR = Math.min(adjustedCAGR, operatingAnchorForRerating + crediblePositiveRerating);
    }
    adjustedCAGR = clamp(adjustedCAGR, -.35, dynamicBaseCeiling);
  }
  const actionableExitValue = finite(adjustedCAGR)
    ? Math.max(0, currentPrice * Math.pow(1 + adjustedCAGR, years) - dividends)
    : null;

  // V50 single-source-of-truth valuation bridge. Each selected method already
  // supplies a present value and a value at the investment horizon. Their ratio
  // implies the annual discount rate used by that method. We blend those implied
  // rates, then discount the canonical actionable future value back to today.
  // This mathematically links fair value today, the five-year target, dividends,
  // and expected CAGR. A separately blended present value remains available only
  // as a diagnostic, so it can no longer produce contradictions such as a fair
  // value today above the future target for a non-dividend stock.
  const impliedRateRows = rows.map(x => {
    const rate = x.presentValue > 0 && x.futureValue > 0
      ? Math.pow(x.futureValue / x.presentValue, 1 / years) - 1
      : null;
    return { ...x, impliedDiscountRate: finite(rate) ? clamp(rate, .035, .22) : null };
  }).filter(x => finite(x.impliedDiscountRate));
  const impliedDiscountRate = clamp(
    weightedAverageRows(impliedRateRows, 'impliedDiscountRate') ?? .10,
    .05, .18
  );
  const annualDividend = years > 0 ? dividends / years : 0;
  let presentValueOfDividends = 0;
  for (let t = 1; t <= years; t++) {
    presentValueOfDividends += annualDividend / Math.pow(1 + impliedDiscountRate, t);
  }
  const presentValueOfExit = actionableExitValue != null
    ? actionableExitValue / Math.pow(1 + impliedDiscountRate, years)
    : null;
  const linkedFairValueToday = presentValueOfExit != null
    ? presentValueOfExit + presentValueOfDividends
    : methodBlendFairValueToday;
  const fairValueToday = linkedFairValueToday;
  const valuationConsistencyGap = methodBlendFairValueToday > 0 && linkedFairValueToday > 0
    ? methodBlendFairValueToday / linkedFairValueToday - 1
    : null;

  return {
    version: 'v53-rerating-disciplined-unified-valuation',
    businessArchetype: lifecycle?.archetype || lifecycle?.economicModel?.archetype || null,
    profile: profile.name,
    profileLabel: profile.label || profile.name,
    specialistModel: !!profile.specialist,
    specialistNotes: profile.specialistNotes || [],
    primaryMethods: profile.primary,
    supportingMethods: profile.support,
    adaptiveMethodWeights: adaptive,
    selectedMethods: rows.map(x => ({
      method: x.key, label: METHOD_LABELS[x.key] || x.key,
      weight: x.weight, reliability: x.reliability,
      fairValueToday: x.presentValue, exitValue: x.futureValue, terminalExitValue: x.terminalExitValue,
    })),
    fairValueToday,
    linkedFairValueToday,
    methodBlendFairValueToday,
    impliedDiscountRate,
    presentValueOfExit,
    presentValueOfDividends,
    valuationConsistencyGap,
    rawExitValue,
    actionableExitValue,
    rawCAGR,
    expectedCAGR: adjustedCAGR,
    operatingCAGR,
    operatingBridge: {
      revenueCAGR,
      revenueContribution,
      rawMarginCAGR,
      marginContribution,
      shareCAGR,
      shareContribution,
      rawOperatingCAGR,
      modeledGrowthAnchor,
      marketImpliedGrowth: finite(marketImpliedGrowth) ? marketImpliedGrowth : null,
      expectationsGap,
      marketExpectationsAdjustment,
      expectationsReliability,
    },
    // Exact audit trail for the displayed CAGR. The expected return is always
    // derived from the actionable value at the end of the investment period,
    // plus modeled dividends, relative to today's price.
    cagrAudit: {
      currentPrice,
      projectionYears: years,
      projectionEndYear: exit.year ?? null,
      projectedRevenue: exitRevenue > 0 ? exitRevenue : null,
      projectedShares: exitShares > 0 ? exitShares : null,
      rawBlendedExitValue: rawExitValue,
      methodBlendFairValueToday,
      linkedFairValueToday,
      impliedDiscountRate,
      presentValueOfExit,
      presentValueOfDividends,
      valuationConsistencyGap,
      actionableExitValue,
      modeledDividends: dividends,
      totalEndingValue: actionableExitValue != null ? actionableExitValue + dividends : null,
      formula: '((actionableExitValue + modeledDividends) / currentPrice)^(1 / projectionYears) - 1',
      expectedCAGR: adjustedCAGR,
    },
    dividends,
    years,
    agreementScore,
    fullForecastYears,
    investmentYears,
    qualityContext: quality,
    qualityPremium,
    maxBaseCAGR: dynamicBaseCeiling,
    maxReratingContribution: dynamicReratingAllowance,
    valuationTrust,
    agreementWeight,
    preAgreementCAGR,
    disagreementShrinkApplied,
    eliteOperatingSetup,
    rawValuationDrag,
    valuationDragFloor,
    maxTrustedNegativeDrag,
    reratingProbability: reratingProbabilityValue,
    probabilityWeightedValuationDrag,
    operatingAnchorForRerating,
    marketImpliedGrowth: finite(marketImpliedGrowth) ? marketImpliedGrowth : null,
    modeledGrowthAnchor,
    expectationsGap,
    marketExpectationsAdjustment,
    expectationsReliability,
    extremeValuationForProbability,
    maxMethodWeight,
    methodConcentrationCapped: maxMethodWeight <= (rows.length >= 4 ? .55 : rows.length === 3 ? .65 : .78) + 1e-9,
    crediblePositiveReratingCap: finite(operatingAnchorForRerating) ? maxCrediblePositiveRerating({ operatingAnchor: operatingAnchorForRerating, quality: quality.quality, agreementScore, methodConcentration: maxMethodWeight, profileMaxRerating: profile.maxRerating }) : null,
    robustBlend: true,
    unifiedForecastLinkedValuation: true,
  };
}

module.exports = { selectedValuation, profileFor, agreementInfluence, capMethodConcentration, maxCrediblePositiveRerating };
