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
function run(s){const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q),d=rateStock(s,f,q,v);const pub={ticker:s.ticker,currentPrice:s.price.current,totalShareholderValue:v.totalShareholderValue,expectedReturn:v.expectedCAGR,bearCAGR:v.bearCAGR,baseCAGR:v.baseCAGR,bullCAGR:v.bullCAGR,fairValueEstimate:v.fairValueEstimate,marginOfSafety:v.marginOfSafety,rating:d.rating};assert.deepStrictEqual(validateStock(pub),[]);assert(v.bearCAGR<=v.baseCAGR&&v.baseCAGR<=v.bullCAGR);assert(Math.abs((1-s.price.current/v.fairValueEstimate)-v.marginOfSafety)<1e-10);return{f,q,v,d};}
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

// A growth company with temporarily unusable earnings/FCF should fall back to an
// EV/Sales bridge instead of becoming Unrated.
const preProfit=stock({ticker:'PREPROFIT',price:100,growth:.22,margin:.10,roic:.05,dilution:.03});
for(const y of preProfit.financials.years){y.fcf=-Math.abs(y.fcf);y.fcfSBCAdjusted=-Math.abs(y.fcfSBCAdjusted);y.netIncome=-Math.abs(y.netIncome);y.ebitda=-Math.abs(y.ebitda);}
const ppF=buildForecast(preProfit), ppQ=computeQuality(preProfit,ppF), ppV=valuate(preProfit,ppF,ppQ), ppD=rateStock(preProfit,ppF,ppQ,ppV);
assert(ppV.methods.some(m=>m.name==='EV/Sales fallback'),'pre-profit company should use EV/Sales fallback');
assert(Number.isFinite(ppV.expectedCAGR),'fallback valuation should publish a canonical return');
assert.notStrictEqual(ppD.rating,'Unrated','fallback-valued company should receive a rating');


// Pathological upside must never be published as a triple-digit base-case CAGR.
// If normalized economics still imply >45% annually, the valuation is considered
// non-decision-grade instead of clipping the return to an arbitrary number.
const pathological=stock({ticker:'PATHOLOGICAL',price:5,growth:.30,margin:.35,roic:.35,dilution:-.04});
const pathF=buildForecast(pathological), pathQ=computeQuality(pathological,pathF), pathV=valuate(pathological,pathF,pathQ);
assert(pathV.expectedCAGR==null || pathV.expectedCAGR<=.25,'pathological upside leaked into published CAGR');

// Financials are valued from normalized EPS, not revenue × margin. This protects
// banks/insurers/multi-class investment companies from accounting-base explosions.
const financial=stock({ticker:'FIN',sector:'Financials',price:100,growth:.18,margin:.30,roic:.18,dilution:-.02});
for(const y of financial.financials.years){ y.dilutedEPS=y.netIncome/y.sharesOutTTM; }
const finF=buildForecast(financial), finQ=computeQuality(financial,finF), finV=valuate(financial,finF,finQ);
assert(finV.methods.every(m=>m.name==='Normalized EPS exit'),'financial valuation should use normalized EPS only');
assert(finV.expectedCAGR==null || finV.expectedCAGR<=.25,'financial base-case CAGR exceeded plausibility ceiling');

console.log('Model smoke test passed: canonical math, normalized valuation anchors, financial EPS handling, and pathological-upside rejection are internally consistent.');

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
