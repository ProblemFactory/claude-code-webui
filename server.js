const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const { execFileSync, spawn } = require('child_process');

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
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

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
              broadcastToSession(session, id, { type: 'chat-message', sessionId: `sub-${toolUseId}`, message: msg });
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
            // Broadcast to parent (for tool card status) + virtual session (for subagent viewer)
            broadcastToSession(session, id, { type: 'subagent-message', sessionId: id, parentToolUseId: ptuid, message: msg });
            if (ptuid) broadcastToSession(session, id, { type: 'chat-message', sessionId: `sub-${ptuid}`, message: msg });
            continue;
          }
          if (msg.type === 'assistant' || msg.type === 'result') session._waitingForResponse = false;
          broadcastToSession(session, id, { type: 'chat-message', sessionId: id, message: msg });
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
    // Clean up subagent file watchers
    if (session.subagentWatchers) {
      for (const [, entry] of session.subagentWatchers) {
        if (entry.watcher) entry.watcher.close();
        if (entry.retry) clearTimeout(entry.retry);
      }
      session.subagentWatchers.clear();
    }
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

// ── File System API ──
function expandTilde(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.substring(1));
  return p;
}
function safePath(p) { return path.resolve(expandTilde(p)); }

app.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

// System monospace fonts via fc-list (cached)
let _cachedMonoFonts = null;
app.get('/api/fonts', (req, res) => {
  if (_cachedMonoFonts) return res.json({ fonts: _cachedMonoFonts });
  try {
    const out = execFileSync('fc-list', [':spacing=mono', 'family'], { encoding: 'utf-8', timeout: 3000 });
    const fonts = [...new Set(
      out.trim().split('\n')
        .map(line => line.split(',')[0].trim())
        .filter(f => f && !/emoji|sign/i.test(f))
    )].sort((a, b) => a.localeCompare(b));
    _cachedMonoFonts = fonts;
    res.json({ fonts });
  } catch {
    res.json({ fonts: [] });
  }
});

// Directory autocomplete — returns dirs matching partial path, with 500ms timeout
app.get('/api/dir-complete', (req, res) => {
  const input = req.query.path || '';
  const timeout = setTimeout(() => { if (!res.headersSent) res.json({ suggestions: [] }); }, 500);

  try {
    const expanded = expandTilde(input);
    const lastSlash = expanded.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? expanded.substring(0, lastSlash) || '/' : '.';
    const prefix = lastSlash >= 0 ? expanded.substring(lastSlash + 1).toLowerCase() : expanded.toLowerCase();
    const resolved = path.resolve(parentDir);

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() && !(e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(resolved, e.name)).isDirectory(); } catch { return false; } })())) continue;
      if (e.name.startsWith('.') && !prefix.startsWith('.')) continue;
      if (prefix && !e.name.toLowerCase().startsWith(prefix)) continue;
      dirs.push(path.join(resolved, e.name));
      if (dirs.length >= 20) break;
    }
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ suggestions: dirs });
  } catch {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ suggestions: [] });
  }
});

app.get('/api/files', (req, res) => {
  const dirPath = safePath(req.query.path || os.homedir());
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(e => {
      let stat = null;
      try { stat = fs.statSync(path.join(dirPath, e.name)); } catch {}
      return {
        name: e.name,
        isDirectory: e.isDirectory() || (e.isSymbolicLink() && stat?.isDirectory()),
        size: stat?.size || 0,
        modified: stat?.mtimeMs || 0,
        created: stat?.birthtimeMs || 0,
      };
    });
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dirPath, items });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// File info (size + binary detection) without reading full content
app.get('/api/file/info', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const stat = fs.statSync(filePath);
    let isBinary = false;
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      for (let i = 0; i < bytesRead; i++) { if (buf[i] === 0) { isBinary = true; break; } }
    } catch {}
    res.json({ path: filePath, size: stat.size, modified: stat.mtimeMs, isBinary, isDirectory: stat.isDirectory() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Read text file content (limit raised to 10MB)
app.get('/api/file/content', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (>10MB). Use hex viewer.', size: stat.size });
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ path: filePath, content, size: stat.size });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Read binary file chunk as raw bytes
app.get('/api/file/binary', (req, res) => {
  const filePath = safePath(req.query.path);
  const offset = parseInt(req.query.offset) || 0;
  const length = Math.min(parseInt(req.query.length) || 65536, 1048576); // max 1MB per chunk
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    const stat = fs.statSync(filePath);
    res.set({ 'Content-Type': 'application/octet-stream', 'X-File-Size': stat.size, 'X-Offset': offset, 'X-Bytes-Read': bytesRead });
    res.send(buf.slice(0, bytesRead));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Serve raw files (PDF, images, etc.)
app.get('/api/file/raw', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    res.sendFile(filePath);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Download file
app.get('/api/download', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    res.download(filePath);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Preview Excel files
app.get('/api/file/excel', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    const sheets = workbook.SheetNames.map(name => ({
      name,
      data: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }),
    }));
    res.json({ sheets });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Preview Word files
app.get('/api/file/docx', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const mammoth = require('mammoth');
    mammoth.convertToHtml({ path: filePath }).then(result => {
      res.json({ html: result.value });
    }).catch(err => res.status(400).json({ error: err.message }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/mkdir', (req, res) => {
  try { fs.mkdirSync(safePath(req.body.path), { recursive: true }); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/file/write', (req, res) => {
  try { fs.writeFileSync(safePath(req.body.path), req.body.content || ''); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/rename', (req, res) => {
  try { fs.renameSync(safePath(req.body.oldPath), safePath(req.body.newPath)); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/file', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true });
    else fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// File upload
const upload = multer({ dest: '/tmp/claude-webui-uploads/' });
app.post('/api/upload', upload.array('files'), (req, res) => {
  const destDir = req.body.destDir || os.homedir();
  try {
    const results = [];
    for (const file of req.files) {
      const dest = path.join(destDir, file.originalname);
      fs.copyFileSync(file.path, dest);
      fs.unlinkSync(file.path);
      results.push({ name: file.originalname, path: dest, size: file.size });
    }
    res.json({ success: true, files: results });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Paste image from clipboard → save to temp file + set X clipboard via xclip
app.post('/api/paste-image', (req, res) => {
  try {
    const { dataUrl } = req.body; // "data:image/png;base64,..."
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Not an image' });
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid data URL' });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const mimeType = `image/${match[1]}`;
    const buf = Buffer.from(match[2], 'base64');
    const tmpPath = path.join(os.tmpdir(), `claude-paste-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buf);
    // Set system clipboard with image — macOS uses osascript, Linux uses xclip
    const isMac = process.platform === 'darwin';
    try {
      if (isMac) {
        // macOS: set clipboard via osascript (synchronous, no polling needed)
        execFileSync('osascript', ['-e', `set the clipboard to (read POSIX file "${tmpPath}" as «class PNGf»)`], { timeout: 5000 });
        res.json({ path: tmpPath, ready: true });
      } else {
        // Linux: xclip piped from stdin, stays alive as clipboard owner
        const clipEnv = { ...process.env, DISPLAY: process.env.DISPLAY || ':99' };
        const cp = spawn('bash', ['-c', `cat "${tmpPath}" | xclip -selection clipboard -t ${mimeType}`], {
          env: clipEnv, detached: true, stdio: 'ignore',
        });
        cp.unref();
        const pollStart = Date.now();
        const poll = () => {
          try {
            const out = execFileSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
              env: clipEnv, encoding: 'utf-8', timeout: 1000,
            });
            if (out.includes('image/')) return res.json({ path: tmpPath, ready: true });
          } catch {}
          if (Date.now() - pollStart < 5000) setTimeout(poll, 200);
          else res.json({ path: tmpPath, ready: false });
        };
        setTimeout(poll, 300);
      }
    } catch {
      res.json({ path: tmpPath, ready: false });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

// ── Layout/Preset Persistence (cached in memory) ──
const LAYOUTS_FILE = path.join(__dirname, 'data', 'layouts.json');
let _layoutsCache = null;
function readLayouts() {
  if (_layoutsCache) return _layoutsCache;
  ensureDir(path.join(__dirname, 'data'));
  try { _layoutsCache = JSON.parse(fs.readFileSync(LAYOUTS_FILE, 'utf-8')); }
  catch { _layoutsCache = { current: null, autoSave: null, saved: {}, customGrids: [] }; }
  return _layoutsCache;
}
function writeLayouts(data) {
  ensureDir(path.join(__dirname, 'data'));
  _layoutsCache = data;
  fs.writeFileSync(LAYOUTS_FILE, JSON.stringify(data, null, 2));
}

// Get all layouts
app.get('/api/layouts', (req, res) => {
  res.json(readLayouts());
});

// Save/update a named layout
app.post('/api/layouts/:name', (req, res) => {
  const data = readLayouts();
  data.saved[req.params.name] = { ...req.body, updatedAt: Date.now() };
  writeLayouts(data);
  res.json({ success: true });
});

// Delete a named layout
app.delete('/api/layouts/:name', (req, res) => {
  const data = readLayouts();
  delete data.saved[req.params.name];
  if (data.current === req.params.name) data.current = null;
  writeLayouts(data);
  res.json({ success: true });
});

// Set which layout is active
app.post('/api/layouts-active', (req, res) => {
  const data = readLayouts();
  data.current = req.body.name || null;
  writeLayouts(data);
  res.json({ success: true });
});

// Custom grid presets
app.post('/api/custom-grids', (req, res) => {
  const { rows, cols } = req.body;
  if (!rows || !cols) return res.status(400).json({ error: 'rows and cols required' });
  const data = readLayouts();
  if (!data.customGrids) data.customGrids = [];
  // Avoid duplicates
  if (!data.customGrids.some(g => g.rows === rows && g.cols === cols)) {
    data.customGrids.push({ rows, cols });
    writeLayouts(data);
  }
  res.json({ success: true, customGrids: data.customGrids });
});

app.delete('/api/custom-grids', (req, res) => {
  const { rows, cols } = req.body;
  const data = readLayouts();
  if (!data.customGrids) data.customGrids = [];
  data.customGrids = data.customGrids.filter(g => !(g.rows === rows && g.cols === cols));
  writeLayouts(data);
  res.json({ success: true, customGrids: data.customGrids });
});

// ── Bookmarks API ──
const BOOKMARKS_FILE = path.join(__dirname, 'data', 'bookmarks.json');
function readBookmarks() {
  ensureDir(path.join(__dirname, 'data'));
  try { return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8')); }
  catch {
    const home = os.homedir();
    return [
      { label: 'Home', path: home },
      { label: 'Desktop', path: path.join(home, 'Desktop') },
      { label: 'Downloads', path: path.join(home, 'Downloads') },
      { label: 'Documents', path: path.join(home, 'Documents') },
    ];
  }
}
function writeBookmarks(data) {
  ensureDir(path.join(__dirname, 'data'));
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/bookmarks', (req, res) => {
  res.json(readBookmarks());
});

app.post('/api/bookmarks', (req, res) => {
  const bookmarks = req.body;
  if (!Array.isArray(bookmarks)) return res.status(400).json({ error: 'Expected array' });
  writeBookmarks(bookmarks);
  // Broadcast to all WebSocket clients so multi-device stays in sync
  const msg = JSON.stringify({ type: 'bookmarks-updated', bookmarks });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) { try { client.send(msg); } catch {} }
  });
  res.json({ success: true });
});

// ── Custom Themes ──
const CUSTOM_THEMES_FILE = path.join(__dirname, 'data', 'custom-themes.json');
let _customThemesCache = null;

function readCustomThemes() {
  if (_customThemesCache) return _customThemesCache;
  try { _customThemesCache = JSON.parse(fs.readFileSync(CUSTOM_THEMES_FILE, 'utf-8')); }
  catch { _customThemesCache = {}; }
  return _customThemesCache;
}

function writeCustomThemes(data) {
  _customThemesCache = data;
  fs.writeFileSync(CUSTOM_THEMES_FILE, JSON.stringify(data, null, 2));
  const msg = JSON.stringify({ type: 'custom-themes-updated', themes: data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { try { client.send(msg); } catch {} }
  });
}

app.get('/api/custom-themes', (req, res) => res.json(readCustomThemes()));

app.post('/api/custom-themes', (req, res) => {
  const { name, css, terminal } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  if (!css || typeof css !== 'object') return res.status(400).json({ error: 'css object required' });
  if (name.length > 50) return res.status(400).json({ error: 'Name too long (max 50)' });
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Name must be alphanumeric' });
  const builtIn = ['dark', 'light', 'dracula', 'nord', 'solarized', 'monokai'];
  if (builtIn.includes(name.toLowerCase())) return res.status(400).json({ error: 'Cannot overwrite built-in theme' });
  if (JSON.stringify(req.body).length > 100000) return res.status(413).json({ error: 'Theme data too large' });
  const data = readCustomThemes();
  data[name] = { css, terminal: terminal || {} };
  writeCustomThemes(data);
  res.json({ success: true });
});

app.delete('/api/custom-themes/:name', (req, res) => {
  const data = readCustomThemes();
  if (!data[req.params.name]) return res.status(404).json({ error: 'Theme not found' });
  delete data[req.params.name];
  writeCustomThemes(data);
  res.json({ success: true });
});

// ── User State Persistence (server-side, replaces localStorage for starred/archived/names/groups) ──
const USER_STATE_FILE = path.join(__dirname, 'data', 'user-state.json');
let _userStateCache = null;
const USER_STATE_DEFAULT = { starredSessions: [], archivedSessions: [], customNames: {}, sessionGroups: {} };

function readUserState() {
  if (_userStateCache) return _userStateCache;
  ensureDir(path.join(__dirname, 'data'));
  try { _userStateCache = JSON.parse(fs.readFileSync(USER_STATE_FILE, 'utf-8')); }
  catch { _userStateCache = { ...USER_STATE_DEFAULT }; }
  return _userStateCache;
}

function writeUserState(data) {
  ensureDir(path.join(__dirname, 'data'));
  _userStateCache = data;
  fs.writeFileSync(USER_STATE_FILE, JSON.stringify(data, null, 2));
  // Broadcast to ALL WebSocket clients
  const msg = JSON.stringify({ type: 'user-state-updated', state: data });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) { try { client.send(msg); } catch {} }
  });
}

// Get full user state
app.get('/api/user-state', (req, res) => {
  res.json(readUserState());
});

// Save full user state (replaces entire state)
app.post('/api/user-state', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  writeUserState(data);
  res.json({ success: true });
});

// ── Settings API (user preferences, separate from session state) ──
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
let _settingsCache = null;

function readSettings() {
  if (_settingsCache) return _settingsCache;
  ensureDir(path.join(__dirname, 'data'));
  try { _settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); }
  catch { _settingsCache = {}; }
  return _settingsCache;
}

function writeSettings(data) {
  ensureDir(path.join(__dirname, 'data'));
  _settingsCache = data;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
  const msg = JSON.stringify({ type: 'settings-updated', settings: data });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) { try { client.send(msg); } catch {} }
  });
}

app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  writeSettings(data);
  res.json({ success: true });
});

app.patch('/api/settings', (req, res) => {
  const current = readSettings();
  const patch = req.body;
  if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Expected object' });
  const merged = { ...current, ...patch };
  // Remove keys set to null (reset to default)
  for (const [k, v] of Object.entries(merged)) { if (v === null) delete merged[k]; }
  writeSettings(merged);
  res.json({ success: true });
});

// Get just session groups
app.get('/api/session-groups', (req, res) => {
  const state = readUserState();
  res.json(state.sessionGroups || {});
});

// Save session groups (replaces all groups)
app.post('/api/session-groups', (req, res) => {
  const groups = req.body;
  if (!groups || typeof groups !== 'object') return res.status(400).json({ error: 'Expected object' });
  const state = readUserState();
  state.sessionGroups = groups;
  writeUserState(state);
  res.json({ success: true });
});

// Create a new session group
app.post('/api/session-groups/create', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const state = readUserState();
  if (!state.sessionGroups) state.sessionGroups = {};
  const groupId = 'group-' + crypto.randomUUID();
  state.sessionGroups[groupId] = { name, sessionIds: [] };
  writeUserState(state);
  res.json({ success: true, groupId, group: state.sessionGroups[groupId] });
});

// Delete a session group
app.post('/api/session-groups/delete', (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });
  const state = readUserState();
  if (!state.sessionGroups || !state.sessionGroups[groupId]) {
    return res.status(404).json({ error: 'Group not found' });
  }
  delete state.sessionGroups[groupId];
  writeUserState(state);
  res.json({ success: true });
});

// Rename a session group
app.post('/api/session-groups/rename', (req, res) => {
  const { groupId, name } = req.body;
  if (!groupId || !name) return res.status(400).json({ error: 'groupId and name are required' });
  const state = readUserState();
  if (!state.sessionGroups || !state.sessionGroups[groupId]) {
    return res.status(404).json({ error: 'Group not found' });
  }
  state.sessionGroups[groupId].name = name;
  writeUserState(state);
  res.json({ success: true });
});

// Assign a session to a group
app.post('/api/session-groups/assign', (req, res) => {
  const { groupId, sessionId } = req.body;
  if (!groupId || !sessionId) return res.status(400).json({ error: 'groupId and sessionId are required' });
  const state = readUserState();
  if (!state.sessionGroups || !state.sessionGroups[groupId]) {
    return res.status(404).json({ error: 'Group not found' });
  }
  const group = state.sessionGroups[groupId];
  if (!group.sessionIds.includes(sessionId)) {
    group.sessionIds.push(sessionId);
    writeUserState(state);
  }
  res.json({ success: true });
});

// Unassign a session from a group
app.post('/api/session-groups/unassign', (req, res) => {
  const { groupId, sessionId } = req.body;
  if (!groupId || !sessionId) return res.status(400).json({ error: 'groupId and sessionId are required' });
  const state = readUserState();
  if (!state.sessionGroups || !state.sessionGroups[groupId]) {
    return res.status(404).json({ error: 'Group not found' });
  }
  const group = state.sessionGroups[groupId];
  group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
  writeUserState(state);
  res.json({ success: true });
});

// Auto-save (saves current workspace state for restore on refresh)
// Mobile and desktop save separately to avoid overwriting each other's layout
app.post('/api/layouts-autosave', (req, res) => {
  const data = readLayouts();
  const deviceType = req.body.deviceType || 'desktop';
  if (deviceType === 'mobile') {
    data.autoSaveMobile = { ...req.body, updatedAt: Date.now() };
  } else {
    data.autoSave = { ...req.body, updatedAt: Date.now() };
  }
  writeLayouts(data);
  res.json({ success: true });
});

// ── Claude Sessions API ──
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Recover real filesystem path from Claude's project directory name
// Claude encodes paths by replacing both '/' and '.' with '-'
// e.g. "/home/user/.claude/work" -> "-home-user--claude-work"
// We greedily reconstruct by checking the filesystem, trying both plain and dot-prefixed names
function recoverCwdFromProjDir(projDir) {
  const parts = projDir.replace(/^-/, '').split('-');
  let current = '/';

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue; // skip empty from double dash

    // Build candidates: try longest match first (handles hyphens in names)
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const segment = parts.slice(i, j).join('-');
      // Try as-is
      if (fs.existsSync(path.join(current, segment))) {
        current = path.join(current, segment); i = j - 1; found = true; break;
      }
      // Try with dot prefix (e.g. segment "claude" -> ".claude")
      if (fs.existsSync(path.join(current, '.' + segment))) {
        current = path.join(current, '.' + segment); i = j - 1; found = true; break;
      }
      // Try with underscore instead of hyphen (e.g. "260322-Random" -> "260322_Random")
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

// ── Session Discovery (redesigned 2026-03-24) ──
// Lock-first approach: lock files are the source of truth for RUNNING sessions.
// JSONL files are the source of truth for session HISTORY.
//
// Claude Code internals:
//   Lock file: ~/.claude/sessions/<PID>.json → {pid, sessionId, cwd, startedAt}
//     - Created when claude starts, deleted on graceful exit
//     - sessionId changes on each --resume (new ID, but JSONL filename stays original)
//   JSONL file: ~/.claude/projects/<encodedCwd>/<originalSessionId>.jsonl
//     - Filename = original sessionId (never changes, even after --resume)
//     - Encoding: cwd.replace(/[/._]/g, '-') → project dir name
//
// Matching: lock.cwd → derive project dir → find most recent JSONL → that's the running session.

// Build a map of PID → tmux target for all tmux panes
function getTmuxPaneMap() {
  const map = new Map(); // pid (number) → "session:window.pane"
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
  // Check if PID itself is a tmux pane
  if (paneMap.has(pid)) return paneMap.get(pid);
  // Check parent (claude is often a child of the pane's shell)
  try {
    const ppid = parseInt(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8', timeout: 2000 }).trim());
    if (paneMap.has(ppid)) return paneMap.get(ppid);
  } catch {}
  return null;
}

function cwdToProjectDir(cwd) {
  return cwd.replace(/[/._]/g, '-');
}

// Parse a Claude session JSONL file into chat messages
function parseSessionJsonl(claudeSessionId, cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  // Try exact project dir from cwd
  const projDir = cwdToProjectDir(cwd || '');
  const candidates = [];
  if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId + '.jsonl'));
  // Also scan all project dirs as fallback
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, claudeSessionId + '.jsonl');
      if (!candidates.includes(fp)) candidates.push(fp);
    }
  } catch {}

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      const messages = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          // Only include user/assistant/result messages (skip system/hooks/internal)
          // Skip subagent messages (have parent_tool_use_id or isSidechain)
          if (msg.parent_tool_use_id || msg.isSidechain) continue;
          if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'result' || (msg.type === 'system' && msg.subtype === 'init')) {
            messages.push(msg);
          }
        } catch {}
      }
      return messages;
    } catch {}
  }
  return [];
}

function isProcessClaude(pid) {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 2000 }).trim();
    return cmd === 'claude' || cmd.includes('claude');
  } catch { return false; }
}

const _sessionMetaCache = new Map(); // filePath → { mtimeMs, meta }

function extractSessionMeta(filePath) {
  // Check cache by mtime
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const cached = _sessionMetaCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  } catch {}

  // Read first 32KB of JSONL to extract cwd and first user message (name)
  let cwd = '', name = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32768);
    const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (!cwd && d.cwd) cwd = d.cwd;
        if (d.type === 'user' && !name) {
          const msg = d.message;
          if (msg?.content) {
            const content = Array.isArray(msg.content)
              ? (msg.content.find(c => c.type === 'text')?.text || '')
              : String(msg.content);
            name = content.split('\n')[0].substring(0, 80);
          }
        }
        if (cwd && name) break;
      } catch {}
    }
  } catch {}

  const meta = { cwd, name };
  try { _sessionMetaCache.set(filePath, { mtimeMs: fs.statSync(filePath).mtimeMs, meta }); } catch {}
  return meta;
}

// Get subagent metadata for a session (description → agentId mapping)
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

// Kill an external/tmux session by PID (not managed by WebUI WebSocket)
// Get chat message history for a Claude session (from JSONL file)
app.get('/api/session-messages', (req, res) => {
  const { claudeSessionId, cwd, offset, limit, search, withStatus } = req.query;
  if (!claudeSessionId) return res.status(400).json({ error: 'claudeSessionId required' });
  const allMessages = parseSessionJsonl(claudeSessionId, cwd || '');
  const total = allMessages.length;

  // Build chatStatus if requested
  let chatStatus = null;
  if (withStatus) {
    let lastUsage = null, model = null, contextWindow = 0, totalCost = 0, slashCommands = null;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i];
      if (!lastUsage && m.type === 'assistant' && m.message?.usage) lastUsage = m.message.usage;
      if (!model && m.type === 'result' && m.modelUsage) { model = Object.keys(m.modelUsage)[0]; contextWindow = Object.values(m.modelUsage)[0]?.contextWindow || 0; }
      if (lastUsage && model) break;
    }
    let permissionMode = null;
    for (const m of allMessages) { if (m.type === 'system' && m.subtype === 'init') { if (m.slash_commands) slashCommands = m.slash_commands; if (!model && m.model) model = m.model; if (m.permissionMode) permissionMode = m.permissionMode; break; } }
    for (const m of allMessages) { if (m.type === 'result' && m.total_cost_usd) totalCost += m.total_cost_usd; }
    if (lastUsage || model) chatStatus = { model, lastUsage, contextWindow, total_cost_usd: totalCost, slashCommands, permissionMode, permissionModes: PERMISSION_MODES, subagentMetas: getSubagentMetas(claudeSessionId, cwd || '') };
  }

  if (search) {
    // Server-side search: find messages containing the query
    const q = search.toLowerCase();
    const matches = [];
    for (let i = 0; i < allMessages.length; i++) {
      const m = allMessages[i];
      const c = m.message?.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.map(b => b.text || '').join(' ');
      if (text.toLowerCase().includes(q)) {
        matches.push({ index: i, type: m.type, preview: text.substring(0, 120) });
      }
    }
    res.json({ matches, total });
  } else if (offset !== undefined || limit !== undefined) {
    const o = parseInt(offset) || 0;
    const l = parseInt(limit) || 50;
    res.json({ messages: allMessages.slice(o, o + l), total, chatStatus });
  } else {
    res.json({ messages: allMessages, total, chatStatus });
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
      const messages = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'result') messages.push(msg);
        } catch {}
      }
      // Read meta
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(filePath.replace('.jsonl', '.meta.json'), 'utf-8')); } catch {}
      return res.json({ messages, total: messages.length, meta });
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
          if (match) {
            status = webuiPids.has(match.lock.pid) ? 'live'
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
            status: webuiPids.has(entry.lock.pid) ? 'live'
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
        // Change permission mode mid-session via control_request
        const session = activeSessions.get(data.sessionId);
        if (session?.pty && session.mode === 'chat' && data.mode) {
          const msg = {
            type: 'control_request',
            request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            request: { subtype: 'set_permission_mode', mode: data.mode },
          };
          session.pty.write(JSON.stringify(msg) + '\n');
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
          session._waitingForResponse = true;
          // Write to buffer for display on refresh (before JSONL is written).
          // Mark with _fromWebui so dedup can remove it when JSONL version arrives.
          userMsg._fromWebui = true;
          session.buffer = (session.buffer + JSON.stringify(userMsg) + '\n').slice(-500000);
          broadcastToSession(session, data.sessionId, { type: 'chat-message', sessionId: data.sessionId, message: userMsg });
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
          const msg = {
            type: 'control_request',
            request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            request: { subtype: 'interrupt' },
          };
          session.pty.write(JSON.stringify(msg) + '\n');
          // 2. Fallback: SIGINT to claude child process (bypasses PTY/dtach chain)
          if (session._childPid) {
            try { process.kill(session._childPid, 'SIGINT'); } catch {}
          }
        }
        break;
      }

      case 'permission-response': {
        // Permission approval/denial from chat UI → write control_response to claude stdin
        const session = activeSessions.get(data.sessionId);
        if (session?.pty && session.mode === 'chat') {
          const allowResponse = { behavior: 'allow', updatedInput: data.toolInput || {} };
          if (data.permissionUpdates?.length) allowResponse.permission_updates = data.permissionUpdates;
          const response = {
            type: 'control_response',
            response: data.approved
              ? { subtype: 'success', request_id: data.requestId, response: allowResponse }
              : { subtype: 'success', request_id: data.requestId, response: { behavior: 'deny', message: 'User denied this action' } },
          };
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
            let messages = [], meta = {};
            const candidates = [path.join(projectsDir, projDir, claudeId, 'subagents')];
            try { for (const dir of fs.readdirSync(projectsDir)) { const fp = path.join(projectsDir, dir, claudeId, 'subagents'); if (!candidates.includes(fp)) candidates.push(fp); } } catch {}
            for (const subDir of candidates) {
              const fp = path.join(subDir, `agent-${agentId}.jsonl`);
              try {
                if (!fs.existsSync(fp)) continue;
                for (const line of fs.readFileSync(fp, 'utf-8').split('\n')) {
                  try { const m = JSON.parse(line.trim()); if (m.type === 'user' || m.type === 'assistant' || m.type === 'result') messages.push(m); } catch {}
                }
                try { meta = JSON.parse(fs.readFileSync(fp.replace('.jsonl', '.meta.json'), 'utf-8')); } catch {}
                break;
              } catch {}
            }
            ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', chatHistory: messages, totalCount: messages.length, meta }));
          } else {
            // Live agent: sub-{parentToolUseId} — find parent session and return buffered messages
            const toolUseId = subId.slice('sub-'.length);
            let found = false;
            for (const [sid, sess] of activeSessions) {
              if (sess.subagentBuffers?.has(toolUseId)) {
                sess.clients.set(ws, { cols: 120, rows: 30 }); // register for broadcasts
                const msgs = sess.subagentBuffers.get(toolUseId);
                ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', chatHistory: msgs, totalCount: msgs.length }));
                found = true;
                break;
              }
            }
            if (!found) ws.send(JSON.stringify({ type: 'attached', sessionId: subId, mode: 'chat', chatHistory: [], totalCount: 0 }));
          }
          break;
        }

        const session = activeSessions.get(data.sessionId);
        if (session) {
          session.clients.set(ws, { cols: 120, rows: 30 });
          attachedSessions.add(data.sessionId);
          if (session.mode === 'chat') {
            // Load JSONL history (past conversation from Claude's session file)
            let jsonlHistory = [];
            const jsonlUuids = new Set();
            if (session.claudeSessionId) {
              jsonlHistory = parseSessionJsonl(session.claudeSessionId, session.cwd);
              for (const m of jsonlHistory) { if (m.uuid) jsonlUuids.add(m.uuid); }
            }
            // Parse buffer for current session output — only include messages
            // Parse buffer: separate regular messages from control_requests
            const bufferMessages = [];
            const pendingPermissions = {}; // tool_use_id → control_request
            for (const line of (session.buffer || '').split('\n')) {
              const trimmed = line.replace(/\r/g, '').trim();
              if (!trimmed) continue;
              try {
                const msg = JSON.parse(trimmed);
                if (msg.type === 'control_request' && msg.request?.tool_use_id) {
                  pendingPermissions[msg.request.tool_use_id] = msg;
                  continue;
                }
                if (msg.parent_tool_use_id || msg.isSidechain) continue; // skip subagent messages
                if (msg.type !== 'user' && msg.type !== 'assistant' && msg.type !== 'result' && !(msg.type === 'system' && msg.subtype === 'init')) continue;
                if (msg.uuid && jsonlUuids.has(msg.uuid)) continue;
                // Webui user messages: skip if JSONL has a user message after this timestamp
                // (Claude processed it — JSONL has the authoritative version with uuid)
                if (msg._fromWebui && msg.timestamp) {
                  const hasNewer = jsonlHistory.some(m => m.type === 'user' && m.timestamp >= msg.timestamp);
                  if (hasNewer) continue;
                }
                bufferMessages.push(msg);
              } catch {}
            }
            // Buffer messages are always from current run (after JSONL)
            const allMessages = [...jsonlHistory, ...bufferMessages];

            // Detect compact boundary index
            let compactBoundaryIdx = -1;
            for (let i = allMessages.length - 1; i >= 0; i--) {
              const c = allMessages[i].message?.content;
              if (typeof c === 'string' && c.includes('continued from a previous conversation') && c.includes('ran out of context')) {
                compactBoundaryIdx = i;
                break;
              }
            }

            const PAGE_SIZE = 50;
            const chatHistory = allMessages.slice(-PAGE_SIZE);
            const totalCount = allMessages.length;

            // Extract latest status: last assistant's per-turn usage + cumulative cost
            let chatStatus = null;
            let lastUsage = null, model = null, contextWindow = 0, totalCost = 0, slashCommands = null;
            for (let i = allMessages.length - 1; i >= 0; i--) {
              const m = allMessages[i];
              if (!lastUsage && m.type === 'assistant' && m.message?.usage) {
                lastUsage = m.message.usage;
              }
              if (!model && m.type === 'result' && m.modelUsage) {
                model = Object.keys(m.modelUsage)[0];
                contextWindow = Object.values(m.modelUsage)[0]?.contextWindow || 0;
              }
              if (lastUsage && model) break;
            }
            // Find slash_commands + permissionMode from system.init
            let permissionMode = null;
            for (const m of allMessages) {
              if (m.type === 'system' && m.subtype === 'init') {
                if (m.slash_commands) slashCommands = m.slash_commands;
                if (!model && m.model) model = m.model;
                if (m.permissionMode) permissionMode = m.permissionMode;
                break;
              }
            }
            for (const m of allMessages) {
              if (m.type === 'result' && m.total_cost_usd) totalCost += m.total_cost_usd;
            }
            if (lastUsage || model) {
              chatStatus = { model, lastUsage, contextWindow, total_cost_usd: totalCost, slashCommands, permissionMode, permissionModes: PERMISSION_MODES, subagentMetas: getSubagentMetas(session.claudeSessionId, session.cwd) };
            }

            // Detect if Claude is mid-stream: only check buffer messages (current run)
            // JSONL-only sessions (e.g. terminal mode viewed as chat) may never have 'result'
            const lastBufMsg = bufferMessages.length > 0 ? bufferMessages[bufferMessages.length - 1] : null;
            const isStreaming = session._waitingForResponse || (lastBufMsg && lastBufMsg.type !== 'result' && lastBufMsg.type !== 'system');

            // Filter out resolved permissions (tool_use_id has a matching tool_result)
            const resolvedToolIds = new Set();
            for (const m of allMessages) {
              if (m.type !== 'user') continue;
              const c = m.message?.content;
              if (!Array.isArray(c)) continue;
              for (const b of c) {
                if (b.type === 'tool_result' && b.tool_use_id) resolvedToolIds.add(b.tool_use_id);
              }
            }
            const activePendingPermissions = {};
            for (const [toolUseId, cr] of Object.entries(pendingPermissions)) {
              if (!resolvedToolIds.has(toolUseId)) activePendingPermissions[toolUseId] = cr;
            }

            ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, mode: 'chat', chatHistory, totalCount, chatStatus, isStreaming, pendingPermissions: activePendingPermissions, compactBoundaryIdx: compactBoundaryIdx >= 0 ? compactBoundaryIdx : undefined }));
          } else {
            ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, buffer: session.buffer || '' }));
          }
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
