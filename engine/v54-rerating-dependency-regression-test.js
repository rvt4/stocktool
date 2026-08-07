'use strict';
const assert = require('assert');
const { capReratingDependentCAGR } = require('./primary-valuation-engine');

const carLike = capReratingDependentCAGR({
  expectedCAGR: .35,
  operatingAnchor: .011,
  agreementScore: 35,
  quality: .44,
  methodConcentration: .65,
});
assert.ok(carLike <= .09, `CAR-like 1.1% operating compounder must not retain 35% CAGR; got ${carLike}`);
assert.ok(carLike >= .03, `CAR-like case should retain some probabilistic rerating upside; got ${carLike}`);

const matureValue = capReratingDependentCAGR({
  expectedCAGR: .24,
  operatingAnchor: .055,
  agreementScore: 55,
  quality: .60,
  methodConcentration: .55,
});
assert.ok(matureValue <= .14, `mature low-growth rerating case should stay below 14%; got ${matureValue}`);

const nbixLike = capReratingDependentCAGR({
  expectedCAGR: .246,
  operatingAnchor: .208,
  agreementScore: 78,
  quality: .71,
  methodConcentration: .35,
});
assert.ok(Math.abs(nbixLike - .246) < 1e-12, `credible operating growth should be preserved; got ${nbixLike}`);

console.log('V54 rerating-dependency regression passed', { carLike, matureValue, nbixLike });
