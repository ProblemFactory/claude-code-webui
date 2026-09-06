'use strict';
/**
 * OpenCode serve-mode STORE FACTS (S9 of docs/design-harness-plugins.md §2.4,
 * B-03f2). SHARED tier: node builtins + discovery-facts + the ACP reader only —
 * one implementation of "which OpenCode conversations live on this machine and
 * what do they contain", never an ORCH import.
 *
 * WHY: S8's ACP harness has no transcript files (OpenCode keeps sessions in its
 * own sqlite, ~/.local/share/opencode/opencode.db), so STOPPED OpenCode
 * conversations never reached the sidebar and could not be resumed from it.
 * `opencode serve` exposes that store over HTTP on 127.0.0.1 (verified
 * 1.18.29, OpenAPI at /doc): session list/get/messages/fork/children/status,
 * plus SSE at /event — this module uses the read family + fork.
 *
 * THREE PIECES:
 *   OpencodeServeClient  — a tiny fetch client (base URL, 1.5s default
 *                          timeout, Basic auth only when OPENCODE_SERVER_PASSWORD
 *                          is set in the spawn env; no vendor secret ever).
 *   createServeLocator   — finds ONE serve instance per VibeSpace: reuse the
 *                          one recorded in data/opencode-serve.json {port,pid,
 *                          startedAt} when it still answers /global/health,
 *                          else start `opencode serve --port <free>
 *                          --hostname 127.0.0.1` (detached, stdio ignored, under
 *                          the caller's sanitized env) and keep it: respawn on
 *                          exit with exponential backoff, PARKED after 5 crashes
 *                          (loud in user actions, silent in the poll), stopped
 *                          on server exit. Started LAZILY on the first discovery
 *                          and only when the CLI is installed. After boot the
 *                          OpenAPI is probed once: the `fork` capability verdict
 *                          (POST /session/{sessionID}/fork present) is reported
 *                          through onCaps — capsOf('opencode').fork flips ONLY
 *                          on that evidence.
 *   createFacts          — the store contract members the harness descriptor
 *                          exposes: discover({activeSessions}) (10s list cache,
 *                          10s negative cache, every call bounded by the 1.5s
 *                          budget — a hung serve never stalls the 5s
 *                          /api/sessions poll), readConversation(id) for the
 *                          serve-backed reader (8s, LOUD), forkSession(id).
 *
 * 'acp-events' SYNTHESIS (messagesToAcpRecords): a stopped conversation is
 * rebuilt as the record stream the wrapper would have journaled, so the
 * existing AcpMessageManager renders it read-only with zero new renderer code:
 *   session                       → {kind:'session', how:'serve', model:'<providerID>/<modelID>', mode:<agent>}
 *   user message  text parts      → {kind:'user', msgId:<message id>, content:[{type:'text'}]}
 *                 file parts      → a "[file: name]" text line inside the same user record
 *   assistant     text part       → update agent_message_chunk (messageId = part id: one card per part)
 *                 reasoning part  → update agent_thought_chunk
 *                 tool part       → update tool_call (kind from the OpenCode tool id, rawInput, locations)
 *                                   + tool_call_update (completed|failed, output/error text, edit diff)
 *                 subtask part    → tool_call kind other (Task: <description>), completed
 *                 compaction part → notice "Context compacted"; retry part → notice "Retry #n: <error>"
 *                 model/agent switch (modelID/mode differ from the previous assistant) → {kind:'config'}
 *                 end of message  → prompt_end (MessageAbortedError → cancelled, other error → error, else end_turn;
 *                                   an assistant message without time.completed and without error = still open, no prompt_end)
 *   step-start / step-finish / snapshot / patch / agent parts → skipped (bookkeeping, nothing to render)
 * OpenCode tool id → ACP ToolKind: read→read; glob|grep|list|ls→search;
 * edit|write|patch|multiedit|apply_patch→edit; bash|shell→execute;
 * webfetch|websearch|codesearch→fetch; todowrite|todoread|plan→think; else other.
 * Tool state → ACP status: pending→pending, running→in_progress, completed→completed, error→failed.
 *
 * NAMING: the shared rule (discovery-facts nameFromText over the FIRST user
 * message — the v2 endpoint GET /api/session/:id/message?limit=3&order=asc
 * returns messages oldest-first; v1 `limit` returns the NEWEST N) — cached per
 * id, at most NAME_BATCH lookups per discovery tick so a big store names
 * itself progressively without a request burst; fallback = OpenCode's own
 * title unless it is the "New session - <date>" placeholder.
 *
 * NOT IN SCOPE (endpoints seen in the 1.18.29 OpenAPI, unwired): revert
 * (POST /session/{sessionID}/revert), question (GET /question, POST
 * /question/{requestID}/reply), pty (/pty…), the SSE event stream (/event,
 * /global/event) — see the S9 row in docs/design-harness-plugins.md.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { nameFromText } = require('./discovery-facts');
const { AcpSessionMessages } = require('./acp-message-manager');

const DEFAULT_TIMEOUT_MS = 1500;   // the poll budget: a hung serve costs at most this per discovery
const READ_TIMEOUT_MS = 8000;      // user actions (open a stopped conversation, fork): LOUD when exceeded
const LIST_CACHE_MS = 10000;
const NEGATIVE_CACHE_MS = 10000;
const NAME_RETRY_MS = 60000;       // a session with no user message yet is re-checked at most this often
const BOOT_TIMEOUT_MS = 20000;     // opencode 1.18.29 answers /global/health in ~1.2s locally
const MAX_CRASHES = 5;
const HEALTHY_UPTIME_RESET_MS = 60000; // a serve that stayed up this long resets the crash counter
const NAME_BATCH = 6;
const LIST_LIMIT = 500;
const TITLE_PLACEHOLDER_RE = /^New session - /;
const FORK_PATH = '/session/{sessionID}/fork';

class OpencodeServeError extends Error {
  constructor(message, { status = 0, code = null, cause = null } = {}) {
    super(message);
    this.name = 'OpencodeServeError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); // budget gates: never keep the process alive
const wait = (ms) => new Promise((r) => setTimeout(r, ms));                                          // the boot wait: MUST keep it alive (the child is unref'd)
function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => { timer = setTimeout(() => reject(new OpencodeServeError(`${label || 'opencode serve'} timed out after ${ms}ms`, { code: 'timeout' })), ms); if (timer.unref) timer.unref(); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
const isoOf = (ms) => new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString();
const isConnErr = (e) => e && (e.code === 'network' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET');

// ── the client ──
class OpencodeServeClient {
  constructor(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null, auth = null } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._auth = auth && auth.password ? 'Basic ' + Buffer.from(`${auth.username || 'opencode'}:${auth.password}`).toString('base64') : null;
  }
  async request(method, route, { query = null, body = null, timeoutMs = null } = {}) {
    const url = new URL(this.baseUrl + route);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const ms = timeoutMs || this.timeoutMs;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    if (timer.unref) timer.unref();
    try {
      const headers = { accept: 'application/json' };
      if (body != null) headers['content-type'] = 'application/json';
      if (this._auth) headers.authorization = this._auth;
      const res = await this._fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const text = await res.text();
      let json = null;
      if (text) { try { json = JSON.parse(text); } catch { json = null; } }
      if (!res.ok) {
        const detail = json?.data?.message || json?.message || (typeof json === 'string' ? json : '') || text.slice(0, 200);
        throw new OpencodeServeError(`${method} ${route} → HTTP ${res.status}${detail ? ': ' + detail : ''}`, { status: res.status, code: json?.name || 'http' });
      }
      return json;
    } catch (e) {
      if (e instanceof OpencodeServeError) throw e;
      const timedOut = ctl.signal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError';
      throw new OpencodeServeError(timedOut ? `${method} ${route} timed out after ${ms}ms` : `${method} ${route} failed: ${e?.cause?.code || e?.code || e?.message || e}`, { code: timedOut ? 'timeout' : (e?.cause?.code || e?.code || 'network'), cause: e });
    } finally { clearTimeout(timer); }
  }
  health(opts) { return this.request('GET', '/global/health', opts); }
  openapi(opts = {}) { return this.request('GET', '/doc', { timeoutMs: READ_TIMEOUT_MS, ...opts }); }
  listProjects(opts) { return this.request('GET', '/project', opts); }
  /** GET /session — verified 1.18.29 semantics: bare `directory` = sessions
   *  whose directory is EXACTLY that path (so `/` matches nothing);
   *  `scope=project` + `directory=<worktree>` = the whole project; `roots`
   *  hides child (sub-agent) sessions. */
  listSessions({ limit = LIST_LIMIT, directory = null, scope = null, roots = null, timeoutMs = null } = {}) {
    return this.request('GET', '/session', { query: { limit, directory, scope, roots: roots === null ? null : (roots ? 'true' : 'false') }, timeoutMs });
  }
  /** Every session the store knows: /project × `scope=project&directory=
   *  <worktree>` (a serve instance's bare /session is scoped to ITS cwd's
   *  project), deduped by id; a failing/empty /project degrades to the bare
   *  listing. */
  async listAllSessions({ limit = LIST_LIMIT, timeoutMs = null } = {}) {
    let projects = [];
    try { projects = await this.listProjects({ timeoutMs }); } catch { projects = []; }
    const dirs = [...new Set((Array.isArray(projects) ? projects : []).map((p) => p && typeof p.worktree === 'string' ? p.worktree : null).filter(Boolean))];
    const lists = dirs.length
      ? await Promise.all(dirs.map((directory) => this.listSessions({ limit, directory, scope: 'project', timeoutMs }).catch(() => [])))
      : [await this.listSessions({ limit, timeoutMs })];
    const byId = new Map();
    for (const list of lists) for (const s of Array.isArray(list) ? list : []) if (s && typeof s.id === 'string' && !byId.has(s.id)) byId.set(s.id, s);
    return [...byId.values()];
  }
  getSession(id, opts) { return this.request('GET', `/session/${encodeURIComponent(id)}`, opts); }
  /** GET /session/:id/message — v1 shape [{info, parts}]; `limit` = the NEWEST N, `before` pages older. */
  listMessages(id, { limit = null, before = null, timeoutMs = null } = {}) {
    return this.request('GET', `/session/${encodeURIComponent(id)}/message`, { query: { limit, before }, timeoutMs });
  }
  /** The FIRST user message (v2 GET /api/session/:id/message?order=asc) → {id, text} | null. */
  async firstUserMessage(id, opts = {}) {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(id)}/message`, { query: { limit: 3, order: 'asc' }, ...opts });
    const first = (Array.isArray(r?.data) ? r.data : []).find((m) => m && m.type === 'user');
    return first ? { id: first.id, text: String(first.text || '') } : null;
  }
  fork(id, { messageID = null, directory = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    return this.request('POST', `/session/${encodeURIComponent(id)}/fork`, { query: { directory }, body: messageID ? { messageID } : {}, timeoutMs });
  }
  children(id, opts) { return this.request('GET', `/session/${encodeURIComponent(id)}/children`, opts); }
  sessionStatus(opts) { return this.request('GET', '/session/status', opts); }
  todo(id, opts) { return this.request('GET', `/session/${encodeURIComponent(id)}/todo`, opts); }
}

// ── the record synthesis (pure) ──
function acpKindOfTool(tool) {
  const t = String(tool || '').toLowerCase();
  if (t === 'read') return 'read';
  if (['glob', 'grep', 'list', 'ls'].includes(t)) return 'search';
  if (['edit', 'write', 'patch', 'multiedit', 'apply_patch'].includes(t)) return 'edit';
  if (['bash', 'shell'].includes(t)) return 'execute';
  if (['webfetch', 'websearch', 'codesearch'].includes(t)) return 'fetch';
  if (['todowrite', 'todoread', 'plan'].includes(t)) return 'think';
  return 'other';
}
function acpStatusOfState(status) {
  switch (String(status || '')) {
    case 'pending': return 'pending';
    case 'running': return 'in_progress';
    case 'completed': return 'completed';
    case 'error': return 'failed';
    default: return 'pending';
  }
}
function modelLabel(providerID, modelID) {
  const p = providerID ? String(providerID) : '', m = modelID ? String(modelID) : '';
  return p && m ? `${p}/${m}` : (m || p || '');
}
function stopReasonOf(info) {
  const err = info?.error;
  if (err && typeof err === 'object') return err.name === 'MessageAbortedError' ? 'cancelled' : 'error';
  return 'end_turn';
}
function fileLine(part) { return `[file: ${part.filename || part.url || part.mime || 'attachment'}]`; }

/** OpenCode v1 messages ([{info, parts}]) + the Session → 'acp-events' records. */
function messagesToAcpRecords(messages, session = {}) {
  const sessionId = session?.id || messages?.[0]?.info?.sessionID || '';
  const out = [];
  const push = (rec) => { out.push(rec); return rec; };
  let curModel = modelLabel(session?.model?.providerID, session?.model?.id);
  let curMode = session?.agent ? String(session.agent) : '';
  push({ ts: isoOf(session?.time?.created), type: 'acp', kind: 'session', sessionId, cwd: session?.directory || '', how: 'serve', model: curModel, mode: curMode, agentInfo: { name: 'opencode', version: session?.version || null }, replay: true });
  const upd = (ts, update) => push({ ts, type: 'acp', kind: 'update', sessionId, update, replay: true });
  for (const m of Array.isArray(messages) ? messages : []) {
    const info = m?.info || {};
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const ts = isoOf(info?.time?.created);
    if (info.role === 'user') {
      const texts = parts.filter((p) => p && p.type === 'text' && p.text && !p.ignored);
      const visible = texts.filter((p) => !p.synthetic);
      const lines = (visible.length ? visible : texts).map((p) => String(p.text));
      for (const p of parts) if (p && p.type === 'file') lines.push(fileLine(p));
      const text = lines.join('\n').trim();
      if (!text) continue;
      push({ ts, type: 'acp', kind: 'user', msgId: String(info.id || ''), content: [{ type: 'text', text }], peer: null });
      continue;
    }
    if (info.role !== 'assistant') continue;
    const model = modelLabel(info.providerID, info.modelID);
    const mode = info.mode ? String(info.mode) : (info.agent ? String(info.agent) : '');
    if ((model && model !== curModel) || (mode && mode !== curMode)) {
      if (model) curModel = model;
      if (mode) curMode = mode;
      push({ ts, type: 'acp', kind: 'config', model: curModel, mode: curMode, source: 'serve' });
    }
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const pts = isoOf(p.time?.start || info?.time?.created);
      if (p.type === 'text') {
        if (p.ignored || !p.text) continue;
        upd(pts, { sessionUpdate: 'agent_message_chunk', messageId: p.id || undefined, content: { type: 'text', text: String(p.text) } });
      } else if (p.type === 'reasoning') {
        if (!p.text) continue;
        upd(pts, { sessionUpdate: 'agent_thought_chunk', messageId: p.id || undefined, content: { type: 'text', text: String(p.text) } });
      } else if (p.type === 'tool') {
        const st = p.state || {};
        const input = st.input && typeof st.input === 'object' ? st.input : {};
        const toolCallId = String(p.callID || p.id || '');
        const kind = acpKindOfTool(p.tool);
        const fileP = typeof input.filePath === 'string' ? input.filePath : (typeof input.path === 'string' ? input.path : (typeof input.file === 'string' ? input.file : null));
        const call = { sessionUpdate: 'tool_call', toolCallId, title: String(st.title || p.tool || 'tool'), kind, status: st.status === 'completed' || st.status === 'error' ? 'in_progress' : acpStatusOfState(st.status), rawInput: { tool: String(p.tool || ''), ...input } };
        if (fileP) call.locations = [{ path: fileP }];
        upd(pts, call);
        if (st.status === 'completed' || st.status === 'error') {
          const done = { sessionUpdate: 'tool_call_update', toolCallId, status: acpStatusOfState(st.status), content: [] };
          const text = st.status === 'error' ? String(st.error || 'tool failed') : String(st.output || '');
          if (text) done.content.push({ type: 'content', content: { type: 'text', text } });
          if (kind === 'edit' && fileP && typeof input.oldString === 'string' && typeof input.newString === 'string') done.content.push({ type: 'diff', path: fileP, oldText: input.oldString, newText: input.newString });
          if (st.status === 'error') done.rawOutput = String(st.error || '');
          upd(isoOf(st.time?.end || p.time?.start || info?.time?.created), done);
        }
      } else if (p.type === 'subtask') {
        const toolCallId = String(p.id || '');
        upd(pts, { sessionUpdate: 'tool_call', toolCallId, title: `Task: ${p.description || p.agent || 'subtask'}`, kind: 'other', status: 'completed', rawInput: { tool: 'task', prompt: String(p.prompt || ''), agent: p.agent || null, model: p.model ? modelLabel(p.model.providerID, p.model.modelID) : null }, content: [] });
      } else if (p.type === 'compaction') {
        push({ ts: pts, type: 'acp', kind: 'notice', level: 'info', text: `Context compacted${p.auto ? ' (automatic)' : ''}`, noticeKind: 'compaction' });
      } else if (p.type === 'retry') {
        push({ ts: pts, type: 'acp', kind: 'notice', level: 'info', text: `Retry #${p.attempt ?? '?'}: ${p.error?.data?.message || p.error?.name || 'provider error'}`, noticeKind: 'retry' });
      }
      // step-start / step-finish / snapshot / patch / agent: bookkeeping, nothing to render
    }
    const reason = stopReasonOf(info);
    if (reason !== 'end_turn' || info?.time?.completed) {
      push({ ts: isoOf(info?.time?.completed || info?.time?.created), type: 'acp', kind: 'prompt_end', promptId: String(info.id || ''), stopReason: reason, error: reason === 'error' ? { message: info.error?.data?.message || info.error?.name || 'prompt failed' } : null });
    }
  }
  return out;
}

/** The sidebar name for an OpenCode session: the shared first-user-message
 *  rule, else OpenCode's own title unless it is the auto placeholder. */
function sessionTitle(s) {
  const t = typeof s?.title === 'string' ? s.title.trim() : '';
  return t && !TITLE_PLACEHOLDER_RE.test(t) ? t : '';
}

// ── the locator / keeper ──
function createServeLocator({
  dataDir, command, env = () => ({ ...process.env }), cwd = null, log = console,
  fetchImpl = null, spawnImpl = spawn, bootTimeoutMs = BOOT_TIMEOUT_MS, backoffBaseMs = 1000,
  maxCrashes = MAX_CRASHES, stopOnExit = false, onCaps = null, onState = null,
  autostart = true, // false = REUSE ONLY (smoke harnesses: a SIGKILLed test server must not leave a serve behind)
} = {}) {
  if (!dataDir) throw new Error('createServeLocator: dataDir is required (the record lives at data/opencode-serve.json)');
  const recordPath = path.join(dataDir, 'opencode-serve.json');
  const state = { client: null, port: null, pid: null, startedAt: null, source: null, child: null, crashes: 0, parked: false, lastError: null, stopping: false, backoffUntil: 0, caps: null, version: null, capsProbed: false };
  let ensuring = null;
  let respawnTimer = null;
  const commandOf = () => (typeof command === 'function' ? command() : command) || null;
  const authOf = () => { const e = env() || {}; return e.OPENCODE_SERVER_PASSWORD ? { username: e.OPENCODE_SERVER_USERNAME || 'opencode', password: e.OPENCODE_SERVER_PASSWORD } : null; };
  const mkClient = (port) => new OpencodeServeClient(`http://127.0.0.1:${port}`, { fetchImpl, auth: authOf() });
  const notify = () => { try { onState?.(snapshot()); } catch { } };
  function readRecord() { try { const r = JSON.parse(fs.readFileSync(recordPath, 'utf8')); return r && Number.isInteger(r.port) && r.port > 0 ? r : null; } catch { return null; } }
  function writeRecord(r) { try { writeJsonAtomic(recordPath, r); } catch (e) { log?.warn?.(`[opencode-serve] record write failed: ${e.message}`); } }
  function clearRecord() { try { fs.unlinkSync(recordPath); } catch { } }
  // /global/health carries the CLI version ({healthy, version:'1.18.29'}); /doc's info.version is the API doc's own
  async function healthy(client, ms) { try { const h = await client.health({ timeoutMs: ms }); if (h && typeof h.version === 'string') state.version = h.version; return !!h && h.healthy !== false; } catch { return false; } }
  async function probeCaps(client) {
    let fork = false;
    try {
      const doc = await client.openapi();
      fork = !!(doc && doc.paths && doc.paths[FORK_PATH] && doc.paths[FORK_PATH].post);
    } catch (e) { log?.warn?.(`[opencode-serve] OpenAPI probe failed (${e.message}) — fork stays unavailable`); }
    state.caps = { fork };
    state.capsProbed = true;
    try { onCaps?.({ ...state.caps }, snapshot()); } catch (e) { log?.error?.(`[opencode-serve] onCaps failed: ${e.message}`); }
  }
  async function adopt(port, pid, source) {
    state.client = mkClient(port);
    state.port = port; state.pid = pid; state.source = source; state.startedAt = Date.now(); state.lastError = null;
    notify();
    await probeCaps(state.client);
    notify();
    return state.client;
  }
  function onChildExit(child, code, signal) {
    if (state.child !== child) return;
    state.child = null; state.client = null; state.port = null; state.pid = null;
    clearRecord();
    if (state.stopping) { notify(); return; }
    if (state.startedAt && Date.now() - state.startedAt >= HEALTHY_UPTIME_RESET_MS) state.crashes = 0;
    state.crashes++;
    state.lastError = `opencode serve exited (${signal || `code ${code}`})`;
    if (state.crashes >= maxCrashes) {
      state.parked = true;
      log?.error?.(`[opencode-serve] PARKED after ${state.crashes} crashes — ${state.lastError}; restart VibeSpace (or fix \`opencode serve\`) to retry`);
    } else {
      const wait = Math.min(30000, backoffBaseMs * 2 ** (state.crashes - 1));
      state.backoffUntil = Date.now() + wait;
      log?.warn?.(`[opencode-serve] ${state.lastError}; respawn in ${wait}ms (crash ${state.crashes}/${maxCrashes})`);
      clearTimeout(respawnTimer);
      // the timer IS the backoff: clear the guard before retrying (Date.now() ms
      // rounding can still read "too early" at the exact firing instant), and
      // CHAIN onto a still-running locate() (its boot loop notices the exit up
      // to ~200ms late) instead of joining it — joining returned that attempt's
      // null and left the keeper idle: neither parked nor running.
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        (ensuring || Promise.resolve()).then(() => { state.backoffUntil = 0; return ensure(); }).catch(() => { });
      }, wait);
      if (respawnTimer.unref) respawnTimer.unref();
    }
    notify();
  }
  async function locate() {
    if (state.client) return state.client;
    if (state.parked || state.stopping) return null;
    if (Date.now() < state.backoffUntil) return null;
    // 1) reuse a recorded instance (a previous VibeSpace's child that outlived a SIGKILL restart)
    const rec = readRecord();
    if (rec) {
      const probe = mkClient(rec.port);
      if (await healthy(probe, DEFAULT_TIMEOUT_MS)) return adopt(rec.port, rec.pid || null, 'reused');
      if (!pidAlive(rec.pid)) clearRecord();
    }
    // 2) start one — only when the CLI is installed and autostart is allowed
    const cmd = commandOf();
    if (!cmd) { state.lastError = 'opencode CLI is not installed'; return null; }
    if (!autostart) { state.lastError = 'opencode serve autostart is disabled on this instance (VIBESPACE_OPENCODE_SERVE=0 / smoke harness) — start `opencode serve` yourself or enable autostart'; return null; }
    const port = await freePort();
    let child;
    try {
      child = spawnImpl(cmd, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--log-level', 'WARN'], { cwd: cwd || os.homedir(), env: env(), stdio: 'ignore', detached: true });
    } catch (e) { state.lastError = `spawn failed: ${e.message}`; state.crashes++; if (state.crashes >= maxCrashes) state.parked = true; notify(); return null; }
    if (typeof child.unref === 'function') child.unref();
    state.child = child; state.pid = child.pid || null; state.startedAt = Date.now();
    child.once('error', (e) => { state.lastError = `spawn failed: ${e.message}`; });
    child.on('exit', (code, signal) => onChildExit(child, code, signal));
    writeRecord({ port, pid: child.pid || null, startedAt: state.startedAt, command: cmd });
    const probe = mkClient(port);
    const t0 = Date.now();
    while (Date.now() - t0 < bootTimeoutMs) {
      if (state.stopping || state.child !== child) return null;
      if (await healthy(probe, 1000)) { log?.log?.(`[opencode-serve] started pid ${child.pid} on 127.0.0.1:${port} (${Date.now() - t0}ms)`); return adopt(port, child.pid || null, 'spawned'); }
      await wait(200);
    }
    state.lastError = `opencode serve did not answer on 127.0.0.1:${port} within ${bootTimeoutMs}ms`;
    log?.warn?.(`[opencode-serve] ${state.lastError} — killing it`);
    try { child.kill('SIGTERM'); } catch { }
    return null;
  }
  function ensure() {
    if (state.client) return Promise.resolve(state.client);
    if (!ensuring) ensuring = locate().catch((e) => { state.lastError = e.message; notify(); return null; }).finally(() => { ensuring = null; });
    return ensuring;
  }
  /** A client within `budgetMs`, else null (the boot continues in the background). */
  function client({ budgetMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (state.client) return Promise.resolve(state.client);
    return Promise.race([ensure(), sleep(budgetMs).then(() => null)]);
  }
  /** A request-level connection failure on a REUSED instance: forget it so the next ensure() re-runs the ladder (our own child is owned by its exit handler). */
  function invalidate(reason) {
    if (state.child) return;
    state.client = null; state.port = null; state.pid = null; state.source = null;
    state.lastError = reason || 'connection lost';
    notify();
  }
  function stop() {
    state.stopping = true;
    clearTimeout(respawnTimer); respawnTimer = null;
    const ch = state.child;
    state.child = null; state.client = null; state.port = null;
    if (ch) { try { ch.kill('SIGTERM'); } catch { } clearRecord(); }
  }
  function snapshot() {
    return { port: state.port, pid: state.pid, startedAt: state.startedAt, source: state.source, crashes: state.crashes, parked: state.parked, lastError: state.lastError, caps: state.caps ? { ...state.caps } : null, version: state.version, capsProbed: state.capsProbed, installed: !!commandOf(), autostart: !!autostart, recordPath, ready: !!state.client };
  }
  if (stopOnExit) process.once('exit', () => { try { stop(); } catch { } });
  return { client, ensure, stop, invalidate, state: snapshot, command: commandOf, recordPath };
}

// ── the store facts ──
function createFacts(locator, { now = Date.now, nameBatch = NAME_BATCH, listCacheMs = LIST_CACHE_MS, negativeCacheMs = NEGATIVE_CACHE_MS } = {}) {
  const cache = { list: null, at: 0, negativeUntil: 0, lastError: null };
  const names = new Map();      // id → { name, at }
  const naming = new Set();
  const convo = new Map();      // id → { at, session, messages, records }
  let listing = null;

  function reasonUnavailable() {
    const st = locator.state();
    if (!st.installed) return 'OpenCode is not installed on this machine (no `opencode` on PATH — install it or set OPENCODE_CMD)';
    if (st.parked) return `OpenCode serve is parked after ${st.crashes} crashes (${st.lastError || 'unknown error'}) — restart VibeSpace to retry`;
    return `OpenCode serve is unreachable (${st.lastError || 'still starting'})`;
  }
  function assemble(list, activeSessions) {
    const activeById = new Map();
    for (const [id, s] of activeSessions || []) {
      if ((s?.backend || 'claude') !== 'opencode') continue;
      const sid = s.backendSessionId || null;
      if (sid && !activeById.has(sid)) activeById.set(sid, { id, session: s });
    }
    const entries = (list || []).map((s) => {
      const active = activeById.get(s.id) || null;
      const named = names.get(s.id);
      return {
        backend: 'opencode',
        backendSessionId: s.id,
        sessionId: s.id,
        sessionKey: `opencode:${s.id}`,
        cwd: s.directory || '',
        startedAt: s.time?.updated || s.time?.created || now(),
        createdAt: s.time?.created || null,
        status: active ? 'live' : 'stopped',
        name: (named && named.name) || sessionTitle(s),
        agentKind: s.parentID ? 'subagent' : 'primary',
        parentThreadId: s.parentID || null,
        webuiId: active?.id || null,
        webuiName: active?.session?.name || null,
        webuiMode: active?.session?.mode || null,
        opencode: { slug: s.slug || null, agent: s.agent || null, model: modelLabel(s.model?.providerID, s.model?.id) || null, projectID: s.projectID || null },
      };
    });
    entries.sort((a, b) => b.startedAt - a.startedAt);
    return entries;
  }
  async function nameSome(client, list) {
    const t = now();
    const todo = [];
    for (const s of list) {
      if (naming.has(s.id)) continue;
      const n = names.get(s.id);
      if (n && (n.name || t - n.at < NAME_RETRY_MS)) continue;
      todo.push(s.id);
      if (todo.length >= nameBatch) break;
    }
    await Promise.all(todo.map(async (id) => {
      naming.add(id);
      try {
        const first = await client.firstUserMessage(id, { timeoutMs: DEFAULT_TIMEOUT_MS });
        names.set(id, { name: first ? (nameFromText(first.text) || '') : '', at: now() });
      } catch (e) {
        names.set(id, { name: '', at: now() });
        if (isConnErr(e)) locator.invalidate(e.message);
      } finally { naming.delete(id); }
    }));
  }
  async function refreshList(budgetMs) {
    const client = await locator.client({ budgetMs });
    if (!client) throw new OpencodeServeError(reasonUnavailable(), { code: 'unavailable' });
    const list = await withTimeout(client.listAllSessions({ timeoutMs: budgetMs }), budgetMs, 'session listing');
    cache.list = list; cache.at = now(); cache.lastError = null;
    nameSome(client, list).catch(() => { });
    return list;
  }
  /** Session entries for the sidebar (the S3 discover member). NEVER throws,
   *  NEVER waits past the budget: cache → negative cache → bounded refresh. */
  async function discover({ activeSessions = new Map(), budgetMs = DEFAULT_TIMEOUT_MS } = {}) {
    const t = now();
    if (cache.list && t - cache.at < listCacheMs) return assemble(cache.list, activeSessions);
    if (t < cache.negativeUntil) return assemble(cache.list || [], activeSessions);
    if (!listing) listing = refreshList(budgetMs).finally(() => { listing = null; });
    try { await listing; }
    catch (e) {
      cache.negativeUntil = now() + negativeCacheMs;
      cache.lastError = e.message;
      if (isConnErr(e)) locator.invalidate(e.message);
    }
    return assemble(cache.list || [], activeSessions);
  }
  /** The whole conversation for the serve-backed reader (user action: LOUD). */
  async function readConversation(id, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    const hit = convo.get(id);
    if (hit && now() - hit.at < listCacheMs) return hit;
    const client = await locator.client({ budgetMs: timeoutMs });
    if (!client) throw new OpencodeServeError(reasonUnavailable(), { code: 'unavailable' });
    let session, messages;
    try {
      [session, messages] = await Promise.all([client.getSession(id, { timeoutMs }), client.listMessages(id, { timeoutMs })]);
    } catch (e) {
      if (isConnErr(e)) locator.invalidate(e.message);
      throw new OpencodeServeError(`OpenCode conversation ${id} could not be read: ${e.message}`, { status: e.status, code: e.code, cause: e });
    }
    const entry = { at: now(), session, messages: Array.isArray(messages) ? messages : [], records: messagesToAcpRecords(Array.isArray(messages) ? messages : [], session) };
    convo.set(id, entry);
    if (convo.size > 64) convo.delete(convo.keys().next().value);
    return entry;
  }
  /** POST /session/:id/fork → the NEW session (user action: LOUD; refused when the serve has no fork endpoint). */
  async function forkSession(id, { cwd = null, messageID = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const client = await locator.client({ budgetMs: timeoutMs });
    if (!client) throw new OpencodeServeError(reasonUnavailable(), { code: 'unavailable' });
    const st = locator.state();
    if (!st.caps?.fork) throw new OpencodeServeError(`this OpenCode serve (${st.version || 'unknown version'}) has no session fork endpoint (POST ${FORK_PATH}) — upgrade opencode`, { code: 'unsupported' });
    const forked = await client.fork(id, { directory: cwd || null, messageID, timeoutMs });
    if (!forked || typeof forked.id !== 'string') throw new OpencodeServeError('fork returned no session id', { code: 'protocol' });
    invalidate();
    return forked;
  }
  function invalidate() { cache.at = 0; cache.negativeUntil = 0; convo.clear(); }
  function stateOf() { return { ...locator.state(), cachedSessions: cache.list ? cache.list.length : null, cacheAgeMs: cache.at ? now() - cache.at : null, negativeUntil: cache.negativeUntil, lastError: cache.lastError || locator.state().lastError, namesKnown: names.size }; }
  return { discover, readConversation, forkSession, invalidate, state: stateOf, reasonUnavailable, locator, _names: names };
}

// ── the serve-backed reader ──
/** AcpSessionMessages over the wrapper journal for LIVE sessions; for a
 *  STOPPED conversation (no journal — the synthetic session shape) the
 *  records come from the serve API on prepare() (transcript-service awaits
 *  it; a consumer that does not is simply empty, never wrong). */
class OpencodeServeSessionMessages extends AcpSessionMessages {
  constructor(session, sessionId, { buffersDir = null, live = false, facts = null } = {}) {
    super(session, sessionId, { buffersDir });
    this._live = !!live || !!(session && typeof session.buffer === 'string' && session.buffer.length);
    this._facts = facts;
    this._serveLoaded = false;
    this.source = this._live ? 'journal' : 'serve';
  }
  async prepare() {
    if (this._live || this._serveLoaded) return;
    const id = this._session?.backendSessionId || this._session?.sessionId || this._sessionId || null;
    if (!id || !this._facts) { this._serveLoaded = true; return; }
    const { records, session } = await this._facts.readConversation(id);
    this._all = records;
    this._serveSession = session || null;
    this._serveLoaded = true;
  }
}

// ── the installed singleton (ORCH wires it once; the harness descriptor reads it) ──
let installed = null;
const NULL_FACTS = Object.freeze({
  discover: async () => [],
  readConversation: async (id) => { throw new OpencodeServeError(`OpenCode serve is not configured on this instance (conversation ${id})`, { code: 'unconfigured' }); },
  forkSession: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  invalidate: () => { },
  state: () => ({ installed: false, ready: false, parked: false, caps: null, configured: false }),
  reasonUnavailable: () => 'OpenCode serve is not configured on this instance',
  locator: null,
});
/** Wire the locator + facts for this process. Called ONCE by cli-env (ORCH);
 *  tests call it with a mock spawn/fetch. Returns the facts. */
function install(opts) {
  const locator = opts.locator || createServeLocator(opts);
  installed = createFacts(locator, opts);
  return installed;
}
function facts() { return installed || NULL_FACTS; }
function uninstall() { const f = installed; installed = null; try { f?.locator?.stop?.(); } catch { } }

module.exports = {
  OpencodeServeClient, OpencodeServeError, createServeLocator, createFacts, OpencodeServeSessionMessages,
  messagesToAcpRecords, acpKindOfTool, acpStatusOfState, sessionTitle, install, facts, uninstall,
  DEFAULT_TIMEOUT_MS, READ_TIMEOUT_MS, LIST_CACHE_MS, NEGATIVE_CACHE_MS, MAX_CRASHES, FORK_PATH,
};
