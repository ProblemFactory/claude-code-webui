#!/usr/bin/env node
// Zero-local-sessions + a configured remote host must still render the
// workbench with its Recent host switcher (2.186.8, real report: a fresh
// instance with a remote machine full of sessions showed only "No sessions" —
// the early-return fired before the workbench's host switchers ever rendered,
// so the remote sessions were unreachable from the UI).
// Throwaway server in a git worktree (own data dir + EMPTY fake HOME so local
// discovery finds nothing) + headless chrome over raw CDP.
// Run: node scripts/test-sidebar-empty-remote.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { freePorts, scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('emptyremote-smoke');
const fakeHome = scratch('emptyremote-home');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── throwaway server in a worktree, empty HOME, one fake host ───────────────
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });
fs.rmSync(fakeHome, { recursive: true, force: true });
fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
fs.writeFileSync(path.join(wt, 'data', 'hosts.json'), JSON.stringify({
  hosts: [{ id: 'host-smoke01', name: 'SmokeBox', user: 'nobody', host: '127.0.0.1', port: 2, createdAt: Date.now() }],
}));

const srv = spawn(process.execPath, ['server.js'], {
  cwd: wt,
  env: { ...process.env, PORT: String(PORT), HOME: fakeHome },
  stdio: 'ignore',
});
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(`${wt}-chrome`, { recursive: true, force: true }); } catch {}
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
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evl = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
};

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);

  // The first paint may legitimately early-return ("No sessions") while
  // /api/hosts is in flight — _ensureHostsData re-renders. Poll for the heal.
  let healed = false;
  for (let i = 0; i < 24 && !healed; i++) {
    healed = await evl(`!!document.querySelector('#all-sessions-list .wb-recent-host')`);
    if (!healed) await sleep(500);
  }
  check('workbench renders with a host switcher despite zero local sessions', healed);
  check('the early-return empty state is gone', !(await evl(
    `[...document.querySelectorAll('#all-sessions-list .empty-hint')].some(e => e.textContent.trim() === 'No sessions')`)));
  check('zone heads render (Active/Recent/History)', (await evl(
    `document.querySelectorAll('#all-sessions-list .wb-zone-head').length`)) >= 2);
  check('the switcher lists the configured host', await evl(
    `[...document.querySelectorAll('#all-sessions-list .wb-recent-host option')].some(o => o.textContent === 'SmokeBox')`));

  // Switching to the host must not crash the render (discovery will fail —
  // port 2 — but the workbench should keep its structure).
  await evl(`(() => { const s = document.querySelector('#all-sessions-list .wb-recent-host'); s.value = 'host-smoke01'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  check('render survives switching to the (unreachable) host', (await evl(
    `document.querySelectorAll('#all-sessions-list .wb-zone-head').length`)) >= 2);
} catch (e) {
  failed++; console.error('  ✗ threw:', e.stack || e.message);
}
ws.close();
console.log(failed ? `\n${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
