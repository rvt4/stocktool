'use strict';
// Build 76: decisions from the Build 75 backtest + base/cautious returns shown together + return calibration.
const assert=require('assert');
const RP=require('./review-policy');
const CFG=require('./engine/config');
const L=require('./owner-strategy-lab');

// Margin-climb rule failed its scorecard test -> off by default (still detectable / testable).
assert.strictEqual(CFG.MARGIN_TREND.enabled,false);
// Both-checks-agree + sell-half-first won the sell-rule test -> live.
assert.strictEqual(RP.SELL.rule,'bothStaged');
const s={ticker:'X',rating:'Hold',qualityScore:85,expectedCAGR:.10,underwrittenCAGR:.04,price:300,revenueGrowthTTM:.12,revenueCAGR3:.12,
  modelRevPS0:10,modelRevPS5:10*Math.pow(1.10,5),analystEstimates:{epsNextYear:10}};       // PEG 3.0 -> both checks say expensive
assert.strictEqual(RP.holdingStatus(s,null,{weight:.05}).status,'Trim half','first expensive reading sells half');
assert.strictEqual(RP.holdingStatus(s,{u:.04,peg:3},{weight:.05}).status,'Sell candidate','second reading sells the rest');
const cheap={...s,price:100};                                                             // PEG 1.0 -> checks disagree -> hold
assert.strictEqual(RP.holdingStatus(cheap,{u:.04,peg:1},{weight:.05}).status,'Hold');
assert.strictEqual(RP.holdingAdvice(cheap,{u:.04,peg:1},{weight:.12}).action,'Hold');
// Advice shows both the base case and the cautious number.
const a=RP.holdingAdvice(s,null,{weight:.05});
assert(a.reasons.some(r=>/base case 10\.0%, cautious 4\.0%/.test(r)),a.reasons.join(' | '));
assert.strictEqual(a.action,'Sell some');

// Return calibration table.
const rows=[{expectedCAGR:.05,underwrittenCAGR:.03,realized3YTotalReturnCAGR:.12,excess3YTotalReturnCAGR:.01},
            {expectedCAGR:.06,underwrittenCAGR:.05,realized3YTotalReturnCAGR:.10,excess3YTotalReturnCAGR:-.01},
            {expectedCAGR:.15,underwrittenCAGR:.12,realized3YTotalReturnCAGR:.20,excess3YTotalReturnCAGR:.09}];
const c=L.returnCalibration([{asOf:'2019-03-31',rows}]);
const b=c.base['3Y'].find(x=>x.bucket==='4-7%');
assert.strictEqual(b.n,2);assert(Math.abs(b.medianRealized-.11)<1e-9&&Math.abs(b.realizedMinusPredicted-.055)<1e-9&&Math.abs(b.medianSpy-.11)<1e-9);
assert.strictEqual(c.cautious['3Y'].find(x=>x.bucket==='0-4%').n,1);
assert.strictEqual(c.base['3Y overall'].n,3);
console.log('build76 tests passed');
