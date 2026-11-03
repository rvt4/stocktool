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
