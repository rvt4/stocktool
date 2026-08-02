'use strict';
const assert = require('assert');
const CategoryEngine = require('./category-engine');
const { assignSelectiveRatings } = require('./rating-engine');
const { computeInvestmentCommitteeScore } = require('./investment-committee-engine');
const { applyDecisionSystemV30 } = require('./decision-system-v30');

function years({rev=[100,110,121,133,146], roic=.16, fcfMargin=.12, shares=100}){
 return rev.map((r,i)=>({revenue:r,fcf:r*fcfMargin,netIncome:r*.10,roic,opMargin:.16,grossMargin:.45,sharesOutTTM:shares*(1+i*.002)}));
}
const sofi={sector:'Financial Services',industry:'Credit Services',financials:{years:years({rev:[100,130,170,220,280],roic:.07,fcfMargin:.03})},analystEstimates:{revenueGrowthCurrentYear:.35,revenueGrowthNextYear:.22},valuation:{fcfYield:.02,forwardPe:28,dividendYield:0}};
assert.notStrictEqual(CategoryEngine.classifyCategory(sofi),'Hyper Growth','Financials must not classify as Hyper Growth');
const kdp={sector:'Consumer Staples',industry:'Beverages',financials:{years:years({rev:[100,104,108,112,117],roic:.12,fcfMargin:.14})},analystEstimates:{revenueGrowthCurrentYear:.28,revenueGrowthNextYear:.12},valuation:{fcfYield:.055,forwardPe:15,dividendYield:.03}};
assert.strictEqual(CategoryEngine.classifyCategory(kdp),'Dividend','Covered staples dividends should classify as Dividend rather than Value/Hyper Growth');
const fragile={ticker:'X',qualifiesForBuyList:true,expectedReturn:.22,portfolioManagerScore:90,businessQualityScore:70,compounderScore:65,confidenceScore:70,downsideProtectionScore:45,methodAgreementScore:6,successProbability:55,returnQualityScore:58,dataIntegrity:{isUsable:true,score:70},marginOfSafety:.30};
assignSelectiveRatings([fragile]);
assert.notStrictEqual(fragile.rating,'Strong Buy','Low valuation agreement must block Strong Buy');

const committeeStock={
 ticker:'TEST', category:'Growth', price:{current:100}, financials:{years:years({})}, dataIntegrity:{score:80},
 valuation:{
  intrinsicValue:130, methodAgreementScore:72, economicQuality:{overall:84}, compounder:{score:82},
  moat:{score:78}, pricingPowerV2:{score:76}, capitalAllocation:{score:80},
  businessProfile:{balanceSheetScore:78}, lifecycle:{confidence:.82,growthPersistenceScore:80},
  returnEngineV2:{expectedCAGR:.16}
 }
};
const committee=computeInvestmentCommitteeScore(committeeStock,{expectedCAGR:.16,downsideCAGR:.04,probabilities:{confidence:.82}},{score:80},{score:75},{score:78});
assert.strictEqual(Object.keys(committee.members).length,5,'Investment committee must retain five distinct votes');
assert.ok(committee.yesVotes>=3,'A balanced high-quality case should receive multiple affirmative votes');

const fatalCommittee={...committee,yesVotes:4,fatalNo:true,unanimous:false,members:{...committee.members,valuation:{score:40,vote:'no'}}};
const candidate={ticker:'Y',category:'Growth',rating:'Strong Buy',probabilityWeightedCAGR:.18,expectedReturn:.18,baseCAGR:.18,bearCAGR:.10,bullCAGR:.25,confidenceScore:85,methodAgreementScore:70,marginOfSafety:.25,businessQualityScore:85,downsideRiskScore:30,valuation:{investmentCommittee:fatalCommittee,economicQuality:{overall:85}},dataIntegrity:{score:85},financials:{years:years({})}};
applyDecisionSystemV30([candidate]);
assert.notStrictEqual(candidate.rating,'Strong Buy','A fatal committee no vote must block Strong Buy');
console.log('model regression tests passed');


const megaPlatform={sector:'Communication Services',industry:'Internet Content',financials:{years:years({rev:[20000,23000,27000,32000,38000],roic:.13,fcfMargin:.20})},analystEstimates:{revenueGrowthCurrentYear:.18,revenueGrowthNextYear:.16},valuation:{fcfYield:.035,forwardPe:22,dividendYield:0}};
assert.strictEqual(CategoryEngine.classifyCategory(megaPlatform),'Compounder','Large profitable sub-25% growth platforms should classify as Compounder');

const cheapMediocre={ticker:'CHEAP',category:'Value',probabilityWeightedCAGR:.18,expectedReturn:.18,baseCAGR:.18,bearCAGR:.10,bullCAGR:.24,confidenceScore:80,methodAgreementScore:80,marginOfSafety:.35,businessQualityScore:55,downsideRiskScore:35,valuation:{economicQuality:{overall:55}},dataIntegrity:{score:80},financials:{years:years({roic:.06,fcfMargin:.05})}};
applyDecisionSystemV30([cheapMediocre]);
assert.notStrictEqual(cheapMediocre.rating,'Strong Buy','Cheapness alone must not create a Strong Buy when business quality is mediocre');
