StockTool V32 — Unified present/future valuation and canonical scenario anchoring

Changes:
1. Every valuation method now supplies both fair value today and a Year-N exit value.
   - DCF and SBC-adjusted DCF use terminal enterprise value less net debt, divided by projected exit shares.
   - Owner Earnings DCF uses the same future-value convention.
   - Revenue, EPS and EBITDA exit methods continue to provide both present and future values.
2. The five-year price target now blends all six methods using the same effective method weights used by the present-value consensus.
3. Margin of safety continues to use present fair values only; expected CAGR uses future exit values only.
4. The lifecycle/reality-checked return engine is the authoritative base CAGR.
5. Scenario analysis is rebuilt around that canonical CAGR and cannot replace it.
6. Probability-weighted scenario CAGR is limited to +/-2.5 percentage points around the canonical base.
7. Raw scenario and raw market returns remain available for audit.

This directly addresses:
- Growth companies receiving a low target because only multiple-exit methods were used for the future target.
- Mature companies bypassing return ceilings through probability-weighted scenarios.
- Present-value and future-price concepts being mixed in the headline CAGR.
