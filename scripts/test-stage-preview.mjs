#!/usr/bin/env node
// Stage × desktop-preview regression smoke (task #131, 2.150.x):
//  BUG 1 (ghost): a stage-borrowed hero must render in its HOME desktop's
//    preview at its HOME bounds — the first fix read `_stageHomeBounds?.gridBounds`
//    but _stageHomeBounds IS the flat bounds object, so the slot geometry leaked.
//  BUG 2 (blank): right after stage.leave() the ACTIVE desktop's preview must
//    have window rects — leave()'s setGrid fired an intermediate render while
//    every target window was still _hiddenByDesktop and the digest (which didn't
//    cover hidden flags) cached the blank render.
// Runs a THROWAWAY server in a git worktree (own data dir — never touches a
// live instance) + headless chrome over raw CDP. Requires google-chrome.
// Run: node scripts/test-stage-preview.mjs
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
const wt = scratch('stage-smoke');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── throwaway server in a worktree ──────────────────────────────────────────
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// uncommitted fix under test: copy the working-tree client sources + bundle
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('stage-smoke-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  // dtach sessions spawned by the throwaway (shell terminal) — kill by socket dir
  try {
    const socks = fs.readdirSync(path.join(wt, 'data', 'sockets'));
    for (const s of socks) { try { execSync(`pkill -f ${JSON.stringify(path.join(wt, 'data', 'sockets', s))}`); } catch {} }
  } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('stage-smoke-chrome'), { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// wait for server
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

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  // enable the stage + settle
  await evalJs(`app.settings.set('desktop.dynamicEnabled', true)`);
  await sleep(600);
  check('stage enabled', await evalJs('!!(app.stage && app.stage.enabled)'));

  // one shell terminal window on the home desktop at a KNOWN position
  await evalJs(`app.openShellTerminal(${JSON.stringify(wt)})`);
  let winId = null;
  for (let i = 0; i < 40 && !winId; i++) {
    winId = await evalJs(`[...app.wm.windows.values()].find(w => w.type === 'terminal')?.id || null`);
    if (!winId) await sleep(300);
  }
  check('terminal window opened', !!winId);
  const HOME = { left: 0.1, top: 0.1, width: 0.3, height: 0.3 };
  await evalJs(`(() => { const w = app.wm.windows.get(${JSON.stringify(winId)});
    w.gridBounds = ${JSON.stringify(HOME)}; app.wm._applyGridBounds(w);
    app.desktopManager.refreshSwitcher(); return true; })()`);
  await sleep(300);

  const rectOf = (id) => evalJs(`(() => {
    const rs = [...document.querySelectorAll('.desktop-preview:not(.stage-preview) .desktop-preview-win')];
    const r = rs.find((el) => el.dataset.winId === ${JSON.stringify(id)});
    return r ? { left: r.style.left, top: r.style.top } : null; })()`);
  const base = await rectOf(winId);
  check('baseline: home preview draws the window at home bounds', !!base && base.left === '10%', JSON.stringify(base));

  // ── enter stage + materialize the terminal as hero ──
  await evalJs('app.stage.enter()');
  await sleep(500);
  await evalJs(`app.wm.focusWindow(${JSON.stringify(winId)})`);
  for (let i = 0; i < 20; i++) {
    if (await evalJs(`!!app.wm.windows.get(${JSON.stringify(winId)})?._onStage`)) break;
    await sleep(250);
  }
  check('hero materialized on the stage', await evalJs(`!!app.wm.windows.get(${JSON.stringify(winId)})?._onStage`));
  const slotLeft = await evalJs('app.stage.slotBounds().left');
  await evalJs('app.desktopManager.refreshSwitcher()');
  await sleep(300);
  // BUG 1: the home desktop's preview must draw the borrowed hero at HOME bounds
  const staged = await rectOf(winId);
  check('GHOST FIX: staged hero renders at HOME bounds in home preview', !!staged && staged.left === '10%',
    `rect=${JSON.stringify(staged)} slotLeft=${slotLeft}`);
  check('…and NOT at the slot position', !staged || staged.left !== (slotLeft * 100) + '%', JSON.stringify(staged));

  // ── leave back to the home desktop ──
  const deskId = await evalJs('app.desktopManager.desktops[0].id');
  await evalJs(`app.stage.leave(${JSON.stringify(deskId)})`);
  // IMMEDIATE assertion (no settle sleep): the blank bug cached an empty preview
  const rightAfter = await evalJs(`(() => {
    const pv = [...document.querySelectorAll('.desktop-preview:not(.stage-preview)')].find((p) => p.classList.contains('active'));
    return pv ? pv.querySelectorAll('.desktop-preview-win').length : -1; })()`);
  check('BLANK FIX: active desktop preview has window rects right after leave()', rightAfter >= 1, `rects=${rightAfter}`);
  const backHome = await rectOf(winId);
  check('hero back at home bounds in preview after leave', !!backHome && backHome.left === '10%', JSON.stringify(backHome));
  check('hero window visible again', await evalJs(`(() => { const w = app.wm.windows.get(${JSON.stringify(winId)});
    return !!w && !w._hiddenByDesktop && !w._hiddenByStage && w.element.style.visibility !== 'hidden'; })()`));
} catch (e) {
  failed++; console.error('  ✗ harness threw:', e.message);
} finally {
  try { ws.close(); } catch {}
}

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nstage preview smoke passed — no ghost at slot position, no blank preview after leave');
process.exit(0);
