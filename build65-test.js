'use strict';
// Build 65: Growth Inflection track.
const assert=require('assert');
const GE=require('./engine/growth-engine');

// price history: daily closes rising from p0 to p1 over 400 days ending on `end`
function prices(p0,p1,end='2026-11-01',days=420){
  const out=[],e=new Date(end).getTime();
  for(let i=days;i>=0;i--){const t=e-i*86400000;out.push({date:new Date(t).toISOString().slice(0,10),close:p0*Math.pow(p1/p0,(days-i)/days)});}
  return out;
}
// quarterly revenue with a given YoY growth path (8 quarters of YoY points need 12 quarters of data)
function quarters(base,yoyPath,endYear=2026){
  const q=[];const n=yoyPath.length+4;let vals=[];
  for(let i=0;i<4;i++)vals.push(base*(1+.02*i));
  for(let i=0;i<yoyPath.length;i++)vals.push(vals[i]*(1+yoyPath[i]));
  for(let i=0;i<n;i++){const d=new Date(Date.UTC(endYear,8,30));d.setUTCMonth(d.getUTCMonth()-3*(n-1-i));q.push({end:d.toISOString().slice(0,10),val:vals[i]});}
  return q;
}
function co({t,rev=[4e8,5e8,6.2e8,8e8],op=[-.10,-.04,.03,.09],fcf=[.05,.08,.12,.17],sbc=[.25,.22,.18,.14],yoy=[.2,.2,.21,.22,.24,.26,.28,.30],sector='Technology'}){
  return {ticker:t,sector,financials:{years:rev.map((r,i)=>({year:2022+i,revenue:r,operatingIncome:r*op[i],fcf:r*fcf[i],sbc:r*sbc[i],sbcIntensity:sbc[i]})),dataQuality:{}},
    quarterly:quarters(rev[0]/4,yoy)};
}

// 1) PLTR-2023-like inflection: accelerating growth, turned profitable, stock pay falling, momentum
const inflect=GE.growthSignals(co({t:'INFL'}),prices(10,25),null);
assert(inflect.eligible,'inflection company not eligible: '+inflect.why);
assert(inflect.revAccel>.03&&inflect.turnedProfitable&&inflect.sbcChange>.05&&inflect.momentum>1,'signals wrong: '+JSON.stringify(inflect));
assert(inflect.reasonsUp.some(x=>/speeding up/.test(x))&&inflect.reasonsUp.some(x=>/Turned profitable/.test(x)),'reasons missing');

// 2) Decelerating grower with a falling stock
const decel=GE.growthSignals(co({t:'DECL',op:[.15,.14,.12,.10],fcf:[.15,.13,.11,.08],sbc:[.10,.11,.12,.13],yoy:[.40,.38,.35,.32,.28,.24,.20,.17]}),prices(30,18),null);
assert(decel.eligible&&decel.revAccel<-.05&&decel.momentum<0,'decelerating case wrong');
// 3) Not a growth company / financial / too small
assert(!GE.growthSignals(co({t:'SLOW',yoy:[.03,.03,.03,.03,.03,.03,.03,.03],rev:[4e8,4.1e8,4.2e8,4.3e8]}),prices(10,11),null).eligible,'slow grower eligible');
assert(!GE.growthSignals(co({t:'TINY',rev:[5e7,7e7,9e7,1.2e8]}),prices(10,25),null).eligible,'tiny company eligible');
assert(!GE.growthSignals({...co({t:'BANK'}),sic:'6022'},prices(10,25),null).eligible,'bank eligible');

// 4) Scoring: the inflection company outranks the decelerating one; exit rule fires on the decliner
const rows=[{ticker:'INFL',growth:inflect},{ticker:'DECL',growth:decel}];
for(let i=0;i<20;i++)rows.push({ticker:'M'+i,growth:GE.growthSignals(co({t:'M'+i,yoy:Array(8).fill(.18+i*.004)}),prices(10,12+i*.3),null)});
assert(GE.scoreGrowthUniverse(rows)===22,'not all scored');
const r=Object.fromEntries(rows.map(x=>[x.ticker,x.growth]));
assert(r.INFL.rank===1,'inflection not ranked first: '+r.INFL.rank);
assert(r.DECL.rank===22,'decliner not last: '+r.DECL.rank);
assert(!GE.growthExit(r.INFL).exit&&GE.growthExit(r.DECL).exit,'exit rule wrong');

// 5) Point-in-time momentum ignores prices after asOf
const h=prices(10,40,'2026-11-01',900);
const m=GE.momentum12_1(h,'2026-06-01');
assert(m>0&&m<GE.momentum12_1(h,null),'momentum used future prices');

// 6) Strategy lab: the growth sleeve buys the inflection names, sells the decliner, and H blends 70/30
{
  const L=require('./owner-strategy-lab');
  const days=[];for(let i=0;i<=8;i++){const d=new Date(Date.UTC(2021,2,31));d.setUTCMonth(d.getUTCMonth()+3*i);days.push(d.toISOString().slice(0,10));}
  const tick=Array.from({length:25},(_,i)=>'G'+i);
  const hist=new Map(tick.map((t,i)=>[t,days.map((d,j)=>({date:d,close:100*Math.pow(i<5?1.08:1.01,j)}))]));
  const spy=days.map((d,j)=>({date:d,close:100*Math.pow(1.025,j)}));
  const arb=(hh,a,b)=>{const x=hh.find(r=>r.date===a),y=hh.find(r=>r.date===b);return x&&y?{return:y.close/x.close-1}:null;};
  const stats=ps=>{let w=1,s=1;for(const p of ps){w*=1+p.portfolioReturn;s*=1+p.spyReturn;}const y=ps.length/4||1;return {periods:ps,portfolioCAGR:Math.pow(w,1/y)-1,spyCAGR:Math.pow(s,1/y)-1,annualizedExcess:Math.pow(w,1/y)-Math.pow(s,1/y),periodCount:ps.length,yearCount:y};};
  const g=(i)=>({eligible:true,revGrowth:i<5?.40:.16,revAccel:i<5?.06:-.02,opMarginChange:i<5?.08:0,ruleOf40:i<5?.55:.20,fcfMarginChange:i<5?.05:0,sbcChange:0,momentum:i<5?.8:.05});
  const snaps=days.slice(0,-1).map(d=>({asOf:d,rows:tick.slice(10).map((t,k)=>({ticker:t,liveRank:k+1,rank:k+1,expectedCAGR:.15,underwrittenCAGR:.14,qualityScore:85,confidenceScore:80,rating:'Watch',growth:g(Number(t.slice(1)))})),
    growthOnlyRows:tick.slice(0,10).map(t=>({ticker:t,growthOnly:true,growth:g(Number(t.slice(1)))}))}));
  const lab=L.buildOwnerStrategyLab(snaps,hist,spy,{adjustedReturnBetween:arb,portfolioStats:stats},{});
  const G=lab.arms.find(a=>a.name.startsWith('G ·')),H=lab.arms.find(a=>a.name.startsWith('H ·')),C=lab.arms.find(a=>a.name.startsWith('C ·'));
  assert(G&&H,'growth arms missing');
  assert(G.holdingsByQuarter[0].holdings.some(h=>h[0]==='G0'),'growth sleeve skipped the growth-only inflection names');
  assert(G.portfolioCAGR>C.portfolioCAGR,'growth sleeve should win in this fixture');
  assert(H.portfolioCAGR<G.portfolioCAGR&&H.portfolioCAGR>C.portfolioCAGR-1e-9,'blend not between its parts');
  assert(lab.growthBuckets['1Y'].length===4,'growth buckets missing');
  console.log('Build 65 strategy-lab growth arms passed',JSON.stringify({G:+G.portfolioCAGR.toFixed(3),H:+H.portfolioCAGR.toFixed(3),C:+C.portfolioCAGR.toFixed(3)}));
}
console.log('Build 65 Growth Inflection tests passed',JSON.stringify({inflectScore:r.INFL.score,declScore:r.DECL.score}));
