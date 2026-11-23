'use strict';
// Build 96: stock-pay fade experiment (backtest only). Live output must be unchanged.
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
const {computeQuality}=require('./engine/quality-engine');
const {valuate}=require('./engine/valuation-engine');

function mk({sbc=.21,op=.06,g=.25,fcf=.25}){const years=[];let revenue=3e9;const shares=250e6;
  for(let i=0;i<5;i++){revenue*=1+g;years.push({year:2021+i,revenue,fcf:revenue*fcf,ebitda:revenue*(op+.05),netIncome:revenue*(op-.01),operatingIncome:revenue*op,sharesOutTTM:shares,dilutedEPS:revenue*(op-.01)/shares,roic:.1,opMargin:op,totalDebt:1e9,cash:3e9,dividendPerShare:0,sbcIntensity:sbc,sbc:sbc*revenue,grossProfit:revenue*.75,researchAndDevelopment:revenue*.25,sellingGeneralAdministrative:revenue*.44,incomeTaxExpense:revenue*op*.2,pretaxIncome:revenue*op});}
  return {ticker:'X96',sector:'Technology',financials:{years,dataQuality:{}},growthYear1:g,price:{current:100},valuation:{dividendYield:0,growthSource:'test'}};}
const run=(c,opts)=>{const s=mk(c),f=buildForecast(s,opts),q=computeQuality(s,f);return {f,v:valuate(s,f,q)};};

// 1) Live path untouched: no option == option false.
{const a=run({},{}),b=run({},{sbcFade:false});assert.strictEqual(a.v.fairValueEstimate,b.v.fairValueEstimate);
 assert.strictEqual(a.f.forecastBridge.margins.sbcFadeApplied??null,null,'live path must not fade');}
// 2) High-SBC software: SBC falls toward 8% by year 10, GAAP margin rises by the same amount, value rises.
{const a=run({sbc:.21,op:.06},{}),b=run({sbc:.21,op:.06},{sbcFade:true});
 const y10a=a.f.rows[9],y10b=b.f.rows[9];
 assert(y10b.sbcMargin<.10&&y10b.sbcMargin<y10a.sbcMargin,'year-10 SBC should fade toward 8%: '+y10b.sbcMargin);
 assert(y10b.operatingMargin>y10a.operatingMargin,'GAAP operating margin should rise');
 const preA=y10a.operatingMargin+y10a.sbcMargin,preB=y10b.operatingMargin+y10b.sbcMargin;
 assert(Math.abs(preA-preB)<.02,'pre-SBC operating margin should be about unchanged: '+preA+' vs '+preB);
 assert(b.v.fairValueEstimate>a.v.fairValueEstimate,'value should rise');}
// 3) Low-SBC company (6%): nothing changes.
{const a=run({sbc:.06,op:.30},{}),b=run({sbc:.06,op:.30},{sbcFade:true});
 assert.strictEqual(a.v.fairValueEstimate,b.v.fairValueEstimate);}
// 4) The fade never raises SBC above the default path.
{const a=run({sbc:.09,op:.20,g:.30},{}),b=run({sbc:.09,op:.20,g:.30},{sbcFade:true});
 for(let i=0;i<10;i++)assert(b.f.rows[i].sbcMargin<=a.f.rows[i].sbcMargin+1e-9,'year '+(i+1)+' SBC raised');}
console.log('build96 tests passed');
