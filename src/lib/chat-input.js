import { escHtml, saveDraft, loadDraft, clearDraft, getStateSync } from './utils.js';

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
  constructor(ws, sessionId, { onSend, onInterrupt }) {
    this._ws = ws;
    this._sessionId = sessionId;
    this._onSend = onSend;
    this._onInterrupt = onInterrupt;

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
    this._textarea.placeholder = 'Type a message...';
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
      setTimeout(() => { this._textarea.style.height = 'auto'; this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px'; }, 0);
    }

    // Auto-grow textarea (skip in expanded mode)
    this._draftTimer = null;
    this._textarea.addEventListener('input', () => {
      if (!this._expanded) {
        this._textarea.style.height = 'auto';
        this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
      }
      // Debounced draft save
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => saveDraft('chat', this._sessionId, this._textarea.value), 300);
    });

    // Sync draft from other clients via StateSync
    this._draftSyncHandler = (value) => {
      this._textarea.value = value || '';
      this._textarea.style.height = 'auto';
      this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
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
      if (this._expanded) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._send(); }
      } else {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
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
    expandBtn.title = 'Expand editor';
    expandBtn.onclick = () => {
      this._expanded = !this._expanded;
      if (this._expanded) {
        this._textarea.style.height = '200px';
        this._textarea.style.minHeight = '200px';
        this._textarea.classList.add('chat-input-expanded');
        expandBtn.textContent = '\u2923';
        expandBtn.title = 'Collapse editor';
        this._shortcutHint.textContent = 'Ctrl+\u23CE';
      } else {
        this._textarea.classList.remove('chat-input-expanded');
        this._textarea.style.minHeight = '';
        this._textarea.style.height = '';
        expandBtn.textContent = '\u2922';
        expandBtn.title = 'Expand editor';
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
    attachBtn.title = 'Attach image';
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

    inputWrap.append(attachBtn, attachInput, this._textarea, expandBtn, this._slashDropdown);

    const sendCol = document.createElement('div');
    sendCol.className = 'chat-send-col';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = '\u25B6';
    sendBtn.title = 'Send';
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

    inputArea.append(this._attachArea, this._todoDisplay, this._streamStatus, inputWrap, sendCol);
  }

  /** The .chat-input-area wrapper element */
  get element() { return this._element; }

  /** The streaming status element (for readOnly mode, shared reference) */
  get statusElement() { return this._streamStatus; }

  /** The todo display element */
  get todoElement() { return this._todoDisplay; }

  /** Whether currently streaming */
  get isStreaming() { return this._isStreaming; }

  /** Set the container element for popup positioning (the .chat-view) */
  set popupContainer(el) { this._todoContainer = el; }

  // ── Public API ──

  showTyping(label = 'thinking...') {
    if (!this._streamStatus) return;
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> ${escHtml(label)}<button class="chat-interrupt-btn" title="Interrupt">\u25A0 Stop</button>`;
    this._streamStatus.querySelector('.chat-interrupt-btn').onclick = () => this._onInterrupt();
    this._streamStatus.classList.remove('hidden');
    this._isStreaming = true;
  }

  hideTyping() {
    if (!this._streamStatus) return;
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
    this._isStreaming = false;
  }

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
      this._textarea.placeholder = 'Session ended';
    }
    this._element.style.display = 'none';
  }

  setDisconnected(disconnected) {
    if (this._textarea) this._textarea.disabled = disconnected;
  }

  focus() {
    if (this._textarea) this._textarea.focus();
  }

  dispose() {
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
    const msgId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    this._textarea.value = '';
    this._textarea.style.height = '';
    this._textarea.style.minHeight = '';
    clearDraft('chat', this._sessionId);
    if (this._expanded) {
      this._expanded = false;
      this._textarea.classList.remove('chat-input-expanded');
      const eb = this._textarea.parentElement?.querySelector('.chat-expand-btn');
      if (eb) { eb.textContent = '\u2922'; eb.title = 'Expand editor'; }
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
    this.showTyping('thinking...');
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
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chat-attach-remove';
      removeBtn.textContent = '\u2715';
      removeBtn.title = 'Remove';
      removeBtn.onclick = (e) => { e.stopPropagation(); this._attachments.splice(i, 1); this._renderAttachments(); };
      item.appendChild(removeBtn);
      this._attachArea.appendChild(item);
    }
  }

  _updateTodoDisplay() {
    if (!this._todoDisplay) return;
    if (!this._todos?.length) { this._todoDisplay.classList.add('hidden'); return; }
    const inProgress = this._todos.find(t => t.status === 'in_progress');
    const completed = this._todos.filter(t => t.status === 'completed').length;
    const total = this._todos.length;
    if (!inProgress && completed === total) { this._todoDisplay.classList.add('hidden'); return; }
    const label = inProgress ? inProgress.activeForm || inProgress.content : `${completed}/${total} done`;
    const icon = inProgress ? '\u23F3' : '\u2705';
    this._todoDisplay.innerHTML = `<span class="chat-todo-current">${icon} ${escHtml(label)} <span class="chat-status-dim">(${completed}/${total})</span></span>`;
    this._todoDisplay.classList.remove('hidden');
    this._todoDisplay.onclick = (e) => {
      e.stopPropagation();
      const container = this._todoContainer || this._element.parentElement;
      const existing = container.querySelector('.chat-todo-popup');
      if (existing) { existing.remove(); return; }
      const popup = document.createElement('div');
      popup.className = 'chat-todo-popup';
      for (const t of this._todos) {
        const icon = t.status === 'completed' ? '\u2705' : t.status === 'in_progress' ? '\u23F3' : '\u2B55';
        const item = document.createElement('div');
        item.className = `chat-todo-item chat-todo-${t.status}`;
        item.textContent = `${icon} ${t.content}`;
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
