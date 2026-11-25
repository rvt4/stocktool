'use strict';
// Build 97: research page summary data (engine/research-data.js) and wording (research-summary.js).
const assert=require('assert');
const R=require('./engine/research-data');
const RS=require('./research-summary');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');

// --- Technical zones on seeded noisy price paths
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647-.5;};
const walk=(drift,n=400)=>{let p=100;return Array.from({length:n},(_,i)=>{p*=1+drift(i)+rnd()*0.03;return {date:'2026-01-01',close:p};});};
assert.strictEqual(R.technical(walk(()=>.0012)).zone,'buy','steady uptrend near its 50-day = buy zone');
assert.strictEqual(R.technical(walk(i=>i<380?.0005:.012)).zone,'extended','late rally = extended');
assert.strictEqual(R.technical(walk(()=>-.0012)).trend,'down');
assert.strictEqual(R.technical(walk(()=>.001,150)).available,false,'needs 210 days');
assert.strictEqual(R.rsi(Array(30).fill(5)),50,'flat prices = RSI 50');
assert(R.rsi(Array.from({length:30},(_,i)=>i))>99);
{const t=R.technical(walk(()=>.0012),150);assert(Math.abs(t.price-150)<1e-9,'uses the live price when given');}

// --- Earnings: quarterly revenue vs the same quarter a year earlier; last 4 reports kept
{const e=R.earnings({financials:{years:[{year:2025,revenue:100,dilutedEPS:2,netIncome:10}]},quarterly:[{end:'2025-03-31',val:100},{end:'2026-03-31',val:110},{end:'2026-06-30',val:120}]},
  {earningsHistory:[1,2,3,4,5].map(i=>({quarter:'2026-0'+i,actual:i,estimate:i}))});
 assert.strictEqual(e.quarterlyRevenue.length,1);assert(Math.abs(e.quarterlyRevenue[0].growth-.1)<1e-9);
 assert.strictEqual(e.reports.length,4);assert.strictEqual(e.annual[0].netMargin,.1);}

// --- Estimates: falls back to the 90-day fields when the extras column is empty
{const x=R.estimates({epsCurrentYear:10,epsCurrentYear90dAgo:9.5,epsNextYear:11,epsNextYear90dAgo:12},null);
 assert(Math.abs(x.thisYear.d90-(.5/9.5))<1e-3);assert(x.nextYear.d90<0);assert.strictEqual(x.revisions30,null);}
{const x=R.estimates({},{epsTrend:{'0y':{current:10,'7daysAgo':10,'30daysAgo':9,'90daysAgo':8}},epsRevisions:{'0y':{up30:5,down30:1},'+1y':{up30:2,down30:0}},
  ratings:[{period:'0m',strongBuy:2,buy:2,hold:4,sell:0,strongSell:0},{period:'-3m',strongBuy:1,buy:1,hold:6,sell:0,strongSell:0}]});
 assert.strictEqual(x.thisYear.d30,.1111);assert.deepStrictEqual(x.revisions30,{up:7,down:1});assert.strictEqual(x.ratingsNow.buyShare,.5);assert.strictEqual(x.ratings3mAgo.buyShare,.25);}

// --- Scenarios: bear < base < bull on growth, margin and exit multiple; returns come from the record
{const years=[];let revenue=8e9;const shares=200e6;
 for(let i=0;i<5;i++){revenue*=1.12;years.push({year:2021+i,revenue,fcf:revenue*.22,fcfSBCAdjusted:revenue*.21,ebitda:revenue*.3,netIncome:revenue*.19,operatingIncome:revenue*.27,sharesOutTTM:shares,dilutedEPS:revenue*.19/shares,roic:.2,opMargin:.27,totalDebt:1e9,cash:1.5e9,dividendPerShare:0,sbcIntensity:.02});}
 const st={ticker:'T97',sector:'Technology',financials:{years,dataQuality:{}},analystEstimates:{revenueGrowthCurrentYear:.12,numAnalysts:20,researchExtras:{}},growthYear1:.12,price:{current:150},valuation:{dividendYield:0,growthSource:'t'}};
 const f=buildForecast(st),q=computeQuality(st,f),v=valuate(st,f,q);
 const rec={bearCAGR:v.bearCAGR,baseCAGR:v.baseCAGR,bullCAGR:v.bullCAGR};
 const d=R.researchData(st,f,v,rec),sc=d.scenarios;
 assert(sc.bear.revenueGrowth<sc.base.revenueGrowth&&sc.base.revenueGrowth<sc.bull.revenueGrowth);
 assert(sc.bear.operatingMargin<sc.base.operatingMargin&&sc.base.operatingMargin<sc.bull.operatingMargin);
 assert(sc.bear.exitPE<sc.base.exitPE&&sc.base.exitPE<sc.bull.exitPE);
 assert(sc.bear.cagr<=sc.base.cagr&&sc.base.cagr<=sc.bull.cagr);
 assert.strictEqual(d.technical.available,false);
 // Display only: building research data must not change the valuation.
 const v2=valuate(st,buildForecast(st),computeQuality(st,buildForecast(st)));assert.strictEqual(v2.fairValueEstimate,v.fairValueEstimate);}

// --- Pros/cons wording
{const s={ticker:'X',qualityScore:90,revenueCAGR3:.15,revenueGrowthTTM:.08,growth:{revAccel:-.04},underwrittenCAGR:.13,expectedCAGR:.15,bearCAGR:.09,
  currentPrice:100,analystCheck:{target:130},netDebtNow:-2e9,marketCap:20e9,research:{estimates:{thisYear:{d90:-.05}},earnings:{reports:[{actual:1,estimate:1.1},{actual:1,estimate:1.2},{actual:1,estimate:.9},{actual:1,estimate:.9}]},technical:{available:true,trend:'down',fromHigh:-.3}}};
 const pc=RS.prosCons(s);
 assert(pc.pros[0].startsWith('Even the cautious case'),'strongest pro first: '+pc.pros[0]);
 assert(pc.cons.some(c=>/slowing/.test(c)));assert(pc.cons.some(c=>/cut this year's EPS estimate 5\.0%/.test(c)));
 assert(pc.cons.some(c=>/Missed EPS estimates in 2 of the last 4/.test(c)));assert(pc.cons.some(c=>/30% below its 52-week high/.test(c)));
 assert(pc.pros.length<=5&&pc.cons.length<=5);
 assert(!pc.cons.join(' ').includes('--'),'no double minus signs');}
{const v=RS.verdict({research:{technical:{available:true,zone:'extended',sma50:90}}},true,'');assert.strictEqual(v.tone,'warn');assert(/\$90/.test(v.text));
 assert.strictEqual(RS.verdict({},false,'Not on the buy list: rank 40').head,'Not on the buy list');}
{const u=RS.prosCons({modelSupport:'unsupported',modelSupportReason:'The model can’t value this',revenueGrowthTTM:-.1});assert(/can.t value/.test(u.cons[0]),'unsupported leads the cons');}
console.log('build97 tests passed');
