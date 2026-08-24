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

function inferShareCount(stock,years){
  const last=years.at(-1)||{};
  const direct=[last.sharesOutTTM,last.weightedAverageDilutedShares,last.dilutedShares,last.sharesDiluted]
    .map(finite).filter(x=>x>0);
  if(direct.length)return {shares:direct[0],source:'reported'};
  const price=finite(stock?.price?.current), marketCap=finite(stock?.valuation?.marketCap);
  if(price>0&&marketCap>0){
    const implied=marketCap/price;
    if(implied>0)return {shares:implied,source:'market_cap_implied'};
  }
  // SEC share tags are occasionally missing even when income and diluted EPS are present.
  // Reconstruct the denominator from internally consistent NI/EPS observations rather than
  // declaring an otherwise well-covered company unrateable. Median recent observations
  // suppress one-off restatement/noise and preserve ticker independence.
  const implied=[];
  for(const y of years.slice(-5)){
    const ni=finite(y?.netIncome), eps=finite(y?.dilutedEPS ?? y?.epsDiluted ?? y?.eps);
    if(ni!=null&&eps!=null&&Math.abs(eps)>.0001&&ni*eps>0){
      const sh=ni/eps;
      if(Number.isFinite(sh)&&sh>1e5&&sh<1e12)implied.push(sh);
    }
  }
  const med=median(implied);
  return med>0?{shares:med,source:'earnings_per_share_implied'}:{shares:null,source:null};
}

function classifyCategory(stock,growth,qualityHint,dividendYield){
  const sector=stock.sector||'Unknown';
  const financialLike=stock.financials?.dataQuality?.financialLikeRevenue===true;
  // Category is descriptive, not a return override. High-yield payout vehicles should
  // not be mislabeled Growth merely because reported revenue is volatile (mortgage REITs
  // are the classic failure mode). A very high yield is therefore a strong category signal.
  if(dividendYield>=0.045) return 'Dividend';
  if(dividendYield>=0.03 && growth<0.15) return 'Dividend';
  if(financialLike) return growth>=0.12?'Growth':(dividendYield>=0.02?'Dividend':'Value');
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
  // Durable reinvestment evidence earns a modest, generic persistence premium. This is not
  // a ticker override: it requires both strong underlying economics and corroboration from
  // consensus/history. It helps prevent high-quality growers from being forced toward a
  // mature rate too quickly simply because they are already large.
  const consensusPersistence=(a1!=null&&a2!=null)?clamp(Math.min(a1,a2)-matureGrowth,0,.18):0;
  const historyPersistence=clamp(historicalAnchor-matureGrowth,0,.18)*historyReliability;
  const persistenceEvidence=Math.min(consensusPersistence,Math.max(historyPersistence,consensusPersistence*.55));
  const reinvestmentPersistence=clamp((qualityHint-.45)*.065,0,.032)*clamp(persistenceEvidence/.10,0,1);
  evidenceGrowth+=reinvestmentPersistence;
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
  return {growthPath,y1,y2,matureGrowth,year5Growth,historicalAnchor,recentAnnual,recentQuarter,qualityHint,reinvestmentPersistence,analystWeight,structuralStepUp,structuralStepDown,analystUsed:a1!=null||a2!=null,historyReliability,histDispersion,forecastReliabilityScore};
}

function buildMarginForecast(stock,years,cfg,growthInfo){
  // Margin forecasting is built from one coherent operating model. We forecast operating
  // profitability first, translate it into EBITDA / net income / CFO using the company's
  // own historical relationships, and derive FCF as CFO minus capex. This avoids three
  // independent margin targets drifting into economically contradictory futures.
  if(stock.financials?.dataQuality?.financialLikeRevenue===true) return {
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
  // Spreadsheet-style operating drivers. We intentionally keep these optional because
  // SEC expense tags are less standardized than revenue/operating income. When enough
  // history exists they become a forward operating model; otherwise the consolidated
  // margin model remains the fallback.
  const rdSeries=years.map(y=>pctMargin(y,'researchAndDevelopment'));
  const sgaSeries=years.map(y=>{
    const direct=pctMargin(y,'sellingGeneralAdministrative');
    if(Number.isFinite(direct))return direct;
    const r=finite(y?.revenue), sm=finite(y?.sellingAndMarketing), ga=finite(y?.generalAdministrative);
    return r>0&&sm!=null&&ga!=null?(sm+ga)/r:null;
  });
  const sbcSeriesForEarnings=years.map(y=>pctMargin(y,'sbc'));
  const amortSeries=years.map(y=>pctMargin(y,'intangibleAmortization'));
  const taxSeries=years.map(y=>{
    const pretax=finite(y?.pretaxIncome), tax=finite(y?.incomeTaxExpense);
    return pretax>0&&tax!=null?clamp(tax/pretax,0,.38):null;
  });

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

  // Sector FCF limits are sanity rails, not hard economic destinations. Exceptionally
  // capital-light businesses can sustain cash margins above a generic sector ceiling.
  // Only relax the rail when high FCF is persistent across several years, capex is low,
  // and the history is reasonably stable. This prevents one working-capital windfall from
  // earning a permanently higher ceiling while allowing software/payment-network economics
  // to remain genuinely asset-light.
  const recentFcfForCeiling=fcfSeries.filter(Number.isFinite).slice(-5);
  const recentCapexForCeiling=capexSeries.filter(Number.isFinite).slice(-5);
  const recurringFcfForCeiling=median(recentFcfForCeiling);
  const recurringCapexForCeiling=median(recentCapexForCeiling);
  const fcfDispersionForCeiling=Number.isFinite(recurringFcfForCeiling)
    ? median(recentFcfForCeiling.map(x=>Math.abs(x-recurringFcfForCeiling)))
    : null;
  const persistentCapitalLightHistory=recentFcfForCeiling.length>=3 &&
    Number.isFinite(recurringFcfForCeiling) && recurringFcfForCeiling>=Math.max(.18,cfg.maxFCFMargin-.06) &&
    Number.isFinite(recurringCapexForCeiling) && recurringCapexForCeiling<=.045 &&
    Number.isFinite(fcfDispersionForCeiling) && fcfDispersionForCeiling<=.065;
  const fcfCeiling=persistentCapitalLightHistory
    ? Math.min(.62,Math.max(cfg.maxFCFMargin,recurringFcfForCeiling+.045))
    : cfg.maxFCFMargin;
  const fcfCfoRatiosForStructure=[];
  for(let i=0;i<years.length;i++){
    const fm=fcfSeries[i],cm=cfoSeries[i];
    if(Number.isFinite(fm)&&Number.isFinite(cm)&&cm>.02) fcfCfoRatiosForStructure.push(clamp(fm/cm,0,1.25));
  }
  const recurringFcfCfoRatio=medianRecent(fcfCfoRatiosForStructure,5);
  const recurringCapex=medianRecent(capexSeries.filter(Number.isFinite),5);
  const recurringFcfAll=medianRecent(fcfSeries.filter(Number.isFinite),5);
  const fcfPersistenceCount=fcfSeries.filter(Number.isFinite).slice(-5)
    .filter(x=>x>=Math.max(.16,(recurringFcfAll??0)-.08)).length;
  const structuralCapitalLightCashConversion=Boolean(
    persistentCapitalLightHistory &&
    Number.isFinite(recurringFcfAll) && recurringFcfAll>=.20 &&
    Number.isFinite(recurringCapex) && recurringCapex<=.045 &&
    Number.isFinite(recurringFcfCfoRatio) && recurringFcfCfoRatio>=.72 &&
    fcfPersistenceCount>=3
  );
  const saneStart=(latest,norm,lo,hi,band)=>clamp(Number.isFinite(latest)?latest:norm,Math.max(lo,norm-band),Math.min(hi,norm+band));
  const currentOperating=saneStart(latestOp,rawOp,-.10,opCeiling,.10);
  const currentEBITDA=Number.isFinite(rawEBITDA)?saneStart(latestEBITDA,rawEBITDA,-.05,ebitdaCeiling,.12):null;
  let currentNet=saneStart(latestNet,rawNet,-.10,netCeiling,.10);
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

  // --- Spreadsheet-style operating build ---------------------------------
  // When gross margin + R&D + SG&A are observable, forecast the expense ratios directly.
  // This mirrors the user's spreadsheet: revenue growth creates operating leverage because
  // R&D/SG&A do not have to grow one-for-one with revenue. The result is blended with the
  // consolidated-margin model so imperfect SEC tagging cannot take over the forecast.
  const grossNow=medianRecent(grossSeries.filter(Number.isFinite),3);
  const rdNow=medianRecent(rdSeries.filter(Number.isFinite),3);
  const sgaNow=medianRecent(sgaSeries.filter(Number.isFinite),3);
  const driverCoverage=Math.min(
    grossSeries.filter(Number.isFinite).length,
    rdSeries.filter(Number.isFinite).length,
    sgaSeries.filter(Number.isFinite).length
  );
  const growthForLeverage=clamp(weightedAverage([[growthInfo.y1,.25],[growthInfo.y2,.35],[growthInfo.year5Growth,.40]])??0,-.05,.25);
  const leverageIntensity=clamp((growthForLeverage-.035)/.165,0,1);
  const grossTarget=Number.isFinite(grossNow)
    ? clamp(grossNow+clamp(grossTrend*2.2,-.025,.035)+leverageIntensity*.006,.05,.85)
    : null;
  const rdHistoricalFloor=median(rdSeries.filter(Number.isFinite).slice(-6)) ?? rdNow;
  const sgaHistoricalFloor=median(sgaSeries.filter(Number.isFinite).slice(-6)) ?? sgaNow;
  const rdTarget=Number.isFinite(rdNow)
    ? clamp(rdNow*(1-.18*leverageIntensity),Math.max(.01,(rdHistoricalFloor??rdNow)*.72),.45)
    : null;
  const sgaTarget=Number.isFinite(sgaNow)
    ? clamp(sgaNow*(1-.25*leverageIntensity),Math.max(.015,(sgaHistoricalFloor??sgaNow)*.65),.40)
    : null;
  const otherOpexSamples=[];
  for(let i=0;i<years.length;i++){
    const gm=grossSeries[i],op=opSeries[i],rd=rdSeries[i],sg=sgaSeries[i];
    if(Number.isFinite(gm)&&Number.isFinite(op)&&Number.isFinite(rd)&&Number.isFinite(sg)){
      otherOpexSamples.push(clamp(gm-op-rd-sg,-.04,.30));
    }
  }
  const otherOpexNow=medianRecent(otherOpexSamples,4);
  let driverTargetOperating=null;
  if(driverCoverage>=2&&[grossTarget,rdTarget,sgaTarget,otherOpexNow].every(Number.isFinite)){
    const otherTarget=clamp(otherOpexNow*(1-.10*leverageIntensity),-.04,.30);
    driverTargetOperating=clamp(grossTarget-rdTarget-sgaTarget-otherTarget,-.10,opCeiling);
    const driverWeight=clamp(.42+.10*Math.min(driverCoverage,4)+.16*leverageIntensity,.52,.82);
    targetOperating=clamp(weightedAverage([[driverTargetOperating,driverWeight],[targetOperating,1-driverWeight]]),-.10,opCeiling);
  }

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

  // Investor-normalized earnings bridge. The spreadsheet values normalized/non-GAAP
  // earnings while modeling dilution separately. We do the same generically: recurring
  // SBC and identifiable acquired-intangible amortization are added back after tax, while
  // the share-count model still charges the shareholder for SBC via dilution. Amortization
  // is modeled mainly as a fixed-dollar legacy charge, so its margin naturally falls as
  // revenue grows rather than remaining a permanent percentage of sales.
  const normalizedTaxRate=clamp(medianRecent(taxSeries.filter(Number.isFinite),5)??.21,.08,.32);
  const sbcNowForEarnings=medianRecent(sbcSeriesForEarnings.filter(Number.isFinite),3);
  const amortNow=medianRecent(amortSeries.filter(Number.isFinite),3);
  const explicitRevenueScale=(growthInfo.growthPath||[]).slice(0,EXPLICIT_FORECAST_YEARS)
    .reduce((x,g)=>x*(1+(Number.isFinite(g)?g:0)),1);
  const fullRevenueScale=(growthInfo.growthPath||[]).slice(0,HORIZON_YEARS)
    .reduce((x,g)=>x*(1+(Number.isFinite(g)?g:0)),1);
  const sbcTarget=Number.isFinite(sbcNowForEarnings)?clamp(sbcNowForEarnings*(1-.15*leverageIntensity),0,.25):null;
  const sbcMature=Number.isFinite(sbcTarget)?clamp(sbcTarget*(1-.12*leverageIntensity),0,.22):null;
  const amortTarget=Number.isFinite(amortNow)?clamp(amortNow*.90/Math.max(1,explicitRevenueScale),0,.15):null;
  const amortMature=Number.isFinite(amortNow)?clamp(amortNow*.80/Math.max(1,fullRevenueScale),0,.10):null;
  const afterTax=x=>Number.isFinite(x)?x*(1-normalizedTaxRate):0;
  const currentNormalizationAddback=clamp(afterTax(sbcNowForEarnings)+afterTax(amortNow),0,.16);
  const targetNormalizationAddback=clamp(afterTax(sbcTarget)+afterTax(amortTarget),0,.14);
  const matureNormalizationAddback=clamp(afterTax(sbcMature)+afterTax(amortMature),0,.12);
  const gaapCurrentNet=currentNet;
  let gaapTargetNet=targetNet, gaapMatureTargetNet=matureTargetNet;
  currentNet=clamp(currentNet+currentNormalizationAddback,-.10,netCeiling);
  targetNet=clamp(targetNet+targetNormalizationAddback,-.10,netCeiling);
  matureTargetNet=clamp(matureTargetNet+matureNormalizationAddback,-.10,netCeiling);

  // V11.16 earnings-power persistence. A growing company can pass through a temporary
  // integration / investment / mix-reset period without its year-10 economics being worse
  // than its already-normalized year-5 economics. Previously the mature model could fade
  // margins back down simply because the historical accounting bridge was noisy, which
  // systematically punished acquisition-heavy and fast-scaling businesses. Preserve the
  // normalized target unless there is broad, independent evidence of structural compression.
  if(compressionVotes<3 && durableGrowth>.035){
    if(Number.isFinite(currentEBITDA)&&Number.isFinite(matureTargetEBITDA)) matureTargetEBITDA=Math.max(matureTargetEBITDA,currentEBITDA-.0075);
    if(Number.isFinite(currentNet)&&Number.isFinite(matureTargetNet)) matureTargetNet=Math.max(matureTargetNet,currentNet-.0075);
    if(durableGrowth>.05){
      if(Number.isFinite(targetEBITDA)&&Number.isFinite(matureTargetEBITDA)) matureTargetEBITDA=Math.max(matureTargetEBITDA,targetEBITDA-.003);
      if(Number.isFinite(targetNet)&&Number.isFinite(matureTargetNet)) matureTargetNet=Math.max(matureTargetNet,targetNet-.002);
    }
  }

  // Detect a likely temporary margin reset: revenue has stepped up materially while the
  // latest accounting margin is well below the company's own pre-reset norm. This commonly
  // occurs after acquisitions, distribution changes, product launches or capacity buildouts.
  // It is deliberately evidence-based and ticker-agnostic. When forward growth remains
  // healthy and there is not broad structural compression, allow a measured recovery toward
  // the pre-reset margin rather than extrapolating the depressed year for a decade.
  const priorNet=median(netSeries.filter(Number.isFinite).slice(-6,-1));
  const priorEBITDA=median(ebitdaSeries.filter(Number.isFinite).slice(-6,-1));
  const latestRevenueGrowth=yoySeries(years.slice(-3),'revenue').filter(Number.isFinite).at(-1);
  const temporaryMarginReset=Boolean(
    Number.isFinite(latestRevenueGrowth) && latestRevenueGrowth>.20 &&
    durableGrowth>.06 && compressionVotes<4 && (
      Number.isFinite(priorNet)&&Number.isFinite(currentNet)&&priorNet>currentNet+.020 ||
      Number.isFinite(priorEBITDA)&&Number.isFinite(currentEBITDA)&&priorEBITDA>currentEBITDA+.025
    )
  );
  if(temporaryMarginReset){
    if(Number.isFinite(priorNet)){
      const recoveryNet=clamp(weightedAverage([[priorNet,.62],[targetNet,.38]]),-.10,netCeiling);
      if(Number.isFinite(recoveryNet)) matureTargetNet=Math.max(matureTargetNet,recoveryNet);
    }
    if(Number.isFinite(priorEBITDA)){
      const recoveryEBITDA=clamp(weightedAverage([[priorEBITDA,.62],[targetEBITDA,.38]]),-.05,ebitdaCeiling);
      if(Number.isFinite(recoveryEBITDA)) matureTargetEBITDA=Math.max(matureTargetEBITDA,recoveryEBITDA);
    }
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
    // temporary working-capital benefits. Persistent capital-light cash conversion retains
    // most of the spread; ordinary businesses still receive conservative normalization.
    if(matureCfoSpread>.10){
      const retention=structuralCapitalLightCashConversion?.88:.55;
      matureCfoSpread=.10+(matureCfoSpread-.10)*retention;
    }
    if(matureCfoSpread<-.05) matureCfoSpread=-.05+(matureCfoSpread+.05)*.65;
  }
  let matureCFO=Number.isFinite(matureCfoSpread)?clamp(matureOperating+matureCfoSpread,-.08,.70):targetCFO;
  if(Number.isFinite(currentCFO)&&Number.isFinite(targetCFO)) targetCFO=clamp(weightedAverage([[targetCFO,.70],[currentCFO,.30]]),-.08,.70);

  // V11.18 earnings-derived owner cash flow. FCF should tell the same economic story as
  // operating earnings unless the model can identify a concrete reinvestment burden. The
  // old implementation independently mean-reverted CFO/operating and FCF/EBITDA spreads;
  // that could make FCF margins collapse even while EBITDA and net margins improved.
  //
  // We now treat recurring FCF-minus-net-income as the company's cash-conversion signature,
  // derive future owner cash from projected earnings, and use CFO-capex only as a secondary
  // accounting cross-check. Capex can still pull FCF lower when the forecast explicitly
  // models a structurally higher reinvestment burden.
  const priorFcfMargins=fcfSeries.filter(Number.isFinite).slice(-6,-1);
  const fcfNetSpreads=[];
  for(let i=0;i<years.length-1;i++){
    if(Number.isFinite(fcfSeries[i])&&Number.isFinite(netSeries[i])){
      fcfNetSpreads.push(clamp(fcfSeries[i]-netSeries[i],-.18,.28));
    }
  }
  const recurringFcfNetSpread=medianRecent(fcfNetSpreads,5);
  const recurringFCF=median(priorFcfMargins);
  const cashSpreadSamples=fcfNetSpreads.filter(Number.isFinite).length;
  const cashSpreadReliability=clamp(cashSpreadSamples/4,0,1);

  let currentFCF=Number.isFinite(currentCFO)&&Number.isFinite(currentCapex)?currentCFO-currentCapex:latestFCF;

  // Normalize the latest cash margin only when it is clearly a one-off working-capital spike.
  const historicalFcfEbitda=[];
  for(let i=0;i<years.length-1;i++){
    if(Number.isFinite(fcfSeries[i])&&Number.isFinite(ebitdaSeries[i])) historicalFcfEbitda.push(fcfSeries[i]-ebitdaSeries[i]);
  }
  const recurringFcfEbitdaSpread=medianRecent(historicalFcfEbitda,5);
  const latestCashOutlier=Number.isFinite(latestFCF)&&Number.isFinite(latestEBITDA)&&Number.isFinite(recurringFcfEbitdaSpread)&&
    latestFCF-latestEBITDA>Math.max(.045,recurringFcfEbitdaSpread+.04);

  // Preserve more of a positive cash-conversion premium when growth and profitability are
  // healthy. A negative spread is allowed to recover as margins normalize rather than being
  // locked in forever. This is company-specific and uses the firm's own history.
  const baseSpread=Number.isFinite(recurringFcfNetSpread)?recurringFcfNetSpread:
    (Number.isFinite(currentFCF)&&Number.isFinite(currentNet)?currentFCF-currentNet:null);
  let targetSpread=null,matureSpread=null;
  if(Number.isFinite(baseSpread)){
    const positiveRetention=durableGrowth>.10?.96:durableGrowth>.06?.92:.86;
    const matureRetention=durableGrowth>.10?.90:durableGrowth>.06?.86:.78;
    if(baseSpread>=0){
      targetSpread=baseSpread*positiveRetention;
      matureSpread=baseSpread*matureRetention;
    }else{
      targetSpread=baseSpread*.70;
      matureSpread=baseSpread*.45;
    }
  }

  let earningsCashTarget=Number.isFinite(targetNet)&&Number.isFinite(targetSpread)
    ? clamp(targetNet+targetSpread,-.10,fcfCeiling):null;
  let earningsCashMature=Number.isFinite(matureTargetNet)&&Number.isFinite(matureSpread)
    ? clamp(matureTargetNet+matureSpread,-.10,fcfCeiling):null;

  const cashModelTarget=Number.isFinite(targetCFO)&&Number.isFinite(targetCapex)?targetCFO-targetCapex:null;
  const cashModelMature=Number.isFinite(matureCFO)&&Number.isFinite(matureCapex)?matureCFO-matureCapex:null;

  // Explicit capex burden is the principal reason projected FCF may lag improving earnings.
  // Compare future capex with the normalized maintenance/growth anchor rather than allowing
  // historical CFO spread mean reversion to create an unexplained cash-flow haircut.
  const normalizedCapexAnchor=Number.isFinite(maintenanceAnchor)?maintenanceAnchor:
    (Number.isFinite(targetCapex)?targetCapex:null);
  const targetCapexBurden=Number.isFinite(targetCapex)&&Number.isFinite(normalizedCapexAnchor)
    ? Math.max(0,targetCapex-normalizedCapexAnchor):0;
  const matureCapexBurden=Number.isFinite(matureCapex)&&Number.isFinite(normalizedCapexAnchor)
    ? Math.max(0,matureCapex-normalizedCapexAnchor):0;
  if(Number.isFinite(earningsCashTarget)) earningsCashTarget-=targetCapexBurden;
  if(Number.isFinite(earningsCashMature)) earningsCashMature-=matureCapexBurden;

  // Earnings-derived FCF is the primary forecast. CFO-capex remains a cross-check with more
  // influence only when cash-conversion history is sparse or explicit capex pressure exists.
  const targetAccountingWeight=clamp(.30-.18*cashSpreadReliability+(targetCapexBurden>.01?.18:0),.10,.48);
  const matureAccountingWeight=clamp(.26-.14*cashSpreadReliability+(matureCapexBurden>.01?.22:0),.12,.52);
  let targetFCF=weightedAverage([
    [earningsCashTarget,1-targetAccountingWeight],
    [cashModelTarget,targetAccountingWeight]
  ]);
  let matureTargetFCF=weightedAverage([
    [earningsCashMature,1-matureAccountingWeight],
    [cashModelMature,matureAccountingWeight]
  ]);
  if(!Number.isFinite(targetFCF)) targetFCF=Number.isFinite(cashModelTarget)?cashModelTarget:directFCF;
  if(!Number.isFinite(matureTargetFCF)) matureTargetFCF=Number.isFinite(targetFCF)?targetFCF:cashModelMature;

  // Persistent capital-light businesses keep their demonstrated cash economics. This is a
  // floor, not a ticker override, and is activated only by multi-year evidence already
  // detected above.
  if(structuralCapitalLightCashConversion && Number.isFinite(recurringFcfAll)){
    const dilutionHist=yoySeries(years.slice(-5),'sharesOutTTM').filter(x=>x>-.20&&x<.25);
    const dilutionPenalty=Math.max(0,median(dilutionHist)??0);
    const preservation=clamp(.92-dilutionPenalty*1.5,.80,.92);
    const structuralTargetFloor=clamp(recurringFcfAll*.94,-.10,fcfCeiling);
    const structuralMatureFloor=clamp(recurringFcfAll*preservation,-.10,fcfCeiling);
    targetFCF=Number.isFinite(targetFCF)?Math.max(targetFCF,structuralTargetFloor):structuralTargetFloor;
    matureTargetFCF=Number.isFinite(matureTargetFCF)?Math.max(matureTargetFCF,structuralMatureFloor):structuralMatureFloor;
  }

  if(latestCashOutlier && !structuralCapitalLightCashConversion){
    const normalizedStart=weightedAverage([[recurringFCF,.45],[earningsCashTarget,.35],[cashModelTarget,.20]]);
    if(Number.isFinite(normalizedStart)) currentFCF=clamp(normalizedStart,-.10,fcfCeiling);
  }

  currentFCF=Number.isFinite(currentFCF)?clamp(currentFCF,-.10,fcfCeiling):null;
  targetFCF=Number.isFinite(targetFCF)?clamp(targetFCF,-.10,fcfCeiling):null;
  matureTargetFCF=Number.isFinite(matureTargetFCF)?clamp(matureTargetFCF,-.10,fcfCeiling):null;

  // Multi-signal operating leverage is direct evidence that near-term owner cash should not
  // be mean-reverted below the already-demonstrated normalized cash margin when capex is not
  // becoming structurally heavier.
  if(expansionVotes>=2 && leverageSignal>0 && targetCapexBurden<=.01 && Number.isFinite(currentFCF) && Number.isFinite(targetFCF)){
    targetFCF=Math.max(targetFCF,currentFCF);
    if(Number.isFinite(matureTargetFCF)) matureTargetFCF=Math.max(matureTargetFCF,targetFCF-.01);
  }

  // Coherence rule: when projected accounting profitability improves and capex burden is
  // not worsening, FCF is not allowed to deteriorate materially without evidence. This is
  // intentionally directional rather than a blanket "FCF must rise" rule.
  let unexplainedFcfCompressionPrevented=false;
  const netImproving=Number.isFinite(currentNet)&&Number.isFinite(matureTargetNet)&&matureTargetNet>=currentNet+.003;
  const ebitdaImproving=Number.isFinite(currentEBITDA)&&Number.isFinite(matureTargetEBITDA)&&matureTargetEBITDA>=currentEBITDA+.003;
  const capexCompressionEvidence=Number.isFinite(targetCapex)&&Number.isFinite(matureCapex)
    ? matureCapex>targetCapex+.010:false;
  const operatingCompressionEvidence=Number.isFinite(targetOperating)&&Number.isFinite(matureOperating)
    ? matureOperating<targetOperating-.015:false;
  // Generic historical 'compression votes' are useful for the accounting-margin model, but
  // they are not enough by themselves to justify a decade-long collapse in owner cash. For
  // FCF we require a concrete cash burden: structurally heavier capex or a material decline
  // in the operating/earnings margins that fund cash generation. This is what prevents the
  // CELH/ELF-style artificial cash trough while still allowing genuine reinvestment cycles.
  const earningsCompressionEvidence=Boolean(
    (Number.isFinite(targetNet)&&Number.isFinite(currentNet)&&targetNet<currentNet-.015) ||
    (Number.isFinite(targetEBITDA)&&Number.isFinite(currentEBITDA)&&targetEBITDA<currentEBITDA-.020) ||
    operatingCompressionEvidence
  );
  const broadCashCompressionEvidence=capexCompressionEvidence||earningsCompressionEvidence;

  const accountingStableOrBetter=Boolean(
    (Number.isFinite(targetNet)&&Number.isFinite(currentNet)&&targetNet>=currentNet-.0075) ||
    (Number.isFinite(targetEBITDA)&&Number.isFinite(currentEBITDA)&&targetEBITDA>=currentEBITDA-.010) ||
    (Number.isFinite(targetOperating)&&Number.isFinite(currentOperating)&&targetOperating>=currentOperating-.010)
  );

  // Year-5 coherence matters just as much as terminal coherence. Previously the engine could
  // force target FCF almost to zero and then let it recover by year 10, producing a U-shaped
  // cash path with no modeled economic cause. If earnings economics are broadly intact and
  // capex is not structurally heavier, only modest cash normalization is permitted.
  if(!broadCashCompressionEvidence && accountingStableOrBetter && Number.isFinite(currentFCF) && Number.isFinite(targetFCF)){
    const allowedTargetDrop=durableGrowth>.10?.018:durableGrowth>.06?.022:.028;
    const targetCoherenceFloor=currentFCF-allowedTargetDrop;
    if(targetFCF<targetCoherenceFloor){
      targetFCF=clamp(targetCoherenceFloor,-.10,fcfCeiling);
      unexplainedFcfCompressionPrevented=true;
    }
  }

  if(!broadCashCompressionEvidence && (netImproving||ebitdaImproving||accountingStableOrBetter) && Number.isFinite(currentFCF) && Number.isFinite(matureTargetFCF)){
    // Allow modest normalization of a high current cash margin, but not a multi-point collapse
    // while the rest of the operating model is stable or improving.
    const allowedDrop=durableGrowth>.10?.015:durableGrowth>.06?.020:.025;
    const coherenceFloor=currentFCF-allowedDrop;
    if(matureTargetFCF<coherenceFloor){
      matureTargetFCF=clamp(coherenceFloor,-.10,fcfCeiling);
      unexplainedFcfCompressionPrevented=true;
    }
  }

  // Also preserve the year-5 cash economics into maturity unless there is explicit evidence
  // that reinvestment intensity or operating profitability worsens.
  if(!broadCashCompressionEvidence && Number.isFinite(targetFCF)&&Number.isFinite(matureTargetFCF)){
    const preservation=durableGrowth>.10?.97:durableGrowth>.06?.94:.90;
    const matureFloor=Math.max(targetFCF*preservation,targetFCF-(durableGrowth>.06?.015:.025));
    if(matureTargetFCF<matureFloor){
      matureTargetFCF=clamp(matureFloor,-.10,fcfCeiling);
      unexplainedFcfCompressionPrevented=true;
    }
  }

  // Synchronize CFO to the chosen owner-cash forecast so annual rows still satisfy the
  // accounting identity FCF = CFO - capex. CFO is now the balancing cash-conversion output,
  // not an independent decade-long mean-reversion engine.
  if(Number.isFinite(targetFCF)&&Number.isFinite(targetCapex)) targetCFO=clamp(targetFCF+targetCapex,-.08,.70);
  if(Number.isFinite(matureTargetFCF)&&Number.isFinite(matureCapex)) matureCFO=clamp(matureTargetFCF+matureCapex,-.08,.70);

  let crossMarginCoherenceApplied=unexplainedFcfCompressionPrevented;
  const cycleNormalizedFCF=abnormalCapexCycle&&Number.isFinite(currentCFO)&&Number.isFinite(targetCapex)?currentCFO-targetCapex:null;
  const profitabilityConsistencyApplied=Boolean(compressionVotes<3&&durableGrowth>.035||crossMarginCoherenceApplied);

  gaapTargetNet=Number.isFinite(targetNet)?clamp(targetNet-targetNormalizationAddback,-.10,netCeiling):gaapTargetNet;
  gaapMatureTargetNet=Number.isFinite(matureTargetNet)?clamp(matureTargetNet-matureNormalizationAddback,-.10,netCeiling):gaapMatureTargetNet;
  const grossMature=Number.isFinite(grossTarget)?clamp(grossTarget+Math.max(0,grossTrend)*1.2,.05,.85):grossTarget;
  const rdMature=Number.isFinite(rdTarget)?clamp(rdTarget*(1-.08*leverageIntensity),.01,.45):rdTarget;
  const sgaMature=Number.isFinite(sgaTarget)?clamp(sgaTarget*(1-.10*leverageIntensity),.015,.40):sgaTarget;

  return {
    rawFCF:directFCF,rawEBITDA,rawNet,currentFCF,currentEBITDA,currentNet,targetFCF,targetEBITDA,targetNet,
    matureTargetFCF,matureTargetEBITDA,matureTargetNet,currentOperating,targetOperating,matureOperating,
    currentCFO,targetCFO,matureCFO,currentCapex,targetCapex,matureCapex,leverageSignal,fcfTrend,opTrend,grossTrend,
    incrementalFCFMargin:incFCF,incrementalOperatingMargin:incOp,analystMarginGrowth,analystMarginDelta,
    expansionVotes,compressionVotes,abnormalCapexCycle,reportedFCFMargin:latestFCF,normalizedCapexMargin:targetCapex,
    cycleNormalizedFCFMargin:cycleNormalizedFCF,maintenanceCapexMargin:maintenanceAnchor,growthReinvestmentShare,
    matureGrowthReinvestmentShare,normalizedCFO:rawCFO,cashEconomicsTarget:matureTargetFCF,profitabilityConsistencyApplied,
    structuralCapitalLightCashConversion,recurringFcfCfoRatio,fcfCeiling,crossMarginCoherenceApplied,
    unexplainedFcfCompressionPrevented,broadCashCompressionEvidence,temporaryMarginReset,
    normalizedTaxRate,gaapCurrentNet,gaapTargetNet,gaapMatureTargetNet,
    currentNormalizationAddback,targetNormalizationAddback,matureNormalizationAddback,
    grossNow,grossTarget,grossMature,rdNow,rdTarget,rdMature,sgaNow,sgaTarget,sgaMature,
    sbcNowForEarnings,sbcTarget,sbcMature,amortNow,amortTarget,amortMature,
    driverTargetOperating,driverCoverage,leverageIntensity
  };
}
function buildForecast(stock){
  const years=stock.financials?.years||[], last=years.at(-1)||{}, cfg=sectorConfig(stock.sector);
  const growth=buildGrowthForecast(stock,years,cfg);
  const margins=buildMarginForecast(stock,years,cfg,growth);

  const shareGrowth=yoySeries(years.slice(-5),'sharesOutTTM').filter(x=>x>-.25&&x<.30);
  const recentShareGrowth=shareGrowth.at(-1), medianShareGrowth=median(shareGrowth)??0;
  // V11.20: share count is modeled as capital allocation, not as a decade-long
  // extrapolation of the latest issuance/buyback rate. Recent behavior matters most
  // in years 1-2, then the path converges toward what SBC and owner cash can actually
  // support at a more mature scale. This prevents high-growth issuers from compounding
  // today's dilution forever and prevents mature buyback programs from shrinking the
  // denominator unrealistically for a full decade.
  const observedDilution=clamp(weightedAverage([[recentShareGrowth,.60],[medianShareGrowth,.40]])??0,-.06,.08);
  const sbcSeries=years.slice(-5).map(y=>finite(y?.sbcIntensity)).filter(x=>Number.isFinite(x)&&x>=0&&x<.50);
  const sbcNow=finite(last.sbcIntensity), sbcNormalized=median(sbcSeries);
  const normalizedSbc=Number.isFinite(sbcNow)||Number.isFinite(sbcNormalized)
    ? clamp(weightedAverage([[sbcNow,.60],[sbcNormalized,.40]])??0,0,.30) : null;
  // SBC/revenue is not identical to share issuance, so only a modest fraction is
  // translated into expected net dilution. The rest may be offset by repurchases.
  const sbcImpliedDilution=Number.isFinite(normalizedSbc)?clamp(normalizedSbc*.18,0,.025):.004;
  const ownerCash=median(years.slice(-4).map(fcfMargin).filter(Number.isFinite));
  const forwardGrowth=Math.max(0,finite(growth.y1)||0,finite(growth.y2)||0);
  // Fast-growing companies should retain more cash for reinvestment; mature cash-rich
  // businesses can sustain larger buybacks. This is deliberately capped so even very
  // strong repurchasers do not mechanically retire several percent of shares forever.
  const reinvestmentDrag=clamp((forwardGrowth-.08)/.22,0,.70);
  const grossBuybackCapacity=Number.isFinite(ownerCash)?clamp((ownerCash-.07)*.12,0,.022):0;
  const buybackCapacity=grossBuybackCapacity*(1-reinvestmentDrag);

  let dilutionRate;
  if(observedDilution>0){
    dilutionRate=clamp(.58*observedDilution+.42*sbcImpliedDilution,0,.05);
  }else{
    const supportedBuyback=-Math.min(Math.abs(observedDilution),buybackCapacity);
    dilutionRate=clamp(.65*observedDilution+.35*supportedBuyback,-.025,0);
  }

  const matureDilutionRate=observedDilution>0
    ? clamp(sbcImpliedDilution*.45-buybackCapacity*.35,-.005,.010)
    : clamp(-buybackCapacity*.45,-.010,0);

  // Explicit fast fade: current behavior dominates years 1-2, but by year 5 the
  // denominator is close to a sustainable mature-state assumption.
  const dilutionFade=[1.00,.72,.48,.30,.18,.10,.05,.02,0,0];
  const dilutionPath=Array.from({length:HORIZON_YEARS},(_,i)=>{
    const w=dilutionFade[Math.min(i,dilutionFade.length-1)];
    return dilutionRate*w+matureDilutionRate*(1-w);
  });

  const shareInfo=inferShareCount(stock,years);
  const reportedShares=shareInfo.source==='reported'?shareInfo.shares:null;
  const inferredShares=shareInfo.shares;
  let revenue=finite(last.revenue)>0?finite(last.revenue):null, shares=inferredShares, dividend=Math.max(0,finite(last.dividendPerShare)||0);
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
    const gaapNetMargin=firstPhase?interp(margins.gaapCurrentNet,margins.gaapTargetNet):interp(margins.gaapTargetNet,margins.gaapMatureTargetNet);
    const grossMargin=firstPhase?interp(margins.grossNow,margins.grossTarget):interp(margins.grossTarget,margins.grossMature);
    const rdMargin=firstPhase?interp(margins.rdNow,margins.rdTarget):interp(margins.rdTarget,margins.rdMature);
    const sgaMargin=firstPhase?interp(margins.sgaNow,margins.sgaTarget):interp(margins.sgaTarget,margins.sgaMature);
    const sbcMargin=firstPhase?interp(margins.sbcNowForEarnings,margins.sbcTarget):interp(margins.sbcTarget,margins.sbcMature);
    const intangibleAmortizationMargin=firstPhase?interp(margins.amortNow,margins.amortTarget):interp(margins.amortTarget,margins.amortMature);
    const capexMargin=firstPhase?interp(margins.currentCapex,margins.targetCapex):interp(margins.targetCapex,margins.matureCapex);
    // V11.19: interpolate the already-underwritten owner-cash targets directly. The margin
    // engine has already incorporated earnings conversion, capex burden, and coherence
    // guardrails; reconstructing FCF from a separately interpolated CFO path could recreate
    // the very U-shaped trough we removed upstream. CFO is therefore the balancing output.
    const modeledFcfMargin=firstPhase?interp(margins.currentFCF,margins.targetFCF):interp(margins.targetFCF,margins.matureTargetFCF);
    const rowFcfCeiling=Number.isFinite(margins.fcfCeiling)?margins.fcfCeiling:cfg.maxFCFMargin;
    const fcfMargin=Number.isFinite(modeledFcfMargin)?clamp(modeledFcfMargin,-.10,rowFcfCeiling):modeledFcfMargin;
    const cfoMargin=Number.isFinite(fcfMargin)&&Number.isFinite(capexMargin)
      ? clamp(fcfMargin+capexMargin,-.08,.70)
      : (firstPhase?interp(margins.currentCFO,margins.targetCFO):interp(margins.targetCFO,margins.matureCFO));
    const fcf=revenue!=null&&fcfMargin!=null?revenue*fcfMargin:null, ebitda=revenue!=null&&ebitdaMargin!=null?revenue*ebitdaMargin:null, netIncome=revenue!=null&&netMargin!=null?revenue*netMargin:null;
    const gaapNetIncome=revenue!=null&&gaapNetMargin!=null?revenue*gaapNetMargin:null;
    rows.push({year:(finite(last.year)||new Date().getFullYear())+i+1,revenueGrowth:growth.growthPath[i],revenue,
      grossMargin,rdMargin,sgaMargin,sbcMargin,intangibleAmortizationMargin,taxRate:margins.normalizedTaxRate,
      operatingMargin,fcfMargin,cfoMargin,capexMargin,ebitdaMargin,gaapNetMargin,netMargin,
      fcf,ebitda,gaapNetIncome,netIncome,shares,eps:shares>0&&netIncome!=null?netIncome/shares:null,
      gaapEps:shares>0&&gaapNetIncome!=null?gaapNetIncome/shares:null,fcfPerShare:shares>0&&fcf!=null?fcf/shares:null,dividendPerShare:dividend});
  }

  const sustainableGrowth=median([growth.y1,growth.y2,growth.historicalAnchor].filter(Number.isFinite))??growth.y1;
  const category=classifyCategory(stock,sustainableGrowth,growth.qualityHint,Number(stock.valuation?.dividendYield)||0);
  const forecastBridge={
    revenue:{model:growth.y1,analystCurrent:safeAnalystGrowth(stock.analystEstimates?.revenueGrowthCurrentYear??stock.analystEstimates?.revenueGrowthFwd),analystNext:safeAnalystGrowth(stock.analystEstimates?.revenueGrowthNextYear),recentQuarter:growth.recentQuarter,recentAnnual:growth.recentAnnual,historicalNormalized:growth.historicalAnchor,terminalOperatingGrowth:growth.year5Growth,analystWeight:growth.analystWeight,structuralStepUp:growth.structuralStepUp,structuralStepDown:growth.structuralStepDown},
    margins:{fcfStart:margins.currentFCF,fcfNormalized:margins.rawFCF,fcfTarget:margins.targetFCF,fcfMatureTarget:margins.matureTargetFCF,operatingStart:margins.currentOperating,operatingTarget:margins.targetOperating,operatingMatureTarget:margins.matureOperating,ebitdaStart:margins.currentEBITDA,ebitdaNormalized:margins.rawEBITDA,ebitdaTarget:margins.targetEBITDA,ebitdaMatureTarget:margins.matureTargetEBITDA,netStart:margins.currentNet,netNormalized:margins.currentNet,gaapNetNormalized:margins.rawNet,netTarget:margins.targetNet,netMatureTarget:margins.matureTargetNet,cfoStart:margins.currentCFO,cfoTarget:margins.targetCFO,cfoMatureTarget:margins.matureCFO,capexStart:margins.currentCapex,capexTarget:margins.targetCapex,capexMatureTarget:margins.matureCapex,incrementalFCFMargin:margins.incrementalFCFMargin,incrementalOperatingMargin:margins.incrementalOperatingMargin,analystMarginGrowth:margins.analystMarginGrowth,analystMarginDelta:margins.analystMarginDelta,expansionVotes:margins.expansionVotes,compressionVotes:margins.compressionVotes,fcfTrend:margins.fcfTrend,operatingTrend:margins.opTrend,grossMarginTrend:margins.grossTrend,operatingLeverageAdjustment:margins.leverageSignal,abnormalCapexCycle:margins.abnormalCapexCycle,reportedFCFMargin:margins.reportedFCFMargin,normalizedCapexMargin:margins.normalizedCapexMargin,cycleNormalizedFCFMargin:margins.cycleNormalizedFCFMargin,maintenanceCapexMargin:margins.maintenanceCapexMargin,growthReinvestmentShare:margins.growthReinvestmentShare,matureGrowthReinvestmentShare:margins.matureGrowthReinvestmentShare,matureCapexMargin:margins.matureCapex,normalizedCFOMargin:margins.normalizedCFO,cashEconomicsTarget:margins.cashEconomicsTarget,profitabilityConsistencyApplied:margins.profitabilityConsistencyApplied,structuralCapitalLightCashConversion:margins.structuralCapitalLightCashConversion,recurringFcfCfoRatio:margins.recurringFcfCfoRatio,fcfCeiling:margins.fcfCeiling,crossMarginCoherenceApplied:margins.crossMarginCoherenceApplied,unexplainedFcfCompressionPrevented:margins.unexplainedFcfCompressionPrevented,broadCashCompressionEvidence:margins.broadCashCompressionEvidence,temporaryMarginReset:margins.temporaryMarginReset,
      normalizedTaxRate:margins.normalizedTaxRate,gaapNetStart:margins.gaapCurrentNet,gaapNetTarget:margins.gaapTargetNet,gaapNetMatureTarget:margins.gaapMatureTargetNet,
      earningsNormalizationAddbackStart:margins.currentNormalizationAddback,earningsNormalizationAddbackTarget:margins.targetNormalizationAddback,earningsNormalizationAddbackMature:margins.matureNormalizationAddback,
      grossMarginStart:margins.grossNow,grossMarginTarget:margins.grossTarget,grossMarginMatureTarget:margins.grossMature,
      rdMarginStart:margins.rdNow,rdMarginTarget:margins.rdTarget,rdMarginMatureTarget:margins.rdMature,
      sgaMarginStart:margins.sgaNow,sgaMarginTarget:margins.sgaTarget,sgaMarginMatureTarget:margins.sgaMature,
      sbcMarginStart:margins.sbcNowForEarnings,sbcMarginTarget:margins.sbcTarget,sbcMarginMatureTarget:margins.sbcMature,
      intangibleAmortizationStart:margins.amortNow,intangibleAmortizationTarget:margins.amortTarget,intangibleAmortizationMatureTarget:margins.amortMature,
      operatingDriverTarget:margins.driverTargetOperating,operatingDriverCoverage:margins.driverCoverage,operatingLeverageIntensity:margins.leverageIntensity},
    shares:{recent:recentShareGrowth,normalized:medianShareGrowth,observed:observedDilution,model:dilutionRate,mature:matureDilutionRate,path:dilutionPath,sbcNow,sbcNormalized,normalizedSbc,sbcImpliedDilution,buybackCapacity},
  };
  const forecastFlags=[];
  if(growth.structuralStepUp)forecastFlags.push('structural_revenue_step_up_detected');
  if(growth.structuralStepDown)forecastFlags.push('structural_revenue_step_down_detected');
  if(margins.abnormalCapexCycle)forecastFlags.push('abnormal_capex_cycle_normalized');
  if(margins.leverageSignal>.008)forecastFlags.push('evidence_supports_margin_expansion');
  if(margins.leverageSignal<-.008)forecastFlags.push('evidence_supports_margin_compression');
  if(margins.profitabilityConsistencyApplied)forecastFlags.push('growth_profitability_consistency_guardrail');
  if(margins.structuralCapitalLightCashConversion)forecastFlags.push('structural_capital_light_cash_conversion');
  if(margins.unexplainedFcfCompressionPrevented)forecastFlags.push('unexplained_fcf_compression_prevented');
  if(margins.temporaryMarginReset)forecastFlags.push('temporary_margin_reset_normalized');
  if((margins.driverCoverage||0)>=2)forecastFlags.push('spreadsheet_operating_driver_model');
  if((margins.currentNormalizationAddback||0)>.015)forecastFlags.push('normalized_earnings_bridge');
  if(growth.recentQuarter!=null&&Math.abs(growth.recentQuarter-growth.historicalAnchor)>.12)forecastFlags.push('recent_growth_inflection');

  return {horizonYears:HORIZON_YEARS,category,rows,terminalGrowth:growth.matureGrowth,year5OperatingGrowth:growth.year5Growth,revenueGrowthAnchor:growth.y1,sustainableGrowth,historicalGrowth:growth.historicalAnchor,dilutionRate,matureDilutionRate,dilutionPath,startRevenue:finite(last.revenue),startShares:inferredShares,shareCountSource:shareInfo.source,marginAssumptions:{fcf:margins.currentFCF,ebitda:margins.currentEBITDA,net:margins.currentNet},marginTargets:{fcf:margins.targetFCF,ebitda:margins.targetEBITDA,net:margins.targetNet,matureFCF:margins.matureTargetFCF,matureEBITDA:margins.matureTargetEBITDA,matureNet:margins.matureTargetNet},analystUsed:growth.analystUsed,forecastReliabilityScore:growth.forecastReliabilityScore,historyReliability:growth.historyReliability,reinvestmentPersistence:growth.reinvestmentPersistence,historyGrowthDispersion:growth.histDispersion,forecastBridge,forecastFlags};
}
module.exports={buildForecast};
