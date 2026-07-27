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

const watchlist = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));

// Finnhub free tier = 60 calls/min, 1 call/ticker (quote only) here.
// 1100ms keeps us at ~54 calls/min, comfortably under the cap even with jitter.
const RATE_LIMIT_DELAY_MS = 1100;
const CHECKPOINT_EVERY = 100; // write partial progress periodically so a mid-run failure isn't a total loss

async function loadAnalystEstimates() {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!baseUrl || !key) {
    console.warn('Supabase credentials missing — analyst estimates will not be loaded.');
    return new Map();
  }

  // Supabase/PostgREST commonly caps a response at 1,000 rows. Fetch in pages so
  // a Russell 1000-sized universe is not silently truncated.
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = `${baseUrl}/rest/v1/analyst_estimates_cache?select=*&order=ticker.asc&offset=${offset}&limit=${pageSize}`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn(`Analyst-estimate cache fetch failed: HTTP ${res.status} ${await res.text()}`);
      return new Map();
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return new Map(rows.map(row => [String(row.ticker || '').toUpperCase(), {
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
  }]));
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
}

async function run() {
  const records = [];
  const analystEstimates = await loadAnalystEstimates();
  console.log(`Loaded analyst estimates for ${analystEstimates.size} tickers from Supabase.`);
  const startTime = Date.now();
  for (let i = 0; i < watchlist.length; i++) {
    const { ticker, sector } = watchlist[i];
    try {
      const record = await buildStockRecord(ticker, sector, analystEstimates.get(ticker.toUpperCase()) || null);
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
  for (const stock of records) {
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
    // Powers the price-aware `expectedReturn` field in scoring-engine.js — without this,
    // every stock falls back to the price-agnostic fundamentalGrowthRate for the buy-list
    // gate, silently losing the "is this a buy at today's price" signal.
    stock.valuation.fiveYearPriceTarget = result.fiveYearPriceTarget;
  }

  writeResults(records, false);
  console.log(`Done. Wrote ${records.length} scored stocks to data/results.json`);
}

run().catch(err => { console.error(err); process.exit(1); });
