Build 29 - valuation recalibration (diagnosed from results (17).json, 988 stocks)

Findings that drove this build: model fair value had ~0 rank correlation with analyst targets;
fair value/price was 0.56x for stocks over 35x P/E and 1.46x under 12x P/E (value factor in
disguise); leveraged/cyclical names (CHTR, MTDR, CVNA) and mortgage REITs (AGNC) valued at 4-8x
their price; only 80/914 stocks cleared a 15% hurdle; 74 stocks (T, CMCSA, LULU...) were Unrated.

Changes
1. engine/config.js: TERMINAL_GROWTH_CAP=3% (sector tech/healthcare 4%/3.5% -> 3%), hurdle 15% -> 11%
   (INVESTOR_ALPHA_HURDLE is now the single source of truth for rating, validation, policy, UI),
   EXIT_PRICE_ANCHOR_WEIGHT=0.35.
2. forecast/valuation: terminal growth <=3% everywhere; intrinsic discount rate base 9.25% -> 10.25%
   (band 9.5-12%); exit-multiple evidence ceilings lowered; Gordon anchor on exit multiples 15% -> 30%.
3. Price-aware exit multiples: year-10 multiple is blended 35% toward today's multiple (bounded 0.6x-1.6x
   of the fundamental multiple; ignored when the current multiple is pinned at a clamp). Set
   EXIT_PRICE_ANCHOR_WEIGHT=0 to restore price-independent values.
4. Leverage: EV/EBITDA exit leans harder on the current multiple as net debt exceeds 30% of EV.
5. Banks/lenders/insurers (SIC 60xx, 61xx, 63xx) and mortgage REITs (Financials + SIC 6798) use the
   earnings/book/residual-income path instead of FCF/EBITDA/DCF.
6. data-fetchers.js: oil & gas capex tags added (MTDR FCF margin was 62% because capex was missing).
7. Return-integrity gate: slow-growth Value/Dividend names whose implied return is too high are now
   capped and marked 'limited' support (cannot be a Buy) instead of Unrated, unless >12 points over.
8. Analyst sanity check (analystCheck on every record + a line on the screen cards); a Buy is
   downgraded to Watch if model fair value is >2x the analyst consensus target (>=5 analysts).
9. Tests updated to the configured hurdle; the exact price-independence test is now a bounded-sensitivity
   test. New: build29-test.js.

Run: node build29-test.js && node model-smoke-test.js (plus the other *-test.js), then nightly.
NOT validated against live data: regenerate data/results.json and re-check the sanity basket.

Build 30
1. SBC double-count: the EPS lens added back after-tax SBC in proportion to net dilution (>=2%/yr dilution =>
   100%, net buybacks => 0). Audit fields: sbcAddBackFraction, reportedYear10EPS. (CRWD EPS lens was $12/share.)
2. Consensus cross-check: model intrinsic value is pulled in log space toward the analyst-implied value
   (weight <=35%, scaled by analyst count, cut 40% when targets are widely dispersed) and kept inside
   0.45x-2.2x of it. analystCheck.modelFairValue keeps the pre-blend value and drives the 'model far above
   analysts' Buy guard. Set ANALYST_BLEND_MAX_WEIGHT=0 in engine/config.js to disable.
   Offline simulation on results (18): rank correlation with analyst targets 0.05 -> 0.20; FV/price 5th-95th
   percentile 0.19-1.67 (full range 0.01-6.5) -> 0.47-1.55 (0.25-3.05).
3. Data: 20-F/40-F annual facts (US-GAAP tags) accepted; tickers with <2 usable years now log a [diag] line
   (entity, CIK, us-gaap vs ifrs tag counts, annual forms per tag). WBD, EA, AVB, EQR, WBS, QRVO, LBRDK/A
   have no SEC ticker (acquired/delisted): drop them from watchlist.json. OZK files with the FDIC, not the SEC.

Build 31
Analyst weight in the revenue forecast now scales with coverage (1 analyst => 30%, 7+ => full consensus weight).
A single analyst's estimate had the same 62% weight as a 30-analyst consensus (IESC: n=1, +48% next-year revenue
=> 28% expected CAGR, 4.7x fair value/price).

Build 32-35
- 32/33: Live ranking uses an evidence-adjusted alpha (compressed extreme returns; haircuts for thin analyst coverage, small caps, model far above analysts). Top 10 requires 3+ analysts. Backtest ranking unchanged.
- 34: Research priority penalizes quality under 75 and leans toward the engine rank; screener gets a minimum market-cap filter.
- 35: Quarterly review. review-policy.js sets Add/Hold/Review/Sell-candidate bands for holdings; the Portfolio page can save quarterly snapshots (Supabase table review_snapshots, or this device if the table is missing) and tracks the research shortlist against an equal-weight universe. Run the new block at the end of supabase.sql once.
- 36: Position sizing + owner strategy backtest.
  Sizing (review-policy.js SIZING): 3-10% at cost by conviction (return over 11%, quality, confidence, coverage); max 15 positions;
  30% sector cap on new buys; positions above 20% get a trim review (toward 15%); winners are otherwise left to run.
  Portfolio page shows weight vs target per holding and an "Invest new money" planner.
  owner-strategy-lab.js backtests the app's actual rules (live ranking, review statuses, sizing; idle cash in SPY) against SPY and an
  equal-weight universe. Run from Actions -> "Owner Strategy Backtest". Output: data/backtest-owner-summary.json.
- 37: App entry rule now matches the backtested strategy (arm C): model rank top 20, expected return >= 11%, quality 75+. Planner buys in model-rank order; snapshots track the top 20 by model rank. Legacy Buy-rated rule kept only for comparison.
- 38: Projections page shows and lets you edit the full year-by-year path (revenue growth, net margin, FCF margin, P/E) with shapes (model path, even steps, faster early/late) or by hand; adds Year-1 margin and P/E fields, a price path and CAGR-if-sold-in-year-N. Old saved projections rebuild with even steps.
- 39: Projections: path inputs removed from the inputs panel (now 'Other inputs'); reported SEC years shown above the projection in the path table; history chart overlays the projection (dashed bars) for the active scenario; EPS added to chart metrics.
- 40: All per-year assumptions live in one 'Your projection' table: growth, net margin, FCF margin, SBC %, share change, dividend/share, P/E (each with shapes). Starting inputs (revenue, shares, price, MOS) and notes sit above it. Share count compounds year by year. data-fetchers: dividends now read from CommonStockDividendsPerShareCashPaid and, failing that, dividends paid / shares (KO, JNJ, HD, O previously modeled with no dividend).
- 41: P/E column is the trailing P/E at each year end, anchored at today's P/E (shown in a new Today row with trailing EPS and price) and reaching the exit P/E in year 10. Previously year 1 used price / next-year EPS, which forced year-1 price = today's price.
- 42: Today P/E uses the engine's normalized base-year EPS (same basis as projected EPS); the engine's currentMultiple is capped at 57x and was distorting high-P/E names (AMD, CELH, ELF). Path years use the model's fiscal-year labels.
- 43: fetch_history.py merges all listed XBRL tags by priority (fills years reported under older/newer tags), adds capex fallbacks (AMZN uses PaymentsToAcquireProductiveAssets, so its FCF history was blank), and decides staleness from the file's generatedAt/schema instead of file mtime (Actions checkouts made every cached file look fresh). Schema bump refreshes all histories over the next nights (HISTORY_LIMIT per night).
- 44: New default P/E shape "Follows earnings": in-between P/Es glide from today's to the exit P/E in step with EPS progress, so the price path is smooth and monotone (no artificial humps for AMD/CELH/ELF). Editing the Year-10 P/E keeps this shape.
