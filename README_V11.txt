StockTool V11 — Classification, Return Quality, and Reality Checks

Main changes
============
1. Rebuilt lifecycle classification using multi-year growth, growth volatility,
   margin volatility, ROIC, FCF consistency, company size, and industry type.
2. Added a Temporary Disruption lifecycle for one-year inventory/distribution
   interruptions where analyst growth and margins support a recovery.
3. Added explicit cyclical and financial classification overrides so recent
   growth spikes do not label mature industrials or financials as hyper-growth.
4. Aligned the forecast engine with the lifecycle engine. Previously the
   projection function independently inferred a category, which could disagree
   with the displayed lifecycle and apply the wrong forecast curve.
5. Normalized margins toward multi-year medians for cyclicals, turnarounds, and
   financials rather than applying normal multiples to peak/rebound margins.
6. Added a second-pass Reality Check and Return Quality engine:
   - separates operating CAGR from valuation rerating;
   - grants only confidence-weighted partial rerating credit;
   - limits implausible lifecycle-specific CAGRs;
   - penalizes mega-cap forecasts and low-agreement valuations;
   - prevents multiple-dominated returns from receiving Exceptional ratings.
7. Added Return Quality diagnostics to returnEngineV2 output.

Expected effects
================
- BKNG/COKE/WU/CMCSA and other mature names should no longer receive 30–40%
  CAGRs primarily from full multiple normalization.
- AMD/NOW/ANET and other premium growth businesses retain operating growth but
  are protected from unlimited negative multiple compression.
- CELH-like temporary disruptions can receive a recovery-aware forecast when
  next-year consensus and margins support it.
- KDP/ALSN/FIX and similar businesses should be less likely to be mislabeled as
  hyper-growth based on a noisy recent year.
- Cyclicals are valued on normalized margins, reducing peak-earnings + normal-
  multiple double counting.

No ticker-specific overrides were added. All changes are systematic.
