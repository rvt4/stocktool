'use strict';
const assert = require('assert');
const { forecastMarginPaths } = require('./business-forecast-engine');

function stock({ industry='general', sector='Technology', years, estimates={}, pricing=65 }) {
  return {
    sector, industry: sector,
    financials: { years },
    analystEstimates: estimates,
    valuation: { industryModel:{model:industry}, pricingPowerV2:{score:pricing}, marketCap:80e9 },
  };
}
const baseYears = [
  {year:2021,revenue:20e9,ebitda:0.4e9,fcf:0.3e9,netIncome:0.2e9,sharesOutTTM:2e9,opMargin:.02,roic:.08},
  {year:2022,revenue:25e9,ebitda:0.8e9,fcf:0.6e9,netIncome:0.4e9,sharesOutTTM:2.03e9,opMargin:.032,roic:.10},
  {year:2023,revenue:32e9,ebitda:1.8e9,fcf:1.5e9,netIncome:1.0e9,sharesOutTTM:2.06e9,opMargin:.056,roic:.12},
  {year:2024,revenue:40e9,ebitda:3.6e9,fcf:3.2e9,netIncome:2.4e9,sharesOutTTM:2.09e9,opMargin:.09,roic:.15},
  {year:2025,revenue:50e9,ebitda:5.5e9,fcf:5.0e9,netIncome:4.0e9,sharesOutTTM:2.12e9,opMargin:.11,roic:.18},
];
const s=stock({years:baseYears, estimates:{revenueCurrentYear:58e9,revenueNextYear:66e9,epsCurrentYear:3.0,epsNextYear:3.5,numAnalysts:30}});
const growth={path:[.16,.14,.12,.10,.09,.08],assumptions:{state:{pricing:.65,roicQuality:.60,persistenceScore:.65,grossTrend:0,marginTrend:.01,regime:'steady'}}};
const m=forecastMarginPaths(s,growth,6,{stage:'Cyclical',normalizeMargins:false});
assert(m.targets.ebitda >= m.starts.ebitda-.018-1e-9, 'EBITDA target cliff');
assert(m.targets.fcf >= m.starts.fcf-.015-1e-9, 'FCF target cliff');
assert(m.targets.net >= m.starts.net-.015-1e-9, 'net-margin target cliff');
assert(m.paths.net.at(-1) >= m.starts.net-.015-1e-9, 'EPS/net-margin cliff survived');
console.log('V55 profitability continuity regression test passed');
