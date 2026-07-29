'use strict';
function hash(s){let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function normal(r){const u=Math.max(r(),1e-9),v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function percentile(a,p){const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor((s.length-1)*p))];}
function simulateReturns(stock,returnV2,agreementScore,confidence=70,n=1200){if(returnV2?.expectedCAGR==null)return null;const r=rng(hash(stock.ticker||'X'));const sigma=.055+(100-(agreementScore??50))/100*.09+(100-confidence)/100*.05;const vals=[];for(let i=0;i<n;i++)vals.push(Math.max(-.75,Math.min(.75,returnV2.expectedCAGR+normal(r)*sigma)));return {p10:percentile(vals,.10),p25:percentile(vals,.25),median:percentile(vals,.50),p75:percentile(vals,.75),p90:percentile(vals,.90),probability15Plus:vals.filter(x=>x>=.15).length/n,probabilityNegative:vals.filter(x=>x<0).length/n,probabilityBeatMarket:vals.filter(x=>x>=.10).length/n,simulations:n};}
module.exports={simulateReturns};
