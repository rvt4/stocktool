StockTool V22 — Canonical Investor Return Fix
==============================================

What was fixed
--------------
1. Investor CAGR is now calculated only from:
     current price -> modeled five-year exit price + cash dividends.
   Business growth and valuation plausibility can explain or flag the result, but
   they can no longer replace it with a different CAGR.

2. The reality-check engine is diagnostic-only for the canonical return. It no
   longer turns a negative/low price-derived return into a positive capped return.

3. Bear, Base, and Bull scenarios each store their own exit price, dividends,
   total future value, and CAGR. Their CAGRs are derived from those values.

4. Institutional sanity checks now flag unusually high returns instead of silently
   clipping them into repeated 20%/22%/24% values.

5. The return engine is preferred ahead of Owner Earnings when the screener builds
   the central expected-return profile. Owner Earnings remains a validation method.

Expected AMD behavior from the screenshots
------------------------------------------
A current price near $485 and a five-year exit price near $517 with no dividends
must produce an investor CAGR near 1.3%, not 12-13%. The exact scenario-weighted
number can differ because Bear and Bull have separate exit prices, but every
reported scenario return now reconciles mathematically to its displayed values.

Files changed
-------------
- valuation-methods.js
- run-screener.js
- engine/return-engine.js
- engine/scenario-engine.js
- engine/institutional-sanity-engine.js

Installation
------------
Replace those files in the same paths, commit, and rerun the screener GitHub Action.
The existing results.json will continue to show old values until the action finishes.
