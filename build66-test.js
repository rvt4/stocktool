'use strict';
// Build 66: forecast scorecard (projections vs. later reported results, against naive baselines).
const assert=require('assert');
const SC=require('./forecast-scorecard');
const {buildForecast}=require('./engine/forecast-engine');

const near=(a,b,tol=1e-9)=>Math.abs(a-b)<=tol;
function years(from,revs,net=.10,fcf=.12){return revs.map((r,i)=>({year:from+i,revenue:r,netIncome:r*(Array.isArray(net)?net[i]:net),fcf:r*(Array.isArray(fcf)?fcf[i]:fcf)}));}

// 1) Baseline inputs: trailing 3-yr CAGR and 3-yr median margins.
const hist=years(2016,[100,110,121,133.1],[.08,.10,.12,.11]);
const b=SC.baselineInputs(hist);
assert.strictEqual(b.baseYear,2019);
assert(near(b.g3,.10,1e-9),'g3 '+b.g3);
assert(near(b.medNet,.11),'median net '+b.medNet);
assert(near(b.lastNet,.11));
// fade: 10% fading to 4% by year 5 -> year-1 growth 10%-1.2pt = 8.8%
const base=SC.baselineRevenue(b,1);
assert(near(base.fade,133.1*1.088,1e-9)&&near(base.trend,133.1*1.10,1e-9)&&base.flat===133.1);

// 2) A perfect forecast scores zero error and beats every baseline.
const f={category:'Growth',forecastReliabilityScore:70,forecastFlags:['peak_margin_reversion'],
  rows:[1,2,3,4,5].map(k=>({year:2019+k,revenue:133.1*Math.pow(1.2,k),gaapNetMargin:.15,preSbcFcfMargin:.18}))};
const obs=SC.captureForecast({ticker:'PERF',sector:'Technology',financials:{years:hist}},f,'2019-12-31');
assert(obs&&obs.h.length===5&&obs.h[0][0]===2020);
const actual=[...hist,...years(2020,[1,2,3,4,5].map(k=>133.1*Math.pow(1.2,k)),.15,.18)];
const scored=SC.scoreForecasts([obs],actual);
assert.strictEqual(scored.length,5);
for(const r of scored){
  assert(near(r.rev.model,0,1e-12)&&near(r.net.model,0,1e-12)&&near(r.fcf.model,0,1e-12),'perfect forecast has error');
  assert(r.rev.fade>0,'company grew faster than the fade baseline, so fade error must be positive (too low)');
}

// 3) Sign convention: forecast 10% too high -> negative revenue error; margin forecast 3 pts too high -> -0.03.
const f2={...f,rows:f.rows.map(r=>({...r,revenue:r.revenue*1.10,gaapNetMargin:.18}))};
const s2=SC.scoreForecasts([SC.captureForecast({ticker:'HIGH',sector:'Technology',financials:{years:hist}},f2,'2019-12-31')],actual);
assert(near(s2[0].rev.model,Math.log(1/1.10),1e-12)&&near(s2[0].net.model,-.03,1e-12));

// 4) Misaligned year labels are rejected (model rows must start the year after the last reported year).
assert.strictEqual(SC.captureForecast({ticker:'X',financials:{years:hist}},{...f,rows:f.rows.map(r=>({...r,year:r.year+1}))},'2019-12-31'),null);

// 5) Years not yet reported are skipped; proxy revenue years are ignored.
const partial=SC.scoreForecasts([obs],[...hist,...years(2020,[160,192])]);
assert.deepStrictEqual(partial.map(r=>r.k),[1,2]);
const proxy=SC.scoreForecasts([obs],[...hist,{year:2020,revenue:160,netIncome:16,revenueIsProxy:true}]);
assert.strictEqual(proxy.length,0);

// 6) Summary: model that is always 10% too high vs fade baseline; skill sign and flag table.
const many=[];
for(let i=0;i<60;i++){
  const h=years(2016,[100,110,121,133.1].map(x=>x*(1+i/100)));
  const fo={...f,forecastFlags:i%2?['peak_margin_reversion']:[],rows:[1,2,3,4,5].map(k=>({year:2019+k,revenue:h[3].revenue*Math.pow(1.088,k)*1.25,gaapNetMargin:.10,preSbcFcfMargin:.12}))};
  const o=SC.captureForecast({ticker:'T'+i,sector:'Industrials',financials:{years:h}},fo,'2019-12-31');
  // actual = the fade path +2%
  let rev=h[3].revenue;const act=[...h];for(let k=1;k<=5;k++){rev*=1+.10+(.04-.10)*Math.min(1,k/5);act.push({year:2019+k,revenue:rev*1.02,netIncome:rev*.11,fcf:rev*.12});}
  many.push(...SC.scoreForecasts([o],act));
}
const card=SC.buildScorecard(many,{modelVersion:'test'});
const y1=card.byHorizon['year 1'];
assert(y1.revenue.bias<0,'over-forecast must show negative bias');
assert(y1.revenue.vs.fade.skill<0,'model worse than the fade baseline must have negative skill');
assert(near(y1.revenue.vs.fade.baselineMedianAbsError,Math.log(1.02),1e-4));
assert(y1.netMargin.vs.median3.skill!=null);
assert(card.byFlag.rows.some(r=>r.flag==='peak_margin_reversion'&&r.n===30));
assert(card.headline.length===5&&/WORSE than the naive fade/.test(card.headline[0]),card.headline[0]);
assert(card.growthCalibration.rows.length>0);

// 7) Works on a real engine forecast (shape check: captureForecast accepts buildForecast output).
const yrs=[];let R=1e9;for(let i=0;i<6;i++){yrs.push({year:2015+i,revenue:R,grossProfit:R*.5,operatingIncome:R*.15,opMargin:.15,netIncome:R*.11,ebitda:R*.2,fcf:R*.12,
  operatingCashFlow:R*.16,capex:R*.04,sbc:R*.01,sbcIntensity:.01,sharesOutTTM:1e8,dilutedEPS:R*.11/1e8,roic:.15,totalDebt:2e8,cash:1e8});R*=1.08;}
const stock={ticker:'ENG',sector:'Industrials',price:{current:20},financials:{years:yrs,dataQuality:{}},valuation:{},analystEstimates:null};
const ef=buildForecast(stock);
const eo=SC.captureForecast(stock,ef,'2020-12-31');
assert(eo&&eo.h.every(x=>x&&x[1]>0),'engine forecast not captured');
console.log('build66-test OK');
