'use strict';
const { HORIZON_YEARS, sectorConfig, clamp, rate, median } = require('./config');

function cagr(a,b,n){ if(!(a>0)||!(b>0)||!(n>0))return null; return Math.pow(b/a,1/n)-1; }
function yoySeries(years,field){const out=[];for(let i=1;i<years.length;i++){const a=Number(years[i-1]?.[field]),b=Number(years[i]?.[field]);if(a>0&&Number.isFinite(b))out.push(b/a-1);}return out;}
function normMargin(years,field,fallback=0){const v=years.slice(-4).map(y=>Number(y?.[field])).filter(Number.isFinite);if(!v.length)return fallback;return .65*v.at(-1)+.35*median(v);}
function safeAnalystGrowth(v){const x=rate(v); return Number.isFinite(x)&&x>-0.35&&x<0.80?x:null;}

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

function buildForecast(stock){
  const years=stock.financials?.years||[], last=years.at(-1)||{}, cfg=sectorConfig(stock.sector), a=stock.analystEstimates||{};
  const hist=yoySeries(years.slice(-5),'revenue').filter(x=>x>-0.5&&x<0.75);
  const histMed=median(hist), histCagr=years.length>=3?cagr(Number(years[Math.max(0,years.length-4)]?.revenue),Number(last.revenue),Math.min(3,years.length-1)):null;
  const historicalAnchor=clamp(median([histMed,histCagr].filter(Number.isFinite))??0.04,-0.08,0.25);
  const a1=safeAnalystGrowth(a.revenueGrowthCurrentYear??a.revenueGrowthFwd), a2=safeAnalystGrowth(a.revenueGrowthNextYear);
  // Consensus matters, but cannot completely overwhelm the company's demonstrated economics.
  const y1=clamp(a1!=null?.65*a1+.35*historicalAnchor:(rate(stock.growthYear1)??historicalAnchor),-0.15,0.35);
  const y2=clamp(a2!=null?.70*a2+.30*historicalAnchor:.65*y1+.35*historicalAnchor,-0.12,0.30);

  const roic=Number(last.roic), fcfM=Number(last.revenue)>0&&Number.isFinite(Number(last.fcfSBCAdjusted??last.fcf))?Number(last.fcfSBCAdjusted??last.fcf)/Number(last.revenue):null;
  const qualityHint=clamp((Number.isFinite(roic)?clamp(roic/.22,0,1):.45)*.55+(fcfM>0?.45:.15),0,1)||.5;
  // This is a year-5 operating growth destination, not a Gordon-growth assumption.
  const matureGrowth=clamp(cfg.terminalGrowth+(qualityHint-.5)*.008,.015,.045);
  const growthPath=[y1,y2];
  for(let i=2;i<HORIZON_YEARS;i++){const t=(i-1)/(HORIZON_YEARS-2);growthPath.push(clamp(y2*(1-t)+matureGrowth*t,-.08,.25));}

  const fcfMargins=years.map(y=>({m:Number(y.revenue)>0&&Number.isFinite(Number(y.fcfSBCAdjusted??y.fcf))?Number(y.fcfSBCAdjusted??y.fcf)/Number(y.revenue):null}));
  const ebitdaMargins=years.map(y=>({m:Number(y.revenue)>0&&Number.isFinite(Number(y.ebitda))?Number(y.ebitda)/Number(y.revenue):null}));
  const netMargins=years.map(y=>({m:Number(y.revenue)>0&&Number.isFinite(Number(y.netIncome))?Number(y.netIncome)/Number(y.revenue):null}));
  const rawFCF=normMargin(fcfMargins,'m',.05), rawEBITDA=normMargin(ebitdaMargins,'m',.10), rawNet=normMargin(netMargins,'m',.06);
  // Do not extrapolate margin trends forever. Fade only 25% of the gap toward a conservative sector ceiling/floor.
  const targetFCF=clamp(rawFCF,-.05,cfg.maxFCFMargin), targetEBITDA=clamp(rawEBITDA,-.03,Math.min(.55,cfg.maxFCFMargin+.16)), targetNet=clamp(rawNet,-.05,Math.min(.40,cfg.maxFCFMargin+.06));

  const shareGrowth=yoySeries(years.slice(-4),'sharesOutTTM').filter(x=>x>-.20&&x<.25);
  const dilutionRate=clamp(median(shareGrowth)??0,-.04,.06);
  let revenue=Number(last.revenue)>0?Number(last.revenue):null, shares=Number(last.sharesOutTTM)>0?Number(last.sharesOutTTM):null, dividend=Math.max(0,Number(last.dividendPerShare)||0);
  const dividendGrowth=clamp(Math.min(Math.max(y2,0),.06),0,.06), rows=[];
  for(let i=0;i<HORIZON_YEARS;i++){
    if(revenue!=null)revenue*=1+growthPath[i]; if(shares!=null)shares*=1+dilutionRate; dividend*=1+dividendGrowth;
    const t=(i+1)/HORIZON_YEARS;
    const fcfMargin=rawFCF+(targetFCF-rawFCF)*.25*t, ebitdaMargin=rawEBITDA+(targetEBITDA-rawEBITDA)*.25*t, netMargin=rawNet+(targetNet-rawNet)*.25*t;
    const fcf=revenue!=null?revenue*fcfMargin:null, ebitda=revenue!=null?revenue*ebitdaMargin:null, netIncome=revenue!=null?revenue*netMargin:null;
    rows.push({year:(Number(last.year)||new Date().getFullYear())+i+1,revenueGrowth:growthPath[i],revenue,fcfMargin,ebitdaMargin,netMargin,fcf,ebitda,netIncome,shares,eps:shares>0&&netIncome!=null?netIncome/shares:null,fcfPerShare:shares>0&&fcf!=null?fcf/shares:null,dividendPerShare:dividend});
  }
  const sustainableGrowth=median([y1,y2,historicalAnchor].filter(Number.isFinite))??y1;
  return {horizonYears:HORIZON_YEARS,category:classifyCategory(stock,sustainableGrowth,qualityHint,Number(stock.valuation?.dividendYield)||0),rows,terminalGrowth:matureGrowth,revenueGrowthAnchor:y1,sustainableGrowth,historicalGrowth:historicalAnchor,dilutionRate,startRevenue:Number(last.revenue)||null,startShares:Number(last.sharesOutTTM)||null,marginAssumptions:{fcf:rawFCF,ebitda:rawEBITDA,net:rawNet},analystUsed:a1!=null||a2!=null};
}
module.exports={buildForecast};
