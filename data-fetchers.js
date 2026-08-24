/**
 * Free data fetchers. No paid API keys required.
 * - SEC EDGAR: financials (unlimited, free, needs a User-Agent header)
 * - Stooq: daily prices (free, no key)
 * - Finnhub: free tier for company profile + real-time quote (60 calls/min free key)
 *
 * Finnhub free key: sign up at finnhub.io — the free tier covers quote/profile,
 * which is all we use here (we do NOT use paid analyst-estimate endpoints).
 */

// Note: dcf.js is no longer imported here — valuation moved to a second pass in
// valuation-methods.js, which runs after the full watchlist has been fetched (see
// run-screener.js). See the comment on buildStockRecord()'s return value below.

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
// SEC requires a real identifying User-Agent (name + email) per their fair-use policy —
// requests without one get rejected. Edit this to your own info before running.
const SEC_HEADERS = {
  'User-Agent': process.env.SEC_USER_AGENT || 'FreeScreener contact@example.com'
};


const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const REQUEST_MAX_RETRIES = Number(process.env.REQUEST_MAX_RETRIES || 2);

const SEC_CIK_FALLBACKS = { HOLX: '0000859737', OZK: '0001569650' };

const SEC_TICKER_ALIASES = {
  BRKB: 'BRK-B',
  BRKA: 'BRK-A',
  BFB: 'BF-B',
  HEIA: 'HEI-A',
  UHALB: 'UHAL-B',
  CWENA: 'CWEN-A',
  LENB: 'LEN-B',
  LLYVK: 'LLYVK',
};

function normalizeSecTicker(ticker) {
  const raw = String(ticker || '').trim().toUpperCase().replace(/\./g, '-');
  return SEC_TICKER_ALIASES[raw] || raw;
}

function normalizeFinnhubTicker(ticker) {
  const secTicker = normalizeSecTicker(ticker);
  return /^(BRK|BF|HEI|UHAL|CWEN|LEN)-[AB]$/.test(secTicker)
    ? secTicker.replace('-', '.')
    : secTicker;
}

async function fetchWithTimeout(url, options = {}, label = 'request') {
  let lastError = null;
  for (let attempt = 0; attempt <= REQUEST_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastError = new Error(`${label} HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err?.name === 'AbortError'
        ? new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`)
        : err;
    }
    if (attempt < REQUEST_MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError || new Error(`${label} failed`);
}

// --- SEC EDGAR: ticker -> CIK map (cached) ---
let tickerCikMap = null;
async function getTickerCikMap() {
  if (tickerCikMap) return tickerCikMap;
  const res = await fetchWithTimeout('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS }, 'SEC ticker map');
  const json = await res.json();
  tickerCikMap = {};
  Object.values(json).forEach(row => {
    tickerCikMap[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0');
  });
  return tickerCikMap;
}

async function fetchSecFacts(ticker) {
  const map = await getTickerCikMap();
  const normalized = normalizeSecTicker(ticker);
  const candidates = [normalized, normalized.replace(/-/g, ''), String(ticker || '').toUpperCase()];
  const mappedTicker = candidates.find(t => map[t]);
  const cik = mappedTicker ? map[mappedTicker] : SEC_CIK_FALLBACKS[normalized];
  if (!cik) throw new Error(`No CIK found for ${ticker} (normalized ${normalized})`);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const res = await fetchWithTimeout(url, { headers: SEC_HEADERS }, `SEC EDGAR ${ticker}`);
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
  const dei = facts.facts?.dei || {};
  const byYear = {}; // year -> partial record

  function pullAnnual(tag, field, { additive = false, preferLargest = false } = {}) {
    const units = usGaap[tag]?.units;
    if (!units) return;
    const arr = units.USD || units.shares || units['USD/shares'] || Object.values(units)[0];
    if (!arr) return;

    // SEC facts are inconsistent: many valid 10-K annual facts omit fp='FY', and
    // some use an amendment form. Accept annual-duration 10-K/10-K/A facts and keep
    // the most recently filed fact for each fiscal year.
    const candidates = arr
      .filter(x => (x.form === '10-K' || x.form === '10-K/A') && x.val != null)
      .filter(x => {
        if (!x.start || !x.end) return x.fp === 'FY';
        const days = (new Date(x.end) - new Date(x.start)) / 86400000;
        return x.fp === 'FY' || (days >= 300 && days <= 430);
      })
      .sort((a, b) => String(a.filed || '').localeCompare(String(b.filed || '')));

    for (const x of candidates) {
      const year = x.end ? new Date(x.end).getUTCFullYear() : Number(x.fy); // period year, not filing fiscal-year label
      if (!year || !Number.isFinite(Number(x.val))) continue;
      byYear[year] = byYear[year] || { year };
      if (additive) {
        byYear[year][field] = (Number(byYear[year][field]) || 0) + Number(x.val);
        byYear[year][`${field}Source`] = tag;
      } else if (!preferLargest || !Number.isFinite(Number(byYear[year][field])) || Number(x.val) > Number(byYear[year][field])) {
        // Revenue tags frequently overlap. For diversified and financial companies,
        // a narrower tag (for example a single operating segment) can be filed after
        // the consolidated tag. Keep the largest annual-duration consolidated-scale
        // fact instead of blindly allowing the final tag to overwrite total revenue.
        byYear[year][field] = Number(x.val);
        byYear[year][`${field}Source`] = tag;
      }
    }
  }

  // Point-in-time DEI facts (especially EntityCommonStockSharesOutstanding) do not
  // consistently carry fp='FY'. Keep them as a last-resort share candidate keyed to
  // the filing fiscal year. For multi-class issuers this is not automatically summed;
  // the later reconciliation step chooses the candidate that best agrees with EPS,
  // prior years, or market-cap evidence.
  function pullDeiAnnual(tag, field) {
    const units = dei[tag]?.units;
    if (!units) return;
    const arr = units.shares || Object.values(units)[0];
    if (!arr) return;
    arr.filter(x => x.form === '10-K').forEach(x => {
      const year = x.end ? new Date(x.end).getUTCFullYear() : x.fy; // period year, not filing fiscal-year label
      if (!year || !Number.isFinite(Number(x.val))) return;
      byYear[year] = byYear[year] || { year };
      const key = `${field}Candidates`;
      byYear[year][key] = byYear[year][key] || [];
      byYear[year][key].push({ value: Number(x.val), source: `dei:${tag}` });
    });
  }

  // Revenue is the least standardized SEC field. Pull broad fallbacks first and
  // preferred general-company tags last so the strongest fact wins per fiscal year.
  pullAnnual('PremiumsEarnedNet', 'revenue', { preferLargest: true });
  pullAnnual('InvestmentIncomeInterestAndDividend', 'revenue', { preferLargest: true });
  pullAnnual('InterestAndDividendIncomeOperating', 'revenue', { preferLargest: true });
  pullAnnual('InterestIncomeExpenseNonoperatingNet', 'revenue', { preferLargest: true });
  pullAnnual('RevenuesNetOfInterestExpense', 'revenue', { preferLargest: true }); // banks / brokers
  pullAnnual('OperatingRevenues', 'revenue', { preferLargest: true });
  pullAnnual('SalesRevenueNet', 'revenue', { preferLargest: true });
  pullAnnual('RevenueFromContractWithCustomerIncludingAssessedTax', 'revenue', { preferLargest: true });
  pullAnnual('Revenues', 'revenue', { preferLargest: true });
  pullAnnual('RevenueFromContractWithCustomerExcludingAssessedTax', 'revenue', { preferLargest: true }); // preferred modern tag
  pullAnnual('NetIncomeLoss', 'netIncome');
  // Ownership-scope facts. Consolidated net income can include large non-controlling
  // interests (UP-C / holding-company structures, insurers, partnerships). Keep the
  // parent/common-holder earnings separately so per-share valuation does not divide
  // whole-enterprise economics by only the public Class A denominator.
  pullAnnual('NetIncomeLossAttributableToParent', 'netIncomeAttributableToParent');
  pullAnnual('NetIncomeLossAvailableToCommonStockholdersBasic', 'netIncomeAttributableToCommon');
  pullAnnual('NetIncomeLossAttributableToNoncontrollingInterest', 'netIncomeAttributableToNCI');
  pullAnnual('GrossProfit', 'grossProfit');
  // Spreadsheet-style operating drivers. These let the forecast model the business from
  // revenue -> gross profit -> operating expenses -> earnings instead of independently
  // extrapolating headline margins. SEC tagging is uneven, so each field is optional and
  // the forecast falls back to the consolidated operating history when coverage is weak.
  pullAnnual('CostOfRevenue', 'costOfRevenue', { preferLargest: true });
  pullAnnual('CostOfGoodsAndServicesSold', 'costOfRevenue', { preferLargest: true });
  pullAnnual('ResearchAndDevelopmentExpense', 'researchAndDevelopment');
  pullAnnual('SellingGeneralAndAdministrativeExpense', 'sellingGeneralAdministrative');
  pullAnnual('SellingAndMarketingExpense', 'sellingAndMarketing');
  pullAnnual('GeneralAndAdministrativeExpense', 'generalAdministrative');
  pullAnnual('IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'pretaxIncome');
  pullAnnual('IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments', 'pretaxIncome');
  pullAnnual('IncomeTaxExpenseBenefit', 'incomeTaxExpense');
  // Acquisition accounting can make GAAP earnings a poor proxy for the normalized earnings
  // power used in a long-term valuation spreadsheet. Keep identifiable intangible
  // amortization separate so the forecast can show both GAAP and investor-normalized EPS.
  pullAnnual('FiniteLivedIntangibleAssetsAmortizationExpense', 'intangibleAmortization');
  pullAnnual('AmortizationOfIntangibleAssets', 'intangibleAmortization');
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
  pullAnnual('CommonStockSharesOutstanding', 'sharesOutTTM'); // cover-page fallback, noisy
  // Diluted weighted-average share count (income statement denominator) is a much
  // steadier figure than the cover-page CommonStockSharesOutstanding above — it's a
  // period average rather than a single point-in-time snapshot, so it's far less prone
  // to the split/offering-driven noise that caused problems earlier. Pulled AFTER the
  // fallback so it takes priority wherever available.
  pullAnnual('WeightedAverageNumberOfSharesOutstandingBasicAndDiluted', 'sharesOutTTM');
  pullAnnual('WeightedAverageNumberOfDilutedSharesOutstanding', 'sharesOutTTM');
  pullAnnual('WeightedAverageNumberOfSharesOutstandingDiluted', 'sharesOutTTM');
  pullAnnual('WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'sharesOutTTM');
  pullAnnual('EarningsPerShareDiluted', 'dilutedEPS');
  pullAnnual('EarningsPerShareDilutedIncludingExtraordinaryItems', 'dilutedEPS');
  pullDeiAnnual('EntityCommonStockSharesOutstanding', 'sharesOutTTM');
  // Stock-based compensation — needed to model real dilution cost and flag heavy-SBC
  // names. Reported under either tag depending on the company.
  pullAnnual('ShareBasedCompensation', 'sbc');
  pullAnnual('AllocatedShareBasedCompensationExpense', 'sbc');
  // Balance-sheet and capital-allocation facts. Pull broad fallbacks first,
  // then preferred tags last so later scoring can distinguish reinvestment,
  // leverage, repurchases, issuance, dividends and acquisition spending.
  pullAnnual('LongTermDebt', 'longTermDebt');
  pullAnnual('LongTermDebtAndFinanceLeaseObligationsNoncurrent', 'longTermDebt');
  pullAnnual('LongTermDebtNoncurrent', 'longTermDebt');
  pullAnnual('ShortTermBorrowings', 'shortTermDebt');
  pullAnnual('LongTermDebtCurrent', 'shortTermDebt');
  pullAnnual('LongTermDebtAndFinanceLeaseObligationsCurrent', 'shortTermDebt');
  pullAnnual('StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'stockholdersEquityIncludingNCI');
  pullAnnual('NoncontrollingInterestInConsolidatedEntity', 'noncontrollingInterest');
  pullAnnual('StockholdersEquity', 'stockholdersEquity');
  pullAnnual('CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'cash');
  pullAnnual('CashAndCashEquivalentsAtCarryingValue', 'cash');
  pullAnnual('PaymentsForRepurchaseOfCommonStock', 'shareRepurchases');
  pullAnnual('PaymentsForRepurchaseOfEquity', 'shareRepurchases');
  pullAnnual('ProceedsFromStockOptionsExercised', 'shareIssuanceProceeds');
  pullAnnual('ProceedsFromIssuanceOfCommonStock', 'shareIssuanceProceeds');
  pullAnnual('ProceedsFromStockIssued', 'shareIssuanceProceeds');
  pullAnnual('PaymentsOfDividends', 'dividendsPaid');
  pullAnnual('PaymentsOfDividendsCommonStock', 'dividendsPaid');
  pullAnnual('PaymentsToAcquireBusinessesNetOfCashAcquired', 'acquisitions');
  pullAnnual('PaymentsToAcquireBusinessesGross', 'acquisitions');
  pullAnnual('InventoryNet', 'inventory');
  pullAnnual('CostOfGoodsAndServicesSold', 'cogs');
  pullAnnual('DepreciationDepletionAndAmortization', 'da');
  pullAnnual('DepreciationAmortizationAndAccretionNet', 'da'); // fallback tag

  // SEC Company Facts normally reports share counts as raw shares, but a small
  // number of filings expose values scaled in thousands or millions. Reconcile
  // the reported value against the independently implied diluted share count:
  //
  //     diluted shares ~= net income / diluted EPS
  //
  // This prevents a value such as 716.4 (meaning 716.4 million shares) from
  // being interpreted as only 716 shares and inflating per-share valuations.
  const shareScaleCandidates = [1, 1e3, 1e6, 1e9];
  const detectedShareScales = [];

  // Use a DEI cover-page candidate only when the income-statement denominator is
  // absent. Multiple contexts/classes can exist; choose the largest plausible value,
  // then let the EPS/prior-year reconciliation below validate or replace it.
  Object.values(byYear).forEach(y => {
    if (!(Number.isFinite(Number(y.sharesOutTTM)) && Number(y.sharesOutTTM) > 0)) {
      const candidates = (y.sharesOutTTMCandidates || [])
        .map(c => ({ ...c, value: Number(c.value) }))
        .filter(c => Number.isFinite(c.value) && c.value > 0);
      if (candidates.length) {
        const chosen = candidates.sort((a, b) => b.value - a.value)[0];
        y.sharesOutTTM = chosen.value;
        y.sharesCandidateSource = chosen.source;
      }
    }
  });

  Object.values(byYear).forEach(y => {
    const rawShares = Number(y.sharesOutTTM);
    if (!Number.isFinite(rawShares) || rawShares <= 0) return;

    y.rawSharesOutTTM = rawShares;

    const netIncome = Number(y.netIncome);
    const dilutedEPS = Number(y.dilutedEPS);
    const impliedShares =
      Number.isFinite(netIncome) &&
      Number.isFinite(dilutedEPS) &&
      Math.abs(dilutedEPS) > 0.000001
        ? Math.abs(netIncome / dilutedEPS)
        : null;

    let selectedScale = 1;

    if (Number.isFinite(impliedShares) && impliedShares > 0) {
      let best = null;

      for (const scale of shareScaleCandidates) {
        const candidate = rawShares * scale;
        const logError = Math.abs(Math.log(candidate / impliedShares));

        if (!best || logError < best.logError) {
          best = { scale, candidate, logError };
        }
      }

      // Accept the inferred scale only when the resulting share count is within
      // roughly 35% of net-income / diluted-EPS. This avoids "fixing" legitimate
      // values when the SEC facts for a year are internally inconsistent.
      if (best && best.logError <= Math.log(1.35)) {
        selectedScale = best.scale;
      }
    } else if (rawShares < 100000) {
      // Conservative fallback for years without usable EPS. The screener covers
      // established U.S. companies, so a sub-100k diluted share count is almost
      // certainly a thousands/millions unit issue.
      selectedScale = 1e6;
    }

    y.sharesScaleApplied = selectedScale;
    y.sharesOutTTM = rawShares * selectedScale;

    if (selectedScale !== 1) detectedShareScales.push(selectedScale);
  });

  // Apply the most frequently detected non-unit scale to any other obviously
  // tiny years that lacked enough information for direct reconciliation.
  if (detectedShareScales.length) {
    const scaleCounts = detectedShareScales.reduce((acc, scale) => {
      acc[scale] = (acc[scale] || 0) + 1;
      return acc;
    }, {});
    const dominantScale = Number(
      Object.entries(scaleCounts).sort((a, b) => b[1] - a[1])[0][0]
    );

    Object.values(byYear).forEach(y => {
      if (
        Number.isFinite(y.sharesOutTTM) &&
        y.sharesOutTTM > 0 &&
        y.sharesOutTTM < 100000 &&
        (y.sharesScaleApplied == null || y.sharesScaleApplied === 1)
      ) {
        y.rawSharesOutTTM = y.rawSharesOutTTM ?? y.sharesOutTTM;
        y.sharesScaleApplied = dominantScale;
        y.sharesOutTTM *= dominantScale;
      }
    });
  }

  // Repair a missing latest-year denominator from internally consistent evidence.
  // Some issuers (notably multi-class filers) omit the diluted-share fact for the
  // newest FY even though earlier years and EPS remain available. A missing latest
  // denominator previously caused every per-share valuation method to return n/a.
  const orderedRawYears = Object.values(byYear).sort((a, b) => a.year - b.year);
  for (let i = 0; i < orderedRawYears.length; i++) {
    const y = orderedRawYears[i];
    if (Number.isFinite(y.sharesOutTTM) && y.sharesOutTTM > 0) {
      y.sharesSource = y.sharesCandidateSource
        ? `${y.sharesCandidateSource}${y.sharesScaleApplied && y.sharesScaleApplied !== 1 ? '_scaled' : ''}`
        : (y.sharesScaleApplied && y.sharesScaleApplied !== 1 ? 'sec_diluted_scaled' : 'sec_diluted');
      continue;
    }

    const income = Number(y.netIncome);
    const dilutedEPS = Number(y.dilutedEPS);
    const implied = Number.isFinite(income) && Number.isFinite(dilutedEPS) && Math.abs(dilutedEPS) > 1e-6
      ? Math.abs(income / dilutedEPS)
      : null;
    if (Number.isFinite(implied) && implied > 100000) {
      y.sharesOutTTM = implied;
      y.rawSharesOutTTM = null;
      y.sharesScaleApplied = null;
      y.sharesSource = 'net_income_div_diluted_eps';
      continue;
    }

    // Final conservative fallback: carry the closest prior diluted denominator.
    // Only use it when it is recent (<=2 fiscal years); this is much safer than
    // dropping valuation entirely and is auditable through sharesSource.
    const prior = orderedRawYears.slice(0, i).reverse().find(x =>
      Number.isFinite(x.sharesOutTTM) && x.sharesOutTTM > 100000 && y.year - x.year <= 2
    );
    if (prior) {
      y.sharesOutTTM = prior.sharesOutTTM;
      y.rawSharesOutTTM = null;
      y.sharesScaleApplied = prior.sharesScaleApplied ?? null;
      y.sharesSource = 'prior_year_carry_forward';
      y.sharesFallbackFromYear = prior.year;
    }
  }

  const years = Object.values(byYear)
    .filter(y => {
      // Keep a year when it has a usable operating scale or profitability fact.
      // Financials and special filers sometimes lack a conventional revenue tag.
      return [y.revenue, y.netIncome, y.operatingIncome, y.cfo, y.grossProfit]
        .some(v => Number.isFinite(Number(v)) && Number(v) !== 0);
    })
    .sort((a, b) => a.year - b.year)
    .slice(-maxYears)
    .map(y => {
      // Graceful fallback for financial/special filers: preserve the record and use
      // the best available operating-scale proxy. It is explicitly marked so later
      // engines can lower confidence and avoid revenue-multiple methods.
      if (!(Number(y.revenue) > 0)) {
        const proxy = [y.grossProfit, y.operatingIncome, y.netIncome, y.cfo]
          .map(Number)
          .find(v => Number.isFinite(v) && Math.abs(v) > 0);
        if (proxy != null) {
          y.revenue = Math.abs(proxy);
          y.revenueIsProxy = true;
          y.revenueSource = y.revenueSource || 'operating_scale_proxy';
        }
      }
      // Free cash flow requires BOTH operating cash flow and capital expenditures.
      // Treating CFO by itself as FCF made capex-heavy or incompletely tagged companies
      // look far more cash-generative than they really are. If capex is unavailable we
      // leave FCF null and let the valuation engine use other methods instead.
      const fcf = (y.cfo != null && y.capex != null) ? y.cfo - Math.abs(y.capex) : null;
      const fcfIsProxy = false;
      const fcfUnavailableReason = y.cfo != null && y.capex == null ? 'missing_capex' : null;
      const grossMargin = (y.grossProfit != null && y.revenue) ? y.grossProfit / y.revenue
        : (y.cogs != null && y.revenue) ? (y.revenue - y.cogs) / y.revenue : null;
      const opMargin = (y.operatingIncome != null && y.revenue) ? y.operatingIncome / y.revenue : null;
      // Approximate operating ROIC using NOPAT divided by debt + equity - cash.
      // This is materially better than the old debt-minus-cash denominator, which
      // collapsed for cash-rich companies and systematically distorted the capital-
      // allocation score. Keep the estimate auditable and omit it when the denominator
      // is not economically meaningful.
      const totalDebt = (Number(y.longTermDebt) || 0) + (Number(y.shortTermDebt) || 0);
      const equity = Number(y.stockholdersEquity);
      const cash = Number(y.cash) || 0;
      const investedCapital = Number.isFinite(equity)
        ? totalDebt + equity - cash
        : null;
      const nopat = Number.isFinite(Number(y.operatingIncome))
        ? Number(y.operatingIncome) * 0.79
        : null;
      const roic = Number.isFinite(nopat) && Number.isFinite(investedCapital) && investedCapital > 0
        ? nopat / investedCapital
        : null;
      const inventoryTurnover = (y.cogs != null && y.inventory) ? y.cogs / y.inventory : null;
      // EBITDA is only published when D&A is actually available. Previously a missing
      // D&A fact silently turned operating income into "EBITDA", understating the
      // denominator and corrupting EV/EBITDA valuation multiples.
      const ebitda = (y.operatingIncome != null && Number.isFinite(Number(y.da)) && Number(y.da) >= 0)
        ? y.operatingIncome + Number(y.da)
        : null;
      // SBC-adjusted FCF: standard FCF (CFO - capex) treats SBC as a non-cash add-back,
      // but economically it's a real cost — it dilutes existing shareholders just like a
      // cash expense would. Subtracting it gives a more conservative "true" FCF for
      // heavy-SBC names (common in software/biotech) where GAAP FCF can look much
      // healthier than the economic reality once dilution is accounted for.
      const fcfSBCAdjusted = fcf != null ? fcf - (y.sbc || 0) : null;
      const sbcIntensity = (y.sbc != null && y.revenue) ? y.sbc / y.revenue : null;
      return { ...y, fcf, fcfIsProxy, fcfUnavailableReason, fcfSBCAdjusted, sbcIntensity, grossMargin, opMargin,
        totalDebt, investedCapital, nopat, roic, inventoryTurnover, ebitda };
    });

  // Mark ownership-scope mismatches generically. If a large share of consolidated
  // earnings belongs to non-controlling owners, consolidated FCF/EBITDA should not be
  // valued against only the listed parent-company share denominator.
  for (const y of years) {
    const consolidated = Number(y.netIncome);
    const parentCandidate = y.netIncomeAttributableToParent ?? y.netIncomeAttributableToCommon;
    const parent = Number(parentCandidate);
    const nci = Number(y.netIncomeAttributableToNCI);
    if (Number.isFinite(consolidated) && parentCandidate != null && Number.isFinite(parent)) {
      y.consolidatedNetIncome = consolidated;
      y.parentNetIncome = parent;
      y.netIncome = parent;
    }
    const denom = Math.max(Math.abs(consolidated || 0), Math.abs(parent || 0) + Math.abs(nci || 0));
    y.noncontrollingIncomeShare = denom > 0 && y.netIncomeAttributableToNCI != null && Number.isFinite(nci) ? Math.abs(nci) / denom : null;
  }

  return years;
}

// --- Stooq: free daily price history, no key needed ---
async function fetchStooqPrice(ticker) {
  const symbol = `${ticker.toLowerCase()}.us`;
  const res = await fetchWithTimeout(`https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`, {}, `Stooq quote ${ticker}`);
  const csv = await res.text();
  const [, row] = csv.trim().split('\n');
  if (!row) return null;
  const cols = row.split(',');
  return { date: cols[0], close: parseFloat(cols[6]) };
}

async function fetchStooqHistory(ticker, years = 5) {
  const symbol = `${ticker.toLowerCase()}.us`;
  const res = await fetchWithTimeout(`https://stooq.com/q/d/l/?s=${symbol}&i=d`, {}, `Stooq history ${ticker}`);
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
  const res = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`, {}, `Finnhub profile ${ticker}`);
  return res.json();
}
async function fetchFinnhubQuote(ticker) {
  if (!FINNHUB_KEY) return null;
  const res = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`, {}, `Finnhub quote ${ticker}`);
  return res.json();
}

// UNCONFIRMED free-tier availability — Finnhub's docs list this endpoint but sources
// disagree on whether it's actually unlocked on a free key or premium-gated. Wired in
// with a safe fallback: if it 403s or errors, we just don't get this signal and fall
// back to the SEC-derived blended growth below. Costs nothing to try.
async function fetchFinnhubRevenueEstimate(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/revenue-estimate?symbol=${ticker}&freq=annual&token=${FINNHUB_KEY}`, {}, `Finnhub revenue estimate ${ticker}`);
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


// Return the most recent diluted share denominator disclosed in a 10-Q/10-K.
// This is intentionally separate from the annual history parser: after a stock split,
// the newest quarterly filing is often the first SEC fact on the new share basis.
function latestDilutedSharesFromFacts(facts) {
  const usGaap = facts?.facts?.['us-gaap'] || {};
  const tags = [
    'WeightedAverageNumberOfSharesOutstandingBasicAndDiluted',
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingDiluted',
    'WeightedAverageNumberOfShareOutstandingBasicAndDiluted',
  ];
  const candidates = [];
  for (const tag of tags) {
    const units = usGaap[tag]?.units;
    const arr = units?.shares || (units ? Object.values(units)[0] : null);
    if (!arr) continue;
    for (const x of arr) {
      if (!['10-Q','10-Q/A','10-K','10-K/A'].includes(x.form) || !Number.isFinite(Number(x.val)) || Number(x.val) <= 100000) continue;
      if (x.start && x.end) {
        const days = (new Date(x.end) - new Date(x.start)) / 86400000;
        // Prefer quarter/YTD/annual duration facts; reject instant/odd contexts.
        if (!(days >= 60 && days <= 430)) continue;
      }
      candidates.push({ value:Number(x.val), filed:String(x.filed||''), end:String(x.end||''), form:x.form, tag });
    }
  }
  candidates.sort((a,b) => b.filed.localeCompare(a.filed) || b.end.localeCompare(a.end));
  return candidates[0] || null;
}

// Rebase historical per-share fields when a recent SEC filing proves that the latest
// annual denominator is on a pre-split (or pre-reverse-split) basis. A split changes
// shares and per-share figures, not the economics. Without this normalization a 25:1
// split can masquerade as 2,400% dilution or make live-price valuation nonsensical.
function normalizeHistoryForCorporateAction(years, currentShareFact) {
  if (!Array.isArray(years) || !years.length || !currentShareFact?.value) return { applied:false, factor:1 };
  const last = years[years.length-1];
  const annualShares = Number(last?.sharesOutTTM), currentShares = Number(currentShareFact.value);
  if (!(annualShares > 100000 && currentShares > 100000)) return { applied:false, factor:1 };
  const rawFactor = currentShares / annualShares;
  if (!(rawFactor >= 3.5 || rawFactor <= 1/3.5)) return { applied:false, factor:1 };
  // Separate the mechanical split ratio from genuine buybacks/issuance since FY-end.
  // Corporate actions overwhelmingly use simple ratios; snap to the nearest common
  // ratio when the observed denominator jump is reasonably close. BKNG, for example,
  // is ~24.5x after post-FY buybacks but the mechanical split itself was 25:1.
  const common = [2,3,4,5,6,7,8,10,12,15,20,25,30,40,50,100];
  const candidates = [...common, ...common.map(x=>1/x)];
  let factor = candidates.reduce((best,x) =>
    Math.abs(Math.log(x/rawFactor)) < Math.abs(Math.log(best/rawFactor)) ? x : best, candidates[0]);
  if (Math.abs(Math.log(factor/rawFactor)) > Math.log(1.20)) factor = rawFactor;
  if (!Number.isFinite(factor) || factor <= 0) return { applied:false, factor:1 };

  for (const y of years) {
    if (Number.isFinite(Number(y.sharesOutTTM)) && Number(y.sharesOutTTM) > 0) {
      y.preCorporateActionSharesOutTTM = Number(y.sharesOutTTM);
      y.sharesOutTTM = Number(y.sharesOutTTM) * factor;
      y.sharesSource = `${y.sharesSource || 'sec'}_corporate_action_rebased`;
    }
    // SEC historical EPS/DPS can remain on the old basis until the next annual filing.
    // Keep dollar totals unchanged and rebase only per-share disclosures.
    for (const field of ['dilutedEPS','dividendPerShare']) {
      if (Number.isFinite(Number(y[field]))) y[field] = Number(y[field]) / factor;
    }
    y.corporateActionFactor = factor;
  }
  // Use the freshest disclosed denominator as the starting share count. This also
  // preserves any real buybacks/issuance that occurred after fiscal year-end.
  last.sharesOutTTM = currentShares;
  last.sharesSource = `latest_${currentShareFact.form.toLowerCase().replace(/-/g,'')}_diluted_shares`;
  return { applied:true, factor, source:currentShareFact };
}



// Generic live share-count reconciliation. SEC Company Facts is authoritative for
// accounting totals, but share-denominator facts can occasionally be stale, pre-split,
// or reported on an unexpected scale. Use an independent live market-cap/price implied
// denominator only when the SEC value is economically implausible. If it cannot be
// reconciled, fail closed instead of publishing a distorted per-share valuation.
function shareDenominatorLooksSuspicious(years, currentPrice) {
  const last = Array.isArray(years) ? years.at(-1) : null;
  const shares = Number(last?.sharesOutTTM);
  const revenue = Number(last?.revenue);
  if (!(shares > 0) || !(currentPrice > 0)) return true;
  if (shares < 100000) return true;
  const impliedMarketCap = shares * currentPrice;
  if (revenue > 0) {
    const salesMultiple = impliedMarketCap / revenue;
    if (salesMultiple < 0.05 || salesMultiple > 100) return true;
    if (revenue / shares > 5000) return true;
  }
  return false;
}

function reconcileSharesWithLiveMarketCap(years, currentPrice, profile) {
  const last = Array.isArray(years) ? years.at(-1) : null;
  if (!last) return { reliable:false, applied:false, reason:'missing_financial_history' };
  const reportedShares = Number(last.sharesOutTTM);
  const profileMarketCap = Number(profile?.marketCapitalization) * 1e6;
  const impliedShares = profileMarketCap > 0 && currentPrice > 0 ? profileMarketCap / currentPrice : null;
  if (!(Number.isFinite(impliedShares) && impliedShares > 100000 && impliedShares < 1e11)) {
    return { reliable:false, applied:false, reason:'live_market_cap_unavailable', reportedShares:reportedShares||null };
  }

  if (!(reportedShares > 0)) {
    last.sharesOutTTM = impliedShares;
    last.sharesSource = 'finnhub_market_cap_div_price';
    return { reliable:true, applied:true, factor:null, reportedShares:null, impliedShares, profileMarketCap };
  }

  const ratio = impliedShares / reportedShares;
  const mismatch = Math.max(ratio, 1/ratio);
  // Ignore ordinary timing differences from buybacks/issuance. Only repair clear
  // denominator-scale/corporate-action breaks.
  if (mismatch < 1.75) {
    return { reliable:true, applied:false, factor:1, reportedShares, impliedShares, profileMarketCap, mismatch };
  }

  // Rebase the historical denominator series by the same factor so dilution trends and
  // historical per-share figures remain on one consistent basis. Dollar totals do not change.
  for (const y of years) {
    if (Number(y.sharesOutTTM) > 0) {
      y.preLiveReconciliationSharesOutTTM = Number(y.sharesOutTTM);
      y.sharesOutTTM = Number(y.sharesOutTTM) * ratio;
      y.sharesSource = `${y.sharesSource || 'sec'}_live_market_cap_rebased`;
    }
    for (const field of ['dilutedEPS','dividendPerShare']) {
      if (Number.isFinite(Number(y[field]))) y[field] = Number(y[field]) / ratio;
    }
    y.liveShareReconciliationFactor = ratio;
  }
  last.sharesOutTTM = impliedShares;
  last.sharesSource = 'finnhub_market_cap_div_price_reconciled';
  return { reliable:true, applied:true, factor:ratio, reportedShares, impliedShares, profileMarketCap, mismatch };
}

// --- Assemble the full stock object the scoring engine expects ---
// Note: sector should be passed in (e.g. from your watchlist.json / index CSV) —
// we don't call Finnhub's profile endpoint anymore, which halves Finnhub API usage
// (quote only) and keeps us comfortably under the 60 calls/min free-tier limit
// even across a 1000+ ticker watchlist.
async function buildStockRecord(ticker, sector, analystEstimate = null) {
  const secTicker = normalizeSecTicker(ticker);
  const finnhubTicker = normalizeFinnhubTicker(ticker);
  const [facts, quote, priceHistory, finnhubRevGrowth] = await Promise.all([
    fetchSecFacts(secTicker),
    fetchFinnhubQuote(finnhubTicker).catch(() => null),
    fetchStooqHistory(secTicker, 5).catch(() => []),
    fetchFinnhubRevenueEstimate(finnhubTicker).catch(() => null),
  ]);

  const years = parseAnnualFinancials(facts);
  const quarters = parseQuarterlyRevenue(facts);
  // Normalize stock splits/reverse splits BEFORE any market-cap, dilution or per-share
  // calculations. The latest 10-Q can be on a new share basis while the last 10-K is not.
  const latestShareFact = latestDilutedSharesFromFacts(facts);
  const corporateActionNormalization = normalizeHistoryForCorporateAction(years, latestShareFact);
  const last = years[years.length - 1] || {};
  const currentPrice = quote?.c || (priceHistory.length ? priceHistory[priceHistory.length - 1].close : null);

  // Independent denominator audit. Only spend the extra Finnhub profile request when
  // the SEC-derived denominator creates economically implausible per-share scale.
  let shareCountReconciliation = { reliable:true, applied:false, reason:'sec_denominator_plausible' };
  if (shareDenominatorLooksSuspicious(years, currentPrice)) {
    try {
      const profile = await fetchFinnhubProfile(finnhubTicker);
      shareCountReconciliation = reconcileSharesWithLiveMarketCap(years, currentPrice, profile);
    } catch (_) {
      shareCountReconciliation = { reliable:false, applied:false, reason:'live_reconciliation_fetch_failed' };
    }
  }

  // Corporate-action denominator repair. SEC share-count facts can remain on a
  // pre-split basis while diluted EPS and the live quote are already split-adjusted.
  // Net income / diluted EPS gives an independent diluted-share denominator. When it
  // differs by a corporate-action-sized factor, prefer that internally consistent
  // denominator rather than allowing every per-share valuation to be off by 10-20x.
  if (!shareCountReconciliation.applied && Number(last.netIncome) !== 0 && Number.isFinite(Number(last.dilutedEPS)) && Math.abs(Number(last.dilutedEPS)) > 1e-6) {
    const epsImpliedShares = Math.abs(Number(last.netIncome) / Number(last.dilutedEPS));
    const reportedShares = Number(last.sharesOutTTM);
    const ratio = reportedShares > 0 && epsImpliedShares > 0
      ? Math.max(reportedShares / epsImpliedShares, epsImpliedShares / reportedShares) : null;
    if (epsImpliedShares > 100000 && epsImpliedShares < 1e11 && (!reportedShares || (ratio != null && ratio >= 3.5))) {
      last.rawSharesOutTTM = reportedShares || null;
      last.sharesOutTTM = epsImpliedShares;
      last.sharesScaleApplied = reportedShares > 0 ? epsImpliedShares / reportedShares : null;
      last.sharesSource = 'net_income_div_diluted_eps_corporate_action_repair';
    }
  }

  // If the denominator still looks suspicious after the independent audit, do not
  // permit it to flow into per-share valuation. A missing valuation is safer than a
  // fabricated 50%-100% CAGR caused by a bad denominator.
  // Re-run the audit AFTER every repair. A later EPS-based corporate-action repair must
  // never silently undo a stronger live market-cap reconciliation. If the final
  // denominator is still economically implausible, fail closed regardless of what an
  // earlier intermediate audit reported.
  const finalShareDenominatorSuspicious = shareDenominatorLooksSuspicious(years, currentPrice);
  const finalShareDenominatorReliable = !finalShareDenominatorSuspicious;
  if (!finalShareDenominatorReliable) {
    last.unreliableSharesOutTTM = last.sharesOutTTM ?? null;
    last.sharesOutTTM = null;
    last.sharesSource = 'unreconciled_share_denominator';
    shareCountReconciliation = { ...shareCountReconciliation, reliable:false, reason:'final_denominator_failed_reconciliation' };
  }


  const sharesOut = last.sharesOutTTM;
  const marketCap = currentPrice && sharesOut ? currentPrice * sharesOut : null;
  const eps = last.netIncome && sharesOut ? last.netIncome / sharesOut : null;
  const pe = currentPrice && eps ? currentPrice / eps : null;
  const debtToEbitda = last.longTermDebt != null && last.ebitda > 0 ? last.longTermDebt / last.ebitda : null;
  const dividendYield = last.dividendPerShare && currentPrice ? last.dividendPerShare / currentPrice : 0;
  const fcfYield = last.fcf && marketCap ? last.fcf / marketCap : null;
  const evEbitda = marketCap && last.ebitda > 0
    ? (marketCap + (last.longTermDebt || 0) - (last.cash || 0)) / last.ebitda
    : null;

  years.forEach(y => {
    y.debtToEbitda = y.longTermDebt != null && y.ebitda > 0 ? y.longTermDebt / y.ebitda : null;
  });

  // Growth signal priority: real analyst consensus (if the Finnhub endpoint worked) >
  // blended recent-quarter momentum + trailing trend. Uses whatever trailing window is
  // available (up to 3yr) rather than requiring exactly 4 years of history — that
  // inconsistency was silently dropping every company with only 3 years of clean SEC
  // data to a null growth signal (and therefore no fair value / no MOS at all).
  let growthYear1 = null;
  const cachedAnalystGrowth = analystEstimate?.revenueGrowthCurrentYear ?? analystEstimate?.revenueGrowthFwd ?? null;
  if (cachedAnalystGrowth != null) {
    growthYear1 = cachedAnalystGrowth;
  } else if (finnhubRevGrowth != null) {
    growthYear1 = finnhubRevGrowth;
  } else if (years.length >= 2) {
    const lookback = Math.min(3, years.length - 1);
    const first = years[years.length - 1 - lookback];
    const trailingCagr = first.revenue > 0 ? Math.pow(last.revenue / first.revenue, 1 / lookback) - 1 : null;
    const recentQoQ = recentQuarterYoYGrowth(quarters);
    growthYear1 = blendedForwardGrowth(trailingCagr, recentQoQ);
  }

  const latestRevenueSource = String(last.revenueSource || '');
  const financialLikeRevenue = /PremiumsEarnedNet|InvestmentIncomeInterestAndDividend|InterestAndDividendIncomeOperating|InterestIncomeExpenseNonoperatingNet|RevenuesNetOfInterestExpense/i.test(latestRevenueSource);
  const nciIncomeShare = Number(last.noncontrollingIncomeShare);
  const nciBalance = Number(last.noncontrollingInterest);
  const parentEquity = Number(last.stockholdersEquity);
  const nciBalanceShare = Number.isFinite(nciBalance) && Number.isFinite(parentEquity) && Math.abs(parentEquity) + Math.abs(nciBalance) > 0
    ? Math.abs(nciBalance) / (Math.abs(parentEquity) + Math.abs(nciBalance)) : null;
  const materialNoncontrollingInterest = (Number.isFinite(nciIncomeShare) && nciIncomeShare >= 0.20) || (Number.isFinite(nciBalanceShare) && nciBalanceShare >= 0.20);

  const stockShell = {
    ticker,
    sector: sector || 'Unknown',
    financials: { years, dataQuality: {
      revenueProxyYears: years.filter(y => y.revenueIsProxy).length,
      fcfProxyYears: years.filter(y => y.fcfIsProxy).length,
      missingCapexYears: years.filter(y => y.fcfUnavailableReason === 'missing_capex').length,
      missingEbitdaYears: years.filter(y => y.operatingIncome != null && y.ebitda == null).length,
      shareDenominatorReliable: finalShareDenominatorReliable,
      shareDenominatorReason: shareCountReconciliation.reason || null,
      financialLikeRevenue,
      materialNoncontrollingInterest,
      noncontrollingIncomeShare: Number.isFinite(nciIncomeShare) ? nciIncomeShare : null,
      noncontrollingBalanceShare: Number.isFinite(nciBalanceShare) ? nciBalanceShare : null,
      latestRevenueSource: latestRevenueSource || null,
    } },
    valuation: {
      pe, forwardPe: pe, evEbitda, fcfYield, marketCap,
      ev: marketCap ? marketCap + (last.longTermDebt || 0) - (last.cash || 0) : null,
      dividendYield,
      growthSource: cachedAnalystGrowth != null ? 'yfinance_supabase' : (finnhubRevGrowth != null ? 'finnhub_analyst_consensus' : 'blended_sec_data'),
      // NOTE: fairValueEstimate is intentionally NOT computed here anymore. Exit-multiple
      // valuation methods need to know what peers are currently trading at across the
      // WHOLE watchlist (e.g. sector median EV/Revenue), which isn't available yet at
      // this point — we're still fetching one ticker at a time. Fair value now gets
      // computed in a second pass by valuation-methods.js, after every ticker has been
      // fetched. See run-screener.js for the two-pass pipeline.
    },
    growthYear1, // carried through to the valuation pass
    analystEstimates: analystEstimate,
    price: { current: currentPrice },
    quarterly: quarters,
    corporateActionNormalization,
    shareCountReconciliation,
    historicalMultiples: { evEbitda: [], forwardPe: [] }, // optional: backfill from priceHistory + trailing EPS
    earningsCallText: null, // optional: plug in a free transcript source if you find one
  };

  return stockShell;
}

const api = {
  fetchSecFacts, parseAnnualFinancials, parseQuarterlyRevenue, recentQuarterYoYGrowth, blendedForwardGrowth,
  fetchStooqPrice, fetchStooqHistory,
  fetchFinnhubProfile, fetchFinnhubQuote, fetchFinnhubRevenueEstimate,
  buildStockRecord, latestDilutedSharesFromFacts, normalizeHistoryForCorporateAction, shareDenominatorLooksSuspicious, reconcileSharesWithLiveMarketCap, getTickerCikMap, normalizeSecTicker, normalizeFinnhubTicker, fetchWithTimeout,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
