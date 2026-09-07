'use strict';
// CLAUDE STREAM-JSON STDOUT CONSUMER (harness S5, docs/design-harness-plugins.md
// §2.4): the 'stream-json' branch of setupSessionPty — the largest one:
// subagent JSONL watchers, id adoption (fork / implicit fork), billing-identity
// truth, get_usage replies, the served-model latch, the live usage odometer,
// rate-limit events + limit banners + fallback belts, permission-mode truth,
// TodoWrite/TaskCreate/TaskUpdate capture, the turn-lifecycle label machine,
// goal attachments, workflow usage watchers, tool_progress routing and the
// subagent buffer/normalizer fan-out — moved VERBATIM out of
// src/server/session-stdout.js behind the protocol registry (./index.js).
//
// SESSION-BRAIN CONTRACT (CLAUDE.md routing table, "Live session stdout
// consumers"): this parse REGISTERS every record through sbSeenFirst (parse-
// primary, first-writer-wins) and runs the side-effect families inline; the
// DEVICE stream runs claudeSideEffects (src/server/session-brain.js) only for
// records the parse has not seen. The two must stay family-for-family
// equivalent — that wiring is untouched by this move (test-session-brain-dark).
//
// ORCH tier by design: it consumes the usage/pool engine, the machine handle
// (hosts.harvestUsage), the ledger and the goal sync — so it cannot be bundled
// for the daemon; the harness descriptor only NAMES it (caps.streamProtocol =
// 'stream-json'). Per-attach state (lineBuf, startSubagentWatcher/
// stopSubagentWatcher) lives in the attach closure exactly as the inline
// branch kept it; the subagent maps and every _field are on the session
// object (src/session-schema.js rows, owner 'stdout') — boot-restore re-arms
// watchers through session._startSubagentWatcher as before.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MessageManager } = require('../../message-manager');
const { cwdToProjectDir } = require('../../session-store');
const { ClaudeCodeAdapter } = require('../../adapters/claude-code.js');
const { isTurnState, turnStateEffect } = require('../../turn-state.js');

const protocol = 'stream-json';

function create({ activeSessions, engine, CLAUDE_STREAM_TYPES, _seenStreamTypes, USAGE_SCANNER_PATH,
  checkClaudeGoalStatus, noteModelSeen, sbSeenFirst, hosts, usageHistory }) {
  const { _vsuPending, armWorkflowUsageWatcher, kickPoolEval, markLimitBanner,
    maybeRepinLockedModel, maybeStopOnFallback, notePoolAuthFailure,
    modelsMatch, noteSessionProduced, noteTurnEnd, recordRateLimitEvent, resolveUsageKey, usageEstimator } = engine;
  function attach(session, id, ptyProcess, { feedLive, broadcastToSession, broadcastActiveSessions, readSessionMeta, writeSessionMeta, updateSessionTodos, applyTaskToolUpdate, emitTaskListTodos }) {
    let lineBuf = '';
    if (!session.subagentBuffers) session.subagentBuffers = new Map();
    if (!session.subagentEmittedUuids) session.subagentEmittedUuids = new Map(); // toolUseId → Set<uuid>
    if (!session.subagentWatchers) session.subagentWatchers = new Map(); // toolUseId → {watcher, offset}

    // Watch a subagent JSONL file for new messages (fills gap: text/thinking not in stream-json)
    const startSubagentWatcher = (toolUseId, agentId, attempt = 0) => {
      if (session.subagentWatchers.has(toolUseId)) return;
      // Find JSONL path
      const projectsDir = path.join(os.homedir(), '.claude', 'projects');
      const projDir = cwdToProjectDir(session.cwd || '');
      const candidates = [];
      if (session.claudeSessionId) {
        candidates.push(path.join(projectsDir, projDir, session.claudeSessionId, 'subagents', `agent-${agentId}.jsonl`));
        try { for (const dir of fs.readdirSync(projectsDir)) { const fp = path.join(projectsDir, dir, session.claudeSessionId, 'subagents', `agent-${agentId}.jsonl`); if (!candidates.includes(fp)) candidates.push(fp); } } catch {}
      }
      const watchFile = candidates.find(f => { try { return fs.existsSync(f); } catch { return false; } });
      if (!watchFile) {
        // File doesn't exist yet — retry with backoff, capped: an agent that
        // failed before writing its JSONL never gets a task_notification, so
        // an uncapped 1s retry (each with a full projects-dir scan) would
        // spin for the session's lifetime
        if (attempt >= 30) { session.subagentWatchers.delete(toolUseId); return; }
        const delay = Math.min(10000, 1000 * Math.pow(1.3, attempt));
        // Belt-and-braces liveness: a killed session must not keep re-scanning
        // the projects dir through this retry chain (audit round-2)
        const retry = setTimeout(() => { session.subagentWatchers.delete(toolUseId); if (!activeSessions.has(id)) return; startSubagentWatcher(toolUseId, agentId, attempt + 1); }, delay);
        session.subagentWatchers.set(toolUseId, { watcher: null, retry, lastActivity: Date.now() });
        return;
      }
      if (!session.subagentEmittedUuids.has(toolUseId)) session.subagentEmittedUuids.set(toolUseId, new Set());
      const emitted = session.subagentEmittedUuids.get(toolUseId);
      let offset = 0;
      // Read existing content first
      const readNewLines = () => {
        try {
          const stat = fs.statSync(watchFile);
          if (stat.size <= offset) return;
          const buf = Buffer.alloc(stat.size - offset);
          const fd = fs.openSync(watchFile, 'r');
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = stat.size;
          for (const line of buf.toString('utf-8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.uuid && emitted.has(msg.uuid)) continue; // already sent via stream-json
              if (msg.uuid) emitted.add(msg.uuid);
              if (msg.type !== 'user' && msg.type !== 'assistant' && msg.type !== 'result') continue;
              // Buffer + broadcast
              if (!session.subagentBuffers.has(toolUseId)) session.subagentBuffers.set(toolUseId, []);
              session.subagentBuffers.get(toolUseId).push(msg);
              broadcastToSession(session, id, { type: 'subagent-message', sessionId: id, parentToolUseId: toolUseId, message: msg });
              // Normalize for subagent viewers
              if (!session._subNormalizers) session._subNormalizers = new Map();
              if (!session._subNormalizers.has(toolUseId)) {
                const subMM = new MessageManager(`sub-${toolUseId}`);
                subMM.onOp((op) => broadcastToSession(session, id, { type: 'msg', sessionId: `sub-${toolUseId}`, ...op }));
                session._subNormalizers.set(toolUseId, subMM);
              }
              session._subNormalizers.get(toolUseId).processLive(msg);
            } catch {}
          }
        } catch {}
      };
      readNewLines(); // read any existing content
      const watcher = fs.watch(watchFile, () => { const e = session.subagentWatchers.get(toolUseId); if (e) e.lastActivity = Date.now(); readNewLines(); });
      session.subagentWatchers.set(toolUseId, { watcher, lastActivity: Date.now() });
    };

    const stopSubagentWatcher = (toolUseId) => {
      const entry = session.subagentWatchers.get(toolUseId);
      if (entry) {
        if (entry.watcher) entry.watcher.close();
        if (entry.retry) clearTimeout(entry.retry);
        session.subagentWatchers.delete(toolUseId);
      }
    };
    // restoreSessions re-arms watchers for agents that span a restart via
    // this handle (the wrapper meta's task map carries their ids); the
    // 10-min inactivity sweep bounds any stale entry it re-creates
    session._startSubagentWatcher = startSubagentWatcher;

    ptyProcess.onData((output) => {
      if (session._reattachAttempts) session._reattachAttempts = 0;
      session.buffer += output;
      if (session.buffer.length > 750000) session.buffer = session.buffer.slice(-500000);
      lineBuf += output;
      let nlIdx;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.substring(0, nlIdx).replace(/\r/g, '').trim();
        lineBuf = lineBuf.substring(nlIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          // BREADCRUMB for CLI evolution (2.227.8): the claude stream gained
          // `tool_progress` and it silently rode the subagent branch for
          // weeks (2.227.7) — the SECOND time a new upstream record type
          // became an invisible product gap (the first was
          // model_refusal_fallback, 2.227.4). Name-only, deduped per
          // process, so the NEXT new top-level type shows up in Diagnostics
          // instead of waiting for a user to notice something odd.
          if (msg.type && !CLAUDE_STREAM_TYPES.has(msg.type) && !_seenStreamTypes.has(msg.type)) {
            _seenStreamTypes.add(msg.type);
            global.__vsEvent?.('cli-unknown-stream-type', String(msg.type).slice(0, 60));
            console.log(`[claude] new stream record type from the CLI: ${msg.type} (unhandled — see Diagnostics)`);
          }
          if (msg.type === '_stdin_ack') { session._stdinAckReceived = true; continue; }
          // Remote transport state from the chat-wrapper (2.125.0): the ssh
          // pipe died and the wrapper is reconnecting to the host-side keeper
          // (the REMOTE session is fine). Surfaced as a status-bar chip; the
          // attach payload carries the current value for refreshes.
          if (msg.type === '_remote_state') {
            const rs = { state: msg.state, attempts: msg.attempts || 0, at: Date.now(), lastError: msg.lastError || null };
            session._remoteState = msg.state === 'connected' ? null : rs;
            broadcastToSession(session, id, { type: 'remote-state', sessionId: id, ...rs });
            broadcastActiveSessions(); // card chip follows the transport state (2.219.1)
            continue;
          }

          // Claude fork: adopt the new session id. --fork-session makes claude
          // mint a fresh id at startup — the very first system/hook_started
          // line already carries it (verified) — and write a separate JSONL.
          // Without adopting it the WebUI keeps tracking the PARENT id, so the
          // forked window shadows the original (same name/history/resume
          // target) and the fork's transcript is orphaned — indistinguishable
          // from a plain resume. One-shot _forkRequested guard (set only when
          // data.fork) so a normal resume, whose id the parser also sees on
          // every line, can never be hijacked.
          // FIRST-capture is UNCONDITIONAL (2.156.1, userL real incident):
          // a session created with claudeSessionId=null could NEVER adopt its
          // id here — the fork guard vetoed the only parser-side capture.
          // Local sessions were silently rescued by lock-first discovery
          // (local locks visible); REMOTE keeper sessions had no rescuer, so
          // meta kept null forever and attach's transcript prefetch died on
          // it. Hijack-safety is preserved: with NO tracked id there is
          // nothing to hijack, and a CHANGED id still requires _forkRequested.
          // IMPLICIT FORK adoption (2.219.0, userL real incident): a
          // `claude --resume <id>` whose conversation is LOCKED by another
          // live claude (an orphaned keeper child) silently forks to a NEW
          // session id — no fork flag from us, claude's own double-writer
          // protection. The 2.156.1 hijack guard vetoed that change, so
          // VibeSpace kept tracking the OLD id while claude wrote the new
          // file: the live stream showed the turns, every restart-rebuilt
          // history lost them ("compact recap 里有, 窗口里不展示"). An id
          // change on the FIRST id-bearing line of a RESUME spawn is claude
          // telling us the real id — adopt it (mid-stream changes without
          // the fork flag stay vetoed).
          const implicitFork = session._resumeSpawn && !session._sawFirstId
            && session.backendSessionId && msg.session_id !== session.backendSessionId;
          if (typeof msg.session_id === 'string' && msg.session_id && !session._sawFirstId) {
            session._sawFirstId = true;
            // persist the disarm for resumes — a restart between first-id and
            // a later id-bearing line must not re-arm implicit-fork adoption
            if (session._resumeSpawn && session.sockName) {
              try { writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), sawFirstId: true }); } catch {}
            }
          }
          if (typeof msg.session_id === 'string' && msg.session_id
              && (!session.backendSessionId || ((session._forkRequested || implicitFork) && session.backendSessionId !== msg.session_id))) {
            if (session.backendSessionId) {
              const prev = session.forkedFrom || [];
              if (!prev.includes(session.backendSessionId)) prev.push(session.backendSessionId);
              session.forkedFrom = prev;
            }
            session.backendSessionId = msg.session_id;
            session.claudeSessionId = msg.session_id;
            session._forkRequested = false; // adopt once, then stop watching
            if (session.sockName) {
              writeSessionMeta(session.sockName, {
                ...(readSessionMeta(session.sockName) || {}), // preserve keys not re-listed (agentToken/taskId/accountId)
                name: session.name,
                cwd: session.cwd,
                backend: session.backend,
                backendSessionId: session.backendSessionId,
                claudeSessionId: session.claudeSessionId,
                sourceKind: session.sourceKind || null,
                agentKind: session.agentKind || 'primary',
                agentRole: session.agentRole || '',
                agentNickname: session.agentNickname || '',
                parentThreadId: session.parentThreadId || null,
                forkedFrom: session.forkedFrom || null,
                permissionMode: session._permissionMode || null,
                effort: session._effort || null,
                createdAt: session.createdAt,
                webuiSessionId: id,
                mode: session.mode,
              });
            }
            broadcastActiveSessions();
          }

          // Billing identity TRUTH: the init record's apiKeySource is the
          // CLI's own statement of what auth it resolved — 'none'=subscription
          // OAuth, '/login managed key'=console login (API billing),
          // 'ANTHROPIC_API_KEY'=env key. Overrides the spawn-time guess.
          if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.apiKeySource === 'string') {
            if (session._apiKeySource !== msg.apiKeySource) {
              session._apiKeySource = msg.apiKeySource;
              if (session.sockName) writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), apiKeySource: msg.apiKeySource });
              broadcastActiveSessions();
            }
          }

          // get_usage control-response (vsu- ids are OURS): payload nests at
          // response.response (live-verified 2026-08-09); resolve the ⟳
          // probe's promise + persist. Other control_responses untouched.
          if (msg.type === 'control_response' && String(msg.response?.request_id || '').startsWith('vsu-')) {
            const pend = _vsuPending.get(msg.response.request_id);
            if (pend) {
              _vsuPending.delete(msg.response.request_id);
              clearTimeout(pend.timer);
              let parsed = null;
              try { parsed = ClaudeCodeAdapter.parseGetUsageResponse(msg.response.response); } catch {}
              pend.resolve(parsed);
            }
          }
          // Served-model truth for the lock re-pin (assistant records carry
          // the model that actually answered; '<synthetic>' rows excluded).
          // MAIN THREAD ONLY (review-caught): subagents/sidechains run their
          // own models — without the guard a haiku subagent both spuriously
          // triggered repins AND masked a real main-thread reroute when it
          // answered last.
          // STEP 3 record REGISTRATION (first-writer-wins, parse-primary):
          // the parse marks every record it processes; the DEVICE feed runs
          // the side-effect families only for records the parse has NOT yet
          // seen (relay lag, wrapper reconnect windows, a dead relay). The
          // parse keeps full authority when healthy — the device stream
          // fills its gaps and beats its latency, never double-fires. Every
          // family is idempotent by design regardless (stdout re-emits the
          // same msg.id up to 3×), so the gate is belt, not the only guard.
          sbSeenFirst(session, msg);
          if (msg.type === 'assistant' && !msg.parent_tool_use_id && !msg.isSidechain
              && msg.message?.model && !String(msg.message.model).startsWith('<')) {
            // main-thread work ⇒ not limit-blocked ⇒ stale armed waits drop
            // (readings-based disarm misses accounts that emit no events)
            try { noteSessionProduced?.(session); } catch { }
            session._servedModel = msg.message.model; session._servedModelAt = Date.now();
            try { noteModelSeen(session._servedModel); } catch { }
            // Latch a target-less lock (locked before any model was known —
            // restored sessions, pre-first-reply locks): first main-thread
            // served model becomes the target, else repin no-ops forever.
            if (session._modelLocked && !session._lockedModel) {
              session._lockedModel = session._servedModel;
              try { if (session.sockName) writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), lockedModel: session._lockedModel }); } catch {}
            }
          }
          // CLI error-class telemetry (2.207.0, names/enums only — no
          // content): usage-limit sightings and silent model fallbacks are
          // exactly what tonight's incidents needed frequency data for.
          // LIVE odometer feed (event-driven estimation): note every usage-
          // carrying record — main thread AND subagent sidechains — the
          // moment it streams (before the transcript flush, long before the
          // ledger scan), then kick a throttled pool re-evaluation. This is
          // what makes burst burns visible between scan ticks (exhaustion #2:
          // half the Fable bucket evaporated inside one polling interval).
          // Bug B (2.297.0, offline-bias audit): a HOST-LOGIN remote session
          // has no local billing identity — resolveUsageKey fell through to
          // '__global__', crediting the LOCAL machine login's live odometer
          // with another machine's spend (then the harvest landed the real
          // event and the estimate visibly dropped back — spend that
          // un-counts itself). Host-login sessions skip the ring; the
          // harvest is their one ledger path. Account-billed remote
          // sessions keep riding it (their identity is real and global).
          if (msg.type === 'assistant' && msg.message?.usage && (msg.requestId || msg.message?.id)
              && !(session.host && !session._accountId)) {
            try {
              const u = msg.message.usage; const cc = u.cache_creation || {};
              const acctKey = resolveUsageKey(session);
              const usd = usageHistory._cost({ acct: acctKey === '__global__' ? null : acctKey, model: msg.message.model, i: u.input_tokens || 0, o: u.output_tokens || 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: u.cache_read_input_tokens || 0 });
              const cwUsd = usageHistory._cost({ acct: acctKey === '__global__' ? null : acctKey, model: msg.message.model, i: 0, o: 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: 0 });
              const crUsd = usageHistory._cost({ acct: acctKey === '__global__' ? null : acctKey, model: msg.message.model, i: 0, o: 0, cw5: 0, cw1: 0, cr: u.cache_read_input_tokens || 0 });
              usageEstimator.noteLive({ rid: msg.requestId || msg.message.id, accountId: acctKey, model: msg.message.model, usd, cwUsd, crUsd });
              kickPoolEval();
            } catch { }
          }
          // CLI-native quota push (B-e5c9): emitted when rate limit info
          // changes, riding real API responses — zero extra calls; covers
          // chat sessions the statusline never could, local AND remote.
          if (msg.type === 'rate_limit_event') recordRateLimitEvent(session, msg);
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const b of msg.message.content) {
              if (b?.type === 'text' && typeof b.text === 'string' && /You've (?:reached|hit) your .{0,40} limit/.test(b.text)) {
                global.__vsEvent?.('cli-usage-limit');
                markLimitBanner(session, b.text); // passive cache mark (2.260.0); the wall SIGNAL rides noteWallSignal inside it (2.369.0)
              } else if (b?.type === 'fallback') {
                global.__vsEvent?.('cli-model-fallback', `${b.from?.model || '?'}->${b.to?.model || '?'}`);
                // main thread only — a SUBAGENT's fallback must not interrupt
                // the parent turn (same guard class as the served-model capture)
                if (!msg.parent_tool_use_id && !msg.isSidechain) maybeStopOnFallback(session, id, b.from?.model, b.to?.model);
              }
            }
          }
          // Reactive belt for the CLIENT-lane reroute (system record). The
          // native switchModelsOnFlag=false prevents both lanes for sessions
          // spawned/flipped after the toggle — this belt covers sessions
          // that predate it (their CLI still has fallback armed).
          if (msg.type === 'system' && msg.subtype === 'model_refusal_fallback') {
            maybeStopOnFallback(session, id,
              msg.originalModel || msg.original_model, msg.fallbackModel || msg.fallback_model);
          }

          // Permission-mode TRUTH (2.195.0): 2.1.215 emits a fresh init on
          // EVERY user message carrying the CURRENT effective mode — adopt
          // it so attach/chatStatus/resume never serve the spawn-time value
          // (the old stale _permissionMode is what made a successful
          // mid-session switch look reverted after a restart/reattach).
          if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.permissionMode === 'string' && msg.permissionMode
              && session._permissionMode !== msg.permissionMode) {
            session._permissionMode = msg.permissionMode;
            if (session.sockName) writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), permissionMode: msg.permissionMode });
          }

          // set_permission_mode verdict (2.195.0): the CLI REFUSES a
          // mid-session switch to bypassPermissions unless the session was
          // launched bypass-capable — a clean error control_response we
          // used to swallow (the optimistic badge then flipped back on the
          // next init and the user read the whole feature as broken).
          // Success → adopt + persist; either way tell the session's
          // clients so the UI can confirm, revert, or offer the
          // restart-with-mode path.
          if (msg.type === 'control_response' && session._pendingModeReqs?.has(msg.response?.request_id)) {
            const pend = session._pendingModeReqs.get(msg.response.request_id);
            session._pendingModeReqs.delete(msg.response.request_id);
            const ok = msg.response?.subtype === 'success';
            if (ok) {
              session._permissionMode = pend.mode;
              if (session.sockName) writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), permissionMode: pend.mode });
            }
            if (!ok) global.__vsEvent?.('perm-mode-refused', pend.mode);
            broadcastToSession(session, id, {
              type: 'permission-mode-ack', sessionId: id, ok, mode: pend.mode,
              error: ok ? null : String(msg.response?.error || 'permission mode change refused'),
            });
          }

          // TodoWrite / TaskCreate / TaskUpdate → the session's live TODO
          // summary (board pill). TaskCreate's id arrives in the RESULT.
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const b of msg.message.content) {
              if (b?.type !== 'tool_use') continue;
              if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) updateSessionTodos(session, b.input.todos);
              else if (b.name === 'TaskCreate') (session._pendingTaskCreates ||= new Map()).set(b.id, b.input || {});
              else if (b.name === 'TaskUpdate' && b.input?.taskId) applyTaskToolUpdate(session, b.input);
            }
          }
          if (msg.type === 'user' && Array.isArray(msg.message?.content) && session._pendingTaskCreates?.size) {
            for (const b of msg.message.content) {
              if (b?.type !== 'tool_result' || !session._pendingTaskCreates.has(b.tool_use_id)) continue;
              const inp = session._pendingTaskCreates.get(b.tool_use_id);
              session._pendingTaskCreates.delete(b.tool_use_id);
              const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((c) => c?.text || '').join(' ') : '');
              const m = /Task #(\d+) created/.exec(txt);
              if (m) {
                (session._taskList ||= new Map()).set(m[1], { content: inp.subject || '', activeForm: inp.activeForm, status: 'pending' });
                emitTaskListTodos(session);
              }
            }
          }

          // TOOL-GRANULAR RUN SET (§2.5, caps `inProgressTools`). The CLI's own
          // describe: "Emitted when tool execution adds/removes tool_use ids
          // from the mid-execution set (after permission grant, before
          // result). Surfaces use this to show which tools are running."
          // Card-less by design — it would drive the tool cards' spinner, not
          // the transcript, so it is consumed HERE and never normalized (the
          // normalizer has no case for it; a rebuild replays it into a no-op,
          // which is correct: a run set is live-only by nature).
          //
          // DORMANT ON 2.1.257 — THE RECORD DOES NOT REACH US (round-4
          // verifier, reproduced on the WIRE). The CLI routes it into a HOST
          // CALLBACK and returns without re-yielding it:
          //   `if(e.type==="set_in_progress_tool_use_ids"){
          //      n.onInProgressToolUseIDs?.(e.op); return }`   (offset 186333979)
          // and the "add" side never even enters that dispatcher — it is handed
          // straight to a callback at tool dispatch
          // (`U({type:"set_in_progress_tool_use_ids",op:{action:"add",ids:[n]}})`,
          // offset 184806515). Only the SUBAGENT pipeline reads one, and only
          // 'remove' (offset 191771649); the forked-skill pipeline `continue`s
          // past it entirely (192802652).
          // MEASURED, not inferred: a probe in chat-wrapper.js's exact spawn
          // shape (--output-format stream-json --input-format stream-json
          // --verbose --permission-prompt-tool stdio, piped) ran three parallel
          // Reads plus three Bashes → 6 tool_use + 6 tool_result records and
          // ZERO of these, while `system/session_state_changed` running/idle
          // DID arrive on the same stdout (the positive control that the reader
          // works). 24 production buffers: 212 tool_use blocks, 0 of these.
          // So `caps.inProgressTools` is FALSE and no surface claims the dot.
          // The branch stays because the day the CLI forwards the record this
          // is the whole feature — scripts/test-stdout-registry.mjs's wire leg
          // re-measures it on every run and goes RED (with the instruction to
          // flip the cap) the moment one arrives.
          if (msg.type === 'set_in_progress_tool_use_ids' && msg.op && Array.isArray(msg.op.ids)) {
            const set = (session._inProgressTools ||= new Set());
            const ids = msg.op.ids.filter((x) => typeof x === 'string' && x).slice(0, 200);
            if (msg.op.action === 'add') for (const t of ids) set.add(t);
            else if (msg.op.action === 'remove') for (const t of ids) set.delete(t);
            else { global.__vsEvent?.('cli-unknown-inprogress-action', String(msg.op.action).slice(0, 40)); }
            broadcastToSession(session, id, { type: 'tools-in-progress', sessionId: id, ids: [...set] });
            continue;
          }
          // Track turn lifecycle: streaming state + activity label (broadcast to clients)
          {
            let newLabel = null;
            // AUTHORITATIVE TURN STATE (§2.5/§3.5). Once THIS session has shown
            // us one `system/session_state_changed`, the harness's own words
            // own `_isStreaming` and the derived writes below stand down. The
            // flag is per SESSION and starts false: an old CLI, or one spawned
            // before src/adapters/claude-code.js started setting
            // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, simply never sets it and
            // keeps today's result/compact_boundary/user inference forever —
            // degradation is the default path, not an error path.
            const authoritative = session._turnStateSeen === true;
            if (msg.type === 'result' || (msg.type === 'system' && msg.subtype === 'compact_boundary')) {
              if (!authoritative) session._isStreaming = false;
              session._fallbackStopFired = false; // one auto-stop per turn (claude.disableModelFallback belt)
              session._streamingKind = null;
              newLabel = '';
            } else if (msg.type === 'system' && msg.subtype === 'session_state_changed' && isTurnState(msg.state)) {
              // The CLI's own turn state. describe: "'idle' fires after
              // heldBackResult flushes and the bg-agent do-while exits —
              // authoritative turn-over signal". That is strictly LATER than
              // our `result` guess, which is why a background agent still
              // working after the result used to look finished. What each state
              // MEANS is the PURE turnStateEffect — the same function the attach
              // reconciliation reads, so the live view and a re-attach can never
              // disagree about a session's turn.
              const st = msg.state;
              const eff = turnStateEffect(st, { hasLabel: !!session._streamingLabel });
              const first = !session._turnStateSeen;
              session._turnStateSeen = true;
              const changed = session._turnState !== st;
              session._turnState = st;
              session._isStreaming = eff.streaming;
              if (!eff.streaming) { session._fallbackStopFired = false; session._streamingKind = null; }
              if (eff.label !== null) newLabel = eff.label;
              // Only on a CHANGE (the CLI can restate the same state) — and NOT
              // through broadcastActiveSessions: the session-card payload
              // carries no turn state at all, so re-broadcasting the whole list
              // here would be a cost with no reader (and a comment claiming a
              // chip that does not exist).
              if (changed || first) broadcastToSession(session, id, { type: 'turn-state', sessionId: id, state: st, authoritative: true });
            } else if (msg.type === 'user' && !msg.parent_tool_use_id && !msg.isSidechain) {
              // Local-command echoes (e.g. "<local-command-stdout>Set model
              // to ...") are user records with NO turn behind them — treating
              // them as a turn start left the chat stuck on "thinking..."
              // forever after a model switch.
              const uText = typeof msg.message?.content === 'string'
                ? msg.message.content
                : (Array.isArray(msg.message?.content) ? msg.message.content.map(b => b.text || '').join('') : '');
              // A5 (review): "Set model to X (resolved-full-id)" echo is the
              // CLI's authoritative resolution — upgrade a BARE-ALIAS lock
              // target to the full id (alias targets false-match intra-family
              // reroutes via the startsWith rule, e.g. 'opus' vs 'opus-4-8',
              // and the repin never fires).
              if (session._modelLocked && session._lockedModel && !/\d/.test(session._lockedModel)) {
                const em = /^<local-command-stdout>Set model to \S+ \(([^)]+)\)/.exec(uText.trim());
                if (em && modelsMatch(session._lockedModel, em[1])) {
                  session._lockedModel = em[1];
                  try { if (session.sockName) writeSessionMeta(session.sockName, { ...(readSessionMeta(session.sockName) || {}), lockedModel: em[1] }); } catch {}
                }
              }
              if (!/^<local-command-/.test(uText.trim())) {
                if (!authoritative) session._isStreaming = true;
                newLabel = 'thinking...';
              }
            } else if (msg.type === 'assistant' && !msg.parent_tool_use_id && !msg.isSidechain) {
              const blocks = msg.message?.content;
              if (Array.isArray(blocks)) {
                const last = blocks[blocks.length - 1];
                if (last?.type === 'thinking') newLabel = 'thinking...';
                else if (last?.type === 'text') newLabel = 'responding';
                else if (last?.type === 'tool_use') newLabel = `running ${last.name || 'tool'}`;
              }
            } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
              // Anthropic API erroring + CLI auto-retrying (up to 10× with
              // backoff — minutes of apparent freeze). Silently dropped, the
              // user sees a bare spinner and files "everything is stuck"
              // (real fleet incident: API 500 burst read as a product hang).
              // Say what's actually happening in the spinner text.
              const attempt = msg.attempt || '?', max = msg.max_retries || 10;
              const why = msg.error_status ? `HTTP ${msg.error_status}` : (msg.error && msg.error !== 'unknown' ? msg.error : 'connection error');
              newLabel = `API retrying (${attempt}/${max}, ${why})…`;
              // AUTH-class failure (2.335.0): a pooled session must route
              // AROUND a banned/expired member, not retry into it forever
              try { notePoolAuthFailure?.(session, id, { status: msg.error_status, message: msg.error, attempt: msg.attempt }); } catch { }
            } else if (msg.type === 'system' && msg.subtype === 'status') {
              // ── THE COMPACTION LANE THAT IS ACTUALLY ON OUR WIRE (§2.11) ──
              // A REAL compaction, captured verbatim in a production buffer
              // (data/session-buffers/sess-5-*.buf, an AUTO compaction with
              // pre_tokens 997587 → post_tokens 11159, duration_ms 174751):
              //   system/status      {status:"compacting"}
              //   system/hook_started/hook_response  SessionStart:compact
              //   system/status      {status:null, compact_result:"success"}
              //   system/compact_boundary {compact_metadata:{trigger:"auto",…}}
              // …and ZERO `compact_progress` records. That is a controlled A/B
              // inside ONE producer: the manual-compact function emits the two
              // twins one line apart, `onCompactEvent?.({type:"compact_progress",
              // …})` (185190125) and `onCompactEvent?.({type:"sdk_status",
              // status:"compacting"})` right after — and only the second one
              // reaches us, because the host's onCompactEvent CONSUMES the
              // first (`case"compact_progress":P.main.applyCompactProgress(
              // x.event);return`, 201341255 — a TUI spinner store) while the
              // second is forwarded through `HRt` (198800990) to the SDK sink
              // as this record (`Oe.type==="sdk_status"` ⇒ `{type:"system",
              // subtype:"status",status,compact_result?,compact_error?}`,
              // 190037796).
              // The whole channel carries exactly two values — 15 `sdk_status`
              // emitters in 2.1.257, all of them "compacting" or null — plus a
              // "requesting" that the forwarder itself filters out
              // (`function wJt(e){return e!=="requesting"&&k5()}`, 198800730).
              // So this branch, NOT compact_progress, is §2.11 in production.
              // It also covers AUTO compaction — the case the user never typed
              // /compact for, which the ws-handler send-site label can never
              // see (it is the only compaction most long sessions ever hit).
              // Card-less, exactly like api_retry above.
              const st = msg.status;
              const cres = typeof msg.compact_result === 'string' ? msg.compact_result : null;
              const cerr = msg.compact_error ? String(msg.compact_error).slice(0, 200) : null;
              const compacting = session._streamingKind === 'compacting';
              if (st === 'compacting') {
                session._streamingKind = 'compacting';
                newLabel = 'Compacting the conversation…';
                broadcastToSession(session, id, { type: 'compact-progress', sessionId: id, event: 'compact_start', hookType: null, hint: null, result: null, error: null });
              } else if ((st === null || st === undefined) && (cres || cerr || compacting)
                         // A bare `status:null` is ALSO the permission-mode echo
                         // (`_r(p,P)` = {status:null,permissionMode,…}, 199038328).
                         // One of those mid-compaction must not be read as "the
                         // compaction finished" — an outcome field, or the
                         // absence of permissionMode, is what makes it ours.
                         && !(msg.permissionMode !== undefined && !cres && !cerr)) {
                session._streamingKind = null;
                newLabel = 'thinking...';
                broadcastToSession(session, id, { type: 'compact-progress', sessionId: id, event: 'compact_end', hookType: null, hint: null, result: cres || (cerr ? 'error' : null), error: cerr });
              }
              // Any other status value (or a permission-mode echo outside a
              // compaction) changes NOTHING — we never invent a stage.
            } else if (msg.type === 'system' && msg.subtype === 'hook_started' && session._streamingKind === 'compacting') {
              // The ONE intermediate stage this lane really has: the same
              // production capture shows `SessionStart:compact` hooks running
              // between the two status records. Gated on an IN-FLIGHT
              // compaction — hook_started fires for every hook in every normal
              // turn (13 of 24 production buffers), and outside a compaction it
              // is none of this branch's business.
              const hn = String(msg.hook_name || msg.hook_event || '').slice(0, 60);
              newLabel = hn ? `Compacting: running ${hn} hooks…` : 'Compacting the conversation…';
              broadcastToSession(session, id, { type: 'compact-progress', sessionId: id, event: 'hooks_start', hookType: hn || null, hint: null, result: null, error: null });
            } else if (msg.type === 'compact_progress' && msg.event && typeof msg.event === 'object') {
              // COMPACTION PROGRESS, the DECLARED lane (§2.11) — kept for
              // SHAPE PARITY, not because it has ever arrived.
              //
              // NO VIBESPACE-SPAWNED CLI HAS EVER EMITTED ONE OF THESE: 24
              // production buffers contain 0 (including the file with a real
              // 2.9-minute auto-compaction, which produced the system/status
              // pair above instead), and the host callback that swallows it is
              // named in the branch above. The branch stays because it costs
              // nothing and the record is declared in the CLI's own schema — if
              // a later version starts forwarding it, this is already the
              // richer lane (hooks phase + the CLI's own hint text). It is NOT
              // what §2.11 runs on today.
              //
              // TWO SPELLINGS, and the schema is NOT the one on the wire.
              // The 2.1.257 zod declaration (offset 179096059) says
              //   hooks_start  {hook_type: pre_compact|post_compact|session_start}
              //   compact_start{hint_text?: string|null}
              //   compact_end
              // but every EMITTER in the same binary builds the camelCase
              // object — `{type:"compact_progress",event:{type:"hooks_start",
              // hookType:"pre_compact"}}` (183979983), `{type:"compact_start",
              // hintText:F}` (183980713), and 185190125/185193937/185195701/
              // 185198872/185209427/192261073 — which `onCompactEvent:(k)=>
              // r.enqueue(k)` (182861070) forwards VERBATIM to stdout. The
              // CLI's own consumer reads camelCase too (189086200:
              // `t.hookType==="pre_compact"`, `u(!0,t.hintText??null)`), and
              // `grep -aob 'hint_text:'` finds exactly ONE hit in the whole
              // binary: the schema literal. Reading only the schema spelling
              // meant "running hook hooks…" and a null hint on every real
              // compaction, which is §2.11's entire point.
              // Read BOTH at this one point (schema shape first — if a later
              // CLI ever makes the emitters match their own declaration, that
              // is the spelling to prefer), and never downstream: the
              // broadcast below publishes ONE normalized shape.
              const ev = msg.event;
              const hookT = ev.hook_type ?? ev.hookType;
              const hintT = ev.hint_text ?? ev.hintText;
              session._streamingKind = ev.type === 'compact_end' ? null : 'compacting';
              if (ev.type === 'hooks_start') newLabel = `Compacting: running ${String(hookT || 'hook').replace(/_/g, ' ')} hooks…`;
              else if (ev.type === 'compact_start') {
                const hint = hintT ? String(hintT).slice(0, 160) : '';
                newLabel = hint ? `Compacting: ${hint}` : 'Compacting the conversation…';
              } else if (ev.type === 'compact_end') newLabel = 'thinking...';
              // The card-less record still has to reach the client that draws
              // the guidance card — it is the ONLY way the card knows a real
              // progress lane exists (the fallback text stops being shown).
              broadcastToSession(session, id, {
                type: 'compact-progress', sessionId: id, event: ev.type || '',
                hookType: hookT || null, hint: hintT ? String(hintT).slice(0, 160) : null,
                // ONE frame shape for both lanes: the declared record carries no
                // outcome, and the client must never have to know which lane it
                // came from (that is how a second consumer gets written).
                result: null, error: null,
              });
            }
            if (newLabel !== null && session._streamingLabel !== newLabel) {
              session._streamingLabel = newLabel;
              broadcastToSession(session, id, { type: 'streaming-label', sessionId: id, label: newLabel, kind: session._streamingKind || null });
            }
          }

          // Track goal state from CLI /goal command (goal_status attachment).
          // Attachments are JSONL-only in current CLI versions — keep the
          // stdout handler in case that changes, but the authoritative sync
          // happens via checkClaudeGoalStatus after each result.
          if (msg.type === 'attachment' && msg.attachment?.type === 'goal_status') {
            const a = msg.attachment;
            const prevGoal = session._goal;
            if (a.durationMs) session._goalElapsed = a.durationMs;
            if (a.tokens) session._goalTokensUsed = a.tokens;
            if (a.met) {
              if (prevGoal) session._prevGoal = prevGoal;
              session._goal = null;
              session._goalStatus = 'complete';
            } else if (a.condition) {
              session._goal = a.condition;
              session._goalStatus = 'active';
            }
            if (session._goal !== prevGoal) {
              broadcastToSession(session, id, { type: 'goal-updated', sessionId: id, goal: session._goal || null, goalStatus: session._goalStatus, goalElapsed: session._goalElapsed || 0,
                statusMsg: a.met ? `Goal met: ${a.condition}` : (a.sentinel ? `Goal set: ${a.condition}` : null) });
            }
          }

          // After each turn, tail the JSONL for goal_status (native goal sync).
          // Immediate check + one delayed re-check (the Stop hook may write
          // the attachment slightly after the result reaches stdout).
          // TURN BOUNDARY (2.369.0 wall machine): classifies walled/normal,
          // runs the per-turn pool eval, arms/disarms — one owner.
          if (msg.type === 'result') { try { noteTurnEnd?.(session); } catch { } }
          // error results carry ban/credit/oauth text the retry path never
          // sees (the CLI gives up without a final api_retry record)
          if (msg.type === 'result' && msg.is_error) { try { notePoolAuthFailure?.(session, id, { message: String(msg.result || msg.error || '') }); } catch { } }
          // Event-driven remote ledger harvest (owner question "为什么15分钟
          // 不实时"): a remote session's turn just ENDED — its usage now
          // exists in the remote transcript, so harvest promptly (60s/host
          // floor) instead of waiting out the idle 15-min cadence. The pool
          // control loop never depended on this (it eats the relayed stdout
          // live via noteLive); this closes the LEDGER/billing-popup lag.
          if (msg.type === 'result' && session.host) {
            try {
              hosts?.harvestUsage(session.host, { minIntervalMs: 60 * 1000, scannerPath: USAGE_SCANNER_PATH })
                .then((txt) => { if (txt) usageHistory.ingestRemoteEvents(session.host, hosts.get(session.host)?.name, txt); })
                .catch(() => { });
            } catch { }
          }
          if (msg.type === 'result') maybeRepinLockedModel(session);
          if (msg.type === 'result' && session._goal) {
            checkClaudeGoalStatus(session, id);
            setTimeout(() => { if (activeSessions.has(id)) checkClaudeGoalStatus(session, id); }, 2000);
          }

          // Track subagent lifecycle: start/stop JSONL watchers
          if (msg.type === 'system' && msg.subtype === 'task_started' && msg.task_type === 'local_agent' && msg.task_id && msg.tool_use_id) {
            startSubagentWatcher(msg.tool_use_id, msg.task_id);
          }
          // Completed agents are served from DISK on attach (sub-agent-*),
          // so the live buffers are dead weight once done — a long session
          // driving dozens of agents retained every subagent message twice
          // (raw buffer + normalizer), unbounded (audit round-2). Grace
          // period lets an already-open live viewer finish rendering.
          const gcSubagent = (tuid) => setTimeout(() => {
            if (!activeSessions.has(id)) return;
            session.subagentBuffers?.delete?.(tuid);
            session.subagentEmittedUuids?.delete?.(tuid);
            session._subNormalizers?.delete?.(tuid);
          }, 60000);
          if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.tool_use_id) {
            stopSubagentWatcher(msg.tool_use_id);
            gcSubagent(msg.tool_use_id);
          }
          // The CURRENT harness signals a background agent's completion with
          // the <task-notification> WAKEUP user record instead (2.233.0
          // discovery) — without this the fs.watch handle + double-buffered
          // transcript lingered until the 10-min idle sweep.
          // Workflow launch ack → arm the usage tailer (file-level "wrapper"
          // for in-process workflow agents — see armWorkflowUsageWatcher).
          if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
            try {
              for (const b of msg.message.content) {
                if (b?.type !== 'tool_result') continue;
                const txt = typeof b.content === 'string' ? b.content
                  : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join('\n') : '';
                const wm = /Run ID: (wf_[\w-]+)/.exec(txt);
                if (wm) armWorkflowUsageWatcher(session, id, wm[1]);
              }
            } catch { }
          }
          if (msg.type === 'user' && (msg.origin?.kind === 'task-notification' || /^\s*<task-notification>/.test(typeof msg.message?.content === 'string' ? msg.message.content : ''))) {
            const notifText = typeof msg.message?.content === 'string' ? msg.message.content : '';
            const tu = notifText.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/);
            if (tu && session.subagentWatchers?.has(tu[1].trim())) {
              stopSubagentWatcher(tu[1].trim());
              gcSubagent(tu[1].trim());
            }
            // Limit banners CARRIED BY workflow/agent failure text (real
            // 2026-08-09 incident: 9 workflow agents died on "You've hit
            // your session limit" — the phrase lives only in the task-
            // notification blob, never as a main-stream assistant banner,
            // so the pool switch waited for full exhaustion).
            const lb = /You've (?:reached|hit) your .{0,40}? ?limit/i.exec(notifText.slice(0, 16384));
            if (lb) { global.__vsEvent?.('cli-usage-limit'); markLimitBanner(session, lb[0]); }
          }
          // Inactivity sweep (audit round-3): an agent whose turn was
          // interrupted / whose CLI died NEVER emits task_notification — its
          // fs.watch handle + double-buffered transcript lived for the
          // session's whole (weeks-long) life. At each turn end, tear down
          // watchers idle >10min; genuinely running background agents keep
          // writing JSONL so their lastActivity stays fresh.
          if (msg.type === 'result' && session.subagentWatchers?.size) {
            const now = Date.now();
            for (const [tuid, entry] of [...session.subagentWatchers]) {
              if (now - (entry.lastActivity || 0) > 10 * 60 * 1000) {
                stopSubagentWatcher(tuid);
                gcSubagent(tuid);
              }
            }
          }

          // TOOL PROGRESS ≠ SUBAGENT (2.227.7, real report "为什么一个 Bash
          // 卡片里出现了 messages"): newer CLIs stream
          // {type:'tool_progress', tool_use_id, tool_name, parent_tool_use_id,
          // elapsed_time_seconds, heartbeat} for a long-running tool — and it
          // carries parent_tool_use_id, the SAME field subagent messages use.
          // The type-blind branch below then buffered them as subagent
          // messages, spun a sub-normalizer per Bash call, and painted the
          // agent-style "N messages · View Log" line on a Bash card. Route
          // them to their own channel (the elapsed seconds are genuinely
          // useful on a pending card) and never into the subagent path.
          if (msg.type === 'tool_progress') {
            broadcastToSession(session, id, {
              type: 'tool-progress', sessionId: id,
              parentToolUseId: msg.parent_tool_use_id || null,
              toolName: msg.tool_name || null,
              elapsedSeconds: msg.elapsed_time_seconds ?? null,
              heartbeat: !!msg.heartbeat,
            });
          } else if (msg.parent_tool_use_id || msg.isSidechain) {
            const ptuid = msg.parent_tool_use_id;
            if (ptuid) {
              // Mark uuid as emitted (for dedup with JSONL watcher)
              if (msg.uuid) {
                if (!session.subagentEmittedUuids.has(ptuid)) session.subagentEmittedUuids.set(ptuid, new Set());
                session.subagentEmittedUuids.get(ptuid).add(msg.uuid);
              }
              // Buffer
              if (!session.subagentBuffers.has(ptuid)) session.subagentBuffers.set(ptuid, []);
              session.subagentBuffers.get(ptuid).push(msg);
            }
            // Broadcast to parent (for tool card status) + normalize for subagent viewers
            broadcastToSession(session, id, { type: 'subagent-message', sessionId: id, parentToolUseId: ptuid, message: msg });
            if (ptuid) {
              if (!session._subNormalizers) session._subNormalizers = new Map();
              if (!session._subNormalizers.has(ptuid)) {
                const subMM = new MessageManager(`sub-${ptuid}`);
                subMM.onOp((op) => broadcastToSession(session, id, { type: 'msg', sessionId: `sub-${ptuid}`, ...op }));
                session._subNormalizers.set(ptuid, subMM);
              }
              session._subNormalizers.get(ptuid).processLive(msg);
            }
            continue;
          }
          // Feed into MessageManager (emits normalized msg ops to all clients)
          // — through the rebuild gate, never processLive directly (2.369.16)
          feedLive(session, msg);
        } catch {
          // Non-JSON line (e.g. dtach noise) — send as raw output
          broadcastToSession(session, id, { type: 'output', sessionId: id, data: line + '\n' });
        }
      }
    });
  }
  return { protocol, attach };
}
module.exports = { protocol, create };
