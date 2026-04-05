import { marked } from 'marked';
import { escHtml } from './utils.js';

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

    // Build DOM
    const container = document.createElement('div');
    container.className = 'chat-view';
    winInfo.content.appendChild(container);

    // Message list
    this._messageList = document.createElement('div');
    this._messageList.className = 'chat-message-list';
    container.appendChild(this._messageList);

    // Scroll detection for pin-to-bottom
    this._messageList.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this._messageList;
      const atBottom = scrollHeight - scrollTop - clientHeight < 30;
      if (atBottom && !this._pinned) this._pinned = true;
      else if (!atBottom) this._pinned = false;
    });

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';
    this._textarea = document.createElement('textarea');
    this._textarea.className = 'chat-input';
    this._textarea.placeholder = 'Type a message...';
    this._textarea.rows = 1;

    // Auto-grow textarea (skip in expanded mode — user controls height)
    this._textarea.addEventListener('input', () => {
      if (this._expanded) return;
      this._textarea.style.height = 'auto';
      this._textarea.style.height = Math.min(this._textarea.scrollHeight, 200) + 'px';
    });

    // Send: Enter in normal mode, Ctrl+Enter in expanded mode
    this._textarea.addEventListener('keydown', (e) => {
      if (this._expanded) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._send(); }
      } else {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
      }
    });

    // Button row: expand toggle + send
    const btnRow = document.createElement('div');
    btnRow.className = 'chat-btn-row';

    const expandBtn = document.createElement('button');
    expandBtn.className = 'chat-expand-btn';
    expandBtn.textContent = '\u2922'; // ⤢ expand icon
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
        this._shortcutHint.textContent = 'Ctrl+Enter to send';
      } else {
        this._textarea.style.height = 'auto';
        this._textarea.style.minHeight = '36px';
        this._textarea.classList.remove('chat-input-expanded');
        expandBtn.textContent = '\u2922';
        expandBtn.title = 'Expand editor';
        this._shortcutHint.textContent = 'Enter to send';
      }
      this._textarea.focus();
    };

    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = '▶';
    sendBtn.title = 'Send';
    sendBtn.onclick = () => this._send();

    // Shortcut hint
    this._shortcutHint = document.createElement('div');
    this._shortcutHint.className = 'chat-shortcut-hint';
    this._shortcutHint.textContent = 'Enter to send';

    btnRow.append(expandBtn, sendBtn, this._shortcutHint);
    inputArea.append(this._textarea, btnRow);

    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'chat-search-bar hidden';
    const searchInput = document.createElement('input');
    searchInput.className = 'chat-search-input';
    searchInput.placeholder = 'Search messages...';
    searchInput.type = 'text';
    const searchClose = document.createElement('button');
    searchClose.className = 'chat-search-close';
    searchClose.textContent = '\u2715';
    searchClose.onclick = () => { searchBar.classList.add('hidden'); searchInput.value = ''; this._clearSearch(); };
    searchBar.append(searchInput, searchClose);
    container.insertBefore(searchBar, this._messageList);

    searchInput.addEventListener('input', () => this._doSearch(searchInput.value));

    // Ctrl+F to search
    container.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        searchBar.classList.remove('hidden');
        searchInput.focus();
      }
    });
    // Make container focusable for Ctrl+F
    container.tabIndex = -1;

    container.appendChild(inputArea);

    // Set up click handler for links/paths
    this._setupLinkHandler();

    // Listen for chat messages from server
    this._handler = (msg) => {
      if (msg.type === 'chat-message' && msg.sessionId === sessionId) {
        this._onMessage(msg.message);
      } else if (msg.type === 'exited' && msg.sessionId === sessionId) {
        this._appendSystem('Session ended.');
      }
    };
    this.ws.onGlobal(this._handler);
  }

  // Load history from attach response
  loadHistory(messages) {
    for (const msg of messages) {
      this._onMessage(msg, true);
    }
    this._scrollToBottom();
  }

  _send() {
    const text = this._textarea.value.trim();
    if (!text) return;
    this._textarea.value = '';
    this._textarea.style.height = 'auto';
    this._textarea.style.minHeight = '36px';
    if (this._expanded) {
      this._expanded = false;
      this._textarea.classList.remove('chat-input-expanded');
      const eb = this._textarea.closest('.chat-input-area')?.querySelector('.chat-expand-btn');
      if (eb) { eb.textContent = '\u2922'; eb.title = 'Expand editor'; }
    }
    this.ws.send({ type: 'chat-input', sessionId: this.sessionId, text });
  }

  _onMessage(msg, isHistory = false) {
    this._messages.push(msg);

    switch (msg.type) {
      case 'user':
        this._appendUser(msg);
        break;
      case 'assistant':
        this._appendAssistant(msg);
        break;
      case 'system':
        if (msg.subtype === 'init') {
          this._appendSystem(`Session started (${msg.model || 'unknown model'})`);
        }
        // Skip hook events and other system noise
        break;
      case 'result':
        this._appendResult(msg);
        break;
      case 'rate_limit_event':
        // Skip silently
        break;
      default:
        // Unknown type — skip
        break;
    }

    if (!isHistory && this._pinned) {
      this._scrollToBottom();
    }
  }

  _appendUser(msg) {
    const content = msg.message?.content;
    if (!content) return;

    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';

    if (typeof content === 'string') {
      el.innerHTML = `<div class="chat-bubble chat-bubble-user">${this._linkifyText(content)}</div>`;
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (block.type === 'text') {
          parts.push(this._linkifyText(block.text));
        } else if (block.type === 'tool_result') {
          const status = block.is_error ? 'error' : 'ok';
          const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
          parts.push(`<div class="chat-tool-result chat-tool-${status}"><span class="chat-tool-label">Tool Result (${status})</span><pre>${escHtml(resultText).substring(0, 2000)}</pre></div>`);
        }
      }
      el.innerHTML = `<div class="chat-bubble chat-bubble-user">${parts.join('')}</div>`;
    }
    this._messageList.appendChild(el);
  }

  _appendAssistant(msg) {
    const content = msg.message?.content;
    if (!content) return;

    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';

    if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (block.type === 'text') {
          parts.push(`<div class="chat-text">${this._renderMarkdown(block.text)}</div>`);
        } else if (block.type === 'thinking') {
          parts.push(`<details class="chat-thinking"><summary>Thinking...</summary><pre>${escHtml(block.text || '')}</pre></details>`);
        } else if (block.type === 'tool_use') {
          const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
          parts.push(`<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(block.name || 'tool')}</span><details><summary>Input</summary><pre>${escHtml(inputStr).substring(0, 3000)}</pre></details></div>`);
        }
      }
      el.innerHTML = `<div class="chat-bubble chat-bubble-assistant">${parts.join('')}</div>`;
    } else if (typeof content === 'string') {
      el.innerHTML = `<div class="chat-bubble chat-bubble-assistant"><div class="chat-text">${this._renderMarkdown(content)}</div></div>`;
    }
    this._messageList.appendChild(el);
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
    this._messageList.appendChild(el);
  }

  _renderMarkdown(text) {
    try {
      let html = marked.parse(text || '', { breaks: true });
      return this._linkify(html);
    } catch {
      return escHtml(text || '');
    }
  }

  // Auto-detect URLs and file paths in rendered HTML, make them interactive
  // Click = copy, Ctrl+Click = open
  _linkify(html) {
    // Match URLs not already inside <a> tags
    html = html.replace(/(?<!href=["'])(https?:\/\/[^\s<>"')\]]+)/g, (url) => {
      return `<span class="chat-link" data-href="${escHtml(url)}" title="Click to copy, Ctrl+Click to open">${escHtml(url)}</span>`;
    });
    // Match absolute file paths (not already inside tags)
    html = html.replace(/(?<![="'\w])(\/(?:home|tmp|usr|var|etc|opt|mnt|root|workspace)[^\s<>"')\]]*)/g, (fp) => {
      return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>`;
    });
    return html;
  }

  // Linkify plain text (for user messages that don't go through markdown)
  _linkifyText(text) {
    let html = escHtml(text);
    html = html.replace(/(https?:\/\/[^\s<>&]+)/g, (url) => {
      return `<span class="chat-link" data-href="${url}" title="Click to copy, Ctrl+Click to open">${url}</span>`;
    });
    html = html.replace(/(?<![="'\w])(\/(?:home|tmp|usr|var|etc|opt|mnt|root|workspace)[^\s<>&]*)/g, (fp) => {
      return `<span class="chat-link chat-link-path" data-path="${fp}" title="Click to copy, Ctrl+Click to open">${fp}</span>`;
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
        if (url) window.open(url, '_blank');
        else if (fp) this.app.openFile(fp, fp.split('/').pop());
      } else {
        // Click: copy
        const text = url || fp;
        navigator.clipboard.writeText(text).then(() => {
          const orig = link.textContent;
          link.textContent = 'Copied!';
          setTimeout(() => { link.textContent = orig; }, 800);
        }).catch(() => {});
      }
    });
  }

  _doSearch(query) {
    const q = query.trim().toLowerCase();
    const msgs = this._messageList.querySelectorAll('.chat-msg');
    if (!q) { msgs.forEach(m => m.classList.remove('chat-search-hidden')); return; }
    msgs.forEach(m => {
      const text = m.textContent.toLowerCase();
      m.classList.toggle('chat-search-hidden', !text.includes(q));
    });
  }

  _clearSearch() {
    this._messageList.querySelectorAll('.chat-msg').forEach(m => m.classList.remove('chat-search-hidden'));
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      this._messageList.scrollTop = this._messageList.scrollHeight;
    });
  }

  focus() {
    this._textarea.focus();
  }

  dispose() {
    this.ws.offGlobal(this._handler);
  }
}

export { ChatView };
