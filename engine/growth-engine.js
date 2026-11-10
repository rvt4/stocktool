'use strict';
// Build 65: Growth Inflection track.
// A separate list from the value ranking. It looks for businesses whose growth is speeding up, whose
// margins are inflecting, and whose stock has started to move: the pattern PLTR (2023) and AMD (2016-17)
// showed during their runs. It uses ONLY data the backtest also has point-in-time (SEC annual + 10-Q
// revenue, daily prices), never analyst estimates, so the backtest measures exactly what the app shows.
// It cannot see a run before it starts; academic evidence (momentum, earnings acceleration) says these
// signals work during a move, on average, across many names, with occasional sharp crashes.
const {isFinancialLike}=require('./config');

const finite=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const DAY=86400000;

const GROWTH={
  minRevenue:300e6,        // last fiscal year
  minGrowth:0.15,          // current revenue growth to qualify as a growth company
  weights:{revGrowth:.15,revAccel:.20,opMarginChange:.15,ruleOf40:.15,fcfMarginChange:.10,sbcChange:.05,momentum:.20},
  // exit rule (backtest arm + live review): growth below this, score below this percentile, or momentum below 0
  exitGrowth:0.10, exitScore:50, exitMomentum:0,
};

// YoY growth for each quarter that has a quarter ~1 year earlier (10-Q single quarters; Q4 often missing).
function quarterlyYoY(quarters){
  const q=(quarters||[]).filter(x=>x&&x.end&&finite(x.val)>0).map(x=>({t:new Date(x.end).getTime(),val:Number(x.val),end:x.end})).sort((a,b)=>a.t-b.t);
  const out=[];
  for(const cur of q){
    let best=null,diff=Infinity;
    for(const p of q){const d=Math.abs((cur.t-p.t)/DAY-365);if(p.t<cur.t&&d<diff){diff=d;best=p;}}
    if(best&&diff<=25)out.push({end:cur.end,t:cur.t,g:cur.val/best.val-1});
  }
  return out;
}

function priceAt(history,t){
  let px=null;
  for(const r of history||[]){const rt=new Date(r.date).getTime();if(rt>t)break;const v=finite(r.adjustedClose)??finite(r.close);if(v>0)px=v;}
  return px;
}

// 12-1 momentum: return from 12 months ago to 1 month ago (skips the last month, the standard definition).
function momentum12_1(history,asOf){
  const h=(history||[]).filter(r=>r&&r.date);
  if(h.length<200)return null;
  const end=asOf?new Date(asOf).getTime():new Date(h.at(-1).date).getTime();
  const p1=priceAt(h,end-30*DAY), p12=priceAt(h,end-365*DAY);
  return p1>0&&p12>0?p1/p12-1:null;
}

function annualSeries(stock){
  return (stock?.financials?.years||[]).filter(y=>finite(y?.revenue)>0).map(y=>{
    const rev=Number(y.revenue), sbc=finite(y.sbc)??(finite(y.sbcIntensity)!=null?y.sbcIntensity*rev:null);
    return {year:y.year,rev,op:finite(y.operatingIncome)!=null?y.operatingIncome/rev:null,
      fcfAfterSbc:finite(y.fcf)!=null?(y.fcf-(sbc||0))/rev:null,sbc:sbc!=null?sbc/rev:null};
  });
}

// Raw signals for one company as of a date. priceHistory may be the live 5-year series or the backtest's.
function growthSignals(stock,priceHistory,asOf){
  const a=annualSeries(stock);
  const out={eligible:false,reasonsUp:[],reasonsDown:[]};
  if(a.length<3){out.why='needs 3+ years of history';return out;}
  const last=a.at(-1), prev=a.at(-2), two=a.at(-3);
  out.revenue=last.rev;
  const yoy=quarterlyYoY(stock?.quarterly);
  // current growth and acceleration: quarterly when available, annual otherwise
  if(yoy.length>=2){
    const cur=yoy.at(-1); const earlier=[...yoy].reverse().find(x=>cur.t-x.t>=150*DAY);
    out.revGrowth=cur.g; out.revAccel=earlier?cur.g-earlier.g:null; out.growthBasis='quarterly';
  }
  if(!Number.isFinite(out.revGrowth)){
    out.revGrowth=last.rev/prev.rev-1; out.revAccel=(last.rev/prev.rev-1)-(prev.rev/two.rev-1); out.growthBasis='annual';
  }
  if(!Number.isFinite(out.revAccel)&&a.length>=3)out.revAccel=(last.rev/prev.rev-1)-(prev.rev/two.rev-1);
  out.opMargin=last.op;
  out.opMarginChange=last.op!=null&&two.op!=null?last.op-two.op:null;
  out.turnedProfitable=last.op!=null&&last.op>0&&a.slice(-4,-1).some(x=>x.op!=null&&x.op<=0);
  out.fcfAfterSbcMargin=last.fcfAfterSbc;
  out.fcfMarginChange=last.fcfAfterSbc!=null&&two.fcfAfterSbc!=null?last.fcfAfterSbc-two.fcfAfterSbc:null;
  out.sbcIntensity=last.sbc;
  out.sbcChange=last.sbc!=null&&two.sbc!=null?two.sbc-last.sbc:null; // positive = stock pay falling
  out.ruleOf40=Number.isFinite(out.revGrowth)&&last.fcfAfterSbc!=null?out.revGrowth+last.fcfAfterSbc:null;
  out.momentum=momentum12_1(priceHistory,asOf);
  const financial=isFinancialLike(stock);
  out.eligible=!financial&&last.rev>=GROWTH.minRevenue&&out.revGrowth>=GROWTH.minGrowth&&Number.isFinite(out.momentum);
  if(!out.eligible)out.why=financial?'financial company':last.rev<GROWTH.minRevenue?'revenue under $300M':!(out.revGrowth>=GROWTH.minGrowth)?'growth under 15%':'no 12-month price history';
  const P=x=>(x*100).toFixed(0)+'%', S=x=>(x>=0?'+':'')+(x*100).toFixed(0)+' pts';
  if(out.revAccel>=.03)out.reasonsUp.push(`Growth speeding up: ${P(out.revGrowth)} now, ${S(out.revAccel)} vs two quarters earlier`);
  else if(out.revAccel<=-.05)out.reasonsDown.push(`Growth slowing: ${P(out.revGrowth)} now, ${S(out.revAccel)} vs two quarters earlier`);
  if(out.turnedProfitable)out.reasonsUp.push('Turned profitable on an operating basis');
  else if(out.opMarginChange>=.04)out.reasonsUp.push(`Operating margin up ${S(out.opMarginChange)} in two years`);
  else if(out.opMarginChange<=-.04)out.reasonsDown.push(`Operating margin down ${S(out.opMarginChange)} in two years`);
  if(out.fcfMarginChange>=.04)out.reasonsUp.push(`Cash flow after stock pay up ${S(out.fcfMarginChange)} of revenue in two years`);
  if(out.sbcChange>=.03)out.reasonsUp.push(`Stock pay falling: ${P(two.sbc)} -> ${P(last.sbc)} of revenue`);
  else if(out.sbcIntensity>=.15)out.reasonsDown.push(`Stock pay is ${P(out.sbcIntensity)} of revenue`);
  if(Number.isFinite(out.ruleOf40))(out.ruleOf40>=.40?out.reasonsUp:out.ruleOf40<.20?out.reasonsDown:[]).push(`Rule of 40 (growth + cash margin after stock pay): ${(out.ruleOf40*100).toFixed(0)}`);
  if(out.momentum>=.30)out.reasonsUp.push(`Stock up ${P(out.momentum)} over the past year (excluding the last month)`);
  else if(out.momentum<0)out.reasonsDown.push(`Stock down ${P(-out.momentum)} over the past year: no momentum yet`);
  return out;
}

// Percentile-score every eligible row. rows: objects carrying signals in rows[i][field].
// Writes growthScore (0-100), growthRank (1 = best), growthUniverse onto each eligible row.
function scoreGrowthUniverse(rows,{field='growth'}={}){
  const elig=(rows||[]).filter(r=>r&&r[field]&&r[field].eligible);
  const keys=Object.keys(GROWTH.weights);
  const pct={};
  for(const k of keys){
    const vals=elig.map(r=>r[field][k]).filter(Number.isFinite).sort((x,y)=>x-y);
    pct[k]=v=>{if(!Number.isFinite(v)||!vals.length)return .5;let lo=0,hi=vals.length;while(lo<hi){const m=(lo+hi)>>1;if(vals[m]<v)lo=m+1;else hi=m;}let eq=lo;while(eq<vals.length&&vals[eq]===v)eq++;return ((lo+eq)/2)/vals.length;};
  }
  for(const r of elig){
    let s=0;const parts={};
    for(const k of keys){const p=pct[k](r[field][k]);parts[k]=Math.round(p*100);s+=GROWTH.weights[k]*p;}
    r[field].score=Math.round(s*1000)/10; r[field].percentiles=parts;
  }
  elig.sort((a,b)=>b[field].score-a[field].score);
  elig.forEach((r,i)=>{r[field].rank=i+1;r[field].universe=elig.length;r[field].scorePercentile=Math.round((1-i/Math.max(1,elig.length))*100);});
  for(const r of rows||[])if(r&&r[field]&&!r[field].eligible){r[field].score=null;r[field].rank=null;}
  return elig.length;
}

// Should a growth holding be sold at a review? (no auto-buy; used by the backtest arm and the live card)
function growthExit(sig){
  if(!sig)return {exit:true,reason:'no growth data'};
  if(!(sig.revGrowth>=GROWTH.exitGrowth))return {exit:true,reason:`growth fell below ${GROWTH.exitGrowth*100}%`};
  if(Number.isFinite(sig.momentum)&&sig.momentum<GROWTH.exitMomentum)return {exit:true,reason:'stock lost its 12-month momentum'};
  if(Number.isFinite(sig.scorePercentile)&&sig.scorePercentile<GROWTH.exitScore)return {exit:true,reason:'fell to the bottom half of growth names'};
  return {exit:false,reason:null};
}

module.exports={GROWTH,growthSignals,scoreGrowthUniverse,growthExit,momentum12_1,quarterlyYoY};
