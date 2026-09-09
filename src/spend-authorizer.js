'use strict';
// THE ONE CEILING ON EVERY TURN NOBODY TYPED (docs/design-account-hardening.md
// §4.4c / P9 / owner decisions D3 + D6). PURE — imports nothing, so the rule is
// unit-provable and the ORCH adapter (src/server/spend-guard.js) is the only
// thing that touches disk, telemetry or the inbox.
//
// WHY THIS EXISTS. Seven producers in this tree can start a BILLED turn with
// no per-occurrence owner action, and until now each carried its own local
// floor — auto-resume's loop breaker (3/hour/session), the Stop nudge's
// `s._lastStopNudge` (in-memory, and 0 on this instance because the owner set
// the cooldown to 0), the jobs engine's 30s-per-conversation flood floor. Every
// one of them is a floor on ONE producer's PACING; not one of them is a bound
// on MONEY, and none of them knows what the others spent. Measured on this
// instance's own transcripts (ALL of them, 2026-07-10 → 2026-09-09): 603
// Stop-nudge mini-turns across 72 conversations, forcing 999 assistant records
// that read 536,353,861 cached tokens — with 21 of those nudges landing on ONE
// conversation inside ONE hour, and 93 on the busiest day.
//
// THE UNIT IS THE IDENTITY, NOT THE SESSION. The money is spent by a
// credential slot, and nine conversations can be parked on one subscription —
// so a per-session floor bounds nothing that has a bill attached. The identity
// here is the credential slot the turn will bill, resolved by the engine's
// EXISTING answer (wallSlotFor / fireIdentityFor); this module never derives
// it — a fifth derivation of session→account is the very thing §2 of the design
// says produced five incidents in three days.
//
// FAIL CLOSED (P8). Every unanswerable question refuses: an identity we cannot
// name, a credential state that says it cannot serve, an overage the owner has
// not opted into. Ignorance about a QUOTA is different from ignorance about the
// BUDGET — an unreadable credential file answers 'unknown' and is NOT a
// refusal (P6: ignorance is never a claim), but an unnameable identity is,
// because a ceiling that cannot be attributed is not a ceiling.

// ── The closed set of unattended-spend reasons ───────────────────────────────
// A producer that can put a user turn into a session nobody typed into must
// appear here AND call the authorizer; scripts/test-spend-paths.mjs derives the
// producer census from the source tree and fails on a site that is not wired.
// `turn: true`  — this reason opens a BILLED turn.
// `turn: false` — it spends something else that costs money (a stored reset
//                 credit), so it takes the same ceiling and says so.
// The set is CLOSED and it holds only reasons a producer passes TODAY: a
// declared-but-unused reason is a slot the next producer slides into without
// anyone deciding anything (test-spend-paths asserts both directions).
const SPEND_REASONS = Object.freeze({
  'auto-resume': { turn: true, what: 'the continue after a usage limit' },
  'stop-nudge': { turn: true, what: 'the Stop bookkeeping mini-turn' },
  'job-notification': { turn: true, what: 'a Background Work notification' },
  'peer-message': { turn: true, what: 'a message from another session' },
  'codex-reset-credit': { turn: false, what: 'a stored Codex rate-limit reset credit' },
});

// D6's proposal, as shipped defaults. They are SETTINGS (see
// src/lib/settings-schema.js `spend.*`); these are the values a caller that
// passes nothing gets, and the numbers the suite pins.
const BUDGET_DEFAULTS = Object.freeze({
  perIdentityHour: 12,
  perIdentityDay: 60,
  perInstanceDay: 200,
  noticePct: 80,
});
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// THE OFFERED RANGE AND THE ENFORCEABLE RANGE ARE ONE SET (r2, reproduced).
// These are the `max` of the three `spend.*` rows in src/lib/settings-schema.js,
// and they are the clamp in budgetLimits — because a setting the UI accepts and
// the ledger cannot count is a money bound that is not one. The round-1 shape
// clamped at 100000/1000000 while retaining a flat 800 stamps, so every value
// above 800 (the schema offers 2000 and 10000) silently never fired: 1500
// charged spends against a 1000/day cap still counted 800 and authorized the
// 1501st. test-spend-paths §1 re-derives these three numbers FROM the schema,
// so widening one row without widening the clamp goes red.
const CAP_MAX = Object.freeze({ perIdentityHour: 200, perIdentityDay: 2000, perInstanceDay: 10000 });
// Retention is a FUNCTION OF THE LIMITS, never a constant: the list only has to
// out-count the biggest cap that reads it, plus head-room so the cap itself is
// reachable rather than exactly met. Bounded by construction — budgetLimits
// clamps at CAP_MAX, so this is at most 10064 numbers (~140 KB of JSON).
const STAMP_HEADROOM = 64;
/** PURE. How many timestamps one list must keep for `limits` to be enforceable. */
function stampCap(limits) {
  const L = limits || BUDGET_DEFAULTS;
  const n = Math.max(
    Number(L.perIdentityDay) || 0, Number(L.perInstanceDay) || 0,
    BUDGET_DEFAULTS.perIdentityDay, BUDGET_DEFAULTS.perInstanceDay,
  );
  return Math.min(CAP_MAX.perInstanceDay, n) + STAMP_HEADROOM;
}
// Kept as the DEFAULT retention (what a caller that passes no limits gets) and
// as the number the suite names; it is no longer a ceiling on what can be
// counted.
const MAX_STAMPS = stampCap(null);

/** PURE. Normalise the four numbers, whatever the settings store holds.
 *  0 is an EXPLICIT choice ("no unattended turns on this axis at all"), which
 *  is why it is not replaced by the default — the same clamp0 convention the
 *  Stop nudge's own thresholds use. A negative/garbage value is not a choice
 *  and falls back. */
function budgetLimits(get = () => undefined) {
  const num = (key, dflt, hi) => {
    let v;
    try { v = get(key); } catch { v = undefined; }
    // A BOOLEAN IS NEVER A CAP. `Number(true)` is 1, so a settings reader that
    // answers `true` to everything (a harness stub, a corrupted store) would
    // silently set every ceiling to ONE unattended turn — a value nobody chose,
    // arrived at by coercion. Only a number is a number.
    if (typeof v === 'boolean') return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return dflt;
    return Math.min(hi, Math.round(n));
  };
  return {
    // clamped at the schema's OWN max (CAP_MAX) — see its comment: a ceiling the
    // settings UI offers and the ledger cannot count is not a ceiling
    perIdentityHour: num('spend.unattendedPerIdentityHour', BUDGET_DEFAULTS.perIdentityHour, CAP_MAX.perIdentityHour),
    perIdentityDay: num('spend.unattendedPerIdentityDay', BUDGET_DEFAULTS.perIdentityDay, CAP_MAX.perIdentityDay),
    perInstanceDay: num('spend.unattendedPerInstanceDay', BUDGET_DEFAULTS.perInstanceDay, CAP_MAX.perInstanceDay),
    noticePct: (() => { const n = num('spend.budgetNoticePct', BUDGET_DEFAULTS.noticePct, 100); return n > 0 ? n : 0; })(),
  };
}

/** PURE. An empty ledger. */
function emptyBudget() { return { v: 1, identities: {}, instance: [], notices: {} }; }

/** PURE. Drop everything older than a day; the hour window is a filter over the
 *  same list. Returns a NEW object (never mutates the caller's state) so a
 *  refused authorization cannot leave a half-pruned ledger behind. */
function pruneBudget(state, now = Date.now(), limits = null) {
  const s = state && typeof state === 'object' ? state : emptyBudget();
  const cut = now - DAY_MS;
  const cap = stampCap(limits);
  const keep = (list) => (Array.isArray(list) ? list.filter((t) => Number(t) > cut).slice(-cap) : []);
  const identities = {};
  for (const [k, v] of Object.entries(s.identities || {})) {
    const l = keep(v);
    if (l.length) identities[k] = l;
  }
  const notices = {};
  for (const [k, v] of Object.entries(s.notices || {})) if (Number(v) > cut) notices[k] = Number(v);
  return { v: 1, identities, instance: keep(s.instance), notices };
}

/** PURE. What this identity (and the instance) has spent inside each window. */
function spendCounts(state, identityKey, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : emptyBudget();
  const mine = Array.isArray(s.identities?.[identityKey]) ? s.identities[identityKey] : [];
  const inst = Array.isArray(s.instance) ? s.instance : [];
  const since = (list, ms) => list.filter((t) => Number(t) > now - ms);
  const hour = since(mine, HOUR_MS);
  const day = since(mine, DAY_MS);
  const instanceDay = since(inst, DAY_MS);
  return {
    hour: hour.length, day: day.length, instanceDay: instanceDay.length,
    // when the window frees a slot again — the honest retryAfter, not a guess
    hourOldest: hour.length ? Math.min(...hour) : 0,
    dayOldest: day.length ? Math.min(...day) : 0,
    instanceOldest: instanceDay.length ? Math.min(...instanceDay) : 0,
  };
}

// HOW OLD AN OVERAGE RECORD MAY BE AND STILL REFUSE A TURN (r2, reproduced).
// `cache.overage` rides only SOME `rate_limit_event`s — rate-limit-capture.js
// merges it when at least one overage field is defined — so its `asOf` goes
// stale for long stretches on an account that is being read constantly.
// MEASURED on this instance's seven live records: ages 0h, 2h, 5h, 5h, 5h, 21h
// and **33h**, the 33h one on a cache file refreshed 4 MINUTES ago; and 0 of 7
// carry a `resetsAt` at all. So a window of hours would flip live accounts to
// 'unknown' (which ALLOWS) and let real money through, while NO window at all
// means a record that stops being refreshed refuses every unattended turn for
// ever — including the auto-resume continue for a session that is BY
// DEFINITION idle and therefore producing no events to refresh it with.
// 7 days is >5× the longest refresh gap measured here.
const OVERAGE_STALE_MS = 7 * 24 * 3600 * 1000;

/** PURE. Does this account's usage cache say REAL MONEY is being spent right
 *  now? `cache.overage` is written by src/rate-limit-capture.js from the CLI's
 *  own `rate_limit_event` (isUsingOverage / overageStatus / overageResetsAt /
 *  overageDisabledReason) and — until this change — was read by NOBODY.
 *
 *  THE RANKING BUG IT CAUSES: with overage on, `utilization` stays under 1
 *  while every token is billed pay-per-use, so `accountRemaining()` sees an
 *  account with the MOST headroom exactly when it is the most expensive one.
 *  Returns a three-state verdict, never a boolean: 'yes' | 'no' | 'unknown'
 *  (no overage record at all — P6, ignorance is not a claim).
 *
 *  THE CLAIM THAT BLOCKS IS THE ONE THAT NEEDS A DATE (r2). `inUse:'yes'` is
 *  what refuses spend AND what paints the panel chip whose tip says "Automatic
 *  turns are refused on this account", so it expires two ways:
 *    · the record's own `resetsAt` is in the PAST — it describes a billing
 *      period that has ENDED, so it is not a statement about now (and it was
 *      also what produced a `retryAfter` printing an instant in the past);
 *    · its `asOf` is older than OVERAGE_STALE_MS.
 *  An expired claim answers 'unknown', which neither blocks nor claims (P6) —
 *  and `stated` keeps what the record literally says, with `evidence` naming
 *  which rung decided, so a refusal is never mistaken for a stale file and a
 *  diagnostic can tell the two apart. `inUse:'no'` is NOT bounded: it blocks
 *  nothing, and downgrading it to 'unknown' would change no decision anywhere.
 *  An UNDATED record (`asOf` absent — a hand edit or a foreign writer; our own
 *  producer stamps it on the same line it merges) cannot claim the present. */
function overageState(cache, { now = Date.now(), staleMs = OVERAGE_STALE_MS } = {}) {
  const o = cache && typeof cache === 'object' ? cache.overage : null;
  if (!o || typeof o !== 'object') {
    return { inUse: 'unknown', stated: 'unknown', evidence: 'none', ageMs: null, status: null, resetsAt: null, disabledReason: null, asOf: 0, spend: null };
  }
  const raw = o.inUse;
  const stated = raw === true ? 'yes' : raw === false ? 'no' : 'unknown';
  const spend = cache.spend && typeof cache.spend === 'object' && Number.isFinite(Number(cache.spend.used))
    ? { used: Number(cache.spend.used), limit: Number(cache.spend.limit) || null, pct: Number(cache.spend.pct) || null }
    : null;
  const asOf = Number(o.asOf) || 0;
  const resetsAt = Number(o.resetsAt) || null;
  const ageMs = asOf > 0 ? Math.max(0, now - asOf) : null;
  let evidence = 'fresh';
  if (stated === 'yes') {
    if (!asOf) evidence = 'undated';
    else if (resetsAt && resetsAt * 1000 <= now) evidence = 'period-ended';
    else if (ageMs > staleMs) evidence = 'stale';
  } else evidence = stated === 'no' ? 'stated-off' : 'none';
  const inUse = stated === 'yes' && evidence !== 'fresh' ? 'unknown' : stated;
  return {
    inUse, stated, evidence, ageMs,
    status: o.status ?? null, resetsAt,
    disabledReason: o.disabledReason ?? null, asOf, spend,
  };
}

/** PURE. The one sentence every surface says about an overage-billing account
 *  (usage popup, Manage Agents, the refusal notice). null = nothing to say.
 *  Takes the SAME evidence options as `overageState` and hands them straight
 *  through: a sentence built on a different clock than the gate is exactly the
 *  "two faces of one record disagree" shape ⑤ exists to close — it would say
 *  "paid overage in use" about a record the authorizer has already expired. */
function overageText(cache, opts = undefined) {
  const o = overageState(cache, opts);
  if (o.inUse !== 'yes') return null;
  const money = o.spend
    ? ` — $${o.spend.used.toFixed(2)}${o.spend.limit ? ` of $${o.spend.limit.toFixed(2)}` : ''} this period`
    : '';
  return `paid overage in use${money}`;
}

/** PURE. THE ONE READER of `cache.spendControlReached` — the THIRD field the
 *  design's §1.4 row named and the one r3 marked CLOSED without wiring
 *  (measured 2026-09-09: `grep -rn spendControlReached src/` returned exactly
 *  two hits, both the WRITER in src/harnesses/codex-quota.js).
 *
 *  WHAT IT MEANS, and what it is NOT. Codex reports it beside the rate-limit
 *  windows; it says this account has reached its configured SPEND CONTROL, so
 *  further requests are REJECTED. That is not the overage class — no dollars
 *  are being spent — it is the `identity-cannot-serve` class: an unattended
 *  turn on it buys a failed request and a junk card, and the account can rank
 *  as the member with the most headroom while it does (`accountRemaining()`
 *  reads `utilization`, and only a `rate_limit_reached_type` marks a window
 *  spent — nothing marks THIS).
 *
 *  THREE-STATE, and DATED like its sibling (P6 + r2's "only the claim that
 *  BLOCKS needs a date"): the snapshot is rebuilt wholesale by every codex
 *  reading producer and stamps its own `fetchedAt`, so that is the date, and a
 *  record older than OVERAGE_STALE_MS — the SAME constant, imported not
 *  re-declared, because a second window for one physical fact is how twins are
 *  born — answers 'unknown', which neither blocks nor claims. `reached:'no'`
 *  is deliberately NOT bounded: it blocks nothing. */
function spendControlState(cache, { now = Date.now(), staleMs = OVERAGE_STALE_MS } = {}) {
  const raw = cache && typeof cache === 'object' ? cache.spendControlReached : undefined;
  const stated = raw === true ? 'yes' : raw === false ? 'no' : 'unknown';
  const asOf = Number(cache && cache.fetchedAt) || 0;
  const ageMs = asOf > 0 ? Math.max(0, now - asOf) : null;
  let evidence = 'none';
  if (stated === 'yes') evidence = !asOf ? 'undated' : ageMs > staleMs ? 'stale' : 'fresh';
  else if (stated === 'no') evidence = 'stated-off';
  const reached = stated === 'yes' && evidence !== 'fresh' ? 'unknown' : stated;
  return { reached, stated, evidence, ageMs, asOf };
}

/** PURE. The one sentence every surface says about it. null = nothing to say. */
function spendControlText(cache, opts = undefined) {
  const s = spendControlState(cache, opts);
  return s.reached === 'yes' ? 'spend control reached' : null;
}

/** PURE. THE DECISION. Everything it needs is an argument; nothing is read.
 *  @param reason      one of SPEND_REASONS
 *  @param identity    {key, name} — the credential slot this turn will BILL
 *  @param state       the persisted ledger (see pruneBudget)
 *  @param limits      budgetLimits()
 *  @param overage     overageState(cache) for that identity, or null (unknown)
 *  @param overagePolicy 'refuse' (default, D3b) | 'allow'
 *  @param credential  {serves: 'yes'|'no'|'unknown'} — login/credential state
 *  @param spendControl spendControlState(cache), or null (unknown)
 *  @returns {ok, why, detail, retryAfter, counts, limits, reason, identity}
 */
function authorizeUnattendedSpend({
  reason, identity = null, state = null, limits = BUDGET_DEFAULTS,
  overage = null, overagePolicy = 'refuse', credential = null,
  spendControl = null, now = Date.now(),
} = {}) {
  const L = { ...BUDGET_DEFAULTS, ...(limits || {}) };
  const key = identity && identity.key ? String(identity.key) : null;
  const name = (identity && (identity.name || identity.key)) || null;
  const counts = spendCounts(state, key || '__no-identity__', now);
  const no = (why, detail, retryAfter = 0) => ({ ok: false, why, detail, retryAfter, counts, limits: L, reason, identity: identity || null });
  if (!reason || !(reason in SPEND_REASONS)) {
    // An unnamed producer is the one shape the census exists to prevent; if it
    // reaches here at runtime it must not spend.
    return no('unknown-reason', `"${String(reason)}" is not a declared unattended-spend reason`);
  }
  // FAIL CLOSED on an unnameable identity: a ceiling nobody can be charged
  // against is not a ceiling. (Structurally rare — wallSlotFor answers
  // `__global__` for a session with no pool — so this is the wiring being
  // broken, which is exactly when spending must stop.)
  if (!key) return no('identity-unknown', 'the credential slot this turn would bill could not be resolved');
  // A credential that CANNOT serve (expired/wiped login, no long-lived token)
  // spends nothing but a failed turn and a junk card. 'unknown' passes: P6.
  if (credential && credential.serves === 'no') {
    return no('identity-cannot-serve', `${name} cannot authorize a request right now (${credential.state || 'signed out'})`);
  }
  // THE SAME CLASS, stated by the harness instead of by the credential file
  // (design §1.4's third named field): codex says this account has reached its
  // spend control, so its requests are REJECTED. No dollars are at stake — the
  // turn simply buys a failed request and a junk card — and it is NOT gated by
  // `spend.allowOverageTurns`, which is an opt-in to SPENDING money, not an
  // opt-in to being refused by the vendor. Only a FRESH, dated claim blocks
  // (spendControlState); 'unknown'/'no' never do.
  if (spendControl && spendControl.reached === 'yes') {
    return no('spend-control-reached', `${name} has reached its spend control — its requests are rejected, so an unattended turn on it buys nothing`);
  }
  // REAL MONEY (D3b). While overage is in use the account is billing
  // pay-per-use, so an unattended turn is a dollar decision, not a quota one.
  if (overage && overage.inUse === 'yes' && overagePolicy !== 'allow') {
    // SAY HOW OLD THE EVIDENCE IS (r2): a refusal that never expires and never
    // dates itself is indistinguishable from a stale file, and `retryAfter`
    // used to print an instant in the PAST (a resetsAt that has already come
    // round — now an expiry rung inside overageState, so it cannot reach here).
    const seen = Number(overage.ageMs) > 0 ? ` (last reported ${Math.round(overage.ageMs / 60000)} min ago)` : '';
    return no('overage-in-use', `${name} is billing paid overage${seen} — unattended turns are refused while real money is being spent`, overage.resetsAt ? overage.resetsAt * 1000 : 0);
  }
  if (L.perIdentityHour === 0) return no('hour-cap', `unattended turns per identity per hour are set to 0`);
  if (counts.hour >= L.perIdentityHour) return no('hour-cap', `${name} has spent ${counts.hour} unattended turns this hour (cap ${L.perIdentityHour})`, counts.hourOldest + HOUR_MS);
  if (L.perIdentityDay === 0) return no('day-cap', `unattended turns per identity per day are set to 0`);
  if (counts.day >= L.perIdentityDay) return no('day-cap', `${name} has spent ${counts.day} unattended turns today (cap ${L.perIdentityDay})`, counts.dayOldest + DAY_MS);
  if (L.perInstanceDay === 0) return no('instance-cap', `unattended turns for this instance are set to 0`);
  if (counts.instanceDay >= L.perInstanceDay) return no('instance-cap', `this instance has spent ${counts.instanceDay} unattended turns today (cap ${L.perInstanceDay})`, counts.instanceOldest + DAY_MS);
  return { ok: true, why: null, detail: null, retryAfter: 0, counts, limits: L, reason, identity: identity || null };
}

/** PURE. Record a spend that ACTUALLY happened (two-phase, like the loop
 *  breaker's canFire/noteFired: an authorization that never became a turn must
 *  not consume budget). Returns the new state plus, when this spend crossed the
 *  notice threshold on some axis, ONE warn object — the 80% line the owner
 *  asked for, emitted at the crossing and never again inside that window. */
function noteUnattendedSpend(state, { identity, at = Date.now(), limits = BUDGET_DEFAULTS } = {}) {
  const L = { ...BUDGET_DEFAULTS, ...(limits || {}) };
  const key = identity && identity.key ? String(identity.key) : null;
  const s = pruneBudget(state, at, L);
  if (!key) return { state: s, warn: null };
  const cap = stampCap(L);
  s.identities[key] = [...(s.identities[key] || []), at].slice(-cap);
  s.instance = [...(s.instance || []), at].slice(-cap);
  const c = spendCounts(s, key, at);
  let warn = null;
  if (L.noticePct > 0) {
    const axes = [
      { scope: 'hour', used: c.hour, limit: L.perIdentityHour, noticeKey: `${key}|hour` },
      { scope: 'day', used: c.day, limit: L.perIdentityDay, noticeKey: `${key}|day` },
      { scope: 'instance', used: c.instanceDay, limit: L.perInstanceDay, noticeKey: '__instance__|day' },
    ];
    for (const a of axes) {
      if (!a.limit) continue;
      const pct = Math.round((a.used / a.limit) * 100);
      if (pct < L.noticePct) continue;
      // one notice per axis per window: the ledger remembers when it spoke
      const spokeAt = Number(s.notices[a.noticeKey]) || 0;
      const windowMs = a.scope === 'hour' ? HOUR_MS : DAY_MS;
      if (spokeAt && at - spokeAt < windowMs) continue;
      s.notices[a.noticeKey] = at;
      warn = { scope: a.scope, pct, used: a.used, limit: a.limit, identity: identity || null };
      break; // the tightest axis that crossed is the one worth saying
    }
  }
  return { state: s, warn };
}

/** PURE. The sentence a refusal says — journal, telemetry detail and the "For
 *  you" inbox item share it, so the user reads the same words the log has. */
function refusalText(v, { sessionName = null } = {}) {
  if (!v || v.ok) return null;
  const who = v.identity && (v.identity.name || v.identity.key) ? (v.identity.name || v.identity.key) : 'this account';
  const what = SPEND_REASONS[v.reason]?.what || v.reason;
  const where = sessionName ? ` in "${sessionName}"` : '';
  const when = v.retryAfter > 0 ? ` Next allowed after ${new Date(v.retryAfter).toLocaleString()}.` : '';
  return `VibeSpace refused ${what}${where}: ${v.detail}.${when}`;
}

/** PURE. The 80% line. */
function noticeText(warn) {
  if (!warn) return null;
  const who = warn.identity && (warn.identity.name || warn.identity.key) ? (warn.identity.name || warn.identity.key) : 'this account';
  const scope = warn.scope === 'instance' ? 'this instance' : who;
  const window = warn.scope === 'hour' ? 'this hour' : 'today';
  return `${scope} has used ${warn.used} of its ${warn.limit} unattended turns ${window} (${warn.pct}%). VibeSpace will refuse further automatic turns on it when the budget is spent.`;
}

module.exports = {
  SPEND_REASONS, BUDGET_DEFAULTS, HOUR_MS, DAY_MS, MAX_STAMPS, CAP_MAX, stampCap, OVERAGE_STALE_MS,
  budgetLimits, emptyBudget, pruneBudget, spendCounts,
  overageState, overageText, spendControlState, spendControlText,
  authorizeUnattendedSpend, noteUnattendedSpend, refusalText, noticeText,
};
