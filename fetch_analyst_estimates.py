"""
Nightly job: pull forward analyst estimates from yfinance (free) and cache them in
Supabase, replacing the FMP paid-tier-gated analyst estimates endpoint.

Run via GitHub Actions on a cron, same pattern as your existing Node screener pipeline.
Writes into a `analyst_estimates_cache` table (see SCHEMA.sql below) that your existing
Node-side estimates.js can read cache-first, exactly like it does today — this script
only changes WHERE the cached numbers come from, not how the rest of the app consumes
them.

ASSUMPTIONS I'm making that you should double-check / tell me if wrong:
  1. RESOLVED: ticker universe reads from `watchlist.json` at the repo root — an array
     of {"ticker": "...", "sector": "..."} objects, matching your actual stocktool repo
     structure. This script must run in a job that has that repo checked out (the
     `actions/checkout@v4` step in the workflow snippet handles this automatically if
     the workflow file lives in the same repo as watchlist.json).
  2. SUPABASE_URL and SUPABASE_SERVICE_KEY are already GitHub Secrets, since your existing
     FMP-quota-guard system already writes to Supabase from Actions.
  3. Your `analyst_estimates_cache` table's existing columns roughly match what's below —
     if the real column names differ, tell me and I'll adjust the upsert payload rather
     than you having to migrate the table.

WHAT THIS DOES NOT DO: verify yfinance's exact response shape at runtime, since this
sandbox has no network access to test against the live Yahoo endpoints. yfinance's
unofficial API changes shape periodically — the first live run in Actions may need a
quick column-name adjustment based on whatever get_revenue_estimate()/
get_earnings_estimate() actually return that day. Defensive try/except per ticker means
one shape-mismatch won't kill the whole run; check the Actions log for anything logged
under "SKIP" after the first run.
"""

import os
import sys
import time
import math
import logging
from datetime import datetime, timezone

import requests
import yfinance as yf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("analyst_estimates")

# .rstrip("/") guards against a trailing slash in the secret producing a double slash
# (e.g. "https://xyz.supabase.co/" + "/rest/v1/...") — PostgREST returns a bare 404
# "Invalid path specified" for that, which looks like a permissions/routing problem but
# is really just a string-formatting issue.
_raw_supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
# Also guard against the secret holding the FULL REST endpoint
# ("https://xyz.supabase.co/rest/v1") instead of just the project base URL
# ("https://xyz.supabase.co") — an easy mistake since Supabase's dashboard surfaces the
# /rest/v1 URL prominently. Without this, the URL built below duplicates the path
# (".../rest/v1/rest/v1/analyst_estimates_cache"), which is exactly the kind of thing
# PostgREST rejects with PGRST125 "Invalid path specified in request URL".
if _raw_supabase_url.endswith("/rest/v1"):
    _raw_supabase_url = _raw_supabase_url[: -len("/rest/v1")]
SUPABASE_URL = _raw_supabase_url
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
TABLE_NAME = "analyst_estimates_cache"

# Small delay between tickers — yfinance scrapes Yahoo's unofficial endpoints, and going
# too fast risks a temporary IP-level throttle for the whole run, not just one ticker.
REQUEST_DELAY_SECONDS = 0.4


def clean_number(x):
    """yfinance/pandas returns NaN (not None) for missing numeric fields. NaN passes
    right through `is not None` checks, and Python's json.dumps raises on NaN/Infinity
    by default — one bad ticker's NaN was enough to crash the entire batch upsert and
    kill the whole run. Route every numeric field through this before it goes in the
    payload."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return x


def load_tickers(path="watchlist.json"):
    """Reads your existing Russell 1000 universe file — an array of
    {"ticker": "...", "sector": "..."} objects — rather than a tickers.txt that
    doesn't exist in your repo."""
    import json
    if not os.path.exists(path):
        log.error(f"{path} not found at repo root. If this script runs in a "
                  f"different repo/checkout than watchlist.json lives in, adjust "
                  f"the `path` default or pass --watchlist explicitly.")
        sys.exit(1)
    with open(path) as f:
        entries = json.load(f)
    tickers = [e["ticker"].strip().upper() for e in entries if e.get("ticker")]
    tickers = sorted(set(tickers))  # dedupe defensively, preserve deterministic order
    log.info(f"Loaded {len(tickers)} tickers from {path}")
    return tickers


def fetch_one(ticker):
    """Pull forward revenue growth, EPS growth, and analyst price target for one ticker.
    Returns None (and logs a SKIP) rather than raising, so one bad ticker never aborts
    the batch."""
    try:
        t = yf.Ticker(ticker)

        revenue_growth_fwd = None
        eps_growth_fwd = None
        num_analysts = None

        # get_revenue_estimate() returns a DataFrame indexed by period
        # ('0q','+1q','0y','+1y') with columns like avg, low, high, growth,
        # numberOfAnalysts. We want the CURRENT-YEAR forward estimate ('0y') as the
        # single "revenueGrowthFwd" figure your scoring engine expects.
        try:
            rev_est = t.get_revenue_estimate()
            if rev_est is not None and "0y" in rev_est.index:
                row = rev_est.loc["0y"]
                revenue_growth_fwd = clean_number(row.get("growth"))
                raw_num_analysts = clean_number(row.get("numberOfAnalysts"))
                num_analysts = int(raw_num_analysts) if raw_num_analysts is not None else None
        except Exception as e:
            log.warning(f"{ticker}: revenue estimate fetch failed ({e})")

        try:
            eps_est = t.get_earnings_estimate()
            if eps_est is not None and "0y" in eps_est.index:
                row = eps_est.loc["0y"]
                eps_growth_fwd = clean_number(row.get("growth"))
        except Exception as e:
            log.warning(f"{ticker}: earnings estimate fetch failed ({e})")

        analyst_target_mean = None
        try:
            targets = t.get_analyst_price_targets()
            if targets is not None:
                # yfinance has returned this as either a dict or a DataFrame across
                # versions — handle both defensively.
                if isinstance(targets, dict):
                    analyst_target_mean = clean_number(targets.get("mean"))
                elif hasattr(targets, "loc") and "mean" in getattr(targets, "columns", []):
                    analyst_target_mean = clean_number(targets["mean"].iloc[0])
        except Exception as e:
            log.warning(f"{ticker}: price target fetch failed ({e})")

        if revenue_growth_fwd is None and eps_growth_fwd is None and analyst_target_mean is None:
            log.info(f"SKIP {ticker}: no usable estimate data returned")
            return None

        return {
            "ticker": ticker,
            "revenue_growth_fwd": revenue_growth_fwd,
            "eps_growth_fwd": eps_growth_fwd,
            "analyst_target_mean": analyst_target_mean,
            "num_analysts": num_analysts,
            "source": "yfinance",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        log.warning(f"SKIP {ticker}: unexpected error ({e})")
        return None


def upsert_batch(rows):
    """Upsert into Supabase via the PostgREST API. Uses on_conflict=ticker so re-running
    the same night (or the next night) overwrites rather than duplicates."""
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/{TABLE_NAME}?on_conflict=ticker"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    resp = requests.post(url, headers=headers, json=rows, timeout=30)
    if resp.status_code not in (200, 201, 204):
        # Log the actual URL that was requested (safe — contains no secret, the key
        # goes in a header, not the URL) so a routing/path problem shows up directly in
        # the log instead of requiring another round of guessing.
        log.error(f"Supabase upsert failed ({resp.status_code}) for URL {resp.url}: {resp.text[:500]}")
    else:
        log.info(f"Upserted {len(rows)} rows to {TABLE_NAME}")


def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set — check GitHub Secrets.")
        sys.exit(1)

    log.info(f"Resolved Supabase endpoint: {SUPABASE_URL}/rest/v1/{TABLE_NAME}")

    tickers = load_tickers()
    batch = []
    fetched, skipped = 0, 0

    for i, ticker in enumerate(tickers):
        row = fetch_one(ticker)
        if row:
            batch.append(row)
            fetched += 1
        else:
            skipped += 1

        # Upsert in batches of 50 rather than one request per ticker, and rather than
        # holding ~1000 rows in memory for a single request at the very end.
        if len(batch) >= 50:
            upsert_batch(batch)
            batch = []

        time.sleep(REQUEST_DELAY_SECONDS)

        if (i + 1) % 100 == 0:
            log.info(f"Progress: {i + 1}/{len(tickers)} ({fetched} fetched, {skipped} skipped)")

    upsert_batch(batch)  # flush remainder
    log.info(f"Done. {fetched} fetched, {skipped} skipped out of {len(tickers)} tickers.")


if __name__ == "__main__":
    main()
