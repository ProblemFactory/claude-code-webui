'use strict';
/**
 * AcpMessageManager — normalizer for the 'acp-events' stream protocol
 * (S8 of docs/design-harness-plugins.md §2.3): converts the records
 * data/bin/acp-wrapper.js journals (one line per ACP v1 notification/request,
 * shape documented at the top of that file) into the WebUI's normalized
 * message shape — the same duck contract MessageManager (claude) and
 * CodexMessageManager honour: onOp/processLive/convertHistory[Async]/tail/
 * slice/turnMap/total/messages/injectPeerCard/taskState/goalState.
 *
 * Mapping (harness-neutral on purpose — the chat view never learns ACP):
 *   update.tool_call            → tool card; collapseKind from ACP ToolKind
 *                                 (read|search→read, edit|delete|move→write,
 *                                 execute→bash, think→thinking, fetch|other→mcp,
 *                                 switch_mode→null = visible)
 *   update.tool_call_update     → status/content edits on that card (diff
 *                                 content becomes Edit-style old/new input)
 *   update.agent_message_chunk  → streaming assistant text (per messageId)
 *   update.agent_thought_chunk  → streaming thinking block (per messageId)
 *   update.user_message_chunk   → user message (session/load replay; a live
 *                                 echo of the wrapper's own `user` record is
 *                                 deduped by text)
 *   update.plan                 → todos meta (same shape as TodoWrite)
 *   update.available_commands_update → slash commands on the init card
 *   update.usage_update         → usage meta (used/size → context%)
 *   permission_request          → the harness-neutral permission card
 *                                 (ordered options with kinds) on the tool card
 *   permission_resolved         → allowed/denied on that card
 *   session/config              → init card + status (model/mode/modes/models)
 *   prompt_end                  → finalize streams; cancelled → Interrupted,
 *                                 refusal/max_* → notice, error → error card
 *   notice                      → system card (level error → error status)
 *
 * Also exports AcpSessionMessages — the store-side reader (raw/tail/slice/
 * wrapperMeta/chatStatus/taskState/isStreaming) over the live buffer: an ACP
 * agent exposes NO transcript read API, so the wrapper's journal IS the
 * history (session/load replays the agent's own history into it on resume).
 */

const { peerDisplayName } = require('./message-manager');
const fs = require('fs');
const path = require('path');

function asArray(v) { return Array.isArray(v) ? v : []; }
function toTs(value) {
  if (!value) return Date.now();
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : Date.now();
}
function parseAcpBufferRecords(buffer) {
  const out = [];
  for (const line of String(buffer || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const r = JSON.parse(t); if (r && typeof r === 'object') out.push(r); } catch {}
  }
  return out;
}

/** ACP ToolKind → the chat view's semantic fold kinds (chat.collapseKinds vocabulary). */
function collapseKindOf(kind) {
  switch (String(kind || 'other')) {
    case 'read': return 'read';
    case 'search': return 'search';
    case 'edit': case 'delete': case 'move': return 'write';
    case 'execute': return 'bash';
    case 'think': return 'thinking';
    case 'switch_mode': return null;          // deliberately visible
    case 'fetch': case 'other': default: return 'mcp';
  }
}
/** ACP ToolKind → the toolName the renderer keys its cards on. */
function toolNameOf(kind) {
  switch (String(kind || 'other')) {
    case 'read': return 'Read';
    case 'edit': return 'Edit';
    case 'delete': return 'Delete';
    case 'move': return 'Move';
    case 'search': return 'Search';
    case 'execute': return 'Bash';
    case 'think': return 'Think';
    case 'fetch': return 'Fetch';
    case 'switch_mode': return 'Mode';
    default: return 'Tool';
  }
}
function contentText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text') return String(block.text || '');
  if (block.type === 'image') return `[image ${block.mimeType || ''}]`;
  if (block.type === 'audio') return `[audio ${block.mimeType || ''}]`;
  if (block.type === 'resource') return String(block.resource?.text || `[resource ${block.resource?.uri || ''}]`);
  if (block.type === 'resource_link') return `[${block.name || block.uri || 'resource'}]`;
  return '';
}
/** ToolCallContent[] → {output, diff|null} */
function toolContentOf(list) {
  const parts = [];
  let diff = null;
  for (const c of asArray(list)) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content') parts.push(contentText(c.content));
    else if (c.type === 'diff') { if (!diff) diff = { path: c.path || '', oldText: c.oldText ?? '', newText: c.newText ?? '' }; parts.push(`${c.path || ''}`); }
    else if (c.type === 'terminal') parts.push(`[terminal ${c.terminalId || ''}]`);
  }
  return { output: parts.filter(Boolean).join('\n'), diff };
}
function inputOf(tc) {
  const raw = tc?.rawInput && typeof tc.rawInput === 'object' && !Array.isArray(tc.rawInput) ? { ...tc.rawInput } : (tc?.rawInput != null ? { input: tc.rawInput } : {});
  if (tc?.title && raw.title == null) raw.title = tc.title;
  const loc = asArray(tc?.locations)[0];
  if (loc?.path && raw.file_path == null) raw.file_path = loc.path;
  if (asArray(tc?.locations).length > 1) raw.locations = tc.locations.map((l) => l?.path).filter(Boolean);
  return raw;
}
function flattenSelect(opt) {
  const out = [];
  for (const it of asArray(opt?.options)) {
    if (it && Array.isArray(it.options)) out.push(...it.options.filter(Boolean));
    else if (it) out.push(it);
  }
  return out;
}

class AcpMessageManager {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.seq = 0;
    this._rkCounts = new Map();
    this._currentRk = null;
    this.messages = [];
    this.messageIndex = new Map();
    this.userMessageIds = new Map();      // webui msgId → message id
    this._queue = [];                     // the wrapper's promptQueue, as published
    this._queuedMsgIds = new Set();       // bubbles currently wearing a 'queued' chip
    this._queuePublished = false;         // has this wrapper ever published a queue? (in-band capability signal)
    this._queueVerbs = null;              // …and the verb list that publication named
    this.toolCards = new Map();           // toolCallId → message id
    this.pendingApprovals = new Map();    // requestId → {msgId, permission}
    this.streams = new Map();             // `${kind}:${messageId}` → message id (open agent/thought streams)
    this._userEcho = null;                // {messageId, text, skip, msgId}
    this.listeners = [];
    this.turnIndex = 0;
    this._currentTs = Date.now();
    this._currentLine = null;
    this._status = { model: '', permissionMode: '', permissionModes: [], contextWindow: 0, lastUsage: null, total_cost_usd: 0, slashCommands: [], models: [], agentInfo: null };
    this._initMsgId = null;
    this._seenInit = false;
    this._goalState = null;
    this._lastPromptText = null;
  }

  // Content-derived ids (R0): rebuild reproduces the same ids for the same
  // records — a hash of the record minus its timestamp.
  _nextId() {
    const rk = this._currentRk || ('s' + this.seq);
    this.seq++;
    const n = this._rkCounts.get(rk) || 0;
    this._rkCounts.set(rk, n + 1);
    return `${this.sessionId}:${rk}${n ? '.' + n : ''}`;
  }
  static recordKey(record) {
    const { ts, ...stable } = record || {};
    let str;
    try { str = JSON.stringify(stable); } catch { str = String(record?.kind || ''); }
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return 'h:' + h.toString(36) + ':' + str.length;
  }

  onOp(fn) { this.listeners.push(fn); }
  offOp(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
  _emit(op) { for (const fn of this.listeners) fn(op); }

  get total() { return this.messages.length; }
  get(id) { return this.messageIndex.get(id); }
  tail(n) { return this.messages.slice(-n); }
  slice(offset, limit) { return this.messages.slice(offset, offset + limit); }
  status() { return { ...this._status }; }
  goalState() { return this._goalState; }      // ACP has no goal loop (stub — the status bar shows nothing)
  queueState() { return this._queue || []; }   // the input queue (attach payload)
  queuePublished() { return !!this._queuePublished; } // the RUNNING wrapper publishes a queue (pairs with sidecar caps.inputQueue)
  queueVerbsPublished() { return this._queueVerbs || null; } // …and WHICH verbs it named (null = a pre-verb-table wrapper); the only advert a remote session has
  taskState() {
    return { tasks: {}, todos: Array.isArray(this._todos) ? this._todos : [] };
  }

  turnMap() {
    const turns = [];
    let last = -1;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const ti = m.turnIndex ?? 0;
      if (ti === last) continue;
      const entry = { turnIndex: ti, startIdx: i, ts: m.ts, role: m.role };
      if (m.role === 'user') {
        const raw = (m.content || []).map((b) => b.text || '').join('').trim();
        if (raw) entry.preview = raw.length > 10 ? `${raw.slice(0, 10)}…` : raw;
      }
      turns.push(entry);
      last = ti;
    }
    return turns;
  }

  search(query) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const out = [];
    for (let i = 0; i < this.messages.length; i++) {
      const text = this._extractText(this.messages[i]);
      if (text.toLowerCase().includes(q)) out.push({ index: i, id: this.messages[i].id, type: this.messages[i].role, preview: text.slice(0, 120) });
    }
    return out;
  }
  _extractText(msg) {
    return asArray(msg.content).map((b) => {
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'system_info') return b.text || '';
      if (b.type === 'tool_call') return `${b.toolName || ''} ${JSON.stringify(b.input || {})}`;
      if (b.type === 'tool_result') return `${b.toolName || ''} ${b.output || ''}`;
      return '';
    }).join(' ');
  }

  /** Server-side peer card (same shape as the claude/codex twins). */
  injectPeerCard({ fromName, text }) {
    const body = String(text || '').trim();
    if (!body) return null;
    this._currentRk = null;
    this._currentTs = Date.now();
    this._currentLine = null;
    this.turnIndex++;
    const msg = this._create({ role: 'user', status: 'complete', content: [{ type: 'text', text: body }], turnIndex: this.turnIndex });
    msg.originKind = 'peer-message';
    msg.peerFrom = fromName ? String(fromName) : null;
    this._emit({ op: 'create', message: msg });
    return msg;
  }

  convertHistory(records) {
    for (const r of records || []) this._processRecord(r, false);
    this._finalizeStreaming(false);
    return this.messages;
  }
  /** Time-sliced twin (same shape as MessageManager.convertHistoryAsync). */
  async convertHistoryAsync(records, { budgetMs = 25, onSlice } = {}) {
    let sliceStart = Date.now(), done = 0;
    for (const r of records || []) {
      try { this._processRecord(r, false); }
      catch (e) { console.error('[acp-normalizer] record skipped during history rebuild:', e.message); }
      done++;
      if (Date.now() - sliceStart >= budgetMs) {
        try { onSlice?.(done); } catch { }
        await new Promise((res) => setImmediate(res));
        sliceStart = Date.now();
      }
    }
    this._finalizeStreaming(false);
    return this.messages;
  }
  processLive(record) { this._processRecord(record, true); }

  _create(fields) {
    const msg = {
      id: this._nextId(),
      role: fields.role,
      status: fields.status || 'complete',
      content: fields.content || [],
      ts: fields.ts || this._currentTs || Date.now(),
      srcLine: this._currentLine,
      turnIndex: fields.turnIndex ?? this.turnIndex,
      toolCallId: fields.toolCallId || null,
      toolName: fields.toolName || null,
      toolStatus: fields.toolStatus || null,
      permission: fields.permission || null,
      usage: fields.usage || null,
      taskInfo: fields.taskInfo || null,
      backendMeta: fields.backendMeta || null,
      collapseKind: fields.collapseKind || null,
      noticeKind: fields.noticeKind || null,
    };
    this.messages.push(msg);
    this.messageIndex.set(msg.id, msg);
    return msg;
  }

  _finalizeStreaming(emit) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && m.originKind !== 'peer-message') break;
      if (m.status === 'streaming') {
        m.status = 'complete';
        if (emit) this._emit({ op: 'edit', id: m.id, fields: { status: 'complete' } });
      }
    }
    this.streams.clear();
    this._userEcho = null;
  }
  _closeStreams(kindPrefix, emit) {
    for (const [key, id] of [...this.streams]) {
      if (kindPrefix && !key.startsWith(kindPrefix)) continue;
      const m = this.messageIndex.get(id);
      if (m && m.status === 'streaming') { m.status = 'complete'; if (emit) this._emit({ op: 'edit', id: m.id, fields: { status: 'complete' } }); }
      this.streams.delete(key);
    }
  }

  _processRecord(record, emit) {
    if (!record || typeof record !== 'object') return;
    this._currentRk = AcpMessageManager.recordKey(record);
    this._currentTs = toTs(record.ts || record.timestamp);
    this._currentLine = Number.isFinite(record.__line) ? record.__line : null;
    // the ws-handler echoes its own permission-response frame into the stream
    if (record.type === 'permission-response') { this._resolvePermission(String(record.requestId), record.approved ? 'allowed' : 'denied', emit, record.optionId || null); return; }
    if (record.type !== 'acp') return;
    switch (record.kind) {
      case 'session': return this._processSession(record, emit);
      case 'config': return this._processConfig(record, emit);
      case 'user': return this._processUser(record, emit);
      case 'prompt_start': return;
      case 'prompt_end': return this._processPromptEnd(record, emit);
      case 'update': return this._processUpdate(record.update || {}, emit, !!record.replay);
      case 'permission_request': return this._processPermissionRequest(record, emit);
      case 'permission_resolved': return this._resolvePermission(String(record.requestId), record.outcome === 'selected' && /^allow/.test(record.optionKind || '') ? 'allowed' : 'denied', emit, record.optionId || null);
      case 'queued_input': {
        // The chip on the bubble IS the notice (codex parity); the card is the
        // fallback for a queued entry with no bubble of its own — and for a
        // wrapper that publishes NO queue (pre-release process), whose chip
        // could never clear or be acted on.
        if (this._queuePublished && this._stampQueueChip(record.msg_id || record.msgId, 'queued', emit)) return;
        const msg = this._create({ role: 'system', content: [{ type: 'system_info', text: 'Queued — runs after the current turn' }], noticeKind: 'notice' });
        if (emit) this._emit({ op: 'create', message: msg });
        return;
      }
      case 'queue_changed': return this._processQueueChanged(record, emit);
      case 'queue_op_result': return this._processQueueOpResult(record, emit);
      case 'notice': return this._processNotice(record, emit);
      default: return; // client_request / notification / peer_result: journal-only
    }
  }

  /** Stamp the queue chip on the bubble a queued message belongs to; false
   *  when there is no such bubble (a peer/nudge entry carries no msgId). */
  _stampQueueChip(msgId, state, emit) {
    if (!msgId) return false;
    const id = this.userMessageIds.get(String(msgId));
    const msg = id ? this.messageIndex.get(id) : null;
    if (!msg) return false;
    if (msg.queueState === state) return true;
    msg.queueState = state;
    if (state === 'queued') this._queuedMsgIds.add(String(msgId)); else this._queuedMsgIds.delete(String(msgId));
    if (emit) this._emit({ op: 'edit', id: msg.id, fields: { queueState: state } });
    return true;
  }

  _processQueueChanged(rec, emit) {
    const items = Array.isArray(rec.items) ? rec.items : [];
    this._queue = items;
    this._queuePublished = true;
    if (Array.isArray(rec.verbs)) this._queueVerbs = rec.verbs.map((v) => String(v));
    const live = new Set(items.map((it) => String(it.msgId || '')).filter(Boolean));
    for (const it of items) this._stampQueueChip(it.msgId, 'queued', emit);
    for (const msgId of [...this._queuedMsgIds]) if (!live.has(msgId)) this._stampQueueChip(msgId, null, emit);
    if (emit) this._emit({ op: 'meta', subtype: 'queue', items, supported: true, verbs: this._queueVerbs || null });
  }

  /** Same contract as the codex normalizer: a `meta` op for the strip (so a
   *  pending row always ends), a chip transition only for the verbs that
   *  change what a bubble MEANS, and a visible card for every failure.
   *  The sentences are this harness's own — "cannot steer" here is a property
   *  of ACP v1, not of a turn kind — so they stay next to the wrapper that
   *  produces the reasons rather than sharing codex's switch. */
  _processQueueOpResult(rec, emit) {
    const ok = rec.ok !== false;
    const text = ok ? '' : AcpMessageManager.queueOpFailureText(rec);
    // …with an empty id for a verb that names no item (the codex twin's rule).
    if (emit) this._emit({ op: 'meta', subtype: 'queue-result', queueOp: rec.op, id: String(rec.id || ''), ok, reason: rec.reason || null, text: text || null });
    if (ok) {
      // 'reorder'/'edit' leave the bubble a queued message of yours — only a
      // removal changes what it means. (ACP has no steer.)
      if (rec.op === 'remove') this._stampQueueChip(rec.msg_id || rec.msgId, 'removed', emit);
      return;
    }
    const msg = this._create({ role: 'system', content: [{ type: 'system_info', text }], noticeKind: 'notice' });
    if (emit) this._emit({ op: 'create', message: msg });
  }

  /** PURE: the sentence for a failed ACP queue op (every branch says what is
   *  true for the message NOW). */
  static queueOpFailureText(rec) {
    switch (rec.reason) {
      case 'gone': return 'That message is no longer queued — it already ran.';
      case 'not-steerable': return 'This agent cannot steer a running turn — the message runs when this turn ends.';
      case 'not-startable': return 'This agent runs one prompt at a time — the queued message starts as soon as the current one ends.';
      case 'not-editable': return 'That message is not yours to rewrite — you can remove it instead.';
      case 'anchor-gone': return 'The message it was dropped after is no longer queued — nothing was moved.';
      case 'empty-text': return 'An edited message needs some text — remove it instead.';
      case 'unknown-op': return `Unsupported queue action "${rec.op}".`;
      default: {
        const what = rec.op === 'remove' ? 'remove' : rec.op === 'reorder' ? 'move' : rec.op === 'edit' ? 'edit' : 'steer';
        return `Could not ${what} the queued message${rec.detail ? `: ${rec.detail}` : ''}.`;
      }
    }
  }

  _ensureInit(emit, source) {
    if (this._seenInit) return;
    if (!emit) return; // the init card is a LIVE artefact (attach status carries the same facts)
    this._seenInit = true;
    const msg = this._create({
      role: 'system',
      content: [{
        type: 'system_info',
        text: `Model: ${this._status.model || 'unknown'}`,
        initData: { model: this._status.model || '', permissionMode: this._status.permissionMode || '', slashCommands: this._status.slashCommands || [], source },
      }],
    });
    this._initMsgId = msg.id;
    this._emit({ op: 'create', message: msg });
  }
  _patchInit(emit) {
    const init = this._initMsgId ? this.messageIndex.get(this._initMsgId) : null;
    const d = init?.content?.[0]?.initData;
    if (!d) return;
    d.model = this._status.model || '';
    d.permissionMode = this._status.permissionMode || '';
    d.slashCommands = this._status.slashCommands || [];
    init.content[0].text = `Model: ${this._status.model || 'unknown'}`;
    if (emit) this._emit({ op: 'edit', id: init.id, fields: { content: init.content } });
  }
  _applyConfig(rec) {
    if (rec.model != null) this._status.model = String(rec.model || '');
    if (rec.mode != null) this._status.permissionMode = String(rec.mode || '');
    if (Array.isArray(rec.modeValues)) this._status.permissionModes = rec.modeValues.map(String);
    else if (Array.isArray(rec.configOptions)) {
      const modeOpt = rec.configOptions.find((o) => o && (o.category === 'mode' || o.id === 'mode'));
      if (modeOpt) this._status.permissionModes = flattenSelect(modeOpt).map((o) => String(o.value));
    }
    if (Array.isArray(rec.models)) this._status.models = rec.models.map((m) => ({ id: String(m.id), label: m.label || String(m.id) }));
  }
  _processSession(rec, emit) {
    this._status.agentInfo = rec.agentInfo || null;
    this._status.sessionId = rec.sessionId || null;
    this._applyConfig(rec);
    this._ensureInit(emit, rec.how || 'new');
  }
  _processConfig(rec, emit) {
    const prevModel = this._status.model, prevMode = this._status.permissionMode;
    this._applyConfig(rec);
    if (this._seenInit && (prevModel !== this._status.model || prevMode !== this._status.permissionMode)) this._patchInit(emit);
  }

  _processUser(rec, emit) {
    const content = [];
    for (const b of asArray(rec.content)) {
      if (b?.type === 'text' && b.text) content.push({ type: 'text', text: String(b.text) });
      if (b?.type === 'image' && b.data) content.push({ type: 'image', mediaType: b.mediaType || 'image/png', data: b.data });
    }
    if (!content.length) return;
    const text = content.map((b) => b.text || '').join('\n');
    if (rec.peer) {
      const from = rec.peer.name ? String(rec.peer.name) : peerDisplayName(null, text);
      const body = typeof rec.peer.body === 'string' && rec.peer.body.trim() ? [{ type: 'text', text: rec.peer.body }] : content;
      this.turnIndex++;
      const msg = this._create({ role: 'user', status: 'complete', content: body, turnIndex: this.turnIndex });
      msg.originKind = 'peer-message';
      msg.peerFrom = from;
      this._lastPromptText = text;
      if (emit) this._emit({ op: 'create', message: msg });
      return;
    }
    this._finalizeStreaming(emit);
    const msgId = rec.msgId ? String(rec.msgId) : null;
    if (msgId) {
      const existingId = this.userMessageIds.get(msgId);
      const existing = existingId ? this.messageIndex.get(existingId) : null;
      if (existing) {
        existing.content = content; existing.status = 'complete';
        existing.webuiMsgId = msgId;
        this._lastPromptText = text;
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content, status: 'complete', webuiMsgId: msgId } });
        return;
      }
    }
    this.turnIndex++;
    const msg = this._create({ role: 'user', content, turnIndex: this.turnIndex });
    // The webui msgId rides the MESSAGE (not only the side map): the queue chip
    // joins a rendered bubble to its queue row on the CLIENT, which never sees
    // `userMessageIds`. Same stamp as the codex normalizer.
    if (msgId) { msg.webuiMsgId = msgId; this.userMessageIds.set(msgId, msg.id); }
    this._lastPromptText = text;
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _processPromptEnd(rec, emit) {
    this._finalizeStreaming(emit);
    const reason = rec.stopReason || 'end_turn';
    if (reason === 'cancelled') {
      const msg = this._create({ role: 'system', status: 'interrupted', content: [{ type: 'system_info', text: 'Interrupted' }] });
      if (emit) this._emit({ op: 'create', message: msg });
    } else if (reason === 'error') {
      const msg = this._create({ role: 'system', status: 'error', content: [{ type: 'system_info', text: `Error: ${rec.error?.message || 'prompt failed'}` }] });
      if (emit) this._emit({ op: 'create', message: msg });
    } else if (reason !== 'end_turn') {
      const text = reason === 'refusal' ? 'The agent refused to continue (this prompt and everything after it is dropped from its context)'
        : reason === 'max_tokens' ? 'Stopped: the agent hit its token limit for this turn'
          : reason === 'max_turn_requests' ? 'Stopped: the agent hit its per-turn request limit'
            : `Stopped: ${reason}`;
      const msg = this._create({ role: 'system', content: [{ type: 'system_info', text }], noticeKind: 'notice' });
      if (emit) this._emit({ op: 'create', message: msg });
    }
    if (emit) this._emit({ op: 'meta', subtype: 'turn_complete', data: { cost: 0, modelUsage: null } });
  }

  _processNotice(rec, emit) {
    const text = String(rec.text || '');
    if (!text) return;
    const isErr = rec.level === 'error';
    const msg = this._create({ role: 'system', status: isErr ? 'error' : 'complete', content: [{ type: 'system_info', text: isErr ? `Error: ${text}` : text }], noticeKind: rec.noticeKind || 'notice' });
    if (emit) this._emit({ op: 'create', message: msg });
  }

  // ── session/update variants ──
  _processUpdate(u, emit, replay) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': return this._chunk('text', u, emit);
      case 'agent_thought_chunk': return this._chunk('thinking', u, emit);
      case 'user_message_chunk': return this._userChunk(u, emit, replay);
      case 'tool_call': return this._toolCall(u, emit);
      case 'tool_call_update': return this._toolCallUpdate(u, emit);
      case 'plan': {
        this._todos = asArray(u.entries).map((e) => ({ content: String(e?.content || ''), status: e?.status === 'in_progress' ? 'in_progress' : e?.status === 'completed' ? 'completed' : 'pending' })).filter((t) => t.content);
        if (emit) this._emit({ op: 'meta', subtype: 'todos', data: this._todos });
        return;
      }
      case 'available_commands_update': {
        this._status.slashCommands = asArray(u.availableCommands).map((c) => String(c?.name || '')).filter(Boolean).slice(0, 64);
        this._status.commandDescriptions = Object.fromEntries(asArray(u.availableCommands).filter((c) => c?.name).map((c) => [String(c.name), String(c.description || '')]));
        this._patchInit(emit);
        return;
      }
      case 'usage_update': {
        const used = Number(u.used) || 0, size = Number(u.size) || 0;
        this._status.lastUsage = { input_tokens: used, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        if (size) this._status.contextWindow = size;
        if (u.cost && Number.isFinite(Number(u.cost.amount))) this._status.total_cost_usd = Number(u.cost.amount);
        if (emit) this._emit({ op: 'meta', subtype: 'usage', data: { ...this._status.lastUsage, contextWindow: this._status.contextWindow || 0, totals: null } });
        return;
      }
      case 'current_mode_update': {
        if (u.modeId) { this._status.permissionMode = String(u.modeId); this._patchInit(emit); }
        return;
      }
      case 'config_option_update': {
        const modelOpt = asArray(u.configOptions).find((o) => o && (o.category === 'model' || o.id === 'model'));
        const modeOpt = asArray(u.configOptions).find((o) => o && (o.category === 'mode' || o.id === 'mode'));
        if (modelOpt) { this._status.model = String(modelOpt.currentValue ?? ''); this._status.models = flattenSelect(modelOpt).map((o) => ({ id: String(o.value), label: o.name || String(o.value) })); }
        if (modeOpt) { this._status.permissionMode = String(modeOpt.currentValue ?? ''); this._status.permissionModes = flattenSelect(modeOpt).map((o) => String(o.value)); }
        this._patchInit(emit);
        return;
      }
      // KNOWN, deliberately card-less: the agent renaming its own session
      // ({title, updatedAt} — the 11th and last sessionUpdate variant in the
      // installed opencode's zod union). It is session METADATA, not
      // conversation content, and VibeSpace's session name is the user's (or
      // the sidebar's derived) name — an agent-driven rename is a product
      // decision, not a normalizer one. Kept on _status so a future surface has
      // the fact, named HERE so it never reads as an unknown kind.
      case 'session_info_update': {
        if (u.title) this._status.agentSessionTitle = String(u.title);
        return;
      }
      // UNKNOWN (2.369.58): a bare `default: return` is how a new upstream
      // update kind becomes an invisible product gap — the same class as
      // claude's `cli-unknown-system-subtype` and codex's `codex-unknown-record`
      // (three 0.153.4 rollouts rendered ZERO search cards under one). Name-only
      // telemetry, deduped per process, plus ONE console line per kind so a
      // developer tailing the log sees it too. Add the case, it stops firing.
      default: return this._noteUnknownUpdate(u.sessionUpdate);
    }
  }

  /** Once-per-process breadcrumb for an ACP sessionUpdate kind this normalizer
   *  does not know. Mirrors MessageManager._seenUnknownSubtypes and
   *  CodexMessageManager._noteUnknown — name only, never payload (an update
   *  body can carry user content). */
  _noteUnknownUpdate(kind) {
    const key = String(kind || '(untyped)').slice(0, 48);
    if (AcpMessageManager._seenUnknownUpdates.has(key)) return;
    AcpMessageManager._seenUnknownUpdates.add(key);
    try { global.__vsEvent?.('acp-unknown-update:' + key, 'session/update'); } catch { }
    try { console.warn(`[acp] unhandled sessionUpdate kind "${key}" — dropped (no card). Add a case in acp-message-manager._processUpdate.`); } catch { }
  }

  _chunk(kind, u, emit) {
    const text = contentText(u.content);
    if (!text) return;
    const key = `${kind}:${u.messageId || '-'}`;
    // a kind switch (text ↔ thinking) closes the OTHER open stream so the
    // transcript keeps the agent's order (text, thought, text = 3 cards)
    for (const k of [...this.streams.keys()]) if (!k.startsWith(kind + ':')) this._closeStreams(k.split(':')[0] + ':', emit);
    const existingId = this.streams.get(key);
    const existing = existingId ? this.messageIndex.get(existingId) : null;
    if (existing) {
      const prev = existing.content?.[0]?.text || '';
      existing.content = [{ type: kind, text: prev + text }];
      existing.status = 'streaming';
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content } });
      return;
    }
    if (!u.messageId) this._closeStreams(kind + ':', emit); // no ids: one open stream per kind
    const msg = this._create({ role: 'assistant', status: 'streaming', content: [{ type: kind, text }] });
    this.streams.set(key, msg.id);
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _userChunk(u, emit, replay) {
    const text = contentText(u.content);
    if (!text) return;
    const mid = u.messageId || '-';
    if (this._userEcho && this._userEcho.messageId === mid) {
      if (this._userEcho.skip) return;
      const m = this.messageIndex.get(this._userEcho.msgId);
      if (m) { m.content = [{ type: 'text', text: (m.content?.[0]?.text || '') + text }]; if (emit) this._emit({ op: 'edit', id: m.id, fields: { content: m.content } }); }
      return;
    }
    // live echo of the prompt the wrapper already recorded → skip (by text)
    if (!replay && this._lastPromptText && (this._lastPromptText === text || this._lastPromptText.startsWith(text))) { this._userEcho = { messageId: mid, skip: true }; return; }
    this._finalizeStreaming(emit);
    this.turnIndex++;
    const msg = this._create({ role: 'user', content: [{ type: 'text', text }], turnIndex: this.turnIndex });
    this._userEcho = { messageId: mid, skip: false, msgId: msg.id };
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _toolCall(u, emit) {
    const toolCallId = u.toolCallId || this._nextId();
    this._closeStreams('text:', emit); // text after a tool call starts a new card
    const existingId = this.toolCards.get(toolCallId);
    if (existingId && this.messageIndex.get(existingId)) return this._toolCallUpdate(u, emit);
    const toolName = toolNameOf(u.kind);
    const input = inputOf(u);
    const { output, diff } = toolContentOf(u.content);
    if (diff) Object.assign(input, { file_path: diff.path || input.file_path, old_string: diff.oldText, new_string: diff.newText });
    const done = u.status === 'completed' || u.status === 'failed';
    const msg = this._create({
      role: 'tool',
      status: done ? (u.status === 'failed' ? 'error' : 'complete') : 'pending',
      content: [done
        ? { type: 'tool_result', toolCallId, toolName, input, output, status: u.status === 'failed' ? 'error' : 'ok' }
        : { type: 'tool_call', toolCallId, toolName, input }],
      toolCallId, toolName,
      toolStatus: done ? (u.status === 'failed' ? 'error' : 'ok') : null,
      collapseKind: collapseKindOf(u.kind),
      backendMeta: { acpKind: u.kind || 'other', title: u.title || '', acpStatus: u.status || 'pending' },
    });
    this.toolCards.set(toolCallId, msg.id);
    if (emit) this._emit({ op: 'create', message: msg });
  }
  _toolCallUpdate(u, emit) {
    const toolCallId = u.toolCallId;
    if (!toolCallId) return;
    const msgId = this.toolCards.get(toolCallId);
    const existing = msgId ? this.messageIndex.get(msgId) : null;
    if (!existing) return this._toolCall({ ...u, status: u.status || 'in_progress' }, emit);
    const block = existing.content?.[0] || {};
    const fields = {};
    if (u.kind) { existing.collapseKind = collapseKindOf(u.kind); existing.toolName = toolNameOf(u.kind); fields.collapseKind = existing.collapseKind; fields.toolName = existing.toolName; }
    let input = { ...(block.input || {}) };
    if (u.rawInput != null || u.locations || u.title) Object.assign(input, inputOf(u));
    let output = block.output || '';
    if (Array.isArray(u.content)) {
      const c = toolContentOf(u.content);
      if (c.output) output = c.output;
      if (c.diff) Object.assign(input, { file_path: c.diff.path || input.file_path, old_string: c.diff.oldText, new_string: c.diff.newText });
    }
    if (u.rawOutput != null && !output) output = typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput, null, 2);
    const status = u.status || existing.backendMeta?.acpStatus || 'in_progress';
    existing.backendMeta = { ...(existing.backendMeta || {}), acpStatus: status, ...(u.title ? { title: u.title } : {}) };
    const done = status === 'completed' || status === 'failed';
    existing.status = done ? (status === 'failed' ? 'error' : 'complete') : 'pending';
    existing.toolStatus = done ? (status === 'failed' ? 'error' : 'ok') : null;
    existing.content = [done
      ? { type: 'tool_result', toolCallId, toolName: existing.toolName, input, output, status: status === 'failed' ? 'error' : 'ok' }
      : { type: 'tool_call', toolCallId, toolName: existing.toolName, input, ...(output ? { output } : {}) }];
    fields.status = existing.status; fields.toolStatus = existing.toolStatus; fields.content = existing.content; fields.backendMeta = existing.backendMeta;
    if (emit) this._emit({ op: 'edit', id: existing.id, fields });
  }

  _processPermissionRequest(rec, emit) {
    const requestId = String(rec.requestId);
    const tc = rec.toolCall || {};
    const options = asArray(rec.options).map((o) => ({ optionId: String(o?.optionId ?? ''), name: String(o?.name || o?.optionId || ''), kind: String(o?.kind || 'allow_once') })).filter((o) => o.optionId);
    if (tc.toolCallId && !this.toolCards.has(tc.toolCallId)) this._toolCall({ ...tc, status: tc.status || 'pending' }, emit);
    const msgId = tc.toolCallId ? this.toolCards.get(tc.toolCallId) : null;
    let existing = msgId ? this.messageIndex.get(msgId) : null;
    const permission = {
      requestId: rec.requestId,
      toolName: existing?.toolName || toolNameOf(tc.kind),
      input: existing?.content?.[0]?.input || inputOf(tc),
      suggestions: options.some((o) => o.kind === 'allow_always') ? [{ kind: 'allow_always' }] : [],
      options,
      resolved: null,
      kind: 'approval',
    };
    if (!existing) {
      existing = this._create({ role: 'tool', status: 'pending', content: [{ type: 'tool_call', toolCallId: tc.toolCallId || requestId, toolName: permission.toolName, input: permission.input }], toolCallId: tc.toolCallId || requestId, toolName: permission.toolName, permission });
      if (tc.toolCallId) this.toolCards.set(tc.toolCallId, existing.id);
      this.pendingApprovals.set(requestId, { msgId: existing.id, permission });
      if (emit) this._emit({ op: 'create', message: existing });
      return;
    }
    existing.permission = permission;
    this.pendingApprovals.set(requestId, { msgId: existing.id, permission });
    if (emit) this._emit({ op: 'edit', id: existing.id, fields: { permission } });
  }
  _resolvePermission(requestId, resolved, emit, optionId) {
    const p = this.pendingApprovals.get(requestId);
    if (!p) return;
    p.permission.resolved = resolved;
    if (optionId) p.permission.selectedOptionId = optionId;
    const m = this.messageIndex.get(p.msgId);
    if (m) { m.permission = p.permission; if (emit) this._emit({ op: 'edit', id: m.id, fields: { permission: m.permission } }); }
    this.pendingApprovals.delete(requestId);
  }
}

/** Store-side reader over the wrapper journal (no on-disk transcript exists
 *  for an ACP agent — the live buffer + sidecar are the whole truth). */
class AcpSessionMessages {
  constructor(session, sessionId, { buffersDir } = {}) {
    this._session = session;
    this._sessionId = sessionId;
    this._buffersDir = buffersDir;
    this._all = null;
    this._wrapperMeta = undefined;
  }
  _ensureParsed() { if (!this._all) this._all = parseAcpBufferRecords(this._session?.buffer || ''); }
  get total() { this._ensureParsed(); return this._all.length; }
  raw() { this._ensureParsed(); return this._all; }
  tail(n = 50) { this._ensureParsed(); return this._all.slice(-n); }
  slice(offset, limit) { this._ensureParsed(); return this._all.slice(offset, offset + limit); }
  get isStreaming() { return !!this.wrapperMeta()?.streaming; }
  wrapperMeta() {
    if (this._wrapperMeta !== undefined) return this._wrapperMeta;
    if (!this._buffersDir || !this._sessionId) { this._wrapperMeta = null; return null; }
    try { this._wrapperMeta = JSON.parse(fs.readFileSync(path.join(this._buffersDir, `${this._sessionId}.json`), 'utf-8')); }
    catch { this._wrapperMeta = null; }
    return this._wrapperMeta;
  }
  chatStatus() {
    const meta = this.wrapperMeta();
    const mm = new AcpMessageManager(this._sessionId || 'status');
    mm.convertHistory(this.raw());
    const st = mm.status();
    const status = {
      model: st.model || meta?.model || '',
      permissionMode: st.permissionMode || meta?.agentMode || '',
      permissionModes: st.permissionModes?.length ? st.permissionModes : asArray(meta?.configOptions).filter((o) => o && (o.category === 'mode' || o.id === 'mode')).flatMap((o) => flattenSelect(o).map((v) => String(v.value))),
      contextWindow: st.contextWindow || meta?.usage?.size || 0,
      lastUsage: st.lastUsage || (meta?.usage?.used != null ? { input_tokens: meta.usage.used, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : null),
      total_cost_usd: st.total_cost_usd || meta?.usage?.cost?.amount || 0,
      slashCommands: st.slashCommands?.length ? st.slashCommands : asArray(meta?.availableCommands).map((c) => c.name),
      models: st.models || [],
      agentInfo: st.agentInfo || meta?.acp?.agentInfo || null,
      subagentMetas: [],
    };
    return status.model || status.permissionMode || status.lastUsage || status.slashCommands.length ? status : null;
  }
  taskState() {
    const meta = this.wrapperMeta();
    const todos = asArray(meta?.todos).map((t) => ({ content: String(t?.content || ''), status: t?.status === 'in_progress' ? 'in_progress' : t?.status === 'completed' ? 'completed' : 'pending' })).filter((t) => t.content);
    return { tasks: {}, todos };
  }
}

AcpMessageManager._seenUnknownUpdates = new Set();

module.exports = { AcpMessageManager, AcpSessionMessages, parseAcpBufferRecords, collapseKindOf, toolNameOf };
