'use strict';
// Build 29 regression: terminal-growth cap, higher discount rate, price-aware exits, leverage,
// structural-financial routing, 11% hurdle, and the analyst-target sanity check.
const assert=require('assert');
const cfg=require('./engine/config');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');

function stock({ticker='TEST',sector='Technology',price=100,growth=.10,margin=.20,roic=.20,dilution=0,debt=1e9,sic}){
  const years=[];let revenue=8e9,shares=200e6;
  for(let i=0;i<5;i++){revenue*=1+growth;shares*=1+dilution;years.push({year:2021+i,revenue,fcf:revenue*margin,fcfSBCAdjusted:revenue*(margin-.01),ebitda:revenue*(margin+.08),netIncome:revenue*(margin-.03),operatingIncome:revenue*(margin+.05),sharesOutTTM:shares,dilutedEPS:revenue*(margin-.03)/shares,roic,opMargin:margin+.05,totalDebt:debt,cash:1.5e9,dividendPerShare:0,sbcIntensity:.02});}
  return{ticker,sector,sic,financials:{years,dataQuality:{}},analystEstimates:{revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth*.9,numAnalysts:25},growthYear1:growth,price:{current:price},valuation:{dividendYield:0,growthSource:'test'}};
}
const run=s=>{const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);return {f,q,v,d:rateStock(s,f,q,v)};};

// 1) hurdle & caps
assert.strictEqual(cfg.INVESTOR_ALPHA_HURDLE,.11);
assert.strictEqual(cfg.TERMINAL_GROWTH_CAP,.03);
for(const sector of Object.keys(cfg.SECTOR)) assert(cfg.SECTOR[sector].terminalGrowth<=cfg.TERMINAL_GROWTH_CAP,sector+' terminal growth exceeds cap');

// 2) forecast terminal growth never exceeds the cap, even for a hot, high-quality grower
const hot=run(stock({ticker:'HOT',growth:.30,margin:.35,roic:.40}));
assert(hot.f.terminalGrowth<=cfg.TERMINAL_GROWTH_CAP+1e-12,'forecast terminal growth above cap: '+hot.f.terminalGrowth);
for(const m of hot.v.methods) if(m.audit?.terminalGrowth!=null) assert(m.audit.terminalGrowth<=cfg.TERMINAL_GROWTH_CAP+1e-12,'DCF terminal growth above cap');

// 3) intrinsic discount rate band
assert(hot.v.intrinsicDiscountRate>=.095&&hot.v.intrinsicDiscountRate<=.12,'discount rate outside 9.5-12%: '+hot.v.intrinsicDiscountRate);

// 4) structural financials (SIC 60/61/63, or SIC 6798 in Financials) use the earnings/book path, not FCF
for(const sic of ['6022','6141','6331']){
  const fin=run(stock({ticker:'F'+sic,sector:'Financials',sic,growth:.08,margin:.22}));
  assert(fin.v.methods.length>0&&fin.v.methods.every(m=>/EPS exit|Book|Residual/.test(m.name)),sic+' should not use FCF/DCF/EBITDA methods: '+fin.v.methods.map(m=>m.name));
}
const mreit=run(stock({ticker:'MREIT',sector:'Financials',sic:'6798',growth:.03,margin:.30}));
assert(mreit.v.methods.every(m=>/EPS exit|Book|Residual/.test(m.name)),'mortgage REIT must not use FCF/EBITDA methods');
// exchange / payment network SICs keep the operating-company path
const exch=run(stock({ticker:'EXCH',sector:'Financials',sic:'6200',growth:.08,margin:.35}));
assert(exch.v.methods.some(m=>/FCF exit|DCF/.test(m.name)),'exchanges should keep the operating-company path');

// 4b) the financial route must PRODUCE a valuation (regression: SIC-routed insurers were Unrated because the
// archetype weights were not financial)
for(const [sic,sector] of [['6324','Healthcare'],['6331','Financials'],['6022','Financials']]){
  const r=run(stock({ticker:'FV'+sic,sector,sic,growth:.06,margin:.12}));
  assert(Number.isFinite(r.v.expectedCAGR)&&Number.isFinite(r.v.fairValueEstimate),sic+' financial route produced no valuation');
}

// 5) price anchoring is bounded: a stock priced at 3x moves fair value by < 20%, and higher price never raises CAGR
const lo=run(stock({ticker:'LO',price:100})), hi=run(stock({ticker:'HI',price:300}));
assert(Math.abs(hi.v.fairValueEstimate/lo.v.fairValueEstimate-1)<.20,'price anchoring moved fair value too much');
assert(hi.v.expectedCAGR<lo.v.expectedCAGR,'higher price must lower expected CAGR');

// 6) leverage must not create absurd equity multiples: a 6x-levered stock cannot value above 8x its price
const lev=run(stock({ticker:'LEV',price:40,growth:.05,margin:.20,debt:8e10}));
assert(!lev.v.fairValueEstimate||lev.v.fairValueEstimate/40<8,'levered name valued above 8x its price: '+lev.v.fairValueEstimate);

// 7) analyst sanity check present and divergence flagged
const s=stock({ticker:'ANA',price:100}); s.analystEstimates.analystTargetMean=50; s.analystEstimates.numAnalysts=20;
const a=run(s);
assert(a.v.analystCheck&&Number.isFinite(a.v.analystCheck.fairValueToTarget),'analystCheck missing');
const thin=stock({ticker:'THIN',price:100}); thin.analystEstimates.analystTargetMean=50; thin.analystEstimates.numAnalysts=2;
assert.strictEqual(run(thin).v.analystCheck,null,'analyst check needs >=5 analysts');

// 8) a Buy cannot rest on a fair value >2x analyst consensus
const probeV={expectedCAGR:.25,underwrittenCAGR:.20,marginOfSafety:.5,requiredReturnBuyPrice:120,hurdleReturnPrice:150,methodAgreementScore:85,valuationConfidenceScore:85,methods:[{},{},{}],independentMethodCount:3,modelSupport:'standard',analystCheck:{divergence:'model_far_above_analysts'},multipleSensitivity:{down20CAGR:.2}};
const q={qualityScore:85,confidenceScore:85,growthQualityScore:80,moatScore:80,compounderScore:80,pricingPowerScore:80,capitalAllocationScore:80,protectionScore:80};
assert.strictEqual(rateStock({price:{current:100},sector:'Technology'},{forecastReliabilityScore:85},q,probeV).rating,'Watch');
assert.notStrictEqual(rateStock({price:{current:100},sector:'Technology'},{forecastReliabilityScore:85},q,{...probeV,analystCheck:null}).rating,'Watch');
// 9) return-cap path (slow-growth value name with an implausible implied return, e.g. HXL) must keep
// bear <= base <= bull, or run-screener's validation aborts the whole nightly run.
{
  const {validateStock}=require('./engine/validation');
  const mk=price=>{const s=stock({ticker:'CAPPED',sector:'Industrials',price,growth:.025,margin:.18,roic:.15});for(const y of s.financials.years)y.dividendPerShare=.10;return s;};
  let sawCap=false;
  for(const price of [33,36,40,45,50,60,70,100]){
    const {v}=run(mk(price));
    if(v.returnCapApplied){sawCap=true;assert.strictEqual(v.modelSupport,'limited');}
    if(Number.isFinite(v.bearCAGR)&&Number.isFinite(v.baseCAGR)) assert(v.bearCAGR<=v.baseCAGR+1e-9,'bear above base at price '+price);
    if(Number.isFinite(v.bullCAGR)&&Number.isFinite(v.baseCAGR)) assert(v.bullCAGR>=v.baseCAGR-1e-9,'bull below base at price '+price);
  }
  assert(sawCap,'fixture no longer exercises the return-cap path');
}
// ---- Build 30 ----
// 10) SBC is counted once in the EPS lens: dilutive SBC payers get an add-back, buyback-offset payers do not.
{
  const mk=(dilution)=>{const t=stock({ticker:'SBC'+dilution,price:100,growth:.18,margin:.25,roic:.25,dilution});for(const y of t.financials.years){y.sbcIntensity=.15;y.sbc=y.revenue*.15;}return t;};
  const dil=run(mk(.03)), buy=run(mk(-.02));
  const e1=dil.v.methods.find(m=>m.name==='EPS exit')?.audit, e2=buy.v.methods.find(m=>m.name==='EPS exit')?.audit;
  assert(e1&&e1.sbcAddBackFraction>0&&e1.metric>e1.reportedYear10EPS,'dilutive SBC payer got no EPS add-back');
  assert(e2&&e2.sbcAddBackFraction===0&&Math.abs(e2.metric-e2.reportedYear10EPS)<1e-9,'buyback-offset SBC payer must not get an add-back');
}
// 11) analyst cross-check: pulls toward consensus, stays bounded, keeps the pre-blend value, needs >=5 analysts
{
  const base=run(stock({ticker:'AB0',price:100,growth:.12,margin:.22}));
  const withT=(target,n=25,lo,hi)=>{const t=stock({ticker:'AB'+target,price:100,growth:.12,margin:.22});Object.assign(t.analystEstimates,{analystTargetMean:target,numAnalysts:n,analystTargetLow:lo??target*.8,analystTargetHigh:hi??target*1.2});return run(t);};
  const hiT=withT(base.v.fairValueEstimate*6), loT=withT(base.v.fairValueEstimate/6), thin=withT(base.v.fairValueEstimate*6,3);
  assert(hiT.v.fairValueEstimate>base.v.fairValueEstimate,'high consensus did not raise fair value');
  assert(loT.v.fairValueEstimate<base.v.fairValueEstimate,'low consensus did not lower fair value');
  const thinBaseStock=stock({ticker:'AB0',price:100,growth:.12,margin:.22}); thinBaseStock.analystEstimates.numAnalysts=3;
  const thinBase=run(thinBaseStock);   // numAnalysts also feeds the forecast, so compare like with like
  assert(Math.abs(thin.v.fairValueEstimate/thinBase.v.fairValueEstimate-1)<1e-9,'<5 analysts must not move fair value');
  assert(hiT.v.analystCheck.modelFairValue>0&&Math.abs(hiT.v.analystCheck.modelFairValue/base.v.fairValueEstimate-1)<1e-9,'pre-blend model value not preserved');
  const implied=hiT.v.analystCheck.target/(1+hiT.v.intrinsicDiscountRate);
  assert(hiT.v.fairValueEstimate/implied<=2.2+1e-9&&loT.v.fairValueEstimate/(loT.v.analystCheck.target/(1+loT.v.intrinsicDiscountRate))>=.45-1e-9,'blend left the allowed band');
  for(const r of [hiT,loT]){ if(Number.isFinite(r.v.bearCAGR)){assert(r.v.bearCAGR<=r.v.baseCAGR+1e-9&&r.v.bullCAGR>=r.v.baseCAGR-1e-9,'scenarios out of order after blend');}
    assert(require('./engine/validation').validateStock({ticker:'X',currentPrice:100,totalShareholderValue:r.v.totalShareholderValue,expectedReturn:r.v.expectedCAGR,fairValueEstimate:r.v.fairValueEstimate,intrinsicDiscountRate:r.v.intrinsicDiscountRate,marginOfSafety:r.v.marginOfSafety,rating:'Hold'}).length===0,'blended record fails reconciliation'); }
}
// 12) thin analyst coverage must not drive the near-term forecast as hard as a full consensus
{
  const mk=n=>{const t=stock({ticker:'COV'+n,price:100,growth:.10,margin:.20});Object.assign(t.analystEstimates,{revenueGrowthCurrentYear:.40,revenueGrowthNextYear:.45,numAnalysts:n});return run(t);};
  const one=mk(1), many=mk(25);
  assert(one.f.rows[0].revenueGrowth<many.f.rows[0].revenueGrowth,'1-analyst estimate carried as much weight as a 25-analyst consensus');
}
console.log('Build 29 regression passed.');
