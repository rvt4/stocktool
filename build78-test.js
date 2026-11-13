'use strict';
// Build 78: simple projection — revenue growth, EPS, share change, exit P/E in; everything else derived.
const assert=require('assert');
const {buildSimplePath,calculateSimple}=require('./engine/simple-path');
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;

// Model rows: revenue +10%/yr from 100B, shares -1%/yr from 1B, GAAP net 20%, SBC 3%, amortization 1%, tax 20%,
// owner FCF 18%, DPS $1. Engine EPS exit: 20x on reported year-10 EPS.
const rows=[];let R=100e9,S=1e9;
for(let i=0;i<10;i++){R*=1.10;S*=0.99;rows.push({year:2026+i,revenue:R,revenueGrowth:.10,shares:S,actualDilution:-.01,gaapNetMargin:.20,netMargin:.208,
  sbcMargin:.03,intangibleAmortizationMargin:.01,taxRate:.20,fcfMargin:.18,eps:.20*R/S,dividendPerShare:1});}
const val={methods:[{name:'EPS exit',audit:{exitMultiple:20,metric:rows[9].eps}}],netDebt:10e9};
const adjM=.20+.03*.8+.01*.8;                                   // 23.2% analyst-basis margin

// 1) No analysts: everything from the model, on the analyst EPS basis.
let sp=buildSimplePath({price:{current:500}},{rows},val);
assert.strictEqual(sp.basis,'model');
assert(near(sp.years[0].netMargin,adjM)&&near(sp.years[0].eps,adjM*rows[0].revenue/rows[0].shares));
assert(near(sp.years[3].revenueGrowth,.10)&&near(sp.years[3].shareChange,-.01));
// Build 78c: exit P/E = the engine's multiple, not cut for stock pay (charged via dilution and buybacks instead).
assert(near(sp.exitPE,20,1e-9));
// Cash conversion is PRE-stock-pay FCF (18% owner + 3% stock pay = 21%) per $ of adjusted earnings.
assert(near(sp.years[0].cashConversion,.21/adjM,1e-9)&&sp.years[0].preSbc&&near(sp.years[0].sbcMargin,.03));

// 2) Consensus for years 1-2 (trimmed 3% / 8%), model drift after.
const an={numAnalysts:12,revenueCurrentYear:rows[0].revenue*1.02,revenueNextYear:rows[1].revenue*1.03,epsCurrentYear:30,epsNextYear:34};
sp=buildSimplePath({price:{current:500},analystEstimates:an},{rows},val);
assert.strictEqual(sp.basis,'consensus_years_1_2');
assert(near(sp.years[0].eps,30*.97,1e-9)&&near(sp.years[1].eps,34*.92,1e-9),'consensus EPS, trimmed');
assert(near(sp.years[0].revenue,an.revenueCurrentYear));
assert(near(sp.years[4].netMargin,sp.years[1].netMargin,1e-9),'flat model margin -> margin holds at the year-2 level');
// A fading stock-pay share with flat GAAP profit must not drag the analyst-basis margin down (SNOW case).
{const r2=rows.map((r,i)=>({...r,sbcMargin:.03-.002*i}));const s2=buildSimplePath({price:{current:500},analystEstimates:an},{rows:r2},val);
 assert(near(s2.years[9].netMargin,s2.years[1].netMargin,1e-9),'stock-pay fade ignored in the margin trend');}
// thin coverage or a mismatched revenue base falls back to the model
assert.strictEqual(buildSimplePath({price:{current:500},analystEstimates:{...an,numAnalysts:2}},{rows},val).basis,'model');
assert.strictEqual(buildSimplePath({price:{current:500},analystEstimates:{...an,revenueCurrentYear:rows[0].revenue*2}},{rows},val).basis,'model');

// 3) One-off gains in this year's consensus: autofill uses a clean year 1.
const spike={...an,epsCurrentYear:60};                           // margin far above next year's
sp=buildSimplePath({price:{current:500},analystEstimates:spike},{rows},val);
assert(sp.oneOffYear1&&near(sp.oneOffYear1.analystEps,60));
assert(near(sp.years[0].netMargin,sp.years[1].netMargin+.02,1e-9));

// 4) Calculator: price = EPS x P/E + cash built per share; one consistent return.
sp=buildSimplePath({price:{current:500}},{rows},val);
const c=calculateSimple(sp);
const y10=c.years[9];
assert(near(y10.pe,sp.exitPE,1e-9));
assert(near(y10.price,y10.eps*y10.pe+(10e9-y10.netDebt)/y10.sh,1e-6));
assert(y10.netDebt<10e9,'cash builds');
const divs=c.years.reduce((t,y)=>t+y.dps,0);
assert(near(c.cagr,Math.pow((y10.price+divs)/500,.1)-1,1e-12));
// Higher EPS -> higher EPS, more cash (FCF follows EPS), higher price. Revenue growth moves EPS at the same margin.
const up=calculateSimple(sp,{netMargin:sp.years.map(y=>y.netMargin+.05)});
assert(up.years[9].eps>y10.eps&&up.years[9].netDebt<y10.netDebt&&up.cagr>c.cagr);
const fast=calculateSimple(sp,{revenueGrowth:sp.years.map(()=>.15)});
assert(near(fast.years[0].margin,c.years[0].margin)&&fast.years[9].eps>y10.eps);
// Buybacks (shares shrink) raise EPS but spend cash.
const bb=calculateSimple(sp,{shareChange:sp.years.map(()=>-.04)});
assert(bb.years[9].eps>y10.eps&&bb.years[9].netDebt>y10.netDebt);
// Exit P/E edit
assert(calculateSimple(sp,{exitPE:sp.exitPE*1.5}).cagr>c.cagr);

// 5) The nightly exports it; the page loads the same file.
const fs=require('fs');
assert(/simplePath:\(\(\)=>\{try\{return require\('\.\/engine\/simple-path'\)\.buildSimplePath/.test(fs.readFileSync('run-screener.js','utf8')));
assert(/engine\/simple-path\.js/.test(fs.readFileSync('index.html','utf8')));

// 6) Build 78b: last year's EPS (for year-1 growth), per-year P/E and net-debt overrides.
{
  const spA=buildSimplePath({price:{current:500},analystEstimates:{...an,epsGrowthCurrentYear:.20}},{rows},val);
  assert(near(spA.eps0,30/1.2,1e-9),'last year EPS = this year consensus / (1 + its growth)');
  assert(sp.eps0>0,'model fallback for last year EPS');
  const base=calculateSimple(sp);
  const pe=Array(10).fill(null);pe[4]=40;
  const p5=calculateSimple(sp,{pe});
  assert(near(p5.years[4].pe,40)&&p5.years[4].peSet&&!p5.years[3].peSet);
  assert(p5.years[4].price>base.years[4].price);
  assert(Math.abs(p5.years[6].price-base.years[6].price)/base.years[6].price<.02,'other years barely move (only that year\'s buyback cost)');
  const nd=Array(10).fill(null);nd[3]=50e9;
  const n4=calculateSimple(sp,{netDebt:nd});
  assert(near(n4.years[3].netDebt,50e9)&&n4.years[3].netDebtSet);
  assert(near(n4.years[4].netDebt-50e9,base.years[4].netDebt-base.years[3].netDebt,1e3),'later years roll on from the typed figure');
  assert(n4.years[9].price<base.years[9].price&&n4.cagr<base.cagr);
  assert(!base.years[9].peSet&&calculateSimple(sp,{exitPE:25,exitPESet:true}).years[9].peSet);
}

// 7) Build 78c: stock pay costs cash only for the shares actually bought back.
{
  const base=calculateSimple(sp);
  // Flat share count -> all stock-pay shares are bought back -> stock pay $ leaves as cash.
  const flat=calculateSimple(sp,{shareChange:sp.years.map(()=>0)});
  const y=flat.years[5],prev=flat.years[4];
  const flow=y.preFcf-y.dps*y.sh-Math.max(0,y.sbc-(y.sh-prev.sh)*y.opsPrice);
  assert(near(prev.netDebt-y.netDebt,flow,1e3),'net debt falls by pre-stock-pay FCF minus dividends minus buybacks');
  assert(near(y.ownerFcf,y.preFcf-y.sbc,1e-6));
  // Share count rising by the full stock-pay issuance -> no buyback cash -> more cash kept than with a flat count.
  const iss=sp.years.map((Y,i)=>.03*base.years[i].rev/(base.years[i].opsPrice*base.years[i].sh));
  const dil=calculateSimple(sp,{shareChange:iss});
  assert(dil.years[9].netDebt<flat.years[9].netDebt,'dilution instead of buybacks keeps the cash');
  assert(dil.years[9].eps<flat.years[9].eps,'...but lowers EPS');
}
console.log('build78 tests passed');
