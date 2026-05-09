/**
 * CodexMessageManager — converts Codex app-server/session JSONL records into
 * the WebUI's normalized message shape.
 *
 * Input records are expected to look like Codex session JSONL entries:
 *   { timestamp, type: 'session_meta' | 'turn_context' | 'response_item' | 'event_msg' | ... , payload }
 *
 * Live wrapper-only records are also supported:
 *   - wrapper_meta
 *   - server_request
 *   - server_request_resolved
 */

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function toTs(value) {
  if (!value) return Date.now();
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : Date.now();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function oneLine(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function formatToolName(name) {
  if (!name) return 'Tool';
  if (name === 'spawn_agent') return 'Agent';
  if (name === 'exec_command') return 'Bash';
  if (name === 'apply_patch') return 'Patch';
  if (name === 'write_stdin') return 'Terminal';
  if (name === 'wait_agent') return 'Agent Wait';
  if (name === 'send_input') return 'Agent Input';
  if (name === 'resume_agent') return 'Agent Resume';
  if (name === 'close_agent') return 'Agent Close';
  return String(name);
}

function flattenContentText(content) {
  return asArray(content).map((item) => item?.text || item?.content || item?.message || '').join('');
}

function normalizeUserInputAnswers(rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    if (Array.isArray(value)) {
      normalized[key] = { answers: value.map((entry) => String(entry)) };
    } else if (value && typeof value === 'object' && Array.isArray(value.answers)) {
      normalized[key] = { answers: value.answers.map((entry) => String(entry)) };
    }
  }
  return Object.keys(normalized).length ? normalized : null;
}

function isAllowedServerDecision(decision) {
  if (!decision) return false;
  if (typeof decision === 'string') {
    return decision === 'approved'
      || decision === 'approved_for_session'
      || decision === 'accept'
      || decision === 'acceptForSession'
      || decision === 'acceptWithExecpolicyAmendment';
  }
  return !!(decision && typeof decision === 'object' && decision.acceptWithExecpolicyAmendment);
}

function mergeToolInput(existingInput, extraInput) {
  if (extraInput == null) return existingInput;
  if (existingInput == null) return extraInput;
  if (
    existingInput
    && extraInput
    && typeof existingInput === 'object'
    && typeof extraInput === 'object'
    && !Array.isArray(existingInput)
    && !Array.isArray(extraInput)
  ) {
    return { ...existingInput, ...extraInput };
  }
  return extraInput;
}

class CodexMessageManager {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.seq = 0;
    this.messages = [];
    this.messageIndex = new Map();
    this.userMessageIds = new Map();
    this.pendingToolCalls = new Map();
    this.toolCallMessageIds = new Map();
    this.pendingApprovals = new Map();
    this.streamingAgentMessages = new Map();
    this.streamingReasoningMessages = new Map();
    this.listeners = [];
    this.turnIndex = 0;
    this._currentTurnId = null;
    this._currentTs = Date.now();
    this._status = {
      model: '',
      permissionMode: '',
      permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
      contextWindow: 0,
      lastUsage: null,
      total_cost_usd: 0,
      subagentMetas: [],
    };
  }

  _nextId() { return `${this.sessionId}:${this.seq++}`; }

  onOp(fn) { this.listeners.push(fn); }
  offOp(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
  _emit(op) { for (const fn of this.listeners) fn(op); }

  get total() { return this.messages.length; }
  get(id) { return this.messageIndex.get(id); }
  tail(n) { return this.messages.slice(-n); }
  slice(offset, limit) { return this.messages.slice(offset, offset + limit); }

  turnMap() {
    const turns = [];
    let lastTurn = -1;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const turnIndex = m.turnIndex ?? 0;
      if (turnIndex === lastTurn) continue;
      const entry = { turnIndex, startIdx: i, ts: m.ts, role: m.role };
      if (m.role === 'user') {
        const raw = (m.content || []).map((b) => b.text || '').join('').trim();
        if (raw) entry.preview = raw.length > 10 ? `${raw.slice(0, 10)}…` : raw;
      }
      turns.push(entry);
      lastTurn = turnIndex;
    }
    return turns;
  }

  search(query) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const matches = [];
    for (let i = 0; i < this.messages.length; i++) {
      const text = this._extractText(this.messages[i]);
      if (text.toLowerCase().includes(q)) {
        matches.push({ index: i, id: this.messages[i].id, type: this.messages[i].role, preview: text.slice(0, 120) });
      }
    }
    return matches;
  }

  status() {
    return { ...this._status };
  }

  convertHistory(records) {
    for (const record of records || []) this._processRecord(record, false);
    this._finalizeStreaming(false, { includeReasoning: true });
    return this.messages;
  }

  processLive(record) {
    this._processRecord(record, true);
  }

  _extractText(msg) {
    return asArray(msg.content).map((block) => {
      if (block.type === 'text' || block.type === 'thinking' || block.type === 'system_info') return block.text || '';
      if (block.type === 'tool_call') return `${block.toolName || ''} ${JSON.stringify(block.input || {})}`;
      if (block.type === 'tool_result') return `${block.toolName || ''} ${block.output || ''}`;
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
      backendMeta: fields.backendMeta || null,
    };
    this.messages.push(msg);
    this.messageIndex.set(msg.id, msg);
    return msg;
  }

  _finalizeStreaming(emit, { includeReasoning = false } = {}) {
    for (const m of this.messages) {
      if (m.status === 'streaming') {
        // Only finalize reasoning if explicitly asked (e.g. turn end)
        if (!includeReasoning && m.content?.[0]?.type === 'thinking') continue;
        m.status = 'complete';
        if (emit) this._emit({ op: 'edit', id: m.id, fields: { status: 'complete' } });
      }
    }
    this.streamingAgentMessages.clear();
    if (includeReasoning) this.streamingReasoningMessages.clear();
  }

  _processRecord(record, emit) {
    if (!record || typeof record !== 'object') return;
    this._currentTs = toTs(record.timestamp);
    if (record.type === 'turn_context') {
      this._processTurnContext(record, emit);
      return;
    }
    if (record.type === 'session_meta') {
      this._processSessionMeta(record, emit);
      return;
    }
    if (record.type === 'wrapper_meta') {
      this._processWrapperMeta(record, emit);
      return;
    }
    if (record.type === 'response_item') {
      this._processResponseItem(record.payload || {}, emit);
      return;
    }
    if (record.type === 'event_msg') {
      this._processEvent(record.payload || {}, emit);
      return;
    }
    if (record.type === 'server_request') {
      this._processServerRequest(record.payload || {}, emit);
      return;
    }
    if (record.type === 'server_request_resolved') {
      this._processServerRequestResolved(record.payload || {}, emit);
    }
  }

  _processSessionMeta(record, emit) {
    const payload = record.payload || {};
    if (!this._status.model && payload.model) this._status.model = payload.model;
    if (payload.model_provider) this._status.modelProvider = payload.model_provider;
    if (payload.permissionMode) this._status.permissionMode = payload.permissionMode;
    if (emit && !this._seenInit) {
      this._seenInit = true;
      const msg = this._create({
        role: 'system',
        content: [{
          type: 'system_info',
          text: `Model: ${payload.model || 'unknown'}`,
          initData: {
            model: payload.model || '',
            permissionMode: this._status.permissionMode || '',
            slashCommands: [],
          },
        }],
      });
      this._emit({ op: 'create', message: msg });
    }
  }

  _processTurnContext(record, emit) {
    const payload = record.payload || {};
    const turnId = payload.turn_id || payload.turnId || null;
    if (turnId && turnId !== this._currentTurnId) {
      this._currentTurnId = turnId;
      this.turnIndex++;
    }
    if (payload.model) this._status.model = payload.model;
    if (payload.approval_policy || payload.approvalPolicy || payload.permissionMode) {
      this._status.permissionMode = payload.permissionMode || payload.approval_policy || payload.approvalPolicy;
    }
    if (payload.model_context_window || payload.modelContextWindow) {
      this._status.contextWindow = payload.model_context_window || payload.modelContextWindow;
    }
    if (emit && !this._seenInit) {
      this._seenInit = true;
      const msg = this._create({
        role: 'system',
        content: [{
          type: 'system_info',
          text: `Model: ${this._status.model || 'unknown'}`,
          initData: {
            model: this._status.model || '',
            permissionMode: this._status.permissionMode || '',
            slashCommands: [],
          },
        }],
      });
      this._emit({ op: 'create', message: msg });
    }
  }

  _processWrapperMeta(record, emit) {
    const payload = record.payload || {};
    if (payload.model) this._status.model = payload.model;
    if (payload.permissionMode) this._status.permissionMode = payload.permissionMode;
    if (payload.contextWindow) this._status.contextWindow = payload.contextWindow;
    if (emit && !this._seenInit && (payload.model || payload.permissionMode)) {
      this._seenInit = true;
      const msg = this._create({
        role: 'system',
        content: [{
          type: 'system_info',
          text: `Model: ${payload.model || 'unknown'}`,
          initData: {
            model: payload.model || '',
            permissionMode: payload.permissionMode || '',
            slashCommands: [],
          },
        }],
      });
      this._emit({ op: 'create', message: msg });
    }
  }

  _processResponseItem(item, emit) {
    const type = item.type;
    if (type === 'message') return this._processResponseMessage(item, emit);
    if (type === 'function_call') return this._processFunctionCall(item, emit);
    if (type === 'custom_tool_call') return this._processCustomToolCall(item, emit);
    if (type === 'function_call_output') return this._processFunctionCallOutput(item, emit);
    if (type === 'reasoning') return this._processReasoningItem(item, emit);
  }

  _processResponseMessage(item, emit) {
    const role = item.role;
    if (role === 'user') {
      const content = [];
      for (const block of asArray(item.content)) {
        if (block.type === 'input_text') content.push({ type: 'text', text: block.text || '' });
        if (block.type === 'input_image' && block.image_url) {
          const match = /^data:([^;,]+);base64,(.+)$/.exec(block.image_url);
          if (match) content.push({ type: 'image', mediaType: match[1], data: match[2] });
        }
      }
      if (!content.length) return;
      const webuiMsgId = item.webui_msg_id || item.webuiMsgId || item.client_msg_id || item.clientMsgId || null;
      this._finalizeStreaming(emit);
      if (webuiMsgId) {
        const existingId = this.userMessageIds.get(String(webuiMsgId));
        const existing = existingId ? this.messageIndex.get(existingId) : null;
        if (existing) {
          existing.content = content;
          existing.status = 'complete';
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content, status: 'complete' } });
          return;
        }
      }
      this.turnIndex++;
      const msg = this._create({ role: 'user', content, turnIndex: this.turnIndex });
      if (webuiMsgId) this.userMessageIds.set(String(webuiMsgId), msg.id);
      if (emit) this._emit({ op: 'create', message: msg });
      return;
    }

    if (role === 'assistant') {
      const text = asArray(item.content).filter((block) => block.type === 'output_text').map((block) => block.text || '').join('');
      if (!text) return;
      const streamKey = item.item_id || item.itemId || item.phase || this._currentTurnId || 'assistant';
      const existingId = this.streamingAgentMessages.get(streamKey);
      if (existingId) {
        const existing = this.messageIndex.get(existingId);
        if (existing) {
          existing.content = [{ type: 'text', text }];
          existing.status = 'complete';
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content, status: 'complete' } });
          this.streamingAgentMessages.delete(streamKey);
          return;
        }
      }
      const msg = this._create({
        role: 'assistant',
        status: 'complete',
        content: [{ type: 'text', text }],
        backendMeta: { phase: item.phase || null },
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }
  }

  _processReasoningItem(item, emit) {
    const summaryText = flattenContentText(item.summary) || flattenContentText(item.content);
    if (!summaryText) return;
    // If a streaming reasoning message exists for this item, finalize it
    // instead of creating a duplicate.
    const itemId = item.item_id || item.id;
    if (itemId) {
      const existingId = this.streamingReasoningMessages.get(itemId);
      if (existingId) {
        const existing = this.messageIndex.get(existingId);
        if (existing) {
          existing.content = [{ type: 'thinking', text: summaryText }];
          existing.status = 'complete';
          this.streamingReasoningMessages.delete(itemId);
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content, status: 'complete' } });
          return;
        }
      }
    }
    const msg = this._create({ role: 'assistant', content: [{ type: 'thinking', text: summaryText }] });
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _processFunctionCall(item, emit) {
    const toolCallId = item.call_id || item.callId || this._nextId();
    const parsedInput = safeJsonParse(item.arguments, item.arguments);
    const toolName = formatToolName(item.name || 'tool');
    const msg = this._create({
      role: 'tool',
      status: 'pending',
      content: [{ type: 'tool_call', toolCallId, toolName, input: parsedInput }],
      toolCallId,
      toolName,
      toolStatus: null,
    });
    this.pendingToolCalls.set(toolCallId, { msgId: msg.id, rawName: item.name || toolName });
    this.toolCallMessageIds.set(toolCallId, msg.id);
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _processCustomToolCall(item, emit) {
    const toolCallId = item.call_id || item.callId || this._nextId();
    const rawInput = item.input ?? item.arguments ?? '';
    const parsedInput = item.name === 'apply_patch'
      ? { patch: typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput ?? '') }
      : safeJsonParse(rawInput, rawInput);
    const toolName = formatToolName(item.name || 'tool');
    const msg = this._create({
      role: 'tool',
      status: 'pending',
      content: [{ type: 'tool_call', toolCallId, toolName, input: parsedInput }],
      toolCallId,
      toolName,
      toolStatus: null,
    });
    this.pendingToolCalls.set(toolCallId, { msgId: msg.id, rawName: item.name || toolName });
    this.toolCallMessageIds.set(toolCallId, msg.id);
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _finalizeToolCall(toolCallId, { output, isError, extraInput = null, rawName = 'tool' }, emit) {
    const pending = this.pendingToolCalls.get(toolCallId);
    const msgId = pending?.msgId || this.toolCallMessageIds.get(toolCallId);
    const toolName = formatToolName(pending?.rawName || rawName || 'tool');
    const nextStatus = isError ? 'error' : 'complete';
    const nextToolStatus = isError ? 'error' : 'ok';

    if (!msgId) {
      const msg = this._create({
        role: 'tool',
        status: nextStatus,
        content: [{
          type: 'tool_result',
          toolCallId,
          toolName,
          input: extraInput || {},
          output: typeof output === 'string' ? output : '',
          status: isError ? 'error' : 'ok',
        }],
        toolCallId,
        toolName,
        toolStatus: nextToolStatus,
      });
      this.toolCallMessageIds.set(toolCallId, msg.id);
      if (emit) this._emit({ op: 'create', message: msg });
      this.pendingToolCalls.delete(toolCallId);
      return;
    }

    const existing = this.messageIndex.get(msgId);
    if (!existing) {
      this.pendingToolCalls.delete(toolCallId);
      return;
    }

    const currentBlock = existing.content?.[0] || {};
    const nextInput = mergeToolInput(currentBlock.input, extraInput);
    const nextOutput = (typeof output === 'string' && output.length > 0)
      ? output
      : (currentBlock.output || '');
    existing.status = nextStatus;
    existing.toolStatus = nextToolStatus;
    existing.content = [{
      type: 'tool_result',
      toolCallId,
      toolName: existing.toolName || toolName,
      input: nextInput,
      output: nextOutput,
      status: isError ? 'error' : 'ok',
    }];
    if (emit) {
      this._emit({
        op: 'edit',
        id: existing.id,
        fields: { status: existing.status, toolStatus: existing.toolStatus, content: existing.content },
      });
    }
    this.pendingToolCalls.delete(toolCallId);
  }

  _processFunctionCallOutput(item, emit) {
    const toolCallId = item.call_id || item.callId;
    if (!toolCallId) return;
    const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
    const isError = !!item.is_error || !!item.error;
    this._finalizeToolCall(toolCallId, { output, isError }, emit);
  }

  _processEvent(event, emit) {
    const type = event.type;
    if (!type) return;

    if (type === 'task_started') {
      if (event.turn_id || event.turnId) {
        const turnId = event.turn_id || event.turnId;
        if (turnId !== this._currentTurnId) {
          this._currentTurnId = turnId;
          this.turnIndex++;
        }
      }
      if (event.model_context_window) this._status.contextWindow = event.model_context_window;
      return;
    }

    if (type === 'task_complete' || type === 'turn_aborted' || type === 'task_failed') {
      this._finalizeStreaming(emit, { includeReasoning: true });
      if (type === 'task_failed') {
        const msg = this._create({
          role: 'system',
          status: 'error',
          content: [{ type: 'system_info', text: event.error ? `Error: ${event.error}` : 'Error' }],
        });
        if (emit) this._emit({ op: 'create', message: msg });
      } else if (type === 'turn_aborted') {
        const msg = this._create({
          role: 'system',
          status: 'interrupted',
          content: [{ type: 'system_info', text: 'Interrupted' }],
        });
        if (emit) this._emit({ op: 'create', message: msg });
      }
      if (emit) this._emit({ op: 'meta', subtype: 'turn_complete', data: { cost: 0, modelUsage: null } });
      return;
    }

    if (type === 'token_count') {
      const info = event.info || {};
      const last = info.last_token_usage || info.lastTokenUsage || info.total_token_usage || null;
      const contextWindow = info.model_context_window || info.modelContextWindow || 0;
      if (last) this._status.lastUsage = {
        input_tokens: last.input_tokens || last.inputTokens || 0,
        cache_read_input_tokens: last.cached_input_tokens || last.cache_read_input_tokens || last.cachedInputTokens || 0,
        cache_creation_input_tokens: last.cache_creation_input_tokens || last.cacheCreationInputTokens || 0,
      };
      if (contextWindow) this._status.contextWindow = contextWindow;
      if (emit && this._status.lastUsage) this._emit({ op: 'meta', subtype: 'usage', data: this._status.lastUsage });
      return;
    }

    if (type === 'agent_message_delta') {
      const streamKey = event.item_id || event.itemId || event.phase || this._currentTurnId || 'assistant';
      const delta = event.delta || '';
      if (!delta) return;
      const existingId = this.streamingAgentMessages.get(streamKey);
      if (existingId) {
        const existing = this.messageIndex.get(existingId);
        if (!existing) return;
        const prev = existing.content?.[0]?.text || '';
        existing.content = [{ type: 'text', text: prev + delta }];
        existing.status = 'streaming';
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content } });
      } else {
        this._finalizeStreaming(emit);
        const msg = this._create({
          role: 'assistant',
          status: 'streaming',
          content: [{ type: 'text', text: delta }],
          backendMeta: { phase: event.phase || null },
        });
        this.streamingAgentMessages.set(streamKey, msg.id);
        if (emit) this._emit({ op: 'create', message: msg });
      }
      return;
    }

    if (type === 'agent_reasoning_delta') {
      const streamKey = event.item_id || event.itemId || this._currentTurnId || 'reasoning';
      const delta = event.delta || '';
      if (!delta) return;
      const existingId = this.streamingReasoningMessages.get(streamKey);
      if (existingId) {
        const existing = this.messageIndex.get(existingId);
        if (!existing) return;
        const prev = existing.content?.[0]?.text || '';
        existing.content = [{ type: 'thinking', text: prev + delta }];
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content } });
      } else {
        const msg = this._create({
          role: 'assistant',
          status: 'streaming',
          content: [{ type: 'thinking', text: delta }],
        });
        this.streamingReasoningMessages.set(streamKey, msg.id);
        if (emit) this._emit({ op: 'create', message: msg });
      }
      return;
    }

    if (type === 'collab_agent_begin') {
      const callId = event.call_id || event.callId || event.item_id || event.itemId;
      if (!callId) return;
      const pending = this.pendingToolCalls.get(callId);
      const msgId = pending?.msgId || this.toolCallMessageIds.get(callId);
      const existing = msgId ? this.messageIndex.get(msgId) : null;
      const taskInfo = {
        id: event.task_id || callId,
        type: 'agent',
        description: event.description || event.command || event.reason || formatToolName(event.tool || pending?.rawName || ''),
        status: 'running',
      };
      if (event.command) taskInfo.command = event.command;
      taskInfo.receiverThreadIds = asArray(event.receiver_thread_ids || event.receiverThreadIds);
      taskInfo.agentRole = event.agent_role || event.agentRole || '';
      taskInfo.agentNickname = event.agent_nickname || event.agentNickname || '';
      if (existing) {
        existing.taskInfo = taskInfo;
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { taskInfo } });
      }
      return;
    }

    if (type === 'patch_apply_end' || type === 'collab_agent_end') {
      const callId = event.call_id || event.callId || event.item_id || event.itemId;
      if (!callId) return;
      const pending = this.pendingToolCalls.get(callId);
      if (type === 'patch_apply_end') {
        const output = typeof event.output === 'string'
          ? event.output
          : [event.stdout, event.stderr].filter(Boolean).join('\n');
        this._finalizeToolCall(callId, {
          output,
          isError: event.success === false || !!event.error || event.status === 'failed',
          extraInput: event.changes ? { changes: event.changes } : null,
          rawName: pending?.rawName || 'apply_patch',
        }, emit);
      }
      const msgId = pending?.msgId || this.toolCallMessageIds.get(callId);
      const existing = msgId ? this.messageIndex.get(msgId) : null;
      if (existing?.taskInfo) {
        existing.taskInfo.status = event.success === false || event.error || event.status === 'failed' ? 'failed' : 'completed';
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { taskInfo: existing.taskInfo } });
      }
      return;
    }

    if (type === 'agent_reasoning_section_break') {
      const streamKey = event.item_id || event.itemId || this._currentTurnId || 'reasoning';
      const existingId = this.streamingReasoningMessages.get(streamKey);
      if (!existingId) return;
      const existing = this.messageIndex.get(existingId);
      if (!existing) return;
      const prev = existing.content?.[0]?.text || '';
      if (prev.endsWith('\n\n')) return;
      existing.content = [{ type: 'thinking', text: prev ? `${prev}\n\n` : '' }];
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content } });
      return;
    }

    if (type === 'entered_review_mode' || type === 'exited_review_mode') {
      const text = type === 'entered_review_mode' ? 'Entered review mode' : 'Exited review mode';
      const msg = this._create({ role: 'system', content: [{ type: 'system_info', text }] });
      if (emit) this._emit({ op: 'create', message: msg });
      return;
    }

    if (type === 'review_started') {
      const reviewThreadId = event.review_thread_id || event.reviewThreadId || null;
      const delivery = event.delivery || 'inline';
      const targetType = event.target?.type || event.targetType || 'review';
      const text = delivery === 'detached'
        ? `Detached review started (${targetType})`
        : `Review started (${targetType})`;
      const msg = this._create({
        role: 'system',
        content: [{ type: 'system_info', text }],
        backendMeta: { reviewThreadId, delivery, target: event.target || null },
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }
  }

  _processServerRequest(payload, emit) {
    const requestId = payload.id;
    const method = payload.method || '';
    const params = payload.params || {};
    const itemId = params.itemId || params.item_id || params.approvalId || null;

    const permission = {
      requestId,
      toolName: 'Permission',
      input: params,
      suggestions: params.proposedExecpolicyAmendment || [],
      resolved: null,
      kind: 'approval',
      method,
    };

    if (method === 'item/commandExecution/requestApproval') {
      permission.toolName = 'Bash';
      permission.input = { command: params.command || '', cwd: params.cwd || '', reason: params.reason || '' };
    } else if (method === 'item/fileChange/requestApproval') {
      permission.toolName = 'Patch';
      permission.input = { reason: params.reason || '', grantRoot: params.grantRoot || '' };
    } else if (method === 'item/permissions/requestApproval') {
      permission.toolName = 'Permissions';
    } else if (method === 'item/tool/requestUserInput') {
      permission.toolName = 'User Input';
      permission.kind = 'user_input';
      permission.questions = asArray(params.questions);
    }

    const requestKey = String(requestId);
    const approvalEntry = { itemId, permission, msgId: null };

    let existing = null;
    if (itemId) {
      const pending = this.pendingToolCalls.get(itemId);
      existing = pending ? this.messageIndex.get(pending.msgId) : null;
    }
    if (existing) {
      existing.permission = permission;
      approvalEntry.msgId = existing.id;
      this.pendingApprovals.set(requestKey, approvalEntry);
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { permission } });
      return;
    }

    const msg = this._create({
      role: 'tool',
      status: 'pending',
      content: [{ type: 'tool_call', toolCallId: itemId || String(requestId), toolName: permission.toolName, input: permission.input }],
      toolCallId: itemId || String(requestId),
      toolName: permission.toolName,
      permission,
    });
    approvalEntry.msgId = msg.id;
    this.pendingApprovals.set(requestKey, approvalEntry);
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _processServerRequestResolved(payload, emit) {
    const requestId = String(payload.id);
    const decision = payload.decision || payload.result || 'denied';
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    const answers = normalizeUserInputAnswers(payload.answers);
    pending.permission.resolved = isAllowedServerDecision(decision) ? 'allowed' : 'denied';
    if (answers) pending.permission.answers = answers;

    const itemId = pending.itemId;
    let existing = pending.msgId ? this.messageIndex.get(pending.msgId) : null;
    if (!existing && itemId) {
      const toolPending = this.pendingToolCalls.get(itemId);
      existing = toolPending ? this.messageIndex.get(toolPending.msgId) : null;
    }
    if (existing) {
      existing.permission = pending.permission;
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { permission: existing.permission } });
    }
    this.pendingApprovals.delete(requestId);
  }
}

module.exports = { CodexMessageManager };
