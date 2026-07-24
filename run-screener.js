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
const { scoreUniverse } = require('./scoring-engine');

const watchlist = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));

// Finnhub free tier = 60 calls/min, 1 call/ticker (quote only) here.
// 1100ms keeps us at ~54 calls/min, comfortably under the cap even with jitter.
const RATE_LIMIT_DELAY_MS = 1100;
const CHECKPOINT_EVERY = 100; // write partial progress periodically so a mid-run failure isn't a total loss

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
  const startTime = Date.now();
  for (let i = 0; i < watchlist.length; i++) {
    const { ticker, sector } = watchlist[i];
    try {
      const record = await buildStockRecord(ticker, sector);
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

  writeResults(records, false);
  console.log(`Done. Wrote ${records.length} scored stocks to data/results.json`);
}

run().catch(err => { console.error(err); process.exit(1); });
