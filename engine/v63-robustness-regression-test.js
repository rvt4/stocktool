'use strict';
const assert = require('assert');
const { computePortfolioProfile } = require('./portfolio-engine');
const { buildReturnAttribution } = require('./return-attribution-engine');

const base = { decisionExpectedReturn:.17, fairValueEstimate:120, businessQualityScore:90, confidenceScore:85, downsideProtectionScore:80, permanentLossProbability:.10, valuation:{} };
assert(computePortfolioProfile({...base,rating:'Strong Buy'}).suggestedMaxWeight > 0, 'buy rating should be sizeable');
for (const rating of ['Hold','Avoid','Sell']) assert.strictEqual(computePortfolioProfile({...base,rating}).suggestedMaxWeight, 0, `${rating} must have zero suggested weight`);

const stock={price:{current:100},valuation:{projection:[{growth:.15},{growth:.12},{growth:.10},{growth:.08},{growth:.06}],projectionAssumptions:{progressiveGrowthBurden:.02}}};
const primary={expectedCAGR:.12,cagrAudit:{projectionYears:5,currentPrice:100,actionableExitValue:170,modeledDividends:6,totalEndingValue:176},operatingBridge:{revenueContribution:.10,marginContribution:.02,shareContribution:.01}};
const attr=buildReturnAttribution(stock,primary,{});
const sum=Object.values(attr.components).reduce((a,b)=>a+b,0);
assert(Math.abs(sum-attr.expectedCAGR)<1e-12,'displayed attribution must sum exactly to expected CAGR');
console.log('V63 robustness regression passed', {weight:computePortfolioProfile({...base,rating:'Strong Buy'}).suggestedWeightRange, attributionSum:sum});
