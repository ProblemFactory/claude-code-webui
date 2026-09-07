/**
 * Session store — JSONL parsing, caching, SessionMessages class,
 * session discovery helpers (path recovery, tmux, PID checks).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const { extractTailIds, nameFromUserRecord } = require('./discovery-facts');
const { readJsonlBounded } = require('./adapters/codex');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// ── Helpers ──

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cwdToProjectDir(cwd) {
  return cwd.replace(/[/._]/g, '-');
}

function recoverCwdFromProjDir(projDir) {
  const parts = projDir.replace(/^-/, '').split('-');
  let current = '/';
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const segment = parts.slice(i, j).join('-');
      if (fs.existsSync(path.join(current, segment))) {
        current = path.join(current, segment); i = j - 1; found = true; break;
      }
      if (fs.existsSync(path.join(current, '.' + segment))) {
        current = path.join(current, '.' + segment); i = j - 1; found = true; break;
      }
      const underscored = parts.slice(i, j).join('_');
      if (underscored !== segment && fs.existsSync(path.join(current, underscored))) {
        current = path.join(current, underscored); i = j - 1; found = true; break;
      }
    }
    if (!found) {
      current = path.join(current, parts.slice(i).join('-'));
      break;
    }
  }
  return current;
}

function getTmuxPaneMap() {
  const map = new Map();
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid}||#{session_name}:#{window_index}.#{pane_index}'], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    for (const line of out.split('\n')) {
      const [pid, target] = line.split('||');
      if (pid && target) map.set(parseInt(pid), target);
    }
  } catch {}
  return map;
}

function findTmuxTarget(pid, paneMap) {
  if (paneMap.has(pid)) return paneMap.get(pid);
  try {
    const ppid = parseInt(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8', timeout: 2000 }).trim());
    if (paneMap.has(ppid)) return paneMap.get(ppid);
  } catch {}
  return null;
}

// The SYNC `isProcessClaude` is GONE (B-3185 r4). Its one caller was
// /api/kill-pid's local branch — a SIGTERM gate — and a kill decision belongs
// to THE identity (src/cli-identity.js), which that route now asks for both CLI
// names, like its own remote branch's shell twin. Only the async twin below
// survives, and only where it never kills anything.

// ── ASYNC discovery helpers (2.242.0) ──
// The /api/sessions sweep ran these as execFileSync — a live V8 profile on the
// busiest fleet pod caught a single sweep blocking the event loop 5.1s (22
// live sessions × sequential pgrep + tmux + per-lock ps; each sync fork is
// 100-300ms under load and pgrep's 2s timeout × N bounded the worst sweeps at
// tens of seconds — the 8-33s "whole instance freezes while I work" class).
// Same commands, async + parallelizable; sync variants stay for boot paths.
function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, { encoding: 'utf-8', ...opts }, (err, stdout) => resolve(err ? null : String(stdout || ''))); }
    catch { resolve(null); }
  });
}

async function getTmuxPaneMapAsync() {
  const map = new Map();
  const out = await execFileP('tmux', ['list-panes', '-a', '-F', '#{pane_pid}||#{session_name}:#{window_index}.#{pane_index}'], { timeout: 3000 });
  for (const line of String(out || '').trim().split('\n')) {
    const [pid, target] = line.split('||');
    if (pid && target) map.set(parseInt(pid), target);
  }
  return map;
}

async function findTmuxTargetAsync(pid, paneMap) {
  if (paneMap.has(pid)) return paneMap.get(pid);
  const out = await execFileP('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 2000 });
  const ppid = parseInt(String(out || '').trim());
  if (paneMap.has(ppid)) return paneMap.get(ppid);
  return null;
}

// THE LAST `comm` IDENTITY, AND ITS REAL BLAST RADIUS (B-3185 r4 — r3 recorded
// this twin with the wrong one). Exactly ONE caller: `isLockClaude` below, as
// the fallback taken when a claude lock file carries no NUMERIC `procStart`
// (macOS locks write `procStartFt`) or /proc could not be read — which feeds
// the discovery sweep's "does this lock still have a live owner?" question and
// nothing else. It decides whether a CARD READS RUNNING. It is NOT on any kill
// path any more (the /api/kill-pid gate that used its sync twin now asks
// src/cli-identity.js) — a card it credits wrongly does hand that pid to the
// sidebar's Terminate, but the ROUTE re-asks THE identity and refuses, which is
// the whole point of gating the kill where the kill happens rather than
// trusting the label that led there. It must not become one either: `ps -o
// comm=` is 15 bytes
// of a name the process may set for itself (node renames its main thread to
// `MainThread` — measured — so an npm-installed `node …/claude-code/cli.js`
// answers NO here), matched as a SUBSTRING (so `claude-keeper` answers YES).
// Both errors are survivable for a label and neither is survivable for a
// SIGTERM. It is kept rather than ported because on the path that reaches it
// (macOS, every lock) `isCliProcess` is SYNCHRONOUS — a per-lock blocking fork
// is the 2.242.0 event-loop stall this whole async family exists to avoid — and
// on Linux `procStart` answers first with a pure file read. scripts/
// test-local-discovery-device.mjs compares the two rungs on a live fixture.
async function isProcessClaudeAsync(pid) {
  const out = await execFileP('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000 });
  const cmd = String(out || '').trim();
  return cmd === 'claude' || cmd.includes('claude');
}

// /proc/<pid>/stat field 22 (starttime, clock ticks since boot). Verified
// byte-equal to the claude lock's `procStart` across 6/6 real locks (2.248.x).
function procStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // comm may contain spaces/parens — start after the LAST ')' (skips
    // "pid (comm) "), so rest[0] = state (field 3); starttime is field 22 →
    // index 22-3 = 19.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const v = rest[19];
    return v ? String(v) : null;
  } catch { return null; }
}

// B-2104: identity-verify a lock's pid WITHOUT a per-lock `ps` fork — the
// 2.242.0 event-loop stall was 22 locks × serial `ps`. claude's own lock
// carries `procStart` (= /proc/<pid>/stat field 22); matching it proves the
// alive pid is the SAME process the lock was written for (defeats PID reuse),
// which is exactly what the `ps comm=claude` check established. GOTCHA: only
// LINUX locks carry `procStart` — macOS writes the string `procStartFt`
// (`ps -o lstart=`), so an absent numeric procStart is NOT a mismatch; it
// falls back to the `ps` fork (never a silent always-true guard).
async function isLockClaude(lock) {
  const pid = lock?.pid;
  if (!pid) return false;
  const want = lock.procStart != null ? String(lock.procStart) : null;
  if (want) {
    const have = procStartTicks(pid);
    if (have != null) return have === want; // pure file read, no fork
    // /proc unreadable (non-Linux, or raced exit) → fall through to ps
  }
  return isProcessClaudeAsync(pid);
}

// ── Lock → JSONL claiming (discovery) ──
// "Newest JSONL in the lock's project dir" misattributes files when SEVERAL
// sessions run in parallel in ONE cwd — mtime order among concurrent writers is
// arbitrary (real incident: 4 parallel external sessions read as 5 running;
// killing one flagged the WRONG session id stopped, and resuming that id
// collided with a still-running process). The lock file carries the CURRENT
// sessionId and every JSONL RECORD carries a sessionId field; after --resume
// the FILENAME keeps the original id but recent records carry the current one.
// So: claim by exact id first, tail-scan second, mtime-recency last.

// Last `bytes` of a JSONL as the sessionIds seen in it, in occurrence order
// (last element = the file's current writer). null = unreadable.
function readJsonlTailIds(fp, bytes = 65536) {
  let fd = null;
  try {
    fd = fs.openSync(fp, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    if (!len) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf-8');
    if (len < size) { // line-align: drop the partial first line
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    // ONE tail-id rule (discovery-facts, 2.278.0): uniq-collapsed runs,
    // last 8 — the semantics the ssh script and daemon snapshot always had;
    // the full-list local variant gave claimJsonls a different mention window.
    return extractTailIds(text);
  } catch { return null; } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Match alive locks to JSONL files within ONE project dir. Pure — testable
 * without live processes; shared by local (/api/sessions) and remote
 * (hosts.discoverSessions) discovery.
 *
 * @param locks  [{ sessionId: string|null, exactOnly: bool, ...caller fields }]
 *               exactOnly (webui-tracked ids) never fall through to tail/mtime.
 * @param jsonls [{ id: filename-id, mtime, ...caller fields }] any order
 * @param tailIdsFor (jsonl) => [sessionIds in tail, occurrence order] | null
 * @returns Map<jsonlId, lock> — each JSONL claimed by at most one lock.
 *
 * Passes:
 *  1. exact — the lock's current sessionId IS a JSONL filename (non-resumed).
 *  2. tail  — a resumed session writes records carrying its CURRENT id into the
 *             ORIGINAL-named file; prefer the file whose LAST tail id is the
 *             lock's (its current writer) over a mere mention.
 *  3. mtime — locks with no id evidence (brand-new session that hasn't flushed
 *             a record yet, unreadable tail, old lock without sessionId) take
 *             the newest unclaimed JSONL among files with NO tail evidence
 *             (empty file / unreadable / no tail data). Files whose tail names
 *             some OTHER (dead) session are NEVER fallback-claimed — they are a
 *             stopped session's transcript, and stealing one is the bug above
 *             (the unmatched lock is instead listed by its own sessionId).
 * Tail reads only happen when the dir is ambiguous — single-lock-single-jsonl
 * short-circuits without touching the file (the overwhelmingly common case).
 */
function claimJsonls(locks, jsonls, tailIdsFor) {
  const claims = new Map(); // jsonl id -> lock
  const sorted = [...jsonls].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const byId = new Map(sorted.map(j => [j.id, j]));
  const claimedIds = new Set();
  const unmatched = [];

  // Pass 1 — exact filename match.
  for (const lock of locks) {
    const want = lock.sessionId;
    if (want && byId.has(want) && !claimedIds.has(want)) {
      claims.set(want, lock);
      claimedIds.add(want);
    } else if (!lock.exactOnly) {
      unmatched.push(lock);
    }
  }
  if (!unmatched.length) return claims;

  const unclaimed = () => sorted.filter(j => !claimedIds.has(j.id));

  // Short-circuit — unambiguous dir: one lock, one JSONL, no tail read.
  if (locks.length === 1 && jsonls.length === 1) {
    const j = unclaimed()[0];
    if (j) claims.set(j.id, unmatched[0]);
    return claims;
  }

  // Pass 2 — tail match (bounded: newest candidates only).
  const TAIL_CANDIDATES_MAX = 30;
  const tails = new Map(); // jsonl id -> [ids] | null
  for (const j of unclaimed().slice(0, TAIL_CANDIDATES_MAX)) {
    let ids = null;
    try { ids = tailIdsFor ? tailIdsFor(j) : null; } catch {}
    tails.set(j.id, Array.isArray(ids) ? ids : null);
  }
  const stillUnmatched = [];
  for (const lock of unmatched) {
    if (!lock.sessionId) { stillUnmatched.push(lock); continue; }
    let best = null, bestScore = 0;
    for (const j of unclaimed()) {
      const ids = tails.get(j.id);
      if (!ids || !ids.length) continue;
      const at = ids.lastIndexOf(lock.sessionId);
      if (at < 0) continue;
      const score = at === ids.length - 1 ? 2 : 1; // current writer beats mention
      if (score > bestScore) { best = j; bestScore = score; }
    }
    if (best) { claims.set(best.id, lock); claimedIds.add(best.id); }
    else stillUnmatched.push(lock);
  }

  // Pass 3 — mtime fallback over NO-EVIDENCE files only. A file whose tail
  // names some other (dead) session is a stopped session's transcript — never
  // hand it to an unrelated lock; the caller lists leftover locks by their own
  // sessionId instead.
  if (stillUnmatched.length) {
    const order = unclaimed().filter(j => !(tails.get(j.id) || []).length); // mtime-desc
    for (const lock of stillUnmatched) {
      const j = order.shift();
      if (!j) break;
      claims.set(j.id, lock);
      claimedIds.add(j.id);
    }
  }
  return claims;
}

// ── JSONL helpers ──

const { parseBackgroundLaunch } = require('./message-manager.js');

function isSubagentMessage(msg) { return !!(msg.parent_tool_use_id || msg.isSidechain); }

function isDisplayMessage(msg) {
  return msg.type === 'user' || msg.type === 'assistant' || msg.type === 'result' || (msg.type === 'system' && msg.subtype === 'init');
}

function findSessionJsonlPath(claudeSessionId, cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const projDir = cwdToProjectDir(cwd || '');
  const candidates = [];
  if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId + '.jsonl'));
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, claudeSessionId + '.jsonl');
      if (!candidates.includes(fp)) candidates.push(fp);
    }
  } catch {}
  // Remote-host transcripts fetched over ssh (hosts.fetchSessionJsonl) land in
  // data/remote-jsonl/<hostId>/<id>.jsonl — session ids are UUIDs, so scanning
  // the cache here makes every history consumer remote-capable for free.
  try {
    const cacheRoot = path.join(__dirname, '..', 'data', 'remote-jsonl');
    for (const hostDir of fs.readdirSync(cacheRoot)) {
      candidates.push(path.join(cacheRoot, hostDir, claudeSessionId + '.jsonl'));
    }
  } catch {}
  for (const fp of candidates) {
    try { if (fs.existsSync(fp)) return fp; } catch {}
  }
  return null;
}

// JSONL parse cache — stores ALL non-subagent messages (unfiltered).
// LRU-bounded: it retains the FULL parsed history of each session, so an
// uncapped map slowly pins every session ever viewed in memory.
const _jsonlCache = new Map();
const JSONL_CACHE_MAX = 30;

// Async warm (2.235.0): populate _jsonlCache OFF the main thread via the
// transcript worker, so the sync parseSessionJsonl below (unchanged, many sync
// callers) hits a warm cache instead of blocking the loop for the 0.5-1s a
// 32MB tail parse costs. Await this at the HOT entry points (ws attach
// history rebuild, /api/session-messages) before the sync machinery runs.
async function warmSessionJsonlAsync(claudeSessionId, cwd) {
  try {
    const fp = findSessionJsonlPath(claudeSessionId, cwd);
    if (!fp) return false;
    const stat = fs.statSync(fp);
    const cached = _jsonlCache.get(claudeSessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return true; // already warm
    const { readJsonlBoundedParsedAsync } = require('./adapters/codex');
    const records = await readJsonlBoundedParsedAsync(fp, { tailOnly: true, dropSubagent: true });
    if (!records) return false; // worker unavailable — sync path will parse inline
    _jsonlCache.delete(claudeSessionId);
    _jsonlCache.set(claudeSessionId, { mtimeMs: stat.mtimeMs, size: stat.size, messages: records });
    while (_jsonlCache.size > JSONL_CACHE_MAX) _jsonlCache.delete(_jsonlCache.keys().next().value);
    return true;
  } catch { return false; }
}

function parseSessionJsonl(claudeSessionId, cwd) {
  const fp = findSessionJsonlPath(claudeSessionId, cwd);
  if (!fp) return [];
  try {
    const stat = fs.statSync(fp);
    const cached = _jsonlCache.get(claudeSessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // refresh LRU position
      _jsonlCache.delete(claudeSessionId);
      _jsonlCache.set(claudeSessionId, cached);
      return cached.messages;
    }

    // Bounded read: a full readFileSync('utf-8') THROWS past Node's ~512MB
    // string limit (and blocks the event loop for hundreds of MB below it).
    // Tail-only: the client seek-loads the earlier history as a continuous
    // virtual scroll, so no seam marker is stitched in.
    const _t0 = Date.now();
    const content = readJsonlBounded(fp, { tailOnly: true });
    const messages = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (!isSubagentMessage(msg)) messages.push(msg);
      } catch {}
    }
    // Slow-parse observation (>200ms — a big tail re-read). global hook keeps
    // this module decoupled from the telemetry instance living in server.js.
    const _dt = Date.now() - _t0;
    if (_dt > 200) global.__vsMetric?.('srv-jsonl-parse-ms', _dt);
    _jsonlCache.delete(claudeSessionId);
    _jsonlCache.set(claudeSessionId, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
    while (_jsonlCache.size > JSONL_CACHE_MAX) {
      _jsonlCache.delete(_jsonlCache.keys().next().value);
    }
    return messages;
  } catch { return []; }
}

// Session metadata cache (cwd + first user message)
const _sessionMetaCache = new Map();

function extractSessionMeta(filePath) {
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const cached = _sessionMetaCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  } catch {}

  let cwd = '', name = '';
  try {
    // Stream in 64KB chunks with a leftover-line buffer until both cwd + name
    // are found (cap at 2MB). A fixed 32KB read truncated the meta whenever an
    // early line carried a large attachment (>32KB) — the line JSON.parse threw
    // and `cwd` stayed empty, so the session became silently un-resumable
    // (wrong/empty cwd → resume no-ops). (issue #18)
    const fd = fs.openSync(filePath, 'r');
    try {
      const CHUNK = 65536;
      const MAX_BYTES = 2 * 1024 * 1024;
      const chunk = Buffer.alloc(CHUNK);
      let leftover = '', pos = 0;
      while (pos < MAX_BYTES) {
        const bytesRead = fs.readSync(fd, chunk, 0, CHUNK, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const lines = (leftover + chunk.toString('utf-8', 0, bytesRead)).split('\n');
        leftover = lines.pop() || ''; // last (possibly partial) line carries over
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (!cwd && d.cwd) cwd = d.cwd;
            if (d.type === 'user' && !name) {
              // ONE naming rule for every machine (discovery-facts, 2.278.0):
              // first non-empty line of the first REAL user message — the
              // remote parser used to whitespace-collapse the WHOLE message,
              // so one session could carry two names depending on where it ran.
              const cand = nameFromUserRecord(d);
              if (cand) name = cand;
            }
          } catch {}
        }
        if (cwd && name) break;
      }
    } finally { fs.closeSync(fd); }
  } catch {}

  const meta = { cwd, name };
  try {
    _sessionMetaCache.set(filePath, { mtimeMs: fs.statSync(filePath).mtimeMs, meta });
    if (_sessionMetaCache.size > 8192) _sessionMetaCache.delete(_sessionMetaCache.keys().next().value);
  } catch {}
  return meta;
}

function getSubagentMetas(claudeSessionId, cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const projDir = cwdToProjectDir(cwd || '');
  const candidates = [];
  if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId, 'subagents'));
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, claudeSessionId, 'subagents');
      if (!candidates.includes(fp)) candidates.push(fp);
    }
  } catch {}
  for (const subDir of candidates) {
    try {
      if (!fs.existsSync(subDir)) continue;
      const metas = [];
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.meta.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf-8'));
          const agentId = f.replace('agent-', '').replace('.meta.json', '');
          metas.push({ agentId, description: meta.description || '', agentType: meta.agentType || '' });
        } catch {}
      }
      return metas;
    } catch {}
  }
  return [];
}

// ── Full-file task-tool event scan (2.180.1, real report: a long-completed
// task showed as in_progress in Steps forever) ──
// Two cooperating failure modes: (a) the tail-only display window can MISS a
// task's completing TaskUpdate entirely; (b) COMPACTION re-appends the
// retained records (with their ORIGINAL timestamps and uuids) after the whole
// history — so a task's create/in_progress get replayed while its completed
// update (summarized away) does not, and even a full FILE-ORDER apply ends on
// the stale replay. Fix: stream the WHOLE file once (substring pre-filter,
// byte-safe line splitting, incremental byte cursor so a live session only
// scans appended bytes) with uuid dedup (kills replay copies), and let the
// caller apply events in TIMESTAMP order.
const _taskEventCache = new Map(); // fp → {offset, carry, seq, pending, events, uuids}
function scanTaskEventsFull(fp) {
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  let c = _taskEventCache.get(fp);
  if (!c || st.size < c.offset) c = { offset: 0, carry: Buffer.alloc(0), seq: 0, pending: new Map(), events: [], uuids: new Set() };
  _taskEventCache.set(fp, c);
  if (st.size === c.offset) return c.events;
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return c.events; }
  try {
    const CH = 16 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CH);
    while (c.offset < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH, st.size - c.offset), c.offset);
      if (n <= 0) break;
      c.offset += n;
      // byte-safe line assembly: never toString across an arbitrary slab edge
      // (a split multi-byte char corrupts the boundary line — the CJK/byte-
      // offset lesson from usage-history)
      const data = c.carry.length ? Buffer.concat([c.carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const cut = data.lastIndexOf(0x0a);
      if (cut === -1) { c.carry = Buffer.from(data); continue; }
      c.carry = Buffer.from(data.subarray(cut + 1));
      for (const line of data.toString('utf-8', 0, cut).split('\n')) {
        if (!line.includes('"TaskCreate"') && !line.includes('"TaskUpdate"') && !line.includes('"TodoWrite"') && !line.includes('Task #')) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.uuid) {
          if (c.uuids.has(rec.uuid)) continue; // compaction replay copy
          c.uuids.add(rec.uuid);
        }
        const content = rec.message?.content;
        if (!Array.isArray(content)) continue;
        const ts = Date.parse(rec.timestamp || '') || 0;
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (rec.type === 'assistant' && b.type === 'tool_use') {
            if (b.name === 'TodoWrite' && b.input?.todos) c.events.push({ kind: 'todos', todos: b.input.todos, ts, seq: c.seq++ });
            else if (b.name === 'TaskCreate') c.pending.set(b.id, b.input || {});
            else if (b.name === 'TaskUpdate' && b.input?.taskId) c.events.push({ kind: 'update', input: b.input, ts, seq: c.seq++ });
          } else if (rec.type === 'user' && b.type === 'tool_result' && c.pending.has(b.tool_use_id)) {
            const inp = c.pending.get(b.tool_use_id);
            c.pending.delete(b.tool_use_id);
            const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '');
            const m = /Task #(\d+) created/.exec(txt);
            if (m) c.events.push({ kind: 'create', id: m[1], subject: inp.subject || '', activeForm: inp.activeForm, ts, seq: c.seq++ });
          }
        }
      }
    }
  } finally { try { fs.closeSync(fd); } catch { } }
  return c.events;
}

function getHistorySessionId(session) {
  return session?.backendSessionId || session?.claudeSessionId || null;
}

// ── SessionMessages class ──

class SessionMessages {
  constructor(session, sessionId, { buffersDir, permissionModes } = {}) {
    this._session = session;
    this._sessionId = sessionId;
    this._buffersDir = buffersDir;
    this._permissionModes = permissionModes || [];
    this._all = null;
    this._display = null;
    this._pendingPerms = null;
    this._wrapperMeta = undefined;
    this._taskState = undefined;
  }

  _ensureParsed() {
    if (this._all) return;
    const session = this._session;
    const historySessionId = getHistorySessionId(session);
    const jsonl = historySessionId ? parseSessionJsonl(historySessionId, session.cwd) : [];
    const uuids = new Set();
    const msgIds = new Set();
    for (const m of jsonl) {
      if (m.uuid) uuids.add(m.uuid);
      // Streaming stdout events can carry a PLACEHOLDER uuid (…-000000000001)
      // while the JSONL record for the SAME message has the real one — uuid
      // dedup misses those and the stale buffer copy would render pinned after
      // the entire history. message.id (msg_…) is stable across both copies.
      const mid = m.message?.id;
      if (mid) msgIds.add(mid);
    }

    this._pendingPerms = {};
    // Surviving buffer records are INTERLEAVED at their true chronological
    // position (right after the JSONL record their buffer-neighborhood dedups
    // against) instead of all appended at the end. Stream-json stdout-only
    // records (result/init/control_*) never dedup — appended at the end, an
    // EARLIER turn's `result` replayed AFTER a still-running tool_use and the
    // normalizer flushed the live pending tool card to ✗ Interrupted on every
    // server restart (real user report); end-append also scrambled turn
    // boundaries in the replay. The buffer is chronological, so the index of
    // the last JSONL-matched record is a correct position anchor.
    const jsonlPos = new Map(); // 'u:<uuid>' | 'm:<message.id>' → jsonl index
    jsonl.forEach((m, i) => {
      if (m.uuid) jsonlPos.set('u:' + m.uuid, i);
      const mid = m.message?.id;
      if (mid && !jsonlPos.has('m:' + mid)) jsonlPos.set('m:' + mid, i);
    });
    const parsed = [];
    for (const line of (session.buffer || '').split('\n')) {
      const trimmed = line.replace(/\r/g, '').trim();
      if (!trimmed) continue;
      try { parsed.push(JSON.parse(trimmed)); } catch {}
    }
    // A ROTATED buffer can start with unmatched stdout-only records from mid-
    // history; anchor those just before the first matched record (not at the
    // very start) — much closer to their true position.
    let firstHit = -1;
    for (const msg of parsed) {
      const hitU = msg.uuid != null ? jsonlPos.get('u:' + msg.uuid) : undefined;
      const hit = hitU !== undefined ? hitU : (msg.message?.id ? jsonlPos.get('m:' + msg.message.id) : undefined);
      if (hit !== undefined) { firstHit = hit; break; }
    }
    let anchor = firstHit >= 0 ? firstHit - 1 : jsonl.length - 1;
    const inserts = new Map(); // jsonl index (-1 = before all) → [records]
    let anyInsert = false;
    for (const msg of parsed) {
      if (msg.type === 'control_request' && msg.request?.tool_use_id) { this._pendingPerms[msg.request.tool_use_id] = msg; }
      const hitU = msg.uuid != null ? jsonlPos.get('u:' + msg.uuid) : undefined;
      const hit = hitU !== undefined ? hitU : (msg.message?.id ? jsonlPos.get('m:' + msg.message.id) : undefined);
      if (hit !== undefined) { if (hit > anchor) anchor = hit; continue; } // in JSONL — advances the position cursor
      const isControl = msg.type === 'control_request' || msg.type === 'control_response' || msg.type === 'control_cancel_request';
      if (!isControl) {
        if (isSubagentMessage(msg)) continue;
        if (msg._fromWebui && msg.timestamp) {
          if (jsonl.some(m => m.type === 'user' && m.timestamp >= msg.timestamp)) continue;
        }
      }
      const list = inserts.get(anchor) || inserts.set(anchor, []).get(anchor);
      list.push(msg);
      anyInsert = true;
    }
    if (!anyInsert) this._all = jsonl;
    else {
      const all = [...(inserts.get(-1) || [])];
      for (let i = 0; i < jsonl.length; i++) {
        all.push(jsonl[i]);
        const ins = inserts.get(i);
        if (ins) all.push(...ins);
      }
      this._all = all;
    }
    this._display = this._all.filter(isDisplayMessage);
  }

  get total() { this._ensureParsed(); return this._display.length; }
  get pendingPermissions() { this._ensureParsed(); return this._pendingPerms; }

  get isStreaming() {
    const wMeta = this.wrapperMeta();
    if (wMeta?.streaming != null) return wMeta.streaming;
    return false;
  }

  tail(n = 50) { this._ensureParsed(); return this._display.slice(-n); }
  slice(offset, limit) { this._ensureParsed(); return this._display.slice(offset, offset + limit); }
  all() { this._ensureParsed(); return this._display; }
  raw() { this._ensureParsed(); return this._all; }

  search(query) {
    this._ensureParsed();
    const q = query.toLowerCase();
    const matches = [];
    for (let i = 0; i < this._display.length; i++) {
      const m = this._display[i];
      const c = m.message?.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.map(b => b.text || '').join(' ');
      if (text.toLowerCase().includes(q)) matches.push({ index: i, type: m.type, preview: text.substring(0, 120) });
    }
    return matches;
  }

  chatStatus() {
    this._ensureParsed();
    const msgs = this._all;
    let lastUsage = null, model = null, contextWindow = 0, totalCost = 0, slashCommands = null, permissionMode = null;
    let assistantModel = null;
    // Scan depth: the tail of _all can be dominated by hundreds of surviving
    // buffer records (stdout-only system/hook events that never dedup against
    // the JSONL) — a 200-record window missed every assistant usage record and
    // the status bar lost its context% on refresh. 2000 covers the spam.
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 2000); i--) {
      const m = msgs[i];
      if (!lastUsage && m.type === 'assistant' && m.message?.usage) lastUsage = m.message.usage;
      // result/init records are stream-json stdout-only — they NEVER appear in
      // the JSONL, so for stopped/resumed sessions (no buffer) the assistant
      // record's message.model is the only model source available
      if (!assistantModel && m.type === 'assistant' && m.message?.model && !String(m.message.model).startsWith('<')) assistantModel = m.message.model;
      if (!model && m.type === 'result' && m.modelUsage) { model = Object.keys(m.modelUsage)[0]; contextWindow = Object.values(m.modelUsage)[0]?.contextWindow || 0; }
      if (lastUsage && model && assistantModel) break;
    }
    if (!model) model = assistantModel;
    for (let i = 0; i < Math.min(msgs.length, 5); i++) {
      const m = msgs[i];
      if (m.type === 'system' && m.subtype === 'init') {
        if (m.slash_commands) slashCommands = m.slash_commands;
        if (!model && m.model) model = m.model;
        if (m.permissionMode) permissionMode = m.permissionMode;
        break;
      }
    }
    // contextWindow comes from result.modelUsage (stdout-only). When restoring
    // from JSONL the only sound DEDUCTION is: observed usage beyond the 200k
    // window proves the 1M beta. Anything else stays 0 = unknown — the UI shows
    // "?" rather than a guessed default (a wrong 200k on a 1M session made the
    // context % lie by 5x).
    if (!contextWindow && lastUsage) {
      const used = (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0);
      if (used > 190000) contextWindow = 1000000;
    }
    for (const m of msgs) { if (m.type === 'result' && m.total_cost_usd) totalCost += m.total_cost_usd; }
    if (!lastUsage && !model) return null;
    return {
      model, lastUsage, contextWindow, total_cost_usd: totalCost, slashCommands, permissionMode,
      permissionModes: this._permissionModes,
      subagentMetas: getSubagentMetas(getHistorySessionId(this._session), this._session.cwd),
    };
  }

  activePendingPermissions() {
    this._ensureParsed();
    const resolved = new Set();
    // Scan ALL records for tool_results, not a tail window — a session that
    // kept running after answering pushes the tool_result out of any fixed
    // window and the stale control_request re-injects an awaiting-approval
    // overlay on every attach (real report: an answered AskUserQuestion
    // questionnaire resurrected after each server restart). Same class as
    // the chatStatus 200→2000 scan-depth bug.
    // Answered request_ids: the chat-wrapper appends control_response stdin
    // lines to its buffer (2.220.0), so an APPROVED permission whose tool is
    // STILL RUNNING at restart (no tool_result yet) resolves here instead of
    // resurrecting the Allow/Deny overlay on every attach.
    const answered = new Set();
    for (const m of this._all) {
      if (m.type === 'control_response') {
        const rid = m.response?.request_id;
        if (rid) answered.add(rid);
        continue;
      }
      if (m.type !== 'user') continue;
      const c = m.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) { if (b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id); }
    }
    const result = {};
    for (const [id, cr] of Object.entries(this._pendingPerms)) {
      if (resolved.has(id)) continue;
      if (cr.request_id && answered.has(cr.request_id)) continue;
      result[id] = cr;
    }
    return result;
  }

  wrapperMeta() {
    if (this._wrapperMeta === undefined) {
      if (this._sessionId && this._buffersDir) {
        try { this._wrapperMeta = JSON.parse(fs.readFileSync(path.join(this._buffersDir, this._sessionId + '.json'), 'utf-8')); }
        catch { this._wrapperMeta = null; }
      } else {
        this._wrapperMeta = null;
      }
    }
    return this._wrapperMeta;
  }

  taskState() {
    if (this._taskState !== undefined) return this._taskState;
    const wMeta = this.wrapperMeta();
    if (wMeta?.tasks || wMeta?.todos) {
      const base = { tasks: wMeta.tasks || {}, todos: wMeta.todos || [] };
      // An EMPTY todos array in wrapper meta must not short-circuit the scan —
      // the newer TaskCreate/TaskUpdate family only exists in the transcript.
      if (base.todos.length) { this._taskState = base; return base; }
      const scanned = this._scanTaskState();
      // MERGE, never fallback (the two-shape-payload law): the wrapper's map
      // is live truth for ITS OWN tasks only — one live entry used to hide
      // the entire history-synthesized set (2.368.31, seen as a 41→1 flap).
      this._taskState = { tasks: { ...scanned.tasks, ...base.tasks }, todos: scanned.todos };
      return this._taskState;
    }
    this._taskState = this._scanTaskState();
    return this._taskState;
  }

  _scanTaskState() {
    this._ensureParsed();
    const tasks = {};
    const todos = [];
    // Newer task-tool family (TaskCreate/TaskUpdate, CLI ≥2.1.2xx): CRUD by id
    // — replay into a list. The created id only appears in the RESULT text
    // ("Task #N created successfully: …").
    const pendingCreates = new Map(); // tool_use_id → input
    const taskList = new Map(); // taskId → {content, activeForm, status}
    // Prefer the FULL-FILE event scan applied in TIMESTAMP order — the tail
    // window misses old completions, and compaction replays stale records
    // AFTER them (see scanTaskEventsFull). Falls back to the in-window walk
    // when the transcript path can't be resolved.
    let fullApplied = false;
    try {
      const hid = getHistorySessionId(this._session);
      const fp = hid ? findSessionJsonlPath(hid, this._session?.cwd) : null;
      const events = fp ? scanTaskEventsFull(fp) : null;
      if (events) {
        fullApplied = true;
        let lastTodoTs = -1, lastTaskTs = -1;
        for (const ev of [...events].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))) {
          if (ev.kind === 'todos') { todos.length = 0; todos.push(...ev.todos); lastTodoTs = ev.ts; }
          else if (ev.kind === 'create') { if (!taskList.has(ev.id)) taskList.set(ev.id, { content: ev.subject, activeForm: ev.activeForm, status: 'pending' }); lastTaskTs = ev.ts; }
          else if (ev.kind === 'update') {
            lastTaskTs = ev.ts;
            const key = String(ev.input.taskId);
            if (ev.input.status === 'deleted') taskList.delete(key);
            else {
              const cur = taskList.get(key) || { content: '', status: 'pending' };
              if (ev.input.subject) cur.content = ev.input.subject;
              if (ev.input.activeForm) cur.activeForm = ev.input.activeForm;
              if (ev.input.status) cur.status = ev.input.status;
              taskList.set(key, cur);
            }
          }
        }
        // The LATEST-used family wins. The old tail-window scan expressed this
        // as "TodoWrite present in the window"; over the FULL history that
        // reads as "TodoWrite EVER used" and an ancient TodoWrite snapshot
        // shadowed the current task list (caught on the first real transcript).
        if (taskList.size && lastTaskTs >= lastTodoTs) todos.length = 0;
      }
    } catch { /* fall through to the in-window walk */ }
    // Launch-ack synthesis (2.368.30, shared parser with the normalizer):
    // the system task_* subtypes below are live-stream-only and never appear
    // in a persisted transcript — without this, taskState.tasks was EMPTY
    // after every restart and the status bar showed nothing.
    const launchUses = new Map(); // tool_use_id → { name, input }
    for (const msg of this._all) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) {
          if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Workflow' || b.name === 'Bash')) launchUses.set(b.id, { name: b.name, input: b.input });
        }
      }
      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) {
          if (b?.type !== 'tool_result' || !launchUses.has(b.tool_use_id) || tasks[b.tool_use_id]) continue;
          const lu = launchUses.get(b.tool_use_id);
          const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((c) => c?.text || '').join(' ') : '');
          const syn = parseBackgroundLaunch(lu.name, lu.input, txt);
          if (syn) {
            // supersede an earlier launch of the SAME task id (workflow resume)
            if (syn.id) for (const tk of Object.values(tasks)) { if (tk.id === syn.id && tk.status === 'running') tk.status = 'completed'; }
            tasks[b.tool_use_id] = { ...syn, status: 'running', _launchTs: Date.parse(msg.timestamp || '') || 0 };
          }
        }
      }
      // the notification rides THREE transports (2.368.31): idle-wake user
      // record, mid-turn queue-operation records, queued_command attachment
      const notifC = (msg.type === 'user' && typeof msg.message?.content === 'string') ? msg.message.content
        : (msg.type === 'queue-operation' && typeof msg.content === 'string') ? msg.content
        : (msg.type === 'attachment' && typeof msg.attachment?.prompt === 'string') ? msg.attachment.prompt : '';
      if (notifC.includes('<task-notification>')) {
        const c = notifC;
        const tu = c.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/)?.[1]?.trim();
        if (tu && tasks[tu] && tasks[tu].status === 'running') {
          tasks[tu].status = (c.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || 'completed').toLowerCase();
          const sm = c.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
          if (sm) tasks[tu].summary = sm.slice(0, 200);
        }
      }
      if (msg.type === 'system' && msg.tool_use_id) {
        if (msg.subtype === 'task_started') {
          tasks[msg.tool_use_id] = { id: msg.task_id, type: msg.task_type === 'local_agent' ? 'agent' : 'command', description: msg.description || '', status: 'running' };
        } else if (msg.subtype === 'task_progress' && tasks[msg.tool_use_id]) {
          if (msg.description) tasks[msg.tool_use_id].description = msg.description;
          if (msg.last_tool_name) tasks[msg.tool_use_id].lastTool = msg.last_tool_name;
        } else if (msg.subtype === 'task_notification' && tasks[msg.tool_use_id]) {
          tasks[msg.tool_use_id].status = 'completed';
        }
      }
      if (!fullApplied && msg.type === 'assistant' && msg.message?.content) {
        const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
        for (const b of blocks) {
          if (b.type !== 'tool_use') continue;
          if (b.name === 'TodoWrite' && b.input?.todos) {
            todos.length = 0;
            todos.push(...b.input.todos);
          } else if (b.name === 'TaskCreate') {
            pendingCreates.set(b.id, b.input || {});
          } else if (b.name === 'TaskUpdate' && b.input?.taskId) {
            const key = String(b.input.taskId);
            if (b.input.status === 'deleted') taskList.delete(key);
            else {
              const cur = taskList.get(key) || { content: '', status: 'pending' };
              if (b.input.subject) cur.content = b.input.subject;
              if (b.input.activeForm) cur.activeForm = b.input.activeForm;
              if (b.input.status) cur.status = b.input.status;
              taskList.set(key, cur);
            }
          }
        }
      }
      if (!fullApplied && msg.type === 'user' && Array.isArray(msg.message?.content) && pendingCreates.size) {
        for (const b of msg.message.content) {
          if (b?.type !== 'tool_result' || !pendingCreates.has(b.tool_use_id)) continue;
          const inp = pendingCreates.get(b.tool_use_id);
          pendingCreates.delete(b.tool_use_id);
          const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((c) => c?.text || '').join(' ') : '');
          const m = /Task #(\d+) created/.exec(txt);
          if (m) taskList.set(m[1], { content: inp.subject || '', activeForm: inp.activeForm, status: 'pending' });
        }
      }
    }
    // A background OS task cannot outlive the CLI process (its /tmp task dir
    // dies with it) — a synthesized 'running' whose launch predates the
    // CURRENT wrapper start is a phantom (the field transcript showed 16
    // forever-'running' watchers from previous wrapper lives). Workflow runs
    // are in-process too. Keep unknown-timestamp entries (never guess dead).
    const wStart = Number(this.wrapperMeta()?.startedAt) || 0;
    if (wStart) {
      for (const [tuid, tk] of Object.entries(tasks)) {
        if (tk.status === 'running' && tk._launchTs && tk._launchTs < wStart) delete tasks[tuid];
      }
    }
    for (const tk of Object.values(tasks)) delete tk._launchTs;
    // Prefer the newer task-tool list when TodoWrite wasn't used.
    if (!todos.length && taskList.size) {
      todos.push(...[...taskList.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v));
    }
    return { tasks, todos };
  }
}

// Dedup surviving webui dtach sockets by conversation (userW's local
// double-writer class, real owner report). A plain `claude --resume`
// REUSES the conversation id, so resuming a session whose claude had already
// died (the live-guard sees no live session to block) mints a SECOND dtach
// session for the SAME claudeSessionId. Two surviving sockets → two sidebar
// cards and — if both claude are alive — two writers on ONE JSONL. On restore
// keep ONE socket per conversation and retire the rest. Winner precedence:
// alive-claude beats dead, then newest createdAt (that's the current writer).
//   entries: [{ sockFile, backend, host, claudeSessionId, createdAt, claudeAlive }]
//   → { winners: Map(key -> sockFile), retire: Set(sockFile) }
// Sessions with no claudeSessionId yet are never duplicates (each is distinct).
// ── THE claude session sweep (S3, docs/design-harness-plugins.md §2.4):
// moved VERBATIM out of routes/sessions.js so the claude harness descriptor's
// `store.discover` owns it and the route only iterates harnesses + merges.
// Steps: webui-pid map (+15s pgrep cache) → lock files + tmux panes → lock-
// first JSONL claims per project dir → entries; `devSnap` = device #0's
// discovery snapshot when agentd.localDiscovery is on (facts pre-verified
// device-side), null ⇒ the local scan. Returns plain entries (the route adds
// sessionKey/realCwd). ──
const _childPidCache = new Map(); // childPid -> {pids, at} — see pgrep note below
async function discoverClaudeSessions({ activeSessions, webuiPids = new Set(), devSnap = null } = {}) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  // snapshot jsonls grouped by projDir for the walk below
  const snapByDir = devSnap ? (() => {
    const m = new Map();
    for (const j of devSnap.jsonls) { if (!m.has(j.projDir)) m.set(j.projDir, new Map()); m.get(j.projDir).set(j.file, j); }
    return m;
  })() : null;

  // Step 0: Use cached webuiPids (updated on session create/kill/restore)

  // Step 1: Scan lock files + tmux panes -> build map of RUNNING sessions
  // Build webuiPid -> claudeSessionId map for precise JSONL matching
  const webuiPidToSessionId = new Map();
  const needPgrep = []; // [{childPid, claudeSessionId}] — cache misses
  for (const [id, s] of activeSessions) {
    if (s.claudeSessionId && s._childPid) {
      // Map childPid + its direct children (claude forks from node-pty spawn)
      webuiPidToSessionId.set(s._childPid, s.claudeSessionId);
      // the wrapper's child pids rarely change, cache them 15s (audit round-2)
      const hit = _childPidCache.get(s._childPid);
      if (hit && Date.now() - hit.at < 15000) {
        for (const p of hit.pids) webuiPidToSessionId.set(p, s.claudeSessionId);
      } else needPgrep.push({ childPid: s._childPid, claudeSessionId: s.claudeSessionId });
    }
  }
  await Promise.all(needPgrep.map(async ({ childPid, claudeSessionId }) => {
    const out = await execFileP('pgrep', ['-P', String(childPid)], { timeout: 2000 });
    const pids = [];
    for (const line of String(out || '').trim().split('\n')) { const p = parseInt(line.trim()); if (p) pids.push(p); }
    _childPidCache.set(childPid, { pids, at: Date.now() });
    if (_childPidCache.size > 512) _childPidCache.delete(_childPidCache.keys().next().value);
    for (const p of pids) webuiPidToSessionId.set(p, claudeSessionId);
  }));

  const paneMap = await getTmuxPaneMapAsync();
  const runningByProjDir = new Map(); // projDirName -> [{lock, tmuxTarget, assigned, claudeSessionId}]
  if (devSnap || fs.existsSync(SESSIONS_DIR)) {
    let lockDatas = [];
    if (devSnap) {
      // device facts: liveness + pidLooksClaude already applied device-side
      lockDatas = devSnap.locks;
    } else for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
        if (!isPidAlive(data.pid)) continue;
        lockDatas.push(data);
      } catch {}
    }
    // probe in PARALLEL, assemble in ORIGINAL order (claimJsonls' mtime
    // fallback + the firstRunning cwd pick depend on stable entry order)
    const probed = await Promise.all(lockDatas.map(async (data) => {
      try {
        if (!devSnap && !(await isLockClaude(data))) return null; // B-2104: procStart file-read, ps only as fallback (device facts arrive pre-verified)
        return { data, tmuxTarget: await findTmuxTargetAsync(data.pid, paneMap) };
      } catch { return null; }
    }));
    for (const hit of probed) {
      if (!hit) continue;
      const projDirName = cwdToProjectDir(hit.data.cwd);
      const claudeSessionId = webuiPidToSessionId.get(hit.data.pid) || null;
      if (!runningByProjDir.has(projDirName)) runningByProjDir.set(projDirName, []);
      runningByProjDir.get(projDirName).push({ lock: hit.data, tmuxTarget: hit.tmuxTarget, assigned: false, claudeSessionId });
    }
  }

  // Step 2: Scan JSONL files, match with running locks
  const sessions = [];
  const sessionMap = new Map(); // sessionId → index in sessions[] (dedup: running wins over stopped)
  if (snapByDir || fs.existsSync(projectsDir)) {
    for (const projDir of (snapByDir ? [...snapByDir.keys()] : fs.readdirSync(projectsDir))) {
      const projPath = path.join(projectsDir, projDir);
      const snapFiles = snapByDir?.get(projDir) || null;
      if (!snapFiles) { try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; } }

      // Pre-fetch stats for sorting + mtime lookup (device facts carry them)
      const jsonls = snapFiles ? [...snapFiles.keys()]
        : fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
      const statMap = new Map();
      for (const f of jsonls) {
        if (snapFiles) { statMap.set(f, snapFiles.get(f)?.mtimeMs || 0); continue; }
        try { statMap.set(f, fs.statSync(path.join(projPath, f)).mtimeMs); } catch { statMap.set(f, 0); }
      }
      // Sort by mtime desc (display recency; claiming no longer relies on it alone)
      jsonls.sort((a, b) => (statMap.get(b) || 0) - (statMap.get(a) || 0));

      // Check if there are running locks for this project dir
      const runningEntries = runningByProjDir.get(projDir) || [];

      // Match running locks to JSONLs (claimJsonls in session-store):
      // 1. exact — webui-tracked claudeSessionId, or the lock file's own
      //    sessionId equals a JSONL filename (non-resumed sessions)
      // 2. tail — resumed sessions write their CURRENT id into the
      //    ORIGINAL-named file; scan the last 64KB for the lock's id
      // 3. mtime fallback — brand-new session with nothing flushed yet.
      // With N parallel sessions in ONE cwd, the old "newest unclaimed
      // JSONL takes the next lock" attributed files arbitrarily (kill one
      // → the WRONG id showed stopped → resume collided with a live one).
      const claims = runningEntries.length ? claimJsonls(
        runningEntries.map(e => ({ sessionId: e.claudeSessionId || e.lock.sessionId || null, exactOnly: !!e.claudeSessionId, entry: e })),
        jsonls.map(f => ({ id: f.replace(/\.jsonl$/, ''), mtime: statMap.get(f) || 0 })),
        (j) => {
          // device facts carry tail ids for the newest 60 files; older
          // files with a running lock (rare) fall back to a local read —
          // extractTailIds' null-on-unreadable contract is preserved
          const sf = snapFiles?.get(j.id + '.jsonl');
          return sf && 'tailIds' in sf ? sf.tailIds : readJsonlTailIds(path.join(projPath, j.id + '.jsonl'));
        },
      ) : new Map();

      for (const f of jsonls) {
        const sessionId = f.replace('.jsonl', '');
        const filePath = path.join(projPath, f);
        const mtime = statMap.get(f) || 0;

        const meta = extractSessionMeta(filePath);
        const firstRunning = runningEntries.find(e => !e.assigned);
        const cwd = (firstRunning?.lock.cwd) || meta.cwd || recoverCwdFromProjDir(projDir);

        let status = 'stopped', pid = null, tmuxTarget = null;
        const match = claims.get(sessionId)?.entry || null;
        // Also check if any active webui session claims this claudeSessionId (covers race during resume)
        let isWebuiSession = false;
        if (match) isWebuiSession = webuiPids.has(match.lock.pid);
        if (!isWebuiSession) {
          for (const [, s] of activeSessions) {
            if (s.claudeSessionId === sessionId) { isWebuiSession = true; break; }
          }
        }
        if (match) {
          status = isWebuiSession ? 'live'
            : match.tmuxTarget ? 'tmux' : 'external';
          pid = match.lock.pid;
          tmuxTarget = match.tmuxTarget || null;
          match.assigned = true;
        }

        const entry = {
          backend: 'claude',
          backendSessionId: sessionId,
          claudeSessionId: sessionId,
          sessionId,
          cwd,
          pid,
          startedAt: mtime,
          status,
          name: meta.name || '',
          tmuxTarget,
        };

        // Deduplicate: same JSONL can appear in multiple project dirs
        if (sessionMap.has(sessionId)) {
          const existing = sessions[sessionMap.get(sessionId)];
          // Running status wins over stopped
          if (existing.status === 'stopped' && status !== 'stopped') {
            sessions[sessionMap.get(sessionId)] = entry;
          }
        } else {
          sessionMap.set(sessionId, sessions.length);
          sessions.push(entry);
        }
      }
    }
  }

  // Step 3: Running locks that didn't match any project dir (brand new, no JSONL yet)
  for (const [, entries] of runningByProjDir) {
    for (const entry of entries) {
      if (!entry.assigned && !sessionMap.has(entry.lock.sessionId)) {
        sessionMap.set(entry.lock.sessionId, sessions.length);
        sessions.push({
          backend: 'claude',
          backendSessionId: entry.lock.sessionId,
          claudeSessionId: entry.lock.sessionId,
          sessionId: entry.lock.sessionId, cwd: entry.lock.cwd, pid: entry.lock.pid,
          startedAt: entry.lock.startedAt || Date.now(),
          status: (webuiPids.has(entry.lock.pid) || [...activeSessions.values()].some(s => s.claudeSessionId === entry.lock.sessionId)) ? 'live'
            : entry.tmuxTarget ? 'tmux' : 'external', name: '',
          tmuxTarget: entry.tmuxTarget || null,
        });
      }
    }
  }
  return sessions;
}

function dedupWebuiSockets(entries) {
  const best = new Map(); // key -> entry
  for (const e of entries || []) {
    if (!e || !e.claudeSessionId) continue;
    const key = `${e.backend || 'claude'}:${e.host || 'local'}:${e.claudeSessionId}`;
    const cur = best.get(key);
    if (!cur) { best.set(key, e); continue; }
    const better = (!!e.claudeAlive && !cur.claudeAlive)
      || (!!e.claudeAlive === !!cur.claudeAlive && (e.createdAt || 0) > (cur.createdAt || 0));
    if (better) best.set(key, e);
  }
  const winners = new Map();
  for (const [key, e] of best) winners.set(key, e.sockFile);
  const retire = new Set();
  for (const e of entries || []) {
    if (!e || !e.claudeSessionId) continue;
    const key = `${e.backend || 'claude'}:${e.host || 'local'}:${e.claudeSessionId}`;
    if (winners.get(key) !== e.sockFile) retire.add(e.sockFile);
  }
  return { winners, retire };
}

module.exports = {
  warmSessionJsonlAsync,
  SESSIONS_DIR,
  dedupWebuiSockets,
  isPidAlive,
  cwdToProjectDir,
  recoverCwdFromProjDir,
  getTmuxPaneMap,
  findTmuxTarget,
  getTmuxPaneMapAsync,
  findTmuxTargetAsync,
  isProcessClaudeAsync,
  isLockClaude,
  execFileP,
  isSubagentMessage,
  isDisplayMessage,
  readJsonlTailIds,
  claimJsonls,
  findSessionJsonlPath,
  parseSessionJsonl,
  extractSessionMeta,
  getSubagentMetas,
  getHistorySessionId,
  SessionMessages,
  discoverClaudeSessions,
};
