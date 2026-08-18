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
  if(dividendYield>=0.03 && growth<0.12) return 'Dividend';
  if(sector==='Financials') return growth>=0.10?'Growth':(dividendYield>=0.02?'Dividend':'Value');
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
  // CFO/capex and revenue margins are not economically comparable for banks, brokers,
  // insurers and other Financials. Do not publish fake FCF/EBITDA margin paths for them.
  if(stock.sector==='Financials') return {rawFCF:null,rawEBITDA:null,rawNet:null,currentFCF:null,currentEBITDA:null,currentNet:null,targetFCF:null,targetEBITDA:null,targetNet:null,leverageSignal:0,fcfTrend:null,opTrend:null,grossTrend:null,incrementalFCFMargin:null,incrementalOperatingMargin:null,abnormalCapexCycle:false,reportedFCFMargin:null,normalizedCapexMargin:null,cycleNormalizedFCFMargin:null};
  // Normalize operating economics from several years of reported facts. SBC is NOT
  // subtracted from FCF here because dilution is modeled separately in the share-count
  // path; subtracting SBC and then also diluting the denominator double-counts the same
  // shareholder cost. We still keep SBC intensity in quality scoring.
  const fcfSeries=years.map(fcfMargin), ebitdaSeries=years.map(y=>pctMargin(y,'ebitda')), netSeries=years.map(y=>pctMargin(y,'netIncome'));
  const cfoSeries=years.map(y=>pctMargin(y,'cfo'));
  const capexSeries=years.map(y=>{const r=finite(y?.revenue),c=finite(y?.capex);return r>0&&c!=null?Math.abs(c)/r:null;});
  const daSeries=years.map(y=>{const r=finite(y?.revenue),d=finite(y?.da);return r>0&&d!=null&&d>=0?d/r:null;});
  const opSeries=years.map(y=>Number.isFinite(finite(y?.opMargin))?finite(y.opMargin):pctMargin(y,'operatingIncome'));
  const grossSeries=years.map(y=>Number.isFinite(finite(y?.grossMargin))?finite(y.grossMargin):pctMargin(y,'grossProfit'));

  const latestFCF=fcfSeries.filter(Number.isFinite).at(-1);
  const rawCFO=medianRecent(cfoSeries), rawCapex=medianRecent(capexSeries);
  const directFCF=medianRecent(fcfSeries);
  const reconstructedFCF=Number.isFinite(rawCFO)&&Number.isFinite(rawCapex)?rawCFO-rawCapex:null;

  // Detect an abnormal investment cycle before normalizing FCF. A temporary capex surge
  // can make reported FCF look structurally impaired even when CFO and operating
  // economics remain healthy. In that case, estimate sustainable FCF using a normalized
  // capex burden anchored to the company's own pre-surge history. We do NOT erase capex:
  // maintenance/reinvestment remains in the model, and the adjustment only activates
  // when several independent signals agree.
  const recentCapex=capexSeries.filter(Number.isFinite).at(-1);
  const priorCapex=median(capexSeries.filter(Number.isFinite).slice(-6,-1));
  const recentCFO=cfoSeries.filter(Number.isFinite).at(-1);
  const priorCFO=median(cfoSeries.filter(Number.isFinite).slice(-6,-1));
  const priorFCF=median(fcfSeries.filter(Number.isFinite).slice(-6,-1));
  const recentOp=opSeries.filter(Number.isFinite).at(-1);
  const priorOp=median(opSeries.filter(Number.isFinite).slice(-6,-1));
  const capexSurge=Number.isFinite(recentCapex)&&Number.isFinite(priorCapex)&&priorCapex>=0&&
    recentCapex>Math.max(priorCapex*1.45,priorCapex+.025);
  const fcfDislocation=Number.isFinite(latestFCF)&&Number.isFinite(priorFCF)&&latestFCF<priorFCF-.035;
  const cfoIntact=Number.isFinite(recentCFO)&&Number.isFinite(priorCFO)&&recentCFO>=priorCFO-.035;
  const operationsIntact=Number.isFinite(recentOp)&&Number.isFinite(priorOp)?recentOp>=priorOp-.035:true;
  const abnormalCapexCycle=Boolean(capexSurge&&fcfDislocation&&cfoIntact&&operationsIntact);
  // Split a detected capex spike into a maintenance-like burden and a growth burden.
  // D&A is useful evidence for the installed asset base, while pre-surge capex tells us
  // what the company actually had to spend before the current buildout. Neither is used
  // alone. We then keep part of the excess spend as required growth reinvestment, with
  // the retained share increasing as the forward growth rate rises. This prevents the
  // normalization from pretending that growth capex is free while also preventing one
  // temporary build cycle from permanently crushing FCF.
  const rawDA=medianRecent(daSeries);
  const priorDA=median(daSeries.filter(Number.isFinite).slice(-6,-1));
  const maintenanceAnchor=weightedAverage([[priorCapex,.55],[priorDA,.30],[rawDA,.15]]);
  const growthReinvestmentShare=clamp(.20+Math.max(0,growthInfo.y2-.04)*1.35,.20,.55);
  const excessCapex=abnormalCapexCycle&&Number.isFinite(recentCapex)&&Number.isFinite(maintenanceAnchor)
    ? Math.max(0,recentCapex-maintenanceAnchor)
    : 0;
  const normalizedCapex=abnormalCapexCycle&&Number.isFinite(maintenanceAnchor)
    ? clamp(maintenanceAnchor+excessCapex*growthReinvestmentShare,
        Math.max(0,maintenanceAnchor),recentCapex)
    : rawCapex;
  const cycleNormalizedFCF=abnormalCapexCycle&&Number.isFinite(rawCFO)&&Number.isFinite(normalizedCapex)
    ? rawCFO-normalizedCapex
    : null;
  let rawFCF=abnormalCapexCycle
    ? weightedAverage([[directFCF,.15],[reconstructedFCF,.15],[cycleNormalizedFCF,.70]])
    : weightedAverage([[directFCF,.70],[reconstructedFCF,.30]]);
  const rawEBITDA=medianRecent(ebitdaSeries)??null, rawNet=medianRecent(netSeries)??0.06, rawOp=medianRecent(opSeries)??rawEBITDA??rawNet;

  // If cash-flow facts are incomplete, do not invent a generic 5% FCF margin. A null
  // FCF path is preferable; EPS/EV-EBITDA (or the controlled sales fallback) can still
  // value the company. This removes a major source of false precision.
  if(!Number.isFinite(rawFCF)) rawFCF=null;
  const latestEBITDA=ebitdaSeries.filter(Number.isFinite).at(-1), latestNet=netSeries.filter(Number.isFinite).at(-1);
  // A single distorted filing must not become the starting economics for all five forecast
  // years. Winsorize latest margins around their recent normalized level.
  const saneStart=(latest,norm,lo,hi,band)=>clamp(Number.isFinite(latest)?latest:norm,Math.max(lo,norm-band),Math.min(hi,norm+band));
  const currentFCF=Number.isFinite(rawFCF)?saneStart(latestFCF,rawFCF,-.08,cfg.maxFCFMargin,.10):null;
  const currentEBITDA=Number.isFinite(rawEBITDA)?saneStart(latestEBITDA,rawEBITDA,-.05,Math.min(.65,cfg.maxFCFMargin+.18),.12):null;
  const currentNet=saneStart(latestNet,rawNet,-.08,Math.min(.50,cfg.maxFCFMargin+.08),.10);

  const fcfTrend=clamp(trendSlope(fcfSeries.slice(-4)),-.04,.04)||0;
  const opTrend=clamp(trendSlope(opSeries.slice(-4)),-.04,.04)||0;
  const grossTrend=clamp(trendSlope(grossSeries.slice(-4)),-.03,.03)||0;
  const incFCF=incrementalMargin(years,'fcf');
  const incOp=incrementalMargin(years,'operatingIncome');
  const revGrowth=growthInfo.y2;

  // Evidence-based operating leverage. Margin expansion is allowed when incremental
  // economics and/or recent margins support it; history is a guardrail, not a hard cap.
  let leverageSignal=0;
  if(Number.isFinite(incFCF)&&Number.isFinite(rawFCF)) leverageSignal += clamp((incFCF-rawFCF)*.18,-.018,.025);
  if(Number.isFinite(incOp)) leverageSignal += clamp((incOp-rawOp)*.12,-.012,.018);
  leverageSignal += clamp(fcfTrend*.55,-.015,.018);
  leverageSignal += clamp(opTrend*.25,-.010,.012);
  leverageSignal += clamp(grossTrend*.20,-.006,.008);
  if(revGrowth>0.12 && fcfTrend>=0) leverageSignal+=.004;
  if(revGrowth<0.03 && fcfTrend<0) leverageSignal-=.004;
  leverageSignal=clamp(leverageSignal,-.035,.045);

  const fcfCeiling=cfg.maxFCFMargin;
  const ebitdaCeiling=Math.min(.65,cfg.maxFCFMargin+.18);
  const netCeiling=Math.min(.50,cfg.maxFCFMargin+.08);
  let targetFCF=Number.isFinite(rawFCF)?clamp(rawFCF+leverageSignal,-.08,fcfCeiling):null;
  let targetEBITDA=Number.isFinite(rawEBITDA)?clamp(rawEBITDA+leverageSignal*.80,-.05,ebitdaCeiling):null;
  let targetNet=clamp(rawNet+leverageSignal*.65,-.08,netCeiling);

  // Do not mechanically snap a business back to the median when the latest economics
  // have clearly improved. Conversely, a one-year spike gets only partial credit.
  if(Number.isFinite(targetFCF)&&Number.isFinite(currentFCF))targetFCF=clamp(.60*targetFCF+.40*currentFCF,-.08,fcfCeiling);
  if(Number.isFinite(targetEBITDA)&&Number.isFinite(currentEBITDA))targetEBITDA=clamp(.60*targetEBITDA+.40*currentEBITDA,-.05,ebitdaCeiling);
  targetNet=clamp(.60*targetNet+.40*currentNet,-.08,netCeiling);

  // Profitability/growth consistency. Sustained double-digit growth does not guarantee
  // margin expansion, but a model should not forecast material margin compression when
  // the company's own operating evidence is stable/improving. Only apply this guardrail
  // when at least two independent operating signals support it; otherwise compression is
  // allowed to flow through normally.
  const highGrowth=(growthInfo.year5Growth??growthInfo.y2)>.10;
  const opSupport=(Number.isFinite(incOp)&&Number.isFinite(rawOp)&&incOp>=rawOp-.015)?1:0;
  const opTrendSupport=opTrend>=-.002?1:0;
  const grossSupport=grossTrend>=-.002?1:0;
  const profitabilitySupport=opSupport+opTrendSupport+grossSupport;
  let profitabilityConsistencyApplied=false;
  if(highGrowth&&profitabilitySupport>=2){
    profitabilityConsistencyApplied=true;
    if(Number.isFinite(targetNet)&&Number.isFinite(currentNet)) targetNet=Math.max(targetNet,currentNet-.0075);
    if(Number.isFinite(targetEBITDA)&&Number.isFinite(currentEBITDA)) targetEBITDA=Math.max(targetEBITDA,currentEBITDA-.0075);
    if(Number.isFinite(targetFCF)&&Number.isFinite(currentFCF)&&!abnormalCapexCycle) targetFCF=Math.max(targetFCF,currentFCF-.0125);
  }

  return {rawFCF,rawEBITDA,rawNet,currentFCF,currentEBITDA,currentNet,targetFCF,targetEBITDA,targetNet,leverageSignal,fcfTrend,opTrend,grossTrend,incrementalFCFMargin:incFCF,incrementalOperatingMargin:incOp,abnormalCapexCycle,reportedFCFMargin:latestFCF,normalizedCapexMargin:normalizedCapex,cycleNormalizedFCFMargin:cycleNormalizedFCF,maintenanceCapexMargin:maintenanceAnchor,growthReinvestmentShare,profitabilityConsistencyApplied};
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
    // Operating margins reach the evidence-based target by year 5. The second five-year
    // phase holds that normalized economics rather than delaying the target until year 10.
    const t=Math.min(1,(i+1)/EXPLICIT_FORECAST_YEARS), curved=t*t*(3-2*t);
    const interp=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a+(b-a)*curved:null;
    const fcfMargin=interp(margins.currentFCF,margins.targetFCF);
    const ebitdaMargin=interp(margins.currentEBITDA,margins.targetEBITDA);
    const netMargin=interp(margins.currentNet,margins.targetNet);
    const fcf=revenue!=null&&fcfMargin!=null?revenue*fcfMargin:null, ebitda=revenue!=null&&ebitdaMargin!=null?revenue*ebitdaMargin:null, netIncome=revenue!=null&&netMargin!=null?revenue*netMargin:null;
    rows.push({year:(finite(last.year)||new Date().getFullYear())+i+1,revenueGrowth:growth.growthPath[i],revenue,fcfMargin,ebitdaMargin,netMargin,fcf,ebitda,netIncome,shares,eps:shares>0&&netIncome!=null?netIncome/shares:null,fcfPerShare:shares>0&&fcf!=null?fcf/shares:null,dividendPerShare:dividend});
  }

  const sustainableGrowth=median([growth.y1,growth.y2,growth.historicalAnchor].filter(Number.isFinite))??growth.y1;
  const category=classifyCategory(stock,sustainableGrowth,growth.qualityHint,Number(stock.valuation?.dividendYield)||0);
  const forecastBridge={
    revenue:{model:growth.y1,analystCurrent:safeAnalystGrowth(stock.analystEstimates?.revenueGrowthCurrentYear??stock.analystEstimates?.revenueGrowthFwd),analystNext:safeAnalystGrowth(stock.analystEstimates?.revenueGrowthNextYear),recentQuarter:growth.recentQuarter,recentAnnual:growth.recentAnnual,historicalNormalized:growth.historicalAnchor,terminalOperatingGrowth:growth.year5Growth,analystWeight:growth.analystWeight,structuralStepUp:growth.structuralStepUp,structuralStepDown:growth.structuralStepDown},
    margins:{fcfStart:margins.currentFCF,fcfNormalized:margins.rawFCF,fcfTarget:margins.targetFCF,ebitdaStart:margins.currentEBITDA,ebitdaNormalized:margins.rawEBITDA,ebitdaTarget:margins.targetEBITDA,netStart:margins.currentNet,netNormalized:margins.rawNet,netTarget:margins.targetNet,incrementalFCFMargin:margins.incrementalFCFMargin,incrementalOperatingMargin:margins.incrementalOperatingMargin,fcfTrend:margins.fcfTrend,operatingTrend:margins.opTrend,grossMarginTrend:margins.grossTrend,operatingLeverageAdjustment:margins.leverageSignal,abnormalCapexCycle:margins.abnormalCapexCycle,reportedFCFMargin:margins.reportedFCFMargin,normalizedCapexMargin:margins.normalizedCapexMargin,cycleNormalizedFCFMargin:margins.cycleNormalizedFCFMargin,maintenanceCapexMargin:margins.maintenanceCapexMargin,growthReinvestmentShare:margins.growthReinvestmentShare,profitabilityConsistencyApplied:margins.profitabilityConsistencyApplied},
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

  return {horizonYears:HORIZON_YEARS,category,rows,terminalGrowth:growth.matureGrowth,year5OperatingGrowth:growth.year5Growth,revenueGrowthAnchor:growth.y1,sustainableGrowth,historicalGrowth:growth.historicalAnchor,dilutionRate,matureDilutionRate,dilutionPath,startRevenue:finite(last.revenue),startShares:finite(last.sharesOutTTM),marginAssumptions:{fcf:margins.currentFCF,ebitda:margins.currentEBITDA,net:margins.currentNet},marginTargets:{fcf:margins.targetFCF,ebitda:margins.targetEBITDA,net:margins.targetNet},analystUsed:growth.analystUsed,forecastReliabilityScore:growth.forecastReliabilityScore,historyReliability:growth.historyReliability,historyGrowthDispersion:growth.histDispersion,forecastBridge,forecastFlags};
}
module.exports={buildForecast};
