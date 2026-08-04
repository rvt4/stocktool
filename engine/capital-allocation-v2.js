'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));
const clean = a => (a || []).filter(finite).map(Number);
const mean = a => { const c = clean(a); return c.length ? c.reduce((s, x) => s + x, 0) / c.length : null; };
const median = a => { const c = clean(a).sort((a, b) => a - b); if (!c.length) return null; const m = Math.floor(c.length / 2); return c.length % 2 ? c[m] : (c[m - 1] + c[m]) / 2; };
const cagr = (a, b, n) => a > 0 && b > 0 && n > 0 ? Math.pow(b / a, 1 / n) - 1 : null;
const higher = (v, poor, strong) => finite(v) ? clamp((Number(v) - poor) / (strong - poor) * 100, 0, 100) : null;
const lower = (v, strong, poor) => finite(v) ? clamp((poor - Number(v)) / (poor - strong) * 100, 0, 100) : null;

function weightedNeutral(components) {
  let evidenceWeight = 0;
  let weighted = 0;
  let maxWeight = 0;
  for (const c of components) {
    maxWeight += c.weight;
    const evidence = clamp(Number(c.evidence ?? (finite(c.score) ? 1 : 0)), 0, 1);
    const score = finite(c.score) ? Number(c.score) : 50;
    weighted += c.weight * (50 + (score - 50) * evidence);
    evidenceWeight += c.weight * evidence;
  }
  return {
    score: maxWeight ? weighted / maxWeight : 50,
    evidence: maxWeight ? evidenceWeight / maxWeight : 0,
  };
}

function series(years, field, positiveOnly = false) {
  return years.map(y => Number(y?.[field])).filter(v => finite(v) && (!positiveOnly || v > 0));
}

function computeCapitalAllocationV2(stock) {
  const years = (stock.financials?.years || []).slice(-7);
  const last = years.at(-1) || {};

  // 1) Reinvestment efficiency: use level and trend of the improved ROIC estimate.
  const roics = series(years, 'roic').filter(v => v > -0.5 && v < 2);
  const recentRoic = median(roics.slice(-3));
  const earlyRoic = median(roics.slice(0, Math.max(1, roics.length - 3)));
  const roicTrend = finite(recentRoic) && finite(earlyRoic) ? recentRoic - earlyRoic : null;
  const roicLevelScore = higher(recentRoic, .04, .25);
  const roicTrendScore = higher(roicTrend, -.06, .06);
  const reinvestment = weightedNeutral([
    { score: roicLevelScore, weight: .72, evidence: Math.min(roics.length / 3, 1) },
    { score: roicTrendScore, weight: .28, evidence: roics.length >= 4 ? 1 : 0 },
  ]);

  // 2) Per-share discipline: actual share-count trend is the primary signal;
  // repurchase/issuance cash flows refine it when SEC facts are available.
  const shares = series(years, 'sharesOutTTM', true);
  const shareCagr = shares.length >= 2 ? cagr(shares[0], shares.at(-1), shares.length - 1) : null;
  const dilutionScore = lower(shareCagr, -.04, .06);
  const repurchases = series(years, 'shareRepurchases');
  const issuances = series(years, 'shareIssuanceProceeds');
  const fcf = series(years, 'fcf');
  const repurchaseToFcf = repurchases.length && fcf.length
    ? median(years.map(y => finite(y.fcf) && Number(y.fcf) > 0 && finite(y.shareRepurchases)
      ? Number(y.shareRepurchases) / Number(y.fcf) : null))
    : null;
  const issuanceToFcf = issuances.length && fcf.length
    ? median(years.map(y => finite(y.fcf) && Number(y.fcf) > 0 && finite(y.shareIssuanceProceeds)
      ? Number(y.shareIssuanceProceeds) / Number(y.fcf) : null))
    : null;
  const netCashReturnScore = finite(repurchaseToFcf) || finite(issuanceToFcf)
    ? clamp(50 + (Number(repurchaseToFcf || 0) - Number(issuanceToFcf || 0)) * 65, 0, 100)
    : null;
  const perShare = weightedNeutral([
    { score: dilutionScore, weight: .75, evidence: shares.length >= 3 ? 1 : shares.length >= 2 ? .65 : 0 },
    { score: netCashReturnScore, weight: .25, evidence: finite(netCashReturnScore) ? .8 : 0 },
  ]);

  // 3) Balance-sheet and acquisition discipline.
  const debts = years.map(y => finite(y.totalDebt) ? Number(y.totalDebt)
    : (finite(y.longTermDebt) || finite(y.shortTermDebt))
      ? Number(y.longTermDebt || 0) + Number(y.shortTermDebt || 0) : null).filter(finite);
  const debtTrend = debts.length >= 2 && Math.abs(debts[0]) > 0
    ? (debts.at(-1) - debts[0]) / Math.abs(debts[0]) : null;
  const latestDebtToFcf = finite(last.totalDebt) && Number(last.fcf) > 0
    ? Number(last.totalDebt) / Number(last.fcf)
    : finite(last.longTermDebt) && Number(last.fcf) > 0
      ? Number(last.longTermDebt) / Number(last.fcf) : null;
  const debtTrendScore = lower(debtTrend, -.35, 1.0);
  const leverageScore = lower(latestDebtToFcf, 0.5, 6.0);
  const acquisitionToFcf = median(years.map(y => finite(y.acquisitions) && Number(y.fcf) > 0
    ? Number(y.acquisitions) / Number(y.fcf) : null));
  // Acquisition spending itself is not bad; only very large recurring spending gets
  // a mild penalty because free SEC data cannot judge deal quality directly.
  const acquisitionDiscipline = finite(acquisitionToFcf) ? lower(acquisitionToFcf, 0, 2.5) : null;
  const balance = weightedNeutral([
    { score: debtTrendScore, weight: .42, evidence: finite(debtTrendScore) ? .85 : 0 },
    { score: leverageScore, weight: .43, evidence: finite(leverageScore) ? .9 : 0 },
    { score: acquisitionDiscipline, weight: .15, evidence: finite(acquisitionDiscipline) ? .45 : 0 },
  ]);

  // 4) Cash-return discipline: sustainable distributions, not simply high payouts.
  const positiveFcfRate = years.length ? years.filter(y => Number(y.fcf) > 0).length / years.length : null;
  const dividendsToFcf = median(years.map(y => finite(y.dividendsPaid) && Number(y.fcf) > 0
    ? Number(y.dividendsPaid) / Number(y.fcf) : null));
  const payoutScore = finite(dividendsToFcf)
    ? dividendsToFcf <= .75 ? clamp(70 + dividendsToFcf * 20, 0, 90)
      : clamp(90 - (dividendsToFcf - .75) * 120, 0, 90)
    : null;
  const fcfConsistencyScore = higher(positiveFcfRate, .35, 1);
  const cashReturn = weightedNeutral([
    { score: fcfConsistencyScore, weight: .62, evidence: years.length >= 4 ? 1 : years.length / 4 },
    { score: payoutScore, weight: .38, evidence: finite(payoutScore) ? .65 : 0 },
  ]);

  const overall = weightedNeutral([
    { score: reinvestment.score, weight: .35, evidence: reinvestment.evidence },
    { score: perShare.score, weight: .30, evidence: perShare.evidence },
    { score: balance.score, weight: .20, evidence: balance.evidence },
    { score: cashReturn.score, weight: .15, evidence: cashReturn.evidence },
  ]);

  // Sparse data should regress toward neutral rather than collapse to a low score.
  const score = Math.round(clamp(50 + (overall.score - 50) * clamp(.45 + overall.evidence * .75, .45, 1), 0, 100));
  const evidenceScore = Math.round(clamp(overall.evidence * 100, 0, 100));

  const signals = [];
  const flags = [];
  if (finite(recentRoic) && recentRoic >= .20) signals.push('High returns on invested capital');
  if (finite(roicTrend) && roicTrend >= .03) signals.push('ROIC is improving');
  if (finite(shareCagr) && shareCagr <= -.01) signals.push('Share count is shrinking');
  if (finite(debtTrend) && debtTrend <= -.20) signals.push('Debt has declined materially');
  if (finite(shareCagr) && shareCagr > .035) flags.push('Persistent share dilution');
  if (finite(roicTrend) && roicTrend < -.04) flags.push('ROIC has deteriorated');
  if (finite(debtTrend) && debtTrend > .75) flags.push('Debt increased materially');
  if (finite(latestDebtToFcf) && latestDebtToFcf > 6) flags.push('Leverage is high relative to free cash flow');
  if (evidenceScore < 45) flags.push('Limited capital-allocation evidence');

  return {
    version: 'capital-allocation-v3',
    score,
    evidenceScore,
    grade: score >= 85 ? 'Exceptional' : score >= 70 ? 'Strong' : score >= 55 ? 'Above Average' : score >= 40 ? 'Mixed' : score >= 25 ? 'Weak' : 'Destructive',
    reinvestmentScore: Math.round(reinvestment.score),
    perShareDiscipline: Math.round(perShare.score),
    buybackQuality: Math.round(perShare.score),
    debtDiscipline: Math.round(balance.score),
    cashDiscipline: Math.round(cashReturn.score),
    annualDilution: shareCagr,
    recentRoic,
    incrementalRoic: roicTrend,
    debtTrend,
    debtToFcf: latestDebtToFcf,
    repurchaseToFcf,
    dividendsToFcf,
    acquisitionToFcf,
    signals,
    flags,
  };
}

module.exports = { computeCapitalAllocationV2 };
