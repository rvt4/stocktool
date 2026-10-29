"use strict";
const $=id=>document.getElementById(id), num=(x,f=0)=>Number.isFinite(Number(x))?Number(x):f;
const money=x=>Number.isFinite(x)?'$'+x.toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2}):'—';
const pct=x=>Number.isFinite(x)?(x*100).toFixed(1)+'%':'—';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let stocks=[],byTicker=new Map(),current=null,assumptions={},client=null,user=null,saved=[],holdings=[],history=null,historyRequest=0,assumptionsEdited=false;
const toast=msg=>{ $('toast').textContent=msg;$('toast').style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('toast').style.display='none',4500)};
const valid=(x,f)=>Number.isFinite(Number(x))?Number(x):f;
function page(id){document.querySelectorAll('.page').forEach(e=>e.hidden=e.id!==id);document.querySelectorAll('nav button').forEach(e=>e.classList.toggle('active',e.dataset.page===id));}
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
 return {revenue:startingRevenue/1e9,growth:Number.isFinite(g1)?g1*100:valid(a.revenueGrowthAnchor,0.06)*100,terminalGrowth:Number.isFinite(g10)?g10*100:valid(a.terminalGrowth,0.03)*100,margin:valid(last.netMargin??a.marginAssumptions?.netTarget,NaN)*100,fcfMargin:valid(last.fcfMargin??a.marginAssumptions?.fcfTarget,NaN)*100,sbc:valid(last.sbcMargin??a.marginAssumptions?.sbcMarginTarget,0)*100,shares:shareBase/1e6,dilution:shareChange*100,multiple:Number.isFinite(multiple)?multiple:18,price:getPrice(s),dividend,mos:20};
}
function nativeScenario(){return $('scenario').value!=='Custom'&&!assumptionsEdited;}
function nativeRows(s){return Array.isArray(s?.valuationProjection)?s.valuationProjection:[];}
function nativeCAGR(s,scenario){return valid(s?.[scenario==='Bear'?'bearCAGR':scenario==='Bull'?'bullCAGR':'expectedReturn'],NaN);}

const fields=[['revenue','Current annual revenue ($ billions)',0.01,0.01],['growth','Year-1 revenue growth (%)',0.5,-50],['terminalGrowth','Year-10 revenue growth (%)',0.5,-20],['margin','Year-10 net margin after SBC (%)',0.5,-50],['fcfMargin','Year-10 FCF margin before SBC adjustment (%)',0.5,-50],['sbc','SBC as % of revenue (%)',0.5,0.1],['shares','Current diluted shares (millions)',1,0.01],['dilution','Annual net share dilution (%)',0.25,-20],['multiple','Terminal P/E multiple',1,1],['price','Current stock price ($)',1,0.01],['dividend','Annual dividend/share ($), held flat',0.1,0],['mos','Additional margin of safety (%)',1,0]];
function hideTickerMatches(){$('tickerMatches').hidden=true;$('tickerSearch').setAttribute('aria-expanded','false')}
function renderTickerMatches(){const q=$('tickerSearch').value.trim().toLowerCase(),matches=stocks.filter(s=>!q||s.ticker.toLowerCase().includes(q)||(s.name||'').toLowerCase().includes(q)).sort((a,b)=>{const score=s=>s.ticker.toLowerCase()===q?0:s.ticker.toLowerCase().startsWith(q)?1:(s.name||'').toLowerCase().startsWith(q)?2:3;return score(a)-score(b)||a.ticker.localeCompare(b.ticker)}).slice(0,12);const box=$('tickerMatches');box.innerHTML=matches.map(s=>`<button type="button" role="option" data-ticker="${esc(s.ticker)}"><strong>${esc(s.ticker)}</strong> <span>${esc(s.name||'')}</span></button>`).join('')||'<p class="muted small">No matching companies</p>';box.hidden=false;$('tickerSearch').setAttribute('aria-expanded','true');box.querySelectorAll('[data-ticker]').forEach(b=>b.onclick=()=>choose(b.dataset.ticker))}
function choose(t){$('scenario').value='Base';current=byTicker.get(t);if(!current)return;assumptions=initial(current);assumptionsEdited=false;$('tickerSearch').value=t+' · '+(current.name||'');hideTickerMatches();$('notes').value='';renderFields();renderValuation();page('projections');loadHistory(t);}
function renderFields(){ $('assumptions').innerHTML=fields.map(([key,label,step,min])=>`<div class="field"><div><label for="a_${key}">${esc(label)}</label><input id="a_${key}" data-key="${key}" type="number" step="${step}" min="${min}" value="${Number.isFinite(assumptions[key])?Number(assumptions[key].toFixed(2)):''}" placeholder="Required"></div><div class="history-hint" id="hint_${key}">History loading…</div></div>`).join('');$('assumptions').querySelectorAll('input').forEach(el=>el.addEventListener('input',()=>{assumptionsEdited=true;$('scenario').value='Custom';assumptions[el.dataset.key]=el.value===''?NaN:Number(el.value);renderValuation()}));}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function calculate(a){
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
  const ownerFCF=r*1000*(fm-sbc)/100;
  years.push({year:new Date().getFullYear()+i,revenue:r,ni,eps:ni/sh,ownerFCF,growth:g,netMargin:nm,fcfMargin:fm});
 }
 const exit=years.at(-1).eps*multiple;
 const totalDiv=dividend*10;
 const value=exit+totalDiv;
 const cagr=value>0?Math.pow(value/price,1/10)-1:NaN;
 const hurdle=value/Math.pow(1.15,10);
 return {years,exit,cagr,hurdle,buy:hurdle*(1-mos/100),value};
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
 return `<section class="assumption-review"><h3>Valuation reconciliation · screener vs manual</h3><p class="small muted">The screener blends valuation methods and applies underwriting adjustments. The editable EPS × P/E sensitivity is NOT the screener base case. The screener's own annual forecast and blended valuation appear above when Base is selected.</p><div class="table-scroll"><table><thead><tr><th>Driver</th><th>Screener</th><th>EPS sensitivity</th></tr></thead><tbody><tr><td>Year-10 revenue</td><td>${fmtB(modelRevenue)}</td><td>$${terminal.revenue.toFixed(2)}B</td></tr><tr><td>Year-10 net income</td><td>${fmtB(Number(modelLast?.netIncome))}</td><td>${money(terminal.ni)}M</td></tr><tr><td>Year-10 shares</td><td>${Number.isFinite(modelShares)?(modelShares/1e6).toFixed(1)+'M':'—'}</td><td>${finalShares.toFixed(1)}M</td></tr><tr><td>Year-10 EPS</td><td>${Number.isFinite(modelEPS)?money(modelEPS):'—'}</td><td>${money(terminal.eps)}</td></tr><tr><td>Year-10 exit value / share</td><td>${Number.isFinite(modelExit)?money(modelExit):'—'}</td><td>${money(r.exit)}</td></tr><tr><td>Exit P/E</td><td>${modelImpliedPE?modelImpliedPE.toFixed(1)+'× (blended implied; not an actual P/E)':'Not comparable'}</td><td>${a.multiple.toFixed(1)}×</td></tr><tr><td>Expected 10Y CAGR</td><td>${pct(stock.expectedReturn)}</td><td>${pct(r.cagr)}</td></tr><tr><td>15% + MOS entry</td><td>${money(Number(stock.requiredReturnBuyPrice))}</td><td>${money(r.buy)}</td></tr></tbody></table></div><p class="small muted">18× P/E sensitivity: ${money(terminal.eps*18)} exit, ${pct(stressCAGR)} CAGR (flat dividends included). Screener modeled return is ${pct(stock.expectedReturn)}; gap to your case is ${((Number(stock.expectedReturn)-r.cagr)*100).toFixed(1)} percentage points. Screener share counts are raw shares; manual share counts are in millions.</p><h4>Individual screener valuation methods</h4>${methodRows?`<div class="table-scroll"><table><thead><tr><th>Method</th><th>Year-10 target/share</th><th>Audit detail</th></tr></thead><tbody>${methodRows}</tbody></table></div>`:'<p class="small muted">Method-level values are missing from this screener snapshot.</p>'}<p class="small muted">The methods above are inputs to the blended model, not additive contributions. Exact weights and normalization adjustments are not exposed in the current feed; they cannot be independently reconstructed here.</p>${cashWarning}</section>`;
}
function renderValuation(){if(!current)return;$('noStock').hidden=true;$('valuation').hidden=false;const a=assumptions,r=calculate(a),price=getPrice(current);const native=nativeScenario(),sc=$('scenario').value,rows=nativeRows(current),hasNative=rows.length>0;
 const modelCagr=nativeCAGR(current,sc),modelBuy=valid(current.requiredReturnBuyPrice,NaN);
 const modelExit=valid(current.tenYearPriceTarget,NaN);
 const underwritingCagr=valid(current.underwrittenCAGR,NaN);
 const underwritingFlags=Array.isArray(current.underwriting?.flags)?current.underwriting.flags:[];
 const attr=current.returnAttribution||{};
 const attrParts=[['Revenue growth',attr.revenueContribution],['Margin expansion',attr.marginContribution],['Share count',attr.shareCountContribution],['Dividends',attr.dividendContribution],['Residual / valuation re-rating',attr.multipleReratingContribution]];
 const headline=native&&hasNative?
  [['Base 10Y CAGR',pct(modelCagr),sc==='Base'?'Nightly screener valuation; not EPS × P/E':'Screener '+sc.toLowerCase()+' case; base forecast rows shown below'],['Underwritten 10Y CAGR',sc==='Base'?pct(underwritingCagr):'—','Conservative scenario used for buy price; not a probability-weighted forecast'],['Year-10 exit price',sc==='Base'?money(modelExit):'—','Blended screener valuation; not a terminal P/E'],['15% CAGR entry price',sc==='Base'?money(valid(current.hurdleReturnPrice,NaN)):'—','Native model; scenario-specific entry unavailable'],['Buy price with MOS',sc==='Base'?money(modelBuy):'—','Native 15% + 20% MOS threshold']]:
  !r?null:[['Expected 10Y CAGR',pct(r.cagr),'Custom EPS × P/E scenario'],['Year-10 exit price',money(r.exit),'EPS × terminal P/E'],['15% CAGR entry price',money(r.hurdle),'Before margin of safety'],['Buy price with MOS',money(r.buy),'Additional '+a.mos+'% discount']];
 $('metrics').innerHTML=headline?headline.map(([k,v,d])=>`<div class="metric"><small>${k}</small><strong>${v}</strong><em>${d}</em></div>`).join(''):'<div class="notice">Missing required inputs. No projection invented.</div>';
 $('projectionRows').innerHTML=native&&hasNative?rows.map(y=>`<tr><td>${esc(y.year)}</td><td>${money(Number(y.revenue)/1e9)}B</td><td>${money(y.netIncome==null?NaN:Number(y.netIncome)/1e6)}M</td><td>${money(y.eps==null?NaN:Number(y.eps))}</td><td>${money(y.fcf==null?NaN:Number(y.fcf)/1e6)}M</td></tr>`).join(''):(r?r.years.map(y=>`<tr><td>${y.year}</td><td>$${y.revenue.toFixed(2)}B</td><td>${money(y.ni)}M</td><td>${money(y.eps)}</td><td>${money(y.ownerFCF)}M</td></tr>`).join(''):'')
;const b=current.assumptions?.bridge||{},risk=current.investmentThesis?.risks||current.risks||[],strength=current.investmentThesis?.strengths||current.strengths||[];$('research').innerHTML=valuationReconciliationHTML(current,a,r)+assumptionReviewHTML()+`<section class="assumption-review"><h3>Why the base return may be optimistic</h3><p class="small muted">Base CAGR ${pct(current.expectedReturn)} versus underwritten CAGR ${pct(underwritingCagr)}. The buy price is calculated from the underwritten outcome, not the base return. These are scenarios, not statistically calibrated forecasts.</p><h4>Approximate annualized return drivers</h4><div class="table-scroll"><table><thead><tr><th>Driver</th><th>Annual contribution</th></tr></thead><tbody>${attrParts.map(([name,value])=>`<tr><td>${esc(name)}</td><td>${Number.isFinite(Number(value))&&value!=null?pct(Number(value)):'—'}</td></tr>`).join('')}</tbody></table></div><p class="small muted">Contributions are approximate and the valuation residual includes starting valuation effects; they are not independent sources of return.</p><h4>Underwriting flags</h4><p class="small">${underwritingFlags.length?underwritingFlags.map(x=>esc(x.replaceAll('_',' '))).join(' · '):'No automated underwriting flags; this does not validate the forecast.'}</p></section>`+`<div class="research-grid"><div><small>Screener vs simplified EPS sensitivity</small><b>${pct(current.expectedReturn)} vs ${r?pct(r.cagr):'—'}</b><p class="small muted">Difference: ${r&&present(current.expectedReturn)?((Number(current.expectedReturn)-r.cagr)*100).toFixed(1)+' percentage points':'unavailable'}. These are different valuation models; the nightly feed does not expose a fully comparable set of screener assumptions.</p></div><div><small>Model confidence (not a probability)</small><b>${modelConfidenceLabel(opportunity(current))}</b><p class="small muted">Model-derived agreement and coverage only; not a probability of accuracy.</p></div><div><small>Buyback assumption</small><b>${Number(a.dilution).toFixed(2)}% annual net dilution</b><p class="small muted">Negative means buybacks. Confirm cash cost and sustainability; compounded share changes can materially affect EPS.</p></div><div><small>Valuation bridge</small><b>Year-10 EPS ${r?money(r.years.at(-1).eps):'—'} × ${a.multiple} P/E</b><p class="small muted">Revenue growth, net margin, dilution and exit multiple determine your EPS-exit return.</p></div></div><p class="warning"><b>Normalization status: NOT VERIFIED.</b> The existing screener feed does not provide itemized, source-linked one-time adjustments. Do not assume earnings, cash flow, or acquisitions have been normalized. Review SEC filings before trusting a valuation.</p><div class="research-grid"><div><small>Model expected CAGR</small><b>${pct(current.expectedReturn)}</b></div><div><small>Model quality</small><b>${esc(current.qualityScore??'—')}</b></div><div><small>Analyst influence (year 1)</small><b>${pct(current.projectionAssumptions?.forecastBridge?.analystWeightYear1)}</b></div><div><small>Current price (nightly snapshot)</small><b>${money(price)}</b></div><div><small>Modeled risks</small>${risk.length?risk.map(x=>'<p class="small">'+esc(x)+'</p>').join(''):'No specific risks supplied'}</div><div><small>Modeled strengths</small>${strength.length?strength.map(x=>'<p class="small">'+esc(x)+'</p>').join(''):'No specific strengths supplied'}</div></div><p class="muted small">SBC handling: net income margin is assumed to already include SBC expense. FCF margin is treated as pre-SBC owner adjustment and SBC is subtracted once. This is a simplified screening valuation, not audited owner earnings. EPS and FCF are displayed separately; the exit price uses EPS only. Verify whether your starting FCF margin already deducts SBC before entering it.</p><p><a href="https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(current.ticker)}" target="_blank" rel="noopener noreferrer">Search SEC filings for ${esc(current.ticker)} ↗</a></p>`;}

const histMetrics=['revenue','grossProfit','operatingIncome','netIncome','eps','ocf','capex','fcf','sbc','shares'];
function historyValue(row,key){const v=row?.[key];return Number.isFinite(v)?v:null;}
function historyFmt(key,v){if(v===null)return '—';if(key==='eps')return money(v);if(key==='shares')return (v/1e6).toFixed(1)+'M';return (v/1e9).toFixed(2)+'B';}
function historyPct(v){return Number.isFinite(v)?(v*100).toFixed(1)+'%':'—';}
function histAvg(arr){const vals=arr.filter(Number.isFinite);return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;}
function historyStats(key){const a=(history?.annual||[]).filter(x=>Number.isFinite(x[key])).slice(-6);if(!a.length)return null;const last=a.at(-1),prev=a.at(-2),start=a[0];const growth=(v0,v1,n)=>v0>0&&v1>0&&n>0?Math.pow(v1/v0,1/n)-1:null;return {latest:last[key],avg3:histAvg(a.slice(-3).map(x=>x[key])),avg5:histAvg(a.slice(-5).map(x=>x[key])),yoy:prev?growth(prev[key],last[key],1):null,cagr3:a.length>=4?growth(a.at(-4)[key],last[key],3):null,cagr5:a.length>=6?growth(start[key],last[key],5):null};}
function updateHistoryHints(){if(!current)return;const annual=history?.annual||[],last=annual.at(-1),first=annual[0];const stats=historyStats('revenue');const sMargin=historyStats('netIncome');const latestMargins=annual.slice(-5).map(x=>({net:x.revenue>0?x.netIncome/x.revenue:null,fcf:x.revenue>0?x.fcf/x.revenue:null,sbc:x.revenue>0?x.sbc/x.revenue:null}));const hints={revenue:last&&Number.isFinite(last.revenue)?'Latest FY '+historyFmt('revenue',last.revenue):null,growth:stats?'Latest YoY '+historyPct(stats.yoy)+' · 3Y CAGR '+historyPct(stats.cagr3)+' · 5Y CAGR '+historyPct(stats.cagr5):null,margin:'3Y net margin '+historyPct(histAvg(latestMargins.slice(-3).map(x=>x.net)))+' · 5Y '+historyPct(histAvg(latestMargins.map(x=>x.net))),fcfMargin:'3Y FCF margin '+historyPct(histAvg(latestMargins.slice(-3).map(x=>x.fcf)))+' · 5Y '+historyPct(histAvg(latestMargins.map(x=>x.fcf))),sbc:'3Y SBC/revenue '+historyPct(histAvg(latestMargins.slice(-3).map(x=>x.sbc)))+' · 5Y '+historyPct(histAvg(latestMargins.map(x=>x.sbc))),shares:last&&Number.isFinite(last.shares)?'Latest FY diluted '+historyFmt('shares',last.shares):null,dilution:historyStats('shares')?'3Y share CAGR '+historyPct(historyStats('shares').cagr3):null};for(const [key] of fields){const el=$('hint_'+key);if(el)el.textContent=hints[key]|| (history?'No comparable SEC history available':'History not loaded');}}
async function loadHistory(ticker){const request=++historyRequest;history=null;$('historyStatus').textContent='Loading SEC historical financials for '+ticker+'…';$('historyRows').innerHTML='';$('historyChart').innerHTML='';updateHistoryHints();try{const r=await fetch('data/history/'+encodeURIComponent(ticker.toUpperCase())+'.json');if(!r.ok)throw Error(r.status===404?'History not generated for this ticker yet':'HTTP '+r.status);const d=await r.json();if(request!==historyRequest)return;history=d;if(!assumptionsEdited && $('scenario').value==='Custom'){const defaults=historyBasedDefaults(d);if(defaults){assumptions={...assumptions,...defaults};renderFields();renderValuation();}}$('historyStatus').textContent='SEC reported history · '+(d.annual?.length||0)+' annual periods · '+(d.quarterly?.length||0)+' quarters · updated '+(d.generatedAt||'unknown');renderHistory();updateHistoryHints();renderValuation();}catch(e){if(request!==historyRequest)return;$('historyStatus').textContent='History unavailable: '+e.message+'. The nightly history job gradually populates companies.';updateHistoryHints();}}
function renderHistory(){if(!history)return;const period=$('historyPeriod').value,rows=(history[period]||[]).slice(- (period==='annual'?10:20)),metric=$('historyMetric').value;const columns=[['revenue','Revenue'],['grossProfit','Gross profit'],['operatingIncome','Operating income'],['netIncome','Net income'],['eps','Diluted EPS'],['ocf','Operating CF'],['capex','Capex'],['fcf','FCF'],['sbc','SBC'],['shares','Diluted shares']];$('historyHead').innerHTML='<tr><th>Period</th>'+columns.map(x=>'<th>'+x[1]+'</th>').join('')+'</tr>';$('historyRows').innerHTML=rows.slice().reverse().map(row=>'<tr><td>'+esc(row.period)+'</td>'+columns.map(([k])=>'<td>'+historyFmt(k,historyValue(row,k))+'</td>').join('')+'</tr>').join('')||'<tr><td colspan="11">No periods available</td></tr>';const values=rows.map(x=>x[metric]).filter(Number.isFinite),max=Math.max(1,...values.map(Math.abs));$('historyChart').innerHTML=rows.map(x=>{const v=historyValue(x,metric),h=v===null?0:Math.max(2,Math.round(Math.abs(v)/max*110));return '<div class="history-bar-item" title="'+esc(x.period)+' · '+historyFmt(metric,v)+'"><div class="history-bar '+(v<0?'negative-bar':'')+'" style="height:'+h+'px"></div><small>'+esc(period==='annual'?x.period:x.period.slice(2))+'</small></div>'}).join('');}

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
 if(confidence!==null&&confidence<60)flags.push('Low model confidence');
 const rerating=Number(s.returnAttribution?.multipleReratingContribution);
 if(Number.isFinite(rerating)&&rerating>=.08)flags.push('Return depends on valuation re-rating ('+pct(rerating)+' annual contribution)');
 const base=Number(s.expectedCAGR),stressed=Number(s.underwrittenCAGR);
 if(Number.isFinite(base)&&Number.isFinite(stressed)&&base-stressed>=.035)flags.push('Underwriting reduces expected return by '+((base-stressed)*100).toFixed(1)+' points');
 if(cagr!==null&&cagr<0.15)flags.push('Below 15% modeled CAGR hurdle');
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
 // Rank against the investor's actual 15% hurdle plus 20% MOS entry price, not the looser intrinsic-value discount.
 const upside=entry===null?null:bounded(50+30*Math.tanh(entry/.40));
 const returnScore=r===null?null:bounded(50+30*Math.tanh((r-.15)/.10));
 const growthRisk=growth===null?8:growth>.50?22:growth>.35?15:growth>.25?8:0;
 const extremeDiscountRisk=mos===null?8:mos>=.65?16:mos>=.50?11:mos>=.40?6:0;
 const methodRisk=methods<2?16:methods===2?7:0;
 const missingRisk=[quality,growth,r,entry,conf].filter(x=>x===null).length*7;
 const valuation=upside===null||returnScore===null?null:bounded(.55*upside+.45*returnScore-growthRisk-extremeDiscountRisk-methodRisk-missingRisk);
 const confidence=conf===null?null:bounded(.50*conf+.25*(quality??50)+Math.min(3,methods)*5-growthRisk*.55-extremeDiscountRisk*.5-missingRisk);
 // Research priority uses the same stressed outcome as the investor buy-price test.
 // Re-rating is a source of upside, but it is not independently verified operating growth.
 const reratingPenalty=bounded(Math.max(0,rerating-.05)*160,0,30);
 const score=(valuation??0)*.45+(quality??0)*.35+(confidence??0)*.20-(r!==null&&r<.15?25:0)-reratingPenalty;
 const verdict=valuation===null?'Entry valuation unverified':entry!==null&&entry<0?'Above 15% + MOS buy price':r!==null&&r<.15?'Underwritten return below 15%':rerating>=.12?'Re-rating dependent · review':quality!==null&&quality<75?'Higher-risk research':valuation>=65&&quality!==null&&quality>=80?'Priority research':valuation>=50?'Research candidate':'Assumptions need review';
 const reasons=[];
 if(mos!==null)reasons.push('Discount to intrinsic fair value '+pct(mos)+' (unverified)');
 if(entry!==null)reasons.push('Versus 15% + 20% MOS buy price '+pct(entry)+' (unverified)');
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
function modelConfidenceLabel(o){return o.confidence===null?'Insufficient data':Math.round(o.confidence)+'/100 (heuristic)';}
function renderScreener(){
 const q=$('search').value.toLowerCase(),sector=$('sector').value,positive=$('positive').checked,sort=$('sort').value;
 let arr=stocks.filter(s=>(s.ticker+' '+(s.name||'')).toLowerCase().includes(q)&&(!sector||s.sector===sector)&&(!positive||present(s.underwrittenCAGR??s.expectedReturn)&&Number(s.underwrittenCAGR??s.expectedReturn)>0));
 const cached=new Map(arr.map(s=>[s,opportunity(s)]));
 arr.sort((a,b)=>sort==='opportunity'?cached.get(b).score-cached.get(a).score:sort==='return'?num(b.underwrittenCAGR??b.expectedReturn,-999)-num(a.underwrittenCAGR??a.expectedReturn,-999):sort==='quality'?num(b.qualityScore,-1)-num(a.qualityScore,-1):sort==='cap'?num(b.marketCap,-1)-num(a.marketCap,-1):num(a.overallRank,99999)-num(b.overallRank,99999));
 const seen=new Set();arr=arr.filter(s=>{const family=companyFamily(s.ticker);if(seen.has(family))return false;seen.add(family);return true;});
 $('count').textContent=`${arr.length} distinct companies of ${stocks.length} ticker listings · showing first ${Math.min(200,arr.length)} · Research scores are heuristic, not verified valuations`;
 const top=arr.slice(0,200);
 const returnSummary=s=>present(s.underwrittenCAGR)?pct(Number(s.underwrittenCAGR)):'—';
 const baseSummary=s=>present(s.expectedReturn)?pct(Number(s.expectedReturn)):'—';
 $('screenRows').innerHTML=top.map(s=>{const o=cached.get(s);return `<tr><td><b>${esc(s.ticker)}</b><br><span class="muted">${esc(s.name||'')}</span></td><td>${esc(s.sector||'—')}</td><td>${money(getPrice(s))}</td><td>${returnSummary(s)}<div class="muted small">Base ${baseSummary(s)}</div></td><td>${esc(s.qualityScore??'—')}</td><td><strong>${esc(o.verdict)}</strong><div class="muted small">Entry-price evidence ${o.valuation===null?'—':Math.round(o.valuation)+'/100'} · Model reliability ${esc(modelConfidenceLabel(o))}</div>${o.flags.length?'<div class="screen-card-flags">Review: '+esc(o.flags.slice(0,2).join(' · '))+'</div>':''}</td><td>${esc(s.overallRank??'—')}</td><td><button data-ticker="${esc(s.ticker)}">Research →</button></td></tr>`}).join('');
 $('screenCards').innerHTML=top.map((s,i)=>{const o=cached.get(s);return `<article class="screen-card compact"><div class="screen-card-head"><div><span class="screen-priority">Research #${i+1}</span><strong>${esc(s.ticker)} <span class="muted">${esc(s.name||'')}</span></strong></div><span class="screen-card-rank">Rank #${esc(s.overallRank??'—')}</span></div><div class="screen-card-stats"><span>Price <b>${money(getPrice(s))}</b></span><span>Underwritten CAGR <b>${returnSummary(s)}</b></span><span>Quality <b>${esc(s.qualityScore??'—')}</b></span></div><div class="muted small">Base-case CAGR ${baseSummary(s)} · Re-rating contribution ${present(s.returnAttribution?.multipleReratingContribution)?pct(Number(s.returnAttribution.multipleReratingContribution)):'—'}</div><div class="screen-card-verdict">${esc(o.verdict)}</div><div class="muted small">Entry-price evidence: <b>${o.valuation===null?'—':Math.round(o.valuation)+'/100'}</b> · Model reliability: <b>${esc(modelConfidenceLabel(o))}</b></div><div class="muted small">15% + 20% MOS buy price: ${money(s.requiredReturnBuyPrice)} · ${o.entry===null?'Entry comparison unavailable':o.entry>=0?'Below entry threshold by '+pct(o.entry/(1+o.entry)):'Above entry threshold by '+pct(-o.entry)}</div>${o.flags.length?'<div class="screen-card-flags">Review: '+esc(o.flags.slice(0,2).join(' · '))+'</div>':''}<div class="screen-card-footer"><span class="muted small">${o.methods} methods · estimates unverified</span><button data-ticker="${esc(s.ticker)}">Research →</button></div></article>`}).join('');
 document.querySelectorAll('#screenRows [data-ticker],#screenCards [data-ticker]').forEach(b=>b.onclick=()=>choose(b.dataset.ticker));
}

async function fetchData(){try{const response=await fetch('data/results.json?refresh='+Date.now());if(!response.ok)throw Error('HTTP '+response.status);const d=await response.json();const candidates=Array.isArray(d)?d:(Array.isArray(d.stocks)?d.stocks:Array.isArray(d.results)?d.results:Array.isArray(d.companies)?d.companies:Array.isArray(d.data)?d.data:[]);stocks=candidates.filter(s=>s&&s.ticker);byTicker=new Map(stocks.map(s=>[s.ticker.toUpperCase(),s]));$('freshness').textContent=stocks.length?`${stocks.length} companies · nightly data ${d.generatedAt||'unknown date'} · ${d.modelVersion||''}`:'No screener results yet — run the nightly workflow';const sectors=[...new Set(stocks.map(s=>s.sector).filter(Boolean))].sort();$('sector').innerHTML='<option value="">All sectors</option>'+sectors.map(x=>`<option>${esc(x)}</option>`).join('');renderScreener();}catch(e){$('freshness').textContent='Could not load nightly screener: '+e.message;toast('Screener data unavailable');}}
function requireAuth(){if(!client){toast('Configure your Supabase public URL and anon key in config.js');return false;}if(!user){$('authModal').hidden=false;return false;}return true;}
async function sync(){if(!user)return;try{const [p,h]=await Promise.all([client.from('stock_projections').select('*').order('updated_at',{ascending:false}),client.from('stock_holdings').select('*').order('updated_at',{ascending:false})]);if(p.error)throw p.error;if(h.error)throw h.error;saved=p.data||[];holdings=h.data||[];renderPortfolio();}catch(e){toast('Cloud sync failed: '+e.message);}}
async function saveProjection(){if(!current)return toast('Choose a company first');if(nativeScenario())return toast('Select Custom or edit an assumption before saving; the nightly Base/Bear/Bull cases are not manual projections');if(!requireAuth())return;const r=calculate(assumptions);if(!r)return toast('Fill in valid assumptions before saving');const row={user_id:user.id,ticker:current.ticker,name:current.name||current.ticker,scenario:$('scenario').value,assumptions,notes:$('notes').value,updated_at:new Date().toISOString()};const {error}=await client.from('stock_projections').upsert(row,{onConflict:'user_id,ticker,scenario'});if(error)return toast(error.message);toast('Projection saved to Supabase');await sync();}
function loadSaved(ticker,scenario){const p=saved.find(p=>p.ticker===ticker&&p.scenario===scenario);if(!p)return toast('No saved scenario for this company');choose(ticker);$('scenario').value=scenario;assumptions={...initial(current),...p.assumptions};assumptionsEdited=true;$('notes').value=p.notes||'';renderFields();renderValuation();}
async function saveHolding(){if(!requireAuth())return;const ticker=$('holdingTicker').value.trim().toUpperCase(),shares=Number($('holdingShares').value),cost=Number($('holdingCost').value);if(!ticker||!Number.isFinite(shares)||shares<0||!Number.isFinite(cost)||cost<0||!$('holdingShares').value||!$('holdingCost').value)return toast('Enter ticker, shares and cost per share');const {error}=await client.from('stock_holdings').upsert({user_id:user.id,ticker,shares,cost_basis:cost,updated_at:new Date().toISOString()},{onConflict:'user_id,ticker'});if(error)return toast(error.message);toast('Holding saved');await sync();}
async function remove(table,id){if(!requireAuth()||!confirm('Delete this saved item?'))return;const {error}=await client.from(table).delete().eq('id',id);if(error)return toast(error.message);await sync();}
function renderPortfolio(){let total=0,cost=0;const rows=holdings.map(h=>{const s=byTicker.get(h.ticker),price=getPrice(s),value=Number.isFinite(price)?price*h.shares:NaN,invested=h.cost_basis*h.shares;if(Number.isFinite(value)){total+=value;cost+=invested;}return `<tr><td>${esc(h.ticker)}</td><td>${h.shares}</td><td>${money(h.cost_basis)}</td><td>${money(price)}</td><td>${money(value)}</td><td>${Number.isFinite(value)?money(value-invested):'—'}</td><td><button data-delete-h="${h.id}">Remove</button></td></tr>`});$('holdingRows').innerHTML=rows.join('')||'<tr><td colspan="7" class="muted">No holdings saved.</td></tr>';$('portfolioMetrics').innerHTML=[['Priced holdings value',money(total)],['Cost of priced holdings',money(cost)],['Unrealized gain/loss',money(total-cost)],['Saved projections',saved.length]].map(([k,v])=>`<div class="metric"><small>${k}</small><strong>${v}</strong></div>`).join('');$('savedRows').innerHTML=saved.map(p=>{const r=calculate(p.assumptions);return `<tr><td>${esc(p.ticker)}</td><td>${esc(p.scenario)}</td><td>${r?pct(r.cagr):'—'}</td><td>${esc((p.updated_at||'').slice(0,10))}</td><td><button data-load="${esc(p.ticker)}" data-scenario="${esc(p.scenario)}">Open</button> <button data-delete-p="${p.id}">Delete</button></td></tr>`}).join('')||'<tr><td colspan="5" class="muted">No projections saved.</td></tr>';$('holdingRows').querySelectorAll('[data-delete-h]').forEach(b=>b.onclick=()=>remove('stock_holdings',b.dataset.deleteH));$('savedRows').querySelectorAll('[data-delete-p]').forEach(b=>b.onclick=()=>remove('stock_projections',b.dataset.deleteP));$('savedRows').querySelectorAll('[data-load]').forEach(b=>b.onclick=()=>loadSaved(b.dataset.load,b.dataset.scenario));}
async function auth(){if(!client)return;const {data:{session}}=await client.auth.getSession();user=session?.user||null;$('loginBtn').hidden=!!user;$('logoutBtn').hidden=!user;$('userLabel').textContent=user?.email||'';if(user)await sync();else{saved=[];holdings=[];renderPortfolio();}}
async function submitAuth(kind){if(!client)return;const email=$('email').value.trim(),password=$('password').value;if(!email||!password)return $('authMessage').textContent='Enter email and password';const {error}=kind==='signUp'?await client.auth.signUp({email,password}):await client.auth.signInWithPassword({email,password});if(error)return $('authMessage').textContent=error.message;$('authMessage').textContent=kind==='signUp'?'Account created. Check your email for confirmation if required.':'Signed in.';await auth();if(user)$('authModal').hidden=true;}
async function boot(){document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));['search','sector','sort','positive'].forEach(id=>$(id).addEventListener('input',renderScreener));$('screenZoom').addEventListener('input',e=>setScreenerScale(e.target.value));$('zoomOut').onclick=()=>setScreenerScale(Number($('screenZoom').value)-10);$('zoomIn').onclick=()=>setScreenerScale(Number($('screenZoom').value)+10);$('screenView').onchange=e=>{const cards=e.target.value==='cards';$('screener').classList.toggle('cards-mode',cards);try{localStorage.setItem('stocktool-screener-view',e.target.value)}catch(err){}};let preferredView='';try{preferredView=localStorage.getItem('stocktool-screener-view')||''}catch(err){};if(!preferredView)preferredView=window.matchMedia('(max-width: 760px)').matches?'cards':'table';$('screenView').value=preferredView;$('screener').classList.toggle('cards-mode',preferredView==='cards');try{setScreenerScale(Number(localStorage.getItem('stocktool-screener-zoom'))||80)}catch(e){setScreenerScale(80)}$('historyPeriod').onchange=renderHistory;$('historyMetric').onchange=renderHistory;$('tickerSearch').addEventListener('input',renderTickerMatches);$('tickerSearch').addEventListener('focus',renderTickerMatches);$('tickerSearch').addEventListener('keydown',e=>{if(e.key==='Escape')hideTickerMatches();if(e.key==='Enter'){const t=$('tickerMatches').querySelector('[data-ticker]');if(t){e.preventDefault();choose(t.dataset.ticker);}}});document.addEventListener('click',e=>{if(!e.target.closest('.ticker-search'))hideTickerMatches()});$('scenario').onchange=()=>{if(!current)return;assumptions=initial(current);assumptionsEdited=$('scenario').value==='Custom';renderFields();renderValuation();if(saved.some(p=>p.ticker===current.ticker&&p.scenario===$('scenario').value))toast('Saved scenario available — click Load saved scenario')};$('loadSaved').onclick=()=>current?loadSaved(current.ticker,$('scenario').value):toast('Choose a company');$('saveProjection').onclick=saveProjection;$('saveHolding').onclick=saveHolding;$('loginBtn').onclick=()=>requireAuth();$('closeAuth').onclick=()=>$('authModal').hidden=true;$('signIn').onclick=()=>submitAuth('signIn');$('signUp').onclick=()=>submitAuth('signUp');$('logoutBtn').onclick=async()=>{if(client)await client.auth.signOut();await auth();};const c=window.STOCK_CONFIG||{};if(c.supabaseUrl&&c.supabaseAnonKey&&window.supabase){client=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey);client.auth.onAuthStateChange(()=>setTimeout(auth,0));auth().catch(e=>toast('Cloud sign-in unavailable: '+e.message));}else toast('To enable cloud sync, configure public Supabase credentials in config.js');await fetchData();renderPortfolio();}
boot();
