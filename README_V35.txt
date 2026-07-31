FreeScreener V35 — quality-aware valuation update

Main changes
1. Dynamic exit multiples now use growth, moat, pricing power, ROIC persistence,
   margin stability, recurring revenue, capital allocation, balance-sheet quality,
   dilution, cyclicality, and forecast reliability.
2. Elite businesses retain a larger justified valuation premium only when several
   independent quality signals agree. A high current multiple is never sufficient.
3. The screener's expected return is now calculated over a true five-year investment
   horizon even when the operating/DCF forecast extends seven to ten years.
4. Long-horizon method exit values are translated to internally consistent five-year
   targets before blending.
5. High-quality but expensive companies can receive Hold rather than being grouped
   with weak businesses under Avoid.
6. Audit output includes quality context, quality premium, five-year target values,
   full forecast horizon, and dynamic rerating allowance.

Files changed
- engine/premium-persistence-engine.js
- engine/exit-multiple-engine.js
- engine/fade-engine.js
- engine/primary-valuation-engine.js
- engine/probability-rating-engine.js
- valuation-methods.js

Unused files found by static import analysis
- engine/calibration-engine.js
- engine/decision-system-v26.js
- engine/rating-engine.js

The following is a test file, not production runtime code:
- engine/decision-system-test.js

Delete the three unused runtime files only after V35 is successfully deployed.
Keep decision-system-test.js if you want to retain the local smoke test.
