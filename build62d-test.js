'use strict';
// Build 62d: proven high-margin businesses are not capped by the sector margin rail.
// Visa (Financials) earns ~51-55% net; the Financials rail (35% + 8 pts = 43%) started its forecast 9 pts low.
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
function co({ticker,sector,net,op,growth=.10}){
  const years=[];let revenue=30e9;
  for(let i=0;i<5;i++){revenue*=1+growth;const n=net[i],o=op[i];
    years.push({year:2022+i,revenue,grossProfit:revenue*.8,operatingIncome:revenue*o,opMargin:o,netIncome:revenue*n,
      ebitda:revenue*(o+.03),fcf:revenue*(n-.01),fcfSBCAdjusted:revenue*(n-.02),operatingCashFlow:revenue*(n+.01),
      capex:revenue*.03,sharesOutTTM:2e9,roic:.35,totalDebt:20e9,cash:15e9,sbcIntensity:.01});}
  return {ticker,sector,financials:{years,dataQuality:{}},analystEstimates:{revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth,epsGrowthCurrentYear:growth+.01,epsGrowthNextYear:growth+.01,numAnalysts:30},growthYear1:growth,price:{current:300},valuation:{growthSource:'test'}};
}
// 1) Visa-like: net 51-55%, op 64-67%
const v=buildForecast(co({ticker:'V',sector:'Financials',net:[.51,.53,.55,.54,.52],op:[.64,.65,.67,.66,.65]}));
const r=v.forecastBridge.margins.provenMarginRails;
assert(r.net.proven&&r.net.rail>.55,'Visa net rail not relaxed: '+JSON.stringify(r.net));
assert(v.rows[0].netMargin>.48,'Visa year-1 net margin still capped: '+v.rows[0].netMargin);
assert(v.rows.at(-1).netMargin>.46,'Visa year-10 net margin collapsed: '+v.rows.at(-1).netMargin);
// 2) Ordinary Financials company at 30% net: rail unchanged
const o=buildForecast(co({ticker:'O',sector:'Financials',net:[.28,.30,.31,.30,.29],op:[.38,.40,.41,.40,.39]}));
assert(!o.forecastBridge.margins.provenMarginRails.net.proven&&Math.abs(o.forecastBridge.margins.provenMarginRails.net.rail-.43)<1e-9,'ordinary company rail changed');
// 3) One spike year (above rail only once) does not earn the exception
const s=buildForecast(co({ticker:'S',sector:'Financials',net:[.30,.31,.60,.32,.33],op:[.40,.41,.70,.42,.43]}));
assert(!s.forecastBridge.margins.provenMarginRails.net.proven,'single spike year relaxed the rail');
// 4) Utility with a revenue-tag artifact (XEL/DTE show 62-75% "net margin"): stays on the sector rail
const u=buildForecast(co({ticker:'U',sector:'Utilities',net:[.70,.72,.75,.74,.73],op:[.80,.81,.82,.82,.81]}));
assert(!u.forecastBridge.margins.provenMarginRails.net.proven,'utility revenue artifact relaxed the rail');
console.log('Build 62d proven-margin rail tests passed',JSON.stringify({visaY1:+v.rows[0].netMargin.toFixed(3),visaY10:+v.rows.at(-1).netMargin.toFixed(3),rail:+r.net.rail.toFixed(3)}));
