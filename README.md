# FreeScreener

A personal stock screener built on 100% free data — no paid APIs required.
Category-first scoring (Compounder / Growth / Value / Turnaround / Dividend),
sector-relative ranking, pricing-power detection, and a dynamic-margin-of-safety
buy list targeting 15%+ expected CAGR.

## How it works

1. **`watchlist.json`** — the tickers you want tracked. Start small, expand over time
   (SEC EDGAR has no hard rate limit but be polite — the runner sleeps 300ms between tickers).
2. **`data-fetchers.js`** — pulls financials from SEC EDGAR (free, no key), prices from
   Stooq (free, no key), and optionally quote/profile from Finnhub's free tier (needs a free key).
3. **`scoring-engine.js`** — classifies each stock into a category, scores it against
   category-specific metrics, computes a Pricing Power Score, sector-relative Z-score,
   dynamic MOS requirement, and Expected CAGR.
4. **`run-screener.js`** — runs the whole pipeline and writes `data/results.json`.
5. **`index.html`** — static frontend that reads `data/results.json`. Sortable/filterable table.

## Setup (10 minutes, all free)

1. Create a new GitHub repo, push these files.
2. **Optional but recommended:** get a free Finnhub API key (finnhub.io) for live quotes.
   Add it as a repo secret: Settings → Secrets and variables → Actions → New repository secret
   → name `FINNHUB_API_KEY`.
3. Enable GitHub Pages: Settings → Pages → Source: `main` branch, `/ (root)`.
4. Enable GitHub Actions if prompted (Settings → Actions → General → Allow all actions).
5. Trigger the first run manually: Actions tab → "Nightly Screener Run" → Run workflow.
   (It also runs automatically every night at 6am UTC — edit the cron in
   `.github/workflows/nightly.yml` if you want a different time.)
6. Once it finishes (~1-2 min for the starter watchlist), visit your GitHub Pages URL —
   something like `https://<your-username>.github.io/<repo-name>/`.

## Editing your watchlist from your phone

Same workflow you're used to with StockDesk: open `watchlist.json` in the GitHub mobile
web UI, add/remove tickers, commit. It'll pick up the changes on the next nightly run
(or trigger manually from the Actions tab).

## Reverse DCF (`dcf.js`)

Wired in and live: `data-fetchers.js` now computes a fair value per share for every
stock using trailing 3yr revenue CAGR as the year-1 growth assumption, fading linearly
to a 2.5% terminal growth rate over 10 years, discounted at a sector-specific rate
(see `SECTOR_DISCOUNT_RATES` in `dcf.js` — edit these if you disagree with the risk
premiums I picked). Margin of Safety now populates for real, which means
`meetsRequiredMOS` and `qualifiesForBuyList` are live too.

This is deliberately simple — one discount rate per sector, FCF growth assumed to
track revenue growth, linear fade. Good for a first-pass screen across your whole
watchlist. For a name you're seriously considering, model it by hand.

## What's still rough / next steps

- **Historical multiples**: `historicalMultiples` (for the "cheap vs its own history" logic)
  is currently empty. This needs trailing EPS/EBITDA history combined with Stooq daily prices —
  doable, just needs a backfill script.
- **Quarterly pricing-power data** (revenue vs. unit growth, inventory turnover trend):
  currently empty — needs parsing SEC 10-Q filings, which is more involved than 10-K annual data.
- **Earnings call text**: no reliably free full-transcript source was wired in. If you find one
  you're comfortable with, drop the text into `earningsCallText` and the keyword scanner will
  pick it up automatically.
- **ROIC calc** in `data-fetchers.js` is a rough proxy (operating income / (debt − cash)).
  Worth refining with a proper invested-capital calculation once the rest is working.

None of these block a working v1 — the app runs end-to-end today, just with fair value
and pricing-power quarterly signals coming back as null/neutral until you fill those in.
