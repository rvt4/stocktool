FreeScreener V7 — Milestone 3

This package includes only files changed for Milestone 3 plus the Visa valuation repair.

Visa / missing valuation repair
- Adds alternate diluted-share XBRL tag support.
- Reconstructs missing diluted shares from net income / diluted EPS when reliable.
- Carries forward a recent prior-year diluted denominator as a conservative last fallback.
- Records sharesSource and sharesFallbackFromYear for auditability.
- Prevents any stock without a real price-aware valuation from receiving Buy, Strong Buy, or Exceptional.

Milestone 3
- Monthly forecast snapshots in data/forecast-history.json.
- Self-calibration after enough forecasts mature (minimum 270 days and 25 observations).
- Category and industry bias adjustments, conservatively capped.
- Portfolio conviction score, eligibility, position tier, and suggested maximum weight.
- Frontend Milestone 3 detail section.
- Nightly workflow commits forecast history along with results.

Upload the files using the same folder paths shown in the ZIP. New files inside engine/ must remain inside engine/.
