'use strict';
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');
const {validateStock}=require('./engine/validation');

function stock({ticker='TEST',sector='Technology',price=100,growth=.10,margin=.20,roic=.20,dividend=0,dilution=0}){
  const years=[];let revenue=8e9,shares=200e6;
  for(let i=0;i<5;i++){revenue*=1+growth;shares*=1+dilution;years.push({year:2021+i,revenue,fcf:revenue*margin,fcfSBCAdjusted:revenue*(margin-.01),ebitda:revenue*(margin+.08),netIncome:revenue*(margin-.03),operatingIncome:revenue*(margin+.05),sharesOutTTM:shares,roic,opMargin:margin+.05,totalDebt:1e9,cash:1.5e9,dividendPerShare:dividend,sbcIntensity:.02});}
  return{ticker,sector,financials:{years,dataQuality:{}},analystEstimates:{revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth*.9,numAnalysts:25},growthYear1:growth,price:{current:price},valuation:{dividendYield:dividend/price,growthSource:'test'}};
}
function run(s){const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q),d=rateStock(s,f,q,v);const pub={ticker:s.ticker,currentPrice:s.price.current,totalShareholderValue:v.totalShareholderValue,expectedReturn:v.expectedCAGR,bearCAGR:v.bearCAGR,baseCAGR:v.baseCAGR,bullCAGR:v.bullCAGR,fairValueEstimate:v.fairValueEstimate,marginOfSafety:v.marginOfSafety,rating:d.rating,methodAgreementScore:v.methodAgreementScore,methodCount:v.methods.length,independentMethodCount:v.independentMethodCount,valuationConfidenceScore:v.valuationConfidenceScore,forecastReliabilityScore:v.forecastReliabilityScore,modelSupport:v.modelSupport};assert.deepStrictEqual(validateStock(pub),[]);assert(v.bearCAGR<=v.baseCAGR&&v.baseCAGR<=v.bullCAGR);assert(Math.abs((1-s.price.current/v.fairValueEstimate)-v.marginOfSafety)<1e-10);return{f,q,v,d};}
const compounder=run(stock({ticker:'COMPOUNDER',price:180,growth:.11,margin:.30,roic:.30,dilution:-.01}));
const expensive=run(stock({ticker:'EXPENSIVE',price:1000,growth:.25,margin:.20,roic:.24,dilution:.02}));
const dividend=run(stock({ticker:'DIVIDEND',sector:'Consumer Staples',price:80,growth:.04,margin:.14,roic:.18,dividend:3}));
assert(Number.isFinite(compounder.v.expectedCAGR));assert(Number.isFinite(expensive.v.expectedCAGR));assert(Number.isFinite(dividend.v.expectedCAGR));

// Forward-looking forecast sanity checks: one-time acquisition-style revenue jumps must
// reset the revenue base without becoming the organic run-rate, and real operating
// leverage is allowed to expand margins when the financial evidence supports it.
const acquisitionLike=stock({ticker:'ACQ',price:100,growth:.04,margin:.14,roic:.18});
acquisitionLike.financials.years.at(-1).revenue*=1.35;
acquisitionLike.financials.years.at(-1).fcfSBCAdjusted*=1.35;
acquisitionLike.financials.years.at(-1).fcf*=1.35;
acquisitionLike.analystEstimates.revenueGrowthCurrentYear=.06;
acquisitionLike.analystEstimates.revenueGrowthNextYear=.05;
acquisitionLike.quarterly=[{end:'2025-03-31',val:100},{end:'2026-03-31',val:105}];
const acqForecast=buildForecast(acquisitionLike);
assert(acqForecast.forecastFlags.includes('structural_revenue_step_up_detected'));
assert(acqForecast.revenueGrowthAnchor<.12,'one-time revenue step-up leaked into forward organic growth');

const leverage=stock({ticker:'LEVERAGE',price:100,growth:.12,margin:.18,roic:.24});
for(let i=0;i<leverage.financials.years.length;i++){
  const y=leverage.financials.years[i], m=.13+i*.018;
  y.fcfSBCAdjusted=y.revenue*m; y.fcf=y.revenue*(m+.01); y.operatingIncome=y.revenue*(m+.07); y.opMargin=m+.07;
}
const levForecast=buildForecast(leverage);
assert(levForecast.marginTargets.fcf>=levForecast.marginAssumptions.fcf,'supported operating leverage should not be forced back to historical margins');


// A very expensive but modelable company must remain rated rather than disappearing as
// Unrated merely because its canonical downside exceeds the old plausibility band.
const extreme=stock({ticker:'EXTREME',price:5000,growth:.12,margin:.18,roic:.22,dilution:.01});
const extremeRun=run(extreme);
assert(Number.isFinite(extremeRun.v.expectedCAGR),'extreme canonical return should still publish');
assert.notStrictEqual(extremeRun.d.rating,'Unrated','modelable extreme valuation should still receive a rating');
assert(Number.isFinite(extremeRun.v.expectedCAGR),'10-year horizon should normalize extreme nominal outcomes into an annualized decision return');
if(extremeRun.v.expectedCAGR>.22||extremeRun.v.expectedCAGR<-.30) assert(extremeRun.v.extremeReturnFlag===true,'extreme annualized return should be explicitly flagged for review');

// Trust-first policy: if a company has no observable positive profitability anchor,
// sales alone may not manufacture a fair value. Coverage is less important than avoiding
// false precision and 30%-100% CAGRs from arbitrary EV/Sales assumptions.
const preProfit=stock({ticker:'PREPROFIT',price:100,growth:.22,margin:.10,roic:.05,dilution:.03});
for(const y of preProfit.financials.years){y.fcf=-Math.abs(y.fcf);y.fcfSBCAdjusted=-Math.abs(y.fcfSBCAdjusted);y.netIncome=-Math.abs(y.netIncome);y.ebitda=-Math.abs(y.ebitda);}
const ppF=buildForecast(preProfit), ppQ=computeQuality(preProfit,ppF), ppV=valuate(preProfit,ppF,ppQ), ppD=rateStock(preProfit,ppF,ppQ,ppV);
assert(!ppV.methods.some(m=>m.name==='EV/Sales fallback'),'unprofitable company received a sales-only valuation');
assert.strictEqual(ppV.expectedCAGR,null,'unanchored sales-only valuation should fail closed');
assert.strictEqual(ppD.rating,'Unrated','unanchored sales-only valuation should not receive a recommendation');


// Pathological upside must never be published as a triple-digit base-case CAGR.
// If normalized economics still imply >45% annually, the valuation is considered
// non-decision-grade instead of clipping the return to an arbitrary number.
const pathological=stock({ticker:'PATHOLOGICAL',price:5,growth:.30,margin:.35,roic:.35,dilution:-.04});
const pathF=buildForecast(pathological), pathQ=computeQuality(pathological,pathF), pathV=valuate(pathological,pathF,pathQ);
assert(Number.isFinite(pathV.expectedCAGR),'modelable pathological upside should remain visible rather than be silently nulled');
assert(pathV.extremeReturnFlag===true,'pathological upside must be flagged for review');

// Financials are valued from normalized EPS, not revenue × margin. This protects
// banks/insurers/multi-class investment companies from accounting-base explosions.
const financial=stock({ticker:'FIN',sector:'Financials',price:100,growth:.18,margin:.30,roic:.18,dilution:-.02});
for(const y of financial.financials.years){ y.dilutedEPS=y.netIncome/y.sharesOutTTM; }
const finF=buildForecast(financial), finQ=computeQuality(financial,finF), finV=valuate(financial,finF,finQ);
assert(finV.methods.every(m=>m.name==='Normalized EPS exit'),'financial valuation should use normalized EPS only');
assert(Number.isFinite(finV.expectedCAGR),'modelable financial valuation should remain visible rather than be silently nulled');

console.log('Model smoke test passed: canonical math, normalized valuation anchors, financial EPS handling, and extreme-upside review flags are internally consistent.');

// Missing capex must not masquerade as free cash flow. The model should keep the FCF
// path unavailable and value the company from other defensible methods instead.
const missingCapex=stock({ticker:'NO_CAPEX',price:100,growth:.10,margin:.18,roic:.20});
for(const y of missingCapex.financials.years){y.cfo=y.fcf;y.capex=null;y.fcf=null;y.fcfSBCAdjusted=null;}
const noCapF=buildForecast(missingCapex), noCapQ=computeQuality(missingCapex,noCapF), noCapV=valuate(missingCapex,noCapF,noCapQ);
assert.strictEqual(noCapF.marginAssumptions.fcf,null,'missing capex should not create a synthetic FCF margin');
assert(!noCapV.methods.some(m=>m.name==='FCF exit'),'missing capex should not feed an FCF valuation method');
assert(Number.isFinite(noCapV.expectedCAGR),'other valuation methods should keep a modelable company rated');

// SBC is reflected through dilution/quality, not subtracted a second time from the FCF
// margin used for valuation. This prevents double-counting the same shareholder cost.
const sbcHeavy=stock({ticker:'SBC',price:100,growth:.14,margin:.20,roic:.20,dilution:.04});
for(const y of sbcHeavy.financials.years){y.fcfSBCAdjusted=y.fcf-y.revenue*.12;y.sbcIntensity=.12;}
const sbcF=buildForecast(sbcHeavy);
assert(sbcF.marginAssumptions.fcf>0.15,'SBC-adjusted FCF was incorrectly used as the operating cash margin');

console.log('Normalization smoke tests passed: missing-capex FCF is suppressed and SBC is not double-counted.');

// Temporary investment-cycle capex should not permanently destroy normalized FCF when
// CFO and operating economics remain intact. The model must retain a real reinvestment
// burden, but fade an abnormal capex spike instead of extrapolating it forever.
const capexCycle=stock({ticker:'CAPEX_CYCLE',price:100,growth:.10,margin:.20,roic:.22});
for(let i=0;i<capexCycle.financials.years.length;i++){
  const y=capexCycle.financials.years[i];
  y.cfo=y.revenue*.28;
  y.capex=y.revenue*(i===capexCycle.financials.years.length-1?.24:.08);
  y.fcf=y.cfo-y.capex;
  y.operatingIncome=y.revenue*.23;
  y.opMargin=.23;
}
const capexF=buildForecast(capexCycle);
assert(capexF.forecastFlags.includes('abnormal_capex_cycle_normalized'),'abnormal capex cycle was not detected');
assert(capexF.forecastBridge.margins.cycleNormalizedFCFMargin>capexF.forecastBridge.margins.reportedFCFMargin+.05,'capex normalization did not restore sustainable FCF economics');
assert(capexF.marginTargets.fcf>capexF.forecastBridge.margins.reportedFCFMargin,'temporary capex spike leaked into year-5 FCF margin');

// Near-term analyst inflections may anchor years 1-2, but years 4-5 must increasingly
// revert toward normalized company growth rather than treating a temporary burst as a
// permanent new regime.
const inflection=stock({ticker:'INFLECTION_FADE',price:100,growth:.09,margin:.20,roic:.22});
inflection.analystEstimates.revenueGrowthCurrentYear=.34;
inflection.analystEstimates.revenueGrowthNextYear=.38;
inflection.analystEstimates.numAnalysts=35;
const inflectionF=buildForecast(inflection);
assert(inflectionF.forecastBridge.revenue.terminalOperatingGrowth<.16,'near-term analyst inflection was carried too aggressively into year 5');
assert(inflectionF.rows[4].revenueGrowth<inflectionF.rows[1].revenueGrowth-.08,'post-inflection growth path did not fade materially after explicit analyst years');

console.log('Cycle-normalization smoke tests passed: abnormal capex is normalized and post-inflection growth fades after explicit consensus years.');

// The capex-cycle normalizer must preserve a larger reinvestment burden for faster
// growers. This is the key guardrail against simply re-labeling all excess capex as free.
const fastCapex=stock({ticker:'FAST_CAPEX',price:100,growth:.22,margin:.20,roic:.24});
for(let i=0;i<fastCapex.financials.years.length;i++){
  const y=fastCapex.financials.years[i];
  y.cfo=y.revenue*.30; y.da=y.revenue*.07;
  y.capex=y.revenue*(i===fastCapex.financials.years.length-1?.25:.09);
  y.fcf=y.cfo-y.capex; y.operatingIncome=y.revenue*.24; y.opMargin=.24;
}
const fastCapexF=buildForecast(fastCapex);
assert(fastCapexF.forecastBridge.margins.growthReinvestmentShare>.30,'high-growth capex cycle did not retain enough growth reinvestment');
assert(fastCapexF.forecastBridge.margins.normalizedCapexMargin>fastCapexF.forecastBridge.margins.maintenanceCapexMargin,'growth capex was incorrectly normalized all the way to maintenance');

// High growth plus stable/improving operating evidence should not mechanically produce
// material margin contraction just because the historical median is lower than today.
const growthProfit=stock({ticker:'GROWTH_PROFIT',price:100,growth:.20,margin:.16,roic:.25});
for(let i=0;i<growthProfit.financials.years.length;i++){
  const y=growthProfit.financials.years[i], nm=.08+i*.012;
  y.netIncome=y.revenue*nm; y.operatingIncome=y.revenue*(nm+.08); y.opMargin=nm+.08;
  y.grossMargin=.48+i*.006;
}
growthProfit.analystEstimates.revenueGrowthCurrentYear=.24;
growthProfit.analystEstimates.revenueGrowthNextYear=.21;
const gpF=buildForecast(growthProfit);
assert(gpF.forecastFlags.includes('growth_profitability_consistency_guardrail'),'profitability consistency guardrail did not activate');
assert(gpF.marginTargets.net>=gpF.marginAssumptions.net-.0076,'high-growth forecast compressed supported net margins too aggressively');

console.log('Reinvestment and profitability-consistency smoke tests passed.');

// V7 method-selection tests. GAAP EPS should lose influence when cash economics are
// materially stronger, without any ticker-specific rule.
const cashVsEarnings=stock({ticker:'CASH_VS_EARNINGS',price:100,growth:.18,margin:.24,roic:.25});
for(const y of cashVsEarnings.financials.years){
  y.fcf=y.revenue*.24; y.fcfSBCAdjusted=y.fcf; y.netIncome=y.revenue*.08; y.ebitda=y.revenue*.28;
}
const cveF=buildForecast(cashVsEarnings), cveQ=computeQuality(cashVsEarnings,cveF), cveV=valuate(cashVsEarnings,cveF,cveQ);
const cveFcf=cveV.methods.find(m=>m.name==='FCF exit'), cveEps=cveV.methods.find(m=>m.name==='EPS exit');
assert(cveFcf&&cveEps,'cash/earnings divergence test needs both FCF and EPS methods');
assert(cveEps.reliability<cveFcf.reliability,'EPS should be downweighted when cash earnings materially exceed accounting earnings');

// Fast-growing financials still use a financial-specific EPS framework, but the generic
// growth-financial path may compound earnings faster than a mature bank/insurer path.
const growthFin=stock({ticker:'GROWTH_FIN',sector:'Financials',price:40,growth:.22,margin:.15,roic:.16,dilution:.02});
for(const y of growthFin.financials.years){y.dilutedEPS=Math.max(.35,y.netIncome/y.sharesOutTTM);}
growthFin.analystEstimates.revenueGrowthCurrentYear=.25; growthFin.analystEstimates.revenueGrowthNextYear=.22;
const gfF=buildForecast(growthFin), gfQ=computeQuality(growthFin,gfF), gfV=valuate(growthFin,gfF,gfQ);
assert(gfV.methods.every(m=>m.name==='Normalized EPS exit'),'growth financial should remain on the financial-specific valuation path');
assert(gfV.methods[0]?.audit?.epsGrowth<=.20,'growth-financial EPS convergence exceeded generic cap');

console.log('V7 method-reliability smoke tests passed.');

// V11.5 exit-multiple differentiation ---------------------------------------
// Terminal multiples should reflect durable company economics rather than collapsing
// every non-financial company toward the same sector-normal multiple.
const eliteExit=stock({ticker:'ELITE_EXIT',price:100,growth:.16,margin:.30,roic:.32,dilution:-.01});
const ordinaryExit=stock({ticker:'ORDINARY_EXIT',price:100,growth:.07,margin:.14,roic:.13,dilution:.02});
const eeF=buildForecast(eliteExit),eeQ=computeQuality(eliteExit,eeF),eeV=valuate(eliteExit,eeF,eeQ);
const oeF=buildForecast(ordinaryExit),oeQ=computeQuality(ordinaryExit,oeF),oeV=valuate(ordinaryExit,oeF,oeQ);
for(const name of ['FCF exit','EPS exit','EV/EBITDA exit']){
  const eliteM=eeV.methods.find(m=>m.name===name)?.audit?.exitMultiple;
  const ordinaryM=oeV.methods.find(m=>m.name===name)?.audit?.exitMultiple;
  assert(Number.isFinite(eliteM)&&Number.isFinite(ordinaryM),`${name} differentiation test needs both multiples`);
  assert(eliteM>ordinaryM+2,`${name} failed to preserve a meaningful premium for superior durable economics`);
}
assert(eeV.methods.find(m=>m.name==='FCF exit').audit.exitMultiple>=17,'elite FCF terminal multiple remained mechanically over-conservative');
assert(oeV.methods.find(m=>m.name==='FCF exit').audit.exitMultiple<=17,'ordinary business received an excessive FCF terminal multiple');
console.log('V11.5 exit-multiple tests passed: durable growth/quality premiums differentiate terminal valuations.');

// V10 trust invariants -------------------------------------------------------
// 1) Intrinsic value cannot follow the quote. Repricing the exact same business must
// change expected return, not the modeled fair value.
const priceA=stock({ticker:'PRICE_INVARIANT',price:100,growth:.12,margin:.22,roic:.24,dilution:.00});
const priceB=JSON.parse(JSON.stringify(priceA)); priceB.price.current=200;
const pAF=buildForecast(priceA), pAQ=computeQuality(priceA,pAF), pAV=valuate(priceA,pAF,pAQ);
const pBF=buildForecast(priceB), pBQ=computeQuality(priceB,pBF), pBV=valuate(priceB,pBF,pBQ);
assert(Number.isFinite(pAV.fairValueEstimate)&&Number.isFinite(pBV.fairValueEstimate),'price-invariance test requires fair values');
assert(Math.abs(pAV.fairValueEstimate/pBV.fairValueEstimate-1)<1e-10,'intrinsic fair value changed when only current price changed');
assert(pBV.expectedCAGR<pAV.expectedCAGR,'higher current price did not reduce expected CAGR');

// 2) More dilution cannot improve per-share value for otherwise identical economics.
const lowDil=stock({ticker:'LOW_DIL',price:100,growth:.14,margin:.20,roic:.22,dilution:0});
const highDil=stock({ticker:'HIGH_DIL',price:100,growth:.14,margin:.20,roic:.22,dilution:.05});
const ldF=buildForecast(lowDil),ldQ=computeQuality(lowDil,ldF),ldV=valuate(lowDil,ldF,ldQ);
const hdF=buildForecast(highDil),hdQ=computeQuality(highDil,hdF),hdV=valuate(highDil,hdF,hdQ);
assert(hdV.fairValueEstimate<ldV.fairValueEstimate,'higher dilution increased intrinsic per-share value');

// 3) Weak/short historical growth cannot overpower clear forward consensus slowdown.
const weakHistory=stock({ticker:'WEAK_HISTORY',price:100,growth:.30,margin:.16,roic:.18});
weakHistory.financials.years=weakHistory.financials.years.slice(-3);
weakHistory.analystEstimates.revenueGrowthCurrentYear=.01;
weakHistory.analystEstimates.revenueGrowthNextYear=.04;
weakHistory.analystEstimates.numAnalysts=12;
const whF=buildForecast(weakHistory);
assert(whF.historyReliability<.65,'short volatile history received excessive reliability');
assert(whF.year5OperatingGrowth<=.09,'weak history overrode clear forward slowdown');

// 4) A business type that needs specialized metrics we do not collect must not receive a
// buy recommendation from a generic model.
const realEstate=stock({ticker:'REAL_ESTATE_LIMIT',sector:'Real Estate',price:100,growth:.08,margin:.25,roic:.12,dilution:.01});
const reF=buildForecast(realEstate),reQ=computeQuality(realEstate,reF),reV=valuate(realEstate,reF,reQ),reD=rateStock(realEstate,reF,reQ,reV);
assert.strictEqual(reV.modelSupport,'limited','real-estate model support was not flagged limited');
assert(!['Buy','Strong Buy','Exceptional Buy'].includes(reD.rating),'limited-support business received a buy rating');

// 5) Evidence count constrains confidence. Correlated FCF and DCF are one evidence family,
// not two independent confirmations.
const evidence=stock({ticker:'EVIDENCE',price:100,growth:.12,margin:.20,roic:.22});
const evF=buildForecast(evidence),evQ=computeQuality(evidence,evF),evV=valuate(evidence,evF,evQ);
assert(evV.independentMethodCount<=evV.methods.length,'independent evidence count exceeded method count');
if(evV.independentMethodCount===1)assert(evV.valuationConfidenceScore<=68,'single evidence family received excessive valuation confidence');

console.log('V10 trust invariants passed: price independence, dilution monotonicity, weak-history fade, specialized-model guardrails, and evidence-count confidence are enforced.');


// V11/V11.4 cash-flow reconciliation invariants -----------------------------
// DCF includes the explicit owner-cash-flow stream. FCF-exit is intentionally an
// exit-only multiple method so interim FCF is not counted once as distributable cash
// and again through the future per-share denominator. Dividends are therefore added
// only to the exit-only method, while DCF must not add them a second time.
const cashRecon=stock({ticker:'CASH_RECON',price:100,growth:.10,margin:.20,roic:.22,dividend:3});
const crF=buildForecast(cashRecon),crQ=computeQuality(cashRecon,crF),crV=valuate(cashRecon,crF,crQ);
const crExit=crV.methods.find(m=>m.name==='FCF exit'), crDCF=crV.methods.find(m=>m.name==='10Y DCF');
assert(crExit&&crDCF,'cash-flow reconciliation test requires FCF exit and DCF methods');
assert(!Number.isFinite(crExit?.audit?.pvExplicit),'FCF exit should not contain an explicit FCF stream');
assert(Number.isFinite(crExit?.audit?.terminalExitValue)&&crExit.audit.terminalExitValue>0,'FCF exit did not expose its terminal exit value');
assert(crExit?.cashFlowInclusive===false&&crDCF?.cashFlowInclusive===true,'cash-flow inclusion flags are inconsistent with method construction');
assert(crExit?.audit?.dividendOutcomeAdded>0&&crDCF?.audit?.dividendOutcomeAdded===0,'dividend treatment is inconsistent across exit-only and DCF methods');
assert(crV.presentValueDividends>0&&crV.terminalDividendValue>crV.cumulativeDividends,'interim dividends were not time-valued consistently');
console.log('V11/V11.4 cash-flow reconciliation invariants passed: DCF preserves explicit FCF, FCF exit is exit-only, and dividends are not double-counted.');

// V11.1 share-denominator reconciliation invariants --------------------------
const { shareDenominatorLooksSuspicious, reconcileSharesWithLiveMarketCap } = require('./data-fetchers');
const brokenShareYears=[
  {year:2024,revenue:4.0e9,netIncome:2.0e8,sharesOutTTM:300000,dilutedEPS:2.0},
  {year:2025,revenue:5.0e9,netIncome:2.5e8,sharesOutTTM:350000,dilutedEPS:2.2},
];
assert(shareDenominatorLooksSuspicious(brokenShareYears,50),'obviously tiny share denominator was not flagged');
const shareFix=reconcileSharesWithLiveMarketCap(brokenShareYears,50,{marketCapitalization:15000}); // $15B => 300M shares
assert(shareFix.reliable===true&&shareFix.applied===true,'live market-cap reconciliation did not repair broken shares');
assert(Math.abs(brokenShareYears.at(-1).sharesOutTTM-300e6)<1,'reconciled latest share count is wrong');
assert(brokenShareYears[0].sharesOutTTM>200e6,'historical share series was not rebased with the repaired denominator');
assert(!shareDenominatorLooksSuspicious(brokenShareYears,50),'repaired denominator still looks suspicious');

const saneShareYears=[{year:2025,revenue:10e9,sharesOutTTM:100e6,dilutedEPS:5}];
assert(!shareDenominatorLooksSuspicious(saneShareYears,100),'sane denominator was falsely flagged');
const saneFix=reconcileSharesWithLiveMarketCap(saneShareYears,100,{marketCapitalization:10200});
assert(saneFix.applied===false&&saneFix.reliable===true,'ordinary live/SEC timing difference should not trigger a rebase');

// Valuation must fail closed when the denominator audit fails.
const badDenom=stock({ticker:'BAD_DENOM',price:50,growth:.15,margin:.20,roic:.20});
badDenom.financials.dataQuality={shareDenominatorReliable:false};
const bdF=buildForecast(badDenom),bdQ=computeQuality(badDenom,bdF),bdV=valuate(badDenom,bdF,bdQ);
assert.strictEqual(bdV.methods.length,0,'unreconciled share denominator was allowed into valuation');
assert.strictEqual(bdV.modelSupport,'unsupported','unreconciled share denominator should fail closed');
assert.strictEqual(bdV.expectedCAGR,null,'unreconciled share denominator published an expected CAGR');
console.log('Share-denominator reconciliation tests passed: scale errors are repaired and unreconciled cases fail closed.');


// V11.2 SEC period-year and economic-scope invariants ------------------------
const { parseAnnualFinancials } = require('./data-fetchers');
// Companyfacts `fy` is the filing fiscal year and is repeated on comparative facts.
// The parser must key annual history by each fact's period end, otherwise a 2025 10-K
// can overwrite 2025 economics with the 2024 comparative column.
const fakeFacts={facts:{'us-gaap':{
  RevenueFromContractWithCustomerExcludingAssessedTax:{units:{USD:[
    {form:'10-K',fy:2025,fp:'FY',start:'2024-01-01',end:'2024-12-31',filed:'2026-02-15',val:900},
    {form:'10-K',fy:2025,fp:'FY',start:'2025-01-01',end:'2025-12-31',filed:'2026-02-15',val:1000},
  ]}},
  NetIncomeLoss:{units:{USD:[
    {form:'10-K',fy:2025,fp:'FY',start:'2024-01-01',end:'2024-12-31',filed:'2026-02-15',val:90},
    {form:'10-K',fy:2025,fp:'FY',start:'2025-01-01',end:'2025-12-31',filed:'2026-02-15',val:120},
  ]}},
  WeightedAverageNumberOfDilutedSharesOutstanding:{units:{shares:[
    {form:'10-K',fy:2025,fp:'FY',start:'2024-01-01',end:'2024-12-31',filed:'2026-02-15',val:90e6},
    {form:'10-K',fy:2025,fp:'FY',start:'2025-01-01',end:'2025-12-31',filed:'2026-02-15',val:100e6},
  ]}},
  EarningsPerShareDiluted:{units:{'USD/shares':[
    {form:'10-K',fy:2025,fp:'FY',start:'2024-01-01',end:'2024-12-31',filed:'2026-02-15',val:1},
    {form:'10-K',fy:2025,fp:'FY',start:'2025-01-01',end:'2025-12-31',filed:'2026-02-15',val:1.2},
  ]}},
},dei:{}}};
const parsedYears=parseAnnualFinancials(fakeFacts,10);
assert(parsedYears.some(y=>y.year===2024&&y.revenue===900),'comparative 2024 fact was assigned to filing FY instead of period year');
assert(parsedYears.some(y=>y.year===2025&&y.revenue===1000),'current 2025 fact was lost to comparative overwrite');

// Healthcare insurers / premium businesses use financial-like EPS valuation rather than
// treating reserve-driven CFO as ordinary industrial free cash flow.
const insurerLike=stock({ticker:'INSURER_LIKE',sector:'Healthcare',price:100,growth:.08,margin:.12,roic:.16});
insurerLike.financials.dataQuality={financialLikeRevenue:true};
for(const y of insurerLike.financials.years){y.dilutedEPS=Math.max(.5,y.netIncome/y.sharesOutTTM);}
const ilF=buildForecast(insurerLike),ilQ=computeQuality(insurerLike,ilF),ilV=valuate(insurerLike,ilF,ilQ);
assert(ilV.methods.length>0&&ilV.methods.every(m=>m.name==='Normalized EPS exit'),'financial-like non-financial-sector company leaked into FCF/DCF valuation');

// A material NCI ownership mismatch must suppress whole-enterprise FCF/EBITDA methods.
const nciCo=stock({ticker:'NCI_SCOPE',sector:'Industrials',price:50,growth:.10,margin:.20,roic:.18});
nciCo.financials.dataQuality={materialNoncontrollingInterest:true};
for(const y of nciCo.financials.years){y.dilutedEPS=Math.max(.5,y.netIncome/y.sharesOutTTM);}
const ncF=buildForecast(nciCo),ncQ=computeQuality(nciCo,ncF),ncV=valuate(nciCo,ncF,ncQ);
assert(!ncV.methods.some(m=>['FCF exit','EV/EBITDA exit','10Y DCF'].includes(m.name)),'material NCI allowed whole-enterprise economics to be divided by parent shares');

console.log('V11.2 trust tests passed: SEC comparative-year mapping, financial-like valuation scope, and NCI ownership scope are enforced.');

// V11.3 return-integrity invariant: a slow-growth value/dividend business may not publish
// a heroic CAGR that depends primarily on re-rating rather than modeled economics.
const slowValue=stock({ticker:'SLOW_VALUE_RETURN_GATE',sector:'Industrials',price:8,growth:.025,margin:.18,roic:.15,dividend:.10});
slowValue.analystEstimates.revenueGrowthCurrentYear=.025; slowValue.analystEstimates.revenueGrowthNextYear=.03;
const svF=buildForecast(slowValue),svQ=computeQuality(slowValue,svF),svV=valuate(slowValue,svF,svQ);
if(svV.returnDecompositionFailure){assert.strictEqual(svV.expectedCAGR,null,'unsupported slow-growth return leaked into published CAGR');assert.strictEqual(svV.modelSupport,'unsupported','return-integrity failure was not marked unsupported');}
console.log('V11.3 return-integrity gate passed.');

// V11.4 cash-flow valuation integrity ---------------------------------------
// Buybacks must not create value twice inside a DCF. Aggregate operating FCF is the
// economic cash flow; a smaller future share count is a use of that cash, not a second
// independent source of intrinsic value.
const dcfNoBuyback=stock({ticker:'DCF_NO_BUYBACK',price:100,growth:.12,margin:.22,roic:.24,dilution:0});
const dnbF=buildForecast(dcfNoBuyback),dnbQ=computeQuality(dcfNoBuyback,dnbF),dnbV=valuate(dcfNoBuyback,dnbF,dnbQ);
// Isolate the denominator effect instead of creating a second company whose historical
// dilution also changes forecast growth/quality inputs. Keep the exact same operating FCF
// in every year, shrink only the future ownership denominator, and recompute FCF/share.
const dbF={...dnbF,rows:dnbF.rows.map((r,i)=>{
  const shares=r.shares*Math.pow(.96,i+1);
  return {...r,shares,fcfPerShare:r.fcf/shares};
})};
const dbV=valuate(dcfNoBuyback,dbF,dnbQ);
const dnbDCF=dnbV.methods.find(m=>m.name==='10Y DCF'), dbDCF=dbV.methods.find(m=>m.name==='10Y DCF');
assert(dnbDCF&&dbDCF,'DCF buyback-integrity test requires both DCF methods');
assert(Number.isFinite(dnbDCF.audit.pvExplicit)&&Number.isFinite(dbDCF.audit.pvExplicit),'DCF audit must expose explicit PV');
// Identical aggregate FCF must produce identical explicit DCF value even when forecast
// shares fall and FCF/share rises. This is the exact double-counting bug V11.4 prevents.
assert(Math.abs(dbDCF.audit.pvExplicit-dnbDCF.audit.pvExplicit)<1e-9,'buyback path mechanically inflated DCF explicit cash flows');

// FCF exit is an exit-only method. It must not capitalize year-10 FCF and then add the
// same decade of FCF as though all of it were an extra distribution.
const exitIntegrity=stock({ticker:'FCF_EXIT_INTEGRITY',price:100,growth:.12,margin:.22,roic:.24,dilution:-.02});
const eiF=buildForecast(exitIntegrity),eiQ=computeQuality(exitIntegrity,eiF),eiV=valuate(exitIntegrity,eiF,eiQ);
const eiExit=eiV.methods.find(m=>m.name==='FCF exit');
assert(eiExit,'FCF exit integrity test requires FCF exit method');
assert.strictEqual(eiExit.audit.pvExplicit,undefined,'FCF exit still includes explicit-period FCF');
assert.strictEqual(eiExit.cashFlowInclusive,false,'FCF exit must be treated as exit-only so dividends can be added separately');

// Generic financials with only normalized EPS evidence remain visible for research but
// cannot present that one-method estimate as decision-grade support.
assert.strictEqual(gfV.modelSupport,'limited','single-method financial valuation was not downgraded to limited support');
assert(gfV.valuationConfidenceScore<=50,'single-method financial valuation retained excessive confidence');

console.log('V11.4 valuation-integrity smoke tests passed: DCF buyback double-counting removed, FCF exit is exit-only, and generic financials fail closed to limited support.');
