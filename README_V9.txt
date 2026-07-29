StockTool V9 — adaptive forecast and valuation engine

What changed
1. Engine-generated forecasts now blend analyst consensus, recent/historical revenue growth, trend, sustainable ROIC/reinvestment growth, and industry calibration.
2. Regime-shift detection increases the weight on current analyst estimates when consensus sharply diverges from historical growth, so sudden slowdowns or accelerations are not ignored.
3. Valuation-method weights now learn by industry from stored forecast snapshots. Methods with lower historical error receive more weight; weaker methods receive less.
4. Exit-multiple discipline is less mechanically punitive for durable, high-quality semiconductor leaders with reliable double-digit exit growth.
5. Forecast history now stores the inputs needed to evaluate forecast growth and every valuation method over time.
6. Calibration now learns return bias, forecast-source bias, and method-level accuracy.

Important rollout behavior
- V9 works immediately using the blended forecast and revised multiple logic.
- The self-calibration layer needs future monthly snapshots before its learned adjustments become meaningful.
- Existing V8 snapshots still help calibrate expected-return bias, but method-level and forecast-source learning begins with the first V9 snapshot because older snapshots did not store those fields.

Files changed
- valuation-methods.js
- run-screener.js
- engine/calibration-engine.js
- engine/exit-multiple-engine.js
- engine/forecast-tracker.js
- engine/forecast-engine.js (new)

No frontend change was required. The existing top summary box and detailed report continue to work, while V9's forecast assumptions and learned weights are included in results.json for auditability.
