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
  // Build 74/75: PEG list (quality growth at a reasonable price). PEG = P/E / growth (in %). Build 75: 5-year revenue-per-share growth, analyst P/E.
  // Bands: buy <= 1.5, watch <= 2.0, pricey > 2.5.
  // Forward when analysts cover it (price / next-year EPS, next-year EPS growth); otherwise trailing
  // (market cap / last net income, 3-year EPS-per-share CAGR). Growth is capped at 1.5x revenue
  // growth so a one-off earnings jump can't flatter the ratio, and at 50%.
  const PEG={buyMax:1.5,watchMax:2.0,sellAbove:2.5,minQuality:75,minGrowth:0.10,minEpsGrowth:0.08,growthCap:0.50,revenueMultiple:1.5,marginCreditCap:0.05};
  // Build 74: which valuation sell rule is live. 'current' = expected return under 6.5% two reviews
  // running. Alternatives are tested in the backtest (owner strategy lab) before any is switched on:
  //   relative    : line = min(6.5%, market median expected return - 3 pts)
  //   qualityOnly : never sell on valuation; only quality < 70 sells
  //   peg         : expensive = PEG above 2 (falls back to the return line when there is no PEG)
  //   staged      : current line, but sell half at the first low reading and the rest at the second
  const SELL={rule:'current',relativeGap:0.03};
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
  // Build 72: the live entry settings. Defaults = arm C. The owner backtest runs the variants (C35, C50, CW, CQ,
  // C35W); change these only to a variant that beat C in BOTH periods (see README-build72).
  const ENTRY={maxRank:20,minQuality:75,blockSplit:false,blockCycleAtPeak:false};
  // Build 72: the GARP list (owner's style). Quality 75+, revenue growing 10%+ a year (average of trailing-12-month
  // growth and the 3-year CAGR), any model rank (the rank leans to cheapness and hid MSFT, GOOG, FIX at #175-220).
  // App list: underwritten return 7%+ (watch zone); buy zone and backtest arm CG: 9%+.
  const GARP={maxRank:Infinity,minReturn:0.09,listMinReturn:0.07,minQuality:75,minGrowth:0.10};
  function businessGrowthOf(s){
    const v=[num(s&&s.revenueGrowthTTM),num(s&&s.revenueCAGR3)].filter(x=>x!==null&&x>-.6&&x<3);
    return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
  }
  // Why a shortlist name would be skipped under the warning blocks (also shown as review notes in the app).
  function entryWarnings(s){
    const w=[];
    if(s&&(s.methodsSplit===true||/two camps/.test(String(s.modelSupportReason||''))))w.push('split');
    if(s&&s.cycle&&s.cycle.atPeak)w.push('cycle_peak');
    return w;
  }
  function shortlistEntry(s,{rankField='overallRank',maxRank=ENTRY.maxRank,minQuality=ENTRY.minQuality,blockSplit=ENTRY.blockSplit,blockCycleAtPeak=ENTRY.blockCycleAtPeak,minReturn=SIZING.hurdle,minGrowth=null}={}){
    if(!s||s.rating==='Unrated') return false;
    const u=returnOf(s), q=num(s.qualityScore), rk=num(s[rankField]);
    if(!((maxRank===Infinity||(rk!==null&&rk<=maxRank))&&u!==null&&u>=minReturn&&q!==null&&q>=minQuality)) return false;
    if(minGrowth!==null){const g=businessGrowthOf(s);if(g===null||g<minGrowth) return false;}
    const w=entryWarnings(s);
    if(blockSplit&&w.includes('split')) return false;
    if(blockCycleAtPeak&&w.includes('cycle_peak')) return false;
    return true;
  }
  // Stricter legacy rule (Buy rating + below buy price). Kept for comparison; historically it almost never fired.
  function garpEntry(s,{rankField='overallRank',minReturn=GARP.minReturn}={}){
    return shortlistEntry(s,{rankField,maxRank:GARP.maxRank,minQuality:GARP.minQuality,minGrowth:GARP.minGrowth,minReturn});
  }
  function entryEligible(s){
    if(!s) return false;
    const u=returnOf(s), q=num(s.qualityScore), price=priceOf(s), buy=num(s.requiredReturnBuyPrice);
    return BUY_TIERS.includes(s.rating||'')&&u!==null&&u>=SIZING.hurdle&&q!==null&&q>=BANDS.reviewQuality&&price!==null&&buy!==null&&price<=buy;
  }

  // Build 75: 5-year PEG = next year's P/E ÷ growth per year over 5 years.
  //   P/E:    analysts' next-year EPS (the usual PEG convention); else the model's next-year EPS; else trailing.
  //   growth: the model's 5-year REVENUE PER SHARE growth. Margins are assumed to hold flat (the model's margin
  //           fade and its stock-pay charge made EPS-based growth unreliable: NOW came out at PEG 66), while
  //           dilution still counts through the share count. Falls back to analysts' next-year EPS growth
  //           (capped at 1.5x revenue growth), then trailing 3-yr EPS growth. Capped at 50%.
  function pegOf(s){
    if(!s) return null;
    const a=s.analystEstimates||{}, px=priceOf(s), bg=businessGrowthOf(s), rg=num(a.revenueGrowthNextYear);
    const aNext=num(a.epsNextYear), e1=num(s.modelEPS1), r0=num(s.modelRevPS0), r5=num(s.modelRevPS5);
    let pe=null,g=null,source=null;
    if(px!==null&&px>0){ if(aNext!==null&&aNext>0) pe=px/aNext; else if(e1!==null&&e1>0) pe=px/e1; }
    if(pe===null){const t=num(s.peTTM);if(t!==null&&t>0)pe=t;}
    if(r0!==null&&r0>0&&r5!==null&&r5>0){g=Math.pow(r5/r0,1/5)-1;source='model5y';}
    else{
      const eg=num(a.epsGrowthNextYear)??num(a.epsGrowthFwd);
      if(eg!==null&&aNext!==null&&aNext>0){g=eg;source='analyst1y';}
      else{const t=num(s.epsCAGR3);if(t!==null){g=t;source='trailing';}}
      const revBase=Math.max(rg??-1,bg??-1);
      if(g!==null&&revBase>-1) g=Math.min(g,PEG.revenueMultiple*Math.max(revBase,0));
    }
    if(pe===null||g===null) return null;
    // Margin credit (live only; no analyst history in the backtest): if analysts expect earnings to outgrow
    // revenue-plus-buybacks over this year and next, count that margin gain for those 2 of the 5 years.
    // Skipped when either year looks like a one-off: a sign flip, or EPS growth far above revenue growth.
    let marginCredit=0;
    if(source==='model5y'){
      const cy=num(a.epsGrowthCurrentYear),ny=num(a.epsGrowthNextYear),rcy=num(a.revenueGrowthCurrentYear),rny=num(a.revenueGrowthNextYear);
      const R0=num(s.modelRev0),R5=num(s.modelRev5);
      if(cy!==null&&ny!==null&&rcy!==null&&rny!==null&&cy>0&&ny>0&&cy<=2*Math.max(rcy,0)+0.15&&ny<=2*Math.max(rny,0)+0.15){
        const buyback=R0>0&&R5>0?g-(Math.pow(R5/R0,1/5)-1):0;   // revenue-per-share growth minus revenue growth
        const e2=Math.sqrt((1+cy)*(1+ny))-1, r2=Math.sqrt((1+rcy)*(1+rny))-1;
        marginCredit=Math.min(PEG.marginCreditCap,Math.max(0,(e2-r2-buyback)*2/5));
      }
      g+=marginCredit;
    }
    g=Math.min(g,PEG.growthCap);
    if(!(g>0)) return {peg:null,pe,growth:g,source,marginCredit};
    return {peg:pe/(g*100),pe,growth:g,source,marginCredit};
  }
  // On the PEG list: quality 75+, revenue growing 10%+, earnings growth 8%+, PEG <= maxPeg.
  function pegEntry(s,{maxPeg=PEG.buyMax,minQuality=PEG.minQuality,minGrowth=PEG.minGrowth}={}){
    if(!s||s.valuationExclusion) return false;
    const q=num(s.qualityScore),bg=businessGrowthOf(s),p=pegOf(s);
    return q!==null&&q>=minQuality&&bg!==null&&bg>=minGrowth&&!!p&&p.peg!==null&&p.growth>=PEG.minEpsGrowth&&p.peg<=maxPeg;
  }
  // Valuation sell test under the chosen rule. Returns {expensive, line, why}.
  //   both        : (Build 75) expensive only when BOTH checks agree: return under 6.5% AND PEG above 2.5
  //                 (return alone when there is no PEG). When they disagree it is a hold.
  //   bothStaged  : 'both', selling half at the first reading and the rest at the second.
  const isStaged=rule=>rule==='staged'||rule==='bothStaged';
  function valuationCheck(s,ctx={}){
    const rule=ctx.sellRule||SELL.rule, u=returnOf(s);
    if(rule==='qualityOnly') return {expensive:false,rule};
    if(rule==='peg'){const p=pegOf(s);if(p&&p.peg!==null)return {expensive:p.peg>PEG.sellAbove,rule,peg:p.peg};}
    let line=BANDS.lowReturn;
    if(rule==='relative'){const m=num(ctx.marketMedian);if(m!==null)line=Math.min(BANDS.lowReturn,m-SELL.relativeGap);}
    const lowU=u!==null&&u<line;
    if(rule==='both'||rule==='bothStaged'){const p=pegOf(s),pg=p&&p.peg!==null?p.peg:null;
      return {expensive:lowU&&(pg===null||pg>PEG.sellAbove),rule,line,pegLine:PEG.sellAbove,pegNow:pg,disagree:lowU&&pg!==null&&pg<=PEG.sellAbove};}
    return {expensive:lowU,rule,line};
  }
  function prevExpensive(prev,check){
    if(!prev) return false;
    if(check.rule==='peg'&&check.peg!==undefined){const pp=num(prev.peg);return pp!==null?pp>PEG.sellAbove:false;}
    const pu=num(prev.u),lowPrev=pu!==null&&check.line!==undefined&&pu<check.line;
    if(check.pegLine!==undefined){const pp=num(prev.peg);return lowPrev&&(pp===null||pp>check.pegLine);}
    return lowPrev;
  }
  // Build 75: the tested quality sell is "fell below 70 after being bought at 75+". A holding that was already
  // below the bar when first seen (bought outside the rules) gets a Review, not a Sell.
  function qualityBroke(q,prev){
    if(q===null||q>=BANDS.sellQuality) return false;
    const eq=num(prev?.entryQ);
    return eq===null?false:(eq>=BANDS.reviewQuality||eq-q>=BANDS.qualityDropReview);
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
    const entryQ=num(prev?.entryQ)??q;
    if(q!==null&&q<BANDS.sellQuality){if(qualityBroke(q,{entryQ}))sell.push('Quality '+q+' is below '+BANDS.sellQuality+' (was '+entryQ+' when first held); re-check the thesis');else review.push('Quality '+q+' is below the '+BANDS.reviewQuality+' bar and was when first held; the tested sell rule does not cover it');}
    const vc=valuationCheck(s,ctx); let trimHalf=false;
    if(vc.expensive){
      const what=vc.peg!==undefined?'PEG above '+PEG.sellAbove:'Expected return below '+pctTxt(vc.line)+(vc.pegLine!==undefined&&vc.pegNow!==null?' and PEG above '+vc.pegLine:'');
      if(prevExpensive(prev,vc)) sell.push(what+' for two reviews in a row');
      else{review.push(what+'; sell candidate if still there next review');if(isStaged(vc.rule))trimHalf=true;}
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
    memo.entryQ=entryQ;
    if(sell.length) return {status:'Sell candidate',reasons:[...sell,...review],memo};
    if(trimHalf) return {status:'Trim half',reasons:review,memo};
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
      holdings:holdings.map(h=>{const t=String(h.ticker).toUpperCase(),s=by.get(t),st=holdingStatus(s,prevH.get(t));return {ticker:t,shares:num(h.shares),price:priceOf(s),u:returnOf(s),q:num(s?.qualityScore),entryQ:num(prevH.get(t)?.entryQ)??num(s?.qualityScore),peg:pegOf(s)?.peg??null,rating:s?.rating??null,status:st.status,rg:st.memo?.rg??null,streak:st.memo?.streak??0,entryEPS:st.memo?.entryEPS??null};}),
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

  // Build 73: one plain-English call per holding: Buy more / Hold / Sell some / Sell / Review, with the reasons.
  // Built on the backtested rules (quality and return bands, target sizes, the C and GARP buy rules).
  //   Sell      : quality under 70 AND expected return under 6.5% (both the business and the price fail), or
  //               expected return under 6.5% at two reviews in a row on a business below quality 80
  //   Sell some : position over 20% of the portfolio (trim to ~15%); quality under 70 alone (the backtest sells
  //               these; the dashboard takes some off and asks for a thesis check); expensive two reviews running
  //               on a great business (keep a core); or expensive and above its target size
  //   Buy more  : passes the C or GARP buy rule, more than 1 pt under its target size, no severe estimate cut
  //   Review    : not in the data, or the model cannot value it
  //   Hold      : everything else (a lower rank alone is never a reason to sell)
  // Build 75: advice follows the tested rules only (same decisions as holdingStatus, in plain English).
  function holdingAdvice(s,prev,ctx={}){
    const weight=num(ctx.weight);
    const p1=x=>(x*100).toFixed(1)+'%', p0=x=>Math.round(x*100)+'%';
    if(!s) return {action:'Review',tone:'review',headline:'Not in tonight’s data; check the ticker',reasons:[],weight,target:null};
    const u=returnOf(s), q=num(s.qualityScore), g=businessGrowthOf(s), target=targetWeight(s);
    const rev=s.estimateRevision||null, warn=entryWarnings(s);
    const unvaluable=s.rating==='Unrated'||s.modelSupport==='unsupported';
    const vc=valuationCheck(s,ctx), pg=pegOf(s), staged=isStaged(vc.rule);
    const entryQ=num(prev?.entryQ)??q;
    const lowQ=q!==null&&q<BANDS.sellQuality, qBroke=qualityBroke(q,{entryQ});
    const lowU=vc.expensive, twoLow=lowU&&prevExpensive(prev,vc);
    const uLow=u!==null&&vc.line!==undefined&&u<vc.line;
    const pegCheap=pg&&pg.peg!==null&&pg.peg<=PEG.buyMax;
    const why=[];
    if(u!==null) why.push(u>=SIZING.hurdle?`Long-term model: ${p1(u)} a year expected, above the ${p0(SIZING.hurdle)} hurdle`
      :!uLow?`Long-term model: ${p1(u)} a year expected; fair, under the ${p0(SIZING.hurdle)} hurdle`
      :`Long-term model: ${p1(u)} a year expected; the price is ahead of the value (floor ${p1(vc.line)})`+(twoLow?`, two reviews in a row`:''));
    if(pg&&pg.peg!==null) why.push(`5-yr PEG ${pg.peg.toFixed(2)}: P/E ${pg.pe.toFixed(1)} on ${p0(pg.growth)} a year growth`+(pg.source==='model5y'?(pg.marginCredit>0.0005?` (revenue per share + ${(pg.marginCredit*100).toFixed(1)} pts margin gains analysts expect)`:' (revenue per share, next 5 years)'):pg.source==='analyst1y'?' (next year’s earnings, analysts)':' (trailing earnings)')+' — '+(pg.peg<=1.0?'cheap':pg.peg<=PEG.buyMax?'reasonable':pg.peg<=PEG.sellAbove?'full price':'pricey')+' for its growth');
    else if(pg&&pg.peg===null) why.push('No PEG: no growth expected');
    if(uLow&&pegCheap) why.push(vc.pegLine!==undefined?'The price checks disagree (cheap on PEG, rich on the long-term model), so no sell on price':'The price checks disagree: cheap on PEG, rich on the long-term model');
    if(q!==null) why.push(q>=85?`Quality ${q}: top tier`:q>=BANDS.reviewQuality?`Quality ${q}: good`:!lowQ?`Quality ${q}: below the ${BANDS.reviewQuality} bar`:qBroke?`Quality ${q}: fell below ${BANDS.sellQuality} since you’ve held it (was ${entryQ})`:`Quality ${q}: below the bar, and it was when first held`);
    if(g!==null) why.push(g>=0.10?`Revenue growing ${p0(g)} a year`:g>=0.03?`Revenue growing a modest ${p0(g)} a year`:g>=0?`Revenue roughly flat`:`Revenue shrinking ${p0(-g)} a year`);
    if(rev&&rev.level) why.push(rev.label);
    if(warn.includes('split')) why.push('Valuation methods disagree, so treat the fair value as rough');
    if(warn.includes('cycle_peak')) why.push('Cyclical business with profits near a peak');
    const out=(action,tone,headline,lead=[])=>({action,tone,headline,reasons:[...lead,...why].slice(0,8),weight,target});
    if(unvaluable) return out('Review','review','The model can’t value this one; judge it on your own research',[s.modelSupportReason||'No reliable valuation']);
    if(qBroke) return out('Sell','sell','Sell: business quality has dropped since you bought it');
    if(twoLow) return out('Sell','sell',staged?'Sell the rest: still expensive a second review in a row':'Sell: expensive two reviews in a row');
    if(lowU&&staged) return out('Sell some','trim','Sell half: expensive now; sell the rest if it still is next review');
    if(weight!==null&&weight>SIZING.trimAbove) return out('Sell some','trim',`Sell some: trim from ${p1(weight)} toward about ${p0(SIZING.trimTo)} of the portfolio`,[`One position this big can swing the whole portfolio (limit ${p0(SIZING.trimAbove)})`]);
    if(lowQ) return out('Hold','hold','Hold, but don’t add: below the model’s quality bar',['Not a sell: the tested quality sell is for quality that drops after you buy, and this was already low']);
    const buyable=shortlistEntry(s)||garpEntry(s)||pegEntry(s);
    if(buyable&&weight!==null&&target!==null&&weight<target-0.01){
      if(rev&&rev.level==='severe') return out('Hold','hold','Hold: would be a buy, but analysts just cut estimates sharply; wait a quarter');
      return out('Buy more','buy',`Buy more: up to about ${p1(target)} of the portfolio (now ${p1(weight)})`,[shortlistEntry(s)?'Passes the backtested buy rule':pegEntry(s)?`On the PEG buy list (quality growth, 5-yr PEG ${PEG.buyMax} or less)`:'In the GARP buy zone (quality growth at a fair price)']);
    }
    if(lowU) return out('Hold','hold','Hold, but don’t add: priced ahead of its value',['Becomes a sell if it is still this expensive next review']);
    if(q!==null&&q<BANDS.reviewQuality) return out('Hold','hold','Hold and keep an eye on quality');
    return out('Hold','hold',buyable?'Hold: already at its target size':q!==null&&q>=80&&u!==null&&u>=0.09?'Hold: strong business at a fair price':'Hold: nothing here calls for a change');
  }
  const ADVICE_ORDER={Sell:0,'Sell some':1,'Buy more':2,Review:3,Hold:4};

  const api={qualityBroke,isStaged,PEG,SELL,pegOf,pegEntry,valuationCheck,prevExpensive,holdingAdvice,ADVICE_ORDER,ENTRY,GARP,garpEntry,businessGrowthOf,entryWarnings,ttmRevenueGrowth,thesisMemo,BANDS,SIZING,convictionScore,targetWeight,sizeTier,shortlistEntry,entryEligible,planContribution,holdingStatus,buildSnapshot,shortlistPerformance,nextReviewDate};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.ReviewPolicy=api;
})(typeof window!=='undefined'?window:globalThis);
