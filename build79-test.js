'use strict';
// Build 79: cash the company keeps counts once, at $1 per $1. The interest on it that is already in EPS
// (growth in non-operating income, capped at a 4% yield on the cash) is taken out before the P/E.
const assert=require('assert');
const {buildSimplePath,calculateSimple,interestInEarnings}=require('./engine/simple-path');
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;

// helper
assert.strictEqual(interestInEarnings(0,200,100,.02,.2),0,'no cash built, nothing to remove');
assert.strictEqual(interestInEarnings(-50,200,100,.02,.2),0,'debt added: nothing to remove');
assert.strictEqual(interestInEarnings(100,200,100,0,.2),0,'no non-operating income in earnings');
assert(near(interestInEarnings(1000,200,100,.02,.2),.02*100*.8),'non-op growth (2) below 4% of cash (40)');
assert(near(interestInEarnings(10,200,100,.02,.2),.04*10*.8),'capped at a 4% yield on the cash');

// simple path: a cash hoarder (no buybacks, no dividends)
const rows=[];let R=100e9,S=1e9;
for(let i=0;i<10;i++){R*=1.10;rows.push({year:2026+i,revenue:R,revenueGrowth:.10,shares:S,actualDilution:0,gaapNetMargin:.25,netMargin:.25,
  sbcMargin:0,intangibleAmortizationMargin:0,taxRate:.20,fcfMargin:.25,preSbcFcfMargin:.25,eps:.25*R/S,dividendPerShare:0,nonOperatingMargin:.02});}
const val={methods:[{name:'EPS exit',audit:{exitMultiple:20}}],netDebt:0};
const sp=buildSimplePath({price:{current:500}},{rows},val);
assert.strictEqual(sp.version,4);
assert(near(sp.nonOperatingMargin,.02)&&near(sp.taxRate,.2));
const r=calculateSimple(sp);
const y=r.years[9];
const built=-y.netDebt;
assert(built>0);
const expectInt=Math.min(.02*(y.rev-sp.revenue0),.04*built)*.8/y.sh;
assert(near(y.interestPS,expectInt,1e-9));
assert(near(y.price,y.eps*y.pe-y.pe*y.interestPS+y.cashPS,1e-9),'price = (EPS - interest on built cash) x P/E + cash built');
assert(y.price<y.eps*y.pe+y.cashPS,'double count removed');
// Old snapshots without the field: no change from Build 78c.
const old={...sp,nonOperatingMargin:undefined};
const r0=calculateSimple(old);
assert(near(r0.years[9].price,r0.years[9].opsPrice+r0.years[9].cashPS,1e-9));
console.log('build79 tests passed');
