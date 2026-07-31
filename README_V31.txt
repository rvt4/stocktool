StockTool V31 — Persistence Runway and Canonical Return Fix

Changed files:
- engine/business-forecast-engine.js
- valuation-methods.js
- scoring-engine.js

Key fixes:
1. Replaces the immediate Year-3 fade with a three-phase forecast:
   near-term analyst evidence -> persistence runway -> mature convergence.
2. Converts persistence into an explicit 2-7 year runway.
3. Enforces dynamic year-over-year continuity limits so a central forecast cannot
   fall 25-30 percentage points in one year without a deterioration regime.
4. Separates an intermediate bridge growth anchor from the terminal growth anchor.
5. Makes valuation-method weights lifecycle-consistent. Owner earnings is reduced
   to a downside cross-check for well-supported inflecting growth businesses.
6. Relaxes cash-flow-anchor penalties on forward valuation methods during genuine
   high-growth transitions while retaining method caps and agreement checks.
7. Fixes headline expected-return precedence: the unified return engine is now
   authoritative; scenario and owner-earnings outputs are supporting diagnostics.

Validation:
- Node syntax checks passed for all changed JavaScript files.
- Existing decision-system smoke test passed.
- Synthetic AMD/PLTR-style tests no longer show a Year-3 growth cliff.
