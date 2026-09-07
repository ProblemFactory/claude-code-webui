/**
 * WebSocket connection handler — terminal/chat I/O, session create/attach/kill,
 * state sync, layout sync, tmux attach, permission/interrupt control.
 */

const { MessageManager } = require('./message-manager');
const { createMessageManager, feedLive, feedPeerCard, rebuildHistory } = require('./normalizers');
const { createWsHeartbeat } = require('./server/ws-heartbeat');
const { listCodexThreads } = require('./codex-session-store');
const { findCodexSessionJsonlPath, extractCodexThreadMeta } = require('./adapters/codex');
const { cwdToProjectDir, findSessionJsonlPath } = require('./session-store');
const { get: harnessOf } = require('./harnesses'); // S3: store.warmTranscript per harness (claude parse-cache warm / codex thread/read fallback)
const { capsOf } = require('./backend-caps');      // inputModes.queueVerbs / review / renameWriteback gates (never a backend-id branch)
const { reconcileAttachStreaming } = require('./turn-state'); // §2.5: ONE attach-time streaming decision, shared with the live consumer

/** The sentence a harness-level verb refusal carries. Every branch says what
 *  happens to the message ANYWAY — a refusal that only says "no" leaves the
 *  user wondering whether their message is lost (the no-silent-failures rule
 *  applies to the WORDING too). English here like every other server notice;
 *  the client renders the sentence as it arrives. */
function queueVerbRefusal(op, label) {
  switch (op) {
    case 'steer':
    case 'steer-all':
      return `${label} cannot steer: a message sent during a turn runs after it. You can remove it instead.`;
    case 'reorder':
      return `${label} cannot reorder its queue — queued messages run in the order they were sent.`;
    case 'edit':
      return `${label} cannot edit a queued message — remove it and send a new one.`;
    case 'run-now':
      return `${label} cannot start a queued message early — it runs when the current turn ends.`;
    case 'run-all':
      return `${label} cannot run its queue early — the messages run when the current turn ends.`;
    default:
      return `${label} has no queue action "${op}".`;
  }
}
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createWsCreateHandler } = require('./ws-create');
// Remote twin of the LOCAL ambient-oat strip (B-211a AGENT_ENV_DROP): a host
// profile exporting CLAUDE_CODE_OAUTH_TOKEN silently re-bills EVERY remote
// spawn (top precedence in the CLI's credential getter) — the local spawn env
// deletes it, but `sh -lc` re-sources the host's profiles. Runs after profile
// sourcing, before the command-prefix assignments (a deliberate oat spawn's
// own `CLAUDE_CODE_OAUTH_TOKEN="$(cat …)"` prefix survives an earlier unset).
// AMBIENT_OAT_UNSET moved into buildRemoteExec (src/remote-shell.js, 2.279.0) —
// every spawn line gets it structurally instead of by five hand-edits.

// Crash-loop detector state (2.207.0): conversation id → recent create times
const crashLoopRef = {};
// Unresumable-conversation circuit breaker (2.207.1): conversation ids whose
// resume died with the CLI's "No conversation found with session ID" — the
// transcript does not exist on the target machine (a session killed before
// its first message ever flushes has NO transcript, forever). Server.js
// stamps entries at teardown; the create case refuses further resumes for
// 10 minutes with a CLEAR error instead of feeding a bootloop (real
// incident: 5 auto-recreations in 2 minutes, each dying in ~2s).
const noConvoRef = { map: new Map() };

// Unknown ws message types (the switch's `default:` case, Plugin Ph1 —
// design-harness-plugins §3.1: the switch had no default, so a typo'd or
// newer-client type was silently ignored and the sender waited forever with
// no signal anywhere). Per type per boot: the first sighting logs and later
// ones re-log at most every 10 minutes carrying the running count — a chatty
// stale client cannot flood the journal, and one line is enough to find it.
// Every occurrence is a telemetry event (Diagnostics).
const UNKNOWN_WS_TYPE_LOG_MS = 10 * 60 * 1000;
const unknownWsTypes = new Map(); // type label → { n, lastLogAt }
const unknownTypeLabel = (t) => (typeof t === 'string' ? t : String(t)).slice(0, 80);
function noteUnknownWsType(telemetry, type) {
  const label = unknownTypeLabel(type);
  const rec = unknownWsTypes.get(label) || { n: 0, lastLogAt: 0 };
  rec.n++;
  const now = Date.now();
  if (now - rec.lastLogAt >= UNKNOWN_WS_TYPE_LOG_MS) {
    rec.lastLogAt = now;
    console.warn(`[ws] unknown message type "${label}" (${rec.n}× this boot) — replied error/unknown-type`);
  }
  unknownWsTypes.set(label, rec);
  try { telemetry?.record({ kind: 'event', name: 'ws-unknown-type', detail: label }); } catch {}
  return rec;
}

// ── Server-runtime env must NEVER reach an agent session (2.227.12) ──
// A session inherits `process.env` so the CLI sees the user's PATH etc. — but
// the container's env also carries (a) OPERATIONAL vars that break the agent's
// own work and (b) the instance's SECRETS.
//   (a) real report: `NODE_ENV=production` made every `npm install` the agent
//       ran silently skip devDependencies, and `PORT=3456` (the server's own
//       listen port, set by the image) was inherited by dev servers the agent
//       started. npm_* leaks the same way when the server was started via npm.
//   (b) the helm chart injects VIBESPACE_PASSWORD (the login password!),
//       S3/CephFS/Drive/frps credentials and the telemetry token — an agent
//       could read all of them with one `env`.
// Everything the agent legitimately needs is set EXPLICITLY after this strip
// (VIBESPACE_API / _SESSION_TOKEN / _TASK_ID / remote-transport hints), so the
// allowlist only has to cover vars set elsewhere and passed through.
const AGENT_ENV_KEEP = new Set([
  'VIBESPACE_API', 'VIBESPACE_SESSION_TOKEN', 'VIBESPACE_TASK_ID',
  'VIBESPACE_REMOTE_SID', 'VIBESPACE_REMOTE_RETRY', 'VIBESPACE_KEEPER_DIR',
  'VIBESPACE_INSTANCE_NAME', 'VIBESPACE_DEVICE_ROOT', 'VIBESPACE_AGENTD_ROOT',
]);
// CLAUDE_CODE_OAUTH_TOKEN has TOP precedence in the CLI's credential getter
// (verified 2.1.225) — an ambient copy would silently re-bill every spawn and
// leak a subscription token into agent child envs. Deliberate oat spawns
// re-add it via spawnAccount.localEnv AFTER the strip.
const AGENT_ENV_DROP = new Set(['PORT', 'HOST', 'NODE_ENV', 'NODE_OPTIONS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']);
function agentEnv(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (AGENT_ENV_DROP.has(k)) continue;
    if (k.startsWith('npm_')) continue;                       // nested-npm hazard
    if (k.startsWith('VIBESPACE_') && !AGENT_ENV_KEEP.has(k)) continue; // secrets + server config
    out[k] = v;
  }
  return out;
}


function getSessionKey(session = {}) {
  const backend = session.backend || 'claude'; // fallback needed: called with API data too
  const backendSessionId = session.backendSessionId || session.sessionId || session.claudeSessionId || null;
  return backendSessionId ? `${backend}:${backendSessionId}` : '';
}

// Terminal QUERY-RESPONSE sequences xterm.js auto-emits when an app queries the
// terminal: CPR/DECXCPR (\e[n;mR), DA1/DA2 (\e[?…c / \e[>…c), DSR-ok (\e[0n),
// DECRPM (\e[?n;m$y), OSC 4/10/11/12 color reports, DCS replies (XTVERSION/
// XTGETTCAP/DECRQSS/DA3). Used by the 'input' case to arbitrate multi-client
// answers — keep in sync with TERM_QUERY_RESP_RE in src/lib/terminal.js.
const TERM_QUERY_RESP_RE = /\x1b\[\??\d+(?:;\d+){0,2}R|\x1b\[[?>][\d;]*c|\x1b\[0n|\x1b\[\?\d+;\d+\$y|\x1b\](?:4|1[0-2]);[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

function normalizeComparablePath(pathLib, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return pathLib.resolve(raw); } catch { return raw; }
}

function pickCodexThreadCandidate({ activeSessions, webuiSessionId, cwd, createdAt, baselineThreadIds, pathLib }) {
  const targetCwd = normalizeComparablePath(pathLib, cwd);
  if (!targetCwd) return null;

  const reservedThreadIds = new Set();
  for (const [otherId, otherSession] of activeSessions || []) {
    if (otherId === webuiSessionId) continue;
    if ((otherSession.backend || 'claude') !== 'codex') continue;
    const reservedId = otherSession.backendSessionId || otherSession.claudeSessionId || otherSession._captureReservedThreadId || null;
    if (reservedId) reservedThreadIds.add(reservedId);
  }

  const candidates = listCodexThreads({ activeSessions })
    .map((entry) => {
      const threadId = entry.backendSessionId || entry.sessionId || null;
      if (!threadId || reservedThreadIds.has(threadId)) return null;
      if (baselineThreadIds instanceof Set && baselineThreadIds.has(threadId)) return null;

      const entryCwd = normalizeComparablePath(pathLib, entry.cwd);
      if (!entryCwd || entryCwd !== targetCwd) return null;

      const startedAt = Number(entry.startedAt) || 0;
      return {
        entry,
        startedAt,
        ageDelta: Math.abs((startedAt || createdAt || Date.now()) - (createdAt || Date.now())),
        recent: startedAt >= ((createdAt || 0) - 5 * 60 * 1000),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.recent !== b.recent) return a.recent ? -1 : 1;
      if (a.ageDelta !== b.ageDelta) return a.ageDelta - b.ageDelta;
      return b.startedAt - a.startedAt;
    });

  return candidates[0]?.entry || null;
}

// Async exec that KEEPS execFileSync's throw-on-failure contract (the remote
// spawn path's catch blocks depend on it) while never blocking the event loop
// — the 2.242.0 instance-freeze lesson applied to the create ladder (P1 of the
// lag/CS audit: four ssh round trips ran SYNC on the loop, so one wedged host
// froze the whole server for up to 20s per spawn). stdin errors are swallowed
// on the STREAM (2.241.1 rule: pipe errors arrive as stream 'error' events).
const { REMOTE_PRELUDE, nodeFinder, buildRemoteExec } = require('./remote-shell.js');
const { sweepWriters } = require('./writer-sweep.js');
const { wrapperCaps, LEGACY_QUEUE_VERBS, QUEUE_EDIT_MAX_CHARS, QUEUE_OP_MAX_BYTES } = require('./server/wrapper-files.js');

function execFileAsync(cmd, args, { input, timeout = 20000, maxBuffer = 8 * 1024 * 1024, encoding = 'buffer' } = {}) {
  return new Promise((resolve, reject) => {
    const cp = require('child_process').execFile(cmd, args, { timeout, maxBuffer, encoding },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
    cp.stdin?.on('error', () => { });
    cp.stdout?.on('error', () => { });
    if (input != null) { try { cp.stdin.end(input); } catch { } } else { try { cp.stdin.end(); } catch { } }
  });
}

// The EXPLICIT ctx contract (拆分P2): every dependency registerWsHandler and
// the extracted case handlers consume. Validated at registration — a missing
// key is a LOUD boot error naming itself, never a silent undefined at the
// bottom of a 1600-line create path. scripts/test-ws-contract.mjs pins the
// destructure below, this list, and server.js's call site to each other.
const WS_CTX_CONTRACT = [
  'activeSessions', 'WS_OPEN', 'broadcastActiveSessions', 'broadcastToSession', 'resizeSessionToMin',
  'setupSessionPty', 'refreshWebuiPids', 'deleteSessionMeta', 'writeSessionMeta', 'readSessionMeta', 'autoResume',
  'readLayouts', 'writeLayouts', 'getSyncStore', 'serverSetting', 'integrationEnabled', 'agentdRemote', 'dialBridge',
  'sessionCounterRef', 'createSessionMessages', 'poolChooser', 'sbNoteServerOp',
  'SOCKETS_DIR', 'BUFFERS_DIR', 'PTY_WRAPPER', 'CHAT_WRAPPER',
  'NODE_CMD', 'DTACH_CMD', 'ENV_CMD', 'CLAUDE_CMD', 'EDITOR_CMD', 'AGENT_BIN_DIR', 'PORT', 'X_ENV',
  'adapterRegistry', 'pty', 'path', 'fs', 'os', 'execFileSync', 'ensureDir', 'hosts',
  'accounts', 'scheduleCtxSync', 'activeSessionsPayload',
  'USAGE_STATUSLINE_CMD', 'userStatuslineCmd', 'serverNotice', 'otelEnv', 'telemetry',
];

function registerWsHandler(wss, ctx) {
  const missing = WS_CTX_CONTRACT.filter((k) => !(k in ctx));
  if (missing.length) throw new Error('[ws-handler] ctx contract violated — missing: ' + missing.join(', '));
  const {
    activeSessions, WS_OPEN, broadcastActiveSessions, broadcastToSession, resizeSessionToMin,
    setupSessionPty, refreshWebuiPids, deleteSessionMeta, writeSessionMeta, readSessionMeta, autoResume,
    readLayouts, writeLayouts, getSyncStore, serverSetting, integrationEnabled, agentdRemote, dialBridge,
    sessionCounterRef, createSessionMessages, poolChooser, sbNoteServerOp,
    SOCKETS_DIR, BUFFERS_DIR, PTY_WRAPPER, CHAT_WRAPPER,
    NODE_CMD, DTACH_CMD, ENV_CMD, CLAUDE_CMD, EDITOR_CMD, AGENT_BIN_DIR, PORT, X_ENV,
    adapterRegistry, pty, path, fs, os, execFileSync, ensureDir, hosts,
    accounts, scheduleCtxSync, activeSessionsPayload,
    USAGE_STATUSLINE_CMD, userStatuslineCmd, otelEnv, telemetry,
  } = ctx;

  // Monotonic sequence for layout-sync rebroadcasts (shared across all
  // connections; resets on server restart — clients reset their counter on WS
  // reconnect, which a server restart always forces).
  const layoutSyncSeqRef = { value: 0 };

  // 'create' case family — extracted to src/ws-create.js (拆分P2). Handler is
  // connection-agnostic; ws/data/attachedSessions ride per call.
  const handleCreate = createWsCreateHandler({
    ctx, agentEnv, crashLoopRef, noConvoRef, execFileAsync,
    pickCodexThreadCandidate, getSessionKey, normalizeComparablePath,
  });

  // Shared by the dial + ssh terminate legs: a kill we could not confirm on
  // the machine must reach the USER (静默失败零容忍), not just the log.
  const notifyKillUnconfirmed = (hostName) => {
    try {
      ctx.serverNotice?.(`kill-unconfirmed:${hostName}`,
        `Couldn’t confirm the session was stopped on ${hostName} — it may still be running there. Check the machine’s sessions in the sidebar.`,
        { level: 'warn' });
    } catch { }
  };

  // Heartbeat: without ping/pong a half-open WS (network blip, sleep/wake,
  // the OOM-induced unresponsiveness from heavy local jobs) is NOT detected
  // by the server — the dead ws lingers in every session.clients map for the
  // full TCP keepalive window (~2h), and its stale size keeps shrinking the
  // PTY via resizeSessionToMin. Ping every 30s; a client that misses two
  // consecutive pongs is terminated, which fires 'close' and cleans it up.
  // STALL-AWARE (2.369.16, userW inc-mtndq0vb): a pong that "never came"
  // while OUR OWN event loop was blocked is not evidence the client died —
  // the old tick terminated userW's live client right after a 4-minute
  // history-rebuild stall and dropped every inbound frame queued on that
  // socket (the second attach, two kills). src/server/ws-heartbeat.js.
  if (!wss._heartbeatTimer) createWsHeartbeat(wss).start();

  wss.on('connection', (ws) => {
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });
    const attachedSessions = new Set();

    // Send current active sessions on connect — THE SAME payload builder as
    // broadcastActiveSessions (a second hardcoded field list here silently
    // dropped every later-added field — auth/account/todo badges were dead
    // after a server-restart reconnect until the next organic broadcast).
    ws.send(JSON.stringify({ type: 'active-sessions', sessions: activeSessionsPayload() }));

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      try {
        await handleMessage(data);
      } catch (err) {
        // A malformed/unexpected client message must never crash the server
        // (observed: array extraArgs → .trim() TypeError killed the process).
        console.error('[ws] message handler error:', err.message, '| type:', data?.type);
        try { ws.send(JSON.stringify({ type: 'error', message: 'Internal error handling ' + (data?.type || 'message'), sessionId: data?.sessionId })); } catch {}
      }
    });

    async function handleMessage(data) {
      switch (data.type) {
        case 'create': {
          await handleCreate(ws, data, attachedSessions);
          break;
        }
        case 'set-permission-mode': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && data.mode) {
            const adapter = adapterRegistry.get(session.backend);
            // Claude answers with a real success/error control_response
            // (2.1.215 refuses bypassPermissions unless launched
            // bypass-capable) — track the request id so the stdout parser
            // can adopt the mode on success / tell the client on refusal.
            // The old fire-and-forget left session._permissionMode stale AND
            // swallowed the refusal (the badge then flipped back on the next
            // per-message init and read as "switching is broken").
            const tracked = adapter?.buildTrackedSetPermissionMode?.(data.mode);
            if (tracked) {
              const pend = (session._pendingModeReqs ||= new Map());
              pend.set(tracked.requestId, { mode: data.mode, ts: Date.now() });
              for (const [rid, p] of pend) if (Date.now() - p.ts > 120000) pend.delete(rid);
              session.pty.write(tracked.line + '\n');
            } else if (adapter) {
              session.pty.write(adapter.formatSetPermissionMode(data.mode) + '\n');
            }
          }
          break;
        }

        case 'set-model': {
          { const s2 = activeSessions.get(data.sessionId); if (s2) { s2._pickedModel = data.model || null; s2._pickedModelAt = Date.now(); if (data.model) s2._modelOrigin = 'chosen'; try { writeSessionMeta(s2.sockName, { ...readSessionMeta(s2.sockName), pickedModel: s2._pickedModel, pickedModelAt: s2._pickedModelAt, modelOrigin: s2._modelOrigin || null }); } catch { } } }
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && (data.model || 'lock' in data)) {
            const adapter = adapterRegistry.get(session.backend);
            try {
              if (data.model && adapter?.formatSetModel) session.pty.write(adapter.formatSetModel(data.model) + '\n');
              // Model LOCK v2 (#6, user-corrected semantics): fallback stays
              // ALLOWED — the lock records the TARGET model, and the server
              // re-pins it via set_model at every turn end where the served
              // model drifted (maybeRepinLockedModel in server.js). So a
              // safety-reroute completes the flagged turn on the fallback,
              // but every subsequent turn re-attempts the original model.
              if ('lock' in data) {
                session._modelLocked = !!data.lock;
                session._lockedModel = data.lock ? (data.lockModel || session._servedModel || null) : null;
                if (session.sockName) { const m = readSessionMeta(session.sockName); writeSessionMeta(session.sockName, { ...m, modelLocked: session._modelLocked, lockedModel: session._lockedModel }); }
                broadcastActiveSessions();
              } else if (data.model && session._modelLocked) {
                // changing the model while locked re-targets the lock
                session._lockedModel = data.model;
                if (session.sockName) { const m = readSessionMeta(session.sockName); writeSessionMeta(session.sockName, { ...m, lockedModel: session._lockedModel }); }
              }
            } catch {}
          }
          break;
        }

        case 'set-effort': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && data.effort != null) {
            const adapter = adapterRegistry.get(session.backend);
            if (adapter?.formatSetEffort) {
              try {
                session.pty.write(adapter.formatSetEffort(data.effort) + '\n');
                // remembered for attach restore — the CLI never reports effort
                // back (claude), so the last COMMANDED value is what we show.
                // Persisted in session meta so it survives server restarts.
                session._effort = data.effort || null;
                // B-6b6d: a pick made INSIDE the session re-authors the origin —
                // otherwise the panel keeps calling a hand-changed value "this
                // conversation's own value" (the contradiction 2.369.58's r2
                // review removed from the response-style row).
                session._effortOrigin = 'chosen';
                if (session.sockName) {
                  const m = readSessionMeta(session.sockName);
                  writeSessionMeta(session.sockName, { ...m, effort: session._effort, effortOrigin: session._effortOrigin });
                }
              } catch {}
            }
          }
          break;
        }

        // LIVE RESPONSE STYLE (2.369.58). The per-session `outputStyle` slot is
        // harness-neutral; WHEN it can be applied is not, and that verdict lives
        // in the caps row, never in a backend id:
        //   · responseStyle.live === false (claude) ⇒ REFUSED here with the
        //     reason; the chip's menu shows "Restart now to apply" instead.
        //   · a value outside the harness's own vocabulary ⇒ REFUSED (the enum
        //     is closed upstream; sending it would fail server-side silently).
        //   · the RUNNING wrapper must advert it too (the 2.361.1/2.364.1 skew
        //     rule): a codex session spawned before this release drops the
        //     unknown stdin verb without a word.
        // Persisted to session meta + broadcast so every client's chip agrees.
        case 'set-response-style': {
          const session = activeSessions.get(data.sessionId);
          // TWO refusal codes, because they mean different things to the UI
          // (2.369.58 r2 — the 2.363.1 law: one error type with several meanings
          // must split by code): 'style-wrapper-old' = THIS session's wrapper
          // will never serve the verb ⇒ the client stops offering the live
          // switch and shows "Restart now to apply"; 'style-not-live' = every
          // other reason (dead session, spawn-only harness, unknown value, a
          // sidecar not written YET) ⇒ the client changes no capability belief.
          const refuse = (message, code = 'style-not-live') => { try { ws.send(JSON.stringify({ type: 'error', code, scope: 'action', sessionId: data.sessionId, error: message, message })); } catch { } };
          if (!session?.pty || session.mode !== 'chat') { refuse('This action needs a live chat session.'); break; }
          let label = session.backend;
          try { label = harnessOf(session.backend).label || label; } catch { }
          const rs = capsOf(session.backend).responseStyle || { live: false, closed: true, values: [] };
          if (!rs.live) { refuse(`${label} only reads its response style at startup — restart the session to apply a change.`); break; }
          const style = typeof data.style === 'string' ? data.style.trim() : '';
          // Only a CLOSED vocabulary may reject: an open one (user-defined
          // styles) would eat a value the harness understands perfectly well.
          if (style && rs.closed && !rs.values.includes(style)) { refuse(`${label} does not accept the response style "${style}" (it knows: ${rs.values.join(', ')}).`); break; }
          const wcaps = wrapperCaps(BUFFERS_DIR, data.sessionId, session.socketPath);
          if (!wcaps.responseStyle) {
            const started = wcaps.startedAt ? new Date(wcaps.startedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time';
            refuse(wcaps.reason === 'no-sidecar'
              ? 'This session\'s agent has not reported its capabilities yet (still starting up?) — try again in a moment.'
              : `This session's agent (started ${started}) predates the live style switch. Terminate + Resume the session to change it.`,
              wcaps.reason === 'no-sidecar' ? 'style-not-live' : 'style-wrapper-old');
            console.log(`[${data.sessionId}] set-response-style REFUSED: wrapper caps ${wcaps.reason} (pid ${wcaps.pid}, started ${wcaps.startedAt})`);
            break;
          }
          const adapter = adapterRegistry.get(session.backend);
          let payload;
          try { payload = adapter.formatSetResponseStyle(style); }
          catch (e) { refuse(e.message); break; }
          session.pty.write(payload + '\n');
          session._outputStyle = style || null;
          if (session.sockName) { try { const m = readSessionMeta(session.sockName); writeSessionMeta(session.sockName, { ...m, outputStyle: session._outputStyle }); } catch { } }
          broadcastToSession(session, data.sessionId, { type: 'response-style-updated', sessionId: data.sessionId, outputStyle: session._outputStyle, live: true });
          break;
        }

        case 'input': {
          const session = activeSessions.get(data.sessionId);
          if (!session?.pty) break;
          // Terminal query-response arbitration: with dtach every attached
          // browser client is a full terminal emulator, so an app's query
          // (\e[6n cursor pos, \e]11;? bg color, DA…) is answered by EVERY
          // client — the app consumes one answer and the tty ECHOES the extras
          // as literal "^[]11;rgb:…^[[3;1R" junk at the prompt (real report,
          // 2 clients attached). Responses are pure well-known sequences that
          // never share a chunk with typed input: forward them only from ONE
          // designated client (the size owner, else the oldest attached).
          // Known collision (accepted): modified-F3 is \e[1;2R = CPR shape —
          // a non-owner client's Shift+F3 in a multi-client session is eaten.
          const chunk = data.data;
          if (typeof chunk === 'string' && session.clients?.size > 1
              && chunk.includes('\x1b') && !chunk.replace(TERM_QUERY_RESP_RE, '')) {
            const owner = (session._sizeOwnerWs && session.clients.has(session._sizeOwnerWs))
              ? session._sizeOwnerWs : session.clients.keys().next().value;
            if (owner && owner !== ws) break;
          }
          session.pty.write(chunk);
          break;
        }

        case 'chat-input': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat') {
            const adapter = adapterRegistry.get(session.backend);
            if (!adapter) break;
            // New input means prior interrupt succeeded (or user proceeded) —
            // cancel any pending SIGINT fallback to avoid killing mid-stream.
            if (session._interruptTimer) {
              clearTimeout(session._interruptTimer);
              session._interruptTimer = null;
            }
            const msgId = data.msgId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
            // NOTE: the user's message text is sent VERBATIM. Task context and
            // status-override notices are delivered through the harness's OWN
            // native hooks (SessionStart / UserPromptSubmit → vibespace-hook.mjs),
            // never by rewriting the user's input — modifying the message stream
            // is unstable and bypasses the CLI's mechanisms (user directive).
            let stdinPayload, userMsg;
            try { ({ stdinPayload, userMsg } = adapter.formatChatInput(data.text, msgId)); }
            catch (e) {
              // POISON GUARD tripped (2.360.0): a shredded frame must reach
              // the USER as an error, never the transcript as text.
              // code marks it a SEND refusal — without it the client's error
              // handler read EVERY per-session error as an attach failure and
              // flipped the LIVE window read-only (inc-mt2arppw, userW: "发消息
              // 就会直接中断"), and the text rode a field the client never read.
              try { ws.send(JSON.stringify({ type: 'error', code: 'input-rejected', sessionId: data.sessionId, error: e.message, message: e.message })); } catch { }
              break;
            }
            // Large frames (image pastes) ride a FILE, not the pty stdin —
            // multi-MB single lines get shredded by the pty/dtach channel
            // (the 79928a2b 38MB poisoning; local chat only — a remote
            // wrapper can't see this filesystem). The condition is TRANSPORT
            // + CAPABILITY, never a backend id: until design-harness-plugins
            // §1 P1 it also excluded the codex backend by id, which left the
            // shredding class OPEN for codex (its wrapper had no _frame_file
            // verb and dropped unparseable lines silently) instead of letting
            // the capability gate below say "old wrapper" honestly.
            let payloadLine = stdinPayload;
            if (stdinPayload.length > 64 * 1024 && !session.host && session.socketPath) {
              // WRAPPER CAPABILITY GATE (2.361.1, the c1206711 lost-image
              // incident): the _frame_file pointer is only understood by
              // wrappers spawned from 2.360.0+ code. Wrappers are LONG-LIVED
              // (dtach survives updates) — an old wrapper forwards the pointer
              // verbatim to claude, which drops the unknown type SILENTLY and
              // the message vanishes (frame file orphaned). Capability = the
              // caps marker the wrapper writes into its SIDECAR at boot
              // (data/session-buffers/<id>.json, read through the collision-
              // aware resolver — 2.364.1: the 2.361.1 gate read the SERVER's
              // data/session-meta record, which never carries caps, so every
              // wrapper tested "old", every >1MB paste was refused for two
              // releases and the refusal sent users to Terminate+Resume
              // sessions that were already new; owner did it three times).
              // Unmarked wrappers keep the historical raw-stdin path (single-
              // screenshot sized frames rode it safely for months) and
              // anything past the shredding-risk range is REFUSED with a
              // visible, EVIDENCED error instead of lost (no-silent-failures
              // law). Only a POSITIVE verdict is cached — a wrapper still
              // booting a huge resume must not be locked out by its first read.
              let caps = null;
              if (session._wrapperFrameFile !== true) {
                caps = wrapperCaps(BUFFERS_DIR, data.sessionId, session.socketPath);
                if (caps.frameFile) session._wrapperFrameFile = true;
              }
              if (session._wrapperFrameFile === true) {
                try {
                  const fdir = path.join(__dirname, '..', 'data', 'chat-frames');
                  fs.mkdirSync(fdir, { recursive: true });
                  const fp = path.join(fdir, `${data.sessionId}-${Date.now()}.json`);
                  fs.writeFileSync(fp, stdinPayload);
                  payloadLine = JSON.stringify({ type: '_frame_file', path: fp });
                } catch (e) { console.log(`[${data.sessionId}] frame-file bypass failed (${e.message}) — falling back to direct stdin`); }
              } else if (stdinPayload.length > 1024 * 1024) {
                const mb = (stdinPayload.length / 1048576).toFixed(1);
                const started = caps?.startedAt ? new Date(caps.startedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time';
                const why = caps?.reason === 'no-sidecar'
                  ? 'its wrapper has not reported its capabilities yet (still starting up?) — wait a moment and send it again'
                  : `its wrapper (started ${started}) predates the frame-file update — Terminate + Resume the session, then send it again`;
                const refusal = `Message too large (${mb}MB) for this session: it was NOT sent — ${why}.`;
                console.log(`[${data.sessionId}] chat-input REFUSED (${mb}MB): wrapper caps ${caps?.reason} (pid ${caps?.pid}, started ${caps?.startedAt})`);
                try { ws.send(JSON.stringify({ type: 'error', code: 'input-rejected', sessionId: data.sessionId, error: refusal, message: refusal })); } catch { }
                break;
              }
            }
            session._isStreaming = true;
            // WORK (the default classification, round 4): the user took the
            // conversation over by hand — the one non-turn signal allowed to
            // clear the loop breaker, because a human at the keyboard is
            // exactly who the budget was protecting
            try { autoResume?.noteRecovered?.(data.sessionId, 'user sent a prompt'); } catch { }
            // /compact turn (2.365.0, the userN "Compaction canceled." case):
            // a large conversation compacts for 1–2 minutes behind a bare
            // "thinking…" spinner, and the CLI's ONLY "Compaction canceled."
            // path is an abort signal — one reflexive Stop click threw the
            // whole attempt away. Label the turn for every client (the label
            // resets with the turn like any other) so Stop can be guarded.
            if (typeof data.text === 'string' && /^\/compact\b/.test(data.text.trim())) {
              session._streamingLabel = 'Compacting context… (a large conversation takes 1–2 minutes — Stop cancels it)';
              session._streamingKind = 'compacting';
              broadcastToSession(session, data.sessionId, { type: 'streaming-label', sessionId: data.sessionId, label: session._streamingLabel, kind: 'compacting' });
            }
            session.pty.write(payloadLine + '\n');
            if (userMsg) {
              session.buffer = (session.buffer + JSON.stringify(userMsg) + '\n').slice(-500000);
              feedLive(session, userMsg);
            }
            // Detect broken pty stdin: the wrapper writes _stdin_ack on
            // stdout immediately when it receives stdin input. If no ack
            // AND no buffer growth within 5s, the stdin pipe is dead.
            // Both signals checked for compat with old wrappers that don't
            // send _stdin_ack (wrapper only updates on server restart).
            if (session.socketPath) {
              const inputPayload = payloadLine;
              const bufLenBefore = (session.buffer || '').length;
              session._stdinAckReceived = false;
              setTimeout(() => {
                if (!activeSessions.has(data.sessionId)) return;
                if (session._stdinAckReceived) return;
                // Fallback: if buffer grew, pty is working (old wrapper without ack)
                if ((session.buffer || '').length > bufLenBefore) return;
                console.log(`[${data.sessionId}] Broken pty stdin detected — re-attaching dtach`);
                if (session.pty) { try { session.pty.kill(); } catch {} }
                const newPty = pty.spawn(DTACH_CMD, ['-a', session.socketPath, '-E', '-r', 'winch'], {
                  name: 'xterm-256color', cols: 120, rows: 30,
                  env: { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
                });
                setupSessionPty(session, data.sessionId, newPty);
                setTimeout(() => { newPty.write(inputPayload + '\n'); }, 500);
              }, 5000);
            }
          }
          break;
        }

        // Auto-continue-after-limit: the live per-session toggle (2.368.0). The
        // wait itself lives server-side (src/server/auto-resume.js) so it
        // survives a reload, a reconnect and a server restart.
        case 'auto-resume': {
          const st = autoResume?.setEnabled?.(data.sessionId, !!data.enabled) || null;
          try { ws.send(JSON.stringify({ type: 'auto-resume', sessionId: data.sessionId, status: st })); } catch { }
          break;
        }

        // Manual codex quota actions (2.368.21): consume a stored reset
        // credit / on-demand rateLimits read — both ride the session's own
        // app-server via a wrapper stdin verb (official client makes the
        // fetch; §ban-safety). Result comes back on the normal event stream.
        case 'codex-reset-credit':
        case 'codex-read-limits': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && session.backend === 'codex') {
            try { session.pty.write(JSON.stringify({ type: data.type }) + '\n'); } catch { }
          } else {
            try { ws.send(JSON.stringify({ type: 'error', sessionId: data.sessionId, code: 'not-codex-chat', message: 'This action needs a live Codex chat session.' })); } catch { }
          }
          break;
        }

        case 'interrupt': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat') {
            const adapter = adapterRegistry.get(session.backend);
            if (adapter) {
              session.pty.write(adapter.formatInterrupt() + '\n');
              adapter.postInterrupt(session, data.sessionId);
            }
          }
          break;
        }

        // QUEUE OPS on a message the user sent mid-turn (remove / steer /
        // steer-all / reorder / edit / run-now / run-all). TWO gates, both
        // required:
        //   ① the HARNESS's verb table (`inputModes.queueVerbs` in
        //      backend-caps — never a backend id), i.e. what this KIND of
        //      agent can do at all;
        //   ② the RUNNING WRAPPER's own advert (`caps.queueVerbs` in the
        //      sidecar IT writes, read through wrapperCaps; a remote wrapper's
        //      sidecar lives on ITS machine, so the in-band verb list its
        //      queue publication carries is the fallback). A codex session
        //      spawned before this release wears ① and would answer ② with the
        //      three legacy verbs: its wrapper drops an unknown stdin verb
        //      SILENTLY — the 2.361.1/2.364.1 skew class, where a static
        //      capability was trusted for a long-lived process. Never cache a
        //      negative verdict (a wrapper resuming a huge thread writes its
        //      sidecar late) — this is a rare user action, so read it each time.
        // The reply is a CODED, `scope:'action'` error carrying a machine
        // `reason` as well as the sentence: the client renders it in-chat and
        // leaves the live window alone (the inc-mt2arppw rule).
        case 'queue-op': {
          const session = activeSessions.get(data.sessionId);
          // The refusal ECHOES the op and its id: this reply never becomes a
          // `queue_op_result` (the wrapper never saw the frame), so the id is
          // the only way the strip can find the row it marked pending and end
          // it (round-2 verifier — those rows spun forever).
          const refuse = (message, reason) => { try { ws.send(JSON.stringify({ type: 'error', code: 'queue-op-unsupported', reason: reason || 'unsupported', scope: 'action', sessionId: data.sessionId, op: data.op || null, id: data.id || null, error: message, message })); } catch { } };
          if (!session?.pty || session.mode !== 'chat') { refuse('This action needs a live chat session.', 'not-live'); break; }
          const adapter = adapterRegistry.get(session.backend);
          if (!adapter) { refuse(`No adapter for backend "${session.backend}".`, 'no-adapter'); break; }
          const modes = capsOf(session.backend).inputModes || {};
          const harnessVerbs = modes.queueVerbs || [];
          // harnessOf THROWS on an unknown id by design — the label is chrome,
          // so it degrades to the id rather than taking the socket down.
          let label = session.backend;
          try { label = harnessOf(session.backend).label || label; } catch { }
          if (!harnessVerbs.length) { refuse(`${label} owns its own input queue — VibeSpace cannot list or change it.`, 'no-queue-ops'); break; }
          if (!harnessVerbs.includes(data.op)) { refuse(queueVerbRefusal(data.op, label), 'verb-unsupported'); break; }
          // Sidecar advert OR the in-band proof: a REMOTE wrapper writes its
          // sidecar on ITS OWN machine, so `no-sidecar` there means "not local",
          // not "old" — but a wrapper that has actually published a queue on
          // this stream demonstrably serves the verbs it named in that
          // publication (and the legacy three if it named none).
          const wcaps = wrapperCaps(BUFFERS_DIR, data.sessionId, session.socketPath);
          const inBand = session._normalizer?.queueVerbsPublished?.();
          const served = wcaps.inputQueue ? wcaps.queueVerbs
            : (Array.isArray(inBand) ? inBand
              : (session._normalizer?.queuePublished?.() ? LEGACY_QUEUE_VERBS.slice() : null));
          if (!served) {
            const started = wcaps.startedAt ? new Date(wcaps.startedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time';
            refuse(wcaps.reason === 'no-sidecar'
              ? 'This session\'s agent has not reported its capabilities yet (still starting up?) — try again in a moment.'
              : `This session's agent (started ${started}) predates the input-queue update, so it cannot act on its queue: the message runs when the current turn ends. Terminate + Resume the session to get the controls.`, 'wrapper-no-queue');
            console.log(`[${data.sessionId}] queue-op ${data.op} REFUSED: wrapper caps ${wcaps.reason} (pid ${wcaps.pid}, started ${wcaps.startedAt})`);
            break;
          }
          if (!served.includes(data.op)) {
            refuse(`This session's agent is an older build that does not serve "${data.op}" — it serves ${served.join(', ')}. Terminate + Resume the session to get the newer controls.`, 'wrapper-verb-skew');
            console.log(`[${data.sessionId}] queue-op ${data.op} REFUSED: running wrapper serves [${served.join(',')}]`);
            break;
          }
          // SIZE, BEFORE THE FRAME IS BUILT: `edit` is the one verb that
          // carries user text, and this frame reaches the wrapper over RAW PTY
          // STDIN — the `input` case routes anything large through the frame
          // file precisely because a big pty write gets shredded (the
          // 79928a2b/c1206711 class). Refuse with evidence rather than send
          // something that may arrive in pieces; the client keeps the typed
          // text and re-opens the editor on the refusal.
          if (typeof data.text === 'string' && data.text.length > QUEUE_EDIT_MAX_CHARS) {
            refuse(`That edit is too long (${data.text.length.toLocaleString('en-US')} characters; the limit is ${QUEUE_EDIT_MAX_CHARS.toLocaleString('en-US')}): it was NOT saved. Shorten it, or remove the queued message and send a new one.`, 'text-too-long');
            break;
          }
          let payload;
          try {
            payload = adapter.formatQueueOp({
              op: data.op,
              id: data.id || null,
              // `afterId: null` MEANS the front of the queue — carry the key
              // only when the client actually sent one, so the adapter can
              // tell "front" from "no anchor" and refuse the latter.
              ...('afterId' in data ? { afterId: data.afterId === null ? null : String(data.afterId || '') } : {}),
              ...('text' in data ? { text: typeof data.text === 'string' ? data.text : '' } : {}),
            });
          }
          catch (e) { refuse(e.message, 'malformed'); break; }
          // …and the frame ITSELF, after JSON escaping (a control-char-heavy
          // string grows sixfold): the char cap above does not bound this one.
          if (payload.length > QUEUE_OP_MAX_BYTES) {
            refuse(`That queue action does not fit in one message to the agent (${payload.length.toLocaleString('en-US')} bytes; the limit is ${QUEUE_OP_MAX_BYTES.toLocaleString('en-US')}): it was NOT sent.`, 'frame-too-large');
            console.log(`[${data.sessionId}] queue-op ${data.op} REFUSED: frame ${payload.length}B over the ${QUEUE_OP_MAX_BYTES}B pty-stdin ceiling`);
            break;
          }
          session.pty.write(payload + '\n');
          break;
        }

        // Start a code review (§2.13). Gated on the HARNESS caps row, never on
        // a backend id — the client's own button already reads the mirror of
        // this row, and a server that disagreed would silently drop the frame.
        case 'review-start': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && capsOf(session.backend).review && data.target) {
            session.pty.write(JSON.stringify({
              type: 'review-start',
              target: data.target,
              delivery: data.delivery || undefined,
            }) + '\n');
          }
          break;
        }

        case 'permission-response': {
          // ASK cards raised by the OpenCode SERVE are answered on the serve's
          // OWN route (S9 remainder piece (b), B-eac2) — not on a session's
          // stdin, because the conversation may have no live process here at
          // all (a stopped conversation opened read-only still shows a pending
          // ask). The card forwards the `via` the record that created it
          // carried, so this layer never guesses a backend, and `host` makes
          // the answer land on the machine the serve runs on.
          if (data.via === 'opencode-serve') {
            const { access } = require('./server/opencode-access');
            const answers = (data.toolInput && data.toolInput.answers) || {};
            const act = data.approved
              ? access().call(data.host || null, 'answer', { requestId: data.requestId, answers })
              : access().call(data.host || null, 'reject', { requestId: data.requestId });
            act.catch((e) => {
              // a refused answer MUST reach the user: the card already flipped
              // itself to "answered" optimistically, so silence would be a lie.
              // `scope:'action'` is LOAD-BEARING (2.363.1, inc-mt2arppw): a
              // session-scoped `error` frame without it is read as "attach
              // failed" and flips the LIVE window into the read-only Resume
              // bar — an OpenCode question we could not answer must refuse ONE
              // ACTION, never condemn the conversation.
              try { ws.send(JSON.stringify({ type: 'error', scope: 'action', code: 'opencode-question', sessionId: data.sessionId, requestId: data.requestId, error: `OpenCode did not accept the answer: ${e.message}`, message: `OpenCode did not accept the answer: ${e.message}` })); } catch { }
            });
            break;
          }
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat') {
            const adapter = adapterRegistry.get(session.backend);
            if (adapter) {
              const payload = adapter.formatPermissionResponse(data);
              session.pty.write(payload + '\n');
              // Record in buffer so permission state survives refresh/restart
              session.buffer = (session.buffer + payload + '\n').slice(-500000);
              feedLive(session, JSON.parse(payload));
            }
          }
          break;
        }

        case 'set-goal': {
          const session = activeSessions.get(data.sessionId);
          if (session?.mode === 'chat') {
            if (data.action === 'status') {
              const goal = session._goal;
              const prev = session._prevGoal;
              let msg = goal ? `Goal active: ${goal}\n\`/goal clear\` to remove, \`/goal <new text>\` to replace.` : 'No goal set. Usage: `/goal <condition>`';
              if (!goal && prev) msg += `\nPrevious goal available — \`/goal resume\` to re-activate.`;
              ws.send(JSON.stringify({ type: 'goal-updated', sessionId: data.sessionId, goal: session._goal || null, statusMsg: msg }));
            } else if (data.action === 'resume') {
              const prev = session._prevGoal;
              if (!prev) {
                ws.send(JSON.stringify({ type: 'goal-updated', sessionId: data.sessionId, goal: null, statusMsg: 'No previous goal to resume.' }));
              } else {
                session._goal = prev;
                session._prevGoal = null;
                session._goalStatus = 'active';
                session._lastGoalStatusUuid = null; // fresh native goal → re-sync from JSONL
                if (session.pty) session.pty.write(JSON.stringify({ type: 'set-goal', goal: prev }) + '\n');
                broadcastToSession(session, data.sessionId, { type: 'goal-updated', sessionId: data.sessionId, goal: prev, goalStatus: 'active', statusMsg: `Goal resumed: ${prev}` });
              }
            } else {
              const goalText = data.goal || null;
              // Save the previous goal for /goal resume on BOTH clear and
              // replace (both backends natively replace an active goal:
              // Claude /goal swaps the Stop-hook condition; Codex
              // thread/goal/set updates/replaces, steering a running turn)
              if (session._goal && session._goal !== goalText) {
                session._prevGoal = session._goal;
                // /goal resume survives restarts (2.219.0): stash in session meta
                try { if (session.sockName) writeSessionMeta(session.sockName, { ...readSessionMeta(session.sockName), prevGoal: session._prevGoal }); } catch {}
              }
              if (session.pty) session.pty.write(JSON.stringify({ type: 'set-goal', goal: goalText }) + '\n');
              session._goal = goalText;
              session._goalStatus = goalText ? 'active' : null;
              session._goalElapsed = 0;
              session._lastGoalStatusUuid = null;
              const msg = goalText ? `Goal set: ${goalText}` : `Goal cleared`;
              broadcastToSession(session, data.sessionId, { type: 'goal-updated', sessionId: data.sessionId, goal: goalText, goalStatus: session._goalStatus, goalElapsed: 0, statusMsg: msg });
            }
          }
          break;
        }

        case 'rename-session': {
          const trimmedName = typeof data.name === 'string' ? data.name.trim() : '';
          let targetId = data.webuiId && activeSessions.has(data.webuiId) ? data.webuiId : null;
          if (!targetId) {
            for (const [sessionId, session] of activeSessions) {
              if (data.sessionKey && getSessionKey(session) === data.sessionKey) {
                targetId = sessionId;
                break;
              }
              if (data.backendSessionId && (session.backendSessionId || session.claudeSessionId) === data.backendSessionId) {
                targetId = sessionId;
                break;
              }
            }
          }
          if (!targetId) break;

          const session = activeSessions.get(targetId);
          if (!session) break;

          if (trimmedName) session.name = trimmedName;
          // Write the new name back into the AGENT's own store when the
          // harness has somewhere to write it (caps.renameWriteback — codex's
          // thread name; claude's JSONL has no title field). Never a backend id.
          if (capsOf(session.backend).renameWriteback && session.mode === 'chat' && session.pty && trimmedName) {
            session.pty.write(JSON.stringify({ type: 'set-thread-name', name: trimmedName }) + '\n');
          }
          if (session.sockName) {
            writeSessionMeta(session.sockName, {
              ...(readSessionMeta(session.sockName) || {}), // preserve keys not re-listed (agentToken/taskId/accountId)
              name: session.name,
              cwd: session.cwd,
              backend: session.backend,
              backendSessionId: session.backendSessionId,
              claudeSessionId: session.claudeSessionId || null,
              sourceKind: session.sourceKind || null,
              agentKind: session.agentKind || 'primary',
              agentRole: session.agentRole || '',
              agentNickname: session.agentNickname || '',
              parentThreadId: session.parentThreadId || null,
              permissionMode: session._permissionMode || null,
              effort: session._effort || null,
              createdAt: session.createdAt,
              webuiSessionId: targetId,
              mode: session.mode || 'terminal',
            });
          }
          broadcastActiveSessions();
          break;
        }

        case 'resize': {
          const session = activeSessions.get(data.sessionId);
          if (session && data.cols > 0 && data.rows > 0) {
            // real:true marks this as a genuine terminal fit (vs the 120×30
            // placeholder set at attach) — only these drive resizeSessionToMin
            const prev = session.clients.get(ws);
            const firstRealFit = !prev?.real;
            session.clients.set(ws, { cols: data.cols, rows: data.rows, real: true });
            const before = session.pty ? { cols: session.pty.cols, rows: session.pty.rows } : null;
            resizeSessionToMin(session, data.sessionId);
            // Fresh attach (first real fit from this client): if the min-size
            // came out unchanged, the PTY got no SIGWINCH — the TUI never
            // repaints and this client is stuck with whatever partial frame the
            // buffer replay contained. Nudge one column down and back to force
            // a clean repaint (same trick as dtach's `-r winch` refresh mode).
            if (firstRealFit && session.mode !== 'chat' && session.pty && before
                && session.pty.cols === before.cols && session.pty.rows === before.rows) {
              try {
                session.pty.resize(Math.max(1, before.cols - 1), before.rows);
                setTimeout(() => { try { session.pty.resize(before.cols, before.rows); } catch {} }, 60);
              } catch {}
            }
          }
          break;
        }

        case 'size-override': {
          // Take over the PTY size: this client's window size wins over the
          // min-of-all-clients policy (smaller clients show a blocked overlay
          // with a "Resume here" takeover button). release:true → min policy.
          const session = activeSessions.get(data.sessionId);
          if (session) {
            session._sizeOwnerWs = data.release ? null : ws;
            resizeSessionToMin(session, data.sessionId);
          }
          break;
        }

        case 'attach': {
          // PROOF-OF-LIFE ACK (2.234.1, userL mass "session died" incident):
          // the full attach reply can lawfully take >20s (degraded event loop,
          // remote transcript pulls, MB-scale payload bursts on reload) — the
          // client's no-reply fallback used to conclude "session no longer
          // exists" and flip every window read-only while all sessions were
          // alive. This tiny synchronous ack tells the client the server is
          // alive and processing, so it WAITS instead of declaring death.
          try { ws.send(JSON.stringify({ type: 'attach-ack', sessionId: data.sessionId })); } catch {}
          // Virtual subagent session: sub-{parentToolUseId} or sub-agent-{agentId}
          if (data.sessionId?.startsWith('sub-')) {
            const subId = data.sessionId;
            if (subId.startsWith('sub-agent-')) {
              // Completed agent: load from JSONL
              const agentId = subId.slice('sub-agent-'.length);
              // Find parent session to get claudeSessionId/cwd
              const parentId = data.parentSessionId;
              const parentSession = parentId ? activeSessions.get(parentId) : null;
              const claudeId = parentSession?.backendSessionId || parentSession?.claudeSessionId || data.backendSessionId || data.claudeSessionId || '';
              const cwd = parentSession?.cwd || data.cwd || '';
              const projectsDir = path.join(os.homedir(), '.claude', 'projects');
              const projDir = cwdToProjectDir(cwd);
              let rawMsgs = [], meta = {}, subFetchErr = null;
              const subDirs = [path.join(projectsDir, projDir, claudeId, 'subagents')];
              try { for (const dir of fs.readdirSync(projectsDir)) { const fp = path.join(projectsDir, dir, claudeId, 'subagents'); if (!subDirs.includes(fp)) subDirs.push(fp); } } catch {}
              // Direct subagent files first, then workflow-nested ones
              // (subagents/workflows/wf_*/agent-<id>.jsonl) so a workflow phase's
              // agent opens in this same viewer.
              const fileCandidates = [];
              // REMOTE parent (2.191.0, remote workflow viewer's View Log):
              // pull the agent transcript into the local cache first — the
              // local scan below then finds it like any other candidate.
              const subHost = data.hostId || parentSession?.host || null;
              if (subHost && hosts && /^[\w-]+$/.test(agentId)) {
                try {
                  const p = await hosts.fetchAgentJsonl(String(subHost), agentId, { claudeSessionId: claudeId });
                  if (p) fileCandidates.push(p);
                } catch (e) {
                  // Remote pull failed (host lag/down): the viewer used to fall
                  // through and render an EMPTY log, indistinguishable from "the
                  // agent said nothing" (2.272.1). Say what happened instead.
                  console.error('remote agent jsonl fetch failed:', e.message);
                  subFetchErr = e.message;
                }
              }
              for (const subDir of subDirs) {
                fileCandidates.push(path.join(subDir, `agent-${agentId}.jsonl`));
                let wfRuns = []; try { wfRuns = fs.readdirSync(path.join(subDir, 'workflows')); } catch {}
                for (const wf of wfRuns) fileCandidates.push(path.join(subDir, 'workflows', wf, `agent-${agentId}.jsonl`));
              }
              for (const fp of fileCandidates) {
                try {
                  if (!fs.existsSync(fp)) continue;
                  for (const line of fs.readFileSync(fp, 'utf-8').split('\n')) {
                    try { const m = JSON.parse(line.trim()); if (m.type === 'user' || m.type === 'assistant' || m.type === 'result') rawMsgs.push(m); } catch {}
                  }
                  try { meta = JSON.parse(fs.readFileSync(fp.replace('.jsonl', '.meta.json'), 'utf-8')); } catch {}
                  break;
                } catch {}
              }
              const subMM = new MessageManager(subId);
              await subMM.convertHistoryAsync(rawMsgs);
              // An empty log after a FAILED remote pull is a lie — tell the
              // client so the viewer can show "couldn't load from <host>"
              // with a retry instead of a blank read-only window.
              ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', messages: subMM.messages, totalCount: subMM.total, meta,
                ...(rawMsgs.length === 0 && subFetchErr ? { loadError: `Couldn’t load this agent’s log from the machine: ${subFetchErr}` } : {}) }));
            } else {
              // Live agent: sub-{parentToolUseId} — find parent session and return buffered messages
              const toolUseId = subId.slice('sub-'.length);
              let found = false;
              for (const [sid, sess] of activeSessions) {
                if (sess.subagentBuffers?.has(toolUseId)) {
                  // viewer:true — receive broadcasts but NEVER influence the
                  // parent session's PTY size (this read-only window has no terminal)
                  sess.clients.set(ws, { cols: 120, rows: 30, viewer: true });
                  attachedSessions.add(sid); // so ws close removes us from the parent's clients map
                  const rawMsgs = sess.subagentBuffers.get(toolUseId);
                  // Use existing sub-normalizer if available, or create one
                  if (!sess._subNormalizers) sess._subNormalizers = new Map();
                  let subMM = sess._subNormalizers.get(toolUseId);
                  if (!subMM) {
                    subMM = new MessageManager(subId);
                    subMM.onOp((op) => broadcastToSession(sess, sid, { type: 'msg', sessionId: subId, ...op }));
                    await subMM.convertHistoryAsync(rawMsgs);
                    sess._subNormalizers.set(toolUseId, subMM);
                  }
                  ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', messages: subMM.messages, totalCount: subMM.total }));
                  found = true;
                  break;
                }
              }
              if (!found) ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', messages: [], totalCount: 0 }));
            }
            break;
          }

          const session = activeSessions.get(data.sessionId);
          if (session) {
            session.clients.set(ws, { cols: 120, rows: 30 });
            attachedSessions.add(data.sessionId);
            if (session.mode === 'chat') {
              // Remote session: pull its transcript into the local cache BEFORE
              // the first history load, so pre-resume history renders and the
              // pagination/search machinery has a real file to work on.
              if (session.host && hosts && !session._historyLoaded && (session.claudeSessionId || session.backendSessionId)) {
                try {
                  const rid = session.claudeSessionId || session.backendSessionId;
                  if ((session.backend || 'claude') === 'codex') await hosts.fetchCodexJsonl(session.host, rid);
                  else await hosts.fetchSessionJsonl(session.host, rid);
                }
                catch (e) { console.error('remote jsonl fetch failed:', e.message); }
              }
              const sm = createSessionMessages(session, data.sessionId);
              // Initialize normalizer from full JSONL + buffer history on first attach.
              // Can't use total===0: PTY output via processLive may have populated the
              // normalizer with partial buffer data before any client connected.
              if (session._normalizer && !session._historyLoaded) {
                // 2.235.0: warm the JSONL parse cache in the transcript worker
                // FIRST — the sync rebuild below then reads a warm cache
                // instead of blocking the loop ~0.5-1s per big-tail parse
                // (the userL-incident spike class). Codex sessions parse
                // their own rollouts sync (unwarmed) — smaller files today.
                // …through the harness descriptor (S3): claude = the worker parse
                // cache warm above; codex = the 0.153 thread/read FALLBACK for a
                // MISSING rollout (B-21e4 item 5, local only — the local
                // app-server knows no remote thread); a harness without the
                // hook skips. Never throws, never blocks the loop (child process).
                try { const warm = harnessOf(session.backend || 'claude').store?.warmTranscript; if (warm) await warm(session.claudeSessionId || session.backendSessionId, session.cwd, { remote: !!session.host }); } catch {}
                // TIME-SLICED + single-flight (2.369.16, userW inc-mtndq0vb):
                // the old sync convertHistory blocked the loop for seconds per
                // multi-MB transcript — after a restart, a reconnect storm of
                // 19 attaches stalled the server ~4 minutes, the heartbeat
                // terminated the client mid-stall and its queued kills were
                // lost with the socket. Live records arriving during the
                // rebuild queue behind it (feedLive gate) and replay in order;
                // _historyLoaded is still set only AFTER success (2.89.2).
                // While it converts (seconds; minutes behind a queue of big
                // sessions after a restart) keep proving life to the client
                // with progress acks — its re-attach ladder extends on a fresh
                // ack instead of flipping read-only at 2 minutes.
                const progressTimer = setInterval(() => {
                  const p = session._rebuildProgress;
                  try { ws.send(JSON.stringify({ type: 'attach-ack', sessionId: data.sessionId, progress: p ? { done: p.done, total: p.total } : null, queued: !p })); } catch { }
                }, 10000);
                try { await rebuildHistory(session, data.sessionId, sm.raw()); }
                finally { clearInterval(progressTimer); }
                // A kill / CLI exit can land during the (now non-blocking)
                // rebuild — never hand the client a live ChatView on a dead
                // session (review-caught).
                if (activeSessions.get(data.sessionId) !== session) {
                  ws.send(JSON.stringify({ type: 'error', sessionId: data.sessionId, code: 'ended-during-attach', message: `Session ${data.sessionId} ended while its history was loading` }));
                  break;
                }
              }
              // Recover goal state from wrapper meta (populated by thread/goal/get on startup)
              if (!session._goal) {
                const wMeta = sm.wrapperMeta?.() || {};
                if (wMeta.goal) {
                  session._goal = wMeta.goal;
                  session._goalStatus = wMeta.goalStatus || null;
                  session._goalElapsed = wMeta.goalElapsed || 0;
                  session._goalTokensUsed = wMeta.goalTokensUsed || 0;
                }
                // Claude fallback: goal_status attachments in JSONL
                if (!session._goal && session.backend === 'claude') {
                  const gs = session._normalizer?.goalState?.();
                  if (gs?.condition) {
                    if (!gs.met) session._goal = gs.condition;
                    else session._prevGoal = gs.condition;
                  }
                }
              }
              const messages = session._normalizer ? session._normalizer.tail(50) : [];
              const totalCount = session._normalizer ? session._normalizer.total : 0;

              const turnMap = session._normalizer ? session._normalizer.turnMap() : [];
              const pendingPerms = sm.activePendingPermissions?.() || {};
              // session._isStreaming is tracked explicitly from protocol signals
              // (result/compact_boundary/user for claude and — since §2.5 — its
              // own session_state_changed; turn events for codex; prompt_end for
              // ACP). Falls back to the wrapper metadata file for sessions the
              // server is not tracking yet.
              // ATTACH RECONCILIATION — ONE decision, PURE
              // (src/turn-state.js reconcileAttachStreaming), shared with the
              // live consumer's reading of what each state means. Two rungs, in
              // order:
              //   ① the harness's OWN last turn state wins in BOTH directions,
              //     including "still running" — which the derived path could
              //     never say, because the CLI's `idle` fires after the bg-agent
              //     loop exits, strictly later than `result`.
              //   ② the wrapper sidecar stays the BACKSTOP (2.339.2: it flips
              //     streaming:false the moment the result record flows). It is a
              //     DERIVED observer, so it never outranks the harness — but it
              //     is the only thing between us and a session that shows
              //     "thinking" forever if an `idle` record is ever lost. Under
              //     authority its settle window is 30s instead of 3s, and when it
              //     fires anyway the override SAYS so (telemetry) instead of
              //     quietly deciding the new signal was wrong.
              if (session.mode === 'chat') {
                let sidecar = null;
                if (session._isStreaming && !session.host) {
                  try {
                    const wf = require('./server/wrapper-files.js').resolveWrapperFiles(BUFFERS_DIR, data.sessionId, path.join(SOCKETS_DIR, data.sessionId.replace(/^sess-/, 'cw-')));
                    const st = fs.statSync(wf.sidecar);
                    const sc = JSON.parse(fs.readFileSync(wf.sidecar, 'utf-8'));
                    sidecar = { streaming: sc.streaming, ageMs: Date.now() - st.mtimeMs };
                  } catch { sidecar = null; } // unreadable sidecar heals nothing
                }
                const rec = reconcileAttachStreaming({
                  turnStateSeen: session._turnStateSeen === true, turnState: session._turnState || null,
                  isStreaming: !!session._isStreaming, sidecar,
                });
                if (rec.action !== 'none') {
                  console.log(`[session] ${data.sessionId}: streaming reconciled (${rec.action}${rec.staleAuthority ? `, the harness last said ${session._turnState}` : ''}) \u2192 ${rec.isStreaming}`);
                  session._isStreaming = rec.isStreaming;
                  if (rec.clearLabel) session._streamingLabel = '';
                  if (rec.staleAuthority) {
                    try { telemetry?.record?.({ kind: 'event', name: 'turn-state-stale', detail: String(session._turnState || '') }); } catch { }
                    // the override is a STATE change, not a display tweak:
                    // leaving 'running' behind would make the NEXT attach undo it
                    session._turnState = 'idle';
                  }
                }
              }
              const isStreaming = session._isStreaming ?? sm.isStreaming;
              const streamingLabel = isStreaming ? (session._streamingLabel || 'thinking...') : '';
              // Merge session-known permission mode into chatStatus — the JSONL
              // can't provide it (init records are stdout-only), so freshly
              // resumed sessions had an empty mode until the first reply
              const chatStatus = sm.chatStatus() || {};
              if (!chatStatus.permissionMode && session._permissionMode) chatStatus.permissionMode = session._permissionMode;
              if (!chatStatus.effort && session._effort) chatStatus.effort = session._effort;
              // …and the PENDING pick separately (2.369.62): `effort` is what
              // the running/last turn is at, `effortNext` what the next one
              // will be. Collapsing them is how a turn codex ran at 'ultra'
              // reported 'xhigh' on every message of that turn.
              if (!chatStatus.effortNext && session._effort) chatStatus.effortNext = session._effort;
              // ALWAYS present (review-caught): omitting the false case left a
              // reconnecting second client showing LOCKED forever after an unlock
              chatStatus.modelLocked = !!session._modelLocked;
              chatStatus.lockedModel = session._lockedModel || null;
              // ONE sidecar read for BOTH wrapper adverts below: resolveWrapperFiles
              // walks /proc when the sidecar is missing (collision sessions), and
              // doing that twice inside the ws attach handler is the 2.369.16 law
              // (no avoidable sync work here).
              const wcapsAttach = wrapperCaps(BUFFERS_DIR, data.sessionId, session.socketPath);
              ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, mode: 'chat',
                messages, totalCount, chatStatus, isStreaming, streamingLabel, streamingKind: isStreaming ? (session._streamingKind || null) : null, autoResume: autoResume?.statusFor?.(data.sessionId) || null, outputStyle: session._outputStyle || null, spawnOrigin: { model: session._modelOrigin || null, effort: session._effortOrigin || null }, taskState: sm.taskState(), turnMap, pendingPermissions: pendingPerms,
                // The input queue as the normalizer knows it (the wrapper's
                // queue_changed replays through the buffer on a rebuild) —
                // ALWAYS present so a reconnecting client can clear a stale
                // strip; harnesses without a queue report [].
                queue: session._normalizer?.queueState?.() || [],
                // …and whether the RUNNING wrapper actually publishes/serves a
                // queue (its own sidecar advert). The client's strip and chip
                // gate on this AS WELL AS the harness caps row: a session
                // spawned before the queue/steer release would otherwise wear
                // controls whose frames its wrapper drops (2.361.1/2.364.1).
                // …and WHICH verbs that wrapper serves, so the client renders
                // exactly the controls this process can honour (an older
                // wrapper gets the legacy three, never a dead reorder handle).
                ...(() => {
                  const wc = wcapsAttach; // the ONE sidecar read above (2.369.16 law)
                  const inBand = session._normalizer?.queueVerbsPublished?.();
                  const served = wc.inputQueue ? wc.queueVerbs
                    : (Array.isArray(inBand) ? inBand
                      : (session._normalizer?.queuePublished?.() ? LEGACY_QUEUE_VERBS.slice() : null));
                  // NULL means "we do not know", NOT "it serves nothing": an
                  // empty ARRAY is a real answer (a wrapper that named no
                  // verbs) and the client intersects with it, so answering []
                  // for the unknown case hid every control (round-2 verifier).
                  return { queueSupported: !!served, queueVerbs: served || null };
                })(),
                // …and whether that same running wrapper serves the LIVE style
                // verb. The client needs BOTH facts (2.369.58): with only the
                // harness caps row, a session spawned before the live-switch
                // release lost the "Restart now to apply" row, kept an
                // invisible saved pick, and got an optimistic toast the
                // server's refusal then contradicted.
                // TRI-STATE: null = the wrapper has not written its sidecar yet
                // (a session spawned seconds ago), which is NOT the same as "it
                // cannot" — the client keeps its "try it" state instead of
                // wearing a restart row it does not need.
                responseStyleLive: wcapsAttach.reason === 'no-sidecar' ? null : !!wcapsAttach.responseStyle,
                // The harness's OWN turn state and the tool ids it says are
                // running (§2.5). TRI-STATE like responseStyleLive: null = this
                // session has never emitted one (old CLI / spawned before the
                // env), and the client then keeps showing the derived state
                // instead of wearing a third state nobody reported.
                turnState: session._turnStateSeen ? (session._turnState || null) : null,
                inProgressTools: session._inProgressTools ? [...session._inProgressTools] : [],
                normEpoch: session._normEpoch || 0,
                remoteState: session._remoteState || (session._bareRemote ? { state: 'unprotected' } : null),
                goal: session._goal || null, goalElapsed: session._goalElapsed || 0, goalStatus: session._goalStatus || null }));
            } else {
              ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, buffer: session.buffer || '' }));
              // A Ctrl+G edit still in flight (helper script blocking on its
              // signal file, claude on "Save and close editor to continue…")
              // exists only as a one-shot broadcast — re-deliver it so a page
              // reload / server restart doesn't leave the session silently
              // hung with no visible editor pane. Local sessions verify the
              // tmpfile still exists (gone = the edit settled or was aborted
              // via Escape → drop the record); remote is best-effort.
              const pe = session._pendingEditor;
              if (pe) {
                let live = true;
                if (!pe.host) { try { live = fs.existsSync(pe.filePath); } catch { live = false; } }
                if (Date.now() - (pe.at || 0) > 24 * 3600 * 1000) live = false;
                if (live) {
                  ws.send(JSON.stringify({ type: 'editor-open', filePath: pe.filePath, signalPath: pe.signalPath, sessionId: data.sessionId, host: pe.host || null }));
                } else {
                  session._pendingEditor = null;
                  try { if (session.sockName) writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), pendingEditor: null }); } catch {}
                }
              }
            }
          } else if (data.viewOnly && (data.backendSessionId || data.claudeSessionId)) {
            // View-only: load JSONL history without an active session
            const backendSessionId = data.backendSessionId || data.claudeSessionId;
            // Remote session: pull the transcript over ssh into the local
            // cache first (findSessionJsonlPath scans it) — history then
            // loads through the normal path. Stale cache beats no history.
            if (data.host && hosts) {
              try {
                if ((data.backend || 'claude') === 'codex') await hosts.fetchCodexJsonl(data.host, backendSessionId);
                else await hosts.fetchSessionJsonl(data.host, backendSessionId);
              }
              catch (e) { console.error('remote jsonl fetch failed:', e.message); }
            }
            // The harness's pre-read hook (S3 store.warmTranscript): claude warms
            // its worker parse cache, codex reads a MISSING rollout through
            // thread/read (B-21e4 item 5, local only) — a dead 0.153 thread whose
            // history lives only in codex's paginated store still opens read-only.
            try { const warm = harnessOf(data.backend || 'claude').store?.warmTranscript; if (warm) await warm(backendSessionId, data.cwd || '', { remote: !!data.host }); } catch {}
            const sm = createSessionMessages({
              backend: data.backend || 'claude',
              backendSessionId,
              claudeSessionId: data.claudeSessionId || backendSessionId,
              agentKind: data.agentKind || 'primary',
              agentRole: data.agentRole || '',
              agentNickname: data.agentNickname || '',
              sourceKind: data.sourceKind || '',
              parentThreadId: data.parentThreadId || null,
              cwd: data.cwd || '',
              buffer: '',
            });
            // THE FOURTH READER SITE (found by the S9-remainder browser leg,
            // B-eac2): a store-backed reader has no bytes until `prepare()` has
            // run — transcript-service awaits it at its three sites, and this
            // one did not, so EVERY stopped OpenCode conversation opened from
            // "View History" said "No messages in this session's transcript
            // yet." while the serve had them. A reader that is not prepared is
            // EMPTY, never wrong, which is exactly why it was silent.
            if (typeof sm.prepare === 'function') { try { await sm.prepare(); } catch (e) { console.warn(`[view] ${data.backend || 'claude'} reader prepare failed for ${backendSessionId}: ${e.message}`); } }
            const mm = createMessageManager(data.backend || 'claude', data.sessionId || 'view', { threadId: backendSessionId }); // the rendered conversation's id (codex ledger key)
            await mm.convertHistoryAsync(sm.raw()); // view-only replay of a dead session — same loop-friendly slicing (boot replay opens N of these at once)
            ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: data.name || '', cwd: data.cwd || '', mode: 'chat',
              messages: mm.tail(50), totalCount: mm.total, chatStatus: sm.chatStatus(), isStreaming: false, viewOnly: true }));
          } else {
            // Include sessionId so the requesting ChatView can correlate the
            // failure (otherwise it waits forever on a blank window)
            ws.send(JSON.stringify({ type: 'error', sessionId: data.sessionId, message: `Session ${data.sessionId} not found` }));
          }
          break;
        }

        // Terminate could not be CONFIRMED on the machine — the local
        // pipeline is gone either way, but the remote claude may live on, so
        // never let the UI imply a clean kill (2.271.0 T1-3).
        case 'kill': {
          // Stale-serverId robustness (2.179.0): after a server restart the
          // client can hold an OLD webui id — a kill that silently no-ops
          // leaves the session alive, and the follow-up resume (billing
          // switch) then double-writes the same claude id (userW's duplicate
          // incident). Fall back to resolving by the conversation id.
          // The requester matches replies on the id IT sent (review-caught:
          // replying with the remapped id left every stale-id kill unanswered).
          const requestedKillId = data.sessionId;
          if (!activeSessions.has(data.sessionId) && data.backendSessionId) {
            for (const [eid, es] of activeSessions) {
              if ((es.claudeSessionId || es.backendSessionId) === data.backendSessionId) { data.sessionId = eid; break; }
            }
          }
          { const ks = activeSessions.get(data.sessionId); if (ks && ks._bridgePort) { try { dialBridge?.close(data.sessionId); } catch { } if (ks._dialDeviceId && ks._dialReversePort) { hosts.device(ks.host).then((dm) => dm.reverseUnforward(ks._dialReversePort)).catch(() => {}); } } }
          const session = activeSessions.get(data.sessionId);
          // Reply to the REQUESTER either way (2.369.16): 'exited' only
          // reaches attached clients, so a sidebar Terminate of an unattached
          // (or already-gone) session had no acknowledgement — and the client
          // now re-sends an unacknowledged kill across reconnects (a kill
          // written to a socket the server later terminated was simply lost).
          if (!session) { try { ws.send(JSON.stringify({ type: 'killed', sessionId: requestedKillId, resolvedId: data.sessionId, ok: false, reason: 'not-found' })); } catch {} }
          if (session) {
            console.log(`[session] killed ${data.sessionId} "${session.name || ''}" mode=${session.mode} backend=${session.backend || 'claude'}`);
            global.__vsEvent?.('session-killed', `${session.mode}/${session.backend || 'claude'}`);
            // Cancel any pending delayed-SIGINT from a recent interrupt — after
            // kill, the childPid may be reused by an unrelated process
            if (session._interruptTimer) { clearTimeout(session._interruptTimer); session._interruptTimer = null; }
            // Kill the dtach session process (which kills claude as its child)
            // The dtach process is the parent of our attach PTY's target
            if (session.socketPath) {
              try {
                // Find dtach process by socket path and kill it
                // async (P1 sweep): pgrep under a loaded box is fast but the
                // rule is loop-blocking-free handlers, no exceptions.
                const out = String(await execFileAsync('pgrep', ['-f', session.socketPath], { encoding: 'utf-8', timeout: 2000 }) || '').trim();
                for (const line of out.split('\n')) {
                  const dpid = parseInt(line.trim());
                  if (dpid && dpid !== session.pty?.pid) {
                    try { process.kill(dpid, 'SIGTERM'); } catch {}
                  }
                }
              } catch {}
              try { fs.unlinkSync(session.socketPath); } catch {}
            }
            if (session.pty) session.pty.kill();
            if (session.sockName) deleteSessionMeta(session.sockName);
            // Clean up wrapper buffer files
            try { fs.unlinkSync(path.join(BUFFERS_DIR, data.sessionId + '.json')); } catch {}
            try { fs.unlinkSync(path.join(BUFFERS_DIR, data.sessionId + '.buf')); } catch {}
            // Per-session agentd attach cfg (0600 — vsht_ host token + full
            // spawn command) accumulated forever (audit #16/#53). The path is
            // derivable, so a restart-restored session (in-memory field lost)
            // still gets its cfg removed.
            {
              const cfgF = session._agentdCfgFile
                || (agentdRemote && path.join(agentdRemote.agentdDir, 'session-' + data.sessionId + '.json'));
              if (cfgF) { try { fs.unlinkSync(cfgF); } catch {} }
            }
            // Tell every attached client the session ended (windows flip to the
            // read-only view). This must happen HERE, deterministically: we
            // delete the session from activeSessions right below, and the pty's
            // async onExit starts with `if (!activeSessions.has(id)) return`
            // (the 46de4ec stale-PTY guard) — so relying on onExit to emit
            // Teardown watchers/normalizers HERE: onExit early-returns once
            // the session leaves activeSessions (stale-PTY guard), so killed
            // sessions leaked every subagent fs.watch + retry timer +
            // normalizer + buffered subagent messages (audit round-2, high).
            if (session.subagentWatchers) {
              for (const [, entry] of session.subagentWatchers) {
                try { entry.watcher?.close(); } catch {}
                if (entry.retry) clearTimeout(entry.retry);
              }
              session.subagentWatchers.clear();
            }
            session._subNormalizers?.clear?.();
            if (session._normalizer) session._normalizer.listeners.length = 0;
            session.subagentBuffers = null;
            session.subagentEmittedUuids = null;
            // Remote CHAT sessions (2.124.0): claude runs DETACHED on the host
            // under vibespace-remote-keeper — killing the local pipeline no
            // longer kills it. Stop it remotely (best-effort, async) and bust
            // the host's discovery cache so the sidebar updates on next poll.
            if (session.host && hosts) {
              try {
                const h = hosts.get(session.host);
                if (h.transport === 'dial') {
                  // Dial device: the ssh teardown below throws for dial (no ssh
                  // fields) and used to be SWALLOWED — the device-side claude
                  // survived every terminate and a later resume raced it
                  // (double JSONL writers, the B-4058 class). Kill the daemon
                  // pipe session + drop the agent token over the device link.
                  if (session.mode === 'chat') {
                    // the pipe sid ≠ webui id for attach-adopted sessions
                    const sidSafe = String(session.keeperSid || data.sessionId).replace(/[^\w-]/g, '');
                    // BOUNDED + CONFIRMED (2.271.0 T1-3): an unbounded
                    // device() could hang the teardown forever, and BOTH legs
                    // were swallowed — an unconfirmed kill left the device-side
                    // claude alive while the UI said "terminated" (the
                    // double-writer precursor). Tell the user when we could not
                    // confirm; the sidebar re-discovery then shows the truth.
                    hosts.deviceBounded(session.host, 8000).then(async (dm) => {
                      let killed = false;
                      try { await dm.killPipeSession(sidSafe); killed = true; } catch (e) { console.warn('[dial] kill-pipe-session failed:', e.message); }
                      try { await dm.runCmd('sh', ['-c', `rm -f "$HOME/.vibespace/bin/.tok-${sidSafe}"`], { timeoutMs: 10000 }); } catch {}
                      try { hosts.invalidateDiscovery(session.host); } catch {}
                      if (!killed) notifyKillUnconfirmed(h.name);
                    }).catch((e) => { console.warn('[dial] terminate teardown unreachable:', e.message); notifyKillUnconfirmed(h.name); });
                  } else {
                    setTimeout(() => { try { hosts.invalidateDiscovery(session.host); } catch {} }, 2000);
                  }
                } else if (session.mode === 'chat') {
                  // Mechanism-agnostic teardown (2.219.0): _agentdSession used
                  // to pick ONE branch, but the flag wasn't restored across
                  // restarts — a restored agentd session's keeper-stop was a
                  // silent no-op and the remote claude ran on (double-writer
                  // class). Both shapes no-op harmlessly when inapplicable.
                  // agentd-ADOPTED sessions run under the pipe sid = keeperSid,
                  // NOT the webui id — the state-file leg used to read
                  // sessions/<webui-id>.json (never exists for adopted) and the
                  // remote claude survived every Terminate (B-b87b; mirrors the
                  // dial branch's sidSafe above). The keeper leg is a harmless
                  // no-op for agentd sids, kept for legacy keeper sessions.
                  const sshSidSafe = String(session.keeperSid || data.sessionId).replace(/[^\w-]/g, '');
                  execFile('ssh', [...hosts.sshArgs(h), '--',
                    `M="$HOME/.vibespace/agentd/state/sessions/${sshSidSafe}.json"; P=$(grep -o '"childPid":[0-9]*' "$M" 2>/dev/null | cut -d: -f2); [ -n "$P" ] && kill $P 2>/dev/null; `
                    + `node "$HOME/.vibespace/bin/vibespace-remote-keeper" stop ${sshSidSafe} 2>/dev/null; `
                    + `sleep 2; [ -n "$P" ] && kill -9 $P 2>/dev/null; true; rm -f "$HOME/.vibespace/bin/.tok-${data.sessionId}"`],
                    { timeout: 15000 }, (err) => {
                      try { hosts.invalidateDiscovery(session.host); } catch {}
                      // ssh leg failed (host lag/down) — the remote claude may
                      // still be running; say so instead of silently claiming
                      // the terminate worked (2.271.0 T1-3).
                      if (err) { console.warn('[remote] terminate teardown failed:', err.message); notifyKillUnconfirmed(h.name); }
                    });
                } else {
                  setTimeout(() => { try { hosts.invalidateDiscovery(session.host); } catch {} }, 2000);
                }
              } catch {}
            }
            // 'exited' silently broke terminate-from-sidebar.
            broadcastToSession(session, data.sessionId, { type: 'exited', sessionId: data.sessionId, reason: 'terminated' });
            try { ws.send(JSON.stringify({ type: 'killed', sessionId: requestedKillId, resolvedId: data.sessionId, ok: true })); } catch {}
            try { if (session._accountId && accounts?.get?.(session._accountId)?.type === 'pooled') accounts.dropSessionPoolLink(session._accountId, data.sessionId); } catch { }
            // R6: a LOCAL daemon pipe session has no dtach socket — kill the
            // daemon-side child explicitly (mirrors the dial branch's shape)
            if (!session.host && session.agentdSession && session.keeperSid) {
              try { hosts.device(null).then((dm) => dm.killPipeSession(session.keeperSid)).catch(() => { }); } catch { }
            }
            activeSessions.delete(data.sessionId);
            refreshWebuiPids();
            broadcastActiveSessions();
          }
          break;
        }

        case 'state-set': {
          const store = getSyncStore(data.store);
          if (store && data.key && typeof data.key === 'string') {
            if (data.value == null || data.value === '') store.delete(data.key, ws);
            else store.set(data.key, data.value, ws);
          }
          break;
        }

        case 'state-resync': {
          // Client reconnected — send missed ops or full snapshot per store
          if (data.versions && typeof data.versions === 'object') {
            for (const [name, sinceVersion] of Object.entries(data.versions)) {
              const store = getSyncStore(name);
              if (!store) continue;
              const result = store.getOpsSince(sinceVersion);
              if (result.full) {
                ws.send(JSON.stringify({ type: 'state-snapshot', store: name, data: result.full, version: result.version }));
              } else if (result.ops.length > 0) {
                for (const op of result.ops) {
                  ws.send(JSON.stringify({ type: 'state-sync', store: name, ...op }));
                }
              }
            }
          }
          break;
        }

        case 'layout-sync': {
          // Layout state sync: save to disk + broadcast to other clients.
          // Each rebroadcast carries a monotonically increasing seq — receivers
          // drop anything <= the last seq they applied, so a delayed/stale
          // broadcast can never "undo" a newer one (the ping-pong bug where an
          // operation on one client got reverted and replayed several times).
          const layoutData = readLayouts();
          const desktopId = data.desktopId;
          // The Stage is NOT a desktop — its state lives in the 'stage'
          // SyncStore. A '__stage__' record here is the pre-2.209.0 poisoning
          // (raw switchTo while staged captured the stage's window set into
          // desktop records → lazy-replayed as slot-bounds window copies).
          // Refuse new writes and scrub any persisted residue.
          if (desktopId === '__stage__') break;
          if (layoutData.desktops?.__stage__) delete layoutData.desktops.__stage__;
          if (desktopId) {
            // Per-desktop save
            if (!layoutData.desktops) layoutData.desktops = {};
            if (!layoutData.desktops[desktopId]) layoutData.desktops[desktopId] = {};
            layoutData.desktops[desktopId].autoSave = { ...data.state, updatedAt: Date.now() };
          } else {
            // Legacy single-desktop save
            layoutData.autoSave = { ...data.state, updatedAt: Date.now() };
          }
          writeLayouts(layoutData);
          // Broadcast to other clients (sender excluded) — include desktopMeta
          const syncMsg = JSON.stringify({ type: 'layout-sync', seq: ++layoutSyncSeqRef.value, desktopId, state: data.state, desktopMeta: layoutData.desktopMeta || [] });
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WS_OPEN) { try { client.send(syncMsg); } catch {} }
          });
          break;
        }

        case 'desktop-create': {
          const layoutData = readLayouts();
          if (!layoutData.desktopMeta) layoutData.desktopMeta = [];
          if (!layoutData.desktops) layoutData.desktops = {};
          const newId = data.id || ('desk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5));
          const newName = data.name || `Desktop ${layoutData.desktopMeta.length + 1}`;
          // Avoid duplicates (migration sends id that may already exist)
          if (!layoutData.desktopMeta.find(d => d.id === newId)) {
            layoutData.desktopMeta.push({ id: newId, name: newName });
          }
          if (!layoutData.desktops[newId]) layoutData.desktops[newId] = {};
          writeLayouts(layoutData);
          const broadcast = JSON.stringify({ type: 'desktop-updated', desktops: layoutData.desktopMeta });
          wss.clients.forEach(c => { if (c !== ws && c.readyState === WS_OPEN) try { c.send(broadcast); } catch {} });
          break;
        }

        case 'desktop-delete': {
          const layoutData = readLayouts();
          if (layoutData.desktopMeta) {
            layoutData.desktopMeta = layoutData.desktopMeta.filter(d => d.id !== data.desktopId);
          }
          if (layoutData.desktops) delete layoutData.desktops[data.desktopId];
          writeLayouts(layoutData);
          const broadcast = JSON.stringify({ type: 'desktop-updated', desktops: layoutData.desktopMeta || [] });
          wss.clients.forEach(c => { if (c !== ws && c.readyState === WS_OPEN) try { c.send(broadcast); } catch {} });
          break;
        }

        case 'desktop-rename': {
          const layoutData = readLayouts();
          const meta = (layoutData.desktopMeta || []).find(d => d.id === data.desktopId);
          if (meta) meta.name = data.name;
          writeLayouts(layoutData);
          const broadcast = JSON.stringify({ type: 'desktop-updated', desktops: layoutData.desktopMeta || [] });
          wss.clients.forEach(c => { if (c !== ws && c.readyState === WS_OPEN) try { c.send(broadcast); } catch {} });
          break;
        }

        case 'desktop-reorder': {
          // Reorder desktopMeta to the client-supplied id order (drag-to-reorder,
          // 2.250.0). Reconcile against the stored set so a stale client can't
          // drop or invent a desktop: keep only known ids in the given order,
          // then append any stored ids the client omitted.
          const layoutData = readLayouts();
          const cur = layoutData.desktopMeta || [];
          const byId = new Map(cur.map(d => [d.id, d]));
          const seen = new Set();
          const next = [];
          for (const id of (Array.isArray(data.order) ? data.order : [])) {
            if (byId.has(id) && !seen.has(id)) { next.push(byId.get(id)); seen.add(id); }
          }
          for (const d of cur) if (!seen.has(d.id)) next.push(d);
          if (next.length === cur.length) {
            layoutData.desktopMeta = next;
            writeLayouts(layoutData);
            const broadcast = JSON.stringify({ type: 'desktop-updated', desktops: layoutData.desktopMeta });
            wss.clients.forEach(c => { if (c !== ws && c.readyState === WS_OPEN) try { c.send(broadcast); } catch {} });
          }
          break;
        }

        case 'tmux-attach': {
          // Attach to a running tmux pane (read-only view of external session)
          const tmuxTarget = data.tmuxTarget;
          if (!tmuxTarget) { ws.send(JSON.stringify({ type: 'error', message: 'No tmux target' })); break; }

          const id = 'tmux-' + (++sessionCounterRef.value) + '-' + Date.now();
          const tmuxPty = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
            name: 'xterm-256color', cols: data.cols || 120, rows: data.rows || 30,
            env: { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          });

          const session = {
            pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
            cwd: data.cwd || '', name: data.name || tmuxTarget,
            createdAt: Date.now(), tmuxTarget, isTmuxView: true,
            backend: 'claude', buffer: '',
          };
          activeSessions.set(id, session);
          session._webuiId = id; // per-session pool link key (plan C) — the id the session is registered under
          attachedSessions.add(id);

          setupSessionPty(session, id, tmuxPty, { cleanupOnExit: false });

          ws.send(JSON.stringify({ type: 'created', sessionId: id, name: session.name, cwd: session.cwd, isTmuxView: true, reqId: data.reqId || undefined }));
          broadcastActiveSessions();
          break;
        }
        default: {
          // LOUD unknown type (Plugin Ph1; design-harness-plugins §3.1): this
          // switch had no default, so an unknown type vanished — no log, no
          // telemetry, no reply, and the sender waited forever. Rate-limited
          // log + a telemetry count + a reply to the sender. The reply carries
          // NO sessionId ON PURPOSE: a session-scoped `error` frame is what
          // flips a live window into the attach-failed / exited path
          // (chat-view's error branch and terminal's per-session handler key on
          // msg.sessionId; ws.js routes by it) — an unknown TYPE is not a dead
          // session. reqId IS echoed so a ws.request() caller fails fast
          // instead of hanging.
          noteUnknownWsType(telemetry, data?.type);
          const unknownType = unknownTypeLabel(data?.type);
          try { ws.send(JSON.stringify({ type: 'error', code: 'unknown-type', message: `Unknown message type: ${unknownType}`, unknownType, reqId: data?.reqId || undefined })); } catch {}
          break;
        }
      }
    }

    ws.on('close', () => {
      for (const sid of attachedSessions) {
        const session = activeSessions.get(sid);
        if (session) {
          session.clients.delete(ws);
          resizeSessionToMin(session, sid);
        }
      }
    });
  });
}

// pickCodexThreadCandidate also serves restoreSessions' id recapture (a
// restart inside the create-time capture window killed the retry chain)
module.exports = { registerWsHandler, noConvoRef, pickCodexThreadCandidate, agentEnv, WS_CTX_CONTRACT };
