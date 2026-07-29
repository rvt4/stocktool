'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

function historicalGrowth(years) {
  const rates=[];
  for(let i=1;i<years.length;i++) if(years[i-1].revenue>0&&years[i].revenue>0) rates.push(years[i].revenue/years[i-1].revenue-1);
  return median(rates.slice(-5));
}

function trendGrowth(years) {
  const rates=[];
  for(let i=1;i<years.length;i++) if(years[i-1].revenue>0&&years[i].revenue>0) rates.push(years[i].revenue/years[i-1].revenue-1);
  if(!rates.length) return null;
  const recent=rates.slice(-3);
  return mean(recent.map((g,i)=>g*(i+1)))/mean(recent.map((_,i)=>i+1));
}

function generateForecast(stock, category, years=5, calibration=null) {
  const e=stock.analystEstimates||{};
  const financials=stock.financials?.years||[];
  const hist=historicalGrowth(financials);
  const trend=trendGrowth(financials);
  const fallback=stock.growthYear1??hist??0.05;
  let analyst1=e.revenueGrowthCurrentYear??e.revenueGrowthFwd??null;
  let analyst2=e.revenueGrowthNextYear??null;
  if(analyst2==null&&e.revenueCurrentYear>0&&e.revenueNextYear>0) analyst2=e.revenueNextYear/e.revenueCurrentYear-1;
  const avgRoic=mean(financials.slice(-3).map(y=>y.roic).filter(Number.isFinite));
  const reinvest=clamp(stock.reinvestmentRate??0.40,0.10,0.80);
  const sustainable=avgRoic!=null?clamp(avgRoic,0,0.40)*reinvest:null;
  const analystRel=clamp((e.numAnalysts||0)/25,0.20,1);
  const shockGap=analyst1!=null&&hist!=null?analyst1-hist:0;
  const regimeShift=Math.abs(shockGap)>=0.10;
  const industry=stock.valuation?.industryModel?.model||'general';
  const cal=calibration?.forecastByIndustry?.[industry]||calibration?.forecastOverall||{};
  const analystBias=Number(cal.analystBias)||0;
  const historyBias=Number(cal.historyBias)||0;
  const ownBias=Number(cal.ownBias)||0;

  let weights={ analyst: analyst1!=null ? 0.46 : 0, history: hist!=null ? 0.22 : 0, trend: trend!=null ? 0.12 : 0, sustainable: sustainable!=null ? 0.20 : 0 };
  if(regimeShift){ weights.analyst+=0.16; weights.history*=0.55; weights.trend*=0.55; }
  if(analystRel<0.45){ weights.analyst*=0.72; weights.history*=1.15; weights.sustainable*=1.10; }
  const total=Object.values(weights).reduce((a,b)=>a+b,0)||1;
  Object.keys(weights).forEach(k=>weights[k]/=total);

  const corrected={
    analyst: analyst1==null?null:analyst1+analystBias,
    history: hist==null?null:hist+historyBias,
    trend: trend==null?null:trend+historyBias,
    sustainable: sustainable==null?null:sustainable+ownBias,
  };
  const y1=clamp(Object.entries(weights).reduce((s,[k,w])=>s+(corrected[k]??0)*w,0),-0.30,0.70);
  const raw2=analyst2!=null?analyst2+analystBias:y1*(['Hyper Growth','Growth','Compounder'].includes(category)?0.88:0.75);
  const y2=clamp(raw2,-0.25,0.60);
  const terminalFloor=['Hyper Growth','Growth'].includes(category)?0.06:category==='Compounder'?0.045:0.025;
  const persistence=category==='Hyper Growth'?0.48:category==='Growth'?0.55:category==='Compounder'?0.66:0.78;
  const anchor=clamp(mean([Math.max(0,hist??y2),Math.max(0,sustainable??y2),Math.max(0,y2)])??y2,terminalFloor,0.30);
  const y5=clamp(anchor*persistence+terminalFloor*(1-persistence),terminalFloor,Math.max(terminalFloor,y2*0.78));
  const path=[y1,y2];
  for(let t=3;t<=years;t++){ const p=(t-2)/Math.max(1,years-2); path.push(y2+(y5-y2)*Math.pow(p,category==='Hyper Growth'?1.45:1.15)); }
  return { path:path.slice(0,years), source:'v9_blended_forecast', assumptions:{ analyst1,analyst2,historical:hist,trend,sustainable,weights,regimeShift,shockGap,analystReliability:analystRel,calibrationApplied:!!calibration?.isCalibrated,year1:y1,year2:y2,year5:y5 } };
}

module.exports={generateForecast,historicalGrowth,trendGrowth};
