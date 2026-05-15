/**
 * ChatRenderers — extracted rendering methods from ChatView.
 * Handles all message rendering, linkification, wrap toggles,
 * and open-in-editor functionality for the chat interface.
 */

import { marked } from 'marked';
import { escHtml, copyText } from './utils.js';
import { renderCodeBlock, rehighlightCodeBlock, stripAnsi } from './highlight.js';
import { UI_ICONS } from './icons.js';
import { createBackendIconHtml, getBackendMeta } from './agent-meta.js';

function normalizeUserInputAnswers(rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    if (Array.isArray(value)) {
      result[key] = value.map((entry) => String(entry));
    } else if (value && typeof value === 'object' && Array.isArray(value.answers)) {
      result[key] = value.answers.map((entry) => String(entry));
    }
  }
  return result;
}

function normalizePatchChangeType(rawType) {
  const normalized = String(
    typeof rawType === 'string'
      ? rawType
      : rawType?.type || rawType?.kind || '',
  ).toLowerCase();
  if (normalized === 'create' || normalized === 'insert') return 'add';
  if (normalized === 'remove') return 'delete';
  if (normalized === 'rename') return 'move';
  return normalized || 'update';
}

function normalizePatchChanges(rawChanges) {
  const changes = [];
  const pushChange = (fallbackPath, raw) => {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const filePath = entry.path || entry.file_path || entry.filePath || fallbackPath || '';
    const changeType = normalizePatchChangeType(entry.type || entry.kind);
    const movePath = entry.move_path || entry.movePath || entry.new_path || entry.newPath || '';
    const unifiedDiff = entry.unified_diff || entry.unifiedDiff || '';
    const diff = entry.diff || '';
    const content = entry.content || '';
    if (!filePath && !movePath && !unifiedDiff && !diff && !content) return;
    changes.push({ filePath, changeType, movePath, unifiedDiff, diff, content });
  };

  if (Array.isArray(rawChanges)) {
    for (const entry of rawChanges) pushChange('', entry);
    return changes;
  }
  if (rawChanges && typeof rawChanges === 'object') {
    for (const [filePath, entry] of Object.entries(rawChanges)) pushChange(filePath, entry);
  }
  return changes;
}

function parseUnifiedDiffLines(text) {
  const diffLines = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.startsWith('@@') && (line.startsWith('---') || line.startsWith('+++'))) continue;
    if (line.startsWith('@@')) {
      diffLines.push({ type: 'ctx', prefix: '@@', text: line });
    } else if (line.startsWith('+')) {
      diffLines.push({ type: 'add', prefix: '+', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      diffLines.push({ type: 'del', prefix: '-', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      diffLines.push({ type: 'ctx', prefix: ' ', text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      diffLines.push({ type: 'ctx', prefix: '\\', text: line });
    } else {
      diffLines.push({ type: 'ctx', prefix: ' ', text: line });
    }
  }
  return diffLines;
}

class ChatRenderers {
  /**
   * @param {Object} opts
   * @param {Object} opts.ws - WebSocket manager (for permission responses)
   * @param {string} opts.sessionId - Current session ID
   * @param {Object} opts.app - App controller (for opening files/editors)
   * @param {boolean} opts.compact - Compact mode flag
   * @param {HTMLElement} opts.messageList - Message list DOM element
   * @param {Function} [opts.onPermissionResolve] - Called when a permission is resolved (allow/deny)
   */
  constructor({ ws, sessionId, app, backend = 'claude', compact, messageList, onPermissionResolve }) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.app = app;
    this.backend = backend;
    this._compact = compact;
    this._messageList = messageList;
    this._onPermissionResolve = onPermissionResolve || (() => {});
    this.setupLinkHandler();
  }

  // ── Message renderers ──

  /**
   * Shared compact/bubble wrapper for user, assistant, and tool messages.
   * role: 'user' | 'assistant' | 'tool'. Tool messages have no bubble in non-compact mode.
   */
  wrapMsg(el, role, label, html) {
    if (this._compact) {
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-${role}">${label}</span><div class="chat-compact-content">${html}</div></div>`;
    } else if (role === 'tool') {
      el.innerHTML = html;
    } else {
      el.innerHTML = `<div class="chat-bubble chat-bubble-${role}">${html}</div>`;
    }
  }

  renderUserMsg(msg) {
    const content = msg.content;
    if (!content?.length) return null;

    // Detect system notifications: command tags, meta directives, reminders
    const rawText = content.map(b => b.text || '').join('');
    const isNotification = /^<(command-name|local-command|task-notification|system-reminder)/.test(rawText.trim())
      || /^A session-scoped Stop hook is now active/.test(rawText.trim());
    if (isNotification) {
      return this._renderNotificationMsg(rawText);
    }

    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    el._rawMsg = msg;
    const parts = content.map(b => {
      if (b.type === 'text') return `<div class="chat-text">${this.renderMarkdown(b.text)}</div>`;
      if (b.type === 'image') return `<img class="chat-img" src="data:${b.mediaType || 'image/png'};base64,${b.data}" alt="image">`;
      return '';
    }).join('');

    const textHtml = rawText.length > 500
      ? `<details class="chat-long-msg"><summary><span>${escHtml(rawText.substring(0, 120))}... (${rawText.length} chars)</span></summary>${parts}</details>`
      : parts;

    this.wrapMsg(el, 'user', 'You', textHtml);
    return el;
  }

  _renderNotificationMsg(rawText) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system chat-system-notification';
    el._rawMsg = { role: 'system' };

    // Extract readable label from tagged content
    let label = '', detail = '';
    const cmdMatch = rawText.match(/<command-name>\/?(\w+)<\/command-name>/);
    const argsMatch = rawText.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const stdoutMatch = rawText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    const hookMatch = rawText.match(/^A session-scoped Stop hook is now active with condition: "([\s\S]*?)"/);

    if (cmdMatch) {
      label = `/${cmdMatch[1]}`;
      if (argsMatch) detail = argsMatch[1].trim();
    } else if (stdoutMatch) {
      label = stdoutMatch[1].trim().substring(0, 80);
      if (stdoutMatch[1].length > 80) label += '...';
    } else if (hookMatch) {
      label = `Goal: ${hookMatch[1].substring(0, 60)}${hookMatch[1].length > 60 ? '...' : ''}`;
    } else {
      label = rawText.replace(/<[^>]+>/g, '').trim().substring(0, 80) || 'notification';
    }

    if (detail) {
      el.innerHTML = `<details class="chat-hook-details"><summary class="chat-hook-summary">${escHtml(label)}</summary><pre class="chat-hook-output">${escHtml(detail)}</pre></details>`;
    } else {
      el.innerHTML = `<span class="chat-system-text">${escHtml(label)}</span>`;
    }
    return el;
  }

  renderAssistantMsg(msg) {
    const block = msg.content?.[0];
    if (!block) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';
    el._rawMsg = msg;
    let html;
    if (block.type === 'thinking') {
      html = `<details class="chat-thinking"${msg.status === 'streaming' ? ' open' : ''}><summary>Thinking</summary><pre>${escHtml(stripAnsi(block.text || ''))}</pre></details>`;
    } else if (block.type === 'text') {
      html = `<div class="chat-text">${this.renderMarkdown(stripAnsi(block.text || ''))}</div>`;
    } else {
      return null;
    }
    this.wrapMsg(el, 'assistant', createBackendIconHtml(this.backend, {
      title: getBackendMeta(this.backend).label,
      className: 'chat-role-backend-icon',
    }), html);
    return el;
  }

  renderToolMsg(msg) {
    const block = msg.content?.[0];
    if (!block) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant chat-msg-tool-result';
    el._rawMsg = msg;
    if (msg.toolCallId) el.dataset.toolId = msg.toolCallId;
    let html;

    if (block.type === 'tool_call') {
      // Tool call — pending (spinner) or interrupted (error, no result ever came)
      const isAgent = block.toolName === 'Agent';
      const icon = isAgent ? UI_ICONS.robot : UI_ICONS.wrench;
      const fp = block.input?.file_path || '';
      const isFileOp = ['Edit', 'Write', 'Read'].includes(block.toolName);
      const isPending = msg.status === 'pending';
      if (isPending && isFileOp) {
        const label = `\u23F3 ${escHtml(block.toolName)} ${this.clickablePath(fp)}`;
        html = `<div class="chat-tool-pending"><span class="chat-tool-label">${label}</span><span class="chat-spinner"></span></div>`;
      } else {
        const desc = isAgent && block.input?.description ? `${icon} Agent: ${escHtml(block.input.description)}` : `${icon} ${escHtml(block.toolName)}`;
        const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
        const statusHtml = isPending
          ? `<div class="chat-tool-output-pending"><span class="chat-spinner"></span> running...</div>`
          : `<details class="chat-diff" open><summary class="chat-diff-summary chat-tool-error-label">\u2717 Interrupted</summary></details>`;
        html = `<div class="chat-tool-use"><span class="chat-tool-label">${desc}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this.linkifyText(inputStr)}</pre></details>${statusHtml}</div>`;
      }
    } else if (block.type === 'tool_result') {
      // Completed tool call — show full result
      html = this.renderToolResult(block, msg);
    } else {
      html = `<pre>${escHtml(JSON.stringify(block, null, 2))}</pre>`;
    }

    const toolLabel = msg.toolStatus === 'error' ? '\u2717' : msg.status === 'pending' ? '\u23F3' : '\u2713';
    this.wrapMsg(el, 'tool', toolLabel, html);

    // Permission overlay — only for pending or denied (resolved+complete = no overlay needed)
    if (msg.permission && !(msg.permission.resolved === 'allowed' && msg.status === 'complete')) {
      this.renderPermissionOverlay(el, msg);
    }

    return el;
  }

  /**
   * Render a completed tool result (Edit diff, Write/Read code block, Agent, generic)
   */
  renderToolResult(block, msg) {
    const fp = block.input?.file_path || '';
    let resultText = stripAnsi(block.output || '');
    // Parse JSON content arrays (e.g. Agent tool returns [{"type":"text","text":"..."}])
    if (resultText.startsWith('[{')) {
      try {
        const parsed = JSON.parse(resultText);
        if (Array.isArray(parsed)) resultText = parsed.map(b => b.text || '').filter(Boolean).join('\n');
      } catch {}
    }
    const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));

    if (block.status === 'error') {
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.wrench} ${escHtml(block.toolName)} ${this.clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff" open><summary class="chat-diff-summary chat-tool-error-label">\u2717 Error</summary><pre class="chat-tool-error-text">${this.linkifyText(resultText)}</pre></details></div>`;
    }
    if (block.toolName === 'Patch') {
      const patchHtml = this.renderPatchDiff(block);
      if (patchHtml) return patchHtml;
    }
    if (block.toolName === 'Edit' && block.input?.old_string != null) {
      return this.renderEditDiff({ input: block.input });
    }
    if (block.toolName === 'Write') {
      const content = block.input?.content || '';
      const lineCount = content.split('\n').length;
      const byteCount = new Blob([content]).size;
      const sizeStr = byteCount > 1024 ? (byteCount / 1024).toFixed(1) + ' KB' : byteCount + ' B';
      const codeBlock = this.renderCodeBlock(content, fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.memo} Write ${this.clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines, ${sizeStr}</summary>${codeBlock}</details></div>`;
    }
    if (block.toolName === 'Read') {
      const lineCount = resultText.split('\n').length;
      const codeBlock = this.renderCodeBlock(resultText, fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.book} Read ${this.clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines</summary>${codeBlock}</details></div>`;
    }
    if (block.toolName === 'Agent') {
      const desc = block.input?.description || '';
      const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
      const reviewThreadId = msg?.taskInfo?.receiverThreadIds?.[0] || '';
      const agentId = msg?.taskInfo?.id || (resultText.match(/agentId:\s*([a-z0-9]+)/)?.[1]) || '';
      const dataAttrs = reviewThreadId
        ? ` data-thread-id="${escHtml(reviewThreadId)}"`
        : agentId
          ? ` data-agent-id="${escHtml(agentId)}"`
          : block.toolCallId
            ? ` data-parent-tool-id="${escHtml(block.toolCallId)}"`
            : '';
      const viewBtn = dataAttrs
        ? ` <button class="chat-agent-view-btn"${dataAttrs} data-desc="${escHtml(desc)}">View Log</button>`
        : '';
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.robot} Agent: ${escHtml(desc)}${viewBtn}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${this.linkifyText(resultText)}</pre></details></div>`;
    }
    // Generic tool
    const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
    return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.wrench} ${escHtml(block.toolName)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${this.linkifyText(resultText)}</pre></details></div>`;
  }

  /**
   * Render a system message. Returns { el, sideEffect } where sideEffect contains
   * metadata extracted from system.init messages, so ChatView can apply them.
   * Returns null if the message should not be rendered (e.g. system.init).
   */
  renderSystemMsg(msg) {
    const text = msg.content?.[0]?.text || '';
    // system.init — extract metadata, don't render
    if (msg.content?.[0]?.initData) {
      const d = msg.content[0].initData;
      const sideEffect = {};
      if (d.model) sideEffect.model = d.model.replace(/\[.*$/, '');
      if (d.permissionMode) sideEffect.permMode = d.permissionMode;
      if (d.slashCommands) sideEffect.slashCommands = d.slashCommands.map(c => c.startsWith('/') ? c : '/' + c);
      return { el: null, sideEffect };
    }
    // Hook events — compact collapsible
    if (msg.content?.[0]?.hookData) {
      const h = msg.content[0].hookData;
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification';
      const output = h.output ? escHtml(h.output).substring(0, 500) : '';
      el.innerHTML = `<details class="chat-hook-details"><summary class="chat-hook-summary">${escHtml(text)}</summary>${output ? `<pre class="chat-hook-output">${output}</pre>` : ''}</details>`;
      return { el, sideEffect: null };
    }
    // Error / interrupted
    if (msg.status === 'error' || msg.status === 'interrupted') {
      return { el: this.appendSystem(text), sideEffect: null };
    }
    // Other system messages (hook summary, etc.)
    if (text) {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification';
      el.innerHTML = `<span class="chat-system-text">${escHtml(text)}</span>`;
      return { el, sideEffect: null };
    }
    return null;
  }

  renderPermissionOverlay(el, msg) {
    if (!msg.permission) return;
    // Remove existing permission overlay
    const existing = el.querySelector('.chat-permission-inline');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.className = 'chat-permission-inline';
    section.dataset.requestId = msg.permission.requestId;

    if (msg.permission.kind === 'user_input' && !msg.permission.resolved) {
      const questions = msg.permission.questions || [];
      section.innerHTML = '';
      const prompt = document.createElement('div');
      prompt.className = 'chat-permission-prompt';
      const label = document.createElement('span');
      label.className = 'chat-permission-label';
      label.textContent = `Input Requested: ${msg.permission.toolName}`;
      prompt.appendChild(label);

      const answersWrap = document.createElement('div');
      answersWrap.className = 'chat-permission-actions';
      const answerInputs = new Map();

      for (const q of questions) {
        const row = document.createElement('div');
        row.className = 'chat-permission-question';
        const qLabel = document.createElement('div');
        qLabel.className = 'chat-status-dim';
        qLabel.textContent = q.question || q.header || q.id;
        row.appendChild(qLabel);

        if (Array.isArray(q.options) && q.options.length) {
          for (const option of q.options) {
            const btn = document.createElement('button');
            btn.className = 'chat-perm-btn';
            btn.textContent = option.label;
            btn.onclick = () => {
              this.ws.send({
                type: 'permission-response',
                sessionId: this.sessionId,
                requestId: msg.permission.requestId,
                responseData: {
                  decision: 'accept',
                  answers: { [q.id]: { answers: [option.label] } },
                },
              });
              msg.permission.resolved = 'allowed';
              msg.permission.answers = { ...(msg.permission.answers || {}), [q.id]: { answers: [option.label] } };
              this.renderPermissionOverlay(el, msg);
              this._onPermissionResolve('allowed');
            };
            row.appendChild(btn);
          }
        } else {
          const input = document.createElement('input');
          input.className = 'filter-input';
          input.placeholder = q.header || q.id || 'Answer';
          input.style.minWidth = '180px';
          answerInputs.set(q.id, input);
          row.appendChild(input);
        }
        answersWrap.appendChild(row);
      }

      if (answerInputs.size) {
        const submitBtn = document.createElement('button');
        submitBtn.className = 'chat-perm-btn chat-perm-allow';
        submitBtn.textContent = 'Submit';
        submitBtn.onclick = () => {
          const answers = {};
          for (const [id, input] of answerInputs) {
            const value = input.value.trim();
            if (value) answers[id] = [value];
          }
          this.ws.send({
            type: 'permission-response',
            sessionId: this.sessionId,
            requestId: msg.permission.requestId,
            responseData: {
              decision: 'accept',
              answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: value }])),
            },
          });
          msg.permission.resolved = 'allowed';
          msg.permission.answers = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: value }]));
          this.renderPermissionOverlay(el, msg);
          this._onPermissionResolve('allowed');
        };
        answersWrap.appendChild(submitBtn);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'chat-perm-btn chat-perm-deny';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => {
        this.ws.send({
          type: 'permission-response',
          sessionId: this.sessionId,
          requestId: msg.permission.requestId,
          responseData: { decision: 'cancel' },
        });
        msg.permission.resolved = 'denied';
        this.renderPermissionOverlay(el, msg);
      };
      answersWrap.appendChild(cancelBtn);
      prompt.appendChild(answersWrap);
      section.appendChild(prompt);
    } else if (msg.permission.kind === 'user_input' && msg.permission.resolved) {
      section.innerHTML = '';
      const prompt = document.createElement('div');
      prompt.className = 'chat-permission-prompt';
      const resolved = document.createElement('div');
      resolved.className = `chat-permission-resolved ${msg.permission.resolved === 'denied' ? 'chat-permission-denied' : 'chat-permission-allowed'}`;
      resolved.textContent = msg.permission.resolved === 'denied' ? '\u2717 Input Cancelled' : '\u2713 Input Submitted';
      prompt.appendChild(resolved);

      if (msg.permission.resolved !== 'denied') {
        const normalizedAnswers = normalizeUserInputAnswers(msg.permission.answers);
        const questions = msg.permission.questions || [];
        for (const q of questions) {
          const row = document.createElement('div');
          row.className = 'chat-permission-question';
          const qLabel = document.createElement('div');
          qLabel.className = 'chat-status-dim';
          qLabel.textContent = q.question || q.header || q.id;
          row.appendChild(qLabel);
          const values = normalizedAnswers[q.id] || [];
          for (const answer of values) {
            const answerEl = document.createElement('div');
            answerEl.className = 'chat-perm-answer';
            answerEl.textContent = answer;
            row.appendChild(answerEl);
          }
          prompt.appendChild(row);
        }
      }

      section.appendChild(prompt);
    } else if (msg.permission.resolved) {
      const icon = msg.permission.resolved === 'denied' ? '\u2717' : '\u2713';
      const label = msg.permission.resolved === 'denied' ? 'Denied' : 'Allowed';
      const cls = msg.permission.resolved === 'denied' ? 'chat-permission-denied' : 'chat-permission-allowed';
      section.innerHTML = `<details class="chat-diff"><summary class="chat-diff-summary"><span class="chat-permission-resolved ${cls}">${icon} ${label}</span></summary></details>`;
    } else {
      section.innerHTML = `<div class="chat-permission-prompt"><span class="chat-permission-label">${UI_ICONS.lock} Permission: ${escHtml(msg.permission.toolName)}</span><div class="chat-permission-actions"><button class="chat-perm-btn chat-perm-allow">Allow</button>${msg.permission.suggestions?.length ? '<button class="chat-perm-btn chat-perm-always">Always Allow</button>' : ''}<button class="chat-perm-btn chat-perm-deny">Deny</button></div></div>`;
      section.querySelector('.chat-perm-allow')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: true, toolInput: msg.permission.input });
        msg.permission.resolved = 'allowed';
        this.renderPermissionOverlay(el, msg);
        this._onPermissionResolve('allowed');
      });
      section.querySelector('.chat-perm-always')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: true, toolInput: msg.permission.input, permissionUpdates: msg.permission.suggestions });
        msg.permission.resolved = 'allowed';
        this.renderPermissionOverlay(el, msg);
        this._onPermissionResolve('allowed');
      });
      section.querySelector('.chat-perm-deny')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: false });
        msg.permission.resolved = 'denied';
        this.renderPermissionOverlay(el, msg);
      });
    }

    const toolUse = el.querySelector('.chat-tool-use') || el.querySelector('.chat-tool-pending');
    if (toolUse) {
      const outputPending = toolUse.querySelector('.chat-tool-output-pending');
      if (outputPending) outputPending.before(section);
      else toolUse.appendChild(section);
    }
  }

  renderEditDiff(block) {
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

    return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.memo} Update ${this.clickablePath(filePath)}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
  }

  renderPatchDiff(block) {
    const changes = normalizePatchChanges(block.input?.changes);
    if (!changes.length) return '';

    return changes.map((change) => {
      const fromPath = change.filePath || '';
      const filePath = fromPath || change.movePath || '';
      const rawDiff = change.unifiedDiff || change.diff || '';
      const hasUnifiedMarkers = rawDiff.includes('@@') || rawDiff.startsWith('---') || rawDiff.startsWith('+++');
      const diffLines = hasUnifiedMarkers
        ? parseUnifiedDiffLines(rawDiff)
        : (rawDiff || change.content)
          ? String(rawDiff || change.content)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => ({
              type: change.changeType === 'delete' ? 'del' : 'add',
              prefix: change.changeType === 'delete' ? '-' : '+',
              text: line,
            }))
          : [];
      const addCount = diffLines.filter((line) => line.type === 'add').length;
      const delCount = diffLines.filter((line) => line.type === 'del').length;
      const action = change.changeType === 'add'
        ? 'Write'
        : change.changeType === 'delete'
          ? 'Delete'
          : change.changeType === 'move'
            ? 'Move'
            : 'Update';
      const pathLabel = change.movePath && fromPath
        ? `${this.clickablePath(fromPath)} \u2192 ${this.clickablePath(change.movePath)}`
        : this.clickablePath(filePath);
      const summary = change.changeType === 'move' && !addCount && !delCount
        ? `\u2713 Moved to ${escHtml(change.movePath || filePath)}`
        : change.changeType === 'delete' && !addCount && !delCount
          ? '\u2713 Removed file'
          : `\u2713 Added ${addCount} lines, removed ${delCount} lines`;
      const body = diffLines.map((line) => {
        const cls = line.type === 'add' ? 'chat-diff-add' : line.type === 'del' ? 'chat-diff-del' : 'chat-diff-ctx';
        return `<div class="${cls}"><span class="chat-diff-prefix">${escHtml(line.prefix)}</span><span class="chat-diff-text">${escHtml(line.text)}</span></div>`;
      }).join('');
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.memo} ${action} ${pathLabel}</span><details class="chat-diff" open><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
    }).join('');
  }

  renderMarkdown(text) {
    try {
      let html = marked.parse(text || '');
      return this.linkify(html);
    } catch {
      return escHtml(text || '');
    }
  }

  appendSystem(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system';
    el.innerHTML = `<div class="chat-system">${escHtml(text)}</div>`;
    this._messageList.appendChild(el); this.addWrapToggles(el); this.addOpenInEditorBtn(el);
    return el;
  }

  // ── Code block helpers (delegated to highlight.js) ──

  renderCodeBlock(code, filePath) { return renderCodeBlock(code, filePath); }
  rehighlightCodeBlock(blockEl, langId) { rehighlightCodeBlock(blockEl, langId); }

  // ── Linkification helpers ──

  /** Make a file path clickable (click=copy, ctrl+click=open) */
  clickablePath(fp) {
    return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>`;
  }

  /** Strip trailing punctuation from matched paths/URLs */
  cleanPath(p) { return p.replace(/[`'".,;:!?)}\]]+$/, ''); }

  /**
   * Linkify URLs in a text segment. esc=true wraps output in escHtml (for markdown HTML text nodes).
   * esc=false assumes input is already HTML-escaped (from escHtml on plain text).
   */
  linkifyUrls(text, esc) {
    const re = esc ? /(https?:\/\/[^\s<>"')\]]+)/g : /(https?:\/\/[^\s<>&]+)/g;
    const e = esc ? escHtml : s => s;
    return text.replace(re, (raw) => {
      const url = this.cleanPath(raw);
      const after = raw.slice(url.length);
      return `<span class="chat-link" data-href="${e(url)}" title="Click to copy, Ctrl+Click to open">${e(url)}</span>${e(after)}`;
    });
  }

  /**
   * Linkify file paths in HTML that may contain tags (from prior URL linkification).
   * Splits by tags to avoid matching inside <span> attributes. esc controls escHtml on output.
   */
  linkifyPathsTagSafe(html, esc) {
    const e = esc ? escHtml : s => s;
    const pathRe = /(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g;
    return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => {
      if (tag || !txt) return m;
      return txt.replace(pathRe, (raw) => {
        const fp = this.cleanPath(raw);
        const after = raw.slice(fp.length);
        if (fp.length < 4) return raw;
        return `<span class="chat-link chat-link-path" data-path="${e(fp)}" title="Click to copy, Ctrl+Click to open">${e(fp)}</span>${e(after)}`;
      });
    });
  }

  /** Combined URL + path linkification on a text segment. */
  linkifySegment(text, esc) {
    return this.linkifyPathsTagSafe(this.linkifyUrls(text, esc), esc);
  }

  /**
   * Auto-detect URLs and file paths in rendered HTML, make them interactive.
   * Click = copy, Ctrl+Click = open.
   */
  linkify(html) {
    return html.replace(/(<a[\s>][\s\S]*?<\/a>)|(<code[\s>][\s\S]*?<\/code>)|(<[^>]*>)|([^<]+)/gi, (match, anchor, code, tag, text) => {
      if (anchor) return match; // preserve <a>...</a> untouched
      if (code) {
        // Linkify paths/URLs inside <code> blocks while preserving the <code> wrapper
        return code.replace(/^(<code[^>]*>)([\s\S]*?)(<\/code>)$/i, (_, open, inner, close) => {
          return open + this.linkifySegment(inner, true) + close;
        });
      }
      if (tag) return tag;
      if (!text) return match;
      return this.linkifySegment(text, true);
    });
  }

  /** Linkify plain text (for tool output, user messages that don't go through markdown) */
  linkifyText(text) {
    return this.linkifySegment(escHtml(text), false);
  }

  /** Set up delegated click handler on message list for links/paths */
  setupLinkHandler() {
    const isMobile = this.app?.isMobile;
    this._messageList.addEventListener('click', (e) => {
      // Handle both our .chat-link spans and markdown-generated <a> tags
      const link = e.target.closest('.chat-link') || e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const url = link.dataset.href || link.getAttribute('href');
      const fp = link.dataset.path;
      // Mobile: tap = open (no Ctrl key available); Desktop: Ctrl/Cmd+Click = open, Click = copy
      const shouldOpen = isMobile || e.ctrlKey || e.metaKey;
      if (shouldOpen) {
        if (fp) {
          // Parse optional :line, :line:col, or :line-line suffix
          const lineMatch = fp.match(/^(.+?):(\d+)(?:[:\-]\d+)?$/);
          const cleanPath = lineMatch ? lineMatch[1] : fp;
          const lineNum = lineMatch ? parseInt(lineMatch[2], 10) : undefined;
          fetch(`/api/file/info?path=${encodeURIComponent(cleanPath)}`)
            .then(r => r.json())
            .then(info => {
              if (info.error) {
                this.flashLink(link, 'Not found');
              } else if (info.isDirectory) {
                this.app.openFileExplorer(cleanPath);
              } else {
                this.app.openFile(cleanPath, cleanPath.split('/').pop(), { line: lineNum });
              }
            })
            .catch(() => this.flashLink(link, 'Error'));
        } else if (url) {
          window.open(url, '_blank');
        }
      } else {
        // Desktop click: copy to clipboard
        const text = fp || url;
        copyText(text).then(() => this.flashLink(link, 'Copied!'));
      }
    });
  }

  flashLink(link, msg) {
    // Show tooltip near the link instead of replacing text
    const tip = document.createElement('span');
    tip.className = 'chat-link-tooltip';
    tip.textContent = msg;
    link.style.position = 'relative';
    link.appendChild(tip);
    setTimeout(() => tip.remove(), 1200);
  }

  // ── Wrap toggles and open-in-editor ──

  openInTempEditor(text) {
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

  addOpenInEditorBtn(el) {
    if (!el._rawMsg) return;
    const msg = el._rawMsg;
    // Skip tool messages (they have their own open-in-editor buttons)
    if (msg.role === 'tool') return;
    // Skip assistant messages with no text content
    if (msg.role === 'assistant' && !msg.content?.some(b => b.type === 'text' && b.text?.trim())) return;
    const btn = document.createElement('button');
    btn.className = 'chat-open-editor-btn';
    btn.innerHTML = UI_ICONS.clipboard;
    btn.title = 'Open in editor';
    btn.onclick = (e) => {
      e.stopPropagation();
      const text = this.extractMsgText(msg);
      if (!text.trim()) return;
      this.openInTempEditor(text);
    };
    el.style.position = 'relative';
    el.appendChild(btn);
  }

  extractMsgText(msg) {
    const c = msg.content;
    if (!Array.isArray(c)) return JSON.stringify(msg, null, 2);
    return c.map(b => {
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'system_info') return b.text || '';
      if (b.type === 'tool_call') return `[Tool: ${b.toolName}]\n${JSON.stringify(b.input, null, 2)}`;
      if (b.type === 'tool_result') return `[${b.toolName}] ${b.status}\n${b.output || ''}`;
      return '';
    }).filter(Boolean).join('\n\n');
  }

  /** Add wrap toggle button to all <pre> blocks inside an element */
  addWrapToggles(el) {
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
            this.rehighlightCodeBlock(block, block.dataset.lang);
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
                this.rehighlightCodeBlock(block, l);
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
}

export { ChatRenderers };
