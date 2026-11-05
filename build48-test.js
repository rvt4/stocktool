'use strict';
// Build 48: analyst-anchored margin recovery for turnarounds / post-acquisition resets.
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const run=s=>{const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return {f,q,v,d:rateStock(s,f,q,v)};};
// netPath: per-year net margins (oldest first); op margin = net + 4pts
function stock({ticker,netPath,growth=.08,analyst=null,price=100,sbc=.01}){
  const years=[];let revenue=8e9;const shares=200e6;
  netPath.forEach((nm,i)=>{revenue*=1+growth;years.push({year:2026-netPath.length+i,revenue,netIncome:revenue*nm,operatingIncome:revenue*(nm+.04),ebitda:revenue*(nm+.08),cfo:revenue*(nm+.07),capex:revenue*.04,fcf:revenue*(nm+.03),sbc:revenue*sbc,sharesOutTTM:shares,totalDebt:2e9,cash:1e9,pretaxIncome:revenue*(nm+.03),incomeTaxExpense:revenue*(nm+.03)*.2});});
  const ae={revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth,numAnalysts:analyst?analyst.n:0};
  if(analyst){const r1=revenue*(1+growth),r2=r1*(1+growth);Object.assign(ae,{revenueCurrentYear:r1,revenueNextYear:r2,epsCurrentYear:analyst.net1*r1/shares,epsNextYear:analyst.net2*r2/shares});}
  return {ticker,sector:'Industrials',financials:{years,dataQuality:{}},analystEstimates:ae,growthYear1:growth,price:{current:price},valuation:{dividendYield:0,growthSource:'test'}};
}
const net=r=>r.f.rows?r.f.rows.map(x=>x.netMargin):r.f.projection?.map(x=>x.netMargin);
const rowsOf=r=>(r.f.rows||r.f.projection||r.f.years||[]);
const m=r=>rowsOf(r).map(x=>x.netMargin);

// 1) Turnaround: good margins years ago, losses recently, analysts expect a return to profit.
const turnHist=[.08,.09,.10,.09,-.02,-.12,-.05,-.06,-.03,.02];
const noA=run(stock({ticker:'T0',netPath:turnHist}));
const withA=run(stock({ticker:'T1',netPath:turnHist,analyst:{n:24,net1:.01,net2:.04}}));
const a0=m(noA),a1=m(withA);
assert(a0.length===10&&a1.length===10,'expected 10 projection rows: '+Object.keys(withA.f));
assert(a1[9]>a0[9]+.005,'turnaround mature margin should recover with analyst support: '+a0[9]+' -> '+a1[9]);
assert(Math.min(...a1)>=Math.min(...a0)-1e-9,'anchor must not deepen the trough');
assert(withA.f.forecastFlags?.includes('analyst_anchored_margin_recovery'),'flag missing');
// recovery is partial: never above the company's proven (70th pct) margin
assert(a1[9]<=.10+1e-9,'recovery overshoots proven earning power: '+a1[9]);

// 2) Post-acquisition reset (CELH-like): analysts' run-rate far above depressed reported margin.
const reset=[.06,.13,.06,.01,-.29,.17,.11,.04];
const r0=m(run(stock({ticker:'R0',netPath:reset,growth:.15}))),r1=m(run(stock({ticker:'R1',netPath:reset,growth:.15,analyst:{n:24,net1:.11,net2:.13}})));
assert(r1[0]>r0[0]+.02,'year-1 margin should move toward analysts: '+r0[0]+' -> '+r1[0]);
assert(r1[9]>r0[9],'mature margin should improve');

// 3) Stable company where analysts agree: essentially unchanged (< 0.5pt anywhere)
const stable=[.20,.20,.21,.20,.21,.20];
const s0=m(run(stock({ticker:'S0',netPath:stable}))),s1=m(run(stock({ticker:'S1',netPath:stable,analyst:{n:25,net1:.205,net2:.21}})));
s0.forEach((x,i)=>assert(Math.abs(s1[i]-x)<.005,'stable company moved at year '+(i+1)+': '+x+' -> '+s1[i]));

// 4) Symmetric: analysts well below the model pull the near-term margin DOWN (no optimism-only bias)
const d1=m(run(stock({ticker:'D1',netPath:stable,analyst:{n:25,net1:.12,net2:.12}})));
assert(d1[0]<s0[0]-.02,'analyst-below should lower the start: '+s0[0]+' -> '+d1[0]);

// 5) Thin coverage (<5 analysts) changes nothing
const t3=m(run(stock({ticker:'T3',netPath:turnHist,analyst:{n:3,net1:.01,net2:.04}})));
t3.forEach((x,i)=>assert(Math.abs(x-a0[i])<1e-9,'thin coverage should not anchor'));

// 6) The valuation stays internally consistent (validation-style invariants)
for(const r of [withA,run(stock({ticker:'R1',netPath:reset,growth:.15,analyst:{n:24,net1:.11,net2:.13}}))]){
  assert(Number.isFinite(r.v.expectedCAGR),'no CAGR');
  if(Number.isFinite(r.v.bearCAGR)&&Number.isFinite(r.v.bullCAGR)) assert(r.v.bearCAGR<=r.v.expectedCAGR+1e-9&&r.v.expectedCAGR<=r.v.bullCAGR+1e-9,'scenario ordering broken');
}
console.log('Build 48 tests passed',JSON.stringify({turnY10:[+a0[9].toFixed(3),+a1[9].toFixed(3)],resetY1:[+r0[0].toFixed(3),+r1[0].toFixed(3)],resetY10:[+r0[9].toFixed(3),+r1[9].toFixed(3)]}));
// 7) SBC basis is inferred per company from the current-year estimate
{
  const {buildForecast}=require('./engine/forecast-engine');
  const hist=[.15,.15,.16,.15,.16,.15];
  const mk=(net1)=>{const st=stock({ticker:'SB',netPath:hist,sbc:.08,analyst:{n:25,net1,net2:net1}});return buildForecast(st).forecastBridge.margins.analystMarginAnchor;};
  const ex=mk(.15+.08*.8),incl=mk(.15);
  assert.strictEqual(ex.consensusBasis,'excludes_sbc');assert.ok(ex.sbcDeduction>.05,'full historical SBC deducted when consensus excludes it');
  assert.strictEqual(incl.consensusBasis,'includes_sbc');assert.strictEqual(incl.sbcDeduction,0);
  console.log('SBC basis inference ok');
}
