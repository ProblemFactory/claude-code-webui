'use strict';
// Claude Code harness descriptor (S1). Declarations only reference the
// existing implementations — behaviour lives where it always did.
const { BACKEND_CAPS } = require('../backend-caps');
const { ClaudeCodeAdapter } = require('../adapters/claude-code');
const { MessageManager } = require('../message-manager');
const store = require('../session-store');
const { writerSweepScript } = require('../writer-sweep');
const { loginState } = require('../login-expiry'); // PURE: refreshTokenExpiresAt -> ok/expiring/expired/logged-out/unknown
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Read-only parse of a claude subscription account dir (NEVER writes or
 *  refreshes — rotation would break the account, issue #20): loggedIn +
 *  identity + the access token IF currently valid (for the usage poll). */
function parseClaudeAuth(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8'));
    const o = raw?.claudeAiOauth;
    if (!o?.accessToken) return { loggedIn: false };
    const valid = !o.expiresAt || Date.now() < o.expiresAt - 60000;
    // Identity (email/org) is NOT in .credentials.json — it's in the dir's
    // .claude.json (written because LOGIN also set CLAUDE_CONFIG_DIR=dir).
    let email = o.email || o.emailAddress || null, org = null;
    if (!email) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8'));
        email = cfg?.oauthAccount?.emailAddress || null;
        org = cfg?.oauthAccount?.organizationName || null;
      } catch { }
    }
    return { loggedIn: true, subscriptionType: o.subscriptionType || null, email, org, accessToken: valid ? o.accessToken : null, expiresAt: o.expiresAt || null };
  } catch { return { loggedIn: false }; }
}

/** LOGIN LIFETIME of an account dir (2026-09-07). The SAME file parseAuth
 *  already reads, asked a different question: not "is there a token" but "when
 *  does this LOGIN SESSION end". Read-only, never refreshes. A dir with no
 *  readable credentials answers 'unknown' — NO CLAIM, which every consumer
 *  treats as "do not block". Only harnesses whose credential format carries a
 *  login deadline declare this; the others simply do not, and accounts.js
 *  answers 'unknown' for them rather than inventing a verdict. */
function claudeLoginState(dir, now = Date.now()) {
  const fp = path.join(dir, '.credentials.json');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return loginState(null, now); }
  // `writtenAt` = the file's last write. It is the ONLY on-disk clock that
  // says anything about when this login session STARTED, but it is NOT the
  // login time: every access-token refresh rewrites this file while
  // refreshTokenExpiresAt stays put, so on an actively-used account it walks
  // forward and "deadline − writtenAt" shrinks towards zero. Nothing may treat
  // it as the session length on its own — the watch only uses it at a moment
  // it WITNESSED the deadline change (login-expiry-watch.measureLoginSpan).
  let writtenAt = null;
  try { writtenAt = fs.statSync(fp).mtimeMs; } catch { }
  return { ...loginState(raw, now), writtenAt };
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'chat',                 // chat + terminal
  caps: BACKEND_CAPS.claude,
  Adapter: ClaudeCodeAdapter,
  adapterConfig: (cfg) => ({ claudeCmd: cfg.claudeCmd, chatWrapper: cfg.chatWrapper, ptyWrapper: cfg.ptyWrapper, buffersDir: cfg.buffersDir }),
  wrapper: 'data/bin/chat-wrapper.js',
  Normalizer: MessageManager,
  // STORE (S3): everything "where do this harness's conversations live and
  // how are they read" — routes/sessions and transcript-service call these,
  // never a backend ternary. discover = the lock-first sweep (RUNNING
  // detection: locks + tmux + webui pids; moved verbatim into session-store).
  store: {
    discover: store.discoverClaudeSessions,        // async ({activeSessions, webuiPids, devSnap}) → session entries
    locate: (id, cwd) => store.findSessionJsonlPath(id, cwd), // (sessionId, cwd) → path|null
    // RESUME CONTINUITY (B-6b6d, round 2): claude declares NEITHER
    // `lastTurnModel` NOR `lastTurnEffort`, and the ABSENCE is the whole
    // declaration (src/resume-continuity.js: a knob with no source sends
    // NOTHING on a resume, never the instance default). Both knobs are absent
    // for the SAME reason — nothing claude writes records them in a form a
    // spawn can command:
    //   · EFFORT: nothing anywhere records the effort a turn ran at.
    //   · MODEL: every assistant record names the model that SERVED it, but
    //     never its context-window variant — measured over 2650 local
    //     transcripts, ZERO `message.model` values carry a `[…]` suffix while
    //     the CLI's own model_refusal_fallback records prove conversations on
    //     `claude-fable-5[1m]`. Commanding the served id would turn a 1M
    //     conversation into a 200k one on every resume. The reader round 1
    //     shipped for this is gone; the long-form reasoning (and the classifier
    //     -reroute measurement that also broke it) is in session-store.js.
    // So a claude resume commands neither knob and the CLI's own session
    // record — variant-exact — decides. Adding a hook back here is all it takes
    // if a future CLI records the commanded value.
    locateTranscript: store.findSessionJsonlPath,   // (sessionId, cwd) → path|null (S1 alias)
    warmTranscript: store.warmSessionJsonlAsync,   // worker-side parse cache
    Reader: store.SessionMessages,
    createReader: (session, sessionId, opts) => new store.SessionMessages(session, sessionId, opts || {}), // SessionMessages-shaped reader
    forkChain: () => [],                            // claude forks write a NEW id's JSONL — nothing to merge
    writerSweep: (rid, shq, opts) => writerSweepScript(rid, shq, { ...(opts || {}), backend: 'claude' }),
    // remote transcript location (hosts.fetchTranscript): where find(1) looks + the cache name
    remoteFind: (id) => ({ root: '"$HOME"/.claude/projects', findExpr: `-maxdepth 2 -name ${JSON.stringify(id + '.jsonl')}`, cacheRel: id + '.jsonl', maxBytes: 64 * 1024 * 1024 }),
    transcriptDirs: ['~/.claude/projects'],
    conversationIdField: 'claudeSessionId',
  },
  quota: require('./claude-quota.js'),   // QuotaSignalSource (S4): normalize/signalFromStream/probe/classifyAuthFailure
  // CREDENTIAL mechanics (S2): where a named account lives, which env var
  // relocates the CLI's secret store, how to read its auth (read-only), what
  // the login is called, which store field holds the default account.
  creds: {
    subsDirName: 'subs',                       // data/subs/<id>
    files: ['.credentials.json', '.claude.json'], // what an account dir ships/backs up (export, remote tar)
    bumpFile: '.credentials.json',             // creds-mtime bump on pool symlink swap (the CLI's cred-cache invalidation)
    hostFactsKey: 'subscription',              // hosts.js backend-status facts bucket carrying this harness's login email
    longLivedToken: true,                      // `claude setup-token` oat accounts exist (accounts._oatMeta)
    supportsApiKeys: true,                     // account records may be API keys (type 'api'); subscription otherwise
    remoteSymlinks: {}, ensureTargets: [],     // nothing shared on the host — securestorage relocates the secret store only
    probe: { file: '.credentials.json', marker: 'accessToken' }, // remote poison-heal marker (a wiped {} file must not win newest-wins)
    // Pre-seed an isolated login dir's .claude.json with the onboarding-complete
    // flags so `claude auth login` under CLAUDE_CONFIG_DIR=dir skips first-run
    // onboarding; the identity lands IN the dir — the global ~/.claude.json is
    // never clobbered.
    seedDir(dir) {
      const seed = { hasCompletedOnboarding: true, hasTrustDialogAccepted: true, theme: 'dark' };
      try { const g = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8')); if (g.theme) seed.theme = g.theme; } catch { }
      try { fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(seed), { mode: 0o600 }); } catch { }
    },
    authFile: '.credentials.json',
    // OPTIONAL (2026-09-07): the login-session deadline this credential format
    // carries. Declared only where the format has one — an absent key is the
    // honest "this harness makes no claim".
    loginState: claudeLoginState,
    spawnEnvVar: 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    loginLabel: 'Claude',
    defaultIdField: 'defaultAccountId',
    keychainSensitive: true,                   // darwin keychain service name hashes the env string ⇒ pools need Linux
    parseAuth: parseClaudeAuth,
  },
  // AUTO-RESUME'S RESUME VERB (owner ruling 2026-09-08: auto-resume is generic,
  // "形式可以不一样 — 有些是发消息, 有些是 start turn 之类的固有指令"). This is
  // ONE of the two harness-specific halves; the other is quota.signalFromStream
  // above. Everything else — the timer, the loop breaker, the notices, restart
  // survival — is src/server/auto-resume.js and is harness-neutral.
  //   FORM 'message': claude's continue is an ordinary USER MESSAGE. The wrapper
  //   takes the adapter's stream-json chat-input frame on stdin and the CLI runs
  //   it as if it had been typed — which is exactly what the CLI's own TUI
  //   auto-continue does, so the conversation sees nothing new.
  // `deps.sendChatInput` is the ORCH channel (server.js's sendToSession) — the
  // descriptor names the verb, the orchestrator owns the socket, so this file
  // stays SHARED and the daemon can still bundle it.
  resume: {
    form: 'message',
    deliver: (session, text, deps) => !!deps.sendChatInput(session, text),
  },
  settingsPrefix: 'claude',
  // CONTEXT INJECTION strategy (S6): the CLI's own hooks carry task context
  // (SessionStart), per-prompt notices (UserPromptSubmit) and the stop-time
  // bookkeeping nudge (Stop); SessionStart output is honoured, so the
  // seen-gates in agent-routes advance on delivery.
  inject: {
    kind: 'hooks',
    hookFile: { file: () => path.join(os.homedir(), '.claude', 'settings.json'), createIfMissing: false },
    hookEvents: ['SessionStart', 'UserPromptSubmit', 'Stop'],
    sessionStartHonoured: true,
  },
};
