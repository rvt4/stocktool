'use strict';
const assert = require('assert');
const CategoryEngine = require('./category-engine');
const { assignSelectiveRatings } = require('./rating-engine');

function years({rev=[100,110,121,133,146], roic=.16, fcfMargin=.12, shares=100}){
 return rev.map((r,i)=>({revenue:r,fcf:r*fcfMargin,netIncome:r*.10,roic,opMargin:.16,grossMargin:.45,sharesOutTTM:shares*(1+i*.002)}));
}
const sofi={sector:'Financial Services',industry:'Credit Services',financials:{years:years({rev:[100,130,170,220,280],roic:.07,fcfMargin:.03})},analystEstimates:{revenueGrowthCurrentYear:.35,revenueGrowthNextYear:.22},valuation:{fcfYield:.02,forwardPe:28,dividendYield:0}};
assert.notStrictEqual(CategoryEngine.classifyCategory(sofi),'Hyper Growth','Financials must not classify as Hyper Growth');
const kdp={sector:'Consumer Staples',industry:'Beverages',financials:{years:years({rev:[100,104,108,112,117],roic:.12,fcfMargin:.14})},analystEstimates:{revenueGrowthCurrentYear:.28,revenueGrowthNextYear:.12},valuation:{fcfYield:.055,forwardPe:15,dividendYield:.03}};
assert.notStrictEqual(CategoryEngine.classifyCategory(kdp),'Hyper Growth','Staples estimate spikes must not classify as Hyper Growth');
const fragile={ticker:'X',qualifiesForBuyList:true,expectedReturn:.22,portfolioManagerScore:90,businessQualityScore:70,compounderScore:65,confidenceScore:70,downsideProtectionScore:45,methodAgreementScore:6,successProbability:55,returnQualityScore:58,dataIntegrity:{isUsable:true,score:70},marginOfSafety:.30};
assignSelectiveRatings([fragile]);
assert.notStrictEqual(fragile.rating,'Strong Buy','Low valuation agreement must block Strong Buy');
console.log('v28 regression tests passed');
