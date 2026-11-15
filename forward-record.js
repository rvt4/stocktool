'use strict';
// Build 87: forward (out-of-sample) record of the FROZEN strategy.
// Every backtest number so far comes from the same 2019-2025 history that the rules were tuned on. The only
// truly independent test is the future, so once a month the nightly saves what the strategy says today, and
// the report checks those calls against what actually happened 12 and 24 months later.
//
// Saved monthly (first nightly of each month) in data/forward-record.json:
//   strategy version, SPY price, the buy list (with projected and cautious returns, quality, rank), and the
//   price of every company in the universe (so any past call can be scored later).
// Report (every nightly) in data/forward-report.json:
//   for each snapshot 12+ months old: buy list equal-weight price return vs SPY, share of names beating SPY,
//   and projected vs realized annual returns. Prices only (dividends ignored on both sides).
const fs = require('fs');
const path = require('path');

const finite = v => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const median = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const mean = a => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

function snapshotOf(stocks, { spyPrice, strategy, now, isCandidate }) {
  const prices = {};
  for (const s of stocks) { const p = finite(s.currentPrice); if (p > 0) prices[s.ticker] = +p.toFixed(4); }
  const buyList = stocks.filter(isCandidate).map(s => ({
    ticker: s.ticker, price: finite(s.currentPrice), expected: finite(s.expectedCAGR), cautious: finite(s.underwrittenCAGR),
    quality: finite(s.qualityScore), rank: finite(s.overallRank), sector: s.sector || null,
  }));
  return { asOf: now.toISOString().slice(0, 10), strategy, spyPrice: finite(spyPrice), buyList, prices };
}

function evaluate(store, latestPrices, latestSpy, now) {
  const out = [];
  const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
  for (const snap of store.snapshots) {
    // Score against the snapshot closest to 12 and 24 months later (or today's prices if that's the latest).
    for (const months of [12, 24]) {
      const later = [...store.snapshots, { asOf: now.toISOString().slice(0, 10), prices: latestPrices, spyPrice: latestSpy }]
        .filter(s => daysBetween(snap.asOf, s.asOf) >= months * 30.4 - 20)
        .sort((a, b) => a.asOf.localeCompare(b.asOf))[0];
      if (!later || !(snap.spyPrice > 0) || !(later.spyPrice > 0) || !snap.buyList.length) continue;
      const years = daysBetween(snap.asOf, later.asOf) / 365.25;
      const spy = later.spyPrice / snap.spyPrice - 1;
      const rows = snap.buyList.map(b => { const p1 = finite(later.prices?.[b.ticker]); return b.price > 0 && p1 > 0 ? { ...b, ret: p1 / b.price - 1 } : null; }).filter(Boolean);
      if (!rows.length) continue;
      const ann = r => Math.pow(1 + r, 1 / years) - 1;
      const listRet = mean(rows.map(r => r.ret));
      out.push({
        from: snap.asOf, to: later.asOf, months, strategy: snap.strategy, names: rows.length, missing: snap.buyList.length - rows.length,
        buyListReturn: listRet, spyReturn: spy, excess: listRet - spy,
        shareBeatingSpy: rows.filter(r => r.ret > spy).length / rows.length,
        medianProjected: median(rows.map(r => r.expected)), medianCautious: median(rows.map(r => r.cautious)),
        medianRealizedAnnual: median(rows.map(r => ann(r.ret))), spyAnnual: ann(spy),
      });
    }
  }
  const sum = m => { const v = out.filter(o => o.months === m); return v.length ? { periods: v.length, averageExcess: mean(v.map(o => o.excess)),
    periodsBeatingSpy: v.filter(o => o.excess > 0).length, averageShareBeatingSpy: mean(v.map(o => o.shareBeatingSpy)) } : null; };
  return { summary12m: sum(12), summary24m: sum(24), periods: out };
}

function recordForward(output, { spyPrice, strategy, isCandidate, dataDir = path.join(__dirname, 'data'), now = new Date() } = {}) {
  const file = path.join(dataDir, 'forward-record.json');
  let store = { readMe: 'Monthly forward record of the frozen strategy (Build 87). See forward-record.js.', snapshots: [] };
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(s.snapshots)) store = s; } catch (e) {}
  const month = now.toISOString().slice(0, 7);
  const stocks = output.stocks || [];
  if (!store.snapshots.some(s => String(s.asOf).slice(0, 7) === month) && finite(spyPrice) > 0) {
    store.snapshots.push(snapshotOf(stocks, { spyPrice, strategy, now, isCandidate }));
    fs.writeFileSync(file, JSON.stringify(store));
  }
  const latestPrices = {}; for (const s of stocks) { const p = finite(s.currentPrice); if (p > 0) latestPrices[s.ticker] = p; }
  const report = { generatedAt: now.toISOString(), strategy, snapshots: store.snapshots.length, firstSnapshot: store.snapshots[0]?.asOf ?? null,
    readMe: 'Out-of-sample check of the frozen strategy. excess = buy list equal-weight price return minus SPY over the same dates. Nothing here was used to tune the rules.',
    ...evaluate(store, latestPrices, finite(spyPrice), now) };
  fs.writeFileSync(path.join(dataDir, 'forward-report.json'), JSON.stringify(report, null, 1));
  return report;
}

module.exports = { recordForward, evaluate, snapshotOf };
