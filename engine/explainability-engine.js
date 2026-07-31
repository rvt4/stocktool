'use strict';
function fmtPct(x){return Number.isFinite(Number(x))?`${(Number(x)*100).toFixed(1)}%`:'n/a';}
function buildDecisionExplanation(stock, c, p, capital) {
  const positives=[], negatives=[];
  if(c.quality>=82) positives.push(`Exceptional economic quality (${c.quality}/100)`); else if(c.quality>=72) positives.push(`Strong economic quality (${c.quality}/100)`); else if(c.quality<58) negatives.push(`Below-average economic quality (${c.quality}/100)`);
  if(c.growth>=75) positives.push(`High-quality per-share growth (${c.growth}/100)`); else if(c.growth<45) negatives.push(`Weak or low-quality growth (${c.growth}/100)`);
  if(c.valuation>=72) positives.push(`Attractive valuation (${c.valuation}/100)`); else if(c.valuation<40) negatives.push(`Valuation is demanding (${c.valuation}/100)`);
  if(capital.score>=75) positives.push(`Strong capital allocation (${capital.score}/100)`); else if(capital.score<45) negatives.push(`Capital allocation concerns (${capital.score}/100)`);
  if(c.risk<=35) positives.push(`Low modeled downside risk (${c.risk}/100)`); else if(c.risk>=65) negatives.push(`Elevated downside risk (${c.risk}/100)`);
  if(c.confidence>=78) positives.push(`High evidence confidence (${c.confidence}/100)`); else if(c.confidence<55) negatives.push(`Limited forecast confidence (${c.confidence}/100)`);
  if(p.pBeat15Cagr>=.65) positives.push(`${fmtPct(p.pBeat15Cagr)} modeled probability of beating 15% CAGR`); else if(p.pBeat15Cagr<.35) negatives.push(`Only ${fmtPct(p.pBeat15Cagr)} modeled probability of beating 15% CAGR`);
  return {version:'decision-explanation-v1',summary:`${stock.rating}: ${stock.ratingReason}`,strengths:positives.slice(0,5),risks:negatives.concat(capital.flags||[]).slice(0,5),keyMetrics:{expectedCAGR:stock.expectedReturn,marginOfSafety:stock.marginOfSafety,pBeat15Cagr:p.pBeat15Cagr,pPermanentLoss:p.pPermanentLoss}};
}
module.exports={buildDecisionExplanation};
