'use strict';
/**
 * OpenCode serve LIVE SIGNALS (S9 remainder, B-eac2) — SHARED tier: node
 * builtins only, no ORCH import. Two lanes, because ONE of them is provably
 * blind and saying so is the whole point of this module:
 *
 *   ① THE SSE LANE — `GET /global/event`.
 *      Measured on a real 1.18.29 serve (/proc thread + RSS sampling, A/B
 *      against the same instance): `/global/event` boots NO OpenCode instance
 *      (15 threads before, 15 during, 15 after) and needs no `directory`
 *      query, so it is the ONE subscription per serve. Its frames are
 *      `{directory, project, workspace, payload:<Event>}` — the same Event
 *      union `/event` carries, but for EVERY directory the serve owns, which
 *      is why the per-instance `/event` route is not used here.
 *      Verified live: creating a session in a directory the subscriber never
 *      named still arrives as `session.created`. A `server.heartbeat` frame
 *      lands about every 10s (undocumented in the OpenAPI, observed on the
 *      wire) — it is the liveness signal a silent stream cannot give us.
 *
 *   ② THE STORE-WATCH LANE — fs.watch over the OpenCode data dir.
 *      THE MEASURED BLIND SPOT: a SECOND opencode process on the SAME sqlite
 *      store (the TUI, another `opencode serve`) produces **no event at all**
 *      on our serve's `/global/event`. Reproduced: serve A subscribed, serve B
 *      created a session on the same store, A's stream carried only
 *      `server.connected` + heartbeats for 28s, while A's `GET /session`
 *      listed the new session immediately. The store is shared; the event bus
 *      is per process. So SSE alone cannot replace the list poll — a TUI's
 *      work would be invisible until something else happened to refresh.
 *      The honest replacement is not a slower timer, it is the OTHER event
 *      source: `~/.local/share/opencode/opencode.db{,-wal}` changes when any
 *      process writes, and fs.watch turns that into an event. Debounced,
 *      failure-tolerant (an unwatchable dir degrades to "no external signal",
 *      loudly once), and it never reads the file — only its mtime events.
 *      ROUND 4, two ways this lane could LIE about itself, both closed: it is
 *      `active` only for a directory that actually holds `opencode.db` (a
 *      leftover empty dir is not a store), and its dirs are RE-RESOLVED on
 *      every `connected` against the serve's own `GET /path` home instead of
 *      being latched from the boot-time env guess. A false `active` is worse
 *      than none: laneHealthy() switches the list-refresh fallback off on it.
 *
 * classifyEvent() is PURE: it maps an OpenCode event payload onto the facts
 * this product caches, so the cache invalidation lives in one testable table
 * instead of scattered `if (type === …)` at the call sites.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SSE_ROUTE = '/global/event';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** No frame at all (not even a heartbeat) for this long ⇒ the stream is dead
 *  even though the socket is open. Heartbeats were measured at ~10s. */
const SSE_IDLE_TIMEOUT_MS = 45000;
const STORE_DEBOUNCE_MS = 400;
/** The file whose presence PROVES a directory is an OpenCode store. A watch on
 *  a directory that merely exists is not a store watch, and `active` is the
 *  flag laneHealthy() switches the list-refresh fallback off on — see
 *  createStoreWatch. Verified 1.18.29: the serve creates it at boot. */
const STORE_DB_FILE = 'opencode.db';

/** Incremental `text/event-stream` framer. PURE: (carry, chunk) → {carry, frames}.
 *  Only the `data:` lines matter (OpenCode sends no event names/ids); a frame
 *  ends at a blank line, and multiple `data:` lines in one frame concatenate
 *  with '\n' per the SSE spec. */
function sseFrames(carry, chunk) {
  const buf = String(carry || '') + String(chunk || '');
  const parts = buf.split(/\r?\n\r?\n/);
  const rest = parts.pop();
  const frames = [];
  for (const block of parts) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data) frames.push(data);
  }
  return { carry: rest, frames };
}

/** What a `/global/event` frame invalidates. PURE.
 *  Returns {kind, sessionId, questionId, ptyId, status, session, dirty:{…}} —
 *  `dirty` names the caches the consumer must drop, `kind` is the coarse
 *  reason a client-facing broadcast quotes. Unknown types are NOT an error
 *  (the union has 89 members and grows): they map to kind 'other' with no
 *  dirty flags, so an OpenCode upgrade can never make us drop a lane. */
function classifyEvent(frame) {
  const wrapped = frame && typeof frame === 'object' ? frame : {};
  const ev = wrapped.payload && typeof wrapped.payload === 'object' ? wrapped.payload : wrapped;
  const type = typeof ev.type === 'string' ? ev.type : '';
  const p = ev.properties && typeof ev.properties === 'object' ? ev.properties : {};
  const out = { type, kind: 'other', directory: typeof wrapped.directory === 'string' ? wrapped.directory : '', sessionId: '', dirty: {} };
  switch (type) {
    case 'server.connected': out.kind = 'connected'; out.dirty.sessions = true; return out;   // a (re)connect may have missed changes: re-list once
    case 'server.heartbeat': out.kind = 'heartbeat'; return out;
    case 'session.created': case 'session.deleted':
      out.kind = 'sessions'; out.sessionId = String(p.sessionID || ''); out.session = p.info || null; out.dirty.sessions = true; return out;
    case 'session.updated':
      out.kind = 'sessions'; out.sessionId = String(p.sessionID || ''); out.session = p.info || null;
      out.dirty.sessions = true; out.dirty.conversation = out.sessionId; out.revert = p.info?.revert || null; return out;
    case 'session.idle':
      out.kind = 'status'; out.sessionId = String(p.sessionID || ''); out.status = { type: 'idle' }; return out;
    case 'session.status':
      out.kind = 'status'; out.sessionId = String(p.sessionID || ''); out.status = p.status && typeof p.status === 'object' ? p.status : null; return out;
    case 'session.error':
      out.kind = 'status'; out.sessionId = String(p.sessionID || ''); out.status = { type: 'idle' }; out.dirty.conversation = out.sessionId; return out;
    case 'session.compacted': case 'session.diff':
      out.kind = 'sessions'; out.sessionId = String(p.sessionID || ''); out.dirty.conversation = out.sessionId; return out;
    case 'message.updated': case 'message.removed': case 'message.part.updated': case 'message.part.removed': case 'message.part.delta':
      out.kind = 'messages'; out.sessionId = String(p.sessionID || p.info?.sessionID || p.part?.sessionID || '');
      if (out.sessionId) out.dirty.conversation = out.sessionId;
      return out;
    case 'question.asked':
      out.kind = 'question'; out.sessionId = String(p.sessionID || ''); out.questionId = String(p.id || '');
      out.question = { id: out.questionId, sessionID: out.sessionId, questions: Array.isArray(p.questions) ? p.questions : [], tool: p.tool || null };
      out.dirty.questions = true; return out;
    case 'question.replied': case 'question.rejected':
      out.kind = 'question'; out.sessionId = String(p.sessionID || ''); out.questionId = String(p.requestID || p.id || '');
      out.answered = type === 'question.replied' ? (Array.isArray(p.answers) ? p.answers : []) : null;
      out.dirty.questions = true; out.dirty.conversation = out.sessionId; return out;
    case 'pty.created': case 'pty.updated': case 'pty.exited': case 'pty.deleted':
      out.kind = 'pty'; out.ptyId = String(p.id || p.ptyID || p.info?.id || ''); out.ptyStatus = type.slice(4); out.dirty.ptys = true; return out;
    default:
      // `session.next.*` (the v2 store), `file.*`, `lsp.*`, `tui.*`, `sync`…
      // — nothing this product caches. Naming them here would be a lie about
      // what we understand; the 'other' bucket is the honest answer.
      return out;
  }
}

/** A live `/global/event` subscription with reconnect backoff.
 *  `locator.client()` supplies the base URL, so a serve that respawns on a new
 *  port is followed automatically: every reconnect re-asks the locator. */
function createEventStream({
  locator, onEvent = null, onState = null, log = console,
  fetchImpl = null, backoffBaseMs = RECONNECT_BASE_MS, maxBackoffMs = RECONNECT_MAX_MS,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS, now = Date.now, connectBudgetMs = 8000,
} = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const state = { connected: false, attempts: 0, lastFrameAt: 0, lastError: null, stopped: false, connectedAt: null, frames: 0 };
  let ctl = null, timer = null, idleTimer = null, running = false;
  /** The resolver of the backoff sleep, while the loop is IN it. THE SLEEP IS
   *  PART OF THE SOCKET: `kick()` used to abort the fetch controller only, and
   *  during a backoff there is no fetch to abort — so a lane that had backed
   *  off to 30s (the service ships OFF, so "nothing to connect to" is the
   *  NORMAL state before first use) took up to that long to notice the serve,
   *  measured at 25s end to end. Waking the sleep is what makes the kick real. */
  let wake = null;
  function wakeSleep() { clearTimeout(timer); timer = null; const w = wake; wake = null; if (w) { try { w(); } catch { } } }

  const notify = () => { try { onState?.(snapshot()); } catch { } };
  function snapshot() {
    return { connected: state.connected, attempts: state.attempts, lastFrameAt: state.lastFrameAt, lastError: state.lastError, stopped: state.stopped, connectedAt: state.connectedAt, frames: state.frames };
  }
  function armIdle() {
    clearTimeout(idleTimer);
    if (!idleTimeoutMs) return;
    idleTimer = setTimeout(() => {
      // an open socket that stopped heart-beating is DEAD, not idle: abort so
      // the loop reconnects (a serve killed with SIGKILL leaves the socket
      // hanging until the OS notices — minutes)
      state.lastError = `no event for ${Math.round(idleTimeoutMs / 1000)}s (heartbeat lost)`;
      try { ctl?.abort(); } catch { }
    }, idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  }
  async function connectOnce() {
    const client = await locator.client({ budgetMs: connectBudgetMs });
    if (!client) throw new Error(locator.state?.().lastError || 'opencode serve unavailable');
    ctl = new AbortController();
    const headers = { accept: 'text/event-stream' };
    if (client._auth) headers.authorization = client._auth;
    const res = await doFetch(new URL(client.baseUrl + SSE_ROUTE), { method: 'GET', headers, signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`GET ${SSE_ROUTE} → HTTP ${res.status}`);
    state.connected = true; state.attempts = 0; state.connectedAt = now(); state.lastError = null;
    notify();
    armIdle();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let carry = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.lastFrameAt = now();
      armIdle();
      const { carry: next, frames } = sseFrames(carry, dec.decode(value, { stream: true }));
      carry = next;
      for (const raw of frames) {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { continue; }   // a partial/garbled frame is skipped, never fatal
        state.frames++;
        let info = null;
        try { info = classifyEvent(parsed); } catch { continue; }
        try { onEvent?.(info, parsed); } catch (e) { log?.warn?.(`[opencode-events] handler failed on ${info?.type}: ${e.message}`); }
      }
    }
  }
  async function loop() {
    if (running) return;
    running = true;
    try {
      while (!state.stopped) {
        try { await connectOnce(); }
        catch (e) { if (!state.lastError) state.lastError = e?.message || String(e); }
        state.connected = false; state.connectedAt = null;
        clearTimeout(idleTimer);
        notify();
        if (state.stopped) break;
        state.attempts++;
        // the serve may be respawning (crash backoff, runaway cooldown): the
        // stream backs off the same way and re-asks the locator each time
        const wait = Math.min(maxBackoffMs, backoffBaseMs * 2 ** Math.min(state.attempts - 1, 10));
        await new Promise((r) => { wake = r; timer = setTimeout(r, wait); if (timer.unref) timer.unref(); });
        wake = null;
      }
    } finally { running = false; }
  }
  return {
    start() { if (state.stopped) return; loop().catch(() => { }); return snapshot(); },
    /** A locator restart (new port) invalidates the socket: drop it so the
     *  loop reconnects to the NEW base url instead of a dead one. Both states
     *  the loop can be in are ended — an OPEN socket by aborting the fetch, a
     *  SLEEPING backoff by waking it (see `wake`); resetting `attempts` alone
     *  only shortens the NEXT wait, never the one already running. */
    kick() { state.attempts = 0; state.lastError = null; wakeSleep(); try { ctl?.abort(); } catch { } if (!running) loop().catch(() => { }); },
    stop() { state.stopped = true; clearTimeout(idleTimer); wakeSleep(); try { ctl?.abort(); } catch { } notify(); },
    state: snapshot,
  };
}

/** fs.watch over the OpenCode store directories → a debounced dirty signal.
 *  This is the ONLY lane that sees a TUI (a different process on the same
 *  sqlite) — see the header. It never reads the db; a missing/unwatchable dir
 *  is reported ONCE and degrades to "no external signal" rather than throwing
 *  (an OpenCode that has never run has no data dir yet).
 *
 *  `active` MEANS "we are watching a real OpenCode store" (round 4). It is the
 *  flag laneHealthy() uses to switch the timed list refresh OFF, so a watch on
 *  a directory that merely EXISTS — `$HOME/.local/share/opencode` left behind
 *  by an OpenCode that keeps its store elsewhere, or simply the wrong HOME —
 *  would report a healthy lane while carrying no signal at all, and the product
 *  would go silently blind to every other opencode process (the exact blind
 *  spot this lane exists to close). A directory with no `opencode.db` is
 *  therefore recorded in `failed` and NOT watched: not-a-store degrades to
 *  "unknown", which keeps the timer fallback on, and the next reconnect
 *  re-arms (the serve creates the db at boot). */
function createStoreWatch({ dirs = [], onDirty = null, debounceMs = STORE_DEBOUNCE_MS, log = console, watchImpl = fs.watch, existsImpl = fs.existsSync } = {}) {
  const watchers = [];
  const state = { watching: [], failed: [], hits: 0, lastAt: 0 };
  let timer = null;
  function fire(reason) {
    state.hits++; state.lastAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; try { onDirty?.(reason); } catch (e) { log?.warn?.(`[opencode-events] store-watch handler failed: ${e.message}`); } }, debounceMs);
    if (timer.unref) timer.unref();
  }
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    if (!dir || typeof dir !== 'string') continue;
    if (!existsImpl(dir)) { state.failed.push({ dir, reason: 'not created yet' }); continue; }
    // EXISTS ≠ IS THE STORE. Watching a stray directory would report a healthy
    // lane that can never fire (see the header).
    if (!existsImpl(path.join(dir, STORE_DB_FILE))) { state.failed.push({ dir, reason: `no ${STORE_DB_FILE} (not an OpenCode store)` }); continue; }
    try {
      const w = watchImpl(dir, { persistent: false }, (_ev, name) => {
        // opencode.db / -wal / -shm are the store; `log/` and `repos/` churn
        // for reasons that change no conversation
        const n = String(name || '');
        if (n && !/^opencode\.db/.test(n)) return;
        fire(`store:${n || 'change'}`);
      });
      w.on?.('error', (e) => { state.failed.push({ dir, reason: e.message }); log?.warn?.(`[opencode-events] store watch on ${dir} failed: ${e.message} — external (TUI) changes will not be noticed live`); });
      watchers.push(w);
      state.watching.push(dir);
    } catch (e) {
      state.failed.push({ dir, reason: e.message });
      log?.warn?.(`[opencode-events] cannot watch ${dir} (${e.message}) — external (TUI) changes will not be noticed live`);
    }
  }
  return {
    state: () => ({ watching: [...state.watching], failed: [...state.failed], hits: state.hits, lastAt: state.lastAt, active: watchers.length > 0 }),
    stop() { clearTimeout(timer); for (const w of watchers) { try { w.close(); } catch { } } watchers.length = 0; state.watching.length = 0; },
  };
}

/** Where THIS machine keeps the OpenCode sqlite store. PURE (env in, paths
 *  out). `serveHome` is the serve's own `GET /path` home, which differs from
 *  ours when the serve was started under another HOME -- both are watched,
 *  because watching a directory that does not exist costs nothing but a note.
 *  OpenCode 1.18.29 keeps `opencode.db{,-wal,-shm}` in
 *  `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`) -- verified
 *  on a real isolated store. */
function storeDirsFor({ env = process.env, home = null, serveHome = null } = {}) {
  const out = [];
  const add = (d) => { if (d && !out.includes(d)) out.push(d); };
  if (env.XDG_DATA_HOME) add(path.join(env.XDG_DATA_HOME, 'opencode'));
  const h = home || env.HOME || os.homedir();
  if (h) add(path.join(h, '.local', 'share', 'opencode'));
  if (serveHome && serveHome !== h) add(path.join(serveHome, '.local', 'share', 'opencode'));
  return out;
}

/** THE LIVE LANE: the two sources together, with ONE state() the product can
 *  show. `onEvent` gets classified `/global/event` frames (what OUR serve
 *  does), `onExternal` gets the debounced store-watch signal (what ANOTHER
 *  opencode process did -- the only lane that sees a TUI). Callers treat the
 *  pair as one thing: while it is healthy, no timer re-reads the session list.
 *
 *  THE STORE DIRS ARE RE-RESOLVED, NOT LATCHED (round 4). The boot arm can only
 *  guess from OUR OWN env — no serve exists yet — and on every machine that has
 *  ever run opencode `$HOME/.local/share/opencode` already exists, so the guess
 *  ALWAYS attached and the documented "resolve lazily once the serve answers
 *  GET /path" never ran. That is a watch on a store the serve may not use,
 *  reported as `active`, which makes laneHealthy() true, which switches the
 *  list-refresh fallback OFF — the product goes blind to every other opencode
 *  process while claiming a healthy lane. So the boot arm stays (it is right in
 *  the default deployment and costs nothing), and EVERY `connected` re-resolves
 *  against the serve's own home and re-arms only when the answer DIFFERS —
 *  matching dirs are left untouched, so a reconnect storm cannot churn the
 *  watchers. A serve that never comes up simply leaves the watch inactive
 *  (which laneHealthy() reads as "not healthy" -> the timer fallback stays on). */
function createLiveLane({ locator, onEvent = null, onExternal = null, onState = null, log = console,
  storeDirs = null, env = process.env, fetchImpl = null, watchImpl = fs.watch, existsImpl = fs.existsSync,
  debounceMs = STORE_DEBOUNCE_MS, idleTimeoutMs = SSE_IDLE_TIMEOUT_MS } = {}) {
  let watch = null;
  let watchTried = false;
  let watchedDirs = [];            // the dirs the CURRENT watch was built from (re-resolution compares against this)
  let rearms = 0;                  // how many times a `connected` moved the watch — a state fact, not a counter for its own sake
  const stream = createEventStream({
    locator, log, fetchImpl, idleTimeoutMs,
    onEvent: (info, raw) => {
      // a (re)connect is also the moment to (re)arm the store watch: the serve
      // may have moved, and a failed watch must be retried rather than lost
      if (info.kind === 'connected') armWatch('connected').catch(() => { });
      try { onEvent?.(info, raw); } catch (e) { log?.warn?.(`[opencode-events] onEvent failed: ${e.message}`); }
    },
    onState: () => { try { onState?.(state()); } catch { } },
  });
  /** Injected dirs win (a unit test / an explicit deployment). Otherwise ask
   *  the SERVE whose HOME it runs under and derive from that; with no serve the
   *  answer is our own env, which is the boot guess. */
  async function resolveDirs() {
    if (Array.isArray(storeDirs) && storeDirs.length) return storeDirs.slice();
    let serveHome = null;
    try { const c = await locator.client({ budgetMs: 2000 }); if (c) serveHome = (await c.paths({ timeoutMs: 2000 }))?.home || null; } catch { }
    return storeDirsFor({ env, serveHome });
  }
  const sameDirs = (a, b) => a.length === b.length && a.every((d, i) => d === b[i]);
  /** @param why 'boot' (no serve yet — the env guess) | 'connected' (the serve
   *  can now name its own home, so re-resolve and move the watch if it moved). */
  async function armWatch(why = 'boot') {
    if (watch && why !== 'connected') return watch;       // already attached and nothing new is knowable
    if (!watch && watchTried && why !== 'connected') return watch;
    const dirs = await resolveDirs();
    if (watch) {
      if (sameDirs(dirs, watchedDirs)) return watch;      // NOTHING MOVED: never churn the watchers on a reconnect
      log?.warn?.(`[opencode-events] the OpenCode store moved (${watchedDirs.join(', ') || 'none'} → ${dirs.join(', ') || 'none'}) — re-arming the store watch`);
      try { watch.stop(); } catch { }
      watch = null; watchedDirs = []; rearms++;
    }
    watchTried = true;
    watch = createStoreWatch({ dirs, debounceMs, log, watchImpl, existsImpl, onDirty: (reason) => { try { onExternal?.(reason); } catch (e) { log?.warn?.(`[opencode-events] onExternal failed: ${e.message}`); } } });
    watchedDirs = dirs.slice();
    // a watch that could not attach ANYWHERE is not a watch: let the next
    // reconnect try again (the store dir is created the first time opencode runs)
    if (!watch.state().active) { watch.stop(); watch = null; watchTried = false; watchedDirs = []; }
    try { onState?.(state()); } catch { }
    return watch;
  }
  function state() {
    return { sse: stream.state(), rearms, watch: watch ? watch.state() : { watching: [], failed: [], hits: 0, lastAt: 0, active: false } };
  }
  return {
    start() { stream.start(); armWatch('boot').catch(() => { }); return state(); },
    kick() { stream.kick(); },
    stop() { stream.stop(); try { watch?.stop(); } catch { } watch = null; watchTried = false; watchedDirs = []; },
    state,
    _armWatch: armWatch,
  };
}

module.exports = {
  SSE_ROUTE, sseFrames, classifyEvent, createEventStream, createStoreWatch, createLiveLane, storeDirsFor,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, SSE_IDLE_TIMEOUT_MS, STORE_DEBOUNCE_MS, STORE_DB_FILE,
};
