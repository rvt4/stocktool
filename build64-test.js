'use strict';
// Build 64: (1) live rank uses the stressed return, (2) boom-cycle margins are stressed, (4) stocks held for a
// recent deal/spin-off stay out of the top 25.
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate,boomCycleCheck}=require('./engine/valuation-engine');
const {applyModelDRanking}=require('./engine/ranking-engine');
// Approximate public operating-margin and growth paths (oldest -> newest) for shape, not exact figures.
function co({t,op,g,cons,price=100,shares=1e8,sector='Industrials'}){
  const years=[];let rev=10e9;
  op.forEach((m,i)=>{if(i)rev*=1+g[i-1];
    years.push({year:2019+i,revenue:rev,grossProfit:rev*(m+.12),operatingIncome:rev*m,opMargin:m,netIncome:rev*m*.76,ebitda:rev*(m+.02),
      fcf:rev*m*.8,operatingCashFlow:rev*(m*.8+.015),capex:rev*.015,sbc:rev*.005,sbcIntensity:.005,sharesOutTTM:shares,dilutedEPS:rev*m*.76/shares,roic:.25,totalDebt:1e9,cash:1e9});});
  return {ticker:t,sector,price:{current:price},financials:{years,dataQuality:{}},valuation:{},
    analystEstimates:{numAnalysts:12,revenueGrowthCurrentYear:cons,revenueGrowthNextYear:cons*.7,epsGrowthCurrentYear:cons*1.1,epsGrowthNextYear:cons*.8}};
}
const cases={
  EME: co({t:'EME', op:[.056,.046,.054,.050,.069,.092,.100],g:[.04,.07,.13,.12,.16,.15],cons:.225}),
  FIX: co({t:'FIX', op:[.072,.076,.070,.075,.098,.124,.145],g:[.03,.02,.35,.27,.35,.20],cons:.45}),
  VRT: co({t:'VRT', op:[.050,.055,.065,.046,.125,.155,.170],g:[.02,.15,.15,.21,.17,.28],cons:.40}),
  META:co({t:'META',op:[.34,.38,.40,.25,.35,.42,.41],g:[.22,.37,.08,.16,.22,.20],cons:.24,sector:'Communication Services'}),
  MSFT:co({t:'MSFT',op:[.37,.42,.42,.42,.45,.45,.46],g:[.14,.18,.07,.16,.15,.17],cons:.17,sector:'Technology'}),
  GNTX:co({t:'GNTX',op:[.25,.24,.21,.19,.20,.18,.19],g:[-.07,.08,.11,.21,-.01,.03],cons:.04}),
};
const out={};
for(const [k,s] of Object.entries(cases)){
  const f=buildForecast(s),q=computeQuality(s,f),v=valuate(s,f,q);
  out[k]={boom:!!v.underwriting.cycle?.boom,uw:v.underwrittenCAGR,flags:v.underwriting.flags};
}
// A boom-shaped history is either stressed, or the base forecast already fades the margin (no double cut).
for(const k of ['EME','FIX','VRT']){const c=boomCycleCheck(cases[k],buildForecast(cases[k]));
  assert(out[k].boom||c.projectedMargin<=c.recentMargin*.85,k+' boom neither stressed nor faded: '+JSON.stringify(c));}
assert(out.EME.boom||out.VRT.boom,'no boom detected at all');
for(const k of ['META','MSFT','GNTX'])assert(!out[k].boom,k+' steady compounder flagged as a boom');
// the stress is bounded: half the boom-era gain, never more than 4 pts/yr
{const s=cases.EME,f=buildForecast(s),c=boomCycleCheck(s,f);assert(c.stressFactor>=.5&&c.bearFactor<c.stressFactor,'factor ordering');}

// (1) stressed-return ranking and (4) corporate-action hold
const rows=Array.from({length:40},(_,i)=>({ticker:'T'+i,expectedAlpha:.05,underwrittenCAGR:.15-i*.002,qualityScore:80,moatScore:80,growthQualityScore:80,compounderScore:80,analystEstimates:{numAnalysts:10}}));
rows[39].expectedAlpha=.30;           // best normal case, worst stressed case
rows[0].corporateAction={reason:'spin-off'};
applyModelDRanking(rows,{rankField:'r',universeSizeField:null,reliability:true});
assert(rows[39].r>30,'normal-case outlier still ranked high: '+rows[39].r);
assert(rows[0].r>25,'stock held for a corporate action ranked in the top 25: '+rows[0].r);
assert.strictEqual(rows[1].r,1,'best stressed return should rank first');
console.log('Build 64 tests passed',JSON.stringify(Object.fromEntries(Object.entries(out).map(([k,v])=>[k,{boom:v.boom,uw:+v.uw?.toFixed(3)}]))));
