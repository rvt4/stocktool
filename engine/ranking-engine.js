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

function buildModelDScores(rows,{alphaGate=ALPHA_GATE}={}){
  const eligible=(rows||[]).filter(r=>(finite(r.expectedAlpha)??-Infinity)>=alphaGate);
  if(!eligible.length) return eligible;

  const alpha=percentileRanks(eligible.map(r=>r.expectedAlpha));
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

function applyModelDRanking(rows,{rankField='overallRank',universeSizeField='globalUniverseSize',alphaGate=ALPHA_GATE}={}){
  for(const r of rows||[]){
    r.rankEligible=false;
    r.rankScore=null;
    r.rankAlphaPercentile=null;
    r.rankQualityBasketPercentile=null;
  }
  buildModelDScores(rows||[],{alphaGate});
  const sorted=[...(rows||[])].sort(compareRank);
  sorted.forEach((r,i)=>{r[rankField]=i+1;});
  if(universeSizeField) for(const r of rows||[]) r[universeSizeField]=(rows||[]).length;
  return sorted;
}

module.exports={ALPHA_GATE,percentileRanks,buildModelDScores,compareRank,applyModelDRanking};
