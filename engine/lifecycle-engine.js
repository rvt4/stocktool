'use strict';

const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;

function growthRates(years){
  const r=[]; for(let i=1;i<years.length;i++) if(years[i-1].revenue>0&&years[i].revenue>0) r.push(years[i].revenue/years[i-1].revenue-1); return r;
}

function classifyLifecycle(stock){
  const ys=stock.financials?.years||[];
  const recent=ys.slice(-5), last=recent.at(-1)||{};
  const rates=growthRates(recent);
  const historical=mean(rates.slice(-3))??0;
  const e=stock.analystEstimates||{};
  const forward1=e.revenueGrowthCurrentYear??e.revenueGrowthFwd??stock.growthYear1??historical;
  const forward2=e.revenueGrowthNextYear??forward1;
  const forward=mean([forward1,forward2].filter(Number.isFinite))??0;
  const avgRoic=mean(recent.slice(-3).map(y=>y.roic).filter(Number.isFinite));
  const positiveFcf=recent.length?recent.filter(y=>(y.fcf||0)>0).length/recent.length:0;
  const op=recent.map(y=>y.opMargin).filter(Number.isFinite);
  const marginRecovery=op.length>=3&&op.at(-1)>op[0]+0.025;
  const revenueDrawdown=rates.some(g=>g<-0.08);
  const industry=stock.valuation?.industryModel?.model||'';
  const dividendYield=stock.valuation?.dividendYield||0;

  let stage;
  if(['financials','utilities','reit'].includes(industry)) stage=industry==='financials'?'Financial':industry==='utilities'?'Utility':'Asset Heavy';
  else if(forward>=0.35) stage='Hyper Growth';
  else if(forward>=0.20) stage='Growth';
  else if(forward>=0.10&&avgRoic!=null&&avgRoic>=0.18&&positiveFcf>=0.75) stage='Elite Compounder';
  else if(forward>=0.07&&avgRoic!=null&&avgRoic>=0.10) stage='Compounder';
  else if(revenueDrawdown&&marginRecovery&&forward>=0) stage='Turnaround';
  else if(revenueDrawdown&&positiveFcf<0.6) stage='Cyclical';
  else if(dividendYield>=0.025&&forward<0.08) stage='Dividend Compounder';
  else stage='Mature';

  const config={
    'Hyper Growth':{forecastYears:12,fadeYears:14,terminalGrowth:0.04,multipleFade:'very-slow'},
    'Growth':{forecastYears:10,fadeYears:12,terminalGrowth:0.035,multipleFade:'slow'},
    'Elite Compounder':{forecastYears:9,fadeYears:15,terminalGrowth:0.035,multipleFade:'very-slow'},
    'Compounder':{forecastYears:8,fadeYears:12,terminalGrowth:0.03,multipleFade:'slow'},
    'Dividend Compounder':{forecastYears:7,fadeYears:10,terminalGrowth:0.025,multipleFade:'moderate'},
    'Turnaround':{forecastYears:7,fadeYears:7,terminalGrowth:0.025,multipleFade:'moderate'},
    'Cyclical':{forecastYears:6,fadeYears:5,terminalGrowth:0.02,multipleFade:'fast'},
    'Financial':{forecastYears:6,fadeYears:8,terminalGrowth:0.025,multipleFade:'moderate'},
    'Utility':{forecastYears:6,fadeYears:10,terminalGrowth:0.025,multipleFade:'moderate'},
    'Asset Heavy':{forecastYears:7,fadeYears:7,terminalGrowth:0.02,multipleFade:'fast'},
    'Mature':{forecastYears:5,fadeYears:7,terminalGrowth:0.025,multipleFade:'moderate'},
  }[stage];

  const confidence=clamp(0.35+(e.numAnalysts||0)/80+Math.min(recent.length,5)*0.05+(positiveFcf*0.15),0.35,0.95);
  return {stage,...config,forwardGrowth:forward,historicalGrowth:historical,avgRoic,positiveFcfRate:positiveFcf,confidence};
}

module.exports={classifyLifecycle};
