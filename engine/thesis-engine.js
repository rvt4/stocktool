'use strict';

function pct(x) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a'; }

function buildInvestmentThesis(stock, result) {
  const profile = stock.valuation?.businessProfile || {};
  const priceTarget = stock.valuation?.fiveYearPriceTarget || {};
  const breakdown = priceTarget.breakdown || stock.valuation?.returnEngineV2?.breakdown || {};
  const strengths = [];
  const risks = [];

  if ((profile.moatScore ?? 0) >= 0.70) strengths.push('Durable competitive advantages');
  if ((stock.valuation?.pricingPowerV2?.score ?? stock.pricingPowerScore ?? 0) >= 70) strengths.push('Strong pricing power');
  if ((stock.valuation?.capitalAllocation?.score ?? 0) >= 70) strengths.push('Disciplined capital allocation');
  if ((stock.valuation?.compounder?.score ?? 0) >= 75) strengths.push('High-quality long-term compounding profile');
  if ((breakdown.revenueGrowth ?? 0) >= 0.08) strengths.push('Revenue growth is a meaningful return driver');
  if ((breakdown.shareCountEffect ?? 0) >= 0.01) strengths.push('Buybacks support per-share growth');
  if ((stock.valuation?.downside?.protectionScore ?? 0) >= 70) strengths.push('Above-average downside protection');

  if ((stock.valuation?.methodAgreementScore ?? 100) < 55) risks.push('Valuation methods disagree materially');
  if ((stock.valuation?.sbcIntensity ?? 0) > 0.08) risks.push('Stock-based compensation is elevated');
  if ((result?.bearCAGR ?? stock.valuation?.scenarioAnalysis?.bearCAGR ?? 0) < 0) risks.push(`Bear-case CAGR is ${pct(result?.bearCAGR ?? stock.valuation?.scenarioAnalysis?.bearCAGR)}`);
  if ((profile.forecastReliability ?? 1) < 0.55) risks.push('Forecast reliability is below average');
  if ((breakdown.multipleRerating ?? 0) > 0.08) risks.push('A meaningful portion of return depends on multiple rerating');
  if ((stock.valuation?.downside?.permanentLossProbability ?? 0) > 0.30) risks.push('Modeled permanent-loss risk is elevated');

  const primaryDriver = Object.entries({
    'revenue growth': breakdown.revenueGrowth,
    'margin expansion': breakdown.marginExpansion,
    'share-count change': breakdown.shareCountEffect,
    dividends: breakdown.dividendContribution,
    'multiple rerating': breakdown.multipleRerating,
  }).filter(([, v]) => Number.isFinite(v)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] || 'business compounding';

  const expected = stock.valuation?.returnEngineV2?.expectedCAGR ?? result?.expectedCAGR;
  return {
    summary: `${stock.ticker} is modeled to earn ${pct(expected)} annually, with ${primaryDriver} as the largest return driver.`,
    strengths: strengths.slice(0, 5),
    risks: risks.slice(0, 5),
    primaryDriver,
  };
}

module.exports = { buildInvestmentThesis };
