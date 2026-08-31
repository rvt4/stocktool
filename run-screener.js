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
const { buildStockRecord, fetchBacktestHistory } = require('./data-fetchers');
const { buildForecast } = require('./engine/forecast-engine');
const { computeQuality } = require('./engine/quality-engine');
const { valuate } = require('./engine/valuation-engine');
const { rateStock } = require('./engine/rating-engine');
const { validateUniverse } = require('./engine/validation');
const { writeProspectiveSnapshot } = require('./engine/history-snapshot');
const { livePortfolioGuidance } = require('./engine/portfolio-policy');
const { applyModelDRanking, compareRank } = require('./engine/ranking-engine');

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
  if((forecast.forecastReliabilityScore??quality.confidenceScore)<55)risks.push('Forecast reliability is below average');
  if(valuation.cyclicalBusiness)risks.push('Cyclical economics widen terminal-value uncertainty');
  if(valuation.modelSupport==='limited')risks.push(valuation.modelSupportReason||'Valuation framework has limited support for this business type');
  if(valuation.valuationConsensus?.hasConsensusOutlier){
    const names=(valuation.valuationConsensus.outlierMethods||[]).join(', ');
    risks.push(names?`Valuation outlier detected: ${names}`:'One valuation method is an outlier versus the consensus');
  } else if(Number.isFinite(valuation.methodAgreementScore)&&valuation.methodAgreementScore<55)risks.push('Valuation methods disagree materially');
  if((valuation.methods||[]).length===1)risks.push('Valuation rests on a single usable method');
  if(valuation.bearCAGR<0)risks.push(`Bear-case CAGR is ${(valuation.bearCAGR*100).toFixed(1)}%`);
  if((quality.diagnostics?.dilutionRate||0)>0.03)risks.push('Share dilution is elevated');
  if((quality.diagnostics?.netDebtToEbitda||0)>3)risks.push('Leverage is elevated');

  const cagrBreakdown=valuation.returnAttribution||{
    revenueContribution:forecast.revenueGrowthAnchor,
    marginContribution:null,
    shareCountContribution:-(forecast.dilutionRate||0),
    dividendContribution:stock.valuation?.dividendYield||0,
    multipleReratingContribution:null,
    uncertaintyAdjustment:null,
  };

  return {
    ticker:stock.ticker, name:stock.name||stock.ticker, sector:stock.sector, industry:stock.industry||null, sic:stock.sic||null, isBiopharma:!!stock.isBiopharma, marketCap:stock.valuation?.marketCap??null, category:forecast.category, rating:decision.rating,
    currentPrice:stock.price?.current??null,
    expectedReturn:valuation.expectedCAGR, expectedCAGR:valuation.expectedCAGR, expectedAlpha:decision.expectedAlpha,
    bearCAGR:valuation.bearCAGR, baseCAGR:valuation.baseCAGR, bullCAGR:valuation.bullCAGR,
    confidenceScore:valuation.valuationConfidenceScore??quality.confidenceScore, valuationConfidenceScore:valuation.valuationConfidenceScore??quality.confidenceScore, businessDataConfidenceScore:quality.confidenceScore, marginOfSafety:valuation.marginOfSafety, premiumToFairValue:valuation.premiumToFairValue, requiredMOS:decision.requiredMOS,
    investmentScore:decision.investmentScore, opportunityScore:decision.opportunityScore, opportunityQualityScore:decision.opportunityQualityScore, activatedQualityScore:decision.activatedQualityScore, qualityActivation:decision.qualityActivation, reliabilityScore:decision.reliabilityScore, qualityScore:quality.qualityScore, moatScore:quality.moatScore, capitalAllocationScore:quality.capitalAllocationScore,
    compounderScore:quality.compounderScore, growthQuality:quality.growthQualityScore, growthQualityScore:quality.growthQualityScore, pricingPowerV2Score:quality.pricingPowerScore, downsideProtectionScore:quality.protectionScore,
    qualifiesForBuyList:decision.qualifiesForBuyList, meetsInvestorBuyPrice:decision.meetsInvestorBuyPrice, meetsHurdlePrice:decision.meetsHurdlePrice, evidenceScore:decision.evidenceScore,
    fairValueEstimate:valuation.fairValueEstimate, intrinsicDiscountRate:valuation.intrinsicDiscountRate, hurdleReturnPrice:valuation.hurdleReturnPrice, requiredReturnBuyPrice:valuation.requiredReturnBuyPrice, investorMarginOfSafety:valuation.investorMarginOfSafety, fairValueDiscountRate:valuation.fairValueDiscountRate, valuationGap:valuation.valuationGap, fiveYearPriceTarget:valuation.fiveYearPriceTarget, tenYearPriceTarget:valuation.tenYearPriceTarget, fiveYearTotalShareholderValue:valuation.fiveYearTotalShareholderValue, fiveYearExpectedCAGR:valuation.fiveYearExpectedCAGR, tenYearExpectedCAGR:valuation.tenYearExpectedCAGR, horizonYears:valuation.horizonYears, totalShareholderValue:valuation.totalShareholderValue, cumulativeDividends:valuation.cumulativeDividends,
    fundamentalGrowthRate:forecast.revenueGrowthAnchor, growthSource:v.growthSource, dilutionRate:forecast.dilutionRate, matureDilutionRate:forecast.matureDilutionRate, dilutionPath:forecast.dilutionPath, sbcIntensity:stock.financials?.years?.at(-1)?.sbcIntensity??null,
    valuationMethods:methodMap, valuationMethodAudits:methodAudits, methodAgreementScore:valuation.methodAgreementScore, methodCount:(valuation.methods||[]).length, independentMethodCount:valuation.independentMethodCount??null, modelSupport:valuation.modelSupport??'standard', modelSupportReason:valuation.modelSupportReason??null, valuationConsensus:valuation.valuationConsensus||null, multipleSensitivity:valuation.multipleSensitivity||null, cyclicalBusiness:valuation.cyclicalBusiness||false, cycleDispersion:valuation.cycleDispersion??null, preUncertaintyCAGR:valuation.preUncertaintyCAGR??null, uncertaintyHaircutRate:valuation.uncertaintyHaircutRate??null,
    valuationProjection:forecast.rows, projectionAssumptions:{terminalGrowth:forecast.terminalGrowth,requiredReturn:valuation.requiredReturn,revenueGrowthAnchor:forecast.revenueGrowthAnchor,historicalGrowth:forecast.historicalGrowth,historyReliability:forecast.historyReliability,historyGrowthDispersion:forecast.historyGrowthDispersion,forecastReliabilityScore:forecast.forecastReliabilityScore,marginAssumptions:forecast.marginAssumptions,marginTargets:forecast.marginTargets,forecastBridge:forecast.forecastBridge,forecastFlags:forecast.forecastFlags,dilutionPath:forecast.dilutionPath,matureDilutionRate:forecast.matureDilutionRate},
    analystEstimates:stock.analystEstimates,
    investmentThesis:{strengths,risks}, pricingPowerSignals: strengths.filter(x=>/pricing/i.test(x)), capitalAllocationSignals: strengths.filter(x=>/capital|dilution|leverage/i.test(x)),
    qualityBreakdown:quality.diagnostics, cagrBreakdown,
    decisionDashboard:{grade:decision.investmentScore>=80?'A':decision.investmentScore>=70?'B+':decision.investmentScore>=60?'B':decision.investmentScore>=50?'C':'D',positionTier:decision.qualifiesForBuyList?'Core':'Unrated',suggestedWeight:decision.rating==='Exceptional Buy'?'8–10%':decision.rating==='Strong Buy'?'6–8%':decision.rating==='Buy'?'4–6%':'Unrated'},
    returnAttribution:cagrBreakdown,
    valuationConfidenceScore:valuation.valuationConfidenceScore??quality.confidenceScore, dataConfidenceScore:quality.confidenceScore, businessConfidenceScore:quality.qualityScore, forecastConfidenceScore:forecast.forecastReliabilityScore??quality.confidenceScore, forecastReliabilityScore:forecast.forecastReliabilityScore??quality.confidenceScore,
    businessQualityScore:quality.qualityScore, valuationAttractivenessScore:Math.round(Math.max(0,Math.min(100,50+(valuation.marginOfSafety||0)*100))),
    portfolioManagerScore:decision.investmentScore, investmentCommitteeScore:decision.investmentScore, investmentCommittee:{score:decision.investmentScore},
    returnQualityFlags:[...(valuation.plausibilityFailure?['valuation_plausibility_failure']:[]),...(valuation.returnDecompositionFailure?['return_decomposition_failure']:[]),...(valuation.extremeReturnFlag?['extreme_canonical_return_review']:[])], returnIntegrityError:valuation.plausibilityFailure?'No defensible canonical valuation could be constructed':null, lowConfidence:quality.confidenceScore<55, valuationReviewFlag:valuation.valuationReviewFlag||null,
    businessProfile:{category:forecast.category,terminalGrowth:forecast.terminalGrowth}, lifecycle:{label:forecast.category}, moat:{score:quality.moatScore},
    marketExpectations:{note:'Simplified model: no reverse-DCF narrative inference is used in ratings.'},
    scenarioAnalysis:{bearCAGR:valuation.bearCAGR,baseCAGR:valuation.baseCAGR,bullCAGR:valuation.bullCAGR}, scenarioProbabilities:{bear:0.25,base:0.50,bull:0.25},
    expectedReturnProfile:{expectedCAGR:valuation.expectedCAGR,bearCAGR:valuation.bearCAGR,baseCAGR:valuation.baseCAGR,bullCAGR:valuation.bullCAGR},
    analystReliability:quality.confidenceScore, outlierFlags:valuation.valuationConsensus?.hasConsensusOutlier?(valuation.valuationConsensus.outlierMethods||[]):[], reliabilityFlags:[], effectiveWeights:valuation.canonicalMethodWeights||Object.fromEntries((valuation.methods||[]).map(m=>[m.name,m.weight])),
    primaryValuation:{method:'Blended 10-year shareholder outcome',target:valuation.tenYearPriceTarget??valuation.fiveYearPriceTarget,totalOutcome:valuation.totalShareholderValue,requiredReturn:valuation.requiredReturn},
    ownerEarningsReturn:null, marketImpliedGrowth:null, marketImpliedGrowthNote:null, reverseDCFGap:null, expectationRisk:null, monteCarlo:null,
  };
}

function rank(stocks){
  // v12.38: Expected Alpha >=10% is the opportunity gate. Eligible names are ordered
  // by the exact frozen Model-D blend; below-gate names remain behind them and are
  // ordered by expected return, so business quality cannot rescue an inadequate return.
  applyModelDRanking(stocks,{rankField:'overallRank',universeSizeField:'globalUniverseSize'});
  const q=[...stocks].sort((a,b)=>(b.qualityScore||0)-(a.qualityScore||0)); q.forEach((s,i)=>s.qualityRank=i+1);
  const o=[...stocks].sort((a,b)=>(b.expectedReturn||-99)-(a.expectedReturn||-99)); o.forEach((s,i)=>s.opportunityRank=i+1);
  const groups={}; for(const s of stocks)(groups[s.category]??=[]).push(s);
  for(const g of Object.values(groups)){g.sort(compareRank);g.forEach((s,i)=>{s.categoryRank=i+1;s.categoryUniverseSize=g.length;});}
}


function addMonths(date,months){const d=new Date(`${date}T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+months);return d.toISOString().slice(0,10);}
function priceOnOrBefore(history,date,maxGapDays=20,field='adjustedClose'){
  const target=new Date(`${date}T23:59:59Z`).getTime(); let best=null;
  for(const row of history||[]){const t=new Date(`${row.date}T00:00:00Z`).getTime();if(t<=target&&(!best||t>best.t)){const px=Number(row[field]??row.close);if(px>0)best={t,px};}}
  if(!best)return null; return (target-best.t)/86400000<=maxGapDays?best.px:null;
}
function trailingAdjustedReturn(history,asOf,months){const a=priceOnOrBefore(history,addMonths(asOf,-months),20,'adjustedClose'),b=priceOnOrBefore(history,asOf,12,'adjustedClose');return a>0&&b>0?b/a-1:null;}
function liveMomentum(history,spyHistory){
  const last=(history||[]).at(-1); if(!last)return {strong:false,stock3:null,stock6:null,stock12:null,spy6:null,spy12:null,rel6:null,rel12:null};
  const asOf=last.date,stock3=trailingAdjustedReturn(history,asOf,3),stock6=trailingAdjustedReturn(history,asOf,6),stock12=trailingAdjustedReturn(history,asOf,12),spy6=trailingAdjustedReturn(spyHistory,asOf,6),spy12=trailingAdjustedReturn(spyHistory,asOf,12);
  const rel6=Number.isFinite(stock6)&&Number.isFinite(spy6)?stock6-spy6:null,rel12=Number.isFinite(stock12)&&Number.isFinite(spy12)?stock12-spy12:null;
  const strong=Number.isFinite(stock3)&&stock3>0&&Number.isFinite(rel6)&&rel6>0&&Number.isFinite(rel12)&&rel12>0&&(rel6>=.05||rel12>=.05);
  return {asOf,strong,stock3,stock6,stock12,spy6,spy12,rel6,rel12};
}
function economicSecurityGroup(ticker){
  const t=String(ticker||'').toUpperCase();
  if(t==='GOOG'||t==='GOOGL')return 'ALPHABET';
  return t;
}
function enforceMutuallyExclusiveShareClasses(stocks){
  const byGroup=new Map();
  for(const s of stocks||[]){const g=economicSecurityGroup(s.ticker);if(!byGroup.has(g))byGroup.set(g,[]);byGroup.get(g).push(s);}
  for(const group of byGroup.values()){
    if(group.length<2)continue;
    const actionable=group.filter(s=>s.newPositionAction==='BUY').sort((a,b)=>(a.overallRank||Infinity)-(b.overallRank||Infinity)||(b.expectedCAGR||-Infinity)-(a.expectedCAGR||-Infinity));
    if(actionable.length<2)continue;
    const keep=actionable[0];
    for(const s of actionable.slice(1)){
      s.newPositionAction='PASS';
      s.portfolioAction=s.existingHolderAction||'HOLD';
      s.suggestedInitialWeight=null;
      s.shareClassDuplicateOf=keep.ticker;
      s.portfolioPolicy={...(s.portfolioPolicy||{}),newPositionAction:'PASS',portfolioAction:s.portfolioAction,suggestedInitialWeight:null,shareClassDuplicateOf:keep.ticker,holderReason:`Do not open ${s.ticker} while ${keep.ticker} is the preferred Alphabet share class; they represent the same underlying company.`};
      s.decisionDashboard=s.decisionDashboard||{};
      s.decisionDashboard.positionTier='Duplicate share class — no new position';
      s.decisionDashboard.suggestedWeight='—';
    }
  }
}

function applyLivePortfolioPolicy(stocks){
  for(const s of stocks){
    const g=livePortfolioGuidance(s,s.momentum||{});
    s.portfolioPolicy=g;
    s.portfolioAction=g.portfolioAction;
    s.newPositionAction=g.newPositionAction;
    s.existingHolderAction=g.existingHolderAction;
    s.suggestedInitialWeight=g.suggestedInitialWeight;
    s.rideWinner=g.existingHolderAction==='RIDE WINNER';
    s.decisionDashboard=s.decisionDashboard||{};
    s.decisionDashboard.positionTier=g.entryEligible?(g.suggestedInitialWeight>=.08?'High conviction':g.suggestedInitialWeight>=.05?'Core':'Starter'):(g.strongMomentum?'Ride winner':'No new position');
    s.decisionDashboard.suggestedWeight=Number.isFinite(g.suggestedInitialWeight)?`${(g.suggestedInitialWeight*100).toFixed(0)}% initial`:(g.strongMomentum?'Let winner run':'—');
  }
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

  const spyHistory=await fetchBacktestHistory('SPY',2).catch(()=>[]);
  if(!spyHistory.length)console.warn('SPY history unavailable: live Ride Winner momentum will fail closed.');
  const stocks=[];
  for(const stock of records){
    const forecast=buildForecast(stock); const quality=computeQuality(stock,forecast); const valuation=valuate(stock,forecast,quality); const decision=rateStock(stock,forecast,quality,valuation);
    const rec=flattenRecord(stock,forecast,quality,valuation,decision); rec.momentum=liveMomentum(stock.priceHistory||[],spyHistory); stocks.push(rec);
  }
  rank(stocks);
  applyLivePortfolioPolicy(stocks);
  enforceMutuallyExclusiveShareClasses(stocks);
  const validation=validateUniverse(stocks); writeJson('validation-report.json',validation); console.log(`Validation: ${validation.passed?'passed':'FAILED'} (${validation.issues.length} issue(s)).`);
  if(!validation.passed){throw new Error(`Validation failed: ${validation.issues.slice(0,10).map(x=>`${x.ticker}:${x.type}`).join(', ')}`);}
  const output={generatedAt:new Date().toISOString(),count:stocks.length,modelVersion:'simple-v12.38-alpha-gated-quality-basket-ranking',stocks}; writeJson('results.json',output);
  const historyFile=writeProspectiveSnapshot(__dirname,output);
  if(historyFile) console.log(`Saved prospective backtest snapshot: ${path.relative(__dirname,historyFile)}`);
  diag.finishedAt=new Date().toISOString();diag.scored=stocks.length;writeJson('screener-diagnostics.json',diag);
  console.log(`Done. Wrote ${stocks.length} stocks using the simplified one-path model.`);
}
run().catch(e=>{console.error(e);process.exit(1);});
