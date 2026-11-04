'use strict';
// Quarterly review policy for long-horizon holdings (Build 35).
// Different bars for buying and for selling, so ordinary model noise does not cause churn:
//   Add candidate : rated Buy or better AND price at or below the hurdle + MOS buy price.
//   Hold          : default. Falling in rank is NOT a reason to sell.
//   Review        : something worth a look (first low-return reading, quality slipping, unrated).
//   Sell candidate: quality broke (<70) OR expected return stayed below the floor two reviews running.
// Shared by the browser (window.ReviewPolicy) and Node tests (module.exports).
(function(root){
  const BANDS={
    sellQuality:70,          // quality below this = thesis likely broken
    reviewQuality:75,        // quality below this = keep an eye on it
    lowReturn:0.065,         // underwritten CAGR below this = price has run ahead of value
    qualityDropReview:10,    // quality fell this many points since last snapshot
    reviewDays:91,           // quarterly cadence
    shortlistSize:20,
  };
  const BUY_TIERS=['Buy','Strong Buy','Exceptional Buy'];
  const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
  const priceOf=s=>num(s?.price??s?.currentPrice??s?.stockPrice);
  const returnOf=s=>num(s?.underwrittenCAGR??s?.expectedReturn??s?.expectedCAGR);
  const pctTxt=x=>(x*100).toFixed(1)+'%';

  // prev = this ticker's entry from the previous snapshot ({u,q,...}) or null.
  function holdingStatus(s,prev){
    if(!s) return {status:'Review',reasons:['Not in the latest nightly data; check the ticker']};
    const u=returnOf(s), q=num(s.qualityScore), rating=s.rating||'';
    const sell=[], review=[];
    if(q!==null&&q<BANDS.sellQuality) sell.push('Quality '+q+' is below '+BANDS.sellQuality+'; re-check the thesis');
    if(u!==null&&u<BANDS.lowReturn){
      const prevU=num(prev?.u);
      if(prevU!==null&&prevU<BANDS.lowReturn) sell.push('Expected return below '+pctTxt(BANDS.lowReturn)+' for two reviews in a row ('+pctTxt(prevU)+' then '+pctTxt(u)+')');
      else review.push('Expected return '+pctTxt(u)+' is below '+pctTxt(BANDS.lowReturn)+'; sell candidate if still low next review');
    }
    if(q!==null&&q>=BANDS.sellQuality&&q<BANDS.reviewQuality) review.push('Quality '+q+' is below '+BANDS.reviewQuality);
    const prevQ=num(prev?.q);
    if(q!==null&&prevQ!==null&&prevQ-q>=BANDS.qualityDropReview) review.push('Quality fell '+(prevQ-q)+' points since the last review');
    if(rating==='Unrated'||u===null) review.push('Model could not value it this run');
    if(sell.length) return {status:'Sell candidate',reasons:[...sell,...review]};
    if(review.length) return {status:'Review',reasons:review};
    const price=priceOf(s), buy=num(s.requiredReturnBuyPrice);
    if(BUY_TIERS.includes(rating)&&price!==null&&buy!==null&&price<=buy) return {status:'Add candidate',reasons:['Rated '+rating+' and at or below the buy price']};
    return {status:'Hold',reasons:['Nothing has changed enough to act on']};
  }

  // shortlist = ordered array of stock records (research-priority order).
  function buildSnapshot({stocks=[],holdings=[],shortlist=[],prev=null,generatedAt=null,takenAt=new Date().toISOString()}={}){
    const by=new Map(stocks.map(s=>[String(s.ticker).toUpperCase(),s]));
    const prevH=new Map((prev?.holdings||[]).map(h=>[h.ticker,h]));
    const prices={};
    for(const s of stocks){const p=priceOf(s);if(p!==null&&p>0)prices[String(s.ticker).toUpperCase()]=p;}
    return {
      version:1,takenAt,generatedAt,
      holdings:holdings.map(h=>{const t=String(h.ticker).toUpperCase(),s=by.get(t),st=holdingStatus(s,prevH.get(t));return {ticker:t,shares:num(h.shares),price:priceOf(s),u:returnOf(s),q:num(s?.qualityScore),rating:s?.rating??null,status:st.status};}),
      shortlist:shortlist.slice(0,BANDS.shortlistSize).map((s,i)=>({ticker:String(s.ticker).toUpperCase(),position:i+1,price:priceOf(s),u:returnOf(s),q:num(s.qualityScore),rating:s.rating??null,rank:num(s.overallRank)})),
      prices,
    };
  }

  // Price-only returns (dividends excluded) since a snapshot, vs an equal-weight universe benchmark.
  function shortlistPerformance(snap,stocks){
    if(!snap) return null;
    const now=new Map((stocks||[]).map(s=>[String(s.ticker).toUpperCase(),priceOf(s)]));
    const ret=(t,p0)=>{const p1=now.get(t);return p0>0&&p1>0?p1/p0-1:null;};
    const picks=(snap.shortlist||[]).map(x=>({ticker:x.ticker,ret:ret(x.ticker,x.price)})).filter(x=>x.ret!==null);
    const uni=Object.entries(snap.prices||{}).map(([t,p])=>ret(t,p)).filter(x=>x!==null);
    const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
    const days=Math.max(0,Math.round((Date.now()-Date.parse(snap.takenAt))/864e5));
    return {days,picks,shortlistReturn:avg(picks.map(x=>x.ret)),universeReturn:avg(uni),pickCount:picks.length,universeCount:uni.length};
  }

  function nextReviewDate(snap){
    if(!snap?.takenAt) return null;
    return new Date(Date.parse(snap.takenAt)+BANDS.reviewDays*864e5).toISOString().slice(0,10);
  }

  const api={BANDS,holdingStatus,buildSnapshot,shortlistPerformance,nextReviewDate};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.ReviewPolicy=api;
})(typeof window!=='undefined'?window:globalThis);
