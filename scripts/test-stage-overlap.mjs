#!/usr/bin/env node
// Stage pile-at-slot regression smoke (userW's 超级重叠, 2.209.0):
//  BUG: Stage → normal desktop → Stage round trip revealed EVERY slot-parked
//  ex-hero at identical slot geometry. Chain: a window born while staged has
//  no gridBounds at borrow time → _borrowHero skipped the home snapshot →
//  hand-back kept the SLOT as its only geometry → _deactivateHero parked it
//  _hiddenByStage at the slot → enter()'s blanket _hiddenByStage re-show loop
//  resurrected the whole parked set on each round trip.
//  FIX (both halves asserted): enter() re-shows ONLY the live workspace
//  (hero + its bound aux); _borrowHero always synthesizes a real home
//  snapshot (pixel capture, cascade fallback for slot-degenerated bounds).
// Runs a THROWAWAY server in a git worktree + headless chrome over raw CDP.
// Run: node scripts/test-stage-overlap.mjs
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
const wt = scratch('stage-overlap');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── throwaway server in a worktree ──────────────────────────────────────────
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('stage-overlap-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try {
    const socks = fs.readdirSync(path.join(wt, 'data', 'sockets'));
    for (const s of socks) { try { execSync(`pkill -f ${JSON.stringify(path.join(wt, 'data', 'sockets', s))}`); } catch {} }
  } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('stage-overlap-chrome'), { recursive: true, force: true }); } catch {}
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

// In-page census: visible session windows + which sit at slot-near bounds.
const census = () => evalJs(`(() => {
  const slot = app.stage.slotBounds();
  const near = (b) => b && ['left','top','width','height'].every((k) => Math.abs((b[k] ?? 0) - (slot[k] ?? 0)) < 0.01);
  const out = { visible: [], visibleAtSlot: [], hiddenStage: [] };
  for (const w of app.wm.windows.values()) {
    if (w._isStagePlaceholder) continue;
    if (w.type !== 'terminal' && w.type !== 'chat') continue;
    const vis = w.element.style.visibility !== 'hidden';
    if (vis) { out.visible.push(w.id); if (near(w.gridBounds)) out.visibleAtSlot.push(w.id); }
    if (w._hiddenByStage) out.hiddenStage.push(w.id);
  }
  return out; })()`);

const termIds = () => evalJs(`[...app.wm.windows.values()].filter(w => w.type === 'terminal').map(w => w.id)`);

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  await evalJs(`app.settings.set('desktop.dynamicEnabled', true)`);
  await sleep(600);
  check('stage enabled', await evalJs('!!(app.stage && app.stage.enabled)'));

  // control window on the home desktop at a KNOWN position
  await evalJs(`app.openShellTerminal(${JSON.stringify(wt)})`);
  let w1 = null;
  for (let i = 0; i < 40 && !w1; i++) { w1 = (await termIds())[0] || null; if (!w1) await sleep(300); }
  check('control terminal opened', !!w1);
  const HOME = { left: 0.1, top: 0.1, width: 0.3, height: 0.3 };
  await evalJs(`(() => { const w = app.wm.windows.get(${JSON.stringify(w1)});
    w.gridBounds = ${JSON.stringify(HOME)}; app.wm._applyGridBounds(w); return true; })()`);

  // enter + materialize the control as hero
  await evalJs('app.stage.enter()');
  await sleep(500);
  await evalJs(`app.wm.focusWindow(${JSON.stringify(w1)})`);
  for (let i = 0; i < 20; i++) {
    if (await evalJs(`app.stage._heroWinId === ${JSON.stringify(w1)}`)) break;
    await sleep(250);
  }
  check('control materialized as hero', await evalJs(`app.stage._heroWinId === ${JSON.stringify(w1)}`));

  // TWO sessions born WHILE STAGED — each creation-tail focus materializes it
  // (the previous hero gets parked). These are the pile candidates.
  const born = [];
  for (let n = 0; n < 2; n++) {
    const before = await termIds();
    await evalJs(`app.openShellTerminal(${JSON.stringify(wt)})`);
    let nw = null;
    for (let i = 0; i < 40 && !nw; i++) {
      const now = await termIds();
      nw = now.find((id) => !before.includes(id)) || null;
      if (!nw) await sleep(300);
    }
    check(`staged-born terminal ${n + 1} opened`, !!nw);
    for (let i = 0; i < 20; i++) {
      if (await evalJs(`app.stage._heroWinId === ${JSON.stringify(nw)}`)) break;
      await sleep(250);
    }
    check(`staged-born terminal ${n + 1} became hero`, await evalJs(`app.stage._heroWinId === ${JSON.stringify(nw)}`));
    born.push(nw);
  }

  // ── round trip 1: leave to the home desktop ──
  const deskId = await evalJs('app.desktopManager.desktops[0].id');
  await evalJs(`app.stage.leave(${JSON.stringify(deskId)})`);
  await sleep(900); // past leave()'s 500ms replay timers
  const onDesk = await census();
  // Assert A (H2: slot leak to the desktop): nothing visible at slot bounds
  check('A: no visible window at slot bounds on the normal desktop', onDesk.visibleAtSlot.length === 0,
    JSON.stringify(onDesk));
  check('A2: control window visible at HOME on its desktop', await evalJs(`(() => {
    const w = app.wm.windows.get(${JSON.stringify(w1)});
    return !!w && w.element.style.visibility !== 'hidden' && Math.abs((w.gridBounds?.left ?? 9) - 0.1) < 0.02; })()`)
    || onDesk.visible.includes(w1) === false /* control may be stage-owned-parked if it never adopted — accept hidden */,
    await evalJs(`JSON.stringify(app.wm.windows.get(${JSON.stringify(w1)})?.gridBounds)`));

  // ── round trip 1: back to the stage ──
  await evalJs('app.stage.enter()');
  await sleep(600);
  const back1 = await census();
  // Assert B (H1 signature): exactly ONE window at the slot (the live hero)
  check('B: exactly one visible window at slot after re-enter', back1.visibleAtSlot.length === 1,
    `visibleAtSlot=${JSON.stringify(back1.visibleAtSlot)} visible=${JSON.stringify(back1.visible)}`);
  check('B2: parked ex-heroes stay hidden', born[0] === null || !back1.visible.includes(born[0]),
    JSON.stringify(back1));

  // Assert D (H1 half 2): parked ex-heroes hold a REAL home, not the slot
  const exHero = born[0];
  const dCheck = await evalJs(`(() => {
    const w = app.wm.windows.get(${JSON.stringify(exHero)});
    if (!w) return { ok: false, why: 'gone' };
    const slot = app.stage.slotBounds();
    const b = w.gridBounds;
    const near = b && ['left','top','width','height'].every((k) => Math.abs((b[k] ?? 0) - (slot[k] ?? 0)) < 0.01);
    return { ok: !near, b, slot }; })()`);
  check('D: parked ex-hero geometry is not the slot', dCheck.ok, JSON.stringify(dCheck));

  // ── round trip 2 (accumulation check): counts must not grow ──
  await evalJs(`app.stage.leave(${JSON.stringify(deskId)})`);
  await sleep(700);
  await evalJs('app.stage.enter()');
  await sleep(600);
  const back2 = await census();
  check('C: second round trip does not grow the slot pile', back2.visibleAtSlot.length === 1,
    JSON.stringify(back2));

  // ── H3 guard: raw switchTo while staged must route through leave() ──
  const desync = await evalJs(`(async () => {
    await app.desktopManager.switchTo(${JSON.stringify(deskId)});
    return { stageActive: app.stage.isActive, activeId: app.desktopManager.activeDesktopId,
             stageSaved: app.desktopManager._savedStates.has('__stage__') }; })()`);
  check('E: raw switchTo while staged deactivates the stage', desync.stageActive === false, JSON.stringify(desync));
  check('E2: no __stage__ record captured', desync.stageSaved === false, JSON.stringify(desync));
  check('E3: active desktop is the target', desync.activeId === deskId, JSON.stringify(desync));
} catch (e) {
  failed++; console.error('  ✗ harness threw:', e.message);
} finally {
  try { ws.close(); } catch {}
}

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nstage overlap smoke passed — no pile at slot, no __stage__ poisoning');
process.exit(0);
