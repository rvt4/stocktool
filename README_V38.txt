Stocktool V38 — GitHub results-size fix

Changed files:
- run-screener.js
- nightly.yml

What changed:
1. data/results.json is now written as compact JSON instead of pretty-printed JSON.
2. The write is atomic through data/results.json.tmp, preventing partial frontend files.
3. The screener fails early if compact results reach 95 MiB, safely below GitHub's 100 MiB hard limit.
4. The nightly workflow defensively compacts every generated JSON artifact before committing.
5. The workflow prints each artifact's final size and includes validation-report.json in the commit.

No frontend change is required. index.html continues loading data/results.json normally.
