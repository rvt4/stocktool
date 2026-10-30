'use strict';
const assert=require('assert');
const {thesisEntryEligible,livePortfolioGuidance}=require('./engine/portfolio-policy');
const base={rating:'Buy',modelSupport:'standard',expectedCAGR:.22,expectedAlpha:.07,underwrittenCAGR:.18,currentPrice:90,requiredReturnBuyPrice:100,rank:900,marginOfSafety:.30};
assert(thesisEntryEligible(base),'rank 900 must not prevent an otherwise qualified buy');
assert.strictEqual(livePortfolioGuidance(base,{}).newPositionAction,'BUY');
for(const change of [{rating:'Watch'},{rating:'Unrated'},{modelSupport:'unsupported'},{underwrittenCAGR:.14},{currentPrice:110},{expectedCAGR:.14}]){
 const r={...base,...change};assert(!thesisEntryEligible(r),JSON.stringify(change));assert.notStrictEqual(livePortfolioGuidance(r,{}).newPositionAction,'BUY');
}
assert(thesisEntryEligible({...base,rank:1}));
console.log('Phase 1 unified-decision regression tests passed');
