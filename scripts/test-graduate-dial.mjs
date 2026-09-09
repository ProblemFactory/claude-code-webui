// B-6640 e2e: graduate a REAL ssh machine to dial-out and back.
// Runs a THROWAWAY server in a git worktree (its own data/ — never touches a
// live instance) with the UNCOMMITTED working tree copied in, opens an ssh
// reverse tunnel so the host can genuinely reach it (the shape a NAT'd
// instance gets from the relay), then asserts the whole chain.
// Run: T_HOST=<ip> T_USER=<user> T_KEY=<keyfile> [T_PORT=22] node scripts/test-graduate-dial.mjs
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { freePort } from './scratch.mjs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const HOST=process.env.T_HOST, USER=process.env.T_USER, KEY=process.env.T_KEY, PORT_SSH=process.env.T_PORT||'22';
if(!HOST){ console.log('SKIP: no T_HOST'); process.exit(0); }
// THROWAWAY git worktree (server.js honours no data-dir env — the worktree's
// own data/ IS the isolation, the project's established smoke pattern) and a
// stripped env (an inherited VIBESPACE_PASSWORD turns auth ON and 401s the
// whole harness).
const WT=fs.mkdtempSync(path.join(os.tmpdir(),'vs-grad-wt-'));
execFileSync('git',['worktree','add','--detach',WT,'HEAD'],{cwd:REPO,stdio:'ignore'});
for (const f of ['node_modules','public/bundle.js','data/bin/vibespace-agentd.js','data/bin/vibespace-agentd-attach.js'])
  { try { fs.symlinkSync(path.join(REPO,f), path.join(WT,f)); } catch {} }
// the worktree is at HEAD — copy the UNCOMMITTED working-tree changes in, or
// the harness tests the previous release instead of the code under review
for (const f of execFileSync('git',['diff','--name-only','HEAD'],{cwd:REPO}).toString().split('\n').filter(Boolean))
  { try { fs.mkdirSync(path.dirname(path.join(WT,f)),{recursive:true}); fs.copyFileSync(path.join(REPO,f), path.join(WT,f)); } catch {} }
const env={...process.env}; delete env.VIBESPACE_PASSWORD; delete env.VIBESPACE_GENERATE_PASSWORD;
const PORT = await freePort(); // per-process (scripts/scratch.mjs)
const srv=spawn('node',[path.join(WT,'server.js')],{cwd:WT,env:{...env,PORT:String(PORT),VIBESPACE_SKIP_AGENT_HOOKS:'1',VIBESPACE_PUBLIC_URL:`http://127.0.0.1:${PORT}`},stdio:['ignore','pipe','pipe']});
let log=''; srv.stdout.on('data',d=>{log+=d;}); srv.stderr.on('data',d=>{log+=d;});
const req=(m,p,body)=>new Promise((res,rej)=>{const d=body?JSON.stringify(body):null;
  const r=http.request({host:'127.0.0.1',port:PORT,path:p,method:m,headers:d?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}},(s)=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>{try{res({status:s.statusCode,json:JSON.parse(b||'{}')})}catch{res({status:s.statusCode,json:{raw:b.slice(0,200)}})}})});
  r.on('error',rej); r.end(d);});
const wait=async(fn,ms=60000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(await fn())return true}catch{}await new Promise(r=>setTimeout(r,1500))}return false};
let pass=0,fail=0; const ck=(n,c,extra='')=>{ if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(extra?' — '+extra:''))} };
try{
  ck('server booted', await wait(async()=>(await req('GET','/api/home')).status===200, 60000));
  const add=await req('POST','/api/hosts',{name:'gradtest',host:HOST,user:USER,port:Number(PORT_SSH),privateKey:fs.readFileSync(KEY,'utf-8')});
  const hid=add.json?.host?.id||add.json?.id; ck('ssh host added',!!hid, JSON.stringify(add.json).slice(0,150));
  const t=await req('POST',`/api/hosts/${hid}/test`); ck('ssh reachable', t.status===200 && !t.json?.error, JSON.stringify(t.json).slice(0,120));
  // Give the HOST a genuinely reachable path back to this throwaway server:
  // an ssh reverse tunnel (the same shape a NAT'd instance gets from the frp
  // relay). Without it the precheck correctly refuses — which is itself the
  // NAT guard working, but we want to exercise the whole chain here.
  const tun=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-o','StrictHostKeyChecking=accept-new','-i',KEY,'-p',PORT_SSH,'-N','-R',`${PORT}:127.0.0.1:${PORT}`,`${USER}@${HOST}`],{stdio:'ignore'});
  await new Promise(r=>setTimeout(r,4000));
  console.log('  … graduating (installs the daemon as a service over ssh; up to 5min)');
  const g=await req('POST',`/api/hosts/${hid}/graduate-dial`,{serverUrl:`http://127.0.0.1:${PORT}`});
  ck('graduate route succeeded', g.json?.success===true, JSON.stringify(g.json).slice(0,300));
  const live=await wait(async()=>{const l=await req('GET','/api/hosts');const h=(l.json.hosts||[]).find(x=>x.id===hid);return h?.graduated&&h?.dialLive;},90000);
  const lNow=await req('GET','/api/hosts'); const hNow=(lNow.json.hosts||[]).find(x=>x.id===hid);
  ck('host reports graduated + dialLive', live, 'record: '+JSON.stringify({graduated:hNow?.graduated,dialLive:hNow?.dialLive,deviceId:hNow?.deviceId,transport:hNow?.transport}));
  const fi=await req('GET',`/api/file/info?path=${encodeURIComponent('~')}&host=${hid}`);
  ck('data-plane op works while graduated', fi.status===200, JSON.stringify(fi.json).slice(0,120));
  ck('server log shows the dial-in', /dialed in/.test(log));
  const rm=await req('POST',`/api/hosts/${hid}/graduate-dial`,{remove:true});
  ck('remove rolled it back', rm.json?.removed===true, JSON.stringify(rm.json).slice(0,150));
  const l2=await req('GET','/api/hosts'); const h2=(l2.json.hosts||[]).find(x=>x.id===hid);
  ck('record is a plain ssh machine again', !!h2 && !h2.graduated && !h2.deviceId);
  const t2=await req('POST',`/api/hosts/${hid}/test`); ck('ssh still works after removal', t2.status===200 && !t2.json?.error, JSON.stringify(t2.json).slice(0,120));
}catch(e){ console.log('HARNESS THREW:', e.message); fail++; }
console.log(fail?`${fail} FAILED (${pass} passed)`:`ALL PASS (${pass})`);
if(fail) console.log('--- server log tail ---\n'+log.slice(-2500));
try{ tun?.kill(); }catch{}
srv.kill(); try{ execFileSync('git',['worktree','remove','--force',WT],{cwd:REPO,stdio:'ignore'}); }catch{} process.exit(fail?1:0);
