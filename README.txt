FreeScreener Fix Pack v2

Replace these four project files:
- data-fetchers.js
- valuation-methods.js
- run-screener.js
- scoring-engine.js

Main changes:
1. Reconciles SEC share counts against net income / diluted EPS.
2. Preserves raw share count and applied scale for auditing.
3. Adds valuation input integrity checks.
4. Rejects individual valuation methods with implausible per-share/price ratios.
5. Prevents invalid valuations from entering the Strong Buy / buy-list gate.
6. Exposes validation issues and raw methods in results.json.

All JavaScript files passed: node --check
