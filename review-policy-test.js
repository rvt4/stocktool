'use strict';
const assert=require('assert');
const RP=require('./review-policy');
const st=(o)=>({ticker:'X',currentPrice:100,underwrittenCAGR:.12,qualityScore:85,rating:'Hold',requiredReturnBuyPrice:90,...o});
assert.strictEqual(RP.holdingStatus(st({})).status,'Hold');
assert.strictEqual(RP.holdingStatus(st({rating:'Buy',requiredReturnBuyPrice:110})).status,'Add candidate');
assert.strictEqual(RP.holdingStatus(st({rating:'Buy'})).status,'Hold','Buy above buy price is just Hold');
assert.strictEqual(RP.holdingStatus(st({qualityScore:65})).status,'Sell candidate');
assert.strictEqual(RP.holdingStatus(st({qualityScore:72})).status,'Review');
// low return: first time Review, second consecutive time Sell candidate
assert.strictEqual(RP.holdingStatus(st({underwrittenCAGR:.05})).status,'Review');
assert.strictEqual(RP.holdingStatus(st({underwrittenCAGR:.05}),{u:.06}).status,'Sell candidate');
assert.strictEqual(RP.holdingStatus(st({underwrittenCAGR:.05}),{u:.09}).status,'Review');
assert.strictEqual(RP.holdingStatus(st({qualityScore:78}),{q:90}).status,'Review','quality drop');
assert.strictEqual(RP.holdingStatus(null).status,'Review');
assert.strictEqual(RP.holdingStatus(st({rating:'Unrated',underwrittenCAGR:null,expectedReturn:null,expectedCAGR:null})).status,'Review');
// snapshot + performance
const stocks=[st({ticker:'A',currentPrice:10}),st({ticker:'B',currentPrice:20}),st({ticker:'C',currentPrice:30})];
const snap=RP.buildSnapshot({stocks,holdings:[{ticker:'a',shares:5}],shortlist:[stocks[0],stocks[1]],takenAt:new Date(Date.now()-30*864e5).toISOString()});
assert.strictEqual(snap.holdings[0].ticker,'A');assert.strictEqual(snap.shortlist.length,2);assert.strictEqual(Object.keys(snap.prices).length,3);
const later=[st({ticker:'A',currentPrice:11}),st({ticker:'B',currentPrice:22}),st({ticker:'C',currentPrice:30})];
const pf=RP.shortlistPerformance(snap,later);
assert.ok(Math.abs(pf.shortlistReturn-.10)<1e-9);assert.ok(Math.abs(pf.universeReturn-(.2/3))<1e-9);assert.strictEqual(pf.days,30);
assert.ok(/^\d{4}-\d\d-\d\d$/.test(RP.nextReviewDate(snap)));
console.log('review-policy tests passed');
