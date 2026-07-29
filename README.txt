FreeScreener V7 — Consolidated Valuation Update

Upload these three files, preserving the engine/ folder:
- valuation-methods.js
- engine/return-engine-v2.js
- engine/method-selection-engine.js

Included fixes:
- CAGR exactly reconciles current price, five-year target, and modeled dividends.
- Adaptive valuation-method selection by industry and input quality.
- Weak Owner Earnings inputs are heavily down-weighted or effectively excluded.
- Semiconductor/hardware weighting emphasizes DCF and SBC-adjusted DCF.
- Quality-adjusted mean reversion reduces retention of extreme current multiples.
- Exit-multiple audit includes currentPremiumRatio, maturityFactor,
  premiumExtremityFactor, and qualityPremiumRetained.
