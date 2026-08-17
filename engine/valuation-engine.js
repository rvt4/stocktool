'use strict';
const { HORIZON_YEARS, MARKET_RETURN, sectorConfig, clamp, median } = require('./config');

function cagr(p,f){if(!(p>0)||!(f>0))return null;return Math.pow(f/p,1/HORIZON_YEARS)-1;}
function pv(v,r,n){return v/Math.pow(1+r,n);}
function finite(v){if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function requiredReturn(q,cat){let r=MARKET_RETURN;if(cat==='Hyper Growth')r+=.02;else if(cat==='Growth')r+=.01;if((q?.confidenceScore||50)<60)r+=.01;if((q?.protectionScore||50)<45)r+=.01;return clamp(r,.09,.14);}
function blend(items){const v=items.filter(x=>Number.isFinite(x.value)&&x.value>0&&x.weight>0);if(!v.length)return null;const w=v.reduce((s,x)=>s+x.weight,0);return v.reduce((s,x)=>s+x.value*x.weight,0)/w;}
function weightedAverage(items){const v=items.filter(x=>Number.isFinite(x.value)&&x.weight>0);if(!v.length)return null;const w=v.reduce((s,x)=>s+x.weight,0);return w>0?v.reduce((s,x)=>s+x.value*x.weight,0)/w:null;}
function recentMedian(values,n=4){return median(values.slice(-n).filter(x=>Number.isFinite(x)&&x>0));}
function safeMultiple(v,lo,hi){if(!(Number.isFinite(v)&&v>0))return null;return clamp(v,lo*.75,hi*1.50);}
function weightedMedian(items){
  const v=items.filter(x=>Number.isFinite(x.value)&&x.weight>0).sort((a,b)=>a.value-b.value);
  const total=v.reduce((s,x)=>s+x.weight,0); if(!total)return null;
  let acc=0; for(const x of v){acc+=x.weight;if(acc>=total/2)return x.value;} return v.at(-1)?.value??null;
}

// Terminal multiples may normalize, but most of a five-year return must come from the
// business rather than a heroic re-rating. The guardrail is generic and sector-aware.
function boundedExit(current,justified,lo,hi){
  let j=clamp(justified,lo,hi);
  if(Number.isFinite(current)&&current>0){
    const sane=clamp(current,lo*.65,hi*1.5);
    j=.70*j+.30*sane;
    j=clamp(j,Math.max(lo,sane*.60),Math.min(hi,sane*1.10));
  }
  return j;
}

function normalizedOperatingBase(stock,forecast){
  const years=stock.financials?.years||[], last=years.at(-1)||{};
  const revenue=finite(last.revenue), shares=finite(last.sharesOutTTM);
  const bridge=forecast.forecastBridge?.margins||{};
  const fcfMargin=finite(bridge.fcfNormalized), ebitdaMargin=finite(bridge.ebitdaNormalized), netMargin=finite(bridge.netNormalized);
  const perShare=(margin)=>revenue>0&&shares>0&&Number.isFinite(margin)&&margin>0?revenue*margin/shares:null;
  return {revenue,shares,fcfPerShare:perShare(fcfMargin),eps:perShare(netMargin),ebitda:revenue>0&&Number.isFinite(ebitdaMargin)&&ebitdaMargin>0?revenue*ebitdaMargin:null,margins:{fcf:fcfMargin,ebitda:ebitdaMargin,net:netMargin}};
}

function normalizedFinancialEPS(years,last){
  const eps=[];
  for(const y of years.slice(-5)){
    const reported=finite(y?.dilutedEPS), ni=finite(y?.netIncome), sh=finite(y?.sharesOutTTM);
    const implied=ni!=null&&sh>0?ni/sh:null, v=reported>0?reported:(implied>0?implied:null);
    if(Number.isFinite(v)&&v>0)eps.push(v);
  }
  const normalized=recentMedian(eps,4), latestReported=finite(last?.dilutedEPS);
  const latest=latestReported>0?latestReported:(finite(last?.netIncome)>0&&finite(last?.sharesOutTTM)>0?finite(last.netIncome)/finite(last.sharesOutTTM):null);
  if(!(normalized>0))return latest>0?latest:null;
  return latest>0?(.70*normalized+.30*latest):normalized;
}

function marginSeries(years,field){
  return years.slice(-5).map(y=>{const r=finite(y?.revenue),n=finite(y?.[field]);return r>0&&n!=null?n/r:null;}).filter(Number.isFinite);
}
function dispersion(values){
  const v=values.filter(Number.isFinite); if(v.length<2)return .10;
  const m=median(v); if(!Number.isFinite(m))return .10;
  return median(v.map(x=>Math.abs(x-m)))??.10;
}

// V7: decide how much each method deserves to matter from the economics/data, not from
// the ticker. A method can still be shown while carrying little weight if the underlying
// metric is distorted or unusually unstable.
function methodReliability(stock,forecast,kind,base,future,quality){
  const years=stock.financials?.years||[], bridge=forecast.forecastBridge?.margins||{};
  const conf=clamp((quality?.confidenceScore??60)/100,.35,1);
  const fcfDisp=dispersion(marginSeries(years,'fcf'));
  const netDisp=dispersion(marginSeries(years,'netIncome'));
  const ebitdaDisp=dispersion(marginSeries(years,'ebitda'));
  const fcfM=finite(bridge.fcfNormalized), netM=finite(bridge.netNormalized), ebitdaM=finite(bridge.ebitdaNormalized);
  const dilution=Math.max(0,finite(forecast.dilutionRate)||0);
  let reliability=.75*conf, reasons=[];

  if(kind==='FCF'){
    reliability*=clamp(1-fcfDisp/.12,.45,1);
    if(bridge.abnormalCapexCycle){reliability*=.88;reasons.push('capex_cycle_normalized');}
    if(Number.isFinite(fcfM)&&fcfM>0)reliability*=1.05;
  } else if(kind==='EPS'){
    reliability*=clamp(1-netDisp/.10,.40,1);
    // If cash economics are much stronger than reported earnings economics, GAAP EPS is
    // likely a noisier valuation anchor (amortization, acquisition accounting, tax mix,
    // investment-cycle effects, etc.). Do not delete EPS; reduce its influence.
    if(Number.isFinite(fcfM)&&fcfM>.04&&Number.isFinite(netM)&&netM>=0){
      const gap=fcfM-netM;
      if(gap>.10){reliability*=.45;reasons.push('cash_earnings_divergence');}
      else if(gap>.06){reliability*=.65;reasons.push('cash_earnings_divergence');}
    }
    if(dilution>.03){reliability*=.90;reasons.push('elevated_dilution');}
  } else if(kind==='EBITDA'){
    reliability*=clamp(1-ebitdaDisp/.12,.45,1);
    const debt=finite(years.at(-1)?.totalDebt)||finite(years.at(-1)?.longTermDebt)||0;
    const cash=finite(years.at(-1)?.cash)||0;
    const ebitda=finite(base?.ebitda);
    const leverage=ebitda>0?(debt-cash)/ebitda:null;
    if(Number.isFinite(leverage)&&leverage>3){reliability*=.65;reasons.push('high_leverage');}
  } else if(kind==='SALES'){
    reliability*=.55;
    if(Number.isFinite(ebitdaM)&&ebitdaM>.08)reliability*=.85;
    reasons.push('profitability_fallback');
  } else if(kind==='FINANCIAL_EPS'){
    reliability*=.90;
  }

  const b=finite(base), f=finite(future);
  if(b>0&&f>0){
    const metricGrowth=Math.pow(f/b,1/HORIZON_YEARS)-1;
    if(metricGrowth>.35||metricGrowth<-.20){reliability*=.65;reasons.push('metric_growth_extreme');}
  }
  return {score:clamp(reliability,.12,1),reasons};
}

function addMethod(methods,{name,target,weight,reliability=1,audit,price}){
  if(!(Number.isFinite(target)&&target>0&&Number.isFinite(price)&&price>0))return;
  const implied=cagr(price,target);
  if(!Number.isFinite(implied))return;
  // Do not silently delete an otherwise valid method just because it implies >25% CAGR.
  // That created a directional bias: upside methods vanished while downside methods stayed.
  // Keep the evidence, but progressively reduce its influence when the implied return is
  // unusually extreme. Only truly pathological outcomes are excluded.
  if(implied>1.00)return;
  let extremityWeight=1;
  if(implied>.45||implied<-.35)extremityWeight=.20;
  else if(implied>.35||implied<-.25)extremityWeight=.40;
  else if(implied>.25||implied<-.18)extremityWeight=.70;
  const rel=clamp(reliability,.05,1);
  const effectiveWeight=weight*rel*extremityWeight;
  methods.push({name,target,weight:effectiveWeight,baseWeight:weight,reliability:rel,audit:{...audit,impliedCAGR:implied,extremityWeight,effectiveWeight}});
}

function valuationConsensus(methods,price){
  const valid=methods.map((m,index)=>({m,index,ret:cagr(price,m.outcome)})).filter(x=>Number.isFinite(x.ret)&&x.m.weight>0);
  if(valid.length<3)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:null,outlierGap:null,hasConsensusOutlier:false};

  // Find the tightest pair in CAGR space. With three methods, two independently agreeing
  // while the third is far away is evidence of an anomalous method, not blanket disagreement.
  let best=null;
  for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
    const gap=Math.abs(valid[i].ret-valid[j].ret);
    if(!best||gap<best.gap)best={a:valid[i],b:valid[j],gap};
  }
  if(!best)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:null,outlierGap:null,hasConsensusOutlier:false};
  const center=(best.a.ret+best.b.ret)/2;
  const outsiders=valid.filter(x=>x.index!==best.a.index&&x.index!==best.b.index);
  const nearestOutlierGap=outsiders.length?Math.min(...outsiders.map(x=>Math.abs(x.ret-center))):null;
  // Require a genuinely tight pair and a clearly separated third method. This deliberately
  // avoids declaring an outlier when all methods are simply spread across a wide range.
  const separated=best.gap<=.08&&Number.isFinite(nearestOutlierGap)&&nearestOutlierGap>=Math.max(.10,best.gap*2.25);
  if(!separated)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:best.gap,outlierGap:nearestOutlierGap,hasConsensusOutlier:false};
  return {clusterIndexes:[best.a.index,best.b.index],outlierIndexes:outsiders.map(x=>x.index),pairSpread:best.gap,outlierGap:nearestOutlierGap,hasConsensusOutlier:true};
}

function robustOutcomeBlend(methods,price,consensus=null){
  const valid=methods.map((m,index)=>({...m,index})).filter(m=>Number.isFinite(m.outcome)&&m.outcome>0&&m.weight>0);
  if(!valid.length)return {outcome:null,weights:{}};
  if(valid.length===1)return {outcome:valid[0].outcome,weights:{[valid[0].name]:1}};
  const info=consensus||valuationConsensus(methods,price);
  const cluster=new Set(info.clusterIndexes||[]), outliers=new Set(info.outlierIndexes||[]);
  const returnItems=valid.map(m=>({value:cagr(price,m.outcome),weight:m.weight,index:m.index,name:m.name})).filter(x=>Number.isFinite(x.value));
  const center=weightedMedian(returnItems.map(x=>({value:x.value,weight:x.weight*(outliers.has(x.index)?.08:1)})));
  const adjusted=returnItems.map(x=>{
    const gap=Math.abs(x.value-center);
    let consensusWeight=gap<=.04?1:gap<=.08?.72:gap<=.14?.42:.18;
    if(info.hasConsensusOutlier&&outliers.has(x.index))consensusWeight*=.08;
    else if(info.hasConsensusOutlier&&cluster.has(x.index))consensusWeight=Math.max(consensusWeight,.90);
    return {...x,weight:x.weight*consensusWeight};
  });
  const totalWeight=adjusted.reduce((sum,x)=>sum+x.weight,0);
  const weights=Object.fromEntries(adjusted.map(x=>[x.name,totalWeight>0?x.weight/totalWeight:0]));
  const blendedReturn=weightedAverage(adjusted);
  const outcome=Number.isFinite(blendedReturn)&&blendedReturn>-1?price*Math.pow(1+blendedReturn,HORIZON_YEARS):null;
  return {outcome,weights};
}
// Independent 10-year per-share DCF. Forecast FCF/share already incorporates the
// modeled share-count path, so this is an equity-cash-flow cross-check and does not
// subtract net debt a second time. The DCF produces a fair value today; for the canonical
// future-outcome framework we carry that fair value forward at the required return.
function dcfFairValue(forecast,req){
  const rows=forecast.rows||[];
  if(rows.length!==HORIZON_YEARS||!(req>0))return null;
  const cashflows=rows.map(r=>finite(r.fcfPerShare));
  if(cashflows.filter(x=>Number.isFinite(x)&&x>0).length<Math.max(6,HORIZON_YEARS-2))return null;
  let explicit=0;
  for(let i=0;i<cashflows.length;i++){
    if(!(cashflows[i]>0))return null;
    explicit+=pv(cashflows[i],req,i+1);
  }
  const g=clamp(finite(forecast.terminalGrowth)??.025,.01,Math.min(.05,req-.025));
  if(!(req>g))return null;
  const terminal=cashflows.at(-1)*(1+g)/(req-g);
  const pvTerminal=pv(terminal,req,HORIZON_YEARS);
  const fair=explicit+pvTerminal;
  return fair>0?{fairValue:fair,pvExplicit:explicit,pvTerminal,terminalGrowth:g,terminalShare:pvTerminal/fair}:null;
}

function valuate(stock,forecast,quality){
  const rows=forecast.rows||[], f=rows.at(-1)||{}, years=stock.financials?.years||[], last=years.at(-1)||{};
  const price=finite(stock.price?.current), cfg=sectorConfig(stock.sector), req=requiredReturn(quality,forecast.category);
  const shares0=finite(last.sharesOutTTM), netDebt=(finite(last.totalDebt)||finite(last.longTermDebt)||0)-(finite(last.cash)||0);
  const marketCap=price>0&&shares0>0?price*shares0:null, revenue0=finite(last.revenue)>0?finite(last.revenue):null;
  const q=(quality.qualityScore||50)/100, growth=clamp(forecast.year5OperatingGrowth??forecast.rows?.at(-1)?.revenueGrowth??forecast.sustainableGrowth??forecast.revenueGrowthAnchor,0,.18);
  const methods=[], base=normalizedOperatingBase(stock,forecast);

  if(stock.sector==='Financials'){
    const epsBase=normalizedFinancialEPS(years,last), currentPE=safeMultiple(price>0&&epsBase>0?price/epsBase:null,6,28);
    if(epsBase>0&&currentPE){
      const buybackTailwind=clamp(-(forecast.dilutionRate||0),-.03,.04);
      const analystGrowth=forecast.forecastBridge?.revenue?.analystNext??forecast.forecastBridge?.revenue?.analystCurrent??growth;
      // Growth financials deserve more room for earnings convergence, while mature
      // financials remain conservative. The distinction comes from growth and dilution,
      // not a company-name override.
      const growthFinancial=forecast.category==='Growth'||forecast.category==='Hyper Growth';
      const epsGrowth=clamp((growthFinancial?.72:.60)*analystGrowth+(growthFinancial?.28:.40)*growth+buybackTailwind,-.04,growthFinancial?.20:.16);
      const futureEPS=epsBase*Math.pow(1+epsGrowth,HORIZON_YEARS);
      const justified=cfg.basePE+epsGrowth*(growthFinancial?28:22)+(q-.5)*5;
      const m=boundedExit(currentPE,justified,7,growthFinancial?26:22);
      const rel=methodReliability(stock,forecast,'FINANCIAL_EPS',epsBase,futureEPS,quality);
      addMethod(methods,{name:'Normalized EPS exit',target:futureEPS*m,weight:1,reliability:rel.score,price,audit:{exitMultiple:m,currentMultiple:currentPE,metric:futureEPS,normalizedEPSBase:epsBase,epsGrowth,reliabilityReasons:rel.reasons}});
    }
  } else {
    const normFCF=base.fcfPerShare, normEPS=base.eps, normEBITDA=base.ebitda;
    const currentPFCF=safeMultiple(price>0&&normFCF>0?price/normFCF:null,6,35);
    const currentPE=safeMultiple(price>0&&normEPS>0?price/normEPS:null,6,38);
    const currentEVEBITDA=safeMultiple(marketCap>0&&normEBITDA>0?(marketCap+netDebt)/normEBITDA:null,4,24);

    if(Number(f.fcfPerShare)>0&&currentPFCF){
      const justified=14+growth*38+(q-.5)*8, m=boundedExit(currentPFCF,justified,9,30);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      addMethod(methods,{name:'FCF exit',target:f.fcfPerShare*m,weight:.35,reliability:rel.score,price,audit:{exitMultiple:m,currentMultiple:currentPFCF,metric:f.fcfPerShare,normalizedCurrentMetric:normFCF,reliabilityReasons:rel.reasons}});
    }
    if(Number(f.eps)>0&&currentPE){
      const justified=cfg.basePE+growth*35+(q-.5)*7, m=boundedExit(currentPE,justified,8,32);
      const rel=methodReliability(stock,forecast,'EPS',normEPS,f.eps,quality);
      addMethod(methods,{name:'EPS exit',target:f.eps*m,weight:.22,reliability:rel.score,price,audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps,normalizedCurrentMetric:normEPS,reliabilityReasons:rel.reasons}});
    }
    if(Number(f.ebitda)>0&&Number(f.shares)>0&&currentEVEBITDA){
      const justified=cfg.baseEVEBITDA+growth*18+(q-.5)*4, m=boundedExit(currentEVEBITDA,justified,6,20), equity=f.ebitda*m-netDebt;
      if(equity>0){
        const rel=methodReliability(stock,forecast,'EBITDA',normEBITDA,f.ebitda,quality);
        addMethod(methods,{name:'EV/EBITDA exit',target:equity/f.shares,weight:.13,reliability:rel.score,price,audit:{exitMultiple:m,currentMultiple:currentEVEBITDA,metric:f.ebitda,normalizedCurrentMetric:normEBITDA,reliabilityReasons:rel.reasons}});
      }
    }

    const dcf=dcfFairValue(forecast,req);
    if(dcf){
      const terminalOutcome=dcf.fairValue*Math.pow(1+req,HORIZON_YEARS);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // Terminal-value-heavy DCFs are still useful, but receive less reliability when
      // most of the present value depends on the perpetuity rather than explicit cash flow.
      const terminalPenalty=dcf.terminalShare>.80?.70:(dcf.terminalShare>.70?.85:1);
      addMethod(methods,{name:'10Y DCF',target:terminalOutcome,weight:.30,reliability:rel.score*terminalPenalty,price,audit:{fairValueToday:dcf.fairValue,pvExplicit:dcf.pvExplicit,pvTerminal:dcf.pvTerminal,terminalGrowth:dcf.terminalGrowth,terminalShare:dcf.terminalShare,reliabilityReasons:[...rel.reasons,...(terminalPenalty<1?['terminal_value_concentration']:[])]}});
    }

    if(!methods.length&&Number(f.revenue)>0&&Number(f.shares)>0&&marketCap>0&&revenue0>0){
      const currentEVSales=safeMultiple((marketCap+netDebt)/revenue0,.25,12);
      if(currentEVSales){
        const terminalEbitdaMargin=clamp(Number(f.ebitdaMargin)||0,0,.60), normalizedMargin=Math.max(.04,terminalEbitdaMargin);
        const economicsMultiple=cfg.baseEVEBITDA*normalizedMargin, growthPremium=clamp(growth-.04,0,.21)*10, qualityPremium=(q-.5)*1.25;
        const justified=clamp(economicsMultiple+growthPremium+qualityPremium,.5,10), m=boundedExit(currentEVSales,justified,.5,10), equity=Number(f.revenue)*m-netDebt;
        if(equity>0){
          const rel=methodReliability(stock,forecast,'SALES',revenue0,f.revenue,quality);
          addMethod(methods,{name:'EV/Sales fallback',target:equity/Number(f.shares),weight:1,reliability:rel.score,price,audit:{exitMultiple:m,currentMultiple:currentEVSales,metric:f.revenue,reason:'profitability_methods_unavailable',reliabilityReasons:rel.reasons}});
        }
      }
    }
  }

  const dividends=rows.reduce((s,r)=>s+(finite(r.dividendPerShare)||0),0);
  for(const m of methods){
    m.outcome=Number.isFinite(m.target)?m.target+dividends:null;
    m.audit={...(m.audit||{}),year10Outcome:m.target,fairValueToday:Number.isFinite(m.target)?pv(m.target,req,HORIZON_YEARS):null};
  }
  const consensus=valuationConsensus(methods,price);
  const canonical=robustOutcomeBlend(methods,price,consensus);
  let total=canonical.outcome, expected=cagr(price,total);
  const hasValuation=Number.isFinite(expected)&&expected<=.25&&methods.length>0&&Number.isFinite(total)&&total>0;
  if(!hasValuation){total=null;expected=null;}

  const target=total!=null?Math.max(0,total-dividends):null, fair=total!=null?pv(total,req,HORIZON_YEARS):null;
  // MOS is expressed as upside/downside to fair value from today's price. This is bounded at -100% as fair value approaches zero.
  const mos=fair>0&&price>0?fair/price-1:null, premium=fair>0&&price>0?price/fair-1:null;
  const reliable=methods.map((m,index)=>({m,index})).filter(x=>(x.m.reliability??1)>=.35);
  const agreementEntries=reliable.length>=2?reliable:methods.map((m,index)=>({m,index}));
  const agreementReturns=agreementEntries.map(x=>({index:x.index,ret:cagr(price,x.m.outcome)})).filter(x=>Number.isFinite(x.ret));
  let spread=agreementReturns.length>=2?Math.max(...agreementReturns.map(x=>x.ret))-Math.min(...agreementReturns.map(x=>x.ret)):null;
  let agreement;
  if(consensus.hasConsensusOutlier){
    const clusterReturns=agreementReturns.filter(x=>consensus.clusterIndexes.includes(x.index)).map(x=>x.ret);
    const clusterSpread=clusterReturns.length>=2?Math.max(...clusterReturns)-Math.min(...clusterReturns):consensus.pairSpread;
    // A 2-of-3 consensus is strong evidence, but not identical to three-way agreement.
    // Cap it below perfect agreement while avoiding a misleading 0/100 score.
    agreement=Math.round(85*clamp(1-(clusterSpread??0)/.22,0,1));
    spread=clusterSpread;
  } else {
    agreement=agreementReturns.length>=2?Math.round(100*clamp(1-spread/.22,0,1)):(agreementReturns.length===1?45:0);
  }
  // Business/data confidence and valuation-method agreement answer different questions.
  // Publish both and combine them for decision confidence so a 4/100 method agreement can
  // never masquerade as a 90-confidence investment conclusion.
  const valuationConfidence=Math.round(clamp(.65*(quality.confidenceScore||50)+.35*agreement,0,100));
  const uncertainty=clamp((100-valuationConfidence)/100,.10,.45);
  const bear=total!=null?total*Math.pow(1-(.035+.04*uncertainty),HORIZON_YEARS):null, bull=total!=null?total*Math.pow(1+(.035+.035*uncertainty),HORIZON_YEARS):null;
  const extremeReturn=hasValuation&&(expected<-.30||expected>.22);
  const lowReliability=methods.length>0&&Math.max(...methods.map(m=>m.reliability??0))<.40;

  return {requiredReturn:req,methods,canonicalMethodWeights:canonical.weights,fiveYearPriceTarget:target,tenYearPriceTarget:target,horizonYears:HORIZON_YEARS,cumulativeDividends:dividends,totalShareholderValue:total,expectedCAGR:expected,fairValueEstimate:fair,marginOfSafety:mos,premiumToFairValue:premium,methodAgreementScore:agreement,valuationConfidenceScore:valuationConfidence,valuationConsensus:{hasConsensusOutlier:consensus.hasConsensusOutlier,clusterMethods:consensus.clusterIndexes.map(i=>methods[i]?.name).filter(Boolean),outlierMethods:consensus.outlierIndexes.map(i=>methods[i]?.name).filter(Boolean),clusterSpread:consensus.pairSpread,outlierGap:consensus.outlierGap},bearCAGR:cagr(price,bear),baseCAGR:expected,bullCAGR:cagr(price,bull),netDebt,plausibilityFailure:!hasValuation,extremeReturnFlag:extremeReturn,valuationReviewFlag:extremeReturn?'extreme_blended_return_after_normalization':(consensus.hasConsensusOutlier?'isolated_method_outlier':(agreement<35?'material_method_disagreement':(lowReliability?'low_method_reliability':null)))};
}
module.exports={valuate};
