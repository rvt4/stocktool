'use strict';

function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}
function clamp(v,lo=0,hi=1){return Math.max(lo,Math.min(hi,v));}


// v12.49 owner-facing buy rating. The owner entry rule (rank + Alpha/CAGR +
// model support) is the gate; ratings tier conviction only inside that eligible set.
// Therefore every stock proposed for a new long-term position is at least Buy.
function ownerEntryRating(r,{minExpectedCAGR=.20,minAlpha=.05,maxRank=25}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn),alpha=finite(r?.expectedAlpha),rank=finite(r?.rank??r?.overallRank);
  const support=String(r?.modelSupport||'standard');
  const q=finite(r?.qualityScore),fc=finite(r?.forecastConfidence??r?.forecastReliabilityScore??r?.forecastConfidenceScore),vc=finite(r?.valuationConfidence??r?.valuationConfidenceScore??r?.confidenceScore);
  // A new-money Buy must also clear the existing forecast-reliability safety invariant.
  // This keeps Starter Portfolio membership and Buy+ ratings internally consistent.
  const eligible=c!=null&&c>=minExpectedCAGR&&alpha!=null&&alpha>=minAlpha&&rank!=null&&rank<=maxRank&&support!=='unsupported'&&fc!=null&&fc>=45;
  if(!eligible)return null;
  const evidenceCanUpgrade=support!=='limited'&&(fc==null||fc>=45)&&(vc==null||vc>=45);
  if(evidenceCanUpgrade&&rank<=5&&alpha>=.15&&(q==null||q>=75)&&(fc==null||fc>=60)&&(vc==null||vc>=60))return 'Exceptional Buy';
  if(evidenceCanUpgrade&&rank<=15&&alpha>=.10&&(q==null||q>=65)&&(fc==null||fc>=50)&&(vc==null||vc>=50))return 'Strong Buy';
  return 'Buy';
}
function applyOwnerEntryRating(r,opts={}){
  const rating=ownerEntryRating(r,opts);if(!rating)return r;
  r.rating=rating;r.qualifiesForBuyList=true;r.ownerEntryRating=rating;return r;
}
// Rating establishes the sizing band; Alpha determines where the stock sits inside
// that band. This remains a challenger until the historical weighting lab is reviewed.
function ratingAlphaSizingTarget(r){
  const rating=String(r?.ownerEntryRating||r?.rating||'Buy'),a=finite(r?.expectedAlpha);
  if(rating==='Exceptional Buy')return 8+2*clamp(((a??.15)-.15)/.20,0,1);
  if(rating==='Strong Buy')return 6+2*clamp(((a??.10)-.10)/.15,0,1);
  return 4.5+1.5*clamp(((a??.05)-.05)/.10,0,1);
}

function thesisEntryEligible(r,{minExpectedCAGR=.20,minAlpha=.05,maxRank=25,minForecastReliability=45}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn);
  const alpha=finite(r?.expectedAlpha);
  const rank=finite(r?.rank??r?.overallRank);
  const fc=finite(r?.forecastConfidence??r?.forecastReliabilityScore??r?.forecastConfidenceScore);
  return c!=null&&c>=minExpectedCAGR&&alpha!=null&&alpha>=minAlpha&&rank!=null&&rank<=maxRank&&fc!=null&&fc>=minForecastReliability&&String(r?.modelSupport||'')!=='unsupported';
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

function livePortfolioGuidance(r,momentum,{minExpectedCAGR=.20,maxRank=25,sellExpectedCAGR=.06,maxInitialWeight=.10}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn);
  const forecast=finite(r?.forecastConfidence??r?.forecastReliabilityScore??r?.forecastConfidenceScore);
  const supported=String(r?.modelSupport||'')!=='unsupported';
  const entryEligible=thesisEntryEligible(r,{minExpectedCAGR,maxRank});
  const suggestedInitialWeight=entryEligible?thesisTargetWeight(r,{maxInitialWeight}):null;
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

  const newPositionAction=entryEligible?'BUY':(!supported?'PASS':(c!=null&&c>=minExpectedCAGR?'WATCH':'PASS'));
  const portfolioAction=entryEligible?'BUY':existingHolderAction;
  return {
    entryEligible,newPositionAction,existingHolderAction,portfolioAction,
    suggestedInitialWeight,strongMomentum,
    rules:{minExpectedCAGR,maxRank,sellExpectedCAGR,maxInitialWeight},
    holderReason,
  };
}

module.exports={thesisEntryEligible,thesisTargetWeight,isStrongWinnerMomentum,livePortfolioGuidance,ownerEntryRating,applyOwnerEntryRating,ratingAlphaSizingTarget};
