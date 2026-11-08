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
const EXIT_PRICE_ANCHOR_WEIGHT = 0.35; // legacy: still used by the financial (P/E, P/B) and EV/Sales exits
// Build 58: operating-company exits (EPS, FCF, EV/EBITDA). Share of today's LOG premium/discount
// to the fundamentally justified multiple that survives to year 10: exit = justified * (current/justified)^p.
// 0 = purely fundamental (every stock converges to ~15-21x: a hidden value bet worth ~7.5%/yr between a
// 10x and a 50x stock). 1 = today's multiple never changes. Results (26) simulation: 0.6 cuts that gap to ~4%/yr.
const EXIT_MULTIPLE_PERSISTENCE = 0.6;
const EXIT_PREMIUM_BAND = [0.15, 6];     // current/justified ratio is clipped to this band first
const EXIT_ANCHOR_MAX_MULTIPLE = 150;    // quotes above this (near-zero earnings) are treated as 150x
// Share of the DCF terminal value set by the anchored FCF exit multiple instead of the Gordon formula
// (Gordon alone applies ~3% perpetual growth to every company, the same convergence problem). 0 = pure Gordon.
const DCF_EXIT_TV_WEIGHT = 0.5;
// Build 58d: extra margin of safety below the STRESSED (underwritten) 11% hurdle price. Was 20%, which
// stacked on top of the stressed case and left ~6 Buys, all with the most optimistic forecasts.
const INVESTOR_MARGIN_OF_SAFETY = 0.10;
// Consensus cross-check (valuation-engine): max log-space weight on the analyst-implied value (0 disables),
// and the band, as a multiple of the analyst-implied value, the blended value must stay inside.
const ANALYST_BLEND_MAX_WEIGHT = 0.35;
const ANALYST_BLEND_RANGE = [0.45, 2.2];
// Retained only for legacy diagnostics that explicitly need a generic market-return assumption.
const MARKET_RETURN = 0.10;

// Banks, lenders, insurers (SIC 60xx/61xx/63xx) and mortgage REITs (Financials + SIC 6798): FCF/EBITDA
// are not owner economics, so every stage (forecast, quality, valuation) must agree they are
// financial. Detecting this in only one stage produced null valuations.
function isStructuralFinancial(stock) {
  const sic = String(stock?.sic || '');
  return /^(60|61|63)\d\d$/.test(sic) || (stock?.sector === 'Financials' && sic === '6798');
}
function isFinancialLike(stock) {
  return stock?.financials?.dataQuality?.financialLikeRevenue === true || isStructuralFinancial(stock);
}

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

module.exports = { SECTOR, HORIZON_YEARS, EXPLICIT_FORECAST_YEARS, INVESTOR_ALPHA_HURDLE, TERMINAL_GROWTH_CAP, EXIT_PRICE_ANCHOR_WEIGHT, EXIT_MULTIPLE_PERSISTENCE, EXIT_PREMIUM_BAND, EXIT_ANCHOR_MAX_MULTIPLE, DCF_EXIT_TV_WEIGHT, INVESTOR_MARGIN_OF_SAFETY, ANALYST_BLEND_MAX_WEIGHT, ANALYST_BLEND_RANGE, MARKET_RETURN, isStructuralFinancial, isFinancialLike, sectorConfig, clamp, rate, median, avg };
