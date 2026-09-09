#!/usr/bin/env node
// Window context-menu smoke (2.212.0): title-bar right-click = full menu with
// the "Switch window" submenu (scope setting), Rename + Task Groups on
// session windows; taskbar item right-click carries the same additions.
// Throwaway worktree server + headless chrome raw CDP (stage-smoke pattern).
// Run: node scripts/test-window-menu.mjs
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
const wt = scratch('menu-smoke');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js', 'scripts']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('menu-smoke-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try {
    const socks = fs.readdirSync(path.join(wt, 'data', 'sockets'));
    for (const s of socks) { try { execSync(`pkill -f ${JSON.stringify(path.join(wt, 'data', 'sockets', s))}`); } catch {} }
  } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('menu-smoke-chrome'), { recursive: true, force: true }); } catch {}
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

// open the title-bar menu for a window; returns { top: [top-level labels],
// switch: [submenu labels] } and leaves the menu open
const openTitleMenu = (winId) => evalJs(`(() => {
  document.querySelectorAll('[data-popover]').forEach((p) => p.remove());
  const w = app.wm.windows.get(${JSON.stringify(winId)});
  const span = w.titleBar.querySelector('.window-title') || w.titleBar;
  const r = w.titleBar.getBoundingClientRect();
  span.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 8 }));
  const menu = document.querySelector('[data-popover]');
  if (!menu) return null;
  const top = [...menu.children].filter((el) => !el.className.includes('separator')).map((el) => el.firstChild?.textContent ?? el.textContent);
  const subEl = [...menu.children].find((el) => (el.firstChild?.textContent || '').includes('Switch window'));
  const sub = subEl ? [...subEl.querySelectorAll('div > div')].map((el) => el.textContent) : null;
  return { top, sub };
})()`);

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');

  // two overlapping terminals + one far-away file explorer
  await evalJs(`app.openShellTerminal(${JSON.stringify(wt)})`);
  await evalJs(`app.openShellTerminal(${JSON.stringify(wt)})`);
  let ids = [];
  for (let i = 0; i < 40 && ids.length < 2; i++) {
    ids = await evalJs(`[...app.wm.windows.values()].filter(w => w.type === 'terminal').map(w => w.id)`);
    if (ids.length < 2) await sleep(300);
  }
  check('two terminals opened', ids.length === 2);
  const [w1, w2] = ids;
  await evalJs(`(() => {
    const a = app.wm.windows.get(${JSON.stringify(w1)}), b = app.wm.windows.get(${JSON.stringify(w2)});
    a.gridBounds = { left: 0.1, top: 0.1, width: 0.4, height: 0.4 }; app.wm._applyGridBounds(a);
    b.gridBounds = { left: 0.3, top: 0.3, width: 0.4, height: 0.4 }; app.wm._applyGridBounds(b); // overlaps a
    return true; })()`);
  // rename w2's session so its menu entry is recognizable
  await evalJs(`(() => { const w = app.wm.windows.get(${JSON.stringify(w2)}); app.wm.setTitle(w.id, 'ZWEI-TERM'); return true; })()`);

  // ── title-bar menu, default scope (overlap) ──
  const m1 = await openTitleMenu(w1);
  check('title-bar right-click opens a menu', !!m1, JSON.stringify(m1));
  check('menu has Switch window submenu', !!m1?.sub, JSON.stringify(m1?.top));
  check('overlap scope lists the overlapping terminal', (m1?.sub || []).some((s) => s.includes('ZWEI-TERM')), JSON.stringify(m1?.sub));
  check('menu has Rename', (m1?.top || []).some((s) => s.includes('Rename')), JSON.stringify(m1?.top));
  check('menu keeps Move/Minimize/Close', ['Move', 'Minimize', 'Close'].every((k) => (m1?.top || []).some((s) => s.includes(k))), JSON.stringify(m1?.top));

  // task group present → Task Groups submenu appears
  await fetch(`http://127.0.0.1:${PORT}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'menu-smoke-group' }) });
  await sleep(1200); // tasks-updated broadcast → sidebar._tasks
  const m2 = await openTitleMenu(w1);
  check('menu has Task Groups submenu (session window)', (m2?.top || []).some((s) => s.includes('Task Groups')), JSON.stringify(m2?.top));

  // ── scope: all — non-overlapping windows appear too ──
  await evalJs(`(() => { const b = app.wm.windows.get(${JSON.stringify(w2)});
    b.gridBounds = { left: 0.72, top: 0.72, width: 0.22, height: 0.22 }; app.wm._applyGridBounds(b); return true; })()`);
  const mOv = await openTitleMenu(w1);
  check('moved apart: overlap scope no longer lists it', !(mOv?.sub || []).some((s) => s.includes('ZWEI-TERM')), JSON.stringify(mOv?.sub));
  await evalJs(`app.settings.set('window.titlebarSwitchScope', 'all')`);
  await sleep(300);
  const mAll = await openTitleMenu(w1);
  check('scope=all lists the non-overlapping terminal', (mAll?.sub || []).some((s) => s.includes('ZWEI-TERM')), JSON.stringify(mAll?.sub));

  // clicking the entry focuses the target window
  await evalJs(`(() => {
    const menu = document.querySelector('[data-popover]');
    const subEl = [...menu.children].find((el) => (el.firstChild?.textContent || '').includes('Switch window'));
    const entry = [...subEl.querySelectorAll('div > div')].find((el) => el.textContent.includes('ZWEI-TERM'));
    entry.click(); return true; })()`);
  await sleep(300);
  check('clicking the submenu entry focuses the window', await evalJs(`app.wm.activeWindowId === ${JSON.stringify(w2)}`));

  // ── taskbar item right-click carries Rename too ──
  const tb = await evalJs(`(() => {
    document.querySelectorAll('[data-popover]').forEach((p) => p.remove());
    const item = document.querySelector('#taskbar-items .taskbar-item[data-win-id], #taskbar-items [data-win-id]');
    if (!item) return null;
    const r = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
    const menu = document.querySelector('[data-popover]');
    return menu ? [...menu.children].map((el) => el.firstChild?.textContent ?? el.textContent) : null; })()`);
  check('taskbar item menu has Rename', (tb || []).some((s) => s && s.includes('Rename')), JSON.stringify(tb));
  check('taskbar item menu has Task Groups', (tb || []).some((s) => s && s.includes('Task Groups')), JSON.stringify(tb));
  check('taskbar item menu has NO switch submenu (title-bar only)', !(tb || []).some((s) => s && s.includes('Switch window')), JSON.stringify(tb));
} catch (e) {
  failed++; console.error('  ✗ harness threw:', e.message);
} finally {
  try { ws.close(); } catch {}
}

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nwindow-menu smoke passed');
process.exit(0);
