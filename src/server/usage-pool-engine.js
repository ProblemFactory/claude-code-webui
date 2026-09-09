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
  getUsageHistory, recordUsageAttribution, adapterRegistry, readUserState = () => ({}),
  // THE SPEND CEILING (design §4.4c / P9) is CONSTRUCTED here (`spendGuard`,
  // below) — the engine's own unattended spender, the codex reset credit, asks
  // that object directly. It deliberately takes NO authorizeSpend/noteSpend
  // deps: r2 found that server.js never passed them, so the gate on the reset
  // credit was dead code in production while a harness that DID pass them made
  // the suite green. A gate whose call site depends on a dep the one real
  // caller does not hand over is a gate nobody has.
  getUserTodos = () => null}) {
  // late-bound singletons: created after this module in boot order, used only
  // at runtime — the Proxy re-resolves per property access, never caches
  const accounts = mk(getAccounts);
  // conversation label for pool notices = the sidebar's name (custom rename in
  // user-state.json customNames), NOT the first-message name on the live
  // session object. readUserState() is cached in persistence, read per notice.
  const convName = (s2, sid) => { let cn = {}; try { cn = (readUserState() || {}).customNames || {}; } catch {} return conversationDisplayName(s2, cn, sid); };
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
const { decidePoolSwitch, rankPoolMembers, poolBlockedNotice, conversationDisplayName, SWITCH_THRESHOLD_PCT: POOL_HARD_PCT } = require('../account-pool-auto.js');
const arSignal = require('../auto-resume-signal.js'); // PURE: the limit LANE a snapshot is about + the fresh-window edge
// THE ONE READER of `cache.overage` (design §1.4: it was written by
// rate-limit-capture and read by nobody). PURE; the spend authorizer and
// the two panels ask the same function.
const { overageState } = require('../spend-authorizer.js');
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
// ── THE SLOT-TRANSITION LEDGER (2026-09-07) ────────────────────────────────
// A symlink has no history, so anything that arrives LATE (a reading whose
// fetchedAt is minutes old, a ledger bake, a migration) could not ask "which
// member was this conversation on THEN" and fell back to the spawn-time org.
// Every re-point now appends {sessionId, from, to, at, why} here, so the past
// is a lookup. Bounded + archive-never-destroy: src/slot-transitions.js.
const { SlotTransitions } = require('../slot-transitions.js');
// THE credential-state readers, BOTH of them (src/login-state.js documents the
// split): `loginState` answers for a credential SLOT — the file a re-pointed
// symlink hands a running CLI — and `accountLoginState` answers for an ACCOUNT,
// which is the same file OR a long-lived token (B-211a) delivered as spawn env.
// They are two questions, so the two callers differ: slot validation asks the
// first, anything reasoning about whether an ACCOUNT can serve a request asks
// the second.
const { loginState, accountLoginState } = require('../login-state.js');
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
const { loginUsable, loginBucketLabel, loginAgeText, loginWallPhrase } = require('../login-expiry.js'); // PURE: is this member's LOGIN SESSION still alive (2026-09-07)
const { UsageEstimator, overlayCache: estOverlayCache, predictCalib, CLAUDE_MAX_PRIOR_FULL_USD } = require('../usage-estimator.js');
const usageAnchors = new UsageAnchors({ dataDir: path.join(rootDir, 'data') });
// READ-ONLY view of the transition ledger. The single WRITER is accounts.js
// (every re-point goes through ensureSessionPoolLink / setPoolTarget — spawn,
// engine, manual route, signed-out self-heal, account removal), so no caller
// here can create a hole by forgetting to record one.
const slotTransitions = new SlotTransitions({ dataDir: path.join(rootDir, 'data') });
app.locals.slotTransitions = slotTransitions;
// ── WHOSE NUMBERS ARE THESE (inc-mts8a8mr-ulmm, 2026-09-08) ────────────────
// The slot rule of 2.369.68 is right and stays; what it could not know is that
// the link moves while requests are IN FLIGHT. The response itself names the
// WINDOW its numbers are counted in, and a weekly reset phase is an account
// fingerprint (measured: one stable phase per identity across this instance's
// whole 30-day corpus, all seven distinct). So the reading is asked which
// credentials produced it, and that answer outranks our bookkeeping.
// PURE rule + the statusline's verbatim mirror: src/reading-lag.js.
const readingLag = require('../reading-lag.js');
// THE ONE WRITE PATH (src/usage-cache-write.js): every usage-cache write in
// this file goes through it, so a reading merges into the file's typed
// `limits` PER limitId instead of replacing whatever the last producer left.
const usageWrite = require('../usage-cache-write.js');
const quotaModel = require('../quota-model.js');
const { familyOfScopedBucket } = require('../model-family.js');
const READING_ARCHIVE = path.join(rootDir, 'data', 'archive', 'readings-window-mismatch.ndjson');
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
    // A sealed order is executed by the DEVICE, possibly hours after we push
    // it and while this server is unreachable — a login that dies in the
    // meantime would be an unreachable fallback. Members near/past their
    // login deadline never enter the snapshot.
    readLogin: poolReadLogin(),
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
    // fallback switches executed while this server was down: surface them AND
    // RECORD THEM (2026-09-07 r2). The by-time attribution is only as honest
    // as the transition ledger, and a device-executed re-point that leaves no
    // row makes `slotAt()` answer with the last ORCHESTRATOR row — a
    // confident wrong answer about the exact window (server down) where late
    // attribution has nothing else to go on. accounts.js stays the single
    // writer; the event already carries every field it needs.
    for (const ev of events) {
      serverNotice('sealed-orders-' + ev.ts, `账号池 ${accounts.get(ev.poolId)?.name || ev.poolId} 在服务器离线期间因触限自动切换到 ${accounts.get(ev.to)?.name || ev.to}（sealed-orders 应急反射）`, { level: 'warn' });
      try { console.log('[sealed-orders] device-executed fallback switch:', JSON.stringify(ev)); } catch { }
      try { accounts.noteDeviceRepoint({ link: ev.link, poolId: ev.poolId, from: ev.from, to: ev.to, at: ev.ts, why: 'sealed-orders' }); } catch { }
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
// THE engine's login reader (2026-09-07). ONE memoized read per tick per
// member: loginStateOf hits the credential file, and a single pool decision
// asks about the same member several times. §ban-safety: file reads only —
// this whole feature never touches the network.
//
// IT ANSWERS FOR *BOTH* READERS (integration r2, reproduced). Two modules ask
// "is this login dead" from different angles and each sees a state the other
// misses:
//   · src/login-expiry.js (accounts.loginStateOf) — the refresh-token
//     DEADLINE. It calls a member with a live access token but a past
//     refreshTokenExpiresAt 'expired'; it says 'unknown' (= no claim) about a
//     file with no deadline at all.
//   · src/login-state.js (memberLoginState) — can a request be made RIGHT
//     NOW. It is the only one that catches "access token expired AND no
//     refresh token", which parseAuth still reports as loggedIn:true.
// The integration's first shape pre-FILTERED the second reader's verdict out
// of the candidate list before decidePoolSwitch ever saw it. That silently
// deleted the attribution master ships: `loginBlocked` (and therefore
// 'all-logins-expired' + "Re-login those accounts in Manage Agents") is built
// from the members the decision was SHOWN, so a member removed beforehand can
// never be named and the refusal degraded to a spent-quota sentence with the
// "wait for a window to reset" remedy — the exact defect 2.369.67 fixed.
// So the second verdict is FOLDED IN HERE, at the reader every gate already
// consults: identical exclusions (decidePoolSwitch's own login gate drops the
// member), restored naming (it drops it into loginBlocked on the way out).
// The hard pre-filter stays only where the list is ACTED on (healthyPoolMembers).
function poolReadLogin() {
  const memo = new Map();
  return (id) => {
    if (!memo.has(id)) {
      let st = null;
      try { st = accounts.loginStateOf(id); } catch { st = null; }
      // EITHER reader saying "unusable" is enough. Only ever a DOWNGRADE: a
      // file verdict never resurrects a login the deadline reader buried.
      try {
        const f = memberLoginState(id);
        if (f && !f.usable && loginUsable(st)) {
          const now = Date.now();
          st = {
            state: f.state === 'expired' ? 'expired' : 'logged-out',
            refreshExpiresAt: f.refreshExpiresAt ?? null,
            accessExpiresAt: f.expiresAt ?? null,
            // the file reader's `since` IS the instant it stopped working, so
            // msLeft stays a coherent (negative) number instead of the
            // deadline reader's stale "30 days left" under an 'expired' state
            msLeft: typeof f.since === 'number' ? f.since - now : (typeof f.refreshExpiresAt === 'number' ? f.refreshExpiresAt - now : null),
          };
        }
      } catch { }
      memo.set(id, st);
    }
    return memo.get(id);
  };
}
// ── THE SPEND CEILING, CONSTRUCTED (design-account-hardening §4.4c / P9) ────
// It lives here because every input it needs is already resolved in this
// module — the identity (`fireIdentityFor`, this file's own answer to "which
// credential slot would a turn started right now bill"), the RAW usage cache
// (overage), and the credential state the pool already reads. A second
// construction site would mean a second set of answers, which is exactly the
// failure §2 of the design catalogues. server.js re-exports it to the three
// consumers outside this module (auto-resume, the delivery ladder, the Stop
// nudge); the inbox is resolved lazily because it is created later in boot.
const spendGuard = require('./spend-guard.js').create({
  dataDir: path.join(rootDir, 'data'),
  serverSetting,
  identityOf: (session) => fireIdentityFor(session),
  readCacheFor: (key) => readRawUsageCache(key),
  // the ACCOUNT reader, not the slot one — an oat-only subscription serves
  // turns with no credential file at all (see accountCredentialState)
  credentialStateOf: (key) => accountCredentialState(key),
  getUserTodos,
  log: (...a) => console.log(...a),
});

// ── THE TWO VOLUNTARY-MOVE BARS (design-account-hardening D2 + D3c) ─────────
// Both are SETTINGS resolved per decision and handed to the PURE decision as
// inputs; neither changes what an ESCAPE from a hard-dead member may do.
//   reserveFloorPct  — EDF drains the soonest-deadline member, and the measured
//                      result was 60% → 95% of a weekly window in 12.4 hours.
//                      Below the floor a member is not a voluntary target.
//   avoidOverageMembers — while `cache.overage.inUse` is true the account bills
//                      pay-per-use, so `utilization` stays under 1 while every
//                      token costs money and EDF actively PREFERS it. Default
//                      OFF (D3 recommends one week of data first); the SPEND
//                      side of the same fact is always on (the authorizer).
function reserveFloorPct() {
  const n = Number(serverSetting('pool.reserveFloorPct'));
  return Number.isFinite(n) && n >= 0 ? Math.min(100, n) : 15;
}
/** The RAW usage cache for one key — no estimator overlay. The overage record
 *  is a fact a producer STATED; an estimate may not authorize an irreversible
 *  act (P7), and it may not bar one either. */
function readRawUsageCache(id) {
  try { return JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, String(id).replace(/[^\w.-]/g, '_') + '.json'), 'utf-8')); }
  catch { return null; }
}
function overageMemberIds(members) {
  try {
    if (serverSetting('pool.avoidOverageMembers') !== true) return null;
    const out = new Set();
    for (const m of members || []) if (overageState(readRawUsageCache(m.id)).inUse === 'yes') out.add(m.id);
    return out.size ? out : null;
  } catch { return null; }
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
    const mem = healthyPoolMembers(poolId);
    const d = decidePoolSwitch({ currentId: cur, members: mem, readCache, nowSec: Date.now() / 1000, hot: true, readLogin: poolReadLogin(), reserveFloorPct: reserveFloorPct(), overageIds: overageMemberIds(mem) });
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
      // THE CREDENTIAL SLOT, for VALUES too (2026-09-07 — the second half of
      // the same correction that moved rejections off the observation).
      // A utilization number does describe whatever token produced it; the
      // refuted step was believing OTel's organization.id NAMES that token.
      // It names the identity the CLI cached at SPAWN, while the credential
      // file it re-reads (mtime-gated, 2.1.257 rpe()) is the link's — so
      // "follow the observation" filed every hot-switched session's readings
      // under the account it started on. The link, slot-validated, is the
      // only identity we can actually prove is being read.
      acct = sessionBillingMember(session, acct).id || acct;
    }
  } catch {}
  // The two CLIs' machine logins are DIFFERENT identities and always were —
  // the ledger has keyed them apart since P1 (`ev.be === 'codex' ?
  // '__global_codex__' : '__global__'`). A bare '__global__' here sent an
  // account-less codex session's readings into the CLAUDE global identity;
  // it only stayed invisible because the codex producers carried their own
  // key resolver. Now that ONE reading resolver serves both, it must know.
  return acct || (session?.backend === 'codex' ? '__global_codex__' : '__global__');
}
function writeUsageCacheForKey(key, parsed) {
  try {
    const f = path.join(USAGE_CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
    let prev = {}; try { prev = JSON.parse(fs.readFileSync(f, 'utf-8')) || {}; } catch {}
    const merged = { ...prev, ...parsed };
    // PROVENANCE IS NOT PRESERVED (2026-09-07 r2, reproduced): `corroborated`
    // is a verdict about ONE write — did the OTel observation agree with the
    // credential slot THAT reading was filed on. A preserve-merge inherits
    // whatever the previous producer decided, so a probe/panel result written
    // over a diverged rate_limit_event rendered as "via own /usage panel · not
    // corroborated": an old verdict attached to a reading it does not
    // describe (and, for a session-less producer, one there is nothing to
    // corroborate WITH). captureRateLimitEvent and markLimitBanner already
    // delete-or-set it per write; every preserve-merge writer must too.
    if (parsed.corroborated === undefined) delete merged.corroborated; else merged.corroborated = !!parsed.corroborated;
    // preserve-merge like the statusline hook: never clobber known scoped/org
    // data with an empty answer
    if ((!parsed.scopedWeekly || !parsed.scopedWeekly.length) && Array.isArray(prev.scopedWeekly) && prev.scopedWeekly.length) {
      merged.scopedWeekly = prev.scopedWeekly; merged.scopedFetchedAt = prev.scopedFetchedAt;
    }
    for (const k of ['orgUuid', 'orgName', 'orgEmail', 'email', 'name']) if (prev[k] !== undefined && merged[k] === undefined) merged[k] = prev[k];
    delete merged.limits; // the canonical half is the write path's to compute, never inherited whole from `prev`
    return usageWrite.writeCacheObject({ cacheDir: USAGE_CACHE_DIR, key, obj: merged, source: parsed.source || null, familyOf: familyOfScopedBucket, backend: 'claude' }).ok;
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
      // the ANSWER comes from a live session's CLI, so it is the credentials
      // that session holds that produced it — the ⟳ target is only who we
      // ASKED about (guard ② decides who it is written for)
      if (parsed) {
        const target = guardReadingTarget(key, readingLag.windowOf(parsed), { session: s, what: 'control:get_usage', entry: parsed });
        if (target) writeUsageCacheForKey(target, parsed);
      }
      return parsed;
    });
  }
  return Promise.resolve(null);
}
app.locals.usageIdentityAccountIds = usageIdentityAccountIds;

// ── THE ESTABLISHED WINDOW of every account we could file a reading on ──────
// It is STAMPED AT THE WRITE by the ONE producer whose key and whose credential
// dir are the SAME decision — refreshViaCliPanel's `claude -p /usage`
// (usage-routes.js says so in its own header). It is deliberately NOT inferred
// from whatever the last write left in `sevenDay.resetsAt`: that field is
// exactly what a mis-filed reading overwrites, so reading the window back out
// of it would let one bad write redefine the account and immunise every later
// one. A member with no established window simply has none, and the guard
// stays inert for it — no evidence, no refusal.
//
// IT LIVES IN A SIDECAR, NOT IN THE SNAPSHOT (r2, reproduced end to end). It
// was a field of the usage-cache object, which EVERY reading producer rewrites
// wholesale — and the highest-frequency one of all, the shipped statusline hook
// (once per 8 s per account), rebuilds that object from a literal that
// preserves scopedWeekly / the org identity / spend one field at a time. The
// window was never added to that list, so ONE legitimate statusline render
// deleted every established window on the instance, `windows` went empty, the
// guard degraded to "no established window to contradict", and the incident
// replayed with its second false pool switch. Two more writers (the bare-token
// ⟳ and the codex snapshot) clobber the same way. A hand-written preserve list
// is what failed — five times on this one file — so the fact a reading producer
// may not state no longer lives where a reading producer writes.
// Keyed off the CACHE FILES, so a sidecar left behind by a removed account is
// invisible and can never become a re-file target.
// Memoised for one tick of the producers (a turn writes ~20 readings and each
// would otherwise re-read every sidecar).
const OWN_WINDOW_TTL_MS = 5000;
let _ownWinAt = 0, _ownWin = null;
function establishedWindows() {
  const now = Date.now();
  if (_ownWin && now - _ownWinAt < OWN_WINDOW_TTL_MS) return _ownWin;
  const out = {};
  let files = [];
  try { files = fs.readdirSync(USAGE_CACHE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('__models__')); } catch { }
  for (const fn of files) {
    const key = fn.slice(0, -5);
    try {
      const w = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, readingLag.windowSidecarName(key)), 'utf-8'));
      if (w && (w.sevenDay || w.fiveHour || (w.scoped && Object.keys(w.scoped).length))) out[key] = w;
    } catch { }
  }
  _ownWin = out; _ownWinAt = now;
  return out;
}
/** The identity GROUP a cache key belongs to, as ONE representative — an
 *  org-merged login spans '__global__' + the named sub and must never read as
 *  two different accounts matching one window. */
function windowGroupOf(id) { try { return usageIdentityAccountIds(id).slice().sort()[0] || id; } catch { return id; } }

/** ② THE WINDOW IDENTITY GUARD, the ONE place every value producer asks
 *  "may this reading be written for this member". Returns the key to write on,
 *  or null when the reading is archived instead.
 *
 *  DELIBERATELY NOT ON THE WALL / BANNER MARKS: those carry no window of their
 *  own (the banner is a BOOLEAN by owner ruling — never parse text for times —
 *  and the wall's `resetsAt` is often a bounded GUESS, `nowSec + 24h`). A guess
 *  compared against a real window is 'differ' every time, so guarding them
 *  would archive every exhaustion mark on the instance. Their identity has its
 *  own protection: the turn-pinned rejection slot plus `slotOk`. */
function guardReadingTarget(key, readingWindow, { session = null, what = 'reading', entry = null } = {}) {
  let d;
  try {
    d = readingLag.decideReadingTarget({ key, readingWindow, windows: establishedWindows(), groupOf: windowGroupOf });
  } catch (e) { console.warn('[usage] window guard failed (writing as asked):', e.message); return key; }
  if (d.action === 'write') return key;
  const sid = session?._webuiId || session?.claudeSessionId || '-';
  if (d.action === 'refile') {
    noteWindowVerdict(sid, key, d.key, () => console.log(`[usage] ${what}: window says these numbers are ${nameOf(d.key)}'s, not ${nameOf(key)}'s — re-filed (${d.reason})`));
    global.__vsEvent?.('usage-reading-window-refiled', `${key}→${d.key}:${what}`);
    return d.key;
  }
  noteWindowVerdict(sid, key, 'archive', () => console.log(`[usage] ${what}: refusing to write ${nameOf(key)} a reading from another window — archived (${d.reason})`));
  global.__vsEvent?.('usage-reading-window-archived', `${key}:${what}`);
  try {
    fs.mkdirSync(path.dirname(READING_ARCHIVE), { recursive: true });
    // BOUNDED, and the roll is APPENDED under a per-DAY name: an account whose
    // weekly window genuinely moved keeps producing mismatches until its next
    // panel refresh re-establishes it, ~20 readings a turn. A Date.now()-named
    // shard would let two rolls inside one millisecond overwrite each other —
    // the slot-transition ledger's own lesson (an archive that loses what it
    // exists to preserve is worse than no archive).
    try {
      if (fs.statSync(READING_ARCHIVE).size > 5 * 1024 * 1024) {
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        fs.appendFileSync(READING_ARCHIVE.replace(/\.ndjson$/, `-${day}.ndjson`), fs.readFileSync(READING_ARCHIVE));
        fs.writeFileSync(READING_ARCHIVE, '');
      }
    } catch { }
    // the TARGET'S established window rides along with its own age: a reading
    // archived because the account's window genuinely moved (a plan change) is
    // told apart from a mis-filed one by how stale `ownWindow.at` is, and that
    // is the whole diagnosis a human needs from the archive line
    fs.appendFileSync(READING_ARCHIVE, JSON.stringify({ at: Date.now(), store: 'usage-cache', key, sid, what, reason: d.reason, matched: d.matched, ownWindow: establishedWindows()[key] || null, entry }) + '\n');
  } catch { }
  return null;
}
// one line per session per (target → verdict) transition: a switching pool
// re-decides every few seconds and a per-record line would be the log
const _windowVerdictAt = new Map();
function noteWindowVerdict(sid, from, to, say) {
  const k = `${sid}:${from}:${to}`;
  if (_windowVerdictAt.get(sid) === k) return;
  _windowVerdictAt.set(sid, k);
  if (_windowVerdictAt.size > 512) _windowVerdictAt.delete(_windowVerdictAt.keys().next().value);
  try { say(); } catch { }
}

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
// misattributed the HOST's quota to the LOCAL machine login. (That sentence
// was written when only claude existed here; it is made exact below.)
// THE HOST BUCKET IS THE CLAUDE MACHINE LOGIN'S PER-HOST FORM (2026-09-07 r2,
// reproduced): `host-<id>.json` has exactly ONE meaning everywhere it is read
// or written — that host's own CLAUDE login (usage-routes seeds `_hostUsage`
// from it, the remote statusline harvest writes the host's `__global__` into
// it, the on-demand ⟳ overwrites it with an OAuth panel, the Agents machine
// rows render it). Codex's machine identity is NOT host-scoped: its own
// resolver (`codexQuotaKeyFor`, still the twin `noteWallSignal` uses) has
// always answered '__global_codex__' for an account-less session, and the
// codex panel only seeds files matching /^(cxs-…|__global_codex__)\.json$/.
// The pre-r2 rule keyed on "remote AND no account", so the moment readings and
// rejections began sharing ONE resolver it became the route by which a REMOTE
// codex session's rate_limits_updated snapshot overwrote the host's claude
// numbers — and disappeared from codex's own panel.
// Written as a TRANSFORM OF THE ANSWER rather than a backend test: whatever
// machine identity resolveUsageKey names, only `__global__` (the claude
// machine login) has a per-host form. An account-billed session never resolves
// to it, so "no account" is implied; every other machine identity — codex's
// today, a future harness's tomorrow — passes through untouched.
function usageCacheKeyFor(session) {
  const key = resolveUsageKey(session);
  return (session?.host && key === '__global__') ? 'host-' + session.host : key;
}
// Passive quota capture from the CLI's own rate_limit_event records (B-e5c9,
// 2.289.0) — ONE shared implementation (src/rate-limit-capture.js) for local
// AND remote chat sessions; the caller resolves key/identity as parameters.
// ── THE OBSERVATION IS CORROBORATION, NEVER THE KEY (2026-09-07) ───────────
// REFUTED AND REMOVED: `orgVerifiedKey(session, key, what)`. B-b3cd's premise
// was "a hot-switched pool session keeps its old token for ≥25min, so its
// quota signals describe the OLD org's buckets" — and its fix re-attributed
// every reading to the OTel-observed org. The owner's post-mortem killed the
// premise for BLOCKING on 2026-09-07 (2.369.66) and for VALUES with the same
// evidence: `organization.id` is the identity the CLI cached in its config
// dir at SPAWN, and the credential file IS re-read on an mtime bump, which is
// precisely what the pool's re-point does. So the rule filed a session's
// readings under the account it was SPAWNED on for the rest of its life. On
// this instance that meant a member whose login had been WIPED on 09-02 kept
// receiving limit-banners and Fable-bucket readings until 09-07, and — the
// silent half — a Fish-billed session spawned under B-Stack filed Fish's
// numbers under B-Stack, poisoning both panels, both anchor streams and the
// learned rates.
// What replaces it: readingSlotFor() (the validated credential slot, pinned
// for the turn). What survives: this — the divergence is LOGGED and
// telemetered, so a disagreement is still visible and still investigable; it
// simply never decides where a number lands.
function corroborateReading(session, key, what) {
  try {
    const obs = getOtelIngest()?.observedOrgFor?.(session?.claudeSessionId);
    if (!obs || !obs.acct || Date.now() - (obs.ts || 0) >= OBSERVED_ORG_RECENT_MS) return null;
    const members = usageIdentityAccountIds(key) || [];
    if (members.includes(obs.acct)) return { agree: true, observed: obs.acct };
    // one line per session per 10min (the same floor noteDivergence uses)
    const sid = session?._webuiId || session?.claudeSessionId || '?';
    const now = Date.now();
    if (now - (_readingDivergeAt.get(sid) || 0) > 10 * 60e3) {
      _readingDivergeAt.set(sid, now);
      console.log(`[usage] ${what}: filed on the credential slot ${nameOf(key)} while OTel last observed ${nameOf(obs.acct)} (spawn-time identity — corroboration only)`);
    }
    global.__vsEvent?.('usage-reading-observation-diverged', `${what}:${key}≠${obs.acct}`);
    return { agree: false, observed: obs.acct };
  } catch { return null; }
}
const _readingDivergeAt = new Map(); // sid → last corroboration log
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
// REFUTED AND REMOVED (2026-09-07): `sessionReadingMember` — "the observed
// member when the OTel truth names one, else its link". There is no longer a
// reading member DIFFERENT from the billing member: both questions have the
// same answer, the validated credential slot, because that is the only
// identity we can prove the process is reading. Keeping two functions was the
// bug's home — one of them had to be wrong, and the one that was wrong owned
// every VALUE on the instance. `sessionBillingMember` is now THE resolver;
// `observedMemberFor` survives as corroboration.
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
    // poolMembers() filters by `loggedIn`, which is a BOOLEAN over four
    // different credential states — 2.369.66 read that as "a separate
    // credentials leg is unsatisfiable". It is not: `loggedIn` is TRUE for a
    // login whose access token AND refresh token have both expired
    // (parseClaudeAuth only nulls the accessToken field), so that member stays
    // a candidate and a slot pointing at it validates. That is a satisfiable
    // gap and it is the one that lets dead-account readings look authorised —
    // hence the explicit state leg below, ONE implementation shared with the
    // panels and the migration (src/login-state.js).
    if (!(accounts.poolMembers(poolId) || []).some((m) => m.id === linkedId)) return { ok: false, reason: 'slot-not-a-member' };
    const st = memberLoginState(linkedId);
    if (st && !st.usable) return { ok: false, reason: 'slot-' + st.state }; // slot-wiped / slot-expired / slot-missing / slot-unreadable
  } catch { return { ok: false, reason: 'slot-unreadable' }; }
  return { ok: true, reason: null };
}
/** The credential state of one CLAUDE account key (src/login-state.js — the
 *  shared reader; also what the panels and the migration read, one
 *  implementation).
 *  DELIBERATELY THE FILE, NOT THE ACCOUNT (2026-09-07 r2): the panels and the
 *  repair ask `accountLoginState`, which also counts a long-lived token — but
 *  this function answers "does the credential SLOT hold credentials", and a
 *  pooled session's CLI reads whatever the SYMLINK points at. An oat lives in
 *  accounts.json and is delivered as spawn ENV; re-pointing a link can never
 *  hand it to a running CLI, so for a slot the file is the whole answer.
 *  Making this one oat-aware would make a wiped member a valid switch target.
 *  null = "no opinion": a pseudo key ('__global__', 'host-…'),
 *  a codex account (its slot machinery does not exist — capsOf('codex')
 *  .hotSwitch is 'impossible', so there is no re-point to be wrong about), or
 *  an unreadable roster.
 *  MEMOIZED ON THE FILE, NOT ON A CLOCK: per-record producers must not re-read
 *  and re-parse on every reading, but a TIME box would keep answering "signed
 *  out" for N seconds after a re-login — and this answer gates switch targets
 *  and the panel's warning. The stat is the cheap half; keying on mtime+size
 *  makes a credential change visible on the very next call. */
const _loginStateMemo = new Map();
function memberLoginState(id) {
  if (!id || typeof id !== 'string' || !/^sub-/.test(id)) return null;
  let fp = null;
  try {
    if ((accounts.get(id)?.backend || 'claude') !== 'claude') return null;
    fp = accounts.subCredsPath(id);
  } catch { return null; }
  let sig = 'none';
  try { const st = fs.statSync(fp); sig = `${st.mtimeMs}:${st.size}`; } catch { }
  const hit = _loginStateMemo.get(id);
  if (hit && hit.sig === sig) return hit.st;
  let st = null;
  try { st = loginState(fp, { backend: 'claude' }); } catch { st = null; }
  _loginStateMemo.set(id, { sig, st });
  if (_loginStateMemo.size > 256) _loginStateMemo.delete(_loginStateMemo.keys().next().value);
  return st;
}
/** THE credential state of one claude ACCOUNT — the file OR a valid long-lived
 *  token (B-211a). This is the reader for "can this identity serve a request
 *  right now", which is what the SPEND CEILING asks about a session that is
 *  already running.
 *
 *  NOT `memberLoginState` (r2, reproduced): that one answers for a credential
 *  SLOT, and it is deliberately oat-blind because re-pointing a symlink can
 *  never hand a token to a running CLI. Asking it about an ACCOUNT gives the
 *  wrong answer for an `oatOnly` subscription — a supported, spawnable
 *  configuration with NO credential file on disk (`resolveForSpawn` returns
 *  `{oatOnly:true, localEnv:{CLAUDE_CODE_OAUTH_TOKEN}}`) — which the file
 *  reader calls 'missing'/unusable. Every unattended producer was then refused
 *  on it FOREVER, with a reason ("cannot authorize a request right now") that
 *  is factually false about an account serving turns normally, and unlike the
 *  hour/day caps that refusal never expires.
 *  null = no opinion (a pseudo key, a codex account, an unreadable roster) —
 *  P6: ignorance is not a claim, and the authorizer treats null as 'unknown'. */
function accountCredentialState(id) {
  if (!id || typeof id !== 'string' || !/^sub-/.test(id)) return null;
  let fp = null, minted = null;
  try {
    const a = accounts.get(id);
    if (!a || (a.backend || 'claude') !== 'claude') return null;
    fp = accounts.subCredsPath(id);
    minted = Number(a.oatMintedAt) || null;
  } catch { return null; }
  try { return accountLoginState(fp, { oatMintedAt: minted, backend: 'claude' }); } catch { return null; }
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
/** THE identity a REJECTION belongs to, resolved NOW: the credential slot this
 *  session's CLI reads, and whether that slot VALIDATED. Pooled ⇒ the validated
 *  link member; otherwise the session's own account/host key (fixed at spawn,
 *  so trivially its own slot). Deliberately NOT orgVerifiedKey — see the header
 *  note. `slotOk` travels ON THE SIGNAL because it is only true AT THE MOMENT
 *  THE REJECTION ARRIVES: by the time the turn ends the pool has usually
 *  re-pointed the link off the account that just refused us.
 *  A rejection RECORD does not call this directly — it calls rejectionSlotFor
 *  (turn-pinned) below; this stays the fresh reading for "where would a fire
 *  land right now" (fireIdentityFor) and for the demotion's fallback. */
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
/** THE identity a rejection RECORD is attributed to — `wallSlotFor` PINNED FOR
 *  THE TURN (2026-09-07 r3; reproduced on the real engine before it was
 *  fixed).
 *  ONE rejection reaches us as SEVERAL records: the CLI's `rate_limit_event`,
 *  the assistant limit banner, and a banner inside a task_notification (three
 *  independent producers — src/server/stdout/claude-stream-json.js :323/:328/
 *  :563 — and noteWallSignal's own comment already says a banner + its rejected
 *  event are ONE wall). The FIRST of them re-points the link BY ITSELF: every
 *  producer calls maybePoolAutoSwitch the moment it marks the cache. Resolving
 *  the slot per RECORD therefore keyed the second one to the member the pool
 *  had just moved TO — and the wall machine then demoted that healthy member
 *  with `credential slot` authority and recorded it as having rejected this
 *  conversation: the exact misattribution this whole change exists to remove
 *  (measured, both producer orders: after a fresh reading showing the moved-to
 *  member 95% healthy the session waited ~2h instead of continuing in ~60s).
 *  The pin is THE TURN, not a time window, because that is what defines it: a
 *  pool re-point does not reach a RUNNING CLI (2.361.0 — a process kept billing
 *  its original org for 35 minutes across four switches), so every rejection
 *  inside one turn came from the credentials the slot named when that turn's
 *  first rejection arrived. `_turnWallSigs` is cleared by noteTurnEnd, so the
 *  pin is exactly one turn wide; a turn whose end record never arrives degrades
 *  exactly the way the wall machine already does (the next turn's real work
 *  classifies it NORMAL and clears the signals).
 *  `slotOk` rides the pin for the same reason it rides the signal: it is only
 *  true AT THE MOMENT THE REJECTION ARRIVED. */
function rejectionSlotFor(session) {
  try {
    const first = ((session && session._turnWallSigs) || []).find((s) => s && s.key);
    if (first) return { key: first.key, slotOk: !!first.slot, slotReason: 'turn-pinned' };
  } catch { }
  return wallSlotFor(session);
}
/** THE identity a quota READING is attributed to — ONE function for every
 *  value producer (rate_limit_event readings, limit-banner marks, the codex
 *  rate_limits_updated snapshot, and any future one). It is `wallSlotFor`'s
 *  twin and deliberately shares its body: a reading and a rejection are facts
 *  about the SAME thing, the credential slot the CLI is reading, and the
 *  entire 2026-09-07 incident is what happens when the two are resolved
 *  differently (the rejection landed on the slot while the numbers landed on
 *  the spawn-time org, so the account that was actually being burned looked
 *  healthy forever and a member wiped five days earlier kept "reporting").
 *
 *  PINNED FOR THE TURN, refreshed at the turn boundary, for the same reason
 *  rejectionSlotFor is: every producer calls maybePoolAutoSwitch the moment it
 *  writes, so one turn's ~20 readings would otherwise be split across the
 *  members our own re-points moved to WHILE they were arriving — numbers
 *  credited to an account that had not served a single request of that turn.
 *  A re-point reaches the running CLI on its NEXT request (mtime-gated
 *  re-read), never the reading already in flight; noteTurnEnd clears the pin,
 *  so a switch is honoured exactly one turn later, which is when it is true.
 *
 *  `slotOk` rides along (same meaning as on a rejection: the link resolved to
 *  a validated, credential-holding member of this pool AT THIS MOMENT). It is
 *  never a veto here — a reading with an unvalidated slot is still filed on
 *  the slot, because the alternative is filing it somewhere we can prove is
 *  wrong; it is carried so the panels can say how sure we are.
 *
 *  SHARED DEPENDENCY, stated so nobody has to rediscover it: both pins live
 *  exactly as long as `noteTurnEnd` says a turn does (claude `result` /
 *  codex task_complete|task_failed / the ACP turn end — one call site per
 *  stdout consumer). A turn whose end record never arrives holds its pin, and
 *  a reading pin held that way keeps filing on a member the pool may have
 *  left. That is the SAME degradation the rejection pin already accepts, and
 *  it is deliberately not bounded differently: giving the twins different
 *  lifetimes would re-create the two-answers-one-question shape this change
 *  exists to remove, and a time box would be a cliff (2.369.63's lesson). If
 *  this ever needs a belt, it belongs on noteTurnEnd — one bound, both pins. */
function readingSlotFor(session, at = Date.now(), opts = {}) {
  try {
    const pin = session && session._turnReadingSlot;
    if (pin && pin.key) return { key: pin.key, slotOk: !!pin.slotOk, slotReason: 'turn-pinned', at: pin.at };
  } catch { }
  const fresh = wallSlotFor(session);
  let key = fresh.key, slotOk = !!fresh.slotOk, slotReason = fresh.slotReason, shadow = null;
  // ① THE LAG SHADOW composes with the pin, and it is applied BEFORE the pin is
  // set, so a pin created by a shadowed reading pins the PREVIOUS slot — the
  // whole turn then bills where its requests actually went.
  if (opts.window && key) {
    shadow = lagShadowFor(session, key, opts.window, opts.fingerprint || null, at);
    if (shadow && shadow.shadowed) {
      key = shadow.key;
      slotReason = 'lag-shadow:' + shadow.why;
      try { slotOk = !!validateBillingSlot(session?._accountId || null, key).ok; } catch { slotOk = false; }
    }
  }
  const out = { key, slotOk, slotReason, at, ...(shadow && shadow.shadowed ? { shadowed: true } : {}) };
  try { if (session && out.key) session._turnReadingSlot = { key: out.key, slotOk: out.slotOk, at }; } catch { }
  return out;
}
/** The evidence `decideLagShadow` needs, gathered from the two stores that
 *  hold it: the transition ledger (which slot did this conversation LEAVE, and
 *  how long ago) and the established windows. `_lastReadingFp` is the server's
 *  twin of the statusline's `.slot-<id>` sidecar — the last window fingerprint
 *  we saw under a given key, which is the only evidence left when two members
 *  share a weekly phase or neither window is known. */
function lagShadowFor(session, freshKey, readingWindow, readingFingerprint, at) {
  try {
    const poolId = session?._accountId || null;
    if (!poolId || accounts.get(poolId)?.type !== 'pooled') return null;
    const sid = session?._webuiId || null;
    // WHICH ROWS DECIDE FOR THIS CONVERSATION — the ledger's own contract: a
    // session that has its own link is decided by its OWN rows and the pool
    // default is irrelevant to it; one without a link is decided by the
    // default. Deciding on "whichever row is newest" would let another
    // session's pool-wide move explain a reading it had nothing to do with.
    const hasOwnLink = (() => { try { fs.lstatSync(accounts.sessionPoolLinkPath(poolId, sid)); return true; } catch { return false; } })();
    // BOUNDED SCAN: rows are ascending, so walking back and stopping at the
    // shadow horizon is O(the last 10 minutes), not O(the whole 20k ledger) on
    // every reading — and a row older than the horizon could not shadow anyway.
    const rows = slotTransitions.all();
    let row = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.at > at) continue;
      if (at - r.at > readingLag.SHADOW_MS) break;
      if (poolId && r.poolId && r.poolId !== poolId) continue;
      if (hasOwnLink ? (sid && r.sessionId === sid) : !r.sessionId) { row = r; break; }
    }
    if (!row || !row.from || row.from === row.to) return null;
    const windows = establishedWindows();
    const last = session._lastReadingFp && session._lastReadingFp.key === row.from ? session._lastReadingFp.fp : null;
    const d = readingLag.decideLagShadow({
      prevKey: row.from, prevWindow: windows[row.from] || null,
      newKey: freshKey, newWindow: windows[freshKey] || null,
      readingWindow, readingFingerprint, prevFingerprint: last,
      repointAgeMs: at - row.at,
    });
    // THE FIRST READING WHOSE FINGERPRINT DIFFERS ENDS THE SHADOW, and it stays
    // ended: once the new credentials have demonstrably answered once, a later
    // in-flight straggler is not evidence that they have not.
    if (session._readingShadowEndedAt === row.at) return { key: freshKey, shadowed: false, why: 'shadow-ended' };
    if (!d.shadowed) session._readingShadowEndedAt = row.at;
    // A SHADOW MOVES MONEY, SO IT SAYS SO. One line per session per (target →
    // verdict) transition, the same floor the guard uses: the incident's whole
    // diagnosis was "which account did this number go to, and why", and the
    // journal had nothing to say about the write that caused it.
    if (d.shadowed) {
      noteWindowVerdict(sid || '-', freshKey, 'shadow:' + row.from, () => console.log(
        `[usage] reading arrived ${Math.round((at - row.at) / 1000)}s after the link moved to ${nameOf(freshKey)}, carrying ${nameOf(row.from)}'s window — filed on ${nameOf(row.from)} (${d.why})`));
      global.__vsEvent?.('usage-reading-lag-shadow', `${freshKey}→${row.from}:${d.why}`);
    }
    return d;
  } catch (e) { console.warn('[usage] lag-shadow check failed (keeping the slot):', e.message); return null; }
}
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
    // A member whose LOGIN SESSION is over cannot serve a turn however much
    // quota its cache shows — and unlike a quota wall this one does NOT heal
    // on a timer, so it contributes NO blockedUntil: only the user's re-login
    // unblocks it (2026-09-07 login expiry). Judged before the wall override
    // because it is the more fundamental refusal AND the actionable one.
    const readLogin = poolReadLogin();
    const walled = session ? sessionWalledMembers(session._webuiId) : new Set();
    const verdicts = ordered.map((m) => {
      const v = quotaVerdict(proj(read(m.id)), nowSec);
      const li = readLogin(m.id);
      if (!loginUsable(li)) return { id: m.id, name: m.name || m.id, v: { ...v, usable: false, blockedUntil: 0, reason: `${loginBucketLabel(li)} — re-login needed` } };
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
  // THE LIMIT LANE (2026-09-08): which of the harness's windows this wall is
  // about — the harness's own `snapshot.limitId`, null when it has one lane
  // (claude). The armed wait carries it so the fresh-window edge can tell a
  // reading about THIS wall from a reading about a sibling lane: a codex login
  // reports `codex` and `codex_bengalfox` minute by minute on the same account,
  // and the spark lane read 0 % for the whole 32 h the plan lane was spent.
  sigs.push({ at: Date.now(), resetsAtMs: Number(sig.resetsAtMs) || 0, bucket: sig.bucket || null, scopedName: sig.scopedName || null, key, slot: !!sig.slot, lane: sig.lane || null });
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
  // the READING pin dies with the turn for exactly the reason the rejection
  // pin does: a re-point reaches the running CLI on its next request, so the
  // next turn is the first one it can be true for (readingSlotFor)
  session._turnReadingSlot = null;
  // …and so does the proven re-file this turn's rejection records established —
  // but only AFTER the demotion below, which is its LAST READER: the turn-end
  // pass asks the same proof for every signal that carries no window of its
  // own, so clearing it here (where the other two pins die) silently put the
  // banner's mark back on the member this turn had just proved innocent.
  const clearRefile = () => { session._turnWallRefile = null; };
  if (sigs.length && workAfter <= 1) {
    // BLOCKED entry owns this turn's pool evaluation (B-2c9b): it runs AFTER
    // the demotion + the arm, so the link moves in the same tick and a hot
    // switch's fireNow() finds the session armed
    try { onWalledTurn(session, sigs); } catch (e) { console.warn('[wall] blocked-entry failed:', e.message); }
    clearRefile();
    return;
  }
  clearRefile();
  maybePoolAutoSwitch(session); // the per-turn pool evaluation this boundary always ran
  // a normally-completed turn is sufficient proof the session is not blocked —
  // and it is WORK (the default classification), so it is one of the only two
  // signals allowed to clear the loop breaker (round 4); a continue that
  // actually landed reaches this same line as its own turn's result
  try { getAutoResume()?.noteRecovered?.(session._webuiId, 'turn completed normally'); } catch { }
}

/** A QUOTA READING ARRIVED FOR THIS SESSION — the harness-neutral half of the
 *  2026-09-08 incident. Two facts, and which one applies depends only on
 *  whether the session is WAITING:
 *   · not waiting → the pre-existing disarm (`worked:false`: a passive reading
 *     says a bucket has room and NOTHING about whether this conversation
 *     produced anything, so it may drop a timed wait but never clear the loop
 *     breaker — round 4 of the 130-fire incident). Unarmed this is a no-op,
 *     which is what it always was.
 *   · waiting → THE FRESH-WINDOW EDGE. The old code disarmed here too, and for
 *     claude that was invisible: claude only emits readings while a turn is
 *     running, so an armed session never saw one. codex's app-server pushes
 *     `rate_limits_updated` to an IDLE thread — that is exactly the 21:55Z
 *     record that should have woken the incident's conversation — so the same
 *     line meant "silently break the promise and leave the session dead".
 *     Now the reading is asked whether the wall is GONE (PURE windowOpened,
 *     lane-aware) and, if so, the promise is KEPT through the normal fire path
 *     (breaker + hourly cap + quarantine + pre-fire gate all still apply).
 *  ONE implementation for every harness: the caller hands over its own
 *  normalized snapshot, nothing here branches on a backend id. */
const _readingEdgeSaid = new Map(); // webuiId → {why, at} — the last verdict this session's wait was journalled with
const READING_EDGE_LOG_MS = 10 * 60e3;
function noteQuotaReadingForResume(session, snapshot, why) {
  const id = session && session._webuiId;
  if (!id) return;
  try {
    const ar = getAutoResume();
    if (!ar) return;
    const st = ar.statusFor?.(id);
    if (!st || !st.armed) { _readingEdgeSaid.delete(id); ar.noteRecovered?.(id, why, { worked: false }); return; }
    const v = ar.noteQuotaReading?.(id, snapshot, why);
    if (!v || v.open || v.why === 'not-armed') { if (v && v.open) _readingEdgeSaid.delete(id); return; }
    // ONE LINE PER VERDICT, NOT ONE PER READING. A waiting codex session is
    // pushed a `rate_limits_updated` every few seconds — measured on the
    // incident thread's own buffer: 454 pushes in under two hours, 403 of them
    // on the SIBLING lane — and a watch can stand for days, so journalling each
    // refusal would bury the lines that mean something (the S9 round-6 rule: a
    // degrade path that speaks once per fetch says nothing). The verdict is
    // said when it CHANGES, and re-said at most every 10 min so a long wait
    // still shows it is being judged rather than ignored.
    const prev = _readingEdgeSaid.get(id);
    const now = Date.now();
    if (prev && prev.why === v.why && now - prev.at < READING_EDGE_LOG_MS) return;
    _readingEdgeSaid.set(id, { why: v.why, at: now });
    // TWO VERDICTS CARRY `wallOpen: true` AND EACH NEEDS ITS OWN SENTENCE —
    // the generic line says the wall is still up, and for these two that is a
    // false fact printed into the one channel this incident was diagnosed from.
    //   already-refuted  the window really does read open; we decline to spend
    //                    again because the CLI answered our last reading-driven
    //                    continue with another limit rejection (r2)
    //   gate-held        the window reads open, the PRE-FIRE GATE disagreed,
    //                    and we are pacing the re-ask rather than re-running it
    //                    on the producer's traffic (r3). The wait is intact and
    //                    it will be asked again — say that, not "still limited".
    console.log(v.why === 'already-refuted'
      ? `[auto-resume] ${id}: the window reads open but a continue onto this wall was already refused — waiting for the reset`
      : v.why === 'gate-held'
        ? `[auto-resume] ${id}: the window reads open but the pre-fire gate still says blocked — re-asking on a timer, the wait stands`
        : `[auto-resume] ${id}: reading did not reopen the wait (${v.why})`);
  } catch (e) { console.warn('[auto-resume] reading edge failed:', e.message); }
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
/** WHOSE WALL IS THIS? (inc-mttbrtc0-6049, 2026-09-08 23:47Z.)
 *
 *  THE INCIDENT. The pool re-pointed one session's credential link twice
 *  inside a single turn (23:44:48 → 23:46:00 → 23:46:36; all three rows are in
 *  data/slot-transitions.jsonl, per session, with timestamps). The CLI re-read
 *  the credentials — 2.1.257's `rpe()` re-reads on mtime, which is exactly what
 *  a re-point bumps — and its NEXT request, made with the member we had just
 *  moved TO, came back rejected with that member's own 5h window ('resets
 *  8:30pm'). `rejectionSlotFor` answers with the TURN PIN, so the wall landed
 *  on the member the turn had STARTED on: its panel read "resets 8:30pm" until
 *  the owner refreshed by hand, and it was demoted for three hours on somebody
 *  else's wall. The pin's justification — "a re-point cannot reach a running
 *  CLI" — is refuted by the readings-by-slot essay itself, and the 2.369.73
 *  rule that a WINDOW outranks our bookkeeping was only ever applied to VALUE
 *  readings. A rejection is a reading too.
 *
 *  THE PIN IS NOT WRONG, IT IS INCOMPLETE, and it stays the default. It exists
 *  because ONE wall reaches us through up to three producers (the
 *  `rate_limit_event`, the assistant banner and the task_notification banner)
 *  and each producer's write re-runs `maybePoolAutoSwitch` — so resolving per
 *  RECORD split one wall across the members our own re-points were moving to.
 *  That is still true. This only asks a further question when there is
 *  something to ask it with.
 *
 *  TWO WITNESSES, AND ONLY THEIR AGREEMENT MOVES A BYTE:
 *    · the LEDGER identifies — `slotAt(webuiId, <when the rejection arrived>)`,
 *      our own first-class record of which member held that link at that
 *      instant. This is the evidence the turn pin throws away.
 *    · the WINDOW refutes — a RUNNING window cannot change its reset before it
 *      ends, so a stated reset that contradicts the pin's own still-future
 *      window proves the wall is not the pin's. It proves nothing about WHOSE
 *      it is (2.369.73 r2 measured a 5h reset names a time, not an account),
 *      which is why identification is left to the ledger.
 *  Either witness silent ⇒ the pin stands. They disagree ⇒ we write NOTHING and
 *  say why; refusing can never write a foreign window onto a member, which is
 *  the harm.
 *
 *  ONLY A VENDOR-STATED RESET COUNTS. `parseLimitBanner` returns `{kind}` and
 *  no time, so the banner path carries `resetsAtMs: 0` and is untouched here —
 *  which is the load-bearing half of `guardReadingTarget`'s own reason for
 *  exempting walls ("the wall's resetsAt is often a bounded GUESS"). A guess
 *  compared against a real window differs every time; reading one as evidence
 *  would archive every exhaustion mark on the instance.
 *
 *  ASKED AT EVERY MOMENT A REJECTION IS WRITTEN, NOT ONLY AT THE AGGREGATE (r2,
 *  the round-1 verifier's first finding, reproduced). A rejected
 *  `rate_limit_event` is written TWICE: once per RECORD, the instant it arrives
 *  (`recordRateLimitEvent` → `captureRateLimitEvent`, which is what makes the
 *  pool act in the same tick), and once more when the turn ends and
 *  `demoteWalledAccount` folds the turn's signals together. Round 1 put the
 *  rule on the second one only, so the incident's own damage still landed: the
 *  foreign 5h window was written onto the pinned member at the FIRST write and
 *  the turn-end pass — which correctly filed the wall on the true owner —
 *  never went back to repair it. It was invisible in the suite because the
 *  fixture sent both rejections on the SAME bucket, so the pin's own turn-end
 *  write happened to overwrite the foreign value; on two different buckets the
 *  victim keeps a stranger's reset (measured: `accountRemaining` 0, ~3 h of
 *  exclusion, i.e. the incident). So `wallAttributionFor` is the rule over
 *  KEYS, and both writers ask it. Attributing at the write is also what makes
 *  the repair unnecessary: nothing foreign is ever stored to be repaired.
 *
 *  The rule is `wallAttributionFor` (over KEYS); its two callers are
 *  `wallRecordTarget` (per record) and `wallTargetFor` (the turn's aggregate),
 *  both directly below. */
/** THE RULE, OVER KEYS — the shared half of the two callers. Gathers the two
 *  witnesses (the slot LEDGER, and each candidate's own established window) and
 *  hands them to the PURE `quotaModel.wallAttribution`. */
function wallAttributionFor(session, poolId, b, pinnedKey) {
  const atMs = Number(b.atMs) || 0;
  const statedSec = b.resetsAtMs > 0 ? Math.floor(b.resetsAtMs / 1000) : null;
  if (!statedSec || !atMs) {
    // NO WINDOW OF ITS OWN — the banner paths, which state no time at all. If a
    // rejection RECORD of this same turn PROVED where this wall belongs, follow
    // that proof rather than the pin it refuted: it is the same wall, and one
    // rejection may not mark two members. Without evidence the pin stands,
    // exactly as before.
    const rf = session && session._turnWallRefile;
    if (rf && rf.from === pinnedKey && rf.to) {
      return { action: 'refile', key: rf.to, reason: `a rejection record of this turn proved this wall is ${rf.to}'s, and this signal states no window of its own` };
    }
    return { action: 'write', key: pinnedKey, reason: 'no reset stated' };
  }
  const atSec = Math.floor(atMs / 1000);
  const kindKey = b.kind === 'scoped' ? null : b.kind === 'fiveHour' ? 'fiveHour' : 'sevenDay';
  const ownOf = (key) => {
    try {
      const w = establishedWindows()[key];
      if (!w) return null;
      if (b.kind === 'scoped') return (w.scoped && w.scoped[String(b.scopedName || '').toLowerCase()]) || null;
      return w[kindKey] || null;
    } catch { return null; }
  };
  let led = null;
  try { led = slotTransitions.slotAt(session._webuiId, atMs, { poolId }); } catch { }
  const ledId = led && led.id && !led.ownLinkUnknown && led.scope === 'session' ? led.id : null;
  return quotaModel.wallAttribution({
    kind: b.kind,
    statedResetsAt: statedSec,
    pinnedKey,
    ledgerKey: ledId,
    ledgerIsSessionScoped: !!ledId,
    pinnedOwnResetsAt: ownOf(pinnedKey),
    ledgerOwnResetsAt: ledId ? ownOf(ledId) : null,
    atSec,
  });
}

/** THE PER-RECORD half: where does THIS rejected `rate_limit_event` go, right
 *  now? Returns the key to write on, or null when the record is archived
 *  instead. A session with no pool has no ledger and no re-point, so the rule
 *  degrades to "the pin" by construction and this costs one sidecar read. */
function wallRecordTarget(session, key, ev) {
  const poolId = session && session._accountId;
  try {
    const a = poolId && accounts.get(poolId);
    if (!a || a.type !== 'pooled') return key;   // no pool ⇒ no ledger and no re-point: the rule has nothing to add
  } catch { return key; }
  const b = {
    kind: ev.kind,
    scopedName: ev.kind === 'scoped' ? String(ev.scopedName || '').toLowerCase() : null,
    resetsAtMs: (Number(ev.resetsAt) || 0) * 1000,
    atMs: Date.now(),
  };
  const d = wallAttributionFor(session, poolId, b, key);
  if (d.action === 'write') {
    // A five-hour disagreement that nothing corroborates is not a verdict, but
    // it IS the shape the incident wore — say it once so a later reader of the
    // journal can find it, and never silently.
    if (d.disagrees) console.log(`[wall] ${session._webuiId}: ${BUCKET_LABEL[ev.kind] || ev.kind} rejection disagrees with ${nameOf(key)}'s own window — writing it there anyway (${d.reason})`);
    return key;
  }
  const label = ev.kind === 'scoped' ? b.scopedName : BUCKET_LABEL[ev.kind] || ev.kind;
  if (d.action === 'refile') {
    const to = (accounts.poolMembers(poolId) || []).find((m) => m.id === d.key);
    if (!to) { archiveWall(session, { id: key }, b, d, `${d.reason}; the ledger's member is no longer in this pool`, 'rejection'); return null; }
    console.log(`[wall] ${session._webuiId}: ${label} rejection states ${nameOf(d.key)}'s window, not ${nameOf(key)}'s — filed there instead (the link moved mid-turn)`);
    global.__vsEvent?.('wall-record-refiled', `${key}→${d.key}:${label}`);
    // ONE WALL REACHES US THROUGH UP TO THREE PRODUCERS, and only this one
    // carries a window. The assistant banner and the task_notification banner
    // describe the SAME rejection but state no time at all (`parseLimitBanner`
    // returns `{kind}` — owner ruling: never parse text for times), so they
    // have no evidence of their own and fall back to the turn pin — the member
    // we have just PROVED this wall is not. Record the proof for the rest of
    // the turn so the whole rejection moves together instead of marking two
    // members; it dies with the turn exactly like the two pins, because a
    // re-point only reaches the CLI on its next request.
    try { session._turnWallRefile = { from: key, to: d.key, at: Date.now() }; } catch { }
    return d.key;
  }
  archiveWall(session, { id: key }, b, d, d.reason, 'rejection');
  return null;
}

/** THE TURN-END half: the aggregate's per-signal target, as a pool MEMBER.
 *  Returns `{member, why}`; `member: null` = archived with a reason. */
function wallTargetFor(session, poolId, b, pinned) {
  const d = wallAttributionFor(session, poolId, b, pinned.id);
  if (d.action === 'write') return { member: pinned, why: null };
  const label = b.kind === 'scoped' ? b.scopedName : BUCKET_LABEL[b.kind] || b.kind;
  if (d.action === 'refile') {
    const to = (accounts.poolMembers(poolId) || []).find((m) => m.id === d.key);
    // The ledger may name a member this pool no longer holds (it was removed
    // between the rejection and now). We can prove the pin is wrong but have
    // nowhere sound to put it, so we do the smaller thing.
    if (!to) return archiveWall(session, pinned, b, d, `${d.reason}; the ledger's member is no longer in this pool`);
    console.log(`[wall] ${session._webuiId}: ${label} wall states ${nameOf(d.key)}'s window, not ${nameOf(pinned.id)}'s — re-filed (the link moved mid-turn)`);
    global.__vsEvent?.('wall-refiled', `${pinned.id}→${d.key}:${label}`);
    return { member: to, why: 'ledger+window' };
  }
  return archiveWall(session, pinned, b, d, d.reason);
}

/** A wall we refuse to write is ARCHIVED, never dropped: the same
 *  archive-never-destroy store the window guard uses, so one grep answers
 *  "what did we refuse and why" for readings and rejections alike. `moment`
 *  distinguishes the two writes of one rejection ('rejection' = the record as
 *  it arrived, 'wall' = the turn's folded signals), because refusing both is
 *  two facts, not one line written twice. */
function archiveWall(session, pinned, b, d, reason, moment = 'wall') {
  const label = b.kind === 'scoped' ? b.scopedName : BUCKET_LABEL[b.kind] || b.kind;
  console.log(`[wall] ${session._webuiId}: refusing to mark ${nameOf(pinned.id)} ${label} — ${reason}`);
  global.__vsEvent?.('wall-archived', `${pinned.id}:${label}`);
  try {
    fs.mkdirSync(path.dirname(READING_ARCHIVE), { recursive: true });
    fs.appendFileSync(READING_ARCHIVE, JSON.stringify({
      at: Date.now(), store: 'usage-cache', key: pinned.id, sid: session._webuiId || '-',
      what: moment + ':' + label, reason, matched: d.key || null,
      ownWindow: (() => { try { return establishedWindows()[pinned.id] || null; } catch { return null; } })(),
      entry: { kind: b.kind, scopedName: b.scopedName, resetsAtMs: b.resetsAtMs, atMs: b.atMs },
    }) + '\n');
  } catch { }
  return { member: null, why: null };
}

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
  // asked of the SIGNAL, because the link may have moved since (the signal
  // carries the turn-pinned answer; see rejectionSlotFor)
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
  //
  // ATTRIBUTE FIRST, THEN AGGREGATE (inc-mttbrtc0-6049). Merging by kind and
  // keeping `Math.max(resetsAtMs)` IS the incident's mechanism: two rejections
  // arriving in one turn from two DIFFERENT members — because the pool moved
  // the link between them — collapsed into one bucket that then carried the
  // later member's window and was written onto the earlier one. Measured on
  // this instance, that is exactly the pair (a legitimate 00:20 wall at 23:46
  // and a foreign 03:30 one at 23:48, one bucket, one write). So each SIGNAL is
  // attributed on its own evidence and only then folded together; two members'
  // walls now stay two walls.
  const buckets = new Map();
  for (const s of sigs) {
    if (s.key && !ids.has(s.key)) continue;
    const kind = s.bucket || 'fiveHour';
    if (kind === 'scoped' && !s.scopedName) continue;
    const one = {
      kind, scopedName: kind === 'scoped' ? String(s.scopedName).toLowerCase() : null,
      resetsAtMs: Number(s.resetsAtMs) || 0, atMs: Number(s.at) || 0,
    };
    const tgt = wallTargetFor(session, poolId, one, member);
    if (!tgt.member) continue;                       // archived, with a reason, inside
    const k = (tgt.member.id === member.id ? '' : tgt.member.id + '|')
      + (kind === 'scoped' ? 'scoped:' + one.scopedName : kind);
    const b = buckets.get(k) || { ...one, resetsAtMs: 0, atMs: 0, dest: tgt.member, why: tgt.why };
    b.resetsAtMs = Math.max(b.resetsAtMs, one.resetsAtMs);
    b.atMs = Math.max(b.atMs, one.atMs);
    buckets.set(k, b);
  }
  const done = [];
  for (const b of buckets.values()) {
    const dest = b.dest;
    const ev = { kind: b.kind, scopedName: b.scopedName, status: 'rejected', utilization: null, resetsAt: b.resetsAtMs > now ? Math.floor(b.resetsAtMs / 1000) : null, overage: {} };
    const r = captureRateLimitEvent({ cacheDir: USAGE_CACHE_DIR, key: dest.id, identityIds: usageIdentityAccountIds(dest.id), ev, now, source: 'wall' });
    if (!r.ok) { console.warn(`[wall] demotion write failed for ${dest.name}: ${r.error || 'unknown'}`); continue; }
    // THE DEMOTION FOLLOWS THE WRITE. The incident's money half was this: the
    // pinned member was held out of the pool for three hours on somebody
    // else's wall, so re-filing the numbers while leaving the demotion behind
    // would fix the panel and keep the cost.
    if (dest.id !== member.id) noteSessionWall(session._webuiId, dest.id, now);
    const label = b.kind === 'scoped' ? b.scopedName : BUCKET_LABEL[b.kind] || b.kind;
    let until = 0;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, String(dest.id).replace(/[^\w.-]/g, '_') + '.json'), 'utf-8'));
      const bk = b.kind === 'scoped' ? (c.scopedWeekly || []).find((x) => String(x?.name || '').toLowerCase() === b.scopedName) : c[b.kind];
      until = (Number(bk?.resetsAt) || 0) * 1000;
    } catch { }
    const why = b.why || (slotMatch ? 'credential slot' : observedMatch ? 'observed-org' : walls + '-walls');
    console.log(`[wall] demoted ${dest.name} ${label} until ${until ? new Date(until).toISOString() : 'unknown'} (${walls} walls / ${why})`);
    global.__vsEvent?.('wall-demote', `${dest.id}:${label}:${why}`);
    done.push({ label, until });
  }
  // (the write's fresh fetchedAt busts the estimator memo by itself — estimateFor re-anchors on a newer rawCache)
  return { demoted: done.length > 0, reason: done.length ? 'demoted' : 'no-bucket', key: member.id, walls, observedMatch, slotMatch, buckets: done };
}

/** PURE. The near-arm's INVARIANT ASSERTION — deliberately NOT its protection
 *  (r3, the round-2 verifier's finding). What keeps a near-arm off the identity
 *  that just rejected us is two mechanisms that run BEFORE it:
 *  demoteWalledAccount calls noteSessionWall(member) on every path that
 *  resolves a member (held demotions included), and quotaVerdictFor forces
 *  `usable:false` for every member in that set — so the verdict's `viaId`
 *  cannot BE the rejector. Round 2 wrote the guard as `viaId === demoted.key`,
 *  which is unreachable for a second reason (the only `demoted.key` that skips
 *  noteSessionWall is `not-a-member`, and by construction no member id matches
 *  it) and read like the defence while never executing — the repo's 恒假守卫
 *  lesson. This one re-reads the SAME store the verdict read: if the two ever
 *  disagree, one of them is broken, so the caller says so LOUDLY and refuses
 *  the spend instead of re-firing at an identity that just refused us.
 *  Returns the violation's text, or null when there is nothing to say. */
function nearArmVeto(viaId, walledIds) {
  if (!viaId || !walledIds) return null;
  const has = typeof walledIds.has === 'function' ? walledIds.has(viaId)
    : Array.isArray(walledIds) ? walledIds.includes(viaId) : false;
  return has ? 'the verdict named a member that rejected this conversation as the way out' : null;
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
    // WHICH WALL this arm is about (2026-09-08), for the fresh-window edge: the
    // LANE the signals named (a codex login reports several — the sibling lane
    // read 0 % through the whole 32 h stall) and the BUCKET with the FURTHEST
    // reset, because an identity unblocks only when the LAST of its dead
    // windows has reset (the c1206711 rule). Both null for a harness that
    // states neither, which is the honest answer rather than a guess — and an
    // arm with no bucket simply waits out its own timer.
    const wallSig = (sigs || []).filter((s2) => s2 && s2.bucket).sort((x, y) => (y.resetsAtMs || 0) - (x.resetsAtMs || 0))[0] || null;
    const armWall = { lane: (sigs || []).map((s2) => s2 && s2.lane).find(Boolean) || null, bucket: wallSig ? wallSig.bucket : null, scopedName: wallSig ? (wallSig.scopedName || null) : null };
    if (v.usable === true) {
      // a member is free: the session is idle-walled and nothing else will
      // move it — a NEAR fire re-enters work through the normal machinery
      // (pre-fire gate re-verifies; the delayed announcement outlives this,
      // so a quick success stays silent). The pool eval in `finally` runs
      // with the session ARMED, so a hot switch's fireNow() continues it now.
      // ASSERTION, NOT PROTECTION (r3 — see nearArmVeto). The near-arm is kept
      // off the rejector by noteSessionWall + the verdict's walled override,
      // both of which have already run; this re-reads that same store so a
      // disagreement between them is LOUD instead of silently spending a turn.
      // It cannot fire today, and that is the point of saying so here rather
      // than dressing it up as the defence (round 2 compared `viaId` to
      // `demoted.key`, which is unreachable for an unrelated reason).
      const veto = nearArmVeto(v.viaId, sessionWalledMembers(id));
      if (veto) {
        console.warn(`[wall] ${id}: INVARIANT VIOLATED — ${veto} (${nameOf(v.viaId)}) — not re-firing`);
        global.__vsEvent?.('wall-usable-is-rejector', String(v.viaId));
      } else {
        ar.armIfEnabled(id, session, Date.now() + 45000, `switched to a usable account (${v.via || '?'})`, armWall);
        return;
      }
    }
    const evReset = Math.max(0, ...sigs.map((s2) => s2.resetsAtMs || 0));
    const target = v.blockedUntil || evReset;
    if (target > Date.now()) {
      ar.armIfEnabled(id, session, target, v.reason || 'usage limit', armWall);
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
  } catch (e) {
    // FAIL CLOSED (P8). This is the gate auto-resume asks before it spends a
    // turn: it probes fresh quota, re-runs the pool decision and re-reads the
    // verdict. An exception means NONE of that happened, and `return true`
    // turned every failure of the money gate into a green light — the same
    // shape as the wiring's own `catch { return true; }` in server.js, so a
    // throw was answered with a billed turn at BOTH layers. A refusal here
    // costs one tick (30s) and says why.
    console.warn(`[auto-resume] pre-fire gate failed for ${id} — refusing the continue (fail closed): ${e && e.message}`);
    try { global.__vsEvent?.('spend-gate-error', 'beforeAutoResumeFire'); } catch { }
    return false;
  }
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
    // BOTH halves are facts about the credential SLOT the CLI reads (the
    // validated link): a REJECTION through rejectionSlotFor, a READING through
    // readingSlotFor — turn-pinned twins, because a rejection's other records
    // and a turn's other readings both arrive after the first one has already
    // moved the link. The observation only corroborates (it names the identity
    // cached at SPAWN, so keying on it filed a hot-switched session's numbers
    // under the account it started on — the 2026-09-07 root cause).
    // THE RECORD ITSELF NAMES ITS WINDOW (inc-mts8a8mr-ulmm). A reading event
    // carries the reset of the bucket it reports, and a weekly reset phase is
    // an account fingerprint — so the response can be asked which credentials
    // produced it, which is strictly better evidence than any bookkeeping of
    // ours about what the process is reading. A REJECTION deliberately keeps
    // the turn-pinned rejection slot untouched (its resetsAt is frequently
    // absent or a bounded guess, and its identity has its own r3 pin).
    const win = ev.status === 'rejected' ? null : readingLag.windowOf(ev);
    // THE FINGERPRINT IS "THE NUMBERS", not "the window" (caught by the shared-
    // phase leg of test-readings-attribution §14). The r3 clause says *the link
    // moved but the numbers did not*, and a window alone almost never moves —
    // fingerprinting only the window would shadow nearly every reading that
    // follows a re-point between two members sharing a weekly phase. The
    // statusline's `rlFingerprint` has always carried used_percentage for both
    // buckets; this is the same fact in this producer's own shape.
    const fp = win ? `${readingLag.windowFingerprint(win)}|k:${ev.kind}|u:${ev.utilization ?? '-'}` : null;
    const slot = ev.status === 'rejected' ? rejectionSlotFor(session) : readingSlotFor(session, Date.now(), { window: win, fingerprint: fp });
    let key = (slot && slot.key) || usageCacheKeyFor(session);
    if (win) {
      const target = guardReadingTarget(key, win, { session, what: 'rate-limit-event:' + ev.kind, entry: { ev, slot } });
      if (!target) return;                       // archived with a reason — never written where it provably does not belong
      if (target !== key) {
        key = target;
        // the window is better evidence than the pin that produced the wrong
        // answer, so the REST of the turn follows it too (the 06:10:46Z shape:
        // a pin held from before three re-points filed one member's fresh
        // numbers on another for the whole turn)
        try { session._turnReadingSlot = { key, slotOk: !!validateBillingSlot(session?._accountId || null, key).ok, at: Date.now() }; } catch { }
      }
      try { session._lastReadingFp = { key, fp }; } catch { }
    }
    // A REJECTION IS WRITTEN THE INSTANT IT ARRIVES, so the attribution rule
    // has to run HERE too — not only when the turn ends (r2, the round-1
    // verifier's first finding). This write is what makes the pool act in the
    // same tick, and it was the one that put the incident's foreign 5h window
    // onto the pinned member: `guardReadingTarget` above is structurally
    // unreachable for a rejection (`win` is deliberately null) and the turn-end
    // pass, which files the wall on the true owner, has no reason to go back
    // and repair a bucket it never touched. `wallRecordTarget` asks exactly the
    // rule `wallTargetFor` asks, over the same two witnesses, so the two writes
    // of one rejection can never disagree about where it belongs.
    let writeKey = key;
    if (ev.status === 'rejected') {
      writeKey = wallRecordTarget(session, key, ev);
      if (!writeKey) {
        // archived with a reason, inside. The SESSION is still blocked whoever
        // owns the bucket, so the session-scoped half below still runs — we
        // refused to write a number, not to notice a wall.
        maybePoolAutoSwitch(session);
        try { noteWallSignal(session, { resetsAtMs: (Number(ev.resetsAt) || 0) * 1000, bucket: ev.kind, scopedName: ev.scopedName, key, slot: !!slot?.slotOk }); } catch { }
        return;
      }
    }
    const corr = corroborateReading(session, writeKey, 'rate-limit-event:' + ev.kind);
    const r = captureRateLimitEvent({ cacheDir: USAGE_CACHE_DIR, key: writeKey, identityIds: usageIdentityAccountIds(writeKey), ev, corroborated: corr ? corr.agree : undefined });
    if (r.unknownType) { global.__vsEvent?.('rate-limit-event-unknown-type', r.unknownType); return; }
    global.__vsEvent?.('rate-limit-event', `${writeKey}:${ev.kind}:${ev.status}${r.wroteReading ? ':reading' : ''}`);
    // a reading busts the estimator memo via fetchedAt and becomes an anchor
    // at the next sweep; exhaustion acts NOW (banner parity)
    if (r.dead) {
      maybePoolAutoSwitch(session);                    // another account = seconds, not hours: always preferred
      // wall-machine SIGNAL (2.369.0): no arming here — the turn's RESULT
      // classifies (a turn the switch rescues completes normally and never
      // enters BLOCKED; a genuinely walled turn arms off quotaVerdict).
      try { noteWallSignal(session, { resetsAtMs: (Number(ev.resetsAt) || 0) * 1000, bucket: ev.kind, scopedName: ev.scopedName, key, slot: !!slot?.slotOk }); } catch { }
    } else if (r.wroteReading) {
      // ONE reading edge for every harness (noteQuotaReadingForResume): drops
      // an un-armed session's timed wait exactly as before, and asks an ARMED
      // one whether this reading says the wall is gone. A `rate_limit_event`
      // names ONE bucket, so the snapshot handed over is that bucket in the
      // shared shape — claude states no limit lane, so the lane matches by
      // construction and every claude reading is judged on its numbers alone.
      if (ev.status && ev.status !== 'rejected') {
        const snap = ev.kind === 'scoped'
          ? { scopedWeekly: [{ name: ev.scopedName || '', utilization: ev.utilization, resetsAt: ev.resetsAt }] }
          : { [ev.kind]: { utilization: ev.utilization, resetsAt: ev.resetsAt } };
        noteQuotaReadingForResume(session, snap, 'fresh non-rejected reading');
      }
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
    // `source` is a PARAMETER, not an assumption: this helper serves two
    // channels and one of them does not always carry a reading (see the
    // task_failed call site, which synthesizes a spent-bucket snapshot).
    const writeSnap = (snap, source) => {
      if (!snap) return null;
      // ONE attribution function for readings (2026-09-07): the codex snapshot
      // is a VALUE like every other, so it goes through the same turn-pinned
      // validated slot instead of re-deriving "the pool's current member" per
      // record. codexQuotaKeyFor is the un-pinned twin (probe matching).
      // …and through the same window guard: `capsOf('codex').hotSwitch` is
      // 'impossible', so codex has no re-point to lag behind — but the guard is
      // about WHOSE numbers these are, and a key that is wrong for any other
      // reason is wrong the same way. The synthesized spent-bucket snapshot on
      // `task_failed` states no reset it did not receive, so it is inert there.
      const _k0 = readingSlotFor(session).key || codexQuotaKeyFor(session);
      const key = guardReadingTarget(_k0, readingLag.windowOf(snap), { session, what: 'codex:' + source, entry: snap });
      // an ARCHIVED reading is not an unparseable one — the waiter must be told
      // which of the two happened (a probe that says "unparseable" about a
      // perfectly good payload sends the next reader hunting the wrong bug)
      if (!key) return { key: null, snap, archived: true };
      // STAMP THE PRODUCER AT THE WRITE (2026-09-07 r3, reproduced): the
      // provenance line reads `snap.source`, and `normalizeCodexRateLimit` is
      // a PURE payload mapper that cannot know which channel carried it — so
      // every codex panel rendered "via unknown · No producer recorded this
      // reading" about the one codex producer that exists.
      snap.source = source;
      try {
        const cur = usageWrite.readCacheObject(USAGE_CACHE_DIR, key);
        if (!cur || (Number(cur.fetchedAt) || 0) < (Number(snap.fetchedAt) || 0)) {
          // codex has no OTel channel, so there is nothing to corroborate WITH:
          // the label is deliberately absent rather than a fabricated `true`.
          // ONE limit per push (B-9213): this snapshot names its own limitId
          // and the write path merges it under that id, so a Spark push can no
          // longer erase the plan limit this account is actually spending.
          usageWrite.writeCacheObject({
            cacheDir: USAGE_CACHE_DIR, key, obj: snap,
            set: quotaSourceFor(session.backend).limitSetFromSnapshot?.(snap, { identity: key, source }) || null,
            source, backend: 'codex',
          });
        }
      } catch { }
      return { key, snap };
    };
    // Escape ladder on codex exhaustion (owner-designed order): ① stored
    // RESET CREDIT when opted in (codex.limitResetCredit='auto' — spending a
    // stored reset unattended is the same consent class as auto-resume, so
    // default off) → ② pool switch → ③ auto-resume wait. One credit attempt
    // per limit event, 10min re-try floor.
    const tryResetCredit = (resetsAtSec, lane = null) => {
      try {
        if (serverSetting('codex.limitResetCredit') !== 'auto') return false;
        if (!session.pty || session.mode !== 'chat') return false;
        const now = Date.now();
        if (session._codexResetTriedAt && now - session._codexResetTriedAt < 10 * 60e3) return false;
        // A stored reset credit is money the owner already paid for, spent
        // while nobody is present — the same consent class as an auto-resume
        // continue, so it passes the SAME ceiling (design §4.4c: the seven
        // producers, this is the one that does not open a turn but still
        // spends). Fail closed: an authorizer that throws does not get to
        // green-light a purchase.
        // THE MODULE'S OWN GUARD, not an injected dep (r2): `spendGuard` is
        // constructed above in this very file and the reset-credit path runs
        // long after the factory returns, so there is nothing to inject and
        // nothing that can arrive null. The dep version of this gate shipped
        // DEAD — server.js never passed it — and the suite leg that "proved"
        // it passed a payload that reached no branch at all.
        let av = null;
        {
          try { av = spendGuard.authorize({ reason: 'codex-reset-credit', session, sessionId: session._webuiId, sessionName: session.name || null }); }
          catch (e) { console.warn('[codex] spend authorizer threw — not spending a reset credit:', e.message); return false; }
          if (av && av.ok === false) { console.log(`[codex] reset credit refused for ${session._webuiId} (spend budget: ${av.why})`); return false; }
        }
        session._codexResetTriedAt = now;
        session._codexLastResetsAt = Number(resetsAtSec) || 0;
        // …and WHICH LANE it was: if the credit fails we arm from these two,
        // and an arm with no lane can never be reopened by a reading (an
        // unknown lane may not authorise a billed turn).
        session._codexLastLane = lane || null;
        session.pty.write(JSON.stringify({ type: 'codex-reset-credit' }) + '\n');
        // CHARGE WHAT YOU AUTHORIZED (r4): the slot the verdict resolved, handed
        // back — never a session for the guard to resolve a second time.
        try { spendGuard.note({ reason: 'codex-reset-credit', session, identity: av && av.identity, hold: av && av.hold }); } catch (e) { console.warn('[codex] spend accounting failed:', e.message); }
        serverNotice(`codex-reset-${session._webuiId}-${now}`, `Codex hit a usage limit — trying a stored rate-limit reset credit before switching accounts.`);
        global.__vsEvent?.('codex-reset-credit-try', session._accountId || 'global');
        return true;
      } catch { return false; }
    };
    if (payload.type === 'reset_credit_result') {
      const out = payload.outcome || payload.result?.outcome || null;
      if (out === 'reset') {
        serverNotice(`codex-reset-ok-${session._webuiId}-${Date.now()}`, `Codex reset credit consumed — the limit was reset, continuing on the same account.`);
        // worked:false — codex says the LIMIT was reset on this identity; the
        // conversation itself has produced nothing yet. Nothing on this path
        // fires a continue either (this very call disarms first, so the
        // kickPoolEval below finds an unarmed session), so the classification
        // only decides whether a still-live failed fire keeps its quarantine —
        // and a redeemed credit is not a reason to re-open the hour's budget:
        // that quarantine self-expires in 10min, the same floor
        // tryResetCredit itself paces on.
        try { getAutoResume()?.noteRecovered?.(session._webuiId, 'codex reset credit consumed', { worked: false }); } catch { }
        kickPoolEval();
      } else {
        // credit didn't land (nothingToReset / alreadyRedeemed / cooldown /
        // error) — fall through to the normal ladder: switch, else wait.
        global.__vsEvent?.('codex-reset-credit-failed', String(out || payload.error || 'unknown').slice(0, 60));
        maybePoolAutoSwitch(session);
        const resets = Number(session._codexLastResetsAt) || 0;
        try { noteWallSignal(session, { resetsAtMs: resets * 1000, bucket: 'sevenDay', key: codexQuotaKeyFor(session), lane: session._codexLastLane || null }); noteTurnEnd(session); } catch { }
      }
      return;
    }
    if (payload.type === 'rate_limits_updated' && payload.rateLimits) {
      // the harness normalized the snapshot (window-by-length, exhaustion
      // markers, the on-demand resetCredits count) — sig.snapshot is it
      const snap0 = sig?.snapshot || null;
      // the live app-server push — the codex twin of claude's 'rate-limit-event'
      const w = writeSnap(snap0, 'codex-rate-limits');
      // an rpc-rate-limits probe waiting on this session settles AFTER the
      // cache write — its next quotaVerdictFor already reads the fresh file
      settleCodexLimitsWaiters(session, w && w.key ? { ok: true }
        : { ok: false, reason: w && w.archived ? 'the reading\'s window is not this account\'s (archived)' : 'unparseable rateLimits' });
      if (!w || !w.key) return;
      global.__vsEvent?.('codex-rate-limits', `${w.key}${w.snap.rateLimitReachedType ? ':reached-' + w.snap.rateLimitReachedType : ''}`);
      if (sig.kind === 'exhausted') {
        const tripped = sig.tripped; // the window rate_limit_reached_type named
        if (tryResetCredit(tripped?.resetsAt, arSignal.laneOf(w.snap))) return; // outcome event continues the ladder
        maybePoolAutoSwitch(session); // another ChatGPT account = seconds, not hours
        try { noteWallSignal(session, { resetsAtMs: (Number(tripped?.resetsAt) || 0) * 1000, bucket: tripped && tripped === w.snap.fiveHour ? 'fiveHour' : 'sevenDay', key: w.key, lane: arSignal.laneOf(w.snap) }); } catch { }
      } else {
        // the codex twin of the passive claude reading above — and the ONE
        // channel that can reach an IDLE conversation, which is why the
        // fresh-window edge exists (the 2026-09-08 incident's 21:55Z push)
        noteQuotaReadingForResume(session, w.snap, 'fresh non-limited codex reading');
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
        // THE SYNTHESIZED SNAPSHOT'S LANE IS A DEFAULT, and it is the best
        // evidence this record carries: the measured exhaustion record has
        // `rateLimits: null`, so the plan lane `'codex'` is what we already
        // write into this account's cache as its state, and the fresh-window
        // edge is armed on it. If the true wall were a MODEL lane
        // (`codex_bengalfox`) the consequence is bounded and self-correcting —
        // a healthy `codex` reading fires ONCE and the edge is spent for this
        // wall AT THE DELIVERY (auto-resume `edgeSpent`, cleared only by proof
        // of work — deliberately not by our rejection report, which this
        // module would have to be trusted to send); the timed path still
        // delivers at the stated reset.
        // THAT BOUND IS THE `edgeSpent` RULE AND NOTHING ELSE (r2): this
        // comment used to credit the loop breaker's quarantine, which is TEN
        // MINUTES, so the real ceiling was the hourly cap — 3 billed continues
        // per rolling hour, every hour, for the life of the watch (measured:
        // [3,3,3,3] over 4 simulated hours against the real modules). Do not
        // restore that claim without re-measuring it.
        // Inventing a lane we cannot read would be worse in the other
        // direction (a wait no reading can ever open).
        const snap = sig.snapshot || {
          limitId: 'codex', sevenDay: { utilization: 1, usedPercent: 100, windowMinutes: 10080, resetsAt: resets > nowSec ? resets : nowSec + 24 * 3600, status: 'limited' },
          fiveHour: null, rateLimitReachedType: 'unknown', fetchedAt: Date.now(),
        };
        // A REFUSAL, not a push: this is codex's 'limit-banner' — the claude
        // vocabulary already names it ("own session (limit hit)"), and the
        // `sig.snapshot ||` fallback above SYNTHESIZES a spent bucket, which is
        // not a reading at all. Calling either one 'codex-rate-limits' would
        // claim a producer that did not produce it.
        const w2 = writeSnap(snap, 'limit-banner');
        global.__vsEvent?.('codex-usage-limit', info);
        if (tryResetCredit(resets, arSignal.laneOf(w2?.snap || snap))) return; // ① reset credit first when opted in
        maybePoolAutoSwitch(session);
        try { noteWallSignal(session, { resetsAtMs: resets > nowSec ? resets * 1000 : 0, bucket: 'sevenDay', key: w2?.key || codexQuotaKeyFor(session), lane: arSignal.laneOf(w2?.snap || snap) }); noteTurnEnd(session); } catch { }
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
    // TURN-PINNED (r3): the banner is usually the SECOND record of a rejection
    // whose first record already re-pointed the link, so asking for the slot
    // fresh here marked the member the pool had just moved TO.
    const slot = rejectionSlotFor(session);
    const pinKey = slot.key || readingSlotFor(session).key || usageCacheKeyFor(session);
    // …but the WRITE follows a re-file this turn PROVED (wallRecordTarget). The
    // banner states no time, so it has no window of its own to be judged by —
    // and it is the same wall, so leaving it on the refuted member marks two
    // members for one rejection. `pinKey` is kept for the SIGNAL below: that
    // key is what demoteWalledAccount resolves `member` and `ids` from, and
    // moving it would silently drop every earlier signal keyed to the pin —
    // the member's OWN legitimate wall among them. The turn-end pass reaches
    // the same destination by asking the same proof (wallAttributionFor).
    let key = pinKey;
    const refile = session._turnWallRefile;
    if (refile && refile.from === key && refile.to) {
      console.log(`[wall] ${session._webuiId}: the banner follows this turn's proven re-file — marking ${nameOf(refile.to)}, not ${nameOf(key)} (the banner states no time of its own)`);
      key = refile.to;
    }
    const corr = corroborateReading(session, key, 'limit-banner');
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
    const fileFor = (id) => usageWrite.cacheFileFor(USAGE_CACHE_DIR, id);
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
    // NOTE (r2): this write used to have to rescue `ownWindow` by hand — the
    // freshest-sibling base is chosen for its READINGS, so writing it through
    // would have carried another file's window here. The established window now
    // lives in a sidecar (readingLag.windowSidecarName) that no reading producer
    // writes, so there is nothing here to preserve and nothing to forget.
    cache.fetchedAt = Date.now(); cache.source = 'limit-banner';
    if (corr) cache.corroborated = !!corr.agree; else delete cache.corroborated;
    delete cache.limits; // the freshest SIBLING's limits describe another file's windows — never carry them here
    usageWrite.writeCacheObject({ cacheDir: USAGE_CACHE_DIR, key, obj: cache, measuredAt: cache.fetchedAt, source: 'limit-banner', familyOf: familyOfScopedBucket, backend: 'claude' });
    for (const id of ids) {
      if (id === key) continue;
      try {
        let c2; try { c2 = JSON.parse(fs.readFileSync(fileFor(id), 'utf-8')) || null; } catch { c2 = null; }
        if (!c2) continue; // never CREATE a sibling file here
        applyHit(c2); // fetchedAt deliberately untouched
        delete c2.limits;
        usageWrite.writeCacheObject({ cacheDir: USAGE_CACHE_DIR, key: id, obj: c2, measuredAt: cache.fetchedAt, familyOf: familyOfScopedBucket, backend: 'claude' });
      } catch {}
    }
    global.__vsEvent?.('usage-limit-banner-marked', `${key}:${hit.kind}`);
    maybePoolAutoSwitch(session); // freshest possible exhaustion signal — act now
    // wall-machine: the banner is a BOOLEAN signal only (owner: never parse
    // text for TIMES) — no resetsAtMs here; the bucket name is the same one
    // parseLimitBanner gave the cache mark, and `key` is where that mark
    // landed (the wall's account, B-2c9b). Times come from quotaVerdict/probe.
    try { noteWallSignal(session, { bucket: hit.kind, scopedName: hit.kind === 'scoped' ? hit.name : null, key: pinKey, slot: !!slot.slotOk }); } catch { }
  } catch (e) { console.warn('[usage] banner mark failed:', e.message); }
}

function maybePoolAutoSwitch(session) {
  try { if (session._accountId) maybePoolAutoSwitchForPool(session._accountId); } catch { }
}

// ── A MEMBER BECAME USABLE, AND NOBODY NOTICED (2026-09-08, from the
// production journal) ──────────────────────────────────────────────────────
// Every member of pool "全部" was spent ("no member can serve it", 02:00:02).
// The owner added a subscription; at 02:18:33 the pool moved EIGHT fable
// conversations onto it ("from 0%") while it had NO reading at all, and four
// seconds later auto-resume RE-ARMED them for the far reset 10:20Z with the
// reason "<new member>: no usage data". The auto-cli panel read of that member
// FAILED at 02:18:40 (which doubled its backoff: the next read was 02:31:43),
// the owner refreshed by hand in between — and that route wrote a reading and
// told the pool NOTHING. The conversations sat armed for a reset eight hours
// away and were released at 02:25:01 only because the owner typed a prompt.
// (The opus conversations woke at 02:22:10 for an unrelated reason: one of
// their turns ended, and a turn end is the one event that already
// re-evaluates.)
//
// So the gap was never "the pool decided wrong" — THE POOL NEVER GOT TO
// DECIDE. It re-evaluates on turn ends and on streamed usage records, and a
// conversation that is ARMED produces neither. Two things make a member's
// first usable reading exist, and neither re-drove anything:
//   · a LOGIN succeeding (the finalize routes)
//   · a HUMAN ⟳ refresh (/api/usage/refresh)
// ONE function serves both, so a third producer cannot forget it.
//
// IT DOES NOT SPEND BY ITSELF. Releasing an armed conversation goes through
// auto-resume's own fireNow → attemptFire, i.e. the 2026-09-07 loop breaker
// (same-identity quarantine, 3/hour cap, backoff) AND the pre-fire gate that
// re-verdicts the target and vetoes the turn if it is still blocked. There is
// no bypass here, by construction: this module only says "look again".
const MEMBER_WAKE_FLOOR_MS = 20e3;         // two refreshes landing together are ONE wake
const MEMBER_READING_FRESH_MS = 10 * 60e3; // a wake acts on a reading taken NOW, never on a stale file
const LOGIN_READ_FLOOR_MS = 5 * 60e3;      // one usage read per login EDGE — a re-polled finalize must not spawn a second CLI
const _memberWakeAt = new Map();           // memberId → last wake that ACTED
const _loginReadAt = new Map();            // memberId → last login-edge usage read (shared with the auto-cli loop's attempt clock)

/** The pools this member can serve, as the pool machinery itself sees them
 *  (`poolMembers` is the same resolver the roster and the chooser use, so a
 *  pool with `members:null` — "every subscription" — is included by the one
 *  rule instead of a second interpretation of that null). */
function memberPoolsOf(memberId) {
  const out = [];
  try {
    for (const a of accounts.list().accounts || []) {
      if (a.type !== 'pooled') continue;
      let ms = [];
      try { ms = accounts.poolMembers(a.id) || []; } catch { }
      if (ms.some((m) => (m && m.id ? m.id : m) === memberId)) out.push(a);
    }
  } catch { }
  return out;
}

/** IS THIS STORED READING ACTUALLY THIS MEMBER'S? Composition with the
 *  window-fingerprint work (inc-mts8a8mr-ulmm, landed 2.369.73) — NOT a second
 *  copy of it.
 *
 *  That work ships TWO rules and this asks the SECOND one on purpose. ① the
 *  LAG SHADOW (`decideLagShadow`) is about a reading ARRIVING on a session
 *  after that session's link moved; it needs a session, a re-point and an age,
 *  and the producers already applied it before this snapshot reached the disk.
 *  ② the WINDOW IDENTITY GUARD (`decideReadingTarget`) is the question a wake
 *  actually has: a reading whose weekly window contradicts this member's own
 *  established window was produced on somebody else's credentials, so it may
 *  not drive a decision here either. Reached through the same
 *  `establishedWindows()` + `windowGroupOf` the write-time guard uses, so there
 *  is ONE predicate ("two functions answering one question" is the exact
 *  family of bug this area keeps producing) — and deliberately NOT called
 *  "shadowed", because that word already names rule ①.
 *
 *  READ-ONLY: `guardReadingTarget` is the WRITE path and it ARCHIVES. A wake
 *  must never move or delete anybody's data; it may only decline to act.
 *  Returns null when the reading is this member's — or when there is no
 *  evidence either way, which is the honest default AND the incident's own
 *  case: a brand-new member has no established window of its own for anything
 *  to contradict. */
function readingForeignForWake(memberId, snap) {
  try {
    const d = readingLag.decideReadingTarget({
      key: memberId,
      readingWindow: readingLag.windowOf(snap),
      windows: establishedWindows(),
      groupOf: windowGroupOf,
    });
    if (!d || d.action === 'write') return null;
    return d.action === 'refile' ? `these numbers are ${nameOf(d.key)}'s — ${d.reason}` : d.reason;
  } catch (e) {
    // A guard that cannot decide must not block — the same rule
    // guardReadingTarget states at its own catch ("writing as asked").
    console.warn('[usage] wake window check failed (acting anyway):', e.message);
    return null;
  }
}

/** THE ONE EDGE. Whatever produced a fresh reading for `memberId` calls this,
 *  and the two halves live HERE so a third producer cannot forget either:
 *
 *   ① RE-DECIDE the pools this member belongs to. `force` drops that pool's
 *      10 s event-KICK gate for this one call — the gate throttles per-record
 *      kicks, and a member's first reading is not a kick, it is the fact the
 *      whole decision was missing. The 180 s dwell belt is untouched, so this
 *      can no more oscillate than any other evaluation. DO NOT DELETE THIS AS
 *      REDUNDANT because half ② appears to cover it: it only looks that way
 *      when something is ARMED, since the pre-fire gate runs
 *      maybePoolAutoSwitch itself. With NOBODY armed — a live conversation on
 *      a spent member that has not hit the wall yet — half ① is the only
 *      thing that moves it (mutation-tested; test-new-member-wake §1c).
 *   ② RE-EXAMINE the conversations that are WAITING. Half ② is the incident's
 *      own shape: the conversations had ALREADY been parked on the newcomer
 *      since 02:18:33, so nothing switches — the per-session pass `continue`s
 *      long before it reaches its own fireNow — and a switch-driven nudge is
 *      therefore structurally unreachable. It fires only when the reading says
 *      the member can actually serve; "the pool moved somebody else" is half
 *      ①'s business and that path already nudges.
 *
 *      HALF ② SERVES ONLY THE CONVERSATIONS NOTHING COULD MOVE (r2). It fires
 *      a session only when a continue would land ON `memberId` and would have
 *      landed there BEFORE half ① ran too — i.e. exactly the shape the
 *      paragraph above describes. Round 1 filtered on pool MEMBERSHIP and
 *      fired anyway, which spent a real turn in three measured shapes:
 *        · a MANUAL pool (`auto:false`) — half ① returns at the top of
 *          maybePoolAutoSwitchForPool, so the link never moves; the continue
 *          bills the spent member and the card called that member "recovered".
 *        · a REMOTE session (`s.host`) — the per-session pass skips it BY
 *          DESIGN, same outcome.
 *        · a COLD pool (`hot:false`) — the pool RESTARTS such a conversation
 *          through the client (`pool-auto-switched`) precisely because its CLI
 *          cannot re-read credentials, and master's only other fireNow call
 *          site guards that same spend with `if (a.hot)`.
 *      The pre-fire gate cannot catch any of them: `quotaVerdictFor` answers a
 *      POOLED scope with "any member usable", which is true and beside the
 *      point. The fact half ② needs is the one this module already names —
 *      `fireIdentityFor`, "where would a continue land right now" — asked
 *      twice, because "the wake moved it there" and "it was already there" are
 *      different worlds and only the second is half ②'s. When half ① DOES move
 *      a conversation, that path fires it itself for a hot pool (:2417) and
 *      restarts it through the client for a cold one.
 *      WHAT THE COLD RULE COSTS, deliberately: a cold pool's conversation is
 *      released by the TIMED path at its armed reset rather than early. That is
 *      latency; firing anyway is money, spent on whichever member the CLI still
 *      holds — the restart is a CLIENT action, so with no browser connected
 *      nothing restarts and the link says one thing while the CLI bills
 *      another. Nothing in this process knows whether a client obeyed a restart
 *      broadcast, and guessing is worse than waiting.
 *
 *  "No reading" is a REFUSAL TO ACT, never a verdict of 0%. */
function onMemberReadingFresh(memberId, why = 'reading', { at = Date.now() } = {}) {
  const out = { member: memberId || null, why, acted: false, reason: null, detail: null, pools: [], fired: [], skipped: [] };
  try {
    if (!memberId || typeof memberId !== 'string') { out.reason = 'no-member'; return out; }
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(path.join(USAGE_CACHE_DIR, memberId.replace(/[^\w.-]/g, '_') + '.json'), 'utf-8')); } catch { }
    if (!snap) { out.reason = 'no-reading'; return out; }
    const age = at - (Number(snap.fetchedAt) || 0);
    if (!(age >= 0) || age > MEMBER_READING_FRESH_MS) { out.reason = 'stale-reading'; return out; }
    const foreign = readingForeignForWake(memberId, snap);
    if (foreign) { out.reason = 'foreign-reading'; out.detail = foreign; return out; }
    // THE FLOOR IS STAMPED ONLY WHEN WE ACT. A declined wake costs one file
    // read; stamping it would let a producer that called a millisecond before
    // its own cache write eat the wake the real one needed.
    const last = _memberWakeAt.get(memberId) || 0;
    if (at - last < MEMBER_WAKE_FLOOR_MS) { out.reason = 'wake-floor'; return out; }
    _memberWakeAt.set(memberId, at);
    if (_memberWakeAt.size > 512) _memberWakeAt.delete(_memberWakeAt.keys().next().value);
    out.acted = true;

    const pools = memberPoolsOf(memberId);
    const ar = getAutoResume();
    // WHERE A CONTINUE WOULD LAND, PER WAITING CONVERSATION, *BEFORE* HALF ①
    // IS ALLOWED TO MOVE ANYTHING (r2). Half ② serves only the conversations
    // nothing could move, and that is a fact about the world before the
    // re-decide — read after it, "the wake moved this session onto the new
    // member" is indistinguishable from "it was already parked there", and the
    // first of those is a spend half ① has already accounted for (it fires a
    // hot pool itself and restarts a cold one through the client).
    // MEASURED HONESTLY: deleting this snapshot changes no outcome TODAY —
    // auto-resume refuses the second fire on its own (`session._arFiring` is
    // raised for the whole gate, and a delivered continue deletes the arm), so
    // the mutant delivers the same one continue with the same card. It stays
    // because half ②'s money-safety must not be OWED to another module's
    // private in-flight flag, and because the skip is what makes half ②'s
    // contract ("only what nothing could move") testable rather than a
    // sentence in a comment. test-new-member-wake §8f drives the interlock
    // itself, so this claim is not decorative.
    const landedBefore = new Map();
    if (ar && ar.armedIds && ar.fireNow) {
      let ids0 = [];
      try { ids0 = ar.armedIds() || []; } catch { }
      for (const id of ids0) {
        const s0 = activeSessions.get(id);
        if (!s0) continue;
        try { landedBefore.set(id, fireIdentityFor(s0)?.key || null); } catch { landedBefore.set(id, null); }
      }
    }
    for (const p of pools) {
      out.pools.push(p.id);
      try { maybePoolAutoSwitchForPool(p.id, { force: true }); } catch (e) { console.warn(`[pool] wake re-decide ${p.id} failed:`, e.message); }
    }

    let usable = null;
    try { usable = quotaVerdict(poolReadCache()(memberId), at / 1000, { tier: 'hot' }).usable; } catch { }
    if (usable !== true) { out.reason = 'member-not-usable'; return out; }
    if (!ar || !ar.fireNow || !ar.armedIds) { out.reason = 'no-auto-resume'; return out; }
    const poolIds = new Set(pools.map((p) => p.id));
    let ids = [];
    try { ids = ar.armedIds() || []; } catch { }
    for (const id of ids) {
      const s = activeSessions.get(id);
      if (!s) continue;
      const acct = s._accountId || null;
      if (acct !== memberId && !poolIds.has(acct)) continue;
      // THE CONTINUE MUST LAND ON THE MEMBER THAT BECAME USABLE, AND MUST
      // ALREADY HAVE BEEN GOING TO (r2 — see the header). `fireIdentityFor` is
      // this module's ONE answer to "where would a continue land right now"
      // (it is auto-resume's own `fireIdentity` dep, so attemptFire re-resolves
      // the very same fact); asking pool MEMBERSHIP instead billed a spent
      // member and then called it recovered. A session armed DURING this wake
      // is absent from the snapshot and is therefore skipped — whatever armed
      // it did so having already seen this reading.
      let landsOn = null;
      try { landsOn = fireIdentityFor(s)?.key || null; } catch { }
      const before = landedBefore.has(id) ? landedBefore.get(id) : null;
      // A COLD pool RESTARTS the conversation through the client instead of
      // trusting the CLI to re-read its credentials — master's only other
      // fireNow call site guards its spend with exactly this (:2417), and the
      // restart is a CLIENT action: with no client connected nothing restarts,
      // the link says one member and the running CLI still holds another's
      // credentials. "The link points at the member that recovered" is
      // therefore not enough to know where a continue would BILL.
      // HOTNESS IS THE CAPS-GATED VERDICT, NEVER THE RAW FLAG (r3, reproduced):
      // `a.hot` is a WISH the user's checkbox persists; whether the pool can
      // act on it is `capsOf(backend).hotSwitch === 'verified'`, and the
      // pool-level path computes exactly that before its own `if (hot)` spend
      // (:2391/:2417). `capsOf('codex').hotSwitch` is 'impossible' (the 2026-
      // 08-24 experiment: CODEX_HOME is canonicalized at startup and the
      // tokens live in process memory), so a codex pool ALWAYS cold-restarts —
      // and a codex pool carrying `hot:true` is persisted state, not a
      // hypothesis: manage-agents offered that row un-gated until 2026-09-05
      // and PATCH /api/accounts/pool/:id still writes the flag with no caps
      // gate, so the setting is inert everywhere else and nobody had a reason
      // to unset it. Reading the raw flag here let the capability gate deliver
      // the very spend the pool-level path refuses.
      const pa = poolIds.has(acct) ? accounts.get(acct) : null;
      const cold = !!(pa && pa.type === 'pooled' && !(pa.hot && capsOf(pa.backend).hotSwitch === 'verified'));
      const why2 = landsOn !== memberId ? 'lands-elsewhere' : before !== memberId ? 'the wake moved it' : cold ? 'cold pool — it restarts instead' : null;
      if (why2) { out.skipped.push({ id, landsOn, before, why: why2 }); continue; }
      try {
        if (ar.fireNow(id, `${nameOf(memberId)} 已恢复可用`, { cause: 'member-usable' })) out.fired.push(id);
      } catch (e) { console.warn('[auto-resume] wake fire failed:', e.message); }
    }
    for (const k of out.skipped) {
      console.log(`[pool] member wake ${nameOf(memberId)}: left ${k.id} alone (${k.why}) — a continue there would have landed on ${nameOf(k.landsOn) || 'nobody'}`);
    }
    if (out.pools.length || out.fired.length) {
      console.log(`[pool] member wake ${nameOf(memberId)} (${why}): re-decided ${out.pools.length} pool(s), continued ${out.fired.length} waiting conversation(s)`);
    }
    global.__vsEvent?.('member-wake', `${memberId}:${why}:${out.fired.length}`);
    return out;
  } catch (e) {
    console.warn('[pool] member wake failed:', e.message);
    out.reason = 'error';
    return out;
  }
}

/** THE LOGIN HALF. A login succeeding is also a QUOTA EVENT: the member that
 *  just logged in has no reading, and "no usage data" is exactly what the pool
 *  and auto-resume saw for the subscription the owner added mid-exhaustion.
 *
 *  §ban-safety: ONE read through the EXISTING caps-routed rung
 *  (probeQuotaForKey → claude's `refreshViaCliPanel`, i.e. `claude -p /usage`
 *  with the official binary making the fetch; codex's app-server twin). No new
 *  vendor surface, and it is the HUMAN'S OWN LOGIN ACTION that triggers it —
 *  the same class as the ⟳ button, not a timer. Bounded twice over: the
 *  finalize routes gate on the credential FINGERPRINT of the answer they
 *  already hold (a polled route may not carry an unbounded side effect), and
 *  this floor is the belt.
 *
 *  The wake runs even when the read did NOT answer: a login landing is itself
 *  new information about the roster, and half ① costs local file reads. */
async function onMemberLoginSuccess(memberId, why = 'login success') {
  if (!memberId || typeof memberId !== 'string') return { ok: false, reason: 'no-member', wake: null };
  const now = Date.now();
  if (now - (_loginReadAt.get(memberId) || 0) < LOGIN_READ_FLOOR_MS) return { ok: false, reason: 'login-read-floor', wake: null };
  _loginReadAt.set(memberId, now);
  if (_loginReadAt.size > 512) _loginReadAt.delete(_loginReadAt.keys().next().value);
  let probe = null;
  try { probe = await probeQuotaForKey(memberId); } catch (e) { probe = { ok: false, reason: e.message }; }
  if (!probe || !probe.ok) console.log(`[pool] ${nameOf(memberId)}: login succeeded but the usage read did not answer (${probe?.reason || 'unknown'}) — re-examining the pool anyway`);
  const wake = onMemberReadingFresh(memberId, why, {});
  return { ok: !!(probe && probe.ok), probe, wake };
}

/** THE SHARED ATTEMPT CLOCK. The auto-cli loop and the login edge spawn the
 *  SAME `claude -p /usage` through the SAME rung, so two attempt clocks race:
 *  the loop would spawn a second panel seconds after the login edge already
 *  did. The loop folds this into its own `lastAttemptAt`. */
function lastMemberReadAt(id) { return _loginReadAt.get(id) || 0; }

/** NOT READY IS NOT FAILED. The auto-cli loop skipped on the roster's
 *  `loggedIn`, which is `parseAuth`'s boolean: TRUE the moment an accessToken
 *  string exists in the file, whatever its expiry — so a credential file whose
 *  access AND refresh tokens have both expired reads as "logged in", the panel
 *  spawn cannot possibly answer, and every failure doubles a backoff that never
 *  had a chance. That is the satisfiable gap `src/login-state.js` exists to
 *  close, asked here through the same credential-FILE reader the pool's slot
 *  validation already uses.
 *
 *  THE FILE READER IS THE RIGHT ONE (not `accountLoginState`): this rung is
 *  `refreshViaCliPanel`, which DELETES CLAUDE_CODE_OAUTH_TOKEN from the child's
 *  env and points CLAUDE_SECURESTORAGE_CONFIG_DIR at the account's own dir, so
 *  a long-lived token cannot serve it — the credential file is literally the
 *  only thing that can.
 *
 *  MEASURED BOUNDARY: the "member has no credentials at all" half was ALREADY
 *  covered (parseAuth answers loggedIn:false when the file is absent, and the
 *  journal shows no auto-cli attempt for the new member before its login
 *  landed), and the incident's 02:18:40 failure happened with `loggedIn` TRUE —
 *  the loop's own gate let it through — so this guard is NOT claimed to be what
 *  would have prevented that particular failure count. It closes the adjacent,
 *  reachable hole. */
function autoCliReady(id) {
  const st = memberLoginState(id);
  return !st || st.usable !== false; // null = not a claude sub / unreadable roster ⇒ never block
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
/** Switch CANDIDATES. Two filters with deliberately different escape hatches:
 *  · CREDENTIAL STATE is a HARD exclusion (2026-09-07) — `poolMembers()` keeps
 *    a member whose access AND refresh tokens have both expired, because
 *    `parseAuth` reports loggedIn:true for it (it only nulls the accessToken),
 *    and `ensureSessionPoolLink` would happily point a conversation at it.
 *    Moving a session onto credentials that cannot authorize a request is not
 *    "routing around a dead account", it IS the dead account — so there is no
 *    fallback here: an all-unusable pool returns EMPTY and decidePoolSwitch's
 *    `no-members` says so loudly, which is the state only the user can fix.
 *  · an auth-FAILURE mark is a live inference (10min TTL, cleared by a token
 *    change), so it keeps its 2.335.0 escape: every member marked means the
 *    marks are wrong more likely than the pool is dead — let quota speak. */
function healthyPoolMembers(poolId) {
  const usable = (accounts.poolMembers(poolId) || []).filter((m) => { const st = memberLoginState(m.id); return !st || st.usable; });
  const ok = usable.filter((m) => !memberAuthFailed(m.id));
  return ok.length ? ok : usable;
}
/** Candidates for a DECISION, as opposed to an ACT (integration r2). Same
 *  auth-failure escape as healthyPoolMembers and NO login pre-filter — the
 *  login verdict is decidePoolSwitch's own gate (poolReadLogin now folds both
 *  readers, so the exclusion is identical) and it can only NAME the members it
 *  was shown. Pre-filtering them out turned "Re-login those accounts in
 *  Manage Agents" back into "wait until a window resets": the wall the user
 *  can clear in 30 seconds, reported as a spent quota bucket.
 *  Use this wherever the list feeds decidePoolSwitch; use healthyPoolMembers
 *  wherever the list is a set of re-point targets to act on. */
function switchCandidates(poolId) {
  const all = accounts.poolMembers(poolId) || [];
  const ok = all.filter((m) => !memberAuthFailed(m.id));
  return ok.length ? ok : all; // the 2.335.0 auth-fail escape, unchanged
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
    // WHY it failed, in the words that name the user's actual fix. When the
    // member's refresh token expired we KNOW the cause (the file says so) and
    // the CLI's own message ("OAuth session expired and could not be
    // refreshed") is about an unrecoverable login, not a transient API error —
    // saying "failing authentication" there sends the user to check the
    // network. Any other shape keeps today's wording verbatim.
    const li = (() => { try { return accounts.loginStateOf(memberId); } catch { return null; } })();
    const loginDead = li && !loginUsable(li);
    // STATE-branched (round-3 verifier's last low): a wiped ('logged-out') file
    // whose deadline is still ahead must not be narrated as an expiry in the
    // past — the deadline is quoted only once it has really passed.
    const why = loginDead
      ? `${loginWallPhrase(li)}${(typeof li.msLeft === 'number' && li.msLeft <= 0 && li.refreshExpiresAt) ? ` (login session ended ${new Date(li.refreshExpiresAt).toISOString()})` : ''} — re-login needed`
      : info.message ? String(info.message).slice(0, 120) : `HTTP ${info.status}`;
    if (!memberAuthFailed(memberId)) {
      _memberAuthFail.set(memberId, { at: now, reason: why, tok: credsTokenSig(memberId) });
      try { global.__vsEvent?.('pool-member-auth-failed', { detail: `${memberId}: ${why}` }); } catch { }
    }
    const memberName = accounts.get(memberId)?.name || memberId;
    // same rule as healthyPoolMembers: an evicted session may not be moved onto
    // credentials that cannot authorize a request (2026-09-07)
    const alive = healthyPoolMembers(poolId).filter((m) => m.id !== memberId);
    if (!alive.length) {
      serverNotice(`pool-authfail-stuck-${memberId}-${Math.floor(now / 3600000)}`,
        `Pool "${a.name}": account ${memberName} ${loginDead ? why : `is failing authentication (${why})`} and no other member can take over — re-login or replace it in Manage Agents.`, { level: 'warn' });
      return;
    }
    const ranked = rankPoolMembers({ members: alive, readCache: poolReadCache(poolId), nowSec: now / 1000, readLogin: poolReadLogin() });
    const to = (ranked[0] && ranked[0].id) || alive[0].id;
    const toName = accounts.get(to)?.name || to;
    const hasOwnLink = (() => { try { fs.lstatSync(accounts.sessionPoolLinkPath(poolId, sid)); return true; } catch { return false; } })();
    if (hasOwnLink) accounts.ensureSessionPoolLink(poolId, sid, to, { why: 'auth-failure' });
    const defaultMoved = accounts.poolCurrent(poolId) === memberId;
    if (defaultMoved) accounts.setPoolTarget(poolId, to, { why: 'auth-failure' });
    _poolSwitchAt.set(poolId + ':' + sid, now); // keep the quota pass's dwell belt consistent with this move
    try { recordUsageAttribution({ claudeSessionId: session.claudeSessionId || session.backendSessionId, accountId: poolId }); } catch { }
    if (now - (_authNoticeAt.get(memberId) || 0) > 60000) {
      _authNoticeAt.set(memberId, now);
      serverNotice(`pool-authfail-${memberId}-${now}`,
        `Pool "${a.name}": account ${memberName} ${loginDead ? why : `is failing authentication (${why})`} — switched to ${toName}.${a.hot ? '' : ' Restarting the conversation to apply it.'}`, { level: 'warn' });
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

function maybePoolAutoSwitchForPool(poolId, { force = false } = {}) {
  try {
    if (!poolId) return;
    const a = accounts.get(poolId);
    if (!a || a.type !== 'pooled' || !a.auto) return;
    const now = Date.now();
    // `force` is the new-member wake (onMemberReadingFresh) and NOTHING else:
    // this gate throttles per-RECORD kicks, and a member's first reading is not
    // a kick — it is the fact the whole decision was missing. The 180s dwell
    // belt below is deliberately NOT forced, so an evaluation forced here can
    // no more oscillate than any other one.
    if (!force && (now - (_poolAutoLast.get(poolId) || 0)) < 10000) return; // event-driven kicks need a tight gate; anti-flap = MIN_GAIN, not cadence
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
    // DECISION list, not an act list (integration r2): auth-failed members are
    // not candidates (2.335.0), but a login-dead member must still REACH
    // decidePoolSwitch so its refusal can name it and prescribe the re-login.
    const members = switchCandidates(poolId);
    const readLogin = poolReadLogin(); // ONE login read per member for this whole tick (per-session pass + pool decision)
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
      const ds = decidePoolSwitch({ currentId: curFor, members, readCache: projected, nowSec: now / 1000, proactive: hot, hot, pessimism: darkTaintedAccounts(), exclude: rejected, readLogin, reserveFloorPct: reserveFloorPct(), overageIds: overageMemberIds(members), explain: true });
      if (!ds || !ds.to) {
        // "there is nowhere for this conversation to go" is the state only the
        // USER can fix. The FACT is handed to auto-resume every time (it is
        // the ONLY source for the breaker's "no usable member left" clause —
        // a refusal reason does not imply it, and round 1 said it anyway);
        // the operator's line below stays throttled to once per 10min.
        const noWay = ds && (ds.reason === 'all-rejected' || ds.reason === 'no-members' || ds.reason === 'stuck' || ds.reason === 'all-logins-expired');
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
      // A DEAD LOGIN is hard death, so it is exempt from the dwell belt exactly
      // like a hard-exhausted target: every turn on that member fails, and the
      // belt exists to stop voluntary oscillation, not to delay an escape.
      // (Its `fromRemaining` is often null — quota says nothing about a login.)
      if (now - lastS < 180000 && ds.reason !== 'login-expired' && !(ds.fromRemaining != null && ds.fromRemaining < POOL_HARD_PCT)) continue;
      _poolSwitchAt.set(dwellKey, now);
      try {
        accounts.ensureSessionPoolLink(poolId, sid, ds.to, { why: 'per-session-switch' });
        try { recordUsageAttribution({ claudeSessionId: s2.claudeSessionId || s2.backendSessionId, accountId: poolId }); } catch { }
        const toName = accounts.get(ds.to)?.name || ds.to;
        // a same-target re-point (observed ≠ linked, the link was already on
        // the chosen member) is not a user-visible switch: journal + the
        // creds-mtime bump that makes the CLI re-read the link, no notice
        // SCRAPS (round-2 verifier): this conversation had nowhere else to go
        // and landed on a member whose OWN login dies in minutes. The move is
        // right (zero minutes was the alternative) but silence about it would
        // read as "it recovered", and it dies again shortly after.
        const sScraps = ds.toLoginNear
          ? ` — but ${toName}'s own login ${typeof ds.toLoginNear.msLeft === 'number' && ds.toLoginNear.msLeft > 0 ? `expires in ${loginAgeText(ds.toLoginNear.msLeft)}` : 'expires imminently'}; re-login it in Manage Agents now`
          : '';
        if (ds.to !== linkCur) serverNotice(`pool-sess-${sid}-${now}`, `Pool "${a.name}": conversation "${convName(s2, sid)}" moved to ${toName}${cm.divergent ? ` (it was still running on ${nameOf(curFor)})` : ''}${fam ? ` (its ${fam} quota${ds.fromRemaining != null ? ` was at ${Math.round(ds.fromRemaining)}%` : ''})` : ''}${a.hot ? '' : ' — restarting it'}${sScraps}`);
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
    const d = decidePoolSwitch({ currentId, members, readCache, nowSec: now / 1000, proactive: hot, hot, pessimism: darkTaintedAccounts(), readLogin, reserveFloorPct: reserveFloorPct(), overageIds: overageMemberIds(members), explain: true });
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
      if (d.reason === 'stuck' || d.reason === 'no-members' || d.reason === 'no-settleable' || d.reason === 'all-logins-expired') {
        // The sentence itself is PURE (poolBlockedNotice in account-pool-auto):
        // it names WHICH buckets are dead ("every member is out of quota" is
        // wrong under the nested model and points at pay/wait-a-week when the
        // truth is "one model's weekly cap is spent while the 7-day budget
        // still has 40% left"), keeps each login-blocked member stating its
        // OWN fact, and — round-3 verifier — gives the CURRENT member's dead
        // login its own clause + the re-login remedy instead of rendering it
        // as a spent quota bucket with "wait for a window to reset".
        // It lives there, not here, so the suite can assert the STRING.
        serverNotice(`pool-blocked-${poolId}-${d.reason}-${Math.floor(now / 3600000)}`,
          poolBlockedNotice(d, { poolName: a.name, currentName: nameOf(currentId) }), { level: 'warn' });
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
    if (now - lastSwitch < 180000 && d.reason !== 'login-expired' && !(d.fromRemaining != null && d.fromRemaining < POOL_HARD_PCT)) return; // dead login = hard death, same exemption
    _poolSwitchAt.set(poolId, now);
    _poolAutoLast.set(poolId, now);
    accounts.setPoolTarget(poolId, d.to, { why: 'pool-switch' });
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
    // SCRAPS (round-2 verifier): the only member left was itself minutes from
    // its login deadline. Moving beats staying on a dead member, but the user
    // has to hear that the reprieve is short — otherwise the pool "recovers"
    // and dies again with no explanation.
    const scraps = d.toLoginNear
      ? ` — but ${d.toName}'s own login ${typeof d.toLoginNear.msLeft === 'number' && d.toLoginNear.msLeft > 0 ? `expires in ${loginAgeText(d.toLoginNear.msLeft)}` : 'expires imminently'}; re-login it in Manage Agents now`
      : '';
    serverNotice(`pool-auto-${poolId}-${now}`, d.reason === 'edf'
      ? `Pool "${a.name}" switched to ${d.toName} — draining the member whose weekly quota resets soonest (use-it-or-lose-it)`
      : d.reason === 'login-expired'
      ? `Pool "${a.name}" switched to ${d.toName} — ${nameOf(currentId)}'s ${(() => { try { const l = accounts.loginStateOf(currentId); return l ? loginWallPhrase(l) : 'login session expired'; } catch { return 'login session expired'; } })()}; re-login it in Manage Agents${hot ? '' : ' (restarting its conversations)'}${scraps}`
      : `Pool "${a.name}" auto-switched to ${d.toName} (previous account down to ${fromPct}% remaining)${hot ? '' : ' — restarting its conversations'}${scraps}`);
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
    onMemberReadingFresh, onMemberLoginSuccess, readingForeignForWake, memberPoolsOf, autoCliReady, lastMemberReadAt, // THE NEW-MEMBER WAKE (2026-09-08): the one edge every producer of a fresh reading takes, its login half, and the two facts the auto-cli loop asks before it spends a spawn
    _memberWakeAt, _loginReadAt, MEMBER_WAKE_FLOOR_MS, MEMBER_READING_FRESH_MS, LOGIN_READ_FLOOR_MS, // the wake's floors are WALL-CLOCK: a suite winds them back instead of sleeping through them (same seam as _poolAutoLast)
    maybeRepinLockedModel, maybeStopOnFallback, modelsMatch,
    poolChooserForModel, poolReadCache, probeUsageForAccountKey,
    noteSessionProduced, noteTurnEnd, noteWallSignal, beforeAutoResumeFire, quotaVerdictFor, probeUsageViaSession, recordRateLimitEvent, recordCodexQuotaSignal, resolveUsageKey,
    probeQuotaForKey, quotaSourceFor, quotaBackendFor, // S4 caps-routed quota probe + the per-harness QuotaSignalSource lookup (functional seams for test-quota-source)
    overageState, readRawUsageCache, reserveFloorPct, overageMemberIds, spendGuard, // the ONE overage reader, the two voluntary-move bars (D2/D3) and THE SPEND CEILING (§4.4c)
    observedMemberFor, sessionBillingMember, wallKeyFor, rejectionSlotFor, readingSlotFor, corroborateReading, memberLoginState, accountCredentialState, healthyPoolMembers, switchCandidates, poolReadLogin, slotTransitions, nearArmVeto, fireIdentityFor, demoteWalledAccount, wallCount, sessionWalledMembers,
    _wallRing, _sessionWalls, OBSERVED_ORG_RECENT_MS, WALL_RING_MS, SESSION_WALL_MS, // wall-ground-truth + token-slot + session-wall seams (test-auto-resume §11, test-auto-resume-loop)
    _poolAutoLast, _poolSwitchAt, // the eval gate (10s) + dwell belt (180s) are WALL-CLOCK: a suite winds them back instead of sleeping through them
    sessionModelFor, sweepUsageAnchors, usageCacheKeyFor,
    usageIdentityAccountIds, usageIdentityGroups, usageIdentityGroupsCached,
    writeUsageCacheForKey, clearSealedOrders, pushSealedOrders,
    estOverlayCache, predictCalib,
  };
}
module.exports = { create };
