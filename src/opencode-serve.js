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
 * WIRED BY THE S9 REMAINDER (B-eac2 — the old "NOT IN SCOPE" list is empty):
 * revert/unrevert, the `question` ask lane, the pty family, and the SSE stream
 * (src/opencode-events.js) which REPLACED the 10s list poll.
 *
 * THE PTY FAMILY SENDS NO `directory` (round 4 — the one place a user
 * directory could still reach the serve). A `?directory=` query is what BOOTS
 * an instance, `DELETE /pty/{id}` frees nothing it booted, and measured on a
 * 200-dir repo that is 204 inotify watches per terminal that outlive every
 * close, vs 4 without it — with an identical shell cwd, because the shell's
 * directory rides the request BODY. See OpencodeServeClient's pty block.
 * A serve pty also OUTLIVES this process, so `reapPtys()` sweeps the ones no
 * session can reach on the ready edge of each serve process.
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
/** Opening a pty BOOTS the OpenCode instance for that directory (measured:
 *  +19 indexer threads, a full-tree index) — on a cold directory, or a loaded
 *  machine, that is well past the 8s read budget. It is an explicit user
 *  action with a spinner, so it gets a spawn-sized one. */
const PTY_TIMEOUT_MS = 45000;
const LIST_CACHE_MS = 10000;
const NEGATIVE_CACHE_MS = 10000;
const NAME_RETRY_MS = 60000;       // a session with no user message yet is re-checked at most this often
const BOOT_TIMEOUT_MS = 20000;     // opencode 1.18.29 answers /global/health in ~1.2s locally
const MAX_CRASHES = 5;
const HEALTHY_UPTIME_RESET_MS = 60000; // a serve that stayed up this long resets the crash counter
const NAME_BATCH = 6;
/** How long POSITIVE evidence that ANOTHER process touched a conversation
 *  keeps it labelled 'external' (piece (f)). Short on purpose: the label must
 *  decay back to 'stopped' on its own -- we never claim a running agent we
 *  cannot see, and we never keep claiming one after the evidence went stale. */
const EXTERNAL_WINDOW_MS = 90000;
/** How long a mutation WE made stays exempt from that rung when the action
 *  gave us NO new `time.updated` to match on (an answered/rejected ask).
 *  MEASURED on a real 1.18.29 serve: `revert`/`unrevert` return the row's
 *  FINAL `time.updated` and the serve never bumps it again afterwards
 *  (0ms delta at +250ms…+8s), so those writes are recognised EXACTLY — by
 *  value, not by clock — and this window only has to cover a listing that was
 *  already in flight while we wrote. Short on purpose: a blind window is how
 *  a real TUI change would be missed. */
const OWN_WRITE_WINDOW_MS = 10000;
/** Floor between two event-driven list refreshes. The single-flight promise
 *  already coalesces CONCURRENT discovers; this coalesces SERIAL ones (five
 *  browser tabs each poll /api/sessions, and a busy turn dirties the store
 *  every few hundred ms), so "no timer" never becomes "a list per request". */
const MIN_REFRESH_MS = 1000;
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
// ── the RECORDED-SERVE settlement (round 10) ──
/** A recorded serve that missed the 1.5s budget gets ONE longer probe before
 *  we conclude it is wedged: a busy 1.18.29 answers /global/health in hundreds
 *  of ms but a cold one takes ~1.2s, and "slow" must not read as "stop it". */
const RECORD_CONFIRM_TIMEOUT_MS = 4000;
/** How long we wait for a SIGTERMed serve to actually exit before refusing to
 *  start a replacement over it. */
const RECORD_KILL_WAIT_MS = 3000;
const RECORD_KILL_POLL_MS = 150;
/** A 'blocked' park (a live serve we could not identify or could not stop)
 *  re-tries on its own: the state can heal without us (the serve answers
 *  again, or the process exits), and a park that only a button can leave would
 *  keep OpenCode dark long after the machine fixed itself. */
const BLOCKED_RETRY_MS = 10 * 60 * 1000;
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

/** The argv of a live pid, or null when procfs cannot say (no /proc on this
 *  platform, hidepid, or the process vanished between the two reads). */
function readProcCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s !== ''); } catch { return null; }
}
/** The uid a live pid runs as, or null. */
function readProcUid(pid) {
  try { return fs.statSync(`/proc/${pid}`).uid; } catch { return null; }
}
/** IS THIS ALIVE PID REALLY THE SERVE THE RECORD NAMES? (round 10 — PURE, the
 *  procfs reads are the caller's.) `pidAlive` answers "something is running
 *  under that number", which is NOT the same claim: pids are recycled, and the
 *  record can outlive its serve by weeks. The verdicts, and what each one
 *  licenses:
 *    'ours'    — the process is running `serve` with the recorded `--port`, as
 *                this same user ⇒ we may SIGTERM it before replacing it.
 *    'other'   — positive evidence it is NOT the serve (a different uid, this
 *                very server process, a different command line) ⇒ the recorded
 *                serve is GONE, so the record is stale bookkeeping we may
 *                delete — but we must NEVER signal that pid.
 *    'unknown' — procfs said nothing (a non-Linux host, hidepid, a zombie's
 *                empty cmdline) ⇒ neither kill nor overwrite: a serve may be
 *                running under it, and starting a second one over a record we
 *                are about to rewrite is exactly the orphan this record exists
 *                to prevent. */
function classifyRecordedPid(rec, { pid = null, argv = null, uid = null, selfUid = null, selfPid = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { verdict: 'other', why: 'the record carries no pid' };
  if (selfPid != null && pid === selfPid) return { verdict: 'other', why: `pid ${pid} is THIS server process — a recycled pid, never the serve` };
  if (uid != null && selfUid != null && uid !== selfUid) return { verdict: 'other', why: `pid ${pid} runs as uid ${uid}, not as the user this server runs as (uid ${selfUid}) — we never spawned it` };
  if (!Array.isArray(argv)) return { verdict: 'unknown', why: `the command line of pid ${pid} is unreadable (no /proc on this platform, hidepid, or the process just vanished)` };
  const args = argv.filter((a) => typeof a === 'string' && a !== '');
  if (!args.length) return { verdict: 'unknown', why: `pid ${pid} has an EMPTY command line (a zombie or a kernel thread)` };
  const port = String(rec && rec.port);
  // the PORT is the discriminator: `serve` alone is a common word, but a
  // process holding the exact port this record was written for, under our own
  // uid, is the serve or nothing. (argv[0] is deliberately NOT compared: the
  // `opencode` launcher can re-exec its runtime, so the recorded `command` is
  // not guaranteed to be argv[0] of the live process.)
  const hasServe = args.includes('serve');
  const hasPort = args.some((a, i) => (a === '--port' && args[i + 1] === port) || a === `--port=${port}`);
  if (hasServe && hasPort) return { verdict: 'ours', why: `its command line is \`${args.slice(0, 6).join(' ')}\`` };
  return { verdict: 'other', why: `pid ${pid} is now \`${args.slice(0, 4).join(' ')}\` — not the \`serve --port ${port}\` this record was written for` };
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
  /** GET /session/status → {sessionID: SessionStatus} for the sessions THIS
   *  serve is running (idle|busy|retry). MEASURED on 1.18.29: no `directory`
   *  needed and it boots NO instance (16 threads / 0 indexer threads before
   *  and after). It is an IN-PROCESS view — a session another opencode
   *  process is driving is absent from it, which is why 'external' liveness
   *  is derived from the list's own `time.updated` instead (see deriveStatus). */
  sessionStatus(opts) { return this.request('GET', '/session/status', opts); }
  todo(id, opts) { return this.request('GET', `/session/${encodeURIComponent(id)}/todo`, opts); }
  /** The store's own paths (home/state/config/worktree). Used to locate the
   *  sqlite store for the fs.watch lane on the machine the serve runs on —
   *  hostId is a parameter, so this must come from the SERVE, not from our
   *  own os.homedir(), whenever the serve is somewhere else. */
  paths(opts) { return this.request('GET', '/path', opts); }

  // ── REVERT (S9 remainder, B-eac2) ──────────────────────────────────────
  /** POST /session/:id/revert {messageID, partID?} → the updated Session,
   *  whose `revert` field is {messageID, partID?, snapshot, diff, files?}.
   *  MEASURED on a real 1.18.29 serve: the v1 route restores the working tree
   *  AND boots NO instance (16 threads / 0 fff threads before and after) —
   *  unlike every `/api/session/{id}/revert/*` v2 route (measured: 16→37
   *  threads, 0→19 indexer threads, +165 MB on a single `revert/clear`), which
   *  is why the v2 stage/clear/commit trio is deliberately NOT wired. */
  revert(id, { messageID, partID = null, directory = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    return this.request('POST', `/session/${encodeURIComponent(id)}/revert`, { query: { directory }, body: partID ? { messageID, partID } : { messageID }, timeoutMs });
  }
  /** POST /session/:id/unrevert → the updated Session with `revert` gone and
   *  the files back. This is OpenCode's own "clear the staged revert". */
  unrevert(id, { directory = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    return this.request('POST', `/session/${encodeURIComponent(id)}/unrevert`, { query: { directory }, timeoutMs });
  }

  // ── QUESTION (the `question` tool's pending requests) ──────────────────
  /** GET /question → [{id, sessionID, questions:[{question, header, options,
   *  multiple?, custom?}], tool:{messageID, callID}}]. Boots no instance
   *  (measured). PER-PROCESS: only questions raised by turns THIS serve is
   *  running are listed — see the reachability note in the module header. */
  questions(opts) { return this.request('GET', '/question', opts); }
  /** POST /question/:requestID/reply {answers} — answers[i] is the array of
   *  selected labels for questions[i], IN ORDER (verified live: a real
   *  `question` tool call answered with [["Blue"]] completed the turn). */
  questionReply(requestId, answers, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    return this.request('POST', `/question/${encodeURIComponent(requestId)}/reply`, { body: { answers }, timeoutMs });
  }
  questionReject(requestId, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    return this.request('POST', `/question/${encodeURIComponent(requestId)}/reject`, { timeoutMs });
  }

  // ── PTY (a shell the SERVE owns, on the serve's machine) ───────────────
  /** THE PTY FAMILY NEVER SENDS `directory` — round 4 of B-eac2, and the whole
   *  reason it is spelled out here (a helpful-looking `{ directory }` in ONE of
   *  these six methods re-opens the 2.369.42/2.369.50 incident).
   *
   *  A pty is addressed by its ptyID, but the pty REGISTRY is per OpenCode
   *  INSTANCE, and `?directory=X` is what picks (and BOOTS) the instance. So a
   *  `directory` query on `POST /pty` bootstraps an instance for the user's
   *  worktree — which recursively indexes and inotify-watches it — while
   *  `DELETE /pty/{id}` releases NOTHING but the shell. Measured, same-origin
   *  A/B, fresh serve per arm, target = a 200-dir/4046-file repo, /proc
   *  Threads + `inotify wd` count over /proc/<serve>/fdinfo/*:
   *    with `?directory=`  base[thr,wd]=[16,0] → open#1 [44,204] → close#1
   *                        [41,204] → open/close #2,#3 … [41,204]  (never freed)
   *    without it          base[16,0] → open#1 [45,4] → close#1 [42,4] → …[42,4]
   *  and `readlink /proc/<shell>/cwd` = the target directory in BOTH arms: the
   *  query buys the SHELL nothing (the `cwd` BODY field is what places it), it
   *  only decides which instance owns the registry entry. The only thing that
   *  frees the watches is `POST /instance/dispose` — i.e. the terminal would
   *  have to hold a whole indexed instance for its entire lifetime and dispose
   *  it on close, when it can simply never boot one.
   *
   *  CHANGE THEM TOGETHER OR NOT AT ALL: measured, `PUT /pty/{id}?directory=X`
   *  on a pty created WITHOUT the query answers 404 PtyNotFoundError (and vice
   *  versa) — a half-migrated family is a terminal that cannot be resized,
   *  closed or reaped. `serveCwdPath()` (our own empty throwaway repo) is the
   *  default instance every call below lands on; that instance's fixed cost is
   *  the 4 watches above. */
  ptyList({ timeoutMs = null } = {}) { return this.request('GET', '/pty', { timeoutMs }); }
  ptyCreate({ command = null, args = null, cwd = null, title = null, env = null, timeoutMs = PTY_TIMEOUT_MS } = {}) {
    const body = {};
    if (command) body.command = command;
    if (Array.isArray(args)) body.args = args;
    if (cwd) body.cwd = cwd;            // where the SHELL runs — measured to place it, with no instance boot
    if (title) body.title = title;
    if (env && typeof env === 'object') body.env = env;
    return this.request('POST', '/pty', { body, timeoutMs });
  }
  ptyGet(ptyId, { timeoutMs = null } = {}) { return this.request('GET', `/pty/${encodeURIComponent(ptyId)}`, { timeoutMs }); }
  ptyResize(ptyId, { rows, cols, timeoutMs = null } = {}) {
    return this.request('PUT', `/pty/${encodeURIComponent(ptyId)}`, { body: { size: { rows, cols } }, timeoutMs });
  }
  ptyRemove(ptyId, { timeoutMs = READ_TIMEOUT_MS } = {}) { return this.request('DELETE', `/pty/${encodeURIComponent(ptyId)}`, { timeoutMs }); }
  /** POST /pty/:id/connect-token → {ticket, expires_in}. On an UNSECURED
   *  loopback serve 1.18.29 answers PtyForbiddenError ("Invalid PTY connect
   *  token request") and the ws upgrade needs no ticket at all — verified on
   *  the wire. So the caller mints a ticket when it can and connects without
   *  one when it cannot; the ticket NEVER reaches a browser either way. */
  ptyTicket(ptyId, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    return this.request('POST', `/pty/${encodeURIComponent(ptyId)}/connect-token`, { timeoutMs });
  }
  /** The ws URL for a pty stream (SERVER-SIDE ONLY — the browser never learns
   *  the serve's port; ws-create bridges it into the normal terminal path).
   *  No `directory` here either: measured, the upgrade succeeds and the shell
   *  is in its `cwd` with the query gone (both arms echoed a bash prompt). */
  ptyConnectUrl(ptyId, { ticket = null, cursor = null } = {}) {
    const u = new URL(this.baseUrl + `/pty/${encodeURIComponent(ptyId)}/connect`);
    if (ticket) u.searchParams.set('ticket', ticket);
    if (cursor) u.searchParams.set('cursor', String(cursor));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }
  /** The Basic header the pty ws needs when the serve is password-protected. */
  authHeader() { return this._auth; }
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

/** QuestionInfo[] → the shape the harness-neutral ASK card renders
 *  ({question, header, options:[{label, description}], multiSelect}). PURE. */
function normalizeAskQuestions(list) {
  return (Array.isArray(list) ? list : []).map((q) => ({
    question: String(q?.question || ''),
    header: String(q?.header || ''),
    multiSelect: !!q?.multiple,
    allowCustom: !!q?.custom,
    options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: String(o?.label ?? ''), description: String(o?.description ?? '') })).filter((o) => o.label),
  })).filter((q) => q.question);
}
/** OpenCode's positional answers ([["Blue"],["a","b"]]) → the card's
 *  question-text-keyed map, which is what the resolved card renders. PURE. */
function askAnswerMap(questions, answers) {
  const out = {};
  (Array.isArray(questions) ? questions : []).forEach((q, i) => {
    const a = Array.isArray(answers) ? answers[i] : null;
    if (a == null) return;
    out[q.question] = (Array.isArray(a) ? a : [a]).map(String).join(', ');
  });
  return out;
}
/** The card's map back to OpenCode's POSITIONAL answers, in question order.
 *  A custom typed answer is one label; a multi-select is the comma-joined
 *  string the card produced, split back apart. PURE (the reply route's
 *  contract lives here, not in the ws handler). */
function askAnswersToPositional(questions, answerMap) {
  return (Array.isArray(questions) ? questions : []).map((q) => {
    const raw = answerMap && Object.prototype.hasOwnProperty.call(answerMap, q.question) ? answerMap[q.question] : '';
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) return raw.map(String);
    const s = String(raw);
    // only split when every piece is a known option label — a free-text answer
    // that happens to contain ", " must survive intact
    const labels = new Set((q.options || []).map((o) => o.label));
    const parts = s.split(', ');
    return parts.length > 1 && parts.every((p) => labels.has(p)) ? parts : [s];
  });
}
/** The one sentence a staged revert says wherever a conversation is rendered. */
function revertNoticeText(session) {
  const files = Array.isArray(session?.revert?.files) ? session.revert.files.length : 0;
  const diff = typeof session?.revert?.diff === 'string' && session.revert.diff ? session.revert.diff : '';
  const changed = files || (diff ? (diff.match(/^diff --git /gm) || []).length : 0);
  return `Reverted to here — everything below is staged for removal${changed ? ` and ${changed} file${changed === 1 ? '' : 's'} were restored` : ''}. "Restore reverted messages" undoes it; the next prompt makes it permanent.`;
}

/** OpenCode v1 messages ([{info, parts}]) + the Session → 'acp-events' records.
 *  Two S9-remainder additions (B-eac2):
 *   • a `question` tool part becomes the harness-neutral ASK card
 *     (permission_request kind 'user_input') instead of a generic "other"
 *     tool — answered ones carry their answers, an unanswered one stays
 *     open so the card can be answered from the reader after a page reload.
 *   • the session's staged `revert` becomes a notice at the boundary, so a
 *     reverted conversation SAYS it is reverted wherever it is rendered.
 */
function messagesToAcpRecords(messages, session = {}) {
  const sessionId = session?.id || messages?.[0]?.info?.sessionID || '';
  const out = [];
  const push = (rec) => { out.push(rec); return rec; };
  // the staged revert boundary: everything from this message on is "staged for
  // removal" until unrevert (v1) or the next prompt commits it
  const revertAt = typeof session?.revert?.messageID === 'string' ? session.revert.messageID : '';
  let revertAnnounced = false;
  let curModel = modelLabel(session?.model?.providerID, session?.model?.id);
  let curMode = session?.agent ? String(session.agent) : '';
  push({ ts: isoOf(session?.time?.created), type: 'acp', kind: 'session', sessionId, cwd: session?.directory || '', how: 'serve', model: curModel, mode: curMode, agentInfo: { name: 'opencode', version: session?.version || null }, replay: true });
  const upd = (ts, update) => push({ ts, type: 'acp', kind: 'update', sessionId, update, replay: true });
  for (const m of Array.isArray(messages) ? messages : []) {
    const info = m?.info || {};
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const ts = isoOf(info?.time?.created);
    if (revertAt && !revertAnnounced && String(info.id || '') === revertAt) {
      revertAnnounced = true;
      push({ ts, type: 'acp', kind: 'notice', level: 'warn', noticeKind: 'revert', text: revertNoticeText(session) });
    }
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
      } else if (p.type === 'tool' && p.tool === 'question') {
        // THE ASK CARD. Verified shape on a real 1.18.29 turn: the `question`
        // tool's part carries state.input.questions ([{question, header,
        // options:[{label, description}], multiple?, custom?}]) and, once
        // answered, state.metadata.answers ([["Blue"]] — one array of labels
        // per question, in order). The request id is NOT in the part (it is
        // `que_…`, minted per ask), so an UNANSWERED one is matched back to
        // the live `GET /question` list by (sessionID, tool.callID).
        const st = p.state || {};
        const input = st.input && typeof st.input === 'object' ? st.input : {};
        const callId = String(p.callID || p.id || '');
        const qs = normalizeAskQuestions(input.questions);
        const answers = Array.isArray(st.metadata?.answers) ? st.metadata.answers : null;
        const resolved = st.status === 'completed' ? (answers ? 'allowed' : 'denied') : (st.status === 'error' ? 'denied' : null);
        push({
          ts: pts, type: 'acp', kind: 'permission_request', sessionId,
          requestId: callId,               // the stable id inside a transcript; the live que_… id is carried by the pending list
          via: 'opencode-serve',           // which lane answers it (the card forwards this back)
          questions: qs, ask: true,
          answers: answers ? askAnswerMap(qs, answers) : null,
          resolved,
          toolCall: { toolCallId: callId, title: String(st.title || 'Question'), kind: 'other', status: resolved ? 'completed' : 'pending', rawInput: { tool: 'question', questions: qs } },
        });
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
  // ── the recorded-serve settlement (round 10) ──
  readCmdline = readProcCmdline, readUid = readProcUid,
  confirmTimeoutMs = RECORD_CONFIRM_TIMEOUT_MS, killWaitMs = RECORD_KILL_WAIT_MS, blockedRetryMs = BLOCKED_RETRY_MS,
  telemetry = null, now = Date.now, guardSampleMs = GUARD_SAMPLE_MS,
  guardCpuPct = GUARD_CPU_PCT, guardCpuSustainMs = GUARD_CPU_SUSTAIN_MS, guardRssBytes = GUARD_RSS_BYTES,
  runawayCooldownMs = RUNAWAY_COOLDOWN_MS,
} = {}) {
  if (!dataDir) throw new Error('createServeLocator: dataDir is required (the record lives at data/opencode-serve.json)');
  const recordPath = path.join(dataDir, 'opencode-serve.json');
  const state = { client: null, port: null, pid: null, startedAt: null, source: null, child: null, crashes: 0, parked: false, parkedKind: null, runawayUntil: 0, retryAfter: 0, lastError: null, stopping: false, stopEpoch: 0, backoffUntil: 0, caps: null, version: null, capsProbed: false, cwd: cwd || null, cwdIsolated: null, cpuPct: null, rssBytes: null, sampledAt: null, skippedWorktrees: [] };
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
  /** EVERY CLEAR NAMES THE SERVE IT BELIEVES IS RECORDED (round 9).
   *  data/opencode-serve.json is a promise to the NEXT boot: "this port/pid is
   *  ours — adopt it or kill it". Deleting one you do not own leaves a live
   *  third-party daemon nobody can find, which is the exact class the record
   *  exists to prevent. Round 8's `ensuring = null` let TWO ladders run at once
   *  for the first time, so "the record on disk is mine" stopped being true by
   *  construction: `owns` = {port, pid} is checked against what is actually
   *  there and a mismatch REFUSES (returns false). Port alone is not identity —
   *  a port freed by one ladder is re-bindable by the next — so the pid the
   *  record was written with is part of the claim.
   *  `clearRecord(null)` (unconditional) is reserved for `stop()`: it is
   *  synchronous, it bumps the epoch FIRST, and "the user turned it off" is the
   *  one instruction that outranks every record on disk. */
  function clearRecord(owns = null) {
    if (owns) {
      const r = readRecord();
      if (!r) return false;
      if (owns.port != null && r.port !== owns.port) return false;
      if ((r.pid ?? null) !== (owns.pid ?? null)) return false;
    }
    try { fs.unlinkSync(recordPath); } catch { }
    return true;
  }
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
  /** IS THE ATTEMPT THAT CAPTURED `epoch` STILL THE ONE ALLOWED TO PUBLISH?
   *  (round 8). `state.stopping` alone is a LEVEL, and a level is not terminal
   *  across a Disable→Enable pair: `stop()` sets it, `start()` clears it 50 ms
   *  later, and the ladder that was in flight the whole time sails past every
   *  `state.stopping` check and publishes evidence it gathered BEFORE the stop
   *  — measured: a Disable inside the 700 ms reuse probe followed by an Enable
   *  adopted `source:'reused'` on the exact port `stop({killRecorded:true})`
   *  had just SIGTERMed and whose record it had deleted, while the fresh
   *  `ensure()` (which joined the cancelled attempt instead of starting its
   *  own) spawned nothing. So the token is an EPOCH, bumped by `stop()` AND by
   *  every new `locate()`: a cancelled attempt can never become valid again,
   *  and only the NEWEST attempt may take ownership. Same shape as round 6's
   *  per-arm cancellation in the live lane, one layer up. */
  const cancelled = (epoch) => state.stopping || epoch !== state.stopEpoch;
  /** THE ACQUISITION POINT (round 7 — the same rule round 6 applied to the
   *  live lane, one layer up). This is the ONLY place `state.client` is ever
   *  assigned, so it is the only place that can refuse to hand a client to a
   *  service that was turned OFF while we were awaiting something. `locate()`
   *  checks its cancellation at ENTRY only, and every rung below reaches this
   *  call after at least one await (the reuse health probe, the safety probe,
   *  the boot wait) — none of which `stop()` can cancel. Publishing here after
   *  a stop is not a cosmetic lie: it sets `ready:true`, RE-ARMS the runaway
   *  guard interval `stop()` just cleared, and through `laneWanted` (install())
   *  builds a BRAND-NEW live lane whose own `laneStopped` is false by
   *  construction — so the user's real OpenCode store is watched again, and
   *  fires `onExternal`, for a service they just disabled. Reproduced through
   *  the real wiring (install() + locator.start() + locator.stop()) with a
   *  busy serve, and again with a stop landing inside the boot probe. */
  async function adopt(port, pid, source, epoch) {
    if (cancelled(epoch)) return null;
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
    state.retryAfter = state.runawayUntil;
    state.lastError = `opencode serve (pid ${pid}) was STOPPED as a runaway: ${why}`;
    guard.prev = null; guard.hotSince = 0;
    const ch = state.child;
    state.child = null; state.client = null; state.port = null; state.pid = null;
    try { if (ch) ch.kill('SIGTERM'); else if (pid && pid !== process.pid) killPid(pid, 'SIGTERM'); } catch { }
    clearRecord({ port, pid });   // the serve we just stopped, named (round 9)
    log?.error?.(`[opencode-serve] RUNAWAY — ${state.lastError}. OpenCode boots an instance per session DIRECTORY and its file finder indexes + watches that whole tree; a session rooted at a huge directory burns the machine. Not restarting for ${Math.round(runawayCooldownMs / 60000)} min — disable the "OpenCode background service" plugin (⚙ → Plugins) if it recurs.`);
    try { telemetry?.({ name: 'opencode-serve-runaway', detail: `${why}${port ? ` port ${port}` : ''}`, value: Math.round(state.rssBytes / 1048576) }); } catch { }
    notify();
  }
  function onChildExit(child, code, signal, port) {
    if (state.child !== child) return;
    state.child = null; state.client = null; state.port = null; state.pid = null;
    // the record this child was spawned with, named (round 9): `state.port` is
    // still null while a child dies DURING its boot wait, so the port travels
    // from the spawn site instead — and naming it means a late exit event can
    // never delete a newer ladder's record.
    clearRecord({ port, pid: child.pid || null });
    if (state.stopping || state.parked) { notify(); return; } // a runaway/park already decided the outcome — never respawn on its own SIGTERM
    if (state.startedAt && Date.now() - state.startedAt >= HEALTHY_UPTIME_RESET_MS) state.crashes = 0;
    state.crashes++;
    state.lastError = `opencode serve exited (${signal || `code ${code}`})`;
    if (state.crashes >= maxCrashes) {
      state.parked = true; state.parkedKind = 'crash'; state.retryAfter = 0;   // terminal until an explicit start(): a crash park has NO deadline
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
  /** THE RECORD IS A PROMISE TO THE NEXT BOOT — so "we are about to overwrite
   *  it" has to be a DECISION (round 10). A recorded serve whose
   *  `/global/health` did not answer used to fall THROUGH this rung whenever
   *  its pid was alive: not killed, not cleared, not even logged — and the
   *  spawn below then rewrote data/opencode-serve.json with the new child,
   *  leaving a live `opencode serve` that NOTHING on disk names. No
   *  concurrency needed; it happened on every restart of a wedged serve.
   *  (Reproduced through install() + locator.start(): the recorded process
   *  still running, the record naming a different port, silence in the log.)
   *  Such an orphan keeps indexing and inotify-watching whatever it was
   *  working on, and neither the runaway guard — which samples OUR child — nor
   *  `stop({killRecorded})` — which reads the record — can ever reach it.
   *
   *  The outcomes, each one OWNED:
   *    'answered'  — one longer probe answered after all ⇒ the caller adopts it
   *                  (slow is not wedged: a cold 1.18.29 needs ~1.2s).
   *    'clear'     — the recorded serve is provably gone (dead pid, a recycled
   *                  pid, or we stopped it and SAW it exit) ⇒ the record is
   *                  deleted and the spawn may write its own.
   *    'keep'      — we are not going to spawn (no CLI / service off), so
   *                  nothing overwrites it and it still NAMES a live process.
   *    'blocked'   — something is alive that we could not identify or could not
   *                  stop ⇒ never signal it, never start a second serve over
   *                  it, and SAY SO (a park with an honest lastError, which is
   *                  the harness store reason the plugin card and the client
   *                  toast read).
   *    'cancelled' — a stop, or a newer ladder, owns this record now. */
  async function settleRecordedServe(rec, owned, probe, epoch, willSpawn) {
    const pid = Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : null;
    if (!pidAlive(pid)) { clearRecord(owned); return 'clear'; }
    if (!willSpawn) return 'keep';
    const v = classifyRecordedPid(rec, {
      pid, argv: readCmdline(pid), uid: readUid(pid),
      selfUid: typeof process.getuid === 'function' ? process.getuid() : null, selfPid: process.pid,
    });
    if (v.verdict === 'other') {
      log?.warn?.(`[opencode-serve] the recorded serve is gone (${v.why}) — clearing ${recordPath} and starting a fresh one`);
      clearRecord(owned);
      return 'clear';
    }
    if (v.verdict === 'unknown') {
      blockOnRecord(`a recorded \`opencode serve\` (pid ${pid}, port ${rec.port}) is alive but unresponsive and could not be verified — ${v.why}. VibeSpace will NOT start a second serve over it: stop that process, or delete ${recordPath}, then start the service again (it re-checks every ${Math.round(blockedRetryMs / 60000)} min).`);
      return 'blocked';
    }
    // 'ours' — and the classifier answers 'other' for THIS process, which is
    // the one pid that must never be signalled, so no self-kill is reachable here.
    if (await healthy(probe, confirmTimeoutMs)) return 'answered';
    if (cancelled(epoch)) return 'cancelled';
    log?.warn?.(`[opencode-serve] the recorded serve (pid ${pid}, port ${rec.port}) is ALIVE but answered no /global/health in ${DEFAULT_TIMEOUT_MS}+${confirmTimeoutMs}ms (${v.why}) — stopping it before starting a replacement`);
    try { killPid(pid, 'SIGTERM'); } catch (e) { log?.warn?.(`[opencode-serve] SIGTERM to pid ${pid} failed: ${e.message}`); }
    const gone = await waitForExit(pid, killWaitMs);
    // the wait is an await like every other one in this rung: a newer ladder
    // (or a stop) may own the record by now, and round 9's rule is that a
    // cancelled attempt does not touch it — the owner re-reads this pid itself
    if (cancelled(epoch)) return 'cancelled';
    if (!gone) {
      blockOnRecord(`the recorded \`opencode serve\` (pid ${pid}, port ${rec.port}) did not exit within ${killWaitMs}ms of SIGTERM and is STILL RUNNING. VibeSpace will NOT start a second serve over it: stop that process, or delete ${recordPath}, then start the service again (it re-checks every ${Math.round(blockedRetryMs / 60000)} min).`);
      return 'blocked';
    }
    clearRecord(owned);
    return 'clear';
  }
  async function waitForExit(pid, budgetMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs) { await wait(RECORD_KILL_POLL_MS); if (!pidAlive(pid)) return true; }
    return !pidAlive(pid);
  }
  /** A live serve we may neither adopt, identify nor stop is a BROKEN store,
   *  not an off one — so it PARKS (the only state `storeFailureReason` lets
   *  speak, 2026-09-07) with a sentence naming the pid, the port and the two
   *  things that fix it. It re-tries on its own cooldown because the state can
   *  heal without the user: the serve may answer again, or the process may exit. */
  function blockOnRecord(why) {
    state.parked = true; state.parkedKind = 'blocked'; state.retryAfter = now() + blockedRetryMs;
    state.lastError = why;
    log?.error?.(`[opencode-serve] ${why}`);
    try { telemetry?.({ name: 'opencode-serve-blocked', detail: why }); } catch { }
    notify();
  }
  async function locate() {
    if (state.client) return state.client;
    if (state.stopping) return null;
    // THIS attempt's cancellation token (round 8). Bumping it here as well as
    // in stop() means a ladder is cancelled BOTH by a stop and by a newer
    // ladder starting — so the Enable after a Disable cannot be served by the
    // run the Disable killed, and two ladders can never both reach adopt().
    const epoch = ++state.stopEpoch;
    if (state.parked) {
      // a runaway — and a 'blocked' record (round 10) — earns exactly one retry
      // per cooldown; a crash park stays terminal until an explicit start().
      // `retryAfter` is the ONE gate so a new retryable park cannot be added
      // without giving it a deadline (0 = never on its own).
      if (!state.retryAfter || now() < state.retryAfter) return null;
      const was = state.parkedKind;
      state.parked = false; state.parkedKind = null; state.crashes = 0; state.lastError = null; state.retryAfter = 0;
      log?.warn?.(`[opencode-serve] ${was === 'blocked' ? 'blocked-record' : 'runaway'} cooldown elapsed — trying \`opencode serve\` once more`);
    }
    if (Date.now() < state.backoffUntil) return null;
    const cmd = commandOf();
    // 1) reuse a recorded instance (a previous VibeSpace's child that outlived a SIGKILL restart)
    const rec = readRecord();
    // the serve's OWN empty directory (see ensureServeCwd): resolved before the
    // reuse probe so a recorded instance can be compared against it — but only
    // when it can be USED (a record to compare, or a spawn we are allowed to
    // make). A service nobody turned on creates nothing, not even a throwaway
    // git repo under data/.
    if (cmd && !state.cwd && (rec || autostartOn())) {
      try { const r = await ensureServeCwd(dataDir, { execImpl, log }); state.cwd = r.dir; state.cwdIsolated = r.isolated; }
      catch (e) { log?.warn?.(`[opencode-serve] isolated cwd unavailable (${e.message})`); }
      if (cancelled(epoch)) return null;   // `git init` is an await too: a disable landing in it used to reach the spawn below
    }
    if (rec) {
      const probe = mkClient(rec.port);
      // the ownership claim every clear in this rung makes: we may only delete
      // the record if it is still THIS one (round 9 — see clearRecord)
      const owned = { port: rec.port, pid: rec.pid || null };
      // A SILENT PROBE IS NOT A VERDICT ON THE PROCESS (round 10). The only
      // arm this rung owned was a DEAD pid; an ALIVE one fell THROUGH to the
      // spawn below, whose writeRecord then buried it. Everything that can
      // happen to a record we are about to overwrite is decided in ONE place
      // now (settleRecordedServe) — including 'keep', which falls through to
      // the spawn GATES below so they refuse with the honest "not installed" /
      // "service off" reason while the record keeps naming its live process
      // (that record is exactly what stop({killRecorded}) reads).
      let answered = await healthy(probe, DEFAULT_TIMEOUT_MS);
      if (!answered) {
        if (cancelled(epoch)) return null;
        const settled = await settleRecordedServe(rec, owned, probe, epoch, !!cmd && autostartOn());
        if (settled === 'blocked' || settled === 'cancelled') return null;
        answered = settled === 'answered';
      }
      if (answered) {
        // …and the probe itself is an await (a BUSY serve answers /global/health
        // in hundreds of ms). Checking here as well as in adopt() means a
        // disable never even evaluates the reuse verdict — it does not signal a
        // recorded pid we were about to replace, on behalf of a service that is
        // already being torn down by stop({killRecorded}).
        if (cancelled(epoch)) return null;
        // THE OPS KILL SWITCH IS AUTHORITATIVE OVER ADOPTION, not just over
        // spawning (2026-09-07 follow-up): this rung runs BEFORE the autostart
        // gate below, so VIBESPACE_OPENCODE_SERVE=0 used to stop us STARTING a
        // serve while happily adopting the one that outlived the last restart
        // — a third-party daemon indexing under an instance whose panel says
        // "forced OFF" and whose controls are disabled BECAUSE it is forced
        // off (no way left to stop it). "Off" means the process is gone.
        const bad = serveEnvOverride() === false
          ? 'VIBESPACE_OPENCODE_SERVE=0 is set on this instance — the ops kill switch stops an adopted serve too'
          : await unsafeReuseReason(probe, rec);
        if (!bad) return adopt(rec.port, rec.pid || null, 'reused', epoch);
        // …AND THE VERDICT IS AN AWAIT OF ITS OWN (round 9): `unsafeReuseReason`
        // probes `GET /project/current` on that same busy serve. Round 8 made
        // two ladders concurrent for the first time (`stop()` detaches the
        // in-flight one so the Enable starts its own), and this branch — the
        // only post-await site left without the check — then SIGTERMed a pid
        // and DELETED THE RECORD on a verdict about a serve the newer ladder
        // had already replaced. Measured: Disable at T, Enable at T+50 ms, the
        // stale ladder waking at T+1.4 s wiped the record the Enable's spawn
        // had just written — a live `opencode serve` the next boot can neither
        // adopt nor kill, the orphaned-daemon class this record exists for.
        if (cancelled(epoch)) return null;
        log?.warn?.(`[opencode-serve] replacing the recorded serve (pid ${rec.pid}, port ${rec.port}): ${bad}`);
        // never signal ourselves: a record can name this very process (a stale
        // pid reused after a reboot) and a self-SIGTERM would take the server down
        try { if (rec.pid && rec.pid !== process.pid) killPid(rec.pid, 'SIGTERM'); } catch { }
        clearRecord(owned);
      }
    }
    // 2) start one — only when the CLI is installed and autostart is allowed
    if (!cmd) { state.lastError = 'opencode CLI is not installed'; return null; }
    if (!autostartOn()) { state.lastError = serveEnvOverride() === false ? 'the OpenCode background service is forced OFF by VIBESPACE_OPENCODE_SERVE=0 on this instance' : 'the OpenCode background service is off — enable the "OpenCode background service" plugin (⚙ → Plugins) to start it'; return null; }
    const port = await freePort();
    if (cancelled(epoch)) return null;   // never START a third-party daemon for a service that was turned off mid-ladder
    let child;
    try {
      child = spawnImpl(cmd, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--log-level', 'WARN'], { cwd: state.cwd || cwd || os.homedir(), env: env(), stdio: 'ignore', detached: true });
    } catch (e) { state.lastError = `spawn failed: ${e.message}`; state.crashes++; if (state.crashes >= maxCrashes) { state.parked = true; state.parkedKind = 'crash'; state.retryAfter = 0; } notify(); return null; }
    if (typeof child.unref === 'function') child.unref();
    state.child = child; state.pid = child.pid || null; state.startedAt = Date.now();
    child.once('error', (e) => { state.lastError = `spawn failed: ${e.message}`; });
    child.on('exit', (code, signal) => onChildExit(child, code, signal, port));
    writeRecord({ port, pid: child.pid || null, startedAt: state.startedAt, command: cmd, cwd: state.cwd || cwd || null });
    const probe = mkClient(port);
    const t0 = Date.now();
    /** A boot we walk away from must not leave the child behind. `stop()` ran
     *  BEFORE this child existed, so it had nothing to kill and its
     *  `clearRecord()` came before our `writeRecord()` — the old `return null`
     *  left a live `opencode serve` plus a record the NEXT boot would adopt,
     *  for a service the user had just turned off. */
    const abandon = ({ why = null } = {}) => {
      // `why` only when WE decided AND the stop is still the current story: a
      // child that exited on its own already has onChildExit's honest
      // lastError (overwriting it would hide the crash), and a run cancelled by
      // a NEWER ladder must not write a complaint the new ladder is about to
      // contradict — it would surface on a healthy locator at the next notify.
      if (why) { state.lastError = `opencode serve was starting when ${why} — stopped it`; log?.warn?.(`[opencode-serve] ${state.lastError} (pid ${child.pid || '?'}, port ${port})`); }
      // A no-op on every path we have: `stop()` nulls `state.child` before this
      // runs, and a newer ladder owns a DIFFERENT child — which is exactly why
      // it must not null unconditionally (that would drop the live handle a
      // newer ladder just took). Kept so a future caller that abandons without
      // a preceding stop cannot leave a stale handle; the SIGTERM below and
      // this invariant are pinned by test-opencode-s9's abandon leg.
      if (state.child === child) { state.child = null; state.pid = null; }
      try { child.kill('SIGTERM'); } catch { }
      // never clear a record that names a DIFFERENT serve — and PORT ALONE
      // CANNOT SAY THAT (round 9): `freePort()` hands out a port that is free
      // right now, so the port this abandoned child was given is re-bindable
      // by the very ladder that cancelled it, and the old `r.port === port`
      // test would then delete the NEW ladder's record for the serve it is
      // actually talking to. The claim is {port, pid} — the pair writeRecord
      // wrote — so a recycled port with a different child fails it.
      clearRecord({ port, pid: child.pid || null });
      return null;
    };
    const cancelWhy = () => (state.stopping ? 'the background service was turned off' : null);
    while (Date.now() - t0 < bootTimeoutMs) {
      if (cancelled(epoch)) return abandon({ why: cancelWhy() });
      if (state.child !== child) return abandon();
      // the health probe is an await of its own (up to 1s per rung, over a
      // boot wait of up to 20s — the whole window in which a user watching
      // "starting…" gives up and clicks Disable)
      if (await healthy(probe, 1000)) {
        if (cancelled(epoch)) return abandon({ why: cancelWhy() });
        log?.log?.(`[opencode-serve] started pid ${child.pid} on 127.0.0.1:${port} (${Date.now() - t0}ms)`);
        return adopt(port, child.pid || null, 'spawned', epoch);
      }
      await wait(200);
    }
    state.lastError = `opencode serve did not answer on 127.0.0.1:${port} within ${bootTimeoutMs}ms`;
    log?.warn?.(`[opencode-serve] ${state.lastError} — killing it`);
    try { child.kill('SIGTERM'); } catch { }
    return null;
  }
  function ensure() {
    if (state.client) return Promise.resolve(state.client);
    if (!ensuring) {
      // the in-flight attempt is single-flight, but `stop()` DETACHES it (round
      // 8) — so this settle handler must only clear the slot it still owns, or
      // a cancelled ladder finishing late would drop the live one that replaced it
      const p = locate().catch((e) => { state.lastError = e.message; notify(); return null; }).finally(() => { if (ensuring === p) ensuring = null; });
      ensuring = p;
    }
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
    state.backoffUntil = 0; state.runawayUntil = 0; state.retryAfter = 0; state.lastError = null;
    notify();
    return ensure();
  }
  /** Stop the keeper. `killRecorded` = ALSO SIGTERM an instance we merely
   *  ADOPTED from data/opencode-serve.json (a previous VibeSpace's child).
   *  The process-exit path deliberately leaves an adopted instance alone (the
   *  next boot reuses it); a user turning the service OFF means STOP IT. */
  function stop({ killRecorded = false } = {}) {
    state.stopping = true;
    // CANCEL THE ATTEMPT, don't just raise a flag (round 8). `state.stopping` is
    // cleared again by the very next start(), so on its own it lets a Disable→
    // Enable pair be served by the ladder the Disable killed; the epoch makes
    // the cancellation terminal, and detaching `ensuring` makes the Enable's
    // ensure() start its OWN ladder instead of joining the cancelled one (which
    // now resolves null — an Enable that silently did nothing).
    state.stopEpoch++;
    ensuring = null;
    clearTimeout(respawnTimer); respawnTimer = null;
    if (guard.timer) { clearInterval(guard.timer); guard.timer = null; }
    const ch = state.child;
    const livePid = state.pid;
    state.child = null; state.client = null; state.port = null;
    // UNCONDITIONAL, deliberately (round 9): `stop()` is synchronous and bumps
    // the epoch FIRST, so no ladder can be interleaved with these lines, and
    // "the user turned the service off" outranks whatever is on disk — leaving
    // a record here is how "off" becomes "the next boot adopts it again".
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
function createFacts(locator, { now = Date.now, nameBatch = NAME_BATCH, listCacheMs = LIST_CACHE_MS, negativeCacheMs = NEGATIVE_CACHE_MS,
  externalWindowMs = EXTERNAL_WINDOW_MS, ownWriteWindowMs = OWN_WRITE_WINDOW_MS, onChange = null, log = console,
  heldPtyIds = null } = {}) {
  const cache = { list: null, at: 0, negativeUntil: 0, lastError: null, skippedWorktrees: [], dirty: true };
  const names = new Map();      // id → { name, at }
  const naming = new Set();
  const convo = new Map();      // id → { at, session, messages, records }
  let listing = null;
  // ── THE LIVE LANE (S9 remainder, B-eac2) — see armLive() ──
  const live = {
    lane: null,                 // the createLiveLane() handle, once armed
    statuses: new Map(),        // opencode session id → SessionStatus (this serve's own turns)
    questions: new Map(),       // que_id → {id, sessionID, questions, tool, at}
    lastUpdated: new Map(),     // opencode session id → the last `time.updated` we saw in a list
    activeElsewhere: new Map(), // opencode session id → ts of the last observed CHANGE we did not make
    ownWrites: new Map(),       // opencode session id → { at, updated } of a mutation WE made (see noteOwnWrite)
    ptys: new Set(),            // serve pty ids THIS process opened — the reaper's "ours", independent of session registration
    ptyOpening: 0,              // opens IN FLIGHT (the serve may already hold a pty whose id we do not know yet)
    ptyOpenSeq: 0,              // monotonic count of opens STARTED — the reaper compares it across its listing
    reapedFor: null,            // `${pid}:${port}:${startedAt}` of the serve we already swept (reapPtys runs once per serve process)
    // THE QUESTION MAP IS PER SERVE PROCESS (round 5). `/question` is answered
    // out of the serve's OWN memory, so a serve that restarted — a keeper
    // respawn, an OOM, a new port, an adopted instance replaced — has NO
    // pending asks at all while this warm map still holds every `que_…` the
    // PREVIOUS process minted. readConversation joins an open ask in the
    // transcript to this map and only re-reads the authoritative list when the
    // map is EMPTY, so a warm-but-dead map renders precisely the answerable
    // card whose Submit can only fail — the thing the `stale` marker exists to
    // prevent. So the map carries the serve process it was filled under, and a
    // map stamped for a DIFFERENT process is not "known", it is "unknown".
    questionsFor: null,         // `${pid}:${port}:${startedAt}` the question map was filled under (null = never / dropped)
  };
  /** The serve PROCESS a fact belongs to. Same key the pty reaper uses. */
  function serveKey() { const st = locator.state?.() || {}; return `${st.pid || 0}:${st.port || 0}:${st.startedAt || 0}`; }
  /** Is the warm question map still about the serve we are talking to? */
  function questionsWarm() { return live.questions.size > 0 && live.questionsFor === serveKey(); }
  /** A question fact arriving from the CURRENT serve (an event, a listing).
   *  Drops a map belonging to an older process first — stamping a stale map as
   *  current is how a dead `que_…` would become answerable again. */
  function questionEpoch() {
    const k = serveKey();
    if (live.questionsFor !== k) { live.questions.clear(); live.questionsFor = k; }
  }

  function reasonUnavailable() {
    const st = locator.state();
    if (!st.installed) return 'OpenCode is not installed on this machine (no `opencode` on PATH — install it or set OPENCODE_CMD)';
    // the runaway must SPEAK: the owner's instance burned for two hours with
    // nothing in the product saying so (2.369.42)
    if (st.parked && st.parkedKind === 'runaway') return `OpenCode serve was stopped by VibeSpace as a RUNAWAY — ${st.lastError || 'resource guard'}. It will not restart for up to an hour; disable the "OpenCode background service" plugin (⚙ → Plugins) if it keeps happening.`;
    // a BLOCKED record is not a crash loop: it names a process the user has to
    // deal with, and its own lastError is the whole instruction (round 10)
    if (st.parked && st.parkedKind === 'blocked') return st.lastError || 'a recorded `opencode serve` is alive but unreachable and could not be identified — stop that process, or delete data/opencode-serve.json, then start the service again';
    if (st.parked) return `OpenCode serve is parked after ${st.crashes} crashes (${st.lastError || 'unknown error'}) — start it again from ⚙ → Plugins → OpenCode background service`;
    if (st.autostart === false) return st.envForced === false
      ? 'the OpenCode background service is forced OFF by VIBESPACE_OPENCODE_SERVE=0 on this instance — stopped OpenCode conversations cannot be listed or opened'
      : 'the OpenCode background service is off — enable the "OpenCode background service" plugin (⚙ → Plugins) to list, open, resume and fork STOPPED OpenCode conversations';
    return `OpenCode serve is unreachable (${st.lastError || 'still starting'})`;
  }
  /** THE HONEST LIVENESS VERDICT (piece (f) of B-eac2).
   *   • 'live'     — one of OUR live sessions holds this conversation id.
   *   • 'external' — POSITIVE evidence that something else is driving it:
   *       (a) this serve's own `/session/status` says busy/retry (an event or
   *           a client of this serve is running the turn — in-process truth), or
   *       (b) the row's `time.updated` moved while we were not the ones moving
   *           it — "we" meaning BOTH a live session of ours and a user action
   *           taken through our own serve routes (noteOwnWrite; a roll-back is
   *           the user, not a stranger) — within externalWindowMs (a TUI or
   *           another opencode process writing the SAME sqlite — MEASURED: its events never reach our
   *           serve's event bus, but the store row it writes does reach our
   *           list, and the store-watch lane makes us re-read it in ~0.4s).
   *   • 'stopped'  — no evidence of anyone driving it. NEVER a fake 'running'.
   *  When we have NO live lane at all we cannot see (b) — the fact is reported
   *  in state().liveLane so the panel can say "liveness unknown" rather than
   *  every row lying; the rows themselves stay honest at 'stopped'. */
  function deriveStatus(s, active) {
    if (active) return 'live';
    const st = live.statuses.get(s.id);
    if (st && st.type && st.type !== 'idle') return 'external';
    const seen = live.activeElsewhere.get(s.id) || 0;
    if (seen && now() - seen < externalWindowMs) return 'external';
    return 'stopped';
  }
  function pendingQuestionsFor(sessionId) {
    if (!questionsWarm()) return [];      // a map minted by a serve that is gone answers nothing
    const out = [];
    for (const q of live.questions.values()) if (q.sessionID === sessionId) out.push(q);
    return out;
  }
  /** REMEMBER A MUTATION WE MADE (round 3 of the review: clicking "Roll back to
   *  before this message" made the row claim ANOTHER process was driving the
   *  conversation for 90s — dimmed card, "Running in unsupported terminal",
   *  no Fork… row, and gone entirely from a sidebar filtered to exclude
   *  'external'). Our own write through the serve moves `time.updated` exactly
   *  like a TUI's does; the only difference is that we know we did it, so we
   *  have to write it down.
   *
   *  `session` is the action's own response when it carries one. MEASURED on a
   *  real 1.18.29 serve: `revert`/`unrevert` return the row's FINAL
   *  `time.updated` and nothing bumps it afterwards, so we match by VALUE —
   *  the listing that reports exactly what we wrote is ours no matter how long
   *  it takes to arrive, and the very next move past it is somebody else's.
   *  An action with no Session (an answered ask) falls back to a short clock
   *  window, which is the only blind spot and is bounded by design. */
  function noteOwnWrite(id, session = null) {
    if (!id) return;
    const updated = Number(session?.time?.updated || session?.time?.created || 0) || 0;
    live.ownWrites.set(String(id), { at: now(), updated });
  }
  /** Does this listing row's `time.updated` describe a write of OURS?
   *  Consumes/expires the ledger entry so it can never linger. */
  function ownWriteVerdict(id, u, t) {
    const own = live.ownWrites.get(id);
    if (!own) return false;
    if (own.updated) {
      if (u === own.updated) { live.ownWrites.delete(id); return true; }        // confirmed: this row IS our write
      if (u < own.updated && t - own.at < ownWriteWindowMs) return true;        // a listing that was already in flight while we wrote
      live.ownWrites.delete(id);                                               // moved PAST our write ⇒ whoever did that, it was not us
      return false;
    }
    if (t - own.at < ownWriteWindowMs) return true;                            // no stamp (an answered ask): the short window
    live.ownWrites.delete(id);
    return false;
  }
  /** Fold a fresh listing into the external-activity ledger: a row whose
   *  `time.updated` MOVED since the previous listing changed under someone —
   *  us or another process. `ownIds` are the conversation ids our own live
   *  sessions hold, and `live.ownWrites` is the same fact for a conversation
   *  with NO live session that the user acted on through our own routes, so
   *  neither kind of own write ever masquerades as "external". */
  function noteListing(list, ownIds) {
    const t = now();
    for (const s of Array.isArray(list) ? list : []) {
      const u = s?.time?.updated || s?.time?.created || 0;
      const prev = live.lastUpdated.get(s.id);
      live.lastUpdated.set(s.id, u);
      const ours = ownWriteVerdict(s.id, u, t);
      if (prev === undefined) continue;                 // first sighting proves nothing
      if (u > prev && !ours && !(ownIds && ownIds.has(s.id))) live.activeElsewhere.set(s.id, t);
    }
    if (live.lastUpdated.size > 4000) live.lastUpdated.clear();
    // a write on a conversation that then vanished from the store would never
    // be consumed above: sweep by age so the ledger stays bounded
    if (live.ownWrites.size > 256) for (const [k, v] of live.ownWrites) if (t - v.at > ownWriteWindowMs) live.ownWrites.delete(k);
  }
  function assemble(list, activeSessions) {
    const activeById = new Map();
    for (const [id, s] of activeSessions || []) {
      if ((s?.backend || 'claude') !== 'opencode') continue;
      const sid = s.backendSessionId || null;
      if (sid && !activeById.has(sid)) activeById.set(sid, { id, session: s });
    }
    // fold the listing into the external-activity ledger BEFORE deriving
    // statuses (a row that just moved under a TUI must read 'external' on the
    // very tick that noticed it, not the next one)
    noteListing(list, new Set(activeById.keys()));
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
        status: deriveStatus(s, active),
        name: (named && named.name) || sessionTitle(s),
        agentKind: s.parentID ? 'subagent' : 'primary',
        parentThreadId: s.parentID || null,
        webuiId: active?.id || null,
        webuiName: active?.session?.name || null,
        webuiMode: active?.session?.mode || null,
        opencode: {
          slug: s.slug || null, agent: s.agent || null,
          model: modelLabel(s.model?.providerID, s.model?.id) || null,
          projectID: s.projectID || null,
          // the staged revert (chat action state) and the pending ask, so the
          // sidebar/chat never has to ask a second route for either
          revert: s.revert ? { messageID: s.revert.messageID || '', files: Array.isArray(s.revert.files) ? s.revert.files.length : 0 } : null,
          questions: pendingQuestionsFor(s.id).length || 0,
          busy: live.statuses.get(s.id)?.type || null,
        },
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
    cache.list = list; cache.at = now(); cache.lastError = null; cache.dirty = false;
    cache.skippedWorktrees = client.skippedWorktrees || [];
    nameSome(client, list).catch(() => { });
    return list;
  }
  /** Is a live event lane actually carrying signal right now? While it is, the
   *  list is refreshed ONLY when an event says it changed — the 10s timer is
   *  GONE, not slowed (piece (d) of B-eac2). A lane that is down (serve
   *  restarting, SSE broken, the store dir unwatchable) falls back to the
   *  timer STRUCTURALLY: a broken lane must not freeze the sidebar forever. */
  function laneHealthy() {
    const st = live.lane?.state?.();
    return !!(st && st.sse?.connected && st.watch?.active);
  }
  function markDirty(reason) {
    cache.dirty = true;
    cache.negativeUntil = 0;                 // a real change retires the negative cache
    try { onChange?.({ reason }); } catch { }
  }
  /** The v1 session list, cache-first and bounded. NEVER throws and NEVER waits
   *  past the budget: cache → negative cache → one shared bounded refresh. Both
   *  readers below are built on it, so neither can invent a second route (the
   *  v2 per-session routes boot an OpenCode instance per directory — 2.369.50).
   *  FRESHNESS is the lane's answer when the lane is up (B-eac2 piece (d)): only
   *  an event marks the list dirty, so the 10s timer is GONE — and a lane that
   *  is down falls back to it STRUCTURALLY. */
  async function listNow(budgetMs) {
    const t = now();
    const fresh = laneHealthy() ? (!cache.dirty || t - cache.at < MIN_REFRESH_MS) : (t - cache.at < listCacheMs);
    if (cache.list && fresh) return cache.list;
    if (t < cache.negativeUntil) return cache.list || [];
    if (!listing) listing = refreshList(budgetMs).finally(() => { listing = null; });
    try { await listing; }
    catch (e) {
      cache.negativeUntil = now() + negativeCacheMs;
      cache.lastError = e.message;
      if (isConnErr(e)) locator.invalidate(e.message);
    }
    return cache.list || [];
  }
  /** Session entries for the sidebar (the S3 discover member). */
  async function discover({ activeSessions = new Map(), budgetMs = DEFAULT_TIMEOUT_MS } = {}) {
    return assemble(await listNow(budgetMs), activeSessions);
  }
  /** RESUME CONTINUITY (B-6b6d r2): the model THIS conversation is on, as
   *  `provider/model` — the store hook behind opencode's `lastTurnModel`, so an
   *  OpenCode resume keeps its own model instead of taking
   *  `opencode.defaultModel` (which is a NEW-session default). OpenCode's own
   *  session record names it, so unlike claude this harness CAN answer.
   *  '' = we could not read it (serve off — it is opt-in and default OFF —
   *  parked, unreachable, or the session is gone); the ladder then falls back to
   *  the instance default and ws-create LOGS which rung it used. Never throws;
   *  v1 list only, shared cache, so a resume adds no route the sidebar poll
   *  does not already use. */
  async function sessionModel(id, { budgetMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!id) return '';
    const s = (await listNow(budgetMs)).find((x) => x && x.id === id);
    return s ? (modelLabel(s.model?.providerID, s.model?.id) || '') : '';
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
    const records = messagesToAcpRecords(Array.isArray(messages) ? messages : [], session);
    // A PENDING ask survives a page reload only if the card can be answered:
    // the transcript knows the tool CALL id, the live route wants the `que_…`
    // REQUEST id. Join them here, at the one place that has both.
    const open = records.filter((r) => r.kind === 'permission_request' && !r.resolved);
    if (open.length) {
      // the live lane keeps this map warm, but a server that just restarted
      // has an empty one — and one whose SERVE restarted has a map full of
      // `que_…` ids that process no longer knows (pendingQuestionsFor answers
      // [] for it, see the questionsFor epoch). Either way: re-read the
      // authoritative list ONCE rather than rendering a card whose Submit
      // could only fail.
      let pend = pendingQuestionsFor(id);
      if (!pend.length) { try { pend = await pendingQuestions({ sessionId: id, refresh: true }); } catch { pend = []; } }
      for (const r of open) {
        const q = pend.find((x) => x?.tool?.callID && x.tool.callID === r.requestId);
        if (q) r.requestId = String(q.id);
        else r.stale = true;              // no live request behind it: the reader shows it, the card cannot answer it
      }
    }
    const entry = { at: now(), session, messages: Array.isArray(messages) ? messages : [], records };
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
    // no noteOwnWrite here, and that is MEASURED rather than assumed: forking
    // does not move the SOURCE row's `time.updated` on 1.18.29 (before ===
    // after), and the fork's own row is a first sighting, which proves nothing
    // by construction. An unmeasured entry would only add a blind window.
    invalidate();
    return forked;
  }
  function invalidate() { cache.at = 0; cache.dirty = true; cache.negativeUntil = 0; convo.clear(); }

  // -- USER ACTIONS over the serve (LOUD by contract: every failure names the
  //    cause; a silent no-op here is the "no silent failures" law broken) --
  async function userClient(timeoutMs) {
    const client = await locator.client({ budgetMs: timeoutMs });
    if (!client) throw new OpencodeServeError(reasonUnavailable(), { code: 'unavailable' });
    return client;
  }
  /** Roll a conversation back to a message (piece (a)). The v1 route ONLY --
   *  measured to restore the tree without booting an instance, unlike v2's
   *  stage/clear/commit trio. Returns the updated Session (its `revert` field
   *  is the state the reader then renders). */
  async function revertTo(id, { messageID, partID = null, cwd = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    if (!messageID) throw new OpencodeServeError('revert needs the message to roll back to', { code: 'bad-request' });
    const client = await userClient(timeoutMs);
    let session;
    try { session = await client.revert(id, { messageID, partID, directory: cwd || null, timeoutMs }); }
    catch (e) { if (isConnErr(e)) locator.invalidate(e.message); throw new OpencodeServeError(`OpenCode could not roll back ${id}: ${e.message}`, { status: e.status, code: e.code, cause: e }); }
    noteOwnWrite(id, session);          // OUR write — never "someone else is driving it" (see noteOwnWrite)
    convo.delete(id); markDirty('revert');
    return session;
  }
  /** Undo a staged rollback (OpenCode's own `unrevert` = the v1 "clear"). */
  async function unrevert(id, { cwd = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const client = await userClient(timeoutMs);
    let session;
    try { session = await client.unrevert(id, { directory: cwd || null, timeoutMs }); }
    catch (e) { if (isConnErr(e)) locator.invalidate(e.message); throw new OpencodeServeError(`OpenCode could not restore the rolled-back messages of ${id}: ${e.message}`, { status: e.status, code: e.code, cause: e }); }
    noteOwnWrite(id, session);
    convo.delete(id); markDirty('unrevert');
    return session;
  }

  /** The pending asks (piece (b)). The live lane keeps this map warm from
   *  `question.asked/replied/rejected`; a caller with `refresh` re-reads the
   *  authoritative list (an attach after a page reload does exactly that, so
   *  a pending card survives the reload). */
  async function pendingQuestions({ sessionId = null, refresh = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (refresh) {
      const client = await userClient(timeoutMs);
      const list = await client.questions({ timeoutMs });
      live.questions.clear();
      // the list is authoritative FOR THIS SERVE PROCESS — stamp it, so the
      // next process's readers know this map is not about them
      live.questionsFor = serveKey();
      for (const q of Array.isArray(list) ? list : []) if (q && q.id) live.questions.set(String(q.id), { ...q, at: now() });
    }
    const all = questionsWarm() ? [...live.questions.values()] : [];
    return sessionId ? all.filter((q) => q.sessionID === sessionId) : all;
  }
  /** Answer an ask through the REAL route. `answers` is either OpenCode's own
   *  positional array-of-arrays, or the card's question-text map (converted
   *  here -- the conversion is PURE and lives with the shape it belongs to). */
  async function answerQuestion(requestId, answers, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    let q = questionsWarm() ? (live.questions.get(String(requestId)) || null) : null;
    // THE CARD'S MAP IS KEYED BY QUESTION TEXT, so converting it back to
    // OpenCode's positional form NEEDS the question list. A server that
    // restarted between rendering the card and the user pressing Submit has an
    // empty warm map, and converting against nothing produced `[]` → "no
    // answers", i.e. a dead Submit on a perfectly answerable ask. Re-read the
    // authoritative list once instead.
    // POSITIONAL answers need no conversion, but they DO need the same read:
    // the question is the only thing that names the conversation, and without
    // it we can neither invalidate that conversation's cache, nor tell the
    // clients WHICH row changed, nor write down that the move it is about to
    // make was OURS (round 3). `/question` boots no instance — measured.
    if (!q) {
      try { await pendingQuestions({ refresh: true, timeoutMs }); q = live.questions.get(String(requestId)) || null; } catch { }
    }
    const positional = Array.isArray(answers)
      ? answers.map((a) => (Array.isArray(a) ? a.map(String) : [String(a)]))
      : askAnswersToPositional(normalizeAskQuestions(q?.questions), answers || {});
    if (!positional.length) throw new OpencodeServeError(`no answers for question ${requestId}`, { code: 'bad-request' });
    const client = await userClient(timeoutMs);
    try { await client.questionReply(requestId, positional, { timeoutMs }); }
    catch (e) { if (isConnErr(e)) locator.invalidate(e.message); throw new OpencodeServeError(`OpenCode refused the answer to ${requestId}: ${e.message}`, { status: e.status, code: e.code, cause: e }); }
    live.questions.delete(String(requestId));
    // an answer moves the row (and starts a turn): the move is OURS. No Session
    // comes back here, so this is the windowed form of the ledger entry.
    if (q?.sessionID) { noteOwnWrite(q.sessionID); convo.delete(q.sessionID); }
    markDirty('question-replied');
    return { ok: true, sessionID: q?.sessionID || null, answers: positional };
  }
  async function rejectQuestion(requestId, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    let q = questionsWarm() ? (live.questions.get(String(requestId)) || null) : null;
    // same cold-map read as the reply path, for the same reason: a rejection
    // moves the row too, and only the question names the conversation
    if (!q) { try { await pendingQuestions({ refresh: true, timeoutMs }); q = live.questions.get(String(requestId)) || null; } catch { } }
    const client = await userClient(timeoutMs);
    try { await client.questionReject(requestId, { timeoutMs }); }
    catch (e) { if (isConnErr(e)) locator.invalidate(e.message); throw new OpencodeServeError(`OpenCode refused the rejection of ${requestId}: ${e.message}`, { status: e.status, code: e.code, cause: e }); }
    live.questions.delete(String(requestId));
    if (q?.sessionID) { noteOwnWrite(q.sessionID); convo.delete(q.sessionID); }
    markDirty('question-rejected');
    return { ok: true, sessionID: q?.sessionID || null };
  }

  /** A shell the SERVE owns, on the serve's machine (piece (c)). Returns
   *  everything the caller needs to bridge it onto the normal ws terminal
   *  path -- INCLUDING the ws url + auth header, which is why this value
   *  never leaves the server process.
   *
   *  `cwd` places the SHELL and nothing else: it rides the request BODY, never
   *  a `directory` query, so opening a terminal in a 200-directory repo boots
   *  NO OpenCode instance for that repo (round 4 — see the pty family in
   *  OpencodeServeClient for the /proc A/B: 204 inotify watches that outlived
   *  every close, vs 4). `cwd` stays in the signature because it is the shell's
   *  working directory and the op table carries it; it must never become a
   *  query again. */
  async function openPty({ cwd = null, command = null, args = null, title = null, env = null, timeoutMs = PTY_TIMEOUT_MS } = {}) {
    const client = await userClient(timeoutMs);
    let pty;
    // THE ONE WINDOW THE REAPER CANNOT REASON ABOUT is between "the serve made
    // the pty" and "we learned its id": a sweep listing right there would see a
    // terminal it cannot recognise as ours. So an open is ANNOUNCED before the
    // request and only un-announced after the id is recorded — reapPtys refuses
    // to sweep while one is in flight (see there) rather than racing it.
    live.ptyOpening++; live.ptyOpenSeq++;
    try {
      try { pty = await client.ptyCreate({ cwd, command, args, title, env, timeoutMs }); }
      catch (e) { if (isConnErr(e)) locator.invalidate(e.message); throw new OpencodeServeError(`OpenCode could not open a terminal${cwd ? ' in ' + cwd : ''}: ${e.message}`, { status: e.status, code: e.code, cause: e }); }
      if (!pty || typeof pty.id !== 'string') throw new OpencodeServeError('OpenCode returned no pty id', { code: 'protocol' });
      live.ptys.add(String(pty.id));
    } finally { live.ptyOpening--; }
    // A ticket is only mintable on a SECURED serve (1.18.29 answers
    // PtyForbiddenError on an unsecured one and the ws needs none) -- try, and
    // connect without it when the serve says no. The ticket never leaves here.
    let ticket = null;
    try { ticket = (await client.ptyTicket(pty.id, { timeoutMs: READ_TIMEOUT_MS }))?.ticket || null; } catch { ticket = null; }
    return { pty, url: client.ptyConnectUrl(pty.id, { ticket }), auth: client.authHeader(), ticketed: !!ticket };
  }
  /** `cwd` is accepted (the op table carries it) and deliberately UNUSED: a pty
   *  is addressed by its id on the default instance — see openPty. */
  async function closePty(ptyId, { cwd = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const client = await userClient(timeoutMs);
    try { await client.ptyRemove(ptyId, { timeoutMs }); } catch (e) { throw new OpencodeServeError(`OpenCode could not close terminal ${ptyId}: ${e.message}`, { status: e.status, code: e.code, cause: e }); }
    live.ptys.delete(String(ptyId));
    return { ok: true };
  }
  /** …same for `cwd` here. */
  async function resizePty(ptyId, { rows, cols, cwd = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const client = await locator.client({ budgetMs: timeoutMs });
    if (!client) return { ok: false };                 // a resize is not worth an error dialog
    try { await client.ptyResize(ptyId, { rows, cols, timeoutMs }); return { ok: true }; }
    catch { return { ok: false }; }
  }
  /** REAP THE PTYS NOBODY CAN REACH ANY MORE (round 4). The serve OUTLIVES us:
   *  a SIGKILL/OOM restart (or any restart while the serve was ADOPTED from
   *  data/opencode-serve.json, where `state.child` is null so our exit hook has
   *  nothing to kill) leaves every serve-owned shell running with no session,
   *  no socketPath (deliberately — a serve pty is not dtach-restorable) and no
   *  window able to reach it. Measured: a pty survives our websocket closing
   *  and is re-connectable; it only disappears when its own shell exits or the
   *  serve dies.
   *
   *  So this is the adopt-or-reap ladder the dtach/job paths already use, on
   *  the ONE moment it is answerable: a serve became reachable. KEEP =
   *  everything this process opened (`live.ptys`) UNION everything a live
   *  session still holds (`heldPtyIds()` reads session._opencodePtyId — the
   *  field's consumer). Everything else on the serve is unreachable by
   *  construction and is removed.
   *  Runs ONCE per serve PROCESS (pid+port+startedAt): a respawned serve has no
   *  ptys to reap, and re-running on every state notify would race a terminal
   *  the user is opening. */
  async function reapPtys({ timeoutMs = READ_TIMEOUT_MS, force = false, attempts = 3, settleMs = 1500 } = {}) {
    const client = await locator.client({ budgetMs: timeoutMs });
    if (!client) return { ok: false, reason: reasonUnavailable() };
    const st = locator.state?.() || {};
    const key = `${st.pid || 0}:${st.port || 0}:${st.startedAt || 0}`;
    if (!force && live.reapedFor === key) return { ok: true, skipped: 'already-reaped', key };
    // A SWEEP IS ONLY ANSWERABLE WHILE NOBODY IS OPENING A TERMINAL. Between
    // the serve creating a pty and openPty recording its id, that pty is in the
    // serve's list and in no keep set — so instead of racing it, refuse and
    // retry: quiet BEFORE the listing, and the same open-count AFTER it, means
    // no create was issued during the window. Never marked done on a refusal,
    // so the next ready edge (or an explicit call) tries again.
    let list = null, busy = null;
    for (let i = 0; i < Math.max(1, attempts) && list === null; i++) {
      if (i) await new Promise((r) => { const t = setTimeout(r, settleMs); t.unref?.(); });
      if (live.ptyOpening > 0) { busy = 'a terminal is being opened'; continue; }
      const seq0 = live.ptyOpenSeq;
      let got;
      try { got = await client.ptyList({ timeoutMs }); }
      catch (e) { return { ok: false, reason: e.message }; }   // NOT marked done: a failed sweep retries on the next ready edge
      if (live.ptyOpening > 0 || live.ptyOpenSeq !== seq0) { busy = 'a terminal was opened while listing'; continue; }
      list = got;
    }
    if (list === null) return { ok: false, reason: busy || 'could not take a quiet listing' };
    live.reapedFor = key;
    let held = [];
    try { held = heldPtyIds ? (heldPtyIds() || []) : []; } catch { held = []; }
    const keep = new Set([...live.ptys, ...held].map((x) => String(x)));
    const removed = [], failed = [];
    for (const p of Array.isArray(list) ? list : []) {
      const id = p && typeof p.id === 'string' ? p.id : '';
      if (!id || keep.has(id)) continue;
      try { await client.ptyRemove(id, { timeoutMs }); removed.push(id); }
      catch (e) { failed.push({ id, reason: e.message }); }
    }
    if (removed.length) log?.warn?.(`[opencode-serve] reaped ${removed.length} orphaned serve terminal(s) no session can reach: ${removed.join(', ')}`);
    return { ok: true, key, removed, failed, kept: [...keep] };
  }
  /** The agent's own todo list for a conversation (cheap v1 route). */
  async function todos(id, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const client = await userClient(timeoutMs);
    return client.todo(id, { timeoutMs });
  }
  /** This serve's in-process busy map (piece (f) rung 1). */
  async function statusMap({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const client = await userClient(timeoutMs);
    const map = await client.sessionStatus({ timeoutMs });
    live.statuses.clear();
    for (const [k, v] of Object.entries(map || {})) live.statuses.set(String(k), v);
    return map || {};
  }

  /** DROP AND RE-READ THE PENDING ASKS (round 5). A (re)connect is the one
   *  moment we know we may have missed `question.asked/replied/rejected`
   *  frames AND the one moment the serve on the other end may be a DIFFERENT
   *  process than the one that minted the ids in the warm map. `/question` is
   *  per process (its answer comes out of the serve's own memory) and boots no
   *  instance — measured — so the reconnect pays for one cheap read, exactly
   *  like the busy map above.
   *  DROP FIRST, then read: a failed read must leave "unknown" (⇒ open ask
   *  cards render `stale`, which is honest and answerable-by-nobody) rather
   *  than "known" from a serve that no longer exists (⇒ a Submit that can only
   *  fail — the dead Submit the `stale` marker was built for). */
  function refreshQuestions(why) {
    const had = live.questions.size;
    live.questions.clear();
    live.questionsFor = null;             // UNKNOWN until the authoritative list answers
    return pendingQuestions({ refresh: true })
      .catch((e) => { log?.warn?.(`[opencode-serve] the pending-ask list could not be re-read after ${why} (${e.message}) — open ask cards render stale until it answers`); return []; })
      .then(() => { if (had || live.questions.size) markDirty('questions'); });
  }

  /** ARM THE LIVE LANE (piece (d)). `makeLane` is injected so these facts
   *  never hard-depend on the event module's IO inside a unit test. */
  function armLive(makeLane) {
    if (live.lane) return live.lane;
    live.lane = makeLane({
      locator,
      onEvent: (info) => {
        // A (RE)CONNECT IS THE ONLY MOMENT WE KNOW WE MISSED EVENTS. The busy
        // map is fed by `session.status` frames, so a serve that was already
        // running a turn when the stream came up would read 'stopped' until
        // its NEXT status change — the honest-liveness rung 1 silently blind
        // for the length of a turn. `/session/status` is the authoritative
        // answer, needs no directory and boots no instance (measured), so the
        // reconnect pays for one cheap read.
        if (info.kind === 'connected') { statusMap().catch(() => { }); refreshQuestions('a reconnect').catch(() => { }); }
        if (info.kind === 'status' && info.sessionId) {
          if (info.status && info.status.type && info.status.type !== 'idle') live.statuses.set(info.sessionId, info.status);
          else live.statuses.delete(info.sessionId);
          markDirty('status');
          return;
        }
        if (info.kind === 'question') {
          questionEpoch();                 // a fact from the CURRENT serve; a map from an older one is dropped, never inherited
          if (info.question) live.questions.set(String(info.questionId), { ...info.question, at: now() });
          else live.questions.delete(String(info.questionId));
          if (info.sessionId) convo.delete(info.sessionId);
          markDirty('question');
          return;
        }
        if (info.dirty?.conversation) convo.delete(info.dirty.conversation);
        if (info.dirty?.sessions || info.dirty?.conversation) markDirty(info.kind);
      },
      // the STORE-WATCH lane: another opencode process (a TUI) wrote the
      // sqlite. We do not know WHAT changed -- only that the list must be
      // re-read, which is exactly what dirty means.
      onExternal: (reason) => { convo.clear(); markDirty(reason || 'store'); },
      onState: () => { try { onChange?.({ reason: 'lane' }); } catch { } },
      log,
    });
    return live.lane;
  }
  function stopLive() { try { live.lane?.stop?.(); } catch { } live.lane = null; }

  function stateOf() {
    const laneSt = live.lane?.state?.() || null;
    return { ...locator.state(), cachedSessions: cache.list ? cache.list.length : null, cacheAgeMs: cache.at ? now() - cache.at : null, negativeUntil: cache.negativeUntil, lastError: cache.lastError || locator.state().lastError, namesKnown: names.size, skippedWorktrees: cache.skippedWorktrees || [],
      liveLane: laneSt, liveLaneHealthy: laneHealthy(), pendingQuestions: questionsWarm() ? live.questions.size : 0, busySessions: live.statuses.size, dirty: !!cache.dirty };
  }
  return { discover, sessionModel, readConversation, forkSession, invalidate, state: stateOf, reasonUnavailable, locator, _names: names,
    revertTo, unrevert, pendingQuestions, answerQuestion, rejectQuestion, openPty, closePty, resizePty, reapPtys, todos, statusMap,
    armLive, stopLive, _live: live };
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
  sessionModel: async () => '',   // no serve ⇒ no answer; the ladder logs the fall back to the instance default
  readConversation: async (id) => { throw new OpencodeServeError(`OpenCode serve is not configured on this instance (conversation ${id})`, { code: 'unconfigured' }); },
  forkSession: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  invalidate: () => { },
  state: () => ({ installed: false, ready: false, parked: false, caps: null, configured: false, autostart: false, envForced: null, stopped: true, liveLane: null, liveLaneHealthy: false, pendingQuestions: 0, busySessions: 0 }),
  reasonUnavailable: () => 'OpenCode serve is not configured on this instance',
  locator: null,
  // the S9-remainder action surface: UNCONFIGURED must say so, never no-op
  // (the "no silent failures" law -- a user action that quietly does nothing
  // is the worst possible answer)
  revertTo: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  unrevert: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  pendingQuestions: async () => [],
  answerQuestion: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  rejectQuestion: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  openPty: async () => { throw new OpencodeServeError('OpenCode serve is not configured on this instance', { code: 'unconfigured' }); },
  closePty: async () => ({ ok: false }),
  resizePty: async () => ({ ok: false }),
  reapPtys: async () => ({ ok: false, reason: 'OpenCode serve is not configured on this instance' }),
  todos: async () => [],
  statusMap: async () => ({}),
  armLive: () => null,
  stopLive: () => { },
});
/** Wire the locator + facts for this process. Called ONCE by cli-env (ORCH);
 *  tests call it with a mock spawn/fetch. Returns the facts. */
function install(opts) {
  // FOLLOW THE SERVE (see the lane block below): the locator's own state
  // callback is the only place that knows "a serve is now reachable on port
  // N". Wrapping it HERE — before the locator exists — is what makes the hook
  // real; the caller's onState still runs first and unchanged.
  const laneRef = { lane: null, lastPort: null, facts: null, sync: () => { } };
  const locatorOpts = opts.locator ? opts : {
    ...opts,
    onState: (st) => {
      try { opts.onState?.(st); } catch (e) { (opts.log || console).warn?.(`[opencode-serve] onState failed: ${e.message}`); }
      // THE LANE LIVES AND DIES WITH THE SERVICE (round 5, see below): every
      // locator state change — the plugin's start/stop, an adoption, a park —
      // is where it is started or torn down.
      laneRef.sync(st);
      const port = st && st.ready ? (st.port || null) : null;
      if (!port) { laneRef.lastPort = null; return; }
      if (port === laneRef.lastPort) return;      // NOT every notify(): the guard samples one a minute
      laneRef.lastPort = port;
      try { laneRef.lane?.kick(); } catch { }
      // …and the SAME edge is the adopt-or-reap moment (round 4): "a serve is
      // reachable" is the only instant at which "which of its terminals can
      // still be reached from here" is answerable. Idempotent per serve
      // process; off the caller's stack so a slow sweep never delays a notify.
      const rt = setImmediate(() => {
        Promise.resolve(laneRef.facts?.reapPtys?.()).catch((e) => (opts.log || console).warn?.(`[opencode-serve] pty reap failed: ${e.message}`));
      });
      rt.unref?.();
    },
  };
  const locator = opts.locator || createServeLocator(locatorOpts);
  installed = createFacts(locator, opts);
  laneRef.facts = installed;
  // THE LIVE LANE replaces the 10s list poll (piece (d) of B-eac2). It is armed
  // here, not lazily at the first discovery, because its whole job is to notice
  // changes NOBODY asked about; `makeLane` is injectable so a unit test can arm
  // a fake one, and `false` disables it entirely (the timer fallback returns).
  //
  // BUT IT ONLY RUNS WHILE THE SERVICE DOES (round 5). The lane is a CLIENT of
  // the serve: `start()` arms an fs.watch on the USER's real OpenCode store
  // (resolved from the env THIS server runs under) plus an SSE reconnect loop
  // with its own timers. With the background service OFF — the shipped default
  // since 2026-09-07, where the rule is that NOTHING of ours runs or watches —
  // install() started it anyway at boot, so an unrelated `opencode` process's
  // writes to ~/.local/share/opencode woke a server whose OpenCode feature the
  // user never turned on. So the lane follows ONE predicate:
  //   • the SAME decision the locator spawns on (opts.autostart =
  //     decideAutostart: the ops override, else the plugin record), OR
  //   • a serve is actually READY — which covers the one case that decision
  //     does not: a RECORDED instance we merely ADOPT (allowed with the plugin
  //     off, and once we are talking to it, following it costs nothing new).
  // Enabling the plugin flips the decision AND notifies (locator.start()), so
  // the lane comes up without a restart; disabling stops the process and the
  // lane with it — SSE socket, backoff timer and store watch.
  const wantsAutostart = () => { try { const a = opts.autostart; return a === undefined ? true : !!(typeof a === 'function' ? a() : a); } catch { return false; } };
  const laneWanted = (st) => { try { return !!(st && st.ready) || wantsAutostart(); } catch { return false; } };
  if (opts.live !== false) {
    const makeLane = opts.makeLane || ((deps) => require('./opencode-events').createLiveLane({ ...deps, storeDirs: opts.storeDirs }));
    laneRef.sync = (st) => {
      // a notify arriving after uninstall() (or after a second install) must
      // never re-arm a lane on facts nobody is using any more
      if (installed !== laneRef.facts) return;
      let known = st;
      if (!known) { try { known = locator.state?.(); } catch { known = null; } }
      const want = laneWanted(known);
      if (want === !!laneRef.lane) return;
      if (want) {
        try {
          const lane = laneRef.facts.armLive(makeLane);
          lane.start();
          // FOLLOW THE SERVE. The stream backs off to 30s while there is
          // nothing to connect to (the keeper is respawning), so "the serve
          // came back on a NEW port" would otherwise take up to half a minute
          // to become live again. The locator already tells us: kick on the
          // READY EDGE (and on a port change) — never on every notify(), which
          // fires each guard sample and would re-open the socket once a minute
          // for nothing.
          laneRef.lane = lane;
        } catch (e) { (opts.log || console).warn?.(`[opencode-serve] live lane could not start: ${e.message} -- falling back to the timed list refresh`); }
      } else {
        laneRef.lane = null; laneRef.lastPort = null;
        try { laneRef.facts.stopLive(); } catch { }
      }
    };
    laneRef.sync(null);           // sync reads the locator itself, inside its own guard
  }
  // …and enforce the ops kill switch AT BOOT rather than at the first
  // discovery: with VIBESPACE_OPENCODE_SERVE=0 a serve that outlived a restart
  // must be STOPPED, and an instance nobody is polling (no client connected)
  // would otherwise leave it indexing for as long as the server runs. This is
  // ONE run of the SAME ladder — locate() drops a recorded instance under the
  // override and refuses to spawn — never a second implementation. Off the
  // boot path (setImmediate + unref) so a hung serve cannot delay startup.
  if (serveEnvOverride() === false && locator?.ensure) {
    const t = setImmediate(() => { Promise.resolve(locator.ensure()).catch(() => { }); });
    t.unref?.();
  }
  return installed;
}
function facts() { return installed || NULL_FACTS; }
function uninstall() { const f = installed; installed = null; try { f?.stopLive?.(); } catch { } try { f?.locator?.stop?.(); } catch { } }

module.exports = {
  OpencodeServeClient, OpencodeServeError, createServeLocator, createFacts, OpencodeServeSessionMessages,
  messagesToAcpRecords, acpKindOfTool, acpStatusOfState, sessionTitle, install, facts, uninstall,
  bootstrappableWorktree, unsafeWorktreeReason, ensureServeCwd, serveCwdPath, readProcUsage,
  classifyRecordedPid, readProcCmdline, readProcUid, RECORD_CONFIRM_TIMEOUT_MS, RECORD_KILL_WAIT_MS, BLOCKED_RETRY_MS,
  normalizeAskQuestions, askAnswerMap, askAnswersToPositional, revertNoticeText, EXTERNAL_WINDOW_MS, OWN_WRITE_WINDOW_MS,
  serveEnvOverride, decideAutostart, SERVICE_PLUGIN_ID: 'opencode-serve',
  DEFAULT_TIMEOUT_MS, READ_TIMEOUT_MS, LIST_CACHE_MS, NEGATIVE_CACHE_MS, MAX_CRASHES, FORK_PATH,
  NAME_MAX_BYTES, GUARD_CPU_PCT, GUARD_RSS_BYTES, GUARD_SAMPLE_MS, RUNAWAY_COOLDOWN_MS, MIN_REFRESH_MS, PTY_TIMEOUT_MS,
};
