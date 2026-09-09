#!/usr/bin/env node
// GHOST-HOST SELF-HEAL (2.334.1, real fleet report): a persisted Recent/History
// host selection whose host record was REMOVED left the switcher <select>
// rendering BLANK (a value with no matching option) and the whole zone bricked
// on "发现失败: host not found" + 无法连接 chips forever — with no visible
// affordance hinting that flipping the (blank) dropdown back to Local was the
// fix. This drives the REAL sidebar render in a worktree server + headless
// chrome: plant a ghost id in localStorage, render, assert the zone healed to
// Local and the persisted keys cleared. Negative control: a transient roster
// failure (hosts data absent) must NOT wipe the selection.
// Run: node scripts/test-ghost-host-heal.mjs
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
const wt = scratch('ghost-host-smoke');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('ghost-host-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('ghost-host-chrome'), { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

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
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
await cdp('Runtime.enable');
await cdp('Page.enable');

// plant the ghost BEFORE the app boots (the incident shape: stale localStorage)
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(800);
await evaljs(`(() => { localStorage.setItem('wbRecentHost', 'ghost-host-id'); localStorage.setItem('wbHistoryHost', 'ghost-host-id'); return 1; })()`);
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 60; i++) { if (await evaljs('!!(window.app && window.app.sidebar && window.app.sidebar.listEl)').catch(() => false)) break; await sleep(400); }
await evaljs(`(() => { window.app.sidebar.toggle(true); return 1; })()`);
await sleep(1500); // roster fetch + heal render pass

const st = await evaljs(`(() => {
  const sb = window.app.sidebar;
  sb._render();
  const sel = document.querySelector('.wb-recent-host');
  return {
    recentMem: sb._wbRecentHost, histMem: sb._wbHistoryHost,
    recentLs: localStorage.getItem('wbRecentHost'), histLs: localStorage.getItem('wbHistoryHost'),
    rosterLoaded: Array.isArray(sb._hostsData?.hosts),
    selValue: sel ? sel.value : null,
    bodyHasGhostError: document.body.textContent.includes('host not found'),
  };
})()`);
check('roster loaded (precondition)', st.rosterLoaded, JSON.stringify(st));
check('ghost Recent selection healed to Local (memory)', st.recentMem === '', JSON.stringify(st));
check('ghost History selection healed to Local (memory)', st.histMem === '', JSON.stringify(st));
check('localStorage keys cleared', st.recentLs === '' && st.histLs === '', JSON.stringify(st));
check('no "host not found" error rendered after heal', !st.bodyHasGhostError, '');
check('switcher (if rendered) shows Local, never blank', st.selValue === null || st.selValue === '', JSON.stringify(st.selValue));

// NEGATIVE CONTROL: with the roster NOT loaded, the heal must keep the pick
const neg = await evaljs(`(() => {
  const sb = window.app.sidebar;
  sb._hostsData = null; // simulate a transient /api/hosts failure window
  sb._wbRecentHost = 'still-mine';
  const v = sb._wbValidHost('still-mine', 'wbRecentHost', '_wbRecentHost');
  return { v, mem: sb._wbRecentHost };
})()`);
check('NEGATIVE CONTROL: unloaded roster keeps the selection', neg.v === 'still-mine' && neg.mem === 'still-mine', JSON.stringify(neg));

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS (7)');
process.exit(failed ? 1 : 0);
