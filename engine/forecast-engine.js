'use strict';
const { HORIZON_YEARS, EXPLICIT_FORECAST_YEARS, sectorConfig, clamp, rate, median, avg } = require('./config');

function cagr(a,b,n){ if(!(a>0)||!(b>0)||!(n>0))return null; return Math.pow(b/a,1/n)-1; }
function yoySeries(years,field){const out=[];for(let i=1;i<years.length;i++){const a=Number(years[i-1]?.[field]),b=Number(years[i]?.[field]);if(a>0&&Number.isFinite(b))out.push(b/a-1);}return out;}
function safeAnalystGrowth(v){const x=rate(v); return Number.isFinite(x)&&x>-0.40&&x<1.00?x:null;}
function finite(v){if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function pctMargin(y, numerator){const r=finite(y?.revenue),n=finite(y?.[numerator]);return r>0&&n!=null?n/r:null;}
function fcfMargin(y){const r=finite(y?.revenue),f=finite(y?.fcf);return r>0&&f!=null?f/r:null;}
function medianRecent(values,n=4){return median(values.slice(-n).filter(Number.isFinite));}
function trendSlope(values){const v=values.filter(Number.isFinite);if(v.length<2)return 0;const diffs=[];for(let i=1;i<v.length;i++)diffs.push(v[i]-v[i-1]);return median(diffs)??0;}
function latestQuarterYoY(quarters){
  if(!Array.isArray(quarters)||quarters.length<2)return null;
  const latest=quarters.at(-1); if(!(finite(latest?.val)>0)||!latest?.end)return null;
  const t=new Date(latest.end).getTime(); let best=null,bestDiff=Infinity;
  for(const q of quarters.slice(0,-1)){if(!(finite(q?.val)>0)||!q?.end)continue;const d=Math.abs((t-new Date(q.end).getTime())/86400000-365);if(d<bestDiff){bestDiff=d;best=q;}}
  return best&&bestDiff<=50?finite(latest.val)/finite(best.val)-1:null;
}
function incrementalMargin(years,field){
  const vals=[];
  for(let i=Math.max(1,years.length-3);i<years.length;i++){
    const a=years[i-1],b=years[i],dr=finite(b?.revenue)-finite(a?.revenue),dn=finite(b?.[field])-finite(a?.[field]);
    if(Number.isFinite(dr)&&dr>0&&Number.isFinite(dn))vals.push(dn/dr);
  }
  return median(vals);
}
function weightedAverage(items){let n=0,d=0;for(const [v,w] of items){if(Number.isFinite(v)&&w>0){n+=v*w;d+=w;}}return d?n/d:null;}

function classifyCategory(stock,growth,qualityHint,dividendYield){
  const sector=stock.sector||'Unknown';
  const financialLike=stock.financials?.dataQuality?.financialLikeRevenue===true;
  // Category is descriptive, not a return override. High-yield payout vehicles should
  // not be mislabeled Growth merely because reported revenue is volatile (mortgage REITs
  // are the classic failure mode). A very high yield is therefore a strong category signal.
  if(dividendYield>=0.045) return 'Dividend';
  if(dividendYield>=0.03 && growth<0.15) return 'Dividend';
  if(sector==='Financials'||financialLike) return growth>=0.12?'Growth':(dividendYield>=0.02?'Dividend':'Value');
  if(growth>=0.20) return 'Hyper Growth';
  if(growth>=0.10) return 'Growth';
  if(qualityHint>=0.68 && growth>=0.035) return 'Compounder';
  if(dividendYield>=0.025) return 'Dividend';
  return 'Value';
}

function buildGrowthForecast(stock,years,cfg){
  const a=stock.analystEstimates||{}, hist=yoySeries(years.slice(-6),'revenue').filter(x=>x>-0.60&&x<1.50);
  const last=years.at(-1)||{};
  const histMed=median(hist), histCagr=years.length>=4?cagr(finite(years.at(-4)?.revenue),finite(last.revenue),3):null;
  const historicalAnchor=clamp(median([histMed,histCagr].filter(Number.isFinite))??0.04,-0.10,0.30);
  const histDispersion=hist.length>=2?(median(hist.map(x=>Math.abs(x-(histMed??historicalAnchor))))??.20):.20;
  // Historical growth is useful only when it is representative. Short histories, spin-offs,
  // acquisition resets and highly erratic series receive less weight in the long-range fade.
  const historyReliability=clamp((hist.length/5)*clamp(1-histDispersion/.22,.20,1),.15,1);
  const recentAnnual=hist.at(-1)??historicalAnchor, recentQuarter=latestQuarterYoY(stock.quarterly);
  const a1=safeAnalystGrowth(a.revenueGrowthCurrentYear??a.revenueGrowthFwd), a2=safeAnalystGrowth(a.revenueGrowthNextYear);
  const analysts=Math.max(0,finite(a.numAnalysts)||0);
  const analystWeight=clamp(0.45+Math.min(analysts,30)/100,0.45,0.75);

  // Detect a likely acquisition / divestiture / accounting step change. We keep the new
  // revenue base, but do not teach the model that the one-time jump is organic growth.
  const priorMed=median(hist.slice(0,-1))??historicalAnchor;
  const stepThreshold=Math.max(0.18,Math.abs(priorMed)*1.6+0.08);
  const structuralStepUp=recentAnnual>priorMed+stepThreshold && ((a2!=null&&a2<recentAnnual-0.12)||(recentQuarter!=null&&recentQuarter<recentAnnual-0.12));
  const structuralStepDown=recentAnnual<priorMed-stepThreshold && ((a2!=null&&a2>recentAnnual+0.12)||(recentQuarter!=null&&recentQuarter>recentAnnual+0.12));

  const momentum=clamp(weightedAverage([[recentQuarter,.55],[recentAnnual,.45]])??recentAnnual,-0.25,0.60);
  let y1;
  if(a1!=null){ y1=weightedAverage([[a1,analystWeight],[historicalAnchor,1-analystWeight]]); }
  else { y1=weightedAverage([[momentum,.60],[historicalAnchor,.40]]); }
  let y2;
  if(a2!=null){ y2=weightedAverage([[a2,Math.min(.80,analystWeight+.05)],[historicalAnchor,1-Math.min(.80,analystWeight+.05)]]); }
  else { y2=weightedAverage([[y1,.55],[historicalAnchor,.45]]); }

  if(structuralStepUp||structuralStepDown){
    // Analysts and the pre-event normalized trend get priority after a one-time base reset.
    y1=weightedAverage([[a1,.65],[recentQuarter,.15],[historicalAnchor,.20]])??y1;
    y2=weightedAverage([[a2,.70],[historicalAnchor,.30]])??y2;
  }
  // Five-year valuation is extremely sensitive to a bad first-year growth input.
  // Keep genuine hyper-growth, but do not extrapolate one noisy annual/quarterly print.
  const analystCeiling = Math.max(.10, Math.min(.35, Math.max(a1??-.99,a2??-.99)+.06));
  y1=clamp(y1,-0.18,Math.min(.35,analystCeiling)); y2=clamp(y2,-0.15,Math.min(.30,analystCeiling));

  // Maturity is company-specific: durable high-growth businesses fade more slowly, but
  // nobody gets a perpetual hyper-growth destination just because the last year was hot.
  const roic=finite(last.roic), fcfM=fcfMargin(last);
  const qualityHint=clamp((roic!=null?clamp(roic/.22,0,1):.45)*.55+(fcfM>0?.45:.15),0,1)||.5;
  const scale=Math.max(0,finite(last.revenue)||0);
  const scalePenalty=scale>100e9?.010:scale>30e9?.006:scale>10e9?.003:0;
  const matureGrowth=clamp(cfg.terminalGrowth+(qualityHint-.5)*.012-scalePenalty,.012,.055);

  // IMPORTANT: terminalGrowth is a steady-state valuation assumption, not the growth
  // rate a healthy company must reach by year 5. The old model forced year-5 growth
  // all the way down to ~2-5%, which badly understated companies such as CELH while
  // simultaneously making terminal multiples inconsistent with the operating forecast.
  // Fade consensus toward an evidence-based year-5 operating rate; terminalGrowth is
  // kept separate for true terminal-value logic.
  // Years 1-2 can be consensus-led, but a near-term inflection must not permanently
  // reset the five-year growth regime. As the forecast moves beyond explicit analyst
  // coverage, progressively anchor back to normalized company history and maturity.
  // This is deliberately generic: the size of the fade is determined by the gap between
  // near-term consensus and the company's own normalized growth, not by ticker.
  const inflectionGap=Math.max(0,(y2??historicalAnchor)-historicalAnchor);
  const inflectionSeverity=clamp((inflectionGap-.04)/.16,0,1);
  const y2Weight=.32-.17*inflectionSeverity;
  const historyWeight=.43+.07*inflectionSeverity;
  const matureWeight=1-y2Weight-historyWeight;
  // Scale the historical weight by its reliability and reallocate the difference to mature
  // economics. This prevents a two-year or acquisition-distorted history from dictating
  // years 5-10.
  const effectiveHistoryWeight=historyWeight*historyReliability;
  const historyWeightGap=historyWeight-effectiveHistoryWeight;
  let evidenceGrowth=weightedAverage([[Math.max(y2,-.05),y2Weight],[historicalAnchor,effectiveHistoryWeight],[matureGrowth,matureWeight+historyWeightGap]])??matureGrowth;
  // Very large businesses need stronger evidence to carry an exceptional growth burst
  // deep into the forecast. This is a smooth scale adjustment, not a hard company rule.
  if(scale>50e9 && inflectionSeverity>0) evidenceGrowth-=Math.min(.018,inflectionSeverity*(scale>150e9?.018:.012));
  let maxYear5=Math.max(matureGrowth+.025, Math.min(.18, historicalAnchor+.025+Math.max(0,inflectionGap)*.38));
  // When current and next-year consensus both sit materially below a weak historical
  // anchor, do not invent a re-acceleration back toward that stale history.
  if(a1!=null&&a2!=null&&historyReliability<.65&&historicalAnchor>Math.max(a1,a2)+.08){
    maxYear5=Math.min(maxYear5,Math.max(matureGrowth+.02,Math.max(a1,a2)+.04));
  }
  const year5Growth=clamp(evidenceGrowth,matureGrowth,maxYear5);
  // 5+5 architecture: years 1-5 are the decision-grade operating forecast. Years
  // 6-10 are a transition period that fades the business toward mature economics before
  // a terminal valuation is applied. This avoids pretending we can forecast year 10 with
  // the same precision as year 2, while also avoiding a cliff from year-5 growth straight
  // to a perpetual-growth assumption.
  const growthPath=[y1,y2];
  for(let i=2;i<EXPLICIT_FORECAST_YEARS;i++){
    const t=(i-1)/(EXPLICIT_FORECAST_YEARS-2);
    const curved=t*t*(3-2*t);
    growthPath.push(clamp(y2*(1-curved)+year5Growth*curved,-.10,.28));
  }
  for(let i=EXPLICIT_FORECAST_YEARS;i<HORIZON_YEARS;i++){
    const t=(i-EXPLICIT_FORECAST_YEARS+1)/(HORIZON_YEARS-EXPLICIT_FORECAST_YEARS);
    const curved=t*t*(3-2*t);
    growthPath.push(clamp(year5Growth*(1-curved)+matureGrowth*curved,-.06,.18));
  }
  const analystCoverage=(a1!=null?1:0)+(a2!=null?1:0);
  const forecastReliabilityScore=Math.round(100*clamp(.20+.35*historyReliability+.25*(analystCoverage/2)+.20*clamp(analysts/20,0,1)-((structuralStepUp||structuralStepDown)?.10:0),.20,.95));
  return {growthPath,y1,y2,matureGrowth,year5Growth,historicalAnchor,recentAnnual,recentQuarter,qualityHint,analystWeight,structuralStepUp,structuralStepDown,analystUsed:a1!=null||a2!=null,historyReliability,histDispersion,forecastReliabilityScore};
}

function buildMarginForecast(stock,years,cfg,growthInfo){
  // Margin forecasting is built from one coherent operating model. We forecast operating
  // profitability first, translate it into EBITDA / net income / CFO using the company's
  // own historical relationships, and derive FCF as CFO minus capex. This avoids three
  // independent margin targets drifting into economically contradictory futures.
  if(stock.sector==='Financials') return {
    rawFCF:null,rawEBITDA:null,rawNet:null,currentFCF:null,currentEBITDA:null,currentNet:null,
    targetFCF:null,targetEBITDA:null,targetNet:null,matureTargetFCF:null,matureTargetEBITDA:null,matureTargetNet:null,
    currentOperating:null,targetOperating:null,matureOperating:null,currentCFO:null,targetCFO:null,matureCFO:null,
    currentCapex:null,targetCapex:null,matureCapex:null,leverageSignal:0,fcfTrend:null,opTrend:null,grossTrend:null,
    incrementalFCFMargin:null,incrementalOperatingMargin:null,abnormalCapexCycle:false,reportedFCFMargin:null,
    normalizedCapexMargin:null,cycleNormalizedFCFMargin:null,maintenanceCapexMargin:null,profitabilityConsistencyApplied:false
  };

  const fcfSeries=years.map(fcfMargin);
  const ebitdaSeries=years.map(y=>pctMargin(y,'ebitda'));
  const netSeries=years.map(y=>pctMargin(y,'netIncome'));
  const cfoSeries=years.map(y=>pctMargin(y,'cfo'));
  const capexSeries=years.map(y=>{const r=finite(y?.revenue),c=finite(y?.capex);return r>0&&c!=null?Math.abs(c)/r:null;});
  const daSeries=years.map(y=>{const r=finite(y?.revenue),d=finite(y?.da);return r>0&&d!=null&&d>=0?d/r:null;});
  const opSeries=years.map(y=>Number.isFinite(finite(y?.opMargin))?finite(y.opMargin):pctMargin(y,'operatingIncome'));
  const grossSeries=years.map(y=>Number.isFinite(finite(y?.grossMargin))?finite(y.grossMargin):pctMargin(y,'grossProfit'));

  const rawOp=medianRecent(opSeries) ?? medianRecent(ebitdaSeries) ?? medianRecent(netSeries) ?? .06;
  const rawEBITDA=medianRecent(ebitdaSeries);
  const rawNet=medianRecent(netSeries) ?? Math.max(-.05,rawOp*.70);
  const rawCFO=medianRecent(cfoSeries);
  const rawCapex=medianRecent(capexSeries);
  const directFCF=medianRecent(fcfSeries);

  const latestOp=opSeries.filter(Number.isFinite).at(-1);
  const latestEBITDA=ebitdaSeries.filter(Number.isFinite).at(-1);
  const latestNet=netSeries.filter(Number.isFinite).at(-1);
  const latestCFO=cfoSeries.filter(Number.isFinite).at(-1);
  const latestCapex=capexSeries.filter(Number.isFinite).at(-1);
  const latestFCF=fcfSeries.filter(Number.isFinite).at(-1);

  const opCeiling=Math.min(.55,Math.max(.30,cfg.maxFCFMargin+.10));
  const ebitdaCeiling=Math.min(.70,Math.max(.40,cfg.maxFCFMargin+.22));
  const netCeiling=Math.min(.50,Math.max(.28,cfg.maxFCFMargin+.08));
  const fcfCeiling=cfg.maxFCFMargin;
  const saneStart=(latest,norm,lo,hi,band)=>clamp(Number.isFinite(latest)?latest:norm,Math.max(lo,norm-band),Math.min(hi,norm+band));
  const currentOperating=saneStart(latestOp,rawOp,-.10,opCeiling,.10);
  const currentEBITDA=Number.isFinite(rawEBITDA)?saneStart(latestEBITDA,rawEBITDA,-.05,ebitdaCeiling,.12):null;
  const currentNet=saneStart(latestNet,rawNet,-.10,netCeiling,.10);
  const currentCFO=Number.isFinite(rawCFO)?saneStart(latestCFO,rawCFO,-.08,.70,.12):null;
  const currentCapex=Number.isFinite(latestCapex)?clamp(latestCapex,0,.45):Number.isFinite(rawCapex)?clamp(rawCapex,0,.45):null;

  const opTrend=clamp(trendSlope(opSeries.slice(-5)),-.04,.04)||0;
  const grossTrend=clamp(trendSlope(grossSeries.slice(-5)),-.03,.03)||0;
  const fcfTrend=clamp(trendSlope(fcfSeries.slice(-5)),-.04,.04)||0;
  const cfoTrend=clamp(trendSlope(cfoSeries.slice(-5)),-.04,.04)||0;
  const incOp=incrementalMargin(years,'operatingIncome');
  const incFCF=incrementalMargin(years,'fcf');

  // Analyst EPS growth is useful as a near-term profitability cross-check. When EPS is
  // expected to grow materially faster than revenue (after share-count effects), analysts
  // are implicitly expecting margin expansion. It is supporting evidence, not a target.
  const a=stock.analystEstimates||{};
  const eps1=safeAnalystGrowth(a.epsGrowthCurrentYear??a.epsGrowthFwd);
  const eps2=safeAnalystGrowth(a.epsGrowthNextYear);
  const shareHist=yoySeries(years.slice(-5),'sharesOutTTM').filter(x=>x>-.20&&x<.25);
  const shareAnchor=clamp(median(shareHist)??0,-.04,.06);
  const analystMarginSignals=[];
  if(eps1!=null&&growthInfo.y1!=null) analystMarginSignals.push(clamp(eps1-growthInfo.y1+shareAnchor,-.12,.12));
  if(eps2!=null&&growthInfo.y2!=null) analystMarginSignals.push(clamp(eps2-growthInfo.y2+shareAnchor,-.12,.12));
  const analystMarginGrowth=median(analystMarginSignals);
  const analystMarginDelta=Number.isFinite(analystMarginGrowth)
    ? clamp(currentNet*((1+analystMarginGrowth)**2-1),-.035,.045)
    : 0;

  // Incremental operating margin is far noisier than a reported margin, so use only the
  // gap versus normalized profitability and cap its influence. Multi-year margin trends,
  // gross-margin direction and analyst-implied earnings leverage provide independent votes.
  const incrementalGap=Number.isFinite(incOp)?clamp(incOp-rawOp,-.12,.18):0;
  let leverageSignal=0;
  leverageSignal += clamp(incrementalGap*.16,-.018,.025);
  leverageSignal += clamp(opTrend*.45,-.014,.018);
  leverageSignal += clamp(grossTrend*.22,-.007,.009);
  leverageSignal += clamp(analystMarginDelta*.32,-.010,.014);
  if((growthInfo.year5Growth??growthInfo.y2)>.08 && opTrend>=-.002 && grossTrend>=-.003) leverageSignal+=.004;
  if((growthInfo.year5Growth??growthInfo.y2)<.025 && opTrend<-.006) leverageSignal-=.004;
  leverageSignal=clamp(leverageSignal,-.025,.040);

  const recentOpMedian=median(opSeries.filter(Number.isFinite).slice(-3));
  const longOpMedian=median(opSeries.filter(Number.isFinite).slice(-6));
  const normalizedOperating=weightedAverage([[rawOp,.50],[recentOpMedian,.25],[longOpMedian,.25]])??rawOp;
  let targetOperating=clamp(normalizedOperating+leverageSignal*.75+analystMarginDelta*.18,-.10,opCeiling);
  targetOperating=clamp(weightedAverage([[targetOperating,.62],[currentOperating,.38]]),-.10,opCeiling);

  // Long-run compression requires broad evidence. A bad recent year is not enough to
  // extrapolate deterioration for a decade. Conversely, strong incremental economics can
  // earn further scale leverage, but only gradually after year 5.
  const compressionVotes=(opTrend<-.006?1:0)+(grossTrend<-.006?1:0)+(incrementalGap<-.04?1:0)+(analystMarginDelta<-.015?1:0);
  const expansionVotes=(opTrend>.003?1:0)+(grossTrend>.003?1:0)+(incrementalGap>.03?1:0)+(analystMarginDelta>.012?1:0);
  const durableGrowth=clamp(growthInfo.year5Growth??growthInfo.y2??0,-.05,.20);
  let matureOpAdjustment=leverageSignal*.45;
  if(expansionVotes>=2&&durableGrowth>.04) matureOpAdjustment+=Math.min(.018,.0045*(expansionVotes-1));
  if(compressionVotes>=3) matureOpAdjustment-=Math.min(.018,.005*(compressionVotes-2));
  let matureOperating=clamp(targetOperating+matureOpAdjustment,-.10,opCeiling);
  if(compressionVotes<3 && durableGrowth>.035) matureOperating=Math.max(matureOperating,Math.min(currentOperating,normalizedOperating)-.006);
  if(expansionVotes>=2) matureOperating=Math.max(matureOperating,targetOperating);

  // Convert operating profitability into EBITDA and net margin using the company's own
  // normalized accounting relationships. This keeps all three profitability measures on
  // one economic story instead of allowing each to wander to an unrelated target.
  const ebitdaOpSpreads=[];
  const opNetSpreads=[];
  for(let i=0;i<years.length;i++){
    const op=opSeries[i],eb=ebitdaSeries[i],nm=netSeries[i];
    if(Number.isFinite(op)&&Number.isFinite(eb)) ebitdaOpSpreads.push(clamp(eb-op,-.02,.25));
    if(Number.isFinite(op)&&Number.isFinite(nm)) opNetSpreads.push(clamp(op-nm,-.12,.25));
  }
  const ebitdaSpread=medianRecent(ebitdaOpSpreads,5);
  const netBurden=medianRecent(opNetSpreads,5);
  let targetEBITDA=Number.isFinite(ebitdaSpread)?clamp(targetOperating+ebitdaSpread,-.05,ebitdaCeiling):currentEBITDA;
  let matureTargetEBITDA=Number.isFinite(ebitdaSpread)?clamp(matureOperating+ebitdaSpread,-.05,ebitdaCeiling):targetEBITDA;
  let targetNet=Number.isFinite(netBurden)?clamp(targetOperating-netBurden,-.10,netCeiling):clamp(rawNet+leverageSignal*.55,-.10,netCeiling);
  let matureTargetNet=Number.isFinite(netBurden)?clamp(matureOperating-netBurden,-.10,netCeiling):targetNet;
  // Blend a limited amount of direct analyst-implied net-margin evidence into years 1-5.
  if(Number.isFinite(analystMarginDelta)){
    targetNet=clamp(targetNet+analystMarginDelta*.28,-.10,netCeiling);
    matureTargetNet=clamp(matureTargetNet+analystMarginDelta*.12,-.10,netCeiling);
  }
  // If historical EBITDA/net data are noisy, do not manufacture decade-long compression
  // unsupported by the operating forecast.
  if(compressionVotes<3 && durableGrowth>.035){
    if(Number.isFinite(currentEBITDA)&&Number.isFinite(matureTargetEBITDA)) matureTargetEBITDA=Math.max(matureTargetEBITDA,currentEBITDA-.0075);
    if(Number.isFinite(currentNet)&&Number.isFinite(matureTargetNet)) matureTargetNet=Math.max(matureTargetNet,currentNet-.0075);
  }

  // Capex is forecast independently from profitability because a temporary investment
  // cycle can depress FCF while the underlying business improves. Detect the cycle using
  // capex versus both pre-cycle history and D&A, with CFO/operations as confirmation.
  const priorCapex=median(capexSeries.filter(Number.isFinite).slice(-6,-1));
  const priorDA=median(daSeries.filter(Number.isFinite).slice(-6,-1));
  const recentDA=daSeries.filter(Number.isFinite).at(-1);
  const maintenanceAnchor=weightedAverage([[priorCapex,.50],[priorDA,.30],[recentDA,.20]]);
  const priorFCF=median(fcfSeries.filter(Number.isFinite).slice(-6,-1));
  const priorCFO=median(cfoSeries.filter(Number.isFinite).slice(-6,-1));
  const priorOperating=median(opSeries.filter(Number.isFinite).slice(-6,-1));
  const capexSurge=Number.isFinite(currentCapex)&&Number.isFinite(priorCapex)&&
    currentCapex>Math.max(priorCapex*1.35,priorCapex+.018);
  const capexVsDA=Number.isFinite(currentCapex)&&Number.isFinite(recentDA)&&currentCapex>recentDA+.018;
  const fcfDislocation=Number.isFinite(latestFCF)&&Number.isFinite(priorFCF)&&latestFCF<priorFCF-.025;
  const cfoIntact=Number.isFinite(currentCFO)&&Number.isFinite(priorCFO)?currentCFO>=priorCFO-.025:true;
  const operationsIntact=Number.isFinite(currentOperating)&&Number.isFinite(priorOperating)?currentOperating>=priorOperating-.025:true;
  const abnormalCapexCycle=Boolean((capexSurge||capexVsDA)&&fcfDislocation&&cfoIntact&&operationsIntact);

  const growthReinvestmentShare=clamp(.22+Math.max(0,growthInfo.y2-.04)*1.15,.22,.55);
  const matureGrowthReinvestmentShare=clamp(.12+Math.max(0,durableGrowth-.03)*.90,.12,.38);
  const excessCapex=Number.isFinite(currentCapex)&&Number.isFinite(maintenanceAnchor)?Math.max(0,currentCapex-maintenanceAnchor):0;
  let targetCapex=Number.isFinite(rawCapex)?rawCapex:currentCapex;
  let matureCapex=targetCapex;
  if(abnormalCapexCycle&&Number.isFinite(maintenanceAnchor)&&Number.isFinite(currentCapex)){
    targetCapex=clamp(maintenanceAnchor+excessCapex*growthReinvestmentShare,0,.45);
    matureCapex=clamp(maintenanceAnchor+excessCapex*matureGrowthReinvestmentShare,0,.45);
  } else if(Number.isFinite(maintenanceAnchor)) {
    // Outside a detected spike, converge gently toward normalized maintenance plus a
    // modest growth burden. This avoids assuming capex either disappears or stays at a
    // one-year extreme forever.
    const normalGrowthPremium=Math.max(0,durableGrowth-.03)*.12;
    targetCapex=clamp(weightedAverage([[rawCapex,.65],[maintenanceAnchor+normalGrowthPremium,.35]]),0,.45);
    matureCapex=clamp(weightedAverage([[targetCapex,.55],[maintenanceAnchor+normalGrowthPremium*.65,.45]]),0,.45);
  }

  // CFO is tied to operating profitability via the company's normalized CFO-to-operating
  // spread. Working-capital windfalls are deliberately damped in the mature state.
  const cfoOpSpreads=[];
  for(let i=0;i<years.length;i++){
    const op=opSeries[i],cf=cfoSeries[i];
    if(Number.isFinite(op)&&Number.isFinite(cf)) cfoOpSpreads.push(clamp(cf-op,-.15,.30));
  }
  const normalizedCfoSpread=medianRecent(cfoOpSpreads,5);
  let targetCFO=Number.isFinite(normalizedCfoSpread)?clamp(targetOperating+normalizedCfoSpread,-.08,.70):rawCFO;
  let matureCfoSpread=normalizedCfoSpread;
  if(Number.isFinite(matureCfoSpread)){
    // Positive CFO spreads often include recurring non-cash charges but can also contain
    // temporary working-capital benefits. Retain most, not all, of a large positive spread.
    if(matureCfoSpread>.10) matureCfoSpread=.10+(matureCfoSpread-.10)*.55;
    if(matureCfoSpread<-.05) matureCfoSpread=-.05+(matureCfoSpread+.05)*.65;
  }
  let matureCFO=Number.isFinite(matureCfoSpread)?clamp(matureOperating+matureCfoSpread,-.08,.70):targetCFO;
  if(Number.isFinite(currentCFO)&&Number.isFinite(targetCFO)) targetCFO=clamp(weightedAverage([[targetCFO,.70],[currentCFO,.30]]),-.08,.70);

  // Economic FCF anchor -------------------------------------------------------
  // CFO-capex is the accounting identity, but CFO can be a terrible *forecasting* anchor:
  // stock compensation, deferred revenue and working-capital releases can make a single
  // year's CFO margin look permanently spectacular.  Conversely, a temporary capex build
  // can make reported FCF look permanently broken.  Reconcile cash flow to the operating
  // model through net income + D&A - normalized capex, then allow only a small persistent
  // working-capital premium/drag that is supported by multi-year history.
  const netDaCapexSeries=[];
  const wcResidualSeries=[];
  for(let i=0;i<years.length;i++){
    const nm=netSeries[i], da=daSeries[i], cx=capexSeries[i], cf=cfoSeries[i];
    if(Number.isFinite(nm)&&Number.isFinite(da)&&Number.isFinite(cx)) netDaCapexSeries.push(nm+da-cx);
    if(Number.isFinite(cf)&&Number.isFinite(nm)&&Number.isFinite(da)) wcResidualSeries.push(cf-nm-da);
  }
  const normalizedEconomicFCF=medianRecent(netDaCapexSeries,5);
  const rawWorkingCapitalResidual=medianRecent(wcResidualSeries,5);
  // Only a modest residual is allowed into a decade forecast. Large positive residuals
  // are commonly SBC / deferred-revenue / working-capital timing rather than free money.
  const persistentCashResidual=Number.isFinite(rawWorkingCapitalResidual)
    ? clamp(rawWorkingCapitalResidual,-.025,.025)
    : 0;
  const daAnchor=medianRecent(daSeries,5);
  const targetEconomicFCF=Number.isFinite(targetNet)&&Number.isFinite(daAnchor)&&Number.isFinite(targetCapex)
    ? targetNet+daAnchor-targetCapex+persistentCashResidual
    : null;
  const matureEconomicFCF=Number.isFinite(matureTargetNet)&&Number.isFinite(daAnchor)&&Number.isFinite(matureCapex)
    ? matureTargetNet+daAnchor-matureCapex+persistentCashResidual*.65
    : null;

  const accountingCurrentFCF=Number.isFinite(currentCFO)&&Number.isFinite(currentCapex)?currentCFO-currentCapex:latestFCF;
  let currentFCF=weightedAverage([[accountingCurrentFCF,.45],[directFCF,.30],[normalizedEconomicFCF,.25]]);
  let targetFCF=weightedAverage([
    [Number.isFinite(targetCFO)&&Number.isFinite(targetCapex)?targetCFO-targetCapex:null,.30],
    [targetEconomicFCF,.50],
    [Number.isFinite(directFCF)?directFCF+leverageSignal*.45:null,.20]
  ]);
  let matureTargetFCF=weightedAverage([
    [Number.isFinite(matureCFO)&&Number.isFinite(matureCapex)?matureCFO-matureCapex:null,.20],
    [matureEconomicFCF,.65],
    [targetFCF,.15]
  ]);

  // FCF must remain reconcilable with operating earnings.  Permit a modest premium for
  // recurring non-cash charges / favorable working capital, but not a 20-30 point gap that
  // turns cash conversion into the entire investment thesis.
  const economicCeiling=(netM,ebitdaM,capexM)=>{
    const fromNet=Number.isFinite(netM)&&Number.isFinite(daAnchor)&&Number.isFinite(capexM)
      ? netM+daAnchor-capexM+.035 : null;
    const fromEbitda=Number.isFinite(ebitdaM)?ebitdaM+.025:null;
    return median([fromNet,fromEbitda,fcfCeiling].filter(Number.isFinite));
  };
  const targetCashCeiling=economicCeiling(targetNet,targetEBITDA,targetCapex);
  const matureCashCeiling=economicCeiling(matureTargetNet,matureTargetEBITDA,matureCapex);
  if(Number.isFinite(targetFCF)&&Number.isFinite(targetCashCeiling)) targetFCF=Math.min(targetFCF,targetCashCeiling);
  if(Number.isFinite(matureTargetFCF)&&Number.isFinite(matureCashCeiling)) matureTargetFCF=Math.min(matureTargetFCF,matureCashCeiling);

  currentFCF=Number.isFinite(currentFCF)?clamp(currentFCF,-.10,fcfCeiling):null;
  targetFCF=Number.isFinite(targetFCF)?clamp(targetFCF,-.10,fcfCeiling):null;
  matureTargetFCF=Number.isFinite(matureTargetFCF)?clamp(matureTargetFCF,-.10,fcfCeiling):null;

  // A healthy, still-growing business should not be forced into decade-long FCF
  // compression merely because today's capex is elevated. If operating/net margins are
  // stable or improving and normalized capex falls, let mature FCF at least preserve the
  // year-5 economics. This is evidence-based and applies equally to every ticker.
  if(Number.isFinite(targetFCF)&&Number.isFinite(matureTargetFCF)&&compressionVotes<3&&durableGrowth>.03&&
     Number.isFinite(matureCapex)&&Number.isFinite(targetCapex)&&matureCapex<=targetCapex+.003){
    matureTargetFCF=Math.max(matureTargetFCF,targetFCF-.003);
  }

  // Close the loop: once sustainable FCF has been reconciled to earnings and reinvestment,
  // CFO is the balancing cash-flow line (FCF + capex). The projection rows therefore use
  // the reconciled economics rather than silently reverting to the noisy historical
  // CFO-spread model that we just rejected above.
  if(Number.isFinite(targetFCF)&&Number.isFinite(targetCapex)) targetCFO=clamp(targetFCF+targetCapex,-.08,.70);
  if(Number.isFinite(matureTargetFCF)&&Number.isFinite(matureCapex)) matureCFO=clamp(matureTargetFCF+matureCapex,-.08,.70);

  const cycleNormalizedFCF=abnormalCapexCycle&&Number.isFinite(currentCFO)&&Number.isFinite(targetCapex)?currentCFO-targetCapex:null;
  const profitabilityConsistencyApplied=Boolean(compressionVotes<3&&durableGrowth>.035);

  return {
    rawFCF:directFCF,rawEBITDA,rawNet,currentFCF,currentEBITDA,currentNet,targetFCF,targetEBITDA,targetNet,
    matureTargetFCF,matureTargetEBITDA,matureTargetNet,currentOperating,targetOperating,matureOperating,
    currentCFO,targetCFO,matureCFO,currentCapex,targetCapex,matureCapex,leverageSignal,fcfTrend,opTrend,grossTrend,
    incrementalFCFMargin:incFCF,incrementalOperatingMargin:incOp,analystMarginGrowth,analystMarginDelta,
    expansionVotes,compressionVotes,abnormalCapexCycle,reportedFCFMargin:latestFCF,normalizedCapexMargin:targetCapex,
    cycleNormalizedFCFMargin:cycleNormalizedFCF,maintenanceCapexMargin:maintenanceAnchor,growthReinvestmentShare,
    matureGrowthReinvestmentShare,normalizedCFO:rawCFO,normalizedEconomicFCF,persistentCashResidual,cashEconomicsTarget:matureTargetFCF,profitabilityConsistencyApplied
  };
}
function buildForecast(stock){
  const years=stock.financials?.years||[], last=years.at(-1)||{}, cfg=sectorConfig(stock.sector);
  const growth=buildGrowthForecast(stock,years,cfg);
  const margins=buildMarginForecast(stock,years,cfg,growth);

  const shareGrowth=yoySeries(years.slice(-5),'sharesOutTTM').filter(x=>x>-.25&&x<.30);
  const recentShareGrowth=shareGrowth.at(-1), medianShareGrowth=median(shareGrowth)??0;
  // Share-count behavior gets its own fade. A recent SBC spike or aggressive buyback
  // program should not be compounded unchanged for a decade. Positive dilution fades
  // toward a modest mature-company rate; buybacks fade toward a sustainable tailwind.
  const dilutionRate=clamp(weightedAverage([[recentShareGrowth,.55],[medianShareGrowth,.45]])??0,-.05,.07);
  const matureDilutionRate=dilutionRate>0
    ? clamp(.004 + .18*dilutionRate, .004, .015)
    : clamp(.25*dilutionRate, -.012, 0);
  const dilutionPath=Array.from({length:HORIZON_YEARS},(_,i)=>{
    const t=Math.min(1,(i+1)/HORIZON_YEARS), curved=t*t*(3-2*t);
    return dilutionRate+(matureDilutionRate-dilutionRate)*curved;
  });

  let revenue=finite(last.revenue)>0?finite(last.revenue):null, shares=finite(last.sharesOutTTM)>0?finite(last.sharesOutTTM):null, dividend=Math.max(0,finite(last.dividendPerShare)||0);
  const dividendGrowth=clamp(Math.min(Math.max(growth.y2,0),.07),0,.07), rows=[];
  for(let i=0;i<HORIZON_YEARS;i++){
    if(revenue!=null)revenue*=1+growth.growthPath[i]; if(shares!=null)shares*=1+dilutionPath[i]; dividend*=1+dividendGrowth;
    // Two-stage margin path: years 1-5 move toward the near/medium-term normalized
    // target; years 6-10 move toward mature economics. This is especially important for
    // temporary investment cycles, where FCF can recover after the explicit buildout.
    const firstPhase=i<EXPLICIT_FORECAST_YEARS;
    const phaseT=firstPhase
      ? (i+1)/EXPLICIT_FORECAST_YEARS
      : (i-EXPLICIT_FORECAST_YEARS+1)/(HORIZON_YEARS-EXPLICIT_FORECAST_YEARS);
    const curved=phaseT*phaseT*(3-2*phaseT);
    const interp=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a+(b-a)*curved:null;
    const operatingMargin=firstPhase?interp(margins.currentOperating,margins.targetOperating):interp(margins.targetOperating,margins.matureOperating);
    const ebitdaMargin=firstPhase?interp(margins.currentEBITDA,margins.targetEBITDA):interp(margins.targetEBITDA,margins.matureTargetEBITDA);
    const netMargin=firstPhase?interp(margins.currentNet,margins.targetNet):interp(margins.targetNet,margins.matureTargetNet);
    const cfoMargin=firstPhase?interp(margins.currentCFO,margins.targetCFO):interp(margins.targetCFO,margins.matureCFO);
    const capexMargin=firstPhase?interp(margins.currentCapex,margins.targetCapex):interp(margins.targetCapex,margins.matureCapex);
    // FCF is an output of the cash-conversion model, not an independently interpolated
    // margin. This is the central accounting consistency invariant of the margin engine.
    const fallbackFcfMargin=firstPhase?interp(margins.currentFCF,margins.targetFCF):interp(margins.targetFCF,margins.matureTargetFCF);
    const fcfMargin=Number.isFinite(cfoMargin)&&Number.isFinite(capexMargin)
      ? clamp(cfoMargin-capexMargin,-.10,cfg.maxFCFMargin)
      : fallbackFcfMargin;
    const fcf=revenue!=null&&fcfMargin!=null?revenue*fcfMargin:null, ebitda=revenue!=null&&ebitdaMargin!=null?revenue*ebitdaMargin:null, netIncome=revenue!=null&&netMargin!=null?revenue*netMargin:null;
    rows.push({year:(finite(last.year)||new Date().getFullYear())+i+1,revenueGrowth:growth.growthPath[i],revenue,operatingMargin,fcfMargin,cfoMargin,capexMargin,ebitdaMargin,netMargin,fcf,ebitda,netIncome,shares,eps:shares>0&&netIncome!=null?netIncome/shares:null,fcfPerShare:shares>0&&fcf!=null?fcf/shares:null,dividendPerShare:dividend});
  }

  const sustainableGrowth=median([growth.y1,growth.y2,growth.historicalAnchor].filter(Number.isFinite))??growth.y1;
  const category=classifyCategory(stock,sustainableGrowth,growth.qualityHint,Number(stock.valuation?.dividendYield)||0);
  const forecastBridge={
    revenue:{model:growth.y1,analystCurrent:safeAnalystGrowth(stock.analystEstimates?.revenueGrowthCurrentYear??stock.analystEstimates?.revenueGrowthFwd),analystNext:safeAnalystGrowth(stock.analystEstimates?.revenueGrowthNextYear),recentQuarter:growth.recentQuarter,recentAnnual:growth.recentAnnual,historicalNormalized:growth.historicalAnchor,terminalOperatingGrowth:growth.year5Growth,analystWeight:growth.analystWeight,structuralStepUp:growth.structuralStepUp,structuralStepDown:growth.structuralStepDown},
    margins:{fcfStart:margins.currentFCF,fcfNormalized:margins.rawFCF,fcfTarget:margins.targetFCF,fcfMatureTarget:margins.matureTargetFCF,operatingStart:margins.currentOperating,operatingTarget:margins.targetOperating,operatingMatureTarget:margins.matureOperating,ebitdaStart:margins.currentEBITDA,ebitdaNormalized:margins.rawEBITDA,ebitdaTarget:margins.targetEBITDA,ebitdaMatureTarget:margins.matureTargetEBITDA,netStart:margins.currentNet,netNormalized:margins.rawNet,netTarget:margins.targetNet,netMatureTarget:margins.matureTargetNet,cfoStart:margins.currentCFO,cfoTarget:margins.targetCFO,cfoMatureTarget:margins.matureCFO,capexStart:margins.currentCapex,capexTarget:margins.targetCapex,capexMatureTarget:margins.matureCapex,incrementalFCFMargin:margins.incrementalFCFMargin,incrementalOperatingMargin:margins.incrementalOperatingMargin,analystMarginGrowth:margins.analystMarginGrowth,analystMarginDelta:margins.analystMarginDelta,expansionVotes:margins.expansionVotes,compressionVotes:margins.compressionVotes,fcfTrend:margins.fcfTrend,operatingTrend:margins.opTrend,grossMarginTrend:margins.grossTrend,operatingLeverageAdjustment:margins.leverageSignal,abnormalCapexCycle:margins.abnormalCapexCycle,reportedFCFMargin:margins.reportedFCFMargin,normalizedCapexMargin:margins.normalizedCapexMargin,cycleNormalizedFCFMargin:margins.cycleNormalizedFCFMargin,maintenanceCapexMargin:margins.maintenanceCapexMargin,growthReinvestmentShare:margins.growthReinvestmentShare,matureGrowthReinvestmentShare:margins.matureGrowthReinvestmentShare,matureCapexMargin:margins.matureCapex,normalizedCFOMargin:margins.normalizedCFO,normalizedEconomicFCFMargin:margins.normalizedEconomicFCF,persistentCashResidual:margins.persistentCashResidual,cashEconomicsTarget:margins.cashEconomicsTarget,profitabilityConsistencyApplied:margins.profitabilityConsistencyApplied},
    shares:{recent:recentShareGrowth,normalized:medianShareGrowth,model:dilutionRate,mature:matureDilutionRate,path:dilutionPath},
  };
  const forecastFlags=[];
  if(growth.structuralStepUp)forecastFlags.push('structural_revenue_step_up_detected');
  if(growth.structuralStepDown)forecastFlags.push('structural_revenue_step_down_detected');
  if(margins.abnormalCapexCycle)forecastFlags.push('abnormal_capex_cycle_normalized');
  if(margins.leverageSignal>.008)forecastFlags.push('evidence_supports_margin_expansion');
  if(margins.leverageSignal<-.008)forecastFlags.push('evidence_supports_margin_compression');
  if(margins.profitabilityConsistencyApplied)forecastFlags.push('growth_profitability_consistency_guardrail');
  if(growth.recentQuarter!=null&&Math.abs(growth.recentQuarter-growth.historicalAnchor)>.12)forecastFlags.push('recent_growth_inflection');

  return {horizonYears:HORIZON_YEARS,category,rows,terminalGrowth:growth.matureGrowth,year5OperatingGrowth:growth.year5Growth,revenueGrowthAnchor:growth.y1,sustainableGrowth,historicalGrowth:growth.historicalAnchor,dilutionRate,matureDilutionRate,dilutionPath,startRevenue:finite(last.revenue),startShares:finite(last.sharesOutTTM),marginAssumptions:{fcf:margins.currentFCF,ebitda:margins.currentEBITDA,net:margins.currentNet},marginTargets:{fcf:margins.targetFCF,ebitda:margins.targetEBITDA,net:margins.targetNet,matureFCF:margins.matureTargetFCF,matureEBITDA:margins.matureTargetEBITDA,matureNet:margins.matureTargetNet},analystUsed:growth.analystUsed,forecastReliabilityScore:growth.forecastReliabilityScore,historyReliability:growth.historyReliability,historyGrowthDispersion:growth.histDispersion,forecastBridge,forecastFlags};
}
module.exports={buildForecast};
