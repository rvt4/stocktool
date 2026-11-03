Build 27 — independent economic valuation cross-check (first rebuild stage)

Replace run-screener.js and add engine/economic-crosscheck.js and economic-crosscheck-test.js.
Run node economic-crosscheck-test.js and node model-smoke-test.js, then nightly.

Each screener record gains economicCrosscheck: an independently computed FCF DCF,
forecast growth, historical median operating margin, terminal margin, FCF/NOPAT,
terminal value share, and discrepancy versus the production valuation.

IMPORTANT: This deliberately does NOT overwrite production valuations or buy
recommendations. The existing FCF path is not yet independently verified and
some companies (financials, REITs, negative-FCF companies) are not appropriate
for this generic cross-check. We must inspect discrepancy data before making
it authoritative. This is NOT a completed fix or validated replacement engine.
