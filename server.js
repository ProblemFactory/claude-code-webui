// libuv threadpool headroom (default 4): a few fs ops stuck on a dying fuse
// mount used to starve EVERY async fs/dns op server-wide (real outage — see
// mounts.js hung-mount defense). Must be set before the pool first spins up,
// i.e. before any require that performs async I/O.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';
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
const { createMessageManager, feedLive, feedPeerCard } = require('./src/normalizers');
const { Telemetry } = require('./src/telemetry');
const { SyncStore } = require('./src/sync-store');
const { cwdToProjectDir, SessionMessages, findSessionJsonlPath, dedupWebuiSockets } = require('./src/session-store');
const { CodexSessionMessages } = require('./src/codex-session-store');
const { normalizeCodexSource, CODEX_SESSIONS_DIR } = require('./src/adapters/codex');
const { createAdapterRegistry } = require('./src/adapters');
const { buildClaudeSubscriptionLoginCommand } = require('./src/claude-subscription-login');
const fileRoutes = require('./src/routes/files');
const { SafeFs } = require('./src/safe-fs');
const { router: persistenceRouter, setup: setupPersistence } = require('./src/routes/persistence');

// ── Env sanitation: the server may have been (re)started from INSIDE a Claude
// Code session (e.g. an agent running in a WebUI terminal restarts it). The
// inherited session env then leaks into every CLI this server spawns —
// CLAUDE_CODE_CHILD_SESSION=1 alone puts a spawned claude into child-session
// mode: NO lock file, NO project transcript. Conversations look fine live but
// are silently unpersisted — terminate + resume loses everything (verified on
// CLI 2.1.199 by A/B env test). Strip the whole inherited set at startup so all
// spawn paths (dtach spawn line, wrappers, probes) run top-level.
if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_CHILD_SESSION) {
  const stripped = [];
  for (const k of Object.keys(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_WEBUI_')) {
      stripped.push(k);
      delete process.env[k];
    }
  }
  console.warn(`[env] Server was started from inside a Claude Code session — stripped inherited session env (${stripped.join(', ')}) so spawned CLIs run top-level. Without this, spawned sessions never write transcripts and their conversations are LOST on resume.`);
}

// Optional persistent ops log (env-gated no-op without VIBESPACE_OPSLOG_DIR) —
// installed EARLY so the console tee captures the whole boot narrative.
try { require('./src/opslog').setupOpslog(require('./package.json').version); } catch (e) { console.warn('[opslog] init failed:', e.message); }

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

// ── CLI environment (src/server/cli-env.js, decomposition #14) ──
// X display + adapter registry + CLI capability probes + model registry.
const { X_ENV, detectXDisplay, refreshXEnv, stabilizeXAuth, adapterRegistry,
  CLAUDE_CMD, CODEX_CMD, CODEX_LINUX_SANDBOX_CMD, CODEX_SANDBOX_SUPPORTED,
  CLAUDE_SUBSCRIPTION_LOGIN_HELPER, CLAUDE_SUPPORTS_NAME, PERMISSION_MODES,
  EFFORT_LEVELS, CLAUDE_MODEL_ALIASES, CLAUDE_KNOWN_MODELS, AVAILABLE_MODELS,
  noteModelSeen, refreshAvailableModels, harnessAvailability, noteHarnessModels,
} = require('./src/server/cli-env.js').create({
  rootDir: __dirname, CLAUDE_CMD_RAW, CODEX_CMD_RAW, resolveCmd,
  getOAuthToken: (...a) => getOAuthToken(...a),
  usagePollingEnabled: (...a) => usagePollingEnabled(...a),
  refreshCodexModels: (...a) => refreshCodexModels(...a), broadcast: (m) => bcastAll(m), getTelemetry: () => { try { return telemetry; } catch { return null; } }, getPlugins: () => { try { return plugins; } catch { return null; } }, // S9: opencode serve caps verdict → 'harness-caps-updated'; runaway telemetry + the 'opencode-serve' PLUGIN is the autostart switch (lazy — both defined below)
});
// ── Codex model list (from ~/.codex/models_cache.json) ──
// That cache is last-writer-wins AND version-gated server-side: a still-running
// OLD codex CLI re-fetches it and writes it back WITHOUT newer models (observed
// live TWICE: a 0.142.5 session erased the gpt-5.6 entries minutes after
// 0.144.0 fetched them — and once it happened right before a server restart,
// leaving the dropdown stale for the whole hourly re-read cycle). Two guards:
// (1) union every model ever seen, PERSISTED across restarts;
// (2) mtime-guarded re-read ON DEMAND from /api/available-models — the model/
//     effort dropdowns fetch per click, so they're always current, no timers.
const CODEX_MODELS_SEEN_FILE = path.join(__dirname, 'data', 'codex-models-seen.json');
const _codexModelsSeen = new Map();
try { for (const m of JSON.parse(fs.readFileSync(CODEX_MODELS_SEEN_FILE, 'utf-8'))) if (m && m.id) _codexModelsSeen.set(m.id, m); } catch {}
if (_codexModelsSeen.size) AVAILABLE_MODELS.codex = [{ id: '', label: 'Default' }, ..._codexModelsSeen.values()];
let _codexCacheMtime = 0;
function refreshCodexModels() {
  try {
    const fp = path.join(os.homedir(), '.codex', 'models_cache.json');
    const mt = fs.statSync(fp).mtimeMs;
    if (mt === _codexCacheMtime) return;
    _codexCacheMtime = mt;
    const codexCache = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!codexCache.models?.length) return;
    const fresh = codexCache.models.map(m => {
      const ctx = m.context_window ? (m.context_window >= 1000000 ? Math.round(m.context_window / 1000000) + 'M' : Math.round(m.context_window / 1000) + 'k') : '';
      // Per-model reasoning levels ride along: GPT-5.6 made efforts
      // model-specific (sol/terra add max+ultra, luna tops out at max) —
      // clients derive dropdowns from this instead of a stale hardcoded list. Plus multiAgentEffort (2.369.62) = the level a DELEGATING effort really reasons at ('ultra' is a mode, not a level); '' = the catalog names none ⇒ the label stays a bare "ultra", never a hardcoded one (kb agent-meta.js).
      return { id: m.slug, label: (m.display_name || m.slug) + (ctx ? ` (${ctx})` : ''), efforts: (m.supported_reasoning_levels || []).map(l => l && l.effort).filter(Boolean), multiAgentEffort: m.multi_agent_reasoning_effort || '' };
    }).filter(m => m.id);
    let changed = false;
    for (const m of fresh) {
      const prev = _codexModelsSeen.get(m.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) { _codexModelsSeen.set(m.id, m); changed = true; }
    }
    AVAILABLE_MODELS.codex = [{ id: '', label: 'Default' }, ..._codexModelsSeen.values()];
    if (changed) {
      try {
        const tmp = CODEX_MODELS_SEEN_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify([..._codexModelsSeen.values()]));
        fs.renameSync(tmp, CODEX_MODELS_SEEN_FILE);
      } catch {}
    }
  } catch {}
}
refreshCodexModels();
setTimeout(refreshAvailableModels, 3000);
setInterval(refreshAvailableModels, 3600000); // refresh hourly

const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

// ── Optional password auth (VIBESPACE_PASSWORD env / data/auth.json) +
//    optional Clerk SSO (VIBESPACE_CLERK_PUBLISHABLE_KEY — src/clerk-auth.js) ──
const { Auth } = require('./src/auth');
const { ClerkAuth } = require('./src/clerk-auth');
const clerkAuth = new ClerkAuth();
const auth = new Auth(path.join(__dirname, 'data'), { clerk: clerkAuth });
{
  const { generated } = auth.ensurePassword({ generateIfMissing: process.env.VIBESPACE_GENERATE_PASSWORD === '1' });
  if (generated) {
    console.log('\n  ╔════════════════════════════════════════════════╗');
    console.log(`  ║  Generated workspace password: ${generated.padEnd(15)} ║`);
    console.log('  ║  (persisted in data/auth.json — set             ║');
    console.log('  ║   VIBESPACE_PASSWORD to choose your own)        ║');
    console.log('  ╚════════════════════════════════════════════════╝\n');
  }
  if (auth.passwordEnabled) console.log('  Password auth: ENABLED');
  if (clerkAuth.enabled) console.log(`  Clerk SSO: ENABLED (${clerkAuth.frontendApi})`);
  // getter — auth can be enabled/disabled at runtime via /api/auth/set-password
  Object.defineProperty(app.locals, 'authEnabled', { get: () => auth.enabled });
  Object.defineProperty(app.locals, 'ssoEnabled', { get: () => auth.ssoEnabled });
}

// noServer + ONE manual upgrade dispatcher (registered at the bottom of this
// file): ws's own {server, path} listener calls handleUpgrade UNCONDITIONALLY
// and abortHandshake(400)s every non-matching path — it was killing /proxy/
// WebSockets silently and the /api/vnc bridge on arrival. Auth happens in the
// dispatcher (cookie token, same as HTTP).
const wss = new WebSocketServer({ noServer: true });

app.use(compression());
// HTTP latency observation (names-and-numbers only): rolling 5-min window
// flushed by the metrics sampler; slow requests (>1.5s) recorded as events
// with the SANITIZED route (first 3 path segments — /api/file/serve/* etc.
// carry user paths that must never enter the ledger).
const _httpWin = { n: 0, sum: 0, max: 0, slow: [] };
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    _httpWin.n++; _httpWin.sum += ms; if (ms > _httpWin.max) _httpWin.max = ms;
    if (ms > 1500 && _httpWin.slow.length < 20) {
      _httpWin.slow.push({ route: req.path.split('/').slice(0, 4).join('/') || '/', ms: Math.round(ms) });
    }
  });
  next();
});
auth.registerRoutes(app);
app.use(auth.middleware());
// Serve index.html with cache-busting query params on every local js/css asset
// (?v=<mtime>). Browsers serve unversioned <script>/<link> from memory cache on
// a soft reload without revalidating, so users were stuck on a stale bundle
// after an update until a hard refresh. Versioning the URL forces a fresh fetch
// whenever the file changes — no hard refresh ever needed.
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    const pub = path.join(__dirname, 'public');
    let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf-8');
    html = html.replace(/(href|src)="\/([^"?]+\.(?:js|css))"/g, (m, attr, file) => {
      try { return `${attr}="/${file}?v=${Math.floor(fs.statSync(path.join(pub, file)).mtimeMs)}"`; }
      catch { return m; }
    });
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch { next(); }
});
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, maxAge: 0 }));
// WebDAV bridge — BEFORE the json body parser (PUT bodies stream to disk).
// Auth = scoped Bearer mount tokens; see src/webdav.js for the security model.
const { MountTokens, registerWebdav } = require('./src/webdav');
const mountTokens = new MountTokens({ dataDir: path.join(__dirname, 'data') });
registerWebdav(app, { tokens: mountTokens });
// Proxied requests must reach unblocker with their body UNREAD — express.json
// consuming a proxied JSON POST forwarded a body-less request that hung the
// target on Content-Length (inc-mt2bpw2f: page rendered, every button dead).
// Skip here rather than mount unblocker earlier: auth must keep covering /proxy/.
const jsonBody = express.json({ limit: '50mb' });
app.use((req, res, next) => (req.path.startsWith('/proxy/') ? next() : jsonBody(req, res, next)));

app.get('/xterm.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'));
});

// ── Active session tracking (dtach-backed for persistence across server restarts) ──
// dtach is a minimal PTY detach/attach tool — no rendering layer, no mouse interception.
// Claude processes get raw PTY I/O identical to a native terminal.
const activeSessions = new Map();
// B-3f8a: account ids that have a RUNNING session — the merge/creds-rewrite
// guard consults this so a subscription merge never rewrites/removes a creds
// dir under a live session (the CLI re-reads creds per request, mid-turn).
const liveAccountIdSet = () => {
  const s = new Set();
  for (const sess of activeSessions.values()) if (sess?._accountId) s.add(sess._accountId);
  return s;
};
const sessionCounterRef = { value: 0 };
const SOCKETS_DIR = path.join(__dirname, 'data', 'sockets');
const META_DIR = path.join(__dirname, 'data', 'session-meta');
const BUFFERS_DIR = path.join(__dirname, 'data', 'session-buffers');

// ── HOME-RENAME MIGRATION (B-b4a2, one-shot at boot) ────────────────────────
// The 3.5.0 fleet image personalizes the container user, so $HOME moves (e.g.
// /home/vibe → /home/userL) while the PVC keeps everything recorded under
// the OLD path: ~/.claude/projects dirs encode the old cwd (claude's resume
// lookup goes by CURRENT-cwd encoding → every resume died "No conversation
// found"), and mounts/layouts/session metas hold dead /home/vibe/... paths.
// This repeats for EVERY user on EVERY such roll (userL needed manual
// surgery) — migrate automatically: rename projdirs to the new encoding and
// prefix-rewrite recorded paths. One-shot per (oldUser→newUser) marker.
function migrateHomeRename() {
  try {
    const home = os.homedir();
    const user = path.basename(home);
    const projectsDir = path.join(home, '.claude', 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(projectsDir); } catch { return; }
    // Detect the old username from leftover projdirs: -home-<old>-… where
    // <old> ≠ current user and /home/<old> no longer exists.
    const oldUsers = new Set();
    for (const d of dirs) {
      const m = /^-home-([a-z][a-z0-9]*)-/.exec(d);
      if (m && m[1] !== user && !fs.existsSync(`/home/${m[1]}`)) oldUsers.add(m[1]);
    }
    for (const old of oldUsers) {
      const marker = path.join(__dirname, 'data', `.home-migrated-${old}-to-${user}`);
      if (fs.existsSync(marker)) continue;
      console.log(`[migrate] home rename detected: /home/${old} → ${home} — migrating projdirs + recorded paths`);
      let moved = 0;
      for (const d of fs.readdirSync(projectsDir)) {
        if (!d.startsWith(`-home-${old}-`)) continue;
        const nd = `-home-${user}-` + d.slice(`-home-${old}-`.length);
        const src = path.join(projectsDir, d), dst = path.join(projectsDir, nd);
        try {
          if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved++; }
          else { // merge, never overwrite (both sides may hold transcripts)
            for (const f of fs.readdirSync(src)) {
              if (!fs.existsSync(path.join(dst, f))) fs.renameSync(path.join(src, f), path.join(dst, f));
            }
            try { fs.rmdirSync(src); } catch { }
            moved++;
          }
        } catch (e) { console.warn(`[migrate] projdir ${d}: ${e.message}`); }
      }
      // Prefix-rewrite every recorded string path in the small JSON stores.
      const rewrite = (v) => (typeof v === 'string' && v.includes(`/home/${old}/`))
        ? v.split(`/home/${old}/`).join(`/home/${user}/`)
        : (typeof v === 'string' && v === `/home/${old}`) ? `/home/${user}` : v;
      const walk = (x) => {
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === 'object') { for (const k of Object.keys(x)) x[k] = walk(x[k]); return x; }
        return rewrite(x);
      };
      const stores = [path.join(__dirname, 'data', 'mounts.json'), path.join(__dirname, 'data', 'layouts.json'),
        path.join(__dirname, 'data', 'task-groups.json'), path.join(__dirname, 'data', 'machine-mounts.json')];
      try { for (const f of fs.readdirSync(META_DIR)) stores.push(path.join(META_DIR, f)); } catch { }
      let rewrote = 0;
      for (const f of stores) {
        try {
          if (!fs.existsSync(f)) continue;
          const raw = fs.readFileSync(f, 'utf-8');
          if (!raw.includes(`/home/${old}`)) continue;
          const fixed = JSON.stringify(walk(JSON.parse(raw)));
          fs.writeFileSync(f + '.pre-home-migrate', raw); // one-shot backup beside it
          const tmp = f + '.tmp'; fs.writeFileSync(tmp, fixed); fs.renameSync(tmp, f);
          rewrote++;
        } catch (e) { console.warn(`[migrate] ${path.basename(f)}: ${e.message}`); }
      }
      fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), moved, rewrote }));
      console.log(`[migrate] home rename done: ${moved} projdirs, ${rewrote} stores rewritten (backups *.pre-home-migrate)`);
    }
  } catch (e) { console.warn('[migrate] home-rename check failed:', e.message); }
}
migrateHomeRename();
const USAGE_CACHE_FILE = path.join(__dirname, 'data', 'usage-cache.json');
// Per-account PASSIVE usage capture (written by data/bin/vibespace-usage, the
// statusLine hook). Key '__global__' = the machine's own login; 'sub-…' = a
// named subscription. This is the ONLY usage source now — VibeSpace makes NO
// background /api/oauth/usage calls with subscription tokens (that off-CLI
// automated pattern is what gets Max/Pro accounts banned; see §ban-safety).
const USAGE_CACHE_DIR = path.join(__dirname, 'data', 'usage-cache');
const USAGE_SCANNER_PATH = path.join(__dirname, 'data', 'bin', 'vibespace-usage-scan');
const PTY_WRAPPER = path.join(__dirname, 'data', 'bin', 'pty-wrapper.js');

// ── CS refactor M1 (opt-in, default OFF): route LOCAL terminal sessions
// through the standing vibespace-agentd daemon. deviceMgr stays null unless
// the local device daemon is ALWAYS on since the 2.175.0 graduation —
// instantiates it, never spawns a daemon, and attachToDtach is byte-identical
// to today. daemonPtyShim presents the node-pty interface over a device
// session handle so setupSessionPty is unchanged.
let deviceMgr = null;
// ── M2 host-level agentd provisioning (always on since the 2.175.0 flag graduation) ──
// Per-host vsht_ token: plaintext in a 0600 local file (the attach bridge
// reads it at spawn; never argv), sha256 recorded alongside for audit.
const AGENTD_DIR = path.join(__dirname, 'data', 'agentd');
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function agentdHostToken(hostId) {
  ensureDir(AGENTD_DIR);
  const f = path.join(AGENTD_DIR, 'host-' + hostId + '.token');
  try { return fs.readFileSync(f, 'utf-8').trim(); } catch { }
  const tok = 'vsht_' + require('crypto').randomBytes(24).toString('hex');
  fs.writeFileSync(f, tok, { mode: 0o600 });
  return tok;
}
// Install/refresh the daemon on a host, throttled per boot+version: a marker
// records the last version shipped; matching = skip (one ssh round trip saved
// per spawn; a bundle change reinstalls because the version bumps with it).
// ── Dial pairing primitives (src/server/dial-pairing.js, decomposition #13) ──
const { CHAT_WRAPPER, agentdDialDevices, agentdDials,
  agentdMintDialPair, daemonPtyShim, deviceForDial, ensureAgentdOnHost,
  unpairDialDevice,
} = require('./src/server/dial-pairing.js').create({
  rootDir: __dirname, AGENTD_DIR,
  agentdHostToken: (...a) => agentdHostToken(...a),
  getHosts: () => { try { return hosts; } catch { return null; } },
  getMounts: () => { try { return mounts; } catch { return null; } },
  getMachineMounts: () => { try { return machineMounts; } catch { return null; } },
  getPortForwards: () => { try { return portForwards; } catch { return null; } },
  getExitProxy: () => { try { return exitProxy; } catch { return null; } },
});
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
// Top-level stream-json record types this server KNOWS (2.227.8 breadcrumb).
// Add a type here when you add its handling — until then it announces itself.
const CLAUDE_STREAM_TYPES = new Set([
  'assistant', 'user', 'system', 'result', 'attachment', 'control_request',
  'control_response', 'tool_progress', 'stream_event', 'summary',
  'rate_limit_event', // handled since 2.289.0 — the set lagged the handler, so the breadcrumb cried 'unhandled' for a handled type (misled the inc-msozeyw2 read)
  '_stdin_ack', '_remote_state', '_remote_exit',
]);
const _seenStreamTypes = new Set();

function broadcastToSession(session, id, msg) {
  const json = JSON.stringify(msg);
  for (const client of session.clients.keys()) {
    if (client.readyState === WS_OPEN) { try { client.send(json); } catch {} }
  }
}

// ── Usage + pool engine (src/server/usage-pool-engine.js, decomposition #5) ──
const {
  _vsuPending, usageAnchors, usageEstimator,
  armWorkflowUsageWatcher, darkSources, darkTaintedAccounts, kickPoolEval,
  markLimitBanner, maybePoolAutoSwitch, maybePoolAutoSwitchForPool, notePoolAuthFailure,
  maybeRepinLockedModel, maybeStopOnFallback, modelsMatch,
  poolChooserForModel, poolReadCache, probeUsageForAccountKey,
  noteSessionProduced, noteTurnEnd, noteWallSignal, beforeAutoResumeFire, fireIdentityFor, probeUsageViaSession, recordCodexQuotaSignal, recordRateLimitEvent, resolveUsageKey,
  sessionModelFor, sweepUsageAnchors, usageCacheKeyFor,
  usageIdentityAccountIds, usageIdentityGroups, usageIdentityGroupsCached,
  writeUsageCacheForKey, clearSealedOrders, pushSealedOrders,
  estOverlayCache, predictCalib,
} = require('./src/server/usage-pool-engine.js').create({
  app, rootDir: __dirname, USAGE_CACHE_DIR, activeSessions, wss, WS_OPEN,
  broadcastToSession, getAutoResume: () => { try { return autoResume; } catch { return null; } }, getOtelIngest: () => { try { return otelIngest; } catch { return null; } }, getQuotaProbe: () => { try { return usage.refreshViaCliPanel; } catch { return null; } }, // both lazy: created further down (TDZ otherwise); otelIngest = B-b3cd org verification
  serverNotice: (...a) => serverNotice(...a),
  serverSetting: (...a) => serverSetting(...a),
  getAccounts: () => { try { return accounts; } catch { return null; } },
  getHosts: () => { try { return hosts; } catch { return null; } },
  getUsageHistory: () => { try { return usageHistory; } catch { return null; } },
  recordUsageAttribution: (...a) => recordUsageAttribution(...a),
  adapterRegistry,
});
// ── Effective-size computation (min cols/rows across clients + PTY resize + broadcast) ──
// Only clients that have sent a REAL `resize` (terminal fit) drive the PTY
// size. Two classes of entries must NOT shrink it:
//  - viewer:true  → subagent View Log windows attach to the PARENT session's
//    clients map purely to receive broadcasts; they have no terminal.
//  - placeholder (no `real` flag) → the 120×30 default set at attach time,
//    before the client's first fit(). A reconnecting/ghost client sitting at
//    this placeholder used to win the min and shrink everyone's terminal.
function resizeSessionToMin(session, sessionId) {
  if (!session.clients.size || !session.pty) return;
  let minCols = Infinity, minRows = Infinity, realCount = 0;
  for (const sz of session.clients.values()) {
    if (sz.viewer || !sz.real) continue;
    realCount++;
    if (sz.cols < minCols) minCols = sz.cols;
    if (sz.rows < minRows) minRows = sz.rows;
  }
  // No real terminal client yet (e.g. chat sessions never fit) — fall back to
  // non-viewer placeholders so chat PTYs still get a sane width, but never let
  // a viewer entry participate.
  if (!realCount) {
    for (const sz of session.clients.values()) {
      if (sz.viewer) continue;
      if (sz.cols < minCols) minCols = sz.cols;
      if (sz.rows < minRows) minRows = sz.rows;
    }
  }
  // Size override ("take over"): one client forces the PTY to ITS size instead
  // of the min — e.g. working from a big screen while a small window at home
  // stays attached. Smaller clients block their view behind a "Resume here"
  // overlay. Ownership follows the owner's live resizes and evaporates when the
  // owner disconnects (its clients-map entry disappears → back to min policy).
  let cols = minCols, rows = minRows, override = false;
  const ownerSz = session._sizeOwnerWs ? session.clients.get(session._sizeOwnerWs) : null;
  if (ownerSz && ownerSz.real && !ownerSz.viewer) {
    cols = ownerSz.cols; rows = ownerSz.rows; override = true;
  } else if (session._sizeOwnerWs) {
    session._sizeOwnerWs = null; // owner gone — min policy again
  }
  if (cols < Infinity && rows < Infinity) {
    try { session.pty.resize(cols, rows); } catch {}
    // clients: real terminal count — lets the UI say "limited by a smaller
    // client" (tmux-style boundary) only when someone else is actually attached
    broadcastToSession(session, sessionId, { type: 'effective-size', sessionId, cols, rows, clients: realCount, override });
  }
}

// ── Native goal status sync (src/server/goal-sync.js) ──
const { checkClaudeGoalStatus } = require('./src/server/goal-sync.js').create({
  hosts: { get fetchSessionJsonl() { return hosts.fetchSessionJsonl.bind(hosts); } }, // lazy — hosts is created later in boot order
  broadcastToSession,
  findSessionJsonlPath: (...a) => findSessionJsonlPath(...a),
});
// ── Session stdout engine (src/server/session-stdout.js, decomposition #6) ──
// setupSessionPty + attachToDtach + the session-meta store.
const { setupSessionPty, attachToDtach, readSessionMeta, writeSessionMeta,
  deleteSessionMeta, sessionMetaOwnerConflict, _metaTombstones,
  applyTaskToolUpdate, emitTaskListTodos, updateSessionTodos,
} = require('./src/server/session-stdout.js').create({
  rootDir: __dirname, BUFFERS_DIR, META_DIR, DTACH_CMD, USAGE_SCANNER_PATH,
  CLAUDE_STREAM_TYPES, _seenStreamTypes, activeSessions,
  engine: { _vsuPending, armWorkflowUsageWatcher, kickPoolEval, markLimitBanner,
    maybePoolAutoSwitch, maybeRepinLockedModel, maybeStopOnFallback, notePoolAuthFailure,
    modelsMatch, noteSessionProduced, noteTurnEnd, noteWallSignal, recordCodexQuotaSignal, recordRateLimitEvent, resolveUsageKey, usageEstimator },
  checkClaudeGoalStatus,
  broadcastToSession,
  broadcastActiveSessions: (...a) => broadcastActiveSessions(...a),
  noteModelSeen: (...a) => noteModelSeen(...a),
  noteHarnessModels: (...a) => noteHarnessModels(...a), // ACP harnesses learn their model list from the agent (S8)
  recordUsageAttribution: (...a) => recordUsageAttribution(...a),
  daemonPtyShim: (...a) => daemonPtyShim(...a),
  sbSeenFirst: (...a) => sbSeenFirst(...a),
  getDeviceMgr: () => deviceMgr,
  getHosts: () => { try { return hosts; } catch { return null; } },
  getUsageHistory: () => { try { return usageHistory; } catch { return null; } },
  getTelemetry: () => { try { return telemetry; } catch { return null; } },
  getNoConvoRef: () => { try { return noConvoRef; } catch { return null; } }, getDeliver: () => { try { return deliver; } catch { return null; } },
});
// ── Boot restore (src/server/boot-restore.js, decomposition #7) ──
// migrations + restoreSessions + R6 pipe re-open + keeper re-adoption.
const { migrateLegacyHomeProjects, restoreSessions, restoreAgentdPipeSessions,
  readoptOrphanKeeperSessions,
} = require('./src/server/boot-restore.js').create({
  rootDir: __dirname, PORT, BUFFERS_DIR, META_DIR, SOCKETS_DIR, DTACH_CMD,
  ENV_CMD, NODE_CMD, CHAT_WRAPPER, activeSessions, sessionCounterRef,
  attachToDtach, setupSessionPty, readSessionMeta, writeSessionMeta,
  deleteSessionMeta, broadcastToSession,
  broadcastActiveSessions: (...a) => broadcastActiveSessions(...a),
  refreshWebuiPids: (...a) => refreshWebuiPids(...a),
  sbNoteServerOp: (...a) => sbNoteServerOp(...a),
  getHosts: () => { try { return hosts; } catch { return null; } },
  getDialBridge: () => { try { return dialBridge; } catch { return null; } },
});
// ── Agent-tool generators + hook registration (src/server/agent-tool-generators.js) ──
const {
  AGENT_BIN_DIR, EDITOR_DIR, EDITOR_CMD, STATUS_CMD, USAGE_STATUSLINE_CMD, HOOK_CMD,
  createEditorHelper, createStatusHelper, createHookHelper, userStatuslineCmd,
  ensureAgentHooks, stripAgentHookEntries, removeAgentHooks, hookRegistrationSafe,
  agentHooksStatus, HOOK_OPTOUT_FILE,
} = require('./src/server/agent-tool-generators.js').create({ rootDir: __dirname, port: PORT });
// Generic operator-visible notice channel (2.226.0, user directive "不要静默
// 失败"): server-side probes report through this instead of dying in the log —
// every connected client toasts it (+ it lands in toast/notification history)
// and a telemetry event carries the key to the fleet collector. Key-deduped
// per boot so a recurring probe can't spam.
const _sentNotices = new Set();
function serverNotice(key, text, { level = 1 } = {}) {
  if (_sentNotices.has(key)) return;
  console.warn('[notice]', text);
  global.__vsEvent?.('server-notice', key);
  let delivered = 0;
  try {
    const payload = JSON.stringify({ type: 'server-notice', key, text, level });
    for (const c of wss.clients) { try { if (c.readyState === WS_OPEN) { c.send(payload); delivered++; } } catch {} }
  } catch {}
  // No client connected (e.g. the 60s post-boot probe right after a pod
  // restart) → don't burn the key; the next probe run re-notices when
  // someone is actually there to see it (review finding).
  if (delivered > 0) _sentNotices.add(key);
}
// Agent-hook health probe (2.226.0; born from the 2-day silent MODULE_NOT_FOUND
// outage whose CAUSE 2.225.1 fixed): a registration that goes stale or points
// at a missing script MID-RUN now self-heals + notifies instead of silently
// dropping every Stop/SessionStart/UserPromptSubmit delivery. Boot(+60s) +
// every 6h. NOTE the heal only fixes the FILE — running CLI sessions snapshot
// hook config and pick it up after restart/compaction; the notice says so.
function checkAgentHookHealth() {
  try {
    if (!hookRegistrationSafe() || !integrationEnabled() || fs.existsSync(HOOK_OPTOUT_FILE)) return;
    const scriptMissing = !fs.existsSync(HOOK_CMD);
    if (scriptMissing) { try { createHookHelper(); } catch {} }
    const st = agentHooksStatus();
    for (const [key, info] of Object.entries(st)) {
      if (!info || typeof info !== 'object' || !('installed' in info)) continue; // hookPath/optedOut fields
      if (!info.fileExists || info.parseError) continue; // that CLI isn't set up here / unreadable
      if (info.stale || !info.installed || scriptMissing) {
        global.__vsEvent?.('agent-hook-broken', `${key}${info.stale ? '/stale' : ''}${!info.installed ? '/missing-entry' : ''}${scriptMissing ? '/script-missing' : ''}`);
        ensureAgentHooks({ auto: true }); // self-heal the registration in place
        serverNotice(`hook-health-${key}`,
          `VibeSpace's ${key} agent-hook registration was broken (stale or missing path) and has been repaired — CLI sessions already running pick the fix up only after they restart or compact.`,
          { level: 2 });
      }
    }
  } catch (e) { console.warn('[hook-health] probe failed:', e.message); }
}

// Long-lived-token expiry sweep (B-211a): setup-token tokens live exactly 1
// year and a 401 has NO self-heal — warn while there's still time to re-mint.
// Once per boot, notice-deduped per account.
function checkOatExpiry() {
  try {
    for (const a of accounts.list().accounts) {
      if (!a.oat || typeof a.oatDaysLeft !== 'number') continue;
      if (a.oatDaysLeft <= 0) {
        serverNotice(`oat-expired-${a.id}`, `The long-lived token for "${a.name}" has EXPIRED — sessions using it will fail until you re-mint one (Manage agents → the account's ⋯ menu → Long-lived token).`, { level: 2 });
      } else if (a.oatDaysLeft <= 21) {
        serverNotice(`oat-expiring-${a.id}`, `The long-lived token for "${a.name}" expires in ${a.oatDaysLeft} days — re-mint it soon (Manage agents → ⋯ → Long-lived token).`, { level: 2 });
      }
    }
  } catch { }
}
setTimeout(checkOatExpiry, 20000);
setInterval(checkOatExpiry, 6 * 3600e3); // stable instances stay up for weeks — a one-shot sweep would sail past the threshold (serverNotice keys dedupe per boot, so re-fires are cheap)
// Boot-time hook registration is DEFERRED until settings are readable (after
// setupPersistence below) — the Integration master switch decides whether we
// register or actively strip. See "Agent-hook boot registration".

// ── File System API (extracted to src/routes/files.js) ──
app.locals.xEnv = X_ENV;
app.locals.refreshXEnv = refreshXEnv; // paste route retries through this after an X cookie rotation
app.locals.activeSessions = activeSessions; // paste-image resolves a session's host server-side (B-65ec)
// Remote fs (Files cross-host) — resolved lazily; `hosts` is created below.
app.locals.getRemoteFs = () => remoteFs;
// ── SafeFs: dedicated worker_threads pool for LOCAL user-path fs ops ──
// STRUCTURAL isolation for the hung-mount class (complements the tactical
// canary/watchdog/circuit-breaker + UV_THREADPOOL_SIZE=32 above): every local
// file-route fs call runs on a worker's own thread with a per-op deadline and
// kill-and-respawn, so a wedged mount can never again saturate the shared libuv
// pool and freeze /login. path.resolve/permission decisions stay in-main; the
// worker only executes the already-resolved absolute path. mounts.pathBlocked
// still fails known-hung roots fast in the route middleware BEFORE dispatch.
try {
  app.locals.safeFs = new SafeFs({
    poolSize: parseInt(process.env.VIBESPACE_SAFEFS_POOL || '', 10) || 4,
  });
  console.log(`[safe-fs] worker pool up (${app.locals.safeFs.poolSize} workers)`);
} catch (e) {
  console.error('[safe-fs] pool init failed, file ops fall back to in-main fs:', e.message);
}
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

// Editor: open request from the `code` helper script (via HTTP, not terminal
// output). The caller lives INSIDE the session shell — no cookie exists there,
// so auth.middleware exempts this path and WE validate the per-session vsst_
// token instead (same trust model as /api/agent/*). Without this, enabling
// password auth silently broke Ctrl+G: the script's POST got 401 and claude
// sat on "Save and close editor to continue…" forever.
app.post('/api/editor/open', (req, res) => {
  if (app.locals.authEnabled) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let ok = false;
    if (token && token.startsWith('vsst_')) {
      for (const [, s] of activeSessions) { if (s.agentToken === token) { ok = true; break; } }
    }
    if (!ok) return res.status(401).json({ error: 'unauthorized (session token required)' });
  }
  const { file, signal, sessionId } = req.body;
  // Remote Ctrl+G (B-2de8): the POST came from the fake `code` helper running
  // ON THE HOST (over the reverse tunnel) — the tmpfile + signal file live
  // there. Resolve the session's host server-side and ship it in the
  // broadcast so the client editor reads/writes/signals the right machine.
  const editorHost = (sessionId && activeSessions.get(sessionId)?.host) || null;
  // Persist the pending edit on the session + its meta: the helper script
  // waits FOREVER on the signal file while claude shows "Save and close
  // editor to continue…" — a server restart + page reload (or pod recreation
  // for remote sessions, whose helper+claude survive on the host) otherwise
  // loses the only record of it and the session silently hangs mid-turn.
  // Cleared by /api/editor/signal; re-broadcast on terminal attach.
  if (sessionId && activeSessions.has(sessionId)) {
    const s = activeSessions.get(sessionId);
    s._pendingEditor = { filePath: file, signalPath: signal, host: editorHost, at: Date.now() };
    try { if (s.sockName) writeSessionMeta(s.sockName, { ...(readSessionMeta(s.sockName) || {}), pendingEditor: s._pendingEditor }); } catch {}
  }
  // Broadcast to all WebSocket clients — include sessionId so each client opens editor on the right window
  const msg = JSON.stringify({ type: 'editor-open', filePath: file, signalPath: signal, sessionId: sessionId || null, host: editorHost });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) {
      try { client.send(msg); } catch {}
    }
  });
  res.json({ success: true });
});

// Editor: signal completion (called by client when user saves/closes editor)
app.post('/api/editor/signal', async (req, res) => {
  const { signalPath, filePath, content, host } = req.body;
  try {
    if (host && remoteFs) {
      // remote Ctrl+G: the CLI polls the signal file ON ITS machine
      if (content !== undefined) await remoteFs.write(String(host), filePath, Buffer.from(content));
      await remoteFs.write(String(host), signalPath, Buffer.from('done'));
    } else {
      if (content !== undefined) fs.writeFileSync(filePath, content);
      fs.writeFileSync(signalPath, 'done');
    }
    // The edit is settled — drop the persisted pending-editor record so a
    // later restart/attach doesn't re-open a dead pane
    for (const [, s] of activeSessions) {
      if (s._pendingEditor?.signalPath === signalPath) {
        s._pendingEditor = null;
        try { if (s.sockName) writeSessionMeta(s.sockName, { ...(readSessionMeta(s.sockName) || {}), pendingEditor: null }); } catch {}
      }
    }
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
// THE server-side settings reader (data/settings.json via persistence.js's
// cached accessor). getSyncStore('settings') is NOT it — that SyncStore is an
// empty migration target; reads through it silently return undefined.
function serverSetting(key) {
  try { return persistenceRouter.readSettings ? persistenceRouter.readSettings()[key] : undefined; } catch { return undefined; }
}
// Integration master switch (agents.vibespaceIntegration, default ON): OFF =
// pristine CLI — no hook registration, no VIBESPACE_API/agent-tools env in new
// spawns, no context/nudge delivery even to already-running sessions. THE one
// definition — threaded into ws-handler and agent-routes via their deps.
function integrationEnabled() {
  try { return serverSetting('agents.vibespaceIntegration') !== false; } catch { return true; }
}
// ONE convergence rule for boot AND the live toggle: hook registration follows
// the master switch. ensureAgentHooks({auto:true}) still honors the manual
// data/.agent-hooks-optout marker (Manage-Agents Remove) — the switch never
// overrides that narrower explicit choice; Install there clears it.
function syncHookRegistration() {
  try {
    if (integrationEnabled()) ensureAgentHooks({ auto: true });
    else stripAgentHookEntries();
  } catch (e) { console.warn('[integration] hook registration sync failed:', e.message); }
}

syncStores.drafts = new SyncStore('drafts', path.join(__dirname, 'data', 'drafts.json'), wss);
syncStores.settings = new SyncStore('settings', path.join(__dirname, 'data', 'settings-sync.json'), wss);
syncStores.uploads = new SyncStore('uploads', path.join(__dirname, 'data', 'uploads-sync.json'), wss);
syncStores.stage = new SyncStore('stage', path.join(__dirname, 'data', 'stage-sync.json'), wss); // dynamic desktop (docs/design-dynamic-desktop.md)

setupPersistence({ dataDir: path.join(__dirname, 'data'), wss, WS_OPEN, getSyncStore, activeSessions, auth,
  getHosts: () => hosts, getMounts: () => mounts, getTasks: () => tasks,
  getAccounts: () => accounts, getUsageHistory: () => usageHistory,
  // React server-side to the Integration master switch: register/strip the
  // CLI-config hook entries the moment the setting flips (the only settings
  // key with a server-side side effect — everything else reads lazily).
  onSettingsWrite: (next, prev) => {
    const was = (prev || {})['agents.vibespaceIntegration'] !== false;
    const now = (next || {})['agents.vibespaceIntegration'] !== false;
    if (was !== now) syncHookRegistration();
    // claude.disableModelFallback flips LIVE sessions too ("动态对对话进行调整"):
    // apply_flag_settings merges switchModelsOnFlag into the CLI's inline
    // flag-settings layer, effective from the next turn. Local and remote
    // chat sessions alike (the control_request rides the same stdin channel
    // as set_model). Sessions spawned after the flip get it at spawn instead.
    const fbWas = (prev || {})['claude.disableModelFallback'] === true;
    const fbNow = (next || {})['claude.disableModelFallback'] === true;
    if (fbWas !== fbNow) {
      for (const [sid, sess] of activeSessions) {
        if (sess.backend !== 'claude' || sess.mode !== 'chat' || !sess.pty) continue;
        try {
          const ad = adapterRegistry.get('claude');
          if (ad?.formatSetFallbackPolicy) sess.pty.write(ad.formatSetFallbackPolicy(fbNow) + '\n');
        } catch (e) { console.warn(`[fallback-policy] ${sid}: ${e.message}`); }
      }
    }
  } });
app.use(persistenceRouter);
// ── Agent-hook boot registration (deferred from the hook-machinery block so
// the Integration master switch is readable) — a toggle flipped just before a
// restart, or an imported config bundle carrying it, converges here.
syncHookRegistration();
// Health probe: catches MID-RUN poisoning (the 2.225.1 incident class) that
// boot-time registration can't — self-heals + notifies. 60s in, then 6h.
setTimeout(checkAgentHookHealth, 60000).unref();
setInterval(checkAgentHookHealth, 6 * 3600 * 1000).unref();

// ── Task Groups (岗位; task system — docs/design-task-system.md + refactor) ──
// data/task-groups.json is AUTHORITATIVE for everything the board renders (the
// store migrates the legacy data/tasks.json forward once). The one-time legacy
// Groups migration (sessionGroups/groupFolders) runs in the constructor.
const { TaskGroupManager } = require('./src/task-groups');
const tasks = new TaskGroupManager({
  dataDir: path.join(__dirname, 'data'),
  readUserState: () => persistenceRouter.readUserState(),
  getSetting: (k) => serverSetting(k), isPathShadowed: (p) => { try { return mounts.shadowedBy(p); } catch { return null; } },
  onChange: (list) => {
    const json = JSON.stringify({ type: 'tasks-updated', tasks: list });
    wss.clients.forEach(c => { if (c.readyState === WS_OPEN) { try { c.send(json); } catch {} } });
  },
});
// System info + memory-pressure watch (2.216.0, userL's 32Gi OOM kill —
// the pod-level kill takes every dtach session; warn BEFORE the kernel acts)
// ── Sysinfo wiring (src/server/sysinfo-wiring.js): remote snapshot ladder ──
const { sysinfo, remoteSysinfo, remoteProcs, signalProc } = require('./src/server/sysinfo-wiring.js').create({ getHosts: () => hosts });
// ── Incident capture (src/server/incident-wiring.js) ──
const { _srvConsoleRing } = require('./src/server/incident-wiring.js').create({
  app, rootDir: __dirname,
  getActiveSessions: () => activeSessions,
  getHosts: () => { try { return hosts; } catch { return null; } },
  getNoConvoRef: () => { try { return noConvoRef; } catch { return null; } },
  readLayouts: (...a) => readLayouts(...a),
  sysinfo,
  listLayoutHistory: () => { try { return persistenceRouter.listLayoutHistory(); } catch { return []; } },
});
app.get('/api/sysinfo', async (req, res) => {
  try {
    const hostId = String(req.query.host || '');
    if (hostId) return res.json(await remoteSysinfo(hostId));
    res.json(await sysinfo.read(path.join(__dirname, 'data')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Process manager (2.354.0, btop-like): full table + user-initiated signal.
app.get('/api/sysinfo/procs', async (req, res) => {
  try {
    const hostId = String(req.query.host || '');
    if (hostId) return res.json(await remoteProcs(hostId));
    res.json({ serverPid: process.pid, ...(await sysinfo.listProcs()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sysinfo/signal', async (req, res) => {
  try { res.json(await signalProc(String(req.body?.host || ''), req.body?.pid, req.body?.sig)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Resource HISTORY for the System rail charts (2.223.0): self-sampled CPU/
// memory rings — 24h at the 45s watch cadence, 7d at 15min. range=1h|24h|7d.
app.get('/api/sysinfo/history', (req, res) => {
  const ranges = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
  const ms = ranges[String(req.query.range || '24h')] || ranges['24h'];
  res.json({ points: sysinfo.history(ms), rangeMs: ms, cpus: require('os').cpus().length });
});
sysinfo.startWatch({
  dataDir: path.join(__dirname, 'data'),
  broadcast: (msg) => {
    const json = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === WS_OPEN) { try { c.send(json); } catch {} } });
  },
});

app.get('/api/tasks', (req, res) => res.json({ tasks: tasks.list() }));
app.post('/api/tasks', (req, res) => {
  try { res.json({ success: true, task: tasks.create(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/tasks/:id', (req, res) => {
  try { res.json({ success: true, task: tasks.update(req.params.id, req.body || {}) }); }
  catch (e) { res.status(e.message === 'task not found' ? 404 : 400).json({ error: e.message }); }
});
app.delete('/api/tasks/:id', (req, res) => {
  try { tasks.remove(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
// Granular tag ops (atomic server-side — concurrent clients can't clobber
// each other's read-modify-write of the sessions array)
app.post('/api/tasks/:id/bind', (req, res) => {
  try { res.json({ success: true, task: tasks.bind(req.params.id, req.body?.sessionKey) }); }
  catch (e) { res.status(e.message === 'task not found' ? 404 : 400).json({ error: e.message }); }
});
app.post('/api/tasks/:id/unbind', (req, res) => {
  try { res.json({ success: true, task: tasks.unbind(req.params.id, req.body?.sessionKey) }); }
  catch (e) { res.status(e.message === 'task not found' ? 404 : 400).json({ error: e.message }); }
});
app.post('/api/tasks/:id/progress', (req, res) => {
  try { res.json({ success: true, task: tasks.addProgress(req.params.id, req.body || {}) }); }
  catch (e) { res.status(e.message === 'task not found' ? 404 : 400).json({ error: e.message }); }
});
// P4 repo task files: export a task to a committable markdown file / import one.
app.post('/api/tasks/:id/export', (req, res) => {
  try { res.json({ success: true, path: tasks.exportToFile(req.params.id, req.body?.path) }); }
  catch (e) { res.status(e.message === 'task not found' ? 404 : 400).json({ error: e.message }); }
});
app.post('/api/tasks/import', (req, res) => {
  try { res.json({ success: true, task: tasks.importFromFile(req.body?.path) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Remote context-folder auto-sync ("mount"): a REMOTE session's belonged
// groups with a contextDir get a live-synced copy at
// <remoteHome>/.vibespace/ctx/<groupId> (bidirectional rsync, newer-wins, no
// deletes, .vibespace excluded), and the injected file index is path-translated
// to the remote copy (remoteCtxBase). Triggers: session spawn + a 60s timer
// while any live remote session belongs to the group. Remote writes sync back
// → the local signature changes → every member re-injects next turn. ──
const { syncGroupCtx, FILE_CAP: CTX_FILE_CAP, MAX_FILES: MAX_CTX_FILES } = require('./src/ctx-sync');
const machineProbes = require('./src/machine-probes');
const { parseRateLimitEvent, captureRateLimitEvent } = require('./src/rate-limit-capture.js');
const _ctxSyncBusy = new Set(); // `${hostId}:${groupId}` in-flight guard
const _ctxSkipNoticed = new Set(); // one honest notice per host:group:file per boot
async function syncRemoteGroupCtx(h, g) {
  const key = `${h.id}:${g.id}`;
  if (_ctxSyncBusy.has(key)) return;
  _ctxSyncBusy.add(key);
  try {
    const home = await hosts.homeDir(h);
    if (!home) return;
    const rdir = `${home}/.vibespace/ctx/${g.id}`;
    // ONE implementation for every transport (src/ctx-sync.js, 2.277.0):
    // hashed newer-wins sync over the device link; ssh degrades to its legacy
    // rsync pair when the link is down. The old split (ssh=rsync uncapped,
    // dial=hashed with a SILENT 2MB/400-file cap) meant a 3MB context file
    // reached every ssh host and never reached a dial device, invisibly.
    await syncGroupCtx({
      hosts, host: h, group: g, remoteDir: rdir,
      onSkip: (rel, why, size) => {
        const k = `${key}:${rel}:${why}`;
        if (_ctxSkipNoticed.has(k)) return;
        _ctxSkipNoticed.add(k);
        const msg = why === 'count'
          ? `Context folder for "${g.title || g.id}" has more than ${MAX_CTX_FILES} files — the rest won't sync to ${h.name}.`
          : `Context file ${rel} (${Math.round((size || 0) / 1024 / 1024)}MB) exceeds the ${Math.round(CTX_FILE_CAP / 1024 / 1024)}MB sync cap and won't reach ${h.name}.`;
        console.warn('[ctx-sync]', msg);
        try { serverNotice(`ctx-skip:${k}`, msg, { level: 2 }); } catch { }
      },
    });
  } catch (e) { console.warn('[ctx-sync]', h.name, g.id, e.message); }
  finally { _ctxSyncBusy.delete(key); }
}
// Groups a session belongs to that have a syncable context folder.
function ctxGroupsOf(session, id) {
  if (!session.host) return [];
  return tasks.groupsForSession({ sessionKey: sessionStatusKey(session, id), cwd: session.cwd, initialGroupId: session._initialGroupId })
    .filter((g) => g.contextDir && g.injectContext !== false);
}
function scheduleCtxSync(session, id) {
  try {
    if (!session.host || !hosts) return;
    let h; try { h = hosts.get(session.host); } catch { return; }
    for (const g of ctxGroupsOf(session, id)) syncRemoteGroupCtx(h, g);
  } catch { }
}
setInterval(() => {
  try {
    if (!integrationEnabled()) return; // master switch off ⇒ no ctx-folder pushes either
    const seen = new Set();
    for (const [id, s] of activeSessions) {
      if (!s.host) continue;
      let h; try { h = hosts.get(s.host); } catch { continue; }
      for (const g of ctxGroupsOf(s, id)) {
        const k = s.host + ':' + g.id;
        if (seen.has(k)) continue;
        seen.add(k);
        syncRemoteGroupCtx(h, g);
      }
    }
  } catch { }
}, 60000);
// Absolute remote path the injection should show for a group's context folder
// (null → local session, keep local paths). Uses the cached remote home; if
// the home isn't known yet (first contact) fall back to local paths this turn.
function remoteCtxBaseFor(session) {
  if (!session.host || !hosts) return null;
  const home = hosts._homes?.get(session.host);
  if (!home) { try { hosts.homeDir(hosts.get(session.host)); } catch { } return null; } // warm the cache async
  return (gid) => `${home}/.vibespace/ctx/${gid}`;
}

// ── Anthropic accounts (subscription ↔ API/console per-session switching) ──
// Keys AES-GCM encrypted in data/accounts.json; injected as ANTHROPIC_API_KEY
// into the session's spawn env (process-env channel — never argv/proc-visible).
// The CLI's own /login is mutually exclusive; this store is what lets both
// identities coexist. Design: docs/design in CLAUDE.md "Accounts".
const { AccountManager } = require('./src/accounts');
const accounts = new AccountManager({
  dataDir: path.join(__dirname, 'data'),
  onChange: (list) => {
    const json = JSON.stringify({ type: 'accounts-updated', ...list });
    for (const client of wss.clients) if (client.readyState === WS_OPEN) client.send(json);
    broadcastActiveSessions(); // account names on live session cards may change
  },
});
// ── Usage history: a PERMANENT per-request token ledger mined from Claude's
// JSONL transcripts (terminal + chat), for the Usage window. resolveAccount
// bakes WHICH account + its billing TYPE into each event so subscription and
// API-key usage are never conflated. ──
const { UsageHistory } = require('./src/usage-history');
// Forward URL/token: user setting wins; the VIBESPACE_TELEMETRY_FORWARD_* env
// vars are the DEPLOYMENT defaults (helm/compose set them fleet-wide so no
// per-user settings edit is needed on managed instances).
const telemetry = new Telemetry({
  dataDir: path.join(__dirname, 'data'),
  version: require('./package.json').version,
  getForwardUrl: () => {
    try { return serverSetting('telemetry.forwardUrl') || process.env.VIBESPACE_TELEMETRY_FORWARD_URL || ''; }
    catch { return process.env.VIBESPACE_TELEMETRY_FORWARD_URL || ''; }
  },
  getForwardToken: () => {
    try { return serverSetting('telemetry.forwardToken') || process.env.VIBESPACE_TELEMETRY_FORWARD_TOKEN || ''; }
    catch { return process.env.VIBESPACE_TELEMETRY_FORWARD_TOKEN || ''; }
  },
});
// Server-side fatals land in the same ledger (journald has them too, but the
// diagnostics report should show one unified picture).
process.on('uncaughtException', (e) => {
  try { telemetry.record({ kind: 'server-error', name: e.message || 'uncaughtException', stack: e.stack }); telemetry.flush(); } catch {}
  // Same flush belt as the clean shutdown (2.219.0 audit) — a crash used to
  // drop up to 2s of debounced writes (layouts, session-status, user-todos).
  try { for (const store of Object.values(syncStores)) { try { store.flush(); } catch {} } } catch {}
  try { flushLayouts(); } catch {}
  try { sessionStatus.flush(); } catch {}
  try { userTodos.flush(); } catch {}
  console.error(e); process.exit(1);
});
process.on('unhandledRejection', (e) => { try { telemetry.record({ kind: 'server-error', name: (e && e.message) || 'unhandledRejection', stack: e && e.stack }); } catch {} console.error('unhandledRejection:', e); });

// Server performance metrics — RSS/heap, event-loop lag, live session count.
// Every 5 min; names-and-numbers only, same ndjson ledger as everything else.
{
  let lagProbeAt = Date.now();
  let maxLagMs = 0;
  setInterval(() => { // 1s cadence lag probe (cheap): drift beyond the interval = loop blocked
    const now = Date.now();
    const lag = now - lagProbeAt - 1000;
    if (lag > maxLagMs) maxLagMs = lag;
    lagProbeAt = now;
  }, 1000);
  setInterval(() => {
    try {
      const mu = process.memoryUsage();
      telemetry.record({ kind: 'metric', name: 'srv-rss-mb', value: Math.round(mu.rss / 1048576) });
      telemetry.record({ kind: 'metric', name: 'srv-heap-mb', value: Math.round(mu.heapUsed / 1048576) });
      telemetry.record({ kind: 'metric', name: 'srv-evloop-max-lag-ms', value: Math.max(0, maxLagMs) });
      telemetry.record({ kind: 'metric', name: 'srv-live-sessions', value: activeSessions.size });
      telemetry.record({ kind: 'metric', name: 'srv-ws-clients', value: wss.clients.size });
      // Leak canaries — the exact classes the 2.81-2.91 audits kept finding:
      // subagent watchers that outlive their agent, normalizer message piles.
      let watchers = 0, normMsgs = 0;
      for (const [, sess] of activeSessions) {
        watchers += sess.subagentWatchers?.size || 0;
        normMsgs += sess._normalizer?.total || 0;
      }
      telemetry.record({ kind: 'metric', name: 'srv-subagent-watchers', value: watchers });
      telemetry.record({ kind: 'metric', name: 'srv-normalizer-msgs', value: normMsgs });
      try { telemetry.record({ kind: 'metric', name: 'srv-buffer-files', value: fs.readdirSync(BUFFERS_DIR).length }); } catch {}
      if (_httpWin.n) {
        telemetry.record({ kind: 'metric', name: 'srv-http-reqs-5min', value: _httpWin.n });
        telemetry.record({ kind: 'metric', name: 'srv-http-avg-ms', value: Math.round(_httpWin.sum / _httpWin.n) });
        telemetry.record({ kind: 'metric', name: 'srv-http-max-ms', value: Math.round(_httpWin.max) });
        for (const sl of _httpWin.slow) telemetry.record({ kind: 'event', name: `slow-request ${sl.route}`, value: sl.ms });
        _httpWin.n = 0; _httpWin.sum = 0; _httpWin.max = 0; _httpWin.slow.length = 0;
      }
      maxLagMs = 0;
    } catch {}
  }, 300000);
}

// Zero-coupling metric hook for deep modules (session-store slow-parse etc.)
global.__vsMetric = (name, value) => { try { telemetry.record({ kind: 'metric', name, value }); } catch {} };
// Server-side EVENT hook (2.207.0): the debugging-pain batch — session
// lifecycle anomalies, CLI error classes, probe failures — flows into the
// same Diagnostics report/fleet forwarding as client events. NAMES + short
// enum-ish details only, never content (telemetry charter).
global.__vsEvent = (name, detail) => { try { telemetry.record({ kind: 'event', name, detail }); } catch {} };

// ── Threadpool canary (2.108.6) ──
// The wedge class that took the instance down twice today (hung fuse IO) fills
// the libuv threadpool while the EVENT LOOP stays healthy — evloop-lag metrics
// see nothing. Canary: a stat() of our own package.json (always-fast local
// disk) must round-trip through the pool; when it exceeds the deadline three
// times in a row, the pool is wedged by SOMETHING — log loudly, record
// telemetry, and kick the mount health sweep (the known culprit class) without
// waiting for its 60s timer. Self-healing for known causes, loud for unknown.
{
  const CANARY_FILE = path.join(__dirname, 'package.json');
  let canaryStrikes = 0;
  let canaryBusy = false;
  setInterval(() => {
    if (canaryBusy) return; // previous canary still in flight = already wedged; strikes accrue on its resolution
    canaryBusy = true;
    const t0 = Date.now();
    const deadline = setTimeout(() => {
      canaryBusy = false;
      canaryStrikes++;
      console.error(`[canary] threadpool stat() exceeded 5s (strike ${canaryStrikes}) — pool likely wedged`);
      telemetry.record({ kind: 'metric', name: 'srv-fs-canary-ms', value: 5000 });
      if (canaryStrikes >= 3) {
        canaryStrikes = 0;
        telemetry.record({ kind: 'event', name: 'srv-threadpool-wedged' });
        try { mounts._healthSweep().catch(() => {}); } catch {}
      }
    }, 5000);
    fs.promises.stat(CANARY_FILE).then(() => {
      clearTimeout(deadline);
      if (!canaryBusy) return; // deadline already fired for this run
      canaryBusy = false;
      canaryStrikes = 0;
      const ms = Date.now() - t0;
      // record anomalies only — a healthy sub-ms canary every 10s is noise
      if (ms > 1000) telemetry.record({ kind: 'metric', name: 'srv-fs-canary-ms', value: ms });
    }).catch(() => { clearTimeout(deadline); canaryBusy = false; });
  }, 10000).unref();
}

const usageHistory = new UsageHistory({
  dataDir: path.join(__dirname, 'data'),
  resolveAccount: (id) => {
    const a = (accounts.list().accounts || []).find((x) => x.id === id);
    if (!a) return null;
    return { type: a.backend === 'codex' ? 'codex-subscription' : a.type, name: a.name, tail: a.tail };
  },
});
// OTel TRUTH receiver (2.361.0, B-345b): local claude sessions push their own
// api_request telemetry (organization.id + request_id) here — the observed
// billing org overrides link-intent attribution at ledger bake time and
// writes corrective attribution records (hot-switch stale-token class).
// Routes are cookie-exempt (auth.js); the module's loopback+token gate is the
// only door. Zero vendor calls — the CLI pushes to us.
const otelIngest = require('./src/server/otel-ingest.js').create({
  dataDir: path.join(__dirname, 'data'), PORT, serverSetting,
  getUsageHistory: () => usageHistory, identityGroups: () => usageIdentityGroupsCached(),
  listAccounts: () => accounts.list().accounts || [],
});
otelIngest.registerRoutes(app);
usageHistory.setTruthLookup(otelIngest.truthLookup);
// Attribution log: dedup'd per (sid,acct) so a resume under a DIFFERENT account
// is captured with its timestamp (per-request-by-time attribution). Called from
// writeSessionMeta whenever a session has both a claudeSessionId and account.
const _lastAttrib = new Map();
function recordUsageAttribution(meta) {
  const sid = meta && (meta.claudeSessionId || meta.backendSessionId);
  if (!sid) return;
  let acct = meta.accountId || null;
  let pool = null;
  // A POOLED session bills whatever the pool currently points at — attribute
  // the ledger to the REAL target at record time (attribution is by-time, so
  // a later re-point + re-record moves subsequent requests to the new target).
  // Keep the pool id as a SEPARATE tag (#4): acct stays the real target so
  // per-account and the global sum are correct with NO double-count, while pool
  // lets the Usage window show the total that flowed through each pool.
  // An unresolvable pool target (broken symlink / logged-out member) falls to
  // GLOBAL, never to the pool id itself — else a `type:'pooled'` pseudo-account
  // would surface as a spender in the account dimension (review low-confidence
  // finding). The pool tag is still recorded (pool captured above).
  try {
    if (acct && accounts.get(acct)?.type === 'pooled') {
      pool = acct;
      // Plan C: a session with its OWN link bills that link's target — the
      // live session is looked up by conversation id (the attribution key we
      // were handed) so the per-session choice lands in the ledger.
      let sessKey = null;
      try { for (const [wid, s2] of activeSessions) if ((s2.claudeSessionId || s2.backendSessionId) === sid && s2._accountId === acct) { sessKey = wid; break; } } catch { }
      acct = accounts.poolCurrentFor(acct, sessKey) || null;
    }
  } catch {}
  const attribKey = (acct || '') + '|' + (pool || '');
  if (_lastAttrib.get(sid) === attribKey) return;
  _lastAttrib.set(sid, attribKey);
  // Cap only — never delete-on-kill: kill→resume of the same sid (terminate/
  // resume, billing switch) would re-append a duplicate attribution line.
  if (_lastAttrib.size > 4096) _lastAttrib.delete(_lastAttrib.keys().next().value);
  usageHistory.recordAttribution({ sid, acct, pool, ts: Date.now() });
}
// Rescan the ledger periodically (incremental — only new JSONL bytes). Also
// rescanned on demand when the Usage window opens.
setTimeout(() => { try { usageHistory.scan(); usageHistory.warm(); } catch {} }, 8000);
setInterval(() => { try {
  const t0 = Date.now();
  const r = usageHistory.scan();
  if (!r?.skipped) telemetry.record({ kind: 'metric', name: 'srv-usage-scan-ms', value: Date.now() - t0 });
} catch {} }, 180000);
// Telemetry ingest (client errors + feature events) + diagnostics summary.
// telemetry.enabled=false drops ingest silently (client still posts — cheap).
app.post('/api/telemetry', (req, res) => {
  try {
    let enabled = true;
    try { enabled = serverSetting('telemetry.enabled') !== false; } catch {}
    if (enabled) {
      const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : [];
      for (const ev of events) telemetry.record(ev);
    }
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.get('/api/telemetry/summary', (req, res) => {
  try {
    telemetry.flush();
    res.json(telemetry.summary({ days: Math.min(parseInt(req.query.days) || 14, 90) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Account + usage routes (src/server/account-usage-routes.js, decomposition #9) ──
require('./src/server/account-usage-routes.js').create({
  app, rootDir: __dirname, HOST, CLAUDE_CMD, NODE_CMD,
  CLAUDE_SUBSCRIPTION_LOGIN_HELPER, activeSessions, auth,
  engine: { clearSealedOrders },
  serverSetting: (...a) => serverSetting(...a),
  recordUsageAttribution: (...a) => recordUsageAttribution(...a),
  liveAccountIdSet: (...a) => liveAccountIdSet(...a),
  buildClaudeSubscriptionLoginCommand: (...a) => buildClaudeSubscriptionLoginCommand(...a),
  getAccounts: () => { try { return accounts; } catch { return null; } },
  getHosts: () => { try { return hosts; } catch { return null; } },
  getMounts: () => { try { return mounts; } catch { return null; } },
  getTelemetry: () => { try { return telemetry; } catch { return null; } },
  getUsageHistory: () => { try { return usageHistory; } catch { return null; } },
});
// ── Session status (agent-set via vibespace-status CLI, user-overridable) ──
// The user's override of an agent-set status is injected as a system-reminder
// into the NEXT chat message (see ws-handler chat-input) so the agent learns
// the user disagreed with its self-assessment.
const { SessionStatusManager } = require('./src/session-status');
const sessionStatus = new SessionStatusManager({
  dataDir: path.join(__dirname, 'data'),
  onChange: (statuses) => {
    const json = JSON.stringify({ type: 'session-status-updated', statuses });
    wss.clients.forEach(c => { if (c.readyState === WS_OPEN) { try { c.send(json); } catch {} } });
  },
});
function sessionStatusKey(session, id) {
  const bsid = session?.backendSessionId || session?.claudeSessionId;
  return bsid ? `${session.backend || 'claude'}:${bsid}` : `webui:${id}`;
}
// ── Global user-facing TODO list (vibespace-ask) — items an agent filed that
// need the USER (decision/input/review). Merged inbox in the taskbar; each
// item belongs to one session and jumps back to it.
const { UserTodoManager } = require('./src/user-todos');
const userTodos = new UserTodoManager({
  dataDir: path.join(__dirname, 'data'),
  onChange: (todos) => {
    const json = JSON.stringify({ type: 'user-todos-updated', todos });
    wss.clients.forEach(c => { if (c.readyState === WS_OPEN) { try { c.send(json); } catch {} } });
  },
});
require('./src/server/login-expiry-watch.js').create({ accounts, userTodos, dataDir: path.join(__dirname, 'data'), log: (...a) => console.log(...a) }).start(); // PASSIVE (file reads only, §ban-safety): warns the inbox at 24h/1h/expired before a subscription's LOGIN SESSION dies — see src/login-expiry.js
app.get('/api/user-todos', (req, res) => res.json({ todos: userTodos.snapshot() }));
// User actions from the panel: done / dismissed / open (reopen)
app.post('/api/user-todos/:id', (req, res) => {
  try { res.json({ success: true, item: userTodos.setStatus(req.params.id, req.body?.status, 'user') }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Agent endpoint (vibespace-ask) — per-session vsst_ token, same auth model as
// /api/agent/session-status; writes scoped to the calling agent's own session.
// ── Agent-facing routes ── (extracted to src/agent-routes.js in the 2.92.0 split)
const { setupAgentRoutes } = require('./src/agent-routes');
// ── Background Work (2.342.0): jobs engine — constructed here, INITIALIZED
// only after listen (failure isolated; §5 of docs/design-background-work.md).
// Shared conversation delivery ladder (2.362.0): jobs notifications AND
// agent-to-agent messages ride one implementation — local CLI inbox, then the
// owning machine's daemon (conversation-index names it), then the durable
// stash drained at that conversation's next context injection.
const deliver = require('./src/server/conversation-deliver.js').create({
  dataDir: path.join(__dirname, 'data'),
  peerMsg: require('./src/peer-messaging.js'),
  getHosts: () => hosts,
  getConvIndex: () => hosts && hosts.convIndex,
  serverSetting, activeSessions,
  // 2.363.0: render the peer card at delivery time — server-posted injections
  // are body-less at the CLI, only the delivery site can show them live.
  emitPeerCard: (cid, card) => {
    for (const [, s] of activeSessions) {
      if ((s.backendSessionId || s.claudeSessionId) !== cid || !s._normalizer) continue;
      try { feedPeerCard(s, card); } catch { }
      return true;
    }
    return false;
  },
  log: (...a) => console.log(...a),
});
const jobsWiring = require('./src/server/jobs-wiring.js').create({
  app, dataDir: path.join(__dirname, 'data'), deliver,
  broadcastAll: (msg) => { const payload = JSON.stringify(msg); for (const c of wss.clients) { try { if (c.readyState === WS_OPEN) c.send(payload); } catch {} } },
  userTodos, log: (...a) => console.log(...a),
  serverSetting, taskGroups: tasks, activeSessions, // owner auto-notify (2.344.0): toggles + channel-lane session lookup
});
// Channels v1 (2.362.0): per-session external reach override for agent
// messaging — user-set (Session Properties), widening only; ACL reads the
// live field, meta persists it across restarts.
app.post('/api/sessions/:id/msg-reachability', (req, res) => {
  const s = activeSessions.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: 'no such active session' });
  const lv = String((req.body || {}).level || 'inherit');
  if (!['inherit', 'visible', 'messageable'].includes(lv)) return res.status(400).json({ error: 'level must be inherit|visible|messageable' });
  s._msgReachability = lv === 'inherit' ? null : lv;
  try { writeSessionMeta(s.sockName, { ...readSessionMeta(s.sockName), msgReachability: s._msgReachability }); } catch { }
  res.json({ ok: true, level: lv });
});
setupAgentRoutes({ app, activeSessions, tasks, sessionStatus, SessionStatusManager, userTodos, sessionStatusKey, serverSetting, scheduleCtxSync, remoteCtxBaseFor, readUserState: () => persistenceRouter.readUserState(), getJobs: jobsWiring.getJobs, deliver, getPublishedPages: () => publishedPages, getDesignKit: () => designKit }); // lazy getters: both are created further down (TDZ at boot otherwise)
app.get('/api/agent-hooks', (req, res) => res.json({ ...agentHooksStatus(), integrationOff: !integrationEnabled() }));
app.post('/api/agent-hooks/install', (req, res) => {
  // The master switch outranks the button: boot/toggle would strip the entries
  // right back — refuse with guidance instead of silently contradicting.
  if (!integrationEnabled()) return res.status(400).json({ error: 'VibeSpace integration is disabled (Settings → Integration → master switch). Enable it first.' });
  createHookHelper(); // regenerate the script too (repair path)
  const results = ensureAgentHooks({ auto: false }); // explicit → clears any opt-out
  res.json({ success: true, results, status: agentHooksStatus() });
});
app.post('/api/agent-hooks/uninstall', (req, res) => {
  removeAgentHooks();
  res.json({ success: true, status: agentHooksStatus() });
});

// ── Hosts (the MACHINE registry — ssh hosts AND dial-out devices, B-f3e8) ──
const { HostManager } = require('./src/hosts');
const hosts = new HostManager({ dataDir: path.join(__dirname, 'data') });
const bcastAll = (msg) => { const j = JSON.stringify(msg); wss.clients.forEach(c => { if (c.readyState === WS_OPEN) { try { c.send(j); } catch {} } }); };
// B-f3e8 one-time migration: dial-tokens.json (deviceId → sha256) folds into
// the dial host records (dialTokenHash) — see hosts.migrateDialTokenFile.
try { hosts.migrateDialTokenFile(path.join(AGENTD_DIR, 'dial-tokens.json')); }
catch (e) { console.warn('[hosts] dial-token migration failed:', e.message); }
hosts.dialOnline = (deviceId) => agentdDials.has(deviceId);
// ── R4 push-triggered remote ledger (docs/design-three-tier.md): a connected
// daemon fs.watches its transcript dirs (.claude/sessions+projects and
// .codex/sessions) and pushes one debounced dirty per change burst; we
// harvest promptly instead of waiting for a turn-end result or the idle
// 15-min cadence. harvestUsage's own 60s/host floor bounds frequency, and
// the op harvest (2.286.0) is incremental + cheap — so ANY remote activity
// (mid-turn tool storms, codex, external terminals) reaches the ledger and
// the billing popup within ~a minute. One dirty signal, two consumers: this
// kick + discovery cache invalidation (armed in hosts._armDirtyPush). ──
// usage-events PUSH consumer (R4 finale, 2.299.0): batches arrive
// seconds-fresh over the device link; ingest through the SAME pipeline the
// pull harvest uses (attribution + rid namespacing + host-bucket honesty),
// then invalidate the estimator so the next pool decision sees the spend.
// Returning normally (not false) tells hosts to ACK — which is what commits
// the device-side cursor (two-phase). A throw leaves the batch unacked → the
// daemon re-emits → rid dedup absorbs the replay.
// ── Session-brain core (src/server/session-brain.js, decomposition #8) ──
const { sbNoteServerOp, sbCompare, sbSeenFirst, claudeSideEffects, _sbRing,
  _sbMidCore, SB_RING_MAX,
} = require('./src/server/session-brain.js').create({
  engine: { kickPoolEval, markLimitBanner, maybeStopOnFallback,
    recordRateLimitEvent, resolveUsageKey, usageEstimator },
  applyTaskToolUpdate, updateSessionTodos,
  getUsageHistory: () => { try { return usageHistory; } catch { return null; } },
});
hosts.onSessionEvents = (hostId, m) => {
  try {
    if (!m?.sid) return;
    // STEP 3: raw records → the shared side-effect consumers, device-first.
    // Session lookup by the DAEMON's sid (keeperSid); miss = not ours (an
    // externally-adopted pipe session) — parity ring still records below.
    if (Array.isArray(m.raw) && m.raw.length) {
      let sess = null;
      for (const [, s3] of activeSessions) { if (s3.host === hostId && s3.keeperSid === m.sid && s3.backend !== 'codex') { sess = s3; break; } }
      if (sess) {
        for (const line of m.raw) {
          let rec = null; try { rec = JSON.parse(line); } catch { continue; }
          if (sbSeenFirst(sess, rec)) claudeSideEffects(sess, sess._webuiId || null, rec);
        }
      }
    }
    if (!Array.isArray(m.batch)) return;
    const r = _sbRing(hostId + ':' + m.sid);
    for (const ej of m.batch) {
      let op = null; try { op = JSON.parse(ej); } catch { continue; }
      if (op?.op === 'create' && op.msg?.id) {
        r.device.push(_sbMidCore(op.msg.id));
        if (r.device.length > SB_RING_MAX) r.device.splice(0, r.device.length - SB_RING_MAX);
      }
    }
    sbCompare(hostId, m.sid, r);
  } catch { }
};
hosts.onUsageEvents = (hostId, text) => {
  if (!text) return true;
  const h = hosts.get(hostId);
  const r = usageHistory.ingestRemoteEvents(hostId, h?.name || hostId, text);
  if (r.added > 0) {
    try { for (const [ik] of usageIdentityGroups()) usageEstimator.invalidate(ik); } catch { }
    try { kickPoolEval(); } catch { }
  }
  return true;
};
{
  const dirtyTimers = new Map();
  // Remote discovery went stale (create / terminate / external kill / device
  // push) — every connected client's cached host list must re-fetch. Trailing-
  // debounced per host so a burst of invalidations is one broadcast.
  // …and the ORCHESTRATOR computes it ONCE and pushes the RESULT (2.310.0).
  // The first cut broadcast a bare "dirty" and let every client re-fetch with
  // ?fresh=1 — which puts the trigger for a heavy scan on the orchestration
  // side and multiplies it by the number of connected clients. The three-tier
  // rule is the opposite: the machine that OWNS the facts computes them (the
  // capability-gated `discovery-claims` op runs the whole claim algorithm on
  // the device, next to the bytes), the orchestrator forwards, the client is a
  // view. One dirty signal ⇒ one computation ⇒ one broadcast, whatever the
  // client count. Skipped entirely when nobody is connected.
  // AUTO-GRADUATE ssh → ws (2.311.0). The graduation mechanism has existed
  // since 2.248.0 but was button-only, so in practice every machine stayed on
  // ssh forever — per-op child spawns, banner hangs on lossy paths, and a
  // ControlMaster whose ESTABLISHED flow survives network changes that every
  // NEW connection fails (the 2.228.1 lie). Once we have proven we can reach
  // the machine, moving to our own ws link is strictly better.
  // DELIBERATELY CONSERVATIVE: only with an operator-declared base URL — never
  // auto-publish this instance to the public relay, which is a side effect the
  // operator has to choose. The machine is still asked whether it can reach
  // that URL BEFORE anything is installed, and any failure leaves it on ssh.
  const gradTried = new Map();
  hosts.onSshConnected = (hostId) => {
    try {
      if (!hostId || serverSetting('agentd.autoGraduate') === false) return;
      const h = hosts.get(hostId);
      if (!h || h.transport === 'dial' || h.deviceId || h.autoGraduate === false) return; // already graduated / opted out
      if (!instanceUrl.url()) return;                                  // nothing to dial back to (was agentdDeps.publicUrl — a ghost binding since the split; auto-graduation silently never fired)
      const last = gradTried.get(hostId) || 0;
      if (Date.now() - last < 6 * 60 * 60 * 1000) return;               // one attempt per machine per 6h
      gradTried.set(hostId, Date.now());
      setTimeout(async () => {
        try {
          const out = await graduateHostToDial(hosts.get(hostId), {});
          serverNotice('grad-' + hostId, `"${h.name}" now talks to VibeSpace over its own ws link${out.dialedIn ? '' : ' (dialing in shortly)'} — ssh stays as the rescue channel.`);
        } catch (e) {
          // Never silent: the operator asked for ws and did not get it.
          console.warn('[graduate] auto attempt failed for', hostId, e.message);
          serverNotice('grad-fail-' + hostId, `Could not move "${h.name}" to a ws link — staying on ssh. ${String(e.message).slice(0, 180)}`, { level: 'warn' });
        }
      }, 3000); // let the connect that triggered us finish its own work first
    } catch { }
  };

  const discDirtyTimers = new Map();
  hosts.onDiscoveryDirty = (hostId) => {
    if (!hostId || discDirtyTimers.has(hostId)) return;
    discDirtyTimers.set(hostId, setTimeout(async () => {
      discDirtyTimers.delete(hostId);
      try {
        if (!wss.clients.size) return; // nobody to tell — do not spend the scan
        const d = await hosts.discoverSessions(hostId, { ttlMs: 0 });
        bcastAll({ type: 'remote-sessions', hostId, sessions: d?.sessions || [], at: Date.now() });
      } catch (e) {
        // An unreachable machine must not silently freeze the list at a state
        // we know is wrong — say so, and let the client keep its labelled
        // last-known copy (the same degrade the pull path already does).
        try { bcastAll({ type: 'remote-sessions', hostId, error: String(e?.message || e), at: Date.now() }); } catch { }
      }
    }, 400));
  };
  hosts.onDeviceDirty = (hostId) => {
    if (dirtyTimers.has(hostId)) return; // trailing-debounce per host
    dirtyTimers.set(hostId, setTimeout(() => {
      dirtyTimers.delete(hostId);
      try {
        hosts.harvestUsage(hostId, { minIntervalMs: 60 * 1000, scannerPath: USAGE_SCANNER_PATH })
          .then((txt) => { if (txt) usageHistory.ingestRemoteEvents(hostId, hosts.get(hostId)?.name, txt); })
          .catch(() => { });
      } catch { }
    }, 3000));
  };
}
const { MachineMounts } = require('./src/machine-mounts');
const machineMounts = new MachineMounts({
  dataDir: path.join(__dirname, 'data'), hosts, mountTokens,
  publicUrl: () => instanceUrl.url(), localPort: () => PORT, // the agentd tunnel's target: our own /dav
  rcloneBin: () => mounts.rcloneBin(),
  broadcast: bcastAll,
  log: (m) => console.log('[machine-mounts]', m),
});
setTimeout(() => { machineMounts.restore().catch(() => {}); }, 5000); // heal pull mounts + re-own push tunnel ports
app.get('/api/machine-mounts', (req, res) => res.json({ mounts: machineMounts.list() }));
app.post('/api/machine-mounts/:hostId', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.dir === 'pull') {
      res.json(await machineMounts.mountPull(req.params.hostId, { remotePath: b.remotePath, mountpoint: b.mountpoint }));
    } else {
      // PRIMARY transport = the agentd tunnel (inside mountPush — no public
      // address needed). The request-derived URL is only the last-resort
      // fallback for hosts without the device agent.
      let pub = b.publicUrl ? String(b.publicUrl) : null;
      if (!pub) { const proto = req.headers['x-forwarded-proto'] || 'http'; const host = req.headers['x-forwarded-host'] || req.headers.host; if (host) pub = `${proto}://${host}`; }
      res.json(await machineMounts.mountPush(req.params.hostId, { folder: b.folder, mode: b.mode, mountpoint: b.mountpoint, publicUrlFallback: pub }));
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/machine-mounts/:id', async (req, res) => {
  try { res.json(await machineMounts.unmount(String(req.params.id))); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/machine-mounts/:id/remount', async (req, res) => {
  try { res.json(await machineMounts.remount(String(req.params.id))); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Port forwarding (B-0b60, tunnel path): expose a machine's loopback
// service at http://127.0.0.1:<localPort> on this instance, over the agentd
// data plane (no frps / public exposure). ──
const { PortForwardManager } = require('./src/port-forward');
const portForwards = new PortForwardManager({
  dataDir: path.join(__dirname, 'data'), hosts, broadcast: bcastAll,
  serverSetting, getJobs: jobsWiring.getJobs, // Background Work ⇄ ports sync (2.343.0)
  log: (m) => console.log('[port-forward]', m),
});
jobsWiring.jm.d.getPorts = () => portForwards; // late singleton — lazy getter, never a Proxy
setTimeout(() => { portForwards.restore().catch(() => {}); }, 5500);
const instanceUrl = require('./src/server/instance-url.js').create({ dataDir: path.join(__dirname, 'data'), port: PORT, serverSetting, log: (...a) => console.log(...a), authEnabled: () => auth.enabled, broadcast: (m) => bcastAll(m), plugins: { status: (id) => plugins.status(id), frpPublish: (...a) => plugins.frpPublish(...a), frpUnpublish: (...a) => plugins.frpUnpublish(...a), setSelfDialSub: (...a) => plugins.setSelfDialSub?.(...a) } }); // ONE resolver for "this instance's URL" (frp mapping layered OVER agentd.publicUrl, never written into it) + the ONLY publisher of the 'vibespace-instance' proxy; plugins arrives later so its accessors are lazy ⇒ src/server/instance-url.js
const autoResume = require('./src/server/auto-resume.js').create({ dataDir: path.join(__dirname, 'data'), activeSessions, serverSetting, beforeFire: (id, s) => { try { return beforeAutoResumeFire(id, s); } catch { return true; } }, fireIdentity: (id, s) => { try { return fireIdentityFor(s); } catch { return null; } }, log: (...a) => console.log(...a), broadcast: (id, m) => { const s = activeSessions.get(id); if (s) broadcastToSession(s, id, m); }, notify: (id, s, text) => { try { feedPeerCard(s, { fromName: 'VibeSpace', text }); } catch { } }, sendToSession: (id, s, text) => { try { const ad = adapterRegistry.get(s.backend); if (!ad || !s.pty || s.mode !== 'chat') return false; const { stdinPayload, userMsg } = ad.formatChatInput(text, Date.now() + '-auto'); s._isStreaming = true; s.pty.write(stdinPayload + '\n'); if (userMsg) { userMsg.originKind = 'auto-resume'; if (userMsg.payload) userMsg.payload.webui_origin = 'auto-resume'; s.buffer = (s.buffer + JSON.stringify(userMsg) + '\n').slice(-500000); feedLive(s, userMsg); } return true; } catch (e) { console.warn('[auto-resume] send failed:', e.message); return false; } } }); // continue a limited session when its quota resets ⇒ src/server/auto-resume.js
autoResume.start();
instanceUrl.registerRoutes(app); instanceUrl.restore(); Object.defineProperty(app.locals, 'instancePublicUrl', { get: () => { try { return instanceUrl.url(); } catch { return null; } } }); app.get('/api/port-forwards', (req, res) => res.json({ forwards: portForwards.list() }));
app.get('/api/hosts/:id/ports', async (req, res) => {
  // the UI path probes protocols (http/https/tcp chip); the watch sweep doesn't
  try { res.json({ ports: await portForwards.detect(req.params.id, { probe: true }) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/hosts/:id/port-forward', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await portForwards.forward(req.params.id, b.port, { label: b.label || '', targetHost: b.targetHost || '' }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/port-forward/:id', async (req, res) => {
  try { await portForwards.unforward(String(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
// public exposure (frp relay) — publish/unpublish a forward; body.sub = a
// user-chosen FIXED subdomain (2.358.0; blank keeps prior/random)
app.post('/api/port-forward/:id/publish', async (req, res) => {
  try { res.json(await portForwards.publish(String(req.params.id), { sub: (req.body || {}).sub })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/port-forward/:id/publish', async (req, res) => {
  try { await portForwards.unpublish(String(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
// main-domain PATH mount (2.358.0): /svc/<name>/ → the forward. body.public
// (2.359.0) = shareable WITHOUT login; default private, auth enforced
// per-mount inside path-mounts (the /svc prefix is middleware-exempt).
app.post('/api/port-forward/:id/path', (req, res) => {
  try { res.json(portForwards.setPathMount(String(req.params.id), (req.body || {}).name ?? null, { public: (req.body || {}).public })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/port-forward/:id/path', (req, res) => {
  try { res.json(portForwards.setPathMount(String(req.params.id), null)); } catch (e) { res.status(400).json({ error: e.message }); }
});
const pathMounts = require('./src/server/path-mounts.js').create({ getPortForwards: () => portForwards, requestAuthed: (req) => auth.requestAuthed(req) });
app.use('/svc', pathMounts.handler);
const publishedPages = require('./src/server/published-pages.js').create({ // 2.364.0 接管artifact: /p/<id> auth-exempt, gated PER PAGE in the module (CSP sandbox = the XSS guard); onPublished = the ONE notify point (dialog + agent publishes)
  dataDir: path.join(__dirname, 'data'), requestAuthed: (req) => auth.requestAuthed(req), log: (...a) => console.log(...a), publicUrl: () => instanceUrl.url(),
  onPublished: (page) => { const s2 = page.sessionId && activeSessions.get(page.sessionId); if (s2) broadcastToSession(s2, page.sessionId, { type: 'page-published', sessionId: page.sessionId, page }); },
});
const designKit = require('./src/server/design-kit.js').create({ dataDir: path.join(__dirname, 'data'), claudeCmd: () => CLAUDE_CMD, log: (...a) => console.log(...a) }); designKit.registerRoutes(app); setTimeout(() => designKit.ensure().catch(() => { }), 15000); publishedPages.registerRoutes(app); // 2.366.0: the /design kit from the INSTALLED CLI, adapted to publish here; warmed off the boot path
// protocol override: {proto: 'http'|'https'|'tcp'|null} (null = back to auto);
// a published forward is transparently re-published in the new mode
app.post('/api/port-forward/:id/proto', async (req, res) => {
  try { res.json(await portForwards.setProtoOverride(String(req.params.id), (req.body || {}).proto ?? null)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Kill a LOCAL orphaned listener (B-16d9): killOrphan re-verifies the
// deleted-cwd condition at kill time, so this can't target a healthy process.
app.post('/api/ports/kill-orphan', (req, res) => {
  try { res.json(portForwards.killOrphan((req.body || {}).pid)); } catch (e) { res.status(400).json({ error: e.message }); }
});
// On-demand EXIT (task #164): let an agent borrow a machine's network for a
// single command. Per-machine opt-in (hosts.allowExit, default off).
const { ExitProxyManager } = require('./src/exit-proxy');
const exitProxy = new ExitProxyManager({ hosts, log: (m) => console.log('[exit]', m) });
app.get('/api/exits', (req, res) => res.json({ exits: exitProxy.list() }));
app.post('/api/hosts/:id/allow-exit', (req, res) => {
  try {
    const on = !!(req.body || {}).on;
    hosts.setAllowExit(req.params.id, on);
    if (!on) exitProxy.onMachineUnpaired(req.params.id); // tearing down the egress when disabled
    bcastAll({ type: 'hosts-updated' }); // restored 2.343.2 — deleted as collateral of the exits-updated sweep; the toggle UI re-renders from this
    res.json({ success: true, allowExit: on });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ── Exit routes + RemoteFs singletons (src/server/exit-routes.js, decomposition #10) ──
const { exitAgentSession, remoteFs, sshKey,
} = require('./src/server/exit-routes.js').create({
  app, rootDir: __dirname, AGENT_BIN_DIR, activeSessions, auth, wss, WS_OPEN,
  bcastAll: (...a) => bcastAll(...a),
  integrationEnabled: (...a) => integrationEnabled(...a),
  unpairDialDevice: (...a) => unpairDialDevice(...a),
  hosts,
  getExitProxy: () => { try { return exitProxy; } catch { return null; } },
  getMounts: () => { try { return mounts; } catch { return null; } },
  getPortForwards: () => { try { return portForwards; } catch { return null; } },
});
const { readLayouts, writeLayouts, flushLayouts } = persistenceRouter;
// ── Mounts + plugins + dial-session wiring (src/server/mounts-plugins-wiring.js, decomposition #12) ──
const { mounts, plugins, dialBridge, graduateHostToDial, createSessionMessages, pluginLoader,
} = require('./src/server/mounts-plugins-wiring.js').create({
  app, server, rootDir: __dirname, HOST, PORT, BUFFERS_DIR, PERMISSION_MODES,
  auth, wss, WS_OPEN,
  bcastAll: (...a) => bcastAll(...a),
  serverSetting: (...a) => serverSetting(...a),
  mountTokens, persistenceRouter, hosts,
  agentdDials, agentdHostToken,
  agentdMintDialPair: (...a) => agentdMintDialPair(...a),
  deviceForDial: (...a) => deviceForDial(...a),
  ensureAgentdOnHost: (...a) => ensureAgentdOnHost(...a),
  getPortForwards: () => { try { return portForwards; } catch { return null; } }, instanceUrl, onMountsUpdated: () => tasks.syncAllContextMd(), activeSessions, getTelemetry: () => { try { return telemetry; } catch { return null; } },
});
// ── Session API (extracted to src/routes/sessions.js) ──
const { router: sessionsRouter, setup: setupSessions } = require('./src/routes/sessions');
setupSessions({ activeSessions, webuiPids, refreshWebuiPids, createSessionMessages, BUFFERS_DIR, PERMISSION_MODES, execFileSync, hosts, accounts, sessionAuth, serverSetting });
// Backend readiness for onboarding: is each CLI installed + logged in?
// Login detection is best-effort file existence — never spawns the CLIs.
app.get('/api/backend-status', async (req, res) => {
  // R1 (three-tier): the machine facts come from the SHARED probe module —
  // the same implementation the device daemon serves as `probe-cli` for
  // remote machines. This route is device #0's in-process call (CS amendment
  // #2: shared implementation, no socket transit). Orchestrator-only
  // composition (env-key overlay, named-account counts) layers on after.
  let out;
  try { out = await machineProbes.cliFacts({ claudeCmd: CLAUDE_CMD, codexCmd: CODEX_CMD }); } catch { out = { claude: {}, codex: {} }; }
  if (!out.claude.loggedIn && process.env.ANTHROPIC_API_KEY) { out.claude.loggedIn = true; out.claude.loginMethod = 'env-key'; }
  // Named-account nuance (2.267.1): under full pooling the MACHINE login
  // legitimately idles to token-less — count usable named identities so the
  // client can say what's actually true instead of "not logged in".
  try {
    const l = accounts.list();
    out.claude.namedLoggedIn = (l.accounts || []).filter((a) =>
      (a.backend || 'claude') === 'claude' && (a.loggedIn || (!a.pooled && a.type !== 'subscription' && a.tail))).length;
    if (out.codex) out.codex.namedLoggedIn = (l.accounts || []).filter((a) => a.backend === 'codex' && a.loggedIn).length; // onboarding readiness per backend (2.369.21)
  } catch {}
  res.json(out);
});

app.use(sessionsRouter);

// ── Usage / Rate Limit ──
// Usage / rate limits read NON-INVASIVELY from the OAuth token store. Cached,
// refreshed every ~5 min. See _fetchOAuthUsage below for the why.
// ── Usage / Rate Limit ── (extracted to src/usage-routes.js in the 2.92.0 split)
const { setupUsage } = require('./src/usage-routes');
const usage = setupUsage({ app, accounts, hosts, usageHistory, activeSessions, serverSetting, ensureDir, USAGE_CACHE_FILE, USAGE_CACHE_DIR, CODEX_SESSIONS_DIR, META_DIR, AVAILABLE_MODELS, BUFFERS_DIR, probeUsageForAccountKey, CLAUDE_CMD });

const { decideCliRefresh } = require('./src/account-pool-auto.js');
// ── auto-cli quota refresh loop (2.329.0, owner-approved after the ToS
// explicitly-permit argument; §ban-safety posture: the fetch is made by the
// official CLI exactly as if the user typed /usage — this instance never
// touches the vendor API). Setting accounts.onDemandQuotaRefresh='auto-cli';
// cadence is BURN-AWARE, not fixed: the dead-reckoner's own drift signal
// (est vs last reading) triggers refreshes within minutes during a fast
// workflow burst; idle accounts get a SLOW rung (owner-directed 2026-08-13):
// a reading older than a per-tick-randomized 30–60min threshold refreshes
// even with zero activity, so the roster never shows week-stale numbers —
// the wandering threshold avoids the metronomic fixed-interval pattern the
// ban postmortem flagged, and never-read accounts bootstrap their first
// reading through the same rung. One CLI spawn per tick, per-account 5min
// floor, exponential backoff on consecutive failures (an unparseable
// account must not spawn claude every 5min forever).
{
  const attempts = new Map(); // key → last attempt ts
  const fails = new Map(); // key → consecutive failures (backoff exponent)
  const jitter = 1 + Math.random() * 0.4; // per-boot 45–63min active-burn cap
  setInterval(async () => {
    try {
      if (serverSetting('accounts.onDemandQuotaRefresh') !== 'auto-cli') return;
      const now = Date.now();
      const list = [];
      for (const a of (accounts.list().accounts || [])) {
        if (a.type !== 'subscription' || !a.loggedIn || a.pooled || (a.backend || 'claude') !== 'claude') continue; // auto-cli spawns `claude -p /usage` — claude accounts only
        let raw = null;
        try { raw = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, a.id + '.json'), 'utf-8')); } catch { }
        try {
          for (const [, g] of usageIdentityGroupsCached()) {
            if (g.accountIds.includes(a.id) && g.cache && (g.cache.fetchedAt || 0) > (raw?.fetchedAt || 0)) { raw = g.cache; break; }
          }
        } catch { }
        // never-read accounts (no cache at all) ride the idle rung with fetchedAt 0 —
        // their first auto-cli read IS the bootstrap; failure backoff bounds retries
        const f = fails.get(a.id) || 0;
        if (f > 0 && now - (attempts.get(a.id) || 0) < 5 * 60e3 * Math.pow(2, Math.min(f, 6))) continue;
        let est = null; try { est = raw ? usageEstimator.estimateFor(a.id, raw, now) : null; } catch { }
        let drift = 0, moved = false;
        const cmp = (e, r) => { if (e && r && typeof e.utilization === 'number' && typeof r.utilization === 'number') { const d = Math.abs(e.utilization - r.utilization) * 100; drift = Math.max(drift, d); if (d > 0.2) moved = true; } };
        cmp(est?.fiveHour, raw?.fiveHour); cmp(est?.sevenDay, raw?.sevenDay);
        for (const s of est?.scopedWeekly || []) cmp(s, (raw?.scopedWeekly || []).find((x) => x.name === s.name));
        list.push({ key: a.id, fetchedAt: raw?.fetchedAt || 0, lastAttemptAt: attempts.get(a.id) || 0, estDriftPct: drift, activeBurn: moved });
      }
      // idle threshold re-rolls EVERY tick inside the owner's 30–60min band —
      // a wandering threshold, not a fixed cadence
      const idleMaxAgeMs = 30 * 60e3 * (1 + Math.random());
      const picks = decideCliRefresh(list, now, { maxAgeMs: 45 * 60e3 * jitter, idleMaxAgeMs });
      for (const key of picks) {
        attempts.set(key, now);
        const ok = await usage.refreshViaCliPanel(key).catch(() => false);
        fails.set(key, ok ? 0 : (fails.get(key) || 0) + 1);
        console.log(`[auto-cli] quota refresh ${key}: ${ok ? 'ok' : 'failed'} (drift ${Math.round(list.find((x) => x.key === key)?.estDriftPct || 0)}pt)`);
        global.__vsMetric?.('auto-cli-refresh-ms', 0);
      }
    } catch (e) { console.warn('[auto-cli] tick failed:', e.message); }
  }, 60000).unref();
}
// Normalizer-level settings reads (chat.hideEmptyHooks) go through the REAL store
MessageManager.getSetting = (k) => { try { return serverSetting(k); } catch { return undefined; } };
const { getOAuthToken, usagePollingEnabled, summarizeCodexRateLimit, summarizeCodexRateLimits } = usage;
app.locals.harnessAvailability = harnessAvailability; app.get('/api/available-models', (req, res) => { // S8: /api/home reads harnessAvailability (installed ACP harnesses for the picker)
  refreshCodexModels(); // mtime-guarded local read — stays current despite old-CLI cache rewrites
  res.json(AVAILABLE_MODELS);
});
app.get('/api/session-options', (req, res) => {
  res.json({ effortLevels: EFFORT_LEVELS, permissionModes: PERMISSION_MODES });
});

// ── WebSocket Terminal Handler (extracted to src/ws-handler.js) ──
const { registerWsHandler, noConvoRef, pickCodexThreadCandidate } = require('./src/ws-handler');
registerWsHandler(wss, {
  poolChooser: poolChooserForModel,
  sbNoteServerOp,
  otelEnv: otelIngest.envFor,
  agentdRemote: { ensureAgentdOnHost, agentdHostToken, agentdDir: AGENTD_DIR, attachBundle: path.join(__dirname, 'data', 'bin', 'vibespace-agentd-attach.js') },
  dialBridge,
  activeSessions, WS_OPEN, broadcastActiveSessions, broadcastToSession, resizeSessionToMin,
  setupSessionPty, refreshWebuiPids, deleteSessionMeta, writeSessionMeta, readSessionMeta, autoResume,
  readLayouts, writeLayouts, getSyncStore, serverSetting, integrationEnabled,
  sessionCounterRef, createSessionMessages,
  SOCKETS_DIR, BUFFERS_DIR, PTY_WRAPPER, CHAT_WRAPPER,
  NODE_CMD, DTACH_CMD, ENV_CMD, CLAUDE_CMD, EDITOR_CMD, AGENT_BIN_DIR, PORT, X_ENV,
  adapterRegistry, pty, path, fs, os, execFileSync, ensureDir, hosts,
  accounts, scheduleCtxSync, activeSessionsPayload, serverNotice,
  USAGE_STATUSLINE_CMD, userStatuslineCmd, telemetry, // telemetry: the ws switch's `default:` counts unknown message types (Plugin Ph1)
});

// Billing identity for the card badge. Precedence: env-key spawn (definite) →
// the CLI's OWN init statement (apiKeySource: 'none'=subscription OAuth,
// '/login managed key'=console login=API billing, 'ANTHROPIC_API_KEY'=env) →
// spawn-time global-login guess (marked guessed) → unknown. This is what tells
// the user WHICH sessions still burn API money after they re-login to the
// subscription: env-key/console sessions keep their auth for their lifetime.
function sessionAuth(s) {
  const be = s.backend || 'claude';
  // A remote session's billing identity lives ON ITS MACHINE — qualify every
  // auth object with the host name so a "CLI login" badge names WHICH
  // machine's login it is (2.188.0: a remote host-login session rendered
  // byte-identical to a local one, and the tooltip pointed at the wrong box).
  const hostName = s.host ? (() => { try { return hosts.get(s.host)?.name || s.host; } catch { return s.host; } })() : null;
  const withHost = (o) => (o && hostName ? { ...o, hostName } : o);
  // POOLED pseudo-account (B-6217; codex pools 2.368.20): ONE shape for both backends — the pool + the real account it currently
  // bills, so no chip mislabels it (real reports: claude pools rendered as 'API key', codex pools as a plain 'ChatGPT account', no target).
  const poolAuth = (a) => { let cur = null; try { const c = accounts.poolCurrentFor(a.id, s._webuiId || null); cur = c ? (accounts.get(c)?.name || null) : null; } catch {} return withHost({ source: 'pooled', name: a.name, poolTarget: cur }); }; // plan C: THIS session's link target (claude), else the pool default
  if (be === 'codex') {
    // Codex billing identity: named ChatGPT account (isolated CODEX_HOME), a codex pool, or the machine's own ~/.codex login.
    if (s._accountId) {
      const a = accounts.get(s._accountId);
      if (a && a.type === 'pooled') return poolAuth(a);
      return withHost({ source: 'codex-subscription', name: a?.name || 'ChatGPT' });
    }
    return withHost({ source: 'codex-cli' });
  }
  if (be !== 'claude') return null; // shell terminals — nothing billed
  if (s._accountId) {
    const a = accounts.get(s._accountId);
    if (a && a.type === 'pooled') return poolAuth(a);
    // A named SUBSCRIPTION account bills the subscription (not API) — show its
    // name, no amber key warning.
    if (a && (a.type || 'api') === 'subscription') return withHost({ source: 'subscription', name: a.name });
    return withHost({ source: 'api-key', name: a?.name || 'API key', tail: a?.tail || null });
  }
  const src = s._apiKeySource;
  if (src === 'none') return withHost({ source: 'subscription' });
  if (src === '/login managed key') return withHost({ source: 'api-console' });
  if (src === 'ANTHROPIC_API_KEY') return withHost({ source: 'api-key', name: 'env key' });
  if (typeof src === 'string' && src) return withHost({ source: 'api-other', detail: src });
  const at = s._authAtSpawn;
  if (at === 'subscription') return withHost({ source: 'subscription', guessed: true });
  if (at === 'console') return withHost({ source: 'api-console', guessed: true });
  if (at === 'env-key') return withHost({ source: 'api-key', guessed: true });
  // remote session with no explicit account: billed by the HOST's own CLI
  // login — a real subscription-or-key on that machine, never "unknown"
  // (2.188.0: remote TERMINAL sessions showed "KEY?" forever — apiKeySource
  // is chat-stream-only and the /proc backfill probes the LOCAL ssh wrapper).
  if (at === 'remote-global') return withHost({ source: 'subscription', guessed: true });
  return withHost({ source: 'unknown' });
}

// THE single active-sessions payload builder — used by every broadcast AND the
// per-connection initial snapshot (ws-handler). A second hardcoded field list
// anywhere means new fields silently vanish for freshly-(re)connected clients
// until the next organic broadcast (bit us twice: host badges, then auth/todo).
function activeSessionsPayload() {
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
      host: s.host || null,
      hostName: s.hostName || null,
      // transport truth for the card (2.219.1): a remote session whose local
      // wrapper is alive but whose HOST is unreachable used to show a plain
      // LIVE card — user read it as "conversable" while every input queued
      remoteState: (s._remoteState && s._remoteState.state !== 'connected') ? s._remoteState.state : null,
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
      // Billing identity badge: which account this session's env was spawned
      // with (null = the CLI's global login / subscription).
      accountId: s._accountId || null,
      accountName: s._accountId ? (accounts.get(s._accountId)?.name || 'API key') : null,
      accountTail: s._accountId ? (accounts.get(s._accountId)?.tail || null) : null,
      todo: s._todos || null, // {done, total, current} — the agent's own TodoWrite/plan
      auth: sessionAuth(s), // billing identity (subscription / api-console / api-key / unknown)
      mode: s.mode || 'terminal',
      outputStyle: s._outputStyle || null, // EFFECTIVE response style (2.369.58; null = the agent's own config decides) — Session Properties names the value AND its origin, which the saved PICK alone cannot
    });
  }
  return activeList;
}

function broadcastActiveSessions() {
  const msg = JSON.stringify({ type: 'active-sessions', sessions: activeSessionsPayload() });
  wss.clients.forEach(client => {
    if (client.readyState === WS_OPEN) {
      try { client.send(msg); } catch {}
    }
  });
}

// ── In-container desktop (noVNC through our own cookie auth — src/vnc.js) ──
const { VncManager } = require('./src/vnc');
const vnc = new VncManager({ dataDir: path.join(__dirname, 'data') });
app.get('/api/vnc/status', async (req, res) => {
  try { res.json(await vnc.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/vnc/start', async (req, res) => {
  try { res.json(await vnc.ensureRunning()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// RFB over WebSocket (websockify semantics: binary frames ↔ raw TCP). The
// bridge is the ONLY route to the localhost-bound VNC server, and it sits
// behind the same cookie auth as everything else — single login by design.
const vncWss = new WebSocketServer({ noServer: true });
const agentdDialWss = new WebSocketServer({ noServer: true }); // Transport B dial-in (2.144.0)
function bridgeVncSocket(ws) {
  const net = require('net');
  const sock = net.connect(vnc.port, '127.0.0.1');
  sock.on('data', (d) => {
    if (ws.readyState !== 1) return;
    ws.send(d);
    // Backpressure: a fast framebuffer + slow client would balloon the WS
    // buffer — pause the TCP side until the browser drains.
    if (ws.bufferedAmount > 8 * 1024 * 1024) {
      sock.pause();
      const t = setInterval(() => {
        if (ws.readyState !== 1) { clearInterval(t); return; }
        if (ws.bufferedAmount < 1024 * 1024) { clearInterval(t); sock.resume(); }
      }, 50);
    }
  });
  ws.on('message', (m) => { try { sock.write(m); } catch {} });
  ws.on('close', () => sock.destroy());
  ws.on('error', () => sock.destroy());
  sock.on('close', () => { try { ws.close(); } catch {} });
  sock.on('error', () => { try { ws.close(); } catch {} });
}

// ── Start Server ──
// THE single WebSocket upgrade dispatcher: /ws (main app), /proxy/ (unblocker
// site WebSockets), /api/vnc (desktop bridge). Everything else is destroyed.
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  const deny = () => { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); };
  if (pathname === '/ws') {
    if (!auth.requestAuthed(req)) return deny();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname.startsWith('/proxy/')) {
    if (!auth.requestAuthed(req)) return deny();
    unblocker.onUpgrade(req, socket, head);
  } else if (pathname === '/api/vnc') {
    if (!auth.requestAuthed(req)) return deny();
    vncWss.handleUpgrade(req, socket, head, (ws) => bridgeVncSocket(ws));
  } else if (pathname.startsWith('/svc/')) {
    // path-mounted service WebSockets — auth is PER MOUNT inside path-mounts
    // (2.359.0 public mounts; private ones 401 there)
    pathMounts.handleUpgrade(req, socket, head);
  } else if (pathname === '/api/device-dial' || pathname === '/api/agentd-dial') {
    // /api/device-dial is the name new pairing commands render;
    // /api/agentd-dial stays FOREVER — in-field daemons hold it in dial.json
    // Transport B: a remote device's daemon dialing IN. Gated by the per-device
    // dial token (never cookie auth — daemons have no cookies); real protocol
    // auth (vsht_ hello) happens inside the mux on this stream.
    const q = new URL(req.url, 'http://x').searchParams;
    const deviceId = String(q.get('device') || '').slice(0, 64);
    const tok = String(req.headers['x-vibespace-dial-token'] || '');
    const want = hosts.dialTokenHash(deviceId); // pairing credential lives on the host record (B-f3e8)
    const got = tok ? require('crypto').createHash('sha256').update(tok).digest('hex') : null;
    if (!deviceId || !want || got !== want) {
      // observability: a silently deny()'d redial is indistinguishable from
      // "no attempts" in the logs (bit us diagnosing the dead-Mac incident)
      console.log(`[device] dial REJECTED for '${deviceId || '?'}' — ${!deviceId ? 'no device id' : !want ? 'no pairing on record' : 'token mismatch'}`);
      return deny();
    }
    agentdDialWss.handleUpgrade(req, socket, head, (ws) => {
      // adapt the ws to the duplex shape Mux consumes
      const listeners = { data: [], close: [], error: [] };
      ws.on('message', (d) => listeners.data.forEach((f) => f(Buffer.isBuffer(d) ? d : Buffer.from(d))));
      ws.on('close', () => listeners.close.forEach((f) => f()));
      ws.on('error', () => listeners.error.forEach((f) => f()));
      const stream = {
        write: (d) => { try { ws.send(d); return true; } catch { return false; } },
        on: (ev, fn) => { listeners[ev]?.push(fn); },
        destroy: () => { try { ws.close(); } catch { } },
      };
      agentdDials.set(deviceId, stream);
      // the device re-dialed with a FRESH stream — drop any cached
      // DeviceManager bound to the previous (dead) stream so the next op
      // rebuilds over this one (stale-stream blank-session fix)
      try { const old = agentdDialDevices.get(deviceId); if (old && old._dialStream !== stream) { old.stop?.(); agentdDialDevices.delete(deviceId); } } catch { }
      try { hosts.invalidateDevice?.('host-dial-' + String(deviceId).replace(/[^\w-]/g, '')); } catch { }
      try { hosts.onDialIn?.(deviceId); } catch { } // graduated ssh host: prefer this fresh dial link (B-6640)
      console.log(`[device] device '${deviceId}' dialed in`);
      // heal recorded pull mounts + re-own push tunnel ports + flip the UI dot
      try { machineMounts.onMachineLinked(hosts.findByDeviceId(deviceId)?.id); } catch { }
      try { portForwards.onMachineLinked(hosts.findByDeviceId(deviceId)?.id); } catch { }
      // Re-own each live dial session's VIBESPACE_API back-tunnel (audit #49):
      // the per-session reverse listener existed only in the DEAD link's
      // DeviceManager — mounts/port-forwards heal from persisted records on
      // dial-in, sessions had none, so vibespace-status/task/ask + remote
      // Ctrl+G went connection-refused forever after any re-dial or server
      // restart while the session kept chatting fine (nothing surfaced it).
      // The daemon's reverseListen `existing` branch re-owns a still-bound
      // port; a reaped one (>10min offline) rebinds at the same number.
      (async () => {
        const netR = require('net');
        for (const [, s] of activeSessions) {
          if (s._dialDeviceId !== deviceId || !s._dialReversePort) continue;
          try {
            const dm = await deviceForDial(deviceId);
            await dm.reverseForward({ port: s._dialReversePort, connectLocal: () => netR.connect(PORT, '127.0.0.1') });
          } catch (e) { console.warn(`[device] session back-tunnel re-own failed (${s._dialReversePort}):`, e.message); }
        }
      })().catch(() => { });
      try { bcastAll({ type: 'hosts-updated' }); } catch { }
      ws.on('close', () => {
        if (agentdDials.get(deviceId) === stream) agentdDials.delete(deviceId);
        try { bcastAll({ type: 'hosts-updated' }); } catch { }
      });
    });
  } else {
    socket.destroy();
  }
});

// ── Ops routes (src/server/ops-routes.js, decomposition #11): version/update/maintenance ──
const { versionInfo, maintState,
} = require('./src/server/ops-routes.js').create({ app, rootDir: __dirname, wss, WS_OPEN });
// ── Prometheus /metrics exporter (opt-in, generic): a SEPARATE listener on
// VIBESPACE_METRICS_PORT, meant for in-cluster scrapes via pod annotations —
// it is never routed through the app ingress/auth, so keep the port un-exposed
// in any public deployment. Hand-rolled text exposition, no dependencies.
const METRICS_PORT = Number(process.env.VIBESPACE_METRICS_PORT || 0);
if (METRICS_PORT > 0) {
  const metricsStarted = Date.now();
  const pkgVersion = (() => { try { return require('./package.json').version; } catch { return ''; } })();
  http.createServer((mreq, mres) => {
    if (!String(mreq.url).startsWith('/metrics')) { mres.writeHead(404); return mres.end(); }
    let watchers = 0, normMsgs = 0;
    try { for (const [, sess] of activeSessions) { watchers += sess.subagentWatchers?.size || 0; normMsgs += sess._normalizer?.total || 0; } } catch {}
    const mu = process.memoryUsage();
    const L = [];
    const g = (name, val, help) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${val}`); };
    g('vibespace_process_resident_memory_bytes', mu.rss, 'Server process RSS');
    g('vibespace_nodejs_heap_used_bytes', mu.heapUsed, 'V8 heap used');
    g('vibespace_nodejs_heap_total_bytes', mu.heapTotal, 'V8 heap total');
    g('vibespace_live_sessions', activeSessions.size, 'Active (webui-managed) sessions');
    g('vibespace_ws_clients', (typeof wss !== 'undefined' && wss.clients) ? wss.clients.size : 0, 'Connected WebSocket clients');
    g('vibespace_subagent_watchers', watchers, 'Live subagent fs watchers (leak canary)');
    g('vibespace_normalizer_messages', normMsgs, 'Normalized messages held in memory (leak canary)');
    g('vibespace_uptime_seconds', Math.round((Date.now() - metricsStarted) / 1000), 'Server uptime');
    L.push('# HELP vibespace_info Build info', '# TYPE vibespace_info gauge', `vibespace_info{version="${pkgVersion}"} 1`);
    mres.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    mres.end(L.join('\n') + '\n');
  }).listen(METRICS_PORT, () => console.log(`  metrics exporter on :${METRICS_PORT}`));
}

server.listen(PORT, HOST, () => {
  const ver = require('./package.json').version;
  console.log(`\n  VibeSpace v${ver} running at http://localhost:${PORT}`);
  // PID file for the supervised-restart path (scripts/update.sh in a container:
  // no systemd — the entrypoint respawn loop restarts us when update.sh kills
  // this pid; dtach sessions live in the same PID namespace and survive).
  try { fs.writeFileSync(path.join(__dirname, 'data', 'server.pid'), String(process.pid)); } catch {}
  setTimeout(() => jobsWiring.initAfterListen(), 1500); // Background Work engine: adopt-first, never blocks boot
  console.log(`  dtach: ${DTACH_CMD}, node: ${NODE_CMD}, env: ${ENV_CMD}, claude: ${CLAUDE_CMD}, codex: ${CODEX_CMD}`);
  if (process.platform === 'linux') console.log(`  X display: ${X_ENV.DISPLAY || '(none)'}${X_ENV.XAUTHORITY ? ' (xauth: ' + X_ENV.XAUTHORITY + ')' : ''} — clipboard image paste ${X_ENV.probed ? 'ready' : 'UNAVAILABLE (no working X display found)'}`);

  // Local sessions run through the device daemon (machine #0) — GRADUATED,
  // no flag: bring it up BEFORE restore so re-adopted sessions attach through
  // it too. attachToDtach still falls back to a local pty on ANY failure.
  {
    try {
      const { DeviceManager } = require('./src/agentd/client.js');
      deviceMgr = new DeviceManager({
        dataDir: path.join(__dirname, 'data'),
        bundlePath: path.join(__dirname, 'data', 'bin', 'vibespace-agentd.js'),
        version: require('./package.json').version,
        nodeModules: path.join(__dirname, 'node_modules'),
        log: console.log,
      });
      // device #0 becomes reachable through hosts.device(null) — that is what
      // lets a consumer be written ONCE and run on ANY machine including this
      // one (CS separation, 2.276.0). Wired BEFORE connect so a consumer that
      // races startup gets the handle and awaits its connect like any other.
      try { hosts.setLocalDevice(deviceMgr); } catch { }
      deviceMgr.connect().then(() => console.log('  device-daemon: device session routing ENABLED')).catch((e) => {
        console.warn('  device-daemon: could not reach the daemon — local pty fallback:', e.message);
        deviceMgr = null; // fall back cleanly
        try { hosts.setLocalDevice(null); } catch { } // consumers fall back to their legacy local path
      });
    } catch (e) { console.warn('  device-daemon: init failed — local pty fallback:', e.message); deviceMgr = null; }
  }

  // Restore existing dtach sessions from before restart
  // One-shot data migrations (src/server/migrations.js, plan B step 1): the
  // ledger-driven registry runs BEFORE any session restore touches the data
  // it may reshape. Failures notice + retry next boot, never block startup.
  try { require('./src/server/migrations.js').create({ rootDir: __dirname, serverNotice }).runLocalMigrations(); }
  catch (e) { console.warn('[migrate] local registry failed to run:', e.message); }
  migrateLegacyHomeProjects();
  restoreSessions();
  // Plan C boot reconciliation: a per-session pool link whose session did not
  // survive the restart is a billing pointer nobody can see or move — unlink.
  try { const n = accounts.sweepSessionPoolLinks(new Set(activeSessions.keys())); if (n) console.log(`[pool] swept ${n} orphaned per-session link(s)`); } catch { }
  // B-1525 second half: consume the .orphan metas the dead-socket cleanup
  // preserved — remote keeper sessions whose claude is STILL ALIVE on its
  // host come back LIVE by themselves (no manual surgery). Runs even on a
  // zero-socket boot (the pod-recreation case restoreSessions early-returns
  // on); delayed off the boot critical path; probes are read-only ssh.
  setTimeout(() => { readoptOrphanKeeperSessions().catch((e) => console.warn('[readopt] failed:', e.message)); }, 8000);

  // Orphan sweep — AGE-BASED (2.89.1). The activeSessions-keyed sweep was a
  // real data-loss race: a live dtach session the restore didn't re-adopt
  // within 30s (or re-adopted under a different id after meta corruption) had
  // its buffer UNLINKED while the wrapper kept writing the deleted inode —
  // live streaming looked fine, but every restart rebuilt history without the
  // buffer ("重启之后消息就都没了", real incident). Dead buffers stop being
  // WRITTEN, so age is race-free by construction: only files untouched for
  // 7 days are ever deleted, and never for a currently-active session.
  setTimeout(() => {
    let swept = 0;
    const cutoff = Date.now() - 7 * 86400000;
    try {
      for (const fn of fs.readdirSync(BUFFERS_DIR)) {
        const m = fn.match(/^(.+)\.(buf|json)$/);
        if (!m || activeSessions.has(m[1])) continue;
        try {
          const st = fs.statSync(path.join(BUFFERS_DIR, fn));
          if (st.mtimeMs > cutoff) continue; // recently written → possibly a live-but-unadopted session
          fs.unlinkSync(path.join(BUFFERS_DIR, fn)); swept++;
        } catch {}
      }
    } catch {}
    // data/agentd/session-*.json attach configs (0600, vsht_ host token +
    // full spawn command) — the kill-path unlink needs the live session, so
    // pod recreation leaked one per dial/agentd session forever (audit
    // #16/#53). Same age rule: written once at create, so 7d + not-active is
    // race-free (active sessions are protected by the id check alone).
    try {
      for (const fn of fs.readdirSync(AGENTD_DIR)) {
        const m = fn.match(/^session-(.+)\.json$/);
        if (!m || activeSessions.has(m[1])) continue;
        try {
          const st = fs.statSync(path.join(AGENTD_DIR, fn));
          if (st.mtimeMs > cutoff) continue;
          fs.unlinkSync(path.join(AGENTD_DIR, fn)); swept++;
        } catch {}
      }
    } catch {}
    // data/chat-frames: the NEW wrapper unlinks after forwarding; a frame sent
    // to a pre-2.360.0 wrapper is orphaned forever (2.361.1 skew incident) —
    // age-based like everything else here, 48h is far past any redelivery use.
    try {
      const fdir = path.join(__dirname, 'data', 'chat-frames');
      const fcut = Date.now() - 48 * 3600 * 1000;
      for (const fn of fs.readdirSync(fdir)) {
        try { if (fs.statSync(path.join(fdir, fn)).mtimeMs < fcut) { fs.unlinkSync(path.join(fdir, fn)); swept++; } } catch {}
      }
    } catch {}
    if (swept) console.log(`  Swept ${swept} orphaned session-buffer/attach-cfg/chat-frame files (age-based)`);
  }, 30000);

  console.log(`  Ready.\n`);
});

// On server shutdown: only kill the attach PTYs, NOT the dtach sessions
// Claude processes in dtach survive the server restart
function shutdown() {
  for (const [, s] of activeSessions) { try { if (s.pty) s.pty.kill(); } catch {} }
  // SyncStores + layouts persist on a debounce — flush so changes made within
  // the last couple seconds aren't lost across a restart
  for (const store of Object.values(syncStores)) { try { store.flush(); } catch {} }
  try { flushLayouts(); } catch {}
  try { sessionStatus.flush(); } catch {} // debounced session-status writes
  try { userTodos.flush(); } catch {} // debounced user-todo writes
  try { telemetry.flush(); } catch {} // buffered telemetry records (2.219.0)
  try { sysinfo.persistHistory(); } catch {} // resource-history ring (2.223.0)
  try { jobsWiring.shutdown(); try { deliver.flush(); } catch { }; } catch {} // jobs store flush + engine lock release
  process.exit(0);
}
process.on('SIGINT', () => {
  console.log('\n  Shutting down (dtach sessions will keep running)...');
  shutdown();
});
process.on('SIGTERM', shutdown);
