'use strict';
// THE SPEND AUTHORIZER'S ORCH HALF (docs/design-account-hardening.md §4.4c,
// P9). The decision is PURE (src/spend-authorizer.js); this module is the only
// thing that reads the ledger off disk, names the identity, asks the usage
// cache about paid overage, writes the journal line, files the inbox item and
// persists the counters across a restart.
//
// TWO PHASE, exactly like the loop breaker's canFire/noteFired: `authorize()`
// answers, `note()` charges. An authorization that never becomes a turn (the
// session died between the gate and the write, the pty refused the frame) must
// not consume budget — and, symmetrically, a turn that DID happen must be
// charged even if the caller then fails to render a card.
//
// …AND THE TWO PHASES ARE NOT ONE INSTANT (r5, reproduced). Whatever a producer
// does in between is invisible to the ledger, so five deliveries dispatched in
// one synchronous pass all read the same pre-charge counts and all five are
// authorized against a cap of two. `authorize()` therefore HOLDS what it
// authorized (`v.hold`, an in-memory reservation that binds exactly like a
// charge) until `note()` converts it, `release()` gives it back, or it times
// out at A.RESERVE_TTL_MS. A hold is deliberately not a stamp: the ladder's
// stash rung — its normal fallback for an unreachable conversation — opens no
// turn, and a charge there would be a turn that never happened.
// HOLDS ARE NOT PERSISTED, on purpose: a restart kills the in-flight
// deliveries they stand for, and a hold that outlived its producer would refuse
// real turns for its whole TTL after every boot.
//
// PERSISTENCE IS THE POINT. `data/spend-budget.json` survives a restart for the
// same reason the armed auto-resume waits do: a release restart that hands the
// automatic spenders a fresh hourly budget is not a ceiling, it is a
// scheduling detail. This instance restarts several times a day.
//
// NO NEW VENDOR SURFACE (§ban-safety): every input is a file we already hold —
// the usage cache the passive capture writes, the credential state reader the
// pool already asks, and our own ledger. scripts/test-vendor-whitelist.mjs
// must stay unchanged by this module.
const fs = require('fs');
const path = require('path');
const A = require('../spend-authorizer.js');

function writeJsonAtomic(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}

const REFUSE_LOG_MS = 5 * 60 * 1000;      // one journal line per (reason, identity, why)
const REFUSE_INBOX_MS = 6 * 60 * 60 * 1000; // one "For you" item per (identity, why)
const INBOX_KEY = 'accounts';             // the same inbox row login-expiry-watch files under

/**
 * @param deps.dataDir            data/ root
 * @param deps.serverSetting      (key) => value  — the four D6 numbers + policies
 * @param deps.identityOf         (session) => {key,name}|null — the engine's OWN answer
 *        (fireIdentityFor = wallSlotFor's key): the credential slot a turn started
 *        right now would bill. NEVER a derivation of this module's own.
 * @param deps.readCacheFor       (key) => raw usage-cache object|null (overage)
 * @param deps.credentialStateOf  (key) => {usable:boolean, state:string}|null
 * @param deps.getUserTodos       () => UserTodoManager — where a refusal reaches the
 *        user. LAZY: this module is constructed with the pool engine, and the
 *        inbox is created further down the boot (TDZ otherwise).
 * @param deps.log                console.log
 */
function create({ dataDir, serverSetting = () => undefined, identityOf = null, readCacheFor = null, credentialStateOf = null, getUserTodos = () => null, log = () => { } } = {}) {
  const file = path.join(dataDir, 'spend-budget.json');
  let state = A.emptyBudget();
  let nudge = {};   // sessionKey -> {at, n, everSeenStatus} (the Stop nudge's PERSISTED cooldown)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (raw && typeof raw === 'object') {
      // PRUNE WIDE AT LOAD (r5, reproduced) — see A.LOAD_RETENTION. Retention is
      // a function of the caps (r2), but HERE THE CAPS ARE NOT KNOWABLE:
      // server.js builds this guard ~318 lines before `setupPersistence()`
      // assigns `persistenceRouter.readSettings`, so `serverSetting` answers
      // `undefined` for every key and `A.budgetLimits()` hands back the
      // DEFAULTS. With an owner day cap of 500 and 400 same-day stamps on disk,
      // that cut the ledger to 264 on EVERY BOOT and forgave 136 unattended
      // turns each time. Dropping a stamp is irreversible and forgives money;
      // keeping one costs bounded memory. The first `note()` re-prunes with the
      // live limits.
      state = A.pruneBudget(raw.budget || raw, Date.now(), A.LOAD_RETENTION);
      if (raw.nudge && typeof raw.nudge === 'object') nudge = raw.nudge;
    }
  } catch { }
  const spoke = new Map();   // journal dedup: `${reason}|${key}|${why}` -> ts
  let chargesUnhinted = 0;   // charges that made this module resolve the identity itself (see identityFor)
  let lastUnhintedLog = 0;
  let pending = [];          // the live HOLDS (see the header) — in memory only
  let holdSeq = 0;
  let holdsExpired = 0;      // CENSUS: holds nobody converted or gave back
  let lastHoldLog = 0;
  let timer = null;
  const writeNow = () => {
    try { writeJsonAtomic(file, { v: 1, budget: state, nudge }); }
    catch (e) { log('[spend] persist failed: ' + e.message); }
  };
  const persist = () => { if (timer) return; timer = setTimeout(() => { timer = null; writeNow(); }, 500); if (timer.unref) timer.unref(); };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } writeNow(); };

  const limits = () => A.budgetLimits(serverSetting);
  const overagePolicy = () => (serverSetting('spend.allowOverageTurns') === true ? 'allow' : 'refuse');

  /** Retire the holds whose producer never came back. THE COUNT IS A CENSUS,
   *  not garbage collection: a hold that timed out is a site that authorized a
   *  spend and never said whether it happened — the shape a grep over the call
   *  sites cannot see, and the same kind of production counter as
   *  `chargesUnhinted`. scripts/test-spend-paths.mjs §5d drives all five
   *  producers and asserts it stays 0. */
  function sweepHolds(now) {
    if (!pending.length) return;
    const { live, expired } = A.expirePending(pending, now);
    if (!expired.length) return;
    pending = live;
    holdsExpired += expired.length;
    if (now - lastHoldLog > REFUSE_LOG_MS) {
      lastHoldLog = now;
      log(`[spend] ${expired.length} authorization hold(s) expired with no charge and no release (${holdsExpired} so far) — a producer authorized a turn and never said what happened`);
    }
    try { global.__vsEvent?.('spend-hold-expired', String(expired.length)); } catch { }
  }

  /** THE ONE READER of `cache.overage` / `cache.spend` (design §1.4: both had
   *  zero consumers). Everything that asks "is real money being spent on this
   *  account right now" — the authorizer, the pool's voluntary-target rule and
   *  the two panels — resolves through this. */
  function overageFor(key) {
    if (!key || !readCacheFor) return null;
    let cache = null;
    try { cache = readCacheFor(key); } catch { cache = null; }
    return A.overageState(cache);
  }

  /** THE ONE READER of `cache.spendControlReached` — the third field the §1.4
   *  row names. It rides the same cache read and the same PURE module as
   *  `overageFor`, so the row's CLOSED verdict is true of all three fields
   *  rather than of two (r4: `grep -rn spendControlReached src/` used to
   *  return only its writer). */
  function spendControlFor(key) {
    if (!key || !readCacheFor) return null;
    let cache = null;
    try { cache = readCacheFor(key); } catch { cache = null; }
    return A.spendControlState(cache);
  }

  function credentialFor(key) {
    if (!key || !credentialStateOf) return null;
    try {
      const st = credentialStateOf(key);
      if (!st) return null;                                   // no reader / not an account key ⇒ unknown (P6)
      return { serves: st.usable === false ? 'no' : 'yes', state: st.state || null };
    } catch { return null; }
  }

  /** Resolve WHO pays. `identityHint` lets a caller that already resolved the
   *  slot (auto-resume re-resolves it after its pre-fire gate) hand the same
   *  object in instead of asking twice and getting two answers.
   *
   *  AUTHORIZE MAY RESOLVE; CHARGE MAY NOT (r4, reproduced). This is the ONE
   *  resolution — `authorize()` is entitled to make it, and the verdict then
   *  CARRIES it (`v.identity`) precisely so the charge can name the same slot.
   *  A `note()` that arrives with no hint asks the question a second time,
   *  against state our own handlers are free to have moved in between: the
   *  delivery ladder deferred its charge by up to 120 s and debited an account
   *  that was never asked, while the authorized one — debited nothing — never
   *  reached its ceiling. `chargesUnhinted` counts that shape in PRODUCTION;
   *  scripts/test-spend-paths.mjs §5c drives all four producers and asserts it
   *  stays 0, which is the census a grep over five call sites cannot be. */
  function identityFor(session, identityHint) {
    if (identityHint && identityHint.key) return { key: String(identityHint.key), name: String(identityHint.name || identityHint.key) };
    if (!identityOf || !session) return null;
    try {
      const r = identityOf(session);
      if (!r) return null;
      if (typeof r === 'string') return { key: r, name: r };
      return r.key ? { key: String(r.key), name: String(r.name || r.key) } : null;
    } catch { return null; }
  }

  function fileInbox(text, detail, urgency) {
    let userTodos = null;
    try { userTodos = getUserTodos(); } catch { userTodos = null; }
    if (!userTodos) return false;
    try { userTodos.add(INBOX_KEY, { text: String(text).slice(0, 300), detail, urgency, by: 'agent', sessionName: 'Spending' }); return true; }
    catch (e) { log('[spend] could not file the inbox item: ' + e.message); return false; }
  }

  /** THE GATE. Every producer of a turn nobody typed calls this BEFORE it
   *  spends, and nothing else may decide. Returns the PURE verdict; the side
   *  effects of a refusal (journal + telemetry + inbox) happen here, once. */
  function authorize({ reason, session = null, sessionId = null, sessionName = null, identity: identityHint = null, hold: takeHold = true, now = Date.now() } = {}) {
    sweepHolds(now);
    const identity = identityFor(session, identityHint);
    const key = identity && identity.key;
    const v = A.authorizeUnattendedSpend({
      reason, identity, state, limits: limits(),
      overage: overageFor(key), overagePolicy: overagePolicy(),
      credential: credentialFor(key), spendControl: spendControlFor(key),
      pending, now,
    });
    // AN "ALLOWED" ANSWER HOLDS ITS SLOT (r5). The caller carries `hold` back
    // to `note()` (it became a turn) or to `release()` (it did not); an answer
    // nobody carries back expires at A.RESERVE_TTL_MS and is counted.
    // A PROBE MUST NOT HOLD (r5, reproduced). `hold: false` asks whether this
    // spend WOULD be allowed without taking a slot for it. auto-resume asks the
    // ceiling TWICE per fire — once before its pre-fire gate, so a spent budget
    // stops us before we pay for the gate's quota probe, and once after, on the
    // identity the continue actually lands on. Measured with the real module at
    // cap 1/hour: with the first call reserving, the second refused its own
    // request and NOTHING ever fired. The charging call is the one that holds.
    if (v.ok && key && takeHold) {
      const hold = `h${++holdSeq}`;
      pending = A.reservePending(pending, { id: hold, key, at: now });
      return { ...v, hold };
    }
    if (v.ok) return v;
    const sig = `${reason}|${key || '?'}|${v.why}`;
    const last = spoke.get(sig) || 0;
    const text = A.refusalText(v, { sessionName });
    if (now - last > REFUSE_LOG_MS) {
      spoke.set(sig, now);
      if (spoke.size > 400) spoke.clear();
      log(`[spend] refused ${reason} for ${sessionId || 'a session'} on ${identity ? identity.name : 'an unknown identity'} — ${v.why}: ${v.detail}`);
    }
    try { global.__vsEvent?.('spend-refused', `${reason}:${v.why}`); } catch { }
    // NO SILENT FAILURES: a refused automatic turn is a promise the product
    // stops keeping, so the user is told once per (identity, why) per 6h. The
    // inbox is the surface, because the conversation it would have spent on is
    // by definition one nobody is watching.
    const inboxSig = `inbox|${key || '?'}|${v.why}`;
    const lastInbox = Number(state.notices[inboxSig]) || 0;
    if (now - lastInbox > REFUSE_INBOX_MS) {
      const filed = fileInbox(text,
        `Reason: ${reason}\nIdentity: ${identity ? identity.name : 'unknown'}\nRefusal: ${v.why}\n`
        + `Unattended turns used: ${v.counts.hour}/${v.limits.perIdentityHour} this hour, ${v.counts.day}/${v.limits.perIdentityDay} today `
        + `(instance ${v.counts.instanceDay}/${v.limits.perInstanceDay}).\n\n`
        + 'These ceilings bound every turn VibeSpace starts without you — the auto-continue after a usage limit, the Stop bookkeeping nudge, '
        + 'Background Work notifications and messages from other sessions. Adjust them in Settings → Spending, or act on the account named above.',
        v.why === 'overage-in-use' ? 'high' : 'normal');
      if (filed) { state.notices[inboxSig] = now; persist(); }
    }
    return v;
  }

  /** Charge a spend that actually happened. The identity is the one
   *  `authorize()` resolved and put on its verdict — see identityFor; `hold` is
   *  the reservation that verdict opened, converted here into the stamp. */
  function note({ reason = null, identity: identityHint = null, session = null, hold = null, now = Date.now() } = {}) {
    sweepHolds(now);
    // convert, never double-count: the stamp below IS this hold's outcome
    if (hold) pending = A.releasePending(pending, hold);
    if (!(identityHint && identityHint.key) && session) {
      // The charge is re-deriving the slot. Not fatal (the answer is usually
      // the same one), so it charges — a dropped charge is the money-unsafe
      // direction — but it is NEVER silent: this is the exact shape that
      // debited an account nobody asked.
      chargesUnhinted++;
      if (now - lastUnhintedLog > REFUSE_LOG_MS) {
        lastUnhintedLog = now;
        log(`[spend] charge for ${reason || 'an unattended turn'} arrived with no identity — resolving it a second time (${chargesUnhinted} so far)`);
      }
      try { global.__vsEvent?.('spend-charge-unhinted', String(reason || 'unknown')); } catch { }
    }
    const identity = identityFor(session, identityHint);
    const r = A.noteUnattendedSpend(state, { identity, at: now, limits: limits() });
    state = r.state;
    persist();
    if (r.warn) {
      const text = A.noticeText(r.warn);
      log(`[spend] ${text}`);
      try { global.__vsEvent?.('spend-budget-notice', `${r.warn.scope}:${r.warn.pct}`); } catch { }
      fileInbox(text, `Reason of the latest turn: ${reason || 'unattended'}\nScope: ${r.warn.scope}\nUsed: ${r.warn.used} of ${r.warn.limit}`, 'normal');
    }
    return r.warn;
  }

  /** GIVE BACK an authorization that did not become a turn — the ladder's
   *  stash rung, a send that failed, a steer the wrapper confirmed was folded
   *  into a turn already running. Idempotent, and a `hold` this guard never
   *  issued is a no-op: releasing is the money-SAFE half of the pair, so it
   *  must never be able to throw its way into a producer's error path.
   *  @returns true when a live hold was actually given back */
  function release({ hold = null, now = Date.now() } = {}) {
    sweepHolds(now);
    if (!hold) return false;
    const before = pending.length;
    pending = A.releasePending(pending, hold);
    return pending.length !== before;
  }

  // ── The Stop nudge's PERSISTED cooldown (D8) ───────────────────────────────
  // `s._lastStopNudge` was in-memory only, so every release restart handed the
  // largest measured automatic spender a fresh cooldown. It now lives here (and
  // the session field is a mirror, registered in src/session-schema.js with
  // this file as its home). `n` counts nudges this session answered with NO
  // status record — the exit condition a session that never reports needs.
  function nudgeRec(sessionKey) { return (sessionKey && nudge[sessionKey]) || null; }
  function noteNudge(sessionKey, { at = Date.now(), sawStatus = false } = {}) {
    if (!sessionKey) return;
    const prev = nudge[sessionKey] || { at: 0, n: 0, everSeenStatus: false };
    nudge[sessionKey] = {
      at,
      n: sawStatus ? 0 : (prev.n || 0) + 1,
      everSeenStatus: prev.everSeenStatus || !!sawStatus,
    };
    // bounded: a long-lived instance must not grow one row per dead session
    const keys = Object.keys(nudge);
    if (keys.length > 400) {
      const cut = at - 7 * 24 * 3600 * 1000;
      for (const k of keys) if ((nudge[k]?.at || 0) < cut) delete nudge[k];
    }
    persist();
  }

  return {
    authorize, note, release, overageFor, spendControlFor, nudgeRec, noteNudge, flush,
    limits, overagePolicy,
    snapshot: () => ({
      budget: A.pruneBudget(state, Date.now(), limits()), nudge: { ...nudge },
      chargesUnhinted, holdsOpen: A.expirePending(pending, Date.now()).live.length, holdsExpired,
    }),
    _file: file,
  };
}

module.exports = { create, REFUSE_LOG_MS, REFUSE_INBOX_MS, INBOX_KEY };
