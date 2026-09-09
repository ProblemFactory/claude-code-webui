#!/usr/bin/env node
// Chat virtual-scroll paging stability (2026-07-30 user report: "翻页过程中会
// 往上跳一大截，往回翻也会意外跳跃"). Drives a REAL view-only ChatView over a
// synthetic 700-record transcript (with foldable Bash runs, so run-collapse is
// active) in a throwaway worktree server + headless chrome, pages UP then DOWN
// in discrete steps, and measures viewport displacement a user would perceive
// as a jump: (a) the anchor element shifting inside the viewport between our
// scripted steps, (b) scrollTop moving away from where the script put it.
// Run: node scripts/test-chat-paging.mjs
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
const wt = scratch('chatpage-smoke');
const CWD = scratch('chatpage-test');
const SID = 'e2e00000-0000-4000-8000-000000000001';
const PROJ = path.join(os.homedir(), '.claude', 'projects', CWD.replace(/[/._]/g, '-'));
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. synthetic transcript: text turns + LONG texts + foldable Bash runs ──
{
  const lines = [];
  let t = Date.now() - 7 * 86400e3;
  const ts = () => new Date((t += 30e3)).toISOString();
  let n = 0;
  const push = (o) => { lines.push(JSON.stringify(o)); };
  // 900 turns with fat tool outputs → ~40MB file: crosses the 32MB
  // registered-tail threshold, so paging up exercises the GAP-SEEK path
  // (slab loads + _trimGapDom) exactly like the huge real-world sessions
  // the report came from.
  const FAT = 'a fat line of tool output that adds real rendered height 0123456789\n';
  for (let turn = 0; turn < 900; turn++) {
    push({ type: 'user', message: { role: 'user', content: `question ${turn}: please do the thing and explain` }, uuid: `u-${n++}`, timestamp: ts() });
    // assistant text of varying length (height variance is what stresses the
    // content-visibility estimates)
    const long = 'line of explanatory prose that wraps around and adds height\n'.repeat(3 + (turn % 9) * 4);
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `answer ${turn}:\n${long}` }], usage: { input_tokens: 10, output_tokens: 50 } }, uuid: `a-${n++}`, timestamp: ts() });
    // a run of 4 Bash tool calls (foldable by run-collapse)
    for (let b = 0; b < 4; b++) {
      const tid = `toolu_${turn}_${b}`;
      push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: `echo step ${turn}.${b}` } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
      // vary result size wildly (16 lines … 300 lines): estimate-vs-real
      // height skew under content-visibility is the stress being tested
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `output ${turn}.${b}\n` + FAT.repeat(16 + ((turn + b) % 5) * 70) }] }, uuid: `tr-${n++}`, timestamp: ts() });
    }
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `turn ${turn} done.` }], usage: { input_tokens: 10, output_tokens: 5 } }, uuid: `af-${n++}`, timestamp: ts() });
  }
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(PROJ, `${SID}.jsonl`), lines.join('\n') + '\n');
  console.log(`  transcript: ${lines.length} records`);
}

// ── 2. throwaway server + chrome ──
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });
// UNMINIFIED bundle for the worktree: scrollTop-write stacks must carry real
// function names so each jump can be attributed to its exact call site.
execSync('npx esbuild src/client.js --bundle --outfile=public/bundle.js --format=iife --platform=browser --target=es2020 --loader:.css=css', { cwd: wt, stdio: 'ignore' });
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000',
  '--disable-background-timer-throttling', `--user-data-dir=${scratch('chatpage-chrome')}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('chatpage-chrome'), { recursive: true, force: true }); } catch {}
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
  if (m.method === 'Runtime.exceptionThrown') { try { console.log('[pageEX]', m.params.exceptionDetails?.exception?.description?.slice(0, 250)); } catch {} }
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

// ── 3. open the view-only chat + install the drift recorder ──
const opened = await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.app.viewSession('${SID}', '${CWD}', 'paging test');
  for (let i = 0; i < 50; i++) {
    const list = document.querySelector('.chat-message-list');
    if (list && list.querySelectorAll('.chat-msg').length > 10) break;
    await sleep(300);
  }
  const list = document.querySelector('.chat-message-list');
  if (!list) return { ok: false };
  await sleep(1200); // initial render + fold settle
  // drift recorder: per-frame topmost-visible element + its viewport offset
  window.__rec = []; window.__marks = []; window.__stWrites = [];
  // forensic interceptor: EVERY programmatic scrollTop write with its caller
  {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(list, 'scrollTop', {
      get() { return desc.get.call(this); },
      set(v) {
        const from = desc.get.call(this);
        const stack = (new Error().stack || '').split(String.fromCharCode(10)).slice(2, 5).map((l) => l.trim()).join(' | ');
        window.__stWrites.push({ t: performance.now(), from: Math.round(from), to: Math.round(v), by: window.__scripted ? 'SCRIPT' : stack.slice(0, 160) });
        desc.set.call(this, v);
      },
    });
  }
  const tick = () => {
    const st = list.scrollTop;
    let el = null;
    for (const c of list.children) { if (c.offsetHeight > 0 && c.offsetTop + c.offsetHeight > st) { el = c; break; } }
    window.__rec.push({ t: performance.now(), id: el ? (el.dataset.msgId || el.className.slice(0, 20)) : null, top: el ? el.offsetTop - st : 0, st, sh: list.scrollHeight });
    window.__rafId = requestAnimationFrame(tick);
  };
  tick();
  window.__list = list;
  return { ok: true, n: list.querySelectorAll('.chat-msg').length, sh: list.scrollHeight, st: list.scrollTop };
})()`);
check('view-only chat opened with messages', opened?.ok && opened.n > 10, JSON.stringify(opened));

// one paging step: mark, set scrollTop, wait for loads/folds to settle
const step = async (dir, px, waitMs) => await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const list = window.__list;
  const before = list.scrollTop;
  const target = ${dir === 'up' ? `Math.max(0, before - ${px})` : `Math.min(list.scrollHeight, before + ${px})`};
  window.__marks.push({ t: performance.now(), set: target, before });
  window.__scripted = true; list.scrollTop = target; window.__scripted = false;
  list.dispatchEvent(new Event('scroll'));
  await sleep(${waitMs});
  return { set: target, settled: list.scrollTop, sh: list.scrollHeight };
})()`);

// wheel-like cadence (small fast ticks) interleaved with big flicks, both ways
const stepsUp = [];
for (let i = 0; i < 90; i++) stepsUp.push(await step('up', i % 9 === 8 ? 1400 : 260, i % 9 === 8 ? 700 : 130));
await sleep(1200);
const stepsDown = [];
for (let i = 0; i < 90; i++) stepsDown.push(await step('down', i % 9 === 8 ? 1400 : 260, i % 9 === 8 ? 700 : 130));

// ── 4. analyze: per-frame anchor displacement between scripted marks ──
const analysis = await evaljs(`(() => {
  cancelAnimationFrame(window.__rafId);
  const rec = window.__rec, marks = window.__marks.map((m) => m.t);
  const jumps = [];
  for (let i = 1; i < rec.length; i++) {
    const a = rec[i - 1], b = rec[i];
    // exclude ONLY the frame pair spanning our own scrollTop write — the
    // earlier ±120ms window swallowed the async load mutations we must watch
    const spansMark = marks.some((mt) => mt >= a.t && mt <= b.t);
    if (spansMark) continue;
    if (a.id && b.id && a.id === b.id && Math.abs(b.top - a.top) > 60) {
      jumps.push({ kind: 'anchor-shift', id: b.id, from: Math.round(a.top), to: Math.round(b.top), st: Math.round(b.st), t: Math.round(b.t) });
    } else if (a.id && b.id && a.id !== b.id && Math.abs(b.st - a.st) > 400) {
      jumps.push({ kind: 'scroll-teleport', dst: Math.round(b.st - a.st), st: Math.round(b.st), t: Math.round(b.t) });
    }
  }
  // attribute: for each jump, the non-script scrollTop writes within ±400ms
  const writes = window.__stWrites;
  for (const j of jumps) {
    j.writes = writes.filter((w) => w.by !== 'SCRIPT' && Math.abs(w.t - j.t) < 400)
      .map((w) => ({ d: Math.round(w.to - w.from), by: w.by, t: Math.round(w.t) })).slice(0, 6);
  }
  return { frames: rec.length, jumps: jumps.slice(0, 14), jumpCount: jumps.length };
})()`);

console.log(`  frames=${analysis.frames} scripted steps=${stepsUp.length + stepsDown.length}`);
if (analysis.jumps.length) console.log('  jumps:', JSON.stringify(analysis.jumps, null, 1).slice(0, 6000));
// settled-vs-set drift on each step (loads may legitimately grow scrollHeight;
// what must NOT happen is the viewport landing far from where the user was)
check('no anchor-shift/teleport jumps while paging', analysis.jumpCount === 0, `${analysis.jumpCount} jumps`);

ws.close();
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
