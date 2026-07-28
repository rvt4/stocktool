'use strict';
const clamp=(x,l,h)=>Math.max(l,Math.min(h,x)),mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null,slope=a=>a.length>=2?(a.at(-1)-a[0])/(a.length-1):null;
function stable(a,r){if(a.length<3)return 50;return Math.round(clamp(100*(1-(Math.max(...a)-Math.min(...a))/r),0,100));}
function computePricingPowerV2(stock,industry){
 const y=(stock.financials?.years||[]).slice(-5),sig=[],risks=[],gm=y.map(x=>x.grossMargin).filter(Number.isFinite),om=y.map(x=>x.opMargin).filter(Number.isFinite),fm=y.map(x=>x.fcf!=null&&x.revenue>0?x.fcf/x.revenue:null).filter(Number.isFinite),ro=y.map(x=>x.roic).filter(Number.isFinite),inv=y.map(x=>x.inventoryTurnover).filter(Number.isFinite),rg=[];
 for(let i=1;i<y.length;i++)if(y[i-1].revenue>0&&y[i].revenue>0)rg.push(y[i].revenue/y[i-1].revenue-1);
 const lvl=gm.length?clamp((mean(gm)-.20)/.55*100,0,100):50,dur=stable(gm,.16),gt=slope(gm),ot=slope(om),ft=slope(fm),trend=clamp(50+(gt||0)*900+(ot||0)*650+(ft||0)*550,0,100),rd=stable(ro,.30),resil=rg.length?clamp((mean(rg)+.04)/.18*100,0,100):50,invs=inv.length>=2?clamp(50+((inv.at(-1)/Math.max(inv[0],.01))-1)*160,0,100):50,boost=industry?.model==='software'?7:industry?.model==='consumer-staples'?5:industry?.model==='communications'?3:0;
 const score=Math.round(clamp(lvl*.18+dur*.20+trend*.22+rd*.14+resil*.16+invs*.10+boost,0,100));
 if(gt>.004)sig.push('Gross margin is expanding'); if(dur>=75)sig.push('Gross margin is durable'); if(ot>.003)sig.push('Operating leverage is improving'); if(ft>.004)sig.push('FCF margin is expanding'); if(rd>=75)sig.push('Returns on capital are persistent'); if(resil>=70)sig.push('Revenue growth has been resilient'); if(invs>=65)sig.push('Inventory efficiency is stable or improving');
 if(gt<-.006)risks.push('Gross margin is eroding'); if(ot<-.006)risks.push('Operating margin is weakening'); if(ft<-.008)risks.push('FCF margin is deteriorating'); if(dur<40)risks.push('Gross margin is volatile');
 return {score,grade:score>=85?'Elite':score>=72?'Strong':score>=58?'Moderate':score>=42?'Weak':'Poor',signals:sig,risks,components:{grossMarginLevel:Math.round(lvl),grossMarginDurability:dur,marginTrend:Math.round(trend),roicDurability:rd,growthResilience:Math.round(resil),inventoryEfficiency:Math.round(invs)}};
}
module.exports={computePricingPowerV2};
