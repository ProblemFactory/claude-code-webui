'use strict';
// ACCOUNT + USAGE ROUTES (decomposition #9): the central telemetry collector
// ingest, the usage-stats ledger routes (aggregate/pivots/pricing/rid-info),
// and the full accounts route family — Claude multi-subscription, pooled
// pseudo-accounts, long-lived tokens (oat01), Codex multi-subscription.
// Extracted VERBATIM. ORCH tier: decisions stay in src/accounts.js /
// account-pool-auto.js; this is HTTP wiring.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { mk } = require('./lazy.js');

function create({ app, rootDir, HOST, CLAUDE_CMD, NODE_CMD,
  CLAUDE_SUBSCRIPTION_LOGIN_HELPER, activeSessions, auth, engine,
  serverSetting, recordUsageAttribution, liveAccountIdSet,
  buildClaudeSubscriptionLoginCommand, getAccounts, getHosts, getMounts,
  getTelemetry, getUsageHistory, getLoginExpiryWatch }) {
  const { clearSealedOrders } = engine;
  const accounts = mk(getAccounts);
  const hosts = mk(getHosts);
  const mounts = mk(getMounts);
  const telemetry = mk(getTelemetry);
  const usageHistory = mk(getUsageHistory);
// A SUCCESSFUL LOGIN is the one moment the login-expiry watch's picture is
// stale by construction: the deadline it warned about no longer exists. Its
// poll is 5 min, which is a long time to keep staring at a red chip and an
// inbox item about the thing you JUST fixed — so every finalize route sweeps
// it right here. The sweep is the SINGLE reader: it asks accounts.loginStateOf
// (exactly what the roster row's `loginState` — the chip — is built from), so
// the chip and the inbox can never disagree about what it found, and there is
// no second credential reader to drift. Failure is logged, never thrown: a
// login must not fail because a follow-up sweep did.
const sweepLoginExpiry = (why) => {
  try {
    const w = getLoginExpiryWatch ? getLoginExpiryWatch() : null;
    if (!w?.sweep) return null;
    const r = w.sweep();
    const cleared = (r?.resolved || []).reduce((n, x) => n + (x.n || 0), 0);
    if (cleared) console.log(`[login-expiry] immediate sweep after ${why}: ${cleared} warning(s) cleared`);
    return r;
  } catch (e) { console.log('[login-expiry] immediate sweep failed:', e.message); return null; }
};
// ONCE PER LOGIN, NOT ONCE PER POLL (round-2 verifier). `/relogin-finalize` is
// a WATCHER endpoint: manage-agents polls it every 3 s for up to 5 minutes,
// and for a record whose login is already on disk the answer is the SAME
// `outcome:'same'` every time. A side effect hung on that answer runs ~100×
// per re-login — a polled route may not carry an unbounded per-call side
// effect.
//
// It also cannot be a plain "already swept this account" latch. Re-logging an
// account that is STILL logged in answers 'same' from the very first poll,
// minutes before the user finishes the browser flow, so a boolean latch would
// skip exactly the sweep that matters. The gate is therefore the answer's own
// CREDENTIAL FINGERPRINT — the fields that can only change when the file the
// login writes changes: which outcome, which record, which identity, which
// access token. Same fingerprint ⇒ the credentials did not move ⇒ there is
// nothing new for the watch to find. This reads the ANSWER the route already
// has; it is NOT a second credential reader (the sweep stays the single one).
const lastLoginFingerprint = new Map(); // accountId → fingerprint of the last answer we swept on
const FINGERPRINT_CAP = 500;            // bounded by the roster in practice; a hard ceiling anyway
const loginFingerprint = (r) => {
  const a = r?.account || r; // reloginResolve WRAPS the finalize result; finalizeSubscription IS it
  return [r?.outcome || '', a?.id || r?.movedTo?.id || '', String(a?.email || r?.freshEmail || '').trim().toLowerCase(), a?.expiresAt ?? ''].join('|');
};
/** Sweep only on the TRANSITION — the first finalize answer that differs from
 *  the last one we swept for this record. Returns whether it swept. */
const sweepOnLoginTransition = (id, r, why) => {
  const fp = loginFingerprint(r);
  if (lastLoginFingerprint.get(id) === fp) return false;
  if (lastLoginFingerprint.size >= FINGERPRINT_CAP) lastLoginFingerprint.clear();
  lastLoginFingerprint.set(id, fp);
  sweepLoginExpiry(why);
  return true;
};
// A LOGIN SUCCEEDING IS ALSO A QUOTA EVENT (2026-09-08, the new-member
// incident). The member that just logged in has NO usage reading, and "no
// usage data" is precisely what the pool and auto-resume saw for the fresh
// subscription the owner added in the middle of a full-pool exhaustion: the
// pool parked eight conversations on it, auto-resume re-armed them for a reset
// EIGHT HOURS out, the auto-cli panel read failed and backed off, and nothing
// ever looked again — the owner released them by typing. So the ONE read of
// that member's usage and the pool re-evaluation that follows it hang HERE,
// on the login edges the finalize routes already detect.
//
// SAME TRANSITION DETECTION, ITS OWN LATCH. The predicate is the existing
// `loginFingerprint` — the fields that can only change when the file the login
// writes changes, read off THE ANSWER THE ROUTE ALREADY HOLDS (never a second
// credential reader). `/relogin-finalize` is polled every 3 s for up to 5 min,
// and the Add-subscription and codex device-auth finalizes are polled the same
// way, so a side effect hung on the raw answer would run ~100× per login and
// spawn ~100 CLI panels. The latch is separate from the expiry sweep's on
// purpose: those two routes call `sweepLoginExpiry` UNCONDITIONALLY (there is a
// documented reason — the pre-merge sweep is the only one on every non-merge
// exit), so sharing one map would silently couple "we already swept" to "we
// already read the usage" and disabling either would disable the other.
//
// WAKE THE RECORD THE LOGIN LANDED IN, not the record that was asked about:
// 'moved' relocated the credentials into ANOTHER record, and the auto-merge
// exit keeps the SURVIVOR. Waking the throwaway would spawn a panel read for a
// record about to stop existing and leave the one the pool actually holds
// unread.
//
// FIRE-AND-FORGET: a login must never wait on, or fail because of, a quota
// read. The promise is returned only so a test can await the edge.
const lastWakeFingerprint = new Map(); // accountId → fingerprint of the last answer we woke on
const wakeOnLoginSuccess = (id, r, why, memberId = null) => {
  try {
    const target = memberId || id;
    if (!target) return null;
    const fp = loginFingerprint(r);
    if (lastWakeFingerprint.get(id) === fp) return null;
    if (lastWakeFingerprint.size >= FINGERPRINT_CAP) lastWakeFingerprint.clear();
    lastWakeFingerprint.set(id, fp);
    const p = Promise.resolve(engine.onMemberLoginSuccess?.(target, why))
      .catch((e) => { console.log('[pool] login wake failed:', e.message); return null; });
    // OBSERVABILITY SEAM, not a control path: nothing in production reads this.
    // A fire-and-forget side effect is exactly the shape a regression can pass
    // vacuously against ("it did not fire" is indistinguishable from "we looked
    // too early"), so the promise is parked where the suite — and a human in a
    // REPL — can await the edge before asserting about it.
    app.locals._lastLoginWake = p;
    return p;
  } catch (e) { console.log('[pool] login wake failed:', e.message); return null; }
};
// ── Central collector (team deployments): other instances POST their batches
// here (telemetry.forwardUrl → https://<collector>/api/telemetry/ingest).
// Enabled ONLY when VIBESPACE_TELEMETRY_INGEST_TOKEN is set — the shared
// Bearer token is both the on-switch and the whole gate (cookie-auth exempt
// in auth.js: remote instances have no cookie). Same privacy model as local
// events: names/stacks/metrics only, never content. ──
const TELEMETRY_INGEST_TOKEN = (process.env.VIBESPACE_TELEMETRY_INGEST_TOKEN || '').trim();
app.post('/api/telemetry/ingest', (req, res) => {
  if (!TELEMETRY_INGEST_TOKEN) return res.status(404).json({ error: 'collector disabled' });
  const crypto = require('crypto');
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${TELEMETRY_INGEST_TOKEN}`);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(403).json({ error: 'bad token' });
  }
  try {
    const n = telemetry.ingestRemote(req.body?.instance, req.body?.events);
    res.json({ success: true, n });
  } catch { res.json({ success: true, n: 0 }); }
});
app.get('/api/telemetry/central-summary', (req, res) => {
  try {
    res.json({ collector: !!TELEMETRY_INGEST_TOKEN, ...telemetry.centralSummary({ days: Math.min(parseInt(req.query.days) || 14, 90) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/usage-stats', (req, res) => {
  try {
    usageHistory.scan(); // pick up anything new before answering
    const from = req.query.from ? parseInt(req.query.from, 10) : null;
    const to = req.query.to ? parseInt(req.query.to, 10) : null;
    const backend = req.query.backend || null;
    // account = comma list of ledger bucket keys (account ids / '__global__')
    const accounts = req.query.account ? new Set(String(req.query.account).split(',').filter(Boolean)) : null;
    // pivot = comma list of 'dimA:dimB' 2-D crosses (dashboard split-series
    // panels, e.g. pivot=day:account) — validated + capped in aggregate/here
    const pivots = req.query.pivot
      ? String(req.query.pivot).split(',').map((s) => s.split(':')).filter((p) => p.length === 2).slice(0, 6)
      : null;
    // host = the DEVICE filter ('local' | a host id) — top-level over the view
    const hostFilter = req.query.host ? String(req.query.host) : null;
    res.json(usageHistory.aggregate({ from, to, backend, accounts, hostFilter, pivots }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Per-message account attribution for the msg-meta popup (2.266.1, user
// request): which account served this requestId, per the ledger's baked
// attribution (aname frozen at scan time; pool = billed THROUGH it).
app.get('/api/usage-stats/rid-info', (req, res) => {
  try {
    let ev = req.query.rid ? usageHistory.eventForRid(String(req.query.rid)) : null;
    // live stdout records carry NO requestId — message.id is the join field
    // both transports share (the 2.267.3 rule), so the popup can attribute
    // EVERY reply, not just history-rebuilt ones.
    if (!ev && req.query.mid) ev = usageHistory.eventForMid(String(req.query.mid));
    if (!ev) return res.json({ found: false });
    let poolName = null;
    try { poolName = ev.pool ? (accounts.get(ev.pool)?.name || null) : null; } catch { }
    let hostName = null;
    try { hostName = ev.host ? (hosts.get(ev.host)?.name || null) : null; } catch { }
    // be/model/effort (additive): the popup names the RIGHT machine login for a
    // global-bucket event (codex = the ChatGPT login, not "CLI login") and can
    // show the ledger's served model / codex effort when the record has none.
    res.json({ found: true, acct: ev.acct || null, aname: ev.aname || null, atype: ev.atype || 'global', pool: ev.pool || null, poolName, host: ev.host || null, hostName, be: ev.be || 'claude', model: ev.model || null, effort: ev.effort || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/usage-stats/pricing', (req, res) => res.json({ pricing: usageHistory.pricingTable() }));
app.post('/api/usage-stats/pricing', (req, res) => {
  try { usageHistory.setPricing(req.body || {}); res.json({ success: true, pricing: usageHistory.pricingTable() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/accounts', (req, res) => {
  const out = {
    ...accounts.list(),
    subscription: accounts.subscriptionStatus(),
    cliKey: accounts.cliPrimaryKey(),
  };
  // Host id → display name map (2.244.1, real screenshot: the roster's
  // "logged in on host-9a86e4fb" — raw ids leaked whenever the sidebar's
  // hosts data wasn't loaded yet; the server always knows the names)
  try { out.hostNames = Object.fromEntries((hosts.list?.() || []).map((h) => [h.id, h.name || h.id])); } catch { }
  // LOCAL verdicts (B-f531): same authority as the per-host ones
  try {
    out.verdicts = {};
    for (const a of (out.accounts || [])) {
      try { out.verdicts[a.id] = accounts.evaluateOnHost(accounts.get(a.id), null, {}); } catch { }
    }
  } catch { }
  res.json(out);
});
app.post('/api/accounts', (req, res) => {
  try { res.json({ success: true, account: accounts.add(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/accounts/import-cli', (req, res) => {
  try { res.json({ success: true, account: accounts.importFromCli() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Anthropic login state ON a remote host (subscription OAuth? console key?) —
// powers the Manage Agents accounts section when a host is selected.
app.get('/api/hosts/:id/accounts-status', async (req, res) => {
  try {
    const r = await hosts.accountsStatus(req.params.id);
    // Same-account auto-recognition on the HOST side (2.205.0): a host dir
    // whose identity email matches a DIFFERENT existing subscription means
    // duplicate records of one real account — rename the host dir to the
    // survivor and fold the records (the local finalize path does the same
    // for local logins). Learned dir emails also backfill records that
    // never declared one (enables the =host-login link).
    // On macOS the Keychain service name is hashed from the dir path. Renaming
    // a host dir cannot migrate that item from this non-interactive server
    // context, so keep duplicate records rather than silently selecting stale
    // credentials or orphaning the fresh service.
    if (accounts && r.hostSubEmails && r.platform && r.platform !== 'darwin') {
      for (const [dirId, email] of Object.entries(r.hostSubEmails)) {
        try {
          const em = String(email).trim().toLowerCase();
          const all = accounts.list().accounts || [];
          const rec = all.find((x) => x.id === dirId);
          if (!rec) continue;
          if (!rec.email) { try { accounts.setEmail(dirId, email); } catch { } }
          const dup = all.find((x) => x.id !== dirId && (x.backend || 'claude') === 'claude' && x.type === 'subscription'
            && String(x.email || (String(x.name || '').includes('@') ? x.name : '')).trim().toLowerCase() === em);
          if (dup) {
            // A Darwin VibeSpace marks these records local-only even when this
            // particular copy lives on a Linux host. Be conservative: check
            // before renaming so mergeSubscription cannot reject after the
            // host path has already changed.
            if (rec.localOnly || dup.localOnly) continue;
            // survivor = the OLDER record; rename the newer's host dir first
            const survivor = (dup.createdAt || 0) <= (rec.createdAt || 0) ? dup : rec;
            const gone = survivor === dup ? rec : dup;
            if ((r.hostSubs || []).includes(gone.id) && await hosts.renameHostSubDir(req.params.id, gone.id, survivor.id)) {
              const i = r.hostSubs.indexOf(gone.id);
              if (i >= 0) r.hostSubs.splice(i, 1, survivor.id);
            }
            try { accounts.mergeSubscription(gone.id, survivor.id, { preferFromCreds: false, liveAccountIds: liveAccountIdSet() }); }
            catch (me) { if (me.code !== 'merge-account-live') throw me; /* live session — leave both records, merge on a later probe */ }
          }
        } catch { /* best-effort per-dir; a failed merge keeps both records */ }
      }
    }
    // remember which accounts hold a login ON this host — every view (incl.
    // local, which probes no host) can then show "logged in on X" (2.204.0)
    try { accounts?.noteHostLogins?.(req.params.id, r.hostSubs || []); } catch { }
    // Per-account VERDICTS (B-f531, 2.244.0): the single evaluateOnHost
    // authority, computed against these LIVE facts — client surfaces render
    // these verbatim and never compute their own from page caches.
    try {
      const facts = { ...r, hostId: req.params.id, transport: hosts.get(req.params.id)?.transport === 'dial' ? 'dial' : 'ssh' };
      let allowShip = false;
      try { allowShip = !!serverSetting('accounts.shipSubscriptionToRemote'); } catch { }
      r.verdicts = {};
      for (const a of (accounts.list().accounts || [])) {
        try { r.verdicts[a.id] = accounts.evaluateOnHost(a, facts, { allowShip }); } catch { }
      }
    } catch { }
    res.json(r);
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Import the console-login key minted on a REMOTE host into the central store
// (the store is host-agnostic — keys are pushed per-session wherever needed).
app.post('/api/accounts/import-cli-host', async (req, res) => {
  try {
    const { key, org } = await hosts.cliPrimaryKey(req.body?.hostId);
    if (!key) return res.status(400).json({ error: 'no primaryApiKey on that host — log in to a Console account there first' });
    const hostName = (() => { try { return hosts.get(req.body?.hostId)?.name; } catch { return null; } })();
    res.json({ success: true, account: accounts.add({ name: (org || 'Console') + ' (API' + (hostName ? ', ' + hostName : '') + ')', key, source: 'cli-import', originHost: hostName }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/accounts/default', (req, res) => {
  // backend needed only when CLEARING (id null) — otherwise it's derived from
  // the account. Each backend (claude/codex) keeps its own default.
  try { accounts.setDefault(req.body?.id || null, req.body?.backend || 'claude'); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/accounts/:id/key', (req, res) => {
  // reveal the decrypted key on request (cookie-authed; mounts-config trust
  // model) — the store is the MASTER copy and the Console can't re-show it
  try { res.json({ key: accounts.revealKey(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/accounts/:id', (req, res) => {
  try {
    let account = null;
    if (req.body?.name !== undefined) account = accounts.rename(req.params.id, req.body.name);
    if (req.body?.email !== undefined) account = accounts.setEmail(req.params.id, req.body.email);
    if (req.body?.note !== undefined) account = accounts.setNote(req.params.id, req.body.note);
    res.json({ success: true, account });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/accounts/:id', (req, res) => {
  try {
    const _wasPool = accounts.get(req.params.id)?.type === 'pooled';
    accounts.remove(req.params.id); // throws for unknown ids → only real (shape-safe) ids continue
    // DISARM the device reflex for a deleted pool — a stale snapshot could
    // otherwise recreate the deleted pool's symlink in a server-down window
    if (_wasPool) clearSealedOrders(req.params.id);
    // Best-effort: clear whatever this account left on each host — a 0600 key
    // file (API), a securestorage creds dir (Claude sub), or a CODEX_HOME copy
    // (Codex sub). Fire-and-forget; unreachable hosts are fine (the leftovers
    // are useless without the account, but tidy up when we can).
    const rid = req.params.id;
    if (/^(acct|sub|cxs)-[a-f0-9]+$/.test(rid) && hosts) {
      const { execFile } = require('child_process');
      // every harness with credential mechanics owns a remote dir family (S2: descriptor subsDirName)
      const dirs = require('../harnesses').list().filter((h) => h.creds?.subsDirName).map((h) => `"$HOME/.vibespace/${h.creds.subsDirName}/${rid}"`).join(' ');
      const rm = `rm -f "$HOME/.vibespace/${rid}.key"; rm -rf ${dirs}`;
      for (const h of hosts.list() || []) {
        try { execFile('ssh', [...hosts.sshArgs(h), '--', rm], { timeout: 15000 }, () => {}); } catch { }
      }
    }
    res.json({ success: true });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Multi-subscription: hold several Claude Max/Pro logins at once, each in
// its own securestorage creds dir (CLAUDE_SECURESTORAGE_CONFIG_DIR). Create
// allocates the dir + returns the login command the client runs in a terminal;
// finalize reads back the identity once the OAuth login has written creds. ──
// ── Pooled pseudo-account (B-6217) ────────────────────────────────────────
// The pool's creds dir is a DIRECTORY SYMLINK at data/subs/<poolId>; switching
// = re-pointing it (accounts.setPoolTarget). See the accounts.js section header
// for why a directory symlink is the only shape that keeps ONE credential copy
// (and therefore one refresh-token holder) while still swapping per-spawn.
app.post('/api/accounts/pool', (req, res) => {
  try { res.json({ success: true, ...accounts.createPool({ name: req.body?.name, members: req.body?.members, backend: req.body?.backend === 'codex' ? 'codex' : 'claude' }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/accounts/pool/:id', (req, res) => {
  try {
    const id = req.params.id;
    // Narrowing the member list away from the CURRENT target makes updatePool
    // re-point IMMEDIATELY (symlink swap) — a running claude re-reads the
    // credential file mid-session, so this must mirror /target's contract
    // (review B1): re-record attribution for live pooled sessions + return
    // `affected` so the dialog can cold-restart them. Silently it mis-billed
    // the OLD target for everything after the swap.
    const before = accounts.poolCurrent(id);
    accounts.updatePool(id, { members: req.body?.members, auto: req.body?.auto, hot: req.body?.hot });
    // auto turned OFF ⇒ disarm the device reflex too, or the daemon keeps
    // switching a pool the user just set to manual (review finding)
    if (req.body?.auto === false) clearSealedOrders(id);
    const after = accounts.poolCurrent(id);
    const affected = [];
    if (before !== after) {
      for (const [sid, sess] of activeSessions) {
        if (sess._accountId !== id) continue;
        try { recordUsageAttribution({ claudeSessionId: sess.claudeSessionId || sess.backendSessionId, accountId: id }); } catch {}
        affected.push({ serverId: sid, backend: sess.backend || 'claude', backendSessionId: sess.claudeSessionId || sess.backendSessionId || null, cwd: sess.cwd || null, name: sess.name || null, host: sess.host || null });
      }
    }
    res.json({ success: true, retargeted: before !== after ? { from: before, to: after, name: after ? (accounts.get(after)?.name || after) : null } : null, affected });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Re-point. Returns the live sessions billed to this pool so the CLIENT can
// restart them (v1 = cold swap; the client owns kill+resume, same machinery as
// the billing switcher). `hot` pools skip the restart — the running CLI
// re-reads the credential file on its next request.
app.post('/api/accounts/pool/:id/target', (req, res) => {
  try {
    const id = req.params.id;
    const before = accounts.poolCurrent(id);
    // USER route → sweep live per-session links on a hot pool (the manual
    // pick means "everything, now"); the engine's own setPoolTarget calls
    // never sweep — their per-session moves ARE the projection state.
    const hot = accounts.get(id)?.hot !== false;
    const r = accounts.setPoolTarget(id, String(req.body?.accountId || ''), { sweepSessionLinks: hot });
    const affected = [];
    for (const [sid, s] of activeSessions) {
      if (s._accountId !== id) continue;
      affected.push({ serverId: sid, backend: s.backend || 'claude', backendSessionId: s.claudeSessionId || s.backendSessionId || null, cwd: s.cwd || null, name: s.name || null, host: s.host || null });
    }
    res.json({ success: true, ...r, previous: before, affected });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Long-lived token (oat01, B-211a) ──────────────────────────────────────
// Minting one (claude setup-token, 1-year, no refresh) is the per-account
// consent to run this subscription on remote machines — it ships as
// CLAUDE_CODE_OAUTH_TOKEN over the same 0600-file channel API keys use.
app.post('/api/accounts/:id/oat', (req, res) => {
  try { res.json({ success: true, ...accounts.setOat(req.params.id, req.body?.token) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/accounts/:id/oat', (req, res) => {
  try {
    accounts.clearOat(req.params.id);
    // The spawn channel left 0600 working copies (~/.vibespace/<id>.key) on
    // hosts — sweep them best-effort like account delete does (the still-valid
    // 1-year token must not outlive its removal where we can reach).
    const rid = req.params.id;
    if (/^sub-[a-f0-9]+$/.test(rid) && hosts) {
      const { execFile } = require('child_process');
      for (const h of hosts.list() || []) {
        try { execFile('ssh', [...hosts.sshArgs(h), '--', `rm -f "$HOME/.vibespace/${rid}.key"`], { timeout: 15000 }, () => {}); } catch { }
      }
    }
    res.json({ success: true });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/accounts/subscription', (req, res) => {
  try {
    const { id, dir } = accounts.createSubscription(req.body || {});
    // The client opens a shell terminal with this exact command. The helper
    // runs the official `claude auth login --claudeai` with BOTH config envs
    // scoped to the pre-seeded account dir, isolating credentials + identity
    // without touching the global login. On macOS it then copies the new
    // per-dir Keychain value to Claude's normal fallback file while it is still
    // in the interactive terminal's Keychain security session; launchd-started
    // VibeSpace processes cannot reliably read that item later.
    const loginCmd = buildClaudeSubscriptionLoginCommand({
      nodeCmd: NODE_CMD,
      helperPath: CLAUDE_SUBSCRIPTION_LOGIN_HELPER,
      claudeCmd: CLAUDE_CMD,
      configDir: dir,
    });
    res.json({ success: true, id, dir, loginCmd });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Re-login an EXISTING Claude subscription on THIS machine (2.332.0, real ask
// after two token-death incidents made "remove + re-add" the only path): the
// SAME env-scoped helper the Add flow uses, pointed at the account's existing
// creds dir — identity, pool membership, ledger history all stay intact; only
// the login is refreshed. Returns the CURRENT helper attempt id as a baseline
// so the client can tell the NEW login from a pre-existing one (a re-login of
// a still-logged-in account would otherwise report success instantly).
app.post('/api/accounts/:id/relogin', (req, res) => {
  try {
    const a = accounts.get(req.params.id);
    if (!a || a.type !== 'subscription' || (a.backend || 'claude') !== 'claude') {
      return res.status(400).json({ error: 'not a Claude subscription account' });
    }
    const dir = accounts.subDir(a.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const loginCmd = buildClaudeSubscriptionLoginCommand({
      nodeCmd: NODE_CMD,
      helperPath: CLAUDE_SUBSCRIPTION_LOGIN_HELPER,
      claudeCmd: CLAUDE_CMD,
      configDir: dir,
    });
    let baselineAttempt = null;
    try { baselineAttempt = accounts._subscriptionLoginStatus?.(a.id)?.attempt || null; } catch { }
    res.json({ success: true, id: a.id, loginCmd, baselineAttempt });
  } catch (e) { res.status(400).json({ error: e.message }); }
});


// Re-login watcher endpoint (2.333.0): finalize WITH the identity guard —
// a fresh login that belongs to a different account than this record MOVES
// OUT (into the matching record, or a brand-new one) instead of rebranding
// the record and splicing two accounts' history together. Regular Add-flow
// finalize keeps its own merge semantics (there the record IS a throwaway).
app.post('/api/accounts/:id/relogin-finalize', (req, res) => {
  try {
    const r = accounts.reloginResolve(req.params.id);
    // GATE ON reloginResolve's REAL ANSWER (round-2 verifier — the round-1 gate
    // read `r.loggedIn`, a property this method has never returned on ANY of
    // its four outcomes, so the sweep was dead on the exact route the inbox
    // item and the login chip send the user to). Its shapes are:
    //   'pending'                  — nothing on disk yet: stay silent
    //   'same'  { account }        — the ordinary in-place re-login
    //   'split' { account }        — a stranger's login, minted as a new record
    //   'moved' { movedTo }        — the login belonged to ANOTHER record and
    //                                was relocated into it; that record's
    //                                ledger row is the one to retract, and
    //                                there is no `account` here at all
    const captured = !!r?.account?.loggedIn || r?.outcome === 'moved';
    if (captured) {
      sweepOnLoginTransition(req.params.id, r, 're-login');
      // the record the login LANDED in: 'moved' relocated it into another one
      wakeOnLoginSuccess(req.params.id, r, 're-login', r?.movedTo?.id || r?.account?.id || req.params.id);
    }
    try {
      // SAME-SPELLING WARNING (2026-09-07): this `loginState` is a STRING
      // ('error') describing how the login TERMINAL run went. The account ROW
      // in accounts.list() also carries `loginState` — an OBJECT describing
      // the login SESSION's lifetime (src/login-expiry.js). Different objects,
      // different types; never join or compare them.
      const ls = accounts._subscriptionLoginStatus?.(req.params.id);
      if (ls) { r.loginAttempt = ls.attempt || null; r.loginState = ls.state || null; }
    } catch { }
    res.json({ success: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/accounts/subscription/:id/finalize', (req, res) => {
  try {
    const fin = accounts.finalizeSubscription(req.params.id);
    if (fin?.loggedIn) sweepLoginExpiry('subscription login'); // ONCE, above BOTH res.json paths (the merge branch returns early)
    // The wake is FINGERPRINT-GATED where the sweep is not: this route is
    // polled every 3 s for 5 minutes and the sweep is local file reads while
    // the wake spawns a CLI panel. The merge branch below re-wakes the
    // SURVIVOR — the fingerprint differs there (a different record id), so
    // both calls land.
    if (fin?.loggedIn) wakeOnLoginSuccess(req.params.id, fin, 'subscription login');
    // attempt identity for the re-login watcher (2.332.0): which helper RUN
    // produced the current state — lets the client ignore a pre-existing login
    try {
      const ls = accounts._subscriptionLoginStatus?.(req.params.id);
      if (fin && ls) { fin.loginAttempt = ls.attempt || null; fin.loginState = ls.state || null; }
    } catch { }
    // Same-account auto-recognition (2.205.0, real ask "这个不能自动识别吗"):
    // a fresh login whose identity email matches an EXISTING subscription is
    // the SAME account — fold the new record into the existing one (fresh
    // creds win) instead of keeping a duplicate.
    // A macOS Keychain service is tied to this fresh config-dir path. Folding
    // its file fallback into an older id would leave Claude preferring the
    // older id's stale Keychain item, so Darwin logins deliberately keep their
    // fresh record instead of using the path-changing auto-merge.
    if (fin?.loggedIn && fin?.email && !fin.localOnly && accounts) {
      const em = String(fin.email).trim().toLowerCase();
      const dup = (accounts.list().accounts || []).find((x) =>
        x.id !== req.params.id && (x.backend || 'claude') === 'claude' && x.type === 'subscription'
        && String(x.email || (String(x.name || '').includes('@') ? x.name : '')).trim().toLowerCase() === em);
      if (dup) {
        try {
          const merged = accounts.mergeSubscription(req.params.id, dup.id, { preferFromCreds: true, liveAccountIds: liveAccountIdSet() });
          // AGAIN, AFTER THE MERGE (round-2 verifier). The sweep above ran
          // while the fresh credentials were still in the THROWAWAY record's
          // dir — the survivor, which is the record carrying the open warning,
          // still had its dead file, so the sweep read a stale deadline and
          // retracted nothing. `mergeSubscription` is the moment the
          // survivor's credential file actually changes, so the sweep that
          // can see it has to come after. The sweep is idempotent (test-login-
          // expiry §5c(g) pins a repeat resolving nothing a second time), so
          // the pre-merge one stays: it is the only sweep on every non-merge
          // exit.
          sweepLoginExpiry('subscription login merge');
          // THE SURVIVOR is the record the pool holds and the one the fresh
          // credentials now live in; the throwaway above is about to stop
          // existing.
          wakeOnLoginSuccess(dup.id, merged, 'subscription login merge', merged?.id || dup.id);
          return res.json({ success: true, ...fin, merged: true, account: merged });
        } catch (me) {
          if (me.code !== 'merge-account-live') throw me;
          // logged in, but a running session blocks the auto-fold — keep both, tell the user
          return res.json({ success: true, ...fin, merged: false, mergeBlocked: 'a session using one of these accounts is running — stop it to auto-merge the duplicate' });
        }
      }
    }
    res.json({ success: true, ...fin });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Add a Console account safely: the /login runs in an isolated dir so it can't
// wipe the global subscription; we capture the minted key from that dir.
app.post('/api/accounts/console-login', (req, res) => {
  try {
    const { id, dir } = accounts.beginConsoleLogin();
    // BOTH env vars → dir (pre-seeded, no onboarding): the console login's
    // .credentials.json wipe AND the minted primaryApiKey land in the isolated
    // dir; ~/.claude and ~/.claude.json are untouched. capture reads the dir.
    const q = JSON.stringify(dir);
    const loginCmd = `CLAUDE_CONFIG_DIR=${q} CLAUDE_SECURESTORAGE_CONFIG_DIR=${q} claude auth login --console`;
    res.json({ success: true, id, loginCmd });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/accounts/console-login/:id/capture', (req, res) => {
  try { res.json({ success: true, ...accounts.captureConsoleLogin(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Codex multi-subscription: same idea via CODEX_HOME. Codex has no auth-only
// relocation env, so each account is an isolated CODEX_HOME whose sessions/ +
// config.toml SYMLINK the shared ~/.codex — auth.json is real per-account,
// threads land in the shared sessions dir (unified discovery). `codex login`
// prints an OAuth URL to a hosted callback (headless-friendly). ──
app.post('/api/accounts/codex-subscription', (req, res) => {
  try {
    const { id, dir } = accounts.createCodexSubscription(req.body || {});
    // --device-auth: prints a URL + one-time code (no localhost:1455 callback
    // server), so it works when the browser is on a DIFFERENT machine than this
    // server (team/remote deploys) — same headless philosophy as claude's
    // paste-code login. CODEX_HOME points at the isolated per-account dir.
    const loginCmd = `CODEX_HOME=${JSON.stringify(dir)} codex login --device-auth`;
    res.json({ success: true, id, dir, loginCmd });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/accounts/codex-subscription/:id/finalize', (req, res) => {
  try {
    const fin = accounts.finalizeCodexSubscription(req.params.id);
    // The device-auth completion sweeps too. Codex declares no creds.loginState,
    // so this member itself contributes nothing — but the sweep is per-INSTANCE
    // (it walks every subscription), and "a login just finished" is the one
    // event we have that says the roster's login facts moved.
    if (fin?.loggedIn) sweepLoginExpiry('codex device-auth');
    if (fin?.loggedIn) wakeOnLoginSuccess(req.params.id, fin, 'codex device-auth');
    res.json({ success: true, ...fin });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

}
module.exports = { create };
