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
  const { decidePoolSwitch, rankPoolMembers } = R('src/account-pool-auto.js');
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
  ck('current dead + every other dead ⇒ named, never a silent null', d6.to === null && d6.reason === 'all-logins-expired' && (d6.deadBuckets || []).includes('login expired'));
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

  for (const d of [dataDir, dataDir2, dataDir3]) fs.rmSync(d, { recursive: true, force: true });
}

// ── §5 wiring pins (2.355.0: an unstaged call site keeps unit tests green) ──
console.log('— §5 wiring');
{
  const acc = fs.readFileSync(path.join(REPO, 'src/accounts.js'), 'utf8');
  ck('accounts.js exposes loginStateOf through the DESCRIPTOR (never a backend-id branch)', /creds\.loginState|_credsOf\(be\)\?\.loginState/.test(acc) && !/backend === 'claude' \? loginState/.test(acc));
  ck('every subscription row in list() carries loginState', /loginState: this\.loginStateOf\(a\.id\)/.test(acc));
  ck("a pool's row carries its MEMBERS' worst", /loginState: this\.poolLoginState\(a\.id\)/.test(acc));
  ck("the pool's login summary does NOT reuse poolMembers (that filter hides the very members this reports)", /_poolLoginCandidates\(poolId\)/.test(acc));

  const eng = fs.readFileSync(path.join(REPO, 'src/server/usage-pool-engine.js'), 'utf8');
  const decides = eng.match(/decidePoolSwitch\(\{[^}]*\}\)/g) || [];
  ck(`every decidePoolSwitch call in the engine passes readLogin (${decides.length} call sites)`, decides.length >= 3 && decides.every((c) => /readLogin/.test(c)));
  const ranks = eng.match(/rankPoolMembers\(\{[\s\S]*?\n?\s*\}\)/g) || [];
  ck(`every rankPoolMembers call in the engine passes readLogin (${ranks.length} call sites)`, ranks.length >= 2 && ranks.every((c) => /readLogin/.test(c)));
  ck('quotaVerdictFor cannot answer "usable" through a dead login', /loginUsable\(li\)/.test(eng) && /re-login needed/.test(eng));
  ck('the auth-failure notice says WHY when the refresh token expired (keeping the old wording otherwise)', /login session expired \(refresh token expired at/.test(eng) && /is failing authentication/.test(eng));
  ck('the "nowhere to go" notice speaks the login wall as its own sentence', /all-logins-expired/.test(eng) && /Re-login those accounts in Manage Agents/.test(eng));

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
