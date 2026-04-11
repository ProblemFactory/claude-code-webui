/**
 * ChatViewV2 — ID-based chat renderer consuming MessageStore events.
 *
 * The frontend is a pure renderer: it receives create/edit/delete ops
 * and translates them into DOM operations. No message parsing,
 * no tool_use/tool_result matching, no pending state.
 *
 * Each NormalizedMessage.id maps to exactly one DOM element.
 * Edit ops update that element in place.
 */
import { escHtml, saveDraft, loadDraft, clearDraft, getStateSync } from './utils.js';
import { MessageStore } from './message-store.js';
import { renderNormalizedMessage, renderPermission, linkifyText, stripAnsi } from './chat-renderer.js';

class ChatViewV2 {
  constructor(winInfo, wsManager, sessionId, app, { readOnly = false } = {}) {
    this.app = app;
    this.ws = wsManager;
    this.sessionId = sessionId;
    this.winInfo = winInfo;
    this._readOnly = readOnly;
    this._compact = true; // default compact mode

    this.store = new MessageStore();
    this._elements = new Map(); // msg.id → DOM element

    // Build DOM
    const container = document.createElement('div');
    container.className = 'chat-container chat-compact';
    winInfo.element.querySelector('.window-content').appendChild(container);
    this._container = container;

    // Message list
    this._messageList = document.createElement('div');
    this._messageList.className = 'chat-messages';
    container.appendChild(this._messageList);

    // Scroll button
    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'chat-scroll-btn-wrap';
    this._scrollBtn = document.createElement('button');
    this._scrollBtn.className = 'chat-scroll-btn hidden';
    this._scrollBtn.innerHTML = '\u2193';
    this._scrollBtn.onclick = () => this._scrollToBottom();
    scrollWrap.appendChild(this._scrollBtn);
    container.appendChild(scrollWrap);

    // Pinned-to-bottom tracking
    this._pinned = true;
    this._messageList.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) this._pinned = false;
    });
    this._messageList.addEventListener('scroll', () => {
      const el = this._messageList;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      if (atBottom) { this._pinned = true; this._scrollBtn.classList.add('hidden'); }
      else { this._scrollBtn.classList.remove('hidden'); }
      // Load more on scroll to top
      if (el.scrollTop < 100 && this.store.hasMore && !this._loading) this._loadMore();
    });

    // Streaming status
    this._streamStatus = document.createElement('div');
    this._streamStatus.className = 'chat-stream-status hidden';
    container.appendChild(this._streamStatus);

    // Status bar
    this._statusBar = document.createElement('div');
    this._statusBar.className = 'chat-status-bar';
    container.appendChild(this._statusBar);

    // Input area (unless readOnly)
    if (!readOnly) {
      this._buildInputArea(container);
    }

    // Link click handler
    this._setupLinkHandler();

    // Subscribe to MessageStore events
    this.store.on('create', (msg) => this._onCreate(msg));
    this.store.on('edit', (data) => this._onEdit(data));
    this.store.on('delete', (data) => this._onDelete(data));
    this.store.on('batch', () => this._onBatch());
    this.store.on('prepend', (data) => this._onPrepend(data));
    this.store.on('meta', (data) => this._onMeta(data));

    // WS handler for live ops
    this._handler = (msg) => {
      if (msg.type === 'msg' && msg.sessionId === sessionId) {
        this.store.applyOp(msg);
      }
    };
    this.ws.onGlobal(this._handler);

    // Reconnect handler
    this._stateHandler = (connected) => {
      if (!connected) {
        this._streamStatus.textContent = 'Disconnected';
        this._streamStatus.classList.remove('hidden');
      } else {
        this._streamStatus.classList.add('hidden');
        this._reattach();
      }
    };
    if (!readOnly) this.ws.onStateChange(this._stateHandler);
  }

  /** Load initial messages from attach response */
  loadHistory(v2Data, meta) {
    if (!v2Data) return;
    this.store.init(v2Data.messages || [], v2Data.total || 0);
    if (meta) this._applyMeta(meta);
    this._scrollToBottom();
  }

  /** Focus the input */
  focus() { this._textarea?.focus(); }

  dispose() {
    this.ws.offGlobal(this._handler);
    if (this._stateHandler) this.ws.offStateChange(this._stateHandler);
    if (this._draftSyncHandler) {
      const sync = getStateSync();
      if (sync) sync.off('drafts', 'chat:' + this.sessionId, this._draftSyncHandler);
    }
  }

  // ── DOM creation ──

  _buildInputArea(container) {
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';

    this._textarea = document.createElement('textarea');
    this._textarea.className = 'chat-input';
    this._textarea.placeholder = 'Type a message...';
    this._textarea.rows = 1;

    // Restore draft
    const draft = loadDraft('chat', this.sessionId);
    if (draft) {
      this._textarea.value = draft;
      setTimeout(() => { this._textarea.style.height = 'auto'; this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px'; }, 0);
    }

    // Auto-grow + draft save
    this._draftTimer = null;
    this._textarea.addEventListener('input', () => {
      this._textarea.style.height = 'auto';
      this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => saveDraft('chat', this.sessionId, this._textarea.value), 300);
    });

    // Send on Enter
    this._textarea.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    // Draft sync from other clients
    this._draftSyncHandler = (value) => {
      if (document.activeElement !== this._textarea) {
        this._textarea.value = value || '';
        this._textarea.style.height = 'auto';
        this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
      }
    };
    const sync = getStateSync();
    if (sync) sync.on('drafts', 'chat:' + this.sessionId, this._draftSyncHandler);

    // Send button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = '\u23CE';
    sendBtn.onclick = () => this._send();

    // Interrupt button
    this._interruptBtn = document.createElement('button');
    this._interruptBtn.className = 'chat-interrupt-btn hidden';
    this._interruptBtn.textContent = '\u25A0 Stop';
    this._interruptBtn.onclick = () => this._interrupt();

    inputArea.appendChild(this._textarea);
    inputArea.appendChild(sendBtn);
    inputArea.appendChild(this._interruptBtn);
    container.appendChild(inputArea);
  }

  // ── MessageStore event handlers ──

  _onCreate(msg) {
    const el = this._renderMessage(msg);
    this._messageList.appendChild(el);
    this._elements.set(msg.id, el);

    // Show streaming indicator
    if (msg.status === 'streaming' || msg.status === 'pending') {
      this._showStreaming(msg);
    }

    if (this._pinned) this._scrollToBottom();
  }

  _onEdit(data) {
    const el = this._elements.get(data.id);
    if (!el) return;

    // Re-render the message with updated fields
    const newEl = this._renderMessage(data.message);
    el.replaceWith(newEl);
    this._elements.set(data.id, newEl);

    // Update streaming status
    if (data.fields.status === 'complete') {
      const isLast = this.store.last()?.id === data.id;
      if (isLast) this._hideStreaming();
    }

    if (this._pinned) this._scrollToBottom();
  }

  _onDelete(data) {
    const el = this._elements.get(data.id);
    if (el) { el.remove(); this._elements.delete(data.id); }
  }

  _onBatch() {
    // Full re-render
    this._messageList.innerHTML = '';
    this._elements.clear();
    for (const msg of this.store.messages) {
      const el = this._renderMessage(msg);
      this._messageList.appendChild(el);
      this._elements.set(msg.id, el);
    }
  }

  _onPrepend(data) {
    // Insert older messages at the top
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) {
      const el = this._renderMessage(msg);
      frag.appendChild(el);
      this._elements.set(msg.id, el);
    }
    const oldScrollH = this._messageList.scrollHeight;
    this._messageList.insertBefore(frag, this._messageList.firstChild);
    // Preserve scroll position
    this._messageList.scrollTop += this._messageList.scrollHeight - oldScrollH;
  }

  _onMeta(data) {
    if (data.subtype === 'usage') {
      const u = data.data;
      this._statusInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this._statusCacheRead = u.cache_read_input_tokens || 0;
      this._statusTokensOut = u.output_tokens || 0;
      this._updateStatusBar();
    } else if (data.subtype === 'turn_complete') {
      this._hideStreaming();
      if (data.data?.cost) {
        this._totalCost = (this._totalCost || 0) + data.data.cost;
        this._updateStatusBar();
      }
    }
  }

  // ── Rendering ──

  _renderMessage(msg) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-msg-${msg.role}`;
    el.dataset.msgId = msg.id;

    if (this._compact) {
      const roleLabel = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Claude' : msg.role === 'tool' ? '\u2699' : '\u2139';
      const roleClass = `chat-role chat-role-${msg.role}`;
      el.innerHTML = `<div class="chat-compact-msg"><span class="${roleClass}">${roleLabel}</span><div class="chat-compact-content">${renderNormalizedMessage(msg)}</div></div>`;
    } else {
      el.innerHTML = renderNormalizedMessage(msg);
    }

    // Permission overlay
    if (msg.permission) {
      const permEl = document.createElement('div');
      permEl.innerHTML = renderPermission(msg.permission);
      const permContent = permEl.firstElementChild;
      if (permContent) {
        permContent.addEventListener('click', (e) => {
          const btn = e.target.closest('.chat-perm-btn');
          if (!btn) return;
          this._handlePermission(msg, btn.dataset.action);
        });
        el.querySelector('.chat-tool-use')?.appendChild(permContent);
      }
    }

    // Add wrap toggles to pre/code blocks
    this._addWrapToggles(el);

    return el;
  }

  _addWrapToggles(el) {
    for (const block of el.querySelectorAll('pre, .chat-diff-body, .chat-code-block')) {
      if (block.parentNode?.classList?.contains('chat-pre-wrap')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-pre-wrap';
      block.parentNode.insertBefore(wrapper, block);
      wrapper.appendChild(block);

      const toolbar = document.createElement('div');
      toolbar.className = 'chat-code-toolbar';

      const btn = document.createElement('button');
      btn.className = 'chat-wrap-toggle';
      btn.textContent = 'Wrap';
      btn.onclick = (e) => { e.stopPropagation(); const on = block.classList.toggle('chat-pre-wrapped'); btn.textContent = on ? 'No Wrap' : 'Wrap'; };
      toolbar.appendChild(btn);
      wrapper.appendChild(toolbar);
    }
  }

  // ── Actions ──

  _send() {
    const text = this._textarea?.value.trim();
    if (!text) return;
    this._textarea.value = '';
    this._textarea.style.height = '';
    clearDraft('chat', this.sessionId);

    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text, msgId });
    this._pinned = true;
    this._scrollBtn.classList.add('hidden');
    this._showStreaming({ role: 'assistant', status: 'streaming' });
  }

  _interrupt() {
    this.ws.send({ type: 'interrupt', sessionId: this.sessionId });
  }

  _handlePermission(msg, action) {
    if (!msg.permission) return;
    const approved = action !== 'deny';
    this.ws.send({
      type: 'permission-response', sessionId: this.sessionId,
      requestId: msg.permission.requestId, approved,
      toolInput: msg.permission.input,
      permissionUpdates: action === 'always' ? msg.permission.suggestions : undefined,
    });
  }

  _reattach() {
    this.ws.send({ type: 'attach', sessionId: this.sessionId });
    // The attach handler will detect v2 and send v2 payload
  }

  async _loadMore() {
    if (this._loading || !this.store.hasMore) return;
    this._loading = true;
    try {
      const start = Math.max(0, this.store.windowStart - 50);
      const limit = this.store.windowStart - start;
      if (limit <= 0) { this._loading = false; return; }

      // Use v2 API for normalized messages
      const { claudeId, cwd } = this._getSessionIds();
      const res = await fetch(`/api/session-messages-v2?claudeSessionId=${encodeURIComponent(claudeId)}&cwd=${encodeURIComponent(cwd)}&offset=${start}&limit=${limit}`);
      const data = await res.json();
      if (data.messages?.length) {
        this.store.prepend(data.messages, start);
      }
    } catch {} finally { this._loading = false; }
  }

  _getSessionIds() {
    const allSess = this.app.sidebar?._allSessions || [];
    const match = allSess.find(s => s.webuiId === this.sessionId);
    return { claudeId: match?.sessionId, cwd: match?.cwd || '' };
  }

  // ── UI helpers ──

  _showStreaming(msg) {
    const label = msg?.role === 'tool' ? `running ${msg.toolName || 'tool'}...` : 'thinking...';
    this._streamStatus.textContent = label;
    this._streamStatus.classList.remove('hidden');
    if (this._interruptBtn) this._interruptBtn.classList.remove('hidden');
  }

  _hideStreaming() {
    this._streamStatus.classList.add('hidden');
    if (this._interruptBtn) this._interruptBtn.classList.add('hidden');
  }

  _scrollToBottom() {
    const list = this._messageList;
    let n = 0;
    const step = () => {
      list.scrollTop = list.scrollHeight;
      if (++n < 10) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _applyMeta(meta) {
    this._statusModel = meta.model;
    this._statusPermMode = meta.permissionMode;
    this._totalCost = meta.totalCost;
    this._updateStatusBar();
  }

  _updateStatusBar() {
    if (!this._statusBar) return;
    const parts = [];
    if (this._statusModel) parts.push(`<span class="chat-status-model">${escHtml(this._statusModel)}</span>`);
    if (this._statusPermMode) parts.push(`<span class="chat-status-perm">\uD83D\uDD12 ${escHtml(this._statusPermMode)}</span>`);
    if (this._totalCost) {
      const cost = this._totalCost;
      const cls = cost > 5 ? 'chat-cost-high' : cost > 1 ? 'chat-cost-med' : 'chat-cost-low';
      parts.push(`<span class="chat-status-cost ${cls}">$${cost.toFixed(2)}</span>`);
    }
    this._statusBar.innerHTML = parts.join(' ');
  }

  _setupLinkHandler() {
    this._messageList.addEventListener('click', (e) => {
      const link = e.target.closest('.chat-link') || e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const url = link.dataset.href || link.getAttribute('href');
      const fp = link.dataset.path;
      if (e.ctrlKey || e.metaKey) {
        if (fp) {
          const lineMatch = fp.match(/^(.+?):(\d+)(?:[:\-]\d+)?$/);
          const cleanPath = lineMatch ? lineMatch[1] : fp;
          const lineNum = lineMatch ? parseInt(lineMatch[2], 10) : undefined;
          fetch(`/api/file/info?path=${encodeURIComponent(cleanPath)}`)
            .then(r => r.json())
            .then(info => {
              if (info.error) return;
              if (info.isDirectory) this.app.openFileExplorer(cleanPath);
              else this.app.openFile(cleanPath, cleanPath.split('/').pop(), { line: lineNum });
            }).catch(() => {});
        } else if (url) {
          window.open(url, '_blank');
        }
      } else {
        const text = fp || url;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      }
    });
  }
}

export { ChatViewV2 };
