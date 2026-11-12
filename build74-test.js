'use strict';
// Build 74: null-safe quality inputs, PEG list, sell-rule variants, after-tax backtest accounting.
const assert=require('assert');
const RP=require('./review-policy');
const {computeQuality}=require('./engine/quality-engine');
const {earningsProfile}=require('./engine/ranking-engine');
const L=require('./owner-strategy-lab');
const {adjustedReturnBetween,portfolioStats}=require('./backtest');
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;

// (Build 75 updated: PEG bands 1.5/2.0/2.5, analyst1y source name, quality sell needs entry quality.)
// 1) Missing ROIC no longer scores as 0% ROIC; it falls back to net margin.
const yrs=r=>[2021,2022,2023,2024].map((y,i)=>({revenue:100*(1.12**i),netIncome:50*(1.12**i),fcf:45*(1.12**i),opMargin:.66,roic:r,sharesOutTTM:10}));
const qMissing=computeQuality({financials:{years:yrs(null)}},{}), qZero=computeQuality({financials:{years:yrs(0)}},{});
assert(qMissing.diagnostics.profitability>=95,'50% net margin business scores as highly profitable when ROIC is missing');
assert(qZero.diagnostics.profitability<60,'a real 0% ROIC still scores low');
assert(qMissing.qualityScore>qZero.qualityScore+10);
// Missing FCF years are skipped, not counted as zero FCF.
const gap=yrs(.3);gap[0].fcf=null;assert.strictEqual(computeQuality({financials:{years:gap}},{}).diagnostics.positiveFCFHistory,1);

// 2) Trailing earnings profile and PEG.
const ep=earningsProfile([{netIncome:100,sharesOutTTM:10},{netIncome:120,sharesOutTTM:10},{netIncome:140,sharesOutTTM:10},{netIncome:160,sharesOutTTM:10}],3200);
assert(near(ep.peTTM,20));assert(near(ep.epsCAGR3,Math.pow(1.6,1/3)-1));
assert.deepStrictEqual(earningsProfile([{netIncome:null},{netIncome:-5}],100),{peTTM:null,epsCAGR3:null});
const fwd={ticker:'F',price:100,qualityScore:85,revenueGrowthTTM:.20,revenueCAGR3:.20,analystEstimates:{epsNextYear:5,epsGrowthNextYear:.25,revenueGrowthNextYear:.20}};
assert(near(RP.pegOf(fwd).peg,20/25)&&RP.pegOf(fwd).source==='analyst1y'&&RP.pegEntry(fwd));
// One-off EPS jump is capped at 1.5x revenue growth: 80% EPS growth on 10% revenue growth -> 15%.
const jump={...fwd,price:150,revenueGrowthTTM:.10,revenueCAGR3:.10,analystEstimates:{epsNextYear:5,epsGrowthNextYear:.80,revenueGrowthNextYear:.10}};
assert(near(RP.pegOf(jump).growth,.15)&&!RP.pegEntry(jump));
const trail={ticker:'T',price:50,qualityScore:80,revenueGrowthTTM:.15,revenueCAGR3:.15,peTTM:18,epsCAGR3:.20};
assert(RP.pegOf(trail).source==='trailing'&&near(RP.pegOf(trail).peg,18/20)&&RP.pegEntry(trail));
assert(!RP.pegEntry({...trail,qualityScore:70})&&!RP.pegEntry({...trail,revenueGrowthTTM:.05,revenueCAGR3:.05})&&!RP.pegEntry({...trail,epsCAGR3:-.1}));
assert(RP.pegEntry({...trail,peTTM:36},{maxPeg:RP.PEG.watchMax})&&!RP.pegEntry({...trail,peTTM:36}));

// 3) Sell rules.
const st=o=>({ticker:'S',rating:'Hold',qualityScore:85,underwrittenCAGR:.05,overallRank:300,revenueGrowthTTM:.12,revenueCAGR3:.12,...o});
const H=(s,prev,ctx)=>RP.holdingStatus(s,prev,ctx).status;
assert.strictEqual(H(st(),{u:.05},{}),'Sell candidate','current rule: 5% twice sells');
assert.strictEqual(H(st(),{u:.05},{sellRule:'relative',marketMedian:.06}),'Hold','relative: line = 3%, 5% is fine');
assert.strictEqual(H(st({underwrittenCAGR:.02}),{u:.02},{sellRule:'relative',marketMedian:.06}),'Sell candidate');
assert.strictEqual(H(st({underwrittenCAGR:.04}),{u:.04},{sellRule:'relative',marketMedian:.12}),'Sell candidate','relative line never above 6.5%');
assert.strictEqual(H(st({underwrittenCAGR:-.05}),{u:-.05},{sellRule:'qualityOnly'}),'Hold');
assert.strictEqual(H(st({underwrittenCAGR:-.05,qualityScore:65}),{u:-.05,entryQ:80},{sellRule:'qualityOnly'}),'Sell candidate','quality still sells');
assert.strictEqual(H(st({peTTM:60,epsCAGR3:.20}),{peg:3},{sellRule:'peg'}),'Sell candidate');
assert.strictEqual(H(st({peTTM:30,epsCAGR3:.20}),{peg:3},{sellRule:'peg'}),'Hold','PEG 1.5 is not expensive even with a low model return');
assert.strictEqual(H(st(),null,{sellRule:'staged'}),'Trim half');
assert.strictEqual(H(st(),{u:.05},{sellRule:'staged'}),'Sell candidate');
assert.strictEqual(RP.SELL.rule,'current','live sell rule unchanged until the backtest picks one');

// 4) After-tax accounting on a one-stock world: buy at 100, sells after it doubles.
const days=[];for(let d=new Date('2016-01-01');d<=new Date('2019-03-15');d.setUTCDate(d.getUTCDate()+1))days.push(d.toISOString().slice(0,10));
const mk=f=>days.map(date=>({date,close:f(date),adjustedClose:f(date)}));
const spy=mk(()=>100);
const px=date=>date<'2016-05-01'?100:200; // doubles in Q2 2016, flat after
const hist=new Map([['W',mk(px)]]);
const dates=['2016-03-31','2016-06-30','2016-09-30','2016-12-31','2017-03-31','2017-06-30','2017-09-30'];
const row=(asOf,u)=>({ticker:'W',sector:'Tech',price:100,rating:'Buy',qualityScore:85,underwrittenCAGR:u,expectedCAGR:u,marketCap:1e10,revenueGrowthTTM:.2,revenueCAGR3:.2,peTTM:u>0?10:100,epsCAGR3:.2});
// Short-term case: return collapses right after the jump -> sold within a year.
const snapsST=dates.map((asOf,i)=>({asOf,rows:[row(asOf,i>=1?.0:.2)]}));
const sim=(snaps,o)=>L.simulateOwnerStrategy(snaps,hist,spy,{name:'t',entry:'peg',sizing:'equal',maxPositions:1,maxRank:Infinity,transactionCostBps:0,trim:false,...o},{adjustedReturnBetween,portfolioStats});
const a=sim(snapsST,{sellRule:'current'});
assert.strictEqual(a.sells,1);
// 30% sector cap at purchase: 0.30 in, doubles to 0.60 while 0.70 sits in flat SPY -> portfolio 1.30.
const G=0.30/1.30;
assert(near(a.shortTermGains,G,1e-3)&&near(a.longTermGains,0,1e-9),'gain realized short-term, in fraction-of-portfolio units');
assert(near(a.taxPaidTotal,G*0.35,1e-3));
assert(a.afterTax.afterTaxCAGR<a.portfolioCAGR);
// Never selling: no tax paid along the way; liquidation taxes the gain at the long-term rate.
const b=sim(snapsST,{sellRule:'qualityOnly'});
assert.strictEqual(b.sells,0);assert.strictEqual(b.taxPaidTotal,0);
assert(b.afterTax.unrealizedTaxAtEnd>0&&near(b.afterTax.unrealizedTaxAtEnd,G*0.20,1e-3));
assert(b.afterTax.afterTaxLiquidatedCAGR>a.afterTax.afterTaxLiquidatedCAGR,'deferring the gain beats selling it short-term');
// Staged rule sells half, then the rest.
const c=sim(snapsST,{sellRule:'staged'});assert.strictEqual(c.trims,1);assert.strictEqual(c.sells,1);
console.log('build74 tests passed');
