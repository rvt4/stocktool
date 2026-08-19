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

// Terminal multiples may normalize, but most of a ten-year return must come from the
// business rather than a heroic re-rating. The guardrail is generic and sector-aware.
function boundedExit(current,justified,lo,hi){
  // Intrinsic value must not be mechanically anchored to today's market multiple.
  // Current multiples remain audit context only. Terminal multiples are determined from
  // modeled mature economics, growth and quality; changing only today's stock price must
  // not change the modeled business value.
  return clamp(justified,lo,hi);
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

function addMethod(methods,{name,target,weight,reliability=1,audit,price,family=null,cashFlowInclusive=false}){
  if(!(Number.isFinite(target)&&target>0&&Number.isFinite(price)&&price>0))return;
  const implied=cagr(price,target);
  if(!Number.isFinite(implied))return;
  const rel=clamp(reliability,.05,1);
  const effectiveWeight=weight*rel;
  methods.push({name,target,weight:effectiveWeight,baseWeight:weight,reliability:rel,family:family||name,cashFlowInclusive,audit:{...audit,impliedCAGR:implied,effectiveWeight}});
}

function valuationConsensus(methods,price){
  // Consensus is measured in intrinsic-outcome space, not return-from-current-price space.
  // That keeps the canonical fair value independent of today's quote.
  const valid=methods.map((m,index)=>({m,index,x:Number.isFinite(m.outcome)&&m.outcome>0?Math.log(m.outcome):null})).filter(v=>Number.isFinite(v.x)&&v.m.weight>0);
  if(valid.length<3)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:null,outlierGap:null,hasConsensusOutlier:false};
  let best=null;
  for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
    const gap=Math.abs(valid[i].x-valid[j].x);
    if(!best||gap<best.gap)best={a:valid[i],b:valid[j],gap};
  }
  if(!best)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:null,outlierGap:null,hasConsensusOutlier:false};
  const center=(best.a.x+best.b.x)/2;
  const outsiders=valid.filter(x=>x.index!==best.a.index&&x.index!==best.b.index);
  const nearestOutlierGap=outsiders.length?Math.min(...outsiders.map(x=>Math.abs(x.x-center))):null;
  const separated=best.gap<=Math.log(1.22)&&Number.isFinite(nearestOutlierGap)&&nearestOutlierGap>=Math.max(Math.log(1.35),best.gap*2.25);
  if(!separated)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:best.gap,outlierGap:nearestOutlierGap,hasConsensusOutlier:false};
  return {clusterIndexes:[best.a.index,best.b.index],outlierIndexes:outsiders.map(x=>x.index),pairSpread:best.gap,outlierGap:nearestOutlierGap,hasConsensusOutlier:true};
}

function robustOutcomeBlend(methods,price,consensus=null){
  const valid=methods.map((m,index)=>({...m,index})).filter(m=>Number.isFinite(m.outcome)&&m.outcome>0&&m.weight>0);
  if(!valid.length)return {outcome:null,weights:{}};
  if(valid.length===1)return {outcome:valid[0].outcome,weights:{[valid[0].name]:1}};
  const info=consensus||valuationConsensus(methods,price);
  const outliers=new Set(info.outlierIndexes||[]);
  const items=valid.map(m=>({value:Math.log(m.outcome),weight:m.weight,index:m.index,name:m.name,outcome:m.outcome}));
  const center=weightedMedian(items.map(x=>({value:x.value,weight:x.weight*(outliers.has(x.index)?.08:1)})));
  const adjusted=items.map(x=>{
    const gap=Math.abs(x.value-center);
    let consensusWeight=gap<=Math.log(1.15)?1:gap<=Math.log(1.30)?.72:gap<=Math.log(1.60)?.42:.18;
    if(info.hasConsensusOutlier&&outliers.has(x.index))consensusWeight=Math.min(consensusWeight,.10);
    return {...x,adjustedWeight:x.weight*consensusWeight};
  });
  const totalW=adjusted.reduce((s,x)=>s+x.adjustedWeight,0);
  if(!(totalW>0))return {outcome:null,weights:{}};
  const outcome=adjusted.reduce((s,x)=>s+x.outcome*x.adjustedWeight,0)/totalW;
  return {outcome,weights:Object.fromEntries(adjusted.map(x=>[x.name,x.adjustedWeight/totalW]))};
}

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
    if(epsBase>0){
      const buybackTailwind=clamp(-(forecast.dilutionRate||0),-.03,.04);
      const analystGrowth=forecast.forecastBridge?.revenue?.analystNext??forecast.forecastBridge?.revenue?.analystCurrent??growth;
      // Growth financials deserve more room for earnings convergence, while mature
      // financials remain conservative. The distinction comes from growth and dilution,
      // not a company-name override.
      const growthFinancial=forecast.category==='Growth'||forecast.category==='Hyper Growth';
      const epsGrowth=clamp((growthFinancial?.72:.60)*analystGrowth+(growthFinancial?.28:.40)*growth+buybackTailwind,-.04,growthFinancial?.20:.16);
      const futureEPS=epsBase*Math.pow(1+epsGrowth,HORIZON_YEARS);
      const stableG=clamp(forecast.terminalGrowth,.01,Math.min(.045,req-.03));
      const stableROE=clamp(.10+.10*q,.10,.20);
      const payout=clamp(1-stableG/stableROE,.35,.85);
      const fundamentalPE=payout*(1+stableG)/Math.max(.035,req-stableG);
      const justified=.70*fundamentalPE+.30*(cfg.basePE+epsGrowth*(growthFinancial?12:8)+(q-.5)*4);
      const m=boundedExit(currentPE,justified,7,growthFinancial?24:21);
      const rel=methodReliability(stock,forecast,'FINANCIAL_EPS',epsBase,futureEPS,quality);
      addMethod(methods,{name:'Normalized EPS exit',target:futureEPS*m,weight:1,reliability:rel.score,price,family:'earnings',audit:{exitMultiple:m,currentMultiple:currentPE,metric:futureEPS,normalizedEPSBase:epsBase,epsGrowth,reliabilityReasons:rel.reasons}});
    }
  } else {
    const normFCF=base.fcfPerShare, normEPS=base.eps, normEBITDA=base.ebitda;
    const currentPFCF=safeMultiple(price>0&&normFCF>0?price/normFCF:null,6,35);
    const currentPE=safeMultiple(price>0&&normEPS>0?price/normEPS:null,6,38);
    const currentEVEBITDA=safeMultiple(marketCap>0&&normEBITDA>0?(marketCap+netDebt)/normEBITDA:null,4,24);

    if(Number(f.fcfPerShare)>0&&normFCF>0){
      const stableG=clamp(forecast.terminalGrowth,.01,Math.min(.045,req-.03));
      const fundamental=(1+stableG)/Math.max(.035,req-stableG);
      const justified=.75*fundamental+.25*(13+growth*18+(q-.5)*6), m=boundedExit(currentPFCF,justified,8,26);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // A terminal FCF multiple by itself discards the first ten years of owner cash flow.
      // Value the explicit FCF stream plus the year-10 exit value, then express that PV
      // as a year-10 equivalent so it can be blended consistently with other methods.
      const explicitFCFPV=rows.reduce((sum,r,i)=>sum+(Number(r.fcfPerShare)>0?pv(Number(r.fcfPerShare),req,i+1):0),0);
      const terminalFCFValue=f.fcfPerShare*m;
      const terminalFCFPV=pv(terminalFCFValue,req,HORIZON_YEARS);
      const fcfExitFair=explicitFCFPV+terminalFCFPV;
      const fcfExitOutcome=fcfExitFair*Math.pow(1+req,HORIZON_YEARS);
      addMethod(methods,{name:'FCF exit',target:fcfExitOutcome,weight:.30,reliability:rel.score,price,family:'cashflow',cashFlowInclusive:true,audit:{exitMultiple:m,currentMultiple:currentPFCF,metric:f.fcfPerShare,normalizedCurrentMetric:normFCF,pvExplicit:explicitFCFPV,pvTerminalExit:terminalFCFPV,terminalExitValue:terminalFCFValue,reliabilityReasons:rel.reasons}});
    }
    if(Number(f.eps)>0&&normEPS>0){
      const stableG=clamp(forecast.terminalGrowth,.01,Math.min(.045,req-.03));
      const stableROE=clamp(.10+.11*q,.10,.21);
      const payout=clamp(1-stableG/stableROE,.30,.85);
      const fundamental=payout*(1+stableG)/Math.max(.035,req-stableG);
      const justified=.65*fundamental+.35*(cfg.basePE+growth*14+(q-.5)*5), m=boundedExit(currentPE,justified,7,28);
      const rel=methodReliability(stock,forecast,'EPS',normEPS,f.eps,quality);
      addMethod(methods,{name:'EPS exit',target:f.eps*m,weight:.20,reliability:rel.score,price,family:'earnings',audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps,normalizedCurrentMetric:normEPS,reliabilityReasons:rel.reasons}});
    }
    if(Number(f.ebitda)>0&&Number(f.shares)>0&&normEBITDA>0){
      const justified=cfg.baseEVEBITDA+growth*10+(q-.5)*3, m=boundedExit(currentEVEBITDA,justified,5,18), equity=f.ebitda*m-netDebt;
      if(equity>0){
        const rel=methodReliability(stock,forecast,'EBITDA',normEBITDA,f.ebitda,quality);
        addMethod(methods,{name:'EV/EBITDA exit',target:equity/f.shares,weight:.10,reliability:rel.score,price,family:'enterprise',audit:{exitMultiple:m,currentMultiple:currentEVEBITDA,metric:f.ebitda,normalizedCurrentMetric:normEBITDA,reliabilityReasons:rel.reasons}});
      }
    }

    const dcf=dcfFairValue(forecast,req);
    if(dcf){
      const terminalOutcome=dcf.fairValue*Math.pow(1+req,HORIZON_YEARS);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // Terminal-value-heavy DCFs are still useful, but receive less reliability when
      // most of the present value depends on the perpetuity rather than explicit cash flow.
      const terminalPenalty=dcf.terminalShare>.80?.70:(dcf.terminalShare>.70?.85:1);
      addMethod(methods,{name:'10Y DCF',target:terminalOutcome,weight:.40,reliability:rel.score*terminalPenalty,price,family:'cashflow',cashFlowInclusive:true,audit:{fairValueToday:dcf.fairValue,pvExplicit:dcf.pvExplicit,pvTerminal:dcf.pvTerminal,terminalGrowth:dcf.terminalGrowth,terminalShare:dcf.terminalShare,reliabilityReasons:[...rel.reasons,...(terminalPenalty<1?['terminal_value_concentration']:[])]}});
    }

    if(!methods.length&&Number(f.revenue)>0&&Number(f.shares)>0&&revenue0>0){
      const currentEVSales=marketCap>0?safeMultiple((marketCap+netDebt)/revenue0,.25,12):null;
      {
        const terminalEbitdaMargin=clamp(Number(f.ebitdaMargin)||0,0,.60), normalizedMargin=Math.max(.04,terminalEbitdaMargin);
        const economicsMultiple=cfg.baseEVEBITDA*normalizedMargin, growthPremium=clamp(growth-.04,0,.21)*10, qualityPremium=(q-.5)*1.25;
        const justified=clamp(economicsMultiple+growthPremium+qualityPremium,.5,10), m=boundedExit(currentEVSales,justified,.5,10), equity=Number(f.revenue)*m-netDebt;
        if(equity>0){
          const rel=methodReliability(stock,forecast,'SALES',revenue0,f.revenue,quality);
          addMethod(methods,{name:'EV/Sales fallback',target:equity/Number(f.shares),weight:1,reliability:rel.score,price,family:'sales',audit:{exitMultiple:m,currentMultiple:currentEVSales,metric:f.revenue,reason:'profitability_methods_unavailable',reliabilityReasons:rel.reasons}});
        }
      }
    }
  }

  // Cash-flow methods already include cash available to owners, so adding dividends to
  // them again double-counts the same cash. Exit-only methods need dividends, valued in
  // the year received rather than pretending every dividend arrives in year 10.
  const dividends=rows.reduce((sum,r)=>sum+(finite(r.dividendPerShare)||0),0);
  const pvDividends=rows.reduce((sum,r,i)=>sum+pv((finite(r.dividendPerShare)||0),req,i+1),0);
  const terminalDividendValue=pvDividends*Math.pow(1+req,HORIZON_YEARS);
  for(const m of methods){
    const dividendOutcome=m.cashFlowInclusive?0:terminalDividendValue;
    m.outcome=Number.isFinite(m.target)?m.target+dividendOutcome:null;
    m.audit={...(m.audit||{}),year10Outcome:m.target,dividendOutcomeAdded:dividendOutcome,fairValueToday:Number.isFinite(m.outcome)?pv(m.outcome,req,HORIZON_YEARS):null};
  }
  const consensus=valuationConsensus(methods,price);
  const canonical=robustOutcomeBlend(methods,price,consensus);
  let total=canonical.outcome, expected=cagr(price,total);
  const hasValuation=Number.isFinite(expected)&&methods.length>0&&Number.isFinite(total)&&total>0;
  if(!hasValuation){total=null;expected=null;}

  const target=total!=null?Math.max(0,total-terminalDividendValue):null, fair=total!=null?pv(total,req,HORIZON_YEARS):null;
  // Conventional margin of safety: discount to intrinsic value as a fraction of fair value.
  // A $50 price versus $100 fair value is 50% MOS, not 100% 'upside'. Premium remains
  // price/fair-1 so overvaluation is still explicit.
  const mos=fair>0&&price>0?1-price/fair:null, premium=fair>0&&price>0?price/fair-1:null;
  const reliable=methods.map((m,index)=>({m,index})).filter(x=>(x.m.reliability??1)>=.35);
  const agreementEntries=reliable.length>=2?reliable:methods.map((m,index)=>({m,index}));
  const agreementValues=agreementEntries.map(x=>({index:x.index,v:Number.isFinite(x.m.outcome)&&x.m.outcome>0?Math.log(x.m.outcome):null})).filter(x=>Number.isFinite(x.v));
  let spread=agreementValues.length>=2?Math.max(...agreementValues.map(x=>x.v))-Math.min(...agreementValues.map(x=>x.v)):null;
  let agreement;
  if(consensus.hasConsensusOutlier){
    const clusterValues=agreementValues.filter(x=>consensus.clusterIndexes.includes(x.index)).map(x=>x.v);
    const clusterSpread=clusterValues.length>=2?Math.max(...clusterValues)-Math.min(...clusterValues):consensus.pairSpread;
    agreement=Math.round(85*clamp(1-(clusterSpread??0)/Math.log(1.45),0,1));
    spread=clusterSpread;
  } else {
    agreement=agreementValues.length>=2?Math.round(100*clamp(1-spread/Math.log(1.45),0,1)):(agreementValues.length===1?45:0);
  }
  const families=new Set(methods.filter(m=>(m.reliability??0)>=.25).map(m=>m.family||m.name));
  const independentMethodCount=families.size;
  const forecastRel=clamp((forecast.forecastReliabilityScore??quality.confidenceScore??50)/100,.20,.95);
  let valuationConfidence=Math.round(clamp(.45*(quality.confidenceScore||50)+.25*(forecastRel*100)+.30*agreement,0,100));
  if(methods.length===1) valuationConfidence=Math.min(valuationConfidence,55);
  else if(independentMethodCount===1) valuationConfidence=Math.min(valuationConfidence,68);
  else if(independentMethodCount===2) valuationConfidence=Math.min(valuationConfidence,82);
  let modelSupport='standard', modelSupportReason=null;
  if(stock.sector==='Real Estate'){modelSupport='limited';modelSupportReason='REIT/real-estate specialized FFO-NAV metrics are not available in the free-data model';valuationConfidence=Math.min(valuationConfidence,50);}
  if(stock.sector==='Financials'&&methods.length===0){modelSupport='unsupported';modelSupportReason='No reliable normalized EPS basis for financial-company valuation';valuationConfidence=Math.min(valuationConfidence,35);}
  const uncertainty=clamp((100-valuationConfidence)/100,.10,.45);
  const bear=total!=null?total*Math.pow(1-(.035+.04*uncertainty),HORIZON_YEARS):null, bull=total!=null?total*Math.pow(1+(.035+.035*uncertainty),HORIZON_YEARS):null;
  const extremeReturn=hasValuation&&(expected<-.30||expected>.22);
  const lowReliability=methods.length>0&&Math.max(...methods.map(m=>m.reliability??0))<.40;

  return {requiredReturn:req,methods,canonicalMethodWeights:canonical.weights,fiveYearPriceTarget:target,tenYearPriceTarget:target,horizonYears:HORIZON_YEARS,cumulativeDividends:dividends,presentValueDividends:pvDividends,terminalDividendValue,totalShareholderValue:total,expectedCAGR:expected,fairValueEstimate:fair,marginOfSafety:mos,premiumToFairValue:premium,methodAgreementScore:agreement,valuationConfidenceScore:valuationConfidence,independentMethodCount,modelSupport,modelSupportReason,forecastReliabilityScore:forecast.forecastReliabilityScore??null,valuationConsensus:{hasConsensusOutlier:consensus.hasConsensusOutlier,clusterMethods:consensus.clusterIndexes.map(i=>methods[i]?.name).filter(Boolean),outlierMethods:consensus.outlierIndexes.map(i=>methods[i]?.name).filter(Boolean),clusterSpread:consensus.pairSpread,outlierGap:consensus.outlierGap},bearCAGR:cagr(price,bear),baseCAGR:expected,bullCAGR:cagr(price,bull),netDebt,plausibilityFailure:!hasValuation,extremeReturnFlag:extremeReturn,valuationReviewFlag:extremeReturn?'extreme_blended_return_after_normalization':(consensus.hasConsensusOutlier?'isolated_method_outlier':(agreement<35?'material_method_disagreement':(lowReliability?'low_method_reliability':null)))};
}
module.exports={valuate};
