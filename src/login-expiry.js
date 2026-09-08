'use strict';
/**
 * LOGIN EXPIRY — PURE (imports NOTHING; safe in any process, incl. the browser
 * bundle and the device daemon).
 *
 * THE FACT (measured on a live instance, 2026-09-07): a Claude subscription's
 * `.credentials.json` carries `claudeAiOauth.refreshTokenExpiresAt` — the
 * ABSOLUTE end of the LOGIN SESSION. It does NOT move when the access token is
 * refreshed (a member refreshed 30 min ago still showed an expiry 17 h out
 * while siblings showed 5 and 16 days), so it is a real deadline the user can
 * see coming. When the access token expires past that point the CLI's refresh
 * gets `invalid_grant`, prints "Failed to authenticate: OAuth session expired
 * and could not be refreshed", and BLANKS accessToken/refreshToken/expiresAt
 * in the file while KEEPING refreshTokenExpiresAt + scopes — that wiped shape
 * is what "logged out" looks like on disk.
 *
 * Before this module VibeSpace only reacted AFTER a failed turn (the pool's
 * auth-failure eviction): the user saw a dead turn, then it "worked again" on
 * another member, and nobody was ever told to re-login. Everything here is
 * derived from the file's own numbers — there is no probe, no vendor call and
 * no timer in this module (§ban-safety: the whole feature is passive by
 * construction).
 *
 * VOCABULARY (the five states are exhaustive; 'unknown' means NO CLAIM and
 * every consumer must treat it as "do not block on this"):
 *   ok          a refresh-token deadline exists and is comfortably ahead
 *   expiring    < EXPIRING_MS away — still works, say so while there is time
 *   expired     the deadline has passed; the CLI's next refresh will fail
 *   logged-out  the CLI already wiped the tokens (the shape above)
 *   unknown     no deadline readable — never 'ok', never a reason to block
 */

// The chip / first inbox warning: a login with less than a day left is worth
// interrupting the user for (re-login is a browser round-trip they must plan).
const EXPIRING_MS = 24 * 3600e3;
// A conversation must never be MOVED onto a login that is about to die: a
// switch buys the session a fresh account, and 30 min of remaining login is
// not a fresh account. Deliberately much shorter than EXPIRING_MS — a member
// with 20 h left still serves its own conversation fine (that is why
// loginUsable and loginSwitchTarget are two different questions).
const NEAR_MS = 30 * 60e3;
// A LOGIN SESSION shorter than this is not how Claude subscriptions normally
// behave (the deadlines measured on this instance were 5, 9, 12 and 16 DAYS
// out) — it is what an org-level SSO session policy looks like from the
// outside. It is a HINT, never a claim: it is only ever spoken about a span
// this watch actually MEASURED (see measureLoginSpan in the watch), because
// the only clock on disk — the credential file's mtime — also moves on every
// access-token refresh and would otherwise report a 30-day session as a
// 20-hour one.
const SHORT_SESSION_MS = 36 * 3600e3;
// Warning ladder, most-lenient first. 'expired' is the terminal rung (it
// fires once, when the login actually dies).
const WARN_STAGES = Object.freeze(['24h', '1h', 'expired']);
const STAGE_MS = Object.freeze({ '24h': EXPIRING_MS, '1h': 3600e3 });
const DEAD_STATES = Object.freeze(['expired', 'logged-out']);

/** The oauth record inside a parsed `.credentials.json` — callers holding
 *  either the whole file object or the inner object both work. Anything else
 *  (null, a string, `{}` — the shape a Console /login wipe leaves) yields
 *  null, i.e. NO CLAIM. */
function oauthOf(creds) {
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return null;
  const inner = creds.claudeAiOauth;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  for (const k of ['accessToken', 'refreshToken', 'refreshTokenExpiresAt', 'expiresAt', 'scopes', 'subscriptionType']) {
    if (Object.prototype.hasOwnProperty.call(creds, k)) return creds;
  }
  return null;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const UNKNOWN = Object.freeze({ state: 'unknown', refreshExpiresAt: null, accessExpiresAt: null, msLeft: null });

/**
 * loginState(creds, now) → { state, refreshExpiresAt, accessExpiresAt, msLeft }
 * The ONE reading of a credential file's login lifetime. Never throws.
 */
function loginState(creds, now = Date.now()) {
  const o = oauthOf(creds);
  if (!o) return { ...UNKNOWN };
  const refreshExpiresAt = finite(o.refreshTokenExpiresAt);
  const accessExpiresAt = finite(o.expiresAt);
  const hasTokens = !!(o.accessToken || o.refreshToken);
  if (!hasTokens) {
    // The wiped shape: tokens blanked, refreshTokenExpiresAt + scopes kept.
    // A file with NOTHING left in it (no deadline, no scopes) is not evidence
    // of a wipe — it is no evidence at all.
    const residue = refreshExpiresAt != null || (Array.isArray(o.scopes) && o.scopes.length > 0);
    if (!residue) return { ...UNKNOWN };
    return { state: 'logged-out', refreshExpiresAt, accessExpiresAt, msLeft: refreshExpiresAt == null ? null : refreshExpiresAt - now };
  }
  // Tokens present but no deadline in the file: we know nothing about the
  // login session's end. 'unknown', NEVER 'ok' — claiming health we cannot
  // read is exactly how the old behaviour surprised people.
  if (refreshExpiresAt == null) return { ...UNKNOWN, accessExpiresAt };
  const msLeft = refreshExpiresAt - now;
  if (msLeft <= 0) return { state: 'expired', refreshExpiresAt, accessExpiresAt, msLeft };
  return { state: msLeft < EXPIRING_MS ? 'expiring' : 'ok', refreshExpiresAt, accessExpiresAt, msLeft };
}

/** Can this login serve AT ALL? 'unknown' says yes — no claim never blocks. */
function loginUsable(info) { return !DEAD_STATES.includes(info?.state); }

/** May a conversation be MOVED onto this login? Dead => no; inside the NEAR
 *  window => no (a switch target must outlive the switch). */
function loginSwitchTarget(info) {
  if (!loginUsable(info)) return false;
  const ms = info?.msLeft;
  return !(typeof ms === 'number' && ms < NEAR_MS);
}

/** Ranking penalty: 0 ok/unknown, 1 expiring, 2 near-expiry, 3 dead. Used as
 *  the LAST tiebreak, so an 'expiring' member ranks below an EQUAL 'ok' one
 *  and nothing else about the ordering changes. */
function loginRank(info) {
  if (!loginUsable(info)) return 3;
  if (!loginSwitchTarget(info)) return 2;
  return info?.state === 'expiring' ? 1 : 0;
}

/** The named bucket a blocked decision must SPEAK (null when nothing to say). */
function loginBlockReason(info) {
  if (info?.state === 'expired') return 'login-expired';
  if (info?.state === 'logged-out') return 'login-signed-out';
  if (!loginSwitchTarget(info)) return 'login-near-expiry';
  return null;
}

/** Compact English duration for server-side notices/labels ("17 h", "42 min",
 *  "5 days"). The CLIENT formats its own translated copy — this is for the
 *  notice/journal strings that are English everywhere else in the engine. */
function loginAgeText(ms) {
  const v = Math.abs(Number(ms) || 0);
  if (v < 90 * 1000) return `${Math.max(1, Math.round(v / 1000))} s`;
  if (v < 90 * 60e3) return `${Math.round(v / 60e3)} min`;
  if (v < 36 * 3600e3) return `${Math.round(v / 3600e3)} h`;
  return `${Math.round(v / 86400e3)} days`;
}

/** One-line bucket label for the SPEAK rule (deadBuckets et al). */
function loginBucketLabel(info) {
  switch (info?.state) {
    case 'expired': return 'login expired';
    case 'logged-out': return 'login signed out';
    case 'expiring': return `login expires in ${loginAgeText(info.msLeft)}`;
    default: return 'login';
  }
}

/** How to SAY one login-blocked member in a notice. Round 1 wrote ONE sentence
 *  ("their login session has expired or is about to") over a list that mixes
 *  three different facts, so a member with 20 min of login left was reported as
 *  expired. Each member states its OWN fact; the caller only joins them. */
function loginBlockedPhrase(m) {
  if (m?.state === 'expired') return 'login expired';
  if (m?.state === 'logged-out') return 'signed out';
  const ms = m?.msLeft;
  if (typeof ms === 'number' && ms > 0) return `login expires in ${loginAgeText(ms)}`;
  return 'login expiring';
}
/** "Fish Max (signed out), B-Stack Max (login expires in 20 min)" */
function loginBlockedText(list) {
  return (list || []).map((m) => `${m?.name || m?.id || 'a member'} (${loginBlockedPhrase(m)})`).join(', ');
}

/** How to say the CURRENT member's OWN dead login inside a sentence that has
 *  already named the account ("Fish Max's <phrase> — no member can take
 *  over"). Round-3 verifier: the current member's dead login used to be
 *  smuggled into `deadBuckets`, where the notice rendered it as a SPENT QUOTA
 *  BUCKET ("spent: login signed out") and prescribed the quota remedy — the
 *  word "re-login" never appeared, and the one account the user had to act on
 *  was the only one the notice could not name. loginBucketLabel is a LIST-ITEM
 *  label; this one is a CLAUSE, so it reads with the possessive. */
function loginWallPhrase(info) {
  if (info?.state === 'logged-out') return 'login is signed out';
  if (info?.state === 'expired') return 'login session expired';
  return 'login session is unusable'; // never reached through loginUsable(), but never silent either
}

/**
 * reloggedIn(info, prevExp) — did a REAL new login session start since the
 * deadline `prevExp` was recorded?
 *
 * Three clauses, each load-bearing:
 *  · the login must be ALIVE again ('ok'/'expiring'). A wiped file keeps
 *    refreshTokenExpiresAt and that deadline can be in the FUTURE (the round-3
 *    shape), so "the number went up" alone would read a signed-out account as
 *    recovered — and silently drop the warning that is still true.
 *  · there must be a readable deadline now. A live token with no deadline is
 *    'unknown' = NO CLAIM, and no claim never overrides a warning we filed
 *    from a fact.
 *  · the deadline must be DIFFERENT from the recorded one. A login session's
 *    deadline is fixed for its whole life, so a change can only come from a
 *    new session; a REWRITE that keeps it (an access-token refresh, a creds
 *    file copied between machines, an import) is the SAME session — nothing
 *    was fixed, so nothing may be cleared. This is the load-bearing negative.
 * `prevExp == null` with a live deadline now IS a re-login: the recorded row
 * was the un-datable wiped shape and there is a session again.
 *
 * NOT "strictly newer" — that reading is wrong in exactly the case the
 * session-policy hint exists for. An org with a 24 h SSO policy hands back a
 * deadline 24 h out; if we warned at the 24 h rung with 20 h still on the
 * clock, the new session's deadline is EARLIER than the one we warned about,
 * and a `>` test would leave that now-false item open forever — the very
 * defect this is fixing. Retraction is safe in the other direction too: the
 * warning ladder re-arms on the new deadline in the SAME sweep, so an item
 * that is still deserved is re-filed immediately, with the right numbers.
 */
function reloggedIn(info, prevExp = null) {
  if (info?.state !== 'ok' && info?.state !== 'expiring') return false;
  const exp = info?.refreshExpiresAt ?? null;
  if (exp == null) return false;
  return exp !== prevExp;
}

/** Is a MEASURED login-session length short enough to be worth mentioning as
 *  a possible org session policy? Never true for a missing measurement. */
function shortSession(spanMs) {
  return typeof spanMs === 'number' && Number.isFinite(spanMs) && spanMs > 0 && spanMs < SHORT_SESSION_MS;
}

/** The most urgent warning rung this login currently qualifies for, or null. */
function warnStageFor(info) {
  if (!loginUsable(info)) return 'expired';
  const ms = info?.msLeft;
  if (typeof ms !== 'number') return null;
  if (ms < STAGE_MS['1h']) return '1h';
  if (ms < STAGE_MS['24h']) return '24h';
  return null;
}

/**
 * reviewWarnings(info, entry, now) -> { emit, entry }
 *
 * The ONCE-PER-MEMBER-PER-THRESHOLD ledger, as a pure transition. `entry` is
 * the persisted record for this member ({ exp, sent[] }) or null.
 *
 *  · A DIFFERENT refreshTokenExpiresAt than the one the ledger recorded is a
 *    RE-LOGIN: the ledger for the old deadline is dropped, so a member that
 *    was re-logged-in goes silent (and a re-login that only bought a few
 *    hours legitimately warns again, about the NEW deadline).
 *  · Skipping a rung (server was off across the 24 h mark) does not fire a
 *    stale "expires in 24 h" — the most urgent qualifying rung fires and the
 *    ones below it are marked as done. Warning about a threshold that is
 *    already history is worse than not warning.
 *  · `emit` is null on every other tick, so a restart replays nothing: the
 *    caller persists `entry` and hands it back next sweep.
 *  · PRE-EXISTING DEATHS (round-2 verifier, measured on the instance this was
 *    built on): the terminal rung had no staleness gate, so the FIRST sweep
 *    after the upgrade filed an `urgent` item for every login that had died
 *    long before the feature existed — three of them here, dead 15 h, 116 h
 *    and 700 h, none of them a routing member. `opts.watchingSince` is when
 *    this ledger started watching; a death that happened BEFORE we were
 *    watching AND is no longer recent is a PRE-EXISTING CONDITION, whose
 *    surface is the permanent red chip in Manage Agents, not an event inbox.
 *    It is recorded as done and never spoken. Both clauses are load-bearing:
 *    a death inside STALE_GRACE_MS is still news on a fresh install, and a
 *    death AFTER watchingSince is one WE missed (server was off) — reporting
 *    that is the whole promise. Omit `watchingSince` and this gate is inert.
 *    A logged-out record with NO readable deadline cannot be dated, so it is
 *    never suppressed — firing is the fail-safe direction.
 */
// "Before we were watching" is not enough on its own: a fresh install that
// boots 20 minutes after a login died must still say so. One day is the same
// horizon EXPIRING_MS already uses for "worth interrupting the user".
const STALE_GRACE_MS = EXPIRING_MS;
function reviewWarnings(info, entry, now = Date.now(), opts = {}) {
  const exp = info?.refreshExpiresAt ?? null;
  const sameLedger = !!entry && (entry.exp ?? null) === exp;
  const sent = sameLedger && Array.isArray(entry.sent) ? entry.sent.filter((s) => WARN_STAGES.includes(s)) : [];
  const stage = warnStageFor(info, now);
  if (!stage) return { emit: null, entry: sent.length ? { exp, sent } : null };
  if (sent.includes(stage)) return { emit: null, entry: { exp, sent } };
  const watchingSince = typeof opts.watchingSince === 'number' && Number.isFinite(opts.watchingSince) ? opts.watchingSince : null;
  if (stage === 'expired' && watchingSince != null && exp != null && exp < watchingSince && now - exp > STALE_GRACE_MS) {
    return { emit: null, entry: { exp, sent: [...WARN_STAGES] }, suppressed: 'pre-existing' };
  }
  const idx = WARN_STAGES.indexOf(stage);
  const nextSent = [...new Set([...sent, ...WARN_STAGES.slice(0, idx + 1)])];
  return { emit: stage, entry: { exp, sent: nextSent } };
}

module.exports = {
  EXPIRING_MS, NEAR_MS, WARN_STAGES, STAGE_MS, DEAD_STATES, STALE_GRACE_MS, SHORT_SESSION_MS,
  loginState, loginUsable, loginSwitchTarget, loginRank, loginBlockReason,
  loginAgeText, loginBucketLabel, loginBlockedPhrase, loginBlockedText, loginWallPhrase,
  warnStageFor, reviewWarnings, reloggedIn, shortSession,
};
