/**
 * Free data fetchers. No paid API keys required.
 * - SEC EDGAR: financials (unlimited, free, needs a User-Agent header)
 * - Stooq: daily prices (free, no key)
 * - Finnhub: free tier for company profile + real-time quote (60 calls/min free key)
 *
 * Finnhub free key: sign up at finnhub.io — the free tier covers quote/profile,
 * which is all we use here (we do NOT use paid analyst-estimate endpoints).
 */

const { estimateFairValue, solveImpliedGrowth } = require('./dcf');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
// SEC requires a real identifying User-Agent (name + email) per their fair-use policy —
// requests without one get rejected. Edit this to your own info before running.
const SEC_HEADERS = { 'User-Agent': 'FreeScreener ryan@example.com' };

// --- SEC EDGAR: ticker -> CIK map (cached) ---
let tickerCikMap = null;
async function getTickerCikMap() {
  if (tickerCikMap) return tickerCikMap;
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
  const json = await res.json();
  tickerCikMap = {};
  Object.values(json).forEach(row => {
    tickerCikMap[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0');
  });
  return tickerCikMap;
}

async function fetchSecFacts(ticker) {
  const map = await getTickerCikMap();
  const cik = map[ticker.toUpperCase()];
  if (!cik) throw new Error(`No CIK found for ${ticker}`);
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`SEC EDGAR fetch failed for ${ticker}: ${res.status}`);
  return res.json();
}

// Extract recent quarterly revenue points from 10-Q filings (same JSON we already
// fetched for annual data — no extra API call). Used to capture *current* growth
// momentum rather than relying solely on a 3-year trailing average, which can badly
// lag an inflecting business (e.g. a cyclical or AI-cycle name accelerating off a trough).
function parseQuarterlyRevenue(facts, maxQuarters = 8) {
  const usGaap = facts.facts?.['us-gaap'] || {};
  const tags = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'];
  const points = [];

  for (const tag of tags) {
    const units = usGaap[tag]?.units;
    if (!units) continue;
    const arr = units.USD || Object.values(units)[0];
    if (!arr) continue;
    arr.filter(x => x.form === '10-Q' && x.start && x.end).forEach(x => {
      const days = (new Date(x.end) - new Date(x.start)) / 86400000;
      if (days >= 80 && days <= 100) { // single-quarter duration, not YTD cumulative
        points.push({ end: x.end, val: x.val });
      }
    });
  }

  const byEnd = {};
  points.forEach(p => { byEnd[p.end] = p; }); // dedupe, last tag checked wins
  return Object.values(byEnd).sort((a, b) => new Date(a.end) - new Date(b.end)).slice(-maxQuarters);
}

// Most recent quarter's YoY revenue growth — a much more current momentum signal
// than a 3yr trailing CAGR. Looks for a quarter ending ~12 months before the latest one.
function recentQuarterYoYGrowth(quarters) {
  if (!quarters || quarters.length < 2) return null;
  const latest = quarters[quarters.length - 1];
  const latestDate = new Date(latest.end);
  let bestMatch = null, bestDiff = Infinity;
  for (const q of quarters.slice(0, -1)) {
    const diffDays = Math.abs((latestDate - new Date(q.end)) / 86400000 - 365);
    if (diffDays < bestDiff) { bestDiff = diffDays; bestMatch = q; }
  }
  if (!bestMatch || bestDiff > 45 || bestMatch.val <= 0) return null; // no good YoY match available
  return latest.val / bestMatch.val - 1;
}

// Blend recent-quarter momentum with the longer trailing trend. Weighted toward the
// recent number so an inflecting business isn't dragged down by stale history, but
// still anchored by the multi-year trend so a single noisy quarter can't dominate.
function blendedForwardGrowth(trailing3yrCagr, recentQoQYoY) {
  if (recentQoQYoY == null) return trailing3yrCagr;
  if (trailing3yrCagr == null) return recentQoQYoY;
  return recentQoQYoY * 0.65 + trailing3yrCagr * 0.35;
}

// Extract a clean annual financials series from raw SEC companyfacts JSON.
// Pulls the most common US-GAAP tags; falls back gracefully if a tag is missing.
function parseAnnualFinancials(facts, maxYears = 10) {
  const usGaap = facts.facts?.['us-gaap'] || {};
  const byYear = {}; // year -> partial record

  function pullAnnual(tag, field) {
    const units = usGaap[tag]?.units;
    if (!units) return;
    const arr = units.USD || units.shares || units['USD/shares'] || Object.values(units)[0];
    if (!arr) return;
    arr.filter(x => x.form === '10-K' && x.fp === 'FY').forEach(x => {
      const year = x.fy;
      byYear[year] = byYear[year] || { year };
      byYear[year][field] = x.val;
    });
  }

  pullAnnual('Revenues', 'revenue');
  pullAnnual('RevenueFromContractWithCustomerExcludingAssessedTax', 'revenue'); // newer tag
  pullAnnual('NetIncomeLoss', 'netIncome');
  pullAnnual('GrossProfit', 'grossProfit');
  pullAnnual('OperatingIncomeLoss', 'operatingIncome');
  pullAnnual('NetCashProvidedByUsedInOperatingActivities', 'cfo');
  // Capex is reported under several different XBRL tags depending on the company —
  // pull weaker/partial fallbacks FIRST, then the most common tag LAST so it takes
  // priority wherever it's available (pullAnnual overwrites per-year on each call).
  // Without these fallbacks, FCF (and therefore fair value / MOS) silently comes back
  // null for any company that doesn't use the primary tag — this was happening to
  // several large, well-covered names.
  pullAnnual('PaymentsToAcquireProductiveAssets', 'capex');
  pullAnnual('PaymentsForCapitalImprovements', 'capex');
  pullAnnual('PaymentsToAcquireOtherPropertyPlantAndEquipment', 'capex');
  pullAnnual('PaymentsToAcquirePropertyPlantAndEquipment', 'capex');
  pullAnnual('CommonStockDividendsPerShareDeclared', 'dividendPerShare');
  pullAnnual('CommonStockSharesOutstanding', 'sharesOutTTM');
  pullAnnual('LongTermDebtNoncurrent', 'longTermDebt');
  pullAnnual('CashAndCashEquivalentsAtCarryingValue', 'cash');
  pullAnnual('InventoryNet', 'inventory');
  pullAnnual('CostOfGoodsAndServicesSold', 'cogs');

  const years = Object.values(byYear)
    .filter(y => y.revenue) // require at least revenue
    .sort((a, b) => a.year - b.year)
    .slice(-maxYears)
    .map(y => {
      const fcf = (y.cfo != null && y.capex != null) ? y.cfo - y.capex : null;
      const grossMargin = (y.grossProfit != null && y.revenue) ? y.grossProfit / y.revenue
        : (y.cogs != null && y.revenue) ? (y.revenue - y.cogs) / y.revenue : null;
      const opMargin = (y.operatingIncome != null && y.revenue) ? y.operatingIncome / y.revenue : null;
      const invested = (y.longTermDebt || 0) + (y.cash != null ? -y.cash : 0); // rough proxy, refine as needed
      const roic = (y.operatingIncome != null && invested) ? y.operatingIncome / Math.abs(invested) : null;
      const inventoryTurnover = (y.cogs != null && y.inventory) ? y.cogs / y.inventory : null;
      return { ...y, fcf, grossMargin, opMargin, roic, inventoryTurnover };
    });

  return years;
}

// --- Stooq: free daily price history, no key needed ---
async function fetchStooqPrice(ticker) {
  const symbol = `${ticker.toLowerCase()}.us`;
  const res = await fetch(`https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`);
  const csv = await res.text();
  const [, row] = csv.trim().split('\n');
  if (!row) return null;
  const cols = row.split(',');
  return { date: cols[0], close: parseFloat(cols[6]) };
}

async function fetchStooqHistory(ticker, years = 5) {
  const symbol = `${ticker.toLowerCase()}.us`;
  const res = await fetch(`https://stooq.com/q/d/l/?s=${symbol}&i=d`);
  const csv = await res.text();
  const rows = csv.trim().split('\n').slice(1).map(r => r.split(','));
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return rows
    .filter(r => new Date(r[0]) >= cutoff)
    .map(r => ({ date: r[0], close: parseFloat(r[4]) }));
}

// --- Finnhub free tier: profile + quote only (no paid estimates endpoints) ---
async function fetchFinnhubProfile(ticker) {
  if (!FINNHUB_KEY) return null;
  const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`);
  return res.json();
}
async function fetchFinnhubQuote(ticker) {
  if (!FINNHUB_KEY) return null;
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`);
  return res.json();
}

// UNCONFIRMED free-tier availability — Finnhub's docs list this endpoint but sources
// disagree on whether it's actually unlocked on a free key or premium-gated. Wired in
// with a safe fallback: if it 403s or errors, we just don't get this signal and fall
// back to the SEC-derived blended growth below. Costs nothing to try.
async function fetchFinnhubRevenueEstimate(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/revenue-estimate?symbol=${ticker}&freq=annual&token=${FINNHUB_KEY}`);
    if (!res.ok) return null;
    const json = await res.json();
    const est = json?.data?.[0]; // most recent forward annual estimate
    if (!est?.revenueAvg || !json?.data?.[1]?.revenueAvg) return null;
    // forward YoY growth implied by consensus estimate for the next fiscal year
    return est.revenueAvg / json.data[1].revenueAvg - 1;
  } catch {
    return null;
  }
}

// --- Assemble the full stock object the scoring engine expects ---
// Note: sector should be passed in (e.g. from your watchlist.json / index CSV) —
// we don't call Finnhub's profile endpoint anymore, which halves Finnhub API usage
// (quote only) and keeps us comfortably under the 60 calls/min free-tier limit
// even across a 1000+ ticker watchlist.
async function buildStockRecord(ticker, sector) {
  const [facts, quote, priceHistory, finnhubRevGrowth] = await Promise.all([
    fetchSecFacts(ticker),
    fetchFinnhubQuote(ticker).catch(() => null),
    fetchStooqHistory(ticker, 5).catch(() => []),
    fetchFinnhubRevenueEstimate(ticker).catch(() => null),
  ]);

  const years = parseAnnualFinancials(facts);
  const quarters = parseQuarterlyRevenue(facts);
  const last = years[years.length - 1] || {};
  const currentPrice = quote?.c || (priceHistory.length ? priceHistory[priceHistory.length - 1].close : null);
  const sharesOut = last.sharesOutTTM;
  const marketCap = currentPrice && sharesOut ? currentPrice * sharesOut : null;
  const eps = last.netIncome && sharesOut ? last.netIncome / sharesOut : null;
  const pe = currentPrice && eps ? currentPrice / eps : null;
  const debtToEbitda = last.longTermDebt && last.operatingIncome ? last.longTermDebt / last.operatingIncome : null;
  const dividendYield = last.dividendPerShare && currentPrice ? last.dividendPerShare / currentPrice : 0;
  const fcfYield = last.fcf && marketCap ? last.fcf / marketCap : null;
  const evEbitda = marketCap && last.operatingIncome ? (marketCap + (last.longTermDebt || 0) - (last.cash || 0)) / last.operatingIncome : null;

  years.forEach(y => y.debtToEbitda = y.longTermDebt && y.operatingIncome ? y.longTermDebt / y.operatingIncome : null);

  // Growth signal priority: real analyst consensus (if the Finnhub endpoint worked) >
  // blended recent-quarter momentum + trailing 3yr trend > trailing 3yr alone.
  let growthYear1 = null;
  if (finnhubRevGrowth != null) {
    growthYear1 = finnhubRevGrowth;
  } else if (years.length >= 4) {
    const first = years[years.length - 4];
    const trailing3yr = first.revenue > 0 ? Math.pow(last.revenue / first.revenue, 1 / 3) - 1 : null;
    const recentQoQ = recentQuarterYoYGrowth(quarters);
    growthYear1 = blendedForwardGrowth(trailing3yr, recentQoQ);
  }

  const stockShell = {
    ticker,
    sector: sector || 'Unknown',
    financials: { years },
    valuation: {
      pe, forwardPe: pe, evEbitda, fcfYield, marketCap,
      ev: marketCap ? marketCap + (last.longTermDebt || 0) - (last.cash || 0) : null,
      dividendYield,
      fairValueEstimate: null,
      growthSource: finnhubRevGrowth != null ? 'analyst_consensus' : 'blended_sec_data',
    },
    price: { current: currentPrice },
    quarterly: quarters,
    historicalMultiples: { evEbitda: [], forwardPe: [] }, // optional: backfill from priceHistory + trailing EPS
    earningsCallText: null, // optional: plug in a free transcript source if you find one
  };

  // Reverse-DCF fair value, using the best available growth signal above (fading to
  // 2.5% terminal growth over 10yrs — see dcf.js to adjust).
  if (years.length >= 3 && growthYear1 != null) {
    const dcfResult = estimateFairValue(stockShell, growthYear1);
    stockShell.valuation.fairValueEstimate = dcfResult.fairValuePerShare ?? null;
    stockShell.valuation.dcfAssumptions = dcfResult.assumptions ?? null;
    // Market-implied growth: what growth rate would the CURRENT price require to be fair,
    // holding everything else constant? Shown alongside our estimate rather than used to
    // penalize — lets you judge whether the market's implied story (e.g. an AI-cycle
    // re-rating) is credible, instead of the tool silently asserting "overvalued."
    if (dcfResult.marginOfSafety != null) {
      const impliedResult = solveImpliedGrowth({
        fcfBase: last.fcf,
        terminalGrowth: dcfResult.assumptions.terminalGrowth,
        discountRate: dcfResult.assumptions.discountRate,
        years: dcfResult.assumptions.years,
        netDebt: dcfResult.assumptions.netDebt,
        sharesOut: last.sharesOutTTM,
        targetPricePerShare: currentPrice,
      });
      stockShell.valuation.marketImpliedGrowth = impliedResult.impliedGrowth;
      stockShell.valuation.marketImpliedGrowthNote = impliedResult.reason !== 'converged' ? impliedResult.reason : null;
    }
  }

  return stockShell;
}

const api = {
  fetchSecFacts, parseAnnualFinancials, parseQuarterlyRevenue, recentQuarterYoYGrowth, blendedForwardGrowth,
  fetchStooqPrice, fetchStooqHistory,
  fetchFinnhubProfile, fetchFinnhubQuote, fetchFinnhubRevenueEstimate,
  buildStockRecord, getTickerCikMap,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
