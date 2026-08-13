FreeScreener V66 — changed files only

Replace these files in the same locations used by your repo:
- scoring-engine.js
- valuation-methods.js
- index.html

What changed:
1. Reverse DCF market-implied growth is now treated correctly as FCF growth, not revenue growth.
2. Market-implied FCF growth no longer feeds the fundamental revenue-growth blend or directly penalizes confidence via an apples-to-oranges growth gap.
3. Reverse DCF now starts from normalized FCF (reported FCF blended with recent median FCF-margin economics) to reduce single-year cash-flow distortion.
4. Buy ratings now require the actual 15% raw expected-return hurdle plus required MOS. Risk-adjusted return, confidence, return robustness and business quality determine Strong/Exceptional tiers.
5. Rating label standardized to "Exceptional Buy".
6. Dashboard wording now explicitly labels reverse-DCF output as market-implied FCF growth and warns that it is not directly comparable to modeled revenue growth.
