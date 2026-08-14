'use strict';
const { clamp } = require('./config');

function requiredMOS(category, q) {
  let m = category==='Hyper Growth'?0.225:category==='Growth'?0.175:category==='Dividend'?0.15:category==='Compounder'?0.12:0.20;
  if((q.qualityScore||50)>=85&&(q.moatScore||50)>=80)m-=0.02;
  if((q.confidenceScore||50)<60)m+=0.025;
  return clamp(m,0.10,0.30);
}
function rateStock(stock, forecast, quality, valuation) {
  const c=valuation.expectedCAGR, mos=valuation.marginOfSafety, reqMOS=requiredMOS(forecast.category,quality);
  const q=quality.qualityScore||0, conf=quality.confidenceScore||0;
  let rating='Unrated';
  if(!Number.isFinite(c)||!Number.isFinite(mos)) rating='Unrated';
  else if(c<0) rating='Sell';
  else if(c<0.07) rating='Avoid';
  else if(c<0.12 || mos<reqMOS || q<50 || conf<50) rating='Hold';
  else if(c>=0.20 && mos>=reqMOS+0.10 && q>=80 && conf>=70) rating='Exceptional Buy';
  else if(c>=0.16 && mos>=reqMOS+0.05 && q>=70 && conf>=60) rating='Strong Buy';
  else rating='Buy';

  const investmentScore=Math.round(clamp(
    0.28*clamp((c+0.02)/0.24,0,1)*100+
    0.20*clamp((mos+0.05)/0.45,0,1)*100+
    0.25*q+0.12*(quality.moatScore||50)+0.15*conf,0,100));
  return {rating,requiredMOS:reqMOS,investmentScore,qualifiesForBuyList:['Buy','Strong Buy','Exceptional Buy'].includes(rating),expectedAlpha:Number.isFinite(c)?c-0.10:null};
}
module.exports={rateStock,requiredMOS};
