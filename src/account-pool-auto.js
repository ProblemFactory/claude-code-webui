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

// LOGIN LIFETIME (2026-09-07, src/login-expiry.js — PURE→PURE): quota is not
// the only way a member becomes unusable. A subscription's OAuth login session
// has its own ABSOLUTE deadline (refreshTokenExpiresAt); past it the CLI's
// refresh fails and every turn on that member dies. `readLogin(id)` is an
// OPTIONAL input here — absent (or answering 'unknown') means "no claim", and
// every decision below then behaves EXACTLY as it did before this input
// existed. That is deliberate: a harness that cannot read a login deadline
// must not have its members quietly demoted.
const { loginUsable, loginSwitchTarget, loginRank, loginWallPhrase, loginBlockedText } = require('./login-expiry.js');
// AN EMPTY WINDOW IS NOT A CONSTRAINT AND NOT A DEADLINE (B-8b12, PURE→PURE).
// A window that has not started answers `resetsAt = now + windowDuration` on
// EVERY read — measured on this instance, 144 distinct "reset times" across 149
// consecutive reads of one codex bucket. Counting it as a bucket says the
// account has full headroom in a window nobody is spending in (harmless), but
// ranking on its reset makes it the earliest deadline forever, which is EDF's
// entire input. `src/quota-model.js` decides what an empty window is; this file
// only asks. The stamp rides the bucket because the derived legacy view puts it
// there — see toLegacyView.
//
// TWO QUESTIONS, TWO PREDICATES (r4). `bucketCounts` answers "may this bucket
// name a DEADLINE" and gates `weeklyDeadline`; `bucketStatesSpend` answers "did
// the vendor state a spend" and gates `bucketRemaining`. Asking the deadline
// predicate about the remaining made a fully FREE member read back as "no usage
// data" — see the essay in quota-model.js.
const { bucketCounts, bucketStatesSpend } = require('./quota-model.js');

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
  // A bucket the vendor never gave a number for makes no claim. An EMPTY one
  // DOES: it was stated at 0 % used, so it is 100 % free, and that is a fact
  // about headroom even though its sliding "reset" is worthless as a deadline
  // (`weeklyDeadline` asks `bucketCounts` for exactly that, three lines down).
  //
  // r3 asked the DEADLINE predicate here, and a brand-new account — both plan
  // buckets at 0 %, no reset, which is what a claude panel prints — came back
  // `known:false`, i.e. "no usage data": ranked at 50 %, reported `usable:null`,
  // and not settleable, so the pool STAYED on an exhausted member. Including it
  // cannot go the other way: this is a MIN, so a 100 %-free bucket can never
  // lift another bucket's 5 %.
  if (!bucketStatesSpend(b)) return null;
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
  // Empty windows are skipped HERE too, and this is the site that mattered: a
  // sliding reset is always ~one window away, so it wins every min() and
  // becomes the account's EDF deadline on every single evaluation.
  const push = (b) => { if (!bucketCounts(b)) return; const r = Number(b?.resetsAt) || 0; if (r > nowSec) cands.push(r); };
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
  // TWO QUESTIONS AGAIN, ON ONE ROW (r4). The row exists because the bucket
  // states a REMAINING; its `resetsAt` may only be published when the bucket
  // may name a DEADLINE. An empty window's "reset" slides with the clock, and
  // this field is what `quotaVerdict` turns into `blockedUntil` — i.e. into an
  // auto-resume arm time. Today a 100 %-free bucket can never be in the `dead`
  // list that reads it, so this is safe by CONSTRUCTION rather than by that
  // argument, which is the point: the argument would have to be re-made by
  // every future reader of this field.
  const push = (kind, b, label) => { const r = bucketRemaining(b, nowSec); if (r != null) out.push({ kind, remaining: r, label, resetsAt: bucketCounts(b) ? (Number(b?.resetsAt) || 0) : 0 }); };
  push('fiveHour', cache.fiveHour, '5h');
  push('weekly', cache.sevenDay, '7d');
  for (const b of Array.isArray(cache.scopedWeekly) ? cache.scopedWeekly : []) push('weekly', b, String(b?.name || 'model cap'));
  return out;
}

// The WEEKLY remaining % — min over the budget buckets only (7d + scoped),
// deliberately WITHOUT the 5h. The reserve floor (D2) is a rule about the
// perishable weekly BUDGET; the 5h bucket is a burst RATE limiter that refills
// ~33×/week, so folding it in would bar a member for being momentarily busy.
// null = no weekly reading at all (ignorance is not a claim — P6).
function weeklyRemaining(brs) {
  const w = (brs || []).filter((b) => b.kind === 'weekly').map((b) => b.remaining);
  return w.length ? Math.min(...w) : null;
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
  // LAST tiebreak only (2026-09-07): between two members the quota ranking
  // calls EQUAL, prefer the healthier LOGIN — an 'expiring' member ranks below
  // an equal 'ok' one. It can never reorder members the quota rules separate,
  // and with no login input every `loginPenalty` is 0, so the comparator is
  // byte-for-byte the old one (stable sort keeps the member-list order).
  const login = () => (a.loginPenalty || 0) - (b.loginPenalty || 0);
  if (a.deadline != null && b.deadline != null) {
    if (Math.abs(a.deadline - b.deadline) > 60) return a.deadline - b.deadline;
    return (b.eff - a.eff) || login();
  }
  if (a.deadline != null) return -1;
  if (b.deadline != null) return 1;
  return (b.eff - a.eff) || login();
}

/** The ranked member snapshot pushed to the holding device (sealed orders):
 *  usable members in EDF order — the device executes a LOCAL fallback switch
 *  down this list only when it both sees a hard limit banner AND cannot
 *  reach the orchestrator. */
function rankPoolMembers({ members, readCache, nowSec, readLogin = null }) {
  const out = [];
  for (const m of members) {
    // A ranked snapshot is a list of FUTURE switch targets (the live evict
    // path picks ranked[0]; the daemon's sealed-orders reflex walks it while
    // this server is unreachable, possibly hours later) — so the NEAR window
    // applies here too: never hand anyone a login that is about to die.
    if (readLogin && !loginSwitchTarget(readLogin(m.id))) continue;
    const c = readCache(m.id);
    const r = accountRemaining(c, nowSec);
    const br = bucketRems(c, nowSec);
    if (r.known && br.some((b) => b.remaining < THRESH[b.kind].hard)) continue;
    out.push({ id: m.id, name: m.name, eff: r.known ? r.remaining : UNKNOWN_REMAINING_PCT, deadline: weeklyDeadline(c, nowSec), loginPenalty: readLogin ? loginRank(readLogin(m.id)) : 0 });
  }
  out.sort(edfCompare);
  return out;
}

// readLogin = (accountId) => loginState info (src/login-expiry.js) or null.
// OPTIONAL: omit it and every rule below is inert — this function decides
// exactly as it did before logins were readable.
// reserveFloorPct = the EDF RESERVE FLOOR (design-account-hardening D2,
// setting `pool.reserveFloorPct`, 15 by default at the engine). A member whose
// WEEKLY remaining is below it is not a VOLUNTARY switch/placement target —
// EDF's job is to drain the soonest-expiring window, and the measured result
// was one member driven 60% → 95% in 12.4 hours, i.e. the policy operating with
// no floor in exactly the band where its inputs are least trustworthy. 0 =
// inert, and the parameter defaults to 0 so every existing caller decides
// EXACTLY as it did before this input existed (the readLogin rule).
// overageIds = members currently billing PAID OVERAGE (D3c, setting
// `pool.avoidOverageMembers`, default off): with overage on, `utilization`
// stays under 1 while every token costs real money, so the EDF ranking
// actively PREFERS the account that is spending dollars.
// Both are rules about VOLUNTARY moves only: a hard-dead current member may
// still escape onto them (liveness beats efficiency — the 2026-08-11 lesson),
// and the verdict SAYS which bar it landed on.
function decidePoolSwitch({ currentId, members, readCache, nowSec, proactive = false, hot = proactive, pessimism = {}, exclude = null, readLogin = null, reserveFloorPct = 0, overageIds = null, explain = false }) {
  const excluded = exclude && exclude.length ? new Set(exclude) : null;
  // `explain` keeps the historical contract (null = no switch) for every
  // existing caller and test, while letting the engine ask WHY nothing
  // happened — a pool sitting on a dead account must not be silent.
  const none = (why, extra) => (explain ? { to: null, reason: why, ...extra } : null);
  // Which buckets are actually holding this decision back, by name — plus, as
  // a SEPARATE named output, the current member's own dead LOGIN.
  //
  // ROUND-3 VERIFIER: round 1 prepended the login label into `deadBuckets`,
  // and the engine renders that array as "spent: <list>" followed by the quota
  // remedy ("until a window resets, you add a member, …"). So the one wall the
  // user can actually clear in 30 seconds was reported as a spent quota bucket
  // and the word "re-login" never appeared — the mirror of the round-2 defect
  // where `all-logins-expired` could only ever describe the OTHER members
  // (loginBlocked skips the current one BY CONSTRUCTION). A login is not a
  // bucket: it does not heal on a timer and it has a different fix, so it gets
  // its own field and `deadBuckets`/`liveBuckets` stay a pure QUOTA sentence.
  const bucketDetail = (brs) => ({
    ...(readLogin && !loginUsable(login(currentId)) ? { fromLogin: loginWallPhrase(login(currentId)) } : {}),
    deadBuckets: brs.filter((b) => b.remaining < THRESH[b.kind].hard).map((b) => `${b.label} ${Math.round(b.remaining)}%`),
    liveBuckets: brs.filter((b) => b.remaining >= THRESH[b.kind].hard).map((b) => `${b.label} ${Math.round(b.remaining)}%`),
  });
  // Login facts, asked at most once per member per decision. `login(id)` is
  // always a real info object so downstream predicates never branch on null.
  const login = (id) => (readLogin ? (readLogin(id) || { state: 'unknown' }) : { state: 'unknown' });
  const dock = (id, brs) => brs.map((b) => ({ ...b, remaining: Math.max(0, b.remaining - (pessimism[id] || 0)) }));
  const dockRem = (id, r) => (r.known ? { ...r, remaining: Math.max(0, r.remaining - (pessimism[id] || 0)) } : r);
  const curCache = readCache(currentId);
  const cur = dockRem(currentId, accountRemaining(curCache, nowSec)); // min% — display/scraps comparison
  const curDeadline = weeklyDeadline(curCache, nowSec);
  const curBr = dock(currentId, bucketRems(curCache, nowSec));
  const soft = (b) => b.remaining < (hot ? THRESH[b.kind].hot : THRESH[b.kind].hard);
  const dead = (b) => b.remaining < THRESH[b.kind].hard;
  // The CURRENT member's login is dead ⇒ it cannot serve another turn no
  // matter what its quota cache says (the quota reading was true and is now
  // irrelevant). Treated exactly like hard exhaustion: escape now, take
  // scraps if that is all there is — and SPEAK the login as a named bucket,
  // because "out of quota" would send the user to wait for a reset when the
  // fix is a 30-second re-login.
  const curLogin = login(currentId);
  const curLoginDead = !loginUsable(curLogin);
  // Per-KIND thresholds (user-designed): what matters is ABSOLUTE headroom —
  // a weekly bucket at 88% still holds ~$200, a 5h bucket at 90% one long
  // turn. exhausted = ANY bucket under its kind's (hot-raised) threshold.
  const exhausted = curLoginDead || (cur.known && curBr.some(soft));
  const hardDead = curLoginDead || (cur.known && curBr.some(dead));
  // No data on the current target → we cannot judge exhaustion; staying put is
  // safer than flapping on ignorance (the ledger will teach us eventually).
  // A DEAD LOGIN is not ignorance, so it overrides the no-data hold: the file
  // says this member cannot authenticate, which is a fact, not a gap.
  if (!cur.known && !proactive && !curLoginDead) return none('no-data');
  if (!exhausted && !proactive) return none('healthy', { fromRemaining: cur.known ? cur.remaining : null });

  // Rank candidates by EDF: known weekly deadline ascending; same deadline
  // (±60s) → MORE remaining first (equal-deadline order can't change total
  // utilization — both expire together — so optimize for fewer switches);
  // no-deadline candidates (unknown / reset-passed-fresh) rank last, ordered
  // by effective remaining (unknown = 50, the v2 rule).
  const ranked = [];
  // NEAR-window candidates, kept SEPARATE (round-2 verifier): they are barred
  // from every voluntary move, but a member with 20 min of login beats a
  // member with zero, so a HARD-DEAD current target may still fall back here.
  const nearRanked = [];
  let excludedN = 0;
  let quotaBlockedN = 0;   // dropped by the QUOTA gate — a different wall, a different sentence
  const loginBlocked = []; // [{id, name, state, msLeft}] — named, never a silently short list
  const reserveBlocked = []; // [{id, name, remaining}] — held back by the reserve floor (D2)
  const overageBlocked = []; // [{id, name}] — billing paid overage (D3c)
  const floor = Number(reserveFloorPct) > 0 ? Number(reserveFloorPct) : 0;
  const overage = overageIds && (typeof overageIds.has === 'function' ? overageIds : new Set(overageIds));
  for (const m of members) {
    if (m.id === currentId) continue;
    if (excluded && excluded.has(m.id)) { excludedN++; continue; } // just rejected this session — not a candidate
    // LOGIN GATE (2026-09-07). Two different refusals, ORDERED so each member
    // is attributed to the wall that actually stops it:
    //   dead login  — it cannot serve anything, for anyone: out, now
    //   quota dead  — a real wall of its own, even with a perfect login
    //   near expiry — it serves its OWN conversations fine; moving a
    //                 conversation ONTO a login with <30min left just buys a
    //                 second outage, so it is a LAST-RESORT target only.
    const li = login(m.id);
    if (readLogin && !loginUsable(li)) { loginBlocked.push({ id: m.id, name: m.name, state: li.state, msLeft: li.msLeft ?? null }); continue; }
    const c = readCache(m.id);
    const r = dockRem(m.id, accountRemaining(c, nowSec));
    const br = dock(m.id, bucketRems(c, nowSec));
    const eff = r.known ? r.remaining : UNKNOWN_REMAINING_PCT;
    if (r.known && br.some(dead)) { quotaBlockedN++; continue; } // gated: some bucket below its hard floor — can't serve
    // settleOk: every bucket clears its kind's HOT threshold + margin — a
    // voluntary move must land somewhere that won't itself soft-exhaust
    // (the 2.266.1 oscillation guard, now per-kind)
    const settleOk = r.known && br.length > 0 && br.every((b) => b.remaining >= THRESH[b.kind].hot + MIN_GAIN_PCT);
    const wk = weeklyRemaining(br);
    const row = { id: m.id, name: m.name, eff, known: r.known, settleOk, remaining: r.known ? r.remaining : null, weeklyRemaining: wk, deadline: weeklyDeadline(c, nowSec), loginPenalty: loginRank(li) };
    if (readLogin && !loginSwitchTarget(li)) { loginBlocked.push({ id: m.id, name: m.name, state: li.state, msLeft: li.msLeft ?? null }); nearRanked.push({ ...row, barredWhy: 'login-near' }); continue; }
    // PAID OVERAGE (D3c). Real dollars, not a spent window — it does not heal
    // on a timer, so it is named separately from every quota bucket.
    if (overage && overage.has(m.id)) { overageBlocked.push({ id: m.id, name: m.name }); nearRanked.push({ ...row, barredWhy: 'overage' }); continue; }
    // RESERVE FLOOR (D2). Only a MEASURED weekly reading may bar a member:
    // an unknown one is ignorance, and ignorance is never a claim.
    if (floor > 0 && wk != null && wk < floor) { reserveBlocked.push({ id: m.id, name: m.name, remaining: wk }); nearRanked.push({ ...row, barredWhy: 'reserve-floor' }); continue; }
    ranked.push(row);
  }
  const barDetail = () => ({
    ...(reserveBlocked.length ? { reserveBlocked, reserveFloorPct: floor } : {}),
    ...(overageBlocked.length ? { overageBlocked } : {}),
  });
  ranked.sort(edfCompare);
  nearRanked.sort(edfCompare);
  // ESCAPE SCRAPS (round-2 verifier, reproduced: current hard-dead on 5h, the
  // only quota-healthy member 20 min from its login deadline ⇒ round 1 refused
  // to move AT ALL, a strict availability regression vs the shipped code). The
  // NEAR window is a rule about VOLUNTARY moves; it must never pin a
  // conversation to a member that is ALREADY dead. Only when the current
  // target is hard-dead and nothing else is left.
  const usingScraps = !ranked.length && hardDead && nearRanked.length > 0;
  const pool = usingScraps ? nearRanked : ranked;
  if (!pool.length) {
    // SPEAK which wall we hit. 'all-logins-expired' is its own reason because
    // it points at a completely different action from 'no-members' (re-login
    // now vs wait for a quota window) — the 2.313.0 named-bucket rule. It may
    // only be claimed when the login gate is the ONLY thing that emptied the
    // list: round 1 let ONE login-blocked member outrank any number of
    // quota-dead ones and then sent the user to re-login accounts whose
    // logins were fine (round-2 verifier).
    const why = excludedN ? 'all-rejected' : (loginBlocked.length && !quotaBlockedN) ? 'all-logins-expired' : 'no-members';
    return none(why, { fromRemaining: cur.known ? cur.remaining : null, excluded: excludedN || undefined, loginBlocked: loginBlocked.length ? loginBlocked : undefined, ...barDetail(), ...bucketDetail(curBr) });
  }

  // What we are moving ONTO, when the only thing left was a dying login — the
  // move happens, and the notice has to say the login still needs renewing.
  // WHAT we are moving ONTO when the only thing left was barred from
  // voluntary moves — and WHICH bar it was, because the three have different
  // fixes: a dying login needs a re-login, a reserve-floor member needs the
  // floor raised or quota to reset, an overage member is costing real money.
  const scrapsInfo = (pick) => {
    if (!usingScraps) return {};
    if (pick.barredWhy === 'overage') return { toOverage: { id: pick.id, name: pick.name } };
    if (pick.barredWhy === 'reserve-floor') return { toReserve: { id: pick.id, name: pick.name, remaining: pick.weeklyRemaining ?? null } };
    return { toLoginNear: { id: pick.id, name: pick.name, ...(loginBlocked.find((b) => b.id === pick.id) || {}) } };
  };
  const bestSettle = pool.find((r) => r.settleOk) || null;
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
      const knownRanked = pool.filter((r) => r.known);
      const best = bestSettle || (knownRanked.length ? knownRanked.reduce((x, y) => (y.eff > x.eff ? y : x)) : pool[0]);
      // The anti-flap floor compares REMAINING QUOTA, which is meaningless
      // when the reason we must leave is a dead LOGIN (and `cur.remaining` is
      // null when that member has no cache at all — `null + 3` is 3, so the
      // old expression would have silently blocked every escape from an
      // unread member). A dead login always leaves.
      if (!curLoginDead && best.eff <= cur.remaining + MIN_GAIN_PCT) return none('stuck', { fromRemaining: cur.remaining, bestRemaining: best.remaining, bestName: best.name || best.id, loginBlocked: loginBlocked.length ? loginBlocked : undefined, ...barDetail(), ...bucketDetail(curBr) });
      // `reason` says why we LEFT (it gates the dwell-belt exemption and the
      // notice); `toLoginNear` says what we could get. Collapsing the two into
      // one string would have made a login-expired escape onto a scrap lose
      // its 180s-belt exemption.
      return { to: best.id, toName: best.name, fromRemaining: cur.known ? cur.remaining : null, toRemaining: best.remaining, reason: curLoginDead ? 'login-expired' : 'exhausted', ...scrapsInfo(best) };
    }
    // soft-exhausted (only a hot-raised threshold tripped): still usable,
    // so only move somewhere that can actually SETTLE
    if (!bestSettle) return none('no-settleable', { fromRemaining: cur.known ? cur.remaining : null, loginBlocked: loginBlocked.length ? loginBlocked : undefined, ...barDetail(), ...bucketDetail(curBr) });
    return { to: bestSettle.id, toName: bestSettle.name, fromRemaining: cur.known ? cur.remaining : null, toRemaining: bestSettle.remaining, reason: 'exhausted' };
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

/**
 * poolBlockedNotice(d, {poolName, currentName}) — THE sentence the hourly
 * "this pool is stuck" server-notice says. PURE, so the suite can assert the
 * STRING a user reads instead of only the decision object behind it.
 *
 * ROUND-3 VERIFIER, and the reason this is a function at all: the engine
 * composed this inline, so the only thing any test ever pinned was
 * `decidePoolSwitch`'s return value — and the branch where the wall is the
 * CURRENT member's dead login rendered it as a spent quota bucket ("spent:
 * login signed out") followed by the quota remedy ("until a window resets, you
 * add a member, or you move them off the pool"). The word "re-login" never
 * appeared, and the one account the user had to act on was the only one the
 * notice could not name. That notice repeats once per hour, per pool, forever,
 * because a dead login — unlike a quota wall — does not heal on a timer.
 *
 * THREE WALLS, and they can co-occur; each one may only claim what it knows:
 *   d.fromLogin            the CURRENT member's own login is dead (the account
 *                          the user must act on; NEVER in `loginBlocked`,
 *                          which skips the current member by construction)
 *   'all-logins-expired'   the login gate is the ONLY thing that emptied the
 *                          candidate list (round-2 rule)
 *   deadBuckets/liveBuckets  the QUOTA sentence — buckets only, never a login
 */
function poolBlockedNotice(d, { poolName = '', currentName = 'the current member' } = {}) {
  const dead = (d?.deadBuckets || []).join(', ');
  const live = (d?.liveBuckets || []).join(', ');
  // THE TWO VOLUNTARY-MOVE BARS (D2/D3c). They are not quota walls and they do
  // not heal on a timer: a reserve-floor member has quota the owner asked us
  // to keep, an overage member is spending real money. Naming them is the
  // difference between "out of quota" (which sends the user to wait for a
  // reset) and the two settings that actually apply.
  const held = (d?.reserveBlocked || []).map((m) => `${m.name || m.id} (${Math.round(m.remaining)}% weekly)`).join(', ');
  const heldNote = held ? ` Held back by the ${d.reserveFloorPct}% reserve floor: ${held}.` : '';
  const paying = (d?.overageBlocked || []).map((m) => m.name || m.id).join(', ');
  const payNote = paying ? ` Skipped because they are billing paid overage: ${paying}.` : '';
  // A bar is only the WHOLE story when nothing else emptied the list — the
  // same rule 'all-logins-expired' earned in round 2: a quota-emptied list
  // stays a quota sentence and the bars are named alongside it.
  const barsOnly = !dead && !!(held || paying);
  const what = dead ? `spent: ${dead}` : 'out of quota';
  const rest = live ? ` (still available: ${live})` : '';
  const loginNames = loginBlockedText(d?.loginBlocked);
  const loginWall = d?.reason === 'all-logins-expired'; // the OTHER members
  const curLoginWall = !!d?.fromLogin;                  // the CURRENT member
  // Quota facts are about the CURRENT member, so under a login wall they are a
  // side note ("its quota is also spent") and are dropped entirely when its
  // quota is fine — "out of quota" would be a plain lie about a 90% member.
  const alsoQuota = curLoginWall && dead ? ` (its quota is also spent: ${dead})` : '';
  const why = curLoginWall
    ? `${currentName}'s ${d.fromLogin} — no member can take over${alsoQuota}`
    : loginWall
    ? `no member can take it — ${loginNames}`
    : barsOnly
    ? 'every other member is held back by your spending limits'
    : d?.reason === 'no-members'
    ? `no member can serve it — ${what}${rest}`
    : `nowhere better to go — ${what}${rest}`;
  // Only meaningful for the quota walls: "the best other member is at N%" is
  // not a reason to keep waiting when the wall is an expired login.
  const alt = !loginWall && !curLoginWall && d?.bestRemaining != null ? ` The best other member is at ${Math.round(d.bestRemaining)}%.` : '';
  // MIXED wall: the members that ALSO need a re-login, whenever `why` has not
  // already listed them (round 2 — one login-blocked member used to claim the
  // whole refusal and the bucket sentence was dropped). `why` lists them ONLY
  // in the pure-'all-logins-expired' shape; when the current member's own
  // login also died, `why` is about the current member, so the others still
  // have to be named here or they vanish from the only notice about them.
  const namedInWhy = loginWall && !curLoginWall;
  const also = !namedInWhy && loginNames ? ` Also needing a re-login: ${loginNames}.` : '';
  const fix = curLoginWall
    ? ` Re-login ${currentName} in Manage Agents.`
    : loginWall
    ? ' Re-login those accounts in Manage Agents.'
    : barsOnly
    ? ' Adjust them in Settings → Spending, or add a member.'
    : ' Conversations on it will hit a limit until a window resets, you add a member, or you move them off the pool.';
  return `Pool "${poolName}": ${why}.${alt}${also}${heldNote}${payNote}${fix}`;
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

/** THE conversation label a pool notice shows — the SAME name the sidebar
 *  shows, resolved server-side. The user's custom rename lives in
 *  user-state.json `customNames`, keyed `<backend>:<backendSessionId>` (the
 *  client's getSessionKey), and is applied only in the sidebar merge; the live
 *  session object carries `.name` = the discovery/first-message name. A notice
 *  that reads `session.name` alone shows the first sentence of the chat instead
 *  of "B2B助手". PURE so test-pool-auto can pin it. customNames may be null.
 *  Precedence mirrors recordUsageAttribution's id (claudeSessionId first) and
 *  the client's legacy fallbacks (bare backend-session-id, then the webui id). */
function conversationDisplayName(session, customNames, fallbackId = '') {
  const s = session || {};
  const cn = customNames || {};
  const bsid = s.claudeSessionId || s.backendSessionId || null;
  const keys = [];
  if (bsid) keys.push(`${s.backend || 'claude'}:${bsid}`, bsid);
  if (s.sessionKey) keys.unshift(s.sessionKey);
  if (fallbackId) keys.push(fallbackId);
  for (const k of keys) {
    const v = k && Object.hasOwn(cn, k) ? cn[k] : null;
    if (v && String(v).trim()) return String(v).trim();
  }
  if (s.name && String(s.name).trim()) return String(s.name).trim();
  return fallbackId || '';
}

module.exports = {
  quotaVerdict, conversationDisplayName,
  classifyAuthFailure, decideCliRefresh, SWITCH_THRESHOLD_PCT, THRESH, rankPoolMembers, UNKNOWN_REMAINING_PCT, PROACTIVE_MARGIN_SEC, MIN_GAIN_PCT, bucketRemaining, bucketRems, accountRemaining, weeklyDeadline, decidePoolSwitch, poolBlockedNotice };
