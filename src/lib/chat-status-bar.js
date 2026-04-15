import { escHtml } from './utils.js';
import { UI_ICONS } from './icons.js';

/**
 * ChatStatusBar — status bar for chat mode sessions.
 * Shows model, permission mode, background tasks, context usage, cache ratio, cost.
 */
export class ChatStatusBar {
  /**
   * @param {object} ws - WsManager instance
   * @param {string} sessionId - session identifier
   * @param {object} opts
   * @param {string} [opts.backend] - backend identifier
   * @param {function} opts.getToolMsg - (toolCallId) => msg, looks up tool message for popup details
   * @param {function} opts.openSubagentViewer - ({ parentToolUseId, description }) => void
   * @param {function} opts.openInTempEditor - (text) => void
   * @param {function} [opts.startReview] - ({ target, delivery }) => void
   */
  constructor(ws, sessionId, { backend = 'claude', allowReview = false, getToolMsg, openSubagentViewer, openInTempEditor, startReview }) {
    this._ws = ws;
    this._sessionId = sessionId;
    this._backend = backend;
    this._allowReview = allowReview;
    this._reviewEnabled = !allowReview;
    this._getToolMsg = getToolMsg;
    this._openSubagentViewer = openSubagentViewer;
    this._openInTempEditor = openInTempEditor;
    this._startReview = startReview || (() => {});

    // Status state
    this._statusModel = '';
    this._statusLastInputTokens = 0;
    this._statusLastCacheRead = 0;
    this._statusCost = 0;
    this._statusContextWindow = 0;
    this._statusPermMode = '';
    this._permissionModes = null;
    this._activeTasks = null;

    // Container reference (set via popupContainer setter for dropdown positioning)
    this._popupContainer = null;

    // Build DOM
    this._element = document.createElement('div');
    this._element.className = 'chat-status-bar';

    // Click handlers
    this._element.addEventListener('click', (e) => {
      this._onClick(e);
    });
  }

  /** The .chat-status-bar element */
  get element() { return this._element; }

  /** Current model name */
  get statusModel() { return this._statusModel; }

  /** Current permission mode */
  get statusPermMode() { return this._statusPermMode; }

  /** Available permission modes */
  get permissionModes() { return this._permissionModes; }

  /** Active background tasks Map */
  get activeTasks() { return this._activeTasks; }

  /** Set the container for popup positioning (the .chat-view element) */
  set popupContainer(el) { this._popupContainer = el; }

  // ── Public API ──

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
    this.render();
  }

  updateUsage(usageData) {
    const u = usageData;
    this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    this._statusLastCacheRead = u.cache_read_input_tokens || 0;
    this.render();
  }

  updateTask(taskInfo, toolCallId, content) {
    if (!this._activeTasks) this._activeTasks = new Map();
    if (taskInfo.status !== 'running') {
      this._activeTasks.delete(toolCallId);
    } else if (taskInfo.status === 'running') {
      const block = content?.[0];
      const task = { ...taskInfo };
      if (block?.type === 'tool_call') {
        task.toolName = block.toolName;
        task.command = block.input?.command || '';
      }
      this._activeTasks.set(toolCallId, task);
    }
    this.render();
  }

  setTasks(tasks) {
    const next = new Map();
    for (const [toolCallId, taskInfo] of Object.entries(tasks || {})) {
      if (taskInfo?.status === 'running') next.set(toolCallId, { ...taskInfo });
    }
    this._activeTasks = next.size ? next : null;
    this.render();
  }

  addCost(cost, modelUsage) {
    if (cost) { this._statusCost += cost; }
    if (modelUsage) {
      const info = Object.values(modelUsage)[0];
      if (info?.contextWindow) this._statusContextWindow = info.contextWindow;
      if (!this._statusModel) this._statusModel = Object.keys(modelUsage)[0]?.replace(/\[.*$/, '');
    }
    this.render();
  }

  setModel(model) {
    this._statusModel = model;
    this.render();
  }

  setPermMode(mode) {
    this._statusPermMode = mode;
    this.render();
  }

  setReviewEnabled(enabled) {
    this._reviewEnabled = !!enabled;
    this.render();
  }

  render() {
    const fmtK = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'm' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    const parts = [];

    // Model badge
    if (this._statusModel) {
      parts.push(`<span class="chat-status-model" title="Model (set at session creation)">${escHtml(this._statusModel)}</span>`);
    }

    // Permission mode (always show, click to change)
    const permLabel = this._statusPermMode || 'default';
    parts.push(`<span class="chat-status-perm chat-status-clickable" title="Click to change permission mode">${UI_ICONS.lock} ${escHtml(permLabel)}</span>`);

    // Background tasks
    if (this._activeTasks?.size > 0) {
      const count = this._activeTasks.size;
      const tasks = [...this._activeTasks.values()];
      const label = count === 1 ? tasks[0].description : `${count} tasks`;
      parts.push(`<span class="chat-status-tasks chat-status-clickable" title="${escHtml(tasks.map(t => t.description).join(', '))}">${UI_ICONS.refresh} ${escHtml(label)}</span>`);
    }

    if (this._backend === 'codex' && this._allowReview) {
      const reviewClass = this._reviewEnabled ? 'chat-status-clickable' : 'chat-status-dim';
      const reviewTitle = this._reviewEnabled
        ? 'Start Codex review'
        : 'Review becomes available after the first completed assistant turn';
      parts.push(`<span class="chat-status-review ${reviewClass}" title="${escHtml(reviewTitle)}">\u2713 Review</span>`);
    }

    // Context % with pie chart
    if (this._statusContextWindow && this._statusLastInputTokens) {
      const pct = Math.min(100, Math.round((this._statusLastInputTokens / this._statusContextWindow) * 100));
      const color = pct > 95 ? '#ef4444' : pct > 85 ? '#f97316' : pct > 70 ? '#eab308' : '#22c55e';
      const deg = Math.round(pct * 3.6);
      const usedK = fmtK(this._statusLastInputTokens);
      const totalK = fmtK(this._statusContextWindow);
      parts.push(`<span class="chat-status-ctx"><span class="chat-status-ctx-pie" style="background:conic-gradient(${color} ${deg}deg, var(--bg-input) ${deg}deg)"></span> <span style="color:${color}">${pct}%</span><span class="chat-status-dim">[${usedK}/${totalK}]</span></span>`);
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

    this._element.innerHTML = parts.join(' ');
  }

  // ── Private ──

  _onClick(e) {
    const container = this._popupContainer || this._element.parentElement;
    const showDropdown = (anchor) => {
      const existing = container.querySelector('.chat-status-dropdown');
      if (existing) { existing.remove(); return null; }
      const dropdown = document.createElement('div');
      dropdown.className = 'chat-status-dropdown';
      const rect = anchor.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      dropdown.style.position = 'absolute';
      dropdown.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
      dropdown.style.left = (rect.left - containerRect.left) + 'px';
      container.appendChild(dropdown);
      const close = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== anchor) {
          dropdown.remove();
          document.removeEventListener('mousedown', close);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
      return dropdown;
    };

    // Background tasks click -> popup
    const taskEl = e.target.closest('.chat-status-tasks');
    if (taskEl && this._activeTasks?.size) {
      e.stopPropagation();
      const dropdown = showDropdown(taskEl);
      if (!dropdown) return;
      for (const [toolUseId, task] of this._activeTasks) {
        const item = document.createElement('div');
        item.className = 'chat-status-dropdown-item chat-task-detail';
        const icon = task.type === 'agent' ? UI_ICONS.robot : UI_ICONS.tasks;
        let detail = `<div class="chat-task-title">${icon} ${escHtml(task.description)}</div>`;
        if (task.lastTool) detail += `<div class="chat-status-dim">Running: ${escHtml(task.lastTool)}</div>`;
        item.innerHTML = detail;
        item.onclick = (ev) => {
          ev.stopPropagation(); dropdown.remove();
          if (task.type === 'agent') {
            this._openSubagentViewer({
              parentToolUseId: toolUseId,
              threadId: task.receiverThreadIds?.[0] || '',
              description: task.description,
              agentRole: task.agentRole || '',
              agentNickname: task.agentNickname || '',
            });
          } else {
            // Open command input + output in editor
            const toolMsg = this._getToolMsg(toolUseId);
            const block = toolMsg?.content?.[0];
            const input = block?.input || {};
            const toolName = task.toolName || block?.toolName || 'Bash';
            const command = task.command || input.command || JSON.stringify(input, null, 2);
            const output = task.resultText || block?.output || '';
            let text = `[${toolName}] ${task.description}\n\n--- Command ---\n${command}\n`;
            if (output) text += `\n--- Output ---\n${output}\n`;
            this._openInTempEditor(text);
          }
        };
        dropdown.appendChild(item);
      }
      return;
    }

    const reviewEl = e.target.closest('.chat-status-review');
    if (reviewEl && this._backend === 'codex' && this._allowReview && this._reviewEnabled) {
      e.stopPropagation();
      const dropdown = showDropdown(reviewEl);
      if (!dropdown) return;
      const reviewOptions = [
        { label: 'Working Tree', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
        { label: 'Working Tree (Detached)', target: { type: 'uncommittedChanges' }, delivery: 'detached' },
        { label: 'Base Branch...', kind: 'baseBranch', delivery: 'inline' },
        { label: 'Base Branch... (Detached)', kind: 'baseBranch', delivery: 'detached' },
        { label: 'Commit...', kind: 'commit', delivery: 'inline' },
        { label: 'Commit... (Detached)', kind: 'commit', delivery: 'detached' },
        { label: 'Custom...', kind: 'custom', delivery: 'inline' },
        { label: 'Custom... (Detached)', kind: 'custom', delivery: 'detached' },
      ];
      for (const option of reviewOptions) {
        const item = document.createElement('div');
        item.className = 'chat-status-dropdown-item';
        item.textContent = option.label;
        item.onclick = (ev) => {
          ev.stopPropagation();
          dropdown.remove();
          let target = option.target || null;
          if (option.kind === 'baseBranch') {
            const branch = prompt('Base branch to review against:', 'main');
            if (!branch) return;
            target = { type: 'baseBranch', branch: branch.trim() };
          } else if (option.kind === 'commit') {
            const sha = prompt('Commit SHA to review:', '');
            if (!sha) return;
            target = { type: 'commit', sha: sha.trim() };
          } else if (option.kind === 'custom') {
            const instructions = prompt('Review instructions:', '');
            if (!instructions) return;
            target = { type: 'custom', instructions: instructions.trim() };
          }
          if (!target) return;
          this._startReview({ target, delivery: option.delivery || 'inline' });
        };
        dropdown.appendChild(item);
      }
      return;
    }

    // Permission mode click -> dropdown
    const el = e.target.closest('.chat-status-perm');
    if (!el) return;
    e.stopPropagation();
    const modes = this._permissionModes || ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'];
    const dropdown = showDropdown(el);
    if (!dropdown) return;
    for (const mode of modes) {
      const item = document.createElement('div');
      item.className = 'chat-status-dropdown-item' + (mode === this._statusPermMode ? ' active' : '');
      item.textContent = mode;
      item.onclick = (ev) => {
        ev.stopPropagation();
        dropdown.remove();
        this._ws.send({ type: 'set-permission-mode', sessionId: this._sessionId, mode });
        this._statusPermMode = mode;
        this.render();
      };
      dropdown.appendChild(item);
    }
  }
}
