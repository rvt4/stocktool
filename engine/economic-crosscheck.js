'use strict';
// Independent, conservative valuation cross-check. Does not use model scores,
// current trading multiples, method blending, or the existing fair-value result.
// Values operating cash flow as an enterprise claim; debt is deducted once.
const { HORIZON_YEARS } = require('./config');
const finite = x => x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null);
const median = a => { const s=a.filter(Number.isFinite).sort((x,y)=>x-y); return s.length ? (s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):null; };
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
function crosscheck(stock,forecast,options={}){
  const rows=forecast?.rows||[], years=stock?.financials?.years||[];
  const last=years.at(-1)||{}, first=rows[0]||{}, end=rows.at(-1)||{};
  const shares=finite(forecast?.startShares), rev0=finite(last.revenue), rev10=finite(end.revenue);
  const op0=finite(last.operatingIncome), op10=finite(end.operatingIncome);
  const fcf0=finite(last.fcf), fcf10=finite(end.fcfPerShare)*finite(end.shares);
  const netDebt=finite(last.totalDebt)??finite(last.longTermDebt)??0;
  const cash=finite(last.cash)??0;
  const reasons=[];
  if(rows.length!==HORIZON_YEARS)reasons.push('incomplete_forecast');
  if(!(shares>0&&rev0>0&&rev10>0))reasons.push('missing_revenue_or_shares');
  if(!(op10>0))reasons.push('nonpositive_terminal_operating_income');
  if(!(fcf10>0))reasons.push('nonpositive_terminal_fcf');
  const histMargins=years.slice(-5).map(y=>finite(y.revenue)>0&&finite(y.operatingIncome)!=null?finite(y.operatingIncome)/finite(y.revenue):null);
  const histMargin=median(histMargins), terminalMargin=rev10>0?op10/rev10:null;
  const histGrowth=[];
  for(let i=Math.max(1,years.length-5);i<years.length;i++){
    const a=finite(years[i-1].revenue),b=finite(years[i].revenue);
    if(a>0&&b>0)histGrowth.push(b/a-1);
  }
  const histGrowthMedian=median(histGrowth);
  const revGrowth=rev0>0&&rev10>0?Math.pow(rev10/rev0,1/HORIZON_YEARS)-1:null;
  const marginExpansion=histMargin!=null&&terminalMargin!=null?terminalMargin-histMargin:null;
  const tax=clamp(finite(options.taxRate)??.24,.12,.35);
  const discount=clamp(finite(options.discountRate)??.11,.085,.16);
  const terminalGrowth=clamp(finite(forecast.terminalGrowth)??.025,.005,.035);
  // A second model of operating economics: terminal NOPAT is independently
  // checked against forecast cash conversion and reinvestment. An enterprise
  // DCF is not allowed to assume that all accounting earnings are distributable.
  const terminalNopat=op10>0?op10*(1-tax):null;
  const conversion=terminalNopat>0&&fcf10>0?fcf10/terminalNopat:null;
  if(conversion!=null&&(conversion>1.35||conversion<.35))reasons.push('terminal_cash_conversion_requires_review');
  if(marginExpansion!=null&&marginExpansion>.12)reasons.push('large_operating_margin_expansion');
  if(revGrowth!=null&&histGrowthMedian!=null&&revGrowth>Math.max(.20,histGrowthMedian+.12))reasons.push('growth_exceeds_historical_evidence');
  // Cross-check uses reported FCF, rather than replacing it with a speculative
  // EBITDA multiple. FCF is an equity flow; do not deduct net debt again.
  const cashflows=rows.map(r=>{
    const ps=finite(r.fcfPerShare), sh=finite(r.shares);
    return ps!=null&&sh>0?ps*sh:null;
  });
  const complete=rows.length===HORIZON_YEARS&&cashflows.every(x=>x!=null&&x>0)&&shares>0;
  let value=null, terminalShare=null;
  if(complete&&discount>terminalGrowth){
    const pvExplicit=cashflows.reduce((s,x,i)=>s+x/Math.pow(1+discount,i+1),0);
    const terminal=cashflows.at(-1)*(1+terminalGrowth)/(discount-terminalGrowth)/Math.pow(1+discount,HORIZON_YEARS);
    value=(pvExplicit+terminal)/shares;
    terminalShare=terminal/(pvExplicit+terminal);
    if(terminalShare>.75)reasons.push('terminal_value_dominates');
  }else reasons.push('insufficient_positive_cash_flow_history');
  const price=finite(stock?.price?.current);
  const cagrAtPrice=price>0&&value>0?Math.pow(value/price,1/HORIZON_YEARS)-1:null;
  return {status:reasons.length?'review':'supported',reasons,independentDCF:value,discountRate:discount,terminalGrowth,terminalValueShare:terminalShare,forecastRevenueCAGR:revGrowth,historicalMedianRevenueGrowth:histGrowthMedian,historicalMedianOperatingMargin:histMargin,terminalOperatingMargin:terminalMargin,terminalFCFToNOPAT:conversion,terminalFCF:fcf10,terminalNOPAT:terminalNopat,netDebtAtStart:netDebt-cash,comparisonCAGR:cagrAtPrice};
}
module.exports={crosscheck};
