#!/usr/bin/env node
// LOGIN-SESSION EXPIRY (2026-09-07) — a Claude subscription's OAuth login has
// its own ABSOLUTE deadline (claudeAiOauth.refreshTokenExpiresAt) that does
// NOT move when the access token refreshes. Past it the CLI's refresh gets
// invalid_grant, prints "OAuth session expired and could not be refreshed",
// and BLANKS accessToken/refreshToken/expiresAt while keeping the deadline +
// scopes. Until this work VibeSpace only reacted AFTER a dead turn (the pool's
// auth-failure eviction), so the user saw a failure, then it "worked again" on
// another member, and nobody was ever told to re-login.
//
// What this suite pins:
//   §1 the PURE reading (incl. the wiped shape and every 'unknown' path)
//   §2 the harness descriptor exposes it; other harnesses make NO claim
//   §3 pool decisions: dead ⇒ never usable (named), NEAR ⇒ never a switch
//      TARGET, 'expiring' ranks below an equal 'ok' — with negative controls
//      that an 'ok' member is still a target and an 'expiring' member still
//      serves its OWN conversation
//   §4 the warning ladder on a FAKE CLOCK: 24h / 1h / expired, once each,
//      surviving a restart through the persisted ledger, silent after a
//      re-login
//   §5 wiring pins (the 2.355.0 lesson: a pure fix with no staged call site
//      is a fix that never runs while its unit test stays green)
//   §6 §ban-safety: this feature reads files, full stop
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const R = (p) => require(path.join(REPO, p));

let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

const LE = R('src/login-expiry.js');
const { loginState, loginUsable, loginSwitchTarget, loginRank, loginBlockReason, loginBucketLabel, warnStageFor, reviewWarnings, EXPIRING_MS, NEAR_MS } = LE;
const H = 3600e3, MIN = 60e3;
const NOW = 1788000000000;

// ── §1 the pure reading ──────────────────────────────────────────────────
console.log('— §1 loginState');
const creds = (o) => ({ claudeAiOauth: o });
const LIVE = { accessToken: 'sk-ant-oat-x', refreshToken: 'sk-ant-ort-x', expiresAt: NOW + H, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_ai' };

ck('ok: a deadline comfortably ahead', loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + 16 * 24 * H }), NOW).state === 'ok');
{
  const st = loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + 17 * H }), NOW);
  ck('expiring: < 24 h left (the measured "refreshed 30 min ago, still 17 h out" shape)', st.state === 'expiring' && st.msLeft === 17 * H);
  ck('...and it reports BOTH clocks separately (login end vs access-token end)', st.refreshExpiresAt === NOW + 17 * H && st.accessExpiresAt === NOW + H);
}
ck('boundary: exactly 24 h out is still ok (< is the rule, never ≤)', loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + EXPIRING_MS }), NOW).state === 'ok');
ck('boundary: one ms inside the window is expiring', loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + EXPIRING_MS - 1 }), NOW).state === 'expiring');
ck('expired: the deadline has passed while the tokens are still on disk', loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW - 1 }), NOW).state === 'expired');
ck('boundary: exactly now is expired, not expiring (msLeft 0 ⇒ nothing left)', loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW }), NOW).state === 'expired');
{
  // THE WIPED SHAPE, verbatim from the three members in this state on the
  // measured instance: tokens blanked, deadline + scopes kept.
  const wiped = creds({ accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: NOW - 4 * H, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_ai' });
  const st = loginState(wiped, NOW);
  ck('logged-out: the CLI-wiped shape is recognised as a LOGIN state, not as garbage', st.state === 'logged-out' && st.refreshExpiresAt === NOW - 4 * H);
}
ck('unknown: an empty object (what a Console /login wipe writes) makes NO claim', loginState({}, NOW).state === 'unknown');
ck('unknown: null / a string / an array never throw and never claim', loginState(null, NOW).state === 'unknown' && loginState('x', NOW).state === 'unknown' && loginState([], NOW).state === 'unknown');
ck('unknown: tokens present but NO deadline is unknown, never ok', loginState(creds({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + H }), NOW).state === 'unknown');
ck('unknown: a non-finite deadline is unknown, never ok', loginState(creds({ ...LIVE, refreshTokenExpiresAt: 'soon' }), NOW).state === 'unknown' && loginState(creds({ ...LIVE, refreshTokenExpiresAt: NaN }), NOW).state === 'unknown');
ck('unknown: a blank oauth record with NO residue is unknown (nothing was wiped — nothing was ever there)', loginState(creds({ accessToken: '', refreshToken: '' }), NOW).state === 'unknown');
ck('the INNER object is accepted too (callers holding claudeAiOauth directly)', loginState({ ...LIVE, refreshTokenExpiresAt: NOW + 5 * 24 * H }, NOW).state === 'ok');
ck('every state carries the same four keys (no shape drift between branches)', [
  loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + 9 * 24 * H }), NOW), loginState({}, NOW),
  loginState(creds({ accessToken: '', refreshTokenExpiresAt: NOW - H, scopes: ['x'] }), NOW), loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW - H }), NOW),
].every((s) => ['state', 'refreshExpiresAt', 'accessExpiresAt', 'msLeft'].every((k) => k in s)));

console.log('— §1b predicates');
const stFor = (msLeft) => loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + msLeft }), NOW);
ck('usable: ok / expiring / near / UNKNOWN all serve; expired + logged-out do not', [
  loginUsable(stFor(9 * 24 * H)), loginUsable(stFor(3 * H)), loginUsable(stFor(5 * MIN)), loginUsable(loginState({}, NOW)),
  !loginUsable(stFor(-H)), !loginUsable(loginState(creds({ accessToken: '', refreshTokenExpiresAt: NOW - H, scopes: ['x'] }), NOW)),
].every(Boolean));
ck('switch target: ok yes, expiring-but-far yes, inside the 30-min NEAR window NO, dead NO', loginSwitchTarget(stFor(9 * 24 * H)) && loginSwitchTarget(stFor(3 * H)) && !loginSwitchTarget(stFor(NEAR_MS - MIN)) && !loginSwitchTarget(stFor(-H)));
ck('switch target: UNKNOWN is a target (no claim never blocks)', loginSwitchTarget(loginState({}, NOW)) === true);
ck('rank: ok/unknown 0 < expiring 1 < near 2 < dead 3', loginRank(stFor(9 * 24 * H)) === 0 && loginRank(loginState({}, NOW)) === 0 && loginRank(stFor(3 * H)) === 1 && loginRank(stFor(10 * MIN)) === 2 && loginRank(stFor(-H)) === 3);
ck('block reason NAMES the bucket (SPEAK rule) and is null when there is nothing to say', loginBlockReason(stFor(-H)) === 'login-expired'
  && loginBlockReason(loginState(creds({ accessToken: '', refreshTokenExpiresAt: NOW - H, scopes: ['x'] }), NOW)) === 'login-signed-out'
  && loginBlockReason(stFor(10 * MIN)) === 'login-near-expiry' && loginBlockReason(stFor(9 * 24 * H)) === null);
ck('bucket label reads like a bucket, not like a quota percentage', loginBucketLabel(stFor(-H)) === 'login expired' && loginBucketLabel(stFor(17 * H)) === 'login expires in 17 h');

// ── §2 the harness descriptor ────────────────────────────────────────────
console.log('— §2 harness descriptor');
{
  const { HARNESSES, chatHarnessIds } = R('src/harnesses/index.js');
  const claude = HARNESSES.claude;
  ck('claude.creds declares loginState (the descriptor exposes it — accounts.js never reads the file itself)', typeof claude.creds.loginState === 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-login-'));
  ck('an EMPTY dir answers unknown and never throws', claude.creds.loginState(dir, NOW).state === 'unknown');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{not json');
  ck('an UNREADABLE creds file answers unknown (never a fabricated ok)', claude.creds.loginState(dir, NOW).state === 'unknown');
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds({ ...LIVE, refreshTokenExpiresAt: NOW + 3 * H })));
  ck('a real dir reads through to the pure decision', claude.creds.loginState(dir, NOW).state === 'expiring');
  // The descriptor is also the parseAuth source — the two answers about the
  // SAME file must not contradict each other for the wiped shape.
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds({ accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: NOW - H, scopes: ['user:inference'] })));
  ck('wiped dir: parseAuth says not-logged-in AND loginState says logged-out (one file, two consistent answers)', claude.creds.parseAuth(dir).loggedIn === false && claude.creds.loginState(dir, NOW).state === 'logged-out');
  fs.rmSync(dir, { recursive: true, force: true });
  const others = chatHarnessIds().filter((id) => id !== 'claude');
  ck(`other harnesses make NO claim (${others.join(',') || 'none'}) — an absent reader is honest, a fabricated 'ok' is not`,
    others.every((id) => !HARNESSES[id].creds || typeof HARNESSES[id].creds.loginState !== 'function'));
}

// ── §3 pool decisions ────────────────────────────────────────────────────
console.log('— §3 pool decisions');
{
  const { decidePoolSwitch, rankPoolMembers, poolBlockedNotice } = R('src/account-pool-auto.js');
  const S = 1788000000; // unix SECONDS clock for the pool module
  const D = 86400;
  const healthy = { fiveHour: { utilization: 0.1, resetsAt: S + 1800 }, sevenDay: { utilization: 0.1, resetsAt: S + 5 * D }, scopedWeekly: [] };
  const spent = { fiveHour: { utilization: 0.99, resetsAt: S + 1800 }, sevenDay: { utilization: 0.99, resetsAt: S + 5 * D }, scopedWeekly: [] };
  const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const L = { ok: { state: 'ok', msLeft: 9 * 24 * H, refreshExpiresAt: NOW + 9 * 24 * H },
    expiring: { state: 'expiring', msLeft: 6 * H, refreshExpiresAt: NOW + 6 * H },
    near: { state: 'expiring', msLeft: 10 * MIN, refreshExpiresAt: NOW + 10 * MIN },
    expired: { state: 'expired', msLeft: -H, refreshExpiresAt: NOW - H },
    out: { state: 'logged-out', msLeft: -4 * H, refreshExpiresAt: NOW - 4 * H },
    unknown: { state: 'unknown', msLeft: null, refreshExpiresAt: null } };
  const dec = (caches, logins, opts = {}) => decidePoolSwitch({
    currentId: 'a', members, nowSec: S, explain: true,
    readCache: (id) => caches[id] ?? null,
    ...(logins ? { readLogin: (id) => logins[id] ?? L.unknown } : {}),
    ...opts,
  });

  // NEGATIVE CONTROL FIRST: with no login input at all, the decision is the
  // one this codebase already shipped — the new input can never change a
  // harness that cannot answer it.
  const base = dec({ a: spent, b: healthy, c: healthy }, null);
  ck('NEGATIVE CONTROL: no readLogin ⇒ byte-identical old behaviour (switch away from the spent member)', base.to === 'b' && base.reason === 'exhausted');
  ck('NEGATIVE CONTROL: all-unknown logins decide exactly like no readLogin at all',
    JSON.stringify(dec({ a: spent, b: healthy, c: healthy }, { a: L.unknown, b: L.unknown, c: L.unknown })) === JSON.stringify(base));

  // dead member ⇒ never a candidate, and the refusal is NAMED
  const d1 = dec({ a: spent, b: healthy, c: healthy }, { a: L.ok, b: L.expired, c: L.out });
  ck('dead logins are never candidates, whatever their quota says', d1.to === null);
  ck('...and the refusal is NAMED (all-logins-expired ≠ no-members: the fix is re-login, not waiting for a reset)', d1.reason === 'all-logins-expired');
  ck('...and it names WHICH members and in which state (SPEAK rule)', (d1.loginBlocked || []).map((m) => `${m.name}:${m.state}`).sort().join() === 'B:expired,C:logged-out');

  // NEAR window: usable, but never a switch TARGET
  const d2 = dec({ a: spent, b: healthy, c: healthy }, { a: L.ok, b: L.near, c: L.ok });
  ck('a member 10 min from its login deadline is never a switch TARGET (the conversation would just die again)', d2.to === 'c');
  ck('NEGATIVE CONTROL: the SAME member with a healthy login IS the target', dec({ a: spent, b: healthy, c: null }, { a: L.ok, b: L.ok, c: L.ok }).to === 'b');

  // NEGATIVE CONTROL: an 'expiring' member still serves its OWN conversation
  const d3 = dec({ a: healthy, b: healthy, c: healthy }, { a: L.expiring, b: L.ok, c: L.ok });
  ck("NEGATIVE CONTROL: an 'expiring' CURRENT member is left alone — it still serves its own conversation", d3.to === null && d3.reason === 'healthy');
  const d3p = dec({ a: healthy, b: healthy, c: healthy }, { a: L.expiring, b: L.ok, c: L.ok }, { proactive: true, hot: true });
  ck('NEGATIVE CONTROL: not even a hot/proactive pool evicts it for the login alone (deadlines are equal ⇒ no EDF gain)', d3p.to === null);

  // ranking: expiring below an EQUAL ok
  {
    // b and c: identical caches ⇒ identical deadline + identical remaining.
    // Only the login separates them.
    const r = rankPoolMembers({ members: [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }], readCache: () => healthy, nowSec: S, readLogin: (id) => (id === 'b' ? L.expiring : L.ok) });
    ck("ranking: an 'expiring' member ranks BELOW an equal 'ok' one (last tiebreak only)", r.map((x) => x.id).join() === 'c,b');
    const flipped = rankPoolMembers({ members: [{ id: 'c', name: 'C' }, { id: 'b', name: 'B' }], readCache: () => healthy, nowSec: S, readLogin: (id) => (id === 'b' ? L.expiring : L.ok) });
    ck('...independently of the input order (it is a comparator, not luck)', flipped.map((x) => x.id).join() === 'c,b');
    const noLogin = rankPoolMembers({ members: [{ id: 'b' }, { id: 'c' }], readCache: () => healthy, nowSec: S });
    ck('NEGATIVE CONTROL: with no login input the ranking keeps its stable member order', noLogin.map((x) => x.id).join() === 'b,c');
    const sealed = rankPoolMembers({ members, readCache: () => healthy, nowSec: S, readLogin: (id) => ({ a: L.ok, b: L.near, c: L.expired })[id] });
    ck('sealed orders (executed by the DEVICE hours later) carry neither dead nor near-expiry members', sealed.map((x) => x.id).join() === 'a');
  }
  // ranking must NOT reorder members the quota rules separate
  {
    const soonest = { ...healthy, sevenDay: { utilization: 0.1, resetsAt: S + 1 * D } };
    const r = rankPoolMembers({ members: [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }], readCache: (id) => (id === 'b' ? soonest : healthy), nowSec: S, readLogin: (id) => (id === 'b' ? L.expiring : L.ok) });
    ck('the login tiebreak NEVER outranks EDF: the sooner deadline still wins even while expiring', r[0].id === 'b');
  }

  // the CURRENT member's dead login forces an escape, with the login named
  const d4 = dec({ a: healthy, b: healthy, c: healthy }, { a: L.expired, b: L.ok, c: L.ok });
  ck("a CURRENT member whose login died must be left even while its quota cache reads healthy", d4.to === 'b' || d4.to === 'c');
  ck('...and the move says WHY (reason login-expired, not "exhausted")', d4.reason === 'login-expired');
  const d5 = dec({ a: null, b: healthy, c: healthy }, { a: L.out, b: L.ok, c: L.ok });
  ck('...even with NO quota data at all for it: a dead login is a fact, not ignorance (the no-data hold does not apply)', d5.to && d5.reason === 'login-expired');
  ck('NEGATIVE CONTROL: no-data + a HEALTHY login still holds (unchanged)', dec({ a: null, b: healthy, c: healthy }, { a: L.ok, b: L.ok, c: L.ok }).reason === 'no-data');
  const d6 = dec({ a: healthy, b: healthy, c: healthy }, { a: L.expired, b: L.expired, c: L.out });
  // ROUND 3: the current member's dead login is its OWN named output. It used
  // to ride in `deadBuckets`, where the notice rendered it as a spent quota
  // bucket — see §3d, which asserts the sentence itself.
  ck('current dead + every other dead ⇒ named, never a silent null', d6.to === null && d6.reason === 'all-logins-expired' && d6.fromLogin === 'login session expired');
  ck("...and the QUOTA arrays stay a quota sentence (a login is not a spent bucket)", (d6.deadBuckets || []).every((b) => !/login/i.test(b)));

  // ── ROUND 2 (adversarial verifier): the login gate may not claim a wall it
  // did not build, and it may not pin a conversation to a member that is
  // ALREADY dead. Both were reproduced against the pure function first.
  console.log('— §3b round 2: which wall, and the escape scraps');
  const spent5 = { fiveHour: { utilization: 0.999, resetsAt: S + 3600 }, sevenDay: { utilization: 0.1, resetsAt: S + 5 * D }, scopedWeekly: [] };
  const soft5 = { fiveHour: { utilization: 0.93, resetsAt: S + 1800 }, sevenDay: { utilization: 0.1, resetsAt: S + 5 * D }, scopedWeekly: [] };
  const m4 = [{ id: 'a', name: 'Cur' }, { id: 'q1', name: 'Quota1' }, { id: 'q2', name: 'Quota2' }, { id: 'x', name: 'X' }];
  const dec4 = (caches, logins, opts = {}) => decidePoolSwitch({
    currentId: 'a', members: m4, nowSec: S, explain: true,
    readCache: (id) => caches[id] ?? null,
    ...(logins ? { readLogin: (id) => logins[id] ?? L.unknown } : {}),
    ...opts,
  });

  // FINDING 2: one login-blocked member used to outrank any number of
  // quota-dead ones, so the engine asserted "every other member's login has
  // expired" and dropped the bucket sentence — sending the user to re-login
  // accounts whose logins were fine.
  {
    const mixed = dec4({ a: spent5, q1: spent5, q2: spent5, x: healthy }, { a: L.ok, q1: L.ok, q2: L.ok, x: L.expired });
    ck("QUOTA emptied the list + ONE dead login ⇒ 'no-members', not 'all-logins-expired' (the wall is quota)", mixed.to === null && mixed.reason === 'no-members');
    ck('...and the quota buckets are still named (round 1 suppressed them under the login branch)', (mixed.deadBuckets || []).includes('5h 0%') && (mixed.liveBuckets || []).includes('7d 90%'));
    ck('...while the login-blocked member is STILL carried, so the notice can say both halves', (mixed.loginBlocked || []).map((m) => `${m.name}:${m.state}`).join() === 'X:expired');
    const pure = dec4({ a: spent5, q1: healthy, q2: healthy, x: healthy }, { a: L.ok, q1: L.expired, q2: L.out, x: L.out });
    ck("NEGATIVE CONTROL: when the login gate is the ONLY thing that emptied the list it still says 'all-logins-expired'", pure.to === null && pure.reason === 'all-logins-expired' && (pure.loginBlocked || []).length === 3);
    const none4 = dec4({ a: spent5, q1: spent5, q2: spent5, x: spent5 }, { a: L.ok, q1: L.ok, q2: L.ok, x: L.ok });
    ck("NEGATIVE CONTROL: no login blocked at all ⇒ the old 'no-members' with no loginBlocked field", none4.reason === 'no-members' && none4.loginBlocked === undefined);
    // The per-member phrasing the notice uses: round 1 said "expired or is
    // about to" over a list that mixes three different facts.
    const { loginBlockedText } = LE;
    ck('each blocked member states its OWN fact (expired / signed out / expires in <t>), never one sentence over all three)',
      loginBlockedText([{ name: 'A', state: 'expired', msLeft: -H }, { name: 'B', state: 'logged-out', msLeft: null }, { name: 'C', state: 'expiring', msLeft: 20 * MIN }])
      === 'A (login expired), B (signed out), C (login expires in 20 min)');
  }

  // FINDING 3: the NEAR window is a rule about VOLUNTARY moves. Round 1 made
  // it a hard filter on the ESCAPE path too, so a hard-dead current member
  // with one quota-perfect (but 20-min-login) candidate refused to move at
  // all — strictly worse than the shipped behaviour.
  {
    const caches = { a: spent5, q1: spent5, q2: spent5, x: healthy };
    const shipped = dec4(caches, null);
    ck('SHIPPED BEHAVIOUR (no readLogin): a hard-dead current member escapes onto the only healthy candidate', shipped.to === 'x' && shipped.reason === 'exhausted');
    const scraps = dec4(caches, { a: L.ok, q1: L.ok, q2: L.ok, x: L.near });
    ck('hard-dead current + only a NEAR candidate ⇒ STILL MOVES (20 min of login beats zero)', scraps.to === 'x' && scraps.toRemaining === shipped.toRemaining);
    ck('...and says what it landed on, so the notice can demand the re-login', scraps.toLoginNear && scraps.toLoginNear.id === 'x' && scraps.toLoginNear.msLeft === 10 * MIN);
    ck('...keeping the reason that says why we LEFT (it gates the dwell-belt exemption)', scraps.reason === 'exhausted');
    const deadCur = dec4({ a: null, q1: spent5, q2: spent5, x: healthy }, { a: L.expired, q1: L.ok, q2: L.ok, x: L.near });
    ck("...and a login-expired escape onto a scrap keeps reason 'login-expired' (a new reason string would have lost its 180s exemption)", deadCur.to === 'x' && deadCur.reason === 'login-expired' && !!deadCur.toLoginNear);
    // NEGATIVE CONTROLS — the NEAR bar is intact everywhere it was designed for
    ck('NEGATIVE CONTROL: a healthy candidate always beats the NEAR one (scraps are LAST resort, never a preference)',
      dec4({ a: spent5, q1: spent5, q2: healthy, x: healthy }, { a: L.ok, q1: L.ok, q2: L.ok, x: L.near }).to === 'q2');
    const softOnly = dec4({ a: soft5, q1: spent5, q2: spent5, x: healthy }, { a: L.ok, q1: L.ok, q2: L.ok, x: L.near }, { hot: true });
    ck('NEGATIVE CONTROL: a merely SOFT-exhausted current member never takes a scrap (that move is voluntary)', softOnly.to === null);
    ck('NEGATIVE CONTROL: a proactive/EDF move never takes a scrap either',
      dec4({ a: healthy, q1: spent5, q2: spent5, x: { ...healthy, sevenDay: { utilization: 0.1, resetsAt: S + 1 * D } } }, { a: L.ok, q1: L.ok, q2: L.ok, x: L.near }, { proactive: true, hot: true }).to === null);
    ck('NEGATIVE CONTROL: sealed orders (the DEVICE executes them hours later) still carry no NEAR member',
      rankPoolMembers({ members: m4, readCache: () => healthy, nowSec: S, readLogin: (id) => (id === 'x' ? L.near : L.ok) }).every((r) => r.id !== 'x'));
    ck('NEGATIVE CONTROL: a NEAR member that is ALSO quota-dead is not a scrap (quota is a real wall of its own)',
      dec4({ a: spent5, q1: spent5, q2: spent5, x: spent5 }, { a: L.ok, q1: L.ok, q2: L.ok, x: L.near }).to === null);
    ck('NEGATIVE CONTROL: with no readLogin the scraps machinery cannot exist (no toLoginNear on any old decision)', shipped.toLoginNear === undefined);
  }

  // ── §3d ROUND 3: the SENTENCE, not just the decision object ─────────────
  // The hourly "this pool is stuck" notice was composed inline in the engine,
  // so every test ever written asserted the decision behind it and none the
  // string a user reads. In the branch where the wall is the CURRENT member's
  // dead login (never in `loginBlocked` — that list skips the current member
  // BY CONSTRUCTION) the login was smuggled through `deadBuckets`, so the
  // notice said "spent: login signed out … until a window resets, you add a
  // member, or you move them off the pool": a quota remedy for a wall that
  // does not heal on a timer, and the one account the user had to act on was
  // the only one the notice could not name. Repeats once per hour, per pool.
  console.log('— §3d round 3: the notice a stuck pool actually prints');
  {
    const say = (d, currentName = 'Cur') => poolBlockedNotice(d, { poolName: 'P', currentName });
    const m2 = [{ id: 'a', name: 'Cur' }, { id: 'q1', name: 'Quota1' }];
    const dec2 = (caches, logins, ms = m2) => decidePoolSwitch({
      currentId: 'a', members: ms, nowSec: S, explain: true,
      readCache: (id) => caches[id] ?? null,
      ...(logins ? { readLogin: (id) => logins[id] ?? L.unknown } : {}),
    });
    // (a) the verifier's first reproduction: current login expired, the other
    // member quota-dead. The current member's own quota is PERFECT.
    const a1 = dec2({ a: healthy, q1: spent5 }, { a: L.expired, q1: L.ok });
    const s1 = say(a1);
    ck('(a) current login expired + a quota-dead sibling ⇒ still a blocked notice', a1.to === null && s1.startsWith('Pool "P": '));
    ck('...it NAMES the account the user must act on', s1.includes('Cur') && /Re-login Cur in Manage Agents\./.test(s1));
    ck('...it says the LOGIN died, not that a quota bucket is spent', s1.includes("Cur's login session expired") && !/spent: login/.test(s1));
    ck('...and it never prescribes the quota remedy for a wall that no window can clear', !/until a window resets/.test(s1) && !/out of quota/.test(s1));
    ck('...nor claims a quota fact about a member sitting at 90% (the buckets are simply not the wall)', !/still available/.test(s1));
    // (b) the wiped shape with no usage cache at all
    const s2 = say(dec2({ a: null, q1: spent5 }, { a: L.out, q1: L.ok }));
    ck('(b) a SIGNED-OUT current member with no usage data says signed out + re-login', s2.includes("Cur's login is signed out") && /Re-login Cur in Manage Agents\./.test(s2) && !/window resets/.test(s2));
    // (c) the pool has no other member at all
    const s3 = say(dec2({ a: healthy }, { a: L.expired }, [{ id: 'a', name: 'Cur' }]));
    ck('(c) a one-member pool whose login died gets the same honest sentence', s3.includes("Cur's login session expired") && /Re-login Cur in Manage Agents\./.test(s3) && !/spent: login/.test(s3));
    // (d) BOTH walls on the current member: the quota fact is a side note, and
    // it is only said when it is true.
    const s4 = say(dec2({ a: spent5, q1: spent5 }, { a: L.expired, q1: L.ok }));
    ck('(d) when the current member is ALSO out of quota, the login leads and the quota rides along', /login session expired/.test(s4) && /its quota is also spent: 5h 0%/.test(s4));
    // (e) MIXED: the current login died AND another member needs a re-login —
    // `why` is about the current member here, so the others must still be
    // named or the only notice that mentions them drops them.
    const s5 = say(dec2({ a: healthy, q1: healthy }, { a: L.expired, q1: L.out }));
    ck('(e) a sibling that ALSO needs a re-login is still named when the current login is the headline', /Also needing a re-login: Quota1 \(signed out\)\./.test(s5) && /Cur's login session expired/.test(s5));

    // NEGATIVE CONTROLS — every sentence that was already right stays right.
    const quotaOnly = say(dec2({ a: spent5, q1: spent5 }, null));
    ck('NEGATIVE CONTROL: a pure QUOTA wall keeps the shipped sentence verbatim',
      quotaOnly === 'Pool "P": no member can serve it — spent: 5h 0% (still available: 7d 90%). Conversations on it will hit a limit until a window resets, you add a member, or you move them off the pool.');
    const otherLogins = say(dec2({ a: spent5, q1: healthy }, { a: L.ok, q1: L.expired }));
    ck("NEGATIVE CONTROL: 'all-logins-expired' with a HEALTHY current login is unchanged (round 2's sentence)",
      otherLogins === 'Pool "P": no member can take it — Quota1 (login expired). Re-login those accounts in Manage Agents.');
    ck('NEGATIVE CONTROL: ...and it does not drag the current member into a wall it is not part of', !/Cur/.test(otherLogins));
    const m3 = [...m2, { id: 'x', name: 'X' }];
    const mixedQuota = say(dec2({ a: spent5, q1: spent5, x: healthy }, { a: L.ok, q1: L.ok, x: L.expired }, m3));
    ck("NEGATIVE CONTROL: the round-2 MIXED wall (quota emptied the list, one login also dead) still says both halves",
      /spent: 5h 0%/.test(mixedQuota) && /Also needing a re-login: X \(login expired\)\./.test(mixedQuota) && /until a window resets/.test(mixedQuota));
    ck('NEGATIVE CONTROL: a current member with a HEALTHY login never gets the fromLogin clause',
      dec2({ a: spent5, q1: spent5 }, { a: L.ok, q1: L.ok }).fromLogin === undefined);
    ck('NEGATIVE CONTROL: with no readLogin at all the field cannot exist (old behaviour is byte-identical)',
      dec2({ a: spent5, q1: spent5 }, null).fromLogin === undefined);
    // 'stuck' keeps its "the best other member is at N%" clause — that number
    // is an argument for waiting, which is meaningless under a login wall.
    const stuck = { reason: 'stuck', to: null, fromRemaining: 0, bestRemaining: 3, deadBuckets: ['5h 0%'], liveBuckets: [] };
    ck("NEGATIVE CONTROL: a 'stuck' quota notice still quotes the best other member", / The best other member is at 3%\./.test(say(stuck)));
    ck('...and that clause is suppressed under a login wall, where waiting is not the fix', !/best other member/.test(say({ ...stuck, fromLogin: 'login session expired' })));
  }
}

// ── §3c a POOL ROW's login summary — over the members it can actually route
// to (round-2 verifier, measured against this instance's own store shape) ──
console.log('— §3c the pool row summarises the pool');
{
  const { AccountManager } = R('src/accounts.js');
  // accounts.list() reads the WALL CLOCK (no injectable now on that path), so
  // these fixtures are anchored to real time, not the suite's frozen NOW.
  const RNOW = Date.now();
  const LIVE_S = { accessToken: 'a', refreshToken: 'r', expiresAt: RNOW + H, scopes: ['user:inference'], subscriptionType: 'max' };
  const WIPED_S = { accessToken: '', refreshToken: '', expiresAt: 0, scopes: ['user:inference'], subscriptionType: 'max' };
  // subs: [id, name, refreshTokenExpiresAt, wiped?]
  const buildStore = (subs, { members = null, current }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-poolrow-'));
    fs.mkdirSync(path.join(dir, 'subs'), { recursive: true });
    const accounts = [];
    for (const [id, name, exp, wiped] of subs) {
      const d = path.join(dir, 'subs', id); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { ...(wiped ? WIPED_S : LIVE_S), refreshTokenExpiresAt: exp } }));
      accounts.push({ id, name, type: 'subscription', backend: 'claude' });
    }
    accounts.push({ id: 'pool-1', name: 'Pool', type: 'pooled', backend: 'claude', members, auto: true, hot: true });
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts }));
    fs.symlinkSync(path.join(dir, 'subs', current), path.join(dir, 'subs', 'pool-1'));
    const am = new AccountManager({ dataDir: dir, platform: 'linux' });
    return { am, dir, row: () => am.list().accounts.find((a) => a.id === 'pool-1') };
  };
  const cleanup = [];
  // THE MEASURED SHAPE: this instance's only pool is implicit (members:null)
  // with three signed-out subscriptions sitting in the store and the CURRENT
  // target 16 h from its own login deadline. Round 1 read the pool as
  // 'logged-out', named an account dead 700 h that the pool never routes to,
  // offered to re-login it, and MASKED the one warning that mattered.
  {
    const s = buildStore([
      ['sub-fish', 'Fish Max', RNOW - 15 * H, true],
      ['sub-nat', 'Natural Max', RNOW - 700 * H, true],
      ['sub-pf', 'ProblemFactory Max', RNOW + 9 * 24 * H],
      ['sub-pers', 'Personal Max', RNOW - 116 * H, true],
      ['sub-bs', 'B-Stack Max', RNOW + 16 * H],
      ['sub-pandy', 'PandyMax', RNOW + 12 * 24 * H],
    ], { members: null, current: 'sub-bs' });
    cleanup.push(s.dir);
    const ls = s.row().loginState;
    ck('IMPLICIT pool: three signed-out non-members + one expiring CURRENT target ⇒ the row reads EXPIRING', ls.state === 'expiring');
    ck('...and names the member that earned it — the one the pool actually routes to', ls.worstId === 'sub-bs' && ls.worstName === 'B-Stack Max');
    ck('...over exactly the routing candidates, no signed-out passengers', ls.members.map((m) => m.name).sort().join() === 'B-Stack Max,PandyMax,ProblemFactory Max');
    ck('...which is exactly poolMembers() (membership for an implicit pool has ONE definition)',
      ls.members.map((m) => m.id).sort().join() === s.am.poolMembers('pool-1').map((m) => m.id).sort().join());
  }
  // The current link target counts even after ITS login dies — the pool is
  // pointed at it, so it is the pool's problem however it got there.
  {
    const s = buildStore([
      ['sub-out', 'Wiped Max', RNOW - 700 * H, true],
      ['sub-ok', 'Good Max', RNOW + 9 * 24 * H],
    ], { members: null, current: 'sub-out' });
    cleanup.push(s.dir);
    const ls = s.row().loginState;
    ck("the CURRENT target's dead login is always the pool's finding, member list or not", ls.state === 'logged-out' && ls.worstId === 'sub-out');
    ck('...and it does not evict the healthy members from the summary', ls.members.some((m) => m.id === 'sub-ok'));
  }
  // NEGATIVE CONTROL: an EXPLICIT list is a different question — the user
  // NAMED those accounts, so a signed-out one IS the pool's finding.
  {
    const s = buildStore([
      ['sub-out', 'Wiped Max', RNOW - 700 * H, true],
      ['sub-ok', 'Good Max', RNOW + 9 * 24 * H],
      ['sub-other', 'Not A Member', RNOW - 700 * H, true],
    ], { members: ['sub-out', 'sub-ok'], current: 'sub-ok' });
    cleanup.push(s.dir);
    const ls = s.row().loginState;
    ck('NEGATIVE CONTROL: an EXPLICIT member list still reports its signed-out member (the user named it)', ls.state === 'logged-out' && ls.worstId === 'sub-out');
    ck('...and still only over the declared list, never every subscription in the store', !ls.members.some((m) => m.id === 'sub-other'));
  }
  // NEGATIVE CONTROL: a fully healthy implicit pool says nothing at all.
  {
    const s = buildStore([
      ['sub-a', 'A', RNOW + 9 * 24 * H],
      ['sub-b', 'B', RNOW + 12 * 24 * H],
      ['sub-dead', 'Long Gone', RNOW - 700 * H, true],
    ], { members: null, current: 'sub-a' });
    cleanup.push(s.dir);
    const ls = s.row().loginState;
    ck('NEGATIVE CONTROL: a healthy implicit pool draws NO chip, whatever else is signed out in the store', ls.state === 'ok');
    ck('...(round 1 read this exact store as logged-out — the permanent red chip on a working pool)', ls.worstName === 'A' || ls.worstName === 'B');
  }
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
}

// ── §4 the warning ladder, on a fake clock ───────────────────────────────
console.log('— §4 warning ladder (fake clock, persisted ledger)');
{
  const watch = R('src/server/login-expiry-watch.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew-'));
  let clock = NOW;
  let exp = NOW + 40 * H;          // the member's login deadline
  const filed = [];                 // every inbox item the watcher tried to file
  const accounts = {
    list: () => ({ accounts: [{ id: 'sub-1', name: 'Work Max', type: 'subscription', backend: 'claude' }] }),
    loginStateOf: (id, t) => loginState(creds({ ...LIVE, refreshTokenExpiresAt: exp }), t || clock),
  };
  const userTodos = { add: (key, item) => { filed.push({ key, ...item }); return item; } };
  const mk = () => watch.create({ accounts, userTodos, dataDir, now: () => clock, log: () => {} });

  let w = mk();
  w.sweep();
  ck('40 h out: silent (nothing to say yet)', filed.length === 0);
  clock = exp - 20 * H; w.sweep();
  ck('inside 24 h: ONE item, urgency normal', filed.length === 1 && filed[0].urgency === 'normal');
  ck('...naming the account and the expiry time (the two facts the user needs)', /Work Max/.test(filed[0].text) && /re-login/i.test(filed[0].text) && filed[0].text.includes(new Date(exp).toISOString().slice(0, 10)));
  ck('...into the accounts inbox bucket, labelled for the panel', filed[0].key === 'accounts' && filed[0].sessionName === 'Manage Agents');
  clock += 30 * MIN; w.sweep(); w.sweep();
  ck('ONCE per threshold: three more sweeps inside the same window file nothing', filed.length === 1);

  clock = exp - 40 * MIN; w.sweep();
  ck('inside 1 h: a SECOND item, urgency high', filed.length === 2 && filed[1].urgency === 'high');
  clock = exp - 5 * MIN; w.sweep();
  ck('...and only once', filed.length === 2);

  clock = exp + MIN; w.sweep();
  ck('expired: a THIRD and final item, urgency urgent', filed.length === 3 && filed[2].urgency === 'urgent' && /expired/.test(filed[2].text));
  clock += 6 * H; w.sweep(); w.sweep();
  ck('...and the dead member never speaks again', filed.length === 3);

  // RESTART SURVIVAL: a fresh watcher over the same data dir replays nothing.
  ck('the ledger is on disk (atomic store), not in memory only', fs.existsSync(path.join(dataDir, 'login-expiry.json')));
  const w2 = mk();
  w2.sweep(); w2.sweep();
  ck('RESTART: a brand-new watcher reading the persisted ledger repeats NOTHING', filed.length === 3);

  // RE-LOGIN: a fresh deadline in the future clears the ledger and goes silent.
  exp = clock + 20 * 24 * H;
  const w3 = mk();
  w3.sweep();
  ck('NEGATIVE CONTROL: a re-logged-in member emits nothing', filed.length === 3);
  ck('...and its ledger row is dropped, not kept forever', !w3.ledger()['sub-1']);
  clock = exp - 3 * H; w3.sweep();
  ck('...and the ladder RE-ARMS for the NEW deadline (silence is per-login, not per-account)', filed.length === 4 && /Work Max/.test(filed[3].text));

  // SKIPPED RUNG: a server that was off across the 24 h mark must not file a
  // stale "expires in 24 h" — the most urgent rung fires, the rest are done.
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew2-'));
  const filed2 = [];
  exp = NOW + 40 * H; clock = NOW;
  const w4 = watch.create({ accounts, userTodos: { add: (k, i) => filed2.push(i) }, dataDir: dataDir2, now: () => clock, log: () => {} });
  w4.sweep();
  clock = exp - 20 * MIN; w4.sweep();
  ck('a skipped rung does not fire late: only the 1 h rung speaks, once', filed2.length === 1 && filed2[0].urgency === 'high');
  clock = exp - 10 * MIN; w4.sweep();
  ck('...and the skipped 24 h rung is marked done, never fired retroactively', filed2.length === 1);

  // The inbox refusing an item must NOT be recorded as sent (no silent loss).
  const dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew3-'));
  let refuse = true; const filed3 = [];
  exp = NOW + 20 * H; clock = NOW;
  const w5 = watch.create({ accounts, dataDir: dataDir3, now: () => clock, log: () => {},
    userTodos: { add: (k, i) => { if (refuse) throw new Error('this session already has 20 open items'); filed3.push(i); } } });
  w5.sweep();
  ck('a REFUSED inbox write is not silently marked sent', filed3.length === 0 && !w5.ledger()['sub-1']);
  refuse = false; w5.sweep();
  ck('...so the next sweep files it', filed3.length === 1);

  // pure transition, directly
  ck('reviewWarnings: a member with no deadline at all never warns', reviewWarnings(loginState({}, NOW), null, NOW).emit === null);
  ck('reviewWarnings: an unchanged ledger for the SAME deadline stays silent', reviewWarnings(stFor(20 * H), { exp: NOW + 20 * H, sent: ['24h'] }, NOW).emit === null);
  ck('reviewWarnings: the same ledger under a DIFFERENT deadline is a re-login ⇒ it starts fresh', reviewWarnings(stFor(20 * H), { exp: NOW + 999 * H, sent: ['24h', '1h', 'expired'] }, NOW).emit === '24h');
  ck('warnStageFor: ok ⇒ null, <24h ⇒ 24h, <1h ⇒ 1h, dead ⇒ expired', warnStageFor(stFor(9 * 24 * H)) === null && warnStageFor(stFor(20 * H)) === '24h' && warnStageFor(stFor(30 * MIN)) === '1h' && warnStageFor(stFor(-H)) === 'expired');

  // ── ROUND 2 (adversarial verifier): PRE-EXISTING DEATHS. The terminal rung
  // had no staleness gate, so the first sweep after the upgrade filed an
  // `urgent` item for every login that had ever died. Reproduced on the
  // instance this feature was measured on: three of them, dead 15 h, 116 h and
  // 700 h, none of them a routing member — the "For you" badge would open red
  // and blinking about accounts abandoned weeks ago.
  console.log('— §4b round 2: a login that died before we were watching');
  {
    const wiped = (exp) => creds({ accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: exp, scopes: ['user:inference'] });
    const deaths = { 'sub-fresh': NOW - 15 * H, 'sub-old': NOW - 116 * H, 'sub-ancient': NOW - 700 * H };
    const rows = Object.keys(deaths).map((id) => ({ id, name: id, type: 'subscription', backend: 'claude' }));
    const acct = { list: () => ({ accounts: rows }), loginStateOf: (id, t) => loginState(wiped(deaths[id]), t) };
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew4-'));
    const filed4 = [];
    const w6 = watch.create({ accounts: acct, userTodos: { add: (k, i) => filed4.push({ k, ...i }) }, dataDir: dir4, now: () => NOW, log: () => {} });
    w6.sweep();
    ck('FIRST SWEEP of a fresh ledger: only the RECENT death speaks (round 1 filed all three as urgent)', filed4.length === 1 && /sub-fresh/.test(filed4[0].text));
    ck('...and it is still urgent — the gate is about age, not about caring less', filed4[0].urgency === 'urgent');
    ck('...the pre-existing ones are RECORDED as done, so they never surface later either', ['sub-old', 'sub-ancient'].every((id) => (w6.ledger()[id]?.sent || []).includes('expired')));
    w6.sweep(); w6.sweep();
    ck('...and further sweeps stay silent', filed4.length === 1);
    ck("the ledger's birth is persisted, so the grace is spent exactly ONCE per install", Number.isFinite(JSON.parse(fs.readFileSync(path.join(dir4, 'login-expiry.json'), 'utf-8')).since));

    // NEGATIVE CONTROL 1: a login that dies AFTER we started watching is one
    // WE missed (server was off) — reporting that is the whole promise.
    const later = { 'sub-later': NOW + 40 * H };
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew5-'));
    const filed5 = [];
    let clock5 = NOW;
    const w7 = watch.create({
      accounts: { list: () => ({ accounts: [{ id: 'sub-later', name: 'Later', type: 'subscription', backend: 'claude' }] }), loginStateOf: (id, t) => loginState(wiped(later[id]), t) },
      userTodos: { add: (k, i) => filed5.push(i) }, dataDir: dir5, now: () => clock5, log: () => {},
    });
    w7.sweep();                                  // ledger born here, deadline 40 h out
    clock5 = later['sub-later'] + 200 * H;       // server was off for the whole ladder AND 200 h past the death
    w7.sweep();
    ck('NEGATIVE CONTROL: a death AFTER the ledger was born still speaks, however long the server was off', filed5.length === 1 && filed5[0].urgency === 'urgent');

    // NEGATIVE CONTROL 2: a death just before a fresh install is still news.
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew6-'));
    const filed6 = [];
    const w8 = watch.create({
      accounts: { list: () => ({ accounts: [{ id: 'sub-just', name: 'Just', type: 'subscription', backend: 'claude' }] }), loginStateOf: (id, t) => loginState(wiped(NOW - 20 * MIN), t) },
      userTodos: { add: (k, i) => filed6.push(i) }, dataDir: dir6, now: () => NOW, log: () => {},
    });
    w8.sweep();
    ck('NEGATIVE CONTROL: a login that died 20 min before the very first sweep IS filed (the grace is a day, not "anything past")', filed6.length === 1);

    // The pure transition, directly — including the control that the gate is
    // OPT-IN: without watchingSince the old behaviour is byte-identical.
    const ancient = loginState(wiped(NOW - 700 * H), NOW);
    ck('reviewWarnings: NO watchingSince ⇒ the ancient death still emits (the gate is an added input, never a silent default)', reviewWarnings(ancient, null, NOW).emit === 'expired');
    ck('reviewWarnings: with watchingSince it is suppressed and marked done, with a NAMED reason', (() => {
      const r = reviewWarnings(ancient, null, NOW, { watchingSince: NOW });
      return r.emit === null && r.suppressed === 'pre-existing' && r.entry.sent.length === LE.WARN_STAGES.length;
    })());
    ck('reviewWarnings: BOTH clauses are load-bearing — inside the grace, or after we started watching, it still emits', [
      reviewWarnings(loginState(wiped(NOW - 20 * MIN), NOW), null, NOW, { watchingSince: NOW }).emit === 'expired',
      reviewWarnings(ancient, null, NOW, { watchingSince: NOW - 900 * H }).emit === 'expired',
    ].every(Boolean));
    ck('reviewWarnings: a logged-out record with NO readable deadline cannot be dated ⇒ never suppressed (firing is the fail-safe direction)',
      reviewWarnings(loginState(creds({ accessToken: '', refreshToken: '', scopes: ['user:inference'] }), NOW), null, NOW, { watchingSince: NOW }).emit === 'expired');
    ck('reviewWarnings: the FUTURE rungs are untouched by the gate (a 24 h warning is always news)',
      reviewWarnings(stFor(20 * H), null, NOW, { watchingSince: NOW }).emit === '24h');

    for (const d of [dir4, dir5, dir6]) fs.rmSync(d, { recursive: true, force: true });
  }

  // ── ROUND 3 (adversarial verifier): the item text branched on the RUNG, and
  // `warnStageFor` maps BOTH 'expired' and 'logged-out' onto the terminal
  // 'expired' rung. A wiped file is produced by ANY unrecoverable refresh (a
  // revoked or rotated session, an explicit logout in an isolated dir), not
  // only by the deadline passing, and the CLI KEEPS refreshTokenExpiresAt when
  // it blanks the tokens — so the deadline can still be in the FUTURE. The
  // inbox then said the login "expired" at a date weeks out, at urgency
  // `urgent`, while the chip on the same row said "signed out". Two surfaces,
  // one record, opposite claims. (Every wiped dir on the instance this was
  // built on happens to have a PAST deadline, which is why §4/§4b never hit
  // it — the fixtures inherited the local sample, not the shape.)
  console.log('— §4c round 3: a wiped credential file whose deadline has not passed yet');
  {
    const wiped = (exp) => creds({ accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: exp, scopes: ['user:inference'] });
    const future = loginState(wiped(NOW + 20 * 24 * H), NOW);
    ck('the reading itself is honest: signed out, with a POSITIVE msLeft', future.state === 'logged-out' && future.msLeft === 20 * 24 * H);
    ck('...and it is still the terminal RUNG (the tokens are gone: every turn fails right now)', warnStageFor(future) === 'expired');
    const txt = watch.itemTextFor('expired', 'Fish Max', future);
    ck('the inbox item never says "expired" about a timestamp in the future', !/expired/.test(txt));
    ck('...it says what actually happened — the CLI cleared the tokens — and asks for the re-login', /is signed out/.test(txt) && /the CLI cleared its tokens/.test(txt) && /re-login it in Manage Agents/.test(txt));
    ck('...and it does not quote a "session ended" date that has not happened', !/session ended/.test(txt));
    ck('the two surfaces now agree: the chip for the SAME record also says signed out', (() => {
      const ma = fs.readFileSync(path.join(REPO, 'src/lib/manage-agents.js'), 'utf8');
      return /ls\.state === 'logged-out' \? t\('login signed out — re-login'\)/.test(ma) && /is signed out/.test(txt);
    })());
    // NEGATIVE CONTROLS — the two shapes that were already right.
    const past = loginState(wiped(NOW - 30 * H), NOW);
    const txtPast = watch.itemTextFor('expired', 'Old Max', past);
    ck('...and the date is NOT dropped for the common shape (deadline already passed): it moves into the clause', /is signed out/.test(txtPast) && /its login session ended 2026-/.test(txtPast));
    const expired = loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW - H }), NOW);
    ck('NEGATIVE CONTROL: a plainly EXPIRED login (tokens still on disk) keeps the shipped "expired <when>" wording',
      expired.state === 'expired' && /^Claude login for "X" expired 2026-.* — re-login it in Manage Agents$/.test(watch.itemTextFor('expired', 'X', expired)));
    ck('NEGATIVE CONTROL: the FUTURE rungs are untouched (they were never about the wiped shape)',
      /^Claude login for "X" expires in 20 h \(2026-.*\) — re-login it in Manage Agents$/.test(watch.itemTextFor('24h', 'X', loginState(creds({ ...LIVE, refreshTokenExpiresAt: NOW + 20 * H }), NOW))));
    // The sweep files it as one urgent item, once — nothing about the wording
    // change may weaken the ledger.
    const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew7-'));
    const filed7 = [];
    const w9 = watch.create({
      accounts: { list: () => ({ accounts: [{ id: 'sub-wiped', name: 'Fish Max', type: 'subscription', backend: 'claude' }] }), loginStateOf: (id, t) => loginState(wiped(NOW + 20 * 24 * H), t) },
      userTodos: { add: (k, i) => filed7.push(i) }, dataDir: dir7, now: () => NOW, log: () => {},
    });
    w9.sweep(); w9.sweep();
    ck('the sweep files exactly one URGENT item for it and the ledger stops there', filed7.length === 1 && filed7[0].urgency === 'urgent');
    ck('...the future deadline lives in the DETAIL, in the future tense, beside the state', /Login session ends: 2026-/.test(filed7[0].detail) && /State: logged-out/.test(filed7[0].detail));
    ck('...and a PAST deadline reads "ended" there (the same tense rule as the text)', (() => {
      const dir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lew8-'));
      const f8 = [];
      watch.create({
        accounts: { list: () => ({ accounts: [{ id: 'sub-p', name: 'P', type: 'subscription', backend: 'claude' }] }), loginStateOf: (id, t) => loginState(wiped(NOW - 20 * MIN), t) },
        userTodos: { add: (k, i) => f8.push(i) }, dataDir: dir8, now: () => NOW, log: () => {},
      }).sweep();
      fs.rmSync(dir8, { recursive: true, force: true });
      return f8.length === 1 && /Login session ended: 2026-/.test(f8[0].detail);
    })());
    fs.rmSync(dir7, { recursive: true, force: true });
  }

  for (const d of [dataDir, dataDir2, dataDir3]) fs.rmSync(d, { recursive: true, force: true });
}

// ── §5 wiring pins (2.355.0: an unstaged call site keeps unit tests green) ──
console.log('— §5 wiring');
{
  const acc = fs.readFileSync(path.join(REPO, 'src/accounts.js'), 'utf8');
  ck('accounts.js exposes loginStateOf through the DESCRIPTOR (never a backend-id branch)', /creds\.loginState|_credsOf\(be\)\?\.loginState/.test(acc) && !/backend === 'claude' \? loginState/.test(acc));
  ck('every subscription row in list() carries loginState', /loginState: this\.loginStateOf\(a\.id\)/.test(acc));
  ck("a pool's row carries its MEMBERS' worst", /loginState: this\.poolLoginState\(a\.id\)/.test(acc));
  // ROUND 2: membership is TWO questions. An explicit list is what the user
  // NAMED (a signed-out member of it IS the finding); an implicit pool's
  // membership is DEFINED as poolMembers(), so an account that is signed out
  // was never a member at all. Round 1 used one over-broad set for both and
  // put a permanent red chip on a healthy pool. §3c is the functional half.
  ck("the pool's login summary asks the EXPLICIT-list question and the IMPLICIT one separately", /_poolLoginCandidates\(poolId\)/.test(acc)
    && /const explicit = Array\.isArray\(a\?\.members\)/.test(acc)
    && /for \(const m of this\.poolMembers\(poolId\)\)/.test(acc));
  ck('...and the CURRENT link target is always in the set, whichever question was asked', /const cur = this\.poolCurrent\(poolId\);[\s\S]{0,240}out\.set\(cur,/.test(acc));

  const eng = fs.readFileSync(path.join(REPO, 'src/server/usage-pool-engine.js'), 'utf8');
  const decides = eng.match(/decidePoolSwitch\(\{[^}]*\}\)/g) || [];
  ck(`every decidePoolSwitch call in the engine passes readLogin (${decides.length} call sites)`, decides.length >= 3 && decides.every((c) => /readLogin/.test(c)));
  const ranks = eng.match(/rankPoolMembers\(\{[\s\S]*?\n?\s*\}\)/g) || [];
  ck(`every rankPoolMembers call in the engine passes readLogin (${ranks.length} call sites)`, ranks.length >= 2 && ranks.every((c) => /readLogin/.test(c)));
  ck('quotaVerdictFor cannot answer "usable" through a dead login', /loginUsable\(li\)/.test(eng) && /re-login needed/.test(eng));
  ck('the auth-failure notice branches on the login STATE (loginWallPhrase) and quotes the deadline only once it has passed (keeping the old wording otherwise)', /\$\{loginWallPhrase\(li\)\}/.test(eng) && /li\.msLeft <= 0 && li\.refreshExpiresAt\)/.test(eng) && /is failing authentication/.test(eng));
  ck('NEGATIVE CONTROL: the rung-branched sentence that narrated a future deadline as a past expiry is gone from the engine', !/login session expired \(refresh token expired at/.test(eng));
  ck('the switch notice names the current member\'s login STATE too (a signed-out login is not "expired")', /\$\{nameOf\(currentId\)\}'s \$\{\(\(\) => \{ try \{ const l = accounts\.loginStateOf\(currentId\); return l \? loginWallPhrase\(l\)/.test(eng));
  ck('the "nowhere to go" notice reaches the pool-blocked branch for the login wall too', /d\.reason === 'all-logins-expired'\) \{/.test(eng));
  // ROUND 3: the sentence itself moved into the PURE module so §3d can assert
  // the STRING (it was composed inline here, so no test ever read it — and it
  // rendered the current member's dead login as a spent quota bucket). The
  // engine must CALL it and must not have grown a second copy.
  ck('the engine composes the blocked notice through the PURE poolBlockedNotice', /poolBlockedNotice\(d, \{ poolName: a\.name, currentName: nameOf\(currentId\) \}\)/.test(eng)
    && /poolBlockedNotice,? .*= require\('\.\.\/account-pool-auto\.js'\)/.test(eng));
  // INTEGRATION r2: the twin check reads EXECUTABLE lines only. A comment must
  // stay free to quote the retired sentence — this repo's rule is "the comments
  // keep the refutation on record", and the merge's own fix note explains that
  // pre-filtering the candidates degraded the notice back to "wait until a
  // window resets". Matching that quote as if it were a second copy would make
  // the pin punish the record of why it exists.
  const engCode = eng.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ck('...and no longer carries an inline twin of it (executable lines: a comment may quote the retired sentence)', !/spent: \$\{dead\}/.test(engCode) && !/Also needing a re-login/.test(engCode) && !/until a window resets/.test(engCode));
  ck('NEGATIVE CONTROL: the same predicate still fires on a real inline twin (an executable line composing the retired sentence)',
    (() => { const twin = engCode + "\n    serverNotice(k, `Pool: no member can serve it — spent: ${dead}. Conversations on it will hit a limit until a window resets.`);"; return /spent: \$\{dead\}/.test(twin) && /until a window resets/.test(twin); })());
  ck('NEGATIVE CONTROL: …and the stripper drops the phrase only on a COMMENT line, never on an executable one (so the pin narrows by line KIND, not by losing the phrase)',
    (() => {
      const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      return !/until a window resets/.test(strip('  // back into "wait until a window resets": the wall the user'))
        && /until a window resets/.test(strip('    serverNotice(k, `… until a window resets.`);'));
    })());
  ck('...while a switch onto a NEAR-expiry scrap tells the user the reprieve is short', /d\.toLoginNear/.test(eng) && /re-login it in Manage Agents now/.test(eng));
  ck('...on BOTH switch surfaces — the per-session re-point (plan C) fires far more often than the pool-level one', /ds\.toLoginNear/.test(eng) && (eng.match(/re-login it in Manage Agents now/g) || []).length === 2);
  const apa = fs.readFileSync(path.join(REPO, 'src/account-pool-auto.js'), 'utf8');
  ck("the pure decision only claims 'all-logins-expired' when the login gate was the ONLY wall", /loginBlocked\.length && !quotaBlockedN\) \? 'all-logins-expired'/.test(apa) && /quotaBlockedN\+\+/.test(apa));
  // ROUND 2 phrasing + ROUND 3 placement, now both in the pure module.
  ck('each blocked member states its OWN state in the notice (never one "expired or is about to" over the whole list)', /loginBlockedText\(d\?\.loginBlocked\)/.test(apa) && !/login session has expired or is about to/.test(apa));
  ck('a MIXED wall (quota emptied the list AND someone needs a re-login) says both halves', /Also needing a re-login: \$\{loginNames\}/.test(apa) && /const also = !namedInWhy && loginNames/.test(apa));
  // ROUND 3: the current member's dead login is a named FIELD, and the quota
  // arrays never carry a login label again.
  ck("the current member's dead login is its own output, never an entry in deadBuckets", /fromLogin: loginWallPhrase\(login\(currentId\)\)/.test(apa)
    && !/deadBuckets: \[\s*\.\.\.\(readLogin/.test(apa));
  ck('...and the notice gives it the re-login remedy instead of the quota one', /Re-login \$\{currentName\} in Manage Agents\./.test(apa) && /const curLoginWall = !!d\?\.fromLogin/.test(apa));
  ck('...and a hard-dead current member may fall back to the NEAR list (the escape is not a voluntary move)', /const usingScraps = !ranked\.length && hardDead && nearRanked\.length > 0/.test(apa));

  ck('a login-expired escape is exempt from the 180s dwell belt (dead login = hard death, and its fromRemaining is null)',
    (eng.match(/ds\.reason !== 'login-expired' && !\(ds\.fromRemaining/g) || []).length === 1 && (eng.match(/d\.reason !== 'login-expired' && !\(d\.fromRemaining/g) || []).length === 1);
  const srv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  ck('server.js STARTS the watcher (a module nobody starts is a feature nobody has)', /login-expiry-watch\.js'\)\.create\(\{[\s\S]*?\}\)\.start\(\)/.test(srv));

  const ma = fs.readFileSync(path.join(REPO, 'src/lib/manage-agents.js'), 'utf8');
  ck('the roster row renders the chip', /loginExpiryChipHtml\(a, \{ local: !selectedHost \}\)/.test(ma) && /\$\{oatTag\}\$\{loginTag\}/.test(ma));
  ck('the chip ACTION is the existing re-login flow (no second login path)', /acct-login-chip'\)/.test(ma) && /this\._reloginSubscription\(target, targetAcct, refresh\)/.test(ma));
  ck('the chip is an SVG icon, never emoji, and never a literal colour', /ROSTER_ICONS\.CLOCK/.test(ma) && /var\(--red/.test(ma) && !/[\u{1F300}-\u{1FAFF}]/u.test(ma.slice(ma.indexOf('loginExpiryChipHtml'), ma.indexOf('loginExpiryChipHtml') + 3000)));
  const css = fs.readFileSync(path.join(REPO, 'public/style.css'), 'utf8');
  ck('the chip SVG is explicitly sized (an unsized inline SVG swallows the row — 2.369.13)', /\.acct-login-chip svg \{[^}]*width: 10px[^}]*height: 10px/.test(css));
  const panel = fs.readFileSync(path.join(REPO, 'src/lib/user-todos-panel.js'), 'utf8');
  ck("the inbox item's click lands on Manage Agents instead of a dead end", /key === 'accounts'/.test(panel) && /_showAgentsDialog/.test(panel));
  // ROUND 3: the item text asks the STATE what happened, not the rung how
  // urgent it is — warnStageFor collapses 'logged-out' onto 'expired'.
  const lew = fs.readFileSync(path.join(REPO, 'src/server/login-expiry-watch.js'), 'utf8');
  ck("the inbox item branches on the login STATE, so a wiped file is never reported as 'expired'", /if \(info\?\.state === 'logged-out'\)/.test(lew)
    && lew.indexOf("info?.state === 'logged-out'") < lew.indexOf("if (stage === 'expired'"));

  // i18n: every user-visible string in the chip has zh + ja
  const zh = fs.readFileSync(path.join(REPO, 'src/lib/i18n-zh.js'), 'utf8');
  const ja = fs.readFileSync(path.join(REPO, 'src/lib/i18n-ja.js'), 'utf8');
  const keys = ['login expires in {left}', 'login expired {when} — re-login', 'login signed out — re-login', '{n} min', '{n} h', '{n} d'];
  ck('every new chip string has a zh entry', keys.every((k) => zh.includes(JSON.stringify(k))));
  ck('every new chip string has a ja entry', keys.every((k) => ja.includes(JSON.stringify(k))));
}

// ── §6 §ban-safety ───────────────────────────────────────────────────────
console.log('— §6 ban-safety');
{
  const pure = fs.readFileSync(path.join(REPO, 'src/login-expiry.js'), 'utf8');
  ck('the pure module imports NOTHING (it is safe in the daemon and the browser)', !/require\(|^import /m.test(pure));
  const w = fs.readFileSync(path.join(REPO, 'src/server/login-expiry-watch.js'), 'utf8');
  // CODE only: the prose in this file legitimately explains refreshTokenExpiresAt,
  // and a census that reads comments would either be permanently red or force the
  // explanation out of the file that needs it.
  const wCode = w.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  ck('the watcher constructs no request of any kind (files only)', !/fetch\(|https?\.request|axios|got\(/.test(wCode));
  ck('...and never touches token MATERIAL: it reads verdicts through the account store', !/accessToken|refreshToken|credentials\.json/.test(wCode));
}

// ── §7 the chip, measured in a real browser at 375×667 ───────────────────
// The chip is built by the REAL exported helper (esbuild → a classic script)
// and dropped into a real .acct-key-row under the REAL stylesheet, because
// "it looks fine" from reading HTML is exactly the claim this project has been
// wrong about twice (an unsized inline SVG that ate a whole mobile row; a
// measurement that counted offsetHeight instead of looking).
console.log('— §7 the chip at 375x667 (headless chrome)');
{
  const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!CHROME) {
    // SKIP WITH A REASON, never a silent green.
    console.log('  SKIP: no chrome binary on this machine (looked in /usr/bin/google-chrome{,-stable}, /usr/bin/chromium{,-browser})');
  } else {
    const { spawn } = await import('node:child_process');
    const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lchip-'));
    const stubBuildVersion = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
    await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/manage-agents.js')], bundle: true, format: 'iife', globalName: 'MA', platform: 'browser', target: 'es2022', outfile: path.join(dir, 'ma.js'), logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stubBuildVersion] });
    fs.copyFileSync(path.join(REPO, 'public/style.css'), path.join(dir, 'style.css'));
    const row = (name, ident, chipVar) => '<div class="acct-key-row"><span class="acct-type-icon"></span>'
      + '<span class="acct-key-main"><span class="acct-key-name">' + name + '</span><span class="acct-key-tail">' + ident + '</span>'
      + '<span class="acct-key-extra">\' + ' + chipVar + ' + \'</span></span>'
      + '<span class="acct-key-actions"><button class="acct-icon"></button><button class="acct-icon"></button></span></div>';
    const html = '<!doctype html><html data-theme="dark"><head><meta charset="utf-8">'
      // WITHOUT this meta, a mobile emulation lays the page out at Chrome's
      // 980px legacy fallback and every "375px" number below would be a lie —
      // index.html carries the same tag, so this fixture matches the product.
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<link rel="stylesheet" href="./style.css"></head>\n'
      + '<body><div id="mount" class="acct-list" style="width:100%"></div><script src="./ma.js"></script><script>\n'
      + 'const H = 3600e3, NOW = Date.now();\n'
      + "const A = (id, name, ls) => ({ id, name, type: 'subscription', loginState: ls });\n"
      + 'window.chips = {\n'
      + "  ok: MA.loginExpiryChipHtml(A('s1', 'Work Max', { state: 'ok', msLeft: 9 * 24 * H, refreshExpiresAt: NOW + 9 * 24 * H })),\n"
      + "  unknown: MA.loginExpiryChipHtml(A('s2', 'No claim', { state: 'unknown', msLeft: null, refreshExpiresAt: null })),\n"
      + "  none: MA.loginExpiryChipHtml({ id: 's2b', name: 'No field', type: 'subscription' }),\n"
      + "  expiring: MA.loginExpiryChipHtml(A('s3', 'Personal Max', { state: 'expiring', msLeft: 17 * H, refreshExpiresAt: NOW + 17 * H })),\n"
      + "  expired: MA.loginExpiryChipHtml(A('s4', 'Old Max', { state: 'expired', msLeft: -4 * H, refreshExpiresAt: NOW - 4 * H })),\n"
      + "  out: MA.loginExpiryChipHtml(A('s5', 'Wiped', { state: 'logged-out', msLeft: -9 * H, refreshExpiresAt: NOW - 9 * H })),\n"
      + "  pool: MA.loginExpiryChipHtml({ id: 'pool-1', name: 'Pool', type: 'pooled', pooled: true, loginState: { state: 'expiring', msLeft: 40 * 60e3, refreshExpiresAt: NOW + 40 * 60e3, worstId: 's3', worstName: 'Personal Max' } }),\n"
      + "  host: MA.loginExpiryChipHtml(A('s3', 'Personal Max', { state: 'expiring', msLeft: 17 * H, refreshExpiresAt: NOW + 17 * H }), { local: false }),\n"
      + "  hostDead: MA.loginExpiryChipHtml(A('s4', 'Old Max', { state: 'expired', msLeft: -4 * H, refreshExpiresAt: NOW - 4 * H }), { local: false }),\n"
      + "  xss: MA.loginExpiryChipHtml({ id: '\"><img src=x onerror=alert(1)>', name: 'x', type: 'subscription', loginState: { state: 'expiring', msLeft: 2 * H, refreshExpiresAt: NOW + 2 * H, worstName: '<b>evil</b>' } }),\n"
      + '};\n'
      + "document.getElementById('mount').innerHTML =\n"
      + "  '" + row('Personal Max', 'you@example.com &middot; max', 'window.chips.expiring') + "' +\n"
      + "  '" + row('Old Max', 'old@example.com &middot; max', 'window.chips.expired') + "' +\n"
      + "  '" + row('Pool', '&rarr; Personal Max', 'window.chips.pool') + "';\n"
      + '<' + '/script></body></html>'; // split so THIS file's own parser never sees a close tag; the fixture gets the real one
    fs.writeFileSync(path.join(dir, 'fixture.html'), html);
    const CDP_PORT = 9351;
    const profile = path.join(dir, 'chrome');
    const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--no-first-run', '--disable-gpu', '--window-size=375,667', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const WS = require(path.join(REPO, 'node_modules/ws'));
      // EVERY browser interaction is time-boxed. A gate suite that can hang
      // forever on a loaded machine is worse than one that fails: this leg
      // shares the box with dozens of other headless chromes here, and the
      // first version of it sat at 198s with nothing printed.
      const race = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(what + ' timed out after ' + ms + 'ms')), ms); if (t.unref) t.unref(); })]);
      let target = null;
      for (let i = 0; i < 60 && !target; i++) { try { const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json(); target = l.find((t) => t.type === 'page'); } catch { await sleep(200); } }
      if (!target) throw new Error('chrome never came up on the devtools port');
      const sock = new WS(target.webSocketDebuggerUrl);
      await race(new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); }), 15000, 'devtools socket');
      let seq = 0; const pend = new Map(); const jsErrors = [];
      sock.on('message', (d) => { const m = JSON.parse(d);
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
        if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params?.exceptionDetails?.exception?.description || 'exception'); });
      const cdp = (method, params = {}) => race(new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); sock.send(JSON.stringify({ id, method, params })); }), 30000, 'CDP ' + method);
      const evalJs = async (e) => { const rr = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (rr.exceptionDetails) throw new Error(rr.exceptionDetails.exception?.description || 'threw'); return rr.result.value; };
      await cdp('Page.enable'); await cdp('Runtime.enable');
      await cdp('Page.navigate', { url: 'file://' + path.join(dir, 'fixture.html') });
      await sleep(1200);
      // AFTER the navigation: an override set on about:blank does not survive
      // it, and a measurement taken at the window's real width would be a
      // "375x667" assert that never saw 375 px (the vw assert below is what
      // makes that impossible to ship again).
      await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
      await sleep(400);
      const chips = await evalJs('window.chips');
      if (!chips) throw new Error('the fixture never produced window.chips (esbuild bundle failed to run?)');
      ck('BROWSER: an ok / unknown / absent login draws NO chip (only a real deadline speaks)', chips.ok === '' && chips.unknown === '' && chips.none === '');
      ck('BROWSER: expiring / expired / logged-out each draw one', /login expires in 17 h/.test(chips.expiring) && /login expired/.test(chips.expired) && /login signed out/.test(chips.out));
      ck('BROWSER: a host section shows only the DEAD state (an expiry warning about this machine there would be noise)', chips.host === '' && chips.hostDead !== '');
      ck("BROWSER: a pool's chip names the member that earned it and re-logs THAT member in", /Personal Max/.test(chips.pool) && /data-relogin="s3"/.test(chips.pool));
      ck('BROWSER: XSS - the account id and the member name are escaped in the attribute and the text', !/<img src=x/.test(chips.xss) && /data-relogin="&quot;&gt;&lt;img/.test(chips.xss) && /&lt;b&gt;evil/.test(chips.xss));
      const m = await evalJs(`(() => {
        const rows = [...document.querySelectorAll('.acct-key-row')];
        const chip = rows[0].querySelector('.acct-login-chip');
        if (!chip) return { err: 'no chip in the first row' };
        const svg = chip.querySelector('svg');
        const cr = chip.getBoundingClientRect(), sr = svg.getBoundingClientRect();
        const extra = rows[0].querySelector('.acct-key-extra').getBoundingClientRect();
        return { vw: innerWidth, chip: { w: cr.width, h: cr.height, right: cr.right, top: cr.top },
          svg: { w: sr.width, h: sr.height }, extraH: extra.height,
          rowsH: rows.map((r) => r.getBoundingClientRect().height),
          cursor: getComputedStyle(chip).cursor,
          colorDead: getComputedStyle(rows[1].querySelector('.acct-login-chip')).color,
          colorWarn: getComputedStyle(chip).color,
          hit: document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2)?.closest('.acct-login-chip') != null };
      })()`);
      if (m.err) throw new Error(m.err);
      ck('BROWSER: viewport is really 375 CSS px (' + m.vw + ')', m.vw === 375);
      ck('BROWSER: the SVG is 10x10, not viewBox-sized (' + Math.round(m.svg.w) + 'x' + Math.round(m.svg.h) + ') - the row-eating shape', Math.round(m.svg.w) === 10 && Math.round(m.svg.h) === 10);
      ck('BROWSER: the chip stays inside the viewport at 375px (right edge ' + Math.round(m.chip.right) + ')', m.chip.right <= 375);
      ck('BROWSER: it is one line, not a stack (chip ' + Math.round(m.chip.h) + 'px inside a ' + Math.round(m.extraH) + 'px extras line)', m.chip.h <= 20 && m.extraH <= 22);
      ck('BROWSER: rows stay row-sized with the chip present (' + m.rowsH.map((h) => Math.round(h)).join('/') + 'px)', m.rowsH.every((h) => h > 20 && h < 90));
      ck('BROWSER: it reads as clickable and the centre of it actually hits the chip', m.cursor === 'pointer' && m.hit === true);
      ck('BROWSER: theme colours only - dead is the red var, expiring the warn var, and they differ (' + m.colorDead + ' vs ' + m.colorWarn + ')', /^rgb/.test(m.colorDead) && /^rgb/.test(m.colorWarn) && m.colorDead !== m.colorWarn);
      ck('BROWSER: no JS error while rendering', jsErrors.length === 0);
      try { sock.close(); } catch { }
    } catch (e) {
      fail++; console.error('  x BROWSER: the 375x667 measurement could not run - ' + e.message);
    } finally {
      try { chrome.kill('SIGKILL'); } catch { }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
