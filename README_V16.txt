StockTool V16 — Probabilistic Equity Research Engine
====================================================

V16 keeps every V15 coverage, valuation-integrity, timeout, SEC parsing and
premium-persistence improvement, then adds an integrated uncertainty and
economic-quality layer.

Major additions
---------------
1. Full bear/base/bull scenario engine
   - Each scenario has its own growth, margin, exit-price and CAGR path.
   - Scenario probabilities adjust for forecast reliability, analyst coverage,
     moat, data integrity, cyclicality and growth quality.
   - Probability-weighted CAGR is now the canonical expected return used by the
     screener and portfolio logic. The former central valuation remains Base CAGR.

2. Cycle normalization
   - Uses multi-year median revenue growth, FCF margin, EBITDA margin and capex.
   - Detects cyclicality from median absolute growth deviations and peak/trough
     behavior.
   - Reduces analyst weight for volatile cyclical companies.

3. Exponential growth-decay curves
   - Analyst estimates anchor the first two years.
   - Excess growth decays exponentially toward a sustainable long-run anchor.
   - Decay accelerates for cyclical and very large companies.
   - Existing cumulative revenue expansion limits remain active.

4. Capital-intensity engine
   - Estimates normalized capex, reinvestment needs, incremental ROIC and FCF
     conversion.
   - High growth no longer receives identical cash conversion regardless of the
     capital required to produce it.

5. Competitive-pressure engine
   - Converts moat, pricing power and margin erosion into growth fade, margin fade
     and premium-retention adjustments.

6. Analyst reliability and learning calibration
   - Existing forecast history compares old analyst, historical and model forecasts
     with later actual results.
   - Industry/category bias and valuation-method accuracy continue to alter future
     forecasts and method weights once enough observations accumulate.

7. Growth-quality score
   - Scores cash conversion, positive growth consistency, margin stability,
     pricing power, capital efficiency and competitive durability.

8. Company-specific mean reversion
   - The premium-persistence system remains the terminal-multiple foundation.
   - V16 scenario exits additionally adjust premium retention for competitive
     durability instead of reverting every business to a generic sector multiple.

9. Investment Committee score
   - Combines expected return, confidence, business quality, margin of safety,
     growth quality, downside protection, capital intensity and competitive
     durability.
   - This is now the default screener sort rather than raw CAGR.

Frontend additions
------------------
- Probability-weighted CAGR
- Bear CAGR
- Base CAGR
- Bull CAGR
- Investment Committee score
- Growth Quality score
- Scenario probabilities
- Cycle-normalized growth
- Capital intensity and FCF conversion
- Competitive durability

Files added
-----------
engine/cycle-normalization-engine.js
engine/capital-intensity-engine.js
engine/competitive-pressure-engine.js
engine/growth-quality-engine.js
engine/investment-committee-engine.js

Files updated
-------------
engine/scenario-engine.js
engine/forecast-engine.js
engine/portfolio-engine.js
run-screener.js
scoring-engine.js
valuation-methods.js
index.html
