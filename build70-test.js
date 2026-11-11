'use strict';
// Build 70: trailing-twelve-month profits/cash flow from 10-Qs folded into the last fiscal year.
const assert=require('assert');
const D=require('./data-fetchers');
const near=(a,b,t=1e-6)=>Math.abs(a-b)<=t*Math.max(1,Math.abs(b));

// SEC-style facts for a calendar-year company: FY2025 10-K, then 2026 10-Qs through Q3 (9-month YTD),
// with 2025 comparatives inside the 2026 10-Qs. Margins collapse in 2026 (PRIM pattern).
function F(start,end,val,form,filed){return {start,end,val,form,filed};}
function facts(){
  const rev=[F('2025-01-01','2025-12-31',4000,'10-K','2026-02-20'),
    F('2025-01-01','2025-09-30',2900,'10-Q','2026-11-05'),F('2026-01-01','2026-09-30',3000,'10-Q','2026-11-05'),
    F('2026-07-01','2026-09-30',1050,'10-Q','2026-11-05'),F('2025-07-01','2025-09-30',1000,'10-Q','2026-11-05')];
  const ni=[F('2025-01-01','2025-12-31',400,'10-K','2026-02-20'),
    F('2025-01-01','2025-09-30',290,'10-Q','2026-11-05'),F('2026-01-01','2026-09-30',60,'10-Q','2026-11-05'),
    F('2026-07-01','2026-09-30',10,'10-Q','2026-11-05')];
  // cash flow is year-to-date only
  const cfo=[F('2025-01-01','2025-12-31',500,'10-K','2026-02-20'),F('2025-01-01','2025-09-30',360,'10-Q','2026-11-05'),F('2026-01-01','2026-09-30',120,'10-Q','2026-11-05')];
  const capex=[F('2025-01-01','2025-12-31',100,'10-K','2026-02-20'),F('2025-01-01','2025-09-30',70,'10-Q','2026-11-05'),F('2026-01-01','2026-09-30',80,'10-Q','2026-11-05')];
  const u=a=>({units:{USD:a}});
  return {facts:{'us-gaap':{Revenues:u(rev),NetIncomeLoss:u(ni),NetCashProvidedByUsedInOperatingActivities:u(cfo),PaymentsToAcquirePropertyPlantAndEquipment:u(capex)}}};
}

// 1) TTM identity: FY + YTD - prior YTD, picking the 9-month YTD over the single quarter.
const t=D.parseTrailingTwelveMonths(facts());
assert.strictEqual(t.end,'2026-09-30');assert.strictEqual(t.fyEnd,'2025-12-31');
assert.strictEqual(t.revenue,4100);assert.strictEqual(t.netIncome,170);assert.strictEqual(t.cfo,260);assert.strictEqual(t.capex,110);

// 2) Overlay: 3 quarters into the year -> 75% weight on TTM margins; revenue and year label unchanged.
const years=[{year:2024,revenue:3600,netIncome:330},{year:2025,revenue:4000,netIncome:400,operatingIncome:520,cfo:500,capex:100,fcf:400,dilutedEPS:4,sharesOutTTM:100}];
const info=D.applyTtmOverlay(years,t);
const L=years[1];
assert.strictEqual(info.weight,.75);assert.strictEqual(L.revenue,4000);assert.strictEqual(L.year,2025);
assert(near(L.netIncome,4000*(.25*.10+.75*170/4100)),'net income '+L.netIncome);
assert(near(L.fcf,L.cfo-L.capex));assert(near(L.dilutedEPS,4*L.netIncome/400));
assert(L.ttmOverlay&&L.ttmOverlay.ttmNetMargin<L.ttmOverlay.annualNetMargin);
assert.strictEqual(L.operatingIncome,520,'no TTM operating income -> left as filed');

// 3) Point-in-time: before the Q3 10-Q is filed, nothing past the cutoff can be used.
const raw=facts();const asOf='2026-10-01';
const cut={facts:{'us-gaap':Object.fromEntries(Object.entries(raw.facts['us-gaap']).map(([k,v])=>[k,{units:{USD:v.units.USD.filter(x=>x.filed<=asOf)}}]))}};
assert.strictEqual(D.parseTrailingTwelveMonths(cut),null,'no 10-Q filed yet -> no TTM');

// 4) Guards: fiscal-year mismatch, revenue mismatch (acquisition), too early in the year.
assert.strictEqual(D.applyTtmOverlay([{year:2024,revenue:4000,netIncome:400}],t).skipped,'fiscal_year_mismatch');
assert.strictEqual(D.applyTtmOverlay([{year:2025,revenue:1500,netIncome:150}],t).skipped,'ttm_revenue_mismatch');
assert.strictEqual(D.applyTtmOverlay([{year:2025,revenue:4000,netIncome:400}],{...t,end:'2026-01-31'}),null);
console.log('build70-test OK');
