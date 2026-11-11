'use strict';
// Build 71: stable method blend, unvaluable balance-sheet businesses, tighter cyclical label, estimate revisions.
const assert=require('assert');
const V=require('./engine/valuation-engine');
const D=require('./data-fetchers');
const R=require('./engine/ranking-engine');

// 1) Smooth weighted median: equal weights -> midpoint between the two middle values; moves continuously.
assert.strictEqual(V.smoothWeightedMedian([{value:1,weight:1},{value:3,weight:1}]),2);
let prev=null;
for(let w=.8;w<=1.2001;w+=.01){
  const m=V.smoothWeightedMedian([{value:0,weight:1},{value:1,weight:1},{value:5,weight:1},{value:6,weight:w}]);
  if(prev!=null)assert(Math.abs(m-prev)<.1,`median jumped ${prev} -> ${m}`);prev=m;
}
// consensus weight is continuous and matches the old steps at their anchor points
assert.strictEqual(V.consensusWeightForGap(0),1);assert(Math.abs(V.consensusWeightForGap(Math.log(1.30))-.78)<1e-12);
assert.strictEqual(V.consensusWeightForGap(5),.2);
for(let g=0;g<1;g+=.005)assert(Math.abs(V.consensusWeightForGap(g+.005)-V.consensusWeightForGap(g))<.03);

// 2) GM case: two camps (~$200 FCF/EPS vs ~$410 EV/EBITDA/DCF). Last night the low pair was tighter, tonight the
//    high pair: the blend used to flip camps ($98 -> $133 final fair value). Now both nights agree within 3%.
const gm=(f,e,x,d,wd=.3)=>[{name:'FCF exit',outcome:f,baseWeight:.3,weight:.3,reliability:.9},{name:'EPS exit',outcome:e,baseWeight:.3,weight:.3,reliability:.9},
  {name:'EV/EBITDA exit',outcome:x,baseWeight:.3,weight:.3,reliability:.9},{name:'10Y DCF',outcome:d,baseWeight:wd,weight:wd,reliability:.9}];
//    Real inputs did change (DCF 452 -> 422, FCF 206 -> 192), so the answer may move, but gradually: the old blend
//    moved 68% on these inputs, now under 15%; and a 1% step in any one method never moves the blend more than 3%.
const a=V.robustOutcomeBlend(gm(206.5,201.4,403,452),88).outcome,b=V.robustOutcomeBlend(gm(192,205.3,397.7,422.3),88).outcome;
assert(Math.abs(a/b-1)<.15,`GM blend unstable: ${a} vs ${b}`);
for(const which of [0,1,2,3]){let p=null;
  for(let k=0;k<=30;k++){const v=[200,205,398,422];v[which]*=Math.pow(1.01,k-15);const o=V.robustOutcomeBlend(gm(...v),88).outcome;
    if(p)assert(Math.abs(o/p-1)<.03,`method ${which} step ${k}: ${p} -> ${o}`);p=o;}}
let last=null;
for(let wd=.20;wd<=.40001;wd+=.01){const o=V.robustOutcomeBlend(gm(200,205,398,422,wd),88).outcome;if(last)assert(Math.abs(o/last-1)<.03,`blend jumped at DCF weight ${wd}: ${last} -> ${o}`);last=o;}
// A genuine single outlier is still down-weighted (three methods agree, one is far away).
const single=V.robustOutcomeBlend([{name:'A',outcome:100,baseWeight:.3,weight:.3,reliability:.9},{name:'B',outcome:104,baseWeight:.3,weight:.3,reliability:.9},
  {name:'C',outcome:98,baseWeight:.3,weight:.3,reliability:.9},{name:'D',outcome:400,baseWeight:.3,weight:.3,reliability:.9}],80);
assert(single.weights.D<.10&&single.outcome<115,'single outlier should stay down-weighted '+JSON.stringify(single));

// 3) Unvaluable balance sheets, from filings, point-in-time.
const I=(end,val,filed)=>({end,val,filed:filed||end});
const f=(tags)=>({facts:{'us-gaap':Object.fromEntries(Object.entries(tags).map(([k,v])=>[k,{units:{USD:v}}]))}});
const crypto=f({Assets:[I('2024-12-31',100,'2025-02-15'),I('2025-09-30',1000,'2025-11-10')],CryptoAssetFairValueNoncurrent:[I('2025-09-30',800,'2025-11-10')]});
assert.strictEqual(D.detectValuationExclusion(crypto,'6199').kind,'crypto_treasury');
assert.strictEqual(D.detectValuationExclusion(crypto,'6199','2025-06-30'),null,'before the crypto pivot was filed, it is not a crypto treasury');
const mreit=f({Assets:[I('2025-09-30',1000)],RealEstateInvestmentPropertyNet:[I('2025-09-30',20)]});
assert.strictEqual(D.detectValuationExclusion(mreit,'6798').kind,'mortgage_reit');
const equityReit=f({Assets:[I('2025-09-30',1000)],RealEstateInvestmentPropertyNet:[I('2025-09-30',780)]});
assert.strictEqual(D.detectValuationExclusion(equityReit,'6798'),null);
assert.strictEqual(D.detectValuationExclusion(mreit,'3711'),null,'only REITs can be mortgage REITs');

// 4) Live rank excludes stocks the model could not value; the frozen legacy rank is unchanged.
function row(t,extra={}){return {ticker:t,expectedAlpha:.03,underwrittenCAGR:.14,bearCAGR:.08,qualityScore:80,moatScore:70,growthQualityScore:60,compounderScore:65,
  marketCap:5e10,analystEstimates:{numAnalysts:20},revenueGrowthTTM:.08,revenueCAGR3:.08,...extra};}
const mk=()=>[row('OK'),row('UNSUP',{modelSupport:'unsupported'}),row('CRYPTO',{valuationExclusion:{kind:'crypto_treasury'}}),...Array.from({length:10},(_,i)=>row('F'+i))];
const live=mk();R.applyModelDRanking(live,{rankField:'r',universeSizeField:null,reliability:true});
const L=Object.fromEntries(live.map(x=>[x.ticker,x]));
assert(L.OK.r&&!L.UNSUP.rankEligible&&!L.CRYPTO.rankEligible,'unsupported / excluded stocks must not be ranked live');
const legacy=mk();R.applyModelDRanking(legacy,{rankField:'r',universeSizeField:null});
assert(legacy.find(x=>x.ticker==='UNSUP').rankEligible,'legacy rank unchanged');

// 5) Estimate revisions (label only).
assert.strictEqual(R.estimateRevision({epsCurrentYear:2.0,epsCurrentYear90dAgo:3.15}).level,'severe');
const cut=R.estimateRevision({epsCurrentYear:4.5,epsCurrentYear90dAgo:5,epsNextYear:5.5,epsNextYear90dAgo:5.4});
assert(cut.level==='cut'&&/this year/.test(cut.label)&&/10%/.test(cut.label),JSON.stringify(cut));
assert.strictEqual(R.estimateRevision({epsCurrentYear:5,epsCurrentYear90dAgo:4.8}).level,null);
assert.strictEqual(R.estimateRevision({epsCurrentYear:-.5,epsCurrentYear90dAgo:-.2}).level,'severe','deeper loss counts as a full cut');
assert.strictEqual(R.estimateRevision({epsCurrentYear:5}),null);assert.strictEqual(R.estimateRevision(null),null);

// 6) Cyclical label: one collapsed year (a write-down) is not a cycle; two are.
const yrs=(m)=>m.map((x,i)=>({year:2018+i,revenue:10+i,netIncome:(10+i)*x}));
assert(!R.cycleProfile(yrs([.15,.16,.15,.02,.16,.17,.16,.18])).cyclical,'one-off write-down year');
assert(R.cycleProfile(yrs([.15,.05,.15,.04,.16,.17,.16,.18])).cyclical,'two slump years');
console.log('build71-test OK');
