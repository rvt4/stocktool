'use strict';
// Build 69: cyclical-at-peak profile and switchable rank penalty.
const assert=require('assert');
const R=require('./engine/ranking-engine');
const yrs=(revs,margins)=>revs.map((r,i)=>({year:2018+i,revenue:r,netIncome:r*margins[i]}));

// Steady compounder: not cyclical.
const steady=R.cycleProfile(yrs([10,11,12,13,14,15,16,17],[.15,.15,.16,.15,.16,.16,.15,.16]));
assert(steady&&!steady.cyclical&&!steady.atPeak);
// Airline: revenue -60% in one year -> cyclical; margin now at median -> not at peak.
const air=R.cycleProfile(yrs([10,11,4.4,7,10,11,11.5,12],[.06,.06,-.3,-.05,.005,.06,.05,.06])); // 2022 profit collapse
assert(air.cyclical&&!air.atPeak,'airline '+JSON.stringify(air));
// Chicken producer: margins swing 1% -> 9%; now 9% vs ~3% median -> cyclical at peak.
const chick=R.cycleProfile(yrs([10,10.5,11,12,13,13,13.5,14],[.03,.01,.035,.04,.012,.03,.08,.09])); // two slump years
assert(chick.cyclical&&chick.atPeak,'chicken '+JSON.stringify(chick));
// Pandemic-only shock (2020) is not a cycle: a hotel/travel name that fell 60% in 2020 only.
const travel=R.cycleProfile(yrs([10,11,4.4,8,11,12,13,14],[.2,.2,-.5,.1,.2,.21,.2,.21]));
assert(travel&&!travel.cyclical,'2020-only shock should not count '+JSON.stringify(travel));
// Too little history -> no profile, no penalty.
assert.strictEqual(R.cycleProfile(yrs([10,11,12],[.1,.1,.1])),null);
assert.strictEqual(R.cyclePenalty({}).points,0);

// Rank: with the switch on, the peak cyclical drops below an identical steady company; off = no effect on rank.
function row(t,cycle){return {ticker:t,expectedAlpha:.03,underwrittenCAGR:.14,bearCAGR:.08,qualityScore:80,moatScore:70,growthQualityScore:60,compounderScore:65,
  marketCap:50e9,analystEstimates:{numAnalysts:20},revenueGrowthTTM:.08,revenueCAGR3:.08,cycle};}
const mk=()=>[row('PEAK',chick),row('STEADY',steady),...Array.from({length:20},(_,i)=>row('F'+i,steady))];
const on=mk();R.applyModelDRanking(on,{rankField:'r',universeSizeField:null,reliability:true,cycle:true});
const o=Object.fromEntries(on.map(x=>[x.ticker,x]));
assert(o.PEAK.r>o.STEADY.r&&o.PEAK.rankCyclePenalty===R.CYCLE_PENALTY.peakPoints&&/peak/.test(o.PEAK.rankCycleLabel));
const off=mk();R.applyModelDRanking(off,{rankField:'r',universeSizeField:null,reliability:true,cycle:false});
const f=Object.fromEntries(off.map(x=>[x.ticker,x]));
assert(f.PEAK.rankCyclePenalty===0&&f.PEAK.rankCycleLabel,'label without penalty when off');
assert(Math.abs(f.PEAK.rankScore-f.STEADY.rankScore)<1e-9,'switch off must not change the score');
assert.strictEqual(R.CYCLE_PENALTY.live,false,'live switch stays off until arm C2 wins');
console.log('build69-test OK');
