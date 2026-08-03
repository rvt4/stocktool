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


const missingValuation={
 ticker:'LIMITED', category:'Unknown', probabilityWeightedCAGR:.08, expectedReturn:.08,
 baseCAGR:.08, bearCAGR:.02, bullCAGR:.14, confidenceScore:55,
 methodAgreementScore:50, marginOfSafety:.05, businessQualityScore:50,
 downsideRiskScore:50, dataIntegrity:{score:60}, financials:{years:years({rev:[100,110]})}
};
assert.doesNotThrow(() => applyDecisionSystemV30([missingValuation]),
  'Limited-history records without a valuation object must not crash the decision system');
assert.ok(missingValuation.valuation && missingValuation.valuation.componentScores,
  'The decision system should create a valuation container for limited-history records');

console.log('model regression tests passed');


const megaPlatform={sector:'Communication Services',industry:'Internet Content',financials:{years:years({rev:[20000,23000,27000,32000,38000],roic:.13,fcfMargin:.20})},analystEstimates:{revenueGrowthCurrentYear:.18,revenueGrowthNextYear:.16},valuation:{fcfYield:.035,forwardPe:22,dividendYield:0}};
assert.strictEqual(CategoryEngine.classifyCategory(megaPlatform),'Compounder','Large profitable sub-25% growth platforms should classify as Compounder');

const cheapMediocre={ticker:'CHEAP',category:'Value',probabilityWeightedCAGR:.18,expectedReturn:.18,baseCAGR:.18,bearCAGR:.10,bullCAGR:.24,confidenceScore:80,methodAgreementScore:80,marginOfSafety:.35,businessQualityScore:55,downsideRiskScore:35,valuation:{economicQuality:{overall:55}},dataIntegrity:{score:80},financials:{years:years({roic:.06,fcfMargin:.05})}};
applyDecisionSystemV30([cheapMediocre]);
assert.notStrictEqual(cheapMediocre.rating,'Strong Buy','Cheapness alone must not create a Strong Buy when business quality is mediocre');

const { selectedValuation, profileFor } = require('./primary-valuation-engine');
const digitalFinancial = {
  ticker:'DFP', name:'Digital lender', sector:'Financial Services', industry:'Credit Services',
  price:{current:16.31}, growthYear1:.28,
  analystEstimates:{revenueGrowthNextYear:.22},
  financials:{years:[
    {revenue:4.00,netIncome:.45,fcf:-1,sharesOutTTM:1.250,sbc:.20},
    {revenue:4.88,netIncome:.77,fcf:-1,sharesOutTTM:1.289,sbc:.36},
  ]},
  valuation:{
    industryModel:{model:'financials'}, dividendYield:0, forwardPe:28, evRevenue:4.3,
    moat:{score:49}, pricingPowerV2:{score:55},
    businessProfile:{premiumPersistence:.45,forecastReliability:.53},
    economicQuality:{overall:45}, compounder:{score:50},
  }
};
const financialLifecycle={stage:'Financial',forwardGrowth:.22,growthPersistenceScore:45};
const financialProfile=profileFor(digitalFinancial,'Value',financialLifecycle);
assert.ok(financialProfile.invalidMethods.includes('ebitdaExit'),
  'EV/EBITDA must be disabled for deposit-funded digital financial platforms');
const financialProjection={projection:[
  {year:2027,revenue:5.93,netMargin:.180,fcfMargin:-1,shares:1.325,eps:.81},
  {year:2028,revenue:6.86,netMargin:.179,fcfMargin:-1,shares:1.354,eps:.91},
  {year:2029,revenue:7.90,netMargin:.165,fcfMargin:-1,shares:1.376,eps:.95},
  {year:2030,revenue:8.88,netMargin:.151,fcfMargin:-1,shares:1.390,eps:.96},
  {year:2031,revenue:9.68,netMargin:.144,fcfMargin:-1,shares:1.401,eps:1.00},
]};
const financialMethods={
  epsExit:{fairValuePerShare:8.74,exitPricePerShare:16.35},
  revenueExit:{fairValuePerShare:11.10,exitPricePerShare:20.76},
  ownerEarnings:{fairValuePerShare:9.41,exitPricePerShare:15.50},
  ebitdaExit:{fairValuePerShare:1.88,exitPricePerShare:3.52},
  dcf:{fairValuePerShare:null,exitPricePerShare:null},
  dcfSBCAdjusted:{fairValuePerShare:null,exitPricePerShare:null},
};
const financialValuation=selectedValuation({
  stock:digitalFinancial, category:'Value', lifecycle:financialLifecycle,
  methodResults:financialMethods, model:financialProjection,
});
assert.ok(financialValuation.selectedMethods.every(x=>x.method!=='ebitdaExit'),
  'Invalid EV/EBITDA output must not enter the digital-financial valuation blend');
assert.ok(financialValuation.expectedCAGR > 0,
  'A profitable, credibly growing digital financial platform should not receive a negative base CAGR solely from an invalid EV/EBITDA terminal value');
