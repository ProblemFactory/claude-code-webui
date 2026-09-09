#!/usr/bin/env node
// Attach-error view-only rescue smoke (2.217.0 — userL's 12 blank windows):
//  BUG: after the server loses its sessions (OOM kill, pod recreation), every
//  saved layout window replays a STALE serverId → attach errors → ChatView
//  set itself read-only on an EMPTY pane (blank window + Resume bar, no
//  history). FIX: _tryViewOnlyRescue flips the window into the view-only
//  pipeline in place — history from the local transcript OR the host-less
//  remote-jsonl cache scan (works with the session's host machine down).
// Asserts: (A) local-transcript rescue renders history + Resume bar;
//          (B) host-less spec whose transcript exists ONLY in the
//              remote-jsonl cache rescues too (the userL h200 case);
//          (C) unknown session (no transcript anywhere) degrades to the
//              plain error + read-only, no rescue loop.
// Runs a THROWAWAY server in a git worktree + headless chrome over raw CDP.
// Run: node scripts/test-attach-rescue.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

// Free ports + per-pid dirs (2.369.53): hard-coded ports collide with a
// parallel agent's copy of this suite (the 2.369.51 negative-control class).
const freePort = () => new Promise((res) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), CDP_PORT = await freePort();
const wt = `/tmp/vs-attach-rescue-${process.pid}`;
const fakeHome = scratch('attach-rescue-home');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── throwaway server in a worktree, fake HOME with a claude transcript ──────
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const SID_LOCAL = '11111111-2222-3333-4444-555555555555';
const SID_CACHED = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const SID_GONE = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const cwd = scratch('rescue-proj');
const rec = (sid, i, role, text) => JSON.stringify(role === 'user'
  ? { type: 'user', uuid: `u-${sid.slice(0, 4)}-${i}`, timestamp: new Date(1700000000000 + i * 60000).toISOString(), sessionId: sid, cwd, message: { role: 'user', content: [{ type: 'text', text }] } }
  : { type: 'assistant', uuid: `a-${sid.slice(0, 4)}-${i}`, timestamp: new Date(1700000000000 + i * 60000).toISOString(), sessionId: sid, cwd, message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } });
const transcript = (sid) => [rec(sid, 1, 'user', 'RESCUE-MARKER-HELLO'), rec(sid, 2, 'assistant', 'RESCUE-MARKER-REPLY'), rec(sid, 3, 'user', 'second turn'), rec(sid, 4, 'assistant', 'done')].join('\n') + '\n';

// (A) local transcript under the fake HOME's ~/.claude/projects
fs.rmSync(fakeHome, { recursive: true, force: true });
const projDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[/._]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, `${SID_LOCAL}.jsonl`), transcript(SID_LOCAL));
// (B) cached-remote transcript ONLY in data/remote-jsonl (host machine "down")
const cacheDir = path.join(wt, 'data', 'remote-jsonl', 'host-deadbeef');
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, `${SID_CACHED}.jsonl`), transcript(SID_CACHED));

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=/tmp/vs-attach-rescue-chrome-${process.pid}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(`/tmp/vs-attach-rescue-chrome-${process.pid}`, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

// ── raw CDP ─────────────────────────────────────────────────────────────────
const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { await sleep(250); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// A replayed dead-serverId window's end state, probed via the chat DOM.
const winState = (winId) => evalJs(`(() => {
  const w = app.wm.windows.get(${JSON.stringify(winId)});
  if (!w) return { gone: true };
  const el = w.element;
  return {
    msgs: el.querySelectorAll('.chat-msg').length,
    text: (el.querySelector('.chat-messages') || el).textContent.slice(0, 4000),
    resumeBar: !!el.querySelector('.chat-resume-bar'),
    resumeBtn: !!el.querySelector('.chat-resume-btn'),
    subNote: !!el.querySelector('.chat-subagent-note'),
  };
})()`);
let deadSeq = 990;
const replayDead = (bsid, name) => evalJs(`(() => {
  const before = new Set(app.wm.windows.keys());
  app.replayOpenSpec({ action: 'attachSession', serverId: 'sess-${++deadSeq}-dead', backendSessionId: ${JSON.stringify(bsid)},
    cwd: ${JSON.stringify(cwd)}, mode: 'chat', backend: 'claude', name: ${JSON.stringify(name)} });
  return [...app.wm.windows.keys()].find((id) => !before.has(id)) || null;
})()`);

try {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  ws.on('message', (d) => { const m = JSON.parse(d);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('  [console.error]', m.params.args.map(a=>a.value||a.description||'').join(' ').slice(0,300));
    if (m.method === 'Runtime.exceptionThrown') console.log('  [exception]', (m.params.exceptionDetails.exception?.description||'').slice(0,300));
  });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await evalJs('new Promise(r => { const t = setInterval(() => { if (window.app) { clearInterval(t); r(); } }, 100); })');
  await evalJs('app.ready');

  // A: dead serverId, transcript in the local ~/.claude/projects
  const wA = await replayDead(SID_LOCAL, 'rescue-local');
  check('A: replay created a window', !!wA);
  await sleep(2500);
  const stA = await winState(wA);
  check('A: history rendered (not blank)', stA.msgs >= 4, `msgs=${stA.msgs}`);
  check('A: transcript content visible', stA.text.includes('RESCUE-MARKER-HELLO') && stA.text.includes('RESCUE-MARKER-REPLY'));
  check('A: Resume bar shown', stA.resumeBar);

  // B: dead serverId, NO host in the spec, transcript only in remote-jsonl cache
  const wB = await replayDead(SID_CACHED, 'rescue-cached');
  await sleep(2500);
  const stB = await winState(wB);
  check('B: host-less cached-remote rescue renders history', stB.msgs >= 4, `msgs=${stB.msgs}`);
  check('B: cached transcript content visible', stB.text.includes('RESCUE-MARKER-REPLY'));
  check('B: Resume bar shown', stB.resumeBar);

  // C: dead serverId, no transcript anywhere — degrade gracefully, no loop
  const wC = await replayDead(SID_GONE, 'rescue-none');
  await sleep(2500);
  const stC = await winState(wC);
  check('C: no-transcript window degrades to read-only notice', stC.resumeBar && !/RESCUE-MARKER/.test(stC.text) && /No messages/.test(stC.text), JSON.stringify(stC).slice(0, 200));
  check('C: Resume BUTTON offered on a primary view', stC.resumeBtn);

  // D: a sub-agent's own conversation opened from its parent (codex collab
  // child / claude Task viewer path through viewSession with agentKind
  // 'subagent'): history renders, NO 'Resume this session' button — a note
  // explains it ran inside the parent (owner report 2026-09-07).
  const wD = await evalJs(`(() => {
    const before = new Set(app.wm.windows.keys());
    app.viewSession(${JSON.stringify(SID_LOCAL)}, ${JSON.stringify(cwd)}, 'sub-view', { backend: 'claude', backendSessionId: ${JSON.stringify(SID_LOCAL)}, agentKind: 'subagent', sourceKind: 'subagent' });
    return [...app.wm.windows.keys()].find((id) => !before.has(id)) || null;
  })()`);
  await sleep(2500);
  const stD = await winState(wD);
  check('D: sub-agent view renders history', stD.msgs >= 4, `msgs=${stD.msgs}`);
  check('D: sub-agent view has NO Resume button', !stD.resumeBtn, JSON.stringify(stD).slice(0, 200));
  check('D: sub-agent view explains read-only', stD.subNote && /Sub-agent conversation/.test(stD.text));
  // E (negative control): the same transcript viewed as a PRIMARY session keeps its Resume button.
  const wE = await evalJs(`(() => {
    const before = new Set(app.wm.windows.keys());
    app.viewSession(${JSON.stringify(SID_CACHED)}, ${JSON.stringify(cwd)}, 'primary-view', { backend: 'claude', backendSessionId: ${JSON.stringify(SID_CACHED)} });
    return [...app.wm.windows.keys()].find((id) => !before.has(id)) || null;
  })()`);
  await sleep(2500);
  const stE = await winState(wE);
  check('E: primary view keeps the Resume button', stE.resumeBtn && !stE.subNote, JSON.stringify(stE).slice(0, 200));
} catch (e) {
  failed++;
  console.error('  ✗ harness error: ' + e.message);
}

console.log(failed ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed ? 1 : 0);
