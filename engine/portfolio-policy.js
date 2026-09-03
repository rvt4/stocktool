'use strict';

function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}
function clamp(v,lo=0,hi=1){return Math.max(lo,Math.min(hi,v));}


// v12.50: the existing Valuation Rating is the buy-quality gate. Do not
// overwrite it with a second portfolio-specific rating system. The portfolio can
// only initiate a position when valuation says Buy / Strong Buy / Exceptional Buy.
function isValuationBuyRating(rating){
  return ['Buy','Strong Buy','Exceptional Buy'].includes(String(rating||''));
}

// Valuation Rating establishes the sizing band; Alpha decides where the stock
// sits inside that band. These are raw sizing points and are normalized across
// the selected Starter Portfolio so the final initial weights sum to 100%.
function ratingAlphaSizingTarget(r){
  const rating=String(r?.rating||'');
  const a=finite(r?.expectedAlpha);
  if(rating==='Exceptional Buy')return 8+2*clamp(((a??.15)-.15)/.20,0,1);
  if(rating==='Strong Buy')return 6+2*clamp(((a??.10)-.10)/.15,0,1);
  if(rating==='Buy')return 4.5+1.5*clamp(((a??.05)-.05)/.10,0,1);
  return null;
}

function thesisEntryEligible(r,{minExpectedCAGR=.20,minAlpha=.05,maxRank=25}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn);
  const alpha=finite(r?.expectedAlpha);
  const rank=finite(r?.rank??r?.overallRank);
  return isValuationBuyRating(r?.rating)&&c!=null&&c>=minExpectedCAGR&&alpha!=null&&alpha>=minAlpha&&rank!=null&&rank<=maxRank&&String(r?.modelSupport||'')!=='unsupported';
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
  const rawSizingPoints=entryEligible?ratingAlphaSizingTarget(r):null;
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

  const newPositionAction=entryEligible?'BUY':(!supported?'PASS':(isValuationBuyRating(r?.rating)?'WATCH':'PASS')); 
  const portfolioAction=entryEligible?'BUY':existingHolderAction;
  return {
    entryEligible,newPositionAction,existingHolderAction,portfolioAction,
    suggestedInitialWeight,rawSizingPoints,strongMomentum,
    rules:{minExpectedCAGR,maxRank,sellExpectedCAGR,maxInitialWeight},
    holderReason,
  };
}

module.exports={thesisEntryEligible,thesisTargetWeight,isStrongWinnerMomentum,livePortfolioGuidance,isValuationBuyRating,ratingAlphaSizingTarget};
