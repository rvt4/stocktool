'use strict';
// Build 62: thesis-broken sell rule. Sell a holding whose business is shrinking (trailing-12-month
// revenue down year over year at 3 reviews in a row) AND whose forward EPS is <= 80% of its level when
// bought. Temporary dips (META 2022) and cyclical downturns with earnings still far above cost (KLAC
// 2023-24) must NOT trigger it.
const assert=require('assert');
const RP=require('./review-policy');

// TTM revenue growth from quarterly points, with annual fallback
const qs=(vals)=>vals.map((v,i)=>({end:new Date(Date.UTC(2023,2+3*i,28)).toISOString().slice(0,10),val:v}));
assert(Math.abs(RP.ttmRevenueGrowth(qs([100,100,100,100,110,110,110,110]))-0.10)<1e-9,'TTM growth wrong');
assert(RP.ttmRevenueGrowth(qs([100,100,100,100,90,90,90,90]))<0,'TTM decline not detected');
assert(Math.abs(RP.ttmRevenueGrowth([], [{revenue:200},{revenue:180}])+0.10)<1e-9,'annual fallback wrong');

// Walk a holding through several reviews, carrying the memo the way the app/backtest do.
function walk(reviews,opts={}){
  let prev={u:.15,q:85,streak:0,entryEPS:reviews[0].forwardEPS};
  let st=null;
  for(const r of reviews){
    st=RP.holdingStatus({ticker:'X',underwrittenCAGR:.15,qualityScore:85,rating:'Watch',overallRank:40,...r},prev,{weight:.06,...opts});
    prev={u:.15,q:85,streak:st.memo.streak,entryEPS:st.memo.entryEPS};
  }
  return st;
}
// 1) Value trap (PLTK-like): revenue shrinking 3 reviews running, forward EPS 40% below cost -> Sell
const trap=walk([{revenueGrowthTTM:.01,forwardEPS:1.0},{revenueGrowthTTM:-.02,forwardEPS:.85},{revenueGrowthTTM:-.03,forwardEPS:.7},{revenueGrowthTTM:-.04,forwardEPS:.6}],{thesisBreak:'sell'});
const trapDefault=walk([{revenueGrowthTTM:.01,forwardEPS:1.0},{revenueGrowthTTM:-.02,forwardEPS:.85},{revenueGrowthTTM:-.03,forwardEPS:.7},{revenueGrowthTTM:-.04,forwardEPS:.6}]);
assert.strictEqual(trapDefault.status,'Review','Build 62b default should flag for review, not sell');
assert(trapDefault.reasons.some(x=>/^Business shrinking/.test(x)),'review reason missing');
assert.strictEqual(trap.status,'Sell candidate','value trap not sold');
assert(trap.reasons.some(x=>/^Business shrinking/.test(x)),'reason missing');

// 2) Temporary dip (META 2022): EPS -38% but revenue down only 2 reviews, then recovers -> no Sell
const dip=walk([{revenueGrowthTTM:.07,forwardEPS:13},{revenueGrowthTTM:-.01,forwardEPS:9},{revenueGrowthTTM:-.008,forwardEPS:8},{revenueGrowthTTM:.02,forwardEPS:10}]);
assert.notStrictEqual(dip.status,'Sell candidate','temporary dip sold');

// 3) Cyclical downturn with earnings far above cost (KLAC 2023-24): revenue down 4 reviews -> no Sell
const cyc=walk([{revenueGrowthTTM:.20,forwardEPS:9},{revenueGrowthTTM:-.03,forwardEPS:24},{revenueGrowthTTM:-.08,forwardEPS:22},{revenueGrowthTTM:-.12,forwardEPS:21},{revenueGrowthTTM:-.10,forwardEPS:22}]);
assert.notStrictEqual(cyc.status,'Sell candidate','compounder sold in a cyclical downturn');

// 4) Rule can be switched off (backtest comparison arm C0)
const off=walk([{revenueGrowthTTM:.01,forwardEPS:1.0},{revenueGrowthTTM:-.02,forwardEPS:.85},{revenueGrowthTTM:-.03,forwardEPS:.7},{revenueGrowthTTM:-.04,forwardEPS:.6}],{thesisBreak:false});
assert.notStrictEqual(off.status,'Sell candidate','rule fired while switched off');

// 5) Snapshot carries the memo forward between real reviews
const snap=RP.buildSnapshot({stocks:[{ticker:'X',price:10,underwrittenCAGR:.15,qualityScore:85,revenueGrowthTTM:-.02,forwardEPS:.9}],holdings:[{ticker:'X',shares:10}],prev:{holdings:[{ticker:'X',streak:2,entryEPS:1.2}]}});
assert.strictEqual(snap.holdings[0].streak,3,'streak not carried');
assert.strictEqual(snap.holdings[0].entryEPS,1.2,'entry EPS not carried');
assert.strictEqual(snap.holdings[0].status,'Review','snapshot status ignores thesis rule');

console.log('Build 62 thesis-broken sell rule tests passed');

// 6) Strategy lab end to end: a ranked-high value trap (revenue shrinking, EPS falling, price falling)
//    is sold by arm C and kept by arm C0, and C ends ahead.
{
  const L=require('./owner-strategy-lab');
  const days=[];for(let i=0;i<=12;i++){const d=new Date(Date.UTC(2019,8,30));d.setUTCMonth(d.getUTCMonth()+3*i);days.push(d.toISOString().slice(0,10));}
  const tick=Array.from({length:30},(_,i)=>'T'+i);
  const qret=(t,i)=>t==='T0'?(i<2?0.02:-0.12):0.03;
  const hist=new Map(tick.map(t=>[t,days.map((d,i)=>({date:d,close:days.slice(0,i).reduce((v,_,j)=>v*(1+qret(t,j)),100)}))]));
  const spy=days.map((d,i)=>({date:d,close:100*Math.pow(1.025,i)}));
  const arb=(h,a,b)=>{const x=h.find(r=>r.date===a),y=h.find(r=>r.date===b);return x&&y?{return:y.close/x.close-1}:null;};
  const stats=ps=>{let w=1,s=1;for(const p of ps){w*=1+p.portfolioReturn;s*=1+p.spyReturn;}const y=ps.length/4||1;return {periods:ps,portfolioCAGR:Math.pow(w,1/y)-1,spyCAGR:Math.pow(s,1/y)-1,annualizedExcess:Math.pow(w,1/y)-Math.pow(s,1/y),periodCount:ps.length,yearCount:y};};
  const snaps=days.slice(0,-1).map((d,qi)=>({asOf:d,rows:tick.map((t,i)=>({ticker:t,sector:'S'+(i%8),liveRank:i+1,rank:i+1,overallRank:i+1,expectedCAGR:.2-i*.003,underwrittenCAGR:.18-i*.003,qualityScore:90-i,confidenceScore:80,rating:'Watch',modelSupport:'standard',
    revenueGrowthTTM:t==='T0'?(qi<1?.02:-.05):.06, forwardEPS:t==='T0'?Math.max(.2,1-.12*qi):1+.03*qi}))}));
  const lab=L.buildOwnerStrategyLab(snaps,hist,spy,{adjustedReturnBetween:arb,portfolioStats:stats},{});
  const Cp=lab.arms.find(a=>a.name.startsWith('C+')), C=lab.arms.find(a=>a.name.startsWith('C ·'));
  assert(Cp.thesisBreakSells.some(x=>x.ticker==='T0'),'experimental arm C+ did not sell the value trap');
  assert(!C.thesisBreakSells.length,'default arm C auto-sold on the thesis rule');
  console.log('Build 62b strategy-lab test passed',JSON.stringify({soldAt:Cp.thesisBreakSells[0].asOf,Cplus:+Cp.portfolioCAGR.toFixed(3),C:+C.portfolioCAGR.toFixed(3)}));
}
