StockTool V38.5

Baseline: V38. V39 valuation and method-weighting changes have been removed.

Changes from V38:
- Category engine now requires current operating impairment before assigning Turnaround.
- Prevents old weak periods from relabeling healthy secular growers such as AMD.
- No V39 premium-growth method weighting or valuation-cap changes are included.

Files that must overwrite V39:
- engine/category-engine.js
- engine/method-selection-engine.js
- valuation-methods.js

Delete these V39-only files if present:
- README_V39.txt
- data/validation-report.json

The full package already excludes those V39-only files.
