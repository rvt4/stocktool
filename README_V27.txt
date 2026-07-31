StockTool V27 — Business-First Plausibility Update

Install
-------
This is cumulative from V26. If V26 is currently installed, overwrite the files in
stocktool-v27-changed-files.zip. Do not delete any other project files.

Changes
-------
1. Extreme CAGR protection
   - Decision returns use a confidence-weighted median of the probability-weighted,
     base, canonical five-year, and risk-adjusted return estimates.
   - Category-aware plausibility ceilings prevent a single optimistic method from
     creating ordinary 50%-120% annual return estimates.
   - Inputs above +/-75% are flagged as data-integrity warnings and cannot receive a
     Buy rating until price/share-count/ticker mapping is verified.

2. Actionable margin of safety
   - Positive MOS is reliability-haircut using confidence and method agreement.
   - Category-aware ceilings prevent routine 80%-100% MOS displays.
   - Raw values are retained in rawMarginOfSafety for auditability.

3. Business-first decisions
   - Quality and capital allocation are evaluated before valuation and probability.
   - Sorting uses rating, sector-adjusted decision score, business quality, then return.

4. Scarcity guard
   - Exceptional Buy is limited to the top 1-3 qualifying names.
   - Strong Buy is limited to the top 10-25 qualifying names depending on universe size.
   - Lower-ranked qualifying names are demoted one tier rather than discarded.

5. UI fix
   - “Exceptional Buy” now appears at the top of the rating dropdown.

Audit fields added
------------------
rawProbabilityWeightedCAGR
rawMarginOfSafety
decisionExpectedReturn
returnPlausibilityAdjusted
marginOfSafetyAdjusted
v27.returnProfile
v27.mosProfile
