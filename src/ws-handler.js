/**
 * WebSocket connection handler — terminal/chat I/O, session create/attach/kill,
 * state sync, layout sync, tmux attach, permission/interrupt control.
 */

const { MessageManager } = require('./message-manager');
const { createMessageManager } = require('./normalizers');
const { listCodexThreads } = require('./codex-session-store');
const { cwdToProjectDir } = require('./session-store');

function getSessionKey(session = {}) {
  const backend = session.backend || 'claude'; // fallback needed: called with API data too
  const backendSessionId = session.backendSessionId || session.sessionId || session.claudeSessionId || null;
  return backendSessionId ? `${backend}:${backendSessionId}` : '';
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

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

function registerWsHandler(wss, ctx) {
  const {
    activeSessions, WS_OPEN, broadcastActiveSessions, broadcastToSession, resizeSessionToMin,
    setupSessionPty, refreshWebuiPids, deleteSessionMeta, writeSessionMeta,
    readLayouts, writeLayouts, getSyncStore,
    sessionCounterRef, createSessionMessages, PERMISSION_MODES,
    SOCKETS_DIR, BUFFERS_DIR, META_DIR, PTY_WRAPPER, CHAT_WRAPPER,
    NODE_CMD, DTACH_CMD, ENV_CMD, CLAUDE_CMD, EDITOR_CMD, PORT,
    adapterRegistry, pty, path, fs, os, execFileSync, ensureDir,
  } = ctx;

  wss.on('connection', (ws) => {
    const attachedSessions = new Set();

    // Send current active sessions on connect
    const activeList = [];
    for (const [id, s] of activeSessions) {
      activeList.push({
        id,
        name: s.name,
        cwd: s.cwd,
        createdAt: s.createdAt,
        backend: s.backend || 'claude',
        backendSessionId: s.backendSessionId || s.claudeSessionId || null,
        sessionKey: getSessionKey(s),
        claudeSessionId: s.claudeSessionId || null,
        sourceKind: s.sourceKind || null,
        agentKind: s.agentKind || 'primary',
        agentRole: s.agentRole || '',
        agentNickname: s.agentNickname || '',
        parentThreadId: s.parentThreadId || null,
        mode: s.mode || 'terminal',
      });
    }
    ws.send(JSON.stringify({ type: 'active-sessions', sessions: activeList }));

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.type) {
        case 'create': {
          const backend = data.backend || 'claude';
          const adapter = adapterRegistry?.get?.(backend) || null;
          if (!adapter) {
            ws.send(JSON.stringify({ type: 'error', message: `Unknown backend "${backend}".` }));
            break;
          }
          const id = 'sess-' + (++sessionCounterRef.value) + '-' + Date.now();
          const cwd = data.cwd || os.homedir();
          const sockName = 'cw-' + sessionCounterRef.value + '-' + Date.now();
          const socketPath = path.join(SOCKETS_DIR, sockName);
          const sessionMode = data.mode === 'chat' ? 'chat' : 'terminal';
          const extraArgs = data.extraArgs ? data.extraArgs.trim().split(/\s+/).filter(Boolean) : [];
          const sessionSpec = adapter.buildSessionArgs({
            cwd,
            model: data.model,
            permissionMode: data.permissionMode,
            resumeId: data.resume && data.resumeId ? data.resumeId : null,
            sessionName: data.sessionName,
            effort: data.effort,
            extraArgs,
            initialPrompt: data.initialPrompt || '',
            mode: sessionMode,
          });
          const codexThreadBaseline = backend === 'codex' && !data.resumeId
            ? new Set(listCodexThreads({ activeSessions }).map((entry) => entry.backendSessionId || entry.sessionId).filter(Boolean))
            : null;

          ensureDir(SOCKETS_DIR);
          ensureDir(BUFFERS_DIR);

          const session = {
            mode: sessionMode,
            pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
            cwd, name: data.sessionName || `Session ${sessionCounterRef.value}`,
            createdAt: Date.now(),
            backend,
            backendSessionId: data.resumeId || null,
            claudeSessionId: backend === 'claude' ? (data.resumeId || null) : null,
            sourceKind: data.sourceKind || null,
            agentKind: data.agentKind || 'primary',
            agentRole: data.agentRole || '',
            agentNickname: data.agentNickname || '',
            parentThreadId: data.parentThreadId || null,
            sockName, socketPath, buffer: '',
          };
          if (codexThreadBaseline) session._codexThreadBaseline = codexThreadBaseline;
          if (sessionMode === 'chat') {
            session._normalizer = createMessageManager(backend, id);
            session._normalizer.onOp((op) => {
              broadcastToSession(session, id, { type: 'msg', sessionId: id, ...op });
            });
          }

          // Use appropriate wrapper inside dtach:
          // - Terminal: pty-wrapper.js (spawns claude with PTY for TUI mode)
          // - Chat: chat-wrapper.js (spawns claude with --output-format stream-json)
          const bufFile = path.join(BUFFERS_DIR, id + '.buf');
          const metaFileW = path.join(BUFFERS_DIR, id + '.json');
          const wrapper = sessionSpec.wrapper || (sessionMode === 'chat' ? CHAT_WRAPPER : PTY_WRAPPER);
          let createPty;
          try {
            createPty = pty.spawn(DTACH_CMD, ['-c', socketPath, '-E', '-r', 'none',
              NODE_CMD, wrapper,
              bufFile, metaFileW,
              ENV_CMD, `EDITOR=${EDITOR_CMD}`, `CLAUDE_WEBUI_PORT=${PORT}`, `CLAUDE_WEBUI_SESSION_ID=${id}`, `DISPLAY=${process.env.DISPLAY || (process.platform === 'darwin' ? '' : ':99')}`,
              `TERM=xterm-256color`, `COLORTERM=truecolor`,
              ...Object.entries(sessionSpec.env || {}).map(([k, v]) => `${k}=${v == null ? '' : String(v)}`),
              sessionSpec.cmd || CLAUDE_CMD, ...(sessionSpec.args || []),
            ], {
              name: 'xterm-256color', cols: data.cols || 120, rows: data.rows || 30,
              cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
            });
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to spawn session: ${err.message}\ndtach=${DTACH_CMD} node=${NODE_CMD} env=${ENV_CMD} cwd=${cwd}` }));
            return;
          }
          setupSessionPty(session, id, createPty);

          activeSessions.set(id, session);
          attachedSessions.add(id);

          writeSessionMeta(sockName, {
            name: session.name,
            cwd,
            backend: session.backend,
            backendSessionId: session.backendSessionId,
            claudeSessionId: session.claudeSessionId,
            sourceKind: session.sourceKind,
            agentKind: session.agentKind,
            agentRole: session.agentRole,
            agentNickname: session.agentNickname,
            parentThreadId: session.parentThreadId,
            createdAt: session.createdAt,
            webuiSessionId: id,
            mode: sessionMode,
          });

          // Capture claudeSessionId from lock file for new (non-resume) Claude sessions
          if (backend === 'claude' && !session.claudeSessionId) {
            const { SESSIONS_DIR } = require('./session-store');
            const tryCapture = (attempts) => {
              if (attempts <= 0 || !activeSessions.has(id)) return;
              try {
                const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
                for (const f of files) {
                  const lockData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
                  if (lockData.cwd === cwd && lockData.startedAt > session.createdAt - 5000) {
                    session.claudeSessionId = lockData.sessionId;
                    session.backendSessionId = lockData.sessionId;
                    writeSessionMeta(sockName, {
                      name: session.name,
                      cwd,
                      backend: session.backend,
                      backendSessionId: session.backendSessionId,
                      claudeSessionId: session.claudeSessionId,
                      sourceKind: session.sourceKind,
                      agentKind: session.agentKind,
                      agentRole: session.agentRole,
                      agentNickname: session.agentNickname,
                      parentThreadId: session.parentThreadId,
                      createdAt: session.createdAt,
                      webuiSessionId: id,
                      mode: sessionMode,
                    });
                    broadcastActiveSessions();
                    return;
                  }
                }
              } catch {}
              setTimeout(() => tryCapture(attempts - 1), 1000);
            };
            setTimeout(() => tryCapture(15), 2000);
          }

          if (backend === 'codex' && !session.backendSessionId) {
            const tryCapture = (attempts) => {
              if (attempts <= 0 || !activeSessions.has(id)) return;

              const matched = pickCodexThreadCandidate({
                activeSessions,
                webuiSessionId: id,
                cwd: session.cwd,
                createdAt: session.createdAt,
                baselineThreadIds: session._codexThreadBaseline,
                pathLib: path,
              });

              if (matched) {
                session._captureReservedThreadId = matched.backendSessionId || matched.sessionId || null;
                session.backendSessionId = matched.backendSessionId || matched.sessionId || session.backendSessionId;
                session.claudeSessionId = null;
                if (matched.name) session.name = matched.name;
                if (matched.cwd) session.cwd = matched.cwd;
                if (matched.sourceKind) session.sourceKind = matched.sourceKind;
                if (matched.agentKind) session.agentKind = matched.agentKind;
                if (matched.agentRole != null) session.agentRole = matched.agentRole || '';
                if (matched.agentNickname != null) session.agentNickname = matched.agentNickname || '';
                if (matched.parentThreadId !== undefined) session.parentThreadId = matched.parentThreadId || null;

                writeSessionMeta(sockName, {
                  name: session.name,
                  cwd: session.cwd,
                  backend: session.backend,
                  backendSessionId: session.backendSessionId,
                  claudeSessionId: session.claudeSessionId,
                  sourceKind: session.sourceKind,
                  agentKind: session.agentKind,
                  agentRole: session.agentRole,
                  agentNickname: session.agentNickname,
                  parentThreadId: session.parentThreadId,
                  createdAt: session.createdAt,
                  webuiSessionId: id,
                  mode: sessionMode,
                });
                delete session._codexThreadBaseline;
                delete session._captureReservedThreadId;
                broadcastActiveSessions();
                return;
              }

              setTimeout(() => tryCapture(attempts - 1), 1500);
            };
            setTimeout(() => tryCapture(40), 1500);
          }

          // Read childPid from wrapper metadata after it has time to spawn
          setTimeout(() => refreshWebuiPids(), 3000);

          ws.send(JSON.stringify({ type: 'created', sessionId: id, name: session.name, cwd, mode: sessionMode }));
          broadcastActiveSessions();
          break;
        }

        case 'set-permission-mode': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && data.mode) {
            const adapter = adapterRegistry.get(session.backend);
            if (adapter) session.pty.write(adapter.formatSetPermissionMode(data.mode) + '\n');
          }
          break;
        }

        case 'input': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty) session.pty.write(data.data);
          break;
        }

        case 'chat-input': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat') {
            const adapter = adapterRegistry.get(session.backend);
            if (!adapter) break;
            const msgId = data.msgId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
            const { stdinPayload, userMsg } = adapter.formatChatInput(data.text, msgId);
            session.pty.write(stdinPayload + '\n');
            if (userMsg) {
              session.buffer = (session.buffer + JSON.stringify(userMsg) + '\n').slice(-500000);
              if (session._normalizer) session._normalizer.processLive(userMsg);
            }
          }
          break;
        }

        case 'interrupt': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat') {
            const adapter = adapterRegistry.get(session.backend);
            if (adapter) {
              session.pty.write(adapter.formatInterrupt() + '\n');
              adapter.postInterrupt(session);
            }
          }
          break;
        }

        case 'review-start': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat' && session.backend === 'codex' && data.target) {
            session.pty.write(JSON.stringify({
              type: 'review-start',
              target: data.target,
              delivery: data.delivery || undefined,
            }) + '\n');
          }
          break;
        }

        case 'permission-response': {
          const session = activeSessions.get(data.sessionId);
          if (session?.pty && session.mode === 'chat') {
            const adapter = adapterRegistry.get(session.backend);
            if (adapter) {
              const payload = adapter.formatPermissionResponse(data);
              session.pty.write(payload + '\n');
              // Record in buffer so permission state survives refresh/restart
              session.buffer = (session.buffer + payload + '\n').slice(-500000);
              if (session._normalizer) session._normalizer.processLive(JSON.parse(payload));
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
          if (session.backend === 'codex' && session.mode === 'chat' && session.pty && trimmedName) {
            session.pty.write(JSON.stringify({ type: 'set-thread-name', name: trimmedName }) + '\n');
          }
          if (session.sockName) {
            writeSessionMeta(session.sockName, {
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
            session.clients.set(ws, { cols: data.cols, rows: data.rows });
            resizeSessionToMin(session, data.sessionId);
          }
          break;
        }

        case 'attach': {
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
              let rawMsgs = [], meta = {};
              const candidates = [path.join(projectsDir, projDir, claudeId, 'subagents')];
              try { for (const dir of fs.readdirSync(projectsDir)) { const fp = path.join(projectsDir, dir, claudeId, 'subagents'); if (!candidates.includes(fp)) candidates.push(fp); } } catch {}
              for (const subDir of candidates) {
                const fp = path.join(subDir, `agent-${agentId}.jsonl`);
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
              subMM.convertHistory(rawMsgs);
              ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', messages: subMM.messages, totalCount: subMM.total, meta }));
            } else {
              // Live agent: sub-{parentToolUseId} — find parent session and return buffered messages
              const toolUseId = subId.slice('sub-'.length);
              let found = false;
              for (const [sid, sess] of activeSessions) {
                if (sess.subagentBuffers?.has(toolUseId)) {
                  sess.clients.set(ws, { cols: 120, rows: 30 }); // register for broadcasts
                  const rawMsgs = sess.subagentBuffers.get(toolUseId);
                  // Use existing sub-normalizer if available, or create one
                  if (!sess._subNormalizers) sess._subNormalizers = new Map();
                  let subMM = sess._subNormalizers.get(toolUseId);
                  if (!subMM) {
                    subMM = new MessageManager(subId);
                    subMM.onOp((op) => broadcastToSession(sess, sid, { type: 'msg', sessionId: subId, ...op }));
                    subMM.convertHistory(rawMsgs);
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
              const sm = createSessionMessages(session, data.sessionId);
              // Initialize normalizer from history if not yet done
              if (session._normalizer && session._normalizer.total === 0) {
                session._normalizer.convertHistory(sm.raw());
              }
              const messages = session._normalizer ? session._normalizer.tail(50) : [];
              const totalCount = session._normalizer ? session._normalizer.total : 0;

              const turnMap = session._normalizer ? session._normalizer.turnMap() : [];
              const pendingPerms = sm.activePendingPermissions?.() || {};
              ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, mode: 'chat',
                messages, totalCount, chatStatus: sm.chatStatus(), isStreaming: sm.isStreaming, taskState: sm.taskState(), turnMap, pendingPermissions: pendingPerms }));
            } else {
              ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, buffer: session.buffer || '' }));
            }
          } else if (data.viewOnly && (data.backendSessionId || data.claudeSessionId)) {
            // View-only: load JSONL history without an active session
            const backendSessionId = data.backendSessionId || data.claudeSessionId;
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
            const mm = createMessageManager(data.backend || 'claude', data.sessionId || 'view');
            mm.convertHistory(sm.raw());
            ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: data.name || '', cwd: data.cwd || '', mode: 'chat',
              messages: mm.tail(50), totalCount: mm.total, chatStatus: sm.chatStatus(), isStreaming: false, viewOnly: true }));
          } else {
            ws.send(JSON.stringify({ type: 'error', message: `Session ${data.sessionId} not found` }));
          }
          break;
        }

        case 'kill': {
          const session = activeSessions.get(data.sessionId);
          if (session) {
            // Kill the dtach session process (which kills claude as its child)
            // The dtach process is the parent of our attach PTY's target
            if (session.socketPath) {
              try {
                // Find dtach process by socket path and kill it
                const out = execFileSync('pgrep', ['-f', session.socketPath], { encoding: 'utf-8', timeout: 2000 }).trim();
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
          // Layout state sync: save to disk + broadcast to other clients
          const layoutData = readLayouts();
          const desktopId = data.desktopId;
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
          const syncMsg = JSON.stringify({ type: 'layout-sync', desktopId, state: data.state, desktopMeta: layoutData.desktopMeta || [] });
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

        case 'tmux-attach': {
          // Attach to a running tmux pane (read-only view of external session)
          const tmuxTarget = data.tmuxTarget;
          if (!tmuxTarget) { ws.send(JSON.stringify({ type: 'error', message: 'No tmux target' })); break; }

          const id = 'tmux-' + (++sessionCounterRef.value) + '-' + Date.now();
          const tmuxPty = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
            name: 'xterm-256color', cols: data.cols || 120, rows: data.rows || 30,
            env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          });

          const session = {
            pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
            cwd: data.cwd || '', name: data.name || tmuxTarget,
            createdAt: Date.now(), tmuxTarget, isTmuxView: true,
            backend: 'claude', buffer: '',
          };
          activeSessions.set(id, session);
          attachedSessions.add(id);

          setupSessionPty(session, id, tmuxPty, { cleanupOnExit: false });

          ws.send(JSON.stringify({ type: 'created', sessionId: id, name: session.name, cwd: session.cwd, isTmuxView: true }));
          broadcastActiveSessions();
          break;
        }
      }
    });

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

module.exports = { registerWsHandler };
