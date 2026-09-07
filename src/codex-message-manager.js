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

const { peerDisplayName } = require('./message-manager');
// web-search cards: the ONE results renderer + the twin-dedup key (PURE, shared with the client's title chip)
const { renderSearchOutput, searchActionKey, NO_SEARCH_DETAILS } = require('./search-card');
const { agentName, collabSummaryText } = require('./collab-row');

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// ── 0.153 multi-agent v2 (B-7473) ──
// The inter-agent ENVELOPE codex puts in front of every sub-agent ↔ root
// message. Mirrored in data/bin/codex-chat-wrapper.js (a shipped single file
// that cannot require this module) — keep the two in lockstep.
//   Message Type: FINAL_ANSWER
//   Task name: /root
//   Sender: /root/usecases_v4
//   Payload:
//   <the actual report>
const AGENT_ENVELOPE_RE = /^Message Type:[ \t]*([A-Z_]+)\r?\n(?:Task name:[ \t]*(\S*)\r?\n)?Sender:[ \t]*(\S+)\r?\n(?:Payload:[ \t]*\r?\n?)?/;
function parseAgentEnvelope(text) {
  const s = String(text || '');
  const m = AGENT_ENVELOPE_RE.exec(s);
  if (!m) return null;
  return { msgType: m[1], taskName: m[2] || '', sender: m[3], body: s.slice(m[0].length) };
}

// The collaboration tool family (codex-rs CollabAgentTool + the wrapper's
// snake_case names). These are ORCHESTRATION, not work: they render as
// one-line collab rows, never as tool cards with an (encrypted) payload.
const COLLAB_TOOL_DIRS = {
  spawn_agent: 'spawn',
  send_message: 'out',
  followup_task: 'out',
  send_input: 'out',
  interrupt_agent: 'out',
  resume_agent: 'out',
  close_agent: 'out',
  list_agents: 'out',
  wait: 'wait',
  wait_agent: 'wait',
};
const COLLAB_MSG_TYPES = {
  send_message: 'message',
  followup_task: 'followup',
  send_input: 'input',
  interrupt_agent: 'interrupt',
  resume_agent: 'resume',
  close_agent: 'close',
  list_agents: 'list',
};
// ONE IDENTITY PER SUB-AGENT (round-5 fix, measured on the owner's real
// 0.153.4 root rollout, 4768 records): codex names the SAME child two ways.
// The OUTBOUND side — a `send_message` / `followup_task` / `spawn_agent`
// call's own arguments — carries a BARE `task_name` ("interior_research"),
// while every inbound message, every spawn OUTPUT ({"task_name":"/root/x"} —
// that is the proof of the intended shape) and every SubAgentActivity record
// carries the absolute agent path ("/root/interior_research"). Keying rows on
// the raw value split each agent in two: 35 distinct row paths for 19 real
// children, the fold header drew the same agent as two chips, the sub-agents
// count over-reported, and the agentPath→threadId map (absolute keys) never
// matched an outbound row — 97 of 402 rows carried no thread id and so had NO
// click-through. Normalising at the ONE place a row is built means every
// consumer (chips, map lookup, back-fill, summary) sees one identity.
// A value that already has a '/' is left alone (a nested child stays nested).
function absAgentPath(name, ownPath) {
  const s = String(name || '').trim();
  if (!s || s.includes('/')) return s;
  const own = String(ownPath || '').trim() || '/root';
  return `${own.replace(/\/+$/, '')}/${s}`;
}

// An encrypted payload must never reach a rendered string: only these argument
// keys may be shown, and `message` (the fernet blob) is deliberately absent.
function collabDetailOf(input) {
  if (!input || typeof input !== 'object') return '';
  const raw = input.prompt || input.description || input.instructions || '';
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

// Server-posted peer frames, ANCHORED at the start of a user message's text
// (agent-routes msg/send + job-model notify are the two frame builders). A
// codex ROLLOUT copy of a delivered peer message carries nothing but this
// text — no origin field (claude's CLI stamps origin.kind='peer'; codex's
// rollout has no such notion) — so a rebuild must recognise the frame alone.
// Anchored so a user QUOTING a frame mid-text never turns into a peer card.
const SERVER_PEER_FRAME_RE = /^\s*(?:Message from session "[^"]+" \(via vibespace-msg|\[VibeSpace Background Work\] )/;

// Peer-record detection for a codex user item (design-harness-plugins §1 P1).
// Two carriers, in precedence:
//   ① the wrapper's out-of-band marker `webui_peer: {name, body}` — written
//     by the rpc-queue lane (codex-chat-wrapper 'peer-message' verb) into ITS
//     OWN buffer record with the delivery site's fromName/cardText: the party
//     holding the information writes it (the 2.362.2 law). Present on the
//     BUFFER copy only; recordKey + mergeCodexRecords strip it so the buffer
//     copy and codex's rollout copy of the same user message still collide.
//   ② the server frame shape (SERVER_PEER_FRAME_RE) — the ROLLOUT copy, an
//     OLD wrapper's unmarked record, and whichever twin mergeCodexRecords
//     kept on a rebuild: label parsed by the shared peerDisplayName (claude
//     rebuild parity; unknown frame ⇒ generic "another session" label).
// Typed messages (webui_msg_id — the user's own words, auto-resume's
// continuation line) are never peer records, whatever their text looks like.
function peerRecordOf(item, content) {
  const marker = item.webui_peer && typeof item.webui_peer === 'object' ? item.webui_peer : null;
  const text = content.map((b) => b.text || '').join('\n');
  if (!marker && !SERVER_PEER_FRAME_RE.test(text)) return null;
  const body = marker && typeof marker.body === 'string' && marker.body.trim() ? marker.body : null;
  const from = marker && marker.name ? String(marker.name) : peerDisplayName(null, text);
  return { content: body ? [{ type: 'text', text: body }] : content, from };
}

function toTs(value) {
  if (!value) return Date.now();
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : Date.now();
}

// The RECORD's own clock, or null when it has none / it is unparseable. toTs()
// silently substitutes Date.now(), which is right for a message's `ts` but
// wrong for a collab row's provenance: "when did this happen" and "when did we
// see it" are different answers and the row title says which (2026-09-07).
function recordTs(value) {
  if (!value) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
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
  if (name === 'exec_command' || name === 'exec') return 'Bash'; // 0.149.x renamed the tool to bare 'exec'
  if (name === 'apply_patch') return 'Patch';
  if (name === 'write_stdin') return 'Terminal';
  if (name === 'wait_agent') return 'Agent Wait';
  if (name === 'send_input') return 'Agent Input';
  if (name === 'resume_agent') return 'Agent Resume';
  if (name === 'close_agent') return 'Agent Close';
  return String(name);
}

// A finished sleep's total, as the card's own output text. The ONE place a
// duration becomes words on the server side — the renderer's countdown formats
// a different thing (time REMAINING) and never re-derives this.
function formatSleptMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = Math.round(total % 60);
  return h ? `${h}h ${m}m` : `${m}m ${sec}s`;
}

// 0.153.4 ImageView items carry the file as a `file:///…` URL (percent-encoded);
// cards and the renderer's /api/file/raw thumbnail want the plain path. Only
// the local forms (empty or `localhost` authority) are understood — anything
// else (a real remote authority) is handed back untouched rather than turned
// into a bogus relative path.
function fileUrlToPath(p) {
  if (typeof p !== 'string') return '';
  if (!/^file:\/\//i.test(p)) return p;
  const bare = p.replace(/^file:\/\/(localhost)?/i, '');
  if (!bare.startsWith('/')) return p;
  try { return decodeURIComponent(bare); } catch { return bare; }
}

// ONE tool-input parser for BOTH call record types (function_call carries
// `arguments`, custom_tool_call carries `input` — apply_patch arrives as
// EITHER depending on channel: live buffer = function_call with structured
// JSON {reason, changes:[{path, kind, diff}]}, rollout = custom_tool_call
// with the "*** Add/Update/Delete File:" envelope; the first fix only
// covered the custom branch and live sessions still had no file names).
function parseToolInput(name, rawInput) {
  if (name !== 'apply_patch') return safeJsonParse(rawInput, rawInput);
  const rawStr = typeof rawInput === 'string' ? rawInput : null;
  const j = rawStr && rawStr.trim().startsWith('{') ? safeJsonParse(rawStr, null)
    : (rawInput && typeof rawInput === 'object' ? rawInput : null);
  if (j && Array.isArray(j.changes)) {
    const files = j.changes.map((c) => c && c.path).filter(Boolean);
    const word = (t) => t === 'add' ? 'Add' : t === 'delete' ? 'Delete' : 'Update';
    const patch = j.changes.map((c) => `*** ${word(c?.kind?.type)} File: ${c?.path || '?'}\n${c?.diff || ''}`).join('\n');
    return { ...j, patch, ...(files.length ? { files, file_path: files[0] } : {}) };
  }
  const patch = rawStr ?? JSON.stringify(rawInput ?? '');
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const inp = { patch };
  if (files.length) { inp.files = files; inp.file_path = files[0]; }
  return inp;
}

// Semantic collapse-kind (Track B, design-backend-parity.md §5): the chat
// view's run folding must never know backend tool names — the normalizer owns
// the semantics. Keys reuse the existing settings vocabulary ('bash' = any
// command execution). null = never folds (visible work: plan updates, images).
function collapseKindOf(rawName) {
  const n = String(rawName || '').toLowerCase();
  if (n === 'exec' || n === 'exec_command' || n === 'shell' || n === 'local_shell' || n === 'write_stdin') return 'bash';
  if (n === 'apply_patch') return 'write';
  if (/^(spawn_agent|wait_agent|send_input|resume_agent|close_agent|list_agents|send_message|interrupt_agent|followup_task)$/.test(n) || n.startsWith('agent')) return 'agent';
  if (n === 'web_search' || n === 'web_fetch') return 'search'; // web research folds with claude's WebSearch (2.369.33, owner report)
  if (n === 'view_image') return 'image'; // image views fold as their own kind (2.369.34, owner ask)
  // deliberately VISIBLE work (plans, generated images, and a `clock.sleep` —
  // a 20-minute wait folded into an "N tool calls" summary is exactly how a
  // deliberate pause reads as a hang)
  if (n === 'update_plan' || n === 'image_gen' || n === 'sleep' || !n) return null;
  // everything else = an external/dynamic tool (codex plugins, browser tools,
  // MCP-class) — same semantic bucket as claude's MCP kind. Unknown names used
  // to return null and BREAK the surrounding fold (owner: 乱七八糟的卡片).
  return 'mcp';
}

// ── 0.153 RECORD TOLERANCE (B-21e4 item 2) ──
// Every rollout line type / response_item type / event_msg type is either
// HANDLED, deliberately SKIPPED (named below — no card, no telemetry) or
// UNKNOWN: reported ONCE per process as telemetry `codex-unknown-record:<type>`
// (Diagnostics shows the next upstream addition instead of waiting for a
// report — the 2.227.5 invisible-record class) and then skipped. Neither ever
// breaks the surrounding fold (a stray system card splits a run) nor drops the
// turn around it. Names enumerated from codex-rs protocol.rs (RolloutItem /
// ResponseItem / EventMsg, snake_case) + every local rollout since 0.142.
const SKIPPED_RECORD_TYPES = new Set([
  'world_state',                        // 0.153 environment/skills snapshot — not conversation content
  // token_usage_record is HANDLED (not skipped) since the per-message meta
  // work: it names the vendor response id for the token_count that follows
  'inter_agent_communication_metadata', // {trigger_turn} marker preceding an agent_message item
  'compacted',                          // the compaction summary line; event_msg context_compacted renders the notice
]);
const SKIPPED_RESPONSE_ITEM_TYPES = new Set([
  'additional_tools', 'configuration_update', 'compaction', 'context_compaction', 'other',
]);
// item_completed item.TYPEs this handler deliberately renders NOTHING for — each
// one's twin (or, for ContextCompaction, the reason it stays unrouted) is named
// in the census above _processItemCompleted. A type NOT in here and not routed
// fires telemetry; the set is exported so the gate can pin it.
const ITEM_COMPLETED_SKIPPED_TYPES = new Set([
  'Reasoning', 'AgentMessage', 'CollabAgentToolCall', 'CommandExecution', 'FileChange', 'UserMessage', 'ContextCompaction',
]);

const SKIPPED_EVENT_TYPES = new Set([
  // twins of records already rendered from the response_item stream
  // (item_completed = the GENERIC skip — _processItemCompleted runs FIRST, at
  // the top of _processEvent, and routes the item kinds a 0.153.4 rollout
  // persists nowhere else: Extension web.search / image_gen.generation,
  // ImageView and — B-7473 — SubAgentActivity, the ONLY rollout carrier of
  // sub-agent lifecycle there; unknown kinds get telemetry
  // codex-unknown-record:item_completed:<type>)
  'user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'raw_response_item', 'raw_response_completed', 'item_started', 'item_completed',
  'agent_message_content_delta', 'reasoning_content_delta', 'reasoning_raw_content_delta', 'plan_delta',
  // tool lifecycle noise — the function_call / function_call_output pair is the card
  'exec_command_begin', 'exec_command_end', 'exec_command_output_delta', 'exec_approval_request', 'apply_patch_approval_request', 'patch_apply_begin', 'patch_apply_updated',
  // (web_search_begin / web_search_end are HANDLED — a rollout persists the search ONLY there, 2.369.43)
  // (view_image_tool_call is HANDLED too — the ≤0.130 engine's own record of an
  // image view, and the ONLY trace of it when the function_call pair is absent)
  'mcp_tool_call_begin', 'mcp_tool_call_end', 'image_generation_begin', 'image_generation_end', 'turn_diff', 'terminal_interaction',
  'collab_agent_spawn_begin', 'collab_agent_spawn_end', 'collab_agent_interaction_begin', 'collab_agent_interaction_end',
  // wrapper / engine side channels consumed elsewhere (pool engine, goal sync, usage meter, delivery ladder)
  'rate_limits_updated', 'goal_updated', 'goal_cleared', 'thread_goal_updated', 'thread_queue_changed', '_remote_state', 'peer_message_result', 'reset_credit_result',
  // webui_user_retracted = the wrapper telling the READER that a user record it
  // already wrote will never be committed by the app-server (round 3). It is a
  // merge-time fact about the claim ledger (mergeCodexRecords), never a card:
  // the bubble it names STAYS — the user really did send that text.
  'webui_user_retracted',
  'error', 'warning', 'stream_error', 'deprecation_notice', 'mcp_startup_update', 'mcp_startup_complete', 'session_configured', 'hook_started', 'hook_completed', 'thread_rolled_back', 'shutdown_complete',
]);

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

// The wrapper's one-word label for the reply it SENT. Since 2.369.58 the five
// ServerRequest methods answer in their own vocabularies, so the allow set
// spans all of them: the exec/patch v1 enum (approved…), the item approval enum
// (accept…), the elicitation action, and the permissions GRANT.
function isAllowedServerDecision(decision) {
  if (!decision) return false;
  if (typeof decision === 'string') {
    return decision === 'approved'
      || decision === 'approved_for_session'
      || decision === 'approved_execpolicy_amendment'
      || decision === 'accept'
      || decision === 'acceptForSession'
      || decision === 'acceptWithExecpolicyAmendment'
      || decision === 'applyNetworkPolicyAmendment'
      || decision === 'network_policy_amendment'
      || decision === 'granted';
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
  // opts.threadId = the READER's thread id (the rollout being rendered) — the
  // DEFAULT ledger thread id for records that carry no file provenance (gap
  // slabs, tail-only reads, the live stream/buffer). A record a reader merged
  // carries its OWN file's id (`__threadId`, codex-session-store.
  // tagRecordThread) and keys by that; the wrapper's wrapper_meta.threadId
  // re-points the default in-stream (a mid-life thread/fork). It is a default,
  // not a lock — see _adoptThreadId for the precedence and the two real-data
  // refutations behind it.
  constructor(sessionId, { threadId } = {}) {
    this.sessionId = sessionId;
    this.seq = 0; // rebuild belt only (R0 — ids are content-derived)
    this._rkCounts = new Map();
    this._currentRk = null;
    this.messages = [];
    this.messageIndex = new Map();
    this.userMessageIds = new Map();
    // THE INPUT QUEUE (session state, never a transcript message): the wrapper
    // publishes the WHOLE queue on every change; `_queuedMsgIds` is the set of
    // bubbles currently wearing a 'queued' chip, so one that leaves the queue
    // without an explicit steer/remove can have its chip cleared — it RAN.
    this._queue = [];
    this._queuedMsgIds = new Set();
    // Has THIS wrapper ever published a queue? A `queue_changed` (every new
    // wrapper emits a baseline one at boot) is the in-band proof. Without it
    // the chip has no way to ever clear or be acted on, so `queued_input`
    // falls back to the old system card — a codex session spawned before the
    // queue/steer release must not wear a permanent, dead 'Queued' badge.
    this._queuePublished = false;
    this._queueVerbs = null;              // the verb list that publication named (null = a pre-verb-table wrapper)
    this.pendingToolCalls = new Map();
    this.toolCallMessageIds = new Map();
    this.pendingApprovals = new Map();
    this.streamingAgentMessages = new Map();
    this.streamingReasoningMessages = new Map();
    this.listeners = [];
    this.turnIndex = 0;
    this._currentTurnId = null;
    this._currentTs = Date.now();
    this._currentTsKind = 'arrival'; // provenance of _currentTs (see recordTs)
    // Per-message meta state (see _threadUsageMeta): the codex thread id (the
    // ledger's `cx:<thread>:<cumulative>` request key needs it — see
    // _adoptThreadId for the precedence), the 0.153 token_usage_record awaiting
    // its token_count twin, the message index the last usage-bearing
    // token_count closed at, and the last ledger key threaded (codex re-emits
    // IDENTICAL token_counts — 369/8490 in the local corpus — which must
    // neither re-stamp nor advance the mark, exactly as the walker dedups).
    this._threadId = threadId ? String(threadId) : null;
    this._recordThreadId = null; // FILE provenance of the record being processed (merged reads tag each record; null = use the default above)
    this._pendingUsageRecord = null;
    this._usageMark = 0;
    this._lastRidKeys = new Map(); // thread id → the last ledger key minted under it (the walker's per-FILE cur.lastRid; a merged read interleaves files)
    // Every ledger key this normalizer minted, in order ({rid, mid, n, tid} —
    // n = messages stamped; n=0 is a CARDLESS response: back-to-back
    // token_counts with no item, an agent_message event with no response_item
    // twin — 215 of 835 responses in one real sub-agent rollout; tid = the
    // file the key belongs to). The corpus gate demands this set EQUALS the
    // walker's rid set for the same file; a per-message check alone could
    // never see the cardless ones. Tiny (one small object per model
    // response); never serialized.
    this._ledgerKeys = [];
    this._status = {
      model: '',
      permissionMode: '',
      permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
      contextWindow: 0,
      lastUsage: null,
      total_cost_usd: 0,
      // TWO effort facts (2.369.62): `effort` = what the CURRENT (or last) turn
      // is running at — the value baked onto that turn's message meta — and
      // `effortNext` = the pick that applies from the next turn. Conflating them
      // is how a turn codex ran at 'ultra' reported 'xhigh' per message.
      effort: null,
      effortNext: null,
      subagentMetas: [],
      // B-7473: agentPath → agentThreadId, learned from SubAgentActivity
      // (0.153.4's only carrier of a child's thread id). The client uses it to
      // open a sub-agent's rollout WITHOUT a server lookup.
      subagents: {},
      agentPath: '',
    };
    // collab bookkeeping (B-7473)
    this._collabByCall = new Map();   // call_id → { msgId, row } (spawn/send/wait rows awaiting their output)
    this._collabSeen = new Set();     // sub-agent activity twins (live event + rollout item carry the same item id)
    this._agentMsgSeen = new Map();   // turn-scoped (author, payload) → msgId — live twin vs rollout twin
  }

  // R0 (docs/design-three-tier.md): content-derived ids — same contract as
  // the claude normalizer (_nextId there). The record key is a hash of the
  // record's MERGE FINGERPRINT shape (volatile item_id/itemId/id stripped —
  // exactly the fields whose presence differs between the wrapper buffer copy
  // and the rollout JSONL copy of one item), so a rebuild reproduces the same
  // ids and cross-transport twins collide instead of double-rendering.
  _nextId() {
    const rk = this._currentRk || ('s' + this.seq);
    this.seq++;
    const n = this._rkCounts.get(rk) || 0;
    this._rkCounts.set(rk, n + 1);
    return `${this.sessionId}:${rk}${n ? '.' + n : ''}`;
  }

  static recordKey(record) {
    const payload = record?.payload || record || {};
    // webui_peer = the wrapper's peer marker (buffer copy only) — stripped so
    // the buffer and rollout copies of one peer message mint the SAME id.
    // webui_queue_id / webui_queue_via (2026-09-07) are the same kind of marker
    // on the bubble the wrapper writes for an INHERITED queue submission
    // entering the turn: only ONE of the two copies survives the merge (either
    // can win, see mergeCodexRecords), so the id must not depend on which.
    // thread_id/turn_id are the wrapper's B-7473 item context: only the LIVE
    // copy carries them, so leaving them in would make every buffer record a
    // stranger to its rollout twin (double cards on every attach).
    const { item_id, itemId, id, internal_chat_message_metadata_passthrough, webui_peer, webui_queue_id, webuiQueueId, webui_queue_via, webuiQueueVia, webui_after_commit, webuiAfterCommit, webui_no_commit, webuiNoCommit, thread_id, turn_id, ...stable } = payload;
    let str;
    try { str = (record?.type || '') + ':' + JSON.stringify(stable); } catch { str = String(record?.type || ''); }
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return 'h:' + h.toString(36) + ':' + str.length;
  }

  onOp(fn) { this.listeners.push(fn); }
  offOp(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
  _emit(op) { for (const fn of this.listeners) fn(op); }

  // SERVER-SIDE peer card — the codex twin of MessageManager.injectPeerCard
  // (design-harness-plugins §1 P1: its absence made normalizers.feedPeerCard
  // return false for every codex session, so auto-resume notices, Background
  // Work stash drains and vibespace-msg cards never rendered in codex chats).
  // SAME card shape: role user + status complete + originKind 'peer-message'
  // + peerFrom — the renderer (chat-renderers _renderPeerMsg) is backend-
  // neutral. Writers: auto-resume notify, the four stash-drain sites, every
  // non-rpc delivery lane's cardOk. In-memory only by design — never a
  // record, so a rebuild cannot double it. The rpc-queue lane does NOT use
  // it: there the wrapper's own buffer record is the carrier (peerRecordOf)
  // and a second card here would double-render live. Containment-free: the
  // delivery site posts once per fire (same-body repeats are legitimate).
  injectPeerCard({ fromName, text }) {
    const body = String(text || '').trim();
    if (!body) return null;
    this._currentRk = null; // outside any record context — take the s-fallback id, never the last record's key
    this._currentTs = Date.now();
    this._currentLine = null; // no source line: the card is not in any transcript
    this.turnIndex++;
    const msg = this._create({ role: 'user', status: 'complete', content: [{ type: 'text', text: body }], turnIndex: this.turnIndex });
    msg.originKind = 'peer-message';
    msg.peerFrom = fromName ? String(fromName) : null;
    this._emit({ op: 'create', message: msg });
    return msg;
  }

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
      if (m.isCompact) { entry.isCompact = true; entry.preview = 'Context compacted'; }
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
    // Finalize goal state: if auto-continue messages were found, goal is active
    if (this._goalActive && this._goalCondition) {
      this._goalState = { condition: this._goalCondition, met: false, sentinel: false };
    }
    return this.messages;
  }

  /** Time-sliced twin of convertHistory (see MessageManager.convertHistoryAsync). */
  async convertHistoryAsync(records, { budgetMs = 25, onSlice } = {}) {
    let sliceStart = Date.now(), done = 0;
    for (const record of records || []) {
      // per-record isolation (review-caught: one bad rollout record rejected
      // the whole rebuild for every attached window)
      try { this._processRecord(record, false); }
      catch (e) { console.error('[codex-normalizer] record skipped during history rebuild:', e.message); }
      done++;
      if (Date.now() - sliceStart >= budgetMs) {
        try { onSlice?.(done); } catch { }
        await new Promise((r) => setImmediate(r));
        sliceStart = Date.now();
      }
    }
    this._finalizeStreaming(false, { includeReasoning: true });
    if (this._goalActive && this._goalCondition) {
      this._goalState = { condition: this._goalCondition, met: false, sentinel: false };
    }
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
      srcLine: this._currentLine,
      turnIndex: fields.turnIndex ?? this.turnIndex,
      toolCallId: fields.toolCallId || null,
      toolName: fields.toolName || null,
      toolStatus: fields.toolStatus || null,
      permission: fields.permission || null,
      usage: fields.usage || null,
      taskInfo: fields.taskInfo || null,
      backendMeta: fields.backendMeta || null,
      collapseKind: fields.collapseKind || null, // semantic run-fold kind (Track B) — the chat view folds by THIS, never by backend tool names
      meta: fields.meta || null, // per-response metadata for the message-info popup — threaded by _threadUsageMeta at token_count (claude parity: MessageManager._create)
    };
    this.messages.push(msg);
    this.messageIndex.set(msg.id, msg);
    return msg;
  }

  _finalizeStreaming(emit, { includeReasoning = false } = {}) {
    // Backward scan, stop at the previous user message: streaming messages can
    // only exist in the current turn. The old full forward scan made history
    // conversion O(n²) — called per user message, this was millions of
    // iterations for multi-thousand-message sessions (cf. the Claude manager,
    // which always scanned backwards).
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      // A peer card is NOT a turn boundary: a queued peer message
      // (thread/queue/add while a turn runs) or an injected notice lands
      // MID-turn, and stopping the scan there left the active turn's open
      // streams 'streaming' forever at task_complete. `midTurn` is the same
      // statement for the bubble of an INHERITED queue submission (steered into
      // the running turn / drained into one that just started): both are
      // messages that entered a turn without beginning it, and neither closes
      // the streams it landed among, so neither may hide them from this scan.
      if (m.role === 'user' && m.originKind !== 'peer-message' && !m.midTurn) break;
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
    this._currentRk = CodexMessageManager.recordKey(record);
    if (!record || typeof record !== 'object') return;
    const exactTs = recordTs(record.timestamp);
    this._currentTs = exactTs != null ? exactTs : Date.now();
    this._currentTsKind = exactTs != null ? 'record' : 'arrival';
    this._currentLine = Number.isFinite(record.__line) ? record.__line : null; // source file line (gap loads only)
    this._recordThreadId = typeof record.__threadId === 'string' && record.__threadId ? record.__threadId : null; // FILE provenance (a merged read tags each record with the rollout it came from)
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
      return;
    }
    if (record.type === 'token_usage_record') {
      this._processTokenUsageRecord(record.payload || {});
      return;
    }
    if (SKIPPED_RECORD_TYPES.has(record.type)) return;
    this._noteUnknown('record', record.type);
  }

  // 0.153 per-response ledger record {thread_id, turn_id, response_id:'resp_…',
  // usage, turn_token_usage, thread_token_usage}. It PRECEDES the event_msg
  // token_count of the same response by 1–5 lines (830/830 real pairs: same
  // turn_id, usage.total_tokens === last_token_usage.total_tokens, only tool
  // outputs / item_completed noise in between — never a new response item), so
  // it is held here and consumed by the next usage-bearing token_count, which
  // verifies the total before adopting the response id. No card, no telemetry.
  _processTokenUsageRecord(payload) {
    this._adoptThreadId(payload.thread_id); // fills a void only — a copied parent record never re-points the key
    const u = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
    this._pendingUsageRecord = {
      responseId: payload.response_id ? String(payload.response_id) : null,
      turnId: payload.turn_id || null,
      total: u && typeof u.total_tokens === 'number' ? u.total_tokens : null,
    };
  }

  // ── Per-message metadata (owner 2026-09-06: "codex会话是不是依然看不到每条消息
  // 的详细信息、计费账号、使用模型"). Codex never stamps usage on a message item —
  // the numbers arrive as ONE token_count per model response, AFTER the
  // response's items (real 0.153.4 rollouts: reasoning/message/function_call
  // items → token_usage_record → tool outputs → token_count). So a response's
  // meta is attached to every assistant/tool message created since the
  // previous usage-bearing token_count — the codex equivalent of the claude
  // normalizer threading one recMeta onto every block of one assistant
  // record. SAME SHAPE as claude's meta so the popup and the rid-info route
  // stay backend-neutral, plus honest kind markers:
  //   requestId = `cx:<threadId>:<cumulative total_tokens>` — derived EXACTLY
  //     the way the ledger mints it (usage-walker.js codex block; that
  //     synthetic key is baked into every already-scanned rollout and is the
  //     only join they have; requestIdKind:'ledger' — never passed off as a
  //     vendor id);
  //   msgId = the vendor response id (`resp_…`) from the preceding
  //     token_usage_record (msgIdKind:'response'; absent on pre-0.153
  //     rollouts and on the live v2 stream, which carries no such record);
  //   usage: input_tokens = FRESH input (input − cached = the ledger's `i`),
  //     cache_read_input_tokens = cached, the cache-write count under BOTH the
  //     claude-parity name and codex's own cache_write_input_tokens,
  //     reasoning_output_tokens kept (a share of output_tokens);
  //   effort = the turn's reasoning effort (turn_context / thread settings).
  // Live: the same 'edit' op claude uses refreshes an open window's popup.
  _threadUsageMeta(last, total, emit) {
    if (!last || typeof last !== 'object') return;
    const num = (o, a, b) => { const v = o[a] ?? o[b]; return v == null ? null : (Number(v) || 0); };
    const input = num(last, 'input_tokens', 'inputTokens') || 0;
    const output = num(last, 'output_tokens', 'outputTokens') || 0;
    if (!input && !output) return; // heartbeat / empty — not a model response (the walker skips these too)
    const cached = num(last, 'cached_input_tokens', 'cachedInputTokens') || 0;
    const cacheWrite = num(last, 'cache_write_input_tokens', 'cacheWriteInputTokens') || 0;
    const reasoning = num(last, 'reasoning_output_tokens', 'reasoningOutputTokens');
    const lastTotal = num(last, 'total_tokens', 'totalTokens');
    const cumTotal = total && typeof total === 'object' ? num(total, 'total_tokens', 'totalTokens') : null;
    // DUPLICATE token_count (same cumulative total ⇒ same ledger rid): codex
    // re-emits the previous response's token_count after later items (real
    // window: token_count → item_completed → assistant message → identical
    // token_count → token_usage_record → next token_count). Stamping here
    // would hand the PREVIOUS response's key/numbers to the NEXT response's
    // messages and advance the mark past them for good (45/1143 messages wrong
    // in the local corpus). The walker returns on `rid === cur.lastRid`; so do
    // we — before touching the pending record or the mark.
    // THREAD ID = the record's own FILE when the reader tagged it (a merged
    // fork read: parent-half records key `cx:<parent>:…` exactly as the walker
    // keys the parent file), else the default (see _adoptThreadId). The
    // duplicate mark is kept PER thread — the walker's cursor is per file.
    const tid = this._recordThreadId || this._threadId || null;
    const ridKey = cumTotal != null ? `${tid || ''}:${cumTotal}` : null;
    if (ridKey && ridKey === this._lastRidKeys.get(tid || '')) return;
    if (ridKey) this._lastRidKeys.set(tid || '', ridKey);
    const pend = this._pendingUsageRecord;
    this._pendingUsageRecord = null; // consumed by this token_count, matched or not
    const responseId = pend && pend.responseId && (pend.total == null || lastTotal == null || pend.total === lastTotal) ? pend.responseId : null;
    const meta = {
      model: this._status.model || null,
      usage: {
        input_tokens: Math.max(0, input - cached),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: cacheWrite,
        cache_write_input_tokens: cacheWrite,
        output_tokens: output,
        ...(reasoning != null ? { reasoning_output_tokens: reasoning } : {}),
      },
      requestId: tid && cumTotal != null ? `cx:${tid}:${cumTotal}` : null,
      requestIdKind: 'ledger',
      msgId: responseId,
      msgIdKind: responseId ? 'response' : null,
      stopReason: null,
      effort: this._status.effort || null,
    };
    let stamped = 0;
    for (let i = this._usageMark; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role !== 'assistant' && m.role !== 'tool') continue; // user / peer / system records carry no response usage
      m.meta = meta;
      stamped++;
      if (emit) this._emit({ op: 'edit', id: m.id, fields: { meta } });
    }
    this._usageMark = this.messages.length;
    this._ledgerKeys.push({ rid: meta.requestId, mid: meta.msgId, n: stamped, tid: tid || null });
  }

  // Once-per-process breadcrumb for an upstream type this normalizer does not
  // know (mirrors MessageManager's cli-unknown-system-subtype). Name-only.
  _noteUnknown(kind, type) {
    const key = `${kind}:${type || '(untyped)'}`;
    if (CodexMessageManager._seenUnknownRecords.has(key)) return;
    CodexMessageManager._seenUnknownRecords.add(key);
    try { global.__vsEvent?.('codex-unknown-record:' + String(type || '(untyped)').slice(0, 48), kind); } catch {}
  }

  // The ledger thread id of a record = the FILE it came from (the walker keys a
  // rollout by its filename uuid). A record the reader merged carries that as
  // `__threadId` (codex-session-store.tagRecordThread) and never consults this
  // default. For PROVENANCE-LESS records (gap slabs, tail-only reads, the live
  // stream and the wrapper buffer) the DEFAULT is, in order:
  //   · a constructor threadId — the reader names the file it opened. A
  //     default, NOT a lock: an absolute pin keyed every parent-half record of
  //     a merged fork read `cx:<child>:…` (0/30 parent messages matched the
  //     parent file's ledger, two collided with real child events — round-3
  //     verifier, byte copies of two real rollouts);
  //   · wrapper_meta.threadId — the wrapper's OWN record naming the file it
  //     writes NOW; a mid-life thread/fork re-points it, constructor id or not
  //     (the live stream after a re-point minted `cx:<old>:…` while the walker
  //     keyed the new file). codex-events re-points session.backendSessionId
  //     on the same record and the normalizer follows it IN-STREAM through
  //     feedLive — ordering-correct across a rebuild queue, which a direct
  //     re-pin from the consumer would not be;
  //   · the FIRST session_meta of the stream fills a void only — a sub-agent
  //     rollout carries its own at line 0 and the PARENT's at line 1 (29/79
  //     local rollouts; 79/79 have their own FIRST), and a merged read
  //     prepends fork-ANCESTRY session_metas, so "last wins" keyed 11 rollouts
  //     / 2320 messages to the parent and 64 keys COLLIDED with the parent
  //     conversation's real ledger events (round-2 verifier, real data);
  //   · token_usage_record.thread_id fills a void only.
  _adoptThreadId(id, { replace = false } = {}) {
    if (!id) return;
    if (this._threadId && !replace) return;
    this._threadId = String(id);
  }

  _processSessionMeta(record, emit) {
    const payload = record.payload || {};
    this._adoptThreadId(payload.id); // FIRST session_meta wins (see _adoptThreadId)
    // This thread's OWN agent path ('/root' for a primary thread, '/root/x'
    // for a sub-agent rollout) — the reference point that makes an
    // agent_message inbound or outbound. A sub-agent rollout also carries a
    // COPY of its parent's meta, so only the first one wins (B-21e4 rule).
    if (!this._status.agentPath && (payload.agent_path || payload.agentPath)) {
      this._status.agentPath = String(payload.agent_path || payload.agentPath);
    }
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
            slashCommands: this._status.slashCommands || [],
          },
        }],
      });
      this._initMsgId = msg.id;
      this._emit({ op: 'create', message: msg });
    }
  }

  /** The ONE writer of the two effort facts — so every carrier (turn_context,
   *  the wrapper's status record, codex's thread_settings_applied) lands the
   *  same way and a LIVE client is told, instead of finding out on re-attach.
   *  `next === null` means "nothing pending"; `undefined` means "this record
   *  says nothing about the pending value" and leaves it alone. */
  _noteEffort(live, next, emit) {
    const before = `${this._status.effort || ''}|${this._status.effortNext || ''}`;
    if (live) this._status.effort = String(live);
    if (next !== undefined) this._status.effortNext = next ? String(next) : null;
    const after = `${this._status.effort || ''}|${this._status.effortNext || ''}`;
    if (emit && after !== before) {
      this._emit({ op: 'meta', subtype: 'effort', data: { effort: this._status.effort || null, effortNext: this._status.effortNext || null } });
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
    // THE TURN'S effort (turn_context.effort, codex 0.149+ and the wrapper's
    // live twin). A record that names one also settles the pending question:
    // `effort_next` present = a re-pick is waiting for the next turn, absent =
    // nothing is (2.369.62 — the wrapper states both).
    if (payload.effort) {
      const next = payload.effort_next || payload.effortNext || null;
      this._noteEffort(String(payload.effort), next ? String(next) : null, emit);
    }
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
            slashCommands: this._status.slashCommands || [],
          },
        }],
      });
      this._initMsgId = msg.id;
      this._emit({ op: 'create', message: msg });
    }
  }

  _processWrapperMeta(record, emit) {
    const payload = record.payload || {};
    this._adoptThreadId(payload.threadId, { replace: true }); // the wrapper's own record names the file it writes NOW (arrives before the first token_count; re-points the default on a mid-life thread/fork, constructor id or not)
    if (Array.isArray(payload.slashCommands)) {
      this._status.slashCommands = payload.slashCommands.slice(0, 32).map(String);
      // The init card may already exist (boot wrapper_meta / session_meta came
      // first): patch its initData in place so the chat-input autocomplete
      // learns the commands, and tell live clients.
      const init = this._initMsgId ? this.messageIndex.get(this._initMsgId) : null;
      const initData = init?.content?.[0]?.initData;
      if (initData) {
        initData.slashCommands = this._status.slashCommands;
        if (emit) this._emit({ op: 'edit', id: init.id, fields: { content: init.content } });
      }
    }
    if (payload.model) this._status.model = payload.model;
    if (payload.permissionMode) this._status.permissionMode = payload.permissionMode;
    if (payload.contextWindow) this._status.contextWindow = payload.contextWindow;
    // The wrapper's own effort pair — the FALLBACK that makes a mid-turn attach
    // honest (2.369.62): the buffer may hold no turn_context yet (a session
    // attached between boot and the first turn), and after a re-pick this is
    // the record that carries the pending value.
    if (payload.effort || payload.effortNext !== undefined) {
      this._noteEffort(payload.effort ? String(payload.effort) : null,
        payload.effortNext === undefined ? undefined : (payload.effortNext || null), emit);
    }
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
            slashCommands: this._status.slashCommands || [],
          },
        }],
      });
      this._initMsgId = msg.id;
      this._emit({ op: 'create', message: msg });
    }
  }

  _processResponseItem(item, emit) {
    const type = item.type;
    if (type === 'message') return this._processResponseMessage(item, emit);
    if (type === 'function_call') return this._processFunctionCall(item, emit);
    if (type === 'custom_tool_call') return this._processCustomToolCall(item, emit);
    // dynamic tools (plugins/browser — DynamicToolCallItem in the binary) ride
    // the same card pipeline; unrouted they rendered nothing or raw
    if (type === 'dynamic_tool_call') return this._processCustomToolCall(item, emit);
    if (type === 'dynamic_tool_call_output') return this._processFunctionCallOutput(item, emit);
    if (type === 'function_call_output') return this._processFunctionCallOutput(item, emit);
    // custom_tool_call has ALWAYS been routed but its output twin never was
    // (2.368.15 codex audit: 84 custom_tool_call_output records in one real
    // session were dropped wholesale — 52 tool cards stuck "pending" forever,
    // the codex flavor of the forever-running card).
    if (type === 'custom_tool_call_output') return this._processFunctionCallOutput(item, emit);
    if (type === 'reasoning') return this._processReasoningItem(item, emit);
    // 0.153 multi-agent v2 chatter (sub-agent ↔ root) — an 'agent' fold-kind card
    if (type === 'agent_message') return this._processAgentMessageItem(item, emit);
    // older Responses-API items that were silently dropped: each is real work
    // the model did, rendered as a COMPLETE card in its fold kind
    if (type === 'web_search_call') return this._processWebSearchCallItem(item, emit);
    if (type === 'tool_search_call') return this._processCustomToolCall({ ...item, name: 'tool_search', input: item.arguments ?? item.input ?? '' }, emit);
    if (type === 'tool_search_output') return this._processFunctionCallOutput({ ...item, output: item.output ?? (Array.isArray(item.tools) ? item.tools.map((t) => t?.name || '').filter(Boolean).join(', ') : '') }, emit);
    if (type === 'local_shell_call') return this._processCustomToolCall({ ...item, name: 'local_shell', input: item.action ?? {} }, emit);
    if (type === 'image_generation_call') return this._processImageGenEvent({ call_id: item.call_id || item.id || this._nextId(), prompt: item.prompt || item.revised_prompt || '', path: item.saved_path || item.savedPath || '', status: item.status || '' }, emit);
    if (SKIPPED_RESPONSE_ITEM_TYPES.has(type)) return;
    this._noteUnknown('response_item', type);
  }

  // ── B-7473: sub-agent ↔ root chatter ──
  // `agent_message` response items are the multi-agent v2 mail: author and
  // recipient are agent PATHS (/root/water_research → /root), the payload
  // rides an encrypted_content block and the visible part is the input_text
  // envelope ("Message Type: … / Sender: … / Payload:"). The wrapper writes
  // the LIVE twin of the same fact (a child's item/completed agentMessage, or
  // an own-thread agentMessage that starts with the envelope) with
  // content:[output_text] and msg_type set.
  //
  // Rendering rule (the owner's report — a sub-agent's FINAL_ANSWER read as
  // the root agent's own reply, twice):
  //   inbound + PLAINTEXT  → a distinct, ATTRIBUTED sub-agent report card
  //   everything else      → a one-line collab row (coalesced with its peers)
  // Neither is ever an assistant bubble, and an encrypted blob is never shown.
  _processAgentMessageItem(item, emit) {
    const parts = asArray(item.content);
    const visible = parts.filter((b) => b && (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')).map((b) => b.text || '').join('').trim();
    const encBlob = parts.map((b) => (b && (typeof b.encrypted_content === 'string' ? b.encrypted_content : (b.type === 'encrypted_content' ? (b.text || b.data || '') : ''))) || '').find((x) => x) || '';
    const encrypted = parts.some((b) => b && (b.type === 'encrypted_content' || typeof b.encrypted_content === 'string')) || !!item.encrypted;
    const envelope = parseAgentEnvelope(visible);
    const author = String(item.author || envelope?.sender || '');
    const own = this._status.agentPath || '/root';
    const dir = author && author !== own ? 'in' : 'out';
    const msgType = String(item.msg_type || item.msgType || envelope?.msgType || (item.phase === 'final_answer' ? 'FINAL_ANSWER' : 'MESSAGE'));
    const body = (envelope ? envelope.body : visible).trim();
    // absAgentPath on BOTH legs: an envelope's `taskName` (and some recipient
    // fields) are bare names, the author is an absolute path — one identity
    const other = absAgentPath(dir === 'in' ? author : String(item.recipient || envelope?.taskName || ''), own);
    const row = {
      dir,
      agentPath: other,
      agentName: agentName(other),
      msgType,
      encrypted,
      threadId: this._status.subagents[other] || String(item.thread_id || item.threadId || '') || null,
      target: dir === 'out' ? other : '',
    };
    // TWIN DEDUP: the live record (wrapper, id msg_…) and the rollout record
    // (id amsg_…) are the SAME message with different ids and different
    // framing — id first, then the CONTENT leg within the turn.
    //
    // The content leg only exists where there IS content (B-7473 integration 2026-09-06, measured on
    // the owner's real root rollout): an ENCRYPTED inter-agent message has body
    // '' and msgType 'MESSAGE' for EVERY message, so a
    // (turn, author, msgType, body) key collapses every message an agent sent in
    // a turn into one — the verifier measured 101 of 140 encrypted messages
    // silently dropped; a re-measure of the SAME (still-growing) rollout at 3648
    // records says 120 of 168. All of them carry distinct ids AND distinct blobs,
    // so the id leg never fired. An encrypted message therefore dedupes by ID, plus a
    // discriminator taken from the fernet blob's first 32 chars (version +
    // timestamp + IV — distinct per message) so a re-read of the same record
    // still collapses if its id is ever missing.
    const idKey = item.id || item.item_id ? `id:${item.id || item.item_id}` : '';
    const contentKey = body
      ? `t${this.turnIndex}:${author}:${msgType}:${body.slice(0, 400)}`
      : (encBlob ? `t${this.turnIndex}:${author}:${msgType}:enc:${encBlob.slice(0, 32)}` : '');
    if ((idKey && this._agentMsgSeen.has(idKey)) || (contentKey && this._agentMsgSeen.has(contentKey))) return;
    if (idKey) this._agentMsgSeen.set(idKey, 1);
    if (contentKey) this._agentMsgSeen.set(contentKey, 1);
    // bounded: a twin's two copies are minutes apart at most (the merge sorts
    // by timestamp), so an old key can never be needed again
    while (this._agentMsgSeen.size > 4000) this._agentMsgSeen.delete(this._agentMsgSeen.keys().next().value);

    if (dir === 'in' && !encrypted && body) {
      this._createCollabReport(row, body, emit);
      return;
    }
    this._pushCollabRow(row, emit);
  }

  /**
   * A sub-agent REPORT: the plaintext payload a child sent home. role 'tool',
   * rendered with an attribution header and the body as markdown — the renderer
   * never confuses it with an assistant reply.
   *
   * collapseKind 'report', NOT 'agent' (B-7473 integration 2026-09-06): a report is the CONTENT the
   * owner opened the window to read (the child's FINAL_ANSWER), while the
   * one-line rows are orchestration noise. 'agent' is in the default
   * chat.collapseKinds, so a report folded away by default and the owner had to
   * expand the run to find the answer. 'report' is offered in the settings list
   * but ships UNCHECKED — a user who wants the quiet view can tick it.
   */
  _createCollabReport(row, body, emit) {
    this._stampRowTime(row);
    const toolCallId = `collab:${row.agentPath || 'agent'}:${this.messages.length}`;
    const msg = this._create({
      role: 'tool',
      status: 'complete',
      content: [{ type: 'tool_result', toolCallId, toolName: 'Sub-agent report', input: { agent: row.agentPath, type: row.msgType }, output: body, status: 'ok' }],
      toolCallId,
      toolName: 'Sub-agent report',
      toolStatus: 'ok',
      collapseKind: 'report',
    });
    msg.collab = { ...row, report: true, rows: [row] };
    if (emit) this._emit({ op: 'create', message: msg });
    return msg;
  }

  /**
   * Every collab row carries WHEN it happened and where that clock came from —
   * the live progress readout (head "last 4s ago", the frozen span, the run
   * label) is derived from these and nothing else. ONE stamper for all four row
   * producers (agent_message in/out, spawn/send/wait calls, SubAgentActivity):
   * a row built without a time would silently drop out of every span.
   */
  _stampRowTime(row) {
    if (!row || Number(row.ts) > 0) return row;
    row.ts = this._currentTs || Date.now();
    row.tsKind = this._currentTsKind || 'arrival';
    return row;
  }

  /**
   * A one-line collab row. CONSECUTIVE rows coalesce into ONE message (the
   * orchestration of a dozen sub-agents otherwise buries the conversation):
   * the last message is edited in place, live and on rebuild alike.
   */
  _pushCollabRow(row, emit) {
    this._stampRowTime(row);
    const last = this.messages[this.messages.length - 1];
    if (last && last.collab && !last.collab.report && last.turnIndex === this.turnIndex) {
      last.collab.rows.push(row);
      const output = collabSummaryText(last.collab);
      last.content = [{ ...(last.content?.[0] || {}), output, status: 'ok' }];
      // `status` rides the edit ON PURPOSE: ChatView._onEditMessage only
      // RE-RENDERS the element for a terminal status — a content-only edit
      // updates the stored message and leaves the DOM showing the old row
      // (the message is already complete; this changes no state).
      if (emit) this._emit({ op: 'edit', id: last.id, fields: { status: 'complete', content: last.content, collab: last.collab } });
      return last;
    }
    const toolCallId = `collab:${row.agentPath || row.target || 'agent'}:${this.messages.length}`;
    const msg = this._create({
      role: 'tool',
      status: 'complete',
      content: [{ type: 'tool_result', toolCallId, toolName: 'Sub-agent', input: {}, output: collabSummaryText(row), status: 'ok' }],
      toolCallId,
      toolName: 'Sub-agent',
      toolStatus: 'ok',
      collapseKind: 'agent',
    });
    msg.collab = { ...row, rows: [row] };
    if (emit) this._emit({ op: 'create', message: msg });
    return msg;
  }

  /**
   * Learn (and remember) a child's agentPath → thread id.
   *
   * The BELT (round-5): rows are built through absAgentPath, so a row and this
   * map agree by construction — but a carrier we have not met yet could still
   * hand us a BARE name, and a row with no thread id has no click-through at
   * all. So the back-fill also matches a row whose own path carries NO '/'
   * against this key's last segment. Deliberately one-directional: an absolute
   * row path must match EXACTLY (two different parents may each have a child
   * called `research`, and mapping one onto the other's thread would open the
   * wrong conversation — a wrong answer is worse than a missing one).
   */
  _noteSubagentThread(agentPath, threadId) {
    if (!agentPath || !threadId) return;
    if (this._status.subagents[agentPath] === threadId) return;
    this._status.subagents = { ...this._status.subagents, [agentPath]: threadId };
    const leaf = agentName(agentPath);
    const matches = (p) => !!p && (p === agentPath || (!p.includes('/') && p === leaf));
    // back-fill rows already rendered for this agent (the spawn row is written
    // before SubAgentActivity names the thread)
    for (const m of this.messages) {
      if (!m.collab) continue;
      for (const r of m.collab.rows || []) {
        if (!r.threadId && matches(r.agentPath)) r.threadId = threadId;
      }
      if (!m.collab.threadId && matches(m.collab.agentPath)) m.collab.threadId = threadId;
    }
  }

  goalState() { return this._goalState || null; }

  /** The input queue as last published by the wrapper (attach payload). */
  queueState() { return this._queue || []; }

  /** Did the RUNNING wrapper publish a queue at all (the in-band capability
   *  signal that pairs with the sidecar's caps.inputQueue advert)? */
  queuePublished() { return !!this._queuePublished; }

  /** WHICH verbs the running wrapper named in its last publication, or null if
   *  it named none (a build older than the verb table). This is the REMOTE
   *  advert: the orchestrator cannot read a sidecar that lives on another
   *  machine, so the in-band list is the only one it will ever see. */
  queueVerbsPublished() { return this._queueVerbs || null; }

  /** Stamp the queue chip on the user bubble a queued message belongs to.
   *  Returns false when there is no such bubble (peer messages carry no
   *  webui_msg_id) — the caller then falls back to a visible system notice, so
   *  a queued message is never silent. */
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

  /** STAMP THE ID ON THE MESSAGE ITSELF, not only into the side map:
   *  `userMessageIds` never leaves the server, while the queue chip on the
   *  CLIENT has to join a rendered bubble back onto its queue row. A map the
   *  client cannot see is not an identity (round-1 review: every chip click
   *  answered "no longer queued" because the bubble carried no id). Both
   *  identities land in the same field — the client asks "which queue row is
   *  this bubble", never "who minted the id". */
  _stampUserIdentity(msg, id) {
    if (!id) return;
    msg.webuiMsgId = String(id);
    this.userMessageIds.set(String(id), msg.id);
  }

  _processResponseMessage(item, emit) {
    const role = item.role;
    // Detect Codex thread goal auto-continue messages (role=developer or user with goal context)
    if (role === 'developer' || role === 'user') {
      const text = asArray(item.content).map(b => b.text || '').join('');
      if (text.includes('Continue working toward the active thread goal')) {
        this._goalActive = true;
        const match = text.match(/<(?:untrusted_)?objective>\s*([\s\S]*?)\s*<\/(?:untrusted_)?objective>/);
        if (match) this._goalCondition = match[1].trim();
        if (role === 'user') return; // Don't render as user message
      }
      if (role === 'developer') return;
    }
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
      // The bubble the WRAPPER wrote for a submission it never typed — an item
      // INHERITED from the wrapper this session replaced, steered into the turn
      // or drained by the app-server (2026-09-07). Its id is the app-server's
      // own clientUserMessageId, which is also what the strip row advertises,
      // so the queue chip joins. It is a SECOND-CLASS identity on purpose: it
      // does NOT suppress peer detection below (most of the 25 inherited items
      // in the owner's session were agent-to-agent messages and must keep their
      // labelled card), and it never reaches the merge fingerprint.
      const queueMsgId = item.webui_queue_id || item.webuiQueueId || null;
      // Peer / notification record (rpc-queue lane live, rollout on rebuild)
      // → the labelled peer card, never an anonymous "You" bubble. NO
      // _finalizeStreaming here: a queued peer message is recorded while a
      // turn is still streaming, and closing its open streams fragmented the
      // active reply (the 2.368.16 class) — the turn's own task_complete
      // finalizes. Typed records (webuiMsgId) never take this branch.
      const peer = webuiMsgId ? null : peerRecordOf(item, content);
      if (peer) {
        this.turnIndex++;
        const msg = this._create({ role: 'user', status: 'complete', content: peer.content, turnIndex: this.turnIndex });
        msg.originKind = 'peer-message';
        msg.peerFrom = peer.from;
        this._stampUserIdentity(msg, queueMsgId);
        if (emit) this._emit({ op: 'create', message: msg });
        return;
      }
      // A record for an INHERITED queue submission exists ONLY mid-turn (a
      // steer injects into the RUNNING turn; a drained item's turn has just
      // started with nothing open yet), so it must not close the streams the
      // way a typed send does: finalizing here cut the agent's reply in two —
      // measured, and the same 2.368.16 fragmentation the peer branch above
      // exists to avoid. A typed record keeps finalizing: it can BEGIN a turn.
      if (!queueMsgId || webuiMsgId) this._finalizeStreaming(emit);
      const identity = webuiMsgId || queueMsgId;
      if (identity) {
        const existingId = this.userMessageIds.get(String(identity));
        const existing = existingId ? this.messageIndex.get(existingId) : null;
        if (existing) {
          existing.content = content;
          existing.status = 'complete';
          existing.webuiMsgId = String(identity);
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content, status: 'complete', webuiMsgId: existing.webuiMsgId } });
          return;
        }
      }
      this.turnIndex++;
      const msg = this._create({ role: 'user', content, turnIndex: this.turnIndex });
      if (item.webui_origin === 'auto-resume') msg.originKind = 'auto-resume'; // VibeSpace's continue prompt after a wall — labelled, not "you typed this" (2.369.32)
      // …and a bubble that does not CLOSE the turn's open streams must not be a
      // turn BOUNDARY for the backward scan either (round 2): skipping the
      // finalize while still stopping the scan left a reply that was open when
      // the turn ended stranded at 'streaming' forever — a phantom spinner on a
      // dead, read-only conversation. Same exemption, same reason, as the peer
      // card on the line that reads this flag.
      if (queueMsgId && !webuiMsgId) msg.midTurn = true;
      this._stampUserIdentity(msg, identity);
      if (emit) this._emit({ op: 'create', message: msg });
      return;
    }

    if (role === 'assistant') {
      const text = asArray(item.content).filter((block) => block.type === 'output_text').map((block) => block.text || '').join('');
      if (!text) return;
      // The rollout JSONL copy carries the item id under `id` (the wrapper's
      // buffer copy uses item_id) — both must resolve to the same stream key
      // as the agent_message_delta events, else the finalized message can't
      // find the streamed one and renders the same text twice.
      const streamKey = item.item_id || item.itemId || item.id || item.phase || this._currentTurnId || 'assistant';
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

  // ONE card per call_id (2.369.43): the wrapper's buffer copy and codex's own
  // rollout copy of the same call serialize differently (view_image: the stub
  // records {path}, the rollout {path, detail}) so the merge fingerprint keeps
  // BOTH — a second card for a known id used to leave the first pending
  // forever. A known id learns any input the twin adds; no new card.
  _absorbTwinCall(toolCallId, parsedInput, emit) {
    const msgId = this.toolCallMessageIds.get(toolCallId);
    const existing = msgId ? this.messageIndex.get(msgId) : null;
    if (!existing) return false;
    const block = existing.content?.[0];
    if (block && parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) {
      const merged = mergeToolInput(block.input, parsedInput);
      if (JSON.stringify(merged) !== JSON.stringify(block.input)) {
        block.input = merged;
        if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content } });
      }
    }
    return true;
  }

  /**
   * A collaboration tool call (spawn_agent / send_message / followup_task /
   * wait …) → a one-line collab row instead of a tool card. The `message`
   * argument is an encrypted blob upstream, so a card would show a 3KB fernet
   * string as "input"; the row shows WHO and WHAT KIND, and says the payload
   * was withheld. Returns true when the call was consumed.
   */
  _processCollabToolCall(item, rawInput, emit) {
    const name = String(item.name || '');
    const dir = COLLAB_TOOL_DIRS[name];
    if (!dir) return false;
    const input = safeJsonParse(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput ?? ''), null) || (rawInput && typeof rawInput === 'object' ? rawInput : {});
    const toolCallId = item.call_id || item.callId || this._nextId();
    // absAgentPath: the outbound call's `task_name` is BARE — every other
    // carrier names the same child absolutely (see the helper's essay)
    const target = absAgentPath(String(input.task_name || input.target || input.agent_path || input.agentPath || ''), this._status.agentPath);
    const row = {
      dir,
      agentPath: target,
      agentName: agentName(target),
      nickname: String(item.agent_nickname || input.agentNickname || ''),
      msgType: COLLAB_MSG_TYPES[name] || '',
      encrypted: typeof input.message === 'string' && input.message.length > 0,
      target,
      cellId: input.cell_id != null ? String(input.cell_id) : '',
      yieldMs: Number(input.yield_time_ms) || 0, // wait: how long the root blocks for its sub-agents (shown on the row)
      threadId: this._status.subagents[target] || (Array.isArray(input.receiverThreadIds) ? input.receiverThreadIds[0] : null) || null,
      detail: collabDetailOf(input),
    };
    const msg = this._pushCollabRow(row, emit);
    this._collabByCall.set(toolCallId, { msgId: msg.id, row });
    // DURABLE marker (the _collabByCall entry is deleted when the call's output
    // arrives): a SubAgentActivity record carrying this same id is this row's
    // own twin, in either arrival order — see _processSubAgentActivity.
    this._collabSeen.add('call:' + toolCallId);
    // bounded: a call whose output never arrives (interrupted turn) would
    // otherwise pin its row object for the manager's lifetime
    while (this._collabByCall.size > 2000) this._collabByCall.delete(this._collabByCall.keys().next().value);
    return true;
  }

  _processFunctionCall(item, emit) {
    if (this._processCollabToolCall(item, item.arguments, emit)) return;
    const toolCallId = item.call_id || item.callId || this._nextId();
    const parsedInput = parseToolInput(item.name, item.arguments);
    if (this._absorbTwinCall(toolCallId, parsedInput, emit)) return;
    const toolName = formatToolName(item.name || 'tool');
    const msg = this._create({
      role: 'tool',
      status: 'pending',
      content: [{ type: 'tool_call', toolCallId, toolName, input: parsedInput }],
      toolCallId,
      toolName,
      toolStatus: null,
      collapseKind: collapseKindOf(item.name),
    });
    this.pendingToolCalls.set(toolCallId, { msgId: msg.id, rawName: item.name || toolName });
    this.toolCallMessageIds.set(toolCallId, msg.id);
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _processCustomToolCall(item, emit) {
    const rawInput0 = item.input ?? item.arguments ?? '';
    if (this._processCollabToolCall(item, rawInput0, emit)) return;
    const toolCallId = item.call_id || item.callId || this._nextId();
    const rawInput = item.input ?? item.arguments ?? '';
    const parsedInput = parseToolInput(item.name, rawInput);
    if (this._absorbTwinCall(toolCallId, parsedInput, emit)) return;
    const toolName = formatToolName(item.name || 'tool');
    const msg = this._create({
      role: 'tool',
      status: 'pending',
      content: [{ type: 'tool_call', toolCallId, toolName, input: parsedInput }],
      toolCallId,
      toolName,
      toolStatus: null,
      collapseKind: collapseKindOf(item.name),
    });
    this.pendingToolCalls.set(toolCallId, { msgId: msg.id, rawName: item.name || toolName });
    this.toolCallMessageIds.set(toolCallId, msg.id);
    if (emit) this._emit({ op: 'create', message: msg });
  }

  _finalizeToolCall(toolCallId, { output, isError, extraInput = null, rawName = 'tool', images = null }, emit) {
    const pending = this.pendingToolCalls.get(toolCallId);
    const msgId = pending?.msgId || this.toolCallMessageIds.get(toolCallId);
    const toolName = formatToolName(pending?.rawName || rawName || 'tool');
    const nextStatus = isError ? 'error' : 'complete';
    const nextToolStatus = isError ? 'error' : 'ok';
    // lifted image metadata ({mediaType, bytes}[], claude parity) — never bytes
    const imagesField = Array.isArray(images) && images.length ? { images } : {};

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
          ...imagesField,
        }],
        toolCallId,
        toolName,
        toolStatus: nextToolStatus,
        collapseKind: collapseKindOf(pending?.rawName || rawName),
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
      ...(Array.isArray(currentBlock.images) && currentBlock.images.length ? { images: currentBlock.images } : {}),
      ...imagesField,
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
    // A collab call's output is either empty (send_message / followup_task) or
    // the spawned agent's PATH ({"task_name":"/root/water_research"}) — never
    // a message body. It enriches the row; it never becomes a card, and the
    // `wait` output (a truncated base64 image in real rollouts) never renders.
    const collab = this._collabByCall.get(toolCallId);
    if (collab) {
      this._collabByCall.delete(toolCallId);
      const parsed = typeof item.output === 'string' ? safeJsonParse(item.output, null) : null;
      const spawned = parsed && typeof parsed === 'object' ? absAgentPath(String(parsed.task_name || parsed.agent_path || ''), this._status.agentPath) : '';
      if (spawned && spawned !== collab.row.agentPath) {
        collab.row.agentPath = spawned;
        collab.row.agentName = agentName(spawned);
        collab.row.target = collab.row.target ? spawned : collab.row.target;
        if (this._status.subagents[spawned]) collab.row.threadId = this._status.subagents[spawned];
        const msg = this.messageIndex.get(collab.msgId);
        if (msg) {
          if (msg.collab && !msg.collab.rows.length) msg.collab.rows = [collab.row];
          if (msg.collab && msg.collab.rows[0] === collab.row) Object.assign(msg.collab, collab.row);
          msg.content = [{ ...(msg.content?.[0] || {}), output: collabSummaryText(msg.collab) }];
          if (emit) this._emit({ op: 'edit', id: msg.id, fields: { status: 'complete', content: msg.content, collab: msg.collab } });
        }
      }
      return;
    }
    // custom_tool_call_output carries output as an ARRAY of {type:'input_text',
    // text} blocks (real rollout shape) — join the text instead of dumping a
    // JSON blob into the card.
    // BINARY NEVER ENTERS A CARD (the 2.369.35 law, codex twin): a view_image
    // output twin in the rollout is [{type:'input_image', image_url:'data:…'}]
    // — lifted to {mediaType, bytes} + a one-line marker, exactly like the
    // claude normalizer's splitToolResultContent; the renderer draws the file.
    const raw = item.output;
    const images = [];
    const output = typeof raw === 'string' ? raw
      : Array.isArray(raw) ? raw.map((b) => {
        if (b && typeof b === 'object' && b.type === 'input_image' && typeof b.image_url === 'string') {
          const m = /^data:([^;,]+)[;,]/.exec(b.image_url);
          const mediaType = m ? m[1] : 'image/png';
          const b64 = b.image_url.slice(b.image_url.indexOf(',') + 1);
          const bytes = Math.round(b64.length * 3 / 4);
          images.push({ mediaType, bytes });
          return `[image ${mediaType} · ${Math.max(1, Math.round(bytes / 1024))} KB]`;
        }
        return b && typeof b === 'object' ? (b.text ?? '') : String(b ?? '');
      }).join('')
        : JSON.stringify(raw ?? '');
    const isError = !!item.is_error || !!item.error;
    this._finalizeToolCall(toolCallId, { output, isError, images }, emit);
  }

  // THE image-view card path — every carrier of "the agent looked at this
  // image" funnels through here, so `fileUrlToPath` is applied in exactly ONE
  // place (2.369.48). The carriers:
  //   · `function_call view_image {path}` — the wrapper's LIVE stub (plain path)
  //   · `event_msg view_image_tool_call {call_id, path}` — the ≤0.130 engine's
  //     own record; the ONLY trace when the function_call pair is absent (a
  //     history whose wrapper stub never recorded the item). Used to sit in
  //     SKIPPED_EVENT_TYPES.
  //   · `event_msg item_completed {item:{type:'ImageView', id, path}}` — the
  //     0.153.4 carrier (file:// URL), routed by _processItemCompleted.
  // ONE card per call_id either way: a KNOWN id just learns the path (the live
  // stub and the rollout copy of the same view share the `exec-…` id), an
  // unknown one becomes a complete view_image card a later output twin edits
  // in place.
  _processViewImageEvent(event, emit) {
    const toolCallId = event.call_id || event.callId;
    if (!toolCallId) return;
    const path = fileUrlToPath(typeof event.path === 'string' ? event.path : '');
    const known = this.toolCallMessageIds.has(toolCallId) || this.pendingToolCalls.has(toolCallId);
    if (known) {
      if (path) this._absorbTwinCall(toolCallId, { path }, emit);
      // a card whose CALL is known but whose output never came (the wrapper's
      // live stub with no function_call_output) still completes on the
      // rollout's ImageView item — otherwise it stayed 'pending' forever
      // (round-3 verifier A/B: master completed it, the rebase did not)
      if (!this.pendingToolCalls.has(toolCallId)) return;
    }
    this._finalizeToolCall(toolCallId, { output: `viewed ${path || 'image'}`, isError: false, extraInput: { path }, rawName: 'view_image' }, emit);
  }

  // ── THE IMAGE-GENERATION card path (2.369.58) ──
  // Every carrier of "the agent generated an image" funnels through here, so
  // the LIVE stream, the ROLLOUT and the thread/read fallback land on ONE card
  // shape (scripts/test-harness-honesty.mjs pins all three producers):
  //   · `event_msg item_completed {item:{type:'Extension', kind:'image_gen.generation', …}}`
  //     — the 0.153.4 rollout's own spelling, which the wrapper now MIRRORS for
  //     the live copy and codex-thread-read emits for a rollout-less thread.
  //     Same item id on every route ⇒ one card, whichever arrives first.
  //   · `response_item image_generation_call` — the ≤0.130 Responses-API shape.
  // The item's `result` (a 3 MB base64 PNG in the real records) NEVER reaches a
  // card: the card names savedPath and the renderer draws the file from disk
  // (the 2.369.35 binary-never-enters-a-card law).
  _processImageGenEvent(event, emit) {
    const toolCallId = event.call_id || event.callId;
    if (!toolCallId) return;
    const path = fileUrlToPath(typeof event.path === 'string' ? event.path : '');
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    const failure = typeof event.error === 'string' ? event.error : '';
    const status = typeof event.status === 'string' ? event.status : '';
    const output = failure || [status ? `status: ${status}` : '', path ? `saved ${path}` : ''].filter(Boolean).join('\n');
    this._finalizeToolCall(toolCallId, { output, isError: !!failure, extraInput: { prompt, path }, rawName: 'image_gen' }, emit);
  }

  // ── THE SLEEP card path (2.369.58) ──
  // `clock.sleep` is the agent deliberately WAITING. It had no branch on the
  // live side at all, so a 20-minute sleep looked exactly like a hang (and on
  // the history side it was dropped as "not conversation content"). Pending =
  // a live countdown row the renderer ticks off this card's own ts + duration;
  // completed = the frozen total.
  _processSleepEvent(event, emit) {
    const toolCallId = event.call_id || event.callId;
    if (!toolCallId) return;
    const raw = Number(event.duration_ms ?? event.durationMs);
    const durationMs = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
    this._finalizeToolCall(toolCallId, { output: `slept ${formatSleptMs(durationMs)}`, isError: false, extraInput: { durationMs }, rawName: 'sleep' }, emit);
  }

  // ── web search (2.369.43, owner: every codex web_search card read
  // {"query":"","action":null} / "(empty)"; refuted + re-cut on real data
  // 2026-09-06) ──
  // ONE search = ONE card keyed by call_id, whichever carriers arrive. WHICH
  // carrier a rollout writes depends on session_meta.cli_version (read-only
  // fleet scan of every local rollout — the table lives in kb-file-structure.md):
  //   0.120 / 0.125 / 0.130 — event_msg web_search_end {call_id:'ws_…', query,
  //       action} (NEVER results: 1698 ends, 0 with the key) + an id-less
  //       Responses-API web_search_call {status, action?} on the NEXT line for
  //       the same search. An end with action {type:'other'} (query '') is
  //       twinned by a call carrying NO action key at all; 0.125 also has long
  //       runs of ORPHAN calls (no end) and 0.130 of ORPHAN ends (no call).
  //   0.149.1 — web_search_end ONLY (call_id 'exec-…', results ALWAYS present:
  //       35/35; no web_search_call item anywhere). item_completed starts here.
  //   0.153.4 (installed) — NO web_search_end anywhere: the search persists
  //       ONLY as event_msg item_completed {item:{type:'Extension',
  //       kind:'web.search', id:'exec-…', query, action, results}} with the v2
  //       camelCase action types (openPage / findInPage; url/pattern nullable),
  //       routed here by _processItemCompleted under the SAME id the wrapper's
  //       live card uses — three 0.153.4 rollouts with 20/43/30 searches
  //       rendered ZERO cards while item_completed sat in the generic skip.
  //   live (wrapper) — function_call web_search at item/started (EMPTY stub =
  //       the pending card) + event_msg web_search_end at item/completed (the
  //       v2 item relayed: query, camelCase action, results).
  // Carriers merge: query/action into the card's input (mergeToolInput),
  // results through search-card.js (one renderer live and rebuilt); a later
  // copy EDITS the same card, never a second create.
  // Twin pairing (0.120-0.130) is POSITIONAL: ONE slot holds the immediately
  // preceding SEARCH record (end or id-less call — records in between never
  // touch it, and both handlers overwrite it) and the next search record
  // consumes or clears it, so an orphan call later in the file with the same
  // action never pairs with a stale end. Whole-file replays: the 0.125 file =
  // 96 orphan calls then 104 end+call twins ⇒ 200 cards; the 0.130 file
  // (2,119,710,127 bytes = 2.0 GiB, 1,116,410 lines — `ls -l` on the named
  // rollout, NOT the 512 MB the first cut claimed) = 1524 ends + 1324 calls,
  // every call an adjacent twin ⇒ 1524 cards, 0 empty and 0 'no results'.
  // web_search_begin is not persisted (0 in every local rollout) but handled
  // for the live stream: a pending card if none exists, else a query patch.
  _processWebSearchEvent(event, emit) {
    const callId = event.call_id || event.callId || this._nextId();
    const query = typeof event.query === 'string' ? event.query : '';
    const action = event.action && typeof event.action === 'object' && !Array.isArray(event.action) ? event.action : null;
    if (event.type === 'web_search_begin') {
      const msgId = this.toolCallMessageIds.get(callId);
      const existing = msgId ? this.messageIndex.get(msgId) : null;
      if (existing) {
        // pending card already there (wrapper ①): patch the query in, keep it pending
        const block = existing.content?.[0];
        if (query && block && block.type === 'tool_call') {
          block.input = mergeToolInput(block.input, { query });
          if (emit) this._emit({ op: 'edit', id: existing.id, fields: { content: existing.content } });
        }
        return;
      }
      this._processFunctionCall({ call_id: callId, name: 'web_search', arguments: JSON.stringify({ query, action }) }, emit);
      return;
    }
    const key = searchActionKey(action, query);
    // an id-less call on the PREVIOUS line (reverse order — not observed in the
    // wild, the pairing is order-free): adopt its card; the slot is single-use
    const prevCall = this._lastSearchCall;
    this._lastSearchCall = null;
    if (prevCall && prevCall.key === key && prevCall.msgId && !this.toolCallMessageIds.has(callId)) this.toolCallMessageIds.set(callId, prevCall.msgId);
    const { output, isError } = renderSearchOutput({ query, action, results: event.results, error: event.error });
    this._finalizeToolCall(callId, { output, isError, extraInput: { query, action }, rawName: 'web_search' }, emit);
    this._lastSearchEnd = { key };
  }

  _processWebSearchCallItem(item, emit) {
    const action = item.action && typeof item.action === 'object' && !Array.isArray(item.action) ? item.action : null;
    const key = searchActionKey(action, action?.query);
    const idLess = !item.call_id && !item.id;
    // the slot holds the end on the PREVIOUS line only — consumed or cleared by
    // this record either way (positional adjacency, never a stale match)
    const prevEnd = this._lastSearchEnd;
    this._lastSearchEnd = null;
    if (idLess && prevEnd && prevEnd.key === key) return; // the end's twin (incl. {type:'other'} end ↔ action-less call)
    const callId = item.call_id || item.id || this._nextId();
    // An ORPHAN action-less call (0.120.0 `{status:'completed'}` with no end, no
    // id, no action — one such record survives the positional pairing) carried
    // NOTHING to render, so the card came out as the owner's exact complaint
    // shape: input {"query":"","action":null} over 'status: completed'. It is
    // now LABELLED — an empty input is replaced by the note and the head says
    // what is missing — so no card can reproduce that shape byte for byte.
    const status = item.status ? `status: ${item.status}` : '';
    const detailed = !!action;
    this._finalizeToolCall(callId, {
      output: detailed ? status : [`web search (${NO_SEARCH_DETAILS})`, status].filter(Boolean).join('\n\n'),
      isError: false,
      extraInput: detailed ? { query: action.query || '', action } : { note: NO_SEARCH_DETAILS },
      rawName: 'web_search',
    }, emit);
    this._lastSearchCall = idLess ? { key, msgId: this.toolCallMessageIds.get(callId) || null } : null;
  }

  // ── event_msg item_completed (the 0.149+ ThreadItem lifecycle record) ──
  // Dispatch is an explicit ALLOWLIST on item.TYPE, not a fall-through: a type
  // whose fact is rendered from ANOTHER record is skipped BY NAME with that
  // record named, a type that is the ONLY carrier of its fact is routed into the
  // card path its live/legacy twin already uses, and anything else fires
  // `codex-unknown-record:item_completed:<type>` ONCE per type. A silent default
  // here is the invisible-record class — three 0.153.4 rollouts with 20/43/30
  // searches rendered ZERO cards while item_completed sat in the generic skip.
  //
  // 0.153.4 CENSUS (all 25 local rollouts, snapshot 2026-09-06 — the corpus is
  // LIVE: two scans an hour apart differed by ~4%, so RE-COUNT rather than trust
  // the totals; the RATIOS are the claim. item_started is NEVER persisted — 0
  // records — so item_completed is the only lifecycle carrier):
  //   RENDERED ELSEWHERE ⇒ skipped by name (ITEM_COMPLETED_SKIPPED_TYPES):
  //   Reasoning 1480 · AgentMessage 84 — the item id IS a response_item id
  //     (1480/1480, 84/84).
  //   CollabAgentToolCall 5 — the id is the function_call's call_id (5/5).
  //   CommandExecution 588 · FileChange 135 — no id twin: the item is the RESULT
  //     of the `exec` custom_tool_call in front of it (876 exec calls, the only
  //     shell tool name in the corpus), whose card already shows the command and
  //     its output. 0.153.4 has NO standalone apply_patch tool call AT ALL (0 in
  //     the corpus — the earlier "the apply_patch execs match the FileChange
  //     count" claim was false): a patch rides the SAME `exec` call, whose input
  //     text carries the '*** Begin Patch' payload; 135/135 FileChange items
  //     follow an exec call naming the changed file.
  //   UserMessage 31 — the prompt, already rendered from its response_item.
  //   SubAgentActivity started 18 + interacted 214 — the item id is the id of the
  //     tool CALL that caused it (started → spawn_agent 18/18, interacted →
  //     send_message 197 + followup_task 17), and that call renders its own card.
  //   ContextCompaction 1 — deliberately NOT routed: the live wrapper emits its
  //     own `context_compacted` for the same item, the two spellings do NOT
  //     fingerprint-dedupe in the buffer⇄rollout merge, so routing it would
  //     print the notice twice (and bump turnIndex twice) on every live session.
  //     Known cost, named here: a rollout-ONLY rebuild shows no compaction
  //     notice. Fixing it needs a dedupe key both spellings share.
  //   ONLY CARRIER ⇒ routed:
  //   Extension:web.search 245 · Extension:image_gen.generation 3 · ImageView 54
  //     — ZERO twins by any id: persisted NOWHERE else.
  //   SubAgentActivity completed 32 over 18 distinct threads (a thread's
  //     completion is recorded more than once; the card is keyed by THREAD, so
  //     the corpus replay gains exactly 18 cards) — id `subagent-completed-
  //     <uuid>`, twinning NOTHING (0/32). A sub-agent FINISHING was recorded
  //     nowhere else, so it routes to the sub_agent_activity card path (which
  //     now CREATES the card when no 'started' opened one: 0.153.4 persists no
  //     standalone sub_agent_activity at all, and its 'started' twin renders as the
  //     spawn_agent call instead). 0.149.1 persists the same facts the OTHER way
  //     — 349 standalone sub_agent_activity events, started 64 / interacted 277 /
  //     interrupted 8 / completed 0 — so this carrier MOVED into item_completed
  //     exactly like web.search did. 'interrupted' has 0 item_completed records
  //     locally: it rides the same terminal rule, and the twin guard below means
  //     a twinned one could still never double-render.
  // Only web.search / image_gen.generation are Extension KINDS in the corpus; an
  // unknown KIND reports as `item_completed:Extension:<kind>` (namespaced so a
  // kind can never be read as a top-level type), an unknown SubAgentActivity kind
  // as `item_completed:SubAgentActivity:<kind>`.
  _processItemCompleted(event, emit) {
    const it = event.item && typeof event.item === 'object' && !Array.isArray(event.item) ? event.item : null;
    if (!it) return;
    const type = String(it.type || '');
    if (ITEM_COMPLETED_SKIPPED_TYPES.has(type)) return; // rendered from the record named in the census above
    if (type === 'Extension') {
      if (it.kind === 'web.search') {
        this._processWebSearchEvent({ type: 'web_search_end', call_id: it.id, query: it.query, action: it.action, results: it.results, error: it.error }, emit);
        return;
      }
      if (it.kind === 'image_gen.generation') {
        // ONE card path (2.369.58) — see _processImageGenEvent. `savedPath` is
        // what the card names; `result` (3 MB of base64) never leaves here.
        const failure = it.failure && typeof it.failure === 'object' ? (it.failure.message || JSON.stringify(it.failure)) : (typeof it.failure === 'string' ? it.failure : '');
        this._processImageGenEvent({
          call_id: it.id || this._nextId(),
          prompt: typeof it.revisedPrompt === 'string' ? it.revisedPrompt : '',
          path: typeof it.savedPath === 'string' ? it.savedPath : '',
          status: typeof it.status === 'string' ? it.status : '',
          error: failure,
        }, emit);
        return;
      }
      if (it.kind === 'clock.sleep') {
        // The rollout's spelling for the v2 `sleep` ThreadItem (0.153.4: the
        // item is `Extension`/`clock.sleep` with a bare durationMs).
        this._processSleepEvent({ call_id: it.id || this._nextId(), duration_ms: it.durationMs }, emit);
        return;
      }
      this._noteUnknown('event_msg', 'item_completed:Extension:' + (it.kind || '(unkinded)'));
      return;
    }
    if (type === 'ImageView') {
      // the shared view_image card path (same item id ⇒ the wrapper's live stub
      // and this rollout copy converge on ONE card, whichever arrives first);
      // the rollout persists a `file://` URL while the live RPC hands the
      // wrapper a plain path — _processViewImageEvent decodes both to the plain
      // path /api/file/raw needs
      this._processViewImageEvent({ call_id: it.id || this._nextId(), path: it.path }, emit);
      return;
    }
    if (type === 'SubAgentActivity') {
      const kind = String(it.kind || '');
      // EVERY kind reaches the ONE lifecycle implementation (B-7473 + the
      // allowlist router merged): started/interacted carry the child's THREAD
      // ID — the fact the click-through needs — and the map is filled even when
      // the row itself is suppressed as its own call's twin (see
      // _processSubAgentActivity). Unknown kinds still get the breadcrumb.
      if (kind === 'started' || kind === 'interacted' || kind === 'completed' || kind === 'interrupted') {
        // `detail` rides along: 0.153.4 never sets it on these four, but a kind
        // that DOES carry a message must not lose it on the way through a
        // hand-copied field list (the whitelist-drift class)
        this._processSubAgentActivity({ event_id: it.id, agent_thread_id: it.agent_thread_id || it.agentThreadId, agent_path: it.agent_path || it.agentPath, kind, detail: it.detail }, emit);
        return;
      }
      this._noteUnknown('event_msg', 'item_completed:SubAgentActivity:' + (kind || '(unkinded)'));
      return;
    }
    this._noteUnknown('event_msg', 'item_completed:' + (type || '(untyped)'));
  }

  // Codex sub-agents: the lifecycle of a spawned agent THREAD
  // (SubAgentActivityKind started | interacted | interrupted | completed,
  // 0.153.4 protocol.rs). ONE implementation, ONE shape (B-7473 ∪ the
  // item_completed allowlist router):
  //   · it ALWAYS learns agentPath → agent_thread_id (`status().subagents`) —
  //     that map is what makes an agent NAME clickable everywhere, and it is
  //     learned even when no row is drawn;
  //   · the fact renders as a one-line collab ACTIVITY row (dir 'activity'),
  //     coalesced with its neighbours. The old standalone "Sub-agent" tool
  //     CARD is RETIRED — a card per lifecycle event buried the conversation
  //     the owner was reading, and the row carries the same three facts (who,
  //     which kind, which thread) plus the click-through.
  //   · NO DOUBLE RENDER: on 0.153.4 the record's own id IS the id of the tool
  //     call that caused it (census: started → spawn_agent 18/18, interacted →
  //     send_message 197 + followup_task 17), and that call already drew its
  //     own collab row / tool card — so a record whose id is a known call is
  //     map-only. Terminal records synthesise `subagent-completed-<uuid>`
  //     (twinning nothing, 0/32) and therefore always draw their row.
  // Three carriers, one path: standalone `event_msg sub_agent_activity`
  // (0.149.1 rollouts — 349 records — and the wrapper's LIVE stream), the
  // thread/read mapper (src/codex-thread-read.js), and 0.153.4's
  // `item_completed {item:SubAgentActivity}` (the ONLY rollout carrier there).
  // Twin dedupe: (thread, kind, id) and (thread, kind) — 'interacted' repeats
  // per interaction and 'completed' is recorded more than once per thread
  // (32 records over 18 threads in the local corpus), so the corpus replay
  // draws one row per (thread, kind).
  _processSubAgentActivity(event, emit) {
    const tid = String(event.agent_thread_id || event.agentThreadId || '');
    const path = absAgentPath(String(event.agent_path || event.agentPath || ''), this._status.agentPath);
    const kind = String(event.kind || '');
    this._noteSubagentThread(path, tid); // always — even when the row is suppressed below
    const id = event.event_id != null ? String(event.event_id) : '';
    if (id && (this._collabSeen.has('call:' + id) || this.toolCallMessageIds.has(id))) return; // this record IS its own call's row/card
    // a foreign-thread ERROR arrives as kind 'errored' with the message here
    // (hover detail) — a child's failure is never the root's task_failed
    const detail = event.detail ? String(event.detail).slice(0, 300) : '';
    const key = `sa:${tid}:${kind}:${id}`;
    if (kind === 'errored') {
      // ERRORS ARE NOT INTERCHANGEABLE (round-5 fix). Every other kind repeats
      // the same fact — 'interacted' once per interaction, 'completed' recorded
      // more than once per thread — so a (thread, kind) key is the right
      // coalescing for them. An 'errored' record carries a MESSAGE: a child
      // that fails three times, differently worded, is three things the user
      // must read, and the (thread, kind) key silently dropped every one after
      // the first. Errors dedupe on their OWN identity: the event id when the
      // carrier gives one, else the detail text (a genuine re-read of the same
      // record still collapses; two different messages never do).
      // The key carries the id AND the message: a genuine re-read of one record
      // has both equal and still collapses, while two differently-worded errors
      // never do — even if their ids collide (the wrapper's synthesized id is
      // `foreign-error-<tid>-<Date.now()>`, and two failures inside one
      // millisecond would otherwise share it; the wrapper now also appends a
      // counter, but the key must not DEPEND on that being unique).
      // (No eviction here on purpose: `_collabSeen` also holds the durable
      // `call:<id>` double-render markers, and an FIFO sweep would drop one
      // while its SubAgentActivity twin is still to come. The error lane adds
      // at most one entry per record — the same growth class as the per-record
      // `key` below, which this set has always held.)
      const errKey = `sa:${tid}:errored:${id}|${detail}`;
      if (this._collabSeen.has(errKey)) return;
      this._collabSeen.add(errKey);
    } else {
      const kindKey = `sa:${tid}:${kind}`;
      if (this._collabSeen.has(key) || this._collabSeen.has(kindKey)) return;
      this._collabSeen.add(key);
      this._collabSeen.add(kindKey);
    }
    this._pushCollabRow({
      dir: 'activity',
      agentPath: path,
      agentName: agentName(path),
      kind,
      threadId: tid || null,
      detail,
    }, emit);
  }

  /** queue_changed = the WHOLE queue, authoritative. Session state (a `meta`
   *  op), never a transcript message. */
  _processQueueChanged(event, emit) {
    const items = Array.isArray(event.items) ? event.items : [];
    this._queue = items;
    this._queuePublished = true;
    if (Array.isArray(event.verbs)) this._queueVerbs = event.verbs.map((v) => String(v));
    const live = new Set(items.map((it) => String(it.msgId || '')).filter(Boolean));
    for (const it of items) this._stampQueueChip(it.msgId, 'queued', emit);
    // Left the queue with no explicit steer/remove ⇒ it RAN: drop the chip
    // rather than leave a bubble claiming to be queued forever.
    for (const msgId of [...this._queuedMsgIds]) if (!live.has(msgId)) this._stampQueueChip(msgId, null, emit);
    if (emit) this._emit({ op: 'meta', subtype: 'queue', items, supported: true, verbs: this._queueVerbs || null });
  }

  /** The outcome of one queue op. Success = a chip transition (for the two
   *  verbs that CHANGE what a bubble means); failure = a VISIBLE notice naming
   *  the reason (no silent failures). Either way the result is ALSO delivered
   *  as a `meta` op so the queue strip can end the row's pending state — a
   *  control that spins forever is the silent failure wearing a spinner. */
  _processQueueOpResult(event, emit) {
    const op = event.op, ok = event.ok !== false;
    const text = ok ? '' : CodexMessageManager.queueOpFailureText(event);
    // A BATCH verb (steer-all / run-all) answers with NO id — emit it anyway,
    // with an empty id, so the client can end the pending state of the rows it
    // marked. A result nobody can join to a row is a spinner that never stops.
    if (emit) this._emit({ op: 'meta', subtype: 'queue-result', queueOp: op, id: String(event.id || ''), ok, reason: event.reason || null, text: text || null });
    if (ok && (op === 'steer' || op === 'remove')) {
      const state = op === 'steer' ? 'steered' : 'removed';
      this._stampQueueChip(event.msg_id || event.msgId, state, emit);
      if (op === 'steer' && event.reason === 'steered-not-dequeued') {
        const msg = this._create({ role: 'system', status: 'error', content: [{ type: 'system_info', text: 'Steered, but the queued copy could not be removed — it may run a second time.' }], noticeKind: 'notice' });
        if (emit) this._emit({ op: 'create', message: msg });
      }
      return;
    }
    // reorder / edit / run-now / run-all leave the bubble's MEANING untouched
    // (it is still a queued message of yours) — the strip republished right
    // after them is the visible confirmation, deliberately card-less.
    if (ok) return;   // …as is steer-all's own ok:true summary
    if (!text) return;
    const msg = this._create({ role: 'system', status: 'complete', content: [{ type: 'system_info', text }], noticeKind: 'notice' });
    if (emit) this._emit({ op: 'create', message: msg });
  }

  /** PURE: the user-facing sentence for a failed queue op. Every branch says
   *  what happens to the message NOW — "it will simply run next" is the whole
   *  point of the turn-ended case. */
  static queueOpFailureText(event) {
    const op = event.op === 'steer-all' ? 'steer-all' : event.op;
    const what = op === 'remove' ? 'remove'
      : op === 'reorder' ? 'move'
        : op === 'edit' ? 'edit'
          : (op === 'run-now' || op === 'run-all') ? 'start'
            : 'steer';
    switch (event.reason) {
      case 'not-steerable':
        return `Cannot steer during a ${event.kind || 'review'} turn — the message stays queued and runs when this turn ends.`;
      case 'turn-mismatch':
      case 'no-active-turn':
        return 'The turn ended before the message could be steered — it stays queued and will simply run next.';
      case 'gone':
        return 'That message is no longer queued — it already ran.';
      case 'no-thread':
        return 'The session has no thread yet — the queue is not available.';
      // …the verb-table reasons (2026-09-07). Each says what is true NOW.
      case 'busy':
        return op === 'run-all'
          ? 'A turn is already running — the queued messages run as soon as it ends.'
          : 'A turn is already running — that message runs as soon as it ends.';
      case 'not-editable':
        return 'That message was sent by another agent — you can remove it, but not rewrite it.';
      case 'anchor-gone':
        return 'The message it was dropped after is no longer queued — nothing was moved.';
      case 'stale-order':
        // The app-server rejects an order that is not the WHOLE queue (measured
        // 0.153.4: "must include every queued submission exactly once"), which
        // is what a queue changing under the move looks like from here.
        return 'The queue changed while that move was in flight — nothing was moved. Try again.';
      case 'incomplete':
        return `The queue could not be read to the end, so nothing was changed${event.detail ? ` (${event.detail})` : ''}.`;
      case 'empty':
        return 'Nothing is queued.';
      case 'empty-text':
        return 'An edited message needs some text — remove it instead.';
      case 'unknown-op':
        return `Unsupported queue action "${event.op}".`;
      default:
        return `Could not ${what} the queued message${event.detail ? `: ${event.detail}` : ''}.`;
    }
  }

  _processEvent(event, emit) {
    const type = event.type;
    if (!type) return;
    if (type === 'web_search_begin' || type === 'web_search_end') return this._processWebSearchEvent(event, emit);
    // the ≤0.130 engine's own image-view record (the only trace when the
    // function_call pair is absent) — routed, not skipped, since 2.369.48
    if (type === 'view_image_tool_call') return this._processViewImageEvent(event, emit);
    // BEFORE the generic skip: 0.153.4 persists web.search / image_gen / ImageView ONLY here
    if (type === 'item_completed') return this._processItemCompleted(event, emit);

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

    // P2 notices the wrapper emits around the codex turn loop (2.369.20):
    // queued input, real compaction, slash commands applied for the next turn.
    // The queue lives ON the bubble (a chip that becomes 'steered'/'removed')
    // and in the strip above the input — the old system card said the same
    // thing a third time and pushed the conversation down. The card survives
    // ONLY as the fallback for a queued message with no bubble of its own.
    if (type === 'queued_input' && this._queuePublished && this._stampQueueChip(event.msg_id || event.msgId, 'queued', emit)) return;
    if (type === 'queue_changed') return this._processQueueChanged(event, emit);
    if (type === 'queue_op_result') return this._processQueueOpResult(event, emit);
    if (type === 'queued_input' || type === 'compact_started' || type === 'context_compacted' || type === 'command_applied') {
      const text = type === 'queued_input' ? 'Queued — runs after the current turn'
        : type === 'compact_started' ? 'Compacting context…'
        : type === 'context_compacted' ? 'Context compacted'
        : `/${event.command} → ${event.value} (applies to the next turn)`;
      if (type === 'context_compacted') this.turnIndex++; // a compaction starts a new turn (minimap marker parity with claude's compact summary turn)
      const msg = this._create({ role: 'system', status: 'complete', content: [{ type: 'system_info', text }], noticeKind: type === 'context_compacted' ? 'compact' : 'notice' });
      if (type === 'context_compacted') msg.isCompact = true;
      if (emit) this._emit({ op: 'create', message: msg });
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
      // Shapes seen in the wild: rollout-native snake_case (last_token_usage),
      // and the v2 notification's nested camelCase ({ last, total })
      const last = info.last_token_usage || info.lastTokenUsage || info.last || info.total_token_usage || null;
      const total = info.total_token_usage || info.totalTokenUsage || info.total || null;
      const contextWindow = info.model_context_window || info.modelContextWindow || 0;
      if (last) this._status.lastUsage = {
        input_tokens: last.input_tokens || last.inputTokens || 0,
        cache_read_input_tokens: last.cached_input_tokens || last.cache_read_input_tokens || last.cachedInputTokens || 0,
        cache_creation_input_tokens: last.cache_creation_input_tokens || last.cacheCreationInputTokens || 0,
      };
      if (total) this._status.totalUsage = {
        total_tokens: total.total_tokens ?? total.totalTokens ?? 0,
        input_tokens: total.input_tokens ?? total.inputTokens ?? 0,
        cached_input_tokens: total.cached_input_tokens ?? total.cachedInputTokens ?? 0,
        output_tokens: total.output_tokens ?? total.outputTokens ?? 0,
        reasoning_output_tokens: total.reasoning_output_tokens ?? total.reasoningOutputTokens ?? 0,
      };
      if (contextWindow) this._status.contextWindow = contextWindow;
      // contextWindow rides the usage meta: the status bar's context% needs
      // BOTH numbers, and on a live session the window otherwise only arrived
      // via the attach-time chatStatus — a created-here codex session showed
      // "123k/?" until re-attach (2.368.15).
      if (emit && this._status.lastUsage) this._emit({ op: 'meta', subtype: 'usage', data: { ...this._status.lastUsage, contextWindow: this._status.contextWindow || 0, totals: this._status.totalUsage || null } });
      this._threadUsageMeta(last, total, emit);
      return;
    }

    if (type === 'sub_agent_activity') return this._processSubAgentActivity(event, emit);

    if (type === 'thread_settings_applied') {
      // 0.153: the app-server's own confirmation of the thread's settings
      // (model / reasoning_effort / approval_policy / cwd…) — the typed source
      // for the status bar; never a card.
      const s = event.thread_settings && typeof event.thread_settings === 'object' ? event.thread_settings : {};
      if (s.model) this._status.model = String(s.model);
      // The THREAD's effort = what the next turn will run at (2.369.62: it is
      // NOT a statement about the turn in flight, which keeps the value its own
      // turn_context named — a set-effort mid-turn must not relabel the
      // messages already produced). Before any turn has named one it is also
      // the best answer for "now".
      if (s.reasoning_effort) {
        const level = String(s.reasoning_effort);
        this._noteEffort(this._status.effort ? null : level, level, emit);
      }
      return;
    }

    if (type === 'plan_updated') {
      // Codex update_plan → same pipeline as Claude's TodoWrite
      const todos = (Array.isArray(event.plan) ? event.plan : []).map((p) => ({
        content: p.step || '',
        status: p.status === 'inProgress' || p.status === 'in_progress' ? 'in_progress'
          : p.status === 'completed' ? 'completed' : 'pending',
      })).filter((t) => t.content);
      if (emit) this._emit({ op: 'meta', subtype: 'todos', data: todos });
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
        // Do NOT finalize the other open streams here (2.368.16, owner's
        // "不是人话" report): codex collab/sub-agent turns interleave the
        // deltas of SEVERAL message items delta-by-delta (real buffer:
        // …464ab10d and …73147228 alternating per character), and closing
        // every open stream on each key switch chopped both messages into
        // per-run fragments ("断 AA 边", "缘小" …). Streams close per-key when
        // their full response_item:message arrives, and task_complete/
        // turn_aborted still finalize everything.
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

    // A ServerRequest the wrapper answered with a JSON-RPC error (2.369.58):
    // codex asked this client for something only a client that OWNS the value
    // can produce (a dynamic tool call, an attestation token, a ChatGPT token
    // refresh) or for a method we have no branch for. The turn FAILS CLEANLY,
    // and it says so here instead of hanging behind an unanswerable card.
    if (type === 'client_request_unsupported') {
      const method = String(event.method || '(unnamed)');
      this._noteUnknown('server_request', 'unsupported:' + method);
      const msg = this._create({
        role: 'system',
        status: 'error',
        content: [{ type: 'system_info', text: `Codex asked VibeSpace for "${method}", which this client cannot answer${event.reason ? ` (${event.reason})` : ''} — the request was declined.` }],
      });
      if (emit) this._emit({ op: 'create', message: msg });
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
      return;
    }

    if (SKIPPED_EVENT_TYPES.has(type)) return;
    this._noteUnknown('event_msg', type);
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
    } else if (method === 'mcpServer/elicitation/request') {
      // MCP ELICITATION (2.369.58) — an MCP server asking the human for
      // structured input. It renders as the SAME question-card family as
      // AskUserQuestion / requestUserInput; the rows come from the WRAPPER
      // (`payload.questions`, derived from the requestedSchema by the same
      // function that maps the answer back onto the right property), so the
      // card and the reply can never disagree.
      // `mode:'url'` carries no schema — it is "open this link and confirm",
      // i.e. the plain approve/deny card, and the reply is {action:'accept'}.
      permission.toolName = params.serverName ? `MCP: ${params.serverName}` : 'MCP';
      permission.input = { message: params.message || '', mode: params.mode || 'form', ...(params.url ? { url: params.url } : {}) };
      const rows = asArray(payload.questions);
      if (rows.length && params.mode !== 'url') {
        permission.kind = 'user_input';
        permission.questions = rows;
      }
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

CodexMessageManager._seenUnknownRecords = new Set();
CodexMessageManager.SKIPPED_RECORD_TYPES = SKIPPED_RECORD_TYPES;
CodexMessageManager.SKIPPED_RESPONSE_ITEM_TYPES = SKIPPED_RESPONSE_ITEM_TYPES;
CodexMessageManager.SKIPPED_EVENT_TYPES = SKIPPED_EVENT_TYPES;
CodexMessageManager.ITEM_COMPLETED_SKIPPED_TYPES = ITEM_COMPLETED_SKIPPED_TYPES;

module.exports = { CodexMessageManager };
