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
 *  believed after `since`. 'oat' is not a file state — it is the ACCOUNT-level
 *  answer below (a long-lived token, no login dir needed). */
const STATES = ['live', 'expired', 'wiped', 'missing', 'unreadable'];
/** The long-lived-token lifetime (B-211a `claude setup-token`). DEFINED HERE
 *  and imported by AccountManager (`this.OAT_TTL_MS`) so the panel, the repair
 *  migration and the spawn resolver cannot disagree about when a token dies;
 *  the suite asserts the two are the same number. */
const OAT_TTL_MS = 31536000 * 1000;

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

/** THE ACCOUNT-level question — "can this account produce a reading at all?"
 *  — which is NOT the same as the credential FILE question above.
 *
 *  A claude subscription has TWO delivery channels (B-211a): the credential
 *  DIR (CLAUDE_SECURESTORAGE_CONFIG_DIR → .credentials.json) and a LONG-LIVED
 *  TOKEN minted by `claude setup-token`, which `resolveForSpawn` ships as
 *  CLAUDE_CODE_OAUTH_TOKEN when the dir has no login (`oatOnly`). Such a
 *  session is a normal, supported, spawnable session: it carries
 *  `_accountId = sub-X` and `VIBESPACE_ACCOUNT_KEY = sub-X`, so its
 *  rate_limit_event / statusline readings land on usage-cache/sub-X.json and
 *  are 100% that account's. Treating "the local credential dir is wiped" as
 *  "this account cannot produce readings" would archive every legitimate
 *  reading it ever wrote and rewind its panel to whatever predates the wipe
 *  (measured on a fixture: a 1h-old reading replaced by a 6-day-old one, its
 *  fresh anchor dropped, the instance's learned rates deleted).
 *
 *  WHO MUST ASK THIS ONE: anything reasoning about READINGS or about what the
 *  panel should claim (reading-repair's death markers, /api/usage `logins`).
 *  WHO MUST NOT: the pool's slot validation. A pooled session's CLI reads
 *  whatever the credential SYMLINK points at, and a token stored in
 *  accounts.json cannot be delivered by re-pointing a symlink — for the SLOT,
 *  the file is the whole answer (usage-pool-engine.memberLoginState keeps
 *  calling `loginState`, deliberately).
 *
 *  @param oatMintedAt when the long-lived token was minted (accounts.json
 *         `oatMintedAt`; null/absent = no token). No decryption needed — the
 *         token's VALUE is irrelevant to this question.
 */
function accountLoginState(credsPath, { oatMintedAt = null, oatTtlMs = OAT_TTL_MS, now = Date.now(), backend = 'claude' } = {}) {
  const st = loginState(credsPath, { now, backend });
  const minted = Number(oatMintedAt) || 0;
  if (!minted) return st;
  const oatExpiresAt = minted + (Number(oatTtlMs) || OAT_TTL_MS);
  if (st.usable) return { ...st, oat: true, oatExpiresAt };
  if (oatExpiresAt > now) return { ...st, state: 'oat', usable: true, since: null, oat: true, oatExpiresAt };
  // Both channels are dead. It stopped being able to produce anything at the
  // LATER of the two instants — and an oat gives a DATE to an account whose
  // dir was never there at all ('missing' has no mtime to speak with).
  return { ...st, oat: true, oatExpiresAt, since: Math.max(Number(st.since) || 0, oatExpiresAt) || null };
}

/** "Believe nothing this identity produced after T." null = no such instant
 *  (the login is live, or we cannot prove when it died). */
function lastKnownGoodAt(state) {
  if (!state || state.state === 'live') return null;
  return Number(state.since) || null;
}

module.exports = { loginState, accountLoginState, lastKnownGoodAt, STATES, OAT_TTL_MS };
