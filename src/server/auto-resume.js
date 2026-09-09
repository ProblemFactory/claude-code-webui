'use strict';
// AUTO-CONTINUE AFTER A USAGE LIMIT RESETS (2.368.0, owner request after the
// CLI shipped its own version).
//
// The CLI has this feature, but it lives in the interactive REPL: `/rate-limit-
// options` is not in a stream-json session's command list (verified against a
// real init record) and the timer is a TUI `useInterval`. So a VibeSpace chat
// session hits the limit and just sits there. This module is our own, with the
// same shape — armed → fires at the reset — and one thing the CLI's cannot do:
// it SURVIVES A RESTART (the CLI's own text says "Automatic continue cancelled
// · Claude Code relaunched during the wait"). Ours is persisted and re-armed at
// boot, because a wait measured in HOURS that a deploy silently cancels is
// worse than no feature at all.
//
// ORDER OF PREFERENCE, deliberately: when the account pool has somewhere else
// to go it SWITCHES (usage-pool-engine, unchanged) — that resumes in seconds
// instead of hours. This module is the single-account fallback, so it arms on
// exhaustion and quietly disarms the moment the session produces work again
// (a switch, the user's own prompt, anything): the fire path must never be the
// reason a session starts spending.
//
// SPENDING IS THE RISK, so the gate is explicit at three levels: the global
// default (`claude.autoResumeOnLimit`, default OFF), a per-session value taken
// at spawn, and a live per-session toggle. Firing announces itself in the
// conversation — an unexplained turn that costs money is not acceptable.
const fs = require('fs');
const path = require('path');

// The CLI's own continue prompt, verbatim (2.1.239) — same words, so a session
// that has seen the TUI behave this way sees nothing new.
const CONTINUE_PROMPT = 'You can continue now. Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete.';
const TICK_MS = 30000;      // the CLI polls at 30s; match it
const GRACE_MS = 15000;     // let the reset actually land before asking
const MAX_WAIT_MS = 26 * 60 * 60 * 1000; // a weekly bucket can be far out; refuse to sit forever

// ── THE LOOP BREAKER (2026-09-07, the 130-fire incident) ───────────────────
// A fire that the session answers with ANOTHER limit rejection is a FAILED
// fire. Nothing in this module used to remember that: the engine's walled-turn
// path re-armed ("switched to a usable account"), the hot pool switch called
// fireNow(), the CLI rejected again in half a second, and the cycle repeated
// — 130 continues on one conversation and 32 on another between 23:32 and
// 04:03, ~150 junk cards in the transcript, every cycle indistinguishable
// from the first to every component involved.
// The memory is per session and PERSISTED next to the armed waits: a restart
// must not hand the loop a fresh budget (the same reasoning that makes the
// armed wait itself survive a restart).
const FIRE_WINDOW_MS = 60 * 60 * 1000;        // the window the cap + the notice ledger count in
const FIRE_BACKOFF_MS = [0, 60000, 300000];   // 1st immediate fire is free, 2nd ≥60s later, 3rd ≥5min
const FIRE_MAX_IMMEDIATE = 3;                 // per session per window; the TIMED reset path stays open
const FIRE_QUARANTINE_MS = 10 * 60 * 1000;    // an identity that just rejected this session is off the table
const FIRE_PENDING_MS = 10 * 60 * 1000;       // a fire we never heard back about stops blocking after this
const REFUSE_LOG_MS = 5 * 60 * 1000;          // one journal line per (reason, identity) — never one per cycle
const NO_TARGET_FRESH_MS = 10 * 60 * 1000;    // how long the pool's "nowhere to go" verdict may be quoted for

// ── WHAT THE CONVERSATION IS TOLD, AND WHEN (round 2 of the same incident) ──
// Round 1 gave the breaker ONE in-chat line for every refusal, and it told the
// SAME story whatever the reason: "the pool switched to X, X was rejected too,
// there is no usable member left, retrying has stopped". For `backoff`,
// `hourly-cap` and `fire-pending` every clause of that is false — X is often a
// member we never fired at (so it rejected nothing), the other members are
// healthy, and the session is STILL ARMED and does continue seconds later. It
// also spent the once-per-window budget, so the genuine "nothing can serve you"
// line was suppressed for the rest of the hour.
// The rule now: a refusal may only claim what its OWN reason knows.
//   same-identity  the identity a continue would land on just rejected THIS
//                  conversation — the only reason that may say "it refused us
//                  too". The extra clause "and there is nowhere else to go"
//                  needs a SECOND fact, the pool's own no-target verdict
//                  (noteNoPoolTarget), never an assumption.
//   hourly-cap     N immediate continues this window and the session still is
//                  not working — say exactly that, nothing more.
//   backoff /      a sub-minute pacing limit on a session whose promise is
//   fire-pending   INTACT (still armed, continues by itself). Journal-only:
//                  no-silent-failures is about a BROKEN promise, not about the
//                  pacing of one we are still keeping — and a card that says
//                  "stopped retrying" seconds before retrying is a lie the
//                  user then has to un-learn.
// Each class carries its own once-per-window budget, so the cap line can never
// eat the exhaustion line's.
/** PURE. The in-chat line a refused continue deserves — null = journal-only. */
function refusalNoticeFor({ reason, label, armedResetsAt = 0, noTargetAt = 0, now = Date.now(), maxImmediate = FIRE_MAX_IMMEDIATE }) {
  const who = label || '当前账号';
  const resets = Number(armedResetsAt) || 0;
  // "we will continue at T" is only sayable when the arm is anchored on a real
  // reset; the +45s near-arm is a retry pacer, not a promise about a time
  const farReset = resets > now + 5 * 60000 ? `将在 ${new Date(resets).toLocaleString()} 重置后自动继续。` : '';
  const noTarget = !!noTargetAt && now - noTargetAt < NO_TARGET_FRESH_MS;
  if (reason === 'same-identity') {
    return {
      cls: 'exhausted',
      text: noTarget
        ? `账号 ${who} 刚刚拒绝了这个会话的自动续跑，账号池里暂时没有其它可用成员，已暂停立即重试 — 可以添加成员、把这个会话切到别的账号，或等待配额重置。`
        : `账号 ${who} 刚刚拒绝了这个会话的自动续跑，已暂停立即重试。` + (farReset || '账号池恢复可用时会自动继续。'),
    };
  }
  if (reason === 'hourly-cap') {
    // what we KNOW is the count and that no recovery signal ever arrived —
    // "it did not work" would be a claim about the CLI we cannot make
    return { cls: 'cap', text: `自动续跑在一小时内已连续尝试 ${maxImmediate} 次仍未见这个会话恢复，暂停立即重试。` + (farReset || '配额恢复后会自动继续。') };
  }
  return null;
}
/** PURE. The line that FOLLOWS a delivered continue. The wording comes from
 *  what actually unblocked us, and there are three ways to know:
 *   · kind 'now'   — the immediate path only ever runs from a pool switch
 *   · the ARM      — the +45s near-arm the pool switch creates. Since the wall
 *                    signals re-point the link BEFORE the session is armed
 *                    (measured: the real producers never reach fireNow), this
 *                    is now the COMMON pool-switch recovery, and it is
 *                    delivered by the timed path — where round 1 said
 *                    "用量上限已重置", i.e. told the user the quota had reset
 *                    when the pool had swapped accounts.
 *   · `moved`      — the pre-fire gate re-pointed the link under us (the
 *                    identity the continue lands on is not the one we
 *                    resolved before the gate): a switch by any other name.
 *   · `cause`      — the caller NAMES it. 'member-usable' is the 2026-09-08
 *                    new-member wake: a member's first reading arrived (a
 *                    login finished, or a human refreshed) and this session
 *                    was ALREADY parked on it, so NOTHING SWITCHED. Saying
 *                    "the pool switched to X" there would be the r2 defect
 *                    again — a card explaining a billed turn must name the
 *                    thing that caused it — and `kind:'now'` can no longer
 *                    stand in for "a pool switch" now that the immediate path
 *                    has a second caller.
 *  Only with none of them is "the limit reset" the reason we continued.
 *
 *  ORDER IS LOAD-BEARING, AND `cause` MAY ONLY REFINE IT (r2). `moved` still
 *  outranks `cause`: if the pre-fire gate re-pointed the link under us, the
 *  continue is landing on a member the wake never spoke about, so "the pool
 *  switched to X" is the true sentence — a `cause`-first order would have
 *  named the gate's target as the account that "recovered". Below `cause`,
 *  master's own precedence is restored verbatim: round 1 hoisted the
 *  `/^account usable again/` arm ABOVE `kind === 'now'` and so silently changed
 *  a PRE-EXISTING pair — the engine's near-arm (:1491 "account usable again")
 *  followed by a real pool switch firing with kind:'now' (:2417/:2498) — from
 *  "账号池已切换到 X" to "账号 X 已恢复可用", describing a switch as a recovery.
 *  With `cause` null every one of the eight reachable caller shapes is
 *  byte-identical to master, and test-auto-resume-loop §3 pins the pair. */
function continueNoticeFor({ kind, armReason, label, moved = false, cause = null }) {
  const who = label || '可用账号';
  const r = String(armReason || '');
  if (moved || /^switched to a usable account/.test(r)) return { cls: 'switched', text: `账号池已切换到 ${who}，已自动继续这个任务。` };
  if (cause === 'member-usable') return { cls: 'switched', text: `账号 ${who} 已恢复可用，已自动继续这个任务。` };
  if (kind === 'now') return { cls: 'switched', text: `账号池已切换到 ${who}，已自动继续这个任务。` };
  if (/^account usable again/.test(r)) return { cls: 'switched', text: `账号 ${who} 已恢复可用，已自动继续这个任务。` };
  return { cls: 'reset', text: '用量上限已重置，已自动继续这个任务。' };
}

/** Pick what to WAIT FOR when a session hits the wall (PURE). Two field
 *  corrections shaped this contract:
 *  · c1206711 #1: the rejection may name a FAR bucket while a POOL SIBLING
 *    frees much sooner — so candidates span identities (self + members).
 *  · c1206711 #2 (owner: "重置的是7d但没和5h对齐, 5h还在cd就发了恢复消息"):
 *    within ONE identity the session unblocks only when ALL its dead buckets
 *    have reset — the wait is the MAX over that identity's dead resets, never
 *    the min over every known reset (a healthy bucket's nearer reset is not
 *    a candidate at all; an earlier dead bucket's reset still leaves the
 *    later one blocking).
 *  identities: [{ label, eventMs?, buckets: {name: {resetsAt(sec), utilization?,
 *  status?, usedPercent?}} }] — identity[0] is the session's own; eventMs (ms)
 *  is the rejection's resetsAt, folded in as one of ITS dead resets.
 *  Returns { ms, label } (min over identities of max-over-dead), tooFar when
 *  nothing lands inside maxWaitMs, null when no dead reset is known at all
 *  (callers must SAY so, not just journal it). */
function writeJsonAtomic(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file + '.tmp', file);
}

/**
 * @param deps.activeSessions Map<id, session>
 * @param deps.sendToSession  (id, session, text) => boolean — puts a USER message
 *        into the live session exactly as a typed one would (so it lands in the
 *        transcript and the UI); returns false when the session cannot take it.
 * @param deps.serverSetting  (key) => value  — the global default
 * @param deps.broadcast      (sessionId, msg) => void — per-session UI state
 * @param deps.notify         (sessionId, session, text) => void — a visible line in the chat
 */
/**
 * @param deps.authorizeSpend (id, session, identity) => {ok, why, detail, retryAfter}
 *        THE SPEND CEILING (design-account-hardening §4.4c / P9). The loop
 *        breaker below bounds this producer's PACING; the authorizer bounds the
 *        MONEY, per credential slot, across every producer and across restarts.
 *        They COMPOSE — the breaker runs first (it is free and its refusals are
 *        the ones with a story to tell), and neither may be bypassed. Absent
 *        (harness without the guard wired) = allow; scripts/test-spend-paths.mjs
 *        pins the real wiring in server.js so "absent" can only mean a test.
 * @param deps.noteSpend (id, session, identity) => void — charged only when a
 *        continue was actually delivered.
 */
function create({ dataDir, activeSessions, sendToSession, serverSetting, broadcast = () => { }, notify = null, beforeFire = null, fireIdentity = null, authorizeSpend = null, noteSpend = null, notifyDelayMs = 90000, log = () => { } }) {
  const file = path.join(dataDir, 'auto-resume.json');
  let armed = new Map(); // webuiId -> { at, resetsAt, reason, cid, fired }
  let fires = new Map(); // webuiId -> loop-breaker record (see FIRE_* above)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const [k, v] of Object.entries(raw && raw.armed ? raw.armed : {})) armed.set(k, v);
    for (const [k, v] of Object.entries(raw && raw.fires ? raw.fires : {})) if (v && typeof v === 'object') fires.set(k, v);
  } catch { }
  let timer = null;

  const save = () => {
    try {
      // prune breaker records that can no longer refuse anything (their
      // window rolled over and nothing is pending) so the file stays bounded
      const now = Date.now();
      for (const [k, r] of fires) {
        const live = (r.fails || []).some((f) => now - (f.at || 0) < FIRE_QUARANTINE_MS)
          || (r.last && now - (r.last.at || 0) < FIRE_PENDING_MS)
          || now - (r.windowStart || 0) < FIRE_WINDOW_MS;
        if (!live) fires.delete(k);
      }
      writeJsonAtomic(file, { armed: Object.fromEntries(armed), fires: Object.fromEntries(fires) });
    }
    catch (e) { log('[auto-resume] persist failed: ' + e.message); }
  };
  const globalDefault = () => { try { return serverSetting('claude.autoResumeOnLimit') === true; } catch { return false; } };

  /** Per-session preference: what the session was spawned with, else the global
   *  default. `session._autoResume` is set at create and by the live toggle. */
  function enabledFor(session) {
    if (!session) return false;
    if (session._autoResume === true) return true;
    if (session._autoResume === false) return false;
    return globalDefault();
  }

  function statusFor(id) {
    const session = activeSessions.get(id);
    const a = armed.get(id) || null;
    return {
      enabled: enabledFor(session),
      explicit: session && session._autoResume !== undefined ? !!session._autoResume : null,
      globalDefault: globalDefault(),
      armed: !!a && !a.fired,
      resetsAt: a ? a.resetsAt : null,
      reason: a ? a.reason : null,
    };
  }
  const _refuseNotified = new Map(); // id → last far-refusal notice ts (1/h floor)
  const _armNotifyTimers = new Map(); // id → pending delayed-announcement timer
  const _cancelArmNotify = (id) => { const t = _armNotifyTimers.get(id); if (t) { clearTimeout(t); _armNotifyTimers.delete(id); } };
  const emit = (id) => { try { broadcast(id, { type: 'auto-resume', sessionId: id, status: statusFor(id) }); } catch { } };

  /** The live toggle (ws). Turning it OFF also cancels a pending wait. */
  function setEnabled(id, on) {
    const session = activeSessions.get(id);
    if (session) session._autoResume = !!on;
    if (!on && armed.has(id)) { armed.delete(id); save(); }
    emit(id);
    return statusFor(id);
  }

  /** Exhaustion seen for this session (rate_limit_event status=rejected, or a
   *  limit banner). resetsAtMs may be null — without a reset time there is
   *  nothing to wait FOR, so we do not pretend. */
  function armIfEnabled(id, session, resetsAtMs, reason) {
    if (!id || !session) return null;
    if (!enabledFor(session)) return null;
    const at = Date.now();
    const resets = Number(resetsAtMs) || 0;
    if (!resets || resets <= at) return null;                 // already past / unknown
    if (resets - at > MAX_WAIT_MS) {                          // a week out: say so, do not squat
      const hrs = Math.round((resets - at) / 3600000);
      log(`[auto-resume] ${id}: reset is ${hrs}h away — not arming`);
      // …but say so IN the session too (the c1206711 lesson: this refusal was
      // journal-only and the user watched a silently dead session). 1/h floor.
      const lastN = _refuseNotified.get(id) || 0;
      if (notify && at - lastN > 3600000) {
        _refuseNotified.set(id, at);
        try { notify(id, session, `用量已达上限，最近的重置在 ${new Date(resets).toLocaleString()}（约${hrs}小时后），超过自动等待上限（${Math.round(MAX_WAIT_MS / 3600000)}h），不会自动续跑。可切换账号或届时手动继续。`); } catch { }
      }
      return null;
    }
    const prev = armed.get(id);
    if (prev && !prev.fired && prev.resetsAt === resets) return prev; // idempotent
    const rec = { at, resetsAt: resets, reason: reason || 'usage limit', cid: session.claudeSessionId || null, fired: false };
    armed.set(id, rec);
    save();
    log(`[auto-resume] ${id}: armed for ${new Date(resets).toISOString()} (${reason})`);
    // DELAYED announcement (2.368.34): a dead event often races the pool
    // switch that fixes it — the armed STATE is instant (chip), but the loud
    // in-chat line waits; a disarm inside the window means it never speaks.
    _cancelArmNotify(id);
    if (notify) {
      const t = setTimeout(() => {
        _armNotifyTimers.delete(id);
        const a = armed.get(id);
        if (!a || a.fired || a.resetsAt !== resets) return;
        const s2 = activeSessions.get(id);
        if (s2) { try { notify(id, s2, `用量已达上限。已安排在 ${new Date(resets).toLocaleString()} 重置后自动继续（状态栏可取消）。`); } catch { } }
      }, Math.max(0, notifyDelayMs));
      if (t.unref) t.unref();
      _armNotifyTimers.set(id, t);
    }
    emit(id);
    return rec;
  }

  /** Anything that proves the session is NOT waiting on a wall any more
   *  disarms the wait: a pool switch that took over, the user's own prompt, a
   *  fresh non-rejected reading. A fire that lands on an already-recovered
   *  session is a wasted (billed) turn, so the DISARM is generous — every
   *  caller gets it.
   *
   *  THE BREAKER IS NOT (round 4, the verifier's finding). Round 1 cleared the
   *  loop-breaker record here unconditionally, which handed the quarantine,
   *  the 3-per-hour immediate counter and BOTH once-per-window notice budgets
   *  to any caller — and the callers are not equal. A `rate_limit_event` with
   *  status "allowed" is a PASSIVE reading the CLI emits whenever quota info
   *  changes (this instance sees it ~20× per rejection); it says something
   *  about a bucket's numbers and NOTHING about whether this conversation
   *  produced a single token. With the record deleted on every one of them,
   *  the next immediate fire onto the identity that just rejected us was
   *  allowed again and the hour's budget was never enforced in production —
   *  the loop the breaker exists to break, one reading later.
   *  So: `worked` is the caller's CLASSIFICATION of its own evidence, and only
   *  proof of WORK (a turn that completed, the user's own prompt) may clear
   *  the memory of a failed fire. Every call site is enumerated with its
   *  classification in the kb essay, and scripts/test-auto-resume-loop.mjs
   *  pins that table against the real call sites — a new caller that does not
   *  say which kind it is fails the suite rather than silently re-opening the
   *  loop. */
  function noteRecovered(id, why, { worked = true } = {}) {
    // On proof of work the breaker clears FIRST and unconditionally: after a
    // fire there is no armed record left, so anything gated behind it (the
    // early return below) would never see the proof that the fire worked.
    if (worked) noteFireOutcome(id, true, why);
    const a = armed.get(id);
    if (!a || a.fired) return;
    armed.delete(id); save();
    _cancelArmNotify(id);
    log(`[auto-resume] ${id}: disarmed (${why})`);
    emit(id);
  }

  function forget(id) { const had = fires.delete(id); if (armed.delete(id) || had) { save(); } }

  // ── THE LOOP BREAKER ──────────────────────────────────────────────────────
  /** The identity a fire would land on: the credential SLOT the session's CLI
   *  reads (the engine's `fireIdentityFor` — a pooled session's token-slot-
   *  validated link member, else its own usage key). Deliberately the SAME
   *  fact the engine's wall machine demotes, so "the fire onto X failed" and
   *  "X rejected this session" name the same X. `{key, name}`; null when the
   *  wiring can't say (the breaker then counts fires session-wide). */
  function identityFor(id, session) {
    try {
      const r = fireIdentity ? fireIdentity(id, session) : null;
      if (!r) return null;
      if (typeof r === 'string') return { key: r, name: r };
      return r.key ? { key: String(r.key), name: String(r.name || r.key) } : null;
    } catch { return null; }
  }
  const fireRec = (id, now) => {
    let r = fires.get(id);
    if (!r) { r = { n: 0, windowStart: now, fails: [], last: null, lastFireAt: 0, notified: {}, notices: {}, refuse: null, noTargetAt: 0 }; fires.set(id, r); }
    if (now - (r.windowStart || 0) > FIRE_WINDOW_MS) { r.n = 0; r.windowStart = now; r.notified = {}; r.notices = {}; }
    r.fails = (r.fails || []).filter((f) => f && now - (f.at || 0) < FIRE_QUARANTINE_MS);
    if (!r.notified || typeof r.notified !== 'object') r.notified = {}; // a truncated/older record must never throw inside deliver()
    if (!r.notices || typeof r.notices !== 'object') r.notices = {};    // per-NOTICE-CLASS budget (an older record has none)
    if (r.last && now - (r.last.at || 0) > FIRE_PENDING_MS) r.last = null; // never heard back — stop blocking on it
    return r;
  };
  /** May this session fire onto `key` right now? Every refusal is NAMED (the
   *  caller journals it once and tells the session once). */
  function canFire(id, key, kind, now) {
    const r = fireRec(id, now);
    if (r.last) return { ok: false, reason: 'fire-pending', key, retryAt: (r.last.at || now) + FIRE_PENDING_MS };
    const hit = key ? r.fails.find((f) => f.key === key) : null;
    if (hit) return { ok: false, reason: 'same-identity', key, retryAt: hit.at + FIRE_QUARANTINE_MS };
    if (kind === 'now') {
      if (r.n >= FIRE_MAX_IMMEDIATE) return { ok: false, reason: 'hourly-cap', key, retryAt: (r.windowStart || now) + FIRE_WINDOW_MS };
      const back = FIRE_BACKOFF_MS[Math.min(r.n, FIRE_BACKOFF_MS.length - 1)];
      if (r.n > 0 && now - (r.lastFireAt || 0) < back) return { ok: false, reason: 'backoff', key, retryAt: (r.lastFireAt || now) + back };
    }
    return { ok: true, reason: null, key };
  }
  function noteFired(id, key, kind, now) {
    const r = fireRec(id, now);
    r.last = { key: key || null, at: now, kind };
    r.lastFireAt = now;
    if (kind === 'now') r.n = (r.n || 0) + 1;
    r.refuse = null; // a new attempt: the next refusal is news again
  }
  /** The outcome of the fire we are waiting to hear about. ok=false is the
   *  engine's walled-turn classification (the continue was answered by another
   *  limit rejection); ok=true is any proof of real work. */
  function noteFireOutcome(id, ok, why) {
    const now = Date.now();
    const r = fires.get(id);
    if (!r) return false;
    if (ok) {
      if (!r.last && !(r.fails || []).length && !r.n) return false;
      fires.delete(id); save();
      return true;
    }
    if (!r.last) return false;         // the rejection did not answer a fire of ours
    const key = r.last.key || null;
    r.fails = (r.fails || []).filter((f) => f.key !== key);
    r.fails.push({ key, at: now });
    r.last = null;
    save();
    log(`[auto-resume] ${id}: the continue onto ${key || 'this account'} was rejected again (${why || 'usage limit'}) — not re-firing there`);
    return true;
  }
  /** Identities that rejected THIS session's continue inside the quarantine
   *  window — the engine excludes them when it picks a per-session target. */
  function recentFireFailures(id, now = Date.now()) {
    const r = fires.get(id);
    if (!r) return [];
    return (r.fails || []).filter((f) => f && now - (f.at || 0) < FIRE_QUARANTINE_MS).map((f) => f.key).filter(Boolean);
  }
  /** The engine's per-session pass found NO target for this conversation (its
   *  own `all-rejected` / `no-members` / `stuck` verdict). The ONLY source for
   *  the "there is nowhere else to go" clause — the breaker itself cannot know
   *  it, and round 1 asserted it from a refusal reason that does not imply it.
   *  Recorded only for a session the breaker already tracks (armed or fired):
   *  nothing else ever reads it, so a stuck pool must not mint records. */
  function noteNoPoolTarget(id, n = 0, why = null) {
    if (!id || (!armed.has(id) && !fires.has(id))) return false;
    const now = Date.now();
    const r = fireRec(id, now);
    const prev = r.noTargetAt || 0;
    r.noTargetAt = now; r.noTargetN = Number(n) || 0; r.noTargetWhy = why || null;
    if (now - prev > 60000) save();   // the pool re-evaluates every 10s; the FACT is fresh, the disk write is not
    return true;
  }
  function logRefusal(id, session, key, label, chk, kind) {
    const now = Date.now();
    const r = fireRec(id, now);
    const sig = chk.reason + '|' + (key || '?');
    if (!r.refuse || r.refuse.sig !== sig || now - (r.refuse.at || 0) > REFUSE_LOG_MS) {
      r.refuse = { sig, at: now };
      const until = chk.retryAt ? `, not before ${new Date(chk.retryAt).toISOString()}` : '';
      log(`[auto-resume] ${id}: refused ${kind === 'now' ? 'an immediate' : 'a timed'} continue onto ${label || key || 'this account'} (${chk.reason}${until})`);
      save();
    }
    breakerNotice(id, session, label || key, kind, chk);
  }
  /** The in-chat line a refused continue deserves — the TEXT is chosen by the
   *  refusal's reason (refusalNoticeFor, PURE), each class once per session per
   *  window. Reasons that do not break the promise say nothing here; the
   *  journal above has every one of them. */
  function breakerNotice(id, session, label, kind, chk) {
    if (!notify || !session || kind !== 'now') return;
    const now = Date.now();
    const r = fireRec(id, now);
    const a = armed.get(id);
    const n = refusalNoticeFor({
      reason: chk && chk.reason, label,
      armedResetsAt: a && !a.fired ? a.resetsAt : 0,
      noTargetAt: r.noTargetAt || 0, now,
    });
    if (!n) return;                                                    // journal-only: never speaks, never spends a budget
    if (r.notices[n.cls] && now - r.notices[n.cls] < FIRE_WINDOW_MS) return;
    r.notices[n.cls] = now; save();
    try { notify(id, session, n.text); } catch { }
  }

  function due(now) {
    const out = [];
    for (const [id, a] of armed) {
      if (a.fired) continue;
      if (now >= a.resetsAt + GRACE_MS) out.push([id, a]);
    }
    return out;
  }

  /** THE SPEND CEILING, asked. Returns true when the turn may be paid for.
   *  A refusal is JOURNAL-ONLY here and deliberately so: the guard itself
   *  already told the user (one "For you" item per identity per reason per 6h,
   *  plus telemetry), and the loop-breaker's in-chat budget belongs to the
   *  refusals that describe THIS conversation's own pacing. Saying it twice,
   *  once per session, is how the round-2 "it also refused me" cards happened.
   *  The arm is NOT dropped: the promise still stands, it is the money that is
   *  out — a later hour, or a raised budget, continues the session. */
  function spendOk(id, session, ident, kind) {
    if (!authorizeSpend) return true;
    let v = null;
    try { v = authorizeSpend(id, session, ident || null); } catch (e) { log('[auto-resume] spend authorizer threw: ' + e.message); return false; } // FAIL CLOSED (P8)
    if (!v || v.ok !== false) return true;
    log(`[auto-resume] ${id}: refused ${kind === 'now' ? 'an immediate' : 'a timed'} continue onto ${(ident && ident.name) || 'this account'} (spend budget: ${v.why})`);
    return false;
  }

  /** The pre-fire gate broke. It probes fresh quota, re-runs the pool decision
   *  and re-reads the verdict, so an exception means NONE of that happened —
   *  the refusal is the only honest answer, and it must be SAID (a money gate
   *  that fails silently reads exactly like one that passed). Journal +
   *  telemetry only: the guard's own inbox item covers the user-facing half,
   *  and the loop breaker's in-chat budget belongs to the refusals that
   *  describe this conversation's pacing. */
  function gateFailedClosed(id, how, e) {
    log(`[auto-resume] ${id}: pre-fire gate ${how} — refusing the continue (fail closed): ${(e && e.message) || e}`);
    try { global.__vsEvent?.('spend-gate-error', 'auto-resume:' + how); } catch { }
  }

  /** ONE fire path for BOTH callers — the timed tick and the immediate
   *  (pool-switch) fireNow. Two things used to differ between them and both
   *  differences were bugs: the immediate path skipped the pre-fire gate
   *  entirely, and neither remembered that the previous continue onto this
   *  same identity had just been rejected.
   *    breaker → the SAME beforeFire gate → deliver → remember what we fired at
   *  Returns true when a continue was delivered or a gate is in flight. */
  function attemptFire(id, session, a, kind, why, cause = null) {
    const now = Date.now();
    if (session._arFiring) return false;   // a gate is already running for this session (also breaks fireNow ⇄ beforeFire re-entry)
    const ident = identityFor(id, session);
    const key = ident ? ident.key : null;
    const label = ident ? ident.name : null;
    const chk = canFire(id, key, kind, now);
    if (!chk.ok) { logRefusal(id, session, key, label, chk, kind); return false; }
    // THE CEILING, asked BEFORE the gate as well as after it (same shape as
    // canFire/chk2): the pre-fire gate probes quota and can re-point the link,
    // so a budget that is already spent must stop us before we pay for that
    // work, and the identity the continue actually LANDS on must be checked
    // again once the gate has had its say.
    if (!spendOk(id, session, ident, kind)) return false;
    const deliver = () => {
      const a2 = armed.get(id);
      if (!a2 || a2.fired || a2.resetsAt !== a.resetsAt) return false;   // re-armed/disarmed while gating
      if (session._isStreaming) return false;                            // it started working while we gated
      // THE IDENTITY IS RE-RESOLVED HERE, after the gate (round 2). The gate
      // is `beforeAutoResumeFire`, which runs maybePoolAutoSwitch and can
      // RE-POINT this session's credential link — so the identity resolved
      // before it is the account we were ABOUT to fire at, not the one the
      // continue lands on. Round 1 keyed noteFired/announce to the stale one,
      // which broke the invariant stated above identityFor() in exactly the
      // case the comment warns about: a rejection would quarantine the
      // account we had already left, leave the real rejector fireable, and
      // journal the wrong name. Re-check the breaker too — a gate that moves
      // us onto an identity we already burned this window must not spend.
      const now2 = Date.now();
      const ident2 = identityFor(id, session) || ident;
      const key2 = ident2 ? ident2.key : null;
      const label2 = ident2 ? ident2.name : null;
      // MOVED requires BOTH identities to be known: null → X is the wiring
      // finding its voice, not the pool switching accounts, and it must not
      // be reported as one
      const moved = !!key && !!key2 && key2 !== key;
      const chk2 = canFire(id, key2, kind, now2);
      if (!chk2.ok) {
        if (moved) log(`[auto-resume] ${id}: the gate moved this session onto ${label2 || key2} — re-checking before spending`);
        logRefusal(id, session, key2, label2, chk2, kind);
        return false;
      }
      // WHAT UNBLOCKED US decides both the journal line and the card, from the
      // ARMED RECORD (one source, one wording) — see continueNoticeFor
      const note = continueNoticeFor({ kind, armReason: a2.reason, label: label2, moved, cause });
      // THE CEILING, on the identity the continue actually lands on. The gate
      // can have moved us onto a member whose budget is spent — charging the
      // one we resolved before it is the round-2 defect in a second currency.
      // It sits BELOW the (pure, side-effect-free) card computation and ABOVE
      // the send: nothing between them spends, and test-auto-resume-loop's
      // round-2 pin measures the distance from `moved` to `continueNoticeFor`.
      if (!spendOk(id, session, ident2, kind)) return false;
      const ok = sendToSession(id, session, CONTINUE_PROMPT);
      if (!ok) { log(`[auto-resume] ${id}: could not deliver the continue prompt (will retry)`); return false; }
      armed.delete(id);
      noteFired(id, key2, kind, Date.now());
      // CHARGED ONLY WHEN THE TURN HAPPENED (two-phase): everything above can
      // refuse, and an authorization that never became a turn must not eat an
      // identity's hourly budget.
      if (noteSpend) { try { noteSpend(id, session, ident2 || null); } catch (e) { log('[auto-resume] spend accounting failed: ' + e.message); } }
      save();
      _cancelArmNotify(id);
      log(kind === 'now'
        ? `[auto-resume] ${id}: ${why}${moved ? ` (landed on ${label2 || key2})` : ''} — continued immediately`
        : `[auto-resume] ${id}: ${note.cls === 'switched' ? `pool switched to ${label2 || '?'}` : 'usage limit reset'} — continued automatically`);
      announce(id, session, key2, kind, note);
      emit(id);
      return true;
    };
    // PRE-FIRE GATE (2.369.0, owner-designed): the engine probes fresh quota
    // + re-checks the account system's verdict. false = still blocked (the
    // engine re-armed to the new blockedUntil) — do not spend. Sync
    // false/true and Promise<boolean> both supported.
    // The in-flight flag is raised BEFORE the gate runs, not inside the async
    // branch: the real gate calls maybePoolAutoSwitch, which calls fireNow for
    // armed sessions, and everything the gate does BEFORE its first await is
    // synchronous re-entry (measured: 1992 levels deep with the flag raised
    // one line too late).
    //
    // FAIL CLOSED (P8), THE THIRD LAYER. Both halves used to answer a broken
    // gate with a billed turn — `catch { gate = true; }` and `.catch(() =>
    // deliver())` — and design §1.4 only named the other two layers (the
    // engine's own `catch { return true; }` and the server.js wiring lambda).
    // Fixing those two MASKS this one in production, which is precisely why it
    // has to be fixed here as well: the mask lives in two different files from
    // the bug, and making the wiring lambda `async` (the natural refactor —
    // the callee already is) removes both halves of it at once. Measured on
    // the real module: a throwing beforeFire delivered 1 continue, a rejecting
    // one delivered 1; with the gate answering `false`, 0.
    // The ARM IS NOT DROPPED, exactly as for a `false` verdict: the promise
    // still stands, it is the gate that is unavailable, and the next tick
    // (30 s) asks again.
    session._arFiring = true;
    let gate = true;
    try { gate = beforeFire ? beforeFire(id, session) : true; }
    catch (e) { gateFailedClosed(id, 'threw', e); gate = false; }
    if (gate && typeof gate.then === 'function') {
      // TWO-ARG `then`, deliberately: the rejection handler must see ONLY the
      // gate's own failure. A trailing `.catch` would also catch a throw from
      // `deliver()` (save() on a full disk, an emit handler) and report it as
      // "the gate rejected" — and master's shape answered that case by calling
      // `deliver()` a SECOND time. A reason string is an assertion about the
      // system; the delivery's own failure gets its own line and no retry.
      gate.then(
        (g2) => { if (g2 !== false) deliver(); },
        (e) => { gateFailedClosed(id, 'rejected', e); },   // never deliver() from here
      )
        .catch((e) => { log(`[auto-resume] ${id}: delivering the continue threw after the gate allowed it: ${(e && e.message) || e}`); })
        .finally(() => { session._arFiring = false; });
      return true;
    }
    const done = gate === false ? false : deliver();
    session._arFiring = false;
    return done;
  }

  /** The in-chat line that follows a delivered continue (`note` = the PURE
   *  continueNoticeFor verdict, computed from the arm that produced this fire
   *  and the identity it actually landed on).
   *  The POOL-SWITCH class goes out at most ONCE per distinct target per
   *  session per window — the incident wrote ~150 identical "已切换到 X，已自动
   *  继续" cards into one transcript; a repeat is journal-only. The RESET class
   *  is never deduped: a continue after a real reset happens once per reset,
   *  and silence there would be an unexplained billed turn.
   *  Round 2: the dedup applies to BOTH fire paths, because the near-arm the
   *  pool switch creates is now delivered by the TIMED path (the link moves
   *  before the session is armed — measured), so the incident's card class can
   *  arrive through either one. */
  function announce(id, session, key, kind, note) {
    if (!notify || !note) return;
    const now = Date.now();
    if (note.cls === 'switched') {
      const r = fireRec(id, now);
      const k = key || '*';
      const seen = r.notified[k] || 0;
      if (seen && now - seen < FIRE_WINDOW_MS) return;   // same target, same window: the journal already has it
      r.notified[k] = now; save();
    }
    try { notify(id, session, note.text); } catch { }
  }

  /** One tick: fire everything due whose session is alive and idle. */
  function tick(now = Date.now()) {
    let fired = 0;
    for (const [id, a] of due(now)) {
      const session = activeSessions.get(id);
      if (!session) { armed.delete(id); save(); continue; }          // gone: nothing to continue
      // the feature was turned off under a live arm: drop the wait, KEEP the
      // breaker (worked:false) — nothing was produced, and a toggle off/on
      // must not hand the loop a fresh budget any more than a deploy may
      if (!enabledFor(session)) { noteRecovered(id, 'disabled', { worked: false }); continue; }
      if (session._isStreaming) { continue; }                        // it is already working — try next tick
      if (attemptFire(id, session, a, 'timed', null)) fired++;
    }
    return fired;
  }

  /** A pool switch just landed this session on a HEALTHY account while it sat
   *  limit-blocked and ARMED. A hot re-point does not move an idle session by
   *  itself (the c1206711 incident: the pool switched back at 07:09 and the
   *  un-armed session stayed dead) — deliver the continue NOW instead of
   *  waiting out a reset that no longer matters. Armed-only: an unarmed
   *  session was never promised a continue.
   *  Since 2026-09-07 this runs the breaker AND the same pre-fire gate as the
   *  tick: the incident's 130 continues all came down this path, each one
   *  bypassing the gate that would have re-verdicted the target. */
  function fireNow(id, why, { cause = null } = {}) {
    try {
      const a = armed.get(id);
      if (!a || a.fired) return false;
      const session = activeSessions.get(id);
      if (!session || !enabledFor(session) || session._isStreaming) return false;
      return attemptFire(id, session, a, 'now', why, cause);
    } catch (e) { log('[auto-resume] fireNow failed: ' + e.message); return false; }
  }

  /** WHO IS WAITING. The new-member wake (2026-09-08) has to re-examine the
   *  conversations that are ARMED — they are exactly the ones that produce
   *  neither of the two events the pool re-evaluates on (a turn end, a streamed
   *  usage record), which is how eight of them sat out a reset eight hours
   *  away. A tiny public accessor rather than the engine reaching into
   *  `_armed`: "who is waiting" is a question this module should answer, and a
   *  caller holding the map would also be able to mutate it. */
  function armedIds() { return [...armed.keys()]; }

  function start() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch (e) { log('[auto-resume] tick failed: ' + e.message); } }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  return {
    armIfEnabled, noteRecovered, forget, setEnabled, statusFor, enabledFor, fireNow, armedIds, tick, start, stop, CONTINUE_PROMPT,
    noteFireOutcome, recentFireFailures, canFire, noteNoPoolTarget, // the loop breaker's seams (engine: walled turn ⇒ ok:false; per-session switch ⇒ exclude + its own no-target verdict)
    _armed: armed, _fires: fires,
  };
}

module.exports = {
  create, CONTINUE_PROMPT, TICK_MS, GRACE_MS, MAX_WAIT_MS,
  FIRE_WINDOW_MS, FIRE_BACKOFF_MS, FIRE_MAX_IMMEDIATE, FIRE_QUARANTINE_MS, NO_TARGET_FRESH_MS,
  refusalNoticeFor, continueNoticeFor, // PURE: what the conversation is told, and when
};
