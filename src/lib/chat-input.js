import { escHtml, saveDraft, loadDraft, clearDraft, getStateSync, showContextMenu, showToast, uploadFilesBatched, showImageOverlay } from './utils.js';
import { UI_ICONS } from './icons.js';
import { composerSendModes } from './agent-meta.js';
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
  constructor(ws, sessionId, { onSend, onInterrupt, getCwd, getHost, getUploadDir, isTouch, getTouchEnterSends, onQueueOp, onSteerChord, onSteerSend }) {
    this._ws = ws;
    this._sessionId = sessionId;
    this._onSend = onSend;
    this._onInterrupt = onInterrupt;
    this._getCwd = getCwd || (() => null);
    this._getHost = getHost || (() => null);
    this._getUploadDir = getUploadDir || (() => '');
    this._isTouch = isTouch || (() => false);
    this._getTouchEnterSends = getTouchEnterSends || (() => false);
    this._onQueueOp = onQueueOp || null;   // (op, id, extra) → ws 'queue-op'
    // THE CHORD (2026-09-07 owner ask). `onSteerChord` routes the composer's
    // Alt+Enter through the SAME command the registered keybinding runs
    // ('chat.steerNow' — one verb, one place a plugin can rebind); without a
    // host (standalone ChatInput) it falls back to acting directly.
    this._onSteerChord = onSteerChord || null;
    // …and `onSteerSend` is the other half: a steer names a QUEUED ITEM, so the
    // chord SENDS on the ordinary path and hands the msgId to the view, which
    // converts it the moment the harness reports it queued.
    this._onSteerSend = onSteerSend || null;
    this._queue = [];
    this._queueCaps = { queue: false, steer: false, queueOps: false, queueVerbs: [] };
    // Per-ROW TRANSIENT OP state, keyed by the app-server's queue id:
    // 'pending' (an op is in flight) or 'refused' (its result said no, with
    // the sentence in `title`). A row that leaves the queue loses its state —
    // see setQueue.
    // EDIT MODE IS NOT ONE OF THESE VALUES (round-4 verifier). It used to be
    // a third one, which made the ONLY on-screen signal that an edit is open
    // — the edit→cancel control and the "send to save" hint — derived from
    // the state every dispatch and every refusal OVERWRITES: a batch verb
    // (run-all / steer-all) marks EVERY row pending, a refusal on the edited
    // row marks it refused, and the indicator silently vanished while the
    // textarea still held the rewrite. The pencil then came back over a live
    // edit, and clicking it replaced the user's words with the queued
    // message's own text (law ②: the box is the only place that rewrite
    // lives). The two are now orthogonal and a row renders BOTH.
    this._queueRowState = new Map();
    // THE EDIT-MODE STATE — its own field, never a row-state value: the row
    // whose text the textarea currently holds. Every on-screen edit signal is
    // derived from THIS (see queueStripHtml's `editingId`), and only
    // _beginQueueEdit / _cancelQueueEdit / _send / _resolvePendingEdit /
    // _abandonEditOfDroppedRow may move it.
    this._editingQueueId = null;
    this._editDraftBefore = null;    // what was in the textarea before editing began
    // The queued message's OWN text as the editor opened it. It is what tells
    // "the user rewrote this" from "the box still holds the original", which
    // is the whole difference between a cancel that may restore the pre-edit
    // draft and one that must not (setQueue's dropped-row branch, round-3).
    this._editOriginalText = null;
    // An edit whose frame is OUT but whose RESULT has not landed:
    // {id, text, raw, original, draftBefore}. The typed rewrite lives here
    // (and stays in the textarea) until the wrapper's answer proves it landed
    // — see _resolvePendingEdit. `text` is what was SENT (trimmed); `raw` is
    // what is in the BOX, and only `raw` may be compared against the textarea.
    this._pendingEdit = null;
    this._queueDrag = null;          // {id, ctl, ...} while a reorder drag runs

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
      this._draftTimer = null;
      // EDIT MODE BORROWS THE TEXTAREA, NOT THE DRAFT CHANNEL (round-2
      // verifier): while a queued message is being rewritten, what is in the
      // box is THAT MESSAGE — persisting it as this session's draft would
      // push the queued text into data/drafts.json and, through StateSync,
      // into every other client's input box, while THIS box shows the real
      // draft again the moment the edit ends. The pre-edit draft is held in
      // `_editDraftBefore` / `_pendingEdit.draftBefore` and restored from
      // there; the store keeps whatever it had.
      if (this._editingQueueId || this._pendingEdit) return;
      this._draftTimer = setTimeout(() => saveDraft('chat', this._sessionId, this._textarea.value), 300);
    });

    // Sync draft from other clients via StateSync
    this._draftSyncHandler = (value) => {
      // …and the same wall in the other direction: another client's draft must
      // not overwrite a rewrite in progress (the next send would then save the
      // FOREIGN text into the queued message). Land it on the draft we will
      // restore when the edit finishes instead of on the live textarea.
      if (this._pendingEdit) { this._pendingEdit.draftBefore = value || ''; return; }
      if (this._editingQueueId) { this._editDraftBefore = value || ''; return; }
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
      // Editing a queued message: Esc puts the textarea back the way it was.
      if (e.key === 'Escape' && this._editingQueueId) { e.preventDefault(); this._cancelQueueEdit(); return; }
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
      // ── ALT+ENTER = STEER (2026-09-07 owner ask) ────────────────────────
      // While a turn runs, Enter already sends as QUEUED — our default, the
      // one the web/desktop Codex apps use (the TUI's Enter=steer/Tab=queue is
      // a terminal keymap we deliberately do not copy). What was missing is
      // the OTHER mode by keyboard, so: Alt+Enter, and Alt+Enter ONLY. Tab is
      // the slash-command completion (above) and Ctrl/Cmd+Enter keeps meaning
      // send/queue — both would have been silent redefinitions of a key the
      // user already relies on. It must be checked BEFORE the plain-Enter
      // branch below, which tests `!e.shiftKey` and would otherwise swallow
      // Alt+Enter as an ordinary send. GATED ON THE HARNESS CAPS, never on a
      // backend id: where steer is impossible this is not a chord at all and
      // the key does what it always did.
      if (e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && this.steerChordAllowed) {
        e.preventDefault();
        if (this._onSteerChord) this._onSteerChord(); else this.steerNow();
        return;
      }
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

    // TOUCH FACE OF THE CHORD (≤768px): a phone has no Alt key, so the same
    // verb gets a button beside Send. Visibility is split in two: JS owns the
    // CAPABILITY (`.hidden` — can this session steer right now), CSS owns the
    // VIEWPORT (`.chat-attach-btn`'s shape: display:none, shown only under the
    // 768px media query), so neither surface can contradict the other.
    this._steerBtn = document.createElement('button');
    this._steerBtn.className = 'chat-steer-btn hidden';
    this._steerBtn.type = 'button';
    this._steerBtn.title = t('Send now — inject into the running turn');
    this._steerBtn.setAttribute('aria-label', t('Send now — inject into the running turn'));
    this._steerBtn.innerHTML = UI_ICONS.bolt;
    this._steerBtn.onclick = () => { if (this._onSteerChord) this._onSteerChord(); else this.steerNow(); };

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

    // SEND-MODE HINT: one line UNDER the textarea while a turn runs, saying
    // what the two send keys do on THIS harness. Last child + width:100% ⇒ the
    // input area's flex-wrap puts it on its own row below the box.
    this._sendHint = document.createElement('div');
    this._sendHint.className = 'chat-send-hint hidden';

    inputArea.append(this._queueStrip, this._attachArea, this._todoDisplay, this._streamStatus, inputWrap, this._steerBtn, sendCol, this._sendHint);
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
    // THE EDITOR OWNS THE BOX, AND THIS WRITER LANDS LATE (round-6 verifier).
    // Every other programmatic writer runs on the click that caused it; an
    // upload writes the box only after a network round-trip, so an editor
    // opened DURING the upload owns the textarea by the time the paths
    // arrive. Inserting them there put the paths INSIDE the queued message
    // (Send then saved a rewrite the user never typed) and, while a save was
    // in flight, changed the box out from under `_resolvePendingEdit`'s `raw`
    // compare — which reads a changed box as "the user typed something else"
    // and takes the bail-out, so the ok/refused/gone outcomes all silently
    // did nothing. The paths belong to the message being COMPOSED, so they go
    // where that message's text already lives: the stash the edit restores.
    if (this._pendingEdit || this._editingQueueId) { this._stashUploadedPaths(text); return; }
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

  /** Where uploaded paths go when a queued message owns the textarea. Same
   *  landing zone as another client's draft sync (law ②): the stash the edit
   *  will hand back — `_pendingEdit.draftBefore` while a save is in flight,
   *  `_editDraftBefore` while the editor is open — and the draft STORE with
   *  it, because that stash is memory-only and the store is what survives the
   *  window closing (law ② keeps the BOX out of the store for the whole edit,
   *  never the stash: `_beginQueueEdit` pins the store to exactly this value).
   *  The toast names where they went: paths that appear in neither the box nor
   *  the edit are the silent failure with a whole upload behind it. */
  _stashUploadedPaths(text) {
    const append = (prev) => {
      const s = typeof prev === 'string' ? prev : '';
      return (s && !/\s$/.test(s) ? s + ' ' : s) + text + ' ';
    };
    if (this._pendingEdit) this._pendingEdit.draftBefore = append(this._pendingEdit.draftBefore);
    else this._editDraftBefore = append(this._editDraftBefore);
    saveDraft('chat', this._sessionId, this._pendingEdit ? this._pendingEdit.draftBefore : this._editDraftBefore);
    showToast(t('Upload finished while a queued message was open for editing — the paths went to your draft, not into the edit'));
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

  // ── SEND MODES WHILE A TURN RUNS (the Alt+Enter chord + its hint) ────────
  /** The PURE caps→surfaces answer for this session's live queue caps. */
  _sendModes() { return composerSendModes(this._queueCaps); }

  /** May Alt+Enter (and the ≤768px bolt button) act right now? A CAPABILITY
   *  answer only — deliberately not "is there text": the hint and the `when`
   *  predicate must not flicker per keystroke, and an empty composer is
   *  handled by `steerNow()` no-opping exactly like `_send()` does. */
  get steerChordAllowed() { return !!(this._isStreaming && this._sendModes().allowSteerChord); }

  /** THE CHORD'S ACTION. A steer names a QUEUED ITEM (codex's `turn/steer`
   *  takes the app-server's queued-submission id — there is no "send this text
   *  as a steer" verb anywhere), so this sends on the ONE ordinary send path
   *  (draft keep, history ring, dead-socket defenses) and hands the msgId to
   *  the host, which converts it with the SAME 'queue-op' frame the strip
   *  button and the bubble chip use. No second wire shape.
   *  @returns {boolean} whether a message actually went out */
  steerNow() {
    if (!this.steerChordAllowed) return false;
    const r = this._send();
    // ONLY a string is a queueable message's id — `true` means _send took the
    // box for a control frame (/goal, an edit), `false` that it bailed.
    const msgId = typeof r === 'string' ? r : null;
    if (!msgId) return false;   // empty composer / disconnected / not a message — _send already spoke
    this._onSteerSend?.(msgId);
    return true;
  }

  /** Repaint both faces of the chord. Called wherever either input changes:
   *  the streaming flag (showTyping/hideTyping) and the caps (setQueue). */
  _updateSendModes() {
    const modes = this._sendModes();
    const live = !!this._isStreaming;
    if (this._steerBtn) this._steerBtn.classList.toggle('hidden', !(live && modes.allowSteerChord));
    if (!this._sendHint) return;
    const show = live && modes.showHint;
    this._sendHint.classList.toggle('hidden', !show);
    if (!show) { this._sendHint.innerHTML = ''; return; }
    const html = ChatInput.sendHintHtml(modes);
    if (this._sendHintHtml !== html) { this._sendHint.innerHTML = html; this._sendHintHtml = html; }
  }

  /** PURE markup for the hint (DOM-free testable). Each segment is drawn ONLY
   *  where the harness backs it, so the line never teaches a key that does
   *  nothing here. The KEY NAME lives inside the translated phrase (a physical
   *  key is not translated, but "Enter queues" as a sentence is — the owner's
   *  own wording is "Enter 排队 · Alt+Enter 立即注入"). */
  static sendHintHtml(modes = {}) {
    const parts = [];
    if (modes.queueSegment) parts.push(`<span class="chat-send-hint-part">${escHtml(t('Enter queues'))}</span>`);
    if (modes.steerSegment) parts.push(`<span class="chat-send-hint-part">${escHtml(t('Alt+Enter injects now'))}</span>`);
    return parts.join('<span class="chat-send-hint-sep">·</span>');
  }

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
    if (this._stopPending) { this._applyStopPending(btn); this._streamStatus.classList.remove('hidden'); this._isStreaming = true; this._updateSendModes(); return; }
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
    this._updateSendModes();   // the chord and its hint exist only while a turn runs
  }

  /** Programmatic send through the FULL _send path (draft keep, history ring,
   *  dead-socket defenses) — for in-chat action buttons such as Compact now
   *  and the design request. Answers `false` when it REFUSED (nothing typed
   *  was touched), so the control that fired it can stay usable and keep the
   *  words the user typed into IT (chat-renderers re-enables its button;
   *  the design dropdown keeps the brief).
   *
   *  THE EDITOR OWNS THE BOX (round-5 verifier). While a queued message is
   *  open for rewriting (`_editingQueueId`) or its save is unanswered
   *  (`_pendingEdit`), the textarea is not a draft box: it holds THAT
   *  message, and `_send` SAVES it as an `edit` op instead of posting a
   *  message. Writing an action into it did three wrong things at once — the
   *  queued message was silently rewritten to the action's text, the action
   *  never reached the agent, and the unsent rewrite (which law ② deliberately
   *  keeps OUT of the draft store for the whole edit, so it lives nowhere
   *  else) was destroyed. Same answer as the sibling guard in _beginQueueEdit:
   *  refuse OUT LOUD and touch nothing.
   *
   *  AND THE ACTION SPENDS NOTHING OF THE USER'S (same audit). `_send` clears
   *  the box, PINS the draft store to what it sent, and folds any pending
   *  attachments into the frame — so an action fired over a half-typed prompt
   *  used to delete it from both the box and the store, and to hand the user's
   *  pasted screenshots to `/compact`. Both are put back around the send.
   *  The text is an ACTION, never a user command that arms a draft-protected
   *  slot of its own (`/goal`) — those belong on the normal Send path. */
  sendText(text) {
    if (!this._textarea) return false;
    if (this._editingQueueId || this._pendingEdit) {
      showToast(t('Finish or cancel the queued-message edit first — the action was not sent'), { type: 'error' });
      return false;
    }
    const keptText = this._textarea.value;
    const keptAttachments = this._attachments;
    // WHAT THE ACTION IS ABOUT TO DISPLACE, captured BEFORE `_send` runs: the
    // slot (`_send` overwrites `_pendingSend`) and the draft store (`_send`
    // PINS it to the action's own text). Both belong to the user and both are
    // put back below — unconditionally, because "the box was empty" is the
    // ordinary state of an action button, not a case with nothing to restore.
    const prevPendingSend = this._pendingSend;
    const prevDraft = loadDraft('chat', this._sessionId);
    if (keptAttachments.length) { this._attachments = []; this._renderAttachments(); }
    this._textarea.value = String(text || '');
    const sent = this._send() !== false;
    if (keptAttachments.length) { this._attachments = keptAttachments; this._renderAttachments(); }
    // THE BOX COMES BACK UNCONDITIONALLY (round-6 verifier). Gating the
    // restore on `keptText.trim()` covered only the case where there was
    // something to give back — but the ACTION's own text is in the box on
    // every bail-out (`_send` refuses a dead socket before it clears
    // anything), so an EMPTY box was left holding `/compact`, one Enter away
    // from being posted as a chat message, with nothing on screen saying how
    // it got there. Writing `keptText` back is a no-op when `_send` took the
    // box (it already emptied it), so one line answers both halves.
    this._textarea.value = keptText;
    // THE DRAFT SLOT GOES BACK UNCONDITIONALLY TOO (round-7 verifier). `_send`
    // pinned the store to the action's own text and armed `_pendingSend` so a
    // dead socket could restore it — an ACTION is not a user message and owns
    // neither. Leaving the slot armed did two different kinds of damage, and
    // the round-6 fix sat INSIDE `if (keptText.trim())`, so neither was fixed
    // for the ordinary case: an action button clicked over an EMPTY box.
    //   · with an older unconfirmed send, `_send` had OVERWRITTEN its slot, so
    //     a message the USER sent seconds ago lost its dead-socket protection
    //     and its pinned draft — it would vanish with the socket instead of
    //     coming back with its "may not have been sent" notice;
    //   · with NO older send, the action armed the slot for ITSELF, so a later
    //     disconnect typed `/compact` into the user's empty input under a
    //     toast telling them their message had been restored.
    // Handing the previous slot back is exactly the old `= null` when there
    // was none.
    this._pendingSend = prevPendingSend || null;
    if (keptText.trim()) {
      this._autoSize?.();
      // The store is written HERE rather than left to the 300 ms debounce
      // (`_send` cancelled the pending autosave and pinned the store to its
      // own text), so the prompt that came back to the box is durable again.
      saveDraft('chat', this._sessionId, keptText);
    } else {
      // Nothing of the user's was in the box — but the action still pinned the
      // store to its own text, which would come back as this session's draft
      // on the next window open (and, with the slot released, is never cleared
      // by the delivery echo either). Put back what was actually there;
      // `loadDraft` answers '' for "nothing", which is what `clearDraft` writes.
      saveDraft('chat', this._sessionId, prevDraft);
    }
    return sent;
  }

  hideTyping() {
    if (!this._streamStatus) return;
    // The turn ended — whatever the Stop was waiting for has happened. Clear
    // the streaming flag FIRST: _endStopPending repaints a live status line,
    // and this one is on its way out.
    this._isStreaming = false;
    this._updateSendModes();
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

  /** ONE answer to "the text we were holding for you may never have gone out"
   *  — shared by the three places that hold text for an unanswered frame (an
   *  unconfirmed send, and the two `/goal` twins: a dead socket and the 10 s
   *  silence). Each of them independently grew the same shape and then drifted
   *  apart: all three guard the restore on a FREE box (the user keeps drafting
   *  while a frame is out, and those keystrokes are theirs), but two of them
   *  still announced "your command was restored to the input" unconditionally
   *  — a report of a rescue that did not happen, which the user reads as "my
   *  text is safe in the box" and acts on (round-7 verifier).
   *
   *  The sentence is chosen by WHAT ACTUALLY HAPPENED, which is three states,
   *  not two: nothing to restore (`noneMsg` — an attachments-only send carries
   *  text `''`), restored into a free box (`restoredMsg`), or the box was
   *  occupied and left alone (`keptMsg`). `noneMsg` is required of any caller
   *  whose text can be empty; the goal twins pass the `/goal …` command the
   *  regex matched, which is never empty, and say so at the call site.
   *  Answers the outcome so a caller (and a test) can assert on it. */
  _announceUnsent(text, { restoredMsg, keptMsg, noneMsg }) {
    if (!text) {
      showToast(noneMsg || keptMsg, { type: 'error' });
      return 'none';
    }
    if (this._textarea && !this._textarea.value.trim()) {
      this._textarea.value = text;
      this._textarea.dispatchEvent(new Event('input', { bubbles: true })); // resize + draft save
      showToast(restoredMsg, { type: 'error' });
      return 'restored';
    }
    showToast(keptMsg, { type: 'error' });
    return 'kept';
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
      this.hideTyping();
      // …into a box that may already hold the NEXT thing the user typed (they
      // keep drafting while a send is in flight, and `sendText` hands this
      // slot back over a half-typed prompt) — that text is theirs and is not
      // overwritten. THE SENTENCE CHANGES WITH IT (round-6), and the THIRD
      // state is real (round-7): an attachments-only send carries text `''`,
      // so "the input already had text, so it was left alone" was told to
      // users whose input was empty and whose send had no text to restore.
      this._announceUnsent(text, {
        restoredMsg: t('Connection lost — your message may not have been sent; the text was restored to the input'),
        keptMsg: t('Connection lost — your last message may not have been sent (the input already had text, so it was left alone)'),
        noneMsg: t('Connection lost — your last message may not have been sent'),
      });
    }
    if (disconnected && this._pendingEdit) {
      // Same class: the edit frame may never have reached the server, and its
      // result certainly will not arrive on this socket. The rewrite is
      // already in the textarea — end the wait and say so (a row left
      // spinning behind a dead socket is the lie the row state exists to
      // prevent).
      this._resolvePendingEdit(false, t('Connection lost — the edit may not have been saved.'));
    }
    if (disconnected && this._pendingGoal) {
      // Same class as the unconfirmed send above — don't make the user wait out
      // the 10s timer when the socket is already known dead.
      clearTimeout(this._goalTimer);
      this._goalTimer = null;
      const { text } = this._pendingGoal;
      this._pendingGoal = null;
      this._clearPending();
      // Same three-state announcement as the send above — the restore was
      // already guarded on a free box here, only the sentence was not.
      // (`text` is the `/goal …` command the regex matched, never empty.)
      this._announceUnsent(text, {
        restoredMsg: t('Connection lost before the goal was set — your command was restored to the input'),
        keptMsg: t('Connection lost before the goal was set — the input already had text, so your command was left alone'),
      });
    }
  }

  // Called by ChatView when server traffic for this session arrives: the send
  // that preceded it demonstrably reached the server, so the deferred draft
  // clear can finalize.
  confirmDelivery() {
    const pending = this._pendingSend;
    if (!pending) return;
    this._pendingSend = null;
    // THE CLEAR IS TEXT-AWARE (round-6 verifier). This deferred clear exists
    // to remove THE SENT TEXT from the store once delivery is proven — it is
    // not a licence to empty the draft channel. Since `sendText` hands an
    // OLDER unconfirmed send's slot back, the slot that survives an action
    // can be armed while the store already holds a half-typed prompt that was
    // never sent (the action put it back there); clearing then deletes the
    // user's words from their only durable copy, leaving the textarea alone
    // with them again — the exact failure this whole family exists to
    // prevent. Clear only what this send put there; an empty store has
    // nothing to lose either way.
    // …and what it may clear is BOTH of those: the pin it wrote itself, and
    // the value it found there and never overwrote (a send with no text of its
    // own — attachments only — pins nothing, so comparing against `text`
    // alone made its clear a permanent no-op).
    const stored = loadDraft('chat', this._sessionId);
    if (stored && stored !== pending.text && stored !== pending.storeBefore) return;
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
      // Third caller of the same shape (round-7): restore only into a free box,
      // and say which of the two it was. (`pending.text` is the matched
      // `/goal …` command, never empty.)
      this._announceUnsent(pending.text, {
        restoredMsg: t('Goal not confirmed — the session may be unresponsive. Your command was restored to the input.'),
        keptMsg: t('Goal not confirmed — the session may be unresponsive. The input already had text, so your command was left alone.'),
      });
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
    // AN UNSTASHED REWRITE MUST NOT DIE WITH THE VIEW. Ordinary typed text is
    // already in the store when a window closes (the 300ms autosave), but edit
    // mode deliberately keeps that autosave OFF (law ②) — so a view torn down
    // mid-edit was the one path where the user's words existed nowhere but a
    // textarea about to be destroyed.
    const unstashed = this._unstashedEditText();
    if (unstashed !== null) saveDraft('chat', this._sessionId, unstashed);
    if (this._goalTimer) { clearTimeout(this._goalTimer); this._goalTimer = null; }
    if (this._editTimer) { clearTimeout(this._editTimer); this._editTimer = null; }
    // A reorder drag in flight owns window-level listeners — a closed window
    // must not keep them (the per-drag controller is what makes this one line).
    if (this._queueDrag) { try { this._queueDrag.ctl.abort(); } catch { } this._queueDrag = null; }
    if (this._stopPendingTimer) { clearTimeout(this._stopPendingTimer); this._stopPendingTimer = null; }
    if (this._draftSyncHandler) {
      const sync = getStateSync();
      if (sync) sync.off('drafts', 'chat:' + this._sessionId, this._draftSyncHandler);
    }
  }

  // ── Private ──

  // EVERY PROGRAMMATIC WRITER OF THE TEXTAREA, AND WHY IT IS SAFE WHILE A
  // QUEUED MESSAGE IS OPEN FOR EDITING (round-5 audit — the box is the editor,
  // so a write there is a write to the QUEUED MESSAGE, not to a draft):
  //   · `sendText` (in-chat actions, design request) — REFUSES out loud. It
  //     was the hole: the action became an `edit` op and ate the rewrite.
  //   · the constructor's draft restore — runs before this input exists, so
  //     no editor can be open.
  //   · another client's draft sync — lands on the STASH (`_editDraftBefore` /
  //     `_pendingEdit.draftBefore`), never on the live box (round-2 finding 5).
  //   · `_insertUploadedPaths` (upload button, folder picker, ChatView's
  //     drag-drop) — the writer that lands LATE (round-6 verifier): it runs
  //     after an await, so the editor it must respect may have been opened
  //     AFTER the upload started, and this audit missed it because it writes
  //     through a local `ta`, not `this._textarea`. Same answer as the draft
  //     sync: `_stashUploadedPaths` puts the paths on the stash (and the
  //     store) with a toast naming where they went.
  //   · the slash-command dropdown (Tab/Enter/click) — a USER action ON the
  //     box, offered only because the user typed `/…` INTO it; it replaces
  //     text they are looking at, exactly as it does for a draft, and Esc
  //     still hands the pre-edit draft back.
  //   · input-history recall (ArrowUp/ArrowDown) — entry is gated on an EMPTY
  //     box, and an empty editor is not a rewrite (`_rewriteInBox` and
  //     `_unstashedEditText` both answer null for it), so it can destroy
  //     nothing; what it puts there is visible and becomes the rewrite.
  //   · the unconfirmed-send / unconfirmed-goal restores (dead socket, 10s
  //     goal timeout) — all three go through the ONE `_announceUnsent`
  //     helper: it writes ONLY a box whose trimmed value is empty (same
  //     reasoning), dispatches nothing, and announces WHICH of the three
  //     things it did (restored / left your text alone / had nothing to
  //     restore) rather than one sentence for all of them (round-7).
  //   · attachments — never touch the textarea, and `_send` REFUSES an edit
  //     that carries them rather than dropping them silently.
  //   · `_send` / `_resolvePendingEdit` / `_beginQueueEdit` / `_cancelQueueEdit`
  //     — the edit machinery itself; each hands the text somewhere first.

  /** What the textarea holds that exists NOWHERE ELSE, or null. Edit mode
   *  keeps the debounced autosave off for the WHOLE flight — `_editingQueueId`
   *  OR `_pendingEdit` disarms it (the `input` listener) — so the in-flight
   *  window is just as unprotected as the pre-send one, and it lasts until the
   *  result lands or the 20s fallback fires (round-4 verifier: dispose used to
   *  look at `_editingQueueId` alone, so a window closed while a save was
   *  unanswered took every keystroke typed since Send with it).
   *  Null when the box holds something already safe: an untouched editor (the
   *  queued message's own text), the payload that is already on the wire (the
   *  text is on its way INTO the queued message — stashing a copy would leave
   *  the user their own queue item as a draft), or nothing at all. */
  _unstashedEditText() {
    if (!this._textarea) return null;
    if (!this._editingQueueId && !this._pendingEdit) return null;
    const typed = this._textarea.value;
    if (!typed.trim()) return null;
    // The baseline is WHAT IS ALREADY SOMEWHERE ELSE: the sent frame's own raw
    // box content while a save is in flight (never the trimmed wire payload —
    // the round-3 skew), the queued message's text before Send.
    const p = this._pendingEdit;
    const baseline = p
      ? (typeof p.raw === 'string' ? p.raw : p.text)
      : this._editOriginalText;
    return typed === baseline ? null : typed;
  }

  /** THE ONE SEND PATH, and it answers TWO questions with one value (the
   *  merge of 2.369.61's chord and the round-5 bail-out fix — both callers
   *  need a different fact and neither may lose it):
   *    · a STRING = the msgId of the queueable message that went out
   *      (`steerNow()` needs it: a steer NAMES a queued item);
   *    · `true`  = it TOOK the box but produced no queueable message
   *      (a `/goal` control frame, a queued-message edit);
   *    · `false` = it BAILED with the text still in the box — `sendText`
   *      turns that into its own `false` so the control that fired it comes
   *      back (round-5), and `steerNow()` reports no steerable send.
   *  Every other caller is a user pressing Send and ignores it. */
  _send() {
    const text = this._textarea.value.trim();
    const hasAttachments = this._attachments.length > 0;
    if (!text && !hasAttachments) return false;
    if (this._disconnected) {
      showToast(t('Disconnected — reconnecting… your draft is kept'), { type: 'error' });
      return false;
    }

    // EDITING A QUEUED MESSAGE: the send control SAVES the edit instead of
    // posting a new message (the strip row says so while the mode is on).
    // Attachments are not part of an edit — the wrapper preserves the queued
    // item's own attachments by exclusion, and silently dropping newly picked
    // ones would be the accept-and-ignore failure.
    if (this._editingQueueId) {
      const id = this._editingQueueId;
      if (hasAttachments) { showToast(t('Attachments cannot be added while editing a queued message — cancel the edit first.'), { type: 'error' }); return false; }
      this._editingQueueId = null;
      // THE REWRITE IS KEPT UNTIL THE RESULT PROVES IT LANDED (round-2
      // verifier, same law as _pendingSend below): restoring the pre-edit
      // draft HERE threw the typed text away before the frame was even sent,
      // and a refusal is the NORMAL race for this control — you rewrite the
      // item at the FRONT of the queue, the turn ends while you type, the
      // app-server drains the ORIGINAL, and the answer is 'gone'. The text
      // stays in the box (and in `_pendingEdit`) until _resolvePendingEdit
      // either puts the draft back (ok) or hands the rewrite back (refused).
      // `raw` is WHAT IS IN THE BOX, kept separately from the trimmed `text`
      // that goes on the wire (round-3 verifier): _resolvePendingEdit's
      // "the user typed something else meanwhile" guard compares the textarea
      // against this, and comparing it against the TRIMMED payload made every
      // rewrite ending in a space or a newline take the bail-out — i.e. every
      // outcome of a multi-line edit silently did nothing, which is exactly
      // the round-2 MAJOR this pending state was introduced to fix.
      this._pendingEdit = { id, text, raw: this._textarea.value, original: this._editOriginalText, draftBefore: this._editDraftBefore };
      this._editDraftBefore = null;
      this._editOriginalText = null;
      // Last-resort release: every ordinary path answers (the wrapper's
      // result, a ws refusal, the republish that drops the row, a dead
      // socket), but a wrapper that dies mid-save answers nothing and the
      // rewrite would sit in a box that refuses to open another edit. The
      // text is already safe IN the box — this only ends the wait and says so.
      clearTimeout(this._editTimer);
      this._editTimer = setTimeout(() => {
        this._editTimer = null;
        if (this._pendingEdit?.id !== id) return;
        this._resolvePendingEdit(false, t('The edit was not confirmed — the session may be unresponsive.'));
      }, 20000);
      this._dispatchQueueOp('edit', id, { text });
      return true;
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
      // A /goal is a control frame: it took the box (so `sendText` must not
      // report a bail) but it is not a queueable message, so `steerNow()`
      // gets no id and reports no steerable send.
      return true;
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
    // WHAT THIS SEND DISPLACED IN THE STORE, so the deferred clear below can
    // tell "my own pin is still there" from "the user has since typed
    // something else" WITHOUT assuming the pin exists: an attachments-only
    // send has no text, pins nothing, and would otherwise never be able to
    // clear anything again (round-7 verifier — text deleted inside the 300 ms
    // debounce window survives in the store as a permanent zombie draft,
    // because `clearTimeout` above cancelled the autosave that would have
    // written the deletion).
    const storeBefore = loadDraft('chat', this._sessionId);
    if (text) saveDraft('chat', this._sessionId, text);
    this._pendingSend = { text, storeBefore };
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
    return msgId;
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
   *  caps = backend-caps `inputModes` projected onto the client (agent-meta):
   *  `queueVerbs` is the table, `steer`/`queueOps` its derived view. */
  setQueue(items, caps) {
    this._queue = Array.isArray(items) ? items : [];
    if (caps) this._queueCaps = { queue: !!caps.queue, steer: !!caps.steer, queueOps: !!caps.queueOps, queueVerbs: Array.isArray(caps.queueVerbs) ? caps.queueVerbs.slice() : [] };
    // A row that left the queue cannot still be pending/refused/edited — the
    // republish IS the outcome (a spinner outliving its row is a lie).
    const live = new Set(this._queue.map((it) => String(it.id || '')));
    for (const id of [...this._queueRowState.keys()]) if (!live.has(id)) this._queueRowState.delete(id);
    if (this._editingQueueId && !live.has(this._editingQueueId)) this._abandonEditOfDroppedRow();
    // …and an edit still in flight whose ROW is gone lost the race: the item
    // ran (or Stop dropped it) before the rewrite landed. The republish IS
    // that answer — hand the typed text back here too, or it dies with the row
    // and no result ever comes.
    if (this._pendingEdit && !live.has(this._pendingEdit.id)) this._resolvePendingEdit(false);
    this._renderQueue();
    // The caps are the OTHER input to the chord and its hint, and they arrive
    // AFTER the composer is on screen (attach payload / the wrapper's baseline
    // queue_changed) — the same late-capability ordering that once shipped a
    // permanently dead bubble chip. Repaint here, so a flip in either
    // direction reaches both faces.
    this._updateSendModes();
  }

  /** The outcome of ONE queue op (the normalizer's `queue-result` meta op).
   *  Ends the row's pending state either way; a refusal MARKS the row and
   *  keeps the sentence on it, because the system card scrolls away. */
  setQueueOpResult(id, ok, text) {
    const key = String(id || '');
    if (!key) {
      // A BATCH verb (run-all / steer-all) names no item: its result ends the
      // pending state of every row the dispatch marked. The reason, if any,
      // is on the system card the normalizer emitted — marking every row
      // 'refused' for one queue-wide refusal would be noise, but leaving them
      // spinning would be a lie.
      for (const [k, v] of [...this._queueRowState]) {
        // …except the row of an edit whose own result has not come back yet:
        // its save IS still in flight, and clearing that spinner would be the
        // opposite lie.
        if (this._pendingEdit && k === this._pendingEdit.id) continue;
        if (v?.state === 'pending') this._queueRowState.delete(k);
      }
      this._renderQueue();
      return;
    }
    // The OP state ends either way — it never carries edit mode any more
    // (round-4), so an ok result can simply clear it without erasing the
    // marker of an edit that is still open on this very row.
    if (ok) this._queueRowState.delete(key);
    else this._queueRowState.set(key, { state: 'refused', title: text || '' });
    // THE EDIT'S OWN ANSWER: ok puts the pre-edit draft back, a refusal hands
    // the rewrite back to the user (never the moment it is thrown away).
    if (this._pendingEdit && this._pendingEdit.id === key) this._resolvePendingEdit(ok, text || '');
    this._renderQueue();
  }

  /** THE ROW BEING EDITED LEFT THE QUEUE WHILE THE USER WAS STILL TYPING
   *  (round-3 verifier). This is the same race `_resolvePendingEdit`'s
   *  row-gone branch answers for a rewrite already sent — you rewrite the
   *  FRONT item, the turn ends, the app-server drains the original — but in
   *  the much LARGER window BEFORE Send, where nothing is pending yet. The
   *  ordinary cancel restores the pre-edit draft OVER the textarea, which
   *  here would silently delete words the user never chose to throw away.
   *  A rewrite is kept exactly the way the post-Send twin keeps it (draft +
   *  toast); an untouched editor is just closed. `_cancelQueueEdit` stays for
   *  the paths where the USER threw the edit away — Esc, and the untouched
   *  editor of a row switch (a switch that CARRIES a rewrite keeps it, see
   *  _beginQueueEdit, round-4). */
  _abandonEditOfDroppedRow() {
    const typed = this._rewriteInBox();
    // Untouched (or emptied) editor ⇒ there is nothing of the user's in the
    // box; the pre-edit draft is what belongs there.
    if (typed === null) { this._cancelQueueEdit({ silent: true }); return; }
    this._editingQueueId = null;
    this._editOriginalText = null;
    this._editDraftBefore = null;          // the rewrite IS this session's draft now
    saveDraft('chat', this._sessionId, typed);
    this._renderQueue();
    showToast(t('That queued message could not be edited — your rewritten text was kept in the input.'), { type: 'error' });
  }

  /** THE ONE DISCRIMINATOR every "this edit is ending for a reason the user
   *  did not choose" path shares: the rewrite currently in the box, or null
   *  when nothing of the user's is in there (an untouched — or emptied —
   *  editor still holds the queued message's own text, and restoring the
   *  pre-edit draft over THAT loses nothing). */
  _rewriteInBox() {
    const typed = this._textarea ? this._textarea.value : '';
    const original = typeof this._editOriginalText === 'string' ? this._editOriginalText : '';
    if (!typed.trim() || typed === original) return null;
    return typed;
  }

  /** The outcome of an edit whose frame is already OUT (`_pendingEdit`).
   *  `ok` restores the draft the edit borrowed the textarea from; a REFUSAL
   *  hands the rewrite back — 'gone' is the normal race for this control (you
   *  rewrite the front item, the turn ends while you type, the app-server runs
   *  the ORIGINAL), and the typed text must never be what pays for it. */
  _resolvePendingEdit(ok, reasonText = '') {
    const p = this._pendingEdit;
    if (!p) return;
    this._pendingEdit = null;
    if (this._editTimer) { clearTimeout(this._editTimer); this._editTimer = null; }
    // NO EXIT FROM HERE MAY LEAVE A SPINNER (round-3 verifier). The row is
    // 'pending' only while THIS edit is in flight and this function IS the end
    // of that flight, but two of the callers write no row state at all (the
    // dead socket, the 20s fallback) — so a bail-out below used to leave the
    // row spinning for the rest of the session. setQueueOpResult has already
    // written 'refused'/cleared before calling us, so this only ever clears a
    // mark nobody else answered.
    let spinning = false;
    if (this._queueRowState.get(p.id)?.state === 'pending') { this._queueRowState.delete(p.id); spinning = true; }
    const bail = () => { if (spinning) this._renderQueue(); };
    if (!this._textarea) { bail(); return; }
    // The user started typing something ELSE while the save was in flight —
    // that text is theirs, and neither outcome may overwrite it (the same
    // guard the _pendingSend restore uses). Compare against what was in the
    // BOX (`raw`), never against the trimmed payload that went on the wire:
    // a rewrite ending in a newline is not "something else".
    if (this._textarea.value !== (typeof p.raw === 'string' ? p.raw : p.text)) {
      // …and it is the session's DRAFT from here on. Edit mode keeps the
      // debounced autosave off for the whole flight (law ②), so those
      // keystrokes are in a volatile textarea and NOWHERE else — the store
      // still holds the pre-edit draft, and the window closing now (or any
      // other client's sync) would take them with it. The edit is over, so
      // the draft channel belongs to the box again.
      saveDraft('chat', this._sessionId, this._textarea.value);
      bail();
      return;
    }
    if (ok) {
      this._textarea.value = typeof p.draftBefore === 'string' ? p.draftBefore : '';
      this._autoSize?.();
      bail();
      return;
    }
    const live = this._queue.some((it) => String(it.id || '') === p.id);
    if (live) {
      // Still queued ⇒ the save can simply be retried: go back INTO edit mode
      // (Send saves, Esc restores the draft) with the reason on the row.
      this._editingQueueId = p.id;
      this._editDraftBefore = typeof p.draftBefore === 'string' ? p.draftBefore : '';
      this._editOriginalText = typeof p.original === 'string' ? p.original
        : (this._queue.find((it) => String(it.id || '') === p.id)?.text ?? null);
      // The REASON is the op's outcome, and it belongs to the op state —
      // being back in edit mode is rendered from `_editingQueueId` (round-4),
      // so the row now shows both marks instead of one hiding the other.
      // setQueueOpResult has usually written this already; the callers that
      // write no row state at all (dead socket, 20s fallback) have not.
      if (reasonText) this._queueRowState.set(p.id, { state: 'refused', title: reasonText });
      this._renderQueue();
      return;
    }
    // The row is GONE: the rewrite becomes this session's draft, and the toast
    // says where it went — finding your own words in the input with no
    // explanation is the silent failure wearing a full textarea. The DRAFT is
    // what is in the box (raw), so the store and the textarea agree — saving
    // the trimmed twin desynced them by exactly the whitespace the user typed.
    saveDraft('chat', this._sessionId, this._textarea.value);
    bail();
    showToast(t('That queued message could not be edited — your rewritten text was kept in the input.'), { type: 'error' });
  }

  _queueHas(verb) { return (this._queueCaps.queueVerbs || []).includes(verb); }

  /** Every strip action goes through here: mark the row pending FIRST (so the
   *  control cannot be double-fired and the user sees that it took), then
   *  send. The pending state ends on the op's result, on a ws-layer refusal
   *  (which echoes the id back), or on the republish that removes the row.
   *  A dispatch that sends NOTHING — `_sendQueueOp` refusing a dead/read-only
   *  window — UNDOES the mark right here: the republish does not clear it
   *  (the row never left the queue) and no result will ever come, so the row
   *  spun forever after one click on a disconnected window (round-2
   *  verifier). The callback answers `false` for exactly that case. */
  _dispatchQueueOp(op, id, extra) {
    const marked = id ? [String(id)] : this._queue.map((it) => String(it.id));
    for (const k of marked) this._queueRowState.set(k, { state: 'pending', title: '' });
    this._renderQueue();
    const sent = this._onQueueOp?.(op, id || null, extra);
    if (sent === false) {
      for (const k of marked) if (this._queueRowState.get(k)?.state === 'pending') this._queueRowState.delete(k);
      // An edit that was never sent is not a refused edit — put the user
      // straight back into edit mode with their text (nothing left the client).
      if (op === 'edit' && this._pendingEdit && this._pendingEdit.id === String(id)) this._resolvePendingEdit(false);
      this._renderQueue();
    }
    return sent;
  }

  /** Open a queued message's FULL text in the textarea. The strip carries that
   *  full text (never the 120-char preview — editing a truncated copy and
   *  saving it would delete the rest of the message), and an item without one
   *  shows no edit control at all. */
  _beginQueueEdit(id) {
    const item = this._queue.find((it) => String(it.id) === String(id));
    if (!item || typeof item.text !== 'string') return;
    // ONE edit at a time: the textarea is the editor, and opening a second
    // message in it while the first save is unanswered would leave that
    // rewrite with nowhere to be handed back to. Sub-second in practice, and
    // the 20s fallback guarantees the block ends.
    if (this._pendingEdit) { showToast(t('The previous edit is still saving — one moment.')); return; }
    // SWITCHING TO ANOTHER ROW MUST NOT EAT THE REWRITE (round-4 verifier).
    // The plain cancel restores the pre-edit draft OVER the textarea, and an
    // UNSENT rewrite lives nowhere else (law ② keeps the autosave off for the
    // whole edit) — clicking a second pencil silently deleted whatever had
    // been typed into the first. Same answer as the twins for a row that
    // vanished (draft + toast), with one difference: the box is about to hold
    // ANOTHER message, so the rewrite must also become what an Esc on the new
    // edit restores. An untouched editor is not a rewrite and still just closes.
    if (this._editingQueueId && this._editingQueueId !== String(id)) {
      const carried = this._rewriteInBox();
      if (carried === null) this._cancelQueueEdit({ silent: true });
      else {
        this._editingQueueId = null;
        this._editOriginalText = null;
        this._editDraftBefore = carried;     // Esc on the new edit hands it back
        saveDraft('chat', this._sessionId, carried);
        showToast(t('Your unsaved rewrite was kept as this session’s draft — cancel this edit to get it back.'));
      }
    }
    if (this._editDraftBefore === null) this._editDraftBefore = this._textarea.value;
    // PIN THE DRAFT AND DISARM THE PENDING AUTOSAVE (the same door as the
    // guard on the `input` listener, from the other side): a debounce armed by
    // the last keystroke fires ~300ms from now and would read the textarea
    // AFTER we put the queued message in it — persisting that message as this
    // session's draft. Same shape as _send's "cancel the pending autosave and
    // pin the draft to exactly what was sent".
    clearTimeout(this._draftTimer);
    this._draftTimer = null;
    saveDraft('chat', this._sessionId, this._editDraftBefore);
    this._editingQueueId = String(id);
    // What the editor OPENED with — the discriminator setQueue needs when the
    // row disappears mid-typing (a box still holding this is not a rewrite).
    this._editOriginalText = item.text;
    this._textarea.value = item.text;
    this._autoSize?.();
    this._renderQueue();
    this._textarea.focus();
    try { this._textarea.setSelectionRange(item.text.length, item.text.length); } catch { }
  }

  _cancelQueueEdit({ silent = false } = {}) {
    this._editingQueueId = null;
    // The OP state is NOT ours to clear (round-4): a refusal that is on this
    // row describes the op that was refused, and it outlives the edit exactly
    // like every other verb's refusal — until the row leaves the queue or its
    // next op succeeds.
    if (this._editDraftBefore !== null) { this._textarea.value = this._editDraftBefore; this._autoSize?.(); }
    this._editDraftBefore = null;
    this._editOriginalText = null;
    this._renderQueue();
    if (!silent) this._textarea.focus();
  }

  /** Move a row one place by KEYBOARD (Alt+Up / Alt+Down on a focused row) —
   *  the SAME relative frame the drag sends, so the two paths cannot drift. A
   *  drag handle with no keyboard equivalent is a control half the users
   *  cannot reach. */
  _moveQueueRow(id, delta) {
    if (!this._queueHas('reorder')) return;
    const ids = this._queue.map((it) => String(it.id));
    const from = ids.indexOf(String(id));
    if (from < 0) return;
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    // afterId = the row it lands BEHIND (null = the front of the queue).
    const afterId = to === 0 ? null : (delta < 0 ? ids[to - 1] : ids[to]);
    this._dispatchQueueOp('reorder', String(id), { afterId });
  }

  _renderQueue() {
    const strip = this._queueStrip;
    if (!strip) return;
    const items = this._queueCaps.queueOps ? this._queue : [];
    if (!items.length) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
    strip.classList.remove('hidden');
    // BOUNDED (2.369.60, owner: 25 queued job notifications swallowed the whole
    // window — no scrolling, no messages, no input box). The rows live in a
    // scrollable body capped by CSS; past QUEUE_COLLAPSE_AT the strip starts
    // COLLAPSED to its header and a chevron toggles it (per-view memory only).
    const collapsed = this._queueCollapsed ?? (items.length > ChatInput.QUEUE_COLLAPSE_AT);
    strip.classList.toggle('chat-queue-collapsed', collapsed);
    strip.innerHTML = ChatInput.queueStripHtml(items, this._queueCaps, this._queueRowState, this._editingQueueId, { collapsed });
    const toggle = strip.querySelector('.chat-queue-toggle');
    if (toggle) toggle.onclick = (e) => { e.stopPropagation(); this._queueCollapsed = !collapsed; this._renderQueue(); };
    strip.querySelectorAll('[data-queue-op]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const op = btn.dataset.queueOp, id = btn.dataset.queueId || null;
        // 'edit' is a LOCAL mode (open the text), not a frame — the frame goes
        // out when the user sends. 'edit-cancel' is purely local too.
        if (op === 'edit') { this._beginQueueEdit(id); return; }
        if (op === 'edit-cancel') { this._cancelQueueEdit(); return; }
        this._dispatchQueueOp(op, id);
      };
    });
    // Enter on a focused row steers it; Alt+Up/Down is the keyboard reorder
    // (the buttons handle their own Enter as ordinary button activation).
    strip.querySelectorAll('.chat-queue-item').forEach((row) => {
      row.onkeydown = (e) => {
        if (e.target !== row) return;
        const id = row.dataset.queueId || null;
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          this._moveQueueRow(id, e.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (this._queueHas('steer')) this._dispatchQueueOp('steer', id);
      };
    });
    if (this._queueHas('reorder')) this._bindQueueDrag(strip);
    // A republish landed MID-DRAG: the new rows carry none of the drag
    // chrome, so re-run the hit test against them right away (the drag itself
    // survives — its listeners are on `window` under its own controller).
    if (this._queueDrag?.apply) { try { this._queueDrag.apply(); } catch { } }
  }

  /** POINTER-event drag reorder (never HTML5 DnD: this strip lives inside a
   *  window whose own drag machinery would fight a native drag image, and
   *  touch has no HTML5 DnD at all). Moves are rAF-coalesced like every other
   *  drag in the app, and the listeners hang on a PER-DRAG AbortController —
   *  a per-render one tears its own listeners down MID-DRAG (the
   *  listener-lifecycle law). */
  _bindQueueDrag(strip) {
    strip.querySelectorAll('[data-queue-drag]').forEach((grip) => {
      grip.onpointerdown = (e) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const id = String(grip.dataset.queueDrag || '');
        const ctl = new AbortController();
        const drag = { id, ctl, y: e.clientY, raf: 0, afterId: undefined, moved: false };
        this._queueDrag = drag;
        // THE ROWS ARE RE-QUERIED EVERY FRAME, NEVER CAPTURED (round-2
        // verifier): a `queue_changed` republish during the ~1s drag (a peer
        // message, another client, an item leaving) rebuilds `strip.innerHTML`,
        // and every element the closure held is then DETACHED — a detached
        // node's rect is all zeros, so the midpoint test said "below every
        // row" and the drop silently landed the item at the END of the queue.
        const liveRows = () => [...strip.querySelectorAll('.chat-queue-item')];
        const apply = () => {
          drag.raf = 0;
          // The row it would land BEHIND: the last OTHER row whose midpoint is
          // above the pointer. null = the front of the queue.
          let afterId = null;
          const rows = liveRows();
          for (const row of rows) {
            if (row.dataset.queueId === id) continue;
            const r = row.getBoundingClientRect();
            if (drag.y > r.top + r.height / 2) afterId = row.dataset.queueId;
          }
          drag.afterId = afterId;
          for (const row of rows) {
            row.classList.toggle('chat-queue-dragging', row.dataset.queueId === id);
            row.classList.toggle('chat-queue-drop-after', afterId != null && row.dataset.queueId === afterId);
          }
          strip.classList.toggle('chat-queue-drop-front', afterId === null);
        };
        // …and a re-render mid-drag repaints the indicator on the NEW rows
        // (the classes live on elements that no longer exist) — `_renderQueue`
        // calls this when a drag is running.
        drag.apply = apply;
        const onMove = (ev) => {
          drag.y = ev.clientY;
          if (Math.abs(ev.clientY - e.clientY) > 3) drag.moved = true;
          if (!drag.raf) drag.raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(apply) : setTimeout(apply, 16));
        };
        const finish = (send) => {
          if (drag.raf) { try { cancelAnimationFrame(drag.raf); } catch { } drag.raf = 0; }
          ctl.abort();
          this._queueDrag = null;
          for (const row of liveRows()) row.classList.remove('chat-queue-dragging', 'chat-queue-drop-after');
          strip.classList.remove('chat-queue-drop-front');
          if (!send || !drag.moved || drag.afterId === undefined) return;
          // The order as it is NOW, not as it was at pointerdown — same reason
          // as the rows above: the no-op test and the landing index must be
          // computed against the queue the user is actually looking at.
          const ids = this._queue.map((it) => String(it.id));
          const at = ids.indexOf(id);
          // The dragged row left the queue mid-drag (it ran, or Stop dropped
          // it): there is nothing to reorder, and sending would earn a 'gone'.
          if (at < 0) return;
          // A drop that lands where the row already is sends NOTHING (a no-op
          // reorder still costs an RPC, a republish and a pending flash).
          const landing = drag.afterId === null ? 0 : ids.filter((x) => x !== id).indexOf(String(drag.afterId)) + 1;
          if (landing === at) return;
          this._dispatchQueueOp('reorder', id, { afterId: drag.afterId });
        };
        window.addEventListener('pointermove', onMove, { signal: ctl.signal });
        window.addEventListener('pointerup', () => finish(true), { signal: ctl.signal });
        window.addEventListener('pointercancel', () => finish(false), { signal: ctl.signal });
      };
    });
  }

  /** PURE markup for the strip (DOM-free testable; every interpolation escaped
   *  — a queue preview is message text and syncs to every client). Controls
   *  come from `caps.queueVerbs`, the harness's verb table INTERSECTED with
   *  what the running wrapper serves: a control that is rendered is a control
   *  the server will honour. `rowState` (id → {state, title}) paints the
   *  TRANSIENT OP state (pending / refused); `editingId` — a SEPARATE
   *  argument, because the two are separate facts (round-4 verifier) — paints
   *  edit mode. A row can carry both: an edit that was refused is still open,
   *  and rendering one of the two facts through the other made whichever
   *  arrived last erase the other. */
  /** More queued items than this ⇒ the strip starts collapsed to its header. */
  static get QUEUE_COLLAPSE_AT() { return 8; }

  static queueStripHtml(items, caps = {}, rowState = null, editingId = null, { collapsed = false } = {}) {
    const verbs = caps.queueVerbs || [];
    const has = (v) => verbs.includes(v);
    const stateOf = (id) => (rowState && typeof rowState.get === 'function' ? rowState.get(String(id)) : (rowState ? rowState[String(id)] : null)) || null;
    const editKey = editingId === null || editingId === undefined ? null : String(editingId);
    const btn = (op, id, icon, label, cls = '') => `<button type="button" class="chat-queue-btn${cls ? ' ' + cls : ''}" data-queue-op="${op}"${id ? ` data-queue-id="${escHtml(String(id))}"` : ''} title="${escHtml(label)}" aria-label="${escHtml(label)}">${icon}</button>`;
    const toggle = items.length > ChatInput.QUEUE_COLLAPSE_AT || collapsed
      ? `<button type="button" class="chat-queue-toggle" aria-expanded="${collapsed ? 'false' : 'true'}" title="${escHtml(collapsed ? t('Show the queued messages') : t('Hide the queued messages'))}">${collapsed ? UI_ICONS.chevronDown : UI_ICONS.chevronUp}</button>`
      : '';
    const head = `<div class="chat-queue-head">${UI_ICONS.queue}<span>${escHtml(t('{n} queued — runs after this turn', { n: items.length }))}</span>${toggle}${
      has('run-all')
        ? `<button type="button" class="chat-queue-all" data-queue-op="run-all" title="${escHtml(t('Run the whole queue now, without waiting for the current turn'))}">${UI_ICONS.playAll}<span>${escHtml(t('Run all now'))}</span></button>`
        : ''
    }${
      has('steer-all') && items.length > 1
        ? `<button type="button" class="chat-queue-all" data-queue-op="steer-all" title="${escHtml(t('Inject every queued message into the running turn, in order'))}">${UI_ICONS.bolt}<span>${escHtml(t('Steer all'))}</span></button>`
        : ''
    }</div>`;
    const rows = items.map((it) => {
      const id = escHtml(String(it.id || ''));
      const st = stateOf(it.id);
      const from = it.kind === 'peer' && it.from ? `<span class="chat-queue-from">${escHtml(String(it.from))}</span>` : '';
      // The drag handle is chrome for a pointer; Alt+Up/Down on the focused
      // row is the keyboard path, and the title says so.
      const grip = has('reorder')
        ? `<span class="chat-queue-grip" data-queue-drag="${id}" title="${escHtml(t('Drag to reorder (Alt+Up / Alt+Down)'))}" aria-hidden="true">${UI_ICONS.grip}</span>`
        : '';
      // EDIT is offered only for a message that is (a) YOURS — rewriting
      // another agent's words would misattribute them, and the wrapper
      // refuses it too — and (b) carried in FULL by the wrapper; the preview
      // is truncated and saving it back would cut the message down.
      const isEditing = editKey !== null && String(it.id || '') === editKey;
      const edit = has('edit') && it.kind !== 'peer' && typeof it.text === 'string'
        ? (isEditing
          ? btn('edit-cancel', it.id, UI_ICONS.close, t('Cancel editing'), 'chat-queue-btn-editing')
          : btn('edit', it.id, UI_ICONS.pencil, t('Edit this queued message')))
        : '';
      const runNow = has('run-now') ? btn('run-now', it.id, UI_ICONS.play, t('Run this one now')) : '';
      const steer = has('steer') ? btn('steer', it.id, UI_ICONS.bolt, t('Steer now — the agent sees it at its next reply')) : '';
      const remove = has('remove') ? btn('remove', it.id, UI_ICONS.close, t('Remove'), 'chat-queue-btn-remove') : '';
      const stateAttr = st?.state ? ` data-queue-state="${escHtml(st.state)}"` : '';
      // Its own attribute, never a value of `data-queue-state`: an op in
      // flight on the row being edited (a batch verb marks every row) must
      // not repaint the row as "not being edited".
      const editAttr = isEditing ? ' data-queue-editing="1"' : '';
      const stateTitle = st?.title ? ` title="${escHtml(String(st.title))}"` : '';
      return `<div class="chat-queue-item" tabindex="0" data-queue-id="${id}"${stateAttr}${editAttr}${stateTitle}>${grip}${from}<span class="chat-queue-preview">${escHtml(String(it.preview || ''))}</span>${edit}${runNow}${steer}${remove}</div>`;
    }).join('');
    const editing = editKey !== null && items.some((it) => String(it.id || '') === editKey)
      ? `<div class="chat-queue-editing">${escHtml(t('Editing a queued message — send to save, Esc to cancel'))}</div>`
      : '';
    // The body is the ONLY thing that scrolls; a collapsed strip omits it.
    return head + (collapsed ? '' : `<div class="chat-queue-body">${rows}</div>`) + editing;
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
