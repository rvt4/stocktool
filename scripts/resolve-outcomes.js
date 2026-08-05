'use strict';

const HORIZONS = [6, 12, 36, 60];
const DAY = 86400000;

function config() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  return { url, key };
}
async function supabaseGet(table, params) {
  const { url, key } = config();
  const endpoint = new URL(`${url}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => endpoint.searchParams.set(k, v));
  const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function upsert(table, rows, conflict) {
  if (!rows.length) return;
  const { url, key } = config();
  const endpoint = new URL(`${url}/rest/v1/${table}`);
  endpoint.searchParams.set('on_conflict', conflict);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
}
async function yahooAdjustedClose(ticker, start, end) {
  const p1 = Math.floor(new Date(start).getTime() / 1000) - 7 * 86400;
  const p2 = Math.floor(new Date(end).getTime() / 1000) + 7 * 86400;
  const symbol = encodeURIComponent(ticker.replace('-', '.'));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const result = (await res.json())?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || result?.indicators?.quote?.[0]?.close || [];
  return timestamps.map((t, i) => ({ date: new Date(t * 1000), price: Number(adj[i]) })).filter(p => p.price > 0);
}
function nearest(points, date, maxDays = 10) {
  const target = new Date(date).getTime();
  const best = points.reduce((a, p) => !a || Math.abs(p.date - target) < Math.abs(a.date - target) ? p : a, null);
  return best && Math.abs(best.date - target) <= maxDays * DAY ? best : null;
}
function addMonths(date, months) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function annualized(start, end, days) {
  return start > 0 && end > 0 && days > 0 ? Math.pow(end / start, 365 / days) - 1 : null;
}
async function main() {
  const today = new Date();
  const cutoff = new Date(today.getTime() - 170 * DAY).toISOString().slice(0, 10);
  const predictions = await supabaseGet('model_predictions', {
    select: 'id,ticker,snapshot_date,engine_version,current_price,expected_cagr,rating,category,industry',
    snapshot_date: `lte.${cutoff}`,
    order: 'snapshot_date.asc',
    limit: '50000',
  });
  const existing = await supabaseGet('prediction_outcomes', { select: 'prediction_id,horizon_months', limit: '100000' });
  const done = new Set(existing.map(x => `${x.prediction_id}:${x.horizon_months}`));
  const cache = new Map();
  async function prices(ticker, start) {
    const key = `${ticker}:${start}`;
    if (!cache.has(key)) cache.set(key, yahooAdjustedClose(ticker, start, today.toISOString().slice(0, 10)));
    return cache.get(key);
  }
  const benchmarkCache = {};
  async function benchmark(ticker, start) {
    if (!benchmarkCache[ticker]) benchmarkCache[ticker] = await yahooAdjustedClose(ticker, start, today.toISOString().slice(0, 10));
    return benchmarkCache[ticker];
  }
  const rows = [];
  for (const p of predictions) {
    for (const months of HORIZONS) {
      if (done.has(`${p.id}:${months}`)) continue;
      const target = addMonths(p.snapshot_date, months);
      if (target > today) continue;
      try {
        const stockPoints = await prices(p.ticker, p.snapshot_date);
        const spyPoints = await benchmark('SPY', predictions[0]?.snapshot_date || p.snapshot_date);
        const qqqPoints = await benchmark('QQQ', predictions[0]?.snapshot_date || p.snapshot_date);
        const stockStart = nearest(stockPoints, p.snapshot_date);
        const stockEnd = nearest(stockPoints, target);
        const spyStart = nearest(spyPoints, p.snapshot_date);
        const spyEnd = nearest(spyPoints, target);
        const qqqStart = nearest(qqqPoints, p.snapshot_date);
        const qqqEnd = nearest(qqqPoints, target);
        if (!stockStart || !stockEnd || !spyStart || !spyEnd) continue;
        const days = Math.round((stockEnd.date - stockStart.date) / DAY);
        const realized = annualized(stockStart.price, stockEnd.price, days);
        const spy = annualized(spyStart.price, spyEnd.price, days);
        const qqq = qqqStart && qqqEnd ? annualized(qqqStart.price, qqqEnd.price, days) : null;
        rows.push({
          prediction_id: p.id, ticker: p.ticker, snapshot_date: p.snapshot_date,
          engine_version: p.engine_version, rating: p.rating, category: p.category, industry: p.industry,
          expected_cagr: p.expected_cagr, horizon_months: months, horizon_days: days,
          start_price: stockStart.price, outcome_date: stockEnd.date.toISOString().slice(0, 10), end_price: stockEnd.price,
          realized_cagr: realized, benchmark_ticker: 'SPY', benchmark_start_price: spyStart.price,
          benchmark_end_price: spyEnd.price, benchmark_cagr: spy, realized_alpha: realized - spy,
          qqq_start_price: qqqStart?.price ?? null, qqq_end_price: qqqEnd?.price ?? null,
          qqq_cagr: qqq, alpha_vs_qqq: qqq == null ? null : realized - qqq,
          prediction_error: realized - Number(p.expected_cagr), absolute_error: Math.abs(realized - Number(p.expected_cagr)),
          source: 'yahoo-adjusted-close', resolved_at: new Date().toISOString(),
        });
      } catch (error) { console.warn(`${p.ticker} ${months}m: ${error.message}`); }
    }
  }
  for (let i = 0; i < rows.length; i += 250) await upsert('prediction_outcomes', rows.slice(i, i + 250), 'prediction_id,horizon_months');
  console.log(`Upserted ${rows.length} fixed-horizon outcomes.`);
}
main().catch(error => { console.error(error); process.exit(1); });
