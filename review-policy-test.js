'use strict';
const assert=require('assert');
const RP=require('./review-policy');
const st=(o)=>({ticker:'X',currentPrice:100,underwrittenCAGR:.12,qualityScore:85,rating:'Hold',requiredReturnBuyPrice:90,...o});
assert.strictEqual(RP.holdingStatus(st({})).status,'Hold');
assert.strictEqual(RP.holdingStatus(st({overallRank:5})).status,'Add candidate','top-20, above hurdle, quality 75+');
assert.strictEqual(RP.holdingStatus(st({overallRank:35})).status,'Hold','outside top 20 is just Hold');
assert.strictEqual(RP.holdingStatus(st({overallRank:5,underwrittenCAGR:.10})).status,'Hold','below hurdle is not an add');
assert.strictEqual(RP.shortlistEntry(st({overallRank:5,rating:'Unrated'})),false);
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
// Build 36 sizing
{
  const s=(o)=>({ticker:'S',currentPrice:50,underwrittenCAGR:.14,qualityScore:85,valuationConfidenceScore:80,rating:'Buy',requiredReturnBuyPrice:60,sector:'Tech',overallRank:5,analystEstimates:{numAnalysts:10},...o});
  const lo=RP.targetWeight(s({underwrittenCAGR:.11,qualityScore:75,valuationConfidenceScore:60,analystEstimates:{numAnalysts:1}}));
  const hi=RP.targetWeight(s({underwrittenCAGR:.20,qualityScore:97,valuationConfidenceScore:95}));
  assert.ok(lo>=RP.SIZING.minWeight&&hi<=RP.SIZING.maxWeightAtCost&&hi>lo,'sizing range');
  assert.strictEqual(RP.entryEligible(s({})),true);
  assert.strictEqual(RP.entryEligible(s({rating:'Watch'})),false);
  assert.strictEqual(RP.entryEligible(s({currentPrice:70})),false,'above buy price');
  assert.strictEqual(RP.holdingStatus(s({}),null,{weight:.25}).status,'Review','oversized position gets a trim review');
  const cands=Array.from({length:30},(_,i)=>s({ticker:'C'+i,sector:i<20?'Tech':'Health'}));
  const plan=RP.planContribution({holdings:[],candidates:cands,cash:10000});
  const tech=plan.lines.filter(l=>l.ticker.match(/^C1?\d$/)).reduce((a,l)=>a+l.amount,0);
  assert.ok(tech<=RP.SIZING.sectorCapAtPurchase*10000+1e-6,'sector cap on new buys');
  assert.ok(plan.lines.length<=RP.SIZING.maxPositions);
  assert.ok(Math.abs(plan.lines.reduce((a,l)=>a+l.amount,0)+plan.leftover-10000)<1e-6,'money conserved');
  const top=RP.planContribution({holdings:[{ticker:'H',value:100,stock:s({ticker:'H'})}],candidates:[],cash:10000});
  assert.ok(top.lines[0]&&top.lines[0].ticker==='H'&&!top.lines[0].isNew,'tops up an under-target holding');
  console.log('sizing tests passed');
}
assert.strictEqual(RP.holdingStatus({ticker:'Z',currentPrice:50,underwrittenCAGR:.14,qualityScore:85,rating:'Buy',requiredReturnBuyPrice:60,overallRank:5},null,{weight:.15}).status,'Hold','full-size position is not an add candidate');
