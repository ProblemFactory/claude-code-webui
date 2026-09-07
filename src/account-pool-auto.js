// Pooled pseudo-account AUTO-SWITCH decisions (B-6217 v2; EDF ranking v3).
// Pure functions — the engine in server.js feeds them the passive usage cache
// and acts on the verdict. ZERO API calls anywhere in this path (§ban-safety:
// decisions read data/usage-cache/*.json only — the cache the statusline hook
// / on-demand ⟳ already wrote; auto-switching must never become a scheduled
// quota poll).
//
// Semantics v3 (user-designed, 2026-08-09): quota is a PERISHABLE asset — any
// remaining expires at its window's reset. Drain the member whose weekly
// window resets SOONEST first (earliest-deadline-first): its quota is
// use-it-or-lose-it, while far-reset quota is storable. KEY FACT (user-
// confirmed + cache-verified ±1s): the model-scoped weekly caps (Fable) are
// COMPONENTS of the same 7-day window — same resetsAt — so each account has
// ONE weekly deadline and plain per-account EDF is optimal. The 5h bucket is
// a burst RATE limiter (refills ~33×/week), not a budget: it participates in
// the usability GATE only — ranking on it would degenerate into noise (every
// account's soonest reset would always be its 5h).
//
// Trigger tiers: exhaustion (<5% min-across-buckets) always switches; HOT
// pools additionally switch PROACTIVELY when another member's weekly deadline
// is strictly sooner (hot re-points are free — no restart; cold pools stay
// exhaustion-only because each switch restarts conversations).

const SWITCH_THRESHOLD_PCT = 5;
// PER-BUCKET-KIND thresholds (2.268.2, user-designed: what matters is
// ABSOLUTE headroom, not relative — 1% of a 7d window ≈ $17 vs 1% of a 5h
// window ≈ $2-5, so 5% weekly ≈ $87 of buffer while 10% of 5h can be one
// long turn). hot = soft-exhaustion trigger for HOT pools (free re-points);
// hard = genuinely-unusable / candidate gate / cold pools' only trigger.
const THRESH = {
  fiveHour: { hot: 10, hard: 5 },
  weekly: { hot: 5, hard: 3 }, // 7d + scoped (Fable) — big windows, more slack
};
// A member with NO usable usage data ranks as if half-full: better than a
// known-exhausted target, worse than a known-good one. Members without a
// known deadline (unknown data / reset just passed) rank AFTER every member
// with a real deadline — EDF needs a deadline to promise anything.
const UNKNOWN_REMAINING_PCT = 50;
// Proactive (hot) switches require the candidate's deadline to be sooner by a
// real margin — absorbs the ±1s scoped-vs-7d rounding and cache skew.
const PROACTIVE_MARGIN_SEC = 3600;
// Exhaustion-tier anti-flap: the target must beat the current member's
// remaining by this much (two members leapfrogging inside the exhaustion band
// otherwise ping-pong every evaluation tick).
const MIN_GAIN_PCT = 3;

// Remaining % for one bucket ({utilization: 0..1, resetsAt: unix seconds}).
// A reset that already PASSED means the window rolled over since the reading
// was captured — the stale utilization is meaningless and the bucket is full
// again (the passive cache only updates while a terminal session is active,
// so week-old readings are normal, not an error).
function bucketRemaining(b, nowSec) {
  if (!b || typeof b !== 'object') return null;
  const reset = Number(b.resetsAt) || 0;
  if (reset && reset < nowSec) return 100;
  const u = Number(b.utilization);
  if (!Number.isFinite(u)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - u) * 10000) / 100)); // 2-decimal: (1-0.9)*100 is 9.999999999999998
}

// Remaining % for one account's cache entry = min across every known bucket
// (INCLUDING 5h — this is the usability gate: a 5h-exhausted account is
// rate-limited right now no matter how attractive its weekly economics).
function accountRemaining(cache, nowSec) {
  if (!cache || typeof cache !== 'object') return { remaining: null, known: false };
  const buckets = [bucketRemaining(cache.fiveHour, nowSec), bucketRemaining(cache.sevenDay, nowSec)];
  for (const b of Array.isArray(cache.scopedWeekly) ? cache.scopedWeekly : []) buckets.push(bucketRemaining(b, nowSec));
  const known = buckets.filter((v) => v != null);
  if (!known.length) return { remaining: null, known: false };
  return { remaining: Math.min(...known), known: true };
}

// The account's ONE weekly deadline: earliest FUTURE reset among the budget
// buckets (7d + scoped weeklies). In practice they are the SAME timestamp
// (scoped caps are components of the 7d window); min() is robustness against
// rounding. null = no timing information (unknown data or all resets passed —
// a just-rolled-over window's next reset is unknowable from a stale cache).
function weeklyDeadline(cache, nowSec) {
  if (!cache || typeof cache !== 'object') return null;
  const cands = [];
  const push = (b) => { const r = Number(b?.resetsAt) || 0; if (r > nowSec) cands.push(r); };
  push(cache.sevenDay);
  for (const b of Array.isArray(cache.scopedWeekly) ? cache.scopedWeekly : []) push(b);
  return cands.length ? Math.min(...cands) : null;
}

// Per-bucket remainings tagged by KIND (fiveHour vs weekly) — the threshold
// unit of the 2.268.2 layered scheme.
function bucketRems(cache, nowSec) {
  if (!cache || typeof cache !== 'object') return [];
  const out = [];
  // `label` is REPORTING-only (kind drives every threshold) but it is what
  // makes an honest message possible: "every member is out of quota" was
  // flatly wrong under the nested model — the truth is usually "every
  // member's <one model>'s weekly cap is spent, the 7-day budget still has
  // 40% left", which points at a completely different user action.
  const push = (kind, b, label) => { const r = bucketRemaining(b, nowSec); if (r != null) out.push({ kind, remaining: r, label, resetsAt: Number(b?.resetsAt) || 0 }); };
  push('fiveHour', cache.fiveHour, '5h');
  push('weekly', cache.sevenDay, '7d');
  for (const b of Array.isArray(cache.scopedWeekly) ? cache.scopedWeekly : []) push('weekly', b, String(b?.name || 'model cap'));
  return out;
}

// Decide a switch for a pool. members = [{id, name}] (already login-filtered),
// readCache(id) → parsed cache entry or null. proactive/hot = hot pools:
// re-points are free, so they soft-exhaust at the RAISED per-kind thresholds
// and jump proactively toward sooner deadlines; cold pools only move at the
// hard thresholds (each switch restarts conversations). Returns null (stay)
// or {to, toName, fromRemaining, toRemaining, reason: 'exhausted'|'edf'}.
// pessimism = {accountId: pct} — OFFLINE-BIAS defense (2.297.0, design
// §Cross-device): an account whose spend partly flows through a machine that
// is ACTIVE but DARK (recent ledger events + link down) is systematically
// UNDER-estimated (its invisible burn keeps accruing), so its effective
// remaining is docked by pct on BOTH sides of a decision — the current
// target trips exhaustion earlier AND a dark-tainted candidate looks worse
// (switching ONTO invisible burn is as dangerous as staying on it).
// exclude = [accountId] — members this DECISION may not choose, whatever the
// caches say (2026-09-07 loop incident): a member that answered this exact
// session's continue with another limit rejection is not a candidate for the
// next 10 minutes. It is a per-SESSION fact (the per-session pass passes it;
// the pool-level decision never does) and it is deliberately separate from
// `pessimism`, which docks a percentage — "this one just said no to this
// conversation" is not a number, and docking it would let a big enough gap
// re-select it on the very next tick.
// EDF comparator — ONE implementation for the live decision AND the
// sealed-orders ranked snapshot the daemon holds (design §Pool management).
function edfCompare(a, b) {
  if (a.deadline != null && b.deadline != null) {
    if (Math.abs(a.deadline - b.deadline) > 60) return a.deadline - b.deadline;
    return b.eff - a.eff;
  }
  if (a.deadline != null) return -1;
  if (b.deadline != null) return 1;
  return b.eff - a.eff;
}

/** The ranked member snapshot pushed to the holding device (sealed orders):
 *  usable members in EDF order — the device executes a LOCAL fallback switch
 *  down this list only when it both sees a hard limit banner AND cannot
 *  reach the orchestrator. */
function rankPoolMembers({ members, readCache, nowSec }) {
  const out = [];
  for (const m of members) {
    const c = readCache(m.id);
    const r = accountRemaining(c, nowSec);
    const br = bucketRems(c, nowSec);
    if (r.known && br.some((b) => b.remaining < THRESH[b.kind].hard)) continue;
    out.push({ id: m.id, name: m.name, eff: r.known ? r.remaining : UNKNOWN_REMAINING_PCT, deadline: weeklyDeadline(c, nowSec) });
  }
  out.sort(edfCompare);
  return out;
}

function decidePoolSwitch({ currentId, members, readCache, nowSec, proactive = false, hot = proactive, pessimism = {}, exclude = null, explain = false }) {
  const excluded = exclude && exclude.length ? new Set(exclude) : null;
  // `explain` keeps the historical contract (null = no switch) for every
  // existing caller and test, while letting the engine ask WHY nothing
  // happened — a pool sitting on a dead account must not be silent.
  const none = (why, extra) => (explain ? { to: null, reason: why, ...extra } : null);
  // Which buckets are actually holding this decision back, by name.
  const bucketDetail = (brs) => ({
    deadBuckets: brs.filter((b) => b.remaining < THRESH[b.kind].hard).map((b) => `${b.label} ${Math.round(b.remaining)}%`),
    liveBuckets: brs.filter((b) => b.remaining >= THRESH[b.kind].hard).map((b) => `${b.label} ${Math.round(b.remaining)}%`),
  });
  const dock = (id, brs) => brs.map((b) => ({ ...b, remaining: Math.max(0, b.remaining - (pessimism[id] || 0)) }));
  const dockRem = (id, r) => (r.known ? { ...r, remaining: Math.max(0, r.remaining - (pessimism[id] || 0)) } : r);
  const curCache = readCache(currentId);
  const cur = dockRem(currentId, accountRemaining(curCache, nowSec)); // min% — display/scraps comparison
  const curDeadline = weeklyDeadline(curCache, nowSec);
  const curBr = dock(currentId, bucketRems(curCache, nowSec));
  const soft = (b) => b.remaining < (hot ? THRESH[b.kind].hot : THRESH[b.kind].hard);
  const dead = (b) => b.remaining < THRESH[b.kind].hard;
  // Per-KIND thresholds (user-designed): what matters is ABSOLUTE headroom —
  // a weekly bucket at 88% still holds ~$200, a 5h bucket at 90% one long
  // turn. exhausted = ANY bucket under its kind's (hot-raised) threshold.
  const exhausted = cur.known && curBr.some(soft);
  const hardDead = cur.known && curBr.some(dead);
  // No data on the current target → we cannot judge exhaustion; staying put is
  // safer than flapping on ignorance (the ledger will teach us eventually).
  if (!cur.known && !proactive) return none('no-data');
  if (!exhausted && !proactive) return none('healthy', { fromRemaining: cur.known ? cur.remaining : null });

  // Rank candidates by EDF: known weekly deadline ascending; same deadline
  // (±60s) → MORE remaining first (equal-deadline order can't change total
  // utilization — both expire together — so optimize for fewer switches);
  // no-deadline candidates (unknown / reset-passed-fresh) rank last, ordered
  // by effective remaining (unknown = 50, the v2 rule).
  const ranked = [];
  let excludedN = 0;
  for (const m of members) {
    if (m.id === currentId) continue;
    if (excluded && excluded.has(m.id)) { excludedN++; continue; } // just rejected this session — not a candidate
    const c = readCache(m.id);
    const r = dockRem(m.id, accountRemaining(c, nowSec));
    const br = dock(m.id, bucketRems(c, nowSec));
    const eff = r.known ? r.remaining : UNKNOWN_REMAINING_PCT;
    if (r.known && br.some(dead)) continue; // gated: some bucket below its hard floor — can't serve
    // settleOk: every bucket clears its kind's HOT threshold + margin — a
    // voluntary move must land somewhere that won't itself soft-exhaust
    // (the 2.266.1 oscillation guard, now per-kind)
    const settleOk = r.known && br.length > 0 && br.every((b) => b.remaining >= THRESH[b.kind].hot + MIN_GAIN_PCT);
    ranked.push({ id: m.id, name: m.name, eff, known: r.known, settleOk, remaining: r.known ? r.remaining : null, deadline: weeklyDeadline(c, nowSec) });
  }
  ranked.sort(edfCompare);
  if (!ranked.length) return none(excludedN ? 'all-rejected' : 'no-members', { fromRemaining: cur.known ? cur.remaining : null, excluded: excludedN || undefined, ...bucketDetail(curBr) });

  const bestSettle = ranked.find((r) => r.settleOk) || null;
  if (exhausted) {
    if (hardDead) {
      // genuinely unusable — any meaningfully-better member beats staying,
      // even one below the settle bar (scraps > nothing)
      // LIVENESS BEATS EFFICIENCY once the current target is genuinely dead.
      // ranked[0] is the EDF pick — soonest weekly deadline — which is the
      // right policy while we still have a CHOICE about when to burn quota.
      // It is the wrong pick when we have none: a member whose window just
      // ROLLED has no known deadline and therefore sorts LAST by design, so a
      // fully-fresh account was invisible as an escape hatch and the pool
      // stayed locked on a dead one until the user hit a limit (real incident
      // 2026-08-11, reproduced from the reporter's own usage cache: current at
      // 0% with a 100%-on-every-bucket member present returned null for hot
      // AND cold). Prefer the EDF-first member that can actually SETTLE; with
      // none, take the most headroom rather than the soonest deadline.
      // "Most headroom" only means something when the headroom was MEASURED:
      // an unknown member carries the fabricated UNKNOWN_REMAINING_PCT, which
      // would otherwise beat every real reading and turn "escape the dead
      // account" into "jump onto ignorance" (caught by the anti-flap test).
      const knownRanked = ranked.filter((r) => r.known);
      const best = bestSettle || (knownRanked.length ? knownRanked.reduce((x, y) => (y.eff > x.eff ? y : x)) : ranked[0]);
      if (best.eff <= cur.remaining + MIN_GAIN_PCT) return none('stuck', { fromRemaining: cur.remaining, bestRemaining: best.remaining, bestName: best.name || best.id, ...bucketDetail(curBr) });
      return { to: best.id, toName: best.name, fromRemaining: cur.remaining, toRemaining: best.remaining, reason: 'exhausted' };
    }
    // soft-exhausted (only a hot-raised threshold tripped): still usable,
    // so only move somewhere that can actually SETTLE
    if (!bestSettle) return none('no-settleable', { fromRemaining: cur.remaining, ...bucketDetail(curBr) });
    return { to: bestSettle.id, toName: bestSettle.name, fromRemaining: cur.remaining, toRemaining: bestSettle.remaining, reason: 'exhausted' };
  }
  // Proactive tier (hot pools): jump to a strictly-sooner KNOWN deadline —
  // drain the soonest-expiring quota while the current target's keeps. Never
  // jump onto unknown data, never without a real deadline margin, and never
  // onto a member below the settle bar (the oscillation guard above).
  if (proactive && bestSettle && bestSettle.deadline != null && curDeadline != null && bestSettle.known
      && curDeadline - bestSettle.deadline > PROACTIVE_MARGIN_SEC) {
    return { to: bestSettle.id, toName: bestSettle.name, fromRemaining: cur.known ? cur.remaining : null, toRemaining: bestSettle.remaining, reason: 'edf' };
  }
  return none('hold', { fromRemaining: cur.known ? cur.remaining : null });
}


// ── auto-cli quota refresh decision (2.329.0, owner-approved 2026-08-12 after
// the ToS explicit-permit argument; cadence made BURN-AWARE per the owner's
// "30min太慢, workflow快跑时容易挂") ──
// Pure: pick which accounts to ground-truth via `claude -p /usage` this tick.
// list: [{ key, fetchedAt, lastAttemptAt, estDriftPct, activeBurn }]
//   estDriftPct = max over buckets of |estimated - last reading| in POINTS —
//   the dead-reckoner's own signal that real burn happened since the reading.
//   activeBurn  = any estimated movement at all since fetchedAt.
// Rules: refresh when the ESTIMATE has drifted ≥ driftPct (a fast workflow
// burst trips this within minutes) OR the reading is older than maxAgeMs
// WITH activity since, OR — owner-directed 2026-08-13 — the reading is older
// than idleMaxAgeMs regardless of activity (idle accounts get a SLOW rung so
// the roster never shows week-stale numbers; the caller passes a per-tick
// RANDOMIZED idleMaxAgeMs in the 30–60min band so the cadence wanders instead
// of the metronomic fixed-interval pattern the ban postmortem flagged, and
// the official-binary channel is the whole §ban-safety posture). Per-account
// floor keeps bursts from hammering one account; one refresh per tick
// serializes the CLI spawns fleet-wide; drift beats stale-idle in priority,
// then oldest reading first.
function decideCliRefresh(list, now, { floorMs = 5 * 60e3, driftPct = 4, maxAgeMs = 45 * 60e3, idleMaxAgeMs = 60 * 60e3, maxPerTick = 1 } = {}) {
  const eligible = (list || []).filter((a) => {
    if (!a || !a.key) return false;
    if (now - (a.lastAttemptAt || 0) < floorMs) return false;
    const age = now - (a.fetchedAt || 0);
    if ((a.estDriftPct || 0) >= driftPct) return true;
    if (age >= maxAgeMs && a.activeBurn) return true;
    return age >= idleMaxAgeMs;
  });
  eligible.sort((x, y) => ((y.estDriftPct || 0) - (x.estDriftPct || 0)) || ((x.fetchedAt || 0) - (y.fetchedAt || 0)));
  return eligible.slice(0, maxPerTick).map((a) => a.key);
}

// ── auth-failure classification (2.335.0, owner report: a banned/expired/
// out-of-credit account never triggered a pool switch — the engine only spoke
// QUOTA). Pure: given the CLI's own error surface (api_retry status/message or
// an error result text), is this an AUTH-CLASS failure the pool should route
// around? 401 is also what a mid-refresh race looks like, so a lone first-
// attempt 401 does NOT qualify — the CLI retries, and attempt ≥2 means the
// refresh already had its chance. Explicit ban/credit/disabled messages
// qualify immediately regardless of status.
const AUTH_FAIL_RE = /oauth.*(revoked|invalid|expired)|token.*(revoked|expired)|authentication[_ ]error|credit balance|organization.*(disabled|suspended)|account.*(disabled|suspended|banned)|invalid.*api.?key|forbidden/i;
// A message-ONLY qualification (no status code) additionally needs API-layer
// context in the text — error-result records carry a whole turn's failure
// text, and an agent's own tooling could legitimately print "authentication
// error" about some third-party system. Real CLI API failures embed
// "API Error: 4xx" / "Anthropic" / "OAuth" alongside the reason.
const API_CTX_RE = /\bapi\b|anthropic|oauth|\b40[13]\b|claude\.ai/i;
function classifyAuthFailure({ status, message, attempt } = {}) {
  const msg = String(message || '');
  if (AUTH_FAIL_RE.test(msg) && (status != null || API_CTX_RE.test(msg))) return true;
  const st = Number(status);
  if (st === 403) return true; // never a refresh race — an authenticated, refused identity
  if (st === 401) return (attempt || 0) >= 2;
  return false;
}

// ── quotaVerdict (2.369.0, owner-designed: "在账户系统里统一管理这个信息
// 的计算，纯基于剩余用量") — THE one verdict for "is this account usable
// right now, and if not, when does it unblock". Same THRESH table and the
// same bucketRems primitives as decidePoolSwitch — one source of truth, no
// twin. tier 'hot' = the usability line the owner set (5h<10%, weekly<5%);
// 'hard' = the pool candidate gate's stricter line. blockedUntil = MAX over
// the dead buckets' FUTURE resets (a session unblocks only when ALL dead
// buckets reset); 0 when any dead bucket's next reset is unknown — the
// caller PROBES instead of guessing (the passive cache legitimately loses a
// window's resetsAt when it rolls over: the next window's reset only exists
// after a fresh reading).
function quotaVerdict(cache, nowSec, { tier = 'hot' } = {}) {
  const brs = bucketRems(cache, nowSec);
  if (!brs.length) return { usable: null, known: false, blockedUntil: 0, dead: [], reason: 'no usage data' };
  const line = (b) => THRESH[b.kind][tier];
  const dead = brs.filter((b) => b.remaining < line(b));
  if (!dead.length) {
    return { usable: true, known: true, blockedUntil: 0, dead: [], reason: brs.map((b) => `${b.label} ${Math.round(b.remaining)}%`).join(' · ') };
  }
  const futureResets = dead.map((b) => (b.resetsAt > nowSec ? b.resetsAt : 0));
  const blockedUntil = futureResets.every(Boolean) ? Math.max(...futureResets) * 1000 : 0;
  return {
    usable: false, known: true, blockedUntil,
    dead: dead.map((b) => b.label),
    reason: dead.map((b) => `${b.label} ${Math.round(b.remaining)}% < ${line(b)}%`).join(' · '),
  };
}

module.exports = {
  quotaVerdict,
  classifyAuthFailure, decideCliRefresh, SWITCH_THRESHOLD_PCT, THRESH, rankPoolMembers, UNKNOWN_REMAINING_PCT, PROACTIVE_MARGIN_SEC, MIN_GAIN_PCT, bucketRemaining, bucketRems, accountRemaining, weeklyDeadline, decidePoolSwitch };
