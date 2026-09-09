'use strict';
/**
 * auto-resume-signal.js — PURE (imports nothing): what a NORMALIZED quota
 * signal says to a conversation that is ALREADY WAITING for its limit to lift.
 *
 * THE INCIDENT (2026-09-08, owner: a codex thread sat idle for 32 h with quota
 * available). Thread 01a0733f… (webui sess-13-1788764799305, backend codex,
 * accountId null = the machine's codex login, no pool):
 *   2026-09-07 13:16:40Z  the app-server refuses the turn — 99 records of
 *                         `codex_error_info: usage_limit_exceeded`, reset
 *                         stated only in prose: "try again at Sep 13th, 2026
 *                         8:36 PM" (= sevenDay.resetsAt 1789356983, exact)
 *   2026-09-07 13:20:19Z  the last reading: sevenDay utilization 1.0
 *   …32 h of silence — data/auto-resume.json holds `{armed:{},fires:{}}`, and
 *      the journal has ZERO [auto-resume] lines for that session, ever…
 *   2026-09-08 21:55:00Z  the app-server pushes a FRESH window on the SAME
 *                         limit lane (limitId 'codex', sevenDay usedPercent 0,
 *                         a NEW resetsAt 1789509303) — quota is available —
 *                         and nothing wakes the thread.
 *
 * THE RESET WAS SIX DAYS OUT, so `armIfEnabled`'s 26 h ceiling was RIGHT to
 * refuse a timed wait. The window then reopened EARLY, 32 h in, which no timer
 * could have predicted. The only thing that could ever have continued this
 * conversation is the signal that says so — and no harness had one.
 *
 * SO THIS MODULE ANSWERS EXACTLY ONE QUESTION, for every harness: does THIS
 * reading say the wall the session is waiting on is gone? It is PURE because
 * both producers ask it (the claude `rate_limit_event` path and the codex
 * `rate_limits_updated` push) and because the answer AUTHORISES A BILLED TURN
 * — the sort of decision that must be unit-testable without a server.
 *
 * THE LANE IS LOAD-BEARING. A codex login reports on more than one limit lane
 * and they interleave on the same account: measured on this instance's own
 * anchor stream, `limitId:'codex'` (the plan weekly, the one that was spent)
 * alternates minute by minute with `limitId:'codex_bengalfox'`
 * (GPT-5.3-Codex-Spark, 0 % the whole time). "No dead bucket ⇒ fire" without a
 * lane check would have fired on the very next spark reading — an unattended
 * billed turn straight back into the wall. A signal about a DIFFERENT lane
 * says nothing about the lane we are waiting on, and an UNKNOWN lane on either
 * side is not a match either: firing costs money, so the ambiguous answer is
 * "stay armed". claude states no lane at all, so both sides are null there and
 * every claude reading matches, which is the correct reading of "this harness
 * has one lane".
 *
 * WHY NOT THE WEEKLY-PHASE FINGERPRINT (src/reading-lag.js)? Because it is an
 * ACCOUNT identity rule and this is a LANE question, and because codex's weekly
 * window is not phase-stable: the incident's two windows are 152 320 s apart,
 * not a multiple of 604 800. The phase rule is measured true of Anthropic's
 * rolling week and would answer 'differ' about the very reading that proves
 * recovery here.
 */

/** The limit LANE a normalized snapshot is about — the harness's own name for
 *  "which of my windows are these numbers", or null when the harness has only
 *  one (claude states none). Never invented. */
function laneOf(snapshot) {
  const id = snapshot && snapshot.limitId;
  return id ? String(id) : null;
}

/** Do two lanes name the same window family? null===null is a match (a harness
 *  with one lane); anything else must be equal. A stated lane vs an unstated
 *  one is NOT a match — that is ignorance, and ignorance may not spend. */
function sameLane(a, b) { return (a || null) === (b || null); }

const BUCKET_KEYS = ['fiveHour', 'sevenDay'];

/** Every bucket a snapshot actually STATES, with the fields this module needs.
 *  A bucket with no finite utilization is not a statement about anything. */
function statedBuckets(snapshot) {
  const out = [];
  if (!snapshot || typeof snapshot !== 'object') return out;
  const push = (kind, b, name) => {
    if (!b || typeof b !== 'object') return;
    const u = Number(b.utilization);
    if (!Number.isFinite(u)) return;
    out.push({ kind, name: name || null, utilization: u, resetsAt: Number(b.resetsAt) || 0, status: b.status || null });
  };
  for (const k of BUCKET_KEYS) push(k, snapshot[k]);
  for (const sw of Array.isArray(snapshot.scopedWeekly) ? snapshot.scopedWeekly : []) push('scoped', sw, sw && sw.name);
  return out;
}

/** SPENT: this bucket cannot serve a request right now. The threshold is a
 *  FULL window (utilization ≥ 1) or the harness's own 'limited' marker —
 *  deliberately NOT the pool's `THRESH.*.hard` candidate gate (3-5 % left).
 *  That gate picks between accounts; this one decides whether to hold a
 *  session hostage and later spend a turn on it, so it answers only to
 *  "there is nothing left". A reset that has already PASSED means the window
 *  rolled since this reading was taken and the stale utilization means
 *  nothing — the same rule account-pool-auto's bucketRemaining applies. */
function bucketSpent(b, nowSec) {
  if (!b) return false;
  if (b.resetsAt && nowSec && b.resetsAt < nowSec) return false;
  return b.status === 'limited' || b.utilization >= 1;
}

/** The buckets a snapshot reports as spent, worst-reset last. */
function spentBuckets(snapshot, nowSec = Math.floor(Date.now() / 1000)) {
  return statedBuckets(snapshot).filter((b) => bucketSpent(b, nowSec));
}

/** Does this stated bucket answer for the one the session is waiting on? A
 *  scoped weekly is identified by its NAME (two model caps are two windows). */
function isArmedBucket(b, armedBucket, armedScopedName) {
  if (!b || b.kind !== armedBucket) return false;
  if (armedBucket !== 'scoped') return true;
  return String(b.name || '').toLowerCase() === String(armedScopedName || '').toLowerCase();
}

/** THE FRESH-WINDOW EDGE. Given the reading and WHICH WALL the session is
 *  waiting on, does this reading say that wall is gone?
 *    { open, why: 'window-open' | 'no-reading' | 'other-lane' | 'unknown-bucket'
 *                | 'other-bucket' | 'still-blocked' }
 *  `open` is only ever true on POSITIVE evidence, and it takes THREE facts —
 *  each of which was a real way to be wrong:
 *   · the LANE matches (a codex login reports `codex` and `codex_bengalfox`
 *     minute by minute; the spark lane read 0 % through the whole 32 h stall);
 *   · the reading STATES THE BUCKET WE ARE WAITING ON and reports it not spent
 *     — a claude `rate_limit_event` names exactly ONE bucket, so a healthy 7d
 *     reading says nothing whatever about a 5h wall, and reading it as "the
 *     wall is gone" would fire a billed turn straight back into it;
 *   · NO OTHER stated bucket of that lane is spent (an identity unblocks only
 *     when all of its dead windows have reset — the c1206711 rule).
 *  An arm with no bucket on record (the pool's +45 s near-arm) can never be
 *  opened this way and waits out its own timer: not knowing which wall we are
 *  waiting on is not evidence that it lifted.
 *  WHETHER the session is armed is the CALLER's fact and deliberately not an
 *  input: this answers about the WALL, not about the wait, so it cannot
 *  quietly disagree with the module that owns the armed record.
 *
 *  A MONTHLY SPEND CAP IS NOT A WINDOW, and the buckets cannot see it (r2).
 *  `spend_control_reached` is the codex twin of 2.361.2's
 *  `seven_day_overage_included`: the account refuses every turn while its
 *  weekly bucket reads perfectly healthy, so a bucket-only rule reads "the
 *  wall is gone" and fires into a wall that has no reset at all. It is
 *  checked BEFORE the lane, deliberately: a spend control is a fact about the
 *  ACCOUNT, not about one of its windows, so a sibling lane stating it is
 *  still stating it about us — and refusing to spend is the safe direction.
 *  UNVERIFIED ON THE WIRE, and it says so: `spendControlReached:true` has
 *  ZERO occurrences in this instance's stores, so this rung can only ever
 *  REFUSE; it never authorises anything, which is why it may ship unmeasured.
 *
 *  `credits.hasCredits === false` IS DELIBERATELY NOT USED — measured, and the
 *  measurement refutes it. The machine's own codex login (the incident's very
 *  account) carries `credits:{hasCredits:false,unlimited:false,balance:"0"}`
 *  in data/usage-cache/__global_codex__.json while serving turns normally off
 *  plan quota: a plan account simply has no credit balance. Reading that as
 *  "spent" would make this edge permanently inert on this instance — the
 *  original incident, re-introduced as a guard. */
function windowOpened({ snapshot = null, armedLane = null, armedBucket = null, armedScopedName = null, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const buckets = statedBuckets(snapshot);
  if (!buckets.length) return { open: false, why: 'no-reading' };
  if (snapshot && snapshot.spendControlReached === true) return { open: false, why: 'spend-capped' };
  if (!sameLane(laneOf(snapshot), armedLane)) return { open: false, why: 'other-lane' };
  if (!armedBucket) return { open: false, why: 'unknown-bucket' };
  const mine = buckets.filter((b) => isArmedBucket(b, armedBucket, armedScopedName));
  if (!mine.length) return { open: false, why: 'other-bucket' };
  if (buckets.some((b) => bucketSpent(b, nowSec))) return { open: false, why: 'still-blocked' };
  return { open: true, why: 'window-open' };
}

module.exports = { laneOf, sameLane, statedBuckets, bucketSpent, spentBuckets, isArmedBucket, windowOpened, BUCKET_KEYS };
