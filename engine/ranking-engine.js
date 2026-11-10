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

function buildModelDScores(rows,{alphaGate=ALPHA_GATE,reliability=false}={}){
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
    const score=Number.isFinite(alpha[i])&&Number.isFinite(basket)
      ?0.5*alpha[i]+0.5*basket
      :null;
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

function applyModelDRanking(rows,{rankField='overallRank',universeSizeField='globalUniverseSize',alphaGate=ALPHA_GATE,reliability=false}={}){
  for(const r of rows||[]){
    r.rankEligible=false;
    r.rankScore=null;
    r.rankAlphaPercentile=null;
    r.rankQualityBasketPercentile=null;
  }
  buildModelDScores(rows||[],{alphaGate,reliability});
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

module.exports={stressedAlpha,ALPHA_GATE,reliabilityAdjustedAlpha,percentileRanks,buildModelDScores,compareRank,applyModelDRanking};
