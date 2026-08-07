'use strict';
function median(a) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function weighted(items) { const v = items.filter(x => x.value > 0 && x.weight > 0); const t = v.reduce((s, x) => s + x.weight, 0); return t ? v.reduce((s, x) => s + x.value * x.weight, 0) / t : null; }
function buildValuationConsensus(methods, agreementScore, effectiveWeights = {}) {
  const intrinsicKeys = ['dcf', 'dcfSBCAdjusted', 'ownerEarnings'];
  const marketKeys = ['revenueExit', 'epsExit', 'ebitdaExit'];
  // V61 structural rule: a method with zero effective weight has already failed the
  // business-model applicability gate. It must not re-enter through family medians,
  // consensus clamping, or dispersion diagnostics.
  const eligible = k => Number(effectiveWeights[k]) > 0 && Number(methods[k]) > 0;
  const intrinsicValues = intrinsicKeys.filter(eligible).map(k => methods[k]);
  const marketValues = marketKeys.filter(eligible).map(k => methods[k]);

  const intrinsicValue = weighted(intrinsicKeys.map(k => ({ value: methods[k], weight: effectiveWeights[k] || 0 }))) || median(intrinsicValues);
  const marketValue = weighted(marketKeys.map(k => ({ value: methods[k], weight: effectiveWeights[k] || 0 }))) || median(marketValues);

  let intrinsicWeight = .56;
  if (agreementScore < 20) intrinsicWeight = .68;
  else if (agreementScore < 40) intrinsicWeight = .63;
  else if (agreementScore < 60) intrinsicWeight = .59;
  else if (agreementScore > 80) intrinsicWeight = .52;
  if (!(intrinsicValue > 0)) intrinsicWeight = 0;
  if (!(marketValue > 0)) intrinsicWeight = 1;

  let actionableFairValue = intrinsicValue > 0 && marketValue > 0
    ? intrinsicValue * intrinsicWeight + marketValue * (1 - intrinsicWeight)
    : (intrinsicValue || marketValue || null);

  const allValues = [...intrinsicValues, ...marketValues].filter(v => v > 0);
  const center = median(allValues);
  let consensusWasClamped = false;
  if (center > 0 && actionableFairValue > center * 1.65) { actionableFairValue = center * 1.65; consensusWasClamped = true; }
  if (center > 0 && actionableFairValue < center * .60) { actionableFairValue = center * .60; consensusWasClamped = true; }

  return {
    intrinsicValue, marketValue, actionableFairValue, intrinsicWeight,
    marketWeight: 1 - intrinsicWeight, consensusWasClamped,
    eligibleMethods: Object.keys(effectiveWeights).filter(eligible),
    agreementRegime: agreementScore < 20 ? 'extreme-disagreement' : agreementScore < 40 ? 'large-disagreement' : agreementScore < 60 ? 'moderate-disagreement' : agreementScore < 80 ? 'normal' : 'high-agreement',
  };
}
module.exports = { buildValuationConsensus };
