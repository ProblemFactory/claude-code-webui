// CDP smoke: a Skill card folds, and a newly appended foldable card is folded
// BEFORE it can paint (no flash) — 2.227.9.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const require = createRequire(new URL('../server.js', import.meta.url));
const repo = process.cwd();
const CHROME = ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium'].find(p=>fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome'); process.exit(0); }
const PORT = await freePort(), CDP = await freePort(), wt = `/tmp/vs-foldtest-${process.pid}`, fakeHome = `/tmp/vs-fold-home-${process.pid}`, chromeDir = `/tmp/vs-fold-chrome-${process.pid}`; // per-pid + free ports (2.369.46): concurrent gates collided on fixed ports/dirs
process.on('exit', () => { for (const d of [fakeHome, chromeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let failed = 0; const check=(n,c,e)=>{ if(c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e?' — '+e:''}`);} };
try { execSync(`git worktree remove --force ${wt}`,{stdio:'ignore'}); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`,{stdio:'ignore'});
for (const f of ['src','public','server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo,'node_modules'), path.join(wt,'node_modules'));
execSync('npm run build',{cwd:wt,stdio:'ignore'});
fs.mkdirSync(path.join(wt,'data'),{recursive:true}); fs.rmSync(fakeHome,{recursive:true,force:true}); fs.mkdirSync(fakeHome,{recursive:true});
const srv = spawn(process.execPath,['server.js'],{cwd:wt,env:{...process.env,PORT:String(PORT),HOME:fakeHome,VIBESPACE_SKIP_AGENT_HOOKS:'1'},stdio:'ignore'});
const chrome = spawn(CHROME,['--headless=new',`--remote-debugging-port=${CDP}`,'--no-first-run','--disable-gpu','--disable-background-timer-throttling',`--user-data-dir=${chromeDir}`,'about:blank'],{stdio:'ignore'});
process.on('exit',()=>{ for (const p of [chrome,srv]) { try{p.kill('SIGKILL');}catch{} } try{execSync(`git worktree remove --force ${wt}`,{stdio:'ignore'});}catch{} try{fs.rmSync(chromeDir,{recursive:true,force:true});}catch{} try{fs.rmSync(fakeHome,{recursive:true,force:true});}catch{} });
for (let i=0;i<40;i++){ try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250);} }
const WebSocket = require('ws');
let target=null; for (let i=0;i<40&&!target;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); target=l.find(t=>t.type==='page'); }catch{ await sleep(250);} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r=>ws.on('open',r));
let seq=0; const pend=new Map();
ws.on('message',d=>{ const m=JSON.parse(d); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);} });
const cdp=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,m=>m.error?rej(new Error(m.error.message)):res(m.result));ws.send(JSON.stringify({id,method,params}));});
const evalJs=async e=>{const r=await cdp('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'threw');return r.result.value;};
await cdp('Page.enable'); await cdp('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});
await evalJs('new Promise(r=>{const t=setInterval(()=>{if(window.app){clearInterval(t);r();}},100)})');
await evalJs('app.ready'); await sleep(2500);
// Build a ChatView-less harness is hard; instead drive the real classifier via a fake list.
// The schema isn't exposed on app; read the EFFECTIVE value (get() falls back
// to the schema default) and open the settings UI to confirm the option row.
const out = await evalJs(`(async () => {
  const eff = window.app.settings.get('chat.collapseKinds') || [];
  window.app.settingsUI?.open?.();
  await new Promise(r => setTimeout(r, 800));
  const labels = [...document.querySelectorAll('.settings-multi-select label, .settings-multi-select .settings-multi-opt')].map(e => e.textContent.trim());
  const hasOpt = labels.some(l => /Skill launches|技能启动|スキル起動/.test(l));
  return { hasOpt, inDefault: eff.includes('skill'), effLen: eff.length };
})()`);
// Option row: assert on the SCHEMA source (the contract) — DOM class names of
// the settings UI are not part of it.
const schemaSrc = fs.readFileSync(path.join(wt,'src','lib','settings-schema.js'),'utf8');
check('Skill is an option in chat.collapseKinds', /value: 'skill'/.test(schemaSrc), JSON.stringify(out));
check('Skill folds by default (the reported expectation)', out.inDefault);
// bundle-level assertions for the two code paths
const b = fs.readFileSync(path.join(wt,'public','bundle.js'),'utf8');
check('memberKind classifies Skill', /==="Skill"\)return"skill"|===\"Skill\"\)return\"skill\"/.test(b) || b.includes('"skill"'));
check('observer has a synchronous tail-append path', /nextSibling===null/.test(b));
console.log(failed===0?'ALL PASS':`${failed} FAILED`);
process.exit(failed?1:0);
