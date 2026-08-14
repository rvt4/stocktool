'use strict';
const { HORIZON_YEARS, MARKET_RETURN, sectorConfig, clamp, median } = require('./config');
function cagr(p,f){if(!(p>0)||!(f>0))return null;return Math.pow(f/p,1/HORIZON_YEARS)-1;}
function pv(v,r,n){return v/Math.pow(1+r,n);}
function requiredReturn(q,cat){let r=MARKET_RETURN;if(cat==='Hyper Growth')r+=.02;else if(cat==='Growth')r+=.01;if((q?.confidenceScore||50)<60)r+=.01;if((q?.protectionScore||50)<45)r+=.01;return clamp(r,.09,.14);}
function blend(items){const v=items.filter(x=>Number.isFinite(x.value)&&x.value>0&&x.weight>0);if(!v.length)return null;const w=v.reduce((s,x)=>s+x.weight,0);return v.reduce((s,x)=>s+x.value*x.weight,0)/w;}
function boundedExit(current, justified, lo, hi){
  let j=clamp(justified,lo,hi); if(Number.isFinite(current)&&current>0){const sane=clamp(current,lo*.65,hi*1.5);j=.55*j+.45*sane; j=clamp(j,Math.max(lo,sane*.65),Math.min(hi,sane*1.35));} return j;
}
function valuate(stock,forecast,quality){
  const rows=forecast.rows||[], f=rows.at(-1)||{}, years=stock.financials?.years||[], last=years.at(-1)||{}, price=Number(stock.price?.current), cfg=sectorConfig(stock.sector), req=requiredReturn(quality,forecast.category);
  const shares0=Number(last.sharesOutTTM), netDebt=(Number(last.totalDebt)||Number(last.longTermDebt)||0)-(Number(last.cash)||0), marketCap=price>0&&shares0>0?price*shares0:null;
  const eps0=Number.isFinite(Number(last.dilutedEPS))&&Number(last.dilutedEPS)>0?Number(last.dilutedEPS):(shares0>0&&Number(last.netIncome)>0?Number(last.netIncome)/shares0:null);
  const fcf0=shares0>0&&Number(last.fcfSBCAdjusted??last.fcf)>0?Number(last.fcfSBCAdjusted??last.fcf)/shares0:null;
  const ebitda0=Number(last.ebitda)>0?Number(last.ebitda):null;
  const currentPE=price>0&&eps0>0?price/eps0:null, currentPFCF=price>0&&fcf0>0?price/fcf0:null;
  const currentEVEBITDA=marketCap>0&&ebitda0>0?(marketCap+netDebt)/ebitda0:null;
  const revenue0=Number(last.revenue)>0?Number(last.revenue):null;
  const currentEVSales=marketCap>0&&revenue0>0?(marketCap+netDebt)/revenue0:null;
  const q=(quality.qualityScore||50)/100, growth=clamp(forecast.sustainableGrowth??forecast.revenueGrowthAnchor,0,.25);
  const methods=[];

  // The terminal multiple is anchored to BOTH business economics and today's observable multiple.
  // This prevents one noisy SEC denominator from creating 50%-200% annual-return fantasies.
  if(stock.sector==='Financials'){
    if(Number(f.eps)>0){const justified=cfg.basePE+growth*28+(q-.5)*6;const m=boundedExit(currentPE,justified,7,22);methods.push({name:'EPS exit',target:f.eps*m,weight:1,audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps}});}
  } else {
    if(Number(f.fcfPerShare)>0){const justified=14+growth*38+(q-.5)*8;const m=boundedExit(currentPFCF,justified,9,30);methods.push({name:'FCF exit',target:f.fcfPerShare*m,weight:.50,audit:{exitMultiple:m,currentMultiple:currentPFCF,metric:f.fcfPerShare}});}
    if(Number(f.eps)>0){const justified=cfg.basePE+growth*35+(q-.5)*7;const m=boundedExit(currentPE,justified,8,32);methods.push({name:'EPS exit',target:f.eps*m,weight:.35,audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps}});}
    if(Number(f.ebitda)>0&&Number(f.shares)>0){const justified=cfg.baseEVEBITDA+growth*18+(q-.5)*4;const m=boundedExit(currentEVEBITDA,justified,6,20);const equity=f.ebitda*m-netDebt;if(equity>0)methods.push({name:'EV/EBITDA exit',target:equity/f.shares,weight:.15,audit:{exitMultiple:m,currentMultiple:currentEVEBITDA,metric:f.ebitda}});}
  }
  // If earnings/FCF are not yet usable, do not give up on an otherwise modelable
  // operating business. Use a conservative EV/Sales bridge based on the year-5
  // revenue base, growth durability, projected EBITDA economics, and sector norms.
  // This is a general fallback (not a ticker override) for firms whose current
  // profitability makes P/E, P/FCF, and EV/EBITDA temporarily unusable.
  if(!methods.length && stock.sector!=='Financials' && Number(f.revenue)>0 && Number(f.shares)>0){
    const terminalEbitdaMargin=clamp(Number(f.ebitdaMargin)||0,0,.60);
    const normalizedMargin=Math.max(.04,terminalEbitdaMargin);
    const economicsMultiple=cfg.baseEVEBITDA*normalizedMargin;
    const growthPremium=clamp(growth-.04,0,.21)*12;
    const qualityPremium=(q-.5)*1.5;
    const justified=clamp(economicsMultiple+growthPremium+qualityPremium,.5,12);
    const m=boundedExit(currentEVSales,justified,.5,12);
    const equity=Number(f.revenue)*m-netDebt;
    if(equity>0)methods.push({name:'EV/Sales fallback',target:equity/Number(f.shares),weight:1,audit:{exitMultiple:m,currentMultiple:currentEVSales,metric:f.revenue,reason:'profitability_methods_unavailable'}});
  }

  const dividends=rows.reduce((s,r)=>s+(Number(r.dividendPerShare)||0),0);
  for(const m of methods)m.outcome=Number.isFinite(m.target)?m.target+dividends:null;
  let total=blend(methods.map(m=>({value:m.outcome,weight:m.weight})));
  let expected=cagr(price,total);
  // Extreme returns are a reason to distrust the precision, not a reason to erase the
  // valuation. Keeping the canonical outcome means expensive/high-optionality companies
  // can still receive a Sell/Hold/etc. rating while diagnostics flag the result for review.
  const hasValuation=Number.isFinite(expected)&&methods.length>0&&Number.isFinite(total)&&total>0;
  const extremeReturn=hasValuation&&(expected<-.30||expected>.35);
  const plausible=hasValuation&&!extremeReturn;
  if(!hasValuation){total=null;expected=null;}
  const target=total!=null?Math.max(0,total-dividends):null, fair=total!=null?pv(total,req,HORIZON_YEARS):null, mos=fair>0&&price>0?1-price/fair:null, premium=fair>0&&price>0?price/fair-1:null;
  const returns=methods.map(m=>cagr(price,m.outcome)).filter(Number.isFinite), spread=returns.length>=2?Math.max(...returns)-Math.min(...returns):null;
  const agreement=returns.length>=2?Math.round(100*clamp(1-spread/.25,0,1)):(returns.length===1?55:0);
  const uncertainty=clamp((100-(quality.confidenceScore||50))/100,.10,.40), bear=total!=null?total*Math.pow(1-(.035+.04*uncertainty),HORIZON_YEARS):null, bull=total!=null?total*Math.pow(1+(.035+.035*uncertainty),HORIZON_YEARS):null;
  return {requiredReturn:req,methods,fiveYearPriceTarget:target,cumulativeDividends:dividends,totalShareholderValue:total,expectedCAGR:expected,fairValueEstimate:fair,marginOfSafety:mos,premiumToFairValue:premium,methodAgreementScore:agreement,bearCAGR:cagr(price,bear),baseCAGR:expected,bullCAGR:cagr(price,bull),netDebt,plausibilityFailure:!hasValuation,extremeReturnFlag:extremeReturn,valuationReviewFlag:extremeReturn?'extreme_canonical_return':null};
}
module.exports={valuate};
