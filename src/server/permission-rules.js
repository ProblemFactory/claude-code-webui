'use strict';
/**
 * PERMISSION-RULES READER + LOCAL-ORACLE RUNNER (ORCH tier, create(deps)).
 *
 * Two READ-ONLY surfaces, both from owner rulings in
 * docs/design-harness-features.md §5.1:
 *
 *   ruling 10 (a) 只读 — "where does this rule come from": one tree per
 *   harness, per SESSION (Session Properties) or per INSTANCE (Manage Agents).
 *   Nothing here writes anything, anywhere. The shaping lives in the PURE
 *   module src/permission-rules.js; this file only does the I/O and picks the
 *   rung, gated on the caps row (`permissionRules`), never on a backend id.
 *
 *   ruling 6 — HUMAN-TRIGGERED local oracles: a CLI read that has been
 *   MEASURED to open zero INET sockets, run under agentEnv() with the
 *   account's isolated config dir, on a button click and nothing else. The
 *   registry + the proofs + the measured-and-REJECTED candidates live in the
 *   PURE module src/local-oracles.js; scripts/test-vendor-whitelist.mjs
 *   enforces both directions.
 *
 * THE RUNGS, per harness (all local-machine only — a remote session's rules
 * live on that machine and this module says so instead of guessing):
 *   claude    the documented settings hierarchy, read off disk. No session
 *             needed. cwd + HOME are the only inputs.
 *   codex     SESSION scope ONLY → the session's OWN wrapper (`read-permission-
 *             rules` stdin verb → `config/read` on its already-running
 *             app-server). It has to be the session's own for a second reason
 *             beyond cost: `config/read` resolves a `sessionFlags` layer that
 *             a fresh child cannot see.
 *             INSTANCE scope → NOT OFFERED. The first cut spawned a bounded
 *             `codex app-server` child for it; measured (strace, empty
 *             CODEX_HOME) that child opens 7 INET connects incl. chatgpt.com
 *             :443 before answering. `permissionRules.instance` is false and
 *             `read()` answers 'would-connect' with the measurement. Proof +
 *             verdict: src/local-oracles.js `codex-app-server-config-read`.
 *   opencode  the serve's v1 `GET /config` (never a v2 route: measured, it
 *             boots an OpenCode instance — 2.369.50's law).
 *
 * ZERO NEW PROCESSES except the measured oracle registry: the only `spawn` in
 * this file is `spawn(cmd, o.argv.slice())` in runOracle, and
 * scripts/test-vendor-whitelist.mjs pins that count — a future child here has
 * to arrive through a registry entry, which cannot be added without a proof.
 */
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const PR = require('../permission-rules');
const { oracle, blockedCapability } = require('../local-oracles');
const { capsOf } = require('../backend-caps');
const { wrapperCaps } = require('./wrapper-files.js');   // the ONLY reader of a wrapper's self-reported caps (2.364.1)
const harnesses = require('../harnesses');

/** The biggest settings.json we will parse. A settings file is hand-written
 *  config; anything past this is not one, and reading it whole into the server
 *  is the class of bug the byte-cap law exists for. */
const SETTINGS_MAX_BYTES = 1 << 20;
/** How long one bounded `codex app-server` config read may take. */
const CODEX_READ_TIMEOUT_MS = 20000;
/** An oracle's output is shown in a modal; cap what we read out of it. */
const ORACLE_MAX_BYTES = 256 * 1024;

/**
 * WHICH CLI runs a harness's oracles. PURE and exported so the two refusals
 * stay distinguishable in a test:
 *   'no-runner'     — no command ref is wired for that harness here. A WIRING
 *                     gap, and it is NOT the same fact as the next one.
 *   'not-installed' — the harness is wired, the binary is absent.
 * Reporting the second for the first is the error-text-is-not-diagnosis rule
 * in miniature: it sends the reader off to install something that is already
 * there. Only codex ships oracles today (every measured claude subcommand
 * reached the vendor API — src/local-oracles.js NOT_ORACLES names the hosts
 * and the counts; THIS file must not, because test-vendor-whitelist reads a
 * vendor hostname here as a vendor CALL and it is right to (the allowlist is
 * per file, not per intent) — so this map
 * has one entry, and a future claude/opencode oracle must ADD one rather than
 * silently answer "not installed".
 */
function resolveOracleCmd(backend, refs = {}) {
  if (!Object.prototype.hasOwnProperty.call(refs, backend)) {
    return { cmd: null, reason: 'no-runner', detail: `no CLI path is wired for ${backend} oracles (src/server/permission-rules.js hands runOracle one ref per harness)` };
  }
  const ref = refs[backend];
  const cmd = typeof ref === 'function' ? ref() : ref;
  if (!cmd) return { cmd: null, reason: 'not-installed', detail: `${backend} is not installed on this machine` };
  return { cmd, reason: null, detail: null };
}

function create({ activeSessions, adapterRegistry, accounts, agentEnv, buffersDir, codexCmdRef, telemetry } = {}) {
  // ── claude: the settings hierarchy off disk ──
  async function readOneSettings(file) {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return { present: false };
      if (st.size > SETTINGS_MAX_BYTES) return { present: true, error: `file is ${st.size} bytes — too large to be a settings file (cap ${SETTINGS_MAX_BYTES})` };
      const raw = await fsp.readFile(file, 'utf-8');
      try { return { present: true, settings: JSON.parse(raw) }; }
      catch (e) { return { present: true, error: `not valid JSON (${e.message}) — the CLI ignores a settings file it cannot parse` }; }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { present: false };
      return { present: false, error: `${e.code || 'read failed'}: ${e.message}` };
    }
  }

  /**
   * claude's rules, read from disk. `cwd` empty ⇒ the INSTANCE scope (no
   * project/local layers exist without a project).
   * NOTE ON THE USER LAYER: VibeSpace's named claude accounts relocate the
   * SECRET store with CLAUDE_SECURESTORAGE_CONFIG_DIR — a different variable
   * that does NOT move settings.json. So the user layer is HOME's ~/.claude
   * unless a CLAUDE_CONFIG_DIR was really set for the session; pointing it at
   * an account dir would show a directory that holds no settings at all.
   */
  async function readClaudeRules({ cwd = '', home = os.homedir(), configDir = '', flagSettings = '', scope = 'session', host = null } = {}) {
    const layers = PR.claudeSettingsPaths({ cwd, home, platform: process.platform, configDir, sep: path.sep, flagSettings });
    const reads = [];
    for (const l of layers) {
      const got = await readOneSettings(l.file);
      const entry = { layer: l.id, file: l.file, dir: l.dir, dropInDir: l.dropInDir, ...got };
      // managed-settings.d/ — each drop-in file is its own source with its own path
      if (l.dropInDir) {
        const dropIns = [];
        let names = [];
        try { names = (await fsp.readdir(l.dropInDir)).filter((n) => n.endsWith('.json')).sort(); } catch { names = []; }
        for (const n of names.slice(0, 50)) {
          const f = path.join(l.dropInDir, n);
          const g = await readOneSettings(f);
          if (g.present && !g.error) dropIns.push({ file: f, settings: g.settings });
        }
        if (dropIns.length) entry.dropIns = dropIns;
      }
      reads.push(entry);
    }
    return PR.claudeRulesRecord(reads, { cwd: cwd || null, host, scope });
  }

  // ── codex INSTANCE scope: DELETED, and the deletion is the fix ──
  // The first cut answered it with ONE bounded `codex app-server` child
  // (the src/codex-thread-read.js pattern). Measured on this very code path
  // (strace -f -e trace=network, `env -i HOME=<empty dir>` ⇒ logged out, codex
  // 0.153.4): 7 INET connects, 2 of them port 443 to chatgpt.com — i.e. it
  // phones the vendor before it will read a local TOML. That is the class
  // src/local-oracles.js rejects `codex doctor` for, offered from a menu whose
  // sibling rows promise "no network requests (measured)".
  //
  // So the capability is OFF (`permissionRules.instance:false`) rather than
  // connecting, the measurement is a permanent negative control
  // (`codex-app-server-config-read`, with `blocks:` naming that caps row), and
  // `read()` below answers the instance scope with THAT verdict instead of a
  // generic refusal. Two knock-on properties worth naming:
  //   · there is no longer any spawn in this module except the oracle runner's
  //     `spawn(cmd, o.argv.slice())` — test-vendor-whitelist pins that count,
  //     so a future child here must arrive through the measured registry.
  //   · the round-2 verifier's separate finding (this reader's cache was
  //     consulted at entry and written after the await, so two concurrent
  //     identical reads were TWO spawns despite a doc-comment promising one)
  //     is resolved by removal — there is no spawn left to double.

  // ── opencode: the serve's v1 /config ──
  async function readOpencodeRules({ cwd = '', scope = 'instance', host = null } = {}) {
    let store = null;
    try { store = harnesses.get('opencode')?.store || null; } catch { store = null; }
    if (!store || typeof store.readPermissionConfig !== 'function') {
      return PR.unavailable('opencode', 'store-unavailable', 'the OpenCode store is not wired on this instance', { cwd: cwd || null, host, scope });
    }
    try {
      const config = await store.readPermissionConfig({ directory: cwd || null });
      return PR.opencodeRulesRecord(config, { cwd: cwd || null, host, scope });
    } catch (e) {
      // The serve being OFF is not a broken store — it is a switch the user
      // holds, and reasonUnavailable() already says which one (2.369.50 r2).
      let why = e.message;
      try { if (e.code === 'unavailable' || e.code === 'unconfigured') why = store.unavailableReason?.() || why; } catch { }
      return PR.unavailable('opencode', e.code === 'unavailable' || e.code === 'unconfigured' ? 'store-unavailable' : 'read-failed', why, { cwd: cwd || null, host, scope });
    }
  }

  // ── the SESSION-scoped codex read, over the session's own wrapper ──
  const pendingSession = new Map();  // requestId → {resolve, timer}
  let reqSeq = 0;

  /** Called by the codex/acp stdout consumers when the wrapper answers. */
  function onWrapperRecord(sessionId, payload) {
    if (!payload || typeof payload !== 'object') return null;
    const rid = typeof payload.requestId === 'string' ? payload.requestId : '';
    const entry = rid ? pendingSession.get(rid) : null;
    if (entry) { pendingSession.delete(rid); clearTimeout(entry.timer); entry.resolve(payload); }
    return payload;
  }

  /**
   * Ask a LIVE session for its own rules. Refusals carry a CODE and
   * `scope:'action'` (inc-mt2arppw: a session-scoped error flips live windows
   * read-only), and the two capability gates are the 2.361.1/2.364.1 pair:
   * the HARNESS row says this kind of agent can answer, the RUNNING wrapper's
   * own advert says THIS process can.
   */
  function readViaSession(sessionId, { timeoutMs = CODEX_READ_TIMEOUT_MS } = {}) {
    const session = activeSessions?.get(sessionId);
    if (!session?.pty || session.mode !== 'chat') {
      return Promise.resolve(PR.unavailable(session?.backend || 'unknown', 'no-live-session', 'This needs a live chat session — the rules a stopped session ran under are not recorded anywhere we can read.', { scope: 'session' }));
    }
    const backend = session.backend || 'claude';
    const caps = capsOf(backend).permissionRules || {};
    if (!caps.liveVerb) {
      return Promise.resolve(PR.unavailable(backend, 'unsupported-harness', 'This harness does not answer permission-rule questions over the session.', { scope: 'session', cwd: session.cwd || null }));
    }
    const wcaps = wrapperCaps(buffersDir, sessionId, session.socketPath);
    if (!wcaps.permissionRules) {
      const started = wcaps.startedAt ? new Date(wcaps.startedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time';
      return Promise.resolve(PR.unavailable(backend, 'wrapper-old', wcaps.reason === 'no-sidecar'
        ? 'This session’s agent has not reported its capabilities yet (still starting up?) — try again in a moment.'
        : `This session's agent (started ${started}) predates the permission-rule read. Terminate + Resume the session to use it.`,
      { scope: 'session', cwd: session.cwd || null }));
    }
    let payload;
    try {
      const adapter = adapterRegistry.get(backend);
      const requestId = `pr${Date.now().toString(36)}${(reqSeq++).toString(36)}`;
      payload = { frame: adapter.formatReadPermissionRules({ requestId }), requestId };
    } catch (e) {
      return Promise.resolve(PR.unavailable(backend, 'unsupported-harness', e.message, { scope: 'session', cwd: session.cwd || null }));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSession.delete(payload.requestId);
        resolve(PR.unavailable(backend, 'read-failed', `the agent did not answer within ${timeoutMs}ms`, { scope: 'session', cwd: session.cwd || null }));
      }, timeoutMs);
      // NOT unref'd: this timeout IS the answer for a wrapper that never
      // replies, and an unref'd timer lets an otherwise-idle process exit with
      // the read still pending (the caller then awaits forever).
      pendingSession.set(payload.requestId, {
        timer,
        resolve: (ans) => resolve(shapeWrapperAnswer(backend, ans, session)),
      });
      try { session.pty.write(payload.frame + '\n'); }
      catch (e) {
        pendingSession.delete(payload.requestId); clearTimeout(timer);
        resolve(PR.unavailable(backend, 'read-failed', `could not reach the agent: ${e.message}`, { scope: 'session', cwd: session.cwd || null }));
      }
    });
  }

  /** The wrapper's typed answer → the shared record shape. The wrapper is a
   *  SHIPPED SINGLE FILE (it runs on hosts with no checkout) so it forwards
   *  codex's own fields and the shaping happens HERE, once. */
  function shapeWrapperAnswer(backend, ans, session) {
    const cwd = (ans && ans.cwd) || session?.cwd || null;
    if (!ans || ans.ok !== true) {
      const reason = (ans && typeof ans.reason === 'string' && PR.UNAVAILABLE_REASONS.includes(ans.reason)) ? ans.reason
        : (ans && ans.reason === 'unsupported-by-protocol') ? 'unsupported-harness' : 'read-failed';
      const rec = PR.unavailable(backend, reason, (ans && ans.detail) || 'the agent could not answer', { cwd, scope: 'session' });
      // ACP carries no rules but DOES carry a live mode — say the one true thing
      if (ans && ans.mode) rec.mode = String(ans.mode);
      if (ans && Array.isArray(ans.modes)) rec.modes = ans.modes.map(String);
      return rec;
    }
    if (backend === 'codex') {
      const rec = PR.codexRulesRecord({ config: ans.config || {}, origins: ans.origins || {}, layers: ans.layers || [] }, { cwd, scope: 'session' });
      if (ans.truncated) rec.truncated = true;
      return rec;
    }
    return PR.unavailable(backend, 'unsupported-harness', 'this harness has no session-scoped rule shape', { cwd, scope: 'session' });
  }

  // ── the one entry point every surface uses ──
  /**
   * @param {{backend, scope:'session'|'instance', sessionId?, cwd?, accountId?, host?}} q
   * The caps row decides which rung runs. A remote session is answered
   * honestly rather than with this machine's files (`hostId` is a parameter,
   * but the FILES are not here — CS separation would need the read to move to
   * the machine, which is a separate change and is named as such).
   *
   * THE HOST GUARD SITS ABOVE THE RUNG CHOICE, DELIBERATELY (round-2 verifier
   * asked; this is the answer). It is obviously right for the disk/serve rungs
   * — those files are on the other machine. For a remote CODEX session it also
   * refuses, even though the frame WOULD reach the remote wrapper's stdin
   * (session.pty is bridged), because the second gate cannot be honoured
   * there: `wrapperCaps()` reads the sidecar the wrapper writes on ITS OWN
   * machine, so a remote session always reads back 'no-sidecar' and would be
   * refused as `wrapper-old` — "still starting up? try again in a moment",
   * forever, which is a lie with an actionable-looking suggestion (the
   * error-text-is-not-diagnosis rule). Given a choice between one honest
   * refusal and one misleading one we take the honest one; making it WORK
   * needs a remote advert channel (the wrapper's boot caps ride stdout, they
   * are simply not recorded per session today) and that is a separate change.
   */
  async function read(q = {}) {
    const backend = q.backend || 'claude';
    const scope = q.scope === 'instance' ? 'instance' : 'session';
    const caps = capsOf(backend).permissionRules || {};
    if (!caps.source) {
      return PR.unavailable(backend, 'unsupported-harness', 'This kind of session has no agent permission rules.', { cwd: q.cwd || null, host: q.host || null, scope });
    }
    if (q.host) {
      return PR.unavailable(backend, 'remote-session', `These rules live on ${q.host} — VibeSpace reads permission rules on this machine only.`, { cwd: q.cwd || null, host: q.host, scope });
    }
    // A scope the caps row turns off has TWO possible reasons, and they are
    // different facts: the harness genuinely cannot answer it, or we MEASURED
    // the only way to answer it reaching the vendor and declined. Ask the
    // registry which one this is rather than hand-writing a sentence that goes
    // stale the day the measurement is redone.
    for (const [want, on, generic] of [['session', caps.session, 'This harness reports one resolved set of rules for the whole machine, not per session.'],
      ['instance', caps.instance, 'This harness only answers for a running session.']]) {
      if (scope !== want || on) continue;
      const blocked = blockedCapability(backend, `permissionRules.${want}`);
      if (blocked) {
        return PR.unavailable(backend, 'would-connect',
          `${blocked.verdict} (measured ${blocked.measured.date} with ${blocked.measured.tool} on ${blocked.measured.version}: ${blocked.measured.inetConnects} connections.)`,
          { cwd: q.cwd || null, scope });
      }
      return PR.unavailable(backend, 'unsupported-harness', generic, { cwd: q.cwd || null, scope });
    }
    if (caps.source === 'settings-files') {
      return readClaudeRules({ cwd: scope === 'session' ? (q.cwd || '') : '', scope, host: null });
    }
    if (caps.source === 'serve-config') {
      return readOpencodeRules({ cwd: q.cwd || '', scope, host: null });
    }
    if (caps.source === 'config-read') {
      // Session scope only (see the deleted-rung note above): the session's own
      // app-server is already running and already connected, so asking it over
      // stdin opens nothing new.
      if (q.sessionId) return readViaSession(q.sessionId);
      return PR.unavailable(backend, 'no-live-session', 'This needs a live chat session — the rules a stopped session ran under are not recorded anywhere we can read.', { cwd: q.cwd || null, scope });
    }
    return PR.unavailable(backend, 'unknown', 'no reader is wired for this harness', { cwd: q.cwd || null, scope });
  }

  // ── ruling 6: the human-triggered local oracles ──
  /**
   * Run ONE registered oracle. There is no path here that takes an argv from a
   * caller: `id` selects a frozen entry and its own argv. Never on a timer,
   * never at boot — the ONLY caller is the POST route below, which is a
   * button.
   */
  function runOracle(id, { accountId = null } = {}) {
    const o = oracle(id);
    if (!o) return Promise.resolve({ ok: false, reason: 'unknown-oracle', detail: `no local oracle "${id}"` });
    const got = resolveOracleCmd(o.backend, { codex: codexCmdRef });
    if (!got.cmd) return Promise.resolve({ ok: false, reason: got.reason, detail: got.detail, id, argv: o.argv });
    const cmd = got.cmd;
    const env = { ...(agentEnv ? agentEnv() : process.env) };
    if (accountId) {
      try { Object.assign(env, accounts?.resolveForSpawn?.(accountId, o.backend)?.localEnv || {}); }
      catch (e) { return Promise.resolve({ ok: false, reason: 'account', detail: e.message }); }
    }
    return new Promise((resolve) => {
      let child, done = false, out = '', err = '', truncated = false;
      const finish = (r) => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { child?.kill('SIGKILL'); } catch { }
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: `${o.label} did not finish within ${o.timeoutMs}ms`, id, argv: o.argv }), o.timeoutMs);
      const cap = (s, chunk) => {
        if (s.length >= ORACLE_MAX_BYTES) { truncated = true; return s; }
        return s + String(chunk);
      };
      try { child = spawn(cmd, o.argv.slice(), { stdio: ['ignore', 'pipe', 'pipe'], env }); }
      catch (e) { return finish({ ok: false, reason: 'spawn', detail: e.message, id, argv: o.argv }); }
      child.on('error', (e) => finish({ ok: false, reason: 'spawn', detail: e.message, id, argv: o.argv }));
      child.stdout.on('data', (c) => { out = cap(out, c); });
      child.stderr.on('data', (c) => { err = cap(err, c); });
      child.on('close', (code) => {
        let json = null, jsonError = null;
        if (o.json) {
          try { json = JSON.parse(out); } catch (e) { jsonError = e.message; }
        }
        try { telemetry?.record?.({ kind: 'event', name: 'local-oracle-run', detail: `${id} exit=${code}` }); } catch { }
        finish({
          ok: true, id, label: o.label, backend: o.backend, argv: o.argv,
          exitCode: code, json, jsonError, truncated,
          // `codex login status` answers on STDERR; both streams always travel,
          // and the modal shows whichever the oracle declared plus anything the
          // other one said (a silent stderr is how a real failure hides).
          stdout: out, stderr: err, streams: o.streams,
        });
      });
    });
  }

  function registerRoutes(app, requireAuth) {
    const mw = requireAuth ? [requireAuth] : [];
    app.get('/api/permission-rules', ...mw, async (req, res) => {
      try {
        const rec = await read({
          backend: String(req.query.backend || 'claude'),
          scope: req.query.scope === 'instance' ? 'instance' : 'session',
          sessionId: req.query.sessionId ? String(req.query.sessionId) : null,
          cwd: req.query.cwd ? String(req.query.cwd) : '',
          accountId: req.query.accountId ? String(req.query.accountId) : null,
          host: req.query.host ? String(req.query.host) : null,
        });
        res.json(rec);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
    // HUMAN-TRIGGERED ONLY (ruling 6). POST because it spawns a process — a
    // GET would be pre-fetchable by a browser and by every crawler that sees
    // the URL, which is exactly the "never on a timer" rule losing by accident.
    app.post('/api/local-oracle/:id', ...mw, async (req, res) => {
      const r = await runOracle(String(req.params.id), { accountId: req.body?.accountId ? String(req.body.accountId) : null });
      if (!r.ok) return res.status(r.reason === 'unknown-oracle' ? 404 : 400).json(r);
      res.json(r);
    });
  }

  return {
    read, readClaudeRules, readOpencodeRules, readViaSession,
    onWrapperRecord, runOracle, registerRoutes,
    SETTINGS_MAX_BYTES, ORACLE_MAX_BYTES, CODEX_READ_TIMEOUT_MS,
  };
}

module.exports = { create, resolveOracleCmd, SETTINGS_MAX_BYTES, ORACLE_MAX_BYTES, CODEX_READ_TIMEOUT_MS };
