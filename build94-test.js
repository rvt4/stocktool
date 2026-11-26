'use strict';
// Build 94: (1) the analyst blend can't lift the model's own value more than 1.5x; bigger lifts are capped and
// marked limited support; (2) the shortlist is the one buy list (Buy more, starter portfolio, research page).
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const {ANALYST_BLEND_MAX_LIFT}=require('./engine/config');
const RP=require('./review-policy');

function stock({ticker='T94',price=100,growth=.12,margin=.22}){
  const years=[];let revenue=8e9,shares=200e6;
  for(let i=0;i<5;i++){revenue*=1+growth;years.push({year:2021+i,revenue,fcf:revenue*margin,fcfSBCAdjusted:revenue*(margin-.01),ebitda:revenue*(margin+.08),netIncome:revenue*(margin-.03),operatingIncome:revenue*(margin+.05),sharesOutTTM:shares,dilutedEPS:revenue*(margin-.03)/shares,roic:.2,opMargin:margin+.05,totalDebt:1e9,cash:1.5e9,dividendPerShare:0,sbcIntensity:.02});}
  return {ticker,sector:'Technology',financials:{years,dataQuality:{}},analystEstimates:{revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth*.9,numAnalysts:25},growthYear1:growth,price:{current:price},valuation:{dividendYield:0,growthSource:'test'}};
}
const run=s=>{const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return {v,d:rateStock(s,f,q,v)};};
const base=run(stock({}));
const withTarget=mult=>{const t=stock({});Object.assign(t.analystEstimates,{analystTargetMean:base.v.fairValueEstimate*mult,analystTargetLow:base.v.fairValueEstimate*mult*.8,analystTargetHigh:base.v.fairValueEstimate*mult*1.2});return run(t);};

// 1) Far-below model (analysts 20x higher): lift capped at 1.5x, limited support, can't be rated Buy.
{
  const r=withTarget(20), ac=r.v.analystCheck;
  assert(ac.liftCapped===true,'big lift should be capped');
  assert(ac.uncappedBlendFactor>ANALYST_BLEND_MAX_LIFT,'uncapped factor recorded');
  assert(Math.abs(ac.blendFactor-ANALYST_BLEND_MAX_LIFT)<1e-9,'factor capped at the max lift');
  assert(r.v.fairValueEstimate<=base.v.fairValueEstimate*ANALYST_BLEND_MAX_LIFT*1.0001,'fair value lifted more than the cap: '+r.v.fairValueEstimate/base.v.fairValueEstimate);
  assert.strictEqual(r.v.modelSupport,'unsupported');  // Build 95: was 'limited'
  assert(/can't value this/.test(r.v.modelSupportReason));
  assert.strictEqual(r.d.rating,'Unrated','capped name rated '+r.d.rating);
  if(Number.isFinite(r.v.bearCAGR))assert(r.v.bearCAGR<=r.v.baseCAGR+1e-9&&r.v.bullCAGR>=r.v.baseCAGR-1e-9,'scenarios out of order');
}
// 2) Small lift (analysts 1.2x): blends normally, not capped.
{
  const r=withTarget(1.2), ac=r.v.analystCheck;
  assert(ac.liftCapped===false&&ac.blendFactor>1&&ac.blendFactor<ANALYST_BLEND_MAX_LIFT,'small lift should blend normally');
}
// 3) Blending DOWN is unchanged (model far above analysts).
{
  const r=withTarget(1/6);
  assert(r.v.analystCheck.liftCapped===false&&r.v.analystCheck.blendFactor<1);
}
// 4) The buy list: capped names are excluded; the reason says why.
const good={ticker:'GOOD',rating:'Watch',overallRank:5,underwrittenCAGR:.13,qualityScore:85};
assert(RP.shortlistEntry(good),'a Watch-rated name that passes rule C is on the buy list');
const capped={...good,ticker:'CAP',analystCheck:{liftCapped:true}};
assert(!RP.shortlistEntry(capped));
assert(/far below analysts/.test(RP.buyListReason(capped)));
assert(/^On the buy list/.test(RP.buyListReason(good)));
assert(/rank 40/.test(RP.buyListReason({...good,overallRank:40})));
assert(/quality 78/.test(RP.buyListReason({...good,qualityScore:78})));
// 5) Buy more comes only from the buy list (a PEG/GARP-only name no longer says Buy more).
{
  const pegOnly={ticker:'PEGO',rating:'Hold',overallRank:300,underwrittenCAGR:.10,expectedCAGR:.12,qualityScore:85,revenueGrowthTTM:.2,revenueCAGR3:.2,
    analystEstimates:{epsNextYear:5,epsGrowthNextYear:.2,numAnalysts:20},price:50,modelRevPS0:10,modelRevPS5:20};
  assert(RP.pegEntry(pegOnly)||RP.garpEntry(pegOnly),'fixture should be on a research list');
  assert.notStrictEqual(RP.holdingAdvice(pegOnly,null,{weight:.01}).action,'Buy more','research-list-only name must not say Buy more');
  assert.strictEqual(RP.holdingAdvice({...good,expectedCAGR:.14},null,{weight:.01}).action,'Buy more');
}
// 6) Strategy version bumped under the change policy.
assert(/^C-v[2-9]$/.test(RP.STRATEGY.id));  // Build 98: C-v3; Build 99: C-v4
assert(RP.STRATEGY.previous.some(p=>p.id==='C-v1'));
console.log('build94 tests passed');
