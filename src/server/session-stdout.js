'use strict';
// SESSION STDOUT ENGINE (decomposition #6 — the largest module).
// setupSessionPty (protocol dispatch → the per-protocol stdout consumers under
// src/server/stdout/, harness S5) + the death classification on exit +
// attachToDtach + the session-meta store (read/write/delete + tombstones +
// owner-conflict guard). The three parse pipelines (claude stream-json /
// codex-events / acp-events) were inline branches here until S5 moved them
// VERBATIM into src/server/stdout/<protocol>.js; the registry (stdout/index.js)
// resolves the harness descriptor's caps.streamProtocol to ONE consumer.
// ORCH tier: it consumes the machine handle (hosts) and the usage/pool engine,
// never vendor APIs. Late-created deps arrive lazily — all uses are at runtime.
const { classifyCliDeath } = require('./agent-tool-generators.js');
const { feedLive } = require('../normalizers');
const { capsOf } = require('../backend-caps.js'); // streamProtocol picks the parse pipeline — never the backend id (P4)
const { createStdoutRegistry } = require('./stdout/index.js'); // protocol → consumer (S5)
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { spawn } = require('child_process');

const { mk } = require('./lazy.js');

function create({ rootDir, BUFFERS_DIR, META_DIR, DTACH_CMD, USAGE_SCANNER_PATH,
  CLAUDE_STREAM_TYPES, _seenStreamTypes, activeSessions, engine,
  checkClaudeGoalStatus, broadcastToSession, broadcastActiveSessions,
  noteModelSeen, noteHarnessModels, recordUsageAttribution, daemonPtyShim, sbSeenFirst, getDeviceMgr,
  agentEnv, // the SANITIZED spawn env (spawn-hygiene law) — the ONE local re-attach uses it, as ws-handler's detector always did
  getHosts, getUsageHistory, getTelemetry, getNoConvoRef, getDeliver, getPages, getPermissionRules }) {
  const hosts = mk(getHosts);
  const usageHistory = mk(getUsageHistory);
  const telemetry = mk(getTelemetry);
  const noConvoRef = mk(getNoConvoRef);
  const deliverRef = mk(getDeliver);
  const pagesRef = mk(getPages);
  const permissionRulesRef = mk(getPermissionRules);   // the read-only rule view's answer sink (ruling 10)
  const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
  // S5: ONE consumer per declared stream protocol (src/server/stdout/), built
  // once with the orchestrator deps the inline branches used to close over;
  // this engine's own closures (meta store, todo helpers, broadcasts, the
  // feedLive gate) ride `stdoutHelpers` into every attach.
  const stdoutConsumers = createStdoutRegistry({ activeSessions, engine, CLAUDE_STREAM_TYPES, _seenStreamTypes, USAGE_SCANNER_PATH,
    checkClaudeGoalStatus, noteModelSeen, noteHarnessModels, sbSeenFirst, hosts, usageHistory, deliverRef, pagesRef, permissionRulesRef });
  const stdoutHelpers = { feedLive, broadcastToSession, broadcastActiveSessions, readSessionMeta, writeSessionMeta,
    updateSessionTodos, applyTaskToolUpdate, emitTaskListTodos };
// ── PTY setup helper (onData + onExit wiring) ──
// Live TODO capture — the agent's own TodoWrite (claude) / plan tool (codex)
// IS the session's (活儿's) checklist; VibeSpace only OBSERVES it (never a
// parallel store the agent must be taught). Summary rides active-sessions for
// the board's progress pill; the full list is fetched on demand (expanded card
// → /api/session-todos, which reads taskState() from the transcript).
// New task-tool family (CLI ≥2.1.2xx: TaskCreate/TaskUpdate — CRUD by id, not
// full-list snapshots like TodoWrite). The created task's id only arrives in
// the paired TOOL RESULT text ("Task #N created…"), so creates are stashed by
// tool_use_id until the result lands. Replayed into a list for the same pill.
function applyTaskToolUpdate(session, input) {
  const list = (session._taskList ||= new Map());
  const key = String(input.taskId);
  if (input.status === 'deleted') list.delete(key);
  else {
    const cur = list.get(key) || { content: '', status: 'pending' };
    if (input.subject) cur.content = input.subject;
    if (input.activeForm) cur.activeForm = input.activeForm;
    if (input.status) cur.status = input.status;
    list.set(key, cur);
  }
  emitTaskListTodos(session);
}
function emitTaskListTodos(session) {
  if (!session._taskList?.size) return;
  const todos = [...session._taskList.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, v]) => v);
  updateSessionTodos(session, todos);
}
let _todoBroadcastTimer = null;
function updateSessionTodos(session, todos) {
  try {
    if (!Array.isArray(todos) || !todos.length) return;
    const done = todos.filter((t) => t?.status === 'completed').length;
    const cur = todos.find((t) => t?.status === 'in_progress');
    session._todos = { done, total: todos.length, current: cur ? String(cur.content || cur.activeForm || cur.step || '').slice(0, 140) : null };
    if (!_todoBroadcastTimer) { // coalesce: TodoWrite can fire several times per turn
      _todoBroadcastTimer = setTimeout(() => { _todoBroadcastTimer = null; broadcastActiveSessions(); }, 500);
    }
  } catch { }
}

function setupSessionPty(session, id, ptyProcess, { cleanupOnExit = true } = {}) {
  session.pty = ptyProcess;

  // LIVENESS STAMP — the ONE place every pty (local node-pty or daemonPtyShim)
  // is wired, so "did ANY byte arrive from this bridge since T" has ONE answer
  // for every mode and every stream protocol. It is registered FIRST and holds
  // no other duty: the terminal branch SWALLOWS dtach's attach preamble and a
  // chat consumer may not append every byte to session.buffer, so a reader
  // that asks `session.buffer.length` cannot see the bytes that prove the
  // bridge is alive. (This is why daemonPtyShim had to grow a listener SET.)
  ptyProcess.onData(() => { session._lastPtyDataAt = Date.now(); });

  if (session.mode === 'chat') {
    // Dispatch by DECLARED protocol (P4 → S5): the harness descriptor's caps
    // row NAMES the stream protocol (capsOf() IS that row — harness-contract
    // pins the identity) and src/server/stdout/ registers ONE consumer per
    // protocol. A chat backend without a protocol, or with a protocol nobody
    // registered, must fail loudly here — never be silently parsed as
    // stream-json. Both cases pass the output through RAW.
    const streamProto = capsOf(session.backend).streamProtocol;
    if (session.mode === 'chat' && !streamProto) {
      console.error(`[session] backend "${session.backend}" has no streamProtocol in src/backend-caps.js — chat output passes through RAW (register a pipeline)`);
      global.__vsEvent?.('chat-backend-no-protocol', String(session.backend));
    }
    const consumer = streamProto ? stdoutConsumers.get(streamProto) : null;
    if (streamProto && !consumer) {
      console.error(`[session] backend "${session.backend}" declares streamProtocol "${streamProto}" but src/server/stdout/index.js registers no consumer for it — chat output passes through RAW (register one)`);
      global.__vsEvent?.('chat-protocol-no-consumer', `${session.backend}/${streamProto}`);
    }
    if (consumer) {
      consumer.attach(session, id, ptyProcess, stdoutHelpers);
    } else {
      // Chat backend with NO registered protocol (reported loudly above):
      // raw passthrough — visible garbage beats silently mis-parsed claude.
      ptyProcess.onData((output) => {
        session.buffer += output;
        if (session.buffer.length > 1200000) session.buffer = session.buffer.slice(-800000);
        broadcastToSession(session, id, { type: 'output', sessionId: id, data: output });
      });
    }
  } else {
    // Terminal mode: raw PTY output.
    // dtach sends the attaching client a clear-screen preamble (\e[H\e[J) as
    // its redraw kickoff. A TUI then repaints fully (SIGWINCH), but a plain
    // SHELL repaints NOTHING — the preamble wiped attached clients live AND
    // poisoned session.buffer's tail, so every later attach rendered BLANK
    // (real report: shell terminals blanked on every server restart / daemon
    // re-exec; probe showed the buffer ending in \e[H\e[J). Strip a LEADING
    // clear burst within 2s of attach — later clears are real program output.
    let attachPreambleUntil = Date.now() + 2000;
    ptyProcess.onData((output) => {
      if (session._reattachAttempts) session._reattachAttempts = 0;
      if (attachPreambleUntil) {
        const inWindow = Date.now() < attachPreambleUntil;
        attachPreambleUntil = 0; // only the FIRST chunk is ever a candidate
        if (inWindow) {
          const stripped = output.replace(/^(?:\x1b\[H|\x1b\[[0-3]?J)+/, '');
          if (!stripped) return; // pure clear preamble — swallow entirely
          output = stripped;
        }
      }
      session.buffer += output;
      if (session.buffer.length > 75000) session.buffer = session.buffer.slice(-50000);
      broadcastToSession(session, id, { type: 'output', sessionId: id, data: output });
    });
  }

  ptyProcess.onExit(() => {
    // Session already torn down (e.g. this is a stale PTY exiting after kill) — nothing to do
    if (!activeSessions.has(id)) return;
    const isCurrent = session.pty === ptyProcess;

    // Detach path: dtach socket still alive → the session survives, only this
    // attach PTY died. Do NOT tear down watchers/normalizer listeners here —
    // the session keeps running and clients stay attached.
    if (cleanupOnExit && session.socketPath && fs.existsSync(session.socketPath)) {
      // Stale PTY (a replacement was already attached, e.g. broken-stdin
      // recovery): must not null the fresh pty or schedule re-attach.
      if (!isCurrent) return;
      session.pty = null;
      // Auto re-attach so the session doesn't become a zombie (LIVE in the
      // sidebar but input-dead). Bounded retries; counter resets on data.
      session._reattachAttempts = (session._reattachAttempts || 0) + 1;
      if (session._reattachAttempts <= 5) {
        setTimeout(() => {
          if (session.pty || !activeSessions.has(id)) return;
          if (!session.socketPath || !fs.existsSync(session.socketPath)) return;
          // repaint: this is a RE-attach — replay the buffer so clients aren't
          // left blank (dtach replays nothing; shells never repaint)
          try { attachToDtach(id, session.socketPath, session, { repaint: true }); } catch {}
        }, 1000 * session._reattachAttempts);
      }
      return;
    }

    // A stale PTY must never tear down a session that has a live replacement
    if (!isCurrent && session.pty) return;

    // Real teardown: clean up subagent file watchers and normalizers
    if (session.subagentWatchers) {
      for (const [, entry] of session.subagentWatchers) {
        if (entry.watcher) entry.watcher.close();
        if (entry.retry) clearTimeout(entry.retry);
      }
      session.subagentWatchers.clear();
    }
    if (session._subNormalizers) { session._subNormalizers.clear(); }
    if (session._normalizer) { session._normalizer.listeners.length = 0; }
    if (session._interruptTimer) { clearTimeout(session._interruptTimer); session._interruptTimer = null; }
    session._isStreaming = false;
    // THE THIRD EXIT OF THE COMPACTION CLAIM (§2.11, round 7). `_streamingKind
    // === 'compacting'` is a statement about a process that is now gone, and
    // this path clears `_isStreaming` but used to leave the kind set — so a
    // wrapper that died mid-compaction left every attached client holding
    // "Compacting: running <hook> hooks…" and every later "Prompt is too long"
    // card without the rewind-and-retry sentence it exists to give. Retire it
    // through the consumer's OWN named function (bound at attach), BEFORE the
    // `exited` broadcast, so the frame arrives while the client still has a
    // live view — never by clearing the field from here, which would be
    // exactly the silent exit the consumer's census forbids.
    try { session._retireCompaction?.(); } catch { }
    // Child exit code from the wrapper's final meta (2.207.0 — wrappers keep
    // it instead of unlinking; a crash-looping claude previously left zero
    // process-level evidence).
    let childCode = null;
    try { childCode = JSON.parse(fs.readFileSync(path.join(BUFFERS_DIR, id + '.json'), 'utf-8')).childExitCode ?? null; } catch {}
    // CLI-death classifier (2.226.0, user directive "不要静默失败"): known
    // canned errors become a machine reason + the matched line, which rides
    // the `exited` broadcast so the window shows WHY it died (read-only bar /
    // exited overlay) and lands as a telemetry event the admin collector
    // groups fleet-wide. TAIL-scan only — the buffer rotates and an old error
    // hours back must not label a normal exit.
    const death = classifyCliDeath((session.buffer || '').slice(-4096), childCode);
    const exitReason = death?.reason;
    // Unresumable-conversation stamp (2.207.1): the CLI's canned error means
    // the transcript does not exist on this session's machine — arm the
    // create-side circuit breaker so retries get an explanation, not a loop.
    // Tested INDEPENDENTLY of the classifier's first-match precedence (review
    // finding: another pattern winning must not skip arming the breaker).
    if (exitReason === 'no_conversation' || /No conversation found with session ID/.test((session.buffer || '').slice(-4096))) {
      const cid = session.claudeSessionId || session.backendSessionId;
      if (cid) {
        noConvoRef.map.set(cid, Date.now());
        if (noConvoRef.map.size > 100) noConvoRef.map.delete(noConvoRef.map.keys().next().value);
        console.warn(`[session] unresumable conversation ${cid} — transcript missing on its machine; resumes blocked 10min`);
      }
    }
    if (death) global.__vsEvent?.('cli-death', `${session.backend || 'claude'}/${death.reason}`);
    // Lifecycle line for the ops log (2.206.0) — tonight's black-window
    // forensics found NOTHING in opslog about session deaths; this is the
    // minimum breadcrumb an incident needs.
    console.log(`[session] exited ${id} "${session.name || ''}" mode=${session.mode} backend=${session.backend || 'claude'}${childCode != null ? ' code=' + childCode : ''}${exitReason ? ' reason=' + exitReason : ''}`);
    global.__vsEvent?.('session-exited', `${session.mode}/${session.backend || 'claude'}${childCode != null ? '/code=' + childCode : ''}${exitReason ? '/' + exitReason : ''}`);
    broadcastToSession(session, id, { type: 'exited', sessionId: id, reason: exitReason, detail: death?.detail });
    activeSessions.delete(id);
    if (cleanupOnExit && session.sockName) deleteSessionMeta(session.sockName);
    // Buffer + wrapper-meta files are only meaningful while the dtach session
    // lives (restore reads them) — on real teardown they're dead weight that
    // used to accumulate forever (129 files / 28MB observed for 8 live
    // sessions; known-backlog item, fixed 2.81.0).
    // FORENSIC TOMBSTONE (2.206.1): keep the buffer TAIL for a week — a
    // crash's stack trace/stderr lives ONLY in the buffer, and deleting it
    // on exit blinded three "why did this session die" investigations in one
    // night (a claude that crash-looped 4× left zero process-level evidence).
    if (cleanupOnExit) {
      try {
        const bufPath = path.join(BUFFERS_DIR, id + '.buf');
        const st = fs.statSync(bufPath);
        const fd = fs.openSync(bufPath, 'r');
        const take = Math.min(st.size, 65536);
        const tail = Buffer.alloc(take);
        fs.readSync(fd, tail, 0, take, st.size - take);
        fs.closeSync(fd);
        const tombDir = path.join(rootDir, 'data', 'exit-tombs');
        fs.mkdirSync(tombDir, { recursive: true });
        fs.writeFileSync(path.join(tombDir, `${id}.tail`), tail);
        // opportunistic sweep: tombs older than 7 days
        for (const f of fs.readdirSync(tombDir)) {
          try { const s = fs.statSync(path.join(tombDir, f)); if (Date.now() - s.mtimeMs > 7 * 86400e3) fs.unlinkSync(path.join(tombDir, f)); } catch {}
        }
      } catch { /* no buffer / read failed — nothing to keep */ }
      try { fs.unlinkSync(path.join(BUFFERS_DIR, id + '.buf')); } catch {}
      try { fs.unlinkSync(path.join(BUFFERS_DIR, id + '.json')); } catch {}
    }
    broadcastActiveSessions();
  });
}

// Read/write session metadata
function readSessionMeta(sockName) {
  try { return JSON.parse(fs.readFileSync(path.join(META_DIR, sockName + '.json'), 'utf-8')); } catch { return {}; }
}
// Tombstones (2.89.1): teardown deletes the meta, but debounced/straggler
// writers (status flush, todo coalesce, attribution) can fire AFTER the delete
// and resurrect the file from a PARTIAL object — observed as metas with
// sessionId/sockName null, which then confuse the next restore (a real
// restart-data-loss chain). sockNames are unique per spawn, so a deleted one
// is never legitimately written again.
const _metaTombstones = new Map(); // sockName → deletedAt
// COLLISION DETECTOR (a fleet user's 2026-08-11 incident, root-fixed in 2.302.0 —
// this is the belt): a session-meta file belongs to ONE webui session. If a
// write would land on a file already owned by a DIFFERENT session, two
// sessions are sharing a sockName and the identity fields are about to
// cross — that is how a session ended up carrying ANOTHER conversation's
// claudeSessionId (and then resuming the wrong, possibly-live conversation:
// the double-writer hazard, not a cosmetic bug). Never silent.
function sessionMetaOwnerConflict(sockName, meta) {
  try {
    const prev = readSessionMeta(sockName);
    const a = prev && prev.webuiSessionId, b = meta && meta.webuiSessionId;
    if (a && b && a !== b) {
      console.error(`[session] META COLLISION on ${sockName}: owned by ${a}, written by ${b} — two sessions share a socket name (identity fields would cross)`);
      try { global.__vsMetric?.('session-meta-collision', 1); } catch {}
      return true;
    }
  } catch {}
  return false;
}
function writeSessionMeta(sockName, meta) {
  if (_metaTombstones.has(sockName)) return;
  sessionMetaOwnerConflict(sockName, meta);
  // SESSION-BRAIN step 1 (design §session-brain campaign): the buffer's OWNER
  // is EXPLICIT in every session record. Today the server writes
  // data/session-buffers/<id>.buf for every session including remote ones
  // (the relayed stdout) — 'server'. When session.open (R6) moves parsing +
  // buffer ownership device-side, those records say 'device' and the attach
  // path routes by THIS FIELD instead of assuming. Both readers work either
  // way; no behavior changes until a record actually says 'device'.
  if (meta && typeof meta === 'object' && !meta.bufferOwner) meta.bufferOwner = 'server';
  ensureDir(META_DIR);
  // tmp+rename (2.219.0): the most frequently written core store was the only
  // non-atomic one — an OOM kill mid-write left truncated JSON that poisoned
  // the next restore.
  const fp = path.join(META_DIR, sockName + '.json');
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, fp);
  try { recordUsageAttribution(meta); } catch {} // usage-ledger account-by-time
}
function deleteSessionMeta(sockName) {
  _metaTombstones.set(sockName, Date.now());
  if (_metaTombstones.size > 4096) _metaTombstones.delete(_metaTombstones.keys().next().value);
  try { fs.unlinkSync(path.join(META_DIR, sockName + '.json')); } catch {}
}

// ── SESSION LIVENESS (2026-09-09, the restore incident) ────────────────────
// A restored dtach session must STREAM without the user typing — that is the
// whole restart-survival promise. It stopped doing so because the daemon
// attach path FIRE-AND-FORGOT the open: `openSession()` resolves as soon as
// the `open-session` control frame is written, `handle.ready` (the daemon's
// `session-open` reply / `session-error` / pre-ready link death) was never
// awaited, and `setupSessionPty` ran on the shim regardless. An open that the
// daemon never completed is then a SILENTLY dead pty: no journal line, the
// session still LIVE in the sidebar, nothing to re-attach because the shim's
// onExit never fires either. Production (2026-09-08 22:20 PDT, v2.369.77):
// twelve sessions restored, one claude session showed "3 Bash · running…" for
// ~8 minutes while its wrapper kept appending to its buffer FILE, and the only
// thing that healed it was the ws input detector at 22:29:05 — i.e. the user
// typing. HONEST LIMIT: the journal proves neither a `session-error` nor an
// `[agentd] connection lost` in that window, so WHICH of the two silent shapes
// (a reply that never came, or one nobody was listening for) hit those
// sessions is not established; both are the same dead bridge and both are
// covered below.
//
// THE PROBE IS A READ, NOT A WRITE. `dtach -a <sock> -E -r winch` emits its
// redraw kickoff `\x1b[H\x1b[J` to the attaching client immediately even when
// the program inside is silent (MEASURED: 1 ms locally; 2–50 ms through the
// daemon over the mux; the terminal branch already strips it as the "attach
// preamble"). So a healthy attach ALWAYS produces a byte within milliseconds
// and a dead bridge never does — no stdin write, no wrapper cooperation, and
// it works for chat AND terminal sessions. Writing a probe LINE was rejected
// on measurement: chat-wrapper acks any stdin line but then forwards an
// unrecognised JSON line straight to claude's stdin and wraps a NON-JSON line
// as a user message (= a billed turn), and the sessions this probe exists for
// are by construction running the PREVIOUS release's wrapper (the 2.361.1
// version-skew class), so a new no-op verb cannot be assumed.
const ATTACH_PROBE_MS = 4000;     // >> the measured 2–50 ms first byte; see the confirm stage below
const ATTACH_PROBE_CONFIRM_MS = 600;
const ATTACH_PROBE_MAX_HEALS = 2; // a bounded heal, never a loop
const DEVICE_OPEN_READY_MS = 5000; // measured open-session→ready: 8 ms worst of 10 (sh), 2 ms (dtach -a), 11 ms for 12 concurrent

/** Did ANY byte arrive from this session's pty since `since`? (the ONE reader
 *  of the stamp — both liveness triggers ask it).
 *  `>=`, not `>`: the stamp has MILLISECOND granularity and both callers take
 *  `since` immediately before the thing they are timing, so a byte landing in
 *  that same millisecond is the byte they are waiting for. The tie must fall
 *  on "alive" because the healing side of it RESENDS the user's input — the
 *  echo of a local terminal really can come back inside the same ms as the
 *  write, and a duplicated keystroke is a worse answer than a missed heal we
 *  get another chance at 4.6 s later. (The predicate this replaced compared a
 *  monotone byte COUNT and had no tie to lose.) */
function ptyQuietSince(session, since) { return !(Number(session._lastPtyDataAt) >= since); }

/** THE ONE local re-attach — both liveness triggers land here (the attach
 *  probe below, and ws-handler's broken-stdin detector after a user input).
 *  The TRIGGERS differ because the evidence differs (no bytes since attach vs
 *  no ack + no bytes since the write); the HEALING is one implementation.
 *  Deliberately local: the daemon is the thing under suspicion. */
function reattachLocalPty(id, session, why, { resend = null } = {}) {
  if (!activeSessions.has(id) || !session.socketPath) return false;
  console.log(`[${id}] ${why} — re-attaching dtach locally`);
  try { global.__vsEvent?.('pty-reattach-local', why); } catch { }
  if (session.pty) { try { session.pty.kill(); } catch { } }
  const newPty = pty.spawn(DTACH_CMD, ['-a', session.socketPath, '-E', '-r', 'winch'], {
    name: 'xterm-256color', cols: 120, rows: 30,
    env: { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  setupSessionPty(session, id, newPty);
  if (resend != null) setTimeout(() => { try { newPty.write(resend + '\n'); } catch { } }, 500);
  return true;
}

// Attach a PTY to an existing dtach socket for I/O.
// opts.repaint (the RE-attach path): dtach replays nothing on attach and a
// plain shell never repaints, so after healing the bridge we push the buffer
// FILE tail (clear + replay) to attached clients — a daemon self-upgrade
// re-exec otherwise left visually-blank terminals until a page reload.
function attachToDtach(id, socketPath, session, { repaint = false } = {}) {
  const repaintClients = () => {
    if (!repaint || session.mode === 'chat') return;
    try {
      const buf = fs.readFileSync(path.join(BUFFERS_DIR, id + '.buf'));
      const tail = buf.length > 200000 ? buf.subarray(buf.length - 200000) : buf;
      const data = '\x1b[2J\x1b[3J\x1b[H' + tail.toString('utf-8');
      session.buffer = tail.toString('utf-8').slice(-50000);
      broadcastToSession(session, id, { type: 'output', sessionId: id, data });
    } catch { /* no buffer file — nothing to repaint */ }
  };
  // Arm the liveness probe for THIS attach: if the bridge produced no byte at
  // all, heal it locally. The confirm stage exists because a blocked event
  // loop runs the timers phase before the poll phase — a 30 s boot stall
  // (measured in the incident journal) would otherwise fire the verdict ahead
  // of bytes that had long since arrived on the socket.
  // `since` is a PARAMETER because the device path stamps bytes it buffered
  // BEFORE the shim existed (see the early-data replay below): the window the
  // probe judges has to start when the BRIDGE was opened, not when the last
  // line of wiring ran, or a preamble we successfully caught reads as silence.
  const armProbe = (ptyProcess, via, since = Date.now()) => {
    const verdict = () => {
      if (!activeSessions.has(id) || session.pty !== ptyProcess) return;   // replaced/torn down — not ours to judge
      // The attach preamble landed: this bridge is alive. Clear the heal
      // counter — the bound below is on CONSECUTIVE silent attaches, the same
      // shape as `_reattachAttempts`, which the terminal branch resets on
      // data. A lifetime cap would spend a long-lived session's two heals on
      // two unrelated daemon hiccups days apart and then leave the third one
      // dark until somebody typed, which is the incident.
      if (!ptyQuietSince(session, since)) { session._attachProbeHeals = 0; return; }
      if (!ptyProcess._daemon) {
        // A local dtach -a that produced nothing means the SOCKET is stale;
        // re-attaching locally again would only repeat it, and the pty's own
        // exit drives the bounded re-attach ladder. Say so once.
        console.warn(`[${id}] local dtach attach produced no output within ${ATTACH_PROBE_MS + ATTACH_PROBE_CONFIRM_MS} ms (${via}) — the dtach socket may be stale`);
        try { global.__vsEvent?.('pty-attach-silent', via); } catch { }
        return;
      }
      session._attachProbeHeals = (session._attachProbeHeals || 0) + 1;
      if (session._attachProbeHeals > ATTACH_PROBE_MAX_HEALS) {
        console.warn(`[${id}] device pty still silent after ${ATTACH_PROBE_MAX_HEALS} local re-attach(es) — giving up on this attach (${via})`);
        return;
      }
      reattachLocalPty(id, session, `no byte from the device pty within ${ATTACH_PROBE_MS + ATTACH_PROBE_CONFIRM_MS} ms of attach (${via})`);
    };
    setTimeout(() => {
      if (!activeSessions.has(id) || session.pty !== ptyProcess) return;
      if (!ptyQuietSince(session, since)) return;
      setTimeout(verdict, ATTACH_PROBE_CONFIRM_MS);
    }, ATTACH_PROBE_MS);
  };
  const localAttach = () => {
    const attachPty = pty.spawn(DTACH_CMD, ['-a', socketPath, '-E', '-r', 'winch'], {
      name: 'xterm-256color', cols: 120, rows: 30,
      env: { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    setupSessionPty(session, id, attachPty);
    repaintClients();
    armProbe(attachPty, 'local');
  };
  // M1: daemon owns the pty when enabled — the dtach attach runs INSIDE agentd
  // and relays over the mux. On ANY failure fall back to the local pty so a
  // daemon hiccup never loses a session.
  //
  // BOOT ORDERING (the incident's second half): server.js starts
  // `deviceMgr.connect()` and calls restoreSessions() on the very next lines,
  // so on a cold boot the daemon link is still being established — in the
  // production journal the connect was in flight for the WHOLE restore
  // (`spawned local daemon` 22:20:56, `routing ENABLED` 22:21:02, restore
  // 22:20:22–22:20:53) and the link it finally produced had just streamed a
  // new bundle into the old daemon and waited out its re-exec. A restored
  // dtach session relays NOTHING while unattached and dtach replays nothing
  // afterwards, so the continuity-preserving answer is to take the daemon
  // path only when the link is ALREADY live: a local pty is available in the
  // SAME TICK, with no blind window and no migration churn.
  // Of the two options the task named, this one and not "connect first":
  // awaiting the link would put that whole 40 s (spawn + version handshake +
  // bundle upload + re-exec, MEASURED in the journal above) in front of every
  // session's restore, and a daemon that never comes up would stall the boot
  // that exists to bring those sessions back. Migrating a working local pty
  // onto the daemon after 'routing ENABLED' was rejected for the same reason
  // the gate exists: it is a teardown + re-attach on a bridge that is already
  // relaying, i.e. a second blind window bought for nothing.
  // WHAT THIS COSTS, precisely: `attachToDtach` has exactly two callers —
  // boot-restore (gated local by the above) and the re-attach ladder in
  // setupSessionPty's onExit, which fires long after 'routing ENABLED' and
  // still takes the daemon. New sessions never took this path at all:
  // ws-create spawns `dtach -c` under its own node-pty.
  const deviceMgr = getDeviceMgr();
  if (deviceMgr && !session.host && deviceMgr.status?.().connected) {
    // OBSERVE THE OPEN. `handle.ready` resolves on the daemon's `session-open`
    // and rejects on `session-error` / pre-ready link death (2.271.0 T1-6) —
    // fire-and-forget made both of those a dead bridge nobody could see.
    let abandoned = false;
    deviceMgr.openSession({
      cmd: DTACH_CMD, args: ['-a', socketPath, '-E', '-r', 'winch'], cols: 120, rows: 30,
      // The daemon merges this over its OWN process env in spawnEnv(), which
      // is the right base here: the local branch's `process.env` reaches
      // NOTHING in attach mode — measured, `/usr/bin/dtach` imports no
      // getenv/secure_getenv and carries no env-var name strings; its only
      // env consumer is execvp, which runs on `-c`/`-n` CREATE only, and the
      // agent CLI lives inside the dtach MASTER with the env it was spawned
      // with. Shipping the whole server env over the mux on every attach
      // would put every secret in it into a control frame for no effect.
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    }).then((h) => {
      // CATCH THE BYTES THAT ARRIVE BEFORE THERE IS A LISTENER. The mux
      // dispatches a whole socket read synchronously, so a `session-open`
      // control frame and the dtach preamble that follows it can land in the
      // SAME read; `ready` is a promise, so it settles a microtask later and
      // `handle.onData` is still null when that data frame is dispatched — it
      // would be dropped on the floor. Harmless for a chatty session, fatal
      // for the probe's evidence on a SILENT one (an idle claude waiting on a
      // prompt emits nothing else), which would make a healthy daemon heal on
      // every attach. Buffer here, replay once the shim's listeners exist.
      const early = [];
      h.onData = (buf) => early.push(buf);
      h._earlyData = early;
      // Handle the rejection here too, so a `ready` nobody raced is never an
      // unhandled rejection; and if we already fell back, kill the late open
      // so two dtach clients never relay the same session twice.
      h.ready.then(() => { if (abandoned) { try { h.kill(); } catch { } } }, () => { });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`device did not answer open-session within ${DEVICE_OPEN_READY_MS} ms`)), DEVICE_OPEN_READY_MS);
        h.ready.then(() => { clearTimeout(t); resolve(h); }, (e) => { clearTimeout(t); reject(e); });
      }).catch((e) => { abandoned = true; try { h.kill(); } catch { } throw e; });
    }).then((h) => {
      const openedAt = Date.now();
      const shim = daemonPtyShim(h);   // reassigns h.onData to its listener SET
      setupSessionPty(session, id, shim);
      for (const buf of (h._earlyData || []).splice(0)) { try { h.onData(buf); } catch { } }
      repaintClients();
      armProbe(shim, 'device', openedAt);
    }).catch((e) => {
      console.warn(`[device] ${id}: session attach failed (${e.message}) — local pty fallback`);
      try { global.__vsEvent?.('pty-device-open-failed', e.message); } catch { }
      localAttach();
    });
    return;
  }
  localAttach();
}

// On startup, reconnect to existing dtach sockets
  return { setupSessionPty, attachToDtach, readSessionMeta, writeSessionMeta,
    deleteSessionMeta, sessionMetaOwnerConflict, _metaTombstones,
    applyTaskToolUpdate, emitTaskListTodos, updateSessionTodos,
    reattachLocalPty, ptyQuietSince }; // the ONE healer + the ONE liveness reader (ws-handler's input detector shares both)
}
module.exports = { create };
