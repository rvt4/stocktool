'use strict';
// Build 36: Owner strategy lab.
// Tests the strategy the app actually recommends, using the SAME rules as the app:
//   - live (evidence-adjusted) ranking from engine/ranking-engine.js
//   - quarterly review with review-policy.js statuses (Sell candidate => sell)
//   - position sizing from review-policy.js (conviction 3-10% at cost, trim review above 20%)
//   - idle cash sits in SPY ("index fund until next review"), so cash is not a hidden drag
// All arms are predeclared. Do not tune thresholds to this output: read it once as a pass/fail check.
const {applyModelDRanking}=require('./engine/ranking-engine');
const RP=require('./review-policy');

const finite=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const mean=a=>{const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;};
const median=a=>{const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const family=t=>{t=String(t||'').toUpperCase();return t==='GOOG'||t==='GOOGL'?'ALPHABET':t;};

function liveRankedRows(rows,rankOpts={}){
  const c=(rows||[]).map(r=>({...r}));
  applyModelDRanking(c,{rankField:'liveRank',universeSizeField:null,reliability:true,...rankOpts});
  return c;
}

function shortlistEligible(r,opts={}){return RP.shortlistEntry(r,{rankField:'liveRank',...opts});}

// Build 74: after-tax view for a taxable account. Taxes are paid out of the portfolio when gains are
// realized (assumed rates below; dividends and the SPY cash sleeve are not taxed here, so idle cash is
// treated like a tax-free index holding). "Liquidated" also taxes the unrealized gains left at the end, so
// strategies that defer gains are compared fairly. SPY after tax = buy and hold, taxed once at the end.
const TAX={shortTerm:0.35,longTerm:0.20};
function afterTaxSummary(periods,lots,lossCarry,tax,portfolioStats){
  const pre=portfolioStats(periods,{periodsPerYear:4});
  const at=portfolioStats(periods.map(p=>({...p,portfolioReturn:p.afterTaxReturn??p.portfolioReturn})),{periodsPerYear:4});
  if(!at.periodCount)return null;
  const endDate=periods.at(-1)?.asOf;
  let st=0,lt=0;for(const L of lots.values())for(const l of L){const g=l.value-l.basis;if((Date.parse(endDate)-Date.parse(l.date))/864e5>=365)lt+=g;else st+=g;}
  let taxable=Math.max(0,st+lt-lossCarry);const stShare=st+lt>0?Math.max(0,st)/(Math.max(0,st)+Math.max(0,lt)||1):0;
  const liqTax=taxable*(stShare*tax.shortTerm+(1-stShare)*tax.longTerm);   // fraction of final portfolio
  const W=1+at.cumulativeReturn,liqW=W*(1-liqTax),yrs=at.yearCount;
  const spyW=1+at.spyCumulativeReturn,spyLiqW=spyW-(spyW-1)*tax.longTerm;
  const c=w=>yrs>0&&w>0?Math.pow(w,1/yrs)-1:null;
  return {rates:tax,preTaxCAGR:pre.portfolioCAGR,afterTaxCAGR:at.portfolioCAGR,afterTaxLiquidatedCAGR:c(liqW),
    spyAfterTaxLiquidatedCAGR:c(spyLiqW),afterTaxExcessVsSpy:c(liqW)!==null&&c(spyLiqW)!==null?c(liqW)-c(spyLiqW):null,
    taxDragPerYear:pre.portfolioCAGR!==null&&c(liqW)!==null?pre.portfolioCAGR-c(liqW):null,unrealizedTaxAtEnd:liqTax};
}
// helpers: {adjustedReturnBetween, portfolioStats, dailyPortfolioRisk?}
function simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,opts,helpers){
  const {name,entry='shortlist',sizing='conviction',maxPositions=RP.SIZING.maxPositions,maxRank=RP.ENTRY.maxRank,transactionCostBps=10,trim=true,thesisBreak='review',rankOpts={},entryOpts={},garp=false,sellRule=RP.SELL.rule,tax=TAX}=opts||{};
  const {adjustedReturnBetween,portfolioStats}=helpers;
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  let weights=new Map(),cash=1;               // fractions of portfolio; cash is held in SPY
  const prevRow=new Map();                    // ticker -> row at the previous review
  const memo=new Map();                       // ticker -> thesis memo {streak, entryEPS} while held (Build 62)
  const periods=[],sellReasons={},soldLog=[];let buys=0,sells=0,trims=0;
  const targetOf=r=>sizing==='equal'?1/maxPositions:RP.targetWeight(r);
  // Build 74: tax lots. lots: ticker -> [{date,basis,value}] in the same portfolio-fraction units as weights.
  const lots=new Map();let lossCarry=0,taxPaidTotal=0,stGainsTotal=0,ltGainsTotal=0;
  const realize=(t,f,asOf,acc)=>{const L=lots.get(t)||[];for(const l of L){const g=f*(l.value-l.basis);const days=(Date.parse(asOf)-Date.parse(l.date))/864e5;if(days>=365)acc.lt+=g;else acc.st+=g;l.value*=1-f;l.basis*=1-f;}if(f>=1-1e-9)lots.delete(t);};
  const pegOf=r=>{const p=RP.pegOf(r);return p&&p.peg!==null?p.peg:Infinity;};
  const canEnter=r=>entry==='peg'?RP.pegEntry(r,entryOpts):entry==='buyRated'?RP.entryEligible(r)&&shortlistEligible(r,{maxRank:Infinity}):shortlistEligible(r,{maxRank,...entryOpts});
  for(let i=0;i<snaps.length-1;i++){
    const snap=snaps[i],next=snaps[i+1];
    const rows=liveRankedRows(snap.rows,rankOpts);
    const rowMap=new Map(rows.map(r=>[r.ticker,r]));
    let turnover=0;const acc={st:0,lt:0};
    const us=rows.map(r=>finite(r.underwrittenCAGR??r.expectedCAGR)).filter(x=>x!==null).sort((a,b)=>a-b);
    const marketMedian=us.length?us[us.length>>1]:null;
    // 1) review existing holdings
    for(const [t,w] of [...weights]){
      const r=rowMap.get(t),p=prevRow.get(t);
      let reason=null;
      if(!r) reason='left_universe_or_unmodeled';
      else{
        const m=memo.get(t)||{};
        const st=RP.holdingStatus(r,{...(p?{u:finite(p.underwrittenCAGR??p.expectedCAGR),q:finite(p.qualityScore),peg:RP.pegOf(p)?.peg??null}:{}),streak:m.streak,entryEPS:m.entryEPS,entryQ:m.entryQ},{weight:w,thesisBreak,sellRule,marketMedian});
        if(st.memo)memo.set(t,{streak:st.memo.streak,entryEPS:st.memo.entryEPS,entryQ:m.entryQ,halved:st.status==='Trim half'?(m.halved||false):false});
        if(st.status==='Trim half'&&!m.halved){const cut=w/2;realize(t,.5,snap.asOf,acc);weights.set(t,w-cut);cash+=cut;turnover+=cut;trims++;memo.set(t,{...memo.get(t),halved:true});continue;}
        if(st.status==='Sell candidate') reason=(finite(r.qualityScore)??100)<RP.BANDS.sellQuality?'quality_below_sell_floor':(st.reasons.some(x=>/^Business shrinking/.test(x))?'thesis_broken_business_shrinking':'low_return_two_reviews');
      }
      if(reason){realize(t,1,snap.asOf,acc);weights.delete(t);memo.delete(t);cash+=w;turnover+=w;sells++;soldLog.push({ticker:t,asOf:snap.asOf,reason});sellReasons[reason]=(sellReasons[reason]||0)+1;continue;}
      if(trim&&w>RP.SIZING.trimAbove){const cut=w-RP.SIZING.trimTo;realize(t,cut/w,snap.asOf,acc);weights.set(t,RP.SIZING.trimTo);cash+=cut;turnover+=cut;trims++;}
    }
    // 2) buy: top up qualifying holdings first, then new names in rank order
    const sectorOf=t=>String((rowMap.get(t)||{}).sector||'Unknown');
    const sectorW=k=>{let s=0;for(const [t,w] of weights)if(sectorOf(t)===k)s+=w;return s;};
    const buy=(r)=>{
      const cur=weights.get(r.ticker)||0,target=targetOf(r);
      const room=Math.max(0,RP.SIZING.sectorCapAtPurchase-sectorW(String(r.sector||'Unknown')));
      const amt=Math.min(cash,Math.max(0,target-cur),room);
      if(amt<RP.SIZING.minTrade)return false;
      weights.set(r.ticker,cur+amt);cash-=amt;turnover+=amt;{const L=lots.get(r.ticker)||[];L.push({date:snap.asOf,basis:amt,value:amt});lots.set(r.ticker,L);}if(!cur){buys++;const rg=finite(r.revenueGrowthTTM);memo.set(r.ticker,{streak:rg!==null&&rg<0?1:0,entryEPS:finite(r.forwardEPS),entryQ:finite(r.qualityScore)});}return true;
    };
    for(const t of [...weights.keys()]){const r=rowMap.get(t);if(r&&canEnter(r))buy(r);}
    const heldFam=new Set([...weights.keys()].map(family));
    // GARP arm buys the highest underwritten return first; the others buy in model-rank order.
    const ret=r=>finite(r.underwrittenCAGR)??finite(r.expectedCAGR)??-1;
    const cands=rows.filter(r=>canEnter(r)&&!heldFam.has(family(r.ticker))).sort(entry==='peg'?(a,b)=>pegOf(a)-pegOf(b):garp?(a,b)=>ret(b)-ret(a):(a,b)=>a.liveRank-b.liveRank);
    for(const r of cands){
      if(weights.size>=maxPositions||cash<RP.SIZING.minTrade)break;
      if(heldFam.has(family(r.ticker)))continue;
      if(buy(r))heldFam.add(family(r.ticker));
    }
    for(const r of rows)prevRow.set(r.ticker,r);
    // 3) hold until next review
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,next.asOf,{executeAfterStart:true});
    if(!spy)continue;
    let gross=cash*spy.return,end=cash*(1+spy.return);
    const holdingsAtStart=weights.size,maxW=weights.size?Math.max(...weights.values()):0,cashAtStart=cash;
    const held=[];
    for(const [t,w] of [...weights]){
      const x=adjustedReturnBetween(historyByTicker.get(t)||[],snap.asOf,next.asOf,{executeAfterStart:true});
      const rr=x?x.return:0;gross+=w*rr;const e=w*(1+rr);weights.set(t,e);end+=e;held.push([t,w,rr,!!x]);for(const l of (lots.get(t)||[]))l.value*=1+rr;
    }
    cash=cash*(1+spy.return);
    if(end>0){for(const [t,w] of weights)weights.set(t,w/end);cash/=end;for(const L of lots.values())for(const l of L){l.value/=end;l.basis/=end;}}
    const cost=turnover*transactionCostBps/10000;
    // Tax on this review's sales: short- and long-term net against each other, then against carried losses.
    let st=acc.st,lt=acc.lt;stGainsTotal+=st;ltGainsTotal+=lt;
    if(st<0&&lt>0){const o=Math.min(-st,lt);st+=o;lt-=o;}else if(lt<0&&st>0){const o=Math.min(-lt,st);lt+=o;st-=o;}
    if(st<0){lossCarry+=-st;st=0;}if(lt<0){lossCarry+=-lt;lt=0;}
    {const o=Math.min(lossCarry,st);st-=o;lossCarry-=o;}{const o=Math.min(lossCarry,lt);lt-=o;lossCarry-=o;}
    const taxPaid=st*tax.shortTerm+lt*tax.longTerm;taxPaidTotal+=taxPaid;
    periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:holdingsAtStart,cashWeight:cashAtStart,maxHoldingWeight:maxW,turnover,portfolioReturn:gross-cost,afterTaxReturn:gross-cost-taxPaid,taxPaid,spyReturn:spy.return,held});
  }
  const stats=portfolioStats(periods,{periodsPerYear:4});
  const afterTax=afterTaxSummary(periods,lots,lossCarry,tax,portfolioStats);
  return {name,entry,sizing,maxPositions,maxRank,transactionCostBps,trim,sellRule,...stats,afterTax,taxPaidTotal,shortTermGains:stGainsTotal,longTermGains:ltGainsTotal,
    averageHoldings:mean(periods.map(p=>p.holdings)),averageCash:mean(periods.map(p=>p.cashWeight)),
    annualTurnover:(mean(periods.map(p=>p.turnover))||0)*4,buys,sells,trims,sellReasons,thesisBreak,
    thesisBreakSells:soldLog.filter(x=>x.reason==='thesis_broken_business_shrinking')};
}

// Mechanical control: equal-weight the top N live-ranked names every quarter.
function simulateMechanicalTopN(snapshotOutput,historyByTicker,spyHistory,{name,topN=20,transactionCostBps=10}={},helpers){
  const {adjustedReturnBetween,portfolioStats}=helpers;
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  const periods=[];let prev=new Set();
  for(let i=0;i<snaps.length-1;i++){
    const snap=snaps[i],next=snaps[i+1];
    const rows=liveRankedRows(snap.rows).filter(r=>finite(r.liveRank)!==null).sort((a,b)=>a.liveRank-b.liveRank);
    const picks=[],fam=new Set();for(const r of rows){if(fam.has(family(r.ticker)))continue;fam.add(family(r.ticker));picks.push(r);if(picks.length>=topN)break;}
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,next.asOf,{executeAfterStart:true});if(!spy||!picks.length)continue;
    const xs=picks.map(r=>adjustedReturnBetween(historyByTicker.get(r.ticker)||[],snap.asOf,next.asOf,{executeAfterStart:true}));
    const rets=xs.map(x=>x?x.return:0);
    const held=picks.map((r,j)=>[r.ticker,1/picks.length,rets[j],!!xs[j]]);
    const now=new Set(picks.map(r=>r.ticker));const changed=[...now].filter(t=>!prev.has(t)).length/now.size;prev=now;
    periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:picks.length,portfolioReturn:mean(rets)-changed*2*transactionCostBps/10000,spyReturn:spy.return,turnover:changed,held});
  }
  return {name,topN,...portfolioStats(periods,{periodsPerYear:4})};
}

// Build 65: Growth Inflection rows for a snapshot: valued rows plus growth-only rows (companies the value
// model cannot value, e.g. unprofitable after stock pay). Scored fresh each quarter, point-in-time.
const GE=require('./engine/growth-engine');
// Build 68b variants (only narrow the Build 65 list; the stored rows were built with the live switches off):
//   cyclical: drop names whose revenue fell >15% in a year of the last 4
//   durable:  require 3-yr revenue CAGR >= 10%, score with durable-growth weights
//   price:    durable + price/sales <= 20 (market cap / last fiscal-year revenue)
function growthVariantOk(r,v){
  const g=r.growth;if(!v)return true;
  const cyc=g.cyclical===true||(Number.isFinite(g.worstRevenueDrop)&&g.worstRevenueDrop<GE.GROWTH.maxRevenueDrop);
  const dur=g.lastingGrowth===true||(Number.isFinite(g.durableGrowth)&&g.durableGrowth>=GE.GROWTH.minDurableGrowth);
  if(v==='cyclical')return !cyc;
  if(v==='durable')return dur;
  if(v==='price'){const ps=finite(r.marketCap)>0&&finite(g.revenue)>0?r.marketCap/g.revenue:null;return dur&&ps!=null&&ps<=20;}
  return true;
}
function growthRows(snap,variant=null){
  const rows=[...(snap.rows||[]),...(snap.growthOnlyRows||[])].filter(r=>r&&r.growth).map(r=>({...r,growth:{...r.growth}}));
  for(const r of rows)if(r.growth.eligible&&!growthVariantOk(r,variant))r.growth.eligible=false;
  GE.scoreGrowthUniverse(rows,{field:'growth',weights:variant==='durable'||variant==='price'?GE.GROWTH.durableWeights:GE.GROWTH.weights});
  return rows.filter(r=>r.growth.eligible).sort((a,b)=>a.growth.rank-b.growth.rank);
}
// Growth sleeve: buy the top N by growth score, equal weight; keep a holding while it stays in the top
// keepRank AND passes the exit rule (growth >= 10%, 12-1 momentum >= 0, top half of growth names).
function simulateGrowthSleeve(snapshotOutput,historyByTicker,spyHistory,{name,topN=10,keepRank=25,transactionCostBps=10,variant=null}={},helpers){
  const {adjustedReturnBetween,portfolioStats}=helpers;
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  const periods=[];let held=[];const sells=[];
  for(let i=0;i<snaps.length-1;i++){
    const snap=snaps[i],next=snaps[i+1];
    const rows=growthRows(snap,variant), byT=new Map(rows.map(r=>[r.ticker,r]));
    const keep=[];
    for(const t of held){const r=byT.get(t);const ex=r?GE.growthExit(r.growth):{exit:true,reason:'no longer a growth company'};
      if(r&&!ex.exit&&r.growth.rank<=keepRank)keep.push(t);else sells.push({asOf:snap.asOf,ticker:t,reason:r&&!ex.exit?'dropped out of top '+keepRank:ex.reason});}
    const fam=new Set(keep.map(family));
    for(const r of rows){if(keep.length>=topN)break;if(keep.includes(r.ticker)||fam.has(family(r.ticker)))continue;if(GE.growthExit(r.growth).exit)continue;keep.push(r.ticker);fam.add(family(r.ticker));}
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,next.asOf,{executeAfterStart:true});if(!spy)continue;
    if(!keep.length){periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:0,portfolioReturn:spy.return,spyReturn:spy.return,cashWeight:1,held:[]});held=keep;continue;}
    const xs=keep.map(t=>adjustedReturnBetween(historyByTicker.get(t)||[],snap.asOf,next.asOf,{executeAfterStart:true}));
    const rets=xs.map(x=>x?x.return:0);
    const changed=keep.filter(t=>!held.includes(t)).length/keep.length;
    periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:keep.length,portfolioReturn:mean(rets)-changed*2*transactionCostBps/10000,spyReturn:spy.return,turnover:changed,
      held:keep.map((t,j)=>[t,1/keep.length,rets[j],!!xs[j]])});
    held=keep;
  }
  return {name,topN,keepRank,growthSells:sells.slice(-60),...portfolioStats(periods,{periodsPerYear:4})};
}
// A fixed-weight blend of two arms' quarterly returns (e.g. 70% value rules + 30% growth sleeve).
function blendArms(name,a,b,wa,helpers){
  const byQ=new Map((b.periods||[]).map(p=>[p.asOf,p]));
  const periods=(a.periods||[]).filter(p=>byQ.has(p.asOf)).map(p=>{const q=byQ.get(p.asOf);
    return {asOf:p.asOf,startYear:p.startYear,portfolioReturn:wa*p.portfolioReturn+(1-wa)*q.portfolioReturn,spyReturn:p.spyReturn,
      held:[...(p.held||[]).map(([t,w,r,ok])=>[t,w*wa,r,ok]),...(q.held||[]).map(([t,w,r,ok])=>[t,w*(1-wa),r,ok])]};});
  return {name,...helpers.portfolioStats(periods,{periodsPerYear:4}),periods};
}
// Signal check for the growth score: do higher growth ranks earn more afterwards?
function growthBucketOutcomes(snapshotOutput){
  const buckets=[['growth 1-10',1,10],['growth 11-30',11,30],['growth 31+',31,Infinity]];
  const all=[],nonGrowth=[];
  for(const snap of snapshotOutput||[]){const g=growthRows(snap);all.push(...g);const set=new Set(g.map(r=>r.ticker));nonGrowth.push(...(snap.rows||[]).filter(r=>!set.has(r.ticker)));}
  const out={};
  for(const n of [1,3]){
    const k=`excess${n}YTotalReturnCAGR`;
    const stat=(label,v)=>({bucket:label,n:v.length,meanExcess:mean(v.map(r=>r[k])),medianExcess:median(v.map(r=>r[k])),beatSpyRate:v.length?v.filter(r=>r[k]>0).length/v.length:null});
    out[`${n}Y`]=[...buckets.map(([label,lo,hi])=>stat(label,all.filter(r=>r.growth.rank>=lo&&r.growth.rank<=hi&&finite(r[k])!==null))),
      stat('not a growth company',nonGrowth.filter(r=>finite(r[k])!==null))];
  }
  return out;
}

// Equal-weight every modeled stock each quarter: "did picking beat owning the whole list?"
function simulateUniverseEqualWeight(snapshotOutput,historyByTicker,spyHistory,helpers){
  const {adjustedReturnBetween,portfolioStats}=helpers;
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  const periods=[];
  for(let i=0;i<snaps.length-1;i++){
    const snap=snaps[i],next=snaps[i+1];
    const spy=adjustedReturnBetween(spyHistory,snap.asOf,next.asOf,{executeAfterStart:true});if(!spy)continue;
    const rets=(snap.rows||[]).map(r=>{const x=adjustedReturnBetween(historyByTicker.get(r.ticker)||[],snap.asOf,next.asOf,{executeAfterStart:true});return x?x.return:null;}).filter(Number.isFinite);
    if(!rets.length)continue;
    periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:rets.length,portfolioReturn:mean(rets),spyReturn:spy.return});
  }
  return {name:'Benchmark · every modeled stock, equal weight',...portfolioStats(periods,{periodsPerYear:4})};
}

// Signal check: do better live ranks earn more afterwards? (stock-level, total-return excess vs SPY)
function rankBucketOutcomes(snapshotOutput){
  const buckets=[['1-20',1,20],['21-50',21,50],['51-100',51,100],['101-250',101,250],['251+',251,Infinity]];
  const all=[];
  for(const snap of snapshotOutput||[])for(const r of liveRankedRows(snap.rows))all.push(r);
  const out={};
  for(const n of [1,3,5]){
    const k=`excess${n}YTotalReturnCAGR`,real=`realized${n}YTotalReturnCAGR`;
    out[`${n}Y`]=buckets.map(([label,lo,hi])=>{
      const v=all.filter(r=>finite(r.liveRank)!==null&&r.liveRank>=lo&&r.liveRank<=hi&&finite(r[k])!==null);
      return {bucket:label,n:v.length,meanExcess:mean(v.map(r=>r[k])),medianExcess:median(v.map(r=>r[k])),beatSpyRate:v.length?v.filter(r=>r[k]>0).length/v.length:null,medianRealized:median(v.map(r=>r[real]))};
    });
  }
  return out;
}

// Build 61: where did the returns come from? For each arm: every stock's contribution (start weight x
// quarterly return, summed over quarters), its contribution versus SPY (what it added over just holding
// SPY with that money), and the strategy's return if its biggest winners had only earned SPY.
function attribution(periods,H,{splitYear=2022}={}){
  const per=new Map();
  for(const p of periods||[])for(const [t,w,r,priced] of (p.held||[])){
    const a=per.get(t)||{ticker:t,quarters:0,weightSum:0,contribution:0,excessContribution:0,growth:1,first:p.asOf,last:p.asOf,missingPriceQuarters:0};
    a.quarters++;a.weightSum+=w;a.contribution+=w*r;a.excessContribution+=w*(r-p.spyReturn);a.growth*=1+r;a.last=p.asOf;if(!priced)a.missingPriceQuarters++;
    per.set(t,a);
  }
  const rows=[...per.values()].map(a=>({ticker:a.ticker,quarters:a.quarters,avgWeight:a.weightSum/a.quarters,
    returnWhileHeld:a.growth-1,contribution:a.contribution,excessContribution:a.excessContribution,first:a.first,last:a.last,missingPriceQuarters:a.missingPriceQuarters}))
    .sort((x,y)=>y.excessContribution-x.excessContribution);
  const totalExcess=rows.reduce((s,r)=>s+r.excessContribution,0);
  const statsFor=ps=>{const all=H.portfolioStats(ps,{periodsPerYear:4}),d=H.portfolioStats(ps.filter(p=>p.startYear<splitYear),{periodsPerYear:4}),v=H.portfolioStats(ps.filter(p=>p.startYear>=splitYear),{periodsPerYear:4});
    return {portfolioCAGR:all.portfolioCAGR,annualizedExcess:all.annualizedExcess,developmentExcess:d.annualizedExcess,validationExcess:v.annualizedExcess};};
  const withoutTop={};
  for(const k of [1,3,5,10]){
    const drop=new Set(rows.slice(0,k).map(r=>r.ticker));
    const ps=(periods||[]).map(p=>({...p,portfolioReturn:p.portfolioReturn-(p.held||[]).filter(h=>drop.has(h[0])).reduce((s,h)=>s+h[1]*(h[2]-p.spyReturn),0)}));
    withoutTop[k]={removed:[...drop],...statsFor(ps)};
  }
  const r4=x=>Number.isFinite(x)?Math.round(x*10000)/10000:x;
  const slim=r=>({...r,avgWeight:r4(r.avgWeight),returnWhileHeld:r4(r.returnWhileHeld),contribution:r4(r.contribution),excessContribution:r4(r.excessContribution)});
  return {
    note:'contribution = sum over quarters of (start weight x quarterly return); excessContribution = same versus SPY. withoutTop[k]: the arm with its k biggest excess contributors earning SPY instead.',
    distinctStocks:rows.length,totalExcessContribution:r4(totalExcess),
    topShareOfExcess:Object.fromEntries([1,3,5,10].map(k=>[k,totalExcess>0?r4(rows.slice(0,k).reduce((s,r)=>s+r.excessContribution,0)/totalExcess):null])),
    topContributors:rows.slice(0,15).map(slim),bottomContributors:rows.slice(-8).reverse().map(slim),withoutTop
  };
}
function holdingsCsvRows(arm){
  const out=[];
  for(const p of arm.periods||[])for(const [t,w,r,priced] of (p.held||[]))
    out.push([JSON.stringify(arm.name),p.asOf,t,w.toFixed(4),r.toFixed(4),p.spyReturn.toFixed(4),(w*r).toFixed(5),(w*(r-p.spyReturn)).toFixed(5),priced?'':'no_price'].join(','));
  return out;
}

const KEEP=['portfolioCAGR','spyCAGR','annualizedExcess','annualVolatility','periodEndMaxDrawdown','beatSpyRate','periodCount','yearCount','finalWealth10k','spyFinalWealth10k'];
function compact(s){
  if(!s)return null;
  const o={};for(const k of ['name','entry','sizing','maxPositions','topN','keepRank','growthSells','averageHoldings','averageCash','annualTurnover','buys','sells','trims','sellReasons','thesisBreak','thesisBreakSells','vsEqualWeightUniverse','sellRule','afterTax','afterTaxSplit','taxPaidTotal','shortTermGains','longTermGains'])if(s[k]!==undefined)o[k]=s[k];
  for(const k of KEEP)if(s[k]!==undefined)o[k]=s[k];
  for(const k of ['development','validation'])if(s[k])o[k]=Object.fromEntries(KEEP.filter(x=>s[k][x]!==undefined).map(x=>[x,s[k][x]]));
  if(s.attribution)o.attribution=s.attribution;
  // Build 61: compact holdings per quarter: [ticker, start weight, quarterly return], 4 decimals.
  if(Array.isArray(s.periods))o.holdingsByQuarter=s.periods.map(p=>({quarterStart:p.asOf,spyReturn:Math.round(p.spyReturn*1e4)/1e4,cash:Number.isFinite(p.cashWeight)?Math.round(p.cashWeight*1e4)/1e4:undefined,
    holdings:(p.held||[]).map(([t,w,r])=>[t,Math.round(w*1e4)/1e4,Math.round(r*1e4)/1e4])}));
  return o;
}

// How many names pass each entry gate per quarter. If almost nothing qualifies, the owner arms are
// mostly SPY and say little about the model; this makes that visible instead of hiding it.
function entryFunnel(snapshotOutput){
  const per=[];
  for(const snap of snapshotOutput||[]){
    const rows=liveRankedRows(snap.rows);
    const u=r=>finite(r.underwrittenCAGR??r.expectedCAGR),q=r=>finite(r.qualityScore);
    const ret=rows.filter(r=>(u(r)??-1)>=RP.SIZING.hurdle),qual=ret.filter(r=>(q(r)??0)>=RP.BANDS.reviewQuality);
    per.push({asOf:snap.asOf,modeled:rows.length,returnAboveHurdle:ret.length,plusQuality75:qual.length,
      shortlistEligible:rows.filter(r=>shortlistEligible(r)).length,buyRated:rows.filter(r=>['Buy','Strong Buy','Exceptional Buy'].includes(r.rating)).length,
      buyRatedEntryEligible:rows.filter(r=>RP.entryEligible(r)&&shortlistEligible(r,{maxRank:Infinity})).length,pegEligible:rows.filter(r=>RP.pegEntry(r)).length});
  }
  const keys=['modeled','returnAboveHurdle','plusQuality75','shortlistEligible','buyRated','buyRatedEntryEligible','pegEligible'];
  const summary=Object.fromEntries(keys.map(k=>{const v=per.map(x=>x[k]);return [k,{median:median(v),min:v.length?Math.min(...v):null,max:v.length?Math.max(...v):null}];}));
  return {summary,byQuarter:per};
}

function buildOwnerStrategyLab(snapshotOutput,historyByTicker,spyHistory,helpers,{splitYear=2022,transactionCostBps=10}={}){
  const H=helpers;
  const split=s=>{
    const ps=s.periods||[];
    s.development={...H.portfolioStats(ps.filter(p=>p.startYear<splitYear),{periodsPerYear:4})};
    s.validation={...H.portfolioStats(ps.filter(p=>p.startYear>=splitYear),{periodsPerYear:4})};
    // Build 74: excess after taxes paid along the way (no end-of-period liquidation), per period.
    if(ps.some(p=>Number.isFinite(p.afterTaxReturn))){const at=x=>x.map(p=>({...p,portfolioReturn:p.afterTaxReturn??p.portfolioReturn}));
      const d=H.portfolioStats(at(ps.filter(p=>p.startYear<splitYear)),{periodsPerYear:4}),v=H.portfolioStats(at(ps.filter(p=>p.startYear>=splitYear)),{periodsPerYear:4});
      s.afterTaxSplit={developmentExcess:d.annualizedExcess??null,validationExcess:v.annualizedExcess??null};}
    return s;
  };
  const universe=split(simulateUniverseEqualWeight(snapshotOutput,historyByTicker,spyHistory,H));
  const arms=[
    simulateMechanicalTopN(snapshotOutput,historyByTicker,spyHistory,{name:'A · Mechanical top 20, equal weight, rebalanced quarterly',topN:20,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'B · Owner rules, shortlist entry, equal weight, max 15',entry:'shortlist',sizing:'equal',maxPositions:15,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'C · Owner rules, shortlist entry, conviction sizing, max 15 (app default)',entry:'shortlist',sizing:'conviction',maxPositions:15,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'C+ · Same as C WITH the experimental thesis-broken auto-sell (Build 62)',entry:'shortlist',sizing:'conviction',maxPositions:15,transactionCostBps,thesisBreak:'sell'},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'D · Owner rules, Buy-rated entry only, conviction sizing, max 15',entry:'buyRated',sizing:'conviction',maxPositions:15,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'E · Concentrated: conviction sizing, max 10',entry:'shortlist',sizing:'conviction',maxPositions:10,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'F · Diversified: conviction sizing, max 25',entry:'shortlist',sizing:'conviction',maxPositions:25,transactionCostBps},H),
  ];
  // Build 65: Growth Inflection sleeve, and the 70/30 value + growth portfolio the app suggests.
  const G=simulateGrowthSleeve(snapshotOutput,historyByTicker,spyHistory,{name:'G · Growth Inflection: top 10 by growth score, equal weight, exit rule',topN:10,keepRank:25,transactionCostBps},H);
  const Cbase=arms.find(a=>a.name.startsWith('C ·'));
  arms.push(G, blendArms('H · 70% arm C (value rules) + 30% arm G (growth sleeve)',Cbase,G,.7,H));
  // Build 72: entry-rule variants of arm C (same sizing, holds and sells). Decision rule fixed in advance in
  // README-build72: adopt a variant only if it beats C in BOTH periods and overall.
  {const V=(name,o)=>simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name,entry:'shortlist',sizing:'conviction',maxPositions:15,transactionCostBps,...o},H);
   arms.push(V('C35 · C with the top-35 rank cutoff',{maxRank:35}),
     V('C50 · C with the top-50 rank cutoff',{maxRank:50}),
     V('CW · C skipping split valuations and cyclicals at a peak',{entryOpts:{blockSplit:true,blockCycleAtPeak:true}}),
     V('CQ · C with quality 80+',{entryOpts:{minQuality:80}}),
     V('C35W · top-35 cutoff + warning blocks',{maxRank:35,entryOpts:{blockSplit:true,blockCycleAtPeak:true}}),
     V('CG · GARP: quality 75+, revenue growth 10%+, return 9%+, any rank; best return first',{maxRank:Infinity,garp:true,entryOpts:{minReturn:RP.GARP.minReturn,minQuality:RP.GARP.minQuality,minGrowth:RP.GARP.minGrowth}}));}
  // Build 75: 5-year PEG (the model's own EPS path, identical live and here) and sell-rule variants.
  // Build 74's CP/CPQ/CPR/CR/CSQ/CGR were read and retired. Decision rule fixed in advance in README-build75.
  {const V=(name,o)=>simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name,entry:'shortlist',sizing:'conviction',maxPositions:15,transactionCostBps,...o},H);
   arms.push(V('CS2 · C selling half at the first low reading, the rest at the second',{sellRule:'staged'}),
     V('CB · C, price sell only when BOTH checks agree (return < 6.5% AND 5-yr PEG > 2.5)',{sellRule:'both'}),
     V('CBS · CB, selling half first, the rest at the second reading',{sellRule:'bothStaged'}),
     V('CP5 · 5-yr PEG list: quality 75+, revenue growth 10%+, PEG <= 1.5, cheapest first, equal weight; both-agree sell',{entry:'peg',sizing:'equal',maxRank:Infinity,sellRule:'both'}),
     V('CP5S · CP5 selling half first, the rest at the second reading',{entry:'peg',sizing:'equal',maxRank:Infinity,sellRule:'bothStaged'}));}
  // Build 68b: growth-list alternatives, same sleeve rules. Compare with G before switching anything on live.
  arms.push(simulateGrowthSleeve(snapshotOutput,historyByTicker,spyHistory,{name:'G1 · Growth sleeve without cyclicals',topN:10,keepRank:25,transactionCostBps,variant:'cyclical'},H),
    simulateGrowthSleeve(snapshotOutput,historyByTicker,spyHistory,{name:'G2 · Growth sleeve, lasting growth only (Build 68 rule)',topN:10,keepRank:25,transactionCostBps,variant:'durable'},H),
    simulateGrowthSleeve(snapshotOutput,historyByTicker,spyHistory,{name:'G3 · Lasting growth + price/sales <= 20',topN:10,keepRank:25,transactionCostBps,variant:'price'},H));
  arms.forEach(split);
  for(const a of arms)a.attribution=attribution(a.periods,H,{splitYear});
  const csvRows=['arm,quarterStart,ticker,startWeight,quarterReturn,spyReturn,contribution,excessContribution,flag',...arms.flatMap(holdingsCsvRows)];
  for(const a of arms)a.vsEqualWeightUniverse=Number.isFinite(a.portfolioCAGR)&&Number.isFinite(universe.portfolioCAGR)?a.portfolioCAGR-universe.portfolioCAGR:null;
  return {
    description:'Build 36 owner strategy lab. Uses the live ranking, the app review statuses and the app sizing rules. Idle cash earns SPY. Analyst estimates are unavailable historically, so the analyst-based parts of the live model are NOT tested here. Development = before '+splitYear+', validation = '+splitYear+' onward. Read once; do not tune to it.',
    passFail:{
      question1:'Do live ranks 1-20 beat ranks 251+ on 1Y and 3Y excess return? (rankBuckets)',
      question2:'Does arm C beat both SPY and the equal-weight universe, in development AND validation?',
      question3:'Does conviction sizing (C) beat equal weight (B)? Does concentration (E vs C vs F) help or just add volatility?',
      question4:'Build 62b: does the experimental thesis-broken auto-sell (C+) beat the default review-only rules (C)? See thesisBreakSells.',
      question5:'Build 65: do growth ranks 1-10 beat 31+ and non-growth stocks (growthBuckets)? Does G beat SPY in development AND validation, and does H beat C?'
    },
    entryFunnel:entryFunnel(snapshotOutput),
    rankBuckets:rankBucketOutcomes(snapshotOutput),
    growthBuckets:growthBucketOutcomes(snapshotOutput),
    benchmarks:{equalWeightUniverse:compact(universe)},
    arms:arms.map(compact),
    holdingsCsv:csvRows.join('\n')
  };
}

module.exports={TAX,afterTaxSummary,growthRows,simulateGrowthSleeve,blendArms,growthBucketOutcomes,attribution,holdingsCsvRows,entryFunnel,liveRankedRows,shortlistEligible,simulateOwnerStrategy,simulateMechanicalTopN,simulateUniverseEqualWeight,rankBucketOutcomes,buildOwnerStrategyLab};
