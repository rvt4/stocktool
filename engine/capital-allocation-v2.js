'use strict';
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function mean(a) { const c=a.filter(Number.isFinite); return c.length?c.reduce((s,x)=>s+x,0)/c.length:null; }
function cagr(a,b,n){ return a>0&&b>0&&n>0?Math.pow(b/a,1/n)-1:null; }
function band(v, poor, good){ if(!Number.isFinite(v))return 50; return Math.round(clamp((v-poor)/(good-poor),0,1)*100); }

function computeCapitalAllocationV2(stock) {
  const years=(stock.financials?.years||[]).slice(-6); const last=years.at(-1)||{};
  const roics=years.map(y=>Number(y.roic)).filter(Number.isFinite).map(v=>Math.abs(v)>2?v/100:v);
  const firstRoic=roics[0], lastRoic=roics.at(-1);
  const incrementalRoic=Number.isFinite(firstRoic)&&Number.isFinite(lastRoic)?lastRoic-firstRoic:null;
  const shares=years.map(y=>Number(y.sharesOutTTM)).filter(v=>v>0);
  const dilution=shares.length>=2?cagr(shares[0],shares.at(-1),shares.length-1):null;
  const debt=years.map(y=>Number(y.longTermDebt??y.totalDebt)).filter(Number.isFinite);
  const debtTrend=debt.length>=2&&Math.abs(debt[0])>0?(debt.at(-1)-debt[0])/Math.abs(debt[0]):null;
  const fcf=years.map(y=>Number(y.fcf)).filter(Number.isFinite);
  const buybackQuality=band(Number.isFinite(dilution)?-dilution:null,-.08,.03);
  const reinvestment=band(mean(roics),.04,.25)*.65+band(incrementalRoic,-.05,.08)*.35;
  const debtDiscipline=Number.isFinite(debtTrend)?band(-debtTrend,-.75,.25):50;
  const fcfCoverage=years.length?years.filter(y=>Number(y.fcf)>0).length/years.length:null;
  const cashDiscipline=band(fcfCoverage,.4,1);
  const existing=Number(stock.valuation?.capitalAllocation?.score);
  const score=Math.round(clamp(reinvestment*.40+buybackQuality*.25+debtDiscipline*.15+cashDiscipline*.15+(Number.isFinite(existing)?existing:50)*.05,0,100));
  const flags=[];
  if(Number.isFinite(dilution)&&dilution>.035)flags.push('Persistent share dilution');
  if(Number.isFinite(incrementalRoic)&&incrementalRoic<-.04)flags.push('ROIC has deteriorated');
  if(Number.isFinite(debtTrend)&&debtTrend>.75)flags.push('Debt increased materially');
  return {version:'capital-allocation-v2',score,reinvestmentScore:Math.round(reinvestment),buybackQuality,debtDiscipline,cashDiscipline,incrementalRoic,annualDilution:dilution,flags};
}
module.exports={computeCapitalAllocationV2};
