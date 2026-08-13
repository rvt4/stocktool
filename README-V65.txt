FreeScreener V65 — confidence & rerating robustness

Changed files:
- scoring-engine.js
- run-screener.js
- index.html
- engine/expected-return-engine.js
- engine/scenario-engine.js

System-wide changes only; no ticker-specific overrides.
- Separate data / forecast / valuation confidence components.
- Nonlinear valuation-disagreement penalty.
- Progressive rerating-dependence confidence/robustness penalty.
- Forecast sanity clamps now affect confidence, required MOS, and scenario width.
- One clamp is a caution; multiple independent clamps receive progressively larger penalties.
- Rerating + valuation disagreement interact instead of being treated as independent minor warnings.
