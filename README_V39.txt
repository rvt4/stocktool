StockTool V39 — quality-aware core engine release

Changed files
- engine/category-engine.js
- engine/method-selection-engine.js
- valuation-methods.js

What changed
1. Turnaround classification now requires a current operating impairment.
   Old weak years no longer cause healthy secular growers such as AMD to be
   labeled Turnaround merely because their five-year history contains a trough.
2. Valuation-method selection is now quality-, moat-, persistence-, lifecycle-,
   and forecast-reliability-aware. Durable compounders receive a measured tilt
   toward forward EPS/revenue and SBC-adjusted cash-flow methods.
3. Dynamic method caps allow more forward-method weight only when the business
   supports a persistent premium. No single optimistic multiple can dominate.
4. Revenue-exit reliability now recognizes quality/persistence while remaining
   bounded by analyst reliability and valuation-method agreement.

Expected behavior
- AMD should classify as Growth/Compounder rather than Turnaround when its latest
  operating condition is healthy.
- PLTR and other premium growth names may receive a higher quality-supported fair
  value than before, but extreme current valuations should still produce low or
  negative expected returns.
- Mature, cyclical, low-quality, or weak-forecast businesses remain anchored to
  DCF, owner earnings, and EBITDA.

Validation
- node --check passed for all changed JavaScript files.
- engine/decision-system-test.js passed.
- engine/validation-suite.js passed.
