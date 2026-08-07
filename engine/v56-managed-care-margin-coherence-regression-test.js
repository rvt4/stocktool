'use strict';
const assert = require('assert');
const { inferIndustryModel } = require('./industry-engine');
const { resolveSectorModel } = require('./sector-model-engine');
const { forecastMarginPaths } = require('./business-forecast-engine');

const managedCare = {
  sector: 'Healthcare',
  industry: 'Healthcare Plans / Managed Care Insurance',
  financials: { years: [
    { year: 2021, revenue: 285e9, ebitda: 22e9, fcf: 20e9, netIncome: 17e9, sharesOutTTM: 950e6, grossMargin: .24, roic: .15 },
    { year: 2022, revenue: 324e9, ebitda: 25e9, fcf: 23e9, netIncome: 20e9, sharesOutTTM: 940e6, grossMargin: .24, roic: .15 },
    { year: 2023, revenue: 372e9, ebitda: 27e9, fcf: 25e9, netIncome: 22e9, sharesOutTTM: 930e6, grossMargin: .23, roic: .14 },
    { year: 2024, revenue: 400e9, ebitda: 23e9, fcf: 20e9, netIncome: 17e9, sharesOutTTM: 920e6, grossMargin: .22, roic: .12 },
    { year: 2025, revenue: 446e9, ebitda: 18.3e9, fcf: 15.2e9, netIncome: 17.8e9, sharesOutTTM: 913e6, grossMargin: .22, roic: .11 },
  ]},
  analystEstimates: { revenueCurrentYear: 446e9, revenueNextYear: 459e9, epsCurrentYear: 19.81, epsNextYear: 22.44 },
  valuation: { pricingPowerV2: { score: 78 }, marketCap: 370e9 },
};
const inferred = inferIndustryModel(managedCare);
assert.strictEqual(inferred.model, 'healthcare-services', 'managed care was misclassified as financials');
managedCare.valuation.industryModel = inferred;
assert.strictEqual(resolveSectorModel(managedCare).key, 'healthcare', 'managed care resolved to financial sector model');

const growth = { path: [.013,.033,.04,.055,.07,.071,.066], assumptions: { state: {
  pricing: .78, roicQuality: .50, persistenceScore: .58, grossTrend: 0, marginTrend: -.003, regime: 'steady'
}}};
const margins = forecastMarginPaths(managedCare, growth, 7, { stage: 'Compounder', normalizeMargins: false });
assert(margins.paths.ebitda.at(-1) >= margins.starts.ebitda - .005, 'managed-care EBITDA cliff survived');
assert(margins.paths.fcf.at(-1) >= margins.starts.fcf - .005, 'managed-care FCF cliff survived');

const platform = {
  sector: 'Industrials', industry: 'Ground Transportation / Mobility Platform',
  financials: { years: [
    {year:2021,revenue:17e9,ebitda:-.8e9,fcf:-.7e9,netIncome:-.5e9,sharesOutTTM:2.0e9,roic:-.03},
    {year:2022,revenue:32e9,ebitda:.6e9,fcf:.4e9,netIncome:-.2e9,sharesOutTTM:2.05e9,roic:.01},
    {year:2023,revenue:37e9,ebitda:2.5e9,fcf:3.3e9,netIncome:1.9e9,sharesOutTTM:2.1e9,roic:.07},
    {year:2024,revenue:44e9,ebitda:4.7e9,fcf:6.8e9,netIncome:4.0e9,sharesOutTTM:2.15e9,roic:.12},
    {year:2025,revenue:58.2e9,ebitda:6.93e9,fcf:10.82e9,netIncome:6.58e9,sharesOutTTM:2.183e9,roic:.16},
  ]},
  analystEstimates:{revenueCurrentYear:58.2e9,revenueNextYear:67.14e9,epsCurrentYear:3.01,epsNextYear:4.52},
  valuation:{industryModel:{model:'industrials'},pricingPowerV2:{score:62},marketCap:145e9},
};
const pg={path:[.143,.133,.105,.103,.09,.083],assumptions:{state:{pricing:.62,roicQuality:.50,persistenceScore:.55,grossTrend:0,marginTrend:.02,regime:'normalizing'}}};
const pm=forecastMarginPaths(platform,pg,6,{stage:'Cyclical',normalizeMargins:false});
for(let i=0;i<6;i++) assert(pm.paths.ebitda[i] >= pm.paths.net[i]+.0179, 'EBITDA fell below net margin');
assert(pm.paths.ebitda.at(-1) >= pm.starts.ebitda-.0081, 'platform EBITDA cliff survived');
console.log('V56 managed-care and margin-coherence regression test passed');
