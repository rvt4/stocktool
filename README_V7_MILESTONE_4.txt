FreeScreener V7 Milestone 4 — Institutional Valuation Engine

Changed root files:
- valuation-methods.js
- run-screener.js
- scoring-engine.js
- index.html

New engine files:
- engine/exit-multiple-engine.js
- engine/valuation-consensus.js
- engine/return-engine-v2.js
- engine/market-expectations.js
- engine/monte-carlo-engine.js

Key behavior changes:
- Exit multiples are capped by expected year-5 growth, quality, reliability, and industry.
- Intrinsic values (DCF/SBC-adjusted DCF/Owner Earnings) are separated from market exit values.
- Low-agreement valuations heavily favor intrinsic value instead of averaging incompatible methods.
- Expected return is decomposed and capped at the component level; multiple rerating is limited to +/-10% annually.
- Extreme-disagreement expected CAGR is capped at 25%; large disagreement at 30%; normal maximum is 35%.
- Adds deterministic Monte Carlo return distributions and market-expectation text.

Upload these files while preserving the engine/ folder structure, then rerun the nightly workflow.
