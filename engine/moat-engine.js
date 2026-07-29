'use strict';
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
function stability(values,band){ if(values.length<2)return .5; return clamp(1-(Math.max(...values)-Math.min(...values))/band,0,1); }
function computeMoat(stock,lifecycle=null){
 const ys=(stock.financials?.years||[]).slice(-5), last=ys.at(-1)||{};
 const roics=ys.map(y=>y.roic).filter(Number.isFinite), gross=ys.map(y=>y.grossMargin).filter(Number.isFinite), ops=ys.map(y=>y.opMargin).filter(Number.isFinite);
 const fcfMargins=ys.map(y=>y.revenue>0&&Number.isFinite(y.fcf)?y.fcf/y.revenue:null).filter(Number.isFinite);
 const avgRoic=mean(roics);
 const roic=avgRoic==null?.45:clamp((avgRoic-.05)/.30,0,1);
 const pricing=clamp((stock.valuation?.pricingPowerV2?.score??stock.pricingPowerScore??50)/100,0,1);
 const marginDurability=stability(gross,.16)*.55+stability(ops,.18)*.45;
 const cash=clamp(((mean(fcfMargins)??.04)-.01)/.24,0,1);
 const reinvestment=clamp(((lifecycle?.forwardGrowth??.06)-.03)/.25,0,1);
 const dilution=stock.valuation?.dilutionRate??0;
 const shareholder=clamp(.7-dilution*5,0,1);
 const balance=last.ebitda>0?clamp(1-Math.max(0,(last.longTermDebt||0)-(last.cash||0))/(last.ebitda*5),0,1):.5;
 const score=Math.round(100*clamp(roic*.26+pricing*.18+marginDurability*.17+cash*.14+reinvestment*.12+shareholder*.07+balance*.06,0,1));
 const duration=Math.round(clamp(3+score*.15+(lifecycle?.stage==='Elite Compounder'?3:0),3,20));
 const fadeSpeed=score>=80?'very-slow':score>=65?'slow':score>=48?'moderate':'fast';
 return {score,grade:score>=85?'Exceptional':score>=70?'Wide':score>=55?'Narrow':score>=40?'Developing':'Weak',excessReturnYears:duration,fadeSpeed,components:{roic,pricingPower:pricing,marginDurability,cashConversion:cash,reinvestmentRunway:reinvestment,shareholderAlignment:shareholder,balanceSheet:balance}};
}
module.exports={computeMoat};
