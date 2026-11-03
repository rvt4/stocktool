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
console.log('Build 29 regression passed.');
