'use strict';

const { computeBusinessEconomics } = require('./business-economics-engine');

/**
 * Backward-compatible adapter. Existing consumers still read
 * valuation.economicQuality.overall, while the richer economics object is also
 * exposed for valuation, forecasting, ranking and dashboard audits.
 */
function computeEconomicQuality(stock, pricingPower, compounder, industryModel, moat = null, lifecycle = null) {
  const economics = computeBusinessEconomics(stock, { pricingPower, compounder, industryModel, moat, lifecycle });
  return {
    version: 'economic-quality-v2-business-economics',
    overall: economics.overall,
    durability: economics.durability,
    balanceSheet: economics.components.capitalAllocation.debtDiscipline,
    cashEconomics: Math.round((economics.capitalLight + economics.components.durability.recessionResistance) / 2),
    pricingPower: economics.pricingPower,
    reinvestment: economics.reinvestmentRunway,
    moat: economics.moat,
    capitalAllocation: economics.capitalAllocation,
    industryStructure: economics.industryStructure,
    forecastReliability: economics.forecastReliability,
    requiredMarginOfSafety: economics.requiredMarginOfSafety,
    businessEconomics: economics,
    evidenceYears: (stock.financials?.years || []).slice(-8).length,
    industry: industryModel?.model || industryModel?.key || 'general',
  };
}

module.exports = { computeEconomicQuality };
