'use strict';
// Build 58: exit-multiple persistence (removes the hidden value bet in the model's own fair value).
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');
const {EXIT_MULTIPLE_PERSISTENCE:P,DCF_EXIT_TV_WEIGHT}=require('./engine/config');

// Same fixture builder as model-smoke-test.js
const src=require('fs').readFileSync(require('path').join(__dirname,'model-smoke-test.js'),'utf8').split('\n');
const start=src.findIndex(l=>l.startsWith('function stock('));
let end=start;while(!src[end].startsWith('}'))end++;
const stock=eval('('+src.slice(start,end+1).join('\n')+')');

const val=s=>{const f=buildForecast(s),q=computeQuality(s,f);return valuate(s,f,q);};
const method=(v,name)=>v.methods.find(m=>m.name===name);

// 1) Same business at a normal and at a very high quote. The expensive copy keeps part of its
// premium (exit multiple rises) but fair value rises far less than the price.
const base={growth:.14,margin:.20,roic:.22};
const normal=val(stock({ticker:'NORMAL',price:300,...base}));
const pricey=val(stock({ticker:'PRICEY',price:900,...base}));
const nEps=method(normal,'EPS exit'), pEps=method(pricey,'EPS exit');
assert(nEps&&pEps,'EPS exit missing');
assert(pEps.audit.anchorMultiple>57,'fixture should trade above the old 57x pin: '+pEps.audit.anchorMultiple);
assert(pEps.audit.exitMultiple>nEps.audit.exitMultiple+2,'expensive quote kept none of its premium (old 57x pin behaviour)');
assert(pEps.audit.exitMultiple<=49+1e-9,'EPS exit multiple above the 49x cap');
const move=pricey.fairValueEstimate/normal.fairValueEstimate;
assert(move>1&&move<=Math.pow(3,P)+.03,'3x quote moved fair value out of bounds: '+move);
assert(pricey.fairValueEstimate/900<normal.fairValueEstimate/300*.75,'3x quote did not look much more expensive');

// 2) Implausibly low multiples (one-off gains, bad denominators) get no anchor.
const artifact=val(stock({ticker:'ARTIFACT',price:100,growth:.16,margin:.30,roic:.32,dilution:-.01}));
for(const name of ['EPS exit','FCF exit']){
  const m=method(artifact,name);
  if(m&&m.audit.currentMultiple<4.5)assert.strictEqual(m.audit.anchorMultiple,null,name+' anchored to an artifact multiple');
}

// 3) DCF terminal value is split between Gordon and the anchored FCF exit when FCF exit exists.
const dcf=method(normal,'10Y DCF'), fcf=method(normal,'FCF exit');
if(dcf&&fcf){
  assert.strictEqual(dcf.audit.terminalExitWeight,DCF_EXIT_TV_WEIGHT,'DCF terminal exit weight not applied');
  assert(Math.abs(dcf.audit.terminalExitMultiple-fcf.audit.exitMultiple)<1e-9,'DCF terminal exit multiple differs from FCF exit');
}

// 4) Ordering: a higher quote never raises expected CAGR.
assert(pricey.expectedCAGR<normal.expectedCAGR,'higher quote raised expected CAGR');

console.log('Build 58 exit-persistence tests passed',JSON.stringify({normalExit:+nEps.audit.exitMultiple.toFixed(1),priceyExit:+pEps.audit.exitMultiple.toFixed(1),fvMove:+move.toFixed(2)}));
