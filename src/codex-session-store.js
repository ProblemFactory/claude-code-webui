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
  // SETTLEDNESS IS A PROPERTY OF THE CAPTURE, NOT OF THE LOOKUP. The guard
  // exists because directory mtimes are coarse (1s on many filesystems, NFS
  // included): a listing taken while the current mtime tick was still open
  // may miss a sibling created in that same second — and that sibling never
  // bumps the mtime again. Evaluating `now - mtime > 2s` at LOOKUP time (the
  // 2.369 shape) trusted such a capture FOREVER once the clock passed
  // mtime+2s: a rollout created in the same second as its neighbour never
  // appeared in the session list (the poll is 5s, so the window is always
  // over by the next lookup). Record it at FILL time instead — an unsettled
  // capture is re-read on the next lookup until it is taken settled.
  if (hit && hit.mtimeMs === st.mtimeMs && hit.settled) { _dirStats.hits++; return hit; }
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
  const rec = { mtimeMs: st.mtimeMs, dirs, files, settled: Date.now() - st.mtimeMs > DIR_CACHE_SETTLE_MS };
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

/** The webui id a user record is FINGERPRINTED by, in every spelling a producer
 *  uses. ONE spelling, so the fingerprint and the twin rule can never disagree
 *  about which copies are id-keyed.
 *  `webui_queue_id` IS one of them (round 2, 2026-09-07): it is the app-server's
 *  clientUserMessageId for the submission whose bubble we wrote — for an
 *  INHERITED queue item that value is literally the webui msgId the wrapper we
 *  replaced minted, so the two spellings name the same submission and belong in
 *  the same namespace. Keying it on CONTENT instead (round 1) silently deleted a
 *  steered message: two inherited items with the SAME text in one turn hashed
 *  identically and the second was dropped on rebuild — two bubbles live, one
 *  after a reload, in the exact scenario this code exists to fix. */
function userRecordIdentity(payload) {
  return payload.webui_msg_id || payload.webuiMsgId || payload.client_msg_id || payload.clientMsgId
    || payload.webui_queue_id || payload.webuiQueueId || '';
}

/** Codex's OWN id for a user message — `msg_…`, minted per SUBMISSION.
 *  A user record that carries none of our markers is codex's copy, and its
 *  identity is this id, never its text: MEASURED on the local rollout corpus
 *  (89 files), the turn-scoped CONTENT key deleted 133 real user messages on
 *  reload — every collision a different `id` AND a different `create_time`,
 *  i.e. 133 distinct submissions, zero genuine duplicates. Cross-file dedup
 *  (a native fork replays its parent's records) survives because a fork REUSES
 *  the parent's ids (measured: 4/4 and 9/9 shared on real fork chains).
 *  Pre-0.15x rollouts wrote no id (144/572 records, all in files ≤2026-05, none
 *  mixed) — those fall back to the content key, i.e. their behaviour is
 *  byte-identical to before. */
function codexRecordIdentity(payload) {
  return typeof payload.id === 'string' && payload.id ? payload.id : '';
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
      const webuiMsgId = userRecordIdentity(payload);
      if (webuiMsgId) return `${turnId}:response_item:user:${webuiMsgId}`;
      // Codex's own copy: keyed by the id IT minted for this submission (see
      // codexRecordIdentity). Separate namespace — a `msg_…` and a webui id
      // are different id spaces, and the ours↔codex twin is retired by the
      // CLAIM below, never by a shared key.
      const codexId = codexRecordIdentity(payload);
      if (codexId) return `${turnId}:response_item:user#codex:${codexId}`;
      // NEITHER side has an id: a pre-0.15x rollout record, or a copy of OURS
      // whose webui id arrived empty (the wrapper writes `webui_msg_id:
      // msg.msgId || ''`). Content is the only fact left — but the two
      // PRODUCERS stay in separate namespaces, so `seen` can only ever collapse
      // copies of ONE producer's record. That is what makes "a record dropped
      // as a duplicate has already had its twin effect applied" true, and with
      // it the round-2 claim leak (a claim short-circuited by `seen` and never
      // retired, which later deleted an unrelated message) structurally
      // impossible. The ours↔codex pair is retired by the CLAIM, as everywhere.
      return `${turnId}:response_item:user#${userRecordIsOurs(payload) ? 'ours' : 'codex'}:${userContentKey(payload) || ''}`;
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
    // thread_id/turn_id ride ONLY the wrapper's copy (B-7473 item context) —
    // stripped for exactly the same reason. The webui user markers are listed
    // here for a record that carries one WITHOUT being a `message`/user pair
    // (the branch above owns every user message and always returns): a marker
    // must never be the difference between our copy and codex's, wherever it
    // rides.
    const { item_id, itemId, id, internal_chat_message_metadata_passthrough, webui_peer, webui_queue_id, webuiQueueId, webui_queue_via, webui_after_commit, webuiAfterCommit,
      webui_no_commit, webuiNoCommit, webui_msg_id, webuiMsgId, client_msg_id, clientMsgId, thread_id, turn_id, ...stablePayload } = payload;
    return `${turnId}:response_item:${payload.type}:${key}:${JSON.stringify(stablePayload)}`;
  }
  if (record.type === 'event_msg') {
    const key = payload.turn_id || payload.turnId || payload.call_id || payload.callId || payload.item_id || payload.itemId || payload.type || 'event';
    const { item_id, itemId, id, internal_chat_message_metadata_passthrough, thread_id, turn_id, ...stablePayload } = payload;
    return `${turnId}:event_msg:${payload.type}:${key}:${JSON.stringify(stablePayload)}`;
  }
  return null;
}

/** A turn_context the WRAPPER synthesized, as opposed to codex's own rollout
 *  copy: ours has always carried `modelPinned` (2.369.32) and now says so
 *  outright. The distinction decides which copy wins the fold below. */
function isWrapperTurnContext(record) {
  const p = record?.payload || {};
  return p.wrapper === true || p.modelPinned !== undefined;
}

/** The wrapper's own copy of a settings record (r2 review). codex's rollout
 *  copy of `thread_settings_applied` carries NINE thread_settings keys
 *  (model_provider_id, approvals_reviewer, collaboration_mode,
 *  permission_profile…) where ours carries five, so the two can never share a
 *  fingerprint — without the marker a rebuilt history holds an unattributable
 *  twin of codex's own record. */
function isWrapperSettingsRecord(record) {
  return record?.payload?.wrapper === true;
}

/** The VALUES a settings record states, as one string — the twin key for the
 *  fold below. Deliberately only the fields both spellings carry. */
function settingsSignature(record) {
  const s = record?.payload?.thread_settings || record?.payload?.threadSettings || {};
  return [s.model || '', s.approval_policy || s.approvalPolicy || '', s.reasoning_effort || s.reasoningEffort || '', s.personality || ''].join('|');
}

// ── THE ID-KEYED USER TWIN (2026-09-07, measured on the owner's own session) ──
// One typed message reaches a rebuild TWICE: the wrapper's buffer copy (written
// as the text passed through it, carrying `webui_msg_id`) and codex's rollout
// copy (written when the app-server COMMITS the message into a turn, carrying
// its own `msg_…` id and nothing of ours). The fingerprint keys the first on
// that webui id and the second on its content, so nothing dedups them — all
// three typed messages in the owner's session rendered TWICE after a reload,
// and the queued path can put the two copies in DIFFERENT turns (ours at send
// time, codex's in the turn that drained it), where even a content key would
// not have collided.
// They cannot simply be keyed on content: two DIFFERENT sends of the same text
// are two messages. So an id-keyed copy of OURS CLAIMS its content, and the
// next codex-side copy of that content CONSUMES the claim and is dropped —
// n copies in, n bubbles out, in order.
// FORWARD ONLY for a claim of OURS: it covers copies that come AFTER it. Ours
// is written first on every path that TYPES or STEERS the text (send/steer time
// < commit time). Letting a late claim swallow an EARLIER codex record would
// DELETE an old message from history whenever the same text was typed again
// after the buffer had rotated away — so a twin that ties on the millisecond
// renders twice instead. A duplicate is a nuisance; a deletion is data loss.
// THE ONE COPY OF OURS THAT IS WRITTEN LAST (round 2) is the bubble for an
// inherited queue item the app-server DRAINED itself: its only trigger is the
// `item/completed` twin, which the app-server emits AFTER it has persisted its
// own record, so no forward claim of ours can ever retire that pair. The
// wrapper marks that record `webui_queue_via:'drained'` — a FACT about how it
// was produced, not a guess about timing — and such a record yields to an
// unconsumed codex copy of the same content IN THE SAME TURN (a submission's
// two copies are always in the turn that committed it) by dropping ITSELF.
// Nothing earlier is ever deleted, and a steered/typed record never yields.
// `webui_no_commit` has NO producer since round 4 (see userTwinKeys) but stays
// on this list: wrappers are long-lived (dtach survives an update — the
// 2.361.1 skew class), and a marker only one producer ever wrote must never
// be the difference between two copies of one message. Retire it when no
// buffer written by a round-3 wrapper can still be replayed.
const WEBUI_USER_MARKERS = ['webui_msg_id', 'webuiMsgId', 'client_msg_id', 'clientMsgId', 'webui_queue_id', 'webuiQueueId', 'webui_queue_via', 'webui_after_commit', 'webuiAfterCommit', 'webui_no_commit', 'webuiNoCommit', 'webui_origin', 'webui_peer'];
const TWIN_VOLATILE_FIELDS = ['id', 'item_id', 'itemId', 'internal_chat_message_metadata_passthrough', 'thread_id', 'turn_id'];
// The event the wrapper writes when it learns that a user record it ALREADY
// wrote will never reach the app-server — see USER_RETRACTION_EVENT below.
const USER_RETRACTION_EVENT = 'webui_user_retracted';

/** Does this user payload come from US? Any webui marker at all — so only a
 *  record with none can be codex's own. */
function userRecordIsOurs(payload) {
  return WEBUI_USER_MARKERS.some((k) => payload[k] !== undefined);
}

/** A content block as the TWIN compares it. An `input_image` is compared on
 *  {type, image_url} ONLY: codex stamps its own `detail` onto the block it
 *  persists (34 of the 40 image blocks in the local rollout corpus carry it,
 *  including 2026-08 files; every `input_text` block is exactly {type,text}),
 *  and a field only ONE producer writes must never be the difference between
 *  two copies of one message — the record-level rule of TWIN_VOLATILE_FIELDS,
 *  applied inside the content array. */
function normalizeUserContentBlock(block) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'input_image') return { type: 'input_image', image_url: block.image_url };
  return block;
}

/** The content of a user message, with every marker and volatile field of both
 *  producers removed — ONE definition, shared by the fingerprint's id-less
 *  fallback and the twin claim, so the two can never disagree about what "the
 *  same text" is. Null when the payload cannot be serialized. */
function userContentKey(payload) {
  const bare = { ...payload };
  for (const k of [...WEBUI_USER_MARKERS, ...TWIN_VOLATILE_FIELDS]) delete bare[k];
  if (Array.isArray(bare.content)) bare.content = bare.content.map(normalizeUserContentBlock);
  try { return 'user:' + JSON.stringify(bare); } catch { return null; }
}

/** {ours, late, contentKey} for a user message response_item, else null.
 *  `ours` = the record carries ANY webui marker, so only a record with none can
 *  be codex's own — keying "codex's copy" on the presence of ITS fields
 *  (`internal_chat_…passthrough`, a `msg_` id) instead would be a guess: 147 of
 *  629 user records in the local rollout corpus carry neither.
 *  EVERY copy of ours claims (round 2). Round 1 claimed only the id-keyed ones
 *  because a content-keyed copy of ours collided with codex's copy on the
 *  fingerprint itself; now that codex's copy is keyed by ITS id, the claim is
 *  the ONLY thing that retires the pair, for a peer copy and a falsy-webui-id
 *  copy exactly as much as for a typed one. */
function userTwinKeys(record) {
  if (!record || record.type !== 'response_item') return null;
  const payload = record.payload || {};
  if (payload.type !== 'message' || payload.role !== 'user') return null;
  const contentKey = userContentKey(payload);
  if (contentKey === null) return null;
  const ours = userRecordIsOurs(payload);
  // A copy of ours that was written AFTER the app-server persisted its own is
  // the one a forward claim can never retire — it says so with
  // `webui_after_commit`. COMPAT RUNG: a PEER copy is late-capable whether or
  // not it says so, because every wrapper shipped before that marker wrote the
  // idle-path record (post-`turn/start`, i.e. after the commit) unmarked, and
  // those buffers live on inside running sessions. Yielding costs such a record
  // nothing when it really was first: it only ever yields to a codex copy
  // ALREADY emitted in the same turn, which cannot exist yet. Retire the rung
  // when no pre-marker buffers survive.
  const marked = payload.webui_after_commit === true || payload.webuiAfterCommit === true;
  // A SUBMISSION THAT NEVER REACHED THE APP-SERVER has no twin to retire the
  // pair against, so its claim must be withdrawn (round 3): our copy is written
  // BEFORE the submission is accepted, and a wrapper-served slash command
  // (/compact, /review, /model, /effort) is answered by the wrapper itself —
  // the text never becomes a user message. A leaked claim would delete an
  // unrelated codex-only record of the same text later, which is round-2
  // finding ④ through a second back door.
  // THERE IS NO WRITE-TIME DECLARATION FOR THIS (round 4). Round 3 had one — a
  // `webui_no_commit` marker on the record — and it was INERT: a typed message
  // has TWO copies of ours, the wrapper's and the SERVER's preview
  // (CodexAdapter._buildUserPreview, written first and therefore the copy this
  // function is asked about), and only the wrapper can know that a text is one
  // of its own slash commands. Every case now speaks through the retraction
  // event below, which names the submission by ID — a fact both copies carry.
  return {
    ours,
    claims: ours,
    late: ours && (marked || payload.webui_peer !== undefined),
    contentKey,
  };
}

/** The submission id a `webui_user_retracted` event names, or ''. The wrapper
 *  emits it when a user record it already wrote will never be committed by the
 *  app-server — learned after the fact (the RPC threw, or the queued item was
 *  removed by Stop / by the user before it ran) or known at once (a
 *  wrapper-served slash command). It names the
 *  record by IDENTITY, never by content: the text can be megabytes of data URL,
 *  and re-deriving a content key inside the wrapper would be a second copy of
 *  userContentKey's algorithm, free to drift from this one. */
function retractionIdOf(record) {
  if (!record || record.type !== 'event_msg') return '';
  const payload = record.payload || {};
  if (payload.type !== USER_RETRACTION_EVENT) return '';
  return String(payload.msg_id || payload.msgId || '');
}

function mergeCodexRecords(historyRecords, liveRecords) {
  const merged = [];
  const seen = new Set();
  const keptTurnContexts = new Map(); // fingerprint → the copy that made it into `merged`
  // The most recent thread_settings_applied that made it into `merged`, and the
  // values it stated. ADJACENCY is the whole point: a conversation that goes
  // high → ultra → high states the same signature twice on purpose, and folding
  // the third record into the FIRST would make the rebuilt status report
  // 'ultra' at the end. Only a repeat with nothing of its own kind in between
  // is a twin of the same event.
  let lastSettings = null; // { record, sig, turnId }
  const userClaims = new Map();   // content key → copies of OURS no codex twin has consumed yet (forward, turn-independent)
  const codexUserOut = new Map(); // `<turn>\u0000<content key>` → codex copies emitted in THIS turn no late twin of ours has consumed
  const oursByIdentity = new Map(); // submission id → the content key the copy of OURS carrying that id claimed under (what a retraction names)
  let currentTurnId = 'prelude';
  for (const record of sortRecords([...(historyRecords || []), ...(liveRecords || [])])) {
    if (record.type === 'turn_context') {
      currentTurnId = record.payload?.turn_id || record.payload?.turnId || currentTurnId;
    }
    const settingsSig = record.type === 'event_msg' && record.payload?.type === 'thread_settings_applied'
      ? settingsSignature(record) : null;
    if (settingsSig !== null) {
      const twin = lastSettings && lastSettings.sig === settingsSig && lastSettings.turnId === currentTurnId ? lastSettings.record : null;
      if (twin) {
        // Same event, two authors. codex's own copy is the record; ours only
        // ever stood in for it (the live buffer has no rollout). Keep the
        // FIRST copy's position (it is the same moment either way) and take
        // codex's payload when it is the one that arrived second — never
        // mutate in place, `twin` is sortRecords' own shallow copy.
        if (isWrapperSettingsRecord(twin) && !isWrapperSettingsRecord(record)) twin.payload = { ...record.payload };
        continue;
      }
    }
    const fp = recordFingerprint(record, currentTurnId);
    // The SAME record from two sources — already decided (emitted, or dropped
    // as a twin, which also marks the fingerprint). It must not touch the claim
    // ledgers a second time… UNLESS its identity was INFERRED FROM CONTENT: a
    // pre-0.15x record carries no id of its own, so "duplicate" is a guess and
    // this may be a second submission of the same text whose twin claim would
    // otherwise leak — and a leaked claim DELETES an unrelated message later,
    // while retiring one duplicate too many only ever renders one extra bubble.
    // A deletion is data loss; a duplicate is a nuisance (round-2 finding).
    if (fp && seen.has(fp)) {
      // TURN_CONTEXT TWINS (2.369.62, the effort incident): the wrapper
      // synthesizes one the moment `turn/started` arrives (live visibility) and
      // codex writes its own when the turn really begins — same turn id, same
      // fingerprint, and OURS is always the earlier of the two, so first-wins
      // silently suppressed codex's authoritative copy for the whole life of
      // the conversation (a turn codex recorded as 'ultra' stayed 'xhigh'
      // forever). A repeat is a REFRESH of one turn, never a second turn:
      // position from the first copy, per-turn VALUES from the better one —
      // codex's own always wins, a later wrapper copy only overrides an earlier
      // wrapper copy (that is the wrapper's own late correction).
      const kept = record.type === 'turn_context' ? keptTurnContexts.get(fp) : null;
      if (kept && kept.payload && record.payload && isWrapperTurnContext(kept)) {
        // never mutate the parsed record in place — a cached rollout parse is
        // shared between reads; `kept` is sortRecords' own shallow copy
        const folded = { ...kept.payload };
        if (record.payload.effort) folded.effort = record.payload.effort;
        if (record.payload.model) folded.model = record.payload.model;
        if (!isWrapperTurnContext(record)) delete folded.effort_next; // codex's copy settles it: nothing pending in a rebuilt history
        kept.payload = folded;
      }
      const dup = userTwinKeys(record);
      if (dup && !dup.ours && !codexRecordIdentity(record.payload || {})) {
        const claimed = userClaims.get(dup.contentKey) || 0;
        if (claimed > 0) userClaims.set(dup.contentKey, claimed - 1);
      }
      continue;
    }
    // A RETRACTION (round 3): the wrapper writes our copy BEFORE the submission
    // is accepted, so it can only learn afterwards that the app-server will
    // never commit it — an RPC that threw, an item Stop or the user removed
    // from the queue before it ran. The claim standing for that record is
    // withdrawn here, in stream order (the retraction is always written after
    // the record it names, so the mapping exists by now unless the buffer has
    // rotated the record away, where there is no claim to withdraw either).
    // The RECORD stays: the user typed it, and the bubble is the truth. Only
    // the claim goes — a claim no twin will ever consume is the thing that
    // deletes an unrelated message later.
    const retractedId = retractionIdOf(record);
    if (retractedId) {
      const key = oursByIdentity.get(retractedId);
      const claimed = key ? (userClaims.get(key) || 0) : 0;
      if (claimed > 0) userClaims.set(key, claimed - 1);
    }
    const twin = userTwinKeys(record);
    if (twin) {
      const turnKey = `${currentTurnId}\u0000${twin.contentKey}`;
      if (twin.ours) {
        const emitted = twin.late ? (codexUserOut.get(turnKey) || 0) : 0;
        if (emitted > 0) {   // we are the LATE copy and codex's is already on screen — yield, never delete
          codexUserOut.set(turnKey, emitted - 1);
          if (fp) seen.add(fp);
          continue;
        }
        if (twin.claims) {
          userClaims.set(twin.contentKey, (userClaims.get(twin.contentKey) || 0) + 1);
          const identity = userRecordIdentity(record.payload || {});
          if (identity) oursByIdentity.set(identity, twin.contentKey);
        }
      } else {
        const claimed = userClaims.get(twin.contentKey) || 0;
        if (claimed > 0) {   // codex's copy of a bubble we already have
          userClaims.set(twin.contentKey, claimed - 1);
          if (fp) seen.add(fp);
          continue;
        }
        codexUserOut.set(turnKey, (codexUserOut.get(turnKey) || 0) + 1);
      }
    }
    if (fp) seen.add(fp);
    if (fp && record.type === 'turn_context') keptTurnContexts.set(fp, record);
    // remembered only once the record really made it into `merged` — a pointer
    // at a record the fingerprint dedup dropped would fold codex's copy into
    // something no reader ever sees
    if (settingsSig !== null) lastSettings = { record, sig: settingsSig, turnId: currentTurnId };
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
      // effort = what the LAST turn ran at; effortNext = the pick that applies
      // from the next one (2.369.62 — one field could not say both, and the
      // popup baked the wrong one onto every message of a turn)
      effort: null,
      effortNext: null,
      sandbox: null,
      totalUsage: null,
    };
    const meta = this.wrapperMeta();
    if (meta?.model) status.model = meta.model;
    if (meta?.permissionMode) status.permissionMode = meta.permissionMode;
    if (meta?.contextWindow) status.contextWindow = meta.contextWindow;
    if (meta?.subagentMetas) status.subagentMetas = meta.subagentMetas;
    if (meta?.sandbox) status.sandbox = meta.sandbox;
    // the wrapper's live pair (2.369.62) — records below still override the
    // live-turn value, but a session attached before its first turn_context
    // (or one whose pick has not started a turn yet) is honest right away
    if (meta?.effort) status.effort = meta.effort;
    if (meta?.effortNext || meta?.effortOverride) status.effortNext = meta.effortNext || meta.effortOverride;
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
        if (record.payload?.effort) {
          status.effort = record.payload.effort;
          // a turn_context that names an effort also settles the pending
          // question: effort_next present = a re-pick waiting for the next turn
          status.effortNext = record.payload.effort_next || record.payload.effortNext || null;
        }
        if (record.payload?.sandbox_policy && !status.sandbox) status.sandbox = record.payload.sandbox_policy;
      } else if (record.type === 'wrapper_meta') {
        // the wrapper restates its pair on every change (set-effort included)
        if (record.payload?.effort) status.effort = record.payload.effort;
        if (record.payload?.effortNext !== undefined) status.effortNext = record.payload.effortNext || null;
      } else if (record.type === 'event_msg' && record.payload?.type === 'thread_settings_applied') {
        // codex's own settings record = the THREAD's effort = the NEXT turn's
        const level = record.payload.thread_settings?.reasoning_effort;
        if (level) { status.effortNext = level; if (!status.effort) status.effort = level; }
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

/** The walk alone, OFF the event loop (the worker twin of
 *  collectCodexThreadMetas; worker down ⇒ the same function runs inline).
 *  Used by any request-path consumer that needs the metas but must not block
 *  the loop — /api/subagents measured 193 ms of sync walk on a modest tree. */
async function collectCodexThreadMetasAsync() {
  return transcriptWorkerCall('codexThreadMetas', {}, collectCodexThreadMetas);
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
  collectCodexThreadMetasAsync,
  assembleCodexThreads,
  listOpenCodexThreadIds,
  dirCacheStats,
  mergeCodexRecords,
  recordFingerprint,
  userTwinKeys,
  userRecordIdentity,
  codexRecordIdentity,
  userContentKey,
  retractionIdOf,
  USER_RETRACTION_EVENT,
  parseCodexSessionJsonl,
  resolveCodexForkAncestry,
  cutRecordsAtOrdinal,
  tagRecordThread,
  recordThreadOf,
  RECORD_THREAD_KEY,
};
