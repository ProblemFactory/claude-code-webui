'use strict';
/**
 * quota-model.js — PURE (imports nothing, CJS so the bundle and the shipped
 * statusline tool can both carry it): THE TYPED LIMIT SET.
 *
 * WHAT WENT WRONG WITHOUT IT (three incidents, one root). Every quota reading
 * this product has ever taken was flattened into a HAND-SHAPED snapshot object
 * — `{fiveHour, sevenDay, scopedWeekly[], overage, spend, …}` — written by nine
 * producers with nine different merge policies and read by loose field access
 * all over the tree. That object cannot express what the vendors actually send:
 *
 *  (a) B-9213 — MORE THAN ONE LIMIT PER ACCOUNT. The codex app-server pushes a
 *      SEPARATE `rate_limits_updated` per limit, interleaved on one session.
 *      Measured on this instance's own buffers (sess-13, 208 pushes in one
 *      conversation): limitId `codex` (the plan, one 10080-min window, 5 %…
 *      100 %) 32×, `codex_bengalfox` / "GPT-5.3-Codex-Spark" (300-min + 10080-
 *      min, 0 %/0 %) 149×, and `premium` (no windows at all) 27×. All three
 *      were collapsed into ONE cache file, last-writer-wins: the file on disk
 *      while this was written held the Spark limit at 0 %/0 % and the plan
 *      limit was simply GONE. A panel flips 5 %→0 % between renders; a pool
 *      reading it sees headroom that does not exist.
 *  (b) B-8b12 — AN EMPTY WINDOW REPORTS A SLIDING RESET. A window that has not
 *      started answers `resetsAt = now + windowDuration` at EVERY read. Same
 *      corpus, 328 empty-window readings: `resetsAt − (measuredAt + window)`
 *      lands in [−489 s, −8 s], median −40 s, and 144 of 149 consecutive reads
 *      carry a DIFFERENT resetsAt. The panel printed it as a precise reset time
 *      (the owner read it as a banked reset being consumed), EDF would rank it
 *      as the soonest deadline forever, and auto-resume would arm on it. The
 *      same corpus's 125 genuinely-running readings sit ≥ 1151 s from the full
 *      window and their reset is PINNED (5 distinct values over 129 reads) —
 *      a 662-second dead band, which is what `EMPTY_WINDOW_JITTER_SEC` sits in.
 *  (c) claude's model-scoped cap exists for ONE family (owner: "除了 fable，没有
 *      模型 specific 的用量限制的") and lives in a `scopedWeekly[]` array beside
 *      the plan buckets; codex has no equivalent shape at all. Every reader
 *      special-cased both, so every reader had its own idea of "the account's
 *      remaining" and of "the account's deadline".
 *
 * THE MODEL. One account key holds a LIMIT SET: a list of LIMITS, each with its
 * own id, scope, provenance and WINDOWS. Nothing collapses; a producer that
 * knows about one limit updates one limit (`mergeLimitSets`); every reader asks
 * the SAME accessor which limit governs the model it is about to spend on
 * (`limitFor`), and `remaining()` / `deadline()` refuse to count a window that
 * has not started.
 *
 *   { identity, fetchedAt, source, limits: [ {
 *       limitId, name, scope:'plan'|'model'|'credits'|'overage',
 *       model, family,
 *       windows: [ { kind:'5h'|'7d'|'monthly'|<other>, minutes, usedPct,
 *                    resetsAt, state:'running'|'empty'|'unknown', measuredAt } ],
 *       flags: { reached, spendControl, overageInUse },
 *       source, fetchedAt } ],
 *     extra }                      // opaque harness fields the legacy view carries
 *
 * WHY IT IS PURE. Three consumers need the identical rules and only one of them
 * has a checkout: the orchestrator (write path, pool, panels), the browser
 * bundle (the three quota panels), and — like `reading-lag.js` before it — the
 * shipped statusline capture tool, which is a SINGLE FILE on hosts with no
 * `src/`. A rule with an import is a rule that cannot be mirrored.
 *
 * WHAT THIS MODULE MAY NOT DO. It never reads a file, never names an account by
 * inference, and never invents a window: a payload that states nothing produces
 * `state:'unknown'`, which every consumer must treat as "no claim" — never as
 * zero, never as full. (`P6`, docs/design-account-hardening.md §3.)
 */

// ── constants ───────────────────────────────────────────────────────────────

/** The window kinds we can put a duration to without being told. Everything
 *  else keeps whatever `minutes` the payload stated (0 = not stated). */
const WINDOW_MINUTES = Object.freeze({ '5h': 300, '7d': 10080 });

/** THE EMPTY-WINDOW TOLERANCE (B-8b12, measured — see the header).
 *  A window is EMPTY when nothing has been spent in it AND its reset is still
 *  a full window away, i.e. it is sliding with the clock rather than naming a
 *  deadline. The number sits inside a 662-second dead band measured on this
 *  instance's own corpus (empty readings ≤ 489 s of elapsed window, running
 *  readings ≥ 1151 s), and it is deliberately placed on the EMPTY side of that
 *  band: calling a running-but-0 % window empty costs only its deadline (it has
 *  full headroom either way), while calling an empty window running re-creates
 *  the incident — a sliding reset becomes an EDF deadline and an auto-resume
 *  arm time, every single read. */
const EMPTY_WINDOW_JITTER_SEC = 600;

/** THE SAME-WINDOW TOLERANCE. Two producers spell ONE window up to a minute
 *  apart (the on-demand panel and the event stream), so `reading-lag.js` has
 *  compared windows at ±120 s since 2.369.73; this is that number, and the two
 *  must stay equal — a wall judged at a different tolerance than a reading is
 *  two answers to one question, the defect class this whole file exists to
 *  end. scripts/test-quota-model.mjs pins them together. */
const WINDOW_JITTER_SEC = 120;

const SCOPES = Object.freeze(['plan', 'model', 'credits', 'overage']);
const STATES = Object.freeze(['running', 'empty', 'unknown']);

// ── small helpers (no imports, so they live here) ───────────────────────────

// `Number(null)` is 0 and `Number('')` is 0 — in a quota model those are the
// difference between "the vendor told us this window is untouched" and "the
// vendor said nothing", which is the single most load-bearing distinction here
// (P6: ignorance is never a claim). So absence is spelled out before the cast.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function posNum(v) { const n = num(v); return n != null && n > 0 ? n : null; }
function str(v) { const s = v == null ? '' : String(v); return s ? s : null; }
function lower(v) { return String(v == null ? '' : v).toLowerCase(); }

/** Minutes for a window: what the payload said, else what the kind implies. */
function minutesOf(kind, stated) {
  const m = num(stated);
  if (m != null && m > 0) return m;
  return WINDOW_MINUTES[kind] || 0;
}

// ── windows ─────────────────────────────────────────────────────────────────

/** IS THIS WINDOW RUNNING, EMPTY, OR UNSTATED? (B-8b12.)
 *
 *  'empty'   — nothing spent AND the reset is (within jitter) exactly one full
 *              window from the moment we measured it. That is not a deadline:
 *              it is the vendor saying "this window starts at your first
 *              request", and it moves every time you ask.
 *  'running' — anything spent, or a reset that has visibly PINNED (it is closer
 *              than a full window away, so the window opened at some earlier
 *              request and the boundary is now a real instant).
 *  'unknown' — no usage figure, or no reset, or no duration to compare against.
 *              We were not told; we do not guess.
 *
 *  Note the asymmetry on purpose: `elapsed <= jitter` also catches a NEGATIVE
 *  elapsed (a reset further out than one full window — clock skew between the
 *  vendor and us). Skew cannot make an empty window look running. */
function windowState(win, { jitterSec = EMPTY_WINDOW_JITTER_SEC } = {}) {
  if (!win || typeof win !== 'object') return 'unknown';
  const used = num(win.usedPct);
  const resetsAt = posNum(win.resetsAt);
  if (used == null || resetsAt == null) return 'unknown';
  if (used > 0) return 'running';
  const minutes = minutesOf(str(win.kind), win.minutes);
  const measuredAt = posNum(win.measuredAt);
  if (!minutes || measuredAt == null) return 'unknown';
  const elapsed = Math.round(measuredAt / 1000) + minutes * 60 - resetsAt;
  return elapsed <= jitterSec ? 'empty' : 'running';
}

/** Build a window record, stamping its own state. `measuredAt` is WHEN WE WERE
 *  TOLD (ms) — the only clock the empty test may use, because the question is
 *  "how far into this window was the vendor when it answered". */
function makeWindow({ kind, minutes = null, usedPct = null, resetsAt = null, measuredAt = null, status = null }, opts = undefined) {
  const k = str(kind) || 'other';
  const stated = num(minutes) != null && num(minutes) > 0;
  const w = {
    kind: k,
    minutes: minutesOf(k, minutes),
    // DID THE PAYLOAD STATE ITS OWN DURATION? codex does (`window_minutes` /
    // `windowDurationMins`); claude never has — its 5h/7d durations are implied
    // by the bucket NAME. The distinction is not pedantry: `toLegacyView` may
    // only re-emit what a producer stated, or the projection invents a
    // `windowMinutes` on a claude bucket, and the next reader's shape detection
    // reads that file as codex (reproduced — it flipped a limit-banner mark's
    // whole bucket).
    minutesStated: stated,
    usedPct: num(usedPct),
    resetsAt: posNum(resetsAt),
    measuredAt: posNum(measuredAt),
    state: 'unknown',
  };
  if (status) w.status = String(status);
  w.state = windowState(w, opts);
  return w;
}

/** Remaining percent for ONE window, or null when it makes no claim.
 *  A reset that already passed means the window rolled over since we read it —
 *  the stale utilization is meaningless and the window is full again (the
 *  `bucketRemaining` rule this model inherits, verbatim). */
function windowRemaining(win, nowSec) {
  if (!win || typeof win !== 'object') return null;
  const reset = posNum(win.resetsAt);
  const now = num(nowSec) != null ? num(nowSec) : Math.floor(Date.now() / 1000);
  if (reset != null && reset < now) return 100;
  const used = num(win.usedPct);
  if (used == null) return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 100) / 100));
}

// ── limits ──────────────────────────────────────────────────────────────────

function makeLimit({ limitId, name = null, scope = 'plan', model = null, family = null, windows = [], flags = null, source = null, fetchedAt = null }, opts = undefined) {
  return {
    limitId: String(limitId),
    name: str(name),
    scope: SCOPES.includes(scope) ? scope : 'plan',
    model: str(model),
    family: str(family),
    windows: (Array.isArray(windows) ? windows : []).map((w) => (w && w.state && ('kind' in w) ? w : makeWindow(w || {}, opts))),
    flags: flags && typeof flags === 'object' ? { ...flags } : {},
    source: str(source),
    fetchedAt: posNum(fetchedAt),
  };
}

function makeLimitSet({ identity = null, fetchedAt = null, source = null, limits = [], extra = null } = {}) {
  return {
    identity: str(identity),
    fetchedAt: posNum(fetchedAt),
    source: str(source),
    limits: (Array.isArray(limits) ? limits : []).filter(Boolean),
    ...(extra && typeof extra === 'object' ? { extra: { ...extra } } : {}),
  };
}

const EMPTY_SET = Object.freeze({ identity: null, fetchedAt: null, source: null, limits: Object.freeze([]) });

function limitsOf(set) { return set && Array.isArray(set.limits) ? set.limits : []; }
function windowsOf(limit) { return limit && Array.isArray(limit.windows) ? limit.windows : []; }
function windowOfKind(limit, kind) { return windowsOf(limit).find((w) => w && w.kind === kind) || null; }

// ── the validator ───────────────────────────────────────────────────────────

/** REJECT A MALFORMED SET, WITH THE REASONS. Called at the write path, which
 *  refuses loudly rather than persisting a shape the readers cannot read. The
 *  point is not paranoia: nine producers write this store, and the ones that
 *  broke it did so by writing a field NOBODY declared. */
function validateLimitSet(set) {
  const errors = [];
  if (!set || typeof set !== 'object' || Array.isArray(set)) return { ok: false, errors: ['not an object'] };
  if (set.identity != null && typeof set.identity !== 'string') errors.push('identity must be a string or null');
  if (set.fetchedAt != null && !(Number.isFinite(Number(set.fetchedAt)) && Number(set.fetchedAt) > 0)) errors.push('fetchedAt must be a positive number');
  if (set.source != null && typeof set.source !== 'string') errors.push('source must be a string or null');
  if (!Array.isArray(set.limits)) return { ok: false, errors: errors.concat('limits must be an array') };
  const ids = new Set();
  set.limits.forEach((l, i) => {
    const at = `limits[${i}]`;
    if (!l || typeof l !== 'object') { errors.push(`${at} is not an object`); return; }
    if (typeof l.limitId !== 'string' || !l.limitId) errors.push(`${at}.limitId must be a non-empty string`);
    else if (ids.has(l.limitId)) errors.push(`${at}.limitId '${l.limitId}' is a duplicate — a set holds one record per limit`);
    else ids.add(l.limitId);
    if (!SCOPES.includes(l.scope)) errors.push(`${at}.scope must be one of ${SCOPES.join('|')} (got ${JSON.stringify(l.scope)})`);
    if (l.fetchedAt != null && !(Number.isFinite(Number(l.fetchedAt)) && Number(l.fetchedAt) > 0)) errors.push(`${at}.fetchedAt must be a positive number`);
    if (!Array.isArray(l.windows)) { errors.push(`${at}.windows must be an array`); return; }
    const kinds = new Set();
    l.windows.forEach((w, j) => {
      const wat = `${at}.windows[${j}]`;
      if (!w || typeof w !== 'object') { errors.push(`${wat} is not an object`); return; }
      if (typeof w.kind !== 'string' || !w.kind) errors.push(`${wat}.kind must be a non-empty string`);
      else if (kinds.has(w.kind)) errors.push(`${wat}.kind '${w.kind}' is a duplicate within one limit`);
      else kinds.add(w.kind);
      if (!STATES.includes(w.state)) errors.push(`${wat}.state must be one of ${STATES.join('|')} (got ${JSON.stringify(w.state)})`);
      if (w.usedPct != null && !(Number.isFinite(Number(w.usedPct)) && Number(w.usedPct) >= 0 && Number(w.usedPct) <= 100)) errors.push(`${wat}.usedPct must be 0..100 or null (got ${JSON.stringify(w.usedPct)})`);
      if (w.resetsAt != null && !(Number.isFinite(Number(w.resetsAt)) && Number(w.resetsAt) > 0)) errors.push(`${wat}.resetsAt must be a positive unix-seconds value or null`);
      if (w.minutes != null && !(Number.isFinite(Number(w.minutes)) && Number(w.minutes) >= 0)) errors.push(`${wat}.minutes must be a non-negative number`);
      if (w.minutesStated !== undefined && typeof w.minutesStated !== 'boolean') errors.push(`${wat}.minutesStated must be a boolean`);
      if (w.measuredAt != null && !(Number.isFinite(Number(w.measuredAt)) && Number(w.measuredAt) > 0)) errors.push(`${wat}.measuredAt must be a positive ms timestamp or null`);
    });
  });
  return { ok: !errors.length, errors };
}

// ── THE ONE ACCESSOR ────────────────────────────────────────────────────────

/** Does this limit name the model / family the caller is about to spend on?
 *  Matching is by the limit's own declared `model`/`family` first and only then
 *  by its human NAME, because a name is the vendor's marketing string
 *  ("GPT-5.3-Codex-Spark") while `family` is the coarse vocabulary the scoped
 *  weekly caps actually scope on. */
function limitNamesModel(limit, { model = null, family = null } = {}) {
  if (!limit) return false;
  const fam = lower(family), mdl = lower(model);
  if (fam && lower(limit.family) && lower(limit.family) === fam) return true;
  // CONTAINMENT RUNS ONE WAY ONLY: the limit's model name must be found IN the
  // served model, never the reverse. Measured shape — the served model
  // `gpt-5.3-codex` is a PREFIX of the Spark limit's `GPT-5.3-Codex-Spark`, so
  // a two-way test hands every plain codex turn the Spark limit, which is the
  // one limit that always reads 0 %. A limit governs a model when its own name
  // appears in that model's, not when it happens to start the same way.
  if (mdl && lower(limit.model) && mdl.includes(lower(limit.model))) return true;
  const nm = lower(limit.name);
  if (!nm) return false;
  if (fam && nm.includes(fam)) return true;
  if (mdl && mdl.includes(nm)) return true;
  return false;
}

/** Among plan-scope limits, THE one: prefer a limit that actually reported a
 *  window (this instance's codex `premium` limit reports none — 27 measured
 *  pushes, `primary` and `secondary` both null — and it must never displace the
 *  plan limit that does), then the freshest. */
function planLimit(set) {
  const plans = limitsOf(set).filter((l) => l && l.scope === 'plan');
  if (!plans.length) return null;
  const withWindows = plans.filter((l) => windowsOf(l).length);
  const pool = withWindows.length ? withWindows : plans;
  return pool.slice().sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))[0] || null;
}

/** THE ONE ACCESSOR every reader uses: which limit governs a spend on this
 *  model? The model-scoped limit when one names the model or its family,
 *  otherwise the plan limit. It never collapses two limits into a guess and it
 *  never invents one — `null` means this set says nothing. */
function limitFor(set, { model = null, family = null } = {}) {
  if (model || family) {
    const scoped = limitsOf(set).filter((l) => l && l.scope === 'model' && limitNamesModel(l, { model, family }));
    if (scoped.length) return scoped.slice().sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))[0];
  }
  return planLimit(set);
}

/** EVERY limit that constrains a spend on this model — the plan limit AND the
 *  model-scoped one, because both apply at once (a model cap is a component of
 *  the plan window, not an alternative to it). This is the list `remaining()`
 *  mins over, and it is why a Spark bucket at 0 % can never grant headroom the
 *  plan bucket does not have (B-9213). Credits/overage limits are NOT here:
 *  they are money, not quota, and they get their own surfaces. */
function applicableLimits(set, { model = null, family = null } = {}) {
  const out = [];
  const plan = planLimit(set);
  if (plan) out.push(plan);
  if (model || family) {
    for (const l of limitsOf(set)) {
      if (l && l.scope === 'model' && limitNamesModel(l, { model, family }) && !out.includes(l)) out.push(l);
    }
  } else {
    // No model stated ⇒ every model cap still binds SOME request on this
    // account, and the pool's account-level gate has always been the min across
    // every known bucket. Keeping that is the conservative direction.
    for (const l of limitsOf(set)) if (l && l.scope === 'model' && !out.includes(l)) out.push(l);
  }
  return out;
}

// ── remaining / deadline (empty windows do not count) ───────────────────────

/** DOES THIS BUCKET COUNT? The ONE predicate every reader outside this module
 *  asks about an empty window, in the LEGACY spelling too (the derived view
 *  stamps `state` on the bucket for exactly this). An 'empty' window is not a
 *  constraint and not a deadline; 'unknown' is a bucket the payload never
 *  described. Both are "no claim", and the difference between them is only ever
 *  reported, never acted on. */
function bucketCounts(b) {
  if (!b || typeof b !== 'object') return false;
  return b.state === undefined || b.state === 'running';
}

/** WINDOWS THAT MAKE A CLAIM. An 'empty' window is not a constraint (nothing
 *  has been spent in it) and not a deadline (its reset slides), so it is
 *  excluded from BOTH answers — that is the whole of the B-8b12 fix. An
 *  'unknown' window makes no claim either. */
function countingWindows(limit) { return windowsOf(limit).filter((w) => w && w.state === 'running'); }

/** Remaining percent for a spend on this model = the MIN across every counting
 *  window of every applicable limit. `known:false` = this set cannot say, and
 *  callers must treat that as "no claim" (the pool's UNKNOWN_REMAINING_PCT
 *  rung), never as 0 and never as 100. */
function remaining(set, { model = null, family = null, nowSec = null } = {}) {
  const now = num(nowSec) != null ? num(nowSec) : Math.floor(Date.now() / 1000);
  let best = null, by = null, kind = null;
  for (const l of applicableLimits(set, { model, family })) {
    for (const w of countingWindows(l)) {
      const r = windowRemaining(w, now);
      if (r == null) continue;
      if (best == null || r < best) { best = r; by = l.limitId; kind = w.kind; }
    }
  }
  return { remaining: best, known: best != null, by, kind };
}

/** Per-window remainings, tagged — the reporting shape the pool's honest
 *  "which bucket is actually spent" message is built from. Empty windows are
 *  REPORTED (with their state) so a panel can say "starts on first use", but
 *  they carry `counts:false` so no ranking rule can pick them up by accident. */
function bucketReport(set, { model = null, family = null, nowSec = null } = {}) {
  const now = num(nowSec) != null ? num(nowSec) : Math.floor(Date.now() / 1000);
  const out = [];
  for (const l of applicableLimits(set, { model, family })) {
    for (const w of windowsOf(l)) {
      out.push({
        limitId: l.limitId, scope: l.scope, label: l.name || l.limitId,
        kind: w.kind, state: w.state, counts: w.state === 'running',
        remaining: w.state === 'running' ? windowRemaining(w, now) : null,
        resetsAt: w.state === 'running' ? (posNum(w.resetsAt) || 0) : 0,
      });
    }
  }
  return out;
}

/** THE BUDGET DEADLINE: the earliest FUTURE reset among the counting BUDGET
 *  windows (weekly and longer). The 5-hour window is a burst RATE limiter that
 *  refills ~33×/week, not a budget — ranking on it degenerates into noise, and
 *  that exclusion is inherited verbatim from `weeklyDeadline`. */
function isBudgetKind(kind) { return kind !== '5h'; }
function deadline(set, { model = null, family = null, nowSec = null } = {}) {
  const now = num(nowSec) != null ? num(nowSec) : Math.floor(Date.now() / 1000);
  let best = null;
  for (const l of applicableLimits(set, { model, family })) {
    for (const w of countingWindows(l)) {
      if (!isBudgetKind(w.kind)) continue;
      const r = posNum(w.resetsAt);
      if (r != null && r > now && (best == null || r < best)) best = r;
    }
  }
  return best;
}

// ── merge ───────────────────────────────────────────────────────────────────

/** Merge one window into an existing one: the NEWER measurement wins whole. A
 *  measurement without a `measuredAt` is treated as older than any that has
 *  one, so a shape-only lift of a legacy record can never displace a real read. */
function mergeWindow(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const a = posNum(prev.measuredAt) || 0, b = posNum(next.measuredAt) || 0;
  return b >= a ? next : prev;
}

function mergeLimit(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const windows = [];
  const byKind = new Map();
  for (const w of windowsOf(prev)) { byKind.set(w.kind, w); windows.push(w.kind); }
  for (const w of windowsOf(next)) {
    if (byKind.has(w.kind)) byKind.set(w.kind, mergeWindow(byKind.get(w.kind), w));
    else { byKind.set(w.kind, w); windows.push(w.kind); }
  }
  const newer = (posNum(next.fetchedAt) || 0) >= (posNum(prev.fetchedAt) || 0);
  return {
    limitId: next.limitId || prev.limitId,
    name: next.name != null ? next.name : prev.name,
    scope: newer ? next.scope : prev.scope,
    model: next.model != null ? next.model : prev.model,
    family: next.family != null ? next.family : prev.family,
    windows: windows.map((k) => byKind.get(k)),
    flags: { ...(prev.flags || {}), ...(next.flags || {}) },
    // PER-LIMIT PROVENANCE. The set-level `source`/`fetchedAt` answer "who
    // wrote this file last"; these answer "who produced THIS limit's numbers,
    // and when" — the only question a panel showing three limits side by side
    // can actually act on.
    source: newer ? (next.source || prev.source) : (prev.source || next.source),
    fetchedAt: Math.max(posNum(prev.fetchedAt) || 0, posNum(next.fetchedAt) || 0) || null,
  };
}

/** MERGE PER limitId. A producer that carries ONE limit updates ONE limit; the
 *  others are carried forward untouched. This is the whole of the B-9213 fix:
 *  the Spark push and the plan push are different facts about different limits
 *  and neither is news about the other.
 *
 *  Order is stable: prev's limits keep their positions, new limitIds append. */
function mergeLimitSets(prev, next) {
  const p = prev && Array.isArray(prev.limits) ? prev : EMPTY_SET;
  const n = next && Array.isArray(next.limits) ? next : EMPTY_SET;
  const order = [];
  const byId = new Map();
  for (const l of limitsOf(p)) { if (!byId.has(l.limitId)) order.push(l.limitId); byId.set(l.limitId, l); }
  for (const l of limitsOf(n)) {
    if (byId.has(l.limitId)) byId.set(l.limitId, mergeLimit(byId.get(l.limitId), l));
    else { order.push(l.limitId); byId.set(l.limitId, l); }
  }
  const limits = order.map((id) => byId.get(id));
  const fetchedAt = Math.max(posNum(p.fetchedAt) || 0, posNum(n.fetchedAt) || 0) || null;
  // The set-level source names whoever produced the NEWEST limit — never the
  // last writer to touch the file, which is exactly the collapse this replaces.
  let newest = null;
  for (const l of limits) if (l && (newest == null || (posNum(l.fetchedAt) || 0) > (posNum(newest.fetchedAt) || 0))) newest = l;
  const extra = (p.extra || n.extra) ? { ...(p.extra || {}), ...(n.extra || {}) } : null;
  return makeLimitSet({
    identity: n.identity != null ? n.identity : p.identity,
    fetchedAt,
    source: (newest && newest.source) || n.source || p.source,
    limits, extra,
  });
}

// ── panels: ordering + labels ───────────────────────────────────────────────

/** The order a panel shows limits in: the one governing the served model
 *  first, then the plan, then the rest by id — so the number the user is about
 *  to spend against is the one they read first. */
function orderLimits(set, { model = null, family = null } = {}) {
  const governing = limitFor(set, { model, family });
  const plan = planLimit(set);
  const rest = limitsOf(set).filter((l) => l !== governing && l !== plan);
  // QUOTA rows before MONEY rows: credits and overage are a different question
  // (dollars, not headroom) and a panel that interleaves them makes the user
  // read past them to find the number they came for.
  const moneyish = (l) => (l.scope === 'credits' || l.scope === 'overage') ? 1 : 0;
  rest.sort((a, b) => moneyish(a) - moneyish(b) || String(a.limitId).localeCompare(String(b.limitId)));
  return [governing, plan, ...rest].filter((l, i, arr) => l && arr.indexOf(l) === i);
}

/** A limit's display label WITHOUT i18n (the caller translates): the vendor's
 *  own name when it gave one, else the limit id. Never a fabricated pretty
 *  name — "GPT-5.3-Codex-Spark" is what the vendor calls it and what the user
 *  will see in the vendor's own UI. */
function limitLabel(limit) { return (limit && (limit.name || limit.limitId)) || ''; }

/** A limit's own headline state for a panel row, in ONE word each consumer
 *  translates: 'empty' (no window has started — "starts on first use"),
 *  'unknown' (nothing was stated), or 'running'. */
function limitState(limit) {
  const ws = windowsOf(limit);
  if (!ws.length) return 'unknown';
  if (ws.some((w) => w.state === 'running')) return 'running';
  if (ws.some((w) => w.state === 'empty')) return 'empty';
  return 'unknown';
}

// ── legacy view (both directions) ───────────────────────────────────────────
//
// THE LEGACY SNAPSHOT IS NOW A DERIVED VIEW. It is written BESIDE `limits` so
// every reader that has not migrated keeps working — but it is PROJECTED from
// the merged set, never computed by the producer, which is why a Spark push no
// longer flips a legacy reader's 5 % to 0 %: the projection always picks the
// plan limit's windows.

/** WHICH limit's windows the legacy `fiveHour`/`sevenDay` pair shows.
 *
 *  The plan limit, and normally that is the end of it. But an account can hold
 *  NO plan limit at all, and that is not a hypothetical: measured on this
 *  instance while writing this, `usage-cache/__global_codex__.json` held the
 *  `GPT-5.3-Codex-Spark` model limit and a `credits` limit and NOTHING ELSE —
 *  the plan limit had been overwritten away by B-9213 before the typed model
 *  existed to stop it. Projecting "the plan limit" there yields nothing, and a
 *  view that yields nothing DELETES the only numbers the file had (the write
 *  path clears a legacy bucket the view does not carry, so that a stale bucket
 *  can never outlive the model). The migration measurement caught exactly that:
 *  two real buckets on that file went to `undefined`, which every unmigrated
 *  reader — the pool, the panels, auto-resume — reads as "no reading".
 *
 *  So the fallback is the freshest limit that actually reports a plan-shaped
 *  window. That is not a guess: it is precisely what a legacy reader saw on
 *  that file BEFORE this change, because last-writer-wins is how the buckets
 *  got there. The typed `limits` beside it still say whose they are, so a
 *  migrated reader is never fooled — and the moment a real plan push arrives,
 *  the per-limit merge restores the plan limit and this fallback stops being
 *  used. NEVER invent: with no window-bearing limit at all this answers null
 *  and the view stays empty, which is the honest shape for a file that states
 *  no reading. */
function legacyWindowLimit(set) {
  const plan = planLimit(set);
  if (plan && windowsOf(plan).length) return plan;
  const bearing = limitsOf(set).filter((l) => l && (windowOfKind(l, '5h') || windowOfKind(l, '7d')));
  if (!bearing.length) return plan;
  return bearing.slice().sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))[0];
}

/** typed set → the historical `{fiveHour, sevenDay, scopedWeekly, …}` shape. */
function toLegacyView(set) {
  const out = {};
  const plan = legacyWindowLimit(set);
  const toBucket = (w) => {
    if (!w) return null;
    const b = { utilization: w.usedPct == null ? 0 : Math.max(0, Math.min(1, w.usedPct / 100)) };
    // `usedPercent` + `windowMinutes` are the CODEX spelling; a claude bucket
    // has only `utilization`, and adding the other two changes what the file
    // looks like to every shape-detecting reader. Re-emit what was stated.
    if (w.minutesStated) {
      if (w.usedPct != null) b.usedPercent = w.usedPct;
      if (w.minutes) b.windowMinutes = w.minutes;
    }
    if (w.resetsAt) b.resetsAt = w.resetsAt;
    if (w.status) b.status = w.status;
    if (w.resetsAtEstimated) b.resetsAtEstimated = true;
    // THE STATE RIDES THE LEGACY BUCKET (B-8b12). An 'empty' window is not a
    // constraint and not a deadline, and the readers that must not count it
    // (remaining/deadline/the window fingerprint/auto-resume's arm) key on
    // exactly this field. Emitting the bucket ANYWAY is deliberate: the panel
    // must still show the limit and say "starts on first use" — hiding a
    // vendor-reported limit would be a second kind of lie.
    if (w.state && w.state !== 'running') b.state = w.state;
    return b;
  };
  const f5 = toBucket(windowOfKind(plan, '5h'));
  const f7 = toBucket(windowOfKind(plan, '7d'));
  if (f5) out.fiveHour = f5;
  if (f7) out.sevenDay = f7;
  const scoped = [];
  for (const l of limitsOf(set)) {
    if (!l || l.scope !== 'model') continue;
    const w = windowOfKind(l, '7d') || windowsOf(l).find((x) => isBudgetKind(x.kind)) || null;
    if (!w) continue;
    const e = { name: l.name || l.limitId, utilization: w.usedPct == null ? 0 : Math.max(0, Math.min(1, w.usedPct / 100)) };
    if (w.resetsAt) e.resetsAt = w.resetsAt;
    if (w.status) e.status = w.status;
    if (w.resetsAtEstimated) e.resetsAtEstimated = true;
    if (w.state && w.state !== 'running') e.state = w.state;
    if (l.flags && l.flags.severity) e.severity = l.flags.severity;
    if (l.flags && l.flags.asOf) e.asOf = l.flags.asOf;
    scoped.push(e);
  }
  if (scoped.length) out.scopedWeekly = scoped;
  const over = limitsOf(set).find((l) => l && l.scope === 'overage');
  if (over && over.flags && Object.keys(over.flags).length) out.overage = { ...over.flags };
  if (set && set.fetchedAt) out.fetchedAt = set.fetchedAt;
  if (set && set.source) out.source = set.source;
  return out;
}

/** the historical shape → a typed set (the migration, and the read side of the
 *  write path: a cache file written before this model existed still has to
 *  merge). `kind` mapping is fixed: `fiveHour`→'5h', `sevenDay`→'7d', each
 *  `scopedWeekly[]` entry → its own model-scoped limit with a '7d' window.
 *
 *  `familyOf` is INJECTED (this module imports nothing): callers that know the
 *  family vocabulary pass `src/model-family.js`'s `familyOfScopedBucket`. */
function fromLegacy(legacy, { identity = null, source = null, fetchedAt = null, limitId = 'plan', familyOf = null, extraKeys = null } = {}) {
  const src = legacy && typeof legacy === 'object' ? legacy : {};
  const at = posNum(fetchedAt) || posNum(src.fetchedAt) || null;
  const srcName = str(source) || str(src.source);
  const limits = [];
  const planWindows = [];
  const bucket = (b, kind) => {
    if (!b || typeof b !== 'object') return null;
    // `utilization` FIRST. Both spellings appear on a codex bucket and they are
    // written together, but a producer that marks a bucket DEAD in place sets
    // only `utilization` (the wall/limit-banner mark does exactly that) — so
    // preferring `usedPercent` reads back the stale number the mark replaced.
    const usedPct = num(b.utilization) != null ? Math.max(0, Math.min(1, num(b.utilization))) * 100
      : num(b.usedPercent);
    const w = makeWindow({ kind, minutes: b.windowMinutes, usedPct, resetsAt: b.resetsAt, measuredAt: at, status: b.status });
    if (b.resetsAtEstimated) w.resetsAtEstimated = true;
    // A STORED STATE OUTRANKS A RE-DERIVED ONE. `windowState` needs the instant
    // the vendor answered, and a legacy bucket read back off disk usually has
    // only the FILE's `fetchedAt` — which is a different (later) clock the
    // moment a preserve-merge carried the bucket forward. The producer decided
    // 'empty' when it had the real measurement; re-deriving it here from a
    // borrowed clock is how a settled verdict would silently flip.
    if (STATES.includes(b.state)) w.state = b.state;
    return w;
  };
  const w5 = bucket(src.fiveHour, '5h'); if (w5) planWindows.push(w5);
  const w7 = bucket(src.sevenDay, '7d'); if (w7) planWindows.push(w7);
  if (planWindows.length) limits.push(makeLimit({ limitId, scope: 'plan', windows: planWindows, source: srcName, fetchedAt: at }));
  for (const s of Array.isArray(src.scopedWeekly) ? src.scopedWeekly : []) {
    if (!s || !s.name) continue;
    const w = bucket(s, '7d');
    if (!w) continue;
    const flags = {};
    if (s.severity) flags.severity = s.severity;
    if (s.asOf) flags.asOf = s.asOf;
    limits.push(makeLimit({
      limitId: 'model:' + lower(s.name).replace(/\s+/g, '-'),
      name: String(s.name), scope: 'model', model: String(s.name),
      family: familyOf ? familyOf(s.name) : null,
      windows: [w], flags, source: srcName, fetchedAt: posNum(s.asOf) || at,
    }));
  }
  if (src.overage && typeof src.overage === 'object') {
    limits.push(makeLimit({ limitId: 'overage', scope: 'overage', windows: [], flags: { ...src.overage }, source: srcName, fetchedAt: posNum(src.overage.asOf) || at }));
  }
  const extra = {};
  for (const k of Array.isArray(extraKeys) ? extraKeys : []) if (src[k] !== undefined) extra[k] = src[k];
  return makeLimitSet({ identity, fetchedAt: at, source: srcName, limits, extra: Object.keys(extra).length ? extra : null });
}


// ── THE WALL'S OWN ATTRIBUTION (inc-mttbrtc0-6049, 2026-09-08 23:47Z) ────────
// A REJECTION IS A READING, and until now it was the only one nobody asked
// "whose numbers are these". Measured on this instance's anchor streams, the
// incident reads like this (identities anonymised, times UTC):
//
//   ident-604088  23:43  on-demand         5h u=0.91  resets 00:19   ← its own
//                 23:46  rate-limit-event  5h u=1     resets 00:20   ← its own
//                 23:48  WALL              5h u=1     resets 03:30   ← FOREIGN
//                 23:53  on-demand         5h u=1     resets 00:20   ← restored
//   ident-e65fd1  23:42  on-demand         5h u=0.84  resets 03:30   ← ITS own
//                 23:47  rate-limit-event  5h u=0.84  resets 03:30
//
// The pool re-pointed that session's credential link twice inside ONE turn
// (23:44:48, 23:46:00, 23:46:36 — all three rows are in slot-transitions.jsonl,
// per session, with timestamps). The CLI re-read the credentials (2.1.257's
// mtime-gated `rpe()`) and its NEXT request — made with the member we had just
// moved TO — was rejected. `rejectionSlotFor` answers with the TURN PIN, i.e.
// the member the turn STARTED on, so the wall was written onto ident-604088:
// its panel read "resets 8:30pm" until the owner refreshed by hand, and it was
// demoted for three hours on another member's wall (a usable member excluded —
// this is money, not cosmetics).
//
// WHY THE EXISTING GUARD COULD NOT CATCH IT. `guardReadingTarget` (reading-lag
// rule ②) judges by the WEEKLY window only — 2.369.73 r2 measured that a
// five-hour reset names a TIME and not an ACCOUNT (47 distinct 5h resets shared
// across identities because they snap to the clock). That refutation stands and
// this rule does not touch it: the 5h window is still never asked WHO.
//
// WHAT IS SOUND, AND IS ALL THIS RULE CLAIMS. A window that is RUNNING cannot
// change its reset before it ends. So a stated reset that contradicts the
// target's own still-future window REFUTES that target — it does not identify
// anybody. Refutation needs no uniqueness, which is exactly why the r2
// measurement does not bite here.
//
// BUT NOT EVERY WINDOW REFUTES EQUALLY WELL, AND THE DIFFERENCE IS MEASURED
// (r2, the round-1 verifier's second finding — round 1 asserted the residue was
// small and cited a number measured on a DIFFERENT quantity: the drift between
// two CONSECUTIVE readings seconds apart, not the drift between a reading and
// its account's own on-demand stamp, which is what this rule actually compares
// and which can be hours old). Re-measured with the predicate the rule uses,
// over every claude anchor stream on this instance (7798 rows, the empty-window
// fence already applied, each account judged against its OWN last `on-demand`
// stamp — the only producer that writes the `.window-` sidecar):
//
//                       judged   refuted   of the refuted: states ANOTHER
//                                          account's own window at that instant
//   7d   own producer     4109      0        —
//        session prod.    1160      0        —
//   scoped own producer   4029      0        —
//        session prod.     700      0        —
//   5h   own producer     1706     13 0.76%  —
//        session prod.    1055    137 12.99%  101 = 73.72 %
//
// Read that table carefully, because it says two different things:
//
//  · A WEEKLY window (7d and every model-scoped bucket) never once contradicted
//    its own account, in 9998 judged readings across seven identities and a
//    month. It is a DECISIVE refuter, which is the same conclusion 2.369.73 r2
//    reached from the other direction when it made the weekly phase the only
//    identity evidence.
//  · A FIVE-HOUR window is EVIDENCE, not proof. Three quarters of the readings
//    it refutes state another account's own window at that very instant — those
//    are true positives, mis-filings of exactly the kind this rule exists to
//    catch — but a residue remains, and the honest bound on it is the OWN
//    PRODUCER row: 13 readings where an account's own `/usage` panel, which
//    cannot be mis-filed (its key and its credential dir are one decision),
//    stated a 5h reset its own previous stamp contradicts. Inspected, all 13 are
//    one account alternating A-B-A-B between two resets 90 minutes apart at a
//    constant 0.89 utilization — which is not "a window moved" but B-9213 in the
//    plan bucket: more than one limit collapsed into one field. Until that is
//    modelled per limit end to end we do not get to call the residue zero.
//
// THEREFORE, REFUTATION HAS A STRENGTH, AND IT IS THE WINDOW KIND'S (see
// `refutationStrength`). A weekly refutation may REFUSE the write on its own. A
// five-hour refutation may only CORROBORATE an identification the ledger made
// independently; on its own it leaves the pin exactly where it was and SAYS so.
// The asymmetry is the point: refusing a wall is not free either — an
// exhaustion mark that never lands means the pool keeps sending turns to a
// member the CLI has just refused, which is the same money in the other
// direction, and it is what `guardReadingTarget` warned about when it exempted
// walls in the first place. A 13 % false-refusal rate on 5h walls would have
// bought the panel fix with a new leak.
//
// THEREFORE: TWO INDEPENDENT WITNESSES. The identification comes from the
// LEDGER — `slotAt(sessionKeys, signal.at)`, our own first-class record of
// which member held that link at the instant the rejection arrived — and the
// window is only allowed to CORROBORATE it. Both must agree before a byte
// moves; either one silent leaves the turn pin exactly where it is. In the
// incident they agree unambiguously, from two unrelated stores.
//
// A WALL MAY NEVER OVERWRITE A MEMBER'S OWN ESTABLISHED WINDOW: when this rule
// says 'archive' the write does not happen at all, and no path here stamps a
// window sidecar (only the on-demand panel does, and that is deliberate —
// 2.369.73 r2 moved the established window OUT of the object every producer
// rewrites for precisely this reason).

/** Does an account's OWN established window REFUTE a stated reset?
 *
 *  TRUE only when all four hold, and each is load-bearing:
 *   · we have the account's own reset for that kind (no evidence ⇒ no refusal);
 *   · that window had NOT ended when the reading was taken — this is the whole
 *     physical claim ("a running window's reset cannot move"), and it is why
 *     `atSec` is the READING's clock and never `Date.now()`;
 *   · the reading STATES a reset (a guess is not a statement — see above);
 *   · they differ by more than the panel-vs-event wobble.
 *  Anything else is `false` = "this window has nothing to say", never a verdict. */
function windowRefutes(ownResetsAt, statedResetsAt, { atSec = null, jitterSec = WINDOW_JITTER_SEC } = {}) {
  const own = posNum(ownResetsAt);
  const stated = posNum(statedResetsAt);
  const at = posNum(atSec);
  if (own == null || stated == null || at == null) return false;
  if (own <= at) return false;                       // it had already ended: it may legitimately have moved
  return Math.abs(own - stated) > jitterSec;
}

/** HOW MUCH IS A REFUTATION BY THIS WINDOW WORTH? (r2, measured — the table is
 *  in the essay above.) Deliberately a FUNCTION OF THE WINDOW KIND and nothing
 *  else, so the answer cannot vary with the caller's mood:
 *
 *   'decisive'      — a WEEKLY window (7d, and every model-scoped bucket, which
 *                     is weekly by construction). 0 contradictions in 9998
 *                     judged readings on this instance's whole corpus. It may
 *                     REFUSE a write on its own.
 *   'corroborating' — the FIVE-HOUR window. 73.72 % of the readings it refutes
 *                     state another account's own window at that instant (true
 *                     positives), but its own account's own panel contradicted
 *                     itself 13 times in 1706 readings. It may confirm an
 *                     identification the LEDGER made independently; it may
 *                     never, alone, refuse a wall.
 *   'none'          — a kind we have measured nothing about. Unknown is not a
 *                     licence: no evidence, no refusal (P6).
 *
 *  A NEW KIND LANDS IN 'none' BY DEFAULT, on purpose. The next backend's bucket
 *  must earn 'decisive' with its own measurement, not inherit one taken on
 *  claude's weekly window. */
function refutationStrength(kind) {
  const k = lower(kind);
  if (k === 'sevenday' || k === '7d' || k === 'scoped' || k === 'weekly') return 'decisive';
  if (k === 'fivehour' || k === '5h') return 'corroborating';
  return 'none';
}

/** WHERE DOES THIS WALL BELONG? PURE, and deliberately conservative: it can
 *  only ever return the pin, one specific other member, or "write nowhere".
 *
 * @param {string} kind                 the BUCKET this rejection named
 *        ('fiveHour' | 'sevenDay' | 'scoped'). It selects how much the window's
 *        refutation is worth — see `refutationStrength`. An unmeasured kind
 *        refutes nothing at all.
 * @param {number|null} statedResetsAt  the reset the REJECTION stated (seconds).
 *        null/0 = the producer had none (the limit banner states no time —
 *        `parseLimitBanner` returns `{kind}` only) ⇒ no window evidence exists
 *        and the pin stands, which is today's behaviour for that producer.
 * @param {string} pinnedKey            `rejectionSlotFor` — the turn pin.
 * @param {string|null} ledgerKey       `slotAt(keys, signal.at)` — who held the
 *        link when the rejection ARRIVED. null = the ledger cannot say.
 * @param {boolean} ledgerIsSessionScoped  a default-only ledger hit is NOT an
 *        answer about THIS conversation (the r3 `ownLinkUnknown` rule).
 * @param {number|null} pinnedOwnResetsAt  the pin's own established window.
 * @param {number|null} ledgerOwnResetsAt  the candidate's own established window.
 * @param {number} atSec                when the rejection arrived (seconds).
 * @returns {{action:'write'|'refile'|'archive', key:string|null, reason:string}}
 */
function wallAttribution({
  kind = null, statedResetsAt = null, pinnedKey = null, ledgerKey = null, ledgerIsSessionScoped = false,
  pinnedOwnResetsAt = null, ledgerOwnResetsAt = null, atSec = null, jitterSec = WINDOW_JITTER_SEC,
} = {}) {
  const pin = str(pinnedKey) || null;
  if (!pin) return { action: 'archive', key: null, reason: 'no pinned target' };
  const stated = posNum(statedResetsAt);
  if (stated == null) return { action: 'write', key: pin, reason: 'the rejection states no reset — no window evidence' };
  const strength = refutationStrength(kind);
  if (strength === 'none') {
    return { action: 'write', key: pin, reason: `nothing is measured about a '${str(kind) || 'null'}' window's stability, so it refutes nothing (no evidence, no refusal)` };
  }
  if (!windowRefutes(pinnedOwnResetsAt, stated, { atSec, jitterSec })) {
    return { action: 'write', key: pin, reason: 'the pinned member\'s own window does not contradict this reset' };
  }
  // The pin is REFUTED. Identification is the ledger's job, never this window's.
  const led = str(ledgerKey) || null;
  const identified = !!led && ledgerIsSessionScoped && led !== pin;
  if (identified) {
    if (windowRefutes(ledgerOwnResetsAt, stated, { atSec, jitterSec })) {
      return { action: 'archive', key: null, reason: `this reset (${stated}) contradicts BOTH the pinned member's and the ledger's candidate's own windows` };
    }
    return { action: 'refile', key: led, reason: `the link moved to this member at ${atSec}s and its own window does not contradict the stated reset (${stated})` };
  }
  // NOBODY ELSE IS IDENTIFIED. What happens now is the whole point of measuring
  // the window kinds separately (r2): a refusal is not the free, conservative
  // option it looks like — a wall that never lands leaves the pool sending
  // turns to a member the CLI has just refused.
  if (strength === 'decisive') {
    return {
      action: 'archive', key: null,
      reason: led === pin
        // Both witnesses spoke and they contradict each other: one of them is
        // wrong and we cannot tell which. Refuse — the harm this rule exists to
        // stop is writing a foreign window onto a member, and doing nothing
        // never does that.
        ? `this reset (${stated}) contradicts the member's own unexpired window (${posNum(pinnedOwnResetsAt)}) but the ledger names that same member`
        : `this reset (${stated}) contradicts the pinned member's own unexpired window (${posNum(pinnedOwnResetsAt)}), and the slot ledger cannot say who held the link`,
    };
  }
  return {
    action: 'write', key: pin, disagrees: true,
    reason: `this reset (${stated}) contradicts the pinned member's own unexpired window (${posNum(pinnedOwnResetsAt)}), but a five-hour reset is only corroborating evidence (measured: its own account's panel contradicts itself too) and nothing else is identified — the pin stands`,
  };
}

module.exports = {
  // constants
  WINDOW_MINUTES, EMPTY_WINDOW_JITTER_SEC, WINDOW_JITTER_SEC, SCOPES, STATES, EMPTY_SET,
  // builders
  makeWindow, makeLimit, makeLimitSet,
  // validator
  validateLimitSet,
  // windows
  windowState, windowRemaining, minutesOf,
  // accessors
  limitsOf, windowsOf, windowOfKind, planLimit, limitFor, applicableLimits, limitNamesModel,
  remaining, deadline, bucketReport, countingWindows, isBudgetKind, bucketCounts,
  // merge
  mergeLimitSets, mergeLimit, mergeWindow,
  // panels
  orderLimits, limitLabel, limitState,
  // the wall's own attribution (inc-mttbrtc0-6049)
  windowRefutes, refutationStrength, wallAttribution,
  // legacy bridge
  toLegacyView, fromLegacy, legacyWindowLimit,
};
