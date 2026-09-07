'use strict';
// CREDENTIAL LOGIN STATE — the ONE reader for "is this account's login still
// real, and if not, SINCE WHEN" (SHARED tier: fs read only, no deps, no
// writes, never refreshes).
//
// WHY IT EXISTS (2026-09-07, the readings-by-slot root cause). `parseAuth`
// answers a BOOLEAN (`loggedIn`) and collapses four different states into it:
//   · file gone                          → loggedIn:false
//   · `{claudeAiOauth:{accessToken:""}}`  → loggedIn:false   ← a WIPED login
//   · access token expired, refresh alive → loggedIn:true    ← still usable
//   · access AND refresh both expired     → loggedIn:true    ← NOT usable
// The last row is the satisfiable gap the pool's member filter never closed
// (`poolMembers()` filters on `loggedIn`, so it keeps a doubly-expired
// member), and the second row carries a FACT nothing else on this instance
// has: the moment the login stopped being able to produce a reading. That
// moment is the "last-known-good marker" the readings migration uses to prove
// a cache entry is foreign — on this instance Personal Max's credentials were
// emptied at 2026-09-03T05:55Z and its usage-cache file kept receiving
// limit-banner marks until 09-07, five days of readings from sessions that
// had long been re-pointed to another member.
//
// WHERE THIS LIVES (integration note): a parallel branch introduces
// `src/login-expiry.js` with its own `loginState`. There must be exactly ONE
// implementation — when that branch integrates, `src/login-expiry.js` should
// re-export from HERE (or absorb this file and update the four importers:
// usage-pool-engine, account-usage-routes, migrations, the suite). Two
// predicates that answer "is this login dead" is the twin-set the standing
// sweep exists to kill.
const fs = require('fs');
const path = require('path');

/** Every state a credential file can be in. `usable` = the CLI could make a
 *  request with it right now (or refresh into one); everything else is a
 *  reason a member must not be a switch target and its readings must not be
 *  believed after `since`. */
const STATES = ['live', 'expired', 'wiped', 'missing', 'unreadable'];

function _stat(p) { try { return fs.statSync(p); } catch { return null; } }
// mtimeMs is FRACTIONAL on ext4/NFS; a marker instant that everything else
// compares against must be a whole millisecond or `since` never equals itself.
const _mtime = (st) => Math.round(st.mtimeMs);

/** Claude: data/subs/<id>/.credentials.json → {claudeAiOauth:{accessToken,
 *  refreshToken, expiresAt, refreshTokenExpiresAt, …}}. A LOGOUT (or a
 *  `claude /logout` on another copy) leaves the file in place with both token
 *  strings EMPTY and expiresAt 0 — that is the shape this instance actually
 *  has, verified byte-for-byte before this module was written. */
function claudeState(raw, mtimeMs, now) {
  const o = raw && raw.claudeAiOauth;
  if (!o || typeof o !== 'object') return { state: 'wiped', since: mtimeMs, expiresAt: null, refreshExpiresAt: null };
  const access = typeof o.accessToken === 'string' ? o.accessToken : '';
  const refresh = typeof o.refreshToken === 'string' ? o.refreshToken : '';
  const expiresAt = Number(o.expiresAt) || 0;
  const refreshExpiresAt = Number(o.refreshTokenExpiresAt) || 0;
  if (!access) return { state: 'wiped', since: mtimeMs, expiresAt: expiresAt || null, refreshExpiresAt: refreshExpiresAt || null };
  const accessAlive = !expiresAt || expiresAt > now;
  const refreshAlive = !!refresh && (!refreshExpiresAt || refreshExpiresAt > now);
  if (accessAlive || refreshAlive) return { state: 'live', since: null, expiresAt: expiresAt || null, refreshExpiresAt: refreshExpiresAt || null };
  // both dead: the login exists on disk and `loggedIn` still says true, but no
  // request can be made with it. `since` is the LATER of the two expiries —
  // that instant, not the file's mtime, is when it stopped working.
  return { state: 'expired', since: Math.max(expiresAt, refreshExpiresAt) || mtimeMs, expiresAt: expiresAt || null, refreshExpiresAt: refreshExpiresAt || null };
}

/** Codex: <CODEX_HOME>/auth.json → {tokens:{access_token,refresh_token,
 *  id_token}, OPENAI_API_KEY, auth_mode}. No expiry is recorded in the file
 *  (the CLI refreshes silently), so the only states we can prove are
 *  live/wiped/missing. */
function codexState(raw, mtimeMs) {
  if (!raw || typeof raw !== 'object') return { state: 'wiped', since: mtimeMs, expiresAt: null, refreshExpiresAt: null };
  const t = raw.tokens || {};
  const has = !!(t.access_token || t.id_token || raw.OPENAI_API_KEY);
  return has
    ? { state: 'live', since: null, expiresAt: null, refreshExpiresAt: null }
    : { state: 'wiped', since: mtimeMs, expiresAt: null, refreshExpiresAt: null };
}

/**
 * @param {string} credsPath absolute path to .credentials.json (claude) or auth.json (codex)
 * @param {{now?:number, backend?:'claude'|'codex'}} opts
 * @returns {{state:string, usable:boolean, since:number|null, expiresAt:number|null, refreshExpiresAt:number|null, path:string}}
 */
function loginState(credsPath, { now = Date.now(), backend = null } = {}) {
  const base = { path: credsPath || null, expiresAt: null, refreshExpiresAt: null };
  if (!credsPath) return { ...base, state: 'missing', usable: false, since: null };
  const st = _stat(credsPath);
  if (!st) return { ...base, state: 'missing', usable: false, since: null };
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(credsPath, 'utf-8')); } catch {
    return { ...base, state: 'unreadable', usable: false, since: _mtime(st) };
  }
  const be = backend || (path.basename(credsPath) === 'auth.json' ? 'codex' : 'claude');
  const r = be === 'codex' ? codexState(raw, _mtime(st)) : claudeState(raw, _mtime(st), now);
  return { ...base, ...r, usable: r.state === 'live' };
}

/** "Believe nothing this identity produced after T." null = no such instant
 *  (the login is live, or we cannot prove when it died). */
function lastKnownGoodAt(state) {
  if (!state || state.state === 'live') return null;
  return Number(state.since) || null;
}

module.exports = { loginState, lastKnownGoodAt, STATES };
