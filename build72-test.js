'use strict';
// Build 72: entry-rule variants (backtest arms) and the app's Buy candidates list.
const assert=require('assert');
const RP=require('./review-policy');
const s=(o)=>({ticker:'X',rating:'Watch',overallRank:10,underwrittenCAGR:.12,qualityScore:80,...o});
// Live defaults are arm C.
assert.deepStrictEqual(RP.ENTRY,{maxRank:20,minQuality:75,blockSplit:false,blockCycleAtPeak:false});
assert(RP.shortlistEntry(s()));
assert(!RP.shortlistEntry(s({overallRank:25})));assert(RP.shortlistEntry(s({overallRank:25}),{maxRank:35}));
assert(!RP.shortlistEntry(s({qualityScore:78}),{minQuality:80}));
assert(!RP.shortlistEntry(s({underwrittenCAGR:.10})));assert(!RP.shortlistEntry(s({rating:'Unrated'})));
// Warnings: split valuation (field or reason text) and cyclical at a peak; blocks only when switched on.
const split=s({methodsSplit:true}),split2=s({modelSupportReason:'Valuation methods split into two camps about 2.0x apart'}),peak=s({cycle:{cyclical:true,atPeak:true}});
assert.deepStrictEqual(RP.entryWarnings(split),['split']);assert.deepStrictEqual(RP.entryWarnings(split2),['split']);
assert.deepStrictEqual(RP.entryWarnings(peak),['cycle_peak']);assert.deepStrictEqual(RP.entryWarnings(s({cycle:{cyclical:true,atPeak:false}})),[]);
assert(RP.shortlistEntry(split)&&RP.shortlistEntry(peak),'warnings do not block by default');
assert(!RP.shortlistEntry(split,{blockSplit:true})&&!RP.shortlistEntry(peak,{blockCycleAtPeak:true}));
// Backtest uses liveRank.
assert(RP.shortlistEntry({...s(),overallRank:null,liveRank:5},{rankField:'liveRank'}));
// GARP list (arm CG): quality 75+, growth 10%+, any rank; buy zone 9%+, app list 7%+.
const g=(o)=>s({overallRank:400,underwrittenCAGR:.095,qualityScore:80,revenueGrowthTTM:.14,revenueCAGR3:.12,...o});
assert(RP.garpEntry(g()),'rank does not matter');
assert(!RP.garpEntry(g({underwrittenCAGR:.08})),'8% is below the buy zone');
assert(RP.garpEntry(g({underwrittenCAGR:.08}),{minReturn:RP.GARP.listMinReturn}),'but it is on the 7%+ list');
assert(!RP.garpEntry(g({revenueGrowthTTM:.08,revenueCAGR3:.09})),'growth under 10% fails');
assert(!RP.garpEntry(g({qualityScore:74})));
assert(!RP.garpEntry(g({revenueGrowthTTM:null,revenueCAGR3:null})),'no growth data fails');
assert(!RP.garpEntry(g({rating:'Unrated'})));
assert(!RP.shortlistEntry(g()),'a rank-400 GARP name is not a C candidate');
console.log('build72-test OK');
