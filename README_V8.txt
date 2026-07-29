FreeScreener V8 — Decision Platform Update

Changed files:
- index.html
- scoring-engine.js
- run-screener.js
- engine/portfolio-engine.js
- engine/thesis-engine.js
- engine/rating-engine.js

What changed:
1. Hold/Watch is now Watch. Hold remains a separate rating.
2. Risk-Adjusted Return was removed from the screener and scored output.
3. Expected CAGR is the single canonical return used for scoring, ratings, and portfolio sizing.
4. Confidence replaces Risk-Adjusted Return near the front of the screener table.
5. Each stock detail page now begins with a V8 decision dashboard showing:
   - Expected CAGR
   - Confidence
   - Investment grade
   - Suggested position-size range
   - Buy-below price
   - Fair value today
   - Five-year target
   - Position tier
   - Top strengths
   - Primary risks
6. Portfolio sizing now uses the institutional price-target CAGR instead of the legacy risk-adjusted field.
7. Thesis generation now runs after pricing-power, compounder, and downside modules so the dashboard can use their outputs.

Deployment:
- Preserve the engine/ folder.
- Replace the six files listed above.
- Run the nightly screener workflow to regenerate data/results.json.
- The current static results file may continue showing old labels until the workflow finishes.

Validation:
- All JavaScript files passed node --check.
- The JavaScript embedded in index.html passed node --check.
