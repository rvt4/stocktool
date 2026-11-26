'use strict';
// Build 98 (C-v3): tax rate, stale interest, double-counted near-term margin dip; consensus comparison display.
const assert=require('assert');
const {buildForecast,normalizeTaxRate}=require('./engine/forecast-engine');
const RS=require('./research-summary');
const RP=require('./review-policy');

// 1) Tax rate
assert.strictEqual(normalizeTaxRate([.12,0,0,0,.02]),.21,'UBER-like allowance releases: fall back to 21%');
{const t=normalizeTaxRate([.45,.18,.30,.28,.26]);assert(t>.21&&t<.27,'VRT-like erratic history pulled toward 21%: '+t);}
assert.strictEqual(normalizeTaxRate([.12,.13,.14,.13,.13]),.13,'a steady low payer keeps its rate');
assert.strictEqual(normalizeTaxRate([.10,.10,.10,.10,-.2]),.10,'one benefit year does not move a steady payer');
assert.strictEqual(normalizeTaxRate([]),.21);

// Fixture helper
function co({op,nonop,taxes,debt,cash,g=.2,cy,ny,rg1=.25,rg2=.2,n=30,nm=null,capex=.03,shares=0.4e9,rev0=10e9,sector='Industrials'}){
  const years=[];let revenue=rev0;
  taxes.forEach((t,i)=>{revenue*=1+g;const o=revenue*op,pre=o+revenue*nonop[i],tax=pre*t;
    years.push({year:2021+i,revenue,operatingIncome:o,pretaxIncome:pre,incomeTaxExpense:tax,netIncome:pre-tax,ebitda:o+revenue*.03,cfo:o*1.05,capex:revenue*capex,fcf:o*1.05-revenue*capex,sbc:revenue*.005,sharesOutTTM:shares,totalDebt:debt[i],cash:cash[i],grossProfit:revenue*.4,dilutedEPS:(pre-tax)/shares});});
  const last=years.at(-1),r1=revenue*(1+rg1),r2=r1*(1+rg2);
  const ae=cy==null?{numAnalysts:0}:{numAnalysts:n,revenueCurrentYear:r1,revenueNextYear:r2,revenueGrowthCurrentYear:rg1,revenueGrowthNextYear:rg2,
    epsCurrentYear:cy*r1/shares,epsNextYear:ny*r2/shares,epsGrowthCurrentYear:cy*r1/shares/last.dilutedEPS-1,epsGrowthNextYear:(ny*r2)/(cy*r1)-1};
  return {ticker:'T98',sector,financials:{years,dataQuality:{}},growthYear1:rg1,price:{current:150},valuation:{dividendYield:0,growthSource:'t'},analystEstimates:ae};
}

// 2) Stale interest: once-levered company now holding little debt. Long-run non-op is capped at today's-debt
//    interest minus 1 pt of revenue (it used to stay at the 5-year typical ~-3%).
{const f=buildForecast(co({op:.22,nonop:[-.04,-.035,-.03,-.02,-.015],taxes:[.25,.25,.25,.25,.25],debt:[3.5e9,3.3e9,3e9,3e9,2.9e9],cash:[.5e9,.6e9,1e9,1.8e9,2.5e9]}));
 for(let i=2;i<10;i++)assert(f.rows[i].nonOperatingMargin>=-.0135,'year '+(i+1)+' non-op '+f.rows[i].nonOperatingMargin);}
// A persistent non-interest cost with real debt is kept (not all non-op is interest).
{const f=buildForecast(co({op:.20,nonop:[-.01,-.01,-.01,-.01,-.01],taxes:[.2,.2,.2,.2,.2],debt:[2e9,2e9,2e9,2e9,2e9],cash:[1e9,1e9,1e9,1e9,1e9]}));
 assert(f.rows[5].nonOperatingMargin<=-.009,'persistent -1% kept: '+f.rows[5].nonOperatingMargin);}

// 3) Near-term dip not counted twice (META-like: consensus sees the margin falling ~20% over two years).
{const years=[];let revenue=100e9;const shares=2.5e9,nm=.34;
 for(let i=0;i<6;i++){revenue*=1.2;const op=revenue*(nm+.02),tax=op*.15;
   years.push({year:2020+i,revenue,operatingIncome:op,pretaxIncome:op,incomeTaxExpense:tax,netIncome:op-tax,ebitda:op+revenue*.1,cfo:op*1.1,capex:revenue*.3,fcf:op*1.1-revenue*.3,sbc:revenue*.1,sharesOutTTM:shares,totalDebt:30e9,cash:50e9,grossProfit:revenue*.8,dilutedEPS:(op-tax)/shares});}
 const eps0=years.at(-1).dilutedEPS,r1=revenue*1.25,r2=r1*1.2;
 const ae={numAnalysts:40,revenueCurrentYear:r1,revenueNextYear:r2,revenueGrowthCurrentYear:.25,revenueGrowthNextYear:.2,epsCurrentYear:eps0*1.1,epsNextYear:eps0*1.1*1.08,epsGrowthCurrentYear:.1,epsGrowthNextYear:.08};
 const f=buildForecast({ticker:'MX',sector:'Communication Services',financials:{years,dataQuality:{}},growthYear1:.25,price:{current:600},valuation:{dividendYield:0,growthSource:'t'},analystEstimates:ae});
 const consNet2=ae.epsNextYear*shares/r2;
 assert(f.forecastBridge.margins.marginEvidence.nearTermDip,'fixture should trigger the dip rule');
 assert(f.rows[1].netMargin>=consNet2-.01,'year-2 margin no longer far below consensus: '+f.rows[1].netMargin+' vs '+consNet2);
 assert(f.rows[1].eps>=ae.epsNextYear*.95,'year-2 EPS within 5% of consensus: '+f.rows[1].eps+' vs '+ae.epsNextYear);
 // Build 99: the expected fall is kept, once (Build 98 removed it and META ended 9% above consensus).
 assert(f.rows[1].netMargin<f.rows[0].netMargin-.01,'year-2 margin should still fall: '+f.rows[0].netMargin+' -> '+f.rows[1].netMargin);
 assert(f.rows[1].eps<=ae.epsNextYear*1.03,'year-2 EPS not above consensus: '+f.rows[1].eps+' vs '+ae.epsNextYear);}
// Build 99: erratic low-tax history moves a third of the way to 21%, not half.
{const t=normalizeTaxRate([.19,.05,.04,.09,.15]);assert(t<.17,'AMD-like erratic low payer: '+t);}

// 4) Display: consensus comparison and one-time quarters
{const s={analystEstimates:{epsCurrentYear:12.8,epsNextYear:10.66},valuationProjection:[{eps:8.57},{eps:10.07}],
   projectionAssumptions:{forecastBridge:{margins:{analystMarginAnchor:{consensusOneOff:true,consensusBasis:'includes_sbc'}}}}};
 const c=RS.consensusGap(s);assert.strictEqual(c.length,2);assert(/one-time/.test(c[0].reason));assert(c[1].gap<0&&/part of the way/.test(c[1].reason));}
assert(RS.oneTimeReport({surprise:2.15})&&!RS.oneTimeReport({surprise:.2}));
{const b=RS.beats({research:{earnings:{reports:[{actual:1,estimate:1.1,surprise:-.09},{actual:5.75,estimate:1.82,surprise:2.15},{actual:1,estimate:.9,surprise:.11}]}}});
 assert.strictEqual(b.n,2,'one-time quarter left out of the beat count');}
assert(['C-v3','C-v4'].includes(RP.STRATEGY.id));  // Build 99: C-v4
console.log('build98 tests passed');
