'use strict';
// Build 75: 5-year PEG from the model's EPS path, both-checks-agree sell rule, quality-drop rule.
const assert=require('assert');
const RP=require('./review-policy');
const L=require('./owner-strategy-lab');
const {adjustedReturnBetween,portfolioStats}=require('./backtest');
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;

// 1) 5-year PEG: analyst next-year P/E ÷ the model's 5-year revenue-per-share growth.
const m={ticker:'M',price:100,qualityScore:85,revenueGrowthTTM:.20,revenueCAGR3:.20,modelEPS1:4,modelRevPS0:10,modelRevPS5:10*Math.pow(1.2,5),
  analystEstimates:{epsNextYear:5,epsGrowthNextYear:-.2,revenueGrowthNextYear:.15}};
const p=RP.pegOf(m);
assert.strictEqual(p.source,'model5y');assert(near(p.growth,.20)&&near(p.pe,20)&&near(p.peg,1.0));
// A one-year earnings dip (negative next-year analyst growth) no longer erases the PEG.
assert(p.peg!==null);
// Without a model path (financials): analysts' next year, then trailing.
const fin={ticker:'F',price:50,qualityScore:80,revenueGrowthTTM:.15,revenueCAGR3:.15,analystEstimates:{epsNextYear:5,epsGrowthNextYear:.12,revenueGrowthNextYear:.12}};
assert.strictEqual(RP.pegOf(fin).source,'analyst1y');assert(near(RP.pegOf(fin).peg,10/12));
assert.strictEqual(RP.pegOf({ticker:'T',price:50,revenueGrowthTTM:.15,revenueCAGR3:.15,peTTM:18,epsCAGR3:.2}).source,'trailing');
// No analyst EPS (backtest): the model's next-year EPS sets the P/E. Growth capped at 50%.
assert(near(RP.pegOf({...m,analystEstimates:{}}).pe,25));
assert(near(RP.pegOf({...m,modelRevPS5:10*Math.pow(1.8,5)}).growth,.5));
// Analyst fallback is still capped at 1.5x revenue growth.
assert(near(RP.pegOf({...fin,revenueGrowthTTM:.06,revenueCAGR3:.06,analystEstimates:{epsNextYear:5,epsGrowthNextYear:.4,revenueGrowthNextYear:.06}}).growth,.09));
// Bands: buy <= 1.5, watch <= 2.0, pricey > 2.5.
assert.deepStrictEqual([RP.PEG.buyMax,RP.PEG.watchMax,RP.PEG.sellAbove],[1.5,2.0,2.5]);
assert(RP.pegEntry(m)&&RP.pegEntry({...m,price:145})&&!RP.pegEntry({...m,price:160}));

// 2) Both-checks-agree sell rule.
const ex={...m,underwrittenCAGR:.04};                       // low return, PEG 1.0 -> disagree -> not expensive
const both=x=>RP.valuationCheck(x,{sellRule:'both'});
assert(!both(ex).expensive&&both(ex).disagree);
assert(both({...ex,price:300}).expensive,'low return AND PEG 3.0 -> expensive');
assert(both({...ex,modelRevPS0:null,modelRevPS5:null,modelEPS1:null,analystEstimates:{}}).expensive,'no PEG -> return alone decides');
assert(!both({...m,underwrittenCAGR:.09,price:300}).expensive,'fine return -> not expensive whatever the PEG');
const H=(s,prev,rule)=>RP.holdingStatus(s,prev,{sellRule:rule}).status;
assert.strictEqual(H({...ex,price:300},{u:.04,peg:3},'both'),'Sell candidate');
assert.strictEqual(H({...ex,price:300},{u:.04,peg:1.0},'both'),'Review','previous reading disagreed -> first strike only');
assert.strictEqual(H({...ex,price:300},null,'bothStaged'),'Trim half');
assert.strictEqual(H(ex,{u:.04,peg:1},'current'),'Sell candidate','current rule unchanged');

// 3) Quality sell = quality that fell after buying.
assert(RP.qualityBroke(65,{entryQ:80})&&RP.qualityBroke(55,{entryQ:68})&&!RP.qualityBroke(65,{entryQ:66})&&!RP.qualityBroke(65,null)&&!RP.qualityBroke(72,{entryQ:90}));
const low={...m,qualityScore:51,underwrittenCAGR:.06};
const adv=RP.holdingAdvice(low,null,{weight:.03});
assert.strictEqual(adv.action,'Hold');assert(/don’t add/.test(adv.headline));
assert.strictEqual(RP.holdingAdvice(low,{entryQ:80},{weight:.03}).action,'Sell');
// Snapshots remember quality when first held and carry it forward.
const snap1=RP.buildSnapshot({stocks:[{...m,qualityScore:82}],holdings:[{ticker:'M',shares:1}]});
assert.strictEqual(snap1.holdings[0].entryQ,82);
const snap2=RP.buildSnapshot({stocks:[{...m,qualityScore:66}],holdings:[{ticker:'M',shares:1}],prev:snap1});
assert.strictEqual(snap2.holdings[0].entryQ,82);assert.strictEqual(snap2.holdings[0].status,'Sell candidate');

// 4) Advice text: disagreement is explained, PEG labelled 5-yr.
const a2=RP.holdingAdvice(ex,{u:.04,peg:1},{weight:.12,sellRule:'both'});
assert.strictEqual(a2.action,'Hold');assert(a2.reasons.some(r=>/disagree/.test(r)));assert(a2.reasons.some(r=>/^5-yr PEG 1\.00/.test(r)));
const a3=RP.holdingAdvice({...ex,price:300},null,{weight:.05,sellRule:'bothStaged'});
assert.strictEqual(a3.action,'Sell some');assert(/half/i.test(a3.headline));
assert.strictEqual(RP.SELL.rule,'current','live sell rule waits for the backtest');

// 5) Backtest: entry quality is remembered; a quality drop after buying sells; both-rule holds through disagreement.
const days=[];for(let d=new Date('2016-01-01');d<=new Date('2018-03-15');d.setUTCDate(d.getUTCDate()+1))days.push(d.toISOString().slice(0,10));
const flat=days.map(date=>({date,close:100,adjustedClose:100}));
const dates=['2016-03-31','2016-06-30','2016-09-30','2016-12-31','2017-03-31'];
const row=(o)=>({ticker:'W',sector:'Tech',price:100,rating:'Buy',qualityScore:85,underwrittenCAGR:.20,expectedCAGR:.20,marketCap:1e10,revenueGrowthTTM:.2,revenueCAGR3:.2,modelEPS1:5,modelRevPS0:10,modelRevPS5:10*Math.pow(1.2,5),...o});
const sim=(rows,rule)=>L.simulateOwnerStrategy(dates.map((asOf,i)=>({asOf,rows:[rows(i)]})),new Map([['W',flat]]),flat,{name:'t',entry:'peg',sizing:'equal',maxPositions:1,maxRank:Infinity,transactionCostBps:0,trim:false,sellRule:rule},{adjustedReturnBetween,portfolioStats});
const qd=sim(i=>row(i>=2?{qualityScore:65}:{}),'both');assert.strictEqual(qd.sells,1);assert.deepStrictEqual(qd.sellReasons,{quality_below_sell_floor:1});
const dis=sim(i=>row(i>=1?{underwrittenCAGR:.03,expectedCAGR:.03}:{}),'both');assert.strictEqual(dis.sells,0,'cheap on PEG -> both-rule holds');
const cur=sim(i=>row(i>=1?{underwrittenCAGR:.03,expectedCAGR:.03,price:500}:{}),'current');assert.strictEqual(cur.sells,1,'current rule sells on return alone');

// 6) Margin credit: analysts' 2-yr EPS growth beyond revenue growth + buybacks, counted for 2 of 5 years.
const mc={ticker:'C',price:100,qualityScore:85,revenueGrowthTTM:.10,revenueCAGR3:.10,modelRev0:100,modelRev5:100*Math.pow(1.10,5),modelRevPS0:10,modelRevPS5:10*Math.pow(1.12,5),
  analystEstimates:{epsNextYear:5,epsGrowthCurrentYear:.22,epsGrowthNextYear:.22,revenueGrowthCurrentYear:.10,revenueGrowthNextYear:.10}};
const pc=RP.pegOf(mc);
// e2 22%, r2 10%, buybacks ~1.8% -> (0.22-0.10-0.018)*2/5 ~ 4.07 pts
assert(pc.marginCredit>0.038&&pc.marginCredit<0.043,'credit '+pc.marginCredit);assert(near(pc.growth,.12+pc.marginCredit,1e-9));
assert.strictEqual(RP.pegOf({...mc,analystEstimates:{...mc.analystEstimates,epsGrowthNextYear:-.1}}).marginCredit,0,'sign flip = one-off, ignored');
assert.strictEqual(RP.pegOf({...mc,analystEstimates:{...mc.analystEstimates,epsGrowthCurrentYear:.9}}).marginCredit,0,'spike far above revenue growth = one-off, ignored');
assert.strictEqual(RP.pegOf({...mc,analystEstimates:{...mc.analystEstimates,epsGrowthCurrentYear:.5,epsGrowthNextYear:.3,revenueGrowthCurrentYear:.25,revenueGrowthNextYear:.2}}).marginCredit<=RP.PEG.marginCreditCap,true);
assert.strictEqual(RP.pegOf({...mc,analystEstimates:{...mc.analystEstimates,epsGrowthCurrentYear:.05,epsGrowthNextYear:.05}}).marginCredit,0,'no negative credit');
assert(RP.holdingAdvice(mc,null,{weight:.12}).reasons.some(r=>/margin gains analysts expect/.test(r)));

// 7) Build 75b: steady margin climbers fade less; one-year spikes and flat margins are untouched.
{
  const {buildForecast}=require('./engine/forecast-engine');
  const {marginTrendTest}=require('./forecast-scorecard');
  const co=(nets,sector='Technology')=>{const years=[];let R=2e9;for(let i=0;i<6;i++){const n=nets[i];
    years.push({year:2020+i,revenue:R,grossProfit:R*.55,operatingIncome:R*(n+.04),opMargin:n+.04,netIncome:R*n,ebitda:R*(n+.08),fcf:R*(n+.03),
      operatingCashFlow:R*(n+.07),capex:R*.04,sbc:R*.02,sbcIntensity:.02,sharesOutTTM:1e8,roic:.2,totalDebt:3e8,cash:4e8});if(i<5)R*=1.12;}
    return {ticker:'X',sector,price:{current:R*nets[5]/1e8*30},financials:{years,dataQuality:{}},valuation:{},analystEstimates:null};};
  const climb=co([.02,.03,.05,.07,.09,.11],'Consumer Discretionary');
  const on=buildForecast(climb),off=buildForecast(climb,{marginTrend:false});
  assert(on.forecastFlags.includes('steady_margin_climb_applied')&&off.forecastFlags.includes('steady_margin_climb')&&!off.forecastFlags.includes('steady_margin_climb_applied'));
  assert(on.rows[4].netMargin>off.rows[4].netMargin+0.005,'climber keeps more of its margin by year 5');
  assert(on.rows[4].netMargin<on.rows[0].netMargin+0.005,'but the rule holds margins, it does not extrapolate the climb');
  for(const nets of [[.10,.10,.10,.10,.10,.10],[.05,.05,.05,.04,.12,.13],[.12,.11,.10,.09,.08,.07]]){
    const f=buildForecast(co(nets));assert(!f.forecastFlags.includes('steady_margin_climb'),'not a steady climb: '+nets);}
  // Scorecard comparison block.
  const rows=[{k:3,net:{model:.01},fcf:{model:.00},alt:{net:.03,fcf:.02}},{k:3,net:{model:-.02},fcf:{model:.01},alt:{net:.01,fcf:.01}}];
  const t=marginTrendTest(rows)['byHorizon']['year 3'];
  assert.strictEqual(t.netMargin.n,2);assert.strictEqual(t.netMargin.ruleCloserRate,0.5);
  console.log('margin climb ok');
}
console.log('build75 tests passed');
