StockTool V19 — Business-Model-First Classification

This release fixes the root classification problem discovered in V18: sector-level
labels and short-term growth could cause secular businesses to be treated as cyclicals,
while temporary pricing/acquisition growth could make mature staples look like growth stocks.

WHAT CHANGED

1. New economic archetype engine
   - Secular Compute Platform
   - Semiconductor Cycle
   - Software Platform Growth / Software Compounder
   - Scaling Consumer Brand
   - Stable Consumer / Dividend Compounder
   - Consumer Brand Compounder / Consumer Cyclical
   - Healthcare Innovation / Healthcare Compounder
   - Industrial Compounder / Industrial Cycle
   - Financial, regulated, asset-income and commodity archetypes

2. Sector alias repair
   Recognizes common Russell/Yahoo labels including Consumer Defensive,
   Consumer Cyclical, Basic Materials, Financial Services and Technology.

3. Lifecycle now starts with the economic model
   Secular compute companies are not automatically classified as Cyclical merely
   because semiconductor results are volatile. Stable staples cannot become Growth
   solely from a short-term spike. Scaling brands can retain a genuine growth label.

4. Archetype-aware premium persistence
   Premium retention now uses the economic archetype, secular growth quality and
   scaling-brand economics in addition to the broad sector anchor.

5. Archetype-aware method weighting
   Scaling consumer brands receive more meaningful revenue/EPS exit weights and less
   owner-earnings weight while they are still reinvesting. Mature cash generators retain
   cash-flow-heavy weighting.

6. Dashboard diagnostics
   The company dashboard now displays Economic archetype below Lifecycle.

No ticker-specific overrides were added.
