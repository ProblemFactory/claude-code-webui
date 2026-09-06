const fs = require('fs');
const path = require('path');
const {
  CODEX_SESSIONS_DIR,
  extractCodexThreadMeta,
  findCodexSessionJsonlPath,
  parseCodexSessionJsonl,
  transcriptWorkerCall,
} = require('./adapters/codex');
const { listOpenCodexRolloutPaths, codexThreadIdOf, CODEX_ROLLOUT_RE } = require('./discovery-facts');

function getCodexHistorySessionId(session) {
  return session?.backendSessionId || session?.claudeSessionId || null;
}

function getSessionKey(session = {}) {
  const backend = session.backend || 'claude';
  const backendSessionId = session.backendSessionId || session.sessionId || session.claudeSessionId || null;
  return backendSessionId ? `${backend}:${backendSessionId}` : '';
}

function parseBufferRecords(buffer) {
  const records = [];
  for (const line of String(buffer || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch {}
  }
  return records;
}

// Codex LIVENESS = a rollout held open by a codex process (no lock files).
// The fd/lsof scan is ONE implementation in discovery-facts
// (listOpenCodexRolloutPaths — shared with the daemon snapshot's CO lines and
// mirrored by the ssh script); this file only turns paths into thread ids.
function _openThreadIdsUncached() {
  const ids = new Set();
  for (const p of listOpenCodexRolloutPaths({ sessionsDir: CODEX_SESSIONS_DIR })) {
    const tid = codexThreadIdOf(p);
    if (tid) ids.add(tid);
  }
  return ids;
}

let _openThreadsCache = null; // {ids, at} — the /proc walk (readdir all pids +
// per-codex-fd readlinks) ran every ~5s sweep; external-codex detection
// tolerates 10s staleness easily (audit round-2)
function listOpenCodexThreadIds() {
  if (_openThreadsCache && Date.now() - _openThreadsCache.at < 10000) return _openThreadsCache.ids;
  const ids = _openThreadIdsUncached();
  _openThreadsCache = { ids, at: Date.now() };
  return ids;
}
/** Off-loop twin (S3 hot path): the /proc walk runs in the transcript worker
 *  (`codexOpenThreads` op); same 10s cache, same result shape. */
async function listOpenCodexThreadIdsAsync() {
  if (_openThreadsCache && Date.now() - _openThreadsCache.at < 10000) return _openThreadsCache.ids;
  const arr = await transcriptWorkerCall('codexOpenThreads', {}, () => [..._openThreadIdsUncached()]);
  const ids = new Set(Array.isArray(arr) ? arr : []);
  _openThreadsCache = { ids, at: Date.now() };
  return ids;
}

// ── The rollout walk (S3 hot path) ──
// Every 5s /api/sessions poll used to readdir the whole ~/.codex/sessions
// tree + head-read every rollout ON THE LOOP (an NFS home stalled the whole
// instance per poll). Now: (1) the walk keeps a PER-DIRECTORY mtime cache —
// a directory whose mtime is unchanged (and older than 2s: coarse NFS
// timestamps) reuses its cached listing, no readdir; (2) extractCodexThreadMeta
// keeps its per-file mtime cache; (3) the whole thing runs in the transcript
// worker for the poll (listCodexThreadsAsync) so the main thread only pays
// for the structured-clone of the small meta array. The sync listCodexThreads
// (user-action consumers: capture, migration map, spawn baseline) is
// unchanged in behaviour and shares the same functions.
const _dirCache = new Map(); // dir -> { mtimeMs, dirs: [names], files: [names] }
const DIR_CACHE_MAX = 4096;
const DIR_CACHE_SETTLE_MS = 2000;
const _dirStats = { hits: 0, misses: 0 };
function _listDirCached(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  const hit = _dirCache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs && Date.now() - st.mtimeMs > DIR_CACHE_SETTLE_MS) { _dirStats.hits++; return hit; }
  _dirStats.misses++;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const dirs = [], files = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile() && CODEX_ROLLOUT_RE.test(e.name)) files.push(e.name);
  }
  // plain before compressed so a thread with both lists its .jsonl (2.369 zst)
  files.sort((a, b) => (a.endsWith('.zst') ? 1 : 0) - (b.endsWith('.zst') ? 1 : 0));
  const rec = { mtimeMs: st.mtimeMs, dirs, files };
  _dirCache.set(dir, rec);
  if (_dirCache.size > DIR_CACHE_MAX) _dirCache.delete(_dirCache.keys().next().value);
  return rec;
}
function dirCacheStats() { return { ..._dirStats, size: _dirCache.size }; }

/** Pass 1: walk the sessions tree, extract every thread's meta (first wins
 *  per threadId), collect the forkedFrom chains. Pure facts — no session
 *  state — so the worker can run it and the main thread assembles. */
function collectCodexThreadMetas() {
  const seen = new Set();
  const metas = [];
  const mergedThreadIds = new Set();
  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length) {
    const current = stack.pop();
    const rec = _listDirCached(current);
    if (!rec) continue;
    for (const d of rec.dirs) stack.push(path.join(current, d));
    for (const f of rec.files) {
      const meta = extractCodexThreadMeta(path.join(current, f));
      if (!meta.threadId || seen.has(meta.threadId)) continue;
      seen.add(meta.threadId);
      // Collect forkedFrom from JSONL metadata (persisted across session lifecycle)
      for (const forkId of meta.forkedFrom || []) mergedThreadIds.add(forkId);
      metas.push(meta);
    }
  }
  return { metas, mergedThreadIds: [...mergedThreadIds] };
}

/** Pass 2: metas + live sessions + open rollouts → the session-list entries
 *  (merged fork sources hidden; live/external/stopped status). */
function assembleCodexThreads({ metas, mergedThreadIds }, { activeSessions, openThreadIds }) {
  const sessions = [];
  const activeByThreadId = new Map();
  const merged = new Set(mergedThreadIds || []);
  for (const [id, session] of activeSessions || []) {
    if (session.backend !== 'codex') continue;
    const threadId = session.backendSessionId || session.claudeSessionId;
    if (!threadId) continue;
    activeByThreadId.set(threadId, { id, session });
    for (const forkId of session.forkedFrom || []) merged.add(forkId);
  }
  for (const meta of metas) {
    if (merged.has(meta.threadId)) continue;
    const active = activeByThreadId.get(meta.threadId);
    const isExternal = !active && openThreadIds.has(meta.threadId);
    sessions.push({
      backend: 'codex',
      backendSessionId: meta.threadId,
      sessionId: meta.threadId,
      sessionKey: getSessionKey({ backend: 'codex', backendSessionId: meta.threadId }),
      cwd: meta.cwd || '',
      startedAt: meta.updatedAt || Date.now(),
      status: active ? 'live' : (isExternal ? 'external' : 'stopped'),
      name: meta.name || meta.agentNickname || meta.agentRole || '',
      source: meta.source || null,
      sourceKind: meta.sourceKind || null,
      agentKind: meta.agentKind || 'primary',
      agentRole: meta.agentRole || '',
      agentNickname: meta.agentNickname || '',
      parentThreadId: meta.parentThreadId || null,
      forkedFromId: meta.forkedFromId || null,                 // codex's own fork parent (0.153 thread/fork, sub-agent spawn) — NOT hidden: it is its own conversation
      forkedFromOrdinal: Number.isInteger(meta.forkedFromOrdinal) ? meta.forkedFromOrdinal : null,
      historyMode: meta.historyMode || null,
      webuiId: active?.id || null,
      webuiName: active?.session?.name || null,
      webuiMode: active?.session?.mode || null,
    });
  }
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  return sessions;
}

/** The fork ancestry a thread's read-only view prepends, oldest → newest
 *  (codex 0.153 paginated forks). Two sources, ONE list:
 *   · the wrapper's `forked_from` chain (superseded ids of THIS conversation
 *     — merged whole, exactly as before; the fingerprint dedup absorbs the
 *     twin records a copied history carries)
 *   · codex's OWN `forked_from_id` parents whose boundary is KNOWN — a
 *     'Referenced' fork's rollout holds none of the parent's records, only
 *     `history_base.end_ordinal_exclusive` / `forked_from_ordinal_exclusive`
 *     (parent-numbered): the parent's records below it ARE the fork's
 *     history, its later turns belong to the parent alone.
 *  Entry = { id, untilOrdinal|null } (null = whole file). A sub-agent's
 *  `subagent_history_start_ordinal` is child-numbered and its rollout already
 *  copies the inherited context, so it never adds an ancestor here. Depth-
 *  capped (8), cycle-safe, a missing rollout ends the walk. */
function resolveCodexForkAncestry(threadId, wrapperChain = []) {
  const entries = [];
  const seen = new Set(threadId ? [threadId] : []);
  for (const id of Array.isArray(wrapperChain) ? wrapperChain : []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, untilOrdinal: null });
  }
  const native = [];
  let cur = threadId, depth = 0;
  while (cur && depth++ < 8) {
    const fp = findCodexSessionJsonlPath(cur);
    if (!fp) break;
    const m = extractCodexThreadMeta(fp);
    const until = Number.isInteger(m.forkedFromOrdinal) ? m.forkedFromOrdinal : null;
    if (!m.forkedFromId || until === null) break;
    const parent = m.forkedFromId;
    const existing = entries.find((e) => e.id === parent);
    if (existing) existing.untilOrdinal = existing.untilOrdinal === null ? until : Math.min(existing.untilOrdinal, until);
    else if (!seen.has(parent)) { seen.add(parent); native.unshift({ id: parent, untilOrdinal: until }); }
    else break;
    cur = parent;
  }
  return [...native, ...entries];
}

/** Keep only the records below a parent-numbered boundary. Records without a
 *  top-level `ordinal` (pre-0.153 rollouts, wrapper buffer copies) are kept —
 *  the boundary can only speak about records that carry one. */
function cutRecordsAtOrdinal(records, untilOrdinal) {
  if (!Number.isInteger(untilOrdinal)) return records;
  return (records || []).filter((r) => !Number.isInteger(r?.ordinal) || r.ordinal < untilOrdinal);
}

/** Per-record FILE provenance for a merged read. CodexSessionMessages
 *  concatenates several rollouts (fork ancestry + the thread's own file), so a
 *  record's ledger thread id is a fact about the FILE it came from — never
 *  about the reader's session: the usage walker keys `cx:<file uuid>:<cum>`
 *  per FILE, and a reader-wide id keyed every parent-half token_count of a
 *  merged fork read `cx:<child>:…` (0/30 parent messages matched the parent's
 *  ledger; two collided with real child events — round-3 verifier, real
 *  rollouts). The tag is NON-ENUMERABLE: it never reaches JSON.stringify
 *  (fingerprints, wire payloads, caches) and survives the sort copy below.
 *  Buffer (live) records are deliberately left untagged — they follow the
 *  normalizer's in-stream default (wrapper_meta.threadId = the file the
 *  wrapper writes), see codex-message-manager._adoptThreadId. */
const RECORD_THREAD_KEY = '__threadId';
function tagRecordThread(records, threadId) {
  if (!threadId) return records;
  const tid = String(threadId);
  for (const r of records || []) {
    if (r && typeof r === 'object') Object.defineProperty(r, RECORD_THREAD_KEY, { value: tid, enumerable: false, configurable: true, writable: true });
  }
  return records;
}
function recordThreadOf(record) {
  return record && typeof record === 'object' && typeof record[RECORD_THREAD_KEY] === 'string' && record[RECORD_THREAD_KEY] ? record[RECORD_THREAD_KEY] : null;
}

function sortRecords(records) {
  return records
    .map((record, idx) => {
      const copy = { ...record, __idx: idx, __ts: Date.parse(record.timestamp || '') || 0 };
      const tid = recordThreadOf(record);
      if (tid) Object.defineProperty(copy, RECORD_THREAD_KEY, { value: tid, enumerable: false, configurable: true, writable: true }); // the spread drops non-enumerables
      return copy;
    })
    .sort((a, b) => (a.__ts - b.__ts) || (a.__idx - b.__idx));
}

function recordFingerprint(record, turnId) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'session_meta') return `session_meta:${record.payload?.id || ''}`;
  if (record.type === 'turn_context') return `turn_context:${record.payload?.turn_id || record.payload?.turnId || ''}`;
  if (record.type === 'wrapper_meta') return `wrapper_meta:${record.payload?.threadId || ''}:${record.payload?.activeTurnId || ''}`;
  if (record.type === 'server_request') return `server_request:${record.payload?.id}`;
  if (record.type === 'server_request_resolved') return `server_request_resolved:${record.payload?.id}:${record.payload?.decision || ''}`;
  const payload = record.payload || {};
  if (record.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'user') {
      const webuiMsgId = payload.webui_msg_id || payload.webuiMsgId || payload.client_msg_id || payload.clientMsgId || '';
      if (webuiMsgId) return `${turnId}:response_item:user:${webuiMsgId}`;
    }
    const key = payload.call_id || payload.callId || payload.role || payload.type || 'item';
    // Strip volatile fields — the SAME item serializes differently on each
    // side: the wrapper's buffer copy carries item_id, the rollout JSONL copy
    // carries id + internal_chat_message_metadata_passthrough instead. Any of
    // them surviving into the fingerprint made buffer/JSONL twins never dedup
    // (assistant text rendered twice in a row on every attach). webui_peer is
    // the wrapper's peer-message marker (buffer copy only; codex's rollout
    // copy of the same user message has just the text) — same twin rule, or
    // every delivered peer message rendered twice after a restart.
    const { item_id, itemId, id, internal_chat_message_metadata_passthrough, webui_peer, ...stablePayload } = payload;
    return `${turnId}:response_item:${payload.type}:${key}:${JSON.stringify(stablePayload)}`;
  }
  if (record.type === 'event_msg') {
    const key = payload.turn_id || payload.turnId || payload.call_id || payload.callId || payload.item_id || payload.itemId || payload.type || 'event';
    const { item_id, itemId, id, internal_chat_message_metadata_passthrough, ...stablePayload } = payload;
    return `${turnId}:event_msg:${payload.type}:${key}:${JSON.stringify(stablePayload)}`;
  }
  return null;
}

function mergeCodexRecords(historyRecords, liveRecords) {
  const merged = [];
  const seen = new Set();
  let currentTurnId = 'prelude';
  for (const record of sortRecords([...(historyRecords || []), ...(liveRecords || [])])) {
    if (record.type === 'turn_context') {
      currentTurnId = record.payload?.turn_id || record.payload?.turnId || currentTurnId;
    }
    const fp = recordFingerprint(record, currentTurnId);
    if (fp && seen.has(fp)) continue;
    if (fp) seen.add(fp);
    delete record.__idx;
    delete record.__ts;
    merged.push(record);
  }
  return merged;
}

class CodexSessionMessages {
  constructor(session, sessionId, { buffersDir } = {}) {
    this._session = session;
    this._sessionId = sessionId;
    this._buffersDir = buffersDir;
    this._all = null;
    this._wrapperMeta = undefined;
  }

  _ensureParsed() {
    if (this._all) return;
    const threadId = getCodexHistorySessionId(this._session);
    // Fork ancestry first (oldest → newest; the wrapper chain whole, codex's
    // own 0.153 fork parents cut at their boundary ordinal), then the current
    // thread. NOTE: parseCodexSessionJsonl is tail-bounded (32MB) — a
    // Referenced fork off a parent larger than that reads the parent's TAIL,
    // which the boundary then (correctly) rejects: bounded, never wrong records.
    const ancestry = resolveCodexForkAncestry(threadId, this._session?.forkedFrom || []);
    let history = [];
    // Every file's records are tagged with THAT file's thread id (tagRecordThread)
    // — the normalizer keys each response's ledger meta by the record's own
    // file, exactly as the walker does; the reader's id is only the default
    // for provenance-less records (the live buffer below).
    for (const { id: forkId, untilOrdinal } of ancestry) {
      const forkHistory = tagRecordThread(cutRecordsAtOrdinal(parseCodexSessionJsonl(forkId), untilOrdinal), forkId);
      if (forkHistory.length) history = mergeCodexRecords(history, forkHistory);
    }
    const currentHistory = threadId ? tagRecordThread(parseCodexSessionJsonl(threadId), threadId) : [];
    if (currentHistory.length) history = mergeCodexRecords(history, currentHistory);
    const live = parseBufferRecords(this._session?.buffer || '');
    this._all = mergeCodexRecords(history, live);
  }

  get total() { this._ensureParsed(); return this._all.length; }
  raw() { this._ensureParsed(); return this._all; }
  tail(n = 50) { this._ensureParsed(); return this._all.slice(-n); }
  slice(offset, limit) { this._ensureParsed(); return this._all.slice(offset, offset + limit); }

  get isStreaming() {
    const meta = this.wrapperMeta();
    return !!meta?.streaming;
  }

  wrapperMeta() {
    if (this._wrapperMeta !== undefined) return this._wrapperMeta;
    if (!this._buffersDir || !this._sessionId) {
      this._wrapperMeta = null;
      return this._wrapperMeta;
    }
    try {
      this._wrapperMeta = JSON.parse(fs.readFileSync(path.join(this._buffersDir, `${this._sessionId}.json`), 'utf-8'));
    } catch {
      this._wrapperMeta = null;
    }
    return this._wrapperMeta;
  }

  chatStatus() {
    this._ensureParsed();
    const status = {
      model: '',
      lastUsage: null,
      contextWindow: 0,
      total_cost_usd: 0,
      permissionMode: '',
      permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
      subagentMetas: [],
      effort: null,
      sandbox: null,
      totalUsage: null,
    };
    const meta = this.wrapperMeta();
    if (meta?.model) status.model = meta.model;
    if (meta?.permissionMode) status.permissionMode = meta.permissionMode;
    if (meta?.contextWindow) status.contextWindow = meta.contextWindow;
    if (meta?.subagentMetas) status.subagentMetas = meta.subagentMetas;
    if (meta?.sandbox) status.sandbox = meta.sandbox;
    if (meta?.totalTokenUsage) {
      const t = meta.totalTokenUsage;
      status.totalUsage = {
        total_tokens: t.total_tokens ?? t.totalTokens ?? 0,
        input_tokens: t.input_tokens ?? t.inputTokens ?? 0,
        cached_input_tokens: t.cached_input_tokens ?? t.cachedInputTokens ?? 0,
        output_tokens: t.output_tokens ?? t.outputTokens ?? 0,
        reasoning_output_tokens: t.reasoning_output_tokens ?? t.reasoningOutputTokens ?? 0,
      };
    }

    for (const record of this._all) {
      if (record.type === 'session_meta' && !status.model) {
        status.model = record.payload?.model || '';
      } else if (record.type === 'turn_context') {
        if (record.payload?.model) status.model = record.payload.model;
        if (record.payload?.permissionMode) status.permissionMode = record.payload.permissionMode;
        if (record.payload?.approval_policy && !status.permissionMode) status.permissionMode = record.payload.approval_policy;
        if (record.payload?.model_context_window) status.contextWindow = record.payload.model_context_window;
        if (record.payload?.effort) status.effort = record.payload.effort;
        if (record.payload?.sandbox_policy && !status.sandbox) status.sandbox = record.payload.sandbox_policy;
      } else if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
        const info = record.payload.info || {};
        const last = info.last_token_usage || info.lastTokenUsage || info.total_token_usage || null;
        if (last) {
          status.lastUsage = {
            input_tokens: last.input_tokens || last.inputTokens || 0,
            cache_read_input_tokens: last.cached_input_tokens || last.cache_read_input_tokens || last.cachedInputTokens || 0,
            cache_creation_input_tokens: last.cache_creation_input_tokens || last.cacheCreationInputTokens || 0,
          };
        }
        if (info.model_context_window || info.modelContextWindow) {
          status.contextWindow = info.model_context_window || info.modelContextWindow;
        }
      }
    }

    return status.model || status.lastUsage || status.permissionMode ? status : null;
  }

  taskState() {
    const meta = this.wrapperMeta();
    const tasks = {};
    for (const [taskId, taskInfo] of Object.entries(meta?.tasks || {})) {
      if ((taskInfo?.type || '') !== 'agent') continue;
      if ((taskInfo?.status || '') !== 'running') continue;
      tasks[taskId] = taskInfo;
    }
    // Codex's plan tool (update_plan) — persisted by the wrapper, mapped to
    // the same TODO shape Claude's TodoWrite uses so attach restores the
    // TODO display
    const todos = (Array.isArray(meta?.plan) ? meta.plan : []).map((p) => ({
      content: p.step || '',
      status: p.status === 'inProgress' || p.status === 'in_progress' ? 'in_progress'
        : p.status === 'completed' ? 'completed' : 'pending',
    })).filter((t) => t.content);
    return {
      tasks,
      todos,
    };
  }
}

/** Sync listing (user-action consumers). Behaviour unchanged. */
function listCodexThreads({ activeSessions } = {}) {
  return assembleCodexThreads(collectCodexThreadMetas(), { activeSessions, openThreadIds: listOpenCodexThreadIds() });
}

/** The 5s-poll listing (S3): walk + head reads + the /proc scan run in the
 *  transcript worker; only the assembly touches the main thread. Worker
 *  down ⇒ the same functions run inline (identical result, no isolation). */
async function listCodexThreadsAsync({ activeSessions } = {}) {
  const [facts, openThreadIds] = await Promise.all([
    transcriptWorkerCall('codexThreadMetas', {}, collectCodexThreadMetas),
    listOpenCodexThreadIdsAsync(),
  ]);
  return assembleCodexThreads(facts, { activeSessions, openThreadIds });
}

module.exports = {
  CODEX_SESSIONS_DIR,
  CodexSessionMessages,
  findCodexSessionJsonlPath,
  getCodexHistorySessionId,
  listCodexThreads,
  listCodexThreadsAsync,
  collectCodexThreadMetas,
  assembleCodexThreads,
  listOpenCodexThreadIds,
  dirCacheStats,
  mergeCodexRecords,
  parseCodexSessionJsonl,
  resolveCodexForkAncestry,
  cutRecordsAtOrdinal,
  tagRecordThread,
  recordThreadOf,
  RECORD_THREAD_KEY,
};
