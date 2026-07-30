'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function cagr(start, end, years) {
  return start > 0 && end > 0 && years > 0 ? Math.pow(end / start, 1 / years) - 1 : null;
}

function historicalOwnerEarnings(stock, maintenanceCapexMargin, daMargin, sbcMargin) {
  return (stock.financials?.years || []).slice(-5).map(y => {
    if (!(y.revenue > 0) || !(y.sharesOutTTM > 0)) return null;
    const da = Number.isFinite(y.da) && y.da >= 0 ? y.da : y.revenue * daMargin;
    const capex = Number.isFinite(y.capex) && y.capex >= 0
      ? Math.min(y.capex, y.revenue * Math.max(maintenanceCapexMargin, daMargin * 1.25))
      : y.revenue * maintenanceCapexMargin;
    const sbc = Number.isFinite(y.sbc) && y.sbc >= 0 ? y.sbc : y.revenue * sbcMargin;
    const oe = (Number(y.netIncome) || 0) + da - capex - sbc;
    return oe > 0 ? { year: y.year, ownerEarnings: oe, shares: y.sharesOutTTM, perShare: oe / y.sharesOutTTM } : null;
  }).filter(Boolean);
}

function justifiedOwnerEarningsMultiple(stock, model, lifecycle, moat, profile, audit) {
  const last = stock.financials?.years?.at(-1) || {};
  const final = model.projection?.at(-1) || {};
  const years = model.projection?.length || 5;
  const growth = model.projection?.length > 1
    ? cagr(model.projection[0].revenue, final.revenue, Math.max(1, years - 1))
    : Number(final.growth) || 0;
  const roic = Number(last.roic) || 0;
  const moatScore = Number(moat?.score) || 50;
  const reliability = Number(profile?.forecastReliability) || 0.5;
  const discount = Number(audit?.discountRate) || 0.09;
  const terminalGrowth = Number(audit?.terminalGrowth) || 0.027;
  const perpetuityMultiple = 1 / Math.max(0.045, discount - terminalGrowth);

  let qualityPremium = 1;
  qualityPremium += clamp((moatScore - 50) / 100, -0.18, 0.28);
  qualityPremium += clamp((roic - 0.12) * 0.65, -0.12, 0.22);
  qualityPremium += clamp((reliability - 0.5) * 0.24, -0.10, 0.12);
  qualityPremium += clamp((growth - 0.06) * 0.75, -0.08, 0.18);

  const stage = String(lifecycle?.stage || '');
  if (/Cyclical|Turnaround|Declin/i.test(stage)) qualityPremium *= 0.82;
  if (/Dividend|Mature|Financial|Utility/i.test(stage)) qualityPremium *= 0.92;
  if (/Elite|Compounder|Growth/i.test(stage)) qualityPremium *= 1.04;

  return clamp(perpetuityMultiple * qualityPremium, 9, 32);
}

function buildOwnerEarningsReturn(stock, model, ownerResult, dcfResult, consensus, lifecycle, moat, profile) {
  const currentPrice = Number(stock.price?.current);
  const projection = model.projection || [];
  const years = projection.length;
  const lastProjection = projection.at(-1) || {};
  const audit = ownerResult?.audit || {};
  if (!(currentPrice > 0) || !years || !(lastProjection.shares > 0)) {
    return { version: 'owner-earnings-v20', expectedCAGR: null, fairValueToday: null, reason: 'missing price, projection, or shares' };
  }

  const daMargin = Number(audit.daMargin) || 0.02;
  const maintenanceCapexMargin = Number(audit.maintenanceCapexMargin) || 0.02;
  const sbcMargin = Number(audit.sbcMargin) || 0;
  const history = historicalOwnerEarnings(stock, maintenanceCapexMargin, daMargin, sbcMargin);
  const normalizedStartPerShare = median(history.map(x => x.perShare));

  const finalOwnerEarnings = Number(audit.yearly?.at(-1)?.ownerEarnings);
  if (!(finalOwnerEarnings > 0)) {
    return { version: 'owner-earnings-v20', expectedCAGR: null, fairValueToday: ownerResult?.fairValuePerShare ?? dcfResult?.fairValuePerShare ?? null, reason: 'non-positive projected owner earnings' };
  }

  const exitOwnerEarningsPerShare = finalOwnerEarnings / lastProjection.shares;
  const terminalMultiple = justifiedOwnerEarningsMultiple(stock, model, lifecycle, moat, profile, audit);
  const exitPrice = exitOwnerEarningsPerShare * terminalMultiple;
  const dividendYield = clamp(Number(stock.valuation?.dividendYield) || 0, 0, 0.08);
  const dividendsReceived = currentPrice * dividendYield * years;
  const rawExpectedCAGR = cagr(currentPrice, exitPrice + dividendsReceived, years);

  const ownerFairValue = Number(ownerResult?.fairValuePerShare);
  const dcfFairValue = Number(dcfResult?.fairValuePerShare);
  const primaryFairValue = ownerFairValue > 0 ? ownerFairValue : dcfFairValue > 0 ? dcfFairValue : null;
  const validationCenter = consensus?.marketValue || consensus?.intrinsicValue || null;
  const validationGap = primaryFairValue > 0 && validationCenter > 0
    ? Math.abs(primaryFairValue - validationCenter) / primaryFairValue : null;

  const inputQuality = audit.inputQuality === 'reported' ? 1 : audit.inputQuality === 'historical-estimate' ? 0.82 : 0.62;
  const terminalShare = clamp(Number(audit.terminalValueShareOfEnterpriseValue) || 0.7, 0, 1);
  const methodAgreement = clamp((Number(consensus?.agreementScore) || 50) / 100, 0, 1);
  const confidence = clamp(inputQuality * 0.35 + (1 - terminalShare) * 0.20 + methodAgreement * 0.20 + (Number(profile?.forecastReliability) || 0.5) * 0.25, 0.25, 0.95);

  // Expected return is driven by owner earnings. Validation methods only temper an
  // extreme result; they never replace the primary economic model.
  let expectedCAGR = rawExpectedCAGR;
  if (Number.isFinite(expectedCAGR)) {
    const stage = String(lifecycle?.stage || '');
    const cap = /Cyclical|Turnaround/i.test(stage) ? 0.20
      : /Dividend|Mature|Utility|Financial/i.test(stage) ? 0.16
      : /Growth|Elite|Compounder/i.test(stage) ? 0.24 : 0.20;
    expectedCAGR = clamp(expectedCAGR, -0.35, cap);
    if (validationGap != null && validationGap > 0.65) {
      const temper = clamp((validationGap - 0.65) * 0.18 * (1 - confidence), 0, 0.035);
      expectedCAGR -= Math.sign(expectedCAGR) * temper;
    }
  }

  const fairValueToday = primaryFairValue;
  const currentOwnerEarningsYield = normalizedStartPerShare > 0 ? normalizedStartPerShare / currentPrice : null;
  const ownerEarningsGrowth = normalizedStartPerShare > 0 ? cagr(normalizedStartPerShare, exitOwnerEarningsPerShare, years) : null;
  const multipleContribution = Number.isFinite(expectedCAGR) && Number.isFinite(ownerEarningsGrowth)
    ? expectedCAGR - ownerEarningsGrowth - dividendYield : null;

  return {
    version: 'owner-earnings-v20',
    expectedCAGR,
    rawExpectedCAGR,
    fairValueToday,
    exitPrice,
    years,
    dividendsReceived,
    normalizedStartOwnerEarningsPerShare: normalizedStartPerShare,
    exitOwnerEarningsPerShare,
    ownerEarningsGrowth,
    currentOwnerEarningsYield,
    terminalMultiple,
    confidence,
    validationCenter,
    validationGap,
    primaryMethod: ownerFairValue > 0 ? 'Owner Earnings DCF' : 'FCF DCF fallback',
    breakdown: {
      ownerEarningsGrowth,
      dividendContribution: dividendYield,
      multipleContribution,
    },
    audit: { inputQuality: audit.inputQuality, terminalValueShare: terminalShare, history },
  };
}

module.exports = { buildOwnerEarningsReturn, justifiedOwnerEarningsMultiple };
