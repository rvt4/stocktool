StockTool V21 — valuation and scenario integrity fix

Changed files:
- valuation-methods.js
- engine/valuation-consensus.js
- engine/scenario-engine.js

What changed:
1. Bear/Base/Bull scenarios are built as deviations from one internally consistent base path.
2. Scenario exits and CAGRs enforce Bear < Base < Bull.
3. Scenario terminal values use FCF, net income, EBITDA, and revenue—not revenue alone.
4. The reliability-weighted unified consensus is the displayed fair value.
5. Owner Earnings remains an important validation method, but cannot override all other methods.
6. Intrinsic and market method families use their reliability-adjusted weights.
7. Method disagreement lowers confidence instead of forcing a 92% intrinsic weighting.
8. Displayed CAGR and exit price come from the unified return engine.

Replace the three changed files, commit, and rerun the screener workflow. Existing results.json values remain visible until the new run completes.
