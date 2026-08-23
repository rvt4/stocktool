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

function inferShareCount(stock,forecast,years){
  const last=years.at(-1)||{};
  const direct=[last.sharesOutTTM,last.weightedAverageDilutedShares,last.dilutedShares,last.sharesDiluted]
    .map(finite).filter(x=>x>0);
  if(direct.length)return {shares:direct[0],source:'reported'};
  const forecastShares=finite(forecast?.startShares);
  if(forecastShares>0)return {shares:forecastShares,source:forecast?.shareCountSource||'forecast_inferred'};
  const price=finite(stock?.price?.current), marketCap=finite(stock?.valuation?.marketCap);
  if(price>0&&marketCap>0)return {shares:marketCap/price,source:'market_cap_implied'};
  const implied=[];
  for(const y of years.slice(-5)){
    const ni=finite(y?.netIncome),eps=finite(y?.dilutedEPS ?? y?.epsDiluted ?? y?.eps);
    if(ni!=null&&eps!=null&&Math.abs(eps)>.0001&&ni*eps>0){const sh=ni/eps;if(Number.isFinite(sh)&&sh>1e5&&sh<1e12)implied.push(sh);}
  }
  const med=median(implied);
  return med>0?{shares:med,source:'earnings_per_share_implied'}:{shares:null,source:null};
}

function normalizeWithCaps(items,methodCap,familyCap){
  let rows=items.map(x=>({...x,w:Math.max(0,x.adjustedWeight||0)}));
  const normalize=()=>{const t=rows.reduce((s,x)=>s+x.w,0);if(t>0)for(const x of rows)x.w/=t;return t;};
  if(!(normalize()>0))return rows;
  // Iterative caps redistribute concentration rather than simply discarding weight.
  for(let pass=0;pass<8;pass++){
    let changed=false;
    let excess=0,open=[];
    for(const x of rows){if(x.w>methodCap){excess+=x.w-methodCap;x.w=methodCap;changed=true;}else open.push(x);}
    if(excess>1e-12&&open.length){const base=open.reduce((s,x)=>s+x.w,0)||open.length;for(const x of open)x.w+=excess*((base===open.length?1:x.w)/base);}
    normalize();
    const fams=new Map();for(const x of rows){const f=x.family||x.name;if(!fams.has(f))fams.set(f,[]);fams.get(f).push(x);}
    for(const [,group] of fams){const fw=group.reduce((s,x)=>s+x.w,0);if(fw<=familyCap+1e-12)continue;const cut=fw-familyCap;const scale=familyCap/fw;for(const x of group)x.w*=scale;const others=rows.filter(x=>!group.includes(x));const ow=others.reduce((s,x)=>s+x.w,0);if(others.length){for(const x of others)x.w+=cut*(ow>0?x.w/ow:1/others.length);}changed=true;}
    normalize();
    if(!changed)break;
  }
  return rows;
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

// V11.5: company-specific terminal multiple framework. A decade-out multiple should not
// simply collapse every business to a sector-average 12-14x. Durable growth and superior
// economics can justify a lasting premium, while weak balance sheets, dilution and low
// quality pull the multiple back down. Importantly, this uses business evidence only --
// never the current share price or current trading multiple -- preserving price invariance.
function terminalMultipleProfile(stock,forecast,quality,base){
  const q=clamp((quality?.qualityScore??50)/100,0,1);
  const moat=clamp((quality?.moatScore??50)/100,0,1);
  const capital=clamp((quality?.capitalAllocationScore??50)/100,0,1);
  const compounder=clamp((quality?.compounderScore??50)/100,0,1);
  const pricing=clamp((quality?.pricingPowerScore??50)/100,0,1);
  const protection=clamp((quality?.protectionScore??50)/100,0,1);
  const growthQuality=clamp((quality?.growthQualityScore??50)/100,0,1);
  const confidence=clamp((quality?.confidenceScore??50)/100,0,1);
  const roic=finite(quality?.diagnostics?.roic);
  const dilution=Math.max(0,finite(forecast?.matureDilutionRate)??finite(forecast?.dilutionRate)??0);
  const growth=clamp(forecast?.year5OperatingGrowth??forecast?.rows?.at(-1)?.revenueGrowth??forecast?.sustainableGrowth??forecast?.revenueGrowthAnchor,0,.22);
  const matureGrowth=clamp(forecast?.rows?.at(-1)?.revenueGrowth??forecast?.terminalGrowth??growth,0,.12);
  // A year-10 exit multiple should primarily reflect the business that exists in year 10,
  // not the faster-growing company from years 1-5. Mature growth therefore carries most
  // of the weight, with only a modest premium for demonstrated durability earlier in the
  // forecast. This prevents a temporary growth regime from earning a permanent premium.
  const growthDurability=clamp(.25*growth+.75*matureGrowth,0,.12);
  const maturityGap=Math.max(0,growth-matureGrowth);
  const maturityPenalty=clamp(maturityGap*18,0,1.8);
  const margin=Math.max(0,finite(base?.margins?.fcf)||0,finite(base?.margins?.ebitda)||0,finite(base?.margins?.net)||0);

  // Quality is deliberately multi-dimensional. This prevents one high ROIC year or one
  // growth estimate from single-handedly granting an elite terminal multiple.
  const durableQuality=.22*q+.18*moat+.15*compounder+.13*pricing+.12*capital+.10*protection+.10*growthQuality;
  const qualityAdj=(durableQuality-.55)*10;
  const roicAdj=Number.isFinite(roic)?clamp((roic-.12)*18,-1.5,3.0):0;
  const marginAdj=clamp((margin-.12)*8,-1.0,2.0);
  const confidenceAdj=(confidence-.60)*2;
  const dilutionPenalty=clamp(dilution*35,0,2.5);
  return {growth,matureGrowth,growthDurability,maturityGap,maturityPenalty,durableQuality,qualityAdj,roicAdj,marginAdj,confidenceAdj,dilutionPenalty};
}

function justifiedExitMultiple(kind,stock,forecast,quality,base,cfg){
  const p=terminalMultipleProfile(stock,forecast,quality,base);
  let multiple;
  if(kind==='FCF'){
    // FCF deserves the widest quality/growth differentiation because it is the cleanest
    // owner-economics anchor. ~10% durable growth with strong economics lands around the
    // mid/high teens; truly elite businesses can retain a low/mid-20s multiple.
    multiple=11.0+p.growthDurability*38+p.qualityAdj+p.roicAdj+p.marginAdj+p.confidenceAdj-p.dilutionPenalty-p.maturityPenalty;
    return {multiple:clamp(multiple,8,28),profile:p};
  }
  if(kind==='EPS'){
    multiple=cfg.basePE+p.growthDurability*38+p.qualityAdj*.90+p.roicAdj*.85+p.marginAdj*.45+p.confidenceAdj-p.dilutionPenalty-p.maturityPenalty;
    return {multiple:clamp(multiple,8,32),profile:p};
  }
  if(kind==='EBITDA'){
    multiple=cfg.baseEVEBITDA+p.growthDurability*24+p.qualityAdj*.60+p.roicAdj*.45+p.marginAdj*.35+p.confidenceAdj*.60-p.dilutionPenalty*.70-p.maturityPenalty*.65;
    return {multiple:clamp(multiple,6,22),profile:p};
  }
  return {multiple:null,profile:p};
}

function normalizedOperatingBase(stock,forecast){
  const years=stock.financials?.years||[], last=years.at(-1)||{};
  const revenue=finite(last.revenue), shares=finite(last.sharesOutTTM)>0?finite(last.sharesOutTTM):finite(forecast?.startShares);
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
  const info=consensus||valuationConsensus(methods,price), outliers=new Set(info.outlierIndexes||[]);
  // Base weights should express method usefulness, not permit a 40% DCF prior to become
  // 70-80% of the answer after disagreement. Square-root the prior and let reliability +
  // agreement do most of the work.
  const items=valid.map(m=>({value:Math.log(m.outcome),weight:Math.sqrt(Math.max(.001,m.baseWeight||m.weight))*Math.pow(clamp(m.reliability??1,.05,1),1.25),index:m.index,name:m.name,outcome:m.outcome,family:m.family||m.name}));
  const center=weightedMedian(items.map(x=>({value:x.value,weight:x.weight*(outliers.has(x.index)?.10:1)})));
  const adjusted=items.map(x=>{
    const gap=Math.abs(x.value-center);
    let consensusWeight=gap<=Math.log(1.15)?1:gap<=Math.log(1.30)?.78:gap<=Math.log(1.60)?.48:.20;
    if(info.hasConsensusOutlier&&outliers.has(x.index))consensusWeight=Math.min(consensusWeight,.12);
    return {...x,adjustedWeight:x.weight*consensusWeight};
  });
  const methodCap=valid.length>=3?.45:.62;
  const familyCap=valid.length>=3?.58:.72;
  const capped=normalizeWithCaps(adjusted,methodCap,familyCap);
  const totalW=capped.reduce((s,x)=>s+x.w,0);
  if(!(totalW>0))return {outcome:null,weights:{}};
  const outcome=capped.reduce((s,x)=>s+x.outcome*x.w,0)/totalW;
  return {outcome,weights:Object.fromEntries(capped.map(x=>[x.name,x.w/totalW]))};
}

function dcfFairValue(forecast,req,currentShares){
  const rows=forecast.rows||[];
  if(rows.length!==HORIZON_YEARS||!(req>0)||!(currentShares>0))return null;

  // V11.4: value aggregate owner cash flow, then divide by TODAY'S ownership base.
  // Discounting forecast FCF/share while the forecast also shrinks the share count counts
  // buyback-funded FCF twice: once as cash flow and again through a smaller denominator.
  // Aggregate FCF is invariant to whether excess cash is retained, paid as dividends, or
  // used for repurchases, which is the correct starting point for an intrinsic DCF.
  const cashflows=rows.map(r=>{
    const fcfps=finite(r.fcfPerShare), shares=finite(r.shares);
    return fcfps>0&&shares>0?fcfps*shares:null;
  });
  if(cashflows.filter(x=>Number.isFinite(x)&&x>0).length<Math.max(6,HORIZON_YEARS-2))return null;
  let explicitTotal=0;
  for(let i=0;i<cashflows.length;i++){
    if(!(cashflows[i]>0))return null;
    explicitTotal+=pv(cashflows[i],req,i+1);
  }

  // Mature perpetual growth is deliberately conservative. The explicit forecast already
  // gives the business ten years to compound; the terminal period should resemble a
  // mature economy, not extend a premium growth regime indefinitely.
  const g=clamp(finite(forecast.terminalGrowth)??.02,.005,Math.min(.025,req-.04));
  if(!(req>g))return null;
  const terminalTotal=cashflows.at(-1)*(1+g)/(req-g);
  const pvTerminalTotal=pv(terminalTotal,req,HORIZON_YEARS);
  const explicit=explicitTotal/currentShares, pvTerminal=pvTerminalTotal/currentShares;
  const fair=explicit+pvTerminal;
  return fair>0?{fairValue:fair,pvExplicit:explicit,pvTerminal,terminalGrowth:g,terminalShare:pvTerminal/fair}:null;
}

function valuate(stock,forecast,quality){
  const rows=forecast.rows||[], f=rows.at(-1)||{}, years=stock.financials?.years||[], last=years.at(-1)||{};
  const price=finite(stock.price?.current), cfg=sectorConfig(stock.sector), req=requiredReturn(quality,forecast.category);
  const shareInfo=inferShareCount(stock,forecast,years);
  const reportedShares0=shareInfo.source==='reported'?shareInfo.shares:null;
  const inferredShares0=shareInfo.shares;
  const shares0=inferredShares0, netDebt=(finite(last.totalDebt)||finite(last.longTermDebt)||0)-(finite(last.cash)||0);
  const marketCap=price>0&&shares0>0?price*shares0:null, revenue0=finite(last.revenue)>0?finite(last.revenue):null;
  const q=(quality.qualityScore||50)/100, growth=clamp(forecast.year5OperatingGrowth??forecast.rows?.at(-1)?.revenueGrowth??forecast.sustainableGrowth??forecast.revenueGrowthAnchor,0,.18);
  const methods=[], base=normalizedOperatingBase(stock,forecast);
  const dataQuality=stock.financials?.dataQuality||{};
  const shareDenominatorReliable=dataQuality.shareDenominatorReliable !== false;
  // A missing SEC share denominator should not make a profitable company permanently
  // unrateable when market cap / price supplies a coherent per-share denominator. This
  // remains lower-confidence than a reported diluted share count and is surfaced below.
  const shareCountFallbackUsed=!reportedShares0&&inferredShares0>0;
  const shareDenominatorUsable=shareDenominatorReliable||shareCountFallbackUsed;
  const financialLike=dataQuality.financialLikeRevenue===true;
  const materialNCI=dataQuality.materialNoncontrollingInterest===true;

  if(!shareDenominatorUsable){
    // Fail closed. A corrupted share denominator can turn an ordinary enterprise value
    // into a triple-digit per-share CAGR. Do not value until the denominator is reconciled.
  } else if(financialLike){
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
      const stableROE=clamp(.105+.13*q,.10,.235);
      const payout=clamp(1-stableG/stableROE,.35,.85);
      const fundamentalPE=payout*(1+stableG)/Math.max(.035,req-stableG);
      const justified=.62*fundamentalPE+.38*(cfg.basePE+epsGrowth*(growthFinancial?20:9)+(q-.5)*5);
      const m=boundedExit(currentPE,justified,7,growthFinancial?28:21);
      const rel=methodReliability(stock,forecast,'FINANCIAL_EPS',epsBase,futureEPS,quality);
      addMethod(methods,{name:'Normalized EPS exit',target:futureEPS*m,weight:1,reliability:rel.score,price,family:'earnings',audit:{exitMultiple:m,currentMultiple:currentPE,metric:futureEPS,normalizedEPSBase:epsBase,epsGrowth,reliabilityReasons:rel.reasons}});
    }
  } else {
    const normFCF=base.fcfPerShare, normEPS=base.eps, normEBITDA=base.ebitda;
    // When a material slice of consolidated economics belongs to non-controlling owners,
    // consolidated FCF/EBITDA is not on the same ownership scope as the listed share
    // denominator. Keep parent EPS usable, but suppress whole-enterprise cash-flow methods.
    const allowEnterpriseScopeMethods=!materialNCI;
    const currentPFCF=safeMultiple(price>0&&normFCF>0?price/normFCF:null,6,35);
    const currentPE=safeMultiple(price>0&&normEPS>0?price/normEPS:null,6,38);
    const currentEVEBITDA=safeMultiple(marketCap>0&&normEBITDA>0?(marketCap+netDebt)/normEBITDA:null,4,24);

    if(allowEnterpriseScopeMethods&&Number(f.fcfPerShare)>0&&normFCF>0){
      const exit=justifiedExitMultiple('FCF',stock,forecast,quality,base,cfg), m=boundedExit(currentPFCF,exit.multiple,8,28);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // V11.4: an exit-multiple method values the business at the exit date. Do not also
      // add every interim dollar of FCF here. The forecast share path already reflects
      // repurchases/capital allocation, so adding explicit FCF on top was systematically
      // double-counting owner cash and made FCF-exit values track the (also inflated) DCF.
      // Dividends are added later because this is now an exit-only method.
      const terminalFCFValue=f.fcfPerShare*m;
      addMethod(methods,{name:'FCF exit',target:terminalFCFValue,weight:.30,reliability:rel.score,price,family:'cashflow',cashFlowInclusive:false,audit:{exitMultiple:m,currentMultiple:currentPFCF,metric:f.fcfPerShare,normalizedCurrentMetric:normFCF,terminalExitValue:terminalFCFValue,multipleProfile:exit.profile,reliabilityReasons:rel.reasons}});
    }
    if(Number(f.eps)>0&&normEPS>0){
      const exit=justifiedExitMultiple('EPS',stock,forecast,quality,base,cfg), m=boundedExit(currentPE,exit.multiple,8,32);
      const rel=methodReliability(stock,forecast,'EPS',normEPS,f.eps,quality);
      addMethod(methods,{name:'EPS exit',target:f.eps*m,weight:.20,reliability:rel.score,price,family:'earnings',audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps,normalizedCurrentMetric:normEPS,multipleProfile:exit.profile,reliabilityReasons:rel.reasons}});
    }
    if(allowEnterpriseScopeMethods&&Number(f.ebitda)>0&&Number(f.shares)>0&&normEBITDA>0){
      const exit=justifiedExitMultiple('EBITDA',stock,forecast,quality,base,cfg), m=boundedExit(currentEVEBITDA,exit.multiple,6,22), equity=f.ebitda*m-netDebt;
      if(equity>0){
        const rel=methodReliability(stock,forecast,'EBITDA',normEBITDA,f.ebitda,quality);
        addMethod(methods,{name:'EV/EBITDA exit',target:equity/f.shares,weight:.10,reliability:rel.score,price,family:'enterprise',audit:{exitMultiple:m,currentMultiple:currentEVEBITDA,metric:f.ebitda,normalizedCurrentMetric:normEBITDA,multipleProfile:exit.profile,reliabilityReasons:rel.reasons}});
      }
    }

    const dcf=allowEnterpriseScopeMethods?dcfFairValue(forecast,req,shares0):null;
    if(dcf){
      const terminalOutcome=dcf.fairValue*Math.pow(1+req,HORIZON_YEARS);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // Terminal-value-heavy DCFs are still useful, but receive less reliability when
      // most of the present value depends on the perpetuity rather than explicit cash flow.
      const terminalPenalty=dcf.terminalShare>.75?.55:(dcf.terminalShare>.65?.72:(dcf.terminalShare>.55?.88:1));
      addMethod(methods,{name:'10Y DCF',target:terminalOutcome,weight:.40,reliability:rel.score*terminalPenalty,price,family:'cashflow',cashFlowInclusive:true,audit:{fairValueToday:dcf.fairValue,pvExplicit:dcf.pvExplicit,pvTerminal:dcf.pvTerminal,terminalGrowth:dcf.terminalGrowth,terminalShare:dcf.terminalShare,reliabilityReasons:[...rel.reasons,...(terminalPenalty<1?['terminal_value_concentration']:[])]}});
    }

    if(!methods.length&&allowEnterpriseScopeMethods&&Number(f.revenue)>0&&Number(f.shares)>0&&revenue0>0){
      const currentEVSales=marketCap>0?safeMultiple((marketCap+netDebt)/revenue0,.25,12):null;
      // Trust-first fallback: never invent a 4% profitability floor. Revenue multiples are
      // only defensible when the company has observable positive normalized economics.
      // If profitability is absent/negative, publish no valuation rather than manufacture
      // a huge fair value from sales alone.
      const observedMargins=[base.margins?.fcf,base.margins?.ebitda,base.margins?.net].filter(x=>Number.isFinite(x)&&x>0);
      const observedMargin=observedMargins.length?Math.max(...observedMargins):null;
      const growthEligible=(forecast.category==='Growth'||forecast.category==='Hyper Growth')&&growth>=.10;
      if(observedMargin>=.02&&growthEligible){
        const economicsMultiple=cfg.baseEVEBITDA*clamp(observedMargin,.02,.35);
        const growthPremium=clamp(growth-.08,0,.15)*6, qualityPremium=(q-.5)*.75;
        const justified=clamp(economicsMultiple+growthPremium+qualityPremium,.25,5), m=boundedExit(currentEVSales,justified,.25,5), equity=Number(f.revenue)*m-netDebt;
        if(equity>0){
          const rel=methodReliability(stock,forecast,'SALES',revenue0,f.revenue,quality);
          addMethod(methods,{name:'EV/Sales fallback',target:equity/Number(f.shares),weight:1,reliability:rel.score*.75,price,family:'sales',audit:{exitMultiple:m,currentMultiple:currentEVSales,metric:f.revenue,observedMargin,reason:'profitability_methods_unavailable_but_positive_economics_observed',reliabilityReasons:rel.reasons}});
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

  // Valuation confidence is determined from evidence BEFORE the canonical outcome is
  // published. Low-confidence assumptions now affect intrinsic value instead of merely
  // appearing as a cosmetic confidence score beside an unchanged point estimate.
  const reliableForAgreement=methods.map((m,index)=>({m,index})).filter(x=>(x.m.reliability??1)>=.35);
  const agreementEntries0=reliableForAgreement.length>=2?reliableForAgreement:methods.map((m,index)=>({m,index}));
  const agreementValues0=agreementEntries0.map(x=>({index:x.index,v:Number.isFinite(x.m.outcome)&&x.m.outcome>0?Math.log(x.m.outcome):null})).filter(x=>Number.isFinite(x.v));
  const agreementLogs0=(consensus.hasConsensusOutlier
    ? agreementValues0.filter(x=>consensus.clusterIndexes.includes(x.index))
    : agreementValues0).map(x=>x.v);
  const logCenter0=agreementLogs0.length?median(agreementLogs0):null;
  const deviations0=logCenter0==null?[]:agreementLogs0.map(v=>Math.abs(v-logCenter0));
  const robustSpread0=deviations0.length?median(deviations0):null;
  let agreement=agreementLogs0.length>=2
    ? Math.round(100*clamp(1-(robustSpread0??0)/Math.log(1.65),0,1))
    : (agreementLogs0.length===1?null:0);
  if(consensus.hasConsensusOutlier) agreement=Math.min(88,agreement);
  const families=new Set(methods.filter(m=>(m.reliability??0)>=.25).map(m=>m.family||m.name));
  const independentMethodCount=families.size;
  const forecastRel=clamp((forecast.forecastReliabilityScore??quality.confidenceScore??50)/100,.20,.95);
  const agreementForConfidence=Number.isFinite(agreement)?agreement:50;
  let valuationConfidence=Math.round(clamp(.45*(quality.confidenceScore||50)+.25*(forecastRel*100)+.30*agreementForConfidence,0,100));
  if(methods.length===1) valuationConfidence=Math.min(valuationConfidence,55);
  else if(independentMethodCount===1) valuationConfidence=Math.min(valuationConfidence,68);
  else if(independentMethodCount===2) valuationConfidence=Math.min(valuationConfidence,82);

  const preUncertaintyTotal=canonical.outcome;
  const preUncertaintyCAGR=cagr(price,preUncertaintyTotal);
  let uncertaintyHaircutRate=.002;
  let total=preUncertaintyTotal, expected=preUncertaintyCAGR;

  // Exit-multiple sensitivity: a decision that flips when terminal multiples move 20% is
  // intrinsically less certain. DCF is left unchanged because its terminal assumption is
  // already represented by perpetual growth rather than an exit multiple.
  const sensitivityOutcome=(factor)=>{
    const shocked=methods.map(m=>{
      if(!/exit$/i.test(m.name)||!Number.isFinite(m.target)) return {...m};
      const dividendOutcome=m.cashFlowInclusive?0:terminalDividendValue;
      const target=m.target*factor;
      return {...m,target,outcome:target+dividendOutcome};
    });
    return robustOutcomeBlend(shocked,price,valuationConsensus(shocked,price)).outcome;
  };
  const lowMultipleOutcome=sensitivityOutcome(.80), highMultipleOutcome=sensitivityOutcome(1.20);
  const lowMultipleCAGR=cagr(price,lowMultipleOutcome), highMultipleCAGR=cagr(price,highMultipleOutcome);
  const multipleSensitivitySpread=Number.isFinite(lowMultipleCAGR)&&Number.isFinite(highMultipleCAGR)?highMultipleCAGR-lowMultipleCAGR:null;

  if(Number.isFinite(multipleSensitivitySpread)){
    const sensitivityPenalty=Math.round(clamp((multipleSensitivitySpread-.035)/.08,0,1)*14);
    valuationConfidence=Math.max(20,valuationConfidence-sensitivityPenalty);
  }
  // Annualized haircut ranges from roughly 0.2% for very high-confidence models to 2.4%
  // for fragile ones. It is applied to business value, not to today's quote, and includes
  // the penalty for terminal-multiple sensitivity calculated immediately above.
  uncertaintyHaircutRate=clamp(.002+Math.pow((100-valuationConfidence)/100,1.35)*.032,.002,.024);
  total=Number.isFinite(preUncertaintyTotal)?preUncertaintyTotal*Math.pow(1-uncertaintyHaircutRate,HORIZON_YEARS):null;
  expected=cagr(price,total);

  // Return-integrity gate. A valuation is not decision-grade merely because its algebra
  // works. Mature/slow-growing businesses cannot publish 25-40% annual returns unless
  // the operating model itself contains enough growth, margin expansion, distributions,
  // or dilution improvement to support that result. This is intentionally generic: it
  // does not favor a category or ticker; it rejects a valuation whose re-rating is doing
  // implausibly large amounts of work.
  const startRevenue=finite(rows[0]?.revenue), endRevenue=finite(f?.revenue);
  const modeledRevenueCAGR=startRevenue>0&&endRevenue>0?Math.pow(endRevenue/startRevenue,1/Math.max(1,HORIZON_YEARS-1))-1:null;
  const startFCFM=finite(rows[0]?.fcfMargin), endFCFM=finite(f?.fcfMargin);
  const startNetM=finite(rows[0]?.netMargin), endNetM=finite(f?.netMargin);
  const marginLift=Math.max(0,(Number.isFinite(startFCFM)&&Number.isFinite(endFCFM)?endFCFM-startFCFM:0),(Number.isFinite(startNetM)&&Number.isFinite(endNetM)?endNetM-startNetM:0));
  const dilutionTailwind=Math.max(0,-(finite(forecast.dilutionRate)||0));
  const dividendYield=Math.max(0,finite(stock.valuation?.dividendYield)||0);
  const operatingSupport=Math.max(0,modeledRevenueCAGR??growth??0)+Math.min(.05,marginLift/HORIZON_YEARS)+Math.min(.04,dilutionTailwind)+Math.min(.06,dividendYield);
  const matureSlowGrowth=Math.max(modeledRevenueCAGR??0,growth??0)<.10;
  const reratingAllowance=matureSlowGrowth?.075:.11;
  const returnSupportCeiling=clamp(operatingSupport+reratingAllowance,.12,.30);
  const conservativeCategory=forecast.category==='Value'||forecast.category==='Dividend';
  const returnDecompositionFailure=conservativeCategory&&matureSlowGrowth&&Number.isFinite(expected)&&expected>returnSupportCeiling+.015;

  let hasValuation=Number.isFinite(expected)&&methods.length>0&&Number.isFinite(total)&&total>0&&!returnDecompositionFailure;
  if(!hasValuation){total=null;expected=null;}

  const target=total!=null?Math.max(0,total-terminalDividendValue):null;
  // Keep two concepts separate:
  //   fairValueEstimate = risk-normalized intrinsic value (what the business is worth)
  //   requiredReturnBuyPrice = price that would deliver this model's stricter hurdle rate.
  // Previously both were the same number, which made high-quality growth companies look
  // artificially 'worth' only the price needed to earn 11-12% annually.
  const fairDiscountRate=clamp(.09+(1-q)*.015,.09,.105);
  const fair=total!=null?pv(total,fairDiscountRate,HORIZON_YEARS):null;
  const requiredReturnBuyPrice=total!=null?pv(total,req,HORIZON_YEARS):null;
  // MOS is never a negative percentage. Overvaluation is represented separately by
  // premiumToFairValue / valuationGap, avoiding outputs such as -165% MOS.
  const rawMos=fair>0&&price>0?1-price/fair:null;
  const mos=rawMos==null?null:Math.max(0,rawMos);
  const premium=fair>0&&price>0?Math.max(0,price/fair-1):null;
  const valuationGap=fair>0&&price>0?fair/price-1:null;
  let modelSupport='standard', modelSupportReason=null;
  if(financialLike&&methods.length>0){
    // Banks, insurers and mortgage REITs need book value/ROTCE, capital, reserve or
    // distributable-earnings inputs that the free generic dataset does not reliably
    // provide. A lone normalized-EPS exit can remain visible as a reference valuation,
    // but it must not masquerade as decision-grade multi-method evidence.
    modelSupport='limited';
    modelSupportReason='Financial-style business is supported by normalized EPS only; specialized book-value/capital/ROTCE or distributable-earnings evidence is unavailable';
    valuationConfidence=Math.min(valuationConfidence,50);
  }
  if(stock.sector==='Real Estate'){modelSupport='limited';modelSupportReason='REIT/real-estate specialized FFO-NAV metrics are not available in the free-data model';valuationConfidence=Math.min(valuationConfidence,50);}
  if(!shareDenominatorUsable){modelSupport='unsupported';modelSupportReason='Share-count denominator failed independent reconciliation';valuationConfidence=Math.min(valuationConfidence,20);}
  else if(financialLike&&methods.length===0){modelSupport='unsupported';modelSupportReason='Financial/insurance-like economics require a reliable normalized EPS basis; cash-flow and sales fallbacks are intentionally disabled';valuationConfidence=Math.min(valuationConfidence,35);}
  else if(materialNCI&&methods.length===0){modelSupport='unsupported';modelSupportReason='Material non-controlling interest creates an ownership-scope mismatch and no parent-scope EPS valuation was available';valuationConfidence=Math.min(valuationConfidence,35);}
  else if(returnDecompositionFailure){modelSupport='unsupported';modelSupportReason='Canonical return exceeds what modeled operating growth, margin change, dilution, dividends, and a bounded re-rating allowance can support';valuationConfidence=Math.min(valuationConfidence,35);}
  else if(methods.length===0){modelSupport='unsupported';modelSupportReason='No defensible valuation method produced a value from the available economics';valuationConfidence=Math.min(valuationConfidence,35);}
  // Investor-style return attribution. Contributions are annualized approximations,
  // intended to reveal what must go right rather than falsely imply exact additivity.
  const endShares=finite(f.shares);
  const shareCountContribution=shares0>0&&endShares>0?Math.pow(shares0/endShares,1/HORIZON_YEARS)-1:null;
  const representativeStartMargin=Number.isFinite(base.margins?.net)&&base.margins.net>0?base.margins.net:(Number.isFinite(base.margins?.fcf)&&base.margins.fcf>0?base.margins.fcf:null);
  const representativeEndMargin=Number.isFinite(f.netMargin)&&f.netMargin>0?f.netMargin:(Number.isFinite(f.fcfMargin)&&f.fcfMargin>0?f.fcfMargin:null);
  const marginContribution=representativeStartMargin>0&&representativeEndMargin>0?Math.pow(representativeEndMargin/representativeStartMargin,1/HORIZON_YEARS)-1:null;
  const exitOnlyOutcome=total!=null?Math.max(0,total-terminalDividendValue*Math.pow(1-uncertaintyHaircutRate,HORIZON_YEARS)):null;
  const exDividendCAGR=cagr(price,exitOnlyOutcome);
  const dividendContribution=Number.isFinite(expected)&&Number.isFinite(exDividendCAGR)?expected-exDividendCAGR:0;
  const revenueContribution=modeledRevenueCAGR;
  const fundamentalContribution=[revenueContribution,marginContribution,shareCountContribution].filter(Number.isFinite).reduce((a,b)=>a+b,0);
  const uncertaintyAdjustment=Number.isFinite(preUncertaintyCAGR)&&Number.isFinite(expected)?expected-preUncertaintyCAGR:null;
  const multipleReratingContribution=Number.isFinite(expected)?expected-fundamentalContribution-(dividendContribution||0)-(uncertaintyAdjustment||0):null;
  const returnAttribution={revenueContribution,marginContribution,shareCountContribution,dividendContribution,multipleReratingContribution,uncertaintyAdjustment,preUncertaintyCAGR,uncertaintyHaircutRate};

  const uncertainty=clamp((100-valuationConfidence)/100,.10,.45);
  const bear=total!=null?total*Math.pow(1-(.035+.04*uncertainty),HORIZON_YEARS):null, bull=total!=null?total*Math.pow(1+(.035+.035*uncertainty),HORIZON_YEARS):null;
  const extremeReturn=hasValuation&&(expected<-.30||expected>.22);
  const lowReliability=methods.length>0&&Math.max(...methods.map(m=>m.reliability??0))<.40;

  return {requiredReturn:req,methods,canonicalMethodWeights:canonical.weights,fiveYearPriceTarget:target,tenYearPriceTarget:target,horizonYears:HORIZON_YEARS,cumulativeDividends:dividends,presentValueDividends:pvDividends,terminalDividendValue,totalShareholderValue:total,expectedCAGR:expected,fairValueEstimate:fair,requiredReturnBuyPrice,fairValueDiscountRate:fairDiscountRate,marginOfSafety:mos,premiumToFairValue:premium,valuationGap,methodAgreementScore:agreement,multipleSensitivity:{down20CAGR:lowMultipleCAGR,up20CAGR:highMultipleCAGR,spread:multipleSensitivitySpread},returnAttribution,preUncertaintyCAGR,uncertaintyHaircutRate,valuationConfidenceScore:valuationConfidence,independentMethodCount,modelSupport,modelSupportReason,forecastReliabilityScore:forecast.forecastReliabilityScore??null,valuationConsensus:{hasConsensusOutlier:consensus.hasConsensusOutlier,clusterMethods:consensus.clusterIndexes.map(i=>methods[i]?.name).filter(Boolean),outlierMethods:consensus.outlierIndexes.map(i=>methods[i]?.name).filter(Boolean),clusterSpread:consensus.pairSpread,outlierGap:consensus.outlierGap},bearCAGR:cagr(price,bear),baseCAGR:expected,bullCAGR:cagr(price,bull),netDebt,plausibilityFailure:!hasValuation,returnDecompositionFailure,returnSupportCeiling,operatingSupport,modeledRevenueCAGR,extremeReturnFlag:extremeReturn,valuationReviewFlag:extremeReturn?'extreme_blended_return_after_normalization':(consensus.hasConsensusOutlier?'isolated_method_outlier':(Number.isFinite(agreement)&&agreement<35?'material_method_disagreement':(lowReliability?'low_method_reliability':null)))};
}
module.exports={valuate};
