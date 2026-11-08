'use strict';
// Build 59: decade-out margins must be supported by evidence (history, consensus, independent signals).
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');

// Five years of history with operating margin rising steadily (a trend the old logic extrapolated).
function trending({ticker='TREND',startOp=.06,step=.012,growth=.15,consensus=null}={}){
  const years=[];let revenue=8e9;
  for(let i=0;i<5;i++){
    revenue*=1+growth; const op=startOp+step*i, gross=.20+step*i;
    years.push({year:2021+i,revenue,grossProfit:revenue*gross,operatingIncome:revenue*op,opMargin:op,
      netIncome:revenue*(op-.025),ebitda:revenue*(op+.02),fcf:revenue*(op-.02),fcfSBCAdjusted:revenue*(op-.025),
      operatingCashFlow:revenue*(op+.005),capex:revenue*.025,sharesOutTTM:200e6,roic:.18,totalDebt:1e9,cash:1e9,sbcIntensity:.005});
  }
  const analystEstimates={revenueGrowthCurrentYear:growth,revenueGrowthNextYear:growth*.9,numAnalysts:12,...(consensus||{})};
  return {ticker,sector:'Industrials',financials:{years,dataQuality:{}},analystEstimates,growthYear1:growth,price:{current:100},valuation:{growthSource:'test'}};
}
const ev=f=>f.forecastBridge.margins.marginEvidence;
const adjMatureOf=f=>{const e=ev(f);return e.adjustedMature+e.cut.mature;};

// 1) Trend only, consensus EPS growing in line with revenue (no margin expansion expected):
//    year-10 adjusted operating margin may not exceed today's / best 3-year level by more than the allowance.
const flat=buildForecast(trending({consensus:{epsGrowthCurrentYear:.15,epsGrowthNextYear:.135}}));
const e1=ev(flat);
assert(e1&&Number.isFinite(e1.ceiling),'margin evidence missing from bridge');
assert(adjMatureOf(flat)<=e1.ceiling+1e-9,'year-10 adjusted margin above the evidence ceiling');
assert(e1.ceiling<=Math.max(e1.adjustedNow,e1.best3YearAverage,e1.consensusTwoYear??-1)+.015+1e-9,'allowance above 1.5 pts');

// 2) Consensus expects a big margin step-up (EPS +45%/+35% on revenue +15%/+13.5%): the ceiling rises with it.
const backed=buildForecast(trending({ticker:'BACKED',consensus:{epsGrowthCurrentYear:.45,epsGrowthNextYear:.35}}));
const e2=ev(backed);
assert(e2.consensusTwoYear>e2.adjustedNow*1.2,'consensus factor not applied');
assert(e2.ceiling>e1.ceiling+.01,'consensus support did not raise the ceiling');

// 3) Consensus expects margins to fall hard (EPS -50% then +10% on growing revenue): an elevated current
//    margin gets no credit, so the ceiling sits at or below today's adjusted margin.
const contra=buildForecast(trending({ticker:'CONTRA',consensus:{epsGrowthCurrentYear:-.50,epsGrowthNextYear:.10}}));
const e3=ev(contra);
assert(e3.consensusContradicts===true,'contradiction not detected');
assert(e3.ceiling<=e3.adjustedNow+1e-9,'contradicted margin still credited above today');
assert(contra.forecastFlags.includes('margin_ceiling_consensus_contradicts')||!e3.applied,'flag missing');

// 4) Cuts flow through: net and FCF year-10 margins fall with operating margin when the ceiling binds.
if(e3.applied){
  const r10=contra.rows.at(-1), r10b=flat.rows.at(-1);
  assert(r10.netMargin<=r10b.netMargin+1e-9,'net margin did not follow the operating cut');
}
// 5) Build 60c: consensus-contradicted near-term dip. Year 1 follows consensus (EPS -50% on revenue up),
//    year 4+ returns to the normal path.
assert(Array.isArray(e3.nearTermDip)&&e3.nearTermDip[0]<.6,'near-term dip missing: '+JSON.stringify(e3.nearTermDip));
assert(contra.rows[0].netMargin<flat.rows[0].netMargin*.75,'year-1 margin ignored the consensus dip');
assert(Math.abs(contra.rows[4].netMargin/flat.rows[4].netMargin-1)<.35,'dip leaked past year 3');
console.log('Build 59 margin-evidence tests passed',JSON.stringify({flatCeil:+e1.ceiling.toFixed(3),backedCeil:+e2.ceiling.toFixed(3),contraCeil:+e3.ceiling.toFixed(3),now:+e1.adjustedNow.toFixed(3)}));
