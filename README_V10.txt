StockTool V10 scale-aware growth valuation update

Changed:
- Replaced linear long-horizon growth interpolation with a multi-stage forecast fade.
- Analyst estimates still anchor years 1 and 2.
- Excess growth now decays toward a sustainable long-run anchor.
- Added revenue-base damping and cumulative revenue-expansion safeguards.
- Added forecast plausibility diagnostics to the forecast audit.
- Added maturity, forecast-horizon, and projected-scale penalties to exit multiples.
- Added lifecycle-specific absolute multiple caps tied to terminal growth and moat.
- Re-enabled the existing exit-multiple discipline layer in the active valuation path.

Expected effect:
- Hyper-growth companies can still receive long forecast horizons and premium valuations.
- Near-term growth spikes no longer persist almost linearly for 10-12 years.
- AMD-like projections should no longer reach multi-trillion-dollar revenue solely because the next-year analyst estimate is very high.
- Mature and compounder valuations should change much less than extreme hyper-growth valuations.

Validation performed:
- node --check passed for all changed JavaScript files.
- valuation-methods.js loads successfully through require().
- A synthetic AMD-like 12-year forecast was reduced from the prior multi-trillion-dollar path to a scale-damped path with an explicit plausibility score.
