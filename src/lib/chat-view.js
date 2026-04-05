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

    // Send: Enter in normal mode, Ctrl+Enter in expanded mode
    this._textarea.addEventListener('keydown', (e) => {
      if (this._expanded) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._send(); }
      } else {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
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
        this._textarea.style.height = 'auto';
        this._textarea.style.minHeight = '36px';
        this._textarea.classList.remove('chat-input-expanded');
        expandBtn.textContent = '\u2922';
        expandBtn.title = 'Expand editor';
        this._shortcutHint.textContent = '\u23CE';
      }
      this._textarea.focus();
    };

    inputWrap.append(this._textarea, expandBtn);

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

    inputArea.append(this._attachArea, inputWrap, sendCol);

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

    // Connection state: freeze on disconnect, unfreeze on reconnect
    this._disconnected = false;
    this._stateHandler = (connected) => {
      this._disconnected = !connected;
      container.classList.toggle('chat-disconnected', !connected);
      this._textarea.disabled = !connected;
      if (!connected) {
        this._hideTyping();
        this._appendSystem('Disconnected from server');
      } else {
        this._appendSystem('Reconnected');
      }
    };
    this.ws.onStateChange(this._stateHandler);
  }

  // Load history from attach response
  loadHistory(messages) {
    for (const msg of messages) {
      this._onMessage(msg, true);
    }
    this._scrollToBottom();
  }

  _send() {
    if (this._disconnected) return;
    const text = this._textarea.value.trim();
    const hasAttachments = this._attachments.length > 0;
    if (!text && !hasAttachments) return;

    this._textarea.value = '';
    this._textarea.style.height = 'auto';
    this._textarea.style.minHeight = '36px';
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
    this._pendingTyping = true;
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
        if (!isHistory && this._pendingTyping) {
          this._pendingTyping = false;
          this._showTyping();
        }
        break;
      case 'assistant':
        if (!isHistory) this._hideTyping();
        this._appendAssistant(msg);
        break;
      case 'system':
        // Skip all system messages in chat mode (hooks, init, etc.)
        break;
      case 'result':
        if (!isHistory) this._hideTyping();
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

    // Distinguish actual user messages (string content) from tool results (array with tool_result blocks)
    const isToolResult = Array.isArray(content) && content.every(b => b.type === 'tool_result');

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
            html = `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Write ${escHtml(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines, ${sizeStr}</summary><pre>${escHtml(preview)}${content.length > 500 ? '\n...' : ''}</pre></details></div>`;
          } else if (status === 'ok' && pendingUse.name === 'Read') {
            const lineCount = resultText.split('\n').length;
            const preview = resultText.substring(0, 500);
            html = `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4D6} Read ${escHtml(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines</summary><pre>${escHtml(preview)}${resultText.length > 500 ? '\n...' : ''}</pre></details></div>`;
          } else {
            // Failed or unhandled tool — show error with expandable original input
            const firstLine = resultText.split('\n')[0].substring(0, 150) || '(empty)';
            const inputStr = stripAnsi(typeof pendingUse.input === 'string' ? pendingUse.input : JSON.stringify(pendingUse.input, null, 2));
            html = `<div class="chat-tool-use chat-tool-use-error"><span class="chat-tool-label">\u2717 ${escHtml(pendingUse.name)} ${escHtml(fp)}</span><div class="chat-tool-error-reason">${escHtml(firstLine)}</div><details class="chat-diff"><summary class="chat-diff-summary">Show input</summary><pre>${escHtml(inputStr).substring(0, 3000)}</pre></details></div>`;
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

    // Actual user message
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    let textHtml = '';
    if (typeof content === 'string') {
      textHtml = this._linkifyText(content);
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const b of content) {
        if (b.type === 'text') parts.push(this._linkifyText(b.text));
        else if (b.type === 'image' && b.source?.data) parts.push(`<img class="chat-img" src="data:${b.source.media_type || 'image/png'};base64,${b.source.data}" alt="image">`);
        else if (b.type === 'image') parts.push('<span class="chat-img-placeholder">[Image]</span>');
      }
      textHtml = parts.join('');
    }

    if (this._compact) {
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-user">You</span><div class="chat-compact-content">${textHtml}</div></div>`;
    } else {
      el.innerHTML = `<div class="chat-bubble chat-bubble-user">${textHtml}</div>`;
    }
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
          if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'Read') && block.id) {
            // Defer rendering until tool_result arrives (to show success/failure)
            this._pendingToolUses.set(block.id, block);
            parts.push(`<div class="chat-tool-pending" data-tool-id="${escHtml(block.id)}"><span class="chat-tool-label">\u23F3 ${escHtml(block.name)} ${escHtml(block.input?.file_path || '')}</span><span class="chat-spinner"></span></div>`);
          } else {
            const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
            parts.push(`<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(block.name || 'tool')}</span><details><summary>Input</summary><pre>${escHtml(inputStr).substring(0, 3000)}</pre></details></div>`);
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

    return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Update ${escHtml(filePath)}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
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
    html = html.replace(/(?<![="'\w])(\/(?:home|tmp|usr|var|etc|opt|mnt|root|workspace)[^\s<>"')\]]*)/g, (raw) => {
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
    html = html.replace(/(?<![="'\w])(\/(?:home|tmp|usr|var|etc|opt|mnt|root|workspace)[^\s<>&]*)/g, (raw) => {
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
          // Check if path is file, directory, or doesn't exist
          fetch(`/api/file/info?path=${encodeURIComponent(fp)}`)
            .then(r => r.json())
            .then(info => {
              if (info.error) {
                this._flashLink(link, 'Not found');
              } else if (info.isDirectory) {
                this.app.openFileExplorer(fp);
              } else {
                this.app.openFile(fp, fp.split('/').pop());
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
    const orig = link.textContent;
    link.textContent = msg;
    setTimeout(() => { link.textContent = orig; }, 800);
  }

  _doSearch(query) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._executeSearch(query), 150);
  }

  _executeSearch(query) {
    this._clearSearch();
    const q = query.trim().toLowerCase();
    if (!q) { this._searchStatus.textContent = ''; return; }

    // Collect ranges in batches to avoid blocking
    const walker = document.createTreeWalker(this._messageList, NodeFilter.SHOW_TEXT);
    const ranges = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(q, idx)) !== -1) {
        ranges.push({ node, start: idx, length: q.length });
        idx += q.length;
      }
    }

    // Apply highlights (reverse order to preserve offsets)
    const matches = [];
    for (let i = ranges.length - 1; i >= 0; i--) {
      const { node, start, length } = ranges[i];
      try {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + length);
        const mark = document.createElement('mark');
        mark.className = 'chat-search-highlight';
        range.surroundContents(mark);
        matches.unshift(mark);
      } catch {}
    }

    this._searchMatches = matches;
    this._searchIdx = matches.length > 0 ? 0 : -1;
    this._searchStatus.textContent = matches.length > 0 ? `1/${matches.length}` : 'No results';
    if (matches.length > 0) {
      this._scrollToMatch(matches[0]);
    }
  }

  _searchNav(dir) {
    if (!this._searchMatches.length) return;
    this._searchMatches[this._searchIdx]?.classList.remove('chat-search-current');
    this._searchIdx = (this._searchIdx + dir + this._searchMatches.length) % this._searchMatches.length;
    this._scrollToMatch(this._searchMatches[this._searchIdx]);
    this._searchStatus.textContent = `${this._searchIdx + 1}/${this._searchMatches.length}`;
  }

  // Expand parent <details> if collapsed, then scroll to match
  _scrollToMatch(mark) {
    mark.classList.add('chat-search-current');
    // Open any collapsed <details> ancestors
    let el = mark.parentElement;
    while (el && el !== this._messageList) {
      if (el.tagName === 'DETAILS' && !el.open) el.open = true;
      el = el.parentElement;
    }
    requestAnimationFrame(() => mark.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  _clearSearch() {
    for (const mark of this._messageList.querySelectorAll('mark.chat-search-highlight')) {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    this._searchMatches = [];
    this._searchIdx = -1;
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

  _showTyping() {
    this._hideTyping();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-typing';
    if (this._compact) {
      el.innerHTML = '<div class="chat-compact-msg"><span class="chat-role chat-role-assistant">Claude</span><div class="chat-compact-content"><span class="chat-thinking-indicator"><span class="chat-spinner"></span> thinking...</span></div></div>';
    } else {
      el.innerHTML = '<div class="chat-bubble chat-bubble-assistant"><span class="chat-thinking-indicator"><span class="chat-spinner"></span> thinking...</span></div>';
    }
    this._typingEl = el;
    this._messageList.appendChild(el);
    this._scrollToBottom();
  }

  _hideTyping() {
    if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }
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
    this.ws.offStateChange(this._stateHandler);
  }
}

export { ChatView };
