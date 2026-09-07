import { copyText, escHtml, showToast, showConfirmDialog, collectDroppedFiles, showImageOverlay, fetchJson } from './utils.js';
import { installChatSeek } from './chat-view-seek.js';
import { metric, track } from './telemetry-client.js';
import { stripAnsi } from './highlight.js';
import { ChatMinimap } from './chat-minimap.js';
import { ChatSearch } from './chat-search.js';
import { ChatRenderers, toolDisplayName, formatSleepRemaining } from './chat-renderers.js';
import { ChatInput } from './chat-input.js';
import { ChatStatusBar } from './chat-status-bar.js';
import { UI_ICONS } from './icons.js';
import { t } from './i18n.js';
import { agentMemoryPathRes, effortDisplay, getBackendMeta } from './agent-meta.js';
import { registerCommand, registerKeybinding, runCommand, hasCommand } from './contributions.js';
// The verb list a wrapper that publishes a queue WITHOUT naming verbs serves —
// the SAME array the server maps a verb-less sidecar onto (src/server/
// wrapper-files.js). Imported, never re-typed: the two ends disagreeing about
// "no list" is the bug this constant now prevents.
import { LEGACY_QUEUE_VERBS } from '../backend-caps.js';
import { mcpParts, messageKind, foldToggleFor, countKinds, runSummaryLabel } from './chat-run-summary.js';
import { collabTrafficStats, collabHeadText, collabRunPart, subAgentStreamLabel } from '../collab-row.js';

// Agent-memory path patterns, PER BACKEND from BACKEND_META (agent-meta.js —
// claude only today; codex has no memory feature; a new backend adds one
// memoryPathRe entry there). Unioned: the PATH identifies memory content
// regardless of which session's file op touches it.
const MEMORY_PATH_RES = agentMemoryPathRes();
const isMemoryPath = (fp) => MEMORY_PATH_RES.some((re) => re.test(fp));

// ── THE STEER CHORD (2026-09-07 owner ask: "顺便加入一个queue的快捷键,
//    不支持queue的就不显示") ───────────────────────────────────────────────
// A CONTRIBUTED command, not a private handler: plugins can see it, rebind it
// and run it (contributions.js §Ph1), and the composer's own Alt+Enter routes
// through the SAME id, so there is exactly ONE definition of what the chord
// does. The command is registered ONCE for the app — registerCommand rejects a
// duplicate id BY DESIGN, so a per-view registration would throw on the second
// chat window; the per-view part is the KEYBINDING, which carries the view's
// AbortSignal and a `when` that scopes the chord to the window the keystroke
// happened in.
export const STEER_NOW_COMMAND = 'chat.steerNow';
// Every MOUNTED ChatView, so a document-level keystroke can find the view it
// belongs to (the dispatcher's ctx is app-wide: `{ app, event }`). Entries are
// added at construction and removed in dispose() — a Set of live views, never
// a "last focused" guess.
const LIVE_CHAT_VIEWS = new Set();

/** The view a command invocation is about: an explicit `ctx.view` (the
 *  composer route hands itself in) or the mounted view whose container
 *  contains the keystroke's target. Null when neither answers — a chord
 *  pressed outside every chat window does nothing, loudly to nobody. */
function steerTargetView(ctx) {
  if (typeof ctx?.view?.steerComposerText === 'function') return ctx.view;
  const target = ctx?.event?.target;
  if (!target) return null;
  for (const v of LIVE_CHAT_VIEWS) {
    if (v._disposed) continue;
    try { if (v._container?.contains?.(target)) return v; } catch { }
  }
  return null;
}

if (!hasCommand(STEER_NOW_COMMAND)) {
  registerCommand({
    id: STEER_NOW_COMMAND,
    title: () => t('Send now — inject into the running turn'),
    icon: UI_ICONS.bolt,
    // `when` gates SURFACES (the keybinding); runCommand never consults it, so
    // a plugin calling it on a harness that cannot steer gets the same honest
    // no-op the composer would give.
    when: (ctx) => !!steerTargetView(ctx)?._canSteerComposer(),
    run: (ctx) => steerTargetView(ctx)?.steerComposerText() ?? false,
  });
}

// How long a just-un-hidden (desktop-resumed) chat window is treated as
// "still re-measuring": every AUTOMATIC paging trigger no-ops and the pinned
// re-tail is re-asserted at the end. Sized from the inc-mtq5bpjt-0o0n capture,
// where the resume bounce ran +366…+602 ms after the desktop-preview click.
const RESUME_SETTLE_MS = 1200;
// The pinned re-tail runs just AFTER the settle expires; the settle window
// carries the same slack so the scroll handler cannot decide (and unpin) in
// between — an input-less re-measure landing in that gap used to strand the
// window in history for good.
const RESUME_RETAIL_SLACK_MS = 40;
// The pinned re-tail is a bounded SERIES, not a one-shot cliff (round-2
// verifier's minor, reproduced 3/3): the re-measure keeps producing input-less
// displacement after the settle expires — a scrollTop=0 injected at resume
// +1400ms unpinned the window and stranded it, and +1240/+1280 only survived
// because _forceScrollToBottom's 10-frame chain happened to still be running.
const RESUME_RETAIL_AT_MS = [RESUME_SETTLE_MS + RESUME_RETAIL_SLACK_MS, 2000];
// …and for that whole horizon an atBottom→false transition with NO scroll or
// navigation since the resume is DISPLACEMENT, not intent: the unpin itself is
// gated on positive evidence, exactly like the paging gates. 2.8s = past the
// last re-tail rung (2000) with room for the re-measure's own tail — the
// displacement the rungs cannot catch is exactly the one that arrives BETWEEN
// them, so the evidence gate must outlive them.
const RESUME_DISPLACEMENT_MS = 2800;
// THE KEYS THAT MOVE THE VIEW. A keydown on one of these is a positioning act
// (it scrolls the list itself); any other key is mere input — see
// _notePositioning vs _noteUserInput (round-3 verifier's MAJOR).
const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', ' '];
// A scrollbar drag is the one positioning act with NO event of its own: it
// produces a pointerdown and then plain scroll events. It is identified by
// WHERE THE PRESS LANDED — the list's own scrollbar gutter — and stays a drag
// for as long as that press is held (round-4 verifier's two MAJORs against the
// old "a scroll within 400ms of ANY pointerdown that moved the view" signature:
// ① the resume's own input-LESS displacement (the incident's re-measure bounces
// at +366…+602ms) landing within the window of a plain content click was read
// as a drag, so the click disarmed the pin snapshot + re-tail series and the
// incident reproduced behind it; ② a drag whose first move came later than the
// window was never positioning at all, and the re-tail series yanked that
// reader back to the tail — a NEW harm vs master). A press in the CONTENT area
// is a click no matter how close in time a displacement lands; a
// press-and-hold-then-drag is positioning for the whole press.
const POINTER_DRAG_PX = 2;
// SCOPED REFUSALS — a per-session `error` frame that rejects ONE ACTION and
// leaves the session alive (inc-mt2arppw: a too-large paste flipped the LIVE
// window into the Resume bar, because the only reading of a session-scoped
// error was "attach failed"). This is an EXPLICIT ALLOW-LIST, not "anything
// with a code": `ended-during-attach` (ws-handler, after the history rebuild)
// is a coded error whose session is GONE, and it must keep taking the
// view-only rescue + Resume bar or a dead session renders as a live-looking
// empty window (round-1 review caught the over-generalization). A NEW
// server-side refusal opts in either by joining this set or — preferred, so
// the client needs no release — by carrying `scope:'action'` on the frame.
// "This session has no queue surface" — one frozen object, so every caller of
// _queueCaps() gets the SAME shape (a missing queueVerbs key would render a
// strip with no controls instead of no strip).
const NO_QUEUE_CAPS = Object.freeze({ queue: false, steer: false, queueOps: false, queueVerbs: Object.freeze([]) });
const SCOPED_REFUSAL_CODES = new Set([
  'input-rejected',        // chat-input refused (size / frame-file capability)
  'not-codex-chat',        // a codex-only action on a non-codex or dead-chat session
  'queue-op-unsupported',  // the harness has no such input-queue operation
]);
/** Is this `error` frame a refusal of one action (vs. "this session is gone")? */
function isScopedRefusal(msg) {
  return msg?.scope === 'action' || (!!msg?.code && SCOPED_REFUSAL_CODES.has(msg.code));
}

/**
 * ChatView — renders a chat interface for stream-json mode sessions.
 * Displays structured messages from Claude Code's --output-format stream-json.
 * Input goes to the same PTY session via WebSocket.
 */
class ChatView {
  constructor(winInfo, wsManager, sessionId, app, { readOnly = false, subagentView = false } = {}) {
    this.winInfo = winInfo;
    this.ws = wsManager;
    this.sessionId = sessionId;
    this.app = app;
    this._readOnly = readOnly;
    // A sub-agent's own conversation opened from its parent (codex collab
    // child thread via viewSession, agentKind 'subagent'): read-only by
    // nature — resuming it would spawn a standalone session on a thread that
    // only ever ran inside its parent's turn. Owner report 2026-09-07: the
    // codex child opened through the generic view path and showed the dead-
    // session 'Resume this session' bar.
    this._subagentView = !!subagentView;
    // Subagent viewers (sub-*) can't paginate; view-only history (view-*) and normal sessions can
    this._canPaginate = !sessionId.startsWith('sub-');
    this._messages = []; // normalized message objects
    this._elements = new Map(); // msg.id → DOM element
    // Cards whose head was PAINTED with a live age (2026-09-07 r2). The ticker
    // alone cannot know them: a burst that runs while the window is hidden
    // never ticks, yet the renderer still paints each coalescing edit live —
    // so the SET is what gets frozen at turn end, not the ticker's last card.
    this._liveHeadIds = new Set();
    this._pinned = true; // auto-scroll to bottom
    this._renderedMsgIds = new Set(); // dedup by msgId
    // Desktop-resume settle window (inc-mtq5bpjt-0o0n): while a just-shown
    // window re-measures, EVERY automatic paging trigger is a no-op. Stamped
    // by setSuspended(false), cleared by real user input. `_pinnedAtSuspend`
    // is the last honest pin reading (taken when the window was hidden) — the
    // resume re-tail asserts off it, so a transitional unpin can't strand the
    // window in history.
    this._resumeSettleUntil = 0;
    this._pinnedAtSuspend = false;
    // When the resume happened, and when the reader last POSITIONED the view
    // on purpose through a path that is not one of the message list's own
    // input listeners (minimap, search reveal, floating run bar, jump). The
    // re-tail and the unpin gate below both compare nav-vs-resume — the
    // chat-view-seek `userScrolled` idiom, generalised.
    this._resumeAt = 0;
    this._lastNavAt = 0;
    // The last POSITIONING act (wheel / touchmove / navigation key / scrollbar
    // drag). Deliberately NOT stamped by a bare click: `_lastUserScrollAt`
    // answers "did the reader touch this view" (the paging gates want that),
    // `_lastPositionAt` answers "did the reader MOVE it" — only the second may
    // cancel the resume repair (round-3 verifier's MAJOR).
    this._lastPositionAt = 0;
    // Did the live press land on the list's own SCROLLBAR GUTTER? While it is
    // held, a scroll is the reader dragging the view — WHERE the press landed,
    // never WHEN a later scroll happens to arrive (round-4 verifier's MAJORs).
    this._pointerDownOnScrollbar = false;
    this._pointerDownScrollTop = 0;
    this._resumeRetailTimers = [];
    // INPUT QUEUE (mid-turn sends). `_queueSupported` starts FALSE: we do not
    // yet know whether THIS session's running wrapper publishes a queue, and
    // guessing yes is the wrapper-skew bug (a chip that never clears). It
    // flips on the attach payload's `queueSupported` or the wrapper's own
    // baseline `queue_changed` — both arrive long before anything can queue.
    this._queue = [];
    this._queueSupported = false;
    // WHICH verbs the running wrapper serves (null = nothing has said yet —
    // the harness row alone then decides, exactly as before the verb table).
    this._queueVerbsServed = null;
    this._queueChipRaf = 0;   // pending re-application of the chips (see _setQueueSupported)

    // Build DOM
    const container = document.createElement('div');
    container.className = 'chat-view';
    this._container = container;
    // Mounted: a document-level chord can now resolve to this view by its
    // container (see steerTargetView). Registered BEFORE the read-only early
    // return so a view-only window answers the chord honestly (it has no
    // composer ⇒ `_canSteerComposer()` is false) instead of being invisible
    // and letting the chord land on some other window.
    LIVE_CHAT_VIEWS.add(this);
    // msgId → the timer waiting for that message to appear in the harness's
    // queue so it can be converted to a steer (see _steerAfterSend). A MAP,
    // not one slot: two quick chords must both land.
    this._pendingSteers = new Map();

    // Settings listeners are tracked and removed in dispose() — the
    // SettingsManager keeps them in a permanent Set, so untracked listeners
    // leak the whole view DOM per closed chat window.
    this._settingsListeners = [];
    const onSetting = (key, fn) => { app.settings?.on(key, fn); this._settingsListeners.push([key, fn]); };

    // Apply compact mode
    this._compact = app.settings?.get('chat.compactMode') ?? true;
    if (this._compact) container.classList.add('chat-compact');
    onSetting('chat.compactMode', (v) => {
      this._compact = v;
      container.classList.toggle('chat-compact', v);
      if (this._renderers) this._renderers._compact = v;
      // compact vs bubble is a per-message DOM STRUCTURE decided at render
      // time (wrapMsg) — flipping the class alone left already-rendered
      // cards in the old structure under the new mode's CSS (real report:
      // broken Update card after toggling). Rebuild what's on screen.
      this._rerenderVisible();
    });

    // Apply font size from global settings (scale message list relative to base 14px)
    const BASE_FONT = 14;
    const fontSize = parseInt(localStorage.getItem('termFontSize')) || BASE_FONT;
    this._chatScale = fontSize / BASE_FONT;
    this._applyFontSize = (size) => {
      this._chatScale = size / BASE_FONT;
      this._messageList.style.zoom = this._chatScale;
    };

    // Role indicator style
    const roleStyle = app.settings?.get('chat.roleIndicator') ?? 'border';
    container.dataset.roleIndicator = roleStyle;
    onSetting('chat.roleIndicator', (v) => {
      container.dataset.roleIndicator = v;
    });

    // Status bar
    this._statusBar = new ChatStatusBar(wsManager, sessionId, {
      backend: winInfo.backend || winInfo.titleMeta?.backend || 'claude',
      allowReview: !readOnly,
      getToolMsg: (toolCallId) => this._messages.find(m => m.toolCallId === toolCallId),
      openSubagentViewer: (opts) => this._openSubagentViewer(opts),
      openInTempEditor: (text) => this._renderers.openInTempEditor(text),
      startReview: (opts) => this._startReview(opts),
      // Mid-session model/effort picks persist as this session's per-session
      // config (same store as the Resume gear popover) so the next resume
      // starts with the same choice.
      onConfigChange: (patch) => this._persistSessionConfig(patch),
      // one-click Terminate+Resume from the style menu (owner UX 2.369.8)
      onRestartSession: readOnly ? null : () => this.app?.restartConversationInPlace?.({ webuiId: this.sessionId }),
      // Design chip (2.366.0): a brief → a design request the agent fulfils
      // with the design kit and publishes to THIS VibeSpace (view-only windows: none)
      onDesignRequest: readOnly ? null : (brief, opts) => this._sendDesignRequest(brief, opts), // false = refused (the dropdown keeps the brief)
      // Running-workflow chips: click → live detail window; poll needs ids
      onOpenWorkflow: (runId, name) => {
        const ids = this._getSessionIds();
        this.app.openWorkflowDetail(runId, { claudeSessionId: ids.claudeId, cwd: ids.cwd, host: ids.host, name });
      },
      getWorkflowIds: () => { const ids = this._getSessionIds(); return { claudeId: ids.claudeId, cwd: ids.cwd, host: ids.host }; },
    });
    // Initial render: a brand-new session has no chatStatus yet — show the
    // honest unknown badges (model: ? / effort: ?) instead of an empty bar.
    this._statusBar.render();
    this._statusBar.popupContainer = container;
    this._syncReviewAvailability();

    // Message list
    this._messageList = document.createElement('div');
    this._messageList.className = 'chat-message-list';
    // Media-card thumbnails that cannot load (file deleted, or a history viewed
    // from a machine that does not have it) swap to the honest "not available"
    // line — `error` does not bubble, so this is a CAPTURE-phase delegate on
    // the list (no inline handlers in rendered HTML; 2.369.48)
    this._messageList.addEventListener('error', (e) => {
      const img = e.target;
      if (img?.tagName === 'IMG' && img.classList?.contains('chat-tool-img')) img.closest('.chat-media')?.classList.add('chat-media-broken');
    }, true);
    // Consecutive thinking/Bash run collapse (chat.collapseRuns, default ON —
    // TUI-style): a MutationObserver keeps the decoration current across live
    // appends, edits, virtual-scroll trims and jumps without touching any of
    // those paths. _runsMutating guards against self-triggering (the pass
    // itself inserts/removes headers).
    this._runsTimer = null;
    this._runsMutating = false;
    this._runsObserver = new MutationObserver((records) => {
      if (this._runsMutating) return;
      // NO VISIBLE FLASH (2.227.9, user report "会展示一瞬间然后才折叠"): the
      // 180ms debounce let a foldable card paint at full size first. A
      // MutationObserver callback runs at the microtask checkpoint — BEFORE
      // the next paint — so folding synchronously here makes the card appear
      // already folded. Only for pure TAIL APPENDS (live streaming): bulk
      // inserts (pagination, jumps, trims) keep the debounce, where the pass
      // is expensive and a frame of delay is invisible anyway.
      const list = this._messageList;
      const tailAppend = list && records.length && records.every((r) =>
        r.type === 'childList' && r.removedNodes.length === 0 && r.addedNodes.length > 0
        && r.nextSibling === null);
      if (tailAppend) {
        // rAF-coalesced (2.338.0): rAF callbacks run BEFORE the next paint,
        // so the no-flash guarantee above holds — but a streaming burst now
        // costs ONE full-list runs pass per frame instead of one per append.
        clearTimeout(this._runsTimer); this._runsTimer = null;
        if (!this._runsRaf) this._runsRaf = requestAnimationFrame(() => { this._runsRaf = null; if (!this._disposed) this._updateRuns(); });
        return;
      }
      clearTimeout(this._runsTimer);
      this._runsTimer = setTimeout(() => this._updateRuns(), 180);
    });
    this._runsObserver.observe(this._messageList, { childList: true });
    this._runExpanded = new WeakSet(); // first member of runs the user opened
    // Runs the user opened DELIBERATELY while they were NOT the live tail —
    // exempt from the pinned auto-refold in _updateRuns (2026-09-06: that
    // branch closed the very run a click had just opened). Keyed by member
    // element like _runExpanded, because run records are rebuilt every pass.
    this._runStickyOpen = new WeakSet();
    // Live re-fold on toggle — the observer only fires on list mutations, so
    // a settings change used to take effect on the NEXT message only.
    onSetting('chat.collapseRuns', () => this._updateRuns());
    onSetting('chat.collapseKinds', () => this._updateRuns());
    // Search open/close changes no list children — watch the bar's class so
    // runs expand while searching (reveal must reach hidden members) and
    // re-collapse after.
    queueMicrotask(() => {
      if (this._disposed || !this._search?._bar) return;
      this._searchBarObserver = new MutationObserver(() => this._updateRuns());
      this._searchBarObserver.observe(this._search._bar, { attributes: true, attributeFilter: ['class'] });
    });

    // Always-on scroll tracer ring (v2, B-21bc): every scroll-affecting path
    // records positions + op tags into a capped in-memory ring; "Report a
    // problem" ships each chat window's tail automatically. See _trace below.
    this._installScrollTracer();

    // Renderers (extracted rendering methods)
    this._renderers = new ChatRenderers({
      getSessionCtx: () => this._getSessionIds(), // view-only/terminated windows keep host+cwd via openSpec
      // In-chat ACTION buttons (Compact now): product-authored text, so the
      // send owns neither the draft slot nor the store — `carriesUserText`
      // stays false EXPLICITLY (round-8: the flag is the difference between
      // this caller and the design request below). Null-safe for view-only.
      onSendText: (txt) => this._chatInput?.sendText(txt, { carriesUserText: false }),
      ws: wsManager,
      sessionId,
      app,
      backend: winInfo.backend || winInfo.titleMeta?.backend || 'claude',
      compact: this._compact,
      messageList: this._messageList,
      onPermissionResolve: () => { this._hideTyping(); this._updateRuns(); },
      onFork: (uuid, msg) => this._forkFromMessage(uuid, msg),
      // A 'queued' chip on a bubble is a second entry point for the same op as
      // the strip's Steer button — one path, one ws message. The renderer asks
      // the VIEW what the queue allows (harness row ∧ running wrapper), so
      // there is exactly one definition of "can steer".
      onQueueChipClick: (msg) => this._steerQueuedMessage(msg),
      getQueueCaps: () => this._queueCaps(),
      // live sub-agent traffic (2026-09-07): only the view knows whether a
      // collab card is still the one the next row lands in on a live turn
      isCollabLive: (msg) => this._noteCollabHeadPainted(msg?.id, this._liveCollabId() === msg?.id),
    });

    // Position indicator (shows when not at bottom, e.g. "120-170 / 3000")
    this._posIndicator = document.createElement('div');
    this._posIndicator.className = 'chat-pos-indicator hidden';
    if (this._chatScale !== 1) this._messageList.style.zoom = this._chatScale;
    container.appendChild(this._messageList);
    container.appendChild(this._posIndicator);

    // Scroll minimap — semantic scrollbar showing turns
    // The minimap's pointer events live on the CONTAINER, not on the message
    // list — none of the four list listeners that end the resume settle ever
    // see a minimap drag, so the landing itself is the navigation stamp
    // (round-2 verifier's MAJOR: a minimap/search/run-bar jump 400ms into a
    // desktop resume was yanked back to the live tail 2.2s later).
    this._chatMinimap = new ChatMinimap(container, this._messageList,
      (idx) => { this._noteUserNav('minimap'); return this.jumpToIndex(idx); },
      (ts, line) => { this._noteUserNav('minimap-time'); return this._jumpToFileTime(ts, line); });
    // Sync minimap bounds on resize
    // Minimap ResizeObserver is handled by ChatMinimap internally

    // Scroll-to-bottom / pin button (shown when unpinned, with new message count)
    this._newMsgCount = 0;
    this._scrollBtn = document.createElement('button');
    this._scrollBtn.className = 'chat-scroll-btn hidden';
    this._scrollBtn.innerHTML = '\u2193';
    this._scrollBtn.title = t('Scroll to bottom');
    this._scrollBtn.onclick = () => {
      if (this._teleported) { this.jumpToBottom(); return; }   // return to latest
      if (this._readOnly || !this.sessionId) {
        // Read-only or no session: just scroll, don't fetch
        this._pinned = true;
        this._newMsgCount = 0;
        this._scrollBtn.classList.add('hidden');
        this._forceScrollToBottom();
      } else {
        this.jumpToBottom();
      }
    };
    // Wrap scroll button in a zero-height container between message list and input
    this._scrollBtnWrap = document.createElement('div');
    this._scrollBtnWrap.className = 'chat-scroll-btn-wrap';
    this._scrollBtnWrap.appendChild(this._scrollBtn);
    container.appendChild(this._scrollBtnWrap);

    // Wheel at top edge: scroll event won't fire when already at scrollTop=0,
    // so use wheel to detect upward scroll intent and trigger pagination
    // Right-click on a message's LEFT INDICATOR STRIP (the role color bar) →
    // per-message metadata popup (model / token usage / request id / uuid).
    // Restricted to the strip so normal right-click (copy text…) keeps the
    // native menu everywhere else; long-press synthesizes contextmenu on touch.
    this._messageList.addEventListener('contextmenu', (e) => {
      const msgEl = e.target.closest('.chat-msg');
      if (!msgEl || !msgEl.dataset.msgId) return;
      if (e.clientX - msgEl.getBoundingClientRect().left > 18) return; // strip only
      const id = isNaN(+msgEl.dataset.msgId) ? msgEl.dataset.msgId : +msgEl.dataset.msgId;
      const msg = this._messages.find(m => m.id === id || String(m.id) === String(msgEl.dataset.msgId));
      if (!msg) return;
      e.preventDefault();
      this._showMsgMeta(msg, e.clientX, e.clientY);
    });
    this._messageList.addEventListener('wheel', (e) => {
      // A wheel is a POSITIONING act: it ends the resume settle AND drops the
      // pin snapshot (inc-mtq5bpjt-0o0n) — the settle exists to suppress
      // INPUT-LESS displacement while a just-shown window re-measures, and it
      // must never hold up a reader who actually moved the view.
      this._notePositioning('wheel');
      // DIRECTION of the user's intent. Content growth (content-visibility
      // resolving a freshly paged batch) moves scrollTop with NO direction of
      // its own — native scroll anchoring pushes it numerically DOWN to keep
      // the view stable — and that was being read as "the user is scrolling
      // toward the end". This is the only reliable discriminator.
      if (e.deltaY) { this._wheelDir = e.deltaY > 0 ? 1 : -1; this._wheelDirAt = Date.now(); }
    }, { passive: true });
    this._messageList.addEventListener('touchmove', () => this._notePositioning('touch'), { passive: true });
    // Scrollbar drags and keyboard paging produce NO wheel/touch events — they
    // must still count as user input for the positive-evidence gate below
    // (inc-mspemym2 round 5), or those readers stall at the window end.
    // A CLICK IS NOT A POSITIONING ACT (round-3 verifier's MAJOR): a plain
    // pointerdown says the reader is HERE, not that they moved the view, so it
    // stamps input and may end the settle WINDOW — but it keeps the pin
    // snapshot and the re-tail series, or the resume's own input-less
    // displacement reproduces the incident behind the click. A press ON THE
    // SCROLLBAR GUTTER is the exception: it is a drag in progress, and every
    // scroll it produces is positioning (round-4 verifier's MAJORs — the drag
    // is keyed on WHERE the press landed, not on how soon a scroll follows).
    this._messageList.addEventListener('pointerdown', (e) => {
      this._noteUserInput();
      this._pointerDownOnScrollbar = this._pointerOnScrollbar(e);
      this._pointerDownScrollTop = this._messageList.scrollTop;
    }, { passive: true });
    // …and the press ends wherever the pointer is RELEASED — a scrollbar drag
    // routinely leaves the element, so this listens on the window, bound to the
    // window's AbortController like every other document-level listener here
    // (listener-lifecycle law). Views whose winInfo has no controller (subagent
    // viewers) are covered by the removeEventListener in dispose().
    this._endPointerPress = () => { this._pointerDownOnScrollbar = false; };
    const pressSignal = winInfo?._listenerCtl?.signal;
    window.addEventListener('pointerup', this._endPointerPress, { passive: true, signal: pressSignal });
    window.addEventListener('pointercancel', this._endPointerPress, { passive: true, signal: pressSignal });
    // ONE collab-age ticker per ChatView (2026-09-07), owned by the window's
    // AbortController like every other window-scoped listener: a per-message
    // interval over a burst of fifty coalescing rows is fifty timers nobody
    // ever cancels. dispose() clears it too (a view can die while its window
    // lives on — tab swap, view replacement).
    if (pressSignal) pressSignal.addEventListener('abort', () => this._stopCollabTick(), { once: true });
    this._messageList.addEventListener('keydown', (e) => {
      // NAVIGATION keys move the view — everything else is mere input.
      if (NAV_KEYS.includes(e.key)) this._notePositioning('key');
      else this._noteUserInput();
    });
    this._messageList.addEventListener('wheel', (e) => {
      if (this._loading || !this._canPaginate) return;
      const list = this._messageList;
      if (e.deltaY < 0 && list.scrollTop < 10) {
        // A wheel-up that PAGES is also a statement of intent to leave the
        // live tail — unpin explicitly (inc-mspemym2, round 5): under
        // collapsed geometry scrollTop can be 0 while still pinned, and a
        // pinned view that pages up gets yanked straight back to the bottom
        // by the pin machinery on the next live edit — the visible bounce.
        this._pinned = false;
        if (this._teleported) this._maybeSeekEarlier();        // teleported: seek older by line
        else if (this._windowStart > 0) this._extendTop();
        else this._maybeSeekEarlier();                         // registered tail exhausted → seek gap
      } else if (e.deltaY > 0 && list.scrollHeight - list.clientHeight > 50
                 && list.scrollHeight - list.scrollTop - list.clientHeight < 10) {
        // THE BOUNCE (inc-msor3oax, still reproducing on 2.305.0): with a
        // fresh batch's heights unresolved the list has NO scrollable range
        // (sh === ch === 755 in the capture), so "parked at the bottom edge"
        // and "parked at the top edge" are the SAME position — one downward
        // wheel tick (or the momentum tail of the user's UPWARD gesture)
        // fired extendBottom and yanked the window back to the live tail,
        // about once a second for as long as they kept paging up. The 2.301.0
        // guard covered the SCROLL handler, but a collapsed list produces NO
        // scroll events — the wheel handler is the only path that runs, and
        // it was unguarded. Requiring a REAL scrollable range is what makes
        // the bottom edge distinguishable from the top edge at all.
        // BOTTOM edge mirror of the top-edge fix above: parked at max
        // scrollTop, wheel events keep coming but scroll events DON'T — the
        // window-mode branch was missing here, so scrolling back down through
        // history stalled at the rendered window's end and only a jiggle
        // (up+down = one scroll event) advanced it a page at a time (real
        // report: "得不断上翻下翻才会触发往下一点点").
        if (this._teleported) this._maybeSeekLater();          // teleported: seek newer by line
        else if (this._windowEnd < this._total) this._extendBottom();
      }
    }, { passive: true });

    // Scroll detection: pin-to-bottom + auto-load earlier messages (throttled)
    let scrollTick = false;
    this._messageList.addEventListener('scroll', () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        scrollTick = false;
        if (this._suspended) return; // hidden-desktop window: geometry is meaningless, decide nothing
        const { scrollTop, scrollHeight, clientHeight } = this._messageList;
        // floating run bar (2.369.37): same frame, same layout pass, no decisions
        this._updateRunBar(scrollTop);
        if (this._programmaticScroll) return; // don't interfere with programmatic scrolls
        // SCROLLBAR DRAG (round-3 MAJOR, re-keyed in round 4): the one
        // positioning act with no event of its own — a scroll produced while a
        // press on the scrollbar GUTTER is held. Stamped HERE, above the settle
        // return, because the drag must be able to end the very settle it
        // starts inside; a press in the content area never gets here, so the
        // resume's own displacement can no longer masquerade as a drag.
        if (this._pointerDragScroll(scrollTop)) this._notePositioning('scrollbar-drag');
        // RESUME SETTLE (inc-mtq5bpjt-0o0n): a window that was JUST un-hidden
        // is still re-measuring — the capture shows scrollTop transiting
        // 1967→0→1976→3297→1950 in 240ms with zero user input. Decide nothing
        // (not even the pin) off that geometry; the pin state the window had
        // when it was hidden is the truth until it settles — and it closes only
        // AFTER the pinned re-tail runs (it carries that timer's slack), so no
        // displacement can slip between them. A POSITIONING act clears it and
        // the repair with it; a bare click only ends the window (see
        // _notePositioning vs _noteUserInput).
        // It sits BELOW the run-bar readout on purpose (round-2 verifier's
        // minor): the bar is a READOUT of the frame's scrollTop, not a
        // decision, and returning above it froze the 2.369.45 floating bar for
        // the whole settle — a resumed window showed the wrong run label (or
        // kept a stale one) for 1.24s. Everything BELOW here is a decision.
        if (Date.now() < (this._resumeSettleUntil || 0)) return;
        // COLLAPSED-GEOMETRY GUARD (inc-mso818ry, first real catch by the
        // 2.264.0 scroll tracer): while content-visibility leaves a fresh
        // batch unresolved, scrollHeight collapses to ≈clientHeight — "at
        // top" AND "at bottom" become SIMULTANEOUSLY true, so the pin
        // re-engaged at scrollTop 0, extendBottom yanked the window back to
        // the live tail, and paging up bounced the user to the bottom every
        // ~1s for 50 seconds straight (trace: sh 782 on every pathological
        // landing vs 2857+ on healthy ones). With messages outside the
        // window and >10 rendered, that geometry is INDETERMINATE — make NO
        // boundary decision; heights resolve within ~1s and the next scroll
        // event re-evaluates honestly.
        // The indeterminacy is TRANSIENT — it lasts only while content-
        // visibility resolves the batch we just inserted — so the guard is
        // scoped to a settling window after a structural mutation rather than
        // to an absolute pixel threshold. A fixed 200px (2.301.0) was too
        // tight for the field data: the incident's landings measured 782, 923
        // and 997 against a ~600-700px list, so two of the three slipped
        // through; widening the pixel bar instead would make a genuinely
        // SHORT partial window skip decisions forever and paging up would
        // stop working. "Less than one viewport of scrollable range, within
        // 1.5s of a structural change" catches every recorded landing and can
        // never stick.
        const partialWindow = this._windowStart > 0 || this._windowEnd < this._total;
        const settling = Date.now() - (this._lastStructuralAt || 0) < 1500;
        if (partialWindow && settling && scrollHeight - clientHeight < clientHeight
            && this._messageList.childElementCount > 10) {
          this._trace('collapsedGeomSkip', { st: Math.round(scrollTop), sh: scrollHeight, ch: clientHeight });
          return;
        }
        const atBottom = scrollHeight - scrollTop - clientHeight < 50;
        if (atBottom && !this._pinned) {
          this._trace('repin', { st: Math.round(scrollTop), sh: scrollHeight, ch: clientHeight,
            structAge: Date.now() - (this._lastStructuralAt || 0), n: this._messageList.childElementCount,
            fsb: this._fsbActive ? (this._fsbFrames || 0) : -1, posAgo: this._lastPositionAt ? Date.now() - this._lastPositionAt : -1 });
          this._pinned = true;
          this._newMsgCount = 0;
          this._scrollBtn.classList.add('hidden');
        } else if (!atBottom) {
          // POSITIVE-EVIDENCE UNPIN GATE (round-2 verifier's minor): the
          // settle window was a one-shot CLIFF — the resume's re-measure keeps
          // moving scrollTop after it expires, and an input-less displacement
          // at resume+1400ms unpinned a pinned window and stranded it in
          // history (3/3 sessions). So the UNPIN obeys the same law as every
          // paging trigger: within the resume horizon, with the pin snapshot
          // still saying "this window was at the live tail" and no scroll or
          // navigation since the resume, an atBottom→false transition is
          // DISPLACEMENT, not intent — keep the pin and re-assert the bottom.
          // A real wheel/touch/nav-key/drag or any nav clears the snapshot,
          // so a reader who scrolls away at +1400ms unpins and pages normally
          // — but a mere CLICK does not (round-3 MAJOR: it left the resume's
          // own displacement free to strand the window behind the click).
          if (this._pinned && this._resumeDisplacement()) {
            this._trace('unpinSkipResume', { st: Math.round(scrollTop), sinceResume: Date.now() - (this._resumeAt || 0) });
            this._scrollToBottom();
            return;
          }
          if (this._pinned) this._trace('unpin', { st: Math.round(scrollTop), wheelAgo: this._lastUserScrollAt ? Date.now() - this._lastUserScrollAt : -1 });
          this._pinned = false;
          this._scrollBtn.classList.remove('hidden');
        }
        // INTENT GATE (inc-msorcsrl, the third capture — this is the real
        // mechanism): after paging UP, the fresh batch's heights resolve and
        // native scroll anchoring raises scrollTop to keep the view stable
        // (captured: 85 → 1466 in 26ms, which no wheel can produce). The
        // "near the end ⇒ extendBottom" rule read that as the user scrolling
        // down, trimmed the top, walked the window back toward the live tail
        // — and the user, still scrolling up, saw the page jump back. A
        // boundary EXTENSION must therefore agree with the user's actual
        // wheel direction; content-growth displacement has no direction.
        const dirAge = Date.now() - (this._wheelDirAt || 0);
        const goingUp = this._wheelDir < 0 && dirAge < 1200;
        const goingDown = this._wheelDir > 0 && dirAge < 1200;
        // DIRECTION LOCKOUT (2.308.0): the wheel gate above needs a recent
        // wheel event, so it does nothing for touch / scrollbar-drag /
        // keyboard readers, or when the reader pauses while a batch settles.
        // A mutation-induced displacement can never be evidence for the
        // OPPOSITE direction, whatever the input device — so for a moment
        // after each structural change, only the trigger that CONTINUES that
        // direction may fire. Short enough that a genuine reversal is never
        // held up (the reader cannot cross a viewport in 600ms).
        const structAge = Date.now() - (this._lastStructuralAt || 0);
        const lockUp = structAge < 600 && this._lastStructuralDir === 'down';
        const lockDown = structAge < 600 && this._lastStructuralDir === 'up';
        // PIN GATE (inc-mspemym2, round 5 — the first bounce's whole cascade):
        // a PINNED view is at the live tail by definition; the user is not
        // reading history, so the scroll handler must never page it upward.
        // The capture: content-visibility height resolution drifted scrollTop
        // 92→0 over 400ms with NO user input while pin stayed 1, the st<100
        // branch then walked the window up 4 slabs (200 messages), and the
        // pin machinery yanked 0→2141→0 against the pager's anchor restore —
        // the visible bounce. Real upward intent always arrives as a wheel-up,
        // which unpins first (wheel branch above + the atBottom update).
        // POSITIVE-EVIDENCE GATE for extendTop too (2.338.0, Windows freeze
        // audit): typing grows the input box, the scroller's clientHeight
        // shrinks, content-visibility re-resolution + scroll anchoring drift
        // scrollTop toward 0 with ZERO user input, and this branch paged 50
        // messages per bounce until history ran out — the round-5 disease
        // through the door the round-5 gates didn't cover. Same rule as
        // extendBottom below: recent REAL user input required; typing stamps
        // __vsInputResizeAt (chat-input autosize) and that never qualifies.
        const userRecentUp = this._lastUserScrollAt && (Date.now() - this._lastUserScrollAt < 1500);
        const inputResizing = (window.__vsInputResizeAt && (Date.now() - window.__vsInputResizeAt < 250))
          || (window.__vsViewportResizeAt && (Date.now() - window.__vsViewportResizeAt < 400)); // browser-window drag-resize = the same displacement, third door (2.339.1)
        if (!this._pinned && scrollTop < 100 && !this._loading && this._canPaginate && !goingDown && !lockUp
            && userRecentUp && !inputResizing) {
          if (this._teleported) this._maybeSeekEarlier();       // teleported: seek older by line
          else if (this._windowStart > 0) this._extendTop();
          else this._maybeSeekEarlier();                        // registered tail exhausted → seek gap
        }
        // Extend bottom when scrolling near end of rendered window. Teleport
        // mode seeks NEWER slabs by file line instead, so browsing continues
        // downward from a jump just like it does upward.
        // POSITIVE-EVIDENCE GATE (inc-mspemym2, the second bounce): while the
        // user is READING HISTORY (unpinned, partial window), extendBottom is
        // the destructive direction — its trimTop yanks the view toward the
        // live tail. The time-boxed gates above all EXPIRED in the capture
        // (cv height resolution outlasted the 1200ms wheel window and the
        // 600ms lockout; anchoring then pushed scrollTop into the "near the
        // end" band 2.5s after the last real wheel and extendBottom fired
        // with zero user input). Displacement is not intent (2.307.0) — so
        // this branch now requires RECENT USER INPUT (wheel/touch/pointer/
        // key, 1.5s), not merely the absence of contrary evidence. A real
        // downward reader produces a continuous input stream and never
        // notices; settling geometry produces none and can no longer fire it.
        const userRecent = userRecentUp;
        const reading = !this._pinned && this._windowEnd < this._total;
        if (scrollHeight - scrollTop - clientHeight < 300 && !this._loading && this._canPaginate
            && !goingUp && !lockDown && (!reading || userRecent) && !inputResizing) {
          if (this._teleported) this._maybeSeekLater();
          else if (this._windowEnd < this._total) this._extendBottom();
        }
        this._updatePosIndicator();
        this._chatMinimap.setViewport(this._windowStart, this._windowEnd, this._total);
        if (this._gapMinimapActive) this._reportVisibleTsRange();
      });
    }, { passive: true });

    // Read-only viewers: status displays but no input
    if (this._readOnly) {
      container.classList.add('chat-no-content-visibility');

      // Minimal TODO + streaming status (no full ChatInput)
      this._todoDisplay = document.createElement('div');
      this._todoDisplay.className = 'chat-todo-display hidden';
      this._streamStatus = document.createElement('div');
      this._streamStatus.className = 'chat-stream-status hidden';

      const statusArea = document.createElement('div');
      statusArea.className = 'chat-input-area';
      statusArea.style.padding = '4px 16px';
      statusArea.append(this._todoDisplay, this._streamStatus);
      container.append(statusArea, this._statusBar.element);
      container.tabIndex = -1;
      winInfo.content.appendChild(container);

      this._messageList.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG' && e.target.classList.contains('chat-img')) {
          showImageOverlay(e.target.src); // property-assignment inside (XSS note in utils)
        }
        if (e.target.classList.contains('chat-agent-view-btn')) {
          e.stopPropagation();
          this._openSubagentViewer({
            threadId: e.target.dataset.threadId,
            agentId: e.target.dataset.agentId,
            parentToolUseId: e.target.dataset.parentToolId,
            description: e.target.dataset.desc,
          });
        }
      });
      this._handler = (msg) => {
        if (msg.type === 'msg' && msg.sessionId === sessionId) {
          this._onOp(msg);
        }
      };
      this.ws.onGlobal(this._handler);
      this._stateHandler = () => {};
      this._startReadOnlyPolling();
      // Show Resume button for view-only history (skip subagent viewers)
      this._showResumeBar();
      return;
    }

    // Chat input area
    this._chatInput = new ChatInput(wsManager, sessionId, {
      onSend: () => {
        if (this._windowEnd < this._total) {
          this.jumpToBottom();
        } else {
          this._pinned = true;
          this._newMsgCount = 0;
          this._scrollBtn.classList.add('hidden');
          this._scrollToBottom();
        }
      },
      onInterrupt: () => this.ws.send({ type: 'interrupt', sessionId: this.sessionId }),
      getCwd: () => this._getSessionIds().cwd,
      getHost: () => this._getSessionIds().host || null,
      getUploadDir: () => (this.app?.settings?.get('chat.uploadDir') || '').trim(),
      // Touch devices: soft keyboards have no Shift+Enter — the enter key is
      // the ONLY way to type a newline, so it must insert one, not send
      // (2.234.0, real report). Send = the button. chat.touchEnterSends
      // restores enter-to-send for those who prefer it.
      isTouch: () => !!this.app?.isTouch,
      getTouchEnterSends: () => !!this.app?.settings?.get('chat.touchEnterSends'),
      onQueueOp: (op, id, extra) => this._sendQueueOp(op, id, extra),
      // Alt+Enter in the composer runs the SAME contributed command the
      // registered keybinding does (owner: one verb, rebindable by plugins).
      onSteerChord: () => runCommand(STEER_NOW_COMMAND, { view: this }),
      onSteerSend: (msgId) => this._steerAfterSend(msgId),
    });
    this._chatInput.popupContainer = container;

    // THE CHORD'S KEYBINDING. Per view (its `when` scopes it to this window,
    // and the binding leaves with the view), bound to the window's
    // AbortController AND disposed explicitly — a view can be replaced while
    // its window lives on. Registering the same chord from several open chat
    // windows is legal precisely because each carries a `when`.
    this._steerKeyDispose = registerKeybinding({
      key: 'alt+enter',
      command: STEER_NOW_COMMAND,
      when: (ctx) => steerTargetView(ctx) === this && this._canSteerComposer(),
      signal: winInfo?._listenerCtl?.signal,
    });
    this._setupChatDrop(container);

    // Search (extracted to ChatSearch)
    this._search = new ChatSearch(this._messageList, {
      getSessionIds: () => this._getSessionIds(),
      getSessionId: () => this.sessionId,
      jumpToIndex: (idx) => this.jumpToIndex(idx),
      getWindowBounds: () => ({ windowStart: this._windowStart, windowEnd: this._windowEnd }),
      // Huge (elided) sessions: search the WHOLE file in {line, ts} coordinates
      getGapActive: () => !!this._gapMinimapActive,
      jumpToFileMatch: (m) => this.jumpToFileMatch(m),
      // a REVEAL positions the viewport without any event the message list can
      // see — it must end the resume settle like a wheel does
      onNav: () => this._noteUserNav('search-reveal'),
    });
    container.insertBefore(this._search.element, this._messageList);

    // Ctrl+F to search
    container.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        this._search.open();
      }
    });
    container.tabIndex = -1;
    winInfo.content.appendChild(container);

    container.appendChild(this._chatInput.element);
    container.appendChild(this._statusBar.element);

    // Clear waiting blink on focus/click
    winInfo.element.addEventListener('mousedown', () => this._clearWaiting());

    // Image zoom + Agent View Log click handler
    this._messageList.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG' && e.target.classList.contains('chat-img')) {
        showImageOverlay(e.target.src); // property-assignment inside (XSS note in utils)
      }
      // Agent View Log button
      if (e.target.classList.contains('chat-agent-view-btn')) {
        e.stopPropagation();
        this._openSubagentViewer({
          threadId: e.target.dataset.threadId,
          agentId: e.target.dataset.agentId,
          parentToolUseId: e.target.dataset.parentToolId,
          description: e.target.dataset.desc,
        });
      }
      // Codex collab row / sub-agent report: the agent NAME opens the child's
      // rollout read-only (B-7473). Also reachable from a fold header, whose
      // own click toggles the run — stop there.
      const collabName = e.target.closest?.('.chat-collab-name');
      if (collabName) {
        e.stopPropagation();
        this._openCollabAgent({
          agentPath: collabName.dataset.agentPath || '',
          threadId: collabName.dataset.threadId || '',
        });
        return;
      }
      // View Workflow button (dynamic-workflow post-hoc detail)
      if (e.target.classList.contains('chat-workflow-view-btn')) {
        e.stopPropagation();
        const { claudeId, cwd, host } = this._getSessionIds();
        this.app.openWorkflowDetail(e.target.dataset.wfRun, {
          name: e.target.dataset.wfName,
          claudeSessionId: claudeId,
          cwd,
          host, // remote session ⇒ the run's artifacts live on the host (2.191.0)
        });
      }
    });

    // ── DELIVERY-STALL WATCHDOG (2.322.0, inc-msp3klen: a COMPLETE reply
    // reached this client 14.5min late on a live connection — heartbeat green
    // both ways, tab foreground, server parse proven on time by telemetry;
    // the last-mile seam is still at large, so this self-heals EVERY flavor:
    // if the UI believes the model is responding but NOTHING for this session
    // has arrived in 120s (long tool runs emit tool_progress heartbeats, so
    // true silence at 120s is abnormal), force a re-attach — idempotent, and
    // the server replies with current history + streaming state, which both
    // repairs a lost clients-map registration and re-syncs a wedged view.
    // Telemetry fingerprint `chat-stall-reattach` records each firing with
    // the silence length — the instrument that convicts the real seam on the
    // next occurrence. Fires at most once per 5min per view.
    // SLEEP COUNTDOWN (2.369.58): a live `clock.sleep` card renders its own
    // deadline into `data-sleep-until`; ONE interval per view rewrites the text
    // so a 20-minute wait visibly counts down instead of sitting behind a
    // spinner. It touches nothing when no such card exists (the usual case),
    // and a COMPLETED sleep card has no such element at all — the row freezes
    // by construction, not by clearing a timer.
    this._sleepTicker = setInterval(() => {
      try {
        const els = this._container?.querySelectorAll?.('.chat-sleep-remaining[data-sleep-until]');
        if (!els || !els.length) return;
        const now = Date.now();
        for (const el of els) el.textContent = formatSleepRemaining((Number(el.dataset.sleepUntil) || 0) - now);
      } catch { }
    }, 1000);

    this._stallWatch = setInterval(() => {
      try {
        if (this._readOnly || !this._typingSince) return;
        const silence = Date.now() - Math.max(this._lastInboundAt || 0, this._typingSince);
        if (silence < 120000) return;
        if (Date.now() - (this._stallReattachAt || 0) < 300000) return;
        this._stallReattachAt = Date.now();
        try { window.__vsEvent?.('chat-stall-reattach', { detail: `${Math.round(silence / 1000)}s sid=${String(sessionId).slice(0, 24)}` }); } catch { }
        console.warn(`[chat] delivery stall: streaming ${Math.round(silence / 1000)}s with zero inbound — forcing re-attach`);
        this._reattach();
      } catch { }
    }, 15000);

    // Listen for normalized message ops from server
    this._handler = (msg) => {
      // Delivery-stall watchdog input (2.322.0, inc-msp3klen): any inbound
      // for THIS session is proof of delivery liveness.
      if (msg.sessionId === sessionId) this._lastInboundAt = Date.now();
      if (msg.type === 'msg' && msg.sessionId === sessionId) {
        // Any live op for this session proves the socket that carried the last
        // send was alive server-side — finalize the deferred draft clear
        // (chat-input dead-ws-window loss defense).
        this._chatInput?.confirmDelivery?.();
        this._onOp(msg);
      } else if (msg.type === 'streaming-label' && msg.sessionId === sessionId) {
        this._onServerStreamLabel(msg.label, msg.kind || null);
      } else if (msg.type === 'auto-resume' && msg.sessionId === sessionId) {
        this._statusBar?.setAutoResume?.(msg.status || null);
      } else if (msg.type === 'response-style-updated' && msg.sessionId === sessionId) {
        // LIVE style switch CONFIRMED by the server (2.369.58). The chip only
        // moves on this echo — a refused switch answers `{type:'error',
        // code:'style-not-live'}` instead and the bar keeps the truth.
        // The SUCCESS TOAST lives here too (2.369.58): firing it at click time
        // announced a switch the server was about to refuse.
        this._statusBar?.setOutputStyle?.(msg.outputStyle || '');
        this._statusBar?.setOutputStylePending?.(undefined);
        this._statusBar?.setResponseStyleLive?.(true);
        if (msg.live) showToast(msg.outputStyle
          ? t('Response style \u201c{v}\u201d applies from the next turn', { v: msg.outputStyle })
          : t('Response style cleared \u2014 the agent\u2019s own config applies again'));
      } else if (msg.type === 'page-published' && msg.sessionId === sessionId) {
        // ONE notify point server-side (dialog + agent publishes): the status
        // bar's design chip is the live list; the agent's reply carries the link
        this._statusBar?.notePagePublished?.(msg.page);
        showToast(t('Page published: {name}', { name: msg.page?.name || '' }));
      } else if (msg.type === 'goal-updated' && msg.sessionId === sessionId) {
        // The server ALWAYS answers a set-goal with this broadcast (status /
        // resume / set / clear alike), so it is the one honest confirmation
        // that the /goal the user typed actually landed.
        this._chatInput?.confirmGoal?.();
        this._onGoalUpdated(msg.goal, msg.goalElapsed);
        if (msg.goalStatus) this._statusBar.setGoalStatus(msg.goalStatus);
        if (msg.statusMsg) this._renderers.appendSystem(msg.statusMsg);
      } else if (msg.type === 'remote-state' && msg.sessionId === sessionId) {
        // remote transport: ssh pipe reconnecting to the host-side keeper
        this._statusBar?.setRemoteState(msg);
      } else if (msg.type === 'permission-mode-ack' && msg.sessionId === sessionId) {
        this._onPermissionModeAck(msg);
      } else if (msg.type === 'subagent-message' && msg.sessionId === sessionId) {
        this._onSubagentMessage(msg.parentToolUseId, msg.message);
      } else if (msg.type === 'tool-progress' && msg.sessionId === sessionId) {
        this._onToolProgress(msg);
      } else if (msg.type === 'turn-state' && msg.sessionId === sessionId) {
        // The harness's OWN turn state (§2.5). Arrives only from a harness that
        // publishes one; a session that never does simply never sends this and
        // the status bar's third state stays unclaimed.
        this._statusBar?.setTurnState?.(msg.state || null);
      } else if (msg.type === 'tools-in-progress' && msg.sessionId === sessionId) {
        this._onToolsInProgress(msg.ids || []);
      } else if (msg.type === 'compact-progress' && msg.sessionId === sessionId) {
        // A REAL progress lane exists for this session — the guidance card's
        // hardcoded "takes 1–2 minutes" apology becomes the fallback and the
        // stage takes its place (§2.11). The spinner label itself rides the
        // normal streaming-label broadcast.
        this._onCompactProgress(msg);
      } else if (msg.type === 'exited' && msg.sessionId === sessionId) {
        this._hideTyping();
        if (msg.reason === 'not_logged_in') {
          this._renderers.appendSystem(t('Not logged in — please log in to continue.'));
          this._setReadOnly();
          this._showLoginBar();
        } else {
          // Classified death detail (2.226.0): show WHY it died — "Session
          // ended." alone on a canned CLI error read as a silent failure.
          this._renderers.appendSystem(msg.detail ? `${t('Session ended.')} — ${msg.detail}` : t('Session ended.'));
          this._setReadOnly();
        }
      } else if (msg.type === 'attach-ack' && msg.sessionId === sessionId) {
        this._lastAttachAckAt = Date.now(); // proof-of-life: server got our attach and is processing
      } else if (msg.type === 'attached' && msg.sessionId === sessionId) {
        // Track the server normalizer epoch from EVERY attach path (create,
        // attach, reattach) — _reattach compares against it to detect a
        // server restart (ID-space reset).
        this._lastAttachedAt = Date.now(); // clears the _reattach no-reply fallback
        if (msg.normEpoch) this._normEpoch = msg.normEpoch;
        if (msg.remoteState) this._statusBar?.setRemoteState(msg.remoteState);
      } else if (msg.type === 'error' && msg.sessionId === sessionId) {
        this._onSessionError(msg);
      }
    };
    this.ws.onGlobal(this._handler);

    // Connection state: freeze on disconnect, re-attach + sync on reconnect
    this._disconnected = false;
    this._hasConnected = false; // track first connect vs reconnect
    this._stateHandler = (connected) => {
      this._disconnected = !connected;
      container.classList.toggle('chat-disconnected', !connected);
      if (this._chatInput) this._chatInput.setDisconnected(!connected);
      if (!connected) {
        this._hideTyping();
        this._renderers.appendSystem(t('Disconnected from server'));
      } else if (this._hasConnected) {
        this._renderers.appendSystem(t('Reconnected'));
        this._reattach(true);
      }
      this._hasConnected = true;
    };
    this.ws.onStateChange(this._stateHandler);
  }

  // Compact NON-CONTENT debug context for telemetry — ids/flags/counts only,
  // never message text. Powers the blank-window / attach-failure events so a bug
  // report ("窗口空白") comes with enough to reproduce: which backend/mode, local
  // vs remote host, read-only, streaming, window bounds, and the session id.
  _telemDetail(extra) {
    try {
      const { backend, backendSessionId, cwd, host } = this._getSessionIds() || {};
      const bits = [
        extra,
        backend && `be=${backend}`,
        this._readOnly ? 'ro=1' : null,
        host ? `remote=1 host=${String(host).slice(0, 24)}` : 'remote=0',
        this._disconnected ? 'ws=off' : null,
        (backendSessionId ? `sid=${String(backendSessionId).slice(0, 12)}` : null),
        `win=${this._windowStart}-${this._windowEnd}`,
      ].filter(Boolean);
      return bits.join(' ').slice(0, 300);
    } catch { return String(extra || '').slice(0, 120); }
  }

  // ── View Manager: sliding window over server message list ──

  // Load initial messages from attach response
  // Load normalized messages from attach response
  loadHistory(messages, totalCount, isStreaming, meta) {
    const _t0 = performance.now();
    // RECONNECT NO-OP (inc-mtd2pg6x "刚刚又卡死了", 2.369.2): a ws reconnect
    // re-attaches EVERY session and each attach used to rebuild its window's
    // whole DOM — N windows × hundreds of messages synchronously = a multi-
    // second freeze with zero content change (the capture shows the stall
    // co-timed with state-resync). When the slab is IDENTICAL to what is
    // already rendered (same epoch, same total, same tail ids, tail-anchored
    // window, not teleported), apply the meta/status and skip the rebuild.
    try {
      const sameEpoch = !meta?.normEpoch || meta.normEpoch === this._normEpoch;
      const lastCur = this._messages?.[this._messages.length - 1];
      const lastNew = messages?.[messages.length - 1];
      if (sameEpoch && !this._teleported && this._messages?.length && messages?.length
          && this._total === (totalCount || messages.length)
          && this._windowEnd === this._total
          && this._windowStart === this._total - messages.length
          && lastCur && lastNew && lastCur.id === lastNew.id
          && this._messages[0]?.id === messages[0]?.id) {
        this._trace('loadHistory:identical-skip', { n: messages.length });
        if (meta) {
          if (meta.chatStatus) this.applyStatus(meta.chatStatus);
          if (meta.taskState) this._applyTaskState(meta.taskState);
          if (meta.goal != null) { this._onGoalUpdated(meta.goal, meta.goalElapsed); if (meta.goalStatus) this._statusBar.setGoalStatus(meta.goalStatus); }
          this._applyLiveMeta?.(meta);
        }
        if (isStreaming) this._onServerStreamLabel(meta?.streamingLabel || t('thinking...'), meta?.streamingKind || null);
        else this._hideTyping?.();
        return;
      }
    } catch { }
    if (meta?.normEpoch) this._normEpoch = meta.normEpoch;
    this._total = totalCount || messages.length;
    this._windowStart = this._total - messages.length;
    this._windowEnd = this._total;
    this._loading = false;

    this._loadingHistory = true;
    for (const msg of messages) this._onCreateMessage(msg);
    this._loadingHistory = false;

    // Apply metadata (chatStatus, taskState, pendingPermissions)
    if (meta) {
      if (meta.chatStatus) this.applyStatus(meta.chatStatus);
      if (meta.taskState) this._applyTaskState(meta.taskState);
      if (meta.goal != null) { this._onGoalUpdated(meta.goal, meta.goalElapsed); if (meta.goalStatus) this._statusBar.setGoalStatus(meta.goalStatus); }
      // Restore pending permission overlays from server (survived in buffer).
      // Usually redundant — MessageManager attaches `permission` onto the
      // normalized tool message — but covers control_requests the normalizer
      // didn't see (e.g. buffered before a server restart).
      if (meta.pendingPermissions) {
        for (const [toolUseId, cr] of Object.entries(meta.pendingPermissions)) {
          // Find the message with this tool call and inject the permission
          for (const [id, el] of this._elements) {
            if (el.dataset?.toolId === toolUseId || el.querySelector(`[data-tool-id="${toolUseId}"]`)) {
              const msg = this._messages.find(m => m.id === id);
              // Skip completed/errored tools — a tool_result means the
              // permission was answered; injecting an unresolved overlay
              // here resurrects an already-answered prompt (defense against
              // a stale server-side pending list).
              if (msg && !msg.permission && msg.status !== 'complete' && msg.status !== 'error') {
                msg.permission = { requestId: cr.request_id, toolName: cr.request?.tool_name, input: cr.request?.input || {}, suggestions: cr.request?.permission_suggestions || [], resolved: null };
                this._renderers.renderPermissionOverlay(el, msg);
              }
              break;
            }
          }
        }
      }
    }
    this._syncReviewAvailability();
    // Set viewport BEFORE rendering markers — render() positions markers
    // against _total, which is stale (0) until setViewport runs, stretching
    // first-render markers toward 100%
    this._chatMinimap.setViewport(this._windowStart, this._windowEnd, this._total);
    // Render minimap from turn data (attach payload or async fetch fallback)
    if (meta?.turnMap?.length) {
      this._chatMinimap.render(meta.turnMap);
    } else if (this._total > 50 && this._canPaginate) {
      // Fallback: fetch turn map via API. _canPaginate excludes sub- viewers:
      // _getSessionIds() falls back to the PARENT's identity there (the
      // openSpec carries it for the disk lookup), so this fetch would render
      // the PARENT conversation's turn markers into the agent's minimap.
      const { backend, backendSessionId, cwd, host } = this._getSessionIds();
      if (backendSessionId) {
        fetch(`/api/session-messages?backend=${encodeURIComponent(backend)}&backendSessionId=${encodeURIComponent(backendSessionId)}&cwd=${encodeURIComponent(cwd)}&turnmap=1${host ? `&host=${encodeURIComponent(host)}` : ''}`)
          .then(r => r.json()).then(d => { if (d.turns?.length) this._chatMinimap.render(d.turns); }).catch(() => {});
      }
    }
    // Huge (elided) session? Switch the minimap to whole-conversation view up
    // front, so the scrollbar reflects the full timeline without waiting for
    // the user to scroll up to the seam marker. (info probe is free for normal
    // sessions — jsonlGapInfo returns null without building an index.)
    if (this._total > 50 && this._canPaginate) this._initGapMinimap();

    this._applyLiveMeta(meta);
    if (isStreaming) this._onServerStreamLabel(meta?.streamingLabel || t('thinking...'), meta?.streamingKind || null);
    this._scrollToBottom();
    metric('history-render-ms', performance.now() - _t0);
    if (this._chatInput) this._loadPages(); // design chip count/list (live windows only)
    // ── Blank-window telemetry (user-reported "session窗口空白" class) ──
    // The server said this session has messages but NOTHING rendered — the exact
    // symptom that's un-debuggable from a bug report alone. Emit names/ids only.
    try {
      if (this._total > 0 && this._elements.size === 0) track('event', 'chat-view-blank-with-content', this._telemDetail(`total=${this._total} rendered=0`));
      // Deferred DOM check: catch a view that ends up visually empty ~2.5s later
      // (silent render failure, cold remote cache) despite claimed content.
      clearTimeout(this._blankProbe);
      this._blankProbe = setTimeout(() => {
        if (this._disconnected || this._disposed) return;
        const domCount = this._messageList?.querySelectorAll('.chat-msg').length || 0;
        if (this._total > 0 && domCount === 0) track('event', 'chat-view-blank-persistent', this._telemDetail(`total=${this._total} dom=0`));
      }, 2500);
    } catch {}
    this._scheduleAttachFill();
  }

  // ── SHORT-VIEW RESCUE after attach ────────────────────────────────────────
  // Content that doesn't fill the viewport has NO scrollable range, so the
  // scroll handler can never fire; on touch there is no wheel-up path either,
  // so the window is a dead end with history it can't reach. The real case is
  // fold-dominated (inc-mtajy6wr class): the attach slab's 50 cards collapse
  // into a couple of run headers, far shorter than one viewport.
  // inc-mtox23xw (2.369.36): 100ms after a re-attach REBUILD the fresh batch's
  // content-visibility heights are still unresolved, so sh<=ch held for a TALL
  // window and this fired an ungated _extendTop on a PINNED view — the slab
  // landed 7s later (stalled server), trimBottom dropped the live tail and the
  // view unpinned 1500px up ("content jumped after I sent a message"). That fix
  // added `rendered < 30`, which is UNSATISFIABLE: every attach path ships
  // tail(50) (ws-handler + transcripts.page), `_windowStart > 0` holds EXACTLY
  // when those 50 arrived, and folding HIDES members (`.chat-run-collapsed`,
  // display:none) without removing them — so `rendered` is ~50 whenever the
  // gate is armed (measured over 33 real production transcripts: 50/50 render,
  // min 50). The rescue has been dead code since.
  // RE-DERIVED from the intent: the indeterminate geometry is TRANSIENT (the
  // collapsedGeomSkip guard's own premise — it resolves inside ~1.5s), so
  // CORROBORATE the reading instead of guessing a card count: measure twice
  // across the settle window and require the same verdict with no structural
  // change in between. The card count survives only as the harm bound — the
  // rescue adds ONE page and never at a size where a trim could fire (the
  // incident's actual damage was trimBottom eating the live tail).
  _shortViewNeedsFill(list) {
    if (!list || this._suspended || this._disposed) return false;
    if (this._teleported) return false;        // teleport pages by file line — _maybeSeekEarlier owns that mode
    if (!(this._windowStart > 0)) return false; // nothing above this window
    const rendered = list.querySelectorAll(':scope > .chat-msg').length;
    if (rendered + 50 > 150) return false;      // one more page must stay under the trim cap
    return list.scrollHeight <= list.clientHeight; // no scrollable range at all
  }

  // A desktop RESUME is the same class of artifact (inc-mtq5bpjt-0o0n): the
  // subtree re-measures for ~1s after content-visibility clears, so the whole
  // two-reading schedule DEFERS past the resume settle (bounded re-arms)
  // instead of spending a reading — or an _extendTop — on transitional
  // geometry. Real user input clears the settle, so a reader is never delayed.
  _scheduleAttachFill() {
    clearTimeout(this._autoFillT1); clearTimeout(this._autoFillT2);
    const tryAutoFill = (retries) => {
      if (this._suspended || this._disposed) return; // hidden window: sh<=ch is an artifact, not "doesn't fill"
      const wait = (this._resumeSettleUntil || 0) - Date.now();
      if (wait > 0) { if (retries > 0) this._autoFillT1 = setTimeout(() => tryAutoFill(retries - 1), wait + 50); return; }
      if (!this._shortViewNeedsFill(this._messageList)) return;
      const structAt = this._lastStructuralAt || 0;
      this._autoFillT2 = setTimeout(() => {
        // the list changed under us (paging/trim/desktop resume) — those paths decide
        if ((this._lastStructuralAt || 0) !== structAt) return;
        if (Date.now() < (this._resumeSettleUntil || 0)) return; // a resume armed mid-schedule: the resume path owns the tail
        const list = this._messageList;
        if (!this._shortViewNeedsFill(list)) return; // the first reading was transient collapsed geometry
        this._trace?.('autoFill', { rendered: list.querySelectorAll(':scope > .chat-msg').length, sh: list.scrollHeight, ch: list.clientHeight });
        this._extendTop();
      }, 900);
    };
    this._autoFillT1 = setTimeout(() => tryAutoFill(2), 700);
  }

  // ── THE INPUT QUEUE (messages sent DURING a turn) ────────────────────────
  /** What the user may actually DO with this session's queue. TWO gates, both
   *  required (the ws layer applies the same pair):
   *    ① the HARNESS row — backend-caps `inputModes`, projected onto the client
   *      through BACKEND_META (never a backend-id branch);
   *    ② the RUNNING WRAPPER — `_queueSupported`, which arrives on the attach
   *      payload (sidecar caps.inputQueue) and from the wrapper's own baseline
   *      `queue_changed`. A codex session spawned before the queue/steer
   *      release satisfies ① and NOT ② — offering it controls would leave a
   *      chip that never clears and a button whose frame is dropped silently
   *      (the 2.361.1/2.364.1 skew class). */
  _queueCaps() {
    if (!this._queueSupported) return NO_QUEUE_CAPS;
    const backend = this._backendId();
    const row = getBackendMeta(backend)?.caps?.inputModes;
    if (!row) return NO_QUEUE_CAPS;
    // ③ …AND the verb table of the RUNNING wrapper: the harness may know
    // 'reorder' while THIS process is an older build that would drop the
    // frame. The intersection is what the user sees, and the derived
    // steer/queueOps view is recomputed FROM it — never carried over from the
    // harness row, or a control could survive its own gate.
    const served = this._queueVerbsServed;
    const verbs = (row.queueVerbs || []).filter((v) => !served || served.includes(v));
    return { queue: !!row.queue, steer: verbs.includes('steer'), queueOps: verbs.length > 0, queueVerbs: verbs };
  }

  /** This view's harness id — the ONE resolution order (live session record,
   *  then the window's own spec, then the default). Surfaces that need a
   *  harness FACT look it up through BACKEND_META with this, never by
   *  comparing ids themselves. */
  _backendId() {
    return this._getSessionIds()?.backend || this.winInfo?.backend || 'claude';
  }

  _setQueue(items) {
    this._queue = Array.isArray(items) ? items : [];
    this._chatInput?.setQueue(this._queue, this._queueCaps());
    // A queue update is the ONLY event that can tell us the id of a message
    // the chord just sent (see _steerAfterSend).
    this._drainPendingSteers();
  }

  // ── THE Alt+Enter CHORD, VIEW SIDE ──────────────────────────────────────
  /** Can the composer steer right now? ONE definition, shared by the command's
   *  `when`, the keybinding's `when` and both composer surfaces — it asks the
   *  ChatInput, which asks the PURE `composerSendModes` over the SAME
   *  `_queueCaps()` intersection the strip's Steer buttons use. */
  _canSteerComposer() { return !!this._chatInput?.steerChordAllowed; }

  /** Run the chord. @returns {boolean} whether a message went out. */
  steerComposerText() { return !!this._chatInput?.steerNow(); }

  /** THE CHORD'S SECOND HALF. A steer NAMES A QUEUED ITEM — codex's
   *  `turn/steer` takes the app-server's queued-submission id and there is no
   *  "send this text as a steer" verb anywhere in the protocol — so the chord
   *  sends on the ordinary path and we convert the item the harness reports
   *  back, with the SAME 'queue-op' frame the strip button and the bubble chip
   *  send. Bounded: if the item never appears we SAY so rather than leave the
   *  user believing an injection happened (no-silent-failures) — unless the
   *  turn we sent into ended meanwhile, which needs no apology (the message
   *  runs next, immediately, which is what "now" asked for).
   *
   *  ROUND-2 VERIFIER'S MAJOR — WHICH turn, not "a turn". The silence guard
   *  used to test `this._typingSince` for TRUTHINESS, and that flag is
   *  RE-ARMED by the next turn. The only way this timer survives to fire is
   *  that the msgId never appeared in the published queue — which is exactly
   *  what happens when the wrapper was NOT busy and ran the message as its
   *  own `turn/start` (it only `thread/queue/add`s while a turn is active).
   *  That new turn re-arms the flag, so the truthiness guard was FALSE
   *  precisely in the case it existed for and the window apologised for a
   *  message the agent was visibly running (the 恒假守卫 class, mirrored).
   *  So capture the turn's IDENTITY at arm time and COMPARE. */
  _steerAfterSend(msgId) {
    const id = String(msgId || '');
    if (!id || !this._queueCaps().steer || this._disposed) return;
    if (this._pendingSteers.has(id)) return;
    const turnAtSend = this._turnEpoch || 0;   // the turn this message was sent INTO
    this._pendingSteers.set(id, setTimeout(() => {
      this._pendingSteers.delete(id);
      if (this._disposed) return;
      if (!this._typingSince) return;                     // nothing is running: it runs next
      if ((this._turnEpoch || 0) !== turnAtSend) return;   // a DIFFERENT turn is running — ours ended, so the message ran or IS running
      this._renderers?.appendSystem?.(t('Sent — but it could not be injected into the running turn; it will run when the turn ends.'));
    }, ChatView.STEER_CHORD_WAIT_MS));
    // A queue_changed can land BEFORE the send resolves here — check now too.
    this._drainPendingSteers();
  }

  /** How long the chord waits for its message to show up in the harness's
   *  published queue before it admits the injection did not happen. Sized
   *  above a round-trip through the wrapper's `thread/queue/list` republish. */
  static get STEER_CHORD_WAIT_MS() { return 8000; }

  _drainPendingSteers() {
    if (!this._pendingSteers?.size) return;
    for (const it of this._queue || []) {
      const mid = String(it?.msgId || '');
      if (!mid || !this._pendingSteers.has(mid)) continue;
      clearTimeout(this._pendingSteers.get(mid));
      this._pendingSteers.delete(mid);
      this._sendQueueOp('steer', it.id);
    }
  }

  _clearPendingSteers() {
    if (!this._pendingSteers) return;
    for (const timer of this._pendingSteers.values()) clearTimeout(timer);
    this._pendingSteers.clear();
  }

  /** THE ONE WRITER of `_queueSupported` — and the reason it exists: the
   *  capability arrives AFTER the bubbles are on screen. loadHistory renders
   *  every message first and calls `_applyLiveMeta` (which carries the attach
   *  payload's `queueSupported`) at the END, and live sessions get the
   *  wrapper's baseline `queue_changed` some frames after the first bubbles.
   *  A chip rendered in between was built with `onSteer = null` ⇒ permanently
   *  `disabled`, and nothing re-rendered it: after ANY history load the
   *  'Queued' chip was dead (round-2 verifier's MAJOR). So a FLIP — in either
   *  direction — re-applies the chips of every rendered message that has a
   *  queueState. The strip has no such problem (it re-renders from
   *  `_setQueue`); the chips live inside bubbles nobody rebuilds. */
  _setQueueSupported(next, verbs) {
    const val = !!next;
    const list = Array.isArray(verbs) ? verbs.map((v) => String(v)) : this._queueVerbsServed;
    // The VERB LIST is part of this flag, not a second one: a wrapper can
    // advertise more verbs without `supported` changing (an attach after a
    // Terminate+Resume), and that flip must re-apply the chips too.
    if (val === this._queueSupported && JSON.stringify(list) === JSON.stringify(this._queueVerbsServed)) return;
    this._queueSupported = val;
    this._queueVerbsServed = list;
    this._refreshQueueChips();
    // both faces of the flag are owned by its ONE writer (round-3 verifier): the
    // strip used to stay correct only by caller ordering
    try { this._chatInput?.setQueue(this._queue, this._queueCaps()); } catch { }
  }

  /** rAF-coalesced (a flip can arrive together with a queue update and, on
   *  reconnect, once per re-attach): ONE pass over the rendered elements. */
  _refreshQueueChips() {
    if (this._queueChipRaf || this._disposed) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 0);
    this._queueChipRaf = raf(() => {
      this._queueChipRaf = 0;
      if (!this._disposed) this._applyQueueChipsNow();
    }) || -1;
  }

  /** Re-run the chip renderer for every rendered message that HAS a queue
   *  state, with the handler the current capability allows (null ⇒ the chip
   *  renders inert, which is what a harness that cannot steer must show). */
  _applyQueueChipsNow() {
    if (!this._elements?.size) return;
    const queued = new Map();
    for (const m of this._messages || []) if (m?.queueState) queued.set(m.id, m);
    if (!queued.size) return;   // nothing on screen claims a queue state
    const onSteer = this._queueCaps().steer ? (m) => this._steerQueuedMessage(m) : null;
    for (const [id, el] of this._elements) {
      const msg = queued.get(id);
      if (msg && el) ChatRenderers.applyQueueChip(el, msg, onSteer);
    }
  }

  /** THE choke point for every queue action (strip buttons, row Enter, bubble
   *  chip). A dead/disconnected window SPEAKS instead of swallowing the click
   *  (no-silent-failures); the strip is dimmed by .chat-input-disconnected so
   *  the state is visible before the click too. */
  _queueOpsLive() {
    if (!this._readOnly && !this._disconnected) return true;
    showToast(t('This session is not live — reconnect to act on queued messages.'));
    return false;
  }

  /** `extra` carries the verb's own argument — {afterId} for a reorder (null
   *  MEANS the front of the queue, so the key is only spread when the caller
   *  supplied one) and {text} for an edit. ONE writer of the frame, for the
   *  strip, the row keyboard and the bubble chip alike.
   *  RETURNS whether a frame actually went out: the strip marks the row
   *  pending BEFORE dispatching, and a dispatch that sends nothing must undo
   *  that mark (nothing will ever answer it — round-2 verifier). */
  _sendQueueOp(op, id, extra) {
    if (!this._queueOpsLive()) return false;
    const frame = { type: 'queue-op', sessionId: this.sessionId, op, id: id || null };
    if (extra && 'afterId' in extra) frame.afterId = extra.afterId === null ? null : String(extra.afterId);
    if (extra && typeof extra.text === 'string') frame.text = extra.text;
    this.ws.send(frame);
    return true;
  }

  /** Steer the queued message a bubble belongs to (the chip entry point): the
   *  bubble knows its own webui msgId (stamped by the normalizer that owns the
   *  userMessageIds map), the queue row knows the app-server id — join on
   *  msgId, and say so when the item has already left the queue. */
  _steerQueuedMessage(msg) {
    if (!this._queueCaps().steer) return;
    // Liveness FIRST: a disconnected window would otherwise blame the message
    // ("it already ran") for what is really a dead socket.
    if (!this._queueOpsLive()) return;
    const mine = (this._queue || []).find((it) => it.msgId && this._msgIdOf(msg) === it.msgId);
    if (!mine) { this._renderers.appendSystem(t('That message is no longer queued — it already ran.')); return; }
    this._sendQueueOp('steer', mine.id);
  }

  /** The webui msgId a rendered user bubble was created from (the normalizer's
   *  userMessageIds key, stamped onto the message as `webuiMsgId` — a server-
   *  only side map is not an identity the client can join on). ONE definition. */
  _msgIdOf(msg) {
    return String(msg?.webuiMsgId || msg?.msgId || '');
  }

  // Live per-session state (output style, auto-resume) from a server payload.
  // Update ONLY when the payload CARRIES the key: this also runs on partial-
  // meta refresh paths (subagent viewer, dead-session view), and resetting the
  // live style to '' there re-lit the pending hourglass on a session that was
  // genuinely running the picked style (owner-caught, 2.368.3). Callable with
  // any server message that includes these fields — 'attached' AND 'created'
  // (the creator never receives an 'attached', which is how a resumed window
  // showed "default" while the session verifiably ran Concise; 2.368.4).
  _applyLiveMeta(meta) {
    if (!meta) return;
    // Attach/create replay of the input queue — carries-the-key guard, so a
    // partial-meta path never clears a live strip. The wrapper advert is read
    // FIRST: it decides which controls the items are rendered with.
    // carries-the-key guarded (2.368.3 law): a partial meta without queueVerbs
    // keeps the served verb list (undefined = keep, see _setQueueSupported).
    if ('queueSupported' in meta) this._setQueueSupported(meta.queueSupported, ('queueVerbs' in meta) ? meta.queueVerbs : undefined);
    if ('queue' in meta) this._setQueue(meta.queue);
    // Does the RUNNING wrapper serve the live style verb? Same shape as
    // queueSupported and the same reason (2.361.1/2.364.1): the harness caps
    // row is about the PROTOCOL, this is about the process that is running.
    if ('responseStyleLive' in meta) this._statusBar?.setResponseStyleLive?.(meta.responseStyleLive);
    // The harness's own turn state + the tool ids it says are running (§2.5).
    // Carries-the-key guards, and `null` is a real value here: "this session
    // has never reported one" — the chip stays off rather than claiming idle.
    if ('turnState' in meta) this._statusBar?.setTurnState?.(meta.turnState || null);
    if ('inProgressTools' in meta) this._onToolsInProgress(meta.inProgressTools || []);
    if ('autoResume' in meta) this._statusBar?.setAutoResume?.(meta.autoResume || null);
    // WHERE this spawn's model/effort came from (B-6b6d) — the resume ladder's
    // verdict, so the effort tooltip can say "carried over from this
    // conversation's last turn" instead of leaving it indistinguishable from
    // the instance default.
    if ('spawnOrigin' in meta) this._statusBar?.setSpawnOrigin?.(meta.spawnOrigin);
    if ('outputStyle' in meta) {
      this._statusBar?.setOutputStyle?.(meta.outputStyle || '');
      try { // saved pick ≠ live value ⇒ show it as pending on the chip
        const ids = this._getSessionIds();
        const cfg = this.app?.sidebar?.getSessionConfig?.({ backend: ids?.backend || 'claude', backendSessionId: ids?.backendSessionId }) || {};
        this._statusBar?.setOutputStylePending?.(cfg.outputStyle !== undefined ? cfg.outputStyle : undefined);
      } catch { }
    }
  }

  // Fork a new session from a specific assistant message (the chat fork button).
  // Resolves this view's session, then hands off to app.forkFromMessage which
  // adds --resume-session-at <uuid> so the branch is truncated at this point.
  _forkFromMessage(uuid, msg) {
    const { backend, backendSessionId, cwd, host } = this._getSessionIds();
    if (backend !== 'claude' || !backendSessionId || !uuid) return;
    const allSess = this.app.sidebar?._allSessions || [];
    const match = allSess.find(s => s.webuiId === this.sessionId)
      || allSess.find(s => (s.backendSessionId || s.sessionId) === backendSessionId);
    const webuiName = match?.webuiName || match?.name || this.winInfo?._openSpec?.name || 'Session';
    // host rides along — a remote session's fork must spawn ON its host
    this.app.forkFromMessage({ backend, backendSessionId, cwd, host, webuiName, webuiMode: 'chat' }, uuid);
  }

  // Get session identifiers for API calls
  // Per-message metadata popup (left-strip right-click): everything the
  // normalizer knows about the record — serving model, token usage, request
  // identity, transcript position — plus a Copy-JSON escape hatch.
  _showMsgMeta(msg, x, y) {
    document.querySelectorAll('.msg-meta-pop').forEach(p => p.remove());
    const meta = msg.meta || {};
    const u = meta.usage || {};
    const cc = u.cache_creation || {};
    const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : null);
    const rows = [];
    const add = (label, val, copyable) => { if (val != null && val !== '') rows.push({ label, val: String(val), copyable }); };
    add(t('Role'), msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : msg.role === 'tool' ? `tool (${msg.toolName || '?'})` : msg.role);
    add(t('Time'), msg.ts ? new Date(msg.ts).toLocaleString() : null);
    add(t('Model'), meta.model);
    if (u.input_tokens != null || u.output_tokens != null) {
      add(t('Input tokens'), fmt(u.input_tokens));
      add(t('Cache read'), fmt(u.cache_read_input_tokens));
      // claude reports cache writes per TTL bucket (cache_creation.ephemeral_*);
      // codex reports ONE cache_write_input_tokens count (its normalizer keeps
      // that name) — claude usage never carries it, so the claude row is unchanged
      const cw = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0) || (u.cache_write_input_tokens || 0);
      add(t('Cache write'), cw ? fmt(cw) : null);
      add(t('Output tokens'), fmt(u.output_tokens));
      if (u.reasoning_output_tokens != null) add(t('Reasoning tokens'), fmt(u.reasoning_output_tokens)); // codex: the reasoning share of output_tokens
      if (u.service_tier) add(t('Service tier'), u.service_tier);
    }
    // THE TURN'S reasoning effort (turn_context / the wrapper's live twin).
    // 'ultra' is a delegation MODE, not a level — effortDisplay names the
    // level the served model really reasons at (catalog
    // multi_agent_reasoning_effort), so a user who picked ultra does not read
    // a bare 'xhigh' here and conclude their pick was dropped (2.369.62).
    if (meta.effort) add(t('Effort'), effortDisplay(this._backendId(), meta.effort, { model: meta.model }));
    add(t('Stop reason'), meta.stopReason);
    // Codex has no vendor request id: its requestId is the LEDGER's synthetic
    // key (cx:<thread>:<cumulative total>, the join every scanned rollout has)
    // and its msgId is the vendor RESPONSE id — the normalizer marks both kinds
    // so the labels stay honest; claude meta carries no kinds → old labels.
    add(meta.requestIdKind === 'ledger' ? t('Ledger request key') : t('Request ID'), meta.requestId, true);
    add(meta.msgIdKind === 'response' ? t('Response ID') : t('Message ID'), meta.msgId, true);
    add(t('uuid'), msg.uuid, true);
    if (msg.srcLine != null) add(t('Transcript line'), msg.srcLine + 1);
    const pop = document.createElement('div');
    pop.className = 'msg-meta-pop';
    pop.dataset.popover = '1';
    pop.innerHTML = `<div class="msg-meta-title">${t('Message metadata')}</div>` + rows.map(r =>
      `<div class="msg-meta-row"><span class="msg-meta-label">${escHtml(r.label)}</span><span class="msg-meta-val${r.copyable ? ' copyable' : ''}" title="${r.copyable ? t('Click to copy') : ''}">${escHtml(r.val)}</span></div>`).join('')
      + `<button class="msg-meta-copy">${t('Copy as JSON')}</button>`;
    document.body.appendChild(pop);
    pop.style.position = 'fixed'; pop.style.zIndex = '99999';
    pop.style.left = Math.min(x, window.innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - pop.offsetHeight - 8) + 'px';
    pop.addEventListener('click', (e) => {
      if (e.target.classList.contains('copyable')) { copyText(e.target.textContent); showToast(t('Copied')); }
      else if (e.target.classList.contains('msg-meta-copy')) {
        copyText(JSON.stringify({ role: msg.role, ts: msg.ts, uuid: msg.uuid, srcLine: msg.srcLine, toolName: msg.toolName, ...meta }, null, 2));
        showToast(t('Copied')); pop.remove();
      }
    });
    const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', close, true); } };
    document.addEventListener('mousedown', close, true);
    // Billing-account row (2.266.1, user request): resolved async from the
    // ledger by requestId — with the pool switching accounts mid-conversation,
    // "which account served THIS message" is per-message truth only the
    // ledger's baked attribution can answer.
    const addAsyncRow = (label, val) => {
      if (!pop.isConnected) return;
      const row = document.createElement('div');
      row.className = 'msg-meta-row';
      row.innerHTML = `<span class="msg-meta-label">${escHtml(label)}</span><span class="msg-meta-val">${escHtml(val)}</span>`;
      pop.querySelector('.msg-meta-copy')?.before(row);
    };
    const addBillingRow = (val) => addAsyncRow(t('Billing account'), val);
    // Session-level billing identity — the fallback truth when per-request
    // attribution can't answer (no request id on the record, or the remote
    // harvest hasn't landed yet). Real report: rows with no requestId showed
    // NOTHING at all, which read as a bug rather than a data gap.
    // The auth object is server.js sessionAuth(s) = {source, name, poolTarget,
    // tail, detail, hostName…} — the SAME shape session-props/session-card
    // read. (This helper used to read `accountName`/`kind`, fields that shape
    // never had, so it answered null for EVERY backend and the codex fallback
    // could never name the ChatGPT account.)
    const sessionBilling = () => {
      const ids = this._getSessionIds?.() || {};
      const live = (this.app.sidebar?._allSessions || []).find((s) =>
        s.webuiId && (s.backendSessionId === ids.backendSessionId || s.claudeSessionId === ids.backendSessionId));
      const a = live?.auth;
      if (!a) return null;
      const onHost = a.hostName ? ` · ${t('on {host}', { host: a.hostName })}` : '';
      if (a.source === 'pooled') return (a.name || t('Pool')) + (a.poolTarget ? ' → ' + a.poolTarget : '') + onHost;
      if (a.source === 'codex-subscription') return (a.name || 'ChatGPT') + onHost;
      if (a.source === 'codex-cli') return t('ChatGPT login') + onHost;
      if (a.source === 'subscription') return (a.name || t('CLI login')) + onHost;
      if (a.source === 'api-console') return t('Console login') + onHost;
      if (a.source === 'api-key' || a.source === 'api-other') return (a.name ? a.name + (a.tail ? ' (…' + a.tail + ')' : '') : (a.detail || t('API key'))) + onHost;
      return null;
    };
    const isRemote = !!(this.winInfo?._openSpec?.hostId);
    if (meta.requestId || meta.msgId) {
      // live stdout records carry NO requestId (CLI behavior) — message.id is
      // the join field both transports share, so EVERY reply attributes, not
      // just history-rebuilt ones (real report: mid-conversation replies
      // "couldn't be tracked"; the ledger had them all along).
      const q = new URLSearchParams();
      if (meta.requestId) q.set('rid', meta.requestId);
      if (meta.msgId) q.set('mid', meta.msgId);
      fetchJson('/api/usage-stats/rid-info?' + q.toString()).then((r) => {
        let val;
        if (r?.found) {
          if (r.atype === 'host') {
            // NO account resolved: this machine ran the session on its OWN
            // login (an external terminal there, or one VibeSpace never
            // spawned). Honest bucket — never invent an account.
            val = t('{host}’s machine login (remote ledger)', { host: r.hostName || r.aname || r.acct || t('remote host') });
          } else {
            // global bucket = the machine's own login of THAT harness (the
            // ledger event says which: codex → ChatGPT, claude → the CLI login)
            val = r.aname || (r.atype === 'global' || !r.acct ? (r.be === 'codex' ? t('ChatGPT login') : t('CLI login')) : r.acct);
            if (r.poolName) val += ` · ${t('via pool “{name}”', { name: r.poolName })}`;
            // a remote request bills to a real account AND ran on a machine —
            // both matter (2.294.0), so name the machine after the account
            if (r.host && r.hostName) val += ` · ${t('on {host}', { host: r.hostName })}`;
          }
        } else if (isRemote) {
          const sb = sessionBilling();
          val = (sb ? sb + ' · ' : '') + t('remote — reaches the ledger about a minute after the turn ends');
        } else {
          // not scanned yet (≤15s) — still name the session's billing identity
          // so the row is never blank about WHO will be billed
          const sb = sessionBilling();
          val = (sb ? sb + ' · ' : '') + t('not in the ledger yet');
        }
        addBillingRow(val);
        // the ledger baked the served model (+ codex effort) per request —
        // fall back to it ONLY when the record's own meta had none (a pre-meta
        // rollout / a record with no turn_context in its slab); rows appended,
        // never duplicated over the sync rows above
        if (r?.found) {
          if (!meta.model && r.model) addAsyncRow(t('Model'), r.model);
          if (!meta.effort && r.effort) addAsyncRow(t('Effort'), effortDisplay(this._backendId(), r.effort, { model: r.model || meta.model }));
        }
      }).catch(() => { });
    } else {
      // record carries NEITHER id (rare: synthetic/system records) — the only
      // honest answer left is the session-level billing identity.
      const sb = sessionBilling();
      addBillingRow((sb || t('unknown')) + ' · ' + t('session-level (no request id on this record)'));
    }
  }

  _getSessionIds() {
    const allSess = this.app.sidebar?._allSessions || [];
    // Remote sessions: every history consumer (initial load, pagination,
    // turnmap, search) must carry the host so /api/session-messages can pull
    // the transcript into the local cache — a REMOTE session that was never
    // started/viewed through this instance has a COLD cache, and a host-less
    // fetch silently returns nothing (real report: externally-started server
    // sessions opened blank in chat mode).
    const specHost = this.winInfo?._openSpec?.hostId || null;
    // View-only sessions: accept both legacy `view-<claudeId>` and backend-aware `view-<backend>-<backendSessionId>`
    if (this.sessionId.startsWith('view-')) {
      const match = allSess.find((s) => {
        const backend = s.backend || 'claude';
        const backendSessionId = s.backendSessionId || s.sessionId;
        const legacyViewId = `view-${s.sessionId}`;
        const backendViewId = backend === 'claude' ? legacyViewId : `view-${backend}-${backendSessionId}`;
        return this.sessionId === legacyViewId || this.sessionId === backendViewId;
      });
      if (match) {
        const backend = match.backend || 'claude';
        const backendSessionId = match.backendSessionId || match.sessionId;
        return { backend, backendSessionId, claudeId: backend === 'claude' ? backendSessionId : null, cwd: match?.cwd || '', host: match.host || specHost };
      }
      const rawId = this.sessionId.slice('view-'.length);
      const sep = rawId.indexOf('-');
      // `view-<backend>-<id>` only when the prefix is a KNOWN backend name —
      // a claude view id is `view-<uuid>` and the first UUID segment used to
      // be misread as a backend here, breaking pagination/search for any view
      // window whose session isn't in the local list (remote sessions never are).
      if (sep > 0 && /^(codex|claude|shell)$/.test(rawId.slice(0, sep))) {
        const backend = rawId.slice(0, sep);
        const backendSessionId = rawId.slice(sep + 1);
        if (backend && backendSessionId) {
          return {
            backend,
            backendSessionId,
            claudeId: backend === 'claude' ? backendSessionId : null,
            cwd: this.winInfo?._openSpec?.cwd || '',
            host: specHost,
          };
        }
      }
      return {
        backend: 'claude',
        backendSessionId: rawId,
        claudeId: rawId,
        cwd: this.winInfo?._openSpec?.cwd || '',
        host: specHost,
      };
    }
    const match = allSess.find(s => s.webuiId === this.sessionId);
    // A terminated window's server session is GONE from the live list
    // (discovery re-lists it as STOPPED with no webuiId) — fall back to the
    // identity captured in the openSpec while it was live, else the Resume
    // bar's click silently no-ops (real user report).
    const spec = this.winInfo?._openSpec || {};
    const backend = match?.backend || spec.backend || 'claude';
    const backendSessionId = match?.backendSessionId || match?.sessionId || spec.backendSessionId || null;
    return { backend, backendSessionId, claudeId: backend === 'claude' ? backendSessionId : null, cwd: match?.cwd || spec.cwd || '', host: match?.host || specHost };
  }

  // Fetch a range of messages from server
  async _fetchMessages(offset, limit) {
    const data = await this._fetchMessagePage(offset, limit);
    return data.messages || [];
  }

  async _fetchMessagePage(offset, limit, { withStatus = false } = {}) {
    const { backend, backendSessionId, cwd, host } = this._getSessionIds();
    if (!backendSessionId) return { messages: [], total: 0 };
    const query = new URLSearchParams({
      backend: backend || 'claude',
      backendSessionId,
      cwd: cwd || '',
      offset: String(offset),
      limit: String(limit),
    });
    if (host) query.set('host', host); // remote transcript: refresh local cache server-side
    if (withStatus) query.set('withStatus', '1');
    const res = await fetch(`/api/session-messages?${query.toString()}`);
    // An HTTP failure (500 on an unreadable transcript, a remote fetch that
    // blew up, a proxy error page) used to fall straight into res.json(): when
    // the body happened to parse, `messages` was absent → [] → the caller read
    // it as "no more history" and pagination silently died. Throw instead so
    // the scroll paths can surface a retry row (静默失败零容忍).
    if (!res.ok) throw new Error(t('Server error {code}', { code: res.status }));
    const data = await res.json();
    if (typeof data.total === 'number') this._total = data.total;
    return data;
  }

  // ── History-load transition + failure surface ──
  // Pagination and gap-seek slabs used to be completely silent: a slow fetch
  // (a remote session's page can wait on a 15s server-side transcript refresh)
  // looked like a dead scroll, and a FAILED one looked like "the conversation
  // begins here". The pill lives on the .chat-view container, NOT in the
  // message list — an in-flow row would be picked up by _withViewportAnchor /
  // _trimTop / the ':scope > .chat-msg' insert reference and would shift the
  // very scroll position those paths exist to preserve.
  _showHistoryStatus(text, { spinner = false, retry = null, kind = 'info', autoHideMs = 0 } = {}) {
    if (this._disposed || !this._container) return;
    let el = this._historyStatus;
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      // positioned by chat.css (.chat-history-status) — NOT inline: while the
      // floating run bar is up the pill has to drop below it, and an inline
      // top would beat the stylesheet rule that does it (2026-09-06 review)
      el.className = 'chat-history-status';
      this._container.appendChild(el);
      this._historyStatus = el;
    }
    clearTimeout(this._historyStatusTimer);
    el.dataset.kind = kind;
    el.innerHTML = '';
    const pill = document.createElement('div');
    pill.className = 'chat-system';
    pill.style.cssText = 'display:flex;align-items:center;gap:6px;';
    if (spinner) {
      const sp = document.createElement('span');
      sp.className = 'chat-spinner';
      pill.appendChild(sp);
    }
    pill.appendChild(document.createTextNode(text));
    if (retry) {
      const link = document.createElement('span');
      link.textContent = t('Retry');
      link.style.cssText = 'cursor:pointer;text-decoration:underline;';
      link.onclick = () => { this._hideHistoryStatus(); retry(); };
      pill.appendChild(link);
    }
    el.appendChild(pill);
    if (autoHideMs) this._historyStatusTimer = setTimeout(() => this._hideHistoryStatus(), autoHideMs);
  }

  _hideHistoryStatus() {
    clearTimeout(this._historyStatusTimer);
    this._historyStatusTimer = null;
    if (this._historyStatus) { this._historyStatus.remove(); this._historyStatus = null; }
  }

  // Deferred spinner: a local page loads in single-digit ms, and flashing a
  // pill on every scroll-up tick would be its own noise. Returns the ender —
  // it only clears a LOADING pill, never an error the fetch just raised.
  _beginHistoryLoad(text) {
    const timer = setTimeout(() => this._showHistoryStatus(text, { spinner: true, kind: 'loading' }), 350);
    return () => {
      clearTimeout(timer);
      if (this._historyStatus?.dataset.kind === 'loading') this._hideHistoryStatus();
    };
  }

  // Extend the window upward (scroll up)
  /** Desktop-hidden windows must make NO paging/pin decisions (inc-mtd1d0ft
   *  "每次从工作桌面切换到个人桌面就会卡死一段时间": on a switch, every shown
   *  window's content-visibility state re-measures — geometry transits
   *  through sh≈ch, and the paging machinery of 4-6 chat windows went wild
   *  simultaneously: fill-loops, extendTop storms, pin restores — 30-60s
   *  compositor stalls in the field capture). While suspended everything
   *  no-ops; on resume the structural settle window arms (collapsedGeomSkip
   *  covers the re-measure) and a pinned view returns to the tail in ONE hop.
   *
   *  RESUME SETTLE (inc-mtq5bpjt-0o0n, "切换桌面后新桌面的窗口内容跳到历史消息了"):
   *  suspending covered the HIDDEN state, but the resume TRANSITION itself was
   *  unguarded — clearing content-visibility re-measures the subtree, scrollTop
   *  momentarily reads 0 while still pinned, and the gap sentinel's
   *  IntersectionObserver (rootMargin 300px) fired a page-up with zero user
   *  intent. `_resumeSettleUntil` makes every AUTOMATIC paging trigger a no-op
   *  for ~1.2s (the capture's bounce ran +366…+602ms) and the pinned re-tail is
   *  re-asserted once when it expires — the window carries that timer's slack,
   *  and the re-tail asserts off `_pinnedAtSuspend` (the pin as it was when the
   *  window was HIDDEN), so an input-less unpin in between cannot strand the
   *  window in history. A POSITIONING act clears settle AND snapshot.
   *
   *  ROUND 2 — the settle was a one-shot CLIFF and the re-tail was BLIND to
   *  readers who navigate without touching the message list. Now: the re-tail
   *  is a bounded SERIES (RESUME_RETAIL_AT_MS) that bails the moment the
   *  reader positioned the view themselves after the resume
   *  (`_navigatedSince` — wheel/touch/nav key/scrollbar drag, minimap, search
   *  reveal, run-bar landing, any jump), and for RESUME_DISPLACEMENT_MS the
   *  UNPIN itself needs positive evidence (`_resumeDisplacement`).
   *
   *  ROUND 3 — a CLICK IS NOT A POSITIONING ACT. Every message-list listener
   *  ran the full _endResumeSettle(), so a plain left-click/tap during the
   *  settle disarmed the whole repair (window + snapshot + series) and the
   *  resume's own input-less displacement then stranded the window exactly as
   *  in the incident (reproduced with trusted CDP input). The effects are now
   *  split: _noteUserInput (click, non-navigation key) stamps input and ends
   *  the WINDOW; _notePositioning (wheel, touchmove, navigation keys, the
   *  scroll that follows a pointerdown = a scrollbar drag) and _noteUserNav
   *  are the only acts that drop the snapshot and the series. */
  setSuspended(on) {
    if (this._suspended === !!on) return;
    this._suspended = !!on;
    if (on) this._updateRunBar(0); // hidden window: no run bar (recomputed on resume)
    if (!on) {
      this._lastStructuralAt = Date.now();
      this._scheduleRunBar();
      this._tickCollab(); // the ages went stale while hidden — repaint on the first frame back
      // The settle carries the re-tail timer's slack (see reTail below): the
      // scroll handler must not be free to decide in the gap BETWEEN the
      // window expiring and the re-tail running.
      this._resumeAt = Date.now();
      this._resumeSettleUntil = this._resumeAt + RESUME_SETTLE_MS + RESUME_RETAIL_SLACK_MS;
      // A pinned view returns to the LIVE tail — not just the DOM bottom
      // (inc-mtfi6034, mobile: touch paging near the top had trimmed the
      // window's tail, so windowEnd < total and a plain scroll landed on an
      // old position after every desktop switch). Behind-the-tail windows
      // take the full jumpToBottom (refetches the tail slab).
      // The re-tail asserts off the SNAPSHOT taken when the window was hidden
      // (`_pinnedAtSuspend`), not off the live flag: a window that was pinned
      // when it went away returns to the tail even if some transitional,
      // input-LESS displacement unpinned it on the way back (the live flag is
      // the very thing the resume corrupts). A POSITIONING act drops the
      // snapshot (_endResumeSettle) — a reader is never yanked to the bottom;
      // a bare click does not, because it moved nothing (round-3 MAJOR).
      // …and it NEVER fires once the reader positioned the view themselves
      // after this resume. Only the four message-list listeners called
      // _endResumeSettle(), so a minimap drag / search reveal / run-bar
      // landing / jumpToIndex during the settle was silently yanked back to
      // the live tail when the timer fired (round-2 verifier's MAJOR,
      // measured: jump at +400ms → back at the tail, pinned, at +2600ms).
      const resumeAt = this._resumeAt;
      const reTail = () => { try {
        if (this._disposed || this._suspended) return;
        if (this._navigatedSince(resumeAt)) return;   // the reader went somewhere on purpose
        if (!this._pinned && !this._pinnedAtSuspend) return;
        if (this._teleported || this._windowEnd < this._total) this.jumpToBottom({ user: false }); // re-pins itself
        else {
          this._pinned = true;                            // re-assert: we ARE the live tail
          this._newMsgCount = 0;
          this._scrollBtn.classList.add('hidden');
          this._scrollToBottom();
        }
      } catch { } };
      if (this._pinned || this._pinnedAtSuspend) {
        requestAnimationFrame(reTail);           // look right immediately…
        // …and again on a BOUNDED SERIES while the subtree keeps re-measuring:
        // one shot at the settle's edge left every later displacement
        // (measured: +1400ms) free to strand the window. The pin SNAPSHOT
        // outlives the last rung so the unpin gate above still has its
        // evidence for the rest of the horizon.
        this._clearResumeRetail();
        this._resumeRetailTimers = RESUME_RETAIL_AT_MS.map((ms) => setTimeout(reTail, ms));
        this._resumeRetailTimers.push(setTimeout(() => { this._pinnedAtSuspend = false; }, RESUME_DISPLACEMENT_MS));
      } else this._pinnedAtSuspend = false;
    } else {
      // The LAST honest reading of the pin: while the window is hidden and
      // through the resume re-measure its geometry lies, so snapshot here.
      this._pinnedAtSuspend = this._pinned;
      this._clearResumeRetail();
      this._resumeSettleUntil = 0;
      this._resumeAt = 0;
    }
  }

  _clearResumeRetail() {
    for (const tm of this._resumeRetailTimers || []) clearTimeout(tm);
    this._resumeRetailTimers = [];
  }

  /** A POSITIONING act ends the resume settle AND drops the pin snapshot: the
   *  settle exists to suppress INPUT-LESS displacement, never to fight a
   *  reader who moved the view on purpose right after a desktop switch. */
  _endResumeSettle() { this._resumeSettleUntil = 0; this._pinnedAtSuspend = false; this._clearResumeRetail(); }

  /** A READER TOUCHED THE VIEW, but touching is not moving it (round-3
   *  verifier's MAJOR, reproduced with trusted CDP input): a plain click or
   *  tap in the message list during the 1.24s settle used to run the full
   *  _endResumeSettle(), which dropped `_pinnedAtSuspend` and the re-tail
   *  series — so the resume's OWN input-less displacement, arriving a beat
   *  later behind the click, reproduced the incident. A click states WHERE the
   *  reader is, not that the view moved, so it only stamps input (the paging
   *  gates' `no-input` evidence, which a scrollbar-drag reader needs) and ends
   *  the settle WINDOW; the repair machinery survives it untouched. */
  _noteUserInput() {
    this._lastUserScrollAt = Date.now();
    this._resumeSettleUntil = 0;   // the WINDOW only — snapshot and re-tail series stay
  }

  /** THE READER MOVED THE VIEW — wheel, touchmove, a navigation key, or the
   *  scroll that follows a pointerdown (a scrollbar drag, which has no event
   *  of its own). This is the act that owns the position from here on, so it
   *  ends the settle, drops the pin snapshot and cancels the re-tail series.
   *  The off-list surfaces (minimap, search reveal, run bar, jumps) stamp
   *  through _noteUserNav instead — same grade, different bookkeeping. */
  _notePositioning(via) {
    const now = Date.now();
    this._lastUserScrollAt = now;
    this._lastPositionAt = now;
    // Traced only when it CANCELS something. The ring is coarse ON PURPOSE
    // (the scroll tracer ignores moves under 400px) and the incident recorder
    // keeps its last 200 entries — a per-wheel-event trace would evict exactly
    // the history that diagnosed this incident.
    if (via && (this._resumeSettleUntil || this._pinnedAtSuspend)) this._trace?.('userPos', { via });
    this._cancelForcedScroll(via);   // our own 10-frame scroll chain loses to the reader (B-9702)
    this._endResumeSettle();
  }

  /** Did this press land on the list's own SCROLLBAR GUTTER? That is the whole
   *  signature of a scrollbar drag — the position of the press, not the timing
   *  of what follows (round-4 verifier's MAJORs; see POINTER_DRAG_PX above).
   *  The gutter is the strip of the border box the CONTENT box does not reach:
   *  `offsetWidth - clientWidth` minus the borders, on the right in LTR and on
   *  the LEFT in RTL; a horizontal scrollbar is the same story along the
   *  bottom. Coordinates are converted viewport→LAYOUT px first: the UI-scale
   *  body `zoom` scales getBoundingClientRect and clientX but NOT clientWidth,
   *  and mixing those two spaces is exactly the 2.369.5 VNC-pointer bug. The
   *  semantic minimap hides the native scrollbar (`scrollbar-width: none`), so
   *  there the gutter is 0 wide and nothing can land in it — correct: with the
   *  minimap on the reader drags the minimap, which is _noteUserNav('minimap').
   *  DOM-free by construction (it reads injected geometry), so it is unit
   *  tested in plain node. */
  _pointerOnScrollbar(e) {
    const list = this._messageList;
    if (!list || !e || typeof e.clientX !== 'number') return false;
    const r = list.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) return false;
    // viewport px → layout px (body zoom / uiScale)
    const scale = list.offsetWidth ? (r.width / list.offsetWidth) : 1;
    const x = (e.clientX - r.left) / (scale || 1);
    const y = (e.clientY - r.top) / (scale || 1);
    let bl = 0, br = 0, bt = 0, bb = 0, rtl = false;
    try {
      const cs = getComputedStyle(list);
      rtl = cs.direction === 'rtl';
      bl = parseFloat(cs.borderLeftWidth) || 0; br = parseFloat(cs.borderRightWidth) || 0;
      bt = parseFloat(cs.borderTopWidth) || 0; bb = parseFloat(cs.borderBottomWidth) || 0;
    } catch { /* node/unit context: no borders to account for */ }
    const vGutter = list.offsetWidth - list.clientWidth - bl - br;
    const hGutter = list.offsetHeight - list.clientHeight - bt - bb;
    if (vGutter > 0 && (rtl
      ? (x >= bl && x < bl + vGutter)
      : (x >= bl + list.clientWidth && x <= list.offsetWidth - br))) return true;
    if (hGutter > 0 && y >= bt + list.clientHeight && y <= list.offsetHeight - bb) return true;
    return false;
  }

  /** Is THIS scroll event a scrollbar drag? Only while a press that landed in
   *  the gutter is still held — and only once it has actually displaced the
   *  view (a bare track press that changed nothing positioned nothing). The
   *  flag is cleared on pointerup/pointercancel, so a press-and-hold followed
   *  by a move minutes later is still the reader dragging, and a click in the
   *  content area is never a drag however close a displacement lands. */
  _pointerDragScroll(scrollTop) {
    if (!this._pointerDownOnScrollbar) return false;
    return Math.abs(scrollTop - (this._pointerDownScrollTop || 0)) > POINTER_DRAG_PX;
  }

  /** An explicit reader NAVIGATION that the message list's own listeners can
   *  never see: the minimap (pointer events on the container), a search
   *  reveal, the floating run bar (on this._container), jumpToIndex /
   *  jumpToBottom. Stamps, and ends the resume settle exactly like a wheel —
   *  round-2 verifier's MAJOR: without this the 1240ms re-tail yanked such a
   *  reader back to the live tail. */
  _noteUserNav(via) {
    this._lastNavAt = Date.now();
    this._trace?.('userNav', { via });
    this._cancelForcedScroll(via);   // …and so does an off-list navigation (B-9702)
    this._endResumeSettle();
  }

  /** Did the READER position this view after `since`? The chat-view-seek
   *  `userScrolled = (this._lastUserScrollAt||0) > Math.max(jumpAt, revealAt)`
   *  idiom, generalised over every positioning stamp we own: a POSITIONING act
   *  (_lastPositionAt — wheel/touch/nav key/scrollbar drag), explicit nav, a
   *  jump landing (_scrollElStable sets _lastJumpAt) and a search reveal.
   *  Automatic repositioning must lose to every one of them — and to NONE of
   *  the acts that merely touched the view: `_lastUserScrollAt` is not read
   *  here, because a click is not a positioning act (round-3 MAJOR). */
  _navigatedSince(since) {
    return Math.max(this._lastNavAt || 0, this._lastPositionAt || 0,
      this._lastJumpAt || 0, this._search?._lastRevealAt || 0) > since;
  }

  /** Is an atBottom→false transition the RESUME's own re-measure rather than
   *  the reader? Positive evidence, like the paging gates: inside the resume
   *  horizon, the pin snapshot still says this window was AT the live tail
   *  when it was hidden, and nothing the reader did has landed since. */
  _resumeDisplacement() {
    const at = this._resumeAt || 0;
    if (!at || Date.now() - at > RESUME_DISPLACEMENT_MS) return false;
    if (!this._pinnedAtSuspend) return false;      // never dragged a window that was reading history
    return !this._navigatedSince(at);
  }

  /** Is an AUTOMATIC (observer- or geometry-driven) upward page allowed right
   *  now? ONE predicate for every such trigger — the gap sentinel's
   *  IntersectionObserver and the scroll/wheel-driven `_maybeSeekEarlier` —
   *  so the laws the scroll handler already obeys cannot be re-invented per
   *  entry point (inc-mtq5bpjt-0o0n: the IO path had NO gate at all and
   *  paged a pinned, just-resumed window into history). Returns a REASON
   *  string (traced as `gapSkip`) or null when the page may proceed.
   *  Explicit user gestures (a retry click) bypass this by construction —
   *  they pass `auto: false`. */
  _autoPagingBlocked() {
    if (this._disposed) return 'disposed';
    if (this._suspended) return 'suspended';                                   // desktop-hidden: geometry is meaningless
    if (Date.now() < (this._resumeSettleUntil || 0)) return 'resume-settle';   // just un-hidden: still re-measuring
    if (this._pinned) return 'pinned';                                         // at the LIVE tail by definition — real upward intent unpins first
    if (Date.now() - (this._lastStructuralAt || 0) < 1500) return 'settling';  // our own mutation is still moving scrollTop
    if (!(this._lastUserScrollAt && Date.now() - this._lastUserScrollAt < 1500)) return 'no-input'; // displacement is not intent
    if ((window.__vsInputResizeAt && (Date.now() - window.__vsInputResizeAt < 250))
      || (window.__vsViewportResizeAt && (Date.now() - window.__vsViewportResizeAt < 400))) return 'input-resize';
    return null;
  }

  async _extendTop(count = 50) {
    if (this._suspended) return; // hidden-desktop window: no paging (inc-mtd1d0ft)
    if (this._loading || this._windowStart <= 0) return;
    this._loading = true;
    const endLoad = this._beginHistoryLoad(t('Loading earlier messages…'));
    try {
      const newStart = Math.max(0, this._windowStart - count);
      const fetchCount = this._windowStart - newStart;
      // A failed fetch (server restart mid-scroll) must NOT leave _loading stuck
      // true forever — that permanently blocks all pagination. The finally resets it.
      const msgs = await this._fetchMessages(newStart, fetchCount);

      const scrollHeightBefore = this._messageList.scrollHeight;
      // Element-anchored position preservation (see _withViewportAnchor —
      // the scrollHeight-delta math this replaces measured fresh inserts at
      // their content-visibility ESTIMATE against trimmed REAL heights; the
      // tracer caught the delta going NEGATIVE, clamping scrollTop to 0 and
      // load-looping the top sentinel). The fold (_updateRuns) runs INSIDE
      // the anchored section so the restore covers every height mutation of
      // this batch in one task.
      const anchored = this._withViewportAnchor(() => {
        // :scope > — a bare '.chat-msg' can match a NESTED element (inside a
        // card), whose parent isn't the list → insertBefore throws NotFoundError
        // (telemetry-captured real user error). Fragment + one validated insert.
        const firstEl = this._messageList.querySelector(':scope > .chat-msg');
        this._loadingHistory = true;
        const frag = document.createDocumentFragment();
        for (const msg of msgs) {
          const el = this._renderDetached(msg);
          if (el) frag.appendChild(el);
        }
        const ref = (firstEl && firstEl.parentNode === this._messageList) ? firstEl : this._messageList.firstChild;
        this._messageList.insertBefore(frag, ref);
        this._loadingHistory = false;
        this._windowStart = newStart;

        // Trim bottom if DOM window too large (keep max ~150 rendered messages)
        // — NEVER while PINNED (inc-mtq5bpjt-0o0n): a pinned view IS the live
        // tail, and this trim is what CONVERTS "we paged up by accident" into
        // permanent damage — it drops the tail (windowEnd < total), unpins, and
        // leaves the reader stranded in history (the capture: trimBottom
        // removed 48/50, then anchored:false landed scrollTop at 0). The DOM
        // stays bounded regardless: the live-append path trims the TOP while
        // pinned, and the next genuine (unpinned) page-up trims normally.
        if (this._pinned) this._trace('trimSkipPinned', { ws: newStart, n: msgs.length });
        else this._trimBottom();
        this._updateRuns();
      });
      if (!anchored) {
        // no usable anchor (very top / empty list) — old delta-math fallback
        this._traceExpect();
        this._messageList.scrollTop += (this._messageList.scrollHeight - scrollHeightBefore);
      }
      // …and re-assert the tail: a prepend must never move a PINNED viewport
      // off the bottom. Under transitional geometry the anchor restore fails
      // (anchored:false) and the delta fallback clamps scrollTop to 0 — the
      // visible "跳到历史消息了".
      if (this._pinned) { this._trace('pinnedRetail', { ws: newStart }); this._scrollToBottom(); }
      this._lastStructuralAt = Date.now(); this._lastStructuralDir = 'up'; this._trace('extendTop:done', { ws: newStart, n: msgs.length, anchored, st: Math.round(this._messageList.scrollTop), sh: this._messageList.scrollHeight });
      if (this._search?.hasHighlight) this._search.applyHighlightLayer();
    } catch (e) {
      // Unhandled before: the scroll handler calls this un-awaited, so a
      // rejection just vanished into the console and scroll-up "did nothing".
      this._showHistoryStatus(t('Couldn\'t load earlier messages'), {
        kind: 'error',
        retry: () => this._extendTop(count),
      });
      try { track('event', 'chat-extend-top-failed', String(e?.message || e).slice(0, 120)); } catch {}
    } finally {
      endLoad();
      setTimeout(() => { this._loading = false; }, 300);
    }
  }

  // Install an invisible sentinel at the very top of the message list. It plays
  // the role the old seam marker did (holds the gap-load cursor + anchor) but is
  // 0-height and unstyled, so scrolling up seek-loads earlier history with no
  // visible "truncated" notice — a continuous virtual scroll to line 0.
  

  // Toggle the content-visibility escape hatch. Turning it back ON (off=stable)
  // makes never-c-v-rendered elements collapse to the 80px estimate, which would
  // visibly shift the viewport — so re-enabling anchors on the topmost visible
  // message and compensates scrollTop to keep the view still.
  

  // Downward counterpart of _maybeSeekEarlier: while teleported, scrolling near
  // the bottom seek-loads the next NEWER slab so browsing continues past the
  // jumped-to point (until the end of the file / "return to latest").
  

  

  // Cap the teleport-browse DOM: each slab adds hundreds of elements and gap
  // messages are exempt from the virtual-scroll trim, so a long browse would
  // otherwise grow without bound. Drop from the far side, keeping the seek
  // cursors consistent so scrolling back re-loads what was dropped. The cap must
  // comfortably hold the teleport slab + a full 2000-line slab (~1200 msgs) in
  // EACH direction — a tighter cap thrashes: an up-load trims away what a
  // down-load just added (and vice versa).
  

  // Scroll-driven trigger for continuous gap loading once the registered tail is
  // fully rendered — complements the IntersectionObserver (which only fires on
  // intersection CHANGES, and scroll compensation can pin the sentinel in place).
  

  // A full-window jump (jumpToIndex/jumpToBottom) cleared the gap content; the
  // sentinel survives (it's not a .chat-msg) but its cursor now points at a stale
  // line. Reset it so the next scroll-up re-seeks from the tail edge (line
  // tailStartLine) instead of skipping the [cursor, tailStartLine) span.
  

  // Auto-load earlier history as the top sentinel scrolls into view — like a
  // virtual list's infinite scroll. The sentinel sits at the top; each loaded
  // slab inserts just below it (with scroll compensation), pushing the sentinel
  // out of the trigger zone until the user scrolls up again.
  _observeHistoryGap(markerEl) {
    if (markerEl._gapObserved) return;
    markerEl._gapObserved = true;
    if (!this._gapObserver) {
      this._gapObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // THE inc-mtq5bpjt-0o0n door: this callback fires off pure GEOMETRY
          // (a desktop resume re-measures the subtree, scrollTop reads 0 for a
          // frame and the sentinel lands inside the 300px margin) and used to
          // page a PINNED window straight into history. It is an AUTOMATIC
          // caller — _loadEarlierGap applies _autoPagingBlocked() and traces
          // `gapSkip` with the reason, so the tracer shows WHY nothing loaded.
          this._loadEarlierGap(entry.target, null, { via: 'io' });
        }
      }, { root: this._messageList, rootMargin: '300px 0px 0px 0px' });
    }
    this._gapObserver.observe(markerEl);
  }

  // Lazily seek-load a slab of earlier history (server reads by byte offset).
  // Fired automatically by the IntersectionObserver as the sentinel nears the
  // viewport. Each call walks one slab older, filling from the tail edge down to
  // line 0 — the whole file as one continuous scroll. Gap messages render
  // read-only and are excluded from virtual-scroll trimming + window accounting.
  

  // Reached line 0 — the whole conversation is now loaded. Stop observing; the
  // invisible sentinel can just go away (a visible "Load earlier" button, if any
  // legacy marker is in use, is removed too).
  

  // Render a gap message to a standalone element WITHOUT registering it in the
  // virtual-scroll window (_messages/_elements/_windowStart). Static + read-only.
  

  // Shared query base for /api/session-history-gap (slabs, info, fullturnmap,
  // full-file search). `host` is load-bearing and was MISSING from every gap
  // caller: without it the server resolves the LOCAL transcript path, so a
  // remote huge session's scroll-up slabs / minimap / Ctrl+F read a cache
  // frozen at the last attach — or nothing at all — while the identical local
  // session worked (violates the 2.108.1 "EVERY history consumer passes
  // ?host=" rule that /api/session-messages already follows).
  _gapQueryBase() {
    const { backend, backendSessionId, cwd, host } = this._getSessionIds();
    if (!backendSessionId) return null;
    const q = new URLSearchParams({ backend: backend || 'claude', backendSessionId, cwd: cwd || '' });
    if (host) q.set('host', host);
    return q.toString();
  }

  // Gap fetch with an explicit ok/fail verdict. `.then(r=>r.json()).catch(()=>null)`
  // collapsed "server said there is no more history" and "the request failed"
  // into the same null — and the seek path read that null as completion and
  // PERMANENTLY removed the scroll sentinel (one blip = the conversation
  // appears to begin at the failure point).
  async _gapFetch(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ── Whole-conversation minimap for gapped (huge) sessions ──
  // Fetch the full-file user-turn map (TIME coordinates) and switch the
  // minimap to full-extent mode so the scrollbar reflects the entire session,
  // not just the loaded head+tail window.
  async _initGapMinimap() {
    // NEVER for subagent viewers (2.233.2, real report "agent日志前面有好多
    // 父会话历史"): _getSessionIds() resolves a sub- viewer to its PARENT
    // session, so the gap probe hits the parent's huge transcript, installs
    // the seek sentinel, and scrolling up loads PARENT slabs above the
    // agent's own log — real parent records rendered as if the agent did
    // them. Same capability class as _canPaginate.
    if (!this._canPaginate) return;
    if (this._gapMinimapActive || this._gapMinimapLoading) return;
    this._gapMinimapLoading = true;
    try {
      const base = this._gapQueryBase();
      if (!base) return;
      const r = await this._gapFetch(`/api/session-history-gap?${base}&fullturnmap=1`);
      // A FAILED probe must not latch: _gapMinimapActive stays false, so the
      // next caller re-probes instead of leaving a huge session without its
      // whole-conversation minimap + seek sentinel forever.
      const data = r.ok ? r.data : null;
      if (this._disposed || !data?.fullTurns?.length) return;
      this._gapMinimapActive = true;
      this._gapBounds = { tailStartLine: data.tailStartLine, totalLines: data.totalLines };
      this._convoLastTs = data.lastTs; // newest real turn ts — anything past it in a
                                       // seek-loaded slab is a Date.now() fallback
      this._chatMinimap.renderFullExtent({ fullTurns: data.fullTurns, firstTs: data.firstTs, lastTs: data.lastTs });
      // Huge session: the server sent tail-ONLY (no head, no seam marker). Install
      // an invisible sentinel above the tail so scrolling up seek-loads the whole
      // earlier history as one continuous virtual list (down to line 0).
      this._installSeekSentinel();
      this._reportVisibleTsRange();
    } finally {
      this._gapMinimapLoading = false;
    }
  }

  // Report the visible viewport's time span to the minimap thumb. Uses
  // getBoundingClientRect for ACCURATE on-screen detection — offsetTop is
  // content-visibility-estimated for off-screen elements, so a far-below live
  // message could read as "visible" and yank the thumb to the recent end. Takes
  // min/max ts (not DOM-first/last) so a stray element can't invert the range.
  // The whole loop forces just ONE reflow (first rect read), then cheap reads.
  

  

  // Minimap click/drag in time mode: jump to a turn at file `line`. Teleports
  // to a seek-loaded slab around that absolute line, then scrolls to nearest ts.
  

  // Center an element with iterative convergence: after a teleport loads a big
  // slab, content-visibility computes real heights over several frames and a
  // single scrollTop set drifts. Re-center over ~12 frames until stable. Holds
  // the programmatic-scroll guard so auto-load doesn't fire mid-scroll.
  

  // Teleport: replace the whole view with a read-only slab seek-loaded around an
  // ABSOLUTE file line (whole=1, so it works in the tail region too and is immune
  // to the live tail sliding). Scrolling up continues seeking older by line; the
  // scroll-to-bottom button returns to the live/registered tail. This is the one
  // jump primitive — search + minimap both go through it, so there is no
  // normalized-index drift regardless of session size or live growth.
  

  // ── Full-file search support (huge sessions) ──
  // Jump to a search match given file-line + ts. Teleports to a slab around the
  // absolute line, then returns the DOM element nearest the match (by ts) so the
  // caller can expand + highlight it.
  

  // Find the loaded gap-slab element at (or nearest before) a file line.
  // Only accepts a hit when the line actually falls inside the loaded span —
  // otherwise the nearest-below element could be a whole slab away.
  _gapElForLine(line) {
    let best = null, bestLine = -1, maxLine = -1;
    for (const el of this._messageList.querySelectorAll('.chat-gap-msg[data-line]')) {
      const l = Number(el.dataset.line);
      if (!Number.isFinite(l)) continue;
      if (l > maxLine) maxLine = l;
      if (l <= line && l > bestLine) { best = el; bestLine = l; }
    }
    if (!best) return null;
    // In-span: either something at/after the target exists, or the gap between
    // the best match and the target is small (non-rendering records only)
    if (maxLine >= line || line - bestLine <= 50) return best;
    return null;
  }

  _nearestElByTs(ts) {
    let best = null, bestDiff = Infinity;
    for (const el of this._messageList.querySelectorAll('.chat-msg')) {
      const ets = Number(el.dataset.ts) || this._tsOfRenderedEl(el);
      if (!ets) continue;
      const d = Math.abs(ets - ts);
      if (d < bestDiff) { bestDiff = d; best = el; }
    }
    return best;
  }

  // Scroll to the rendered message nearest `ts`. Returns true if a match within
  // `tolMs` was found (Infinity = always scroll to the closest rendered).
  

  // Load messages at the bottom (when scrolling back down after trimming)
  async _extendBottom(count = 50) {
    if (this._suspended) return; // hidden-desktop window: no paging (inc-mtd1d0ft)
    if (this._loading || this._windowEnd >= this._total) return;
    this._loading = true;
    const endLoad = this._beginHistoryLoad(t('Loading messages…'));
    try {
      const end = Math.min(this._total, this._windowEnd + count);
      // finally resets _loading even if the fetch rejects — else pagination locks.
      const msgs = await this._fetchMessages(this._windowEnd, end - this._windowEnd);

      this._loadingHistory = true;
      for (const msg of msgs) this._onCreateMessage(msg);
      this._loadingHistory = false;
      this._windowEnd = end;

      // Trim top if DOM window too large
      this._trimTop();

      // Same-task fold of the newly appended cards (see _extendTop)
      this._updateRuns();
      this._lastStructuralAt = Date.now(); this._lastStructuralDir = 'down'; this._trace('extendBottom', { we: end, n: msgs.length, st: Math.round(this._messageList.scrollTop) });
      // Newly rendered messages need the search highlight re-applied
      if (this._search?.hasHighlight) this._search.applyHighlightLayer();
    } catch (e) {
      // Same silent class as _extendTop: the scroll handler never awaits this.
      this._showHistoryStatus(t('Couldn\'t load more messages'), {
        kind: 'error',
        retry: () => this._extendBottom(count),
      });
      try { track('event', 'chat-extend-bottom-failed', String(e?.message || e).slice(0, 120)); } catch {}
    } finally {
      endLoad();
      setTimeout(() => { this._loading = false; }, 300);
    }
  }

  // Keep DOM under ~150 messages by removing from bottom
  _trimBottom(maxRendered = 150) {
    // FOLD-DOMINATED WINDOWS (inc-mtajy6wr, "上翻的时候出现大量白屏"): with
    // semantic collapse folding whole tool/agent runs, 150 rendered messages
    // can amount to a couple of run headers — SHORTER than the viewport
    // (sh clamps to ch). Trimming then removes the only VISIBLE content and
    // every wheel-tick teleports the window 50 messages through fold-space
    // on a white screen. While the rendered window is shorter than ~2
    // viewports, let it grow instead (fold members are hidden and cheap);
    // 600 rendered messages is the absolute DOM bound.
    const list = this._messageList;
    if (list && list.scrollHeight < list.clientHeight * 2) maxRendered = 600;
    const els = list.querySelectorAll('.chat-msg:not(.chat-gap-msg)');
    if (els.length <= maxRendered) return;
    const toRemove = els.length - maxRendered;
    const removedIds = new Set();
    for (let i = els.length - 1; i >= els.length - toRemove; i--) {
      const id = els[i].dataset.msgId;
      if (id) { this._elements.delete(id); this._renderedMsgIds.delete(id); removedIds.add(id); }
      els[i].remove();
    }
    if (removedIds.size) this._messages = this._messages.filter(m => !removedIds.has(m.id));
    this._windowEnd -= toRemove;
    this._lastStructuralAt = Date.now(); this._lastStructuralDir = 'up'; this._trace('trimBottom', { removed: toRemove });
    this._pinned = false; // we trimmed the bottom, can't be pinned
  }

  // Keep DOM under ~150 messages by removing from top
  _trimTop(maxRendered = 150) {
    // Exclude lazily-loaded gap messages: they aren't part of the server
    // window (_windowStart/_windowEnd accounting), so trimming them would
    // corrupt the offsets and silently delete explicitly-requested history
    // FOLD-DOMINATED WINDOWS (inc-mtajy6wr, "上翻的时候出现大量白屏"): with
    // semantic collapse folding whole tool/agent runs, 150 rendered messages
    // can amount to a couple of run headers — SHORTER than the viewport
    // (sh clamps to ch). Trimming then removes the only VISIBLE content and
    // every wheel-tick teleports the window 50 messages through fold-space
    // on a white screen. While the rendered window is shorter than ~2
    // viewports, let it grow instead (fold members are hidden and cheap);
    // 600 rendered messages is the absolute DOM bound.
    const list = this._messageList;
    if (list && list.scrollHeight < list.clientHeight * 2) maxRendered = 600;
    const els = list.querySelectorAll('.chat-msg:not(.chat-gap-msg)');
    if (els.length <= maxRendered) return;
    const scrollHeightBefore = this._messageList.scrollHeight;
    const toRemove = els.length - maxRendered;
    const removedIds = new Set();
    // Element-anchored ABSOLUTE restore (2.229.1, forensics-confirmed): the
    // old relative `scrollTop -= (before - after)` double-compensated with
    // the browser's NATIVE scroll anchoring, which reacts to the same
    // removals with its own adjustment — the two fought in ±4000px
    // oscillations. An absolute anchor restore converges no matter what the
    // browser did in between. Delta math survives only as the anchorless
    // fallback (empty/near-top viewport).
    const anchored = this._withViewportAnchor(() => {
      for (let i = 0; i < toRemove; i++) {
        const id = els[i].dataset.msgId;
        if (id) { this._elements.delete(id); this._renderedMsgIds.delete(id); removedIds.add(id); }
        els[i].remove();
      }
    });
    if (removedIds.size) this._messages = this._messages.filter(m => !removedIds.has(m.id));
    this._windowStart += toRemove;
    this._lastStructuralAt = Date.now(); this._lastStructuralDir = 'down'; this._trace('trimTop', { removed: toRemove, anchored });
    if (!anchored) {
      this._traceExpect();
      this._messageList.scrollTop -= (scrollHeightBefore - this._messageList.scrollHeight);
    }
  }

  // Jump to a specific message index: replace window entirely
  async jumpToIndex(targetIdx) {
    this._noteUserNav('jumpToIndex');   // a chosen destination — the resume re-tail must never overrule it
    this._trace('jumpToIndex', { idx: targetIdx });
    this._traceExpect();
    const windowSize = 50;
    const start = Math.max(0, targetIdx - 20);
    const end = Math.min(this._total, start + windowSize);
    // Fetch BEFORE clearing the DOM, and abort the jump on failure — a throw
    // past this point would leave the view wiped with nothing rendered.
    let msgs;
    const endLoad = this._beginHistoryLoad(t('Loading messages…'));
    try { msgs = await this._fetchMessages(start, end - start); }
    catch (e) {
      this._showHistoryStatus(t('Couldn\'t load that part of the conversation'), {
        kind: 'error', retry: () => this.jumpToIndex(targetIdx),
      });
      return;
    } finally { endLoad(); }

    // Clear and rebuild DOM
    this._messageList.querySelectorAll('.chat-msg, .chat-msg-system').forEach(el => el.remove());
    this._resetGapAfterJump();
    this._elements.clear();
    this._renderedMsgIds.clear();
    this._messages = [];
    this._windowStart = start;
    this._windowEnd = end;
    this._pinned = false;

    this._loadingHistory = true;
    for (const msg of msgs) this._onCreateMessage(msg);
    this._loadingHistory = false;

    // Scroll to the target message (gap-loaded elements are outside the
    // window index space — exclude them so relIdx maps to the right element)
    // Fold runs NOW, before the landing measurement — the 180ms-debounced
    // observer pass otherwise collapses a tool-heavy window right AFTER the
    // scroll landed, moving the target out from under the viewport (incident
    // trace: land at 145px → yanked to 0 → spurious extendBottom on the
    // collapsed heights → user reads ~20 messages before the one they chose).
    this._updateRuns();
    const relIdx = targetIdx - start;
    const allMsgs = this._messageList.querySelectorAll('.chat-msg:not(.chat-gap-msg)');
    if (relIdx >= 0 && relIdx < allMsgs.length) {
      const targetEl = allMsgs[relIdx];
      for (const d of targetEl.querySelectorAll('details:not([open])')) d.open = true;
      targetEl.style.contentVisibility = 'visible';
      // The INDEX-mode landing was a single-rAF scrollIntoView while the
      // teleport path got the full content-visibility landing machinery —
      // heights keep resolving for ~1s after a window rebuild, so one shot
      // always drifts (the recurring "minimap jump lands wrong" class).
      // _scrollElStable = 12-frame convergence + 180/400/750ms re-centers +
      // the programmatic-scroll guard + _lastJumpTargetEl replay.
      this._scrollElStable(targetEl);
    }
    if (this._search?.hasHighlight) this._search.applyHighlightLayer();
  }

  // Jump to the bottom of the conversation. `user:false` = the resume re-tail
  // calling it on the reader's behalf — it must not stamp a navigation (that
  // would cancel its own bounded series and the unpin gate's evidence).
  async jumpToBottom({ user = true } = {}) {
    if (user) this._noteUserNav('jumpToBottom');
    const windowSize = 50;
    const start = Math.max(0, this._total - windowSize);
    // Same as jumpToIndex: never wipe the rendered view for a fetch that failed
    // (the "return to latest" button would just blank the window).
    let msgs;
    const endLoad = this._beginHistoryLoad(t('Loading messages…'));
    try { msgs = await this._fetchMessages(start, this._total - start); }
    catch (e) {
      this._showHistoryStatus(t('Couldn\'t load the latest messages'), {
        kind: 'error', retry: () => this.jumpToBottom(),
      });
      return;
    } finally { endLoad(); }

    this._messageList.querySelectorAll('.chat-msg, .chat-msg-system').forEach(el => el.remove());
    this._resetGapAfterJump();
    this._elements.clear();
    this._renderedMsgIds.clear();
    this._messages = [];
    this._windowStart = start;
    this._windowEnd = this._total;

    this._loadingHistory = true;
    for (const msg of msgs) this._onCreateMessage(msg);
    this._loadingHistory = false;
    this._pinned = true;
    this._newMsgCount = 0;
    this._scrollBtn.classList.add('hidden');
    if (this._search?.hasHighlight) this._search.applyHighlightLayer();

    // Temporarily disable content-visibility so the browser computes real heights
    // for all elements, then scroll to bottom, then re-enable
    this._forceScrollToBottom();
  }

  _forceScrollToBottom() {
    this._programmaticScroll = true;
    // SINGLE CHAIN (2.338.0, Windows freeze audit): every create/edit/delta
    // used to start its OWN 10-frame chain; overlapping chains each did a
    // scrollTop=scrollHeight read-after-write = N forced full-document
    // layouts per frame during streaming. One chain, countdown refreshed by
    // each call — same convergence semantics, one forced layout per frame.
    this._fsbFrames = 0;
    if (this._fsbActive) return;
    this._fsbActive = true;
    // …and the chain carries an EPOCH (B-9702): it is AUTOMATIC repositioning,
    // so a reader who positions the view CANCELS it (_cancelForcedScroll bumps
    // the epoch) and every frame already queued must find itself orphaned
    // instead of writing scrollTop one more time.
    const epoch = this._fsbEpoch = (this._fsbEpoch || 0) + 1;
    const list = this._messageList;
    const step = () => {
      if (this._disposed) { this._fsbActive = false; this._programmaticScroll = false; return; }
      if (epoch !== this._fsbEpoch) return;   // cancelled/superseded — the flags belong to whoever holds the epoch now
      list.scrollTop = list.scrollHeight;
      // Each frame scrolling reveals off-screen elements, browser computes
      // their real heights (replacing content-visibility estimates), scrollHeight
      // grows — repeat until converged or max 10 frames (~166ms)
      if (++this._fsbFrames < 10) requestAnimationFrame(step);
      // THE MUTE OUTLIVES THE LAST WRITE BY ONE FRAME (B-9702, the same
      // capture): a scroll event is delivered AFTER the callback that wrote
      // scrollTop, so clearing `_programmaticScroll` in the frame of the final
      // write handed OUR OWN displacement to the boundary decision as if a
      // reader had produced it — the guard exists to reject exactly that.
      // Guarded by `_fsbActive` so a chain restarted in between keeps its mute.
      else { this._fsbActive = false; requestAnimationFrame(() => { if (!this._fsbActive) this._programmaticScroll = false; }); }
    };
    requestAnimationFrame(step);
  }

  /** THE READER TOOK OVER — stop our own bottom-scroll chain (B-9702, measured
   *  in headless chrome: 5/20 real wheel-ups at resume+1400ms were UNDONE).
   *  `_forceScrollToBottom` keeps writing `scrollTop = scrollHeight` for up to
   *  10 frames (~166ms). That is AUTOMATIC repositioning and it must lose to a
   *  positioning act exactly like the resume re-tail SERIES, which
   *  `_endResumeSettle` already cancels — the round-2 series fix cancelled the
   *  TIMERS and left the frame chain, the other automatic writer, running. The
   *  capture: the +1240ms re-tail rung's chain wrote the view back to the live
   *  tail 3ms AFTER the reader's wheel-up (trace `repin st:1760 … posAgo:3`,
   *  with `fsb:-1` because the chain clears its own flag in the frame of its
   *  final write), the pin re-engaged off that position, and `_extendTop`'s
   *  pinned-tail invariant then re-asserted the bottom — the reader's page-up
   *  silently undone. Geometry was NOT collapsed there (sh-ch = 2.5 viewports):
   *  the hypothesis that the 2.301.0 collapsed-geometry window carried this was
   *  refuted by the measurement.
   *  It only ever cancels a chain of OURS: with `_fsbActive` false a jump
   *  landing (`_scrollElStable` / `_landOnHeader`) owns `_programmaticScroll`
   *  and must keep it. */
  _cancelForcedScroll(via) {
    if (!this._fsbActive) return;
    this._trace('fsbCancel', { via: via || '', frames: this._fsbFrames || 0 });
    this._fsbEpoch = (this._fsbEpoch || 0) + 1;   // orphan every queued frame of the running chain
    this._fsbActive = false;
    this._programmaticScroll = false;
  }

  // Render a message into elements (append to list, then detach for insertion elsewhere)
  // Render a normalized message and detach from DOM (for insertBefore operations)
  _renderDetached(msg) {
    this._onCreateMessage(msg);
    const el = this._elements.get(msg.id);
    if (el) { el.remove(); return el; }
    return null;
  }

  // Handle normalized message ops from server (create/edit/meta)
  _onOp(op) {
    if (op.op === 'create') {
      this._onCreateMessage(op.message);
      this._noteRecordKind(op.message);
    } else if (op.op === 'edit') {
      this._onEditMessage(op.id, op.fields);
      // AFTER the assign: a coalescing collab edit carries the grown rows
      this._noteRecordKind(this._messages.find((m) => m.id === op.id));
    } else if (op.op === 'meta') {
      this._onMeta(op);
    }
  }

  // Create a new normalized message → render and append to DOM
  _onCreateMessage(msg) {
    if (this._renderedMsgIds.has(msg.id)) return;
    // set_model confirmation: the CLI echoes "Set model to X (resolved-id)" as a
    // user record — the RESOLVED id is the authoritative model for the status
    // bar (the control_response reports success even for bogus names). Parsed
    // before the defer check so it applies even while viewing history.
    if (msg.role === 'user' && this._statusBar) {
      const txt = (msg.content || []).map(b => b.text || '').join('');
      const m = txt.match(/^<local-command-stdout>Set model to (\S+?)(?: \(([^)]+)\))?<\/local-command-stdout>/);
      if (m) this._statusBar.setModel(m[2] || m[1]);
    }
    if (!this._loadingHistory && msg.backendMeta?.reviewThreadId && msg.backendMeta?.delivery === 'detached') {
      if (!this._openedDetachedReviews) this._openedDetachedReviews = new Set();
      const reviewThreadId = msg.backendMeta.reviewThreadId;
      if (reviewThreadId && !this._openedDetachedReviews.has(reviewThreadId)) {
        this._openedDetachedReviews.add(reviewThreadId);
        const { backend, backendSessionId, cwd } = this._getSessionIds();
        this.app.viewSession(reviewThreadId, cwd, t('Review'), {
          backend: backend || 'codex',
          backendSessionId: reviewThreadId,
          agentKind: 'review',
          sourceKind: 'review',
          parentThreadId: backendSessionId || null,
        });
      }
    }

    // Live message while viewing history: don't render, just track count.
    // Teleport mode is always "viewing history" \u2014 its window accounting is
    // stale, so gate on the flag directly (else live messages leak into the
    // teleported slab and corrupt the minimap's visible-ts thumb).
    if (!this._loadingHistory && (this._teleported || (!this._pinned && this._windowEnd < this._total))) {
      this._total++;
      this._newMsgCount++;
      this._scrollBtn.innerHTML = `\u2193 <span class="chat-scroll-badge">${this._newMsgCount}</span>`;
      this._scrollBtn.classList.remove('hidden');
      return;
    }

    this._renderedMsgIds.add(msg.id);
    // Upsert: trims clear _renderedMsgIds, so re-extending the window would
    // otherwise push duplicate copies — and _onEditMessage's findIndex would
    // then mutate the stale first copy instead of the rendered one.
    const existIdx = this._messages.findIndex(m => m.id === msg.id);
    if (existIdx >= 0) this._messages[existIdx] = msg; else this._messages.push(msg);
    this._syncReviewAvailability();

    // Streaming indicator driven by server's streaming-label broadcast (no client-side derivation)

    let el;
    switch (msg.role) {
      case 'user': el = this._renderers.renderUserMsg(msg); break;
      case 'assistant': el = this._renderers.renderAssistantMsg(msg); break;
      case 'tool': el = this._renderers.renderToolMsg(msg); break;
      case 'system': {
        const result = this._renderers.renderSystemMsg(msg);
        if (result?.sideEffect) {
          const se = result.sideEffect;
          if (se.model) this._statusBar.setModel(se.model);
          if (se.permMode) this._statusBar.setPermMode(se.permMode);
          if (se.slashCommands && this._chatInput) this._chatInput.setSlashCommands(se.slashCommands);
          this._statusBar.render();
        }
        el = result?.el || null;
        break;
      }
      default: return;
    }

    if (!el) return;
    el.dataset.msgId = msg.id;
    if (msg.ts) el.dataset.ts = msg.ts; // for time-coordinate minimap positioning
    // Every per-element mark the VIEW owns (retraction §2.10, the executing-tool
    // dot §2.5) — re-derived here, at both replacement sites AND in the gap
    // renderer (chat-view-seek `_renderGapMsg`), never carried by the
    // element. Retraction survives a REBUILD because the normalizer
    // marks the message in record order, so a reload of the transcript shows
    // the same rewound history the live stream did — one code path for both.
    this._applyElementMarks(el, msg);
    this._elements.set(msg.id, el);
    this._messageList.appendChild(el);
    this._renderers.addWrapToggles(el);
    this._renderers.addOpenInEditorBtn(el);
    // Update window bounds for live messages (not history batch)
    if (!this._loadingHistory) {
      this._total++;
      this._windowEnd = this._total;
      // Update minimap with new user turns (CLI-injected page-image
      // attachments share the previous turnIndex — not a turn, no marker)
      if (msg.role === 'user' && !msg.imageAttachment) {
        const preview = (msg.content || []).map(b => b.text || '').join('').trim();
        const turn = { turnIndex: msg.turnIndex, startIdx: this._total - 1, ts: msg.ts, role: 'user' };
        if (preview) {
          if (preview.startsWith('This session is being continued from a previous conversation')) {
            turn.isCompact = true; turn.preview = 'Context compacted';
          } else {
            turn.preview = preview.length > 60 ? preview.substring(0, preview.lastIndexOf(' ', 60) > 30 ? preview.lastIndexOf(' ', 60) : 60) + '…' : preview;
          }
        }
        this._chatMinimap.addTurn(turn, this._total);
        // Huge-session (time-coordinate) minimap: extend the timeline too —
        // addTurn is a no-op in full-extent mode, and without this the map
        // froze at init time while the live session kept growing
        if (this._gapMinimapActive) this._chatMinimap.appendFullTurn(turn);
      }
      this._chatMinimap.setViewport(this._windowStart, this._windowEnd, this._total);
    }
    if (this._pinned && !this._loadingHistory) {
      // Live path trim (audit-confirmed): _trimTop was only ever called from
      // pagination, so a pinned chat streaming for DAYS grew the DOM without
      // bound. While pinned the user is at the bottom — dropping the oldest
      // rendered rows is invisible; scrolling up re-loads them via _extendTop.
      // NOT during batch loads (2.229.1 forensics): _extendBottom appends 50
      // messages through this path — the per-message trim+scrollToBottom
      // fired a storm of remove/compensate cycles per batch and the browser's
      // native scroll anchoring answered each with its own correction
      // (captured live: ±4000px oscillation between adjacent frames). Batch
      // callers trim ONCE at the end.
      this._trimTop();
      this._scrollToBottom();
    }
  }

  // Edit an existing message → re-render in place
  _onEditMessage(id, fields) {
    // Update stored message
    const msgIdx = this._messages.findIndex(m => m.id === id);
    if (msgIdx < 0) return;
    const msg = this._messages[msgIdx];
    Object.assign(msg, fields);
    // A Workflow launch ack just landed → status-bar chip for the running run
    if (msg.toolName === 'Workflow' && fields.content && !this._loadingHistory) {
      const out = msg.content?.[0]?.output || '';
      const runId = out.match(/Run ID:\s*(wf_[\w-]+)/)?.[1];
      if (runId) this._statusBar.trackWorkflow(runId, out.match(/Workflow ["“]([^"”]+)["”]/)?.[1] || msg.content?.[0]?.input?.name || null);
    }
    this._syncReviewAvailability();

    // Queue chip: a cheap in-place swap. A full re-render here would rebuild
    // the whole bubble (markdown, images, fold state) for a one-word badge.
    if ('queueState' in fields) {
      const el = this._elements.get(id);
      if (el) ChatRenderers.applyQueueChip(el, msg, this._queueCaps().steer ? (m) => this._steerQueuedMessage(m) : null);
    }

    // Status transitions
    if (fields.status === 'complete' || fields.status === 'error' || fields.status === 'interrupted') {
      // Re-render completed messages in case content changed while pending/local.
      const oldEl = this._elements.get(id);
      if (oldEl) {
        let newEl;
        switch (msg.role) {
          case 'user': newEl = this._renderers.renderUserMsg(msg); break;
          case 'tool': newEl = this._renderers.renderToolMsg(msg); break;
          case 'assistant': newEl = this._renderers.renderAssistantMsg(msg); break;
          default: {
            const result = this._renderers.renderSystemMsg(msg);
            newEl = result?.el || null;
            break;
          }
        }
        if (newEl) {
          this._trace?.('editReplace', { id, status: fields.status });
          newEl.dataset.msgId = id;
          if (msg.ts) newEl.dataset.ts = msg.ts; // keep time-coordinate minimap data on re-render
          // Run open/closed memory is keyed by ELEMENT — transfer it across the
          // swap or a run whose every member gets replaced within one debounce
          // window re-collapses on the user (review-confirmed: a single-Bash
          // fold opened to watch live output snapped shut the moment the
          // result landed).
          if (this._runExpanded?.has(oldEl)) this._runExpanded.add(newEl);
          if (this._runStickyOpen?.has(oldEl)) this._runStickyOpen.add(newEl); // the user's deliberate-open mark rides the swap too (verifier: a full re-render otherwise let the pinned auto-refold snap it shut)
          this._applyElementMarks(newEl, msg);
          oldEl.replaceWith(newEl);
          this._elements.set(id, newEl);
          this._renderers.addWrapToggles(newEl);
          this._renderers.addOpenInEditorBtn(newEl);
        }
      }
    }

    // Streaming text update → coalesce to one re-render per frame: each delta
    // re-parses the FULL accumulated markdown + linkify passes, so per-delta
    // rendering is O(n²) over a long response and churns the DOM subtree
    if (fields.content && msg.status === 'streaming') {
      if (!this._streamRenderPending) this._streamRenderPending = new Set();
      this._streamRenderPending.add(id);
      if (!this._streamRenderRaf) {
        // 150ms throttle on top of the frame coalescing (2.338.0): each pass
        // re-parses the FULL accumulated markdown (marked+DOMPurify+3 linkify
        // regex sweeps) — per-frame on a long answer is O(n²) main-thread
        // burn. 150ms is invisible next to token cadence.
        const wait = Math.max(0, 150 - (Date.now() - (this._lastStreamRenderAt || 0)));
        this._streamRenderRaf = setTimeout(() => requestAnimationFrame(() => {
          this._streamRenderRaf = null;
          this._lastStreamRenderAt = Date.now();
          const ids = this._streamRenderPending; this._streamRenderPending = new Set();
          for (const mid of ids) this._renderStreamingText(mid);
        }), wait);
      }
    }

    // Streaming label driven by server broadcast — no client-side sync needed here

    if (this._pinned) this._scrollToBottom();

    // Permission update
    if (fields.permission) {
      const el = this._elements.get(id);
      if (el) this._renderers.renderPermissionOverlay(el, msg);
      // The overlay mutates the card IN PLACE — no childList change, so the
      // runs observer never fires. Re-evaluate directly: an unresolved
      // permission must pop its card out of a collapsed run (and a resolve
      // lets it fold back in).
      this._updateRuns();
    }

    // Task info update — delegate to status bar
    if (fields.taskInfo) {
      this._statusBar.updateTask(fields.taskInfo, msg.toolCallId, msg.content);
      // TERMINAL state also freezes the AGENT CARD's live status line
      // (2.233.1, real report "已经回复完了还写着回应中"): the line is only
      // ever redrawn by _onSubagentMessage, so after the last subagent
      // message it kept whatever activity was in flight ("responding")
      // forever. Background agents' completion arrives as the
      // <task-notification> wakeup (2.233.0), which now lands here.
      if (fields.taskInfo.status && fields.taskInfo.status !== 'running') {
        this._freezeAgentStatus(msg.toolCallId, fields.taskInfo.status);
      }
    }
  }

  // Render the latest streaming text for a message (called once per rAF batch)
  _renderStreamingText(id) {
    if (this._disposed) return;
    const msg = this._messages.find(m => m.id === id);
    const oldEl = this._elements.get(id);
    if (!msg || !oldEl || msg.status !== 'streaming') return;
    const textDiv = oldEl.querySelector('.chat-text');
    if (textDiv && msg.content[0]?.type === 'text') {
      textDiv.innerHTML = this._renderers.renderMarkdown(stripAnsi(msg.content[0].text));
    } else if (msg.content[0]?.type === 'thinking') {
      const summaryEl = oldEl.querySelector('.chat-thinking summary');
      const preEl = oldEl.querySelector('.chat-thinking pre');
      const detailsEl = oldEl.querySelector('.chat-thinking');
      if (detailsEl) detailsEl.open = true;
      if (summaryEl) summaryEl.textContent = t('Thinking');
      if (preEl) preEl.textContent = stripAnsi(msg.content[0].text || '');
      // A streaming thinking card can start empty (tagged hidden at create)
      // and fill in — untag the moment real text lands so it becomes visible.
      if ((msg.content[0].text || '').trim()) oldEl.classList.remove('chat-empty-thinking');
    }
    if (this._pinned) this._scrollToBottom();
  }

  // Handle meta ops (usage, cost, turn_complete)
  /**
   * Verdict of a mid-session set_permission_mode (2.195.0). Success → keep the
   * badge + persist as the session's per-session permission (resume respawns
   * with it — the old switch was durable NOWHERE, so any restart clamped back).
   * Refusal (the CLI rejects bypassPermissions unless the session was LAUNCHED
   * bypass-capable — verified on 2.1.215) → revert the optimistic badge and
   * offer the working path: restart this conversation with the mode as a
   * launch flag (history preserved via --resume).
   */
  async _onPermissionModeAck({ ok, mode, error }) {
    // The ack is BROADCAST to every attached client — only the INITIATOR
    // (the client with an optimistic pick in flight: _permModePrev set) may
    // pop dialogs; other tabs just sync the badge on success and ignore
    // refusals (their badge never changed). Review-confirmed: unconditional
    // handling made BOTH tabs offer the restart → double kill+resume flap.
    // The successful mode is deliberately NOT persisted as the per-session
    // launch override: the CLI moves modes on its own (plan → acceptEdits on
    // ExitPlanMode approval) and a frozen 'plan' override would relaunch
    // every resume into plan mode (review finding). Server meta tracks the
    // live mode via the per-message init harvest; only the explicit
    // restart-with-bypass persists (its whole point is the launch flag).
    const initiated = this._statusBar && this._statusBar._permModePrev !== undefined;
    if (ok) {
      this._statusBar?.setPermMode(mode);
      return;
    }
    if (!initiated) return;
    this._statusBar?.revertPermMode();
    if (mode === 'bypassPermissions') {
      const go = await showConfirmDialog({
        title: t('Restart in bypassPermissions?'),
        message: t('The CLI refuses switching a running session to bypassPermissions (it must be launched with that mode). Restart this conversation with bypassPermissions? The history is kept — it resumes where you left off.'),
        confirmText: t('Restart session'),
      });
      if (go) this._restartWithPermission('bypassPermissions');
      else showToast(error || t('Permission mode unchanged'), { type: 'error', duration: 5000 });
    } else {
      showToast(error || t('Permission mode change refused by the CLI'), { type: 'error', duration: 6000 });
    }
  }

  /** Kill + resume with the mode persisted as the per-session permission
   *  override (the billing-switcher dance: geometry survives, transcript
   *  flushes before --resume). */
  _restartWithPermission(mode) {
    const ids = this._getSessionIds();
    const backendSessionId = ids.backendSessionId || this.winInfo?._openSpec?.backendSessionId;
    const cwd = ids.cwd || this.winInfo?._openSpec?.cwd || '';
    if (!backendSessionId || !cwd) { showToast(t('Session id not known yet — try again after the first reply'), { type: 'error' }); return; }
    this._persistSessionConfig({ permission: mode });
    const backend = ids.backend || 'claude';
    const name = this.app.sidebar?.getCustomName?.({ backend, backendSessionId }) || this.winInfo?.name || t('Session');
    const winId = this.winInfo?.id;
    const winBounds = winId ? this.app._snapshotWinBounds?.(this.app.wm.windows.get(winId)) : undefined;
    this.app.killSession(this.sessionId, backendSessionId);
    setTimeout(() => {
      if (winId) this.app.wm?.closeWindow?.(winId);
      this.app.resumeSession(backendSessionId, cwd, name, {
        mode: 'chat', backend, backendSessionId,
        hostId: ids.host || undefined, winBounds, permission: mode,
      });
    }, 900); // let the CLI flush its transcript before --resume
  }

  _persistSessionConfig(patch) {
    try {
      const sb = this.app?.sidebar;
      if (!sb?.setSessionConfig) return;
      const match = (sb._allSessions || []).find(x => x.webuiId === this.sessionId);
      const spec = this.winInfo?._openSpec;
      const target = match || (spec?.backendSessionId ? { backend: spec.backend || 'claude', backendSessionId: spec.backendSessionId } : null);
      if (!target) return; // brand-new session with no backend id yet — nothing durable to key on
      const cur = sb.getSessionConfig?.(target) || {};
      sb.setSessionConfig(target, { ...cur, ...patch });
    } catch { /* config persistence is best-effort */ }
  }

  _onMeta(op) {
    // A published queue IS the wrapper's in-band "I serve queue ops" advert
    // (every current wrapper emits a baseline one at boot), so a window created
    // before its sidecar existed turns its controls on here.
    // A publication that NAMES NO VERBS is a pre-verb-table wrapper, and it is
    // mapped onto the legacy three EXACTLY as the server maps a verb-less
    // sidecar (round-2 verifier: `|| undefined` fell back to whatever was
    // known before, which for a fresh window is the create/attach payload's
    // "nothing known" — the intersection then hid the ENTIRE strip from a
    // session the server would have served remove/steer/steer-all for).
    if (op.subtype === 'queue') { if (op.supported) this._setQueueSupported(true, Array.isArray(op.verbs) ? op.verbs : LEGACY_QUEUE_VERBS.slice()); this._setQueue(op.items); return; }
    // The outcome of ONE queue op: the strip row ends its pending state and,
    // on a refusal, wears the reason (the system card the normalizer also
    // emits scrolls away — the control the user pressed must speak too).
    if (op.subtype === 'queue-result') { this._chatInput?.setQueueOpResult(op.id, op.ok !== false, op.text || ''); return; }
    if (op.subtype === 'served-model') {
      this._statusBar.setServedModel(op.data?.model || null);
      return;
    }
    // Live effort (2.369.62): the running turn's value AND the pending pick.
    // Fired by turn_context / wrapper_meta / thread_settings_applied alike, so
    // a `/effort` typed into the chat or another client's pick lands here with
    // no re-attach and no rollout re-read.
    if (op.subtype === 'effort') {
      this._statusBar.setEffort(op.data?.effort || null, op.data?.effortNext ?? null);
      return;
    }
    // RETRACTED HISTORY (§2.10 / §3.2). ONE op for both harnesses: claude's
    // `tombstone` (kind 'superseded' — the CLI replaced a partial orphan and
    // asks consumers to remove it) and codex's `thread_rolled_back` (kind
    // 'rollback' — turns deliberately taken back, struck through in place so
    // nobody's memory of reading them is silently rewritten). Marking, never
    // splicing: the message array's indices back the virtual window's
    // slice(offset,limit) and `total`, and re-indexing them under a reader is
    // where three paging incidents came from.
    if (op.subtype === 'rewound') { this._applyRewound(op.data); return; }
    if (op.subtype === 'usage') {
      this._statusBar.updateUsage(op.data);
    } else if (op.subtype === 'todos') {
      if (this._chatInput) {
        this._chatInput.updateTodos(op.data);
      } else {
        // readOnly mode: update local todos + display
        this._todos = op.data;
        this._updateTodoDisplay();
      }
    } else if (op.subtype === 'goal_status') {
      const gs = op.data;
      if (gs?.met) {
        this._statusBar.setGoal(null);
        this._renderers.appendSystem(t('Goal met: {condition}', { condition: gs.condition }));
      } else if (gs?.condition) {
        this._statusBar.setGoal(gs.condition);
        if (gs.sentinel) this._renderers.appendSystem(t('Goal set: {condition}', { condition: gs.condition }));
      }
    } else if (op.subtype === 'turn_complete') {
      this._noteTurnBoundary();
      this._hideTyping();
      this._statusBar.addCost(op.data?.cost, op.data?.modelUsage);
      // Blink window
      if (!this.winInfo.element.classList.contains('window-active')) {
        this.winInfo.element.classList.add('window-waiting');
        if (this.winInfo._notifyChanged) this.winInfo._notifyChanged();
      }
    }
  }

  /** Mark the named messages as retracted, live. Idempotent (the same op can
   *  arrive again on a reconnect replay) and index-stable — the elements stay
   *  where they are and only gain a class. */
  _applyRewound(data) {
    const ids = Array.isArray(data?.ids) ? data.ids : [];
    const kind = data?.kind === 'superseded' ? 'superseded' : 'rollback';
    if (!ids.length) return;
    const want = new Set(ids);
    for (const m of this._messages) if (m && want.has(m.id)) m.rewound = kind;
    for (const id of ids) {
      const el = this._elements.get(id);
      if (el) this._markRewoundEl(el, kind);
    }
    // The minimap is NOT re-rendered here: ChatMinimap.render(turnMap) needs a
    // turn map, and the only authority for one is the server normalizer (which
    // already drops rewound turns). Fabricating a client-side map to blank the
    // ghost markers would be a second source of truth for turn positions.
  }

  /** EVERY per-element mark this view owns, re-derived from the view's own
   *  state onto a freshly built element.
   *
   *  The bug this closes (round-2 verifier, reproduced at 375×667): a mark
   *  written STRAIGHT TO THE DOM at its origin — `_applyRewound`'s
   *  strike-through, `_onToolsInProgress`'s executing dot — dies at the next
   *  element REPLACEMENT, and there are FOUR places that build an element for
   *  a message (`_onCreateMessage`, the status-transition re-render in
   *  `_onEditMessage`, `_rerenderVisible`, and — round 3 — `_renderGapMsg`,
   *  the huge-session seek renderer in chat-view-seek.js). The claude
   *  tombstone case always gets one: the message it retracts is a STREAMING
   *  partial, and `MessageManager._finalizeStreaming` emits `{op:'edit',
   *  fields:{status:'complete'}}` for exactly that message at the next
   *  `result` — so a retracted answer came back on screen one record later,
   *  while an attach/rebuild (which reads `msg.rewound` from the normalizer)
   *  still hid it. That divergence is what the create path's comment claims
   *  cannot happen.
   *
   *  So: never re-apply marks one at a time at each replacement site (that is
   *  the same miss with more copies). One function, called at every place an
   *  element is BUILT FOR A MESSAGE, that asks the VIEW STATE what this
   *  element should be wearing. A new mark is added here and is correct
   *  everywhere. Idempotent — it only ever restates what the state says.
   *
   *  The rule is "built for a message", NOT "enters `_elements`": round 3's
   *  finding was exactly that narrower phrasing — gap-slab elements are
   *  deliberately kept out of `_elements` (they sit outside the virtual
   *  window's accounting), so a hook keyed to that map skipped the one path
   *  that renders a >34MB conversation's earlier history. scripts/
   *  test-turn-truth-ui's source drift guard COUNTS the builders and demands a
   *  mark call inside each one, so a fifth path cannot be added silently. */
  _applyElementMarks(el, msg) {
    if (!el) return;
    // ① retraction (§2.10) — the message model carries it (live op + rebuild)
    if (msg?.rewound) this._markRewoundEl(el, msg.rewound);
    // ② the tool the harness says is EXECUTING (§2.5, set_in_progress_tool_use_ids).
    //    `_inFlightTools` is the resolved set, and for a long-running tool the
    //    next delta may never come — re-deriving is the only way the dot
    //    survives a re-render or a page-out/page-in.
    const inflight = this._inFlightTools;
    if (inflight?.size) {
      const mark = (node) => { const tid = node?.dataset?.toolId; if (tid) node.classList.toggle('chat-tool-inflight', inflight.has(tid)); };
      mark(el);
      if (el.querySelectorAll) for (const n of el.querySelectorAll('[data-tool-id]')) mark(n);
    }
  }

  /** ONE place that turns the mark into DOM (create-path and live op share it,
   *  so a rebuilt history and a live retraction can never look different). */
  _markRewoundEl(el, kind) {
    if (!el) return;
    el.classList.add(kind === 'superseded' ? 'chat-msg-superseded' : 'chat-msg-rewound');
    if (kind !== 'superseded' && !el.querySelector('.chat-rewound-tag')) {
      const tag = document.createElement('span');
      tag.className = 'chat-rewound-tag';
      tag.textContent = t('rewound');
      tag.title = t('The agent rolled this turn back — it is no longer part of the conversation it can see.');
      el.appendChild(tag);
    }
  }

  /** Pages published from this session → status-bar design chip. */
  _loadPages() {
    // by webui session id OR conversation id: a resume mints a new session id
    // while the pages keep the old one (review-caught: the chip went empty
    // exactly when the user came back for the link)
    const ids = this._getSessionIds();
    const cid = ids?.claudeId || ids?.backendSessionId || '';
    fetchJson('/api/pages?sessionId=' + encodeURIComponent(this.sessionId) + (cid ? '&conversationId=' + encodeURIComponent(cid) : '')).then((r) => {
      if (r && Array.isArray(r.pages) && this._statusBar) this._statusBar.setPages(r.pages);
    });
  }

  /** The design request (2.366.0): a VISIBLE user message (no hidden
   *  injection — the transcript shows exactly what the agent was asked)
   *  that routes the bundled design-canvas flow to this instance: the kit
   *  comes from `vibespace-page kit`, the publish step is
   *  `vibespace-page publish`. Agent-facing text: English, not t(). */
  _sendDesignRequest(brief, { public: pub = false } = {}) {
    const b = String(brief || '').trim();
    if (!b || !this._chatInput) return false;
    const msg = `[VibeSpace design request] ${b}

Create this as a design canvas HOSTED BY THIS VIBESPACE (not claude.ai):
1. Run \`vibespace-page kit\` — it prints "Base directory for this skill: <dir>".
2. Read <dir>/SKILL.md and follow it exactly: author the .dc.html artboards (and canvas.json for several), seed with seed-canvas.mjs, run its --check. Work inside a new subdirectory designs/<short-slug>/ of the current working directory (create it) so the working files and the seeded ~2 MB page never land in a repo root. Do not use the Artifact tool, artifact-capabilities or anything pointing at claude.ai.
3. Publish with \`vibespace-page publish <seeded file> --title "<what I would call it>"${pub ? ' --public' : ''}\` and reply with the share link plus a line on what you drafted and assumed.`;
    // ANSWER THE DIALOG (round-5): sendText refuses while a queued-message
    // edit owns the input, and the brief exists only in the dropdown's own
    // textarea — the caller keeps it open on a false. Every reachable false
    // is one sendText already TOASTED (the chip exists only on a window that
    // has a live input, so the guard above cannot answer for the dropdown).
    // CARRIES THE USER'S OWN WORDS (round-8): `b` is the brief they typed, and
    // on a TRUE the dropdown closes and destroys the only other copy — so this
    // send keeps the pending-send slot `_send` armed for it (the action
    // default releases it) and a half-open socket hands the message back with
    // a notice instead of losing it silently.
    return this._chatInput.sendText(msg, { carriesUserText: true }) !== false;
  }

  // ── LIVE SUB-AGENT TRAFFIC (2026-09-07, owner: "这种互聊如果连续发生是不是应该
  // 界面里展示下连续数量, 这样我好知道对话没卡住") ────────────────────────────
  // Dozens of ENCRYPTED one-line collab rows over minutes, with no assistant
  // text in between, are indistinguishable from a wedged turn. Three surfaces
  // read the SAME derived numbers (src/collab-row.js, PURE): the coalesced
  // card's head, the run header/footer/floating bar, and the spinner line.
  // Everything is derived from the rows the normalizer already stamped —
  // nothing is counted into a field, nothing is stored server-side, so a
  // second client renders identical numbers off the same message state.

  /**
   * The id of the card the NEXT collab row would coalesce into — i.e. the one
   * whose age is still meaningful. That is the LAST message, and only while
   * the turn streams: once anything else arrives (assistant text, a tool card,
   * a sub-agent report) the burst is over and the card freezes to its span.
   */
  _liveCollabId() {
    if (!this._typingSince || this._disposed) return null;
    const last = this._messages[this._messages.length - 1];
    return (last?.collab && !last.collab.report) ? last.id : null;
  }

  /**
   * Traffic stats of the CURRENT turn's collab rows (the spinner line's
   * counter): a report card lands between two coalesced cards, so a per-card
   * count would restart at 1 in the middle of one burst. Bounded backward scan
   * — the turn boundary is a change of turnIndex.
   */
  _liveCollabStats() {
    const msgs = this._messages;
    if (!msgs.length) return null;
    const turn = msgs[msgs.length - 1].turnIndex;
    let start = msgs.length - 1;
    for (let seen = 0; start > 0 && seen < 400 && msgs[start - 1].turnIndex === turn; seen++) start--;
    const rows = [];
    // push, never `unshift(...rows)` — a several-hundred-row burst spread as
    // arguments is an argument-count hazard for no gain
    for (let i = start; i < msgs.length; i++) for (const r of (msgs[i].collab?.rows || [])) rows.push(r);
    return rows.length ? collabTrafficStats({ rows }) : null;
  }

  /** Note what KIND of record just landed — collab traffic, or anything else. */
  _noteRecordKind(msg) {
    if (this._loadingHistory || this._disposed) return;
    const isCollab = !!msg?.collab;
    this._lastRecordCollab = isCollab;
    if (isCollab) this._startCollabTick();
    this._applyStreamLabel();
  }

  /**
   * The spinner label. While a turn streams AND the newest typed record was
   * collab traffic, it names the traffic; the moment ANY other record arrives
   * (a tool call, assistant text, an api_retry notice — all of which either
   * broadcast their own streaming-label or land as a non-collab message) it
   * yields back to the server's label. The server stays the authority on what
   * the harness is doing; this only re-labels the gap the harness is silent in.
   */
  _applyStreamLabel() {
    if (!this._typingSince || this._disposed) return;
    const stats = this._lastRecordCollab ? this._liveCollabStats() : null;
    if (stats?.count) {
      this._collabLabelShown = true;
      this._showTyping(subAgentStreamLabel(stats, { now: Date.now(), t }), 'subagents');
      return;
    }
    // Yield ONLY what we took. Re-asserting the remembered server label on
    // every op would fight the label chat-input sets locally on send (a stale
    // "running Bash" from the previous turn would win) — the server stays the
    // only writer except across our own override.
    if (this._collabLabelShown) {
      this._collabLabelShown = false;
      this._showTyping(this._serverStreamLabel || t('thinking...'), this._serverStreamKind || null);
    }
  }

  /** The server's own activity label — remembered so the collab label can yield back to it. */
  _onServerStreamLabel(label, kind) {
    this._serverStreamLabel = label || '';
    this._serverStreamKind = kind || null;
    this._collabLabelShown = false; // the server is writing the line itself now
    // a streaming-label broadcast IS a different record (task_started, a
    // function_call, an assistant message): the collab claim is stale
    this._lastRecordCollab = false;
    if (label) {
      this._showTyping(label, kind || null);
      // …and only NOW is _typingSince set, so a mid-burst attach/reattach can
      // finally answer "is this card live" — arm the ticker off the same event
      this._startCollabTick();
    } else this._hideTyping();
  }

  /**
   * Arm the ticker — and paint once immediately, so a window ATTACHED in the
   * middle of a burst does not sit on the frozen span for a second (attaching
   * to a STALLED turn is exactly the case this readout exists for). Gated on
   * something actually being live: a claude session has no collab cards and
   * must not carry an interval at all.
   */
  _startCollabTick() {
    if (this._collabTimer || this._disposed || !this._liveCollabId()) return;
    this._collabTimer = setInterval(() => this._tickCollab(), 1000);
    this._tickCollab();
  }

  _stopCollabTick() {
    if (this._collabTimer) { clearInterval(this._collabTimer); this._collabTimer = null; }
  }

  /**
   * One tick: re-write the ages that already exist on screen. It NEVER
   * re-renders a card (a rebuild would drop the fold state the user opened)
   * and never touches scroll/pin/paging — it writes textContent into three
   * places and stops itself when there is nothing live left.
   *
   * A hidden window (desktop switch, setSuspended) is a NO-OP: its geometry is
   * meaningless and nobody is reading it; resume runs one tick immediately so
   * the age is right on the first frame back.
   */
  _tickCollab() {
    if (this._disposed) return;
    if (this._suspended) return;
    const liveId = this._liveCollabId();
    const now = Date.now();
    // (a) EVERY card that stopped being live must be FROZEN once — it keeps
    // its last age forever otherwise, which reads as "still going". The set is
    // the authority (not "the card this ticker last painted"): rows that
    // landed while the window was hidden were painted live by the renderer
    // with no tick in between.
    this._freezeStaleHeads(liveId, now);
    if (liveId) this._paintCollabHead(liveId, true, now);
    // (b) the run header / footer / floating bar segment
    this._paintRunCollab(liveId, now);
    // (c) the spinner line
    if (liveId) this._applyStreamLabel();
    if (!liveId) this._stopCollabTick();
  }

  /**
   * Remember whether a card's head was rendered with a LIVE age. Called from
   * the renderer's `isCollabLive` hook (it returns the answer through) and
   * from every paint below, so the set always names exactly the cards that
   * still owe a freeze — including the ones no tick ever touched.
   *
   * The set is created LAZILY here and read optionally below because this
   * class is deliberately DOM-free at import and its guards are unit-tested on
   * prototype-only views (`Object.create(ChatView.prototype)`, test-chat-trim-
   * guard) whose constructor never ran: setSuspended(false) → _tickCollab on
   * such a view must not throw, or the whole resume suite dies at import time.
   */
  _noteCollabHeadPainted(id, live) {
    if (id) {
      const ids = (this._liveHeadIds ||= new Set());
      if (live) ids.add(id); else ids.delete(id);
    }
    return live;
  }

  /**
   * Freeze every head that was painted live and is not the live card any more.
   * A card trimmed out of the render window simply leaves the set — there is
   * no element left to freeze, and the next render composes the frozen form
   * from the rows anyway.
   */
  _freezeStaleHeads(liveId, now) {
    if (!this._liveHeadIds?.size) return;
    for (const id of [...this._liveHeadIds]) if (id !== liveId) this._paintCollabHead(id, false, now);
  }

  /** Rewrite one card's `.chat-collab-head` text (live age or frozen span). */
  _paintCollabHead(msgId, live, now) {
    const el = this._elements.get(msgId);
    const head = el?.querySelector?.('.chat-collab-head');
    const msg = head ? this._messages.find((m) => m.id === msgId) : null;
    if (!msg?.collab) { this._liveHeadIds?.delete(msgId); return; }
    const text = collabHeadText(collabTrafficStats(msg.collab), { now, live, t });
    if (head.textContent !== text) head.textContent = text;
    this._noteCollabHeadPainted(msgId, live);
  }

  /**
   * Re-compose the label of the run holding the live card and write it to its
   * header, its footer and the floating bar. `run.mkLabel` is captured in the
   * fold pass with that run's own counts, so this never rebuilds a second kind
   * table (the 2.369.34 class) — it only re-asks the ONE composer for a fresh
   * `now`.
   */
  _paintRunCollab(liveId, now) {
    const runs = this._runs;
    if (!runs?.length) return;
    const liveEl = liveId ? this._elements.get(liveId) : null;
    for (const run of runs) {
      if (!run.mkLabel || !run.collabStats?.count) continue;
      const live = !!liveEl && run.members.includes(liveEl);
      if (!live && !run._collabWasLive) continue; // frozen run: its label never changes
      run._collabWasLive = live;
      const label = run.mkLabel({ now, live });
      if (label === run.label) continue;
      run.label = label;
      const headLabel = run.header?.querySelector('.chat-run-label');
      if (headLabel) headLabel.textContent = label;
      const footLabel = run.footer?.querySelector('.chat-run-label');
      if (footLabel) footLabel.textContent = `${t('Collapse')} · ${label}`;
      if (this._runBarRun === run) this._scheduleRunBar();
    }
  }

  /** THE TURN'S IDENTITY advances at the REAL boundary — every normalizer's
   *  `turn_complete` meta op — never on a label arm: `_typingSince` is a TIME
   *  and a time is not an identity (the turn that ends and the one that
   *  starts next can arm in the SAME millisecond), and the flag also drops
   *  and re-arms INSIDE a turn (a permission answer, a reconnect), which must
   *  not read as a new turn — the 2.302.0 capture-the-counter rule, applied to
   *  the flag itself (steer-chord round 3). */
  _noteTurnBoundary() { this._turnEpoch = (this._turnEpoch || 0) + 1; }

  // _showTyping / _hideTyping delegate to ChatInput (normal) or readOnly _streamStatus
  _showTyping(label = t('thinking...'), kind = null) {
    if (!this._typingSince) this._typingSince = Date.now(); // watchdog arm
    if (this._chatInput) { this._chatInput.showTyping(label, kind); return; }
    // readOnly fallback — same shape as ChatInput's line (label in its own
    // `.chat-stream-label`), so a ticking age is a textContent write and not a
    // rebuild of the whole line once a second
    if (!this._streamStatus) return;
    const roLabel = this._streamStatus.querySelector('.chat-stream-label');
    if (roLabel && !this._streamStatus.classList.contains('hidden')) {
      if (this._roTypingLabel !== label) { roLabel.textContent = label; this._roTypingLabel = label; }
      return;
    }
    this._roTypingLabel = label;
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> <span class="chat-stream-label">${escHtml(label)}</span>`;
    this._streamStatus.classList.remove('hidden');
  }

  _hideTyping() {
    this._typingSince = null; // watchdog disarm
    this._roTypingLabel = null;
    // The turn ended: the traffic can no longer grow, so every live age
    // FREEZES to its absolute span (a ticking "last 3s ago" on a finished turn
    // is a lie the user would read as progress).
    this._freezeCollab();
    if (this._chatInput) { this._chatInput.hideTyping(); return; }
    // readOnly fallback
    if (!this._streamStatus) return;
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
  }

  /**
   * Stop ticking and repaint every live surface in its frozen form.
   *
   * EVERY head that was painted live — never just the one the ticker happened
   * to touch (2026-09-07 r2, reproduced 2/2): a burst that started AND ended
   * while the window was hidden (desktop switch — start an orchestration,
   * switch desktop, come back) never ran a single tick, because _tickCollab is
   * a no-op while suspended; the renderer had still painted each coalescing
   * edit with `live: true`, so the card sat on "last 0s ago" forever on a turn
   * that ended minutes ago, contradicting the run header (whose liveness IS
   * captured in the fold pass, which runs while hidden). A freeze that depends
   * on the ticker having painted is not a freeze.
   */
  _freezeCollab() {
    this._stopCollabTick();
    this._lastRecordCollab = false;
    this._collabLabelShown = false;
    const now = Date.now();
    this._freezeStaleHeads(null, now);
    this._paintRunCollab(null, now);
  }

  _onGoalUpdated(goal, elapsed) {
    this._statusBar.setGoal(goal, elapsed);
  }

  // Long-running tool heartbeat (2.227.7) — the CLI streams elapsed seconds for
  // a tool that is still running. Renders as a plain "running · 2m30s" line on
  // the PENDING card; deliberately NOT the agent status line (no message count,
  // no View Log — a Bash call has no transcript to view; that mix-up is the bug
  // this replaced).
  _onToolProgress({ parentToolUseId, elapsedSeconds }) {
    if (!parentToolUseId) return;
    const pending = this._messageList?.querySelector(`[data-tool-id="${parentToolUseId}"]`);
    if (!pending) return;
    const card = pending.querySelector('.chat-tool-use') || pending;
    if (card.querySelector('.chat-agent-live-status')) return; // a real agent owns this card
    let el = card.querySelector('.chat-tool-progress');
    if (!el) {
      el = document.createElement('div');
      el.className = 'chat-tool-progress';
      const outputPending = card.querySelector('.chat-tool-output-pending');
      if (outputPending) outputPending.before(el); else card.appendChild(el);
    }
    const s = Number(elapsedSeconds);
    const human = !Number.isFinite(s) ? '' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
    el.textContent = human ? t('still running · {elapsed}', { elapsed: human }) : t('still running');
  }

  /** The tool ids the harness says are EXECUTING right now (§2.5, claude
   *  `set_in_progress_tool_use_ids`; caps.inProgressTools). Until this record
   *  existed a tool card span "pending" from the moment it was parsed —
   *  including the whole permission wait, where nothing is running at all.
   *  Set-based and idempotent: the record is a delta, this is the resolved set,
   *  so a reconnect that replays it lands on the same DOM. */
  _onToolsInProgress(ids) {
    if (!this._messageList) return;
    const want = new Set(Array.isArray(ids) ? ids : []);
    this._inFlightTools = want;
    for (const el of this._messageList.querySelectorAll('[data-tool-id]')) {
      el.classList.toggle('chat-tool-inflight', want.has(el.dataset.toolId));
    }
  }

  /** Compaction stage from the harness's own records. Held on the view so a
   *  card rendered LATER (or re-rendered) still shows the live stage instead of
   *  the generic apology.
   *
   *  ONE frame shape, two producers (§2.11): on 2.1.257 the frames come from
   *  `system/status` ({status:'compacting'} → compact_start, {status:null,
   *  compact_result} → compact_end), which is also the ONLY lane that sees an
   *  AUTO compaction — the one the user never typed /compact for. The declared
   *  `compact_progress` record feeds the same frames if a CLI ever emits one.
   *
   *  A compact_end is KEPT, not dropped: "how it ended" is the last true thing
   *  we know, and a card still on screen would otherwise silently fall back to
   *  the 1–2-minute apology the moment the compaction succeeded.
   *
   *  …but a HELD terminal stage belongs to the compaction it describes, not to
   *  the view forever. It is pushed into the cards that WATCHED the compaction
   *  (setCompactStage) and no further: a card BUILT later opens on the guidance
   *  again, because `compactInFlight()` is false. Without that split the first
   *  compaction of a view — including the AUTO one, which no user action
   *  precedes — silently replaced the actionable sentence every later "Prompt
   *  is too long" card exists to give. */
  _onCompactProgress(msg) {
    this._compactStage = {
      event: msg.event || '',
      hookType: msg.hookType || null,
      hint: msg.hint || null,
      result: msg.result || null,
      error: msg.error || null,
    };
    this._renderers?.setCompactStage?.(this._compactStage);
  }

  /** Replace a finished agent card's live activity with its终态 (2.233.1).
   *  Keeps the message count + View Log, drops the stale "responding". */
  _freezeAgentStatus(toolCallId, status) {
    if (!toolCallId || !this._messageList) return;
    const pending = this._messageList.querySelector(`[data-tool-id="${toolCallId}"]`);
    const statusEl = pending?.querySelector('.chat-agent-live-status');
    if (!statusEl) return;
    if (this._subagentDone) this._subagentDone.add(toolCallId);
    else this._subagentDone = new Set([toolCallId]);
    const countEl = statusEl.querySelector('.chat-agent-live-count');
    const n = this._subagentCounts?.get(toolCallId);
    const label = status === 'completed' ? t('finished') : String(status);
    if (countEl) countEl.textContent = `${n ? t('{n} messages', { n }) : ''}${n ? ' \u2022 ' : ''}${label}`;
    statusEl.classList.add('chat-agent-status-done');
  }

  _onSubagentMessage(parentToolUseId, msg) {
    if (!parentToolUseId) return;
    // Track message count for tool card status
    if (!this._subagentCounts) this._subagentCounts = new Map();
    this._subagentCounts.set(parentToolUseId, (this._subagentCounts.get(parentToolUseId) || 0) + 1);

    // Update pending Agent card status
    const pending = this._messageList.querySelector(`[data-tool-id="${parentToolUseId}"]`);
    if (pending) {
      // [data-tool-id] is the .chat-msg WRAPPER — the visual card is the inner
      // .chat-tool-use. Background agents complete the tool call instantly (no
      // .chat-tool-output-pending), so appending to the wrapper drew the status
      // line OUTSIDE the card. Always anchor inside the card.
      const card = pending.querySelector('.chat-tool-use') || pending;
      let statusEl = card.querySelector('.chat-agent-live-status');
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'chat-agent-live-status';
        const outputPending = card.querySelector('.chat-tool-output-pending');
        if (outputPending) outputPending.before(statusEl);
        else card.appendChild(statusEl);
      }
      const count = this._subagentCounts.get(parentToolUseId);
      // a card frozen by its completion wakeup stays frozen (a trailing
      // buffered message must not resurrect "responding")
      const frozen = this._subagentDone?.has(parentToolUseId);
      // Upgrade the header model chip to the model ACTUALLY serving this agent
      // (subagent assistant messages carry message.model) — the render-time chip
      // only knows the declared tool-input model, which may be absent/an alias.
      const servedModel = msg.message?.model;
      if (servedModel && !servedModel.startsWith('<')) {
        let chip = card.querySelector('.chat-tool-label .chat-agent-model');
        if (!chip) {
          const lbl = card.querySelector('.chat-tool-label');
          if (lbl) {
            chip = document.createElement('span');
            chip.className = 'chat-agent-model';
            const btn = lbl.querySelector('.chat-agent-view-btn');
            if (btn) btn.before(chip); else lbl.appendChild(chip);
          }
        }
        if (chip && chip.textContent !== servedModel) chip.textContent = servedModel;
      }
      // Detect activity from raw subagent message
      let activity = '';
      const c = msg.message?.content || msg.content;
      if (Array.isArray(c)) {
        const last = c[c.length - 1];
        if (last?.type === 'tool_use' || last?.type === 'tool_call') activity = t('running {tool}', { tool: toolDisplayName(last.name || last.toolName) || t('tool') });
        else if (last?.type === 'thinking') activity = t('thinking');
        else if (last?.type === 'text') activity = t('responding');
      }
      // Find description from stored messages
      const toolMsg = this._messages.find(m => m.toolCallId === parentToolUseId);
      const desc = toolMsg?.content?.[0]?.input?.description || '';
      const threadId = toolMsg?.taskInfo?.receiverThreadIds?.[0] || '';
      const threadAttr = threadId ? ` data-thread-id="${escHtml(threadId)}"` : ` data-parent-tool-id="${escHtml(parentToolUseId)}"`;
      // A completed Agent card already has a View Log button in its header \u2014
      // the live status line only adds one when the card has none (pending).
      const hasHeaderBtn = !!card.querySelector('.chat-tool-label .chat-agent-view-btn');
      const btnHtml = hasHeaderBtn ? '' : ` <button class="chat-agent-view-btn"${threadAttr} data-desc="${escHtml(desc)}">${t('View Log')}</button>`;
      const actPart = frozen ? ' \u2022 ' + escHtml(t('finished')) : (activity ? ' \u2022 ' + escHtml(activity) : '');
      statusEl.innerHTML = `<span class="chat-agent-live-count">${t('{n} messages', { n: count })}${actPart}</span>${btnHtml}`;
      if (frozen) statusEl.classList.add('chat-agent-status-done');
    }
  }

  /**
   * Open a codex sub-agent's own conversation from a collab row (B-7473).
   * In 0.153.4 the child's thread id rides SubAgentActivity, so the common
   * path needs NO server call. Older rollouts (and a spawn row seen before the
   * first activity item) fall back to GET /api/subagents, which walks the
   * local session tree for `source.subagent.thread_spawn`; a remote session's
   * children live on the OTHER machine, and the route says so rather than
   * pretending the sub-agent never existed.
   */
  async _openCollabAgent({ agentPath, threadId }) {
    const { backend, backendSessionId, host } = this._getSessionIds();
    const name = String(agentPath || '').split('/').filter(Boolean).pop() || '';
    if (threadId) { this._openSubagentViewer({ threadId, description: name || agentPath }); return; }
    if (!backendSessionId) { showToast(t('This sub-agent’s conversation is not on this machine.')); return; }
    const q = new URLSearchParams({ backend: backend || 'codex', threadId: backendSessionId });
    if (host) q.set('host', host);
    const r = await fetchJson(`/api/subagents?${q.toString()}`);
    if (r?.error) { showToast(r.error); return; }
    const list = Array.isArray(r?.subagents) ? r.subagents : [];
    const hit = list.find((s) => s.agentPath === agentPath)
      || (name ? list.find((s) => String(s.agentPath || '').endsWith('/' + name)) : null);
    if (!hit?.threadId) {
      track('codex-subagent-unresolved', { agent: String(agentPath || '').slice(0, 40), reason: r?.reason || 'not-found' });
      showToast(t('This sub-agent’s conversation is not on this machine.'));
      return;
    }
    this._openSubagentViewer({ threadId: hit.threadId, description: hit.nickname || name || agentPath, agentNickname: hit.nickname || '' });
  }

  // Unified subagent viewer: works for both live (parentToolUseId) and completed (agentId)
  _openSubagentViewer({ parentToolUseId, threadId, agentId, description, agentRole = '', agentNickname = '' }) {
    const { backend, backendSessionId, claudeId, cwd, host } = this._getSessionIds();
    if (backend === 'codex' && threadId) {
      const viewId = `view-${backend}-${threadId}`;
      if (!this._subagentViewers) this._subagentViewers = new Map();
      const existingWinId = this._subagentViewers.get(viewId);
      if (existingWinId && this.app.wm.windows.has(existingWinId)) {
        this.app.wm.focusWindow(existingWinId);
        return;
      }
      const winInfo = this.app.viewSession(threadId, cwd, description || agentNickname || agentRole || 'Agent', {
        backend,
        backendSessionId: threadId,
        agentKind: 'subagent',
        agentRole,
        agentNickname,
        sourceKind: 'subagent',
        parentThreadId: backendSessionId || null,
      });
      if (winInfo?.id) {
        this._subagentViewers.set(viewId, winInfo.id);
        const prevOnClose = winInfo.onClose;
        winInfo.onClose = () => {
          this._subagentViewers.delete(viewId);
          prevOnClose?.();
        };
      }
      return;
    }

    // Virtual session ID for subscribing to messages
    const virtualId = agentId ? `sub-agent-${agentId}` : `sub-${parentToolUseId}`;

    // Reuse existing viewer window if still open
    if (!this._subagentViewers) this._subagentViewers = new Map();
    const existingWinId = this._subagentViewers.get(virtualId);
    if (existingWinId && this.app.wm.windows.has(existingWinId)) {
      this.app.wm.focusWindow(existingWinId);
      return;
    }

    const title = `Agent: ${description || t('Subagent')}`;
    const openSpec = {
      action: 'viewSubagent',
      virtualId,
      parentSessionId: this.sessionId,
      backend,
      backendSessionId,
      claudeSessionId: claudeId,
      agentKind: 'subagent',
      agentRole,
      agentNickname,
      sourceKind: 'subagent',
      parentThreadId: backendSessionId || null,
      cwd,
      ...(host ? { hostId: host } : {}), // remote parent → agent transcript on the host
      description,
    };
    const winInfo = this.app.wm.createWindow({
      title,
      type: 'chat',
      openSpec,
      titleMeta: { backend, agentKind: 'subagent', agentRole, agentNickname, sourceKind: 'subagent', parentThreadId: backendSessionId || null },
    });
    this._subagentViewers.set(virtualId, winInfo.id);
    const view = new ChatView(winInfo, this.ws, virtualId, this.app, { readOnly: true });

    // Attach to virtual session — server returns history + sets up live forwarding
    this.ws.send({
      type: 'attach',
      sessionId: virtualId,
      parentSessionId: this.sessionId,
      backend,
      backendSessionId,
      claudeSessionId: claudeId,
      cwd,
      hostId: host || undefined,
    });

    // No reply at all (host wedged mid-fetch, ws message dropped): say the
    // viewer is still waiting rather than sitting blank forever.
    const attachWatchdog = setTimeout(() => {
      if (!this.app.wm.windows.has(winInfo.id) || view._disposed) return;
      if (view._messages?.length) return;
      view._renderers.appendSystem(t('Still loading this agent\'s transcript — the machine holding it may be slow or unreachable.'));
    }, 20000);

    // One-time handler for attach response — MUST self-guard (documented
    // invariant: closing the window mid-attach otherwise leaks the handler
    // and leaves a phantom viewer entry; same fix as app.js attachSession)
    const handler = (msg) => {
      if (!this.app.wm.windows.has(winInfo.id)) { this.ws.offGlobal(handler); return; }
      if (msg.type === 'error' && msg.sessionId === virtualId) {
        this.ws.offGlobal(handler);
        // Was pure cleanup: the read-only window stayed permanently BLANK.
        // Remote workflow agents (transcript pulled over ssh) hit this whenever
        // the host is slow/unreachable — the user learned nothing. Mirror
        // _viewIntoWindow and render the reason.
        clearTimeout(attachWatchdog);
        view._renderers.appendSystem(msg.message || t('Agent transcript could not be loaded.'));
        return;
      }
      if (msg.type === 'attached' && msg.sessionId === virtualId) {
        this.ws.offGlobal(handler);
        clearTimeout(attachWatchdog);
        if (msg.messages?.length) {
          view.loadHistory(msg.messages, msg.totalCount, msg.isStreaming);
        } else {
          // An empty 'attached' is the server's "found nothing" — a live agent
          // whose buffer is gone, or a remote fetch that failed and degraded to
          // an empty reply. Say so instead of rendering an empty window. The
          // server now distinguishes the two: msg.loadError carries the real
          // machine-side failure (2.272.1) instead of implying an empty log.
          view._renderers.appendSystem(msg.loadError || t('No transcript found for this agent.'));
        }
      }
    };
    this.ws.onGlobal(handler);

    winInfo.onClose = () => {
      clearTimeout(attachWatchdog);
      this._subagentViewers.delete(virtualId); view.dispose(); this.app._checkWelcome();
    };
  }

  _startReview({ target, delivery }) {
    if (!target || this._readOnly) return;
    this.ws.send({
      type: 'review-start',
      sessionId: this.sessionId,
      target,
      delivery: delivery || 'inline',
    });
  }

  _syncReviewAvailability() {
    const { backend } = this._getSessionIds();
    if (backend !== 'codex') return;
    const ready = this._messages.some((msg) => msg.role === 'assistant' && msg.status === 'complete');
    this._statusBar.setReviewEnabled(ready);
  }

  _startReadOnlyPolling() {
    if (!this._readOnly || !this.sessionId.startsWith('view-') || this._readOnlyPollTimer) return;
    const { backend } = this._getSessionIds();
    if (backend !== 'codex') return;
    const tick = async () => {
      if (this._disposed) return;
      // Hidden tab: 2s polling of a read-only view is pure waste — heartbeat
      // at 30s and catch up when visible again (sidebar poll pattern).
      if (document.hidden) { this._readOnlyPollTimer = setTimeout(tick, 30000); return; }
      try {
        const nextOffset = this._windowEnd || 0;
        const page = await this._fetchMessagePage(nextOffset, 200, { withStatus: true });
        const msgs = page.messages || [];
        if (page.chatStatus) this.applyStatus(page.chatStatus);
        if (page.taskState) this._applyTaskState(page.taskState);
        if (msgs.length) {
          this._loadingHistory = true;
          for (const msg of msgs) this._onCreateMessage(msg);
          this._loadingHistory = false;
          this._windowEnd = Math.min(this._total || (nextOffset + msgs.length), nextOffset + msgs.length);
          if (this._pinned) this._scrollToBottom();
        }
      } catch {}
      if (this._disposed) return;
      this._readOnlyPollTimer = setTimeout(tick, 2000);
    };
    this._readOnlyPollTimer = setTimeout(tick, 2000);
  }

  _applyTaskState(taskState) {
    const tasks = taskState?.tasks || {};
    this._statusBar.setTasks(tasks);
    // Re-arm running-workflow chips after attach/refresh: any Workflow result
    // in the loaded tail gets probed once — /api/workflow drops non-running
    // ones on the first poll, so finished runs never chip.
    for (const m of this._messages.slice(-60)) {
      if (m.toolName !== 'Workflow') continue;
      const out = m.content?.[0]?.output || '';
      const runId = out.match(/Run ID:\s*(wf_[\w-]+)/)?.[1];
      if (runId) this._statusBar.trackWorkflow(runId, m.content?.[0]?.input?.name || null);
    }

    const todos = Array.isArray(taskState?.todos) ? taskState.todos : [];
    if (this._chatInput) {
      this._chatInput.updateTodos(todos);
    } else {
      this._todos = todos;
      this._updateTodoDisplay();
    }

    this._statusBar.render();
  }


  // readOnly-only _updateTodoDisplay (for readOnly mode which doesn't have ChatInput)
  _updateTodoDisplay() {
    if (!this._todoDisplay) return;
    if (!this._todos?.length) { this._todoDisplay.classList.add('hidden'); return; }
    const inProgress = this._todos.find(t => t.status === 'in_progress');
    const completed = this._todos.filter(t => t.status === 'completed').length;
    const total = this._todos.length;
    if (!inProgress && completed === total) { this._todoDisplay.classList.add('hidden'); return; }
    const label = inProgress ? inProgress.activeForm || inProgress.content : t('{done}/{total} done', { done: completed, total });
    const icon = inProgress ? UI_ICONS.hourglass : UI_ICONS.check;
    this._todoDisplay.innerHTML = `<span class="chat-todo-current">${icon} ${escHtml(label)} <span class="chat-status-dim">(${completed}/${total})</span></span>`;
    this._todoDisplay.classList.remove('hidden');
  }

  applyStatus(status) {
    if (!status) return;
    this._statusBar.applyStatus(status);
    if (status.slashCommands && this._chatInput) {
      this._chatInput.setSlashCommands(status.slashCommands.map(c => c.startsWith('/') ? c : '/' + c));
    }
  }

  _scrollToBottom() {
    this._forceScrollToBottom();
  }

  // Drag-and-drop file/folder upload onto the chat → saved into the session's
  // working directory, with the path inserted into the input. (Editable views
  // only; the input button handles the mobile/click path.)
  _setupChatDrop(container) {
    const overlay = document.createElement('div');
    overlay.className = 'chat-drop-overlay hidden';
    const hintEl = document.createElement('div');
    hintEl.className = 'chat-drop-hint';
    overlay.appendChild(hintEl);
    // Reflect chat.uploadDir when set so the drop target is never a surprise.
    const refreshDropHint = () => {
      const dir = (this.app?.settings?.get('chat.uploadDir') || '').trim();
      hintEl.textContent = dir ? t('Drop to upload to {dir}', { dir }) : t('Drop to upload to the working directory');
    };
    refreshDropHint();
    this._refreshDropHint = refreshDropHint;
    container.appendChild(overlay);
    this._dropOverlay = overlay;
    const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    // Robust across browsers (incl. Safari, and OS/Finder file drags that never
    // fire dragend): `dragover` fires continuously while the cursor hovers, so
    // each one shows the overlay and pushes back a short hide timer. When
    // dragover STOPS firing — cursor left, drag cancelled, or it ended — the
    // timer hides it. This avoids `dragleave`/`relatedTarget` (unreliable in
    // Safari) and the dragenter/leave depth counter (unbalanced in Chrome,
    // which left the overlay stuck).
    this._dropHideTimer = null;
    const hide = () => { if (this._dropHideTimer) { clearTimeout(this._dropHideTimer); this._dropHideTimer = null; } overlay.classList.add('hidden'); };
    container.addEventListener('dragenter', (e) => { if (isFileDrag(e)) e.preventDefault(); });
    container.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      this._refreshDropHint?.();
      overlay.classList.remove('hidden');
      if (this._dropHideTimer) clearTimeout(this._dropHideTimer);
      this._dropHideTimer = setTimeout(hide, 150);
    });
    container.addEventListener('drop', async (e) => {
      hide();
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const files = await this._collectDroppedFiles(e.dataTransfer);
      if (files.length && this._chatInput) this._chatInput.uploadFiles(files);
    });
  }

  // Collect dropped files, recursing into directories (DataTransferItem entries
  // must be read synchronously before the first await), tagging each File with
  // its relative path so folder trees are recreated under the cwd.
  async _collectDroppedFiles(dt) {
    return collectDroppedFiles(dt); // shared with the file explorer (utils.js)
  }

  // Re-attach to session after reconnect: re-register with server + sync missed messages
  _reattach(keepDisabled = false) {
    // Read-only windows (view-history, terminated, rescued) have nothing to
    // re-attach — a bare attach of a view-/dead id just errors (2.219.0 audit)
    if (this._readOnly) return;
    // Keep input disabled until server confirms re-attach — prevents
    // sending messages before the WS is registered in session.clients
    if (keepDisabled && this._chatInput) this._chatInput.setDisconnected(true);

    // Snapshot the epoch BEFORE re-attaching: the permanent handler stores the
    // fresh epoch as soon as 'attached' arrives, so comparing against
    // this._normEpoch inside the temp handler would always match.
    const epochBefore = this._normEpoch;

    // Re-attach so server adds this WS to session.clients again
    this.ws.send({ type: 'attach', sessionId: this.sessionId });
    // NO-REPLY fallback (REWRITTEN 2.234.1, userL's mass false-death
    // incident): the old one-shot 20s timer declared "session no longer
    // exists (likely a restart)" on ANY slow reply — but a degraded server
    // (event-loop spikes, remote transcript pulls, MB-scale attach bursts on
    // reload) can lawfully take longer while every session is alive, and the
    // flip turned "slow" into what looked like mass session death across ~8
    // windows. Now: a RETRY ladder — re-send the attach while the server
    // hasn't even ACKED it (the 2.234.1 'attach-ack' lands synchronously, so
    // its absence means the attach may never have arrived); once acked, just
    // wait (server alive, processing). Flip read-only only after ~2 minutes,
    // with a message that says the truth: timeout ≠ dead — the old certainty
    // is reserved for the explicit not-found error path.
    const reattachAt = Date.now();
    this._reattachGen = (this._reattachGen || 0) + 1;
    const gen = this._reattachGen;
    let waits = 0;
    const checkOrRetry = () => {
      if (gen !== this._reattachGen) { this.ws.offGlobal(handler); return; } // superseded by a newer reconnect cycle (which armed its own handler)
      if (this._readOnly || this._disconnected) { this.ws.offGlobal(handler); return; } // resolved / offline (next reconnect restarts the ladder)
      if ((this._lastAttachedAt || 0) >= reattachAt) return; // attached — done (the handler self-removed when it ran)
      const acked = (this._lastAttachAckAt || 0) >= reattachAt;
      // A FRESH ack (the server re-acks every 10s while this session waits
      // in / runs its history rebuild, 2.369.16) is proof of life — keep
      // waiting instead of counting toward the flip, up to 15 minutes.
      const freshAck = acked && Date.now() - this._lastAttachAckAt < 30000 && Date.now() - reattachAt < 15 * 60000;
      if (!freshAck) waits++;
      if (waits < 5) {
        if (!acked) this.ws.send({ type: 'attach', sessionId: this.sessionId });
        setTimeout(checkOrRetry, 25000);
        return;
      }
      this.ws.offGlobal(handler);
      this._hideTyping();
      if (this._tryViewOnlyRescue()) return;
      this._renderers.appendSystem(acked
        ? t('The server is alive but did not finish re-attaching in time — the session is likely STILL RUNNING. Reload the tab, or Resume (resuming a live session reconnects to it, never starts a duplicate).')
        : t('The server did not answer the re-attach — it may have restarted. If the session is still running, Resume reconnects to it.'));
      this._setReadOnly();
    };
    setTimeout(checkOrRetry, 20000);

    // Wait for attached response before re-enabling input
    const handler = (msg) => {
      if (msg.type !== 'attached' || msg.sessionId !== this.sessionId) return;
      this.ws.offGlobal(handler);
      if (gen !== this._reattachGen) return; // a newer reconnect cycle owns the view now
      if (this._chatInput) this._chatInput.setDisconnected(false);
      // Server normalizer was REBUILT (server restart): message IDs are a
      // plain per-normalizer counter, so the new numbering collides with what
      // we've already rendered — incremental catch-up would silently DROP new
      // messages (false dedup in _renderedMsgIds) and corrupt indices. The
      // only safe move is a full view reload from the attach payload.
      // UNKNOWN prior epoch (createSession-born window that never saw an
      // 'attached') counts as changed — incremental catch-up against a
      // possibly-rebuilt normalizer silently drops messages (2.219.0 audit)
      const epochChanged = msg.normEpoch && msg.normEpoch !== epochBefore;
      if (msg.normEpoch) this._normEpoch = msg.normEpoch;
      if (epochChanged) {
        // STAGGERED (2.338.0): after a server restart EVERY chat window used
        // to wipe + re-render its 50-message tail in the same tick — N
        // synchronous marked+DOMPurify passes back-to-back froze the page.
        // A 0-500ms jitter splits them into separate tasks; the DOM wipe
        // happens inside _fullViewReset so nothing is torn meanwhile.
        setTimeout(() => { if (!this._disposed) this._fullViewReset(msg); }, Math.random() * 500);
        return;
      }
      // Sync streaming label from server
      if (msg.isStreaming) this._onServerStreamLabel(msg.streamingLabel || t('thinking...'), msg.streamingKind || null);
      else this._hideTyping();
      this._reattachCatchUp();
    };
    this.ws.onGlobal(handler);
    // Safety: re-enable INPUT after 30s even if attached never arrives. The
    // handler itself must stay armed for the whole retry-ladder window — an
    // 'attached' landing between 30s and the ~2min deadline used to be
    // half-processed (the ladder saw _lastAttachedAt and stood down, but the
    // catch-up / epoch full-reset never ran → silently stale view; B-b87b).
    // The ladder's terminal paths remove the handler instead.
    setTimeout(() => {
      if (this._chatInput) this._chatInput.setDisconnected(false);
    }, 30000);
  }

  // Same-epoch reconnect: fetch just the messages we missed while offline
  _reattachCatchUp() {
    const missedStart = this._windowEnd;
    // same stagger rationale as the epoch reset above — N windows × 200
    // messages rendered in one tick is the non-restart reconnect freeze
    this._fetchMessages(missedStart, 200).then(msgs => new Promise((res) => setTimeout(() => res(msgs), Math.random() * 400))).then(msgs => {
      if (!msgs.length) return;
      this._loadingHistory = true;
      for (const msg of msgs) this._onCreateMessage(msg);
      this._loadingHistory = false;
      // Keep the window accounting in sync: _fetchMessages silently updated
      // _total from the server, but _windowEnd previously stayed stale — the
      // rendered window then held more messages than [start,end) claimed, so
      // the minimap thumb, position indicator, and every index-based jump
      // (search + minimap) were off by the missed count after a reconnect.
      this._windowEnd = missedStart + msgs.length;
      // Server totals can move across a restart (e.g. dedup changes) — clamp so
      // the window accounting never overshoots (_windowEnd > _total broke the
      // at-bottom checks and the pos indicator).
      if (this._total && this._windowEnd > this._total) this._windowEnd = this._total;
      this._total = Math.max(this._total, this._windowEnd);
      this._chatMinimap.setViewport(this._windowStart, this._windowEnd, this._total);
      this._updatePosIndicator();
      // Missed user turns also belong on the minimap
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.role === 'user') this._chatMinimap.addTurn({ turnIndex: m.turnIndex, startIdx: missedStart + i, ts: m.ts, role: 'user' }, this._total);
      }
      if (this._search?.hasHighlight) this._search.applyHighlightLayer();
      if (this._pinned) this._scrollToBottom();
    }).catch(() => {
      // Was a bare swallow: the catch-up is exactly the fetch that fills in
      // what happened while the socket was down, so eating its failure leaves
      // a view that looks complete but silently isn't.
      if (this._disposed) return;
      this._showHistoryStatus(t('Couldn\'t load messages received while offline'), {
        kind: 'error', retry: () => this._reattachCatchUp(),
      });
    });
  }

  // Server-restart reload: rebuild the whole view from the fresh attach
  // payload (new ID space, new totals). Position resets to the live tail —
  // predictable, and beats silently frozen messages.
  _fullViewReset(msg) {
    this._messageList.querySelectorAll('.chat-msg, .chat-msg-system').forEach(el => el.remove());
    this._resetGapAfterJump();
    this._elements.clear();
    this._renderedMsgIds.clear();
    this._messages = [];
    this._newMsgCount = 0;
    // The attach payload IS the meta — never re-copy it key by key (a hand-
    // maintained list silently dropped outputStyle/autoResume on the sibling
    // attach path; the whitelist-drift class, 2.368.4).
    this.loadHistory(msg.messages || [], msg.totalCount || 0, msg.isStreaming, msg);
  }

  _clearWaiting() {
    if (this.winInfo.element.classList.contains('window-waiting')) {
      this.winInfo.element.classList.remove('window-waiting');
      if (this.winInfo._notifyChanged) this.winInfo._notifyChanged();
    }
  }

  focus() {
    if (this._chatInput) this._chatInput.focus();
    this._clearWaiting();
  }

  // Minimap extracted to ChatMinimap class (src/lib/chat-minimap.js)

  _updatePosIndicator() {
    if (!this._posIndicator || !this._total) return;
    // Teleport mode browses by file position; the window-index numbers are stale
    // and misleading — the minimap thumb communicates position instead.
    if (this._teleported || (this._pinned && this._windowEnd >= this._total)) {
      this._posIndicator.classList.add('hidden');
      return;
    }
    this._posIndicator.textContent = `${this._windowStart + 1}\u2013${this._windowEnd} / ${this._total}`;
    this._posIndicator.classList.remove('hidden');
  }

  // Convert to read-only mode (after session terminate/exit)
  _setReadOnly() {
    this._readOnly = true;
    if (this._chatInput) this._chatInput.setReadOnly();
    this._showResumeBar();
  }

  /** A per-session `error` frame. TWO meanings, and conflating them is a
   *  shipped incident in both directions: a SCOPED refusal (one action denied,
   *  session alive) renders in chat and leaves the view untouched, while an
   *  attach failure rescues into the read-only history + Resume bar. */
  _onSessionError(msg) {
    // SEND refusal ≠ attach failure (inc-mt2arppw, userW: every too-large
    // paste flipped the LIVE window into the Resume bar — the session was
    // never broken, and the refusal text rode msg.error which this branch
    // never read, so the user saw a dead-looking window with no reason).
    if (isScopedRefusal(msg)) {
      this._hideTyping();
      // A refused LIVE style switch can be a FACT about this session: only
      // 'style-wrapper-old' means THIS wrapper will never serve the verb, so
      // only it flips the flag — the chip's menu then offers the restart row
      // and keeps the saved pick visible as pending instead of swallowing the
      // choice (2.369.58). 'style-not-live' covers transient/other reasons (a
      // sidecar not written yet, a dead session) and must change no belief.
      if (msg.code === 'style-wrapper-old') this._statusBar?.setResponseStyleLive?.(false);
      // A QUEUE-OP refusal from the ws layer never becomes a `queue-result`
      // meta op (the wrapper never saw the frame), so the row the strip marked
      // pending had no way back — it spun forever (round-2 verifier). The
      // refusal echoes the op's own `id` for exactly this join; an id-less
      // batch verb ends every pending row, which is what setQueueOpResult('')
      // already means.
      if (msg.code === 'queue-op-unsupported') { try { this._chatInput?.setQueueOpResult(msg.id || '', false, msg.message || msg.error || ''); } catch { } }
      this._renderers.appendSystem('✗ ' + (msg.message || msg.error || t('Message rejected.')));
      try { track('event', msg.code === 'input-rejected' ? 'chat-input-rejected' : 'chat-action-refused', this._telemDetail(`${msg.code || 'action'}: ${msg.message || msg.error || ''}`)); } catch {}
      return;
    }
    // Attach failed (e.g. stale serverId replayed from a saved layout, or
    // 'ended-during-attach': the session died while its history was loading).
    // If NOTHING is rendered yet and the identity is known, rescue into
    // the view-only pipeline (saved history + Resume bar) — after an OOM
    // kill / pod recreation every window replays a dead serverId, and
    // read-only-ing the empty pane opened 12 BLANK windows at once (real
    // fleet report). Only when even that can't work, show the bare error.
    this._hideTyping();
    if (!this._tryViewOnlyRescue()) {
      this._renderers.appendSystem(msg.message || msg.error || t('Session not found.'));
      this._setReadOnly();
    }
    try { track('event', 'chat-attach-failed', this._telemDetail(msg.message)); } catch {}
  }

  // Attach failed for a window that never rendered anything — flip it into
  // the view-only pipeline IN PLACE: the same server path viewSession uses
  // (JSONL history from the local transcript or the remote-jsonl cache — the
  // cache scan is host-less-tolerant and stale-cache-beats-no-history, so it
  // works even with the session's host machine down), then the Resume bar.
  // Without this, every layout replay after the server lost its sessions
  // (OOM kill, pod recreation) opened BLANK read-only windows.
  _tryViewOnlyRescue() {
    if (this._rescueTried || this._readOnly) return false;
    if (this.sessionId.startsWith('view-') || this.sessionId.startsWith('sub-')) return false;
    if (this._total > 0 || this._elements.size > 0) return false;
    const ids = this._getSessionIds() || {};
    const bsid = ids.backendSessionId;
    // needs the REAL backend id — a webui `sess-N` placeholder has no transcript
    if (!bsid || /^sess-\d/.test(bsid)) return false;
    this._rescueTried = true;
    const backend = ids.backend || 'claude';
    const viewId = backend === 'claude' ? `view-${bsid}` : `view-${backend}-${bsid}`;
    const handler = (msg) => {
      if (this._disposed) { this.ws.offGlobal(handler); return; }
      if (msg.sessionId !== viewId) return;
      if (msg.type === 'error') {
        this.ws.offGlobal(handler);
        this._renderers.appendSystem(msg.message || t('Session not found.'));
        this._setReadOnly();
        return;
      }
      if (msg.type !== 'attached') return;
      this.ws.offGlobal(handler);
      // History ops (pagination, search, resume) resolve identity through
      // _getSessionIds/openSpec — nothing addresses the dead server id anymore.
      this.sessionId = viewId;
      if (msg.messages?.length) this.loadHistory(msg.messages, msg.totalCount, false, { chatStatus: msg.chatStatus });
      else this._renderers.appendSystem(t("No messages in this session's transcript yet."));
      this._renderers.appendSystem(t('The session is no longer running — showing saved history.'));
      this._setReadOnly();
    };
    this.ws.onGlobal(handler);
    this.ws.send({
      type: 'attach', sessionId: viewId, viewOnly: true, backend,
      backendSessionId: bsid, claudeSessionId: backend === 'claude' ? bsid : undefined,
      host: ids.host || undefined, cwd: ids.cwd || '', name: this.winInfo?.title || '',
    });
    try { track('event', 'chat-attach-rescued'); } catch {}
    return true;
  }

  // Insert a Resume bar in place of the input area for stopped/view-only/terminated
  // chat windows. Subagent viewers (sub-*) can't be resumed, so they're skipped.
  _showResumeBar() {
    if (this._resumeBar || this.sessionId.startsWith('sub-')) return;
    const container = this._container;
    if (!container) return;
    if (this._subagentView) {
      // Say WHY there is no input instead of offering a Resume that would be
      // wrong (no-silent-state rule) — a note, no button.
      const bar = document.createElement('div');
      bar.className = 'chat-resume-bar chat-subagent-note';
      const note = document.createElement('div');
      note.className = 'chat-resume-note';
      note.textContent = t('Sub-agent conversation — read-only. It ran inside its parent session; resume the parent to continue.');
      bar.append(note);
      if (this._statusBar?.element && this._statusBar.element.parentNode === container) container.insertBefore(bar, this._statusBar.element);
      else container.appendChild(bar);
      this._resumeBar = bar;
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'chat-resume-bar';
    const btn = document.createElement('button');
    btn.className = 'chat-resume-btn';
    btn.innerHTML = `${UI_ICONS.refresh} <span>${t('Resume this session')}</span>`;
    btn.title = t('Resume the session and continue chatting');
    btn.onclick = () => this._resumeAndClose();

    const note = document.createElement('div');
    note.className = 'chat-resume-note';
    note.textContent = t('Session is read-only.');

    bar.append(note, btn);
    // Insert before status bar (which is the last child)
    if (this._statusBar?.element && this._statusBar.element.parentNode === container) {
      container.insertBefore(bar, this._statusBar.element);
    } else {
      container.appendChild(bar);
    }
    this._resumeBar = bar;
  }

  // Retry-past-the-breaker bar (2.227.3): the no-transcript breaker is a
  // GUESS ("the CLI looked and didn't find it"), so the user always gets a
  // way through instead of a dead end — no-silent-failure rule, applied to
  // dead-END failures too.
  _showRetryResumeBar(onRetry) {
    if (this._resumeBar) this._resumeBar.remove();
    this._resumeBar = null;
    const container = this._container;
    if (!container) return;
    const bar = document.createElement('div');
    bar.className = 'chat-resume-bar';
    const note = document.createElement('div');
    note.className = 'chat-resume-note';
    note.textContent = t('Resume was paused after a failed attempt — you can try again.');
    const btn = document.createElement('button');
    btn.className = 'chat-resume-btn';
    btn.innerHTML = `${UI_ICONS.refresh || ''} <span>${t('Try resuming anyway')}</span>`;
    btn.onclick = () => { btn.disabled = true; try { onRetry?.(); } finally { this.app.wm?.closeWindow?.(this.winInfo?.id); } };
    bar.append(note, btn);
    if (this._statusBar?.element && this._statusBar.element.parentNode === container) container.insertBefore(bar, this._statusBar.element);
    else container.appendChild(bar);
    this._resumeBar = bar;
  }

  // Show login bar when session exits due to expired/missing OAuth token
  _showLoginBar() {
    if (this._resumeBar) this._resumeBar.remove();
    this._resumeBar = null;
    const container = this._container;
    if (!container) return;

    const bar = document.createElement('div');
    bar.className = 'chat-resume-bar chat-login-bar';

    const note = document.createElement('div');
    note.className = 'chat-resume-note';
    note.textContent = t('Claude CLI is not logged in. Open a terminal to run /login, then retry.');

    const loginBtn = document.createElement('button');
    loginBtn.className = 'chat-resume-btn';
    loginBtn.innerHTML = `${UI_ICONS.wrench} <span>${t('Open Login Terminal')}</span>`;
    loginBtn.onclick = () => {
      // Open a terminal window running claude (user can /login there)
      const ids = this._getSessionIds();
      const cwd = ids.cwd || this.winInfo?._openSpec?.cwd || '';
      this.app.createSession({ cwd, mode: 'terminal', backend: ids.backend || 'claude' });
    };

    const retryBtn = document.createElement('button');
    retryBtn.className = 'chat-resume-btn';
    retryBtn.innerHTML = `${UI_ICONS.refresh} <span>${t('Retry')}</span>`;
    retryBtn.onclick = () => this._resumeAndClose();

    bar.append(note, loginBtn, retryBtn);
    if (this._statusBar?.element && this._statusBar.element.parentNode === container) {
      container.insertBefore(bar, this._statusBar.element);
    } else {
      container.appendChild(bar);
    }
    this._resumeBar = bar;
  }

  _resumeAndClose() {
    const ids = this._getSessionIds();
    const backend = ids.backend || 'claude';
    const backendSessionId = ids.backendSessionId || this.winInfo?.backendSessionId || null;
    const cwd = ids.cwd || this.winInfo?._openSpec?.cwd || this.winInfo?.cwd || '';
    if (!backendSessionId || !cwd) {
      // NEVER a silent no-op (user directive 2026-07-25: every resume failure
      // must reach the frontend — a dead click reads as a VibeSpace bug).
      showToast(t('Cannot resume from this window — session identity is incomplete. Use the session card in the sidebar instead.'), { type: 'error' });
      this.app.sidebar?.refresh?.();
      return;
    }
    const customName = this.app.sidebar?.getCustomName?.(backendSessionId);
    const name = customName || this.winInfo?.name || this.winInfo?.titleMeta?.name || 'Session';
    const winId = this.winInfo?.id;
    this.app.resumeSession(backendSessionId, cwd, name, {
      mode: 'chat',
      backend,
      backendSessionId,
      // remote sessions resume ON their host — omitting this spawned a LOCAL
      // `claude --resume <remote-id>` (wrong machine, double-writer class)
      hostId: ids.host || undefined,
      agentKind: this.winInfo?.titleMeta?.agentKind,
      agentRole: this.winInfo?.titleMeta?.agentRole,
      agentNickname: this.winInfo?.titleMeta?.agentNickname,
      sourceKind: this.winInfo?.titleMeta?.sourceKind,
    });
    // Close the read-only window — the resumed session opens in a new window
    if (winId) this.app.wm?.closeWindow?.(winId);
  }

  // Billing identity chip in the status bar (fed by app.syncSessionIdentity,
  // mobile only — desktop shows the same identity in the window title bar).
  setBillingIdentity(auth, onSwitch) {
    this._statusBar?.setBilling?.(auth, onSwitch);
  }

  // ── Consecutive thinking/Bash run collapse (chat.collapseRuns) ──
  // Decoration-only pass: adjacent thinking/Bash cards get a "N × …" header
  // and the members hide behind it (any Bash folds immediately, pure-thinking
  // needs ≥2). Nothing is reparented and headers don't match .chat-msg, so
  // virtual-scroll trims, index→element mapping and gap-seek are untouched.
  // HIDDEN cards (empty thinking under chat.hideEmptyThinking, hook cards
  // under chat.showHookCards=false) are TRANSPARENT: they neither count
  // toward the threshold nor break adjacency of the visible cards around
  // them — without this, invisible empty-thinking stubs wedged between real
  // cards silently broke every run. An open search bar expands everything
  // (search reveal must be able to scroll to any member).
  // ── Viewport-anchored mutation (the scroll-jump root fix, 2.111.5) ──
  // scrollHeight-DELTA compensation is mathematically wrong under
  // content-visibility:auto: freshly inserted off-screen elements measure at
  // their ~80px ESTIMATE while trimmed ones had REAL heights, so the delta
  // can even go NEGATIVE — the tracer caught insert-50/trim-50 shrinking
  // scrollHeight by 312px, the compensation clamping scrollTop to 0, and the
  // top sentinel then load-looping at the clamp (the reported 乱跳+翻不回来).
  // Anchor the topmost visible element instead: its offsetTop delta IS the
  // ground truth in the same units the browser scrolls by.
  _withViewportAnchor(fn) {
    const list = this._messageList;
    const st = list.scrollTop;
    let el = null, delta = 0;
    // Run headers/footers are DESTROYED and rebuilt by any _updateRuns pass
    // that fn may run — anchoring on one meant a dead anchor and the
    // estimate-skewed delta fallback. Members only get class-toggled: stable.
    const runChrome = (c) => c.classList.contains('chat-run-header') || c.classList.contains('chat-run-footer');
    if (st > 0) {
      for (const c of list.children) {
        if (runChrome(c)) continue;
        if (c.offsetHeight > 0 && c.offsetTop + c.offsetHeight > st) { el = c; delta = c.offsetTop - st; break; }
      }
      // ALL children content-visibility-collapsed (offsetHeight 0) — their
      // offsetTop is still valid layout truth, so anchor on position alone
      // rather than giving up to the estimate-skewed delta fallback
      if (!el) {
        for (const c of list.children) {
          if (runChrome(c)) continue;
          if (c.offsetTop + c.offsetHeight >= st) { el = c; delta = c.offsetTop - st; break; }
        }
      }
    } else if (list.children.length) {
      // AT THE TOP EDGE (inc-mso818ry): st===0 captured NO anchor at all, so
      // every extendTop while sitting at the top landed un-anchored and
      // clamped into the fresh batch. The previously-first message IS the
      // anchor — after the insert it scrolls back to the top edge, which is
      // exactly where the reader's eyes were.
      el = list.children[0]; delta = 0;
    }
    fn();
    if (el && el.isConnected) {
      let a = el;
      if (a.offsetParent === null) {
        // anchor got FOLDED by a run-collapse pass inside fn (much likelier
        // since 2.213.0 widened the collapsible kinds) — restore on the
        // nearest visible neighbor: the run header sits exactly where the
        // folded content was (same strategy as _updateRuns' own restore)
        let prev = a.previousElementSibling;
        while (prev && prev.offsetParent === null) prev = prev.previousElementSibling;
        let next = null;
        if (!prev) { next = a.nextElementSibling; while (next && next.offsetParent === null) next = next.nextElementSibling; }
        a = prev || next;
        if (a) { this._traceExpect?.(); list.scrollTop = a.offsetTop; return true; }
        return false;
      }
      this._traceExpect?.();
      list.scrollTop = a.offsetTop - delta;
      return true;
    }
    return false;
  }

  // Scroll tracer v2 (2.264.0, B-21bc — user request: 汇报问题时自动带上).
  // The 2.111.8 removal stubbed these out, which left incident reports BLIND
  // to viewport-jump bugs (B-21bc arrived with zero scroll evidence and even
  // the documented Ctrl+Shift+J dump was dead). Now an ALWAYS-ON in-memory
  // ring: the pre-existing `_trace()` breadcrumbs (extendTop/extendBottom/
  // trim/jump/runsRestore) re-arm for free, plus a coarse scroll sampler
  // below. Positions and op tags only — never message content. The incident
  // reporter ships each chat window's ring tail automatically (snapshot
  // `chatTraces` in incident-recorder.js). Cost: one compare per scroll event
  // + tiny objects in a capped ring.
  _trace(tag, data) {
    const r = this._traceRing || (this._traceRing = []);
    r.push(data ? { t: Date.now(), tag, ...data } : { t: Date.now(), tag });
    if (r.length > 400) r.splice(0, r.length - 250);
  }
  _traceExpect() {}
  _installScrollTracer() {
    let last = 0;
    this._messageList.addEventListener('scroll', () => {
      const st = this._messageList.scrollTop;
      if (Math.abs(st - last) < 400) return; // coarse: only real moves, not per-frame noise
      this._trace('scroll', {
        from: Math.round(last), to: Math.round(st),
        pin: this._pinned ? 1 : 0,
        // key discriminator for B-21bc: a big move with NO recent user
        // wheel/touch is a programmatic yank
        wheelAgo: this._lastUserScrollAt ? Date.now() - this._lastUserScrollAt : -1,
      });
      last = st;
    }, { passive: true });
  }

  // Re-render every rendered message in place — for mode toggles that change
  // the per-message DOM STRUCTURE (compact mode builds a different wrapper in
  // wrapMsg at render time). Gap-loaded (.chat-gap-msg) elements aren't in
  // _elements and keep the old structure until reloaded — accepted (rare
  // mid-history toggle). Run open/closed memory transfers across the swap.
  _rerenderVisible() {
    if (!this._elements || this._disposed) return;
    for (const [id, oldEl] of [...this._elements]) {
      const msg = oldEl._rawMsg;
      if (!msg || !oldEl.isConnected) continue;
      let newEl = null;
      try {
        switch (msg.role) {
          case 'user': newEl = this._renderers.renderUserMsg(msg); break;
          case 'tool': newEl = this._renderers.renderToolMsg(msg); break;
          case 'assistant': newEl = this._renderers.renderAssistantMsg(msg); break;
          default: { const r = this._renderers.renderSystemMsg(msg); newEl = r?.el || null; break; }
        }
      } catch {}
      if (!newEl) continue;
      newEl.dataset.msgId = id;
      if (msg.ts) newEl.dataset.ts = msg.ts;
      if (oldEl.dataset.line) newEl.dataset.line = oldEl.dataset.line;
      if (this._runExpanded?.has(oldEl)) this._runExpanded.add(newEl);
          if (this._runStickyOpen?.has(oldEl)) this._runStickyOpen.add(newEl); // the user's deliberate-open mark rides the swap too (verifier: a full re-render otherwise let the pinned auto-refold snap it shut)
      this._applyElementMarks(newEl, msg);
      oldEl.replaceWith(newEl);
      this._elements.set(id, newEl);
      this._renderers.addWrapToggles(newEl);
      this._renderers.addOpenInEditorBtn(newEl);
    }
    this._updateRuns();
  }

  _updateRuns() {
    const list = this._messageList;
    if (!list || this._disposed) return;
    const enabled = this.app?.settings?.get('chat.collapseRuns') !== false;
    const searchOpen = this._search?._bar && !this._search._bar.classList.contains('hidden');
    // Viewport anchor: collapsing/expanding runs ABOVE the viewport shifts
    // everything the user is reading — the debounced observer pass lands
    // ~180ms AFTER _extendTop's scroll compensation, so freshly loaded Bash
    // cards folded, the view jumped and the top sentinel re-triggered another
    // load in a loop (real report: 往上翻阅跳动+翻不回来). Keep the topmost
    // visible element fixed across the pass. Skip when pinned (bottom-follow
    // owns the scroll) and skip run headers/footers (removed by the pass).
    let anchorEl = null, anchorDelta = 0;
    if (!this._pinned && list.scrollTop > 0) {
      const st = list.scrollTop;
      for (const el of list.children) {
        if (el.classList.contains('chat-run-header') || el.classList.contains('chat-run-footer')) continue;
        if (el.offsetTop + el.offsetHeight > st) { anchorEl = el; anchorDelta = el.offsetTop - st; break; }
      }
    }
    this._runsMutating = true;
    try {
      list.querySelectorAll(':scope > .chat-run-header, :scope > .chat-run-footer').forEach((h) => h.remove());
      list.querySelectorAll(':scope > .chat-run-collapsed, :scope > .chat-run-member').forEach((el) => el.classList.remove('chat-run-collapsed', 'chat-run-member', 'chat-run-first', 'chat-run-last'));
      // run bookkeeping (headers ↔ members ↔ footer) — rebuilt every pass; the
      // floating run bar (_updateRunBar) reads it, never the DOM tree
      this._runs = [];
      this._runBarRun = null;
      if (!enabled || searchOpen) return;
      // ENABLED kinds count as ONE collapsible group — the TUI folds the
      // interleaved think→read→edit→run noise as a single group (user
      // directive; same-kind-only grouping never reached its threshold in
      // real turns). Which kinds participate is configurable since 2.213.0
      // (chat.collapseKinds: thinking/bash/read/write).
      const hideEmptyThink = this.app?.settings?.get('chat.hideEmptyThinking') !== false;
      const hooksHidden = document.body.classList.contains('hide-hook-cards');
      const kindsArr = this.app?.settings?.get('chat.collapseKinds');
      const kinds = new Set(Array.isArray(kindsArr) ? kindsArr : ['thinking', 'bash', 'read', 'memory', 'mcp', 'agent', 'search', 'image']);
      // per-member classification (also used by flush() for the summary) —
      // the PURE classifier in chat-run-summary.js (semantic collapseKind hint
      // first, claude tool-name map as the fallback; pinned by test-fold-ux)
      const memberKind = (el) => messageKind(el._rawMsg, { toolCard: el.classList.contains('chat-msg-tool-result'), isMemoryPath });
      const kindOf = (el) => {
        if (!el.classList?.contains('chat-msg') || el.classList.contains('chat-gap-msg')) return null;
        // display:none'd cards are invisible glue — 'skip' (never break a run)
        if (hideEmptyThink && el.classList.contains('chat-empty-thinking')) return 'skip';
        if (hooksHidden && el.classList.contains('chat-msg-hook')) return 'skip';
        const m = el._rawMsg;
        if (!m) return null;
        // A card waiting for the user's Allow/Deny (or an AskUserQuestion
        // answer) must stay visible — folding it hides the approval buttons
        // and the turn stalls unnoticed (real report). Returning null also
        // BREAKS the run so the surrounding fold can't swallow it.
        if (m.permission && !m.permission.resolved) return null;
        // pending/running cards collapse too (user directive — the bottom
        // streaming indicator already shows live activity)
        const mk = memberKind(el);
        // 'lookup' (ToolSearch) rides the MCP toggle — it folds with its
        // neighbours exactly as before, only the summary line is honest now
        return mk && kinds.has(foldToggleFor(mk)) ? 'noise' : null;
      };
      // Collapsed-summary file names: basename, with agent-memory files
      // distinguished as memory/<name> (user ask: 区分项目文件和memory).
      // A codex apply_patch can touch SEVERAL files (input.files, parsed from
      // the patch envelope by the normalizer) — list them all.
      const fileLabelsOf = (el) => {
        const inp = el._rawMsg?.content?.[0]?.input || {};
        const list = Array.isArray(inp.files) && inp.files.length ? inp.files : (inp.file_path ? [inp.file_path] : []);
        return list.map((fp) => {
          const base = String(fp).split('/').pop();
          return isMemoryPath(fp) ? 'memory/' + base : base;
        });
      };
      const kids = [...list.children];
      const built = []; // runs constructed this pass (for pinned auto-refold)
      let run = [];
      let runKind = null;
      const flush = () => {
        // the newest message stays visible — live activity must not vanish
        const members = run; // the newest message collapses too (user directive)
        // A run containing ANY tool card collapses immediately — even a single
        // one (user directive: "看到 bash 直接开始折叠, 无论多少条"; a lone tool
        // card still shrinks several lines → one). Pure-thinking runs need ≥2
        // so a lone thought stays inline.
        const hasTool = members.some((el) => el.classList.contains('chat-msg-tool-result'));
        // THE IMAGE MEMBER IS EXEMPT, NOT THE RUN (image-card review round 2, 2026-09-06).
        // An image the owner asked to SEE must not vanish into "1 image read"
        // (2.369.48): 'image' ships ON in chat.collapseKinds and the rule above
        // folds a LONE tool card, so every media card landed collapsed —
        // display:none, so the card was invisible without a click AND its
        // loading="lazy" thumbnail never even fetched. The first cut exempted
        // whole runs made only of image views, which is the RARE shape: in real
        // sessions a media card sits BETWEEN other foldable cards (Bash →
        // Read(png) → Bash), and browser ground truth showed it still
        // display:none inside "2 Bash · 1 image reads". So the exemption is
        // per MEMBER: image cards stay in the run (rail, first/last, sticky
        // mark, summary count, the bar's span) but never join the COLLAPSED
        // set — the fold closes around them. A run with NOTHING left to fold
        // (every member an image) gets no header at all: a fold control that
        // hides nothing is a dead control.
        const inline = new Set(members.filter((el) => memberKind(el) === 'image'));
        if (inline.size === members.length) { run = []; runKind = null; return; }
        if (members.length >= (hasTool ? 1 : 2)) {
          const header = document.createElement('div');
          header.className = 'chat-run-header';
          // per-kind counts (only non-zero kinds render) — countKinds zero-fills
          // EVERY kind the classifier can return (an unlisted kind used to count
          // NaN and vanish from the summary, 2.369.34). 'report' (a codex
          // sub-agent's written answer, B-7473) is one of those kinds and lives
          // in RUN_KINDS/SUMMARY_ORDER like every other — never a second map here.
          const memberKinds = members.map(memberKind);
          const byKind = countKinds(memberKinds);
          // single-server runs name the server — "8 MCP (chrome-devtools)";
          // ONLY real mcp__server__tool calls contribute (lookups never do)
          const mcpServers = new Set();
          members.forEach((el, i) => {
            if (memberKinds[i] === 'mcp') { const mp = mcpParts(el._rawMsg?.content?.[0]?.toolName); if (mp) mcpServers.add(mp.server); }
          });
          // Codex multi-agent (B-7473): the collab rows in this run carry the
          // sub-agent traffic. Inbound messages get their OWN count — "5 agent
          // ops" said nothing about a sub-agent having reported back — and the
          // agents named in the run become click-through chips on the header.
          // It is a COUNT, not a card kind (SUMMARY_EXTRAS in chat-run-summary),
          // so it is assigned into byKind and ordered by the one SUMMARY_ORDER.
          const collabRows = [];
          for (const el of members) for (const r of (el._rawMsg?.collab?.rows || [])) collabRows.push(r);
          byKind.subAgentIn = collabRows.filter((r) => r.dir === 'in').length;
          // touched files (user ask: don't lose the paths): writes first with
          // a ✎ mark, then reads; deduped display names, capped at 4 + "+N".
          // memory/<name> marks agent-memory files vs project files.
          const files = [];
          const seenF = new Set();
          for (const wantWrite of [true, false]) {
            members.forEach((el, i) => {
              const k = memberKinds[i];
              if (k !== 'read' && k !== 'write' && k !== 'memory') return;
              const tn = el._rawMsg?.content?.[0]?.toolName;
              // semantic hint covers codex (Patch stamped 'write'); the name
              // check remains for claude/pre-hint messages
              const isW = el._rawMsg?.collapseKind === 'write' || tn === 'Write' || tn === 'Edit' || tn === 'Patch';
              if (isW !== wantWrite) return;
              for (const fl of fileLabelsOf(el)) {
                if (!fl || seenF.has(fl)) continue;
                seenF.add(fl);
                files.push(isW ? '✎ ' + fl : fl);
              }
            });
          }
          const nErr = members.filter((el) => el._rawMsg?.toolStatus === 'error').length;
          const running = members.some((el) => el._rawMsg?.status === 'pending' || el._rawMsg?.status === 'streaming');
          // LIVE SUB-AGENT TRAFFIC (2026-09-07): the run's whole traffic — how
          // many agents, how many events, and while the burst is still growing
          // how long ago the last one arrived. Composed by the PURE collab
          // module, POSITIONED by the ONE summary composer, and captured as a
          // closure so the per-second ticker can re-ask for a fresh `now`
          // without a second count anywhere.
          const collabStats = collabTrafficStats({ rows: collabRows });
          const liveCollabEl = this._elements.get(this._liveCollabId());
          const mkLabel = ({ now = Date.now(), live = false } = {}) => runSummaryLabel({
            byKind, mcpServers, files, nErr, running,
            collabPart: collabRunPart(collabStats, { now, live, t }),
          }, t);
          const collabLive = !!liveCollabEl && members.includes(liveCollabEl);
          const label = mkLabel({ live: collabLive });
          // "3 sub-agents: water_research, interior_research" (B-7473) — the same
          // click-through as the rows themselves (the header's own onclick
          // toggles the run, so each name stops propagation). Identity = the
          // row's agentPath, which the normalizer normalises to an absolute
          // path for EVERY direction (round-5: bare target vs '/root/x' showed
          // one agent as two chips).
          const agents = [];
          for (const r of collabRows) {
            const p = r.agentPath || r.target || '';
            if (!p || agents.some((a) => a.path === p)) continue;
            agents.push({ path: p, name: r.agentName || p.split('/').filter(Boolean).pop() || p, threadId: r.threadId || '' });
          }
          // The COUNT ("3 sub-agents · 47 messages · last 4s ago") now lives in
          // the label, so the floating run bar and the footer carry it too;
          // what stays here is the part a label cannot hold — the clickable
          // chips. Saying "3 sub-agents" twice on one line was the alternative.
          // ` · ` before the chips (2026-09-07 r2): moving the count into the
          // label dropped the colon that used to introduce the names, and the
          // header read "2 sub-agent events water_research" as one phrase.
          // The chips are a separate segment and must LOOK like one.
          const agentsHtml = agents.length
            ? `${label ? ' · ' : ' '}<span class="chat-run-agents">${agents.slice(0, 4).map((a) => `<span class="chat-collab-name" role="link" tabindex="0" data-agent-path="${escHtml(a.path)}"${a.threadId ? ` data-thread-id="${escHtml(a.threadId)}"` : ''}>${escHtml(a.name)}</span>`).join(', ')}${agents.length > 4 ? `, +${agents.length - 4}` : ''}</span>`
            : '';
          header.innerHTML = `<span class="chat-run-arrow">▸</span><span class="chat-run-label">${escHtml(label)}</span>${agentsHtml}`;
          for (const nameEl of header.querySelectorAll('.chat-collab-name')) {
            nameEl.onclick = (ev) => {
              ev.stopPropagation();
              this._openCollabAgent({ agentPath: nameEl.dataset.agentPath || '', threadId: nameEl.dataset.threadId || '' });
            };
          }
          const rec = { header, members, inline, footer: null, label, open: false, mkLabel, collabStats, _collabWasLive: collabLive };
          // Rebuilds happen on every list mutation — remember runs the user
          // opened so a new message doesn't re-collapse what they're reading.
          // Keyed by ANY member, not just the first: scroll-up pagination
          // prepends older members onto an existing run, changing its first
          // element — a first-member-only key re-collapsed the run the user
          // was reading on every _extendTop (real report).
          const wasOpen = members.some((el) => this._runExpanded.has(el));
          header.onclick = () => this._setRunOpen(rec, !rec.open);
          list.insertBefore(header, members[0]);
          this._setRunOpen(rec, wasOpen);
          built.push(rec);
        }
        run = []; runKind = null;
      };
      for (const el of kids) {
        const k = kindOf(el);
        if (k === 'skip') continue; // hidden card — transparent to the run
        if (k && k === runKind) { run.push(el); continue; }
        flush();
        if (k) { run = [el]; runKind = k; }
      }
      flush();
      // While PINNED (following live output) only the LAST run keeps an
      // opened state: a run expanded to watch one command's output used to
      // inherit the open flag as it grew and stayed expanded FOREVER (user
      // report: 一部分没折叠). Moving on re-folds it; reading history
      // (unpinned) never auto-collapses anything.
      if (this._pinned && built.length > 1) {
        for (const r of built.slice(0, -1)) {
          if (!r.open) continue;
          // …EXCEPT a run the user just opened on purpose (it was already a
          // non-last run when they clicked): _setRunOpen's footer insert is a
          // childList mutation, so before 2026-09-06 the click scheduled a
          // pass and this line closed the run the click had opened ~180ms
          // later — every non-last header was a no-op while pinned (measured
          // in headless chrome: open → [false] at t+320ms). An INHERITED open
          // flag (the live tail grew past the run the user was watching) has
          // no sticky mark and still re-folds — that is what this rule is for.
          if (r.members.some((el) => this._runStickyOpen.has(el))) continue;
          this._setRunOpen(r, false);
        }
      }
      this._runs = built;
    } finally {
      this._runsMutating = false;
      if (anchorEl && anchorEl.isConnected) {
        // the anchor itself may have folded (display:none) — prefer falling
        // BACK to its run header (it sits directly above, exactly where the
        // folded content was, and clicking it restores the view); fall
        // forward only when nothing visible precedes the anchor
        let a = anchorEl;
        while (a && a.offsetParent === null) a = a.previousElementSibling;
        if (!a) { a = anchorEl; while (a && a.offsetParent === null) a = a.nextElementSibling; }
        if (a) {
          const stBefore = list.scrollTop;
          this._traceExpect();
          list.scrollTop = a === anchorEl ? a.offsetTop - anchorDelta : a.offsetTop;
          if (Math.abs(list.scrollTop - stBefore) > 1) this._trace('runsRestore', { same: a === anchorEl, from: Math.round(stBefore), to: Math.round(list.scrollTop) });
        }
      }
      // Drain OUR OWN mutation records: the observer callback is delivered at
      // a microtask checkpoint AFTER this finally resets _runsMutating, so the
      // flag alone never suppressed self-triggering — every pass scheduled
      // another identical pass in a permanent 180ms rebuild loop
      // (review-confirmed, pre-existing). Nothing else mutates the list
      // synchronously between our pass and this drain.
      this._runsObserver?.takeRecords();
      this._scheduleRunBar();
    }
  }

  // ── Expanded-run legibility (2.369.37, owner: an expanded run taller than
  // a screen was indistinguishable from loose cards, and re-collapsing meant
  // scrolling back up to find the summary line). Three affordances, all on
  // top of the FLAT list (members stay direct .chat-msg children — virtual
  // scroll, trims, minimap, search and the seek machinery select
  // ':scope > .chat-msg'; nothing is ever wrapped):
  //  (i)  GROUPING RAIL — members of an OPEN run carry .chat-run-member
  //       (+ .chat-run-first/.chat-run-last): accent rail + tint (chat.css).
  //  (ii) FLOATING RUN BAR — .chat-run-bar, ONE element per ChatView on the
  //       .chat-view container (NOT a list child — an in-flow row would be
  //       picked up by _withViewportAnchor / trims / the insert reference).
  //       Shown while an open run's header is above the viewport and its
  //       footer is still at/below the top edge. Computed in the scroll rAF
  //       (_updateRunBar) off _runs; never pages.
  //  (iii) BOTTOM COLLAPSE LINE — .chat-run-footer after the last member of
  //       an open run; same non-.chat-msg family as the header (removed and
  //       re-inserted by every _updateRuns pass, invisible to counts/trims).
  // Collapsed runs show none of these. Esc is NOT bound (data-popover owns it).
  _setRunOpen(run, open) {
    if (!run?.header) return;
    run.open = !!open;
    run.header.classList.toggle('open', run.open);
    const n = run.members.length;
    run.members.forEach((el, i) => {
      if (run.open) this._runExpanded.add(el); else this._runExpanded.delete(el);
      // an INLINE member (an image view — image-card review round 2) is a member of the run for
      // every other purpose but never of the collapsed set: the owner asked to
      // see the picture without a click, and display:none also means its
      // loading="lazy" thumbnail never fetches
      el.classList.toggle('chat-run-collapsed', !run.open && !run.inline?.has(el));
      el.classList.toggle('chat-run-member', run.open);
      el.classList.toggle('chat-run-first', run.open && i === 0);
      el.classList.toggle('chat-run-last', run.open && i === n - 1);
    });
    // The footer is a LIST CHILD, so inserting/removing it is a childList
    // mutation. Inside a pass _runsMutating already covers that; a USER CLICK
    // is not a pass, so the record scheduled ANOTHER pass — and while pinned
    // that pass's auto-refold closed the run the click had just opened. Hide
    // our own mutation exactly the way a pass drains its own records (the
    // flag alone never suppressed anything: the observer callback is
    // delivered at a microtask checkpoint, long after the flag is back to
    // false). Drain only when we really mutated, so an unrelated pending
    // record is never swallowed with it.
    const outsidePass = !this._runsMutating;
    let mutated = false;
    if (outsidePass) this._runsMutating = true;
    try {
      if (run.open) {
        if (!run.footer) {
          const f = document.createElement('div');
          f.className = 'chat-run-footer';
          f.innerHTML = `<span class="chat-run-arrow">${UI_ICONS.chevronUp}</span><span class="chat-run-label">${escHtml(t('Collapse'))} · ${escHtml(run.label)}</span>`;
          f.onclick = () => this._collapseRunTo(run);
          run.footer = f;
        }
        const last = run.members[n - 1];
        if (last?.parentNode === this._messageList && run.footer.previousSibling !== last) {
          this._messageList.insertBefore(run.footer, last.nextSibling);
          mutated = true;
        }
      } else if (run.footer?.isConnected) {
        run.footer.remove();
        mutated = true;
      }
    } finally {
      if (outsidePass) {
        this._runsMutating = false;
        if (mutated) this._runsObserver?.takeRecords();
      }
    }
    // A deliberate toggle on a run that is NOT the live tail means "I am
    // reading this" — remember it so the pinned auto-refold spares it, and
    // forget it the moment the user collapses it again. Opening the LAST run
    // is the live-watching case the auto-refold exists for (2.227.x
    // "一部分没折叠": a run expanded to watch one command's output
    // used to stay expanded forever once the tail moved on), so it stays
    // inherited-open and re-folds when it stops being last.
    if (outsidePass) {
      const isLast = this._runs?.length ? this._runs[this._runs.length - 1] === run : false;
      const sticky = run.open && !isLast;
      for (const el of run.members) { if (sticky) this._runStickyOpen.add(el); else this._runStickyOpen.delete(el); }
    }
    this._scheduleRunBar();
  }

  // Land the viewport on a run's header — ABSOLUTE (the 2.229.1 lesson: delta
  // math fights native scroll anchoring). Muted for the scroll handler so the
  // landing can neither re-pin nor page (_extendTop's intent gates read the
  // list's own input stamps; the bar/footer live outside the list). Pin state
  // follows the landing honestly.
  _landOnHeader(run) {
    const list = this._messageList;
    if (!run?.header?.isConnected || !list) return;
    // the floating run bar and the run footer live on this._container, so this
    // landing reaches the list only as a scrollTop write — stamp it as the
    // navigation it is (round-2 verifier's MAJOR)
    this._noteUserNav('runBar');
    this._programmaticScroll = true;
    clearTimeout(this._jumpGuardTimer);
    this._jumpGuardTimer = setTimeout(() => { this._programmaticScroll = false; }, 400);
    this._traceExpect();
    list.scrollTop = run.header.offsetTop;
    this._lastStructuralAt = Date.now(); this._lastStructuralDir = null;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
    if (atBottom !== this._pinned) {
      this._pinned = atBottom;
      if (atBottom) this._newMsgCount = 0;
      this._scrollBtn?.classList.toggle('hidden', atBottom);
    }
    this._trace('runLand', { st: Math.round(list.scrollTop), pin: this._pinned ? 1 : 0 });
    this._scheduleRunBar();
  }

  // Collapse from the bar/footer (header OFF-screen): fold, then land on the
  // header so the user keeps their place — the header takes exactly the spot
  // the bar occupied.
  _collapseRunTo(run) {
    if (!run?.header?.isConnected) return;
    this._setRunOpen(run, false);
    this._landOnHeader(run);
  }

  _ensureRunBar() {
    if (this._runBar) return this._runBar;
    const bar = document.createElement('div');
    bar.className = 'chat-run-bar hidden';
    bar.innerHTML = `<span class="chat-run-bar-label"></span>`
      + `<button type="button" class="chat-run-bar-btn chat-run-bar-top" title="${escHtml(t('Jump to top of run'))}">${UI_ICONS.arrowUpToLine}</button>`
      + `<button type="button" class="chat-run-bar-btn chat-run-bar-collapse" title="${escHtml(t('Collapse run'))}">${UI_ICONS.chevronUp}</button>`;
    bar.querySelector('.chat-run-bar-top').onclick = (e) => { e.stopPropagation(); if (this._runBarRun) this._landOnHeader(this._runBarRun); };
    // the whole bar collapses (touch: a tap anywhere on it — no Esc chord)
    bar.onclick = () => { if (this._runBarRun) this._collapseRunTo(this._runBarRun); };
    this._container.appendChild(bar);
    this._runBar = bar;
    return bar;
  }

  _scheduleRunBar() {
    if (this._runBarRaf || this._disposed) return;
    this._runBarRaf = requestAnimationFrame(() => {
      this._runBarRaf = null;
      if (this._disposed) return;
      this._updateRunBar(this._messageList.scrollTop);
    });
  }

  // Floating-bar state for THIS frame. Called from the rAF-coalesced scroll
  // path with the frame's already-read scrollTop; header/footer offsets are
  // read in the same layout pass (no writes in between), the current open
  // run is cached and re-checked first. Makes NO paging/pin decision.
  _updateRunBar(scrollTop) {
    const runs = this._runs;
    let hit = null;
    if (!this._suspended && runs?.length) {
      const bottomOf = (r) => {
        if (r.footer?.isConnected) return r.footer.offsetTop + r.footer.offsetHeight;
        for (let i = r.members.length - 1; i >= 0; i--) { const m = r.members[i]; if (m.isConnected) return m.offsetTop + m.offsetHeight; }
        return r.header.offsetTop + r.header.offsetHeight;
      };
      const covers = (r) => r.open && r.header.isConnected && r.header.offsetTop < scrollTop - 1 && bottomOf(r) > scrollTop;
      if (this._runBarRun && runs.includes(this._runBarRun) && covers(this._runBarRun)) hit = this._runBarRun;
      else hit = runs.find(covers) || null;
    }
    this._runBarRun = hit;
    if (!hit) {
      if (this._runBar && !this._runBar.classList.contains('hidden')) { this._runBar.classList.add('hidden'); this._container.classList.remove('chat-run-bar-on'); }
      return;
    }
    const bar = this._ensureRunBar();
    if (bar._label !== hit.label) { bar._label = hit.label; bar.querySelector('.chat-run-bar-label').textContent = hit.label; }
    // pin to the message list's top edge (the search bar sits above the list
    // in-flow; the list may not start at the container's top)
    const top = this._messageList.offsetTop;
    if (bar._top !== top) { bar._top = top; bar.style.top = top + 'px'; }
    if (bar.classList.contains('hidden')) { bar.classList.remove('hidden'); this._container.classList.add('chat-run-bar-on'); }
  }

  dispose() {
    this._statusBar?.dispose?.();
    this._disposed = true;
    LIVE_CHAT_VIEWS.delete(this);
    // The keybinding is signal-bound to the WINDOW, but a view can be replaced
    // while its window lives on — an orphaned binding would keep answering the
    // chord for a disposed view.
    try { this._steerKeyDispose?.(); } catch { }
    this._steerKeyDispose = null;
    this._clearPendingSteers();
    if (this._blankProbe) { clearTimeout(this._blankProbe); this._blankProbe = null; }
    if (this._autoFillT1) { clearTimeout(this._autoFillT1); this._autoFillT1 = null; }
    if (this._autoFillT2) { clearTimeout(this._autoFillT2); this._autoFillT2 = null; }
    if (this._runsObserver) { this._runsObserver.disconnect(); this._runsObserver = null; }
    if (this._searchBarObserver) { this._searchBarObserver.disconnect(); this._searchBarObserver = null; }
    if (this._runsTimer) { clearTimeout(this._runsTimer); this._runsTimer = null; }
    if (this._runBarRaf) { cancelAnimationFrame(this._runBarRaf); this._runBarRaf = null; }
    this._stopCollabTick();
    if (this._queueChipRaf && this._queueChipRaf !== -1) { try { cancelAnimationFrame(this._queueChipRaf); } catch { } this._queueChipRaf = 0; }
    this._clearResumeRetail();
    if (this._endPointerPress) {
      // belt and braces: winInfo._listenerCtl aborts these on window close, but
      // a view can also be disposed while its window lives on (tab swap, view
      // replacement) and these are WINDOW-scoped listeners holding the view.
      window.removeEventListener('pointerup', this._endPointerPress);
      window.removeEventListener('pointercancel', this._endPointerPress);
      this._endPointerPress = null;
    }
    if (this._traceWatchTimer) { clearInterval(this._traceWatchTimer); this._traceWatchTimer = null; }
    if (this._stallWatch) { clearInterval(this._stallWatch); this._stallWatch = null; }
    if (this._sleepTicker) { clearInterval(this._sleepTicker); this._sleepTicker = null; }
    if (this._readOnlyPollTimer) clearTimeout(this._readOnlyPollTimer);
    this.ws.offGlobal(this._handler);
    this.ws.offStateChange(this._stateHandler);
    for (const [key, fn] of this._settingsListeners || []) this.app.settings?.off(key, fn);
    this._settingsListeners = [];
    if (this._chatInput) this._chatInput.dispose();
    if (this._chatMinimap) this._chatMinimap.dispose();
    if (this._search) this._search.dispose();
    if (this._gapObserver) { this._gapObserver.disconnect(); this._gapObserver = null; }
    if (this._dropHideTimer) { clearTimeout(this._dropHideTimer); this._dropHideTimer = null; }
    if (this._historyStatusTimer) { clearTimeout(this._historyStatusTimer); this._historyStatusTimer = null; }
  }
}

export { ChatView, isScopedRefusal };

// Gap-seek (huge-JSONL continuous scroll) methods live in their own module.
installChatSeek(ChatView);
