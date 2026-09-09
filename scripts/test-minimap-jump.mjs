#!/usr/bin/env node
// INDEX-mode minimap jump landing (inc-msnyti7z-c5sb: "minimap 跳转又不准" on a
// tool-heavy 4.4MB remote session). The incident trace showed the exact
// failure: jumpToIndex landed (scroll→145), then the 180ms-debounced
// run-collapse pass + content-visibility height resolution yanked the view to
// scrollTop 0 and a spurious extendBottom fired — the user ends up ~20
// messages before the one they clicked. The teleport (gap-mode) path got the
// full landing machinery in 2.111.x; index mode kept a single-rAF
// scrollIntoView. This drives a REAL view-only ChatView over a tool-heavy
// SMALL transcript (below the seek threshold → index mode, like the incident)
// and asserts the clicked message IS on screen ~centered after everything
// settles — across consecutive jumps.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { freePorts, scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('mmjump-smoke');
const CWD = scratch('mmjump-test');
const SID = 'e2e00000-0000-4000-8000-000000000002';
const PROJ = path.join(os.homedir(), '.claude', 'projects', CWD.replace(/[/._]/g, '-'));
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. tool-heavy transcript BELOW the seek threshold (index mode) ──
{
  const lines = [];
  let t = Date.now() - 86400e3;
  const ts = () => new Date((t += 20e3)).toISOString();
  let n = 0;
  const push = (o) => { lines.push(JSON.stringify(o)); };
  for (let turn = 0; turn < 120; turn++) {
    push({ type: 'user', message: { role: 'user', content: `question ${turn}: MARKER_Q${turn}` }, uuid: `u-${n++}`, timestamp: ts() });
    // a foldable Bash run (the incident window folded most of the messages
    // above the target — the fold moving the target is the failure mechanism)
    for (let b = 0; b < 5; b++) {
      const tid = `t-${turn}-${b}`;
      push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: `echo step ${turn}.${b}` } }], usage: { input_tokens: 5, output_tokens: 3 } }, uuid: `a-${n++}`, timestamp: ts() });
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `output ${turn}.${b}\n` + 'tool output line adding height 0123456789\n'.repeat(20 + ((turn + b) % 4) * 30) }] }, uuid: `tr-${n++}`, timestamp: ts() });
    }
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `answer ${turn}: MARKER_A${turn}\n` + 'prose line that wraps and adds height\n'.repeat(2 + (turn % 7) * 3) }], usage: { input_tokens: 10, output_tokens: 5 } }, uuid: `af-${n++}`, timestamp: ts() });
  }
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(PROJ, `${SID}.jsonl`), lines.join('\n') + '\n');
  const sz = fs.statSync(path.join(PROJ, `${SID}.jsonl`)).size;
  console.log(`  transcript: ${lines.length} records, ${(sz / 1e6).toFixed(1)}MB (index mode)`);
  if (sz > 30e6) { console.error('fixture unexpectedly huge — would flip into gap mode'); process.exit(1); }
}

// ── 2. throwaway server + chrome ──
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npx esbuild src/client.js --bundle --outfile=public/bundle.js --format=iife --platform=browser --target=es2020 --loader:.css=css', { cwd: wt, stdio: 'ignore' });
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('mmjump-chrome')}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('mmjump-chrome'), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PROJ, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); }
  catch { await sleep(250); }
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
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 60; i++) { if (await evaljs('!!(window.app && window.app.ready && window.app.wm)').catch(() => false)) break; await sleep(400); }
await sleep(1500);

// ── 3. open the view + run consecutive index jumps, assert each landing ──
const opened = await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.app.viewSession('${SID}', '${CWD}', 'minimap jump test');
  for (let i = 0; i < 50; i++) {
    const list = document.querySelector('.chat-message-list');
    if (list && list.querySelectorAll('.chat-msg').length > 5) break;
    await sleep(300);
  }
  await sleep(1500);
  const view = [...(window.app.sessions?.values() || [])].find((v) => v && v._messageList);
  if (!view) return { ok: false };
  window.__view = view;
  return { ok: true, total: view._total };
})()`);
check('view-only chat opened (index mode)', opened?.ok && opened.total > 100, JSON.stringify(opened));

// one landing check: jump to idx, wait past ALL settle timers (folds at
// 180ms, cv resolution ~1s, re-centers through 750ms), then measure where
// the target actually sits in the viewport
const land = async (frac) => await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = window.__view;
  const idx = Math.floor(view._total * ${frac});
  await view.jumpToIndex(idx);
  await sleep(1600);
  const list = view._messageList;
  const rel = idx - view._windowStart;
  const els = list.querySelectorAll('.chat-msg:not(.chat-gap-msg)');
  if (rel < 0 || rel >= els.length) return { idx, err: 'target not in window', rel, n: els.length };
  const el = els[rel];
  const lr = list.getBoundingClientRect();
  const rc = el.getBoundingClientRect();
  const centerOff = (rc.top + rc.height / 2) - (lr.top + lr.height / 2);
  const visible = rc.bottom > lr.top && rc.top < lr.bottom;
  const marker = (el.textContent.match(/MARKER_[AQ]\\d+/) || [null])[0];
  return { idx, visible, centerOff: Math.round(centerOff), vh: Math.round(lr.height), st: Math.round(list.scrollTop), marker, msgId: el.dataset.msgId };
})()`);

const seenTargets = [];
for (const frac of [0.6, 0.25, 0.85]) {
  const r = await land(frac);
  const okLand = r && !r.err && r.visible && Math.abs(r.centerOff) < r.vh * 0.5;
  check(`jump to ${Math.round(frac * 100)}% lands ON the clicked message after settle (off=${r?.centerOff}px, st=${r?.st}, ${r?.marker || r?.msgId})`, okLand, JSON.stringify(r));
  seenTargets.push(r?.msgId || r?.marker);
  // the incident's terminal state: view yanked to scrollTop 0 (window top)
  check(`jump to ${Math.round(frac * 100)}% did not get yanked to the window top`, r && r.st > 0, `st=${r?.st}`);
}

check('the three jumps measured three DISTINCT targets', new Set(seenTargets).size === 3, JSON.stringify(seenTargets));

ws.close();
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
