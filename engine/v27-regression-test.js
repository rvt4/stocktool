'use strict';
const assert = require('assert');
const { classifyCategory } = require('../scoring-engine');
const { assignProbabilityRating, computeProbabilityProfile } = require('./probability-rating-engine');

function years(growths, opts={}) {
  let revenue=100;
  return growths.map((g,i)=>{
    if(i) revenue*=1+g;
    return { year:2020+i, revenue, fcf:opts.negativeFcf?-5:12, netIncome:8, roic:.16, opMargin:.14 };
  });
}
const kdp={sector:'Consumer Staples',industry:'Beverages',financials:{years:years([0,.05,.06,.07,.06])},valuation:{dividendYield:.025,industryModel:{model:'consumer-staples'}},analystEstimates:{revenueGrowthCurrentYear:.31,revenueGrowthNextYear:.18}};
assert.notStrictEqual(classifyCategory(kdp),'Hyper Growth','one-year staples spike must not become Hyper Growth');
const sofi={sector:'Financial Services',industry:'Credit Services',financials:{years:years([0,.28,.24,.22,.20],{negativeFcf:true})},valuation:{dividendYield:0,industryModel:{model:'financials'}},analystEstimates:{revenueGrowthCurrentYear:.35,revenueGrowthNextYear:.22}};
assert.notStrictEqual(classifyCategory(sofi),'Hyper Growth','financial company must not use Hyper Growth underwriting');

const fragile={category:'Growth',methodAgreementScore:20,investmentCommitteeScore:82,confidenceScore:90,marginOfSafety:.30,riskAdjustedExpectedReturn:.22,scenarioAnalysis:{downsideCAGR:.02},financials:{years:years([0,.20,.20,.20,.20])}};
const components={quality:92,growth:92,valuation:90,risk:20,confidence:90};
const probability=computeProbabilityProfile(fragile,components);
assert.strictEqual(assignProbabilityRating(fragile,components,probability).rating,'Hold','low method agreement must block Buy ratings');
console.log('V27 regression tests passed.');
