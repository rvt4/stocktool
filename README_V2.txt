StockTool V2 engine rewrite
===========================

What changed
- Added engine/lifecycle-engine.js: classifies each company and selects a 5-12 year forecast horizon.
- Added engine/moat-engine.js: estimates moat strength, excess-return duration and fade speed.
- Added engine/fade-engine.js: exit multiples now fade from company-specific economics instead of snapping to sector averages.
- valuation-methods.js now uses dynamic forecast horizons and lifecycle/moat-aware exit multiples.
- Analyst consensus remains an anchor in years 1-2 through forecast-engine.js, including regime-shift detection.
- Existing calibration continues to learn forecast and valuation-method errors.
- Removed V7 Milestone 2/3/4 labels from the UI and replaced them with Business Classification & Moat and Valuation Summary.

Validation
- All changed JavaScript files pass node --check.
- The full valuation run still requires Supabase/Finnhub credentials and will execute in the existing GitHub Actions workflow.

Important
The first V2 run will create materially longer projections for Growth, Hyper Growth and elite compounders. Review AMD, CELH, PLTR, META and ADBE after the workflow finishes. The engine retains broad hard caps only as data-error safeguards; sector medians are now anchors rather than forced destinations.
