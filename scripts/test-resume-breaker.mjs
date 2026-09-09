import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import { freePort, scratch } from './scratch.mjs';
const require = createRequire(new URL('../server.js', import.meta.url));
const repo = process.cwd(); const PORT = await freePort(); // per-process (scripts/scratch.mjs)
const wt = scratch('brk-smoke'), fakeHome = scratch('brk-home');
const CWD = scratch('brk-work'); const SID = '88880000-1111-2222-3333-444455556666';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (n,c,e)=>{ if(c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e?' — '+e:''}`);} };
try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { stdio: 'ignore' });
for (const f of ['src','public','server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo,'node_modules'), path.join(wt,'node_modules'));
fs.mkdirSync(path.join(wt,'data'), { recursive:true });
fs.rmSync(fakeHome,{recursive:true,force:true}); fs.mkdirSync(CWD,{recursive:true});
// transcript EXISTS under the fake HOME (the "known" case)
const projDir = path.join(fakeHome,'.claude','projects', CWD.replace(/[/._]/g,'-'));
fs.mkdirSync(projDir,{recursive:true});
fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), JSON.stringify({type:'user',uuid:'u1',timestamp:new Date().toISOString(),sessionId:SID,cwd:CWD,message:{role:'user',content:[{type:'text',text:'precious 46MB conversation'}]}})+'\n');
const srv = spawn(process.execPath,['server.js'],{cwd:wt,env:{...process.env,PORT:String(PORT),HOME:fakeHome,VIBESPACE_SKIP_AGENT_HOOKS:'1'},stdio:'ignore'});
process.on('exit',()=>{ try{srv.kill('SIGKILL');}catch{}; try{execSync(`git worktree remove --force ${wt}`,{stdio:'ignore'});}catch{}; try{fs.rmSync(fakeHome,{recursive:true,force:true});}catch{}; try{fs.rmSync(CWD,{recursive:true,force:true});}catch{} });
for (let i=0;i<40;i++){ try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250);} }
// arm the breaker directly (same map the onExit path writes)
const { noConvoRef } = require(path.join(wt,'src','ws-handler.js'));
const WebSocket = require('ws');
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); await new Promise(r=>ws.on('open',r));
const pend = new Map();
ws.on('message',(d)=>{ const m=JSON.parse(d); const cb=pend.get(m.reqId); if(cb && ['created','error'].includes(m.type)) cb(m); });
const send=(msg)=>new Promise(res=>{ pend.set(msg.reqId,res); ws.send(JSON.stringify(msg)); });
// force the breaker via the server's own module instance: use a spawn that fails
// (simplest: resume an id whose transcript is absent AND arm through a real death)
// → instead assert the KNOWN-transcript wording by arming through the HTTP-side map is not reachable;
// so drive it the real way: resume a bogus id in a valid cwd (claude will fail fast), then re-resume.
const BOGUS = '99990000-dead-beef-0000-000000000000';
await send({type:'create',backend:'claude',mode:'chat',resume:true,resumeId:BOGUS,cwd:CWD,reqId:'b1',cols:80,rows:24});
await sleep(6000); // let it die + arm the breaker
const r2 = await send({type:'create',backend:'claude',mode:'chat',resume:true,resumeId:BOGUS,cwd:CWD,reqId:'b2',cols:80,rows:24});
check('breaker refuses with structured code', r2.type==='error' && r2.code==='no-convo-breaker', JSON.stringify(r2).slice(0,140));
check('absent transcript → transcriptKnown false', r2.transcriptKnown === false);
check('message never says "start a new session instead"', !/start a new session instead/i.test(r2.message||''), r2.message);
check('message says nothing was deleted', /nothing has been deleted/i.test(r2.message||''), r2.message);
// KNOWN case: arm for the id whose transcript exists
await send({type:'create',backend:'claude',mode:'chat',resume:true,resumeId:SID,cwd:scratch('brk-wrongdir'),recreateCwd:true,reqId:'k1',cols:80,rows:24});
await sleep(6000);
const r4 = await send({type:'create',backend:'claude',mode:'chat',resume:true,resumeId:SID,cwd:CWD,reqId:'k2',cols:80,rows:24});
if (r4.type==='error' && r4.code==='no-convo-breaker') {
  check('known transcript → transcriptKnown true', r4.transcriptKnown===true, JSON.stringify(r4).slice(0,140));
  check('known wording says NOT lost', /is NOT lost/i.test(r4.message||''), r4.message);
} else { console.log('  (known-case breaker not armed — resume succeeded, acceptable)'); }
// bypass flag must be honored
const r5 = await send({type:'create',backend:'claude',mode:'chat',resume:true,resumeId:BOGUS,cwd:CWD,ignoreNoConvo:true,reqId:'b3',cols:80,rows:24});
check('ignoreNoConvo bypasses the breaker', r5.type==='created', JSON.stringify(r5).slice(0,140));
console.log(failed===0?'ALL PASS':`${failed} FAILED`); process.exit(failed?1:0);
