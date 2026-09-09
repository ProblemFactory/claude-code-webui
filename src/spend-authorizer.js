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
// Per identity, per day: keeping more timestamps than the biggest cap could
// ever need only grows the file. 4× the instance/day cap is head-room for a
// re-configured instance without an unbounded array.
const MAX_STAMPS = 4 * 200;

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
    perIdentityHour: num('spend.unattendedPerIdentityHour', BUDGET_DEFAULTS.perIdentityHour, 10000),
    perIdentityDay: num('spend.unattendedPerIdentityDay', BUDGET_DEFAULTS.perIdentityDay, 100000),
    perInstanceDay: num('spend.unattendedPerInstanceDay', BUDGET_DEFAULTS.perInstanceDay, 1000000),
    noticePct: (() => { const n = num('spend.budgetNoticePct', BUDGET_DEFAULTS.noticePct, 100); return n > 0 ? n : 0; })(),
  };
}

/** PURE. An empty ledger. */
function emptyBudget() { return { v: 1, identities: {}, instance: [], notices: {} }; }

/** PURE. Drop everything older than a day; the hour window is a filter over the
 *  same list. Returns a NEW object (never mutates the caller's state) so a
 *  refused authorization cannot leave a half-pruned ledger behind. */
function pruneBudget(state, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : emptyBudget();
  const cut = now - DAY_MS;
  const keep = (list) => (Array.isArray(list) ? list.filter((t) => Number(t) > cut).slice(-MAX_STAMPS) : []);
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

/** PURE. Does this account's usage cache say REAL MONEY is being spent right
 *  now? `cache.overage` is written by src/rate-limit-capture.js from the CLI's
 *  own `rate_limit_event` (isUsingOverage / overageStatus / overageResetsAt /
 *  overageDisabledReason) and — until this change — was read by NOBODY.
 *
 *  THE RANKING BUG IT CAUSES: with overage on, `utilization` stays under 1
 *  while every token is billed pay-per-use, so `accountRemaining()` sees an
 *  account with the MOST headroom exactly when it is the most expensive one.
 *  Returns a three-state verdict, never a boolean: 'yes' | 'no' | 'unknown'
 *  (no overage record at all — P6, ignorance is not a claim). */
function overageState(cache) {
  const o = cache && typeof cache === 'object' ? cache.overage : null;
  if (!o || typeof o !== 'object') return { inUse: 'unknown', status: null, resetsAt: null, disabledReason: null, asOf: 0, spend: null };
  const raw = o.inUse;
  const inUse = raw === true ? 'yes' : raw === false ? 'no' : 'unknown';
  const spend = cache.spend && typeof cache.spend === 'object' && Number.isFinite(Number(cache.spend.used))
    ? { used: Number(cache.spend.used), limit: Number(cache.spend.limit) || null, pct: Number(cache.spend.pct) || null }
    : null;
  return {
    inUse, status: o.status ?? null, resetsAt: Number(o.resetsAt) || null,
    disabledReason: o.disabledReason ?? null, asOf: Number(o.asOf) || 0, spend,
  };
}

/** PURE. The one sentence every surface says about an overage-billing account
 *  (usage popup, Manage Agents, the refusal notice). null = nothing to say. */
function overageText(cache) {
  const o = overageState(cache);
  if (o.inUse !== 'yes') return null;
  const money = o.spend
    ? ` — $${o.spend.used.toFixed(2)}${o.spend.limit ? ` of $${o.spend.limit.toFixed(2)}` : ''} this period`
    : '';
  return `paid overage in use${money}`;
}

/** PURE. THE DECISION. Everything it needs is an argument; nothing is read.
 *  @param reason      one of SPEND_REASONS
 *  @param identity    {key, name} — the credential slot this turn will BILL
 *  @param state       the persisted ledger (see pruneBudget)
 *  @param limits      budgetLimits()
 *  @param overage     overageState(cache) for that identity, or null (unknown)
 *  @param overagePolicy 'refuse' (default, D3b) | 'allow'
 *  @param credential  {serves: 'yes'|'no'|'unknown'} — login/credential state
 *  @returns {ok, why, detail, retryAfter, counts, limits, reason, identity}
 */
function authorizeUnattendedSpend({
  reason, identity = null, state = null, limits = BUDGET_DEFAULTS,
  overage = null, overagePolicy = 'refuse', credential = null, now = Date.now(),
} = {}) {
  const L = { ...BUDGET_DEFAULTS, ...(limits || {}) };
  const key = identity && identity.key ? String(identity.key) : null;
  const name = (identity && (identity.name || identity.key)) || null;
  const counts = spendCounts(state, key || ' none', now);
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
  // REAL MONEY (D3b). While overage is in use the account is billing
  // pay-per-use, so an unattended turn is a dollar decision, not a quota one.
  if (overage && overage.inUse === 'yes' && overagePolicy !== 'allow') {
    return no('overage-in-use', `${name} is billing paid overage — unattended turns are refused while real money is being spent`, overage.resetsAt ? overage.resetsAt * 1000 : 0);
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
  const s = pruneBudget(state, at);
  if (!key) return { state: s, warn: null };
  s.identities[key] = [...(s.identities[key] || []), at].slice(-MAX_STAMPS);
  s.instance = [...(s.instance || []), at].slice(-MAX_STAMPS);
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
  SPEND_REASONS, BUDGET_DEFAULTS, HOUR_MS, DAY_MS, MAX_STAMPS,
  budgetLimits, emptyBudget, pruneBudget, spendCounts,
  overageState, overageText,
  authorizeUnattendedSpend, noteUnattendedSpend, refusalText, noticeText,
};
