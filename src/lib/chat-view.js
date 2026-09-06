import { copyText, escHtml, showToast, showConfirmDialog, collectDroppedFiles, showImageOverlay, fetchJson } from './utils.js';
import { installChatSeek } from './chat-view-seek.js';
import { metric, track } from './telemetry-client.js';
import { stripAnsi } from './highlight.js';
import { ChatMinimap } from './chat-minimap.js';
import { ChatSearch } from './chat-search.js';
import { ChatRenderers, toolDisplayName } from './chat-renderers.js';
import { ChatInput } from './chat-input.js';
import { ChatStatusBar } from './chat-status-bar.js';
import { UI_ICONS } from './icons.js';
import { t } from './i18n.js';
import { agentMemoryPathRes } from './agent-meta.js';
import { mcpParts } from './chat-renderers.js';

// Agent-memory path patterns, PER BACKEND from BACKEND_META (agent-meta.js —
// claude only today; codex has no memory feature; a new backend adds one
// memoryPathRe entry there). Unioned: the PATH identifies memory content
// regardless of which session's file op touches it.
const MEMORY_PATH_RES = agentMemoryPathRes();
const isMemoryPath = (fp) => MEMORY_PATH_RES.some((re) => re.test(fp));

/**
 * ChatView — renders a chat interface for stream-json mode sessions.
 * Displays structured messages from Claude Code's --output-format stream-json.
 * Input goes to the same PTY session via WebSocket.
 */
class ChatView {
  constructor(winInfo, wsManager, sessionId, app, { readOnly = false } = {}) {
    this.winInfo = winInfo;
    this.ws = wsManager;
    this.sessionId = sessionId;
    this.app = app;
    this._readOnly = readOnly;
    // Subagent viewers (sub-*) can't paginate; view-only history (view-*) and normal sessions can
    this._canPaginate = !sessionId.startsWith('sub-');
    this._messages = []; // normalized message objects
    this._elements = new Map(); // msg.id → DOM element
    this._pinned = true; // auto-scroll to bottom
    this._renderedMsgIds = new Set(); // dedup by msgId

    // Build DOM
    const container = document.createElement('div');
    container.className = 'chat-view';
    this._container = container;

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
      onDesignRequest: readOnly ? null : (brief, opts) => this._sendDesignRequest(brief, opts),
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
      onSendText: (txt) => this._chatInput?.sendText(txt), // in-chat action buttons (Compact now) — null-safe for view-only
      ws: wsManager,
      sessionId,
      app,
      backend: winInfo.backend || winInfo.titleMeta?.backend || 'claude',
      compact: this._compact,
      messageList: this._messageList,
      onPermissionResolve: () => { this._hideTyping(); this._updateRuns(); },
      onFork: (uuid, msg) => this._forkFromMessage(uuid, msg),
    });

    // Position indicator (shows when not at bottom, e.g. "120-170 / 3000")
    this._posIndicator = document.createElement('div');
    this._posIndicator.className = 'chat-pos-indicator hidden';
    if (this._chatScale !== 1) this._messageList.style.zoom = this._chatScale;
    container.appendChild(this._messageList);
    container.appendChild(this._posIndicator);

    // Scroll minimap — semantic scrollbar showing turns
    this._chatMinimap = new ChatMinimap(container, this._messageList, (idx) => this.jumpToIndex(idx), (ts, line) => this._jumpToFileTime(ts, line));
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
      this._lastUserScrollAt = Date.now();
      // DIRECTION of the user's intent. Content growth (content-visibility
      // resolving a freshly paged batch) moves scrollTop with NO direction of
      // its own — native scroll anchoring pushes it numerically DOWN to keep
      // the view stable — and that was being read as "the user is scrolling
      // toward the end". This is the only reliable discriminator.
      if (e.deltaY) { this._wheelDir = e.deltaY > 0 ? 1 : -1; this._wheelDirAt = Date.now(); }
    }, { passive: true });
    this._messageList.addEventListener('touchmove', () => { this._lastUserScrollAt = Date.now(); }, { passive: true });
    // Scrollbar drags and keyboard paging produce NO wheel/touch events — they
    // must still count as user input for the positive-evidence gate below
    // (inc-mspemym2 round 5), or those readers stall at the window end.
    this._messageList.addEventListener('pointerdown', () => { this._lastUserScrollAt = Date.now(); }, { passive: true });
    this._messageList.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) this._lastUserScrollAt = Date.now();
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
        if (this._programmaticScroll) return; // don't interfere with programmatic scrolls
        const { scrollTop, scrollHeight, clientHeight } = this._messageList;
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
          this._pinned = true;
          this._newMsgCount = 0;
          this._scrollBtn.classList.add('hidden');
        } else if (!atBottom) {
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
    });
    this._chatInput.popupContainer = container;
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
        if (msg.label) this._showTyping(msg.label, msg.kind || null);
        else this._hideTyping();
      } else if (msg.type === 'auto-resume' && msg.sessionId === sessionId) {
        this._statusBar?.setAutoResume?.(msg.status || null);
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
        // SEND refusal ≠ attach failure (inc-mt2arppw, userW: every too-large
        // paste flipped the LIVE window into the Resume bar — the session was
        // never broken, and the refusal text rode msg.error which this branch
        // never read, so the user saw a dead-looking window with no reason).
        // A coded input rejection renders in-chat and leaves the view alone.
        if (msg.code === 'input-rejected') {
          this._hideTyping();
          this._renderers.appendSystem('✗ ' + (msg.message || msg.error || t('Message rejected.')));
          try { track('event', 'chat-input-rejected', this._telemDetail(msg.message || msg.error)); } catch {}
          return;
        }
        // Attach failed (e.g. stale serverId replayed from a saved layout).
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
        if (isStreaming) this._showTyping(meta?.streamingLabel || t('thinking...'), meta?.streamingKind || null);
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
    if (isStreaming) this._showTyping(meta?.streamingLabel || t('thinking...'), meta?.streamingKind || null);
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
    // Auto-load more if content doesn't fill viewport (no scrollbar to trigger scroll event).
    // inc-mtox23xw (2.369.36): 100ms after a re-attach REBUILD the fresh batch's
    // content-visibility heights are still unresolved, so sh<=ch held for a TALL
    // window and this fired an ungated _extendTop on a PINNED view — the slab
    // landed 7s later (stalled server), trimBottom dropped the live tail and the
    // view unpinned 1500px up ("content jumped after I sent a message"). Decide
    // only after the settle window, and only for a genuinely SHORT view.
    setTimeout(() => {
      if (this._suspended || this._disposed) return; // hidden window: sh<=ch is an artifact, not "doesn't fill"
      const list = this._messageList;
      const rendered = list.querySelectorAll(':scope > .chat-msg').length;
      if (this._windowStart > 0 && rendered < 30 && list.scrollHeight <= list.clientHeight) {
        this._trace?.('autoFill', { rendered, sh: list.scrollHeight, ch: list.clientHeight });
        this._extendTop();
      }
    }, 700);
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
    if ('autoResume' in meta) this._statusBar?.setAutoResume?.(meta.autoResume || null);
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
    if (meta.effort) add(t('Effort'), meta.effort); // codex: the turn's reasoning effort (turn_context)
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
          if (!meta.effort && r.effort) addAsyncRow(t('Effort'), r.effort);
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
      el.className = 'chat-history-status';
      el.style.cssText = 'position:absolute;top:6px;left:50%;transform:translateX(-50%);z-index:20;max-width:80%;';
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
   *  covers the re-measure) and a pinned view returns to the tail in ONE hop. */
  setSuspended(on) {
    if (this._suspended === !!on) return;
    this._suspended = !!on;
    if (!on) {
      this._lastStructuralAt = Date.now();
      // A pinned view returns to the LIVE tail — not just the DOM bottom
      // (inc-mtfi6034, mobile: touch paging near the top had trimmed the
      // window's tail, so windowEnd < total and a plain scroll landed on an
      // old position after every desktop switch). Behind-the-tail windows
      // take the full jumpToBottom (refetches the tail slab).
      if (this._pinned) requestAnimationFrame(() => { try {
        if (this._disposed) return;
        if (this._teleported || this._windowEnd < this._total) this.jumpToBottom();
        else this._scrollToBottom();
      } catch { } });
    }
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
        this._trimBottom();
        this._updateRuns();
      });
      if (!anchored) {
        // no usable anchor (very top / empty list) — old delta-math fallback
        this._traceExpect();
        this._messageList.scrollTop += (this._messageList.scrollHeight - scrollHeightBefore);
      }
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
          if (entry.isIntersecting) this._loadEarlierGap(entry.target, null);
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

  // Jump to the bottom of the conversation
  async jumpToBottom() {
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
    const list = this._messageList;
    const step = () => {
      if (this._disposed) { this._fsbActive = false; return; }
      list.scrollTop = list.scrollHeight;
      // Each frame scrolling reveals off-screen elements, browser computes
      // their real heights (replacing content-visibility estimates), scrollHeight
      // grows — repeat until converged or max 10 frames (~166ms)
      if (++this._fsbFrames < 10) requestAnimationFrame(step);
      else { this._fsbActive = false; this._programmaticScroll = false; }
    };
    requestAnimationFrame(step);
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
    } else if (op.op === 'edit') {
      this._onEditMessage(op.id, op.fields);
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
    if (op.subtype === 'served-model') {
      this._statusBar.setServedModel(op.data?.model || null);
      return;
    }
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
      this._hideTyping();
      this._statusBar.addCost(op.data?.cost, op.data?.modelUsage);
      // Blink window
      if (!this.winInfo.element.classList.contains('window-active')) {
        this.winInfo.element.classList.add('window-waiting');
        if (this.winInfo._notifyChanged) this.winInfo._notifyChanged();
      }
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
    if (!b || !this._chatInput) return;
    const msg = `[VibeSpace design request] ${b}

Create this as a design canvas HOSTED BY THIS VIBESPACE (not claude.ai):
1. Run \`vibespace-page kit\` — it prints "Base directory for this skill: <dir>".
2. Read <dir>/SKILL.md and follow it exactly: author the .dc.html artboards (and canvas.json for several), seed with seed-canvas.mjs, run its --check. Work inside a new subdirectory designs/<short-slug>/ of the current working directory (create it) so the working files and the seeded ~2 MB page never land in a repo root. Do not use the Artifact tool, artifact-capabilities or anything pointing at claude.ai.
3. Publish with \`vibespace-page publish <seeded file> --title "<what I would call it>"${pub ? ' --public' : ''}\` and reply with the share link plus a line on what you drafted and assumed.`;
    this._chatInput.sendText(msg);
  }

  // _showTyping / _hideTyping delegate to ChatInput (normal) or readOnly _streamStatus
  _showTyping(label = t('thinking...'), kind = null) {
    this._typingSince = this._typingSince || Date.now(); // watchdog arm
    if (this._chatInput) { this._chatInput.showTyping(label, kind); return; }
    // readOnly fallback
    if (!this._streamStatus) return;
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> ${escHtml(label)}`;
    this._streamStatus.classList.remove('hidden');
  }

  _hideTyping() {
    this._typingSince = null; // watchdog disarm
    if (this._chatInput) { this._chatInput.hideTyping(); return; }
    // readOnly fallback
    if (!this._streamStatus) return;
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
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
      if (msg.isStreaming) this._showTyping(msg.streamingLabel || t('thinking...'), msg.streamingKind || null);
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
    if (st > 0) {
      for (const c of list.children) {
        if (c.offsetHeight > 0 && c.offsetTop + c.offsetHeight > st) { el = c; delta = c.offsetTop - st; break; }
      }
      // ALL children content-visibility-collapsed (offsetHeight 0) — their
      // offsetTop is still valid layout truth, so anchor on position alone
      // rather than giving up to the estimate-skewed delta fallback
      if (!el) {
        for (const c of list.children) {
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
    // owns the scroll) and skip run headers (they're removed by the pass).
    let anchorEl = null, anchorDelta = 0;
    if (!this._pinned && list.scrollTop > 0) {
      const st = list.scrollTop;
      for (const el of list.children) {
        if (el.classList.contains('chat-run-header')) continue;
        if (el.offsetTop + el.offsetHeight > st) { anchorEl = el; anchorDelta = el.offsetTop - st; break; }
      }
    }
    this._runsMutating = true;
    try {
      list.querySelectorAll(':scope > .chat-run-header').forEach((h) => h.remove());
      list.querySelectorAll(':scope > .chat-run-collapsed').forEach((el) => el.classList.remove('chat-run-collapsed'));
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
      // per-member classification (also used by flush() for the summary).
      // SEMANTIC HINT FIRST (Track B, design-backend-parity.md §5): the
      // normalizer stamps `collapseKind` — codex cards (exec, Agent Wait,
      // send_message…) never matched the claude tool-name map below and so
      // NOTHING codex folded (owner report). The name map stays as the
      // fallback for claude + pre-hint histories.
      const memberKind = (el) => {
        const m = el._rawMsg;
        if (el.classList.contains('chat-msg-tool-result')) {
          const ck = m?.collapseKind;
          if (ck) {
            if ((ck === 'read' || ck === 'write') && isMemoryPath(m?.content?.[0]?.input?.file_path || '')) return 'memory';
            return ck;
          }
          const tn = m?.content?.[0]?.toolName;
          if (tn === 'Bash') return 'bash';
          // Skill launches (2.227.9, user report "技能卡片无法参与折叠") — a
          // "Launching skill: x" card is pure harness noise, same class as a
          // Bash line; it fell through to null and so BROKE the surrounding run.
          if (tn === 'Skill') return 'skill';
          if (tn === 'Agent' || tn === 'Task') return 'agent'; // claude sub-agent cards join the collab kind
          // web research is its OWN kind (2.369.33, owner report: 42 WebSearch cards
          // in one session, none folded — and each null BROKE the surrounding run)
          if (tn === 'WebSearch' || tn === 'WebFetch') return 'search';
          if (tn === 'Read' && /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|avif)$/i.test(m?.content?.[0]?.input?.file_path || '')) return 'image'; // image views fold as their own kind (2.369.34)
          if (tn === 'Grep' || tn === 'Glob' || tn === 'LS') return 'read';   // file-system searches = reads
          if (tn === 'ToolSearch') return 'mcp';                              // tool-schema lookup = MCP housekeeping
          if (mcpParts(tn)) return 'mcp'; // any MCP server's tool (2.215.3)
          if (tn === 'Read' || tn === 'Write' || tn === 'Edit' || tn === 'Patch') {
            // agent-memory file ops are their OWN kind (2.213.1, user ask:
            // each is a distinct user concern) — housekeeping vs project work
            if (isMemoryPath(m?.content?.[0]?.input?.file_path || '')) return 'memory';
            return tn === 'Read' ? 'read' : 'write';
          }
          return null;
        }
        if (m?.role === 'assistant' && Array.isArray(m.content) && m.content.length
            && m.content.every((b) => b.type === 'thinking')) return 'thinking';
        return null;
      };
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
        return mk && kinds.has(mk) ? 'noise' : null;
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
        if (members.length >= (hasTool ? 1 : 2)) {
          const header = document.createElement('div');
          header.className = 'chat-run-header';
          // per-kind counts (only non-zero kinds render)
          // EVERY kind the classifier can return must be initialised here — an
          // unlisted kind counted `undefined++` = NaN and silently vanished from
          // the summary (2.369.34, owner: "searches were lumped/missing")
          const byKind = { thinking: 0, bash: 0, read: 0, write: 0, memory: 0, mcp: 0, agent: 0, skill: 0, search: 0, image: 0 };
          const mcpServers = new Set();
          for (const el of members) {
            const k = memberKind(el);
            if (k) byKind[k]++;
            if (k === 'mcp') { const mp = mcpParts(el._rawMsg?.content?.[0]?.toolName); if (mp) mcpServers.add(mp.server); }
          }
          const parts = [];
          if (byKind.thinking) parts.push(t('{n} thinking', { n: byKind.thinking }));
          if (byKind.bash) parts.push(t('{n} Bash', { n: byKind.bash }));
          if (byKind.read) parts.push(t('{n} file reads', { n: byKind.read }));
          if (byKind.search) parts.push(t('{n} web searches', { n: byKind.search }));
          if (byKind.image) parts.push(t('{n} image reads', { n: byKind.image }));
          if (byKind.write) parts.push(t('{n} writes', { n: byKind.write }));
          if (byKind.memory) parts.push(t('{n} memory', { n: byKind.memory }));
          // single-server runs name the server — "8 MCP (chrome-devtools)"
          if (byKind.mcp) parts.push(t('{n} MCP', { n: byKind.mcp }) + (mcpServers.size === 1 ? ` (${[...mcpServers][0]})` : ''));
          if (byKind.agent) parts.push(t('{n} agent ops', { n: byKind.agent }));
          let label = parts.join(' · ');
          // touched files (user ask: don't lose the paths): writes first with
          // a ✎ mark, then reads; deduped display names, capped at 4 + "+N".
          // memory/<name> marks agent-memory files vs project files.
          const files = [];
          const seenF = new Set();
          for (const wantWrite of [true, false]) {
            for (const el of members) {
              const k = memberKind(el);
              if (k !== 'read' && k !== 'write' && k !== 'memory') continue;
              const tn = el._rawMsg?.content?.[0]?.toolName;
              // semantic hint covers codex (Patch stamped 'write'); the name
              // check remains for claude/pre-hint messages
              const isW = el._rawMsg?.collapseKind === 'write' || tn === 'Write' || tn === 'Edit' || tn === 'Patch';
              if (isW !== wantWrite) continue;
              for (const fl of fileLabelsOf(el)) {
                if (!fl || seenF.has(fl)) continue;
                seenF.add(fl);
                files.push(isW ? '✎ ' + fl : fl);
              }
            }
          }
          if (files.length) {
            const shown = files.slice(0, 4);
            label += ' — ' + shown.join(', ') + (files.length > 4 ? `, +${files.length - 4}` : '');
          }
          // failed members surface as a count (an error must not vanish into a
          // silent fold — grep-exit-1 class errors are common and folding them
          // is fine, but the header says they exist)
          const nErr = members.filter((el) => el._rawMsg?.toolStatus === 'error').length;
          if (nErr) label += ` · ${nErr} ✗`;
          // live state on the fold: a running member shows through the header
          if (members.some((el) => el._rawMsg?.status === 'pending' || el._rawMsg?.status === 'streaming')) {
            label += ' · ' + t('running…');
          }
          header.innerHTML = `<span class="chat-run-arrow">▸</span><span>${escHtml(label)}</span>`;
          // Rebuilds happen on every list mutation — remember runs the user
          // opened so a new message doesn't re-collapse what they're reading.
          // Keyed by ANY member, not just the first: scroll-up pagination
          // prepends older members onto an existing run, changing its first
          // element — a first-member-only key re-collapsed the run the user
          // was reading on every _extendTop (real report).
          const wasOpen = members.some((el) => this._runExpanded.has(el));
          header.onclick = () => {
            const open = header.classList.toggle('open');
            for (const el of members) {
              if (open) this._runExpanded.add(el); else this._runExpanded.delete(el);
              el.classList.toggle('chat-run-collapsed', !open);
            }
          };
          list.insertBefore(header, members[0]);
          if (wasOpen) { header.classList.add('open'); for (const el of members) this._runExpanded.add(el); }
          else for (const el of members) el.classList.add('chat-run-collapsed');
          built.push({ header, members });
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
          if (!r.header.classList.contains('open')) continue;
          r.header.classList.remove('open');
          for (const el of r.members) { this._runExpanded.delete(el); el.classList.add('chat-run-collapsed'); }
        }
      }
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
    }
  }

  dispose() {
    this._statusBar?.dispose?.();
    this._disposed = true;
    if (this._blankProbe) { clearTimeout(this._blankProbe); this._blankProbe = null; }
    if (this._runsObserver) { this._runsObserver.disconnect(); this._runsObserver = null; }
    if (this._searchBarObserver) { this._searchBarObserver.disconnect(); this._searchBarObserver = null; }
    if (this._runsTimer) { clearTimeout(this._runsTimer); this._runsTimer = null; }
    if (this._traceWatchTimer) { clearInterval(this._traceWatchTimer); this._traceWatchTimer = null; }
    if (this._stallWatch) { clearInterval(this._stallWatch); this._stallWatch = null; }
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

export { ChatView };

// Gap-seek (huge-JSONL continuous scroll) methods live in their own module.
installChatSeek(ChatView);
