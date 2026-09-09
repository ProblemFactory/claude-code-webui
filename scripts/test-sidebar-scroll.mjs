#!/usr/bin/env node
// Sidebar lazy-folder scroll preservation (2.228.3, recurring user report:
// "scroll down, click a card's expand arrow → the list jumps back to the
// top"). Mechanism under test: a re-render resets every lazy folder to an
// EMPTY pending div, the list's scrollHeight collapses, and _render()'s
// scrollTop restore clamps to ~0 before the IntersectionObserver can
// materialize anything. The fix reserves each folder's previous height
// (_lazyHeights in _render → minHeight in _observeFolder). This drives the
// REAL render/observer/clamp machinery in a throwaway worktree server +
// headless chrome (raw CDP), feeding _renderGrouped synthetic folders.
// Run: node scripts/test-sidebar-scroll.mjs
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
const wt = scratch('scroll-smoke');
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
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('scroll-smoke-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('scroll-smoke-chrome'), { recursive: true, force: true }); } catch {}
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
ws.on('message', (d) => { const m = JSON.parse(d);
  if (m.method === 'Runtime.consoleAPICalled') { try { console.log('[page]', m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 500)); } catch {} }
  if (m.method === 'Runtime.exceptionThrown') { try { console.log('[pageEX]', m.params.exceptionDetails?.exception?.description?.slice(0, 300) || JSON.stringify(m.params.exceptionDetails).slice(0, 200)); } catch {} }
});
await cdp('Page.enable');
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 60; i++) { if (await evaljs('!!(window.app && window.app.sidebar && window.app.sidebar.listEl)').catch(() => false)) break; await sleep(400); }

// Fresh profile starts rail-collapsed (44px strip, main panel width 0) — a
// zero-height scroller makes every scroll op a no-op. Expand like a user:
// click the active rail item (re-click while collapsed EXPANDS per 2.177.0).
await evaljs(`(() => { window.app.sidebar.toggle(true); return document.querySelector('.sidebar')?.className; })()`);
await sleep(400);
const h = await evaljs(`window.app.sidebar.listEl.closest('.sidebar-section').clientHeight`);
check('sidebar expanded (scroller has height)', h > 200, `clientHeight=${h}`);

const result = await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sb = window.app.sidebar;
  let sc = sb.listEl.closest('.sidebar-section');
  const pickScroller = () => { sc = [sb.listEl, sb.listEl.closest('.sidebar-section')].find((el) => el && el.scrollHeight > el.clientHeight + 4) || sc; };
  // 50 folders x 3 stopped sessions — enough content to scroll deep
  const fakes = [];
  for (let g = 0; g < 50; g++) for (let i = 0; i < 3; i++) fakes.push({
    sessionId: 'fk-' + g + '-' + i, claudeSessionId: 'fk-' + g + '-' + i,
    status: 'stopped', backend: 'claude', cwd: '/tmp/proj-' + g, name: 'fake ' + g + '-' + i,
    startedAt: Date.now() - g * 3600e3 - i * 60e3, mtime: Date.now() - g * 3600e3,
  });
  // Drive the REAL lazy grouped renderer through the REAL _render preserve path
  sb._renderInner = () => { sb.listEl.innerHTML = ''; sb._renderGrouped(fakes); };
  sb._lastRenderView = null;
  sb._render();
  await sleep(500); // observer materializes viewport folders
  const pendingWithHeight = [...sb.listEl.querySelectorAll('.folder-sessions')]
    .filter((d) => d.dataset.lazy !== 'rendered' && parseInt(d.style.minHeight || '0') > 0).length;
  pickScroller(); // the real scroller only overflows once content exists
  const fullHeight = sc.scrollHeight;
  const target = Math.floor(sc.scrollHeight * 0.6);
  sc.scrollTop = target;
  const landed = sc.scrollTop; // may clamp if content short — record what we got
  await sleep(500); // observer renders folders at the new viewport
  const before = sc.scrollTop;
  // simulate the expand-toggle re-render (sidebar-render onExpandToggle)
  sb._expandedCardId = 'fk-30-0';
  sb._render();
  const immediatelyAfter = sc.scrollTop;
  await sleep(500);
  const after = sc.scrollTop;
  const rebuiltHeight = sc.scrollHeight;
  return { pendingWithHeight, fullHeight, landed, before, immediatelyAfter, after, rebuiltHeight };
})()`);

check('lazy machinery active (pending folders exist below the fold)', result.pendingWithHeight > 0, JSON.stringify(result));
check('deep scroll actually landed (content tall enough)', result.landed > 500, `landed=${result.landed} fullHeight=${result.fullHeight}`);
check('scrollTop survives the expand re-render (sync)', Math.abs(result.immediatelyAfter - result.before) < 80, `before=${result.before} after-sync=${result.immediatelyAfter}`);
check('scrollTop stays after observer settles', Math.abs(result.after - result.before) < 120, `before=${result.before} after=${result.after}`);
check('rebuilt scrollHeight holds (reserved heights)', result.rebuiltHeight > result.fullHeight * 0.8, `full=${result.fullHeight} rebuilt=${result.rebuiltHeight}`);

ws.close();
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
