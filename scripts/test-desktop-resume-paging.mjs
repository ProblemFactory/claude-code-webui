#!/usr/bin/env node
// DESKTOP-RESUME PAGING (inc-mtq5bpjt-0o0n, owner: "切换桌面后，新桌面的窗口
// 内容跳到历史消息了"). Three chat windows, all PINNED at the live tail before
// their desktop was hidden, came back at scrollTop 0 with the tail TRIMMED
// AWAY — with zero user input (the capture's wheelAgo was 1.8M-4.7M ms).
//
// Mechanism: the gap sentinel's IntersectionObserver (rootMargin 300px) is a
// PURELY GEOMETRIC trigger. On resume, desktop-manager._showWin clears
// content-visibility:hidden, the subtree re-measures, scrollTop transits
// through 0 while still pinned, the sentinel intersects → _loadEarlierGap →
// its tail-mode branch called _extendTop() with NO intent/pin/settle/suspend
// gate at all — the one upward-paging entry point the 2.301→2.339 gates never
// covered. _extendTop's completion then trimBottom'd the live tail away
// (windowEnd < total), the anchor restore failed under transitional geometry
// (anchored:false) and the view landed at scrollTop 0, unpinned.
//
// This drives the REAL path end to end: a >34MB transcript (so the server
// reports a gap and the client installs the seek sentinel — the sentinel is
// what makes the failure reachable at all), a chat window pinned at the tail
// on desktop B, switch away, switch back, and watch the tracer.
//
// NEGATIVE CONTROL: the same run against a worktree whose gates are patched
// out at SOURCE level must page up on the resume AND through the sentinel
// probe — otherwise the harness proves nothing (a green test that never
// touches the path is worse than no test).
//
// ROUND 2 adds two more repros on the same window: a reader who NAVIGATES
// during the settle (minimap / search reveal / run bar / jumpToIndex — none of
// them touch the message list's own listeners) must be left where they landed,
// and an input-less displacement ANYWHERE in the resume horizon (1240 / 1400 /
// 1900 / 2400 ms) must end pinned at the tail while a real wheel-up in that
// same horizon still pages. Their negative controls are per-mechanism and run
// on the FIXED build (the source-level control rebuilds with
// RESUME_SETTLE_MS = 0, which cannot host a timing-dependent repro).
//
// ROUND 3 adds three TRUSTED-INPUT legs (§4b): everything above dispatches
// synthetic events or writes scrollTop, and the finding this branch fixes was
// only visible with REAL input — a plain left-click during the settle used to
// run the full _endResumeSettle() and hand the resume's own displacement a
// stranded window. Input.dispatchMouseEvent is also the only way to touch a
// native scrollbar, which has no DOM node to dispatch to.
//
// ROUND 4 adds two more, against the round-3 drag SIGNATURE ("a scroll within
// 400ms of a pointerdown that moved the view"): ① a click at +300ms with the
// resume's own input-less displacement at +450ms — inside that window, so the
// click's displacement was read as a "drag", disarmed the repair and
// reproduced the incident (the round-3 leg passed only because it injected at
// +1400ms); ② a scrollbar drag whose first move comes 900ms after the press —
// outside the window, so it was never positioning and the re-tail yanked that
// reader back (a NEW harm vs master). The drag is now keyed on WHERE the press
// landed (the scrollbar gutter), held for the whole press.
//
// ROUND 5 (B-9702) tightens the round-2 "a REAL wheel-up at +1400ms still
// pages" leg and adds the mechanism it was blind to. That leg asserted only
// that SOMETHING paged, on the stated reasoning that the final pin state was
// "not this gate's to decide" — and run 20x it ended with the reader dragged
// back to the live tail 5 times: the +1240ms re-tail rung's own
// _forceScrollToBottom chain was still writing scrollTop = scrollHeight and one
// of its frames landed 3ms AFTER the reader's wheel, so the pin re-engaged off
// OUR OWN write. It now asserts the READER'S OUTCOME on a settled snapshot,
// and a second leg arms that chain by hand (deterministic) with the cancel
// neutered on the instance as its control. An assert that will not name the
// user-visible outcome is where a residue hides.
//
// IN THE RELEASE GATE (scripts/ci.mjs) despite being heavy — two chrome runs
// and two bundle builds, ~3.5 min here after round 3: this is the only place
// the whole path is exercised end to end, and its negative controls are what
// prove the harness touches it at all. The cheap in-gate pins live in
// test-chat-trim-guard.mjs (the browser-suite budget in ci.mjs is 600s).
// Run: node scripts/test-desktop-resume-paging.mjs   (SKIPs without chrome)
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import { freePort, scratch, scratchHome, fixtureSid } from './scratch.mjs';
const require = createRequire(import.meta.url);
const { fixtureLitter } = require('../src/fixture-guard.js');

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

// FREE ports (2.369.51): two copies of this suite (a parallel agent's gate + the
// release gate) collided on 3989/9339 — the loser's server never bound, its chrome
// talked to the OTHER copy's server, and the source-level negative control probed an
// unpatched bundle → 4 phantom reds on a green commit.
const PORT = await freePort(), CDP_PORT = await freePort();
// EVERY path here comes from scripts/scratch.mjs, which mints them from the ONE
// fixture convention in src/fixture-guard.js (2026-09-09). This suite already
// ran the server under an isolated HOME — it is the template the other two were
// fixed to — but its paths were hand-spelled, so a rename here would have
// walked out from under the production walk/discovery guard and the standing
// sweep without either noticing.
const wt = scratch('deskresume');
const fakeHome = scratchHome('deskresume-home', fs);
const chromeDir = scratch('deskresume-chrome');
const CWD = scratch('deskresume-cwd');
const SID = fixtureSid('d1');
const PROJ = path.join(fakeHome, '.claude', 'projects', CWD.replace(/[/._]/g, '-'));
const REAL_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const realBefore = (() => { try { return new Set(fs.readdirSync(REAL_PROJECTS)); } catch { return new Set(); } })();
let failed = 0, passed = 0;   // COUNTED, not a hand-maintained constant (the pre-round-2 label said 15 for 16 checks)
const check = (n, c, e) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. synthetic transcript > 34MB (JSONL_HEAD 2MB + JSONL_TAIL 32MB is the
//      threshold below which jsonlGapInfo returns null — no gap, no sentinel,
//      no bug). Fat tool outputs so the rendered 50-message tail is much
//      TALLER than the viewport: the sentinel must NOT already be intersecting
//      at load, or the "before" state is contaminated by an ordinary fill.
const MIN_BYTES = 36 * 1024 * 1024;
{
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  const fp = path.join(PROJ, `${SID}.jsonl`);
  const fd = fs.openSync(fp, 'w');
  const FAT = 'a fat line of tool output that adds real rendered height 0123456789\n';
  let bytes = 0, n = 0, turn = 0;
  let t = Date.now() - 7 * 86400e3;
  const ts = () => new Date((t += 30e3)).toISOString();
  const push = (o) => { const s = JSON.stringify(o) + '\n'; fs.writeSync(fd, s); bytes += Buffer.byteLength(s); };
  while (bytes < MIN_BYTES) {
    push({ type: 'user', message: { role: 'user', content: `question ${turn}: please do the thing and explain` }, uuid: `u-${n++}`, timestamp: ts() });
    const long = 'line of explanatory prose that wraps around and adds height\n'.repeat(3 + (turn % 9) * 4);
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `answer ${turn}:\n${long}` }], usage: { input_tokens: 10, output_tokens: 50 } }, uuid: `a-${n++}`, timestamp: ts() });
    for (let b = 0; b < 4; b++) {
      const tid = `toolu_${turn}_${b}`;
      push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: `echo step ${turn}.${b}` } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `output ${turn}.${b}\n` + FAT.repeat(16 + ((turn + b) % 5) * 70) }] }, uuid: `tr-${n++}`, timestamp: ts() });
    }
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `turn ${turn} done.` }], usage: { input_tokens: 10, output_tokens: 5 } }, uuid: `af-${n++}`, timestamp: ts() });
    turn++;
  }
  fs.closeSync(fd);
  console.log(`  transcript: ${n} records, ${(bytes / 1048576).toFixed(1)}MB (gap threshold 34MB)`);
}

// ── 2. throwaway worktree + WORKING-TREE overlay (a pre-commit run must test
//      what is about to ship) ──
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js', 'package.json']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
const buildBundle = () => {
  fs.writeFileSync(path.join(wt, 'src/lib/build-version.js'), "export const BUILD_VERSION = 'test';\n");
  // UNMINIFIED: this harness reads traces, not bytes, but a readable bundle
  // makes a red run debuggable.
  execSync('npx esbuild src/client.js --bundle --outfile=public/bundle.js --format=iife --platform=browser --target=es2020 --loader:.css=css',
    { cwd: wt, stdio: 'ignore' });
};
buildBundle();

const srv = spawn(process.execPath, ['server.js'], {
  cwd: wt, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' },
});
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1500,1050', '--disable-background-timer-throttling',
  `--user-data-dir=${chromeDir}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  for (const d of [chromeDir, fakeHome, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(143); });

for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 80 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('✗ chrome never exposed a CDP page target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};
await cdp('Runtime.enable');
await cdp('Page.enable');

// ── 3. THE SCENARIO, as one page-side script so every step is same-tab ──
const SCENARIO = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dm = window.app.desktopManager;
  const deskA = dm.activeDesktopId;
  const deskB = dm.createDesktop('B');
  await dm.switchTo(deskB);
  await sleep(300);

  const win = window.app.viewSession('${SID}', '${CWD}', 'resume paging test');
  window.app.wm.toggleMaximize(win.id);   // a real reading viewport, not a 380px pane
  let view = null;
  for (let i = 0; i < 120; i++) {
    view = window.app.sessions.get(win.id);
    if (view && view._messages && view._messages.length > 10) break;
    await sleep(500);
  }
  if (!view || !view._messages?.length) return { ok: false, why: 'chat never loaded' };
  // A view-only ChatView runs with content-visibility OFF permanently
  // (.chat-no-content-visibility) — but the incident's windows were LIVE ones,
  // and content-visibility:auto height re-resolution IS the displacement that
  // drives scrollTop to 0 on resume. Put this harness window in the live
  // window's rendering mode; everything else about the path is identical.
  view._container.classList.remove('chat-no-content-visibility');
  // wait for the gap probe (sentinel install) + folds + heights to settle
  for (let i = 0; i < 40 && !view._seekSentinel; i++) await sleep(300);
  await sleep(2500);
  // SEED both A/B runs to the SAME starting state — 150 rendered messages
  // (the trim cap) pinned at the tail, which is what the incident's windows
  // were. Two DIRECT _extendTop calls: explicit, ungated by construction, and
  // exactly at the cap so neither build trims while seeding. Without this the
  // two builds start from different window sizes and the comparison is not an
  // A/B at all (the ungated build pages once at LOAD time and ends up taller).
  await view._extendTop(); await sleep(900);
  await view._extendTop(); await sleep(1500);
  view._pinned = true; view._scrollToBottom(); await sleep(1500);

  const list = view._messageList;
  const snap = () => ({
    st: Math.round(list.scrollTop), sh: Math.round(list.scrollHeight), ch: Math.round(list.clientHeight),
    fromBottom: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight),
    pinned: !!view._pinned, ws: view._windowStart, we: view._windowEnd, total: view._total,
  });
  const before = { ...snap(), rendered: list.querySelectorAll(':scope > .chat-msg').length,
    sentinel: !!(view._seekSentinel && view._seekSentinel.isConnected), gapActive: !!view._gapMinimapActive };
  if (!before.sentinel) return { ok: false, why: 'no seek sentinel — the transcript is under the gap threshold', before };
  if (!(before.ws > 0)) return { ok: false, why: 'windowStart is 0 — nothing to page up into', before };

  // ── the gesture: switch away, sit there, switch back ──
  const mark = (view._traceRing || []).length;
  await dm.switchTo(deskA);
  await sleep(2000);
  const tSwitch = Date.now();
  await dm.switchTo(deskB);
  const samples = [];
  for (let i = 0; i < 20; i++) { await sleep(200); samples.push({ dt: Date.now() - tSwitch, ...snap() }); }
  const traces = (view._traceRing || []).slice(mark).map((e) => ({ dt: e.t - tSwitch, ...e, t: undefined }));
  const after = snap();

  // ── SENTINEL PROBE: the incident's essential fact in isolation — scrollTop
  //    reads 0 with NO user input (a re-measure, an anchor restore, anything
  //    structural), the top sentinel enters the observer's 300px margin and
  //    the IntersectionObserver fires. The scroll/wheel handlers cannot page
  //    here (no user input, no wheel), so anything that loads came through the
  //    gap door — which is exactly the door this fix closes.
  view._pinned = true; view._scrollToBottom(); await sleep(1200);
  const mark2 = (view._traceRing || []).length;
  list.scrollTop = 0;
  await sleep(2000);
  const probeTraces = (view._traceRing || []).slice(mark2).map((e) => e.tag + (e.why ? '/' + e.why : ''));

  // ── RE-TAIL GAP (the verifier's minor on this fix): the settle expires and
  //    the pinned re-tail runs a beat later. An input-LESS displacement landing
  //    in THAT gap reached the scroll handler, unpinned the window, and the
  //    re-tail — which asserted off the LIVE pin flag — then refused: the window
  //    stayed in history permanently (measured: scrollTop=0 injected at
  //    resume+1210ms → unpinned, fromBottom 1536, and it stayed there). Same
  //    gesture as the resume above, with the displacement injected in the gap.
  view._pinned = true; view._scrollToBottom(); await sleep(1500);
  await dm.switchTo(deskA);
  await sleep(1500);
  const mark4 = (view._traceRing || []).length;
  const tSwitch3 = Date.now();
  await dm.switchTo(deskB);
  await sleep(Math.max(0, 1210 - (Date.now() - tSwitch3)));
  const injectedAt = Date.now() - tSwitch3;
  list.scrollTop = 0;                       // zero user input — a re-measure would do this
  await sleep(2500);
  const retail = { ...snap(), inject: injectedAt,
    traces: (view._traceRing || []).slice(mark4).map((e) => e.tag + (e.why ? '/' + e.why : '')) };

  // ── ROUND 2 (a) THE MAJOR: a reader who NAVIGATES during the settle must be
  //    left where they landed. Only the four MESSAGE-LIST listeners ended the
  //    settle — the minimap lives on the container, the floating run bar on
  //    view._container, and jumpToIndex/search reveal touch neither — so the
  //    1240ms re-tail silently yanked such a reader back to the live tail
  //    (measured: jump at +400ms → at +2600ms back at the tail, pinned).
  const toTail = async () => {
    if (view._teleported || view._windowEnd < view._total) await view.jumpToBottom();
    view._pinned = true; view._scrollToBottom(); await sleep(1300);
  };
  // offsets are measured off the VIEW's own resume stamp, not off the click:
  // dm.switchTo() awaits, so the click is always EARLIER than the resume.
  const sinceResume = () => Date.now() - (view._resumeAt || Date.now());
  const waitTo = async (off) => { await sleep(Math.max(0, off - sinceResume())); };
  const navTargetIdx = Math.max(0, Math.floor(view._total * 0.2));
  const navLeg = async () => {
    await toTail();
    await dm.switchTo(deskA); await sleep(1200);
    await dm.switchTo(deskB);
    await waitTo(400);
    const jumpedAt = sinceResume();
    await view.jumpToIndex(navTargetIdx);
    const landed = snap();
    await sleep(2600);                     // past BOTH re-tail rungs
    return { jumpedAt, landed, after: snap() };
  };
  const nav = await navLeg();

  // ── ROUND 2 (b) THE ONE-SHOT CLIFF: the settle protected its own edge only.
  //    An input-less displacement at +1400ms unpinned and stranded the window
  //    (3/3 sessions); +1240/+1280 survived only because _forceScrollToBottom's
  //    10-frame chain happened to still be running. Every offset in the resume
  //    horizon must end pinned at the tail.
  const sweep = [];
  for (const off of [1240, 1400, 1900, 2400]) {
    await toTail();
    await dm.switchTo(deskA); await sleep(1200);
    await dm.switchTo(deskB);
    view._traceRing = [];                  // own ring per leg (the 400-entry cap must not shift a mark)
    await waitTo(off);
    const at = sinceResume();
    list.scrollTop = 0;                    // zero user input — a re-measure would do this
    await sleep(1500);
    sweep.push({ off, at, ...snap(), traces: (view._traceRing || []).map((e) => e.tag) });
  }

  // ── …and a REAL reader INSIDE that same horizon still unpins and pages: the
  //    unpin gate must refuse displacement, never a reader — AND THE PAGE-UP
  //    MUST SURVIVE (B-9702, round 5). The pre-B-9702 leg asserted only that
  //    something paged; measured 20x on that build, 5 of those readers were
  //    silently dragged back to the live tail: the +1240ms re-tail rung's own
  //    _forceScrollToBottom chain was still writing scrollTop = scrollHeight
  //    and one of its frames landed 3ms AFTER the wheel, so the pin re-engaged
  //    off OUR OWN write (trace 'repin st:1760 … posAgo:3', with fsb:-1
  //    because the chain clears its flag in the frame of its final write) and
  //    _extendTop's pinned-tail invariant re-asserted the bottom.
  //    So the leg now asserts the READER'S OUTCOME, on a settled snapshot.
  const wheelLeg = async (off, { armChain = false } = {}) => {
    await toTail();
    await dm.switchTo(deskA); await sleep(1200);
    await dm.switchTo(deskB);
    await waitTo(off);
    view._traceRing = [];                  // own ring: the 400-entry cap must not shift a mark
    const pre = snap();
    // armChain = the DETERMINISTIC form of the race the +1400ms leg only wins
    // 15/20 times by luck: a re-tail rung landing immediately before the
    // reader, i.e. a chain with all 10 frames still ahead of it.
    if (armChain) view._scrollToBottom();
    let traces = [];
    for (let i = 0; i < 6; i++) {
      list.scrollTop = 0;
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      await sleep(700);
      traces = (view._traceRing || []).map((e) => e.tag);
      if (traces.includes('extendTop:done')) break;
    }
    const now = snap();
    await sleep(1500);                     // …and it must STILL be there once every rung has fired
    return { pre, now, settled: snap(), traces };
  };
  const resumeWheel = { ...await wheelLeg(1400) };
  //    …and the same gesture with the chain armed by hand — the mechanism
  //    itself, with a per-mechanism control (the cancel neutered on the
  //    instance) that must bring the pre-fix outcome back.
  const chainWheel = await wheelLeg(1400, { armChain: true });
  view._cancelForcedScroll = function () {};
  const chainWheelControl = await wheelLeg(1400, { armChain: true });
  delete view._cancelForcedScroll;

  // ── PER-MECHANISM NEGATIVE CONTROLS, on the FIXED build. The source-level
  //    control below (§5) rebuilds with RESUME_SETTLE_MS = 0, which cannot
  //    host either round-2 repro: both depend on the settle/re-tail TIMING
  //    still existing while ONE protection is missing. So each protection is
  //    neutered on the instance, in the same run, and the pre-fix failure must
  //    come back — otherwise these two legs prove nothing.
  view._navigatedSince = () => false;      // the re-tail blind to the reader again
  view._noteUserNav = function () {};      // …and the off-list nav surfaces stop stamping
  const navControl = await navLeg();
  delete view._navigatedSince; delete view._noteUserNav;

  //    The control injects at the SAME 1900ms offset the sweep above passes at
  //    — an exact A/B on one offset. (Not 1400: the first run measured that the
  //    1240 rung's own _forceScrollToBottom chain is still writing scrollTop
  //    there and re-pinned the window even with the gate off — which is
  //    precisely the accident the finding says the +1240/+1280 probes rode on.)
  await toTail();
  await dm.switchTo(deskA); await sleep(1200);
  view._resumeDisplacement = () => false;  // the round-2 unpin gate off
  await dm.switchTo(deskB);
  await waitTo(1300);
  view._clearResumeRetail();               // …and back to a ONE-SHOT cliff (the 1240 rung has fired)
  await waitTo(1900);
  list.scrollTop = 0;
  await sleep(1500);
  const cliffControl = snap();
  delete view._resumeDisplacement;

  // ── and a REAL wheel-up: paging must still work for an actual reader.
  //    A reader produces a STREAM of wheel ticks, so send a few (a single
  //    synthetic tick can land while a previous load still holds _loading).
  const mark3 = (view._traceRing || []).length;
  let wheelTraces = [];
  for (let i = 0; i < 6; i++) {
    list.scrollTop = 0;
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
    await sleep(700);
    wheelTraces = (view._traceRing || []).slice(mark3).map((e) => e.tag);
    if (wheelTraces.includes('extendTop:done')) break;
  }
  const wheelState = { loading: !!view._loading, pinned: !!view._pinned, ws: view._windowStart, st: Math.round(list.scrollTop) };

  // ── HANDLES for the TRUSTED-INPUT legs (round 3). Those legs need real CDP
  //    Input events dispatched from node at a precise offset from the resume,
  //    so the page side exposes the pieces and node drives the clock.
  window.__vs = {
    view, list, snap, toTail, sinceResume,
    arm: async () => {
      await toTail();
      await dm.switchTo(deskA); await sleep(1200);
      view._traceRing = [];
      await dm.switchTo(deskB);
      const r = list.getBoundingClientRect();
      return { since: sinceResume(), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height } };
    },
    at: async (off) => { await waitTo(off); return sinceResume(); },
    inject: async (off) => { await waitTo(off); const at = sinceResume(); list.scrollTop = 0; return at; },
    top: () => { list.scrollTop = 0; },
    finish: async (ms) => { await sleep(ms); return { ...snap(), sinceResume: sinceResume(),
      traces: (view._traceRing || []).map((e) => e.tag + (e.via ? '/' + e.via : '') + (e.why ? '/' + e.why : '')) }; },
    hit: (x, y) => { const el = document.elementFromPoint(x, y); return el ? (el.className || el.tagName) + '' : 'none'; },
    // ROUND 4 control: the PRE-FIX drag signature, restored on the instance —
    // "a scroll within 400ms of ANY pointerdown that moved the view is a drag".
    // It needs its own pointerdown stamp, since the shipped code no longer
    // keeps one.
    oldDragSignature: () => {
      window.__pdAt = 0;
      window.__pdListener = () => { window.__pdAt = Date.now(); };
      list.addEventListener('pointerdown', window.__pdListener, { passive: true });
      view._pointerDragScroll = function (st) {
        const at = window.__pdAt || 0;
        if (!at || Date.now() - at > 400) return false;
        return Math.abs(st - (this._pointerDownScrollTop || 0)) > 2;
      };
    },
    restoreDragSignature: () => {
      list.removeEventListener('pointerdown', window.__pdListener);
      delete view._pointerDragScroll;
    },
    // The semantic MINIMAP hides the native scrollbar
    // (.chat-minimap-active { scrollbar-width: none }), so a native scrollbar
    // drag is only reachable with the minimap off — which is exactly the
    // configuration where the gutter hit-test is the ONLY signal that a drag
    // happened (with the minimap ON the reader drags the minimap, and that
    // stamps through _noteUserNav('minimap') instead).
    bareScrollbar: () => {
      list.classList.remove('chat-minimap-active');
      const r = list.getBoundingClientRect();
      return { sbw: list.offsetWidth - list.clientWidth, right: r.right, top: r.top, bottom: r.bottom, h: r.height, st: Math.round(list.scrollTop) };
    },
  };

  return { ok: true, before, after, samples, traces, probeTraces, retail, wheelTraces, wheelState,
    nav, sweep, resumeWheel, chainWheel, chainWheelControl, navControl, cliffControl };
})()`;

const run = async (label) => {
  // The negative-control leg re-navigates onto a JUST-REBUILT bundle, so a
  // boot can lose the race — retry the navigation rather than throwing an
  // opaque "window.app is undefined" out of the scenario.
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt++) {
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/?cb=${Date.now()}` });
    for (let i = 0; i < 90 && !booted; i++) {
      booted = !!await evaljs('!!(window.app && window.app.ready && window.app.wm && window.app.desktopManager)').catch(() => false);
      if (!booted) await sleep(400);
    }
  }
  if (!booted) return { ok: false, why: 'the client never booted' };
  await evaljs('window.app.ready').catch(() => {});
  await sleep(1500);
  const r = await evaljs(SCENARIO).catch((e) => ({ ok: false, why: String(e.message || e).slice(0, 300) }));
  console.log(`  [${label}] ${r?.ok ? JSON.stringify({ before: r.before, after: r.after, wheelState: r.wheelState }) : JSON.stringify(r)}`);
  if (r?.ok) console.log(`  [${label}] traces: ${JSON.stringify(r.traces.map((e) => e.dt + ':' + e.tag + (e.why ? '/' + e.why : '')))}`);
  return r;
};

// ── 4. FIXED build: the resume must change nothing ──
const good = await run('fixed');
check('scenario ran (chat opened, gap sentinel installed, windowStart > 0)', good?.ok, JSON.stringify(good).slice(0, 400));
if (good?.ok) {
  const tags = good.traces.map((e) => e.tag);
  check('resume does NOT page up (no extendTop:done)', !tags.includes('extendTop:done'), JSON.stringify(good.traces).slice(0, 900));
  check('resume does NOT trim the tail away (no trimBottom)', !tags.includes('trimBottom'), JSON.stringify(good.traces).slice(0, 900));
  check('the rendered window did not MOVE (windowStart unchanged — the visible "跳到历史消息了")',
    good.after.ws === good.before.ws, `${good.before.ws} → ${good.after.ws}`);
  check('the view is still PINNED after the resume', good.after.pinned === true, JSON.stringify(good.after));
  check('the window still ends at the live tail (windowEnd === total)', good.after.we === good.after.total, JSON.stringify(good.after));
  check('the view sits at the bottom (within 8px)', good.after.fromBottom <= 8, JSON.stringify(good.after));
  check('…and never left the bottom during the whole 4s settle', good.samples.every((s) => s.fromBottom <= 8),
    JSON.stringify(good.samples.filter((s) => s.fromBottom > 8)).slice(0, 500));
  check('SENTINEL PROBE: an input-less scrollTop→0 makes the observer fire and be REFUSED (gapSkip)',
    good.probeTraces.some((x) => x.startsWith('gapSkip')), JSON.stringify(good.probeTraces));
  check('SENTINEL PROBE: …and nothing pages (no extendTop:done, no trimBottom)',
    !good.probeTraces.some((x) => x === 'extendTop:done' || x === 'trimBottom'), JSON.stringify(good.probeTraces));
  check('RE-TAIL GAP: an input-less scrollTop→0 at resume+1210ms (between the settle expiring and the re-tail running) ends PINNED at the tail',
    good.retail.pinned === true && good.retail.fromBottom <= 8, JSON.stringify(good.retail).slice(0, 500));
  check('a REAL wheel-up after the settle still pages normally (the gates refuse displacement, never a reader)',
    good.wheelTraces.includes('extendTop:done'), JSON.stringify({ wheelTraces: good.wheelTraces, wheelState: good.wheelState }));
  // ── ROUND 2 ──
  check('NAV DURING THE SETTLE: a jumpToIndex at resume+400ms STAYS where the reader jumped (the re-tail never yanks a navigating reader back to the tail)',
    good.nav.after.ws === good.nav.landed.ws && good.nav.after.pinned === false && good.nav.after.we < good.nav.after.total,
    JSON.stringify(good.nav).slice(0, 500));
  check('…and its control proves the leg touches the path: with the nav stamps neutered the SAME jump is dragged back to the live tail',
    good.navControl.after.ws !== good.navControl.landed.ws || good.navControl.after.pinned === true,
    JSON.stringify(good.navControl).slice(0, 500));
  check('DISPLACEMENT SWEEP: an input-less scrollTop→0 at 1240/1400/1900/2400ms after the resume ALL end pinned at the tail (the settle alone was a one-shot cliff)',
    good.sweep.length === 4 && good.sweep.every((s) => s.pinned === true && s.fromBottom <= 8), JSON.stringify(good.sweep));
  check('…and its control proves the leg touches the path: with the unpin gate off and a one-shot re-tail, the SAME +1900ms displacement strands the window',
    good.cliffControl.pinned === false || good.cliffControl.fromBottom > 8, JSON.stringify(good.cliffControl));
  // …and WHICH mechanism carries each offset, measured rather than assumed:
  // 1240 is inside the settle (the scroll handler decides nothing and the rung
  // re-tails), 1400 traced `collapsedGeomSkip` — the 2.301.0 guard still owns
  // it, because `settling` runs 1500ms from the resume's structural stamp. Only
  // past that window is the NEW gate the sole thing standing between an
  // input-less displacement and a stranded window, so that is where it must
  // show up. (A sweep that passes for an older guard's reasons is the "+1240
  // survived by accident" mistake in test form.)
  check('…and past every OLDER guard (1900/2400ms — beyond the 1500ms collapsed-geometry settling window) the sweep is carried by the unpin gate itself: unpinSkipResume',
    good.sweep.filter((s) => s.off >= 1900).every((s) => s.traces.includes('unpinSkipResume')),
    JSON.stringify(good.sweep.map((s) => ({ off: s.off, traces: s.traces }))).slice(0, 600));
  // A real reader inside the horizon: the gate never fires against them, their
  // page-up happens — AND THEY KEEP IT (B-9702, round 5). The pre-B-9702
  // version of this leg deliberately did NOT assert the final pin state,
  // reasoning that "under collapsed geometry the scroll handler makes no
  // decision and _extendTop's pinned-tail invariant owns the outcome". That
  // reasoning was REFUTED by measurement: run 20× on that build the leg ended
  // pinned at the tail 5 times, and the trace shows ordinary geometry (sh-ch =
  // 2.5 viewports, no collapsedGeomSkip) with `repin st:1760 … posAgo:3` — our
  // OWN re-tail scroll chain writing the view back to the tail milliseconds
  // after the reader moved it. The reader's outcome IS this suite's business.
  check('…while a REAL wheel-up at resume+1400ms (inside the same horizon) still pages, and the unpin gate NEVER fires against a reader',
    good.resumeWheel.traces.includes('extendTop:done') && !good.resumeWheel.traces.includes('unpinSkipResume'),
    JSON.stringify(good.resumeWheel).slice(0, 400));
  check('…and THE READER KEEPS THAT PAGE-UP: unpinned, away from the live tail, window moved up, and never re-pinned off an automatic write (B-9702)',
    good.resumeWheel.settled.pinned === false && good.resumeWheel.settled.fromBottom > 8
    && good.resumeWheel.settled.ws < good.resumeWheel.pre.ws && !good.resumeWheel.traces.includes('repin'),
    JSON.stringify(good.resumeWheel).slice(0, 600));
  // THE MECHANISM, deterministically: a re-tail rung's `_scrollToBottom()`
  // chain armed immediately before the wheel (all 10 frames still ahead of it)
  // is exactly the race the +1400ms leg wins only by timing luck.
  check('B-9702: a wheel-up while our OWN scroll chain is mid-flight cancels the chain (fsbCancel) and the reader keeps their page-up',
    good.chainWheel.traces.includes('extendTop:done') && good.chainWheel.traces.includes('fsbCancel')
    && good.chainWheel.settled.pinned === false && good.chainWheel.settled.fromBottom > 8
    && good.chainWheel.settled.ws < good.chainWheel.pre.ws,
    JSON.stringify(good.chainWheel).slice(0, 600));
  // POSITION, not the pin flag (same reading as the drag control): with the
  // cancel neutered the chain drags the reader back to the live tail whether
  // or not the mute lets the pin re-engage on the way.
  check('…and its control proves the leg touches the path: with _cancelForcedScroll neutered the SAME wheel-up is dragged back to the live tail',
    good.chainWheelControl.settled.fromBottom <= 8,
    JSON.stringify(good.chainWheelControl).slice(0, 600));
}

// ── 4b. ROUND 3, THE MAJOR — TRUSTED INPUT. Everything above dispatches
//      synthetic events or writes scrollTop; the verifier reproduced this one
//      with REAL CDP input, and that is the only way to prove what a CLICK
//      does: `Input.dispatchMouseEvent` produces an isTrusted event that goes
//      through the same listener chain a user's mouse does (and is the only
//      way to drive a native scrollbar at all — it has no DOM to dispatch to).
//      The three claims: a click during the settle is NOT a positioning act
//      (the repair survives it), a wheel IS (it unpins and pages), and a
//      scrollbar drag IS (it ends the repair though it has no event of its own).
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: extra.button || 'none', clickCount: extra.clickCount || 0,
  buttons: extra.buttons || 0, ...(extra.deltaX !== undefined ? { deltaX: extra.deltaX, deltaY: extra.deltaY } : {}),
});
// wait until the page is `off` ms past ITS OWN resume stamp, then act — the
// node↔page round trip is a few ms, and the offsets that matter are hundreds.
const armAt = async (off) => {
  const a = await evaljs('window.__vs.arm()');
  const wait = off - (a.since || 0) - 8;
  if (wait > 0) await sleep(wait);
  return a;
};
const trusted = { };
if (good?.ok) {
  // (i) THE CLICK. At resume+300ms, a plain left click in the middle of the
  //     message list; at +1400ms the resume's own input-LESS displacement.
  //     Pre-fix the click ran the full _endResumeSettle() and the window was
  //     stranded in history — the incident, reproduced behind a click.
  const a = await armAt(300);
  const cx = a.rect.left + a.rect.w / 2, cy = a.rect.top + a.rect.h / 2;
  trusted.hit = await evaljs(`window.__vs.hit(${Math.round(cx)}, ${Math.round(cy)})`);
  await mouse('mousePressed', cx, cy, { button: 'left', clickCount: 1, buttons: 1 });
  await mouse('mouseReleased', cx, cy, { button: 'left', clickCount: 1, buttons: 0 });
  trusted.clickAt = await evaljs('window.__vs.sinceResume()');
  trusted.injectAt = await evaljs('window.__vs.inject(1400)');
  trusted.click = await evaljs('window.__vs.finish(1600)');

  // (i-b) ROUND 4, MAJOR ①: the SAME click, with the resume's OWN input-less
  //     displacement landing at +450ms — INSIDE the 400ms window the round-3
  //     drag signature opened behind every pointerdown (the incident's
  //     re-measure bounces run +366…+602ms after the switch, so this is the
  //     real timing, not a contrived one). Pre-fix that scroll was read as a
  //     "scrollbar drag", which ran _endResumeSettle() — snapshot AND series —
  //     and the window was stranded behind the click. The round-3 leg above
  //     only passed because its displacement was at +1400ms, far outside the
  //     window.
  const clickThenDisplace = async (off) => {
    const a = await armAt(300);
    await mouse('mousePressed', a.rect.left + a.rect.w / 2, a.rect.top + a.rect.h / 2, { button: 'left', clickCount: 1, buttons: 1 });
    const onSb = await evaljs('window.__vs.view._pointerDownOnScrollbar');   // a CONTENT press is never a gutter press
    await mouse('mouseReleased', a.rect.left + a.rect.w / 2, a.rect.top + a.rect.h / 2, { button: 'left', clickCount: 1, buttons: 0 });
    const afterUp = await evaljs('window.__vs.view._pointerDownOnScrollbar'); // …and the press is over
    const injectAt = await evaljs(`window.__vs.inject(${off})`);
    return { onSb, afterUp, injectAt, ...await evaljs('window.__vs.finish(2600)') };
  };
  trusted.near = await clickThenDisplace(450);
  await evaljs('window.__vs.oldDragSignature()');
  trusted.nearControl = await clickThenDisplace(450);
  await evaljs('window.__vs.restoreDragSignature()');

  // (i-control) the SAME leg with the split neutered on the instance: the
  //     click ends the whole repair again (the pre-fix listener body), so the
  //     +1400ms displacement must strand the window. Without this the leg
  //     could be passing for the older guards' reasons.
  await evaljs(`window.__vs.view._noteUserInput = function () { this._lastUserScrollAt = Date.now(); this._endResumeSettle(); };`);
  const a2 = await armAt(300);
  await mouse('mousePressed', a2.rect.left + a2.rect.w / 2, a2.rect.top + a2.rect.h / 2, { button: 'left', clickCount: 1, buttons: 1 });
  await mouse('mouseReleased', a2.rect.left + a2.rect.w / 2, a2.rect.top + a2.rect.h / 2, { button: 'left', clickCount: 1, buttons: 0 });
  await evaljs('window.__vs.inject(1400)');
  trusted.clickControl = await evaljs('window.__vs.finish(1600)');
  await evaljs('delete window.__vs.view._noteUserInput;');

  // (ii) THE WHEEL at the same +300ms: a positioning act. It must unpin
  //      IMMEDIATELY and page — the split must not cost a reader anything.
  //      (Its FINAL pin state is not asserted: under collapsed geometry the
  //      atBottom re-pin owns that, as round 2 measured.)
  const a3 = await armAt(300);
  const wx = a3.rect.left + a3.rect.w / 2, wy = a3.rect.top + a3.rect.h / 2;
  let wheelPinned = null;
  for (let i = 0; i < 6; i++) {
    await evaljs('window.__vs.top()');                    // park at the top edge: a wheel-up there PAGES
    await mouse('mouseWheel', wx, wy, { deltaX: 0, deltaY: -300 });
    await sleep(60);
    if (wheelPinned === null) wheelPinned = await evaljs('window.__vs.view._pinned');
    await sleep(600);
    const tr = await evaljs('(window.__vs.view._traceRing || []).map((e) => e.tag)');
    if (tr.includes('extendTop:done')) break;
  }
  trusted.wheelPinned = wheelPinned;
  trusted.wheel = await evaljs('window.__vs.finish(300)');

  // (iii) THE SCROLLBAR DRAG at +300ms: press on the native scrollbar (which
  //      has no DOM node — only trusted input can touch it) and drag up. It
  //      produces a pointerdown and then plain scroll events, so it is
  //      positioning only through _pointerDragScroll — and it must END the
  //      repair: the re-tail may not drag this reader back to the tail.
  //      `hold` = how long the press sits still before the first move: round 4
  //      keys the drag on WHERE the press landed, so a slow reader is a
  //      positioning act just as much as a fast one.
  const dragLeg = async (hold = 40) => {
    await evaljs('window.__vs.bareScrollbar()');            // …before the desktop switch, so the resume measures the real geometry
    await armAt(300);
    const g = await evaljs('window.__vs.bareScrollbar()');  // …and again in case a minimap render re-added the class
    const sx = g.right - Math.max(2, g.sbw / 2);
    await mouse('mousePressed', sx, g.bottom - 25, { button: 'left', clickCount: 1, buttons: 1 });
    await sleep(hold);
    const onScrollbar = await evaljs('window.__vs.view._pointerDownOnScrollbar');  // did the press land in the GUTTER?
    const heldFor = hold;
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', sx, g.bottom - 25 - i * (g.h / 9), { button: 'left', buttons: 1 }); await sleep(30); }
    await mouse('mouseReleased', sx, g.top + 60, { button: 'left', clickCount: 1, buttons: 0 });
    const moved = await evaljs('Math.round(window.__vs.list.scrollTop)');
    const afterUp = await evaljs('window.__vs.view._pointerDownOnScrollbar');      // …and the press is over on release
    return { sbw: g.sbw, onScrollbar, heldFor, afterUp, from: g.st, moved, ...await evaljs('window.__vs.finish(2600)') };   // past BOTH re-tail rungs
  };
  trusted.drag = await dragLeg();
  // (iii-b) ROUND 4, MAJOR ②: the same drag, but the reader holds the thumb for
  //      900ms before moving — outside the deleted 400ms window, so pre-fix
  //      this drag was never positioning at all and the re-tail series
  //      (1240/2000ms) yanked the reader back to the live tail. A NEW harm the
  //      round-3 signature introduced vs master, which is why it gets its own
  //      leg AND its own control.
  trusted.holdDrag = await dragLeg(900);
  await evaljs('window.__vs.view._pointerOnScrollbar = function () { return false; };');
  trusted.holdDragControl = await dragLeg(900);
  await evaljs('delete window.__vs.view._pointerOnScrollbar;');
  // (iii-control) with the drag predicate neutered the drag is just a click
  //      followed by displacement — the re-tail then drags the reader back to
  //      the live tail, which is the whole reason the predicate exists.
  await evaljs('window.__vs.view._pointerDragScroll = function () { return false; };');
  trusted.dragControl = await dragLeg();
  await evaljs('delete window.__vs.view._pointerDragScroll;');

  console.log(`  [trusted] ${JSON.stringify(trusted).slice(0, 2400)}`);
  check('TRUSTED CLICK: a real left-click in the message list at resume+300ms does NOT disarm the repair — the input-less displacement at +1400ms still ends PINNED at the tail (round-3 MAJOR)',
    trusted.click.pinned === true && trusted.click.fromBottom <= 8,
    JSON.stringify({ hit: trusted.hit, clickAt: trusted.clickAt, injectAt: trusted.injectAt, click: trusted.click }).slice(0, 600));
  check('…and its control proves the leg touches the path: with the click running the OLD full _endResumeSettle() the same displacement strands the window',
    trusted.clickControl.pinned === false || trusted.clickControl.fromBottom > 8, JSON.stringify(trusted.clickControl).slice(0, 500));
  check('TRUSTED WHEEL: a real wheel-up at resume+300ms unpins IMMEDIATELY and pages (a positioning act loses nothing to the split)',
    trusted.wheelPinned === false && trusted.wheel.traces.includes('extendTop:done') && !trusted.wheel.traces.includes('unpinSkipResume'),
    JSON.stringify({ wheelPinned: trusted.wheelPinned, wheel: trusted.wheel }).slice(0, 600));
  check('TRUSTED SCROLLBAR DRAG: a real drag at resume+300ms IS positioning (userPos/scrollbar-drag) — it ends the repair and the reader is left where they dragged to',
    trusted.drag.traces.some((x) => x === 'userPos/scrollbar-drag') && trusted.drag.fromBottom > 8,
    JSON.stringify(trusted.drag).slice(0, 700));
  // POSITION, not the pin flag: the fixed leg ALSO ends `pinned:true` here —
  // under collapsed geometry the scroll handler makes no boundary decision at
  // all (collapsedGeomSkip), so the flag belongs to the 2.301.0 guard. What the
  // drag stamp decides is WHERE the reader ends up.
  check('…and its control proves the leg touches the path: with _pointerDragScroll neutered the SAME drag is dragged back to the live tail by the re-tail',
    trusted.dragControl.fromBottom <= 8, JSON.stringify(trusted.dragControl).slice(0, 700));
  // ── ROUND 4 ──
  check('THE GUTTER HIT-TEST, under trusted input: a press in the CONTENT area is not a scrollbar press, and the flag is cleared on release',
    trusted.near.onSb === false && trusted.near.afterUp === false && trusted.drag.onScrollbar === true && trusted.drag.afterUp === false,
    JSON.stringify({ contentPress: { on: trusted.near.onSb, afterUp: trusted.near.afterUp }, gutterPress: { on: trusted.drag.onScrollbar, afterUp: trusted.drag.afterUp, sbw: trusted.drag.sbw } }));
  check('ROUND 4 ①: a real left-click at resume+300ms followed by the resume\'s OWN input-less displacement at +450ms (inside the deleted 400ms drag window) still ends PINNED at the tail',
    trusted.near.pinned === true && trusted.near.fromBottom <= 8,
    JSON.stringify(trusted.near).slice(0, 600));
  check('…and its control proves the leg touches the path: with the pre-fix time-window signature restored, that same +450ms displacement is read as a "drag", disarms the repair and strands the window',
    trusted.nearControl.pinned === false || trusted.nearControl.fromBottom > 8,
    JSON.stringify(trusted.nearControl).slice(0, 600));
  check('ROUND 4 ②: a scrollbar drag whose first move comes 900ms after the press is STILL positioning — the reader is left where they dragged to (userPos/scrollbar-drag)',
    trusted.holdDrag.onScrollbar === true && trusted.holdDrag.traces.some((x) => x === 'userPos/scrollbar-drag') && trusted.holdDrag.fromBottom > 8,
    JSON.stringify(trusted.holdDrag).slice(0, 700));
  check('…and its control proves the leg touches the path: with the press not recognised as a gutter press (the pre-fix outcome for a late move) the SAME drag is yanked back to the live tail',
    trusted.holdDragControl.fromBottom <= 8, JSON.stringify(trusted.holdDragControl).slice(0, 700));
}

// ── 5. NEGATIVE CONTROL: patch the gates out at SOURCE and rebuild ──
// String-exact against code this commit owns; a drifted marker fails LOUDLY
// instead of silently turning the control into a no-op.
const patch = (rel, pairs) => {
  const fp = path.join(wt, rel);
  let s = fs.readFileSync(fp, 'utf8');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) { console.error(`  ✗ NEGATIVE CONTROL marker drifted in ${rel}: ${from.slice(0, 70)}`); failed++; continue; }
    s = s.split(from).join(to);
  }
  fs.writeFileSync(fp, s);
};
patch('src/lib/chat-view.js', [
  ['const RESUME_SETTLE_MS = 1200;', 'const RESUME_SETTLE_MS = 0;'],                       // (2) resume settle off
  ['  _autoPagingBlocked() {', '  _autoPagingBlocked() { return null;'],                   // (1) IO/seek gate off
  ["if (this._pinned) this._trace('trimSkipPinned', { ws: newStart, n: msgs.length });\n        else this._trimBottom();", 'this._trimBottom();'], // (3a)
  ["if (this._pinned) { this._trace('pinnedRetail', { ws: newStart }); this._scrollToBottom(); }", ';'],                                          // (3b)
  ['if (!this._pinned && !this._pinnedAtSuspend) return;', 'if (!this._pinned) return;'],   // (4) re-tail back on the LIVE flag
]);
buildBundle();
const bad = await run('gates-removed');
check('NEGATIVE CONTROL: without the gates the resume DOES page up (extendTop:done)',
  bad?.ok && bad.traces.some((e) => e.tag === 'extendTop:done'), JSON.stringify(bad).slice(0, 900));
check('NEGATIVE CONTROL: …and the rendered window MOVES with zero user input',
  bad?.ok && bad.after.ws !== bad.before.ws, `${bad?.before?.ws} → ${bad?.after?.ws}`);
check('NEGATIVE CONTROL: the sentinel probe pages through the gap door',
  bad?.ok && bad.probeTraces.includes('extendTop:done'), JSON.stringify(bad?.probeTraces));
check('NEGATIVE CONTROL: …and the re-tail-gap injection strands the window (unpinned / away from the tail)',
  bad?.ok && (bad.retail.pinned === false || bad.retail.fromBottom > 8), JSON.stringify(bad?.retail).slice(0, 500));

// THE REAL HOME IS UNTOUCHED (see test-chat-paging.mjs §5 for the rule).
{
  const after = (() => { try { return fs.readdirSync(REAL_PROJECTS, { withFileTypes: true }); } catch { return []; } })();
  const added = after.filter((d) => !realBefore.has(d.name))
    .map((d) => ({ name: d.name, mtimeMs: (() => { try { return fs.statSync(path.join(REAL_PROJECTS, d.name)).mtimeMs; } catch { return Date.now(); } })() }));
  const lit = fixtureLitter(added);
  check(`the real ~/.claude/projects gained no fixture entry (${added.length} new from concurrent real sessions, 0 fixtures)`,
    lit.offenders.length === 0, JSON.stringify(lit.offenders.slice(0, 3)));
  check('the fixture really was written under the isolated home (isolation did not skip the work)',
    fs.existsSync(path.join(PROJ, `${SID}.jsonl`)), path.join(PROJ, `${SID}.jsonl`));
}

ws.close();
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
