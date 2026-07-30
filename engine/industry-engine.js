'use strict';
const clamp=(x,l,h)=>Math.max(l,Math.min(h,x));
function inferIndustryModel(stock){
 const raw=String(stock.sector||'').toLowerCase();
 const s=raw.replace(/&/g,'and');
 const ys=stock.financials?.years||[], last=ys.at(-1)||{};
 const gm=last.grossMargin, ci=last.revenue>0&&last.capex!=null?Math.abs(last.capex)/last.revenue:null;
 let model='general';
 if(/financial|bank|insurance/.test(s)) model='financials';
 else if(/real estate|reit/.test(s)) model='reit';
 else if(/utilit/.test(s)) model='utilities';
 else if(/energy|oil|gas/.test(s)) model='energy';
 else if(/communication|telecom/.test(s)) model='communications';
 else if(/technology|tech/.test(s)&&gm>=.65&&(ci==null||ci<.08)) model='software';
 else if(/technology|tech|semiconductor/.test(s)) model='semiconductors-hardware';
 else if(/consumer staples|consumer defensive|staples/.test(s)) model='consumer-staples';
 else if(/consumer discretionary|consumer cyclical|discretionary/.test(s)) model='consumer-discretionary';
 else if(/health/.test(s)) model=gm>=.60?'healthcare-innovation':'healthcare-services';
 else if(/industrial/.test(s)) model='industrials';
 else if(/basic materials|materials/.test(s)) model='materials';
 const cfg={software:[1.08,1.20,.96,0],'semiconductors-hardware':[.96,1.12,1.06,.05],financials:[.82,1,1.08,0],reit:[.78,.98,1.12,.05],utilities:[.72,.94,.94,.07],energy:[.62,.88,1.24,.10],communications:[.82,1,1.06,.03],'consumer-staples':[.90,1.08,.90,.01],'consumer-discretionary':[.84,1.02,1.08,.02],'healthcare-innovation':[.94,1.10,1.12,.02],'healthcare-services':[.82,1,1.02,.01],industrials:[.84,1.02,1,.04],materials:[.68,.92,1.18,.08],general:[.82,1,1,.03]}[model];
 const cat=stock.valuation?.businessProfile?.category||''; const life=cat==='Hyper Growth'?1.08:cat==='Growth'?1.04:cat==='Compounder'?1.06:cat==='Cyclical'?.82:cat==='Turnaround'?.88:1;
 return {model,sector:stock.sector||'Unknown',config:{growthPersistence:clamp(cfg[0]*life,.55,1.18),multiplePremiumCap:cfg[1],riskModifier:cfg[2],capitalIntensityPenalty:cfg[3]},diagnostics:{rawSector:raw,grossMargin:gm,capexIntensity:ci,category:cat}};
}
module.exports={inferIndustryModel};
