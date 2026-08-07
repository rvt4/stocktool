'use strict';
const assert = require('assert');
const { buildActionableReturn } = require('./decision-system-v30');
const { assignProbabilityRating } = require('./probability-rating-engine');
const { selectedValuation } = require('./primary-valuation-engine');

// 1) No category ceiling saturation: a 35% raw Value CAGR must be compressed,
// not clipped back to exactly 35% or silently left untouched.
const saturated = buildActionableReturn({
  category:'Value', probabilityWeightedCAGR:.35, expectedReturn:.35,
  baseCAGR:.34, fiveYearPriceTarget:{cagr:.36}, expectedReturnProfile:{riskAdjustedCAGR:.33},
  confidenceScore:90, methodAgreementScore:85,
});
assert.ok(saturated.actionable < .35, `35% saturation should be compressed, got ${saturated.actionable}`);
assert.ok(Math.abs(saturated.actionable - .35) > 1e-6, 'actionable CAGR must not pile up at 35%');

// 2) Strong Buy requires >=15% expected return AND the displayed required MOS.
const components={quality:88,confidence:90,risk:25,growth:80,valuation:85};
const p={pPermanentLoss:.05,pBeat15Cagr:.85,pPositiveReturn:.90,inputs:{er:.141,mos:.30}};
const stock={category:'Value',requiredMarginOfSafety:.20,methodAgreementScore:85,investmentCommitteeScore:90,
  scenarioAnalysis:{downsideCAGR:.05},financials:{years:Array.from({length:5},()=>({fcf:10,revenue:100}))},valuation:{}};
const lowReturn=assignProbabilityRating(stock,components,p);
assert.notStrictEqual(lowReturn.rating,'Strong Buy','14.1% expected return cannot be Strong Buy');

const p2={...p,inputs:{er:.17,mos:.15}};
const lowMos=assignProbabilityRating(stock,components,p2);
assert.ok(!['Exceptional Buy','Strong Buy','Buy'].includes(lowMos.rating), 'A stock below its required MOS cannot receive a buy rating');

// 3) Rerating sanity is economics-driven: low operating compounding cannot turn a
// huge terminal-method gap into a 30%+ central CAGR.
const vStock={ticker:'GENERIC',sector:'Industrials',industry:'Services',price:{current:100},financials:{years:[
  {revenue:100,fcf:10,netIncome:8,sharesOutTTM:10,roic:.08,sbc:0},
  {revenue:102,fcf:10.2,netIncome:8.2,sharesOutTTM:10,roic:.08,sbc:0},
]},valuation:{industryModel:{model:'general'},dividendYield:0,moat:{score:50},pricingPowerV2:{score:50},businessProfile:{premiumPersistence:.5,forecastReliability:.65},economicQuality:{overall:55},compounder:{score:55}}};
const lifecycle={stage:'Mature',forwardGrowth:.03,growthPersistenceScore:55};
const model={projection:[1,2,3,4,5].map((i)=>({year:2026+i,revenue:102*Math.pow(1.03,i),fcfMargin:.10,netMargin:.08,shares:10}))};
const methods={dcf:{fairValuePerShare:150,exitPricePerShare:430},ownerEarnings:{fairValuePerShare:145,exitPricePerShare:410},epsExit:{fairValuePerShare:155,exitPricePerShare:440}};
const val=selectedValuation({stock:vStock,category:'Value',lifecycle,methodResults:methods,model});
assert.ok(val.rawCAGR > .25, `fixture should create a rerating-heavy raw CAGR, got ${val.rawCAGR}`);
assert.ok(val.expectedCAGR < .16, `low-growth mature business should not retain a 25-35% CAGR, got ${val.expectedCAGR}`);
assert.ok(val.reratingSanityApplied, 'rerating sanity should be reported in the audit');
assert.ok(Math.abs(Math.pow(val.actionableExitValue/100,1/val.years)-1-val.expectedCAGR)<1e-10,'target and expected CAGR must stay mathematically consistent');

console.log('V60 valuation/rating regression passed', {saturated:saturated.actionable, normalized:val.expectedCAGR, raw:val.rawCAGR});
