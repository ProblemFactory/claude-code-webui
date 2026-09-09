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
      // sized from the LIVE limits (r2): retention is a function of the caps,
      // never a constant below them
      state = A.pruneBudget(raw.budget || raw, Date.now(), A.budgetLimits(serverSetting));
      if (raw.nudge && typeof raw.nudge === 'object') nudge = raw.nudge;
    }
  } catch { }
  const spoke = new Map();   // journal dedup: `${reason}|${key}|${why}` -> ts
  let chargesUnhinted = 0;   // charges that made this module resolve the identity itself (see identityFor)
  let lastUnhintedLog = 0;
  let timer = null;
  const writeNow = () => {
    try { writeJsonAtomic(file, { v: 1, budget: state, nudge }); }
    catch (e) { log('[spend] persist failed: ' + e.message); }
  };
  const persist = () => { if (timer) return; timer = setTimeout(() => { timer = null; writeNow(); }, 500); if (timer.unref) timer.unref(); };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } writeNow(); };

  const limits = () => A.budgetLimits(serverSetting);
  const overagePolicy = () => (serverSetting('spend.allowOverageTurns') === true ? 'allow' : 'refuse');

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
  function authorize({ reason, session = null, sessionId = null, sessionName = null, identity: identityHint = null, now = Date.now() } = {}) {
    const identity = identityFor(session, identityHint);
    const key = identity && identity.key;
    const v = A.authorizeUnattendedSpend({
      reason, identity, state, limits: limits(),
      overage: overageFor(key), overagePolicy: overagePolicy(),
      credential: credentialFor(key), spendControl: spendControlFor(key), now,
    });
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
   *  `authorize()` resolved and put on its verdict — see identityFor. */
  function note({ reason = null, identity: identityHint = null, session = null, now = Date.now() } = {}) {
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
    authorize, note, overageFor, spendControlFor, nudgeRec, noteNudge, flush,
    limits, overagePolicy,
    snapshot: () => ({ budget: A.pruneBudget(state, Date.now(), limits()), nudge: { ...nudge }, chargesUnhinted }),
    _file: file,
  };
}

module.exports = { create, REFUSE_LOG_MS, REFUSE_INBOX_MS, INBOX_KEY };
