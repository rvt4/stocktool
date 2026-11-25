'use strict';
// Build 97: plain-English summary for one stock on the research page: the verdict, pros and cons, and labels
// for the bear/base/bull, earnings, estimate and technical sections. Runs in the browser (window.ResearchSummary)
// and in Node tests. Display only: it never changes the rating, rank or buy list.
(function(root){
  const num=x=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))?Number(x):null);
  const pct=(x,d=0)=>x===null?'—':(x*100).toFixed(d)+'%';
  const spct=(x,d=0)=>x===null?'—':(x>=0?'+':'')+(x*100).toFixed(d)+'%';
  const money=x=>x===null?'—':'$'+(Math.abs(x)>=100?x.toFixed(0):x.toFixed(2));
  const HURDLE=.11;
  // Only the rarer, more serious underwriting flags. The margin-expansion flags fire on about half the universe,
  // so as a con they'd be noise.
  const FLAG_TEXT={exit_value_reliant_on_unverified_rerating:'Much of the return depends on the stock getting a higher multiple',
    boom_cycle_margin_reversion:'Profits look like a cyclical peak; the model expects margins to fall back',
    growth_accelerates_beyond_history:'The forecast needs faster growth than the company has ever had'};

  function beats(s){
    const r=(s?.research?.earnings?.reports||[]).filter(x=>num(x.actual)!==null&&num(x.estimate)!==null);
    return r.length?{n:r.length,beat:r.filter(x=>x.actual>=x.estimate).length,avgSurprise:r.reduce((a,x)=>a+(num(x.surprise)??0),0)/r.length}:null;
  }
  function revision(s){
    const e=s?.research?.estimates;
    const d=num(e?.thisYear?.d90)??num(s?.estimateRevision?.currentYear), dn=num(e?.nextYear?.d90)??num(s?.estimateRevision?.nextYear);
    return {thisYear:d,nextYear:dn,up:num(e?.revisions30?.up),down:num(e?.revisions30?.down)};
  }

  function prosCons(s){
    const pros=[],cons=[];
    const add=(list,p,t)=>list.push({p,t});
    const q=num(s.qualityScore),g3=num(s.revenueCAGR3),ttm=num(s.revenueGrowthTTM),acc=num(s.growth?.revAccel),
      opc=num(s.growth?.opMarginChange),uw=num(s.underwrittenCAGR),base=num(s.expectedCAGR??s.baseCAGR),bear=num(s.bearCAGR),
      price=num(s.currentPrice),target=num(s.analystCheck?.target??s.analystEstimates?.analystTargetMean),
      nd=num(s.netDebtNow),cap=num(s.marketCap),dil=num(s.dilutionRate),tech=s.research?.technical,b=beats(s),rv=revision(s);
    // Business
    if(q!==null&&q>=80)add(pros,9,`High-quality business (quality ${Math.round(q)}/100)`);
    else if(q!==null&&q<60)add(cons,6,`Below-average business quality (${Math.round(q)}/100)`);
    if(g3!==null&&g3>=.10)add(pros,8,`Revenue up ${pct(g3)} a year over the last 3 years`);
    if(ttm!==null&&ttm<0)add(cons,9,`Revenue is shrinking (down ${pct(Math.abs(ttm))} over the last year)`);
    else if(ttm!==null&&g3!==null&&ttm<g3-.02&&(acc===null||acc<=0))add(cons,8,`Growth is slowing: ${pct(ttm)} over the last year vs ${pct(g3)} a year over 3 years`);
    else if(acc!==null&&acc<=-.05&&ttm!==null)add(cons,6,`Growth slowed in recent quarters (${pct(ttm)} over the last year)`);
    else if(acc!==null&&acc>=.03&&ttm!==null)add(pros,8,`Growth is speeding up (${pct(ttm)} over the last year)`);
    if(opc!==null&&opc>=.02)add(pros,6,`Operating margin up ${(opc*100).toFixed(1)} pts over the last year`);
    else if(opc!==null&&opc<=-.02)add(cons,6,`Operating margin down ${(-opc*100).toFixed(1)} pts over the last year`);
    // Valuation
    if(uw!==null&&uw>=HURDLE)add(pros,10,`Even the cautious case returns ${pct(uw,1)} a year (the bar is ${pct(HURDLE)})`);
    else if(base!==null&&base<HURDLE)add(cons,9,`Base case returns ${pct(base,1)} a year, under the ${pct(HURDLE)} bar`);
    if(bear!==null&&bear<.03)add(cons,7,`Bear case returns only ${pct(bear,1)} a year`);
    else if(bear!==null&&bear>=.08)add(pros,7,`Bear case still returns ${pct(bear,1)} a year`);
    if(price>0&&target>0){const up=target/price-1;if(up>=.20)add(pros,4,`Analysts' average target is ${pct(up)} above the price`);else if(up<0)add(cons,5,`Price is above analysts' average target (${money(target)})`);}
    // Earnings and estimates
    if(rv.thisYear!==null&&rv.thisYear>=.02)add(pros,7,`Analysts raised this year's EPS estimate ${pct(Math.abs(rv.thisYear),1)} in 90 days`);
    else if(rv.thisYear!==null&&rv.thisYear<=-.02)add(cons,8,`Analysts cut this year's EPS estimate ${pct(Math.abs(rv.thisYear),1)} in 90 days`);
    if(rv.nextYear!==null&&rv.nextYear<=-.03&&!(rv.thisYear!==null&&rv.thisYear<=-.02))add(cons,7,`Next year's EPS estimate cut ${pct(Math.abs(rv.nextYear),1)} in 90 days`);
    if(rv.up!==null&&rv.down!==null&&rv.down>=rv.up+3)add(cons,5,`More estimate cuts than raises lately (${rv.down} down vs ${rv.up} up in 30 days)`);
    if(b&&b.n>=3){if(b.n===4&&b.beat===4)add(pros,6,`Beat EPS estimates in all of the last 4 reports`);else if(b.beat>=3)add(pros,5,`Beat EPS estimates in ${b.beat} of the last ${b.n} reports`);else if(b.n-b.beat>=2)add(cons,7,`Missed EPS estimates in ${b.n-b.beat} of the last ${b.n} reports`);}
    // Balance sheet and risks
    if(nd!==null&&cap>0){if(nd<0&&-nd/cap>=.05)add(pros,3,`Net cash on the balance sheet (${money(-nd/1e9)}B)`);else if(nd/cap>.35)add(cons,6,`Heavy debt: net debt is ${pct(nd/cap)} of the market value`);}
    if(dil!==null&&dil>.03)add(cons,5,`Share count growing ${pct(dil,1)} a year (dilution)`);
    if(s.cyclicalBusiness)add(cons,5,'Cyclical business: profits swing with the economy');
    for(const f of (s.underwriting?.flags||[]))if(FLAG_TEXT[f])add(cons,7,FLAG_TEXT[f]);
    if(s.modelSupport==='limited'||s.modelSupport==='unsupported')add(cons,s.modelSupport==='unsupported'?11:8,s.modelSupportReason||'The model has limited support for valuing this business');
    // Price action
    if(tech?.available){if(tech.trend==='up')add(pros,3,'Stock is in an uptrend');else if(tech.trend==='down')add(cons,4,`Stock is in a downtrend (${pct(Math.abs(tech.fromHigh))} below its 52-week high)`);}
    const top=l=>l.sort((a,b)=>b.p-a.p).slice(0,5).map(x=>x.t);
    return {pros:top(pros),cons:top(cons)};
  }

  function zoneTone(zone){return {buy:'good',ok:'neutral',recovering:'neutral',extended:'warn',below200:'warn',oversold:'warn',downtrend:'bad'}[zone]||'neutral';}

  function verdict(s,onList,listReason){
    const t=s.research?.technical, lvl=t?.available&&num(t.sma50)?money(num(t.sma50)):null;
    if(!onList)return {tone:'neutral',head:'Not on the buy list',text:listReason||''};
    if(!t?.available)return {tone:'good',head:'On the buy list',text:'No price-trend data yet.'};
    if(t.zone==='buy')return {tone:'good',head:'On the buy list · in a technical buy zone',text:'The business case and the price action agree.'};
    if(t.zone==='extended')return {tone:'warn',head:'On the buy list · price is extended',text:`Consider starting small and adding nearer the 50-day average (${lvl}).`};
    if(t.zone==='downtrend'||t.zone==='below200'||t.zone==='oversold')return {tone:'warn',head:'On the buy list · price still falling',text:'Consider buying in stages rather than all at once.'};
    return {tone:'good',head:'On the buy list',text:t.label};
  }

  function scenarioStory(name,c){
    if(!c)return '';
    const bits=[];
    if(num(c.revenueGrowth)!==null)bits.push(`revenue grows ${pct(c.revenueGrowth,1)} a year`);
    if(num(c.operatingMargin)!==null)bits.push(`operating margin ${pct(c.operatingMargin,0)} by year 10`);
    if(num(c.exitPE)!==null)bits.push(`ends at ${num(c.exitPE).toFixed(0)}× earnings`);
    return bits.length?bits.join(', '):'';
  }

  const api={prosCons,verdict,zoneTone,scenarioStory,beats,revision,fmt:{pct,spct,money}};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ResearchSummary=api;
})(typeof window!=='undefined'?window:globalThis);
