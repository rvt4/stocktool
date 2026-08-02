'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function n(value, fallback = 50) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}
function grade(score) {
  return score >= 90 ? 'A+' : score >= 82 ? 'A' : score >= 74 ? 'B+' : score >= 66 ? 'B' : score >= 54 ? 'C' : 'D';
}
function vote(score, pass = 70, caution = 55) {
  return score >= pass ? 'yes' : score >= caution ? 'caution' : 'no';
}

/**
 * Five-member investment committee.
 *
 * Each member evaluates a distinct underwriting question. The aggregate score is
 * useful for ranking, but the vote pattern is deliberately retained so rating
 * logic can reject a stock that has one fatal weakness hidden by a high average.
 */
function computeInvestmentCommitteeScore(stock, scenario, growthQuality, capital, competition) {
  const expected = n(
    scenario?.expectedCAGR ?? scenario?.probabilityWeightedCAGR ??
    stock.valuation?.returnEngineV2?.expectedCAGR,
    0
  );
  const bear = n(scenario?.downsideCAGR, expected - .08);
  const rawConfidence = n(scenario?.probabilities?.confidence, n(stock.valuation?.lifecycle?.confidence, .5));
  const confidence = clamp(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence, 0, 100);
  const quality = clamp(n(stock.valuation?.economicQuality?.overall, n(stock.valuation?.compounder?.score, 50)), 0, 100);
  const moat = clamp(n(stock.valuation?.moat?.score, 50), 0, 100);
  const pricing = clamp(n(stock.valuation?.pricingPowerV2?.score, 50), 0, 100);
  const allocation = clamp(n(stock.valuation?.capitalAllocation?.score, n(stock.valuation?.capitalAllocation, 50)), 0, 100);
  const balance = clamp(n(stock.valuation?.businessProfile?.balanceSheetScore, n(stock.balanceSheetScore, 50)), 0, 100);
  const durability = clamp(n(
    competition?.score,
    n(stock.valuation?.lifecycle?.growthPersistenceScore, n(stock.valuation?.lifecycle?.compoundingPotential, 50))
  ), 0, 100);
  const agreement = clamp(n(stock.valuation?.methodAgreementScore, 50), 0, 100);
  const integrity = clamp(n(stock.dataIntegrity?.score, 65), 0, 100);
  const downsideProtection = clamp((bear + .12) / .20 * 100, 0, 100);

  const fv = n(stock.valuation?.intrinsicValue, n(stock.valuation?.blendedFairValue, n(stock.valuation?.fairValueEstimate, null)));
  const price = n(stock.price?.current, n(stock.price, null));
  const mos = fv > 0 && price > 0 ? (fv - price) / fv : 0;
  const valuation = clamp(45 + (expected - .10) * 180 + mos * 60 + (agreement - 50) * .20, 0, 100);
  const growth = clamp(n(growthQuality?.score, 50) * .55 + durability * .30 + clamp((expected - .06) / .18 * 100, 0, 100) * .15, 0, 100);
  const risk = clamp(downsideProtection * .40 + balance * .25 + integrity * .20 + confidence * .15, 0, 100);
  const business = clamp(quality * .50 + moat * .25 + pricing * .15 + durability * .10, 0, 100);
  const capitalAllocation = clamp(allocation * .75 + balance * .15 + integrity * .10, 0, 100);

  const members = {
    businessQuality: { score: Math.round(business), vote: vote(business), question: 'Would we want to own this business through a full cycle?' },
    growthDurability: { score: Math.round(growth), vote: vote(growth), question: 'Can per-share value compound at an attractive rate for long enough?' },
    valuation: { score: Math.round(valuation), vote: vote(valuation), question: 'Does today’s price offer an adequate return with corroborated valuation evidence?' },
    risk: { score: Math.round(risk), vote: vote(risk), question: 'Is permanent impairment risk acceptably controlled?' },
    capitalAllocation: { score: Math.round(capitalAllocation), vote: vote(capitalAllocation), question: 'Does management allocate capital for per-share value creation?' },
  };

  const memberValues = Object.values(members);
  const yesVotes = memberValues.filter(x => x.vote === 'yes').length;
  const cautionVotes = memberValues.filter(x => x.vote === 'caution').length;
  const noVotes = memberValues.filter(x => x.vote === 'no').length;
  const fatalNo = members.valuation.vote === 'no' || members.risk.vote === 'no';
  const score = Math.round(clamp(
    business * .27 + growth * .20 + valuation * .24 + risk * .18 + capitalAllocation * .11,
    0, 100
  ));

  return {
    version: 'investment-committee-v2-five-vote',
    score,
    grade: grade(score),
    yesVotes,
    cautionVotes,
    noVotes,
    fatalNo,
    unanimous: yesVotes === 5,
    members,
    components: {
      businessQuality: Math.round(business), growthDurability: Math.round(growth),
      valuation: Math.round(valuation), risk: Math.round(risk), capitalAllocation: Math.round(capitalAllocation),
      moat, pricingPower: pricing, confidence: Math.round(confidence), agreement,
      downsideProtection: Math.round(downsideProtection), integrity, balanceSheet: balance,
    },
  };
}

module.exports = { computeInvestmentCommitteeScore };
