import { escHtml, saveDraft, loadDraft, clearDraft, getStateSync } from './utils.js';
import { stripAnsi } from './highlight.js';
import { ChatMinimap } from './chat-minimap.js';
import { ChatSearch } from './chat-search.js';
import { ChatRenderers } from './chat-renderers.js';

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

    // Apply compact mode
    this._compact = app.settings?.get('chat.compactMode') ?? true;
    if (this._compact) container.classList.add('chat-compact');
    app.settings?.on('chat.compactMode', (v) => {
      this._compact = v;
      container.classList.toggle('chat-compact', v);
      if (this._renderers) this._renderers._compact = v;
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
    app.settings?.on('chat.roleIndicator', (v) => {
      container.dataset.roleIndicator = v;
    });

    // Status bar (will be added after input area)
    this._statusBar = document.createElement('div');
    this._statusBar.className = 'chat-status-bar';
    this._statusModel = '';
    this._statusLastInputTokens = 0;
    this._statusLastCacheRead = 0;
    this._statusCost = 0;
    this._statusContextWindow = 0;

    // Message list
    this._messageList = document.createElement('div');
    this._messageList.className = 'chat-message-list';

    // Renderers (extracted rendering methods)
    this._renderers = new ChatRenderers({
      ws: wsManager,
      sessionId,
      app,
      compact: this._compact,
      messageList: this._messageList,
      onPermissionResolve: () => this._hideTyping(),
    });

    // Position indicator (shows when not at bottom, e.g. "120-170 / 3000")
    this._posIndicator = document.createElement('div');
    this._posIndicator.className = 'chat-pos-indicator hidden';
    if (this._chatScale !== 1) this._messageList.style.zoom = this._chatScale;
    container.appendChild(this._messageList);
    container.appendChild(this._posIndicator);

    // Scroll minimap — semantic scrollbar showing turns
    this._chatMinimap = new ChatMinimap(container, this._messageList, (idx) => this.jumpToIndex(idx));
    // Sync minimap bounds on resize
    // Minimap ResizeObserver is handled by ChatMinimap internally

    // Scroll-to-bottom / pin button (shown when unpinned, with new message count)
    this._newMsgCount = 0;
    this._scrollBtn = document.createElement('button');
    this._scrollBtn.className = 'chat-scroll-btn hidden';
    this._scrollBtn.innerHTML = '\u2193';
    this._scrollBtn.title = 'Scroll to bottom';
    this._scrollBtn.onclick = () => {
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
    this._messageList.addEventListener('wheel', (e) => {
      if (e.deltaY < 0 && this._messageList.scrollTop < 10 && this._windowStart > 0 && !this._loading && this._canPaginate) {
        this._extendTop();
      }
    }, { passive: true });

    // Scroll detection: pin-to-bottom + auto-load earlier messages (throttled)
    let scrollTick = false;
    this._messageList.addEventListener('scroll', () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        scrollTick = false;
        if (this._programmaticScroll) return; // don't interfere with programmatic scrolls
        const { scrollTop, scrollHeight, clientHeight } = this._messageList;
        const atBottom = scrollHeight - scrollTop - clientHeight < 50;
        if (atBottom && !this._pinned) {
          this._pinned = true;
          this._newMsgCount = 0;
          this._scrollBtn.classList.add('hidden');
        } else if (!atBottom) {
          this._pinned = false;
          this._scrollBtn.classList.remove('hidden');
        }
        if (scrollTop < 100 && this._windowStart > 0 && !this._loading && this._canPaginate) {
          this._extendTop();
        }
        // Extend bottom when scrolling near end of rendered window (but more messages exist)
        if (scrollHeight - scrollTop - clientHeight < 200 && this._windowEnd < this._total && !this._loading && this._canPaginate) {
          this._extendBottom();
        }
        this._updatePosIndicator();
        this._chatMinimap.setViewport(this._windowStart, this._windowEnd, this._total);
      });
    }, { passive: true });

    // Read-only viewers: status displays but no input
    if (this._readOnly) {
      container.classList.add('chat-no-content-visibility');

      // TODO + streaming status + status bar (same as normal mode)
      this._todoDisplay = document.createElement('div');
      this._todoDisplay.className = 'chat-todo-display hidden';
      this._todos = [];
      this._streamStatus = document.createElement('div');
      this._streamStatus.className = 'chat-stream-status hidden';
      this._statusBar = document.createElement('div');
      this._statusBar.className = 'chat-status-bar';

      const statusArea = document.createElement('div');
      statusArea.className = 'chat-input-area';
      statusArea.style.padding = '4px 16px';
      statusArea.append(this._todoDisplay, this._streamStatus);
      container.append(statusArea, this._statusBar);
      container.tabIndex = -1;
      winInfo.content.appendChild(container);

      this._messageList.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG' && e.target.classList.contains('chat-img')) {
          const overlay = document.createElement('div');
          overlay.className = 'chat-img-overlay';
          overlay.innerHTML = `<img src="${e.target.src}" alt="image">`;
          overlay.onclick = () => overlay.remove();
          document.body.appendChild(overlay);
        }
        if (e.target.classList.contains('chat-agent-view-btn')) {
          e.stopPropagation();
          this._openSubagentViewer({ agentId: e.target.dataset.agentId, parentToolUseId: e.target.dataset.parentToolId, description: e.target.dataset.desc });
        }
      });
      this._handler = (msg) => {
        if (msg.type === 'msg' && msg.sessionId === sessionId) {
          this._onOp(msg);
        }
      };
      this.ws.onGlobal(this._handler);
      this._stateHandler = () => {};
      return;
    }

    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';
    this._textarea = document.createElement('textarea');
    this._textarea.className = 'chat-input';
    this._textarea.placeholder = 'Type a message...';
    this._textarea.rows = 1;

    // Attachment area (above input row)
    this._attachments = [];
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
      // Trigger auto-grow for restored content
      setTimeout(() => { this._textarea.style.height = 'auto'; this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px'; }, 0);
    }

    // Auto-grow textarea (skip in expanded mode — user controls height)
    this._draftTimer = null;
    this._textarea.addEventListener('input', () => {
      if (!this._expanded) {
        this._textarea.style.height = 'auto';
        this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
      }
      // Debounced draft save
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => saveDraft('chat', this.sessionId, this._textarea.value), 300);
    });

    // Sync draft from other clients via StateSync
    this._draftSyncHandler = (value) => {
      this._textarea.value = value || '';
      this._textarea.style.height = 'auto';
      this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
    };
    const sync = getStateSync();
    if (sync) sync.on('drafts', 'chat:' + this.sessionId, this._draftSyncHandler);

    // Slash command list (populated from system.init)
    this._slashCommands = [];
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
      if (e.isComposing || e.keyCode === 229) return; // IME composing — don't intercept Enter
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
    this._expanded = false;
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
    inputWrap.append(this._textarea, expandBtn, this._slashDropdown);

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
    this._isStreaming = false;
    sendCol.append(sendBtn, this._shortcutHint);

    // TODO display (above streaming status)
    this._todoDisplay = document.createElement('div');
    this._todoDisplay.className = 'chat-todo-display hidden';
    this._todos = [];

    // Streaming status indicator (above input)
    this._streamStatus = document.createElement('div');
    this._streamStatus.className = 'chat-stream-status hidden';

    inputArea.append(this._attachArea, this._todoDisplay, this._streamStatus, inputWrap, sendCol);

    // Search (extracted to ChatSearch)
    this._search = new ChatSearch(this._messageList, {
      getSessionIds: () => this._getSessionIds(),
      getSessionId: () => this.sessionId,
      jumpToIndex: (idx) => this.jumpToIndex(idx),
      getWindowBounds: () => ({ windowStart: this._windowStart, windowEnd: this._windowEnd }),
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

    container.appendChild(inputArea);
    container.appendChild(this._statusBar);

    // Status bar clicks
    this._statusBar.addEventListener('click', (e) => {
      // Background tasks click → popup
      const taskEl = e.target.closest('.chat-status-tasks');
      if (taskEl && this._activeTasks?.size) {
        e.stopPropagation();
        const existing = container.querySelector('.chat-status-dropdown');
        if (existing) { existing.remove(); return; }
        const dropdown = document.createElement('div');
        dropdown.className = 'chat-status-dropdown';
        const rect = taskEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        dropdown.style.position = 'absolute';
        dropdown.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
        dropdown.style.left = (rect.left - containerRect.left) + 'px';
        for (const [toolUseId, task] of this._activeTasks) {
          const item = document.createElement('div');
          item.className = 'chat-status-dropdown-item chat-task-detail';
          const icon = task.type === 'agent' ? '\uD83E\uDD16' : '\u26A1';
          let detail = `<div class="chat-task-title">${icon} ${escHtml(task.description)}</div>`;
          if (task.lastTool) detail += `<div class="chat-status-dim">Running: ${escHtml(task.lastTool)}</div>`;
          item.innerHTML = detail;
          item.onclick = (ev) => {
            ev.stopPropagation(); dropdown.remove();
            if (task.type === 'agent') {
              this._openSubagentViewer({ parentToolUseId: toolUseId, description: task.description });
            } else {
              // Open command input + output in editor — look up tool message for full details
              const toolMsg = this._messages.find(m => m.toolCallId === toolUseId);
              const block = toolMsg?.content?.[0];
              const input = block?.input || {};
              const toolName = task.toolName || block?.toolName || 'Bash';
              const command = task.command || input.command || JSON.stringify(input, null, 2);
              const output = task.resultText || block?.output || '';
              let text = `[${toolName}] ${task.description}\n\n--- Command ---\n${command}\n`;
              if (output) text += `\n--- Output ---\n${output}\n`;
              this._renderers.openInTempEditor(text);
            }
          };
          dropdown.appendChild(item);
        }
        container.appendChild(dropdown);
        const close = (ev) => { if (!dropdown.contains(ev.target)) { dropdown.remove(); document.removeEventListener('mousedown', close); } };
        setTimeout(() => document.addEventListener('mousedown', close), 0);
        return;
      }

      const el = e.target.closest('.chat-status-perm');
      if (!el) return;
      e.stopPropagation();
      // Remove existing dropdown
      const existing = container.querySelector('.chat-status-dropdown');
      if (existing) { existing.remove(); return; }
      const modes = this._permissionModes || ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'];
      const dropdown = document.createElement('div');
      dropdown.className = 'chat-status-dropdown';
      // Position above the clicked element
      const rect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      dropdown.style.position = 'absolute';
      dropdown.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
      dropdown.style.left = (rect.left - containerRect.left) + 'px';
      for (const mode of modes) {
        const item = document.createElement('div');
        item.className = 'chat-status-dropdown-item' + (mode === this._statusPermMode ? ' active' : '');
        item.textContent = mode;
        item.onclick = (ev) => {
          ev.stopPropagation();
          dropdown.remove();
          this.ws.send({ type: 'set-permission-mode', sessionId: this.sessionId, mode });
          this._statusPermMode = mode;
          this._updateStatusBar();
        };
        dropdown.appendChild(item);
      }
      container.appendChild(dropdown);
      const close = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== el) {
          dropdown.remove(); document.removeEventListener('mousedown', close);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    });

    // Clear waiting blink on focus/click
    winInfo.element.addEventListener('mousedown', () => this._clearWaiting());

    // Image zoom + Agent View Log click handler
    this._messageList.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG' && e.target.classList.contains('chat-img')) {
        const overlay = document.createElement('div');
        overlay.className = 'chat-img-overlay';
        overlay.innerHTML = `<img src="${e.target.src}" alt="image">`;
        overlay.onclick = () => overlay.remove();
        document.body.appendChild(overlay);
      }
      // Agent View Log button
      if (e.target.classList.contains('chat-agent-view-btn')) {
        e.stopPropagation();
        this._openSubagentViewer({ agentId: e.target.dataset.agentId, parentToolUseId: e.target.dataset.parentToolId, description: e.target.dataset.desc });
      }
    });

    // Listen for normalized message ops from server
    this._handler = (msg) => {
      if (msg.type === 'msg' && msg.sessionId === sessionId) {
        this._onOp(msg);
      } else if (msg.type === 'subagent-message' && msg.sessionId === sessionId) {
        this._onSubagentMessage(msg.parentToolUseId, msg.message);
      } else if (msg.type === 'exited' && msg.sessionId === sessionId) {
        this._renderers.appendSystem('Session ended.');
        this._hideTyping();
        this._setReadOnly();
      }
    };
    this.ws.onGlobal(this._handler);

    // Connection state: freeze on disconnect, re-attach + sync on reconnect
    this._disconnected = false;
    this._hasConnected = false; // track first connect vs reconnect
    this._stateHandler = (connected) => {
      this._disconnected = !connected;
      container.classList.toggle('chat-disconnected', !connected);
      this._textarea.disabled = !connected;
      if (!connected) {
        this._hideTyping();
        this._renderers.appendSystem('Disconnected from server');
      } else if (this._hasConnected) {
        this._renderers.appendSystem('Reconnected');
        this._reattach();
      }
      this._hasConnected = true;
    };
    this.ws.onStateChange(this._stateHandler);
  }

  // ── View Manager: sliding window over server message list ──

  // Load initial messages from attach response
  // Load normalized messages from attach response
  loadHistory(messages, totalCount, isStreaming, meta) {
    this._total = totalCount || messages.length;
    this._windowStart = this._total - messages.length;
    this._windowEnd = this._total;
    this._loading = false;

    this._loadingHistory = true;
    for (const msg of messages) this._onCreateMessage(msg);
    this._loadingHistory = false;

    // Apply metadata (chatStatus, taskState)
    if (meta) {
      if (meta.chatStatus) this.applyStatus(meta.chatStatus);
      if (meta.taskState) {
        if (meta.taskState.tasks) {
          if (!this._activeTasks) this._activeTasks = new Map();
          for (const [id, t] of Object.entries(meta.taskState.tasks)) {
            if (t.status === 'running') this._activeTasks.set(id, t);
          }
        }
        if (meta.taskState.todos?.length) {
          this._todos = meta.taskState.todos;
          this._updateTodoDisplay();
        }
        this._updateStatusBar();
      }
    }
    // Render minimap from turn data (attach payload or async fetch fallback)
    if (meta?.turnMap?.length) {
      this._chatMinimap.render(meta.turnMap);
    } else if (this._total > 50) {
      // Fallback: fetch turn map via API
      const { claudeId, cwd } = this._getSessionIds();
      if (claudeId) {
        fetch(`/api/session-messages?claudeSessionId=${encodeURIComponent(claudeId)}&cwd=${encodeURIComponent(cwd)}&turnmap=1`)
          .then(r => r.json()).then(d => { if (d.turns?.length) this._chatMinimap.render(d.turns); }).catch(() => {});
      }
    }
    this._chatMinimap.setViewport(this._windowStart, this._windowEnd, this._total);

    if (isStreaming) this._showTyping();
    this._scrollToBottom();
    // Auto-load more if content doesn't fill viewport (no scrollbar to trigger scroll event)
    setTimeout(() => {
      if (this._windowStart > 0 && this._messageList.scrollHeight <= this._messageList.clientHeight) {
        this._extendTop();
      }
    }, 100);
  }

  // Get session identifiers for API calls
  _getSessionIds() {
    // View-only sessions: extract claudeSessionId from the virtual ID
    if (this.sessionId.startsWith('view-')) {
      const claudeId = this.sessionId.slice('view-'.length);
      const allSess = this.app.sidebar?._allSessions || [];
      const match = allSess.find(s => s.sessionId === claudeId);
      return { claudeId, cwd: match?.cwd || '' };
    }
    const allSess = this.app.sidebar?._allSessions || [];
    const match = allSess.find(s => s.webuiId === this.sessionId);
    return { claudeId: match?.sessionId, cwd: match?.cwd || '' };
  }

  // Fetch a range of messages from server
  async _fetchMessages(offset, limit) {
    const { claudeId, cwd } = this._getSessionIds();
    if (!claudeId) return [];
    const res = await fetch(`/api/session-messages?claudeSessionId=${encodeURIComponent(claudeId)}&cwd=${encodeURIComponent(cwd)}&offset=${offset}&limit=${limit}`);
    const data = await res.json();
    if (data.total) this._total = data.total;
    return data.messages || [];
  }

  // Extend the window upward (scroll up)
  async _extendTop(count = 50) {
    if (this._loading || this._windowStart <= 0) return;
    this._loading = true;

    const newStart = Math.max(0, this._windowStart - count);
    const fetchCount = this._windowStart - newStart;
    const msgs = await this._fetchMessages(newStart, fetchCount);

    const scrollHeightBefore = this._messageList.scrollHeight;
    const firstEl = this._messageList.querySelector('.chat-msg');
    this._loadingHistory = true;
    for (const msg of msgs) {
      const el = this._renderDetached(msg);
      if (el && firstEl) this._messageList.insertBefore(el, firstEl);
    }
    this._loadingHistory = false;
    this._windowStart = newStart;

    // Trim bottom if DOM window too large (keep max ~150 rendered messages)
    this._trimBottom();

    // Preserve scroll position
    this._messageList.scrollTop += (this._messageList.scrollHeight - scrollHeightBefore);
    if (this._search?.hasHighlight) this._search.applyHighlightLayer();
    setTimeout(() => { this._loading = false; }, 300);
  }

  // Load messages at the bottom (when scrolling back down after trimming)
  async _extendBottom(count = 50) {
    if (this._loading || this._windowEnd >= this._total) return;
    this._loading = true;

    const end = Math.min(this._total, this._windowEnd + count);
    const msgs = await this._fetchMessages(this._windowEnd, end - this._windowEnd);

    this._loadingHistory = true;
    for (const msg of msgs) this._onCreateMessage(msg);
    this._loadingHistory = false;
    this._windowEnd = end;

    // Trim top if DOM window too large
    this._trimTop();

    setTimeout(() => { this._loading = false; }, 300);
  }

  // Keep DOM under ~150 messages by removing from bottom
  _trimBottom(maxRendered = 150) {
    const els = this._messageList.querySelectorAll('.chat-msg');
    if (els.length <= maxRendered) return;
    const toRemove = els.length - maxRendered;
    for (let i = els.length - 1; i >= els.length - toRemove; i--) {
      const id = els[i].dataset.msgId;
      if (id) { this._elements.delete(id); this._renderedMsgIds.delete(id); }
      els[i].remove();
    }
    this._windowEnd -= toRemove;
    this._pinned = false; // we trimmed the bottom, can't be pinned
  }

  // Keep DOM under ~150 messages by removing from top
  _trimTop(maxRendered = 150) {
    const els = this._messageList.querySelectorAll('.chat-msg');
    if (els.length <= maxRendered) return;
    const scrollHeightBefore = this._messageList.scrollHeight;
    const toRemove = els.length - maxRendered;
    for (let i = 0; i < toRemove; i++) {
      const id = els[i].dataset.msgId;
      if (id) { this._elements.delete(id); this._renderedMsgIds.delete(id); }
      els[i].remove();
    }
    this._windowStart += toRemove;
    // Preserve scroll position after removing from top
    this._messageList.scrollTop -= (scrollHeightBefore - this._messageList.scrollHeight);
  }

  // Jump to a specific message index: replace window entirely
  async jumpToIndex(targetIdx) {
    const windowSize = 50;
    const start = Math.max(0, targetIdx - 20);
    const end = Math.min(this._total, start + windowSize);
    const msgs = await this._fetchMessages(start, end - start);

    // Clear and rebuild DOM
    this._messageList.querySelectorAll('.chat-msg, .chat-msg-system').forEach(el => el.remove());
    this._elements.clear();
    this._renderedMsgIds.clear();
    this._messages = [];
    this._windowStart = start;
    this._windowEnd = end;
    this._pinned = false;

    this._loadingHistory = true;
    for (const msg of msgs) this._onCreateMessage(msg);
    this._loadingHistory = false;

    // Scroll to the target message
    const relIdx = targetIdx - start;
    const allMsgs = this._messageList.querySelectorAll('.chat-msg');
    if (relIdx >= 0 && relIdx < allMsgs.length) {
      const targetEl = allMsgs[relIdx];
      for (const d of targetEl.querySelectorAll('details:not([open])')) d.open = true;
      targetEl.style.contentVisibility = 'visible';
      requestAnimationFrame(() => targetEl.scrollIntoView({ block: 'center' }));
    }
  }

  // Jump to the bottom of the conversation
  async jumpToBottom() {
    const windowSize = 50;
    const start = Math.max(0, this._total - windowSize);
    const msgs = await this._fetchMessages(start, this._total - start);

    this._messageList.querySelectorAll('.chat-msg, .chat-msg-system').forEach(el => el.remove());
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

    // Temporarily disable content-visibility so the browser computes real heights
    // for all elements, then scroll to bottom, then re-enable
    this._forceScrollToBottom();
  }

  _forceScrollToBottom() {
    this._programmaticScroll = true;
    const list = this._messageList;
    let n = 0;
    const step = () => {
      list.scrollTop = list.scrollHeight;
      // Each frame scrolling reveals off-screen elements, browser computes
      // their real heights (replacing content-visibility estimates), scrollHeight
      // grows — repeat until converged or max 10 frames (~166ms)
      if (++n < 10) requestAnimationFrame(step);
      else this._programmaticScroll = false;
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

  _send() {
    if (this._disconnected) return;
    const text = this._textarea.value.trim();
    const hasAttachments = this._attachments.length > 0;
    if (!text && !hasAttachments) return;

    this._textarea.value = '';
    this._textarea.style.height = '';
    this._textarea.style.minHeight = '';
    clearDraft('chat', this.sessionId);
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
      this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text: msg });
      this._attachments = [];
      this._renderAttachments();
    } else {
      this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text });
    }
    // Re-pin — if we're not at the end of conversation, jump there first
    if (this._windowEnd < this._total) {
      this.jumpToBottom();
    } else {
      this._pinned = true;
      this._newMsgCount = 0;
      this._scrollBtn.classList.add('hidden');
      this._scrollToBottom();
    }
    this._showTyping('thinking...');
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

    // Live message while viewing history: don't render, just track count
    if (!this._loadingHistory && !this._pinned && this._windowEnd < this._total) {
      this._total++;
      this._newMsgCount++;
      this._scrollBtn.innerHTML = `\u2193 <span class="chat-scroll-badge">${this._newMsgCount}</span>`;
      this._scrollBtn.classList.remove('hidden');
      return;
    }

    this._renderedMsgIds.add(msg.id);
    this._messages.push(msg);

    // Streaming indicator for live messages (server isStreaming is authority for initial state)
    if (!this._loadingHistory && (msg.status === 'streaming' || msg.status === 'pending')) {
      const label = msg.role === 'tool' ? `running ${msg.toolName || 'tool'}...` : msg.content?.[0]?.type === 'thinking' ? 'thinking...' : 'responding...';
      this._showTyping(label);
    }

    let el;
    switch (msg.role) {
      case 'user': el = this._renderers.renderUserMsg(msg); break;
      case 'assistant': el = this._renderers.renderAssistantMsg(msg); break;
      case 'tool': el = this._renderers.renderToolMsg(msg); break;
      case 'system': {
        const result = this._renderers.renderSystemMsg(msg);
        if (result?.sideEffect) {
          const se = result.sideEffect;
          if (se.model) this._statusModel = se.model;
          if (se.permMode) this._statusPermMode = se.permMode;
          if (se.slashCommands) this._slashCommands = se.slashCommands;
          this._updateStatusBar();
        }
        el = result?.el || null;
        break;
      }
      default: return;
    }

    if (!el) return;
    el.dataset.msgId = msg.id;
    this._elements.set(msg.id, el);
    this._messageList.appendChild(el);
    this._renderers.addWrapToggles(el);
    this._renderers.addOpenInEditorBtn(el);
    // Update window bounds for live messages (not history batch)
    if (!this._loadingHistory) {
      this._total++;
      this._windowEnd = this._total;
    }
    if (this._pinned) this._scrollToBottom();
  }

  // Edit an existing message → re-render in place
  _onEditMessage(id, fields) {
    // Update stored message
    const msgIdx = this._messages.findIndex(m => m.id === id);
    if (msgIdx < 0) return;
    const msg = this._messages[msgIdx];
    Object.assign(msg, fields);

    // Status transitions
    if (fields.status === 'complete' || fields.status === 'error' || fields.status === 'interrupted') {
      // Tool call completed → re-render the element
      const oldEl = this._elements.get(id);
      if (oldEl) {
        let newEl;
        switch (msg.role) {
          case 'tool': newEl = this._renderers.renderToolMsg(msg); break;
          case 'assistant': newEl = this._renderers.renderAssistantMsg(msg); break;
          default: {
            const result = this._renderers.renderSystemMsg(msg);
            newEl = result?.el || null;
            break;
          }
        }
        if (newEl) {
          newEl.dataset.msgId = id;
          oldEl.replaceWith(newEl);
          this._elements.set(id, newEl);
          this._renderers.addWrapToggles(newEl);
          this._renderers.addOpenInEditorBtn(newEl);
        }
      }
      // Hide streaming indicator if this is the last message
      if (this._messages[this._messages.length - 1]?.id === id) this._hideTyping();
    }

    // Streaming text update → just update the text content
    if (fields.content && msg.status === 'streaming') {
      const oldEl = this._elements.get(id);
      if (oldEl) {
        const textDiv = oldEl.querySelector('.chat-text');
        if (textDiv && msg.content[0]?.type === 'text') {
          textDiv.innerHTML = this._renderers.renderMarkdown(stripAnsi(msg.content[0].text));
        }
      }
    }

    if (this._pinned) this._scrollToBottom();

    // Permission update
    if (fields.permission) {
      const el = this._elements.get(id);
      if (el) this._renderers.renderPermissionOverlay(el, msg);
    }

    // Task info update — enrich with tool context from the normalized message
    if (fields.taskInfo) {
      if (!this._activeTasks) this._activeTasks = new Map();
      if (fields.taskInfo.status === 'completed') {
        this._activeTasks.delete(msg.toolCallId);
      } else if (fields.taskInfo.status === 'running') {
        const block = msg.content?.[0];
        const task = { ...fields.taskInfo };
        if (block?.type === 'tool_call') {
          task.toolName = block.toolName;
          task.command = block.input?.command || '';
        }
        this._activeTasks.set(msg.toolCallId, task);
      }
      this._updateStatusBar();
    }
  }

  // Handle meta ops (usage, cost, turn_complete)
  _onMeta(op) {
    if (op.subtype === 'usage') {
      const u = op.data;
      this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this._statusLastCacheRead = u.cache_read_input_tokens || 0;
      this._updateStatusBar();
    } else if (op.subtype === 'todos') {
      this._todos = op.data;
      this._updateTodoDisplay();
    } else if (op.subtype === 'turn_complete') {
      this._hideTyping();
      if (op.data?.cost) { this._statusCost += op.data.cost; this._updateStatusBar(); }
      if (op.data?.modelUsage) {
        const info = Object.values(op.data.modelUsage)[0];
        if (info?.contextWindow) this._statusContextWindow = info.contextWindow;
        if (!this._statusModel) this._statusModel = Object.keys(op.data.modelUsage)[0]?.replace(/\[.*$/, '');
        this._updateStatusBar();
      }
      // Blink window
      if (!this.winInfo.element.classList.contains('window-active')) {
        this.winInfo.element.classList.add('window-waiting');
        if (this.winInfo._notifyChanged) this.winInfo._notifyChanged();
      }
    }
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

  // Inject permission UI into the matching pending tool card

  _showTyping(label = 'thinking...') {
    if (!this._streamStatus) return;
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> ${escHtml(label)}<button class="chat-interrupt-btn" title="Interrupt">\u25A0 Stop</button>`;
    this._streamStatus.querySelector('.chat-interrupt-btn').onclick = () => this._interrupt();
    this._streamStatus.classList.remove('hidden');
    this._isStreaming = true;
  }

  _hideTyping() {
    if (!this._streamStatus) return;
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
    this._isStreaming = false;
  }

  _interrupt() {
    this.ws.send({ type: 'interrupt', sessionId: this.sessionId });
  }

  _onSubagentMessage(parentToolUseId, msg) {
    if (!parentToolUseId) return;
    // Track message count for tool card status
    if (!this._subagentCounts) this._subagentCounts = new Map();
    this._subagentCounts.set(parentToolUseId, (this._subagentCounts.get(parentToolUseId) || 0) + 1);

    // Update pending Agent card status
    const pending = this._messageList.querySelector(`[data-tool-id="${parentToolUseId}"]`);
    if (pending) {
      let statusEl = pending.querySelector('.chat-agent-live-status');
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'chat-agent-live-status';
        const outputPending = pending.querySelector('.chat-tool-output-pending');
        if (outputPending) outputPending.before(statusEl);
        else pending.appendChild(statusEl);
      }
      const count = this._subagentCounts.get(parentToolUseId);
      // Detect activity from raw subagent message
      let activity = '';
      const c = msg.message?.content || msg.content;
      if (Array.isArray(c)) {
        const last = c[c.length - 1];
        if (last?.type === 'tool_use' || last?.type === 'tool_call') activity = `running ${last.name || last.toolName || 'tool'}`;
        else if (last?.type === 'thinking') activity = 'thinking';
        else if (last?.type === 'text') activity = 'responding';
      }
      // Find description from stored messages
      const toolMsg = this._messages.find(m => m.toolCallId === parentToolUseId);
      const desc = toolMsg?.content?.[0]?.input?.description || '';
      statusEl.innerHTML = `<span class="chat-agent-live-count">${count} messages${activity ? ' \u2022 ' + escHtml(activity) : ''}</span> <button class="chat-agent-view-btn" data-parent-tool-id="${escHtml(parentToolUseId)}" data-desc="${escHtml(desc)}">View Log</button>`;
    }
  }

  // Unified subagent viewer: works for both live (parentToolUseId) and completed (agentId)
  _openSubagentViewer({ parentToolUseId, agentId, description }) {
    // Virtual session ID for subscribing to messages
    const virtualId = agentId ? `sub-agent-${agentId}` : `sub-${parentToolUseId}`;

    // Reuse existing viewer window if still open
    if (!this._subagentViewers) this._subagentViewers = new Map();
    const existingWinId = this._subagentViewers.get(virtualId);
    if (existingWinId && this.app.wm.windows.has(existingWinId)) {
      this.app.wm.focusWindow(existingWinId);
      return;
    }

    const title = `\uD83E\uDD16 ${description || 'Agent'}`;
    const winInfo = this.app.wm.createWindow({ title, type: 'chat' });
    this._subagentViewers.set(virtualId, winInfo.id);
    const { claudeId, cwd } = this._getSessionIds();
    winInfo._openSpec = { action: 'viewSubagent', virtualId, parentSessionId: this.sessionId, claudeSessionId: claudeId, cwd, description };
    const view = new ChatView(winInfo, this.ws, virtualId, this.app, { readOnly: true });

    // Attach to virtual session — server returns history + sets up live forwarding
    this.ws.send({ type: 'attach', sessionId: virtualId, parentSessionId: this.sessionId, claudeSessionId: claudeId, cwd });

    // One-time handler for attach response
    const handler = (msg) => {
      if (msg.type === 'attached' && msg.sessionId === virtualId) {
        this.ws.offGlobal(handler);
        if (msg.messages?.length) {
          view.loadHistory(msg.messages, msg.totalCount, msg.isStreaming);
        }
      }
    };
    this.ws.onGlobal(handler);

    winInfo.onClose = () => { this._subagentViewers.delete(virtualId); view.dispose(); this.app._checkWelcome(); };
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
      const existing = this._container.querySelector('.chat-todo-popup');
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
      const containerRect = this._container.getBoundingClientRect();
      popup.style.position = 'absolute';
      popup.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
      popup.style.left = '12px';
      popup.style.right = '12px';
      this._container.appendChild(popup);
      const close = (ev) => { if (!popup.contains(ev.target) && !this._todoDisplay.contains(ev.target)) { popup.remove(); document.removeEventListener('mousedown', close); } };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    };
  }

  applyStatus(status) {
    if (!status) return;
    if (status.model) this._statusModel = status.model.replace(/\[.*$/, '');
    if (status.contextWindow) this._statusContextWindow = status.contextWindow;
    if (status.lastUsage) {
      const u = status.lastUsage;
      this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this._statusLastCacheRead = u.cache_read_input_tokens || 0;
    }
    if (status.total_cost_usd) this._statusCost = status.total_cost_usd;
    if (status.permissionMode) this._statusPermMode = status.permissionMode;
    if (status.permissionModes) this._permissionModes = status.permissionModes;
    if (status.slashCommands) this._slashCommands = status.slashCommands.map(c => c.startsWith('/') ? c : '/' + c);
    this._updateStatusBar();
  }

  _updateStatusBar() {
    const fmtK = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'm' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    const parts = [];

    // Model badge
    if (this._statusModel) {
      parts.push(`<span class="chat-status-model" title="Model (set at session creation)">${escHtml(this._statusModel)}</span>`);
    }

    // Permission mode (always show, click to change)
    const permLabel = this._statusPermMode || 'default';
    parts.push(`<span class="chat-status-perm chat-status-clickable" title="Click to change permission mode">\uD83D\uDD12 ${escHtml(permLabel)}</span>`);

    // Background tasks
    if (this._activeTasks?.size > 0) {
      const count = this._activeTasks.size;
      const tasks = [...this._activeTasks.values()];
      const label = count === 1 ? tasks[0].description : `${count} tasks`;
      parts.push(`<span class="chat-status-tasks chat-status-clickable" title="${escHtml(tasks.map(t => t.description).join(', '))}">\uD83D\uDD04 ${escHtml(label)}</span>`);
    }

    // Context % with emoji + progress bar
    if (this._statusContextWindow && this._statusLastInputTokens) {
      const pct = Math.min(100, Math.round((this._statusLastInputTokens / this._statusContextWindow) * 100));
      let icon, barColor;
      if (pct > 95) { icon = '\uD83D\uDD34'; barColor = '#ef4444'; } // 🔴
      else if (pct > 85) { icon = '\uD83D\uDFE0'; barColor = '#f97316'; } // 🟠
      else if (pct > 70) { icon = '\uD83D\uDFE1'; barColor = '#eab308'; } // 🟡
      else { icon = '\uD83D\uDFE2'; barColor = '#22c55e'; } // 🟢
      const usedK = fmtK(this._statusLastInputTokens);
      const totalK = fmtK(this._statusContextWindow);
      parts.push(`<span class="chat-status-ctx">${icon} <span class="chat-status-ctx-bar"><span class="chat-status-ctx-fill" style="width:${pct}%;background:${barColor}"></span></span> <span style="color:${barColor}">${pct}%</span><span class="chat-status-dim">[${usedK}/${totalK}]</span></span>`);
    }

    // Cache ratio
    if (this._statusLastCacheRead != null && this._statusLastInputTokens) {
      const cacheTotal = this._statusLastInputTokens;
      const cachePct = cacheTotal > 0 ? Math.round((this._statusLastCacheRead / cacheTotal) * 100) : 0;
      const cacheColor = cachePct >= 80 ? '#22c55e' : cachePct >= 50 ? '#eab308' : '#f97316';
      parts.push(`<span style="color:${cacheColor}">\u26A1${cachePct}%</span><span class="chat-status-dim">[${fmtK(this._statusLastCacheRead)}]</span>`);
    }

    // Cost with color tiers
    if (this._statusCost > 0) {
      const costColor = this._statusCost > 5 ? '#ef4444' : this._statusCost > 1 ? '#f97316' : '#22c55e';
      parts.push(`<span style="color:${costColor}">$${this._statusCost.toFixed(2)}</span>`);
    }

    this._statusBar.innerHTML = parts.join(' ');
  }

  _scrollToBottom() {
    this._forceScrollToBottom();
  }

  // Re-attach to session after reconnect: re-register with server + sync missed messages
  _reattach() {
    // Re-attach so server adds this WS to session.clients again
    this.ws.send({ type: 'attach', sessionId: this.sessionId });

    // Fetch messages from where we left off to catch up
    const missedStart = this._windowEnd;
    this._fetchMessages(missedStart, 200).then(msgs => {
      if (!msgs.length) return;
      this._loadingHistory = true;
      for (const msg of msgs) this._onCreateMessage(msg);
      this._loadingHistory = false;
      if (this._pinned) this._scrollToBottom();
    }).catch(() => {});
  }

  _clearWaiting() {
    if (this.winInfo.element.classList.contains('window-waiting')) {
      this.winInfo.element.classList.remove('window-waiting');
      if (this.winInfo._notifyChanged) this.winInfo._notifyChanged();
    }
  }

  focus() {
    if (this._textarea) this._textarea.focus();
    this._clearWaiting();
  }

  // Minimap extracted to ChatMinimap class (src/lib/chat-minimap.js)

  _updatePosIndicator() {
    if (!this._posIndicator || !this._total) return;
    if (this._pinned && this._windowEnd >= this._total) {
      this._posIndicator.classList.add('hidden');
      return;
    }
    this._posIndicator.textContent = `${this._windowStart + 1}\u2013${this._windowEnd} / ${this._total}`;
    this._posIndicator.classList.remove('hidden');
  }

  // Convert to read-only mode (after session terminate/exit)
  _setReadOnly() {
    this._readOnly = true;
    if (this._textarea) {
      this._textarea.disabled = true;
      this._textarea.placeholder = 'Session ended';
    }
    // Hide send/interrupt buttons
    const inputArea = this._container?.querySelector('.chat-input-area');
    if (inputArea) inputArea.style.display = 'none';
  }

  dispose() {
    this.ws.offGlobal(this._handler);
    this.ws.offStateChange(this._stateHandler);
    if (this._draftSyncHandler) {
      const sync = getStateSync();
      if (sync) sync.off('drafts', 'chat:' + this.sessionId, this._draftSyncHandler);
    }
    if (this._chatMinimap) this._chatMinimap.dispose();
    if (this._search) this._search.dispose();
  }
}

export { ChatView };
