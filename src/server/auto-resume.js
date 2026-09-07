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
function create({ dataDir, activeSessions, sendToSession, serverSetting, broadcast = () => { }, notify = null, beforeFire = null, fireIdentity = null, notifyDelayMs = 90000, log = () => { } }) {
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

  /** Anything that proves the session is working again disarms the wait: a
   *  pool switch that took over, the user's own prompt, a fresh non-rejected
   *  reading. A fire that lands on an already-recovered session is a wasted
   *  (billed) turn. */
  function noteRecovered(id, why) {
    // The breaker clears FIRST and unconditionally: after a fire there is no
    // armed record left, so anything gated behind it (the early return below)
    // would never see the proof that the fire actually worked.
    noteFireOutcome(id, true, why);
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
    if (!r) { r = { n: 0, windowStart: now, fails: [], last: null, lastFireAt: 0, notified: {}, noticeAt: 0, refuse: null }; fires.set(id, r); }
    if (now - (r.windowStart || 0) > FIRE_WINDOW_MS) { r.n = 0; r.windowStart = now; r.notified = {}; r.noticeAt = 0; }
    r.fails = (r.fails || []).filter((f) => f && now - (f.at || 0) < FIRE_QUARANTINE_MS);
    if (!r.notified || typeof r.notified !== 'object') r.notified = {}; // a truncated/older record must never throw inside deliver()
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
  function logRefusal(id, session, key, label, chk, kind) {
    const now = Date.now();
    const r = fireRec(id, now);
    const sig = chk.reason + '|' + (key || '?');
    if (!r.refuse || r.refuse.sig !== sig || now - (r.refuse.at || 0) > REFUSE_LOG_MS) {
      r.refuse = { sig, at: now };
      const until = chk.retryAt ? `, not before ${new Date(chk.retryAt).toISOString()}` : '';
      log(`[auto-resume] ${id}: refused a ${kind === 'now' ? 'immediate' : 'timed'} continue onto ${label || key || 'this account'} (${chk.reason}${until})`);
      save();
    }
    breakerNotice(id, session, label || key, kind);
  }
  /** ONE honest line in the conversation when the breaker trips — once per
   *  session per window, never per cycle. The user is the only one who can
   *  act on "nothing in the pool can serve this". */
  function breakerNotice(id, session, label, kind) {
    if (!notify || !session || kind !== 'now') return;
    const now = Date.now();
    const r = fireRec(id, now);
    if (r.noticeAt && now - r.noticeAt < FIRE_WINDOW_MS) return;
    r.noticeAt = now; save();
    const a = armed.get(id);
    const resets = a && !a.fired ? Number(a.resetsAt) || 0 : 0;
    const who = label ? `${label}` : '新的账号';
    const text = resets > now + 5 * 60000
      ? `账号池已切换到 ${who}，但它同样被用量上限拒绝，已停止反复重试。将在 ${new Date(resets).toLocaleString()} 重置后自动继续。`
      : `账号池已切换到 ${who}，但它同样被用量上限拒绝，且暂时没有可用的成员。已停止反复重试 — 可以添加成员、把这个会话切到别的账号，或等待配额重置。`;
    try { notify(id, session, text); } catch { }
  }

  function due(now) {
    const out = [];
    for (const [id, a] of armed) {
      if (a.fired) continue;
      if (now >= a.resetsAt + GRACE_MS) out.push([id, a]);
    }
    return out;
  }

  /** ONE fire path for BOTH callers — the timed tick and the immediate
   *  (pool-switch) fireNow. Two things used to differ between them and both
   *  differences were bugs: the immediate path skipped the pre-fire gate
   *  entirely, and neither remembered that the previous continue onto this
   *  same identity had just been rejected.
   *    breaker → the SAME beforeFire gate → deliver → remember what we fired at
   *  Returns true when a continue was delivered or a gate is in flight. */
  function attemptFire(id, session, a, kind, why) {
    const now = Date.now();
    if (session._arFiring) return false;   // a gate is already running for this session (also breaks fireNow ⇄ beforeFire re-entry)
    const ident = identityFor(id, session);
    const key = ident ? ident.key : null;
    const label = ident ? ident.name : null;
    const chk = canFire(id, key, kind, now);
    if (!chk.ok) { logRefusal(id, session, key, label, chk, kind); return false; }
    const deliver = () => {
      const a2 = armed.get(id);
      if (!a2 || a2.fired || a2.resetsAt !== a.resetsAt) return false;   // re-armed/disarmed while gating
      if (session._isStreaming) return false;                            // it started working while we gated
      const ok = sendToSession(id, session, CONTINUE_PROMPT);
      if (!ok) { log(`[auto-resume] ${id}: could not deliver the continue prompt (will retry)`); return false; }
      armed.delete(id);
      noteFired(id, key, kind, Date.now());
      save();
      _cancelArmNotify(id);
      log(kind === 'now'
        ? `[auto-resume] ${id}: ${why} — continued immediately`
        : `[auto-resume] ${id}: usage limit reset — continued automatically`);
      announce(id, session, key, label, kind, why);
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
    session._arFiring = true;
    let gate = true;
    try { gate = beforeFire ? beforeFire(id, session) : true; } catch { gate = true; }
    if (gate && typeof gate.then === 'function') {
      gate.then((g2) => { if (g2 !== false) deliver(); }).catch(() => deliver()).finally(() => { session._arFiring = false; });
      return true;
    }
    const done = gate === false ? false : deliver();
    session._arFiring = false;
    return done;
  }

  /** The in-chat line that follows a delivered continue. The immediate one
   *  names the account the pool moved to and goes out at most ONCE per
   *  distinct target per session per window — the incident wrote ~150
   *  identical "已切换到 X，已自动继续" cards into one transcript; a repeat is
   *  journal-only. */
  function announce(id, session, key, label, kind, why) {
    if (!notify) return;
    if (kind !== 'now') { try { notify(id, session, '用量上限已重置，已自动继续这个任务。'); } catch { } return; }
    const now = Date.now();
    const r = fireRec(id, now);
    const k = key || '*';
    const seen = r.notified[k] || 0;
    if (seen && now - seen < FIRE_WINDOW_MS) return;   // same target, same window: the journal already has it
    r.notified[k] = now; save();
    try { notify(id, session, (why || `账号池已切换到 ${label || '可用账号'}`) + '，已自动继续这个任务。'); } catch { }
  }

  /** One tick: fire everything due whose session is alive and idle. */
  function tick(now = Date.now()) {
    let fired = 0;
    for (const [id, a] of due(now)) {
      const session = activeSessions.get(id);
      if (!session) { armed.delete(id); save(); continue; }          // gone: nothing to continue
      if (!enabledFor(session)) { noteRecovered(id, 'disabled'); continue; }
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
  function fireNow(id, why) {
    try {
      const a = armed.get(id);
      if (!a || a.fired) return false;
      const session = activeSessions.get(id);
      if (!session || !enabledFor(session) || session._isStreaming) return false;
      return attemptFire(id, session, a, 'now', why);
    } catch (e) { log('[auto-resume] fireNow failed: ' + e.message); return false; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch (e) { log('[auto-resume] tick failed: ' + e.message); } }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  return {
    armIfEnabled, noteRecovered, forget, setEnabled, statusFor, enabledFor, fireNow, tick, start, stop, CONTINUE_PROMPT,
    noteFireOutcome, recentFireFailures, canFire, // the loop breaker's seams (engine: walled turn ⇒ ok:false; per-session switch ⇒ exclude)
    _armed: armed, _fires: fires,
  };
}

module.exports = { create, CONTINUE_PROMPT, TICK_MS, GRACE_MS, MAX_WAIT_MS, FIRE_WINDOW_MS, FIRE_BACKOFF_MS, FIRE_MAX_IMMEDIATE, FIRE_QUARANTINE_MS };
