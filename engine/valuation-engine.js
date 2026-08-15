'use strict';
const { HORIZON_YEARS, MARKET_RETURN, sectorConfig, clamp, median } = require('./config');

function cagr(p,f){if(!(p>0)||!(f>0))return null;return Math.pow(f/p,1/HORIZON_YEARS)-1;}
function pv(v,r,n){return v/Math.pow(1+r,n);}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function requiredReturn(q,cat){let r=MARKET_RETURN;if(cat==='Hyper Growth')r+=.02;else if(cat==='Growth')r+=.01;if((q?.confidenceScore||50)<60)r+=.01;if((q?.protectionScore||50)<45)r+=.01;return clamp(r,.09,.14);}
function blend(items){const v=items.filter(x=>Number.isFinite(x.value)&&x.value>0&&x.weight>0);if(!v.length)return null;const w=v.reduce((s,x)=>s+x.weight,0);return v.reduce((s,x)=>s+x.value*x.weight,0)/w;}
function recentMedian(values,n=4){return median(values.slice(-n).filter(x=>Number.isFinite(x)&&x>0));}
function safeMultiple(v,lo,hi){if(!(Number.isFinite(v)&&v>0))return null;return clamp(v,lo*.65,hi*2.0);}

// Terminal multiples are allowed to move, but the model may not manufacture most of
// the return through rerating. This is deliberately a multiple-ratio guardrail rather
// than a CAGR cap: operating growth remains free to drive strong outcomes.
function boundedExit(current,justified,lo,hi){
  let j=clamp(justified,lo,hi);
  if(Number.isFinite(current)&&current>0){
    const sane=clamp(current,lo*.65,hi*1.5);
    j=.60*j+.40*sane;
    j=clamp(j,Math.max(lo,sane*.55),Math.min(hi,sane*1.80));
  }
  return j;
}

function normalizedOperatingBase(stock,forecast){
  const years=stock.financials?.years||[], last=years.at(-1)||{};
  const revenue=finite(last.revenue), shares=finite(last.sharesOutTTM);
  const bridge=forecast.forecastBridge?.margins||{};
  const fcfMargin=finite(bridge.fcfNormalized);
  const ebitdaMargin=finite(bridge.ebitdaNormalized);
  const netMargin=finite(bridge.netNormalized);

  const perShare=(margin)=>revenue>0&&shares>0&&Number.isFinite(margin)&&margin>0?revenue*margin/shares:null;
  return {
    revenue,
    shares,
    fcfPerShare:perShare(fcfMargin),
    eps:perShare(netMargin),
    ebitda:revenue>0&&Number.isFinite(ebitdaMargin)&&ebitdaMargin>0?revenue*ebitdaMargin:null,
    margins:{fcf:fcfMargin,ebitda:ebitdaMargin,net:netMargin},
  };
}

function normalizedFinancialEPS(years,last){
  const eps=[];
  for(const y of years.slice(-5)){
    const reported=finite(y?.dilutedEPS);
    const ni=finite(y?.netIncome), sh=finite(y?.sharesOutTTM);
    const implied=ni!=null&&sh>0?ni/sh:null;
    const v=reported>0?reported:(implied>0?implied:null);
    if(Number.isFinite(v)&&v>0)eps.push(v);
  }
  const normalized=recentMedian(eps,4);
  const latestReported=finite(last?.dilutedEPS);
  const latest=latestReported>0?latestReported:(finite(last?.netIncome)>0&&finite(last?.sharesOutTTM)>0?finite(last.netIncome)/finite(last.sharesOutTTM):null);
  if(!(normalized>0))return latest>0?latest:null;
  // Do not let a temporary earnings spike/trough become the permanent denominator.
  return latest>0?(.70*normalized+.30*latest):normalized;
}

function addMethod(methods,{name,target,weight,audit,price}){
  if(!(Number.isFinite(target)&&target>0&&Number.isFinite(price)&&price>0))return;
  const implied=cagr(price,target);
  // A single method implying a >50% annualized return or >45% annualized loss is not
  // decision-grade in a five-year terminal-multiple model. Exclude it instead of
  // clipping the published return. Other independent methods can still value the stock.
  if(!Number.isFinite(implied)||implied>.45)return;
  methods.push({name,target,weight,audit:{...audit,impliedCAGR:implied}});
}

function valuate(stock,forecast,quality){
  const rows=forecast.rows||[], f=rows.at(-1)||{}, years=stock.financials?.years||[], last=years.at(-1)||{};
  const price=finite(stock.price?.current), cfg=sectorConfig(stock.sector), req=requiredReturn(quality,forecast.category);
  const shares0=finite(last.sharesOutTTM), netDebt=(finite(last.totalDebt)||finite(last.longTermDebt)||0)-(finite(last.cash)||0);
  const marketCap=price>0&&shares0>0?price*shares0:null;
  const revenue0=finite(last.revenue)>0?finite(last.revenue):null;
  const q=(quality.qualityScore||50)/100, growth=clamp(forecast.sustainableGrowth??forecast.revenueGrowthAnchor,0,.25);
  const methods=[];
  const base=normalizedOperatingBase(stock,forecast);

  if(stock.sector==='Financials'){
    // Banks, insurers and asset managers are not revenue-margin businesses. Forecasting
    // net income as revenue × a generic net margin is the main reason multi-class and
    // investment-heavy financials could produce absurd 50%-300% CAGRs. Normalize EPS
    // directly, then compound it at a conservative per-share earnings rate.
    const epsBase=normalizedFinancialEPS(years,last);
    const currentPE=safeMultiple(price>0&&epsBase>0?price/epsBase:null,6,24);
    if(epsBase>0&&currentPE){
      const buybackTailwind=clamp(-(forecast.dilutionRate||0),-.03,.04);
      const epsGrowth=clamp((forecast.sustainableGrowth??growth)+buybackTailwind,-.04,.20);
      const futureEPS=epsBase*Math.pow(1+epsGrowth,HORIZON_YEARS);
      const justified=cfg.basePE+epsGrowth*22+(q-.5)*5;
      const m=boundedExit(currentPE,justified,7,22);
      addMethod(methods,{name:'Normalized EPS exit',target:futureEPS*m,weight:1,price,audit:{exitMultiple:m,currentMultiple:currentPE,metric:futureEPS,normalizedEPSBase:epsBase,epsGrowth}});
    }
  } else {
    const normFCF=base.fcfPerShare;
    const normEPS=base.eps;
    const normEBITDA=base.ebitda;
    const currentPFCF=safeMultiple(price>0&&normFCF>0?price/normFCF:null,6,35);
    const currentPE=safeMultiple(price>0&&normEPS>0?price/normEPS:null,6,38);
    const currentEVEBITDA=safeMultiple(marketCap>0&&normEBITDA>0?(marketCap+netDebt)/normEBITDA:null,4,24);

    if(Number(f.fcfPerShare)>0&&currentPFCF){
      const justified=14+growth*38+(q-.5)*8, m=boundedExit(currentPFCF,justified,9,30);
      addMethod(methods,{name:'FCF exit',target:f.fcfPerShare*m,weight:.50,price,audit:{exitMultiple:m,currentMultiple:currentPFCF,metric:f.fcfPerShare,normalizedCurrentMetric:normFCF}});
    }
    if(Number(f.eps)>0&&currentPE){
      const justified=cfg.basePE+growth*35+(q-.5)*7, m=boundedExit(currentPE,justified,8,32);
      addMethod(methods,{name:'EPS exit',target:f.eps*m,weight:.35,price,audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps,normalizedCurrentMetric:normEPS}});
    }
    if(Number(f.ebitda)>0&&Number(f.shares)>0&&currentEVEBITDA){
      const justified=cfg.baseEVEBITDA+growth*18+(q-.5)*4, m=boundedExit(currentEVEBITDA,justified,6,20);
      const equity=f.ebitda*m-netDebt;
      if(equity>0)addMethod(methods,{name:'EV/EBITDA exit',target:equity/f.shares,weight:.15,price,audit:{exitMultiple:m,currentMultiple:currentEVEBITDA,metric:f.ebitda,normalizedCurrentMetric:normEBITDA}});
    }

    // Profitability fallback. Require a sane CURRENT EV/Sales denominator, and limit
    // rerating relative to that observed multiple. This prevents distressed or malformed
    // accounting inputs from becoming 5x-50x terminal-sales jackpots.
    if(!methods.length&&Number(f.revenue)>0&&Number(f.shares)>0&&marketCap>0&&revenue0>0){
      const currentEVSales=safeMultiple((marketCap+netDebt)/revenue0,.25,12);
      if(currentEVSales){
        const terminalEbitdaMargin=clamp(Number(f.ebitdaMargin)||0,0,.60), normalizedMargin=Math.max(.04,terminalEbitdaMargin);
        const economicsMultiple=cfg.baseEVEBITDA*normalizedMargin, growthPremium=clamp(growth-.04,0,.21)*10, qualityPremium=(q-.5)*1.25;
        const justified=clamp(economicsMultiple+growthPremium+qualityPremium,.5,10), m=boundedExit(currentEVSales,justified,.5,10);
        const equity=Number(f.revenue)*m-netDebt;
        if(equity>0)addMethod(methods,{name:'EV/Sales fallback',target:equity/Number(f.shares),weight:1,price,audit:{exitMultiple:m,currentMultiple:currentEVSales,metric:f.revenue,reason:'profitability_methods_unavailable'}});
      }
    }
  }

  const dividends=rows.reduce((s,r)=>s+(finite(r.dividendPerShare)||0),0);
  for(const m of methods)m.outcome=Number.isFinite(m.target)?m.target+dividends:null;
  let total=blend(methods.map(m=>({value:m.outcome,weight:m.weight})));
  let expected=cagr(price,total);
  const hasValuation=Number.isFinite(expected)&&expected<=.45&&methods.length>0&&Number.isFinite(total)&&total>0;
  if(!hasValuation){total=null;expected=null;}

  const target=total!=null?Math.max(0,total-dividends):null, fair=total!=null?pv(total,req,HORIZON_YEARS):null;
  const mos=fair>0&&price>0?1-price/fair:null, premium=fair>0&&price>0?price/fair-1:null;
  const returns=methods.map(m=>cagr(price,m.outcome)).filter(Number.isFinite), spread=returns.length>=2?Math.max(...returns)-Math.min(...returns):null;
  const agreement=returns.length>=2?Math.round(100*clamp(1-spread/.25,0,1)):(returns.length===1?55:0);
  const uncertainty=clamp((100-(quality.confidenceScore||50))/100,.10,.40);
  const bear=total!=null?total*Math.pow(1-(.035+.04*uncertainty),HORIZON_YEARS):null;
  const bull=total!=null?total*Math.pow(1+(.035+.035*uncertainty),HORIZON_YEARS):null;
  const extremeReturn=hasValuation&&(expected<-.30||expected>.35);

  return {requiredReturn:req,methods,fiveYearPriceTarget:target,cumulativeDividends:dividends,totalShareholderValue:total,expectedCAGR:expected,fairValueEstimate:fair,marginOfSafety:mos,premiumToFairValue:premium,methodAgreementScore:agreement,bearCAGR:cagr(price,bear),baseCAGR:expected,bullCAGR:cagr(price,bull),netDebt,plausibilityFailure:!hasValuation,extremeReturnFlag:extremeReturn,valuationReviewFlag:extremeReturn?'extreme_blended_return_after_normalization':null};
}
module.exports={valuate};
