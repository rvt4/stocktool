'use strict';
const { clamp }=require('./config');
function requiredMOS(category,q){let m=category==='Hyper Growth'?.225:category==='Growth'?.175:category==='Dividend'?.15:category==='Compounder'?.12:.20;if((q.qualityScore||50)>=85&&(q.moatScore||50)>=80)m-=.02;if((q.confidenceScore||50)<60)m+=.025;return clamp(m,.10,.30);}
function rateStock(stock,forecast,quality,v){const c=v.expectedCAGR,mos=v.marginOfSafety,req=requiredMOS(forecast.category,quality),q=quality.qualityScore||0,conf=quality.confidenceScore||0,agreement=v.methodAgreementScore||0,methodCount=(v.methods||[]).length;let rating='Unrated';
  if(!Number.isFinite(c)||!Number.isFinite(mos))rating='Unrated';
  else if(c<0)rating='Sell';
  else if(c<.08)rating='Avoid';
  else if(c<.12||mos<=0)rating='Hold';
  else if(c>=.18&&mos>=.20&&q>=75&&conf>=65&&agreement>=60)rating='Exceptional Buy';
  else if(c>=.15&&mos>=req&&q>=65&&conf>=55&&agreement>=50)rating='Strong Buy';
  else if(c>=.12&&mos>0&&q>=50&&conf>=50)rating='Buy';
  else rating='Hold';
  // Very large positive modeled returns are published, but they cannot become a Buy
  // solely because a fragile valuation method produced an extreme outcome. Negative
  // extremes remain Sell: overvaluation is still actionable information.
  if(v.extremeReturnFlag && Number.isFinite(c) && c>.35) rating='Hold';
  // A lone non-financial fallback method is useful enough to keep a stock rated, but
  // not strong enough evidence for a top-tier buy label. Financials are intentionally
  // single-method because normalized EPS is their primary valuation framework.
  if(stock.sector!=='Financials'&&methodCount===1&&['Strong Buy','Exceptional Buy'].includes(rating))rating='Buy';
  const agreementFactor=clamp(agreement/100,.35,1);
  const investmentScore=Number.isFinite(c)?Math.round(clamp((.32*clamp((c+.02)/.24,0,1)*100+.18*clamp((mos+.05)/.40,0,1)*100+.27*q+.10*(quality.moatScore||50)+.13*conf)*(.88+.12*agreementFactor),0,100)):0;
  return {rating,requiredMOS:req,investmentScore,qualifiesForBuyList:['Buy','Strong Buy','Exceptional Buy'].includes(rating),expectedAlpha:Number.isFinite(c)?c-.10:null};}
module.exports={rateStock,requiredMOS};
