'use strict';
const { HORIZON_YEARS, MARKET_RETURN, sectorConfig, clamp, median, rate } = require('./config');

function cagr(p,f){if(!(p>0)||!(f>0))return null;return Math.pow(f/p,1/HORIZON_YEARS)-1;}
function pv(v,r,n){return v/Math.pow(1+r,n);}
function finite(v){if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
const INVESTOR_HURDLE_RETURN=.15;
const INVESTOR_MARGIN_OF_SAFETY=.20;
function requiredReturn(){return INVESTOR_HURDLE_RETURN;}

// V12.6: intrinsic-value discounting is deliberately separate from the investor's
// hurdle return above. The DCF rate reflects business/forecast risk; it is not increased
// by 1-2 points merely because a company is labelled Growth/Hyper Growth. That avoids
// double-charging growth companies through both conservative terminal economics and a
// category premium in the discount rate.
function intrinsicDiscountRate(quality,forecast){
  const q=clamp((quality?.qualityScore??50)/100,0,1);
  const confidence=clamp((quality?.confidenceScore??50)/100,0,1);
  const moat=clamp((quality?.moatScore??50)/100,0,1);
  const forecastReliability=clamp((forecast?.forecastReliabilityScore??65)/100,0,1);
  let r=.0925;
  r+=(.65-confidence)*.012;
  r+=(.55-moat)*.005;
  r+=(.65-forecastReliability)*.008;
  r+=(.55-q)*.004;
  // Growth complexity can add a small uncertainty premium, but never the old automatic
  // +100/+200 bps hurdle-rate surcharge.
  if(forecast?.category==='Hyper Growth')r+=.0025;
  else if(forecast?.category==='Growth')r+=.0010;
  return clamp(r,.0825,.11);
}
function blend(items){const v=items.filter(x=>Number.isFinite(x.value)&&x.value>0&&x.weight>0);if(!v.length)return null;const w=v.reduce((s,x)=>s+x.weight,0);return v.reduce((s,x)=>s+x.value*x.weight,0)/w;}
function weightedAverage(items){const v=items.filter(x=>Number.isFinite(x.value)&&x.weight>0);if(!v.length)return null;const w=v.reduce((s,x)=>s+x.weight,0);return w>0?v.reduce((s,x)=>s+x.value*x.weight,0)/w:null;}
function recentMedian(values,n=4){return median(values.slice(-n).filter(x=>Number.isFinite(x)&&x>0));}
function safeMultiple(v,lo,hi){if(!(Number.isFinite(v)&&v>0))return null;return clamp(v,lo*.75,hi*1.50);}
function weightedMedian(items){
  const v=items.filter(x=>Number.isFinite(x.value)&&x.weight>0).sort((a,b)=>a.value-b.value);
  const total=v.reduce((s,x)=>s+x.weight,0); if(!total)return null;
  let acc=0; for(const x of v){acc+=x.weight;if(acc>=total/2)return x.value;} return v.at(-1)?.value??null;
}

function inferShareCount(stock,forecast,years){
  const last=years.at(-1)||{};
  const direct=[last.sharesOutTTM,last.weightedAverageDilutedShares,last.dilutedShares,last.sharesDiluted]
    .map(finite).filter(x=>x>0);
  if(direct.length)return {shares:direct[0],source:'reported'};
  const forecastShares=finite(forecast?.startShares);
  if(forecastShares>0)return {shares:forecastShares,source:forecast?.shareCountSource||'forecast_inferred'};
  const price=finite(stock?.price?.current), marketCap=finite(stock?.valuation?.marketCap);
  if(price>0&&marketCap>0)return {shares:marketCap/price,source:'market_cap_implied'};
  const implied=[];
  for(const y of years.slice(-5)){
    const ni=finite(y?.netIncome),eps=finite(y?.dilutedEPS ?? y?.epsDiluted ?? y?.eps);
    if(ni!=null&&eps!=null&&Math.abs(eps)>.0001&&ni*eps>0){const sh=ni/eps;if(Number.isFinite(sh)&&sh>1e5&&sh<1e12)implied.push(sh);}
  }
  const med=median(implied);
  return med>0?{shares:med,source:'earnings_per_share_implied'}:{shares:null,source:null};
}

function normalizeWithCaps(items,methodCap,familyCap){
  let rows=items.map(x=>({...x,w:Math.max(0,x.adjustedWeight||0)}));
  const normalize=()=>{const t=rows.reduce((s,x)=>s+x.w,0);if(t>0)for(const x of rows)x.w/=t;return t;};
  if(!(normalize()>0))return rows;
  // Iterative caps redistribute concentration rather than simply discarding weight.
  for(let pass=0;pass<8;pass++){
    let changed=false;
    let excess=0,open=[];
    for(const x of rows){if(x.w>methodCap){excess+=x.w-methodCap;x.w=methodCap;changed=true;}else open.push(x);}
    if(excess>1e-12&&open.length){const base=open.reduce((s,x)=>s+x.w,0)||open.length;for(const x of open)x.w+=excess*((base===open.length?1:x.w)/base);}
    normalize();
    const fams=new Map();for(const x of rows){const f=x.family||x.name;if(!fams.has(f))fams.set(f,[]);fams.get(f).push(x);}
    for(const [,group] of fams){const fw=group.reduce((s,x)=>s+x.w,0);if(fw<=familyCap+1e-12)continue;const cut=fw-familyCap;const scale=familyCap/fw;for(const x of group)x.w*=scale;const others=rows.filter(x=>!group.includes(x));const ow=others.reduce((s,x)=>s+x.w,0);if(others.length){for(const x of others)x.w+=cut*(ow>0?x.w/ow:1/others.length);}changed=true;}
    normalize();
    if(!changed)break;
  }
  return rows;
}

// Terminal multiples may normalize, but most of a ten-year return must come from the
// business rather than a heroic re-rating. The guardrail is generic and sector-aware.
function boundedExit(current,justified,lo,hi){
  // Intrinsic value must not be mechanically anchored to today's market multiple.
  // Current multiples remain audit context only. Terminal multiples are determined from
  // modeled mature economics, growth and quality; changing only today's stock price must
  // not change the modeled business value.
  return clamp(justified,lo,hi);
}

// V12.2: a company's own observed valuation history is a soft anchor when genuine
// historical multiples are available. Missing history gets zero weight; today's price is
// never substituted for history, preserving intrinsic-value price invariance.
function historicalMultipleAnchor(stock,kind){
  const h=stock?.historicalMultiples||{};
  const keys=kind==='EPS'?['forwardPe','pe']:kind==='EBITDA'?['evEbitda']:['pFcf','priceFcf','fcfMultiple'];
  const vals=[];
  for(const k of keys)for(const x of (Array.isArray(h[k])?h[k]:[])){const n=finite(x?.value??x);if(n>0)vals.push(n);}
  return vals.length>=2?{value:median(vals.slice(-12)),samples:vals.length}:{value:null,samples:vals.length};
}
function applyHistoricalMultipleAnchor(stock,kind,justified,lo,hi,quality){
  const hist=historicalMultipleAnchor(stock,kind);
  if(!(hist.value>0))return {multiple:clamp(justified,lo,hi),historicalAnchor:null,historicalSamples:hist.samples,historicalWeight:0};
  const w=clamp((hist.samples-1)/7,0,.55)*clamp((quality?.confidenceScore??50)/100,.35,.95);
  return {multiple:clamp(weightedAverage([[justified,1-w],[hist.value,w]]),lo,hi),historicalAnchor:hist.value,historicalSamples:hist.samples,historicalWeight:w};
}

// V11.5: company-specific terminal multiple framework. A decade-out multiple should not
// simply collapse every business to a sector-average 12-14x. Durable growth and superior
// economics can justify a lasting premium, while weak balance sheets, dilution and low
// quality pull the multiple back down. Importantly, this uses business evidence only --
// never the current share price or current trading multiple -- preserving price invariance.
function terminalMultipleProfile(stock,forecast,quality,base){
  const q=clamp((quality?.qualityScore??50)/100,0,1);
  const moat=clamp((quality?.moatScore??50)/100,0,1);
  const capital=clamp((quality?.capitalAllocationScore??50)/100,0,1);
  const compounder=clamp((quality?.compounderScore??50)/100,0,1);
  const pricing=clamp((quality?.pricingPowerScore??50)/100,0,1);
  const protection=clamp((quality?.protectionScore??50)/100,0,1);
  const growthQuality=clamp((quality?.growthQualityScore??50)/100,0,1);
  const confidence=clamp((quality?.confidenceScore??50)/100,0,1);
  const roic=finite(quality?.diagnostics?.roic);
  const dilution=Math.max(0,finite(forecast?.matureDilutionRate)??finite(forecast?.dilutionRate)??0);
  const growth=clamp(forecast?.year5OperatingGrowth??forecast?.rows?.at(-1)?.revenueGrowth??forecast?.sustainableGrowth??forecast?.revenueGrowthAnchor,0,.22);
  const matureGrowth=clamp(forecast?.rows?.at(-1)?.revenueGrowth??forecast?.terminalGrowth??growth,0,.12);
  // A year-10 exit multiple should primarily reflect the business that exists in year 10,
  // not the faster-growing company from years 1-5. Mature growth therefore carries most
  // of the weight, with only a modest premium for demonstrated durability earlier in the
  // forecast. This prevents a temporary growth regime from earning a permanent premium.
  // Natural maturation is not deterioration. A great reinvestment engine can still deserve
  // a premium after headline revenue growth slows, because value creation depends on the
  // returns earned on incremental capital, cash conversion and durability -- not year-10
  // revenue growth alone. Use mature growth as the anchor, then retain a measured premium
  // when quality + growth-quality evidence says the fade is scale-driven rather than decay.
  const reinvestmentQuality=clamp(.30*growthQuality+.22*compounder+.18*capital+.15*moat+.15*pricing,0,1);
  const durableGrowthCarry=clamp(Math.max(0,growth-matureGrowth)*Math.max(0,reinvestmentQuality-.45)*.70,0,.045);
  const growthDurability=clamp(.70*matureGrowth+.30*growth+durableGrowthCarry,0,.16);
  const maturityGap=Math.max(0,growth-matureGrowth);
  // Only penalize a fade when weak business evidence accompanies it. High-quality companies
  // are allowed to mature without being treated as if their economics deteriorated.
  const deteriorationRisk=clamp(1-(.30*q+.20*moat+.20*growthQuality+.15*compounder+.15*capital),0,1);
  const maturityPenalty=clamp(maturityGap*10*deteriorationRisk,0,1.25);
  // Value the company we are forecasting, not the company it is today. Terminal margins
  // are the primary economics for a terminal multiple; current/base margins are only a
  // fallback when the forecast cannot produce the relevant mature margin.
  const terminalRow=forecast?.rows?.at(-1)||{};
  const margin=Math.max(0,finite(terminalRow.fcfMargin)||0,finite(terminalRow.ebitdaMargin)||0,finite(terminalRow.netMargin)||0,finite(base?.margins?.fcf)||0,finite(base?.margins?.ebitda)||0,finite(base?.margins?.net)||0);

  // Quality is deliberately multi-dimensional. This prevents one high ROIC year or one
  // growth estimate from single-handedly granting an elite terminal multiple.
  const durableQuality=.22*q+.18*moat+.15*compounder+.13*pricing+.12*capital+.10*protection+.10*growthQuality;
  const qualityAdj=(durableQuality-.55)*10;
  const roicAdj=Number.isFinite(roic)?clamp((roic-.12)*18,-1.5,3.0):0;
  const marginAdj=clamp((margin-.12)*8,-1.0,2.0);
  const confidenceAdj=(confidence-.60)*2;
  const dilutionPenalty=clamp(dilution*35,0,2.5);
  // V12.14: premium terminal valuations require corroboration. A company does not earn an
  // elite decade-out multiple from growth alone; the premium must also be supported by a
  // broad quality/reinvestment profile. This keeps ordinary businesses out of the 20s while
  // preserving room for genuinely exceptional compounders whose growth naturally fades.
  const premiumEvidence=clamp(.55*durableQuality+.45*reinvestmentQuality,0,1);
  // Terminal durability is deliberately broader than premiumEvidence: it asks whether the
  // mature company should still deserve an above-market valuation after growth has faded.
  // Cash conversion, reinvestment quality, moat, capital allocation and forecast stability
  // all matter; no ticker/category override is used.
  const forecastStability=clamp((forecast?.forecastReliabilityScore??60)/100,0,1);
  const cashDurability=clamp((margin-.05)/.30,0,1);
  const terminalDurability=clamp(.24*durableQuality+.22*reinvestmentQuality+.16*moat+.12*capital+.12*cashDurability+.08*forecastStability+.06*protection,0,1);
  return {growth,matureGrowth,growthDurability,maturityGap,maturityPenalty,reinvestmentQuality,durableGrowthCarry,deteriorationRisk,durableQuality,premiumEvidence,terminalDurability,qualityAdj,roicAdj,marginAdj,confidenceAdj,dilutionPenalty};
}

function justifiedExitMultiple(kind,stock,forecast,quality,base,cfg){
  const p=terminalMultipleProfile(stock,forecast,quality,base);
  let multiple;
  if(kind==='FCF'){
    // FCF deserves the widest quality/growth differentiation because it is the cleanest
    // owner-economics anchor. ~10% durable growth with strong economics lands around the
    // mid/high teens; truly elite businesses can retain a low/mid-20s multiple.
    multiple=11.0+p.growthDurability*56+p.qualityAdj*1.15+p.roicAdj*1.05+p.marginAdj*1.10+p.confidenceAdj-p.dilutionPenalty-p.maturityPenalty*.75;
    // Low/mid-20s FCF exits are reserved for businesses with corroborated premium evidence.
    // The ceiling rises smoothly rather than switching on a category/ticker-specific rule.
    const evidenceCeiling=18.5+clamp((.55*p.premiumEvidence+.45*p.terminalDurability-.58)/.26,0,1)*15.5;
    multiple=Math.min(multiple,evidenceCeiling);
    { const a=applyHistoricalMultipleAnchor(stock,'FCF',multiple,8,34,quality); return {...a,profile:p}; }
  }
  if(kind==='EPS'){
    multiple=cfg.basePE+p.growthDurability*58+p.qualityAdj*1.08+p.roicAdj*.95+p.marginAdj*.55+p.confidenceAdj-p.dilutionPenalty-p.maturityPenalty*.80;
    const evidenceCeiling=19.5+clamp((.50*p.premiumEvidence+.50*p.terminalDurability-.56)/.28,0,1)*18.5;
    multiple=Math.min(multiple,evidenceCeiling);
    { const a=applyHistoricalMultipleAnchor(stock,'EPS',multiple,8,38,quality); return {...a,profile:p}; }
  }
  if(kind==='EBITDA'){
    multiple=cfg.baseEVEBITDA+p.growthDurability*31+p.qualityAdj*.68+p.roicAdj*.50+p.marginAdj*.38+p.confidenceAdj*.60-p.dilutionPenalty*.70-p.maturityPenalty*.65;
    const evidenceCeiling=14.0+clamp((.50*p.premiumEvidence+.50*p.terminalDurability-.56)/.28,0,1)*11.0;
    multiple=Math.min(multiple,evidenceCeiling);
    { const a=applyHistoricalMultipleAnchor(stock,'EBITDA',multiple,6,25,quality); return {...a,profile:p}; }
  }
  return {multiple:null,profile:p};
}

// V12.3: make exit methods different lenses on one mature business, not independent
// guesses. EPS is the cleanest common equity-value bridge; FCF and EV/EBITDA multiples are
// softly reconciled to the equity value implied by the same terminal EPS economics. Raw
// method-specific multiples still retain 45% weight so genuine cash-conversion differences
// are preserved rather than erased.
function coherentExitMultiples(stock,forecast,quality,base,cfg,netDebt,intrinsicRate){
  const f=forecast?.rows?.at(-1)||{};
  const epsExit=justifiedExitMultiple('EPS',stock,forecast,quality,base,cfg);
  const fcfExit=justifiedExitMultiple('FCF',stock,forecast,quality,base,cfg);
  const ebitdaExit=justifiedExitMultiple('EBITDA',stock,forecast,quality,base,cfg);
  const eps=finite(f.eps),fcfps=finite(f.fcfPerShare),shares=finite(f.shares),ebitda=finite(f.ebitda);
  const pe=finite(epsExit.multiple);
  const equityFromEPS=eps>0&&shares>0&&pe>0?eps*pe*shares:null;
  const coherentPFCF=equityFromEPS>0&&fcfps>0&&shares>0?equityFromEPS/(fcfps*shares):null;
  const coherentEVEBITDA=equityFromEPS>0&&ebitda>0?(equityFromEPS+(finite(netDebt)||0))/ebitda:null;
  // V12.7: exit multiples and DCF must describe the same mature economics. Gordon growth
  // implies a terminal P/FCF of (1+g)/(r-g). We do not force every method to equal DCF,
  // but a multiple far outside that economic neighborhood is no longer allowed to create
  // a contradictory terminal world. EPS/EBITDA retain wider bands for conversion differences.
  const r=finite(intrinsicRate);
  const g=clamp(finite(forecast?.terminalGrowth)??finite(cfg?.terminalGrowth)??.025,.005,r>.05?Math.min(.04,r-.045):.03);
  const gordonPFCF=r>g?(1+g)/(r-g):null;
  // DCF is an anchor, not a hard multiple cap. A hard Gordon band was circular: it could
  // force every exit method toward the DCF even when the forecast itself described a
  // materially better/worse business. Blend only a modest DCF-consistency reference and
  // never let it move a fundamentals-implied multiple by more than 12%.
  const dcfAnchor=(kind,multiple)=>{
    if(!(multiple>0&&gordonPFCF>0))return multiple;
    const scale=kind==='FCF'?1:(kind==='EPS'?1.18:.72);
    const ref=gordonPFCF*scale;
    const boundedRef=clamp(ref,multiple*.88,multiple*1.12);
    return .85*multiple+.15*boundedRef;
  };
  const reconcile=(kind,raw,coherent,lo,hi)=>{
    if(!(raw>0))return null;
    let x=raw;
    if(coherent>0){
      // When terminal cash flow and earnings describe the same owner economics, P/FCF
      // should not sit dramatically below the P/E lens simply because the standalone
      // FCF formula started from a conservative base. Let the common-equity bridge carry
      // materially more weight when cash conversion is close to earnings, while retaining
      // a smaller reconciliation weight when the two metrics genuinely diverge.
      let w=.34, lower=.78, upper=1.40;
      if(kind==='FCF'&&eps>0&&fcfps>0){
        const conversion=fcfps/eps;
        const alignment=clamp(1-Math.abs(Math.log(conversion))/Math.log(2),0,1);
        w=.34+.24*alignment;
        lower=.72; upper=1.65;
      }
      const boundedCoherent=clamp(coherent,raw*lower,raw*upper);
      x=(1-w)*raw+w*boundedCoherent;
    }
    x=dcfAnchor(kind,x);
    return clamp(x,lo,hi);
  };
  return {
    EPS:{...epsExit,multiple:clamp(dcfAnchor('EPS',pe),8,38),coherentReference:pe,gordonReference:gordonPFCF},
    FCF:{...fcfExit,multiple:reconcile('FCF',fcfExit.multiple,coherentPFCF,8,34),coherentReference:coherentPFCF,gordonReference:gordonPFCF},
    EBITDA:{...ebitdaExit,multiple:reconcile('EBITDA',ebitdaExit.multiple,coherentEVEBITDA,6,25),coherentReference:coherentEVEBITDA,gordonReference:gordonPFCF},
    equityFromEPS
  };
}

// V12.8: a 5Y checkpoint should be valued as the year-5 business, not by blindly
// reusing the year-10 mature multiple. This is especially important for companies whose
// growth is still elevated in year 5 (the exact CELH/ELF failure mode). The adjustment is
// generic and bounded: horizon growth can change the multiple, but cannot create a heroic
// re-rating by itself.
function horizonExitMultiple(kind,terminalMultiple,forecast,quality){
  if(!(terminalMultiple>0))return null;
  const rows=forecast?.rows||[], y5=rows[Math.min(4,rows.length-1)]||{}, y10=rows.at(-1)||{};
  const g5=clamp(finite(y5.revenueGrowth)??0,-.05,.30), g10=clamp(finite(y10.revenueGrowth)??finite(forecast?.terminalGrowth)??0,-.02,.12);
  const q=clamp((quality?.qualityScore??50)/100,0,1), moat=clamp((quality?.moatScore??50)/100,0,1), comp=clamp((quality?.compounderScore??50)/100,0,1);
  const durability=.45*q+.30*moat+.25*comp;
  const excessGrowth=Math.max(0,g5-g10);
  const weakGrowth=Math.max(0,g10-g5);
  const premium=excessGrowth*(kind==='EPS'?30:kind==='FCF'?25:18)*(.55+.45*durability);
  const penalty=weakGrowth*(kind==='EPS'?18:kind==='FCF'?16:12);
  const cap=kind==='EPS'?1.55:kind==='FCF'?1.50:1.40;
  return clamp(terminalMultiple+premium-penalty,terminalMultiple*.80,terminalMultiple*cap);
}

function transitionUncertainty(forecast,kind){
  const rows=forecast?.rows||[]; if(rows.length<6)return {factor:1,ratio:null};
  const y5=rows[Math.min(4,rows.length-1)]||{}, y10=rows.at(-1)||{};
  let a=null,b=null;
  if(kind==='FCF'){a=finite(y5.fcfPerShare);b=finite(y10.fcfPerShare);}
  else if(kind==='EPS'){a=finite(y5.eps);b=finite(y10.eps);}
  else if(kind==='EBITDA'){a=finite(y5.ebitda);b=finite(y10.ebitda);}
  if(!(a>0&&b>0))return {factor:1,ratio:null};
  const ratio=b/a;
  // Years 6-10 are a convergence band, not another high-confidence explicit forecast.
  // Penalize methods whose terminal value depends heavily on economics created after year 5.
  const factor=ratio>2.0?.72:ratio>1.65?.82:ratio>1.35?.91:1;
  return {factor,ratio};
}

function normalizedOperatingBase(stock,forecast){
  const years=stock.financials?.years||[], last=years.at(-1)||{};
  const revenue=finite(last.revenue), shares=finite(last.sharesOutTTM)>0?finite(last.sharesOutTTM):finite(forecast?.startShares);
  const bridge=forecast.forecastBridge?.margins||{};
  const fcfMargin=finite(bridge.fcfNormalized), ebitdaMargin=finite(bridge.ebitdaNormalized), netMargin=finite(bridge.netNormalized);
  const perShare=(margin)=>revenue>0&&shares>0&&Number.isFinite(margin)&&margin>0?revenue*margin/shares:null;
  return {revenue,shares,fcfPerShare:perShare(fcfMargin),eps:perShare(netMargin),ebitda:revenue>0&&Number.isFinite(ebitdaMargin)&&ebitdaMargin>0?revenue*ebitdaMargin:null,margins:{fcf:fcfMargin,ebitda:ebitdaMargin,net:netMargin}};
}

function normalizedFinancialEPS(years,last){
  const eps=[];
  for(const y of years.slice(-5)){
    const reported=finite(y?.dilutedEPS), ni=finite(y?.netIncome), sh=finite(y?.sharesOutTTM);
    const implied=ni!=null&&sh>0?ni/sh:null, v=reported>0?reported:(implied>0?implied:null);
    if(Number.isFinite(v)&&v>0)eps.push(v);
  }
  const normalized=recentMedian(eps,4), latestReported=finite(last?.dilutedEPS);
  const latest=latestReported>0?latestReported:(finite(last?.netIncome)>0&&finite(last?.sharesOutTTM)>0?finite(last.netIncome)/finite(last.sharesOutTTM):null);
  if(!(normalized>0))return latest>0?latest:null;
  return latest>0?(.70*normalized+.30*latest):normalized;
}

function marginSeries(years,field){
  return years.slice(-5).map(y=>{const r=finite(y?.revenue),n=finite(y?.[field]);return r>0&&n!=null?n/r:null;}).filter(Number.isFinite);
}
function dispersion(values){
  const v=values.filter(Number.isFinite); if(v.length<2)return .10;
  const m=median(v); if(!Number.isFinite(m))return .10;
  return median(v.map(x=>Math.abs(x-m)))??.10;
}

// V7: decide how much each method deserves to matter from the economics/data, not from
// the ticker. A method can still be shown while carrying little weight if the underlying
// metric is distorted or unusually unstable.
function methodReliability(stock,forecast,kind,base,future,quality){
  const years=stock.financials?.years||[], bridge=forecast.forecastBridge?.margins||{};
  const conf=clamp((quality?.confidenceScore??60)/100,.35,1);
  const fcfDisp=dispersion(marginSeries(years,'fcf'));
  const netDisp=dispersion(marginSeries(years,'netIncome'));
  const ebitdaDisp=dispersion(marginSeries(years,'ebitda'));
  const fcfM=finite(bridge.fcfNormalized), netM=finite(bridge.netNormalized), ebitdaM=finite(bridge.ebitdaNormalized);
  const dilution=Math.max(0,finite(forecast.dilutionRate)||0);
  const sbc=Math.max(0,finite(bridge.sbcMarginStart)||finite(years.at(-1)?.sbcIntensity)||0);
  const driverMode=bridge.operatingDriverReconciliation||'fallback';
  // V12.15: cyclical businesses get less confidence in point-in-time exit metrics. This
  // does not change the base CAGR; it changes how much we trust a terminal multiple built
  // from a commodity/cycle-sensitive earnings snapshot.
  const sector=String(stock?.sector||'');
  const revenueGrowth=[];
  for(let i=1;i<years.length;i++){const a=finite(years[i-1]?.revenue),b=finite(years[i]?.revenue);if(a>0&&b>0)revenueGrowth.push(b/a-1);}
  const growthDispersion=dispersion(revenueGrowth.slice(-6));
  const cyclicalSector=/Energy|Materials/i.test(sector);
  const cyclicalEvidence=cyclicalSector||growthDispersion>.16;
  let reliability=.75*conf, reasons=[];
  if(cyclicalEvidence){
    const cyclePenalty=cyclicalSector?clamp(1-growthDispersion/.55,.62,.88):clamp(1-growthDispersion/.70,.72,.92);
    reliability*=cyclePenalty; reasons.push('cyclical_economics_normalized');
  }

  if(kind==='FCF'){
    reliability*=clamp(1-fcfDisp/.12,.45,1);
    if(bridge.abnormalCapexCycle){reliability*=.88;reasons.push('capex_cycle_normalized');}
    if(Number.isFinite(fcfM)&&fcfM>0)reliability*=1.05;
    if(sbc>.08){reliability*=clamp(1-(sbc-.08)*1.8,.62,.95);reasons.push('high_sbc_owner_cost');}
    if(driverMode==='fallback'){reliability*=.92;reasons.push('operating_bridge_fallback');}
  } else if(kind==='EPS'){
    reliability*=clamp(1-netDisp/.10,.40,1);
    // If cash economics are much stronger than reported earnings economics, GAAP EPS is
    // likely a noisier valuation anchor (amortization, acquisition accounting, tax mix,
    // investment-cycle effects, etc.). Do not delete EPS; reduce its influence.
    if(Number.isFinite(fcfM)&&fcfM>.04&&Number.isFinite(netM)&&netM>=0){
      const gap=fcfM-netM;
      if(gap>.10){reliability*=.45;reasons.push('cash_earnings_divergence');}
      else if(gap>.06){reliability*=.65;reasons.push('cash_earnings_divergence');}
    }
    if(dilution>.03){reliability*=.90;reasons.push('elevated_dilution');}
    if(sbc>.08){reliability*=clamp(1-(sbc-.08)*1.2,.72,.96);reasons.push('high_sbc_normalization_risk');}
    if(driverMode==='full')reliability*=1.05;
  } else if(kind==='EBITDA'){
    reliability*=clamp(1-ebitdaDisp/.12,.45,1);
    const debt=finite(years.at(-1)?.totalDebt)||finite(years.at(-1)?.longTermDebt)||0;
    const cash=finite(years.at(-1)?.cash)||0;
    const ebitda=finite(base?.ebitda);
    const leverage=ebitda>0?(debt-cash)/ebitda:null;
    if(Number.isFinite(leverage)&&leverage>3){reliability*=.65;reasons.push('high_leverage');}
    if(driverMode==='full')reliability*=1.08;
    else if(driverMode==='fallback'){reliability*=.82;reasons.push('operating_bridge_fallback');}
  } else if(kind==='SALES'){
    reliability*=.55;
    if(Number.isFinite(ebitdaM)&&ebitdaM>.08)reliability*=.85;
    reasons.push('profitability_fallback');
  } else if(kind==='FINANCIAL_EPS'){
    reliability*=.90;
  }

  const b=finite(base), f=finite(future);
  if(b>0&&f>0){
    const metricGrowth=Math.pow(f/b,1/HORIZON_YEARS)-1;
    if(metricGrowth>.35||metricGrowth<-.20){reliability*=.65;reasons.push('metric_growth_extreme');}
  }
  const transition=transitionUncertainty(forecast,kind);
  if(transition.factor<1){reliability*=transition.factor;reasons.push('years_6_10_transition_dependence');}
  return {score:clamp(reliability,.12,1),reasons,transitionRatio:transition.ratio};
}

// V12.4: choose valuation lenses from the economics of the business before blending.
// A mathematically available method is not automatically decision-useful. This keeps a
// distorted cash-flow lens from receiving a token vote against a much cleaner earnings
// lens (and vice versa), while remaining completely ticker-agnostic.
function valuationArchetype(stock,forecast,quality,base){
  const dq=stock.financials?.dataQuality||{};
  if(dq.financialLikeRevenue===true)return {name:'financial-earnings',weights:{FINANCIAL_EPS:1},minimum:{FINANCIAL_EPS:.28}};
  const category=forecast.category||'Value';
  const growth=clamp(forecast.year5OperatingGrowth??forecast.rows?.at(-1)?.revenueGrowth??forecast.sustainableGrowth??0,0,.30);
  const q=clamp((quality?.qualityScore??50)/100,0,1);
  const compounder=clamp((quality?.compounderScore??50)/100,0,1);
  const fcf=finite(base?.margins?.fcf), net=finite(base?.margins?.net), ebitda=finite(base?.margins?.ebitda);
  const assetLight=(fcf??0)>.10&&(ebitda??0)>.14;
  const cashEarningsGap=Number.isFinite(fcf)&&Number.isFinite(net)?Math.abs(fcf-net):0;
  const highQuality=q>=.72||compounder>=.75;
  if(cashEarningsGap>.09){
    // When accounting earnings and cash conversion diverge materially, admit only lenses
    // that clear a higher evidence bar rather than forcing both into the answer.
    return {name:'cash-conversion-divergence',weights:{FCF:.42,DCF:.34,EPS:.18,EBITDA:.06},minimum:{FCF:.48,DCF:.45,EPS:.50,EBITDA:.52}};
  }
  if((category==='Hyper Growth'||growth>=.16)&&assetLight){
    return {name:'growth-normalized-earnings',weights:{EPS:.46,FCF:.24,DCF:.20,EBITDA:.10},minimum:{EPS:.28,FCF:.42,DCF:.38,EBITDA:.45}};
  }
  if((category==='Compounder'||highQuality)&&assetLight){
    return {name:'asset-light-compounder',weights:{EPS:.38,FCF:.30,DCF:.24,EBITDA:.08},minimum:{EPS:.30,FCF:.38,DCF:.38,EBITDA:.48}};
  }
  const capitalIntensive=(ebitda??0)>.08&&(fcf??0)<.08;
  if(capitalIntensive)return {name:'capital-intensive',weights:{DCF:.40,EBITDA:.35,FCF:.20,EPS:.05},minimum:{DCF:.38,EBITDA:.38,FCF:.45,EPS:.55}};
  return {name:'balanced-operating-business',weights:{DCF:.34,FCF:.30,EPS:.26,EBITDA:.10},minimum:{DCF:.34,FCF:.34,EPS:.34,EBITDA:.42}};
}

function archetypeMethodWeight(archetype,kind,reliability){
  const w=archetype?.weights?.[kind]??0;
  const floor=archetype?.minimum?.[kind]??.35;
  if(!(w>0)||!(reliability>0))return 0;
  // V12.5: reliability should change how much a valid lens matters, not usually delete it.
  // V12.4's hard floors often collapsed otherwise modelable companies to one method,
  // making the answer both less robust and excessively dependent on a single conservative
  // lens. Keep truly weak methods out, but taper borderline methods smoothly.
  if(reliability<.18)return 0;
  const support=clamp(reliability/Math.max(floor,.18),.35,1);
  return w*support;
}

function addMethod(methods,{name,target,weight,reliability=1,audit,price,family=null,cashFlowInclusive=false}){
  if(!(Number.isFinite(target)&&target>0&&Number.isFinite(price)&&price>0))return;
  const implied=cagr(price,target);
  if(!Number.isFinite(implied))return;
  const rel=clamp(reliability,.05,1);
  const effectiveWeight=weight*rel;
  methods.push({name,target,weight:effectiveWeight,baseWeight:weight,reliability:rel,family:family||name,cashFlowInclusive,audit:{...audit,impliedCAGR:implied,effectiveWeight}});
}

function valuationConsensus(methods,price){
  // Consensus is measured in intrinsic-outcome space, not return-from-current-price space.
  // That keeps the canonical fair value independent of today's quote.
  const valid=methods.map((m,index)=>({m,index,x:Number.isFinite(m.outcome)&&m.outcome>0?Math.log(m.outcome):null})).filter(v=>Number.isFinite(v.x)&&v.m.weight>0);
  if(valid.length<3)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:null,outlierGap:null,hasConsensusOutlier:false};
  let best=null;
  for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
    const gap=Math.abs(valid[i].x-valid[j].x);
    if(!best||gap<best.gap)best={a:valid[i],b:valid[j],gap};
  }
  if(!best)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:null,outlierGap:null,hasConsensusOutlier:false};
  const center=(best.a.x+best.b.x)/2;
  const outsiders=valid.filter(x=>x.index!==best.a.index&&x.index!==best.b.index);
  const nearestOutlierGap=outsiders.length?Math.min(...outsiders.map(x=>Math.abs(x.x-center))):null;
  const separated=best.gap<=Math.log(1.22)&&Number.isFinite(nearestOutlierGap)&&nearestOutlierGap>=Math.max(Math.log(1.35),best.gap*2.25);
  if(!separated)return {clusterIndexes:valid.map(x=>x.index),outlierIndexes:[],pairSpread:best.gap,outlierGap:nearestOutlierGap,hasConsensusOutlier:false};
  return {clusterIndexes:[best.a.index,best.b.index],outlierIndexes:outsiders.map(x=>x.index),pairSpread:best.gap,outlierGap:nearestOutlierGap,hasConsensusOutlier:true};
}

function robustOutcomeBlend(methods,price,consensus=null){
  const valid=methods.map((m,index)=>({...m,index})).filter(m=>Number.isFinite(m.outcome)&&m.outcome>0&&m.weight>0);
  if(!valid.length)return {outcome:null,weights:{}};
  if(valid.length===1)return {outcome:valid[0].outcome,weights:{[valid[0].name]:1}};
  const info=consensus||valuationConsensus(methods,price), outliers=new Set(info.outlierIndexes||[]);
  // Base weights should express method usefulness, not permit a 40% DCF prior to become
  // 70-80% of the answer after disagreement. Square-root the prior and let reliability +
  // agreement do most of the work.
  const items=valid.map(m=>({value:Math.log(m.outcome),weight:Math.sqrt(Math.max(.001,m.baseWeight||m.weight))*Math.pow(clamp(m.reliability??1,.05,1),1.25),index:m.index,name:m.name,outcome:m.outcome,family:m.family||m.name}));
  const center=weightedMedian(items.map(x=>({value:x.value,weight:x.weight*(outliers.has(x.index)?.10:1)})));
  const adjusted=items.map(x=>{
    const gap=Math.abs(x.value-center);
    let consensusWeight=gap<=Math.log(1.15)?1:gap<=Math.log(1.30)?.78:gap<=Math.log(1.60)?.48:.20;
    if(info.hasConsensusOutlier&&outliers.has(x.index))consensusWeight=Math.min(consensusWeight,.12);
    return {...x,adjustedWeight:x.weight*consensusWeight};
  });
  const methodCap=valid.length>=3?.45:.62;
  const familyCap=valid.length>=3?.58:.72;
  const capped=normalizeWithCaps(adjusted,methodCap,familyCap);
  const totalW=capped.reduce((s,x)=>s+x.w,0);
  if(!(totalW>0))return {outcome:null,weights:{}};
  const outcome=capped.reduce((s,x)=>s+x.outcome*x.w,0)/totalW;
  return {outcome,weights:Object.fromEntries(capped.map(x=>[x.name,x.w/totalW]))};
}

function dcfFairValue(forecast,discountRate,currentShares,cfg){
  const rows=forecast.rows||[];
  if(rows.length!==HORIZON_YEARS||!(discountRate>0)||!(currentShares>0))return null;

  // V11.4: value aggregate owner cash flow, then divide by TODAY'S ownership base.
  // Discounting forecast FCF/share while the forecast also shrinks the share count counts
  // buyback-funded FCF twice: once as cash flow and again through a smaller denominator.
  // Aggregate FCF is invariant to whether excess cash is retained, paid as dividends, or
  // used for repurchases, which is the correct starting point for an intrinsic DCF.
  const cashflows=rows.map(r=>{
    const fcfps=finite(r.fcfPerShare), shares=finite(r.shares);
    return fcfps>0&&shares>0?fcfps*shares:null;
  });
  if(cashflows.filter(x=>Number.isFinite(x)&&x>0).length<Math.max(6,HORIZON_YEARS-2))return null;
  let explicitTotal=0;
  for(let i=0;i<cashflows.length;i++){
    if(!(cashflows[i]>0))return null;
    explicitTotal+=pv(cashflows[i],discountRate,i+1);
  }

  // Mature perpetual growth remains bounded, but V12.6 no longer silently forces every
  // sector to <=2.5%. Use the sector's mature-growth ceiling (max 4%) while preserving a
  // healthy spread to the intrinsic discount rate.
  const sectorCeiling=clamp(finite(cfg?.terminalGrowth)??.025,.02,.04);
  const g=clamp(finite(forecast.terminalGrowth)??.02,.005,Math.min(sectorCeiling,discountRate-.045));
  if(!(discountRate>g))return null;
  const terminalTotal=cashflows.at(-1)*(1+g)/(discountRate-g);
  const pvTerminalTotal=pv(terminalTotal,discountRate,HORIZON_YEARS);
  const explicit=explicitTotal/currentShares, pvTerminal=pvTerminalTotal/currentShares;
  const fair=explicit+pvTerminal;
  return fair>0?{fairValue:fair,pvExplicit:explicit,pvTerminal,terminalGrowth:g,terminalShare:pvTerminal/fair,discountRate}:null;
}

// V12.7: value the business at the end of year 5 as well as year 10. The 5Y view is
// not a second return engine: it uses the same forecast, same method reliability, same
// intrinsic discount rate and same terminal economics. It simply asks what the modeled
// business should be worth halfway through the underwriting horizon.
function dcfValueAtYear5(forecast,discountRate,currentShares,cfg){
  const rows=forecast?.rows||[], start=5;
  if(rows.length!==HORIZON_YEARS||!(discountRate>0)||!(currentShares>0))return null;
  const cashflows=rows.map(r=>{const ps=finite(r.fcfPerShare),sh=finite(r.shares);return ps>0&&sh>0?ps*sh:null;});
  if(cashflows.slice(start).some(x=>!(x>0)))return null;
  const sectorCeiling=clamp(finite(cfg?.terminalGrowth)??.025,.02,.04);
  const g=clamp(finite(forecast.terminalGrowth)??.02,.005,Math.min(sectorCeiling,discountRate-.045));
  if(!(discountRate>g))return null;
  let value=0;
  for(let i=start;i<cashflows.length;i++)value+=cashflows[i]/Math.pow(1+discountRate,i-start+1);
  const terminal=cashflows.at(-1)*(1+g)/(discountRate-g);
  value+=terminal/Math.pow(1+discountRate,HORIZON_YEARS-start);
  return value/currentShares;
}

function valuate(stock,forecast,quality){
  const rows=forecast.rows||[], f=rows.at(-1)||{}, years=stock.financials?.years||[], last=years.at(-1)||{};
  const price=finite(stock.price?.current), cfg=sectorConfig(stock.sector), req=requiredReturn(quality,forecast.category), intrinsicRate=intrinsicDiscountRate(quality,forecast);
  const shareInfo=inferShareCount(stock,forecast,years);
  const reportedShares0=shareInfo.source==='reported'?shareInfo.shares:null;
  const inferredShares0=shareInfo.shares;
  const shares0=inferredShares0, netDebt=(finite(last.totalDebt)||finite(last.longTermDebt)||0)-(finite(last.cash)||0);
  const marketCap=price>0&&shares0>0?price*shares0:null, revenue0=finite(last.revenue)>0?finite(last.revenue):null;
  const q=(quality.qualityScore||50)/100, growth=clamp(forecast.year5OperatingGrowth??forecast.rows?.at(-1)?.revenueGrowth??forecast.sustainableGrowth??forecast.revenueGrowthAnchor,0,.18);
  const methods=[], base=normalizedOperatingBase(stock,forecast);
  const archetype=valuationArchetype(stock,forecast,quality,base);
  const dataQuality=stock.financials?.dataQuality||{};
  const shareDenominatorReliable=dataQuality.shareDenominatorReliable !== false;
  // A missing SEC share denominator should not make a profitable company permanently
  // unrateable when market cap / price supplies a coherent per-share denominator. This
  // remains lower-confidence than a reported diluted share count and is surfaced below.
  const shareCountFallbackUsed=!reportedShares0&&inferredShares0>0;
  const shareDenominatorUsable=shareDenominatorReliable||shareCountFallbackUsed;
  const financialLike=dataQuality.financialLikeRevenue===true;
  const materialNCI=dataQuality.materialNoncontrollingInterest===true;

  if(!shareDenominatorUsable){
    // Fail closed. A corrupted share denominator can turn an ordinary enterprise value
    // into a triple-digit per-share CAGR. Do not value until the denominator is reconciled.
  } else if(financialLike){
    const epsBase=normalizedFinancialEPS(years,last), currentPE=safeMultiple(price>0&&epsBase>0?price/epsBase:null,6,28);
    if(epsBase>0){
      const buybackTailwind=clamp(-(forecast.dilutionRate||0),-.03,.04);
      const a=stock.analystEstimates||{};
      const analystEPS1=rate(a.epsGrowthCurrentYear??a.epsGrowthFwd);
      const analystEPS2=rate(a.epsGrowthNextYear);
      const analystRevenue=forecast.forecastBridge?.revenue?.analystNext??forecast.forecastBridge?.revenue?.analystCurrent??growth;
      // V11.16: growth financials are earnings businesses, not revenue-multiple businesses.
      // Use explicit analyst EPS growth when available for the near term, then fade toward a
      // quality- and revenue-supported mature earnings rate. The old implementation used
      // analyst *revenue* growth as the EPS proxy and a single constant CAGR, which erased
      // operating leverage in fast-scaling lenders/fintechs and understated their earnings
      // power even when consensus expected EPS to grow much faster than revenue.
      const growthFinancial=forecast.category==='Growth'||forecast.category==='Hyper Growth';
      const near1=clamp(Number.isFinite(analystEPS1)?analystEPS1:analystRevenue,-.10,growthFinancial?.40:.24);
      const near2=clamp(Number.isFinite(analystEPS2)?analystEPS2:(Number.isFinite(near1)?near1*.85:analystRevenue),-.08,growthFinancial?.34:.22);
      const qualityGrowth=((quality?.growthQualityScore??50)/100);
      const compounder=((quality?.compounderScore??50)/100);
      const terminalRevenue=clamp(forecast.terminalGrowth??growth,.01,.12);
      const matureEpsGrowth=clamp(terminalRevenue+Math.max(0,qualityGrowth-.55)*.055+Math.max(0,compounder-.55)*.035+buybackTailwind*.55,.02,growthFinancial?.12:.08);
      const year3=clamp(.60*near2+.40*Math.max(matureEpsGrowth,analystRevenue??matureEpsGrowth),-.06,growthFinancial?.28:.18);
      const year4=clamp(.62*year3+.38*matureEpsGrowth,-.04,growthFinancial?.23:.16);
      const year5=clamp(.58*year4+.42*matureEpsGrowth,-.03,growthFinancial?.19:.13);
      const epsPath=[near1,near2,year3,year4,year5];
      while(epsPath.length<HORIZON_YEARS){
        const prev=epsPath.at(-1);
        const t=(epsPath.length-4)/(HORIZON_YEARS-5);
        epsPath.push(clamp(prev+(matureEpsGrowth-prev)*clamp(t,0,1),-.03,growthFinancial?.18:.12));
      }
      let futureEPS=epsBase;
      for(const g of epsPath) futureEPS*=1+g;
      const epsGrowth=Math.pow(futureEPS/epsBase,1/HORIZON_YEARS)-1;
      const stableG=clamp(forecast.terminalGrowth,.01,Math.min(.045,req-.03));
      const stableROE=clamp(.105+.13*q+.04*Math.max(0,qualityGrowth-.60),.10,.26);
      const payout=clamp(1-stableG/stableROE,.30,.85);
      const fundamentalPE=payout*(1+stableG)/Math.max(.035,req-stableG);
      const qualityPremium=(q-.5)*7+(qualityGrowth-.5)*6+(((quality?.moatScore??50)/100)-.5)*4+(compounder-.5)*4;
      const growthPremium=Math.max(0,matureEpsGrowth-.035)*(growthFinancial?46:18);
      const justified=.45*fundamentalPE+.55*(cfg.basePE+growthPremium+qualityPremium);
      const m=boundedExit(currentPE,justified,7,growthFinancial?36:22);
      const rel=methodReliability(stock,forecast,'FINANCIAL_EPS',epsBase,futureEPS,quality);
      addMethod(methods,{name:'Normalized EPS exit',target:futureEPS*m,weight:1,reliability:rel.score,price,family:'earnings',audit:{exitMultiple:m,currentMultiple:currentPE,metric:futureEPS,normalizedEPSBase:epsBase,epsGrowth,epsGrowthPath:epsPath,matureEpsGrowth,reliabilityReasons:rel.reasons}});
    }
  } else {
    const normFCF=base.fcfPerShare, normEPS=base.eps, normEBITDA=base.ebitda;
    // When a material slice of consolidated economics belongs to non-controlling owners,
    // consolidated FCF/EBITDA is not on the same ownership scope as the listed share
    // denominator. Keep parent EPS usable, but suppress whole-enterprise cash-flow methods.
    const allowEnterpriseScopeMethods=!materialNCI;
    const currentPFCF=safeMultiple(price>0&&normFCF>0?price/normFCF:null,6,35);
    const currentPE=safeMultiple(price>0&&normEPS>0?price/normEPS:null,6,38);
    const currentEVEBITDA=safeMultiple(marketCap>0&&normEBITDA>0?(marketCap+netDebt)/normEBITDA:null,4,24);
    const coherentExits=coherentExitMultiples(stock,forecast,quality,base,cfg,netDebt,intrinsicRate);

    if(allowEnterpriseScopeMethods&&Number(f.fcfPerShare)>0&&normFCF>0){
      const exit=coherentExits.FCF, m=boundedExit(currentPFCF,exit.multiple,8,34);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // V11.4: an exit-multiple method values the business at the exit date. Do not also
      // add every interim dollar of FCF here. The forecast share path already reflects
      // repurchases/capital allocation, so adding explicit FCF on top was systematically
      // double-counting owner cash and made FCF-exit values track the (also inflated) DCF.
      // Dividends are added later because this is now an exit-only method.
      const terminalFCFValue=f.fcfPerShare*m;
      { const w=archetypeMethodWeight(archetype,'FCF',rel.score); if(w>0)addMethod(methods,{name:'FCF exit',target:terminalFCFValue,weight:w,reliability:rel.score,price,family:'cashflow',cashFlowInclusive:false,audit:{exitMultiple:m,currentMultiple:currentPFCF,metric:f.fcfPerShare,normalizedCurrentMetric:normFCF,terminalExitValue:terminalFCFValue,multipleProfile:exit.profile,historicalMultipleAnchor:exit.historicalAnchor,historicalMultipleSamples:exit.historicalSamples,historicalMultipleWeight:exit.historicalWeight,coherentMultipleReference:exit.coherentReference,gordonMultipleReference:exit.gordonReference,reliabilityReasons:rel.reasons,transitionRatio:rel.transitionRatio}}); }
    }
    if(Number(f.eps)>0&&normEPS>0){
      const exit=coherentExits.EPS, m=boundedExit(currentPE,exit.multiple,8,38);
      const rel=methodReliability(stock,forecast,'EPS',normEPS,f.eps,quality);
      { const w=archetypeMethodWeight(archetype,'EPS',rel.score); if(w>0)addMethod(methods,{name:'EPS exit',target:f.eps*m,weight:w,reliability:rel.score,price,family:'earnings',audit:{exitMultiple:m,currentMultiple:currentPE,metric:f.eps,normalizedCurrentMetric:normEPS,multipleProfile:exit.profile,historicalMultipleAnchor:exit.historicalAnchor,historicalMultipleSamples:exit.historicalSamples,historicalMultipleWeight:exit.historicalWeight,coherentMultipleReference:exit.coherentReference,gordonMultipleReference:exit.gordonReference,reliabilityReasons:rel.reasons,transitionRatio:rel.transitionRatio}}); }
    }
    if(allowEnterpriseScopeMethods&&Number(f.ebitda)>0&&Number(f.shares)>0&&normEBITDA>0){
      const exit=coherentExits.EBITDA, m=boundedExit(currentEVEBITDA,exit.multiple,6,25), equity=f.ebitda*m-netDebt;
      if(equity>0){
        const rel=methodReliability(stock,forecast,'EBITDA',normEBITDA,f.ebitda,quality);
        { const w=archetypeMethodWeight(archetype,'EBITDA',rel.score); if(w>0)addMethod(methods,{name:'EV/EBITDA exit',target:equity/f.shares,weight:w,reliability:rel.score,price,family:'enterprise',audit:{exitMultiple:m,currentMultiple:currentEVEBITDA,metric:f.ebitda,normalizedCurrentMetric:normEBITDA,multipleProfile:exit.profile,historicalMultipleAnchor:exit.historicalAnchor,historicalMultipleSamples:exit.historicalSamples,historicalMultipleWeight:exit.historicalWeight,coherentMultipleReference:exit.coherentReference,gordonMultipleReference:exit.gordonReference,reliabilityReasons:rel.reasons,transitionRatio:rel.transitionRatio}}); }
      }
    }

    const dcf=allowEnterpriseScopeMethods?dcfFairValue(forecast,intrinsicRate,shares0,cfg):null;
    if(dcf){
      const terminalOutcome=dcf.fairValue*Math.pow(1+intrinsicRate,HORIZON_YEARS);
      const rel=methodReliability(stock,forecast,'FCF',normFCF,f.fcfPerShare,quality);
      // Terminal-value-heavy DCFs are still useful, but receive less reliability when
      // most of the present value depends on the perpetuity rather than explicit cash flow.
      const terminalPenalty=dcf.terminalShare>.75?.55:(dcf.terminalShare>.65?.72:(dcf.terminalShare>.55?.88:1));
      { const dcfRel=rel.score*terminalPenalty, w=archetypeMethodWeight(archetype,'DCF',dcfRel); if(w>0)addMethod(methods,{name:'10Y DCF',target:terminalOutcome,weight:w,reliability:dcfRel,price,family:'cashflow',cashFlowInclusive:true,audit:{fairValueToday:dcf.fairValue,year5Value:dcfValueAtYear5(forecast,intrinsicRate,shares0,cfg),pvExplicit:dcf.pvExplicit,pvTerminal:dcf.pvTerminal,discountRate:dcf.discountRate,terminalGrowth:dcf.terminalGrowth,terminalShare:dcf.terminalShare,reliabilityReasons:[...rel.reasons,...(terminalPenalty<1?['terminal_value_concentration']:[])]}}); }
    }

    if(!methods.length&&allowEnterpriseScopeMethods&&Number(f.revenue)>0&&Number(f.shares)>0&&revenue0>0){
      const currentEVSales=marketCap>0?safeMultiple((marketCap+netDebt)/revenue0,.25,12):null;
      // Trust-first fallback: never invent a 4% profitability floor. Revenue multiples are
      // only defensible when the company has observable positive normalized economics.
      // If profitability is absent/negative, publish no valuation rather than manufacture
      // a huge fair value from sales alone.
      const observedMargins=[base.margins?.fcf,base.margins?.ebitda,base.margins?.net].filter(x=>Number.isFinite(x)&&x>0);
      const observedMargin=observedMargins.length?Math.max(...observedMargins):null;
      const growthEligible=(forecast.category==='Growth'||forecast.category==='Hyper Growth')&&growth>=.10;
      if(observedMargin>=.02&&growthEligible){
        const economicsMultiple=cfg.baseEVEBITDA*clamp(observedMargin,.02,.35);
        const growthPremium=clamp(growth-.08,0,.15)*6, qualityPremium=(q-.5)*.75;
        const justified=clamp(economicsMultiple+growthPremium+qualityPremium,.25,5), m=boundedExit(currentEVSales,justified,.25,5), equity=Number(f.revenue)*m-netDebt;
        if(equity>0){
          const rel=methodReliability(stock,forecast,'SALES',revenue0,f.revenue,quality);
          addMethod(methods,{name:'EV/Sales fallback',target:equity/Number(f.shares),weight:1,reliability:rel.score*.75,price,family:'sales',audit:{exitMultiple:m,currentMultiple:currentEVSales,metric:f.revenue,observedMargin,reason:'profitability_methods_unavailable_but_positive_economics_observed',reliabilityReasons:rel.reasons}});
        }
      }
    }
  }

  // Cash-flow methods already include cash available to owners, so adding dividends to
  // them again double-counts the same cash. Exit-only methods need dividends, valued in
  // the year received rather than pretending every dividend arrives in year 10.
  const dividends=rows.reduce((sum,r)=>sum+(finite(r.dividendPerShare)||0),0);
  const pvDividends=rows.reduce((sum,r,i)=>sum+pv((finite(r.dividendPerShare)||0),req,i+1),0);
  const terminalDividendValue=pvDividends*Math.pow(1+req,HORIZON_YEARS);
  for(const m of methods){
    const dividendOutcome=m.cashFlowInclusive?0:terminalDividendValue;
    m.outcome=Number.isFinite(m.target)?m.target+dividendOutcome:null;
    // Keep the method card on the same valuation basis as the headline fair value.
    // `fairValueToday` is intrinsic value discounted at the business-specific intrinsic
    // rate; `hurdleValueToday` is the separate 15% investor entry-price reference.
    // Using the hurdle rate for the method card made the displayed method fair values
    // look far below (and fail to reconcile to) the canonical fair value.
    m.audit={
      ...(m.audit||{}),
      year10Outcome:m.target,
      dividendOutcomeAdded:dividendOutcome,
      fairValueToday:Number.isFinite(m.outcome)?pv(m.outcome,intrinsicRate,HORIZON_YEARS):null,
      hurdleValueToday:Number.isFinite(m.outcome)?pv(m.outcome,INVESTOR_HURDLE_RETURN,HORIZON_YEARS):null,
      intrinsicDiscountRate:intrinsicRate,
      investorHurdleReturn:INVESTOR_HURDLE_RETURN,
    };
  }
  // Parallel 5Y outcome using the same admitted methods. Exit methods value year-5
  // forecast metrics with their already-underwritten mature multiple; DCF is rolled forward
  // to a year-5 continuation value. This makes near/medium-term return visible without
  // changing the canonical 10Y ranking contract.
  const y5=rows[Math.min(4,rows.length-1)]||{};
  const dividends5=rows.slice(0,5).reduce((sum,r)=>sum+(finite(r.dividendPerShare)||0),0);
  const pvDividends5=rows.slice(0,5).reduce((sum,r,i)=>sum+pv((finite(r.dividendPerShare)||0),req,i+1),0);
  const year5DividendValue=pvDividends5*Math.pow(1+req,5);
  const methods5Raw=methods.map(m=>{
    const terminalMult=finite(m.audit?.exitMultiple);
    const kind=/EPS exit/i.test(m.name)?'EPS':(/FCF exit/i.test(m.name)?'FCF':(/EV\/EBITDA exit/i.test(m.name)?'EBITDA':null));
    const mult=kind?horizonExitMultiple(kind,terminalMult,forecast,quality):terminalMult; let target5=null;
    if(m.name==='10Y DCF') target5=finite(m.audit?.year5Value);
    else if(/EPS exit/i.test(m.name)&&mult>0&&finite(y5.eps)>0) target5=y5.eps*mult;
    else if(/FCF exit/i.test(m.name)&&mult>0&&finite(y5.fcfPerShare)>0) target5=y5.fcfPerShare*mult;
    else if(/EV\/EBITDA exit/i.test(m.name)&&mult>0&&finite(y5.ebitda)>0&&finite(y5.shares)>0){const eq=y5.ebitda*mult-netDebt;target5=eq>0?eq/y5.shares:null;}
    else if(/EV\/Sales fallback/i.test(m.name)&&mult>0&&finite(y5.revenue)>0&&finite(y5.shares)>0){const eq=y5.revenue*mult-netDebt;target5=eq>0?eq/y5.shares:null;}
    const outcome5=target5>0?target5+(m.cashFlowInclusive?0:year5DividendValue):null;
    return {...m,target:target5,outcome:outcome5,audit:{...(m.audit||{}),year5ExitMultiple:mult,year5Outcome:target5,year5DividendOutcomeAdded:m.cashFlowInclusive?0:year5DividendValue}};
  });
  // The UI reads audit fields from the canonical 10Y methods. Previously the 5Y audit
  // lived only on temporary cloned methods, so every displayed Year-5 outcome was blank
  // even though the calculation existed. Copy the checkpoint audit back to the published
  // method objects before filtering invalid 5Y values.
  for(const m5 of methods5Raw){
    const published=methods.find(m=>m.name===m5.name);
    if(published) published.audit={...(published.audit||{}),year5ExitMultiple:m5.audit?.year5ExitMultiple??null,year5Outcome:m5.audit?.year5Outcome??null,year5DividendOutcomeAdded:m5.audit?.year5DividendOutcomeAdded??0};
  }
  const methods5=methods5Raw.filter(m=>m.outcome>0);
  const consensus5=valuationConsensus(methods5,price);
  const canonical5=robustOutcomeBlend(methods5,price,consensus5);
  const fiveYearTotalShareholderValue=canonical5.outcome;
  const fiveYearExpectedCAGR=price>0&&fiveYearTotalShareholderValue>0?Math.pow(fiveYearTotalShareholderValue/price,1/5)-1:null;
  const fiveYearPriceTarget=methods5.length?robustOutcomeBlend(methods5.map(m=>({...m,outcome:m.target})).filter(m=>m.outcome>0),price).outcome:null;

  const consensus=valuationConsensus(methods,price);
  const canonical=robustOutcomeBlend(methods,price,consensus);
  const provisionalTenYearCAGR=price>0&&canonical.outcome>0?Math.pow(canonical.outcome/price,1/HORIZON_YEARS)-1:null;
  const horizonCAGRSpread=Number.isFinite(fiveYearExpectedCAGR)&&Number.isFinite(provisionalTenYearCAGR)?Math.abs(fiveYearExpectedCAGR-provisionalTenYearCAGR):null;
  const horizonDivergenceFlag=Number.isFinite(horizonCAGRSpread)&&horizonCAGRSpread>.12;

  // Valuation confidence is determined from evidence BEFORE the canonical outcome is
  // published. Low-confidence assumptions now affect intrinsic value instead of merely
  // appearing as a cosmetic confidence score beside an unchanged point estimate.
  const reliableForAgreement=methods.map((m,index)=>({m,index})).filter(x=>(x.m.reliability??1)>=.35);
  const agreementEntries0=reliableForAgreement.length>=2?reliableForAgreement:methods.map((m,index)=>({m,index}));
  const agreementValues0=agreementEntries0.map(x=>({index:x.index,v:Number.isFinite(x.m.outcome)&&x.m.outcome>0?Math.log(x.m.outcome):null})).filter(x=>Number.isFinite(x.v));
  const agreementLogs0=(consensus.hasConsensusOutlier
    ? agreementValues0.filter(x=>consensus.clusterIndexes.includes(x.index))
    : agreementValues0).map(x=>x.v);
  const logCenter0=agreementLogs0.length?median(agreementLogs0):null;
  const deviations0=logCenter0==null?[]:agreementLogs0.map(v=>Math.abs(v-logCenter0));
  const robustSpread0=deviations0.length?median(deviations0):null;
  let agreement=agreementLogs0.length>=2
    ? Math.round(100*clamp(1-(robustSpread0??0)/Math.log(1.65),0,1))
    : (agreementLogs0.length===1?null:0);
  if(consensus.hasConsensusOutlier) agreement=Math.min(88,agreement);
  const families=new Set(methods.filter(m=>(m.reliability??0)>=.25).map(m=>m.family||m.name));
  const independentMethodCount=families.size;
  const forecastRel=clamp((forecast.forecastReliabilityScore??quality.confidenceScore??50)/100,.20,.95);
  const agreementForConfidence=Number.isFinite(agreement)?agreement:50;
  let valuationConfidence=Math.round(clamp(.45*(quality.confidenceScore||50)+.25*(forecastRel*100)+.30*agreementForConfidence,0,100));
  if(methods.length===1) valuationConfidence=Math.min(valuationConfidence,55);
  else if(independentMethodCount===1) valuationConfidence=Math.min(valuationConfidence,68);
  else if(independentMethodCount===2) valuationConfidence=Math.min(valuationConfidence,82);

  // V12.3: method dispersion is itself information. Even when no single method is a clean
  // statistical outlier, a wide high/low range means the terminal economics are uncertain.
  const methodOutcomes=methods.map(m=>finite(m.outcome)).filter(x=>x>0);
  const methodDispersionRatio=methodOutcomes.length>=2?Math.max(...methodOutcomes)/Math.min(...methodOutcomes):null;
  if(Number.isFinite(methodDispersionRatio)){
    const dispersionPenalty=Math.round(clamp((methodDispersionRatio-1.30)/1.20,0,1)*16);
    valuationConfidence=Math.max(20,valuationConfidence-dispersionPenalty);
  }

  // V12.15: explicitly separate forecast certainty from valuation certainty. Commodity and
  // strongly cyclical economics can have decent near-term forecasts while still deserving
  // a wider terminal-value range.
  const historicalRevenueGrowth=[];
  const histYears=stock.financials?.years||[];
  for(let i=1;i<histYears.length;i++){const a=finite(histYears[i-1]?.revenue),b=finite(histYears[i]?.revenue);if(a>0&&b>0)historicalRevenueGrowth.push(b/a-1);}
  const cycleDispersion=dispersion(historicalRevenueGrowth.slice(-6));
  const cyclicalBusiness=/Energy|Materials/i.test(String(stock?.sector||''))||cycleDispersion>.16;
  if(cyclicalBusiness){
    const cyclePenalty=Math.round(6+clamp((cycleDispersion-.08)/.24,0,1)*12);
    valuationConfidence=Math.max(20,valuationConfidence-cyclePenalty);
  }

  const preUncertaintyTotal=canonical.outcome;
  const preUncertaintyCAGR=cagr(price,preUncertaintyTotal);
  let uncertaintyHaircutRate=.002;
  let total=preUncertaintyTotal, expected=preUncertaintyCAGR;

  // Exit-multiple sensitivity: a decision that flips when terminal multiples move 20% is
  // intrinsically less certain. DCF is left unchanged because its terminal assumption is
  // already represented by perpetual growth rather than an exit multiple.
  const sensitivityOutcome=(factor)=>{
    const shocked=methods.map(m=>{
      if(!/exit$/i.test(m.name)||!Number.isFinite(m.target)) return {...m};
      const dividendOutcome=m.cashFlowInclusive?0:terminalDividendValue;
      const target=m.target*factor;
      return {...m,target,outcome:target+dividendOutcome};
    });
    return robustOutcomeBlend(shocked,price,valuationConsensus(shocked,price)).outcome;
  };
  const lowMultipleOutcome=sensitivityOutcome(.80), highMultipleOutcome=sensitivityOutcome(1.20);
  const lowMultipleCAGR=cagr(price,lowMultipleOutcome), highMultipleCAGR=cagr(price,highMultipleOutcome);
  const multipleSensitivitySpread=Number.isFinite(lowMultipleCAGR)&&Number.isFinite(highMultipleCAGR)?highMultipleCAGR-lowMultipleCAGR:null;
  // Confidence must be intrinsic-value invariant: changing only today's quote cannot make
  // the modeled business more or less uncertain. Score multiple sensitivity from the
  // high/low intrinsic outcomes themselves, not from CAGR measured off the current price.
  const intrinsicSensitivitySpread=lowMultipleOutcome>0&&highMultipleOutcome>0
    ? Math.pow(highMultipleOutcome/lowMultipleOutcome,1/HORIZON_YEARS)-1:null;

  if(Number.isFinite(intrinsicSensitivitySpread)){
    const sensitivityPenalty=Math.round(clamp((intrinsicSensitivitySpread-.035)/.08,0,1)*14);
    valuationConfidence=Math.max(20,valuationConfidence-sensitivityPenalty);
  }
  // Keep expected return and conservative underwriting separate. Uncertainty belongs in
  // confidence, scenario width and risk-adjusted fair value; subtracting it directly from
  // the base expected CAGR double-counts conservatism when the user also requires a margin
  // of safety / hurdle return. The risk-adjusted outcome remains available for fair value.
  uncertaintyHaircutRate=clamp(.001+Math.pow((100-valuationConfidence)/100,1.35)*.020,.001,.015);
  const riskAdjustedTotal=Number.isFinite(preUncertaintyTotal)?preUncertaintyTotal*Math.pow(1-uncertaintyHaircutRate,HORIZON_YEARS):null;
  total=preUncertaintyTotal;
  expected=preUncertaintyCAGR;

  // Return-integrity gate. A valuation is not decision-grade merely because its algebra
  // works. Mature/slow-growing businesses cannot publish 25-40% annual returns unless
  // the operating model itself contains enough growth, margin expansion, distributions,
  // or dilution improvement to support that result. This is intentionally generic: it
  // does not favor a category or ticker; it rejects a valuation whose re-rating is doing
  // implausibly large amounts of work.
  const startRevenue=finite(rows[0]?.revenue), endRevenue=finite(f?.revenue);
  const modeledRevenueCAGR=startRevenue>0&&endRevenue>0?Math.pow(endRevenue/startRevenue,1/Math.max(1,HORIZON_YEARS-1))-1:null;
  const startFCFM=finite(rows[0]?.fcfMargin), endFCFM=finite(f?.fcfMargin);
  const startNetM=finite(rows[0]?.netMargin), endNetM=finite(f?.netMargin);
  const marginLift=Math.max(0,(Number.isFinite(startFCFM)&&Number.isFinite(endFCFM)?endFCFM-startFCFM:0),(Number.isFinite(startNetM)&&Number.isFinite(endNetM)?endNetM-startNetM:0));
  const dilutionTailwind=Math.max(0,-(finite(forecast.dilutionRate)||0));
  const dividendYield=Math.max(0,finite(stock.valuation?.dividendYield)||0);
  const operatingSupport=Math.max(0,modeledRevenueCAGR??growth??0)+Math.min(.05,marginLift/HORIZON_YEARS)+Math.min(.04,dilutionTailwind)+Math.min(.06,dividendYield);
  const matureSlowGrowth=Math.max(modeledRevenueCAGR??0,growth??0)<.10;
  const reratingAllowance=matureSlowGrowth?.075:.11;
  const returnSupportCeiling=clamp(operatingSupport+reratingAllowance,.12,.30);
  const conservativeCategory=forecast.category==='Value'||forecast.category==='Dividend';
  const returnDecompositionFailure=conservativeCategory&&matureSlowGrowth&&Number.isFinite(expected)&&expected>returnSupportCeiling+.015;

  let hasValuation=Number.isFinite(expected)&&methods.length>0&&Number.isFinite(total)&&total>0&&!returnDecompositionFailure;
  if(!hasValuation){total=null;expected=null;}

  const target=total!=null?Math.max(0,total-terminalDividendValue):null;
  // Keep two concepts separate:
  //   fairValueEstimate = risk-normalized intrinsic value (what the business is worth)
  //   requiredReturnBuyPrice = price that would deliver this model's stricter hurdle rate.
  // Previously both were the same number, which made high-quality growth companies look
  // artificially 'worth' only the price needed to earn 11-12% annually.
  const fairDiscountRate=intrinsicRate;
  // The operating forecast is our best base-case estimate. Do not apply the generic
  // uncertainty haircut again when converting that forecast into fair value or the
  // investor entry price: forecast risk is already reflected in the intrinsic discount
  // rate, while the user's conservatism is imposed explicitly through a 15% hurdle and
  // then a separate 20% margin of safety.
  const fair=total!=null?pv(total,fairDiscountRate,HORIZON_YEARS):null;
  const hurdleReturnPrice=total!=null?pv(total,INVESTOR_HURDLE_RETURN,HORIZON_YEARS):null;
  const requiredReturnBuyPrice=hurdleReturnPrice!=null?hurdleReturnPrice*(1-INVESTOR_MARGIN_OF_SAFETY):null;
  // MOS is never a negative percentage. Overvaluation is represented separately by
  // premiumToFairValue / valuationGap, avoiding outputs such as -165% MOS.
  const rawMos=fair>0&&price>0?1-price/fair:null;
  const mos=rawMos==null?null:Math.max(0,rawMos);
  const premium=fair>0&&price>0?Math.max(0,price/fair-1):null;
  const valuationGap=fair>0&&price>0?fair/price-1:null;
  let modelSupport='standard', modelSupportReason=null;
  if(financialLike&&methods.length>0){
    // Banks, insurers and mortgage REITs need book value/ROTCE, capital, reserve or
    // distributable-earnings inputs that the free generic dataset does not reliably
    // provide. A lone normalized-EPS exit can remain visible as a reference valuation,
    // but it must not masquerade as decision-grade multi-method evidence.
    modelSupport='limited';
    modelSupportReason='Financial-style business is supported by normalized EPS only; specialized book-value/capital/ROTCE or distributable-earnings evidence is unavailable';
    valuationConfidence=Math.min(valuationConfidence,50);
  }
  if(stock.sector==='Real Estate'){modelSupport='limited';modelSupportReason='REIT/real-estate specialized FFO-NAV metrics are not available in the free-data model';valuationConfidence=Math.min(valuationConfidence,50);}
  if(!shareDenominatorUsable){modelSupport='unsupported';modelSupportReason='Share-count denominator failed independent reconciliation';valuationConfidence=Math.min(valuationConfidence,20);}
  else if(financialLike&&methods.length===0){modelSupport='unsupported';modelSupportReason='Financial/insurance-like economics require a reliable normalized EPS basis; cash-flow and sales fallbacks are intentionally disabled';valuationConfidence=Math.min(valuationConfidence,35);}
  else if(materialNCI&&methods.length===0){modelSupport='unsupported';modelSupportReason='Material non-controlling interest creates an ownership-scope mismatch and no parent-scope EPS valuation was available';valuationConfidence=Math.min(valuationConfidence,35);}
  else if(returnDecompositionFailure){modelSupport='unsupported';modelSupportReason='Canonical return exceeds what modeled operating growth, margin change, dilution, dividends, and a bounded re-rating allowance can support';valuationConfidence=Math.min(valuationConfidence,35);}
  else if(methods.length===0){modelSupport='unsupported';modelSupportReason='No defensible valuation method produced a value from the available economics';valuationConfidence=Math.min(valuationConfidence,35);}
  // Investor-style return attribution. Contributions are annualized approximations,
  // intended to reveal what must go right rather than falsely imply exact additivity.
  const endShares=finite(f.shares);
  const shareCountContribution=shares0>0&&endShares>0?Math.pow(shares0/endShares,1/HORIZON_YEARS)-1:null;
  const representativeStartMargin=Number.isFinite(base.margins?.net)&&base.margins.net>0?base.margins.net:(Number.isFinite(base.margins?.fcf)&&base.margins.fcf>0?base.margins.fcf:null);
  const representativeEndMargin=Number.isFinite(f.netMargin)&&f.netMargin>0?f.netMargin:(Number.isFinite(f.fcfMargin)&&f.fcfMargin>0?f.fcfMargin:null);
  const marginContribution=representativeStartMargin>0&&representativeEndMargin>0?Math.pow(representativeEndMargin/representativeStartMargin,1/HORIZON_YEARS)-1:null;
  const exitOnlyOutcome=total!=null?Math.max(0,total-terminalDividendValue):null;
  const exDividendCAGR=cagr(price,exitOnlyOutcome);
  const dividendContribution=Number.isFinite(expected)&&Number.isFinite(exDividendCAGR)?expected-exDividendCAGR:0;
  const revenueContribution=modeledRevenueCAGR;
  const fundamentalContribution=[revenueContribution,marginContribution,shareCountContribution].filter(Number.isFinite).reduce((a,b)=>a+b,0);
  const riskAdjustedCAGR=cagr(price,riskAdjustedTotal);
  const uncertaintyAdjustment=Number.isFinite(preUncertaintyCAGR)&&Number.isFinite(riskAdjustedCAGR)?riskAdjustedCAGR-preUncertaintyCAGR:null;
  const multipleReratingContribution=Number.isFinite(expected)?expected-fundamentalContribution-(dividendContribution||0):null;
  const returnAttribution={revenueContribution,marginContribution,shareCountContribution,dividendContribution,multipleReratingContribution,uncertaintyAdjustment,preUncertaintyCAGR,uncertaintyHaircutRate};

  const uncertainty=clamp((100-valuationConfidence)/100+(cyclicalBusiness?.08:0),.10,.55);
  const bear=total!=null?total*Math.pow(1-(.035+.04*uncertainty),HORIZON_YEARS):null, bull=total!=null?total*Math.pow(1+(.035+.035*uncertainty),HORIZON_YEARS):null;
  const extremeReturn=hasValuation&&(expected<-.30||expected>.22);
  const lowReliability=methods.length>0&&Math.max(...methods.map(m=>m.reliability??0))<.40;

  return {requiredReturn:req,intrinsicDiscountRate:intrinsicRate,methods,valuationArchetype:archetype.name,canonicalMethodWeights:canonical.weights,fiveYearPriceTarget,tenYearPriceTarget:target,fiveYearTotalShareholderValue,fiveYearExpectedCAGR,tenYearExpectedCAGR:expected,horizonCAGRSpread,horizonDivergenceFlag,horizonYears:HORIZON_YEARS,cumulativeDividends:dividends,presentValueDividends:pvDividends,terminalDividendValue,totalShareholderValue:total,expectedCAGR:expected,fairValueEstimate:fair,hurdleReturnPrice,requiredReturnBuyPrice,investorMarginOfSafety:INVESTOR_MARGIN_OF_SAFETY,fairValueDiscountRate:fairDiscountRate,marginOfSafety:mos,premiumToFairValue:premium,valuationGap,methodAgreementScore:agreement,multipleSensitivity:{down20CAGR:lowMultipleCAGR,up20CAGR:highMultipleCAGR,spread:multipleSensitivitySpread},returnAttribution,preUncertaintyCAGR,riskAdjustedTotal,riskAdjustedCAGR,uncertaintyHaircutRate,valuationConfidenceScore:valuationConfidence,cyclicalBusiness,cycleDispersion,independentMethodCount,modelSupport,modelSupportReason,forecastReliabilityScore:forecast.forecastReliabilityScore??null,valuationConsensus:{hasConsensusOutlier:consensus.hasConsensusOutlier,clusterMethods:consensus.clusterIndexes.map(i=>methods[i]?.name).filter(Boolean),outlierMethods:consensus.outlierIndexes.map(i=>methods[i]?.name).filter(Boolean),clusterSpread:consensus.pairSpread,outlierGap:consensus.outlierGap},methodDispersionRatio,bearCAGR:cagr(price,bear),baseCAGR:expected,bullCAGR:cagr(price,bull),netDebt,plausibilityFailure:!hasValuation,returnDecompositionFailure,returnSupportCeiling,operatingSupport,modeledRevenueCAGR,extremeReturnFlag:extremeReturn,valuationReviewFlag:extremeReturn?'extreme_blended_return_after_normalization':(horizonDivergenceFlag?'large_5y_10y_return_divergence':(consensus.hasConsensusOutlier?'isolated_method_outlier':(Number.isFinite(agreement)&&agreement<35?'material_method_disagreement':(lowReliability?'low_method_reliability':null))))};
}
module.exports={valuate};
