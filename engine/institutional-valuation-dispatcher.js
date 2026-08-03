'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));

function normalizeGrowth(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return null;
  return Math.abs(v) > 2 ? v / 100 : v;
}

function textFor(stock) {
  return [stock?.sector, stock?.industry, stock?.name, stock?.valuation?.industryModel?.model,
    stock?.valuation?.industryModel?.key, stock?.valuation?.businessArchetype,
    stock?.valuation?.lifecycle?.archetype].filter(Boolean).join(' ').toLowerCase();
}

function recentOperatingFacts(stock) {
  const recent = (stock?.financials?.years || []).slice(-5);
  const positiveIncomeRate = recent.length ? recent.filter(y => Number(y.netIncome) > 0).length / recent.length : 0;
  const positiveFcfRate = recent.length ? recent.filter(y => Number(y.fcf) > 0 && !y.fcfIsProxy).length / recent.length : 0;
  const revenueProxyRate = recent.length ? recent.filter(y => y.revenueIsProxy).length / recent.length : 0;
  const analystGrowth = normalizeGrowth(stock?.analystEstimates?.revenueGrowthNextYear ??
    stock?.analystEstimates?.revenueGrowthCurrentYear ?? stock?.analystEstimates?.revenueGrowthFwd);
  return { years: recent.length, last: recent.at(-1) || {}, positiveIncomeRate, positiveFcfRate, revenueProxyRate, analystGrowth };
}

function resolveInstitutionalValuationModel(stock, category, lifecycle = {}) {
  const text = textFor(stock);
  const facts = recentOperatingFacts(stock);
  const industryModel = String(stock?.valuation?.industryModel?.model || '').toLowerCase();
  const lifecycleStage = String(lifecycle?.stage || '').toLowerCase();
  const lifecycleArchetype = String(lifecycle?.archetype || lifecycle?.economicModel?.archetype || '').toLowerCase();
  const isFinancial = industryModel === 'financials' || lifecycleStage === 'financial' ||
    /bank|financial|credit|lending|fintech|broker|capital market|asset manage|insurance/.test(text);
  const isInsurance = /insurance|reinsurance|property casualty|life insurer|insurance broker/.test(text);
  const isAssetManager = /asset management|investment management|wealth management|capital markets|brokerage|exchange/.test(text);
  const isReit = industryModel === 'reit' || /reit|real estate investment trust/.test(text);
  const isUtility = industryModel === 'utilities' || /utility|utilities|regulated electric|regulated gas/.test(text);

  if (isInsurance) return { key:'insurance-earnings-book', label:'Insurance earnings / book-value proxy', primary:['epsExit'], support:['ownerEarnings'], weights:{epsExit:.72,ownerEarnings:.28}, maxBase:.17,maxRerating:.025,invalidMethods:['revenueExit','ebitdaExit','dcf','dcfSBCAdjusted'],useNetMarginForBridge:true,notes:['Enterprise-value and conventional FCF methods are disabled for insurers.'] };
  if (isAssetManager) return { key:'asset-manager-earnings', label:'Asset manager earnings-power model', primary:['epsExit','ownerEarnings'], support:[], weights:{epsExit:.62,ownerEarnings:.38}, maxBase:.18,maxRerating:.03,invalidMethods:['revenueExit','ebitdaExit','dcf','dcfSBCAdjusted'],useNetMarginForBridge:true,notes:['Per-share earnings power and capital returns drive the valuation.'] };

  if (isFinancial) {
    const forward = Math.max(facts.analystGrowth ?? 0, normalizeGrowth(lifecycle?.forwardGrowth) ?? 0);
    const digital = lifecycleArchetype.includes('digital financial') || /fintech|digital bank|online bank|lending platform|financial technology/.test(text) ||
      forward >= .12 || ['growth','hyper growth'].includes(String(category || '').toLowerCase());
    if (digital) return {
      key:'digital-financial-platform', label:'Digital financial platform',
      primary:['epsExit','revenueExit'], support:['ownerEarnings'],
      weights:{epsExit:.60,revenueExit:.25,ownerEarnings:.15}, maxBase:.23,maxRerating:.045,
      invalidMethods:['dcf','dcfSBCAdjusted','ebitdaExit'], useNetMarginForBridge:true,
      notes:['EV/EBITDA and conventional FCF DCF are disabled for funded financial platforms.','Revenue and EPS are blended with owner earnings using financial-specific reliability rules.']
    };
    return { key:'bank-earnings',label:'Bank earnings-power model',primary:['epsExit'],support:['ownerEarnings'],weights:{epsExit:.80,ownerEarnings:.20},maxBase:.16,maxRerating:.02,invalidMethods:['dcf','dcfSBCAdjusted','revenueExit','ebitdaExit'],useNetMarginForBridge:true,notes:['Conventional FCF and enterprise-value methods are disabled for deposit-funded balance sheets.'] };
  }
  if (isReit) return { key:'reit-income',label:'REIT income model',primary:['ebitdaExit','ownerEarnings'],support:[],weights:{ebitdaExit:.65,ownerEarnings:.35},maxBase:.16,maxRerating:.025,invalidMethods:['revenueExit','epsExit','dcfSBCAdjusted'],useNetMarginForBridge:false,notes:['Uses asset-income methods rather than ordinary corporate earnings.'] };
  if (isUtility) return { key:'regulated-utility',label:'Regulated utility cash-flow model',primary:['dcf','ownerEarnings'],support:['ebitdaExit'],weights:{dcf:.48,ownerEarnings:.32,ebitdaExit:.20},maxBase:.14,maxRerating:.02,invalidMethods:['revenueExit','dcfSBCAdjusted'],useNetMarginForBridge:false,notes:['Prioritizes durable regulated cash flow and dividends.'] };
  return null;
}

function specialistReliabilityAdjustment(model, method, stock) {
  if (!model) return 1;
  if (model.invalidMethods?.includes(method)) return 0;
  const facts = recentOperatingFacts(stock);
  let m = 1;
  const digitalFinancial = model.key === 'digital-financial-platform';
  if (method === 'epsExit') m *= digitalFinancial
    ? clamp(.72 + facts.positiveIncomeRate * .30 + Math.max(0, facts.analystGrowth || 0) * .35, .65, 1.12)
    : clamp(.62 + facts.positiveIncomeRate * .48, .45, 1.10);
  if (method === 'ownerEarnings') m *= digitalFinancial
    ? clamp(.62 + facts.positiveIncomeRate * .30, .55, .95)
    : clamp(.50 + facts.positiveIncomeRate * .30 + facts.positiveFcfRate * .20, .35, 1.00);
  if (method === 'dcf' || method === 'dcfSBCAdjusted') m *= clamp(.25 + facts.positiveFcfRate * .75, .10, 1.00);
  if (method === 'revenueExit') m *= facts.revenueProxyRate > .4 ? .35 : (digitalFinancial ? 1.08 : 1);
  return clamp(m,0,1.15);
}
module.exports={resolveInstitutionalValuationModel,specialistReliabilityAdjustment,recentOperatingFacts};
