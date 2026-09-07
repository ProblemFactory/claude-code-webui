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
ok('resume returns a pinned view to the LIVE tail — behind-the-tail windows take the full jumpToBottom (inc-mtfi6034 mobile old-position), and it does NOT stamp a user navigation over its own series',
  /this\._windowEnd < this\._total\) this\.jumpToBottom\(\{ user: false \}\);/.test(cv.slice(cv.indexOf('setSuspended'))));
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

// ── the RESUME transition (inc-mtq5bpjt-0o0n "切换桌面后，新桌面的窗口内容跳到
// 历史消息了"): suspending covered the HIDDEN state; the un-hide TRANSITION was
// unguarded, and the ONE upward-paging entry point with no gate at all — the
// gap sentinel's IntersectionObserver → _loadEarlierGap's tail-mode branch —
// paged three PINNED windows into history with zero user input. The end-to-end
// reproduction (with the negative control that proves the path is exercised)
// lives in scripts/test-desktop-resume-paging.mjs; these pin the mechanism.
const sk = fs.readFileSync(path.join(REPO, 'src/lib/chat-view-seek.js'), 'utf8');
ok('the gap path has ONE gate predicate, _autoPagingBlocked (never re-invented per entry point)',
  /_autoPagingBlocked\(\) \{/.test(cv));
ok('…and it names every law the scroll handler obeys (suspend / resume-settle / pin / settle / no-input)',
  ["'suspended'", "'resume-settle'", "'pinned'", "'settling'", "'no-input'"].every((r) => cv.includes(r)));
ok('_loadEarlierGap applies the gate BEFORE its tail-mode _extendTop branch (the guard sits on the path that is alive in the failure state)',
  /if \(auto\) \{[\s\S]{0,220}_autoPagingBlocked\(\)[\s\S]{0,220}\}[\s\S]{0,400}this\._windowStart > 0\) \{ await this\._extendTop\(\); return; \}/.test(sk));
ok('…and traces WHY it refused (gapSkip + reason, so the tracer shows the refusal)', /_trace\?\.\('gapSkip', \{ why, via \}\)/.test(sk));
ok('the sentinel IntersectionObserver goes through _loadEarlierGap as an AUTOMATIC caller (never a bare _extendTop)',
  /isIntersecting\) continue;[\s\S]{0,900}this\._loadEarlierGap\(entry\.target, null, \{ via: 'io' \}\)/.test(cv));
ok('an explicit RETRY click bypasses the gate (auto: false — a click is intent)', /_loadEarlierGap\(markerEl, btn, \{ auto: false \}\)/.test(sk));
ok('the scroll/wheel-driven _maybeSeekEarlier is an automatic caller too', /_maybeSeekEarlier\(\) \{[\s\S]{0,700}_loadEarlierGap\(s, null\);\s*\/\/ AUTOMATIC/.test(sk));
ok('setSuspended(false) arms the resume settle window — WITH the re-tail timer\'s slack, so nothing can decide in the gap between the window expiring and the re-tail running',
  /setSuspended\(on\) \{[\s\S]{0,900}this\._resumeAt = Date\.now\(\);\s*this\._resumeSettleUntil = this\._resumeAt \+ RESUME_SETTLE_MS \+ RESUME_RETAIL_SLACK_MS;/.test(cv)
  && /const RESUME_RETAIL_SLACK_MS = 40;/.test(cv));
ok('…and the pinned re-tail is a BOUNDED SERIES, not a one-shot cliff (round-2: an input-less displacement at resume+1400ms still stranded the window 3/3 — +1240/+1280 only survived on _forceScrollToBottom\'s 10-frame chain)',
  /const RESUME_RETAIL_AT_MS = \[RESUME_SETTLE_MS \+ RESUME_RETAIL_SLACK_MS, 2000\];/.test(cv)
  && /this\._resumeRetailTimers = RESUME_RETAIL_AT_MS\.map\(\(ms\) => setTimeout\(reTail, ms\)\);/.test(cv)
  && /_clearResumeRetail\(\) \{[\s\S]{0,160}clearTimeout\(tm\)/.test(cv)
  && /this\._clearResumeRetail\(\);/.test(cv.slice(cv.indexOf('\n  dispose() {'))));
ok('…and the pin SNAPSHOT outlives the last re-tail, so the unpin gate keeps its evidence for the whole displacement horizon',
  /const RESUME_DISPLACEMENT_MS = 2800;/.test(cv)
  && /setTimeout\(\(\) => \{ this\._pinnedAtSuspend = false; \}, RESUME_DISPLACEMENT_MS\)/.test(cv));
ok('…and it asserts off the pin SNAPSHOT taken when the window was HIDDEN (a transitional unpin during the resume must not strand the window in history)',
  /this\._pinnedAtSuspend = this\._pinned;/.test(cv)
  && /if \(!this\._pinned && !this\._pinnedAtSuspend\) return;/.test(cv)
  && /if \(this\._pinned \|\| this\._pinnedAtSuspend\) \{/.test(cv));
// ORDER pin. The settle return moved BELOW the run-bar readout (round-2
// minor: returning above it froze the 2.369.45 floating bar for the whole
// 1.24s settle) and stays ABOVE every pin/paging decision; round 3 puts the
// scrollbar-drag stamp between the programmatic return and the settle (the
// drag must be able to end the very settle it starts inside). Budgets per
// segment: suspend→runBar ≤400 (was one 700 hop to the settle),
// runBar→programmatic ≤200, programmatic→drag ≤700 (round 4 explains the
// gutter re-key there), drag→settle ≤1400 (the comment block that explains why
// the readout comes first), settle→atBottom ≤2400. The budgets bound DISTANCE,
// not prose — raise one when a comment legitimately grows; what is pinned is
// the ORDER.
ok('the scroll handler updates the run-bar READOUT first, stamps a scrollbar DRAG, then no-ops for the settle BEFORE it touches the pin (transitional geometry must not unpin)',
  /this\._suspended\) return;[\s\S]{0,400}this\._updateRunBar\(scrollTop\);[\s\S]{0,200}this\._programmaticScroll\) return;[\s\S]{0,700}this\._pointerDragScroll\(scrollTop\)\)[\s\S]{0,1400}Date\.now\(\) < \(this\._resumeSettleUntil \|\| 0\)\) return;[\s\S]{0,2400}const atBottom =/.test(cv));
ok('…and the UNPIN itself is gated on positive evidence for the rest of the horizon (the settle alone was a one-shot cliff)',
  /if \(this\._pinned && this\._resumeDisplacement\(\)\) \{[\s\S]{0,260}_scrollToBottom\(\);\s*return;\s*\}[\s\S]{0,200}this\._pinned = false;/.test(cv)
  && /_resumeDisplacement\(\) \{/.test(cv));
ok('the loadHistory auto-fill DEFERS through the settle instead of deciding on transitional geometry',
  /const tryAutoFill = \(retries\) => \{[\s\S]{0,400}this\._resumeSettleUntil \|\| 0\) - Date\.now\(\)[\s\S]{0,200}tryAutoFill\(retries - 1\)/.test(cv));
ok('a POSITIONING act clears the settle AND the pin snapshot (the settle only suppresses input-LESS displacement, it never fights a reader who MOVED the view)',
  /_notePositioning\(via\) \{[\s\S]{0,320}this\._lastPositionAt = now;[\s\S]{0,600}this\._endResumeSettle\(\);/.test(cv)
  && /_endResumeSettle\(\) \{ this\._resumeSettleUntil = 0; this\._pinnedAtSuspend = false; this\._clearResumeRetail\(\); \}/.test(cv));

// ── ROUND 3, THE MAJOR (reproduced with TRUSTED CDP input): a plain
// left-click/tap in the message list during the 1.24s settle ran the FULL
// _endResumeSettle() — window + pin snapshot + re-tail series — so the
// resume's own input-LESS displacement, arriving a beat later behind the
// click, reproduced the incident. A click is not a positioning act: it says
// where the reader IS, not that the view moved.
ok('a bare CLICK / non-navigation key only stamps input and ends the settle WINDOW — the pin snapshot and the re-tail series survive it',
  /_noteUserInput\(\) \{\s*this\._lastUserScrollAt = Date\.now\(\);\s*this\._resumeSettleUntil = 0;/.test(cv)
  && !/_noteUserInput\(\) \{[\s\S]{0,200}_pinnedAtSuspend|_noteUserInput\(\) \{[\s\S]{0,200}_clearResumeRetail/.test(cv));
ok('…and the message-list listeners route by GRADE: wheel/touchmove/navigation keys position, pointerdown and other keys merely input',
  /addEventListener\('wheel', \(e\) => \{[\s\S]{0,400}this\._notePositioning\('wheel'\);/.test(cv)
  && /addEventListener\('touchmove', \(\) => this\._notePositioning\('touch'\)/.test(cv)
  && /addEventListener\('pointerdown', \(e\) => \{\s*this\._noteUserInput\(\);\s*this\._pointerDownOnScrollbar = this\._pointerOnScrollbar\(e\);\s*this\._pointerDownScrollTop = this\._messageList\.scrollTop;/.test(cv)
  && /if \(NAV_KEYS\.includes\(e\.key\)\) this\._notePositioning\('key'\);\s*else this\._noteUserInput\(\);/.test(cv)
  && /const NAV_KEYS = \['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', ' '\];/.test(cv));
// ── ROUND 4: the drag signature is WHERE the press landed, never WHEN a
// scroll follows it. The 400ms window had two MAJORs: the resume's OWN
// input-less displacement (the incident's re-measure bounces at +366…+602ms)
// landing inside a plain content click's window was read as a drag — the click
// then disarmed the snapshot + series and the incident reproduced behind it —
// and a real drag whose first move came later than the window was never
// positioning at all, so the re-tail series yanked that reader back (a NEW harm
// vs master). The press now carries a gutter FLAG for its whole lifetime.
ok('…and a SCROLLBAR DRAG is keyed on the GUTTER the press landed in (position), not on a time window after any pointerdown',
  /_pointerDragScroll\(scrollTop\) \{\s*if \(!this\._pointerDownOnScrollbar\) return false;\s*return Math\.abs\(scrollTop - \(this\._pointerDownScrollTop \|\| 0\)\) > POINTER_DRAG_PX;/.test(cv)
  && /_pointerOnScrollbar\(e\) \{/.test(cv)
  && /this\._pointerDragScroll\(scrollTop\)\) this\._notePositioning\('scrollbar-drag'\);/.test(cv));
ok('…the time-window signature is GONE (POINTER_DRAG_MS / _pointerDownAt cannot come back by accident)',
  !/POINTER_DRAG_MS/.test(cv) && !/_pointerDownAt/.test(cv));
ok('…the gutter hit-test measures the strip the CONTENT box does not reach, in LAYOUT px (uiScale zoom scales the rect, not clientWidth — the 2.369.5 VNC-pointer class), and handles RTL + a horizontal gutter',
  /const scale = list\.offsetWidth \? \(r\.width \/ list\.offsetWidth\) : 1;/.test(cv)
  && /const vGutter = list\.offsetWidth - list\.clientWidth - bl - br;/.test(cv)
  && /const hGutter = list\.offsetHeight - list\.clientHeight - bt - bb;/.test(cv)
  && /rtl = cs\.direction === 'rtl';/.test(cv));
ok('…and the press is CLEARED on pointerup/pointercancel, window-scoped on the winInfo AbortController (a drag routinely releases outside the list) and removed on dispose',
  /window\.addEventListener\('pointerup', this\._endPointerPress, \{ passive: true, signal: pressSignal \}\);/.test(cv)
  && /window\.addEventListener\('pointercancel', this\._endPointerPress, \{ passive: true, signal: pressSignal \}\);/.test(cv)
  && /const pressSignal = winInfo\?\._listenerCtl\?\.signal;/.test(cv)
  && /this\._endPointerPress = \(\) => \{ this\._pointerDownOnScrollbar = false; \};/.test(cv)
  && /window\.removeEventListener\('pointerup', this\._endPointerPress\);/.test(cv.slice(cv.indexOf('\n  dispose() {'))));

// ── ROUND 2, THE MAJOR: only the four message-list listeners ended the settle,
// so a reader who navigated through a surface that is NOT the list — the
// minimap (its pointer events live on the container), a search reveal, the
// floating run bar (this._container), jumpToIndex — was YANKED back to the
// live tail by the 1240ms re-tail (measured: jump at +400ms → pinned at the
// tail at +2600ms). Every such entry point stamps and ends the settle, and the
// re-tail compares nav-vs-resume: the chat-view-seek `userScrolled` idiom.
ok('there is ONE navigation stamp (_noteUserNav) and it ends the settle like a wheel does',
  /_noteUserNav\(via\) \{[\s\S]{0,220}this\._lastNavAt = Date\.now\(\);[\s\S]{0,220}this\._endResumeSettle\(\);/.test(cv));
ok('…and the reader-position test generalises the seek idiom over every POSITIONING stamp (positioning act, nav, jump landing, search reveal) — and reads _lastUserScrollAt NOWHERE, because a click is not one (round 3)',
  /_navigatedSince\(since\) \{[\s\S]{0,500}this\._lastNavAt \|\| 0[\s\S]{0,120}this\._lastPositionAt \|\| 0[\s\S]{0,160}this\._lastJumpAt \|\| 0[\s\S]{0,160}this\._search\?\._lastRevealAt \|\| 0[\s\S]{0,60}> since;/.test(cv)
  && !/_navigatedSince\(since\) \{[\s\S]{0,500}_lastUserScrollAt/.test(cv));
ok('the resume re-tail BAILS when the reader navigated after the resume (never yank a reader back to the tail)',
  /const resumeAt = this\._resumeAt;[\s\S]{0,400}if \(this\._navigatedSince\(resumeAt\)\) return;/.test(cv));
ok('every off-list navigation surface stamps: minimap (index + time), search reveal, run-bar landing, jumpToIndex, user jumpToBottom',
  /_noteUserNav\('minimap'\); return this\.jumpToIndex/.test(cv)
  && /_noteUserNav\('minimap-time'\); return this\._jumpToFileTime/.test(cv)
  && /onNav: \(\) => this\._noteUserNav\('search-reveal'\)/.test(cv)
  && /_landOnHeader\(run\) \{[\s\S]{0,400}this\._noteUserNav\('runBar'\);/.test(cv)
  && /async jumpToIndex\(targetIdx\) \{\s*this\._noteUserNav\('jumpToIndex'\);/.test(cv)
  && /async jumpToBottom\(\{ user = true \} = \{\}\) \{\s*if \(user\) this\._noteUserNav\('jumpToBottom'\);/.test(cv));
{
  const sch = fs.readFileSync(path.join(REPO, 'src/lib/chat-search.js'), 'utf8');
  ok('…and ChatSearch actually calls it on a REVEAL (the reveal scrolls the list from outside its own listeners)',
    /this\._onNav = onNav \|\| null;/.test(sch) && /this\._lastRevealAt = Date\.now\(\);\s*this\._onNav\?\.\(\);/.test(sch));
  ok('…and the minimap time landing stamps in the seek module too', /_jumpToFileTime\(ts, line\) \{\s*this\._noteUserNav\('jumpToFileTime'\);/.test(sk));
}
ok('INVARIANT a pinned view never loses its tail: _extendTop skips trimBottom while pinned',
  /if \(this\._pinned\) this\._trace\('trimSkipPinned'[\s\S]{0,200}else this\._trimBottom\(\);/.test(cv));
ok('…and re-asserts the tail after the prepend (the anchor restore fails under transitional geometry: anchored:false, scrollTop 0)',
  /if \(this\._pinned\) \{ this\._trace\('pinnedRetail'[\s\S]{0,80}this\._scrollToBottom\(\); \}/.test(cv));
ok('the incident is named at the fix (future readers find the bundle)', /inc-mtq5bpjt-0o0n/.test(cv) && /inc-mtq5bpjt-0o0n/.test(sk));

// ── DOM-free UNIT: the decision table itself. The method reads only `this`
// fields and `window`, so the SHIPPED source is lifted out and exercised
// directly — no jsdom, no bundle, and a rewrite that changes the ORDER of the
// reasons (which is the diagnostic value of the trace) fails here.
{
  const start = cv.indexOf('  _autoPagingBlocked() {');
  const end = cv.indexOf('\n  }\n', start);
  ok('the _autoPagingBlocked source is extractable for the unit below', start > 0 && end > start);
  if (start > 0 && end > start) {
    const body = cv.slice(cv.indexOf('{', start) + 1, end);
    const win = {};
    const decide = new Function('window', `return function () {${body}\n}`)(win);
    const NOW = Date.now();
    const clear = () => ({ _pinned: false, _lastStructuralAt: NOW - 9e5, _lastUserScrollAt: NOW - 100, _resumeSettleUntil: 0 });
    const call = (over) => { win.__vsInputResizeAt = 0; win.__vsViewportResizeAt = 0; return decide.call({ ...clear(), ...over }); };
    ok('unit: a clean, recently-scrolled, unpinned view may page', call({}) === null);
    ok('unit: disposed blocks', call({ _disposed: true }) === 'disposed');
    ok('unit: a desktop-HIDDEN view blocks (geometry is meaningless)', call({ _suspended: true }) === 'suspended');
    ok('unit: a just-RESUMED view blocks for the settle window', call({ _resumeSettleUntil: NOW + 500 }) === 'resume-settle');
    ok('unit: a PINNED view blocks — it is at the live tail by definition (THE inc-mtq5bpjt-0o0n case)', call({ _pinned: true }) === 'pinned');
    ok('unit: our own recent structural mutation blocks (it is still moving scrollTop)', call({ _lastStructuralAt: NOW - 200 }) === 'settling');
    ok('unit: no recent user input blocks — displacement is not intent', call({ _lastUserScrollAt: NOW - 5000 }) === 'no-input');
    ok('unit: …and a view that NEVER saw user input blocks too (undefined, not just stale)', call({ _lastUserScrollAt: undefined }) === 'no-input');
    ok('unit: input-box / viewport resize blocks (the 2.338/2.339 displacement doors)',
      (() => { win.__vsInputResizeAt = NOW - 50; win.__vsViewportResizeAt = 0; return decide.call(clear()) === 'input-resize'; })());
    ok('unit: suspend outranks pin outranks no-input (reason ORDER is the diagnostic)',
      call({ _suspended: true, _pinned: true, _lastUserScrollAt: 0 }) === 'suspended'
      && call({ _pinned: true, _lastUserScrollAt: 0 }) === 'pinned');
  }
}

// ── FUNCTIONAL: the resume RE-TAIL and its pin SNAPSHOT. The settle expires
// and the pinned re-tail runs a beat later; an input-LESS displacement landing
// in that gap reached the scroll handler, unpinned the window, and the re-tail
// — which asserted off the LIVE flag — then refused, stranding the window in
// history for good (repro: scrollTop=0 injected at resume+1210ms). setSuspended
// is DOM-free enough to run right here, so the two behaviours are pinned by
// EXECUTION, not by regex: a transitional unpin still returns to the tail, and
// a real reader who scrolled away is left exactly where they are.
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
{
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkView = (over = {}) => Object.assign(Object.create(ChatView.prototype), {
    _suspended: false, _disposed: false, _pinned: true, _teleported: false,
    _windowEnd: 100, _total: 100, _newMsgCount: 3,
    _scrollBtn: { classList: { add() {}, remove() {} } },
    _updateRunBar() {}, _scheduleRunBar() {},
    jumpToBottom() { this._jumps = (this._jumps || 0) + 1; this._pinned = true; },
    _scrollToBottom() { this._scrolls = (this._scrolls || 0) + 1; },
    ...over,
  });
  const retails = (v) => (v._scrolls || 0) + (v._jumps || 0);
  const resumeThen = async (mutate, over) => {
    const v = mkView(over);
    v.setSuspended(true);                            // desktop hidden
    v.setSuspended(false);                           // …and shown again
    await nap(60);                                   // the immediate rAF re-tail
    const baseline = retails(v);
    mutate?.(v);
    await nap(1500);                                 // past RESUME_SETTLE_MS + the slack
    return { v, retailed: retails(v) > baseline };
  };
  const snap = mkView(); snap.setSuspended(true);
  ok('setSuspended(true) SNAPSHOTS the pin — the last honest reading before the geometry starts lying', snap._pinnedAtSuspend === true);
  const snapOff = mkView({ _pinned: false }); snapOff.setSuspended(true);
  ok('…and an unpinned window snapshots FALSE (a reader in history is not dragged anywhere)', snapOff._pinnedAtSuspend === false);
  const [gap, reader, never] = await Promise.all([
    resumeThen((v) => { v._pinned = false; }),                        // input-LESS transitional unpin (THE hole)
    resumeThen((v) => { v._pinned = false; v._endResumeSettle(); }),  // a real reader scrolled away
    resumeThen(null, { _pinned: false }),                             // was never pinned to begin with
  ]);
  ok('a transitional (input-LESS) unpin during the resume still ends at the LIVE tail — the re-tail asserts off the snapshot', gap.retailed && gap.v._pinned === true);
  ok('…and a REAL reader who scrolled away during the settle is left alone (input drops the snapshot)', !reader.retailed && reader.v._pinned === false);
  ok('a window that was NOT pinned when it was hidden is never dragged to the tail', !never.retailed && retails(never.v) === 0);

  // ROUND 2 (a): a reader who NAVIGATED (minimap / search reveal / run bar /
  // jumpToIndex) during the settle is left where they landed. The four
  // message-list listeners were the only thing that ended the settle, so this
  // reader used to be yanked to the live tail by the 1240ms re-tail.
  const navs = await Promise.all([
    resumeThen((v) => { v._pinned = false; v._noteUserNav('minimap'); }),
    resumeThen((v) => { v._pinned = false; v._lastJumpAt = Date.now(); }),         // a jump LANDING (_scrollElStable) with no other stamp
    resumeThen((v) => { v._pinned = false; v._search = { _lastRevealAt: Date.now() }; }), // a search reveal
  ]);
  ok('a reader who navigates during the settle (minimap/run-bar/jumpToIndex → _noteUserNav) is NEVER yanked back to the tail',
    !navs[0].retailed && navs[0].v._pinned === false);
  ok('…and a bare jump LANDING counts as navigation too (the seek idiom generalised: _lastJumpAt)',
    !navs[1].retailed && navs[1].v._pinned === false);
  ok('…as does a search reveal (it scrolls the list from outside the list\'s own listeners)',
    !navs[2].retailed && navs[2].v._pinned === false);

  // ROUND 3: a CLICK during the settle must NOT disarm the repair, while a
  // real positioning act still owns the position. This is the verifier's
  // MAJOR in unit form — the pre-fix listener ran _endResumeSettle() for both.
  const [clicked, positioned] = await Promise.all([
    resumeThen((v) => { v._noteUserInput(); v._pinned = false; }),      // click, then the resume's own displacement
    resumeThen((v) => { v._notePositioning('wheel'); v._pinned = false; }), // a reader who actually moved the view
  ]);
  ok('a CLICK during the settle leaves the repair armed — the input-LESS displacement behind it is still repaired (round-3 MAJOR)',
    clicked.retailed && clicked.v._pinned === true);
  ok('…while a real POSITIONING act during the settle still hands the position to the reader (nothing yanks them back)',
    !positioned.retailed && positioned.v._pinned === false);
  ok('…and the click did end the settle WINDOW (a reader who touched the view is never left with a frozen one)',
    clicked.v._resumeSettleUntil === 0);

  // ROUND 2 (b): the re-assert SERIES — the transitional unpin is repaired at
  // every rung while the snapshot holds, not once at a cliff edge.
  const late = await (async () => {
    const v = mkView();
    v.setSuspended(true); v.setSuspended(false);
    await nap(1400);                       // past the settle AND the first re-tail
    const baseline = retails(v);
    v._pinned = false;                     // input-LESS displacement, the 1400ms repro
    await nap(900);                        // the 2000ms rung
    return { v, repaired: retails(v) > baseline };
  })();
  ok('an input-LESS unpin AFTER the settle expires is still repaired by the bounded series (the +1400ms strand, 3/3 sessions)',
    late.repaired && late.v._pinned === true);

  // ROUND 2 (c): the UNPIN gate itself — positive evidence, DOM-free, run
  // against the SHIPPED predicate.
  const disp = (over) => ChatView.prototype._resumeDisplacement.call(Object.assign(
    Object.create(ChatView.prototype),
    { _resumeAt: Date.now() - 1400, _pinnedAtSuspend: true, _lastUserScrollAt: Date.now() - 9e5, _lastPositionAt: 0, _lastNavAt: 0, _lastJumpAt: 0 },
    over));
  ok('unit: an input-less unpin 1.4s after a resume, off a pinned snapshot, is DISPLACEMENT', disp({}) === true);
  ok('unit: …but a reader who MOVED the view since the resume is INTENT', disp({ _lastPositionAt: Date.now() }) === false);
  ok('unit: …and a bare CLICK since the resume is NOT (round-3 MAJOR: it stamps input, it positions nothing)',
    disp({ _lastUserScrollAt: Date.now() }) === true);
  ok('unit: …and so is a reader who navigated since the resume', disp({ _lastNavAt: Date.now() }) === false);
  ok('unit: a window that was reading history when it was hidden is never re-pinned', disp({ _pinnedAtSuspend: false }) === false);
  ok('unit: past the horizon the gate is off — a normal unpin must always be possible', disp({ _resumeAt: Date.now() - 4000 }) === false);
  ok('unit: a view that never resumed is unaffected (the gate is scoped to the resume)', disp({ _resumeAt: 0 }) === false);

  // ROUND 3 (b) / ROUND 4: the scrollbar-drag predicate — the only way a drag
  // can be told from a click, and the reason a click can stay non-positioning.
  // Round 4 re-keyed it from WHEN (a 400ms window after any pointerdown, which
  // the resume's own displacement walked straight through) to WHERE the press
  // landed, held for the whole press.
  const drag = (over, st) => ChatView.prototype._pointerDragScroll.call(Object.assign(
    Object.create(ChatView.prototype),
    { _pointerDownOnScrollbar: true, _pointerDownScrollTop: 900 }, over), st);
  ok('unit: a scroll while a GUTTER press is held, that MOVED the view, is a drag', drag({}, 400) === true);
  ok('unit: …in either direction', drag({}, 1400) === true);
  ok('unit: …and however LATE it comes — the press is held, so it is still the reader dragging (round-4 MAJOR ②: the 400ms window dropped this reader and the re-tail yanked them back)',
    drag({}, 1400) === true && drag({}, 400) === true);
  ok('unit: a gutter press with no displacement positions nothing', drag({}, 901) === false);
  ok('unit: a press in the CONTENT area is never a drag, however large the displacement that follows (round-4 MAJOR ①: the resume\'s own re-measure behind a click)',
    drag({ _pointerDownOnScrollbar: false }, 0) === false);
  ok('unit: …and with no press at all it is never a drag', drag({ _pointerDownOnScrollbar: undefined }, 0) === false);

  // ROUND 4: the gutter hit-test itself. DOM-free (injected geometry), so the
  // SHIPPED predicate runs right here — content click false, gutter press true.
  const mkList = (over = {}) => ({
    offsetWidth: 800, clientWidth: 785, offsetHeight: 600, clientHeight: 600,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
    ...over,
  });
  const onSb = (x, y, list) => ChatView.prototype._pointerOnScrollbar.call(
    Object.assign(Object.create(ChatView.prototype), { _messageList: list || mkList() }), { clientX: x, clientY: y });
  ok('unit: a click in the CONTENT area is not on the scrollbar', onSb(400, 300) === false);
  ok('unit: …not even at the last content pixel before the gutter', onSb(884, 300) === false);
  ok('unit: a press in the vertical GUTTER is (x = rect.left + clientWidth …+ gutter)', onSb(893, 300) === true);
  ok('unit: a list with NO scrollbar (the semantic minimap sets scrollbar-width:none) has no gutter to press',
    onSb(899, 300, mkList({ clientWidth: 800 })) === false);
  // uiScale body zoom 1.5×: the rect and clientX are scaled, clientWidth is
  // not. A CONTENT press at layout x=600 reads (clientX - left) = 900 in
  // viewport px — which the un-converted comparison would call a gutter press
  // (900 >= 785). The 2.369.5 VNC-pointer class, in miniature.
  {
    const zoomed = () => mkList({ getBoundingClientRect: () => ({ left: 100, top: 50, width: 1200, height: 900 }) });
    ok('unit: under uiScale zoom the rect is scaled and clientWidth is not — the hit-test converts to layout px first (2.369.5 class)',
      onSb(100 + 793 * 1.5, 300, zoomed()) === true
      && onSb(100 + 600 * 1.5, 300, zoomed()) === false);
  }
  ok('unit: a HORIZONTAL gutter along the bottom counts too', onSb(400, 50 + 595, mkList({ clientHeight: 585 })) === true);
  ok('unit: a detached / unmeasurable list answers false rather than throwing',
    onSb(400, 300, mkList({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) })) === false);
  // …and with a computed style available (the browser case): RTL puts the
  // vertical gutter on the LEFT, and a border is part of neither box.
  {
    const prev = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (el) => ({
      direction: el.__dir || 'ltr', borderLeftWidth: (el.__b || 0) + 'px', borderRightWidth: (el.__b || 0) + 'px',
      borderTopWidth: (el.__b || 0) + 'px', borderBottomWidth: (el.__b || 0) + 'px',
    });
    try {
      const rtl = mkList({ __dir: 'rtl' });
      ok('unit: RTL — the vertical gutter is on the LEFT', onSb(103, 300, rtl) === true && onSb(893, 300, rtl) === false);
      // 4px borders: gutter = offsetWidth - clientWidth - 8 = 7px, at [789, 796)
      const bordered = mkList({ clientWidth: 785, __b: 4 });
      ok('unit: a BORDER is not a scrollbar — the gutter is measured inside it', onSb(100 + 792, 300, bordered) === true && onSb(100 + 700, 300, bordered) === false);
    } finally { globalThis.getComputedStyle = prev; }
  }
}

// ── WIRING PIN: the desktop show/hide path must keep flowing the flag (a new
// hide/show writer that forgets it re-opens the whole class)
ok('desktop _showWin resumes the ChatView (the resume settle is armed from there)',
  /_showWin\(win\) \{[\s\S]{0,500}setSuspended\?\.\(false\)/.test(dm));

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
