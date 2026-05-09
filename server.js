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
const { createMessageManager } = require('./src/normalizers');
const { SyncStore } = require('./src/sync-store');
const { cwdToProjectDir, SessionMessages } = require('./src/session-store');
const { CodexSessionMessages } = require('./src/codex-session-store');
const { normalizeCodexSource, CODEX_SESSIONS_DIR } = require('./src/adapters/codex');
const { createAdapterRegistry } = require('./src/adapters');
const fileRoutes = require('./src/routes/files');
const { router: persistenceRouter, setup: setupPersistence } = require('./src/routes/persistence');

// Auto-update: pull latest + rebuild on startup (skip with NO_AUTO_UPDATE=1)
if (!process.env.NO_AUTO_UPDATE) {
  try {
    const repoDir = __dirname;
    // Ensure Homebrew/nvm paths are in PATH for child processes (macOS non-login shells)
    const nodeDir = path.dirname(process.execPath);
    const envPath = [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
    const spawnEnv = { ...process.env, PATH: envPath };
    const result = execFileSync('git', ['-C', repoDir, 'pull', '--ff-only'], { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result && !result.includes('Already up to date')) {
      console.log('[auto-update] git pull:', result);
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: repoDir, encoding: 'utf-8', timeout: 60000, stdio: 'inherit', env: spawnEnv });
      execFileSync('npm', ['run', 'build'], { cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'inherit', env: spawnEnv });
      console.log('[auto-update] rebuilt successfully');
    }
  } catch (e) { console.log('[auto-update] skipped:', e.message?.split('\n')[0]); }
}

const PORT = process.env.PORT || 3456;
const CLAUDE_CMD_RAW = process.env.CLAUDE_CMD || 'claude';
const CODEX_CMD_RAW = process.env.CODEX_CMD || 'codex';
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
const CODEX_CMD = CODEX_CMD_RAW.startsWith('/') ? CODEX_CMD_RAW : resolveCmd(CODEX_CMD_RAW);
const CODEX_LINUX_SANDBOX_CMD = resolveCmd('codex-linux-sandbox');
const CODEX_SANDBOX_SUPPORTED = process.platform !== 'linux'
  || (!!CODEX_LINUX_SANDBOX_CMD && CODEX_LINUX_SANDBOX_CMD !== 'codex-linux-sandbox')
  || (typeof CODEX_LINUX_SANDBOX_CMD === 'string' && fs.existsSync(CODEX_LINUX_SANDBOX_CMD));
const adapterRegistry = createAdapterRegistry({
  claudeCmd: CLAUDE_CMD,
  codexCmd: CODEX_CMD,
  codexSandboxSupported: CODEX_SANDBOX_SUPPORTED,
  chatWrapper: path.join(__dirname, 'data', 'bin', 'chat-wrapper.js'),
  codexChatWrapper: path.join(__dirname, 'data', 'bin', 'codex-chat-wrapper.js'),
  ptyWrapper: path.join(__dirname, 'data', 'bin', 'pty-wrapper.js'),
  buffersDir: path.join(__dirname, 'data', 'session-buffers'),
});

if (!CODEX_SANDBOX_SUPPORTED) {
  console.log('[codex] codex-linux-sandbox not found; default/safe-yolo sessions will run unsandboxed.');
}

// Parse available permission modes, effort levels, and supported flags from claude --help
let PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'];
let EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];
let CLAUDE_SUPPORTS_NAME = false;
try {
  const help = execFileSync(CLAUDE_CMD, ['--help'], { encoding: 'utf-8', timeout: 5000 });
  const permMatch = help.match(/--permission-mode.*choices:\s*(.+)\)/);
  if (permMatch) {
    PERMISSION_MODES = permMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) || PERMISSION_MODES;
  }
  // --effort <level>  Effort level ... (low, medium, high, max)
  const effortMatch = help.match(/--effort\s+\S+\s+[^(]*\(([^)]+)\)/);
  if (effortMatch) {
    EFFORT_LEVELS = effortMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  CLAUDE_SUPPORTS_NAME = /--name\b/.test(help);
} catch {}
// Propagate capability flags to the adapter
adapterRegistry.get('claude').config.supportsName = CLAUDE_SUPPORTS_NAME;
// Discover available models per backend (cached, refreshed periodically)
const AVAILABLE_MODELS = {
  claude: [{ id: '', label: 'Default' }, { id: 'opus', label: 'opus (latest, 200k)' }, { id: 'opus[1m]', label: 'opus[1m] (latest, 1M)' }, { id: 'sonnet', label: 'sonnet (latest)' }, { id: 'sonnet[1m]', label: 'sonnet[1m] (latest, 1M)' }, { id: 'haiku', label: 'haiku (latest)' }],
  codex: [{ id: '', label: 'Default' }],
};
function refreshAvailableModels() {
  const aliases = [
    { id: '', label: 'Default' },
    { id: 'opus', label: 'opus (latest, 200k)' },
    { id: 'opus[1m]', label: 'opus[1m] (latest, 1M context)' },
    { id: 'sonnet', label: 'sonnet (latest)' },
    { id: 'sonnet[1m]', label: 'sonnet[1m] (latest, 1M context)' },
    { id: 'haiku', label: 'haiku (latest)' },
  ];

  function fetchModels(token, useOAuth) {
    const headers = { 'anthropic-version': '2023-06-01' };
    let endpoint = '/v1/models';
    if (useOAuth) {
      headers['Authorization'] = 'Bearer ' + token;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
      endpoint = '/api/claude_cli/bootstrap';
    } else {
      headers['x-api-key'] = token;
    }
    const req = https.request('https://api.anthropic.com' + endpoint, {
      method: 'GET', headers,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (useOAuth) {
            const extra = data.additional_model_options;
            if (extra?.length) {
              const models = extra.map(m => ({ id: m.model, label: m.name || m.model }));
              AVAILABLE_MODELS.claude = [...aliases, ...models];
            }
          } else if (data.data?.length) {
            const models = data.data.map(m => {
              const ctx = m.max_input_tokens >= 1000000 ? '1M' : m.max_input_tokens >= 200000 ? '200k' : Math.round(m.max_input_tokens / 1000) + 'k';
              return { id: m.id, label: `${m.display_name || m.id} (${ctx})` };
            });
            AVAILABLE_MODELS.claude = [...aliases, ...models];
          }
        } catch {}
      });
    });
    req.on('error', () => {});
    req.end();
  }

  // Prefer OAuth (supports bootstrap endpoint), fall back to API key (/v1/models)
  const apiKey = process.env.ANTHROPIC_API_KEY || null;
  getOAuthToken((oauthToken) => {
    if (oauthToken) fetchModels(oauthToken, true);
    else if (apiKey) fetchModels(apiKey, false);
  });
  // Codex: read from ~/.codex/models_cache.json
  try {
    const codexCache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf-8'));
    if (codexCache.models?.length) {
      AVAILABLE_MODELS.codex = [{ id: '', label: 'Default' }, ...codexCache.models.map(m => {
        const ctx = m.context_window ? (m.context_window >= 1000000 ? Math.round(m.context_window / 1000000) + 'M' : Math.round(m.context_window / 1000) + 'k') : '';
        return { id: m.slug, label: (m.display_name || m.slug) + (ctx ? ` (${ctx})` : '') };
      }).filter(m => m.id)];
    }
  } catch {}
}
setTimeout(refreshAvailableModels, 3000);
setInterval(refreshAvailableModels, 3600000); // refresh hourly

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
const sessionCounterRef = { value: 0 };
const SOCKETS_DIR = path.join(__dirname, 'data', 'sockets');
const META_DIR = path.join(__dirname, 'data', 'session-meta');
const BUFFERS_DIR = path.join(__dirname, 'data', 'session-buffers');
const USAGE_CACHE_FILE = path.join(__dirname, 'data', 'usage-cache.json');
const PTY_WRAPPER = path.join(__dirname, 'data', 'bin', 'pty-wrapper.js');
const CHAT_WRAPPER = path.join(__dirname, 'data', 'bin', 'chat-wrapper.js');
const CODEX_CHAT_WRAPPER = path.join(__dirname, 'data', 'bin', 'codex-chat-wrapper.js');

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
    let lineBuf = '';
    if (session.backend === 'codex') {
      const stripAnsi = (value) => String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
      ptyProcess.onData((output) => {
        session.buffer = (session.buffer + output).slice(-800000);
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
            const nextThreadId = msg.type === 'session_meta'
              ? payload.id
              : msg.type === 'wrapper_meta'
                ? payload.threadId
                : null;
            const nextThreadName = payload.session_name
              || payload.sessionName
              || payload.threadName
              || payload.name
              || payload.thread?.name
              || null;
            const sourceMeta = payload.source ? normalizeCodexSource(payload.source) : null;
            let changed = false;
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
                createdAt: session.createdAt,
                webuiSessionId: id,
                mode: session.mode,
              });
              broadcastActiveSessions();
            }
            if (session._normalizer) session._normalizer.processLive(msg);
          } catch {
            broadcastToSession(session, id, { type: 'output', sessionId: id, data: line + '\n' });
          }
        }
      });
    } else {
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
            if (msg.type === '_stdin_ack') { session._stdinAckReceived = true; continue; }

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
    }
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
    // Detect auth failure from buffer content (claude exits immediately with "Not logged in")
    const exitReason = /Not logged in|Please run \/login|OAuth token revoked/.test(session.buffer || '') ? 'not_logged_in' : undefined;
    if (cleanupOnExit) {
      if (session.socketPath && fs.existsSync(session.socketPath)) { session.pty = null; return; }
      broadcastToSession(session, id, { type: 'exited', sessionId: id, reason: exitReason });
      activeSessions.delete(id);
      if (session.sockName) deleteSessionMeta(session.sockName);
      broadcastActiveSessions();
    } else {
      broadcastToSession(session, id, { type: 'exited', sessionId: id, reason: exitReason });
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
    const id = meta.webuiSessionId || ('sess-' + (++sessionCounterRef.value) + '-' + Date.now());

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
      backend: meta.backend || 'claude',
      backendSessionId: meta.backendSessionId || meta.claudeSessionId || null,
      claudeSessionId: meta.claudeSessionId || null,
      sourceKind: meta.sourceKind || null,
      agentKind: meta.agentKind || 'primary',
      agentRole: meta.agentRole || '',
      agentNickname: meta.agentNickname || '',
      parentThreadId: meta.parentThreadId || null,
      forkedFrom: meta.forkedFrom || null,
      sockName: sockFile,
      socketPath,
      buffer: savedBuffer,
    };
    // Create normalizer for chat sessions (populated on first attach from JSONL + buffer)
    if (sessionMode === 'chat') {
      session._normalizer = createMessageManager(session.backend || 'claude', id);
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
syncStores.uploads = new SyncStore('uploads', path.join(__dirname, 'data', 'uploads-sync.json'), wss);

setupPersistence({ dataDir: path.join(__dirname, 'data'), wss, WS_OPEN, getSyncStore, activeSessions });
app.use(persistenceRouter);
const { readLayouts, writeLayouts } = persistenceRouter;

// Session discovery functions imported from ./src/session-store.js
// Helper to create SessionMessages with correct context
function createSessionMessages(session, sessionId) {
  return session?.backend === 'codex'
    ? new CodexSessionMessages(session, sessionId, { buffersDir: BUFFERS_DIR })
    : new SessionMessages(session, sessionId, { buffersDir: BUFFERS_DIR, permissionModes: PERMISSION_MODES });
}

// ── Session API (extracted to src/routes/sessions.js) ──
const { router: sessionsRouter, setup: setupSessions } = require('./src/routes/sessions');
setupSessions({ activeSessions, webuiPids, refreshWebuiPids, createSessionMessages, BUFFERS_DIR, PERMISSION_MODES, execFileSync });
app.use(sessionsRouter);

// ── Usage / Rate Limit ──
// Minimal haiku API call to read rate limit headers. Cached, refreshed every 5 min.
// Uses OAuth token from ~/.claude/.credentials.json (x-api-key header).
const https = require('https');
function readUsageCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf-8'));
    return cached?.claude || null;
  } catch {
    return null;
  }
}

function writeUsageCache() {
  if (!_rateLimitCache) return;
  try {
    ensureDir(path.dirname(USAGE_CACHE_FILE));
    const tmpPath = `${USAGE_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ claude: _rateLimitCache }, null, 2));
    fs.renameSync(tmpPath, USAGE_CACHE_FILE);
  } catch {}
}

let _rateLimitCache = readUsageCache();
let _codexRateLimitCache = null;
let _codexRateLimitCacheAt = 0;

let _oauthCreds = null; // { accessToken, refreshToken, expiresAt }
let _oauthMtime = 0;
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

function _readOAuthCreds() {
  try {
    // Linux: .credentials.json
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credsPath)) {
      const stat = fs.statSync(credsPath);
      if (_oauthCreds && stat.mtimeMs === _oauthMtime) return _oauthCreds;
      const raw = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const o = raw?.claudeAiOauth;
      if (o?.accessToken) { _oauthCreds = o; _oauthMtime = stat.mtimeMs; return _oauthCreds; }
    }
    // macOS: Keychain
    if (process.platform === 'darwin') {
      // Re-read from Keychain each time (Claude Code may have refreshed)
      try {
        const user = os.userInfo().username;
        const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', user, '-w'], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (out) {
          const o = JSON.parse(out)?.claudeAiOauth;
          if (o?.accessToken) { _oauthCreds = o; return _oauthCreds; }
        }
      } catch {}
    }
  } catch {}
  return _oauthCreds;
}

function _saveRefreshedToken(creds) {
  try {
    // Linux: write back to .credentials.json
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credsPath)) {
      const raw = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      raw.claudeAiOauth = { ...raw.claudeAiOauth, ...creds };
      fs.writeFileSync(credsPath, JSON.stringify(raw, null, 2));
      _oauthMtime = fs.statSync(credsPath).mtimeMs;
    }
    // macOS: Keychain — let Claude Code handle persisting on next run.
    // We update in-memory only; Claude Code will re-read Keychain and
    // see the token isn't expired, skipping its own refresh.
  } catch {}
  _oauthCreds = { ..._oauthCreds, ...creds };
}

function _refreshOAuthToken(callback) {
  const creds = _readOAuthCreds();
  if (!creds?.refreshToken) return callback(null);
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const req = https.request(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let data = '';
    res.on('data', d => { data += d; });
    res.on('end', () => {
      try {
        const resp = JSON.parse(data);
        if (resp.access_token) {
          const refreshed = {
            accessToken: resp.access_token,
            refreshToken: resp.refresh_token || creds.refreshToken,
            expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
          };
          _saveRefreshedToken(refreshed);
          callback(refreshed.accessToken);
        } else { callback(null); }
      } catch { callback(null); }
    });
  });
  req.on('error', () => callback(null));
  req.end(body);
}

function getOAuthToken(callback) {
  // Async version: callback(token) — handles refresh if expired
  if (callback) {
    const creds = _readOAuthCreds();
    if (!creds?.accessToken) return callback(null);
    if (creds.expiresAt && Date.now() > creds.expiresAt) {
      _refreshOAuthToken(callback);
    } else {
      callback(creds.accessToken);
    }
    return;
  }
  // Sync version (for rate limit polling where we don't want to block) —
  // returns cached token, may be expired (caller should handle 401).
  const creds = _readOAuthCreds();
  return creds?.accessToken || null;
}

function refreshRateLimit() {
  getOAuthToken((token) => {
    if (!token) return;
    _refreshRateLimitWithToken(token);
  });
}
function _refreshRateLimitWithToken(token) {
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
      writeUsageCache();
    }
    res.resume();
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}
setTimeout(refreshRateLimit, 5000); // delay startup to avoid hitting rate limits
setInterval(refreshRateLimit, 300000); // every 5 min

function normalizeCodexRateLimit(raw, fetchedAt = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const toWindow = (entry, fallbackWindowMinutes) => {
    if (!entry || typeof entry !== 'object') return null;
    const usedPercent = Number(entry.used_percent ?? entry.usedPercent);
    const normalizedPercent = Number.isFinite(usedPercent)
      ? Math.max(0, Math.min(100, usedPercent))
      : 0;
    return {
      utilization: normalizedPercent / 100,
      usedPercent: normalizedPercent,
      windowMinutes: Number(entry.window_minutes ?? entry.windowMinutes) || fallbackWindowMinutes || 0,
      resetsAt: Number(entry.resets_at ?? entry.resetsAt) || 0,
    };
  };

  const fiveHour = toWindow(raw.primary, 300);
  const sevenDay = toWindow(raw.secondary, 10080);
  if (!fiveHour && !sevenDay) return null;

  return {
    limitId: raw.limit_id || raw.limitId || 'codex',
    limitName: raw.limit_name || raw.limitName || '',
    planType: raw.plan_type || raw.planType || '',
    fiveHour,
    sevenDay,
    fetchedAt: Number(fetchedAt) || Date.now(),
  };
}

function readCodexWrapperRateLimit(sessionId) {
  if (!sessionId) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(BUFFERS_DIR, sessionId + '.json'), 'utf-8'));
    return normalizeCodexRateLimit(meta?.rateLimits, meta?.rateLimitsFetchedAt || meta?.startedAt || Date.now());
  } catch {
    return null;
  }
}

function readLatestCodexRateLimitFromJsonl(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line || !line.includes('"type":"event_msg"') || !line.includes('"type":"token_count"') || !line.includes('"rate_limits"')) continue;
      const record = JSON.parse(line);
      const timestamp = record?.timestamp ? Date.parse(record.timestamp) : 0;
      const rateLimits = record?.payload?.rate_limits || null;
      const normalized = normalizeCodexRateLimit(rateLimits, Number.isFinite(timestamp) ? timestamp : Date.now());
      if (normalized) return normalized;
    }
  } catch {}
  return null;
}

function listRecentCodexJsonlFiles(limit = 24) {
  const files = [];
  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fp = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
        continue;
      }
      if (!entry.isFile() || !fp.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(fp);
        files.push({ path: fp, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}

function summarizeCodexRateLimit() {
  const now = Date.now();
  if (now - _codexRateLimitCacheAt < 30000) return _codexRateLimitCache;

  let freshest = null;
  for (const [id, session] of activeSessions) {
    if (session.backend !== 'codex' || session.mode !== 'chat') continue;
    const snapshot = readCodexWrapperRateLimit(id);
    if (!snapshot) continue;
    if (!freshest || (snapshot.fetchedAt || 0) > (freshest.fetchedAt || 0)) freshest = snapshot;
  }

  if (!freshest) {
    const recentFiles = listRecentCodexJsonlFiles();
    for (const entry of recentFiles) {
      const snapshot = readLatestCodexRateLimitFromJsonl(entry.path);
      if (!snapshot) continue;
      if (!freshest || (snapshot.fetchedAt || 0) > (freshest.fetchedAt || 0)) freshest = snapshot;
      if (snapshot && snapshot.fetchedAt && (Date.now() - snapshot.fetchedAt) < 5 * 60 * 1000) break;
    }
  }

  _codexRateLimitCache = freshest;
  _codexRateLimitCacheAt = now;
  return _codexRateLimitCache;
}

app.get('/api/usage', (req, res) => {
  res.json({ rateLimit: _rateLimitCache, codexRateLimit: summarizeCodexRateLimit() });
});

app.get('/api/available-models', (req, res) => {
  res.json(AVAILABLE_MODELS);
});
app.get('/api/session-options', (req, res) => {
  res.json({ effortLevels: EFFORT_LEVELS, permissionModes: PERMISSION_MODES });
});

// ── WebSocket Terminal Handler (extracted to src/ws-handler.js) ──
const { registerWsHandler } = require('./src/ws-handler');
registerWsHandler(wss, {
  activeSessions, WS_OPEN, broadcastActiveSessions, broadcastToSession, resizeSessionToMin,
  setupSessionPty, refreshWebuiPids, deleteSessionMeta, writeSessionMeta,
  readLayouts, writeLayouts, getSyncStore,
  sessionCounterRef, createSessionMessages, PERMISSION_MODES,
  SOCKETS_DIR, BUFFERS_DIR, META_DIR, PTY_WRAPPER, CHAT_WRAPPER,
  NODE_CMD, DTACH_CMD, ENV_CMD, CLAUDE_CMD, CODEX_CMD, EDITOR_CMD, PORT,
  adapterRegistry, pty, path, fs, os, execFileSync, ensureDir,
});

function broadcastActiveSessions() {
  const getSessionKey = (session = {}) => {
    const backend = session.backend || 'claude';
    const backendSessionId = session.backendSessionId || session.sessionId || session.claudeSessionId || null;
    return backendSessionId ? `${backend}:${backendSessionId}` : '';
  };
  const activeList = [];
  for (const [id, s] of activeSessions) {
    // Exclude tmux view sessions — they shouldn't appear as separate "live" entries
    if (s.isTmuxView) continue;
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
  const ver = require('./package.json').version;
  console.log(`\n  Claude Code WebUI v${ver} running at http://localhost:${PORT}`);
  console.log(`  dtach: ${DTACH_CMD}, node: ${NODE_CMD}, env: ${ENV_CMD}, claude: ${CLAUDE_CMD}, codex: ${CODEX_CMD}`);

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
