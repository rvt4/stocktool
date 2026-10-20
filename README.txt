Upload the five files to the repository root, replacing app.js, index.html, style.css, and .github/workflows/nightly.yml; add fetch_history.py at the root.
IMPORTANT: nightly.yml goes in .github/workflows/, NOT the root. The other four files go at the root.

The next nightly run generates SEC financial history for up to 100 companies; additional companies populate over subsequent runs. This is intentional to avoid flooding SEC with 1000+ requests. Existing data/results.json remains unchanged.

SEC_USER_AGENT should be configured in GitHub Actions secrets as a descriptive app/contact identifier. GitHub Pages must publish data/history/*.json for history to appear. Missing tickers show an honest unavailable message.

No Supabase schema changes needed. Saved projections continue to use existing Supabase tables.

Notes: SEC Company Facts coverage and tags vary. Reported financials are not adjusted for acquisitions, divestitures, tax anomalies or other one-offs. The quarter extraction is conservative and missing metrics remain blank; compare against original filings before investing.
