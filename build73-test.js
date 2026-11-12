'use strict';
// Build 73: per-holding advice (Buy more / Hold / Sell some / Sell / Review) shown on the dashboard.
const assert=require('assert');
const RP=require('./review-policy');
const base={ticker:'X',rating:'Watch',overallRank:10,underwrittenCAGR:.12,qualityScore:85,revenueGrowthTTM:.15,revenueCAGR3:.15};
const s=o=>({...base,...o});
const A=(st,prev,w)=>RP.holdingAdvice(st,prev||null,{weight:w===undefined?0.05:w});
// Missing / unvaluable -> Review
assert.strictEqual(A(null).action,'Review');
assert.strictEqual(A(s({rating:'Unrated'})).action,'Review');
assert.strictEqual(A(s({modelSupport:'unsupported'})).tone,'review');
// Quality and price both bad -> Sell
assert.strictEqual(A(s({qualityScore:60,underwrittenCAGR:.03})).action,'Sell');
// Expensive two reviews running: Sell unless quality 80+, then Sell some
assert.strictEqual(A(s({qualityScore:76,underwrittenCAGR:.04}),{u:.05}).action,'Sell');
const core=A(s({qualityScore:88,underwrittenCAGR:.04}),{u:.05});
assert.strictEqual(core.action,'Sell some');assert(/core/.test(core.headline));
// Oversized -> Sell some toward 15%
const big=A(s(),null,.24);assert.strictEqual(big.action,'Sell some');assert(/15%/.test(big.headline));
// Quality slipped alone -> Sell some, not Sell
assert.strictEqual(A(s({qualityScore:65,underwrittenCAGR:.10})).action,'Sell some');
// Expensive and overweight vs target -> Sell some; expensive and at/under target -> Hold, don't add
const tgt=RP.targetWeight(s({underwrittenCAGR:.05}));
assert.strictEqual(A(s({underwrittenCAGR:.05}),null,(tgt||0)+.03).action,'Sell some');
const h=A(s({underwrittenCAGR:.05}),null,.005);assert.strictEqual(h.action,'Hold');assert(/don’t add/.test(h.headline));
// Buyable and underweight -> Buy more; severe estimate cut -> Hold
const b=A(s(),null,.01);assert.strictEqual(b.action,'Buy more');assert.strictEqual(b.tone,'buy');
assert.strictEqual(A(s({estimateRevision:{level:'severe',label:'Analysts cut estimates 20%'}}),null,.01).action,'Hold');
// GARP-only names (rank outside top 20) can also be Buy more
assert.strictEqual(A(s({overallRank:300,underwrittenCAGR:.095}),null,.005).action,'Buy more');
// Reasons: plain, capped, no duplicates, no tax boilerplate
for(const r of [b,big,core,h]){assert(r.reasons.length<=7);assert.strictEqual(new Set(r.reasons).size,r.reasons.length);assert(!r.reasons.some(x=>/Taxable/.test(x)));}
assert(b.reasons.some(x=>/12\.0% a year/.test(x)));
// Sort order puts actions first
const order=['Hold','Sell','Buy more','Review','Sell some'].sort((a,c)=>RP.ADVICE_ORDER[a]-RP.ADVICE_ORDER[c]);
assert.deepStrictEqual(order,['Sell','Sell some','Buy more','Review','Hold']);
console.log('build73 tests passed');
