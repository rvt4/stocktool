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
 const forwardGrowth=Number(lifecycle?.forwardGrowth??stock.growthYear1??.06);
 const reinvestment=clamp((forwardGrowth-.03)/.25,0,1);
 const dilution=stock.valuation?.dilutionRate??0;
 const shareholder=clamp(.7-dilution*5,0,1);
 const balance=last.ebitda>0?clamp(1-Math.max(0,(last.longTermDebt||0)-(last.cash||0))/(last.ebitda*5),0,1):.5;

 // V59 economic moat recognition: scale/network/platform advantages often appear in
 // financial statements as asset-light growth + durable/improving margins + cash
 // conversion before conventional ROIC history fully catches up. This is deliberately
 // economics-based so no ticker receives a special override.
 const capexIntensity=last.revenue>0?Math.abs(Number(last.capex||0))/last.revenue:1;
 const positiveFcf=ys.length?ys.filter(y=>Number(y.fcf)>0).length/ys.length:0;
 const firstOp=ops.length?ops[0]:null, lastOp=ops.length?ops.at(-1):null;
 const marginDirection=Number.isFinite(firstOp)&&Number.isFinite(lastOp)?clamp((lastOp-firstOp+.03)/.12,0,1):.5;
 const assetLight=clamp((.12-capexIntensity)/.10,0,1);
 const scaleEconomics=clamp(
   assetLight*.28 + clamp((forwardGrowth-.06)/.18,0,1)*.25 + positiveFcf*.18 +
   marginDirection*.17 + clamp(((mean(gross)??.25)-.20)/.45,0,1)*.12, 0, 1);
 const platformBonus=scaleEconomics>=.62?clamp((scaleEconomics-.62)*.32,0,.12):0;

 const base=roic*.24+pricing*.17+marginDurability*.16+cash*.13+reinvestment*.11+shareholder*.07+balance*.06+scaleEconomics*.06;
 const score=Math.round(100*clamp(base+platformBonus,0,1));
 const duration=Math.round(clamp(3+score*.15+(lifecycle?.stage==='Elite Compounder'?3:0),3,20));
 const fadeSpeed=score>=80?'very-slow':score>=65?'slow':score>=48?'moderate':'fast';
 return {score,grade:score>=85?'Exceptional':score>=70?'Wide':score>=55?'Narrow':score>=40?'Developing':'Weak',excessReturnYears:duration,fadeSpeed,components:{roic,pricingPower:pricing,marginDurability,cashConversion:cash,reinvestmentRunway:reinvestment,shareholderAlignment:shareholder,balanceSheet:balance,scaleEconomics,assetLight}};
}
module.exports={computeMoat};
