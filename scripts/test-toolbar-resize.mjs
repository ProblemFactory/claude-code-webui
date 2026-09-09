#!/usr/bin/env node
// Toolbar-resize persistence smoke (2.252.1 — the 2.250.1 snap-back rootfix).
// The bug: cssDefault()/def read the COMPUTED --toolbar-height, which the drag
// (and any saved override) itself sets — so the "within 2px of default ⇒
// reset" check compared the dragged height against ITSELF and reset on every
// mouseup / restore-apply. This smoke drives a REAL drag via CDP mouse events
// and asserts the height survives mouseup, reload, and a same-value re-apply.
// Throwaway server in a git worktree + headless chrome (test-sidebar-rail
// harness pattern). Run: node scripts/test-toolbar-resize.mjs
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
const wt = scratch('tbresize-smoke');
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
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('tbresize-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('tbresize-chrome'), { recursive: true, force: true }); } catch {}
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
const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const toolbarH = () => evalJs(`document.getElementById('toolbar').offsetHeight`);
// A REAL drag on the handle: press, move in steps (rAF-coalesced handlers need
// real successive events), release.
const dragHandle = async (dy) => {
  const r = await evalJs(`(() => { const h = document.getElementById('toolbar-resize-handle').getBoundingClientRect(); return { x: h.left + h.width / 2, y: h.top + h.height / 2 }; })()`);
  await mouse('mousePressed', r.x, r.y);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', r.x, r.y + (dy * i) / 6); await sleep(30); }
  await mouse('mouseReleased', r.x, r.y + dy);
  await sleep(200);
};

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  await sleep(500);

  // 2.254.0 SCALE MODEL: the toolbar height auto-fits content; the handle
  // drives --toolbar-scale (zoom on #toolbar + #toolbar-row2). Truth metric =
  // RENDERED height (getBoundingClientRect) + workspace absorption.
  const rendered = () => evalJs(`Math.round(document.getElementById('toolbar').getBoundingClientRect().height)`);
  const workspaceH = () => evalJs(`document.getElementById('workspace').offsetHeight`);
  const scaleVar = () => evalJs(`document.documentElement.style.getPropertyValue('--toolbar-scale')`);

  const h0 = await rendered(); const ws0 = await workspaceH();
  check('handle exists', await evalJs(`!!document.getElementById('toolbar-resize-handle')`));

  // drag DOWN → scale up → toolbar renders taller, workspace shrinks
  await dragHandle(80);
  const h1 = await rendered(); const ws1 = await workspaceH();
  check(`drag down scales the toolbar UP and it sticks (${h0} → ${h1})`, h1 > h0 + 5);
  check('workspace shrank by the toolbar delta', ws0 - ws1 >= (h1 - h0) - 3);
  check('scale persisted to localStorage', await evalJs(`parseFloat(localStorage.getItem('toolbarScale')) > 1.05`));
  const s1 = await evalJs(`parseFloat(localStorage.getItem('toolbarScale'))`);

  // same-value re-apply is a no-op (restore/sync path)
  await evalJs(`app.layoutManager._applyToolbarScale(${s1})`);
  await sleep(100);
  check('re-applying the same scale does not reset', Math.abs((await rendered()) - h1) <= 1);

  // NO DEAD BAND: the toolbar's rendered height ≈ scale × content height —
  // an empty gap would make rendered >> content. Compare against row content.
  const noBand = await evalJs(`(() => {
    const tb = document.getElementById('toolbar');
    const inner = Math.max(...[...tb.children].map(c => c.getBoundingClientRect().height), 0);
    return { outer: tb.getBoundingClientRect().height, inner };
  })()`);
  check(`no dead band (outer ${Math.round(noBand.outer)} ≈ content+pad, inner ${Math.round(noBand.inner)})`, noBand.outer - noBand.inner < 30);

  // cross-desktop broadcast applies the scale (2.252.2 invariant, scale edition)
  await evalJs(`app.layoutManager._handleRemoteSync({ desktopId: 'not-the-active-desktop', state: { toolbarScale: 0.8, windows: [] } })`);
  await sleep(150);
  check('non-active-desktop broadcast applies the scale', (await rendered()) < h0);
  // legacy fixed-height state migrates (toolbarHeight 64 → scale 1.25-capped 1.6)
  await evalJs(`app.layoutManager._handleRemoteSync({ desktopId: 'not-the-active-desktop', state: { toolbarHeight: 64, windows: [] } })`);
  await sleep(150);
  check('legacy toolbarHeight state migrates to a scale', parseFloat(await scaleVar()) > 1.1);
  // an OLD-bundle client echoes its fixed default (40) on every autosave —
  // that is NO information, it must NOT erase the fleet's scale (review catch)
  await evalJs(`app.layoutManager._handleRemoteSync({ desktopId: 'not-the-active-desktop', state: { toolbarHeight: 40, windows: [] } })`);
  await sleep(150);
  check('legacy default (40) echo does NOT erase the scale', parseFloat(await scaleVar()) > 1.1);
  // companion legacy field rides captureState so old bundles can track + round-trip
  check('captureState emits the companion legacy toolbarHeight', await evalJs(`(() => { const st = app.layoutManager.captureState(); return typeof st.toolbarHeight === 'number' && Math.abs(st.toolbarHeight - Math.round(40 * (st.toolbarScale || 1))) <= 1; })()`));
  // absurd values clamp
  await evalJs(`app.layoutManager._applyToolbarScale(500)`);
  await sleep(100);
  check('absurd value clamps to the range', parseFloat(await scaleVar()) <= 1.25);
  // a remote RESET (explicit toolbarScale:null in the state) must propagate —
  // skipping null left other clients scaled forever after a dblclick reset
  await evalJs(`app.layoutManager._handleRemoteSync({ desktopId: 'not-the-active-desktop', state: { toolbarScale: null, windows: [] } })`);
  await sleep(150);
  check('remote reset (null) propagates', (await scaleVar()) === '');
  await evalJs(`app.layoutManager._applyToolbarScale(${s1})`);
  await sleep(2800); // let the autosave land before reload

  // survives a reload (localStorage boot restore)
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('app.ready');
  await sleep(500);
  check('scale survives reload', Math.abs((await rendered()) - h1) <= 2);

  // theme switch must NOT wipe the override (2.252.1 third leg, scale edition)
  await evalJs(`app.themeManager.apply('nord')`);
  await sleep(200);
  check('theme switch keeps the scale', Math.abs((await rendered()) - h1) <= 2);
  await evalJs(`app.themeManager.apply('dark')`);

  // dblclick resets to default
  await evalJs(`document.getElementById('toolbar-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(200);
  check(`dblclick resets to default (${h0})`, Math.abs((await rendered()) - h0) <= 1);
  check('reset cleared localStorage', await evalJs(`localStorage.getItem('toolbarScale') === null`));

  // drag away then back to ~default clears the override
  await dragHandle(60);
  await dragHandle(-60);
  check('drag back to default clears the override', await evalJs(`localStorage.getItem('toolbarScale') === null && document.documentElement.style.getPropertyValue('--toolbar-scale') === ''`));

  // BOOT DIVERGENCE (review catch): the server state carries the reset
  // (toolbarScale null after the resets above, persisted by the autosaves);
  // a client with a STALE localStorage must not resurrect the erased scale
  // at boot — the loadAutoSave heal applies the explicit-null reset even
  // when restoreState is skipped (no windows).
  // The 5s post-load _restoring window suppresses autosaves (deliberate) —
  // the resets above happened inside it. Wait it out, re-trigger the reset
  // with a REAL interaction, and give the debounce time to send.
  await sleep(6000);
  await evalJs(`document.getElementById('toolbar-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await evalJs(`document.dispatchEvent(new Event('pointerdown'))`); // arm _userDirty (capture listener)
  await evalJs(`app.layoutManager.scheduleAutoSave()`);
  await sleep(1500); // debounce + send + server write
  await evalJs(`localStorage.setItem('toolbarScale', '1.2')`);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('app.ready');
  await sleep(500);
  check('stale localStorage does NOT resurrect an erased scale at boot', Math.abs((await rendered()) - h0) <= 1, 'rendered=' + (await rendered()));
} catch (e) {
  failed++;
  console.error('  ✗ harness error: ' + e.message);
}

ws.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS (18)');
process.exit(failed ? 1 : 0);
