'use strict';
const assert = require('assert');
const { assessDataIntegrity } = require('./data-integrity');
const { selectedValuation } = require('./primary-valuation-engine');

// A specialist bank must not fall back to generic DCF/EV methods merely because
// only one economically valid method survives.
const bank = {
  sector:'Financial Services', industry:'Regional Banks', price:{current:80},
  analystEstimates:{epsGrowthNextYear:.12},
  financials:{years:[
    {revenue:1000,netIncome:160,fcf:-300,cfo:200,sharesOutTTM:100,dilutedEPS:1.6},
    {revenue:1080,netIncome:175,fcf:-250,cfo:220,sharesOutTTM:100,dilutedEPS:1.75},
    {revenue:1160,netIncome:190,fcf:-200,cfo:240,sharesOutTTM:100,dilutedEPS:1.9},
  ]},
  valuation:{industryModel:{model:'financials'},businessProfile:{forecastReliability:.7},moat:{score:55},pricingPowerV2:{score:50},economicQuality:{overall:60},compounder:{score:55}}
};
const model={projection:[1,2,3,4,5].map((year,i)=>({year,revenue:1200+i*80,netMargin:.16,fcfMargin:-.2,shares:100,eps:2+i*.2}))};
const methodResults={
  dcf:{fairValuePerShare:5,exitPricePerShare:8}, dcfSBCAdjusted:{fairValuePerShare:4,exitPricePerShare:7},
  ownerEarnings:{fairValuePerShare:300,exitPricePerShare:400}, revenueExit:{fairValuePerShare:500,exitPricePerShare:700},
  epsExit:{fairValuePerShare:95,exitPricePerShare:140}, ebitdaExit:{fairValuePerShare:600,exitPricePerShare:900}
};
const pv=selectedValuation({stock:bank,category:'Value',lifecycle:{stage:'Financial',forwardGrowth:.08},methodResults,model});
assert(pv && pv.selectedMethods.length===1 && pv.selectedMethods[0].method==='epsExit','bank must stay on EPS specialist valuation');
assert.strictEqual(pv.agreementScore,35,'single-method specialist valuation must not claim high agreement');

// Data-integrity logic must flag a split-sized EPS/share denominator mismatch.
const split={price:{current:200},financials:{years:[{revenue:1000,netIncome:600,dilutedEPS:1,sharesOutTTM:30,cfo:700}]},analystEstimates:{}};
const integrity=assessDataIntegrity(split);
assert(integrity.issues.some(x=>x.code==='share_eps_mismatch'),'split-sized share/EPS mismatch must be detected');
console.log('V62 structural sanity regression test passed');
