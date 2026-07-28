FreeScreener V7 — Milestone 1 (Core Decision Engine)

Replace:
- data-fetchers.js
- valuation-methods.js
- run-screener.js
- scoring-engine.js

Add the entire engine/ folder:
- engine/data-integrity.js
- engine/scenario-engine.js
- engine/expected-return-engine.js
- engine/thesis-engine.js

What this milestone adds:
1. Data Integrity Score and explicit issue list.
2. Bear / Base / Bull five-year CAGR scenarios.
3. Probability-weighted expected CAGR.
4. Risk-adjusted CAGR after downside, uncertainty, and data penalties.
5. Return Quality Score.
6. Investment Grade (A+ through F).
7. Plain-English investment thesis, strengths, and risks.
8. V7 scoring uses risk-adjusted return rather than only the deterministic base case.

This is Milestone 1, not the final V7 build. Industry-specific models, expanded
pricing-power inputs, portfolio manager mode, and historical forecast tracking
belong in later milestones.

Install:
1. Copy the four root JavaScript files into the same locations as before.
2. Add the new engine folder at the project root, next to run-screener.js.
3. Run: node run-screener.js
4. Commit the newly generated data/results.json.

All included JavaScript files passed node --check.
