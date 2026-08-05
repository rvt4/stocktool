'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value) {
  const n = finite(value);
  if (n == null) return null;
  return Math.abs(n) > 1.5 ? n / 100 : n;
}

function supabaseConfig() {
  const rawUrl = String(process.env.SUPABASE_URL || '').trim();
  const url = rawUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  return { url, key, enabled: Boolean(url && key) };
}

function currentPrice(stock) {
  return finite(stock?.price?.current ?? stock?.currentPrice);
}

function latestFinancial(stock) {
  const years = stock?.financials?.years;
  return Array.isArray(years) && years.length ? years[years.length - 1] : {};
}

function methodRows(stock) {
  const values = stock?.valuation?.valuationMethods || {};
  const weights = stock?.valuation?.effectiveWeights || {};
  const reliability = stock?.valuation?.reliabilityFlags || {};
  return Object.entries(values)
    .filter(([, value]) => finite(value) != null)
    .map(([method, value]) => ({
      method,
      fair_value: finite(value),
      effective_weight: finite(weights?.[method]),
      reliability: finite(reliability?.[method]?.score ?? reliability?.[method]),
    }));
}

function compactPrediction(stock, asOf = new Date()) {
  const price = currentPrice(stock);
  const valuation = stock?.valuation || {};
  const profile = valuation.expectedReturnProfile || {};
  const scenario = valuation.scenarioAnalysis || {};
  const latest = latestFinancial(stock);
  const projection = valuation.projectionAssumptions || {};
  const growth = projection?.growthModel?.assumptions || {};
  const category = valuation.category || stock.category || null;
  const industry = valuation.industryModel?.model || valuation.industryModel?.key || 'general';
  const modelVersion = process.env.MODEL_VERSION || projection.version || 'v47';

  const payload = {
    ticker: String(stock.ticker || '').toUpperCase(),
    snapshot_date: asOf.toISOString().slice(0, 10),
    captured_at: asOf.toISOString(),
    engine_version: modelVersion,
    prediction_hash: null,
    current_price: price,
    category,
    industry,
    sector: stock.sector || null,
    market_cap: finite(valuation.marketCap ?? stock.marketCap),
    rating: stock.rating || null,
    confidence: finite(stock.forecastConfidenceScore ?? stock.confidenceScore ?? valuation.confidence ?? profile.confidence),
    forecast_confidence_label: stock.forecastConfidenceLabel || null,
    investment_score: finite(stock.investmentScore ?? stock.portfolioManagerScore),
    ic_score: finite(stock.icScore ?? valuation.investmentCommittee?.score),
    quality_score: finite(stock.qualityScore ?? valuation.economicQuality?.score ?? valuation.economicQuality),
    moat_score: finite(stock.componentScores?.moat ?? valuation.moat?.score),
    pricing_score: finite(stock.pricingPowerScore ?? valuation.pricingPowerV2?.score),
    protection_score: finite(stock.protectionScore ?? stock.downsideProtectionScore ?? valuation.downside?.protectionScore ?? valuation.downside?.score),
    capital_allocation_score: finite(stock.capitalAllocationScore ?? stock.capitalAllocation?.score ?? valuation.capitalAllocation?.score),
    success_probability: pct(stock.successProbability ?? profile.successProbability),
    expected_cagr: pct(profile.expectedCAGR ?? stock.expectedReturn),
    risk_adjusted_cagr: pct(profile.riskAdjustedCAGR),
    expected_alpha: pct(stock.expectedAlpha ?? ((profile.expectedCAGR ?? stock.expectedReturn) != null ? (profile.expectedCAGR ?? stock.expectedReturn) - .10 : null)),
    bear_cagr: pct(profile.bearCAGR ?? scenario.downsideCAGR),
    base_cagr: pct(profile.baseCAGR ?? scenario.baseCAGR),
    bull_cagr: pct(profile.bullCAGR ?? scenario.upsideCAGR),
    scenario_downside_spread: pct(stock.baseCAGR != null && stock.bearCAGR != null ? stock.baseCAGR - stock.bearCAGR : null),
    scenario_upside_spread: pct(stock.bullCAGR != null && stock.baseCAGR != null ? stock.bullCAGR - stock.baseCAGR : null),
    fundamental_cagr: pct(valuation.returnEngineV2?.fundamentalCAGR ?? valuation.ownerEarningsReturn?.fundamentalCAGR),
    fair_value: finite(valuation.fairValueEstimate),
    five_year_target: finite(valuation.fiveYearPriceTarget),
    required_mos: pct(stock.requiredMarginOfSafety ?? valuation.requiredMarginOfSafety),
    margin_of_safety: pct(stock.marginOfSafety ?? valuation.marginOfSafety),
    pe: finite(stock.pe ?? valuation.pe ?? stock.metrics?.pe),
    ev_ebit: finite(stock.evEbit ?? valuation.evEbit ?? stock.metrics?.evEbit),
    ev_fcf: finite(stock.evFcf ?? valuation.evFcf ?? stock.metrics?.evFcf),
    price_to_fcf: finite(stock.pFcf ?? valuation.pFcf ?? stock.metrics?.pFcf),
    analyst_revenue_growth: pct(stock.analystEstimates?.revenueGrowthNextYear ?? stock.analystEstimates?.revenueGrowth),
    analyst_eps_growth: pct(stock.analystEstimates?.epsGrowthNextYear ?? stock.analystEstimates?.epsGrowth),
    revenue: finite(latest.revenue),
    eps: finite(latest.eps),
    fcf: finite(latest.fcf ?? latest.freeCashFlow),
    revenue_growth: pct(latest.revenueGrowth ?? growth.year1),
    fcf_margin: pct(latest.fcfMargin),
    net_margin: pct(latest.netMargin),
    roic: pct(latest.roic ?? valuation.economicQuality?.roic),
    share_count: finite(latest.shares ?? latest.dilutedShares),
    sbc_to_revenue: pct(valuation.sbcIntensity),
    net_debt: finite(valuation.netDebt ?? latest.netDebt),
    discount_rate: pct(valuation.returnEngineV2?.discountRate ?? valuation.projectionAssumptions?.discountRate),
    terminal_growth: pct(valuation.returnEngineV2?.terminalGrowth ?? valuation.projectionAssumptions?.terminalGrowth),
    method_values: methodRows(stock),
    return_attribution: profile.returnAttribution || stock.returnAttribution || null,
    assumptions: {
      lifecycle: valuation.lifecycle || null,
      moat: valuation.moat || null,
      growth_model: growth,
      dilution_rate: pct(valuation.dilutionRate),
      market_implied_growth: pct(valuation.marketImpliedGrowth),
      agreement_score: finite(valuation.methodAgreementScore),
      method_count: finite(valuation.methodCount),
    },
  };

  payload.prediction_hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return payload;
}

async function request(table, rows, onConflict) {
  const { url, key, enabled } = supabaseConfig();
  if (!enabled) return { skipped: true, reason: 'missing Supabase credentials' };
  if (!rows.length) return { skipped: true, reason: 'no rows' };
  const endpoint = new URL(`${url}/rest/v1/${table}`);
  if (onConflict) endpoint.searchParams.set('on_conflict', onConflict);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: onConflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${table} write failed: HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }
  return { inserted: rows.length };
}

async function persistCalibrationSnapshot(stocks, options = {}) {
  const asOf = options.asOf || new Date();
  const rows = stocks.map(stock => compactPrediction(stock, asOf)).filter(row => row.ticker && row.current_price > 0);
  const batchSize = options.batchSize || 250;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const result = await request('model_predictions', rows.slice(i, i + batchSize), 'ticker,snapshot_date,engine_version');
    inserted += result.inserted || 0;
  }

  const localPath = options.localPath || path.join(__dirname, '..', 'data', 'latest-prediction-snapshot.json');
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify({ capturedAt: asOf.toISOString(), count: rows.length, rows }, null, 2));
  return { inserted, localCount: rows.length, localPath };
}

module.exports = { compactPrediction, persistCalibrationSnapshot, supabaseConfig };
