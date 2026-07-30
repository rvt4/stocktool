StockTool V13 — Coverage & Resilience Update

Purpose
- Prevent established companies from being discarded because SEC XBRL tags differ.
- Gracefully include limited-history companies with lower confidence.
- Prevent a single network request from hanging the nightly screener.
- Produce an auditable per-run coverage report.

Changes
1. SEC annual parser now accepts valid annual 10-K facts even when fp=FY is absent.
2. Added additional revenue tags for banks, brokers, insurers, utilities, and older filers.
3. Missing conventional revenue can use an explicitly flagged operating-scale proxy.
4. Missing capex can use CFO as an explicitly flagged FCF proxy; confidence is reduced.
5. Two-year histories can be included with a 20-point limited-history penalty.
6. Added ticker normalization for common share-class symbols (BRKB, BRKA, HEIA, UHALB, etc.).
7. Added 20-second request timeouts, bounded retries, and retry backoff.
8. Added data/screener-diagnostics.json with skipped/failed ticker reasons and coverage.
9. Added data-integrity penalties for proxy financial fields.

Notes
- A proxy does not silently pretend to be reported data. It is marked in financials.dataQuality
  and reduces confidence.
- Companies with fewer than two usable annual years, no core financial facts, or no current
  price are still skipped.
- Financial firms can now pass ingestion more often, but their valuation should still be
  interpreted through the existing industry-specific suitability logic.
