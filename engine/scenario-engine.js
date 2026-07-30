'use strict';
const { normalizeCycle } = require('./cycle-normalization-engine');
const { assessCapitalIntensity } = require('./capital-intensity-engine');
const { assessCompetitivePressure } = require('./competitive-pressure-engine');
const { computeGrowthQuality } = require('./growth-quality-engine');
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
const SPREAD={
 'Hyper Growth':{g:.10,m:.035,x:.24},Growth:{g:.07,m:.025,x:.18},Compounder:{g:.045,m:.018,x:.13},Dividend:{g:.025,m:.012,x:.10},Value:{g:.035,m:.018,x:.14},Turnaround:{g:.07,m:.04,x:.22},Cyclical:{g:.09,m:.05,x:.25}
};
function probs(stock,integrity,profile,cycle,gq){
 const reliability=profile?.forecastReliability??.5, analyst=stock.valuation?.analystReliability??.5, moat=profile?.moatScore??.5, data=(integrity?.score??50)/100;
 const conf=clamp(reliability*.24+analyst*.18+moat*.18+data*.22+(gq?.score??50)/100*.18,0,1);
 const base=clamp(.46+(conf-.5)*.34-cycle.cyclicality*.07,.36,.66); const bear=clamp(.34-(conf-.5)*.18+cycle.cyclicality*.08,.18,.43); return {bear,base,bull:1-base-bear,confidence:conf};
}
function scenarioProjection(base,kind,spread,cycle,capital,competition){
 let previousRevenue=null; return base.map((r,i)=>{
  const t=i+1, fade=Math.exp(-t*(kind==='bull'?.18:.26)*competition.growthFadeMultiplier);
  const delta=kind==='bear'?-spread.g*(.65+.35*cycle.cyclicality)*fade:kind==='bull'?spread.g*(.60+.30*(1-cycle.cyclicality))*fade:0;
  const growth=clamp(r.growth+delta,-.25,.65); const revenue=i===0?r.revenue:previousRevenue*(1+growth); previousRevenue=revenue;
  const marginDelta=kind==='bear'?-spread.m*(.6+.4*competition.pressure):kind==='bull'?spread.m*(.55+.25*capital.fcfConversion):0;
  return {...r,growth,revenue,fcfMargin:clamp((r.fcfMargin??0)+marginDelta-competition.annualMarginFade*t,-.2,.5),netMargin:clamp((r.netMargin??0)+marginDelta*.75,-.25,.5),ebitdaMargin:clamp((r.ebitdaMargin??0)+marginDelta*.9,-.1,.6)};
 });
}
function buildScenarios(stock,v,integrity){
 const category=v.category||'Value', spread=SPREAD[category]||SPREAD.Value, profile=v.businessProfile||{}, base=v.projection||[];
 const current=stock.price?.current, years=v.fiveYearPriceTarget?.years||Math.min(5,base.length)||5, baseExit=v.fiveYearPriceTarget?.exitPrice, dividends=v.fiveYearPriceTarget?.dividendsReceived||0;
 const cycle=normalizeCycle(stock), capital=assessCapitalIntensity(stock,base), competition=assessCompetitivePressure(stock,profile,stock.valuation?.pricingPowerV2), growthQuality=computeGrowthQuality(stock,cycle,capital,competition), p=probs(stock,integrity,profile,cycle,growthQuality);
 if(!(current>0)||!(baseExit>0))return{probabilities:p,scenarios:null,expectedCAGR:null,cycleNormalization:cycle,capitalIntensity:capital,competitivePressure:competition,growthQuality};
 const bearProj=scenarioProjection(base,'bear',spread,cycle,capital,competition), bullProj=scenarioProjection(base,'bull',spread,cycle,capital,competition);
 const bearFund=base.length&&bearProj.length?bearProj.at(-1).revenue/base.at(-1).revenue:1, bullFund=base.length&&bullProj.length?bullProj.at(-1).revenue/base.at(-1).revenue:1;
 const bearExit=Math.max(.01,baseExit*bearFund*(1-spread.x*(.75+competition.pressure*.35)));
 const bullExit=baseExit*bullFund*(1+spread.x*(.60+competition.premiumRetentionMultiplier*.35));
 const baseC=Math.pow((baseExit+dividends)/current,1/years)-1, bearC=Math.pow((bearExit+dividends*.75)/current,1/years)-1, bullC=Math.pow((bullExit+dividends*1.1)/current,1/years)-1;
 const expected=clamp(bearC*p.bear+baseC*p.base+bullC*p.bull,-.6,1);
 return {probabilities:p,scenarios:{bear:{probability:p.bear,cagr:clamp(bearC,-.6,1),exitPrice:bearExit,projection:bearProj,description:'Cycle-normalized downside with faster competitive fade'},base:{probability:p.base,cagr:clamp(baseC,-.6,1),exitPrice:baseExit,projection:base,description:'Central operating forecast'},bull:{probability:p.bull,cagr:clamp(bullC,-.6,1.2),exitPrice:bullExit,projection:bullProj,description:'Stronger execution, margins and premium retention'}},expectedCAGR:expected,probabilityWeightedCAGR:expected,downsideCAGR:clamp(bearC,-.6,1),baseCAGR:clamp(baseC,-.6,1),upsideCAGR:clamp(bullC,-.6,1.2),years,cycleNormalization:cycle,capitalIntensity:capital,competitivePressure:competition,growthQuality};
}
module.exports={buildScenarios};
