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
    return { version: 'return-attribution-v57', available: false, expectedCAGR: finite(expectedCAGR) ? expectedCAGR : null };
  }

  const revenue = finite(bridge.revenueContribution) ? Number(bridge.revenueContribution) : 0;
  const forecastAssumptions = stock?.valuation?.projectionAssumptions || stock?.valuation?.forecast?.assumptions || {};
  const growthPath = (stock?.valuation?.projection || []).map(x => Number(x.growth)).filter(finite);
  const firstGrowth = growthPath.length ? growthPath[0] : Number(forecastAssumptions.year1);
  const terminalGrowth = growthPath.length ? growthPath.at(-1) : Number(forecastAssumptions.longRunAnchor);
  const explicitFade = finite(firstGrowth) && finite(terminalGrowth)
    ? clamp(Math.max(0, firstGrowth - terminalGrowth) / Math.max(years, 1) * .55, 0, .08)
    : 0;
  const progressiveBurden = finite(forecastAssumptions.progressiveGrowthBurden)
    ? clamp(Number(forecastAssumptions.progressiveGrowthBurden) / Math.max(years, 1), 0, .04) : 0;
  const growthFade = -(explicitFade + progressiveBurden);
  const preFadeRevenue = revenue - growthFade;
  const margin = finite(bridge.marginContribution) ? Number(bridge.marginContribution) : 0;
  const buybacks = finite(bridge.shareContribution) ? Number(bridge.shareContribution) : 0;
  const dividendYield = dividends > 0 ? Math.pow((exitValue + dividends) / Math.max(exitValue, 0.01), 1 / years) - 1 : 0;

  // Convert intuitive annual arithmetic assumptions into additive log returns.
  const logExpected = Math.log1p(clamp(expectedCAGR, -0.95, 5));
  const logRevenue = Math.log1p(clamp(preFadeRevenue, -0.80, 2));
  const logGrowthFade = Math.log1p(clamp(growthFade, -0.80, 2));
  const logMargin = Math.log1p(clamp(margin, -0.80, 2));
  const logBuybacks = Math.log1p(clamp(buybacks, -0.80, 2));
  const logDividend = Math.log1p(clamp(dividendYield, -0.80, 2));
  const logValuation = logExpected - logRevenue - logGrowthFade - logMargin - logBuybacks - logDividend;

  // Dashboard contributions are arithmetic CAGR-point contributions that reconcile
  // exactly to expectedCAGR.  We preserve the underlying multiplicative factor
  // rates separately for audit, but do not display those rates as if they were
  // additive percentages (the old presentation could appear not to sum).
  const logParts = {
    revenueGrowth: logRevenue, growthFade: logGrowthFade, marginChange: logMargin,
    shareCountChange: logBuybacks, dividends: logDividend, valuationChange: logValuation,
  };
  const logTotal = Object.values(logParts).reduce((a, b) => a + b, 0);
  const components = {};
  for (const [key, value] of Object.entries(logParts)) {
    components[key] = Math.abs(logTotal) > 1e-12 ? expectedCAGR * value / logTotal : 0;
  }
  // Eliminate floating-point drift on the residual component.
  const subtotal = Object.entries(components).filter(([k]) => k !== 'valuationChange').reduce((a, [,v]) => a + v, 0);
  components.valuationChange = expectedCAGR - subtotal;
  const factorRates = Object.fromEntries(Object.entries(logParts).map(([k,v]) => [k, Math.expm1(v)]));

  const operatingCAGR = Math.expm1(logRevenue + logGrowthFade + logMargin + logBuybacks);
  const reconstructedCAGR = Math.expm1(logRevenue + logGrowthFade + logMargin + logBuybacks + logDividend + logValuation);
  const scenarioRange = finite(scenarioAnalysis?.upsideCAGR) && finite(scenarioAnalysis?.downsideCAGR)
    ? Number(scenarioAnalysis.upsideCAGR) - Number(scenarioAnalysis.downsideCAGR) : null;

  return {
    version: 'return-attribution-v63',
    available: true,
    expectedCAGR,
    reconstructedCAGR,
    operatingCAGR,
    components,
    factorRates,
    contributionSum: Object.values(components).reduce((a,b)=>a+b,0),
    audit: {
      currentPrice,
      projectionYears: years,
      exitValue,
      dividends,
      totalEndingValue,
      directCAGR: cagr(currentPrice, totalEndingValue, years),
      scenarioRange,
      formula: 'Displayed contributions are allocated CAGR points from exact log-return factors and therefore sum to expected CAGR.',
      multiplicativeIdentity: '(1+CAGR)^years = ending value / starting price',
      firstGrowth: finite(firstGrowth) ? firstGrowth : null,
      terminalGrowth: finite(terminalGrowth) ? terminalGrowth : null,
      progressiveGrowthBurden: progressiveBurden,
    },
  };
}

module.exports = { buildReturnAttribution };
