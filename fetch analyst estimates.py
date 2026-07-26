"""
Nightly job: pull forward analyst estimates from yfinance (free) and cache them in
Supabase, replacing the FMP paid-tier-gated analyst estimates endpoint.

Run via GitHub Actions on a cron, same pattern as your existing Node screener pipeline.
Writes into a `analyst_estimates_cache` table (see SCHEMA.sql below) that your existing
Node-side estimates.js can read cache-first, exactly like it does today — this script
only changes WHERE the cached numbers come from, not how the rest of the app consumes
them.

ASSUMPTIONS I'm making that you should double-check / tell me if wrong:
  1. Your ticker universe lives in a local `tickers.txt` file (one ticker per line) that
     you already generate/maintain for the Russell 1000 screen. If instead your universe
     lives in Supabase (e.g. a `screener_results` table from last night's run), swap
     load_tickers() below for a Supabase SELECT — trivial change, tell me the table/column
     names and I'll wire it directly.
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
import logging
from datetime import datetime, timezone

import requests
import yfinance as yf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("analyst_estimates")

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
TABLE_NAME = "analyst_estimates_cache"

# Small delay between tickers — yfinance scrapes Yahoo's unofficial endpoints, and going
# too fast risks a temporary IP-level throttle for the whole run, not just one ticker.
REQUEST_DELAY_SECONDS = 0.4


def load_tickers(path="tickers.txt"):
    """ASSUMPTION #1: universe lives in a local file. Swap this for a Supabase query
    if your ticker list actually lives there instead."""
    if not os.path.exists(path):
        log.error(f"{path} not found. Populate it with one ticker per line, or tell "
                  f"me where your ticker universe actually lives so I can wire this "
                  f"to read from Supabase instead.")
        sys.exit(1)
    with open(path) as f:
        tickers = [line.strip().upper() for line in f if line.strip()]
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
                revenue_growth_fwd = float(row.get("growth")) if row.get("growth") is not None else None
                num_analysts = int(row.get("numberOfAnalysts")) if row.get("numberOfAnalysts") is not None else None
        except Exception as e:
            log.warning(f"{ticker}: revenue estimate fetch failed ({e})")

        try:
            eps_est = t.get_earnings_estimate()
            if eps_est is not None and "0y" in eps_est.index:
                row = eps_est.loc["0y"]
                eps_growth_fwd = float(row.get("growth")) if row.get("growth") is not None else None
        except Exception as e:
            log.warning(f"{ticker}: earnings estimate fetch failed ({e})")

        analyst_target_mean = None
        try:
            targets = t.get_analyst_price_targets()
            if targets is not None:
                # yfinance has returned this as either a dict or a DataFrame across
                # versions — handle both defensively.
                if isinstance(targets, dict):
                    analyst_target_mean = targets.get("mean")
                elif hasattr(targets, "loc") and "mean" in getattr(targets, "columns", []):
                    analyst_target_mean = float(targets["mean"].iloc[0])
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
        log.error(f"Supabase upsert failed ({resp.status_code}): {resp.text[:500]}")
    else:
        log.info(f"Upserted {len(rows)} rows to {TABLE_NAME}")


def main():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set — check GitHub Secrets.")
        sys.exit(1)

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
