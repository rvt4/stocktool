'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function n(x, fallback = null) { const v = Number(x); return Number.isFinite(v) ? v : fallback; }

const MODELS = {
  software: {
    match: /software|internet|cloud|saas|application|cyber/i,
    weights: { quality: .30, growth: .25, valuation: .22, risk: .13, confidence: .10 },
    gates: { exceptionalQuality: 84, strongQuality: 76, exceptionalCagr: .20, strongCagr: .15, maxRisk: 42 },
    notes: ['Emphasizes durable growth, FCF conversion, retention proxies and dilution discipline.'],
  },
  semiconductors: {
    match: /semiconductor|chip|microprocessor|gpu|electronic equipment/i,
    weights: { quality: .31, growth: .23, valuation: .23, risk: .14, confidence: .09 },
    gates: { exceptionalQuality: 83, strongQuality: 75, exceptionalCagr: .20, strongCagr: .15, maxRisk: 48 },
    notes: ['Normalizes cyclicality and requires stronger downside protection at peak margins.'],
  },
  financials: {
    match: /bank|insurance|financial|capital markets|asset management|credit/i,
    weights: { quality: .29, growth: .13, valuation: .28, risk: .20, confidence: .10 },
    gates: { exceptionalQuality: 80, strongQuality: 72, exceptionalCagr: .18, strongCagr: .14, maxRisk: 38 },
    notes: ['Places more weight on valuation, balance-sheet resilience and cycle risk.'],
  },
  consumer: {
    match: /retail|consumer|apparel|restaurant|beverage|food|household|leisure/i,
    weights: { quality: .29, growth: .18, valuation: .25, risk: .18, confidence: .10 },
    gates: { exceptionalQuality: 82, strongQuality: 74, exceptionalCagr: .18, strongCagr: .14, maxRisk: 42 },
    notes: ['Rewards pricing power, inventory discipline and margin resilience.'],
  },
  healthcare: {
    match: /health|pharma|biotech|medical|life science/i,
    weights: { quality: .28, growth: .20, valuation: .22, risk: .20, confidence: .10 },
    gates: { exceptionalQuality: 82, strongQuality: 74, exceptionalCagr: .19, strongCagr: .145, maxRisk: 45 },
    notes: ['Applies a larger risk weight for concentration, patent and regulatory uncertainty.'],
  },
  industrials: {
    match: /industrial|machinery|aerospace|transport|construction|electrical/i,
    weights: { quality: .30, growth: .16, valuation: .25, risk: .19, confidence: .10 },
    gates: { exceptionalQuality: 81, strongQuality: 73, exceptionalCagr: .18, strongCagr: .14, maxRisk: 42 },
    notes: ['Normalizes cycle-sensitive margins and rewards incremental returns on capital.'],
  },
  energyMaterials: {
    match: /energy|oil|gas|mining|material|chemical|steel|commodity/i,
    weights: { quality: .24, growth: .10, valuation: .28, risk: .28, confidence: .10 },
    gates: { exceptionalQuality: 78, strongQuality: 70, exceptionalCagr: .19, strongCagr: .145, maxRisk: 34 },
    notes: ['Requires conservative normalized cash flow and a wide margin of safety.'],
  },
  utilitiesReits: {
    match: /utility|utilities|reit|real estate/i,
    weights: { quality: .27, growth: .10, valuation: .28, risk: .25, confidence: .10 },
    gates: { exceptionalQuality: 78, strongQuality: 70, exceptionalCagr: .16, strongCagr: .12, maxRisk: 34 },
    notes: ['Prioritizes leverage, cash-flow coverage and rate sensitivity.'],
  },
  general: {
    match: /.*/,
    weights: { quality: .30, growth: .18, valuation: .24, risk: .18, confidence: .10 },
    gates: { exceptionalQuality: 82, strongQuality: 74, exceptionalCagr: .19, strongCagr: .145, maxRisk: 42 },
    notes: ['Balanced cross-sector model.'],
  },
};

function resolveSectorModel(stock) {
  const text = [stock.sector, stock.industry, stock.valuation?.industryModel?.model, stock.valuation?.industryModel?.key].filter(Boolean).join(' ');
  // V56: managed-care and healthcare-insurance companies must resolve to the
  // healthcare model even though their descriptions contain the word insurance.
  if (/managed care|health insurance|health plan|healthcare|health care|medical/i.test(text)) {
    return { key: 'healthcare', ...MODELS.healthcare };
  }
  for (const [key, model] of Object.entries(MODELS)) {
    if (key !== 'general' && model.match.test(text)) return { key, ...model };
  }
  return { key: 'general', ...MODELS.general };
}

function sectorAdjustedComposite(stock, components) {
  const model = resolveSectorModel(stock);
  const w = model.weights;
  const score =
    components.quality * w.quality +
    components.growth * w.growth +
    components.valuation * w.valuation +
    (100 - components.risk) * w.risk +
    components.confidence * w.confidence;
  return { score: Math.round(clamp(score, 0, 100)), model };
}

module.exports = { MODELS, resolveSectorModel, sectorAdjustedComposite };
