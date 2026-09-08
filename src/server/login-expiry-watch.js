'use strict';
// LOGIN-EXPIRY WATCH (2026-09-07) — the passive sweep that turns
// src/login-expiry.js's reading of each subscription's credential file into
// exactly three "For you" inbox items per login: 24 h left, 1 h left, expired.
//
// WHY IT EXISTS: until now VibeSpace only reacted AFTER a turn had already
// died — the pool's auth-failure eviction logged "[pool] auth-failure evict …"
// and moved the conversation to another member, so the user saw a dead turn,
// then it "worked again", and nobody was ever told to re-login. The expiry is
// READABLE HOURS IN ADVANCE (claudeAiOauth.refreshTokenExpiresAt is absolute
// and does not move with access-token refreshes), so the honest thing is to
// say it while the user can still act.
//
// §ban-safety: this sweep only READS FILES. No vendor call, no probe, no
// token use — the timer here is the same class as the existing long-lived
// token sweep in server.js (boot + interval, local reads, notice-deduped).
//
// ONCE-PER-THRESHOLD, ACROSS RESTARTS: the decision is the pure
// `reviewWarnings` transition; this module only persists its ledger
// (data/login-expiry.json, atomic tmp+rename like every other store) and
// files the item. A re-login (a different refreshTokenExpiresAt) drops the
// member's ledger, so all three warnings go silent again.
//
// RECOVERY (2026-09-07, measured on this instance): "goes silent again" was
// only half of it. Silencing FUTURE filings does nothing about the items
// ALREADY IN THE INBOX — the owner re-logged two members, their credential
// files carried fresh tokens and a deadline 29 days out, and the "For you"
// panel still listed `Claude login for "Fish Max" is signed out …` as OPEN,
// forever, until someone ticked it off by hand. An inbox item is a claim
// about the world; when the world stops matching it, the thing that filed it
// must retract it. So the ledger now remembers the item IDS it filed for each
// member's deadline, and a real re-login RESOLVES them through the store's own
// setStatus (which saves + broadcasts, so every open client updates live) and
// says so in the journal. Three things it must never do: reopen or re-resolve
// an item the USER already handled, touch an item filed by anything else (an
// agent's vibespace-ask — we only ever act on ids from our own ledger, and we
// re-check the item before touching it), or count a credentials REWRITE that
// keeps the same deadline as a re-login (see `reloggedIn`).
const fs = require('fs');
const path = require('path');
const { loginAgeText, reviewWarnings, reloggedIn, shortSession, WARN_STAGES } = require('../login-expiry.js');

// 5 min: the 1 h rung needs a cadence well under an hour, and a file stat +
// JSON.parse per subscription is cheap enough that this never shows up next
// to the discovery sweeps. (The oat sweep's 6 h cadence would sail past the
// 1 h threshold entirely — the same "a one-shot sweep sails past" note that
// made THAT one an interval.)
const SWEEP_MS = 5 * 60e3;
const BOOT_DELAY_MS = 25 * 1000; // after the account store + user-todos exist and boot has settled
// The inbox bucket for account-level items. Not a session: these belong to
// the INSTANCE, and the panel's jump lands on Manage Agents (the same shape
// the 'jobs' bucket uses for job-borne items).
const INBOX_KEY = 'accounts';
const URGENCY = { '24h': 'normal', '1h': 'high', expired: 'urgent' };
// Who resolved it, for the panel's "recently resolved" tail. Not 'user' (the
// user did not tick it) and not 'agent' (no agent did anything) — the watch
// retracted its own claim, and the panel says "automatically".
const RESOLVED_BY = 'system';
// "We were watching across the login" — three sweeps of slack, so a tick that
// ran late (a busy event loop, an immediate post-login sweep landing just
// after a scheduled one) still counts as continuous observation.
const WITNESS_SWEEPS = 3;

function fmtWhen(ms) {
  if (!ms) return 'an unknown time';
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; } catch { return 'an unknown time'; }
}

/** The item text for a rung. Includes the ACCOUNT NAME and the EXPIRY TIME
 *  (the spec's two facts) and is STABLE for a given expiry, because
 *  UserTodoManager.add is idempotent BY TEXT — a stable text means a re-file
 *  can never mint a second item, and the ledger means it is never re-filed
 *  anyway. Text carries the absolute time, not "in 24h", for the same reason:
 *  an item read tomorrow must not lie about when it was written.
 *
 *  BRANCH ON THE STATE, NOT THE RUNG (round-3 verifier). `warnStageFor` maps
 *  BOTH 'expired' and 'logged-out' onto the terminal 'expired' rung — the rung
 *  answers "how urgent", the state answers "what happened". A wiped credential
 *  file is produced by ANY unrecoverable refresh (a revoked or rotated session,
 *  an explicit logout in an isolated dir), not only by the deadline passing,
 *  and the CLI KEEPS refreshTokenExpiresAt when it blanks the tokens — so that
 *  deadline can still be in the FUTURE. Round 1 then filed an `urgent` item
 *  saying the login "expired" at a date weeks out, while the chip on the very
 *  same account row (loginExpiryChipHtml, which does branch on the state)
 *  correctly said "login signed out". Two surfaces, one record, opposite
 *  claims. The deadline is not dropped — it rides in `detail`, next to the
 *  state — and it is still quoted here when it is genuinely in the past. */
function itemTextFor(stage, name, info, opts = {}) {
  const when = fmtWhen(info.refreshExpiresAt);
  if (info?.state === 'logged-out') {
    const ended = typeof info.msLeft === 'number' && info.msLeft <= 0 ? ` (its login session ended ${when})` : '';
    return `Claude login for "${name}" is signed out — the CLI cleared its tokens${ended}; re-login it in Manage Agents`;
  }
  if (stage === 'expired' || info?.state === 'expired') return `Claude login for "${name}" expired ${when} — re-login it in Manage Agents`;
  const left = loginAgeText(info.msLeft);
  // A measured span only describes THIS session while it is at least as long
  // as what is still left of it. A recorded 2 h span under a deadline 20 h
  // away is a leftover from some earlier login, not a policy — say nothing.
  const fits = typeof info.msLeft === 'number' && typeof opts.spanMs === 'number' && opts.spanMs >= info.msLeft;
  return `Claude login for "${name}" expires in ${left} (${when}) — re-login it in Manage Agents${fits ? shortSessionHint(opts.spanMs) : ''}`;
}

/** THE SESSION-POLICY HINT, on the 24 h / 1 h rungs only (2026-09-07).
 *
 *  "Re-login it" is advice that reads very differently depending on whether
 *  this account's logins last three weeks or one day: on a 24 h org SSO
 *  policy, the user is going to be back here tomorrow, and knowing THAT is
 *  the difference between "I'll do it later" and "I should ask IT". So when
 *  we have MEASURED this member's last login session and it came in under
 *  SHORT_SESSION_MS, the item says so.
 *
 *  It is a HINT and it says so ("may be"): we measured ONE session of ONE
 *  member, which is evidence about an org policy, not a reading of it. And it
 *  is only ever built from `measureLoginSpan`'s witnessed number — the naive
 *  version of this (deadline − credential-file mtime) reports a healthy
 *  30-day login as a 20-hour one, because every access-token refresh rewrites
 *  that file while the deadline stays put. Nothing to measure ⇒ nothing said.
 */
function shortSessionHint(spanMs) {
  if (!shortSession(spanMs)) return '';
  return ` (its last login session lasted only ~${loginAgeText(spanMs)} — this org's session policy may be short)`;
}

/** MEASURE the login session's full length, or answer null.
 *
 *  span = refreshTokenExpiresAt − the credential file's LOGIN write. The
 *  deadline is on disk; the login write is not, so it has to be witnessed
 *  against the OBSERVATION log (`seen`, one row per subscription, written on
 *  every sweep — as opposed to `members`, which only holds accounts we have
 *  something to say about):
 *   · the log confirmed this member ONE sweep ago (`seen.at`) and that was
 *     recent — we were actually watching, not booting after a week off;
 *   · the deadline CHANGED since then — an access-token refresh rewrites the
 *     file but never moves refreshTokenExpiresAt, so a new deadline can only
 *     have come from a login;
 *   · the file was written after that confirmation — so the write we are
 *     looking at is the one inside the window where the deadline changed.
 *  Together those pin the login write to a window one sweep wide, which is
 *  the whole error bar on the number. Miss any of them and we say nothing:
 *  a wrong "your sessions are ~2 h" is worse than no hint at all. */
function measureLoginSpan(info, seen, now, gapMs) {
  // Only a LIVE login has a session length: a wiped record INHERITS its
  // deadline rather than creating one, so it can never be a measurement.
  if (info?.state !== 'ok' && info?.state !== 'expiring') return null;
  const exp = info?.refreshExpiresAt ?? null;
  const w = typeof info?.writtenAt === 'number' && Number.isFinite(info.writtenAt) ? info.writtenAt : null;
  const at = typeof seen?.at === 'number' && Number.isFinite(seen.at) ? seen.at : null;
  if (exp == null || w == null || at == null) return null;
  if (now - at > gapMs) return null;          // the ledger was not running across the login
  if ((seen.exp ?? null) === exp) return null; // nothing was created — same session
  if (w < at) return null;                     // the file predates our last look
  const span = exp - w;
  // Sanity rails: a span of seconds is a clock artefact, and a span of a year
  // is not a login session either.
  return span > 60e3 && span < 400 * 86400e3 ? span : null;
}

/**
 * create(deps) — the standard factory (docs: 拆分 P1-P3 discipline).
 *   accounts   AccountManager (loginStateOf + list)
 *   userTodos  UserTodoManager (the "For you" inbox vibespace-ask writes to)
 *   dataDir    where the ledger lives
 *   log        console.log-shaped
 *   now        injectable clock (the suite drives the ladder on a fake one)
 */
function create({ accounts, userTodos, dataDir, log = () => {}, now = () => Date.now(), sweepMs = SWEEP_MS } = {}) {
  const file = path.join(dataDir, 'login-expiry.json');
  let ledger = {};       // accountId → { exp, sent: [...], items: [{id,text}] } — what we have SAID
  // THE OBSERVATION LOG, separate from the warning ledger (2026-09-07):
  // accountId → { exp, at, spanMs? } for EVERY subscription, rewritten every
  // sweep. `ledger` is deliberately sparse — a healthy member has nothing to
  // remember and its row is dropped — but that is exactly the member whose
  // NEXT login we need to have witnessed in order to measure the session
  // length. Two different questions, two stores; conflating them either
  // resurrects "the ledger row is kept forever" or makes the measurement
  // impossible for every account that is not already in trouble.
  let seen = {};
  // WHEN THIS LEDGER STARTED WATCHING (round-2 verifier). A login that died
  // BEFORE this instant, and is no longer recent, is a PRE-EXISTING CONDITION
  // — its surface is the permanent red chip in Manage Agents, not an event
  // inbox. Without it the first sweep after the upgrade filed an `urgent` item
  // for every login that had ever died: three on the instance this was built
  // on, dead 15 h, 116 h and 700 h, none of them a routing member. Persisted,
  // so the grace is spent exactly once per install and a real death two
  // minutes before the upgrade still speaks.
  let since = null;
  let timer = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.members && typeof parsed.members === 'object') ledger = parsed.members;
    if (parsed && parsed.seen && typeof parsed.seen === 'object') seen = parsed.seen;
    if (parsed && Number.isFinite(parsed.since)) since = parsed.since;
  } catch { /* fresh install */ }

  function save() {
    // Atomic (tmp+rename): a torn ledger would either replay every warning or
    // suppress the real one — both are the exact failure this feature exists
    // to prevent.
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, since, members: ledger, seen }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log('[login-expiry] ledger write failed:', e.message); }
  }

  /** RETRACT the items THIS WATCH filed for THIS member's previous deadline.
   *  Returns { n, remaining } — n resolved now, remaining = the records we
   *  could not act on (a store error; the row keeps them so the next sweep
   *  retries). Records for items that are GONE or already resolved are simply
   *  dropped: not ours to manage any more, and never reopened. */
  function resolveFiled(entry) {
    const recs = Array.isArray(entry?.items) ? entry.items : [];
    if (!recs.length) return { n: 0, remaining: [] };
    let n = 0; const remaining = [];
    for (const rec of recs) {
      if (!rec || typeof rec.id !== 'string') continue;
      let it = null;
      try { it = userTodos.get(rec.id); } catch (e) { log('[login-expiry] inbox read failed:', e.message); remaining.push(rec); continue; }
      // Already handled BY THE USER (done/dismissed), or pruned away. Leave
      // it exactly as it is — re-resolving is noise and reopening would undo
      // someone's decision.
      if (!it || it.status !== 'open') continue;
      // Belt: only ever an item in OUR bucket whose text is still the one we
      // filed. The id came from our own ledger, so this can only fire if the
      // store re-used it — but "never touch an item filed by anything else"
      // is a promise, and a promise gets a check, not a comment.
      if (it.sessionKey !== INBOX_KEY || (rec.text && it.text !== rec.text)) continue;
      try { userTodos.setStatus(rec.id, 'done', RESOLVED_BY); n++; }
      catch (e) { log('[login-expiry] could not clear the inbox item:', e.message); remaining.push(rec); }
    }
    return { n, remaining };
  }

  /** ONE pass over every subscription account. Returns { emitted, resolved }
   *  (the suite asserts on this; production ignores it). */
  function sweep() {
    const emitted = [], resolved = [];
    let rows = [];
    try { rows = accounts.list().accounts || []; } catch (e) { log('[login-expiry] roster read failed:', e.message); return { emitted, resolved }; }
    const t = now();
    if (since == null) since = t; // first sweep of a fresh install — everything already dead predates us
    const alive = new Set();
    for (const a of rows) {
      // Subscriptions only: an API key / oat record has no OAuth login
      // session, and a POOL is its members (each already visited on its own
      // row — warning twice about one login would be noise).
      if (a.type !== 'subscription') continue;
      alive.add(a.id);
      let info = null;
      try { info = accounts.loginStateOf(a.id, t); } catch { info = null; }
      if (!info) continue;
      const name = a.name || a.id;
      const exp = info.refreshExpiresAt ?? null;
      let prev = ledger[a.id] || null;
      // ── MEASURE the login session's length, against the observation log.
      // `spanMs` outlives the deadline it was measured on: it describes the
      // ORG's session policy, not one session.
      // ONE definition of "a new login session started" — the same predicate
      // that decides the retraction below, asked of the observation log.
      const prevSeen = seen[a.id] || null;
      let span = prevSeen?.spanMs ?? null;
      if (reloggedIn(info, prevSeen?.exp ?? null)) {
        const measured = measureLoginSpan(info, prevSeen, t, WITNESS_SWEEPS * sweepMs);
        if (measured != null) span = measured;
      }
      // (A re-login onto a SHORTER org policy hands back an EARLIER deadline
      // than the one we warned about — which is why `reloggedIn` asks whether
      // the deadline CHANGED, not whether it grew.)
      seen[a.id] = { exp, at: t, ...(span != null ? { spanMs: span } : {}) };
      // ── RE-LOGIN: retract before deciding. `reviewWarnings` is about to drop
      // this row (a new deadline is a new ledger) and the item ids live in it,
      // so the recovery has to happen while we still hold them.
      if (prev && reloggedIn(info, prev.exp ?? null)) {
        const { n, remaining } = resolveFiled(prev);
        prev = { ...prev, items: remaining };
        if (n) {
          resolved.push({ id: a.id, n });
          log(`[login-expiry] ${name}: re-logged in — ${n} warning${n === 1 ? '' : 's'} cleared`);
          try { global.__vsEvent?.('login-expiry-recovered', `${a.id}:${n}`); } catch { }
        }
      }
      // Item ids belong to the deadline they were filed for; a new deadline
      // starts an empty list (the old one was just retracted above).
      const sameLedger = !!prev && (prev.exp ?? null) === exp;
      const carryItems = sameLedger && Array.isArray(prev.items) ? prev.items : [];
      const { emit, entry, suppressed } = reviewWarnings(info, prev, t, { watchingSince: since });
      // The warning row stays only while it still carries something we have
      // SAID: rungs already fired, or item ids not yet retracted.
      if (entry || carryItems.length) ledger[a.id] = { exp, sent: [], ...(entry || {}), items: carryItems };
      else delete ledger[a.id];
      if (suppressed) log(`[login-expiry] ${name}: login already dead before this ledger existed (ended ${fmtWhen(info.refreshExpiresAt)}) — recorded, not filed`);
      if (!emit) continue;
      const text = itemTextFor(emit, name, info, { spanMs: span });
      try {
        const filedItem = userTodos.add(INBOX_KEY, {
          text,
          urgency: URGENCY[emit] || 'normal',
          by: 'agent',
          sessionName: 'Manage Agents',
          // Same tense rule as the text: a deadline in the past "ended", one
          // in the future "ends" — a wiped record can carry either.
          detail: `Account: ${a.name || a.id}\nLogin session ${typeof info.msLeft === 'number' && info.msLeft <= 0 ? 'ended' : 'ends'}: ${fmtWhen(info.refreshExpiresAt)}\nState: ${info.state}\n\n`
            + 'A Claude subscription login has its own absolute lifetime — refreshing the access token does NOT extend it. '
            + 'When it runs out the CLI cannot refresh, every turn on this account fails, and VibeSpace can only route around it '
            + '(pooled sessions) or stop (everything else). Re-login from Manage Agents → the account\'s ⋯ menu → Re-login on this machine.',
        });
        // Remember WHICH item, so a re-login can retract exactly this one.
        if (filedItem?.id && ledger[a.id]) ledger[a.id].items = [...(ledger[a.id].items || []), { id: filedItem.id, text }];
        emitted.push({ id: a.id, stage: emit });
        log(`[login-expiry] ${name}: ${emit} warning filed (login ends ${fmtWhen(info.refreshExpiresAt)})`);
        try { global.__vsEvent?.('login-expiry-warned', `${a.id}:${emit}`); } catch { }
      } catch (e) {
        // The inbox refused it (per-session open cap). Roll the rung back so
        // the NEXT sweep tries again — silently marking it sent would be the
        // no-silent-failures violation this whole feature is about. `prev` is
        // the POST-retraction row, so a rollback never resurrects item ids we
        // already resolved in this same sweep.
        if (prev) ledger[a.id] = prev; else delete ledger[a.id];
        log('[login-expiry] could not file the inbox item:', e.message);
      }
    }
    // Drop rows for accounts that no longer exist (removed / migrated).
    for (const id of Object.keys(ledger)) if (!alive.has(id)) delete ledger[id];
    for (const id of Object.keys(seen)) if (!alive.has(id)) delete seen[id];
    save();
    return { emitted, resolved };
  }

  function start() {
    if (timer) return;
    timer = setTimeout(function tick() {
      try { sweep(); } catch (e) { log('[login-expiry] sweep failed:', e.message); }
      timer = setTimeout(tick, sweepMs);
      if (timer.unref) timer.unref();
    }, BOOT_DELAY_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearTimeout(timer); timer = null; } }

  return { sweep, start, stop, ledger: () => JSON.parse(JSON.stringify(ledger)), seen: () => JSON.parse(JSON.stringify(seen)), watchingSince: () => since, INBOX_KEY, WARN_STAGES };
}

module.exports = { create, itemTextFor, shortSessionHint, measureLoginSpan, INBOX_KEY, SWEEP_MS, RESOLVED_BY };
