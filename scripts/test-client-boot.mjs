#!/usr/bin/env node
// CLIENT BOOT SMOKE (2.336.1, owner: "以后别又出现你给我更新完我打不开"). The
// "打不开" failure has TWO faces: the server won't boot (restore-smoke covers
// it) and the FRONTEND dies on the loading screen (2.330.0/2.330.1 — a client
// boot crash leaves the splash forever; the only guard was the STATIC
// free-variable check, which can only catch the one mechanism it models).
// This boots the real app in headless chrome against a worktree server and
// asserts what the user actually needs: app.ready resolves, the splash is
// GONE, the ws is open, and no uncaught exception fired during boot.
// NEGATIVE CONTROL: corrupt the worktree's bundle the way 2.330.0 shipped
// (a throwing statement at the top), reload, assert this probe goes RED.
// Run: node scripts/test-client-boot.mjs   (SKIPs cleanly without chrome)
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

// FREE ports (2.369.46): two gates on one box used to collide on 3993/9343 — the
// suite then waited 5–10 min on someone else's server/chrome and the gate read RED for 'load'.
const PORT = await freePort(), CDP_PORT = await freePort();
const wt = `/tmp/vs-client-boot-${process.pid}`;
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// WORKING-TREE overlay (same rule as restore-smoke: a worktree checks out
// HEAD, and a pre-commit run must test what is about to ship, not the past)
for (const f of ['src', 'public', 'server.js', 'package.json']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
// --no-sandbox + --disable-dev-shm-usage: the canonical CI flags — GitHub
// runners have a tiny /dev/shm and chrome cold-starts slowly there (the
// first Actions run died with a bare null-target TypeError at 10s)
const chromeLog = [];
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage',
  `--user-data-dir=/tmp/vs-client-boot-chrome-${process.pid}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (d) => { if (chromeLog.length < 40) chromeLog.push(d.toString()); });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(`/tmp/vs-client-boot-chrome-${process.pid}`, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
// the gate's timeout kills us with SIGTERM — without these the worktree server + chrome outlive the suite (72 stale /tmp/vs-client-boot-* dirs found on 2026-09-06)
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(143); });

for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page'); }
  catch { }
  if (!target) await sleep(250);
}
if (!target) {
  console.error('✗ chrome never exposed a CDP page target (30s)\n' + chromeLog.join('').slice(0, 1500));
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
const pageErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    try { pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown'); } catch {}
  }
});
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
await cdp('Runtime.enable');
await cdp('Page.enable');

// ── phase 1: the shipped client must reach the workspace ──
async function bootProbe(cacheBust) {
  pageErrors.length = 0;
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/${cacheBust ? '?cb=' + cacheBust : ''}` });
  let ready = false;
  // budget ~60s: the gate runs this right after a real chat turn on a box that
  // also hosts live agent sessions — a slow boot is not a broken boot (two
  // gate-only reds at 24s in 2.369.30/.33 while standalone passed in <10s)
  for (let i = 0; i < 180; i++) {
    ready = await evaljs(`(async () => { if (!window.app || !window.app.ready) return false; await Promise.race([window.app.ready, new Promise(r => setTimeout(r, 100))]); return !!document.querySelector('.sidebar'); })()`).catch(() => false);
    if (ready) break;
    await sleep(300);
  }
  // the splash fades AFTER app.ready (opacity→0, removed 300ms later) — poll
  let splashGone = false;
  for (let i = 0; i < 40 && !splashGone; i++) {
    splashGone = await evaljs(`(() => { const s = document.getElementById('loading-screen'); return !s || s.style.opacity === '0'; })()`).catch(() => false);
    if (!splashGone) await sleep(300);
  }
  const wsOpen = await evaljs(`window.app?.ws?.ws?.readyState === 1`).catch(() => false);
  return { ready: !!ready, splashGone: !!splashGone, wsOpen: !!wsOpen, errors: pageErrors.slice() };
}

const good = await bootProbe();
check('app.ready resolves and the workspace renders', good.ready);
check('loading screen is gone (the 2.330.x symptom)', good.splashGone);
check('client websocket is OPEN', good.wsOpen);
check('zero uncaught exceptions during boot', good.errors.length === 0, good.errors.slice(0, 3).join(' | '));

// ── phase 2: NEGATIVE CONTROL — ship the 2.330.0 shape, probe must go RED ──
const bundlePath = path.join(wt, 'public', 'bundle.js');
const orig = fs.readFileSync(bundlePath);
fs.writeFileSync(bundlePath, 'someUndefinedBootSymbol();\n' + orig);
const bad = await bootProbe(Date.now());
check('NEGATIVE CONTROL: broken bundle → app never becomes ready', !bad.ready);
check('NEGATIVE CONTROL: the boot crash is captured as an exception', bad.errors.some((e) => /someUndefinedBootSymbol/.test(e)), bad.errors.join(' | ').slice(0, 200));
fs.writeFileSync(bundlePath, orig);

ws.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS (6)');
process.exit(failed ? 1 : 0);
