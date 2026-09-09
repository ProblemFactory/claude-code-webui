'use strict';
// CODEX QuotaSignalSource (harness S4, docs/design-harness-plugins.md §2.4):
// everything the quota/pool engine needs to know about HOW the codex harness
// reports quota, in one object — the engine consults the harness registry,
// never a backend-id branch. Contract (shared by every harness):
//   normalize(raw, fetchedAt)  → {fiveHour, sevenDay, scopedWeekly?, …} | null
//   signalFromStream(record)   → a typed wall/quota signal | null
//   probe                      → capsOf(id).quotaProbe rung name | null
//   classifyAuthFailure(info)  → boolean (auth-class failure the pool routes around)
// PURE by construction (no I/O — every reading is passed in): the same file
// may run in the orchestrator, a test, or the device daemon.
//
// normalize() is the former usage-routes.js normalizeCodexRateLimit, moved
// here VERBATIM (2.368.18 P0 semantics: windows classify by LENGTH never by
// primary/secondary position; every exhaustion marker survives). The
// usage-routes export of the same name still resolves to THIS function.
const { capsOf } = require('../backend-caps.js');

function normalizeCodexRateLimit(raw, fetchedAt = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  // Windows are classified by their LENGTH, never by primary/secondary
  // position (P0 fix, design-backend-parity.md §0): codex 0.149.x switched to
  // a SINGLE-window shape where `primary` IS the weekly window (10080min,
  // secondary null) — the old positional mapping labeled weekly usage as the
  // 5h bucket on every current reading. Field names also differ per channel:
  // rollout snake_case `window_minutes`, live app-server push
  // `windowDurationMins` — read all three.
  const toWindow = (entry, fallbackWindowMinutes) => {
    if (!entry || typeof entry !== 'object') return null;
    const usedPercent = Number(entry.used_percent ?? entry.usedPercent);
    const normalizedPercent = Number.isFinite(usedPercent)
      ? Math.max(0, Math.min(100, usedPercent))
      : 0;
    return {
      utilization: normalizedPercent / 100,
      usedPercent: normalizedPercent,
      windowMinutes: Number(entry.window_minutes ?? entry.windowMinutes ?? entry.windowDurationMins ?? entry.window_duration_mins) || fallbackWindowMinutes || 0,
      resetsAt: Number(entry.resets_at ?? entry.resetsAt) || 0,
    };
  };

  let fiveHour = null, sevenDay = null;
  const bucketOfPos = {}; // raw position → the bucket it classified into
  for (const [pos, entry, fallback] of [['primary', raw.primary, 300], ['secondary', raw.secondary, 10080]]) {
    const w = toWindow(entry, fallback);
    if (!w) continue;
    // ≤ 8h = the burst window; anything longer = the weekly lane
    if (w.windowMinutes && w.windowMinutes <= 480) { if (!fiveHour) { fiveHour = w; bucketOfPos[pos] = w; } }
    else if (!sevenDay) { sevenDay = w; bucketOfPos[pos] = w; }
  }
  if (!fiveHour && !sevenDay) return null;

  // Exhaustion markers used to be DROPPED here — they are the entire signal a
  // pool auto-switch gates on (rate_limit_reached_type names WHICH raw window
  // tripped; spend_control/credits are the monthly-cap lane).
  const reached = raw.rate_limit_reached_type ?? raw.rateLimitReachedType ?? null;
  const spendControl = raw.spend_control_reached ?? raw.spendControlReached ?? null;
  const credits = raw.credits && typeof raw.credits === 'object' ? {
    hasCredits: !!(raw.credits.has_credits ?? raw.credits.hasCredits),
    unlimited: !!(raw.credits.unlimited),
    balance: String(raw.credits.balance ?? ''),
  } : null;
  if (reached && bucketOfPos[reached]) {
    const w = bucketOfPos[reached]; // tripped window reads as dead, whatever its %
    w.utilization = 1; w.usedPercent = 100; w.status = 'limited';
  }

  return {
    limitId: raw.limit_id || raw.limitId || 'codex',
    limitName: raw.limit_name || raw.limitName || '',
    planType: raw.plan_type || raw.planType || '',
    fiveHour,
    sevenDay,
    rateLimitReachedType: reached,
    spendControlReached: spendControl,
    credits,
    fetchedAt: Number(fetchedAt) || Date.now(),
  };
}

// The typed exhaustion enum the wrapper forwards on task_failed (codex
// `codex_error_info`; the UsageLimitReachedError family) — the pool
// auto-switch / auto-resume trigger. Lives HERE (the harness owns its own
// vocabulary); the engine only ever sees the classified signal.
//
// THE HISTORICAL SPELLING, KEPT VERBATIM AS THE SEED OF THE SET BELOW. It has
// never matched a single production record. RE-MEASURED 2026-09-08 (the counts
// being the ones a reader can reproduce today): across this instance's whole
// rollout corpus `codex_error_info` takes exactly THREE values —
// `usage_limit_exceeded` (102), `cyber_policy` (6), `unauthorized` (1) — and
// the regex below matches NONE of them. The live app-server lane sends the
// camelCase twin `usageLimitExceeded` (its own 0.153.4 schema documents the
// translation: "This translation layer make sure that we expose codex error
// code in camel case"); its record count in data/session-buffers is NOT
// reproducible from here — buffers rotate, and the incident thread's own was
// replaced the moment the owner resumed it. EXCEEDED, not REACHED. The app-server's own schema says so out loud:
// CodexErrorInfo is documented as "This translation layer make sure that we
// expose codex error code in camel case", variants contextWindowExceeded |
// sessionBudgetExceeded | usageLimitExceeded | rateLimitExceeded |
// serverOverloaded | cyberPolicy | ... (0.153.4 `codex app-server
// generate-json-schema`). ZERO occurrences of any name in the regex below.
// So codex auto-resume was structurally dead since 2.368.20 — the classifier
// never said 'exhausted', so nothing ever armed.
const EXHAUSTION_RE = /^(usage_limit_reached|quota_exceeded|usage_not_included|workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached|workspace_member_credits_depleted)$/;

/** ONE canonical spelling for a codex error enum. The SAME fact reaches us in
 *  two casings depending on which layer produced it (core's rollout writes
 *  snake_case, the app-server translates to camelCase), so the vocabulary is
 *  compared case- and separator-insensitively rather than kept as two lists
 *  that drift. */
const canonInfo = (x) => String(x || '').toLowerCase().replace(/[_-]/g, '');

/** THE closed set of "this identity is out of quota" enum values, SEEDED from
 *  the historical regex above (one list, not two) and extended with what the
 *  wire actually sends. DELIBERATELY NOT INCLUDED, each for a reason a
 *  continue would not fix:
 *    rateLimitExceeded      a transient 429 — the CLI retries; a billed
 *                           continue would land in the same second.
 *    sessionBudgetExceeded  the SESSION's own token budget, not an account
 *                           window: continuing this conversation hits it again
 *                           immediately and no reset ever arrives.
 *    contextWindowExceeded  a compaction problem, not a quota one.
 *  scripts/test-quota-source.mjs pins both directions. */
const EXHAUSTION_INFO = new Set([
  ...EXHAUSTION_RE.source.replace(/^\^\(/, '').replace(/\)\$$/, '').split('|'),
  'usage_limit_exceeded',   // codex-core's rollout spelling (102 records here)
  'usageLimitExceeded',     // the app-server's camelCase (the LIVE lane; see the note above)
].map(canonInfo));
/** Is this typed enum "the account is out of quota"? */
const isExhaustionInfo = (info) => EXHAUSTION_INFO.has(canonInfo(info));

/** THE ENUM'S SHAPE IS THE EMITTER'S DECISION, NOT THE SCHEMA'S — the r4
 *  lesson of the B3 batch, applied to the field this release turns on.
 *  MEASURED 2026-09-08 on this instance's own live buffer, verbatim:
 *      "codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}}
 *  CodexErrorInfo is a serde EXTERNALLY-TAGGED enum, so a variant that carries
 *  data arrives as a ONE-KEY OBJECT while a unit variant arrives as a bare
 *  string — and every fixture in this repo (and every reader before this
 *  function) assumed the string. `String({...})` is "[object Object]", which is
 *  TRUTHY, so the object form did not even fall through to the message ladder:
 *  it was read as an unknown enum and DROPPED, silently, which is precisely the
 *  failure mode this release exists to remove.
 *  HONEST BOUNDARY: whether `usageLimitExceeded` is itself a unit or a data
 *  variant in 0.153.4 could NOT be measured here — no such record survives in
 *  the buffers (the incident thread's own buffer rotated when it was resumed),
 *  and `codex app-server generate-json-schema` is a REJECTED oracle
 *  (src/local-oracles.js: measured opening 7 INET connections incl.
 *  chatgpt.com:443, even logged out), so asking it is a §ban-safety violation.
 *  Both shapes are therefore read rather than betting on one. The variant's own
 *  payload comes back with the name because the http variants PROVE a variant
 *  can carry fields (a reset time would ride exactly there).
 *  Returns { name, data } — name '' when nothing states an enum. */
function codexErrorEnum(x) {
  if (typeof x === 'string') return { name: x, data: null };
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { name: '', data: null };
  // internally tagged (`{type:'usageLimitExceeded', …}`) is checked FIRST: it
  // can also be a one-key object, and reading it as external would name the
  // TAG FIELD instead of the variant
  for (const k of ['type', 'kind', 'code']) if (typeof x[k] === 'string' && x[k]) return { name: x[k], data: x };
  const keys = Object.keys(x);
  if (keys.length === 1) { const v = x[keys[0]]; return { name: keys[0], data: v && typeof v === 'object' && !Array.isArray(v) ? v : null }; }
  return { name: '', data: null };
}

// WHEN THE WINDOW REOPENS, FROM THE CLI'S OWN SENTENCE. The measured
// exhaustion record carries `resetsAt: null` AND `rateLimits: null` — the only
// reset it states is PROSE:
//   "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
//    to purchase more credits or try again at Sep 13th, 2026 8:36 PM."
// and that sentence is exact: the same account's reading in that minute carried
// sevenDay.resetsAt = 1789356983 = Sun Sep 13 2026 20:36:23 local. This is the
// codex twin of ClaudeCodeAdapter.parseLimitBanner and it is a LAST RESORT —
// the engine prefers the account's own cached window (`v.blockedUntil`) and
// falls back to this only when there is none. The minute is truncated in the
// text, so we round UP by one: being a minute late costs one tick, being early
// spends a billed turn into a wall. Unmatched = 0 (never an invented wait). No
// timezone is stated and none is assumed beyond the server's own — the wrapper
// that produced the line runs on this machine.
const LIMIT_RESET_RE = /try again (?:at|on)\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i;
function parseCodexLimitReset(message, now = Date.now()) {
  const m = LIMIT_RESET_RE.exec(String(message || ''));
  if (!m) return 0;
  const cleaned = m[1].replace(/(\d{1,2})(?:st|nd|rd|th)/, '$1').replace(/,/g, '').replace(/\./g, '');
  const t = Date.parse(cleaned);
  if (!Number.isFinite(t)) return 0;
  const at = t + 60000;                        // the printed minute is truncated
  return at > now ? Math.floor(at / 1000) : 0; // a reset already past states nothing
}

// Which normalized window a `rate_limit_reached_type` tripped (the engine's
// exact rule since 2.368.20: primary→the burst window when present, else the
// weekly; secondary→the weekly, else the burst).
function trippedWindow(snap) {
  if (!snap || !snap.rateLimitReachedType) return null;
  return snap.rateLimitReachedType === 'primary' ? (snap.fiveHour || snap.sevenDay) : (snap.sevenDay || snap.fiveHour);
}

// OpenAI/codex auth-failure wording (design-backend-parity.md §2 item 5 —
// "codex 各写一个": the claude classifier keys on Anthropic phrasing).
// Sources: the typed `codex_error_info` enum (`unauthorized`), app-server
// error messages ("401 Unauthorized", "invalid_grant", "token has expired",
// "Not logged in", "account/organization … deactivated|suspended"), and
// HTTP 401/403 statuses. Like the claude rule, a lone first-attempt 401 is
// the mid-refresh-race shape and does NOT qualify; 5xx/429 never do.
const CODEX_AUTH_FAIL_RE = /\bunauthorized\b|invalid_grant|invalid[_ ]token|token (?:has )?(?:expired|been revoked)|refresh token.*(?:expired|invalid|revoked)|not logged in|login required|(?:account|organization|workspace).*(?:deactivated|suspended|disabled|banned)|insufficient permissions|forbidden/i;
function classifyAuthFailure({ status, message, attempt, codexErrorInfo } = {}) {
  const info = codexErrorEnum(codexErrorInfo).name.toLowerCase(); // the wire sends a string OR a one-key object (codexErrorEnum)
  if (info === 'unauthorized') return true; // the typed enum — never a race
  const msg = String(message || '');
  if (CODEX_AUTH_FAIL_RE.test(msg)) return true;
  const st = Number(status);
  if (st === 403) return true;
  if (st === 401) return (attempt || 0) >= 2;
  return false;
}

// Classify one wrapper stdout record. Accepts the server-side frame
// ({type:'event_msg', payload}) OR the bare payload the engine already holds.
// Returns null for anything that is not a quota/wall signal.
//   {source:'rate_limits_updated', kind:'reading'|'exhausted'|'probe-failed', snapshot, tripped, resetsAtMs, onDemand, error}
//   {source:'task_failed',         kind:'exhausted'|'auth-failure', errorInfo, resetsAtSec, resetsAtMs, snapshot}
//   {source:'reset_credit_result', kind:'recovered'|'reset-credit-failed', outcome, error}
function signalFromStream(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return null;
  const payload = record.type === 'event_msg' ? record.payload : record;
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return null;
  if (payload.type === 'rate_limits_updated') {
    if (!payload.rateLimits) return { source: 'rate_limits_updated', kind: 'probe-failed', snapshot: null, tripped: null, resetsAtMs: 0, onDemand: !!payload.onDemand, error: String(payload.error || 'no rateLimits in reply') };
    const snapshot = normalizeCodexRateLimit(payload.rateLimits, now);
    if (!snapshot) return { source: 'rate_limits_updated', kind: 'probe-failed', snapshot: null, tripped: null, resetsAtMs: 0, onDemand: !!payload.onDemand, error: 'unparseable rateLimits' };
    // stored reset-credit count rides ONLY the on-demand rateLimits/read
    // (owner ask: usage 展示剩余 reset) — keep it on the account snapshot
    if (payload.resetCredits) {
      const rc = payload.resetCredits;
      snapshot.resetCredits = { availableCount: Number(rc.availableCount ?? rc.available_count ?? rc?.summary?.availableCount) || 0 };
    }
    const tripped = trippedWindow(snapshot);
    return { source: 'rate_limits_updated', kind: tripped ? 'exhausted' : 'reading', snapshot, tripped, resetsAtMs: (Number(tripped?.resetsAt) || 0) * 1000, onDemand: !!payload.onDemand, error: null };
  }
  // The exhaustion/auth record reaches us as `task_failed` (the wrapper's
  // relay of the app-server `error` notification AND of a turn/completed whose
  // status is failed). `error` is accepted as a synonym so a wrapper that ever
  // forwards the notification unrenamed is understood rather than dropped —
  // one classifier, both spellings, no second reader.
  if (payload.type === 'task_failed' || payload.type === 'error') {
    // THE ENUM CAN BE NESTED. codex-core writes it inside the turn's `error`
    // object (`{message, codex_error_info}`) and the app-server inside
    // `turn.error`; the wrapper flattens what it can see. Read every measured
    // position rather than the one the first draft happened to meet.
    const enumRaw = payload.codexErrorInfo || payload.codex_error_info
      || payload.error?.codexErrorInfo || payload.error?.codex_error_info || null;
    const { name: errorInfo, data: enumData } = codexErrorEnum(enumRaw); // string OR the wire's one-key object (see codexErrorEnum)
    const message = String(payload.error?.message || (typeof payload.error === 'string' ? payload.error : '') || payload.message || '');
    if (!errorInfo) return null;
    if (isExhaustionInfo(errorInfo)) {
      // The reset, strongest evidence first: the record's own field, then the
      // rate-limit snapshot that rode along, then the CLI's own sentence.
      // MEASURED: the production record carries neither of the first two.
      const stated = Number(payload.resetsAt || payload.resets_at || enumData?.resetsAt || enumData?.resets_at) || 0;
      const snapshot = normalizeCodexRateLimit(payload.rateLimits || enumData?.rateLimits || enumData?.rate_limits, now);
      const fromSnap = Number(trippedWindow(snapshot)?.resetsAt) || 0;
      const resets = stated || fromSnap || parseCodexLimitReset(message, now);
      return { source: 'task_failed', kind: 'exhausted', errorInfo, message, resetsAtSec: resets, resetsAtMs: resets * 1000, snapshot };
    }
    if (classifyAuthFailure({ codexErrorInfo: errorInfo, message })) return { source: 'task_failed', kind: 'auth-failure', errorInfo, message, resetsAtMs: 0, snapshot: null };
    return null;
  }
  if (payload.type === 'reset_credit_result') {
    const outcome = payload.outcome || payload.result?.outcome || null;
    return { source: 'reset_credit_result', kind: outcome === 'reset' ? 'recovered' : 'reset-credit-failed', outcome, error: payload.error || null };
  }
  return null;
}

// ── THE TYPED LIMIT SET (src/quota-model.js) — B-9213 ───────────────────────
// THE MEASUREMENT THIS EXISTS FOR. The codex app-server pushes ONE
// `rate_limits_updated` PER LIMIT, interleaved on a single session. Counted on
// this instance's own buffers (sess-13, one conversation, 208 pushes):
//
//   limitId            limitName               windows                 pushes
//   codex              (null)                  primary 10080min        32   5 %…100 %
//   codex_bengalfox    GPT-5.3-Codex-Spark     primary 300 + sec 10080 149  0 %/0 %
//   premium            (null)                  NONE (both null)        27
//
// `normalizeCodexRateLimit` keeps `limitId` on the snapshot, but the snapshot
// is written to ONE cache file per account key, so the last push wins: the file
// on disk while this was written held the Spark limit at 0 %/0 % and the plan
// limit — the one at 5 % — had been overwritten out of existence. The panel
// flips between renders; a pool reading it sees headroom that does not exist.
//
// The typed set fixes it structurally: each limitId is its OWN limit, and
// `mergeLimitSets` merges per limitId, so a Spark push is not news about the
// plan. What each limit BECOMES:
//   • a limit whose `limitName` names a model  → scope 'model'  (Spark)
//   • anything else                            → scope 'plan'   (codex, premium)
//   • `credits`                                → its own 'credits' limit
//   • `spendControlReached`                    → a flag on the plan limit
// `premium` reports no windows at all in all 27 measured pushes; it is KEPT
// (a limit the vendor named is a fact) and `planLimit()` prefers a plan limit
// that actually carries a window, so it can never displace `codex`.
const quotaModel = require('../quota-model.js');

const CODEX_EXTRA_KEYS = ['limitId', 'limitName', 'planType', 'rateLimitReachedType', 'spendControlReached', 'credits', 'resetCredits'];

/** Which window kind is a codex window of `windowMinutes` minutes? The same
 *  LENGTH rule normalizeCodexRateLimit uses (never primary/secondary position —
 *  0.149.x moved the weekly window into `primary`), spelled once. */
function codexWindowKind(minutes) {
  const m = Number(minutes) || 0;
  if (!m) return 'other';
  return m <= 480 ? '5h' : '7d';
}

/** ONE `rate_limits_updated` payload's `rateLimits` object → a typed LimitSet
 *  carrying exactly ONE limit. `identity` is the account key; `source` names
 *  the producer (`codex-rate-limits` for the live app-server push,
 *  `limit-banner` for the task_failed rejection, `codex-rollout` for a
 *  transcript tail read) — a producer we ship always stamps its own name. */
function toLimitSet(raw, { identity = null, source = null, fetchedAt = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(fetchedAt) || Date.now();
  const limitId = String(raw.limit_id || raw.limitId || 'codex');
  const name = raw.limit_name || raw.limitName || null;
  const reached = raw.rate_limit_reached_type ?? raw.rateLimitReachedType ?? null;
  const windows = [];
  for (const [pos, entry, fallback] of [['primary', raw.primary, 300], ['secondary', raw.secondary, 10080]]) {
    if (!entry || typeof entry !== 'object') continue;
    const minutes = Number(entry.window_minutes ?? entry.windowMinutes ?? entry.windowDurationMins ?? entry.window_duration_mins) || fallback;
    const rawPct = Number(entry.used_percent ?? entry.usedPercent);
    let usedPct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : null;
    let status = null;
    // The tripped window reads as DEAD whatever its percentage says — the
    // exhaustion marker names WHICH raw position hit the wall, and dropping it
    // is what the pool auto-switch gates on (2.368.18 P0, kept verbatim).
    if (reached === pos) { usedPct = 100; status = 'limited'; }
    const kind = codexWindowKind(minutes);
    if (windows.some((w) => w.kind === kind)) continue; // one window per kind, first wins (the normalizer's own rule)
    windows.push(quotaModel.makeWindow({ kind, minutes, usedPct, resetsAt: entry.resets_at ?? entry.resetsAt, measuredAt: at, status }));
  }
  const flags = {};
  if (reached != null) flags.reached = reached;
  const spend = raw.spend_control_reached ?? raw.spendControlReached ?? null;
  if (spend != null) flags.spendControl = spend;
  const limits = [quotaModel.makeLimit({
    limitId,
    name: name || null,
    // A limit that NAMES a model is scoped to that model; everything else is a
    // plan limit. Never a guess from the id string — `codex_bengalfox` means
    // nothing, `GPT-5.3-Codex-Spark` is the vendor telling us what it governs.
    scope: name ? 'model' : 'plan',
    model: name || null,
    windows, flags, source, fetchedAt: at,
  })];
  const c = raw.credits;
  if (c && typeof c === 'object') {
    limits.push(quotaModel.makeLimit({
      limitId: 'credits', scope: 'credits', name: 'Credits', windows: [],
      flags: {
        hasCredits: !!(c.has_credits ?? c.hasCredits),
        unlimited: !!c.unlimited,
        balance: String(c.balance ?? ''),
      },
      source, fetchedAt: at,
    }));
  }
  if (!windows.length && !limits[0].flags.reached && limits.length === 1 && !name) {
    // `premium`-shaped: a limit the vendor named and reported NOTHING about.
    // Kept (it is a fact about the account), and it carries no windows, so no
    // reader can mistake it for headroom.
  }
  const extra = {};
  for (const k of CODEX_EXTRA_KEYS) {
    if (k === 'limitId') { extra.limitId = limitId; continue; }
    if (k === 'limitName') { if (name != null) extra.limitName = name; continue; }
    if (k === 'planType') { const p = raw.plan_type || raw.planType; if (p) extra.planType = p; continue; }
  }
  return quotaModel.makeLimitSet({ identity, fetchedAt: at, source, limits, extra: Object.keys(extra).length ? extra : null });
}

/** A legacy codex SNAPSHOT (what normalizeCodexRateLimit returns, i.e. what the
 *  cache files hold today) → a typed set. Used by the migration and by the
 *  write path when the previous file predates this model. */
function limitSetFromSnapshot(snap, { identity = null, source = null } = {}) {
  if (!snap || typeof snap !== 'object') return null;
  const at = Number(snap.fetchedAt) || Date.now();
  const src = source || snap.source || null;
  const limitId = String(snap.limitId || 'codex');
  const name = snap.limitName || null;
  const windows = [];
  for (const [kind, w] of [['5h', snap.fiveHour], ['7d', snap.sevenDay]]) {
    if (!w || typeof w !== 'object') continue;
    // `utilization` first, for the same reason quota-model's `fromLegacy` does:
    // the tripped-window mark rewrites both, but a caller that marks a bucket
    // dead in place may set only the fraction.
    const usedPct = Number.isFinite(Number(w.utilization)) ? Math.max(0, Math.min(1, Number(w.utilization))) * 100
      : (Number.isFinite(Number(w.usedPercent)) ? Number(w.usedPercent) : null);
    windows.push(quotaModel.makeWindow({ kind, minutes: w.windowMinutes, usedPct, resetsAt: w.resetsAt, measuredAt: at, status: w.status }));
  }
  const flags = {};
  if (snap.rateLimitReachedType != null) flags.reached = snap.rateLimitReachedType;
  if (snap.spendControlReached != null) flags.spendControl = snap.spendControlReached;
  const limits = [quotaModel.makeLimit({ limitId, name, scope: name ? 'model' : 'plan', model: name, windows, flags, source: src, fetchedAt: at })];
  if (snap.credits && typeof snap.credits === 'object') {
    limits.push(quotaModel.makeLimit({ limitId: 'credits', scope: 'credits', name: 'Credits', windows: [], flags: { ...snap.credits }, source: src, fetchedAt: at }));
  }
  const extra = {};
  for (const k of CODEX_EXTRA_KEYS) if (snap[k] !== undefined) extra[k] = snap[k];
  return quotaModel.makeLimitSet({ identity, fetchedAt: at, source: src, limits, extra: Object.keys(extra).length ? extra : null });
}

module.exports = {
  normalize: normalizeCodexRateLimit,
  signalFromStream,
  probe: capsOf('codex').quotaProbe, // 'rpc-rate-limits': account/rateLimits/read on a LIVE app-server
  classifyAuthFailure,
  // THE TYPED PRODUCERS (src/quota-model.js, B-9213) — the write path takes these
  toLimitSet, limitSetFromSnapshot, codexWindowKind, CODEX_EXTRA_KEYS,
  // named helpers for current callers / tests
  normalizeCodexRateLimit, EXHAUSTION_RE, trippedWindow,
  EXHAUSTION_INFO, isExhaustionInfo, canonInfo, codexErrorEnum, parseCodexLimitReset, LIMIT_RESET_RE,
};
