#!/usr/bin/env node
// B3 TURN TRUTH — the BROWSER half (design-harness-features §2.5 / §2.10 / §2.11).
//
// The server suites (test-stdout-registry, test-codex-history, test-attach-rebuild,
// test-harness-contract) prove the records are consumed and the ops are right.
// This one proves the three things a user can actually SEE, measured in a real
// headless chrome at 375×667 — the ≤768px viewport, where this product's status
// bar becomes a single swipeable lane and a chip that "renders" can still be
// unreachable:
//   ① the status bar's THIRD state ('requires_action') — the value we never had
//   ② the compaction card's hint: the hardcoded 1–2-minute apology BEFORE any
//      stage record, the CLI's real stage after one — driven by the frames the
//      server builds from `system/status`, the lane a REAL compaction (incl.
//      the AUTO one nobody typed /compact for) actually uses on 2.1.257
//      (round 4: `compact_progress` never reaches our stdout at all)
//   ③ retraction: a claude tombstone is REMOVED (its own instruction), a codex
//      rollback is STRUCK IN PLACE (hiding it would rewrite what someone read)
//   ④ the tool-granular run set marks the executing card, not every pending one
//      — DORMANT since round 4: `set_in_progress_tool_use_ids` never reaches
//      our stdout (the CLI hands it to a host callback), so caps.inProgressTools
//      is false everywhere and NO user sees this dot today. The legs stay as a
//      pin on the code, and say so.
//   ⑤ and BOTH of those per-element marks survive every rebuild — three of the
//      FOUR paths that build an element for a message (create/_renderDetached,
//      the status re-render in _onEditMessage, _rerenderVisible). Round-2
//      finding: they were written straight to the DOM and dropped on the
//      first replacement, and the tombstone's own case ALWAYS gets one.
//   ⑥ the FOURTH one — `_renderGapMsg`, the huge-session seek renderer, whose
//      elements deliberately never enter `_elements` and so were skipped by a
//      hook keyed to that map (round-3 finding). Guarded structurally by ⓪.
//
// SKIPs (exit 0) without chrome, like every other browser suite here.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { freePorts } from './scratch.mjs';
const require = createRequire(import.meta.url);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
};
const done = () => { console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`); process.exit(failed ? 1 : 0); };

// ── ⓪ SOURCE DRIFT GUARD — runs with or WITHOUT chrome ─────────────────────
//    Round-2's fix rests on one sentence: "ONE `_applyElementMarks`, called at
//    every place an element is built for a message". Round 3's verifier found
//    the ENUMERATION was wrong, not the mechanism — the huge-session seek
//    renderer `_renderGapMsg` (chat-view-seek.js) is a FOURTH builder and had
//    no marks at all, so a retracted turn reached through a gap slab rendered
//    as ordinary live history. A count in a comment cannot fail; this guard
//    COUNTS the builders in the source and demands a mark call inside each one,
//    so a fifth path added without marks goes red here even on a machine with
//    no browser. (`renderAssistantMsg` is the per-role switch's fingerprint:
//    every builder has exactly one, and nothing else calls it.)
{
  const BUILDER = /\.renderAssistantMsg\(/g;   // a CALL — chat-renderers' definition has no leading dot
  const MARK = /this\._applyElementMarks\(/g;
  // A builder may DELEGATE. Owner ruling 9's round 2 collapsed the two
  // element-SWAP sites into one named method (`_swapMessageEl`), which is the
  // same law one level up: the marks are re-derived in exactly one place for
  // both. So a site satisfies this guard by calling the mark directly OR by
  // handing the element to that method — and the delegate is then held to the
  // mark itself by its own assert below, so the escape hatch cannot be used to
  // launder a builder that marks nothing.
  const DELEGATE = /this\._swapMessageEl\(/;
  const MARKED = /this\._applyElementMarks\(/;
  // 2000 chars: the known sites sit 636–1165 chars from their mark call and the
  // two nearest builders are 5191 apart, so the window can never borrow the
  // NEXT builder's call and pass a site that has none of its own.
  const WIN = 2000;
  const scan = (src) => {
    const out = { builders: 0, marks: (src.match(MARK) || []).length, unmarked: [] };
    for (const b of src.matchAll(BUILDER)) {
      out.builders++;
      const win = src.slice(b.index, b.index + WIN);
      if (!MARKED.test(win) && !DELEGATE.test(win)) {
        out.unmarked.push(src.slice(0, b.index).split('\n').length);
      }
    }
    return out;
  };
  // The whole client tree, not a hardcoded pair: a fifth builder is as likely
  // to land in a new mixin file as in these two (chat-view-seek itself was
  // split out of chat-view, and that split is how this defect got in).
  const files = fs.readdirSync(path.join(repo, 'src/lib')).filter((f) => f.endsWith('.js')).map((f) => 'src/lib/' + f);
  let builders = 0, marks = 0;
  const unmarked = [];
  for (const f of files) {
    const r = scan(fs.readFileSync(path.join(repo, f), 'utf8'));
    builders += r.builders; marks += r.marks;
    for (const line of r.unmarked) unmarked.push(`${f}:${line}`);
  }
  check(`every path that BUILDS an element for a message re-derives its marks, directly or through the ONE swap method (${builders} builders, ${marks} direct call sites)`,
    builders >= 4 && marks >= 1 && unmarked.length === 0,
    unmarked.length ? 'unmarked builders: ' + unmarked.join(', ') : `builders=${builders} marks=${marks}`);
  // …and the delegate owes the mark. Without this, "call `_swapMessageEl`"
  // would be a way to satisfy the guard while marking nothing at all.
  const swapSrc = fs.readFileSync(path.join(repo, 'src/lib/chat-view.js'), 'utf8');
  const swapBody = (() => {
    const i = swapSrc.indexOf('_swapMessageEl(oldEl, newEl, id) {');
    if (i < 0) return null;
    let depth = 0;
    for (let k = swapSrc.indexOf('{', i); k < swapSrc.length; k++) {
      if (swapSrc[k] === '{') depth++;
      else if (swapSrc[k] === '}' && --depth === 0) return swapSrc.slice(i, k + 1);
    }
    return null;
  })();
  check('…and the ONE swap method re-derives the marks itself — the delegation the guard accepts is not a hole in it',
    !!swapBody && MARKED.test(swapBody) && /oldEl\.replaceWith\(newEl\)/.test(swapBody),
    swapBody ? swapBody.slice(0, 160) : 'no _swapMessageEl found');
  // NEGATIVE CONTROL for the guard itself — a matcher that can only ever say
  // "clean" is not a guard. The exact shape round 3 found (a builder switch
  // with no mark call) must be REPORTED, and the fixed shape must not be.
  const bad = scan("switch(m.role){case 'assistant': el = this._renderers.renderAssistantMsg(m); break;}\nel.classList.add('chat-gap-msg');\nreturn el;");
  const good = scan("switch(m.role){case 'assistant': el = this._renderers.renderAssistantMsg(m); break;}\nthis._applyElementMarks(el, m);\nreturn el;");
  const viaSwap = scan("switch(m.role){case 'assistant': el = this._renderers.renderAssistantMsg(m); break;}\nthis._swapMessageEl(oldEl, el, id);\nreturn el;");
  check('NEGATIVE CONTROL: the guard actually detects an unmarked builder (and passes both the marked twin and the one that delegates)',
    bad.builders === 1 && bad.unmarked.length === 1 && good.builders === 1 && good.unmarked.length === 0
    && viaSwap.builders === 1 && viaSwap.unmarked.length === 0,
    JSON.stringify([bad, good, viaSwap]));
}

// ── ⓪ b SESSION DEATH RETIRES EVERY CLIENT-HELD "RIGHT NOW" CLAIM ───────
//    (chrome-free wiring pin; the CONSEQUENCE is measured in chrome, leg ⑦)
//    Round 6 closed the two exits the SERVER can see for the compaction
//    stage. Session death is the third one and it is client-side: the wrapper
//    dies, no record ever arrives, and the view keeps its last frame forever.
//    Round 8's verifier found the round-7 fix was ONE LINE SHORT — the
//    compaction stage is not the only claim of that shape held on this view:
//      • `_compactStage`  → "a compaction is running"       (round 7)
//      • `_turnState`     → "the agent is waiting for you"  (round 8, the chip
//                            pulses on a dead session, forever)
//      • `_inFlightTools` → "this tool is executing"        (round 8; the
//                            DORMANT twin — `set_in_progress_tool_use_ids`
//                            never reaches our stdout, so no user sees it
//                            today, but the lane is kept alive by tests and
//                            must be right the day the CLI forwards one)
//    Each is a statement about a process that is GONE, and each is drawn
//    until something overwrites it — nothing ever will. A retirement nobody
//    calls is the 2.331.0 lesson verbatim, so the CALLS are pinned here.
{
  const cv = fs.readFileSync(path.join(repo, 'src/lib/chat-view.js'), 'utf8');
  const exitedAt = cv.indexOf("msg.type === 'exited'");
  // The branch EXACTLY, not a byte window: a call that drifts into the NEXT
  // `else if` must not be counted as this branch's.
  const rest = exitedAt >= 0 ? cv.slice(exitedAt) : '';
  const nextAt = rest.indexOf("} else if (msg.type ===", 10);
  const branch = exitedAt >= 0 ? (nextAt > 0 ? rest.slice(0, nextAt) : rest.slice(0, 2000)) : '';
  check('the client retirement is ONE named method (the twin of the server’s retireCompaction)',
    /_retireCompactionStage\(\)\s*\{/.test(cv) && /compactInFlight\?\.\(\)/.test(cv), 'no _retireCompactionStage in chat-view.js');
  // …and ONE OWNER for the whole set. Round 7 called the compaction retirement
  // straight from the branch, so "which claims does session death retire" had
  // no home and the answer stayed one line long. Now the branch calls one
  // named method and the ENUMERATION is what this guard reads.
  const ownerAt = cv.indexOf('_retireLiveClaims() {');
  const owner = ownerAt >= 0 ? cv.slice(ownerAt, ownerAt + 700).split('\n  }')[0] : '';
  check("the 'exited' branch calls ONE named retirement (a retirement nobody calls is the 2.331.0 unstaged-wiring class)",
    exitedAt >= 0 && /this\._retireLiveClaims\(\)/.test(branch), `exitedAt=${exitedAt} branch=${JSON.stringify(branch.slice(0, 300))}`);
  // ONE table, three rows — a fourth live claim added later gets a row here
  // and a leg in ⑦; the shape of the omission is identical every time.
  const CLAIMS = [
    ['the compaction stage (round 7)', /this\._retireCompactionStage\(\)/],
    ['the harness turn-state chip (round 8)', /this\._statusBar\?\.setTurnState\?\.\(null\)/],
    ['the executing-tool run set (round 8, dormant lane)', /this\._onToolsInProgress\(\[\]\)/],
  ];
  for (const [what, re] of CLAIMS) {
    check(`…and that retirement retires ${what} — a claim about RIGHT NOW dies with its producer`,
      ownerAt >= 0 && re.test(owner), `ownerAt=${ownerAt} owner=${JSON.stringify(owner.slice(0, 400))}`);
  }
  // NEGATIVE CONTROLS for this guard: the round-6 shape AND the round-7 shape
  // (which retired the compaction stage and nothing else) must each be
  // REPORTED, or the guard is decoration that would have passed on the very
  // code being fixed — plus an owner that forgot one row.
  const r6branch = "} else if (msg.type === 'exited' && msg.sessionId === sessionId) {\n  this._hideTyping();\n  this._renderers.appendSystem('Session ended.');\n  this._setReadOnly();\n}";
  const r7branch = "} else if (msg.type === 'exited' && msg.sessionId === sessionId) {\n  this._hideTyping();\n  this._retireCompactionStage();\n  this._renderers.appendSystem('Session ended.');\n  this._setReadOnly();\n}";
  const missing = (src) => CLAIMS.filter(([, re]) => !re.test(src)).length;
  check('NEGATIVE CONTROL: the guard detects the round-6 branch (hideTyping + system line + read-only, no retirement at all)',
    !/this\._retireLiveClaims\(\)/.test(r6branch) && missing(r6branch) === 3, String(missing(r6branch)));
  check('NEGATIVE CONTROL: …and the round-7 branch, which retired the compaction stage and nothing else (the shape this round fixes)',
    !/this\._retireLiveClaims\(\)/.test(r7branch) && missing(r7branch) === 2, String(missing(r7branch)));
  const halfOwner = '_retireLiveClaims() {\n    const wasCompacting = this._retireCompactionStage();\n    this._onToolsInProgress([]);\n    return wasCompacting;';
  check('NEGATIVE CONTROL: …and an OWNER that forgot the chip is reported by name (the enumeration is the thing being guarded)',
    missing(halfOwner) === 1 && !CLAIMS[1][1].test(halfOwner), String(missing(halfOwner)));
}

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('  SKIP: no chrome/chromium — the browser measurement did not run'); done(); }

const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs) — a pid-modulo port was a 1-in-20 collision
const wt = `/tmp/vs-turntruth-${process.pid}`;
const fakeHome = `${wt}-home`;
const CWD = `${wt}-cwd`;
const SID = 'b3000000-0000-4000-8000-0000000000b3';

// ── fixture: two answered turns + one PENDING tool call (so a [data-tool-id]
//    card exists to mark as executing). Small on purpose — this suite measures
//    chrome, not paging.
{
  const lines = [];
  let ts0 = Date.now() - 3600e3;
  const ts = () => new Date((ts0 += 5e3)).toISOString();
  const push = (o) => lines.push(JSON.stringify(o));
  let n = 0;
  for (const k of [0, 1]) {
    push({ type: 'user', message: { role: 'user', content: `question ${k}` }, uuid: `u-${n++}`, timestamp: ts() });
    push({ type: 'assistant', message: { id: `msg_a${k}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `answer ${k}` }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `a-${n++}`, timestamp: ts() });
    push({ type: 'result', subtype: 'success', duration_ms: 5, total_cost_usd: 0.001, timestamp: ts() });
  }
  push({ type: 'user', message: { role: 'user', content: 'run the two tools' }, uuid: `u-${n++}`, timestamp: ts() });
  for (const b of [0, 1]) {
    push({ type: 'assistant', message: { id: `msg_t${b}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: `toolu_${b}`, name: 'Bash', input: { command: `echo ${b}` } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
  }
  const proj = path.join(fakeHome, '.claude', 'projects', CWD.replace(/[/._]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines.join('\n') + '\n');
}

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch { }
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// Overlay the ALREADY-BUILT public/ (the gate's build step ran first); a
// standalone run measures whatever the last `npm run build` produced.
for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
// 375×667 = the mobile viewport this project measures at. --window-size is the
// OUTER size in headless=new, so the inner viewport is set through CDP below.
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=375,667',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { }
  try { srv.kill('SIGKILL'); } catch { }
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch { }
  for (const d of [`${wt}-chrome`, fakeHome, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
};
process.on('exit', cleanup);
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { }
  if (!target) await sleep(250);
}
if (!target) { console.error('✗ chrome never exposed a CDP page target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map(); const pageErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') { try { pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown'); } catch { } }
});
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 100; i++) { if (await evaljs('!!(window.app && window.app.ready && window.app.wm)').catch(() => false)) break; await sleep(300); }
await evaljs('window.app.ready.then(() => true)').catch(() => { });
await sleep(1200);

const vp = await evaljs('JSON.stringify({ w: innerWidth, h: innerHeight, mobile: !!(window.app && window.app.isMobile) })');
check(`viewport is the 375×667 mobile shape (${vp})`, /"w":375/.test(vp) && /"h":667/.test(vp), vp);

const opened = await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.app.viewSession('${SID}', '${CWD}', 'turn truth');
  for (let i = 0; i < 80; i++) {
    const v = [...(window.app.sessions?.values?.() || [])].pop();
    if (v && v._messageList && v._messageList.querySelectorAll('.chat-msg').length >= 5) { window.__v = v; return { ok: true, n: v._messageList.querySelectorAll('.chat-msg').length }; }
    await sleep(250);
  }
  const v = [...(window.app.sessions?.values?.() || [])].pop();
  window.__v = v || null;
  return { ok: false, n: v?._messageList?.querySelectorAll('.chat-msg').length ?? -1 };
})()`);
check(`the view-only chat rendered the fixture (${JSON.stringify(opened)})`, opened?.ok === true, opened);
if (!opened?.ok) { console.error(pageErrors.join('\n')); done(); }

// ── ① the status bar's THIRD state at 375px ─────────────────────────────────
{
  const before = await evaljs(`(() => {
    const bar = window.__v._statusBar?._element || document.querySelector('.chat-status-bar');
    return JSON.stringify({ hasBar: !!bar, chips: bar ? bar.querySelectorAll('.chat-status-turnstate').length : -1 });
  })()`);
  check('nothing is drawn before the harness reports a state (null ≠ idle ≠ a claim)', /"chips":0/.test(before), before);
  const idle = await evaljs(`(() => { window.__v._statusBar.setTurnState('idle'); const bar = window.__v._statusBar._element; return bar.querySelectorAll('.chat-status-turnstate').length; })()`);
  check("'idle' and 'running' draw nothing either — the composer's spinner already says that, and one fact must not have two voices", idle === 0, String(idle));
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sb = window.__v._statusBar;
    sb.setTurnState('requires_action');
    await sleep(120);
    const bar = sb._element;
    const chip = bar.querySelector('.chat-status-turnstate');
    if (!chip) return { chip: false };
    // the ≤768px lane is horizontally SWIPEABLE — a chip past the fold is
    // reachable, not lost; scroll it into view and measure it there.
    chip.scrollIntoView({ block: 'nearest', inline: 'end' });
    await sleep(120);
    const cs = getComputedStyle(chip), br = bar.getBoundingClientRect(), cr = chip.getBoundingClientRect();
    return {
      chip: true, text: chip.textContent.trim(), title: chip.getAttribute('title') || '',
      w: Math.round(cr.width), h: Math.round(cr.height),
      display: cs.display, visibility: cs.visibility,
      insideBar: cr.left >= br.left - 1 && cr.right <= br.right + 1,
      insideViewport: cr.left >= -1 && cr.right <= innerWidth + 1,
      barScrolls: bar.scrollWidth >= bar.clientWidth,
      barOverflowX: getComputedStyle(bar).overflowX,
      barH: Math.round(br.height),
    };
  })()`);
  check(`'requires_action' draws the third state at 375×667 (${JSON.stringify(m)})`, m?.chip === true && m.w > 0 && m.h > 0 && m.display !== 'none' && m.visibility !== 'hidden', m);
  check('…it says what it means, and the tooltip names WHO reported it', /waiting for you|等你操作|あなた待ち/.test(m?.text || '') && /harness/.test(m?.title || ''), JSON.stringify([m?.text, m?.title]));
  check('…and at ≤768px it lands inside the swipeable status lane, fully within the 375px viewport (no clipped chip)', m?.insideBar === true && m?.insideViewport === true && m?.barOverflowX === 'auto', m);
  check('…the bar stayed ONE line (mobile rule: never wrap into rows that eat the space above the input)', m?.barH > 0 && m.barH <= 40, String(m?.barH));
  const back = await evaljs(`(() => { window.__v._statusBar.setTurnState('idle'); return window.__v._statusBar._element.querySelectorAll('.chat-status-turnstate').length; })()`);
  check('…and it goes away again when the harness says idle (the chip is a live state, not a sticky banner)', back === 0, String(back));
}

// ── ② the compaction card: apology → real stage → real OUTCOME ──────────────
// The frames below are EXACTLY what src/server/stdout/claude-stream-json.js
// broadcasts for the real production sequence captured in a session buffer
// (system/status compacting → hook_started SessionStart:compact → system/status
// {status:null, compact_result:'success'}), plus one failure frame. The node
// suite pins that the server builds these; this one pins what the user reads.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(80);
    const hintEl = () => v._messageList.querySelector('.chat-ctx-full-hint');
    const fallback = hintEl().textContent.trim();
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: null, result: null, error: null });
    await sleep(60);
    const started = hintEl().textContent.trim();
    v._onCompactProgress({ event: 'hooks_start', hookType: 'SessionStart:compact', hint: null, result: null, error: null });
    await sleep(60);
    const stage1 = hintEl().textContent.trim();
    // the richer (declared) lane's hint still lands if a CLI ever forwards one
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: 'summarizing 812 messages', result: null, error: null });
    await sleep(60);
    const stage2 = hintEl().textContent.trim();
    const r = hintEl().getBoundingClientRect();
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null, result: 'success', error: null });
    await sleep(60);
    const ended = hintEl().textContent.trim();
    const rEnd = hintEl().getBoundingClientRect();
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null, result: 'error', error: 'ran out of context' });
    await sleep(60);
    const failedTxt = hintEl().textContent.trim();
    return { fallback, started, stage1, stage2, ended, failedTxt,
             w: Math.round(r.width), inViewport: r.left >= -1 && r.right <= innerWidth + 1,
             wEnd: Math.round(rEnd.width), endInViewport: rEnd.left >= -1 && rEnd.right <= innerWidth + 1 };
  })()`);
  check('before any stage record the card shows the hardcoded 1–2-minute apology (the FALLBACK, unchanged)', /1.2 minutes|1–2|1〜2|do not press Stop|不要按 Stop|Stop を押さないで/.test(m?.fallback || ''), m?.fallback);
  check("the wire's own compaction START (system/status 'compacting') replaces the apology with a live sentence", m?.started && m.started !== m.fallback && /Compact|压缩|圧縮/.test(m.started), m?.started);
  check('a hooks_start record names the hook phase (the one intermediate stage this lane has)', /SessionStart:compact/.test(m?.stage1 || '') && m.stage1 !== m.fallback, m?.stage1);
  check("a compact_start carries the CLI's own hint text into the card", /summarizing 812 messages/.test(m?.stage2 || ''), m?.stage2);
  // THE ROUND-4 BEHAVIOUR CHANGE, measured: the end of a compaction must not
  // silently revert to "this takes 1–2 minutes, do not press Stop" — the thing
  // it is describing already finished.
  check('compact_end reports the real OUTCOME and never falls back to the apology', m?.ended && m.ended !== m.fallback && /finish|完成|完了/.test(m.ended), JSON.stringify([m?.ended, m?.fallback]));
  check('…and a FAILED compaction says so, with the CLI’s own reason', /ran out of context/.test(m?.failedTxt || '') && m.failedTxt !== m.fallback, m?.failedTxt);
  check(`the hint fits the 375px viewport (${m?.w}px, no horizontal overflow)`, m?.inViewport === true && m?.w > 0 && m.w <= 375, m);
  check(`…and so does the outcome sentence (${m?.wEnd}px)`, m?.endInViewport === true && m?.wEnd > 0 && m.wEnd <= 375, m);
}

// ── ②b THE STAGE BELONGS TO ITS COMPACTION, NOT TO THE VIEW ────────────────
// Round 4 made a `compact_end` STICK (a card watching the compaction must not
// revert to "this takes 1–2 minutes" the moment it finished). Round-5 finding:
// nothing ever cleared it, so the FIRST compaction of a view — now including
// the AUTO one round 4 wired up, which no user action precedes — permanently
// replaced the guidance card's actionable sentence for the rest of the view's
// life. The exact frames the server builds for the production AUTO capture are
// replayed here with NO card on screen; the card is appended AFTERWARDS, and
// what it must read is the thing it exists to say.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    for (const el of [...v._messageList.querySelectorAll('.chat-ctx-full')]) el.closest('.chat-msg').remove();
    v._compactStage = null;
    v._renderers.setCompactStage(null);
    // THE PRODUCTION AUTO COMPACTION (data/session-buffers/sess-5-*.buf):
    // status compacting -> hook_started SessionStart:compact -> status null +
    // compact_result success. Nobody typed /compact; there is no card yet.
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: null, result: null, error: null });
    v._onCompactProgress({ event: 'hooks_start', hookType: 'SessionStart:compact', hint: null, result: null, error: null });
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null, result: 'success', error: null });
    await sleep(80);
    const held = JSON.stringify(v._compactStage);
    // ...and only NOW does the context fill up again
    const card = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(80);
    const hint = card.querySelector('.chat-ctx-full-hint');
    const later = hint.textContent.trim();
    const r = hint.getBoundingClientRect();
    const btn = card.querySelector('.chat-ctx-compact-btn');
    // NEGATIVE CONTROL 1: a card built while a compaction IS in flight still
    // opens on the live stage (that is what round 4 bought and must survive).
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: 'summarizing 812 messages', result: null, error: null });
    await sleep(60);
    const card2 = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    const liveNew = card2.querySelector('.chat-ctx-full-hint').textContent.trim();
    // NEGATIVE CONTROL 2: the card that WATCHED the compaction keeps its
    // outcome - the round-4 behaviour, unchanged.
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null, result: 'success', error: null });
    await sleep(60);
    const watchedEnd = card2.querySelector('.chat-ctx-full-hint').textContent.trim();
    // ...and a THIRD card, built after that end, is actionable again.
    const card3 = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    const third = card3.querySelector('.chat-ctx-full-hint').textContent.trim();
    for (const el of [card, card2, card3]) el.remove();
    return { held, later, liveNew, watchedEnd, third,
             hasBtn: !!btn, w: Math.round(r.width), inViewport: r.left >= -1 && r.right <= innerWidth + 1 };
  })()`);
  const APOLOGY = /1.2 minutes|1–2|1〜2|do not press Stop|不要按 Stop|Stop を押さないで/;
  check('the terminal stage is still HELD after the compaction (round 4: the last true thing we know)', /compact_end/.test(m?.held || ''), m?.held);
  check('…but a card built AFTER it opens on the actionable guidance, not on "Compaction finished."',
    APOLOGY.test(m?.later || '') && !/finish|完成|完了/.test(m?.later || ''), m?.later);
  check('…with its Compact-now button still there (the card is unchanged apart from the sentence)', m?.hasBtn === true, m);
  check('NEGATIVE CONTROL: a card built while a compaction is IN FLIGHT still opens on the live stage', /summarizing 812 messages/.test(m?.liveNew || ''), m?.liveNew);
  check('NEGATIVE CONTROL: the card that WATCHED the compaction keeps its outcome (round 4 preserved)', /finish|完成|完了/.test(m?.watchedEnd || ''), m?.watchedEnd);
  check('…and the next card after that end is actionable again (the stage never becomes the view’s permanent voice)', APOLOGY.test(m?.third || ''), m?.third);
  check(`the late card's hint still fits the 375px viewport (${m?.w}px)`, m?.inViewport === true && m?.w > 0 && m.w <= 375, m);
}

// ── ②c "ENDED" IS NOT "SUCCEEDED" ───────────────────────────────────────────
// The wire really produces a `compact_end` with NO outcome: a PreCompact hook
// that BLOCKS the compaction makes the CLI emit `sdk_status status:null` with
// no metadata at all, and the retained `compact_progress` lane hardcodes
// result:null on every frame. Nothing was compacted — the card must not say it
// finished.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    for (const el of [...v._messageList.querySelectorAll('.chat-ctx-full')]) el.closest('.chat-msg').remove();
    v._compactStage = null; v._renderers.setCompactStage(null);
    const card = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: null, result: null, error: null });
    await sleep(40);
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null, result: null, error: null });
    await sleep(60);
    const blocked = card.querySelector('.chat-ctx-full-hint').textContent.trim();
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null, result: 'success', error: null });
    await sleep(60);
    const success = card.querySelector('.chat-ctx-full-hint').textContent.trim();
    card.remove();
    return { blocked, success };
  })()`);
  check('a compact_end with NO outcome says the compaction ENDED, never that it finished (a hook-blocked compaction compacted nothing)',
    !!m?.blocked && !/finished|完成了|完了しました/.test(m.blocked) && /ended|结束|終了/i.test(m.blocked), m?.blocked);
  check('…while POSITIVE CONTROL compact_result:"success" does say it finished (the two are not collapsed)',
    /finish|完成|完了/.test(m?.success || '') && m.success !== m.blocked, JSON.stringify([m?.success, m?.blocked]));
}

// ── ②d A COMPACTION THAT ENDS WITHOUT AN OUTCOME RECORD (round 6) ───────────
// The three legs above feed the client frames written BY HAND, which can only
// prove "we render them right". This one asks the REAL server consumer
// (src/server/stdout/claude-stream-json.js, over a fake pty) what it actually
// broadcasts for a compaction that ends the way a hook-blocked one does — no
// `status:null` outcome record, just the turn finishing — and replays THOSE
// frames into the real client. Before round 6 the producer said nothing at
// that exit: the client kept `hooks_start` forever, `compactInFlight()` stayed
// true, and every later "Prompt is too long" card lost the rewind-and-retry
// sentence it exists to give (reproduced on this engine: frames
// ["hooks_start"], _streamingKind null, no compact_end).
{
  const frames = (() => {
    const out = [];
    const stub = () => { };
    const consumer = require(path.join(repo, 'src/server/stdout/claude-stream-json.js')).create({
      activeSessions: new Map(), CLAUDE_STREAM_TYPES: new Set(['system', 'assistant', 'user', 'result']),
      _seenStreamTypes: new Set(), USAGE_SCANNER_PATH: '/nonexistent', checkClaudeGoalStatus: stub,
      noteModelSeen: stub, sbSeenFirst: () => true, hosts: null, usageHistory: null,
      engine: {
        _vsuPending: new Map(), armWorkflowUsageWatcher: stub, kickPoolEval: stub, markLimitBanner: stub,
        maybeRepinLockedModel: stub, maybeStopOnFallback: stub, notePoolAuthFailure: stub, modelsMatch: () => false,
        noteSessionProduced: stub, noteTurnEnd: stub, recordRateLimitEvent: stub, resolveUsageKey: () => '__g__',
        usageEstimator: { noteLive: stub },
      },
    });
    const pty = { data: null, onData(cb) { pty.data = cb; }, onExit: stub };
    const session = { mode: 'chat', backend: 'claude', cwd: '/tmp', sockName: 'cw-ui-compact', buffer: '', createdAt: Date.now(), _normalizer: { processLive: stub, listeners: [] } };
    consumer.attach(session, 'ui-compact', pty, {
      feedLive: stub, broadcastActiveSessions: stub, readSessionMeta: () => ({}), writeSessionMeta: stub,
      updateSessionTodos: stub, applyTaskToolUpdate: stub, emitTaskListTodos: stub,
      broadcastToSession: (s, id, msg) => { if (msg.type === 'compact-progress') out.push(msg); },
    });
    // ws-handler.js's `/compact` send site, then a PreCompact hook, then the
    // turn simply ends — the shape a BLOCKED compaction leaves on the wire.
    session._streamingKind = 'compacting';
    pty.data(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'PreCompact:guard', session_id: 'sid-ui' }) + '\n');
    pty.data(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sid-ui', duration_ms: 1 }) + '\n');
    return out.map(({ event, hookType, hint, result, error }) => ({ event, hookType, hint, result, error }));
  })();
  check(`the REAL producer terminates the compaction it opened (frames ${JSON.stringify(frames.map((f) => f.event))})`,
    frames.length === 2 && frames[0].event === 'hooks_start' && frames[1].event === 'compact_end' && frames[1].result === null,
    JSON.stringify(frames));
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    for (const el of [...v._messageList.querySelectorAll('.chat-ctx-full')]) el.closest('.chat-msg').remove();
    v._compactStage = null; v._renderers.setCompactStage(null);
    const frames = ${JSON.stringify(frames)};
    const card = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    // CONTROL: mid-compaction (only the frames produced so far) the card really
    // is on the live stage — the terminal frame is what changes, not the lane.
    v._onCompactProgress(frames[0]);
    await sleep(60);
    const mid = card.querySelector('.chat-ctx-full-hint').textContent.trim();
    const midInFlight = v._renderers.compactInFlight();
    const midCard = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(40);
    const midLater = midCard.querySelector('.chat-ctx-full-hint').textContent.trim();
    for (const f of frames.slice(1)) v._onCompactProgress(f);
    await sleep(60);
    const watched = card.querySelector('.chat-ctx-full-hint').textContent.trim();
    const endInFlight = v._renderers.compactInFlight();
    const later = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    const laterTxt = later.querySelector('.chat-ctx-full-hint').textContent.trim();
    const r = later.querySelector('.chat-ctx-full-hint').getBoundingClientRect();
    for (const el of [card, midCard, later]) el.remove();
    return { mid, midInFlight, midLater, watched, endInFlight, laterTxt,
             w: Math.round(r.width), inViewport: r.left >= -1 && r.right <= innerWidth + 1 };
  })()`);
  const APOLOGY = /1.2 minutes|1–2|1〜2|do not press Stop|不要按 Stop|Stop を押さないで/;
  check('CONTROL: while the hook stage is the last frame the compaction IS in flight — the card names the hook, and a card built then joins it',
    m?.midInFlight === true && /PreCompact:guard/.test(m?.mid || '') && /PreCompact:guard/.test(m?.midLater || ''), JSON.stringify([m?.mid, m?.midLater]));
  check('the producer’s terminal frame ends it: the watching card says the compaction ENDED (never still "running … hooks")',
    !/hooks/i.test(m?.watched || '') && /ended|结束|終了/i.test(m?.watched || '') && !/finished|完成了|完了しました/.test(m?.watched || ''), m?.watched);
  check('…compactInFlight() is false again, so a card built AFTERWARDS opens on the rewind-and-retry guidance the user actually needs',
    m?.endInFlight === false && APOLOGY.test(m?.laterTxt || '') && !/hooks/i.test(m?.laterTxt || ''), JSON.stringify([m?.endInFlight, m?.laterTxt]));
  check(`…and that sentence still fits the 375px viewport (${m?.w}px)`, m?.inViewport === true && m?.w > 0 && m.w <= 375, m);
}

// ── ②d SESSION DEATH IS THE THIRD EXIT (round 7) ──────────────────────
// The wrapper dies mid-compaction: no outcome record, no turn end, nothing —
// the producer is gone, so no frame can ever arrive. Before this the view kept
// the last mid-compaction frame forever (compactInFlight() true), and every
// later guidance card opened on "Compacting: running <hook> hooks…" for a
// process that no longer exists. Measured on the real client at 375×667.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    for (const el of [...v._messageList.querySelectorAll('.chat-ctx-full')]) el.closest('.chat-msg').remove();
    v._compactStage = null; v._renderers.setCompactStage(null);
    // mid-compaction, exactly the shape the server broadcasts
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: null, result: null, error: null });
    v._onCompactProgress({ event: 'hooks_start', hookType: 'PreCompact:guard', hint: null, result: null, error: null });
    const watching = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    const midTxt = watching.querySelector('.chat-ctx-full-hint').textContent.trim();
    const midInFlight = v._renderers.compactInFlight();
    // …and now the session dies. THE call the 'exited' branch makes.
    const retired = v._retireLiveClaims();
    await sleep(60);
    const watchedTxt = watching.querySelector('.chat-ctx-full-hint').textContent.trim();
    const endInFlight = v._renderers.compactInFlight();
    const later = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    const laterTxt = later.querySelector('.chat-ctx-full-hint').textContent.trim();
    // NEGATIVE CONTROL: a view that never compacted must not be made to claim
    // one ended. Fresh state, same call.
    v._compactStage = null; v._renderers.setCompactStage(null);
    const retiredAgain = v._retireLiveClaims();
    const virgin = v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(60);
    const virginTxt = virgin.querySelector('.chat-ctx-full-hint').textContent.trim();
    const r = later.querySelector('.chat-ctx-full-hint').getBoundingClientRect();
    for (const el of [watching, later, virgin]) el.remove();
    return { midTxt, midInFlight, retired, watchedTxt, endInFlight, laterTxt, retiredAgain, virginTxt,
             stage: JSON.stringify(v._compactStage), w: Math.round(r.width), inViewport: r.left >= -1 && r.right <= innerWidth + 1 };
  })()`);
  const APOLOGY2 = /1.2 minutes|1–2|1〜2|do not press Stop|不要按 Stop|Stop を押さないで/;
  check('CONTROL: mid-compaction the card really is holding a LIVE stage (the failure needs something to get stuck on)',
    m?.midInFlight === true && /PreCompact:guard/.test(m?.midTxt || ''), JSON.stringify([m?.midInFlight, m?.midTxt]));
  check('session death RETIRES the stage: the watching card stops claiming a compaction is running',
    m?.retired === true && m?.endInFlight === false && !/hooks/i.test(m?.watchedTxt || ''), JSON.stringify([m?.retired, m?.endInFlight, m?.watchedTxt]));
  check('…and it says ENDED, never FINISHED — nothing told us the compaction worked (round 5’s law at the third exit)',
    /ended|结束|終了/i.test(m?.watchedTxt || '') && !/finished|完成了|完了しました/.test(m?.watchedTxt || ''), m?.watchedTxt);
  check('…so a card built after the session died opens on the rewind-and-retry guidance again',
    APOLOGY2.test(m?.laterTxt || '') && !/hooks/i.test(m?.laterTxt || ''), m?.laterTxt);
  check('NEGATIVE CONTROL: a view that never compacted is NOT made to claim one ended (the retirement is guarded, not unconditional)',
    m?.retiredAgain === false && APOLOGY2.test(m?.virginTxt || '') && !/ended|结束|終了/i.test(m?.virginTxt || ''), JSON.stringify([m?.retiredAgain, m?.virginTxt]));
  check(`…and the restored guidance still fits the 375px viewport (${m?.w}px)`, m?.inViewport === true && m?.w > 0 && m.w <= 375, m);
}

// ── ③ retraction: two kinds, two treatments ─────────────────────────────────
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const users = v._messages.filter((x) => x.role === 'user');
    const assts = v._messages.filter((x) => x.role === 'assistant');
    const rollbackId = users[users.length - 1].id, supersededId = assts[assts.length - 1].id;
    v._applyRewound({ harness: 'codex', numTurns: 1, ids: [rollbackId], kind: 'rollback', ts: Date.now() });
    v._applyRewound({ harness: 'claude', toMessageId: supersededId, ids: [supersededId], kind: 'superseded', ts: Date.now() });
    await sleep(120);
    const rb = v._elements.get(rollbackId), sup = v._elements.get(supersededId);
    const rbCs = getComputedStyle(rb), supCs = getComputedStyle(sup);
    const rbRect = rb.getBoundingClientRect();
    const tag = rb.querySelector('.chat-rewound-tag');
    // idempotence: the same op again (a reconnect replay) must not double the tag
    v._applyRewound({ harness: 'codex', numTurns: 1, ids: [rollbackId], kind: 'rollback', ts: Date.now() });
    await sleep(60);
    return {
      rollbackVisible: supCs.display === 'none' ? true : true,
      rbDisplay: rbCs.display, rbOpacity: Number(rbCs.opacity), rbH: Math.round(rbRect.height),
      rbInViewport: rbRect.left >= -1 && rbRect.right <= innerWidth + 1,
      supDisplay: supCs.display,
      tagText: tag ? tag.textContent.trim() : null,
      tagCount: rb.querySelectorAll('.chat-rewound-tag').length,
      modelRewound: v._messages.find((x) => x.id === rollbackId)?.rewound || null,
    };
  })()`);
  check('a codex ROLLBACK stays on screen, dimmed (hiding it would silently rewrite what the reader remembers)', m?.rbDisplay !== 'none' && m?.rbH > 0 && m?.rbOpacity > 0 && m.rbOpacity < 1, m);
  check('…wearing a "rewound" tag that says why', !!m?.tagText, m?.tagText);
  check('a claude TOMBSTONE is REMOVED instead — the CLI\'s own instruction for a superseded partial', m?.supDisplay === 'none', m?.supDisplay);
  check('the op is idempotent: a replayed op does not stack a second tag', m?.tagCount === 1, String(m?.tagCount));
  // The model field is a PRECONDITION for leg ⑤, not evidence — "so a
  // re-render keeps it" was the claim the round-2 verifier falsified (the
  // replacement paths dropped the DOM mark while this field stayed set).
  check('…and the client message model carries the mark too (the precondition leg ⑤ then MEASURES)', m?.modelRewound === 'rollback', String(m?.modelRewound));
  check(`the struck message still fits the 375px viewport (h=${m?.rbH})`, m?.rbInViewport === true, m);
}

// ── ④ the tool-granular run set — DORMANT, and pinned as dormant ────────────
// Round 4: no harness reports one today (caps.inProgressTools is false
// everywhere — claude's record never leaves the CLI's host callback, measured
// on the wire by test-stdout-registry's leg ⓕ). These legs therefore describe
// CODE, not a shipped user-visible behaviour: they keep the rendering honest
// for the day a harness does report a run set, and the caps row is what stops
// any surface from claiming the dot in the meantime. The first assert below is
// the honesty pin — if a caps row ever turns true, this leg's framing must be
// revisited together with it.
{
  {
    const { capsOf, BACKEND_CAPS } = require(path.join(repo, 'src/backend-caps.js'));
    check('this leg exercises DORMANT code: no harness declares inProgressTools, so no user sees a dot today',
      Object.values(BACKEND_CAPS).every((r) => r.inProgressTools === false) && capsOf('claude').inProgressTools === false,
      'a harness now claims a run set — re-read this leg: it is written as "the code is ready", not "the user sees this"');
  }
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const cards = [...v._messageList.querySelectorAll('[data-tool-id]')];
    const ids = cards.map((c) => c.dataset.toolId);
    v._onToolsInProgress([ids[0]]);
    await sleep(80);
    const marked = cards.map((c) => c.classList.contains('chat-tool-inflight'));
    const dot = cards[0].querySelector('.chat-tool-label') ? getComputedStyle(cards[0].querySelector('.chat-tool-label'), '::after').content : '(no label)';
    v._onToolsInProgress([]);
    await sleep(60);
    const cleared = cards.map((c) => c.classList.contains('chat-tool-inflight'));
    return { n: cards.length, ids, marked, cleared, dot };
  })()`);
  check(`the fixture has two pending tool cards (${m?.n})`, m?.n === 2, m);
  check('only the tool the harness says is EXECUTING is marked — a pending card is not a running one (it may be sitting on a permission prompt)', JSON.stringify(m?.marked) === '[true,false]', m);
  check('…and the resolved set is authoritative: an empty set clears every mark (a delta record, a resolved view)', JSON.stringify(m?.cleared) === '[false,false]', m);
}

// ── ⑤ EVERY per-element mark survives EVERY rebuild ─────────────────────────
//    Round-2 finding, reproduced here before the fix: a mark written straight
//    to the DOM at its origin (`_applyRewound`, `_onToolsInProgress`) died at
//    the next element REPLACEMENT, and three code paths build an element for a
//    message. The claude tombstone case ALWAYS gets one — the message it
//    retracts is a streaming partial, and MessageManager._finalizeStreaming
//    emits `{op:'edit', fields:{status:'complete'}}` for exactly that message
//    at the next `result`. Measured as COMPUTED STYLE (the no-global-.hidden
//    law: never by the class being present), at 375×667, with two negative
//    controls that must stay unmarked through all of it.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const assts = v._messages.filter((x) => x.role === 'assistant');
    const users = v._messages.filter((x) => x.role === 'user');
    const supId = assts[assts.length - 1].id;   // marked 'superseded' in leg ③
    const rbId = users[users.length - 1].id;    // marked 'rollback' in leg ③
    const ctrlId = assts[0].id;                 // NEGATIVE CONTROL: never retracted
    const cards = [...v._messageList.querySelectorAll('[data-tool-id]')];
    const msgA = cards[0].dataset.msgId, msgB = cards[1].dataset.msgId;
    v._onToolsInProgress([cards[0].dataset.toolId]); // A executes, B only pends
    await sleep(80);
    const styleOf = (id) => {
      const el = v._elements.get(id); if (!el) return { gone: true };
      const cs = getComputedStyle(el);
      return { display: cs.display, opacity: Number(cs.opacity), tags: el.querySelectorAll('.chat-rewound-tag').length };
    };
    const dotOf = (id) => {
      const el = v._elements.get(id); if (!el) return { gone: true };
      const lab = el.querySelector('.chat-tool-label');
      const af = lab ? getComputedStyle(lab, '::after') : null;
      return { cls: el.classList.contains('chat-tool-inflight'), content: af ? af.content : '(no label)', w: af ? af.width : '(no label)' };
    };
    const shot = () => ({ sup: styleOf(supId), rb: styleOf(rbId), ctrl: styleOf(ctrlId), toolA: dotOf(msgA), toolB: dotOf(msgB) });
    const s0 = shot();
    // ① the status-transition re-render inside _onEditMessage
    for (const id of [supId, rbId, ctrlId, msgA, msgB]) v._onOp({ op: 'edit', id, fields: { status: 'complete' } });
    await sleep(160);
    const s1 = shot();
    // ② _rerenderVisible — the full rebuild a compact-mode toggle runs
    v._rerenderVisible();
    await sleep(160);
    const s2 = shot();
    // ③ the CREATE path — page out and back in, exactly what a trim followed
    //    by _extendTop does (_renderDetached → _onCreateMessage)
    v._loadingHistory = true;
    for (const id of [supId, rbId, ctrlId, msgA, msgB]) {
      const el = v._elements.get(id), msg = v._messages.find((x) => x.id === id);
      const anchor = el.nextSibling;
      v._renderedMsgIds.delete(id); v._elements.delete(id); el.remove();
      const fresh = v._renderDetached(msg);
      if (fresh) v._messageList.insertBefore(fresh, anchor);
    }
    v._loadingHistory = false;
    await sleep(160);
    const s3 = shot();
    return { s0, s1, s2, s3, inflightStillHeld: !!(v._inFlightTools && v._inFlightTools.has(cards[0].dataset.toolId)) };
  })()`);
  const stages = m ? [m.s0, m.s1, m.s2, m.s3] : [];
  const names = ['before any rebuild', 'after the _onEditMessage status re-render', 'after _rerenderVisible', 'after a page-out/page-in (create path)'];
  const supHidden = stages.map((s) => s?.sup?.display);
  check(`the tombstoned partial stays REMOVED through all three rebuilds (computed display: ${JSON.stringify(supHidden)}) — an edit op used to bring a retracted answer back on screen`, supHidden.length === 4 && supHidden.every((d) => d === 'none'), JSON.stringify(m?.s1?.sup));
  const rbOk = stages.map((s) => s?.rb).every((r) => r && r.display !== 'none' && r.opacity > 0 && r.opacity < 1 && r.tags === 1);
  check(`…and the rollback stays struck: dimmed, exactly one tag, at every stage (${JSON.stringify(stages.map((s) => [s?.rb?.opacity, s?.rb?.tags]))})`, rbOk, JSON.stringify(stages.map((s) => s?.rb)));
  const dotOk = stages.map((s) => s?.toolA).every((d) => d && d.cls === true && d.w === '6px');
  check(`the EXECUTING tool keeps its dot through all three rebuilds (computed ::after width: ${JSON.stringify(stages.map((s) => s?.toolA?.w))}) — for a long-running tool no second delta ever comes`, dotOk, JSON.stringify(stages.map((s) => s?.toolA)));
  check('…and the view still holds the id, so the dot is re-derived from state, not remembered by an element', m?.inflightStillHeld === true, JSON.stringify(m?.inflightStillHeld));
  const ctrlOk = stages.map((s) => s?.ctrl).every((c) => c && c.display !== 'none' && c.opacity === 1 && c.tags === 0);
  check(`NEGATIVE CONTROL: a message that was never retracted is untouched by every rebuild (${JSON.stringify(stages.map((s) => [s?.ctrl?.display, s?.ctrl?.opacity, s?.ctrl?.tags]))})`, ctrlOk, JSON.stringify(stages.map((s) => s?.ctrl)));
  const ctrlDotOk = stages.map((s) => s?.toolB).every((d) => d && d.cls === false && d.w !== '6px');
  check(`NEGATIVE CONTROL: the PENDING-but-not-executing tool never gains a dot on a rebuild (${JSON.stringify(stages.map((s) => s?.toolB?.w))}) — re-deriving must not mark everything`, ctrlDotOk, JSON.stringify(stages.map((s) => s?.toolB)));
}

// ── ⑥ the FOURTH builder: the huge-session gap/seek renderer ───────────────
//    Round-3 finding, reproduced here before the fix. `_renderGapMsg`
//    (chat-view-seek.js) builds a message element for every record of a seek
//    slab and applied NONE of the per-element marks — it carries only
//    `.chat-gap-msg`, `dataset.line` and `dataset.ts`, and its elements never
//    enter `this._elements`, which is the set leg ⑤'s hook is keyed to.
//    REACHABILITY IS REAL, and it is exactly the case §2.10 exists for: codex
//    carries `thread_rolled_back` in the ROLLOUT (verified on the owner's two
//    real rollouts), the server's `gapSlab` normalizes the slab through the
//    same message manager, so a slab genuinely arrives with `rewound` set —
//    and past 34MB (JSONL_HEAD_BYTES + JSONL_TAIL_BYTES) the seek path is the
//    ONLY way to read that history. The reader could not tell the agent had
//    taken those turns back.
//    Measured the way leg ⑤ is: COMPUTED STYLE off a gap element that is IN
//    the document (a detached element has no computed style), with the same
//    two negative controls.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const assts = v._messages.filter((x) => x.role === 'assistant');
    const users = v._messages.filter((x) => x.role === 'user');
    const supMsg = assts[assts.length - 1];  // 'superseded' (marked in leg ③)
    const rbMsg = users[users.length - 1];   // 'rollback'   (marked in leg ③)
    const ctrlMsg = assts[0];                // NEGATIVE CONTROL: never retracted
    const cards = [...v._messageList.querySelectorAll('[data-tool-id]')].filter((c) => !c.classList.contains('chat-gap-msg'));
    const toolA = v._messages.find((x) => x.id === cards[0].dataset.msgId);
    const toolB = v._messages.find((x) => x.id === cards[1].dataset.msgId);
    v._onToolsInProgress([cards[0].dataset.toolId]); // A executes, B only pends
    await sleep(80);
    // Render each through the GAP path and put it in the document, exactly as
    // _loadEarlierGap does (it inserts before the sentinel; the parent is the
    // same message list either way).
    const built = [];
    const gap = (msg) => { const el = v._renderGapMsg(msg); if (el) { v._messageList.appendChild(el); built.push(el); } return el; };
    const supEl = gap(supMsg), rbEl = gap(rbMsg), ctrlEl = gap(ctrlMsg), aEl = gap(toolA), bEl = gap(toolB);
    await sleep(140);
    const styleOf = (el) => { if (!el) return { gone: true }; const cs = getComputedStyle(el); return { display: cs.display, opacity: Number(cs.opacity), tags: el.querySelectorAll('.chat-rewound-tag').length }; };
    const dotOf = (el) => { if (!el) return { gone: true }; const lab = el.querySelector('.chat-tool-label'); const af = lab ? getComputedStyle(lab, '::after') : null; return { cls: el.classList.contains('chat-tool-inflight'), w: af ? af.width : '(no label)' }; };
    const out = {
      n: built.length,
      gapClass: built.every((e) => e.classList.contains('chat-gap-msg')),
      notInElements: built.every((e) => ![...v._elements.values()].includes(e)),
      sup: styleOf(supEl), rb: styleOf(rbEl), ctrl: styleOf(ctrlEl),
      toolA: dotOf(aEl), toolB: dotOf(bEl),
      rbRect: rbEl ? (() => { const r = rbEl.getBoundingClientRect(); return { w: Math.round(r.width), inViewport: r.left >= -1 && r.right <= innerWidth + 1 }; })() : null,
      modelMarks: [supMsg.rewound || null, rbMsg.rewound || null, ctrlMsg.rewound || null],
    };
    for (const e of built) e.remove();  // leave the live view exactly as found
    return out;
  })()`);
  check(`the gap renderer built all five elements and they are gap elements OUTSIDE _elements (${JSON.stringify([m?.n, m?.gapClass, m?.notInElements])})`,
    m?.n === 5 && m?.gapClass === true && m?.notInElements === true, m);
  check(`a tombstoned partial reached through a GAP SLAB is REMOVED, like everywhere else (computed display: ${m?.sup?.display})`,
    m?.sup?.display === 'none', JSON.stringify(m?.sup));
  check(`…a codex ROLLBACK reached through a gap slab is struck in place: dimmed, exactly one tag (${JSON.stringify([m?.rb?.display, m?.rb?.opacity, m?.rb?.tags])})`,
    m?.rb && m.rb.display !== 'none' && m.rb.opacity > 0 && m.rb.opacity < 1 && m.rb.tags === 1, JSON.stringify(m?.rb));
  check(`…and the EXECUTING tool card keeps its dot on the gap path too (computed ::after width: ${m?.toolA?.w})`,
    m?.toolA?.cls === true && m?.toolA?.w === '6px', JSON.stringify(m?.toolA));
  check(`NEGATIVE CONTROL: a never-retracted message renders through the gap path untouched (${JSON.stringify([m?.ctrl?.display, m?.ctrl?.opacity, m?.ctrl?.tags])})`,
    m?.ctrl && m.ctrl.display !== 'none' && m.ctrl.opacity === 1 && m.ctrl.tags === 0, JSON.stringify(m?.ctrl));
  check(`NEGATIVE CONTROL: the PENDING-but-not-executing tool gains no dot on the gap path (${m?.toolB?.w})`,
    m?.toolB?.cls === false && m?.toolB?.w !== '6px', JSON.stringify(m?.toolB));
  check(`the struck gap message still fits the 375px viewport (w=${m?.rbRect?.w})`, m?.rbRect?.inViewport === true, JSON.stringify(m?.rbRect));
  check('…and the model marks are unchanged by the gap render (it READS view state, it must never write it)',
    JSON.stringify(m?.modelMarks) === '["superseded","rollback",null]', JSON.stringify(m?.modelMarks));
}

// ── ⑦ SESSION DEATH RETIRES THE CHIP AND THE DOT (round 8) ────────────────
//    The behaviour behind ⓪b's wiring pin, measured on the real client and
//    driven through the REAL dispatcher, because the defect IS the dispatcher
//    branch — calling the retirement directly would exercise the method while
//    the bug lives one level up (that is exactly how round 7 shipped it).
//    Failure mode: a session terminated or crashed while the turn was PARKED
//    keeps a pulsing "waiting for you — the turn is paused, not finished
//    (reported by the harness)" chip forever, on a dead session.
//
//    `window.__v` CANNOT be used for this: a view-only ChatView installs a
//    MINIMAL handler (`msg` ops only, chat-view.js's `if (this._readOnly)`
//    early return), so it never receives a turn-state push in the first place
//    — the claims only exist on a LIVE view. So this leg builds one the way
//    session-lifecycle does (`new ChatView(winInfo, app.ws, id, app)`, no
//    options = live) on its own window, and closes it again. No session is
//    spawned: the frames are the ws frames the server sends, fed to the real
//    `_handler`, which is the code under test.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const CV = window.__v.constructor;
    const app = window.app;
    const SID = 'live-b3r8-' + Date.now().toString(36);
    const win = app.wm.createWindow({ title: 'turn-truth live', type: 'chat' });
    const live = new CV(win, app.ws, SID, app);
    window.__live = { view: live, winId: win.id };
    await sleep(200);
    const sb = live._statusBar;
    const chips = () => sb._element.querySelectorAll('.chat-status-turnstate').length;
    const built = { handler: typeof live._handler === 'function', readOnly: !!live._readOnly, chips: chips() };
    // a tool card to carry the executing dot. CLONED from a message the real
    // normalizer produced for the fixture (never a hand-written shape — the
    // "fixture self-consistent but production dead" class), re-identified so
    // it is this view's own message.
    const srcCard = [...window.__v._messageList.querySelectorAll('[data-tool-id]')].filter((c) => !c.classList.contains('chat-gap-msg'))[0];
    const src = window.__v._messages.find((x) => x.id === srcCard.dataset.msgId);
    const clone = JSON.parse(JSON.stringify(src));
    clone.id = 'live-tool-msg-1';
    const toolId = srcCard.dataset.toolId;
    live._onCreateMessage(clone);
    await sleep(120);
    const card = live._messageList.querySelector('[data-tool-id="' + toolId + '"]');
    const dot = () => (card ? card.classList.contains('chat-tool-inflight') : null);
    // THE HARNESS PARKS THE TURN — the exact ws frames the server broadcasts
    live._handler({ type: 'streaming-label', sessionId: SID, label: 'running Bash', kind: null });
    live._handler({ type: 'turn-state', sessionId: SID, state: 'requires_action' });
    live._handler({ type: 'tools-in-progress', sessionId: SID, ids: [toolId] });
    await sleep(160);
    const parked = { chips: chips(), state: sb._turnState, dot: dot(),
      text: (sb._element.querySelector('.chat-status-turnstate') || {}).textContent || '' };
    // NEGATIVE CONTROL: ANOTHER session's death must change nothing here
    live._handler({ type: 'exited', sessionId: SID + '-someone-else', reason: null, detail: 'not ours' });
    await sleep(120);
    const other = { chips: chips(), state: sb._turnState, dot: dot(), readOnly: !!live._readOnly };
    // …and now THIS session dies
    live._handler({ type: 'exited', sessionId: SID, reason: null, detail: 'wrapper died' });
    await sleep(200);
    const dead = { chips: chips(), state: sb._turnState, dot: dot(),
      held: live._inFlightTools ? live._inFlightTools.size : -1,
      readOnly: !!live._readOnly,
      ended: /Session ended|会话已结束|セッションが終了/.test(live._messageList.textContent || '') };
    // teardown: only the window this chain created (never a heuristic match)
    try { live.dispose(); } catch (e) {}
    try { app.wm.closeWindow(window.__live.winId); } catch (e) {}
    window.__live = null;
    return { built, parked, other, dead };
  })()`);
  check(`CONTROL: a LIVE ChatView was built (full dispatcher, not the read-only stub) with no chip on it yet (${JSON.stringify(m?.built)})`,
    m?.built?.handler === true && m?.built?.readOnly === false && m?.built?.chips === 0, JSON.stringify(m?.built));
  check(`CONTROL: the harness parked the turn, so the chip is UP before the session dies (${JSON.stringify(m?.parked)})`,
    m?.parked?.chips === 1 && m?.parked?.state === 'requires_action' && /waiting for you|等你操作|あなた待ち/.test(m?.parked?.text || ''), JSON.stringify(m?.parked));
  check('CONTROL: …and the executing-tool dot is on the card too (the dormant twin of the same claim)', m?.parked?.dot === true, JSON.stringify(m?.parked));
  check('NEGATIVE CONTROL: ANOTHER session dying leaves this view untouched — the retirement is session-scoped, never unconditional',
    m?.other?.chips === 1 && m?.other?.state === 'requires_action' && m?.other?.dot === true && m?.other?.readOnly === false, JSON.stringify(m?.other));
  check('session death RETIRES the "waiting for you" chip — a pulsing claim about RIGHT NOW must not outlive its producer',
    m?.dead?.chips === 0 && m?.dead?.state === null, JSON.stringify(m?.dead));
  check('…and the executing-tool dot goes with it (nothing is executing inside a process that is gone)',
    m?.dead?.dot === false && m?.dead?.held === 0, JSON.stringify(m?.dead));
  check('…while the rest of the branch is unchanged: the session-ended notice is written and the view went read-only',
    m?.dead?.ended === true && m?.dead?.readOnly === true, JSON.stringify(m?.dead));
}

check('no uncaught page exceptions during the measurement', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done();
