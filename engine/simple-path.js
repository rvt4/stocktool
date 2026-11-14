(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SimplePath=api;})(typeof self!=='undefined'?self:this,function(){
'use strict';
// Build 78: the "simple projection" the Research page edits. Four inputs a person can reason about:
//   revenue growth, EPS, share change (per year) and a year-10 P/E.
// Everything else (net margin, free cash flow, net debt, price) is derived from them, so it always agrees.
//
// EPS is on the ANALYST basis (excludes stock pay and acquisition amortization), the number on every
// finance site and in the PEG. Stock pay is still a real cost: it shows up as dilution in the share-change
// row and as cash (owner FCF is after stock pay, i.e. the cost of buying those shares back).
//
// Autofill:
//   years 1-2  analysts' consensus revenue and EPS (EPS trimmed per CONSENSUS_TRIM, fading out by year 5)
//              when 3+ analysts cover it and their revenue base matches ours; otherwise the model.
//   years 3-10 revenue growth = the model's (Build 67 calibrated fade, scored by the forecast scorecard);
//              margin = year-2 margin + the model's own margin drift from year 2.
//   cash       owner FCF = EPS x the model's year-by-year cash conversion (keeps capex cycles: META, AMZN).
//   P/E        the engine's EPS-exit multiple, converted to the analyst EPS basis.

const finite = v => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Build 79: cash the company keeps is worth $1 per $1 (the "cash built" part of the price), and its interest
// must not be counted a second time through EPS x P/E. The model's non-operating income (interest, other) is a
// share of revenue, so it grows as the company grows; that growth stands in for interest on the new cash.
// This returns the after-tax interest already inside earnings for the cash built so far: the growth in
// non-operating income, capped at a normal yield on that cash. The price takes it out before applying the P/E.
const CASH_YIELD = 0.04;

// Build 80c: how much to trim analysts' EPS, by projection year. Consensus is optimistic on average, most
// at longer horizons, but large companies also beat the final estimate most quarters, and over the 90 days
// to Nov 2026 estimates were revised UP (this year +1.1%, next year +0.5% median, 840+ companies).
// So: 1% this year (mostly reported), 4% next year, fading to zero by year 5, so a one-year correction never
// becomes a permanent cut to long-run EPS (the old flat 3% / 8% did, costing ~0.8 pt/yr on every stock).
// Starting estimates only: track-forecasts.js now records consensus monthly and measures the actual error;
// replace these with its suggestedTrim once it has a year of data.
const CONSENSUS_TRIM = [0.01, 0.04, 0.04 * 2 / 3, 0.04 / 3, 0, 0, 0, 0, 0, 0];
function interestInEarnings(cashBuilt, revenue, revenue0, nonOperatingMargin, taxRate) {
  if (!(cashBuilt > 0) || !(nonOperatingMargin > 0) || !(revenue > revenue0) || !(revenue0 > 0)) return 0;
  const t = clamp(finite(taxRate) ?? .21, 0, .35);
  return Math.min(nonOperatingMargin * (revenue - revenue0), CASH_YIELD * cashBuilt) * (1 - t);
}

function buildSimplePath(stock, forecast, valuation) {
  const rows = forecast?.rows || [];
  if (rows.length < 10) return null;
  const price = finite(stock?.price?.current ?? stock?.currentPrice ?? valuation?.currentPrice);
  if (!(price > 0)) return null;
  const a = stock?.analystEstimates || {};
  const n = finite(a.numAnalysts) ?? 0;

  // Adjusted (analyst-basis) net margin implied by the model each year.
  const adjMargin = rows.map(r => {
    const t = clamp(finite(r.taxRate) ?? .21, 0, .35);
    const g = finite(r.gaapNetMargin) ?? finite(r.netMargin);
    if (g === null) return null;
    return g + Math.max(0, finite(r.sbcMargin) ?? 0) * (1 - t) + Math.max(0, finite(r.intangibleAmortizationMargin) ?? 0) * (1 - t);
  });
  const rev = rows.map(r => finite(r.revenue)), sh = rows.map(r => finite(r.shares));
  if (!rev.every(v => v > 0) || !sh.every(v => v > 0)) return null;
  if (!adjMargin.every(v => v !== null)) return buildEpsOnlyPath(stock, rows, valuation, price, a, n, rev, sh);
  const rev0 = rev[0] / (1 + (finite(rows[0].revenueGrowth) ?? 0));
  const sh0 = sh[0] / (1 + (finite(rows[0].actualDilution) ?? 0));

  // Years 1-2 from consensus when it's usable.
  const usable = (r, i) => r > 0 && Math.abs(r / rev[i] - 1) <= .25;
  const aRev = [finite(a.revenueCurrentYear), finite(a.revenueNextYear)];
  const aEps = [finite(a.epsCurrentYear), finite(a.epsNextYear)];
  const useConsensus = n >= 3 && usable(aRev[0], 0) && usable(aRev[1], 1) && aEps[0] !== null && aEps[1] !== null;
  const revenue = rev.slice(), margin = adjMargin.slice();
  let oneOff = null;
  if (useConsensus) {
    // Untrimmed consensus here; the trim schedule is applied to every year below.
    for (let i = 0; i < 2; i++) {
      revenue[i] = aRev[i];
      margin[i] = aEps[i] * sh[i] / revenue[i];
    }
    // One-off gains: when this year's consensus margin sits well above next year's while revenue grows
    // (investment mark-ups, asset sales: GOOGL, AMZN in 2026), next year is the clean run-rate. The autofill
    // uses a clean year-1 EPS (no more than 2 pts above next year's margin); the analyst figure is kept for display.
    if (margin[0] > margin[1] + .03 && revenue[1] > revenue[0]) {
      oneOff = { analystEps: aEps[0], cleanEps: (margin[1] + .02) * revenue[0] / sh[0] };
      margin[0] = margin[1] + .02;
    }
    // Later years: carry the model's trend in GAAP profit (+ amortization), NOT its stock-pay fade. The model
    // fades stock pay as a share of revenue without lifting GAAP profit to match, so the adjusted margin used to
    // collapse for heavy stock-pay companies (SNOW 12% -> 3%). Stock pay is charged via dilution and buybacks.
    const core = rows.map(r => { const t = clamp(finite(r.taxRate) ?? .21, 0, .35);
      return (finite(r.gaapNetMargin) ?? finite(r.netMargin) ?? 0) + Math.max(0, finite(r.intangibleAmortizationMargin) ?? 0) * (1 - t); });
    for (let i = 2; i < 10; i++) {
      revenue[i] = revenue[i - 1] * (1 + (finite(rows[i].revenueGrowth) ?? 0));
      margin[i] = margin[1] + (core[i] - core[1]);
    }
    // Optimism trim, fading to zero by year 5 (losses are not trimmed).
    for (let i = 0; i < 10; i++) if (margin[i] > 0) margin[i] *= 1 - CONSENSUS_TRIM[i];
    if (oneOff) oneOff.cleanEps = margin[0] * revenue[0] / sh[0];
  }

  // Cash conversion: PRE-stock-pay FCF per dollar of adjusted earnings, from the model's own path. Stock pay
  // is charged separately (Build 78c): as dilution in the share count, and as cash only for the shares the
  // company actually buys back. Using after-stock-pay FCF as well counted it twice (SNOW, NET: -15 to -20%/yr).
  const preFcf = rows.map(r => finite(r.preSbcFcfMargin) ?? ((finite(r.fcfMargin) ?? 0) + Math.max(0, finite(r.sbcMargin) ?? 0)));
  const conv = rows.map((r, i) => adjMargin[i] > .02 ? clamp(preFcf[i] / adjMargin[i], -1, 2.5) : null);
  // Where earnings are too small for a ratio, carry the cash margin itself.
  const fcfMarginFallback = preFcf.slice();

  const years = [];
  let prevRev = rev0, prevSh = sh0;
  for (let i = 0; i < 10; i++) {
    const r = rows[i];
    const eps = margin[i] * revenue[i] / sh[i];
    years.push({
      year: finite(r.year),
      revenueGrowth: revenue[i] / prevRev - 1,
      revenue: revenue[i],
      shareChange: sh[i] / prevSh - 1,
      shares: sh[i],
      eps,
      netMargin: margin[i],
      cashConversion: conv[i],
      fcfMarginFallback: fcfMarginFallback[i],
      dividendPerShare: Math.max(0, finite(r.dividendPerShare) ?? 0),
      sbcMargin: Math.max(0, finite(r.sbcMargin) ?? 0),
      preSbc: true,
    });
    prevRev = revenue[i]; prevSh = sh[i];
  }

  // Exit P/E on the same (analyst) EPS basis as the table.
  // Year-10 P/E: the engine's exit multiple (set from growth, quality and durability). It is NOT cut for
  // stock pay: in this table stock pay is already charged through dilution (share change) and in FCF, so a
  // lower multiple would count it twice (Build 78 did: SNOW's P/E was pinned at 6x).
  const audit = (valuation?.methods || []).find(m => m.name === 'EPS exit')?.audit || null;
  const eps10 = years[9].eps;
  let exitPE = finite(audit?.exitMultiple);
  if (!(exitPE > 0)) exitPE = finite(valuation?.tenYearPriceTarget) && eps10 > 0 ? valuation.tenYearPriceTarget / eps10 : 20;
  exitPE = clamp(exitPE, 8, 45);
  // Build 82: the model's exit P/E is a P/E on REPORTED (GAAP) earnings, but this table's EPS is analysts'
  // basis, which for many companies leaves out stock pay and/or acquisition amortization (CRM, ADBE, INTU).
  // Copying the number re-rated CRM from 14x to 21x. Convert it to this table's basis with the same gap
  // between the model's GAAP margin and this table's (analyst-basis) margin:
  //   basisFactor = model GAAP net margin / table net margin, at year 10.
  // Check (CRM, year 2): model P/E today 19.9x x 0.73 = 14.5x, the market's actual 14.3x on analyst EPS.
  // Consensus that already includes stock pay (META, GOOGL, CELH) keeps factor 1. Where GAAP earnings are
  // negative (SNOW) the factor is meaningless and the model's multiple is used as before.
  const anchor = forecast?.forecastBridge?.margins?.analystMarginAnchor || null;
  const rawExit = exitPE;
  let basisFactor = 1;
  // Measured at year 10, where the multiple is applied: stock pay usually shrinks relative to revenue, so
  // the gap between analysts' and GAAP margins narrows over time (ZETA: 0.4 at year 2, wider later).
  // Year-10 GAAP margin = the model's row; this table's year-10 margin carries analysts' basis.
  // Only when the multiple IS the model's P/E on GAAP EPS (not the fallback used when no EPS method exists, ZETA).
  if (finite(audit?.exitMultiple) > 0 && useConsensus && anchor && anchor.consensusBasis && anchor.consensusBasis !== 'includes_sbc' && years[9].netMargin > 0) {
    const gaap10 = finite(rows[9].gaapNetMargin ?? rows[9].netMargin);
    if (gaap10 > 0) basisFactor = clamp(gaap10 / years[9].netMargin, 0.4, 1);
  }
  exitPE = clamp(rawExit * basisFactor, 8, 45);
  const exitBasis = basisFactor < 1 ? 'gaap_multiple_converted_to_analyst_basis' : 'model_multiple';

  // Last year's EPS on the same basis, so year 1 has a growth rate too: consensus this-year EPS / (1 + its
  // growth) when analysts give it, else the model's year-1 margin applied to last year's revenue and shares.
  const cyG = finite(a.epsGrowthCurrentYear);
  let eps0 = useConsensus && aEps[0] > 0 && cyG !== null && cyG > -0.9 ? aEps[0] / (1 + cyG) : null;
  if (!(eps0 > 0)) eps0 = adjMargin[0] * rev0 / sh0;
  return {
    version: 5,
    eps0,
    basis: useConsensus ? 'consensus_years_1_2' : 'model',
    analysts: n,
    oneOffYear1: oneOff,
    price,
    revenue0: rev0,
    shares0: sh0,
    netDebtNow: finite(valuation?.netDebt),
    nonOperatingMargin: finite(rows[9].nonOperatingMargin) ?? 0,
    taxRate: clamp(finite(rows[9].taxRate) ?? .21, 0, .35),
    peToday: years[0].eps > 0 ? price / years[0].eps : null,
    exitPE, exitBasis, modelExitPE: rawExit, basisFactor,
    years,
  };
}

// Build 80b: banks, insurers and other lenders (JPM, AXP, SOFI, UNH). The model values them on EPS alone
// (no operating-margin or free-cash-flow rows: a lender's "cash flow" is mostly its balance sheet growing),
// so the simple table follows that: EPS from consensus for years 1-2 (same fading trims), then the model's
// own EPS growth path, and the model's exit P/E. Net margin is shown (EPS x shares / revenue) and editable
// the same way. No free cash flow and no cash build: retained earnings fund loan and float growth, and the
// shareholder return is the dividend plus the buybacks already in the share count.
function buildEpsOnlyPath(stock, rows, valuation, price, a, n, rev, sh) {
  const audit = (valuation?.methods || []).find(m => m.name === 'Normalized EPS exit')?.audit;
  const base = finite(audit?.normalizedEPSBase), path = audit?.epsGrowthPath;
  if (!(base > 0) || !Array.isArray(path) || path.length < 10) return null;
  const rev0 = rev[0] / (1 + (finite(rows[0].revenueGrowth) ?? 0));
  const sh0 = sh[0] / (1 + (finite(rows[0].actualDilution) ?? 0));
  const eps = []; let e = base;
  for (let i = 0; i < 10; i++) { e *= 1 + (finite(path[i]) ?? 0); eps.push(e); }
  // Consensus for years 1-2 when it's in the same ballpark as the model (within 40%: guards against a
  // different EPS basis or a bad feed value).
  const aEps = [finite(a.epsCurrentYear), finite(a.epsNextYear)];
  const near = (x, m) => x > 0 && m > 0 && Math.abs(x / m - 1) <= .40;
  const useConsensus = n >= 3 && near(aEps[0], eps[0]) && near(aEps[1], eps[1]);
  if (useConsensus) {
    // Consensus levels for years 1-2, then the model's growth path from there; the trim fades out by year 5.
    // The model's own path already carries the fading trim when it used consensus levels: undo it first.
    const un = i => audit.consensusLevels ? eps[i] / (1 - CONSENSUS_TRIM[i]) : eps[i];
    const raw = eps.map((v, i) => i < 2 ? aEps[i] : un(i) * aEps[1] / un(1));
    for (let i = 0; i < 10; i++) eps[i] = raw[i] > 0 ? raw[i] * (1 - CONSENSUS_TRIM[i]) : raw[i];
  }
  const years = [];
  let prevRev = rev0, prevSh = sh0;
  for (let i = 0; i < 10; i++) {
    const r = rows[i];
    years.push({ year: finite(r.year), revenueGrowth: rev[i] / prevRev - 1, revenue: rev[i], shareChange: sh[i] / prevSh - 1, shares: sh[i],
      eps: eps[i], netMargin: eps[i] * sh[i] / rev[i], cashConversion: null, fcfMarginFallback: 0,
      dividendPerShare: Math.max(0, finite(r.dividendPerShare) ?? 0), sbcMargin: 0, preSbc: false });
    prevRev = rev[i]; prevSh = sh[i];
  }
  const cyG = finite(a.epsGrowthCurrentYear);
  let eps0 = useConsensus && cyG !== null && cyG > -0.9 ? aEps[0] / (1 + cyG) : base;
  return {
    version: 5, epsOnly: true, eps0, basis: useConsensus ? 'consensus_years_1_2' : 'model', analysts: n, oneOffYear1: null,
    price, revenue0: rev0, shares0: sh0, netDebtNow: null, nonOperatingMargin: 0, taxRate: .21,
    peToday: years[0].eps > 0 ? price / years[0].eps : null,
    exitPE: clamp(finite(audit.exitMultiple) ?? 15, 6, 35), years,
  };
}

// Same arithmetic the Research page uses, so tests can check the page and the nightly agree.
function calculateSimple(sp, edits = {}) {
  if (!sp || !sp.years || sp.years.length < 10) return null;
  const g = edits.revenueGrowth || sp.years.map(y => y.revenueGrowth);
  const d = edits.shareChange || sp.years.map(y => y.shareChange);
  const price = sp.price;
  let rev = sp.revenue0, sh = sp.shares0;
  const out = [];
  for (let i = 0; i < 10; i++) {
    rev *= 1 + g[i]; sh *= 1 + d[i];
    const margin = edits.netMargin ? edits.netMargin[i] : sp.years[i].netMargin;
    const eps = margin * rev / sh;
    const Y = sp.years[i], c = Y.cashConversion;
    const fcf = c === null ? Y.fcfMarginFallback * rev : eps * sh * c;          // pre-stock-pay when Y.preSbc
    const sbc = Y.preSbc ? (Y.sbcMargin || 0) * rev : 0;
    out.push({ rev, sh, eps, margin, preFcf: fcf, sbc, ownerFcf: fcf - sbc, dps: Y.dividendPerShare });
  }
  // P/E glides from today's forward P/E to the exit P/E in step with earnings progress (log scale).
  const exitPE = edits.exitPE ?? sp.exitPE, e0 = out[0].eps, e10 = out[9].eps;
  const pe0 = sp.peToday && sp.peToday > 0 ? sp.peToday : exitPE;
  const lnTot = e0 > 0 && e10 > 0 ? Math.log(e10 / e0) : 0;
  let nd = sp.netDebtNow ?? 0, prevSh = sp.shares0, divs = 0;
  const nd0 = nd;
  out.forEach((y, i) => {
    const t = i === 9 ? 1 : (e0 > 0 && y.eps > 0 && Math.abs(lnTot) > 1e-6 ? clamp(Math.log(y.eps / e0) / lnTot, 0, 1) : (i + 1) / 10);
    const peSet = edits.pe && Number.isFinite(edits.pe[i]) && edits.pe[i] > 0 ? edits.pe[i] : null;
    y.pe = i === 9 && !peSet ? exitPE : (peSet ?? pe0 * Math.pow(exitPE / pe0, t));
    y.peSet = !!peSet || (i === 9 && !!edits.exitPESet);
    y.opsPrice = y.eps > 0 ? y.eps * y.pe : NaN;
    // Cash buybacks = shares that offset stock-pay issuance plus any net reduction, at that year's price.
    // Shares issued for stock pay ~ stock pay $ / price; net change = issued - bought.
    const px = Number.isFinite(y.opsPrice) && y.opsPrice > 0 ? y.opsPrice : null;
    const buyback = px ? Math.max(0, y.sbc - (y.sh - prevSh) * px) : y.sbc;
    if (!sp.epsOnly) nd -= y.preFcf - y.dps * y.sh - buyback;
    else { y.preFcf = NaN; y.ownerFcf = NaN; }
    // A net debt you type replaces the rolled-forward figure; later years roll on from it.
    if (edits.netDebt && Number.isFinite(edits.netDebt[i])) { nd = edits.netDebt[i]; y.netDebtSet = true; }
    y.netDebt = nd;
    y.cashPS = (nd0 - nd) / y.sh;
    // Interest on that cash already in EPS: taken out at the P/E so the cash counts once, at $1.
    y.interestPS = interestInEarnings(nd0 - nd, y.rev, sp.revenue0, sp.nonOperatingMargin, sp.taxRate) / y.sh;
    y.price = Number.isFinite(y.opsPrice) ? y.opsPrice - y.pe * y.interestPS + y.cashPS : NaN;
    divs += y.dps;
    y.cagrToDate = y.price + divs > 0 ? Math.pow((y.price + divs) / price, 1 / (i + 1)) - 1 : NaN;
    prevSh = y.sh;
  });
  const value = out[9].price + divs;
  return { years: out, exit: out[9].price, value, cagr: value > 0 ? Math.pow(value / price, .1) - 1 : NaN };
}

return { buildSimplePath, calculateSimple, interestInEarnings, CASH_YIELD, CONSENSUS_TRIM };
});
