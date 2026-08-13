'use strict';

/**
 * FreeScreener canonical investor-return contract.
 *
 * There is exactly one decision horizon: five years.
 * Any displayed/decision CAGR must be the mathematical CAGR from today's price
 * to the canonical five-year exit price plus modeled cash dividends.
 */
const INVESTMENT_HORIZON_YEARS = 5;
const RETURN_INTEGRITY_TOLERANCE = 1e-6;

function finite(v) { return Number.isFinite(Number(v)); }

function projectionAtInvestmentHorizon(model) {
  const projection = Array.isArray(model?.projection) ? model.projection : [];
  return projection.length >= INVESTMENT_HORIZON_YEARS
    ? projection[INVESTMENT_HORIZON_YEARS - 1]
    : null;
}

function convertTerminalValueToInvestmentHorizon(presentValue, terminalValue, fullForecastYears) {
  const present = Number(presentValue);
  const terminal = Number(terminalValue);
  const fullYears = Number(fullForecastYears);
  if (!(present > 0) || !(terminal > 0) || !(fullYears >= INVESTMENT_HORIZON_YEARS)) return null;
  if (fullYears === INVESTMENT_HORIZON_YEARS) return terminal;
  return present * Math.pow(terminal / present, INVESTMENT_HORIZON_YEARS / fullYears);
}

function cagrFromOutcome(currentPrice, exitPrice, dividendsReceived = 0, years = INVESTMENT_HORIZON_YEARS) {
  const current = Number(currentPrice);
  const exit = Number(exitPrice);
  const dividends = Number(dividendsReceived || 0);
  const horizon = Number(years);
  if (!(current > 0) || !(exit > 0) || !(horizon > 0) || !finite(dividends)) return null;
  const totalFutureValue = exit + dividends;
  if (!(totalFutureValue > 0)) return null;
  return Math.pow(totalFutureValue / current, 1 / horizon) - 1;
}

function auditCanonicalReturn(target, currentPrice, tolerance = RETURN_INTEGRITY_TOLERANCE) {
  const years = Number(target?.years);
  const shown = Number(target?.cagr);
  const exitPrice = Number(target?.exitPrice);
  const dividendsReceived = Number(target?.dividendsReceived || 0);
  const reasons = [];

  if (years !== INVESTMENT_HORIZON_YEARS) reasons.push(`canonical horizon must be ${INVESTMENT_HORIZON_YEARS} years, got ${years}`);
  if (!(Number(currentPrice) > 0)) reasons.push('current price is missing or invalid');
  if (!(exitPrice > 0)) reasons.push('canonical five-year exit price is missing or invalid');
  if (!finite(shown)) reasons.push('canonical five-year CAGR is missing or invalid');

  const implied = reasons.length
    ? null
    : cagrFromOutcome(currentPrice, exitPrice, dividendsReceived, INVESTMENT_HORIZON_YEARS);
  const gap = implied != null && finite(shown) ? Math.abs(implied - shown) : null;
  if (gap != null && gap > tolerance) reasons.push(`displayed CAGR differs from five-year price-derived CAGR by ${(gap * 100).toFixed(4)}pp`);

  return {
    valid: reasons.length === 0,
    years,
    shownCAGR: finite(shown) ? shown : null,
    impliedCAGR: implied,
    gap,
    reasons,
  };
}

module.exports = {
  INVESTMENT_HORIZON_YEARS,
  RETURN_INTEGRITY_TOLERANCE,
  projectionAtInvestmentHorizon,
  convertTerminalValueToInvestmentHorizon,
  cagrFromOutcome,
  auditCanonicalReturn,
};
