#!/usr/bin/env node
// Codex P2 client-side rows (docs/design-harness-plugins.md §1, 2.369.21):
// onboarding readiness counts codex named accounts, the billing switcher
// shows codex quota, whole-thread fork is exposed for codex (thread/fork is
// wired: wrapper ← CODEX_WEBUI_FORK ← server _forkRequested per harness
// caps), and the permission-mode dropdown seeds per backend.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// ── fork: the real wrapper forks when asked (stub app-server records the RPC) ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxfork-'));
  const SID = 'sess-3-1700000000003';
  const buf = path.join(dir, SID + '.buf'), meta = path.join(dir, SID + '.json'), rpcLog = path.join(dir, 'rpc.jsonl');
  const STUB = `const fs=require('fs');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const line=b.slice(0,i);b=b.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}if(m.id!==undefined&&m.method){fs.appendFileSync(${JSON.stringify(rpcLog)},line+'\\n');const result=m.method==='thread/fork'?{thread:{id:'th-forked'}}:m.method==='thread/start'?{thread:{id:'th-new'}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}}});setInterval(()=>{},1e3);`;
  const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, meta, process.execPath, '-e', STUB], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_WEBUI_CWD: dir, CODEX_WEBUI_RESUME_ID: 'th-old', CODEX_WEBUI_FORK: '1', VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
  });
  w.stdout.on('data', () => {}); w.stderr.on('data', () => {});
  const rpc = () => { try { return read(rpcLog).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const readAbs = (p) => fs.readFileSync(p, 'utf8');
  const rpcAbs = () => { try { return readAbs(rpcLog).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  let t0 = Date.now(); while (Date.now() - t0 < 8000 && !rpcAbs().some((m) => m.method === 'thread/fork')) await sleep(100);
  const fk = rpcAbs().find((m) => m.method === 'thread/fork');
  ok(!!fk && fk.params.threadId === 'th-old', 'CODEX_WEBUI_FORK=1 + resume id → the wrapper sends thread/fork for the parent thread (not thread/resume)');
  ok(!rpcAbs().some((m) => m.method === 'thread/resume' || m.method === 'thread/start'), 'no resume/start alongside the fork (one writer, a NEW thread id comes back)');
  t0 = Date.now(); while (Date.now() - t0 < 5000 && (() => { try { return JSON.parse(readAbs(meta)).threadId !== 'th-forked'; } catch { return true; } })()) await sleep(100);
  ok((() => { try { return JSON.parse(readAbs(meta)).threadId === 'th-forked'; } catch { return false; } })(), 'the forked thread id is adopted into the sidecar (discovery/forkedFrom chain sees the child)');
  try { w.kill('SIGTERM'); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── wiring pins ──
const caps = require(path.join(REPO, 'src/backend-caps.js'));
ok(caps.capsOf('claude').fork === true && caps.capsOf('codex').fork === true && caps.capsOf('shell').fork === false && caps.capsOf('nope').fork === false, 'backend-caps carries fork per harness (claude/codex yes, shell/unknown no)');
const wsc = read('src/ws-create.js');
ok(/_forkRequested: !!data\.fork && !!capsOf\(backend\)\.fork/.test(wsc) && /require\('\.\/backend-caps'\)/.test(wsc), 'ws-create honours a fork request per harness caps (no claude-only branch)');
const meta = read('src/lib/agent-meta.js');
ok(/caps: \{ fork: true, effort: true, review: true, outputStyle: false, autoResume: true, quotaRefresh: 'session-rpc', accounts: true \}/.test(meta), 'client META: codex caps.fork is true (the fork button/menu shows)');
ok(/permissionModes: \['default', 'read-only', 'safe-yolo', 'yolo'\]/.test(meta) && /permissionModes: \['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'\]/.test(meta), 'client META carries a permission-mode seed per backend');
const sb = read('src/lib/chat-status-bar.js');
ok(/BACKEND_META\[backend\]\?\.permissionModes/.test(sb) && /import \{ BACKEND_META, getBackendMeta, backendFeatureCaps, effortLabel \} from '\.\/agent-meta\.js'/.test(sb), 'the status bar seeds its permission dropdown from META (never claude modes on a codex chat before the first status)');
const sf = read('src/lib/setup-flows.js');
ok(/const named = b\.namedLoggedIn \|\| 0;/.test(sf) && !/key === 'claude' \? \(b\.namedLoggedIn/.test(sf) && /const acctBtn = b\.installed\n/.test(sf), 'onboarding counts named accounts and offers the accounts door for every installed backend');
const sv = read('server.js');
ok(/out\.codex\.namedLoggedIn = \(l\.accounts \|\| \[\]\)\.filter\(\(a\) => a\.backend === 'codex' && a\.loggedIn\)\.length/.test(sv), '/api/backend-status reports codex.namedLoggedIn');
const sl = read('src/lib/session-lifecycle.js');
ok(/if \(\(a\.backend \|\| 'claude'\) === 'codex'\) return this\._codexAccountUsage\?\.\[a\.id\];/.test(sl), 'billing switcher: codex account rows read the persisted codex quota buckets');
ok(/isCodex \? \(rHostId \? '' : usageHint\(this\._codexAccountUsage\?\.__global_codex__/.test(sl), 'billing switcher: the ChatGPT-login row shows the global codex quota');
ok(/_doForkSession\(sessionInfo/.test(sl) && /fork: true,/.test(sl), 'fork flows send fork:true for every backend (extraArgs stay claude-only: --fork-session)');

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
