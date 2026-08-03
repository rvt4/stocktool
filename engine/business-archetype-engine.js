'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => {
  const v = (a || []).filter(Number.isFinite).sort((a,b)=>a-b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m-1] + v[m]) / 2;
};
const volatility = a => {
  const v = (a || []).filter(Number.isFinite);
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(mean(v.map(x => (x-m) ** 2)) || 0);
};

function growthRates(years) {
  const out = [];
  for (let i=1;i<years.length;i++) if (years[i-1].revenue>0 && years[i].revenue>0) out.push(years[i].revenue/years[i-1].revenue-1);
  return out;
}

function classifyBusinessArchetype(stock, metrics = {}) {
  const years = (stock.financials?.years || []).slice(-10);
  const last = years.at(-1) || {};
  const industry = stock.valuation?.industryModel?.model || 'general';
  const rates = growthRates(years);
  const forward = metrics.analystForward ?? stock.analystEstimates?.revenueGrowthCurrentYear ?? stock.growthYear1 ?? median(rates.slice(-3)) ?? 0;
  const growth5 = metrics.growth5 ?? (rates.length >= 5 ? Math.pow(years.at(-1).revenue / years.at(-6).revenue, 1/5)-1 : null);
  const grossMed = median(years.map(y=>y.grossMargin)) ?? 0;
  const opMed = median(years.map(y=>y.opMargin ?? y.operatingMargin)) ?? 0;
  const roicMed = median(years.map(y=>y.roic));
  const positiveFcf = years.length ? years.filter(y => Number(y.fcf) > 0).length / years.length : .4;
  const divYield = stock.valuation?.dividendYield || 0;
  const marketCap = stock.valuation?.marketCap || 0;
  const growthVol = volatility(rates.slice(-7));
  const pricing = clamp((stock.valuation?.pricingPowerV2?.score ?? stock.pricingPowerScore ?? 50)/100,0,1);
  const moat = clamp((stock.valuation?.moat?.score ?? 50)/100,0,1);
  const quality = clamp(((roicMed == null ? .45 : clamp((roicMed-.05)/.30,0,1)) + positiveFcf + pricing + moat)/4,0,1);

  let archetype = 'General Business';
  let secular = false;
  let cyclicalBias = 0.25;
  let premiumAnchor = 0.30;
  let durationBias = 0;

  if (industry === 'software') {
    archetype = forward >= .15 ? 'Software Platform Growth' : 'Software Compounder';
    secular = true; cyclicalBias = .08; premiumAnchor = .58; durationBias = 2;
  } else if (industry === 'semiconductors-hardware') {
    const secularCompute = forward >= .14 && quality >= .52 && (growth5 == null || growth5 >= .07) && positiveFcf >= .55;
    archetype = secularCompute ? 'Secular Compute Platform' : 'Semiconductor Cycle';
    secular = secularCompute; cyclicalBias = secularCompute ? .28 : .78; premiumAnchor = secularCompute ? .46 : .25; durationBias = secularCompute ? 2 : -1;
  } else if (['consumer-staples','consumer-discretionary'].includes(industry)) {
    const scalingBrand = forward >= .14 && grossMed >= .35 && (growth5 == null || growth5 >= .10) && quality >= .42;
    if (scalingBrand) {
      archetype = 'Scaling Consumer Brand'; secular = true; cyclicalBias = .16; premiumAnchor = .52; durationBias = 2;
    } else if (industry === 'consumer-staples') {
      archetype = divYield >= .018 ? 'Stable Dividend Compounder' : 'Stable Consumer Compounder';
      cyclicalBias = .08; premiumAnchor = .40; durationBias = 1;
    } else {
      archetype = quality >= .62 ? 'Consumer Brand Compounder' : 'Consumer Cyclical';
      cyclicalBias = quality >= .62 ? .22 : .58; premiumAnchor = quality >= .62 ? .43 : .28;
    }
  } else if (industry === 'healthcare-innovation') {
    archetype = forward >= .14 ? 'Healthcare Innovation Growth' : 'Healthcare Compounder';
    secular = true; cyclicalBias=.10; premiumAnchor=.50; durationBias=2;
  } else if (industry === 'financials') {
    const digitalPlatform = forward >= .12 && positiveFcf >= .35 &&
      (positiveFcf >= .55 || Number(last.netIncome) > 0 || opMed >= .08);
    if (digitalPlatform) {
      archetype = 'Digital Financial Platform'; secular = true;
      cyclicalBias = .32; premiumAnchor = .38; durationBias = 1;
    } else {
      archetype = 'Financial Compounder'; cyclicalBias=.40; premiumAnchor=.20;
    }
  } else if (industry === 'utilities') {
    archetype = 'Regulated Cash Compounder'; cyclicalBias=.08; premiumAnchor=.25;
  } else if (industry === 'reit') {
    archetype = 'Asset Income Compounder'; cyclicalBias=.35; premiumAnchor=.22;
  } else if (['energy','materials'].includes(industry)) {
    archetype = 'Commodity Cycle'; cyclicalBias=.90; premiumAnchor=.10; durationBias=-2;
  } else if (industry === 'industrials') {
    archetype = quality >= .68 && growthVol < .12 ? 'Industrial Compounder' : 'Industrial Cycle';
    cyclicalBias = archetype === 'Industrial Compounder' ? .30 : .70;
    premiumAnchor = archetype === 'Industrial Compounder' ? .36 : .22;
  } else if (industry === 'communications') {
    archetype = quality >= .60 ? 'Network Compounder' : 'Mature Communications';
    cyclicalBias=.22; premiumAnchor=quality>=.60?.42:.28;
  }

  return { archetype, secular, cyclicalBias, premiumAnchor, durationBias, quality, forwardGrowth: forward, growth5, grossMargin: grossMed, operatingMargin: opMed, positiveFcfRate: positiveFcf, marketCap };
}

module.exports = { classifyBusinessArchetype };
