'use strict';
// ACP-EVENTS STDOUT CONSUMER (harness S5, docs/design-harness-plugins.md
// §2.4): the 'acp-events' branch of setupSessionPty (added 2.369.29 with the
// generic ACP v1 harness), moved VERBATIM out of src/server/session-stdout.js
// behind the protocol registry (./index.js). ORCH tier: it consumes the wall
// machine's noteTurnEnd, the model registry (noteHarnessModels) and the
// delivery ladder — the descriptor only NAMES it (caps.streamProtocol =
// 'acp-events'; acpHarness() refuses any other value). Per-attach state
// (lineBuf) lives in the attach closure as before; everything else is on the
// session object.
const protocol = 'acp-events';

function create({ engine, noteHarnessModels, deliverRef, permissionRulesRef }) {
  const { noteTurnEnd } = engine;
  function attach(session, id, ptyProcess, { feedLive, broadcastToSession, broadcastActiveSessions, readSessionMeta, writeSessionMeta, updateSessionTodos }) {
    let lineBuf = '';
    // ACP v1 harnesses (S8, docs/design-harness-plugins.md §2.3): the
    // generic wrapper (data/bin/acp-wrapper.js) journals ONE JSON record per
    // line ({type:'acp', kind, …}; shape documented at its top). This
    // consumer is deliberately small: id adoption from the `session` record,
    // the streaming flag from prompt_start/prompt_end, the activity label,
    // todos from `plan`, the agent's offered models into the model registry,
    // peer-delivery honesty, then feedLive for the normalizer. No wall
    // machine: ACP carries no subscription-quota signal (usage_update is
    // context size).
    ptyProcess.onData((output) => {
      if (session._reattachAttempts) session._reattachAttempts = 0;
      session.buffer += output;
      if (session.buffer.length > 1200000) session.buffer = session.buffer.slice(-800000);
      lineBuf += output;
      let nlIdx;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.substring(0, nlIdx).replace(/\r/g, '').trim();
        lineBuf = lineBuf.substring(nlIdx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { broadcastToSession(session, id, { type: 'output', sessionId: id, data: line + '\n' }); continue; }
        try {
          if (msg.type === '_stdin_ack') { session._stdinAckReceived = true; continue; }
          if (msg.type !== 'acp') { feedLive(session, msg); continue; } // e.g. the echoed permission-response frame
          let newLabel = null;
          if (msg.kind === 'session') {
            // The agent's session id IS the conversation id (resume = session/load with it)
            let changed = false;
            if (msg.sessionId && session.backendSessionId !== msg.sessionId) {
              if (session.backendSessionId) {
                const prev = session.forkedFrom || [];
                if (!prev.includes(session.backendSessionId)) prev.push(session.backendSessionId);
                session.forkedFrom = prev;
              }
              session.backendSessionId = msg.sessionId;
              session.claudeSessionId = null;
              changed = true;
            }
            if (msg.cwd && session.cwd !== msg.cwd) { session.cwd = msg.cwd; changed = true; }
            if (changed && session.sockName) {
              writeSessionMeta(session.sockName, {
                ...(readSessionMeta(session.sockName) || {}),
                name: session.name, cwd: session.cwd, backend: session.backend,
                backendSessionId: session.backendSessionId, claudeSessionId: null,
                forkedFrom: session.forkedFrom || null,
                permissionMode: session._permissionMode || null, effort: session._effort || null,
                createdAt: session.createdAt, webuiSessionId: id, mode: session.mode,
              });
              broadcastActiveSessions();
            }
            if (Array.isArray(msg.models) && msg.models.length) { try { noteHarnessModels?.(session.backend, msg.models); } catch {} }
            if (msg.how === 'load' || msg.how === 'resume') newLabel = '';
          } else if (msg.kind === 'config') {
            if (Array.isArray(msg.models) && msg.models.length) { try { noteHarnessModels?.(session.backend, msg.models); } catch {} }
          } else if (msg.kind === 'prompt_start') {
            session._isStreaming = true; newLabel = 'thinking...';
          } else if (msg.kind === 'prompt_end') {
            session._isStreaming = false; newLabel = '';
            try { noteTurnEnd?.(session); } catch {}
          } else if (msg.kind === 'update') {
            const u = msg.update || {};
            if (u.sessionUpdate === 'agent_message_chunk') newLabel = 'responding';
            else if (u.sessionUpdate === 'agent_thought_chunk') newLabel = 'thinking...';
            else if (u.sessionUpdate === 'tool_call') newLabel = `running ${String(u.title || u.kind || 'tool').slice(0, 60)}`;
            else if (u.sessionUpdate === 'plan' && Array.isArray(u.entries)) {
              updateSessionTodos(session, u.entries.map((e) => ({ content: String(e?.content || ''), status: e?.status === 'in_progress' ? 'in_progress' : (e?.status === 'completed' ? 'completed' : 'pending') })));
            }
          } else if (msg.kind === 'permission_rules') {
            // READ-ONLY rule answer (ruling 10). For ACP the answer is always
            // 'unsupported-by-protocol' + the live mode — routed anyway, so a
            // pending read gets a TYPED refusal instead of a timeout.
            // PROPERTY ACCESS, never a call — see the twin note in
            // codex-events.js: these lazy refs are mk() Proxies over `{}`, so
            // `ref()` throws TypeError and the answer never lands.
            try { permissionRulesRef?.onWrapperRecord?.(id, msg); } catch (e) { console.warn(`[permission-rules] ${id}: answer handling failed: ${e.message}`); }
          } else if (msg.kind === 'peer_result' && msg.ok === false && msg.text) {
            // same honesty rule as the codex rpc-queue lane: a promised message never silently dies
            const cid = session.backendSessionId;
            console.log(`[deliver] acp wrapper delivery failed (${msg.reason || 'unknown'}) — re-stashing for ${cid}`);
            try { if (cid) deliverRef?.stashFor?.(cid, { source: 'agent', fromName: msg.fromName || null, text: String(msg.text) }); }
            catch (e) { console.warn(`[deliver] ${id}: re-stash failed: ${e.message}`); }
          }
          if (newLabel !== null && session._streamingLabel !== newLabel) {
            session._streamingLabel = newLabel;
            broadcastToSession(session, id, { type: 'streaming-label', sessionId: id, label: newLabel, kind: session._streamingKind || null });
          }
          feedLive(session, msg);
        } catch (e) { console.error(`[acp] record handling failed (${msg.kind || msg.type}): ${e.message}`); }
      }
    });
  }
  return { protocol, attach };
}
module.exports = { protocol, create };
