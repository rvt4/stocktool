StockTool V34 — Incremental Margin & Operating Leverage Engine

Changed file:
  engine/business-forecast-engine.js

What changed:
- Replaced historical-median margin reversion with an incremental-margin and operating-leverage model.
- EBITDA, FCF, and net margins are forecast independently.
- Analyst EPS and revenue estimates are converted into explicit near-term net-margin anchors.
- Years 3+ bridge smoothly from analyst margins to sustainable margins; no Year-2-to-Year-3 reset.
- High-growth businesses with pricing power, strong ROIC, stable gross margins, and no deterioration signal cannot show broad-based margin compression as the central case.
- Historical incremental profit on incremental revenue is used as supporting evidence.
- Added margin diagnostics and V34 assumptions to results.json audit output.

After replacing the file, rerun the full screener to regenerate data/results.json.
