'use strict';
const clamp=(x,l,h)=>Math.max(l,Math.min(h,x));
function inferIndustryModel(stock){
 const s=String(stock.sector||'').toLowerCase(), ys=stock.financials?.years||[], last=ys.at(-1)||{};
 const gm=last.grossMargin, ci=last.revenue>0&&last.capex!=null?Math.abs(last.capex)/last.revenue:null;
 let model='general';
 if(s.includes('financial')) model='financials'; else if(s.includes('real estate')) model='reit'; else if(s.includes('utility')) model='utilities'; else if(s.includes('energy')) model='energy'; else if(s.includes('communication')) model='communications'; else if(s.includes('technology')&&gm>=.65&&(ci==null||ci<.08)) model='software'; else if(s.includes('technology')) model='semiconductors-hardware'; else if(s.includes('consumer staples')) model='consumer-staples'; else if(s.includes('consumer discretionary')) model='consumer-discretionary'; else if(s.includes('health')) model=gm>=.60?'healthcare-innovation':'healthcare-services'; else if(s.includes('industrial')) model='industrials'; else if(s.includes('materials')) model='materials';
 const cfg={software:[1.08,1.20,.96,0],'semiconductors-hardware':[.92,1.08,1.10,.06],financials:[.82,1,1.08,0],reit:[.78,.98,1.12,.05],utilities:[.72,.94,.94,.07],energy:[.62,.88,1.24,.10],communications:[.82,1,1.06,.03],'consumer-staples':[.90,1.08,.90,.01],'consumer-discretionary':[.84,1.02,1.08,.02],'healthcare-innovation':[.94,1.10,1.12,.02],'healthcare-services':[.82,1,1.02,.01],industrials:[.84,1.02,1,.04],materials:[.68,.92,1.18,.08],general:[.82,1,1,.03]}[model];
 const cat=stock.valuation?.businessProfile?.category||''; const life=cat==='Hyper Growth'?1.08:cat==='Growth'?1.04:cat==='Compounder'?1.06:cat==='Cyclical'?.82:cat==='Turnaround'?.88:1;
 return {model,sector:stock.sector||'Unknown',config:{growthPersistence:clamp(cfg[0]*life,.55,1.18),multiplePremiumCap:cfg[1],riskModifier:cfg[2],capitalIntensityPenalty:cfg[3]},diagnostics:{grossMargin:gm,capexIntensity:ci,category:cat}};
}
module.exports={inferIndustryModel};
