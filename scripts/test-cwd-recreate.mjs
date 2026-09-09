import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { freePort, scratch } from './scratch.mjs';
const require = createRequire(new URL('../server.js', import.meta.url));
const repo = process.cwd();
const PORT = await freePort(); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('cwdre-smoke'), fakeHome = scratch('cwdre-home');
const MISSING_CWD = scratch('cwdre-workdir') + '/deleted-project';
const SID = '77770000-1111-2222-3333-444455556666';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, c, extra) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${extra ? ' — ' + extra : ''}`); } };
try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
fs.rmSync(scratch('cwdre-workdir'), { recursive: true, force: true }); // the cwd does NOT exist
const projDir = path.join(fakeHome, '.claude', 'projects', MISSING_CWD.replace(/[/._]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), sessionId: SID, cwd: MISSING_CWD, message: { role: 'user', content: [{ type: 'text', text: 'hello from before the deletion' }] } }) + '\n');
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {}; try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}; try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}; try { fs.rmSync(scratch('cwdre-workdir'), { recursive: true, force: true }); } catch {} });
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
const WebSocket = require('ws');
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r) => ws.on('open', r));
const replies = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.reqId) { (replies.get(m.reqId) || []).forEach?.(0); const cb = replies.get(m.reqId); if (cb) cb(m); } });
const send = (msg) => new Promise((res) => { replies.set(msg.reqId, (m) => { if (['created', 'error'].includes(m.type)) res(m); }); ws.send(JSON.stringify(msg)); });
// 1. refuse with structured code
const r1 = await send({ type: 'create', backend: 'claude', mode: 'chat', resume: true, resumeId: SID, cwd: MISSING_CWD, reqId: 'r1', cols: 80, rows: 24 });
check('missing cwd refused', r1.type === 'error', JSON.stringify(r1).slice(0, 120));
check('error carries code cwd-missing', r1.code === 'cwd-missing');
check('error carries cwd', r1.cwd === MISSING_CWD);
// 2. recreate flag → mkdir + spawn
const r2 = await send({ type: 'create', backend: 'claude', mode: 'chat', resume: true, resumeId: SID, cwd: MISSING_CWD, recreateCwd: true, reqId: 'r2', cols: 80, rows: 24 });
check('recreateCwd create succeeds', r2.type === 'created', JSON.stringify(r2).slice(0, 120));
check('directory recreated on disk', fs.existsSync(MISSING_CWD));
await sleep(3000);
// 3. meta flag + agent token
const metaDir = path.join(wt, 'data', 'session-meta');
let meta = null;
for (const f of fs.readdirSync(metaDir)) { const m = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8')); if (m.cwd === MISSING_CWD) meta = m; }
check('meta.cwdRecreated persisted', meta?.cwdRecreated === true, JSON.stringify(meta || {}).slice(0, 150));
const tok = meta?.agentToken;
check('agent token in meta', !!tok);
// 4. one-shot notice via prompt-context
const pc1 = await (await fetch(`http://127.0.0.1:${PORT}/api/agent/prompt-context`, { headers: { Authorization: `Bearer ${tok}` } })).json();
check('first prompt-context carries cwd notice', String(pc1.context || '').includes('<vibespace-cwd-notice>'), JSON.stringify(pc1).slice(0, 150));
check('notice names the cwd', String(pc1.context || '').includes(MISSING_CWD));
const pc2 = await (await fetch(`http://127.0.0.1:${PORT}/api/agent/prompt-context`, { headers: { Authorization: `Bearer ${tok}` } })).json();
check('second call: notice one-shot (absent)', !String(pc2.context || '').includes('<vibespace-cwd-notice>'));
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
