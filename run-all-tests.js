'use strict';
// Build 94: run every JS test file; exit non-zero if any fails, so the nightly stops before writing results.
// Picks up any file ending in "-test.js", so new tests are included without editing this list.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const files=fs.readdirSync(__dirname).filter(f=>f.endsWith('-test.js')).sort();
const failed=[];
for(const f of files){
  const r=spawnSync(process.execPath,[path.join(__dirname,f)],{cwd:__dirname,encoding:'utf8',timeout:300000});
  if(r.status===0){console.log('PASS '+f);continue;}
  failed.push(f);
  console.log('FAIL '+f+'\n'+String((r.stderr||'')+(r.stdout||'')).split('\n').slice(0,15).join('\n'));
}
console.log(`${files.length-failed.length}/${files.length} test files passed.`);
if(failed.length){console.error('Failed: '+failed.join(', '));process.exit(1);}
