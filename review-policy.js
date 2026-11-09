'use strict';
// Quarterly review policy for long-horizon holdings (Build 35).
// Different bars for buying and for selling, so ordinary model noise does not cause churn:
//   Add candidate : passes the backtested entry rule (model rank top 20, return >= hurdle, quality >= 75) and is below target size.
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
    // Build 62 thesis-broken rule (backtest: PLTK held 17 quarters while -80%, WSC -55%).
    thesisRevenueStreak:3,   // trailing-12-month revenue down year over year at this many reviews in a row
    thesisEpsRatio:0.80,     // ...and forward EPS at or below this share of its level when bought
    // Build 62b: backtest (Nov 2026) showed the auto-sell missed PLTK/WSC and sold TPL/LRCX instead
    // (validation excess +8.6% vs +8.8% without it). Default is a Review flag only; 'sell' is experimental.
    thesisAction:'review',
  };
  // Position sizing (Build 36). Sizes are set when buying; winners are allowed to run.
  //   target at cost = 3% .. 10%, scaled by conviction (return over hurdle, quality, confidence, coverage)
  //   a position above 20% of the portfolio gets a Review to consider trimming back toward 15%
  //   no single sector above 30% from new purchases
  const SIZING={
    hurdle:0.11,
    maxPositions:15,
    minWeight:0.03,
    maxWeightAtCost:0.10,
    trimAbove:0.20,
    trimTo:0.15,
    sectorCapAtPurchase:0.30,
    minTrade:0.005,
  };
  const BUY_TIERS=['Buy','Strong Buy','Exceptional Buy'];
  const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
  const priceOf=s=>num(s?.price??s?.currentPrice??s?.stockPrice);
  const returnOf=s=>num(s?.underwrittenCAGR??s?.expectedReturn??s?.expectedCAGR);
  const pctTxt=x=>(x*100).toFixed(1)+'%';
  const revGrowthOf=s=>num(s?.revenueGrowthTTM);
  const fwdEpsOf=s=>num(s?.forwardEPS??s?.valuationProjection?.[0]?.eps);
  // Trailing-12-month revenue growth from quarterly points [{end,val}], else the last two annual years.
  function ttmRevenueGrowth(quarters,years){
    const q=(Array.isArray(quarters)?quarters:[]).filter(x=>x&&x.end&&num(x.val)>0).sort((a,b)=>String(a.end).localeCompare(String(b.end)));
    if(q.length>=8){
      const last8=q.slice(-8),span=(Date.parse(last8[7].end)-Date.parse(last8[0].end))/864e5;
      if(span>580&&span<720){const a=last8.slice(4).reduce((t,x)=>t+num(x.val),0),b=last8.slice(0,4).reduce((t,x)=>t+num(x.val),0);if(b>0)return a/b-1;}
    }
    const y=(Array.isArray(years)?years:[]).filter(x=>num(x?.revenue)>0);
    return y.length>=2?num(y.at(-1).revenue)/num(y.at(-2).revenue)-1:null;
  }
  // Carried from review to review: how many reviews in a row TTM revenue has shrunk, and forward EPS at purchase.
  function thesisMemo(s,prev){
    const rg=revGrowthOf(s),fwd=fwdEpsOf(s),prevStreak=num(prev?.streak)||0;
    return {rg,streak:rg===null?prevStreak:(rg<0?prevStreak+1:0),entryEPS:num(prev?.entryEPS)??fwd,fwdEPS:fwd};
  }
  const clamp01=x=>Math.max(0,Math.min(1,x));

  // 0..1 conviction. Quality is weighted as heavily as return: this is a long-horizon owner's book.
  function convictionScore(s){
    if(!s) return null;
    const u=returnOf(s), q=num(s.qualityScore), c=num(s.valuationConfidenceScore??s.confidenceScore??s.valuationConfidence);
    const n=num(s.analystEstimates?.numAnalysts);
    const parts=[];
    if(u!==null) parts.push([.35,clamp01((u-SIZING.hurdle)/0.06)]);   // 11% -> 0, 17%+ -> 1
    if(q!==null) parts.push([.35,clamp01((q-75)/20)]);                 // 75 -> 0, 95+ -> 1
    if(c!==null) parts.push([.20,clamp01((c-60)/30)]);                 // 60 -> 0, 90+ -> 1
    if(n!==null) parts.push([.10,n>=8?1:n>=3?.6:.2]);
    const w=parts.reduce((a,[x])=>a+x,0);
    return w>0?parts.reduce((a,[x,v])=>a+x*v,0)/w:null;
  }
  function targetWeight(s){
    const c=convictionScore(s); if(c===null) return SIZING.minWeight;
    const w=SIZING.minWeight+(SIZING.maxWeightAtCost-SIZING.minWeight)*c;
    return Math.round(w*200)/200; // nearest 0.5%
  }
  function sizeTier(w){return w>=.075?'High conviction':w>=.05?'Standard':'Starter';}
  // A stock you would buy today (not merely keep): above hurdle, quality 75+, rated Buy or better
  // and at/below the hurdle + MOS buy price.
  // The entry rule the Build 36 backtest validated (arm C). One definition, used by the app and the backtest.
  function shortlistEntry(s,{rankField='overallRank',maxRank=20}={}){
    if(!s||s.rating==='Unrated') return false;
    const u=returnOf(s), q=num(s.qualityScore), rk=num(s[rankField]);
    return rk!==null&&rk<=maxRank&&u!==null&&u>=SIZING.hurdle&&q!==null&&q>=BANDS.reviewQuality;
  }
  // Stricter legacy rule (Buy rating + below buy price). Kept for comparison; historically it almost never fired.
  function entryEligible(s){
    if(!s) return false;
    const u=returnOf(s), q=num(s.qualityScore), price=priceOf(s), buy=num(s.requiredReturnBuyPrice);
    return BUY_TIERS.includes(s.rating||'')&&u!==null&&u>=SIZING.hurdle&&q!==null&&q>=BANDS.reviewQuality&&price!==null&&buy!==null&&price<=buy;
  }

  // New-money plan. holdings: [{ticker, value, stock}], candidates: ordered stock records (research priority).
  // Fills holdings that are below target and still buyable first, then opens new positions in order.
  function planContribution({holdings=[],candidates=[],cash=0}={}){
    cash=num(cash)||0; if(cash<=0) return {total:0,lines:[],leftover:0};
    const invested=holdings.reduce((a,h)=>a+(num(h.value)||0),0), total=invested+cash;
    const sectorOf=s=>String(s?.sector||'Unknown');
    const sector={}; for(const h of holdings){const k=sectorOf(h.stock);sector[k]=(sector[k]||0)+(num(h.value)||0);}
    const lines=[]; let left=cash;
    const buy=(stock,current,isNew)=>{
      if(left<=0) return;
      const target=targetWeight(stock)*total, k=sectorOf(stock);
      const room=Math.max(0,SIZING.sectorCapAtPurchase*total-(sector[k]||0));
      const amt=Math.min(left,Math.max(0,target-current),room);
      if(amt<SIZING.minTrade*total) return;
      left-=amt; sector[k]=(sector[k]||0)+amt;
      lines.push({ticker:String(stock.ticker).toUpperCase(),amount:amt,isNew,targetWeight:target/total,resultingWeight:(current+amt)/total,tier:sizeTier(target/total)});
    };
    const held=new Map(holdings.map(h=>[String(h.ticker).toUpperCase(),h]));
    for(const h of holdings) if(shortlistEntry(h.stock)) buy(h.stock,num(h.value)||0,false);
    let positions=holdings.length;
    const seen=new Set();
    for(const s of candidates){
      const t=String(s.ticker).toUpperCase(), fam=t==='GOOGL'?'GOOG':t;
      if(held.has(t)||held.has(fam==='GOOG'?'GOOGL':t)||seen.has(fam)) continue; seen.add(fam);
      if(positions>=SIZING.maxPositions||left<=0) break;
      if(!shortlistEntry(s)) continue;
      const before=lines.length; buy(s,0,true); if(lines.length>before) positions++;
    }
    return {total,lines,leftover:left};
  }

  // prev = this ticker's entry from the previous snapshot ({u,q,...}) or null.
  function holdingStatus(s,prev,ctx={}){
    if(!s) return {status:'Review',reasons:['Not in the latest nightly data; check the ticker']};
    const u=returnOf(s), q=num(s.qualityScore), rating=s.rating||'';
    const sell=[], review=[];
    if(q!==null&&q<BANDS.sellQuality) sell.push('Quality '+q+' is below '+BANDS.sellQuality+'; re-check the thesis');
    if(u!==null&&u<BANDS.lowReturn){
      const prevU=num(prev?.u);
      if(prevU!==null&&prevU<BANDS.lowReturn) sell.push('Expected return below '+pctTxt(BANDS.lowReturn)+' for two reviews in a row ('+pctTxt(prevU)+' then '+pctTxt(u)+')');
      else review.push('Expected return '+pctTxt(u)+' is below '+pctTxt(BANDS.lowReturn)+'; sell candidate if still low next review');
    }
    const memo=thesisMemo(s,prev);
    const thesisAction=ctx.thesisBreak===false?'off':(ctx.thesisBreak==='sell'||ctx.thesisBreak===true?'sell':BANDS.thesisAction);
    if(thesisAction!=='off'){
      const epsDown=memo.entryEPS>0&&memo.fwdEPS!==null&&memo.fwdEPS<=BANDS.thesisEpsRatio*memo.entryEPS;
      const epsTxt=memo.entryEPS>0&&memo.fwdEPS!==null?pctTxt(1-memo.fwdEPS/memo.entryEPS):'';
      if(memo.streak>=BANDS.thesisRevenueStreak&&epsDown) (thesisAction==='sell'?sell:review).push('Business shrinking: revenue down year over year for '+memo.streak+' reviews in a row and forward EPS '+epsTxt+' below its level when bought');
      else if(memo.streak>=BANDS.thesisRevenueStreak-1&&memo.rg!==null&&memo.rg<0) review.push('Revenue down year over year for '+memo.streak+' reviews in a row ('+pctTxt(memo.rg)+')');
      else if(epsDown) review.push('Forward EPS is '+epsTxt+' below its level when bought');
    }
    if(q!==null&&q>=BANDS.sellQuality&&q<BANDS.reviewQuality) review.push('Quality '+q+' is below '+BANDS.reviewQuality);
    const prevQ=num(prev?.q);
    if(q!==null&&prevQ!==null&&prevQ-q>=BANDS.qualityDropReview) review.push('Quality fell '+(prevQ-q)+' points since the last review');
    if(rating==='Unrated'||u===null) review.push('Model could not value it this run');
    const w=num(ctx.weight);
    if(w!==null&&w>SIZING.trimAbove) review.push('Position is '+pctTxt(w)+' of the portfolio; consider trimming toward '+pctTxt(SIZING.trimTo));
    if(sell.length) return {status:'Sell candidate',reasons:[...sell,...review],memo};
    if(review.length) return {status:'Review',reasons:review,memo};
    if(shortlistEntry(s)){
      if(w!==null&&w>=targetWeight(s)) return {status:'Hold',reasons:['Still passes the buy rules, but already at or above its '+pctTxt(targetWeight(s))+' target size'],memo};
      return {status:'Add candidate',reasons:['Passes the buy rules (rank '+num(s.overallRank)+', '+pctTxt(u)+' expected return, quality '+q+')'],memo};
    }
    return {status:'Hold',reasons:['Nothing has changed enough to act on'],memo};
  }

  // shortlist = ordered array of stock records (research-priority order).
  function buildSnapshot({stocks=[],holdings=[],shortlist=[],prev=null,generatedAt=null,takenAt=new Date().toISOString()}={}){
    const by=new Map(stocks.map(s=>[String(s.ticker).toUpperCase(),s]));
    const prevH=new Map((prev?.holdings||[]).map(h=>[h.ticker,h]));
    const prices={};
    for(const s of stocks){const p=priceOf(s);if(p!==null&&p>0)prices[String(s.ticker).toUpperCase()]=p;}
    return {
      version:1,takenAt,generatedAt,
      holdings:holdings.map(h=>{const t=String(h.ticker).toUpperCase(),s=by.get(t),st=holdingStatus(s,prevH.get(t));return {ticker:t,shares:num(h.shares),price:priceOf(s),u:returnOf(s),q:num(s?.qualityScore),rating:s?.rating??null,status:st.status,rg:st.memo?.rg??null,streak:st.memo?.streak??0,entryEPS:st.memo?.entryEPS??null};}),
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

  const api={ttmRevenueGrowth,thesisMemo,BANDS,SIZING,convictionScore,targetWeight,sizeTier,shortlistEntry,entryEligible,planContribution,holdingStatus,buildSnapshot,shortlistPerformance,nextReviewDate};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.ReviewPolicy=api;
})(typeof window!=='undefined'?window:globalThis);
