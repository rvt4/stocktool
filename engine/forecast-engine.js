'use strict';
const { HORIZON_YEARS, sectorConfig, clamp, rate, median, avg } = require('./config');

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
  const evidenceGrowth=weightedAverage([[Math.max(y2,-.05),.55],[historicalAnchor,.30],[matureGrowth,.15]])??matureGrowth;
  const maxYear5=Math.max(matureGrowth+.025, Math.min(.18, Math.max(y2,matureGrowth)*.90));
  const year5Growth=clamp(evidenceGrowth,matureGrowth,maxYear5);
  const growthPath=[y1,y2];
  for(let i=2;i<HORIZON_YEARS;i++){
    const t=(i-1)/(HORIZON_YEARS-2);
    const curved=t*t*(3-2*t);
    growthPath.push(clamp(y2*(1-curved)+year5Growth*curved,-.10,.28));
  }
  return {growthPath,y1,y2,matureGrowth,year5Growth,historicalAnchor,recentAnnual,recentQuarter,qualityHint,analystWeight,structuralStepUp,structuralStepDown,analystUsed:a1!=null||a2!=null};
}

function buildMarginForecast(stock,years,cfg,growthInfo){
  // CFO/capex and revenue margins are not economically comparable for banks, brokers,
  // insurers and other Financials. Do not publish fake FCF/EBITDA margin paths for them.
  if(stock.sector==='Financials') return {rawFCF:null,rawEBITDA:null,rawNet:null,currentFCF:null,currentEBITDA:null,currentNet:null,targetFCF:null,targetEBITDA:null,targetNet:null,leverageSignal:0,fcfTrend:null,opTrend:null,grossTrend:null,incrementalFCFMargin:null,incrementalOperatingMargin:null};
  // Normalize operating economics from several years of reported facts. SBC is NOT
  // subtracted from FCF here because dilution is modeled separately in the share-count
  // path; subtracting SBC and then also diluting the denominator double-counts the same
  // shareholder cost. We still keep SBC intensity in quality scoring.
  const fcfSeries=years.map(fcfMargin), ebitdaSeries=years.map(y=>pctMargin(y,'ebitda')), netSeries=years.map(y=>pctMargin(y,'netIncome'));
  const cfoSeries=years.map(y=>pctMargin(y,'cfo'));
  const capexSeries=years.map(y=>{const r=finite(y?.revenue),c=finite(y?.capex);return r>0&&c!=null?Math.abs(c)/r:null;});
  const opSeries=years.map(y=>Number.isFinite(finite(y?.opMargin))?finite(y.opMargin):pctMargin(y,'operatingIncome'));
  const grossSeries=years.map(y=>Number.isFinite(finite(y?.grossMargin))?finite(y.grossMargin):pctMargin(y,'grossProfit'));

  const rawCFO=medianRecent(cfoSeries), rawCapex=medianRecent(capexSeries);
  const directFCF=medianRecent(fcfSeries);
  const reconstructedFCF=Number.isFinite(rawCFO)&&Number.isFinite(rawCapex)?rawCFO-rawCapex:null;
  let rawFCF=weightedAverage([[directFCF,.70],[reconstructedFCF,.30]]);
  const rawEBITDA=medianRecent(ebitdaSeries)??null, rawNet=medianRecent(netSeries)??0.06, rawOp=medianRecent(opSeries)??rawEBITDA??rawNet;

  // If cash-flow facts are incomplete, do not invent a generic 5% FCF margin. A null
  // FCF path is preferable; EPS/EV-EBITDA (or the controlled sales fallback) can still
  // value the company. This removes a major source of false precision.
  if(!Number.isFinite(rawFCF)) rawFCF=null;
  const latestFCF=fcfSeries.filter(Number.isFinite).at(-1), latestEBITDA=ebitdaSeries.filter(Number.isFinite).at(-1), latestNet=netSeries.filter(Number.isFinite).at(-1);
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

  return {rawFCF,rawEBITDA,rawNet,currentFCF,currentEBITDA,currentNet,targetFCF,targetEBITDA,targetNet,leverageSignal,fcfTrend,opTrend,grossTrend,incrementalFCFMargin:incFCF,incrementalOperatingMargin:incOp};
}

function buildForecast(stock){
  const years=stock.financials?.years||[], last=years.at(-1)||{}, cfg=sectorConfig(stock.sector);
  const growth=buildGrowthForecast(stock,years,cfg);
  const margins=buildMarginForecast(stock,years,cfg,growth);

  const shareGrowth=yoySeries(years.slice(-5),'sharesOutTTM').filter(x=>x>-.25&&x<.30);
  const recentShareGrowth=shareGrowth.at(-1), medianShareGrowth=median(shareGrowth)??0;
  // Give recent buyback/SBC behavior more weight without extrapolating an extreme one-off.
  const dilutionRate=clamp(weightedAverage([[recentShareGrowth,.55],[medianShareGrowth,.45]])??0,-.05,.07);

  let revenue=finite(last.revenue)>0?finite(last.revenue):null, shares=finite(last.sharesOutTTM)>0?finite(last.sharesOutTTM):null, dividend=Math.max(0,finite(last.dividendPerShare)||0);
  const dividendGrowth=clamp(Math.min(Math.max(growth.y2,0),.07),0,.07), rows=[];
  for(let i=0;i<HORIZON_YEARS;i++){
    if(revenue!=null)revenue*=1+growth.growthPath[i]; if(shares!=null)shares*=1+dilutionRate; dividend*=1+dividendGrowth;
    const t=(i+1)/HORIZON_YEARS, curved=t*t*(3-2*t);
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
    margins:{fcfStart:margins.currentFCF,fcfNormalized:margins.rawFCF,fcfTarget:margins.targetFCF,ebitdaStart:margins.currentEBITDA,ebitdaNormalized:margins.rawEBITDA,ebitdaTarget:margins.targetEBITDA,netStart:margins.currentNet,netNormalized:margins.rawNet,netTarget:margins.targetNet,incrementalFCFMargin:margins.incrementalFCFMargin,incrementalOperatingMargin:margins.incrementalOperatingMargin,fcfTrend:margins.fcfTrend,operatingTrend:margins.opTrend,grossMarginTrend:margins.grossTrend,operatingLeverageAdjustment:margins.leverageSignal},
    shares:{recent:recentShareGrowth,normalized:medianShareGrowth,model:dilutionRate},
  };
  const forecastFlags=[];
  if(growth.structuralStepUp)forecastFlags.push('structural_revenue_step_up_detected');
  if(growth.structuralStepDown)forecastFlags.push('structural_revenue_step_down_detected');
  if(margins.leverageSignal>.008)forecastFlags.push('evidence_supports_margin_expansion');
  if(margins.leverageSignal<-.008)forecastFlags.push('evidence_supports_margin_compression');
  if(growth.recentQuarter!=null&&Math.abs(growth.recentQuarter-growth.historicalAnchor)>.12)forecastFlags.push('recent_growth_inflection');

  return {horizonYears:HORIZON_YEARS,category,rows,terminalGrowth:growth.matureGrowth,year5OperatingGrowth:growth.year5Growth,revenueGrowthAnchor:growth.y1,sustainableGrowth,historicalGrowth:growth.historicalAnchor,dilutionRate,startRevenue:finite(last.revenue),startShares:finite(last.sharesOutTTM),marginAssumptions:{fcf:margins.currentFCF,ebitda:margins.currentEBITDA,net:margins.currentNet},marginTargets:{fcf:margins.targetFCF,ebitda:margins.targetEBITDA,net:margins.targetNet},analystUsed:growth.analystUsed,forecastBridge,forecastFlags};
}
module.exports={buildForecast};
