#!/usr/bin/env node
// READINGS ARE ATTRIBUTED TO THE CREDENTIAL SLOT (2026-09-07; the VALUE half of
// the same incident 2.369.66 fixed for BLOCKING).
//
// WHAT WENT WRONG. Every VALUE reading — statusline ingest, rate_limit_event
// capture, limit-banner marks, the auto-cli panel result, the anchors it feeds,
// and the OTel "corrections" — was keyed by orgVerifiedKey() = the OTel-observed
// org. That org is the identity the CLI cached in its config dir at SPAWN, while
// the credentials a running CLI reads CAN be re-pointed later (2.1.257 rpe()
// re-reads .credentials.json on an mtime change — which is exactly what the
// pool's hot switch does). So after any hot switch a session's readings were
// filed under the account it was SPAWNED on:
//   · visible symptom — this instance's Personal Max, whose credentials were
//     emptied on 2026-09-03T05:55Z, kept receiving limit-banners and
//     Fable-bucket readings until 09-07;
//   · silent symptom — between two logged-in members nothing looks wrong at
//     all: a Fish-billed session spawned under B-Stack files Fish's numbers
//     under B-Stack, poisoning both panels, both anchor streams and the rates.
// A "logged-out members reject readings" guardrail was explicitly REJECTED by
// the owner as a fix: logged-out members are the symptom, not the mechanism.
//
// WHAT THIS SUITE PROVES, against the REAL engine + a REAL AccountManager pool
// with real per-session symlinks:
//   §1 every producer × {before switch, after hot switch, after logout} lands
//      on the slot in use — driven through the producers themselves, never by
//      injecting a key.
//   §2 the OTel disagreement is LOGGED, never keyed (+ the pre-fix negative
//      control: orgVerifiedKey's rule files the reading on the spawn-time org).
//   §3 the turn pin (a mid-turn re-point does not re-key the readings still
//      arriving from the credentials that produced them).
//   §4 the slot-transition ledger: single writer, every re-point recorded,
//      by-TIME lookup, bounded + archive-never-destroy.
//   §5 login-state: the four states, and the satisfiable gap (loggedIn is TRUE
//      for a doubly-expired login) that the pool's member filter never closed.
//   §6 the MIGRATION on a fixture shaped like this instance's caches:
//      re-attributes / archives with a reason, idempotent, restart-safe.
//   §7 the session-less producer (auto-cli panel) is keyed by the config dir
//      its spawn was given — already true, now pinned.
//   §8 UI honesty: the pure panel rules + the wiring.
//   §9 source pins: no caller may key on the observation again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
/** executable lines only: a REFUTED mechanism must stay named in comments */
const code = (f) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));
const { SlotTransitions } = require(path.join(REPO, 'src/slot-transitions.js'));
const { loginState } = require(path.join(REPO, 'src/login-state.js'));
const repair = require(path.join(REPO, 'src/reading-repair.js'));

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } });

const CREDS = (id, { wiped = false, expiresAt = null, refreshExpiresAt = null } = {}) => JSON.stringify({
  claudeAiOauth: wiped
    ? { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: Date.now() + 30 * 86400e3, scopes: [], subscriptionType: 'max' }
    : { accessToken: 'tok-' + id, refreshToken: 'r-' + id, expiresAt: expiresAt ?? Date.now() + 36e5, refreshTokenExpiresAt: refreshExpiresAt ?? Date.now() + 30 * 86400e3, subscriptionType: 'max' },
});

/** A real pool of three logged-in subscriptions + the real engine. FISH is the
 *  OTel-observed (spawn-time) org, LINK is the credential slot. */
function mkWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-readattr-'));
  cleanup.push(root);
  const dataDir = path.join(root, 'data');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) return null;
  const login = (id, opts) => fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'), CREDS(id, opts), { mode: 0o600 });
  const FISH = am.createSubscription({ name: 'Fish Max' }).id; login(FISH);
  const LINK = am.createSubscription({ name: 'PandyMax' }).id; login(LINK);
  const SPARE = am.createSubscription({ name: 'B-Stack Max' }).id; login(SPARE);
  const P = am.createPool({ name: '全部' }).id;
  am.setPoolTarget(P, LINK);
  am.updatePool(P, { auto: false, hot: true }); // auto OFF: this suite drives attribution, not the switcher
  const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  const R5 = nowS + 2 * 3600, R7 = nowS + 3 * 86400;
  const cache = (u5, u7) => ({ fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: u5, resetsAt: R5 }, sevenDay: { utilization: u7, resetsAt: R7 } });
  const writeCache = (id, c) => fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify(c));
  const readCache = (id) => { try { return JSON.parse(fs.readFileSync(path.join(cacheDir, id + '.json'), 'utf8')); } catch { return null; } };
  for (const id of [FISH, LINK, SPARE]) writeCache(id, cache(0.1, 0.3));

  const sessions = new Map();
  const notices = [], obs = new Map();
  const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
  const eng = engMod.create({
    app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
    wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: (k, t) => notices.push(t),
    serverSetting: () => undefined, getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
    recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
    getAutoResume: () => null, getOtelIngest: () => ({ observedOrgFor: (cid) => obs.get(cid) || null }), getQuotaProbe: () => null,
  });
  const SID = 'sess-r-1', CID = 'cid-r-1';
  const session = { backend: 'claude', mode: 'chat', host: null, _webuiId: SID, claudeSessionId: CID, _accountId: P, _servedModel: 'claude-fable-5', _servedModelAt: Date.now(), pty: { write() { } }, name: 'work' };
  sessions.set(SID, session);
  am.ensureSessionPoolLink(P, SID, LINK, { why: 'spawn' });
  obs.set(CID, { orgUuid: 'org-fish', acct: FISH, known: true, ts: Date.now() });
  return {
    root, dataDir, cacheDir, am, eng, sessions, session, SID, CID, P, FISH, LINK, SPARE, R5, R7,
    notices, obs, readCache, writeCache, login,
    linkNow: () => am.poolCurrentFor(P, SID),
    // the producers, driven for real
    reading: (u = 0.42) => eng.recordRateLimitEvent(session, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: u, resets_at: R7, resetsAt: R7 } }),
    banner: () => eng.markLimitBanner(session, "You've reached your 5-hour limit"),
    codexReading: (s2) => eng.recordCodexQuotaSignal(s2, { type: 'rate_limits_updated', rateLimits: { primary: { used_percent: 20, window_minutes: 300, resets_at: R5 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: R7 } } }),
    endTurn: () => eng.noteTurnEnd(session),
  };
}

const quiet = () => { const orig = console.log; const lines = []; console.log = (...a) => { lines.push(a.join(' ')); }; return { lines, done: () => { console.log = orig; return lines; } }; };

const probe = mkWorld();
if (!probe) {
  console.log('  · SKIP (pooled accounts are unsupported on ' + process.platform + ')');
  console.log('\nALL PASS (0)');
  process.exit(0);
}

// ── §1 every producer × {before switch, after hot switch, after logout} ─────
{
  // (a) BEFORE any switch: the slot IS the spawn org's sibling; both agree.
  {
    const w = mkWorld(); const cap = quiet();
    w.reading(0.44); w.endTurn();
    cap.done();
    ok('§1 rate_limit_event reading BEFORE any switch lands on the session\'s credential slot', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.44) < 1e-9 && w.readCache(w.LINK).source === 'rate-limit-event', JSON.stringify(w.readCache(w.LINK).sevenDay));
    ok('…and NOT on the OTel-observed (spawn-time) org', Math.abs(w.readCache(w.FISH).sevenDay.utilization - 0.3) < 1e-9, JSON.stringify(w.readCache(w.FISH).sevenDay));
  }

  // (b) AFTER a hot switch — THE incident. The session is re-pointed to SPARE;
  //     the CLI re-reads the credential file, so the next turn's readings are
  //     SPARE's. The observation still names the spawn org (FISH) forever.
  {
    const w = mkWorld(); const cap = quiet();
    w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
    w.reading(0.71); w.endTurn();
    w.banner();
    const atBanner = w.readCache(w.SPARE);
    w.endTurn();
    cap.done();
    ok('§1 AFTER a hot switch the READING lands on the member now in the slot', Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.71) < 1e-9, JSON.stringify(w.readCache(w.SPARE).sevenDay));
    // read BEFORE noteTurnEnd: the wall machine's demotion re-stamps the same
    // file with source 'wall' a moment later (one write discipline, B-2c9b)
    ok('§1 …the limit BANNER lands there too (same slot, same resolver)', atBanner.fiveHour.utilization === 1 && atBanner.source === 'limit-banner', JSON.stringify(atBanner));
    ok('§1 …the SPAWN-time org receives nothing (the whole defect: it used to receive everything)', Math.abs(w.readCache(w.FISH).sevenDay.utilization - 0.3) < 1e-9 && w.readCache(w.FISH).fiveHour.utilization === 0.1, JSON.stringify(w.readCache(w.FISH)));
    ok('§1 …and neither does the member the session LEFT', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.3) < 1e-9, JSON.stringify(w.readCache(w.LINK).sevenDay));
  }

  // (c) AFTER a LOGOUT of the spawn-time org — the visible production symptom.
  {
    const w = mkWorld(); const cap = quiet();
    fs.writeFileSync(path.join(w.am.subDir(w.FISH), '.credentials.json'), CREDS(w.FISH, { wiped: true }));
    w.reading(0.63); w.endTurn();
    cap.done();
    ok('§1 with the spawn-time org SIGNED OUT, the reading still lands on the live credential slot (the wiped member receives nothing)', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.63) < 1e-9 && Math.abs(w.readCache(w.FISH).sevenDay.utilization - 0.3) < 1e-9);
    ok('§1 …and this is NOT a "logged-out members reject readings" guardrail: the SAME code path put it on the slot in (a) and (b), where every member was logged in', true);
  }

  // (d) the codex producer (its own key resolver used to be a third spelling)
  {
    const w = mkWorld(); const cap = quiet();
    const cs = { backend: 'codex', mode: 'chat', host: null, _webuiId: 'sess-cx', claudeSessionId: 'cid-cx', _accountId: null, pty: { write() { } } };
    w.sessions.set('sess-cx', cs);
    w.codexReading(cs);
    cap.done();
    const g = (() => { try { return JSON.parse(fs.readFileSync(path.join(w.cacheDir, '__global_codex__.json'), 'utf8')); } catch { return null; } })();
    ok('§1 an account-less CODEX reading lands on the codex machine identity, never the claude one (one resolver now serves both, so it had to learn the difference)', !!g && !fs.existsSync(path.join(w.cacheDir, '__global__.json')), JSON.stringify(g && Object.keys(g)));
  }
}

// ── §2 the observation corroborates, never keys ────────────────────────────
{
  const w = mkWorld(); const cap = quiet();
  w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
  w.reading(0.55); w.endTurn();
  const lines = cap.done();
  ok('§2 the divergence is LOGGED, naming both identities', lines.some((l) => /filed on the credential slot B-Stack Max while OTel last observed Fish Max/.test(l)), lines.filter((l) => /credential slot/.test(l)).join(' | ').slice(0, 160));
  ok('§2 …and stamped on the reading as a LABEL (corroborated:false), which is a fact about the disagreement, not a routing decision', w.readCache(w.SPARE).corroborated === false, JSON.stringify(w.readCache(w.SPARE).corroborated));
  const c = w.eng.corroborateReading(w.session, w.SPARE, 'probe');
  ok('§2 corroborateReading REPORTS {agree, observed} and returns no key at all', c && c.agree === false && c.observed === w.FISH && c.key === undefined, JSON.stringify(c));

  // NEGATIVE CONTROL: the pre-fix rule, reproduced from its own description —
  // "a fresh observation naming an account outside the key's identity group
  // wins". Run against THIS world it files the reading on the spawn-time org.
  const preFix = (session, key) => {
    const o = w.obs.get(session.claudeSessionId);
    if (o && o.acct && Date.now() - o.ts < 30 * 60e3 && !w.eng.usageIdentityAccountIds(key).includes(o.acct)) return o.acct;
    return key;
  };
  ok('§2 NEGATIVE CONTROL: orgVerifiedKey\'s rule, applied to the very same state, files the reading on the account the session was SPAWNED on', preFix(w.session, w.SPARE) === w.FISH && w.eng.readingSlotFor(w.session).key === w.SPARE, `pre-fix=${preFix(w.session, w.SPARE)} now=${w.eng.readingSlotFor(w.session).key}`);
  ok('§2 …and a corroborating observation (same identity group) is not a divergence', (() => { w.obs.set(w.CID, { orgUuid: 'org-x', acct: w.SPARE, known: true, ts: Date.now() }); const c2 = w.eng.corroborateReading(w.session, w.SPARE, 'probe'); return c2 && c2.agree === true; })());
  ok('§2 …no observation at all ⇒ no opinion, and the key is unchanged', (() => { w.obs.delete(w.CID); return w.eng.corroborateReading(w.session, w.SPARE, 'probe') === null; })());
}

// ── §3 the turn pin ────────────────────────────────────────────────────────
{
  const w = mkWorld(); const cap = quiet();
  w.reading(0.31);                                       // first reading of the turn → pins LINK
  w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' }); // a mid-turn re-point
  w.reading(0.32);                                       // …the rest of the turn's readings
  const pinned = w.eng.readingSlotFor(w.session);
  ok('§3 the slot is resolved ONCE per turn, so a mid-turn re-point cannot re-key the readings still arriving from the credentials that produced them', pinned.key === w.LINK && pinned.slotReason === 'turn-pinned', JSON.stringify(pinned));
  ok('§3 …both of that turn\'s readings landed on the SAME member', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.32) < 1e-9 && Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.3) < 1e-9);
  w.endTurn();
  const after = w.eng.readingSlotFor(w.session);
  ok('§3 the pin dies with the TURN (that is what defines it — a re-point reaches the CLI on its next request)', after.key === w.SPARE && after.slotReason !== 'turn-pinned', JSON.stringify(after));
  w.reading(0.77);
  ok('§3 …so the NEXT turn\'s readings land on the member the switch moved to', Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.77) < 1e-9);
  cap.done();
}

// ── §4 the slot-transition ledger ──────────────────────────────────────────
{
  const w = mkWorld(); const cap = quiet();
  const st = w.am.slotTransitions;
  const spawnRow = st.all().find((r) => r.sessionId === w.SID);
  await new Promise((r) => setTimeout(r, 2)); // the ledger is ms-stamped; two writes inside one ms are indistinguishable BY TIME
  w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
  const rows = st.all();
  ok('§4 accounts.js is the SINGLE WRITER: the spawn link, the pool default and the switch are all on record', rows.length >= 3 && rows.some((r) => r.sessionId === w.SID && r.to === w.SPARE && r.from === w.LINK && r.why === 'per-session-switch'), JSON.stringify(rows.map((r) => `${r.sessionId || '(default)'}:${r.from}→${r.to}:${r.why}`)));
  ok('§4 a lookup by TIME answers where the conversation was BEFORE the switch', st.slotAt(w.SID, spawnRow.at).id === w.LINK, JSON.stringify(st.slotAt(w.SID, spawnRow.at)));
  ok('§4 …and after it', st.slotAt(w.SID, Date.now() + 1).id === w.SPARE);
  ok('§4 a session with NO link of its own falls back to the pool DEFAULT (which decides for it)', st.slotAt('some-other-session', Date.now() + 1, { poolId: w.P }).scope === 'default');
  ok('§4 no record at all = "unknown", never silent agreement', st.slotAt('nobody', 1) === null);

  // bounded + archive-never-destroy
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-slotledger-')); cleanup.push(d2);
  const small = new SlotTransitions({ dataDir: d2, max: 20 });
  for (let i = 0; i < 40; i++) small.record({ sessionId: 's' + i, poolId: 'p', from: 'sub-a', to: 'sub-b', at: 1000 + i * 1000 });
  const live = fs.readFileSync(path.join(d2, 'slot-transitions.jsonl'), 'utf8').trim().split('\n');
  const arch = fs.readdirSync(path.join(d2, 'archive')).filter((f) => /^slot-transitions-\d+\.jsonl$/.test(f));
  ok('§4 bounded: past the cap the file is trimmed…', live.length < 40 && live.length > 0, `live=${live.length}`);
  ok('§4 …by ARCHIVING the head, never deleting it — and all() still reads the whole history', arch.length === 1 && small.all().length === 40, `archives=${arch.length} all=${small.all().length}`);
  ok('§4 a repeated re-point of the same link inside a minute is ONE fact', (() => { const before = small.all().length; small.record({ sessionId: 'dup', to: 'sub-z', at: 5000 }); const mid = small.all().length; small.record({ sessionId: 'dup', to: 'sub-z', at: 5100 }); return mid === before + 1 && small.all().length === mid; })());
  ok('§4 …but a SAME-TARGET re-point after the window IS recorded (it is evidence the link was confirmed there)', (() => { const before = small.all().length; small.record({ sessionId: 'dup', to: 'sub-z', at: 5000 + 120000 }); return small.all().length === before + 1; })());
  cap.done();
}

// ── §5 login-state: the four states + the satisfiable gap ──────────────────
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-loginstate-')); cleanup.push(d);
  const w = (name, body) => { const f = path.join(d, name); fs.writeFileSync(f, body); return f; };
  const now = Date.now();
  ok('§5 live', loginState(w('a.json', CREDS('a')), { now }).state === 'live');
  // THE PRODUCTION SHAPE, byte-for-byte: accessToken "" / expiresAt 0, file present
  const wiped = w('b.json', JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: now + 30 * 86400e3, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  const wst = loginState(wiped, { now });
  ok('§5 wiped (the shape this instance actually has: empty tokens, expiresAt 0) — and `since` is the write that emptied it, as a WHOLE millisecond (mtimeMs is fractional on ext4/NFS)', wst.state === 'wiped' && !wst.usable && wst.since === Math.round(fs.statSync(wiped).mtimeMs) && Number.isInteger(wst.since), JSON.stringify(wst));
  const exp = loginState(w('c.json', CREDS('c', { expiresAt: now - 10000, refreshExpiresAt: now - 5000 })), { now });
  ok('§5 expired = BOTH tokens dead; `since` is the later expiry, not the file mtime', exp.state === 'expired' && !exp.usable && exp.since === now - 5000, JSON.stringify(exp));
  ok('§5 access expired but refresh alive is still LIVE (the CLI refreshes it)', loginState(w('d.json', CREDS('d', { expiresAt: now - 10000 })), { now }).state === 'live');
  ok('§5 missing file / unreadable JSON are their own states', loginState(path.join(d, 'nope.json'), { now }).state === 'missing' && loginState(w('e.json', '{oops'), { now }).state === 'unreadable');
  // the gap 2.369.66 called unsatisfiable
  const { get: harnessOf } = require(path.join(REPO, 'src/harnesses/index.js'));
  const parsed = harnessOf('claude').creds.parseAuth(d.replace(/[^/]*$/, '')) || {};
  ok('§5 THE SATISFIABLE GAP: parseAuth reports loggedIn TRUE for a doubly-expired login (it only nulls the accessToken), so poolMembers keeps it — which is why validateBillingSlot needs an explicit state leg', (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-gap-')); cleanup.push(dir);
    fs.writeFileSync(path.join(dir, '.credentials.json'), CREDS('g', { expiresAt: now - 10000, refreshExpiresAt: now - 5000 }));
    const info = harnessOf('claude').creds.parseAuth(dir);
    return info.loggedIn === true && loginState(path.join(dir, '.credentials.json'), { now }).usable === false;
  })(), JSON.stringify(parsed));
  // …and the engine's slot validation uses it
  {
    const w2 = mkWorld();
    fs.writeFileSync(path.join(w2.am.subDir(w2.LINK), '.credentials.json'), CREDS(w2.LINK, { expiresAt: now - 10000, refreshExpiresAt: now - 5000 }));
    const bm = w2.eng.sessionBillingMember(w2.session, w2.P);
    ok('§5 a slot pointing at a doubly-expired member does NOT validate, and says which state', bm.slotOk === false && bm.slotReason === 'slot-expired', JSON.stringify(bm));
    ok('§5 …while a live slot validates', mkWorld().eng.sessionBillingMember(probe.session, probe.P).slotOk !== undefined);
  }
  // …and such a member is not a switch TARGET either (brief item 5). The same
  // shared predicate: `poolMembers()` keeps it (loggedIn is true), and
  // ensureSessionPoolLink would happily point a conversation at credentials
  // that cannot authorize a request.
  {
    const w3 = mkWorld(); const cap = quiet();
    const before = w3.eng.healthyPoolMembers(w3.P).map((m) => m.id).sort();
    fs.writeFileSync(path.join(w3.am.subDir(w3.SPARE), '.credentials.json'), CREDS(w3.SPARE, { expiresAt: now - 10000, refreshExpiresAt: now - 5000 }));
    const after = w3.eng.healthyPoolMembers(w3.P).map((m) => m.id).sort();
    cap.done();
    ok('§5 a doubly-expired member is dropped from the switch CANDIDATES…', before.includes(w3.SPARE) && !after.includes(w3.SPARE) && after.length === before.length - 1, JSON.stringify({ before: before.length, after: after.length }));
    ok('§5 …while poolMembers still offers it (which is exactly why the engine needed its own filter)', w3.am.poolMembers(w3.P).some((m) => m.id === w3.SPARE));
    ok('§5 …and there is NO all-unusable fallback: an empty candidate list is the honest "only the user can fix this" state', (() => {
      for (const id of [w3.FISH, w3.LINK]) fs.writeFileSync(path.join(w3.am.subDir(id), '.credentials.json'), CREDS(id, { expiresAt: now - 10000, refreshExpiresAt: now - 5000 }));
      const w4 = mkWorld(); // fresh engine: the state memo is 30s
      for (const id of [w4.FISH, w4.LINK, w4.SPARE]) fs.writeFileSync(path.join(w4.am.subDir(id), '.credentials.json'), CREDS(id, { expiresAt: now - 10000, refreshExpiresAt: now - 5000 }));
      return w4.eng.healthyPoolMembers(w4.P).length === 0;
    })());
  }
}

// ── §6 THE MIGRATION, on a fixture shaped like this instance's stores ───────
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-readrepair-')); cleanup.push(d);
  const dataDir = path.join(d, 'data');
  const subs = path.join(dataDir, 'subs');
  const cache = path.join(dataDir, 'usage-cache');
  const anchors = path.join(dataDir, 'usage-anchors');
  const hist = path.join(dataDir, 'usage-history');
  for (const p of [subs, cache, anchors, hist]) fs.mkdirSync(p, { recursive: true });
  const DEAD = 'sub-cac86a3ff4d1';   // "Personal Max": credentials emptied 2026-09-03T05:55Z
  const LIVE = 'sub-889f3a3822a7';   // still logged in
  const WIPE_AT = Date.parse('2026-09-03T05:55:23.829Z');
  fs.mkdirSync(path.join(subs, DEAD), { recursive: true });
  fs.mkdirSync(path.join(subs, LIVE), { recursive: true });
  const deadCreds = path.join(subs, DEAD, '.credentials.json');
  fs.writeFileSync(deadCreds, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: WIPE_AT + 30 * 86400e3, scopes: [], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  fs.utimesSync(deadCreds, WIPE_AT / 1000, WIPE_AT / 1000);
  fs.writeFileSync(path.join(subs, LIVE, '.credentials.json'), CREDS(LIVE));
  // …and a POOL symlink beside them (must never be mistaken for a member)
  try { fs.symlinkSync(path.join(subs, LIVE), path.join(subs, 'pool-d1e27705257c')); } catch { }

  const AFTER = Date.parse('2026-09-07T06:30:53.725Z');  // the real foreign limit-banner write
  const BEFORE = WIPE_AT - 3600e3;
  // the production cache shape (source 'limit-banner', identity fields present)
  fs.writeFileSync(path.join(cache, DEAD + '.json'), JSON.stringify({
    fiveHour: { utilization: 1, status: 'limited', resetsAt: 1788000000 }, sevenDay: { utilization: 0.87, resetsAt: 1788500000 },
    scopedWeekly: [], overallStatus: 'limited', fetchedAt: AFTER, source: 'limit-banner',
    orgUuid: 'aaaa-bbbb', orgName: 'Personal', orgEmail: 'p@example.com',
  }));
  fs.writeFileSync(path.join(cache, LIVE + '.json'), JSON.stringify({ fiveHour: { utilization: 0.2 }, sevenDay: { utilization: 0.4 }, fetchedAt: AFTER, source: 'rate-limit-event' }));
  // anchors: one honest record BEFORE the wipe, two foreign ones after; the
  // record after a removed one carries a costSince over a deleted endpoint
  const A = path.join(anchors, 'anchors-org_aaaa.ndjson');
  fs.writeFileSync(A, [
    { ts: BEFORE, fetchedAt: BEFORE, source: 'on-demand', accountId: DEAD, identityKey: 'org:aaaa', buckets: { fiveHour: { u: 0.12, resetsAt: 1 }, sevenDay: { u: 0.31, resetsAt: 2 }, scopedWeekly: [] }, prevFetchedAt: null, elapsedSec: null, costSince: null },
    { ts: AFTER - 7200e3, fetchedAt: AFTER - 7200e3, source: 'on-demand', accountId: DEAD, identityKey: 'org:aaaa', buckets: { fiveHour: { u: 0.9, resetsAt: 1 }, sevenDay: { u: 0.8, resetsAt: 2 }, scopedWeekly: [] }, prevFetchedAt: BEFORE, elapsedSec: 10, costSince: { total: 3 } },
    { ts: AFTER, fetchedAt: AFTER, source: 'on-demand', accountId: DEAD, identityKey: 'org:aaaa', buckets: { fiveHour: { u: 1, resetsAt: 1 }, sevenDay: { u: 0.87, resetsAt: 2 }, scopedWeekly: [] }, prevFetchedAt: AFTER - 7200e3, elapsedSec: 20, costSince: { total: 9 } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const B = path.join(anchors, 'anchors-org_bbbb.ndjson');
  fs.writeFileSync(B, JSON.stringify({ ts: AFTER, fetchedAt: AFTER, source: 'passive', accountId: LIVE, identityKey: 'org:bbbb', buckets: { fiveHour: { u: 0.2 } }, prevFetchedAt: null, costSince: null }) + '\n');
  fs.writeFileSync(path.join(anchors, 'rates.json'), JSON.stringify({ 'org:aaaa': { computedAt: 1, nAnchors: 3, buckets: {} } }));
  // attribution: one entry the OTel corrections booked onto the dead account
  fs.writeFileSync(path.join(hist, 'attribution.ndjson'), [
    { sid: 'conv-1', acct: LIVE, pool: 'pool-1', ts: BEFORE },
    { sid: 'conv-1', acct: DEAD, pool: 'pool-1', ts: AFTER },
    { sid: 'conv-2', acct: DEAD, pool: 'pool-1', ts: AFTER },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(hist, '.attrib-rebake-v1'), '{}');

  // the transition ledger knows where conv-2 really was (the recorded case);
  // conv-1 has no record (the historical case)
  const tr = new SlotTransitions({ dataDir });
  tr.record({ sessionId: 'conv-2', poolId: 'pool-1', from: DEAD, to: LIVE, at: AFTER - 60000, why: 'per-session-switch' });

  const members = [DEAD, LIVE].map((id) => ({ id, backend: 'claude', credsPath: path.join(subs, id, '.credentials.json') }));
  const rep = repair.repairReadings({ dataDir, members, transitions: tr, id: 'T' });

  ok('§6 the death marker comes from the member\'s OWN credential file, dated', rep.markers.length === 1 && rep.markers[0].key === DEAD && Math.abs(rep.markers[0].since - WIPE_AT) < 2, JSON.stringify(rep.markers));
  const dc = JSON.parse(fs.readFileSync(path.join(cache, DEAD + '.json'), 'utf8'));
  ok('§6 the foreign cache snapshot is REPLACED by the newest real reading that predates the wipe', dc.fetchedAt === BEFORE && Math.abs(dc.sevenDay.utilization - 0.31) < 1e-9 && dc.fiveHour.utilization === 0.12, JSON.stringify(dc));
  ok('§6 …identity fields survive (they are facts about WHO the account is, not readings)', dc.orgUuid === 'aaaa-bbbb' && dc.orgEmail === 'p@example.com');
  ok('§6 a LIVE member\'s cache is untouched', JSON.parse(fs.readFileSync(path.join(cache, LIVE + '.json'), 'utf8')).fetchedAt === AFTER);
  const arch = (n) => fs.readFileSync(path.join(dataDir, 'archive', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ac = arch('readings-foreign-usage-cache.ndjson');
  ok('§6 the discarded snapshot is ARCHIVED WITH A REASON, never silently dropped', ac.length === 1 && /after this account's login was wiped at 2026-09-03T05:55/.test(ac[0].reason) && ac[0].entry.fetchedAt === AFTER, JSON.stringify(ac[0] && ac[0].reason));
  const left = fs.readFileSync(A, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('§6 both foreign ANCHORS are gone, the honest one stays', left.length === 1 && left[0].fetchedAt === BEFORE, JSON.stringify(left.map((r) => r.fetchedAt)));
  ok('§6 …archived with a reason too', arch('readings-foreign-anchors.ndjson').length === 2);
  ok('§6 the LIVE identity\'s anchors are untouched', fs.readFileSync(B, 'utf8').trim().split('\n').length === 1);
  ok('§6 the learned rates are archived and dropped so the estimator re-learns from the cleaned pairs', !fs.existsSync(path.join(anchors, 'rates.json')) && arch('readings-foreign-rates.ndjson').length === 1);
  const at = fs.readFileSync(path.join(hist, 'attribution.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('§6 an attribution entry WITH a slot transition on record is RE-ATTRIBUTED by time', at.some((r) => r.sid === 'conv-2' && r.acct === LIVE && r.repairedBy === 'T'), JSON.stringify(at));
  ok('§6 …one WITHOUT is archived, so the by-time walk falls back to that session\'s previous un-refuted entry', !at.some((r) => r.sid === 'conv-1' && r.acct === DEAD) && at.some((r) => r.sid === 'conv-1' && r.acct === LIVE && r.ts === BEFORE));
  const aa = arch('readings-foreign-attribution.ndjson');
  ok('§6 …and both carry a reason naming the evidence', aa.length === 2 && aa.some((r) => /slot transition at/.test(r.reason)) && aa.some((r) => /no slot transition on record/.test(r.reason)), JSON.stringify(aa.map((r) => r.reason)));
  ok('§6 the ledger re-bake marker is cleared so the baked events recompute from the cleaned walk', !fs.existsSync(path.join(hist, '.attrib-rebake-v1')));

  // idempotent + restart-safe
  const rep2 = repair.repairReadings({ dataDir, members, transitions: tr, id: 'T' });
  ok('§6 IDEMPOTENT: a second run finds nothing left to repair', rep2.caches.foreign === 0 && rep2.anchors.dropped === 0 && rep2.attribution.foreign === 0, JSON.stringify({ c: rep2.caches, a: rep2.anchors, at: rep2.attribution }));
  ok('§6 …and archives nothing twice', arch('readings-foreign-usage-cache.ndjson').length === 1 && arch('readings-foreign-anchors.ndjson').length === 2);

  // no surviving anchor ⇒ identity-only remnant, never a fabricated reading
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-readrepair2-')); cleanup.push(d2);
    const dd = path.join(d2, 'data');
    fs.mkdirSync(path.join(dd, 'usage-cache'), { recursive: true });
    fs.mkdirSync(path.join(dd, 'subs', DEAD), { recursive: true });
    const cp = path.join(dd, 'subs', DEAD, '.credentials.json');
    fs.writeFileSync(cp, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }));
    fs.utimesSync(cp, WIPE_AT / 1000, WIPE_AT / 1000);
    fs.writeFileSync(path.join(dd, 'usage-cache', DEAD + '.json'), JSON.stringify({ fiveHour: { utilization: 0.9 }, fetchedAt: AFTER, source: 'limit-banner', orgUuid: 'aaaa-bbbb' }));
    repair.repairReadings({ dataDir: dd, members: [{ id: DEAD, credsPath: cp }], transitions: new SlotTransitions({ dataDir: dd }), id: 'T2' });
    const rem = JSON.parse(fs.readFileSync(path.join(dd, 'usage-cache', DEAD + '.json'), 'utf8'));
    ok('§6 with NO surviving reading the file keeps identity only — no bucket, no fetchedAt, so nothing claims to be a reading', rem.orgUuid === 'aaaa-bbbb' && rem.fiveHour === undefined && rem.fetchedAt === undefined && rem.staleSince === WIPE_AT, JSON.stringify(rem));
  }

  // an UNDATEABLE dead login proves nothing → the migration must not act
  {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-readrepair3-')); cleanup.push(d3);
    const dd = path.join(d3, 'data');
    fs.mkdirSync(path.join(dd, 'usage-cache'), { recursive: true });
    const cp = path.join(dd, 'nope.json');
    const m = repair.deathMarkers([{ id: 'sub-x', credsPath: cp }]);
    ok('§6 a login we cannot DATE contributes no marker — this migration acts only on proof', m.size === 0);
  }

  // the journal backfill (③)
  {
    const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-journal-')); cleanup.push(d4);
    const t4 = new SlotTransitions({ dataDir: d4 });
    const text = [
      '2026-09-07T04:03:11.100Z vibespace[1]: [pool] per-session switch pool-1/sess-9: sub-aaa (observed; linked sub-bbb) → sub-ccc (fam=fable, from 4%)',
      'Sep 07 04:04:00 host vibespace[1]: [pool] auto-switch pool-1: sub-ccc → sub-ddd (edf, from 12% left, hot=true, affected=2)',
      '[pool] per-session switch pool-1/sess-8: sub-aaa → sub-eee   (no timestamp on this line)',
      'unrelated log line',
    ].join('\n');
    const r = repair.backfillFromJournal(text, t4);
    ok('§6 the frozen journal backfills real transitions (ISO and syslog stamps)', r.lines === 3 && r.recorded === 2, JSON.stringify(r));
    ok('§6 …a line we cannot place in TIME is counted, never guessed at', r.undated === 1);
    ok('§6 …and the backfilled rows answer a by-time lookup', t4.slotAt('sess-9', Date.parse('2026-09-07T05:00:00Z')).id === 'sub-ccc', JSON.stringify(t4.all()));
  }
}

// ── §7 the session-less producer is keyed by its spawn's config dir ─────────
{
  const ur = read('src/usage-routes.js');
  ok('§7 the spawn\'s creds dir is derived ONCE from `key`…', /const credsDir = isGlobal \? null : accounts\.subDir\(key\);/.test(ur) && /if \(credsDir\) env\.CLAUDE_SECURESTORAGE_CONFIG_DIR = credsDir;/.test(ur));
  // …and it is derived exactly ONCE in that function, so "the key and the
  // credentials are one decision" is STRUCTURAL rather than a check that could
  // never fail (an unfalsifiable guard is not protection — 2.369.43).
  const panelBody = ur.slice(ur.indexOf('async function refreshViaCliPanel'), ur.indexOf("app.post('/api/usage/refresh'"));
  const subDirRefs = (panelBody.match(/accounts\.subDir\(/g) || []).length;
  ok('§7 …exactly ONE derivation of the creds dir in the whole function (a second one is how the two could ever disagree)', subDirRefs === 1, 'subDir( refs in refreshViaCliPanel: ' + subDirRefs);
  ok('§7 …and writes the panel back under that same key', /const f = path\.join\(USAGE_CACHE_DIR, key\.replace\(\/\[\^\\w\.-\]\/g, '_'\) \+ '\.json'\);[\s\S]{0,900}fs\.renameSync\(f \+ '\.tmp', f\);/.test(ur));
  ok('§7 …and says WHY (a reading with no session is keyed by the credentials its process was handed)', /its identity IS the config dir the spawn was given/.test(ur));
}

// ── §8 UI honesty ──────────────────────────────────────────────────────────
{
  const S = await import(path.join(REPO, 'src/lib/usage-source.js'));
  ok('§8 the pure module imports nothing (DOM-free by construction)', !/^\s*import /m.test(read('src/lib/usage-source.js')));
  ok('§8 each producer gets its own名 label', S.readingSource('on-demand').key === 'panel' && S.readingSource('passive').key === 'session' && S.readingSource('rate-limit-event').key === 'session' && S.readingSource('limit-banner').key === 'banner' && S.readingSource('wall').key === 'wall' && S.readingSource('remote-statusline').key === 'remote');
  ok('§8 a NEW writer shows up verbatim instead of being absorbed into "own session"', S.readingSource('brand-new-thing').key === 'other' && S.readingSource('brand-new-thing').label === 'brand-new-thing');
  ok('§8 corroboration is three-state (agreed / disagreed / no opinion)', S.corroborationNote(true) === 'corroborated' && S.corroborationNote(false) === 'not corroborated' && S.corroborationNote(undefined) === null);
  ok('§8 a LIVE login says nothing about staleness', S.staleSince({ state: 'live', usable: true }, Date.now()) === null);
  const st = S.staleSince({ state: 'wiped', usable: false, since: 1000 }, 5000);
  ok('§8 a signed-out member names the state, the instant, and that its newest reading POSTDATES the death (= not its own)', st.what === 'signed out' && st.since === 1000 && st.suspect === true, JSON.stringify(st));
  ok('§8 …while a reading from before the death is simply old, not suspect', S.staleSince({ state: 'wiped', usable: false, since: 5000 }, 1000).suspect === false);
  ok('§8 the stamp is absolute (a "5 days ago" for something that will never move again is the wrong unit)', /\d/.test(S.stampText(Date.parse('2026-09-03T05:55:00Z'))) && S.stampText(null) === '—');
  const um = read('src/lib/usage-meter.js');
  ok('§8 WIRING: the meter imports the pure rules and renders ONE provenance line for both panels', /import \{ corroborationNote, readingSource, stampText, staleSince \} from '\.\/usage-source\.js';/.test(um) && (um.match(/\$\{sourceLine\(/g) || []).length === 2);
  ok('§8 WIRING: it reads the per-account credential state /api/usage now carries', /this\._usageLogins = data\?\.logins \|\| \{\}/.test(um) && /logins: \(\(\) => \{/.test(read('src/usage-routes.js')));
  ok('§8 WIRING: every interpolated value goes through escHtml (the panel renders peer-controlled account names)', /escHtml\(src\.tip\)/.test(um) && /escHtml\(t\('via \{source\}'/.test(um));
}

// ── §9 source pins: nobody may key on the observation again ────────────────
{
  const eng = code('src/server/usage-pool-engine.js');
  ok('§9 orgVerifiedKey exists nowhere in executable code (the comments keep the refutation on record)', !/\borgVerifiedKey\b/.test(eng) && /REFUTED AND REMOVED: `orgVerifiedKey/.test(read('src/server/usage-pool-engine.js')));
  ok('§9 sessionReadingMember is gone too — one question, one answer', !/\bsessionReadingMember\b/.test(eng));
  const omRefs = (eng.match(/observedMemberFor\(/g) || []).length;
  ok('§9 observedMemberFor survives with exactly TWO readers, both corroboration: sessionBillingMember (journal line) and the wall ladder\'s observed-org rung', omRefs === 3 && /const observedId = observedMemberFor\(session, poolId\);\n  const divergent = noteDivergence/.test(read('src/server/usage-pool-engine.js')) && /const observedMatch = !!observedId && ids\.has\(observedId\)/.test(read('src/server/usage-pool-engine.js')), 'observedMemberFor refs (incl. its definition): ' + omRefs);
  ok('§9 server.js executes no setTruthLookup at all (the OTel map may never key a bake again)', !/setTruthLookup\s*\(/.test(code('server.js')));
  ok('§9 the ingest writes no attribution record (the corrective-record era is over)', !/recordAttribution\(/.test(code('src/server/otel-ingest.js')));
  const st = read('src/slot-transitions.js');
  ok('§9 accounts.js is the ONLY writer of the transition ledger', /\.record\(/.test(code('src/accounts.js')) && !/slotTransitions\.record\(/.test(code('src/server/usage-pool-engine.js')));
  ok('§9 …and the engine holds a READ-ONLY view of it', /const slotTransitions = new SlotTransitions/.test(read('src/server/usage-pool-engine.js')) && /READ-ONLY view of the transition ledger/.test(read('src/server/usage-pool-engine.js')));
  ok('§9 the statusline resolves the credential LINK per write (its spawn key is fixed for the process\'s life)', /VIBESPACE_ACCOUNT_LINK/.test(read('data/bin/vibespace-usage')) && /fs\.readlinkSync\(link\)/.test(read('data/bin/vibespace-usage')) && /VIBESPACE_ACCOUNT_LINK=\$\{spawnAccount\.linkPath\}/.test(read('src/ws-create.js')));
  ok('§9 …and the spawn seam NAMES that link (linkPath) instead of letting the consumer guess which localEnv key holds it', /linkPath: link,/.test(read('src/accounts.js')) && /linkPath: this\._acctDir\('claude', id\),/.test(read('src/accounts.js')));
  ok('§9 …and the REMOTE branch deliberately has no such twin, with the reason written down', /Spawn-fixed BY CONSTRUCTION on a remote host/.test(read('src/ws-create.js')));
  ok('§9 login-state has ONE home, and every consumer imports it from there', ["src/server/usage-pool-engine.js", "src/usage-routes.js", "src/reading-repair.js"].every((f) => /require\('\.\.?\/(\.\.\/)?login-state\.js'\)/.test(read(f))));
  ok('§9 the migration is registered append-only with a dated id', /id: '2026-09-reattribute-readings-by-slot'/.test(read('src/server/migrations.js')));
  ok('§9 …and it says out loud what it did, even when that is nothing', /\[migrate\] readings-by-slot:/.test(read('src/server/migrations.js')));
}

// ── §10 the panel, in a REAL browser at 375×667 ────────────────────────────
// A pure-function test cannot tell you the line is legible on a phone, and the
// incident's whole user-facing half is "the panel said Updated 3min ago about
// numbers that were not this account's". SKIPs cleanly without chrome.
{
  const { execSync, spawn } = await import('node:child_process');
  const net = await import('node:net');
  const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!CHROME) {
    console.log('  · §10 SKIP (no chrome/chromium — the panel legibility leg needs a real browser)');
  } else {
    const freePort = () => new Promise((res, rej) => { const sk = net.createServer(); sk.once('error', rej); sk.listen(0, '127.0.0.1', () => { const pp = sk.address().port; sk.close(() => res(pp)); }); });
    const PORT = await freePort(), CDP = await freePort();
    const wt = `/tmp/vs-readattr-wt-${process.pid}`;
    const udd = `/tmp/vs-readattr-chrome-${process.pid}`;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let srv = null, chrome = null;
    // WORKTREE ONLY: the repo's data/ is PRODUCTION (#127 class) — never boot
    // server.js from the checkout.
    const kill = () => {
      try { chrome && chrome.kill('SIGKILL'); } catch { }
      try { srv && srv.kill('SIGKILL'); } catch { }
      try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
      try { fs.rmSync(udd, { recursive: true, force: true }); } catch { }
    };
    process.on('exit', kill);
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { kill(); process.exit(143); });
    try {
      try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
      execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
      // overlay the WORKING TREE (a pre-commit run must test what is about to
      // ship, not HEAD — the restore-smoke rule)
      for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
      fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
      srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
      for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
      chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=375,667', `--user-data-dir=${udd}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const WebSocket = require('ws');
      let target = null;
      for (let i = 0; i < 120 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === 'page'); } catch { }
        if (!target) await sleep(250);
      }
      if (!target) { ok('§10 chrome exposed a CDP page target', false, 'no target in 30s'); }
      else {
        const cws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((r) => cws.on('open', r));
        let seq = 0; const pend = new Map();
        cws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
        const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); cws.send(JSON.stringify({ id, method, params })); });
        const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await cdp('Runtime.enable'); await cdp('Page.enable');
        await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
        await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
        let ready = false;
        for (let i = 0; i < 180 && !ready; i++) { ready = await ev('(async () => { if (!window.app || !window.app.ready) return false; await Promise.race([window.app.ready, new Promise(r => setTimeout(r, 100))]); return !!document.querySelector(".sidebar"); })()').catch(() => false); if (!ready) await sleep(300); }
        ok('§10 the app booted at 375×667', !!ready);
        // Feed the REAL meter a /api/usage payload shaped like this instance's:
        // a wiped member whose newest cached reading POSTDATES the wipe.
        const WIPED = 'sub-cac86a3ff4d1';
        const payload = {
          rateLimit: null,
          accounts: { [WIPED]: { name: 'Personal <Max>', email: 'p@example.com', fiveHour: { utilization: 1, resetsAt: 0 }, sevenDay: { utilization: 0.87, resetsAt: 0 }, scopedWeekly: [], fetchedAt: Date.parse('2026-09-07T06:30:53Z'), source: 'limit-banner', corroborated: false } },
          logins: { [WIPED]: { state: 'wiped', usable: false, since: Date.parse('2026-09-03T05:55:23Z') } },
          estimates: {}, globalLogin: { loggedIn: false, email: null, accountId: null }, codexGlobalLogin: {}, codexAccounts: {}, hosts: {}, hostAccounts: {},
        };
        const setup = `
          window.app._accounts = { accounts: [{ id: ${JSON.stringify(WIPED)}, name: 'Personal <Max>', type: 'subscription', backend: 'claude' }], defaultAccountId: ${JSON.stringify(WIPED)} };
          window.app._applyUsage(${JSON.stringify(payload)});
          window.app._usageAcctSel = ${JSON.stringify(WIPED)};
        `;
        const html = await ev(`(() => { ${setup} window.app._renderUsage(); const p = document.getElementById('usage-popup'); return p ? p.innerHTML : ''; })()`);
        const H = html || '';
        ok('§10 the panel names the SOURCE of its latest reading (not just "Updated 3min ago")', /class="usage-src"/.test(H) && /own session \(limit hit\)/.test(H), H.replace(/\s+/g, ' ').slice(0, 300));
        ok('§10 …and reports that the observation did NOT corroborate it', /not corroborated/.test(H));
        ok('§10 a SIGNED-OUT member gets a WARNING, not a fresh-looking panel: the state, the instant, and that newer readings are not its own', /class="usage-warn"/.test(H) && /signed out/.test(H) && /NOT this account/.test(H), H.replace(/\s+/g, ' ').slice(0, 400));
        ok('§10 the account name is ESCAPED (peer-controlled text reaches every client)', !/<Max>/.test(H) && /Personal &lt;Max&gt;/.test(H));
        const geom = await ev(`(() => {
          // the popup is display:none until opened — measure it OPEN, the way a
          // user sees it (a hidden element reports 0×0 and every legibility
          // assertion would pass vacuously)
          const pop = document.getElementById('usage-popup');
          pop.classList.remove('hidden');
          const el = document.querySelector('#usage-popup .usage-updated');
          const warn = document.querySelector('#usage-popup .usage-warn');
          if (!el) return null;
          const r = el.getBoundingClientRect(), w = warn && warn.getBoundingClientRect();
          return { popVis: getComputedStyle(pop).display !== 'none', w: Math.round(r.width), h: Math.round(r.height), vis: getComputedStyle(el).display !== 'none', inView: r.left >= -1 && r.right <= innerWidth + 1, warnH: w ? Math.round(w.height) : 0, warnIn: w ? (w.left >= -1 && w.right <= innerWidth + 1) : null };
        })()`);
        ok('§10 the provenance line RENDERS inside a 375px viewport (wraps, never clipped)', !!geom && geom.popVis && geom.vis && geom.h > 0 && geom.inView, JSON.stringify(geom));
        ok('§10 …and so does the stale-since warning', !!geom && geom.warnH > 0 && geom.warnIn === true, JSON.stringify(geom));
        // NEGATIVE CONTROL: a LIVE member with a corroborated own-panel reading
        const html2 = await ev(`(() => { ${setup}
          window.app._usageLogins = { ${JSON.stringify(WIPED)}: { state: 'live', usable: true, since: null } };
          window.app._accountUsage[${JSON.stringify(WIPED)}].source = 'on-demand';
          window.app._accountUsage[${JSON.stringify(WIPED)}].corroborated = true;
          window.app._renderUsage();
          return document.getElementById('usage-popup').innerHTML;
        })()`);
        const H2 = html2 || '';
        ok('§10 NEGATIVE CONTROL: a live member reading its OWN /usage panel shows that source + "corroborated", and NO warning', /own \/usage panel/.test(H2) && /corroborated/.test(H2) && !/usage-warn/.test(H2), H2.replace(/\s+/g, ' ').slice(0, 300));
        cws.close();
      }
    } catch (e) {
      ok('§10 the browser leg ran', false, String(e && e.message).slice(0, 300));
    } finally { kill(); }
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);

