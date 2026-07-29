/**
 * Nightly screener run. Fetches free data for the watchlist, scores it,
 * and writes data/results.json for the static frontend to read.
 *
 * Run with: node run-screener.js
 * Requires Node 18+ (built-in fetch).
 *
 * At full Russell 1000 scale (~1000 tickers) this takes roughly 20-30 minutes,
 * mostly spent in the delay between tickers (see RATE_LIMIT_DELAY_MS below) —
 * that's normal, not a bug. GitHub Actions on a public repo has no minutes cap,
 * so a long-running job costs nothing.
 */
const fs = require('fs');
const path = require('path');
const { buildStockRecord } = require('./data-fetchers');
const { computeSectorExitMultiples, valuateStock } = require('./valuation-methods');
const { scoreUniverse } = require('./scoring-engine');
const { assessDataIntegrity } = require('./engine/data-integrity');
const { buildScenarios } = require('./engine/scenario-engine');
const { computeExpectedReturnProfile } = require('./engine/expected-return-engine');
const { buildInvestmentThesis } = require('./engine/thesis-engine');
const { inferIndustryModel } = require('./engine/industry-engine');
const { computePricingPowerV2 } = require('./engine/pricing-power-engine');
const { computeCompounderScore } = require('./engine/compounder-engine');
const { computeDownsideRisk } = require('./engine/downside-engine');
const { buildCalibration, applyCalibration } = require('./engine/calibration-engine');
const { updateForecastHistory } = require('./engine/forecast-tracker');
const { computePortfolioProfile } = require('./engine/portfolio-engine');

const watchlist = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));

// Finnhub free tier = 60 calls/min, 1 call/ticker (quote only) here.
// 1100ms keeps us at ~54 calls/min, comfortably under the cap even with jitter.
const RATE_LIMIT_DELAY_MS = 1100;
const CHECKPOINT_EVERY = 100; // write partial progress periodically so a mid-run failure isn't a total loss

function normalizeTicker(ticker) {
  return String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/\./g, '-');
}

async function loadAnalystEstimates() {
  const rawUrl = String(process.env.SUPABASE_URL || '').trim();
  const baseUrl = rawUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  ).trim();

  if (!baseUrl || !key) {
    throw new Error(
      'Supabase credentials are missing in the run-screener job. ' +
      'Add SUPABASE_URL and SUPABASE_SERVICE_KEY to the Run screener step in nightly.yml.'
    );
  }

  console.log(`Reading analyst estimates from ${baseUrl}/rest/v1/analyst_estimates_cache`);

  const pageSize = 1000;
  const rows = [];

  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      select: '*',
      order: 'ticker.asc',
      offset: String(offset),
      limit: String(pageSize),
    });
    const url = `${baseUrl}/rest/v1/analyst_estimates_cache?${params}`;
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        Prefer: 'count=exact',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Analyst-estimate cache fetch failed: HTTP ${res.status}. ` +
        `${body.slice(0, 800)}`
      );
    }

    const page = await res.json();
    if (!Array.isArray(page)) {
      throw new Error('Supabase analyst-estimate response was not a JSON array.');
    }

    rows.push(...page);
    console.log(`Analyst cache page: offset ${offset}, received ${page.length}, total ${rows.length}`);
    if (page.length < pageSize) break;
  }

  if (rows.length === 0) {
    throw new Error(
      'Supabase returned zero analyst-estimate rows. The screener was stopped rather ' +
      'than silently generating another results file without analyst data.'
    );
  }

  const estimates = new Map();
  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) continue;

    estimates.set(ticker, {
      revenueGrowthFwd: row.revenue_growth_fwd ?? null,
      revenueGrowthCurrentYear: row.revenue_growth_current_year ?? row.revenue_growth_fwd ?? null,
      revenueGrowthNextYear: row.revenue_growth_next_year ?? null,
      revenueCurrentYear: row.revenue_current_year ?? null,
      revenueNextYear: row.revenue_next_year ?? null,
      epsGrowthFwd: row.eps_growth_fwd ?? null,
      epsGrowthCurrentYear: row.eps_growth_current_year ?? row.eps_growth_fwd ?? null,
      epsGrowthNextYear: row.eps_growth_next_year ?? null,
      epsCurrentYear: row.eps_current_year ?? null,
      epsNextYear: row.eps_next_year ?? null,
      analystTargetMean: row.analyst_target_mean ?? null,
      analystTargetLow: row.analyst_target_low ?? null,
      analystTargetHigh: row.analyst_target_high ?? null,
      numAnalysts: row.num_analysts ?? null,
      source: row.source ?? null,
      updatedAt: row.updated_at ?? null,
    });
  }

  const examples = ['AMD', 'META', 'CRM', 'CELH']
    .map(ticker => `${ticker}:${estimates.has(ticker) ? 'yes' : 'no'}`)
    .join(', ');
  console.log(`Mapped ${estimates.size} analyst records. Spot check — ${examples}`);

  return estimates;
}

function writeResults(records, partial) {
  const scored = scoreUniverse(records);
  const output = {
    generatedAt: new Date().toISOString(),
    count: scored.length,
    partial: !!partial,
    stocks: scored,
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'results.json'), JSON.stringify(output, null, 2));
  return scored;
}

async function run() {
  const records = [];
  const analystEstimates = await loadAnalystEstimates();
  console.log(`Loaded analyst estimates for ${analystEstimates.size} tickers from Supabase.`);
  const startTime = Date.now();
  const forecastHistoryPath = path.join(__dirname, 'data', 'forecast-history.json');
  let forecastHistory = { version: 1, snapshots: [] };
  try {
    forecastHistory = JSON.parse(fs.readFileSync(forecastHistoryPath, 'utf8'));
  } catch (_) {
    // First Milestone 3 run starts a new local history file.
  }
  for (let i = 0; i < watchlist.length; i++) {
    const { ticker, sector } = watchlist[i];
    try {
      const record = await buildStockRecord(ticker, sector, analystEstimates.get(normalizeTicker(ticker)) || null);
      if (record.financials.years.length >= 3) {
        records.push(record);
      } else {
        console.warn(`[${i + 1}/${watchlist.length}] Skipping ${ticker}: insufficient financial history`);
      }
    } catch (err) {
      console.error(`[${i + 1}/${watchlist.length}] Failed ${ticker}: ${err.message}`);
    }

    if ((i + 1) % 25 === 0) {
      const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
      console.log(`Progress: ${i + 1}/${watchlist.length} (${elapsedMin} min elapsed, ${records.length} scored so far)`);
    }
    if ((i + 1) % CHECKPOINT_EVERY === 0) {
      writeResults(records, true); // checkpoint save in case the job gets interrupted
    }

    if (i < watchlist.length - 1) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  }

  // --- Second pass: multi-method valuation, now that we have the whole universe ---
  // Exit-multiple methods need sector median multiples across ALL fetched stocks, which
  // only exists once the fetch loop above is done. This is why valuation can't happen
  // per-ticker during the fetch loop anymore.
  console.log(`Valuating ${records.length} stocks (DCF + revenue/EPS/EBITDA exit multiples)...`);
  const sectorExitMultiples = computeSectorExitMultiples(records);
  const currentByTicker = new Map(records.map(stock => [stock.ticker, stock]));
  const calibration = buildCalibration(forecastHistory, currentByTicker);
  console.log(`Milestone 3 calibration: ${calibration.observationCount} mature observations${calibration.isCalibrated ? ' (active)' : ' (collecting history)'}.`);
  for (const stock of records) {
    // Industry must be known before valuation so method suitability can influence
    // the reliability-weighted blend (for example, cash-flow methods dominate for
    // semiconductors while revenue multiples receive more room for software).
    const industryModel = inferIndustryModel(stock);
    stock.valuation.industryModel = industryModel;
    const result = valuateStock(stock, sectorExitMultiples);
    stock.valuation.fairValueEstimate = result.blendedFairValue;
    stock.valuation.valuationMethods = result.methods;
    stock.valuation.outlierFlags = result.outlierFlags;
    stock.valuation.effectiveWeights = result.effectiveWeights;
    stock.valuation.reliabilityFlags = result.reliabilityFlags;
    stock.valuation.projection = result.projection;
    stock.valuation.projectionAssumptions = result.projectionAssumptions;
    stock.valuation.methodAudits = result.methodAudits;
    stock.valuation.methodAgreementScore = result.agreementScore;
    stock.valuation.methodCount = result.methodCount;
    stock.valuation.marketImpliedGrowth = result.marketImpliedGrowth;
    stock.valuation.marketImpliedGrowthNote = result.marketImpliedGrowthNote;
    stock.valuation.dilutionRate = result.dilutionRate;
    stock.valuation.sbcIntensity = result.sbcIntensity;
    stock.valuation.capitalAllocation = result.capitalAllocation;
    stock.valuation.analystReliability = result.analystReliability;
    stock.valuation.reverseDCFGap = result.reverseDCFGap;
    stock.valuation.businessProfile = result.businessProfile;
    stock.valuation.category = result.category;
    // Powers the price-aware `expectedReturn` field in scoring-engine.js — without this,
    // every stock falls back to the price-agnostic fundamentalGrowthRate for the buy-list
    // gate, silently losing the "is this a buy at today's price" signal.
    stock.valuation.fiveYearPriceTarget = result.fiveYearPriceTarget;
    stock.valuation.intrinsicValue = result.intrinsicValue;
    stock.valuation.marketValue = result.marketValue;
    stock.valuation.valuationConsensus = result.valuationConsensus;
    stock.valuation.returnEngineV2 = result.returnEngineV2;
    stock.valuation.marketExpectations = result.marketExpectations;
    stock.valuation.monteCarlo = result.monteCarlo;

    // V7 Milestone 1: auditable data integrity + bear/base/bull return distribution.
    const dataIntegrity = assessDataIntegrity(stock);
    const scenarioAnalysis = buildScenarios(stock, result, dataIntegrity);
    const rawExpectedReturnProfile = computeExpectedReturnProfile(stock, scenarioAnalysis, dataIntegrity);
    const expectedReturnProfile = applyCalibration(rawExpectedReturnProfile, stock, calibration);
    stock.dataIntegrity = dataIntegrity;
    stock.valuation.scenarioAnalysis = scenarioAnalysis;
    stock.valuation.expectedReturnProfile = expectedReturnProfile;
    stock.valuation.calibration = calibration;
    stock.valuation.investmentThesis = buildInvestmentThesis(stock, expectedReturnProfile);
    const pricingPowerV2 = computePricingPowerV2(stock, industryModel);
    const compounder = computeCompounderScore(stock, pricingPowerV2, industryModel);
    const downside = computeDownsideRisk(stock, scenarioAnalysis, dataIntegrity, industryModel);
    stock.valuation.pricingPowerV2 = pricingPowerV2;
    stock.valuation.compounder = compounder;
    stock.valuation.downside = downside;
    stock.valuation.portfolioProfile = computePortfolioProfile(stock);
  }

  const scored = writeResults(records, false);
  const updatedHistory = updateForecastHistory(forecastHistory, scored);
  fs.writeFileSync(forecastHistoryPath, JSON.stringify(updatedHistory, null, 2));
  console.log(`Done. Wrote ${records.length} scored stocks to data/results.json`);
}

run().catch(err => { console.error(err); process.exit(1); });
