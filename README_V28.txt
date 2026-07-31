StockTool V28 — durable category classification

What changed
- Added one shared engine/category-engine.js used by BOTH scoring-engine.js and valuation-methods.js.
- Replaced threshold-first classification with a multi-year archetype scorecard.
- Uses up to 8 years of revenue growth, 3/5-year growth, growth volatility, ROIC, gross-margin stability, FCF consistency, margin trends, share-count trend, forward estimates, sector/industry cyclicality, dividend sustainability, and valuation yield.
- Added hard gates so one noisy estimate cannot label a company Hyper Growth, Turnaround, Cyclical, Dividend, Value, or Compounder.
- Value is no longer the fallback for every mature company.
- Turnaround now requires BOTH prior deterioration and measurable recovery.
- Category is now calculated once consistently for scoring and valuation.
- Screener output now includes categoryConfidence, categoryScores, and categoryProfile for auditing.

Files to replace/add
- ADD engine/category-engine.js
- REPLACE scoring-engine.js
- REPLACE valuation-methods.js

After uploading, run the nightly screener again. Existing results.json will not change until the job reruns.
