'use strict';
// Build 97: compact data for the research page summary (rec.research). Display only: nothing here feeds the
// valuation, rating, rank or buy list.
//   technical : trend and buy-zone read from daily prices (50/200-day averages, RSI, 52-week range)
//   earnings  : annual revenue/EPS, recent quarterly revenue growth, last 4 reports vs estimates
//   estimates : how consensus EPS moved (7/30/90 days), analysts revising up vs down, rating mix, up/downgrades
//   scenarios : the assumptions behind the bear, base and bull cases

const fin=x=>Number.isFinite(Number(x))&&x!==null&&x!==''?Number(x):null;
const r4=x=>x===null||!Number.isFinite(x)?null:Math.round(x*1e4)/1e4;
const r2=x=>x===null||!Number.isFinite(x)?null:Math.round(x*100)/100;

function sma(closes,n,end=closes.length){if(end<n)return null;let s=0;for(let i=end-n;i<end;i++)s+=closes[i];return s/n;}
function rsi(closes,n=14){
  if(closes.length<n+1)return null;
  let gain=0,loss=0;
  for(let i=1;i<=n;i++){const d=closes[i]-closes[i-1];if(d>0)gain+=d;else loss-=d;}
  let ag=gain/n,al=loss/n;
  for(let i=n+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(n-1)+Math.max(d,0))/n;al=(al*(n-1)+Math.max(-d,0))/n;}
  if(al===0)return ag===0?50:100;return 100-100/(1+ag/al);
}

// Zone rules (fixed; not backtested; display only):
//   uptrend   = price above the 200-day, 50-day above the 200-day, 200-day rising over the last month
//   downtrend = price below the 200-day and 50-day below the 200-day
//   buy       = uptrend, within -4%..+5% of the 50-day, RSI under 65 (a pullback in an uptrend)
//   extended  = uptrend but more than 10% above the 50-day or RSI over 70
//   oversold  = downtrend with RSI under 30
function technical(history,price){
  const h=(history||[]).filter(x=>fin(x?.close)>0);
  if(h.length<210)return {available:false,reason:'Under 210 trading days of prices'};
  const closes=h.map(x=>Number(x.close));
  const last=fin(price)>0?Number(price):closes.at(-1);
  // Daily history may lag today's quote by a day; use the live price for the levels it's compared with.
  const s50=sma(closes,50),s200=sma(closes,200),s200Prior=sma(closes,200,closes.length-21);
  const year=closes.slice(-252),hi=Math.max(...year),lo=Math.min(...year);
  const rsi14=rsi(closes.slice(-120));
  const above50=last/s50-1,above200=last/s200-1,slope200=s200Prior>0?s200/s200Prior-1:null;
  const up=last>s200&&s50>s200&&slope200>0, down=last<s200&&s50<s200;
  const trend=up?'up':down?'down':'mixed';
  let zone,label;
  if(up&&above50>=-.04&&above50<=.05&&rsi14<65){zone='buy';label='Buy zone: a pullback in an uptrend';}
  else if(up&&(above50>.10||rsi14>70)){zone='extended';label='Extended: up a lot lately, a pullback would be a better entry';}
  else if(up){zone='ok';label='Uptrend, between pullback and stretched';}
  else if(down&&rsi14<30){zone='oversold';label='Downtrend, but oversold: wait for it to steady';}
  else if(down){zone='downtrend';label='Downtrend: no sign of a bottom yet';}
  else if(last>s200){zone='recovering';label='Recovering: back above its 200-day average';}
  else {zone='below200';label='Below its 200-day average: wait for it to reclaim it';}
  return {available:true,asOf:h.at(-1).date,price:r2(last),sma50:r2(s50),sma200:r2(s200),above50:r4(above50),above200:r4(above200),
    sma200Slope1m:r4(slope200),rsi14:r2(rsi14),high52:r2(hi),low52:r2(lo),fromHigh:r4(last/hi-1),fromLow:r4(last/lo-1),
    ret1m:r4(closes.length>21?closes.at(-1)/closes.at(-22)-1:null),ret3m:r4(closes.length>63?closes.at(-1)/closes.at(-64)-1:null),
    ret12m:r4(closes.length>252?closes.at(-1)/closes.at(-253)-1:null),trend,zone,label};
}

function earnings(stock,extras){
  const years=(stock?.financials?.years||[]).slice(-5).map(y=>({year:y.year,revenue:fin(y.revenue)===null?null:Math.round(y.revenue),eps:r2(fin(y.dilutedEPS??y.eps)),netMargin:fin(y.revenue)>0&&fin(y.netIncome)!==null?r4(y.netIncome/y.revenue):null}));
  // Quarterly revenue: growth vs the same quarter a year earlier (10-Q quarters; Q4 is in the 10-K).
  const q=(stock?.quarterly||[]).filter(x=>x?.end&&fin(x.val)>0);
  const yoy=[];
  for(const p of q){const d=new Date(p.end);const prior=q.find(o=>{const od=new Date(o.end);const days=(d-od)/864e5;return days>350&&days<380;});
    if(prior)yoy.push({end:p.end,revenue:Math.round(p.val),growth:r4(p.val/prior.val-1)});}
  const reports=Array.isArray(extras?.earningsHistory)?extras.earningsHistory.slice(-4):[];
  return {annual:years,quarterlyRevenue:yoy.slice(-4),reports};
}

function pctChange(now,then){return fin(now)!==null&&fin(then)!==null&&Math.abs(then)>1e-9?r4((now-then)/Math.abs(then)):null;}
function estimates(ae,extras){
  const t=extras?.epsTrend||{},rv=extras?.epsRevisions||{};
  const row=k=>{const x=t[k]||{};return {now:fin(x.current),d7:pctChange(x.current,x['7daysAgo']),d30:pctChange(x.current,x['30daysAgo']),d90:pctChange(x.current,x['90daysAgo'])};};
  const thisYear=t['0y']?row('0y'):{now:fin(ae?.epsCurrentYear),d7:null,d30:null,d90:pctChange(ae?.epsCurrentYear,ae?.epsCurrentYear90dAgo)};
  const nextYear=t['+1y']?row('+1y'):{now:fin(ae?.epsNextYear),d7:null,d30:null,d90:pctChange(ae?.epsNextYear,ae?.epsNextYear90dAgo)};
  const sum=(k)=>['0q','+1q','0y','+1y'].reduce((a,p)=>a+(fin(rv[p]?.[k])||0),0);
  const hasRev=Object.keys(rv).length>0;
  const ratings=Array.isArray(extras?.ratings)?extras.ratings:[];
  const mix=r=>{if(!r)return null;const n=['strongBuy','buy','hold','sell','strongSell'].reduce((a,k)=>a+(fin(r[k])||0),0);return n?{n,buyShare:r4(((fin(r.strongBuy)||0)+(fin(r.buy)||0))/n),sellShare:r4(((fin(r.sell)||0)+(fin(r.strongSell)||0))/n)}:null;};
  return {thisYear,nextYear,nextQuarter:t['+1q']?row('+1q'):null,
    revisions30:hasRev?{up:sum('up30'),down:sum('down30')}:null,
    ratingsNow:mix(ratings.find(r=>r.period==='0m')||ratings[0]),ratings3mAgo:mix(ratings.find(r=>r.period==='-3m')),
    actions90d:extras?.analystActions90d||null,
    target:{mean:fin(ae?.analystTargetMean),low:fin(ae?.analystTargetLow),high:fin(ae?.analystTargetHigh),analysts:fin(ae?.numAnalysts)}};
}

function scenarios(valuation,forecast,record){
  const rows=forecast?.rows||[],first=rows[0]||{},last=rows.at(-1)||{},n=rows.length;
  const rev0=fin(forecast?.startRevenue)??fin(first.revenue);
  const revCagr=rev0>0&&fin(last.revenue)>0&&n?Math.pow(last.revenue/rev0,1/n)-1:null;
  const opM=fin(last.operatingMargin)??fin(last.netMargin);
  const epsExit=(valuation?.methods||[]).find(m=>/^(EPS exit|Normalized EPS exit)$/i.test(m.name));
  const pe=fin(epsExit?.audit?.exitMultiple), peNow=fin(epsExit?.audit?.currentMultiple);
  const es=valuation?.economicScenarios||{};
  const one=(name,cagr,f)=>{
    const g=revCagr!==null&&f?Math.pow((1+revCagr)*Math.pow(f.revenueFactor,1/n),1)-1:revCagr;
    return {cagr:r4(fin(cagr)),revenueGrowth:r4(g),operatingMargin:r4(opM!==null&&f?opM*f.marginFactor:opM),
      exitPE:r2(pe!==null&&f?pe*f.multipleFactor:pe)};};
  return {years:n,peNow:r2(peNow),
    bear:one('bear',record?.bearCAGR,es.bear),base:one('base',record?.baseCAGR??record?.expectedCAGR,null),bull:one('bull',record?.bullCAGR,es.bull)};
}

function researchData(stock,forecast,valuation,record){
  const extras=stock?.analystEstimates?.researchExtras||null;
  let tech;try{tech=technical(stock?.priceHistory,stock?.price?.current);}catch(e){tech={available:false,reason:e.message};}
  return {technical:tech,earnings:earnings(stock,extras),estimates:estimates(stock?.analystEstimates,extras),scenarios:scenarios(valuation,forecast,record)};
}

module.exports={researchData,technical,earnings,estimates,scenarios,rsi,sma};
