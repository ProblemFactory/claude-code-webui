import { marked } from 'marked';
import { escHtml } from './utils.js';

// Strip ANSI escape sequences (colors, cursor, etc.)
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * ChatView — renders a chat interface for stream-json mode sessions.
 * Displays structured messages from Claude Code's --output-format stream-json.
 * Input goes to the same PTY session via WebSocket.
 */
class ChatView {
  constructor(winInfo, wsManager, sessionId, app) {
    this.winInfo = winInfo;
    this.ws = wsManager;
    this.sessionId = sessionId;
    this.app = app;
    this._messages = []; // parsed message objects
    this._pinned = true; // auto-scroll to bottom
    this._renderedMsgIds = new Set(); // dedup by msgId
    this._highlightQuery = ''; // active search query for highlight layer
    this._pendingToolUses = new Map(); // tool_use id → block (for deferred diff rendering)

    // Build DOM
    const container = document.createElement('div');
    container.className = 'chat-view';
    this._container = container;
    winInfo.content.appendChild(container);

    // Apply compact mode
    this._compact = app.settings?.get('chat.compactMode') ?? true;
    if (this._compact) container.classList.add('chat-compact');
    app.settings?.on('chat.compactMode', (v) => {
      this._compact = v;
      container.classList.toggle('chat-compact', v);
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
    this._statusTokensOut = 0;
    this._statusLastInputTokens = 0;
    this._statusLastCacheRead = 0;
    this._statusCost = 0;
    this._statusContextWindow = 0;

    // Message list
    this._messageList = document.createElement('div');
    this._messageList.className = 'chat-message-list';
    if (this._chatScale !== 1) this._messageList.style.zoom = this._chatScale;
    container.appendChild(this._messageList);

    // Scroll-to-bottom / pin button (shown when unpinned, with new message count)
    this._newMsgCount = 0;
    this._scrollBtn = document.createElement('button');
    this._scrollBtn.className = 'chat-scroll-btn hidden';
    this._scrollBtn.innerHTML = '\u2193';
    this._scrollBtn.title = 'Scroll to bottom';
    this._scrollBtn.onclick = () => {
      this.jumpToBottom();
    };
    container.appendChild(this._scrollBtn);

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
        if (scrollTop < 100 && this._windowStart > 0 && !this._loading) {
          this._extendTop();
        }
      });
    }, { passive: true });

    // Input area
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

    // Auto-grow textarea (skip in expanded mode — user controls height)
    this._textarea.addEventListener('input', () => {
      if (this._expanded) return;
      this._textarea.style.height = 'auto';
      this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
    });

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
      // Escape: send to PTY to interrupt running Claude
      if (e.key === 'Escape') {
        this.ws.send({ type: 'input', sessionId: this.sessionId, data: '\x1b' });
        return;
      }
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
    sendBtn.textContent = '▶';
    sendBtn.title = 'Send';
    sendBtn.onclick = () => this._send();
    this._shortcutHint = document.createElement('div');
    this._shortcutHint.className = 'chat-shortcut-hint';
    this._shortcutHint.textContent = '\u23CE';
    sendCol.append(sendBtn, this._shortcutHint);

    // Streaming status indicator (above input)
    this._streamStatus = document.createElement('div');
    this._streamStatus.className = 'chat-stream-status hidden';

    inputArea.append(this._attachArea, this._streamStatus, inputWrap, sendCol);

    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'chat-search-bar hidden';
    const searchInput = document.createElement('input');
    searchInput.className = 'chat-search-input';
    searchInput.placeholder = 'Search messages...';
    searchInput.type = 'text';
    this._searchStatus = document.createElement('span');
    this._searchStatus.className = 'chat-search-status';
    const searchPrev = document.createElement('button');
    searchPrev.className = 'chat-search-nav';
    searchPrev.textContent = '\u25B2';
    searchPrev.title = 'Previous';
    searchPrev.onclick = () => this._searchNav(-1);
    const searchNext = document.createElement('button');
    searchNext.className = 'chat-search-nav';
    searchNext.textContent = '\u25BC';
    searchNext.title = 'Next';
    searchNext.onclick = () => this._searchNav(1);
    const searchClose = document.createElement('button');
    searchClose.className = 'chat-search-close';
    searchClose.textContent = '\u2715';
    searchClose.onclick = () => { searchBar.classList.add('hidden'); searchInput.value = ''; this._clearSearch(); };
    searchBar.append(searchInput, this._searchStatus, searchPrev, searchNext, searchClose);
    this._searchInput = searchInput;
    this._searchMatches = [];
    this._searchIdx = -1;
    container.insertBefore(searchBar, this._messageList);

    searchInput.addEventListener('input', () => this._doSearch(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._searchNav(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { searchClose.click(); }
    });

    // Ctrl+F to search
    container.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        searchBar.classList.remove('hidden');
        searchInput.focus();
        searchInput.select();
      }
    });
    container.tabIndex = -1;

    container.appendChild(inputArea);
    container.appendChild(this._statusBar);

    // Clear waiting blink on focus/click
    winInfo.element.addEventListener('mousedown', () => this._clearWaiting());

    // Set up click handler for links/paths + image zoom
    this._setupLinkHandler();
    this._messageList.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG' && e.target.classList.contains('chat-img')) {
        // Open image in a simple overlay
        const overlay = document.createElement('div');
        overlay.className = 'chat-img-overlay';
        overlay.innerHTML = `<img src="${e.target.src}" alt="image">`;
        overlay.onclick = () => overlay.remove();
        document.body.appendChild(overlay);
      }
    });

    // Listen for chat messages from server
    this._handler = (msg) => {
      if (msg.type === 'chat-message' && msg.sessionId === sessionId) {
        this._onMessage(msg.message);
      } else if (msg.type === 'exited' && msg.sessionId === sessionId) {
        this._appendSystem('Session ended.');
        this._hideTyping();
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
        this._appendSystem('Disconnected from server');
      } else if (this._hasConnected) {
        this._appendSystem('Reconnected');
        this._reattach();
      }
      this._hasConnected = true;
    };
    this.ws.onStateChange(this._stateHandler);
  }

  // ── View Manager: sliding window over server message list ──

  // Load initial messages from attach response
  loadHistory(messages, totalCount, isStreaming) {
    this._total = totalCount || messages.length;
    this._windowStart = this._total - messages.length; // index of first loaded msg
    this._windowEnd = this._total; // index after last loaded msg
    this._loading = false;

    for (const msg of messages) this._onMessage(msg, true);
    if (isStreaming) this._showTyping();
    this._scrollToBottom();
  }

  // Get session identifiers for API calls
  _getSessionIds() {
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
    for (const msg of msgs) {
      const el = this._renderElement(msg);
      if (el && firstEl) this._messageList.insertBefore(el, firstEl);
    }
    this._windowStart = newStart;

    // Preserve scroll position
    this._messageList.scrollTop += (this._messageList.scrollHeight - scrollHeightBefore);
    if (this._highlightQuery) this._applyHighlightLayer();
    setTimeout(() => { this._loading = false; }, 300);
  }

  // Jump to a specific message index: replace window entirely
  async jumpToIndex(targetIdx) {
    const windowSize = 50;
    const start = Math.max(0, targetIdx - 20);
    const end = Math.min(this._total, start + windowSize);
    const msgs = await this._fetchMessages(start, end - start);

    // Clear and rebuild DOM
    this._messageList.querySelectorAll('.chat-msg, .chat-msg-system').forEach(el => el.remove());
    this._windowStart = start;
    this._windowEnd = end;
    this._pinned = false;

    for (const msg of msgs) this._onMessage(msg, true);

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
    this._windowStart = start;
    this._windowEnd = this._total;

    for (const msg of msgs) this._onMessage(msg, true);
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

  // Render a single message element (append to list, then detach for insertion elsewhere)
  _renderElement(msg) {
    const countBefore = this._messageList.children.length;
    this._onMessage(msg, true);
    const countAfter = this._messageList.children.length;
    if (countAfter > countBefore) {
      return this._messageList.removeChild(this._messageList.lastElementChild);
    }
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
    if (this._expanded) {
      this._expanded = false;
      this._textarea.classList.remove('chat-input-expanded');
      const eb = this._textarea.parentElement?.querySelector('.chat-expand-btn');
      if (eb) { eb.textContent = '\u2922'; eb.title = 'Expand editor'; }
      this._shortcutHint.textContent = '\u23CE';
    }

    const msgId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    if (hasAttachments) {
      const content = [];
      for (const a of this._attachments) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
      }
      if (text) content.push({ type: 'text', text });
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
      this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text: msg, msgId });
      // Show local preview immediately (server echo deduped by msgId)
      this._onMessage({ type: 'user', message: { role: 'user', content }, msgId });
      this._attachments = [];
      this._renderAttachments();
    } else {
      this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text, msgId });
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

  _onMessage(msg, isHistory = false) {
    // Dedup by msgId — skip if already rendered
    if (msg.msgId) {
      if (this._renderedMsgIds.has(msg.msgId)) return;
      this._renderedMsgIds.add(msg.msgId);
    }
    this._messages.push(msg);

    switch (msg.type) {
      case 'user':
        this._appendUser(msg);
        break;
      case 'assistant':
        if (!isHistory) this._updateTyping(msg);
        this._appendAssistant(msg);
        // Track per-turn usage from assistant message (NOT result.modelUsage which is cumulative)
        if (msg.message?.usage && !isHistory) {
          const u = msg.message.usage;
          this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          this._statusLastCacheRead = u.cache_read_input_tokens || 0;
          this._statusTokensOut = u.output_tokens || 0;
          this._updateStatusBar();
        }
        break;
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.model) this._statusModel = msg.model.replace(/\[.*$/, '');
          if (msg.slash_commands) this._slashCommands = msg.slash_commands.map(c => '/' + c);
          this._updateStatusBar();
        }
        break;
      case 'result':
        if (!isHistory) {
          this._hideTyping();
          // Blink window when result arrives and window is not focused
          if (!this.winInfo.element.classList.contains('window-active')) {
            this.winInfo.element.classList.add('window-waiting');
            if (this.winInfo._notifyChanged) this.winInfo._notifyChanged();
          }
        }
        this._appendResult(msg);
        if (!isHistory) {
          if (msg.total_cost_usd) { this._statusCost += msg.total_cost_usd; this._updateStatusBar(); }
          if (msg.modelUsage && !this._statusContextWindow) {
            const info = Object.values(msg.modelUsage)[0];
            if (info?.contextWindow) this._statusContextWindow = info.contextWindow;
            if (!this._statusModel) this._statusModel = Object.keys(msg.modelUsage)[0]?.replace(/\[.*$/, '');
            this._updateStatusBar();
          }
        }
        break;
      case 'rate_limit_event':
        // Skip silently
        break;
      default:
        // Unknown type — skip
        break;
    }

    if (!isHistory) {
      this._total = (this._total || 0) + 1;
      this._windowEnd = this._total;
      if (this._pinned) {
        this._scrollToBottom();
      } else {
        this._newMsgCount++;
        this._scrollBtn.innerHTML = `\u2193 <span class="chat-scroll-badge">${this._newMsgCount}</span>`;
      }
    }
  }

  _appendUser(msg) {
    const content = msg.message?.content;
    if (!content) return;

    // Distinguish actual user messages from tool results
    const isToolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result');

    if (isToolResult) {
      for (const block of content) {
        const toolId = block.tool_use_id;
        const pendingUse = toolId ? this._pendingToolUses.get(toolId) : null;
        const status = block.is_error ? 'error' : 'ok';
        const rawText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
        const resultText = stripAnsi(rawText);

        if (pendingUse) {
          // Replace the pending placeholder with the final result
          this._pendingToolUses.delete(toolId);
          const placeholder = this._messageList.querySelector(`[data-tool-id="${toolId}"]`);

          let html = '';
          const fp = pendingUse.input?.file_path || '';
          if (status === 'ok' && pendingUse.name === 'Edit' && pendingUse.input?.old_string != null) {
            html = this._renderEditDiff(pendingUse);
          } else if (status === 'ok' && pendingUse.name === 'Write') {
            const content = pendingUse.input?.content || '';
            const lineCount = content.split('\n').length;
            const byteCount = new Blob([content]).size;
            const sizeStr = byteCount > 1024 ? (byteCount / 1024).toFixed(1) + ' KB' : byteCount + ' B';
            const preview = content.substring(0, 500);
            html = `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Write ${this._clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines, ${sizeStr}</summary><pre>${escHtml(preview)}${content.length > 500 ? '\n...' : ''}</pre></details></div>`;
          } else if (status === 'ok' && pendingUse.name === 'Read') {
            const lineCount = resultText.split('\n').length;
            const preview = resultText.substring(0, 500);
            html = `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4D6} Read ${this._clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines</summary><pre>${escHtml(preview)}${resultText.length > 500 ? '\n...' : ''}</pre></details></div>`;
          } else if (status !== 'ok') {
            // Failed tool — show error with expandable original input
            const firstLine = resultText.split('\n')[0].substring(0, 150) || '(empty)';
            const inputStr = stripAnsi(typeof pendingUse.input === 'string' ? pendingUse.input : JSON.stringify(pendingUse.input, null, 2));
            html = `<div class="chat-tool-use chat-tool-use-error"><span class="chat-tool-label">\u2717 ${escHtml(pendingUse.name)} ${this._clickablePath(fp)}</span><div class="chat-tool-error-reason">${escHtml(firstLine)}</div><details class="chat-diff"><summary class="chat-diff-summary">Show input</summary><pre>${escHtml(inputStr).substring(0, 3000)}</pre></details></div>`;
          } else {
            // Other tool success — show with collapsible input + output
            const inputStr = stripAnsi(typeof pendingUse.input === 'string' ? pendingUse.input : JSON.stringify(pendingUse.input, null, 2));
            const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
            const truncated = resultText.length > 3000 ? resultText.substring(0, 3000) + '\n...' : resultText;
            html = `<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(pendingUse.name)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${escHtml(inputStr).substring(0, 3000)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${escHtml(truncated)}</pre></details></div>`;
          }

          if (placeholder) {
            placeholder.outerHTML = html;
          } else {
            const el = document.createElement('div');
            el.className = 'chat-msg chat-msg-tool-result';
            el.innerHTML = this._compact
              ? `<div class="chat-compact-msg"><span class="chat-role chat-role-tool">${status === 'ok' ? '\u2713' : '\u2717'}</span><div class="chat-compact-content">${html}</div></div>`
              : html;
            this._messageList.appendChild(el); this._addWrapToggles(el);
          }
          continue;
        }

        // Generic tool result (no pending use match)
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-tool-result';
        const truncated = resultText.length > 2000 ? resultText.substring(0, 2000) + '...' : resultText;
        const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
        const icon = status === 'ok' ? '\u2713' : '\u2717';
        if (this._compact) {
          el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-tool">${icon}</span><div class="chat-compact-content"><details class="chat-tool-result-details chat-tool-${status}"><summary>${escHtml(firstLine)}</summary><pre>${escHtml(truncated)}</pre></details></div></div>`;
        } else {
          el.innerHTML = `<details class="chat-tool-result-details chat-tool-${status}"><summary><span class="chat-tool-label">Tool Result (${status})</span> ${escHtml(firstLine)}</summary><pre>${escHtml(truncated)}</pre></details>`;
        }
        this._messageList.appendChild(el); this._addWrapToggles(el);
      }
      return;
    }

    // Actual user message — render with markdown
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    let rawText = '';
    let textHtml = '';
    if (typeof content === 'string') {
      rawText = content;
      textHtml = `<div class="chat-text">${this._renderMarkdown(content)}</div>`;
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const b of content) {
        if (b.type === 'text') { rawText += b.text; parts.push(`<div class="chat-text">${this._renderMarkdown(b.text)}</div>`); }
        else if (b.type === 'image' && b.source?.data) parts.push(`<img class="chat-img" src="data:${b.source.media_type || 'image/png'};base64,${b.source.data}" alt="image">`);
        else if (b.type === 'image') parts.push('<span class="chat-img-placeholder">[Image]</span>');
      }
      textHtml = parts.join('');
    }

    // Auto-collapse long messages (>500 chars)
    const isLong = rawText.length > 500;
    let innerHtml;
    if (this._compact) {
      if (isLong) {
        const preview = rawText.substring(0, 120).split('\n')[0];
        innerHtml = `<div class="chat-compact-msg"><span class="chat-role chat-role-user">You</span><div class="chat-compact-content"><details class="chat-long-msg"><summary><span>${escHtml(preview)}...</span></summary>${textHtml}</details></div></div>`;
      } else {
        innerHtml = `<div class="chat-compact-msg"><span class="chat-role chat-role-user">You</span><div class="chat-compact-content">${textHtml}</div></div>`;
      }
    } else {
      if (isLong) {
        const preview = rawText.substring(0, 120).split('\n')[0];
        innerHtml = `<div class="chat-bubble chat-bubble-user"><details class="chat-long-msg"><summary><span>${escHtml(preview)}...</span></summary>${textHtml}</details></div>`;
      } else {
        innerHtml = `<div class="chat-bubble chat-bubble-user">${textHtml}</div>`;
      }
    }
    el.innerHTML = innerHtml;
    this._messageList.appendChild(el); this._addWrapToggles(el);
  }

  _appendAssistant(msg) {
    const content = msg.message?.content;
    if (!content) return;

    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';

    const parts = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          parts.push(`<div class="chat-text">${this._renderMarkdown(stripAnsi(block.text || ''))}</div>`);
        } else if (block.type === 'thinking') {
          parts.push(`<details class="chat-thinking"><summary>Thinking...</summary><pre>${escHtml(stripAnsi(block.text || ''))}</pre></details>`);
        } else if (block.type === 'tool_use') {
          // Defer all tool_use rendering until tool_result arrives
          if (block.id) {
            this._pendingToolUses.set(block.id, block);
            const fp = block.input?.file_path || '';
            const label = (block.name === 'Edit' || block.name === 'Write' || block.name === 'Read')
              ? `\u23F3 ${escHtml(block.name)} ${this._clickablePath(fp)}`
              : `\uD83D\uDD27 ${escHtml(block.name || 'tool')}`;
            parts.push(`<div class="chat-tool-pending" data-tool-id="${escHtml(block.id)}"><span class="chat-tool-label">${label}</span><span class="chat-spinner"></span></div>`);
          }
        } else if (block.type === 'image' && block.source?.data) {
          parts.push(`<img class="chat-img" src="data:${block.source.media_type || 'image/png'};base64,${block.source.data}" alt="image">`);
        }
      }
    } else if (typeof content === 'string') {
      parts.push(`<div class="chat-text">${this._renderMarkdown(content)}</div>`);
    }

    if (!parts.length) return; // skip empty assistant messages (tool-only with no text)

    if (this._compact) {
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-assistant">Claude</span><div class="chat-compact-content">${parts.join('')}</div></div>`;
    } else {
      el.innerHTML = `<div class="chat-bubble chat-bubble-assistant">${parts.join('')}</div>`;
    }
    this._messageList.appendChild(el); this._addWrapToggles(el);
  }

  _appendResult(msg) {
    if (msg.subtype === 'success' && msg.result) {
      // Don't duplicate — the result text is usually already shown in the last assistant message
      return;
    }
    if (msg.is_error) {
      this._appendSystem(`Error: ${msg.result || 'Unknown error'}`);
    }
  }

  _appendSystem(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system';
    el.innerHTML = `<div class="chat-system">${escHtml(text)}</div>`;
    this._messageList.appendChild(el); this._addWrapToggles(el);
  }

  // Add wrap toggle button to all <pre> blocks inside an element
  _addWrapToggles(el) {
    for (const pre of el.querySelectorAll('pre')) {
      if (pre.querySelector('.chat-wrap-toggle')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-pre-wrap';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'chat-wrap-toggle';
      btn.textContent = 'Wrap';
      btn.title = 'Toggle word wrap';
      btn.onclick = (e) => {
        e.stopPropagation();
        const on = pre.classList.toggle('chat-pre-wrapped');
        btn.textContent = on ? 'No Wrap' : 'Wrap';
      };
      wrapper.appendChild(btn);
    }
  }

  _renderMarkdown(text) {
    try {
      let html = marked.parse(text || '');
      return this._linkify(html);
    } catch {
      return escHtml(text || '');
    }
  }

  _renderEditDiff(block) {
    const filePath = block.input.file_path || '';
    const fileName = filePath.split('/').pop();
    const oldStr = block.input.old_string || '';
    const newStr = block.input.new_string || '';
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    // Simple line-by-line diff
    const diffLines = [];
    let oi = 0, ni = 0;
    while (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      diffLines.push({ type: 'ctx', text: oldLines[oi] }); oi++; ni++;
    }
    while (oi < oldLines.length) { diffLines.push({ type: 'del', text: oldLines[oi] }); oi++; }
    while (ni < newLines.length) { diffLines.push({ type: 'add', text: newLines[ni] }); ni++; }

    const addCount = diffLines.filter(l => l.type === 'add').length;
    const delCount = diffLines.filter(l => l.type === 'del').length;
    const summary = `\u2713 Added ${addCount} lines, removed ${delCount} lines`;

    let body = '';
    for (const line of diffLines) {
      const cls = line.type === 'add' ? 'chat-diff-add' : line.type === 'del' ? 'chat-diff-del' : 'chat-diff-ctx';
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      body += `<div class="${cls}"><span class="chat-diff-prefix">${prefix}</span>${escHtml(line.text)}</div>`;
    }

    return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Update ${this._clickablePath(filePath)}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
  }

  // Make a file path clickable (click=copy, ctrl+click=open)
  _clickablePath(fp) {
    return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>`;
  }

  // Strip trailing punctuation from matched paths/URLs
  _cleanPath(p) { return p.replace(/[`'".,;:!?)}\]]+$/, ''); }

  // Auto-detect URLs and file paths in rendered HTML, make them interactive
  // Click = copy, Ctrl+Click = open
  _linkify(html) {
    // Match URLs not already inside <a> tags
    html = html.replace(/(?<!href=["'])(https?:\/\/[^\s<>"')\]]+)/g, (raw) => {
      const url = this._cleanPath(raw);
      const after = raw.slice(url.length);
      return `<span class="chat-link" data-href="${escHtml(url)}" title="Click to copy, Ctrl+Click to open">${escHtml(url)}</span>${escHtml(after)}`;
    });
    // Match absolute file paths (not already inside tags)
    html = html.replace(/(?<![="'\w])(\/(?:home|tmp|usr|var|etc|opt|mnt|root|workspace|Users)[^\s<>"')\]]*)/g, (raw) => {
      const fp = this._cleanPath(raw);
      const after = raw.slice(fp.length);
      if (fp.length < 3) return raw; // too short
      return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>${escHtml(after)}`;
    });
    return html;
  }

  // Linkify plain text (for user messages that don't go through markdown)
  _linkifyText(text) {
    let html = escHtml(text);
    html = html.replace(/(https?:\/\/[^\s<>&]+)/g, (raw) => {
      const url = this._cleanPath(raw);
      const after = raw.slice(url.length);
      return `<span class="chat-link" data-href="${url}" title="Click to copy, Ctrl+Click to open">${url}</span>${after}`;
    });
    html = html.replace(/(?<![="'\w])(\/(?:home|tmp|usr|var|etc|opt|mnt|root|workspace|Users)[^\s<>&]*)/g, (raw) => {
      const fp = this._cleanPath(raw);
      const after = raw.slice(fp.length);
      if (fp.length < 3) return raw;
      return `<span class="chat-link chat-link-path" data-path="${fp}" title="Click to copy, Ctrl+Click to open">${fp}</span>${after}`;
    });
    return html;
  }

  _setupLinkHandler() {
    this._messageList.addEventListener('click', (e) => {
      const link = e.target.closest('.chat-link');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const url = link.dataset.href;
      const fp = link.dataset.path;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: open
        if (url) {
          window.open(url, '_blank');
        } else if (fp) {
          // Parse optional :line, :line:col, or :line-line suffix
          const lineMatch = fp.match(/^(.+?):(\d+)(?:[:\-]\d+)?$/);
          const cleanPath = lineMatch ? lineMatch[1] : fp;
          const lineNum = lineMatch ? parseInt(lineMatch[2], 10) : undefined;
          // Check if path is file, directory, or doesn't exist
          fetch(`/api/file/info?path=${encodeURIComponent(cleanPath)}`)
            .then(r => r.json())
            .then(info => {
              if (info.error) {
                this._flashLink(link, 'Not found');
              } else if (info.isDirectory) {
                this.app.openFileExplorer(cleanPath);
              } else {
                this.app.openFile(cleanPath, cleanPath.split('/').pop(), { line: lineNum });
              }
            })
            .catch(() => this._flashLink(link, 'Error'));
        }
      } else {
        // Click: copy to clipboard
        const text = url || fp;
        this._copyText(text, link);
      }
    });
  }

  _copyText(text, link) {
    // Try clipboard API, fall back to execCommand
    const flash = () => this._flashLink(link, 'Copied!');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => {
        this._fallbackCopy(text);
        flash();
      });
    } else {
      this._fallbackCopy(text);
      flash();
    }
  }

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  _flashLink(link, msg) {
    // Show tooltip near the link instead of replacing text
    const tip = document.createElement('span');
    tip.className = 'chat-link-tooltip';
    tip.textContent = msg;
    link.style.position = 'relative';
    link.appendChild(tip);
    setTimeout(() => tip.remove(), 1200);
  }

  _doSearch(query) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._executeSearch(query), 250);
  }

  async _executeSearch(query) {
    this._clearSearch();
    const q = query.trim().toLowerCase();
    if (!q) { this._searchStatus.textContent = ''; return; }

    this._searchStatus.textContent = 'Searching...';
    this._searchQuery = q;
    this._highlightQuery = q;
    this._applyHighlightLayer(); // highlight current view immediately

    // Server-side search
    const allSess = this.app.sidebar?._allSessions || [];
    const match = allSess.find(s => s.webuiId === this.sessionId);
    const claudeId = match?.sessionId;
    const cwd = match?.cwd || '';

    if (claudeId) {
      try {
        const res = await fetch(`/api/session-messages?claudeSessionId=${encodeURIComponent(claudeId)}&cwd=${encodeURIComponent(cwd)}&search=${encodeURIComponent(q)}`);
        const data = await res.json();
        this._serverSearchResults = data.matches || [];
      } catch {
        this._serverSearchResults = [];
      }
    } else {
      this._serverSearchResults = [];
    }

    if (!this._serverSearchResults.length) {
      this._searchStatus.textContent = 'No results';
      return;
    }

    this._searchResultIdx = 0;
    this._searchStatus.textContent = `1/${this._serverSearchResults.length}`;
    this._jumpToSearchResult(0);
  }

  async _jumpToSearchResult(idx) {
    const results = this._serverSearchResults;
    if (!results || idx < 0 || idx >= results.length) return;

    const msgIndex = results[idx].index;

    // Jump window if target is outside
    if (msgIndex < this._windowStart || msgIndex >= this._windowEnd) {
      await this.jumpToIndex(msgIndex);
    }

    // Expand collapsed content in target, then refresh highlight layer
    const relIdx = msgIndex - this._windowStart;
    const allMsgs = this._messageList.querySelectorAll('.chat-msg');
    if (relIdx >= 0 && relIdx < allMsgs.length) {
      const targetEl = allMsgs[relIdx];
      targetEl.style.contentVisibility = 'visible';
      for (const d of targetEl.querySelectorAll('details:not([open])')) d.open = true;
    }

    // Refresh highlight layer and scroll to first match in target
    this._applyHighlightLayer();
    const targetEl = allMsgs[relIdx];
    if (this._highlightRanges?.length > 0 && targetEl) {
      const matchIdx = this._highlightRanges.findIndex(r => targetEl.contains(r.startContainer));
      if (matchIdx >= 0) {
        this._setCurrentHighlight(matchIdx);
        // Scroll the range into view
        const rect = this._highlightRanges[matchIdx].getBoundingClientRect();
        const listRect = this._messageList.getBoundingClientRect();
        this._messageList.scrollTop += rect.top - listRect.top - listRect.height / 2;
        return;
      }
    }
    // Fallback: just scroll to the message
    if (targetEl) targetEl.scrollIntoView({ block: 'center' });
  }

  // ── Highlight Layer: non-destructive search highlighting ──

  // Apply highlight layer to current DOM content based on _highlightQuery
  _applyHighlightLayer() {
    if (!CSS.highlights) return; // fallback: no highlight API
    CSS.highlights.delete('chat-search');
    CSS.highlights.delete('chat-search-current');
    if (!this._highlightQuery) return;

    const q = this._highlightQuery;
    const ranges = [];
    const walker = document.createTreeWalker(this._messageList, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(q, idx)) !== -1) {
        const range = new Range();
        range.setStart(node, idx);
        range.setEnd(node, idx + q.length);
        ranges.push(range);
        idx += q.length;
      }
    }
    if (ranges.length > 0) {
      CSS.highlights.set('chat-search', new Highlight(...ranges));
    }
    this._highlightRanges = ranges;
  }

  // Highlight a specific range as "current" (for search navigation)
  _setCurrentHighlight(rangeIdx) {
    if (!CSS.highlights || !this._highlightRanges) return;
    CSS.highlights.delete('chat-search-current');
    if (rangeIdx >= 0 && rangeIdx < this._highlightRanges.length) {
      CSS.highlights.set('chat-search-current', new Highlight(this._highlightRanges[rangeIdx]));
    }
  }

  _clearHighlightLayer() {
    this._highlightQuery = '';
    this._highlightRanges = [];
    if (CSS.highlights) {
      CSS.highlights.delete('chat-search');
      CSS.highlights.delete('chat-search-current');
    }
  }

  _searchNav(dir) {
    const results = this._serverSearchResults;
    if (!results || !results.length) return;
    this._searchResultIdx = (this._searchResultIdx + dir + results.length) % results.length;
    this._searchStatus.textContent = `${this._searchResultIdx + 1}/${results.length}`;
    this._jumpToSearchResult(this._searchResultIdx);
  }

  _clearSearch() {
    this._clearHighlightLayer();
    this._serverSearchResults = [];
    this._searchResultIdx = -1;
    this._searchQuery = '';
    if (this._searchStatus) this._searchStatus.textContent = '';
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

  _showTyping(label = 'thinking...') {
    this._streamStatus.innerHTML = `<span class="chat-spinner"></span> ${escHtml(label)}`;
    this._streamStatus.classList.remove('hidden');
  }

  _hideTyping() {
    this._streamStatus.classList.add('hidden');
    this._streamStatus.innerHTML = '';
  }

  // Update typing indicator based on assistant message content
  _updateTyping(msg) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    const last = content[content.length - 1];
    if (!last) return;
    if (last.type === 'tool_use') {
      this._showTyping(`running ${last.name}...`);
    } else if (last.type === 'thinking') {
      this._showTyping('thinking...');
    } else {
      this._showTyping('responding...');
    }
  }

  applyStatus(status) {
    if (!status) return;
    if (status.model) this._statusModel = status.model.replace(/\[.*$/, '');
    if (status.contextWindow) this._statusContextWindow = status.contextWindow;
    if (status.lastUsage) {
      const u = status.lastUsage;
      this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this._statusLastCacheRead = u.cache_read_input_tokens || 0;
      this._statusTokensOut = u.output_tokens || 0;
    }
    if (status.total_cost_usd) this._statusCost = status.total_cost_usd;
    if (status.slashCommands) this._slashCommands = status.slashCommands.map(c => c.startsWith('/') ? c : '/' + c);
    this._updateStatusBar();
  }

  _updateStatusBar() {
    const fmtK = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'm' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    const parts = [];

    // Model badge
    if (this._statusModel) {
      parts.push(`<span class="chat-status-model">${escHtml(this._statusModel)}</span>`);
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
      for (const msg of msgs) this._onMessage(msg);
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
    this._textarea.focus();
    this._clearWaiting();
  }

  dispose() {
    this.ws.offGlobal(this._handler);
    this.ws.offStateChange(this._stateHandler);
  }
}

export { ChatView };
