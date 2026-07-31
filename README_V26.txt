STOCKTOOL V26 — CUMULATIVE PHASE 1 + PHASE 2 BUILD

This package is built directly from the V22 codebase that produced the user's latest
screenshots. It does not require V23, V24, or V25 to be installed first.

WHAT IS INCLUDED
1. Frozen, multi-method valuation foundation
   - DCF, SBC-adjusted DCF, Owner Earnings, EPS, EBITDA, and revenue exit methods.
   - Reliability-weighted consensus rather than a single method overriding the result.
   - Canonical investor CAGR always runs from today's price to modeled future value plus dividends.

2. Sector- and industry-aware valuation
   - Method suitability and prior weights differ by industry.
   - Software, semiconductors, financials, consumer, healthcare, industrials,
     energy/materials, utilities/REITs, and a general fallback use different rating gates.

3. Probability-informed rating tiers
   - Exceptional Buy, Strong Buy, Buy, Hold, Avoid, and Sell require several signals to agree.
   - High ratings require quality, expected return, margin of safety, confidence,
     method agreement, downside control, and sector-specific gates.
   - The probability outputs are model confidence estimates, not guaranteed statistical odds.

4. Capital allocation and economic quality
   - ROIC level/trend, dilution, debt discipline, FCF consistency, pricing power,
     moat, growth quality, and economic quality are evaluated independently of price.

5. Learning foundation
   - Every run stores forecast snapshots.
   - Calibration remains inactive until enough mature observations exist.
   - Learning adjustments are capped and cannot erase stable prior weights.

6. Explainability and validation
   - Each stock receives decisionExplanation and probabilityProfile objects.
   - Every completed screener run writes data/validation-report.json.
   - A local fixture test checks rating monotonicity and impossible combinations.

INSTALLATION
- Use stocktool-v26-full.zip to replace the repository contents, OR
- Use stocktool-v26-changed-files.zip on top of the unchanged V22 project.
- Do not install V23/V24/V25 first.
- Do not delete old engine files. The changed-files package overwrites changed files
  and adds new dependencies while retaining existing modules.

AFTER INSTALLING
1. Commit and push all files.
2. Run the normal screener GitHub Action.
3. Confirm data/results.json, data/calibration-report.json,
   data/forecast-history.json, and data/validation-report.json are updated.
4. Run `node engine/decision-system-test.js` locally or in Actions for a quick smoke test.

IMPORTANT
This engine is a disciplined research and ranking tool, not an autonomous investment
adviser. The first run improves consistency immediately, but historical outcome
calibration still needs real point-in-time observations to become empirically calibrated.
