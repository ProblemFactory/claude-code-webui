'use strict';
// Codex harness descriptor (S1).
const { BACKEND_CAPS } = require('../backend-caps');
const { CodexAdapter } = require('../adapters/codex');
const { findCodexSessionJsonlPath, extractCodexThreadMeta } = require('../adapters/codex');
const { CodexMessageManager } = require('../codex-message-manager');
const codexStore = require('../codex-session-store');
const { writerSweepScript } = require('../writer-sweep');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Decode a JWT payload without verifying (identity display only — never trust
// for auth). Returns {} on any malformation.
function jwtPayload(tok) {
  try { const seg = String(tok).split('.')[1]; return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) || {}; } catch { return {}; }
}
/** Read-only parse of a codex auth.json (never refreshes): loggedIn + auth
 *  mode + identity (email/plan) from the id_token claims. `subscriptionType`
 *  mirrors `plan` so every harness reports the same shape. */
function parseCodexAuthFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const mode = raw.auth_mode || (raw.tokens ? 'chatgpt' : (raw.OPENAI_API_KEY ? 'apikey' : null));
    const hasTok = !!(raw.tokens?.access_token || raw.tokens?.id_token || raw.OPENAI_API_KEY);
    if (!hasTok) return { loggedIn: false };
    let email = null, plan = null;
    if (raw.tokens?.id_token) {
      const c = jwtPayload(raw.tokens.id_token);
      email = c.email || null;
      const auth = c['https://api.openai.com/auth'] || {};
      plan = auth.chatgpt_plan_type || auth.plan_type || null;
    }
    return { loggedIn: true, authMode: mode, email, plan, subscriptionType: plan };
  } catch { return { loggedIn: false }; }
}
const parseCodexAuth = (dir) => parseCodexAuthFile(path.join(dir, 'auth.json'));

module.exports = {
  id: 'codex',
  label: 'Codex',
  kind: 'chat',
  caps: BACKEND_CAPS.codex,
  Adapter: CodexAdapter,
  adapterConfig: (cfg) => ({ codexCmd: cfg.codexCmd, codexSandboxSupported: cfg.codexSandboxSupported, chatWrapper: cfg.codexChatWrapper, ptyWrapper: cfg.ptyWrapper }),
  wrapper: 'data/bin/codex-chat-wrapper.js',
  Normalizer: CodexMessageManager,
  // STORE (S3): discover = the worker-side rollout walk + /proc liveness
  // (external = a codex process holds the rollout open); locate handles
  // .jsonl and .jsonl.zst; forkChain = the persisted forked_from chain the
  // wrapper merges on resume.
  store: {
    discover: ({ activeSessions } = {}) => codexStore.listCodexThreadsAsync({ activeSessions }),
    locate: (id) => findCodexSessionJsonlPath(id),   // (threadId) → rollout path|null (cwd irrelevant)
    locateTranscript: findCodexSessionJsonlPath,   // (threadId) → rollout path|null (S1 alias)
    listThreads: codexStore.listCodexThreads,      // sync twin (user-action consumers)
    Reader: codexStore.CodexSessionMessages,
    createReader: (session, sessionId, opts) => new codexStore.CodexSessionMessages(session, sessionId, opts || {}),
    forkChain: (id) => { const p = findCodexSessionJsonlPath(id); return p ? (extractCodexThreadMeta(p).forkedFrom || []) : []; },
    // (id, wrapperChain) → [{ id, untilOrdinal|null }] oldest→newest: the wrapper
    // chain ∪ codex's own 0.153 fork parents cut at their boundary ordinal —
    // what the read-only view prepends (codex-session-store.resolveCodexForkAncestry)
    forkAncestry: (id, wrapperChain) => codexStore.resolveCodexForkAncestry(id, wrapperChain || []),
    writerSweep: (rid, shq, opts) => writerSweepScript(rid, shq, { ...(opts || {}), backend: 'codex' }),
    remoteFind: (id) => ({
      root: '"$HOME"/.codex/sessions',
      findExpr: `-maxdepth 5 -type f \\( -name ${JSON.stringify('rollout-*' + id + '.jsonl')} -o -name ${JSON.stringify('rollout-*' + id + '.jsonl.zst')} \\)`,
      cacheRel: path.join('codex', id + '.jsonl'), maxBytes: 64 * 1024 * 1024,
    }),
    transcriptDirs: ['~/.codex/sessions'],
    conversationIdField: 'backendSessionId',
  },
  quota: require('./codex-quota.js'),    // QuotaSignalSource (S4)
  // CREDENTIAL mechanics (S2): one isolated CODEX_HOME per named account
  // (auth.json isolated; sessions/ + config.toml symlink the shared ~/.codex).
  creds: {
    subsDirName: 'codex-subs',                 // data/codex-subs/<id>
    files: ['auth.json'],                      // the only per-account file (sessions/config.toml are shared symlinks)
    bumpFile: null,                            // auth.json needs no mtime bump on a pool swap
    hostFactsKey: 'codex',                     // hosts.js backend-status facts bucket
    longLivedToken: false,
    supportsApiKeys: false,                    // codex accounts are always ChatGPT logins (type 'subscription')
    remoteSymlinks: { sessions: '$HOME/.codex/sessions', 'config.toml': '$HOME/.codex/config.toml' },
    ensureTargets: ['mkdir -p "$HOME/.codex/sessions"', 'touch "$HOME/.codex/config.toml"'],
    probe: { file: 'auth.json', marker: 'auth_mode|tokens|OPENAI_API_KEY' },
    sharedHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); },
    // An isolated CODEX_HOME whose sessions/ + config.toml SYMLINK the shared
    // home: threads land in one place (unified discovery), model/approval
    // settings are shared, only auth.json is per-account.
    seedDir(dir) {
      const shared = this.sharedHome();
      try { fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true }); } catch { }
      try { if (!fs.existsSync(path.join(shared, 'config.toml'))) fs.writeFileSync(path.join(shared, 'config.toml'), ''); } catch { }
      const link = (name) => {
        const p = path.join(dir, name);
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { }
        try { fs.symlinkSync(path.join(shared, name), p); } catch { }
      };
      link('sessions');
      link('config.toml');
    },
    authFile: 'auth.json',
    spawnEnvVar: 'CODEX_HOME',
    loginLabel: 'ChatGPT',
    defaultIdField: 'defaultCodexAccountId',
    keychainSensitive: false,                  // plain file ⇒ pools work wherever directory symlinks do
    parseAuth: parseCodexAuth,
    parseAuthFile: parseCodexAuthFile,
  },
  settingsPrefix: 'codex',
  // CONTEXT INJECTION strategy (S6): hooks are registered (the app-server
  // RUNS them) but their SessionStart output is IGNORED, so the WRAPPER
  // delivers teaching through thread/inject_items (prompt-context route) and
  // the stop-time nudge rides turn/completed — no Stop hook. Seen-gates in
  // agent-routes must NOT advance on SessionStart for this harness.
  inject: {
    kind: 'wrapper',
    hookFile: { file: () => path.join(os.homedir(), '.codex', 'hooks.json'), createIfMissing: true },
    hookEvents: ['SessionStart', 'UserPromptSubmit'],
    sessionStartHonoured: false,
  },
};
