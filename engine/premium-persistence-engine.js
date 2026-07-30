'use strict';
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const median=a=>{const v=(a||[]).filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const stability=a=>{const v=(a||[]).filter(Number.isFinite);if(v.length<3)return .5;const avg=v.reduce((s,x)=>s+x,0)/v.length;const dev=Math.sqrt(v.reduce((s,x)=>s+(x-avg)**2,0)/v.length);return clamp(1-dev/.10,0,1);};
const INDUSTRY_ANCHORS={
 software:.58,'healthcare-innovation':.50,'healthcare-services':.40,'consumer-staples':.40,
 'consumer-discretionary':.38,communications:.36,'semiconductors-hardware':.34,
 industrials:.27,utilities:.25,financials:.18,reit:.20,energy:.10,materials:.12,general:.30
};
function computePremiumPersistence(stock,profile={},lifecycle={},moat={}){
 const years=(stock.financials?.years||[]).slice(-8);
 const industry=stock.valuation?.industryModel?.model||'general';
 const roicMed=median(years.map(y=>y.roic));
 const gross=years.map(y=>y.grossMargin); const op=years.map(y=>y.operatingMargin??y.opMargin); const fcf=years.map(y=>y.fcfMargin??(y.revenue>0&&Number.isFinite(y.fcf)?y.fcf/y.revenue:null));
 const grossMed=median(gross)??0;
 const recurring=clamp(profile.recurringRevenue??profile.recurringRevenueScore??.45,0,1);
 const profileMoat=Number.isFinite(profile.moatScore)?profile.moatScore*100:null;
 const moat01=clamp((moat.score??profileMoat??50)/100,0,1);
 const pricing=clamp((stock.valuation?.pricingPowerV2?.score??stock.pricingPowerScore??50)/100,0,1);
 const roicScore=roicMed==null?.45:clamp((roicMed-.06)/.30,0,1);
 const marginStability=(stability(gross)+stability(op)+stability(fcf))/3;
 const reliability=clamp(profile.forecastReliability??lifecycle.confidence??.5,0,1);
 const capitalLight=clamp(1-(profile.capitalIntensity??.5),0,1);
 const growthPersistence=clamp((lifecycle.growthPersistenceScore??50)/100,0,1);
 const stage=lifecycle.stage||'';
 const stageAdj=/Elite Compounder|Compounder/.test(stage)?.06:/Hyper Growth|Growth/.test(stage)?.03:/Cyclical|Turnaround/.test(stage)?-.06:0;
 const economicModel=lifecycle.economicModel||{};
 const industryAnchor=Number.isFinite(economicModel.premiumAnchor)?economicModel.premiumAnchor:(INDUSTRY_ANCHORS[industry]??INDUSTRY_ANCHORS.general);
 // Emerging high-margin consumer brands deserve a longer premium runway than mature
 // packaged-goods averages, without any ticker-specific exception.
 const scalingBrand=economicModel.archetype==='Scaling Consumer Brand';
 const consumerBrandBonus=['consumer-staples','consumer-discretionary'].includes(industry)
   ? clamp((grossMed-.35)*.35,0,.08)+clamp(((lifecycle.forwardGrowth ?? 0) - .10) * .20,0,.06)+pricing*.04+(scalingBrand?.08:0)
   : 0;
 const secularBonus=economicModel.secular?clamp(.03+economicModel.quality*.05,0,.08):0;
 const score=clamp(industryAnchor*.22+moat01*.18+pricing*.14+roicScore*.14+marginStability*.10+recurring*.08+reliability*.06+capitalLight*.04+growthPersistence*.04+stageAdj+consumerBrandBonus+secularBonus,0,1);
 const floor=industry==='energy'||industry==='materials'?.08:.16;
 const ceiling=['software','healthcare-innovation'].includes(industry)?.80:scalingBrand?.76:['consumer-staples','consumer-discretionary'].includes(industry)?.68:economicModel.secular?.76:.72;
 const retainedPremium=clamp(industryAnchor*.45+score*.55,floor,ceiling);
 return {score,retainedPremium,expectedFade:1-retainedPremium,industryAnchor,consumerBrandBonus,secularBonus,archetype:economicModel.archetype||null,components:{moat:moat01,pricingPower:pricing,roicPersistence:roicScore,marginStability,recurringRevenue:recurring,forecastReliability:reliability,capitalLight,growthPersistence}};
}
module.exports={computePremiumPersistence,INDUSTRY_ANCHORS};
