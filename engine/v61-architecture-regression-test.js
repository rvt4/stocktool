'use strict';
const assert = require('assert');
const { selectValuationMethods } = require('./method-selection-engine');
const { buildValuationConsensus } = require('./valuation-consensus');
const { classifyLifecycle } = require('./lifecycle-engine');

const insurer = {
  sector: 'Healthcare', industry: 'Managed Care',
  analystEstimates: { revenueGrowthCurrentYear: .03, revenueGrowthNextYear: .04 },
  valuation: { industryModel: { model: 'healthcare-services' }, businessProfile: { forecastReliability: .75 } },
  financials: { years: [
    { revenue: 100, netIncome: 5, fcf: 4, ebitda: 8, da: 1, capex: 1 },
    { revenue: 104, netIncome: 5.2, fcf: 4.2, ebitda: 8.3, da: 1, capex: 1 },
    { revenue: 108, netIncome: 5.4, fcf: 4.4, ebitda: 8.6, da: 1, capex: 1 },
  ]},
};
const methods = { dcf: 65, dcfSBCAdjusted: 55, ownerEarnings: 220, revenueExit: 1400, epsExit: 285, ebitdaExit: 260 };
const sel = selectValuationMethods(insurer, 'Value', methods);
assert.strictEqual(sel.effectiveStartingWeights.revenueExit, 0, 'managed-care revenue multiple must be hard excluded');
const weights = { dcf: .2, ownerEarnings: .3, revenueExit: 0, epsExit: .3, ebitdaExit: .2 };
const c = buildValuationConsensus(methods, 50, weights);
assert.ok(!c.eligibleMethods.includes('revenueExit'), 'zero-weight method must not re-enter consensus');
assert.ok(c.actionableFairValue < 500, 'audit-only heroic revenue multiple must not inflate fair value');

const inflector = {
  sector: 'Industrials', industry: 'Mobility Platform',
  analystEstimates: { revenueGrowthCurrentYear: .14, revenueGrowthNextYear: .13, numAnalysts: 35 },
  valuation: { industryModel: { model: 'industrials' }, marketCap: 150e9, pricingPowerV2: { score: 62 }, moat: { score: 58 } },
  financials: { years: [
    { revenue: 50, netIncome: -3, fcf: -1, operatingIncome: -2, grossMargin: .35, roic: -.05 },
    { revenue: 58, netIncome: -1, fcf: 1, operatingIncome: 0, grossMargin: .36, roic: .01 },
    { revenue: 66, netIncome: 1.0, fcf: 3, operatingIncome: 2, grossMargin: .37, roic: .05 },
    { revenue: 76, netIncome: 4.5, fcf: 7, operatingIncome: 6, grossMargin: .38, roic: .10 },
    { revenue: 87, netIncome: 8.0, fcf: 11, operatingIncome: 10, grossMargin: .39, roic: .14 },
  ]},
};
const life = classifyLifecycle(inflector);
assert.ok(life.profitabilityInflection, 'loss-to-profit transition should be detected');
assert.ok(['Growth','Compounder'].includes(life.stage), `profitability inflector should not be mislabeled cyclical; got ${life.stage}`);
console.log('V61 architecture regression passed', { insurerRevenueWeight: sel.effectiveStartingWeights.revenueExit, insurerFairValue: c.actionableFairValue, inflectorStage: life.stage });
