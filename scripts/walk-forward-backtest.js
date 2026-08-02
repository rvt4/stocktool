'use strict';

const fs = require('fs');
const path = require('path');

function mean(xs) { const a = xs.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function std(xs) { const m = mean(xs); return m == null ? null : Math.sqrt(mean(xs.map(x => (x - m) ** 2))); }
function maxDrawdown(equity) {
  let peak = -Infinity, worst = 0;
  for (const x of equity) { peak = Math.max(peak, x); worst = Math.min(worst, x / peak - 1); }
  return worst;
}
function parseArgs() {
  const args = Object.fromEntries(process.argv.slice(2).map(x => x.split('=')));
  return { topN: Number(args['--top'] || 20), minConfidence: Number(args['--min-confidence'] || 60) };
}
async function loadOutcomes() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  const endpoint = new URL(`${url}/rest/v1/prediction_outcomes`);
  endpoint.searchParams.set('select', '*,model_predictions(confidence,ic_score,margin_of_safety,success_probability)');
  endpoint.searchParams.set('order', 'snapshot_date.asc');
  endpoint.searchParams.set('limit', '50000');
  const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
function score(row) {
  const p = row.model_predictions || {};
  const expected = Number(row.expected_cagr) || -1;
  const confidence = Number(p.confidence) || 0;
  const ic = Number(p.ic_score) || 0;
  const mos = Number(p.margin_of_safety) || 0;
  return expected * 100 + confidence * 0.08 + ic * 0.05 + mos * 4;
}
async function main() {
  const { topN, minConfidence } = parseArgs();
  const rows = await loadOutcomes();
  const dates = [...new Set(rows.map(r => r.snapshot_date))].sort();
  const periods = [];
  let equity = 1;
  const curve = [equity];
  for (const date of dates) {
    const universe = rows.filter(r => r.snapshot_date === date && Number(r.horizon_days) >= 300 && Number(r.model_predictions?.confidence || 0) >= minConfidence);
    const selected = universe.sort((a, b) => score(b) - score(a)).slice(0, topN);
    if (!selected.length) continue;
    const portfolioReturn = mean(selected.map(r => Math.pow(1 + Number(r.realized_cagr), Number(r.horizon_days) / 365) - 1));
    equity *= 1 + portfolioReturn;
    curve.push(equity);
    periods.push({ date, holdings: selected.length, return: portfolioReturn, tickers: selected.map(r => r.ticker) });
  }
  const returns = periods.map(p => p.return);
  const report = {
    generatedAt: new Date().toISOString(),
    methodology: 'Prospective walk-forward test using only stored model snapshots. This is not a reconstructed 10-year point-in-time fundamentals backtest.',
    topN,
    minConfidence,
    periods: periods.length,
    cumulativeReturn: equity - 1,
    arithmeticMeanPeriodReturn: mean(returns),
    volatility: std(returns),
    sharpeLike: std(returns) ? mean(returns) / std(returns) : null,
    maxDrawdown: maxDrawdown(curve),
    periodDetails: periods,
  };
  const out = path.join(__dirname, '..', 'data', 'walk-forward-backtest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, periodDetails: undefined }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
