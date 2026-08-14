# FreeScreener — simplified model

Production is intentionally small. The nightly run follows exactly one path:

`data-fetchers.js -> forecast-engine.js -> quality-engine.js -> valuation-engine.js -> rating-engine.js -> validation.js -> results.json`

## Core rules

- One forecast. No competing lifecycle/fade/cycle forecast engines.
- One canonical five-year shareholder outcome.
- Expected CAGR is always recomputed from current price and that exact outcome.
- Fair value today is the same outcome discounted at the model's required return.
- Margin of safety is always `1 - current price / fair value`.
- Ratings consume those canonical values; they never create or overwrite returns.
- Validation runs before publication and refuses contradictory math.
- No ticker-specific overrides. Sector rules are allowed and live in `engine/config.js`.

## Production files

- `data-fetchers.js` — SEC/Finnhub/Stooq data collection
- `run-screener.js` — orchestration only
- `engine/config.js` — transparent sector assumptions and helpers
- `engine/forecast-engine.js` — five-year operating forecast
- `engine/quality-engine.js` — quality/moat/capital-allocation/confidence scores
- `engine/valuation-engine.js` — DCF + FCF/EPS/EV-EBITDA year-five targets and canonical return
- `engine/rating-engine.js` — Buy/Hold/Avoid/Sell rules
- `engine/validation.js` — hard mathematical invariants
- `index.html` — static UI

The old Vxx engines are deliberately not part of this package.


## Simple V2 valuation model

The publication path is still one-way: data -> forecast -> quality -> valuation -> rating.
V2 removes the old DCF from the ranking path and values each company from normalized year-5 per-share fundamentals and conservative exit multiples anchored to both business economics and the company's observable current multiple. Financials use EPS only. Implausible base-case CAGRs above 35% or below -30% are treated as model/data failures and published as Unrated rather than ranked as opportunities.

`sanity-basket.json` contains 25 names to use for quick pre-production checks before running the full universe.
