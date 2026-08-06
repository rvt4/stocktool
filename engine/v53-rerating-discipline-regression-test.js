'use strict';
const assert = require('assert');
const { capMethodConcentration, maxCrediblePositiveRerating } = require('./primary-valuation-engine');

const capped = capMethodConcentration([
  { key: 'dcf', rawWeight: .923 },
  { key: 'dcfSBCAdjusted', rawWeight: .059 },
  { key: 'revenueExit', rawWeight: .018 },
]);
const maxWeight = Math.max(...capped.map(x => x.weight));
assert.ok(maxWeight <= .6500001, `three-method concentration should be capped at 65%, got ${maxWeight}`);
assert.ok(Math.abs(capped.reduce((s, x) => s + x.weight, 0) - 1) < 1e-9, 'capped weights must sum to one');

const carLike = maxCrediblePositiveRerating({
  operatingAnchor: .011, quality: .44, agreementScore: 35, methodConcentration: .923, profileMaxRerating: .03,
});
const nbixLike = maxCrediblePositiveRerating({
  operatingAnchor: .208, quality: .71, agreementScore: 78, methodConcentration: .348, profileMaxRerating: .045,
});
assert.ok(carLike <= .06, `weak business rerating allowance should remain near mid-single digits, got ${carLike}`);
assert.ok(nbixLike >= .10, `credible high-growth business should retain rerating room, got ${nbixLike}`);
assert.ok(nbixLike > carLike + .04, 'rerating allowance should scale with operating quality');
console.log('V53 rerating-discipline regression passed', { carLike, nbixLike, maxWeight });
