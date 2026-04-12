const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const compression = require('compression');
const { MessageManager } = require('./src/message-manager');
const { ClaudeCodeAdapter } = require('./src/adapters/claude-code');
const { SyncStore } = require('./src/sync-store');
const {
  SESSIONS_DIR, isPidAlive, cwdToProjectDir, recoverCwdFromProjDir,
  getTmuxPaneMap, findTmuxTarget, isProcessClaude, isSubagentMessage,
  findSessionJsonlPath, parseSessionJsonl, extractSessionMeta, getSubagentMetas,
  SessionMessages,
} = require('./src/session-store');
const fileRoutes = require('./src/routes/files');
const { router: persistenceRouter, setup: setupPersistence } = require('./src/routes/persistence');

const PORT = process.env.PORT || 3456;
const CLAUDE_CMD_RAW = process.env.CLAUDE_CMD || 'claude';
// Resolve full paths at startup — node-pty's posix_spawnp may not find commands
// if Homebrew/nvm paths (/opt/homebrew/bin) aren't in Node's inherited PATH
function resolveCmd(name) {
  // Try 'which' first
  try {
    const r = execFileSync('/usr/bin/which', [name], { encoding: 'utf-8', timeout: 2000 }).trim();
    if (r && r.startsWith('/')) return r;
  } catch {}
  // Search common paths directly
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return name;
}
const DTACH_CMD = resolveCmd('dtach');
const NODE_CMD = process.execPath;
const ENV_CMD = resolveCmd('env');
const CLAUDE_CMD = CLAUDE_CMD_RAW.startsWith('/') ? CLAUDE_CMD_RAW : resolveCmd(CLAUDE_CMD_RAW);

// Parse available permission modes from claude --help (cached on startup)
let PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'];
try {
  const help = execFileSync(CLAUDE_CMD, ['--help'], { encoding: 'utf-8', timeout: 5000 });
  const match = help.match(/--permission-mode.*choices:\s*(.+)\)/);
  if (match) {
    PERMISSION_MODES = match[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) || PERMISSION_MODES;
  }
} catch {}
const HOST = process.env.HOST || '0.0.0.0';
const EDITOR_SCRIPT = path.join(__dirname, 'editor-helper.sh');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, maxAge: 0 }));
app.use(express.json({ limit: '50mb' }));

app.get('/xterm.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'));
});

// ── Active session tracking (dtach-backed for persistence across server restarts) ──
// dtach is a minimal PTY detach/attach tool — no rendering layer, no mouse interception.
// Claude processes get raw PTY I/O identical to a native terminal.
const activeSessions = new Map();
let sessionCounter = 0;
const SOCKETS_DIR = path.join(__dirname, 'data', 'sockets');
const META_DIR = path.join(__dirname, 'data', 'session-meta');
const BUFFERS_DIR = path.join(__dirname, 'data', 'session-buffers');
const PTY_WRAPPER = path.join(__dirname, 'data', 'bin', 'pty-wrapper.js');
const CHAT_WRAPPER = path.join(__dirname, 'data', 'bin', 'chat-wrapper.js');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// ── Cached webuiPids (PIDs managed by webui dtach sessions) ──
// Built from pty-wrapper metadata files (childPid), no pgrep/process-tree traversal needed.
const webuiPids = new Set();

function refreshWebuiPids() {
  webuiPids.clear();
  for (const [id, s] of activeSessions) {
    // Read childPid from pty-wrapper's metadata file
    try {
      const metaPath = path.join(BUFFERS_DIR, id + '.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.childPid) {
        webuiPids.add(meta.childPid);
        s._childPid = meta.childPid;
        // Also add direct children of childPid (claude forks from node-pty spawn)
        try {
          const ch = execFileSync('pgrep', ['-P', String(meta.childPid)], { encoding: 'utf-8', timeout: 2000 }).trim();
          for (const line of ch.split('\n')) { const p = parseInt(line.trim()); if (p) webuiPids.add(p); }
        } catch {}
      }
      if (meta.pid) { webuiPids.add(meta.pid); }
    } catch {}
  }
}

// ── Broadcast helper (avoids duplicating per-session WebSocket iteration) ──
const WS_OPEN = 1;
function broadcastToSession(session, id, msg) {
  const json = JSON.stringify(msg);
  for (const client of session.clients.keys()) {
    if (client.readyState === WS_OPEN) { try { client.send(json); } catch {} }
  }
}

// SyncStore imported from ./src/sync-store.js

// ── Effective-size computation (min cols/rows across clients + PTY resize + broadcast) ──
function resizeSessionToMin(session, sessionId) {
  if (!session.clients.size || !session.pty) return;
  let minCols = Infinity, minRows = Infinity;
  for (const sz of session.clients.values()) {
    if (sz.cols < minCols) minCols = sz.cols;
    if (sz.rows < minRows) minRows = sz.rows;
  }
  if (minCols < Infinity && minRows < Infinity) {
    try { session.pty.resize(minCols, minRows); } catch {}
    broadcastToSession(session, sessionId, { type: 'effective-size', sessionId, cols: minCols, rows: minRows });
  }
}

// ── PTY setup helper (onData + onExit wiring) ──
function setupSessionPty(session, id, ptyProcess, { cleanupOnExit = true } = {}) {
  session.pty = ptyProcess;

  if (session.mode === 'chat') {
    // Chat mode: parse JSON lines from PTY output, broadcast as structured messages
    let lineBuf = '';
    if (!session.subagentBuffers) session.subagentBuffers = new Map();
    if (!session.subagentEmittedUuids) session.subagentEmittedUuids = new Map(); // toolUseId → Set<uuid>
    if (!session.subagentWatchers) session.subagentWatchers = new Map(); // toolUseId → {watcher, offset}

    // Watch a subagent JSONL file for new messages (fills gap: text/thinking not in stream-json)
    const startSubagentWatcher = (toolUseId, agentId) => {
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
        // File doesn't exist yet, retry after delay
        const retry = setTimeout(() => { session.subagentWatchers.delete(toolUseId); startSubagentWatcher(toolUseId, agentId); }, 1000);
        session.subagentWatchers.set(toolUseId, { watcher: null, retry });
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
      const watcher = fs.watch(watchFile, () => readNewLines());
      session.subagentWatchers.set(toolUseId, { watcher });
    };

    const stopSubagentWatcher = (toolUseId) => {
      const entry = session.subagentWatchers.get(toolUseId);
      if (entry) {
        if (entry.watcher) entry.watcher.close();
        if (entry.retry) clearTimeout(entry.retry);
        session.subagentWatchers.delete(toolUseId);
      }
    };

    ptyProcess.onData((output) => {
      session.buffer = (session.buffer + output).slice(-500000);
      lineBuf += output;
      let nlIdx;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.substring(0, nlIdx).replace(/\r/g, '').trim();
        lineBuf = lineBuf.substring(nlIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);

          // Track subagent lifecycle: start/stop JSONL watchers
          if (msg.type === 'system' && msg.subtype === 'task_started' && msg.task_type === 'local_agent' && msg.task_id && msg.tool_use_id) {
            startSubagentWatcher(msg.tool_use_id, msg.task_id);
          }
          if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.tool_use_id) {
            stopSubagentWatcher(msg.tool_use_id);
          }

          if (msg.parent_tool_use_id || msg.isSidechain) {
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
          if (session._normalizer) session._normalizer.processLive(msg);
        } catch {
          // Non-JSON line (e.g. dtach noise) — send as raw output
          broadcastToSession(session, id, { type: 'output', sessionId: id, data: line + '\n' });
        }
      }
    });
  } else {
    // Terminal mode: raw PTY output
    ptyProcess.onData((output) => {
      session.buffer = (session.buffer + output).slice(-50000);
      broadcastToSession(session, id, { type: 'output', sessionId: id, data: output });
    });
  }

  ptyProcess.onExit(() => {
    // Clean up subagent file watchers and normalizers
    if (session.subagentWatchers) {
      for (const [, entry] of session.subagentWatchers) {
        if (entry.watcher) entry.watcher.close();
        if (entry.retry) clearTimeout(entry.retry);
      }
      session.subagentWatchers.clear();
    }
    if (session._subNormalizers) { session._subNormalizers.clear(); }
    if (session._normalizer) { session._normalizer.listeners.length = 0; }
    if (cleanupOnExit) {
      if (session.socketPath && fs.existsSync(session.socketPath)) { session.pty = null; return; }
      broadcastToSession(session, id, { type: 'exited', sessionId: id });
      activeSessions.delete(id);
      if (session.sockName) deleteSessionMeta(session.sockName);
      broadcastActiveSessions();
    } else {
      broadcastToSession(session, id, { type: 'exited', sessionId: id });
      activeSessions.delete(id);
      broadcastActiveSessions();
    }
  });
}

// Read/write session metadata
function readSessionMeta(sockName) {
  try { return JSON.parse(fs.readFileSync(path.join(META_DIR, sockName + '.json'), 'utf-8')); } catch { return {}; }
}
function writeSessionMeta(sockName, meta) {
  ensureDir(META_DIR);
  fs.writeFileSync(path.join(META_DIR, sockName + '.json'), JSON.stringify(meta));
}
function deleteSessionMeta(sockName) {
  try { fs.unlinkSync(path.join(META_DIR, sockName + '.json')); } catch {}
}

// Attach a PTY to an existing dtach socket for I/O
function attachToDtach(id, socketPath, session) {
  const attachPty = pty.spawn(DTACH_CMD, ['-a', socketPath, '-E', '-r', 'winch'], {
    name: 'xterm-256color', cols: 120, rows: 30,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  setupSessionPty(session, id, attachPty);
}

// On startup, reconnect to existing dtach sockets
function restoreSessions() {
  ensureDir(SOCKETS_DIR);
  ensureDir(BUFFERS_DIR);
  const sockets = fs.readdirSync(SOCKETS_DIR).filter(f => f.startsWith('cw-'));
  if (!sockets.length) return;

  console.log(`  Found ${sockets.length} existing session(s), reconnecting...`);
  for (const sockFile of sockets) {
    const socketPath = path.join(SOCKETS_DIR, sockFile);
    try { fs.statSync(socketPath); } catch { continue; }

    // Verify socket is live — check if any process owns it
    let socketAlive = false;
    try {
      const out = execFileSync('fuser', [socketPath], { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
      socketAlive = out.trim().length > 0;
    } catch {
      // fuser returns non-zero if no process found, also try pgrep
      try {
        execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf-8', timeout: 2000 });
        socketAlive = true;
      } catch { socketAlive = false; }
    }

    if (!socketAlive) {
      console.log(`  ✗ Dead socket: ${sockFile} — cleaning up`);
      try { fs.unlinkSync(socketPath); } catch {}
      deleteSessionMeta(sockFile);
      continue;
    }

    const meta = readSessionMeta(sockFile);
    const id = meta.webuiSessionId || ('sess-' + (++sessionCounter) + '-' + Date.now());

    // Detect mode from wrapper metadata (chat-wrapper writes mode: 'chat')
    let sessionMode = meta.mode || 'terminal';
    if (sessionMode === 'terminal') {
      // Also check wrapper metadata for mode
      try {
        const wrapperMeta = JSON.parse(fs.readFileSync(path.join(BUFFERS_DIR, id + '.json'), 'utf-8'));
        if (wrapperMeta.mode === 'chat') sessionMode = 'chat';
      } catch {}
    }

    let savedBuffer = '';
    if (id) {
      try { savedBuffer = fs.readFileSync(path.join(BUFFERS_DIR, id + '.buf'), 'utf-8'); } catch {}
    }

    const session = {
      mode: sessionMode,
      pty: null, clients: new Map(),
      cwd: meta.cwd || os.homedir(),
      name: meta.name || sockFile,
      createdAt: meta.createdAt || Date.now(),
      claudeSessionId: meta.claudeSessionId || null,
      sockName: sockFile,
      socketPath,
      buffer: savedBuffer,
    };
    // Create normalizer for chat sessions (populated on first attach from JSONL + buffer)
    if (sessionMode === 'chat') {
      session._normalizer = new MessageManager(id);
      session._normalizer.onOp((op) => {
        broadcastToSession(session, id, { type: 'msg', sessionId: id, ...op });
      });
    }
    activeSessions.set(id, session);
    attachToDtach(id, socketPath, session);

    console.log(`  ✓ Reconnected: ${session.name} (${session.cwd})`);
  }

  // Populate webuiPids cache after all sessions are restored
  refreshWebuiPids();
}

// ── Create editor helper script ──
// Communicates via HTTP (not terminal output) so Claude Code treats it as a GUI editor
// and does NOT clear the screen. The server broadcasts via WebSocket to the client.
// Claude Code checks if EDITOR is in a hardcoded set of GUI editor names:
// ["code","cursor","windsurf","codium"] — if it is, it does NOT clear the screen.
// So we create a fake "code" wrapper script and set EDITOR to its path.
// This tricks Claude Code into treating our editor as a GUI editor.
const EDITOR_DIR = path.join(__dirname, 'data', 'bin');
const EDITOR_CMD = path.join(EDITOR_DIR, 'code'); // named "code" to match GUI editor check

function createEditorHelper() {
  ensureDir(EDITOR_DIR);
  // The script: "code -w <file>" is how Claude Code invokes it.
  // -w (--wait) flag is passed by Claude Code for known GUI editors.
  // We accept all flags, extract the filename, notify server via HTTP, and wait.
  const script = `#!/bin/bash
# WebUI editor disguised as "code" so Claude Code treats it as GUI (no screen clear).
# Parse args: skip flags, last arg is the file
FILE="\${@: -1}"
SIGNAL="/tmp/claude-webui-edit-signal-\$\$"
PORT="\${CLAUDE_WEBUI_PORT:-${PORT}}"
SESS="\${CLAUDE_WEBUI_SESSION_ID}"
curl -sf -X POST "http://localhost:\${PORT}/api/editor/open" \\
  -H "Content-Type: application/json" \\
  -d "{\\"file\\":\\"\$FILE\\",\\"signal\\":\\"\$SIGNAL\\",\\"sessionId\\":\\"\$SESS\\"}" >/dev/null 2>&1 &
while [ ! -f "\$SIGNAL" ]; do sleep 0.2; done
rm -f "\$SIGNAL"
`;
  fs.writeFileSync(EDITOR_CMD, script, { mode: 0o755 });
}
createEditorHelper();

// ── File System API (extracted to src/routes/files.js) ──
app.use(fileRoutes);

// Browser proxy — full-rewriting web proxy via node-unblocker
// Rewrites all URLs in HTML/CSS, injects JS to rewrite XHR/WebSocket, strips security headers
const Unblocker = require('unblocker');
const unblocker = new Unblocker({
  prefix: '/proxy/',
  responseMiddleware: [
    function stripFrameHeaders(data) {
      delete data.headers['x-frame-options'];
    }
  ],
});
app.use(unblocker);

// Editor: open request from editor-helper.sh (via HTTP, not terminal output)
app.post('/api/editor/open', (req, res) => {
  const { file, signal, sessionId } = req.body;
  // Broadcast to all WebSocket clients — include sessionId so each client opens editor on the right window
  const msg = JSON.stringify({ type: 'editor-open', filePath: file, signalPath: signal, sessionId: sessionId || null });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) {
      try { client.send(msg); } catch {}
    }
  });
  res.json({ success: true });
});

// Editor: signal completion (called by client when user saves/closes editor)
app.post('/api/editor/signal', (req, res) => {
  const { signalPath, filePath, content } = req.body;
  try {
    if (content !== undefined) fs.writeFileSync(filePath, content);
    fs.writeFileSync(signalPath, 'done');
    // Broadcast editor-close to all clients so they remove the split pane
    const msg = JSON.stringify({ type: 'editor-close', filePath, signalPath });
    wss.clients.forEach(client => {
      if (client.readyState === WS_OPEN) { try { client.send(msg); } catch {} }
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Persistence API (extracted to src/routes/persistence.js) ──
const syncStores = {};
function getSyncStore(name) { return syncStores[name]; }

syncStores.drafts = new SyncStore('drafts', path.join(__dirname, 'data', 'drafts.json'), wss);
syncStores.settings = new SyncStore('settings', path.join(__dirname, 'data', 'settings-sync.json'), wss);

setupPersistence({ dataDir: path.join(__dirname, 'data'), wss, WS_OPEN, getSyncStore });
app.use(persistenceRouter);
const { readLayouts, writeLayouts } = persistenceRouter;

// Session discovery functions imported from ./src/session-store.js
// Helper to create SessionMessages with correct context
function createSessionMessages(session, sessionId) {
  return new SessionMessages(session, sessionId, { buffersDir: BUFFERS_DIR, permissionModes: PERMISSION_MODES });
}

// Get chat message history for a Claude session (JSONL + optional buffer)
app.get('/api/session-messages', (req, res) => {
  const { claudeSessionId, cwd, offset, limit, search } = req.query;
  if (!claudeSessionId) return res.status(400).json({ error: 'claudeSessionId required' });

  // Use session's existing normalizer if available (cached); else build on-demand
  let session = null;
  for (const [, s] of activeSessions) {
    if (s.claudeSessionId === claudeSessionId) { session = s; break; }
  }
  let mm;
  if (session?._normalizer && session._normalizer.total > 0) {
    mm = session._normalizer;
  } else {
    const sm = createSessionMessages(session || { claudeSessionId, cwd: cwd || '', buffer: '' });
    mm = new MessageManager('api');
    mm.convertHistory(sm.raw());
  }

  if (req.query.turnmap) {
    res.json({ turns: mm.turnMap(), total: mm.total });
  } else if (search) {
    res.json({ matches: mm.search(search), total: mm.total });
  } else if (offset !== undefined || limit !== undefined) {
    const o = parseInt(offset) || 0;
    const l = parseInt(limit) || 50;
    res.json({ messages: mm.slice(o, l), total: mm.total });
  } else {
    res.json({ messages: mm.tail(50), total: mm.total });
  }
});

// V2: Normalized messages (tool calls merged, IDs assigned)
app.get('/api/session-messages-v2', (req, res) => {
  const { claudeSessionId, cwd, offset, limit, search } = req.query;
  if (!claudeSessionId) return res.status(400).json({ error: 'claudeSessionId required' });

  // Find or create normalizer
  let session = null;
  for (const [, s] of activeSessions) {
    if (s.claudeSessionId === claudeSessionId) { session = s; break; }
  }

  // Build normalizer from SessionMessages (includes buffer)
  const sm = new SessionMessages(session || { claudeSessionId, cwd: cwd || '', buffer: '' });
  const normalizer = new MessageManager('api');
  normalizer.convertHistory(sm.raw());

  if (search) {
    res.json({ matches: normalizer.search(search), total: normalizer.total });
  } else if (offset !== undefined || limit !== undefined) {
    const o = parseInt(offset) || 0;
    const l = parseInt(limit) || 50;
    res.json({ messages: normalizer.slice(o, l), total: normalizer.total });
  } else {
    res.json({ messages: normalizer.tail(50), total: normalizer.total });
  }
});

// Subagent messages for a given session + agentId
app.get('/api/subagent-messages', (req, res) => {
  const { claudeSessionId, cwd, agentId } = req.query;
  if (!claudeSessionId || !agentId) return res.status(400).json({ error: 'claudeSessionId and agentId required' });
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const projDir = cwdToProjectDir(cwd || '');
  // Try exact project dir, then scan all
  const candidates = [];
  if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId, 'subagents', `agent-${agentId}.jsonl`));
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, claudeSessionId, 'subagents', `agent-${agentId}.jsonl`);
      if (!candidates.includes(fp)) candidates.push(fp);
    }
  } catch {}
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      const rawMsgs = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { const msg = JSON.parse(trimmed); rawMsgs.push(msg); } catch {}
      }
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(filePath.replace('.jsonl', '.meta.json'), 'utf-8')); } catch {}
      const mm = new MessageManager(`sub-agent-${agentId}`);
      mm.convertHistory(rawMsgs);
      return res.json({ messages: mm.messages, total: mm.total, meta });
    } catch {}
  }
  res.json({ messages: [], total: 0, meta: {} });
});

app.post('/api/kill-pid', (req, res) => {
  const { pid } = req.body;
  if (!pid || typeof pid !== 'number') return res.status(400).json({ error: 'pid required' });
  try {
    if (!isProcessClaude(pid)) return res.status(400).json({ error: 'PID is not a claude process' });
    process.kill(pid, 'SIGTERM');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sessions', (req, res) => {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    // Step 0: Use cached webuiPids (updated on session create/kill/restore)

    // Step 1: Scan lock files + tmux panes → build map of RUNNING sessions
    // Build webuiPid → claudeSessionId map for precise JSONL matching
    const webuiPidToSessionId = new Map();
    for (const [id, s] of activeSessions) {
      if (s.claudeSessionId) {
        // Map childPid + its direct children (claude forks from node-pty spawn)
        if (s._childPid) {
          webuiPidToSessionId.set(s._childPid, s.claudeSessionId);
          try {
            const ch = execFileSync('pgrep', ['-P', String(s._childPid)], { encoding: 'utf-8', timeout: 2000 }).trim();
            for (const line of ch.split('\n')) { const p = parseInt(line.trim()); if (p) webuiPidToSessionId.set(p, s.claudeSessionId); }
          } catch {}
        }
      }
    }

    const paneMap = getTmuxPaneMap();
    const runningByProjDir = new Map(); // projDirName → [{lock, tmuxTarget, assigned, claudeSessionId}]
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
          if (!isPidAlive(data.pid)) continue;
          if (!isProcessClaude(data.pid)) continue;
          const projDirName = cwdToProjectDir(data.cwd);
          const tmuxTarget = findTmuxTarget(data.pid, paneMap);
          const claudeSessionId = webuiPidToSessionId.get(data.pid) || null;
          if (!runningByProjDir.has(projDirName)) runningByProjDir.set(projDirName, []);
          runningByProjDir.get(projDirName).push({ lock: data, tmuxTarget, assigned: false, claudeSessionId });
        } catch {}
      }
    }

    // Step 2: Scan JSONL files, match with running locks
    const sessions = [];
    if (fs.existsSync(projectsDir)) {
      for (const projDir of fs.readdirSync(projectsDir)) {
        const projPath = path.join(projectsDir, projDir);
        try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }

        // Pre-fetch stats for sorting + mtime lookup
        const jsonls = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        const statMap = new Map();
        for (const f of jsonls) {
          try { statMap.set(f, fs.statSync(path.join(projPath, f)).mtimeMs); } catch { statMap.set(f, 0); }
        }
        // Sort by mtime desc so most recent JSONL gets the running lock
        jsonls.sort((a, b) => (statMap.get(b) || 0) - (statMap.get(a) || 0));

        // Check if there are running locks for this project dir
        const runningEntries = runningByProjDir.get(projDir) || [];

        for (const f of jsonls) {
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(projPath, f);
          const mtime = statMap.get(f) || 0;

          const meta = extractSessionMeta(filePath);
          const firstRunning = runningEntries.find(e => !e.assigned);
          const cwd = (firstRunning?.lock.cwd) || meta.cwd || recoverCwdFromProjDir(projDir);

          // Match running lock to JSONL:
          // 1. If a lock has claudeSessionId (WebUI), only match to that exact JSONL
          // 2. Otherwise (tmux/external), match to most recent unassigned JSONL (sorted by mtime desc)
          let status = 'stopped', pid = null, tmuxTarget = null;
          const exactMatch = runningEntries.find(e => !e.assigned && e.claudeSessionId === sessionId);
          const fallbackMatch = runningEntries.find(e => !e.assigned && !e.claudeSessionId);
          const match = exactMatch || fallbackMatch;
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

          sessions.push({ sessionId, cwd, pid, startedAt: mtime, status, name: meta.name || '', tmuxTarget });
        }
      }
    }

    // Step 3: Running locks that didn't match any project dir (brand new, no JSONL yet)
    for (const [, entries] of runningByProjDir) {
      for (const entry of entries) {
        if (!entry.assigned) {
          sessions.push({
            sessionId: entry.lock.sessionId, cwd: entry.lock.cwd, pid: entry.lock.pid,
            startedAt: entry.lock.startedAt || Date.now(),
            status: (webuiPids.has(entry.lock.pid) || [...activeSessions.values()].some(s => s.claudeSessionId === entry.lock.sessionId)) ? 'live'
              : entry.tmuxTarget ? 'tmux' : 'external', name: '',
            tmuxTarget: entry.tmuxTarget || null,
          });
        }
      }
    }

    sessions.sort((a, b) => b.startedAt - a.startedAt);
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/active', (req, res) => {
  const sessions = [];
  for (const [id, s] of activeSessions) {
    sessions.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null, mode: s.mode || 'terminal' });
  }
  res.json({ sessions });
});

// ── Usage / Rate Limit ──
// Minimal haiku API call to read rate limit headers. Cached, refreshed every 5 min.
// Uses OAuth token from ~/.claude/.credentials.json (x-api-key header).
const https = require('https');
let _rateLimitCache = null;

let _oauthToken = null, _oauthMtime = 0;
function getOAuthToken() {
  try {
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const stat = fs.statSync(credsPath);
    if (_oauthToken && stat.mtimeMs === _oauthMtime) return _oauthToken;
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    _oauthToken = creds?.claudeAiOauth?.accessToken || null;
    _oauthMtime = stat.mtimeMs;
    return _oauthToken;
  } catch { return null; }
}

function refreshRateLimit() {
  const token = getOAuthToken();
  if (!token) return;
  const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: '.' }] });
  const req = https.request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, (res) => {
    const h = res.headers;
    if (res.statusCode === 200) {
      _rateLimitCache = {
        fiveHour: { utilization: parseFloat(h['anthropic-ratelimit-unified-5h-utilization'] || '0'), status: h['anthropic-ratelimit-unified-5h-status'] || 'unknown', resetsAt: parseInt(h['anthropic-ratelimit-unified-5h-reset'] || '0') },
        sevenDay: { utilization: parseFloat(h['anthropic-ratelimit-unified-7d-utilization'] || '0'), status: h['anthropic-ratelimit-unified-7d-status'] || 'unknown', resetsAt: parseInt(h['anthropic-ratelimit-unified-7d-reset'] || '0') },
        overallStatus: h['anthropic-ratelimit-unified-status'] || 'unknown',
        fetchedAt: Date.now(),
      };
    }
    res.resume();
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}
setTimeout(refreshRateLimit, 5000); // delay startup to avoid hitting rate limits
setInterval(refreshRateLimit, 300000); // every 5 min

app.get('/api/usage', (req, res) => {
  res.json({ rateLimit: _rateLimitCache });
});

// ── WebSocket Terminal Handler ──
wss.on('connection', (ws) => {
  const attachedSessions = new Set();

  // Send current active sessions on connect
  const activeList = [];
  for (const [id, s] of activeSessions) {
    activeList.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null, mode: s.mode || 'terminal' });
  }
  ws.send(JSON.stringify({ type: 'active-sessions', sessions: activeList }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case 'create': {
        const id = 'sess-' + (++sessionCounter) + '-' + Date.now();
        const cwd = data.cwd || os.homedir();
        const sockName = 'cw-' + sessionCounter + '-' + Date.now();
        const socketPath = path.join(SOCKETS_DIR, sockName);
        const sessionMode = data.mode === 'chat' ? 'chat' : 'terminal';

        // Build claude command
        const claudeArgs = [];
        if (data.resume && data.resumeId) claudeArgs.push('--resume', data.resumeId);
        if (data.sessionName) claudeArgs.push('--name', data.sessionName);
        if (data.model) claudeArgs.push('--model', data.model);
        if (data.permissionMode) claudeArgs.push('--permission-mode', data.permissionMode);
        if (data.extraArgs) claudeArgs.push(...data.extraArgs.trim().split(/\s+/).filter(Boolean));

        ensureDir(SOCKETS_DIR);
        ensureDir(BUFFERS_DIR);

        const session = {
          mode: sessionMode,
          pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
          cwd, name: data.sessionName || `Session ${sessionCounter}`,
          createdAt: Date.now(), claudeSessionId: data.resumeId || null,
          sockName, socketPath, buffer: '',
        };
        // Create normalizer for chat sessions (converts raw Claude messages to normalized format)
        if (sessionMode === 'chat') {
          session._normalizer = new MessageManager(id);
          session._normalizer.onOp((op) => {
            broadcastToSession(session, id, { type: 'msg', sessionId: id, ...op });
          });
        }

        // Use appropriate wrapper inside dtach:
        // - Terminal: pty-wrapper.js (spawns claude with PTY for TUI mode)
        // - Chat: chat-wrapper.js (spawns claude with --output-format stream-json)
        const bufFile = path.join(BUFFERS_DIR, id + '.buf');
        const metaFileW = path.join(BUFFERS_DIR, id + '.json');
        const wrapper = sessionMode === 'chat' ? CHAT_WRAPPER : PTY_WRAPPER;
        let createPty;
        try {
          createPty = pty.spawn(DTACH_CMD, ['-c', socketPath, '-E', '-r', 'none',
            NODE_CMD, wrapper,
            bufFile, metaFileW,
            ENV_CMD, `EDITOR=${EDITOR_CMD}`, `CLAUDE_WEBUI_PORT=${PORT}`, `CLAUDE_WEBUI_SESSION_ID=${id}`, `DISPLAY=${process.env.DISPLAY || (process.platform === 'darwin' ? '' : ':99')}`,
            `TERM=xterm-256color`, `COLORTERM=truecolor`,
            CLAUDE_CMD, ...claudeArgs,
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

        writeSessionMeta(sockName, { name: session.name, cwd, claudeSessionId: session.claudeSessionId, createdAt: session.createdAt, webuiSessionId: id, mode: sessionMode });

        // Capture claudeSessionId from lock file for new (non-resume) sessions
        if (!session.claudeSessionId) {
          const tryCapture = (attempts) => {
            if (attempts <= 0 || !activeSessions.has(id)) return;
            try {
              const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
              for (const f of files) {
                const lockData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
                if (lockData.cwd === cwd && lockData.startedAt > session.createdAt - 5000) {
                  session.claudeSessionId = lockData.sessionId;
                  writeSessionMeta(sockName, { name: session.name, cwd, claudeSessionId: session.claudeSessionId, createdAt: session.createdAt, webuiSessionId: id, mode: sessionMode });
                  broadcastActiveSessions();
                  return;
                }
              }
            } catch {}
            setTimeout(() => tryCapture(attempts - 1), 1000);
          };
          setTimeout(() => tryCapture(15), 2000);
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
          session.pty.write(JSON.stringify(ClaudeCodeAdapter.buildSetPermissionMode(data.mode)) + '\n');
        }
        break;
      }

      case 'input': {
        const session = activeSessions.get(data.sessionId);
        if (session?.pty) session.pty.write(data.data);
        break;
      }

      case 'chat-input': {
        // Chat mode: send user message to stdin + broadcast to all clients
        const session = activeSessions.get(data.sessionId);
        if (session?.pty && session.mode === 'chat') {
          const msgId = data.msgId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
          let stdinPayload, userMsg;

          // Check if text is already a raw JSON message (e.g. image paste)
          let parsed = null;
          try { parsed = JSON.parse(data.text); if (!(parsed.type === 'user' && parsed.message)) parsed = null; } catch {}

          if (parsed) {
            stdinPayload = data.text;
            userMsg = { ...parsed, msgId, timestamp: new Date().toISOString() };
          } else {
            // Always send as JSON to avoid multi-line text being split by chat-wrapper
            stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: data.text }] } });
            userMsg = { type: 'user', message: { role: 'user', content: data.text }, msgId, timestamp: new Date().toISOString() };
          }

          session.pty.write(stdinPayload + '\n');
          // Write to buffer for display on refresh (before JSONL is written).
          // Mark with _fromWebui so dedup can remove it when JSONL version arrives.
          userMsg._fromWebui = true;
          session.buffer = (session.buffer + JSON.stringify(userMsg) + '\n').slice(-500000);
          // Normalize and broadcast to other clients (sender already shows local preview)
          if (session._normalizer) session._normalizer.processLive(userMsg);
        }
        break;
      }

      case 'interrupt': {
        // Dual interrupt: control_request protocol + SIGINT fallback
        // control_request alone is unreliable during active tool execution
        // (known issue: anthropics/claude-code#17466, #3455)
        const session = activeSessions.get(data.sessionId);
        if (session?.pty && session.mode === 'chat') {
          // 1. Protocol: send control_request interrupt to stdin
          session.pty.write(JSON.stringify(ClaudeCodeAdapter.buildInterruptRequest()) + '\n');
          // 2. Fallback: SIGINT to claude child process (bypasses PTY/dtach chain)
          if (session._childPid) {
            try { process.kill(session._childPid, 'SIGINT'); } catch {}
          }
        }
        break;
      }

      case 'permission-response': {
        const session = activeSessions.get(data.sessionId);
        if (session?.pty && session.mode === 'chat') {
          const response = ClaudeCodeAdapter.buildPermissionResponse(data.requestId, data.approved, data.toolInput, data.permissionUpdates);
          session.pty.write(JSON.stringify(response) + '\n');
        }
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
            const claudeId = parentSession?.claudeSessionId || data.claudeSessionId || '';
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
            ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, mode: 'chat',
              messages, totalCount, chatStatus: sm.chatStatus(), isStreaming: sm.isStreaming, taskState: sm.taskState(), turnMap }));
          } else {
            ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, buffer: session.buffer || '' }));
          }
        } else if (data.viewOnly && data.claudeSessionId) {
          // View-only: load JSONL history without an active session
          const sm = createSessionMessages({ claudeSessionId: data.claudeSessionId, cwd: data.cwd || '', buffer: '' });
          const mm = new MessageManager(data.sessionId || 'view');
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
        layoutData.autoSave = { ...data.state, updatedAt: Date.now() };
        writeLayouts(layoutData);
        // Broadcast to other clients (sender excluded)
        const syncMsg = JSON.stringify({ type: 'layout-sync', ...data });
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WS_OPEN) { try { client.send(syncMsg); } catch {} }
        });
        break;
      }

      case 'tmux-attach': {
        // Attach to a running tmux pane (read-only view of external session)
        const tmuxTarget = data.tmuxTarget;
        if (!tmuxTarget) { ws.send(JSON.stringify({ type: 'error', message: 'No tmux target' })); break; }

        const id = 'tmux-' + (++sessionCounter) + '-' + Date.now();
        const tmuxPty = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
          name: 'xterm-256color', cols: data.cols || 120, rows: data.rows || 30,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });

        const session = {
          pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
          cwd: data.cwd || '', name: data.name || tmuxTarget,
          createdAt: Date.now(), tmuxTarget, isTmuxView: true,
          buffer: '',
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

function broadcastActiveSessions() {
  const activeList = [];
  for (const [id, s] of activeSessions) {
    // Exclude tmux view sessions — they shouldn't appear as separate "live" entries
    if (s.isTmuxView) continue;
    activeList.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null, mode: s.mode || 'terminal' });
  }
  const msg = JSON.stringify({ type: 'active-sessions', sessions: activeList });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) {
      try { client.send(msg); } catch {}
    }
  });
}

// ── Start Server ──
// Unblocker WebSocket proxy (for proxied sites' WebSockets, not our /ws)
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/proxy/')) unblocker.onUpgrade(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Claude Code WebUI v2.0 running at http://localhost:${PORT}`);
  console.log(`  dtach: ${DTACH_CMD}, node: ${NODE_CMD}, env: ${ENV_CMD}, claude: ${CLAUDE_CMD}`);

  // Restore existing dtach sessions from before restart
  restoreSessions();

  console.log(`  Ready.\n`);
});

// On server shutdown: only kill the attach PTYs, NOT the dtach sessions
// Claude processes in dtach survive the server restart
process.on('SIGINT', () => {
  console.log('\n  Shutting down (dtach sessions will keep running)...');
  for (const [, s] of activeSessions) { try { if (s.pty) s.pty.kill(); } catch {} }
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const [, s] of activeSessions) { try { if (s.pty) s.pty.kill(); } catch {} }
  process.exit(0);
});
