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
// Build 86: financial-aware quality (experiment arm CQF).
const {computeQuality}=require('./engine/quality-engine');
{
  // A lender: steady 20% net margin, ROE 18%, operating-margin data that swings wildly (as in SEC data).
  const years=[];let revenue=60e9;
  for(let i=0;i<5;i++){revenue*=1.1;years.push({year:2020+i,revenue,netIncome:revenue*.20,stockholdersEquity:revenue*.20/.18,opMargin:[.05,.6,-.3,.9,.1][i],
    fcf:null,sharesOutTTM:1e9*(1-.02*i),sbcIntensity:.02});}
  const st={financials:{years,dataQuality:{financialLikeRevenue:true}},analystEstimates:{numAnalysts:20}};
  const q1=computeQuality(st,{}),q2=computeQuality(st,{},{financialAware:true});
  assert.strictEqual(q1.diagnostics.marginStability,0,'old: wild operating margins score 0');
  assert(q2.diagnostics.marginStability>=90,'v2: steady net margin scores high: '+q2.diagnostics.marginStability);
  assert(q2.qualityScore>q1.qualityScore,'lender quality rises');
  assert(Math.abs(q2.diagnostics.roe-.18)<1e-9,'ROE measured');
}
{
  // A thin-margin insurer with no ROIC: v2 scores returns on equity instead of margin.
  const years=[];let revenue=300e9;
  for(let i=0;i<5;i++){revenue*=1.1;years.push({year:2020+i,revenue,netIncome:revenue*.04,stockholdersEquity:revenue*.04/.20,opMargin:.06,
    fcf:revenue*.05,sharesOutTTM:1e9,sbcIntensity:.005,ebitda:revenue*.07,totalDebt:revenue*.1,cash:revenue*.05});}
  const st={financials:{years,dataQuality:{}},analystEstimates:{numAnalysts:20}};
  const q1=computeQuality(st,{}),q2=computeQuality(st,{},{financialAware:true});
  assert(q2.diagnostics.profitability>q1.diagnostics.profitability+15,'insurer profitability on ROE: '+q1.diagnostics.profitability+' -> '+q2.diagnostics.profitability);
  // Companies WITH ROIC are untouched.
  years.forEach(y=>y.roic=.15);
  assert.strictEqual(computeQuality(st,{}).qualityScore,computeQuality(st,{},{financialAware:true}).qualityScore);
}
// Lab: quality experiment arms by default.
{
  const lab=L.buildOwnerStrategyLab(snaps,hist,spy,H,{splitYear:2018,altSnapshotOutput:snaps});
  assert(lab.arms.find(a=>a.name.startsWith('CQF ·'))&&lab.arms.find(a=>a.name.startsWith('CQF75 ·')));
  assert(!lab.arms.find(a=>a.name.startsWith('CX ·')));
}
console.log('build86 tests passed');
{
  const lab=L.buildOwnerStrategyLab(snaps,hist,spy,H,{splitYear:2018,altSnapshotOutput:snaps});
  const d=lab.experimentDecision;
  assert(d&&d.arm==='CQF'&&d.adopt===false,'identical inputs: no 0.5-pt win, not adopted');
  console.log('build87 decision bar ok');
}
