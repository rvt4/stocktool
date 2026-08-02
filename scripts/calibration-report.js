'use strict';

const fs = require('fs');
const path = require('path');

function config() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  return { url, key };
}

async function get(table, params) {
  const { url, key } = config();
  const endpoint = new URL(`${url}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params || {})) endpoint.searchParams.set(k, v);
  const response = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`${table} fetch failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function corr(a, b) {
  const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map(p => p[0]));
  const my = mean(pairs.map(p => p[1]));
  const num = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const dx = Math.sqrt(pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0));
  const dy = Math.sqrt(pairs.reduce((s, [, y]) => s + (y - my) ** 2, 0));
  return dx && dy ? num / (dx * dy) : null;
}
function summarize(rows) {
  const errors = rows.map(r => Number(r.realized_cagr) - Number(r.expected_cagr)).filter(Number.isFinite);
  return {
    observations: rows.length,
    predictedMean: mean(rows.map(r => Number(r.expected_cagr))),
    realizedMean: mean(rows.map(r => Number(r.realized_cagr))),
    bias: mean(errors),
    medianError: median(errors),
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map(x => x * x)) || 0),
    correlation: corr(rows.map(r => Number(r.expected_cagr)), rows.map(r => Number(r.realized_cagr))),
    hitRatePositive: mean(rows.map(r => Number(r.realized_cagr) > 0 ? 1 : 0)),
    hitRateBeatSPY: mean(rows.filter(r => Number.isFinite(Number(r.benchmark_cagr))).map(r => Number(r.realized_cagr) > Number(r.benchmark_cagr) ? 1 : 0)),
  };
}
function group(rows, key) {
  const out = {};
  for (const value of [...new Set(rows.map(r => r[key] || 'Unknown'))]) out[value] = summarize(rows.filter(r => (r[key] || 'Unknown') === value));
  return out;
}

async function main() {
  const rows = await get('prediction_outcomes', {
    select: '*',
    order: 'snapshot_date.asc',
    limit: '50000',
  });
  const mature = rows.filter(r => Number(r.horizon_days) >= 330 && Number.isFinite(Number(r.realized_cagr)));
  const report = {
    generatedAt: new Date().toISOString(),
    status: mature.length >= 100 ? 'active' : 'collecting-history',
    minimumRecommendedObservations: 100,
    overall: summarize(mature),
    byRating: group(mature, 'rating'),
    byCategory: group(mature, 'category'),
    byIndustry: group(mature, 'industry'),
    byEngineVersion: group(mature, 'engine_version'),
  };
  const out = path.join(__dirname, '..', 'data', 'calibration-dashboard.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.overall, null, 2));
  console.log(`Wrote ${out}`);
}

main().catch(error => { console.error(error); process.exit(1); });
