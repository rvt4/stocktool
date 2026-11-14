'use strict';
// Build 81: FCF-margin variant test in the forecast scorecard.
const assert=require('assert');
const {baselineInputs,scoreForecasts,fcfVariantTest,buildScorecard}=require('./forecast-scorecard');
const years=[2019,2020,2021].map((y,i)=>({year:y,revenue:100+i*10,netIncome:10+i,fcf:12+i}));
const b=baselineInputs(years);
assert(Math.abs(b.conv-1.1818)<.01,'median FCF / net income');
// One company, model FCF margin 5% every year, actual 11% (company converts like it always has).
const mk=(t,asOf,fcfF)=>({ticker:t,asOf,sector:'X',category:'Value',reliability:60,flags:[],...b,
  h:[1,2,3,4,5].map(k=>[2021+k,120*1.05**k,.10,fcfF]),alt:null});
const actual=[...years,...[1,2,3,4,5].map(k=>({year:2021+k,revenue:120*1.05**k,netIncome:120*1.05**k*.10,fcf:120*1.05**k*.115}))];
const obs=[];for(let i=0;i<30;i++){obs.push({...mk('A'+i,'2020-03-31',.05)});obs.push({...mk('B'+i,'2023-03-31',.05)});}
const scored=scoreForecasts(obs,actual);
const t=fcfVariantTest(scored);
const y5=t.byHorizon['year 5'];
assert(y5&&y5.conv.medianAbsError<y5.model.medianAbsError,'conversion variant closer here');
assert(t.passing.includes('conv')&&t.winner,'passes the pre-set rule when it wins everywhere');
// Same test, but the model is right: no variant may pass.
const good=scoreForecasts(obs.map(o=>({...o,h:o.h.map(r=>[r[0],r[1],r[2],.115])})),actual);
assert.deepStrictEqual(fcfVariantTest(good).passing,[]);
assert(buildScorecard(scored).fcfVariantTest.byHorizon['year 3']);
console.log('build81 tests passed');
