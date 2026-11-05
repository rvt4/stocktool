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
s0.forEach((x,i)=>assert(Math.abs(s1[i]-x)<.01,'stable company moved at year '+(i+1)+': '+x+' -> '+s1[i]));

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

// 8) Analysts on a different revenue base (spin-off): no anchor
{
  const st=stock({ticker:'SPIN',netPath:[.15,.15,.16,.15,.02],analyst:{n:23,net1:.26,net2:.30}});
  st.analystEstimates.revenueCurrentYear/=2;st.analystEstimates.revenueNextYear/=2; // half the revenue, same EPS
  const f=buildForecast(st);assert.strictEqual(f.forecastBridge.margins.analystMarginAnchor.revenueBaseMismatch,true);assert.strictEqual(f.forecastBridge.margins.analystMarginAnchor.applied,false);
}
// 9) Analysts below the model lower EPS margins but never the cash (FCF) path
{
  const hist=[.20,.20,.21,.20,.21,.20];
  const f0=buildForecast(stock({ticker:'C0',netPath:hist})),f1=buildForecast(stock({ticker:'C1',netPath:hist,analyst:{n:25,net1:.12,net2:.12}}));
  const fcf=f=>f.rows.map(r=>r.fcfMargin);fcf(f1).forEach((x,i)=>assert(x>=fcf(f0)[i]-1e-9,'FCF cut by analyst pull-down at year '+(i+1)));
  console.log('guards ok');
}
// 10) Build 50 dividend sanity: a mis-tagged $76 dividend on an $83 stock is capped; high yielders grow slowly
{
  const st=stock({ticker:'DIVX',netPath:[.10,.10,.11,.10,.10],price:83});
  st.financials.years.at(-1).dividendPerShare=76;
  const f=buildForecast(st);
  assert(f.rows[0].dividendPerShare<=83*.15+1e-9,'starting dividend not capped: '+f.rows[0].dividendPerShare);
  assert(f.forecastFlags.includes('dividend_sanity_capped'));
  f.rows.forEach(r=>{if(r.eps!=null&&r.fcfPerShare!=null)assert(r.dividendPerShare<=Math.max(r.eps,r.fcfPerShare)*1.25+1e-9,'payout above 125%');});
  const ok=stock({ticker:'DIVOK',netPath:[.10,.10,.11,.10,.10],price:83});ok.financials.years.at(-1).dividendPerShare=1.5;
  const g=buildForecast(ok);assert(!g.forecastFlags.includes('dividend_sanity_capped'),'normal dividend should not be capped');assert(Math.abs(g.rows[0].dividendPerShare-1.5)<.2);
  console.log('dividend sanity ok');
}
// 11) Build 51 peak-margin discipline
{
  const boom=[.04,.05,.04,.06,.05,.04,.06,.08,.11,.13]; // contractor: 4-6% for years, now 13%
  const st=stock({ticker:'BOOM',netPath:boom,growth:.20});st.sector='Industrials';
  const f=buildForecast(st),nm=f.rows.map(r=>r.netMargin);
  assert(f.forecastFlags.includes('peak_margin_reversion'),'peak flag missing');
  assert(nm[9]<.13,'boom margin should partly revert by year 10: '+nm[9]);
  assert(nm[9]>.06,'but not all the way to history: '+nm[9]);
  // a steady high-margin business is untouched
  const steady=buildForecast(stock({ticker:'STD',netPath:[.20,.21,.20,.21,.20,.21,.20]}));
  assert(!steady.forecastFlags.includes('peak_margin_reversion'),'steady business should not be reverted');
  // the CELH-like analyst-supported recovery survives
  const reset=[.06,.13,.06,.01,-.29,.17,.11,.04];
  const r1=buildForecast(stock({ticker:'R1',netPath:reset,growth:.15,analyst:{n:24,net1:.11,net2:.13}}));
  assert(r1.rows[9].netMargin>.10,'recovery undone by peak discipline: '+r1.rows[9].netMargin);
  console.log('peak discipline ok',JSON.stringify({boomY10:+nm[9].toFixed(3),resetY10:+r1.rows[9].netMargin.toFixed(3)}));
}
// 12) Durability: a 5-year sustained step-up with rising gross margins and analyst support reverts far less
{
  const spike=[.04,.05,.04,.05,.04,.05,.04,.05,.06,.13];   // one-year spike
  const durable=[.04,.05,.04,.05,.04,.05,.04,.13,.14,.13]; // 3 years at the new level, analysts expect it to hold
  // (4+ elevated years out of 10 already count as the company's normal level and are not reverted at all)
  const six=buildForecast(Object.assign(stock({ticker:'SIX',netPath:[.04,.05,.04,.05,.13,.13,.14,.13,.14,.13],growth:.10}),{sector:'Industrials'}));
  assert(!six.forecastFlags.includes('peak_margin_reversion'),'a 6-year step-up is the new normal, not a peak');
  const a=buildForecast(Object.assign(stock({ticker:'SPK',netPath:spike,growth:.10}),{sector:'Industrials'}));
  const b=buildForecast(Object.assign(stock({ticker:'DUR',netPath:durable,growth:.10,analyst:{n:20,net1:.13,net2:.135}}),{sector:'Industrials'}));
  const pa=a.forecastBridge.margins.peakMarginDiscipline,pb=b.forecastBridge.margins.peakMarginDiscipline;
  assert(pb.durability>pa.durability,'durable boom should score higher: '+pa.durability+' vs '+pb.durability);
  assert(pb.reversionShare<pa.reversionShare,'durable boom should revert less');
  assert(b.rows[9].netMargin>a.rows[9].netMargin,'durable boom keeps more margin: '+a.rows[9].netMargin+' vs '+b.rows[9].netMargin);
  console.log('durability ok',JSON.stringify({spike:{dur:pa.durability,share:pa.reversionShare,y10:+a.rows[9].netMargin.toFixed(3)},durable:{dur:pb.durability,share:pb.reversionShare,yrs:pb.elevatedYears,y10:+b.rows[9].netMargin.toFixed(3)}}));
}
// 13) Young company that lost money for years then turned very profitable: baseline floored at 0
{
  const young=[-.40,-.30,-.25,-.20,-.10,-.05,.02,.09,.16,.23];
  const f=buildForecast(Object.assign(stock({ticker:'YNG',netPath:young,growth:.30,analyst:{n:22,net1:.24,net2:.26}}),{sector:'Technology'}));
  const pm=f.forecastBridge.margins.peakMarginDiscipline;
  assert(f.rows[9].netMargin>.18,'young profitable grower reverted toward start-up losses: '+f.rows[9].netMargin);
  console.log('young grower ok',JSON.stringify({dur:pm.durability,share:+pm.reversionShare.toFixed(3),y10:+f.rows[9].netMargin.toFixed(3)}));
}
// 14) Build 52: one-time charges, backlog, amortization fallback
{
  // a big impairment in the latest year should barely move the projection vs the same company without it
  const clean=stock({ticker:'CLN',netPath:[.10,.10,.11,.10,.10,.11]});
  const hit=stock({ticker:'HIT',netPath:[.10,.10,.11,.10,.10,-.05]});
  const y=hit.financials.years.at(-1);y.goodwillImpairment=y.revenue*.19;y.operatingIncome+=0; // the -5% year was caused by a 19%-of-revenue charge
  const fc=buildForecast(clean),fh=buildForecast(hit);
  assert(Math.abs(fh.rows[0].netMargin-fc.rows[0].netMargin)<.02,'one-time charge leaked into year 1: '+fc.rows[0].netMargin+' vs '+fh.rows[0].netMargin);
  assert(fh.forecastBridge.margins.oneTimeChargesLatest>.18);
  // backlog adds durability to a boom
  const boom=[.04,.05,.04,.05,.04,.05,.04,.08,.11,.13];
  const nb=Object.assign(stock({ticker:'NB',netPath:boom,growth:.15}),{sector:'Industrials'});
  const wb=Object.assign(stock({ticker:'WB',netPath:boom,growth:.15}),{sector:'Industrials'});
  wb.financials.years.at(-2).rpo=wb.financials.years.at(-2).revenue*1.2;wb.financials.years.at(-1).rpo=wb.financials.years.at(-1).revenue*1.6;
  const dn=buildForecast(nb).forecastBridge.margins.peakMarginDiscipline,dw=buildForecast(wb).forecastBridge.margins.peakMarginDiscipline;
  assert(dw.durability>dn.durability&&dw.durabilityEvidence.includes('backlog_over_1x_revenue'),'backlog should add durability');
  // amortization estimated from accumulated amortization when the expense isn't tagged
  const am=stock({ticker:'AM',netPath:[.08,.08,.08,.08,.08]});
  am.financials.years.forEach((yy,i)=>{yy.accumulatedAmortization=1e8*(i+1);});
  const fa=buildForecast(am);assert((fa.rows[0].intangibleAmortizationMargin||0)>0,'amortization fallback not used');
  console.log('build 52 ok',JSON.stringify({noBacklog:dn.durability,withBacklog:dw.durability}));
}
// 15) A company that grew ~8x and only recently got profitable at scale isn't reverted to start-up margins
{
  const yrs=[.02,.03,-.01,.04,.05,.06,.03,.15,.16,.14];
  const st=Object.assign(stock({ticker:'SCL',netPath:yrs,growth:.40}),{sector:'Consumer Discretionary'});
  const f=buildForecast(st),pm=f.forecastBridge.margins.peakMarginDiscipline;
  assert(pm.durabilityEvidence.includes('no_comparable_scale_history')||!pm.applied,'scale check missing');
  assert(f.rows[9].netMargin>.12,'scaled-up company reverted to start-up margins: '+f.rows[9].netMargin);
  // an established cyclical of similar size each year still reverts
  const cyc=Object.assign(stock({ticker:'CYC',netPath:[.04,.05,.04,.05,.04,.05,.04,.08,.11,.13],growth:.05}),{sector:'Industrials'});
  assert(buildForecast(cyc).forecastFlags.includes('peak_margin_reversion'),'established cyclical should still revert');
  console.log('scale check ok');
}
// 16) Zero reversion must not clamp the margin path or touch cash flow (Build 53 regression)
{
  const yrs=[.02,.03,-.01,.04,.05,.06,.03,.15,.16,.14];
  const st=Object.assign(stock({ticker:'SCL2',netPath:yrs,growth:.40}),{sector:'Consumer Discretionary'});
  const base=buildForecast(Object.assign(stock({ticker:'SCL3',netPath:yrs,growth:.40}),{sector:'Technology'}));
  const f=buildForecast(st),pm=f.forecastBridge.margins.peakMarginDiscipline;
  assert.strictEqual(pm.reversionShare,0);
  const m=f.forecastBridge.margins;assert(m.fcfMatureTarget>=m.fcfStart-.03,'cash path cut although no reversion: '+m.fcfStart+' -> '+m.fcfMatureTarget);
  console.log('zero-reversion ok');
}
// 17) Build 54: consensus long-term growth shapes years 3-5 (both directions); thin coverage ignored
{
  const mk=(ltg,n=25)=>{const st=stock({ticker:'LTG',netPath:[.15,.15,.16,.15,.16],growth:.25,analyst:{n,net1:.16,net2:.17}});st.analystEstimates.revenueGrowthCurrentYear=.30;st.analystEstimates.revenueGrowthNextYear=.28;if(ltg!=null)st.analystEstimates.epsGrowthLongTerm=ltg;return buildForecast(st);};
  const base=mk(null),hi=mk(.45),lo=mk(.08),thin=mk(.45,3),thinBase=mk(null,3);
  const g=f=>f.rows.slice(2,5).map(r=>r.revenueGrowth);
  const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  assert(avg(g(hi))>avg(g(base))+.005,'high LTG should raise years 3-5');
  assert(avg(g(lo))<avg(g(base))-.005,'low LTG should lower years 3-5');
  g(thin).forEach((x,i)=>assert(Math.abs(x-g(thinBase)[i])<1e-9,'thin coverage should ignore LTG'));
  assert(hi.forecastBridge.revenue.longTermConsensus.raw===.45);
  for(const f of [hi,lo])f.rows.forEach((r,i)=>{if(i>1)assert(r.revenueGrowth<=f.rows[i-1].revenueGrowth+.01,'growth re-accelerates at year '+(i+1));});
  console.log('LTG ok',JSON.stringify({base:g(base).map(x=>+x.toFixed(3)),hi:g(hi).map(x=>+x.toFixed(3)),lo:g(lo).map(x=>+x.toFixed(3))}));
}
// 18) Build 55: backlog growth evidence and the two-source ceiling
{
  const mk=(opts={})=>{const st=stock({ticker:'BKL',netPath:[.15,.15,.16,.15,.16],growth:.12,analyst:{n:25,net1:.16,net2:.17}});
    st.analystEstimates.revenueGrowthCurrentYear=.38;st.analystEstimates.revenueGrowthNextYear=.36;
    if(opts.ltg!=null)st.analystEstimates.epsGrowthLongTerm=opts.ltg;
    if(opts.rpo){const ys=st.financials.years;ys.at(-2).rpo=ys.at(-2).revenue*opts.rpo[0];ys.at(-1).rpo=ys.at(-1).revenue*opts.rpo[1];}
    return buildForecast(st);};
  const g=f=>f.rows.slice(2,5).map(r=>r.revenueGrowth),avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  const none=mk(),ltgOnly=mk({ltg:.60}),both=mk({ltg:.60,rpo:[1.0,1.8]}),shrink=mk({rpo:[1.6,1.1]});
  assert(none.forecastBridge.revenue.growthCeiling.years3to5===.28,'no evidence keeps the 28% ceiling');
  assert(ltgOnly.forecastBridge.revenue.growthCeiling.years3to5<=.32+1e-9,'one source caps at 32%');
  assert(both.forecastBridge.revenue.growthCeiling.sources>=2&&both.forecastBridge.revenue.growthCeiling.years3to5>.32,'two sources can go higher');
  assert(avg(g(both))>avg(g(ltgOnly)),'backlog growth should add to years 3-5');
  assert(avg(g(shrink))<avg(g(none)),'shrinking backlog should lower years 3-5');
  console.log('backlog ok',JSON.stringify({none:g(none).map(x=>+x.toFixed(3)),ltgOnly:g(ltgOnly).map(x=>+x.toFixed(3)),both:g(both).map(x=>+x.toFixed(3)),shrink:g(shrink).map(x=>+x.toFixed(3))}));
}
// 19) Forecast tracking: snapshot once a month and score old forecasts against reported revenue
{
  const os=require('os'),fs=require('fs'),path=require('path');
  const {trackForecasts}=require('./track-forecasts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ft-'));
  const mkS=(t,yr,rev,g)=>({ticker:t,sector:'Technology',valuationProjection:[{year:yr,revenue:rev*(1+g),revenueGrowth:g},{year:yr+1,revenue:rev*(1+g)**2,revenueGrowth:g}]});
  trackForecasts({stocks:[mkS('AAA',2026,100,.20)]},{dataDir:dir,now:new Date('2026-01-15')});
  // a year later the company reported 2026 revenue of 130 (forecast was 120): model was ~8% too low
  const rep=trackForecasts({stocks:[mkS('AAA',2027,130,.10)]},{dataDir:dir,now:new Date('2027-02-15')});
  assert(rep.snapshots===2&&rep.observations===1,'expected one scored forecast: '+JSON.stringify(rep));
  assert(Math.abs(rep.byHorizon['year 1'].meanError-(130/120-1))<1e-9);
  // same month again does not add a snapshot
  assert(trackForecasts({stocks:[]},{dataDir:dir,now:new Date('2027-02-20')}).snapshots===2);
  console.log('tracking ok');
}
