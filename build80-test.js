'use strict';
// Build 80: one-off gains in this year's consensus must not fool the stock-pay basis test or the margin anchor.
const assert=require('assert');
const {buildForecast}=require('./engine/forecast-engine');
// GAAP net 25%, stock pay 6% of revenue; analysts (GAAP basis) expect 25% net next year, but this year's
// consensus includes big investment gains (40% "net").
function stock(net1){
  const years=[];let revenue=100e9;const shares=1e9;
  [.24,.24,.25,.25,.25].forEach((nm,i)=>{revenue*=1.12;years.push({year:2021+i,revenue,netIncome:revenue*nm,operatingIncome:revenue*(nm+.05),ebitda:revenue*(nm+.10),
    cfo:revenue*(nm+.10),capex:revenue*.06,fcf:revenue*(nm+.04),sbc:revenue*.06,sharesOutTTM:shares,totalDebt:10e9,cash:60e9,pretaxIncome:revenue*(nm+.05),incomeTaxExpense:revenue*(nm+.05)*.17});});
  const r1=revenue*1.12,r2=r1*1.12;
  return {ticker:'GOO',sector:'Technology',financials:{years,dataQuality:{}},growthYear1:.12,price:{current:300},valuation:{dividendYield:0,growthSource:'test'},
    analystEstimates:{numAnalysts:45,revenueGrowthCurrentYear:.12,revenueGrowthNextYear:.12,revenueCurrentYear:r1,revenueNextYear:r2,epsCurrentYear:net1*r1/shares,epsNextYear:.25*r2/shares}};
}
const clean=buildForecast(stock(.25)), spike=buildForecast(stock(.40));
const A=f=>f.forecastBridge.margins.analystMarginAnchor;
assert.strictEqual(A(clean).consensusBasis,'includes_sbc');
assert.strictEqual(A(spike).consensusBasis,'includes_sbc','one-off year must not flip the basis to excludes_sbc');
assert.strictEqual(A(spike).consensusOneOff,true);
assert.strictEqual(A(clean).consensusOneOff,false);
const op=f=>f.rows.map(r=>r.operatingMargin);
const dip=f=>{const o=op(f);return o[0]-Math.min(...o);};
assert(dip(spike)<dip(clean)+.02,'no extra margin dip from a one-off consensus year: '+dip(clean)+' vs '+dip(spike));
console.log('build80 tests passed');

// Build 80b (1): a one-off gain below the operating line is not a margin peak (AMZN's investment mark-ups).
{
  const mk=gain=>{const years=[];let revenue=200e9;const shares=10e9;
    const net=[.04,.05,.04,.05,.05,.04,.05,.05,.09,.11];
    net.forEach((nm,i)=>{revenue*=1.10;const g=i===net.length-1?gain:0;
      years.push({year:2016+i,revenue,netIncome:revenue*(nm+g),operatingIncome:revenue*(nm/.82),ebitda:revenue*(nm/.82+.08),cfo:revenue*(nm+.08),capex:revenue*.07,
        fcf:revenue*(nm+.01),sbc:revenue*.02,sharesOutTTM:shares,totalDebt:50e9,cash:80e9,pretaxIncome:revenue*(nm+g)/.82,incomeTaxExpense:revenue*(nm+g)/.82*.18,grossProfit:revenue*.45});});
    return buildForecast({ticker:'AMZ',sector:'Consumer Discretionary',financials:{years,dataQuality:{}},growthYear1:.10,price:{current:200},valuation:{dividendYield:0,growthSource:'test'},analystEstimates:{numAnalysts:0}});};
  const clean=mk(0),gain=mk(.04);
  const mat=f=>f.forecastBridge.margins.peakMarginDiscipline;
  assert(gain.forecastBridge.margins.peakMarginDiscipline.durabilityEvidence.includes('one_off_gains_excluded'),'gain should be recognised');
  const cut=f=>-(mat(f).delta.mature||0);
  assert(cut(gain)<=cut(clean)+.003,'a one-off gain must not deepen the peak-margin fade: '+cut(clean)+' vs '+cut(gain));
}

// Build 80b (2): lenders and insurers get an EPS-only simple table.
{
  const {buildSimplePath,calculateSimple}=require('./engine/simple-path');
  const rows=[];let R=50e9,S=700e6;
  for(let i=0;i<10;i++){R*=1.07;S*=.98;rows.push({year:2026+i,revenue:R,revenueGrowth:.07,shares:S,actualDilution:-.02,dividendPerShare:3+i*.2});}
  const path=Array(10).fill(.08);
  const val={methods:[{name:'Normalized EPS exit',audit:{exitMultiple:16,normalizedEPSBase:15,epsGrowthPath:path}}]};
  const sp=buildSimplePath({price:{current:300},analystEstimates:{numAnalysts:20,epsCurrentYear:16.5,epsNextYear:18.0,epsGrowthCurrentYear:.10}},{rows},val);
  assert(sp&&sp.epsOnly,'EPS-only path expected');
  assert.strictEqual(sp.basis,'consensus_years_1_2');
  assert(Math.abs(sp.years[0].eps-16.5*.99)<1e-9&&Math.abs(sp.years[1].eps-18*.96)<1e-9);
  assert(Math.abs(sp.years[2].eps/sp.years[1].eps-1.08*(1-.04*2/3)/.96)<1e-9,'later years follow the model EPS growth path, trim fading');
  assert(Math.abs(sp.years[5].eps/sp.years[4].eps-1.08)<1e-9,'no trim after year 5');
  const r=calculateSimple(sp);const y=r.years[9];
  assert(Math.abs(y.price-y.eps*16)<1e-9,'price = EPS x P/E, no cash line');
  assert(Number.isFinite(r.cagr));
  // a feed value far off the model (different basis) falls back to the model
  const sp2=buildSimplePath({price:{current:300},analystEstimates:{numAnalysts:20,epsCurrentYear:40,epsNextYear:44}},{rows},val);
  assert.strictEqual(sp2.basis,'model');
}
console.log('build80b tests passed');

// Build 80c: consensus EPS record and error measurement.
{
  const os=require('os'),fs=require('fs'),path=require('path');
  const {trackForecasts,evaluateEps}=require('./track-forecasts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trk-'));
  const stock=(eCY,eNY,gCY,fy)=>({ticker:'AAA',sector:'Tech',valuationProjection:[{year:fy,revenue:110,revenueGrowth:.1},{year:fy+1,revenue:121,revenueGrowth:.1}],
    analystEstimates:{numAnalysts:10,epsCurrentYear:eCY,epsNextYear:eNY,epsGrowthCurrentYear:gCY,epsCurrentYear90dAgo:eCY,epsNextYear90dAgo:eNY}});
  // Jan 2025: analysts expect $10 for FY2025 and $12 for FY2026.
  trackForecasts({stocks:[stock(10,12,.1,2025)]},{dataDir:dir,now:new Date('2025-01-15')});
  // Jan 2026: FY2025 is over; this year's $12.10 is +10% on last year's actual, so FY2025 actual = $11.
  const rep=trackForecasts({stocks:[stock(12.1,13.5,.1,2026)]},{dataDir:dir,now:new Date('2026-01-15')});
  const e=rep.consensusEps;
  const ty=e.byHorizon['this year'];
  assert(ty&&ty.n===1&&Math.abs(ty.medianError-(11/10-1))<1e-9,'this-year error vs actual on the same basis');
  assert(!e.byHorizon['next year'],'FY2026 not reported yet');
  const stored=JSON.parse(fs.readFileSync(path.join(dir,'forecast-tracking.json'),'utf8'));
  assert.strictEqual(stored.snapshots.length,2);assert(stored.revisionHistory.length===2);
  // a second run in the same month does not add a snapshot
  trackForecasts({stocks:[stock(12.1,13.5,.1,2026)]},{dataDir:dir,now:new Date('2026-01-20')});
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir,'forecast-tracking.json'),'utf8')).snapshots.length,2);
}
console.log('build80c tests passed');
