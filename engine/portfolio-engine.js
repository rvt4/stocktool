'use strict';
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function computePortfolioProfile(stock) {
  const quality = stock.valuation?.compounder?.score ?? 50;
  const confidence = stock.dataIntegrity?.score ?? 50;
  const protection = stock.valuation?.downside?.protectionScore ?? 50;
  const expected = stock.valuation?.expectedReturnProfile?.riskAdjustedCAGR;
  const permanentLoss = stock.valuation?.downside?.permanentLossProbability ?? 0.25;
  const valuationAvailable = Number.isFinite(stock.valuation?.fairValueEstimate) && Number.isFinite(expected);

  const conviction = Math.round(clamp(
    quality * 0.34 + confidence * 0.20 + protection * 0.24 +
    (Number.isFinite(expected) ? clamp((expected - 0.04) / 0.20 * 100, 0, 100) : 0) * 0.22,
    0, 100
  ));
  const riskBudget = clamp(1 - permanentLoss, 0.25, 0.95);
  const maxWeight = valuationAvailable
    ? clamp((conviction / 100) * riskBudget * 0.12, 0.01, 0.10)
    : 0;

  return {
    convictionScore: conviction,
    valuationAvailable,
    eligibleForModelPortfolio: valuationAvailable && conviction >= 70 && expected >= 0.10 && permanentLoss <= 0.30,
    suggestedMaxWeight: maxWeight,
    positionTier: maxWeight >= 0.075 ? 'Core' : maxWeight >= 0.04 ? 'Standard' : maxWeight > 0 ? 'Starter' : 'Unrated',
    riskBudget,
  };
}
module.exports = { computePortfolioProfile };
