'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function median(a){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}
function mad(a,m){const x=a.filter(Number.isFinite);return x.length?median(x.map(v=>Math.abs(v-m))):null;}
function growthRates(years,key='revenue'){const out=[];for(let i=1;i<years.length;i++){const a=years[i-1]?.[key],b=years[i]?.[key];if(a>0&&b>0)out.push(b/a-1);}return out;}
function normalizeCycle(stock){
 const years=stock.financials?.years||[]; const recent=years.slice(-7);
 const rev=growthRates(recent); const revMed=median(rev)??0.04; const revMad=mad(rev,revMed)??0;
 const margins=recent.map(y=>y.revenue>0&&Number.isFinite(y.fcf)?y.fcf/y.revenue:null).filter(Number.isFinite);
 const ebitda=recent.map(y=>y.revenue>0&&Number.isFinite(y.ebitda)?y.ebitda/y.revenue:null).filter(Number.isFinite);
 const capex=recent.map(y=>y.revenue>0&&Number.isFinite(y.capex)?Math.abs(y.capex)/y.revenue:null).filter(Number.isFinite);
 const currentAnalyst=stock.analystEstimates?.revenueGrowthCurrentYear??stock.analystEstimates?.revenueGrowthFwd;
 const nextAnalyst=stock.analystEstimates?.revenueGrowthNextYear;
 const volatility=clamp(revMad/0.12,0,1); const cyclicality=clamp(volatility*0.65+(rev.some(x=>x<-.08)&&rev.some(x=>x>.15)?0.35:0),0,1);
 const analystWeight=clamp(0.62-cyclicality*0.22,0.35,0.68);
 const analystAnchor=median([currentAnalyst,nextAnalyst].filter(Number.isFinite));
 const normalizedGrowth=clamp((analystAnchor??revMed)*analystWeight+revMed*(1-analystWeight),-0.12,0.35);
 return {normalizedGrowth,historicalMedianGrowth:revMed,growthVolatility:revMad,cyclicality,
   normalizedFcfMargin:median(margins),normalizedEbitdaMargin:median(ebitda),normalizedCapexMargin:median(capex),
   analystWeight,quality:Math.round(clamp((1-cyclicality)*70+Math.min(1,recent.length/7)*30,0,100))};
}
module.exports={normalizeCycle};
