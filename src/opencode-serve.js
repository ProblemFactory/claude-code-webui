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
 *                          startedAt,command,cwd} when it still answers
 *                          /global/health AND its own project is safe,
 *                          else start `opencode serve --port <free>
 *                          --hostname 127.0.0.1` (detached, stdio ignored, under
 *                          the caller's sanitized env, FROM ITS OWN EMPTY
 *                          data/opencode-serve/cwd) and keep it: respawn on
 *                          exit with exponential backoff, PARKED after 5 crashes
 *                          (loud in user actions, silent in the poll), stopped
 *                          on server exit, and STOPPED as a runaway when its
 *                          /proc sample blows the CPU/RSS bounds. Started
 *                          LAZILY on the first discovery and only when the CLI
 *                          is installed AND autostart is on — and autostart is
 *                          DEFAULT OFF (owner decision 2026-09-07): the switch
 *                          is the built-in 'opencode-serve' PLUGIN the user
 *                          enables deliberately (decideAutostart below is the
 *                          ONE decision; src/plugins.js is its control surface,
 *                          this module stays the facts). After boot the
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
 * WHERE IT RUNS AND WHAT IT MAY TOUCH (2.369.50, the 2.369.42 runaway):
 * OpenCode boots an "instance" per DIRECTORY and each instance recursively
 * indexes + inotify-watches that tree (`fff-*` + `notify-rs` threads).
 * Measured with /proc against a real 1.18.29 serve:
 *   • v1 routes (/session, /session/:id, /session/:id/message, /project) boot
 *     NOTHING; every v2 /api/session/{id}/… route boots an instance for that
 *     session's directory (+19 threads, +200 MB, a full-tree watch).
 *   • the serve's cwd decides its DEFAULT project (git walk UP, else the
 *     'global' catch-all whose worktree is '/'), so the serve runs from its own
 *     empty throwaway git repo under data/opencode-serve/cwd.
 *   • listAllSessions takes the DIRECTORY-LESS listing first and only
 *     bootstraps `scope=project` for real (vcs-backed) worktrees, never '/',
 *     $HOME or the tmp dir.
 * The 2.369.42 shape: the serve ran with cwd=$HOME (project '/') and the naming
 * lookup used the v2 route on a session whose directory was /tmp — 209 CPU-min,
 * 5.0 GB RSS, 30 021 inotify watches, 3.6 GB/s page-cache reads.
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
 * message) read from the v1 GET /session/:id/message list — which is the WHOLE
 * conversation oldest-first (v1 `limit` returns the NEWEST N, so it cannot page
 * from the front), capped at NAME_MAX_BYTES. The v2 asc endpoint is smaller but
 * BOOTS AN INSTANCE — see above; never use it here. Cached per id, at most
 * NAME_BATCH lookups per discovery tick so a big store names itself
 * progressively without a request burst; fallback = OpenCode's own title unless
 * it is the "New session - <date>" placeholder.
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
const { spawn, execFile } = require('child_process');
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
const NAME_MAX_BYTES = 1 << 20;    // the naming read is the WHOLE v1 message list — refuse a conversation bigger than this (it has a real title anyway)
// ── the RUNAWAY guard (2.369.50, the 2.369.42 incident) ──
const GUARD_SAMPLE_MS = 60000;                     // /proc sample cadence
const GUARD_CPU_PCT = 150;                         // sustained CPU% (100% = one core) that counts as hot
const GUARD_CPU_SUSTAIN_MS = 5 * 60 * 1000;        // …for this long ⇒ runaway
const GUARD_RSS_BYTES = 2 * 1024 * 1024 * 1024;    // RSS above this ⇒ runaway at once
const RUNAWAY_COOLDOWN_MS = 60 * 60 * 1000;        // a runaway is respawned at most once an hour
const CLK_TCK = 100;                               // Linux USER_HZ (getconf CLK_TCK) — /proc stat ticks → seconds

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

// ── THE autostart decision (ONE implementation; cli-env only wires the inputs) ──
/** The ops override, if any: `VIBESPACE_OPENCODE_SERVE=1/0` → true/false,
 *  unset/empty → null. Kept here (not in cli-env) so the plugin control
 *  surface and the keeper read the SAME switch — a second parse of the same
 *  env var is the twin class this repo keeps paying for. */
function serveEnvOverride(env = process.env) {
  const v = env && env.VIBESPACE_OPENCODE_SERVE;
  if (v === undefined || v === null || v === '') return null;
  return v !== '0';
}
/** May the keeper START a serve right now?
 *  env override (ops, wins) > the 'opencode-serve' PLUGIN record
 *  (enabled && desiredUp). DEFAULT OFF — owner decision 2026-09-07: nothing
 *  starts a background third-party daemon on this machine until the user
 *  enables the plugin. (Reuse of an ALREADY-RUNNING recorded instance is a
 *  separate rung and still works: adopting costs nothing.) */
function decideAutostart({ env = process.env, pluginWantsUp = false } = {}) {
  const o = serveEnvOverride(env);
  if (o !== null) return o;
  return !!pluginWantsUp;
}

// ── where the serve runs, and which worktrees may be bootstrapped ──
/** OpenCode resolves its DEFAULT project from the process cwd, and every
 *  instance it boots recursively INDEXES + inotify-watches a directory tree
 *  (the `fff-*` fast-file-finder threads + `notify-rs`). MEASURED on 1.18.29:
 *    • cwd inside a git checkout  → project worktree = that checkout (the walk
 *      goes UP; a plain `data/opencode-serve/cwd` resolves the whole VibeSpace
 *      checkout, node_modules and all — a fake `.git` directory does NOT stop
 *      it, only a real repo does)
 *    • cwd with no repo above it  → the catch-all 'global' project, worktree '/'
 *  So the serve gets its OWN empty directory made into a throwaway git repo:
 *  the walk stops there and the default project is an empty tree. Falls back to
 *  the bare directory (loudly) when `git init` is unavailable. */
function serveCwdPath(dataDir) { return path.join(dataDir, 'opencode-serve', 'cwd'); }
const SERVE_CWD_README = `This directory is the working directory of VibeSpace's \`opencode serve\` keeper
(src/opencode-serve.js). It is deliberately EMPTY and its own throwaway git repo:
OpenCode resolves its default project from the serve's cwd by walking UP for a
git worktree, and any instance it boots recursively indexes + inotify-watches
that tree. Pointing the serve at $HOME (2.369.42) resolved the '/' project.
Do not put files here, do not delete it while the server runs.
`;
async function ensureServeCwd(dataDir, { execImpl = execFile, log = null } = {}) {
  const dir = serveCwdPath(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(path.join(dataDir, 'opencode-serve', 'README.txt'), SERVE_CWD_README); } catch { }
  // a bare `.git` ENTRY is not a repo: OpenCode's upward walk ignores it and
  // resolves the whole checkout (verifier reproduced it after a died git init /
  // a backup that dropped .git contents) — require HEAD, else re-init
  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(path.join(gitDir, 'HEAD'))) return { dir, isolated: true };
  if (fs.existsSync(gitDir)) { try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch { } }
  const ok = await new Promise((resolve) => {
    try { execImpl('git', ['init', '-q', '.'], { cwd: dir, timeout: 10000 }, (err) => resolve(!err)); }
    catch { resolve(false); }
  });
  if (!ok) log?.warn?.('[opencode-serve] `git init` failed in the isolated serve cwd — OpenCode will resolve the ENCLOSING checkout (or "/") as its default project; nothing indexes it while discovery stays on the v1 routes, but the isolation is weaker');
  return { dir, isolated: ok };
}
/** May we hand this /project row to a `scope=project&directory=` query?
 *  '/' and $HOME are the 2.369.42 shapes (the whole filesystem / the whole
 *  home); os.tmpdir() is the tree that actually burned. A REAL project row
 *  carries `vcs` (verified 1.18.29: the git-backed rows do, the 'global'
 *  catch-all does not) — that is the API's own "is a real project" signal, so
 *  no fs call is needed (the never-block-the-event-loop law). */
function bootstrappableWorktree(project) {
  const w = project && typeof project.worktree === 'string' ? project.worktree.trim() : '';
  if (!w || !path.isAbsolute(w)) return false;
  const p = path.resolve(w);
  if (p === path.parse(p).root) return false;
  if (p === path.resolve(os.homedir())) return false;
  if (p === path.resolve(os.tmpdir())) return false;
  return !!project.vcs;
}
/** A recorded serve whose CURRENT project is '/' or $HOME is a 2.369.42
 *  leftover: replace it instead of adopting it. */
function unsafeWorktreeReason(worktree) {
  const w = typeof worktree === 'string' && worktree.trim() ? path.resolve(worktree.trim()) : '';
  if (!w) return null;
  if (w === path.parse(w).root) return 'its project worktree is "/" — the WHOLE filesystem';
  if (w === path.resolve(os.homedir())) return `its project worktree is the home directory (${w})`;
  return null;
}
/** {cpuTicks, rssBytes} for a pid, or null. procfs only (no mountpoint, no
 *  child process) — safe to read synchronously once a minute. */
function readProcUsage(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cpuTicks = Number(f[11]) + Number(f[12]); // utime + stime
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || 0);
    if (!Number.isFinite(cpuTicks)) return null;
    return { cpuTicks, rssBytes: rssKb * 1024 };
  } catch { return null; }
}

// ── the client ──
class OpencodeServeClient {
  constructor(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null, auth = null } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._auth = auth && auth.password ? 'Basic ' + Buffer.from(`${auth.username || 'opencode'}:${auth.password}`).toString('base64') : null;
  }
  async request(method, route, { query = null, body = null, timeoutMs = null, maxBytes = 0 } = {}) {
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
      const text = await this._readBody(res, method, route, maxBytes);
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
  /** Body text, refusing anything past `maxBytes` (0 = unbounded). The naming
   *  read is the WHOLE v1 message list; six of those concurrently, unbounded,
   *  into this process is an OOM waiting to happen. Only successful responses
   *  are capped — an error body is always read whole for its message. */
  async _readBody(res, method, route, maxBytes) {
    if (!maxBytes || !res.ok || !res.body || typeof res.body.getReader !== 'function') return res.text();
    const reader = res.body.getReader();
    const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) { try { await reader.cancel(); } catch { } throw new OpencodeServeError(`${method} ${route} response exceeded ${maxBytes} bytes`, { code: 'too-large' }); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  health(opts) { return this.request('GET', '/global/health', opts); }
  openapi(opts = {}) { return this.request('GET', '/doc', { timeoutMs: READ_TIMEOUT_MS, ...opts }); }
  listProjects(opts) { return this.request('GET', '/project', opts); }
  /** The project THIS serve resolved from its own cwd (worktree '/' or $HOME = a 2.369.42 leftover). */
  currentProject(opts) { return this.request('GET', '/project/current', opts); }
  /** POST /instance/dispose?directory= — tears down the OpenCode instance (and
   *  its file watcher) for a directory. Best-effort belt for the one place we
   *  hand a directory to a mutating endpoint. */
  disposeInstance(directory, { timeoutMs = null } = {}) {
    return this.request('POST', '/instance/dispose', { query: { directory }, timeoutMs });
  }
  /** GET /session — verified 1.18.29 semantics: bare `directory` = sessions
   *  whose directory is EXACTLY that path (so `/` matches nothing);
   *  `scope=project` + `directory=<worktree>` = the whole project; `roots`
   *  hides child (sub-agent) sessions. */
  listSessions({ limit = LIST_LIMIT, directory = null, scope = null, roots = null, timeoutMs = null } = {}) {
    return this.request('GET', '/session', { query: { limit, directory, scope, roots: roots === null ? null : (roots ? 'true' : 'false') }, timeoutMs });
  }
  /** Every session the store knows, deduped by id.
   *  RUNG 1 = the DIRECTORY-LESS listing. Verified 1.18.29 on a real store: a
   *  bare `GET /session` returns every session regardless of the serve's cwd
   *  and bootstraps NO instance. (The v2 `GET /api/session` is the same set
   *  with cursor pagination and also needs no directory; the v1 shape is the
   *  one the rest of this module speaks, so that is the rung we take.)
   *  RUNG 2 = `scope=project&directory=<worktree>`, and ONLY for worktrees that
   *  pass bootstrappableWorktree: never '/', never $HOME, never the tmp dir,
   *  never the 'global' catch-all row. 2.369.42 queried `directory=/` every
   *  10s against a serve whose only project WAS '/'. */
  async listAllSessions({ limit = LIST_LIMIT, timeoutMs = null } = {}) {
    const byId = new Map();
    const add = (list) => { for (const s of Array.isArray(list) ? list : []) if (s && typeof s.id === 'string' && !byId.has(s.id)) byId.set(s.id, s); };
    let bareErr = null;
    try { add(await this.listSessions({ limit, timeoutMs })); } catch (e) { bareErr = e; }
    let projects = [];
    try { projects = await this.listProjects({ timeoutMs }); } catch { projects = []; }
    const dirs = [], skipped = [];
    for (const p of Array.isArray(projects) ? projects : []) {
      const w = p && typeof p.worktree === 'string' ? p.worktree : '';
      if (!w) continue;
      if (bootstrappableWorktree(p)) { if (!dirs.includes(w)) dirs.push(w); }
      else if (!skipped.includes(w)) skipped.push(w);
    }
    this.skippedWorktrees = skipped;
    if (dirs.length) for (const l of await Promise.all(dirs.map((directory) => this.listSessions({ limit, directory, scope: 'project', timeoutMs }).catch(() => [])))) add(l);
    if (!byId.size && bareErr) throw bareErr;
    return [...byId.values()];
  }
  getSession(id, opts) { return this.request('GET', `/session/${encodeURIComponent(id)}`, opts); }
  /** GET /session/:id/message — v1 shape [{info, parts}]; `limit` = the NEWEST N, `before` pages older. */
  listMessages(id, { limit = null, before = null, timeoutMs = null } = {}) {
    return this.request('GET', `/session/${encodeURIComponent(id)}/message`, { query: { limit, before }, timeoutMs });
  }
  /** The FIRST user message → {id, text} | null.
   *  THE NAMING LOOKUP MUST STAY ON THE v1 ROUTE. Measured on 1.18.29 with
   *  /proc: every `GET /api/session/{id}/…` route (message, history, context,
   *  the session itself) BOOTSTRAPS an OpenCode instance for that session's
   *  DIRECTORY — +19 threads, a recursive `fff` index and an inotify watch of
   *  the whole tree; the v1 routes (`/session/:id`, `/session/:id/message`,
   *  `/session`, `/project`) boot nothing. 2.369.42 named sessions through
   *  `/api/session/:id/message?order=asc`, the one session in the owner's
   *  store had `directory: "/tmp"`, and the serve spent 209 CPU-minutes and
   *  5.0 GB RSS on 30 021 inotify watches over that tree.
   *  v1 returns the WHOLE list oldest-first (its `limit` is the NEWEST N, so
   *  it cannot page from the front) — capped at NAME_MAX_BYTES; a conversation
   *  bigger than that long ago earned a real OpenCode title to fall back on. */
  async firstUserMessage(id, { timeoutMs = null, maxBytes = NAME_MAX_BYTES } = {}) {
    const list = await this.request('GET', `/session/${encodeURIComponent(id)}/message`, { timeoutMs, maxBytes });
    for (const m of Array.isArray(list) ? list : []) {
      const info = m?.info || {};
      if (info.role !== 'user') continue;
      const parts = Array.isArray(m.parts) ? m.parts : [];
      const texts = parts.filter((p) => p && p.type === 'text' && p.text && !p.ignored);
      const visible = texts.filter((p) => !p.synthetic);
      const text = (visible.length ? visible : texts).map((p) => String(p.text)).join('\n').trim();
      if (text) return { id: String(info.id || ''), text };
    }
    return null;
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
  fetchImpl = null, spawnImpl = spawn, execImpl = execFile, bootTimeoutMs = BOOT_TIMEOUT_MS, backoffBaseMs = 1000,
  maxCrashes = MAX_CRASHES, stopOnExit = false, onCaps = null, onState = null,
  autostart = true, // false (or a function returning false) = REUSE ONLY (smoke harnesses: a SIGKILLed test server must not leave a serve behind)
  // ── the runaway guard (2.369.50) ──
  readProc = readProcUsage, killPid = (pid, sig) => process.kill(pid, sig),
  telemetry = null, now = Date.now, guardSampleMs = GUARD_SAMPLE_MS,
  guardCpuPct = GUARD_CPU_PCT, guardCpuSustainMs = GUARD_CPU_SUSTAIN_MS, guardRssBytes = GUARD_RSS_BYTES,
  runawayCooldownMs = RUNAWAY_COOLDOWN_MS,
} = {}) {
  if (!dataDir) throw new Error('createServeLocator: dataDir is required (the record lives at data/opencode-serve.json)');
  const recordPath = path.join(dataDir, 'opencode-serve.json');
  const state = { client: null, port: null, pid: null, startedAt: null, source: null, child: null, crashes: 0, parked: false, parkedKind: null, runawayUntil: 0, lastError: null, stopping: false, backoffUntil: 0, caps: null, version: null, capsProbed: false, cwd: cwd || null, cwdIsolated: null, cpuPct: null, rssBytes: null, sampledAt: null, skippedWorktrees: [] };
  const guard = { prev: null, hotSince: 0, timer: null };
  let ensuring = null;
  let respawnTimer = null;
  const autostartOn = () => !!(typeof autostart === 'function' ? autostart() : autostart);
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
    guard.prev = null; guard.hotSince = 0; armGuard();
    notify();
    await probeCaps(state.client);
    notify();
    return state.client;
  }
  // ── the RUNAWAY guard (2.369.50) ──────────────────────────────────────────
  // A serve is not "hung", it BURNS: 2.369.42's instance sat at 157-169% CPU
  // and 5.0 GB RSS for two hours while its file watcher crawled /tmp, and
  // nothing in the product noticed. Sample the child's own /proc every minute;
  // sustained CPU or an RSS blowout stops it, PARKS the locator as
  // 'parked:runaway' (loud + telemetry + the harness availability reason) and
  // refuses to respawn it more than once an hour.
  function armGuard() {
    if (guard.timer || !guardSampleMs) return;
    guard.timer = setInterval(() => { try { sampleGuard(); } catch (e) { log?.warn?.(`[opencode-serve] resource sample failed: ${e.message}`); } }, guardSampleMs);
    if (guard.timer.unref) guard.timer.unref();
  }
  function sampleGuard() {
    if (state.stopping || state.parked || !state.pid) { guard.prev = null; return; }
    const s = readProc(state.pid);
    const t = now();
    if (!s) { guard.prev = null; return; }
    let cpuPct = null;
    if (guard.prev && t > guard.prev.at) cpuPct = (s.cpuTicks - guard.prev.cpuTicks) * 100000 / CLK_TCK / (t - guard.prev.at);
    guard.prev = { at: t, cpuTicks: s.cpuTicks };
    state.cpuPct = cpuPct; state.rssBytes = s.rssBytes; state.sampledAt = t;
    let why = null;
    if (s.rssBytes > guardRssBytes) why = `RSS ${(s.rssBytes / 2 ** 30).toFixed(1)} GB (limit ${(guardRssBytes / 2 ** 30).toFixed(1)} GB)`;
    else if (cpuPct !== null && cpuPct > guardCpuPct) {
      if (!guard.hotSince) guard.hotSince = t;
      if (t - guard.hotSince >= guardCpuSustainMs) why = `${cpuPct.toFixed(0)}% CPU sustained for ${Math.round((t - guard.hotSince) / 60000)} min (limit ${guardCpuPct}%)`;
    } else guard.hotSince = 0;
    if (why) parkRunaway(why); else notify();
  }
  function parkRunaway(why) {
    const pid = state.pid, port = state.port;
    state.parked = true; state.parkedKind = 'runaway'; state.runawayUntil = now() + runawayCooldownMs;
    state.lastError = `opencode serve (pid ${pid}) was STOPPED as a runaway: ${why}`;
    guard.prev = null; guard.hotSince = 0;
    const ch = state.child;
    state.child = null; state.client = null; state.port = null; state.pid = null;
    try { if (ch) ch.kill('SIGTERM'); else if (pid && pid !== process.pid) killPid(pid, 'SIGTERM'); } catch { }
    clearRecord();
    log?.error?.(`[opencode-serve] RUNAWAY — ${state.lastError}. OpenCode boots an instance per session DIRECTORY and its file finder indexes + watches that whole tree; a session rooted at a huge directory burns the machine. Not restarting for ${Math.round(runawayCooldownMs / 60000)} min — disable the "OpenCode background service" plugin (⚙ → Plugins) if it recurs.`);
    try { telemetry?.({ name: 'opencode-serve-runaway', detail: `${why}${port ? ` port ${port}` : ''}`, value: Math.round(state.rssBytes / 1048576) }); } catch { }
    notify();
  }
  function onChildExit(child, code, signal) {
    if (state.child !== child) return;
    state.child = null; state.client = null; state.port = null; state.pid = null;
    clearRecord();
    if (state.stopping || state.parked) { notify(); return; } // a runaway/park already decided the outcome — never respawn on its own SIGTERM
    if (state.startedAt && Date.now() - state.startedAt >= HEALTHY_UPTIME_RESET_MS) state.crashes = 0;
    state.crashes++;
    state.lastError = `opencode serve exited (${signal || `code ${code}`})`;
    if (state.crashes >= maxCrashes) {
      state.parked = true; state.parkedKind = 'crash';
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
  /** null = adopt it; a string = why this recorded serve must be REPLACED.
   *  The 2.369.42 self-heal: an instance whose own project is '/' or $HOME
   *  indexes that whole tree the moment anything bootstraps it, so the owner's
   *  leftover is stopped and respawned from the isolated cwd on update — no
   *  manual step. A record written by THIS code (rec.cwd = our isolated dir)
   *  skips the probe; a probe that fails NEVER churns (unknown ≠ unsafe). */
  async function unsafeReuseReason(probe, rec) {
    // the cwd shortcut is only proof when OUR cwd is a verified repo — a
    // degraded (bare .git) cwd resolves the whole checkout, so probe instead
    if (state.cwdIsolated === true && state.cwd && rec.cwd && path.resolve(rec.cwd) === path.resolve(state.cwd)) return null;
    let cur = null;
    try { cur = await probe.currentProject({ timeoutMs: DEFAULT_TIMEOUT_MS }); } catch { return null; }
    const why = unsafeWorktreeReason(cur && cur.worktree);
    return why ? `${why} (a 2.369.42 serve started from the server's own cwd)` : null;
  }
  async function locate() {
    if (state.client) return state.client;
    if (state.stopping) return null;
    if (state.parked) {
      // a runaway earns exactly one retry per cooldown; a crash park is terminal until restart
      if (state.parkedKind !== 'runaway' || now() < state.runawayUntil) return null;
      state.parked = false; state.parkedKind = null; state.crashes = 0; state.lastError = null;
      log?.warn?.('[opencode-serve] runaway cooldown elapsed — trying `opencode serve` once more');
    }
    if (Date.now() < state.backoffUntil) return null;
    const cmd = commandOf();
    // the serve's OWN empty directory (see ensureServeCwd): resolved before the
    // reuse probe so a recorded instance can be compared against it
    if (cmd && !state.cwd) {
      try { const r = await ensureServeCwd(dataDir, { execImpl, log }); state.cwd = r.dir; state.cwdIsolated = r.isolated; }
      catch (e) { log?.warn?.(`[opencode-serve] isolated cwd unavailable (${e.message})`); }
    }
    // 1) reuse a recorded instance (a previous VibeSpace's child that outlived a SIGKILL restart)
    const rec = readRecord();
    if (rec) {
      const probe = mkClient(rec.port);
      if (await healthy(probe, DEFAULT_TIMEOUT_MS)) {
        const bad = await unsafeReuseReason(probe, rec);
        if (!bad) return adopt(rec.port, rec.pid || null, 'reused');
        log?.warn?.(`[opencode-serve] replacing the recorded serve (pid ${rec.pid}, port ${rec.port}): ${bad}`);
        // never signal ourselves: a record can name this very process (a stale
        // pid reused after a reboot) and a self-SIGTERM would take the server down
        try { if (rec.pid && rec.pid !== process.pid) killPid(rec.pid, 'SIGTERM'); } catch { }
        clearRecord();
      } else if (!pidAlive(rec.pid)) clearRecord();
    }
    // 2) start one — only when the CLI is installed and autostart is allowed
    if (!cmd) { state.lastError = 'opencode CLI is not installed'; return null; }
    if (!autostartOn()) { state.lastError = serveEnvOverride() === false ? 'the OpenCode background service is forced OFF by VIBESPACE_OPENCODE_SERVE=0 on this instance' : 'the OpenCode background service is off — enable the "OpenCode background service" plugin (⚙ → Plugins) to start it'; return null; }
    const port = await freePort();
    let child;
    try {
      child = spawnImpl(cmd, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--log-level', 'WARN'], { cwd: state.cwd || cwd || os.homedir(), env: env(), stdio: 'ignore', detached: true });
    } catch (e) { state.lastError = `spawn failed: ${e.message}`; state.crashes++; if (state.crashes >= maxCrashes) { state.parked = true; state.parkedKind = 'crash'; } notify(); return null; }
    if (typeof child.unref === 'function') child.unref();
    state.child = child; state.pid = child.pid || null; state.startedAt = Date.now();
    child.once('error', (e) => { state.lastError = `spawn failed: ${e.message}`; });
    child.on('exit', (code, signal) => onChildExit(child, code, signal));
    writeRecord({ port, pid: child.pid || null, startedAt: state.startedAt, command: cmd, cwd: state.cwd || cwd || null });
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
  /** An EXPLICIT user start (the plugin's Start / Enable & start button).
   *  Clears a previous stop() and any park — a user asking for it IS the
   *  deliberate retry a crash/runaway park waits for — then runs the ladder.
   *  Returns the ensure() promise so the caller can report the outcome. */
  function start() {
    state.stopping = false;
    state.parked = false; state.parkedKind = null; state.crashes = 0;
    state.backoffUntil = 0; state.runawayUntil = 0; state.lastError = null;
    notify();
    return ensure();
  }
  /** Stop the keeper. `killRecorded` = ALSO SIGTERM an instance we merely
   *  ADOPTED from data/opencode-serve.json (a previous VibeSpace's child).
   *  The process-exit path deliberately leaves an adopted instance alone (the
   *  next boot reuses it); a user turning the service OFF means STOP IT. */
  function stop({ killRecorded = false } = {}) {
    state.stopping = true;
    clearTimeout(respawnTimer); respawnTimer = null;
    if (guard.timer) { clearInterval(guard.timer); guard.timer = null; }
    const ch = state.child;
    const livePid = state.pid;
    state.child = null; state.client = null; state.port = null;
    if (ch) { try { ch.kill('SIGTERM'); } catch { } clearRecord(); }
    else if (killRecorded) {
      const rec = readRecord();
      const target = livePid || rec?.pid || null;
      // never signal ourselves: a stale pid can name this very process
      try { if (target && target !== process.pid) killPid(target, 'SIGTERM'); } catch { }
      clearRecord();
    }
    state.pid = null; state.source = null;
    notify();
  }
  function snapshot() {
    return { port: state.port, pid: state.pid, startedAt: state.startedAt, source: state.source, crashes: state.crashes, parked: state.parked, parkedKind: state.parkedKind, runawayUntil: state.runawayUntil, lastError: state.lastError, caps: state.caps ? { ...state.caps } : null, version: state.version, capsProbed: state.capsProbed, installed: !!commandOf(), autostart: autostartOn(), envForced: serveEnvOverride(), stopped: !!state.stopping, cwd: state.cwd, cwdIsolated: state.cwdIsolated, cpuPct: state.cpuPct, rssBytes: state.rssBytes, sampledAt: state.sampledAt, recordPath, ready: !!state.client };
  }
  if (stopOnExit) process.once('exit', () => { try { stop(); } catch { } });
  return { client, ensure, start, stop, invalidate, state: snapshot, command: commandOf, recordPath, _sampleGuard: sampleGuard };
}

// ── the store facts ──
function createFacts(locator, { now = Date.now, nameBatch = NAME_BATCH, listCacheMs = LIST_CACHE_MS, negativeCacheMs = NEGATIVE_CACHE_MS } = {}) {
  const cache = { list: null, at: 0, negativeUntil: 0, lastError: null, skippedWorktrees: [] };
  const names = new Map();      // id → { name, at }
  const naming = new Set();
  const convo = new Map();      // id → { at, session, messages, records }
  let listing = null;

  function reasonUnavailable() {
    const st = locator.state();
    if (!st.installed) return 'OpenCode is not installed on this machine (no `opencode` on PATH — install it or set OPENCODE_CMD)';
    // the runaway must SPEAK: the owner's instance burned for two hours with
    // nothing in the product saying so (2.369.42)
    if (st.parked && st.parkedKind === 'runaway') return `OpenCode serve was stopped by VibeSpace as a RUNAWAY — ${st.lastError || 'resource guard'}. It will not restart for up to an hour; disable the "OpenCode background service" plugin (⚙ → Plugins) if it keeps happening.`;
    if (st.parked) return `OpenCode serve is parked after ${st.crashes} crashes (${st.lastError || 'unknown error'}) — start it again from ⚙ → Plugins → OpenCode background service`;
    if (st.autostart === false) return st.envForced === false
      ? 'the OpenCode background service is forced OFF by VIBESPACE_OPENCODE_SERVE=0 on this instance — stopped OpenCode conversations cannot be listed or opened'
      : 'the OpenCode background service is off — enable the "OpenCode background service" plugin (⚙ → Plugins) to list, open, resume and fork STOPPED OpenCode conversations';
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
      if (n && (n.name || n.permanent || t - n.at < NAME_RETRY_MS)) continue; // permanent: a deterministic refusal (too-large / 404) is never re-asked
      todo.push(s.id);
      if (todo.length >= nameBatch) break;
    }
    await Promise.all(todo.map(async (id) => {
      naming.add(id);
      try {
        const first = await client.firstUserMessage(id, { timeoutMs: DEFAULT_TIMEOUT_MS });
        names.set(id, { name: first ? (nameFromText(first.text) || '') : '', at: now() });
      } catch (e) {
        // a conversation over the naming cap (or a vanished session) will not shrink:
        // mark it PERMANENT so the 60s retry never re-serialises it (verifier: 4 full
        // 3 MiB fetches in 200s on a cheaper route — the forever-poke pattern again)
        const permanent = e && (e.code === 'too-large' || e.status === 404 || e.code === 'NotFoundError');
        names.set(id, { name: '', at: now(), permanent });
        if (isConnErr(e)) locator.invalidate(e.message);
      } finally { naming.delete(id); }
    }));
  }
  async function refreshList(budgetMs) {
    const client = await locator.client({ budgetMs });
    if (!client) throw new OpencodeServeError(reasonUnavailable(), { code: 'unavailable' });
    const list = await withTimeout(client.listAllSessions({ timeoutMs: budgetMs }), budgetMs, 'session listing');
    cache.list = list; cache.at = now(); cache.lastError = null;
    cache.skippedWorktrees = client.skippedWorktrees || [];
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
    // fork is the ONE call that hands a directory to a mutating endpoint —
    // dispose the instance it may have bootstrapped (best effort; the forked
    // session lives in sqlite and stays readable, verified 1.18.29)
    const dir = cwd || forked.directory || null;
    if (dir) await client.disposeInstance(dir, { timeoutMs: DEFAULT_TIMEOUT_MS }).catch(() => { });
    invalidate();
    return forked;
  }
  function invalidate() { cache.at = 0; cache.negativeUntil = 0; convo.clear(); }
  function stateOf() { return { ...locator.state(), cachedSessions: cache.list ? cache.list.length : null, cacheAgeMs: cache.at ? now() - cache.at : null, negativeUntil: cache.negativeUntil, lastError: cache.lastError || locator.state().lastError, namesKnown: names.size, skippedWorktrees: cache.skippedWorktrees || [] }; }
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
  state: () => ({ installed: false, ready: false, parked: false, caps: null, configured: false, autostart: false, envForced: null, stopped: true }),
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
  bootstrappableWorktree, unsafeWorktreeReason, ensureServeCwd, serveCwdPath, readProcUsage,
  serveEnvOverride, decideAutostart, SERVICE_PLUGIN_ID: 'opencode-serve',
  DEFAULT_TIMEOUT_MS, READ_TIMEOUT_MS, LIST_CACHE_MS, NEGATIVE_CACHE_MS, MAX_CRASHES, FORK_PATH,
  NAME_MAX_BYTES, GUARD_CPU_PCT, GUARD_RSS_BYTES, GUARD_SAMPLE_MS, RUNAWAY_COOLDOWN_MS,
};
