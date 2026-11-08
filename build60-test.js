'use strict';
// Build 60: share-basis repair from split events (IESC 2:1 on 2026-08-14 was missed).
const assert=require('assert');
const {applySplitEvents}=require('./data-fetchers');

const mkYears=()=>[2023,2024,2025].map((year,i)=>({year,sharesOutTTM:20e6,dilutedEPS:8+i,dividendPerShare:0,netIncome:(8+i)*20e6}));

// (a) IESC: latest SEC share fact filed 2026-08-01 (pre-split), split 2:1 on 2026-08-14.
{
  const y=mkYears();
  const r=applySplitEvents(y,{value:20.1e6,filed:'2026-08-01',end:'2026-06-30'},[{date:'2026-08-14',ratio:2}],false);
  assert(r.applied&&r.factor===2,'post-filing split not applied');
  assert.strictEqual(y.at(-1).sharesOutTTM,40e6,'shares not doubled');
  assert(Math.abs(y.at(-1).dilutedEPS-5)<1e-9,'EPS not halved');
  assert.strictEqual(y.at(-1).netIncome,10*20e6,'dollar totals must not change');
}
// (b) split between the last annual year and a post-split 10-Q (3:2), below the old 3.5x rule.
{
  const y=mkYears();
  const r=applySplitEvents(y,{value:30.2e6,filed:'2026-05-05',end:'2026-03-31'},[{date:'2025-11-20',ratio:1.5}],false);
  assert(r.applied&&r.factor===1.5,'annual-vs-10Q split not applied');
  assert.strictEqual(y.at(-1).sharesOutTTM,30.2e6,'latest 10-Q denominator not used');
  assert(Math.abs(y[0].sharesOutTTM-30e6)<1,'older years not rebased');
}
// (c) no split in the window, or an old split already reflected in SEC data: no change.
{
  const y=mkYears();
  assert(!applySplitEvents(y,{value:20e6,filed:'2026-08-01'},[{date:'2021-06-01',ratio:2}],false).applied,'old split re-applied');
  assert(!applySplitEvents(y,{value:20e6,filed:'2026-08-01'},[],false).applied,'no-split case changed data');
  assert.strictEqual(y.at(-1).sharesOutTTM,20e6);
}
// (d) a large split already handled by the >=3.5x normalizer is not applied twice for case (b).
{
  const y=mkYears(); y.forEach(x=>x.sharesOutTTM*=25);
  const r=applySplitEvents(y,{value:500e6,filed:'2026-05-05'},[{date:'2026-01-10',ratio:25}],true);
  assert(!r.applied,'already-normalized split applied twice');
}
console.log('Build 60 split-event tests passed');

// (e) acquisition detector: consensus revenue jump with lagging EPS on a slow-growing history.
{
  const {consensusCorporateAction}=require('./engine/rating-engine');
  const years=[0,1,2,3,4,5].map(i=>({revenue:20e9*Math.pow(.98,i)}));
  assert(consensusCorporateAction({financials:{years},analystEstimates:{revenueGrowthCurrentYear:.18,epsGrowthCurrentYear:-.10,revenueGrowthNextYear:.70,epsGrowthNextYear:.05}}),'KMB-style deal not detected');
  // organic boom: EPS grows faster than revenue -> not an acquisition
  assert(!consensusCorporateAction({financials:{years},analystEstimates:{revenueGrowthCurrentYear:.51,epsGrowthCurrentYear:.94,revenueGrowthNextYear:.83,epsGrowthNextYear:1.18}}),'organic boom flagged as M&A');
  console.log('Build 60 corporate-action detector tests passed');
}

// (f) automatic completed-deal detection from SEC 8-K Item 2.01 (no manual list).
{
  const {detectFilingCorporateAction}=require('./data-fetchers');
  const sub=(rows)=>({filings:{recent:{form:rows.map(r=>r[0]),filingDate:rows.map(r=>r[1]),items:rows.map(r=>r[2]||''),reportDate:rows.map(r=>r[3]||r[1])}}});
  const asOf=new Date('2026-11-08');
  // Modine: 10-K May 2026, 10-Q Aug, 8-K 2.01 Oct 1 (spin-off), 10-Q Nov -> still pending until next 10-K
  const mod=detectFilingCorporateAction(sub([['10-K','2026-05-21'],['10-Q','2026-08-05'],['8-K','2026-10-01','1.01,2.01,5.02,9.01','2026-10-01'],['10-Q','2026-11-04']]),asOf);
  assert(mod.pending&&mod.events[0].filed==='2026-10-01','Modine spin-off not detected');
  // deal reported before the latest 10-K: history already reflects it
  assert(!detectFilingCorporateAction(sub([['8-K','2026-01-10','2.01'],['10-K','2026-02-20']]),asOf).pending,'stale deal still held');
  // 8-Ks without Item 2.01 are ignored
  assert(!detectFilingCorporateAction(sub([['10-K','2026-02-20'],['8-K','2026-06-01','2.02,9.01']]),asOf).pending,'earnings 8-K treated as a deal');
  const {rateStock}=require('./engine/rating-engine');
  const d=rateStock({ticker:'X',price:{current:100},sector:'Industrials',filingCorporateAction:mod},{forecastReliabilityScore:80},{qualityScore:80,confidenceScore:80},{expectedCAGR:.2,marginOfSafety:.3,requiredReturnBuyPrice:150,hurdleReturnPrice:170,methods:[1,2,3],independentMethodCount:3,methodAgreementScore:80,underwrittenCAGR:.16});
  assert.strictEqual(d.rating,'Watch','filed corporate action did not hold the rating');
  console.log('Build 60b SEC 8-K corporate-action tests passed');
}

// (g) Build 60c guards: non-standard "split" ratios (spin-off price adjustments) are ignored, and a
// repair that moves EPS away from consensus is undone.
{
  const y1=mkYears();
  const r1=applySplitEvents(y1,{value:20e6,filed:'2026-05-01'},[{date:'2026-06-02',ratio:6.6667}],false,1.07);
  assert(!r1.applied&&y1.at(-1).sharesOutTTM===20e6,'CTVA-style spin-off adjustment treated as a split');
  const y2=mkYears(); // latest EPS 10 already matches consensus 10.5
  const r2=applySplitEvents(y2,{value:20e6,filed:'2026-05-01'},[{date:'2026-06-02',ratio:3}],false,10.5);
  assert(!r2.applied&&r2.rejectedByConsensus&&y2.at(-1).sharesOutTTM===20e6&&y2.at(-1).dilutedEPS===10,'consensus-contradicted split not undone');
  const y3=mkYears(); // IESC: EPS 10 pre-split, consensus 5.8 -> repair to 5 is closer
  assert(applySplitEvents(y3,{value:20e6,filed:'2026-08-01'},[{date:'2026-08-14',ratio:2}],false,5.8).applied,'valid split rejected');
  console.log('Build 60c split guard tests passed');
}
