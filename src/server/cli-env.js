'use strict';
// CLI ENVIRONMENT (decomposition #14): X display detection + xauth
// stabilization (clipboard image paste), the adapter registry, CLI capability
// probes (PERMISSION_MODES / EFFORT_LEVELS / --name support), and the model
// registry (known baseline + passive discovery via noteModelSeen +
// /v1/models refresh). Extracted VERBATIM. ORCH tier.
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { createAdapterRegistry } = require('../adapters');
const { capsOf, setVerifiedCap } = require('../backend-caps');

function create({ rootDir, CLAUDE_CMD_RAW, CODEX_CMD_RAW, resolveCmd,
  getOAuthToken, usagePollingEnabled, refreshCodexModels, broadcast = null,
  getTelemetry = () => null, getSetting = () => undefined }) {
  const USAGE_CACHE_DIR = path.join(rootDir, 'data', 'usage-cache');
// ── X display detection (Linux clipboard / xclip) ──
// The inherited DISPLAY is unreliable: the server is often (re)started from
// shells with a stale value (e.g. :99 with no X server behind it), and under
// XWayland the display also needs the compositor's XAUTHORITY cookie — without
// it even the right display number fails. Probe candidates at startup and use
// the first {DISPLAY, XAUTHORITY} pair that actually answers; this env is used
// for the server's own xclip calls AND injected into spawned sessions (the CLI
// reads the clipboard itself on Ctrl+V).
function detectXDisplay() {
  if (process.platform !== 'linux') return { DISPLAY: process.env.DISPLAY || '', XAUTHORITY: process.env.XAUTHORITY || '' };
  const displays = [];
  if (process.env.DISPLAY) displays.push(process.env.DISPLAY);
  try {
    for (const f of fs.readdirSync('/tmp/.X11-unix')) {
      if (/^X\d+$/.test(f)) { const d = ':' + f.slice(1); if (!displays.includes(d)) displays.push(d); }
    }
  } catch {}
  const xauths = [];
  if (process.env.XAUTHORITY) xauths.push(process.env.XAUTHORITY);
  try {
    const rd = `/run/user/${process.getuid()}`;
    for (const f of fs.readdirSync(rd)) {
      // .mutter-Xwaylandauth.XXXXXX, Xauthority, xauth_XXXXXX (sddm), …
      // NOTE: "Xwaylandauth" does NOT contain the substring "xauth" — match "auth"
      if (/auth/i.test(f)) xauths.push(path.join(rd, f));
    }
  } catch {}
  xauths.push(path.join(os.homedir(), '.Xauthority'));
  const xauthCandidates = ['', ...xauths.filter((p, i, a) => p && a.indexOf(p) === i && fs.existsSync(p))];
  const xsetCmd = resolveCmd('xset');
  for (const d of displays) {
    for (const xa of xauthCandidates) {
      try {
        execFileSync(xsetCmd, ['q'], {
          env: { ...process.env, DISPLAY: d, ...(xa ? { XAUTHORITY: xa } : {}) },
          timeout: 1500, stdio: 'ignore',
        });
        return stabilizeXAuth({ DISPLAY: d, XAUTHORITY: xa, probed: true });
      } catch {}
    }
  }
  return { DISPLAY: process.env.DISPLAY || '', XAUTHORITY: process.env.XAUTHORITY || '', probed: false }; // best effort
}
// Compositor restarts mint a NEW per-instance cookie file
// (.mutter-Xwaylandauth.XXXXXX) while every already-running session keeps the
// OLD path in its env — the clipboard silently dies for all of them (real
// incident 2026-07-09: an Xwayland restart at 18:42 broke image paste in 11
// live sessions at once). Stabilize: merge the working cookie into
// ~/.Xauthority and hand THAT path to sessions — processes re-open the auth
// file on every X request, so after a future rotation one refreshXEnv() merge
// heals everything, old sessions included, without respawns.
function stabilizeXAuth(found) {
  if (!found.probed || !found.XAUTHORITY) return found;
  const home = path.join(os.homedir(), '.Xauthority');
  if (found.XAUTHORITY === home) return found;
  try {
    execFileSync(resolveCmd('xauth'), ['merge', found.XAUTHORITY], {
      env: { ...process.env, XAUTHORITY: home }, timeout: 3000, stdio: 'ignore',
    });
    // switch to the stable path only if it actually answers
    execFileSync(resolveCmd('xset'), ['q'], {
      env: { ...process.env, DISPLAY: found.DISPLAY, XAUTHORITY: home }, timeout: 1500, stdio: 'ignore',
    });
    return { ...found, XAUTHORITY: home };
  } catch { return found; }
}
// ONE mutable object — ws-handler and app.locals hold references to it, so a
// refresh propagates everywhere (new spawns + the paste route) without rewiring.
const X_ENV = detectXDisplay();
function refreshXEnv() { Object.assign(X_ENV, detectXDisplay()); return X_ENV; }
const CLAUDE_CMD = CLAUDE_CMD_RAW.startsWith('/') ? CLAUDE_CMD_RAW : resolveCmd(CLAUDE_CMD_RAW);
const CODEX_CMD = CODEX_CMD_RAW.startsWith('/') ? CODEX_CMD_RAW : resolveCmd(CODEX_CMD_RAW);
// codex 0.153 thread/read fallback (B-21e4 item 5): the codex store's warmTranscript may run ONE
// bounded `codex app-server` read for a thread with no rollout file here — wired where the
// command is resolved (disabled when codex is absent; server.js stays bootstrap-sized)
require('../codex-thread-read').configure({ codexCmd: CODEX_CMD || null, enabled: !!CODEX_CMD });
const CLAUDE_SUBSCRIPTION_LOGIN_HELPER = path.join(rootDir, 'data', 'bin', 'vibespace-claude-subscription-login.mjs');
const CODEX_LINUX_SANDBOX_CMD = resolveCmd('codex-linux-sandbox');
// FUNCTIONAL probe (2.369.17): the PATH lookup above said "not found" on every
// npm install (the vendor dir ships only `codex`; the sandbox is the main
// binary re-exec'd), so TERMINAL codex at 'default' silently ran
// danger-full-access while CHAT was sandboxed. Assume supported until the
// async `codex sandbox -- true` answers; a failing probe flips the adapter
// to the degraded (unsandboxed, notified) path exactly as before.
const CODEX_SANDBOX_SUPPORTED = true;
function probeCodexSandbox(registry) {
  if (process.platform !== 'linux' || !CODEX_CMD) return;
  execFile(CODEX_CMD, ['sandbox', '--', 'true'], { timeout: 20000, env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } }, (err) => {
    const ok = !err;
    const ad = registry.get('codex');
    if (ad?.config) ad.config.codexSandboxSupported = ok;
    if (!ok) console.log(`[codex] sandbox probe failed (${err.code || err.message}); default/safe-yolo sessions will run unsandboxed.`);
  });
}
// ACP harnesses (S8): each descriptor names its executable; resolve it ONCE
// here (null = not installed → the New Session dialog hides the backend and a
// create fails loudly). Env override per harness: <ID>_CMD (OPENCODE_CMD).
const { list: listHarnesses } = require('../harnesses');
const ACP_COMMANDS = {};
for (const h of listHarnesses()) {
  if (!h.acp) continue;
  const raw = process.env[h.id.toUpperCase().replace(/-/g, '_') + '_CMD'] || h.acp.command;
  ACP_COMMANDS[h.id] = raw.startsWith('/') ? raw : (resolveCmd(raw) || null);
}
const adapterRegistry = createAdapterRegistry({
  claudeCmd: CLAUDE_CMD,
  codexCmd: CODEX_CMD,
  codexSandboxSupported: CODEX_SANDBOX_SUPPORTED,
  chatWrapper: path.join(rootDir, 'data', 'bin', 'chat-wrapper.js'),
  codexChatWrapper: path.join(rootDir, 'data', 'bin', 'codex-chat-wrapper.js'),
  acpWrapper: path.join(rootDir, 'data', 'bin', 'acp-wrapper.js'),
  acpCommands: ACP_COMMANDS,
  ptyWrapper: path.join(rootDir, 'data', 'bin', 'pty-wrapper.js'),
  buffersDir: path.join(rootDir, 'data', 'session-buffers'),
});
/** Installed-state per harness for the client (New Session backend picker).
 *  ACP harnesses also carry their RUNTIME-VERIFIED feature caps (S9: opencode
 *  fork = the serve OpenAPI evidence) so the client's BACKEND_META merges the
 *  verdict instead of shipping a guess. */
function harnessAvailability() {
  return listHarnesses().map((h) => {
    const row = { id: h.id, label: h.label, kind: h.kind, installed: h.acp ? !!ACP_COMMANDS[h.id] : true, ...(h.acp ? { caps: { fork: !!capsOf(h.id).fork } } : {}) };
    // A harness whose STORE is broken must say so where the user looks (the
    // 2.369.42 runaway burned for two hours in silence): parked/runaway =>
    // the reason travels with /api/home and the harness-store-updated push.
    try { const st = h.store?.serveState?.(); if (st && (st.parked || st.autostart === false) && h.store.unavailableReason) row.storeReason = String(h.store.unavailableReason()); } catch { }
    return row;
  });
}
// ── OpenCode serve locator (S9, B-03f2): the opencode harness's STORE facts
// come from ONE `opencode serve` instance per VibeSpace — reused from
// data/opencode-serve.json when it still answers, else started LAZILY on the
// first discovery (never at boot) under agentEnv(), kept by the module's own
// keeper (backoff, parked after 5 crashes, stopped on exit). The fork verdict
// from its OpenAPI flips capsOf('opencode').fork and is BROADCAST so open
// clients learn it without a reload (the cache-invalidation-must-notify law).
// Autostart, in precedence order (2.369.45 — the env switch AND the setting are
// both honoured): VIBESPACE_OPENCODE_SERVE=0/1 (explicit, wins over everything)
// > the test-harness belt VIBESPACE_SKIP_AGENT_HOOKS=1 forces OFF (every
// worktree smoke sets it and SIGKILLs its server — a spawned serve would
// outlive that kill and pile up on the dev box) > the SETTING
// agents.opencodeServeAutostart (default ON = the shipped behaviour). Read
// through a FUNCTION so a live settings change takes effect without a restart.
// Reuse of an already-running recorded instance still works with autostart off.
const OPENCODE_SERVE_ENV = process.env.VIBESPACE_OPENCODE_SERVE ? process.env.VIBESPACE_OPENCODE_SERVE !== '0'
  : (process.env.VIBESPACE_SKIP_AGENT_HOOKS === '1' ? false : null);
const opencodeServeAutostart = () => (OPENCODE_SERVE_ENV !== null ? OPENCODE_SERVE_ENV : getSetting('agents.opencodeServeAutostart') !== false);
let _opencodeStoreReason = null;
const opencodeServe = require('../opencode-serve').install({
  dataDir: path.join(rootDir, 'data'),
  command: () => ACP_COMMANDS.opencode || null,
  env: () => require('../ws-handler').agentEnv(),
  log: console,
  stopOnExit: true,
  autostart: opencodeServeAutostart,
  telemetry: (ev) => { try { getTelemetry()?.record({ kind: 'event', ...ev }); } catch { } },
  onCaps: (caps) => {
    setVerifiedCap('opencode', 'fork', !!caps.fork);
    try { broadcast?.({ type: 'harness-caps-updated', backend: 'opencode', caps: { fork: !!caps.fork } }); } catch { }
  },
  // the runaway/park state is a USER-VISIBLE fact, not just telemetry: push it
  // the moment it changes so open clients show it without a reload
  onState: (st) => {
    const reason = st.parked ? (harnessOf('opencode')?.store?.unavailableReason?.() || st.lastError || null) : null;
    if (reason === _opencodeStoreReason) return;
    _opencodeStoreReason = reason;
    try { broadcast?.({ type: 'harness-store-updated', backend: 'opencode', parked: !!st.parked, parkedKind: st.parkedKind || null, reason }); } catch { }
  },
});
function harnessOf(id) { try { return require('../harnesses').get(id); } catch { return null; } }

probeCodexSandbox(adapterRegistry);

// Parse available permission modes, effort levels, and supported flags from claude --help
let PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'];
// The effortLevel enum (parsed from `claude --help` below, which lists it on a
// wrapped line: "(low, medium, high, xhigh, max)"). This is the fallback if the
// parse ever fails — keep it matching. NOTE: "ultracode" is deliberately NOT
// here — it's not an effortLevel value but a separate session mode (xhigh +
// dynamic-workflow orchestration), appended as a pseudo-level client-side.
let EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
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
const CLAUDE_MODEL_ALIASES = [
  { id: '', label: 'Default' },
  { id: 'fable', label: 'fable (latest, 200k)' },
  { id: 'fable[1m]', label: 'fable[1m] (latest, 1M context)' },
  { id: 'opus', label: 'opus (latest, 200k)' },
  { id: 'opus[1m]', label: 'opus[1m] (latest, 1M context)' },
  { id: 'sonnet', label: 'sonnet (latest)' },
  { id: 'sonnet[1m]', label: 'sonnet[1m] (latest, 1M context)' },
  { id: 'haiku', label: 'haiku (latest)' },
];
// Known GA full model ids — the BASELINE the dropdown always carries.
// The passive statusline discovery only learns models that have SERVED a
// LOCAL TERMINAL session here (real report: the list held Opus 4.8 —
// once seen — but never Opus 5), and the /v1/models fetch is §ban-safety
// opt-in. A new tier ships → add it here (same convention as the aliases).
// No context-size claims on these labels: a full id can serve the long
// context (a claude-opus-5 session was observed at 222k/1M under an old
// "(200k)" label) — the status bar derives the real window from usage.
const CLAUDE_KNOWN_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];
// Served-model passive discovery: EVERY session's assistant records name the
// model that actually served — feed the same __models__.json the statusline
// hook writes, so chat/remote sessions teach the dropdown too (both writers
// preserve-merge; ingestPassiveModels picks it up within ~30s).
const _modelsSeenRam = new Set();
function noteModelSeen(id) {
  if (!id || typeof id !== 'string' || id === '<synthetic>' || _modelsSeenRam.has(id)) return;
  _modelsSeenRam.add(id);
  try {
    const fp = path.join(USAGE_CACHE_DIR, '__models__.json');
    let list = [];
    try { list = JSON.parse(fs.readFileSync(fp, 'utf-8')) || []; } catch { }
    if (!list.some((m) => m && m.id === id)) {
      list.push({ id, label: id.replace(/^claude-/, '').replace(/-(\d{8})$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) });
      fs.writeFileSync(fp, JSON.stringify(list));
    }
  } catch { }
}
const AVAILABLE_MODELS = {
  claude: [...CLAUDE_MODEL_ALIASES, ...CLAUDE_KNOWN_MODELS],
  codex: [{ id: '', label: 'Default' }],
};
for (const id of Object.keys(ACP_COMMANDS)) AVAILABLE_MODELS[id] = [{ id: '', label: 'Default' }];
// ACP harnesses learn their model list from the AGENT (session config
// options at session/new) — the stdout consumer feeds it here so the
// dropdowns/settings offer what the agent actually serves (union, in-memory).
function noteHarnessModels(backend, models) {
  if (!backend || !Array.isArray(models) || !models.length || !(backend in ACP_COMMANDS)) return;
  const cur = new Map((AVAILABLE_MODELS[backend] || []).filter((m) => m && m.id).map((m) => [m.id, m]));
  for (const m of models) if (m && m.id) cur.set(String(m.id), { id: String(m.id), label: m.label || String(m.id) });
  AVAILABLE_MODELS[backend] = [{ id: '', label: 'Default' }, ...cur.values()];
}
function refreshAvailableModels() {
  // /v1/models accepts both auth schemes now (OAuth needs Bearer + the oauth
  // beta header — it used to 401, fixed server-side ~2026-06). The old
  // bootstrap endpoint's additional_model_options now returns null, so
  // /v1/models is the single source for full model IDs; CLI aliases
  // (fable/opus/sonnet/haiku) stay hardcoded since they're CLI-side names.
  function fetchModels(token, useOAuth) {
    const headers = { 'anthropic-version': '2023-06-01' };
    if (useOAuth) {
      headers['Authorization'] = 'Bearer ' + token;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      headers['x-api-key'] = token;
    }
    const req = https.request('https://api.anthropic.com/v1/models?limit=100', {
      method: 'GET', headers,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.data?.length) {
            const models = data.data.map(m => {
              const ctx = m.max_input_tokens >= 1000000 ? '1M' : m.max_input_tokens >= 200000 ? '200k' : Math.round(m.max_input_tokens / 1000) + 'k';
              return { id: m.id, label: `${m.display_name || m.id} (${ctx})` };
            });
            const known = CLAUDE_KNOWN_MODELS.filter((k) => !models.some((m) => m.id === k.id));
            AVAILABLE_MODELS.claude = [...CLAUDE_MODEL_ALIASES, ...known, ...models];
          } else if (res.statusCode !== 200) {
            console.warn(`[models] /v1/models failed: HTTP ${res.statusCode}`);
          }
        } catch {}
      });
    });
    req.on('error', () => {});
    req.end();
  }

  // §ban-safety: a /v1/models fetch with the OAuth (subscription) token is the
  // same off-CLI background-call pattern as the usage poll, so it's gated behind
  // the SAME opt-in. Default OFF → the dropdown falls back to the hardcoded CLI
  // aliases (fable/opus/sonnet/haiku[+1m]); only full model IDs are missed, and
  // "Custom…" still lets you type one. An API KEY (sanctioned) is always used.
  const apiKey = process.env.ANTHROPIC_API_KEY || null;
  if (apiKey) {
    fetchModels(apiKey, false);
  } else if (usagePollingEnabled()) {
    getOAuthToken((oauthToken) => { if (oauthToken) fetchModels(oauthToken, true); });
  }
  refreshCodexModels();
}

  return { X_ENV, detectXDisplay, refreshXEnv, stabilizeXAuth, adapterRegistry,
    CLAUDE_CMD, CODEX_CMD, CODEX_LINUX_SANDBOX_CMD, CODEX_SANDBOX_SUPPORTED,
    CLAUDE_SUBSCRIPTION_LOGIN_HELPER, CLAUDE_SUPPORTS_NAME, PERMISSION_MODES,
    EFFORT_LEVELS, CLAUDE_MODEL_ALIASES, CLAUDE_KNOWN_MODELS, AVAILABLE_MODELS,
    noteModelSeen, refreshAvailableModels, ACP_COMMANDS, harnessAvailability, noteHarnessModels, opencodeServe };
}
module.exports = { create };
