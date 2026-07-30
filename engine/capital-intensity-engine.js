'use strict';
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function median(a){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}
function assessCapitalIntensity(stock,projection=[]){
 const yrs=(stock.financials?.years||[]).slice(-6); const ratios=yrs.map(y=>y.revenue>0&&Number.isFinite(y.capex)?Math.abs(y.capex)/y.revenue:null).filter(Number.isFinite);
 const roics=yrs.map(y=>y.roic).filter(Number.isFinite); const capexMargin=median(ratios)??0.04; const roic=median(roics)??0.10;
 const growth=projection.length&&yrs.at(-1)?.revenue>0?Math.pow(projection.at(-1).revenue/yrs.at(-1).revenue,1/projection.length)-1:0.05;
 const reinvestmentNeed=clamp(growth/Math.max(roic,0.06),0,1.5); const conversion=clamp(1-capexMargin*2.6-reinvestmentNeed*0.16,0.30,0.95);
 const score=Math.round(clamp(100-(capexMargin/0.16)*55-(reinvestmentNeed/1.2)*30+(roic/0.30)*15,0,100));
 return {score,grade:score>=80?'Light':score>=60?'Moderate':score>=40?'Heavy':'Very Heavy',capexMargin,normalizedROIC:roic,reinvestmentNeed,fcfConversion:conversion};
}
module.exports={assessCapitalIntensity};
