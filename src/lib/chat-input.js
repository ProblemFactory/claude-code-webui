import { escHtml, saveDraft, loadDraft, clearDraft, getStateSync, showContextMenu, showToast, uploadFilesBatched, showImageOverlay } from './utils.js';
import { UI_ICONS } from './icons.js';
import { t } from './i18n.js';

/**
 * ChatInput — input area for chat mode sessions.
 * Manages textarea, attachments, slash commands, expand/collapse,
 * draft persistence, streaming status indicator, and todo display.
 */
export class ChatInput {
  /**
   * @param {object} ws - WsManager instance
   * @param {string} sessionId - session identifier
   * @param {object} opts
   * @param {function} opts.onSend - called after send with (text, attachments)
   * @param {function} opts.getStateSync - returns StateSync instance
   * @param {function} opts.onInterrupt - called when user clicks Stop
   */
  constructor(ws, sessionId, { onSend, onInterrupt, getCwd, getHost, getUploadDir, isTouch, getTouchEnterSends, onQueueOp }) {
    this._ws = ws;
    this._sessionId = sessionId;
    this._onSend = onSend;
    this._onInterrupt = onInterrupt;
    this._getCwd = getCwd || (() => null);
    this._getHost = getHost || (() => null);
    this._getUploadDir = getUploadDir || (() => '');
    this._isTouch = isTouch || (() => false);
    this._getTouchEnterSends = getTouchEnterSends || (() => false);
    this._onQueueOp = onQueueOp || null;   // (op, id) → ws 'queue-op'
    this._queue = [];
    this._queueCaps = { steer: false, queueOps: false };

    // Attachment state
    this._attachments = [];

    // Slash commands (populated from system.init)
    this._slashCommands = [];

    // Streaming state
    this._isStreaming = false;

    // Todos
    this._todos = [];

    // Expanded editor state
    this._expanded = false;

    // ── Build DOM ──

    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';
    this._element = inputArea;

    // Textarea
    this._textarea = document.createElement('textarea');
    this._textarea.className = 'chat-input';
    this._textarea.placeholder = t('Type a message...');
    this._textarea.rows = 1;

    // Attachment area (above input row)
    this._attachArea = document.createElement('div');
    this._attachArea.className = 'chat-attach-area hidden';

    // Image paste — add as attachment, don't send immediately
    this._textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) this._addImageAttachment(file);
          return;
        }
      }
    });

    // Restore draft from sessionStorage
    const draft = loadDraft('chat', sessionId);
    if (draft) {
      this._textarea.value = draft;
      setTimeout(() => this._autoSize?.(), 0);
    }

    // Auto-grow textarea (skip in expanded mode). rAF-COALESCED with a no-op
    // skip (2.338.0, Windows freeze audit): the raw handler did write→read→
    // write per keystroke = two forced layouts of the whole chat window, and
    // every real height change rippled into the scroller (content-visibility
    // re-resolution + scroll-anchoring drift → the paging self-feed loop).
    // Mid-line keystrokes now cost zero layout; actual wraps stamp
    // __vsInputResizeAt so the scroll handler can tell resize-drift from
    // user scrolling (displacement is not intent, 2.307.0).
    this._draftTimer = null;
    this._autoSizeRaf = null;
    this._autoSize = () => {
      if (this._autoSizeRaf || this._expanded) return;
      this._autoSizeRaf = requestAnimationFrame(() => {
        this._autoSizeRaf = null;
        const ta = this._textarea;
        if (!ta || this._expanded) return;
        ta.style.height = 'auto';
        const h = Math.min(ta.scrollHeight, 200);
        ta.style.height = h + 'px';
        if (h !== this._lastAutoH) { this._lastAutoH = h; try { window.__vsInputResizeAt = Date.now(); } catch { } }
      });
    };
    this._textarea.addEventListener('input', () => {
      this._autoSize();
      // Debounced draft save
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => saveDraft('chat', this._sessionId, this._textarea.value), 300);
    });

    // Sync draft from other clients via StateSync
    this._draftSyncHandler = (value) => {
      this._textarea.value = value || '';
      this._autoSize?.();
    };
    const sync = getStateSync();
    if (sync) sync.on('drafts', 'chat:' + this._sessionId, this._draftSyncHandler);

    // Slash command dropdown
    this._slashDropdown = document.createElement('div');
    this._slashDropdown.className = 'chat-slash-dropdown hidden';

    // Send: Enter in normal mode, Ctrl+Enter in expanded mode
    // Tab to accept slash autocomplete
    this._textarea.addEventListener('keydown', (e) => {
      if (!this._slashDropdown.classList.contains('hidden')) {
        if (e.key === 'Tab' || e.key === 'Enter') {
          const active = this._slashDropdown.querySelector('.active');
          if (active) { e.preventDefault(); this._textarea.value = active.dataset.cmd + ' '; this._slashDropdown.classList.add('hidden'); return; }
        }
        if (e.key === 'Escape') { this._slashDropdown.classList.add('hidden'); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = [...this._slashDropdown.querySelectorAll('.chat-slash-item')];
          const cur = items.findIndex(i => i.classList.contains('active'));
          items[cur]?.classList.remove('active');
          const next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
          items[next]?.classList.add('active');
          return;
        }
      }
      if (e.isComposing || e.keyCode === 229) return; // IME composing
      // Input history: ArrowUp on empty textarea recalls previous sent message
      if (e.key === 'ArrowUp' && !this._textarea.value.trim() && this._sentHistory?.length) {
        e.preventDefault();
        if (this._historyIdx == null) this._historyIdx = this._sentHistory.length;
        if (this._historyIdx > 0) {
          this._historyIdx--;
          this._textarea.value = this._sentHistory[this._historyIdx];
          this._autoSize?.();
        }
        return;
      }
      if (e.key === 'ArrowDown' && this._historyIdx != null) {
        e.preventDefault();
        this._historyIdx++;
        if (this._historyIdx >= this._sentHistory.length) {
          this._historyIdx = null;
          this._textarea.value = '';
        } else {
          this._textarea.value = this._sentHistory[this._historyIdx];
        }
        this._autoSize?.();
        return;
      }
      if (this._historyIdx != null && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') this._historyIdx = null;
      if (this._expanded) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._send(); }
      } else {
        if (e.key === 'Enter' && !e.shiftKey) {
          // Touch soft keyboards have no Shift — their enter key is the only
          // way to type a newline, so by default it inserts one and sending
          // is the button (2.234.0, real report "点换行之后就发出了").
          // chat.touchEnterSends opts back into enter-to-send.
          if (this._isTouch() && !this._getTouchEnterSends()) return;
          e.preventDefault(); this._send();
        }
      }
    });

    // Slash command autocomplete on input
    this._textarea.addEventListener('input', () => {
      const val = this._textarea.value;
      if (val.startsWith('/') && !val.includes(' ') && this._slashCommands.length) {
        const q = val.toLowerCase();
        const matches = val === '/' ? this._slashCommands : this._slashCommands.filter(c => c.toLowerCase().startsWith(q));
        if (matches.length > 0) {
          this._slashDropdown.innerHTML = matches.slice(0, 10).map((c, i) =>
            `<div class="chat-slash-item${i === 0 ? ' active' : ''}" data-cmd="${escHtml(c)}">${escHtml(c)}</div>`
          ).join('');
          this._slashDropdown.classList.remove('hidden');
        } else {
          this._slashDropdown.classList.add('hidden');
        }
      } else {
        this._slashDropdown.classList.add('hidden');
      }
    });

    // Input wrapper (for floating expand button inside textarea)
    const inputWrap = document.createElement('div');
    inputWrap.className = 'chat-input-wrap';

    const expandBtn = document.createElement('button');
    expandBtn.className = 'chat-expand-btn';
    expandBtn.textContent = '\u2922';
    expandBtn.title = t('Expand editor');
    expandBtn.onclick = () => {
      this._expanded = !this._expanded;
      if (this._expanded) {
        this._textarea.style.height = '200px';
        this._textarea.style.minHeight = '200px';
        this._textarea.classList.add('chat-input-expanded');
        expandBtn.textContent = '\u2923';
        expandBtn.title = t('Collapse editor');
        this._shortcutHint.textContent = 'Ctrl+\u23CE';
      } else {
        this._textarea.classList.remove('chat-input-expanded');
        this._textarea.style.minHeight = '';
        this._textarea.style.height = '';
        expandBtn.textContent = '\u2922';
        expandBtn.title = t('Expand editor');
        this._shortcutHint.textContent = '\u23CE';
      }
      this._textarea.focus();
    };

    this._slashDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.chat-slash-item');
      if (item) { this._textarea.value = item.dataset.cmd + ' '; this._slashDropdown.classList.add('hidden'); this._textarea.focus(); }
    });
    // Image upload button (visible on mobile, hidden on desktop where paste works)
    const attachBtn = document.createElement('button');
    attachBtn.className = 'chat-attach-btn';
    attachBtn.title = t('Attach image');
    attachBtn.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="1.5"/><circle cx="5.5" cy="5.5" r="1.5"/><path d="M14 10.5l-3-3-4 4-2-2-3 3"/></svg>';
    const attachInput = document.createElement('input');
    attachInput.type = 'file';
    attachInput.accept = 'image/*';
    attachInput.multiple = true;
    attachInput.style.display = 'none';
    attachBtn.onclick = () => attachInput.click();
    attachInput.onchange = () => {
      for (const file of attachInput.files) this._addImageAttachment(file);
      attachInput.value = '';
    };

    // Upload file/folder to the session's working directory, then insert its
    // path into the input. Click → menu (also the mobile entry point); desktop
    // also supports drag-and-drop (wired by ChatView onto the whole chat view).
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'chat-attach-btn';
    uploadBtn.title = t('Upload file/folder to working directory');
    uploadBtn.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 4L5 8.5a2.5 2.5 0 003.5 3.5L13 7.5a4 4 0 00-5.7-5.7L3 6.2"/></svg>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    const dirInput = document.createElement('input');
    dirInput.type = 'file'; dirInput.setAttribute('webkitdirectory', ''); dirInput.style.display = 'none';
    fileInput.onchange = () => { if (fileInput.files.length) this.uploadFiles([...fileInput.files]); fileInput.value = ''; };
    dirInput.onchange = () => { if (dirInput.files.length) this.uploadFiles([...dirInput.files]); dirInput.value = ''; };
    uploadBtn.onclick = (e) => {
      e.preventDefault();
      const r = uploadBtn.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 4, [
        { label: t('Upload file(s)'), action: () => fileInput.click() },
        { label: t('Upload folder'), action: () => dirInput.click() },
      ]);
    };

    inputWrap.append(attachBtn, attachInput, uploadBtn, fileInput, dirInput, this._textarea, expandBtn, this._slashDropdown);

    const sendCol = document.createElement('div');
    sendCol.className = 'chat-send-col';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = '\u25B6';
    sendBtn.title = t('Send');
    sendBtn.onclick = () => this._send();
    this._shortcutHint = document.createElement('div');
    this._shortcutHint.className = 'chat-shortcut-hint';
    this._shortcutHint.textContent = '\u23CE';

    sendCol.append(sendBtn, this._shortcutHint);

    // TODO display (above streaming status)
    this._todoDisplay = document.createElement('div');
    this._todoDisplay.className = 'chat-todo-display hidden';
    this._todoContainer = null; // set externally for popup positioning

    // Streaming status indicator (above input)
    this._streamStatus = document.createElement('div');
    this._streamStatus.className = 'chat-stream-status hidden';

    // QUEUE STRIP: what the user sent DURING the running turn and has not run
    // yet. Above everything else in the input area — it is about the messages
    // already sent, not about the one being typed.
    this._queueStrip = document.createElement('div');
    this._queueStrip.className = 'chat-queue-strip hidden';

    inputArea.append(this._queueStrip, this._attachArea, this._todoDisplay, this._streamStatus, inputWrap, sendCol);
  }

  /** The .chat-input-area wrapper element */
  get element() { return this._element; }


  // ── Upload files/folders to the session cwd, then insert their path(s) ──
  // Called by the upload button, the folder picker, and ChatView's drag-drop.
  // Each File may carry `_relPath` (drag-dropped folder) or `webkitRelativePath`
  // (folder picker); preservePaths is inferred so the folder tree is recreated
  // under cwd. After upload, the top-level path(s) are inserted at the cursor.
  async uploadFiles(files) {
    files = (files || []).filter(Boolean);
    if (!files.length) return;
    const cwd = this._getCwd();
    if (!cwd) { this._uploadToast(t('No working directory for this session'), true); return; }
    // Destination: the session cwd by default, or a fixed folder from
    // `chat.uploadDir` — absolute (/… or ~/…) as-is, otherwise relative to cwd.
    const destDir = this._resolveUploadDir(cwd);
    this._uploadToast(files.length > 1 ? t('Uploading {n} items…', { n: files.length }) : t('Uploading {n} item…', { n: files.length }));
    try {
      // Chunked + per-file fallback: a folder with one unreadable file (the
      // usual net::ERR_ACCESS_DENIED cause) no longer fails the whole upload.
      const { uploaded, failed } = await uploadFilesBatched(files, {
        destDir,
        host: this._getHost(), // remote sessions: upload lands on the host, not locally
        onProgress: (d, total) => this._uploadToast(t('Uploading {d}/{total}…', { d, total })),
      });
      if (uploaded.length) this._insertUploadedPaths(destDir, uploaded);
      if (failed.length) {
        this._uploadToast(t("Uploaded {n}, {failed} couldn't be read (e.g. {name})", { n: uploaded.length, failed: failed.length, name: failed[0].name }), true);
      } else if (!uploaded.length) {
        this._uploadToast(t('Upload failed — no files could be read'), true);
      } else {
        this._uploadToast(null);
      }
    } catch (e) {
      this._uploadToast(t('Upload failed: {msg}', { msg: e.message }), true);
    }
  }

  // Resolve the configured upload folder against the session cwd. Empty →
  // cwd (default). Absolute (/… or ~/…, the server expands ~ to ITS home) →
  // used verbatim. Relative → joined under cwd (one collect-here folder, e.g.
  // "Downloads"). For remote sessions the path is on the remote, same as cwd.
  _resolveUploadDir(cwd) {
    const d = (this._getUploadDir() || '').trim();
    if (!d) return cwd;
    if (d.startsWith('/') || d.startsWith('~')) return d;
    return cwd.replace(/\/+$/, '') + '/' + d.replace(/^\/+/, '');
  }

  _insertUploadedPaths(cwd, uploaded) {
    const base = cwd.replace(/\/+$/, '');
    // One entry per top-level item: a file → its own path; a folder → the folder
    // root (deduped across all its uploaded files).
    const tops = new Set();
    for (const f of uploaded) { const first = (f.name || '').split('/')[0]; if (first) tops.add(first); }
    if (!tops.size) return;
    const quote = (p) => /[\s'"$`\\()]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
    const text = [...tops].map((t) => quote(base + '/' + t)).join(' ');
    const ta = this._textarea;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const sep = (before && !/\s$/.test(before)) ? ' ' : '';
    const inserted = sep + text + ' ';
    ta.value = before + inserted + after;
    const pos = (before + inserted).length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch {}
    ta.dispatchEvent(new Event('input', { bubbles: true })); // resize + draft save
  }

  _uploadToast(msg, isError) {
    if (!this._uploadToastEl) {
      this._uploadToastEl = document.createElement('div');
      this._uploadToastEl.className = 'chat-upload-toast hidden';
      this._element.appendChild(this._uploadToastEl);
    }
    const el = this._uploadToastEl;
    if (this._uploadToastTimer) { clearTimeout(this._uploadToastTimer); this._uploadToastTimer = null; }
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.toggle('chat-upload-toast-error', !!isError);
    el.classList.remove('hidden');
    if (isError || !/…$/.test(msg)) this._uploadToastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }


  /** Whether currently streaming */
  get isStreaming() { return this._isStreaming; }

  /** Set the container element for popup positioning (the .chat-view) */
  set popupContainer(el) { this._todoContainer = el; }

  // ── Public API ──

  showTyping(label = t('thinking...'), kind = null) {
    if (!this._streamStatus) return;
    // A TEXT CHANGE NEVER REBUILDS THE BUTTON (2026-09-07 r2 — the live
    // sub-agent counter's own regression, caught by the adversarial verifier).
    // The view re-asserts this line every second while collab traffic ticks
    // and the label CHANGES on every tick (the age), so an "unchanged label"
    // memo can never protect anything: a blind innerHTML rewrite destroyed
    // `.chat-interrupt-btn` once a second. A mousedown whose target leaves the
    // DOM before mouseup fires `click` on the common ancestor (.chat-stream-
    // status, no handler) — the interrupt is lost with no toast and no log
    // (measured: 6/10 trusted clicks delivered while ticking, 10/10 with a
    // stable node; keyboard focus on Stop died within 1.4s, i.e. 100%) in
    // exactly the moment the user believes the turn is wedged and reaches for
    // Stop. So while the turn streams, the button is still there and the KIND
    // (which decides what the button DOES) is unchanged, write ONLY the label
    // text — the button node, its focus and the two-step compaction ARM all
    // survive. _showPending's button-less line has no `.chat-interrupt-btn`,
    // so it always falls through to the full render.
    const liveBtn = this._isStreaming ? this._streamStatus.querySelector('.chat-interrupt-btn') : null;
    const labelEl = liveBtn && this._typingKind === kind ? this._streamStatus.querySelector('.chat-stream-label') : null;
    if (labelEl) {
      if (this._typingLabel !== label) { labelEl.textContent = label; this._typingLabel = label; }
      this._pendingLine = false;
      this._streamStatus.classList.remove('hidden');
      return;
    }
    this._typingLabel = label;
    this._typingKind = kind;
    this._pendingLine = false; // a real turn owns the line now (see _clearPending)
    // Remembered so the button can be re-rendered in place when the pending
    // Stop state ends (the label keeps changing under it while the turn runs).
    this._typingLabel = label; this._typingKind = kind;
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> <span class="chat-stream-label">${escHtml(label)}</span><button class="chat-interrupt-btn" title="${escHtml(t('Interrupt'))}">\u25A0 ${escHtml(t('Stop'))}</button>`;
    const btn = this._streamStatus.querySelector('.chat-interrupt-btn');
    // A STOP ALREADY IN FLIGHT OWNS THE BUTTON (round-3 review). showTyping is
    // re-run on every label change, so re-applying the pending state HERE is
    // what makes it stick: without it the next "thinking\u2026" repaint handed back
    // a fresh, clickable Stop in the middle of the very window it guards.
    if (this._stopPending) { this._applyStopPending(btn); this._streamStatus.classList.remove('hidden'); this._isStreaming = true; return; }
    if (kind === 'compacting') {
      // Two-step Stop while a compaction runs (2.365.0): the CLI's only
      // "Compaction canceled." path is an abort signal, and a large
      // conversation compacts for 1–2 minutes — one reflexive click threw the
      // whole attempt away (the userN incident). Arm, then confirm.
      btn.title = t('Click again to cancel the running compaction');
      btn.onclick = () => {
        if (btn.dataset.armed) { this._fireInterrupt(); return; }
        btn.dataset.armed = '1';
        btn.classList.add('chat-interrupt-armed');
        btn.textContent = t('Cancel compaction?');
        setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.armed;
          btn.classList.remove('chat-interrupt-armed');
          btn.textContent = '\u25A0 ' + t('Stop');
        }, 4000);
      };
    } else {
      btn.onclick = () => this._fireInterrupt();
    }
    this._streamStatus.classList.remove('hidden');
    this._isStreaming = true;
  }

  /** Programmatic send through the FULL _send path (draft keep, history ring,
   *  dead-socket defenses) — for in-chat action buttons such as Compact now. */
  sendText(text) {
    if (!this._textarea) return;
    this._textarea.value = String(text || '');
    this._send();
  }

  hideTyping() {
    if (!this._streamStatus) return;
    // The turn ended — whatever the Stop was waiting for has happened. Clear
    // the streaming flag FIRST: _endStopPending repaints a live status line,
    // and this one is on its way out.
    this._isStreaming = false;
    this._endStopPending();
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
    this._typingLabel = null;
    this._typingKind = null;
  }

  // ── Stop, once (round-3 review) ─────────────────────────────────────────
  // Between the click and the turn actually ending there is a REAL window: the
  // codex wrapper empties the app-server queue first and that sweep is capped
  // at ~6s against a wedged app-server (and the claude lane's own §11
  // delayed-fallback SIGINT is 2s behind the protocol interrupt). A second
  // click inside it is a second `interrupt` frame — the wrapper now coalesces
  // duplicates, but the honest fix is for the button to SAY it is working
  // instead of inviting the click. Bounded by construction: the state is
  // cleared by the turn ending (hideTyping, which every end — result,
  // task_failed, interrupted — reaches) OR by the fallback timer, so it can
  // never wedge the only control that stops a running agent.
  // A second attached client's Stop is unaffected: it is a different browser,
  // and the wrapper's single-flight is what makes those two frames one sweep.
  static get STOP_PENDING_MS() { return 8000; }

  _fireInterrupt() {
    if (this._stopPending) return;
    this._stopPending = true;
    this._applyStopPending();
    clearTimeout(this._stopPendingTimer);
    this._stopPendingTimer = setTimeout(() => {
      this._stopPendingTimer = null;
      // The turn outlived the whole interrupt budget: hand the control back
      // rather than leave a dead button (it may be the retry that lands).
      this._endStopPending();
    }, ChatInput.STOP_PENDING_MS);
    this._onInterrupt?.();
  }

  /** Paint the in-flight Stop: disabled, and saying what it is doing. */
  _applyStopPending(btn) {
    const el = btn || this._streamStatus?.querySelector('.chat-interrupt-btn');
    if (!el) return;
    el.disabled = true;
    el.onclick = null;
    delete el.dataset.armed;
    el.classList.remove('chat-interrupt-armed');
    el.classList.add('chat-interrupt-pending');
    el.textContent = t('Stopping…');
    el.title = t('Stopping the current turn…');
  }

  /** Leave the pending state and give the live button back (same label). */
  _endStopPending() {
    clearTimeout(this._stopPendingTimer);
    this._stopPendingTimer = null;
    if (!this._stopPending) return;
    this._stopPending = false;
    if (this._isStreaming) {
      // The 2.369.57 label-only repaint keeps an EXISTING button untouched —
      // which here is the disabled "Stopping…" one. Drop it first so showTyping
      // takes its full-render path and hands back a live Stop (the 8 s fallback
      // and a turn boundary both come through here; a dead button after either
      // is the exact wedge this state promised never to produce).
      this._streamStatus?.querySelector('.chat-interrupt-btn')?.remove();
      this.showTyping(this._typingLabel ?? t('thinking...'), this._typingKind ?? null);
    }
  }

  /** The label currently on the stream-status line (null = not streaming). */
  get typingLabel() { return this._isStreaming ? this._typingLabel : null; }

  updateTodos(todos) {
    this._todos = todos;
    this._updateTodoDisplay();
  }

  setSlashCommands(cmds) {
    this._slashCommands = cmds;
  }

  setReadOnly() {
    if (this._textarea) {
      this._textarea.disabled = true;
      this._textarea.placeholder = t('Session ended');
    }
    this._element.style.display = 'none';
  }

  setDisconnected(disconnected) {
    // Keep the textarea fully editable — the user must be able to select/copy
    // (a disabled textarea blocks selection) and keep drafting; only SENDING
    // is blocked (guarded in _send). Drafts queue via ws.pending and sync on
    // reconnect.
    this._disconnected = disconnected;
    this._element.classList.toggle('chat-input-disconnected', disconnected);
    if (disconnected && this._pendingSend) {
      // The socket died with a send still unconfirmed — the message may never
      // have reached the server. Restore the text (draft was never cleared)
      // so the user can re-send after checking the conversation; without this
      // the prompt vanished with zero trace.
      const { text } = this._pendingSend;
      this._pendingSend = null;
      if (text && !this._textarea.value.trim()) {
        this._textarea.value = text;
        this._textarea.dispatchEvent(new Event('input', { bubbles: true })); // resize + draft save
      }
      this.hideTyping();
      showToast(t('Connection lost — your message may not have been sent; the text was restored to the input'), { type: 'error' });
    }
    if (disconnected && this._pendingGoal) {
      // Same class as the unconfirmed send above — don't make the user wait out
      // the 10s timer when the socket is already known dead.
      clearTimeout(this._goalTimer);
      this._goalTimer = null;
      const { text } = this._pendingGoal;
      this._pendingGoal = null;
      this._clearPending();
      if (text && !this._textarea.value.trim()) {
        this._textarea.value = text;
        this._textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      showToast(t('Connection lost before the goal was set — your command was restored to the input'), { type: 'error' });
    }
  }

  // Called by ChatView when server traffic for this session arrives: the send
  // that preceded it demonstrably reached the server, so the deferred draft
  // clear can finalize.
  confirmDelivery() {
    if (!this._pendingSend) return;
    this._pendingSend = null;
    clearDraft('chat', this._sessionId);
  }

  // /goal has no ack of its own — the server's goal-updated broadcast IS the
  // confirmation (it answers status/resume/set/clear alike). Until it lands we
  // keep the typed command as a draft and show a pending line; 10s of silence
  // means the session never processed it (dead wrapper / stale session id).
  _markGoalPending(text) {
    clearTimeout(this._goalTimer);
    saveDraft('chat', this._sessionId, text);
    this._pendingGoal = { text };
    this._showPending(t('Setting goal…'));
    this._goalTimer = setTimeout(() => {
      const pending = this._pendingGoal;
      this._pendingGoal = null;
      this._goalTimer = null;
      this._clearPending();
      if (!pending) return;
      if (!this._textarea.value.trim()) {
        this._textarea.value = pending.text;
        this._textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      showToast(t('Goal not confirmed — the session may be unresponsive. Your command was restored to the input.'), { type: 'error' });
    }, 10000);
  }

  confirmGoal() {
    if (!this._pendingGoal) return;
    clearTimeout(this._goalTimer);
    this._goalTimer = null;
    this._pendingGoal = null;
    this._clearPending();
    clearDraft('chat', this._sessionId);
  }

  // Transient "still working on it" line in the stream-status slot. Deliberately
  // WITHOUT the interrupt button showTyping renders — there is no turn to stop.
  _showPending(label) {
    if (!this._streamStatus) return;
    this._typingLabel = null; // this line has no Stop button — showTyping must fall through to a full render
    this._pendingLine = true;
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> ${escHtml(label)}`;
    this._streamStatus.classList.remove('hidden');
  }

  _clearPending() {
    // Only clear OUR line: a real turn may have started streaming meanwhile
    // (a /goal set immediately provokes one) and must keep its indicator.
    if (!this._streamStatus || !this._pendingLine) return;
    this._pendingLine = false;
    if (this._streamStatus.querySelector('.chat-interrupt-btn')) return;
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
  }

  focus() {
    if (this._textarea) this._textarea.focus();
  }

  dispose() {
    if (this._goalTimer) { clearTimeout(this._goalTimer); this._goalTimer = null; }
    if (this._stopPendingTimer) { clearTimeout(this._stopPendingTimer); this._stopPendingTimer = null; }
    if (this._draftSyncHandler) {
      const sync = getStateSync();
      if (sync) sync.off('drafts', 'chat:' + this._sessionId, this._draftSyncHandler);
    }
  }

  // ── Private ──

  _send() {
    const text = this._textarea.value.trim();
    const hasAttachments = this._attachments.length > 0;
    if (!text && !hasAttachments) return;
    if (this._disconnected) {
      showToast(t('Disconnected — reconnecting… your draft is kept'), { type: 'error' });
      return;
    }

    // Intercept /goal command — handled by wrapper, not sent as chat message
    const goalMatch = text.match(/^\/goal(?:\s+(.*))?$/s);
    if (goalMatch) {
      const goalArg = (goalMatch[1] || '').trim();
      if (!goalArg) {
        this._ws.send({ type: 'set-goal', sessionId: this._sessionId, action: 'status' });
      } else if (goalArg === 'clear') {
        this._ws.send({ type: 'set-goal', sessionId: this._sessionId, goal: null });
      } else if (goalArg === 'resume') {
        this._ws.send({ type: 'set-goal', sessionId: this._sessionId, action: 'resume' });
      } else {
        this._ws.send({ type: 'set-goal', sessionId: this._sessionId, goal: goalArg });
      }
      this._textarea.value = '';
      this._textarea.style.height = '';
      // Fire-and-forget before: ws.send has no ack, and the server silently
      // does NOTHING when the session isn't a live chat session (dead wrapper,
      // stale webui id) — the typed goal vanished with no pending state, no
      // error and no way to notice. The draft is kept until the goal-updated
      // broadcast (confirmGoal) proves it landed; a 10s silence restores the
      // text and says so. Same shape as the _pendingSend defense below.
      this._markGoalPending(text);
      return;
    }

    const msgId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // Save to input history (ring buffer, max 50)
    if (text) {
      if (!this._sentHistory) this._sentHistory = [];
      this._sentHistory.push(text);
      if (this._sentHistory.length > 50) this._sentHistory.shift();
      this._historyIdx = null;
    }

    this._textarea.value = '';
    this._textarea.style.height = '';
    this._textarea.style.minHeight = '';
    // DEFERRED draft clear (restart audit): ws.send has no ack — a message
    // written into a half-open socket (server died, onclose not yet fired,
    // up to the 30s-heartbeat window for remote clients) vanishes silently,
    // and the immediately-cleared draft made the loss total: the server echo
    // IS the render, so nothing ever marked it. Keep the draft until inbound
    // traffic proves the send got through (confirmDelivery — TCP ordering:
    // anything the server answers on this socket arrived AFTER our send); if
    // the connection drops first, setDisconnected restores the text.
    // A pending 300ms autosave would read the now-empty textarea and wipe the
    // kept draft — cancel it and pin the draft to exactly what was sent (the
    // debounced autosave can lag behind fast typing).
    clearTimeout(this._draftTimer);
    if (text) saveDraft('chat', this._sessionId, text);
    this._pendingSend = { text };
    if (this._expanded) {
      this._expanded = false;
      this._textarea.classList.remove('chat-input-expanded');
      const eb = this._textarea.parentElement?.querySelector('.chat-expand-btn');
      if (eb) { eb.textContent = '\u2922'; eb.title = t('Expand editor'); }
      this._shortcutHint.textContent = '\u23CE';
    }

    if (hasAttachments) {
      const content = [];
      for (const a of this._attachments) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
      }
      if (text) content.push({ type: 'text', text });
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
      this._ws.send({ type: 'chat-input', sessionId: this._sessionId, text: msg, msgId });
      this._attachments = [];
      this._renderAttachments();
    } else {
      this._ws.send({ type: 'chat-input', sessionId: this._sessionId, text, msgId });
    }

    // Notify parent to handle scroll/pin
    this._onSend();
    // A /compact send shows its own label immediately (the server broadcasts
    // the same kind to other clients) so the minute-long run is never a bare
    // "thinking…" with an unguarded Stop.
    if (/^\/compact\b/.test(text)) this.showTyping(t('Compacting context… (a large conversation takes 1–2 minutes — Stop cancels it)'), 'compacting');
    else this.showTyping(t('thinking...'));
  }

  _addImageAttachment(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const mediaType = file.type || 'image/png';
      const attachment = { base64, mediaType, dataUrl, name: file.name || 'image' };
      this._attachments.push(attachment);
      this._renderAttachments();
      this._textarea.focus();
    };
    reader.readAsDataURL(file);
  }

  _renderAttachments() {
    this._attachArea.innerHTML = '';
    if (!this._attachments.length) { this._attachArea.classList.add('hidden'); return; }
    this._attachArea.classList.remove('hidden');
    for (let i = 0; i < this._attachments.length; i++) {
      const a = this._attachments[i];
      const item = document.createElement('div');
      item.className = 'chat-attach-item';
      item.innerHTML = `<img src="${a.dataUrl}" alt="${escHtml(a.name)}"><span class="chat-attach-name">${escHtml(a.name)}</span>`;
      // Click the chip → full-size zoom (2.228.2, user request): a pasted
      // screenshot's ~28px preview is unverifiable — you want to confirm you
      // pasted the RIGHT image BEFORE sending it to the model.
      item.title = t('Click to view full size');
      item.style.cursor = 'zoom-in';
      item.onclick = () => showImageOverlay(a.dataUrl);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chat-attach-remove';
      removeBtn.textContent = '\u2715';
      removeBtn.title = t('Remove');
      removeBtn.onclick = (e) => { e.stopPropagation(); this._attachments.splice(i, 1); this._renderAttachments(); };
      item.appendChild(removeBtn);
      this._attachArea.appendChild(item);
    }
  }

  /** The input queue + what this harness lets the user DO with it.
   *  caps = backend-caps `inputModes` projected onto the client (agent-meta). */
  setQueue(items, caps) {
    this._queue = Array.isArray(items) ? items : [];
    if (caps) this._queueCaps = { steer: !!caps.steer, queueOps: !!caps.queueOps };
    this._renderQueue();
  }

  _renderQueue() {
    const strip = this._queueStrip;
    if (!strip) return;
    const items = this._queueCaps.queueOps ? this._queue : [];
    if (!items.length) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
    strip.classList.remove('hidden');
    strip.innerHTML = ChatInput.queueStripHtml(items, this._queueCaps);
    strip.querySelectorAll('[data-queue-op]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this._onQueueOp?.(btn.dataset.queueOp, btn.dataset.queueId || null);
      };
    });
    // Enter on a focused row steers it (the row itself is the target — the
    // buttons handle their own Enter as ordinary button activation).
    strip.querySelectorAll('.chat-queue-item').forEach((row) => {
      row.onkeydown = (e) => {
        if (e.key !== 'Enter' || e.target !== row) return;
        e.preventDefault();
        if (this._queueCaps.steer) this._onQueueOp?.('steer', row.dataset.queueId || null);
      };
    });
  }

  /** PURE markup for the strip (DOM-free testable; every interpolation escaped
   *  — a queue preview is message text and syncs to every client). */
  static queueStripHtml(items, caps = {}) {
    const head = `<div class="chat-queue-head">${UI_ICONS.queue}<span>${escHtml(t('{n} queued — runs after this turn', { n: items.length }))}</span>${
      caps.steer && items.length > 1
        ? `<button type="button" class="chat-queue-all" data-queue-op="steer-all" title="${escHtml(t('Inject every queued message into the running turn, in order'))}">${UI_ICONS.bolt}<span>${escHtml(t('Steer all'))}</span></button>`
        : ''
    }</div>`;
    const rows = items.map((it) => {
      const id = escHtml(String(it.id || ''));
      const from = it.kind === 'peer' && it.from ? `<span class="chat-queue-from">${escHtml(String(it.from))}</span>` : '';
      const steer = caps.steer
        ? `<button type="button" class="chat-queue-btn" data-queue-op="steer" data-queue-id="${id}" title="${escHtml(t('Steer now — the agent sees it at its next reply'))}" aria-label="${escHtml(t('Steer now — the agent sees it at its next reply'))}">${UI_ICONS.bolt}</button>`
        : '';
      return `<div class="chat-queue-item" tabindex="0" data-queue-id="${id}">${from}<span class="chat-queue-preview">${escHtml(String(it.preview || ''))}</span>${steer}<button type="button" class="chat-queue-btn chat-queue-btn-remove" data-queue-op="remove" data-queue-id="${id}" title="${escHtml(t('Remove'))}" aria-label="${escHtml(t('Remove'))}">${UI_ICONS.close}</button></div>`;
    }).join('');
    return head + rows;
  }

  _updateTodoDisplay() {
    if (!this._todoDisplay) return;
    if (!this._todos?.length) { this._todoDisplay.classList.add('hidden'); return; }
    const inProgress = this._todos.find(t => t.status === 'in_progress');
    const completed = this._todos.filter(t => t.status === 'completed').length;
    const total = this._todos.length;
    if (!inProgress && completed === total) { this._todoDisplay.classList.add('hidden'); return; }
    const label = inProgress ? inProgress.activeForm || inProgress.content : t('{completed}/{total} done', { completed, total });
    const icon = inProgress ? UI_ICONS.hourglass : UI_ICONS.check;
    this._todoDisplay.innerHTML = `<span class="chat-todo-current">${icon} ${escHtml(label)} <span class="chat-status-dim">(${completed}/${total})</span></span>`;
    this._todoDisplay.classList.remove('hidden');
    this._todoDisplay.onclick = (e) => {
      e.stopPropagation();
      const container = this._todoContainer || this._element.parentElement;
      const existing = container.querySelector('.chat-todo-popup');
      if (existing) { existing.remove(); return; }
      const popup = document.createElement('div');
      popup.className = 'chat-todo-popup';
      popup.dataset.popover = '1'; // app-wide Escape-dismiss protocol (app.js removes [data-popover])
      for (const t of this._todos) {
        const icon = t.status === 'completed' ? UI_ICONS.check : t.status === 'in_progress' ? UI_ICONS.hourglass : UI_ICONS.circle;
        const item = document.createElement('div');
        item.className = `chat-todo-item chat-todo-${t.status}`;
        item.innerHTML = `${icon} <span>${escHtml(t.content)}</span>`;
        popup.appendChild(item);
      }
      const rect = this._todoDisplay.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      popup.style.position = 'absolute';
      popup.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
      popup.style.left = '12px';
      popup.style.right = '12px';
      container.appendChild(popup);
      const close = (ev) => { if (!popup.contains(ev.target) && !this._todoDisplay.contains(ev.target)) { popup.remove(); document.removeEventListener('mousedown', close); } };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    };
  }
}
