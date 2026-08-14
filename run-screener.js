'use strict';
/**
 * FreeScreener simplified production pipeline.
 *
 * ONE path only:
 *   data -> forecast -> quality -> valuation -> rating -> validation -> results.json
 *
 * There are deliberately no Vxx decision systems, calibration layers, return aliases,
 * Monte Carlo overrides, or competing fair-value engines in the publication path.
 */
const fs = require('fs');
const path = require('path');
const { buildStockRecord } = require('./data-fetchers');
const { buildForecast } = require('./engine/forecast-engine');
const { computeQuality } = require('./engine/quality-engine');
const { valuate } = require('./engine/valuation-engine');
const { rateStock } = require('./engine/rating-engine');
const { validateUniverse } = require('./engine/validation');

const watchlist = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'),'utf8'));
const RATE_LIMIT_DELAY_MS = Number(process.env.RATE_LIMIT_DELAY_MS || 1100);
const CHECKPOINT_EVERY = 100;

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function normalizeTicker(t){return String(t||'').trim().toUpperCase().replace(/\./g,'-');}

async function loadAnalystEstimates(){
  const raw=String(process.env.SUPABASE_URL||'').trim();
  const base=raw.replace(/\/+$/,'').replace(/\/rest\/v1$/,'');
  const key=String(process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_ANON_KEY||'').trim();
  if(!base||!key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  console.log(`Reading analyst estimates from ${base}/rest/v1/analyst_estimates_cache`);
  const rows=[]; const pageSize=1000;
  for(let offset=0;;offset+=pageSize){
    const params=new URLSearchParams({select:'*',order:'ticker.asc',offset:String(offset),limit:String(pageSize)});
    const res=await fetch(`${base}/rest/v1/analyst_estimates_cache?${params}`,{headers:{apikey:key,Authorization:`Bearer ${key}`,Accept:'application/json'}});
    if(!res.ok) throw new Error(`Analyst cache HTTP ${res.status}: ${(await res.text()).slice(0,400)}`);
    const page=await res.json(); rows.push(...page); console.log(`Analyst cache page: offset ${offset}, received ${page.length}, total ${rows.length}`); if(page.length<pageSize)break;
  }
  const map=new Map();
  for(const r of rows){const t=normalizeTicker(r.ticker);if(!t)continue;map.set(t,{
    revenueGrowthFwd:r.revenue_growth_fwd??null,revenueGrowthCurrentYear:r.revenue_growth_current_year??r.revenue_growth_fwd??null,revenueGrowthNextYear:r.revenue_growth_next_year??null,
    revenueCurrentYear:r.revenue_current_year??null,revenueNextYear:r.revenue_next_year??null,epsGrowthFwd:r.eps_growth_fwd??null,epsGrowthCurrentYear:r.eps_growth_current_year??r.eps_growth_fwd??null,epsGrowthNextYear:r.eps_growth_next_year??null,
    epsCurrentYear:r.eps_current_year??null,epsNextYear:r.eps_next_year??null,analystTargetMean:r.analyst_target_mean??null,analystTargetLow:r.analyst_target_low??null,analystTargetHigh:r.analyst_target_high??null,numAnalysts:r.num_analysts??null,source:r.source??null,updatedAt:r.updated_at??null
  });}
  console.log(`Mapped ${map.size} analyst records.`); return map;
}

function pct(v){return Number.isFinite(v)?v:null;}
function flattenRecord(stock, forecast, quality, valuation, decision){
  const v=stock.valuation||{};
  const methodMap={}; const methodAudits={};
  for(const m of valuation.methods||[]){methodMap[m.name]=m.target;methodAudits[m.name]=m.audit||{};}
  const strengths=[]; const risks=[];
  if(quality.moatScore>=75)strengths.push('Durable competitive advantages');
  if(quality.pricingPowerScore>=70)strengths.push('Strong pricing power');
  if(quality.capitalAllocationScore>=70)strengths.push('Disciplined capital allocation');
  if(quality.compounderScore>=75)strengths.push('High-quality long-term compounding profile');
  if(quality.growthQualityScore>=70)strengths.push('Revenue growth is a meaningful return driver');
  if(quality.protectionScore>=70)strengths.push('Above-average downside protection');
  if(quality.confidenceScore<55)risks.push('Forecast reliability is below average');
  if(valuation.methodAgreementScore<55)risks.push('Valuation methods disagree materially');
  if(valuation.bearCAGR<0)risks.push(`Bear-case CAGR is ${(valuation.bearCAGR*100).toFixed(1)}%`);
  if((quality.diagnostics?.dilutionRate||0)>0.03)risks.push('Share dilution is elevated');
  if((quality.diagnostics?.netDebtToEbitda||0)>3)risks.push('Leverage is elevated');

  const cagrBreakdown={
    revenueContribution:forecast.revenueGrowthAnchor,
    marginContribution:(forecast.rows.at(-1)?.fcfMargin??0)-(forecast.marginAssumptions?.fcf??0),
    shareCountContribution:-(forecast.dilutionRate||0),
    dividendContribution:stock.valuation?.dividendYield||0,
    multipleReratingContribution:null,
  };

  return {
    ticker:stock.ticker, sector:stock.sector, category:forecast.category, rating:decision.rating,
    currentPrice:stock.price?.current??null,
    expectedReturn:valuation.expectedCAGR, expectedCAGR:valuation.expectedCAGR, expectedAlpha:decision.expectedAlpha,
    bearCAGR:valuation.bearCAGR, baseCAGR:valuation.baseCAGR, bullCAGR:valuation.bullCAGR,
    confidenceScore:quality.confidenceScore, marginOfSafety:valuation.marginOfSafety, premiumToFairValue:valuation.premiumToFairValue, requiredMOS:decision.requiredMOS,
    investmentScore:decision.investmentScore, qualityScore:quality.qualityScore, moatScore:quality.moatScore, capitalAllocationScore:quality.capitalAllocationScore,
    compounderScore:quality.compounderScore, growthQuality:quality.growthQualityScore, growthQualityScore:quality.growthQualityScore, pricingPowerV2Score:quality.pricingPowerScore, downsideProtectionScore:quality.protectionScore,
    qualifiesForBuyList:decision.qualifiesForBuyList,
    fairValueEstimate:valuation.fairValueEstimate, fiveYearPriceTarget:valuation.fiveYearPriceTarget, totalShareholderValue:valuation.totalShareholderValue, cumulativeDividends:valuation.cumulativeDividends,
    fundamentalGrowthRate:forecast.revenueGrowthAnchor, growthSource:v.growthSource, dilutionRate:forecast.dilutionRate, sbcIntensity:stock.financials?.years?.at(-1)?.sbcIntensity??null,
    valuationMethods:methodMap, valuationMethodAudits:methodAudits, methodAgreementScore:valuation.methodAgreementScore, methodCount:(valuation.methods||[]).length,
    valuationProjection:forecast.rows, projectionAssumptions:{terminalGrowth:forecast.terminalGrowth,requiredReturn:valuation.requiredReturn,revenueGrowthAnchor:forecast.revenueGrowthAnchor,historicalGrowth:forecast.historicalGrowth,marginAssumptions:forecast.marginAssumptions},
    analystEstimates:stock.analystEstimates,
    investmentThesis:{strengths,risks}, pricingPowerSignals: strengths.filter(x=>/pricing/i.test(x)), capitalAllocationSignals: strengths.filter(x=>/capital|dilution|leverage/i.test(x)),
    qualityBreakdown:quality.diagnostics, cagrBreakdown,
    decisionDashboard:{grade:decision.investmentScore>=80?'A':decision.investmentScore>=70?'B+':decision.investmentScore>=60?'B':decision.investmentScore>=50?'C':'D',positionTier:decision.qualifiesForBuyList?'Core':'Unrated',suggestedWeight:decision.rating==='Exceptional Buy'?'8–10%':decision.rating==='Strong Buy'?'6–8%':decision.rating==='Buy'?'4–6%':'Unrated'},
    returnAttribution:cagrBreakdown,
    valuationConfidenceScore:Math.round((quality.confidenceScore+valuation.methodAgreementScore)/2), dataConfidenceScore:quality.confidenceScore, businessConfidenceScore:quality.qualityScore, forecastConfidenceScore:quality.confidenceScore,
    businessQualityScore:quality.qualityScore, valuationAttractivenessScore:Math.round(Math.max(0,Math.min(100,50+(valuation.marginOfSafety||0)*100))),
    portfolioManagerScore:decision.investmentScore, investmentCommitteeScore:decision.investmentScore, investmentCommittee:{score:decision.investmentScore},
    returnQualityFlags:[], returnIntegrityError:null, lowConfidence:quality.confidenceScore<55,
    businessProfile:{category:forecast.category,terminalGrowth:forecast.terminalGrowth}, lifecycle:{label:forecast.category}, moat:{score:quality.moatScore},
    marketExpectations:{note:'Simplified model: no reverse-DCF narrative inference is used in ratings.'},
    scenarioAnalysis:{bearCAGR:valuation.bearCAGR,baseCAGR:valuation.baseCAGR,bullCAGR:valuation.bullCAGR}, scenarioProbabilities:{bear:0.25,base:0.50,bull:0.25},
    expectedReturnProfile:{expectedCAGR:valuation.expectedCAGR,bearCAGR:valuation.bearCAGR,baseCAGR:valuation.baseCAGR,bullCAGR:valuation.bullCAGR},
    analystReliability:quality.confidenceScore, outlierFlags:[], reliabilityFlags:[], effectiveWeights:Object.fromEntries((valuation.methods||[]).map(m=>[m.name,m.weight])),
    primaryValuation:{method:'Blended year-5 shareholder outcome',target:valuation.fiveYearPriceTarget,totalOutcome:valuation.totalShareholderValue,requiredReturn:valuation.requiredReturn},
    ownerEarningsReturn:null, marketImpliedGrowth:null, marketImpliedGrowthNote:null, reverseDCFGap:null, expectationRisk:null, monteCarlo:null,
  };
}

function rank(stocks){
  const sorted=[...stocks].sort((a,b)=>(b.investmentScore||0)-(a.investmentScore||0)); sorted.forEach((s,i)=>s.overallRank=i+1);
  const q=[...stocks].sort((a,b)=>(b.qualityScore||0)-(a.qualityScore||0)); q.forEach((s,i)=>s.qualityRank=i+1);
  const o=[...stocks].sort((a,b)=>(b.expectedReturn||-99)-(a.expectedReturn||-99)); o.forEach((s,i)=>s.opportunityRank=i+1);
  const groups={}; for(const s of stocks)(groups[s.category]??=[]).push(s);
  for(const g of Object.values(groups)){g.sort((a,b)=>(b.investmentScore||0)-(a.investmentScore||0));g.forEach((s,i)=>{s.categoryRank=i+1;s.categoryUniverseSize=g.length;});}
  stocks.forEach(s=>s.globalUniverseSize=stocks.length);
}

function writeJson(file,obj){const p=path.join(__dirname,'data',file);const tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(obj));fs.renameSync(tmp,p);}

async function run(){
  fs.mkdirSync(path.join(__dirname,'data'),{recursive:true});
  const analyst=await loadAnalystEstimates(); const records=[]; const diag={startedAt:new Date().toISOString(),total:watchlist.length,skipped:[],failed:[],limitedHistoryIncluded:0}; const start=Date.now();
  for(let i=0;i<watchlist.length;i++){
    const {ticker,sector}=watchlist[i];
    try{
      const r=await buildStockRecord(ticker,sector,analyst.get(normalizeTicker(ticker))||null); const n=r.financials?.years?.length||0;
      if(n<2){diag.skipped.push({ticker,reason:`only ${n} usable annual years`});console.log(`[${i+1}/${watchlist.length}] Skipping ${ticker}: only ${n} usable annual years`);} else {if(n===2){diag.limitedHistoryIncluded++;console.log(`[${i+1}/${watchlist.length}] Including ${ticker} with limited 2-year history`);} if(!(r.price?.current>0)){diag.skipped.push({ticker,reason:'no current price'});console.log(`[${i+1}/${watchlist.length}] Skipping ${ticker}: no current price`);} else records.push(r);}
    }catch(e){diag.failed.push({ticker,error:e.message});console.log(`[${i+1}/${watchlist.length}] Failed ${ticker}: ${e.message}`);}
    if((i+1)%25===0)console.log(`Progress: ${i+1}/${watchlist.length} (${((Date.now()-start)/60000).toFixed(1)} min elapsed, ${records.length} usable so far)`);
    if(RATE_LIMIT_DELAY_MS>0)await sleep(RATE_LIMIT_DELAY_MS);
  }
  console.log(`Coverage: ${records.length}/${watchlist.length} (${(records.length/watchlist.length*100).toFixed(1)}%).`);

  const stocks=[];
  for(const stock of records){
    const forecast=buildForecast(stock); const quality=computeQuality(stock,forecast); const valuation=valuate(stock,forecast,quality); const decision=rateStock(stock,forecast,quality,valuation); stocks.push(flattenRecord(stock,forecast,quality,valuation,decision));
  }
  rank(stocks);
  const validation=validateUniverse(stocks); writeJson('validation-report.json',validation); console.log(`Validation: ${validation.passed?'passed':'FAILED'} (${validation.issues.length} issue(s)).`);
  if(!validation.passed){throw new Error(`Validation failed: ${validation.issues.slice(0,10).map(x=>`${x.ticker}:${x.type}`).join(', ')}`);}
  const output={generatedAt:new Date().toISOString(),count:stocks.length,modelVersion:'simple-v1',stocks}; writeJson('results.json',output);
  diag.finishedAt=new Date().toISOString();diag.scored=stocks.length;writeJson('screener-diagnostics.json',diag);
  console.log(`Done. Wrote ${stocks.length} stocks using the simplified one-path model.`);
}
run().catch(e=>{console.error(e);process.exit(1);});
