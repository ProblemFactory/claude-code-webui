#!/usr/bin/env node
// UI scale (DPI) + UI font scale + locked-model-badge restyle smoke (2.257.0).
// - locked badge: SVG lock in currentColor on the accent pill (no more orange
//   emoji / accent-on-accent washout) — computed-color + screenshot verified
// - vibespace.uiScale: body zoom, #main-wrapper /--ui-scale compensation, and
//   DRAG ACCURACY (the classic CSS-zoom bug: viewport deltas applied to layout
//   px make windows outrun the cursor by the zoom factor — every drag handler
//   divides by uiScale(); this asserts a real CDP drag lands 1:1)
// - vibespace.uiFontScale: chrome text multiplier (desktop-preview labels etc.)
// Throwaway server in a git worktree + headless chrome. Screenshots land in
// /tmp/vs-uiscale-shots/ for the mandatory human look.
// Run: node scripts/test-ui-scale.mjs
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
const wt = scratch('uiscale-smoke');
const SHOTS = scratch('uiscale-shots');
fs.mkdirSync(SHOTS, { recursive: true });
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
  '--window-size=1280,800', '--disable-background-timer-throttling', `--user-data-dir=${scratch('uiscale-chrome')}`, 'about:blank'], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('uiscale-chrome'), { recursive: true, force: true }); } catch {}
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
const shot = async (name, clip) => {
  const r = await cdp('Page.captureScreenshot', clip ? { clip: { ...clip, scale: 1 } } : {});
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
};

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  await sleep(500);

  // ── 1. Locked-model badge restyle (real CSS, injected markup) ────────────
  const LOCK_SVG = '<svg style="width:1em;height:1em;vertical-align:-0.125em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 016 0v2"/></svg>';
  const badge = await evalJs(`(() => {
    const bar = document.createElement('div');
    bar.className = 'chat-status-bar';
    bar.style.cssText = 'position:fixed;left:20px;bottom:60px;z-index:99999;padding:3px 10px;display:flex;gap:8px;align-items:center;';
    bar.id = 'smoke-badge-bar';
    bar.innerHTML = '<span class="chat-status-model chat-status-clickable chat-status-model-locked">${LOCK_SVG.replace(/'/g, "\\'")}claude-fable-5</span>';
    document.body.appendChild(bar);
    const el = bar.querySelector('.chat-status-model');
    const cs = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    return {
      color: cs.color, bg: cs.backgroundColor,
      bgRoot: root.getPropertyValue('--bg-root').trim(), accent: root.getPropertyValue('--accent').trim(),
      svgStroke: getComputedStyle(el.querySelector('svg')).stroke,
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 }; })(),
    };
  })()`);
  // text must be the pill's base --bg-root (dark-on-accent), NOT an accent tone
  const norm = (c) => c.replace(/\s/g, '').toLowerCase();
  const toRgb = await evalJs(`(() => { const d = document.createElement('div'); d.style.color = ${JSON.stringify(badge.bgRoot)}; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; })()`);
  check(`locked badge text = --bg-root (${badge.color})`, norm(badge.color) === norm(toRgb));
  check('lock SVG inherits the text color (currentColor)', norm(badge.svgStroke) === norm(badge.color));
  const accentRgb = await evalJs(`(() => { const d = document.createElement('div'); d.style.color = ${JSON.stringify(badge.accent)}; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; })()`);
  check(`badge bg stays the accent pill (${badge.bg})`, norm(badge.bg) === norm(accentRgb));
  await shot('badge-locked.png', badge.rect);
  await shot('badge-context.png');
  await evalJs(`document.getElementById('smoke-badge-bar').remove(); true`);

  // ── 2. UI scale (DPI): zoom + layout compensation + drag accuracy ────────
  await evalJs(`localStorage.setItem('vibespace.uiScale', '125'); localStorage.setItem('vibespace.uiFontScale', '120'); true`);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('app.ready');
  await sleep(600);

  check('body zoom applied (1.25)', await evalJs(`document.body.style.zoom`) === '1.25');
  const mw = await evalJs(`(() => { const r = document.getElementById('main-wrapper').getBoundingClientRect(); return { h: r.height, vh: window.innerHeight }; })()`);
  check(`#main-wrapper fills the real viewport under zoom (${Math.round(mw.h)} vs ${mw.vh})`, Math.abs(mw.h - mw.vh) <= 2);

  // font scale: desktop preview label = base var (7px default) × 1.2
  const lbl = await evalJs(`(() => {
    const el = document.querySelector('.desktop-preview-label');
    if (!el) return null;
    return { fs: parseFloat(getComputedStyle(el).fontSize) };
  })()`);
  if (lbl) check(`desktop-preview label font scales ×1.2 (${lbl.fs}px)`, lbl.fs > 7.5 && lbl.fs < 12);
  else check('desktop-preview label present', false, 'no .desktop-preview-label found');

  // drag accuracy: open a file explorer window, drag its title bar by a fixed
  // PHYSICAL delta, assert the window's on-screen rect moved by ≈ the same
  // physical delta (uncompensated it would move ×1.25 = ~+37px off at 150px)
  await evalJs(`app.openFileExplorer(); true`);
  await sleep(800);
  const t0 = await evalJs(`(() => {
    const w = [...app.wm.windows.values()].pop();
    const tb = w.element.querySelector('.window-titlebar');
    const r = tb.getBoundingClientRect(); const wr = w.element.getBoundingClientRect();
    return { id: w.id, x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2, wx: wr.left, wy: wr.top };
  })()`);
  await mouse('mousePressed', t0.x, t0.y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', t0.x + (150 * i) / 8, t0.y + (90 * i) / 8); await sleep(25); }
  await mouse('mouseReleased', t0.x + 150, t0.y + 90);
  await sleep(300);
  const t1 = await evalJs(`(() => { const w = app.wm.windows.get(${JSON.stringify(t0.id)}); const r = w.element.getBoundingClientRect(); return { wx: r.left, wy: r.top }; })()`);
  const mdx = t1.wx - t0.wx, mdy = t1.wy - t0.wy;
  check(`drag tracks the cursor 1:1 at 125% (moved ${Math.round(mdx)},${Math.round(mdy)} for a 150,90 drag)`, Math.abs(mdx - 150) <= 12 && Math.abs(mdy - 90) <= 12);

  await shot('app-125.png');

  // ── F1 regression (review-caught): snap/preset geometry must stay INSIDE
  // the workspace at 125% — the old gBCR-based math spanned zoom-inflated
  // widths and hung windows off the right edge; captured fractions divided by
  // the zoom poisoned layouts.json for all clients.
  const snap = await evalJs(`(() => {
    const w = [...app.wm.windows.values()].pop();
    app.wm.snapToHalf(w.id, 'left');
    return new Promise((res) => setTimeout(() => {
      const wr = w.element.getBoundingClientRect();
      const wsr = document.getElementById('workspace').getBoundingClientRect();
      res({ inRight: wr.right <= wsr.right + 2, inBottom: wr.bottom <= wsr.bottom + 2,
            frac: w.gridBounds ? w.gridBounds.width : null,
            visFrac: wr.width / wsr.width });
    }, 400));
  })()`);
  check(`snapToHalf stays inside the workspace at 125% (right ${snap.inRight}, bottom ${snap.inBottom})`, snap.inRight && snap.inBottom);
  check(`captured gridBounds fraction matches the visual fraction (${snap.frac?.toFixed(3)} vs ${snap.visFrac?.toFixed(3)})`, snap.frac != null && Math.abs(snap.frac - snap.visFrac) < 0.02);

  // ── F2 regression (review-caught): a context menu opened near the bottom-
  // right corner must render fully on screen — the old viewport-px write
  // rendered at coordinate×zoom (unreachable past ~80% of the viewport) and
  // the clamp wrote viewport numbers as layout px, so it could not recover.
  // right-click a desktop preview (bottom-right corner chrome) → real menu
  const pv = await evalJs(`(() => { const el = document.querySelector('.desktop-preview'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (pv) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pv.x, y: pv.y, button: 'right', buttons: 2, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pv.x, y: pv.y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(400);
    const mrect = await evalJs(`(() => { const m = document.querySelector('[data-popover]'); if (!m) return null; const r = m.getBoundingClientRect(); return { l: r.left, t: r.top, rgt: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight, nearX: ${Math.round(pv.x)}, nearY: ${Math.round(pv.y)} }; })()`);
    if (mrect) {
      check(`context menu fully on screen at 125% (r ${Math.round(mrect.rgt)}/${mrect.vw}, b ${Math.round(mrect.b)}/${mrect.vh})`, mrect.rgt <= mrect.vw && mrect.b <= mrect.vh && mrect.l >= 0 && mrect.t >= 0);
      check(`context menu opens near the cursor (Δx ${Math.round(Math.abs(mrect.l - mrect.nearX))})`, Math.abs(mrect.l - mrect.nearX) < 120 && Math.abs(mrect.t - mrect.nearY) < 200);
      await evalJs(`document.querySelector('[data-popover]')?.remove(); true`);
    } else check('context menu appeared', false);
  }

  // gs-menu rows exist and show the current values
  await evalJs(`document.getElementById('btn-global-settings').click(); true`);
  await sleep(300);
  const rows = await evalJs(`(() => {
    const pop = document.querySelector('.global-settings-popover');
    if (!pop) return null;
    const labels = [...pop.querySelectorAll('label')].map((l) => l.textContent);
    const vals = [...pop.querySelectorAll('.font-size-ctrl span')].map((s) => s.textContent);
    return { labels, vals };
  })()`);
  check('gs-menu has the two new rows', !!rows && rows.labels.some((l) => /DPI/.test(l)) && rows.labels.some((l) => /font size|字体/.test(l)));
  check('rows show current % values', !!rows && rows.vals.includes('125%') && rows.vals.includes('120%'));
  await shot('gs-menu-125.png');
  await evalJs(`document.querySelector('.global-settings-popover')?.remove(); true`);

  // ── 3. reset to 100% clears the zoom ─────────────────────────────────────
  await evalJs(`localStorage.removeItem('vibespace.uiScale'); localStorage.removeItem('vibespace.uiFontScale'); true`);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('app.ready');
  check('reset clears body zoom', await evalJs(`document.body.style.zoom`) === '');
  const lbl2 = await evalJs(`(() => { const el = document.querySelector('.desktop-preview-label'); return el ? parseFloat(getComputedStyle(el).fontSize) : null; })()`);
  if (lbl2 != null) check(`label font back to base (${lbl2}px)`, lbl2 <= 8);
  await shot('app-100.png');

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  process.exit(1);
}
