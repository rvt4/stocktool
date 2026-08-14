'use strict';
const { HORIZON_YEARS, MARKET_RETURN, sectorConfig, clamp } = require('./config');

function weightedMean(items) {
  const valid=items.filter(x=>Number.isFinite(x.value)&&x.value>0&&x.weight>0); if(!valid.length)return null;
  const sorted=valid.map(x=>x.value).sort((a,b)=>a-b); const med=sorted[Math.floor(sorted.length/2)];
  const capped=valid.map(x=>({...x,value:clamp(x.value,med*0.45,med*2.2)}));
  const w=capped.reduce((s,x)=>s+x.weight,0); return capped.reduce((s,x)=>s+x.value*x.weight,0)/w;
}
function cagr(price, future) { if(!(price>0)||!(future>0))return null; return Math.pow(future/price,1/HORIZON_YEARS)-1; }
function pv(value, r, n){return value/Math.pow(1+r,n);}

function requiredReturn(quality, category) {
  let r=MARKET_RETURN;
  if(category==='Hyper Growth')r+=0.02; else if(category==='Growth')r+=0.01;
  if((quality?.confidenceScore||50)<60)r+=0.01;
  if((quality?.protectionScore||50)<45)r+=0.01;
  if((quality?.qualityScore||50)>=85&&category==='Compounder')r-=0.01;
  return clamp(r,0.09,0.14);
}

function dcfMethod(forecast, quality, req) {
  const rows=forecast.rows||[]; if(!rows.length||!rows.every(r=>Number.isFinite(r.fcf)))return null;
  if(rows[0].fcf<=0 && rows[rows.length-1].fcf<=0)return null;
  let pvExplicit=0; for(let i=0;i<rows.length;i++) pvExplicit += pv(Math.max(0,rows[i].fcf),req,i+1);
  const g=Math.min(forecast.terminalGrowth,req-0.025); const terminalFCF=Math.max(0,rows[rows.length-1].fcf)*(1+g);
  const terminal=terminalFCF/(req-g); const pvTerminal=pv(terminal,req,rows.length);
  const last=rows[rows.length-1]; const shares=last.shares; if(!(shares>0))return null;
  const stockLastNetDebt = null;
  return { enterpriseValue:pvExplicit+pvTerminal, pvExplicit, pvTerminal, shares };
}

function valuate(stock, forecast, quality) {
  const rows=forecast.rows||[]; const lastF=rows[rows.length-1]||{}; const years=stock.financials?.years||[]; const last=years[years.length-1]||{};
  const price=Number(stock.price?.current); const shares=Number(lastF.shares); const cfg=sectorConfig(stock.sector); const req=requiredReturn(quality,forecast.category);
  const debt=(Number(last.totalDebt)||Number(last.longTermDebt)||0); const cash=Number(last.cash)||0; const netDebt=debt-cash;
  const qAdj=clamp(((quality.qualityScore||50)-60)/100,-0.18,0.20)||0;
  const g=forecast.terminalGrowth;

  const methods=[];
  const dcf=dcfMethod(forecast,quality,req);
  if(dcf&&shares>0){ const fair=dcf.enterpriseValue/shares; if(fair>0) methods.push({name:'DCF (FCF)',today:fair,target:null,outcome:fair*Math.pow(1+req,HORIZON_YEARS),weight:0.40,audit:{pvExplicit:dcf.pvExplicit,pvTerminal:dcf.pvTerminal,terminalShare:dcf.pvTerminal/dcf.enterpriseValue,note:'CFO-capex is treated as equity cash flow; net debt is not subtracted a second time.'}}); }

  if(Number.isFinite(lastF.fcfPerShare)&&lastF.fcfPerShare>0){
    const fundamentalMultiple=clamp(1/Math.max(0.035,req-g),10,26); const multiple=clamp(fundamentalMultiple*(1+qAdj),8,30);
    methods.push({name:'FCF exit',target:lastF.fcfPerShare*multiple,outcome:null,weight:0.30,audit:{exitMultiple:multiple,metric:lastF.fcfPerShare}});
  }
  if(Number.isFinite(lastF.eps)&&lastF.eps>0){ const pe=clamp((cfg.basePE+g*45)*(1+qAdj),8,32); methods.push({name:'EPS exit',target:lastF.eps*pe,outcome:null,weight:stock.sector==='Financials'?0.45:0.20,audit:{exitMultiple:pe,metric:lastF.eps}}); }
  if(Number.isFinite(lastF.ebitda)&&lastF.ebitda>0&&shares>0&&stock.sector!=='Financials'){
    const mult=clamp((cfg.baseEVEBITDA+g*25)*(1+qAdj),6,20); const equity=lastF.ebitda*mult-netDebt; if(equity>0)methods.push({name:'EV/EBITDA exit',target:equity/shares,outcome:null,weight:0.10,audit:{exitMultiple:mult,metric:lastF.ebitda}});
  }

  const dividends=rows.reduce((s,r)=>s+(Number(r.dividendPerShare)||0),0);
  for(const m of methods){
    if(!Number.isFinite(m.outcome) && Number.isFinite(m.target)) m.outcome=m.target+dividends;
    if(!Number.isFinite(m.target) && Number.isFinite(m.outcome)) m.target=Math.max(0,m.outcome-dividends);
  }
  const totalFuture=weightedMean(methods.map(m=>({value:m.outcome,weight:m.weight})));
  const target=totalFuture!=null?Math.max(0,totalFuture-dividends):null;
  const expectedCAGR=cagr(price,totalFuture);
  const fairValue=totalFuture!=null?pv(totalFuture,req,HORIZON_YEARS):null;
  const mos=(fairValue>0&&price>0)?1-price/fairValue:null;
  const premium=(fairValue>0&&price>0)?price/fairValue-1:null;

  const methodTargets=methods.map(m=>m.outcome).filter(Number.isFinite); let agreement=0;
  if(methodTargets.length>=2){const mean=methodTargets.reduce((s,x)=>s+x,0)/methodTargets.length;const sd=Math.sqrt(methodTargets.reduce((s,x)=>s+(x-mean)**2,0)/methodTargets.length);agreement=Math.round(100*clamp(1-sd/Math.max(mean,1),0,1));} else if(methodTargets.length===1) agreement=45;

  const uncertainty = clamp((100-(quality.confidenceScore||50))/100,0.08,0.45);
  const bearOutcome=totalFuture!=null?totalFuture*(1-(0.20+0.30*uncertainty)):null;
  const bullOutcome=totalFuture!=null?totalFuture*(1+(0.20+0.25*uncertainty)):null;
  const bearCAGR=cagr(price,bearOutcome), bullCAGR=cagr(price,bullOutcome);

  return { requiredReturn:req, methods, fiveYearPriceTarget:target, cumulativeDividends:dividends, totalShareholderValue:totalFuture, expectedCAGR, fairValueEstimate:fairValue, marginOfSafety:mos, premiumToFairValue:premium, methodAgreementScore:agreement, bearCAGR, baseCAGR:expectedCAGR, bullCAGR, netDebt };
}
module.exports={valuate};
