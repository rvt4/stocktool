'use strict';
// Build 55: forecast tracking. Once a month, save each company's year-1 and year-2 revenue forecasts
// (plus the evidence behind them). On every run, compare old forecasts with the revenue the company
// later reported, and summarize the errors by how fast the model expected the company to grow.
// After a few quarters this shows whether the model systematically under- or over-forecasts fast
// growers, so caps and fades can be calibrated from real results instead of judgment.
//
// Files (both committed by the nightly workflow):
//   data/forecast-tracking.json  - monthly snapshots (last 48 kept)
//   data/forecast-accuracy.json  - summary report
const fs=require('fs');
const path=require('path');

const finite=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const median=a=>{const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const mean=a=>{const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;};

// The fiscal year and revenue of the last REPORTED year, backed out from the first projection row.
function reportedBase(s){
  const r0=(s.valuationProjection||[])[0];
  const rev1=finite(r0?.revenue),g1=finite(r0?.revenueGrowth),yr1=finite(r0?.year);
  if(!(rev1>0)||g1==null||yr1==null||g1<=-1)return null;
  return {year:yr1-1,revenue:rev1/(1+g1)};
}

function snapshotRow(s){
  const p=s.valuationProjection||[];
  if(p.length<2)return null;
  const b=s.projectionAssumptions?.forecastBridge?.revenue||{};
  const ltg=b.longTermConsensus||{};
  return [finite(p[0].year),finite(p[0].revenue),finite(p[0].revenueGrowth),finite(p[1].year),finite(p[1].revenue),finite(p[1].revenueGrowth),
    finite(s.analystEstimates?.numAnalysts),finite(ltg.raw),finite(b.backlogEvidence?.signal),String(s.sector||'')];
}
const COLS=['y1Year','y1Revenue','y1Growth','y2Year','y2Revenue','y2Growth','numAnalysts','longTermConsensus','backlogSignal','sector'];

function bucketOf(g){if(g==null)return 'unknown';if(g<0)return '<0%';if(g<.10)return '0-10%';if(g<.20)return '10-20%';if(g<.30)return '20-30%';return '30%+';}

function evaluate(snapshots,stocks){
  const base=new Map();
  for(const s of stocks){const b=reportedBase(s);if(b)base.set(s.ticker,b);}
  const obs=[];
  for(const snap of snapshots){
    for(const [t,row] of Object.entries(snap.rows||{})){
      const rec=Object.fromEntries(COLS.map((c,i)=>[c,row[i]]));
      const actual=base.get(t);if(!actual)continue;
      for(const h of [1,2]){
        const fy=rec[`y${h}Year`],fr=rec[`y${h}Revenue`],fg=rec[`y${h}Growth`];
        if(fy!=null&&fr>0&&fy===actual.year){
          obs.push({ticker:t,asOf:snap.asOf,horizon:h,forecastGrowth:fg,error:actual.revenue/fr-1,numAnalysts:rec.numAnalysts,hasLongTerm:rec.longTermConsensus!=null,hasBacklog:rec.backlogSignal!=null,sector:rec.sector});
        }
      }
    }
  }
  const summarize=list=>({n:list.length,meanError:mean(list.map(o=>o.error)),medianError:median(list.map(o=>o.error)),
    shareTooLow:list.length?list.filter(o=>o.error>0).length/list.length:null});
  const group=(fn)=>{const g={};for(const o of obs){const k=fn(o);(g[k]??=[]).push(o);}return Object.fromEntries(Object.entries(g).map(([k,v])=>[k,summarize(v)]));};
  return {
    note:'error = actual reported revenue / forecast - 1. Positive = the model forecast too LOW (company grew faster). Based on monthly snapshots compared once the forecast year has been reported.',
    observations:obs.length,
    byHorizon:group(o=>'year '+o.horizon),
    byForecastGrowth:group(o=>`year ${o.horizon} · ${bucketOf(o.forecastGrowth)}`),
    byEvidence:group(o=>o.hasLongTerm&&o.hasBacklog?'consensus + backlog':o.hasLongTerm?'consensus only':o.hasBacklog?'backlog only':'neither'),
    bySector:group(o=>o.sector||'unknown'),
    worstMisses:obs.slice().sort((a,b)=>Math.abs(b.error)-Math.abs(a.error)).slice(0,25).map(o=>({ticker:o.ticker,asOf:o.asOf,horizon:o.horizon,forecastGrowth:o.forecastGrowth,error:o.error}))
  };
}

function trackForecasts(output,{dataDir=path.join(__dirname,'data'),now=new Date(),keep=48}={}){
  const stocks=output?.stocks||[];
  const file=path.join(dataDir,'forecast-tracking.json');
  let store={version:1,columns:COLS,snapshots:[]};
  try{if(fs.existsSync(file))store=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){}
  const month=now.toISOString().slice(0,7);
  if(!store.snapshots.some(s=>String(s.asOf).slice(0,7)===month)){
    const rows={};for(const s of stocks){const r=snapshotRow(s);if(r)rows[s.ticker]=r;}
    store.snapshots.push({asOf:now.toISOString().slice(0,10),rows});
    store.snapshots=store.snapshots.slice(-keep);
    store.columns=COLS;
    fs.writeFileSync(file,JSON.stringify(store));
  }
  const report={generatedAt:now.toISOString(),snapshots:store.snapshots.length,firstSnapshot:store.snapshots[0]?.asOf??null,...evaluate(store.snapshots,stocks)};
  fs.writeFileSync(path.join(dataDir,'forecast-accuracy.json'),JSON.stringify(report,null,1));
  return report;
}

module.exports={trackForecasts,evaluate,reportedBase,snapshotRow,COLS};
