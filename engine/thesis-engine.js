'use strict';

function pct(x) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a'; }

function buildInvestmentThesis(stock, result) {
  const profile = stock.valuation?.businessProfile || {};
  const priceTarget = stock.valuation?.fiveYearPriceTarget || {};
  const breakdown = priceTarget.breakdown || {};
  const strengths = [];
  const risks = [];

  if ((profile.moatScore ?? 0) >= 0.70) strengths.push('Durable competitive advantages');
  if ((stock.pricingPowerScore ?? 0) >= 70) strengths.push('Strong pricing-power evidence');
  if ((stock.valuation?.capitalAllocation?.score ?? 0) >= 70) strengths.push('Disciplined capital allocation');
  if ((breakdown.revenueGrowth ?? 0) >= 0.08) strengths.push('Revenue growth is a major return driver');
  if ((breakdown.shareCountEffect ?? 0) >= 0.01) strengths.push('Buybacks improve per-share compounding');
  if ((stock.valuation?.methodAgreementScore ?? 100) < 55) risks.push('Valuation methods disagree materially');
  if ((stock.valuation?.sbcIntensity ?? 0) > 0.08) risks.push('Stock-based compensation is heavy');
  if ((result?.bearCAGR ?? 0) < 0) risks.push(`Bear-case CAGR is ${pct(result.bearCAGR)}`);
  if ((profile.forecastReliability ?? 1) < 0.55) risks.push('Forecast reliability is below average');
  if ((stock.valuation?.fiveYearPriceTarget?.breakdown?.multipleRerating ?? 0) > 0.08) risks.push('A meaningful portion of return depends on rerating');

  const primaryDriver = Object.entries({
    'revenue growth': breakdown.revenueGrowth,
    'margin expansion': breakdown.marginExpansion,
    'share-count change': breakdown.shareCountEffect,
    dividends: breakdown.dividendContribution,
    'multiple rerating': breakdown.multipleRerating,
  }).filter(([, v]) => Number.isFinite(v)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] || 'business compounding';

  return {
    summary: `${stock.ticker} is modeled to earn ${pct(result?.expectedCAGR)} annually, with ${primaryDriver} as the largest return driver.`,
    strengths: strengths.slice(0, 4),
    risks: risks.slice(0, 4),
    primaryDriver,
  };
}

module.exports = { buildInvestmentThesis };
