const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

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
const HOST = process.env.HOST || '0.0.0.0';
const EDITOR_SCRIPT = path.join(__dirname, 'editor-helper.sh');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));
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
const { execFileSync, spawn } = require('child_process');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// ── Cached webuiPids (PIDs managed by webui dtach sessions) ──
const webuiPids = new Set();

function collectDescendantPids(socketPath) {
  const pids = new Set();
  try {
    const out = execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf-8', timeout: 2000 }).trim();
    const rootPids = out.split('\n').map(l => parseInt(l.trim())).filter(Boolean);
    const queue = [...rootPids];
    while (queue.length) {
      const pid = queue.pop();
      try {
        // macOS ps uses -o ppid= not --ppid; use pgrep -P instead (cross-platform)
        const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8', timeout: 2000 });
        for (const cl of children.trim().split('\n')) {
          const cpid = parseInt(cl.trim());
          if (cpid && !pids.has(cpid)) { pids.add(cpid); queue.push(cpid); }
        }
      } catch {}
    }
  } catch {}
  return pids;
}

function refreshWebuiPids() {
  webuiPids.clear();
  for (const [, s] of activeSessions) {
    if (s.socketPath) {
      for (const pid of collectDescendantPids(s.socketPath)) {
        webuiPids.add(pid);
      }
    }
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
  ptyProcess.onData((output) => {
    session.buffer = (session.buffer + output).slice(-50000);
    broadcastToSession(session, id, { type: 'output', sessionId: id, data: output });
  });
  ptyProcess.onExit(() => {
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

    let savedBuffer = '';
    if (id) {
      try { savedBuffer = fs.readFileSync(path.join(BUFFERS_DIR, id + '.buf'), 'utf-8'); } catch {}
    }

    const session = {
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

// ── Layout Persistence (cached in memory) ──
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

// Auto-save (saves current workspace state for restore on refresh)
app.post('/api/layouts-autosave', (req, res) => {
  const data = readLayouts();
  data.autoSave = { ...req.body, updatedAt: Date.now() };
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

app.get('/api/sessions', (req, res) => {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    // Step 0: Use cached webuiPids (updated on session create/kill/restore)

    // Step 1: Scan lock files + tmux panes → build map of RUNNING sessions
    const paneMap = getTmuxPaneMap();
    const runningByProjDir = new Map(); // projDirName → {lock, tmuxTarget, assigned: false}
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
          if (!isPidAlive(data.pid)) continue;
          if (!isProcessClaude(data.pid)) continue;
          const projDirName = cwdToProjectDir(data.cwd);
          const tmuxTarget = findTmuxTarget(data.pid, paneMap);
          const existing = runningByProjDir.get(projDirName);
          if (!existing || data.startedAt > (existing.lock.startedAt || 0)) {
            runningByProjDir.set(projDirName, { lock: data, tmuxTarget, assigned: false });
          }
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

        // Check if there's a running lock for this project dir
        const running = runningByProjDir.get(projDir);

        for (const f of jsonls) {
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(projPath, f);
          const mtime = statMap.get(f) || 0;

          const meta = extractSessionMeta(filePath);
          const cwd = (running?.lock.cwd) || meta.cwd || recoverCwdFromProjDir(projDir);

          // Assign the running lock to the MOST RECENT JSONL in this project dir
          let status = 'stopped', pid = null, tmuxTarget = null;
          if (running && !running.assigned) {
            status = webuiPids.has(running.lock.pid) ? 'live'
              : running.tmuxTarget ? 'tmux' : 'external';
            pid = running.lock.pid;
            tmuxTarget = running.tmuxTarget || null;
            running.assigned = true;
          }

          sessions.push({ sessionId, cwd, pid, startedAt: mtime, status, name: meta.name || '', tmuxTarget });
        }
      }
    }

    // Step 3: Running locks that didn't match any project dir (brand new, no JSONL yet)
    for (const [, entry] of runningByProjDir) {
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

    sessions.sort((a, b) => b.startedAt - a.startedAt);
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/active', (req, res) => {
  const sessions = [];
  for (const [id, s] of activeSessions) {
    sessions.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null });
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
    activeList.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null });
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

        // Build claude command
        const claudeArgs = [];
        if (data.resume && data.resumeId) claudeArgs.push('--resume', data.resumeId);
        if (data.sessionName) claudeArgs.push('--name', data.sessionName);
        if (data.model) claudeArgs.push('--model', data.model);
        if (data.permissionMode) claudeArgs.push('--permission-mode', data.permissionMode);
        if (data.extraArgs) claudeArgs.push(...data.extraArgs.trim().split(/\s+/).filter(Boolean));

        // Create dtach session using wrapper for output buffering + metadata
        // dtach -c creates and immediately attaches (no output loss)
        // wrapper.sh captures all output via script(1) for server restart recovery
        ensureDir(SOCKETS_DIR);
        ensureDir(BUFFERS_DIR);

        const session = {
          pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
          cwd, name: data.sessionName || `Session ${sessionCounter}`,
          createdAt: Date.now(), claudeSessionId: data.resumeId || null,
          sockName, socketPath, buffer: '',
        };

        // Use pty-wrapper.js inside dtach for persistent output buffering
        // Wrapper survives server restarts, tees output to buffer file
        const bufFile = path.join(BUFFERS_DIR, id + '.buf');
        const metaFileW = path.join(BUFFERS_DIR, id + '.json');
        let createPty;
        try {
          createPty = pty.spawn(DTACH_CMD, ['-c', socketPath, '-E', '-r', 'none',
            NODE_CMD, PTY_WRAPPER,
            bufFile, metaFileW,
            ENV_CMD, `EDITOR=${EDITOR_CMD}`, `CLAUDE_WEBUI_PORT=${PORT}`, `CLAUDE_WEBUI_SESSION_ID=${id}`, `DISPLAY=${process.env.DISPLAY || ''}`,
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

        writeSessionMeta(sockName, { name: session.name, cwd, claudeSessionId: session.claudeSessionId, createdAt: session.createdAt, webuiSessionId: id });

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
                  writeSessionMeta(sockName, { name: session.name, cwd, claudeSessionId: session.claudeSessionId, createdAt: session.createdAt, webuiSessionId: id });
                  broadcastActiveSessions();
                  return;
                }
              }
            } catch {}
            setTimeout(() => tryCapture(attempts - 1), 1000);
          };
          setTimeout(() => tryCapture(15), 2000);
        }

        // Schedule delayed webuiPids refresh (child processes need time to start)
        setTimeout(refreshWebuiPids, 3000);

        ws.send(JSON.stringify({ type: 'created', sessionId: id, name: session.name, cwd }));
        broadcastActiveSessions();
        break;
      }

      case 'input': {
        const session = activeSessions.get(data.sessionId);
        if (session?.pty) session.pty.write(data.data);
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
        const session = activeSessions.get(data.sessionId);
        if (session) {
          session.clients.set(ws, { cols: 120, rows: 30 });
          attachedSessions.add(data.sessionId);
          ws.send(JSON.stringify({ type: 'attached', sessionId: data.sessionId, name: session.name, cwd: session.cwd, buffer: session.buffer || '' }));
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
    activeList.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null });
  }
  const msg = JSON.stringify({ type: 'active-sessions', sessions: activeList });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) {
      try { client.send(msg); } catch {}
    }
  });
}

// ── Start Server ──
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
