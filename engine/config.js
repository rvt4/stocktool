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
// Optional override only. Completed deals and spin-offs are detected automatically from SEC 8-K
// Item 2.01 filings (Build 60b) and pending deals from analyst estimates; nothing needs adding here.
// Format if ever needed: { TICKER: 'reason' } holds that stock at Watch.
const MANUAL_CORPORATE_ACTIONS = {};
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
  // Build 67b: Number(null) is 0, so missing analyst data used to read as "0% growth" (ROKU, CNA, COKE...).
  if (v === null || v === undefined || v === '') return null;
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

// Build 67: calibration from the forecast scorecard (backtest, 70,699 forecasts vs reported results).
// Revenue growth beyond year 1 regressed toward the market far more than the model assumed: 3-year
// forecasts of 10-20%/yr delivered ~8%, 20-30% delivered ~13%, and shrinking companies grew ~4.6%.
// Fitted: actual 3-yr CAGR ~= 6.5% + 0.48 x (forecast - 6.5%). Each projected year's growth is pulled
// toward ANCHOR, keeping KEEP[k] of its distance (year 1 untouched; year 2 keeps more when analysts
// forecast it). Set every KEEP value to 1 to switch the calibration off.
const GROWTH_CALIBRATION = { anchor: 0.065, keep: [1, 0.75, 0.55, 0.45, 0.40], keepYear2WithConsensus: 0.90 };
// Projected FCF margins (before stock pay) were less accurate than "the 3-year median FCF margin persists"
// in years 2-5. The starting, year-5 and mature (year-10) FCF targets are blended with that median by these
// weight; the yearly rows interpolate between them. One weight for all three keeps the path's shape (a rising
// path still rises), it just sits closer to the company's record. All 0 = off.
// Build 77b: year 1 starts from the latest reported cash margin. The scorecard showed the plain 'last year'
// baseline beat the blended start at year 1 (skill -8.5%); the blend still wins from year 2 on, so it stays there.
const FCF_MEDIAN_BLEND = { start: 0, year5: 0.40, mature: 0.40 };
// Build 75b: steady margin climbers. When operating margin has risen 3+ pts over the last 3 years without a
// real down year, revenue kept growing, gross margin isn't falling and analysts don't expect a drop, the
// model stops pulling margins back toward the historical median (AMZN-type businesses). Detection always
// runs (flag 'steady_margin_climb'); 'enabled' switches the effect. The scorecard re-runs flagged forecasts
// with the effect off so the two can be compared on the same companies and dates.
const MARGIN_TREND = { enabled: false,  // Build 76: OFF — failed its scorecard test (rule closer only 30-37% of the time)
  minRise: 0.03, maxStepDrop: 0.015, minOpMargin: 0.03, currentWeight: 0.85, durabilityBoost: 0.35, fcfBlendScale: 0.4 };
module.exports = { GROWTH_CALIBRATION, FCF_MEDIAN_BLEND, MARGIN_TREND, SECTOR, HORIZON_YEARS, EXPLICIT_FORECAST_YEARS, INVESTOR_ALPHA_HURDLE, TERMINAL_GROWTH_CAP, EXIT_PRICE_ANCHOR_WEIGHT, EXIT_MULTIPLE_PERSISTENCE, EXIT_PREMIUM_BAND, EXIT_ANCHOR_MAX_MULTIPLE, DCF_EXIT_TV_WEIGHT, INVESTOR_MARGIN_OF_SAFETY, MANUAL_CORPORATE_ACTIONS, ANALYST_BLEND_MAX_WEIGHT, ANALYST_BLEND_RANGE, MARKET_RETURN, isStructuralFinancial, isFinancialLike, sectorConfig, clamp, rate, median, avg };
