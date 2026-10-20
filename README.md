# Stock Research Studio — clean GitHub Pages replacement

Three pages: **Screener**, **Projections**, **Portfolio**. No backtest UI. Preserves the existing financial data collection, forecasting engines and nightly GitHub Actions. Supabase authentication and row-level-security protect your personal projections and holdings.

## Installation

1. **Back up your existing repository** (download ZIP or create a backup branch). Do not delete your existing Supabase project, tables, secrets, or GitHub repository settings.
2. In your existing Supabase project, open **SQL Editor** and run `supabase.sql`. This adds only `stock_projections` and `stock_holdings`; it does not delete other tables.
3. In Supabase **Authentication → Providers**, enable Email sign-in. In **URL Configuration**, set Site URL to your GitHub Pages URL and add it to Redirect URLs. Confirm email if prompted.
4. Edit `config.js`: set the **project URL** and **publishable/anon key** from Supabase → Project Settings → API. **Never** paste `service_role`, `SUPABASE_SERVICE_KEY`, or database passwords into `config.js` or any browser file.
5. Upload **the contents of this folder** to the root of your GitHub repository (including the `.github/workflows/nightly.yml` folder). Remove old backtest and duplicated `.github 2`, `.github 3` etc. folders. Keep GitHub repository secrets (`FINNHUB_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SEC_USER_AGENT`) configured in Settings → Secrets and variables → Actions.
6. Ensure GitHub Pages is publishing from the repository root on your desired branch. Under Actions run **Nightly Screener Run** manually once. The included `data/results.json` is a zero-stock placeholder until that completes.
7. Open the site, sign up / sign in, choose a company, and save a projection. Then add a holding. Verify it appears after refreshing and on another device.

## Financial-model limitations — important

- This release **does not claim to automatically identify one-time gains, acquisitions or normalize financials with SEC source citations**. The existing engine is retained as the screening starting point; the research page explicitly flags normalization as **unverified**. This needs a separate audited SEC normalization pipeline before automatic adjustments can be trusted.
- Editable projection is a transparent **10-year EPS exit** with flat dividends, fixed net margin and share-dilution assumptions. A simple owner FCF diagnostic is displayed but not used to set the EPS-exit valuation. It is **not** a full integrated three-statement model.
- Starting assumptions are extracted opportunistically from the existing screener output. Missing revenue or shares are **left blank rather than invented**. Input values and reported market prices must be verified.
- Forecasts are not investment recommendations. No historical backtest is shipped in the UI.
- GitHub Pages is public, but individual holdings/projections are private to the authenticated account due to Supabase RLS. The nightly screener data is public.

## File map

`index.html`, `style.css`, `app.js` — 3-page website. `config.js` — public Supabase browser settings. `supabase.sql` — private cloud storage tables and policies. `.github/workflows/nightly.yml` — nightly refresh. `run-screener.js`, `data-fetchers.js`, `engine/`, `fetch_analyst_estimates.py`, `model-smoke-test.js` — existing financial pipeline retained.
