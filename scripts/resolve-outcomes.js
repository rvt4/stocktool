'use strict';

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
  const p1 = Math.floor(new Date(start).getTime() / 1000);
  const p2 = Math.floor(new Date(end).getTime() / 1000) + 86400;
  const symbol = encodeURIComponent(ticker.replace('-', '.'));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const result = (await res.json())?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((t, i) => ({ date: new Date(t * 1000), price: Number(adj[i]) })).filter(p => p.price > 0);
  return points;
}
function nearest(points, date) {
  const target = new Date(date).getTime();
  return points.reduce((best, p) => !best || Math.abs(p.date - target) < Math.abs(best.date - target) ? p : best, null);
}
function annualized(start, end, days) {
  return start > 0 && end > 0 && days > 0 ? Math.pow(end / start, 365 / days) - 1 : null;
}
async function main() {
  const cutoff = new Date(Date.now() - 330 * 86400000).toISOString().slice(0, 10);
  const predictions = await supabaseGet('model_predictions', {
    select: 'id,ticker,snapshot_date,engine_version,current_price,expected_cagr,rating,category,industry',
    snapshot_date: `lte.${cutoff}`,
    order: 'snapshot_date.asc',
    limit: '50000',
  });
  const existing = await supabaseGet('prediction_outcomes', { select: 'prediction_id', limit: '50000' });
  const done = new Set(existing.map(x => x.prediction_id));
  const pending = predictions.filter(p => !done.has(p.id));
  const byTicker = new Map();
  for (const p of pending) {
    if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, []);
    byTicker.get(p.ticker).push(p);
  }
  const rows = [];
  for (const [ticker, items] of byTicker) {
    const start = items[0].snapshot_date;
    const end = new Date().toISOString().slice(0, 10);
    try {
      const prices = await yahooAdjustedClose(ticker, start, end);
      for (const p of items) {
        const startPoint = nearest(prices, p.snapshot_date);
        const endPoint = prices[prices.length - 1];
        if (!startPoint || !endPoint) continue;
        const days = Math.round((endPoint.date - startPoint.date) / 86400000);
        if (days < 300) continue;
        rows.push({
          prediction_id: p.id,
          ticker: p.ticker,
          snapshot_date: p.snapshot_date,
          engine_version: p.engine_version,
          rating: p.rating,
          category: p.category,
          industry: p.industry,
          expected_cagr: p.expected_cagr,
          start_price: p.current_price,
          outcome_date: endPoint.date.toISOString().slice(0, 10),
          end_price: endPoint.price,
          horizon_days: days,
          realized_cagr: annualized(p.current_price, endPoint.price, days),
          source: 'yahoo-adjusted-close',
          resolved_at: new Date().toISOString(),
        });
      }
      console.log(`${ticker}: ${items.length} predictions, ${rows.length} total outcomes`);
    } catch (error) {
      console.warn(error.message);
    }
  }
  for (let i = 0; i < rows.length; i += 250) await upsert('prediction_outcomes', rows.slice(i, i + 250), 'prediction_id');
  console.log(`Upserted ${rows.length} outcomes.`);
}
main().catch(error => { console.error(error); process.exit(1); });
