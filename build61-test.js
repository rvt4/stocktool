'use strict';
// Build 61: backtest return attribution and holdings export.
const assert=require('assert');
const L=require('./owner-strategy-lab');
const days=[];for(let i=0;i<=12;i++){const d=new Date(Date.UTC(2019,8,30));d.setUTCMonth(d.getUTCMonth()+3*i);days.push(d.toISOString().slice(0,10));}
const tick=Array.from({length:40},(_,i)=>'T'+i);
const qret=(t,i)=>t==='T0'?0.25:t==='T1'?0.15:0.02;
const hist=new Map(tick.map(t=>[t,days.map((d,i)=>({date:d,close:days.slice(0,i).reduce((v,_,j)=>v*(1+qret(t,j)),100)}))]));
const spy=days.map((d,i)=>({date:d,close:100*Math.pow(1.03,i)}));
const arb=(h,a,b)=>{const x=h.find(r=>r.date===a),y=h.find(r=>r.date===b);return x&&y?{return:y.close/x.close-1}:null;};
const stats=(ps)=>{let w=1,s=1;for(const p of ps){w*=1+p.portfolioReturn;s*=1+p.spyReturn;}const y=ps.length/4||1;const c=Math.pow(w,1/y)-1,sc=Math.pow(s,1/y)-1;return {periods:ps,portfolioCAGR:c,spyCAGR:sc,annualizedExcess:c-sc,periodCount:ps.length,yearCount:y};};
const snaps=days.slice(0,-1).map(d=>({asOf:d,rows:tick.map((t,i)=>({ticker:t,sector:'S'+(i%8),liveRank:i+1,rank:i+1,expectedCAGR:.2-i*.003,underwrittenCAGR:.18-i*.003,qualityScore:90-i,confidenceScore:80,rating:i<3?'Buy':'Watch',modelSupport:'standard'}))}));
const lab=L.buildOwnerStrategyLab(snaps,hist,spy,{adjustedReturnBetween:arb,portfolioStats:stats},{});
const C=lab.arms.find(a=>a.name.startsWith('C'));
assert(C&&C.attribution&&C.holdingsByQuarter.length===11,'attribution/holdings missing');
assert.strictEqual(C.attribution.topContributors[0].ticker,'T0','biggest winner not identified');
assert.strictEqual(C.attribution.topContributors[1].ticker,'T1','second winner not identified');
assert(C.attribution.withoutTop[1].portfolioCAGR<C.portfolioCAGR-.05,'removing the top winner did not lower CAGR');
assert(C.attribution.withoutTop[3].portfolioCAGR<=C.attribution.withoutTop[1].portfolioCAGR+1e-9,'withoutTop not monotonic');
assert(lab.holdingsCsv.split('\n')[0].startsWith('arm,quarterStart,ticker'),'CSV header missing');
console.log('Build 61 backtest attribution tests passed');
