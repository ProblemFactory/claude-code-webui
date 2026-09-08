/**
 * Usage / rate-limit cluster — extracted verbatim from server.js (2.92.0 split).
 * Everything about quota visibility lives here: the passive statusline-cache
 * ingest (§ban-safety: NO background polling by default), the read-only OAuth
 * token accessor, the opt-in active poll, the user-initiated on-demand quota
 * refresh, and the codex rollout-tail rate-limit summarizer.
 * See CLAUDE.md §9 + accounts.js §ban-safety before changing ANY cadence here.
 */
const fs = require('fs');
const { accountLoginState } = require('./login-state.js'); // THE credential-state reader (shared with the pool engine + the repair migration)
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ── Quota READING parsers live in the harness registry (S4, docs/design-
// harness-plugins.md §2.4): each harness's QuotaSignalSource.normalize is
// the ONE normalizer for its reading shapes. The names below are the same
// functions this file used to define (moved verbatim) — re-exported at the
// bottom for current callers (tests, the engine) so nothing drifts.
const harnesses = require('./harnesses');
const claudeQuota = harnesses.get('claude').quota;
const parseCliUsageText = claudeQuota.parseCliUsageText;      // `claude -p /usage` panel text
const normalizeCodexRateLimit = harnesses.get('codex').quota.normalize; // codex rate_limits (rollout / live push / rateLimits/read)

function setupUsage({ app, accounts, hosts, usageHistory, activeSessions, serverSetting, ensureDir, USAGE_CACHE_FILE, USAGE_CACHE_DIR, CODEX_SESSIONS_DIR, META_DIR, AVAILABLE_MODELS, BUFFERS_DIR, probeUsageForAccountKey, onMemberReadingFresh, CLAUDE_CMD }) {
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
let _oauthSignedOut = false; // credentials file present but emptied — see the cause split below
let _oauthSignedOutCause = 'expired'; // 'console' (replaced by a Console /login) | 'expired' (idle machine login aged out)

function _readOAuthCreds() {
  try {
    // Linux: .credentials.json
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credsPath)) {
      const stat = fs.statSync(credsPath);
      if (_oauthCreds && stat.mtimeMs === _oauthMtime) return _oauthCreds;
      const raw = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const o = raw?.claudeAiOauth;
      if (o?.accessToken) { _oauthCreds = o; _oauthMtime = stat.mtimeMs; _oauthSignedOut = false; return _oauthCreds; }
      // File parses but holds no token. TWO distinct causes (2.266.2 — the
      // blanket "a Console login replaced it" wording was wrong for the real
      // 2026-08-09 case): (a) a Console /login wiped it (primaryApiKey lands in
      // ~/.claude.json); (b) the machine login sat IDLE until its refresh token
      // expired — with named/pooled accounts handling every session nothing
      // refreshes ~/.claude — and the CLI's failed refresh cleared the stored
      // tokens (empty access+refresh, metadata kept). Cause derived once per
      // creds-file change (never per poll — ~/.claude.json can be large).
      if (!_oauthSignedOut || stat.mtimeMs !== _oauthMtime) {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
          _oauthSignedOutCause = cfg?.primaryApiKey ? 'console' : 'expired';
        } catch { _oauthSignedOutCause = 'expired'; }
      }
      _oauthMtime = stat.mtimeMs;
      _oauthSignedOut = true;
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

function getOAuthToken(callback) {
  // READ-ONLY: we NEVER refresh the OAuth token ourselves. Anthropic's refresh
  // tokens rotate (each refresh invalidates the previous one), so calling the
  // refresh endpoint would burn the token Claude Code still has stored — on
  // macOS that lives in the Keychain, which we can't safely rewrite, forcing a
  // daily re-login (issue #20). We only USE a currently-valid access token; if
  // it's expired we return null and skip, letting Claude Code refresh it through
  // its own session activity — the next poll picks up the fresh token. (60s
  // skew so we don't use a token about to expire mid-request.)
  const creds = _readOAuthCreds();
  const token = (creds?.accessToken && (!creds.expiresAt || Date.now() < creds.expiresAt - 60000))
    ? creds.accessToken
    : null;
  if (callback) { callback(token); return; }
  return token;
}

// Non-invasive usage/rate-limit polling via GET /api/oauth/usage.
//
// The old approach made a BILLABLE haiku `POST /v1/messages` every 5 min purely
// to read the unified rate-limit RESPONSE HEADERS — consuming quota to measure
// quota, and (because that call needs a fresh token) driving the token refresh
// that rotates and breaks the macOS Keychain (#20). /api/oauth/usage returns
// the same 5h/7d utilization directly in the body for FREE, with a read-only
// token. It rate-limits HARD on bursts (~5 rapid requests → 429 for 5 min;
// verified), so we poll once per ~5 min and on 429 back off for the advised
// window, keeping the last-known value rather than retry-storming.
let _rateLimitBackoffUntil = 0;

function refreshRateLimit() {
  if (Date.now() < _rateLimitBackoffUntil) return; // honoring a prior 429
  const token = getOAuthToken();                   // read-only; null if expired
  if (!token) return;                              // keep last-known; Claude refreshes the token
  _fetchOAuthUsage(token);
}

// GET /api/oauth/usage reply → usage-cache shape: the claude harness's
// parseOAuthUsage (moved there verbatim in S4; bound under the old name).
const _parseUsage = claudeQuota.parseOAuthUsage;

// Consume RAW vendor reply bodies the DEVICE op returned (quota-refresh runs
// the human-gated fetch ON the machine holding the login — design §Quota
// refresh origin; the parse stays here, one implementation for both origins).
function _consumeDeviceQuota(r) {
  if (!r || !r.usage) return null;
  if (r.usage.status === 429) { _rateLimitBackoffUntil = Date.now() + 300000; return null; }
  if (r.usage.status !== 200) return null;
  let u = null; try { u = _parseUsage(JSON.parse(r.usage.body)); } catch { return null; }
  if (r.roles && r.roles.status === 200) {
    try {
      const j = JSON.parse(r.roles.body);
      if (j.organization_uuid) {
        const m = /^(\S+@\S+)'s Organization$/.exec(j.organization_name || '');
        Object.assign(u, { orgUuid: j.organization_uuid, orgName: j.organization_name || '', ...(m ? { orgEmail: m[1] } : {}) });
      }
    } catch { }
  }
  return u;
}

// cb(usageObj) on a 200; cb(null) on any failure (caller keeps last-known).
function _fetchOAuthUsage(token, cb) {
  cb = cb || ((u) => { if (u) { _rateLimitCache = u; writeUsageCache(); } });
  // OAuth-only endpoint; a real API key can't read subscription usage.
  if (typeof token === 'string' && token.startsWith('sk-ant-api')) { cb(null); return; }
  const req = https.request('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    // DORMANT: nothing schedules this anymore (usage is captured passively via
    // the statusLine hook). Kept ONLY as a user-initiated one-shot primitive.
    // Deliberately NOT spoofing the claude-code User-Agent — impersonating the
    // official harness is itself an enforced-against pattern; the honest fix was
    // to remove the background poll, not to disguise it.
    headers: { 'authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
  }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode === 429) {
        const ra = parseInt(res.headers['retry-after'] || '300', 10);
        _rateLimitBackoffUntil = Date.now() + (Number.isFinite(ra) ? ra : 300) * 1000;
        console.warn(`[rate-limit] /api/oauth/usage 429 — backing off ${ra}s (keeping last-known)`);
        cb(null); return;
      }
      if (res.statusCode !== 200) { console.warn(`[rate-limit] /api/oauth/usage HTTP ${res.statusCode}`); cb(null); return; }
      try { cb(_parseUsage(JSON.parse(body))); } catch { cb(null); }
    });
  });
  req.on('error', () => cb(null));
  req.end();
}

// Token → TRUE account identity (org uuid/name). Rides ONLY on the human-gated
// on-demand refresh (never scheduled) — one extra read-only call per ⟳ click.
// Exists because ~/.claude.json's oauthAccount goes STALE after a /login
// account switch (real incident: config said one email, the token actually
// belonged to another account — the usage popup looked like two subscriptions
// had swapped quotas). The org uuid is the only trustworthy join key.
function _fetchOAuthRoles(token, cb) {
  if (typeof token === 'string' && token.startsWith('sk-ant-api')) { cb(null); return; }
  const req = https.request('https://api.anthropic.com/api/oauth/claude_cli/roles', {
    method: 'GET',
    headers: { 'authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
    timeout: 8000,
  }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) { cb(null); return; }
      try {
        const j = JSON.parse(body);
        if (!j.organization_uuid) { cb(null); return; }
        // Personal orgs are named "<email>'s Organization" — extract the email
        // for display; team orgs just carry their org name.
        const m = /^(\S+@\S+)'s Organization$/.exec(j.organization_name || '');
        cb({ orgUuid: j.organization_uuid, orgName: j.organization_name || '', ...(m ? { orgEmail: m[1] } : {}) });
      } catch { cb(null); }
    });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
  req.end();
}

// Per-subscription-account usage. Key = account id; '__global__' = the
// machine's own login. Populated PASSIVELY from data/usage-cache/<key>.json,
// which the statusLine hook (data/bin/vibespace-usage) writes from the CLI's
// OWN rate_limits during a real session — NO background OAuth calls.
const _accountUsage = {}; // id → { ...usage, name }

// ── §ban-safety: background /api/oauth/usage polling is OPT-IN, default OFF ───
// By DEFAULT we do NOT poll the usage endpoint with subscription OAuth tokens.
// A fixed-cadence call using a subscription token — for accounts that may be
// idle, from a server — is the textbook "automated / non-human access outside
// the official client" pattern (Consumer Terms §3.7; 2026-02-20 OAuth
// clarification) that flags Max/Pro accounts as bots and gets them banned. So
// usage is normally a BYPRODUCT of real sessions (the statusLine hook caches
// the CLI's own rate_limits). The user can OPT IN to the old active poll via
// the setting below (with a stark automation-risk warning) — e.g. to see live
// usage for chat-only/idle accounts — accepting the ban risk.
function usagePollingEnabled() {
  try { return !!serverSetting('accounts.activeUsagePolling'); } catch { return false; }
}
// Which NAMED claude subscription IS the machine's own ~/.claude login (email
// match)? When linked, the '__global__' cache and that account's cache are two
// views of ONE quota: sessions on the global login write __global__.json,
// sessions with the account explicitly selected write <subId>.json — so we
// merge them newest-wins BOTH ways and tell the client (usage switcher shows
// ONE entry for the account instead of a confusing duplicate pair).
let _usageGlobalLink = { email: null, loggedIn: false, accountId: null };
let _codexUsageGlobalLink = { email: null, loggedIn: false, accountId: null };
/** Re-read the persisted machine-login snapshot and re-run the passive merge.
 *  The one-shot migrations run INSIDE server.listen's callback, i.e. AFTER this
 *  module already loaded data/usage-cache.json into `_rateLimitCache` at boot
 *  (2026-09-08 repair r6 verifier: unlinking a poisoned sibling changed nothing
 *  for the life of that process — both panel rows kept the stranger's window).
 *  Cheap and idempotent: server.js calls it right after runLocalMigrations(). */
function reloadRateLimitCache() { _rateLimitCache = readUsageCache(); ingestPassiveUsage(); }
function ingestPassiveUsage() {
  const allAccts = accounts.list().accounts || [];
  const roster = allAccts.filter((a) => (a.backend || 'claude') !== 'codex' && a.type === 'subscription');
  const subIds = new Set(roster.map((a) => a.id));
  for (const id of Object.keys(_accountUsage)) if (!subIds.has(id)) delete _accountUsage[id]; // drop removed accounts
  // Same-account link for CODEX: the machine's own ~/.codex login vs the named
  // ChatGPT accounts (cxs-*) — email from the id_token claims on both sides.
  try {
    const cst = accounts.codexGlobalStatus();
    const cem = cst.loggedIn && cst.email ? String(cst.email).toLowerCase() : null;
    const cm = cem ? allAccts.find((a) => a.backend === 'codex' && a.email && String(a.email).toLowerCase() === cem) : null;
    _codexUsageGlobalLink = { email: cst.email || null, loggedIn: !!cst.loggedIn, accountId: cm ? cm.id : null };
  } catch { _codexUsageGlobalLink = { email: null, loggedIn: false, accountId: null }; }
  let entries = [];
  try { entries = fs.readdirSync(USAGE_CACHE_DIR); } catch { entries = []; }
  for (const fn of entries) {
    if (!fn.endsWith('.json')) continue;
    const key = fn.slice(0, -5);
    if (key === '__models__') { ingestPassiveModels(fn); continue; }
    let u = null;
    try { u = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, fn), 'utf-8')); } catch { continue; }
    if (!u || typeof u.fetchedAt !== 'number') continue;
    if (key === '__global__') {
      // Newest wins vs whatever we have (a live global poll never runs now).
      if (!_rateLimitCache || (u.fetchedAt > (_rateLimitCache.fetchedAt || 0))) { _rateLimitCache = u; writeUsageCache(); }
    } else if (subIds.has(key)) {
      const meta = roster.find((x) => x.id === key) || {};
      _accountUsage[key] = { ...u, name: meta.name, email: meta.email };
    }
  }
  // Which NAMED claude subscription IS the machine's own ~/.claude login?
  // Computed AFTER the cache pass so org-uuid evidence (captured by on-demand
  // refreshes) is available. Evidence order:
  //   1. org uuid equality (token-derived truth — immune to the stale-config
  //      problem above); a PROVEN-different org also BREAKS an email match.
  //   2. email match (~/.claude.json oauthAccount vs account emails) — the
  //      original heuristic, still the only signal before any ⟳ was clicked.
  try {
    const st = accounts.subscriptionStatus();
    const em = st.loggedIn && st.email ? String(st.email).toLowerCase() : null;
    const emailMatch = em ? roster.find((a) => a.email && String(a.email).toLowerCase() === em) : null;
    const gOrg = _rateLimitCache?.orgUuid || null;
    let m = emailMatch;
    if (gOrg) {
      const orgMatch = roster.find((a) => _accountUsage[a.id]?.orgUuid === gOrg) || null;
      if (orgMatch) m = orgMatch;
      else if (emailMatch && _accountUsage[emailMatch.id]?.orgUuid) m = null; // both identities known, different orgs
    }
    const actualEmail = _rateLimitCache?.orgEmail || null;
    _usageGlobalLink = {
      email: st.email || null, loggedIn: !!st.loggedIn, accountId: m ? m.id : null,
      // Stale-identity surfacing: what the token ACTUALLY belongs to, when the
      // on-demand refresh captured it and it contradicts the config file.
      actualEmail,
      identityMismatch: !!(actualEmail && st.email && actualEmail.toLowerCase() !== String(st.email).toLowerCase()),
    };
  } catch { _usageGlobalLink = { email: null, loggedIn: false, accountId: null, actualEmail: null, identityMismatch: false }; }
  // Same-account merge (see _usageGlobalLink above): freshest view wins for both.
  const gid = _usageGlobalLink.accountId;
  if (gid) {
    const a = _accountUsage[gid] || null;
    const g = _rateLimitCache || null;
    const newest = (a && (!g || (a.fetchedAt || 0) > (g.fetchedAt || 0))) ? a : g;
    if (newest) {
      const meta = roster.find((x) => x.id === gid) || {};
      if (newest !== g) {
        const { name, email, ...usage } = newest;
        _rateLimitCache = usage; writeUsageCache();
      }
      _accountUsage[gid] = { ...newest, name: meta.name, email: meta.email };
    }
  }
}
// Merge PASSIVELY-discovered full model IDs (from the statusLine hook — models
// you actually ran) into the Claude dropdown, after the hardcoded aliases and
// deduped by id. Zero API calls; this is the passive counterpart to the
// (now opt-in) /v1/models fetch.
function ingestPassiveModels(fn) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, fn), 'utf-8')); } catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  const have = new Set((AVAILABLE_MODELS.claude || []).map((m) => m.id));
  const add = list.filter((m) => m && typeof m.id === 'string' && !have.has(m.id))
                  .map((m) => ({ id: m.id, label: m.label || m.id }));
  if (add.length) AVAILABLE_MODELS.claude = [...(AVAILABLE_MODELS.claude || []), ...add];
}
ingestPassiveUsage();
setInterval(ingestPassiveUsage, 30000); // local disk read only — no network
// Normalizer-visible settings (chat.hideEmptyHooks) — lazy, store-safe getter.

// OPT-IN active poll (default OFF; see usagePollingEnabled + the stark warning
// on accounts.activeUsagePolling). When enabled it restores the pre-2.60.0
// behavior: global login every ~5 min + one named subscription per 90s tick
// (round-robin). No-op every tick while the setting is off, so toggling it takes
// effect live without a restart. This is the ONLY code path that contacts
// Anthropic for usage, and the user explicitly accepted the risk to enable it.
let _acctUsageRR = 0;
let _lastGlobalUsagePoll = 0;
function pollUsageActive() {
  if (!usagePollingEnabled()) return;               // OPT-IN gate
  if (Date.now() < _rateLimitBackoffUntil) return;  // honoring a prior 429
  // Global login (the machine's own) — at most every 5 min.
  if (Date.now() - _lastGlobalUsagePoll > 300000) {
    _lastGlobalUsagePoll = Date.now();
    const gtok = getOAuthToken();
    if (gtok) _fetchOAuthUsage(gtok, (u) => { if (u) { _rateLimitCache = u; writeUsageCache(); } });
  }
  // One named subscription per tick (round-robin); idle/expired-token accounts
  // are skipped and keep last-known.
  const subs = (accounts.list().accounts || []).filter((a) => a.type === 'subscription');
  const ids = new Set(subs.map((a) => a.id));
  for (const id of Object.keys(_accountUsage)) if (!ids.has(id)) delete _accountUsage[id];
  if (!subs.length) return;
  const a = subs[_acctUsageRR++ % subs.length];
  const token = accounts.usageToken(a.id);
  if (!token) return;
  _fetchOAuthUsage(token, (u) => { if (u) _accountUsage[a.id] = { ...u, name: a.name, email: a.email }; });
}
setInterval(pollUsageActive, 90000);

// ── On-demand quota refresh (USER-INITIATED, throttled) ──────────────────────
// The statusline payload carries ONLY five_hour/seven_day — model-scoped weekly
// buckets (e.g. the Fable cap) are never in it (verified against the 2.1.206
// payload builder: rate_limits spreads exactly those two windows), so passive
// capture cannot show them. This endpoint is the human-gated equivalent of
// running /usage in the CLI: fired from the usage popup (open / ⟳ click),
// NEVER on a timer, one account per call, ≥60s per account, honoring the
// global 429 backoff. §ban-safety: interactive user action, not background
// automation — do NOT wire this to any scheduler.
const _onDemandUsageAt = {};
// Remote-host quota snapshots (2.127.0): keyed by host id, persisted to
// usage-cache/host-<id>.json by the on-demand ⟳ (read-only remote token —
// never refreshed, §ban-safety; no scheduler anywhere near this).
const _hostUsage = {};
// Host-HELD account quota snapshots (2.245.0): '<hostId>:<acctId>' → snapshot,
// persisted as usage-cache/host-<hostId>-<acctId>.json. Account ids are
// strictly sub-[\w-]+ (validated at write), so the host-account pattern is
// checked FIRST — the plain host pattern would otherwise swallow these files
// and pollute _hostUsage with bogus host keys.
const _hostAcctUsage = {};
try {
  for (const f of fs.readdirSync(USAGE_CACHE_DIR)) {
    const ma = /^host-([\w-]+)-(sub-[\w-]+)\.json$/.exec(f);
    if (ma) { try { _hostAcctUsage[ma[1] + ':' + ma[2]] = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, f), 'utf-8')); } catch {} continue; }
    const m = /^host-([\w-]+)\.json$/.exec(f);
    if (m) { try { _hostUsage[m[1]] = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, f), 'utf-8')); } catch {} }
  }
} catch {}
// Ledger harvest from remote hosts (ssh, incremental via remote-side cursors).
// One at a time per server; throttling lives in hosts.harvestUsage (15min).
// TIMESTAMPED LEASE, not a boolean (2.271.0 T1-5): a hung device stream used
// to leave _harvestBusy true forever, so every later harvest answered
// {busy:true} until a server restart — remote usage collection silently died
// fleet-wide after ONE link flap. The lease expires; the underlying op is
// bounded too (runStream now settles on link death).
let _harvestLease = 0;
const HARVEST_LEASE_MS = 5 * 60 * 1000;
app.post('/api/usage-stats/harvest-hosts', async (req, res) => {
  if (!hosts || !usageHistory) return res.json({ hosts: {} });
  if (Date.now() - _harvestLease < HARVEST_LEASE_MS) return res.json({ busy: true });
  _harvestLease = Date.now();
  const out = {};
  try {
    const scannerPath = path.join(path.dirname(USAGE_CACHE_DIR), 'bin', 'vibespace-usage-scan');
    const want = req.body?.host ? [req.body.host] : hosts.list().map((h) => h.id);
    for (const id of want) {
      try {
        const h = hosts.get(id);
        const text = await hosts.harvestUsage(id, { force: !!req.body?.force, scannerPath });
        out[id] = text ? usageHistory.ingestRemoteEvents(id, h.name, text) : { added: 0, throttled: !text };
      } catch (e) { out[id] = { error: String(e.message || e).slice(0, 160) }; }
    }
  } finally { _harvestLease = 0; }
  res.json({ hosts: out });
});

// The CLI-panel refresher, callable from the route AND the auto-cli loop
// (2.329.0). One spawn = one first-party `/usage` fetch by the official
// binary; writes the same per-account cache the statusline hook uses. Returns
// true when a parseable panel landed.
//
// ATTRIBUTION (2026-09-07, the readings-by-slot rule for a SESSION-LESS
// reading): this reading has no session, so there is no credential slot to
// resolve — its identity IS the config dir the spawn was given. `key` and
// `CLAUDE_SECURESTORAGE_CONFIG_DIR` are therefore ONE decision, made once into
// `credsDir` below and used for both the spawn and the write-back, rather than
// derived twice and compared (a check that cannot fail is not protection —
// making it structurally impossible is). Every other producer now follows the
// same rule the hard way (readingSlotFor); this one gets it for free.
async function refreshViaCliPanel(key) {
  const isGlobal = key === '__global__';
  let acctMeta = null;
  if (!isGlobal) {
    acctMeta = (accounts.list().accounts || []).find((x) => x.id === key && x.type === 'subscription');
    if (!acctMeta) return false;
  }
  const cliPanel = await new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
      // ONLY the secret store relocates (session-spawn parity): the token IS
      // the identity the panel reports; projects/settings stay shared.
      // credsDir = the identity this reading WILL be keyed by (see above).
      const credsDir = isGlobal ? null : accounts.subDir(key);
      if (credsDir) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = credsDir;
      const bin = CLAUDE_CMD || 'claude';
      execFile(bin, ['-p', '/usage'], { env, cwd: os.tmpdir(), timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseCliUsageText(stdout));
      });
    } catch { resolve(null); }
  });
  if (!(cliPanel && (cliPanel.fiveHour || cliPanel.sevenDay))) return false;
  // THE ROSTER IS ASKED AGAIN AT THE WRITE, NOT ONLY AT THE SPAWN (r3, the
  // auto-merge finding's belt). This function's only roster check happens
  // before a 60-second `execFile`, and a record CAN stop existing inside that
  // window — the subscription auto-merge deletes the throwaway milliseconds
  // after the login edge, and a removed account is a normal user action too.
  // Nothing in accounts.js or the routes deletes usage-cache entries when an
  // account goes away, and `establishedWindows()` reads every `.json` in that
  // directory with no roster filter, so a write here would leave a cache file
  // AND a window sidecar keyed to an id that no longer names anything. FALSE,
  // not true: no reading was recorded, and the caller's backoff is the right
  // response to a panel whose subject vanished.
  if (!isGlobal && !(accounts.list().accounts || []).some((x) => x.id === key)) {
    console.log(`[usage] the /usage panel for ${key} answered after the account was removed — discarding the reading`);
    return false;
  }
  _onDemandUsageAt[key] = Date.now();
  const u = { ...cliPanel, source: 'on-demand', scopedFetchedAt: Date.now() };
  try {
    fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
    const f = path.join(USAGE_CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
    // preserve org identity + any fields the panel doesn't carry
    let prev = {}; try { prev = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { }
    const merged = { ...prev, ...u, scopedWeekly: u.scopedWeekly?.length ? u.scopedWeekly : (prev.scopedWeekly || []) };
    // A preserve-merge inherits IDENTITY, never PROVENANCE (2026-09-07 r2):
    // `corroborated` is a verdict about the write that carried it. This panel
    // has no session, so there is nothing to corroborate with — inheriting the
    // last session-write's verdict rendered "via own /usage panel · not
    // corroborated" about a reading the account made about itself. Same rule
    // as captureRateLimitEvent (which deletes it when undefined).
    if (u.corroborated === undefined) delete merged.corroborated;
    // WEEKLY RESET PROJECTION (2.369.33, owner ask): the panel omits '· resets'
    // for a bucket at 0%, but weekly windows repeat on a fixed 7-day anchor —
    // carry the last observed weekly reset forward (projectReset) and mark it
    // estimated. The 5-hour bucket is NOT projected (its window starts with
    // the first request; a stale one would be a lie).
    try {
      const { projectReset, WEEK_SEC } = require('./harnesses/claude-quota.js');
      const nowSec = Math.floor(Date.now() / 1000);
      if (merged.sevenDay && !merged.sevenDay.resetsAt && prev.sevenDay?.resetsAt) { const p = projectReset(prev.sevenDay.resetsAt, WEEK_SEC, nowSec); if (p) merged.sevenDay = { ...merged.sevenDay, resetsAt: p, resetsAtEstimated: true }; }
      else if (merged.sevenDay?.resetsAt && !u.sevenDay?.resetsAt && prev.sevenDay?.resetsAtEstimated) merged.sevenDay = { ...merged.sevenDay, resetsAtEstimated: true };
      if (Array.isArray(merged.scopedWeekly) && Array.isArray(prev.scopedWeekly)) {
        merged.scopedWeekly = merged.scopedWeekly.map((sw) => {
          if (!sw || sw.resetsAt) return sw;
          const before = prev.scopedWeekly.find((x) => x && x.name === sw.name && x.resetsAt);
          const p = before ? projectReset(before.resetsAt, WEEK_SEC, nowSec) : null;
          return p ? { ...sw, resetsAt: p, resetsAtEstimated: true } : sw;
        });
      }
    } catch { }
    // ESTABLISH THE ACCOUNT'S OWN WINDOW (inc-mts8a8mr-ulmm). This producer is
    // the only one whose KEY and whose CREDENTIAL DIR are the same decision
    // (see the header above), so it is the only one entitled to say "this is
    // the window `key`'s buckets are counted in". Every session-attributed
    // producer is then checked AGAINST it (src/reading-lag.js ②) instead of
    // being allowed to redefine the account by writing a foreign window into
    // `sevenDay.resetsAt` — which is exactly what a mis-filed reading does, and
    // why the established window may never be read back out of that field.
    // It is written to a SIDECAR beside the cache, never into `merged` (r2,
    // reproduced): this object is rebuilt wholesale by the statusline hook
    // every 8 s, by the bare-token ⟳ and by the codex snapshot writer, and a
    // field there survives only while every one of them remembers to carry it.
    // One legitimate statusline render deleted every established window on the
    // instance and replayed the incident. See windowSidecarName.
    try {
      const { windowOf, windowSidecarName } = require('./reading-lag.js');
      const w = windowOf(merged);
      if (w.sevenDay || w.fiveHour || Object.keys(w.scoped).length) {
        const wf = path.join(USAGE_CACHE_DIR, windowSidecarName(key));
        fs.writeFileSync(wf + '.tmp', JSON.stringify({ ...w, at: Date.now(), source: 'on-demand' }));
        fs.renameSync(wf + '.tmp', wf);
      }
    } catch { }
    fs.writeFileSync(f + '.tmp', JSON.stringify(merged)); fs.renameSync(f + '.tmp', f);
    if (isGlobal) { _rateLimitCache = merged; writeUsageCache(); }
    else _accountUsage[key] = { ...merged, name: acctMeta.name, email: acctMeta.email };
    try { ingestPassiveUsage(); } catch { }
  } catch { }
  return true;
}

// A HUMAN ⟳ THAT REVEALS A USABLE MEMBER MUST RE-DRIVE THE POOL (2026-09-08,
// the new-member incident). This route used to write the reading and answer
// {success:true}: it re-ran no pool decision and it did not touch the
// conversations ARMED on exhaustion, so the owner clicked refresh, watched the
// number change, and eight conversations kept waiting for a reset eight hours
// out. Every LOCAL rung below therefore takes the ONE edge — session,
// cli-panel and the bare-token ladder — because a third rung would otherwise
// be the one that forgets.
//
// LOCAL ONLY, DELIBERATELY. The `host` branch above returns long before this:
// a remote machine's pool is decided by the instance that owns it, and the
// conversations armed there are not ours to continue. (Its readings still land
// in the host-<id> caches for the panels, exactly as before.)
//
// The edge is idempotent, rate-floored per member, and refuses a reading that
// is missing, stale, or whose weekly window says it is another member's — see
// onMemberReadingFresh. Failure is swallowed: a refresh must not fail because
// a follow-up pool evaluation did.
//
// '__global__' is skipped as a COST saving, not a rule: the machine login is
// not a `sub-` record, so it can never be a pool member (poolMembers filters
// subscriptions) and a session billed to it carries no `_accountId` to match —
// the edge would do a cache read and a roster walk to reach the same answer.
const wakePool = (key, why) => {
  try { if (key && key !== '__global__' && onMemberReadingFresh) onMemberReadingFresh(key, why); }
  catch (e) { console.warn('[usage] pool wake after refresh failed:', e.message); }
};

app.post('/api/usage/refresh', async (req, res) => {
  // User-facing kill switch (accounts.onDemandQuotaRefresh = 'off'): never
  // contact Anthropic, even if a stale client asks.
  let odMode = 'manual';
  try { odMode = serverSetting('accounts.onDemandQuotaRefresh') || 'manual'; } catch {}
  if (odMode === 'off') return res.status(403).json({ error: 'on-demand quota refresh is disabled in Settings' });
  // Remote host (2.127.0): read the host's own login token over ssh
  // (READ-ONLY — never refreshed) and do the same single human-gated call.
  if (req.body?.host && hosts) {
    const hid = String(req.body.host);
    if (Date.now() < _rateLimitBackoffUntil) return res.json({ throttled: true, reason: 'backoff' });
    // Host-HELD account variant (2.245.0): {host, account} together — read the
    // account's OWN creds dir on the host (~/.vibespace/subs/<id>; READ-ONLY,
    // never refreshed — same §ban-safety class as the machine-login peek
    // below) and make the same single human-gated call with that token.
    if (req.body.account) {
      const aid = String(req.body.account);
      if (!/^sub-[\w-]{1,40}$/.test(aid)) return res.status(400).json({ error: 'bad account id' });
      const tkey = 'host:' + hid + ':' + aid;
      if (Date.now() - (_onDemandUsageAt[tkey] || 0) < 60000) return res.json({ throttled: true });
      let hMeta2; try { hMeta2 = hosts.get(hid); } catch { return res.status(404).json({ error: 'unknown host' }); }
      const acctMeta2 = (accounts.list().accounts || []).find((x) => x.id === aid);
      if (!acctMeta2) return res.status(404).json({ error: 'unknown account' });
      // Throttle is stamped only AFTER a probe actually reached the host
      // (2.271.0 T2-12) — stamping first meant an immediate retry after an
      // unreachable-host failure answered {throttled:true} for 60s.
      // DEVICE-EXECUTED refresh first (2.298.0, §Quota refresh origin): the
      // token is used FROM THE MACHINE that holds it — the server never sees
      // it and the token-from-a-foreign-IP signal is gone. Old daemons /
      // failures fall through to the legacy token-peek path unchanged.
      const deviceLeg = async () => {
        const dm = await hosts.device(hid);
        const r = await dm.quotaRefresh({ subDir: aid, humanGated: true });
        const u = _consumeDeviceQuota(r);
        if (!u) throw new Error('device refresh returned no usable reading');
        return u;
      };
      deviceLeg().then((u) => {
        _onDemandUsageAt[tkey] = Date.now();
        u.source = 'on-demand';
        u.scopedFetchedAt = Date.now();
        _hostAcctUsage[hid + ':' + aid] = { ...u, name: acctMeta2.name, email: acctMeta2.email };
        try {
          fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
          const f = path.join(USAGE_CACHE_DIR, 'host-' + hid.replace(/[^\w-]/g, '_') + '-' + aid + '.json');
          fs.writeFileSync(f + '.tmp', JSON.stringify(_hostAcctUsage[hid + ':' + aid])); fs.renameSync(f + '.tmp', f);
        } catch {}
        res.json({ success: true, origin: 'device' });
      }).catch(() => hosts.readRemoteSubOAuth(hid, aid).then((token) => {
        _onDemandUsageAt[tkey] = Date.now();
        if (!token) return res.json({ error: 'no currently-valid login for this account on the host — run a session on it there first' });
        _fetchOAuthUsage(token, (u) => {
          if (!u) return res.json({ error: 'refresh failed (rate-limited or offline) — kept last-known' });
          u.source = 'on-demand';
          u.scopedFetchedAt = Date.now();
          _fetchOAuthRoles(token, (org) => {
            if (org) Object.assign(u, org);
            _hostAcctUsage[hid + ':' + aid] = { ...u, name: acctMeta2.name, email: acctMeta2.email };
            try {
              fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
              const f = path.join(USAGE_CACHE_DIR, 'host-' + hid.replace(/[^\w-]/g, '_') + '-' + aid + '.json');
              fs.writeFileSync(f + '.tmp', JSON.stringify(_hostAcctUsage[hid + ':' + aid])); fs.renameSync(f + '.tmp', f);
            } catch {}
            res.json({ success: true });
          });
        });
      }).catch((e) => res.json({ error: e?.code === 'host-unreachable'
        ? `${hMeta2?.name || hid} isn’t responding — couldn’t check its login. Retry when it’s back.`
        : String(e.message || e).slice(0, 160) })));
      return;
    }
    if (Date.now() - (_onDemandUsageAt['host:' + hid] || 0) < 60000) return res.json({ throttled: true });
    let hMeta; try { hMeta = hosts.get(hid); } catch { return res.status(404).json({ error: 'unknown host' }); }
    const deviceLegG = async () => {
      const dm = await hosts.device(hid);
      const r = await dm.quotaRefresh({ humanGated: true });
      // B-0f13 read path: the reply carries the host's PASSIVE statusline
      // cache (files the remote vibespace-usage hook wrote — zero vendor
      // calls). Merge fetchedAt-GUARDED into the server-side per-host cache:
      // only a strictly-newer reading may overwrite (the anti-poison rule —
      // a stale file must never displace a fresher one). Remote '__global__'
      // = the host's own login → the host-<id> bucket; sub-* keys → the
      // host-held account files the boot loader already recognizes.
      if (r?.passive) {
        try {
          fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
          for (const [k, j] of Object.entries(r.passive)) {
            if (!j?.fetchedAt) continue;
            const fname = k === '__global__'
              ? 'host-' + hid.replace(/[^\w-]/g, '_') + '.json'
              : /^sub-[\w-]{1,40}$/.test(k) ? `host-${hid.replace(/[^\w-]/g, '_')}-${k}.json` : null;
            if (!fname) continue;
            const f = path.join(USAGE_CACHE_DIR, fname);
            let prev = null; try { prev = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { }
            if (prev?.fetchedAt && prev.fetchedAt >= j.fetchedAt) continue;
            const merged = { ...(prev || {}), ...j, source: 'remote-statusline' };
            if (j.corroborated === undefined) delete merged.corroborated; // provenance belongs to the write that made it — the host's own label, if it sent one, describes THIS reading
            fs.writeFileSync(f + '.tmp', JSON.stringify(merged)); fs.renameSync(f + '.tmp', f);
          }
        } catch { }
      }
      const u = _consumeDeviceQuota(r);
      if (!u) throw new Error('device refresh returned no usable reading');
      return u;
    };
    deviceLegG().then((u) => {
      _onDemandUsageAt['host:' + hid] = Date.now();
      u.source = 'on-demand-remote';
      u.scopedFetchedAt = Date.now();
      _hostUsage[hid] = { ...u, name: hMeta.name };
      try {
        fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
        const f = path.join(USAGE_CACHE_DIR, 'host-' + hid.replace(/[^\w-]/g, '_') + '.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify(_hostUsage[hid])); fs.renameSync(f + '.tmp', f);
      } catch {}
      res.json({ success: true, origin: 'device' });
    }).catch(() => hosts.readRemoteOAuth(hid).then((token) => {
      _onDemandUsageAt['host:' + hid] = Date.now(); // stamp only after the probe reached the host
      if (!token) return res.json({ error: 'no currently-valid login token on the host — log in / run claude there first' });
      _fetchOAuthUsage(token, (u) => {
        if (!u) return res.json({ error: 'refresh failed (rate-limited or offline) — kept last-known' });
        u.source = 'on-demand-remote';
        u.scopedFetchedAt = Date.now();
        _fetchOAuthRoles(token, (org) => {
          if (org) Object.assign(u, org);
          _hostUsage[hid] = { ...u, name: hMeta.name };
          try {
            fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
            const f = path.join(USAGE_CACHE_DIR, 'host-' + hid.replace(/[^\w-]/g, '_') + '.json');
            fs.writeFileSync(f + '.tmp', JSON.stringify(_hostUsage[hid])); fs.renameSync(f + '.tmp', f);
          } catch {}
          res.json({ success: true });
        });
      });
    }).catch((e) => res.json({ error: e?.code === 'host-unreachable'
      ? `${hMeta?.name || hid} isn’t responding — couldn’t check its login. Retry when it’s back.`
      : String(e.message || e).slice(0, 160) })));
    return;
  }
  const key = String(req.body?.account || '__global__');
  if (Date.now() < _rateLimitBackoffUntil) return res.json({ throttled: true, reason: 'backoff' });
  if (Date.now() - (_onDemandUsageAt[key] || 0) < 60000) return res.json({ throttled: true });
  // CONTROL-CHANNEL preference (B-7edc, 2.260.0): if a live LOCAL claude chat
  // session is billed to this account, ask ITS CLI via get_usage instead of
  // touching the API ourselves — the fetch is then made by the first-party
  // client (same as the user typing /usage there). Still human-gated (this
  // route IS the ⟳ click) + the same 60s throttle above. Falls through to the
  // bare read-only call when no session answers.
  if (probeUsageForAccountKey) {
    try {
      const viaSession = await probeUsageForAccountKey(key);
      if (viaSession) {
        _onDemandUsageAt[key] = Date.now();
        wakePool(key, 'manual refresh (session)');
        return res.json({ success: true, via: 'session' });
      }
    } catch { /* fall through to the bare call */ }
  }
  const isGlobal = key === '__global__';
  let acctMeta = null;
  if (!isGlobal) {
    acctMeta = (accounts.list().accounts || []).find((x) => x.id === key && x.type === 'subscription');
    if (!acctMeta) return res.status(404).json({ error: 'unknown subscription account' });
  }
  // CLI-PANEL rung (2.327.0, user-verified: `claude -p /usage` prints ALL
  // THREE buckets incl. model-scoped weeklies): spawn the CLI pointed at the
  // account's own creds dir and let IT make the first-party fetch — no token
  // ever touches this server, and accounts with NO live session (the old
  // 'no valid token' dead end) become refreshable. Human-gated (this route IS
  // the ⟳ click) + the same 60s throttle; any failure falls through to the
  // token ladder below. Ambient key/oat env is stripped so the CLI reads the
  // subscription login, not an inherited API key.
  const cliOk = await refreshViaCliPanel(key);
  if (cliOk) { wakePool(key, 'manual refresh (cli-panel)'); return res.json({ success: true, via: 'cli-panel' }); }
  // A record REMOVED while its panel was being read (the r3 belt refuses to
  // write for it) must not fall through to the token ladder: that costs one
  // real vendor request on a SIBLING's token and can re-create the phantom
  // cache entry the belt exists to prevent (member-wake r3 verifier, LOW).
  if (!isGlobal && !(accounts.list().accounts || []).some((x) => x.id === key)) return res.status(404).json({ error: 'that account was removed while its usage was being read' });
  let token = isGlobal ? getOAuthToken() : accounts.usageToken(key);
  // Same-account fallback (2.181.0, real report): a named subscription's dir
  // token is only refreshed while a session RUNS on that dir — but when the
  // machine's global CLI login IS the same Anthropic account (email link),
  // its token is just as authoritative for the shared quota (and vice versa).
  // Still read-only + user-initiated — same §ban-safety class.
  if (!token) {
    try {
      const gl = accounts.subscriptionStatus();
      if (!isGlobal) {
        const email = String(acctMeta.email || '').toLowerCase();
        if (email && gl?.loggedIn && String(gl.email || '').toLowerCase() === email) token = getOAuthToken();
      } else if (gl?.email) {
        const linked = (accounts.list().accounts || []).find((x) => x.type === 'subscription' && String(x.email || '').toLowerCase() === String(gl.email).toLowerCase());
        if (linked) token = accounts.usageToken(linked.id);
      }
    } catch { }
  }
  // IDENTITY-GROUP fallback (2.266.1, real report): the email-link above needs
  // the account RECORD's email, which login flows can leave empty — but the
  // identity groups (orgUuid > email from the usage caches) already know which
  // keys are the same real account. Any currently-valid token in the group is
  // authoritative for the shared quota; the pool keeps the DIR token fresh
  // while '__global__' idles, so this is the rung that actually fires there.
  if (!token) {
    try {
      for (const id of app.locals.usageIdentityAccountIds?.(key) || []) {
        if (id === key) continue;
        token = id === '__global__' ? getOAuthToken() : accounts.usageToken(id);
        if (token) break;
      }
    } catch { }
  }
  if (!token) return res.json({ error: 'no currently-valid token for this account (nor its linked machine login) — run a session on it (the CLI refreshes its own login), then retry' });
  _onDemandUsageAt[key] = Date.now();
  _fetchOAuthUsage(token, (u) => {
    if (!u) return res.json({ error: 'refresh failed (rate-limited or offline) — kept last-known' });
    u.source = 'on-demand';
    u.scopedFetchedAt = Date.now(); // scoped buckets only ever come from here — track their own age
    // Same-click identity capture: the token's TRUE org (see _fetchOAuthRoles).
    // Best-effort — a failure just leaves the fields absent (email heuristics
    // keep working). This is what un-confuses a stale ~/.claude.json identity.
    _fetchOAuthRoles(token, (org) => {
      if (org) Object.assign(u, org);
      // Persist to the same per-account cache file the statusline hook writes:
      // survives restarts, and the hook's preserve-merge keeps scopedWeekly and
      // the org identity alive through subsequent passive (5h/7d-only) writes.
      try {
        fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
        const f = path.join(USAGE_CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify(u)); fs.renameSync(f + '.tmp', f);
      } catch {}
      if (isGlobal) { _rateLimitCache = u; writeUsageCache(); }
      else _accountUsage[key] = { ...u, name: acctMeta.name, email: acctMeta.email };
      try { ingestPassiveUsage(); } catch {} // re-run the global↔named same-account merge
      wakePool(key, 'manual refresh (token)');
      res.json({ success: true });
    });
  });
});

function readCodexWrapperRateLimit(sessionId) {
  if (!sessionId) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(BUFFERS_DIR, sessionId + '.json'), 'utf-8'));
    const snap = normalizeCodexRateLimit(meta?.rateLimits, meta?.rateLimitsFetchedAt || meta?.startedAt || Date.now());
    // The RUNNING wrapper's own sidecar: the same `rate_limits_updated` push
    // the engine consumes live, read back off disk — one producer, one name
    // (2026-09-07 r3).
    if (snap) snap.source = 'codex-rate-limits';
    // stored reset-credit count (wrapper reads it once at startup + on ⟳)
    if (snap && meta?.rateLimitResetCredits) {
      const rc = meta.rateLimitResetCredits;
      snap.resetCredits = { availableCount: Number(rc.availableCount ?? rc.available_count ?? rc?.summary?.availableCount) || 0 };
    }
    return snap;
  } catch {
    return null;
  }
}

function readLatestCodexRateLimitFromJsonl(filePath) {
  try {
    // Tail read only — we scan from the end anyway, and codex JSONLs can be
    // many MB; reading them whole blocked the event loop on every fallback
    const TAIL = 65536;
    const stat = fs.statSync(filePath);
    let content;
    if (stat.size > TAIL) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(TAIL);
        const n = fs.readSync(fd, buf, 0, TAIL, stat.size - TAIL);
        content = buf.toString('utf-8', 0, n);
        content = content.slice(content.indexOf('\n') + 1); // drop the cut-off first line
      } finally { fs.closeSync(fd); }
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line || !line.includes('"type":"event_msg"') || !line.includes('"type":"token_count"') || !line.includes('"rate_limits"')) continue;
      const record = JSON.parse(line);
      const timestamp = record?.timestamp ? Date.parse(record.timestamp) : 0;
      const rateLimits = record?.payload?.rate_limits || null;
      const normalized = normalizeCodexRateLimit(rateLimits, Number.isFinite(timestamp) ? timestamp : Date.now());
      // Mined from a rollout TRANSCRIPT, not from a live stream — a different
      // producer with a different freshness story, so it says so (2026-09-07
      // r3: the codex panel used to label every reading "via unknown").
      if (normalized) { normalized.source = 'codex-rollout'; return normalized; }
    }
  } catch {}
  return null;
}

function listRecentCodexJsonlFiles(limit = 24) {
  const files = [];
  const stack = [CODEX_SESSIONS_DIR];
  // Rollouts are organized sessions/YYYY/MM/DD/ and this walk runs every ~30s
  // forever (usage snapshot refresh) — unpruned it is O(all rollouts ever).
  // Skip date subtrees older than the cutoff; freshest-24 is all we keep anyway.
  const cutoff = new Date(Date.now() - 14 * 86400000);
  const cutoffYMD = [cutoff.getFullYear(), cutoff.getMonth() + 1, cutoff.getDate()];
  const tooOld = (rel) => {
    const segs = rel.split(path.sep).filter(Boolean).map(Number);
    for (let i = 0; i < Math.min(segs.length, 3); i++) {
      if (!Number.isFinite(segs[i])) return false; // not a date layout — keep descending
      if (segs[i] < cutoffYMD[i]) return true;
      if (segs[i] > cutoffYMD[i]) return false;
    }
    return false;
  };
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
        if (tooOld(path.relative(CODEX_SESSIONS_DIR, fp))) continue;
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

// threadId → accountId from session-meta (codex quota is PER ACCOUNT — each
// snapshot must land in the bucket of the account its session billed to).
let _codexAcctMapCache = null;
function codexThreadAccountMap() {
  // META_DIR lives on the (possibly NFS) workspace — same cost class as
  // usage-history's _metaMap, same fix: 60s TTL (attribution of a snapshot
  // to an account tolerates a minute of staleness).
  if (_codexAcctMapCache && Date.now() - _codexAcctMapCache.at < 60000) return _codexAcctMapCache.map;
  const map = {};
  let files = [];
  try { files = fs.readdirSync(META_DIR); } catch {}
  for (const fn of files) {
    if (!fn.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(META_DIR, fn), 'utf-8'));
      if ((m.backend || 'claude') === 'codex' && m.backendSessionId) map[m.backendSessionId] = m.accountId || null;
    } catch {}
  }
  _codexAcctMapCache = { at: Date.now(), map };
  return map;
}

// Overall freshest snapshot (back-compat) + per-account buckets keyed by
// account id / '__global_codex__' (sessions with no VibeSpace account = the
// machine's own codex login). Sources: live wrapper meta (account = the
// session's own), then recent rollout tails (account via session-meta lookup
// on the thread id in the filename).
function summarizeCodexRateLimits() {
  const now = Date.now();
  if (now - _codexRateLimitCacheAt < 30000) return _codexRateLimitCache || { overall: null, byAccount: {} };

  const byAccount = {};
  const keep = (key, snapshot) => {
    if (!snapshot) return;
    if (!byAccount[key] || (snapshot.fetchedAt || 0) > (byAccount[key].fetchedAt || 0)) byAccount[key] = snapshot;
  };
  // SEED FROM DISK first (P1, design-backend-parity.md §1): snapshots used to
  // be re-derived from rollout tails only (24 files / 14 days) — an idle
  // account's quota silently VANISHED. Persisted files also make codex
  // identities visible to the anchors sweep / estimator like claude's.
  try {
    for (const fn of fs.readdirSync(USAGE_CACHE_DIR)) {
      const m = /^(cxs-[\w-]+|__global_codex__)\.json$/.exec(fn);
      if (!m) continue;
      try { keep(m[1], JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, fn), 'utf-8'))); } catch {}
    }
  } catch {}
  for (const [id, session] of activeSessions) {
    if (session.backend !== 'codex' || session.mode !== 'chat') continue;
    keep(session._accountId || '__global_codex__', readCodexWrapperRateLimit(id));
  }
  {
    const threadAcct = codexThreadAccountMap();
    const recentFiles = listRecentCodexJsonlFiles();
    let freshEnough = 0;
    for (const entry of recentFiles) {
      const tm = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.path);
      const snapshot = readLatestCodexRateLimitFromJsonl(entry.path);
      if (!snapshot) continue;
      const acct = tm ? (threadAcct[tm[1].toLowerCase()] || null) : null;
      keep(acct || '__global_codex__', snapshot);
      if (snapshot.fetchedAt && (now - snapshot.fetchedAt) < 5 * 60 * 1000 && ++freshEnough >= 3) break;
    }
  }
  let overall = null;
  for (const s of Object.values(byAccount)) if (!overall || (s.fetchedAt || 0) > (overall.fetchedAt || 0)) overall = s;
  // Same-account merge (codex global ↔ linked named account): newest wins both.
  const gid = _codexUsageGlobalLink.accountId;
  if (gid) {
    const a = byAccount[gid], g = byAccount['__global_codex__'];
    const newest = (a && (!g || (a.fetchedAt || 0) > (g.fetchedAt || 0))) ? a : g;
    if (newest) { byAccount[gid] = newest; byAccount['__global_codex__'] = newest; }
  }
  // WRITE-THROUGH (P1): freshest-wins persistence, same anti-poison rule as
  // the claude device read-back — never let an older snapshot overwrite a
  // newer file (fetchedAt-guarded by `keep` above, which already merged disk).
  try {
    fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
    for (const [key, snap] of Object.entries(byAccount)) {
      if (!/^(cxs-[\w-]+|__global_codex__)$/.test(key)) continue;
      const f = path.join(USAGE_CACHE_DIR, key + '.json');
      let cur = null; try { cur = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
      if (cur && (Number(cur.fetchedAt) || 0) >= (Number(snap.fetchedAt) || 0)) continue;
      fs.writeFileSync(f + '.tmp', JSON.stringify(snap)); fs.renameSync(f + '.tmp', f);
    }
  } catch {}
  _codexRateLimitCache = { overall, byAccount };
  _codexRateLimitCacheAt = now;
  return _codexRateLimitCache;
}
function summarizeCodexRateLimit() { return summarizeCodexRateLimits().overall; }

app.get('/api/usage', (req, res) => {
  ingestPassiveUsage(); // pick up whatever active sessions' statuslines just wrote
  const codexRl = summarizeCodexRateLimits();
  const codexAccounts = {};
  const acctList = Object.keys(codexRl.byAccount || {}).length ? (accounts.list().accounts || []) : [];
  for (const [key, snap] of Object.entries(codexRl.byAccount || {})) {
    const meta = key === '__global_codex__' ? null : acctList.find((a) => a.id === key);
    codexAccounts[key] = { ...snap, name: meta?.name || null, email: meta?.email || null };
  }
  res.json({
    rateLimit: _rateLimitCache, codexRateLimit: codexRl.overall,
    subscriptionSignedOut: _oauthSignedOut, subscriptionSignedOutCause: _oauthSignedOutCause, accounts: _accountUsage,
    // Dead-reckoned CURRENT utilization per account key (B-fcff v2): anchor +
    // learned-rate × ledger-cost-since. Purely local computation (30s memo);
    // keys match `accounts` + '__global__'. The popup renders these as a dim
    // "est now" line so stale readings stop masquerading as current.
    estimates: (() => {
      try {
        const e = app.locals.usageEstimator;
        if (!e) return {};
        const out = {}; const now = Date.now();
        for (const [id, snap] of Object.entries(_accountUsage)) {
          const est = e.estimateFor(id, snap, now);
          if (est) out[id] = est;
        }
        const g = e.estimateFor(null, _rateLimitCache, now);
        if (g) out.__global__ = g;
        // codex identities estimate too (P1): same estimator, codex-prefixed
        // identities learned prior-less; keys match `codexAccounts`
        for (const [key, snap] of Object.entries(codexRl.byAccount || {})) {
          try { const est = e.estimateFor(key, snap, now); if (est) out[key] = est; } catch {}
        }
        return out;
      } catch { return {}; }
    })(),
    // CREDENTIAL STATE per named claude account (2026-09-07, panel honesty):
    // live / expired / wiped / missing / oat, with `since` = the instant the
    // account stopped being able to produce a reading (src/login-state.js —
    // the SAME module the pool's slot validation and the repair migration
    // read). The panel shows a signed-out member's LAST REAL reading with
    // "stale since", instead of presenting five-day-old foreign numbers as
    // current.
    // ACCOUNT-level, not file-level (r2): a wiped dir + a valid long-lived
    // token is a working account (`oatOnly` spawns, its readings are its own),
    // so the panel must not tell the user it is signed out and must not flag
    // its own fresh readings as somebody else's. `accountLoginState` answers
    // for both channels; `oatMintedAt` rides list() already.
    logins: (() => {
      try {
        const out = {};
        for (const a of (accounts.list().accounts || [])) {
          if ((a.backend || 'claude') !== 'claude' || a.type !== 'subscription') continue;
          const st = accountLoginState(accounts.subCredsPath(a.id), { backend: 'claude', oatMintedAt: a.oat ? (a.oatMintedAt || null) : null });
          out[a.id] = { state: st.state, usable: st.usable, since: st.since || null };
        }
        return out;
      } catch { return {}; }
    })(),
    // Identity of each CLI's machine login (+ the named account it IS, when an
    // email matches) — the usage switchers render one entry, not two.
    globalLogin: _usageGlobalLink,
    codexGlobalLogin: _codexUsageGlobalLink,
    // Per-account codex quota snapshots (key = cxs id / '__global_codex__')
    codexAccounts,
    // Remote hosts' own-login quota snapshots (on-demand ⟳ only), keyed by
    // host id — every CONFIGURED host is listed (no-data hosts included, so
    // the popup offers the first ⟳)
    hosts: (() => {
      try {
        const out = {};
        for (const h of hosts?.list() || []) out[h.id] = { ...(_hostUsage[h.id] || {}), name: h.name };
        return out;
      } catch { return _hostUsage; }
    })(),
    // Host-HELD account quota snapshots (2.245.0, on-demand ⟳ only), keyed
    // '<hostId>:<accountId>' — the Agents machine sections' per-row usage
    hostAccounts: _hostAcctUsage,
  });
});


  return { refreshViaCliPanel, getOAuthToken, usagePollingEnabled, refreshRateLimit, reloadRateLimitCache, ingestPassiveUsage, summarizeCodexRateLimit, summarizeCodexRateLimits };
}

module.exports = { setupUsage, parseCliUsageText, normalizeCodexRateLimit };
