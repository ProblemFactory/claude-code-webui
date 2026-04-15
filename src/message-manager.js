/**
 * MessageManager — converts raw Claude stream-json messages into normalized messages.
 *
 * Each NormalizedMessage has a stable ID ({sessionId}:{seq}), a role, status, and content blocks.
 * Tool calls and their results are merged into single messages server-side.
 * Streaming text is modeled as repeated edits to the same message.
 *
 * Two modes:
 *   1. Historical: bulk-convert JSONL array → NormalizedMessage[]
 *   2. Real-time: process one message at a time, emitting create/edit ops
 *
 * Backend-agnostic: other adapters (Codex, Gemini, etc.) can produce the same
 * NormalizedMessage format via their own normalizer.
 */

class MessageManager {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.seq = 0;
    this.messages = [];
    this.messageIndex = new Map();      // id → NormalizedMessage
    this.pendingToolCalls = new Map();   // toolUseId → { msgId, block }
    this.turnIndex = 0;
    this.listeners = [];
  }

  _nextId() { return `${this.sessionId}:${this.seq++}`; }

  onOp(fn) { this.listeners.push(fn); }
  offOp(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
  _emit(op) { for (const fn of this.listeners) fn(op); }

  /**
   * Bulk convert historical messages. Returns NormalizedMessage[].
   * Does NOT emit ops — caller uses the returned array directly.
   */
  convertHistory(claudeMessages) {
    for (const msg of claudeMessages) {
      this._processMessage(msg, false);
    }
    // Finalize any trailing streaming text
    this._finalizeStreaming(false);
    return this.messages;
  }

  /**
   * Process a single live message. Emits create/edit ops via listeners.
   */
  processLive(claudeMsg) {
    this._processMessage(claudeMsg, true);
  }

  /** Get current message count */
  get total() { return this.messages.length; }

  /** Get message by ID */
  get(id) { return this.messageIndex.get(id); }

  /** Get last N messages */
  tail(n) { return this.messages.slice(-n); }

  /** Get messages by offset+limit */
  slice(offset, limit) { return this.messages.slice(offset, offset + limit); }

  /** Get turn boundaries for minimap: [{turnIndex, startIdx, ts, role, preview?, isCompact?}] */
  turnMap() {
    const turns = [];
    let lastTurn = -1;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const t = m.turnIndex ?? 0;
      if (t !== lastTurn) {
        const entry = { turnIndex: t, startIdx: i, ts: m.ts, role: m.role };
        // For user messages: extract preview text (truncate at word boundary ~10 chars)
        if (m.role === 'user') {
          const raw = (m.content || []).map(b => b.text || '').join('').trim();
          if (raw) {
            // Check for compaction marker
            if (raw.startsWith('This session is being continued from a previous conversation')) {
              entry.isCompact = true;
              entry.preview = 'Context compacted';
            } else {
              entry.preview = this._truncateWord(raw, 10);
            }
          }
        }
        turns.push(entry);
        lastTurn = t;
      }
    }
    return turns;
  }

  /** Truncate text at word boundary, max ~maxLen chars */
  _truncateWord(text, maxLen) {
    if (text.length <= maxLen) return text;
    // Find last space before or at maxLen
    const cut = text.lastIndexOf(' ', maxLen);
    if (cut > maxLen * 0.5) return text.substring(0, cut) + '…';
    return text.substring(0, maxLen) + '…';
  }

  /** Search messages by text query → [{index, id, type, preview}] */
  search(query) {
    const q = query.toLowerCase();
    const matches = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const text = this._extractText(m);
      if (text.toLowerCase().includes(q)) {
        matches.push({ index: i, id: m.id, type: m.role, preview: text.substring(0, 120) });
      }
    }
    return matches;
  }

  _extractText(msg) {
    return msg.content.map(b => {
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'system_info') return b.text || '';
      if (b.type === 'tool_result') return `${b.toolName}: ${b.output || ''}`;
      if (b.type === 'tool_call') return `${b.toolName}: ${JSON.stringify(b.input).substring(0, 200)}`;
      return '';
    }).join(' ');
  }

  _create(fields) {
    const msg = {
      id: this._nextId(),
      role: fields.role,
      status: fields.status || 'complete',
      content: fields.content || [],
      ts: fields.ts || this._currentTs || Date.now(),
      turnIndex: fields.turnIndex ?? this.turnIndex,
      toolCallId: fields.toolCallId || null,
      toolName: fields.toolName || null,
      toolStatus: fields.toolStatus || null,
      permission: fields.permission || null,
      usage: fields.usage || null,
      taskInfo: fields.taskInfo || null,
    };
    this.messages.push(msg);
    this.messageIndex.set(msg.id, msg);
    return msg;
  }

  _finalizeStreaming(emit) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.status === 'streaming') {
        m.status = 'complete';
        if (emit) this._emit({ op: 'edit', id: m.id, fields: { status: 'complete' } });
      } else {
        break;
      }
    }
  }

  _processMessage(raw, emit) {
    // Extract timestamp from raw message for _create
    this._currentTs = raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now();
    switch (raw.type) {
      case 'system': return this._processSystem(raw, emit);
      case 'user': return this._processUser(raw, emit);
      case 'assistant': return this._processAssistant(raw, emit);
      case 'result': return this._processResult(raw, emit);
      case 'control_request': return this._processControlRequest(raw, emit);
      case 'control_response': return this._processControlResponse(raw, emit);
      case 'control_cancel_request': return this._processControlCancel(raw, emit);
    }
  }

  _processSystem(raw, emit) {
    if (raw.subtype === 'init') {
      const msg = this._create({
        role: 'system', status: 'complete',
        content: [{ type: 'system_info', text: `Model: ${raw.model || 'unknown'}`, initData: { model: raw.model, permissionMode: raw.permissionMode, slashCommands: raw.slash_commands } }],
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }

    // Task lifecycle → edit existing tool message
    if (raw.tool_use_id) {
      const pending = this.pendingToolCalls.get(raw.tool_use_id);
      if (!pending) return;
      const existing = this.messageIndex.get(pending.msgId);
      if (!existing) return;

      if (raw.subtype === 'task_started') {
        existing.taskInfo = { id: raw.task_id, type: raw.task_type, description: raw.description, status: 'running' };
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { taskInfo: existing.taskInfo } });
      } else if (raw.subtype === 'task_progress') {
        if (existing.taskInfo) {
          if (raw.description) existing.taskInfo.description = raw.description;
          if (raw.last_tool_name) existing.taskInfo.lastTool = raw.last_tool_name;
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { taskInfo: existing.taskInfo } });
        }
      } else if (raw.subtype === 'task_notification') {
        if (existing.taskInfo) {
          existing.taskInfo.status = 'completed';
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { taskInfo: existing.taskInfo } });
        }
      }
    }
  }

  _processUser(raw, emit) {
    const content = raw.message?.content;
    if (!content) return;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];

    // Check for tool results
    const toolResults = blocks.filter(b => b.type === 'tool_result');
    const textBlocks = blocks.filter(b => b.type !== 'tool_result');

    // Merge tool results into pending tool messages
    for (const tr of toolResults) {
      const toolUseId = tr.tool_use_id;
      const pending = this.pendingToolCalls.get(toolUseId);
      if (!pending) continue;
      const existing = this.messageIndex.get(pending.msgId);
      if (!existing) continue;

      const resultText = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
      existing.status = tr.is_error ? 'error' : 'complete';
      existing.toolStatus = tr.is_error ? 'error' : 'ok';
      // Replace tool_call content with tool_result (keeps input + adds output)
      existing.content = [{
        type: 'tool_result', toolCallId: toolUseId, toolName: pending.block.name,
        input: pending.block.input, output: resultText, status: tr.is_error ? 'error' : 'ok',
      }];
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { status: existing.status, toolStatus: existing.toolStatus, content: existing.content } });
      this.pendingToolCalls.delete(toolUseId);
    }

    // Real user message (has text content, not just tool results)
    if (textBlocks.length > 0 || toolResults.length === 0) {
      // Skip if this is a pure tool-result message (no user text)
      const hasText = textBlocks.some(b => (b.type === 'text' && b.text?.trim()) || b.type === 'image');
      if (!hasText && toolResults.length > 0) return;

      this.turnIndex++;
      const normalizedContent = textBlocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text || '' };
        if (b.type === 'image') return { type: 'image', mediaType: b.source?.media_type || 'image/png', data: b.source?.data || '' };
        return null;
      }).filter(Boolean);

      if (normalizedContent.length === 0) return;
      // Use original msgId if present (for dedup with client-side local preview)
      const msg = this._create({ role: 'user', status: 'complete', content: normalizedContent, turnIndex: this.turnIndex });
      if (emit) this._emit({ op: 'create', message: msg });
    }
  }

  _processAssistant(raw, emit) {
    const content = raw.message?.content;
    if (!Array.isArray(content) || !content.length) return;

    for (const block of content) {
      if (block.type === 'thinking') {
        const msg = this._create({ role: 'assistant', content: [{ type: 'thinking', text: block.text || '' }] });
        if (emit) this._emit({ op: 'create', message: msg });

      } else if (block.type === 'text') {
        // Streaming detection: if last message is streaming assistant text, edit it
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'assistant' && last.status === 'streaming' && last.content[0]?.type === 'text') {
          last.content = [{ type: 'text', text: block.text || '' }];
          if (emit) this._emit({ op: 'edit', id: last.id, fields: { content: last.content } });
        } else {
          this._finalizeStreaming(emit);
          const msg = this._create({ role: 'assistant', status: 'streaming', content: [{ type: 'text', text: block.text || '' }] });
          if (emit) this._emit({ op: 'create', message: msg });
        }

      } else if (block.type === 'tool_use') {
        this._finalizeStreaming(emit);
        // TodoWrite → emit meta op so frontend can update display
        if (block.name === 'TodoWrite' && block.input?.todos && emit) {
          this._emit({ op: 'meta', subtype: 'todos', data: block.input.todos });
        }
        const msgId = this._nextId();
        const msg = {
          id: msgId, role: 'tool', status: 'pending',
          content: [{ type: 'tool_call', toolCallId: block.id, toolName: block.name, input: block.input }],
          ts: Date.now(), turnIndex: this.turnIndex,
          toolCallId: block.id, toolName: block.name, toolStatus: null,
          permission: null, usage: null, taskInfo: null,
        };
        this.messages.push(msg);
        this.messageIndex.set(msgId, msg);
        this.pendingToolCalls.set(block.id, { msgId, block });
        if (emit) this._emit({ op: 'create', message: msg });
      }
    }

    // Track usage metadata
    if (raw.message?.usage && emit) {
      this._emit({ op: 'meta', subtype: 'usage', data: raw.message.usage });
    }
  }

  _processResult(raw, emit) {
    this._finalizeStreaming(emit);
    // Flush any pending tool calls that never got results (interrupted)
    for (const [toolUseId, pending] of this.pendingToolCalls) {
      const existing = this.messageIndex.get(pending.msgId);
      if (existing && existing.status === 'pending') {
        existing.status = 'error';
        existing.toolStatus = 'error';
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { status: 'error', toolStatus: 'error' } });
      }
    }
    this.pendingToolCalls.clear();
    this.turnIndex++;

    if (raw.is_error || (raw.subtype && raw.subtype !== 'success')) {
      const label = raw.subtype === 'error_during_execution' ? 'Interrupted'
        : raw.subtype === 'error_max_turns' ? 'Max turns reached'
        : raw.subtype === 'error_max_budget_usd' ? 'Budget exceeded'
        : 'Error';
      const text = raw.result ? `${label}: ${raw.result}` : label;
      const msg = this._create({
        role: 'system', status: raw.subtype === 'error_during_execution' ? 'interrupted' : 'error',
        content: [{ type: 'system_info', text }],
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }

    if (emit) {
      this._emit({ op: 'meta', subtype: 'turn_complete', data: { cost: raw.total_cost_usd || 0, modelUsage: raw.modelUsage || null } });
    }
  }

  _processControlRequest(raw, emit) {
    if (raw.request?.subtype !== 'can_use_tool') return;
    const toolUseId = raw.request.tool_use_id;
    const pending = this.pendingToolCalls.get(toolUseId);
    if (!pending) return;
    const existing = this.messageIndex.get(pending.msgId);
    if (!existing) return;

    existing.permission = {
      requestId: raw.request_id,
      toolName: raw.request.tool_name,
      input: raw.request.input || {},
      suggestions: raw.request.permission_suggestions || [],
      resolved: null,
    };
    if (emit) this._emit({ op: 'edit', id: existing.id, fields: { permission: existing.permission } });
  }

  _processControlResponse(raw, emit) {
    // control_response is the user's approval/denial sent to claude stdin
    // Match by request_id to resolve the pending permission
    const requestId = raw.response?.request_id;
    if (!requestId) return;
    const approved = raw.response?.response?.behavior === 'allow';
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.permission?.requestId === requestId) {
        m.permission.resolved = approved ? 'allowed' : 'denied';
        if (emit) this._emit({ op: 'edit', id: m.id, fields: { permission: m.permission } });
        break;
      }
    }
  }

  _processControlCancel(raw, emit) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.permission?.requestId === raw.request_id) {
        m.permission.resolved = 'denied';
        if (emit) this._emit({ op: 'edit', id: m.id, fields: { permission: m.permission } });
        break;
      }
    }
  }
}

module.exports = { MessageManager };
