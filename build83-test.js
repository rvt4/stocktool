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
// Build 83: CX / CXQ run arm C on the experiment's snapshots. Identical inputs -> identical results.
const lab=L.buildOwnerStrategyLab(snaps,hist,spy,H,{splitYear:2018,altSnapshotOutput:snaps});
const arm=k=>lab.arms.find(a=>a.name.startsWith(k));
assert.strictEqual(lab.arms.length,25,'C/CX arms: '+lab.arms.length);
assert(arm('CX ·')&&arm('CXQ ·'));
assert(Math.abs(arm('CX ·').portfolioCAGR-arm('C ·').portfolioCAGR)<1e-12,'same inputs, same result');
assert(arm('CX ·').afterTaxSplit&&arm('CX ·').development,'split and after-tax applied to the new arms');
// Without the experiment's snapshots nothing is added.
assert.strictEqual(L.buildOwnerStrategyLab(snaps,hist,spy,H,{splitYear:2018}).arms.length,23);
console.log('build83 tests passed');
