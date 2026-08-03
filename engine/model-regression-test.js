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


// V36 calibration regressions: premium persistence, agreement shrinkage, and
// high-growth economic fade must remain active across future revisions.
const { computePremiumPersistence } = require('./premium-persistence-engine');
const { generateBusinessForecast } = require('./business-forecast-engine');
const { agreementInfluence } = require('./primary-valuation-engine');

const elitePersistenceStock={
  financials:{years:[
    {revenue:100,fcf:24,netIncome:20,roic:.30,grossMargin:.78,opMargin:.30,ebitda:32,cash:20,longTermDebt:0},
    {revenue:115,fcf:28,netIncome:23,roic:.31,grossMargin:.79,opMargin:.31,ebitda:37,cash:25,longTermDebt:0},
    {revenue:132,fcf:33,netIncome:27,roic:.32,grossMargin:.79,opMargin:.32,ebitda:43,cash:30,longTermDebt:0},
    {revenue:151,fcf:38,netIncome:31,roic:.31,grossMargin:.80,opMargin:.32,ebitda:49,cash:36,longTermDebt:0},
  ]},
  valuation:{industryModel:{model:'software'},pricingPowerV2:{score:90},capitalAllocation:{score:88},dilutionRate:0}
};
const weakPersistenceStock={
  financials:{years:[
    {revenue:100,fcf:2,netIncome:1,roic:.04,grossMargin:.25,opMargin:.02,ebitda:5,cash:2,longTermDebt:30},
    {revenue:125,fcf:-3,netIncome:-2,roic:.02,grossMargin:.18,opMargin:-.03,ebitda:2,cash:2,longTermDebt:35},
    {revenue:105,fcf:1,netIncome:0,roic:.03,grossMargin:.28,opMargin:.01,ebitda:4,cash:2,longTermDebt:38},
    {revenue:140,fcf:-2,netIncome:-1,roic:.01,grossMargin:.20,opMargin:-.02,ebitda:3,cash:2,longTermDebt:42},
  ]},
  valuation:{industryModel:{model:'industrials'},pricingPowerV2:{score:25},capitalAllocation:{score:30},dilutionRate:.08}
};
const elitePersistence=computePremiumPersistence(elitePersistenceStock,{recurringRevenue:.9,forecastReliability:.9,capitalIntensity:.1,cyclicality:.1},{stage:'Elite Compounder',growthPersistenceScore:90},{score:90});
const weakPersistence=computePremiumPersistence(weakPersistenceStock,{recurringRevenue:.2,forecastReliability:.35,capitalIntensity:.8,cyclicality:.8},{stage:'Cyclical',growthPersistenceScore:25},{score:25});
assert.ok(elitePersistence.retainedPremium > weakPersistence.retainedPremium + .25,
  'Elite durable businesses must retain materially more terminal premium than weak cyclicals');
assert.strictEqual(agreementInfluence(0),.15,'Zero agreement should sharply reduce valuation influence');
assert.strictEqual(agreementInfluence(95),1,'High agreement should preserve valuation influence');

const hyperGrowthFadeStock={
  sector:'Technology',industry:'Software',
  financials:{years:[
    {year:2021,revenue:100,fcf:8,netIncome:6,roic:.14,grossMargin:.70,opMargin:.10,sharesOutTTM:100},
    {year:2022,revenue:135,fcf:12,netIncome:9,roic:.16,grossMargin:.71,opMargin:.12,sharesOutTTM:101},
    {year:2023,revenue:182,fcf:19,netIncome:14,roic:.18,grossMargin:.72,opMargin:.14,sharesOutTTM:102},
    {year:2024,revenue:246,fcf:29,netIncome:21,roic:.20,grossMargin:.73,opMargin:.16,sharesOutTTM:103},
    {year:2025,revenue:332,fcf:43,netIncome:31,roic:.22,grossMargin:.74,opMargin:.18,sharesOutTTM:104},
  ]},
  analystEstimates:{revenueGrowthCurrentYear:.34,revenueGrowthNextYear:.30,numAnalysts:12},
  valuation:{marketCap:25000,industryModel:{model:'software'},pricingPowerV2:{score:75}}
};
const fadeForecast=generateBusinessForecast(hyperGrowthFadeStock,{stage:'Hyper Growth'},7,null);
assert.ok(fadeForecast.path.at(-1) < fadeForecast.path[1] - .08,
  'Exceptional analyst growth must fade materially by the terminal forecast years');
assert.ok(fadeForecast.assumptions.fadeBurden > 0,
  'High-growth forecasts must expose a positive economic fade burden in the audit');
