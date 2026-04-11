import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';
import hljsDiff from 'highlight.js/lib/languages/diff';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsIni from 'highlight.js/lib/languages/ini';
import hljsRuby from 'highlight.js/lib/languages/ruby';
import hljsPhp from 'highlight.js/lib/languages/php';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsKotlin from 'highlight.js/lib/languages/kotlin';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsCsharp from 'highlight.js/lib/languages/csharp';
import hljsLua from 'highlight.js/lib/languages/lua';
import hljsR from 'highlight.js/lib/languages/r';
import hljsPerl from 'highlight.js/lib/languages/perl';
import hljsScss from 'highlight.js/lib/languages/scss';
import hljsGraphql from 'highlight.js/lib/languages/graphql';
import hljsNginx from 'highlight.js/lib/languages/nginx';
import hljsProtobuf from 'highlight.js/lib/languages/protobuf';

hljs.registerLanguage('javascript', hljsJavascript);
hljs.registerLanguage('typescript', hljsTypescript);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('yaml', hljsYaml);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('c', hljsC);
hljs.registerLanguage('cpp', hljsCpp);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('markdown', hljsMarkdown);
hljs.registerLanguage('diff', hljsDiff);
hljs.registerLanguage('dockerfile', hljsDockerfile);
hljs.registerLanguage('ini', hljsIni);
hljs.registerLanguage('ruby', hljsRuby);
hljs.registerLanguage('php', hljsPhp);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('kotlin', hljsKotlin);
hljs.registerLanguage('scala', hljsScala);
hljs.registerLanguage('csharp', hljsCsharp);
hljs.registerLanguage('lua', hljsLua);
hljs.registerLanguage('r', hljsR);
hljs.registerLanguage('perl', hljsPerl);
hljs.registerLanguage('scss', hljsScss);
hljs.registerLanguage('graphql', hljsGraphql);
hljs.registerLanguage('nginx', hljsNginx);
hljs.registerLanguage('protobuf', hljsProtobuf);
import { escHtml, saveDraft, loadDraft, clearDraft, getStateSync } from './utils.js';

// Map file extensions to highlight.js language identifiers
const EXT_TO_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'objectivec',
  php: 'php', pl: 'perl', pm: 'perl',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', r: 'r', lua: 'lua', scala: 'scala', groovy: 'groovy',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', tex: 'latex',
  dockerfile: 'dockerfile', makefile: 'makefile',
  graphql: 'graphql', proto: 'protobuf', thrift: 'thrift',
  diff: 'diff', patch: 'diff',
  nginx: 'nginx', conf: 'nginx',
};

function detectHljsLang(filePath) {
  if (!filePath) return '';
  const name = filePath.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT_TO_LANG[ext] || '';
}

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
  constructor(winInfo, wsManager, sessionId, app, { readOnly = false } = {}) {
    this.winInfo = winInfo;
    this.ws = wsManager;
    this.sessionId = sessionId;
    this.app = app;
    this._readOnly = readOnly;
    this._messages = []; // normalized message objects
    this._elements = new Map(); // msg.id → DOM element
    this._pinned = true; // auto-scroll to bottom
    this._renderedMsgIds = new Set(); // dedup by msgId
    this._highlightQuery = ''; // active search query for highlight layer

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
        if (scrollTop < 100 && this._windowStart > 0 && !this._loading && !this._readOnly) {
          this._extendTop();
        }
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

      this._setupLinkHandler();
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
      if (document.activeElement !== this._textarea) {
        this._textarea.value = value || '';
        this._textarea.style.height = 'auto';
        this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
      }
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
              // Open command input + output in editor
              let text = `[${task.toolName || 'Bash'}] ${task.description}\n\n`;
              if (task.command) text += `--- Command ---\n${task.command}\n\n`;
              if (task.resultText) text += `--- Output ---\n${task.resultText}\n`;
              this._openInTempEditor(text);
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

    // Set up click handler for links/paths + image zoom
    this._setupLinkHandler();
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
      const el = this._renderDetached(msg);
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
    this._elements.clear();
    this._windowStart = start;
    this._windowEnd = end;
    this._pinned = false;

    for (const msg of msgs) this._onCreateMessage(msg);

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
    this._windowStart = start;
    this._windowEnd = this._total;

    for (const msg of msgs) this._onCreateMessage(msg);
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

    const msgId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    if (hasAttachments) {
      const content = [];
      for (const a of this._attachments) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
      }
      if (text) content.push({ type: 'text', text });
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
      this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text: msg, msgId });
      // Show local preview immediately
      const previewContent = content.map(b => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'image' ? { type: 'image', mediaType: b.source?.media_type, data: b.source?.data } : null).filter(Boolean);
      this._onCreateMessage({ id: msgId, role: 'user', status: 'complete', content: previewContent, ts: Date.now() });
      this._attachments = [];
      this._renderAttachments();
    } else {
      this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text, msgId });
      this._onCreateMessage({ id: msgId, role: 'user', status: 'complete', content: [{ type: 'text', text }], ts: Date.now() });
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
    this._renderedMsgIds.add(msg.id);
    this._messages.push(msg);

    // Streaming indicator for live messages (server isStreaming is authority for initial state)
    if (!this._loadingHistory && (msg.status === 'streaming' || msg.status === 'pending')) {
      const label = msg.role === 'tool' ? `running ${msg.toolName || 'tool'}...` : msg.content?.[0]?.type === 'thinking' ? 'thinking...' : 'responding...';
      this._showTyping(label);
    }

    let el;
    switch (msg.role) {
      case 'user': el = this._renderUserMsg(msg); break;
      case 'assistant': el = this._renderAssistantMsg(msg); break;
      case 'tool': el = this._renderToolMsg(msg); break;
      case 'system': el = this._renderSystemMsg(msg); break;
      default: return;
    }

    if (!el) return;
    el.dataset.msgId = msg.id;
    this._elements.set(msg.id, el);
    this._messageList.appendChild(el);
    this._addWrapToggles(el);
    this._addOpenInEditorBtn(el);
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
    if (fields.status === 'complete' || fields.status === 'error') {
      // Tool call completed → re-render the element
      const oldEl = this._elements.get(id);
      if (oldEl) {
        let newEl;
        switch (msg.role) {
          case 'tool': newEl = this._renderToolMsg(msg); break;
          case 'assistant': newEl = this._renderAssistantMsg(msg); break;
          default: newEl = this._renderSystemMsg(msg); break;
        }
        if (newEl) {
          newEl.dataset.msgId = id;
          oldEl.replaceWith(newEl);
          this._elements.set(id, newEl);
          this._addWrapToggles(newEl);
          this._addOpenInEditorBtn(newEl);
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
          textDiv.innerHTML = this._renderMarkdown(stripAnsi(msg.content[0].text));
        }
      }
    }

    if (this._pinned) this._scrollToBottom();

    // Permission update
    if (fields.permission) {
      const el = this._elements.get(id);
      if (el) this._renderPermissionOverlay(el, msg);
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
      this._statusTokensOut = u.output_tokens || 0;
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

  // ── Normalized message renderers ──
  // These produce DOM elements from normalized messages (role-based dispatch)

  _renderUserMsg(msg) {
    const content = msg.content;
    if (!content?.length) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    el._rawMsg = msg;
    const parts = content.map(b => {
      if (b.type === 'text') return `<div class="chat-text">${this._renderMarkdown(b.text)}</div>`;
      if (b.type === 'image') return `<img class="chat-img" src="data:${b.mediaType || 'image/png'};base64,${b.data}" alt="image">`;
      return '';
    }).join('');

    const rawText = content.map(b => b.text || '').join('');
    const textHtml = rawText.length > 500
      ? `<details class="chat-long-msg"><summary>Message (${rawText.length} chars)</summary>${parts}</details>`
      : parts;

    if (this._compact) {
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-user">You</span><div class="chat-compact-content">${textHtml}</div></div>`;
    } else {
      el.innerHTML = `<div class="chat-bubble chat-bubble-user">${textHtml}</div>`;
    }
    return el;
  }

  _renderAssistantMsg(msg) {
    const block = msg.content?.[0];
    if (!block) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';
    el._rawMsg = msg;
    let html;
    if (block.type === 'thinking') {
      html = `<details class="chat-thinking"><summary>Thinking...</summary><pre>${escHtml(stripAnsi(block.text || ''))}</pre></details>`;
    } else if (block.type === 'text') {
      html = `<div class="chat-text">${this._renderMarkdown(stripAnsi(block.text || ''))}</div>`;
    } else {
      return null;
    }
    if (this._compact) {
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-assistant">Claude</span><div class="chat-compact-content">${html}</div></div>`;
    } else {
      el.innerHTML = `<div class="chat-bubble chat-bubble-assistant">${html}</div>`;
    }
    return el;
  }

  _renderToolMsg(msg) {
    const block = msg.content?.[0];
    if (!block) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant chat-msg-tool-result';
    el._rawMsg = msg;
    let html;

    if (block.type === 'tool_call' && msg.status === 'pending') {
      // Pending tool call — show input with spinner
      const isAgent = block.toolName === 'Agent';
      const icon = isAgent ? '\uD83E\uDD16' : '\uD83D\uDD27';
      const fp = block.input?.file_path || '';
      const isFileOp = ['Edit', 'Write', 'Read'].includes(block.toolName);
      if (isFileOp) {
        const label = `\u23F3 ${escHtml(block.toolName)} ${this._clickablePath(fp)}`;
        html = `<div class="chat-tool-pending"><span class="chat-tool-label">${label}</span><span class="chat-spinner"></span></div>`;
      } else {
        const desc = isAgent && block.input?.description ? `${icon} Agent: ${escHtml(block.input.description)}` : `${icon} ${escHtml(block.toolName)}`;
        const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
        html = `<div class="chat-tool-use"><span class="chat-tool-label">${desc}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this._linkifyText(inputStr)}</pre></details><div class="chat-tool-output-pending"><span class="chat-spinner"></span> running...</div></div>`;
      }
    } else if (block.type === 'tool_result') {
      // Completed tool call — show full result
      html = this._renderToolResult(block, msg);
    } else {
      html = `<pre>${escHtml(JSON.stringify(block, null, 2))}</pre>`;
    }

    if (this._compact) {
      const roleLabel = msg.toolStatus === 'error' ? '\u2717' : msg.status === 'pending' ? '\u23F3' : '\u2713';
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-tool">${roleLabel}</span><div class="chat-compact-content">${html}</div></div>`;
    } else {
      el.innerHTML = html;
    }

    // Permission overlay
    if (msg.permission) this._renderPermissionOverlay(el, msg);

    return el;
  }

  // Render a completed tool result (Edit diff, Write/Read code block, Agent, generic)
  _renderToolResult(block, msg) {
    const fp = block.input?.file_path || '';
    const resultText = stripAnsi(block.output || '');
    const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));

    if (block.status === 'error') {
      return `<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(block.toolName)} ${this._clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this._linkifyText(inputStr)}</pre></details><details class="chat-diff" open><summary class="chat-diff-summary chat-tool-error-label">\u2717 Error</summary><pre class="chat-tool-error-text">${this._linkifyText(resultText)}</pre></details></div>`;
    }
    if (block.toolName === 'Edit' && block.input?.old_string != null) {
      return this._renderEditDiff({ input: block.input });
    }
    if (block.toolName === 'Write') {
      const content = block.input?.content || '';
      const lineCount = content.split('\n').length;
      const byteCount = new Blob([content]).size;
      const sizeStr = byteCount > 1024 ? (byteCount / 1024).toFixed(1) + ' KB' : byteCount + ' B';
      const codeBlock = this._renderCodeBlock(content, fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Write ${this._clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines, ${sizeStr}</summary>${codeBlock}</details></div>`;
    }
    if (block.toolName === 'Read') {
      const lineCount = resultText.split('\n').length;
      const codeBlock = this._renderCodeBlock(resultText, fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4D6} Read ${this._clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines</summary>${codeBlock}</details></div>`;
    }
    if (block.toolName === 'Agent') {
      const desc = block.input?.description || '';
      const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
      // View Log button: use agentId from taskInfo or parse from result text
      const agentId = msg?.taskInfo?.id || (resultText.match(/agentId:\s*([a-z0-9]+)/)?.[1]) || '';
      const viewBtn = agentId
        ? ` <button class="chat-agent-view-btn" data-agent-id="${escHtml(agentId)}" data-desc="${escHtml(desc)}">View Log</button>`
        : (block.toolCallId ? ` <button class="chat-agent-view-btn" data-parent-tool-id="${escHtml(block.toolCallId)}" data-desc="${escHtml(desc)}">View Log</button>` : '');
      return `<div class="chat-tool-use"><span class="chat-tool-label">\uD83E\uDD16 Agent: ${escHtml(desc)}${viewBtn}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this._linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${this._linkifyText(resultText)}</pre></details></div>`;
    }
    // Generic tool
    const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
    return `<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(block.toolName)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this._linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${this._linkifyText(resultText)}</pre></details></div>`;
  }

  _renderSystemMsg(msg) {
    const text = msg.content?.[0]?.text || '';
    // system.init — extract metadata, don't render
    if (msg.content?.[0]?.initData) {
      const d = msg.content[0].initData;
      if (d.model) this._statusModel = d.model.replace(/\[.*$/, '');
      if (d.permissionMode) this._statusPermMode = d.permissionMode;
      if (d.slashCommands) this._slashCommands = d.slashCommands.map(c => c.startsWith('/') ? c : '/' + c);
      this._updateStatusBar();
      return null;
    }
    // Error / interrupted
    if (msg.status === 'error' || msg.status === 'interrupted') {
      return this._appendSystem(text);
    }
    return null;
  }

  _renderPermissionOverlay(el, msg) {
    if (!msg.permission) return;
    // Remove existing permission overlay
    const existing = el.querySelector('.chat-permission-inline');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.className = 'chat-permission-inline';
    section.dataset.requestId = msg.permission.requestId;

    if (msg.permission.resolved) {
      const icon = msg.permission.resolved === 'denied' ? '\u2717' : '\u2713';
      const label = msg.permission.resolved === 'denied' ? 'Denied' : 'Allowed';
      const cls = msg.permission.resolved === 'denied' ? 'chat-permission-denied' : 'chat-permission-allowed';
      section.innerHTML = `<details class="chat-diff"><summary class="chat-diff-summary"><span class="chat-permission-resolved ${cls}">${icon} ${label}</span></summary></details>`;
    } else {
      section.innerHTML = `<div class="chat-permission-prompt"><span class="chat-permission-label">\uD83D\uDD12 Permission: ${escHtml(msg.permission.toolName)}</span><div class="chat-permission-actions"><button class="chat-perm-btn chat-perm-allow">Allow</button>${msg.permission.suggestions?.length ? '<button class="chat-perm-btn chat-perm-always">Always Allow</button>' : ''}<button class="chat-perm-btn chat-perm-deny">Deny</button></div></div>`;
      section.querySelector('.chat-perm-allow')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: true, toolInput: msg.permission.input });
        msg.permission.resolved = 'allowed';
        this._renderPermissionOverlay(el, msg);
        this._hideTyping();
      });
      section.querySelector('.chat-perm-always')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: true, toolInput: msg.permission.input, permissionUpdates: msg.permission.suggestions });
        msg.permission.resolved = 'allowed';
        this._renderPermissionOverlay(el, msg);
        this._hideTyping();
      });
      section.querySelector('.chat-perm-deny')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: false });
        msg.permission.resolved = 'denied';
        this._renderPermissionOverlay(el, msg);
      });
    }

    const toolUse = el.querySelector('.chat-tool-use') || el.querySelector('.chat-tool-pending');
    if (toolUse) {
      const outputPending = toolUse.querySelector('.chat-tool-output-pending');
      if (outputPending) outputPending.before(section);
      else toolUse.appendChild(section);
    }
  }




  _appendSystem(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system';
    el.innerHTML = `<div class="chat-system">${escHtml(text)}</div>`;
    this._messageList.appendChild(el); this._addWrapToggles(el); this._addOpenInEditorBtn(el);
  }

  // Add wrap toggle button to all <pre> blocks inside an element
  // Add open-in-editor button to a tool card, using raw data from closure
  _addToolOpenBtn(toolEl, resultText, pendingUse) {
    const btn = document.createElement('button');
    btn.className = 'chat-open-editor-btn chat-tool-open-btn';
    btn.textContent = '\uD83D\uDCCB';
    btn.title = 'Open output in editor';
    btn.onclick = (e) => {
      e.stopPropagation();
      let text = '';
      if (pendingUse) {
        const inputStr = typeof pendingUse.input === 'string' ? pendingUse.input : JSON.stringify(pendingUse.input, null, 2);
        text = `[Tool: ${pendingUse.name}]\n\n--- Input ---\n${inputStr}\n\n--- Output ---\n${resultText}`;
      } else {
        text = resultText;
      }
      if (!text.trim()) return;
      this._openInTempEditor(text);
    };
    toolEl.style.position = 'relative';
    toolEl.appendChild(btn);
  }

  _openInTempEditor(text) {
    const tmpName = `chat-block-${Date.now()}.txt`;
    const tmpPath = `/tmp/claude-webui/${tmpName}`;
    fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/tmp/claude-webui' }) }).catch(() => {});
    fetch('/api/file/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tmpPath, content: text }) })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(() => {
        this.app.openEditor(tmpPath, tmpName, {
          _tempFile: true,
          _onCloseDelete: () => fetch(`/api/file?path=${encodeURIComponent(tmpPath)}`, { method: 'DELETE' }).catch(() => {}),
        });
      })
      .catch(() => {});
  }

  _addOpenInEditorBtn(el) {
    if (!el._rawMsg) return;
    // Skip for assistant messages that have tool_use — tool cards have their own buttons
    const msg = el._rawMsg;
    if (msg.type === 'assistant') {
      const c = msg.message?.content;
      if (Array.isArray(c) && c.some(b => b.type === 'tool_use') && !c.some(b => b.type === 'text' && b.text?.trim())) return;
    }
    const btn = document.createElement('button');
    btn.className = 'chat-open-editor-btn';
    btn.textContent = '\uD83D\uDCCB';
    btn.title = 'Open in editor';
    btn.onclick = (e) => {
      e.stopPropagation();
      const text = this._extractMsgText(msg);
      if (!text.trim()) return;
      this._openInTempEditor(text);
    };
    el.style.position = 'relative';
    el.appendChild(btn);
  }

  _extractMsgText(msg) {
    const c = msg.message?.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return JSON.stringify(msg, null, 2);
    return c.map(b => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'thinking') return b.text || '';
      if (b.type === 'tool_use') return `[Tool: ${b.name}]\n${JSON.stringify(b.input, null, 2)}`;
      if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2);
      return '';
    }).filter(Boolean).join('\n\n');
  }

  _addWrapToggles(el) {
    const LANGS = ['plain', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile',
      'go', 'graphql', 'ini', 'java', 'javascript', 'json', 'kotlin', 'lua', 'markdown',
      'nginx', 'perl', 'php', 'protobuf', 'python', 'r', 'ruby', 'rust', 'scala', 'scss',
      'sql', 'swift', 'typescript', 'xml', 'yaml'];

    for (const block of el.querySelectorAll('pre, .chat-diff-body, .chat-code-block')) {
      if (block.parentNode?.classList?.contains('chat-pre-wrap')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-pre-wrap';
      block.parentNode.insertBefore(wrapper, block);
      wrapper.appendChild(block);

      const toolbar = document.createElement('div');
      toolbar.className = 'chat-code-toolbar';

      // Deferred highlight: large code blocks skip hljs on render, highlight on first expand
      if (block.classList.contains('chat-code-block') && block.dataset.highlightDeferred) {
        const details = block.closest('details');
        if (details) {
          const highlightOnce = () => {
            if (!block.dataset.highlightDeferred) return;
            delete block.dataset.highlightDeferred;
            this._rehighlightCodeBlock(block, block.dataset.lang);
            details.removeEventListener('toggle', highlightOnce);
          };
          details.addEventListener('toggle', highlightOnce);
        }
      }

      // Language picker for code blocks — searchable dropdown
      if (block.classList.contains('chat-code-block')) {
        const langPicker = document.createElement('div');
        langPicker.className = 'chat-lang-picker';
        const langBtn = document.createElement('button');
        langBtn.className = 'chat-lang-btn';
        langBtn.textContent = block.dataset.lang || 'plain';
        langBtn.title = 'Change syntax highlighting';
        langBtn.onclick = (e) => {
          e.stopPropagation();
          if (langPicker.querySelector('.chat-lang-dropdown')) { langPicker.querySelector('.chat-lang-dropdown').remove(); return; }
          const dd = document.createElement('div');
          dd.className = 'chat-lang-dropdown';
          const input = document.createElement('input');
          input.className = 'chat-lang-search';
          input.placeholder = 'Filter...';
          dd.appendChild(input);
          const list = document.createElement('div');
          list.className = 'chat-lang-list';
          dd.appendChild(list);
          const render = (filter) => {
            list.innerHTML = '';
            const f = (filter || '').toLowerCase();
            for (const l of LANGS) {
              if (f && !l.includes(f)) continue;
              const item = document.createElement('div');
              item.className = 'chat-lang-item' + (l === (block.dataset.lang || 'plain') ? ' active' : '');
              item.textContent = l;
              item.onclick = (ev) => {
                ev.stopPropagation();
                this._rehighlightCodeBlock(block, l);
                langBtn.textContent = l;
                dd.remove();
                closeFn();
              };
              list.appendChild(item);
            }
          };
          render('');
          input.oninput = () => render(input.value);
          input.onkeydown = (ev) => { if (ev.key === 'Escape') { dd.remove(); closeFn(); } };
          langPicker.appendChild(dd);
          setTimeout(() => input.focus(), 0);
          const closeFn = () => document.removeEventListener('mousedown', closeHandler);
          const closeHandler = (ev) => { if (!dd.contains(ev.target) && ev.target !== langBtn) { dd.remove(); closeFn(); } };
          setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
        };
        langPicker.appendChild(langBtn);
        toolbar.appendChild(langPicker);
      }

      const btn = document.createElement('button');
      btn.className = 'chat-wrap-toggle';
      btn.textContent = 'Wrap';
      btn.title = 'Toggle word wrap';
      btn.onclick = (e) => {
        e.stopPropagation();
        const on = block.classList.toggle('chat-pre-wrapped');
        btn.textContent = on ? 'No Wrap' : 'Wrap';
      };
      toolbar.appendChild(btn);
      wrapper.appendChild(toolbar);
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
    const oldStr = block.input.old_string || '';
    const newStr = block.input.new_string || '';
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    // Simple line-by-line diff with prefix and suffix context matching
    const diffLines = [];
    let oi = 0, ni = 0;
    // Match prefix context
    while (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      diffLines.push({ type: 'ctx', text: oldLines[oi], ol: oi + 1, nl: ni + 1 }); oi++; ni++;
    }
    // Match suffix context from the end
    let suffixCtx = [];
    let oe = oldLines.length - 1, ne = newLines.length - 1;
    while (oe >= oi && ne >= ni && oldLines[oe] === newLines[ne]) {
      suffixCtx.unshift({ type: 'ctx', text: oldLines[oe] }); oe--; ne--;
    }
    // Remaining old = del, remaining new = add
    while (oi <= oe) { diffLines.push({ type: 'del', text: oldLines[oi], ol: oi + 1 }); oi++; }
    while (ni <= ne) { diffLines.push({ type: 'add', text: newLines[ni], nl: ni + 1 }); ni++; }
    // Append suffix context with correct line numbers
    for (const s of suffixCtx) { s.ol = oi + 1; s.nl = ni + 1; diffLines.push(s); oi++; ni++; }

    const addCount = diffLines.filter(l => l.type === 'add').length;
    const delCount = diffLines.filter(l => l.type === 'del').length;
    const summary = `\u2713 Added ${addCount} lines, removed ${delCount} lines`;

    let body = '';
    for (const line of diffLines) {
      const cls = line.type === 'add' ? 'chat-diff-add' : line.type === 'del' ? 'chat-diff-del' : 'chat-diff-ctx';
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      body += `<div class="${cls}"><span class="chat-diff-prefix">${prefix}</span><span class="chat-diff-text">${escHtml(line.text)}</span></div>`;
    }

    return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Update ${this._clickablePath(filePath)}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
  }

  // Render code with line numbers + syntax highlighting (for Read/Write tool output)
  // Returns HTML string for a .chat-code-block element
  _renderCodeBlock(code, filePath) {
    const lang = detectHljsLang(filePath);
    // Skip highlight for large files (>10KB) — defer to expand time
    const skipHighlight = code.length > 10000;
    let highlighted;
    try {
      highlighted = (!skipHighlight && lang) ? hljs.highlight(code, { language: lang }).value : escHtml(code);
    } catch {
      highlighted = escHtml(code);
    }
    const lines = highlighted.split('\n');
    const gutterW = String(lines.length).length;
    let body = '';
    for (let i = 0; i < lines.length; i++) {
      body += `<div class="chat-code-line"><span class="chat-code-ln" style="width:${gutterW + 1}ch">${i + 1}</span><span class="chat-code-text">${lines[i] || ' '}</span></div>`;
    }
    const langLabel = lang || 'plain';
    const deferred = skipHighlight ? ' data-highlight-deferred="1"' : '';
    return `<div class="chat-code-block" data-lang="${escHtml(langLabel)}" data-filepath="${escHtml(filePath)}"${deferred}>${body}</div>`;
  }

  // Apply syntax highlighting to an already-rendered .chat-code-block
  _rehighlightCodeBlock(blockEl, langId) {
    const code = Array.from(blockEl.querySelectorAll('.chat-code-text')).map(s => s.textContent).join('\n');
    let highlighted;
    try {
      highlighted = langId && langId !== 'plain' ? hljs.highlight(code, { language: langId }).value : escHtml(code);
    } catch {
      highlighted = escHtml(code);
    }
    const lines = highlighted.split('\n');
    const lineEls = blockEl.querySelectorAll('.chat-code-text');
    for (let i = 0; i < lineEls.length && i < lines.length; i++) {
      lineEls[i].innerHTML = lines[i] || ' ';
    }
    blockEl.dataset.lang = langId || 'plain';
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
    // Split HTML into tags and text segments, only linkify text outside <a> tags
    let inAnchor = 0;
    return html.replace(/(<a[\s>][\s\S]*?<\/a>)|(<code[\s>][\s\S]*?<\/code>)|(<[^>]*>)|([^<]+)/gi, (match, anchor, code, tag, text) => {
      if (anchor) return match; // preserve <a>...</a> untouched
      if (code) {
        // Linkify paths/URLs inside <code> blocks while preserving the <code> wrapper
        // Inner content is already HTML-escaped by marked, so use same logic as bare text segments below
        return code.replace(/^(<code[^>]*>)([\s\S]*?)(<\/code>)$/i, (_, open, inner, close) => {
          let r = inner.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (raw) => {
            const url = this._cleanPath(raw);
            const after = raw.slice(url.length);
            return `<span class="chat-link" data-href="${escHtml(url)}" title="Click to copy, Ctrl+Click to open">${escHtml(url)}</span>${escHtml(after)}`;
          });
          r = r.replace(/(<[^>]*>)|([^<]+)/g, (m2, t2, txt) => {
            if (t2 || !txt) return m2;
            return txt.replace(/(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g, (raw) => {
              const fp = this._cleanPath(raw);
              const after = raw.slice(fp.length);
              if (fp.length < 4) return raw;
              return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>${escHtml(after)}`;
            });
          });
          return open + r + close;
        });
      }
      if (tag) return tag;
      if (!text) return match;
      // Linkify URLs
      let result = text.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (raw) => {
        const url = this._cleanPath(raw);
        const after = raw.slice(url.length);
        return `<span class="chat-link" data-href="${escHtml(url)}" title="Click to copy, Ctrl+Click to open">${escHtml(url)}</span>${escHtml(after)}`;
      });
      // Linkify file paths
      result = result.replace(/(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g, (raw) => {
        const fp = this._cleanPath(raw);
        const after = raw.slice(fp.length);
        if (fp.length < 4) return raw;
        return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>${escHtml(after)}`;
      });
      return result;
    });
  }

  // Linkify plain text (for tool output, user messages that don't go through markdown)
  _linkifyText(text) {
    let html = escHtml(text);
    // First pass: linkify URLs
    html = html.replace(/(https?:\/\/[^\s<>&]+)/g, (raw) => {
      const url = this._cleanPath(raw);
      const after = raw.slice(url.length);
      return `<span class="chat-link" data-href="${url}" title="Click to copy, Ctrl+Click to open">${url}</span>${after}`;
    });
    // Second pass: linkify file paths — split by tags to avoid matching inside generated <span> attributes
    html = html.replace(/(<[^>]*>)|([^<]+)/g, (match, tag, text2) => {
      if (tag) return tag;
      if (!text2) return match;
      return text2.replace(/(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g, (raw) => {
        const fp = this._cleanPath(raw);
        const after = raw.slice(fp.length);
        if (fp.length < 4) return raw;
        return `<span class="chat-link chat-link-path" data-path="${fp}" title="Click to copy, Ctrl+Click to open">${fp}</span>${after}`;
      });
    });
    return html;
  }

  _setupLinkHandler() {
    this._messageList.addEventListener('click', (e) => {
      // Handle both our .chat-link spans and markdown-generated <a> tags
      const link = e.target.closest('.chat-link') || e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const url = link.dataset.href || link.getAttribute('href');
      const fp = link.dataset.path;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: open
        if (fp) {
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
        } else if (url) {
          window.open(url, '_blank');
        }
      } else {
        // Click: copy to clipboard
        const text = fp || url;
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

    // Server-side search — find claudeSessionId for this webui session
    let { claudeId, cwd } = this._getSessionIds();
    // Fallback: check active sessions API directly
    if (!claudeId) {
      try {
        const r = await fetch('/api/active');
        const d = await r.json();
        const sessions = d.sessions || d;
        const s = Array.isArray(sessions) ? sessions.find(s => s.id === this.sessionId) : null;
        if (s) { claudeId = s.claudeSessionId; cwd = s.cwd || ''; }
      } catch {}
    }

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
    const view = new ChatView(winInfo, this.ws, virtualId, this.app, { readOnly: true });

    // Attach to virtual session — server returns history + sets up live forwarding
    const { claudeId, cwd } = this._getSessionIds();
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
    if (status.permissionMode) this._statusPermMode = status.permissionMode;
    if (status.permissionModes) this._permissionModes = status.permissionModes;
    if (status.subagentMetas) this._subagentMetas = status.subagentMetas;
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
      for (const msg of msgs) this._onCreateMessage(msg);
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

  dispose() {
    this.ws.offGlobal(this._handler);
    this.ws.offStateChange(this._stateHandler);
    if (this._draftSyncHandler) {
      const sync = getStateSync();
      if (sync) sync.off('drafts', 'chat:' + this.sessionId, this._draftSyncHandler);
    }
  }
}

export { ChatView };
