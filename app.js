"use strict";
// Keep in sync with engine/config.js INVESTOR_ALPHA_HURDLE.
const HURDLE=0.11, HURDLE_LABEL=Math.round(HURDLE*100)+'%';
const $=id=>document.getElementById(id), num=(x,f=0)=>Number.isFinite(Number(x))?Number(x):f;
const money=x=>Number.isFinite(x)?'$'+x.toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2}):'—';
const pct=x=>Number.isFinite(x)?(x*100).toFixed(1)+'%':'—';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let stocks=[],byTicker=new Map(),current=null,assumptions={},client=null,user=null,saved=[],holdings=[],snapshots=[],snapshotStore='cloud',history=null,historyRequest=0,assumptionsEdited=false;
const toast=msg=>{ $('toast').textContent=msg;$('toast').style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('toast').style.display='none',4500)};
const valid=(x,f)=>Number.isFinite(Number(x))?Number(x):f;
function page(id){try{window.scrollTo(0,0)}catch(e){}document.querySelectorAll('.page').forEach(e=>e.hidden=e.id!==id);document.querySelectorAll('nav button').forEach(e=>e.classList.toggle('active',e.dataset.page===id));}
function getPrice(s){return valid(s?.price??s?.currentPrice??s?.stockPrice??s?.valuation?.currentPrice,NaN)}
function model(s){return s?.valuation||s?.valuationSummary||{} }
function initial(s){
 const p=Array.isArray(s.valuationProjection)?s.valuationProjection:[];
 const first=p[0]||{},last=p.at(-1)||{},a=s.projectionAssumptions||{};
 const revenue=valid(s.revenue??s.financials?.revenue,NaN);
 const g1=valid(first.revenueGrowth,NaN),g10=valid(last.revenueGrowth,NaN);
 const firstRevenue=valid(first.revenue,NaN);
 const startingRevenue=Number.isFinite(revenue)&&revenue>0?revenue:(Number.isFinite(firstRevenue)&&Number.isFinite(g1)?firstRevenue/(1+g1):NaN);
 const startingShares=valid(s.sharesOutstanding??s.shareCount,NaN);
 const firstShares=valid(first.shares,NaN);
 const shareChange=valid(first.actualDilution??s.dilutionRate,0);
 const shareBase=Number.isFinite(startingShares)?startingShares:Number.isFinite(firstShares)?firstShares/(1+shareChange):NaN;
 const epsMultipleAudit=Object.entries(s.valuationMethodAudits||{}).find(([name])=>/eps|earnings/i.test(name))?.[1]||{};
 const multiple=valid(epsMultipleAudit.exitMultiple??epsMultipleAudit.multiple??s.exitMultiple,NaN);
 const dividend=valid(first.dividendPerShare,0);
 const a0={revenue:startingRevenue/1e9,growth:Number.isFinite(g1)?g1*100:valid(a.revenueGrowthAnchor,0.06)*100,terminalGrowth:Number.isFinite(g10)?g10*100:valid(a.terminalGrowth,0.03)*100,margin:valid(last.netMargin??a.marginAssumptions?.netTarget,NaN)*100,fcfMargin:valid(last.fcfMargin??a.marginAssumptions?.fcfTarget,NaN)*100,sbc:valid(last.sbcMargin??a.marginAssumptions?.sbcMarginTarget,0)*100,shares:shareBase/1e6,dilution:shareChange*100,multiple:Number.isFinite(multiple)?multiple:18,price:getPrice(s),dividend,mos:10};
 a0.netStart=valid(first.netMargin,NaN)*100;if(!Number.isFinite(a0.netStart))a0.netStart=a0.margin;
 a0.fcfStart=valid(first.fcfMargin,NaN)*100;if(!Number.isFinite(a0.fcfStart))a0.fcfStart=a0.fcfMargin;
 // Today's EPS on the SAME basis as the projected EPS (normalized, before the SBC add-back). The audit's
 // currentMultiple is capped at 57x inside the engine, so it is only a fallback.
 const eps1=valid(first.eps,NaN),curPE=valid(epsMultipleAudit.currentMultiple,NaN),normEps0=valid(epsMultipleAudit.normalizedCurrentMetric,NaN);
 const trailingEps=Number.isFinite(normEps0)&&normEps0>0?normEps0:Number.isFinite(curPE)&&curPE>0&&curPE<56.5&&a0.price>0?a0.price/curPE:(Number.isFinite(eps1)&&eps1>0?eps1/(1+valid(g1,0.05)):NaN);
 a0.firstYear=Number.isFinite(Number(first.year))?Number(first.year):new Date().getFullYear()+1;
 a0.epsToday=trailingEps;a0.peToday=Number.isFinite(trailingEps)&&trailingEps>0&&a0.price>0?clamp(a0.price/trailingEps,3,400):a0.multiple;
 let mp=modelPath(s,a0);
 // Financials (banks, insurers): the screener forecasts EPS directly, not revenue x margin. Build the
 // table so its EPS path matches the screener's (start = normalized EPS, year 10 = its year-10 EPS).
 if(!mp&&p.length===10&&p.every(r=>Number.isFinite(Number(r.revenueGrowth))&&Number(r.revenue)>0&&Number(r.shares)>0)){
  const e0=valid(epsMultipleAudit.normalizedEPSBase,NaN),e10=valid(epsMultipleAudit.metric,NaN);
  if(e0>0&&e10>0){
   a0.financialPath=true;a0.epsToday=e0;a0.peToday=a0.price>0?clamp(a0.price/e0,3,400):a0.multiple;
   a0.revenue=valid(p[0].revenue,NaN)/(1+Number(p[0].revenueGrowth))/1e9;a0.shares=valid(p[0].shares,NaN)/(1+valid(p[0].actualDilution,0))/1e6;
   // Build 62e: follow the screener's own year-by-year EPS growth path (year 1 = consensus), not a smooth
   // curve from today's EPS to year 10, which hid the consensus jump and showed AXP's margin 3 pts too low.
   const gp=epsMultipleAudit.epsGrowthPath,useGp=Array.isArray(gp)&&gp.length===10&&gp.every(Number.isFinite);
   let ec=e0;const epsAt=i=>useGp?(ec*=1+gp[i]):e0*Math.pow(e10/e0,(i+1)/10);
   const net=p.map((r,i)=>epsAt(i)*Number(r.shares)/Number(r.revenue)*100);
   mp={growth:p.map(r=>Number(r.revenueGrowth)*100),net,fcf:net.slice(),sbc:Array(10).fill(0),dil:p.map(r=>valid(r.actualDilution,0)*100),div:p.map(r=>valid(r.dividendPerShare,0)),pe:peSeries(a0.peToday,a0.multiple,'linear')};
  }
 }
 a0.shapes={growth:'model',net:'model',fcf:'model',pe:'steady',sbc:'model',dil:'model',div:'model'};
 a0.path=mp||linearPath(a0);
 if(!mp)a0.shapes={growth:'linear',net:'linear',fcf:'linear',pe:'steady',sbc:'linear',dil:'linear',div:'linear'};
 const rowsAll=p;
 if(mp&&rowsAll.length===10&&!a0.financialPath){
  const eb=rowsAll.map(r=>nz(r.ebitdaMargin)*100),nd=rowsAll.map(r=>nz(r.netDebt)/1e9);
  if(eb.every(Number.isFinite)){a0.path.ebitda=eb;a0.shapes.ebitda='model';}
  if(nd.every(Number.isFinite)){a0.path.debt=nd;a0.shapes.debt='model';}
 }
 a0.methods=seedMethods(s);
 syncEndpoints(a0);
 return a0;
}
// ---- Build 46: every valuation method, visible and editable ----
function methodKind(name){return /^(EPS exit|Normalized EPS exit)$/i.test(name)?'eps':/^FCF exit$/i.test(name)?'fcf':/EV\/EBITDA/i.test(name)?'ebitda':/DCF/i.test(name)?'dcf':'fixed';}
function seedMethods(s){
 const audits=s?.valuationMethodAudits||{},W=s?.effectiveWeights||{},out=[];
 for(const [name,au] of Object.entries(audits)){
  const kind=methodKind(name),w=valid(W[name],valid(au?.effectiveWeight,0));
  out.push({name,kind,weight:Math.max(0,w)*100,mult:valid(au?.exitMultiple,NaN),screenerCAGR:valid(au?.impliedCAGR,NaN),screenerOutcome:valid(au?.year10Outcome,NaN)});
 }
 if(!out.some(m=>m.kind==='eps'))out.unshift({name:'EPS exit',kind:'eps',weight:out.length?0:100,mult:NaN,screenerCAGR:NaN,screenerOutcome:NaN});
 const dr=valid(s?.intrinsicDiscountRate,0.10),tg=valid(s?.projectionAssumptions?.terminalGrowth,0.025);
 const vp=s?.valuationProjection||[],ac=s?.analystCheck||{};
 // Build 58c: mirror the screener exactly — DCF terminal value split with the FCF exit multiple,
 // SBC add-back tax rate, and the analyst cross-check that turns the method blend into the headline.
 return {list:out,dcfRate:dr*100,dcfGrowth:Math.min(tg,0.03)*100,
  dcfExitWeight:valid(audits['10Y DCF']?.terminalExitWeight,0),taxRate:valid(vp.at(-1)?.taxRate,0.21),
  analyst:{factor:valid(ac.blendFactor,1),weight:valid(ac.blendWeight,0),target:valid(ac.target,NaN),n:valid(ac.numAnalysts,0)}};
}
// Build 58c: say why a stock has its rating. Mirrors engine/rating-engine.js: Buy needs expected CAGR >= hurdle,
// the stressed (underwritten) CAGR >= hurdle, AND price <= requiredReturnBuyPrice (stressed hurdle price less the margin of safety).
function ratingWhy(s){
 const H=0.11,c=valid(s.expectedReturn,NaN),u=valid(s.underwrittenCAGR,NaN),p=valid(s.currentPrice,NaN),buy=valid(s.requiredReturnBuyPrice,NaN),hp=valid(s.hurdleReturnPrice,NaN),rt=s.rating||'Unrated';
 if(rt==='Unrated')return s.modelSupportReason||'Model does not support this business type or data is missing';
 if(s.corporateAction&&rt==='Watch')return `Held at Watch: ${s.corporateAction.reason}`;
 if(!Number.isFinite(c))return 'No expected return';
 if(c<0)return `Expected ${pct(c)} a year: below zero`;
 if(rt==='Avoid'||rt==='Hold'&&c<H)return `Expected ${pct(c)} a year vs ${pct(H)} hurdle`;
 if(/Buy/.test(rt))return `Expected ${pct(c)}, stressed ${pct(u)}; price ${money(p)} is at or below buy price ${money(buy)}`;
 if(Number.isFinite(u)&&u<H)return `Expected ${pct(c)} but stressed case ${pct(u)} is below the ${pct(H)} hurdle`;
 if(Number.isFinite(buy)&&p>buy)return `Expected ${pct(c)}, stressed ${pct(u)}: Buy below ${money(buy)} (stressed ${pct(H)} price ${money(hp)} less ${Math.round((1-buy/hp)*100)}% margin of safety). Now ${money(p)}`;
 return `Expected ${pct(c)}, stressed ${pct(u)}; held back by a reliability check (method agreement, forecast confidence or analyst divergence)`;
}
function methodResults(a,r){
 if(!r||!a?.methods?.list?.length)return null;
 const price=a.price,ys=r.years,y10=ys[9],divs=r.value-r.exit;
 // Screener basis (Build 63): SBC is expensed in both net margin and FCF, and the share path excludes
 // employee-grant dilution, so it is counted exactly once. DCF discounts aggregate FCF over today's share count.
 const sh10=y10.shares,fcfAgg=ys.map(y=>y.revenue*1000*y.fcfMargin/100),fcfps=ys.map((y,i)=>fcfAgg[i]/y.shares);
 const sbcFrac=0; // Build 63: SBC is expensed in the margins, so no add-back
 const tax=valid(a.methods.taxRate,0.21),sbcAdd=sbcFrac*y10.revenue*1000*(Number(y10.sbc)||0)/100*(1-tax)/sh10;
 const shares0=valid(r.startShares,ys[0].shares),fcfMethod=a.methods.list.find(m=>m.kind==='fcf');
 const rows=a.methods.list.map(m=>{
  let outcome=NaN,fair=NaN,note='';
  if(m.kind==='eps'){const pe10=r.exit/y10.eps;outcome=y10.eps>0&&pe10>0?(y10.eps+sbcAdd)*pe10+divs:NaN;note=sbcAdd>0.005?`Year-10 EPS × P/E, + ${money(sbcAdd)}/sh SBC add-back (dilution already in share count)`:'Year-10 EPS × P/E (table)';}
  else if(m.kind==='fcf'){outcome=fcfps[9]>0&&m.mult>0?fcfps[9]*m.mult+divs:NaN;note='Year-10 FCF/share × P/FCF';}
  else if(m.kind==='ebitda'){
   const eb=a.path?.ebitda,dt=a.path?.debt;
   if(Array.isArray(eb)&&Array.isArray(dt)&&m.mult>0){const ebitda=ys[9].revenue*1000*eb[9]/100;outcome=(ebitda*m.mult-dt[9]*1000)/sh10+divs;}
   note='(Year-10 EBITDA × EV/EBITDA − net debt) / shares';
  }
  else if(m.kind==='dcf'){
   const rr=a.methods.dcfRate/100,g=a.methods.dcfGrowth/100;
   const xw=fcfMethod&&fcfMethod.mult>0?valid(a.methods.dcfExitWeight,0):0;
   if(rr>g&&fcfAgg.every(c=>c>0)&&shares0>0){
    const gordon=fcfAgg[9]*(1+g)/(rr-g),tv=(1-xw)*gordon+xw*fcfAgg[9]*(fcfMethod?.mult||0);
    fair=(fcfAgg.reduce((t,c,i)=>t+c/Math.pow(1+rr,i+1),0)+tv/Math.pow(1+rr,10))/shares0;
    outcome=fair*Math.pow(1+rr,10);}
   note=xw>0?`FCF years 1–10; terminal value ${Math.round((1-xw)*100)}% growth formula, ${Math.round(xw*100)}% FCF exit multiple`:'FCF years 1–10 + terminal growth';
  }
  else {outcome=m.screenerOutcome;note='Screener only (not editable here)';}
  const cagr=outcome>0?Math.pow(outcome/price,1/10)-1:NaN;
  return {...m,outcome,cagr,fair,note};
 });
 const ok=rows.filter(x=>x.outcome>0&&x.weight>0),ws=ok.reduce((t,x)=>t+x.weight,0);
 const blend=ws>0?Math.exp(ok.reduce((t,x)=>t+x.weight*Math.log(x.outcome),0)/ws):NaN;
 const cagr=blend>0?Math.pow(blend/price,1/10)-1:NaN,hurdle=blend/Math.pow(1+HURDLE,10);
 return {rows,blend,cagr,hurdle,buy:hurdle*(1-a.mos/100),weightSum:ws};
}
function renderMethods(){
 const el=$('methodsPanel');if(!el)return;const a=assumptions;
 if(!a.methods){a.methods=seedMethods(current);}
 const r=calculate(a),mr=methodResults(a,r);
 if(!mr){el.innerHTML='<p class="muted small">Not enough inputs to value this company.</p>';return;}
 const fx=(v,d=1)=>Number.isFinite(v)?Number(v.toFixed(d)):'';
 const multCell=(m,i)=>m.kind==='eps'?`<input type="number" step="0.5" data-mpe="1" value="${fx(a.path.pe[9])}" aria-label="Exit P/E"> <span class="muted small">P/E</span>`
  :m.kind==='fcf'?`<input type="number" step="0.5" data-mmult="${i}" value="${fx(m.mult)}" aria-label="Exit P/FCF"> <span class="muted small">P/FCF</span>`
  :m.kind==='ebitda'?(a.path?.ebitda?`<input type="number" step="0.5" data-mmult="${i}" value="${fx(m.mult)}" aria-label="Exit EV/EBITDA"> <span class="muted small">EV/EBITDA</span>`:'<span class="muted small">no EBITDA data</span>')
  :m.kind==='dcf'?`<input type="number" step="0.25" data-mdcf="rate" value="${fx(a.methods.dcfRate,2)}" aria-label="Discount rate"> <span class="muted small">% disc.</span> <input type="number" step="0.25" data-mdcf="growth" value="${fx(a.methods.dcfGrowth,2)}" aria-label="Terminal growth"> <span class="muted small">% term. g</span>`
  :'<span class="muted small">—</span>';
 // Build 58c: the screener headline = method blend x analyst cross-check. Show both steps so the
 // headline reconciles (AMD: methods ~7.6%, pulled toward the $656 consensus target -> 8.8%).
 const an=a.methods.analyst||{},headline=valid(current?.expectedReturn,NaN),af=valid(an.factor,1);
 const screenerMethodsCAGR=Number.isFinite(headline)?(1+headline)/Math.pow(af,1/10)-1:NaN;
 const yourWithAnalyst=mr.blend>0?Math.pow(mr.blend*af/a.price,1/10)-1:NaN;
 const dRate=valid(current?.intrinsicDiscountRate,0.10),targetToday=an.target/(1+dRate);
 const analystRow=Math.abs(af-1)>0.001?`<tr><td>Analyst cross-check<div class="muted small">${Math.round(valid(an.weight,0)*100)}% weight on the ${an.n} analysts' ${money(an.target)} 12-month target, worth ${money(targetToday)} today (discounted one year at ${pct(dRate)}). It ${af<1?'lowers':'raises'} value ${Math.abs((af-1)*100).toFixed(1)}%.</div></td><td></td><td>${money(mr.blend*af)}</td><td>${pct(yourWithAnalyst)}</td><td class="muted"><b>${pct(headline)}</b> headline</td><td></td></tr>`:'';
 el.innerHTML=`<div class="table-scroll"><table class="methods-table"><thead><tr><th>Method</th><th>Exit assumption</th><th>Year-10 value/sh</th><th>Your 10Y CAGR</th><th>Screener's</th><th>Weight %</th></tr></thead><tbody>
 ${mr.rows.map((m,i)=>`<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.note)}</div></td><td class="mcell">${multCell(m,i)}</td><td>${money(m.outcome)}${m.kind==='dcf'&&Number.isFinite(m.fair)?`<div class="muted small">value today ${money(m.fair)}</div>`:''}</td><td>${pct(m.cagr)}</td><td class="muted">${pct(m.screenerCAGR)}</td><td><input type="number" step="1" min="0" data-mw="${i}" value="${fx(m.weight,0)}" aria-label="Weight"></td></tr>`).join('')}
 <tr class="today-row"><td>Blended methods</td><td></td><td>${money(mr.blend)}</td><td>${pct(mr.cagr)}</td><td class="muted">${pct(screenerMethodsCAGR)}</td><td>${Math.round(mr.weightSum)}</td></tr>
 ${analystRow}</tbody></table></div>
 <p class="muted small">Each method values the same projection (the table above) in a different way; the blend is a weighted geometric average of their year-10 values, plus dividends. Weights don't need to add to 100; they're relative. "Screener's" shows the nightly model's own figure for each method, computed on the same basis (EPS and FCF after stock-based pay, DCF terminal value partly set by the FCF exit multiple). Small gaps remain because the screener weights methods by reliability and agreement before blending. When the methods disagree a lot (e.g. EPS far below cash flow), reported earnings are probably distorted: check why before trusting either.</p>`;
 const done=()=>{markCustom();renderValuation();};
 el.querySelectorAll('[data-mw]').forEach(inp=>inp.addEventListener('change',()=>{const v=Number(inp.value);if(Number.isFinite(v)&&v>=0){a.methods.list[Number(inp.dataset.mw)].weight=v;done();}}));
 el.querySelectorAll('[data-mmult]').forEach(inp=>inp.addEventListener('change',()=>{const v=Number(inp.value);if(Number.isFinite(v)&&v>0){a.methods.list[Number(inp.dataset.mmult)].mult=v;done();}}));
 el.querySelectorAll('[data-mdcf]').forEach(inp=>inp.addEventListener('change',()=>{const v=Number(inp.value);if(Number.isFinite(v)){a.methods[inp.dataset.mdcf==='rate'?'dcfRate':'dcfGrowth']=v;done();}}));
 const pe=el.querySelector('[data-mpe]');if(pe)pe.addEventListener('change',()=>{const v=Number(pe.value);if(Number.isFinite(v)&&v>0){a.path.pe[9]=v;a.multiple=v;done();}});
}
// ---- Build 38: year-by-year path (growth, net margin, FCF margin, P/E) ----
const PATH_SERIES=[['growth','Revenue growth %','growth','terminalGrowth'],['net','Net margin %','netStart','margin'],['fcf','FCF margin %','fcfStart','fcfMargin'],['pe','P/E','peStart','multiple']];
// Per-year inputs without a Year-1/Year-10 field; their single-number versions (a.sbc, a.dilution, a.dividend) are the 10-year average.
const EXTRA_SERIES=[['sbc','SBC % of revenue (already expensed)','sbc'],['dil','Share change %','dilution'],['div','Dividend / share','dividend']];
const OPT_KEYS=['ebitda','debt'];
const ALL_KEYS=['growth','net','fcf','sbc','dil','div','pe'];
const SHAPES={linear:t=>t,front:t=>1-(1-t)*(1-t),back:t=>t*t};
const SHAPE_LABELS={steady:'Follows earnings',model:'Model path',linear:'Even steps',front:'Faster early',back:'Faster late',manual:'Manual'};
function seriesFrom(start,end,shape){const f=SHAPES[shape]||SHAPES.linear;return Array.from({length:10},(_,i)=>start+(end-start)*f(i/9));}
// P/E is anchored at TODAY's trailing P/E and reaches the exit P/E in year 10.
function peSeries(today,exit,shape){const f=SHAPES[shape]||SHAPES.linear;return Array.from({length:10},(_,i)=>today+(exit-today)*f((i+1)/10));}
function peAnchor(a){return Number.isFinite(a.peToday)&&a.peToday>0?a.peToday:(Number.isFinite(a.peStart)?a.peStart:a.multiple);}
function linearPath(a){const out={};for(const [k,,s0,s1] of PATH_SERIES)out[k]=k==='pe'?peSeries(peAnchor(a),Number(a.multiple),'linear'):seriesFrom(Number(a[s0]),Number(a[s1]),'linear');for(const [k,,sc] of EXTRA_SERIES)out[k]=Array(10).fill(Number(a[sc])||0);return out;}
const nz=x=>x===null||x===undefined||x===''?NaN:Number(x); // valid() treats null as 0; projections need 'missing' to stay missing
function modelPath(s,a){
 const rows=nativeRows(s);if(rows.length!==10)return null;
 const g=rows.map(r=>nz(r.revenueGrowth)*100),n=rows.map(r=>nz(r.netMargin)*100),f=rows.map(r=>nz(r.fcfMargin)*100);
 if(![...g,...n,...f].every(Number.isFinite))return null;
 const sb=rows.map(r=>nz(r.sbcMargin)*100),dl=rows.map(r=>nz(r.actualDilution)*100),dv=rows.map(r=>valid(r.dividendPerShare,0));
 return {growth:g,net:n,fcf:f,pe:peSeries(peAnchor(a),a.multiple,'linear'),sbc:sb.every(Number.isFinite)?sb:Array(10).fill(valid(a.sbc,0)),dil:dl.every(Number.isFinite)?dl:Array(10).fill(valid(a.dilution,0)),div:dv};
}
function syncEndpoints(a){if(!a.path)return;for(const [k,,s0,s1] of PATH_SERIES){a[s0]=a.path[k][0];a[s1]=a.path[k][9];}for(const [k,,sc] of EXTRA_SERIES)if(Array.isArray(a.path[k]))a[sc]=a.path[k].reduce((x,y)=>x+y,0)/10;}
// Editing a Year-1 or Year-10 field shifts the path with a ramp, keeping its shape (a hump stays a hump).
function shiftEndpoint(a,key,value){
 if(!a.path)return;
 for(const [k,,s0,s1] of PATH_SERIES){
  if(key!==s0&&key!==s1)continue;
  const arr=a.path[k],d0=key===s0?value-arr[0]:0,d9=key===s1?value-arr[9]:0;
  a.path[k]=arr.map((v,i)=>v+d0*(1-i/9)+d9*(i/9));
  if(a.shapes&&a.shapes[k]==='model')a.shapes[k]='manual';
 }
}
function ensurePath(a){
 const ok=k=>Array.isArray(a.path?.[k])&&a.path[k].length===10&&a.path[k].every(Number.isFinite);
 if(a.path&&PATH_SERIES.every(([k])=>ok(k))){for(const [k,,sc] of EXTRA_SERIES)if(!ok(k)){a.path[k]=Array(10).fill(Number(a[sc])||0);a.shapes={...(a.shapes||{}),[k]:'linear'};}return;}
 // Older saved projections had no path: rebuild with even steps (margins start at the saved start or target).
 if(!Number.isFinite(a.netStart))a.netStart=a.margin;if(!Number.isFinite(a.fcfStart))a.fcfStart=a.fcfMargin;if(!Number.isFinite(a.peStart))a.peStart=a.multiple;if(!Number.isFinite(a.peToday)&&Number.isFinite(a.price)&&current){const t=initial(current);a.peToday=t.peToday;a.epsToday=t.epsToday;}
 if([a.growth,a.terminalGrowth,a.netStart,a.margin,a.fcfStart,a.fcfMargin,a.peStart,a.multiple].every(Number.isFinite)){a.path=linearPath(a);a.shapes={growth:'linear',net:'linear',fcf:'linear',pe:'linear',sbc:'linear',dil:'linear',div:'linear'};}
}
function markCustom(){assumptionsEdited=true;$('scenario').value='Custom';}
function refreshEndpointInputs(except){for(const [,,s0,s1] of PATH_SERIES)for(const k of [s0,s1]){const el=$('a_'+k);if(el&&el!==except&&Number.isFinite(assumptions[k]))el.value=Number(assumptions[k].toFixed(2));}}
function projectedSeries(){
 if(!current)return [];
 const native=nativeScenario(),rows=nativeRows(current);
 if(native&&rows.length)return rows.map(y=>{const rev=valid(y.revenue,NaN);return {period:String(y.year),revenue:rev,grossProfit:rev*valid(y.grossMargin,NaN),operatingIncome:rev*valid(y.operatingMargin,NaN),netIncome:valid(y.netIncome,NaN),eps:valid(y.eps,NaN),fcf:rev*valid(y.fcfMargin,NaN),sbc:rev*valid(y.sbcMargin,NaN),shares:valid(y.shares,NaN)};});
 const r=calculate(assumptions);if(!r)return [];
 return r.years.map((y,i)=>({period:String(y.year),revenue:y.revenue*1e9,grossProfit:NaN,operatingIncome:NaN,netIncome:y.ni*1e6,eps:y.eps,fcf:y.revenue*1e9*y.fcfMargin/100,sbc:y.revenue*1e9*(y.sbc??valid(assumptions.sbc,NaN))/100,shares:(y.shares??assumptions.shares*Math.pow(1+assumptions.dilution/100,i+1))*1e6}));
}
function reportedPathRows(){
 const ann=(history?.annual||[]).filter(x=>Number.isFinite(x.revenue)&&x.revenue>0).slice(-6);
 return ann.slice(1).map((x,i)=>{const prev=ann[i];return {period:x.period,growth:prev.revenue>0?(x.revenue/prev.revenue-1):NaN,net:Number.isFinite(x.netIncome)?x.netIncome/x.revenue:NaN,fcf:Number.isFinite(x.fcf)?(x.fcf-(Number.isFinite(x.sbc)?x.sbc:0))/x.revenue:NaN,sbc:Number.isFinite(x.sbc)?x.sbc/x.revenue:NaN,dil:x.shares>0&&prev.shares>0?x.shares/prev.shares-1:NaN,eps:valid(x.eps,Number.isFinite(x.netIncome)&&x.shares>0?x.netIncome/x.shares:NaN),div:valid(x.dps,NaN),debt:Number.isFinite(x.netDebt)?x.netDebt/1e9:NaN};});
}
let shapesOpen=false;
const PATH_COLS=[['growth','Growth %','growth',0.1,2],['net','Net mgn %','net',0.1,2],['fcf','FCF mgn % (after SBC)','fcf',0.1,2],['ebitda','EBITDA mgn %',null,0.1,2],['sbc','SBC %','sbc',0.1,2],['dil','Shares chg %','dil',0.1,2],['div','Div / sh $',null,0.01,2],['debt','Net debt $B',null,0.1,2],['pe','P/E (trailing)',null,0.5,1]];
const SERIES_LABELS={ebitda:'EBITDA margin',debt:'Net debt ($B)',growth:'Revenue growth',net:'Net margin',fcf:'FCF margin',sbc:'SBC % of revenue (already expensed)',dil:'Share change',div:'Dividend / share',pe:'P/E'};
function renderPathEditor(){
 const el=$('pathEditor');if(!el)return;
 ensurePath(assumptions);const a=assumptions;
 if(!a.path){el.innerHTML='<p class="muted small">Not enough data to build a path for this company.</p>';return;}
 const hasModel=!!(current&&nativeRows(current).length===10);
 const shapeSel=k=>`<select data-shape="${k}" aria-label="${esc(SERIES_LABELS[k])} shape">${Object.entries(SHAPE_LABELS).filter(([v])=>(v!=='model'||(hasModel&&k!=='pe'))&&(v!=='steady'||k==='pe')&&(v!=='manual'||a.shapes?.[k]==='manual')).map(([v,l])=>`<option value="${v}"${a.shapes?.[k]===v?' selected':''}>${l}</option>`).join('')}</select>`;
 const COLS=PATH_COLS.filter(([k])=>!OPT_KEYS.includes(k)||Array.isArray(a.path[k])),r=calculate(a),n=COLS.length+4;
 // Build 62c: reported dividends/share and net debt now come from SEC history (schema 3). EBITDA and P/E stay blank:
 // the history has no D&A, and P/E needs historical prices.
 const hcell=(h,k)=>k==='fcf'&&a.financialPath?'—':k==='div'?(Number.isFinite(h.div)?'$'+h.div.toFixed(2):'—'):k==='debt'?(Number.isFinite(h.debt)?h.debt.toFixed(1):'—'):k==='pe'||k==='ebitda'?'—':pct(h[k]);
 const mb=current?.projectionAssumptions?.forecastBridge?.margins||{},pk=mb.peakMarginDiscipline,an=mb.analystMarginAnchor,notes=[];
 const ev=x=>String(x).replaceAll('_',' ');
 if(pk?.applied)notes.push(`Today's margin is well above this company's long-run level, so the model lets part of it fade (${Math.round((1-(pk.reversionShare||0)/(pk.baseReversion||1))*100)}% durability credit${pk.durabilityEvidence?.length?': '+pk.durabilityEvidence.map(ev).join(', '):''}).`);
 if(an?.applied)notes.push(`Near-term margins are anchored part-way to analyst EPS (${Math.round((an.weight||0)*100)}% weight${an.consensusBasis&&an.consensusBasis!=='unknown'?', consensus '+ev(an.consensusBasis):''}).`);
 const cr=mb.crisisRecovery;if(cr?.applied)notes.push(`Recovery from ${cr.lossYears} loss years: margins head back half-way to the pre-crisis ${(cr.preCrisis*100).toFixed(1)}% net margin by year 10 (${(cr.proven*100).toFixed(1)}%).`);
 if(Number.isFinite(mb.backlogCoverage))notes.push(`Backlog (contracted revenue not yet recognized): ${mb.backlogCoverage.toFixed(1)}× annual revenue.`);
 const rb=current?.projectionAssumptions?.forecastBridge?.revenue||{};
 if(Number.isFinite(rb.longTermConsensus?.raw)&&rb.longTermConsensus.weight>0)notes.push(`Years 3–5 growth leans on the analyst long-term EPS growth estimate of ${pct(rb.longTermConsensus.raw)} (haircut, ${Math.round(rb.longTermConsensus.weight*100)}% weight).`);
 if(Number.isFinite(rb.backlogEvidence?.growth)&&rb.backlogEvidence.weight>0)notes.push(`Backlog grew ${pct(rb.backlogEvidence.growth)} last year and is used as evidence for years 3–5.`);
 if(rb.growthCeiling&&rb.growthCeiling.years3to5>.28)notes.push(`Growth ceiling for years 3–5 raised to ${pct(rb.growthCeiling.years3to5)} (${rb.growthCeiling.sources} supporting source${rb.growthCeiling.sources===1?'':'s'}).`);
 if(a.financialPath)notes.push('Valued on earnings (lender/insurer): margins here are projected EPS × shares ÷ revenue. Reported FCF is left blank because loan and deposit flows run through operating cash flow, so it says nothing about owner earnings; the FCF column simply mirrors net margin.');
 if(mb.oneTimeChargesLatest>.005)notes.push(`One-time charges of ${pct(mb.oneTimeChargesLatest)} of revenue were excluded from last year's margin.`);
 const modelNotes=notes.length&&nativeScenario()!==null?`<div class="model-notes small">${notes.map(n=>'<p>'+esc(n)+'</p>').join('')}</div>`:'';
 el.innerHTML=modelNotes+`<details class="path-shape-box"${shapesOpen?' open':''}><summary class="small">Shapes (redraw a whole line)</summary><div class="path-shapes">${[...ALL_KEYS,...OPT_KEYS.filter(k=>Array.isArray(a.path[k]))].map(k=>`<label class="small">${esc(SERIES_LABELS[k])} ${shapeSel(k)}</label>`).join('')}</div></details>
 <div class="table-scroll"><table class="path-table"><thead><tr><th>Year</th>${COLS.map(([,l])=>`<th>${l}</th>`).join('')}<th>EPS</th><th>Price*</th><th>CAGR if sold</th></tr></thead><tbody>${reportedPathRows().map(h=>`<tr class="hist-row"><td>${esc(h.period)} <span class="hist-tag">reported</span></td>${COLS.map(([k])=>`<td>${hcell(h,k)}</td>`).join('')}<td>${money(h.eps)}</td><td>—</td><td>—</td></tr>`).join('')}${history?'':`<tr class="hist-row"><td colspan="${n}" class="muted small">Reported history not loaded for this company yet.</td></tr>`}<tr class="today-row"><td>Today</td>${COLS.map(([k])=>`<td>${k==='pe'?(Number.isFinite(a.peToday)?a.peToday.toFixed(1)+'×':'—'):'—'}</td>`).join('')}<td>${money(a.epsToday)}</td><td>${money(a.price)}</td><td>—</td></tr><tr class="proj-divider"><td colspan="${n}">Projected</td></tr>${a.path.growth.map((_,i)=>{const y=r?.years?.[i];return `<tr><td>${y?y.year:(Number.isFinite(a.firstYear)?a.firstYear:new Date().getFullYear()+1)+i}</td>${COLS.map(([k,,,step,dp])=>`<td><input type="number" inputmode="decimal" step="${step}" data-path="${k}" data-i="${i}" value="${Number(a.path[k][i].toFixed(dp))}"></td>`).join('')}<td>${y?money(y.eps):'—'}</td><td>${y?money(y.price):'—'}</td><td>${y&&Number.isFinite(y.cagrToDate)?pct(y.cagrToDate):'—'}</td></tr>`}).join('')}</tbody></table></div>
 <p class="muted small">* P/E is the trailing P/E at the end of each year, from today's P/E (Today row) to your exit P/E in the final year. With the default "Follows earnings" shape the P/E moves from today's P/E toward your exit P/E in proportion to how much of the forecast EPS growth has been delivered: a high multiple is paid for growth still to come, so it shrinks as that growth arrives (half the EPS growth done = halfway to the exit P/E, on a log scale). Change the Year-10 P/E to set the exit; pick "Even steps" to move it by time instead. In-between prices are illustrations of these assumptions, not forecasts; the 10-year result is what the model estimates. Price = that year's EPS × that year's P/E, so the last row is your exit; CAGR if sold includes dividends received. Shares chg is the yearly change in share count (negative = buybacks). Net margin is after SBC; FCF margin is before it, and SBC % is subtracted for owner FCF. Grey rows are reported SEC figures. Any edit switches to Custom.${nativeScenario()?' <b>In Base, this grid uses a simple EPS × P/E price, so its return differs from the blended Base CAGR above.</b>':''}</p>`;
 el.querySelector('.path-shape-box').addEventListener('toggle',e=>{shapesOpen=e.target.open;});
 el.querySelectorAll('[data-shape]').forEach(sel=>sel.onchange=()=>{
  const k=sel.dataset.shape;
  if(sel.value==='steady'){/* derived in calculatePath */}
  else if(sel.value==='model'){if(OPT_KEYS.includes(k)){const t=initial(current);if(t.path[k])a.path[k]=t.path[k];}else{const mp=modelPath(current,a);if(mp)a.path[k]=mp[k];}}
  else a.path[k]=k==='pe'?peSeries(peAnchor(a),a.path.pe[9],sel.value):seriesFrom(a.path[k][0],a.path[k][9],sel.value);
  a.shapes={...(a.shapes||{}),[k]:sel.value};syncEndpoints(a);markCustom();refreshEndpointInputs();renderValuation();
 });
 el.querySelectorAll('[data-path]').forEach(inp=>inp.addEventListener('change',()=>{
  const v=Number(inp.value);if(inp.value===''||!Number.isFinite(v))return;
  const k=inp.dataset.path,ii=Number(inp.dataset.i);a.path[k][ii]=v;if(!(k==='pe'&&ii===9&&a.shapes?.pe==='steady'))a.shapes={...(a.shapes||{}),[k]:'manual'};
  syncEndpoints(a);markCustom();refreshEndpointInputs();renderValuation();
 }));
}
function nativeScenario(){return $('scenario').value!=='Custom'&&!assumptionsEdited;}
function nativeRows(s){return Array.isArray(s?.valuationProjection)?s.valuationProjection:[];}
function nativeCAGR(s,scenario){return valid(s?.[scenario==='Bear'?'bearCAGR':scenario==='Bull'?'bullCAGR':'expectedReturn'],NaN);}

const fields=[['revenue','Revenue today ($ billions)',0.01,0.01],['growth','Year-1 revenue growth (%)',0.5,-50],['terminalGrowth','Year-10 revenue growth (%)',0.5,-20],['netStart','Year-1 net margin after SBC (%)',0.5,-50],['margin','Year-10 net margin after SBC (%)',0.5,-50],['fcfStart','Year-1 FCF margin before SBC adjustment (%)',0.5,-50],['fcfMargin','Year-10 FCF margin before SBC adjustment (%)',0.5,-50],['sbc','SBC as % of revenue (%)',0.5,0.1],['shares','Diluted shares today (millions)',1,0.01],['dilution','Annual net share dilution (%)',0.25,-20],['peStart','Year-1 P/E (price path only)',0.5,1],['multiple','Terminal P/E multiple (year 10)',1,1],['price','Current stock price ($)',1,0.01],['dividend','Annual dividend/share ($), held flat',0.1,0],['mos','Additional margin of safety (%)',1,0]];
function calculatePath(a){
 const {revenue,shares,price,mos,path}=a;
 if(![revenue,shares,price,mos].every(Number.isFinite)||revenue<=0||shares<=0||price<=0)return null;
 if(path.growth.some(g=>g<=-100)||path.pe.some(x=>x<=0)||path.dil.some(d=>d<=-100))return null;
 // Steady price: the price compounds evenly from today to the exit price (year-10 EPS x exit P/E), so the
 // in-between years show no boom-and-bust the model does not actually forecast. P/E_i = price_i / EPS_i.
 if(a.shapes?.pe==='steady'){
  let rr=revenue,ss=shares;const eps=[];
  for(let i=0;i<10;i++){rr*=1+path.growth[i]/100;ss*=1+path.dil[i]/100;eps.push(rr*1000*path.net[i]/100/ss);}
  const exitPx=eps[9]*path.pe[9];
  if(eps.every(e=>e>0)&&exitPx>0){
   // Price moves in step with earnings progress: t = share of the total EPS change achieved so far.
   // The P/E then glides from today's to the exit P/E, falling fastest in the years EPS grows fastest,
   // so there is no artificial boom-and-bust. Falls back to even time steps.
   const e0=Number(a.epsToday),lnTot=e0>0?Math.log(eps[9]/e0):0;
   for(let i=0;i<9;i++){const t=e0>0&&Math.abs(lnTot)>1e-6?Math.log(eps[i]/e0)/lnTot:(i+1)/10;path.pe[i]=price*Math.pow(exitPx/price,t)/eps[i];}
  }
 }
 const years=[];let r=revenue,sh=shares,divs=0;
 for(let i=1;i<=10;i++){
  const g=path.growth[i-1],nm=path.net[i-1],fm=path.fcf[i-1],pe=path.pe[i-1],sbcI=path.sbc[i-1],d=path.dil[i-1],dps=Math.max(0,path.div[i-1]);
  r*=1+g/100;sh*=1+d/100;divs+=dps;
  const ni=r*1000*nm/100,eps=ni/sh;
  // A P/E on negative earnings is meaningless: no price is shown for loss years (and no exit if year 10 is a loss).
  const px=eps>0?eps*pe:NaN,val=px+divs;
  years.push({year:(Number.isFinite(a.firstYear)?a.firstYear:new Date().getFullYear()+1)+i-1,revenue:r,ni,eps,shares:sh,ownerFCF:r*1000*fm/100,growth:g,netMargin:nm,fcfMargin:fm,sbc:sbcI,dilution:d,dividend:dps,pe,price:px,cagrToDate:val>0?Math.pow(val/price,1/i)-1:NaN});
 }
 const exit=years.at(-1).price,value=exit+divs;
 const cagr=value>0?Math.pow(value/price,1/10)-1:NaN,hurdle=value/Math.pow(1+HURDLE,10);
 return {years,exit,cagr,hurdle,buy:hurdle*(1-mos/100),value,startShares:shares};
}
function hideTickerMatches(){$('tickerMatches').hidden=true;$('tickerSearch').setAttribute('aria-expanded','false')}
function renderTickerMatches(){const q=$('tickerSearch').value.trim().toLowerCase(),matches=stocks.filter(s=>!q||s.ticker.toLowerCase().includes(q)||(s.name||'').toLowerCase().includes(q)).sort((a,b)=>{const score=s=>s.ticker.toLowerCase()===q?0:s.ticker.toLowerCase().startsWith(q)?1:(s.name||'').toLowerCase().startsWith(q)?2:3;return score(a)-score(b)||a.ticker.localeCompare(b.ticker)}).slice(0,12);const box=$('tickerMatches');box.innerHTML=matches.map(s=>`<button type="button" role="option" data-ticker="${esc(s.ticker)}"><strong>${esc(s.ticker)}</strong> <span>${esc(s.name||'')}</span></button>`).join('')||'<p class="muted small">No matching companies</p>';box.hidden=false;$('tickerSearch').setAttribute('aria-expanded','true');box.querySelectorAll('[data-ticker]').forEach(b=>b.onclick=()=>choose(b.dataset.ticker))}
function choose(t){$('scenario').value='Base';current=byTicker.get(t);if(!current)return;assumptions=initial(current);assumptionsEdited=false;$('tickerSearch').value=t+' · '+(current.name||'');hideTickerMatches();$('notes').value='';renderFields();renderValuation();page('projections');loadHistory(t);}
const PATH_KEYS=new Set(['growth','terminalGrowth','netStart','margin','fcfStart','fcfMargin','peStart','multiple']);
const START_KEYS=new Set(['revenue','shares','price','mos']);
function renderFields(){ $('assumptions').innerHTML=fields.filter(([k])=>START_KEYS.has(k)).map(([key,label,step,min])=>`<div class="field"><div><label for="a_${key}">${esc(label)}</label><input id="a_${key}" data-key="${key}" type="number" step="${step}" min="${min}" value="${Number.isFinite(assumptions[key])?Number(assumptions[key].toFixed(2)):''}" placeholder="Required"></div><div class="history-hint" id="hint_${key}">History loading…</div></div>`).join('');$('assumptions').querySelectorAll('input').forEach(el=>el.addEventListener('input',()=>{assumptionsEdited=true;$('scenario').value='Custom';const k=el.dataset.key,v=el.value===''?NaN:Number(el.value);if(Number.isFinite(v))shiftEndpoint(assumptions,k,v);assumptions[k]=v;renderValuation()}));}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function calculate(a){
 if(a&&a.path&&ALL_KEYS.every(k=>Array.isArray(a.path[k])&&a.path[k].length===10&&a.path[k].every(Number.isFinite)))return calculatePath(a);
 const {revenue,growth,margin,fcfMargin,sbc,shares,dilution,multiple,price,dividend,mos}=a;
 const terminalGrowth=Number.isFinite(a.terminalGrowth)?a.terminalGrowth:growth;
 if(![revenue,growth,terminalGrowth,margin,fcfMargin,sbc,shares,dilution,multiple,price,dividend,mos].every(Number.isFinite)||revenue<=0||shares<=0||price<=0||multiple<=0||growth<=-100||terminalGrowth<=-100||dilution<=-100)return null;
 const years=[];let r=revenue;
 const netStart=Number.isFinite(a.netStart)?a.netStart:margin;
 const fcfStart=Number.isFinite(a.fcfStart)?a.fcfStart:fcfMargin;
 for(let i=1;i<=10;i++){
  const g=growth+(terminalGrowth-growth)*(i-1)/9;
  r*=1+g/100;
  const sh=shares*Math.pow(1+dilution/100,i);
  const nm=netStart+(margin-netStart)*i/10;
  const fm=fcfStart+(fcfMargin-fcfStart)*i/10;
  const ni=r*1000*nm/100;
  const ownerFCF=r*1000*fm/100; // Build 63: FCF margin is already after SBC
  years.push({year:new Date().getFullYear()+i,revenue:r,ni,eps:ni/sh,ownerFCF,shares:sh,sbc,dilution,growth:g,netMargin:nm,fcfMargin:fm});
 }
 const exit=years.at(-1).eps*multiple;
 const totalDiv=dividend*10;
 const value=exit+totalDiv;
 const cagr=value>0?Math.pow(value/price,1/10)-1:NaN;
 const hurdle=value/Math.pow(1+HURDLE,10);
 return {years,exit,cagr,hurdle,buy:hurdle*(1-mos/100),value,startShares:shares};
}
function historyBasedDefaults(d){
 const rows=(d?.annual||[]).filter(x=>Number.isFinite(x.revenue)&&x.revenue>0).slice(-6);
 if(rows.length<3)return null;
 const last=rows.at(-1),prev=rows.at(-2),first=rows[0];
 const rate=(a,b,n)=>a>0&&b>0?100*(Math.pow(b/a,1/n)-1):null;
 const rates=[rate(prev.revenue,last.revenue,1),rows.length>=4?rate(rows.at(-4).revenue,last.revenue,3):null,rows.length>=6?rate(first.revenue,last.revenue,5):null].filter(Number.isFinite);
 if(!rates.length)return null;
 const historical=rates.length===3?0.2*rates[0]+0.5*rates[1]+0.3*rates[2]:rates.reduce((a,b)=>a+b,0)/rates.length;
 const modelGrowth=assumptions.growth;
 const growth=clamp(0.6*historical+0.4*modelGrowth,-12,30);
 // A size-aware, declining growth runway; not a claim about segment-level guidance.
 const terminalGrowth=clamp(3+Math.max(0,growth-5)*0.2,2,8);
 const ratio=(key,n)=>{const v=rows.slice(-n).map(x=>Number.isFinite(x[key])?100*x[key]/x.revenue:null).filter(Number.isFinite);return v.length>=2?v.reduce((a,b)=>a+b,0)/v.length:null};
 const net3=ratio('netIncome',3),net5=ratio('netIncome',5);
 const fcf3=ratio('fcf',3),fcf5=ratio('fcf',5);
 const sbc3=ratio('sbc',3);
 const shares=rows.filter(x=>Number.isFinite(x.shares)&&x.shares>0);
 const shareGrowth=shares.length>=4?rate(shares.at(-4).shares,shares.at(-1).shares,3):null;
 const defaults={revenue:last.revenue/1e9,growth,terminalGrowth};
 if(Number.isFinite(net3)){defaults.netStart=clamp(net3,-30,60);defaults.margin=clamp(0.6*net3+0.4*(net5??net3),-15,40);}
 if(Number.isFinite(fcf3)){defaults.fcfStart=clamp(fcf3,-30,60);defaults.fcfMargin=clamp(0.6*fcf3+0.4*(fcf5??fcf3),-15,45);}
 if(Number.isFinite(sbc3))defaults.sbc=clamp(sbc3,0,20);
 if(shares.length&&Number.isFinite(shares.at(-1).shares))defaults.shares=shares.at(-1).shares/1e6;
 if(Number.isFinite(shareGrowth))defaults.dilution=clamp(shareGrowth,-5,5);
 return defaults;
}

// Evidence-based assumption review. Uses only reported SEC history; missing data stays unknown.
function assumptionReview(a, h, stock){
 const annual=(h?.annual||[]).filter(x=>Number.isFinite(x.revenue)&&x.revenue>0).slice(-6);
 const findings=[];let verified=0;
 const add=(severity,title,detail)=>findings.push({severity,title,detail});
 const avg=(rows,key)=>{const v=rows.map(x=>Number.isFinite(x[key])&&x.revenue>0?100*x[key]/x.revenue:null).filter(Number.isFinite);return v.length>=2?v.reduce((x,y)=>x+y,0)/v.length:null};
 const rate=(start,end,n)=>start>0&&end>0&&n>0?100*(Math.pow(end/start,1/n)-1):null;
 if(annual.length>=4){
  const last=annual.at(-1),hist3=rate(annual.at(-4).revenue,last.revenue,3),hist5=annual.length>=6?rate(annual.at(-6).revenue,last.revenue,5):null;
  if(hist3!==null){verified++;const gap=a.growth-hist3;
   add(gap>10?'high':gap>5?'watch':'ok','Revenue growth',`Year-1 ${a.growth.toFixed(1)}% vs reported 3Y CAGR ${hist3.toFixed(1)}%${hist5!==null?' · 5Y '+hist5.toFixed(1)+'%':''}. ${gap>5?'Projection exceeds recent growth; identify a specific driver.':'No large acceleration versus 3Y history.'}`);
  }
  const net=avg(annual.slice(-3),'netIncome');
  if(net!==null){verified++;const gap=a.margin-net;add(gap>8?'high':gap>4?'watch':'ok','Net margin',`Year-10 ${a.margin.toFixed(1)}% vs reported 3Y average ${net.toFixed(1)}%. ${gap>4?'Requires margin expansion; check sustainable operating leverage.':'No large improvement assumed.'}`);}
  const fcf=avg(annual.slice(-3),'fcf');
  if(fcf!==null){verified++;const gap=a.fcfMargin-fcf;add(gap>8?'high':gap>4?'watch':'ok','Cash-flow margin',`Year-10 input ${a.fcfMargin.toFixed(1)}% vs reported 3Y FCF margin ${fcf.toFixed(1)}%. Check whether SBC is already reflected in reported FCF before subtracting it.`);}
  const shares=annual.filter(x=>Number.isFinite(x.shares)&&x.shares>0);
  if(shares.length>=4){verified++;const observed=rate(shares.at(-4).shares,shares.at(-1).shares,3);if(observed!==null){const gap=observed-a.dilution;add(gap>4?'high':gap>2?'watch':'ok','Share count / buybacks',`Assumed ${a.dilution.toFixed(1)}% annual net dilution vs reported 3Y ${observed.toFixed(1)}%. ${gap>2?'Buyback assumption is materially stronger than history; verify funding.':'Comparable to historical share-count change.'}`);}}
  const sbc=avg(annual.slice(-3),'sbc');
  if(sbc!==null){verified++;add(a.sbc<sbc-3?'watch':'ok','Stock-based compensation',`Assumed ${a.sbc.toFixed(1)}% of revenue vs reported 3Y ${sbc.toFixed(1)}%. Reported FCF generally adds back SBC; confirm adjustment conventions.`);}
 }
 const mos=present(stock?.marginOfSafety)?Number(stock.marginOfSafety):null;
 if(mos!==null&&mos>=0.4)add(mos>=0.6?'high':'watch','Screener valuation gap',`Modeled discount ${pct(mos)}. This is not independent proof of undervaluation; test growth, margins and terminal multiple.`);
 if(a.multiple>=30)add('watch','Exit multiple',`Terminal P/E ${a.multiple.toFixed(1)}×. Stress-test a lower terminal multiple.`);
 const high=findings.filter(x=>x.severity==='high').length,watch=findings.filter(x=>x.severity==='watch').length;
 return {findings,coverage:verified,level:verified<3?'Insufficient historical evidence':high>=2?'High assumption risk':high||watch>=2?'Elevated assumption risk':'No major discrepancies detected',high,watch};
}
function assumptionReviewHTML(){
 const report=assumptionReview(assumptions,history,current);
 return `<section class="assumption-review"><h3>Assumption reliability · evidence review</h3><p class="muted small">${esc(report.level)} · ${report.coverage}/5 historical checks available. This is not a probability or a verified valuation.</p>${report.findings.map(f=>`<div class="assumption-check ${f.severity}"><strong>${f.severity==='high'?'Review closely':f.severity==='watch'?'Check assumption':'Historical comparison'} · ${esc(f.title)}</strong><p>${esc(f.detail)}</p></div>`).join('')||'<p class="muted">Not enough comparable SEC history yet. Assumptions remain unverified.</p>'}<p class="muted small">Historical comparisons use reported, unnormalized SEC figures. Acquisitions, fiscal-period changes, and one-time items may distort them. A green comparison does not establish an accurate forecast.</p></section>`;
}
// Transparent comparison: preserve the screener's native valuation and the independent manual EPS case.
function valuationReconciliationHTML(stock,a,r){
 if(!r)return '';
 const price=getPrice(stock),terminal=r.years.at(-1),rows=stock.valuationProjection||[];
 const modelLast=rows.length?rows.at(-1):null;
 const modelEPS=Number(modelLast?.eps),modelRevenue=Number(modelLast?.revenue),modelShares=Number(modelLast?.shares);
 const methods=Object.entries(stock.valuationMethods||{}).filter(([,v])=>Number.isFinite(Number(v))&&Number(v)>0);
 const audits=stock.valuationMethodAudits||{};
 const pctDiff=(x,y)=>Number.isFinite(x)&&Number.isFinite(y)&&y!==0?((x/y-1)*100).toFixed(1)+'%':'—';
 const fmtB=v=>Number.isFinite(v)?'$'+(v/1e9).toFixed(2)+'B':'—';
 const modelExit=Number(stock.tenYearPriceTarget),modelTotal=Number(stock.totalShareholderValue);
 const modelImpliedPE=Number.isFinite(modelEPS)&&modelEPS>0&&Number.isFinite(modelExit)&&modelExit>0?modelExit/modelEPS:null;
 const annual=[];let priorShares=a.shares;let cashGap=0,spendTotal=0,cashTotal=0;
 for(const y of r.years){
  const nextShares=a.shares*Math.pow(1+a.dilution/100,y.year-r.years[0].year+1);
  const retired=Math.max(0,priorShares-nextShares);
  // Reference price is today's price, NOT a prediction of future repurchase execution prices.
  const spend=retired*a.price;
  const available=Math.max(0,y.ownerFCF);
  spendTotal+=spend;cashTotal+=available;cashGap+=Math.max(0,spend-available);
  annual.push({year:y.year,spend,available});priorShares=nextShares;
 }
 const finalShares=a.shares*Math.pow(1+a.dilution/100,10);
 const methodRows=methods.map(([name,target])=>{
  const audit=audits[name]||{};
  const multiple=Object.entries(audit).find(([k,v])=>/multiple/i.test(k)&&Number.isFinite(Number(v))&&Number(v)>0);
  return `<tr><td>${esc(name)}</td><td>${money(Number(target))}</td><td>${multiple?esc(multiple[0])+': '+Number(multiple[1]).toFixed(1)+'×':'Not disclosed'}</td></tr>`;
 }).join('');
 const stress18=terminal.eps*18+a.dividend*10;
 const stressCAGR=stress18>0?Math.pow(stress18/price,0.1)-1:NaN;
 const cashWarning=a.dilution<0?`<p class="small ${cashGap>0?'warning':'muted'}">Simplified EPS sensitivity buyback assumption: ${a.shares.toFixed(1)}M → ${finalShares.toFixed(1)}M shares over 10 years. At <b>today's stock price held constant</b>, indicative repurchase spending is ${money(spendTotal)}M versus ${money(cashTotal)}M of cumulative simplified owner FCF; ${cashGap>0?`at least ${money(cashGap)}M of annual funding shortfalls before dividends, debt repayment or reinvestment.`:'no annual shortfall under this simplified price assumption.'} Actual future repurchase prices, available cash and capital needs may differ substantially. This is a funding diagnostic, not a funded buyback forecast.</p>`:'<p class="small muted">No net share retirement assumed in the manual scenario.</p>';
 return `<section class="assumption-review"><h3>Valuation reconciliation · screener vs manual</h3><p class="small muted">The screener blends valuation methods and applies underwriting adjustments. The editable EPS × P/E sensitivity is NOT the screener base case. The screener's own annual forecast and blended valuation appear above when Base is selected.</p><div class="table-scroll"><table><thead><tr><th>Driver</th><th>Screener</th><th>EPS sensitivity</th></tr></thead><tbody><tr><td>Year-10 revenue</td><td>${fmtB(modelRevenue)}</td><td>$${terminal.revenue.toFixed(2)}B</td></tr><tr><td>Year-10 net income</td><td>${fmtB(Number(modelLast?.netIncome))}</td><td>${money(terminal.ni)}M</td></tr><tr><td>Year-10 shares</td><td>${Number.isFinite(modelShares)?(modelShares/1e6).toFixed(1)+'M':'—'}</td><td>${finalShares.toFixed(1)}M</td></tr><tr><td>Year-10 EPS</td><td>${Number.isFinite(modelEPS)?money(modelEPS):'—'}</td><td>${money(terminal.eps)}</td></tr><tr><td>Year-10 exit value / share</td><td>${Number.isFinite(modelExit)?money(modelExit):'—'}</td><td>${money(r.exit)}</td></tr><tr><td>Exit P/E</td><td>${modelImpliedPE?modelImpliedPE.toFixed(1)+'× (blended implied; not an actual P/E)':'Not comparable'}</td><td>${a.multiple.toFixed(1)}×</td></tr><tr><td>Expected 10Y CAGR</td><td>${pct(stock.expectedReturn)}</td><td>${pct(r.cagr)}</td></tr><tr><td>${HURDLE_LABEL} + MOS entry</td><td>${money(Number(stock.requiredReturnBuyPrice))}</td><td>${money(r.buy)}</td></tr></tbody></table></div><p class="small muted">18× P/E sensitivity: ${money(terminal.eps*18)} exit, ${pct(stressCAGR)} CAGR (flat dividends included). Screener modeled return is ${pct(stock.expectedReturn)}; gap to your case is ${((Number(stock.expectedReturn)-r.cagr)*100).toFixed(1)} percentage points. Screener share counts are raw shares; manual share counts are in millions.</p><h4>Individual screener valuation methods</h4>${methodRows?`<div class="table-scroll"><table><thead><tr><th>Method</th><th>Year-10 target/share</th><th>Audit detail</th></tr></thead><tbody>${methodRows}</tbody></table></div>`:'<p class="small muted">Method-level values are missing from this screener snapshot.</p>'}<p class="small muted">The methods above are inputs to the blended model, not additive contributions. Exact weights and normalization adjustments are not exposed in the current feed; they cannot be independently reconstructed here.</p>${cashWarning}</section>`;
}
function renderValuation(){if(!current)return;$('noStock').hidden=true;$('valuation').hidden=false;ensurePath(assumptions);renderPathEditor();renderMethods();if(history)renderHistory();const a=assumptions,r=calculate(a),price=getPrice(current);const native=nativeScenario(),sc=$('scenario').value,rows=nativeRows(current),hasNative=rows.length>0;
 const modelCagr=nativeCAGR(current,sc),modelBuy=valid(current.requiredReturnBuyPrice,NaN);
 const modelExit=valid(current.tenYearPriceTarget,NaN);
 const underwritingCagr=valid(current.underwrittenCAGR,NaN);
 const underwritingFlags=Array.isArray(current.underwriting?.flags)?current.underwriting.flags:[];
 const attr=current.returnAttribution||{};
 const attrParts=[['Revenue growth',attr.revenueContribution],['Margin expansion',attr.marginContribution],['Share count',attr.shareCountContribution],['Dividends',attr.dividendContribution],['Residual / valuation re-rating',attr.multipleReratingContribution]];
 const headline=native&&hasNative?
  [['Base 10Y CAGR',pct(modelCagr),sc==='Base'?'Nightly screener valuation; not EPS × P/E':'Screener '+sc.toLowerCase()+' case; base forecast rows shown below'],['Underwritten 10Y CAGR',sc==='Base'?pct(underwritingCagr):'—','Conservative scenario used for buy price; not a probability-weighted forecast'],['Year-10 price',sc==='Base'?money(modelExit):'—',(()=>{const dv=valid(current.totalShareholderValue,NaN)-modelExit;return Number.isFinite(dv)&&dv>0.005?'Share price only. The CAGR also counts '+money(dv)+'/sh of dividends paid along the way':'Share price only; no dividends assumed';})()],[HURDLE_LABEL+' CAGR entry price',sc==='Base'?money(valid(current.hurdleReturnPrice,NaN)):'—','Native model; scenario-specific entry unavailable'],['Buy price with MOS',sc==='Base'?money(modelBuy):'—','Native '+HURDLE_LABEL+' + 10% MOS threshold']]:
  !r?null:(()=>{const mr=methodResults(a,r);return mr&&Number.isFinite(mr.cagr)?[['Blended 10Y CAGR',pct(mr.cagr),'Your inputs, all methods weighted'],['EPS × P/E 10Y CAGR',pct(r.cagr),'Table above on its own'],[HURDLE_LABEL+' CAGR entry price',money(mr.hurdle),'Blended, before margin of safety'],['Buy price with MOS',money(mr.buy),'Additional '+a.mos+'% discount']]:[['Expected 10Y CAGR',pct(r.cagr),'Custom EPS × P/E scenario'],['Year-10 exit price',money(r.exit),'EPS × terminal P/E'],[HURDLE_LABEL+' CAGR entry price',money(r.hurdle),'Before margin of safety'],['Buy price with MOS',money(r.buy),'Additional '+a.mos+'% discount']];})();
 if(headline&&native&&hasNative&&sc==='Base')headline.unshift(['Rating',esc(current.rating||'Unrated'),esc(ratingWhy(current))]);
 // Build 59: show whether the year-10 margin is supported by evidence.
 const me=current?.projectionAssumptions?.forecastBridge?.margins?.marginEvidence;
 if(headline&&native&&hasNative&&sc==='Base'&&me&&Number.isFinite(me.ceiling)){
  const yr10=valid(me.adjustedMature,NaN)+valid(me.cut?.mature,0),pre=valid(me.adjustedMature,NaN);
  const parts=[`today ${pct(me.adjustedNow)}`];
  if(Number.isFinite(me.best3YearAverage))parts.push(`best 3-yr ${pct(me.best3YearAverage)}`);
  if(Number.isFinite(me.consensusTwoYear))parts.push(`analysts' 2-yr ${pct(me.consensusTwoYear)}`);
  const why=me.applied?`Capped from ${pct(pre)}: above the evidence ceiling of ${pct(me.ceiling)} (${parts.join(', ')})${me.consensusContradicts?'; analysts expect margins to fall, so today\'s level gets no credit':''}`
   :`Within the evidence ceiling of ${pct(me.ceiling)} (${parts.join(', ')})`;
  headline.splice(1,0,['Year-10 margin check',pct(yr10),esc(why+'. Adjusted operating margin: before amortization, stock comp and one-offs.')]);
 }
 $('metrics').innerHTML=headline?headline.map(([k,v,d])=>`<div class="metric"><small>${k}</small><strong>${v}</strong><em>${d}</em></div>`).join(''):'<div class="notice">Missing required inputs. No projection invented.</div>';
 $('projectionRows').innerHTML=native&&hasNative?rows.map(y=>`<tr><td>${esc(y.year)}</td><td>${pct(valid(y.revenueGrowth,NaN))}</td><td>${pct(valid(y.netMargin,NaN))}</td><td>${money(Number(y.revenue)/1e9)}B</td><td>${money(y.netIncome==null?NaN:Number(y.netIncome)/1e6)}M</td><td>${money(y.eps==null?NaN:Number(y.eps))}</td><td>${money(y.fcf==null?NaN:Number(y.fcf)/1e6)}M</td></tr>`).join(''):(r?r.years.map(y=>`<tr><td>${y.year}</td><td>${pct(y.growth/100)}</td><td>${pct(y.netMargin/100)}</td><td>$${y.revenue.toFixed(2)}B</td><td>${money(y.ni)}M</td><td>${money(y.eps)}</td><td>${money(y.ownerFCF)}M</td></tr>`).join(''):'')
;const b=current.assumptions?.bridge||{},risk=current.investmentThesis?.risks||current.risks||[],strength=current.investmentThesis?.strengths||current.strengths||[];$('research').innerHTML=valuationReconciliationHTML(current,a,r)+assumptionReviewHTML()+`<section class="assumption-review"><h3>Why the base return may be optimistic</h3><p class="small muted">Base CAGR ${pct(current.expectedReturn)} versus underwritten CAGR ${pct(underwritingCagr)}. The buy price is calculated from the underwritten outcome, not the base return. These are scenarios, not statistically calibrated forecasts.</p><h4>Approximate annualized return drivers</h4><div class="table-scroll"><table><thead><tr><th>Driver</th><th>Annual contribution</th></tr></thead><tbody>${attrParts.map(([name,value])=>`<tr><td>${esc(name)}</td><td>${Number.isFinite(Number(value))&&value!=null?pct(Number(value)):'—'}</td></tr>`).join('')}</tbody></table></div><p class="small muted">Contributions are approximate and the valuation residual includes starting valuation effects; they are not independent sources of return.</p><h4>Underwriting flags</h4><p class="small">${underwritingFlags.length?underwritingFlags.map(x=>esc(x.replaceAll('_',' '))).join(' · '):'No automated underwriting flags; this does not validate the forecast.'}</p></section>`+`<div class="research-grid"><div><small>Screener vs simplified EPS sensitivity</small><b>${pct(current.expectedReturn)} vs ${r?pct(r.cagr):'—'}</b><p class="small muted">Difference: ${r&&present(current.expectedReturn)?((Number(current.expectedReturn)-r.cagr)*100).toFixed(1)+' percentage points':'unavailable'}. These are different valuation models; the nightly feed does not expose a fully comparable set of screener assumptions.</p></div><div><small>Model confidence (not a probability)</small><b>${modelConfidenceLabel(opportunity(current))}</b><p class="small muted">Model-derived agreement and coverage only; not a probability of accuracy.</p></div><div><small>Buyback assumption</small><b>${Number(a.dilution).toFixed(2)}% annual net dilution</b><p class="small muted">Negative means buybacks. Confirm cash cost and sustainability; compounded share changes can materially affect EPS.</p></div><div><small>Valuation bridge</small><b>Year-10 EPS ${r?money(r.years.at(-1).eps):'—'} × ${a.multiple} P/E</b><p class="small muted">Revenue growth, net margin, dilution and exit multiple determine your EPS-exit return.</p></div></div><p class="warning"><b>Normalization status: NOT VERIFIED.</b> The existing screener feed does not provide itemized, source-linked one-time adjustments. Do not assume earnings, cash flow, or acquisitions have been normalized. Review SEC filings before trusting a valuation.</p><div class="research-grid"><div><small>Model expected CAGR</small><b>${pct(current.expectedReturn)}</b></div><div><small>Model quality</small><b>${esc(current.qualityScore??'—')}</b></div><div><small>Analyst influence (year 1)</small><b>${pct(current.projectionAssumptions?.forecastBridge?.revenue?.analystWeightYear1??current.projectionAssumptions?.forecastBridge?.analystWeightYear1)}</b></div><div><small>Current price (nightly snapshot)</small><b>${money(price)}</b></div><div><small>Modeled risks</small>${risk.length?risk.map(x=>'<p class="small">'+esc(x)+'</p>').join(''):'No data-driven risk flags. That is not the same as no risk: the model cannot see competitive or technology threats, so read the latest filing.'}</div><div><small>Modeled strengths</small>${strength.length?strength.map(x=>'<p class="small">'+esc(x)+'</p>').join(''):'No specific strengths supplied'}</div></div><p class="muted small">SBC handling: stock-based pay is treated as a real cost. Net margin is GAAP (SBC already expensed) plus amortization of acquired intangibles; FCF is cash from operations minus capex minus SBC. Because the cost is already counted, the share-count path only includes dilution beyond employee grants (deals, converts). Company "adjusted" EPS and FCF figures usually add SBC back, so they will look higher than these numbers.</p><p><a href="https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(current.ticker)}" target="_blank" rel="noopener noreferrer">Search SEC filings for ${esc(current.ticker)} ↗</a></p>`;$('research').insertAdjacentHTML('afterbegin',growthCard(current));}

const histMetrics=['revenue','grossProfit','operatingIncome','netIncome','eps','ocf','capex','fcf','sbc','shares'];
function historyValue(row,key){const v=row?.[key];return Number.isFinite(v)?v:null;}
function historyFmt(key,v){if(v===null)return '—';if(key==='eps')return money(v);if(key==='shares')return (v/1e6).toFixed(1)+'M';return (v/1e9).toFixed(2)+'B';}
function historyPct(v){return Number.isFinite(v)?(v*100).toFixed(1)+'%':'—';}
function histAvg(arr){const vals=arr.filter(Number.isFinite);return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;}
function historyStats(key){const a=(history?.annual||[]).filter(x=>Number.isFinite(x[key])).slice(-6);if(!a.length)return null;const last=a.at(-1),prev=a.at(-2),start=a[0];const growth=(v0,v1,n)=>v0>0&&v1>0&&n>0?Math.pow(v1/v0,1/n)-1:null;return {latest:last[key],avg3:histAvg(a.slice(-3).map(x=>x[key])),avg5:histAvg(a.slice(-5).map(x=>x[key])),yoy:prev?growth(prev[key],last[key],1):null,cagr3:a.length>=4?growth(a.at(-4)[key],last[key],3):null,cagr5:a.length>=6?growth(start[key],last[key],5):null};}
function updateHistoryHints(){if(!current)return;const annual=history?.annual||[],last=annual.at(-1),first=annual[0];const stats=historyStats('revenue');const sMargin=historyStats('netIncome');const latestMargins=annual.slice(-5).map(x=>({net:x.revenue>0?x.netIncome/x.revenue:null,fcf:x.revenue>0?x.fcf/x.revenue:null,sbc:x.revenue>0?x.sbc/x.revenue:null}));const hints={revenue:last&&Number.isFinite(last.revenue)?'Latest FY '+historyFmt('revenue',last.revenue):null,growth:stats?'Latest YoY '+historyPct(stats.yoy)+' · 3Y CAGR '+historyPct(stats.cagr3)+' · 5Y CAGR '+historyPct(stats.cagr5):null,margin:'3Y net margin '+historyPct(histAvg(latestMargins.slice(-3).map(x=>x.net)))+' · 5Y '+historyPct(histAvg(latestMargins.map(x=>x.net))),fcfMargin:'3Y FCF margin '+historyPct(histAvg(latestMargins.slice(-3).map(x=>x.fcf)))+' · 5Y '+historyPct(histAvg(latestMargins.map(x=>x.fcf))),sbc:'3Y SBC/revenue '+historyPct(histAvg(latestMargins.slice(-3).map(x=>x.sbc)))+' · 5Y '+historyPct(histAvg(latestMargins.map(x=>x.sbc))),shares:last&&Number.isFinite(last.shares)?'Latest FY diluted '+historyFmt('shares',last.shares):null,dilution:historyStats('shares')?'3Y share CAGR '+historyPct(historyStats('shares').cagr3):null};for(const [key] of fields){const el=$('hint_'+key);if(el)el.textContent=key==='price'||key==='mos'?'':hints[key]|| (history?'No comparable SEC history available':'History not loaded');}}
async function loadHistory(ticker){const request=++historyRequest;history=null;$('historyStatus').textContent='Loading SEC historical financials for '+ticker+'…';$('historyRows').innerHTML='';$('historyChart').innerHTML='';updateHistoryHints();try{const r=await fetch('data/history/'+encodeURIComponent(ticker.toUpperCase())+'.json');if(!r.ok)throw Error(r.status===404?'History not generated for this ticker yet':'HTTP '+r.status);const d=await r.json();if(request!==historyRequest)return;history=d;if(!assumptionsEdited && $('scenario').value==='Custom'){const defaults=historyBasedDefaults(d);if(defaults){for(const [k,v] of Object.entries(defaults)){if(Number.isFinite(v))shiftEndpoint(assumptions,k,v);assumptions[k]=v;}renderFields();renderValuation();}}$('historyStatus').textContent='SEC reported history · '+(d.annual?.length||0)+' annual periods · '+(d.quarterly?.length||0)+' quarters · updated '+(d.generatedAt||'unknown');renderHistory();updateHistoryHints();renderValuation();}catch(e){if(request!==historyRequest)return;$('historyStatus').textContent='History unavailable: '+e.message+'. The nightly history job gradually populates companies.';updateHistoryHints();}}
function renderHistory(){if(!history)return;const period=$('historyPeriod').value,rows=(history[period]||[]).slice(- (period==='annual'?10:20)),metric=$('historyMetric').value;const columns=[['revenue','Revenue'],['grossProfit','Gross profit'],['operatingIncome','Operating income'],['netIncome','Net income'],['eps','Diluted EPS'],['ocf','Operating CF'],['capex','Capex'],['fcf','FCF'],['sbc','SBC'],['shares','Diluted shares']];$('historyHead').innerHTML='<tr><th>Period</th>'+columns.map(x=>'<th>'+x[1]+'</th>').join('')+'</tr>';$('historyRows').innerHTML=rows.slice().reverse().map(row=>'<tr><td>'+esc(row.period)+'</td>'+columns.map(([k])=>'<td>'+historyFmt(k,historyValue(row,k))+'</td>').join('')+'</tr>').join('')||'<tr><td colspan="11">No periods available</td></tr>';const proj=period==='annual'?projectedSeries().filter(x=>Number.isFinite(x[metric])):[];const values=[...rows,...proj].map(x=>x[metric]).filter(Number.isFinite),max=Math.max(1e-9,...values.map(Math.abs));const bar=(x,projected)=>{const v=projected?x[metric]:historyValue(x,metric),h=v===null||!Number.isFinite(v)?0:Math.max(2,Math.round(Math.abs(v)/max*110));return '<div class="history-bar-item'+(projected?' projected':'')+'" title="'+esc(x.period)+(projected?' (projected)':'')+' · '+historyFmt(metric,v)+'"><div class="history-bar '+(v<0?'negative-bar':'')+'" style="height:'+h+'px"></div><small>'+esc(period==='annual'?String(x.period).slice(-2):x.period.slice(2))+'</small></div>'};$('historyChart').innerHTML=rows.map(x=>bar(x,false)).join('')+(proj.length?'<div class="history-divider" title="Projection starts"></div>'+proj.map(x=>bar(x,true)).join(''):'');$('historyLegend').innerHTML=period!=='annual'?'Switch to Annual to compare with your projection.':proj.length?'<span class="lg lg-hist"></span> Reported (SEC) <span class="lg lg-proj"></span> Projected ('+esc(nativeScenario()?'model base case':'your custom path')+')':'No projection available for this metric in a custom scenario.';}

// Research discovery, not an intrinsic value calculation. Missing evidence is penalized.
const present=(v)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const bounded=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,v));
function researchFlags(s){
 const flags=[];
 const growth=present(s.fundamentalGrowthRate)?Number(s.fundamentalGrowthRate):null;
 const mos=present(s.marginOfSafety)?Number(s.marginOfSafety):null;
 const cagr=present(s.expectedReturn)?Number(s.expectedReturn):null;
 const quality=present(s.qualityScore)?Number(s.qualityScore):null;
 const methods=present(s.independentMethodCount)?Number(s.independentMethodCount):0;
 const confidence=present(s.valuationConfidenceScore)?Number(s.valuationConfidenceScore):null;
 if(growth!==null&&growth>0.35)flags.push('Very high modeled growth ('+pct(growth)+'); check sustainability');
 if(mos!==null&&mos>=0.40)flags.push('Large modeled discount ('+pct(mos)+'); check assumptions and data');
 if(quality!==null&&quality<75)flags.push('Quality below 75/100');
 if(methods<2)flags.push('Fewer than two modeled valuation methods');
 { const na=Number(s.analystEstimates?.numAnalysts); if(!(na>=3))flags.push('Thin analyst coverage ('+(Number.isFinite(na)?na:0)+'); no outside check on estimates'); }
 if(confidence!==null&&confidence<60)flags.push('Low model confidence');
 const rerating=Number(s.returnAttribution?.multipleReratingContribution);
 if(Number.isFinite(rerating)&&rerating>=.08)flags.push('Return depends on valuation re-rating ('+pct(rerating)+' annual contribution)');
 const base=Number(s.expectedCAGR),stressed=Number(s.underwrittenCAGR);
 if(Number.isFinite(base)&&Number.isFinite(stressed)&&base-stressed>=.035)flags.push('Underwriting reduces expected return by '+((base-stressed)*100).toFixed(1)+' points');
 if(cagr!==null&&cagr<HURDLE)flags.push('Below '+HURDLE_LABEL+' modeled CAGR hurdle');
 return flags;
}
function opportunity(s){
 const quality=present(s.qualityScore)?bounded(Number(s.qualityScore)):null;
 const growth=present(s.fundamentalGrowthRate)?Number(s.fundamentalGrowthRate):null;
 const baseReturn=present(s.expectedReturn)?Number(s.expectedReturn):null;
 const r=present(s.underwrittenCAGR)?Number(s.underwrittenCAGR):baseReturn;
 const rerating=present(s.returnAttribution?.multipleReratingContribution)?Math.max(0,Number(s.returnAttribution.multipleReratingContribution)):0;
 const mos=present(s.marginOfSafety)?Number(s.marginOfSafety):null;
 const entry=present(s.requiredReturnBuyPrice)&&present(getPrice(s))&&Number(getPrice(s))>0?Number(s.requiredReturnBuyPrice)/Number(getPrice(s))-1:null;
 const conf=present(s.valuationConfidenceScore)?bounded(Number(s.valuationConfidenceScore)):null;
 const methods=present(s.independentMethodCount)?Number(s.independentMethodCount):0;
 const flags=researchFlags(s);
 // A modeled discount is not proof of cheapness. Keep upside separate from evidence quality.
 // Scores are research-priority heuristics, NOT calibrated valuation probabilities.
 // Rank against the investor's actual hurdle (HURDLE) plus 10% MOS entry price, not the looser intrinsic-value discount.
 const upside=entry===null?null:bounded(50+30*Math.tanh(entry/.40));
 const returnScore=r===null?null:bounded(50+30*Math.tanh((r-HURDLE)/.10));
 const growthRisk=growth===null?8:growth>.50?22:growth>.35?15:growth>.25?8:0;
 const extremeDiscountRisk=mos===null?8:mos>=.65?16:mos>=.50?11:mos>=.40?6:0;
 const methodRisk=methods<2?16:methods===2?7:0;
 const missingRisk=[quality,growth,r,entry,conf].filter(x=>x===null).length*7;
 const valuation=upside===null||returnScore===null?null:bounded(.55*upside+.45*returnScore-growthRisk-extremeDiscountRisk-methodRisk-missingRisk);
 const confidence=conf===null?null:bounded(.50*conf+.25*(quality??50)+Math.min(3,methods)*5-growthRisk*.55-extremeDiscountRisk*.5-missingRisk);
 // Research priority uses the same stressed outcome as the investor buy-price test.
 // Re-rating is a source of upside, but it is not independently verified operating growth.
 const nA=present(s.analystEstimates?.numAnalysts)?Number(s.analystEstimates.numAnalysts):0;
 const mc=present(s.marketCap)?Number(s.marketCap):null;
 const thinPenalty=(nA<1?14:nA<3?10:nA<5?5:0)+(mc!==null&&mc<2.5e9?5:0)+(s.analystCheck?.divergence==='model_far_above_analysts'?10:0)+(r!==null&&r>.22?Math.min(12,(r-.22)*100):0);
 // Long-horizon quality focus: below-75 quality costs points; agreement with the engine rank adds a little.
 const qualityFloorPenalty=quality===null?10:quality<75?Math.min(20,(75-quality)*1.2):0;
 const orank=present(s.overallRank)?Number(s.overallRank):null;
 const rankAgreement=orank===null?0:orank<=10?8:orank<=25?5:orank<=50?2:0;
 const reratingPenalty=bounded(Math.max(0,rerating-.05)*160,0,30);
 const score=(valuation??0)*.45+(quality??0)*.35+(confidence??0)*.20-(r!==null&&r<HURDLE?25:0)-reratingPenalty-thinPenalty-qualityFloorPenalty+rankAgreement;
 const verdict=valuation===null?'Entry valuation unverified':entry!==null&&entry<0?'Above '+HURDLE_LABEL+' + MOS buy price':r!==null&&r<HURDLE?'Underwritten return below '+HURDLE_LABEL:rerating>=.12?'Re-rating dependent · review':quality!==null&&quality<75?'Higher-risk research':valuation>=65&&quality!==null&&quality>=80?'Priority research':valuation>=50?'Research candidate':'Assumptions need review';
 const reasons=[];
 if(mos!==null)reasons.push('Discount to intrinsic fair value '+pct(mos)+' (unverified)');
 if(entry!==null)reasons.push('Versus '+HURDLE_LABEL+' + 10% MOS buy price '+pct(entry)+' (unverified)');
 if(growth!==null&&growth>.25)reasons.push('Growth assumption '+pct(growth));
 if(methods<3)reasons.push(methods+' valuation methods');
 return {score,verdict,evidence:reasons,flags,valuation,quality,confidence,methods,growthRisk,extremeDiscountRisk,entry};
}
function setScreenerScale(value){
 const scale=bounded(Number(value),55,110);
 document.getElementById('screener').style.setProperty('--screener-scale',scale/100);
 $('screenZoomValue').textContent=scale+'%';
 $('screenZoom').value=scale;
 try{localStorage.setItem('stocktool-screener-zoom',String(scale))}catch(e){}
}
function companyFamily(t){const k=String(t||'').toUpperCase();return k==='GOOG'||k==='GOOGL'?'ALPHABET':k;}
// Build 56: research priority is a reading list, so keep it from being 10 versions of the same
// trade. At most 3 companies per sector in each block of 15 (3 in the top 15, 6 in the top 30...).
// A deferred company is not removed: it reappears as soon as its sector has room again.
const SECTOR_PER_BLOCK=3,SECTOR_BLOCK=15;
function sectorBalanced(list){
 const left=list.slice(),out=[],count={};
 while(left.length){
  const limit=SECTOR_PER_BLOCK*(1+Math.floor(out.length/SECTOR_BLOCK));
  let i=left.findIndex(s=>(count[s.sector||'Unknown']||0)<limit);
  if(i<0)i=0;
  const [s]=left.splice(i,1);const k=s.sector||'Unknown';count[k]=(count[k]||0)+1;out.push(s);
 }
 return out;
}
function modelConfidenceLabel(o){return o.confidence===null?'Insufficient data':Math.round(o.confidence)+'/100 (heuristic)';}
// Build 65: Growth Inflection (separate from the value ranking; backtested as arm G in the strategy lab)
const gpct=x=>Number.isFinite(x)?(x*100).toFixed(0)+'%':'—';
function growthCard(s){
 const g=s?.growth;if(!g)return '';
 if(!g.eligible)return `<section class="card"><h3>Growth Inflection</h3><p class="muted small">Not on the growth list: ${esc(g.why||'does not qualify')}.</p></section>`;
 const ex=g.exit||{};
 return `<section class="card"><h3>Growth Inflection · #${esc(g.rank)} of ${esc(g.universe)} growth companies</h3>
 <p><b>Score ${esc(g.score)}/100</b> · revenue growth ${gpct(g.revGrowth)} (${esc(g.growthBasis||'')}) · 12-month momentum ${gpct(g.momentum)} · Rule of 40 ${Number.isFinite(g.ruleOf40)?(g.ruleOf40*100).toFixed(0):'—'}</p>
 ${(g.reasonsUp||[]).length?'<p class="small"><b>Working:</b> '+g.reasonsUp.map(esc).join(' · ')+'</p>':''}
 ${(g.reasonsDown||[]).length?'<p class="small"><b>Watch:</b> '+g.reasonsDown.map(esc).join(' · ')+'</p>':''}
 <p class="small ${ex.exit?'warning':'muted'}">${ex.exit?'Exit rule triggered: '+esc(ex.reason):'Exit rule: sell if growth falls under 10%, the stock loses its 12-month momentum, or it drops to the bottom half of growth names.'}</p>
 <p class="muted small">Growth signals find runs that have started, not before they start. They work on average across many names and can crash together; size these smaller than value positions.</p></section>`;
}
function growthWhy(s){const g=s.growth||{};const up=(g.reasonsUp||[]).slice(0,2),dn=(g.reasonsDown||[]).slice(0,1);return `<strong>Growth score ${esc(g.score)}</strong>${up.length?'<div class="small">'+up.map(esc).join('<br>')+'</div>':''}${dn.length?'<div class="screen-card-flags">Watch: '+esc(dn[0])+'</div>':''}${g.exit?.exit?'<div class="screen-card-flags">Exit rule: '+esc(g.exit.reason)+'</div>':''}`;}
function renderScreener(){
 const minCap=Number($('minCap')?.value||0);try{localStorage.setItem('stocktool-mincap',String(minCap))}catch(e){}
 const q=$('search').value.toLowerCase(),sector=$('sector').value,positive=$('positive').checked,sort=$('sort').value;
 let arr=stocks.filter(s=>(s.ticker+' '+(s.name||'')).toLowerCase().includes(q)&&(!sector||s.sector===sector)&&(!minCap||num(s.marketCap,0)>=minCap)&&(!positive||present(s.underwrittenCAGR??s.expectedReturn)&&Number(s.underwrittenCAGR??s.expectedReturn)>0));
 const cached=new Map(arr.map(s=>[s,opportunity(s)]));
 arr.sort((a,b)=>sort==='opportunity'?cached.get(b).score-cached.get(a).score:sort==='return'?num(b.underwrittenCAGR??b.expectedReturn,-999)-num(a.underwrittenCAGR??a.expectedReturn,-999):sort==='quality'?num(b.qualityScore,-1)-num(a.qualityScore,-1):sort==='cap'?num(b.marketCap,-1)-num(a.marketCap,-1):num(a.overallRank,99999)-num(b.overallRank,99999));
 // Build 72: Buy candidates = the backtested entry rule (arm C: top-20 rank, underwritten return >= 11%, quality
 // 75+), the same rule the backtest and the new-money planner use. Replaces the strict "Buy" rating as the list to
 // act on (that rule, arm D, roughly matched SPY). Warnings are shown, not hidden.
 if(sort==='candidates')arr=arr.filter(s=>window.ReviewPolicy.shortlistEntry(s));
 if(sort==='peg'){const R=window.ReviewPolicy;arr=arr.filter(s=>R.pegEntry(s,{maxPeg:R.PEG.watchMax})).sort((a,b)=>R.pegOf(a).peg-R.pegOf(b).peg);}
 if(sort==='garp'){const R=window.ReviewPolicy;arr=arr.filter(s=>R.garpEntry(s,{minReturn:R.GARP.listMinReturn})).sort((a,b)=>num(b.underwrittenCAGR??b.expectedReturn,-9)-num(a.underwrittenCAGR??a.expectedReturn,-9));}
 if(sort==='growth')arr=stocks.filter(s=>s.growth?.eligible&&(s.ticker+' '+(s.name||'')).toLowerCase().includes(q)&&(!sector||s.sector===sector)&&(!minCap||num(s.marketCap,0)>=minCap)).sort((a,b)=>a.growth.rank-b.growth.rank);
 const seen=new Set();arr=arr.filter(s=>{const family=companyFamily(s.ticker);if(seen.has(family))return false;seen.add(family);return true;});
 const balanced=sort==='opportunity'&&!sector&&!q;
 if(balanced)arr=sectorBalanced(arr);
 $('count').textContent=sort==='garp'?`${arr.length} GARP stocks: quality 75+, revenue growing 10%+ a year, underwritten return 7%+, any model rank, best return first. 9%+ = buy zone. Being tested in the backtest (arm CG).`:sort==='candidates'?`${arr.length} buy candidates: top-20 model rank, underwritten return 11%+, quality 75+ (the backtested rule, strategy C). Few or none is normal when the market looks fully priced. Warnings are shown on the cards.`:`${arr.length} distinct companies of ${stocks.length} ticker listings · showing first ${Math.min(200,arr.length)} · Research scores are heuristic, not verified valuations${balanced?' · max 3 per sector in each 15 (pick a sector to see all of it)':''}`;
 const top=arr.slice(0,200);
 const returnSummary=s=>present(s.underwrittenCAGR)?pct(Number(s.underwrittenCAGR)):'—';
 const baseSummary=s=>present(s.expectedReturn)?pct(Number(s.expectedReturn)):'—';
 const head=document.querySelector('.screen-table thead tr');
 if(sort==='growth'){
  if(head)head.innerHTML='<th>Company</th><th>Sector</th><th>Price</th><th>Revenue growth</th><th>12-mo momentum</th><th>Why it is on the list</th><th>Growth #</th><th></th>';
  $('count').textContent=`${arr.length} growth companies (15%+ revenue growth, $300M+ revenue) · Growth Inflection is a separate list from the value ranking · backtest arm G`;
  $('screenRows').innerHTML=arr.slice(0,200).map(s=>`<tr><td><b>${esc(s.ticker)}</b><br><span class="muted">${esc(s.name||'')}</span></td><td>${esc(s.sector||'—')}</td><td>${money(getPrice(s))}</td><td>${gpct(s.growth.revGrowth)}<div class="muted small">${Number.isFinite(s.growth.revAccel)?(s.growth.revAccel>=0?'+':'')+(s.growth.revAccel*100).toFixed(0)+' pts vs 2Q ago':''}</div></td><td>${gpct(s.growth.momentum)}</td><td>${growthWhy(s)}</td><td>#${esc(s.growth.rank)}</td><td><button data-ticker="${esc(s.ticker)}">Research →</button></td></tr>`).join('');
  $('screenCards').innerHTML=arr.slice(0,200).map(s=>`<article class="screen-card compact"><div class="screen-card-head"><div><span class="screen-priority">Growth #${esc(s.growth.rank)}</span><strong>${esc(s.ticker)} <span class="muted">${esc(s.name||'')}</span></strong></div><span class="screen-card-rank">Value rank #${esc(s.overallRank??'—')}</span></div><div class="screen-card-stats"><span>Price <b>${money(getPrice(s))}</b></span><span>Revenue growth <b>${gpct(s.growth.revGrowth)}</b></span><span>3-yr <b>${gpct(s.growth.durableGrowth)}</b></span><span>Momentum <b>${gpct(s.growth.momentum)}</b></span></div><div class="screen-card-verdict">${growthWhy(s)}</div><div class="screen-card-footer"><span class="muted small">Growth signals, not a valuation</span><button data-ticker="${esc(s.ticker)}">Research →</button></div></article>`).join('');
  document.querySelectorAll('#screenRows [data-ticker],#screenCards [data-ticker]').forEach(b=>b.onclick=()=>choose(b.dataset.ticker));
  return;
 }
 // Build 73: plain-English table for the two lists you act on (GARP, Buy candidates).
 if(sort==='garp'||sort==='candidates'||sort==='peg'){const R=window.ReviewPolicy;
  const pegTxt=s=>{const p=R.pegOf(s);return p&&p.peg!==null?p.peg.toFixed(2):'—';};
  const status=s=>{const u=num(s.underwrittenCAGR??s.expectedReturn,NaN),buy=sort==='candidates'||(sort==='peg'?R.pegEntry(s):u>=R.GARP.minReturn);
   const w=R.entryWarnings(s),notes=[s.estimateRevision?.level?'analysts cut estimates':'',w.includes('split')?'valuation methods disagree':'',w.includes('cycle_peak')?'cyclical, profits near a peak':''].filter(Boolean);
   return {buy,label:buy?'Buy zone':'Watch',sub:buy?(notes.length?'Check: '+notes.join(', '):'No warnings'):(sort==='peg'?'PEG over '+R.PEG.buyMax.toFixed(1):'Return under '+pct(R.GARP.minReturn))+(notes.length?' · '+notes.join(', '):'')};};
  if(head)head.innerHTML='<th>Company</th><th>Sector</th><th>Price</th><th>5-yr PEG</th><th>Revenue growth</th><th>Quality</th><th>Model return / yr</th><th>Status</th><th></th>';
  $('screenRows').innerHTML=top.map(s=>{const st=status(s);return `<tr><td><b>${esc(s.ticker)}</b><br><span class="muted">${esc(s.name||'')}</span></td><td>${esc(s.sector||'—')}</td><td>${money(getPrice(s))}</td><td><b>${pegTxt(s)}</b></td><td>${pct(R.businessGrowthOf(s))}</td><td>${esc(s.qualityScore??'—')}</td><td>${returnSummary(s)}</td><td><span class="action ${st.buy?'act-buy':'act-review'}">${st.label}</span><div class="muted small" style="margin-top:4px">${esc(st.sub)}</div></td><td><button class="ghost" data-ticker="${esc(s.ticker)}">Research →</button></td></tr>`}).join('');
  $('screenCards').innerHTML=top.map(s=>{const st=status(s);return `<article class="screen-card compact"><div class="screen-card-head"><div><strong>${esc(s.ticker)} <span class="muted">${esc(s.name||'')}</span></strong></div><span class="action ${st.buy?'act-buy':'act-review'}">${st.label}</span></div><div class="screen-card-stats"><span>PEG <b>${pegTxt(s)}</b></span><span>Return <b>${returnSummary(s)}</b></span><span>Growth <b>${pct(R.businessGrowthOf(s))}</b></span><span>Quality <b>${esc(s.qualityScore??'—')}</b></span><span>Price <b>${money(getPrice(s))}</b></span></div><div class="screen-card-footer"><span class="muted small">${esc(st.sub)}</span><button class="ghost" data-ticker="${esc(s.ticker)}">Research →</button></div></article>`}).join('');
  if(sort==='peg')$('count').textContent=`${arr.length} quality growers: quality 75+, revenue growing 10%+, 5-yr PEG 2.0 or less, cheapest for its growth first. Buy zone = 1.5 or less. 5-yr PEG = next year’s P/E ÷ the model’s revenue-per-share growth per year over 5 years (margins held flat; dilution counts).`;
  if(sort==='garp')$('count').textContent=`${arr.length} quality growers: quality 75+, revenue growing 10%+ a year, expected return 7%+. Buy zone = 9%+ a year.`;
  document.querySelectorAll('#screenRows [data-ticker],#screenCards [data-ticker]').forEach(b=>b.onclick=()=>choose(b.dataset.ticker));
  return;
 }
 if(head)head.innerHTML='<th>Company</th><th>Sector</th><th>Price</th><th>Underwritten CAGR</th><th>Quality</th><th>Why research it?</th><th>Rank</th><th></th>';
 $('screenRows').innerHTML=top.map(s=>{const o=cached.get(s);return `<tr><td><b>${esc(s.ticker)}</b><br><span class="muted">${esc(s.name||'')}</span></td><td>${esc(s.sector||'—')}</td><td>${money(getPrice(s))}</td><td>${returnSummary(s)}<div class="muted small">Base ${baseSummary(s)}</div></td><td>${esc(s.qualityScore??'—')}</td><td><strong>${esc(o.verdict)}</strong><div class="muted small">Entry-price evidence ${o.valuation===null?'—':Math.round(o.valuation)+'/100'} · Model reliability ${esc(modelConfidenceLabel(o))}</div>${o.flags.length?'<div class="screen-card-flags">Review: '+esc(o.flags.slice(0,2).join(' · '))+'</div>':''}</td><td>${esc(s.overallRank??'—')}</td><td><button data-ticker="${esc(s.ticker)}">Research →</button></td></tr>`}).join('');
 $('screenCards').innerHTML=top.map((s,i)=>{const o=cached.get(s);return `<article class="screen-card compact"><div class="screen-card-head"><div><span class="screen-priority">${sort==='garp'?(window.ReviewPolicy.garpEntry(s)?'✅ GARP buy zone':'GARP watch'):window.ReviewPolicy.shortlistEntry(s)?'✅ Buy candidate':'Research #'+(i+1)}</span>${window.ReviewPolicy.entryWarnings(s).length?`<span class="small warning"> ${window.ReviewPolicy.entryWarnings(s).map(w=>w==='split'?'valuation split':'cyclical at peak').join(' · ')}</span>`:''}<strong>${esc(s.ticker)} <span class="muted">${esc(s.name||'')}</span></strong></div><span class="screen-card-rank">Rank #${esc(s.overallRank??'—')}</span></div><div class="screen-card-stats"><span>Price <b>${money(getPrice(s))}</b></span><span>Underwritten CAGR <b>${returnSummary(s)}</b></span><span>Quality <b>${esc(s.qualityScore??'—')}</b></span></div><div class="muted small">Base-case CAGR ${baseSummary(s)} · Re-rating contribution ${present(s.returnAttribution?.multipleReratingContribution)?pct(Number(s.returnAttribution.multipleReratingContribution)):'—'}</div>${s.rankGrowthPenalty>0?`<div class="small warning">Ranked lower: ${esc(s.rankGrowthPenaltyReason||'slow growth')} (${pct(Number(s.rankBusinessGrowth))}/yr)</div>`:''}${s.estimateRevision?.level?`<div class="small warning">${s.estimateRevision.level==='severe'?'⚠️ ':''}${esc(s.estimateRevision.label)}</div>`:''}${s.ttmOverlay?.through?`<div class="muted small">Margins include 10-Q results through ${esc(s.ttmOverlay.through)}</div>`:''}${s.rankCycleLabel?`<div class="small warning">${s.rankCyclePenalty>0?'Ranked lower: ':'Watch: '}${esc(s.rankCycleLabel)}${s.cycle?` (net margin ${pct(Number(s.cycle.marginNow))} vs ${pct(Number(s.cycle.marginMedian))} typical)`:''}</div>`:''}<div class="screen-card-verdict">${esc(o.verdict)}</div><div class="muted small">Entry-price evidence: <b>${o.valuation===null?'—':Math.round(o.valuation)+'/100'}</b> · Model reliability: <b>${esc(modelConfidenceLabel(o))}</b></div>${s.analystCheck?`<div class="muted small">Model fair value vs analyst target: <b>${(s.analystCheck.fairValueToTarget).toFixed(2)}×</b>${s.analystCheck.divergence?` · <span class="warning">${esc(s.analystCheck.divergence.replaceAll('_',' '))}</span>`:''}</div>`:''}<div class="muted small">${HURDLE_LABEL} + 10% MOS buy price: ${money(s.requiredReturnBuyPrice)} · ${o.entry===null?'Entry comparison unavailable':o.entry>=0?'Below entry threshold by '+pct(o.entry/(1+o.entry)):'Above entry threshold by '+pct(-o.entry)}</div>${o.flags.length?'<div class="screen-card-flags">Review: '+esc(o.flags.slice(0,2).join(' · '))+'</div>':''}<div class="screen-card-footer"><span class="muted small">${o.methods} methods · estimates unverified</span><button data-ticker="${esc(s.ticker)}">Research →</button></div></article>`}).join('');
 document.querySelectorAll('#screenRows [data-ticker],#screenCards [data-ticker]').forEach(b=>b.onclick=()=>choose(b.dataset.ticker));
}

async function fetchData(){try{const response=await fetch('data/results.json?refresh='+Date.now());if(!response.ok)throw Error('HTTP '+response.status);const d=await response.json();window.__generatedAt=d.generatedAt||null;const candidates=Array.isArray(d)?d:(Array.isArray(d.stocks)?d.stocks:Array.isArray(d.results)?d.results:Array.isArray(d.companies)?d.companies:Array.isArray(d.data)?d.data:[]);stocks=candidates.filter(s=>s&&s.ticker);byTicker=new Map(stocks.map(s=>[s.ticker.toUpperCase(),s]));$('freshness').textContent=stocks.length?`${stocks.length} companies · nightly data ${d.generatedAt||'unknown date'} · ${d.modelVersion||''}`:'No screener results yet — run the nightly workflow';const sectors=[...new Set(stocks.map(s=>s.sector).filter(Boolean))].sort();$('sector').innerHTML='<option value="">All sectors</option>'+sectors.map(x=>`<option>${esc(x)}</option>`).join('');renderScreener();renderPortfolio();}catch(e){$('freshness').textContent='Could not load nightly screener: '+e.message;toast('Screener data unavailable');}}
function requireAuth(){if(!client){toast('Configure your Supabase public URL and anon key in config.js');return false;}if(!user){$('authModal').hidden=false;return false;}return true;}
async function sync(){if(!user)return;try{const [p,h]=await Promise.all([client.from('stock_projections').select('*').order('updated_at',{ascending:false}),client.from('stock_holdings').select('*').order('updated_at',{ascending:false})]);if(p.error)throw p.error;if(h.error)throw h.error;saved=p.data||[];holdings=h.data||[];await loadSnapshots();renderPortfolio();}catch(e){toast('Cloud sync failed: '+e.message);}}
const SNAP_KEY='stocktool-review-snapshots';
function localSnapshots(){try{return JSON.parse(localStorage.getItem(SNAP_KEY)||'[]')}catch(e){return []}}
async function loadSnapshots(){
 // Cloud table is optional: if it has not been created yet, fall back to this device's storage.
 if(client&&user){try{const r=await client.from('review_snapshots').select('id,taken_at,data').order('taken_at',{ascending:false}).limit(40);if(!r.error){snapshots=(r.data||[]).map(x=>({id:x.id,...x.data,takenAt:x.taken_at}));snapshotStore='cloud';return;}}catch(e){}}
 snapshots=localSnapshots();snapshotStore='local';
}
// The "previous review" is the latest snapshot at least 30 days old, so re-saving on review day
// (or a few days later) never counts as a second consecutive reading.
let reviewCompareIdx=null;
function priorSnapshotIndex(){const i=snapshots.findIndex(x=>Date.now()-Date.parse(x.takenAt)>=30*864e5);return i;}
function priorSnapshot(){const i=priorSnapshotIndex();return i>=0?snapshots[i]:null;}
// Model-rank order: the order the backtested strategy buys in.
function rankedList(){
 const seen=new Set(),out=[];
 for(const s of [...stocks].filter(s=>present(s.overallRank)).sort((a,b)=>Number(a.overallRank)-Number(b.overallRank))){const f=companyFamily(s.ticker);if(seen.has(f))continue;seen.add(f);out.push(s);}
 return out;
}
function researchShortlist(){
 const scored=stocks.map(s=>[s,opportunity(s).score]).sort((a,b)=>b[1]-a[1]);
 const seen=new Set(),out=[];
 for(const [s] of scored){const f=companyFamily(s.ticker);if(seen.has(f))continue;seen.add(f);out.push(s);}
 return sectorBalanced(out);
}
async function saveSnapshot(){
 if(!stocks.length)return toast('Nightly data not loaded yet');
 if(!holdings.length&&!confirm('No holdings saved. Save a snapshot of the research shortlist only?'))return;
 reviewCompareIdx=null;
 const snap=window.ReviewPolicy.buildSnapshot({stocks,holdings,shortlist:rankedList(),prev:priorSnapshot(),generatedAt:window.__generatedAt||null});
 if(client&&user){const {error}=await client.from('review_snapshots').insert({user_id:user.id,taken_at:snap.takenAt,data:snap});if(!error){toast('Quarterly snapshot saved');await loadSnapshots();return renderPortfolio();}
  toast('Cloud snapshot table missing; saved on this device instead (run the new SQL to sync)');}
 const list=[snap,...localSnapshots()].slice(0,40);try{localStorage.setItem(SNAP_KEY,JSON.stringify(list))}catch(e){return toast('Could not save snapshot: '+e.message)}
 snapshots=list;snapshotStore='local';renderPortfolio();
}
function renderPlanner(){
 const el=$('plannerOut');if(!el||!window.ReviewPolicy)return;
 const cash=Number($('plannerCash')?.value||0);
 if(!(cash>0)){el.innerHTML='<p class="muted small">Enter an amount to see how to split it.</p>';return;}
 const hs=holdings.map(h=>{const t=String(h.ticker).toUpperCase(),s=byTicker.get(t),px=getPrice(s);return {ticker:t,value:Number.isFinite(px)?px*h.shares:0,stock:s}});
 const plan=window.ReviewPolicy.planContribution({holdings:hs,candidates:rankedList(),cash});
 const rows=plan.lines.map(l=>{const s=byTicker.get(l.ticker),px=getPrice(s);return `<tr><td><b>${esc(l.ticker)}</b>${l.isNew?' <span class="muted small">new</span>':''}</td><td>${money(l.amount)}</td><td>${Number.isFinite(px)&&px>0?(l.amount/px).toFixed(2):'—'}</td><td>${pct(l.resultingWeight)}</td><td>${esc(l.tier)}</td></tr>`}).join('');
 el.innerHTML=(rows?`<div class="table-scroll"><table><thead><tr><th>Ticker</th><th>Amount</th><th>≈ Shares</th><th>Weight after</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="small">Nothing qualifies to buy right now.</p>')+
 (plan.leftover>1?`<p class="small">Unallocated: <b>${money(plan.leftover)}</b>. Not enough names pass the buy rules today; holding cash or an index fund until next review is fine.</p>`:'')+
 `<p class="muted small">Buys only stocks ranked top 20 by the model with expected return ≥ ${HURDLE_LABEL} and quality 75+ (the rule the backtest tested), in rank order. Sizes run 3–10% at cost by conviction (return over ${HURDLE_LABEL}, quality, confidence, analyst coverage), max ${window.ReviewPolicy.SIZING.maxPositions} positions, 30% per sector on new buys. Existing holdings below target are topped up first. Suggestions, not orders.</p>`;
}
function renderReview(){
 const el=$('reviewPanel');if(!el||!window.ReviewPolicy)return;
 const RP=window.ReviewPolicy,pi=priorSnapshotIndex(),idx=reviewCompareIdx!==null&&snapshots[reviewCompareIdx]?reviewCompareIdx:(pi>=0?pi:0);
 const base=snapshots[idx]||null,latest=snapshots[0]||null;
 const ago=latest?Math.round((Date.now()-Date.parse(latest.takenAt))/864e5):null;
 const due=latest?RP.nextReviewDate(latest):null,overdue=ago!==null&&ago>=RP.BANDS.reviewDays;
 const head=latest?`Last snapshot <b>${esc(latest.takenAt.slice(0,10))}</b> (${ago} days ago) · next review ${overdue?'<b class="warning">due now</b>':'due <b>'+esc(due)+'</b>'}`:'No snapshot yet. Save one now, then come back each quarter.';
 const opts=snapshots.map((x,i)=>`<option value="${i}"${i===idx?' selected':''}>${esc(x.takenAt.slice(0,10))}</option>`).join('');
 let perf='';
 const pf=base?RP.shortlistPerformance(base,stocks):null;
 if(pf&&pf.pickCount){const diff=pf.universeReturn===null?null:pf.shortlistReturn-pf.universeReturn;
  perf=`<div class="metrics">${[['Top '+pf.pickCount+' ranked since '+base.takenAt.slice(0,10),pct(pf.shortlistReturn)],['All stocks (equal weight)',pct(pf.universeReturn)],['Shortlist vs all',diff===null?'—':(diff>=0?'+':'')+(diff*100).toFixed(1)+' pts'],['Days elapsed',pf.days]].map(([k,v])=>`<div class="metric"><small>${esc(k)}</small><strong>${v}</strong></div>`).join('')}</div>
  <p class="muted small">Price-only returns from nightly snapshot prices; dividends excluded. Under a year, this is mostly noise; judge after several quarters.</p>
  <details><summary class="small">Shortlist picks from that snapshot</summary><div class="table-scroll"><table><thead><tr><th>#</th><th>Ticker</th><th>Then</th><th>Now</th><th>Return</th></tr></thead><tbody>${(base.shortlist||[]).map(x=>{const s=byTicker.get(x.ticker),p=getPrice(s),r=x.price>0&&p>0?p/x.price-1:null;return `<tr><td>${x.position}</td><td>${esc(x.ticker)}</td><td>${money(x.price)}</td><td>${money(p)}</td><td>${r===null?'—':pct(r)}</td></tr>`}).join('')}</tbody></table></div></details>`;}
 el.innerHTML=`<p class="small">${head}</p><div class="toolbar"><button id="saveSnapshot" class="primary">Save quarterly snapshot</button>${snapshots.length?`<label class="small">Compare with <select id="reviewCompare">${opts}</select></label>`:''}</div>${perf}
 <p class="muted small">Rules: <b>Add candidate</b> = model rank top 20, expected return ≥ ${HURDLE_LABEL}, quality 75+, and below its target size. <b>Hold</b> = default; a lower rank alone is not a reason to sell. <b>Review</b> = quality under ${RP.BANDS.reviewQuality}, a quality drop of ${RP.BANDS.qualityDropReview}+ points, or a first reading of expected return under ${pct(RP.BANDS.lowReturn)}. <b>Sell candidate</b> = quality under ${RP.BANDS.sellQuality}, or expected return under ${pct(RP.BANDS.lowReturn)} at two reviews in a row. Statuses are prompts to do your own work, not trade signals.${snapshotStore==='local'?' Snapshots are stored on this device only.':''}</p>`;
 $('saveSnapshot').onclick=()=>requireAuth()&&saveSnapshot();
 renderPlanner();
 if($('reviewCompare'))$('reviewCompare').onchange=e=>{reviewCompareIdx=Number(e.target.value);renderReview();};
}
async function saveProjection(){if(!current)return toast('Choose a company first');if(nativeScenario())return toast('Select Custom or edit an assumption before saving; the nightly Base/Bear/Bull cases are not manual projections');if(!requireAuth())return;const r=calculate(assumptions);if(!r)return toast('Fill in valid assumptions before saving');const row={user_id:user.id,ticker:current.ticker,name:current.name||current.ticker,scenario:$('scenario').value,assumptions,notes:$('notes').value,updated_at:new Date().toISOString()};const {error}=await client.from('stock_projections').upsert(row,{onConflict:'user_id,ticker,scenario'});if(error)return toast(error.message);toast('Projection saved to Supabase');await sync();}
function loadSaved(ticker,scenario){const p=saved.find(p=>p.ticker===ticker&&p.scenario===scenario);if(!p)return toast('No saved scenario for this company');choose(ticker);$('scenario').value=scenario;const base=initial(current),sa=JSON.parse(JSON.stringify(p.assumptions||{}));if(!sa.path){delete base.path;delete base.shapes;}assumptions={...base,...sa};ensurePath(assumptions);assumptionsEdited=true;$('notes').value=p.notes||'';renderFields();renderValuation();}
async function saveHolding(){if(!requireAuth())return;const ticker=$('holdingTicker').value.trim().toUpperCase(),shares=Number($('holdingShares').value),cost=Number($('holdingCost').value);if(!ticker||!Number.isFinite(shares)||shares<0||!Number.isFinite(cost)||cost<0||!$('holdingShares').value||!$('holdingCost').value)return toast('Enter ticker, shares and cost per share');const {error}=await client.from('stock_holdings').upsert({user_id:user.id,ticker,shares,cost_basis:cost,updated_at:new Date().toISOString()},{onConflict:'user_id,ticker'});if(error)return toast(error.message);toast('Holding saved');await sync();}
async function remove(table,id){if(!requireAuth()||!confirm('Delete this saved item?'))return;const {error}=await client.from(table).delete().eq('id',id);if(error)return toast(error.message);await sync();}
function renderPortfolio(){let total=0,cost=0;const pvTotal=holdings.reduce((a,h)=>{const px=getPrice(byTicker.get(String(h.ticker).toUpperCase()));return a+(Number.isFinite(px)?px*h.shares:0)},0);const rows=holdings.map(h=>{const s=byTicker.get(h.ticker),price=getPrice(s),value=Number.isFinite(price)?price*h.shares:NaN,invested=h.cost_basis*h.shares;if(Number.isFinite(value)){total+=value;cost+=invested;}const prevH=(priorSnapshot()?.holdings||[]).find(x=>x.ticker===String(h.ticker).toUpperCase())||null,wt=pvTotal>0&&Number.isFinite(price)?price*h.shares/pvTotal:null,tw=window.ReviewPolicy&&s?window.ReviewPolicy.targetWeight(s):null,adv=window.ReviewPolicy?window.ReviewPolicy.holdingAdvice(s,prevH,{weight:wt}):null,st=adv?{status:adv.action,reasons:[adv.headline]}:null,stCls=adv?{Sell:'status-sell','Sell some':'status-review',Review:'status-review','Buy more':'status-add',Hold:'status-hold'}[adv.action]:'';const chg=prevH&&present(prevH.u)&&present(s?.underwrittenCAGR)?`<div class="muted small">CAGR ${pct(prevH.u)} → ${pct(Number(s.underwrittenCAGR))}${present(prevH.q)?' · Q '+prevH.q+' → '+esc(s?.qualityScore??'—'):''}</div>`:'';return `<tr><td>${esc(h.ticker)}</td><td class="status-cell">${st?`<span class="status-pill ${stCls}">${esc(st.status)}</span><div class="muted small">${esc(st.reasons[0])}</div>${chg}${wt!==null?`<div class="muted small">Weight ${pct(wt)}${tw!==null?' · target at cost '+pct(tw):''}</div>`:''}`:'—'}</td><td>${h.shares}</td><td>${money(h.cost_basis)}</td><td>${money(price)}</td><td>${money(value)}</td><td>${Number.isFinite(value)?money(value-invested):'—'}</td><td><button data-delete-h="${h.id}">Remove</button></td></tr>`});$('holdingRows').innerHTML=rows.join('')||'<tr><td colspan="8" class="muted">No holdings saved.</td></tr>';$('portfolioMetrics').innerHTML=[['Priced holdings value',money(total)],['Cost of priced holdings',money(cost)],['Unrealized gain/loss',money(total-cost)],['Saved projections',saved.length]].map(([k,v])=>`<div class="metric"><small>${k}</small><strong>${v}</strong></div>`).join('');$('savedRows').innerHTML=saved.map(p=>{const r=calculate(p.assumptions),mr=r?methodResults(p.assumptions,r):null;return `<tr><td>${esc(p.ticker)}</td><td>${esc(p.scenario)}</td><td>${mr&&Number.isFinite(mr.cagr)?pct(mr.cagr):r?pct(r.cagr):'—'}</td><td>${esc((p.updated_at||'').slice(0,10))}</td><td><button data-load="${esc(p.ticker)}" data-scenario="${esc(p.scenario)}">Open</button> <button data-delete-p="${p.id}">Delete</button></td></tr>`}).join('')||'<tr><td colspan="5" class="muted">No projections saved.</td></tr>';$('holdingRows').querySelectorAll('[data-delete-h]').forEach(b=>b.onclick=()=>remove('stock_holdings',b.dataset.deleteH));$('savedRows').querySelectorAll('[data-delete-p]').forEach(b=>b.onclick=()=>remove('stock_projections',b.dataset.deleteP));$('savedRows').querySelectorAll('[data-load]').forEach(b=>b.onclick=()=>loadSaved(b.dataset.load,b.dataset.scenario));renderReview();renderDashboard();}
async function auth(){if(!client)return;const {data:{session}}=await client.auth.getSession();user=session?.user||null;$('loginBtn').hidden=!!user;$('logoutBtn').hidden=!user;$('userLabel').textContent=user?.email||'';if(user)await sync();else{saved=[];holdings=[];snapshots=localSnapshots();snapshotStore='local';renderPortfolio();}}
async function submitAuth(kind){if(!client)return;const email=$('email').value.trim(),password=$('password').value;if(!email||!password)return $('authMessage').textContent='Enter email and password';const {error}=kind==='signUp'?await client.auth.signUp({email,password}):await client.auth.signInWithPassword({email,password});if(error)return $('authMessage').textContent=error.message;$('authMessage').textContent=kind==='signUp'?'Account created. Check your email for confirmation if required.':'Signed in.';await auth();if(user)$('authModal').hidden=true;}
async function boot(){document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));try{const mc=localStorage.getItem('stocktool-mincap');if(mc!==null&&$('minCap'))$('minCap').value=mc;}catch(e){}
if($('plannerCash'))$('plannerCash').addEventListener('input',renderPlanner);
['search','sector','sort','positive','minCap'].forEach(id=>$(id)&&$(id).addEventListener('input',renderScreener));$('screenZoom').addEventListener('input',e=>setScreenerScale(e.target.value));$('zoomOut').onclick=()=>setScreenerScale(Number($('screenZoom').value)-10);$('zoomIn').onclick=()=>setScreenerScale(Number($('screenZoom').value)+10);$('screenView').onchange=e=>{const cards=e.target.value==='cards';$('screener').classList.toggle('cards-mode',cards);try{localStorage.setItem('stocktool-screener-view',e.target.value)}catch(err){}};let preferredView='';try{preferredView=localStorage.getItem('stocktool-screener-view')||''}catch(err){};if(!preferredView)preferredView=window.matchMedia('(max-width: 760px)').matches?'cards':'table';$('screenView').value=preferredView;$('screener').classList.toggle('cards-mode',preferredView==='cards');try{setScreenerScale(Number(localStorage.getItem('stocktool-screener-zoom'))||80)}catch(e){setScreenerScale(80)}$('historyPeriod').onchange=renderHistory;$('historyMetric').onchange=renderHistory;$('tickerSearch').addEventListener('input',renderTickerMatches);$('tickerSearch').addEventListener('focus',renderTickerMatches);$('tickerSearch').addEventListener('keydown',e=>{if(e.key==='Escape')hideTickerMatches();if(e.key==='Enter'){const t=$('tickerMatches').querySelector('[data-ticker]');if(t){e.preventDefault();choose(t.dataset.ticker);}}});document.addEventListener('click',e=>{if(!e.target.closest('.ticker-search'))hideTickerMatches()});$('scenario').onchange=()=>{if(!current)return;assumptions=initial(current);assumptionsEdited=$('scenario').value==='Custom';renderFields();renderValuation();if(saved.some(p=>p.ticker===current.ticker&&p.scenario===$('scenario').value))toast('Saved scenario available — click Load saved scenario')};$('loadSaved').onclick=()=>current?loadSaved(current.ticker,$('scenario').value):toast('Choose a company');$('saveProjection').onclick=saveProjection;$('saveHolding').onclick=saveHolding;$('loginBtn').onclick=()=>requireAuth();$('closeAuth').onclick=()=>$('authModal').hidden=true;$('signIn').onclick=()=>submitAuth('signIn');$('signUp').onclick=()=>submitAuth('signUp');$('logoutBtn').onclick=async()=>{if(client)await client.auth.signOut();await auth();};const c=window.STOCK_CONFIG||{};if(c.supabaseUrl&&c.supabaseAnonKey&&window.supabase){client=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey);client.auth.onAuthStateChange(()=>setTimeout(auth,0));auth().catch(e=>toast('Cloud sign-in unavailable: '+e.message));}else toast('To enable cloud sync, configure public Supabase credentials in config.js');await fetchData();renderPortfolio();}
// ===== Build 73: Dashboard =====
// One screen: portfolio value, what to do with each holding and why, and the best new ideas (GARP buy zone).
const ACTION_CLASS={'Buy more':'act-buy',Hold:'act-hold','Sell some':'act-trim',Sell:'act-sell',Review:'act-review'};
function renderDashboard(){
 const el=$('dashboard');if(!el||!window.ReviewPolicy)return;
 const RP=window.ReviewPolicy,prior=priorSnapshot();
 const rows=holdings.map(h=>{const t=String(h.ticker).toUpperCase(),s=byTicker.get(t),px=getPrice(s);
  return {h,t,s,px,value:Number.isFinite(px)?px*h.shares:null,cost:num(h.cost_basis)*num(h.shares)};});
 const total=rows.reduce((a,r)=>a+(r.value||0),0),cost=rows.reduce((a,r)=>a+(Number.isFinite(r.value)?r.cost:0),0);
 for(const r of rows){r.weight=total>0&&r.value!==null?r.value/total:null;
  const prevH=(prior?.holdings||[]).find(x=>x.ticker===r.t)||null;r.advice=RP.holdingAdvice(r.s,prevH,{weight:r.weight});}
 rows.sort((a,b)=>(RP.ADVICE_ORDER[a.advice.action]??9)-(RP.ADVICE_ORDER[b.advice.action]??9)||(b.value||0)-(a.value||0));
 const count=k=>rows.filter(r=>r.advice.action===k).length;
 const gain=total-cost,gainPct=cost>0?gain/cost:null;
 const asOf=window.__generatedAt?String(window.__generatedAt).slice(0,10):'—';
 const kpis=[['Portfolio value',money(total),`${rows.length} holdings · prices as of ${esc(asOf)}`],
  ['Unrealized gain',`<span class="${gain>=0?'positive':'negative'}">${gain>=0?'+':''}${money(gain)}</span>`,gainPct===null?'':`<span class="${gain>=0?'positive':'negative'}">${gain>=0?'+':''}${pct(gainPct)}</span> on cost`],
  ['To do',`${count('Sell')+count('Sell some')+count('Buy more')}`,['Sell','Sell some','Buy more','Hold','Review'].filter(k=>count(k)).map(k=>`${count(k)} ${k.toLowerCase()}`).join(' · ')||'Nothing to do'],
  ['Next review',prior||snapshots[0]?esc(RP.nextReviewDate(snapshots[0])||'—'):'Not set','Save a snapshot each quarter in Portfolio']];
 const bar=(w,t)=>{if(w===null)return '';const W=Math.min(1,w/.25),T=t===null?null:Math.min(1,t/.25);
  return `<div class="wbar" title="Weight ${pct(w)}${t!==null?' · target '+pct(t):''}"><span class="wfill" style="width:${(W*100).toFixed(1)}%"></span>${T!==null?`<span class="wtarget" style="left:${(T*100).toFixed(1)}%"></span>`:''}</div><div class="wlabel">${pct(w)} of portfolio${t!==null?` · target ${pct(t)}`:''}</div>`;};
 // Build 75: your saved projection next to the model's view (it does not change the tested advice).
 const yourView=r=>{
  const sp=saved.filter(p=>String(p.ticker).toUpperCase()===r.t).sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||'')))[0];
  if(!sp)return `<div class="yourview empty-view"><span class="muted small">No projection of your own yet.</span> <button class="linkish" data-dticker="${esc(r.t)}">Add one →</button></div>`;
  let calc=null,u=null,peg=null;
  try{const A={...JSON.parse(JSON.stringify(sp.assumptions||{})),price:Number.isFinite(r.px)?r.px:sp.assumptions?.price};calc=calculate(A);const mr=calc?methodResults(A,calc):null;u=mr&&Number.isFinite(mr.cagr)?mr.cagr:calc?.cagr;
   const y=calc?.years||[],e1=y[0]?.eps,e6=y[5]?.eps;if(e1>0&&e6>0&&Number.isFinite(r.px)){const g=Math.pow(e6/e1,1/5)-1;if(g>0)peg=(r.px/e1)/(g*100);}}catch(e){}
  if(!Number.isFinite(u))return `<div class="yourview"><span class="muted small">Your ${esc(sp.scenario)} projection couldn’t be recalculated; open it to re-save.</span></div>`;
  const mv=r.s?(r.s.underwrittenCAGR??r.s.expectedCAGR):null,m=mv==null?NaN:Number(mv),d=Number.isFinite(m)?u-m:null;
  const act=r.advice.action;
  const note=u>=0.11&&/Sell/.test(act)?'Your projection sees a buy-level return while the model says sell. Compare the growth and margin assumptions.'
   :u<0.065&&/Buy|Hold/.test(act)?'Your projection sees it as expensive; the model is more forgiving.'
   :d!==null&&Math.abs(d)<0.03?'You and the model roughly agree.'
   :d!==null?`You’re ${d>0?'more optimistic':'more cautious'} than the model by ${Math.abs(d*100).toFixed(1)} pts a year.`:'';
  return `<div class="yourview"><div class="yv-head"><small>Your view · ${esc(sp.scenario)} · saved ${esc(String(sp.updated_at||'').slice(0,10))}</small></div>
   <div class="yv-stats"><div><small>Your return</small><b>${pct(u)}</b></div><div><small>Your 5Y PEG</small><b>${peg!==null?peg.toFixed(2):'—'}</b></div><div><small>Model return</small><b>${Number.isFinite(m)?pct(m):'—'}</b></div></div>
   ${note?`<p class="muted small" style="margin:6px 0 0">${esc(note)}</p>`:''}</div>`;
 };
 const card=r=>{const a=r.advice,s=r.s,u=s?(s.underwrittenCAGR??s.expectedCAGR):null,g=r.value!==null&&r.cost>0?r.value/r.cost-1:null;
  return `<article class="hcard ${ACTION_CLASS[a.action]||''}">
   <div class="hcard-top"><div><div class="hcard-ticker">${esc(r.t)}</div><div class="hcard-name">${esc(s?.name||'')}</div></div><span class="action ${ACTION_CLASS[a.action]||''}">${esc(a.action)}</span></div>
   <p class="hcard-headline">${esc(a.headline)}</p>
   <div class="hcard-stats"><div><small>Value</small><b>${money(r.value)}</b></div><div><small>Gain</small><b class="${g!==null&&g>=0?'positive':'negative'}">${g===null?'—':(g>=0?'+':'')+pct(g)}</b></div><div><small>5Y PEG</small><b>${(()=>{const p=RP.pegOf(s);return p&&p.peg!==null?p.peg.toFixed(2):'—';})()}</b></div><div><small>Return</small><b>${u===null||u===undefined?'—':pct(Number(u))}</b></div><div><small>Quality</small><b>${esc(s?.qualityScore??'—')}</b></div></div>
   ${bar(r.weight,a.target)}
   ${yourView(r)}
   ${a.reasons.length?`<details${a.action!=='Hold'?' open':''}><summary>Why</summary><ul>${a.reasons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}
   ${s?`<button class="ghost" data-dticker="${esc(r.t)}">Open research →</button>`:''}
  </article>`;};
 const heldFam=new Set(rows.map(r=>companyFamily(r.t)));
 const ideas=stocks.filter(s=>RP.pegEntry(s)&&!heldFam.has(companyFamily(s.ticker))).sort((a,b)=>RP.pegOf(a).peg-RP.pegOf(b).peg);
 const seenI=new Set(),ideaList=ideas.filter(s=>{const f=companyFamily(s.ticker);if(seenI.has(f))return false;seenI.add(f);return true;}).slice(0,8);
 const idea=s=>{const w=RP.entryWarnings(s),rv=s.estimateRevision?.level;return `<button class="idea" data-dticker="${esc(s.ticker)}"><span class="idea-t">${esc(s.ticker)}</span><span class="idea-n">${esc(s.name||'')}</span><span class="idea-m">${RP.pegOf(s).peg.toFixed(2)}<small>PEG</small></span><span class="idea-m">${pct(RP.businessGrowthOf(s))}<small>growth</small></span><span class="idea-m">${esc(s.qualityScore)}<small>quality</small></span>${w.length||rv?`<span class="idea-warn">${[rv?'estimate cut':'',w.includes('split')?'valuation split':'',w.includes('cycle_peak')?'cyclical peak':''].filter(Boolean).join(' · ')}</span>`:''}</button>`;};
 const signedOut=!user;
 el.innerHTML=`
  <div class="kpis">${kpis.map(([k,v,sub])=>`<div class="kpi"><small>${k}</small><strong>${v}</strong><em>${sub}</em></div>`).join('')}</div>
  <section class="dash-section"><div class="section-head"><h2>Your holdings</h2><span class="muted small">Sorted by what needs attention first</span></div>
   ${rows.some(r=>/Sell/.test(r.advice.action))?'<p class="muted small">Before selling in a taxable account: shares held under a year are taxed at the higher short-term rate, so check the purchase date. Selling part now and the rest after it turns a year old can be cheaper.</p>':''}
   ${signedOut?`<div class="empty"><p>Sign in to see buy / hold / sell advice for your holdings.</p><button class="primary" id="dashSignIn">Sign in</button></div>`
    :rows.length?`<div class="hgrid">${rows.map(card).join('')}</div>`:`<div class="empty"><p>No holdings yet. Add them under Portfolio.</p><button class="primary" data-goto="portfolio">Add holdings</button></div>`}
  </section>
  <section class="dash-section"><div class="section-head"><h2>Ideas for new money</h2><button class="ghost" data-goto="screener">See all ideas →</button></div>
   <p class="muted small">PEG buy zone: quality 75+, revenue growing 10%+, 5-yr PEG 1.5 or less. Cheapest for its growth first; you don’t own these yet.</p>
   ${ideaList.length?`<div class="ideas">${ideaList.map(idea).join('')}</div>`:'<div class="empty"><p>Nothing in the buy zone tonight. Holding cash or an index fund until prices improve is fine.</p></div>'}
  </section>
  <p class="disclaimer">Advice comes from the model’s backtested rules applied to tonight’s data. It is a prompt to do your own research, not financial advice. Expected returns are estimates, and the backtest (2019–2025, before taxes) leaned on a handful of big winners.</p>`;
 el.querySelectorAll('[data-dticker]').forEach(b=>b.onclick=()=>choose(b.dataset.dticker));
 el.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>page(b.dataset.goto));
 if($('dashSignIn'))$('dashSignIn').onclick=()=>requireAuth();
}

boot();
