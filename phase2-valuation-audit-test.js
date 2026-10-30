'use strict';
const assert=require('assert');
const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'engine/valuation-engine.js'),'utf8');
assert(src.includes("coherentReference:pe,gordonReference:gordonPFCF"),'EPS coherent reference must be a P/E multiple, not total equity dollars');
assert(!src.includes('coherentReference:equityFromEPS,gordonReference:gordonPFCF'),'Equity dollars must never be labeled an EPS multiple');
const {thesisEntryEligible}=require('./engine/portfolio-policy');
assert(!thesisEntryEligible({rating:'Watch',modelSupport:'standard',expectedCAGR:.3,underwrittenCAGR:.25,currentPrice:100,requiredReturnBuyPrice:200}));
console.log('Phase 2 diagnostic units and investment-decision invariants passed');
