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
function run(s){const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q),d=rateStock(s,f,q,v);const pub={ticker:s.ticker,currentPrice:s.price.current,totalShareholderValue:v.totalShareholderValue,expectedReturn:v.expectedCAGR,bearCAGR:v.bearCAGR,baseCAGR:v.baseCAGR,bullCAGR:v.bullCAGR,fairValueEstimate:v.fairValueEstimate,intrinsicDiscountRate:v.intrinsicDiscountRate,hurdleReturnPrice:v.hurdleReturnPrice,requiredReturnBuyPrice:v.requiredReturnBuyPrice,marginOfSafety:v.marginOfSafety,rating:d.rating,methodAgreementScore:v.methodAgreementScore,methodCount:v.methods.length,independentMethodCount:v.independentMethodCount,valuationConfidenceScore:v.valuationConfidenceScore,forecastReliabilityScore:v.forecastReliabilityScore,modelSupport:v.modelSupport};assert.deepStrictEqual(validateStock(pub),[]);assert(v.bearCAGR<=v.baseCAGR&&v.baseCAGR<=v.bullCAGR);assert(Math.abs(Math.max(0,1-s.price.current/v.fairValueEstimate)-v.marginOfSafety)<1e-10);return{f,q,v,d};}
const compounder=run(stock({ticker:'COMPOUNDER',price:180,growth:.11,margin:.30,roic:.30,dilution:-.01}));
const expensive=run(stock({ticker:'EXPENSIVE',price:1000,growth:.25,margin:.20,roic:.24,dilution:.02}));
const dividend=run(stock({ticker:'DIVIDEND',sector:'Consumer Staples',price:80,growth:.04,margin:.14,roic:.18,dividend:3}));
assert(Number.isFinite(compounder.v.expectedCAGR));assert(Number.isFinite(expensive.v.expectedCAGR));assert(Number.isFinite(dividend.v.expectedCAGR));
for(const sample of [compounder.v,expensive.v,dividend.v]){
  for(const m of sample.methods){
    assert(Math.abs(m.audit.fairValueToday-m.outcome/Math.pow(1+sample.intrinsicDiscountRate,10))<1e-8,'method fair value does not use intrinsic discount rate');
    assert(Math.abs(m.audit.hurdleValueToday-m.outcome/Math.pow(1+.15,10))<1e-8,'method hurdle value does not use 15% hurdle rate');
  }
  assert(Math.abs(sample.requiredReturnBuyPrice-sample.hurdleReturnPrice*.80)<1e-10,'20% MOS buy price does not reconcile to hurdle price');
}

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
financial.financials.dataQuality={financialLikeRevenue:true};
for(const y of financial.financials.years){ y.dilutedEPS=y.netIncome/y.sharesOutTTM; }
const finF=buildForecast(financial), finQ=computeQuality(financial,finF), finV=valuate(financial,finF,finQ);
assert(finV.methods.every(m=>m.name==='Normalized EPS exit'),'financial valuation should use normalized EPS only');
assert(Number.isFinite(finV.expectedCAGR),'modelable financial valuation should remain visible rather than be silently nulled');

// Payment networks can be classified in the Financials sector by market-data vendors, but
// their revenue/FCF economics are ordinary operating-company economics. Sector alone must
// not suppress margins or force normalized-EPS-only valuation.
const paymentNetwork=stock({ticker:'PAYNET',sector:'Financials',price:100,growth:.11,margin:.32,roic:.30,dilution:-.01});
paymentNetwork.financials.dataQuality={financialLikeRevenue:false};
for(const y of paymentNetwork.financials.years){y.cfo=y.fcf+y.revenue*.02;y.capex=y.revenue*.02;y.dilutedEPS=y.netIncome/y.sharesOutTTM;}
const payF=buildForecast(paymentNetwork),payQ=computeQuality(paymentNetwork,payF),payV=valuate(paymentNetwork,payF,payQ);
assert(Number.isFinite(payF.rows[0].fcfMargin)&&Number.isFinite(payF.rows[0].netMargin),'payment-network margins were incorrectly suppressed by sector label');
assert(payV.methods.some(m=>m.name!=='Normalized EPS exit'),'payment network was incorrectly forced into specialized-financial valuation');

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
assert(cveV.valuationArchetype==='cash-conversion-divergence','cash/earnings divergence should select the divergence archetype');
assert(cveFcf,'cash/earnings divergence should retain a reliable cash-flow lens');
assert(!cveEps || cveEps.reliability<cveFcf.reliability,'weak accounting-EPS evidence should be excluded or carry less reliability than FCF');

// Fast-growing financials still use a financial-specific EPS framework, but the generic
// growth-financial path may compound earnings faster than a mature bank/insurer path.
const growthFin=stock({ticker:'GROWTH_FIN',sector:'Financials',price:40,growth:.22,margin:.15,roic:.16,dilution:.02});
growthFin.financials.dataQuality={financialLikeRevenue:true};
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
assert(oeV.methods.find(m=>m.name==='FCF exit').audit.exitMultiple<=22,'ordinary business exceeded the intended low-20s FCF terminal-multiple ceiling');
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

// V11.6 coherent margin-engine invariants -----------------------------------
// A high-quality platform in a temporary capex buildout should be allowed to improve
// operating/net margins while FCF recovers as excess capex fades. No ticker override is
// used; the result must come from operating leverage + cash-conversion evidence.
const platform=stock({ticker:'PLATFORM_MARGIN',sector:'Consumer Discretionary',price:200,growth:.12,margin:.08,roic:.20,dilution:0});
{
  const ops=[.075,.085,.095,.105,.115], ebs=[.16,.17,.18,.19,.20], nets=[.07,.078,.085,.095,.105], cfos=[.13,.14,.15,.16,.17], caps=[.06,.065,.07,.10,.14];
  for(let i=0;i<platform.financials.years.length;i++){
    const y=platform.financials.years[i];
    y.operatingIncome=y.revenue*ops[i]; y.opMargin=ops[i]; y.ebitda=y.revenue*ebs[i]; y.netIncome=y.revenue*nets[i];
    y.cfo=y.revenue*cfos[i]; y.capex=y.revenue*caps[i]; y.fcf=y.revenue*(cfos[i]-caps[i]); y.da=y.revenue*.055; y.grossMargin=.46;
  }
  platform.analystEstimates.revenueGrowthCurrentYear=.15; platform.analystEstimates.revenueGrowthNextYear=.14;
  platform.analystEstimates.epsGrowthCurrentYear=.22; platform.analystEstimates.epsGrowthNextYear=.20; platform.analystEstimates.numAnalysts=50;
}
const platformF=buildForecast(platform), pmb=platformF.forecastBridge.margins;
assert(platformF.forecastFlags.includes('abnormal_capex_cycle_normalized'),'temporary capex buildout was not detected');
assert(pmb.operatingMatureTarget>pmb.operatingStart,'supported operating leverage failed to improve mature operating margin');
assert(pmb.netMatureTarget>=pmb.netStart,'net margin contradicted supported operating leverage');
assert(pmb.capexMatureTarget<pmb.capexStart,'temporary excess capex failed to normalize over the decade');
assert(pmb.fcfMatureTarget>pmb.fcfTarget&&pmb.fcfTarget>pmb.fcfStart,'FCF did not recover as the investment cycle normalized');
for(const r of platformF.rows){
  assert(Math.abs(r.fcfMargin-(r.cfoMargin-r.capexMargin))<1e-10,'FCF margin is no longer CFO minus capex');
}

// One weak recent profitability period must not automatically become a decade of severe
// margin erosion when the company is still growing and the broader evidence is mixed.
const noisyCompression=stock({ticker:'NOISY_COMPRESSION',sector:'Consumer Staples',price:40,growth:.18,margin:.10,roic:.14,dilution:.02});
{
  const ops=[.10,.095,.09,.075,.068], ebs=[.105,.10,.095,.073,.068], nets=[.055,.05,.045,.032,.026], cfos=[.14,.13,.12,.13,.135], caps=[.025,.02,.02,.018,.008], gross=[.52,.515,.51,.505,.50];
  for(let i=0;i<noisyCompression.financials.years.length;i++){
    const y=noisyCompression.financials.years[i];
    y.operatingIncome=y.revenue*ops[i]; y.opMargin=ops[i]; y.ebitda=y.revenue*ebs[i]; y.netIncome=y.revenue*nets[i];
    y.cfo=y.revenue*cfos[i]; y.capex=y.revenue*caps[i]; y.fcf=y.revenue*(cfos[i]-caps[i]); y.grossMargin=gross[i]; y.da=y.revenue*.005;
  }
  noisyCompression.analystEstimates.revenueGrowthCurrentYear=.26; noisyCompression.analystEstimates.revenueGrowthNextYear=.084;
  noisyCompression.analystEstimates.epsGrowthCurrentYear=.20; noisyCompression.analystEstimates.epsGrowthNextYear=.10;
}
const noisyF=buildForecast(noisyCompression), ncb=noisyF.forecastBridge.margins;
assert(ncb.operatingMatureTarget>=ncb.operatingStart-.012,'mixed evidence caused excessive decade-long operating margin compression');
assert(ncb.netMatureTarget>=ncb.netStart-.012,'mixed evidence caused excessive decade-long net margin compression');

console.log('V11.6 coherent margin-engine tests passed: profitability, cash conversion, and capex now reconcile to one operating model.');

// V11.8 structural capital-light cash-conversion invariants -----------------
// A persistently high-FCF, low-capex software-like business should not have its
// cash margin mechanically cut in half merely because FCF sits above accounting
// EBITDA/net margins. The premium must be multi-year and cash-backed, not a one-off.
const structuralCash=stock({ticker:'STRUCTURAL_CASH',sector:'Technology',price:100,growth:.22,margin:.48,roic:.30,dilution:.025});
{
  const fcfs=[.43,.46,.49,.52,.55], cfos=[.455,.485,.515,.545,.575], caps=[.025,.025,.025,.025,.025];
  const ops=[.18,.19,.20,.21,.22], ebs=[.22,.23,.24,.25,.26], nets=[.16,.17,.18,.19,.20];
  for(let i=0;i<structuralCash.financials.years.length;i++){
    const y=structuralCash.financials.years[i];
    y.fcf=y.revenue*fcfs[i]; y.cfo=y.revenue*cfos[i]; y.capex=y.revenue*caps[i];
    y.operatingIncome=y.revenue*ops[i]; y.opMargin=ops[i]; y.ebitda=y.revenue*ebs[i]; y.netIncome=y.revenue*nets[i];
    y.da=y.revenue*.015; y.grossMargin=.80;
  }
  structuralCash.analystEstimates.revenueGrowthCurrentYear=.28;
  structuralCash.analystEstimates.revenueGrowthNextYear=.22;
  structuralCash.analystEstimates.epsGrowthCurrentYear=.35;
  structuralCash.analystEstimates.epsGrowthNextYear=.28;
}
const structuralCashF=buildForecast(structuralCash), scb=structuralCashF.forecastBridge.margins;
assert(structuralCashF.forecastFlags.includes('structural_capital_light_cash_conversion'),'persistent capital-light cash conversion was not recognized');
assert(scb.fcfCeiling>.45,'persistent capital-light economics remained trapped by the generic technology FCF ceiling');
assert(structuralCashF.rows.at(-1).fcfMargin>=scb.reportedFCFMargin*.72,'persistent capital-light FCF margin was mechanically cut roughly in half');
assert(structuralCashF.rows.at(-1).fcfMargin>.35,'structural high cash conversion faded to an implausibly ordinary mature margin');

// A single FCF spike with otherwise ordinary history must NOT earn the structural
// exemption. This preserves the CELH-style working-capital normalization behavior.
const transientCash=stock({ticker:'TRANSIENT_CASH',sector:'Consumer Staples',price:40,growth:.12,margin:.10,roic:.15,dilution:.01});
{
  const fcfs=[.08,.09,.09,.10,.24], cfos=[.11,.12,.12,.13,.27], caps=[.03,.03,.03,.03,.03];
  const ebs=[.10,.10,.10,.10,.11], nets=[.05,.05,.05,.05,.055];
  for(let i=0;i<transientCash.financials.years.length;i++){
    const y=transientCash.financials.years[i];
    y.fcf=y.revenue*fcfs[i]; y.cfo=y.revenue*cfos[i]; y.capex=y.revenue*caps[i];
    y.operatingIncome=y.revenue*.08; y.opMargin=.08; y.ebitda=y.revenue*ebs[i]; y.netIncome=y.revenue*nets[i]; y.da=y.revenue*.02;
  }
}
const transientCashF=buildForecast(transientCash);
assert(!transientCashF.forecastFlags.includes('structural_capital_light_cash_conversion'),'one-off cash spike incorrectly earned structural cash-conversion treatment');
assert(transientCashF.rows.at(-1).fcfMargin<.20,'one-off cash spike leaked into mature FCF economics');

console.log('V11.8 structural cash-conversion tests passed: persistent capital-light FCF is preserved while one-off cash spikes still normalize.');

// V11.10 valuation-evidence and share-denominator invariants ----------------
// Missing SEC share tags must not make a profitable company unrateable when recent
// net income and diluted EPS imply a coherent ownership denominator.
const epsShareFallback=stock({ticker:'EPS_SHARE_FALLBACK',price:120,growth:.18,margin:.26,roic:.28,dilution:.02});
for(const y of epsShareFallback.financials.years){
  y.dilutedEPS=y.netIncome/y.sharesOutTTM;
  y.sharesOutTTM=null;
  y.cfo=y.fcf+y.revenue*.025;
  y.capex=y.revenue*.025;
}
const esfF=buildForecast(epsShareFallback),esfQ=computeQuality(epsShareFallback,esfF),esfV=valuate(epsShareFallback,esfF,esfQ);
assert(esfF.startShares>0,'EPS-implied share denominator was not reconstructed');
assert.strictEqual(esfF.shareCountSource,'earnings_per_share_implied','share fallback did not disclose its evidence source');
assert(esfV.methods.length>=2,'share fallback failed to restore ordinary valuation methods');
assert(Number.isFinite(esfV.expectedCAGR),'share fallback still left a modelable company unrateable');

// With three or more methods, no single method or duplicate cash-flow family may dominate
// simply because the others disagree. Reliability and agreement still matter, but the
// canonical estimate must remain genuinely corroborated.
const balanced=stock({ticker:'BALANCED_METHODS',price:100,growth:.14,margin:.24,roic:.27,dilution:-.01});
for(const y of balanced.financials.years){y.cfo=y.fcf+y.revenue*.03;y.capex=y.revenue*.03;y.dilutedEPS=y.netIncome/y.sharesOutTTM;}
const balF=buildForecast(balanced),balQ=computeQuality(balanced,balF),balV=valuate(balanced,balF,balQ);
const balWeights=Object.values(balV.canonicalMethodWeights||{});
if(balWeights.length>=3)assert(Math.max(...balWeights)<=.451,'one valuation method still dominates a multi-method canonical estimate');
const cashWeight=(balV.canonicalMethodWeights?.['FCF exit']||0)+(balV.canonicalMethodWeights?.['10Y DCF']||0);
if(balWeights.length>=3)assert(cashWeight<=.581,'correlated FCF methods still dominate the canonical estimate as independent evidence');

// Forecast bridge targets must describe the rows that are actually valued. Correcting a
// target FCF margin without synchronizing CFO used to leave the displayed target and the
// cash-flow path on different economic stories.
const coherentCash=stock({ticker:'COHERENT_CASH',price:80,growth:.15,margin:.16,roic:.22,dilution:.01});
for(let i=0;i<coherentCash.financials.years.length;i++){
  const y=coherentCash.financials.years[i];
  y.cfo=y.revenue*(.18+i*.005); y.capex=y.revenue*.035; y.fcf=y.cfo-y.capex;
  y.operatingIncome=y.revenue*(.12+i*.004); y.opMargin=.12+i*.004;
  y.ebitda=y.revenue*(.15+i*.004); y.netIncome=y.revenue*(.075+i*.003);
}
const cohF=buildForecast(coherentCash),cmb=cohF.forecastBridge.margins;
assert(Math.abs(cmb.fcfTarget-(cmb.cfoTarget-cmb.capexTarget))<1e-10,'year-5 FCF target diverges from CFO minus capex');
assert(Math.abs(cmb.fcfMatureTarget-(cmb.cfoMatureTarget-cmb.capexMatureTarget))<1e-10,'mature FCF target diverges from CFO minus capex');

console.log('V11.10 evidence-balance tests passed: share fallback restores coverage, method concentration is capped, and cash-margin targets reconcile to valued rows.');

// V11.11 cash-path integrity invariants ------------------------------------
// The company-specific FCF ceiling selected by the margin engine must also be the ceiling
// used by the annual rows. This catches the old downstream cfg.maxFCFMargin clamp that
// silently turned a 50%+ Visa-like cash margin into 35% in the actual valuation path.
assert(Math.abs(structuralCashF.rows.at(-1).fcfMargin-scb.fcfMatureTarget)<1e-10,
  'year-10 FCF row does not equal the mature FCF target actually published by the margin engine');
assert(structuralCashF.rows.at(-1).fcfMargin>.35,
  'company-specific high-FCF ceiling was overwritten by the generic sector cap in annual rows');

// After transient cash spikes have already been normalized, years 6-10 may not invent a
// second large cash-margin collapse unless capex or operating-profitability evidence says
// the business is structurally becoming more cash intensive / less profitable.
const highCashNoCompression=stock({ticker:'HIGH_CASH_NO_COMPRESSION',sector:'Technology',price:100,growth:.20,margin:.34,roic:.25,dilution:.02});
{
  const fcfs=[.30,.35,.39,.42,.43], cfos=[.35,.40,.44,.47,.48], caps=[.05,.05,.05,.05,.05];
  const ops=[.17,.18,.19,.20,.21], ebs=[.22,.23,.24,.25,.26], nets=[.15,.16,.17,.18,.19];
  for(let i=0;i<highCashNoCompression.financials.years.length;i++){
    const y=highCashNoCompression.financials.years[i];
    y.fcf=y.revenue*fcfs[i]; y.cfo=y.revenue*cfos[i]; y.capex=y.revenue*caps[i];
    y.operatingIncome=y.revenue*ops[i]; y.opMargin=ops[i]; y.ebitda=y.revenue*ebs[i]; y.netIncome=y.revenue*nets[i];
    y.da=y.revenue*.02; y.grossMargin=.75;
  }
  highCashNoCompression.analystEstimates.revenueGrowthCurrentYear=.25;
  highCashNoCompression.analystEstimates.revenueGrowthNextYear=.20;
  highCashNoCompression.analystEstimates.epsGrowthCurrentYear=.30;
  highCashNoCompression.analystEstimates.epsGrowthNextYear=.25;
}
const hcnF=buildForecast(highCashNoCompression), hcnB=hcnF.forecastBridge.margins;
assert(!hcnB.broadCashCompressionEvidence,'no-compression fixture unexpectedly generated structural cash-compression evidence');
assert(hcnB.fcfMatureTarget>=Math.max(hcnB.fcfTarget*.90,hcnB.fcfTarget-.035)-1e-10,
  'mature FCF was mechanically compressed without economic evidence');
assert(Math.abs(hcnF.rows.at(-1).fcfMargin-hcnB.fcfMatureTarget)<1e-10,
  'annual row path diverges from the mature cash-margin target');

console.log('V11.11 cash-path integrity tests passed: row ceilings match margin targets and unexplained mature FCF compression is blocked.');


// V11.18 earnings/FCF coherence regression ---------------------------------
// A growing company with improving accounting margins and no rising capex burden must not
// show a large long-run FCF-margin collapse. This is the exact failure mode that produced
// contradictory AMD/CELH/ELF-style forecasts.
const improvingEconomics=stock({ticker:'IMPROVING_ECONOMICS',sector:'Technology',price:100,growth:.18,margin:.16,roic:.24,dilution:.01});
{
  const ops=[.12,.125,.13,.135,.14], ebs=[.15,.155,.16,.165,.17], nets=[.08,.085,.09,.095,.10];
  const fcfs=[.145,.15,.155,.16,.165], caps=[.035,.035,.034,.034,.033];
  for(let i=0;i<improvingEconomics.financials.years.length;i++){
    const y=improvingEconomics.financials.years[i];
    y.operatingIncome=y.revenue*ops[i]; y.opMargin=ops[i]; y.ebitda=y.revenue*ebs[i]; y.netIncome=y.revenue*nets[i];
    y.capex=y.revenue*caps[i]; y.fcf=y.revenue*fcfs[i]; y.cfo=y.fcf+y.capex; y.da=y.revenue*.025; y.grossMargin=.55;
  }
  improvingEconomics.analystEstimates.revenueGrowthCurrentYear=.22;
  improvingEconomics.analystEstimates.revenueGrowthNextYear=.18;
  improvingEconomics.analystEstimates.epsGrowthCurrentYear=.25;
  improvingEconomics.analystEstimates.epsGrowthNextYear=.20;
}
const ieF=buildForecast(improvingEconomics), ieB=ieF.forecastBridge.margins;
assert(ieB.netMatureTarget>=ieB.netStart-.002,'improving-economics fixture lost accounting profitability unexpectedly');
assert(ieB.fcfMatureTarget>=ieB.fcfStart-.015-1e-10,
  'FCF margin still collapses while net/EBITDA margins improve and capex burden does not rise');
assert(Math.abs(ieF.rows.at(-1).fcfMargin-ieB.fcfMatureTarget)<1e-10,
  'year-10 FCF row diverges from the coherent mature FCF target');

console.log('V11.18 FCF-coherence test passed: improving operating economics can no longer coexist with unexplained cash-margin collapse.');

// V11.19 cash-path shape regression -----------------------------------------
// Stable/improving accounting economics with no heavier capex must not create a
// deep year-5 FCF trough followed by a recovery. This catches the CELH/ELF-style
// U-shape even when the terminal FCF margin eventually looks reasonable.
const smoothCash=stock({ticker:'SMOOTH_CASH_PATH',sector:'Consumer Staples',price:40,growth:.16,margin:.10,roic:.18,dilution:.02});
{
  const yrs=smoothCash.financials.years;
  const fcfs=[.095,.10,.105,.108,.11], nets=[.045,.048,.050,.052,.054], eb=[.085,.087,.089,.091,.093], caps=[.028,.028,.027,.027,.026];
  for(let i=0;i<yrs.length;i++){
    const y=yrs[i];
    y.netIncome=y.revenue*nets[i]; y.ebitda=y.revenue*eb[i]; y.operatingIncome=y.revenue*(eb[i]-.015);
    y.capex=y.revenue*caps[i]; y.fcf=y.revenue*fcfs[i]; y.cfo=y.fcf+y.capex; y.da=y.revenue*.018; y.grossMargin=.48;
  }
}
const smoothCashF=buildForecast(smoothCash);
const scRows=smoothCashF.rows.map(r=>r.fcfMargin).filter(Number.isFinite);
const scStart=smoothCashF.forecastBridge.margins.fcfStart;
assert(scRows.length===10,'smooth cash regression did not produce a full FCF path');
assert(Math.min(...scRows)>=scStart-.03-1e-10,'FCF path still contains an unexplained deep mid-forecast trough');
for(const r of smoothCashF.rows){
  assert(Math.abs(r.cfoMargin-r.capexMargin-r.fcfMargin)<1e-10,'row CFO-capex no longer reconciles to directly modeled FCF');
}
console.log('V11.19 cash-path regression passed: stable economics cannot generate an unexplained FCF U-shape.');

// V12 spreadsheet-style operating model ------------------------------------
// High-growth companies with observable gross-margin / R&D / SG&A structure should
// receive operating leverage through explicit expense-ratio modeling, and recurring
// SBC + acquired-intangible amortization should bridge GAAP earnings to the normalized
// investor earnings used for EPS valuation while dilution remains modeled separately.
const spreadsheetLike=stock({ticker:'SPREADSHEET',price:100,growth:.15,margin:.18,roic:.24,dilution:.01});
for(let i=0;i<spreadsheetLike.financials.years.length;i++){
  const y=spreadsheetLike.financials.years[i];
  const gross=.49+i*.01, rd=.24-i*.004, sga=.10-i*.002, other=.04;
  y.grossProfit=y.revenue*gross; y.grossMargin=gross;
  y.researchAndDevelopment=y.revenue*rd;
  y.sellingGeneralAdministrative=y.revenue*sga;
  y.operatingIncome=y.revenue*(gross-rd-sga-other); y.opMargin=y.operatingIncome/y.revenue;
  y.sbc=y.revenue*.05; y.sbcIntensity=.05;
  y.intangibleAmortization=y.revenue*(.06-i*.004);
  y.pretaxIncome=y.netIncome/.85; y.incomeTaxExpense=y.pretaxIncome*.15;
  y.cfo=y.revenue*.24; y.capex=y.revenue*.03; y.fcf=y.cfo-y.capex;
}
spreadsheetLike.analystEstimates={revenueGrowthCurrentYear:.35,revenueGrowthNextYear:.30,epsGrowthCurrentYear:.50,epsGrowthNextYear:.40,numAnalysts:30};
const ssF=buildForecast(spreadsheetLike);
assert(ssF.forecastFlags.includes('spreadsheet_operating_driver_model'),'explicit expense-ratio operating model did not activate');
assert(ssF.forecastFlags.includes('normalized_earnings_bridge'),'normalized earnings bridge did not activate');
assert(ssF.forecastBridge.margins.operatingTarget>ssF.forecastBridge.margins.operatingStart,'high-growth operating leverage failed to expand operating margin');
assert(ssF.forecastBridge.margins.netTarget>ssF.forecastBridge.margins.gaapNetTarget,'normalized earnings did not exceed GAAP earnings despite recurring SBC/amortization');
assert(ssF.rows[0].gaapEps<ssF.rows[0].eps,'forecast did not expose separate GAAP and normalized EPS');
assert(ssF.rows[4].intangibleAmortizationMargin<ssF.rows[0].intangibleAmortizationMargin,'legacy intangible amortization did not fade as a percentage of revenue');
console.log('V12 spreadsheet-operating-model tests passed: expense leverage and normalized earnings bridge are active and auditable.');


// V12.1 malformed SEC driver tags must fail closed rather than create impossible economics.
const malformedDrivers=stock({ticker:'BADDRIVER',price:100,growth:.12,margin:.15,roic:.18,dilution:.01});
for(const y of malformedDrivers.financials.years){
  y.grossProfit=y.revenue*.25; y.grossMargin=.25;
  y.researchAndDevelopment=y.revenue*.05;
  y.sellingGeneralAdministrative=y.revenue*.58;
  y.operatingIncome=y.revenue*.10; y.opMargin=.10;
}
const badDriverF=buildForecast(malformedDrivers);
assert(badDriverF.forecastFlags.includes('partial_operating_driver_data_rejected'),'non-reconciling expense tags did not fail closed');
assert(!badDriverF.forecastFlags.includes('spreadsheet_operating_driver_model'),'non-reconciling expense tags incorrectly activated spreadsheet driver model');
assert.strictEqual(badDriverF.forecastBridge.margins.rdMarginStart,null,'rejected driver set still exposed R&D as a modeled driver');
assert.strictEqual(badDriverF.forecastBridge.margins.sgaMarginStart,null,'rejected driver set still exposed SG&A as a modeled driver');

// Extreme SBC should receive only a partial normalized-earnings add-back and retain a
// meaningful mature dilution burden.
const heavySbc=stock({ticker:'HEAVYSBC',price:100,growth:.20,margin:.20,roic:.20,dilution:.05});
for(const y of heavySbc.financials.years){ y.sbc=y.revenue*.20; y.sbcIntensity=.20; }
const heavySbcF=buildForecast(heavySbc);
assert(heavySbcF.forecastBridge.margins.earningsNormalizationAddbackStart<.13,'extreme SBC received an excessive normalized-earnings add-back');
assert(heavySbcF.matureDilutionRate>.005,'extreme SBC faded to an implausibly trivial mature dilution rate');
console.log('V12.1 reconciliation tests passed: malformed operating tags fail closed and extreme SBC remains economically charged.');

// V12.3 coherent terminal economics and transition uncertainty ----------------
const coherentCase=stock({ticker:'COHERENT',price:100,growth:.14,margin:.22,roic:.24,dilution:.00});
const v123CohF=buildForecast(coherentCase),v123CohQ=computeQuality(coherentCase,v123CohF),v123CohV=valuate(coherentCase,v123CohF,v123CohQ);
for(const name of ['FCF exit','EPS exit','EV/EBITDA exit']){
  const method=v123CohV.methods.find(m=>m.name===name);
  assert(method&&Number.isFinite(method.audit.coherentMultipleReference),`${name} missing mature-economics coherence reference`);
}
assert(Number.isFinite(v123CohV.methodDispersionRatio)&&v123CohV.methodDispersionRatio>=1,'method dispersion was not surfaced for valuation confidence');

const transitionCase=stock({ticker:'TRANSITION',price:100,growth:.24,margin:.20,roic:.25,dilution:.00});
transitionCase.analystEstimates.revenueGrowthCurrentYear=.35;
transitionCase.analystEstimates.revenueGrowthNextYear=.30;
const v123TrF=buildForecast(transitionCase),v123TrQ=computeQuality(transitionCase,v123TrF),v123TrV=valuate(transitionCase,v123TrF,v123TrQ);
assert(v123TrV.methods.some(m=>(m.audit?.reliabilityReasons||[]).includes('years_6_10_transition_dependence')),'terminal methods did not recognize years 6-10 transition dependence');

const sbcGuard=stock({ticker:'SBC_GUARD',price:100,growth:.25,margin:.25,roic:.25,dilution:.05});
for(const y of sbcGuard.financials.years){
  y.sbcIntensity=.22;y.sbc=y.revenue*.22;y.grossProfit=y.revenue*.85;y.researchAndDevelopment=y.revenue*.15;y.sellingGeneralAdministrative=y.revenue*.25;y.operatingIncome=y.revenue*.25;y.netIncome=y.revenue*.18;y.ebitda=y.revenue*.30;
}
const v123SgF=buildForecast(sbcGuard);
const v123Mb=v123SgF.forecastBridge.margins;
assert(v123Mb.netMatureTarget<=Math.max(v123Mb.gaapNetMatureTarget+.051,v123Mb.operatingMatureTarget+.071),'normalized mature margin escaped structural profitability guardrail');
console.log('V12.3 tests passed: terminal methods share coherent economics, transition dependence lowers reliability, and normalized mature margins remain structurally bounded.');


// V12.6 separated discount-rate architecture ---------------------------------
// The investor hurdle rate is a buy-price requirement; it must not be reused as the DCF
// discount rate for growth/hyper-growth businesses. Intrinsic discounting is company-risk
// based and can therefore be lower than the return hurdle.
const discountCase=stock({ticker:'DISCOUNT_ARCH',sector:'Technology',price:100,growth:.18,margin:.24,roic:.28,dilution:.00});
discountCase.analystEstimates.revenueGrowthCurrentYear=.30;
discountCase.analystEstimates.revenueGrowthNextYear=.26;
const dcaF=buildForecast(discountCase),dcaQ=computeQuality(discountCase,dcaF),dcaV=valuate(discountCase,dcaF,dcaQ);
const dcaDCF=dcaV.methods.find(m=>m.name==='10Y DCF');
assert(dcaDCF,'V12.6 discount architecture test requires a DCF method');
assert(Number.isFinite(dcaV.intrinsicDiscountRate)&&Number.isFinite(dcaV.requiredReturn),'discount rates were not surfaced');
assert(dcaV.requiredReturn>dcaV.intrinsicDiscountRate,'growth-company hurdle rate still leaked into intrinsic DCF discounting');
assert(Math.abs(dcaDCF.audit.discountRate-dcaV.intrinsicDiscountRate)<1e-12,'DCF audit discount rate does not match intrinsic discount rate');
assert(Math.abs(dcaV.fairValueDiscountRate-dcaV.intrinsicDiscountRate)<1e-12,'fair-value discount rate is not aligned with intrinsic DCF rate');

// Technology can retain a mature perpetual growth assumption above the old universal 2.5%
// ceiling when the forecast and discount-rate spread support it.
const higherTerminalF={...dcaF,terminalGrowth:.035};
const higherTerminalV=valuate(discountCase,higherTerminalF,dcaQ);
const higherTerminalDCF=higherTerminalV.methods.find(m=>m.name==='10Y DCF');
assert(higherTerminalDCF&&higherTerminalDCF.audit.terminalGrowth>.025,'DCF still applies the old universal 2.5% terminal-growth ceiling');
assert(higherTerminalDCF.audit.terminalGrowth<=.04+1e-12,'technology DCF exceeded the sector mature-growth ceiling');
console.log('V12.6 discount-rate tests passed: hurdle return is separated from intrinsic DCF discounting and sector-aware terminal growth is bounded independently.');

// V12.12 gross-margin identity reconciliation --------------------------------
// A malformed GrossProfit/grossMargin pair must not beat an independent
// revenue-minus-cost-of-revenue accounting identity (ELF-style SEC corruption).
const grossIdentity=stock({ticker:'GROSS_IDENTITY',price:100,growth:.12,margin:.16,roic:.20,dilution:0});
for(const y of grossIdentity.financials.years){
  y.grossProfit=y.revenue*.25;
  y.grossMargin=.25;
  y.costOfRevenue=y.revenue*.15;
  y.researchAndDevelopment=y.revenue*.08;
  y.sellingGeneralAdministrative=y.revenue*.38;
  y.operatingIncome=y.revenue*.19;
  y.opMargin=.19;
}
const grossIdentityF=buildForecast(grossIdentity);
assert(grossIdentityF.forecastBridge.margins.grossMarginStart>.75,'independent cost-of-revenue identity did not repair malformed gross margin');
assert(grossIdentityF.forecastBridge.margins.grossMarginTarget>.70,'repaired gross margin did not survive into the forward operating model');
console.log('V12.12 gross-margin reconciliation test passed: cost-of-revenue identity overrides malformed gross-profit tags.');


// V12.13 forecast-to-valuation transmission -----------------------------------
// Reconciled gross economics must not be display-only when detailed expense tags fail.
// A multi-year gross-to-operating residual bridge may infer only measured leverage, while
// the reported operating-income history remains the primary anchor.
const grossResidual=stock({ticker:'GROSS_RESIDUAL',price:100,growth:.12,margin:.16,roic:.20,dilution:0});
for(const y of grossResidual.financials.years){
  y.grossProfit=y.revenue*.25; y.grossMargin=.25; y.costOfRevenue=y.revenue*.15;
  y.researchAndDevelopment=null; y.sellingGeneralAdministrative=null;
  y.operatingIncome=y.revenue*.10; y.opMargin=.10;
}
const grossResidualF=buildForecast(grossResidual);
assert(grossResidualF.forecastFlags.includes('gross_to_operating_residual_bridge'),'reconciled gross margin did not activate the fallback gross-to-operating bridge');
assert(Number.isFinite(grossResidualF.forecastBridge.margins.residualOperatingDriverTarget),'fallback residual operating target was not surfaced');
assert(grossResidualF.forecastBridge.margins.operatingTarget>grossResidualF.forecastBridge.margins.operatingStart,'strong gross economics plus growth failed to transmit into any operating leverage');

// More importantly, valuation itself must be monotonic to better owner economics. Holding
// revenue, shares, discounting and terminal framework constant, higher sustainable FCF,
// EPS and EBITDA must increase year-10 shareholder value and expected CAGR.
const transmissionBase=stock({ticker:'TRANSMISSION',price:100,growth:.10,margin:.14,roic:.20,dilution:0});
const transmissionF=buildForecast(transmissionBase);
const transmissionQ=computeQuality(transmissionBase,transmissionF);
const transmissionV=valuate(transmissionBase,transmissionF,transmissionQ);
const strongerF=JSON.parse(JSON.stringify(transmissionF));
for(const r of strongerF.rows){
  r.fcfPerShare*=1.25;
  r.fcfMargin*=1.25;
  r.eps*=1.25;
  r.netMargin*=1.25;
  r.ebitda*=1.25;
  r.ebitdaMargin*=1.25;
}
strongerF.marginTargets.fcf*=1.25;
strongerF.marginTargets.net*=1.25;
strongerF.marginTargets.ebitda*=1.25;
strongerF.marginTargets.matureFCF*=1.25;
strongerF.marginTargets.matureNet*=1.25;
strongerF.marginTargets.matureEBITDA*=1.25;
const strongerV=valuate(transmissionBase,strongerF,transmissionQ);
assert(strongerV.totalShareholderValue>transmissionV.totalShareholderValue*1.12,'materially stronger sustainable owner economics did not materially increase shareholder value');
assert(strongerV.expectedCAGR>transmissionV.expectedCAGR+.01,'materially stronger sustainable owner economics did not increase expected CAGR');
console.log('V12.13 transmission tests passed: reconciled gross economics reach operating leverage and stronger owner economics increase valuation/CAGR.');

// V12.17.1 historical backtest date-selection regression ----------------------
// priceOnOrBefore must select the latest eligible trading day, not the first
// row in the returned Stooq history. The previous comparison accidentally used
// the target timestamp as the incumbent timestamp, causing every historical
// snapshot to fail the max-gap check and producing zero backtest observations.
const {priceOnOrBefore,totalReturnCAGR,parseNportHoldingsXml,accessionFromHit,parseSecSeriesAtom,chooseOpenFigiTicker,adjustedReturnBetween,equalWeightTurnover,endWeightsFromReturns,portfolioStats,thesisSellReason,winnerMomentum,thesisEntryEligible,thesisTargetWeight,buildSellDecisionAudit}=require('./backtest');
const historicalPriceFixture=[
  {date:'2016-01-04',close:10},
  {date:'2016-12-29',close:19},
  {date:'2016-12-30',close:20},
  {date:'2017-01-03',close:21},
];
assert.strictEqual(priceOnOrBefore(historicalPriceFixture,'2016-12-31'),20,'historical price selector did not choose the latest trading day on/before as-of date');
assert.strictEqual(priceOnOrBefore(historicalPriceFixture,'2016-12-29'),19,'historical price selector failed an exact-date match');
assert.strictEqual(priceOnOrBefore(historicalPriceFixture,'2015-12-31'),null,'historical price selector used a future trading day');
console.log('V12.17.1 backtest regression passed: historical prices select the latest eligible trading day.');

// V12.20 total-return backtest regression -------------------------------------
// Valuation must continue to use the raw historical close, while realized
// backtest performance uses adjusted close so splits/dividends are included.
const totalReturnFixture=[
  {date:'2020-12-31',close:100,adjustedClose:90},
  {date:'2021-12-31',close:108,adjustedClose:108},
];
assert.strictEqual(priceOnOrBefore(totalReturnFixture,'2020-12-31'),100,'point-in-time valuation price accidentally used adjusted close');
const tr=totalReturnCAGR(totalReturnFixture,'2020-12-31','2021-12-31',1);
assert(Math.abs(tr-.20)<1e-12,'realized total return did not use adjusted-close series');
console.log('V12.20 backtest regression passed: valuation uses raw close while realized returns use adjusted close.');

// V12.23 SEC N-PORT historical-universe parser regression -------------------
// Historical IWB membership now comes from the SEC's public N-PORT filings,
// avoiding iShares' bot-protected archival endpoint.
const nportFixture=`<edgarSubmission><formData><genInfo><repPd>2025-03-31</repPd></genInfo><invstOrSecs>
<invstOrSec><name>ABC, Inc.</name><assetCat>EC</assetCat><units>NS</units><identifiers><ticker value="ABC"/></identifiers></invstOrSec>
<invstOrSec><name>Berkshire Hathaway Inc.</name><assetCat>EC</assetCat><units>NS</units><identifiers><ticker value="BRK.B"/></identifiers></invstOrSec>
<invstOrSec><name>Veralto Corporation</name><title>VERALTO CORP</title><cusip>92338C103</cusip><assetCat>EC</assetCat><units>NS</units><identifiers><isin value="US92338C1036"/></identifiers></invstOrSec>
<invstOrSec><name>US Dollar</name><assetCat>EC</assetCat><units>NS</units><identifiers><ticker value="USD"/></identifiers></invstOrSec>
</invstOrSecs></formData></edgarSubmission>`;
const currentSectorFixture=new Map([['ABC',{sector:'Technology'}],['BRK-B',{sector:'Financials'}]]);
const parsedNport=parseNportHoldingsXml(nportFixture,currentSectorFixture);
assert.strictEqual(parsedNport.reportDate,'2025-03-31','N-PORT parser lost report date');
assert.strictEqual(parsedNport.holdings.length,2,'N-PORT parser did not retain the two directly tickered equity holdings');
assert.strictEqual(parsedNport.unresolved.length,1,'N-PORT parser did not retain stock CUSIPs when ticker tags were absent');
assert.strictEqual(parsedNport.unresolved[0].cusip,'92338C103','N-PORT parser lost the historical stock CUSIP');
assert.strictEqual(parsedNport.holdings[0].ticker,'ABC','N-PORT parser misread ticker attribute');
assert.strictEqual(parsedNport.holdings[1].ticker,'BRK-B','N-PORT parser did not normalize dotted tickers');
assert.strictEqual(accessionFromHit({_id:'0001752724-25-118607:primary_doc.xml'}),'0001752724-25-118607','EFTS accession parser failed');
const atomFixture=`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>NPORT-P - iShares Russell 1000 ETF</title><updated>2025-05-23T15:30:51-04:00</updated><link href="https://www.sec.gov/Archives/edgar/data/1100663/000175272425118607/0001752724-25-118607-index.htm"/></entry></feed>`;
const atomParsed=parseSecSeriesAtom(atomFixture);
assert.strictEqual(atomParsed.length,1,'SEC series Atom parser did not find filing entry');
assert.strictEqual(atomParsed[0].accession,'0001752724-25-118607','SEC series Atom parser lost accession number');
assert.strictEqual(chooseOpenFigiTicker({data:[{ticker:'VLTO',marketSector:'Equity',securityType2:'Common Stock',exchCode:'US',compositeFIGI:'BBG01J2W8ZK6'}]}),'VLTO','OpenFIGI mapper did not select a common-stock ticker');
assert.strictEqual(chooseOpenFigiTicker({data:[{ticker:'ESH26',marketSector:'Equity',securityType2:'Future',exchCode:'US'}]}),null,'OpenFIGI mapper accepted a derivative as an equity constituent');
console.log('V12.26 backtest regression passed: SEC N-PORT CUSIPs survive parsing and OpenFIGI common-stock ticker selection is guarded.');

// V12.28: the investable portfolio path must use non-overlapping next-rebalance
// returns, execute after the signal date, annualize quarterly volatility/CAGR, and
// charge turnover rather than compounding overlapping 1Y cohorts.
const qHist=[
  {date:'2025-03-31',adjustedClose:100,close:100},
  {date:'2025-04-01',adjustedClose:101,close:101},
  {date:'2025-06-30',adjustedClose:110,close:110},
  {date:'2025-07-01',adjustedClose:111,close:111}
];
const qRet=adjustedReturnBetween(qHist,'2025-03-31','2025-06-30',{executeAfterStart:true});
assert(Math.abs(qRet.return-(111/101-1))<1e-12,'investable return did not execute after signal date / next rebalance');
assert.strictEqual(qRet.startTradeDate,'2025-04-01');
assert.strictEqual(qRet.endTradeDate,'2025-07-01');
assert(Math.abs(equalWeightTurnover(['A','B'],new Map([['A',.5],['B',.5]])))<1e-12,'unchanged equal-weight portfolio should have zero turnover');
assert(Math.abs(equalWeightTurnover(['C','D'],new Map([['A',.5],['B',.5]]))-1)<1e-12,'full replacement should have 100% one-way turnover');
const ew=endWeightsFromReturns(['A','B'],new Map([['A',.10],['B',-.10]]));
assert(ew.get('A')>ew.get('B')&&Math.abs([...ew.values()].reduce((a,b)=>a+b,0)-1)<1e-12,'ending portfolio weights do not drift/reconcile');
const qStats=portfolioStats([
  {portfolioReturn:.10,spyReturn:.05,holdings:10},
  {portfolioReturn:.00,spyReturn:.02,holdings:10},
  {portfolioReturn:.05,spyReturn:.03,holdings:10},
  {portfolioReturn:-.02,spyReturn:.01,holdings:10}
],{periodsPerYear:4});
assert(Math.abs(qStats.portfolioCAGR-((1.10*1.00*1.05*.98)-1))<1e-12,'quarterly chronological CAGR is not compounded over one year correctly');
assert.strictEqual(qStats.periodCount,4);
assert.strictEqual(qStats.yearCount,1);
console.log('V12.28 investable-portfolio regression passed: next-day execution, non-overlapping compounding, turnover, and quarterly annualization are enforced.');




// V12.29 thesis-hold policy regression ---------------------------------------
// Buy and hold use intentionally different hurdles. Rank changes alone are not
// a sell signal; valuation exhaustion and material thesis deterioration are.
const thesisEntry={rank:4,expectedCAGR:.20,qualityScore:82,protectionScore:80,forecastConfidence:85,valuationConfidence:82,modelSupport:'full'};
assert.strictEqual(thesisSellReason({expectedCAGR:.12,qualityScore:78,protectionScore:76,forecastConfidence:80,modelSupport:'full'},thesisEntry),null,'healthy holding was sold merely after its return profile moderated');
assert.strictEqual(thesisSellReason({expectedCAGR:.059,qualityScore:82,protectionScore:80,forecastConfidence:85,modelSupport:'full'},thesisEntry),'forward_return_below_hold_floor','valuation sell floor was not enforced');
assert.strictEqual(thesisSellReason(null,thesisEntry),null,'temporary universe/model absence should not force a sale');
assert.strictEqual(thesisEntryEligible({rank:25,expectedCAGR:.15,modelSupport:'full'}),true,'15% CAGR + Top-25 entry rule was not admitted');
assert.strictEqual(thesisEntryEligible({rank:26,expectedCAGR:.20,modelSupport:'full'}),false,'rank outside Top 25 was admitted');
assert.strictEqual(thesisEntryEligible({rank:5,expectedCAGR:.149,modelSupport:'full'}),false,'sub-15% CAGR entry was admitted');
assert(thesisTargetWeight(thesisEntry)>thesisTargetWeight({...thesisEntry,rank:24,forecastConfidence:65,valuationConfidence:65,qualityScore:65,protectionScore:65}),'position sizing did not reward higher conviction/rank');
assert(thesisTargetWeight(thesisEntry)<=.10,'initial position sizing exceeded 10% cap');
assert.strictEqual(thesisSellReason({expectedCAGR:.14,qualityScore:55,protectionScore:80,forecastConfidence:85,modelSupport:'full'},thesisEntry),'quality_thesis_deteriorated','material quality deterioration did not break the thesis');
assert.strictEqual(thesisSellReason({expectedCAGR:.14,qualityScore:80,protectionScore:45,forecastConfidence:85,modelSupport:'full'},thesisEntry),'protection_thesis_deteriorated','material protection deterioration did not break the thesis');
console.log('V12.30 sized thesis-hold regression passed: Top-25/15% entries, conviction sizing, loose holds, and 6% valuation exits are enforced.');


// V12.31 thesis-hold sell-decision audit regression -------------------------
// A sell audit must follow the sold stock forward without look-ahead and compare
// it with both SPY and same-review replacement buys.
const auditStrategy={periods:[{asOf:'2020-01-01',sells:[{ticker:'OLD',reason:'forward_return_below_hold_floor'}],buyTrades:[{ticker:'NEW',weight:.08}]}]};
const auditHist=new Map([
  ['OLD',[{date:'2020-01-02',adjustedClose:100,close:100},{date:'2021-01-04',adjustedClose:110,close:110}]],
  ['NEW',[{date:'2020-01-02',adjustedClose:100,close:100},{date:'2021-01-04',adjustedClose:120,close:120}]]
]);
const auditSpy=[{date:'2020-01-02',adjustedClose:100,close:100},{date:'2021-01-04',adjustedClose:105,close:105}];
const sellAudit=buildSellDecisionAudit(auditStrategy,auditHist,auditSpy,{horizons:[1]});
assert.strictEqual(sellAudit.events.length,1,'sell-decision audit lost a historical exit');
assert(Math.abs(sellAudit.events[0].horizons[1].soldCAGR-.10)<1e-12,'sell-decision audit mismeasured sold-stock forward CAGR');
assert(Math.abs(sellAudit.events[0].horizons[1].spyCAGR-.05)<1e-12,'sell-decision audit mismeasured SPY comparator');
assert(Math.abs(sellAudit.events[0].horizons[1].replacementCAGR-.20)<1e-12,'sell-decision audit mismeasured replacement basket');
assert(sellAudit.events[0].horizons[1].replacementVsSold>.09,'sell-decision audit did not capture replacement opportunity cost');
console.log('V12.31 sell-decision audit regression passed: sold stocks, SPY, and replacement buys are followed forward consistently.');


// V12.32 Ride Winner momentum regression ------------------------------------
// A valuation-stretched holding may keep running only when its recent absolute
// return is positive and it is beating SPY over both 6M and 12M windows.
const momHist=new Map([['WIN',[
  {date:'2024-03-31',close:100,adjustedClose:100},
  {date:'2024-09-30',close:120,adjustedClose:120},
  {date:'2024-12-31',close:130,adjustedClose:130},
  {date:'2025-03-31',close:145,adjustedClose:145}
]]]);
const momSpy=[
  {date:'2024-03-31',close:100,adjustedClose:100},
  {date:'2024-09-30',close:108,adjustedClose:108},
  {date:'2024-12-31',close:112,adjustedClose:112},
  {date:'2025-03-31',close:115,adjustedClose:115}
];
const mom=winnerMomentum('WIN','2025-03-31',momHist,momSpy);
assert.strictEqual(mom.strong,true,'strong relative winner was not granted Ride Winner status');
assert.strictEqual(thesisSellReason({expectedCAGR:.03,qualityScore:82,protectionScore:80,forecastConfidence:85,modelSupport:'full'},thesisEntry,{rideMomentum:true,momentum:mom}),null,'strong momentum did not override the low-return valuation exit');
assert.strictEqual(thesisSellReason({expectedCAGR:.03,qualityScore:82,protectionScore:80,forecastConfidence:85,modelSupport:'full'},thesisEntry,{rideMomentum:true,momentum:{strong:false}}),'low_return_momentum_broken','low-return holding survived after momentum privilege broke');
assert.strictEqual(thesisSellReason({expectedCAGR:.03,qualityScore:55,protectionScore:80,forecastConfidence:85,modelSupport:'full'},thesisEntry,{rideMomentum:true,momentum:mom}),'quality_thesis_deteriorated','momentum improperly overrode a broken fundamental thesis');
console.log('V12.32 Ride Winner regression passed: stretched winners can run on relative momentum, but momentum cannot override a broken thesis.');

// V12.33 live portfolio-policy regression ------------------------------------
// The live screener must publish the same Top-25/15% entry sizing and Ride Winner
// momentum logic used by the historical thesis-hold backtest.
const {
  thesisEntryEligible:liveEntryEligible,
  thesisTargetWeight:liveTargetWeight,
  isStrongWinnerMomentum,
  livePortfolioGuidance,
}=require('./engine/portfolio-policy');
const liveCandidate={overallRank:7,expectedCAGR:.22,expectedAlpha:.07,rating:'Buy',forecastReliabilityScore:88,valuationConfidenceScore:84,qualityScore:86,moatScore:82,compounderScore:84,downsideProtectionScore:80,marginOfSafety:.12,modelSupport:'standard'};
assert.strictEqual(liveEntryEligible(liveCandidate),true,'live policy rejected a Buy-rated Top-25 stock that clears CAGR and Alpha entry gates');
assert.strictEqual(liveEntryEligible({...liveCandidate,rating:'Watch'}),true,'v12.51 should not use Valuation Rating as a hard Starter Portfolio gate');
assert(liveTargetWeight(liveCandidate)>=.07&&liveTargetWeight(liveCandidate)<=.10,'live conviction sizing drifted from thesis-hold sizing bands');
const liveRideMomentum={stock3:.08,rel6:.06,rel12:.03};
assert.strictEqual(isStrongWinnerMomentum(liveRideMomentum),true,'live Ride Winner momentum test drifted from the backtest rule');
const liveRide=livePortfolioGuidance({...liveCandidate,overallRank:40,expectedCAGR:.04},liveRideMomentum);
assert.strictEqual(liveRide.newPositionAction,'WATCH','valuation-stretched Buy-rated stock should be watched rather than opened as a new position');
assert.strictEqual(liveRide.existingHolderAction,'RIDE WINNER','live policy failed to ride an existing valuation-stretched winner with strong momentum');
const liveExit=livePortfolioGuidance({...liveCandidate,overallRank:40,expectedCAGR:.04},{stock3:-.02,rel6:-.01,rel12:.02});
assert.strictEqual(liveExit.existingHolderAction,'HOLD — VALUATION WATCH','live policy incorrectly turned low expected return into a thesis sell');
console.log('V12.39 live portfolio-policy regression passed: entry logic is unchanged and valuation/forecast weakness no longer masquerades as a thesis sell.');

// V12.45 Alpha semantics regression ------------------------------------------
const {INVESTOR_ALPHA_HURDLE}=require('./engine/config');
const {ALPHA_GATE,applyModelDRanking}=require('./engine/ranking-engine');
assert.strictEqual(INVESTOR_ALPHA_HURDLE,.15,'Expected Alpha hurdle is not 15%');
assert.strictEqual(ALPHA_GATE,0,'v12.51 live candidate ranking should include stocks at the 15% CAGR hurdle (Alpha >=0)');
const alphaProbe=rateStock({price:{current:100},sector:'Technology'},{forecastReliabilityScore:80},{qualityScore:80,growthQualityScore:80,moatScore:80,compounderScore:80,pricingPowerScore:80,capitalAllocationScore:80,protectionScore:80,confidenceScore:80},{expectedCAGR:.22,marginOfSafety:.2,requiredReturnBuyPrice:90,hurdleReturnPrice:110,methodAgreementScore:80,valuationConfidenceScore:80,methods:[1,2,3],independentMethodCount:3,modelSupport:'standard'});
assert(Math.abs(alphaProbe.expectedAlpha-.07)<1e-12,'22% expected CAGR should equal +7% Alpha on a 15% hurdle');
const rankProbe=[{ticker:'A',expectedAlpha:.049,expectedCAGR:.199,qualityScore:90,moatScore:90,growthQualityScore:90,compounderScore:90,investmentScore:90},{ticker:'B',expectedAlpha:.051,expectedCAGR:.201,qualityScore:60,moatScore:60,growthQualityScore:60,compounderScore:60,investmentScore:60}];
applyModelDRanking(rankProbe);assert.strictEqual(rankProbe.find(x=>x.ticker==='B').rankEligible,true);assert.strictEqual(rankProbe.find(x=>x.ticker==='A').rankEligible,true);
console.log('V12.51 Alpha regression passed: Alpha uses the 15% hurdle and live candidate ranking starts at Alpha >=0.');

// V12.51 dynamic margin-of-safety entry regression ---------------------------
const {dynamicMosProfile}=require('./engine/portfolio-policy');
const elite={...liveCandidate,expectedCAGR:.17,expectedAlpha:.02,overallRank:10,qualityScore:86,moatScore:82,compounderScore:84,forecastReliabilityScore:72,valuationConfidenceScore:76,marginOfSafety:.06,rating:'Watch'};
assert.strictEqual(dynamicMosProfile(elite).requiredMOS,.05,'elite compounder should require 5% MOS');
assert.strictEqual(liveEntryEligible(elite),true,'elite compounder clearing 15% CAGR and 5% MOS should qualify even when Valuation Rating is Watch');
const uncertain={...liveCandidate,expectedCAGR:.24,expectedAlpha:.09,overallRank:8,qualityScore:55,moatScore:48,compounderScore:52,forecastReliabilityScore:48,valuationConfidenceScore:50,marginOfSafety:.20,rating:'Buy'};
assert.strictEqual(dynamicMosProfile(uncertain).requiredMOS,.25,'higher-uncertainty business should require 25% MOS');
assert.strictEqual(liveEntryEligible(uncertain),false,'higher-uncertainty business must not qualify with only 20% MOS');
assert.strictEqual(liveEntryEligible({...uncertain,marginOfSafety:.27}),true,'higher-uncertainty business should qualify after clearing its larger MOS requirement');
assert.strictEqual(liveEntryEligible({...elite,expectedCAGR:.149,expectedAlpha:-.001}),false,'no quality tier may bypass the 15% return hurdle');
console.log('V12.51 dynamic-MOS regression passed: 15% CAGR is the floor and stronger businesses earn a smaller required valuation cushion.');
