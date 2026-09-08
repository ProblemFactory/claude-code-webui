'use strict';
/**
 * reading-lag.js — PURE (imports nothing): WHOSE NUMBERS ARE THESE?
 *
 * THE INCIDENT (inc-mts8a8mr-ulmm, 2026-09-08 05:27Z; owner: "a low-usage
 * account suddenly jumped to 93% 7d"). 2.369.68 established the right rule —
 * a reading belongs to the CREDENTIAL SLOT the process was handed, pinned for
 * the turn — and that rule is still right. What it could not know is that the
 * slot moves while requests are IN FLIGHT:
 *
 *   05:27:00  the pool re-points 9 sessions PandyMax → Personal Max
 *   05:27:16  a response to a request made 39 s earlier WITH PANDYMAX'S TOKEN
 *             arrives; `readingSlotFor` resolves the slot at the turn's first
 *             reading = Personal, so PandyMax's 93 % 7d is filed on Personal
 *   05:28:38  the pool reads Personal as "5 % left" and moves everything to
 *             Fish Max — a second switch inside 98 s, caused by our own write
 *   05:29:39  Personal's own /usage panel restores it to 13 %
 *   05:31:40  the pool moves everything back
 *
 * Two false switches, and for 100 s every panel and every anchor stream
 * believed a 13 %-used account was at 93 %.
 *
 * THE EVIDENCE THE RESPONSE CARRIES ABOUT ITSELF. A rate-limit payload names
 * the WINDOW its numbers are counted in, and a weekly window is an ACCOUNT
 * FINGERPRINT: measured over this instance's whole anchor corpus (7 live
 * subscriptions, 30 days, 6 634 anchors) every identity has exactly ONE weekly
 * reset phase, stable across the whole period, and the seven phases are all
 * distinct. A roll moves `resetsAt` by exactly 604 800 s, so the PHASE
 * (resetsAt mod one week) survives it. The ±60 s wobble between the /usage
 * panel's and the event stream's spelling of the SAME window (…340 vs …400) is
 * normal and is what the jitter tolerance is for.
 *
 * So the response can be asked which credentials produced it, and that answer
 * outranks any bookkeeping of ours — the slot, the turn pin, and the OTel
 * observation are all statements about what we BELIEVE the process is reading.
 *
 * TWO RULES LIVE HERE, and they catch the two opposite errors we have now
 * measured on real data:
 *   ① the LAG SHADOW — a reading that arrives after a re-point carrying the
 *      PREVIOUS slot's window is the previous slot's (05:27, above).
 *   ② the WINDOW IDENTITY GUARD — a reading whose window contradicts the
 *      target's own established window is NEVER written to that target; it is
 *      re-filed when exactly one account's window matches, else archived with
 *      the reason. This one also catches the mirror-image defect the same
 *      journal shows at 06:10:46Z, where a turn pin held from before three
 *      re-points filed PandyMax's fresh numbers on Fish Max.
 *
 * R2 — TWO CORRECTIONS, both reproduced against the real corpus before being
 * believed, and both of the same species: a fact was trusted further than the
 * measurement supports it.
 *   (a) WHICH HALF OF A WINDOW IS AN IDENTITY. The rule above is true of the
 *       WEEKLY reset and false of the five-hour one, which names a TIME and
 *       collides across accounts constantly. Asking it made the guard invent
 *       the very misattribution it exists to prevent. `compareWindows` now
 *       decides on the weekly half alone — and therefore needs no clock.
 *   (b) WHERE THAT EVIDENCE MAY BE KEPT. `ownWindow` lived inside the
 *       usage-cache snapshot, which every reading producer rewrites whole, so
 *       ONE ordinary statusline render (8 s cadence) deleted every established
 *       window on the instance and replayed the incident. It now lives in a
 *       sidecar those producers never write (`windowSidecarName`), which is
 *       the difference between remembering to preserve a field and not being
 *       able to lose it.
 *
 * ONE RULE, TWO SPELLINGS. The statusline capture tool (data/bin/vibespace-
 * usage) ships as a SINGLE FILE to checkout-less hosts, so it cannot require
 * this module — it carries a verbatim MIRROR of the block between the
 * `>>> reading-lag mirror` sentinels below, parity-pinned byte-for-byte and
 * functionally by scripts/test-readings-attribution.mjs §13. Its r3 sidecar
 * rule ("the link moved but the numbers did not ⇒ leave them where they were")
 * is the fingerprint clause of `decideLagShadow` — the same rule, now able to
 * answer when the numbers DID move because it can read the windows.
 */

// >>> reading-lag mirror (src/reading-lag.js) — keep byte-identical
const WEEK_SEC = 604800;      // a weekly window's period; a roll is exactly this
const JITTER_SEC = 120;       // the panel and the event stream spell one window ±60 s apart
const SHADOW_MS = 10 * 60e3;  // a re-point stops explaining anything after this

/** A weekly window's ACCOUNT-STABLE half: which instant of the week it resets
 *  at. A roll adds exactly WEEK_SEC, so this does not move. */
function weeklyPhase(resetsAt) {
  const n = Number(resetsAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return ((n % WEEK_SEC) + WEEK_SEC) % WEEK_SEC;
}
/** Circular distance on the week, so 1 s past the boundary is not half a week
 *  away from 1 s before it. */
function weeklyNear(a, b, jitterSec = JITTER_SEC) {
  const p = weeklyPhase(a), q = weeklyPhase(b);
  if (p == null || q == null) return null;
  const d = Math.abs(p - q) % WEEK_SEC;
  return Math.min(d, WEEK_SEC - d) <= jitterSec;
}
/** WHERE THE ESTABLISHED WINDOW LIVES (r2). NOT inside the usage-cache
 *  snapshot: that object is REBUILT WHOLESALE by every reading producer — the
 *  statusline hook (once per 8 s per account), the on-demand ⟳, the codex
 *  snapshot writer — so a field there survives only while every one of them
 *  remembers to carry it forward. This exact file has already lost
 *  `scopedWeekly`, the org identity, `spend` and `corroborated` that way, and
 *  `ownWindow` was the fifth: ONE ordinary statusline render deleted the only
 *  evidence the guard below runs on, and the incident replayed end to end.
 *  So the window a member's buckets are counted in lives BESIDE the cache, in
 *  a file no reading producer writes at all: `.window-<key>` — no `.json`, so
 *  every usage-cache scanner keeps ignoring it, exactly as the `.slot-<id>`
 *  sidecar next to it already relies on. A fact only one producer may state
 *  does not belong in the object all the others rewrite. */
function windowSidecarName(key) { return '.window-' + String(key).replace(/[^\w.-]/g, '_'); }

/** The window fingerprint of ANY of the shapes this codebase carries readings
 *  in — a usage-cache snapshot, an anchor's `buckets`, the statusline's
 *  `rate_limits`, or one parsed rate_limit_event (which names ONE bucket).
 *  Returns {sevenDay, fiveHour, scoped:{name:resetsAt}}; absent = null, never
 *  0, because "no window stated" and "a window at the epoch" are different
 *  facts and only one of them is evidence. */
function windowOf(x) {
  const out = { sevenDay: null, fiveHour: null, scoped: {} };
  if (!x || typeof x !== 'object') return out;
  const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  // one parsed rate_limit_event: {kind:'sevenDay'|'fiveHour'|'scoped', scopedName, resetsAt}
  if (typeof x.kind === 'string' && ('resetsAt' in x) && !x.sevenDay && !x.fiveHour && !x.seven_day) {
    const r = pos(x.resetsAt);
    if (x.kind === 'sevenDay') out.sevenDay = r;
    else if (x.kind === 'fiveHour') out.fiveHour = r;
    else if (x.kind === 'scoped' && x.scopedName && r) out.scoped[String(x.scopedName).toLowerCase()] = r;
    return out;
  }
  const b7 = x.sevenDay || x.seven_day;
  const b5 = x.fiveHour || x.five_hour;
  out.sevenDay = pos(b7 && typeof b7 === 'object' ? (b7.resetsAt ?? b7.resets_at) : b7);
  out.fiveHour = pos(b5 && typeof b5 === 'object' ? (b5.resetsAt ?? b5.resets_at) : b5);
  const sw = Array.isArray(x.scopedWeekly) ? x.scopedWeekly : [];
  for (const s of sw) {
    if (!s || !s.name) continue;
    const r = pos(s.resetsAt ?? s.resets_at);
    if (r) out.scoped[String(s.name).toLowerCase()] = r;
  }
  return out;
}

/** A stable string for "are these the same numbers" (the r3 clause). Windows
 *  only — utilizations belong to `readingFingerprint` callers that have them. */
function windowFingerprint(win) {
  const w = win && win.scoped ? win : windowOf(win);
  const sc = Object.keys(w.scoped).sort().map((k) => `${k}=${w.scoped[k]}`).join(',');
  return `7d:${w.sevenDay || '-'}|5h:${w.fiveHour || '-'}|sc:${sc}`;
}

/** Does a reading's window say it came from `memberWindow`'s credentials?
 *  'agree' | 'differ' | 'unknown' — three states, because "we cannot tell" must
 *  never be spelled the same way as "yes".
 *
 *  THE WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE (r2, measured — the first
 *  spelling of this rule also asked the 5-hour window, and that was wrong in
 *  both directions). A weekly reset is an account property: every identity in
 *  this instance's 30-day corpus has exactly ONE weekly phase, stable across
 *  the period, and all seven are distinct. A FIVE-HOUR reset is a property of
 *  a TIME: it opens at the account's first request in the block and then snaps
 *  to the clock, so on the same corpus
 *    · a SAME-account 5h reading sits >120 s from that account's own
 *      still-future stamped 5h on 7.2 % (33/456) and 7.4 % (47/639) of the two
 *      busiest streams — a 'differ' about its rightful owner; and
 *    · DIFFERENT identities carry IDENTICAL 5h resets constantly (47 distinct
 *      colliding values; `resetsAt mod 1800` piles onto :00/:10/:29/:30) — an
 *      'agree' with a stranger.
 *  Scanned end to end, that rung would have re-filed a legitimate reading onto
 *  another account at 50 real moments. So five-hour is recorded (it is useful
 *  in a fingerprint, and forensics want it) and never asked WHO. A reading
 *  with no weekly component answers 'unknown', and the callers below treat
 *  that as no evidence — which is the honest answer, not a cheap one.
 *
 *  Note there is no `nowSec`: comparing weekly PHASES (mod one week) survives
 *  a roll by construction, so identity is decided without consulting a clock.
 *  The 5-hour rung was the only thing that ever needed the time. */
function compareWindows(readingWin, memberWin, { jitterSec = JITTER_SEC } = {}) {
  const a = readingWin && readingWin.scoped ? readingWin : windowOf(readingWin);
  const b = memberWin && memberWin.scoped ? memberWin : windowOf(memberWin);
  let weekly = null;
  const wk = weeklyNear(a.sevenDay, b.sevenDay, jitterSec);
  if (wk !== null) weekly = wk;
  for (const name of Object.keys(a.scoped)) {
    const r = weeklyNear(a.scoped[name], b.scoped[name], jitterSec);
    if (r === null) continue;
    if (r === false) weekly = false;         // one disagreeing scoped bucket is a disagreement
    else if (weekly === null) weekly = true;
  }
  if (weekly === true) return 'agree';
  if (weekly === false) return 'differ';
  return 'unknown';
}

/** ① THE LAG SHADOW. A reading that arrives after the link moved was produced
 *  by whichever credentials the request carried, and a re-point reaches the CLI
 *  on its NEXT request — never the response already in flight.
 *
 *  Evidence order, strongest first:
 *    · the window matches the slot we LEFT and not the one we moved to ⇒ the
 *      previous slot (the 05:27 incident, verbatim);
 *    · the window matches the one we moved to and not the one we left ⇒ the new
 *      slot (the shadow is over — this is what ends it);
 *    · BOUNDED: with the windows silent, a re-point older than `shadowMs`
 *      explains nothing, so a session that never speaks again can never pin a
 *      slot forever;
 *    · neither window decidable (unknown windows, or two members that genuinely
 *      share a weekly phase) ⇒ the r3 statusline clause: numbers identical to
 *      the last ones seen under the previous slot are still those numbers.
 *
 *  THE CLOCK RANKS BELOW THE WINDOWS (r3, reproduced). The bound used to
 *  short-circuit FIRST, above every window rung, and that made the whole rule
 *  only as good as its caller's estimate of the age. The shipped statusline has
 *  no re-point instant in hand and passed the age of its last OBSERVATION
 *  instead, so ONE ordinary render of an idle pooled TERMINAL session — 30 min
 *  since its last redraw, link re-pointed one second ago — answered
 *  `shadow-expired` and filed the previous member's 96 % onto the low-usage
 *  one, replaying the incident including its second false switch, and doing it
 *  in a shape MASTER's unconditional r3 rule had protected.
 *
 *  A clock is a PROXY for "were those credentials still in play"; the window is
 *  the ANSWER. A proxy may never overrule the thing it stands in for, so the
 *  bound now applies only where there is nothing else to go on — which is also
 *  the only place it was ever load-bearing. And `repointAgeMs == null` is
 *  UNKNOWN and does NOT expire: a caller that cannot date the re-point has not
 *  thereby proved the shadow is over (spelling unknown like 'expired' is how
 *  the r3 protection was deleted in the first place). */
function decideLagShadow({
  prevKey = null, prevWindow = null, newKey = null, newWindow = null,
  readingWindow = null, readingFingerprint = null, prevFingerprint = null,
  repointAgeMs = 0, shadowMs = SHADOW_MS, jitterSec = JITTER_SEC,
} = {}) {
  if (!prevKey || !newKey || prevKey === newKey) return { key: newKey, shadowed: false, why: 'no-repoint' };
  const cmpPrev = prevWindow ? compareWindows(readingWindow, prevWindow, { jitterSec }) : 'unknown';
  const cmpNew = newWindow ? compareWindows(readingWindow, newWindow, { jitterSec }) : 'unknown';
  if (cmpPrev === 'agree' && cmpNew === 'differ') return { key: prevKey, shadowed: true, why: 'window-of-previous-slot', cmpPrev, cmpNew };
  if (cmpNew === 'agree' && cmpPrev === 'differ') return { key: newKey, shadowed: false, why: 'window-of-new-slot', cmpPrev, cmpNew };
  if (repointAgeMs != null && (!(Number(repointAgeMs) >= 0) || Number(repointAgeMs) > shadowMs)) return { key: newKey, shadowed: false, why: 'shadow-expired', cmpPrev, cmpNew };
  if (readingFingerprint && prevFingerprint && readingFingerprint === prevFingerprint) {
    return { key: prevKey, shadowed: true, why: 'identical-payload', cmpPrev, cmpNew };
  }
  return { key: newKey, shadowed: false, why: 'no-evidence', cmpPrev, cmpNew };
}

/** ② THE WINDOW IDENTITY GUARD. Whatever bookkeeping named `key`, a reading
 *  whose window contradicts that member's OWN established window is not that
 *  member's. `windows` is {accountId: window}; `groupOf` collapses the identity
 *  groups an org-merged login spans (`__global__` + the named sub are ONE
 *  account, and must not read as two matches).
 *
 *  Outcomes — every one of them NAMED, none of them silent:
 *    write   — agrees, or there is no evidence either way (the honest default:
 *              a guard with no evidence must not delete data)
 *    refile  — contradicts the target and matches EXACTLY ONE other account
 *    archive — contradicts the target and matches none, or several */
function decideReadingTarget({ key, readingWindow, windows = {}, groupOf = null, jitterSec = JITTER_SEC } = {}) {
  const win = readingWindow && readingWindow.scoped ? readingWindow : windowOf(readingWindow);
  // NO WEEKLY COMPONENT = NO IDENTITY EVIDENCE. A `five_hour` rate_limit_event
  // states a window, but a 5-hour window names a TIME, not an account (see
  // `compareWindows`), so such a reading can never be moved or refused. Stated
  // here at the decision point so the REASON that reaches the journal and the
  // archive is true: `compareWindows` already answers 'unknown' for it, but
  // "no established window to contradict" would be a false sentence about a
  // target that has one — and in this subsystem the reason IS the diagnosis.
  if (!win.sevenDay && !Object.keys(win.scoped).length) {
    return { action: 'write', key, reason: 'reading states no weekly window', matched: [] };
  }
  const own = windows[key] || null;
  const mine = own ? compareWindows(win, own, { jitterSec }) : 'unknown';
  if (mine !== 'differ') {
    return { action: 'write', key, reason: mine === 'agree' ? 'window matches the target' : 'no established window to contradict', matched: [] };
  }
  const grp = (id) => (groupOf ? groupOf(id) : id) || id;
  const hits = new Map(); // group → representative id
  for (const id of Object.keys(windows)) {
    if (id === key) continue;
    if (compareWindows(win, windows[id], { jitterSec }) !== 'agree') continue;
    const g = grp(id);
    if (!hits.has(g)) hits.set(g, id);
  }
  const matched = [...hits.values()];
  if (matched.length === 1) {
    return { action: 'refile', key: matched[0], reason: `window ${windowFingerprint(win)} is not ${key}'s (${windowFingerprint(own)}) and matches exactly one account`, matched };
  }
  return {
    action: 'archive', key: null, matched,
    reason: matched.length
      ? `window ${windowFingerprint(win)} is not ${key}'s (${windowFingerprint(own)}) and matches ${matched.length} accounts — no single owner can be proven`
      : `window ${windowFingerprint(win)} is not ${key}'s (${windowFingerprint(own)}) and matches no known account`,
  };
}
// <<< reading-lag mirror

module.exports = {
  WEEK_SEC, JITTER_SEC, SHADOW_MS,
  weeklyPhase, weeklyNear, windowOf, windowFingerprint, windowSidecarName, compareWindows,
  decideLagShadow, decideReadingTarget,
};
