'use strict';

function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}

function thesisEntryEligible(r,{minExpectedCAGR=.15,maxRank=25}={}){
  const c=finite(r?.expectedCAGR??r?.expectedReturn);
  const rank=finite(r?.rank??r?.overallRank);
  return c!=null&&c>=minExpectedCAGR&&rank!=null&&rank<=maxRank&&String(r?.modelSupport||'')!=='unsupported';
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

module.exports={thesisEntryEligible,thesisTargetWeight,isStrongWinnerMomentum,livePortfolioGuidance};
