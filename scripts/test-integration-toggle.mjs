#!/usr/bin/env node
// Integration master-switch e2e (2.190.0, agents.vibespaceIntegration):
//  1. Boot (default ON) registers the vibespace hook in BOTH CLI configs.
//  2. A spawned session's dtach argv carries VIBESPACE_API + data/bin PATH.
//  3. PATCH the switch OFF → hook entries stripped LIVE from both configs,
//     /api/agent-hooks reports integrationOff, install route refuses,
//     the delivery endpoints (task-context / prompt-context / stop-check)
//     return empty even for the pre-toggle session's still-valid token.
//  4. A session spawned while OFF has NO VIBESPACE_API and NO tools PATH,
//     but KEEPS the session token (Ctrl+G editor auth — never model-visible).
//  5. PATCH ON → hook re-registered.
//  6. Boot convergence: settings flipped OFF while the server is down +
//     hook entries present → next boot strips them.
// Runs a THROWAWAY server in a git worktree with a FAKE $HOME — never touches
// a live instance or the real ~/.claude. Run: node scripts/test-integration-toggle.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { freePort, scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await freePort(); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('integ-toggle');
const home = scratch('integ-home');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opts) => fetch(`http://127.0.0.1:${PORT}${p}`, opts);

// ── throwaway worktree + fake home ──────────────────────────────────────────
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
// A machine WITH codex has ~/.codex; registration creates only hooks.json in
// it (a missing dir = codex not installed ⇒ registration must SKIP, never
// manufacture the dir — reviewed invariant).
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

// FORCE hook registration: the harness runs the server from a /tmp worktree,
// where the 2.225.1 temp-server guard refuses every global-hook write — so
// the five hook assertions below could NEVER pass and this suite has been
// silently red since that release (found during the 2.271.0 lag/CS audit
// campaign; a red suite = zero coverage on the registration path). HOME is a
// throwaway dir here, so forcing only ever touches the fake configs.
const SRV_ENV = { ...process.env, HOME: home, PORT: String(PORT), VIBESPACE_FORCE_AGENT_HOOKS: '1' };
let srv = null;
// A stale listener on our port would silently absorb every assertion (real
// debugging cost: yesterday's crashed smoke servers still held the port).
try { await api('/api/home'); console.error(`ABORT: something already listens on :${PORT}`); process.exit(2); } catch {}
const bootServer = async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: SRV_ENV, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await api('/api/home'); if (r.ok) return; } catch {} await sleep(250); }
  throw new Error('server did not come up');
};
const cleanup = () => {
  try { srv?.kill('SIGKILL'); } catch {}
  try {
    for (const s of fs.readdirSync(path.join(wt, 'data', 'sockets'))) {
      try { execSync(`pgrep -f ${JSON.stringify(path.join(wt, 'data', 'sockets', s))} | xargs -r kill -9`, { shell: '/bin/bash' }); } catch {}
    }
  } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

const hookIn = (file) => {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf-8'))).includes('vibespace-hook.mjs'); }
  catch { return false; }
};
const claudeCfg = path.join(home, '.claude', 'settings.json');
const codexCfg = path.join(home, '.codex', 'hooks.json');

// ws session create → resolves {sessionId, argv} of the spawned dtach line
const WebSocket = require('ws');
let wsc = null;
const openWs = () => new Promise((res, rej) => {
  wsc = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  wsc.on('open', () => res());
  wsc.on('error', rej);
});
const createShellSession = () => new Promise((res, rej) => {
  const reqId = 'it-' + Math.random().toString(36).slice(2);
  const to = setTimeout(() => rej(new Error('create timed out')), 20000);
  const onMsg = (d) => {
    const m = JSON.parse(d);
    if (m.type === 'created' && m.reqId === reqId) { clearTimeout(to); wsc.off('message', onMsg); res(m.sessionId); }
    if (m.type === 'error' && m.reqId === reqId) { clearTimeout(to); wsc.off('message', onMsg); rej(new Error(m.message)); }
  };
  wsc.on('message', onMsg);
  wsc.send(JSON.stringify({ type: 'create', reqId, backend: 'shell', mode: 'terminal', cwd: home, cols: 80, rows: 24 }));
});
const dtachArgv = (sessionId) => {
  // the dtach spawn's argv contains the per-session socket path — match on it.
  // Socket names are cw-<tail> while sessionIds are sess-<tail>.
  const tail = sessionId.replace(/^sess-/, '');
  const sock = fs.readdirSync(path.join(wt, 'data', 'sockets')).find((s) => s.includes(tail));
  if (!sock) return null;
  const out = execSync(`ps axww -o args= | grep -F ${JSON.stringify(path.join(wt, 'data', 'sockets', sock))} | grep -v grep | head -1`, { shell: '/bin/bash' }).toString();
  return out || null;
};

// ═══ Phase 1: boot ON (default) ═════════════════════════════════════════════
console.log('Phase 1: boot with integration ON (default)');
await bootServer();
check('claude settings.json has the hook registered', hookIn(claudeCfg));
check('codex hooks.json created + hook registered', hookIn(codexCfg));
const hs1 = await (await api('/api/agent-hooks')).json();
check('/api/agent-hooks integrationOff=false', hs1.integrationOff === false);

await openWs();
const sid1 = await createShellSession();
await sleep(800);
const argv1 = dtachArgv(sid1);
check('ON-spawn argv has VIBESPACE_API', !!argv1 && argv1.includes('VIBESPACE_API='));
check('ON-spawn argv has the tools PATH prefix', !!argv1 && argv1.includes(`PATH=${path.join(wt, 'data', 'bin')}`));
const tok1 = argv1 && (argv1.match(/VIBESPACE_SESSION_TOKEN=(vsst_[\w-]+)/) || [])[1];
check('ON-spawn argv has the session token', !!tok1);
const auth = { headers: { Authorization: `Bearer ${tok1}` } };
const ctxOn = await (await api('/api/agent/task-context', auth)).json();
check('task-context delivers content while ON', !!(ctxOn.success && ctxOn.context && ctxOn.context.length > 50), JSON.stringify(ctxOn).slice(0, 200));

// ═══ Phase 2: toggle OFF live ═══════════════════════════════════════════════
console.log('Phase 2: PATCH agents.vibespaceIntegration=false');
await api('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'agents.vibespaceIntegration': false }) });
await sleep(300);
check('claude hook entries stripped live', !hookIn(claudeCfg));
check('codex hook entries stripped live', !hookIn(codexCfg));
const hs2 = await (await api('/api/agent-hooks')).json();
check('/api/agent-hooks integrationOff=true', hs2.integrationOff === true);
const inst = await api('/api/agent-hooks/install', { method: 'POST' });
check('install route refuses while OFF', inst.status === 400);
const ctxOff = await (await api('/api/agent/task-context', auth)).json();
check('task-context empty for pre-toggle session', ctxOff.success === true && (ctxOff.context || '') === '');
const pOff = await (await api('/api/agent/prompt-context', auth)).json();
check('prompt-context empty for pre-toggle session', pOff.success === true && (pOff.context || '') === '');
const sOff = await (await api('/api/agent/stop-check', auth)).json();
check('stop-check never blocks while OFF', sOff.block === false);
const tOff = await api('/api/agent/task', auth);
check('GET /api/agent/task refuses while OFF (steering-content read)', tOff.status === 403);

const sid2 = await createShellSession();
await sleep(800);
const argv2 = dtachArgv(sid2);
check('OFF-spawn argv has NO VIBESPACE_API', !!argv2 && !argv2.includes('VIBESPACE_API='), (argv2 || 'no argv').slice(0, 400));
check('OFF-spawn argv has NO tools PATH prefix', !!argv2 && !argv2.includes(`PATH=${path.join(wt, 'data', 'bin')}`));
check('OFF-spawn argv KEEPS the session token (Ctrl+G auth)', !!argv2 && argv2.includes('VIBESPACE_SESSION_TOKEN=vsst_'));

// ═══ Phase 3: toggle back ON ════════════════════════════════════════════════
console.log('Phase 3: PATCH back true');
await api('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'agents.vibespaceIntegration': null }) }); // null deletes → default ON
await sleep(300);
check('claude hook re-registered on re-enable', hookIn(claudeCfg));
check('codex hook re-registered on re-enable', hookIn(codexCfg));

// ═══ Phase 4: boot convergence (flipped OFF while server down) ══════════════
console.log('Phase 4: boot with the switch already OFF');
try { wsc?.close(); } catch {}
srv.kill('SIGKILL');
await sleep(500);
const settingsFile = path.join(wt, 'data', 'settings.json');
const cur = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
cur['agents.vibespaceIntegration'] = false;
fs.writeFileSync(settingsFile, JSON.stringify(cur));
check('precondition: hook present before boot', hookIn(claudeCfg));
await bootServer();
check('boot strips hook entries when switch is OFF', !hookIn(claudeCfg));
check('boot strips codex entries too', !hookIn(codexCfg));

srv.kill('SIGKILL');
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
