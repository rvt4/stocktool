'use strict';
const fs=require('fs'); const path=require('path');
function validate(stocks){
 const issues=[]; const counts={};
 for(const s of stocks){counts[s.rating]=(counts[s.rating]||0)+1;
  const p=s.probabilityProfile||{};
  if(s.rating==='Exceptional Buy'&&(!(s.marginOfSafety>=.20)||!(s.confidenceScore>=78)))issues.push({ticker:s.ticker,type:'exceptional_gate_failure'});
  if(['Exceptional Buy','Strong Buy'].includes(s.rating)&&Number(s.expectedReturn)<.12)issues.push({ticker:s.ticker,type:'return_rating_mismatch'});
  if(Number(p.pPermanentLoss)>.45&&['Exceptional Buy','Strong Buy','Buy'].includes(s.rating))issues.push({ticker:s.ticker,type:'loss_probability_mismatch'});
 }
 const total=stocks.length||1;
 return {version:'validation-v1',generatedAt:new Date().toISOString(),stocks:stocks.length,ratingDistribution:counts,exceptionalShare:(counts['Exceptional Buy']||0)/total,strongOrBetterShare:((counts['Exceptional Buy']||0)+(counts['Strong Buy']||0))/total,issues,passed:issues.length===0};
}
if(require.main===module){const root=path.join(__dirname,'..');const data=JSON.parse(fs.readFileSync(path.join(root,'data','results.json'),'utf8'));const report=validate(data.stocks||[]);fs.writeFileSync(path.join(root,'data','validation-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
module.exports={validate};
