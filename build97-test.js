'use strict';
// Build 97: every valued stock gets a research rank on one scale (no 11% gate); the frozen overallRank is unchanged.
const assert=require('assert');
const {applyModelDRanking,applyResearchRank}=require('./engine/ranking-engine');
const mk=(t,ret,q,o={})=>({ticker:t,expectedAlpha:ret-.11,expectedCAGR:ret,underwrittenCAGR:ret-.01,qualityScore:q,moatScore:q,growthQualityScore:q,compounderScore:q,
  revenueGrowthTTM:.10,revenueCAGR3:.10,marketCap:5e10,analystEstimates:{numAnalysts:20},...o});
const rows=[mk('JUNK',.12,40),mk('OK',.14,70),mk('AXPL',.078,90),mk('VLIKE',.086,92),mk('LOWQ',.09,30),mk('AMDL',.056,70),
  mk('UNV',.20,80,{modelSupport:'unsupported'}),mk('NOALPHA',null,80,{expectedAlpha:null,expectedCAGR:null,underwrittenCAGR:null})];
applyModelDRanking(rows,{reliability:true});
const frozen=Object.fromEntries(rows.map(r=>[r.ticker,r.overallRank]));
applyResearchRank(rows);
const R=t=>rows.find(r=>r.ticker===t);
// Frozen rank untouched; gated rank still puts sub-11% names behind 11%+ names.
for(const r of rows)assert.strictEqual(r.overallRank,frozen[r.ticker],'overallRank unchanged for '+r.ticker);
assert(R('JUNK').overallRank<R('AXPL').overallRank);
// Every valued stock is ranked, 1..n with no gaps; unvalued / no-return names get none.
const ranked=rows.filter(r=>r.researchRank!=null).map(r=>r.researchRank).sort((a,b)=>a-b);
assert.deepStrictEqual(ranked,[1,2,3,4,5,6]);
assert.strictEqual(R('UNV').researchRank,null);assert.strictEqual(R('NOALPHA').researchRank,null);
// Quality now counts below 11%: a quality-90 stock at 7.8% beats a quality-40 stock at 12%, and a quality-30 at 9%.
assert(R('AXPL').researchRank<R('JUNK').researchRank,'quality counts below the hurdle');
assert(R('VLIKE').researchRank<R('LOWQ').researchRank);
// Return still matters: same quality, higher return ranks higher.
assert(R('OK').researchRank<R('AMDL').researchRank);
// Clones: the frozen rank fields on the rows are not overwritten by the ungated pass.
assert.strictEqual(R('AXPL').rankEligible,false);
console.log('build97-test passed');
