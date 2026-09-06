#!/usr/bin/env node
// Sidebar activity rail smoke (task #149, 2.176.0 — docs/design-sidebar-rail.md):
// rail renders by default, panel tabs (Ports / Agents / Plugins) render into the
// sidebar list area, re-click collapses the sidebar, and turning the setting off
// live-restores the classic tab bar (and back on again restores the rail).
// Runs a THROWAWAY server in a git worktree (own data dir — never touches a
// live instance) + headless chrome over raw CDP. Requires google-chrome.
// Run: node scripts/test-sidebar-rail.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

const PORT = 3931 + (process.pid % 20), CDP_PORT = 9311 + (process.pid % 20);
const wt = `/tmp/vs-rail-smoke-${process.pid}`;
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── throwaway server in a worktree ──────────────────────────────────────────
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// NO rebuild here (2.355.0, gate-admission diet): the overlay copies the
// repo's ALREADY-BUILT public/ (bundle.js included) — same rule as
// test-client-boot/test-restore-smoke. The gate's step 1 built it; a
// standalone run tests whatever `npm run build` last produced.
for (const f of ['src', 'public', 'server.js', 'package.json']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', // GH runners: tiny /dev/shm (the client-boot lesson)
  '--disable-background-timer-throttling', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(`${wt}-chrome`, { recursive: true, force: true }); } catch {}
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

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  await sleep(800); // rail builds on a constructor setTimeout + settings load

  // default ON: rail present, classic tab bar hidden
  check('rail renders by default', await evalJs(`!!document.getElementById('sidebar-rail')`));
  check('rail has 10 items', await evalJs(`document.querySelectorAll('#sidebar-rail .rail-item').length === 10`)); // 3 content tabs + 5 panels (ports/agents/plugins/jobs/system) + 2 launchers
  check('classic tab bar hidden', await evalJs(`getComputedStyle(document.querySelector('.sidebar-tabs')).display === 'none'`));
  check('sidebar content wrapped', await evalJs(`!!document.querySelector('#sidebar .sidebar-main')`));

  // panel tabs render into the list area
  const openPanel = async (id) => {
    await evalJs(`app.sidebar._railGo(${JSON.stringify(id)})`);
    await sleep(600);
    return evalJs(`!!document.querySelector('.rail-panel-${id}')`);
  };
  check('ports panel renders', await openPanel('ports'));
  // The machine row lands after the async port scan fetch — poll instead of a
  // fixed sleep (gate-only red under a loaded machine while standalone green).
  const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(250); } return evalJs(expr); };
  check('ports panel shows local machine scan', await waitFor(`document.querySelector('.rail-panel-ports .ports-machine') !== null`));
  check('agents panel renders', await openPanel('agents'));
  // redesign: roster header has the Add-account menu button, rows carry a ⋯ menu
  check('agents roster uses redesigned header', await evalJs(`!!document.querySelector('.rail-panel-agents .acct-roster-head .acct-add')`));
  // a fresh instance has only the CLI-login row (no ⋯); IF a named account
  // exists it must carry the ⋯ menu, and NO row may carry the old Test button
  check('named account rows (if any) have overflow menu, none have inline Test', await evalJs(`
    (() => { const rows = [...document.querySelectorAll('.rail-panel-agents .acct-key-row:not([data-id="__global__"]):not([data-id="__codex_global__"])')];
      const noTest = !document.querySelector('.rail-panel-agents .acct-test');
      const allMenu = rows.every(r => r.querySelector('.acct-menu'));
      return noTest && allMenu; })()`));
  // add-account menu opens a context menu
  await evalJs(`document.querySelector('.rail-panel-agents .acct-add').click()`);
  await sleep(200);
  check('add-account opens a menu', await evalJs(`!!document.querySelector('.context-menu')`));
  await evalJs(`document.querySelector('.context-menu')?.remove()`);
  check('plugins panel renders', await openPanel('plugins'));

  // Background Work panel is sidebar-NATIVE (2.357.0, owner verdict): cards
  // expand INLINE — a sidebar click must never spawn a window, and the
  // interact entry points land back in the sidebar
  await evalJs(`fetch('/api/jobs', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({kind:'task', name:'smoke-job', cmd:{argv:['sh','-c','sleep 5']}, context:{payload:'smoke'}, access:{view:'all', control:'session'}})}).then(r=>r.json())`);
  check('jobs panel renders', await openPanel('jobs'));
  await sleep(800);
  check('jobs toolbar renders (New button, no Open-window button)', await evalJs(`!!document.querySelector('.rail-panel-jobs .jobs-btn-ok') && ![...document.querySelectorAll('.rail-panel-jobs .jobs-btn')].some((b) => /open window/i.test(b.textContent))`));
  check('smoke job card renders', await evalJs(`!!document.querySelector('.rail-panel-jobs [data-job]')`));
  const winsBefore = await evalJs('app.wm.windows.size');
  await evalJs(`document.querySelector('.rail-panel-jobs [data-job]').click()`);
  await sleep(800);
  check('card click expands INLINE detail', await evalJs(`!!document.querySelector('.rail-panel-jobs .jobs-detail')`));
  check('…and spawns NO window', await evalJs('app.wm.windows.size') === winsBefore);
  check('openJobInteract lands in the sidebar, not a window', await evalJs(`(() => { const before = app.wm.windows.size; const id = document.querySelector('.rail-panel-jobs [data-job]').dataset.job; app.openJobInteract(id); return app.wm.windows.size === before && app.sidebar._activeTab === 'jobs'; })()`));
  await sleep(600);

  // System panel: the btop-like process manager (2.354.0) — real rows from
  // the live /api/sysinfo/procs, search narrows, expand exposes the actions
  check('system panel renders', await openPanel('system'));
  // first /procs fetch: POLL, never a fixed sleep — under the gate's parallel
  // load the first fetch can take several seconds and a 1.5s sleep went red
  // (2.369.16 gate flake: 6 process-table asserts + a null .click())
  // 60s budget (was 20s): at load average 44 (owner renders + parallel gates)
  // the /procs + sysinfo fetches took longer than 20s and the battery read
  // RED for load alone (2.369.48 gate)
  for (let i = 0; i < 240; i++) {
    if (await evalJs(`document.querySelectorAll('.rail-panel-system .prc-row').length > 5 && !!document.querySelector('.rail-panel-system .prc-pause') && !!document.querySelector('.rail-panel-system .sys-hist')`)) break;
    await sleep(250);
  }
  check('process table has real rows', await evalJs(`document.querySelectorAll('.rail-panel-system .prc-row').length > 5`));
  check('rows carry cpu + mem cells', await evalJs(`!!document.querySelector('.rail-panel-system .prc-row .prc-cpu') && !!document.querySelector('.rail-panel-system .prc-row .prc-mem')`));
  check('sort chips render (CPU/MEM/PID/Name/Tree)', await evalJs(`document.querySelectorAll('.rail-panel-system .prc-sorts .sys-range-chip').length === 5`));
  check('rows carry a PID column', await evalJs(`(() => { const el = document.querySelector('.rail-panel-system .prc-row .prc-pid'); return !!el && /^\\d+$/.test(el.textContent); })()`));
  check('charts zone sits BEFORE the process table', await evalJs(`(() => { const p = document.querySelector('.rail-panel-system .sys-procs'); const h = document.querySelector('.rail-panel-system .sys-hist'); return !!p && !!h && (h.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()`));
  // pause toggle freezes the table (no fetch-driven redraw while on)
  await evalJs(`document.querySelector('.rail-panel-system .prc-pause')?.click()`);
  check('pause toggle arms', await evalJs(`document.querySelector('.rail-panel-system .prc-pause').classList.contains('on') && app.sidebar._prcPaused === true`));
  await evalJs(`document.querySelector('.rail-panel-system .prc-pause')?.click()`);
  check('pause toggle disarms + refresh resumes', await evalJs(`app.sidebar._prcPaused === false`));
  await evalJs(`(() => { const s = document.querySelector('.rail-panel-system .prc-search'); s.value = 'node'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  // filter matches the FULL cmd (the title attr), not the displayed basename —
  // `sh -c "node …"` rows legitimately show 'sh' while matching 'node'
  check('search filters the table', await evalJs(`(() => { const rows = [...document.querySelectorAll('.rail-panel-system .prc-row')]; return rows.length > 0 && rows.every((r) => (r.querySelector('.prc-name')?.title || '').toLowerCase().includes('node')); })()`));
  await evalJs(`document.querySelector('.rail-panel-system .prc-row')?.click()`);
  await sleep(200);
  check('row expands to detail with kill actions', await evalJs(`!!document.querySelector('.rail-panel-system .prc-detail .prc-act[data-sig="TERM"]') || !!document.querySelector('.rail-panel-system .prc-detail .empty-hint')`));
  await evalJs(`(() => { const s = document.querySelector('.rail-panel-system .prc-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);

  // gs-menu style entry redirects to the rail panel (no modal)
  await evalJs(`app.sidebar._railGo('folders')`);
  await sleep(200);
  await evalJs(`app.openPluginsDialog()`);
  await sleep(500);
  check('openPluginsDialog redirects to rail panel', await evalJs(`!!document.querySelector('.rail-panel-plugins') && !document.getElementById('plugins-dialog')`));

  // re-click active item collapses the sidebar — but the rail STRIP persists
  // (sidebar.railPersistent, default ON) and a rail click expands back
  await evalJs(`app.sidebar._railGo('plugins')`);
  await sleep(200);
  check('re-click collapses sidebar', await evalJs(`!app.sidebar.isOpen`));
  check('collapsed keeps the rail strip', await evalJs(`document.getElementById('sidebar').classList.contains('rail-collapsed')`));
  check('collapsed strip is 44px', await evalJs(`Math.round(document.getElementById('sidebar').getBoundingClientRect().width) === 44`));
  check('panel area hidden while collapsed', await evalJs(`getComputedStyle(document.querySelector('.sidebar-main')).display === 'none'`));
  await evalJs(`app.sidebar._railGo('folders')`);
  await sleep(200);
  check('rail click expands back', await evalJs(`app.sidebar.isOpen && !document.getElementById('sidebar').classList.contains('rail-collapsed')`));
  // railPersistent OFF → collapsing hides everything (classic)
  await evalJs(`app.settings.set('sidebar.railPersistent', false)`);
  await sleep(1200); // let the save echo land (applyRemote guard covers the debounce)
  await evalJs(`app.sidebar.toggle(false)`);
  await sleep(200);
  check('persistent off: collapse hides fully', await evalJs(`!document.getElementById('sidebar').classList.contains('rail-collapsed')`));
  await evalJs(`app.settings.set('sidebar.railPersistent', true)`);
  await sleep(200);
  check('persistent back on applies live to a collapsed sidebar', await evalJs(`document.getElementById('sidebar').classList.contains('rail-collapsed')`));
  await evalJs(`app.sidebar.toggle(true)`);
  // header title tracks the active panel
  await evalJs(`app.sidebar._railGo('ports')`);
  await sleep(300);
  check('header title tracks panel', await evalJs(`document.querySelector('#sidebar .sidebar-title').textContent.length > 0 && document.querySelector('#sidebar .sidebar-title').textContent !== 'Sessions'`));
  await evalJs(`app.sidebar._railGo('folders')`);
  await sleep(200);
  check('header title restores for sessions', await evalJs(`document.querySelector('#sidebar .sidebar-title').textContent === 'Sessions'`));

  // setting OFF live-restores the classic tab bar + falls back to a session tab
  await evalJs(`app.settings.set('sidebar.activityRail', false)`);
  await sleep(500);
  check('rail removed when setting off', await evalJs(`!document.getElementById('sidebar-rail')`));
  check('classic tab bar restored', await evalJs(`getComputedStyle(document.querySelector('.sidebar-tabs')).display !== 'none'`));
  check('panel tab fell back to folders', await evalJs(`app.sidebar._activeTab === 'folders'`));

  // and back ON
  await evalJs(`app.settings.set('sidebar.activityRail', true)`);
  await sleep(500);
  check('rail rebuilt when setting on', await evalJs(`!!document.getElementById('sidebar-rail')`));

} catch (e) {
  failed++;
  console.error('  ✗ smoke crashed: ' + e.message);
}

console.log(failed ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed ? 1 : 0);
