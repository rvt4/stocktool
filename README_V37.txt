StockTool V37 — consensus, dilution, and margin reliability upgrade

Changed files:
- valuation-methods.js
- engine/business-forecast-engine.js

Main fixes:
1. Analyst-consensus sanity layer
   - Compares analyst growth with historical growth, quarterly momentum, company scale, and persistence.
   - Clamps implausible outlier estimates instead of allowing a single bad cache record to drive the model.
   - Rejects absolute revenue estimates when they materially conflict with the sanitized growth estimate.

2. Fading dilution model
   - Ignores split/merger/source-unit share-count outliers.
   - Blends recent and long-run dilution with SBC intensity.
   - Uses a year-by-year dilution path that fades over time instead of compounding one historical rate forever.
   - Intended to stop CELH and PLTR share counts from exploding unrealistically.

3. Margin guardrails
   - Adds an analyst-anchored profitability floor for profitable growth/compounder businesses.
   - Prevents strong near-term margins from collapsing toward obsolete historical margins without deterioration evidence.
   - Caps heroic margin expansion for mature, lower-growth businesses.

4. Auditability
   - New consensus checks, dilution diagnostics, and V37 version labels are exposed in projection assumptions.

Regression check:
- Existing decision-system smoke test passes.
