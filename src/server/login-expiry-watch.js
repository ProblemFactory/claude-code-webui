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
// member's ledger, so all three warnings go silent again — which is exactly
// what "I fixed it" should look like.
const fs = require('fs');
const path = require('path');
const { loginAgeText, reviewWarnings, WARN_STAGES } = require('../login-expiry.js');

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

function fmtWhen(ms) {
  if (!ms) return 'an unknown time';
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; } catch { return 'an unknown time'; }
}

/** The item text for a rung. Includes the ACCOUNT NAME and the EXPIRY TIME
 *  (the spec's two facts) and is STABLE for a given expiry, because
 *  UserTodoManager.add is idempotent BY TEXT — a stable text means a re-file
 *  can never mint a second item, and the ledger means it is never re-filed
 *  anyway. Text carries the absolute time, not "in 24h", for the same reason:
 *  an item read tomorrow must not lie about when it was written. */
function itemTextFor(stage, name, info) {
  const when = fmtWhen(info.refreshExpiresAt);
  if (stage === 'expired') return `Claude login for "${name}" expired ${when} — re-login it in Manage Agents`;
  const left = loginAgeText(info.msLeft);
  return `Claude login for "${name}" expires in ${left} (${when}) — re-login it in Manage Agents`;
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
  let ledger = {};       // accountId → { exp, sent: [...] }
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
    if (parsed && Number.isFinite(parsed.since)) since = parsed.since;
  } catch { /* fresh install */ }

  function save() {
    // Atomic (tmp+rename): a torn ledger would either replay every warning or
    // suppress the real one — both are the exact failure this feature exists
    // to prevent.
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, since, members: ledger }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log('[login-expiry] ledger write failed:', e.message); }
  }

  /** ONE pass over every subscription account. Returns the stages emitted
   *  (the suite asserts on this; production ignores it). */
  function sweep() {
    const emitted = [];
    let rows = [];
    try { rows = accounts.list().accounts || []; } catch (e) { log('[login-expiry] roster read failed:', e.message); return emitted; }
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
      const prev = ledger[a.id] || null;
      const { emit, entry, suppressed } = reviewWarnings(info, prev, t, { watchingSince: since });
      if (entry) ledger[a.id] = entry; else delete ledger[a.id];
      if (suppressed) log(`[login-expiry] ${a.name || a.id}: login already dead before this ledger existed (ended ${fmtWhen(info.refreshExpiresAt)}) — recorded, not filed`);
      if (!emit) continue;
      const text = itemTextFor(emit, a.name || a.id, info);
      try {
        userTodos.add(INBOX_KEY, {
          text,
          urgency: URGENCY[emit] || 'normal',
          by: 'agent',
          sessionName: 'Manage Agents',
          detail: `Account: ${a.name || a.id}\nLogin session ends: ${fmtWhen(info.refreshExpiresAt)}\nState: ${info.state}\n\n`
            + 'A Claude subscription login has its own absolute lifetime — refreshing the access token does NOT extend it. '
            + 'When it runs out the CLI cannot refresh, every turn on this account fails, and VibeSpace can only route around it '
            + '(pooled sessions) or stop (everything else). Re-login from Manage Agents → the account\'s ⋯ menu → Re-login on this machine.',
        });
        emitted.push({ id: a.id, stage: emit });
        log(`[login-expiry] ${a.name || a.id}: ${emit} warning filed (login ends ${fmtWhen(info.refreshExpiresAt)})`);
        try { global.__vsEvent?.('login-expiry-warned', `${a.id}:${emit}`); } catch { }
      } catch (e) {
        // The inbox refused it (per-session open cap). Roll the rung back so
        // the NEXT sweep tries again — silently marking it sent would be the
        // no-silent-failures violation this whole feature is about.
        if (prev) ledger[a.id] = prev; else delete ledger[a.id];
        log('[login-expiry] could not file the inbox item:', e.message);
      }
    }
    // Drop ledger rows for accounts that no longer exist (removed / migrated).
    for (const id of Object.keys(ledger)) if (!alive.has(id)) delete ledger[id];
    save();
    return emitted;
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

  return { sweep, start, stop, ledger: () => JSON.parse(JSON.stringify(ledger)), watchingSince: () => since, INBOX_KEY, WARN_STAGES };
}

module.exports = { create, itemTextFor, INBOX_KEY, SWEEP_MS };
