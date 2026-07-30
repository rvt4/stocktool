StockTool V20 — Owner Earnings Primary Architecture

V20 replaces the blended-six-model expected-return architecture with a single
owner-earnings economic model.

Primary valuation and return path
1. Normalize owner earnings per share from up to five historical years.
2. Project owner earnings from the operating forecast.
3. Apply a justified terminal owner-earnings multiple based on discount rate,
   terminal growth, moat, ROIC, forecast reliability, lifecycle and growth.
4. Calculate investor CAGR directly from today's price, exit owner earnings,
   the justified terminal multiple and dividends.
5. Use DCF, revenue, EPS and EV/EBITDA methods only as validation/confidence
   inputs. They no longer determine the canonical expected return.

Important safeguards
- Lifecycle-specific return ceilings.
- Multi-year normalized starting owner earnings.
- Explicit SBC and maintenance-capex deductions.
- Validation disagreement can temper an extreme estimate, but cannot replace
  the primary owner-earnings model.
- Fair value now uses Owner Earnings DCF first, then FCF DCF as a fallback.
- Bear/base/bull scenarios are anchored to the V20 owner-earnings base case.

New dashboard diagnostics
- Primary model name
- Normalized owner earnings per share
- Exit owner earnings per share
- Owner-earnings CAGR
- Justified terminal P/OE multiple
- Validation gap
