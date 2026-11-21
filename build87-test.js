'use strict';
// Build 87: frozen strategy + forward record.
const assert=require('assert');const fs=require('fs'),os=require('os'),path=require('path');
const RP=require('./review-policy');
const {recordForward}=require('./forward-record');
assert.strictEqual(RP.STRATEGY.id,'C-v2');  // Build 94 bumped C-v1 -> C-v2 under the change policyassert(RP.STRATEGY.rules&&RP.STRATEGY.changePolicy);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fwd-'));
const out=px=>({stocks:[{ticker:'AAA',currentPrice:px.a,expectedCAGR:.14,underwrittenCAGR:.12,qualityScore:90,overallRank:1,sector:'Tech'},
  {ticker:'BBB',currentPrice:px.b,expectedCAGR:.05,underwrittenCAGR:.04,qualityScore:60,overallRank:300}]});
const cand=s=>s.overallRank<=20;
// Nov 2025 snapshot: AAA on the buy list at $100, SPY $500.
recordForward(out({a:100,b:50}),{spyPrice:500,strategy:'C-v1',isCandidate:cand,dataDir:dir,now:new Date('2025-11-03')});
// Same month again: no second snapshot.
recordForward(out({a:101,b:50}),{spyPrice:505,strategy:'C-v1',isCandidate:cand,dataDir:dir,now:new Date('2025-11-20')});
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir,'forward-record.json'))).snapshots.length,1);
// 12 months later: AAA $130 (+30%), SPY $550 (+10%).
const rep=recordForward(out({a:130,b:40}),{spyPrice:550,strategy:'C-v1',isCandidate:cand,dataDir:dir,now:new Date('2026-11-05')});
const p=rep.periods.find(x=>x.months===12&&x.from==='2025-11-03');
assert(p,'12-month period scored');
assert(Math.abs(p.buyListReturn-.30)<1e-9&&Math.abs(p.spyReturn-.10)<1e-9&&Math.abs(p.excess-.20)<1e-9);
assert.strictEqual(p.shareBeatingSpy,1);assert.strictEqual(p.names,1,'only the buy list is scored');
assert.strictEqual(rep.summary12m.periodsBeatingSpy,1);
assert(fs.existsSync(path.join(dir,'forward-report.json')));
console.log('build87 tests passed');
