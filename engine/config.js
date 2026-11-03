'use strict';

const SECTOR = {
  Technology:              { terminalGrowth: 0.030, basePE: 20, baseEVEBITDA: 14, maxFCFMargin: 0.45 },
  Healthcare:              { terminalGrowth: 0.030, basePE: 18, baseEVEBITDA: 13, maxFCFMargin: 0.40 },
  Financials:              { terminalGrowth: 0.030, basePE: 13, baseEVEBITDA: 10, maxFCFMargin: 0.35 },
  Industrials:             { terminalGrowth: 0.030, basePE: 16, baseEVEBITDA: 11, maxFCFMargin: 0.30 },
  'Consumer Discretionary':{ terminalGrowth: 0.030, basePE: 16, baseEVEBITDA: 11, maxFCFMargin: 0.30 },
  'Consumer Staples':      { terminalGrowth: 0.025, basePE: 17, baseEVEBITDA: 12, maxFCFMargin: 0.28 },
  'Communication Services':{ terminalGrowth: 0.030, basePE: 17, baseEVEBITDA: 11, maxFCFMargin: 0.35 },
  Energy:                  { terminalGrowth: 0.020, basePE: 12, baseEVEBITDA: 8,  maxFCFMargin: 0.30 },
  Materials:               { terminalGrowth: 0.020, basePE: 13, baseEVEBITDA: 8,  maxFCFMargin: 0.25 },
  Utilities:               { terminalGrowth: 0.020, basePE: 16, baseEVEBITDA: 10, maxFCFMargin: 0.25 },
  'Real Estate':           { terminalGrowth: 0.025, basePE: 16, baseEVEBITDA: 12, maxFCFMargin: 0.35 },
  Unknown:                 { terminalGrowth: 0.025, basePE: 15, baseEVEBITDA: 10, maxFCFMargin: 0.30 },
};

const HORIZON_YEARS = 10;
const EXPLICIT_FORECAST_YEARS = 5;
// Investor required long-run return (single source of truth; was 15%, which only ~4% of the
// universe could clear). Expected Alpha is defined relative to this hurdle.
const INVESTOR_ALPHA_HURDLE = 0.11;
// Perpetual growth can never exceed long-run nominal GDP / risk-free growth. The old 4-5.5%
// ceilings (ADBE 4.3%) inflated every DCF and Gordon-anchored exit multiple.
const TERMINAL_GROWTH_CAP = 0.03;
// Weight placed on the market's CURRENT multiple when setting the year-10 exit multiple.
// 0 reproduces the old purely fundamental (price-independent) behavior.
const EXIT_PRICE_ANCHOR_WEIGHT = 0.35;
// Retained only for legacy diagnostics that explicitly need a generic market-return assumption.
const MARKET_RETURN = 0.10;

function sectorConfig(sector) {
  return SECTOR[sector] || SECTOR.Unknown;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

function rate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 1.5 ? n / 100 : n;
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function avg(values) {
  const a = values.filter(Number.isFinite);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

module.exports = { SECTOR, HORIZON_YEARS, EXPLICIT_FORECAST_YEARS, INVESTOR_ALPHA_HURDLE, TERMINAL_GROWTH_CAP, EXIT_PRICE_ANCHOR_WEIGHT, MARKET_RETURN, sectorConfig, clamp, rate, median, avg };
