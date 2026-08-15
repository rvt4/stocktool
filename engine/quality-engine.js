'use strict';
const { clamp, median } = require('./config');

function scoreBand(v, bad, good) {
  if (!Number.isFinite(v)) return 50;
  if (good === bad) return 50;
  return Math.round(100 * clamp((v - bad) / (good - bad), 0, 1));
}
function reverseBand(v, good, bad) { return 100 - scoreBand(v, good, bad); }
function yoy(years, field) {
  const out=[]; for(let i=1;i<years.length;i++){const a=Number(years[i-1]?.[field]),b=Number(years[i]?.[field]);if(a>0&&Number.isFinite(b))out.push(b/a-1);} return out;
}
function stdev(a){const v=a.filter(Number.isFinite); if(v.length<2)return 0.15; const m=v.reduce((s,x)=>s+x,0)/v.length; return Math.sqrt(v.reduce((s,x)=>s+(x-m)**2,0)/v.length);}

function computeQuality(stock, forecast) {
  const years = stock.financials?.years || [];
  const last = years[years.length - 1] || {};
  const revenueGrowth = yoy(years.slice(-5),'revenue').filter(x=>x>-0.8&&x<2);
  const shareGrowth = yoy(years.slice(-4),'sharesOutTTM').filter(x=>x>-0.5&&x<0.5);
  const roic = median(years.slice(-3).map(y=>Number(y.roic)).filter(Number.isFinite));
  const fcfMargins = years.slice(-4).map(y=>Number(y.revenue)>0&&Number.isFinite(Number(y.fcf))?Number(y.fcf)/Number(y.revenue):null).filter(Number.isFinite);
  const opMargins = years.slice(-4).map(y=>Number(y.opMargin)).filter(Number.isFinite);
  const positiveFCF = years.length ? years.filter(y=>Number(y.fcf)>0).length/years.length : 0;
  const growthMed = median(revenueGrowth) ?? 0;
  const growthVol = stdev(revenueGrowth);
  const dilution = median(shareGrowth) ?? 0;
  const sbc = Number(last.sbcIntensity);
  const debt = Number(last.totalDebt ?? last.longTermDebt) || 0;
  const cash = Number(last.cash) || 0;
  const ebitda = Number(last.ebitda);
  const netDebtToEbitda = ebitda>0 ? (debt-cash)/ebitda : null;

  const isFinancial=stock.sector==='Financials';
  const netMargins=years.slice(-4).map(y=>Number(y.revenue)>0&&Number.isFinite(Number(y.netIncome))?Number(y.netIncome)/Number(y.revenue):null).filter(Number.isFinite);
  const profitability = isFinancial
    ? Math.round(0.55*scoreBand(median(netMargins)??0,0,.25)+0.45*scoreBand(growthMed,-.05,.15))
    : Math.round(0.55*scoreBand(roic,-0.02,0.25)+0.45*scoreBand(median(fcfMargins)??-0.05,-0.05,0.20));
  const growthQuality = Math.round(0.60*scoreBand(growthMed,-0.05,0.18)+0.40*reverseBand(growthVol,0.05,0.35));
  const cashQuality = isFinancial ? 55 : Math.round(70*positiveFCF + 0.30*scoreBand(median(fcfMargins)??-0.05,-0.05,0.15));
  const balanceSheet = Math.round(netDebtToEbitda==null?55:reverseBand(netDebtToEbitda,-1,4));
  const dilutionScore = Math.round(0.65*reverseBand(dilution,-0.03,0.08)+0.35*reverseBand(Number.isFinite(sbc)?sbc:0.03,0.00,0.15));
  const marginStability = reverseBand(stdev(opMargins),0.01,0.15);
  const qualityScore = Math.round(0.28*profitability+0.20*growthQuality+0.20*cashQuality+0.14*balanceSheet+0.10*dilutionScore+0.08*marginStability);

  const moatScore = Math.round(0.45*profitability+0.20*marginStability+0.20*growthQuality+0.15*dilutionScore);
  const capitalAllocationScore = Math.round(0.45*profitability+0.30*dilutionScore+0.25*balanceSheet);
  const compounderScore = Math.round(0.35*qualityScore+0.30*moatScore+0.20*growthQuality+0.15*capitalAllocationScore);
  const pricingPowerScore = Math.round(0.45*marginStability+0.30*profitability+0.25*scoreBand(growthMed,-0.03,0.12));
  const protectionScore = Math.round(0.50*balanceSheet+0.30*cashQuality+0.20*marginStability);

  const analystCount = Number(stock.analystEstimates?.numAnalysts) || 0;
  let confidence = 45;
  confidence += Math.min(25, years.length*5);
  confidence += Math.min(12, analystCount/3);
  confidence += forecast?.analystUsed ? 8 : 0;
  if (years.length < 3) confidence -= 15;
  if (stock.financials?.dataQuality?.revenueProxyYears) confidence -= 10;
  confidence = Math.round(clamp(confidence,25,95));

  return {
    qualityScore, moatScore, capitalAllocationScore, compounderScore, growthQualityScore:growthQuality,
    pricingPowerScore, protectionScore, confidenceScore:confidence,
    diagnostics:{ profitability, cashQuality, balanceSheet, dilutionScore, marginStability, roic, growthMedian:growthMed, growthVolatility:growthVol, dilutionRate:dilution, positiveFCFHistory:positiveFCF, netDebtToEbitda }
  };
}
module.exports={computeQuality};
