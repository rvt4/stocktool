'use strict';
/**
 * FreeScreener point-in-time historical CORE backtest.
 *
 * Purpose:
 *   Re-run today's model architecture on historical dates using only SEC facts that
 *   had actually been filed by each as-of date plus historical market prices.
 *
 * Important limitations (published in the output too):
 *   - Historical analyst consensus is intentionally NOT reconstructed. The backtest
 *     therefore exercises the model's SEC/history fallback path, while live forward
 *     snapshots preserve the complete analyst-assisted production model.
 *   - watchlist.json is today's universe, so this first free backtest has survivorship
 *     bias. It is useful for model calibration, but it is not a clean claim of alpha.
 *   - Realized returns are historical price returns from Stooq, not dividend-inclusive
 *     total returns. The benchmark is measured on the same basis (SPY price return).
 *
 * Usage examples:
 *   node backtest.js
 *   BACKTEST_START=2018 BACKTEST_END=2025 BACKTEST_FREQUENCY=annual node backtest.js
 *   BACKTEST_FREQUENCY=quarterly BACKTEST_LIMIT=100 node backtest.js
 */
const fs=require('fs');
const path=require('path');
const {
  fetchSecFacts, parseAnnualFinancials, parseQuarterlyRevenue, recentQuarterYoYGrowth,
  blendedForwardGrowth, fetchStooqHistory, latestDilutedSharesFromFacts,
  normalizeHistoryForCorporateAction, normalizeSecTicker
}=require('./data-fetchers');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {rateStock}=require('./engine/rating-engine');

const MODEL_VERSION='simple-v12.18-backtest-signal-analysis';
const watchlist=JSON.parse(fs.readFileSync(path.join(__dirname,'watchlist.json'),'utf8'));
const START=Number(process.env.BACKTEST_START||2016);
const END=Number(process.env.BACKTEST_END||new Date().getUTCFullYear()-1);
const FREQUENCY=String(process.env.BACKTEST_FREQUENCY||'annual').toLowerCase();
const LIMIT=Math.max(0,Number(process.env.BACKTEST_LIMIT||0));
const RATE_LIMIT_DELAY_MS=Number(process.env.BACKTEST_RATE_LIMIT_DELAY_MS||350);
const HISTORY_YEARS=Math.max(12,new Date().getUTCFullYear()-START+2);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function cagr(a,b,n){return a>0&&b>0&&n>0?Math.pow(b/a,1/n)-1:null;}
function median(a){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}
function isoDate(d){return new Date(d).toISOString().slice(0,10);}

function snapshotDates(){
  const out=[];
  for(let y=START;y<=END;y++){
    if(FREQUENCY==='quarterly'){
      for(const md of ['03-31','06-30','09-30','12-31'])out.push(`${y}-${md}`);
    }else out.push(`${y}-12-31`);
  }
  return out.filter(d=>new Date(d)<=new Date());
}

// Keep only facts that were publicly filed by the simulated date. This is the core
// look-ahead-bias guardrail. We also reject facts whose period ends after the date.
function factsAsOf(raw,asOf){
  const cutoff=String(asOf);
  const out={...raw,facts:{}};
  for(const [taxonomy,tags] of Object.entries(raw?.facts||{})){
    out.facts[taxonomy]={};
    for(const [tag,obj] of Object.entries(tags||{})){
      const units={};
      for(const [unit,arr] of Object.entries(obj?.units||{})){
        units[unit]=(arr||[]).filter(x=>{
          if(x?.filed&&String(x.filed)>cutoff)return false;
          if(x?.end&&String(x.end)>cutoff)return false;
          // If a fact lacks a filing date, require a conservative reporting lag.
          if(!x?.filed&&x?.end){const lag=(new Date(cutoff)-new Date(x.end))/86400000;if(lag<45)return false;}
          return true;
        });
      }
      out.facts[taxonomy][tag]={...obj,units};
    }
  }
  return out;
}
function priceOnOrBefore(history,date,maxGapDays=12){
  const t=new Date(date).getTime(); let best=null;
  for(const p of history||[]){const pt=new Date(p.date).getTime();if(pt<=t&&(!best||pt>best.pt))best={t,pt,p};}
  if(!best)return null;
  return (best.t-best.pt)/86400000<=maxGapDays?finite(best.p.close):null;
}
function addYears(date,years){const d=new Date(date+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()+years);return d.toISOString().slice(0,10);}

function historicalStockFromData(ticker,sector,rawFacts,priceHistory,asOf,diagnostics=null){
  const facts=factsAsOf(rawFacts,asOf);
  const years=parseAnnualFinancials(facts);
  const quarters=parseQuarterlyRevenue(facts);
  if(years.length<2){ if(diagnostics) diagnostics.insufficientFinancialHistory++; return null; }
  if(diagnostics) diagnostics.usableFinancialHistory++;
  const currentPrice=priceOnOrBefore(priceHistory,asOf);
  if(!(currentPrice>0)){ if(diagnostics) diagnostics.missingHistoricalPrice++; return null; }
  if(diagnostics) diagnostics.historicalPriceFound++;
  normalizeHistoryForCorporateAction(years,latestDilutedSharesFromFacts(facts));
  const last=years.at(-1)||{};

  // Historical runs cannot use today's market-cap reconciliation. Prefer reported
  // diluted shares; repair only with NI / diluted EPS when those two filed facts agree.
  if(Number(last.netIncome)!==0&&Number.isFinite(Number(last.dilutedEPS))&&Math.abs(Number(last.dilutedEPS))>1e-6){
    const implied=Math.abs(Number(last.netIncome)/Number(last.dilutedEPS));
    const reported=Number(last.sharesOutTTM);
    const mismatch=reported>0&&implied>0?Math.max(reported/implied,implied/reported):null;
    if(implied>1e5&&implied<1e12&&(!reported||(mismatch!=null&&mismatch>=3.5))){
      last.sharesOutTTM=implied; last.sharesSource='historical_net_income_div_diluted_eps_repair';
    }
  }
  const shares=finite(last.sharesOutTTM);
  if(!(shares>0)){ if(diagnostics) diagnostics.missingShareCount++; return null; }
  if(diagnostics) diagnostics.shareCountFound++;
  const marketCap=currentPrice*shares;
  const eps=finite(last.netIncome)!=null?finite(last.netIncome)/shares:null;
  const pe=eps?currentPrice/eps:null;
  const ev=marketCap+(finite(last.longTermDebt)||0)-(finite(last.cash)||0);
  const evEbitda=finite(last.ebitda)>0?ev/finite(last.ebitda):null;
  const dividendYield=finite(last.dividendPerShare)>0?finite(last.dividendPerShare)/currentPrice:0;
  const fcfYield=finite(last.fcf)!=null&&marketCap>0?finite(last.fcf)/marketCap:null;
  for(const y of years)y.debtToEbitda=finite(y.longTermDebt)!=null&&finite(y.ebitda)>0?finite(y.longTermDebt)/finite(y.ebitda):null;

  let growthYear1=null;
  if(years.length>=2){
    const lookback=Math.min(3,years.length-1), first=years[years.length-1-lookback];
    const trailing=first.revenue>0?Math.pow(last.revenue/first.revenue,1/lookback)-1:null;
    growthYear1=blendedForwardGrowth(trailing,recentQuarterYoYGrowth(quarters));
  }
  const revenueSource=String(last.revenueSource||'');
  const financialLikeRevenue=/PremiumsEarnedNet|InvestmentIncomeInterestAndDividend|InterestAndDividendIncomeOperating|InterestIncomeExpenseNonoperatingNet|RevenuesNetOfInterestExpense/i.test(revenueSource);
  const nciIncomeShare=finite(last.noncontrollingIncomeShare),nci=finite(last.noncontrollingInterest),eq=finite(last.stockholdersEquity);
  const nciBalanceShare=nci!=null&&eq!=null&&Math.abs(eq)+Math.abs(nci)>0?Math.abs(nci)/(Math.abs(eq)+Math.abs(nci)):null;
  const materialNci=(nciIncomeShare!=null&&nciIncomeShare>=.20)||(nciBalanceShare!=null&&nciBalanceShare>=.20);
  return {
    ticker,sector:sector||'Unknown',asOf,
    financials:{years,dataQuality:{
      revenueProxyYears:years.filter(y=>y.revenueIsProxy).length,
      fcfProxyYears:years.filter(y=>y.fcfIsProxy).length,
      missingCapexYears:years.filter(y=>y.fcfUnavailableReason==='missing_capex').length,
      missingEbitdaYears:years.filter(y=>y.operatingIncome!=null&&y.ebitda==null).length,
      shareDenominatorReliable:true,shareDenominatorReason:'point_in_time_sec_or_eps',financialLikeRevenue,
      materialNoncontrollingInterest:materialNci,noncontrollingIncomeShare:nciIncomeShare,
      noncontrollingBalanceShare:nciBalanceShare,latestRevenueSource:revenueSource||null
    }},
    valuation:{pe,forwardPe:pe,evEbitda,fcfYield,marketCap,ev,dividendYield,growthSource:'point_in_time_sec_history'},
    growthYear1,analystEstimates:null,price:{current:currentPrice},quarterly:quarters,
    corporateActionNormalization:null,shareCountReconciliation:{reliable:true,applied:false,reason:'historical_point_in_time'},
    historicalMultiples:{evEbitda:[],forwardPe:[]},earningsCallText:null
  };
}

function compactModel(stock,f,q,v,d){return {
  ticker:stock.ticker,sector:stock.sector,price:stock.price.current,rating:d.rating,
  investmentScore:d.investmentScore,expectedCAGR:v.expectedCAGR,expectedAlpha:d.expectedAlpha,
  fiveYearExpectedCAGR:v.fiveYearExpectedCAGR,bearCAGR:v.bearCAGR,bullCAGR:v.bullCAGR,
  fairValue:v.fairValueEstimate,buyPrice:v.requiredReturnBuyPrice,marginOfSafety:v.marginOfSafety,
  qualityScore:q.qualityScore,moatScore:q.moatScore,pricingPowerScore:q.pricingPowerScore,
  capitalAllocationScore:q.capitalAllocationScore,compounderScore:q.compounderScore,growthQualityScore:q.growthQualityScore,
  protectionScore:q.protectionScore,forecastConfidence:f.forecastReliabilityScore,
  valuationConfidence:v.valuationConfidenceScore,methodAgreement:v.methodAgreementScore,
  methodCount:(v.methods||[]).length,independentEvidenceFamilies:v.independentMethodCount,
  modelSupport:v.modelSupport
};}
function rank(rows){const s=[...rows].sort((a,b)=>(b.investmentScore||0)-(a.investmentScore||0));s.forEach((x,i)=>x.rank=i+1);rows.forEach(x=>x.universeSize=rows.length);}
function attachRealized(row,history,spyHistory,asOf){
  for(const n of [1,3,5,10]){
    const end=addYears(asOf,n), endPx=priceOnOrBefore(history,end), spy0=priceOnOrBefore(spyHistory,asOf), spy1=priceOnOrBefore(spyHistory,end);
    const realized=endPx>0?cagr(row.price,endPx,n):null, bench=spy0>0&&spy1>0?cagr(spy0,spy1,n):null;
    row[`realized${n}YPriceCAGR`]=realized; row[`spy${n}YPriceCAGR`]=bench;
    row[`excess${n}YPriceCAGR`]=realized!=null&&bench!=null?realized-bench:null;
  }
}
function alphaBucket(a){if(!Number.isFinite(a))return 'N/A';if(a>=.10)return '>= +10%';if(a>=.05)return '+5% to +10%';if(a>=0)return '0% to +5%';if(a>=-.05)return '-5% to 0%';return '< -5%';}
function summarize(rows,field='realized1YPriceCAGR'){
  const valid=rows.filter(r=>Number.isFinite(r[field]));
  const by=(keyFn)=>Object.entries(valid.reduce((m,r)=>{const k=keyFn(r);(m[k]??=[]).push(r[field]);return m;},{})).map(([bucket,v])=>({bucket,n:v.length,median:median(v),mean:v.reduce((a,b)=>a+b,0)/v.length}));
  return {n:valid.length,byRating:by(r=>r.rating),byAlpha:by(r=>alphaBucket(r.expectedAlpha)),byRankQuintile:by(r=>`Q${Math.min(5,Math.ceil((r.rank/r.universeSize)*5))}`)};
}

function mean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;}
function pctTrue(a){return a.length?a.filter(Boolean).length/a.length:null;}
function percentileSorted(v,p){if(!v.length)return null;const i=(v.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return lo===hi?v[lo]:v[lo]+(v[hi]-v[lo])*(i-lo);}
function outcomeStats(rows,n){
  const excess=`excess${n}YPriceCAGR`,realized=`realized${n}YPriceCAGR`;
  const v=rows.filter(r=>Number.isFinite(r[excess])&&Number.isFinite(r[realized]));
  return {n:v.length,medianRealized:median(v.map(r=>r[realized])),medianExcess:median(v.map(r=>r[excess])),meanExcess:mean(v.map(r=>r[excess])),beatSpyRate:pctTrue(v.map(r=>r[excess]>0)),hit10Rate:pctTrue(v.map(r=>r[realized]>=.10)),hit15Rate:pctTrue(v.map(r=>r[realized]>=.15))};
}
function groupedOutcome(rows,keyFn,n){
  const groups={}; for(const r of rows){const k=keyFn(r);if(k==null)continue;(groups[k]??=[]).push(r);}
  return Object.entries(groups).map(([bucket,v])=>({bucket,...outcomeStats(v,n)}));
}
function scoreDeciles(rows,field,n){
  const vals=rows.map(r=>finite(r[field])).filter(Number.isFinite).sort((a,b)=>a-b); if(vals.length<10)return [];
  const cuts=Array.from({length:9},(_,i)=>percentileSorted(vals,(i+1)/10));
  return groupedOutcome(rows,r=>{const x=finite(r[field]);if(x==null)return null;let d=1;while(d<=9&&x>cuts[d-1])d++;return `D${d}`;},n).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1)));
}
function buildSignalAnalysis(rows){
  const horizons=[1,3,5];
  const metrics=['expectedAlpha','investmentScore','qualityScore','moatScore','capitalAllocationScore','compounderScore','growthQualityScore','pricingPowerScore','protectionScore','forecastConfidence','valuationConfidence','marginOfSafety'];
  const byHorizon={};
  for(const n of horizons){
    byHorizon[n]={
      overall:outcomeStats(rows,n),
      alphaBuckets:groupedOutcome(rows,r=>alphaBucket(r.expectedAlpha),n),
      rankDeciles:groupedOutcome(rows,r=>`D${Math.min(10,Math.max(1,Math.ceil((r.rank/r.universeSize)*10)))}`,n).sort((a,b)=>Number(a.bucket.slice(1))-Number(b.bucket.slice(1))),
      ratings:groupedOutcome(rows,r=>r.rating,n),
      metrics:Object.fromEntries(metrics.map(m=>[m,scoreDeciles(rows,m,n)])),
      alphaRank:groupedOutcome(rows,r=>{const a=finite(r.expectedAlpha);if(a==null)return null;const ab=a>=.10?'Alpha >=10%':a>=.05?'Alpha 5-10%':a>=0?'Alpha 0-5%':'Alpha <0%';const rd=Math.min(10,Math.max(1,Math.ceil((r.rank/r.universeSize)*10)));const rb=rd<=2?'Top 20% rank':rd<=5?'Rank 21-50%':'Bottom 50% rank';return `${ab} | ${rb}`;},n),
      alphaQualityConfidence:groupedOutcome(rows,r=>{const a=finite(r.expectedAlpha),q=finite(r.qualityScore),fc=finite(r.forecastConfidence),vc=finite(r.valuationConfidence);if([a,q,fc,vc].some(x=>x==null))return null;return a>=.05&&q>=75&&fc>=75&&vc>=70?'Alpha>=5 + Q>=75 + Conf strong':a>=.05?'Alpha>=5 other':'Alpha<5';},n),
      byCohort:groupedOutcome(rows,r=>String(r.asOf||'').slice(0,4),n).sort((a,b)=>a.bucket.localeCompare(b.bucket))
    };
  }
  return {description:'Point-in-time signal validation. Excess return is realized stock price CAGR minus SPY price CAGR over the same horizon.',byHorizon};
}

async function main(){
  fs.mkdirSync(path.join(__dirname,'data'),{recursive:true});
  const dates=snapshotDates(), universe=LIMIT?watchlist.slice(0,LIMIT):watchlist;
  console.log(`Historical core backtest: ${universe.length} tickers × ${dates.length} ${FREQUENCY} dates (${dates[0]} to ${dates.at(-1)}).`);
  console.log('Historical analyst estimates are intentionally excluded to avoid look-ahead bias.');
  const spyHistory=await fetchStooqHistory('SPY',HISTORY_YEARS);
  if(!spyHistory.length) throw new Error('SPY historical price history was empty; cannot benchmark backtest.');
  const snapshots=new Map(dates.map(d=>[d,[]])); const errors=[];
  const diagnostics={
    tickerDateAttempts:0,tickersFetched:0,tickerFetchFailures:0,
    usableFinancialHistory:0,insufficientFinancialHistory:0,
    historicalPriceFound:0,missingHistoricalPrice:0,
    shareCountFound:0,missingShareCount:0,
    modelRuns:0,modelFailures:0,missingExpectedCAGR:0,modeledObservations:0
  };
  const skipExamples=[];
  for(let i=0;i<universe.length;i++){
    const {ticker,sector}=universe[i];
    try{
      const sec=normalizeSecTicker(ticker);
      const [facts,history]=await Promise.all([fetchSecFacts(sec),fetchStooqHistory(sec,HISTORY_YEARS)]);
      diagnostics.tickersFetched++;
      if(!history.length && skipExamples.length<20) skipExamples.push({ticker,reason:'empty_stooq_history'});
      for(const asOf of dates){
        diagnostics.tickerDateAttempts++;
        const before={...diagnostics};
        const stock=historicalStockFromData(ticker,sector,facts,history,asOf,diagnostics);
        if(!stock){
          if(skipExamples.length<20){
            let reason='historical_stock_unavailable';
            if(diagnostics.insufficientFinancialHistory>before.insufficientFinancialHistory) reason='insufficient_financial_history';
            else if(diagnostics.missingHistoricalPrice>before.missingHistoricalPrice) reason='missing_historical_price';
            else if(diagnostics.missingShareCount>before.missingShareCount) reason='missing_share_count';
            skipExamples.push({ticker,asOf,reason});
          }
          continue;
        }
        try{
          diagnostics.modelRuns++;
          const f=buildForecast(stock),q=computeQuality(stock,f),v=valuate(stock,f,q),d=rateStock(stock,f,q,v);
          if(!Number.isFinite(v.expectedCAGR)){ diagnostics.missingExpectedCAGR++; if(skipExamples.length<20)skipExamples.push({ticker,asOf,reason:'missing_expected_cagr'}); continue; }
          const row=compactModel(stock,f,q,v,d); attachRealized(row,history,spyHistory,asOf); snapshots.get(asOf).push(row); diagnostics.modeledObservations++;
        }catch(e){diagnostics.modelFailures++;errors.push({ticker,asOf,error:e.message}); if(skipExamples.length<20)skipExamples.push({ticker,asOf,reason:'model_failure',error:e.message});}
      }
    }catch(e){diagnostics.tickerFetchFailures++;errors.push({ticker,error:e.message}); if(skipExamples.length<20)skipExamples.push({ticker,reason:'ticker_fetch_failure',error:e.message});}
    if((i+1)%25===0){
      console.log(`Fetched ${i+1}/${universe.length}; modeled ${diagnostics.modeledObservations} point-in-time observations.`);
      console.log(`  diagnostics: attempts=${diagnostics.tickerDateAttempts}, financials=${diagnostics.usableFinancialHistory}, prices=${diagnostics.historicalPriceFound}, shares=${diagnostics.shareCountFound}, modelRuns=${diagnostics.modelRuns}, failures=${diagnostics.modelFailures}`);
    }
    if(RATE_LIMIT_DELAY_MS>0)await sleep(RATE_LIMIT_DELAY_MS);
  }
  console.log('Backtest diagnostics:', JSON.stringify(diagnostics));
  if(skipExamples.length) console.log('Representative skips:', JSON.stringify(skipExamples.slice(0,10)));
  const flat=[]; const snapshotOutput=[];
  for(const asOf of dates){const rows=snapshots.get(asOf);rank(rows);flat.push(...rows.map(r=>({...r,asOf})));snapshotOutput.push({asOf,count:rows.length,rows});}
  const output={
    generatedAt:new Date().toISOString(),modelVersion:MODEL_VERSION,backtestMode:'historical_core_point_in_time',frequency:FREQUENCY,startYear:START,endYear:END,
    assumptions:{analystEstimates:'excluded_historical_unavailable',universe:'current_watchlist_survivorship_biased',returns:'Stooq price CAGR; dividends not included',benchmark:'SPY price CAGR',secCutoff:'facts must be filed by as-of date'},
    observations:flat.length,diagnostics,skipExamples,summary1Y:summarize(flat,'realized1YPriceCAGR'),summary3Y:summarize(flat,'realized3YPriceCAGR'),summary5Y:summarize(flat,'realized5YPriceCAGR'),signalAnalysis:buildSignalAnalysis(flat),errors:errors.slice(0,500),snapshots:snapshotOutput
  };
  const p=path.join(__dirname,'data','backtest-results.json'),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(output));fs.renameSync(tmp,p);
  console.log(`Done. Wrote ${flat.length} historical observations to data/backtest-results.json.`);
}
if(require.main===module) main().catch(e=>{console.error(e);process.exit(1);});
module.exports={factsAsOf,priceOnOrBefore,snapshotDates,historicalStockFromData,alphaBucket,summarize,buildSignalAnalysis};
