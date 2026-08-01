'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function finite(x) { return Number.isFinite(Number(x)); }
function cagr(start, end, years) {
  if (!(start > 0) || !(end > 0) || !(years > 0)) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

/**
 * Decomposes the canonical expected return into auditable operating and valuation
 * contributions. The contributions are expressed as annualized log-return pieces,
 * so they add exactly (apart from rounding) to the modeled CAGR in log space.
 */
function buildReturnAttribution(stock, primaryValuation, scenarioAnalysis) {
  const p = primaryValuation || stock?.valuation?.primaryValuation || stock?.valuation?.returnEngineV2 || {};
  const audit = p.cagrAudit || {};
  const bridge = p.operatingBridge || {};
  const years = Number(audit.projectionYears ?? p.years ?? 5);
  const currentPrice = Number(audit.currentPrice ?? stock?.price?.current);
  const exitValue = Number(audit.actionableExitValue ?? p.actionableExitValue);
  const dividends = Number(audit.modeledDividends ?? p.dividends ?? 0);
  const totalEndingValue = Number(audit.totalEndingValue ?? (finite(exitValue) ? exitValue + dividends : NaN));
  const expectedCAGR = Number(p.expectedCAGR ?? scenarioAnalysis?.baseCAGR);

  if (!(years > 0) || !(currentPrice > 0) || !(totalEndingValue > 0) || !finite(expectedCAGR)) {
    return { version: 'return-attribution-v1', available: false, expectedCAGR: finite(expectedCAGR) ? expectedCAGR : null };
  }

  const revenue = finite(bridge.revenueContribution) ? Number(bridge.revenueContribution) : 0;
  const margin = finite(bridge.marginContribution) ? Number(bridge.marginContribution) : 0;
  const buybacks = finite(bridge.shareContribution) ? Number(bridge.shareContribution) : 0;
  const dividendYield = dividends > 0 ? Math.pow((exitValue + dividends) / Math.max(exitValue, 0.01), 1 / years) - 1 : 0;

  // Convert intuitive annual arithmetic assumptions into additive log returns.
  const logExpected = Math.log1p(clamp(expectedCAGR, -0.95, 5));
  const logRevenue = Math.log1p(clamp(revenue, -0.80, 2));
  const logMargin = Math.log1p(clamp(margin, -0.80, 2));
  const logBuybacks = Math.log1p(clamp(buybacks, -0.80, 2));
  const logDividend = Math.log1p(clamp(dividendYield, -0.80, 2));
  const logValuation = logExpected - logRevenue - logMargin - logBuybacks - logDividend;

  const components = {
    revenueGrowth: Math.expm1(logRevenue),
    marginChange: Math.expm1(logMargin),
    shareCountChange: Math.expm1(logBuybacks),
    dividends: Math.expm1(logDividend),
    valuationChange: Math.expm1(logValuation),
  };

  const operatingCAGR = Math.expm1(logRevenue + logMargin + logBuybacks);
  const reconstructedCAGR = Math.expm1(logRevenue + logMargin + logBuybacks + logDividend + logValuation);
  const scenarioRange = finite(scenarioAnalysis?.upsideCAGR) && finite(scenarioAnalysis?.downsideCAGR)
    ? Number(scenarioAnalysis.upsideCAGR) - Number(scenarioAnalysis.downsideCAGR) : null;

  return {
    version: 'return-attribution-v1',
    available: true,
    expectedCAGR,
    reconstructedCAGR,
    operatingCAGR,
    components,
    audit: {
      currentPrice,
      projectionYears: years,
      exitValue,
      dividends,
      totalEndingValue,
      directCAGR: cagr(currentPrice, totalEndingValue, years),
      scenarioRange,
      formula: 'log(1+CAGR) = revenue + margin + share count + dividends + valuation',
    },
  };
}

module.exports = { buildReturnAttribution };
