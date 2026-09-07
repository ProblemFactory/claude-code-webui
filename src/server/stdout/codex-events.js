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

function create({ engine, deliverRef }) {
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
          if (msg.type === 'event_msg' && msg.payload?.type === 'peer_message_result' && msg.payload.ok === false && msg.payload.text) {
            const cid = session.backendSessionId || session.claudeSessionId;
            console.log(`[deliver] rpc-queue wrapper delivery failed (${msg.payload.reason || 'unknown'}) — re-stashing for ${cid}`);
            try { if (cid) deliverRef()?.stashFor(cid, { source: 'agent', fromName: msg.payload.fromName || null, text: String(msg.payload.text) }); } catch {}
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
