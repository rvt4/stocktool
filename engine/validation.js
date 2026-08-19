'use strict';
const { HORIZON_YEARS } = require('./config');
function near(a,b,tol=0.0005){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol;}
function validateStock(s){
  const issues=[]; const p=Number(s.currentPrice), fut=Number(s.totalShareholderValue), c=Number(s.expectedReturn);
  if(p>0&&fut>0){const calc=Math.pow(fut/p,1/HORIZON_YEARS)-1;if(!near(calc,c))issues.push('canonical_return_math_mismatch');}
  if(Number.isFinite(s.bearCAGR)&&Number.isFinite(s.baseCAGR)&&s.bearCAGR>s.baseCAGR+1e-9)issues.push('bear_above_base');
  if(Number.isFinite(s.bullCAGR)&&Number.isFinite(s.baseCAGR)&&s.bullCAGR<s.baseCAGR-1e-9)issues.push('bull_below_base');
  if(Number.isFinite(s.fairValueEstimate)&&Number.isFinite(s.marginOfSafety)&&p>0){const calc=1-p/s.fairValueEstimate;if(!near(calc,s.marginOfSafety))issues.push('mos_math_mismatch');}
  if(['Buy','Strong Buy','Exceptional Buy'].includes(s.rating)&&(!Number.isFinite(c)||!Number.isFinite(s.marginOfSafety)))issues.push('buy_without_canonical_valuation');
  if(['Strong Buy','Exceptional Buy'].includes(s.rating)&&(s.independentMethodCount??0)<2)issues.push('high_conviction_without_independent_methods');
  if(s.rating==='Exceptional Buy'&&(s.independentMethodCount??0)<3)issues.push('exceptional_buy_without_three_evidence_families');
  if(['Buy','Strong Buy','Exceptional Buy'].includes(s.rating)&&s.modelSupport==='limited')issues.push('buy_on_limited_model_support');
  if(['Buy','Strong Buy','Exceptional Buy'].includes(s.rating)&&Number.isFinite(s.forecastReliabilityScore)&&s.forecastReliabilityScore<45)issues.push('buy_with_low_forecast_reliability');
  if(Number.isFinite(s.valuationConfidenceScore)&&s.methodCount===1&&s.valuationConfidenceScore>55)issues.push('single_method_confidence_too_high');
  if(['Buy','Strong Buy','Exceptional Buy'].includes(s.rating)&&Number.isFinite(s.methodAgreementScore)&&s.methodAgreementScore<35)issues.push('buy_with_material_method_disagreement');
  return issues;
}
function validateUniverse(stocks){const issues=[];for(const s of stocks){for(const type of validateStock(s))issues.push({ticker:s.ticker,type});}return{passed:issues.length===0,issues,checked:stocks.length};}
module.exports={validateStock,validateUniverse};
