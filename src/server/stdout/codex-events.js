'use strict';
// CODEX-EVENTS STDOUT CONSUMER (harness S5, docs/design-harness-plugins.md
// §2.4): the 'codex-events' branch of setupSessionPty, moved VERBATIM out of
// src/server/session-stdout.js behind the protocol registry (./index.js).
// ORCH tier by design — it consumes the pool/quota engine
// (recordCodexQuotaSignal, noteTurnEnd) and the delivery ladder, so it cannot
// be bundled for the daemon; the harness descriptor only NAMES it
// (caps.streamProtocol = 'codex-events', the same row harness-contract pins).
// Per-attach state (lineBuf, the ANSI stripper) lives in the attach closure
// exactly as the inline branch kept it; every other field is on the session
// object (src/session-schema.js rows, owner 'stdout').
const { normalizeCodexSource } = require('../../adapters/codex');

const protocol = 'codex-events';

function create({ engine, deliverRef, permissionRulesRef }) {
  const { noteTurnEnd, recordCodexQuotaSignal } = engine;
  function attach(session, id, ptyProcess, { feedLive, broadcastToSession, broadcastActiveSessions, readSessionMeta, writeSessionMeta, updateSessionTodos }) {
    let lineBuf = '';
    const stripAnsi = (value) => String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    ptyProcess.onData((output) => {
      if (session._reattachAttempts) session._reattachAttempts = 0;
      // Append, trim only past 1.5x cap — slicing a fresh 800KB string per
      // delta chunk was hundreds of MB/s of string churn while streaming
      session.buffer += output;
      if (session.buffer.length > 1200000) session.buffer = session.buffer.slice(-800000);
      lineBuf += output;
      let nlIdx;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.substring(0, nlIdx).replace(/\r/g, '').trim();
        lineBuf = lineBuf.substring(nlIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(stripAnsi(line).trim());
          if (msg.type === '_stdin_ack') { session._stdinAckReceived = true; continue; }
          const payload = msg.payload || {};
          // remote transport state (2.139.0 codex remote chat, B-0588) —
          // rides as an event_msg record from the wrapper; mirror the
          // claude branch's broadcast so the status-bar chip works
          if (msg.type === 'event_msg' && payload.type === '_remote_state') {
            session._remoteState = payload.state === 'connected' ? null : { state: payload.state, attempts: payload.attempts || 0, at: Date.now() };
            broadcastToSession(session, id, { type: 'remote-state', sessionId: id, state: payload.state, attempts: payload.attempts || 0 });
            continue;
          }
          const nextThreadId = msg.type === 'session_meta'
            ? payload.id
            : msg.type === 'wrapper_meta'
              ? payload.threadId
              : null;
          // Name ONLY from meta records: every codex function_call carries
          // payload.name = the TOOL name ('shell'…) — ungated, each tool call
          // renamed the session + 2 sync meta writes + 2 broadcasts, forever
          // (audit round-2, high). Real thread names arrive via
          // session_meta/wrapper_meta only.
          const nextThreadName = (msg.type === 'session_meta' || msg.type === 'wrapper_meta')
            ? (payload.session_name || payload.sessionName || payload.threadName || payload.name || payload.thread?.name || null)
            : null;
          const sourceMeta = payload.source ? normalizeCodexSource(payload.source) : null;
          let changed = false;
          // THE SESSION'S EFFORT, from the process that owns it (2.369.62):
          // `session._effort` used to move only when a CLIENT clicked the
          // status-bar picker, so an effort the wrapper adopted from the thread
          // (spawn env empty) or a `/effort` typed into the chat never reached
          // session-meta — and the next resume spawned with a stale value that
          // then labelled every turn. wrapper_meta.effortNext = what the next
          // turn will run at = exactly what a resume must carry.
          //
          // ONE FACT, NOT TWO (r2 review): `effortNext` is the ONLY field this
          // may read. `effort` is the LAST TURN's level — the very conflation
          // this release exists to end — and `effortNext: null` is a POSITIVE
          // statement ("nothing pending: the agent's own config decides"), not
          // a gap to fill. Falling back to `effort` made picking "Auto (model
          // default)" write the last turn's level into session-meta, so the
          // attach payload, the chip after a restart and the next resume spawn
          // all re-commanded a level the user had just cleared. A wrapper that
          // predates this release sends NEITHER field ⇒ `undefined` ⇒ we leave
          // `session._effort` exactly where master left it.
          if (msg.type === 'wrapper_meta' && payload.effortNext !== undefined) {
            const nextEffort = payload.effortNext || null;
            if ((session._effort || null) !== nextEffort) {
              // WHICH FACT this new value is (B-6b6d): if we had commanded
              // nothing, the wrapper is reporting what the THREAD itself runs
              // at (it adopted it on resume) — that is the conversation's own
              // value. If it moves away from a value we DID command, someone
              // changed it inside the session (`/effort` in the chat, another
              // client's picker) — that is a choice for this session. The panel
              // must never keep calling a hand-changed value "the conversation's
              // own" (the contradiction 2.369.58's r2 review removed).
              session._effortOrigin = (session._effort || null) === null ? 'conversation' : 'chosen';
              session._effort = nextEffort;
              changed = true;
            }
          }
          // A mid-life thread id change (thread/fork, a resume that minted a
          // new id) re-points the session here AND the normalizer's ledger-key
          // default: the SAME wrapper_meta record reaches it through feedLive
          // below (codex-message-manager._adoptThreadId replaces on
          // wrapper_meta.threadId, constructor default or not), in stream
          // order — a rebuild in flight queues it behind the history, which a
          // direct assignment into the normalizer from here would not honour.
          if (nextThreadId && session.backendSessionId !== nextThreadId) {
            if (session.backendSessionId) {
              const prev = session.forkedFrom || [];
              if (!prev.includes(session.backendSessionId)) prev.push(session.backendSessionId);
              session.forkedFrom = prev;
            }
            session.backendSessionId = nextThreadId;
            session.claudeSessionId = null;
            changed = true;
          }
          if (nextThreadName && session.name !== nextThreadName) {
            session.name = nextThreadName;
            changed = true;
          }
          if (payload.cwd && session.cwd !== payload.cwd) {
            session.cwd = payload.cwd;
            changed = true;
          }
          if (sourceMeta) {
            const nextFields = {
              sourceKind: sourceMeta.sourceKind || null,
              agentKind: sourceMeta.agentKind || 'primary',
              agentRole: sourceMeta.agentRole || '',
              agentNickname: sourceMeta.agentNickname || '',
              parentThreadId: sourceMeta.parentThreadId || null,
            };
            for (const [key, value] of Object.entries(nextFields)) {
              if ((session[key] || null) !== (value || null)) {
                session[key] = value;
                changed = true;
              }
            }
          }
          if (changed && session.sockName) {
            writeSessionMeta(session.sockName, {
              ...(readSessionMeta(session.sockName) || {}), // preserve keys not re-listed (agentToken/taskId/accountId)
              name: session.name,
              cwd: session.cwd,
              backend: session.backend,
              backendSessionId: session.backendSessionId,
              claudeSessionId: null,
              sourceKind: session.sourceKind || null,
              agentKind: session.agentKind || 'primary',
              agentRole: session.agentRole || '',
              agentNickname: session.agentNickname || '',
              parentThreadId: session.parentThreadId || null,
              forkedFrom: session.forkedFrom || null,
              permissionMode: session._permissionMode || null,
              effort: session._effort || null,
              // …AND WHICH FACT IT IS (B-6b6d round 3). This consumer AUTHORS
              // `_effortOrigin` a few lines up, so it must write it with the
              // value it describes: without this the disk kept the SPAWN's
              // origin while memory moved on, and after a restart
              // boot-restore rebuilt `_effortOrigin` from that stale key —
              // Session Properties then called a value the user had just
              // changed by hand inside the session "this conversation's own
              // value", the exact contradiction the origin exists to remove.
              // `modelOrigin` is deliberately NOT listed: nothing here
              // authors it, and the spread above already carries it through.
              // Re-listing a key this writer does not own would stamp `null`
              // over a real disk value for any session object that lacks the
              // field (leg ⑦'s negative control pins that it survives).
              effortOrigin: session._effortOrigin || null,
              createdAt: session.createdAt,
              webuiSessionId: id,
              mode: session.mode,
            });
            broadcastActiveSessions();
          }
          // Track turn lifecycle: streaming state + activity label
          {
            let newLabel = null;
            if (msg.type === 'event_msg') {
              const evType = payload.type;
              if (evType === 'task_started' && payload.turn_id) { session._isStreaming = true; newLabel = 'thinking...'; }
              else if (evType === 'task_complete' || evType === 'turn_aborted' || evType === 'task_failed') { session._isStreaming = false; newLabel = ''; }
              else if (evType === 'goal_updated' && payload.goal) {
                session._goal = payload.goal.objective || null;
                session._goalElapsed = (payload.goal.timeUsedSeconds || payload.goal.time_used_seconds || 0) * 1000;
                session._goalStatus = payload.goal.status || null;
                broadcastToSession(session, id, { type: 'goal-updated', sessionId: id, goal: session._goal, goalElapsed: session._goalElapsed, goalStatus: session._goalStatus });
              } else if (evType === 'goal_cleared') {
                if (session._goal) session._prevGoal = session._goal;
                session._goal = null; session._goalElapsed = 0; session._goalStatus = null;
                broadcastToSession(session, id, { type: 'goal-updated', sessionId: id, goal: null, statusMsg: 'Goal cleared' });
              }
            } else if (msg.type === 'response_item') {
              const itemType = payload.type;
              if (itemType === 'message' && payload.role === 'assistant') newLabel = 'responding';
              else if (itemType === 'function_call') newLabel = `running ${payload.name || 'tool'}`;
              else if (itemType === 'reasoning') newLabel = 'thinking...';
            }
            if (newLabel !== null && session._streamingLabel !== newLabel) {
              session._streamingLabel = newLabel;
              broadcastToSession(session, id, { type: 'streaming-label', sessionId: id, label: newLabel, kind: session._streamingKind || null });
            }
          }
          // Codex quota signals → pool/auto-resume engine (P2): readings +
          // typed exhaustion, relayed by the wrapper (older wrappers simply
          // never emit these — additive, no capability gate needed)
          if (msg.type === 'event_msg' && (msg.payload?.type === 'rate_limits_updated' || msg.payload?.type === 'task_failed' || msg.payload?.type === 'reset_credit_result')) {
            try { recordCodexQuotaSignal?.(session, msg.payload); } catch {}
          }
          // codex turn boundary (task_complete; task_failed classifies
          // inside recordCodexQuotaSignal) — same wall machine as claude
          if (msg.type === 'event_msg' && msg.payload?.type === 'task_complete') {
            try { noteTurnEnd?.(session); } catch {}
          }
          // rpc-queue delivery honesty (peerDelivery registry lane): the
          // deliver ladder returned ok on the stdin write, so a wrapper-side
          // failure (queue/add rejected, turn/start error) must RE-STASH the
          // text for next-turn injection — never silently lose a promised
          // message. (ok:true needs no action: the wrapper recorded it.)
          // PROPERTY ACCESS, never a call (round-3 verifier, reproduced): the
          // lazy singleton refs are mk() Proxies over a plain `{}` target —
          // truthy, but NOT callable. `deliverRef()` threw TypeError on every
          // failed delivery and the bare `catch {}` ate it, so this lane
          // logged "re-stashing" and stashed nothing. The catch now logs the
          // message verbatim: a degrade path that swallows its own bug is the
          // only reason this survived (2.276.0 writer-sweep lesson).
          if (msg.type === 'event_msg' && msg.payload?.type === 'peer_message_result' && msg.payload.ok === false && msg.payload.text) {
            const cid = session.backendSessionId || session.claudeSessionId;
            console.log(`[deliver] rpc-queue wrapper delivery failed (${msg.payload.reason || 'unknown'}) — re-stashing for ${cid}`);
            try { if (cid) deliverRef?.stashFor?.(cid, { source: 'agent', fromName: msg.payload.fromName || null, text: String(msg.payload.text) }); }
            catch (e) { console.warn(`[deliver] ${id}: re-stash failed: ${e.message}`); }
          }
          // A notification that could NOT be steered fell back to the queue
          // (the turn ended between the check and the RPC, or it was a
          // review/compact turn). It was delivered either way — but the lane
          // it actually took is the fact an operator needs when a session
          // shows a queued notification the design says should have steered.
          if (msg.type === 'event_msg' && msg.payload?.type === 'peer_message_result' && msg.payload.ok === true && msg.payload.steerFailed) {
            console.log(`[deliver] rpc-queue: turn/steer refused (${msg.payload.steerFailed}${msg.payload.steerDetail ? ': ' + msg.payload.steerDetail : ''}) — the notification took the '${msg.payload.mode}' lane instead`);
          }
          // THE SPEND SETTLEMENT for that same answer (r2). The ladder does not
          // charge a notification it predicted would be STEERED into a turn
          // already running — that opens no turn, so charging it would spend
          // the money ceiling on nothing and then refuse the auto-resume
          // continue that does cost. The prediction can be wrong (the turn
          // ended between the check and the RPC; a review/compact turn is not
          // steerable), and the wrapper is the only party that knows: `mode`
          // 'steered' drops the withheld charge, 'queued'/'turn' charges it
          // now. ok:false charges nothing — the re-stash above keeps the words
          // and they ride a turn that was going to happen anyway.
          // PROPERTY ACCESS on the lazy ref, never a call (the mk() Proxy
          // lesson two blocks up); the degrade catch logs verbatim.
          if (msg.type === 'event_msg' && msg.payload?.type === 'peer_message_result') {
            const cid = session.backendSessionId || session.claudeSessionId;
            try { if (cid) deliverRef?.settleRpcDelivery?.(cid, { ok: msg.payload.ok !== false, mode: msg.payload.mode || null }); }
            catch (e) { console.warn(`[deliver] ${id}: spend settle failed: ${e.message}`); }
          }
          // READ-ONLY permission-rule answer (owner ruling 10): the wrapper
          // replied to `read-permission-rules`. It goes to exactly ONE place —
          // the pending HTTP read that asked for it, matched by requestId.
          // It is NOT a client-facing record: nothing in the browser consumes
          // a `permission_rules` record, so a second window watching the same
          // session still has to click its own button (each door is
          // human-triggered by design; there is no cached tree to invalidate).
          // It is in the normalizer's SKIPPED_EVENT_TYPES for that reason —
          // deliberately card-less, never an "unknown record" (round-2
          // verifier: the earlier version of this comment promised a live
          // broadcast the client never implemented).
          // PROPERTY ACCESS, never a call (round-3 verifier, reproduced on the
          // real registry): `permissionRulesRef` is an mk() Proxy over `{}` —
          // `ref()` is a TypeError, so EVERY answer was dropped and every
          // "Show rules…" on a live codex session waited out the 20s timeout
          // and reported `read-failed`. The Proxy's get trap already returns a
          // BOUND method, or `undefined` while the singleton is not up yet, so
          // the optional chain is the whole null check.
          if (msg.type === 'event_msg' && msg.payload?.type === 'permission_rules') {
            try { permissionRulesRef?.onWrapperRecord?.(id, msg.payload); } catch (e) { console.warn(`[permission-rules] ${id}: answer handling failed: ${e.message}`); }
          }
          // Codex plan tool → the session's live TODO summary (board pill)
          if (msg.type === 'event_msg' && msg.payload?.type === 'plan_updated' && Array.isArray(msg.payload.plan)) {
            updateSessionTodos(session, msg.payload.plan.map((p) => ({
              content: p.step || '',
              status: (p.status === 'inProgress' || p.status === 'in_progress') ? 'in_progress' : (p.status === 'completed' ? 'completed' : 'pending'),
            })));
          }
          feedLive(session, msg);
        } catch {
          broadcastToSession(session, id, { type: 'output', sessionId: id, data: line + '\n' });
        }
      }
    });
  }
  return { protocol, attach };
}
module.exports = { protocol, create };
