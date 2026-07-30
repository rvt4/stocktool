'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const BANDS = {
  Mature: [-0.10, 0.16],
  'Dividend Compounder': [-0.08, 0.17],
  Financial: [-0.15, 0.20],
  Utility: [-0.08, 0.15],
  'Asset Heavy': [-0.18, 0.20],
  Cyclical: [-0.22, 0.20],
  Turnaround: [-0.30, 0.25],
  Compounder: [-0.12, 0.22],
  'Elite Compounder': [-0.10, 0.24],
  Growth: [-0.20, 0.27],
  'Temporary Disruption': [-0.25, 0.26],
  'Hyper Growth': [-0.30, 0.30],
};

function assessReturnQuality({ stock, lifecycle, rawCAGR, fundamentalCAGR, multipleRerating, agreementScore, forecastPlausibility }) {
  const stage = lifecycle?.stage || 'Mature';
  const [floor, ceiling] = BANDS[stage] || BANDS.Mature;
  const confidence = clamp((agreementScore ?? 50) / 100, 0, 1);
  const plausibility = clamp((forecastPlausibility ?? 70) / 100, 0, 1);
  const marketCap = stock.valuation?.marketCap || 0;

  let adjustedCeiling = ceiling;
  if (marketCap >= 100e9) adjustedCeiling -= 0.015;
  if (marketCap >= 300e9) adjustedCeiling -= 0.015;
  if (marketCap >= 800e9) adjustedCeiling -= 0.015;

  // A low-growth mature business should not receive a 25-40% expected CAGR merely
  // because the model assumes its multiple fully normalizes.
  const operating = Number.isFinite(fundamentalCAGR) ? fundamentalCAGR : 0;
  const rerating = Number.isFinite(multipleRerating) ? multipleRerating : 0;
  const positiveReratingLimit = stage === 'Turnaround' ? 0.09
    : stage === 'Temporary Disruption' ? 0.07
      : ['Mature', 'Dividend Compounder', 'Financial', 'Utility', 'Asset Heavy', 'Cyclical'].includes(stage) ? 0.055
        : 0.075;
  const negativeReratingLimit = ['Growth', 'Hyper Growth', 'Elite Compounder', 'Temporary Disruption'].includes(stage) ? -0.12 : -0.16;

  // The amount of a valuation gap assumed to close is confidence-weighted. Cheap can
  // remain cheap, so weak method agreement must not manufacture a high return.
  const closureFactor = clamp(0.30 + confidence * 0.45 + plausibility * 0.20, 0.30, 0.92);
  const adjustedRerating = rerating >= 0
    ? Math.min(rerating * closureFactor, positiveReratingLimit)
    : Math.max(rerating, negativeReratingLimit);

  let adjusted = operating + adjustedRerating;
  adjusted = clamp(adjusted, floor, adjustedCeiling);

  const reratingShare = Math.abs(adjusted) > 1e-6 ? Math.abs(adjustedRerating / adjusted) : 0;
  let score = 100;
  score -= clamp(reratingShare - 0.25, 0, 1) * 55;
  score -= (1 - confidence) * 22;
  score -= (1 - plausibility) * 20;
  if (rawCAGR > adjustedCeiling + 0.05) score -= 10;
  if (stage === 'Cyclical' && rawCAGR > 0.18) score -= 8;
  score = Math.round(clamp(score, 15, 100));

  const flags = [];
  if (reratingShare > 0.50) flags.push('Expected return is dominated by valuation rerating');
  if (rawCAGR > adjustedCeiling + 0.03) flags.push('Raw CAGR exceeds lifecycle plausibility range');
  if (confidence < 0.55) flags.push('Low valuation-method agreement reduces rerating credit');
  if (plausibility < 0.60) flags.push('Forecast plausibility is below average');

  return {
    adjustedCAGR: adjusted,
    adjustedRerating,
    rawCAGR,
    operatingCAGR: operating,
    reratingShare,
    returnQualityScore: score,
    closureFactor,
    lifecycleBand: { floor, ceiling: adjustedCeiling },
    flags,
  };
}

module.exports = { assessReturnQuality };
