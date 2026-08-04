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

  // Capital allocation must remain useful even when newer SEC cash-flow tags are
  // unavailable. Use direct evidence where present, then fall back to high-coverage
  // per-share, profitability, cash-flow and balance-sheet evidence.
  const revenues = series(years, 'revenue', true);
  const fcfs = series(years, 'fcf');
  const incomes = series(years, 'netIncome');
  const opIncome = series(years, 'operatingIncome');
  const shares = series(years, 'sharesOutTTM', true);

  const roics = series(years, 'roic').filter(v => v > -0.5 && v < 2);
  const explicitRecentRoic = median(roics.slice(-3));
  const explicitEarlyRoic = median(roics.slice(0, Math.max(1, roics.length - 3)));

  // Fallback return-on-capital proxy: after-tax operating margin combined with
  // asset efficiency / FCF conversion. It is not labelled ROIC in the audit, but
  // it prevents every company from receiving the same neutral score when SEC
  // invested-capital facts are sparse.
  const marginSeries = years.map(y => Number(y.revenue) > 0 && finite(y.operatingIncome)
    ? Number(y.operatingIncome) / Number(y.revenue) : null).filter(finite);
  const fcfMarginSeries = years.map(y => Number(y.revenue) > 0 && finite(y.fcf)
    ? Number(y.fcf) / Number(y.revenue) : null).filter(finite);
  const recentMargin = median(marginSeries.slice(-3));
  const earlyMargin = median(marginSeries.slice(0, Math.max(1, marginSeries.length - 3)));
  const marginTrend = finite(recentMargin) && finite(earlyMargin) ? recentMargin - earlyMargin : null;
  const recentFcfMargin = median(fcfMarginSeries.slice(-3));
  const fallbackReturnScore = weightedNeutral([
    { score: higher(recentMargin, .04, .32), weight: .55, evidence: marginSeries.length >= 3 ? .75 : .4 },
    { score: higher(recentFcfMargin, .02, .25), weight: .30, evidence: fcfMarginSeries.length >= 3 ? .75 : .4 },
    { score: higher(marginTrend, -.05, .05), weight: .15, evidence: marginSeries.length >= 4 ? .65 : 0 },
  ]);

  const recentRoic = finite(explicitRecentRoic) ? explicitRecentRoic : null;
  const roicTrend = finite(explicitRecentRoic) && finite(explicitEarlyRoic)
    ? explicitRecentRoic - explicitEarlyRoic : null;
  const reinvestment = weightedNeutral([
    { score: higher(recentRoic, .04, .25), weight: .62, evidence: Math.min(roics.length / 3, 1) },
    { score: higher(roicTrend, -.06, .06), weight: .18, evidence: roics.length >= 4 ? 1 : 0 },
    { score: fallbackReturnScore.score, weight: .20, evidence: fallbackReturnScore.evidence },
  ]);

  // Per-share discipline. Share-count trend is deliberately dominant because it
  // is broadly available and captures the net result of SBC, issuance and buybacks.
  const shareCagr = shares.length >= 2 ? cagr(shares[0], shares.at(-1), shares.length - 1) : null;
  const dilutionScore = lower(shareCagr, -.04, .06);
  const sbcIntensity = Number(last.revenue) > 0 && finite(last.sbc)
    ? Number(last.sbc) / Number(last.revenue) : null;
  const sbcScore = lower(sbcIntensity, .005, .10);
  const repurchaseToFcf = median(years.map(y => Number(y.fcf) > 0 && finite(y.shareRepurchases)
    ? Math.abs(Number(y.shareRepurchases)) / Number(y.fcf) : null));
  const issuanceToFcf = median(years.map(y => Number(y.fcf) > 0 && finite(y.shareIssuanceProceeds)
    ? Math.abs(Number(y.shareIssuanceProceeds)) / Number(y.fcf) : null));
  const netCashReturnScore = finite(repurchaseToFcf) || finite(issuanceToFcf)
    ? clamp(50 + (Number(repurchaseToFcf || 0) - Number(issuanceToFcf || 0)) * 55, 0, 100)
    : null;
  const perShare = weightedNeutral([
    { score: dilutionScore, weight: .62, evidence: shares.length >= 3 ? 1 : shares.length >= 2 ? .65 : 0 },
    { score: sbcScore, weight: .23, evidence: finite(sbcScore) ? .75 : 0 },
    { score: netCashReturnScore, weight: .15, evidence: finite(netCashReturnScore) ? .75 : 0 },
  ]);

  // Balance-sheet and acquisition discipline.
  const debts = years.map(y => finite(y.totalDebt) ? Number(y.totalDebt)
    : (finite(y.longTermDebt) || finite(y.shortTermDebt))
      ? Number(y.longTermDebt || 0) + Number(y.shortTermDebt || 0) : null).filter(finite);
  const debtTrend = debts.length >= 2 && Math.abs(debts[0]) > 0
    ? (debts.at(-1) - debts[0]) / Math.abs(debts[0]) : null;
  const latestDebt = finite(last.totalDebt) ? Number(last.totalDebt)
    : finite(last.longTermDebt) || finite(last.shortTermDebt)
      ? Number(last.longTermDebt || 0) + Number(last.shortTermDebt || 0) : null;
  const latestDebtToFcf = finite(latestDebt) && Number(last.fcf) > 0
    ? latestDebt / Number(last.fcf) : null;
  const debtTrendScore = lower(debtTrend, -.35, 1.0);
  const leverageScore = lower(latestDebtToFcf, 0.5, 6.0);
  const acquisitionToFcf = median(years.map(y => Number(y.fcf) > 0 && finite(y.acquisitions)
    ? Math.abs(Number(y.acquisitions)) / Number(y.fcf) : null));
  const acquisitionDiscipline = finite(acquisitionToFcf) ? lower(acquisitionToFcf, 0, 2.5) : null;
  const balance = weightedNeutral([
    { score: debtTrendScore, weight: .40, evidence: finite(debtTrendScore) ? .85 : 0 },
    { score: leverageScore, weight: .45, evidence: finite(leverageScore) ? .90 : 0 },
    { score: acquisitionDiscipline, weight: .15, evidence: finite(acquisitionDiscipline) ? .45 : 0 },
  ]);

  // Cash discipline: reward repeatable FCF and sensible conversion, not simply a
  // high dividend payout. This also differentiates non-dividend compounders.
  const positiveFcfRate = years.length ? years.filter(y => Number(y.fcf) > 0).length / years.length : null;
  const fcfConversion = median(years.map(y => Number(y.netIncome) > 0 && finite(y.fcf)
    ? Number(y.fcf) / Number(y.netIncome) : null));
  const conversionScore = finite(fcfConversion)
    ? clamp(100 - Math.abs(clamp(fcfConversion, -1, 3) - 1) * 55, 0, 100) : null;
  const dividendsToFcf = median(years.map(y => Number(y.fcf) > 0 && finite(y.dividendsPaid)
    ? Math.abs(Number(y.dividendsPaid)) / Number(y.fcf) : null));
  const payoutScore = finite(dividendsToFcf)
    ? dividendsToFcf <= .75 ? clamp(65 + dividendsToFcf * 25, 0, 90)
      : clamp(90 - (dividendsToFcf - .75) * 120, 0, 90)
    : null;
  const cashReturn = weightedNeutral([
    { score: higher(positiveFcfRate, .35, 1), weight: .50, evidence: years.length >= 4 ? 1 : years.length / 4 },
    { score: conversionScore, weight: .35, evidence: finite(conversionScore) ? .75 : 0 },
    { score: payoutScore, weight: .15, evidence: finite(payoutScore) ? .60 : 0 },
  ]);

  const overall = weightedNeutral([
    { score: reinvestment.score, weight: .35, evidence: reinvestment.evidence },
    { score: perShare.score, weight: .30, evidence: perShare.evidence },
    { score: balance.score, weight: .20, evidence: balance.evidence },
    { score: cashReturn.score, weight: .15, evidence: cashReturn.evidence },
  ]);

  // Use evidence to control confidence, not to collapse every result to 50. Even
  // sparse records retain a meaningful spread from high-coverage fallback signals.
  const evidenceMultiplier = clamp(.70 + overall.evidence * .45, .70, 1.08);
  const score = Math.round(clamp(50 + (overall.score - 50) * evidenceMultiplier, 0, 100));
  const evidenceScore = Math.round(clamp(overall.evidence * 100, 0, 100));

  const signals = [];
  const flags = [];
  if (finite(recentRoic) && recentRoic >= .20) signals.push('High returns on invested capital');
  else if (fallbackReturnScore.score >= 75) signals.push('Strong operating and cash-return economics');
  if ((finite(roicTrend) && roicTrend >= .03) || (finite(marginTrend) && marginTrend >= .025)) signals.push('Reinvestment economics are improving');
  if (finite(shareCagr) && shareCagr <= -.01) signals.push('Share count is shrinking');
  if (finite(debtTrend) && debtTrend <= -.20) signals.push('Debt has declined materially');
  if (positiveFcfRate >= .85) signals.push('Free cash flow is consistently positive');
  if (finite(shareCagr) && shareCagr > .035) flags.push('Persistent share dilution');
  if (finite(sbcIntensity) && sbcIntensity > .08) flags.push('Stock-based compensation is heavy');
  if ((finite(roicTrend) && roicTrend < -.04) || (finite(marginTrend) && marginTrend < -.04)) flags.push('Reinvestment economics have deteriorated');
  if (finite(debtTrend) && debtTrend > .75) flags.push('Debt increased materially');
  if (finite(latestDebtToFcf) && latestDebtToFcf > 6) flags.push('Leverage is high relative to free cash flow');
  if (evidenceScore < 40) flags.push('Limited capital-allocation evidence');

  return {
    version: 'capital-allocation-v4', score, evidenceScore,
    grade: score >= 85 ? 'Exceptional' : score >= 70 ? 'Strong' : score >= 55 ? 'Above Average' : score >= 40 ? 'Mixed' : score >= 25 ? 'Weak' : 'Destructive',
    reinvestmentScore: Math.round(reinvestment.score),
    perShareDiscipline: Math.round(perShare.score),
    buybackQuality: Math.round(perShare.score),
    debtDiscipline: Math.round(balance.score),
    cashDiscipline: Math.round(cashReturn.score),
    annualDilution: shareCagr, sbcIntensity, recentRoic,
    fallbackReturnEconomics: Math.round(fallbackReturnScore.score),
    incrementalRoic: roicTrend, marginTrend, debtTrend, debtToFcf: latestDebtToFcf,
    repurchaseToFcf, dividendsToFcf, acquisitionToFcf, fcfConversion,
    signals, flags,
  };
}

module.exports = { computeCapitalAllocationV2 };
