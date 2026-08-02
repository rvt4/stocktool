'use strict';

/**
 * V44 institutional valuation dispatcher.
 *
 * The general valuation engine works well for operating companies, but cash-flow
 * definitions are not economically comparable across banks, insurers, REITs and
 * regulated utilities. This dispatcher changes method selection and reliability
 * without adding ticker-specific exceptions or changing the public CAGR formula.
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));

function textFor(stock) {
  return [
    stock?.sector,
    stock?.industry,
    stock?.name,
    stock?.valuation?.industryModel?.model,
    stock?.valuation?.industryModel?.key,
  ].filter(Boolean).join(' ').toLowerCase();
}

function recentOperatingFacts(stock) {
  const years = stock?.financials?.years || [];
  const recent = years.slice(-5);
  const last = recent.at(-1) || {};
  const positiveIncomeRate = recent.length
    ? recent.filter(y => Number(y.netIncome) > 0).length / recent.length : 0;
  const positiveFcfRate = recent.length
    ? recent.filter(y => Number(y.fcf) > 0 && !y.fcfIsProxy).length / recent.length : 0;
  const revenueProxyRate = recent.length
    ? recent.filter(y => y.revenueIsProxy).length / recent.length : 0;
  const analystGrowth = Number(
    stock?.analystEstimates?.revenueGrowthNextYear ??
    stock?.analystEstimates?.revenueGrowthCurrentYear ??
    stock?.analystEstimates?.revenueGrowthFwd
  );
  return {
    years: recent.length,
    last,
    positiveIncomeRate,
    positiveFcfRate,
    revenueProxyRate,
    analystGrowth: finite(analystGrowth) ? analystGrowth : null,
  };
}

function resolveInstitutionalValuationModel(stock, category, lifecycle = {}) {
  const text = textFor(stock);
  const facts = recentOperatingFacts(stock);
  const industryModel = stock?.valuation?.industryModel?.model || '';
  const isFinancial = industryModel === 'financials' || /bank|financial|credit|lending|fintech|broker|capital market|asset manage|insurance/.test(text);
  const isInsurance = /insurance|reinsurance|property casualty|life insurer|insurance broker/.test(text);
  const isAssetManager = /asset management|investment management|wealth management|capital markets|brokerage|exchange/.test(text);
  const isReit = industryModel === 'reit' || /reit|real estate investment trust/.test(text);
  const isUtility = industryModel === 'utilities' || /utility|utilities|regulated electric|regulated gas/.test(text);

  if (isInsurance) {
    return {
      key: 'insurance-earnings-book',
      label: 'Insurance earnings / book-value proxy',
      primary: ['epsExit'],
      support: ['ownerEarnings', 'dcf'],
      weights: { epsExit: .68, ownerEarnings: .20, dcf: .12 },
      maxBase: .17,
      maxRerating: .025,
      invalidMethods: ['revenueExit', 'ebitdaExit', 'dcfSBCAdjusted'],
      useNetMarginForBridge: true,
      notes: ['FCF and EV/EBITDA are de-emphasized because insurer cash flows include policyholder float and reserve movements.'],
    };
  }

  if (isAssetManager) {
    return {
      key: 'asset-manager-earnings',
      label: 'Asset manager earnings-power model',
      primary: ['epsExit', 'ownerEarnings'],
      support: ['dcf'],
      weights: { epsExit: .52, ownerEarnings: .30, dcf: .18 },
      maxBase: .18,
      maxRerating: .030,
      invalidMethods: ['revenueExit', 'ebitdaExit'],
      useNetMarginForBridge: true,
      notes: ['Emphasizes per-share earnings power and capital returns; revenue multiples are not central.'],
    };
  }

  if (isFinancial) {
    const highGrowthPlatform = (facts.analystGrowth ?? 0) >= .14 ||
      ['Growth', 'Hyper Growth'].includes(category) ||
      Number(lifecycle?.forwardGrowth ?? 0) >= .14;
    if (highGrowthPlatform) {
      return {
        key: 'digital-financial-platform',
        label: 'Digital financial platform',
        primary: ['epsExit', 'revenueExit'],
        support: ['ownerEarnings'],
        weights: { epsExit: .56, revenueExit: .28, ownerEarnings: .16 },
        maxBase: .22,
        maxRerating: .040,
        invalidMethods: ['dcf', 'dcfSBCAdjusted', 'ebitdaExit'],
        useNetMarginForBridge: true,
        notes: [
          'Routes high-growth lenders/fintech platforms away from conventional FCF DCF, which is distorted by loan origination and funding flows.',
          'Disables EV/EBITDA because debt and EBITDA are not economically comparable for deposit-funded lenders and can create a false terminal-value collapse.'
        ],
      };
    }
    return {
      key: 'bank-earnings',
      label: 'Bank earnings-power model',
      primary: ['epsExit'],
      support: ['ownerEarnings'],
      weights: { epsExit: .78, ownerEarnings: .22 },
      maxBase: .16,
      maxRerating: .020,
      invalidMethods: ['dcf', 'dcfSBCAdjusted', 'revenueExit', 'ebitdaExit'],
      useNetMarginForBridge: true,
      notes: ['Conventional FCF and enterprise-value methods are disabled for deposit-funded balance sheets.'],
    };
  }

  if (isReit) {
    return {
      key: 'reit-income-assets',
      label: 'REIT income / asset model',
      primary: ['ebitdaExit', 'ownerEarnings'],
      support: ['dcf'],
      weights: { ebitdaExit: .52, ownerEarnings: .30, dcf: .18 },
      maxBase: .15,
      maxRerating: .020,
      invalidMethods: ['epsExit', 'revenueExit', 'dcfSBCAdjusted'],
      useNetMarginForBridge: false,
      notes: ['Uses EBITDA and owner-earnings proxies as free-data substitutes for AFFO/FFO; GAAP EPS is not central.'],
    };
  }

  if (isUtility) {
    return {
      key: 'regulated-utility',
      label: 'Regulated utility cash-flow model',
      primary: ['dcf', 'ownerEarnings'],
      support: ['ebitdaExit'],
      weights: { dcf: .48, ownerEarnings: .34, ebitdaExit: .18 },
      maxBase: .13,
      maxRerating: .015,
      invalidMethods: ['revenueExit', 'dcfSBCAdjusted'],
      useNetMarginForBridge: false,
      notes: ['Prioritizes durable cash generation and dividends while limiting rerating assumptions.'],
    };
  }

  return null;
}

function specialistReliabilityAdjustment(model, method, stock) {
  if (!model) return 1;
  if (model.invalidMethods?.includes(method)) return 0;
  const facts = recentOperatingFacts(stock);
  let multiplier = 1;

  if (method === 'epsExit') {
    multiplier *= clamp(.55 + facts.positiveIncomeRate * .55, .35, 1.10);
  }
  if (method === 'ownerEarnings') {
    multiplier *= clamp(.45 + facts.positiveIncomeRate * .35 + facts.positiveFcfRate * .25, .25, 1.00);
  }
  if (method === 'dcf' || method === 'dcfSBCAdjusted') {
    multiplier *= clamp(.25 + facts.positiveFcfRate * .75, .10, 1.00);
  }
  if (method === 'revenueExit') {
    multiplier *= facts.revenueProxyRate > .4 ? .35 : 1;
  }
  return clamp(multiplier, 0, 1.15);
}

module.exports = {
  resolveInstitutionalValuationModel,
  specialistReliabilityAdjustment,
  recentOperatingFacts,
};
