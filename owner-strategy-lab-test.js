'use strict';
// Synthetic check of the Build 36 owner strategy lab: mechanics, caps, and that a planted signal is found.
const assert=require('assert');
const {adjustedReturnBetween,portfolioStats}=require('./backtest');
const L=require('./owner-strategy-lab');
const RP=require('./review-policy');
const H={adjustedReturnBetween,portfolioStats};
let seed=7;const rnd=()=>{seed=(1103515245*seed+12345)%2147483648;return seed/2147483648;};
const days=[];for(let d=new Date('2016-01-01');d<=new Date('2020-01-15');d.setUTCDate(d.getUTCDate()+1))days.push(d.toISOString().slice(0,10));
const series=drift=>{let p=100;return days.map(date=>{p*=Math.exp(drift/365+(rnd()-.5)*.02);return {date,close:p,adjustedClose:p};});};
const N=60,hist=new Map(),spy=series(.08);
const good=i=>i<15; // planted signal: the first 15 names are high-return, high-quality AND outperform
for(let i=0;i<N;i++)hist.set('T'+i,series(good(i)?.20:.02));
const dates=[];for(let y=2016;y<=2019;y++)for(const md of ['03-31','06-30','09-30','12-31'])dates.push(`${y}-${md}`);
const snaps=dates.map((asOf,qi)=>({asOf,rows:Array.from({length:N},(_,i)=>{
  const g=good(i),broken=i===3&&qi>=6; // T3's quality collapses mid-way -> must be sold
  return {ticker:'T'+i,sector:['Tech','Industrials','Health','Consumer','Energy'][i%5],marketCap:2e10,price:100,rating:g?'Buy':'Hold',
    expectedCAGR:g?.17:.07,underwrittenCAGR:g?.16:.06,expectedAlpha:(g?.17:.07)-.11,qualityScore:broken?60:(g?88:70),moatScore:g?80:50,growthQualityScore:g?80:50,compounderScore:g?80:50,
    valuationConfidence:g?85:60,requiredReturnBuyPrice:g?120:80};
})}));
const lab=L.buildOwnerStrategyLab(snaps,hist,spy,H,{splitYear:2018});
const arm=k=>lab.arms.find(a=>a.name.startsWith(k));
assert.ok(lab.arms.length===6&&lab.benchmarks.equalWeightUniverse);
assert.ok(arm('C').portfolioCAGR>lab.benchmarks.equalWeightUniverse.portfolioCAGR,'planted signal should beat the equal-weight universe');
assert.ok(arm('A').portfolioCAGR>lab.benchmarks.equalWeightUniverse.portfolioCAGR);
assert.ok((arm('C').sellReasons.quality_below_sell_floor||0)>=1,'T3 quality collapse must trigger a sell');
assert.ok(arm('E').averageHoldings<=10.0001&&arm('F').averageHoldings<=25.0001);
const b1=lab.rankBuckets['1Y'];assert.ok(b1[0].meanExcess>b1.at(-1).meanExcess||b1.at(-1).n===0);
// direct sim: weights never exceed the 20% trim line after a review (beyond one quarter of drift)
const sim=L.simulateOwnerStrategy(snaps,hist,spy,{name:'x',sizing:'conviction',maxPositions:15},H);
for(const p of sim.periods)assert.ok(p.maxHoldingWeight<=RP.SIZING.trimAbove+1e-9,'post-review weight above trim line');
assert.ok(sim.periods.every(p=>p.cashWeight>=-1e-9));
console.log('owner-strategy-lab tests passed',JSON.stringify({C:+arm('C').portfolioCAGR.toFixed(3),A:+arm('A').portfolioCAGR.toFixed(3),U:+lab.benchmarks.equalWeightUniverse.portfolioCAGR.toFixed(3)}));
{const f=L.entryFunnel(snaps);assert.strictEqual(f.byQuarter.length,snaps.length);assert.strictEqual(f.summary.plusQuality75.median,14);console.log('funnel ok');}
