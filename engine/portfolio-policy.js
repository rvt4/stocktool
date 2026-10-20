'use strict';

function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}
function clamp(v,lo=0,hi=1){return Math.max(lo,Math.min(hi,v));}


// v12.52: 15% is the investor return hurdle. Margin of safety is separate and
// scales with uncertainty. Very uncertain but still supported businesses are no
// longer vetoed outright; they must clear a substantially larger valuation cushion.
function isValuationBuyRating(rating){
  return ['Buy','Strong Buy','Exceptional Buy'].includes(String(rating||''));
}
function ratingAlphaSizingTarget(r){
  const rating=String(r?.rating||''),a=finite(r?.expectedAlpha);
  if(rating==='Exceptional Buy')return 8+2*clamp(((a??.15)-.15)/.20,0,1);
  if(rating==='Strong Buy')return 6+2*clamp(((a??.10)-.10)/.15,0,1);
  if(rating==='Buy')return 4.5+1.5*clamp(((a??.05)-.05)/.10,0,1);
  return null;
}
function dynamicMosProfile(r){
  const q=finite(r?.qualityScore),moat=finite(r?.moatScore),comp=finite(r?.compounderScore),
        fc=finite(r?.forecastConfidence??r?.forecastReliabilityScore??r?.forecastConfidenceScore),
        vc=finite(r?.valuationConfidence??r?.valuationConfidenceScore??r?.confidenceScore);
  const support=String(r?.modelSupport||'standard');
  if(support==='unsupported')return {tier:'Unsupported',requiredMOS:null,eligibleQuality:false};
  if(q!=null&&q>=80&&moat!=null&&moat>=75&&comp!=null&&comp>=75&&fc!=null&&fc>=60&&vc!=null&&vc>=65&&support!=='limited')
    return {tier:'Elite established compounder',requiredMOS:.05,eligibleQuality:true};
  if(q!=null&&q>=72&&moat!=null&&moat>=65&&comp!=null&&comp>=68&&fc!=null&&fc>=55&&vc!=null&&vc>=60&&support!=='limited')
    return {tier:'Strong established business',requiredMOS:.10,eligibleQuality:true};
  if(q!=null&&q>=58&&fc!=null&&fc>=50&&vc!=null&&vc>=55&&support!=='limited')
    return {tier:'Standard quality',requiredMOS:.20,eligibleQuality:true};
  if(fc!=null&&fc>=45&&vc!=null&&vc>=45)
    return {tier:'Higher uncertainty',requiredMOS:.25,eligibleQuality:true};
  return {tier:'Very high uncertainty',requiredMOS:.35,eligibleQuality:true};
}
function thesisEntryEligible(r,{minExpectedCAGR=.15,minAlpha=0,maxRank=25}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn),alpha=finite(r?.expectedAlpha),rank=finite(r?.rank??r?.overallRank),mos=finite(r?.marginOfSafety);
  const profile=dynamicMosProfile(r);
  return profile.eligibleQuality&&c!=null&&c>=minExpectedCAGR&&alpha!=null&&alpha>=minAlpha&&rank!=null&&rank<=maxRank&&mos!=null&&profile.requiredMOS!=null&&mos>=profile.requiredMOS&&String(r?.modelSupport||'')!=='unsupported';
}

function thesisTargetWeight(r,{maxInitialWeight=.10}={}){
  const rank=finite(r?.rank??r?.overallRank);
  if(rank==null)return null;
  const fc=finite(r?.forecastConfidence??r?.forecastReliabilityScore??r?.forecastConfidenceScore);
  const vc=finite(r?.valuationConfidence??r?.valuationConfidenceScore??r?.confidenceScore);
  const q=finite(r?.qualityScore);
  const pr=finite(r?.protectionScore??r?.downsideProtectionScore);
  let w=rank<=5?.10:rank<=10?.08:rank<=15?.06:rank<=20?.05:.03;
  const evidence=[fc,vc,q,pr].filter(Number.isFinite);
  const avg=evidence.length?mean(evidence):null;
  if(avg!=null&&avg>=85)w+=.01;
  else if(avg!=null&&avg<65)w-=.01;
  return Math.max(.02,Math.min(maxInitialWeight,w));
}

function isStrongWinnerMomentum(momentum){
  const stock3=finite(momentum?.stock3),rel6=finite(momentum?.rel6),rel12=finite(momentum?.rel12);
  return stock3!=null&&stock3>0&&rel6!=null&&rel6>0&&rel12!=null&&rel12>0&&(rel6>=.05||rel12>=.05);
}

function livePortfolioGuidance(r,momentum,{minExpectedCAGR=.15,maxRank=25,sellExpectedCAGR=.06,maxInitialWeight=.10}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn);
  const forecast=finite(r?.forecastConfidence??r?.forecastReliabilityScore??r?.forecastConfidenceScore);
  const supported=String(r?.modelSupport||'')!=='unsupported';
  const entryEligible=thesisEntryEligible(r,{minExpectedCAGR,maxRank});
  const rawSizingPoints=entryEligible?Math.max(4.5,4.5+4*clamp((finite(r?.expectedAlpha)??0)/.20,0,1)):null;
  const suggestedInitialWeight=null; // normalized across the selected Starter Portfolio after all stocks are ranked
  const strongMomentum=isStrongWinnerMomentum(momentum);

  let existingHolderAction='HOLD';
  let holderReason='Thesis remains intact; rank changes alone are not a sell signal.';
  if(!supported){
    existingHolderAction='REVIEW';
    holderReason='Model support is currently insufficient for an actionable portfolio decision.';
  }else if(forecast!=null&&forecast<40){
    existingHolderAction='ROTATION WATCH';
    holderReason='Forecast support is weak. This is not a thesis SELL by itself; review the holding against a genuinely eligible replacement before rotating capital.';
  }else if(c!=null&&c<sellExpectedCAGR){
    if(strongMomentum){
      existingHolderAction='RIDE WINNER';
      holderReason='Valuation is stretched, but 3M momentum is positive and the stock still leads SPY over both 6M and 12M windows.';
    }else{
      existingHolderAction='HOLD — VALUATION WATCH';
      holderReason='Expected CAGR is below 6%, but low expected return alone is not a thesis SELL. Hold unless the business thesis breaks; consider rotation only when a superior eligible opportunity exists.';
    }
  }

  const newPositionAction=entryEligible?'BUY':(!supported?'PASS':'WATCH'); 
  const portfolioAction=entryEligible?'BUY':existingHolderAction;
  return {
    entryEligible,newPositionAction,existingHolderAction,portfolioAction,
    suggestedInitialWeight,rawSizingPoints,strongMomentum,
    rules:{minExpectedCAGR,maxRank,sellExpectedCAGR,maxInitialWeight,dynamicMOS:dynamicMosProfile(r)},
    holderReason,
  };
}

module.exports={thesisEntryEligible,thesisTargetWeight,isStrongWinnerMomentum,livePortfolioGuidance,isValuationBuyRating,ratingAlphaSizingTarget,dynamicMosProfile};
