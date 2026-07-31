StockTool V30 — Business-First Forecast Engine

Changed files:
  engine/business-forecast-engine.js (new)
  engine/forecast-engine.js
  valuation-methods.js

What changed
------------
1. The operating forecast is now derived before valuation and largely independent
   of the stock's category label.
2. Up to ten annual revenue observations are used to identify acceleration,
   deceleration, normalization, recovery, deterioration, and structural inflection.
3. Available SEC quarterly revenue points are used as a current-momentum signal.
4. Current-year and next-year analyst estimates anchor years one and two, weighted
   by analyst breadth and agreement rather than blindly accepted or averaged away.
5. Older history is deliberately downweighted during a supported regime shift.
6. Revenue growth is forecast one year at a time and fades according to measured
   persistence, company scale, reinvestment economics, and runway.
7. EBITDA, FCF, and net margins now follow separate trend/operating-leverage paths.
8. Every forecast writes an auditable regime, persistence score, scale adjustment,
   annual path, margin path, and plausibility score into results.json.

Important
---------
Rerun the full screener after uploading these files. Existing results.json rows were
calculated by the prior engine and will not change until the nightly job finishes.
