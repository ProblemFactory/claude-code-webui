#!/usr/bin/env node
// Fold-dominated trim guard (inc-mtajy6wr "上翻的时候出现大量白屏", 2.368.29):
// with semantic collapse folding whole tool/agent runs, a 150-message window
// can render shorter than the viewport — trimBottom then removes the only
// VISIBLE content and every wheel-tick teleports the window 50 messages
// through fold-space on a white screen (captured: extendTop:done sh=787=ch
// every ~0.5s, ws 4572→4036). The guard: while the rendered window is
// shorter than ~2 viewports, the cap grows to 600 instead of trimming.
// DOM-heavy machinery has no functional harness — these pins keep the guard
// (and its symmetry) from being refactored away silently.
import fs from 'node:fs';
import path from 'node:path';
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const cv = fs.readFileSync(path.join(REPO, 'src/lib/chat-view.js'), 'utf8');
// chat-view imports telemetry-client → build-version.js, which `npm run build`
// GENERATES (gitignored); ci.mjs builds before any suite runs.
if (!fs.existsSync(path.join(REPO, 'src/lib/build-version.js'))) {
  console.error('src/lib/build-version.js is missing — run `npm run build` first (it is a generated file)');
  process.exit(1);
}

const guards = cv.match(/if \(list && list\.scrollHeight < list\.clientHeight \* 2\) maxRendered = 600;/g) || [];
ok('the short-window guard exists in BOTH trims (bottom AND top — downward paging through folds is the mirror image)', guards.length === 2, `found ${guards.length}`);
ok('trimBottom carries the guard', /_trimBottom\(maxRendered = 150\) \{[\s\S]{0,900}maxRendered = 600;/.test(cv));
ok('trimTop carries the guard', /_trimTop\(maxRendered = 150\) \{[\s\S]{0,900}maxRendered = 600;/.test(cv));
ok('the incident is named at the guard (future readers find the bundle)', /inc-mtajy6wr/.test(cv));
ok('the trim trace tags survive (the capture channel that caught this)', cv.includes("this._trace('trimBottom'") && cv.includes("_trace('extendTop:done'"));
// ── SHORT-VIEW RESCUE after attach (2.369.43) ───────────────────────────────
// The 2.369.36 gate `_windowStart > 0 && rendered < 30 && sh <= ch` was
// UNSATISFIABLE: every attach path ships tail(50) (ws-handler `_normalizer
// .tail(50)`, transcripts.page), `_windowStart > 0` holds EXACTLY when those
// 50 arrived, and the semantic fold HIDES members (`.chat-run-collapsed`,
// display:none) instead of removing them — measured over 33 real production
// transcripts with total>50: 50 of 50 tail messages render a `.chat-msg`
// child, min 50. So the rescue never fired for anyone, and the case it exists
// for — a fold-dominated slab shorter than the viewport, with NO scrollable
// range and therefore no scroll events (and no wheel path at all on touch) —
// was a dead end. Re-derived: corroborate the geometry across the settle
// window (the transient collapsed-geometry artifact resolves inside ~1.5s,
// the same premise collapsedGeomSkip runs on) and keep only the harm bound.
ok('the unsatisfiable `rendered < 30` gate is gone from the code (it made the rescue dead code)', !/rendered < 30 &&/.test(cv) && !/this\._windowStart > 0 && rendered/.test(cv));
ok('the rescue is a named predicate + a two-reading schedule', /_shortViewNeedsFill\(list\) \{/.test(cv) && /_scheduleAttachFill\(\) \{/.test(cv) && /this\._scheduleAttachFill\(\);/.test(cv));
const disposeBody = cv.slice(cv.indexOf('\n  dispose() {'));
ok('…both timers are cleared on dispose (no rescue against a torn-down view)', /clearTimeout\(this\._autoFillT1\)/.test(disposeBody) && /clearTimeout\(this\._autoFillT2\)/.test(disposeBody));

// FUNCTIONAL: chat-view.js is DOM-free at import, so the decision runs here
// against fake geometry (the whole point — the pre-fix gate looked plausible
// in review and was arithmetically impossible in production).
const { ChatView } = await import(path.join(REPO, 'src/lib/chat-view.js'));
const mkList = (rendered, sh, ch) => ({ scrollHeight: sh, clientHeight: ch, querySelectorAll: () => ({ length: rendered }) });
const decide = (state, list) => ChatView.prototype._shortViewNeedsFill.call(state, list);
const attached = { _windowStart: 4550, _suspended: false, _disposed: false, _teleported: false };
ok('THE CASE: a fold-dominated attach slab (50 cards collapsed into run headers, 240px in a 700px viewport) asks for one page', decide(attached, mkList(50, 240, 700)));
ok('…and the OLD gate refused exactly that (rendered 50 ≥ 30) — the regression this pins', !(attached._windowStart > 0 && 50 < 30 && 240 <= 700));
ok('a normal attach that already fills the viewport asks for nothing', !decide(attached, mkList(50, 6000, 700)));
ok('a window with no history above it asks for nothing', !decide({ ...attached, _windowStart: 0 }, mkList(50, 240, 700)));
ok('a desktop-hidden (suspended) window decides nothing — its geometry is meaningless (inc-mtd1d0ft)', !decide({ ...attached, _suspended: true }, mkList(50, 240, 700)));
ok('a disposed view decides nothing', !decide({ ...attached, _disposed: true }, mkList(50, 240, 700)));
ok('teleport mode is left to its own seek paths (window indices are stale there)', !decide({ ...attached, _teleported: true }, mkList(50, 240, 700)));
ok('the harm bound holds: never extend where the extra page could trip a trim and eat the live tail (inc-mtox23xw)', !decide(attached, mkList(120, 240, 700)));

// FUNCTIONAL: the two-reading corroboration (the artifact the 2.369.36 fix saw
// was a TALL pinned window reading sh<=ch while heights were unresolved).
const runFill = async (frames, mutate) => {
  let extended = 0;
  const state = Object.assign(Object.create(ChatView.prototype), {
    _windowStart: 4550, _suspended: false, _disposed: false, _teleported: false,
    _lastStructuralAt: 1000, _messageList: frames[0], _trace: () => {},
    _extendTop: () => { extended++; },
  });
  ChatView.prototype._scheduleAttachFill.call(state);
  await new Promise((r) => setTimeout(r, 800));
  state._messageList = frames[1];
  if (mutate) mutate(state);
  await new Promise((r) => setTimeout(r, 1100));
  return extended;
};
const short = mkList(50, 240, 700), tall = mkList(50, 6000, 700);
const [genuine, artifact, mutated] = await Promise.all([
  runFill([short, short]),
  runFill([short, tall]),                                       // heights resolved between the readings
  runFill([short, short], (s) => { s._lastStructuralAt = 99999; }), // paging/trim ran in between
]);
ok('a view still short at BOTH readings extends exactly once', genuine === 1);
ok('a view whose heights resolve between the readings (the 2.369.36 artifact) never extends', artifact === 0);
ok('a structural change between the readings hands the decision back to the paging machinery', mutated === 0);

// ── suspend gate (inc-mtd1d0ft "桌面切换卡死30-60s"): a desktop-hidden chat
// window's geometry is meaningless — the paging machinery must make no
// decisions off it, and a switch re-measures 4-6 windows at once.
ok('ChatView.setSuspended exists and arms the structural settle window on resume', /setSuspended\(on\) \{/.test(cv) && /this\._lastStructuralAt = Date\.now\(\);/.test(cv.slice(cv.indexOf('setSuspended'))));
ok('resume returns a pinned view to the LIVE tail — behind-the-tail windows take the full jumpToBottom (inc-mtfi6034 mobile old-position)', /this\._windowEnd < this\._total\) this\.jumpToBottom\(\);/.test(cv.slice(cv.indexOf('setSuspended'))));
// four paging entries: extendTop / extendBottom / the scroll handler's
// decisions / the short-view rescue (which answers `false`, not `return`)
ok('all four paging entries gate on _suspended (extendTop/extendBottom/scroll decisions/short-view rescue)',
  (cv.match(/this\._suspended(?: \|\| this\._disposed)?\) return(?: false)?;/g) || []).length >= 4);
const dm = fs.readFileSync(path.join(REPO, 'src/lib/desktop-manager.js'), 'utf8');
ok('desktop hide/show wires the suspend flag', (dm.match(/setSuspended\?\.\((true|false)\)/g) || []).length === 2);
ok("hidden chat windows get content-visibility:hidden (state-preserving render skip — the switch-jank render leg, inc-mtd54h45)", /contentVisibility = 'hidden'/.test(dm) && /win\.type === 'chat'/.test(dm));
ok('stage un-hide paths resume too (direct _hiddenByDesktop writers)', (fs.readFileSync(path.join(REPO, 'src/lib/stage-manager.js'), 'utf8').match(/setSuspended\?\.\(false\)/g) || []).length === 2);
const ap = fs.readFileSync(path.join(REPO, 'src/lib/app.js'), 'utf8');
ok('the legacy dialog overlay closes only when the interaction STARTED on it (inc-mtd1c2sd select-drag)', /_downOnOverlay = e\.target === overlay/.test(ap) && /e\.target === overlay && _downOnOverlay/.test(ap));

// ── reconnect no-op (inc-mtd2pg6x "刚刚又卡死了": ws reconnect re-attaches
// every session; identical slabs must not rebuild N windows' DOM)
ok('loadHistory skips the rebuild for an IDENTICAL slab (same epoch/total/tail ids, tail-anchored)', /loadHistory:identical-skip/.test(cv) && /lastCur\.id === lastNew\.id/.test(cv) && /this\._windowEnd === this\._total/.test(cv));
ok('…the skip still applies meta/status/live state and the typing indicator', /identical-skip[\s\S]{0,900}applyStatus\(meta\.chatStatus\)[\s\S]{0,600}_applyLiveMeta\?\.\(meta\)/.test(cv));

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
