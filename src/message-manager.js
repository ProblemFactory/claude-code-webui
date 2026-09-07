/**
 * MessageManager — converts raw Claude stream-json messages into normalized messages.
 *
 * Each NormalizedMessage has a stable CONTENT-DERIVED ID (see _nextId), a role, status, and content blocks.
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

// System subtypes _processSystem actually renders/consumes — anything else
// trips the unhandled-subtype breadcrumb (2.227.5). Keep in sync when adding
// a branch; task_* are handled under the tool_use_id path.
const HANDLED_SYSTEM_SUBTYPES = new Set([
  'init', 'hook_response', 'stop_hook_summary', 'model_refusal_fallback',
  'model_refusal_no_fallback',
  'task_started', 'task_progress', 'task_notification',
  // api_retry is DELIBERATELY card-less: the server feeds it into the
  // streaming label ("API retrying (3/10, HTTP 500)…") — one card per retry
  // attempt would spam the transcript. Listed here so the unknown-subtype
  // breadcrumb stops firing for it.
  'api_retry',
]);


// Cross-session peer display name (2.361.6, owner report: the card showed the
// raw uds socket path). Precedence: origin.name (the CLI includes the sender's
// session name since 2.1.23x) → the wrapper tag's from-name attribute (older
// records) → a non-socket origin.from → null (renderer shows a generic label;
// a unix socket path is never a user-facing identity).
function peerDisplayName(origin, text) {
  if (origin && origin.name) return String(origin.name);
  const m = /<cross-session-message[^>]*\bfrom-name="([^"]+)"/.exec(String(text || ''));
  if (m) return m[1];
  // SERVER-posted deliveries (vibespace-msg / Background Work) reach the CLI
  // as an unregistered poster: origin has NO name and from:"unknown" — but the
  // framed text itself names the sender. Parse it so rebuilds match the card
  // the delivery site rendered live (2.363.0).
  const s = String(text || '');
  const vm = /Message from session "([^"]+)" \(via vibespace-msg/.exec(s);
  if (vm) return vm[1];
  const bw = /\[VibeSpace Background Work\] \w+ "([^"]+)"/.exec(s);
  if (bw) return 'Background Work · ' + bw[1];
  const f = origin && origin.from;
  if (f && f !== 'unknown' && !String(f).startsWith('uds:')) return String(f);
  return null;
}

// Result-error classes the UI ACTS on (2.365.0). 'prompt-too-long' = the
// conversation no longer fits the model's context window: every following
// send fails identically until the conversation is compacted, so the renderer
// turns it into a guidance card with a Compact-now action instead of a bare
// "Error: Prompt is too long" line (the userN incident: bare line, then a
// minute-long /compact that got Stop-clicked into "Compaction canceled.").
// Phrases = the CLI's own prompt_too_long detector family (2.1.238).
const PROMPT_TOO_LONG_RE = /prompt is too long|input is too long for requested model|exceeds? (the )?(model'?s )?context (window|limit)|context window (is )?(full|exceeded)/i;
function classifyResultError(text) {
  return PROMPT_TOO_LONG_RE.test(String(text || '')) ? 'prompt-too-long' : null;
}

/** tool_result content → { text, images }. Text/other blocks keep the exact
 *  previous shape (string passthrough; arrays JSON-stringified so the
 *  renderer's `[{` Agent-result parse still works); image blocks are LIFTED
 *  OUT as {mediaType, bytes} and replaced by a one-line marker. */
function splitToolResultContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content || ''), images: [] };
  const images = [];
  const rest = [];
  for (const b of content) {
    if (b && typeof b === 'object' && b.type === 'image') {
      const data = b.source?.data || '';
      const bytes = Math.round(data.length * 3 / 4);
      images.push({ mediaType: b.source?.media_type || 'image/png', bytes });
      rest.push({ type: 'text', text: `[image ${b.source?.media_type || 'image/png'} · ${Math.max(1, Math.round(bytes / 1024))} KB]` });
    } else rest.push(b);
  }
  if (!images.length) return { text: JSON.stringify(content), images: [] };
  return { text: JSON.stringify(rest), images };
}

class MessageManager {
  // Injected by the server once the settings SyncStore exists (the normalizer
  // can't reach server state directly). null in tests → defaults apply.
  static getSetting = null;

  constructor(sessionId) {
    this.sessionId = sessionId;
    this.seq = 0; // rebuild belt only — ids no longer derive from it (R0, three-tier design)
    this._rkCounts = new Map(); // record-key → messages minted from it (id suffix discriminator)
    this._currentRk = null;
    this.messages = [];
    this.messageIndex = new Map();      // id → NormalizedMessage
    this.pendingToolCalls = new Map();   // toolUseId → { msgId, block }
    // Task lifecycle needs its OWN index (2.368.15, owner: "基本每个对话都有
    // 已结束的后台任务显示为正在进行"): pendingToolCalls is the permission/
    // result matcher and the tool_result DELETES its entry — a background
    // task's result arrives in seconds ("Command running in background…"),
    // its completion notification arrives minutes later, so every closer
    // that looked tasks up via pendingToolCalls found nothing and the card
    // stayed 'running' forever. These maps live for the conversation.
    this.taskMsgByToolUse = new Map();   // toolUseId → msgId (tasks only)
    this.taskMsgByTaskId = new Map();    // task_id  → msgId
    this.turnIndex = 0;
    this.listeners = [];
    this._peerMsgIds = new Set(); // cross-session msg_ids already rendered (dedup across the three peer sites)
  }

  _notePeerMsgId(id) {
    if (!id) return;
    this._peerMsgIds.add(id);
    if (this._peerMsgIds.size > 500) { const first = this._peerMsgIds.values().next().value; this._peerMsgIds.delete(first); }
  }

  // Does any recent user message already carry this text? (fallback dedup for
  // peer records without msg_id — the JSONL user record wraps the body in the
  // harness envelope, so containment, not equality)
  _recentUserTextIncludes(body) {
    for (let i = this.messages.length - 1, seen = 0; i >= 0 && seen < 12; i--, seen++) {
      const m = this.messages[i];
      if (m.role === 'user' && (m.content || []).map((b) => b.text || '').join('').includes(body)) return true;
    }
    return false;
  }

  // SERVER-SIDE peer card (2.363.0, owner report "session里也没有消息卡片"):
  // deliveries POSTED BY THIS SERVER (Background Work notify, vibespace-msg —
  // the conversation-deliver ladder) reach the CLI as an UNREGISTERED poster,
  // so the CLI records origin {kind:'peer', from:'unknown'} with NO
  // name/msg_id/body and the stdout result.origin is body-less — result-mining
  // has nothing to mine and the live window stays blank. The server IS the
  // poster: the delivery site knows the sender and text exactly and renders
  // the card here the moment the post succeeds. In-memory only by design — a
  // rebuild renders the CLI's own JSONL user record instead (no dup: that
  // record never crosses stdout, and its body-less result.origin is skipped).
  // No containment dedup: the delivery site posts once per fire (same-body
  // repeats are legitimate — the 2.362.2 review lesson).
  injectPeerCard({ fromName, text }) {
    const body = String(text || '').trim();
    if (!body) return null;
    this._currentRk = null; // outside any record context — take the s-fallback id, never the last record's key
    this._currentTs = Date.now();
    this.turnIndex++;
    const msg = this._create({ role: 'user', status: 'complete', content: [{ type: 'text', text: body }], turnIndex: this.turnIndex });
    msg.originKind = 'peer-message';
    msg.peerFrom = fromName ? String(fromName) : null;
    this._emit({ op: 'create', message: msg });
    return msg;
  }

  // R0 (docs/design-three-tier.md): ids derive from CONTENT, not a
  // per-instance counter. A parser rebuild (server restart today; routine
  // daemon self-upgrade once parsing moves device-side) must reproduce the
  // SAME ids, and a device-parsed history must join a server-parsed live
  // stream by id. Key preference: message.id (stable across the stdout and
  // JSONL copies of one API message — the 2.74.0 dedup lesson) > record uuid
  // (unique per JSONL record; the stdout placeholder uuid is excluded) >
  // record-content hash. One record can mint several messages (thinking /
  // text / tool_use blocks); a per-key counter suffixes the 2nd+ — block
  // order is the API's content order on BOTH transports, so the suffix is
  // transport-stable. Tool messages don't come through here at all: they key
  // on their globally-unique toolCallId.
  _nextId() {
    const rk = this._currentRk || ('s' + this.seq); // s-fallback: creates outside record context
    this.seq++;
    const n = this._rkCounts.get(rk) || 0;
    this._rkCounts.set(rk, n + 1);
    return `${this.sessionId}:${rk}${n ? '.' + n : ''}`;
  }

  static recordKey(raw) {
    const mid = raw?.message?.id;
    if (mid && mid !== '<synthetic>') return 'm:' + mid;
    const u = raw?.uuid;
    if (u && !/-0{11,}1?$/.test(u)) return 'u:' + u; // stdout placeholder …-000000000001 excluded
    let h = 0x811c9dc5; // FNV-1a over the record's own serialization —
    const str = JSON.stringify(raw ?? null); // deterministic for identical bytes (buffer replay)
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return 'h:' + h.toString(36) + ':' + str.length;
  }

  onOp(fn) { this.listeners.push(fn); }
  offOp(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
  _emit(op) { for (const fn of this.listeners) fn(op); }

  /**
   * Bulk convert historical messages. Returns NormalizedMessage[].
   * Does NOT emit ops — caller uses the returned array directly.
   */
  convertHistory(claudeMessages) {
    for (const msg of claudeMessages) {
      // Per-record isolation: a single malformed/crashing record must skip,
      // not amputate everything after it (a ReferenceError here once truncated
      // every rebuilt session view at the first hook record — fleet-wide).
      try { this._processMessage(msg, false); }
      catch (e) { console.error('[normalizer] record skipped during history rebuild:', e.message); }
    }
    // Finalize any trailing streaming text
    this._finalizeStreaming(false);
    return this.messages;
  }

  /**
   * TIME-SLICED rebuild (2.369.16, userW inc-mtndq0vb): identical result to
   * convertHistory, but yields to the event loop every ~budgetMs so the
   * first attach of a multi-MB transcript no longer blocks the server for
   * seconds (58 sessions × 10-56MB after a restart = a 4-minute stall that
   * made the heartbeat terminate the client and drop its queued kills).
   * Callers MUST hold live records back (session._rebuildQueue) while this
   * runs and replay them after — a live record interleaved mid-rebuild
   * would land before the rest of the history.
   */
  async convertHistoryAsync(claudeMessages, { budgetMs = 25, onSlice } = {}) {
    let sliceStart = Date.now(), done = 0;
    for (const msg of claudeMessages) {
      try { this._processMessage(msg, false); }
      catch (e) { console.error('[normalizer] record skipped during history rebuild:', e.message); }
      done++;
      if (Date.now() - sliceStart >= budgetMs) {
        try { onSlice?.(done); } catch { }
        await new Promise((r) => setImmediate(r));
        sliceStart = Date.now();
      }
    }
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
              entry.preview = this._truncateWord(raw, 60);
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
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'system_info') return b.text || b.thinking || '';
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
      srcLine: this._currentLine,
      uuid: this._currentUuid,
      turnIndex: fields.turnIndex ?? this.turnIndex,
      toolCallId: fields.toolCallId || null,
      toolName: fields.toolName || null,
      toolStatus: fields.toolStatus || null,
      permission: fields.permission || null,
      usage: fields.usage || null,
      taskInfo: fields.taskInfo || null,
      meta: fields.meta || null, // per-record metadata (model/usage/requestId) for the message-info popup
      // noticeKind keys the CLIENT's localized renderer branch (model-fallback,
      // model-refusal-fallback). It was NEVER passed through here (2.227.4):
      // every notice fell back to its raw English text and the localized
      // branches were dead code from the day they were written.
      noticeKind: fields.noticeKind || null,
    };
    this.messages.push(msg);
    this.messageIndex.set(msg.id, msg);
    return msg;
  }

  /** Harness tasks (TaskCreate/TaskUpdate) → TodoWrite-shaped todos meta */
  _emitHarnessTodos(emit) {
    if (!emit || !this._harnessTasks?.size) return;
    // Harness tasks accumulate over the whole session (unlike TodoWrite,
    // which replaces its working set) — show the current working set only:
    // everything unfinished + the 5 most recent completions.
    const all = [...this._harnessTasks.values()].filter(t => t.status !== 'deleted');
    const openTasks = all.filter(t => t.status !== 'completed');
    const doneTail = all.filter(t => t.status === 'completed')
      .sort((a, b) => Number(a.id) - Number(b.id)).slice(-5);
    const todos = [...doneTail, ...openTasks]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
    this._emit({ op: 'meta', subtype: 'todos', data: todos });
  }

  _finalizeStreaming(emit) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.status === 'streaming') {
        m.status = 'complete';
        if (emit) this._emit({ op: 'edit', id: m.id, fields: { status: 'complete' } });
      }
      // Don't break early — stale streaming messages can exist anywhere
      // after pty re-attach incidents. Scan all recent messages.
      // Stop at user messages (streaming never crosses turn boundaries).
      if (m.role === 'user') break;
    }
  }

  _processMessage(raw, emit) {
    // Extract timestamp from raw message for _create
    this._currentTs = raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now();
    this._currentLine = Number.isFinite(raw.__line) ? raw.__line : null; // source file line (gap loads only)
    this._currentUuid = raw.uuid || null; // JSONL record uuid — needed for fork-from-here (--resume-session-at)
    this._currentRk = MessageManager.recordKey(raw);
    switch (raw.type) {
      case 'system': return this._processSystem(raw, emit);
      case 'user': return this._processUser(raw, emit);
      case 'assistant': return this._processAssistant(raw, emit);
      case 'result': return this._processResult(raw, emit);
      case 'attachment': return this._processAttachment(raw, emit);
      case 'queue-operation':
        if (typeof raw.content === 'string' && raw.content.includes('<task-notification>')) this._closeTaskFromNotification(raw.content, emit);
        return;
      case 'control_request': return this._processControlRequest(raw, emit);
      case 'control_response': return this._processControlResponse(raw, emit);
      case 'control_cancel_request': return this._processControlCancel(raw, emit);
    }
  }

  _processSystem(raw, emit) {
    // (see the unhandled-subtype breadcrumb at the tail of this method)
    if (raw.subtype === 'init') {
      const msg = this._create({
        role: 'system', status: 'complete',
        content: [{ type: 'system_info', text: `Model: ${raw.model || 'unknown'}`, initData: { model: raw.model, permissionMode: raw.permissionMode, slashCommands: raw.slash_commands } }],
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }

    if (raw.subtype === 'hook_response') {
      const name = raw.hook_name || raw.hook_event || 'hook';
      if (this._lastHookCard && this._lastHookCard.name === name && Math.abs(this._currentTs - this._lastHookCard.ts) < 5000) return;
      const ok = raw.outcome === 'success' || raw.exit_code === 0;
      const icon = ok ? '✓' : '✗';
      const msg = this._create({
        role: 'system', status: ok ? 'complete' : 'error',
        content: [{ type: 'system_info', text: `${icon} Hook: ${name}`, hookData: { name, event: raw.hook_event, outcome: raw.outcome, exitCode: raw.exit_code, output: raw.output } }],
      });
      // raw.output, NOT bare `output` — the 2.80.0 typo threw ReferenceError on
      // EVERY hook_response during convertHistory, amputating rebuilt history at
      // the first buffer hook record (live path swallowed it per-line; the
      // "restart 之后消息都没了" incident).
      this._lastHookCard = { name, ts: this._currentTs, msgId: msg.id, outHead: raw.output ? String(raw.output).slice(0, 200) : null };
      if (emit) this._emit({ op: 'create', message: msg });
    }

    // REFUSAL-triggered model fallback (2.227.4, real report "聊到一半变成
    // opus-4.8 但看不到 fallback 事件"): a NEWER CLI path than the 2.29.1
    // `fallback` CONTENT BLOCK — when the safety classifier flags a message,
    // the CLI RETRIES it on another model and records ONLY this system line
    // (verified: the 00:29 switch had the system record and NO content
    // block). Unhandled subtypes fall through _processSystem silently, so the
    // model badge flipped with nothing in the transcript to explain it.
    if (raw.subtype === 'model_refusal_fallback') {
      // KEY-CASING TRAP (2.227.6, real "? → ?" report): the SAME record is
      // snake_case on stdout (`original_model`) and camelCase in the JSONL
      // (`originalModel`) — reading only the JSONL shape rendered every LIVE
      // notice with '?' models while history rebuilds looked fine. Accept
      // both on every field of any record read from BOTH transports.
      const from = raw.originalModel || raw.original_model || '?';
      const to = raw.fallbackModel || raw.fallback_model || '?';
      const msg = this._create({
        role: 'system',
        content: [{
          type: 'text',
          // English text is the fallback; the client localizes on noticeKind.
          text: `⚠ Safety-classifier fallback: ${from} → ${to} (the model's safeguards flagged this message, so the harness retried it on another model)`,
          fallbackFrom: from, fallbackTo: to,
          refusalCategory: raw.apiRefusalCategory || raw.api_refusal_category || null,
          // stdout also carries the policy explanation (JSONL doesn't) — it is
          // the most actionable line for the user, so prefer it.
          cliText: [raw.api_refusal_explanation || raw.apiRefusalExplanation || '', typeof raw.content === 'string' ? raw.content : '']
            .filter(Boolean).join('\n\n').slice(0, 900) || null,
        }],
        noticeKind: 'model-refusal-fallback',
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }

    // With fallback disabled (switchModelsOnFlag=false / the env kill), a
    // safety-classifier refusal no longer reroutes — the CLI emits this and
    // the turn DEAD-ENDS. Unrendered it is a silent failure (the turn just
    // stops with nothing shown), which is the exact class the disable option
    // exists to avoid. Both key casings (stdout snake / JSONL camel).
    if (raw.subtype === 'model_refusal_no_fallback') {
      const model = raw.originalModel || raw.original_model || '?';
      const msg = this._create({
        role: 'system',
        content: [{
          type: 'text',
          text: `⚠ Safety-classifier stop: ${model} flagged this message and model fallback is disabled — the turn stopped instead of switching models. Rephrase and resend to continue.`,
          fallbackFrom: model,
          refusalCategory: raw.apiRefusalCategory || raw.api_refusal_category || null,
          cliText: [raw.api_refusal_explanation || raw.apiRefusalExplanation || '', typeof raw.content === 'string' ? raw.content : '']
            .filter(Boolean).join('\n\n').slice(0, 900) || null,
        }],
        noticeKind: 'model-refusal-no-fallback',
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }

    if (raw.subtype === 'stop_hook_summary') {
      const count = raw.hookCount || 0;
      const infos = raw.hookInfos || [];
      const failed = infos.filter(h => h.exitCode !== 0 && h.exitCode != null);
      // Inline: SHORT names only. hookInfos often has no name field, just the
      // raw command — which can be a whole embedded shell script (claude-mem's
      // is ~1KB; dumping it inline made the card an unreadable wall — user
      // report). Derive a short name (first script filename in the command);
      // the full commands live in the expandable hookData body instead.
      const shortName = (h) => {
        const n = h.name || h.hookName;
        if (n) return String(n).slice(0, 40);
        const cmd = String(h.command || '');
        const m = cmd.match(/([\w.-]+\.(?:mjs|cjs|js|sh|py|ts))\b/);
        return (m ? m[1] : (cmd.trim().split(/\s+/)[0] || 'hook')).slice(0, 40);
      };
      const names = [...new Set(infos.map(shortName).filter(Boolean))];
      const nameStr = names.length ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})` : '';
      const text = (failed.length ? `${count} hooks ran, ${failed.length} failed` : `${count} hooks ran`) + nameStr;
      const detail = infos.map((h) => `- ${shortName(h)}${h.exitCode != null ? ` (exit ${h.exitCode})` : ''}${h.command ? `\n  ${String(h.command)}` : ''}`).join('\n');
      const msg = this._create({
        role: 'system', status: failed.length ? 'error' : 'complete',
        content: [{ type: 'system_info', text, ...(detail ? { hookData: { name: `${count} hooks`, event: 'Stop', outcome: failed.length ? 'partial' : 'success', exitCode: null, output: detail } } : {}) }],
      });
      if (emit) this._emit({ op: 'create', message: msg });
    }

    // BREADCRUMB for CLI evolution (2.227.5, the model_refusal_fallback
    // lesson): an unhandled system subtype is DROPPED here — that is how a
    // new upstream record type becomes an invisible product gap (39 silent
    // model switches before a user noticed). Name-only telemetry, deduped per
    // process, so the NEXT new subtype shows up in Diagnostics instead of
    // waiting for a report. Add the handler, then it stops firing.
    if (raw.subtype && !HANDLED_SYSTEM_SUBTYPES.has(raw.subtype) && !raw.tool_use_id) {
      if (!MessageManager._seenUnknownSubtypes.has(raw.subtype)) {
        MessageManager._seenUnknownSubtypes.add(raw.subtype);
        try { global.__vsEvent?.('cli-unknown-system-subtype', String(raw.subtype).slice(0, 60)); } catch {}
      }
    }

    // Task lifecycle → edit existing tool message. Resolution goes through
    // the task index FIRST — pendingToolCalls only helps for task_started
    // (the tool_result hasn't arrived yet then) and is EMPTY by the time a
    // completion lands (see the constructor note).
    if (raw.tool_use_id) {
      const existing = this._taskMsgFor(raw.tool_use_id, raw.task_id);
      if (!existing) return;

      if (raw.subtype === 'task_started') {
        existing.taskInfo = { id: raw.task_id, type: raw.task_type, description: raw.description, status: 'running' };
        this.taskMsgByToolUse.set(raw.tool_use_id, existing.id);
        if (raw.task_id != null) this.taskMsgByTaskId.set(String(raw.task_id), existing.id);
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

  /** Close the task a <task-notification> payload names (status + summary).
   *  ONE closer for every transport the notification rides: the idle-wake
   *  user record, the mid-turn queued_command attachment, and the
   *  queue-operation records (2.368.31, owner "又开始出现大量已经完成的任务
   *  显示成在进行了": a BUSY agent's completions are persisted ONLY as
   *  queue-operation + attachment records — never as the idle user record
   *  the 2.233.0 closer read, so most tasks never closed after a rebuild). */
  _closeTaskFromNotification(contentStr, emit) {
    const tuMatch = contentStr.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/);
    const tidMatch = contentStr.match(/<task-id>([\s\S]*?)<\/task-id>/);
    const stMatch = contentStr.match(/<status>([\s\S]*?)<\/status>/);
    // Lookup via the task index — NOT pendingToolCalls, whose entry the
    // background task's own tool_result deleted minutes before this
    // notification arrived (2.368.15: the reason every conversation
    // accumulated forever-'running' cards despite the 2.233.0 closer).
    const taskMsg = this._taskMsgFor(tuMatch ? tuMatch[1].trim() : null, tidMatch ? tidMatch[1].trim() : null);
    if (taskMsg?.taskInfo && taskMsg.taskInfo.status === 'running') {
      const st = (stMatch ? stMatch[1].trim() : 'completed').toLowerCase();
      taskMsg.taskInfo.status = st === 'completed' ? 'completed' : (st || 'completed');
      const smMatch = contentStr.match(/<summary>([\s\S]*?)<\/summary>/);
      if (smMatch) taskMsg.taskInfo.summary = smMatch[1].trim().slice(0, 200);
      if (emit) this._emit({ op: 'edit', id: taskMsg.id, fields: { taskInfo: taskMsg.taskInfo } });
    }
  }

  /** Find the tool message a task-lifecycle signal refers to: task index →
   *  pendingToolCalls (pre-result window) → task-id fallback. */
  _taskMsgFor(toolUseId, taskId) {
    const viaTask = toolUseId && this.taskMsgByToolUse.get(toolUseId);
    if (viaTask) return this.messageIndex.get(viaTask) || null;
    const pending = toolUseId && this.pendingToolCalls.get(toolUseId);
    if (pending) return this.messageIndex.get(pending.msgId) || null;
    const viaId = taskId != null && this.taskMsgByTaskId.get(String(taskId));
    return viaId ? (this.messageIndex.get(viaId) || null) : null;
  }

  _processAttachment(raw, emit) {
    const a = raw.attachment;
    if (!a) return;
    // Mid-turn user messages ("sent while you were working") are recorded in
    // the JSONL ONLY as queued_command attachments — never as user records.
    // Dropping them (pre-2.88.0) ERASED the user's own words from any history
    // rebuilt from the JSONL (restart re-normalization, resume under another
    // account, view-only) — a real 211-records-in-one-session data-visibility
    // loss. Render as a normal user message; dedup against the live-send echo
    // (same text sent via chat-input lands in the buffer too).
    if (a.type === 'queued_command') {
      // prompt is an ARRAY of blocks for the user's own mid-turn messages,
      // but a plain STRING for mid-turn PEER deliveries (2.351.2 forensics:
      // a queued cross-session message is JSONL-only — attachment/
      // queued_command with origin:{kind:'peer'} and a string prompt; the
      // array-only filter made every one of them invisible)
      const blocks = typeof a.prompt === 'string'
        ? (a.prompt.trim() ? [{ type: 'text', text: a.prompt }] : [])
        : (Array.isArray(a.prompt) ? a.prompt : [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
          .map((b) => ({ type: 'text', text: b.text }));
      const text = blocks.map((b) => b.text).join('');
      if (!text.trim()) return;
      // Mid-turn task completion (2.368.31): the notification rides THIS
      // attachment when the agent was busy — close the task and render the
      // notification card (provenance law: never a "You" bubble of XML).
      if (/^\s*<task-notification>/.test(text)) {
        this._closeTaskFromNotification(text, emit);
        this.turnIndex++;
        const nmsg = this._create({ role: 'user', status: 'complete', content: blocks, turnIndex: this.turnIndex });
        nmsg.originKind = 'task-notification';
        if (emit) this._emit({ op: 'create', message: nmsg });
        return;
      }
      for (let i = this.messages.length - 1, seen = 0; i >= 0 && seen < 12; i--, seen++) {
        const m = this.messages[i];
        if (m.role === 'user' && (m.content || []).map((b) => b.text || '').join('') === text) return;
      }
      this.turnIndex++;
      const msg = this._create({ role: 'user', status: 'complete', content: blocks, turnIndex: this.turnIndex });
      if (a.origin?.kind === 'peer') {
        // same provenance law as the idle-wake user record — render the
        // peer card, never a "You" bubble of someone else's words
        msg.originKind = 'peer-message';
        msg.peerFrom = peerDisplayName(a.origin, text);
        this._notePeerMsgId(a.origin.msg_id);
      } else {
        msg.typed = true; // the user's own words — never a notification card
      }
      if (emit) this._emit({ op: 'create', message: msg });
      return;
    }
    if (a.type === 'goal_status') {
      this._goalState = { condition: a.condition || '', met: !!a.met, sentinel: !!a.sentinel };
      if (emit) this._emit({ op: 'meta', subtype: 'goal_status', data: this._goalState });
      return;
    }
    // The CANONICAL carrier of injected context is its OWN attachment type —
    // {type:'hook_additional_context', content:[strings]} (no hookName). This
    // was the missing piece behind "hook注入的context看不到" (user report).
    if (a.type === 'hook_additional_context') {
      const text = (Array.isArray(a.content) ? a.content : [a.content]).filter((x) => typeof x === 'string').join('\n').trim();
      if (!text) return;
      const prior = this._lastHookCard;
      if (prior && prior.outHead && text.slice(0, 200) === prior.outHead && Math.abs(this._currentTs - prior.ts) < 5000) return; // same payload already shown via the hook's stdout card
      const tag = (text.match(/^<([\w-]+)/) || [])[1] || null;
      const msg = this._create({
        role: 'system', status: 'complete',
        content: [{ type: 'system_info', text: `✓ Hook context${tag ? `: ${tag}` : ''}`, hookData: { name: tag || 'injected context', event: null, outcome: 'context', exitCode: null, output: text } }],
      });
      this._lastHookCard = { name: tag || 'injected context', ts: this._currentTs, msgId: msg.id, outHead: text.slice(0, 200) };
      if (emit) this._emit({ op: 'create', message: msg });
      return;
    }
    // Hook attachments (JSONL-only) carry the FULL per-hook record — name,
    // event, stdout (incl. any injected additionalContext). Without this,
    // history replay showed only the bare "N hooks ran" summary (user report).
    if (a.type === 'hook_success' || a.type === 'hook_failure' || a.type === 'hook_error' || a.type === 'hook_system_message') {
      const isSys = a.type === 'hook_system_message';
      const name = a.hookName || a.hookEvent || 'hook';
      const ok = a.type === 'hook_success' || isSys;
      // stderr counts only for FAILED hooks — successful plugins routinely spew
      // warnings there (Node ExperimentalWarning etc.), which is noise. content
      // can be a LIST of strings (harness content blocks) — flatten it.
      const contentStr = Array.isArray(a.content) ? a.content.filter((x) => typeof x === 'string').join('\n') : a.content;
      const raw = [contentStr, a.stdout, ...(ok ? [] : [a.stderr])].filter((x) => typeof x === 'string' && x.trim()).join('\n');
      // Unwrap the machine ack: hook stdout is usually a protocol JSON like
      // {"continue":true,"suppressOutput":true} — the only human-relevant part
      // is hookSpecificOutput.additionalContext (or a block decision/reason).
      let meaningful = raw.trim();
      try {
        const j = JSON.parse(meaningful);
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          const extra = j.hookSpecificOutput?.additionalContext;
          meaningful = typeof extra === 'string' ? extra.trim() : '';
          if (!meaningful && (j.decision || j.reason)) meaningful = [j.decision, j.reason].filter(Boolean).join(': ');
        }
      } catch { /* not JSON — keep the raw text */ }
      const output = meaningful || (ok ? '' : raw); // full output — never truncated (expandable card + scroll cap handle size)
      // Live/replay double-render dedup — the two copies are ASYMMETRIC: the
      // stdout hook_response usually has NO output while the JSONL attachment
      // carries the FULL injected context. Skipping the newcomer blindly hid
      // every injected context (user report) — UPGRADE the existing card when
      // the newcomer knows more.
      const prior = this._lastHookCard;
      const sameContent = prior && prior.outHead && output && output.slice(0, 200) === prior.outHead;
      if (prior && (prior.name === name || sameContent) && Math.abs(this._currentTs - prior.ts) < 5000) {
        if (output && prior.msgId != null) {
          const ex = this.messageIndex.get(prior.msgId);
          const exOut = ex?.content?.[0]?.hookData?.output || '';
          if (ex && output.length > exOut.length) {
            ex.content[0].hookData.output = output;
            if (emit) this._emit({ op: 'edit', id: ex.id, fields: { content: ex.content } });
          }
        }
        return;
      }
      // Empty SUCCESSFUL hooks are pure noise (PostToolUse etc. fire per tool
      // call with no output — user report: chat flooded with blank hook cards).
      // Failures always show. Overridable via chat.hideEmptyHooks (2.80.0).
      const hideEmpty = !MessageManager.getSetting || MessageManager.getSetting('chat.hideEmptyHooks') !== false;
      if (ok && !output && hideEmpty) return;
      const msg = this._create({
        role: 'system', status: ok ? 'complete' : 'error',
        content: [{ type: 'system_info', text: `${ok ? '✓' : '✗'} Hook: ${isSys ? (name !== 'hook' ? name + ' ' : '') + 'message' : name}`, hookData: { name, event: a.hookEvent || null, outcome: a.type, exitCode: a.exitCode ?? null, output } }],
      });
      this._lastHookCard = { name, ts: this._currentTs, msgId: msg.id };
      if (emit) this._emit({ op: 'create', message: msg });
    }
  }

  goalState() { return this._goalState || null; }

  /** The input queue (harness contract). ALWAYS EMPTY for claude: the CLI
   *  queues stdin messages itself and publishes no queue state — backend-caps
   *  inputModes {queue:true, steer:false, queueOps:false} says so, and the
   *  client's strip renders nothing. Present so every chat normalizer answers
   *  the same question (test-harness-contract pins it) instead of the caller
   *  learning which ones have the method. */
  queueState() { return []; }
  /** …and the CLI never publishes one, so the client's controls stay off. */
  queuePublished() { return false; }

  _processUser(raw, emit) {
    this._finalizeStreaming(emit);
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

      // BINARY NEVER ENTERS A CARD (2.369.35, owner: two windows frozen): a Read
      // of a PNG returns the image as a base64 block; stringifying it put a
      // ~600KB blob into `output` TEXT — 78 such cards = a 12MB attach payload and
      // the renderer (escHtml/linkify over base64) froze the whole page. Images
      // leave as {mediaType, bytes} metadata; the renderer shows the FILE (the
      // Read path is on disk) instead of the bytes.
      const split = splitToolResultContent(tr.content);
      const resultText = split.text;
      existing.status = tr.is_error ? 'error' : 'complete';
      existing.toolStatus = tr.is_error ? 'error' : 'ok';
      // A tool_result implies the pending permission was answered. The
      // control_response only exists in server memory (it goes to claude's
      // STDIN — the wrapper's .buf tees stdout only), so a restart-rebuilt
      // history is request-without-response and the card would render
      // awaiting-approval forever (real report: an answered AskUserQuestion
      // questionnaire stuck interactive). Mirror of the completed-before-
      // request auto-resolve in _processControlRequest. Emit `permission`
      // ONLY when newly resolved HERE — unconditionally re-emitting a
      // long-resolved permission made the live completion edit re-append the
      // "✓ Allowed" chip renderToolMsg deliberately omits AND clobbered the
      // client's selectedAnswers (review-confirmed).
      let permResolved = false;
      if (existing.permission && !existing.permission.resolved) {
        existing.permission.resolved = this._resolutionFromResult(resultText, tr.is_error);
        permResolved = true;
      }
      // Replace tool_call content with tool_result (keeps input + adds output)
      existing.content = [{
        type: 'tool_result', toolCallId: toolUseId, toolName: pending.block.name,
        input: pending.block.input, output: resultText, status: tr.is_error ? 'error' : 'ok',
        ...(split.images.length ? { images: split.images } : {}),
      }];
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { status: existing.status, toolStatus: existing.toolStatus, content: existing.content, ...(permResolved ? { permission: existing.permission } : {}) } });
      // LAUNCH-ACK taskInfo synthesis (2.368.30): works on HISTORY too (the
      // stream-only task_started never persists), so resumed sessions get
      // running/completed background cards again; a live task_started that
      // follows overwrites the same shape harmlessly.
      if (!existing.taskInfo && !tr.is_error) {
        const syn = parseBackgroundLaunch(pending.block.name, pending.block.input, resultText);
        if (syn) {
          // SUPERSEDE (the wf_768b7abd residual): a Workflow resumed via
          // resumeFromRunId re-launches under the SAME run id — the resume's
          // completion notification closes the resume card only, so the
          // original launch stayed 'running' forever. A re-launch of the same
          // task id supersedes the earlier card.
          const prevId = syn.id && this.taskMsgByTaskId.get(String(syn.id));
          if (prevId && prevId !== existing.id) {
            const prev = this.messageIndex.get(prevId);
            if (prev?.taskInfo?.status === 'running') {
              prev.taskInfo.status = 'completed';
              if (emit) this._emit({ op: 'edit', id: prev.id, fields: { taskInfo: prev.taskInfo } });
            }
          }
          existing.taskInfo = { ...syn, status: 'running' };
          this.taskMsgByToolUse.set(toolUseId, existing.id);
          if (syn.id) this.taskMsgByTaskId.set(String(syn.id), existing.id);
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { taskInfo: existing.taskInfo } });
        }
      }
      // harness TaskCreate: "Task #N created successfully" carries the id
      const subj = this._pendingTaskCreates?.get(toolUseId);
      if (subj && !tr.is_error) {
        const m = resultText.match(/#(\d+)/);
        if (m) {
          (this._harnessTasks = this._harnessTasks || new Map())
            .set(m[1], { id: m[1], content: `#${m[1]} ${subj}`, status: 'pending', activeForm: subj });
          this._emitHarnessTodos(emit);
        }
        this._pendingTaskCreates.delete(toolUseId);
      }
      this.pendingToolCalls.delete(toolUseId);
    }

    // Real user message (has text content, not just tool results)
    if (textBlocks.length > 0 || toolResults.length === 0) {
      // Skip if this is a pure tool-result message (no user text)
      const hasText = textBlocks.some(b => (b.type === 'text' && b.text?.trim()) || b.type === 'image');
      if (!hasText && toolResults.length > 0) return;

      const normalizedContent = textBlocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text || '' };
        if (b.type === 'image') return { type: 'image', mediaType: b.source?.media_type || 'image/png', data: b.source?.data || '' };
        return null;
      }).filter(Boolean);

      if (normalizedContent.length === 0) return;
      // CLI-injected page images (Read on a PDF): the CLI ships the extracted
      // pages as image-only user records — LIVE as one isSynthetic record PER
      // PAGE, in the JSONL as one isMeta record with N image blocks. They are
      // model context, not the user speaking: unflagged, the live burst
      // rendered one bare "notification" stub per page (real report: a
      // 10-page Read → 10 empty cards) and the history rebuild a giant "You"
      // bubble. Coalesce consecutive page events into ONE imageAttachment
      // message (no turnIndex bump — not a conversation turn) so both paths
      // converge on a single compact card.
      const isPageImages = !raw.promptSource && !raw._fromWebui && (raw.isSynthetic || raw.isMeta)
        && normalizedContent.every(b => b.type === 'image');
      if (isPageImages) {
        const last = this.messages[this.messages.length - 1];
        if (last && last.imageAttachment) {
          last.content = last.content.concat(normalizedContent);
          if (emit) this._emit({ op: 'edit', id: last.id, fields: { content: last.content, status: 'complete' } });
          return;
        }
        const att = this._create({ role: 'user', status: 'complete', content: normalizedContent, turnIndex: this.turnIndex });
        att.imageAttachment = true;
        att.synthetic = true;
        if (emit) this._emit({ op: 'create', message: att });
        return;
      }

      this.turnIndex++;
      // Use original msgId if present (for dedup with client-side local preview)
      const msg = this._create({ role: 'user', status: 'complete', content: normalizedContent, turnIndex: this.turnIndex });
      // Provenance for the notification classifier: promptSource = the CLI's
      // marker on HUMAN-submitted prompts (JSONL 'sdk'; our own live sends
      // stamp it too), isSynthetic = CLI-synthesized records (hook feedback on
      // the live stream). A user who literally types "Stop hook feedback: …"
      // must NOT get their message demoted to a dim notification card.
      // EXCEPT (2.229.2, real report "看不到后台任务唤醒"): the CLI stamps
      // promptSource:"sdk" on SYSTEM-GENERATED deliveries too — a background
      // task completing wakes the agent with a `<task-notification>` user
      // record whose authoritative marker is top-level origin.kind. typed
      // made it render as the USER'S OWN words (a "You" bubble of sanitized
      // XML ≈ invisible), so the wakeup had no trace in the chat. origin
      // wins over promptSource; the text-shape check covers transports that
      // drop the origin field.
      const contentStr = typeof raw.message?.content === 'string' ? raw.message.content : '';
      const isTaskNotif = raw.origin?.kind === 'task-notification' || /^\s*<task-notification>/.test(contentStr);
      if (isTaskNotif) {
        msg.originKind = 'task-notification';
        // CLOSE THE TASK LIFECYCLE (2.233.0, real report "popup 20条无完成
        // 状态"): in the current harness a background task's COMPLETION
        // signal is THIS user record — the system/task_notification subtype
        // that used to remove tasks from the status-bar tracker never
        // arrives for them, so tasks only accumulated. The wakeup names its
        // <tool-use-id> and <status>; route them into the same taskInfo
        // edit the old path used.
        this._closeTaskFromNotification(contentStr, emit);
      }
      else if (raw.origin?.kind === 'peer') {
        // Cross-session PEER message (2.349.0, owner report "announce了但对话
        // 框里什么都看不到"): a Background-Work notify / another session's
        // SendMessage wakes this conversation as a user record with
        // origin.kind='peer' (+ isMeta), which fell into the invisible-meta
        // path — the turn appeared to start from nothing. Same provenance law
        // as task-notification: origin.kind wins, render a distinct card.
        msg.originKind = 'peer-message';
        msg.peerFrom = peerDisplayName(raw.origin, (raw.message && (typeof raw.message.content === 'string' ? raw.message.content : (raw.message.content || []).map((b) => b.text || '').join('\n'))) || '');
        this._notePeerMsgId(raw.origin.msg_id);
      }
      else if (raw.originKind === 'auto-resume') { msg.originKind = 'auto-resume'; msg.typed = false; } // VibeSpace's own continue prompt (auto-resume) — labelled, never a "you typed this" bubble (2.369.32)
      else if (raw.promptSource || raw._fromWebui) msg.typed = true;
      if (raw.isSynthetic) msg.synthetic = true;
      if (emit) this._emit({ op: 'create', message: msg });
    }
  }

  _processAssistant(raw, emit) {
    const content = raw.message?.content;
    if (!Array.isArray(content) || !content.length) return;

    // Per-turn serving model — lets the UI detect silent auto-fallback
    // (harness swapped models mid-session; e.g. fable-5 → opus under load).
    const servedModel = raw.message?.model;
    // Per-message metadata for the left-strip right-click popup: which model
    // actually served this record, its token usage, and the request identity.
    const recMeta = {
      model: (servedModel && servedModel !== '<synthetic>') ? servedModel : null,
      usage: raw.message?.usage || null,
      requestId: raw.requestId || null,
      msgId: raw.message?.id || null,
      stopReason: raw.message?.stop_reason || null,
    };
    if (servedModel && servedModel !== '<synthetic>' && emit && servedModel !== this._lastServedModel) {
      this._lastServedModel = servedModel;
      this._emit({ op: 'meta', subtype: 'served-model', data: { model: servedModel } });
    }

    for (const block of content) {
      // Explicit fallback marker the CLI writes when it auto-switches models:
      // { type:'fallback', from:{model}, to:{model} } — surface it as a notice.
      if (block.type === 'fallback' && (block.from?.model || block.to?.model)) {
        const from = block.from?.model || '?', to = block.to?.model || '?';
        // Text kept as an English fallback; the CLIENT localizes it at render
        // time (renderSystemMsg, keyed on noticeKind) since language is a
        // per-device choice the server can't know. from/to ride the block.
        const msg = this._create({ role: 'system', content: [{ type: 'text', text: `⚠ Model auto-fallback: ${from} → ${to} (the harness switched models, e.g. capacity/overload; /model or the badge menu sets it back)`, fallbackFrom: from, fallbackTo: to }], noticeKind: 'model-fallback' });
        if (emit) this._emit({ op: 'create', message: msg });
        continue;
      }
      if (block.type === 'thinking') {
        // Claude's thinking blocks carry the text in `thinking`, not `text`
        const msg = this._create({ role: 'assistant', content: [{ type: 'thinking', text: block.thinking || block.text || '' }], meta: recMeta });
        if (emit) this._emit({ op: 'create', message: msg });

      } else if (block.type === 'text') {
        // Streaming detection: if last message is streaming assistant text, edit it
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'assistant' && last.status === 'streaming' && last.content[0]?.type === 'text') {
          last.content = [{ type: 'text', text: block.text || '' }];
          last.meta = recMeta; // later records of the same message carry the final usage
          if (emit) this._emit({ op: 'edit', id: last.id, fields: { content: last.content, meta: recMeta } });
        } else {
          this._finalizeStreaming(emit);
          const msg = this._create({ role: 'assistant', status: 'streaming', content: [{ type: 'text', text: block.text || '' }], meta: recMeta });
          if (emit) this._emit({ op: 'create', message: msg });
        }

      } else if (block.type === 'tool_use') {
        this._finalizeStreaming(emit);
        // TodoWrite → emit meta op so frontend can update display
        if (block.name === 'TodoWrite' && block.input?.todos && emit) {
          this._emit({ op: 'meta', subtype: 'todos', data: block.input.todos });
        }
        // Harness Task tools (TaskCreate/TaskUpdate) → same TODO display.
        // TaskCreate's id only appears in the RESULT text, so creation is
        // finalized in the tool_result merge below.
        if (block.name === 'TaskCreate' && block.input?.subject) {
          (this._pendingTaskCreates = this._pendingTaskCreates || new Map())
            .set(block.id, String(block.input.subject));
        } else if (block.name === 'TaskUpdate' && block.input?.taskId != null) {
          const t = this._harnessTasks?.get(String(block.input.taskId));
          if (t && block.input.status) {
            t.status = block.input.status;
            this._emitHarnessTodos(emit);
          }
        }
        // Tool ids key on the globally-unique toolCallId: the SAME tool_use
        // replayed from any transport (stdout buffer, JSONL rebuild, a
        // device-parsed history) lands on the SAME id — duplicates become
        // no-ops instead of double cards (R0 join guarantee).
        const msgId = `${this.sessionId}:t:${block.id}`;
        if (this.messageIndex.has(msgId)) {
          // already minted (replay overlap) — refresh the pending mapping so
          // a later tool_result still resolves it, and never re-create.
          if (!this.pendingToolCalls.has(block.id)) this.pendingToolCalls.set(block.id, { msgId, block });
          continue;
        }
        const msg = {
          id: msgId, role: 'tool', status: 'pending',
          content: [{ type: 'tool_call', toolCallId: block.id, toolName: block.name, input: block.input }],
          // _currentTs first (the assistant record's own timestamp): this
          // hand-rolled path bypassed _create's ts ladder and stamped every
          // rebuild-rendered tool card with the REBUILD time, not the tool
          // call time (caught by the R3 transcript parity suite — two parses
          // of one file disagreed on ts; live records without timestamps
          // still fall back to arrival time exactly as before).
          ts: this._currentTs || Date.now(), turnIndex: this.turnIndex,
          toolCallId: block.id, toolName: block.name, toolStatus: null,
          permission: null, usage: null, taskInfo: null, meta: recMeta,
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
    // But preserve tool calls with unresolved permissions — they're still waiting for user input
    const toRemove = [];
    for (const [toolUseId, pending] of this.pendingToolCalls) {
      const existing = this.messageIndex.get(pending.msgId);
      if (existing && existing.status === 'pending') {
        if (existing.permission && !existing.permission.resolved) {
          // Still waiting for permission — keep in pendingToolCalls for tool_result matching
          continue;
        }
        existing.status = 'error';
        existing.toolStatus = 'error';
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { status: 'error', toolStatus: 'error' } });
      }
      toRemove.push(toolUseId);
    }
    for (const id of toRemove) this.pendingToolCalls.delete(id);

    // Peer message whose ONLY stdout trace is this result record (inc-mt27t0bg,
    // userW: an inbox delivery — harness SendMessage / vibespace-msg / job
    // notify — opens the turn as command_lifecycle + the turn's records; the
    // user record with the sender's words is written to the JSONL only, so a
    // LIVE-attached window showed the agent replying to nothing). The terminal
    // result carries the full envelope in origin — synthesize the peer card
    // from it. Feeds that DID see the user/attachment record (JSONL rebuilds,
    // the device stream) marked origin.msg_id, so this rung dedups; the card
    // lands at turn end live (late but visible), in true order on any rebuild.
    // msg_id is the AUTHORITATIVE per-message identity when present — the
    // containment scan is ONLY for msg_id-less legacy records (review-caught:
    // AND-ing it unconditionally suppressed every repeat fire of a same-body
    // recurring notify, and any short body contained in recent typed text).
    const po = raw.origin;
    if (po && po.kind === 'peer' && typeof po.body === 'string' && po.body.trim()
      && (po.msg_id ? !this._peerMsgIds.has(po.msg_id) : !this._recentUserTextIncludes(po.body))) {
      this._notePeerMsgId(po.msg_id);
      const pm = this._create({ role: 'user', status: 'complete', content: [{ type: 'text', text: po.body }], turnIndex: this.turnIndex });
      pm.originKind = 'peer-message';
      pm.peerFrom = peerDisplayName(po, po.body);
      if (emit) this._emit({ op: 'create', message: pm });
    }
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
      const errorKind = classifyResultError(raw.result);
      if (errorKind) msg.errorKind = errorKind;
      if (emit) this._emit({ op: 'create', message: msg });
    }

    if (emit) {
      this._emit({ op: 'meta', subtype: 'turn_complete', data: { cost: raw.total_cost_usd || 0, modelUsage: raw.modelUsage || null } });
    }
  }

  // Deduce a permission's resolution from the tool_result that answered it.
  // is_error alone must NOT read as denied: a user-APPROVED tool that then
  // fails (nonzero exit, bad edit — hundreds per real transcript) is is_error
  // too, and labeling it "✗ Denied" misrecords the user's action
  // (review-confirmed). Only the CLI's canned user-rejection text is a denial.
  _resolutionFromResult(outputText, isError) {
    if (!isError) return 'allowed';
    return /user (doesn'?t want|rejected|declined|chose not)/i.test(outputText || '') ? 'denied' : 'allowed';
  }

  _processControlRequest(raw, emit) {
    if (raw.request?.subtype !== 'can_use_tool') return;
    const toolUseId = raw.request.tool_use_id;

    // Find the tool message — may be in pendingToolCalls (live) or already flushed (history replay)
    let existing = null;
    const pending = this.pendingToolCalls.get(toolUseId);
    if (pending) {
      existing = this.messageIndex.get(pending.msgId);
    } else {
      // Search backwards for the tool message by toolCallId (flushed by prior result during history replay)
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].toolCallId === toolUseId) { existing = this.messages[i]; break; }
      }
    }
    if (!existing) return;

    // A REAL tool_result (content already merged) means the permission
    // question was settled — never flip such a card back to pending. Only an
    // interrupt-FLUSHED tool (content still tool_call, errored by
    // _processResult) is "incorrectly flushed" and restorable. Without this
    // the [tool_use, tool_result, control_request] replay order (end-appended
    // buffer records after an anchorless merge) resurrected denied/errored
    // cards as awaiting-approval — the exact bug the merge auto-resolve fixes
    // for the other order (review-confirmed).
    const rblock = existing.content?.[0];
    const hasRealResult = rblock?.type === 'tool_result';
    if (existing.status === 'error' && !hasRealResult) {
      existing.status = 'pending';
      existing.toolStatus = null;
      if (emit) this._emit({ op: 'edit', id: existing.id, fields: { status: 'pending', toolStatus: null } });
    }

    // If the tool already ran, the permission was implicitly settled
    const autoResolved = hasRealResult
      ? this._resolutionFromResult(rblock.output, rblock.status === 'error')
      : (existing.status === 'complete' ? 'allowed' : null);

    const isAskUser = raw.request.tool_name === 'AskUserQuestion';
    existing.permission = {
      requestId: raw.request_id,
      toolName: raw.request.tool_name,
      input: raw.request.input || {},
      suggestions: raw.request.permission_suggestions || [],
      resolved: autoResolved,
      ...(isAskUser && { kind: 'user_input', questions: raw.request.input?.questions || [] }),
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

MessageManager._seenUnknownSubtypes = new Set();
/** Background-launch ACK → task identity, PURE (2.368.30, owner: "很多
 *  subagent任务你没识别出来"). task_started/task_progress/task_notification
 *  are LIVE-STREAM-ONLY subtypes — a 602MB field transcript carries ZERO —
 *  so anything derived from them dies on the first resume. The launch ack
 *  itself names the task; both the normalizer and session-store's taskState
 *  scan derive from IT (one parser, no twin). */
function parseBackgroundLaunch(toolName, input, resultText) {
  const txt = String(resultText || '');
  if (toolName === 'Agent' && /^Async agent launched/.test(txt)) {
    return { id: txt.match(/agentId:\s*([a-z0-9]+)/)?.[1] || null, type: 'agent', description: String(input?.description || '').slice(0, 120) };
  }
  if (toolName === 'Workflow') {
    const rid = txt.match(/Run ID:\s*(wf_[\w-]+)/)?.[1];
    if (!rid) return null;
    const nm = txt.match(/Workflow ["\u201c]([^"\u201d\n]+)["\u201d]/)?.[1] || input?.name || 'workflow';
    return { id: rid, type: 'workflow', description: String(nm).slice(0, 120) };
  }
  const bg = txt.match(/^Command running in background with ID:\s*([\w-]+)/);
  if (bg) return { id: bg[1], type: 'command', description: String(input?.description || input?.command || '').slice(0, 120) };
  return null;
}

// peerDisplayName is shared with the codex normalizer (design-harness-plugins
// §1 P1): the server frames it parses are backend-neutral text, and a codex
// rollout copy of a peer message carries ONLY that text.
module.exports = { splitToolResultContent, MessageManager, classifyResultError, parseBackgroundLaunch, peerDisplayName };
