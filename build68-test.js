'use strict';
// Build 68: lasting-growth list (no cyclical spikes / glitches) + value-trap check in the live rank.
const assert=require('assert');
const GE=require('./engine/growth-engine');
const R=require('./engine/ranking-engine');

function prices(ret){const h=[];const n=400;for(let i=0;i<n;i++){const d=new Date(Date.UTC(2024,0,1)+i*86400000);h.push({date:d.toISOString().slice(0,10),close:100*Math.pow(1+ret,i/365)});}return h;}
function co(revs,{op=.15,quarterly=null,ticker='T'}={}){
  return {ticker,sector:'Technology',financials:{years:revs.map((r,i)=>({year:2020+i,revenue:r,operatingIncome:r*(Array.isArray(op)?op[i]:op),fcf:r*.15,sbc:r*.03}))},quarterly};
}
const px=prices(.40);

// 1) A steady 25% grower qualifies; the reason list mentions lasting growth.
const steady=GE.growthSignals(co([1e9,1.25e9,1.5625e9,1.953e9,2.441e9]),px,null);
assert(steady.eligible,'steady grower should qualify: '+steady.why);
assert(Math.abs(steady.durableGrowth-.25)<.01);
assert(steady.reasonsUp.some(x=>/Lasting growth/.test(x)));

// 2-3) Build 68b: by default (switches off, the Build 65 list) cyclicals and spikes stay eligible but carry a
// warning label; with the switches on they are excluded with a reason.
const cycCo=co([1e9,2e9,1.5e9,2.5e9,3.5e9]), spikeCo=co([2e9,2.02e9,2.0e9,1.98e9,2.6e9]); // -25% year; flat then +31%
{
  const cyc=GE.growthSignals(cycCo,px,null),spike=GE.growthSignals(spikeCo,px,null);
  assert(!cyc.eligible&&cyc.cyclical&&cyc.reasonsDown.some(x=>/^Cyclical/.test(x)),'cyclical: excluded live (69b) and labelled');
  assert(spike.eligible&&!spike.lastingGrowth&&spike.reasonsDown.some(x=>/Recent spike/.test(x)),'spike label');
  GE.GROWTH.requireDurable=true;GE.GROWTH.excludeCyclical=true;
  const c2=GE.growthSignals(cycCo,px,null),s2=GE.growthSignals(spikeCo,px,null);
  GE.GROWTH.requireDurable=false;GE.GROWTH.excludeCyclical=true;
  assert(!c2.eligible&&/cyclical/.test(c2.why),'cyclical: '+c2.why);
  assert(!s2.eligible&&/spike/.test(s2.why),'spike: '+s2.why);
}

// 4) Quarterly glitch (346% vs ~25% annual) falls back to annual growth; acceleration is clamped.
const q=[];for(let y=2023;y<=2024;y++)for(const m of ['03-31','06-30','09-30','12-31'])q.push({end:`${y}-${m}`,val:5e8});
q[q.length-1].val=5e8*4.46; // last quarter "346%" YoY
const gl=GE.growthSignals(co([1e9,1.25e9,1.5625e9,1.953e9,2.441e9],{quarterly:q}),px,null);
assert.strictEqual(gl.growthBasis,'annual');assert(gl.revGrowth<.3&&gl.dataWarnings?.length);
assert(gl.revAccel>=-1&&gl.revAccel<=1);

// 5) Impossible operating margin (APA showed 100%) is ignored.
const bad=GE.growthSignals(co([1e9,1.25e9,1.5625e9,1.953e9,2.441e9],{op:[.1,.1,.1,.1,1.0]}),px,null);
assert.strictEqual(bad.opMargin,null);assert.strictEqual(bad.opMarginChange,null);

// 6) Both weight sets sum to 1; the live default is the Build 65 set.
for(const w of [GE.GROWTH.weights,GE.GROWTH.durableWeights])assert(Math.abs(Object.values(w).reduce((a,b)=>a+b,0)-1)<1e-9);
assert(GE.GROWTH.durableWeights.durableGrowth>0&&GE.GROWTH.weights.durableGrowth===undefined&&GE.GROWTH.requireDurable===false&&GE.GROWTH.excludeCyclical===true); // Build 69b: cyclicals off the live list

// 7) revenueCagr3 and business growth.
assert(Math.abs(R.revenueCagr3([{revenue:100},{revenue:110},{revenue:121},{revenue:133.1}])-.10)<1e-9);
assert.strictEqual(R.revenueCagr3([{revenue:100},{revenue:110}]),null);
assert(Math.abs(R.businessGrowth({revenueGrowthTTM:.10,revenueCAGR3:-.06})-.02)<1e-12);

// 8) Value-trap check: two otherwise identical stocks, one shrinking -> it ranks below; legacy rule unaffected.
function row(t,ttm,c3){return {ticker:t,expectedAlpha:.03,underwrittenCAGR:.14,bearCAGR:.08,qualityScore:80,moatScore:70,growthQualityScore:60,compounderScore:65,
  marketCap:50e9,analystEstimates:{numAnalysts:20},revenueGrowthTTM:ttm,revenueCAGR3:c3};}
const mk=()=>[row('GROW',.09,.08),row('SHRINK',-.03,-.02),row('SLOW',.02,.02),...Array.from({length:20},(_,i)=>row('F'+i,.06,.06))];
const live=mk();R.applyModelDRanking(live,{rankField:'r',universeSizeField:null,reliability:true});
const byT=Object.fromEntries(live.map(x=>[x.ticker,x]));
assert(byT.GROW.r<byT.SLOW.r&&byT.SLOW.r<byT.SHRINK.r,'shrinking/slow businesses must rank lower');
assert.strictEqual(byT.SHRINK.rankGrowthPenalty,15);assert.strictEqual(byT.SLOW.rankGrowthPenalty,8);assert.strictEqual(byT.GROW.rankGrowthPenalty,0);
assert.strictEqual(byT.SHRINK.rankGrowthPenaltyReason,'shrinking revenue');
const legacy=mk();R.applyModelDRanking(legacy,{rankField:'r',universeSizeField:null});
assert(legacy.every(x=>x.rankGrowthPenalty===undefined),'legacy (frozen) rank must not apply the check');
// No growth data -> no penalty.
assert.strictEqual(R.valueTrapPenalty({}).points,0);
console.log('build68-test OK');
