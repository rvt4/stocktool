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
const median = values => {
  const a = values.filter(finite).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const METHOD_LABELS = {
  dcf: 'DCF', dcfSBCAdjusted: 'SBC-adjusted DCF', ownerEarnings: 'Owner Earnings',
  revenueExit: 'Revenue Exit', epsExit: 'EPS Exit', ebitdaExit: 'EV/EBITDA Exit',
};

function profileFor(stock, category, lifecycle = {}) {
  const industry = stock?.valuation?.industryModel?.model || 'general';
  const stage = lifecycle.stage || category || 'Value';
  const archetype = lifecycle.archetype || lifecycle.economicModel?.archetype || '';
  const growth = Number(lifecycle.forwardGrowth ?? stock?.valuation?.businessForecast?.currentOperatingRate ?? stock?.growthYear1 ?? 0);
  const persistence = Number(lifecycle.growthPersistenceScore ?? lifecycle.compoundingPotential ?? 50) / 100;
  const sbc = Number(stock?.valuation?.sbcIntensity ?? stock?.financials?.years?.at(-1)?.sbcIntensity ?? 0);

  if (industry === 'financials') return {
    name: 'financial-earnings', primary: ['epsExit', 'dcf'], support: ['ownerEarnings'],
    weights: { epsExit: .55, dcf: .30, ownerEarnings: .15 }, maxBase: .18, maxRerating: .035,
  };
  if (industry === 'reit') return {
    name: 'asset-income', primary: ['ebitdaExit', 'dcf'], support: ['ownerEarnings'],
    weights: { ebitdaExit: .50, dcf: .30, ownerEarnings: .20 }, maxBase: .16, maxRerating: .025,
  };
  if (industry === 'utilities' || stage === 'Utility') return {
    name: 'regulated-cash-flow', primary: ['dcf', 'ownerEarnings'], support: ['ebitdaExit'],
    weights: { dcf: .50, ownerEarnings: .30, ebitdaExit: .20 }, maxBase: .14, maxRerating: .020,
  };
  if (['energy', 'materials'].includes(industry) || ['Cyclical', 'Asset Heavy'].includes(stage)) return {
    name: 'cycle-normalized', primary: ['dcf', 'ebitdaExit'], support: ['ownerEarnings'],
    weights: { dcf: .45, ebitdaExit: .40, ownerEarnings: .15 }, maxBase: .17, maxRerating: .025,
  };
  if (industry === 'semiconductors-hardware') return {
    name: 'innovation-cash-flow', primary: ['dcf', 'dcfSBCAdjusted'], support: ['epsExit', 'revenueExit'],
    weights: growth >= .18 && persistence >= .55
      ? { dcf: .45, dcfSBCAdjusted: .25, epsExit: .20, revenueExit: .10 }
      : { dcf: .50, dcfSBCAdjusted: .25, epsExit: .20, ebitdaExit: .05 },
    maxBase: growth >= .18 ? .24 : .19, maxRerating: .045,
  };
  if (industry === 'software') {
    const eliteGrowth = growth >= .24 && persistence >= .62;
    return {
      name: eliteGrowth ? 'software-platform-growth' : 'software-growth-quality',
      primary: eliteGrowth ? ['dcfSBCAdjusted', 'revenueExit'] : ['dcfSBCAdjusted', 'dcf'],
      support: ['revenueExit', 'epsExit', 'dcf'],
      // High-growth software should not be valued almost entirely from near-term
      // FCF while it is deliberately reinvesting. SBC-adjusted DCF still matters,
      // but revenue and EPS exits receive more weight when growth persistence and
      // quality support the platform economics.
      weights: eliteGrowth
        ? { dcfSBCAdjusted: .28, dcf: .17, revenueExit: .30, epsExit: .25 }
        : growth >= .18
          ? { dcfSBCAdjusted: .35, dcf: .25, revenueExit: .22, epsExit: .18 }
          : { dcfSBCAdjusted: .35, dcf: .30, epsExit: .25, ownerEarnings: .10 },
      maxBase: eliteGrowth ? .28 : growth >= .18 ? .25 : .20,
      maxRerating: eliteGrowth ? .055 : .045,
    };
  }
  if (['Dividend Compounder', 'Mature'].includes(stage) || category === 'Dividend') return {
    name: 'mature-owner-cash-flow', primary: ['dcf', 'ownerEarnings'], support: ['epsExit'],
    weights: { dcf: .45, ownerEarnings: .35, epsExit: .20 }, maxBase: .15, maxRerating: .020,
  };
  if (['Growth', 'Hyper Growth', 'Temporary Disruption'].includes(stage) || growth >= .15) return {
    name: 'growth-quality', primary: ['dcf', 'epsExit'], support: ['dcfSBCAdjusted', 'revenueExit'],
    weights: sbc > .03
      ? { dcf: .30, dcfSBCAdjusted: .30, epsExit: .25, revenueExit: .15 }
      : { dcf: .40, epsExit: .30, ebitdaExit: .20, revenueExit: .10 },
    maxBase: growth >= .25 ? .26 : .22, maxRerating: .045,
  };
  if (['Elite Compounder', 'Compounder'].includes(stage) || category === 'Compounder') return {
    name: 'quality-compounder', primary: ['dcf', 'ownerEarnings'], support: ['epsExit'],
    weights: { dcf: .45, ownerEarnings: .25, epsExit: .25, ebitdaExit: .05 }, maxBase: .19, maxRerating: .030,
  };
  return {
    name: 'value-cash-flow', primary: ['dcf', 'ownerEarnings'], support: ['epsExit', 'ebitdaExit'],
    weights: { dcf: .40, ownerEarnings: .25, epsExit: .20, ebitdaExit: .15 }, maxBase: .18, maxRerating: .030,
  };
}

function reliability(method, presentValue, futureValue, centerPresent, centerFuture, profile, stock) {
  if (!(presentValue > 0) || !(futureValue > 0)) return 0;
  let r = 1;
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

function selectedValuation({ stock, category, lifecycle, methodResults, model }) {
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
  let rows = all.map(x => ({
    ...x,
    reliability: reliability(x.key, x.presentValue, x.futureValue, centerPresent, centerFuture, profile, stock),
  })).map(x => ({ ...x, rawWeight: (profile.weights[x.key] || 0) * x.reliability }));
  rows = normalizeRows(rows).filter(x => x.weight >= .035);
  rows = normalizeRows(rows);

  const fairValueToday = rows.reduce((s, x) => s + x.presentValue * x.weight, 0);
  const rawExitValue = rows.reduce((s, x) => s + x.futureValue * x.weight, 0);
  const currentPrice = Number(stock?.price?.current);
  const years = investmentYears;
  const dividendYield = clamp(Number(stock?.valuation?.dividendYield || 0), 0, .12);
  const dividends = currentPrice * dividendYield * years;
  const rawCAGR = currentPrice > 0 && rawExitValue > 0
    ? Math.pow((rawExitValue + dividends) / currentPrice, 1 / years) - 1
    : null;

  const exit = model?.projection?.[Math.max(0, investmentYears - 1)] || model?.projection?.at(-1) || {};
  const start = stock?.financials?.years?.at(-1) || {};
  const startPerShare = start.sharesOutTTM > 0 ? Math.max(start.fcf || start.netIncome || 0, 0) / start.sharesOutTTM : null;
  const exitPerShare = exit.shares > 0 ? Math.max(exit.fcf || exit.netIncome || 0, 0) / exit.shares : null;
  const operatingCAGR = startPerShare > 0 && exitPerShare > 0 ? Math.pow(exitPerShare / startPerShare, 1 / years) - 1 : null;
  const quality = qualityContext(stock, lifecycle);
  const disagreement = median(rows.map(x => Math.abs(x.presentValue - fairValueToday) / fairValueToday)) || 0;
  const agreementScore = Math.round(clamp(100 - disagreement * 180, 0, 100));
  const valuationTrust = clamp(.18 + (agreementScore / 100) * .48 + quality.reliability * .34, .18, 1);

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
  const eliteOperatingSetup = quality.quality >= .63 && quality.reliability >= .50 &&
    quality.persistence >= .52 && forwardGrowth >= .18;
  const exceptionalGrowthSetup = eliteOperatingSetup && forwardGrowth >= .28 &&
    quality.quality >= .68 && quality.persistence >= .62;

  if (finite(adjustedCAGR)) {
    if (finite(operatingCAGR)) {
      const maxFromOperations = operatingCAGR + dynamicReratingAllowance + dividendYield;
      adjustedCAGR = Math.min(adjustedCAGR, maxFromOperations);

      // V36: valuation is evidence, not certainty. When a high-quality, high-growth
      // business has a credible operating forecast, an internally disputed set of
      // valuation methods cannot impose unlimited negative multiple drag. Extreme
      // valuations may still produce low or negative returns, but the burden of
      // proof rises with disagreement and forecast quality.
      if (eliteOperatingSetup) {
        const businessAnchor = Math.min(operatingCAGR, dynamicBaseCeiling);
        rawValuationDrag = rawCAGR - businessAnchor;
        const forwardPe = Number(stock?.valuation?.forwardPe ?? stock?.valuation?.pe ?? 0);
        const evRevenue = Number(stock?.valuation?.evRevenue ?? 0);
        const extremeValuation = clamp(Math.max(
          forwardPe > 0 ? (forwardPe - 55) / 95 : 0,
          evRevenue > 0 ? (evRevenue - 12) / 28 : 0
        ), 0, 1);
        const profileDragBase = profile.name.includes('software-platform') ? .16
          : profile.name.includes('software') ? .19
          : profile.name.includes('innovation') ? .17
            : profile.name.includes('growth') ? .16 : .12;
        maxTrustedNegativeDrag = clamp(
          profileDragBase * (.42 + .58 * valuationTrust) + extremeValuation * .10,
          exceptionalGrowthSetup ? .06 : .07, exceptionalGrowthSetup ? .24 : .28
        );
        valuationDragFloor = businessAnchor - maxTrustedNegativeDrag;
        adjustedCAGR = Math.max(adjustedCAGR, valuationDragFloor);
      }
    }
    adjustedCAGR = clamp(adjustedCAGR, -.35, dynamicBaseCeiling);
  }
  const actionableExitValue = finite(adjustedCAGR)
    ? Math.max(0, currentPrice * Math.pow(1 + adjustedCAGR, years) - dividends)
    : null;


  return {
    version: 'v36-business-first-primary-valuation',
    profile: profile.name,
    primaryMethods: profile.primary,
    supportingMethods: profile.support,
    selectedMethods: rows.map(x => ({
      method: x.key, label: METHOD_LABELS[x.key] || x.key,
      weight: x.weight, reliability: x.reliability,
      fairValueToday: x.presentValue, exitValue: x.futureValue, terminalExitValue: x.terminalExitValue,
    })),
    fairValueToday,
    rawExitValue,
    actionableExitValue,
    rawCAGR,
    expectedCAGR: adjustedCAGR,
    operatingCAGR,
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
    eliteOperatingSetup,
    exceptionalGrowthSetup,
    rawValuationDrag,
    valuationDragFloor,
    maxTrustedNegativeDrag,
  };
}

module.exports = { selectedValuation, profileFor };
