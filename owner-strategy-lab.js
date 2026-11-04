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

function liveRankedRows(rows){
  const c=(rows||[]).map(r=>({...r}));
  applyModelDRanking(c,{rankField:'liveRank',universeSizeField:null,reliability:true});
  return c;
}

function shortlistEligible(r,{maxRank=20}={}){
  const u=finite(r?.underwrittenCAGR??r?.expectedCAGR),q=finite(r?.qualityScore);
  return !!r&&r.rating!=='Unrated'&&finite(r.liveRank)!==null&&r.liveRank<=maxRank&&u!==null&&u>=RP.SIZING.hurdle&&q!==null&&q>=RP.BANDS.reviewQuality;
}

// helpers: {adjustedReturnBetween, portfolioStats, dailyPortfolioRisk?}
function simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,opts,helpers){
  const {name,entry='shortlist',sizing='conviction',maxPositions=RP.SIZING.maxPositions,maxRank=20,transactionCostBps=10,trim=true}=opts||{};
  const {adjustedReturnBetween,portfolioStats}=helpers;
  const snaps=[...(snapshotOutput||[])].sort((a,b)=>String(a.asOf).localeCompare(String(b.asOf)));
  let weights=new Map(),cash=1;               // fractions of portfolio; cash is held in SPY
  const prevRow=new Map();                    // ticker -> row at the previous review
  const periods=[],sellReasons={};let buys=0,sells=0,trims=0;
  const targetOf=r=>sizing==='equal'?1/maxPositions:RP.targetWeight(r);
  const canEnter=r=>entry==='buyRated'?RP.entryEligible(r)&&shortlistEligible(r,{maxRank:Infinity}):shortlistEligible(r,{maxRank});
  for(let i=0;i<snaps.length-1;i++){
    const snap=snaps[i],next=snaps[i+1];
    const rows=liveRankedRows(snap.rows);
    const rowMap=new Map(rows.map(r=>[r.ticker,r]));
    let turnover=0;
    // 1) review existing holdings
    for(const [t,w] of [...weights]){
      const r=rowMap.get(t),p=prevRow.get(t);
      let reason=null;
      if(!r) reason='left_universe_or_unmodeled';
      else{
        const st=RP.holdingStatus(r,p?{u:finite(p.underwrittenCAGR??p.expectedCAGR),q:finite(p.qualityScore)}:null,{weight:w});
        if(st.status==='Sell candidate') reason=(finite(r.qualityScore)??100)<RP.BANDS.sellQuality?'quality_below_sell_floor':'low_return_two_reviews';
      }
      if(reason){weights.delete(t);cash+=w;turnover+=w;sells++;sellReasons[reason]=(sellReasons[reason]||0)+1;continue;}
      if(trim&&w>RP.SIZING.trimAbove){const cut=w-RP.SIZING.trimTo;weights.set(t,RP.SIZING.trimTo);cash+=cut;turnover+=cut;trims++;}
    }
    // 2) buy: top up qualifying holdings first, then new names in rank order
    const sectorOf=t=>String((rowMap.get(t)||{}).sector||'Unknown');
    const sectorW=k=>{let s=0;for(const [t,w] of weights)if(sectorOf(t)===k)s+=w;return s;};
    const buy=(r)=>{
      const cur=weights.get(r.ticker)||0,target=targetOf(r);
      const room=Math.max(0,RP.SIZING.sectorCapAtPurchase-sectorW(String(r.sector||'Unknown')));
      const amt=Math.min(cash,Math.max(0,target-cur),room);
      if(amt<RP.SIZING.minTrade)return false;
      weights.set(r.ticker,cur+amt);cash-=amt;turnover+=amt;if(!cur)buys++;return true;
    };
    for(const t of [...weights.keys()]){const r=rowMap.get(t);if(r&&canEnter(r))buy(r);}
    const heldFam=new Set([...weights.keys()].map(family));
    const cands=rows.filter(r=>canEnter(r)&&!heldFam.has(family(r.ticker))).sort((a,b)=>a.liveRank-b.liveRank);
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
    for(const [t,w] of [...weights]){
      const x=adjustedReturnBetween(historyByTicker.get(t)||[],snap.asOf,next.asOf,{executeAfterStart:true});
      const rr=x?x.return:0;gross+=w*rr;const e=w*(1+rr);weights.set(t,e);end+=e;
    }
    cash=cash*(1+spy.return);
    if(end>0){for(const [t,w] of weights)weights.set(t,w/end);cash/=end;}
    const cost=turnover*transactionCostBps/10000;
    periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:holdingsAtStart,cashWeight:cashAtStart,maxHoldingWeight:maxW,turnover,portfolioReturn:gross-cost,spyReturn:spy.return});
  }
  const stats=portfolioStats(periods,{periodsPerYear:4});
  return {name,entry,sizing,maxPositions,maxRank,transactionCostBps,trim,...stats,
    averageHoldings:mean(periods.map(p=>p.holdings)),averageCash:mean(periods.map(p=>p.cashWeight)),
    annualTurnover:(mean(periods.map(p=>p.turnover))||0)*4,buys,sells,trims,sellReasons};
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
    const rets=picks.map(r=>{const x=adjustedReturnBetween(historyByTicker.get(r.ticker)||[],snap.asOf,next.asOf,{executeAfterStart:true});return x?x.return:0;});
    const now=new Set(picks.map(r=>r.ticker));const changed=[...now].filter(t=>!prev.has(t)).length/now.size;prev=now;
    periods.push({asOf:snap.asOf,startYear:Number(String(snap.asOf).slice(0,4)),holdings:picks.length,portfolioReturn:mean(rets)-changed*2*transactionCostBps/10000,spyReturn:spy.return,turnover:changed});
  }
  return {name,topN,...portfolioStats(periods,{periodsPerYear:4})};
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

const KEEP=['portfolioCAGR','spyCAGR','annualizedExcess','annualVolatility','periodEndMaxDrawdown','beatSpyRate','periodCount','yearCount','finalWealth10k','spyFinalWealth10k'];
function compact(s){
  if(!s)return null;
  const o={};for(const k of ['name','entry','sizing','maxPositions','topN','averageHoldings','averageCash','annualTurnover','buys','sells','trims','sellReasons','vsEqualWeightUniverse'])if(s[k]!==undefined)o[k]=s[k];
  for(const k of KEEP)if(s[k]!==undefined)o[k]=s[k];
  for(const k of ['development','validation'])if(s[k])o[k]=Object.fromEntries(KEEP.filter(x=>s[k][x]!==undefined).map(x=>[x,s[k][x]]));
  return o;
}

function buildOwnerStrategyLab(snapshotOutput,historyByTicker,spyHistory,helpers,{splitYear=2022,transactionCostBps=10}={}){
  const H=helpers;
  const split=s=>{
    const ps=s.periods||[];
    s.development={...H.portfolioStats(ps.filter(p=>p.startYear<splitYear),{periodsPerYear:4})};
    s.validation={...H.portfolioStats(ps.filter(p=>p.startYear>=splitYear),{periodsPerYear:4})};
    return s;
  };
  const universe=split(simulateUniverseEqualWeight(snapshotOutput,historyByTicker,spyHistory,H));
  const arms=[
    simulateMechanicalTopN(snapshotOutput,historyByTicker,spyHistory,{name:'A · Mechanical top 20, equal weight, rebalanced quarterly',topN:20,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'B · Owner rules, shortlist entry, equal weight, max 15',entry:'shortlist',sizing:'equal',maxPositions:15,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'C · Owner rules, shortlist entry, conviction sizing, max 15 (app default)',entry:'shortlist',sizing:'conviction',maxPositions:15,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'D · Owner rules, Buy-rated entry only, conviction sizing, max 15',entry:'buyRated',sizing:'conviction',maxPositions:15,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'E · Concentrated: conviction sizing, max 10',entry:'shortlist',sizing:'conviction',maxPositions:10,transactionCostBps},H),
    simulateOwnerStrategy(snapshotOutput,historyByTicker,spyHistory,{name:'F · Diversified: conviction sizing, max 25',entry:'shortlist',sizing:'conviction',maxPositions:25,transactionCostBps},H),
  ].map(split);
  for(const a of arms)a.vsEqualWeightUniverse=Number.isFinite(a.portfolioCAGR)&&Number.isFinite(universe.portfolioCAGR)?a.portfolioCAGR-universe.portfolioCAGR:null;
  return {
    description:'Build 36 owner strategy lab. Uses the live ranking, the app review statuses and the app sizing rules. Idle cash earns SPY. Analyst estimates are unavailable historically, so the analyst-based parts of the live model are NOT tested here. Development = before '+splitYear+', validation = '+splitYear+' onward. Read once; do not tune to it.',
    passFail:{
      question1:'Do live ranks 1-20 beat ranks 251+ on 1Y and 3Y excess return? (rankBuckets)',
      question2:'Does arm C beat both SPY and the equal-weight universe, in development AND validation?',
      question3:'Does conviction sizing (C) beat equal weight (B)? Does concentration (E vs C vs F) help or just add volatility?'
    },
    rankBuckets:rankBucketOutcomes(snapshotOutput),
    benchmarks:{equalWeightUniverse:compact(universe)},
    arms:arms.map(compact)
  };
}

module.exports={liveRankedRows,shortlistEligible,simulateOwnerStrategy,simulateMechanicalTopN,simulateUniverseEqualWeight,rankBucketOutcomes,buildOwnerStrategyLab};
