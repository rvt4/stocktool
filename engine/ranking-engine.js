'use strict';

// v12.38 live ranking architecture.
// The backtest challenger was frozen before promotion and showed that, once Expected
// Alpha >= 0% on the 15% hurdle scale (>=15% expected CAGR candidate universe), a simple 50/50 blend of Expected Alpha percentile and an equal-weight
// Quality/Moat/Growth-Quality/Compounder percentile basket generalized better than the
// v12.37 hierarchical score. This module implements that exact cross-sectional rule.

const ALPHA_GATE = 0.00;

function finite(v){
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}

// Higher values are better. Ties receive the same average percentile, matching the
// frozen challenger lab so live ranking and historical evaluation use one definition.
function percentileRanks(values){
  const valid=values
    .map((v,i)=>({v:finite(v),i}))
    .filter(x=>x.v!=null)
    .sort((a,b)=>b.v-a.v);
  const out=Array(values.length).fill(null), n=valid.length;
  let j=0;
  while(j<n){
    let k=j+1;
    while(k<n && valid[k].v===valid[j].v) k++;
    const avgRank=(j+(k-1))/2;
    const score=n<=1?1:1-(avgRank/(n-1));
    for(let z=j;z<k;z++) out[valid[z].i]=score;
    j=k;
  }
  return out;
}

function qualityValue(row,key){
  if(key==='growthQualityScore') return finite(row.growthQualityScore??row.growthQuality);
  return finite(row[key]);
}

// Live-only evidence haircut (opt-in; the backtest keeps the frozen rule).
// Ranking should reward return that is both high AND well supported. Extreme alpha is
// compressed (a 26% CAGR is not 2x as believable as 16%), and thin analyst coverage,
// small size, or a model far above analysts shrink the alpha used for ordering.
// Build 64: the live rank orders on the STRESSED (underwritten) return, the same number the Buy rule uses.
// Ranking on the normal case put VRT at #1 with an 8.7% stressed return and rewarded forecasts that need
// everything to go right. Falls back to the normal case when no stressed figure exists.
const RANK_HURDLE=0.11;
// Build 64b: a stock whose bear case loses money cannot rank on its stressed case alone (results_37 top 25 had
// ALK -3.4%, PRIM 0.2%, FOUR 2.4%, EXPE 0.6% bear cases). 30% of the rank return comes from the bear case.
function stressedAlpha(r){
  const u=finite(r.underwrittenCAGR), b=finite(r.bearCAGR);
  if(u==null)return finite(r.expectedAlpha);
  const blended=b!=null?Math.min(u,.7*u+.3*b):u;
  return blended-RANK_HURDLE;
}
function reliabilityAdjustedAlpha(r){
  const a=stressedAlpha(r); if(a==null) return null;
  const KNEE=0.06;
  let adj=a>KNEE?KNEE+0.30*(a-KNEE):a;
  const n=finite(r.analystEstimates?.numAnalysts);
  let f=1;
  if(n==null||n<1) f*=0.45; else if(n<3) f*=0.55; else if(n<5) f*=0.8; else if(n<8) f*=0.92;
  const cap=finite(r.marketCap);
  if(cap!=null&&cap<2.5e9) f*=0.85; else if(cap!=null&&cap<5e9) f*=0.93;
  if(r.analystCheck?.divergence==='model_far_above_analysts') f*=0.7;
  return adj>0?adj*f:adj;
}

// Build 68: value-trap check (live rule; the frozen legacy backtest rank is unchanged).
// Cheap-but-shrinking businesses (CMCSA, CHTR, CPB, LKQ, BBWI...) filled the top ranks, and ranks 1-20 trailed
// ranks 21-50 in the backtest. Business growth = average of trailing-12-month revenue growth and the 3-year
// revenue CAGR (either alone if only one exists). Rank-score points (0-100 scale) are subtracted below each
// threshold. A recovering company (3-year shrink, TTM +10%) lands around +2% and takes only the mild cut.
const VALUE_TRAP=[{below:0,points:15,label:'shrinking revenue'},{below:.03,points:8,label:'revenue growth under 3%'},{below:.05,points:3,label:'revenue growth under 5%'}];
function revenueCagr3(years){
  const ys=(years||[]).filter(y=>finite(y?.revenue)>0&&!y.revenueIsProxy);
  if(ys.length<3)return null;
  const lb=Math.min(3,ys.length-1),g=Math.pow(ys.at(-1).revenue/ys[ys.length-1-lb].revenue,1/lb)-1;
  return Number.isFinite(g)?g:null;
}
function businessGrowth(r){
  const t=finite(r.revenueGrowthTTM),c=finite(r.revenueCAGR3);
  const ok=x=>x!=null&&x>-.6&&x<3;
  const v=[t,c].filter(ok);
  return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
}
function valueTrapPenalty(r){
  const g=businessGrowth(r);
  if(g==null)return {growth:null,points:0,label:null};
  const hit=VALUE_TRAP.find(x=>g<x.below);
  return {growth:g,points:hit?hit.points:0,label:hit?hit.label:null};
}

// Build 69: cyclical-at-peak check. A cyclical business (revenue fell >15% in a year, or profits collapsed to under
// half their typical margin, in the last 8 years) whose current net margin is well above its own median looks
// cheap on peak earnings (PPC, ALK, OMF...). Not live until the owner backtest's arm C2 beats arm C:
// set CYCLE_PENALTY.live = true then. The app shows the label either way.
const CYCLE_PENALTY={live:false,peakPoints:12,cyclicalPoints:4,maxRevenueDrop:-.15,peakMarginGap:.03,peakMarginRelative:.25};
function cycleProfile(years){
  const ys=(years||[]).filter(y=>finite(y?.revenue)>0&&!y.revenueIsProxy).slice(-8);
  if(ys.length<4)return null;
  // Fiscal 2020 (the pandemic shock) is skipped: it is not a business cycle and would tag BKNG, restaurants, hotels.
  const covid=y=>Number(y.year)===2020;
  const drops=ys.map((y,i)=>i&&!covid(y)?y.revenue/ys[i-1].revenue-1:null).filter(Number.isFinite);
  if(!drops.length)return null;
  const m=ys.filter(y=>!covid(y)).map(y=>finite(y.netIncome)!=null?y.netIncome/y.revenue:null).filter(x=>x!=null&&x>-1&&x<1);
  if(m.length<4)return null;
  const sorted=[...m].sort((a,b)=>a-b),med=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
  const now=m.at(-1),worstDrop=Math.min(...drops),low=Math.min(...m.slice(0,-1));
  const profitCollapse=med>0&&low<.5*med;
  const cyclical=worstDrop<CYCLE_PENALTY.maxRevenueDrop||profitCollapse;
  const atPeak=cyclical&&med>0&&now>med+Math.max(CYCLE_PENALTY.peakMarginGap,CYCLE_PENALTY.peakMarginRelative*med);
  const r4=x=>Math.round(x*1e4)/1e4;
  return {cyclical,atPeak,worstRevenueDrop:r4(worstDrop),marginNow:r4(now),marginMedian:r4(med),marginLow:r4(low)};
}
function cyclePenalty(r){
  const c=r.cycle;if(!c||!c.cyclical)return {points:0,label:null};
  return c.atPeak?{points:CYCLE_PENALTY.peakPoints,label:'cyclical, profits near a peak'}:{points:CYCLE_PENALTY.cyclicalPoints,label:'cyclical business'};
}

function buildModelDScores(rows,{alphaGate=ALPHA_GATE,reliability=false,cycle=CYCLE_PENALTY.live}={}){
  const eligible=(rows||[]).filter(r=>(finite(r.expectedAlpha)??-Infinity)>=alphaGate);
  if(!eligible.length) return eligible;

  const alpha=percentileRanks(eligible.map(r=>reliability?reliabilityAdjustedAlpha(r):r.expectedAlpha));
  const quality=percentileRanks(eligible.map(r=>qualityValue(r,'qualityScore')));
  const moat=percentileRanks(eligible.map(r=>qualityValue(r,'moatScore')));
  const growth=percentileRanks(eligible.map(r=>qualityValue(r,'growthQualityScore')));
  const compounder=percentileRanks(eligible.map(r=>qualityValue(r,'compounderScore')));

  eligible.forEach((r,i)=>{
    const pieces=[quality[i],moat[i],growth[i],compounder[i]].filter(Number.isFinite);
    const basket=pieces.length?pieces.reduce((a,b)=>a+b,0)/pieces.length:null;
    let score=Number.isFinite(alpha[i])&&Number.isFinite(basket)
      ?0.5*alpha[i]+0.5*basket
      :null;
    if(reliability){
      const p=valueTrapPenalty(r);
      r.rankBusinessGrowth=p.growth;r.rankGrowthPenalty=p.points||0;r.rankGrowthPenaltyReason=p.label;
      if(Number.isFinite(score)&&p.points)score-=p.points/100;
      const c=cyclePenalty(r);r.rankCycleLabel=c.label;r.rankCyclePenalty=cycle?c.points:0;
      if(cycle&&Number.isFinite(score)&&c.points)score-=c.points/100;
    }
    r.rankEligible=true;
    r.rankAlphaPercentile=alpha[i];
    r.rankQualityBasketPercentile=basket;
    r.rankScore=Number.isFinite(score)?Math.round(score*1000)/10:null; // 0-100
  });
  return eligible;
}

function compareRank(a,b){
  const ae=a.rankEligible===true, be=b.rankEligible===true;
  if(ae!==be) return ae?-1:1;
  if(ae&&be){
    const as=finite(a.rankScore)??-Infinity, bs=finite(b.rankScore)??-Infinity;
    if(bs!==as) return bs-as;
    const aa=finite(a.expectedAlpha)??-Infinity, ba=finite(b.expectedAlpha)??-Infinity;
    if(ba!==aa) return ba-aa;
    const aq=finite(a.rankQualityBasketPercentile)??-Infinity, bq=finite(b.rankQualityBasketPercentile)??-Infinity;
    if(bq!==aq) return bq-aq;
  }else{
    // Below the gate, quality cannot compensate for inadequate expected return.
    const aa=finite(a.expectedAlpha)??-Infinity, ba=finite(b.expectedAlpha)??-Infinity;
    if(ba!==aa) return ba-aa;
    const ac=finite(a.expectedCAGR??a.expectedReturn)??-Infinity, bc=finite(b.expectedCAGR??b.expectedReturn)??-Infinity;
    if(bc!==ac) return bc-ac;
  }
  const al=finite(a.investmentScore)??-Infinity, bl=finite(b.investmentScore)??-Infinity;
  if(bl!==al) return bl-al;
  return String(a.ticker||'').localeCompare(String(b.ticker||''));
}

function applyModelDRanking(rows,{rankField='overallRank',universeSizeField='globalUniverseSize',alphaGate=ALPHA_GATE,reliability=false,cycle=CYCLE_PENALTY.live}={}){
  for(const r of rows||[]){
    r.rankEligible=false;
    r.rankScore=null;
    r.rankAlphaPercentile=null;
    r.rankQualityBasketPercentile=null;
  }
  buildModelDScores(rows||[],{alphaGate,reliability,cycle});
  let sorted=[...(rows||[])].sort(compareRank);
  if(reliability){
    // Top-10 needs outside corroboration: eligible names with <3 analysts start at #11.
    const thin=r=>r.rankEligible===true&&!((finite(r.analystEstimates?.numAnalysts)??0)>=3);
    const top=[],held=[];
    for(const r of sorted){ if(top.length<10&&!thin(r)) top.push(r); else held.push(r); }
    sorted=[...top,...held];
    // Build 64: a stock held at Watch for a recent deal or spin-off (its history predates the change) cannot
    // be ranked in the top 25 until a 10-K reflects the new company.
    const pending=r=>r.rankEligible===true&&!!r.corporateAction;
    const top25=[];
    for(const r of sorted){ if(top25.length<25&&!pending(r)) top25.push(r); }
    const inTop=new Set(top25);
    sorted=[...top25,...sorted.filter(r=>!inTop.has(r))];
  }
  sorted.forEach((r,i)=>{r[rankField]=i+1;});
  if(universeSizeField) for(const r of rows||[]) r[universeSizeField]=(rows||[]).length;
  return sorted;
}

module.exports={CYCLE_PENALTY,cycleProfile,cyclePenalty,VALUE_TRAP,revenueCagr3,businessGrowth,valueTrapPenalty,stressedAlpha,ALPHA_GATE,reliabilityAdjustedAlpha,percentileRanks,buildModelDScores,compareRank,applyModelDRanking};
