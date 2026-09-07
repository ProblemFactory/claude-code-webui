'use strict';
// USAGE + POOL ENGINE (decomposition #5 — the largest single extraction).
// Everything that DECIDES about quota and pooled billing on this instance:
// the model-fallback belt, pool auto-switch (pool-level + plan-C per-session),
// get_usage probe plumbing, the anchors sweep, offline-bias defenses, sealed
// orders push, rate-limit capture wiring, usage identity groups and the
// estimator instance. Extracted VERBATIM; late-created deps (accounts, hosts,
// usageHistory, recordUsageAttribution) arrive as lazy getters/lambdas —
// every use is at RUNTIME, after boot completes. ORCH tier.
const os = require('os');
const fs = require('fs');
const path = require('path');

const { mk } = require('./lazy.js');

function create({ app, rootDir, USAGE_CACHE_DIR, activeSessions, wss, WS_OPEN, getAutoResume = () => null, getOtelIngest = () => null, getQuotaProbe = () => null,
  broadcastToSession, serverNotice, serverSetting, getAccounts, getHosts,
  getUsageHistory, recordUsageAttribution, adapterRegistry}) {
  // late-bound singletons: created after this module in boot order, used only
  // at runtime — the Proxy re-resolves per property access, never caches
  const accounts = mk(getAccounts);
  const hosts = mk(getHosts);
  const usageHistory = mk(getUsageHistory);
// ── Stop-on-model-fallback belt (2.228.0, claude.disableModelFallback) ──
// The PRIMARY mechanism is the CLI's native switchModelsOnFlag=false
// (spawn --settings + mid-session apply_flag_settings) — with it armed no
// fallback ever happens and this never fires. The belt covers sessions whose
// CLI predates the toggle (spawned before it was enabled, or restored from
// before a server restart): the moment a fallback signal appears on the
// stream, interrupt the turn (same recipe as the ws 'interrupt' case) and
// tell the user why. Once per turn (_fallbackStopFired, cleared on result).
// ── Pooled pseudo-account auto-switch (B-6217 v2) ───────────────────────────
// Runs at each claude turn end for sessions billed to a pool with auto=on.
// Decisions read ONLY the passive usage cache (§ban-safety — never an API
// call); see src/account-pool-auto.js for the semantics. hot=on → just
// re-point (the running CLI re-reads the credential file on its next request);
// hot=off → also ask ONE connected client to cold-restart the affected
// conversations (headless instances degrade to hot behavior until a client
// appears — the switch itself never waits on a browser).
const { decidePoolSwitch, rankPoolMembers, SWITCH_THRESHOLD_PCT: POOL_HARD_PCT } = require('../account-pool-auto.js');
const { captureRateLimitEvent } = require('../rate-limit-capture.js'); // was a FREE IDENTIFIER since extraction #5 — passive rate_limit_event capture silently dead for 3 days (5th lost binding; the try/catch swallowed the ReferenceError into a log line). The PARSE now reaches the engine through the claude harness's quota.signalFromStream (S4) — one classifier per harness.
// ── THE harness registry (S4, docs/design-harness-plugins.md §2.4): each
// harness declares its QuotaSignalSource = normalize / signalFromStream /
// probe rung / classifyAuthFailure. The engine asks the registry, never a
// backend id (the codex-shaped ternaries this replaced spawned `claude -p
// /usage` for codex identities and classified auth failures in Anthropic
// wording only).
const harnesses = require('../harnesses');
const _poolAutoLast = new Map(); // poolId → ts of last DECISION (eval gate)
const _poolSwitchAt = new Map(); // poolId → ts of last actual SWITCH (dwell belt)
// ── member auth-health (2.335.0, owner report: a banned/expired/out-of-credit
// account never triggered a switch — quota was the engine's ONLY signal, and a
// dead-auth account often still SHOWS rich quota). memberId → {at, reason}.
// Self-healing exit: TTL 10min, and a creds file NEWER than the mark (=
// somebody re-logged-in) clears immediately.
const _memberAuthFail = new Map();
const _authNoteAt = new Map(); // member:sid → last evict attempt (throttle)
const _authNoticeAt = new Map(); // memberId → last user notice (anti-spam)
const AUTH_FAIL_TTL_MS = 10 * 60e3;
// ── WALL = GROUND TRUTH (B-2c9b, owner-approved plan A+B 2026-09-05) ─────────
// Three production occurrences in one day: a walled turn's verdict read the
// POOL scope ("usable via <linked member>" off the linked member's healthy
// cache) while the banner had landed on the org the CLI was ACTUALLY on (193
// readings re-attributed away from the link); the pool moved 1.5-3 min later
// when a reading arrived, and in-flight subagents died in the gap. Now: a
// wall is ground truth for the account it lands on (readings only confirm).
// (The second half of that sentence — "the engine evaluates a session on the
// member it is OBSERVED to bill" — was REFUTED on 2026-09-07; see the block
// directly below, which is what governs every blocking decision now.)
// ── ATTRIBUTION BY LINK, OBSERVATION AS CORROBORATION (2026-09-07, owner
// decision ut-1c6c15a2db ①/④ after the 130-fire loop) ───────────────────────
// B-2c9b made the OTel-observed org OVERRIDE the link for blocking decisions.
// The owner's post-mortem corrected the premise: an `api_request` record's
// organization.id comes from the identity the CLI cached in its config dir at
// SPAWN, not from the token that authorized the request — so after a hot
// re-point the process reads the NEW credential file (that is what the
// mtime-bump exists for) while its telemetry keeps naming the OLD org.
// Consequence, reproduced in scripts/test-auto-resume-loop.mjs: every
// rejection landed on the observed org, the LINKED member's cache stayed
// "healthy" forever, the verdict kept answering "usable via <link>", the
// per-session pass "switched" to the member it was already on, and fireNow()
// continued a session that was rejected again half a second later — 130 times.
// So: a REJECTION is a fact about the credential SLOT the CLI reads (the
// link, validated), the observation is corroboration in the journal and in
// telemetry. Quota VALUES (utilization readings) keep the B-b3cd
// observed-org routing — a value describes whatever token produced it; only
// the identity of a WALL moved.
const OBSERVED_ORG_RECENT_MS = 10 * 60e3; // how fresh an OTel observation must be to speak at all
const WALL_RING_MS = 120e3;              // the ≥2-walls corroboration window for a wall we cannot tie to a slot
const WALL_RING_MAX = 16;
const SESSION_WALL_MS = 10 * 60e3;       // "this member rejected THIS session" — dead for its verdicts + switch targets
const _wallRing = new Map();             // account key → [{at, sid}] walled-turn timestamps (one entry per turn per key)
const _divergenceLogAt = new Map();      // webuiId → last "observed on X while linked to Y" log (10min floor)
const _sessionWalls = new Map();         // webuiId → Map(memberId → ts): the members that walled THIS session
const _noTargetLogAt = new Map();        // webuiId → last "nowhere to go" per-session log (10min floor)
// ── get_usage control channel + chat-mode limit banner (B-7edc/B-292b) ──────
// The get_usage control request makes the CLI (first-party client) fetch usage
// itself — strictly better ToS posture than our bare /api/oauth/usage call.
// HUMAN-TRIGGERED ONLY (the ⟳ button): auto-firing was REJECTED (2026-08-09,
// user decision) — a machine-initiated quota check is the automated-access
// pattern that got a real account banned. The passive chat-mode signal is the
// LIMIT BANNER instead (markLimitBanner below): zero calls.
const { ClaudeCodeAdapter } = require('../adapters/claude-code.js');
// ── usage ANCHOR recorder (dead-reckoning data foundation, 2.261.0) ─────────
// Sweeps local usage-cache snapshots for NEW ground-truth readings (any
// source: statusline / ⟳ / get_usage / limit banner) and appends them, with
// the ledger cost consumed since the previous anchor, to
// data/usage-anchors/anchors-<identity>.ndjson. Identity key = orgUuid >
// email > account id, so a sub's history SURVIVES remove + re-add (user
// requirement — a re-add mints a fresh sub-<hex> id). Zero API calls.
const { UsageAnchors, identityKeyFor, costBetweenMulti } = require('../usage-anchors.js');
const { capsOf } = require('../backend-caps.js'); // per-backend switching capabilities (P4 slice) — replaces backend-id special cases
// Which QuotaSignalSource speaks for a backend. A FALSY backend is the
// legacy-record case (accounts._acctBackend / boot-restore's `m.backend ||
// 'claude'` — records written before the field existed ARE claude; same rule
// as capsOf); an UNKNOWN id is a loud failure that degrades to the NULL
// source (no reading, no signal, no probe — never parsed as claude, the
// gemini-as-claude class the harness design bans).
const _unknownHarnessWarned = new Set();
function quotaSourceFor(backend) {
  const id = backend || 'claude';
  try { return harnesses.get(id).quota; } catch (e) {
    if (!_unknownHarnessWarned.has(id)) { _unknownHarnessWarned.add(id); console.warn('[quota] ' + e.message); global.__vsEvent?.('quota-harness-unknown', id); }
    return harnesses.NULL_QUOTA;
  }
}
// The backend a usage-cache KEY belongs to: named accounts carry it;
// '__global_codex__' is the codex CLI login; the asking session's own backend
// decides for identity-less keys ('__global__', host-*); else claude.
function quotaBackendFor(key, session) {
  if (key === '__global_codex__') return 'codex';
  try { const a = key && accounts.get(key); if (a) return a.backend || 'claude'; } catch { }
  if (session?.backend) return session.backend;
  return 'claude';
}
const { quotaVerdict } = require('../account-pool-auto.js'); // THE account-usability verdict (2.369.0, owner-designed)
const { UsageEstimator, overlayCache: estOverlayCache, predictCalib, CLAUDE_MAX_PRIOR_FULL_USD } = require('../usage-estimator.js');
const usageAnchors = new UsageAnchors({ dataDir: path.join(rootDir, 'data') });
// Which caches map to which identity (org-merge aware) — shared by the sweep
// and the estimator's per-account resolution. Reads roster + cache files only.
function usageIdentityGroups() {
  const groups = new Map(); // identityKey → {accountIds:[], cache, accountId}
  let files = [];
  try { files = fs.readdirSync(USAGE_CACHE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('__models__') && !f.startsWith('host-') && f !== 'rates.json'); } catch { return groups; }
  const roster = accounts.list().accounts || [];
  for (const fn of files) {
    try {
      // '__global_codex__' is a PSEUDO id like '__global__' (the machine's
      // ChatGPT login) — roster-less by design, never a "deleted account".
      const accountId = (fn === '__global__.json' || fn === '__global_codex__.json') ? null : fn.slice(0, -5);
      const isCodexGlobal = fn === '__global_codex__.json';
      const cache = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, fn), 'utf-8'));
      if (!cache?.fetchedAt) continue;
      const acctRec = accountId ? roster.find((x) => x.id === accountId) : null;
      // A DELETED account's cache file is a zombie (nothing removes the file
      // with the record) and it kept poisoning org→account resolution: it
      // stays in the identity group, OTel's resolveOrg picked the dead id
      // (first named member) and booked LIVE spend to an account that no
      // longer exists (atype 'unknown', outside every quota view) — the
      // 2026-08-24 estimator investigation traced the org-29c4 implied-full
      // crash to exactly this (sub-a453 deleted, cache file from 07-16 still
      // resolving). A file with no roster record contributes NOTHING true.
      if (accountId && !acctRec) continue;
      if (accountId && acctRec && acctRec.type === 'pooled') continue; // pools have no quota of their own
      // codex identities join the groups since P1 (design-backend-parity.md §1)
      // — persisted cxs-*/__global_codex__ snapshots feed the SAME anchors →
      // estimator stack (their ledger cost is already backend-tagged). Every
      // codex key carries a 'codex:' prefix: identityKeyFor falls back to
      // EMAIL, and one person's ChatGPT + Anthropic logins sharing an email
      // must never merge into one identity (different quotas entirely).
      const isCodex = isCodexGlobal || acctRec?.backend === 'codex';
      const key = isCodexGlobal ? 'codex:__global__'
        : (isCodex ? 'codex:' : '') + identityKeyFor({ accountId, cache, email: acctRec?.email });
      const g = groups.get(key) || { accountIds: [], cache: null, accountId: null, backend: isCodex ? 'codex' : 'claude' };
      g.accountIds.push(isCodexGlobal ? '__global_codex__' : (accountId || '__global__'));
      // freshest cache is the identity's anchor source (the same real login can
      // surface as BOTH __global__ and a named sub — one quota, two files)
      if (!g.cache || cache.fetchedAt > g.cache.fetchedAt) { g.cache = cache; g.accountId = accountId; }
      groups.set(key, g);
    } catch { }
  }
  return groups;
}
// Dead-reckoning estimator (B-fcff v2): learned per-identity per-bucket rates
// over the anchor pairs, seeded with the measured Max-20x priors. Feeds the
// pool auto-switch an ESTIMATED bucket view and /api/usage an `estimates`
// field. Zero API calls; ledger + anchor files only.
const _identGroupsMemo = { at: 0, groups: null };
function usageIdentityGroupsCached() {
  if (!_identGroupsMemo.groups || Date.now() - _identGroupsMemo.at > 30000) {
    _identGroupsMemo.groups = usageIdentityGroups(); _identGroupsMemo.at = Date.now();
  }
  return _identGroupsMemo.groups;
}
const usageEstimator = new UsageEstimator({
  anchorsDir: path.join(rootDir, 'data', 'usage-anchors'),
  usageHistory: () => usageHistory, // declared far below — lazy ref (TDZ)
  resolveIdentity: (accountId) => {
    const want = accountId || '__global__';
    for (const [identityKey, g] of usageIdentityGroupsCached()) {
      if (g.accountIds.includes(want)) return { identityKey };
    }
    return null;
  },
  // codex identities learn WITHOUT priors (the built-in default is the
  // measured claude Max-20x quota sizes — meaningless for ChatGPT plans);
  // the no-prior fallback needs ≥$1 cost + ≥0.5% observed movement before
  // it emits a rate, which is the honest cold-start for an unmeasured plan.
  priorsFor: (identityKey) => String(identityKey || '').startsWith('codex:') ? null : CLAUDE_MAX_PRIOR_FULL_USD,
});
app.locals.usageEstimator = usageEstimator;
// ── OFFLINE-BIAS defense (2.297.0, design §Cross-device aggregation) ──
// A source is ACTIVE-DARK when the ledger holds RECENT events from it but its
// link is down: its spend keeps accruing invisibly, which biases estimates in
// the DANGEROUS direction (under → late pool switches). 30s memo — this runs
// inside pool decisions and the anchor sweep.
let _darkMemo = { at: 0, list: [] };
function darkSources() {
  if (Date.now() - _darkMemo.at < 30000) return _darkMemo.list;
  const list = [];
  try {
    const wm = usageHistory.sourceWatermarks();
    const now = Date.now();
    for (const [src, ts] of Object.entries(wm)) {
      if (src === 'local') continue;
      if (now - ts > 48 * 3600 * 1000) continue; // idle for 2 days — not dangerous
      if (hosts.linkState(src) === 'offline') list.push({ host: src, lastEventTs: ts });
    }
  } catch { }
  _darkMemo = { at: Date.now(), list };
  return list;
}
// Which accounts a dark source taints: those with ledger events from that
// host in the last 7 days (per-account precision so an all-local pool never
// pays the pessimism tax for an unrelated machine's outage).
function darkTaintedAccounts() {
  const dark = darkSources();
  if (!dark.length) return {};
  const taint = {};
  try {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const darkSet = new Set(dark.map((d) => d.host));
    for (const ev of usageHistory._events(since, Date.now())) {
      if (ev.host && darkSet.has(ev.host) && ev.acct && ev.atype !== 'host') taint[ev.acct] = DARK_PESSIMISM_PCT;
    }
  } catch { }
  return taint;
}
const DARK_PESSIMISM_PCT = 8; // dock: ~1 long turn of 5h headroom / real weekly $

// Disarm a pool's device-side reflex (pool deleted / auto turned off) —
// without this the daemon kept executing a stale snapshot forever, and could
// even recreate a deleted pool's symlink during a server-down window.
async function clearSealedOrders(poolId) {
  try {
    _sealedOrdersSent.delete(poolId);
    const dm = await hosts.device(null);
    await dm.poolOrders({ clearPool: poolId });
  } catch { }
}
const _sealedOrdersSent = new Map(); // poolId → last pushed JSON (skip no-ops)
let _poolOrdersWarned = false; // warn once per boot, never per tick
async function pushSealedOrders(poolId) {
  const a = accounts.get(poolId);
  if (!a || a.type !== 'pooled') return;
  const members = accounts.poolMembers(poolId);
  const ranked = rankPoolMembers({
    members,
    readCache: (id) => { try { return JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, id + '.json'), 'utf-8')); } catch { return null; } },
    nowSec: Date.now() / 1000,
  }).map((m) => ({ id: m.id, dir: accounts.subDir(m.id), creds: accounts.subCredsPath(m.id) }));
  const orders = { poolId, linkPath: accounts.subDir(poolId), ranked, currentId: accounts.poolCurrent(poolId) || null,
    // Plan C: per-session links are additional MATCH+ACT targets — the daemon
    // re-points exactly the link the banner session spawned against. Old
    // daemons ignore this field and keep matching only the default link:
    // reduced coverage on skew, never a wrong re-point.
    linkPaths: (() => { try { return accounts.sessionPoolLinks(poolId).map((l) => l.path); } catch { return []; } })() };
  const j = JSON.stringify(orders);
  if (_sealedOrdersSent.get(poolId) === j) return;
  const dm = await hosts.device(null); // device #0 — pools are local-only
  // (the memo below is per-pool AND the daemon now stores per-pool slots, so a
  // second pool's push can no longer evict the first — review finding)
  await dm.poolOrders(orders, (events) => {
    // fallback switches executed while this server was down: surface + let
    // the by-time ledger attribution reconcile billing (it already keys on
    // the symlink target's real account at scan time)
    for (const ev of events) {
      serverNotice('sealed-orders-' + ev.ts, `账号池 ${accounts.get(ev.poolId)?.name || ev.poolId} 在服务器离线期间因触限自动切换到 ${accounts.get(ev.to)?.name || ev.to}（sealed-orders 应急反射）`, { level: 'warn' });
      try { console.log('[sealed-orders] device-executed fallback switch:', JSON.stringify(ev)); } catch { }
    }
    try { dm.ackPoolOrdersLog(); } catch { }
  });
  _sealedOrdersSent.set(poolId, j);
}

function sweepUsageAnchors() {
  // GROUPED BY IDENTITY (2.263.0): recording per cache-file double-anchored
  // org-merged logins (__global__ + named sub interleaved in one identity
  // file, each record's costSince missing the sibling account's spend — real
  // data bug caught in the ProblemFactory analysis). One identity = one
  // anchor stream; cost sums across ALL its account ids.
  for (const [identityKey, g] of usageIdentityGroups()) {
    try {
      const prev = usageAnchors.lastAnchor(identityKey);
      const allIds = usageEstimator.accountIdsFor(identityKey, g.accountIds);
      const costSince = prev ? costBetweenMulti(usageHistory, allIds, prev.fetchedAt, g.cache.fetchedAt) : null;
      // calibration: what the CURRENT rates would have predicted for this new
      // reading — recorded into the anchor for offline analysis + Diagnostics
      let calib = null;
      // Same-source only (B-b3cd metric hygiene): a cross-source pair carries
      // the unknown inter-source offset, not prediction error — the exact rule
      // extractPairs already enforces for LEARNING (2.340.0); without it here
      // the calib stream's worst rows were all source flips, drowning the real
      // error signal (48↔95 "errors" that were attribution, not estimation).
      if (prev && costSince && (prev.source || 'unknown') === (g.cache.source || 'unknown')) {
        try {
          const newBuckets = {
            fiveHour: g.cache.fiveHour ? { u: g.cache.fiveHour.utilization, resetsAt: g.cache.fiveHour.resetsAt } : null,
            sevenDay: g.cache.sevenDay ? { u: g.cache.sevenDay.utilization, resetsAt: g.cache.sevenDay.resetsAt } : null,
            scopedWeekly: (g.cache.scopedWeekly || []).map((s) => ({ name: s.name, u: s.utilization, resetsAt: s.resetsAt })),
          };
          calib = predictCalib(prev, newBuckets, usageEstimator.ratesFor(identityKey), costSince, (g.cache.fetchedAt - prev.fetchedAt) / 1000);
          // Metric is DELTA-RELATIVE (owner-corrected, 2.368.13): absolute
          // error rewards refresh cadence, not model quality — emit only for
          // windows that actually moved, as |predΔ−actΔ|/|actΔ|.
          if (calib) for (const c of Object.values(calib)) {
            if (c.rel != null) global.__vsMetric?.('usage-est-rel-err-pct', Math.abs(c.predDu - c.actDu) / Math.abs(c.actDu) * 100);
          }
        } catch { }
      }
      // pairs recorded while ANY tainted source was dark must not teach rates
      // (Δu real, cost missing ⇒ a falsely HOT rate) — mark the record so
      // extractPairs voids pairs touching it (both sides of the gap).
      const darkHosts = (() => { try { const t = darkTaintedAccounts(); return allIds.some((a) => t[a]) ? darkSources().map((d) => d.host) : []; } catch { return []; } })();
      if (usageAnchors.maybeRecord({ identityKey, accountId: g.accountId, cache: g.cache, costSince, calib, accountIds: allIds, dark: darkHosts })) {
        usageEstimator.invalidate(identityKey); // rates re-derive from the grown pair set
      }
    } catch { }
  }
}
// boot-time sealed-orders push: a restarted server re-arms every pool's
// device-side fallback snapshot AND collects executions from its own down
// window (the report rides the pool-orders reply)
setTimeout(() => {
  // Only AUTO pools (review finding): the runtime refresh is gated on a.auto,
  // so arming a manual pool at boot let the device switch a pool the user
  // explicitly set to manual — with a snapshot frozen at boot forever.
  try {
    for (const a of (accounts.list().accounts || [])) {
      const full = accounts.get(a.id);
      if (full?.type === 'pooled' && full.auto) pushSealedOrders(a.id).catch(() => { });
    }
  } catch { }
}, 15000);
setInterval(() => { try { sweepUsageAnchors(); } catch {} }, 60000);
setTimeout(() => { try { sweepUsageAnchors(); } catch {} }, 20000);

// ── Plan C (B-a612, 2.315.0): per-session pool placement ────────────────────
// One pool, many links: each session bills the member its OWN symlink points
// at. The chooser and the per-session switch pass both read quota through the
// SAME estimator-overlaid readCache the pool engine uses, PROJECTED to the
// session's model family (src/model-family.js): scoped caps of models this
// session is not running stop vetoing its placement; 5h/7d always count
// (nested buckets); an unknown family means NO projection — today's
// conservative semantics, never a relaxation on ignorance.
const { familyOfModel, projectCacheForFamily } = require('../model-family.js');
function poolReadCache(poolId) {
  // the engine's readCache, extracted for reuse (identity-group freshest file
  // + estimator overlay); kept here so chooser/switch/engine cannot drift
  const now = Date.now();
  return (id) => {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, id + '.json'), 'utf-8')); } catch { }
    try {
      for (const [, g] of usageIdentityGroupsCached()) {
        if (g.accountIds.includes(id) && g.cache && (g.cache.fetchedAt || 0) > (raw?.fetchedAt || 0)) { raw = g.cache; break; }
      }
    } catch { }
    try { return estOverlayCache(raw, usageEstimator.estimateFor(id, raw, now)); } catch { return raw; }
  };
}
function poolChooserForModel(poolId, { model } = {}) {
  try {
    const a = accounts.get(poolId);
    if (!a || a.type !== 'pooled') return null;
    const fam = familyOfModel(model);
    const cur = accounts.poolCurrent(poolId);
    if (!fam) return cur; // no identity → the pool's default target
    const base = poolReadCache(poolId);
    const readCache = (id) => projectCacheForFamily(base(id), fam);
    // decidePoolSwitch FROM the default target under the projected view: if
    // the default serves this family, stay (fewest distinct billing dirs);
    // if it doesn't, the switch verdict IS the placement.
    const { decidePoolSwitch } = require('../account-pool-auto.js');
    const d = decidePoolSwitch({ currentId: cur, members: healthyPoolMembers(poolId), readCache, nowSec: Date.now() / 1000, hot: true });
    return (d && d.to) || cur;
  } catch (e) { console.warn('[pool] chooser failed (falling back to default target):', e.message); return null; }
}
// The session's model identity, per the user's spec: the LAST assistant
// message's served model vs the last set-model pick — newest wins — else the
// spawn model. Any unknown → null (no projection).
function sessionModelFor(s) {
  const served = s._servedModel ? { m: s._servedModel, at: s._servedModelAt || 0 } : null;
  const picked = s._pickedModel ? { m: s._pickedModel, at: s._pickedModelAt || 0 } : null;
  const newest = served && picked ? (picked.at >= served.at ? picked : served) : (picked || served);
  return (newest && newest.m) || s._spawnModel || null;
}

const _vsuPending = new Map(); // request_id → {resolve, timer}
function resolveUsageKey(session) {
  let acct = session._accountId || null;
  try {
    if (acct && accounts.get(acct)?.type === 'pooled') {
      // VALUES follow the observation (B-b3cd): a utilization number
      // describes whatever token produced it, so the live odometer, probe
      // matching and every cache key derived here take the observed member.
      // No observation ⇒ the link. BLOCKING decisions deliberately do NOT
      // come through here — they read sessionBillingMember (2026-09-07).
      acct = sessionReadingMember(session, acct).id || acct;
    }
  } catch {}
  return acct || '__global__';
}
function writeUsageCacheForKey(key, parsed) {
  try {
    const f = path.join(USAGE_CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
    let prev = {}; try { prev = JSON.parse(fs.readFileSync(f, 'utf-8')) || {}; } catch {}
    const merged = { ...prev, ...parsed };
    // preserve-merge like the statusline hook: never clobber known scoped/org
    // data with an empty answer
    if ((!parsed.scopedWeekly || !parsed.scopedWeekly.length) && Array.isArray(prev.scopedWeekly) && prev.scopedWeekly.length) {
      merged.scopedWeekly = prev.scopedWeekly; merged.scopedFetchedAt = prev.scopedFetchedAt;
    }
    for (const k of ['orgUuid', 'orgName', 'orgEmail', 'email', 'name']) if (prev[k] !== undefined && merged[k] === undefined) merged[k] = prev[k];
    fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(merged)); fs.renameSync(f + '.tmp', f);
    return true;
  } catch { return false; }
}
// Ask a LIVE LOCAL claude chat session's CLI for usage over its control
// channel. Returns parsed cache shape or null. Caller is the human-gated ⟳.
function probeUsageViaSession(session, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      if (!session?.pty || session.backend !== 'claude' || session.mode !== 'chat' || session.host) return resolve(null);
      const req = ClaudeCodeAdapter.buildGetUsage();
      const timer = setTimeout(() => { _vsuPending.delete(req.request_id); resolve(null); }, timeoutMs);
      _vsuPending.set(req.request_id, { resolve, timer });
      session.pty.write(JSON.stringify(req) + '\n');
    } catch { resolve(null); }
  });
}
// Every account key in `key`'s IDENTITY group (org-merged logins span
// '__global__' + named subs — one real account, several keys). Falls back to
// just [key] when the identity is unknown.
function usageIdentityAccountIds(key) {
  try {
    for (const [, g] of usageIdentityGroupsCached()) {
      if (g.accountIds.includes(key)) return g.accountIds;
    }
  } catch { }
  return [key];
}
// ⟳-route hook: find any live local claude chat session billed to `key` — or
// to ANY key in its identity group (2.266.1, real report: ⟳ on the pool's
// ACTIVE target said "no valid token" while the asking session itself was
// billing that very account — the popup had remapped the linked account to
// '__global__', which no session matches when pool sessions bill the DIR key;
// the shared quota makes any same-identity session's answer authoritative).
function probeUsageForAccountKey(key) {
  const ids = new Set(usageIdentityAccountIds(key));
  for (const [, s] of activeSessions) {
    if (s.backend !== 'claude' || s.mode !== 'chat' || s.host || !s.pty) continue;
    if (!ids.has(resolveUsageKey(s))) continue;
    return probeUsageViaSession(s).then((parsed) => {
      if (parsed) writeUsageCacheForKey(key, parsed);
      return parsed;
    });
  }
  return Promise.resolve(null);
}
app.locals.usageIdentityAccountIds = usageIdentityAccountIds;
// Chat-mode PASSIVE exhaustion signal (zero API calls): the CLI's own
// "You've reached your … limit" banner marks the bucket dead in the cache and
// immediately re-evaluates the pool — this is what makes auto-switch work for
// chat-only accounts (the statusline never runs there).
// Which usage-cache identity does a session's quota belong to? Account-billed
// sessions (local, host-held, linked, pool→target) → the account key (quota
// is a per-account GLOBAL fact — readings merge across machines by identity,
// three-tier design). A REMOTE session on the host's own CLI login has no
// account id → the host bucket (usage-cache/host-<id>.json, the popup's
// machine rows) — resolveUsageKey alone mapped those to '__global__' and
// misattributed the HOST's quota to the LOCAL machine login.
function usageCacheKeyFor(session) {
  if (session?.host && !session._accountId) return 'host-' + session.host;
  return resolveUsageKey(session);
}
// Passive quota capture from the CLI's own rate_limit_event records (B-e5c9,
// 2.289.0) — ONE shared implementation (src/rate-limit-capture.js) for local
// AND remote chat sessions; the caller resolves key/identity as parameters.
// ORG VERIFICATION (B-b3cd, the odometer-flap fix): a hot-switched pool
// session keeps its old token for ≥25min, so its quota signals (rate_limit_
// event readings, limit banners) describe the OLD org's buckets — written
// under the newly-linked account they flapped a half-empty account's 7d
// odometer 48↔95 (34% of this source's anchors jumped >10pt vs a <1h-old
// panel reading; magnitude alone can't gate this — parallel workflows really
// can move >10pt/h, owner-confirmed). The OTel truth stream names the org
// each session's requests actually bill: when it names a DIFFERENT identity
// than the link, the reading/mark belongs to the observed org's account —
// re-attribute the cache key. No observation (OTel absent/remote) or an
// observed-but-unmapped org ⇒ attribute by link, exactly the old behavior.
function orgVerifiedKey(session, key, what) {
  try {
    const obs = getOtelIngest()?.observedOrgFor?.(session.claudeSessionId);
    if (obs && obs.acct && Date.now() - (obs.ts || 0) < 30 * 60e3) {
      const members = usageIdentityAccountIds(key) || [];
      if (!members.includes(obs.acct)) {
        global.__vsEvent?.('usage-reading-reattributed', `${what}:${key}→${obs.acct}`);
        return obs.acct;
      }
    }
  } catch { }
  return key;
}
const nameOf = (id) => { try { return (id && accounts.get(id)?.name) || id || '?'; } catch { return id || '?'; } };
/** The pool member the OTel truth stream last SAW this session's requests on
 *  — i.e. the identity the CLI cached at spawn, not necessarily the one whose
 *  credentials it is reading now (2026-09-07). Routes VALUES, corroborates a
 *  wall; never decides a blocking question on its own:
 *  the OTel truth stream's latest org for the session (≤ OBSERVED_ORG_RECENT_MS
 *  old) resolved to a member of `poolId` — else null. A pure read: no
 *  telemetry, no re-attribution side effects (orgVerifiedKey owns those for
 *  readings; this answers "which member is this session on right now"). */
function observedMemberFor(session, poolId) {
  try {
    if (!session || !poolId) return null;
    const obs = getOtelIngest()?.observedOrgFor?.(session.claudeSessionId);
    if (!obs || !obs.acct || Date.now() - (obs.ts || 0) > OBSERVED_ORG_RECENT_MS) return null;
    const members = accounts.poolMembers(poolId) || [];
    const hit = members.find((m) => m.id === obs.acct)
      || members.find((m) => { try { return usageIdentityAccountIds(m.id).includes(obs.acct); } catch { return false; } });
    return hit ? hit.id : null;
  } catch { return null; }
}
function noteDivergence(session, observedId, linkedId) {
  if (!observedId || observedId === linkedId) return false;
  const sid = session?._webuiId || session?.claudeSessionId || '?';
  const now = Date.now();
  if (now - (_divergenceLogAt.get(sid) || 0) > 10 * 60e3) {
    _divergenceLogAt.set(sid, now);
    console.log(`[pool] session ${sid} observed on ${nameOf(observedId)} while linked to ${nameOf(linkedId)}`);
    global.__vsEvent?.('pool-observed-divergence', `${observedId}≠${linkedId}`);
  }
  return true;
}
/** Where a pooled session's quota READINGS belong: the observed member when
 *  the OTel truth names one, else its link. VALUES only (resolveUsageKey →
 *  the live odometer, probe-session matching, derived cache keys) — B-b3cd's
 *  odometer-flap defence. It deliberately does NOT decide anything about
 *  BLOCKING any more; that is sessionBillingMember. */
function sessionReadingMember(session, poolId) {
  let linkedId = null;
  try { linkedId = accounts.poolCurrentFor(poolId, session?._webuiId || null) || null; } catch { }
  const observedId = observedMemberFor(session, poolId);
  const divergent = noteDivergence(session, observedId, linkedId);
  return { id: observedId || linkedId, linkedId, observedId, divergent };
}
/** TOKEN-SLOT VALIDATION: is the credential slot this session's CLI reads
 *  really `linkedId`'s? The slot is the per-session symlink (or the pool's
 *  default link for a session that has none) — `poolCurrentFor` resolves the
 *  symlink itself, so a non-null answer already means "the link points at a
 *  known account". These legs add the two things that make it AUTHORITY for a
 *  wall: the target is a member of THIS pool, and it holds credentials. When
 *  a leg fails we say WHICH — an unvalidated slot degrades to the old
 *  ≥2-walls corroboration instead of silently demoting the wrong account. */
function validateBillingSlot(poolId, linkedId) {
  if (!linkedId) return { ok: false, reason: 'no-slot' };            // no link, or it resolves to no known account (poolCurrentFor readlinks it)
  try {
    // poolMembers() is the ONE authority here and it already filters by
    // loggedIn — a separate credentials leg would be an unsatisfiable guard
    // (it can only disagree with itself), i.e. deleted functionality wearing
    // a check's clothes.
    if (!(accounts.poolMembers(poolId) || []).some((m) => m.id === linkedId)) return { ok: false, reason: 'slot-not-a-member' };
  } catch { return { ok: false, reason: 'slot-unreadable' }; }
  return { ok: true, reason: null };
}
/** THE member a pooled session's requests are BILLED to: its link, validated
 *  against the credential slot. Every blocking decision uses this — the wall's
 *  demotion target, the verdict order, the per-session switch's `currentId`,
 *  both probe targets and the identity the loop breaker keys fires on.
 *  `observedId`/`divergent` ride along as corroboration for the journal. */
function sessionBillingMember(session, poolId) {
  let linkedId = null;
  try { linkedId = accounts.poolCurrentFor(poolId, session?._webuiId || null) || null; } catch { }
  const observedId = observedMemberFor(session, poolId);
  const divergent = noteDivergence(session, observedId, linkedId);
  const slot = validateBillingSlot(poolId, linkedId);
  return { id: linkedId, linkedId, observedId, divergent, slotOk: slot.ok, slotReason: slot.reason };
}
/** THE identity a REJECTION belongs to: the credential slot this session's
 *  CLI reads, and whether that slot VALIDATED. Pooled ⇒ the validated link
 *  member; otherwise the session's own account/host key (fixed at spawn, so
 *  trivially its own slot). Deliberately NOT orgVerifiedKey — see the header
 *  note. `slotOk` travels ON THE SIGNAL because it is only true AT THE MOMENT
 *  THE REJECTION ARRIVES: by the time the turn ends the pool has usually
 *  re-pointed the link off the account that just refused us. */
function wallSlotFor(session) {
  try {
    const poolId = session?._accountId || null;
    const a = poolId && accounts.get(poolId);
    if (a && a.type === 'pooled') {
      const b = sessionBillingMember(session, poolId);
      return { key: b.id || poolId, slotOk: !!b.slotOk && !!b.id, slotReason: b.slotReason };
    }
  } catch { }
  const key = usageCacheKeyFor(session);
  return { key, slotOk: !!key, slotReason: null }; // no pool = one fixed creds dir for the whole session
}
function wallKeyFor(session) { return wallSlotFor(session).key; }
/** The identity + label a CONTINUE fired into this session would land on —
 *  auto-resume's `fireIdentity` dep. Deliberately wallKeyFor: the breaker's
 *  "the fire onto X failed" and the wall machine's "X rejected this session"
 *  must name the same X, or the breaker quarantines an account nothing ever
 *  rejects. */
function fireIdentityFor(session) {
  try {
    const key = wallKeyFor(session);
    if (!key) return null;
    return { key, name: nameOf(key) };
  } catch { return null; }
}
/** "This member rejected THIS session at T" — written where a wall resolves to
 *  a member, read by the verdict (it cannot answer `usable` through such a
 *  member) and by the per-session switch (it cannot pick one). Session-scoped
 *  and self-expiring: a pool-wide fact would be the 2.368.34 misattribution
 *  class again. */
function noteSessionWall(sid, memberId, now = Date.now()) {
  if (!sid || !memberId) return;
  let m = _sessionWalls.get(sid);
  if (!m) { m = new Map(); _sessionWalls.set(sid, m); }
  m.set(memberId, now);
  for (const [k, t] of m) if (now - t > SESSION_WALL_MS) m.delete(k);
  if (_sessionWalls.size > 512) { const k = _sessionWalls.keys().next().value; _sessionWalls.delete(k); }
}
function sessionWalledMembers(sid, now = Date.now()) {
  const out = new Set();
  const m = sid && _sessionWalls.get(sid);
  if (m) for (const [k, t] of m) if (now - t < SESSION_WALL_MS) out.add(k);
  // the loop breaker's own memory (a continue we fired that came back
  // rejected) is the same fact seen from the other side — one union, so a
  // restart-surviving failure record still steers the next target choice
  try { for (const k of getAutoResume()?.recentFireFailures?.(sid) || []) out.add(k); } catch { }
  return out;
}

/** Walled turns seen on an account (any session) inside WALL_RING_MS, counted
 *  across its identity group. */
function wallCount(key, now = Date.now()) {
  let n = 0;
  const ids = new Set([key]);
  try { for (const id of usageIdentityAccountIds(key)) ids.add(id); } catch { }
  for (const id of ids) for (const e of _wallRing.get(id) || []) if (now - e.at < WALL_RING_MS) n++;
  return n;
}
// ── TURN-GRANULAR WALL MACHINE (2.369.0, owner-designed replacement for the
// .27-.34 patch pile) ─────────────────────────────────────────────────────
// Design (docs/design-wall-machine.md): wall SIGNALS (rejected events, the
// banner as a BOOLEAN — never a data source) accumulate on the current turn;
// the RESULT record classifies the turn (walled = signals with no real work
// after the last one; a turn the pool rescued mid-way classifies NORMAL); a
// normally-completed turn is sufficient proof the session is not blocked.
// Times come from ONE place: the account system's quotaVerdict (model-
// projected, estimator-overlaid, 5h<10%/weekly<5%). A missing blockedUntil
// is filled by PROBING the owner-approved /usage panel channel — never by
// parsing text, never by guessing.

// The account system's usability answer for a scope (pool id OR cache key),
// model-projected. Pool = any member usable / min over members' blockedUntil.
function quotaVerdictFor(scope, { model, session = null } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const fam = familyOfModel(model);
  const read = poolReadCache(null); // generic estimator-overlaid identity reader
  const proj = (c) => { try { return fam ? projectCacheForFamily(c, fam) : c; } catch { return c; } };
  const a = accounts.get(scope);
  if (a && a.type === 'pooled') {
    const members = accounts.poolMembers(scope) || [];
    // The member whose credentials the CLI reads is judged FIRST, so `via`
    // names the account the session is actually billing whenever that one is
    // usable; the verdict carries on/linked/observed/divergent/slotOk for the
    // journal + tests. (Was "observed over linked" under B-2c9b plan B until
    // 2026-09-07 — the observation names the SPAWN-time identity, so judging
    // it first is how the loop kept finding a "usable" member to re-fire at.)
    const cm = session ? sessionBillingMember(session, scope) : null;
    const ordered = cm?.id ? [...members.filter((m) => m.id === cm.id), ...members.filter((m) => m.id !== cm.id)] : members;
    // A member that answered THIS session's turn with a limit rejection is
    // dead-until-reset for this session's verdicts, whatever its cache says
    // (2026-09-07: the loop's every cycle re-read a "healthy" member that had
    // just rejected us). Its own blockedUntil still counts toward the wait.
    const walled = session ? sessionWalledMembers(session._webuiId) : new Set();
    const verdicts = ordered.map((m) => {
      const v = quotaVerdict(proj(read(m.id)), nowSec);
      if (walled.has(m.id) && v.usable !== false) {
        return { id: m.id, name: m.name || m.id, v: { ...v, usable: false, reason: `rejected this conversation (${v.reason})` } };
      }
      return { id: m.id, name: m.name || m.id, v };
    });
    const ctx = cm ? { on: cm.id, linked: cm.linkedId, observed: cm.observedId || null, divergent: cm.divergent, slotOk: cm.slotOk } : {};
    const note = cm?.divergent ? ` — session observed on ${nameOf(cm.observedId)} while linked to ${nameOf(cm.linkedId)}` : '';
    if (!verdicts.length) return { usable: null, known: false, blockedUntil: 0, reason: 'pool has no members', ...ctx };
    const ok = verdicts.find((x) => x.v.usable === true);
    if (ok) return { usable: true, known: true, blockedUntil: 0, via: ok.name, viaId: ok.id, reason: `${ok.name} usable (${ok.v.reason})${note}`, ...ctx };
    const untils = verdicts.map((x) => x.v.blockedUntil).filter(Boolean);
    return {
      usable: false, known: true,
      blockedUntil: untils.length ? Math.min(...untils) : 0, // soonest-usable member; 0 = some member unknowable → probe
      reason: verdicts.map((x) => `${x.name}: ${x.v.reason}`).join(' | ') + note,
      ...ctx,
    };
  }
  return quotaVerdict(proj(read(scope)), nowSec);
}

/** The identity whose quota is BLOCKING this session (the verdict's scope):
 *  the pool, or — for an unpooled session — its own credential slot. Not
 *  orgVerifiedKey: routing the VERDICT to the spawn-time org means asking a
 *  different account whether this session may spend (the pooled half of that
 *  mistake is what produced the 2026-09-07 fire loop). */
function _wallScope(session) {
  const a = session._accountId && accounts.get(session._accountId);
  if (a && a.type === 'pooled') return session._accountId;
  return wallKeyFor(session);
}

/** A wall SIGNAL landed on the session's current turn (rejected event /
 *  banner boolean / codex typed exhaustion). No transition yet — the turn's
 *  RESULT decides. */
function noteWallOnAccount(key, sid, now = Date.now()) {
  const ring = (_wallRing.get(key) || []).filter((e) => now - e.at < WALL_RING_MS);
  ring.push({ at: now, sid: sid || null });
  _wallRing.set(key, ring.slice(-WALL_RING_MAX));
}
function noteWallSignal(session, sig = {}) {
  const key = sig.key ? String(sig.key) : null; // the cache key the signal's mark landed on (org-verified at signal time)
  const sigs = (session._turnWallSigs = session._turnWallSigs || []);
  // the per-account ring counts WALLED TURNS, not records: one turn's banner
  // + its rejected event are ONE wall (a single turn must not satisfy the
  // ≥2-walls guard by itself)
  if (key && !sigs.some((s) => s.key === key)) noteWallOnAccount(key, session._webuiId);
  sigs.push({ at: Date.now(), resetsAtMs: Number(sig.resetsAtMs) || 0, bucket: sig.bucket || null, scopedName: sig.scopedName || null, key, slot: !!sig.slot });
  session._turnWorkAfterSig = 0;
}
/** Main-thread assistant output — work evidence for turn classification. */
function noteSessionProduced(session) {
  if (session._turnWallSigs && session._turnWallSigs.length) session._turnWorkAfterSig = (session._turnWorkAfterSig || 0) + 1;
}
/** The turn ended (claude `result` record / codex task_complete|task_failed).
 *  ALL wall-state transitions happen here and only here. */
function noteTurnEnd(session) {
  const sigs = session._turnWallSigs || [];
  const workAfter = session._turnWorkAfterSig || 0;
  session._turnWallSigs = []; session._turnWorkAfterSig = 0;
  if (sigs.length && workAfter <= 1) {
    // BLOCKED entry owns this turn's pool evaluation (B-2c9b): it runs AFTER
    // the demotion + the arm, so the link moves in the same tick and a hot
    // switch's fireNow() finds the session armed
    try { onWalledTurn(session, sigs); } catch (e) { console.warn('[wall] blocked-entry failed:', e.message); }
    return;
  }
  maybePoolAutoSwitch(session); // the per-turn pool evaluation this boundary always ran
  // a normally-completed turn is sufficient proof the session is not blocked
  try { getAutoResume()?.noteRecovered?.(session._webuiId, 'turn completed normally'); } catch { }
}

const BUCKET_LABEL = { fiveHour: '5h', sevenDay: '7d' };
/** (B-2c9b plan A, re-based 2026-09-07) WALL = GROUND TRUTH for the account
 *  whose credentials the CLI actually read. A walled turn's signals name the
 *  key their mark landed on — for a rejection that key is now the session's
 *  TOKEN SLOT (wallKeyFor: the validated link), not the OTel-observed org,
 *  because the observation names the identity the CLI cached at spawn (see
 *  the header note). Mark the affected bucket exhausted NOW — utilization 1,
 *  resetsAt = the signal's, else the bucket's cached future reset, else the
 *  bounded 5h/24h guess — through the SAME write path readings use
 *  (captureRateLimitEvent, source 'wall'), so anchors/estimator/verdicts all
 *  see it in this tick.
 *  VERIFICATION LADDER (the 2.368.34 misattribution class still applies to
 *  every account that is NOT the session's slot): the session's own validated
 *  slot is authority by itself — we know what the symlink points at, which is
 *  strictly better evidence than a telemetry attribute. Anything else needs
 *  the old corroboration: ≥2 walled turns inside WALL_RING_MS (any session)
 *  OR the account IS the session's OTel-observed org. Every outcome returns a
 *  named reason. */
function demoteWalledAccount(session, sigs) {
  const poolId = session._accountId;
  const a = poolId && accounts.get(poolId);
  if (!a || a.type !== 'pooled') return { demoted: false, reason: 'not-pooled' };
  const last = sigs.length ? sigs[sigs.length - 1] : null;
  const wallKey = (last && last.key) || wallKeyFor(session);
  const ids = new Set([wallKey]);
  try { for (const id of usageIdentityAccountIds(wallKey)) ids.add(id); } catch { }
  const slot = sessionBillingMember(session, poolId);
  const member = (accounts.poolMembers(poolId) || []).find((m) => ids.has(m.id)) || (slot.id && ids.has(slot.id) ? { id: slot.id, name: nameOf(slot.id) } : null);
  // "was this key the session's credential slot when the rejection arrived" —
  // asked of the SIGNAL, because the link may have moved since (see wallSlotFor)
  const slotSignal = sigs.some((x) => x && x.slot && (!x.key || ids.has(x.key)));
  if (!member) return { demoted: false, reason: 'not-a-member', key: wallKey };
  const now = Date.now();
  if (!(last && last.key)) noteWallOnAccount(wallKey, session._webuiId, now); // a key-less signal joins the ring at resolution time — this turn IS a wall on that account
  const walls = wallCount(wallKey, now);
  const observedId = observedMemberFor(session, poolId);
  const observedMatch = !!observedId && ids.has(observedId);
  const slotMatch = slotSignal || (!!slot.slotOk && !!slot.id && ids.has(slot.id));
  // this member said no to THIS session — true whether or not we demote it,
  // and the fact the verdict + the next target choice read
  noteSessionWall(session._webuiId, member.id, now);
  if (!slotMatch && walls < 2 && !observedMatch) {
    const held = (slot.id && ids.has(slot.id)) ? `this session's slot, but unvalidated: ${slot.slotReason || 'unknown'}` : "not this session's credential slot";
    console.log(`[wall] ${session._webuiId}: single wall on ${member.name} (${held}) — holding the demotion`);
    global.__vsEvent?.('wall-demote-held', `${member.id}:${walls}`);
    return { demoted: false, reason: 'unverified', key: member.id, walls };
  }
  // the buckets this turn's signals named for the account (a bucket-less
  // signal = fiveHour, the banner's shortest-self-heal rule); the signal's
  // resetsAt wins when it is in the future
  const buckets = new Map();
  for (const s of sigs) {
    if (s.key && !ids.has(s.key)) continue;
    const kind = s.bucket || 'fiveHour';
    if (kind === 'scoped' && !s.scopedName) continue;
    const k = kind === 'scoped' ? 'scoped:' + String(s.scopedName).toLowerCase() : kind;
    const b = buckets.get(k) || { kind, scopedName: kind === 'scoped' ? String(s.scopedName).toLowerCase() : null, resetsAtMs: 0 };
    b.resetsAtMs = Math.max(b.resetsAtMs, Number(s.resetsAtMs) || 0);
    buckets.set(k, b);
  }
  const done = [];
  for (const b of buckets.values()) {
    const ev = { kind: b.kind, scopedName: b.scopedName, status: 'rejected', utilization: null, resetsAt: b.resetsAtMs > now ? Math.floor(b.resetsAtMs / 1000) : null, overage: {} };
    const r = captureRateLimitEvent({ cacheDir: USAGE_CACHE_DIR, key: member.id, identityIds: usageIdentityAccountIds(member.id), ev, now, source: 'wall' });
    if (!r.ok) { console.warn(`[wall] demotion write failed for ${member.name}: ${r.error || 'unknown'}`); continue; }
    const label = b.kind === 'scoped' ? b.scopedName : BUCKET_LABEL[b.kind] || b.kind;
    let until = 0;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, String(member.id).replace(/[^\w.-]/g, '_') + '.json'), 'utf-8'));
      const bk = b.kind === 'scoped' ? (c.scopedWeekly || []).find((x) => String(x?.name || '').toLowerCase() === b.scopedName) : c[b.kind];
      until = (Number(bk?.resetsAt) || 0) * 1000;
    } catch { }
    const why = slotMatch ? 'credential slot' : observedMatch ? 'observed-org' : walls + '-walls';
    console.log(`[wall] demoted ${member.name} ${label} until ${until ? new Date(until).toISOString() : 'unknown'} (${walls} walls / ${why})`);
    global.__vsEvent?.('wall-demote', `${member.id}:${label}:${why}`);
    done.push({ label, until });
  }
  // (the write's fresh fetchedAt busts the estimator memo by itself — estimateFor re-anchors on a newer rawCache)
  return { demoted: done.length > 0, reason: done.length ? 'demoted' : 'no-bucket', key: member.id, walls, observedMatch, slotMatch, buckets: done };
}

function onWalledTurn(session, sigs) {
  const id = session._webuiId;
  const model = sessionModelFor(session);
  const scope = _wallScope(session);
  // FIRST: if this walled turn is the answer to a continue WE fired, that
  // fire FAILED. The breaker has to learn it before anything below re-arms
  // or re-switches — that ordering is the loop's off-switch (2026-09-07).
  try { getAutoResume()?.noteFireOutcome?.(id, false, 'limit rejection'); } catch { }
  // (A) the wall is ground truth for the account it landed on — write it
  // BEFORE the verdict reads the cache (readings only confirm)
  let demoted = null;
  try { demoted = demoteWalledAccount(session, sigs); } catch (e) { console.warn('[wall] demotion failed:', e.message); }
  try {
    const ar = getAutoResume();
    if (!ar?.armIfEnabled) return;
    const v = quotaVerdictFor(scope, { model, session });
    console.log(`[wall] ${id}: walled turn (scope ${scope}${demoted?.demoted ? `, demoted ${demoted.key}` : ''}) → ${v.usable === true ? 'usable via ' + (v.via || '?') : v.usable === false ? 'blocked until ' + (v.blockedUntil ? new Date(v.blockedUntil).toISOString() : 'unknown') : 'no data'}${v.divergent ? ` [billing ${nameOf(v.linked)}, OTel observed ${nameOf(v.observed)}]` : ''}`);
    if (v.usable === true) {
      // a member is free: the session is idle-walled and nothing else will
      // move it — a NEAR fire re-enters work through the normal machinery
      // (pre-fire gate re-verifies; the delayed announcement outlives this,
      // so a quick success stays silent). The pool eval in `finally` runs
      // with the session ARMED, so a hot switch's fireNow() continues it now.
      // The target must DIFFER from the identity that just rejected us —
      // quotaVerdictFor cannot answer `usable` through a walled member, so
      // reaching here with viaId === the wall's member would mean the two
      // disagree about identity; say so instead of arming (2026-09-07).
      if (v.viaId && demoted?.key && v.viaId === demoted.key) {
        console.log(`[wall] ${id}: the only usable member IS the one that just rejected this conversation (${nameOf(v.viaId)}) — not re-firing`);
        global.__vsEvent?.('wall-usable-is-rejector', String(v.viaId));
      } else {
        ar.armIfEnabled(id, session, Date.now() + 45000, `switched to a usable account (${v.via || '?'})`);
        return;
      }
    }
    const evReset = Math.max(0, ...sigs.map((s2) => s2.resetsAtMs || 0));
    const target = v.blockedUntil || evReset;
    if (target > Date.now()) {
      ar.armIfEnabled(id, session, target, v.reason || 'usage limit');
      // VERIFY the cache's word (inc-mtdsoj5f, userW: an ALIVE account read
      // dead-with-a-far-reset — "blocked until Aug-31" off stale data — until a
      // MANUAL refresh fixed it; a confident cache can lie exactly like an
      // absent one). One throttled probe re-verdicts: usable ⇒ the near-fire
      // path takes over in seconds, still blocked ⇒ the arm stands corrected.
      if (Date.now() - (_wallVerifyAt.get(scope) || 0) > 10 * 60e3) {
        _wallVerifyAt.set(scope, Date.now());
        scheduleWallProbe(session, scope, model, 0);
      }
      return;
    }
    // no reset time ANYWHERE (a rolled-over window's next reset only exists
    // after a fresh reading) → probe the data gap, never guess
    scheduleWallProbe(session, scope, model, 0);
  } finally {
    // the per-turn pool evaluation, AFTER the demotion and the arm: the link
    // moves in this same tick (the demoted member reads dead; the decision is
    // taken FROM the member whose credentials the CLI reads) and a hot
    // switch's fireNow() continues the armed session — through the breaker,
    // which refuses a second continue onto an identity that just rejected it
    maybePoolAutoSwitch(session);
  }
}

// ── CAPS-ROUTED QUOTA PROBE (S4): ONE dispatcher for every "refresh this
// identity's quota now" need (wall verification, the wall probe ladder, the
// auto-resume pre-fire gate). The identity's HARNESS names the rung:
//   'cli-usage'       claude — `claude -p /usage` (usage-routes
//                     refreshViaCliPanel, the owner-approved auto-cli channel)
//   'rpc-rate-limits' codex — account/rateLimits/read on a LIVE local codex
//                     chat session's own app-server (wrapper verb
//                     codex-read-limits; the reply lands as rate_limits_updated
//                     and recordCodexQuotaSignal settles the waiter AFTER the
//                     cache write, so a verdict taken next already sees it)
//   null              nothing to run (shell / unknown) — the verdict stands
// Before this every probe spawned `claude -p /usage` whatever the backend: a
// codex identity burned a pointless claude process and never got a fresh
// reading (design-harness-plugins.md §1 P2). §ban-safety unchanged — both
// rungs make the OFFICIAL client do the fetch; nothing here touches a vendor.
function codexQuotaKeyFor(session) {
  let key = session._accountId || '__global_codex__';
  // a pool wrapper never owns quota — the reading belongs to the CURRENT member
  try { const a = accounts.get(key); if (a && a.type === 'pooled') key = accounts.poolCurrentFor(key, session._webuiId) || accounts.poolCurrent(key) || key; } catch { }
  return key;
}
function pickCodexProbeSession(target, session) {
  const live = (s) => !!(s && s.pty && s.backend === 'codex' && s.mode === 'chat' && !s.host);
  // the asking session itself first: it sits idle-walled on exactly this
  // identity and its app-server is already up
  if (live(session)) return session;
  const ids = new Set(usageIdentityAccountIds(target));
  for (const [, s] of activeSessions) if (live(s) && ids.has(codexQuotaKeyFor(s))) return s;
  return null;
}
function readCodexLimitsViaSession(session, timeoutMs) {
  return new Promise((resolve) => {
    const waiters = (session._codexLimitsWaiters = session._codexLimitsWaiters || []);
    const entry = {};
    const drop = () => { const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1); };
    entry.timer = setTimeout(() => { drop(); resolve({ ok: false, reason: `no rate_limits_updated within ${timeoutMs}ms` }); }, timeoutMs);
    if (entry.timer.unref) entry.timer.unref();
    entry.resolve = (r) => { clearTimeout(entry.timer); drop(); resolve(r); };
    waiters.push(entry);
    try { session.pty.write(JSON.stringify({ type: 'codex-read-limits' }) + '\n'); }
    catch (e) { entry.resolve({ ok: false, reason: 'stdin write failed: ' + e.message }); }
  });
}
function settleCodexLimitsWaiters(session, result) {
  const waiters = session._codexLimitsWaiters;
  if (!waiters || !waiters.length) return;
  for (const w of waiters.splice(0)) { try { w.resolve(result); } catch { } }
}
async function probeQuotaForKey(target, { session = null, timeoutMs = 20000 } = {}) {
  const backend = quotaBackendFor(target, session);
  const rung = quotaSourceFor(backend).probe;
  global.__vsEvent?.('quota-probe', `${backend}:${rung || 'none'}`);
  if (rung === 'cli-usage') {
    const probe = getQuotaProbe?.();
    if (!probe) return { ok: false, rung, backend, reason: 'cli-usage probe not wired' };
    const ok = await Promise.resolve(probe(target)).catch(() => false);
    return { ok: !!ok, rung, backend, reason: ok ? null : 'cli panel did not answer' };
  }
  if (rung === 'rpc-rate-limits') {
    const s = pickCodexProbeSession(target, session);
    if (!s) return { ok: false, rung, backend, reason: 'no live local codex chat session on this identity' };
    const r = await readCodexLimitsViaSession(s, timeoutMs);
    return { ok: !!r.ok, rung, backend, reason: r.reason || null };
  }
  return { ok: false, rung: null, backend, reason: `backend '${backend}' declares no quota probe` };
}

// Probe ladder (owner-set): immediate, then 30min → 1h → 2h, then give up
// loudly. Each attempt refreshes the blocking account through the caps-routed
// dispatcher above (official client makes the fetch — §ban-safety intact).
const _wallVerifyAt = new Map(); // scope → last blocked-entry verification probe (10min floor)
const WALL_PROBE_BACKOFF = [0, 1800000, 3600000, 7200000];
function scheduleWallProbe(session, scope, model, attempt) {
  const id = session._webuiId;
  if (attempt >= WALL_PROBE_BACKOFF.length) { console.log(`[wall] ${id}: no reset time after ${attempt} probes — giving up (manual resume needed)`); return; }
  try { clearTimeout(session._wallProbeTimer); } catch { }
  session._wallProbeTimer = setTimeout(async () => {
    session._wallProbeTimer = null;
    try {
      if (!activeSessions.has(id)) return;
      if (!getAutoResume()?.enabledFor?.(session)) return;
      const a = accounts.get(scope);
      const target = a && a.type === 'pooled' ? sessionBillingMember(session, scope).id : scope; // the member whose credentials the CLI reads (2026-09-07: the link, slot-validated)
      if (target) await probeQuotaForKey(target, { session }).catch(() => { }); // caps-routed: never a claude spawn for a codex identity
      const v = quotaVerdictFor(scope, { model, session });
      const ar = getAutoResume();
      if (v.usable === true) { ar?.armIfEnabled?.(id, session, Date.now() + 45000, 'account usable again'); return; }
      if (v.blockedUntil > Date.now()) { ar?.armIfEnabled?.(id, session, v.blockedUntil, v.reason); return; }
      scheduleWallProbe(session, scope, model, attempt + 1);
    } catch (e) { console.warn('[wall] probe failed:', e.message); }
  }, WALL_PROBE_BACKOFF[attempt]);
  if (session._wallProbeTimer.unref) session._wallProbeTimer.unref();
}

/** The pre-fire gate (auto-resume beforeFire): probe fresh quota, re-check
 *  the verdict — false vetoes the spend and re-arms to the new blockedUntil. */
const _preFireProbeAt = new Map(); // probe target → last pre-fire probe (60s floor)
async function beforeAutoResumeFire(id, session) {
  try {
    const model = sessionModelFor(session);
    const scope = _wallScope(session);
    const a = accounts.get(scope);
    const target = a && a.type === 'pooled' ? sessionBillingMember(session, scope).id : scope; // the member whose credentials the CLI reads (2026-09-07: the link, slot-validated)
    // The immediate (pool-switch) path runs this gate too since 2026-09-07,
    // so the probe needs a floor: the wall demotion wrote this target's cache
    // microseconds ago, and a `claude -p /usage` spawn per hot switch would be
    // a new cost on a path that fires in bursts. The RE-VERDICT below always
    // runs — only the spawn is throttled.
    const probedAt = target ? _preFireProbeAt.get(target) || 0 : 0;
    if (target && Date.now() - probedAt > 60e3) {
      _preFireProbeAt.set(target, Date.now());
      try { await probeQuotaForKey(target, { session }); } catch { } // caps-routed (S4): the identity's harness picks the rung
    }
    maybePoolAutoSwitch(session);
    const v = quotaVerdictFor(scope, { model, session });
    if (v.usable === false) {
      if (v.blockedUntil > Date.now()) getAutoResume()?.armIfEnabled?.(id, session, v.blockedUntil, 're-armed at fire: ' + v.reason);
      else scheduleWallProbe(session, scope, model, 1);
      return false;
    }
    return true;
  } catch { return true; }
}
function recordRateLimitEvent(session, msg) {
  try {
    // the session's harness classifies the record (S4 QuotaSignalSource) —
    // the parse itself is rate-limit-capture's, reached through the registry
    const sig = quotaSourceFor(session.backend).signalFromStream(msg);
    const ev = sig && sig.source === 'rate_limit_event' ? sig.ev : null;
    if (!ev) return;
    // Session-scoped actions below (pool switch, auto-resume) stay on THIS
    // session regardless of re-attribution: it is genuinely blocked no
    // matter whose bucket filled.
    // A REJECTION is a fact about the credential SLOT the CLI reads (the
    // validated link) — a READING is a fact about whatever token produced its
    // numbers, which is where orgVerifiedKey's observed-org routing belongs
    // (B-b3cd odometer flap, unchanged). Mixing the two put every rejection on
    // the spawn-time org and left the linked member reading "healthy"
    // forever — the 2026-09-07 fire loop.
    const slot = ev.status === 'rejected' ? wallSlotFor(session) : null;
    const key = slot && slot.key
      ? slot.key
      : orgVerifiedKey(session, usageCacheKeyFor(session), 'rate-limit-event:' + ev.kind);
    const r = captureRateLimitEvent({ cacheDir: USAGE_CACHE_DIR, key, identityIds: usageIdentityAccountIds(key), ev });
    if (r.unknownType) { global.__vsEvent?.('rate-limit-event-unknown-type', r.unknownType); return; }
    global.__vsEvent?.('rate-limit-event', `${key}:${ev.kind}:${ev.status}${r.wroteReading ? ':reading' : ''}`);
    // a reading busts the estimator memo via fetchedAt and becomes an anchor
    // at the next sweep; exhaustion acts NOW (banner parity)
    if (r.dead) {
      maybePoolAutoSwitch(session);                    // another account = seconds, not hours: always preferred
      // wall-machine SIGNAL (2.369.0): no arming here — the turn's RESULT
      // classifies (a turn the switch rescues completes normally and never
      // enters BLOCKED; a genuinely walled turn arms off quotaVerdict).
      try { noteWallSignal(session, { resetsAtMs: (Number(ev.resetsAt) || 0) * 1000, bucket: ev.kind, scopedName: ev.scopedName, key, slot: !!slot?.slotOk }); } catch { }
    } else if (r.wroteReading) {
      try { if (ev.status && ev.status !== 'rejected') getAutoResume()?.noteRecovered?.(session._webuiId, 'fresh non-rejected reading'); } catch { }
      kickPoolEval();
    }
  } catch (e) { console.warn('[usage] rate_limit_event capture failed:', e.message); }
}
// ── Codex quota signals (P2, design-backend-parity.md §2) ──────────────────
// The wrapper relays account/rateLimits/updated as `rate_limits_updated` and
// forwards the typed codex_error_info on task_failed. Readings write the SAME
// per-account cache the pool decisions and the estimator read; exhaustion
// (rate_limit_reached_type / usage_limit_reached family) acts like a claude
// rejected rate_limit_event: pool switch first, auto-resume as the fallback.
// The typed exhaustion enum + the snapshot normalizer live in the codex
// harness (src/harnesses/codex-quota.js, S4): the harness classifies the
// record into a signal, the engine runs the ladder on the signal.
function recordCodexQuotaSignal(session, payload) {
  try {
    const sig = quotaSourceFor(session.backend).signalFromStream({ type: 'event_msg', payload });
    const writeSnap = (snap) => {
      if (!snap) return null;
      let key = session._accountId || '__global_codex__';
      // a pool wrapper never owns quota — the reading belongs to the CURRENT member
      try { const a = accounts.get(key); if (a && a.type === 'pooled') key = accounts.poolCurrentFor(key, session._webuiId) || accounts.poolCurrent(key) || key; } catch { }
      try {
        fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
        const f = path.join(USAGE_CACHE_DIR, String(key).replace(/[^\w.-]/g, '_') + '.json');
        let cur = null; try { cur = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { }
        if (!cur || (Number(cur.fetchedAt) || 0) < (Number(snap.fetchedAt) || 0)) {
          fs.writeFileSync(f + '.tmp', JSON.stringify(snap)); fs.renameSync(f + '.tmp', f);
        }
      } catch { }
      return { key, snap };
    };
    // Escape ladder on codex exhaustion (owner-designed order): ① stored
    // RESET CREDIT when opted in (codex.limitResetCredit='auto' — spending a
    // stored reset unattended is the same consent class as auto-resume, so
    // default off) → ② pool switch → ③ auto-resume wait. One credit attempt
    // per limit event, 10min re-try floor.
    const tryResetCredit = (resetsAtSec) => {
      try {
        if (serverSetting('codex.limitResetCredit') !== 'auto') return false;
        if (!session.pty || session.mode !== 'chat') return false;
        const now = Date.now();
        if (session._codexResetTriedAt && now - session._codexResetTriedAt < 10 * 60e3) return false;
        session._codexResetTriedAt = now;
        session._codexLastResetsAt = Number(resetsAtSec) || 0;
        session.pty.write(JSON.stringify({ type: 'codex-reset-credit' }) + '\n');
        serverNotice(`codex-reset-${session._webuiId}-${now}`, `Codex hit a usage limit — trying a stored rate-limit reset credit before switching accounts.`);
        global.__vsEvent?.('codex-reset-credit-try', session._accountId || 'global');
        return true;
      } catch { return false; }
    };
    if (payload.type === 'reset_credit_result') {
      const out = payload.outcome || payload.result?.outcome || null;
      if (out === 'reset') {
        serverNotice(`codex-reset-ok-${session._webuiId}-${Date.now()}`, `Codex reset credit consumed — the limit was reset, continuing on the same account.`);
        try { getAutoResume()?.noteRecovered?.(session._webuiId, 'codex reset credit consumed'); } catch { }
        kickPoolEval();
      } else {
        // credit didn't land (nothingToReset / alreadyRedeemed / cooldown /
        // error) — fall through to the normal ladder: switch, else wait.
        global.__vsEvent?.('codex-reset-credit-failed', String(out || payload.error || 'unknown').slice(0, 60));
        maybePoolAutoSwitch(session);
        const resets = Number(session._codexLastResetsAt) || 0;
        try { noteWallSignal(session, { resetsAtMs: resets * 1000, bucket: 'sevenDay', key: codexQuotaKeyFor(session) }); noteTurnEnd(session); } catch { }
      }
      return;
    }
    if (payload.type === 'rate_limits_updated' && payload.rateLimits) {
      // the harness normalized the snapshot (window-by-length, exhaustion
      // markers, the on-demand resetCredits count) — sig.snapshot is it
      const snap0 = sig?.snapshot || null;
      const w = writeSnap(snap0);
      // an rpc-rate-limits probe waiting on this session settles AFTER the
      // cache write — its next quotaVerdictFor already reads the fresh file
      settleCodexLimitsWaiters(session, w ? { ok: true } : { ok: false, reason: 'unparseable rateLimits' });
      if (!w) return;
      global.__vsEvent?.('codex-rate-limits', `${w.key}${w.snap.rateLimitReachedType ? ':reached-' + w.snap.rateLimitReachedType : ''}`);
      if (sig.kind === 'exhausted') {
        const tripped = sig.tripped; // the window rate_limit_reached_type named
        if (tryResetCredit(tripped?.resetsAt)) return; // outcome event continues the ladder
        maybePoolAutoSwitch(session); // another ChatGPT account = seconds, not hours
        try { noteWallSignal(session, { resetsAtMs: (Number(tripped?.resetsAt) || 0) * 1000, bucket: tripped && tripped === w.snap.fiveHour ? 'fiveHour' : 'sevenDay', key: w.key }); } catch { }
      } else {
        try { getAutoResume()?.noteRecovered?.(session._webuiId, 'fresh non-limited codex reading'); } catch { }
        kickPoolEval();
      }
      return;
    }
    if (payload.type === 'rate_limits_updated') {
      // an on-demand rateLimits/read that FAILED ({error, onDemand}) — settle
      // any rpc-rate-limits probe waiting on this session, honestly
      settleCodexLimitsWaiters(session, { ok: false, reason: String(payload.error || 'no rateLimits in reply') });
      return;
    }
    if (payload.type === 'task_failed') {
      if (!sig) return; // no typed codex_error_info, or one that is neither exhaustion nor auth
      const info = sig.errorInfo;
      if (sig.kind === 'exhausted') {
        // exhaustion may arrive WITHOUT a fresh snapshot — mark the current
        // member's cache dead with the error's resets_at (or a bounded guess)
        const nowSec = Math.floor(Date.now() / 1000);
        const resets = sig.resetsAtSec;
        const snap = sig.snapshot || {
          limitId: 'codex', sevenDay: { utilization: 1, usedPercent: 100, windowMinutes: 10080, resetsAt: resets > nowSec ? resets : nowSec + 24 * 3600, status: 'limited' },
          fiveHour: null, rateLimitReachedType: 'unknown', fetchedAt: Date.now(),
        };
        const w2 = writeSnap(snap);
        global.__vsEvent?.('codex-usage-limit', info);
        if (tryResetCredit(resets)) return; // ① reset credit first when opted in
        maybePoolAutoSwitch(session);
        try { noteWallSignal(session, { resetsAtMs: resets > nowSec ? resets * 1000 : 0, bucket: 'sevenDay', key: w2?.key || codexQuotaKeyFor(session) }); noteTurnEnd(session); } catch { }
      } else if (sig.kind === 'auth-failure') {
        global.__vsEvent?.('codex-auth-failure', session._accountId || 'global'); // v1: surfaced, not auto-evicted (claude's evict is creds-path-specific)
      }
      return;
    }
  } catch (e) { console.warn('[codex-quota] signal failed:', e.message); }
}
function markLimitBanner(session, text) {
  try {
    const hit = ClaudeCodeAdapter.parseLimitBanner(text);
    if (!hit) return;

    // host-aware (2.289.0) — a remote host-login banner belongs to the host
    // bucket, not __global__. The banner is a REJECTION (the CLI refused the
    // turn), so since 2026-09-07 it marks the session's credential SLOT, the
    // same identity the wall machine demotes — not the OTel-observed org
    // (that names the identity cached at spawn; see the header note).
    const slot = wallSlotFor(session);
    const key = slot.key || orgVerifiedKey(session, usageCacheKeyFor(session), 'limit-banner');
    const nowSec = Math.floor(Date.now() / 1000);
    const bump = (b, fallbackResetSec) => ({
      ...(b || {}),
      utilization: 1, status: 'limited',
      // keep a known FUTURE reset; else a bounded guess so the marker self-
      // expires (reset-passed ⇒ full) instead of pinning the account dead
      resetsAt: (Number(b?.resetsAt) || 0) > nowSec ? b.resetsAt : nowSec + fallbackResetSec,
    });
    const applyHit = (cache) => {
      if (hit.kind === 'fiveHour') cache.fiveHour = bump(cache.fiveHour, 5 * 3600);
      else if (hit.kind === 'sevenDay') cache.sevenDay = bump(cache.sevenDay, 24 * 3600);
      else if (hit.kind === 'scoped') {
        const list = Array.isArray(cache.scopedWeekly) ? cache.scopedWeekly : [];
        const i = list.findIndex((x) => String(x?.name || '').toLowerCase() === hit.name.toLowerCase());
        if (i >= 0) list[i] = bump(list[i], 24 * 3600);
        else list.push({ name: hit.name, ...bump(null, 24 * 3600) });
        cache.scopedWeekly = list;
      }
      return cache;
    };
    const fileFor = (id) => path.join(USAGE_CACHE_DIR, String(id).replace(/[^\w.-]/g, '_') + '.json');
    // IDENTITY-GROUP write (2.267.0, anchor-poison root cause): an org-merged
    // login keeps several cache files, and stamping fetchedAt=now onto ONE of
    // them used to PROMOTE that file — week-stale sibling buckets and all —
    // to "freshest" for the anchor sweep (real incident: banner on the idle
    // __global__ file flapped the identity's anchors 51→19→51 and the bounce
    // pair taught a poison rate). Base the promoted write on the identity's
    // FRESHEST file, and mark the same bucket dead in every sibling WITHOUT
    // touching its fetchedAt (a stale file must never gain freshness here).
    const ids = usageIdentityAccountIds(key);
    let base = null, baseAt = -1;
    for (const id of ids) {
      try { const c = JSON.parse(fs.readFileSync(fileFor(id), 'utf-8')) || {}; if ((Number(c.fetchedAt) || 0) > baseAt) { baseAt = Number(c.fetchedAt) || 0; base = c; } } catch {}
    }
    const cache = applyHit(base ? { ...base } : {});
    cache.fetchedAt = Date.now(); cache.source = 'limit-banner';
    fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
    const f = fileFor(key);
    fs.writeFileSync(f + '.tmp', JSON.stringify(cache)); fs.renameSync(f + '.tmp', f);
    for (const id of ids) {
      if (id === key) continue;
      try {
        const f2 = fileFor(id);
        let c2; try { c2 = JSON.parse(fs.readFileSync(f2, 'utf-8')) || null; } catch { c2 = null; }
        if (!c2) continue; // never CREATE a sibling file here
        applyHit(c2); // fetchedAt deliberately untouched
        fs.writeFileSync(f2 + '.tmp', JSON.stringify(c2)); fs.renameSync(f2 + '.tmp', f2);
      } catch {}
    }
    global.__vsEvent?.('usage-limit-banner-marked', `${key}:${hit.kind}`);
    maybePoolAutoSwitch(session); // freshest possible exhaustion signal — act now
    // wall-machine: the banner is a BOOLEAN signal only (owner: never parse
    // text for TIMES) — no resetsAtMs here; the bucket name is the same one
    // parseLimitBanner gave the cache mark, and `key` is where that mark
    // landed (the wall's account, B-2c9b). Times come from quotaVerdict/probe.
    try { noteWallSignal(session, { bucket: hit.kind, scopedName: hit.kind === 'scoped' ? hit.name : null, key, slot: !!slot.slotOk }); } catch { }
  } catch (e) { console.warn('[usage] banner mark failed:', e.message); }
}

function maybePoolAutoSwitch(session) {
  try { if (session._accountId) maybePoolAutoSwitchForPool(session._accountId); } catch { }
}
// EVENT-DRIVEN pool evaluation (user-designed after exhaustion #2, 2026-08-09):
// every streamed usage record kicks a (5s-throttled) re-evaluation instead of
// waiting for the timer — combined with the estimator's live odometer, burst
// burns are seen the moment the CLI streams them, not when the ledger scan
// catches up. Zero network; decision reads memory + local files only.
let _poolEvalKickAt = 0;
function kickPoolEval() {
  const now = Date.now();
  if (now - _poolEvalKickAt < 5000) return;
  _poolEvalKickAt = now;
  setImmediate(() => {
    try {
      for (const a of accounts.list().accounts || []) {
        if (a.type === 'pooled' && a.auto) { try { maybePoolAutoSwitchForPool(a.id); } catch { } }
      }
    } catch { }
  });
}
// WORKFLOW usage tailer (2.266.0, user question "不能拦截workflow agents吗"):
// workflow agents are IN-PROCESS API calls writing FILE-ONLY transcripts —
// there is no process to wrap — but tailing the run dir is the same thing at
// the file level: every agent-*.jsonl growth streams its usage records into
// the live odometer within ~1-2s (vs the 30s timer+scan). Armed when the
// launch ack ("Run ID: wf_…") crosses the session's stdout; belt-polled 5s
// (fs.watch can coalesce/miss); torn down after 30min without growth or when
// the session dies. rid-dedup in noteLive makes offset loss/re-reads harmless.
const _wfWatchers = new Map(); // runId → tailer handle
function armWorkflowUsageWatcher(session, sessionId, runId) {
  try {
    if (_wfWatchers.has(runId) || _wfWatchers.size >= 6) return;
    if (session.host) return; // remote runs have no local files; timer+harvest cover them
    const sid = session.claudeSessionId || session.backendSessionId;
    if (!sid || !session.cwd) return;
    const { cwdToProjectDir } = require('../session-store.js');
    const dir = path.join(os.homedir(), '.claude', 'projects', cwdToProjectDir(session.cwd), sid, 'subagents', 'workflows', runId);
    // The tailer RETRIES until the dir exists — the ack beats the harness's
    // mkdir by ~17ms, so the old one-shot existsSync never armed (2.270.0,
    // see src/workflow-usage-tailer.js for the forensics).
    const { createWorkflowTailer } = require('../workflow-usage-tailer.js');
    const tailer = createWorkflowTailer({
      dir,
      isAlive: () => activeSessions.has(sessionId),
      onRecord: (r) => {
        const u = r.message?.usage;
        const rid = r.requestId || r.message?.id; if (!rid) return;
        const cc = u.cache_creation || {};
        const acctKey = resolveUsageKey(session);
        const acct = acctKey === '__global__' ? null : acctKey;
        const model = r.message?.model;
        const cost = (o) => usageHistory._cost({ acct, model, i: 0, o: 0, cw5: 0, cw1: 0, cr: 0, ...o });
        const usd = cost({ i: u.input_tokens || 0, o: u.output_tokens || 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: u.cache_read_input_tokens || 0 });
        const cwUsd = cost({ cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0 });
        const crUsd = cost({ cr: u.cache_read_input_tokens || 0 });
        usageEstimator.noteLive({ rid, accountId: acctKey, model, usd, cwUsd, crUsd });
      },
      onDrain: (n) => {
        // Observability: this feature died silently for four releases because
        // nothing ever reported it running. Both signals are cheap + local.
        global.__vsMetric?.('wf-usage-noted', n);
        if (!_wfWatchers.get(runId)?._announced) {
          const h = _wfWatchers.get(runId); if (h) h._announced = true;
          global.__vsEvent?.('wf-usage-tailer-armed', runId);
        }
        kickPoolEval();
      },
    });
    _wfWatchers.set(runId, tailer);
    // Reap the handle when the tailer gives up (dead session / idle / no dir).
    const reap = setInterval(() => {
      if (_wfWatchers.get(runId) !== tailer) { clearInterval(reap); return; }
      if (tailer._state.stopped) { _wfWatchers.delete(runId); clearInterval(reap); }
    }, 30000);
    if (reap.unref) reap.unref();
  } catch { }
}
// TIMER-driven evaluation (2.263.0, real incident): the event triggers (turn
// `result` records + limit banner) both sit at TURN EDGES — an 8-minute
// review workflow burned an entire 5h window mid-turn with ZERO evaluation
// points and the pool only switched after exhaustion had failed 9 agents.
// Every auto pool now re-evaluates on a 60s timer (per-pool 60s throttle
// unchanged). §ban-safety: local reads only — the ledger scan mines the CLI's
// own transcripts (self-throttled), the decision reads cache files; no
// network anywhere.
setInterval(() => {
  try {
    const pools = (accounts.list().accounts || []).filter((a) => a.type === 'pooled' && a.auto);
    if (!pools.length) return;
    try { usageHistory.scan(); } catch { } // freshen the odometer first (incremental, 15s-throttled)
    for (const a of pools) { try { maybePoolAutoSwitchForPool(a.id); } catch { } }
  } catch { }
  // 30s (was 60s): the 2026-08-09 #2 exhaustion burned HALF the Fable bucket
  // between two ticks (12 concurrent maxed-context agents ≈ $100+/min) — a
  // tighter cadence can't fully close that gap (ledger visibility lags the
  // burn) but halves the blind window; anti-flap now lives in MIN_GAIN_PCT +
  // the proactive margin, not the cadence.
}, 30000);
function credsTokenSig(id) {
  // TOKEN MATERIAL signature, not mtime (review finding: repointPoolSymlink
  // utimes-bumps the target's creds on EVERY re-point, so an mtime-based
  // "somebody re-logged in" check is cleared by the pool's own plumbing).
  try { return String(JSON.parse(fs.readFileSync(accounts.subCredsPath(id), 'utf-8'))?.claudeAiOauth?.accessToken || ''); } catch { return ''; }
}
function memberAuthFailed(id) {
  const m = _memberAuthFail.get(id);
  if (!m) return false;
  if (Date.now() - m.at > AUTH_FAIL_TTL_MS) { _memberAuthFail.delete(id); return false; }
  if (credsTokenSig(id) !== m.tok) { _memberAuthFail.delete(id); return false; } // token CHANGED = re-login/refresh — give it another chance
  return true;
}
function healthyPoolMembers(poolId) {
  const all = accounts.poolMembers(poolId);
  const ok = all.filter((m) => !memberAuthFailed(m.id));
  return ok.length ? ok : all; // every member marked = marks are wrong or the pool is truly dead; let quota logic speak
}

// A running session's CLI reported an AUTH-class API failure (401×2+/403/ban/
// credit message). Quota decisions can't see this — the failed account often
// still shows plenty of remaining — so route around it NOW: mark the member,
// re-point this session's link (and the pool default if it sits on the failed
// member), and say what happened. Runs regardless of `auto`: this is routing
// around a dead account (the 2.330.2 heal's live-session sibling), not quota
// optimization.
function notePoolAuthFailure(session, sid, info = {}) {
  try {
    const poolId = session?._accountId;
    const a = poolId && accounts.get(poolId);
    if (!a || a.type !== 'pooled' || session.host) return;
    if (!quotaSourceFor(session.backend).classifyAuthFailure(info)) return; // the session's harness knows its vendor's wording (S4)
    const memberId = accounts.poolCurrentFor(poolId, sid);
    if (!memberId) return;
    const now = Date.now();
    // throttle PER (member, session) — the member-keyed version left every
    // OTHER conversation pinned to the banned account for 60s each (review
    // finding: 3 sessions on A, A banned, only the first escaped)
    const tkey = memberId + ':' + sid;
    if (now - (_authNoteAt.get(tkey) || 0) < 60000) return;
    _authNoteAt.set(tkey, now);
    const why = info.message ? String(info.message).slice(0, 120) : `HTTP ${info.status}`;
    if (!memberAuthFailed(memberId)) {
      _memberAuthFail.set(memberId, { at: now, reason: why, tok: credsTokenSig(memberId) });
      try { global.__vsEvent?.('pool-member-auth-failed', { detail: `${memberId}: ${why}` }); } catch { }
    }
    const memberName = accounts.get(memberId)?.name || memberId;
    const alive = accounts.poolMembers(poolId).filter((m) => m.id !== memberId && !memberAuthFailed(m.id));
    if (!alive.length) {
      serverNotice(`pool-authfail-stuck-${memberId}-${Math.floor(now / 3600000)}`,
        `Pool "${a.name}": account ${memberName} is failing authentication (${why}) and no other member can take over — re-login or replace it in Manage Agents.`, { level: 'warn' });
      return;
    }
    const ranked = rankPoolMembers({ members: alive, readCache: poolReadCache(poolId), nowSec: now / 1000 });
    const to = (ranked[0] && ranked[0].id) || alive[0].id;
    const toName = accounts.get(to)?.name || to;
    const hasOwnLink = (() => { try { fs.lstatSync(accounts.sessionPoolLinkPath(poolId, sid)); return true; } catch { return false; } })();
    if (hasOwnLink) accounts.ensureSessionPoolLink(poolId, sid, to);
    const defaultMoved = accounts.poolCurrent(poolId) === memberId;
    if (defaultMoved) accounts.setPoolTarget(poolId, to);
    _poolSwitchAt.set(poolId + ':' + sid, now); // keep the quota pass's dwell belt consistent with this move
    try { recordUsageAttribution({ claudeSessionId: session.claudeSessionId || session.backendSessionId, accountId: poolId }); } catch { }
    if (now - (_authNoticeAt.get(memberId) || 0) > 60000) {
      _authNoticeAt.set(memberId, now);
      serverNotice(`pool-authfail-${memberId}-${now}`,
        `Pool "${a.name}": account ${memberName} is failing authentication (${why}) — switched to ${toName}.${a.hot ? '' : ' Restarting the conversation to apply it.'}`, { level: 'warn' });
    }
    console.log(`[pool] auth-failure evict ${poolId}/${sid}: ${memberId} → ${to} (${why})`);
    if (!a.hot) {
      // a DEFAULT-link move affects every session billing through the default
      // (no own link), not just the reporter — collect them all (review)
      const affected = [];
      const pack = (theSid, s3) => ({ serverId: theSid, backend: s3.backend || 'claude', backendSessionId: s3.claudeSessionId || s3.backendSessionId || null, cwd: s3.cwd || null, name: s3.name || null, host: s3.host || null });
      affected.push(pack(sid, session));
      if (defaultMoved) {
        for (const [sid2, s2] of activeSessions) {
          if (sid2 === sid || s2._accountId !== poolId || s2.host) continue;
          const own = (() => { try { fs.lstatSync(accounts.sessionPoolLinkPath(poolId, sid2)); return true; } catch { return false; } })();
          if (!own) affected.push(pack(sid2, s2));
        }
      }
      const payload = JSON.stringify({ type: 'pool-auto-switched', poolId, affected });
      for (const c of wss.clients) { if (c.readyState === WS_OPEN) { try { c.send(payload); } catch { } break; } }
    }
  } catch (e) { console.warn('[pool] auth-failure evict failed:', e.message); }
}

function maybePoolAutoSwitchForPool(poolId) {
  try {
    if (!poolId) return;
    const a = accounts.get(poolId);
    if (!a || a.type !== 'pooled' || !a.auto) return;
    const now = Date.now();
    if ((now - (_poolAutoLast.get(poolId) || 0)) < 10000) return; // event-driven kicks need a tight gate; anti-flap = MIN_GAIN, not cadence
    const currentId = accounts.poolCurrent(poolId);
    if (!currentId) return;
    // Capability-gated (P4 slice, src/backend-caps.js): hot only where a
    // live re-read is VERIFIED (codex: experimentally refuted, 2026-08-24 —
    // CODEX_HOME canonicalized at startup + tokens held in process memory);
    // sealed orders + plan-C per-session links only where those material
    // paths exist. The pool-level decide + cold-restart machinery below is
    // backend-agnostic.
    const poolCaps = capsOf(a.backend);
    const isCodexPool = (a.backend || 'claude') === 'codex'; // (naming kept for the gates below)
    const hot = !!a.hot && poolCaps.hotSwitch === 'verified';
    // ESTIMATED bucket view (B-fcff v2): the raw cache goes stale the moment
    // its session pauses — overlay dead-reckoned utilizations (anchor + rate ×
    // ledger cost since) so the decision sees NOW, not the last reading. The
    // estimator abstains per bucket when it has nothing better; those keep raw.
    const readCache = (id) => {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, id + '.json'), 'utf-8')); } catch { }
      // ORG-MERGED identities keep TWO cache files (__global__ + the named
      // sub) and ground truth lands in whichever one the refresh targeted —
      // during the 2026-08-09 #2 exhaustion the ⟳ readings (Fable 34%→51%)
      // went to __global__.json while this decision read the sub's file
      // frozen at 01:23. Read through the IDENTITY GROUP: freshest file wins.
      try {
        for (const [, g] of usageIdentityGroupsCached()) {
          if (g.accountIds.includes(id) && g.cache && (g.cache.fetchedAt || 0) > (raw?.fetchedAt || 0)) { raw = g.cache; break; }
        }
      } catch { }
      try { return estOverlayCache(raw, usageEstimator.estimateFor(id, raw, now)); } catch { return raw; }
    };
    // proactive EDF tier only for HOT pools (re-point is free — no restart);
    // cold pools switch on exhaustion only (each switch restarts conversations).
    // Hot pools also treat est<10% as exhaustion (提前切 — switch BEFORE the
    // limit interrupts a long-running workflow; cold keeps 5%).
    // SEALED ORDERS push (design §Pool management, 2.300.0): after every
    // evaluation the holding device (device #0 — pools are local-only) gets
    // the pool's ranked member snapshot. It executes a LOCAL fallback switch
    // ONLY when it both sees a hard limit banner AND cannot reach this
    // server; executions are reported on reconnect and re-attributed below.
    // OBSERVE the rejection: hosts.device(null) throws while the local daemon
    // is down/upgrading, and an unobserved rejection is a process-level
    // unhandledRejection on every eval tick (the deviceBounded ② rule)
    if (poolCaps.sealedOrders) pushSealedOrders(poolId).catch((e) => { if (!_poolOrdersWarned) { _poolOrdersWarned = true; console.warn('[pool] sealed-orders push unavailable:', e.message); } });
    // ── Per-SESSION pass (plan C): sessions with their OWN link decide on a
    // FAMILY-PROJECTED view and re-point only their link — an opus session's
    // spent cap never evicts a fable session, and vice versa. Sessions whose
    // family is unknown project nothing (full view = legacy semantics).
    const members = healthyPoolMembers(poolId); // auth-failed members are not candidates (2.335.0)
    for (const [sid, s2] of activeSessions) {
      if (!poolCaps.planC) break; // plan-C per-session links need the backend's material path
      if ((s2.backend || 'claude') === 'codex') continue;
      if (s2._accountId !== poolId || s2.host) continue;
      let linkCur = null;
      try { linkCur = accounts.poolCurrentFor(poolId, sid); } catch { }
      const hasOwnLink = (() => { try { fs.lstatSync(accounts.sessionPoolLinkPath(poolId, sid)); return true; } catch { return false; } })();
      if (!hasOwnLink || !linkCur) continue;
      // Decide FROM the member whose credentials this session's CLI reads —
      // its token slot (2026-09-07, reversing B-2c9b plan B for DECISIONS):
      // deciding from the OTel-observed org made every cycle of the fire loop
      // "switch" to the member the link was already on ("re-point, same
      // target", 740 of them in the incident journal) and then fire again.
      // The observation still rides along in the log line as corroboration.
      const cm = sessionBillingMember(s2, poolId);
      const curFor = cm.id || linkCur;
      const fam = familyOfModel(sessionModelFor(s2));
      const projected = (id) => projectCacheForFamily(readCache(id), fam);
      // never pick a member that just answered THIS session with a limit
      // rejection (verdict-level twin of the same fact)
      const rejected = [...sessionWalledMembers(sid, now)];
      const ds = decidePoolSwitch({ currentId: curFor, members, readCache: projected, nowSec: now / 1000, proactive: hot, hot, pessimism: darkTaintedAccounts(), exclude: rejected, explain: true });
      if (!ds || !ds.to) {
        // "there is nowhere for this conversation to go" is the state only the
        // USER can fix. The FACT is handed to auto-resume every time (it is
        // the ONLY source for the breaker's "no usable member left" clause —
        // a refusal reason does not imply it, and round 1 said it anyway);
        // the operator's line below stays throttled to once per 10min.
        const noWay = ds && (ds.reason === 'all-rejected' || ds.reason === 'no-members' || ds.reason === 'stuck');
        if (noWay) try { getAutoResume()?.noteNoPoolTarget?.(sid, rejected.length, ds.reason); } catch { }
        if (ds && ds.reason === 'all-rejected' && now - (_noTargetLogAt.get(sid) || 0) > 10 * 60e3) {
          _noTargetLogAt.set(sid, now);
          console.log(`[pool] per-session ${poolId}/${sid}: nowhere to go — ${rejected.length} member(s) already rejected this conversation`);
          global.__vsEvent?.('pool-sess-all-rejected', `${sid}:${rejected.length}`);
        }
        continue;
      }
      const dwellKey = poolId + ':' + sid;
      const lastS = _poolSwitchAt.get(dwellKey) || 0;
      if (now - lastS < 180000 && !(ds.fromRemaining != null && ds.fromRemaining < POOL_HARD_PCT)) continue;
      _poolSwitchAt.set(dwellKey, now);
      try {
        accounts.ensureSessionPoolLink(poolId, sid, ds.to);
        try { recordUsageAttribution({ claudeSessionId: s2.claudeSessionId || s2.backendSessionId, accountId: poolId }); } catch { }
        const toName = accounts.get(ds.to)?.name || ds.to;
        // a same-target re-point (observed ≠ linked, the link was already on
        // the chosen member) is not a user-visible switch: journal + the
        // creds-mtime bump that makes the CLI re-read the link, no notice
        if (ds.to !== linkCur) serverNotice(`pool-sess-${sid}-${now}`, `Pool "${a.name}": conversation "${s2.name || sid}" moved to ${toName}${cm.divergent ? ` (it was still running on ${nameOf(curFor)})` : ''}${fam ? ` (its ${fam} quota${ds.fromRemaining != null ? ` was at ${Math.round(ds.fromRemaining)}%` : ''})` : ''}${a.hot ? '' : ' — restarting it'}`);
        console.log(`[pool] per-session switch ${poolId}/${sid}: ${curFor}${cm.divergent ? ` (observed; linked ${linkCur})` : ''} → ${ds.to}${ds.to === linkCur ? ' (re-point, same target)' : ''} (fam=${fam || '?'}, from ${ds.fromRemaining}%)`);
        // a hot re-point does not move an idle limit-blocked session by itself
        // (c1206711: the pool switched back and the session stayed dead) —
        // an ARMED session gets its continue NOW. Hot only: a cold switch
        // restarts the conversation through the client instead.
        if (a.hot) { try { getAutoResume()?.fireNow?.(sid, `账号池已切换到 ${toName}`); } catch { } }
        if (!a.hot) {
          const payload = JSON.stringify({ type: 'pool-auto-switched', poolId, affected: [{ serverId: sid, backend: s2.backend || 'claude', backendSessionId: s2.claudeSessionId || s2.backendSessionId || null, cwd: s2.cwd || null, name: s2.name || null, host: s2.host || null }] });
          for (const c of wss.clients) { if (c.readyState === WS_OPEN) { try { c.send(payload); } catch {} break; } }
        }
      } catch (e) { console.warn('[pool] per-session re-point failed:', e.message); }
    }
    const d = decidePoolSwitch({ currentId, members, readCache, nowSec: now / 1000, proactive: hot, hot, pessimism: darkTaintedAccounts(), explain: true });
    if (!d) return;
    if (!d.to) {
      // A pool sitting on a DEAD account with nowhere to go used to be
      // completely silent — the user found out by hitting a limit mid-turn
      // (real incident 2026-08-11). Say it, once per hour per pool: this is
      // the state where only the user can act (add a member, wait for a
      // reset, switch that conversation off the pool).
      // EVERY non-actionable outcome must speak, not just 'stuck' (2.313.0):
      // when the candidate gate drops every member the code returns through
      // 'no-members' instead, which was silent — the same "pool sits on a dead
      // account while the user finds out by hitting a limit" incident down a
      // different branch. `_sentNotices` is a per-BOOT permanent Set, so the
      // key must carry an hour bucket or a recurrence is never reported again.
      if (d.reason === 'stuck' || d.reason === 'no-members' || d.reason === 'no-settleable') {
        // Say WHICH buckets are dead. "Every member is out of quota" is wrong
        // under the nested model and points at the wrong action (pay/wait a
        // week) when the truth is usually "one model's weekly cap is spent
        // while the 7-day budget still has 40% left".
        const dead = (d.deadBuckets || []).join(', ');
        const live = (d.liveBuckets || []).join(', ');
        const what = dead ? `spent: ${dead}` : 'out of quota';
        const rest = live ? ` (still available: ${live})` : '';
        const alt = d.bestRemaining != null ? ` The best other member is at ${Math.round(d.bestRemaining)}%.` : '';
        const why = d.reason === 'no-members'
          ? `no member can serve it — ${what}${rest}`
          : `nowhere better to go — ${what}${rest}`;
        serverNotice(`pool-blocked-${poolId}-${d.reason}-${Math.floor(now / 3600000)}`,
          `Pool "${a.name}": ${why}.${alt} Conversations on it will hit a limit until a window resets, you add a member, or you move them off the pool.`, { level: 'warn' });
      }
      return;
    }
    // DWELL belt (2.266.1, real oscillation report): every switch cold-starts
    // the running sessions' prompt caches on BOTH accounts — expensive. After
    // any switch, further switches wait 3min unless the current target is
    // HARD-dead (<5%, genuinely unusable — escaping immediately is cheaper
    // than idling on a dead account). The settle-bar in decidePoolSwitch is
    // the primary anti-oscillation; this is the belt.
    const lastSwitch = _poolSwitchAt.get(poolId) || 0;
    if (now - lastSwitch < 180000 && !(d.fromRemaining != null && d.fromRemaining < POOL_HARD_PCT)) return;
    _poolSwitchAt.set(poolId, now);
    _poolAutoLast.set(poolId, now);
    accounts.setPoolTarget(poolId, d.to);
    // Re-attribute every live session on this pool from this moment — the
    // ledger's by-time attribution resolves pool → current target at record
    // time, so a fresh record moves subsequent requests to the new account.
    const affected = [];
    for (const [sid, s] of activeSessions) {
      if (s._accountId !== poolId) continue;
      // plan C: a session with its own link didn't move with the default —
      // restarting it for the pool-level switch would be the old collateral
      try { fs.lstatSync(accounts.sessionPoolLinkPath(poolId, sid)); continue; } catch { }
      try { recordUsageAttribution({ claudeSessionId: s.claudeSessionId || s.backendSessionId, accountId: poolId }); } catch {}
      affected.push({ serverId: sid, backend: s.backend || 'claude', backendSessionId: s.claudeSessionId || s.backendSessionId || null, cwd: s.cwd || null, name: s.name || null, host: s.host || null });
    }
    const fromPct = d.fromRemaining != null ? Math.round(d.fromRemaining) : null;
    serverNotice(`pool-auto-${poolId}-${now}`, d.reason === 'edf'
      ? `Pool "${a.name}" switched to ${d.toName} — draining the member whose weekly quota resets soonest (use-it-or-lose-it)`
      : `Pool "${a.name}" auto-switched to ${d.toName} (previous account down to ${fromPct}% remaining)${hot ? '' : ' — restarting its conversations'}`);
    console.log(`[pool] auto-switch ${poolId}: ${currentId} → ${d.to} (${d.reason}, from ${fromPct}% left, hot=${hot}, affected=${affected.length})`);
    if (!hot && affected.length) {
      // ONE client only — every client acting would race duplicate restarts.
      const payload = JSON.stringify({ type: 'pool-auto-switched', poolId, affected });
      for (const c of wss.clients) { if (c.readyState === WS_OPEN) { try { c.send(payload); } catch {} break; } }
    }
    // default-link sessions on a HOT switch: same c1206711 rule as the
    // per-session pass — an ARMED (limit-blocked, idle) session must be
    // nudged, a re-point alone never moves it.
    if (hot) for (const t of affected) { try { getAutoResume()?.fireNow?.(t.serverId, `账号池已切换到 ${d.toName || d.to}`); } catch { } }
  } catch (e) { console.warn('[pool] auto-switch check failed:', e.message); }
}
// Alias-tolerant model compare (server twin of the client's _modelMismatch):
// 'fable' vs 'claude-fable-5' is NOT a mismatch; [1m] suffixes ignored.
function modelsMatch(a, b) {
  if (!a || !b) return true;
  const core = (m) => String(m).toLowerCase().replace(/^claude-/, '').replace(/\s*\[1m\]$/, '').trim();
  const x = core(a), y = core(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}
// Per-conversation MODEL LOCK v2 (#6, semantics per the user's correction):
// fallback stays ALLOWED (the flagged turn completes on the fallback model),
// but at each turn end a locked session whose SERVED model drifted away is
// re-pinned via set_model — so every subsequent turn re-attempts the original
// model instead of staying degraded forever (switchModelsOnFlag switches the
// session's model persistently on a safety reroute; this undoes it per turn).
// The set_model echo ("Set model to …") lands in the chat as the visible trace.
function maybeRepinLockedModel(session) {
  try {
    if (!session._modelLocked || !session._lockedModel || !session.pty || session.mode !== 'chat') return;
    if (modelsMatch(session._servedModel, session._lockedModel)) return;
    const adapter = adapterRegistry.get(session.backend);
    if (!adapter?.formatSetModel) return;
    session.pty.write(adapter.formatSetModel(session._lockedModel) + '\n');
    global.__vsEvent?.('model-lock-repin', `${session._servedModel || '?'}->${session._lockedModel}`);
  } catch (e) { console.warn('[model-lock] repin failed:', e.message); }
}

function maybeStopOnFallback(session, id, from, to) {
  try {
    if (serverSetting('claude.disableModelFallback') !== true) return;
    if (session._fallbackStopFired || session.mode !== 'chat' || !session.pty) return;
    const adapter = adapterRegistry.get(session.backend);
    if (!adapter?.formatInterrupt) return;
    session._fallbackStopFired = true;
    session.pty.write(adapter.formatInterrupt() + '\n');
    adapter.postInterrupt(session, id);
    // Belt-and-braces: also disarm fallback in this CLI for the rest of the
    // session, so the next turn stops at the refusal instead of re-routing.
    try { if (adapter.formatSetFallbackPolicy) session.pty.write(adapter.formatSetFallbackPolicy(true) + '\n'); } catch {}
    global.__vsEvent?.('fallback-auto-stop', `${from || '?'}->${to || '?'}`);
    broadcastToSession(session, id, {
      type: 'server-notice', key: `fallback-stop:${id}:${Date.now()}`, level: 2,
      text: `Model fallback detected (${from || '?'} → ${to || '?'}) — turn stopped because "Disable model fallback" is on. Send a new message to continue on your model.`,
    });
  } catch (e) { console.warn('[fallback-stop] failed:', e.message); }
}

// SyncStore imported from ./src/sync-store.js

  return {
    _vsuPending, usageAnchors, usageEstimator,
    armWorkflowUsageWatcher, darkSources, darkTaintedAccounts, kickPoolEval,
    markLimitBanner, maybePoolAutoSwitch, maybePoolAutoSwitchForPool, notePoolAuthFailure,
    maybeRepinLockedModel, maybeStopOnFallback, modelsMatch,
    poolChooserForModel, poolReadCache, probeUsageForAccountKey,
    noteSessionProduced, noteTurnEnd, noteWallSignal, beforeAutoResumeFire, quotaVerdictFor, probeUsageViaSession, recordRateLimitEvent, recordCodexQuotaSignal, resolveUsageKey,
    probeQuotaForKey, quotaSourceFor, quotaBackendFor, // S4 caps-routed quota probe + the per-harness QuotaSignalSource lookup (functional seams for test-quota-source)
    observedMemberFor, sessionReadingMember, sessionBillingMember, wallKeyFor, fireIdentityFor, demoteWalledAccount, wallCount, sessionWalledMembers,
    _wallRing, _sessionWalls, OBSERVED_ORG_RECENT_MS, WALL_RING_MS, SESSION_WALL_MS, // wall-ground-truth + token-slot + session-wall seams (test-auto-resume §11, test-auto-resume-loop)
    _poolAutoLast, _poolSwitchAt, // the eval gate (10s) + dwell belt (180s) are WALL-CLOCK: a suite winds them back instead of sleeping through them
    sessionModelFor, sweepUsageAnchors, usageCacheKeyFor,
    usageIdentityAccountIds, usageIdentityGroups, usageIdentityGroupsCached,
    writeUsageCacheForKey, clearSealedOrders, pushSealedOrders,
    estOverlayCache, predictCalib,
  };
}
module.exports = { create };
