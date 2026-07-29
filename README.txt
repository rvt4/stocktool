FreeScreener V7 valuation repair

Changed files:
- data-fetchers.js
- valuation-methods.js
- run-screener.js

What changed:
1. Missing-share repair
   - Adds SEC DEI EntityCommonStockSharesOutstanding as a fallback candidate.
   - Adds alternate diluted-share and diluted-EPS tags.
   - Reconciles share candidates with net income / diluted EPS.
   - For the rare stock still missing shares, conditionally calls Finnhub profile2 and derives shares from market cap / current price.
   - Records the share source for auditability.

2. Reliability-weighted valuation blending
   - Determines the industry model before valuation.
   - Adds industry-specific starting weights.
   - Uses a cash-flow anchor made from DCF, SBC-adjusted DCF, and Owner Earnings.
   - Penalizes exit valuations that diverge materially from the cash-flow anchor.
   - Caps Revenue Exit influence at 8% for semiconductor/hardware companies.
   - Caps EPS and EV/EBITDA exit influence for semiconductor/hardware companies.
   - Keeps more room for Revenue Exit when the company is classified as software.
   - Makes agreement scoring reflect divergence from both the method median and cash-flow anchor.

Upload these three files into the repository root, replacing the existing versions, then rerun the nightly workflow.
