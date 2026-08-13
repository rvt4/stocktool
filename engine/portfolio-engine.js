'use strict';
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function computePortfolioProfile(stock) {
  const quality = stock.valuation?.compounder?.score ?? stock.compounderBreakdown?.score ?? stock.businessQualityScore ?? 50;
  const confidence = stock.dataIntegrity?.score ?? stock.confidenceScore ?? 50;
  const protection = stock.valuation?.downside?.protectionScore ?? stock.downsideProtectionScore ?? 50;
  // V8: the institutional target return is the single canonical expected CAGR.
  const expected = stock.decisionExpectedReturn
    ?? stock.probabilityWeightedCAGR
    ?? stock.expectedReturn
    ?? stock.valuation?.scenarioAnalysis?.probabilityWeightedCAGR
    ?? stock.valuation?.returnEngineV2?.expectedCAGR
    ?? stock.valuation?.fiveYearPriceTarget?.cagr
    ?? stock.fiveYearPriceTarget?.cagr
    ?? null;
  const permanentLoss = stock.valuation?.downside?.permanentLossProbability ?? stock.permanentLossProbability ?? 0.25;
  const valuationAvailable = Number.isFinite(stock.valuation?.fairValueEstimate ?? stock.fairValueEstimate) && Number.isFinite(expected);
  const rating = stock.rating || null;
  const ratingEligible = ['Exceptional Buy','Strong Buy','Buy'].includes(rating);

  const conviction = Math.round(clamp(
    quality * 0.34 + confidence * 0.20 + protection * 0.24 +
    (Number.isFinite(expected) ? clamp((expected - 0.04) / 0.20 * 100, 0, 100) : 0) * 0.22,
    0, 100
  ));
  const riskBudget = clamp(1 - permanentLoss, 0.25, 0.95);
  const maxWeight = valuationAvailable && ratingEligible
    ? clamp((conviction / 100) * riskBudget * 0.12, 0.01, 0.10)
    : 0;
  const minWeight = maxWeight > 0 ? Math.max(0.01, maxWeight - 0.02) : 0;

  return {
    convictionScore: conviction,
    valuationAvailable,
    eligibleForModelPortfolio: valuationAvailable && ratingEligible && conviction >= 70 && expected >= 0.10 && permanentLoss <= 0.30,
    suggestedMinWeight: minWeight,
    suggestedMaxWeight: maxWeight,
    suggestedWeightRange: maxWeight > 0
      ? `${Math.round(minWeight * 100)}–${Math.round(maxWeight * 100)}%`
      : 'Unrated',
    positionTier: maxWeight >= 0.075 ? 'Core' : maxWeight >= 0.04 ? 'Standard' : maxWeight > 0 ? 'Starter' : 'Unrated',
    riskBudget,
    ratingEligible,
  };
}
module.exports = { computePortfolioProfile };
