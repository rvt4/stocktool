'use strict';
const assert = require('assert');
const { computeCapitalAllocationV2 } = require('./capital-allocation-v2');
const { capitalAllocationScore } = require('../valuation-methods');

function stock(years) {
  return { financials: { years }, valuation: { dividendYield: 0 } };
}

const strong = stock([
  { year: 2021, revenue: 100, operatingIncome: 25, netIncome: 20, fcf: 22, sharesOutTTM: 100, totalDebt: 25, sbc: 2 },
  { year: 2022, revenue: 115, operatingIncome: 30, netIncome: 24, fcf: 27, sharesOutTTM: 98, totalDebt: 20, sbc: 2 },
  { year: 2023, revenue: 132, operatingIncome: 37, netIncome: 29, fcf: 33, sharesOutTTM: 95, totalDebt: 14, sbc: 2 },
  { year: 2024, revenue: 151, operatingIncome: 44, netIncome: 35, fcf: 40, sharesOutTTM: 92, totalDebt: 8, sbc: 2 },
]);
const weak = stock([
  { year: 2021, revenue: 100, operatingIncome: 8, netIncome: 5, fcf: 3, sharesOutTTM: 100, totalDebt: 30, sbc: 8 },
  { year: 2022, revenue: 102, operatingIncome: 6, netIncome: 3, fcf: -1, sharesOutTTM: 106, totalDebt: 45, sbc: 10 },
  { year: 2023, revenue: 104, operatingIncome: 4, netIncome: 1, fcf: -3, sharesOutTTM: 114, totalDebt: 65, sbc: 12 },
  { year: 2024, revenue: 105, operatingIncome: 2, netIncome: -2, fcf: -5, sharesOutTTM: 124, totalDebt: 90, sbc: 14 },
]);

const directStrong = computeCapitalAllocationV2(strong).score;
const directWeak = computeCapitalAllocationV2(weak).score;
const wiredStrong = capitalAllocationScore(strong).score;
const wiredWeak = capitalAllocationScore(weak).score;

assert.strictEqual(wiredStrong, directStrong, 'valuation layer must use canonical capital-allocation score');
assert.strictEqual(wiredWeak, directWeak, 'valuation layer must use canonical capital-allocation score');
assert.ok(wiredStrong - wiredWeak >= 20, `expected meaningful spread, got ${wiredStrong} vs ${wiredWeak}`);
assert.notStrictEqual(wiredStrong, 55, 'strong allocator must not hit old constant fallback');
assert.notStrictEqual(wiredWeak, 55, 'weak allocator must not hit old constant fallback');
console.log(`capital allocation wiring passed: strong=${wiredStrong}, weak=${wiredWeak}`);
