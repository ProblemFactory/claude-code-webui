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
import cp from 'node:child_process';
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
const { loginState, accountLoginState, OAT_TTL_MS } = require(path.join(REPO, 'src/login-state.js'));
const repair = require(path.join(REPO, 'src/reading-repair.js'));
const readingLag = require(path.join(REPO, 'src/reading-lag.js'));
/** The established window lives in a SIDECAR beside the cache (r2), because the
 *  snapshot is rebuilt wholesale by every reading producer — including the
 *  shipped statusline hook, whose ordinary 8 s write used to delete it. Every
 *  fixture stamps it the way refreshViaCliPanel does. */
const stampWindow = (cacheDir, id, win) =>
  fs.writeFileSync(path.join(cacheDir, readingLag.windowSidecarName(id)), JSON.stringify({ at: Date.now(), source: 'on-demand', ...win }));
const readWindow = (cacheDir, id) => { try { return JSON.parse(fs.readFileSync(path.join(cacheDir, readingLag.windowSidecarName(id)), 'utf8')); } catch { return null; } };

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } });

/** Write a PATCHED COPY of a real src/ module somewhere else and require it.
 *  EVERY relative require is re-pointed at the repo, not a hand-kept list of
 *  two: r5 added one import to `reading-repair.js` and the r4 control — the
 *  file whose whole job is to still run — died on MODULE_NOT_FOUND. A control
 *  that stops loading is worse than one that stops applying. */
const patchedModule = (dir, name, text) => {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, text.replace(/require\((['"])\.\/([\w.-]+)\1\)/g, (_m, _q, f) => `require(${JSON.stringify(path.join(REPO, 'src', f))})`));
  return require(fp);
};

const CREDS = (id, { wiped = false, expiresAt = null, refreshExpiresAt = null } = {}) => JSON.stringify({
  claudeAiOauth: wiped
    ? { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: Date.now() + 30 * 86400e3, scopes: [], subscriptionType: 'max' }
    : { accessToken: 'tok-' + id, refreshToken: 'r-' + id, expiresAt: expiresAt ?? Date.now() + 36e5, refreshTokenExpiresAt: refreshExpiresAt ?? Date.now() + 30 * 86400e3, subscriptionType: 'max' },
});

/** A real pool of three logged-in subscriptions + the real engine. FISH is the
 *  OTel-observed (spawn-time) org, LINK is the credential slot.
 *  `hosts` (r2 §11b) injects a device-manager stub so pushSealedOrders can be
 *  driven for real; every other caller passes nothing and gets `null`, which
 *  is what the engine sees on an instance with no daemon. */
function mkWorld({ hosts = null } = {}) {
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
  // A FRESH engine over the SAME stores — what a server restart sees. §14 uses
  // it to reach a SECOND pool evaluation without fighting the live engine's own
  // 10s/180s anti-flap timers (which are per-instance memory, and which in the
  // real incident had simply expired by the time the second switch fired).
  const mkEngine = () => engMod.create({
    app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
    wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: (k, t) => notices.push(t),
    serverSetting: () => undefined, getAccounts: () => am, getHosts: () => hosts, getUsageHistory: () => null,
    recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
    getAutoResume: () => null, getOtelIngest: () => ({ observedOrgFor: (cid) => obs.get(cid) || null }), getQuotaProbe: () => null,
  });
  const eng = mkEngine();
  const SID = 'sess-r-1', CID = 'cid-r-1';
  const session = { backend: 'claude', mode: 'chat', host: null, _webuiId: SID, claudeSessionId: CID, _accountId: P, _servedModel: 'claude-fable-5', _servedModelAt: Date.now(), pty: { write() { } }, name: 'work' };
  sessions.set(SID, session);
  am.ensureSessionPoolLink(P, SID, LINK, { why: 'spawn' });
  obs.set(CID, { orgUuid: 'org-fish', acct: FISH, known: true, ts: Date.now() });
  return {
    root, dataDir, cacheDir, am, eng, mkEngine, sessions, session, SID, CID, P, FISH, LINK, SPARE, R5, R7,
    notices, obs, readCache, writeCache, login,
    stampWindow: (id, win) => stampWindow(cacheDir, id, win),
    readWindow: (id) => readWindow(cacheDir, id),
    linkNow: () => am.poolCurrentFor(P, SID),
    // the producers, driven for real
    reading: (u = 0.42, opts = {}) => eng.recordRateLimitEvent(session, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: u, resets_at: opts.resetsAt ?? R7, resetsAt: opts.resetsAt ?? R7 } }),
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
  // ── §5b THE CROSSING LEG (integration r2, a REPRODUCED merge-only defect).
  // The two halves above were each pinned alone: "healthyPoolMembers drops the
  // dead member" here, "decidePoolSwitch says all-logins-expired" in
  // test-login-expiry — and NOTHING ran healthyPoolMembers → decidePoolSwitch
  // → poolBlockedNotice end to end. So a candidate list that pre-filtered the
  // login-dead members deleted the very evidence the notice is built from
  // (`loginBlocked` holds the members the DECISION was shown), and the pool's
  // refusal silently degraded from "Re-login those accounts in Manage Agents"
  // to the quota remedy "wait until a window resets" — the exact defect
  // 2.369.67 shipped to fix — with both suites green.
  // The assertion is therefore on the SERVER NOTICE STRING, nothing smaller.
  {
    const dead = (id) => CREDS(id, { expiresAt: now - 10000, refreshExpiresAt: now - 5000 });
    // access token expired and NO refresh token: only src/login-state.js can
    // see this one (login-expiry finds no deadline ⇒ 'unknown' = no claim),
    // and parseAuth still reports loggedIn:true
    const fileOnlyDead = (id) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok-' + id, refreshToken: '', expiresAt: now - 10000, subscriptionType: 'max' } });
    const spent = (w2, id) => w2.writeCache(id, { fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: 0.99, resetsAt: w2.R5 }, sevenDay: { utilization: 0.5, resetsAt: w2.R7 } });
    const blocked = (w2) => { const cap = quiet(); w2.am.updatePool(w2.P, { auto: true }); w2.eng.maybePoolAutoSwitchForPool(w2.P); cap.done(); return w2.notices.join(' | '); };

    const w5 = mkWorld();
    spent(w5, w5.LINK); // the current member is quota-dead, so a switch is wanted
    for (const id of [w5.FISH, w5.SPARE]) fs.writeFileSync(path.join(w5.am.subDir(id), '.credentials.json'), dead(id));
    const n5 = blocked(w5);
    ok('§5b the pool NAMES the login wall end to end (healthyPoolMembers → decidePoolSwitch → poolBlockedNotice), not a spent quota bucket',
      /Re-login those accounts in Manage Agents/.test(n5) && n5.includes('Fish Max') && n5.includes('B-Stack Max'), n5);
    ok('§5b …and does NOT prescribe the quota remedy for a wall the user clears in 30 seconds',
      !/until a window resets/.test(n5), n5);

    // NEGATIVE CONTROL ①: every login healthy, every member out of quota ⇒ the
    // quota sentence, and the word re-login must NOT appear.
    const w6 = mkWorld();
    for (const id of [w6.LINK, w6.FISH, w6.SPARE]) spent(w6, id);
    const n6 = blocked(w6);
    ok('§5b NEG ① an all-quota-dead pool keeps the quota sentence and never says re-login',
      /until a window resets/.test(n6) && !/[Rr]e-login/.test(n6), n6);

    // NEGATIVE CONTROL ②: the member only the FILE reader can call dead. The
    // naming must not cost the exclusion — it must still never become a
    // target, and it must be named too (this is why the second verdict is
    // folded into poolReadLogin instead of pre-filtering the list).
    const w7 = mkWorld();
    spent(w7, w7.LINK);
    fs.writeFileSync(path.join(w7.am.subDir(w7.FISH), '.credentials.json'), fileOnlyDead(w7.FISH));
    fs.writeFileSync(path.join(w7.am.subDir(w7.SPARE), '.credentials.json'), dead(w7.SPARE));
    ok('§5b NEG ② the file-only-dead shape is invisible to the deadline reader…',
      w7.am.loginStateOf(w7.FISH).state === 'unknown' && w7.eng.memberLoginState(w7.FISH).usable === false);
    ok('§5b NEG ② …but poolReadLogin folds BOTH readers, so the decision still excludes it',
      w7.eng.poolReadLogin()(w7.FISH).state === 'expired');
    const n7 = blocked(w7);
    ok('§5b NEG ② …the pool did NOT move onto it, and the notice names it', w7.am.poolCurrent(w7.P) === w7.LINK && n7.includes('Fish Max') && /Re-login/.test(n7), n7);

    // …and the two lists stay two different questions: DECIDE sees the dead
    // members (so it can name them), ACT never does.
    const w8 = mkWorld();
    for (const id of [w8.FISH, w8.SPARE]) fs.writeFileSync(path.join(w8.am.subDir(id), '.credentials.json'), dead(id));
    ok('§5b switchCandidates (decide) shows the login-dead members; healthyPoolMembers (act) does not',
      w8.eng.switchCandidates(w8.P).length === 3 && w8.eng.healthyPoolMembers(w8.P).length === 1, JSON.stringify({ decide: w8.eng.switchCandidates(w8.P).length, act: w8.eng.healthyPoolMembers(w8.P).length }));
    // WIRING PIN: the pure-list fix is worthless if the engine's decision site
    // goes back to the act list (the 2.355.0 unstaged-wiring class).
    const engSrc = code('src/server/usage-pool-engine.js');
    ok('§5b WIRING: maybePoolAutoSwitchForPool decides on switchCandidates, and the act sites keep healthyPoolMembers',
      /const members = switchCandidates\(poolId\)/.test(engSrc) && /const alive = healthyPoolMembers\(poolId\)/.test(engSrc), '');
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
  const smeta = path.join(dataDir, 'session-meta');
  for (const p of [subs, cache, anchors, hist, smeta]) fs.mkdirSync(p, { recursive: true });
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

  // TWO NAMESPACES, as on disk (2026-09-07 r3): the ledger is keyed by the
  // WEBUI session key (`sess-<seq>-<ms>` — what ensureSessionPoolLink is called
  // with) and attribution by the CLAUDE conversation id (a UUID). session-meta
  // (`cw-<seq>-<ms>.json`) is the join. The r2 fixture used ONE id for both and
  // could therefore never fail the way production did (the winId-vs-id class).
  const KEY2 = 'sess-2-' + (AFTER - 86400e3);
  fs.writeFileSync(path.join(smeta, 'cw-2-' + (AFTER - 86400e3) + '.json'), JSON.stringify({ claudeSessionId: 'conv-2', accountId: 'pool-1', backend: 'claude' }));
  fs.writeFileSync(path.join(smeta, 'cw-1-' + (AFTER - 86400e3) + '.json'), JSON.stringify({ claudeSessionId: 'conv-1', accountId: 'pool-1', backend: 'claude' }));
  // the transition ledger knows where conv-2 really was (the recorded case);
  // conv-1 is joinable but has NO row (the historical case)
  const tr = new SlotTransitions({ dataDir });
  tr.record({ sessionId: KEY2, poolId: 'pool-1', from: DEAD, to: LIVE, at: AFTER - 60000, why: 'per-session-switch' });

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
  // §9b THE LAW INDEX IS A SOURCE PIN TOO (integration r2, a reproduced
  // merge-only doc regression). CLAUDE.md is auto-loaded and its routing table
  // is what gates the NEXT change to this subsystem, so a superseded paragraph
  // there outranks any essay that contradicts it. The Pool/billing row is ONE
  // 3.3 KB line, so a hand-merge that keeps "both sides verbatim" resurrects
  // the refuted rule SUB-LINE, where a lost/resurrected-LINE check sees
  // nothing. Pinned against the code that refutes it, not against a snapshot:
  // the row may not claim the observed org still routes VALUES while
  // readingSlotFor is what every value producer calls.
  {
    const md = read('CLAUDE.md');
    const row = md.split('\n').find((l) => /^\|\s*\*\*Pool\/billing decisions\*\*/.test(l)) || '';
    ok('§9b the Pool/billing routing row exists and is one well-formed 3-cell row', !!row && row.split('|').length === 5, String(row.length));
    const REFUTED = /quota VALUES keep the observed-org routing/;
    ok('§9b …and it does NOT still say the observed org routes quota VALUES (the rule this chain deleted from the code)', !REFUTED.test(row), row.slice(0, 200));
    ok('§9b …while the rule that REPLACED it is stated there', /EVERY reading AND every rejection is attributed to the credential SLOT/.test(row) && /readingSlotFor/.test(row));
    // the CODE half of the same claim — the doc is wrong precisely because the
    // engine routes every value through the slot and the OTel override is dead
    const engSrc = code('src/server/usage-pool-engine.js');
    ok('§9b …and the engine agrees: values go through readingSlotFor, nothing keys on the observation', /readingSlotFor\(/.test(engSrc) && !/\borgVerifiedKey\b/.test(engSrc) && !/setTruthLookup\s*\(/.test(code('server.js')));
    // NEGATIVE CONTROL: the pin can SEE the refuted sentence when it is there
    // (this is the leg the merge defeated — a line-granularity check reports
    // zero resurrected lines with the paragraph present).
    ok('§9b NEGATIVE CONTROL: the same predicate fails on the pre-fix row text', (() => {
      const prefix = row.slice(0, 1331);
      const resurrected = prefix + "**A REJECTION is attributed to the credential SLOT (the token-slot-validated link), never to the OTel-observed org — that names the identity the CLI cached at SPAWN (2026-09-07 loop incident); quota VALUES keep the observed-org routing.** " + row.slice(1331);
      return REFUTED.test(resurrected) && resurrected.split('|').length === 5;
    })());
    // …and the historical ESSAY is deliberately allowed to keep the refuted
    // rule (it narrates round 1 keeping it and round 2 finishing it) — a pin
    // that also banned the record would delete the history.
    // (and it narrates it in the PAST tense — "kept", not "keep" — which is
    // exactly the difference between a record and a rule)
    ok('§9b …and the kb ESSAY may still narrate the refuted rule as history, in the past tense', /Round 1 \(2\.369\.66\) changed only the CONSUMER:/.test(read('docs/kb-file-structure.md')) && /quota VALUES kept the observed-org routing/.test(read('docs/kb-file-structure.md')));
    // The SAME rule for the 2026-09-08 half: the auto-loaded index is what gates
    // the NEXT change to this subsystem, so the row must carry the rule the code
    // now runs, and the file index must name the module that holds it.
    ok('§9b the routing row also states the rule THIS change added (the window outranks the bookkeeping)',
      /LAG SHADOW/.test(row) && /WINDOW IDENTITY GUARD/.test(row) && /reading-lag\.js/.test(row) && /NO EVIDENCE ⇒ NO REFUSAL/.test(row), row.slice(-320));
    ok('§9b …including the two properties a later edit is most likely to drop: the PHASE comparison, and that `ownWindow` is stamped and never read back out of `sevenDay.resetsAt`',
      /resetsAt mod 604800/.test(row) && /NEVER read back out of `sevenDay\.resetsAt`/.test(row));
    ok('§9b …and the file index names the PURE module beside the ledger it works with', /^  reading-lag\.js — PURE \(imports nothing\)/m.test(md));
    // r2: the auto-loaded index gates the NEXT change, so it must carry the two
    // rules round 2 established — WHICH HALF of a window identifies an account,
    // and WHERE the established window may be kept. Both are the kind of thing
    // a later edit "simplifies" back, and each one cost a reproduced incident.
    ok('§9b …and the two rules ROUND 2 established: the weekly half is the only identity evidence (a 5h window names a TIME), and the established window lives in a sidecar no reading producer writes',
      /WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE/.test(row) && /FIVE-HOUR window names a TIME/.test(row)
      && /ESTABLISHED WINDOW LIVES IN A SIDECAR/.test(row) && /\.window-<key>/.test(row)
      && /NOT a field of the usage-cache snapshot/.test(row), row.slice(-400));
    ok('§9b NEGATIVE CONTROL: those predicates fail on the row as ROUND 1 left it (they are not matching prose that was already there)',
      (() => {
        const r1 = row.replace(/\*\*THE WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE\*\*[\s\S]*?The statusline carries a byte-identical MIRROR/,
          'A weekly window is an ACCOUNT FINGERPRINT compared by its PHASE (`resetsAt mod 604800`, ±120s) because a roll adds exactly one week. `cache.ownWindow` is STAMPED AT THE WRITE by the one producer whose key and credential dir are the same decision (refreshViaCliPanel) and NEVER read back out of `sevenDay.resetsAt`; every session-attributed writer PRESERVES it. The statusline carries a byte-identical MIRROR');
        return r1.length < row.length
          && !/WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE/.test(r1) && !/ESTABLISHED WINDOW LIVES IN A SIDECAR/.test(r1)
          // …while the ROUND 1 properties this row also pins are still there,
          // so the control differs in exactly the dimension it names
          && /resetsAt mod 604800/.test(r1) && /NEVER read back out of `sevenDay\.resetsAt`/.test(r1);
      })());
    ok('§9b NEGATIVE CONTROL: the same predicates fail on the row as it stood before this change (they are not matching prose that was always there)',
      // the terminus moves with the chain: every later round appends to the
      // SAME block, so this control strips through whatever the last one ended
      // with (r4: "…AFTER the guard chose the key.**") and must still remove
      // strictly more than nothing, or it has silently stopped applying.
      (() => { const before = row.replace(/\*\*AND THE READING IS EVIDENCE ABOUT ITSELF[\s\S]*?AFTER the guard chose the key\.\*\* /, ''); return !/LAG SHADOW/.test(before) && !/reading-lag\.js/.test(before) && !/PER BUCKET/.test(before) && before.length < row.length; })());
    // r3: the two rules THIS round established are exactly the kind a later edit
    // "simplifies" back — one of them is a single line's POSITION, the other is
    // which of two clocks a shipped single file is allowed to believe.
    ok('§9b …and the two rules ROUND 3 established: the clock ranks BELOW the windows (a proxy may not overrule what it stands for, and an unknown age does not expire), and the statusline dates the RE-POINT from the link the pool re-mints — never from its own last observation',
      /THE CLOCK RANKS BELOW THE WINDOWS/.test(row) && /`repointAgeMs == null` is UNKNOWN/.test(row)
      && /lstat\(link\)\.mtimeMs`? IS that instant/.test(row) && /systematically OLDER than the re-point/.test(row)
      && /AND THE STATUSLINE RUNS THE GUARD/.test(row) && /\.window-refused\.ndjson/.test(row), row.slice(-900));
    ok('§9b NEGATIVE CONTROL: those predicates fail on the row as ROUND 2 left it (they are not matching prose that was already there)',
      (() => {
        const r2 = row.replace(/\*\*THE CLOCK RANKS BELOW THE WINDOWS\*\*[\s\S]*?nothing is written anywhere\)\. /, '');
        return r2.length < row.length
          && !/THE CLOCK RANKS BELOW THE WINDOWS/.test(r2) && !/AND THE STATUSLINE RUNS THE GUARD/.test(r2)
          // …while the ROUND 1+2 properties this row also pins are still there
          && /WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE/.test(r2) && /ESTABLISHED WINDOW LIVES IN A SIDECAR/.test(r2)
          && /resetsAt mod 604800/.test(r2);
      })());
    // r4: the rule most likely to be "simplified" back is the one that reads as
    // an optimisation — deciding a record once instead of once per bucket.
    ok('§9b …and the rule ROUND 4 established: the repair moves PER BUCKET (the {5h,7d} primary half decides where the record goes; every other bucket is archived with its own reason), and "no evidence ⇒ no refusal" governs REFUSING TO WRITE, not MOVING',
      /THE REPAIR MOVES PER BUCKET, NEVER WHOLESALE/.test(row) && /ONE BUCKET AT A TIME/.test(row)
      && /the PRIMARY half is `\{5h,7d\}`/.test(row) && /governs REFUSING TO WRITE, not MOVING/.test(row)
      && /preserve-merges the previous scoped bucket/.test(row), row.slice(-900));
    ok('§9b NEGATIVE CONTROL: that predicate fails on the row as ROUND 3 left it (it is not matching prose that was already there)',
      (() => {
        const r3 = row.replace(/\*\*AND THE REPAIR MOVES PER BUCKET, NEVER WHOLESALE[\s\S]*?AFTER the guard chose the key\.\*\* /, '');
        return r3.length < row.length
          && !/THE REPAIR MOVES PER BUCKET/.test(r3) && !/ONE BUCKET AT A TIME/.test(r3)
          // …while every earlier round's properties this row pins are still there
          && /THE CLOCK RANKS BELOW THE WINDOWS/.test(r3) && /AND THE STATUSLINE RUNS THE GUARD/.test(r3)
          && /WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE/.test(r3);
      })());
    // r5: the rule most likely to be "simplified" back is the one that reads
    // like bookkeeping — which KEY the cache half iterates. It is the whole
    // difference between arming the live guard on an identity and arming it on
    // one of that identity's two files.
    ok('§9b …and the two rules ROUND 5 established: an identity can hold MORE THAN ONE cache file (so the cache half enumerates the files the product accepts, and the `acct:` rung is the only one that may ask the streams), and a bucket\'s fate is decided on the RECORD\'s buckets, not on the dated view of them',
      /AND AN IDENTITY CAN HOLD MORE THAN ONE CACHE FILE/.test(row) && /keyed on the FILES the product accepts/.test(row)
      && /structurally inert on it/.test(row) && /re-poisoned the just-cleaned stream on the next tick/.test(row)
      && /documented LAST RESORT/.test(row) && /a PSEUDO key never/.test(row)
      && /A BUCKET'S FATE IS DECIDED ON THE RECORD'S BUCKETS/.test(row) && /counted PARTIAL/.test(row), row.slice(-1200));
    ok('§9b NEGATIVE CONTROL: those predicates fail on the row as ROUND 4 left it (they are not matching prose that was already there)',
      (() => {
        const r4 = row.replace(/\*\*AND AN IDENTITY CAN HOLD MORE THAN ONE CACHE FILE[\s\S]*?never a drop line\.\*\*/, '');
        return r4.length < row.length
          && !/AN IDENTITY CAN HOLD MORE THAN ONE CACHE FILE/.test(r4) && !/A BUCKET'S FATE IS DECIDED ON THE RECORD'S BUCKETS/.test(r4)
          // …while every earlier round's properties this row pins are still there
          && /THE REPAIR MOVES PER BUCKET/.test(r4) && /THE CLOCK RANKS BELOW THE WINDOWS/.test(r4)
          && /WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE/.test(r4);
      })());
    // r6: the rule most likely to be dropped is the one that reads like an
    // implementation detail of r5 — that the DIRECTORY is not every file.
    ok('§9b …and the rule ROUND 6 established: the `__global__` key has a SECOND snapshot outside the directory (`data/usage-cache.json`), judged by the directory half\'s own answer, archived-then-UNLINKED rather than mirrored, and reported as its own state',
      /AND THE `__global__` KEY HAS A SECOND SNAPSHOT, OUTSIDE THAT DIRECTORY/.test(row)
      && /USAGE_CACHE_FILE/.test(row) && /newest-wins merge/.test(row)
      && /never a second `identityKeyFor` over that payload/.test(row)
      && /UNLINKED, not mirrored/.test(row) && /globalFile: clean \/ archived \/ unresolvable \/ absent/.test(row)
      && /STANDING SWEEP derives the persisted-snapshot ROOTS from the source/.test(row), row.slice(-1400));
    ok('§9b NEGATIVE CONTROL: that predicate fails on the row as ROUND 5 left it (it is not matching prose that was already there)',
      (() => {
        const r5 = row.replace(/ \*\*AND THE `__global__` KEY HAS A SECOND SNAPSHOT, OUTSIDE THAT DIRECTORY[\s\S]*?to judge or seed it with\.\*\*/, '');
        return r5.length < row.length
          && !/SECOND SNAPSHOT, OUTSIDE THAT DIRECTORY/.test(r5) && !/globalFile: clean \/ archived/.test(r5)
          // …while every earlier round's properties this row pins are still there
          && /AN IDENTITY CAN HOLD MORE THAN ONE CACHE FILE/.test(r5) && /THE REPAIR MOVES PER BUCKET/.test(r5)
          && /WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE/.test(r5);
      })());
  }
}

// ── §11 ROUND 2: the six defects the adversarial verifier reproduced ────────
// Every leg drives the REAL producer / the REAL merge / the REAL migration,
// and carries a negative control that fails without the fix.

// (a) MAJOR — a REMOTE CODEX reading was routed into the HOST'S CLAUDE bucket.
//     `usageCacheKeyFor`'s first rule ("a remote session with no account →
//     host-<id>") is a CLAUDE fact: usage-routes seeds _hostUsage from those
//     files, the remote statusline harvest writes the host's `__global__`
//     into them and the Agents machine rows render them. Codex remote chat is
//     supported (ws-create "codex remote chat rides the SAME keeper") and its
//     stdout consumer calls recordCodexQuotaSignal with no host gate, so once
//     readings started sharing ONE resolver the codex snapshot began
//     OVERWRITING the host's claude numbers — and disappearing from codex's
//     own panel, whose disk seed only matches cxs-* / __global_codex__.
{
  const w = mkWorld(); const cap = quiet();
  const remoteClaude = { backend: 'claude', mode: 'chat', host: 'h1', _accountId: null, _webuiId: 'sess-cl-h1', claudeSessionId: 'cid-cl-h1', pty: { write() { } } };
  const remoteCodex = { backend: 'codex', mode: 'chat', host: 'h1', _accountId: null, _webuiId: 'sess-cx-h1', claudeSessionId: 'cid-cx-h1', pty: { write() { } } };
  w.sessions.set('sess-cl-h1', remoteClaude); w.sessions.set('sess-cx-h1', remoteCodex);
  // ① the host's own claude login reports its quota (the file's ONE meaning)
  w.eng.recordRateLimitEvent(remoteClaude, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.11, resets_at: w.R7, resetsAt: w.R7 } });
  const hostFile = path.join(w.cacheDir, 'host-h1.json');
  // age it a minute: the codex snapshot below carries `fetchedAt: now`, and
  // its writer only overwrites a STRICTLY OLDER file — two writes inside the
  // same millisecond would make this leg pass for the wrong reason.
  try { const j = JSON.parse(fs.readFileSync(hostFile, 'utf8')); j.fetchedAt -= 60000; fs.writeFileSync(hostFile, JSON.stringify(j)); } catch { }
  const hostBefore = fs.existsSync(hostFile) ? fs.readFileSync(hostFile, 'utf8') : null;
  ok('§11a a REMOTE CLAUDE session with no account still fills the HOST bucket (2.289.0, unchanged)', !!hostBefore && Math.abs(JSON.parse(hostBefore).sevenDay.utilization - 0.11) < 1e-9, String(hostBefore).slice(0, 120));
  // ② the same host runs a codex session
  w.codexReading(remoteCodex);
  const hostAfter = fs.existsSync(hostFile) ? fs.readFileSync(hostFile, 'utf8') : null;
  const cxFile = path.join(w.cacheDir, '__global_codex__.json');
  const cx = (() => { try { return JSON.parse(fs.readFileSync(cxFile, 'utf8')); } catch { return null; } })();
  cap.done();
  ok('§11a …and a REMOTE CODEX reading lands on the codex machine identity', !!cx && cx.limitId === 'codex' && Math.abs(cx.sevenDay.utilization - 0.3) < 1e-9, JSON.stringify(cx && { l: cx.limitId, s: cx.sevenDay }));
  ok('§11a …leaving the host\'s CLAUDE bucket byte-identical (that file has exactly one meaning everywhere it is read)', hostAfter === hostBefore, `${String(hostBefore).slice(0, 80)} → ${String(hostAfter).slice(0, 80)}`);
  // NEGATIVE CONTROL: the pre-fix rule, applied to the very same session,
  // names the file we just proved untouched.
  const preFixKey = (s2) => (s2.host && !s2._accountId) ? 'host-' + s2.host : (s2._accountId || '__global__');
  ok('§11a NEGATIVE CONTROL: the pre-fix host rule sends that codex snapshot to host-h1 — the claude file, with codex numbers and no `source`', preFixKey(remoteCodex) === 'host-h1' && w.eng.readingSlotFor(remoteCodex).key === '__global_codex__', `pre-fix=${preFixKey(remoteCodex)} now=${w.eng.readingSlotFor(remoteCodex).key}`);
  ok('§11a …and the reading resolver agrees with the un-pinned codex twin again (readingSlotFor vs codexQuotaKeyFor, which noteWallSignal uses on the same session)', w.eng.readingSlotFor(remoteCodex).key === '__global_codex__' && w.eng.resolveUsageKey(remoteCodex) === '__global_codex__');
  // the codex panel's disk seed must actually be able to see it
  const seedLine = read('src/usage-routes.js').split('\n').find((l) => /exec\(fn\)/.test(l) && /cxs/.test(l));
  const lit = seedLine && seedLine.match(/\/(\^\(cxs[^/]+)\//);
  const seedRe = lit ? new RegExp(lit[1]) : null;
  ok('§11a …so the codex panel\'s own disk seed can read it (a host-<id> file would be invisible to it)', !!seedRe && seedRe.test('__global_codex__.json') && !seedRe.test('host-h1.json'), String(seedLine).trim().slice(0, 120));
  // …and the rule is a TRANSFORM OF THE ANSWER, not a backend test: every
  // machine identity except the claude one passes through, so a third harness
  // keeps whatever key it already had (a `backend === 'claude'` spelling would
  // have silently moved remote OpenCode/ACP sessions off the host bucket).
  const remoteAcp = { backend: 'opencode', mode: 'chat', host: 'h1', _accountId: null, _webuiId: 'sess-oc-h1', pty: { write() { } } };
  ok('§11a a THIRD backend\'s remote session is untouched by the fix (it resolves to the claude machine identity today, so it keeps the host bucket it always had)', w.eng.readingSlotFor(remoteAcp).key === 'host-h1', w.eng.readingSlotFor(remoteAcp).key);
}

// (b) MEDIUM — the DAEMON's sealed-orders reflex re-points a credential link
//     while this server is DOWN (agentd `_execute` → repointPoolSymlink,
//     deliberately bypassing accounts.js). It left no ledger row, so slotAt()
//     answered with the last ORCHESTRATOR transition: a confident WRONG
//     answer in the exact window where late attribution has nothing else.
{
  const evs = [];
  let acked = false;
  const dm = {
    poolOrders: async (orders, cb) => { evs.push(orders); if (cb) cb(dm._events || []); },
    ackPoolOrdersLog: () => { acked = true; },
  };
  const w = mkWorld({ hosts: { device: async () => dm } });
  const st = w.am.slotTransitions;
  const link = w.am.sessionPoolLinkPath(w.P, w.SID);
  const at = Date.now() + 5000; // the device executed it "later" than the spawn row
  // BEFORE: the ledger's answer for that instant is the last row WE wrote
  ok('§11b NEGATIVE CONTROL: with no row for the device-executed switch the ledger answers with the ORCHESTRATOR\'s last transition — confidently WRONG, not "unknown"', st.slotAt(w.SID, at).id === w.LINK, JSON.stringify(st.slotAt(w.SID, at)));
  dm._events = [{ ts: at, poolId: w.P, sid: w.SID, banner: 'fiveHour', from: w.am.subDir(w.LINK), to: w.SPARE, link }];
  const cap = quiet();
  await w.eng.pushSealedOrders(w.P);
  cap.done();
  const row = st.all().find((r) => r.at === at);
  ok('§11b the reconcile callback RECORDS every device-executed re-point (accounts.js still the single writer)', !!row && row.to === w.SPARE && row.from === w.LINK && row.sessionId === w.SID && row.why === 'sealed-orders', JSON.stringify(row));
  ok('§11b …so slotAt() moves at the instant the DEVICE acted', st.slotAt(w.SID, at).id === w.SPARE && st.slotAt(w.SID, at - 1).id === w.LINK, JSON.stringify(st.slotAt(w.SID, at)));
  ok('§11b …and the pending-report ack still runs', acked === true && evs.length === 1);
  // a re-delivered log (crash between report and ack) is ONE fact
  const n = st.all().length;
  ok('§11b a REPLAYED device log does not duplicate the row (the daemon clears its log only on ack, and the in-memory dedup dies with the process)', w.am.noteDeviceRepoint({ link, poolId: w.P, from: w.am.subDir(w.LINK), to: w.SPARE, at }) === null && st.all().length === n);
  // the POOL DEFAULT link moving decides for every session without one
  const at2 = at + 60000;
  w.am.noteDeviceRepoint({ link: w.am.subDir(w.P), poolId: w.P, from: w.am.subDir(w.SPARE), to: w.FISH, at: at2 });
  ok('§11b …and a move of the pool DEFAULT link is recorded as the default (sessionId null), so it answers for sessions with no link of their own', st.slotAt('some-other-session', at2, { poolId: w.P }).scope === 'default' && st.slotAt('some-other-session', at2, { poolId: w.P }).id === w.FISH, JSON.stringify(st.slotAt('some-other-session', at2, { poolId: w.P })));
  ok('§11b an unresolvable `from` is left null, never guessed (the daemon reports a PATH, the ledger stores ids)', (() => {
    const at3 = at2 + 60000;
    w.am.noteDeviceRepoint({ link, poolId: w.P, from: '/somewhere/sub-not-an-account', to: w.LINK, at: at3 });
    const r = st.all().find((x) => x.at === at3);
    return !!r && r.from === null && r.to === w.LINK;
  })());
}

// (c) MEDIUM — when the migration archives the ONLY attribution entry of a
//     conversation, the baked ledger events kept the refuted account FOREVER:
//     UsageHistory's re-bake deliberately skips a sid with no attribution
//     entries ("the baked value is the only record we have"), which stopped
//     being true the moment the repair emptied it.
{
  const DEADX = 'sub-dead0000', LIVEX = 'sub-live0000';
  const WIPE = Date.parse('2026-09-03T05:55:00Z'), AFTER2 = Date.parse('2026-09-07T06:30:00Z');
  const mkRebakeFixture = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rebake-')); cleanup.push(d);
    const dataDir = path.join(d, 'data');
    for (const p2 of ['subs/' + DEADX, 'usage-cache', 'usage-history', 'session-meta']) fs.mkdirSync(path.join(dataDir, p2), { recursive: true });
    const cp = path.join(dataDir, 'subs', DEADX, '.credentials.json');
    fs.writeFileSync(cp, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }));
    fs.utimesSync(cp, WIPE / 1000, WIPE / 1000);
    const hist = path.join(dataDir, 'usage-history');
    // conv-X: its ONLY entry is on the dead account (the old OTel corrective
    // record fired whenever the observation disagreed with attribAt, which
    // answers acct:null for a sid with no entries — so a conversation's FIRST
    // and only entry could be a corrective one).
    // conv-Y: keeps an entry (the ordinary re-bake path).
    // conv-Z: never had one (the deliberate "leave it" rule).
    fs.writeFileSync(path.join(hist, 'attribution.ndjson'), [
      { sid: 'conv-X', acct: DEADX, pool: 'pool-1', ts: AFTER2 },
      { sid: 'conv-Y', acct: LIVEX, pool: 'pool-1', ts: WIPE - 3600e3 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(hist, 'events-2026-09.ndjson'), [
      { ts: AFTER2, sid: 'conv-X', acct: DEADX, atype: 'subscription', aname: 'Personal', model: 'm', cost: 1 },
      { ts: AFTER2, sid: 'conv-Y', acct: LIVEX, atype: 'subscription', aname: 'Live', model: 'm', cost: 1 },
      { ts: AFTER2, sid: 'conv-Z', acct: 'sub-zzz', atype: 'subscription', aname: 'Z', model: 'm', cost: 1 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(hist, '.attrib-rebake-v1'), '{}');
    // session-meta: conv-X was created under the LIVE account — the
    // un-refuted fallback the archive exists to expose
    fs.writeFileSync(path.join(dataDir, 'session-meta', 'sess-x.json'), JSON.stringify({ claudeSessionId: 'conv-X', accountId: LIVEX, backend: 'claude' }));
    return { dataDir, hist };
  };
  const runRepairAndRebake = ({ dataDir, hist }, { dropEmptiedList = false } = {}) => {
    const cap = quiet();
    repair.repairReadings({ dataDir, members: [{ id: DEADX, credsPath: path.join(dataDir, 'subs', DEADX, '.credentials.json') }], transitions: new SlotTransitions({ dataDir }), id: 'T3' });
    if (dropEmptiedList) { try { fs.unlinkSync(path.join(hist, '.attrib-emptied.json')); } catch { } }
    const UH = require(path.join(REPO, 'src/usage-history.js')).UsageHistory;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rebake-home-')); cleanup.push(home);
    const uh = new UH({ dataDir, homeDir: home, resolveAccount: (id) => (id === LIVEX ? { type: 'subscription', name: 'Live' } : null) });
    uh._maybeRebakeAttribution();
    cap.done();
    return fs.readFileSync(path.join(hist, 'events-2026-09.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  };
  const fixed = mkRebakeFixture();
  const evAfter = runRepairAndRebake(fixed);
  const x = evAfter.find((e) => e.sid === 'conv-X');
  ok('§11c an event whose conversation LOST its only attribution entry is re-baked off the refuted account…', x.acct === LIVEX && x.aname === 'Live', JSON.stringify(x));
  ok('§11c …onto the session-meta account, which is the un-refuted record we still hold', JSON.parse(fs.readFileSync(path.join(fixed.dataDir, 'session-meta', 'sess-x.json'), 'utf8')).accountId === LIVEX);
  ok('§11c …the repair NAMES those conversations for the re-bake (a list that stays true, so any later generation inherits it)', JSON.parse(fs.readFileSync(path.join(fixed.hist, '.attrib-emptied.json'), 'utf8')).includes('conv-X'));
  ok('§11c a conversation that KEEPS an entry still re-bakes the ordinary way', evAfter.find((e) => e.sid === 'conv-Y').acct === LIVEX);
  ok('§11c …and one that NEVER had an entry is left exactly as it was (the deliberate rule this fix does not widen)', (() => { const z = evAfter.find((e) => e.sid === 'conv-Z'); return z.acct === 'sub-zzz' && z.aname === 'Z'; })());
  // NEGATIVE CONTROL: the same repair, the same re-bake, without the list
  const ctl = mkRebakeFixture();
  const evCtl = runRepairAndRebake(ctl, { dropEmptiedList: true });
  ok('§11c NEGATIVE CONTROL: without the emptied list the re-bake skips that sid and the event keeps the refuted account forever', evCtl.find((e) => e.sid === 'conv-X').acct === DEADX, JSON.stringify(evCtl.find((e) => e.sid === 'conv-X')));
  ok('§11c …and the attribution store really was emptied for it (so "clear the marker and re-bake" could never have reached it)', !fs.readFileSync(path.join(ctl.hist, 'attribution.ndjson'), 'utf8').includes('conv-X'));
}

// (d) MEDIUM — a wiped local credential dir is NOT "this account cannot
//     produce readings": with a valid long-lived token (B-211a) the account
//     spawns (`oatOnly`) and its readings are its own. The repair archived
//     every one of them and rewound the panel.
{
  const now = Date.now();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oat-')); cleanup.push(d);
  const wf = (name, body, mtime) => { const f = path.join(d, name); fs.writeFileSync(f, body); if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000); return f; };
  const WIPED_AT = now - 5 * 86400e3;
  const wiped = wf('w.json', JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }), WIPED_AT);
  ok('§11d the FILE reader is unchanged: a wiped dir is wiped', loginState(wiped, { now }).state === 'wiped' && loginState(wiped, { now }).usable === false);
  const withOat = accountLoginState(wiped, { now, oatMintedAt: now - 86400e3 });
  ok('§11d the ACCOUNT reader says the account is usable through its long-lived token', withOat.state === 'oat' && withOat.usable === true && withOat.since === null, JSON.stringify(withOat));
  const deadOat = accountLoginState(wiped, { now, oatMintedAt: now - (OAT_TTL_MS + 86400e3) });
  ok('§11d …and when BOTH channels are dead it dies at the LATER instant, never the earlier one', deadOat.usable === false && deadOat.since === Math.max(Math.round(fs.statSync(wiped).mtimeMs), now - 86400e3), JSON.stringify(deadOat));
  ok('§11d …an oat also DATES an account whose dir was never there at all ("missing" has no mtime to speak with)', (() => {
    const st2 = accountLoginState(path.join(d, 'nope.json'), { now, oatMintedAt: now - (OAT_TTL_MS + 3600e3) });
    return st2.usable === false && st2.since === now - 3600e3;
  })());
  ok('§11d …and with no token at all it is byte-for-byte the file answer (one predicate, no second opinion)', JSON.stringify(accountLoginState(wiped, { now })) === JSON.stringify(loginState(wiped, { now })));
  ok('§11d the TTL has ONE definition — accounts.js reads it from login-state (a second copy is a twin that expires on a different day)', probe.am.OAT_TTL_MS === OAT_TTL_MS && OAT_TTL_MS > 0);

  // the MIGRATION, end to end: an oat-only member's stores must not be touched
  const mkOatFixture = ({ oatMintedAt }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oatmig-')); cleanup.push(root);
    const dataDir = path.join(root, 'data');
    const OAT = 'sub-oatonly00';
    for (const p2 of ['subs/' + OAT, 'usage-cache', 'usage-anchors', 'usage-history']) fs.mkdirSync(path.join(dataDir, p2), { recursive: true });
    const cp = path.join(dataDir, 'subs', OAT, '.credentials.json');
    fs.writeFileSync(cp, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }));
    fs.utimesSync(cp, WIPED_AT / 1000, WIPED_AT / 1000);
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: OAT, name: 'Token account', type: 'subscription', backend: 'claude', ...(oatMintedAt ? { oatEnc: 'x:y:z', oatMintedAt } : {}) }] }));
    // a FRESH reading it legitimately produced an hour ago, plus its anchors
    fs.writeFileSync(path.join(dataDir, 'usage-cache', OAT + '.json'), JSON.stringify({ fiveHour: { utilization: 0.42 }, sevenDay: { utilization: 0.61 }, fetchedAt: now - 3600e3, source: 'rate-limit-event', orgUuid: 'oat-org' }));
    fs.writeFileSync(path.join(dataDir, 'usage-anchors', 'anchors-org_oat.ndjson'), [
      { ts: WIPED_AT - 86400e3, fetchedAt: WIPED_AT - 86400e3, source: 'passive', accountId: OAT, identityKey: 'org:oat', buckets: { fiveHour: { u: 0.1 }, sevenDay: { u: 0.2 } }, prevFetchedAt: null, costSince: null },
      { ts: now - 3600e3, fetchedAt: now - 3600e3, source: 'passive', accountId: OAT, identityKey: 'org:oat', buckets: { fiveHour: { u: 0.42 }, sevenDay: { u: 0.61 } }, prevFetchedAt: WIPED_AT - 86400e3, costSince: { total: 3 } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(dataDir, 'usage-anchors', 'rates.json'), JSON.stringify({ 'org:oat': { computedAt: 1, nAnchors: 2, buckets: {} } }));
    fs.writeFileSync(path.join(dataDir, 'usage-history', 'attribution.ndjson'), JSON.stringify({ sid: 'conv-oat', acct: OAT, ts: now - 3600e3 }) + '\n');
    return { root, dataDir, OAT };
  };
  const runMigration = (root) => {
    const notes = [];
    const cap = quiet();
    const { MIGRATIONS } = require(path.join(REPO, 'src/server/migrations.js')).create({ rootDir: root, serverNotice: (k, t2) => notes.push(t2) });
    const m = MIGRATIONS.find((x) => x.id === '2026-09-reattribute-readings-by-slot');
    m.run();
    cap.done();
    return notes;
  };
  {
    const f = mkOatFixture({ oatMintedAt: now - 86400e3 });
    const before = fs.readFileSync(path.join(f.dataDir, 'usage-cache', f.OAT + '.json'), 'utf8');
    const anchorsBefore = fs.readFileSync(path.join(f.dataDir, 'usage-anchors', 'anchors-org_oat.ndjson'), 'utf8');
    const notes = runMigration(f.root);
    ok('§11d MIGRATION: an oat-only member\'s fresh reading survives (it really is that account\'s)', fs.readFileSync(path.join(f.dataDir, 'usage-cache', f.OAT + '.json'), 'utf8') === before, fs.readFileSync(path.join(f.dataDir, 'usage-cache', f.OAT + '.json'), 'utf8').slice(0, 120));
    ok('§11d …its anchors and the instance-wide learned rates survive too', fs.readFileSync(path.join(f.dataDir, 'usage-anchors', 'anchors-org_oat.ndjson'), 'utf8') === anchorsBefore && fs.existsSync(path.join(f.dataDir, 'usage-anchors', 'rates.json')));
    ok('§11d …its attribution entry survives, and nothing was archived', fs.readFileSync(path.join(f.dataDir, 'usage-history', 'attribution.ndjson'), 'utf8').includes('conv-oat') && !fs.existsSync(path.join(f.dataDir, 'archive')) && notes.length === 0);
  }
  {
    // NEGATIVE CONTROL: the very same fixture with NO token — every store IS
    // repaired, so the assertions above are not vacuous.
    const f = mkOatFixture({ oatMintedAt: null });
    runMigration(f.root);
    const after = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'usage-cache', f.OAT + '.json'), 'utf8'));
    ok('§11d NEGATIVE CONTROL: the identical fixture WITHOUT a token is repaired — cache rewound to the pre-wipe reading…', Math.abs(after.fiveHour.utilization - 0.1) < 1e-9 && after.fetchedAt === WIPED_AT - 86400e3, JSON.stringify(after));
    ok('§11d …the fresh anchor dropped, rates.json deleted, the attribution entry archived', fs.readFileSync(path.join(f.dataDir, 'usage-anchors', 'anchors-org_oat.ndjson'), 'utf8').trim().split('\n').length === 1 && !fs.existsSync(path.join(f.dataDir, 'usage-anchors', 'rates.json')) && !fs.readFileSync(path.join(f.dataDir, 'usage-history', 'attribution.ndjson'), 'utf8').includes('conv-oat'));
    // an EXPIRED token is dead again — the account really cannot produce now
    const f2 = mkOatFixture({ oatMintedAt: now - (OAT_TTL_MS + 86400e3) });
    runMigration(f2.root);
    ok('§11d …and an EXPIRED token gets the same treatment (a token that cannot spawn is not a channel)', JSON.parse(fs.readFileSync(path.join(f2.dataDir, 'usage-cache', f2.OAT + '.json'), 'utf8')).fetchedAt === WIPED_AT - 86400e3);
  }
  // the SLOT question deliberately does NOT inherit the token: a symlink
  // cannot deliver an env var to a running CLI.
  {
    const w2 = mkWorld();
    // a REAL long-lived token on the member the session's link points at…
    w2.am.setOat(w2.LINK, 'sk-ant-oat01-' + 'x'.repeat(48));
    fs.writeFileSync(path.join(w2.am.subDir(w2.LINK), '.credentials.json'), CREDS(w2.LINK, { wiped: true }));
    const acctSt = accountLoginState(w2.am.subCredsPath(w2.LINK), { oatMintedAt: (w2.am.list().accounts.find((a) => a.id === w2.LINK) || {}).oatMintedAt || null });
    ok('§11d …the ACCOUNT can still spawn and produce readings through that token', acctSt.usable === true && acctSt.state === 'oat', JSON.stringify(acctSt));
    const bm = w2.eng.sessionBillingMember(w2.session, w2.P);
    ok('§11d a POOL SLOT pointing at that same member never validates — an oat lives in accounts.json and rides spawn ENV, so re-pointing a link can never hand it to a RUNNING CLI (a wiped login is dropped by poolMembers before the state leg even runs; §5 pins the doubly-expired shape that reaches it)', bm.slotOk === false && bm.slotReason === 'slot-not-a-member', JSON.stringify(bm));
    ok('§11d …and the engine\'s reader is the FILE one, deliberately (making it account-aware would make a wiped member a valid switch TARGET)', /const st = memberLoginState\(linkedId\);/.test(read('src/server/usage-pool-engine.js')) && /loginState\(fp, \{ backend: 'claude' \}\)/.test(read('src/server/usage-pool-engine.js')) && /DELIBERATELY THE FILE, NOT THE ACCOUNT/.test(read('src/server/usage-pool-engine.js')));
  }
}

// (e) MINOR — `corroborated` is a verdict about ONE write. Both preserve-merge
//     writers inherited the previous producer's verdict, so a panel result
//     rendered as "via own /usage panel · not corroborated" — an old verdict
//     attached to a reading it does not describe, and for a session-less
//     producer there is nothing to corroborate WITH.
{
  const w = mkWorld(); const cap = quiet();
  w.writeCache(w.LINK, { ...w.readCache(w.LINK), source: 'rate-limit-event', corroborated: false, orgUuid: 'org-keep', orgName: 'Keep' });
  w.eng.writeUsageCacheForKey(w.LINK, { fiveHour: { utilization: 0.5 }, sevenDay: { utilization: 0.6 }, source: 'on-demand', fetchedAt: Date.now() });
  const merged = w.readCache(w.LINK);
  cap.done();
  ok('§11e a preserve-merge does NOT inherit the previous write\'s corroboration verdict', merged.corroborated === undefined && merged.source === 'on-demand', JSON.stringify({ c: merged.corroborated, s: merged.source }));
  ok('§11e …while it still preserves IDENTITY, which is a fact about the account rather than about one reading', merged.orgUuid === 'org-keep' && merged.orgName === 'Keep');
  ok('§11e …and a caller that DOES supply a verdict keeps it (undefined ⇒ delete is the rule captureRateLimitEvent states; an unconditional delete would be accept-and-ignore)', (() => {
    w.eng.writeUsageCacheForKey(w.LINK, { fiveHour: { utilization: 0.7 }, source: 'on-demand', fetchedAt: Date.now(), corroborated: true });
    return w.readCache(w.LINK).corroborated === true;
  })());
  // NEGATIVE CONTROL: a producer that DOES have an opinion still stamps it
  {
    const w2 = mkWorld(); const cap2 = quiet();
    w2.am.ensureSessionPoolLink(w2.P, w2.SID, w2.SPARE, { why: 'per-session-switch' }); // OTel still names FISH ⇒ divergence
    w2.reading(0.5); w2.endTurn();
    cap2.done();
    ok('§11e NEGATIVE CONTROL: a producer whose own write HAS a verdict still stamps it (the label is not being deleted, it is being un-inherited)', w2.readCache(w2.SPARE).corroborated === false);
  }
  // DRIFT GUARD: every preserve-merge writer of a usage-cache file must decide
  // the label for its own write.
  {
    // EXECUTABLE lines only — a comment that merely mentions the field is how
    // the first version of this guard passed while the fix was reverted.
    const bad = [];
    let seen = 0;
    for (const f of ['src/server/usage-pool-engine.js', 'src/usage-routes.js', 'src/rate-limit-capture.js']) {
      const src = code(f);
      const re = /const (?:merged|cache) = [^;\n]*\{ \.\.\./g;
      let m2;
      while ((m2 = re.exec(src))) {
        seen++;
        const after = src.slice(m2.index, m2.index + 700);
        if (!/delete\s+\w+\.corroborated|\w+\.corroborated\s*=/.test(after)) bad.push(`${f}: ${after.split('\n')[0].trim().slice(0, 60)}`);
      }
    }
    ok('§11e DRIFT GUARD: every usage-cache merge in the three writer files DECIDES `corroborated` for its own write (a statement, not a mention)', bad.length === 0 && seen >= 5, `${seen} merges scanned (writeUsageCacheForKey, markLimitBanner, refreshViaCliPanel, the remote-statusline harvest, captureRateLimitEvent); offenders: ${bad.join(' | ')}`);
  }
}

// (f) LOW — the kb essay a reader reaches FIRST still documented the mechanism
//     this change deleted. A refuted claim stays on record, but it must be
//     MARKED refuted where it lives.
{
  // PER MENTION, not per line: these essays are single giant paragraphs, so a
  // line-level rule passes as soon as ANY other sentence on it says REFUTED
  // (measured — it let the very sentence this leg exists for slip back in).
  for (const f of ['docs/kb-file-structure.md', 'docs/kb-bugfix-invariants.md']) {
    const src = read(f);
    const stale = [];
    let hits = 0;
    for (const m2 of src.matchAll(/sessionReadingMember|unsatisfiable guard/g)) {
      hits++;
      const near = src.slice(Math.max(0, m2.index - 40), m2.index + 260);
      if (!/REFUTED|DELETED/.test(near)) stale.push(near.slice(0, 100).replace(/\s+/g, ' '));
    }
    ok(`§11f ${f}: every mention of the deleted resolver / the "unsatisfiable guard" claim is marked REFUTED WHERE IT STANDS (${hits} mentions)`, stale.length === 0 && hits >= 3, stale.join(' | '));
  }
  ok('§11f …and both essays name the resolver that replaced it', /readingSlotFor/.test(read('docs/kb-file-structure.md')) && /readingSlotFor/.test(read('docs/kb-bugfix-invariants.md')));
}

// ── §12 ROUND 3: the five defects the adversarial verifier reproduced ───────
// Same discipline as §11: drive the REAL producer / the REAL migration, and
// carry a negative control that fails without the fix.

// (a) MAJOR — THE TWO NAMESPACES. The slot-transition ledger is keyed by the
//     WEBUI session key (`sess-<seq>-<ms>`: what ensureSessionPoolLink is
//     called with, what a plan-C link's basename spells, what the engine's
//     journal line prints) while attribution.ndjson is keyed by the CLAUDE
//     CONVERSATION id (a UUID: what recordUsageAttribution receives). The
//     repair looked the ledger up with the conversation id, so a session-scoped
//     row could never match: every plan-C conversation silently got the POOL
//     DEFAULT's answer, and that answer was WRITTEN INTO THE LIVE STORE — the
//     conversation's spend moved to a member its own link was never on.
{
  const DEAD = 'sub-dead0000', BST = 'sub-bstack00', FISH = 'sub-fish0000';
  const T = Date.parse('2026-09-07T06:30:00Z');
  const WIPE = T - 5 * 86400e3;
  const CONV = '2f1a9c40-e15f-48e9-bea4-5a1cb9e7cb9b';   // the shape in attribution.ndjson
  const SEQ = 7, KEY_AT = T - 86400e3;
  const KEY = `sess-${SEQ}-${KEY_AT}`;                    // the shape in data/pool-links/<pool>/
  const mkFixture = ({ withMeta = true, ownRow = true } = {}) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-join-')); cleanup.push(d);
    const dataDir = path.join(d, 'data');
    for (const p2 of ['subs/' + DEAD, 'usage-cache', 'usage-history', 'session-meta']) fs.mkdirSync(path.join(dataDir, p2), { recursive: true });
    const cp = path.join(dataDir, 'subs', DEAD, '.credentials.json');
    fs.writeFileSync(cp, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }));
    fs.utimesSync(cp, WIPE / 1000, WIPE / 1000);
    const hist = path.join(dataDir, 'usage-history');
    fs.writeFileSync(path.join(hist, 'attribution.ndjson'), JSON.stringify({ sid: CONV, acct: DEAD, pool: 'pool-1', ts: T }) + '\n');
    if (withMeta) fs.writeFileSync(path.join(dataDir, 'session-meta', `cw-${SEQ}-${KEY_AT}.json`), JSON.stringify({ claudeSessionId: CONV, accountId: 'pool-1', backend: 'claude' }));
    const tr = new SlotTransitions({ dataDir });
    tr.record({ sessionId: null, poolId: 'pool-1', from: null, to: BST, at: T - 2000, why: 'pool-target' });          // the pool DEFAULT
    if (ownRow) tr.record({ sessionId: KEY, poolId: 'pool-1', from: BST, to: FISH, at: T - 1000, why: 'per-session-switch' }); // THIS conversation's link
    return { dataDir, hist, cp, tr };
  };
  const runRepair = (f) => { const cap = quiet(); const r = repair.repairReadings({ dataDir: f.dataDir, members: [{ id: DEAD, credsPath: f.cp }], transitions: f.tr, id: 'R3' }); cap.done(); return r.attribution; };
  const lines = (f) => fs.readFileSync(path.join(f.hist, 'attribution.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const archLine = (f) => { try { return JSON.parse(fs.readFileSync(path.join(f.dataDir, 'archive', 'readings-foreign-attribution.ndjson'), 'utf8').trim().split('\n')[0]); } catch { return null; } };

  {
    const f = mkFixture();
    const rep = runRepair(f);
    const row = lines(f)[0];
    ok('§12a a conversation is re-attributed to ITS OWN credential link\'s target, joined through session-meta (the ledger speaks webui keys, attribution speaks conversation ids)', rep.reattributed === 1 && row.acct === FISH && row.repairedBy === 'R3', JSON.stringify({ rep, row }));
    ok('§12a …and the archived copy NAMES the webui session it was joined through', /scope session, via session sess-7-/.test(String(archLine(f)?.reason)), String(archLine(f)?.reason));
  }
  {
    // NEGATIVE CONTROL #1: the pre-fix lookup, run against this very ledger.
    const f = mkFixture();
    const byConv = f.tr.slotAt(CONV, T, { poolId: 'pool-1' });
    const byKey = f.tr.slotAt(KEY, T, { poolId: 'pool-1' });
    ok('§12a NEGATIVE CONTROL: asked with the CONVERSATION id the ledger falls to the POOL DEFAULT — a member this conversation\'s link was never on', byConv.id === BST && byConv.scope === 'default' && byKey.id === FISH && byKey.scope === 'session', JSON.stringify({ byConv, byKey }));
    ok('§12a …and it SAYS that its own-link answer is unknown, so a caller about to rewrite a stored fact can refuse', byConv.ownLinkUnknown === true && byKey.ownLinkUnknown === undefined, JSON.stringify(byConv));
    ok('§12a …while asking about the DEFAULT ITSELF (no session named) carries no flag — that is exactly the question it answers', f.tr.slotAt(null, T, { poolId: 'pool-1' }).ownLinkUnknown === undefined);
  }
  {
    // NEGATIVE CONTROL #2: unjoinable (session-meta gone) ⇒ ARCHIVE, never the
    // default's answer. This is the shape the bug produced on every entry.
    const f = mkFixture({ withMeta: false });
    const rep = runRepair(f);
    ok('§12a a conversation we cannot join to a webui key is ARCHIVED, not re-attributed to whatever the pool default happened to be', rep.reattributed === 0 && rep.archived === 1 && rep.unjoinable === 1 && lines(f).length === 0, JSON.stringify(rep));
    ok('§12a …and the reason says WHICH evidence was missing', /no webui session key for this conversation/.test(String(archLine(f)?.reason)), String(archLine(f)?.reason));
  }
  {
    // joinable, but only the DEFAULT has a row: still not evidence about a
    // conversation that may have had a link of its own.
    const f = mkFixture({ ownRow: false });
    const rep = runRepair(f);
    ok('§12a a joinable conversation with only a POOL-DEFAULT row is archived too (the default is not evidence about a session that may have had its own link)', rep.reattributed === 0 && rep.archived === 1, JSON.stringify(rep));
    ok('§12a …and says so', /only the POOL DEFAULT answers for it/.test(String(archLine(f)?.reason)), String(archLine(f)?.reason));
  }
  {
    // ONE CONVERSATION, MANY WEBUI KEYS: a resume mints a new sess-* under the
    // same claudeSessionId, so the join is one-to-many over time.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-join2-')); cleanup.push(d);
    const dataDir = path.join(d, 'data');
    for (const p2 of ['subs/' + DEAD, 'usage-history', 'session-meta']) fs.mkdirSync(path.join(dataDir, p2), { recursive: true });
    const cp = path.join(dataDir, 'subs', DEAD, '.credentials.json');
    fs.writeFileSync(cp, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }));
    fs.utimesSync(cp, WIPE / 1000, WIPE / 1000);
    const A_AT = T - 3 * 86400e3, B_AT = T - 3600e3;      // the resume happened an hour before the entry
    fs.writeFileSync(path.join(dataDir, 'session-meta', `cw-3-${A_AT}.json`), JSON.stringify({ claudeSessionId: CONV, accountId: 'pool-1' }));
    fs.writeFileSync(path.join(dataDir, 'session-meta', `cw-9-${B_AT}.json`), JSON.stringify({ claudeSessionId: CONV, accountId: 'pool-1' }));
    fs.writeFileSync(path.join(dataDir, 'usage-history', 'attribution.ndjson'), JSON.stringify({ sid: CONV, acct: DEAD, pool: 'pool-1', ts: T }) + '\n');
    const tr = new SlotTransitions({ dataDir });
    tr.record({ sessionId: `sess-3-${A_AT}`, poolId: 'pool-1', from: null, to: BST, at: A_AT, why: 'spawn' });
    tr.record({ sessionId: `sess-9-${B_AT}`, poolId: 'pool-1', from: null, to: FISH, at: B_AT, why: 'spawn' });
    const keys = repair.sessionKeysFor(repair._sessionKeyMap(dataDir), CONV, T);
    ok('§12a a conversation carried by SEVERAL webui sessions (resume/fork) offers every candidate, and the latest row at that instant wins', keys.length === 2 && tr.slotAt(keys, T, { poolId: 'pool-1' }).id === FISH, JSON.stringify({ keys, hit: tr.slotAt(keys, T, { poolId: 'pool-1' }) }));
    ok('§12a …and a key minted AFTER the entry is not a candidate for it (the key carries its own creation ms)', repair.sessionKeysFor(repair._sessionKeyMap(dataDir), CONV, A_AT + 1).length === 1);
    const cap = quiet();
    repair.repairReadings({ dataDir, members: [{ id: DEAD, credsPath: cp }], transitions: tr, id: 'R3b' });
    cap.done();
    ok('§12a …end to end: the entry lands on the member the RESUMED session\'s link was on', JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-history', 'attribution.ndjson'), 'utf8').trim()).acct === FISH);
  }
  // WIRING PIN: a pure join that the orchestrator never hands dataDir to is the
  // 2.355.0 unstaged-wiring class.
  ok('§12a WIRING: repairReadings passes dataDir into repairAttribution, and the lookup goes through the join (never the raw sid)', /repairAttribution\(\{ dataDir, historyDir:/.test(read('src/reading-repair.js')) && /transitions\.slotAt\(keys, r\.ts/.test(read('src/reading-repair.js')) && !/transitions\.slotAt\(r\.sid/.test(code('src/reading-repair.js')));
  ok('§12a WIRING: the journal backfill records the SAME namespace the engine prints (webui id), so its rows are joinable by the same map', /per-session switch \$\{poolId\}\/\$\{sid\}/.test(read('src/server/usage-pool-engine.js')) && /const row = s\n\s*\? \{ sessionId: s\[2\]/.test(read('src/reading-repair.js')));
}

// (b) MEDIUM — the r2 emptied-sid fix re-bakes through `_acctAt`'s session-meta
//     fallback, and for a POOLED session that field is the POOL id. So ledger
//     events got `acct:'pool-…', atype:'pooled'` — a pseudo-account that holds
//     no credentials, surfacing as a spender in the account dimension, which
//     server.js forbids in so many words.
{
  const UH = require(path.join(REPO, 'src/usage-history.js')).UsageHistory;
  const T = Date.parse('2026-09-07T06:30:00Z');
  const mk = (metaAcct, resolve) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-poolbake-')); cleanup.push(d);
    const dataDir = path.join(d, 'data');
    for (const p2 of ['usage-history', 'session-meta']) fs.mkdirSync(path.join(dataDir, p2), { recursive: true });
    const hist = path.join(dataDir, 'usage-history');
    fs.writeFileSync(path.join(hist, 'events-2026-09.ndjson'), JSON.stringify({ ts: T, sid: 'S', acct: 'sub-dead', atype: 'subscription', aname: 'Dead', pool: 'pool-abc123def456', model: 'm', cost: 1 }) + '\n');
    fs.writeFileSync(path.join(hist, 'attribution.ndjson'), '');
    fs.writeFileSync(path.join(hist, '.attrib-emptied.json'), JSON.stringify(['S']));
    fs.writeFileSync(path.join(dataDir, 'session-meta', 'cw-1-1.json'), JSON.stringify({ claudeSessionId: 'S', accountId: metaAcct, backend: 'claude' }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-poolbake-h-')); cleanup.push(home);
    const cap = quiet();
    new UH({ dataDir, homeDir: home, resolveAccount: resolve })._maybeRebakeAttribution();
    cap.done();
    return JSON.parse(fs.readFileSync(path.join(hist, 'events-2026-09.ndjson'), 'utf8').trim());
  };
  // the CLAUDE pool: the injected resolver reports type 'pooled'
  const e1 = mk('pool-abc123def456', (id) => (id === 'pool-abc123def456' ? { type: 'pooled', name: 'My Pool' } : null));
  ok('§12b an emptied conversation whose session-meta names a POOL falls to GLOBAL, never to the pool id (a pseudo-account cannot be a spender)', e1.acct === null && e1.atype === 'global' && e1.aname === null, JSON.stringify(e1));
  ok('§12b …and the `pool` tag survives, so the per-pool total still sees the spend it really carried', e1.pool === 'pool-abc123def456');
  // the CODEX pool: server.js's resolveAccount maps backend 'codex' to a single
  // type BEFORE a.type is read, so it reports 'codex-subscription' — the type
  // leg alone misses every codex pool, which is why the minted id shape is the
  // primary test.
  const e2 = mk('pool-abc123def456', () => ({ type: 'codex-subscription', name: 'Codex Pool' }));
  ok('§12b …a CODEX pool is caught too, by the minted id shape (its injected type says "codex-subscription")', e2.acct === null && e2.atype === 'global', JSON.stringify(e2));
  // and the TYPE leg is not decoration: an id outside the minted shape still
  // resolves through it
  const e3 = mk('legacy-pool-1', (id) => (id === 'legacy-pool-1' ? { type: 'pooled', name: 'Legacy' } : null));
  ok('§12b …and an id OUTSIDE the minted shape is caught by the type leg (both legs are load-bearing, neither is unfalsifiable)', e3.acct === null && e3.atype === 'global', JSON.stringify(e3));
  // NEGATIVE CONTROL: an ordinary account still falls back the r2 way
  const e4 = mk('sub-live0000', (id) => (id === 'sub-live0000' ? { type: 'subscription', name: 'Live' } : null));
  ok('§12b NEGATIVE CONTROL: an ordinary subscription in session-meta is still the un-refuted fallback (the fix drops POOLS, it does not disable the fallback)', e4.acct === 'sub-live0000' && e4.atype === 'subscription' && e4.aname === 'Live', JSON.stringify(e4));
  ok('§12b …and this is server.js\'s own invariant, applied at the second site that reaches the same decision', /never to the pool id itself/.test(read('server.js')) && /_nonPoolAcct/.test(code('src/usage-history.js')));
}

// (c) MINOR — the provenance line labelled EVERY codex reading "via unknown /
//     No producer recorded this reading". The codex snapshot writers stamped
//     no `source`: normalizeCodexRateLimit is a PURE payload mapper and cannot
//     know which channel carried it, so nobody named the one codex producer
//     that exists. The honesty feature was lying about it.
{
  const S = await import(path.join(REPO, 'src/lib/usage-source.js'));
  const w = mkWorld(); const cap = quiet();
  const cs = { backend: 'codex', mode: 'chat', host: null, _webuiId: 'sess-cx3', claudeSessionId: 'cid-cx3', _accountId: null, pty: { write() { } } };
  w.sessions.set('sess-cx3', cs);
  w.codexReading(cs);
  cap.done();
  const g = JSON.parse(fs.readFileSync(path.join(w.cacheDir, '__global_codex__.json'), 'utf8'));
  ok('§12c the LIVE codex producer stamps its own name at the write', g.source === 'codex-rate-limits', JSON.stringify({ source: g.source }));
  const src = S.readingSource(g.source);
  ok('§12c …so the panel names it instead of "unknown"', src.key === 'session' && src.label !== 'unknown' && !/No producer recorded/.test(src.tip), JSON.stringify(src));
  ok('§12c the ROLLOUT-TAIL producer gets its own name (a transcript read is a different freshness story from a live push)', S.readingSource('codex-rollout').key === 'transcript' && S.readingSource('codex-rollout').label !== 'unknown');
  // A REFUSAL is not a push, and the `sig.snapshot ||` fallback on that branch
  // SYNTHESIZES a spent bucket that is not a reading at all — `writeSnap` takes
  // the source as a PARAMETER so each channel names itself.
  {
    const w2 = mkWorld(); const cap2 = quiet();
    const cs2 = { backend: 'codex', mode: 'chat', host: null, _webuiId: 'sess-cx4', claudeSessionId: 'cid-cx4', _accountId: null, pty: { write() { } } };
    w2.sessions.set('sess-cx4', cs2);
    w2.eng.recordCodexQuotaSignal(cs2, { type: 'task_failed', error: 'usage limit reached', codexErrorInfo: 'usage_limit_reached', resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    cap2.done();
    const g2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(w2.cacheDir, '__global_codex__.json'), 'utf8')); } catch { return null; } })();
    ok('§12c a codex REFUSAL is stamped as the limit banner it is, never as the live push (the same branch also SYNTHESIZES a spent bucket, which is not a reading)', !!g2 && g2.source === 'limit-banner' && S.readingSource(g2.source).key === 'banner', JSON.stringify(g2 && { source: g2.source, u7: g2.sevenDay?.utilization }));
  }
  ok('§12c …both new keys carry zh+ja entries', (() => {
    const zh = read('src/lib/i18n-zh.js'), ja = read('src/lib/i18n-ja.js');
    return ['session transcript', "A live Codex session on this account's credential slot pushed its own rate limits."].every((k) => zh.includes(JSON.stringify(k).slice(1, -1)) && ja.includes(JSON.stringify(k).slice(1, -1)));
  })());
  // WIRING: every codex snapshot writer stamps, and the PURE mapper still does
  // not (the channel is not a property of the payload).
  const cq = require(path.join(REPO, 'src/harnesses/codex-quota.js'));
  const bare = cq.normalizeCodexRateLimit({ primary: { used_percent: 20, window_minutes: 300, resets_at: 1 } }, Date.now());
  // scoped to normalizeCodexRateLimit's OWN body: `signalFromStream` further
  // down legitimately returns a `source` naming which STREAM RECORD produced a
  // signal — a different field from a reading's producer, and a loose grep here
  // matched it (the assertion has to name the function it is about).
  const cqSrc = read('src/harnesses/codex-quota.js');
  const normBody = cqSrc.slice(cqSrc.indexOf('function normalizeCodexRateLimit'), cqSrc.indexOf('// The typed exhaustion enum'));
  ok('§12c the PURE normalizer still stamps nothing — the channel is named at the WRITE, never inferred from the payload shape', bare.source === undefined && normBody.length > 500 && !/\bsource\b\s*[:=]/.test(normBody), `${normBody.length}B scanned`);
  ok('§12c WIRING: every codex snapshot writer stamps a source, and the engine takes it as a PARAMETER (one helper, two channels — one of which does not always carry a reading)', /const writeSnap = \(snap, source\) =>/.test(read('src/server/usage-pool-engine.js')) && /snap\.source = source;/.test(read('src/server/usage-pool-engine.js')) && /writeSnap\(snap0, 'codex-rate-limits'\)/.test(read('src/server/usage-pool-engine.js')) && /writeSnap\(snap, 'limit-banner'\)/.test(read('src/server/usage-pool-engine.js')) && /if \(snap\) snap\.source = 'codex-rate-limits';/.test(read('src/usage-routes.js')) && /normalized\.source = 'codex-rollout';/.test(read('src/usage-routes.js')));
  // NEGATIVE CONTROL: the verbatim-unknown rule is intact for a producer we
  // have genuinely never met — the fix names OUR writers, it does not bucket.
  ok('§12c NEGATIVE CONTROL: an unmet producer is still reported verbatim, and a MISSING one still says "unknown"', S.readingSource('some-future-writer').key === 'other' && S.readingSource('some-future-writer').label === 'some-future-writer' && S.readingSource(undefined).key === 'unknown');
}

// (d) MINOR — the statusline resolved the credential link at WRITE time, so it
//     honoured a re-point one turn EARLIER than the server's own rule allows:
//     `rate_limits` is the CLI's LAST API response, made with the PREVIOUS
//     credentials, so the first post-switch render filed the old member's
//     numbers under the new one — stamped fresh, and then anchored as ground
//     truth (the B-b3cd odometer-flap class, on the write path).
{
  const { execFileSync } = await import('node:child_process');
  const SCRIPT = path.join(REPO, 'data/bin/vibespace-usage');
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sline-')); cleanup.push(d);
    for (const p2 of ['subs/sub-old', 'subs/sub-new', 'usage-cache', 'pool-links/pool-1']) fs.mkdirSync(path.join(d, p2), { recursive: true });
    const link = path.join(d, 'pool-links/pool-1/sess-1-1');
    fs.symlinkSync(path.join(d, 'subs/sub-old'), link);
    return { d, link, point: (to) => { fs.unlinkSync(link); fs.symlinkSync(path.join(d, 'subs', to), link); } };
  };
  const P = (p5, p7) => JSON.stringify({ session_id: 'conv-sline', rate_limits: { five_hour: { used_percentage: p5, resets_at: 1788800000 }, seven_day: { used_percentage: p7, resets_at: 1789000000 } } });
  const render = (w, payload) => execFileSync(process.execPath, [SCRIPT], { input: payload, encoding: 'utf8', env: { ...process.env, VIBESPACE_USAGE_CACHE: path.join(w.d, 'usage-cache'), VIBESPACE_ACCOUNT_KEY: 'pool-1', VIBESPACE_ACCOUNT_LINK: w.link } });
  const cacheOf = (w, id) => { try { return JSON.parse(fs.readFileSync(path.join(w.d, 'usage-cache', id + '.json'), 'utf8')); } catch { return null; } };

  {
    const w = mk();
    render(w, P(42, 61));               // produced by sub-old
    w.point('sub-new');                 // the pool re-points; no request has happened yet
    render(w, P(42, 61));               // the SAME numbers — still sub-old's
    ok('§12d the first render after a re-point does NOT move the previous slot\'s numbers onto the new member', cacheOf(w, 'sub-new') === null && Math.abs(cacheOf(w, 'sub-old').fiveHour.utilization - 0.42) < 1e-9, JSON.stringify({ neu: cacheOf(w, 'sub-new'), old: cacheOf(w, 'sub-old')?.fiveHour }));
    render(w, P(7, 9));                 // the first response the NEW credentials produced
    ok('§12d …and the first DIFFERING payload — the first one the new credentials produced — lands on the new member', Math.abs(cacheOf(w, 'sub-new').fiveHour.utilization - 0.07) < 1e-9 && Math.abs(cacheOf(w, 'sub-old').fiveHour.utilization - 0.42) < 1e-9, JSON.stringify({ neu: cacheOf(w, 'sub-new').fiveHour, old: cacheOf(w, 'sub-old').fiveHour }));
  }
  {
    // A render that the 8s THROTTLE skipped is still an OBSERVATION: the state
    // must record it, or the next payload after a switch looks "new".
    const w = mk();
    render(w, P(42, 61));               // written under sub-old
    render(w, P(55, 66));               // throttled (mtime < 8s) — but seen, under sub-old
    w.point('sub-new');
    render(w, P(55, 66));               // same as the throttled render ⇒ must be held
    ok('§12d a payload the throttle SKIPPED still counts as evidence about which credentials produced it', cacheOf(w, 'sub-new') === null && Math.abs(cacheOf(w, 'sub-old').fiveHour.utilization - 0.42) < 1e-9, JSON.stringify(cacheOf(w, 'sub-new')));
  }
  {
    // NEGATIVE CONTROL: delete the state between the switch and the render and
    // the pre-fix behaviour returns exactly — the old numbers land on the new
    // member, stamped fresh.
    const w = mk();
    render(w, P(42, 61));
    w.point('sub-new');
    for (const n of fs.readdirSync(path.join(w.d, 'usage-cache'))) if (n.startsWith('.slot-')) fs.unlinkSync(path.join(w.d, 'usage-cache', n));
    render(w, P(42, 61));
    const neu = cacheOf(w, 'sub-new');
    ok('§12d NEGATIVE CONTROL: without the slot state the identical payload lands on the new member, stamped fresh (the pre-fix write, reproduced)', !!neu && Math.abs(neu.fiveHour.utilization - 0.42) < 1e-9 && neu.fetchedAt > Date.now() - 60000, JSON.stringify(neu && { u: neu.fiveHour.utilization, fresh: neu.fetchedAt > Date.now() - 60000 }));
  }
  {
    // it costs an UNPOOLED session nothing, and the state file is invisible to
    // every usage-cache scanner (they all filter on `.json`)
    const w = mk();
    execFileSync(process.execPath, [SCRIPT], { input: P(11, 22), encoding: 'utf8', env: { ...process.env, VIBESPACE_USAGE_CACHE: path.join(w.d, 'usage-cache'), VIBESPACE_ACCOUNT_KEY: 'sub-plain00' } });
    const names = fs.readdirSync(path.join(w.d, 'usage-cache'));
    ok('§12d a session with NO credential link writes no slot state at all (it cannot switch under itself)', !names.some((n) => n.startsWith('.slot-')) && names.includes('sub-plain00.json'), JSON.stringify(names));
    const w2 = mk();
    render(w2, P(1, 2));
    ok('§12d …and the state file carries no `.json`, so every usage-cache scanner keeps ignoring it', fs.readdirSync(path.join(w2.d, 'usage-cache')).some((n) => n.startsWith('.slot-') && !n.endsWith('.json')));
  }
  ok('§12d the rule NAMES the server-side twin it mirrors (one reading-lag rule, two implementations that must not drift)', /a re-point reaches the running CLI on its NEXT request/i.test(read('src/server/usage-pool-engine.js')) && /NEXT request/.test(read('data/bin/vibespace-usage')));
}

// (e) LOW — record()'s dedup key was the sessionId alone, so EVERY pool shared
//     one `__default__` bucket. A member can belong to several pools (this
//     instance's has members:null = every subscription), so two pools moving
//     their defaults to the same member inside DEDUP_MS lost the second row —
//     and slotAt, which filters by poolId, then answered that pool with its
//     previous, now-WRONG default: a confident answer from a ledger whose
//     contract is "unknown, never agreement".
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-dedupkey-')); cleanup.push(d);
  const st = new SlotTransitions({ dataDir: d });
  const t0 = 1788000000000;
  st.record({ sessionId: null, poolId: 'pool-B', from: null, to: 'sub-old', at: t0 - 300000, why: 'pool-target' });
  const a = st.record({ sessionId: null, poolId: 'pool-A', from: 'sub-x', to: 'sub-shared', at: t0, why: 'pool-target' });
  const b = st.record({ sessionId: null, poolId: 'pool-B', from: 'sub-old', to: 'sub-shared', at: t0 + 10000, why: 'pool-target' });
  ok('§12e two pools re-pointing their DEFAULTS to the same member 10s apart produce TWO rows', !!a && !!b, JSON.stringify({ a: !!a, b: !!b }));
  ok('§12e …and slotAt answers each pool with its own', st.slotAt(null, t0 + 20000, { poolId: 'pool-A' }).id === 'sub-shared' && st.slotAt(null, t0 + 20000, { poolId: 'pool-B' }).id === 'sub-shared', JSON.stringify([st.slotAt(null, t0 + 20000, { poolId: 'pool-A' }), st.slotAt(null, t0 + 20000, { poolId: 'pool-B' })]));
  // NEGATIVE CONTROL: the old key rule, applied to the very same sequence.
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-dedupkey2-')); cleanup.push(d2);
    const st2 = new SlotTransitions({ dataDir: d2 });
    st2._key = (sessionId) => sessionId || '__default__';   // the pre-fix key, verbatim
    st2.record({ sessionId: null, poolId: 'pool-B', from: null, to: 'sub-old', at: t0 - 300000, why: 'pool-target' });
    st2.record({ sessionId: null, poolId: 'pool-A', from: 'sub-x', to: 'sub-shared', at: t0, why: 'pool-target' });
    const b2 = st2.record({ sessionId: null, poolId: 'pool-B', from: 'sub-old', to: 'sub-shared', at: t0 + 10000, why: 'pool-target' });
    ok('§12e NEGATIVE CONTROL: with the pre-fix key pool B\'s row is dropped and the ledger answers it CONFIDENTLY WRONG (sub-old), which is worse than "unknown"', b2 === null && st2.slotAt(null, t0 + 20000, { poolId: 'pool-B' }).id === 'sub-old', JSON.stringify(st2.slotAt(null, t0 + 20000, { poolId: 'pool-B' })));
  }
  // the SESSION dedup is unchanged: a session key is globally unique and a
  // conversation belongs to exactly one pool, so it needs nothing more.
  ok('§12e a repeated re-point of the SAME session link inside the window is still ONE fact', (() => {
    const n = st.all().length;
    st.record({ sessionId: 'sess-9-1', poolId: 'pool-A', to: 'sub-z', at: t0 });
    const mid = st.all().length;
    st.record({ sessionId: 'sess-9-1', poolId: 'pool-A', to: 'sub-z', at: t0 + 100 });
    return mid === n + 1 && st.all().length === mid;
  })());
}

// ── §13 THE LAG SHADOW + THE WINDOW GUARD, as a PURE rule ───────────────────
// inc-mts8a8mr-ulmm (2026-09-08, owner: "a low-usage account suddenly jumped to
// 93% 7d"). The slot rule of 2.369.68 is right and stays; what it could not
// know is that the link moves while requests are IN FLIGHT — the response that
// arrived 16 s after the 05:27:00Z re-point had been made 39 s earlier with the
// PREVIOUS member's token, and `readingSlotFor` filed it on the new one.
//
// The numbers below are the MEASURED shapes from this instance's own anchor
// corpus (weekly resets and utilizations; the account ids are synthetic).
{
  const L = require(path.join(REPO, 'src/reading-lag.js'));
  const WEEK = 604800;
  // the three weekly windows from the incident, verbatim; A/B/C are synthetic
  const W_A = 1789030800;   // the member that was actually being burned
  const W_B = 1789142400;   // the member the pool moved to (its own window)
  const W_C = 1789318800;   // a third member
  const nowSec = 1788845259;  // 2026-09-08T05:27:39Z, the poisoned anchor's own ts

  ok('§13 a weekly window identifies an ACCOUNT: the three members of the incident have three different phases',
    new Set([W_A, W_B, W_C].map((x) => L.weeklyPhase(x))).size === 3, JSON.stringify([W_A, W_B, W_C].map(L.weeklyPhase)));
  ok('§13 …and a ROLL keeps the phase (a window that resets moves by exactly one week — measured across this instance\'s 30-day corpus)',
    L.weeklyNear(W_A, W_A + WEEK) === true && L.weeklyNear(W_A, W_A + 4 * WEEK) === true);
  ok('§13 the ±60 s wobble between the /usage panel\'s and the event stream\'s spelling of the SAME window is not a difference',
    L.weeklyNear(1789030800, 1789030740) === true && L.weeklyNear(1789142400, 1789142340) === true);
  ok('§13 …while a real disagreement is one (the incident: 1789030800 filed against a member whose window is 1789142400)',
    L.weeklyNear(W_A, W_B) === false);
  ok('§13 the phase is CIRCULAR — 1 s past the boundary is not half a week from 1 s before it',
    L.weeklyNear(WEEK - 30, WEEK + 30) === true && L.weeklyNear(WEEK - 400, WEEK + 400) === false);

  // three states, and "we cannot tell" is never spelled like "yes"
  const winA = { sevenDay: W_A, fiveHour: null, scoped: {} };
  const winB = { sevenDay: W_B, fiveHour: null, scoped: {} };
  ok('§13 compareWindows is THREE-state', L.compareWindows({ kind: 'sevenDay', resetsAt: W_A }, winA, { nowSec }) === 'agree'
    && L.compareWindows({ kind: 'sevenDay', resetsAt: W_A }, winB, { nowSec }) === 'differ'
    && L.compareWindows({ kind: 'fiveHour', resetsAt: 1 }, winA, { nowSec }) === 'unknown');
  // A FIVE-HOUR WINDOW IDENTIFIES A TIME, NOT AN ACCOUNT (r2 — the first
  // spelling of this rule asked it, and that was a new misattribution of
  // exactly the class the guard exists to prevent). Measured on this
  // instance's own 30-day corpus, with the real numbers below:
  //   · SAME account, >120 s from its own still-future stamped 5h, on 7.2 %
  //     (33/456) and 7.4 % (47/639) of the two busiest streams — a 'differ'
  //     about its rightful owner. The pair below is verbatim from that scan.
  //   · DIFFERENT identities carry IDENTICAL 5h resets constantly (47 distinct
  //     colliding values; `resetsAt mod 1800` piles onto :00/:10/:29/:30) — an
  //     'agree' with a stranger. End to end that rung would have re-filed a
  //     legitimate reading onto another account at 50 real moments.
  // The corpus pair is one account's own: stamped 1788780540, read 1788786600
  // (Δ 6060 s). Anchored to NOW here on purpose — the retired rung only ever
  // fired while the target's stamped 5h was still in the FUTURE, so a leg built
  // on the raw (now past) corpus seconds could never have reddened for it.
  const OWN_5H = Math.floor(Date.now() / 1000) + 1800, READ_5H = OWN_5H + 6060;
  ok('§13 a 5-hour window identifies a TIME, not an account: a reading 6060 s from the target\'s own STILL-FUTURE stamped 5h is NOT a disagreement (measured: 7.2 % (33/456) and 7.4 % (47/639) of the two busiest streams do exactly this)',
    L.compareWindows({ kind: 'fiveHour', resetsAt: READ_5H }, { sevenDay: null, fiveHour: OWN_5H, scoped: {} }) === 'unknown');
  ok('§13 …and a stranger whose still-future 5h happens to line up is NOT a match either (5h resets snap to the clock — 47 colliding values across identities in the same corpus)',
    L.compareWindows({ kind: 'fiveHour', resetsAt: READ_5H }, { sevenDay: null, fiveHour: READ_5H, scoped: {} }) === 'unknown');
  ok('§13 THE WEEKLY HALF IS THE ONLY IDENTITY EVIDENCE — a disagreeing 5h cannot spoil an agreeing week, and identity is decided WITHOUT a clock',
    L.compareWindows({ sevenDay: W_A, fiveHour: 111 }, { sevenDay: W_A, fiveHour: nowSec + 7200, scoped: {} }) === 'agree'
    && L.compareWindows({ sevenDay: W_A, fiveHour: READ_5H }, { sevenDay: W_B, fiveHour: READ_5H, scoped: {} }) === 'differ');
  ok('§13 …so a reading with NO weekly component is simply written — never re-filed onto a sibling, never archived (no evidence, no refusal)',
    (() => {
      const win5 = { fish: { sevenDay: null, fiveHour: OWN_5H, scoped: {} }, bstack: { sevenDay: null, fiveHour: READ_5H, scoped: {} } };
      const d = L.decideReadingTarget({ key: 'fish', readingWindow: { kind: 'fiveHour', resetsAt: READ_5H }, windows: win5 });
      const alone = L.decideReadingTarget({ key: 'fish', readingWindow: { kind: 'fiveHour', resetsAt: READ_5H }, windows: { fish: win5.fish } });
      // and the REASON is true: the target HAS an established window, the
      // reading just carries nothing that names an account
      return d.action === 'write' && d.key === 'fish' && /no weekly window/.test(d.reason)
        && alone.action === 'write' && alone.key === 'fish';
    })());
  ok('§13 NEGATIVE CONTROL: the retired 5-hour rung, on those same numbers, calls the account\'s OWN reading foreign and a stranger\'s a match',
    (() => {
      // the pre-fix rung, verbatim: absNear on 5h whenever the target's own 5h
      // is still future
      const absNear = (a, b, j = 120) => Math.abs(Number(a) - Number(b)) <= j;
      const nowS = Math.floor(Date.now() / 1000);
      const preFix = (readingR, ownR) => (ownR > nowS) ? (absNear(readingR, ownR) ? 'agree' : 'differ') : 'unknown';
      return preFix(READ_5H, OWN_5H) === 'differ' && preFix(READ_5H, READ_5H) === 'agree';
    })());
  // TWO MECHANISMS, TWO LEGS. Removing the 5h rung is what makes
  // `compareWindows` answer 'unknown'; the no-weekly early return in
  // `decideReadingTarget` is what keeps that answer from being re-derived by a
  // future edit — and it is NOT decoration: it fires before compareWindows is
  // consulted at all, which is why the engine-level leg in §15 survives even a
  // restored rung. Each is mutation-checked on its own.
  ok('§13 MECHANISM 2: a reading with no weekly component short-circuits the guard BEFORE any comparison, and says so in the reason that reaches the journal and the archive',
    (() => {
      const d = L.decideReadingTarget({
        key: 'fish', readingWindow: { kind: 'fiveHour', resetsAt: READ_5H },
        windows: { fish: { sevenDay: W_A, fiveHour: OWN_5H, scoped: {} }, bstack: { sevenDay: W_B, fiveHour: READ_5H, scoped: {} } },
      });
      // the target HAS an established window, so "no established window to
      // contradict" would be a false sentence about it
      return d.action === 'write' && d.key === 'fish' && d.reason === 'reading states no weekly window';
    })());
  ok('§13 a scoped weekly bucket carries the same fingerprint', L.compareWindows({ kind: 'scoped', scopedName: 'fable', resetsAt: W_A }, { sevenDay: null, fiveHour: null, scoped: { fable: W_B } }, { nowSec }) === 'differ');

  // ── the shadow, on the incident's own timing
  const shadow = (o) => L.decideLagShadow({ prevKey: 'acct-A', prevWindow: winA, newKey: 'acct-B', newWindow: winB, nowSec, ...o });
  const s1 = shadow({ readingWindow: { kind: 'sevenDay', resetsAt: W_A }, repointAgeMs: 16000 });
  ok('§13 THE INCIDENT: a reading arriving 16 s after the re-point, carrying the PREVIOUS slot\'s window, is the previous slot\'s',
    s1.key === 'acct-A' && s1.shadowed === true && s1.why === 'window-of-previous-slot', JSON.stringify(s1));
  const s2 = shadow({ readingWindow: { kind: 'sevenDay', resetsAt: W_B }, repointAgeMs: 16000 });
  ok('§13 …and the FIRST reading that is really the new credentials\' ends it', s2.key === 'acct-B' && s2.shadowed === false && s2.why === 'window-of-new-slot', JSON.stringify(s2));
  // ── r3: THE CLOCK RANKS BELOW THE WINDOWS. `shadowMs` used to short-circuit
  //    above every window rung, which made the whole rule only as good as its
  //    caller's ESTIMATE of the age — and the shipped statusline had no re-point
  //    instant to give it (see §15's leg). A clock is a proxy for "were those
  //    credentials still in play"; the window is the answer, so the proxy may
  //    never overrule it.
  const s3 = shadow({ readingWindow: { kind: 'sevenDay', resetsAt: W_A }, repointAgeMs: 11 * 60e3 });
  ok('§13 THE WINDOW OUTRANKS THE CLOCK: an old re-point does not make the PREVIOUS slot\'s window stop being the previous slot\'s',
    s3.key === 'acct-A' && s3.shadowed === true && s3.why === 'window-of-previous-slot', JSON.stringify(s3));
  const s3b = L.decideLagShadow({ prevKey: 'acct-A', newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: 11 * 60e3 });
  ok('§13 BOUNDED where the clock is the only thing left: with no window evidence, a re-point past the horizon explains nothing, so a session that never speaks again cannot pin a slot forever',
    s3b.shadowed === false && s3b.why === 'shadow-expired', JSON.stringify(s3b));
  const s3c = L.decideLagShadow({ prevKey: 'acct-A', newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: null });
  ok('§13 …and an UNKNOWN age never expires — a caller that cannot date the re-point has not thereby proved the shadow is over',
    s3c.key === 'acct-A' && s3c.shadowed === true && s3c.why === 'identical-payload', JSON.stringify(s3c));
  const s3d = L.decideLagShadow({ prevKey: 'acct-A', newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: -5 });
  ok('§13 …while a NEGATIVE age is still rejected (a number that cannot be an age is not evidence)',
    s3d.shadowed === false && s3d.why === 'shadow-expired', JSON.stringify(s3d));
  ok('§13 NEGATIVE CONTROL: the PRE-FIX ordering (clock first) answers `shadow-expired` on the very reading whose window names the previous slot',
    (() => {
      const preFix = ({ prevKey, newKey, repointAgeMs, shadowMs = L.SHADOW_MS }) => {
        if (!prevKey || !newKey || prevKey === newKey) return 'no-repoint';
        if (!(Number(repointAgeMs) >= 0) || Number(repointAgeMs) > shadowMs) return 'shadow-expired';
        return 'window-of-previous-slot';
      };
      // …and note WHY the null case is not part of this control: the retired
      // rule coerced (`Number(null) === 0`), so it read "unknown" as "just now"
      // and happened to agree. The `!= null` clause is a STATEMENT, not a
      // behaviour change — the defect was the ORDER, and that is what differs.
      return preFix({ prevKey: 'acct-A', newKey: 'acct-B', repointAgeMs: 11 * 60e3 }) === 'shadow-expired'
        && s3.why === 'window-of-previous-slot'
        && preFix({ prevKey: 'acct-A', newKey: 'acct-B', repointAgeMs: null }) === 'window-of-previous-slot'
        && s3c.why === 'identical-payload';
    })());
  ok('§13 no re-point ⇒ no shadow, ever', L.decideLagShadow({ prevKey: null, newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A } }).why === 'no-repoint'
    && L.decideLagShadow({ prevKey: 'acct-B', newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A } }).why === 'no-repoint');
  // the r3 statusline clause, now the LAST rung of the same rule
  const s4 = L.decideLagShadow({ prevKey: 'acct-A', newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: 3000 });
  ok('§13 with NO established windows the rule falls back to r3 — "the link moved but the numbers did not"', s4.key === 'acct-A' && s4.shadowed === true && s4.why === 'identical-payload', JSON.stringify(s4));
  const s5 = L.decideLagShadow({ prevKey: 'acct-A', newKey: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'Y', prevFingerprint: 'X', repointAgeMs: 3000 });
  ok('§13 …and a payload that DID change, with nothing else to go on, is not shadowed (r3 verbatim)', s5.shadowed === false && s5.why === 'no-evidence');
  const s6 = L.decideLagShadow({ prevKey: 'acct-A', prevWindow: winA, newKey: 'acct-B', newWindow: winB, readingWindow: { kind: 'sevenDay', resetsAt: W_B }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: 3000, nowSec });
  ok('§13 …but identical numbers NEVER override positive evidence that they are the NEW slot\'s (the incident\'s numbers DID move: 0.92→0.93)', s6.shadowed === false && s6.why === 'window-of-new-slot');

  // ── the guard
  const windows = { 'acct-A': winA, 'acct-B': winB, 'acct-C': { sevenDay: W_C, fiveHour: null, scoped: {} } };
  const g1 = L.decideReadingTarget({ key: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows, nowSec });
  ok('§13 GUARD: a reading whose window is not the target\'s and matches EXACTLY ONE other account is re-filed there', g1.action === 'refile' && g1.key === 'acct-A', JSON.stringify(g1));
  const g2 = L.decideReadingTarget({ key: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_B }, windows, nowSec });
  ok('§13 …a reading that AGREES is simply written', g2.action === 'write' && g2.key === 'acct-B');
  const g3 = L.decideReadingTarget({ key: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_B + 3 * 86400 }, windows, nowSec });
  ok('§13 …one that matches NOBODY is archived with the reason, never written where it provably does not belong', g3.action === 'archive' && g3.key === null && /matches no known account/.test(g3.reason), JSON.stringify(g3));
  const amb = { ...windows, 'acct-D': { sevenDay: W_A + WEEK, fiveHour: null, scoped: {} } };
  const g4 = L.decideReadingTarget({ key: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows: amb, nowSec });
  ok('§13 …and two accounts that genuinely share a weekly phase are AMBIGUOUS, so nothing is re-filed on a guess', g4.action === 'archive' && g4.matched.length === 2, JSON.stringify(g4));
  const grp = L.decideReadingTarget({ key: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows: { ...windows, '__global__': winA }, groupOf: (id) => (id === '__global__' || id === 'acct-A' ? 'acct-A' : id), nowSec });
  ok('§13 …an ORG-MERGED login (`__global__` + its named sub) is ONE account, not two matches', grp.action === 'refile' && grp.matched.length === 1, JSON.stringify(grp));
  ok('§13 NO EVIDENCE = NO REFUSAL: a reading that states no window, and a target with no established window, are both simply written',
    L.decideReadingTarget({ key: 'acct-B', readingWindow: { kind: 'sevenDay', resetsAt: null }, windows, nowSec }).action === 'write'
    && L.decideReadingTarget({ key: 'acct-Z', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows, nowSec }).action === 'write');

  // ── ONE RULE, TWO SPELLINGS (the statusline ships as a single file)
  const SRC = read('src/reading-lag.js'), TOOL = read('data/bin/vibespace-usage');
  const cut = (txt) => {
    const a = txt.indexOf('// >>> reading-lag mirror'), b = txt.indexOf('// <<< reading-lag mirror');
    return a >= 0 && b > a ? txt.slice(a, b) : null;
  };
  const bSrc = cut(SRC), bTool = cut(TOOL);
  ok('§13 the statusline carries a BYTE-IDENTICAL mirror of the rule (it ships to checkout-less hosts and cannot require src/)',
    !!bSrc && bSrc.length > 2000 && bSrc === bTool, `src=${bSrc && bSrc.length} tool=${bTool && bTool.length}`);
  // …and functionally, over the same table, through the SHIPPED file's own text
  {
    const mod = { exports: {} };
    // the mirror is a block of declarations; evaluate it and hand back the two
    // entry points the statusline uses (this is the SHIPPED bytes, not a copy)
    // eslint-disable-next-line no-new-func
    const f = new Function(bTool + '\nreturn { windowOf, decideLagShadow, decideReadingTarget, compareWindows, weeklyPhase, windowFingerprint };');
    const T = f();
    const table = [
      [{ prevKey: 'a', prevWindow: winA, newKey: 'b', newWindow: winB, readingWindow: { kind: 'sevenDay', resetsAt: W_A }, repointAgeMs: 16000, nowSec }],
      [{ prevKey: 'a', prevWindow: winA, newKey: 'b', newWindow: winB, readingWindow: { kind: 'sevenDay', resetsAt: W_B }, repointAgeMs: 16000, nowSec }],
      [{ prevKey: 'a', prevWindow: winA, newKey: 'b', newWindow: winB, readingWindow: { kind: 'sevenDay', resetsAt: W_A }, repointAgeMs: 11 * 60e3, nowSec }],
      [{ prevKey: 'a', newKey: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: 3000, nowSec }],
      [{ prevKey: 'a', newKey: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'Y', prevFingerprint: 'X', repointAgeMs: 3000, nowSec }],
      // r3: the ORDER of the clock against the windows, and the two ages the
      // reordering gave meaning to (unknown never expires; a negative age is
      // not an age). A one-sided edit of either spelling changes these rows.
      [{ prevKey: 'a', newKey: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: 11 * 60e3, nowSec }],
      [{ prevKey: 'a', newKey: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: null, nowSec }],
      [{ prevKey: 'a', newKey: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, readingFingerprint: 'X', prevFingerprint: 'X', repointAgeMs: -5, nowSec }],
    ];
    const same = table.every(([inp]) => JSON.stringify(T.decideLagShadow(inp)) === JSON.stringify(L.decideLagShadow(inp)));
    ok('§13 …and the two spellings answer the SAME table identically, driven through the shipped file\'s own bytes', same,
      JSON.stringify(table.map(([i]) => [T.decideLagShadow(i).why, L.decideLagShadow(i).why])));
    // …and the GUARD too: r3 moved `decideReadingTarget` INSIDE the sentinels
    // because the statusline now runs it (it was the one value producer with no
    // window guard at all), so its parity is owed the same table.
    {
      const gw = { a: winA, b: winB, c: { sevenDay: W_C, fiveHour: null, scoped: {} } };
      const gtable = [
        { key: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows: gw },
        { key: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_B }, windows: gw },
        { key: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_B + 3 * 86400 }, windows: gw },
        { key: 'b', readingWindow: { kind: 'fiveHour', resetsAt: nowSec + 1800 }, windows: gw },
        { key: 'z', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows: gw },
        { key: 'b', readingWindow: { kind: 'sevenDay', resetsAt: W_A }, windows: { ...gw, d: { sevenDay: W_A + WEEK, fiveHour: null, scoped: {} } } },
      ];
      ok('§13 …including the WINDOW GUARD, which the statusline now runs from the same mirrored bytes',
        gtable.every((i) => JSON.stringify(T.decideReadingTarget(i)) === JSON.stringify(L.decideReadingTarget(i))),
        JSON.stringify(gtable.map((i) => [T.decideReadingTarget(i).action, L.decideReadingTarget(i).action])));
    }
    // the statusline's rate_limits payload shape is one of the shapes windowOf reads
    const rl = { five_hour: { used_percentage: 22, resets_at: 1788850800 }, seven_day: { used_percentage: 93, resets_at: W_A } };
    ok('§13 …including the statusline\'s OWN payload shape (snake_case rate_limits)', T.windowOf(rl).sevenDay === W_A && T.windowOf(rl).fiveHour === 1788850800
      && JSON.stringify(T.windowOf(rl)) === JSON.stringify(L.windowOf(rl)));
    ok('§13 …and the shipped tool USES it (the r3 sidecar now records the window + the instant, and asks the shared rule)',
      /const d = decideLagShadow\(\{/.test(TOOL) && /prevWindow: ownWindowOf\(st\.key\) \|\| st\.win \|\| null/.test(TOOL) && /writeSlotState\(sf, \{ key, fp, win, at: Date\.now\(\) \}/.test(TOOL), '');
  }
  // NEGATIVE CONTROL: the r3-only rule, applied to the incident, does nothing —
  // the numbers moved (0.92 → 0.93), so "same payload" never fires.
  ok('§13 NEGATIVE CONTROL: the r3 rule ALONE (fingerprint equality) cannot see the incident — its numbers changed',
    (function () {
      const preFix = (stKey, key, stFp, fp) => (stKey && stKey !== key && stFp === fp) ? stKey : key;
      return preFix('acct-A', 'acct-B', '-/93', '-/94') === 'acct-B' && s1.key === 'acct-A';
    })());
}

// ── §14 THE INCIDENT, replayed against the REAL engine + REAL pool ──────────
// Mapping to the production names: LINK plays PandyMax (the member actually
// being burned), SPARE plays Personal Max (the member the pool moved TO, and
// the one that was wrongly credited with 93 %), FISH plays Fish Max (where the
// false second switch went).
/** A world whose three members have three DIFFERENT weekly windows, each
 *  stamped as that account's own — which on a real instance is written by
 *  refreshViaCliPanel, the one producer whose key and credential dir are the
 *  same decision (source-pinned in §15). Module-scoped because §15's clobber
 *  leg replays the same incident after a real statusline render. */
const mkIncidentWorld = ({ stampWindows = true } = {}) => {
    const w = mkWorld();
    const nowSec = Math.floor(Date.now() / 1000);
    const WIN = { [w.LINK]: nowSec + 3 * 86400, [w.SPARE]: nowSec + 5 * 86400, [w.FISH]: nowSec + 6 * 86400 };
    const put = (id, u7) => {
      const c = {
        fetchedAt: Date.now() - 60000, source: 'on-demand',
        fiveHour: { utilization: 0.2, resetsAt: nowSec + 2 * 3600 },
        sevenDay: { utilization: u7, resetsAt: WIN[id] },
        scopedWeekly: [{ name: 'Fable', utilization: u7, resetsAt: WIN[id] }],
      };
      w.writeCache(id, c);
      if (stampWindows) w.stampWindow(id, { sevenDay: WIN[id], fiveHour: null, scoped: { fable: WIN[id] } });
    };
    put(w.LINK, 0.98);   // PandyMax: 2 % left — hard dead, the reason the pool moves
    put(w.SPARE, 0.11);  // Personal Max: barely used (the owner's "low-usage account")
    put(w.FISH, 0.33);
    w.am.updatePool(w.P, { auto: true, hot: true });
    return { ...w, WIN, nowSec };
};

{
  // ① THE MOVE. Driven through the pool's own material act — the same call the
  //    engine makes and the ONLY writer of the transition ledger.
  // ② THE LAGGING RESPONSE. Delivered through the REAL producer, carrying
  //    PandyMax's window and PandyMax's 93 % — a response to a request made
  //    39 s earlier with PandyMax's token.
  const play = (w, u) => {
    const cap = quiet();
    w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
    w.am.setPoolTarget(w.P, w.SPARE, { why: 'pool-switch' });
    w.reading(u, { resetsAt: w.WIN[w.LINK] });
    return cap.done();
  };

  // The production numbers were 0.93 / 0.94; the pool's own log line says it
  // switched "from 4.97% left", i.e. the estimator's overlay on top of the 0.94
  // anchor is what carried it past the hard line. This replay uses 0.96 so the
  // SECOND SWITCH does not depend on a learned rate — the shape (a member the
  // panel reads at 11 % suddenly reading ≥ 93 %) is the incident's.
  const POISON = 0.96;
  {
    const w = mkIncidentWorld();
    const lines = play(w, POISON);
    ok('§14 the lagging response lands on the member whose credentials made the request…',
      Math.abs(w.readCache(w.LINK).sevenDay.utilization - POISON) < 1e-9, JSON.stringify(w.readCache(w.LINK).sevenDay));
    ok('§14 …and the member the pool had just moved TO keeps its OWN number (the owner\'s "low-usage account" is not touched)',
      Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9, JSON.stringify(w.readCache(w.SPARE).sevenDay));
    ok('§14 …and it SAYS SO, naming both accounts and how late the response was (a write that moves money is not silent)',
      lines.some((l) => /after the link moved to/.test(l) && /window-of-previous-slot/.test(l)), lines.filter((l) => /\[usage\]/.test(l)).join(' | ').slice(0, 220));
    // the anchors follow the cache, so the estimator trains on the right stream
    w.eng.sweepUsageAnchors();
    const anchorsOf = (id) => {
      const dir = path.join(w.dataDir, 'usage-anchors');
      let out = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/^anchors-.*\.ndjson$/.test(f)) continue;
          for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
            if (!line) continue;
            const r = JSON.parse(line);
            if ((r.accountId || '__global__') === id) out.push(r);
          }
        }
      } catch { }
      return out;
    };
    const aL = anchorsOf(w.LINK), aS = anchorsOf(w.SPARE);
    ok('§14 the ANCHOR lands on that member\'s identity stream too (the estimator learns from the account that was burned)',
      aL.some((r) => Math.abs((r.buckets?.sevenDay?.u ?? -1) - POISON) < 1e-9), JSON.stringify(aL.map((r) => r.buckets?.sevenDay)));
    ok('§14 …and no such anchor is written for the account that did not produce it',
      !aS.some((r) => Math.abs((r.buckets?.sevenDay?.u ?? -1) - POISON) < 1e-9), JSON.stringify(aS.map((r) => r.buckets?.sevenDay)));

    // ③ ZERO SECOND SWITCH. A FRESH engine over the same stores (what a restart
    //    sees — its anti-flap timers are empty, exactly as the real 98-second
    //    gap had let them expire) runs the pool's own evaluation.
    const cap2 = quiet();
    const eng2 = w.mkEngine();
    eng2.maybePoolAutoSwitchForPool(w.P);
    cap2.done();
    ok('§14 ZERO SECOND SWITCH: the pool\'s own evaluation leaves the conversation where it is',
      w.am.poolCurrentFor(w.P, w.SID) === w.SPARE && w.am.poolCurrent(w.P) === w.SPARE,
      `link=${w.am.poolCurrentFor(w.P, w.SID)} default=${w.am.poolCurrent(w.P)} spare=${w.SPARE}`);
  }

  // NEGATIVE CONTROL — the PRE-FIX world, reproduced structurally: no account
  // has an established window (nothing wrote `ownWindow` before this change),
  // so both the shadow and the guard are inert and the incident replays.
  {
    const w = mkIncidentWorld({ stampWindows: false });
    play(w, POISON);
    ok('§14 NEGATIVE CONTROL: with no established windows the other account\'s number lands on the member the pool had just moved to…',
      Math.abs(w.readCache(w.SPARE).sevenDay.utilization - POISON) < 1e-9, JSON.stringify(w.readCache(w.SPARE).sevenDay));
    const cap2 = quiet();
    const eng2 = w.mkEngine();
    eng2.maybePoolAutoSwitchForPool(w.P);
    const lines = cap2.done();
    ok('§14 …and THAT is the second switch, 98 seconds after the first — the whole incident, caused by our own write',
      w.am.poolCurrent(w.P) === w.FISH, `default=${w.am.poolCurrent(w.P)} fish=${w.FISH} | ${lines.filter((l) => /auto-switch/.test(l)).join(' | ')}`);
  }

  // ── WHICH RE-POINT EXPLAINS THIS READING. A conversation with its OWN link is
  //    decided by its own rows; one without is decided by the pool DEFAULT.
  //    Taking "whichever row is newest" would let another session's pool-wide
  //    move explain a reading it had nothing to do with.
  {
    const w = mkIncidentWorld();
    const SID2 = 'sess-r-2';
    const s2 = { ...w.session, _webuiId: SID2, claudeSessionId: 'cid-r-2' };
    w.sessions.set(SID2, s2);                                   // no per-session link: the DEFAULT decides for it
    const cap = quiet();
    w.am.setPoolTarget(w.P, w.SPARE, { why: 'pool-switch' });    // only the default moves
    w.eng.recordRateLimitEvent(s2, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.88, resets_at: w.WIN[w.LINK], resetsAt: w.WIN[w.LINK] } });
    const lines = cap.done();
    ok('§14 a conversation with NO link of its own is shadowed by the POOL DEFAULT\'s move (that is what decides for it)',
      Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.88) < 1e-9 && lines.some((l) => /after the link moved to/.test(l)), JSON.stringify(w.readCache(w.LINK).sevenDay));
    // …and the session that HAS its own link is not explained by that same row
    const w2 = mkIncidentWorld();
    const cap2 = quiet();
    w2.am.setPoolTarget(w2.P, w2.SPARE, { why: 'pool-switch' });  // the DEFAULT moves; SID's own link does NOT
    w2.reading(0.88, { resetsAt: w2.WIN[w2.SPARE] });             // its own credentials are still LINK's, and this reading is SPARE's window
    const l2 = cap2.done();
    ok('§14 …while a conversation that HAS its own link is not explained by a pool-default row it was never subject to',
      !l2.some((l) => /after the link moved to/.test(l)), l2.filter((l) => /\[usage\]/.test(l)).join(' | ').slice(0, 200));
  }

  // ── WHAT ONLY THE SHADOW CAN ANSWER. The guard and the shadow overlap on the
  //    incident (either alone would have kept the 96 % off Personal), so the
  //    shadow's own value has to be shown where the guard is structurally
  //    silent: two members that genuinely SHARE a weekly phase. The window then
  //    says 'agree' about both, and the only evidence left is the r3 clause —
  //    the link moved but the numbers did not.
  {
    const w = mkWorld();
    const nowSec = Math.floor(Date.now() / 1000);
    const SHARED = nowSec + 3 * 86400;                       // ONE phase, two members
    for (const id of [w.LINK, w.SPARE, w.FISH]) {
      w.writeCache(id, {
        fetchedAt: Date.now() - 60000, source: 'on-demand', fiveHour: { utilization: 0.1, resetsAt: nowSec + 3600 },
        sevenDay: { utilization: 0.3, resetsAt: SHARED },
      });
      w.stampWindow(id, { sevenDay: SHARED, fiveHour: null, scoped: {} });
    }
    const cap = quiet();
    w.reading(0.42, { resetsAt: SHARED });                    // seen under LINK
    w.endTurn();
    w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
    w.reading(0.42, { resetsAt: SHARED });                    // the SAME numbers, after the move
    cap.done();
    ok('§14 two members sharing a weekly phase: the window cannot tell them apart, so the r3 clause keeps the identical payload where it was',
      Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.42) < 1e-9 && Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.3) < 1e-9,
      JSON.stringify([w.readCache(w.LINK).sevenDay, w.readCache(w.SPARE).sevenDay]));
    // NEGATIVE CONTROL: the first payload that DIFFERS is the new credentials'
    const w2 = mkWorld();
    for (const id of [w2.LINK, w2.SPARE, w2.FISH]) {
      w2.writeCache(id, {
        fetchedAt: Date.now() - 60000, source: 'on-demand', fiveHour: { utilization: 0.1, resetsAt: nowSec + 3600 },
        sevenDay: { utilization: 0.3, resetsAt: SHARED },
      });
      w2.stampWindow(id, { sevenDay: SHARED, fiveHour: null, scoped: {} });
    }
    const cap2 = quiet();
    w2.reading(0.42, { resetsAt: SHARED });
    w2.endTurn();
    w2.am.ensureSessionPoolLink(w2.P, w2.SID, w2.SPARE, { why: 'per-session-switch' });
    w2.reading(0.43, { resetsAt: SHARED });
    cap2.done();
    ok('§14 NEGATIVE CONTROL: …and a payload that DID move is the new slot\'s — the shadow ends on the first differing reading',
      Math.abs(w2.readCache(w2.SPARE).sevenDay.utilization - 0.43) < 1e-9, JSON.stringify(w2.readCache(w2.SPARE).sevenDay));
  }

  // ── THE SECOND BRANCH: a reading that is NOT lagging, filed on a slot a
  //    STALE TURN PIN still holds. Measured on this instance at 06:10:46Z: a
  //    turn that began before three re-points kept filing one member's fresh
  //    numbers on another for its whole life. No re-point is recent, so the
  //    shadow cannot speak — the window guard is what catches this one.
  {
    const w = mkIncidentWorld();
    const cap = quiet();
    w.reading(0.20, { resetsAt: w.WIN[w.LINK] });          // pins LINK for the turn
    w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
    w.am.setPoolTarget(w.P, w.SPARE, { why: 'pool-switch' });
    // the turn never ends — the pin still says LINK while the credentials are SPARE's
    w.reading(0.44, { resetsAt: w.WIN[w.SPARE] });
    const lines = cap.done();
    ok('§14 STALE TURN PIN: a reading whose window is the NEW member\'s is filed there, whatever the pin says',
      Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.44) < 1e-9, JSON.stringify(w.readCache(w.SPARE).sevenDay));
    ok('§14 …and the pinned member does not receive it', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.20) < 1e-9, JSON.stringify(w.readCache(w.LINK).sevenDay));
    ok('§14 …the re-file is SPOKEN, naming both accounts', lines.some((l) => /window says these numbers are/.test(l) && /re-filed/.test(l)), lines.filter((l) => /\[usage\]/.test(l)).join(' | ').slice(0, 200));
    ok('§14 …and the pin follows the evidence, so the REST of the turn bills where its requests actually go',
      w.eng.readingSlotFor(w.session).key === w.SPARE, JSON.stringify(w.eng.readingSlotFor(w.session)));
  }
}

// ── §15 THE WINDOW GUARD in the live producers ─────────────────────────────
{
  const nowSec = Math.floor(Date.now() / 1000);
  const mk = () => {
    const w = mkWorld();
    const WIN = { [w.LINK]: nowSec + 3 * 86400, [w.SPARE]: nowSec + 5 * 86400, [w.FISH]: nowSec + 6 * 86400 };
    for (const id of [w.LINK, w.SPARE, w.FISH]) {
      w.writeCache(id, {
        fetchedAt: Date.now() - 60000, source: 'on-demand',
        fiveHour: { utilization: 0.1, resetsAt: nowSec + 3600 }, sevenDay: { utilization: 0.3, resetsAt: WIN[id] },
      });
      w.stampWindow(id, { sevenDay: WIN[id], fiveHour: null, scoped: {} });
    }
    return { ...w, WIN };
  };
  // ARCHIVE: a window nobody owns is never written, and never destroyed
  {
    const w = mk(); const cap = quiet();
    w.reading(0.77, { resetsAt: nowSec + 9 * 86400 });
    const lines = cap.done();
    ok('§15 a reading whose window belongs to NO known account is refused', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.3) < 1e-9, JSON.stringify(w.readCache(w.LINK).sevenDay));
    const arch = path.join(w.dataDir, 'archive', 'readings-window-mismatch.ndjson');
    const rows = fs.existsSync(arch) ? fs.readFileSync(arch, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    ok('§15 …ARCHIVED with the reason, the session, and the target\'s own window (never destroyed)',
      rows.length === 1 && /matches no known account/.test(rows[0].reason) && rows[0].sid === w.SID && rows[0].ownWindow && rows[0].entry, JSON.stringify(rows[0] && rows[0].reason));
    ok('§15 …and SPOKEN once', lines.some((l) => /refusing to write/.test(l)), lines.filter((l) => /\[usage\]/.test(l)).join(' | ').slice(0, 200));
  }
  // INERT where there is no evidence — the guard must not delete data it cannot judge
  {
    const w = mkWorld(); const cap = quiet();   // no ownWindow anywhere
    w.reading(0.61); cap.done();
    ok('§15 with no established window the guard is INERT (no evidence, no refusal)', Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.61) < 1e-9);
  }
  // a reading that AGREES is untouched, and a rejection is never window-guarded
  {
    const w = mk(); const cap = quiet();
    w.reading(0.55, { resetsAt: w.WIN[w.LINK] });
    w.eng.recordRateLimitEvent(w.session, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resets_at: nowSec + 9 * 86400, resetsAt: nowSec + 9 * 86400 } });
    cap.done();
    ok('§15 a reading that agrees with the target is written unchanged', w.readCache(w.LINK).sevenDay.utilization === 1 || Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.55) < 1e-9);
    ok('§15 a REJECTION is deliberately NOT window-guarded — its resetsAt is frequently a bounded guess, and its identity has the turn-pinned rejection slot',
      w.readCache(w.LINK).sevenDay.utilization === 1 && w.readCache(w.LINK).sevenDay.status === 'limited', JSON.stringify(w.readCache(w.LINK).sevenDay));
  }
  // the established window may only be written by the panel refresh, and the
  // session-attributed producers must PRESERVE it (dropping it disarms the guard)
  {
    const w = mk(); const cap = quiet();
    w.reading(0.51, { resetsAt: w.WIN[w.LINK] });
    w.banner();
    cap.done();
    ok('§15 the established window survives a rate-limit-event write (which is based on the identity group\'s FRESHEST sibling)', !!w.readWindow(w.LINK)?.sevenDay, JSON.stringify(Object.keys(w.readCache(w.LINK))));
    ok('§15 …and a limit-banner write', !!w.readWindow(w.LINK)?.sevenDay);
    ok('§15 …because it is NOT a field of the snapshot those producers rewrite (that is what let one statusline render disarm the whole guard)',
      w.readCache(w.LINK).ownWindow === undefined, JSON.stringify(Object.keys(w.readCache(w.LINK))));
    const ur = read('src/usage-routes.js');
    ok('§15 SOURCE PIN: the ONLY producer that writes the window sidecar is the panel refresh — the one whose key and credential dir are the same decision',
      /windowSidecarName\(key\)/.test(ur) && /source: 'on-demand'/.test(ur)
      && !/windowSidecarName/.test(code('src/rate-limit-capture.js')), '');
    ok('§15 …and it is never READ BACK from `sevenDay.resetsAt` (the field a mis-filed reading overwrites — that would let one bad write redefine the account)',
      /readingLag\.windowSidecarName\(key\)/.test(code('src/server/usage-pool-engine.js')) && !/ownWindow = .*sevenDay\.resetsAt/.test(code('src/server/usage-pool-engine.js')));
  }

  // ── THE CLOBBER (r2, reproduced). The window used to be a FIELD of the
  //    usage-cache snapshot, and EVERY reading producer rebuilds that object
  //    whole. The highest-frequency one is the SHIPPED statusline hook — once
  //    per 8 s per account — whose `out` literal preserves scopedWeekly / the
  //    org identity / spend one field at a time and simply never listed the
  //    window. One ordinary, entirely legitimate render therefore deleted every
  //    established window on the instance, and the incident replayed with its
  //    second false switch. Driven through the SHIPPED FILE'S OWN BYTES,
  //    because that file is the writer.
  {
    const runTool = (toolPath, w, id, sevenDayReset, pct) => {
      const f = path.join(w.cacheDir, id + '.json');
      const cur = w.readCache(id);
      const old = new Date(Date.now() - 60000); fs.utimesSync(f, old, old);   // past THROTTLE_MS
      cp.execFileSync(process.execPath, [toolPath], {
        input: JSON.stringify({ model: { id: 'claude-fable-5' }, rate_limits: {
          five_hour: { used_percentage: 20, resets_at: cur.fiveHour.resetsAt },
          seven_day: { used_percentage: pct, resets_at: sevenDayReset } } }),
        env: { ...process.env, VIBESPACE_USAGE_CACHE: w.cacheDir, VIBESPACE_ACCOUNT_KEY: id }, encoding: 'utf8',
      });
    };
    const TOOL_PATH = path.join(REPO, 'data/bin/vibespace-usage');
    const w = mkIncidentWorld();
    const before = [w.LINK, w.SPARE, w.FISH].map((id) => !!w.readWindow(id)?.sevenDay);
    for (const id of [w.LINK, w.SPARE, w.FISH]) runTool(TOOL_PATH, w, id, w.WIN[id], Math.round(w.readCache(id).sevenDay.utilization * 100));
    const after = [w.LINK, w.SPARE, w.FISH].map((id) => !!w.readWindow(id)?.sevenDay);
    ok('§15 CLOBBER: one legitimate statusline render per member leaves every established window intact (pre-fix: all three deleted)',
      before.every(Boolean) && after.every(Boolean), JSON.stringify([before, after]));
    ok('§15 …and the renders really happened (a leg that measures nothing would pass too)',
      [w.LINK, w.SPARE, w.FISH].every((id) => w.readCache(id).source === 'passive'),
      JSON.stringify([w.LINK, w.SPARE, w.FISH].map((id) => w.readCache(id).source)));
    ok('§15 …the sidecar stays invisible to every usage-cache scanner (they all filter on `.json`, like the `.slot-` sidecar beside it)',
      !readingLag.windowSidecarName(w.LINK).endsWith('.json')
      && fs.existsSync(path.join(w.cacheDir, readingLag.windowSidecarName(w.LINK)))
      && fs.readdirSync(w.cacheDir).filter((f) => f.endsWith('.json')).every((f) => !f.startsWith('.window-')));
    // …so the incident STILL does not replay AFTER the render
    const cap = quiet();
    w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
    w.am.setPoolTarget(w.P, w.SPARE, { why: 'pool-switch' });
    w.reading(0.96, { resetsAt: w.WIN[w.LINK] });
    const eng2 = w.mkEngine(); eng2.maybePoolAutoSwitchForPool(w.P);
    cap.done();
    ok('§15 …so the lagging response is STILL filed on the member whose credentials made the request',
      Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.96) < 1e-9 && Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9,
      JSON.stringify([w.readCache(w.LINK).sevenDay, w.readCache(w.SPARE).sevenDay]));
    ok('§15 …and there is NO second switch', w.am.poolCurrent(w.P) === w.SPARE, `default=${w.am.poolCurrent(w.P)} spare=${w.SPARE} fish=${w.FISH}`);

    // NEGATIVE CONTROL — a PATCHED COPY of the shipped tool with the storage
    // decision reverted (the window read back out of the snapshot, as it was),
    // over a snapshot carrying the window: the SAME `out` literal deletes it.
    // The patch is asserted to have hit, so this can never silently become a
    // second green arm.
    const w2 = mkIncidentWorld();
    const shipped = read('data/bin/vibespace-usage');
    const NEEDLE = "const w = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, windowSidecarName(key)), 'utf-8'));";
    ok('§15 NEGATIVE CONTROL setup: the storage decision is a single line in the shipped tool (the patch below must hit it)',
      shipped.split(NEEDLE).length === 2, '');
    const preFixTool = path.join(w2.root, 'vibespace-usage.prefix');
    fs.writeFileSync(preFixTool, shipped.replace(NEEDLE,
      "const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, String(key).replace(/[^\\w.-]/g, '_') + '.json'), 'utf-8')); const w = c && c.ownWindow;"), { mode: 0o755 });
    for (const id of [w2.LINK, w2.SPARE, w2.FISH]) {         // put the window back IN the snapshot, pre-fix style
      const c = w2.readCache(id);
      c.ownWindow = { sevenDay: w2.WIN[id], fiveHour: null, scoped: { fable: w2.WIN[id] }, at: Date.now(), source: 'on-demand' };
      w2.writeCache(id, c);
      fs.rmSync(path.join(w2.cacheDir, readingLag.windowSidecarName(id)), { force: true });
    }
    const before2 = [w2.LINK, w2.SPARE, w2.FISH].map((id) => !!w2.readCache(id).ownWindow);
    for (const id of [w2.LINK, w2.SPARE, w2.FISH]) runTool(preFixTool, w2, id, w2.WIN[id], Math.round(w2.readCache(id).sevenDay.utilization * 100));
    const after2 = [w2.LINK, w2.SPARE, w2.FISH].map((id) => !!w2.readCache(id).ownWindow);
    ok('§15 NEGATIVE CONTROL: with the window back in the snapshot, one render of the SAME `out` literal deletes all three',
      before2.every(Boolean) && after2.every((x) => x === false), JSON.stringify([before2, after2]));
    const cap2 = quiet();
    w2.am.ensureSessionPoolLink(w2.P, w2.SID, w2.SPARE, { why: 'per-session-switch' });
    w2.am.setPoolTarget(w2.P, w2.SPARE, { why: 'pool-switch' });
    w2.reading(0.96, { resetsAt: w2.WIN[w2.LINK] });
    const eng3 = w2.mkEngine(); eng3.maybePoolAutoSwitchForPool(w2.P);
    cap2.done();
    ok('§15 …and THAT is the whole incident again — the poison lands on the low-usage account and the pool makes its SECOND false switch',
      Math.abs(w2.readCache(w2.SPARE).sevenDay.utilization - 0.96) < 1e-9 && w2.am.poolCurrent(w2.P) === w2.FISH,
      `spare7d=${w2.readCache(w2.SPARE).sevenDay.utilization} default=${w2.am.poolCurrent(w2.P)} fish=${w2.FISH}`);
  }

  // ── r3: THE STATUSLINE OF A POOLED TERMINAL SESSION. Everything above drives
  //    the tool WITHOUT `VIBESPACE_ACCOUNT_LINK`, so no leg had ever reached the
  //    `.slot-<id>` branch — the one that decides which member a pooled
  //    terminal's numbers are filed on. Three defects lived behind it, and each
  //    gets its OWN leg with its OWN single-mechanism negative control (a
  //    patched copy of the shipped file, the patch asserted to hit), because a
  //    control that reverts two mechanisms cannot tell them apart.
  {
    const TOOL_PATH = path.join(REPO, 'data/bin/vibespace-usage');
    const shipped = read('data/bin/vibespace-usage');
    /** ONE ordinary statusline render of a pooled TERMINAL session, driven
     *  through the given file's OWN BYTES with the link env the spawn sets. */
    const renderPooled = (toolPath, w, { pct, sevenDayReset, slotFp, slotAtMinutesAgo, ages = [] }) => {
      const rl = {
        five_hour: { used_percentage: 20, resets_at: w.nowSec + 2 * 3600 },
        seven_day: { used_percentage: pct, resets_at: sevenDayReset },
      };
      const sf = path.join(w.cacheDir, '.slot-' + w.CID.replace(/[^\w.-]/g, '_'));
      fs.writeFileSync(sf, JSON.stringify({
        key: w.LINK,
        fp: slotFp === 'same' ? `20/${rl.five_hour.resets_at}|${pct}/${sevenDayReset}` : 'an-older-payload',
        win: { sevenDay: w.WIN[w.LINK], fiveHour: null, scoped: {} },
        at: Date.now() - slotAtMinutesAgo * 60e3,
      }));
      for (const id of ages) {                       // past THROTTLE_MS, or the write is skipped
        const f = path.join(w.cacheDir, id + '.json');
        const old = new Date(Date.now() - 60000); fs.utimesSync(f, old, old);
      }
      cp.execFileSync(process.execPath, [toolPath], {
        input: JSON.stringify({ session_id: w.CID, model: { id: 'claude-fable-5' }, rate_limits: rl }),
        env: { ...process.env, VIBESPACE_USAGE_CACHE: w.cacheDir, VIBESPACE_ACCOUNT_KEY: w.LINK,
          VIBESPACE_ACCOUNT_LINK: w.am.sessionPoolLinkPath(w.P, w.SID) },
        encoding: 'utf8',
      });
    };
    /** The pool's move, then the render, then the pool's own re-evaluation on a
     *  FRESH engine (what a restart sees — the real 98-second gap had let the
     *  anti-flap timers expire). `repointMinutesAgo` back-dates the LINK the
     *  pool re-minted, which is the only honest clock this tool has. */
    const playPooled = (toolPath, w, opts) => {
      const cap = quiet();
      w.am.ensureSessionPoolLink(w.P, w.SID, w.SPARE, { why: 'per-session-switch' });
      w.am.setPoolTarget(w.P, w.SPARE, { why: 'pool-switch' });
      if (opts.repointMinutesAgo) {
        const t = Date.now() / 1000 - opts.repointMinutesAgo * 60;
        fs.lutimesSync(w.am.sessionPoolLinkPath(w.P, w.SID), t, t);
      }
      renderPooled(toolPath, w, opts);
      const eng2 = w.mkEngine(); eng2.maybePoolAutoSwitchForPool(w.P);
      cap.done();
    };

    // ① THE WINDOW OUTRANKS THE CLOCK. An IDLE pooled terminal: the pool moved
    //    LINK → SPARE 30 minutes ago, the CLI has made no request since, so its
    //    `rate_limits` still carries LINK's numbers counted in LINK's window.
    //    The re-point is genuinely old — and the window still says whose
    //    credentials produced these numbers.
    const slotStateOf = (w) => { try { return JSON.parse(fs.readFileSync(path.join(w.cacheDir, '.slot-' + w.CID.replace(/[^\w.-]/g, '_')), 'utf8')); } catch { return null; } };
    {
      const w = mkIncidentWorld();
      playPooled(TOOL_PATH, w, { pct: 96, sevenDayReset: w.WIN[w.LINK], slotFp: 'differs', slotAtMinutesAgo: 30, repointMinutesAgo: 30, ages: [w.LINK, w.SPARE, w.FISH] });
      ok('§15 POOLED STATUSLINE: a render whose window is the PREVIOUS slot\'s leaves the low-usage member alone, however old the re-point is',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9, JSON.stringify(w.readCache(w.SPARE).sevenDay));
      ok('§15 …and it is SHADOWED, not re-filed: the shadow leaves the numbers where they were, so neither cache moves',
        slotStateOf(w)?.key === w.LINK && Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.98) < 1e-9,
        JSON.stringify([slotStateOf(w)?.key === w.LINK, w.readCache(w.LINK).sevenDay]));
      ok('§15 …so the pool makes NO second switch', w.am.poolCurrent(w.P) === w.SPARE,
        `default=${w.am.poolCurrent(w.P)} spare=${w.SPARE} fish=${w.FISH}`);
    }
    // NEGATIVE CONTROL — the PRE-FIX ORDERING only (the clock short-circuits
    // above every window rung). Measured at the SHADOW's own output, because
    // the guard added below is a SECOND barrier against the same harm and would
    // otherwise mask this one: a control that reverts one mechanism must be
    // read where that mechanism speaks, and the money is judged by the control
    // that reverts BOTH (next block).
    const NEW_BOUND = "  if (repointAgeMs != null && (!(Number(repointAgeMs) >= 0) || Number(repointAgeMs) > shadowMs)) return { key: newKey, shadowed: false, why: 'shadow-expired', cmpPrev, cmpNew };\n";
    const NO_REPOINT = "  if (!prevKey || !newKey || prevKey === newKey) return { key: newKey, shadowed: false, why: 'no-repoint' };\n";
    const OLD_BOUND = "  if (!(Number(repointAgeMs) >= 0) || Number(repointAgeMs) > shadowMs) return { key: newKey, shadowed: false, why: 'shadow-expired' };\n";
    const GUARD_ASK = "    const d = decideReadingTarget({ key, readingWindow: windowOf(rl), windows: establishedWindows() });\n";
    const GUARD_OFF = "    const d = { action: 'write', key, reason: 'pre-fix: this producer had no window guard', matched: [] };\n";
    const clockFirst = (txt) => txt.replace(NEW_BOUND, '').replace(NO_REPOINT, NO_REPOINT + OLD_BOUND);
    ok('§15 NEGATIVE CONTROL setup: the clock bound, the no-repoint rung and the guard call are each a single line in the shipped tool (every patch below must hit)',
      shipped.split(NEW_BOUND).length === 2 && shipped.split(NO_REPOINT).length === 2 && shipped.split(GUARD_ASK).length === 2, '');
    {
      const w = mkIncidentWorld();
      const preFix = path.join(w.root, 'vibespace-usage.clock-first');
      fs.writeFileSync(preFix, clockFirst(shipped), { mode: 0o755 });
      playPooled(preFix, w, { pct: 96, sevenDayReset: w.WIN[w.LINK], slotFp: 'differs', slotAtMinutesAgo: 30, repointMinutesAgo: 30, ages: [w.LINK, w.SPARE, w.FISH] });
      ok('§15 NEGATIVE CONTROL: with the clock ranked ABOVE the windows the shadow is gone — the conversation is re-keyed onto the member the pool moved to, whose credentials produced none of it',
        slotStateOf(w)?.key === w.SPARE, JSON.stringify(slotStateOf(w)));
    }
    // …and THAT is the money, once the second barrier is down too: the PRE-FIX
    // file — the ordering as it shipped, and the producer with no guard at all.
    {
      const w = mkIncidentWorld();
      const preFix = path.join(w.root, 'vibespace-usage.prefix-both');
      fs.writeFileSync(preFix, clockFirst(shipped).replace(GUARD_ASK, GUARD_OFF), { mode: 0o755 });
      playPooled(preFix, w, { pct: 96, sevenDayReset: w.WIN[w.LINK], slotFp: 'differs', slotAtMinutesAgo: 30, repointMinutesAgo: 30, ages: [w.LINK, w.SPARE, w.FISH] });
      ok('§15 NEGATIVE CONTROL: the PRE-FIX statusline files the previous member\'s 96 % on the low-usage one and the pool makes its SECOND false switch — one ordinary render of an idle terminal',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.96) < 1e-9 && w.am.poolCurrent(w.P) === w.FISH,
        `spare7d=${w.readCache(w.SPARE).sevenDay.utilization} default=${w.am.poolCurrent(w.P)} fish=${w.FISH}`);
    }

    // ② THE CLOCK SOURCE. With NO established windows (a fresh instance, or any
    //    account whose panel has not refreshed yet) the rule falls to the r3
    //    identical-payload clause, and THAT is where the age is load-bearing.
    //    The link moved one second ago; the conversation's last render was 30
    //    minutes ago. Only one of those two numbers is a re-point age.
    {
      const w = mkIncidentWorld({ stampWindows: false });
      playPooled(TOOL_PATH, w, { pct: 96, sevenDayReset: w.WIN[w.LINK], slotFp: 'same', slotAtMinutesAgo: 30, ages: [w.LINK, w.SPARE, w.FISH] });
      ok('§15 CLOCK SOURCE: with no windows at all, an idle terminal\'s unchanged payload is still the previous slot\'s — the r3 protection master shipped is intact',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9 && w.am.poolCurrent(w.P) === w.SPARE,
        `spare7d=${w.readCache(w.SPARE).sevenDay.utilization} default=${w.am.poolCurrent(w.P)}`);
    }
    // NEGATIVE CONTROL — the OBSERVATION age only (the shipped ordering stays).
    {
      const w = mkIncidentWorld({ stampWindows: false });
      const NEW_SRC = '          repointAgeMs: repointAgeMs(),';
      const OLD_SRC = '          repointAgeMs: Date.now() - (Number(st.at) || Date.now()),';
      ok('§15 NEGATIVE CONTROL setup: the re-point age has ONE source in the shipped tool (the patch below must hit it)',
        shipped.split(NEW_SRC).length === 2, '');
      const preFix = path.join(w.root, 'vibespace-usage.observation-age');
      fs.writeFileSync(preFix, shipped.replace(NEW_SRC, OLD_SRC), { mode: 0o755 });
      playPooled(preFix, w, { pct: 96, sevenDayReset: w.WIN[w.LINK], slotFp: 'same', slotAtMinutesAgo: 30, ages: [w.LINK, w.SPARE, w.FISH] });
      ok('§15 NEGATIVE CONTROL: fed its own OBSERVATION age instead of the re-point\'s, the same render expires a shadow that had not started — 96 % onto the low-usage member, and the SECOND false switch',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.96) < 1e-9 && w.am.poolCurrent(w.P) === w.FISH,
        `spare7d=${w.readCache(w.SPARE).sevenDay.utilization} default=${w.am.poolCurrent(w.P)} fish=${w.FISH}`);
    }

    // ③ THE GUARD IN THE 8×/MINUTE PRODUCER. The shadow only speaks when a
    //    re-point can explain the reading; every other path through this file
    //    wrote whatever `accountKey()` resolved. A session with NO link at all
    //    (not pooled, or a link we cannot read) is the plainest of them.
    const renderKeyed = (toolPath, w, key, { pct, sevenDayReset }) => {
      for (const id of [w.LINK, w.SPARE, w.FISH]) {
        const f = path.join(w.cacheDir, id + '.json');
        const old = new Date(Date.now() - 60000); fs.utimesSync(f, old, old);
      }
      cp.execFileSync(process.execPath, [toolPath], {
        input: JSON.stringify({ model: { id: 'claude-fable-5' }, rate_limits: {
          five_hour: { used_percentage: 20, resets_at: w.nowSec + 2 * 3600 },
          seven_day: { used_percentage: pct, resets_at: sevenDayReset } } }),
        env: { ...process.env, VIBESPACE_USAGE_CACHE: w.cacheDir, VIBESPACE_ACCOUNT_KEY: key },
        encoding: 'utf8',
      });
    };
    {
      const w = mkIncidentWorld();
      renderKeyed(TOOL_PATH, w, w.SPARE, { pct: 96, sevenDayReset: w.WIN[w.LINK] });   // SPARE's key, LINK's WEEK
      ok('§15 STATUSLINE GUARD: a reading whose weekly window is another member\'s is re-filed there, not written to the key the spawn handed us',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9 && Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.96) < 1e-9,
        JSON.stringify([w.readCache(w.SPARE).sevenDay, w.readCache(w.LINK).sevenDay]));
      const readRefused = () => { try { return fs.readFileSync(path.join(w.cacheDir, '.window-refused.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
      const refused = readRefused();
      ok('§15 …and the move is WRITTEN DOWN with its reason, beside the cache and invisible to every `.json` scanner',
        refused.length === 1 && refused[0].action === 'refile' && refused[0].key === w.SPARE && refused[0].to === w.LINK && /matches exactly one account/.test(refused[0].reason)
        && !'.window-refused.ndjson'.endsWith('.json'), JSON.stringify(refused));
      // …and it is a SAMPLE, not a count: a statusline is a fresh process per
      // render, so it cannot hold the engine's per-verdict memory, and a
      // persistent mismatch at the 8 s cadence would otherwise write ~11 500
      // lines a day. The line SAYS it is sampled, so nobody reads it as a count.
      renderKeyed(TOOL_PATH, w, w.SPARE, { pct: 97, sevenDayReset: w.WIN[w.LINK] });
      ok('§15 …once per 60 s, and the line says so — a repeated refusal keeps the fact and drops the repetition',
        readRefused().length === 1 && refused[0].sampled === '<=1/60s'
        && Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9,   // …and it still refused the second one
        JSON.stringify(readRefused()));
    }
    {
      const w = mkIncidentWorld();
      // nobody's week: the three members are +3/+5/+6 days, and the comparison
      // is by PHASE (mod one week), so a stranger's reset must be phase-distinct
      // — +40 days is +5 days plus five whole weeks, i.e. B-Stack's own phase.
      renderKeyed(TOOL_PATH, w, w.SPARE, { pct: 96, sevenDayReset: w.nowSec + 1 * 86400 });
      ok('§15 …a reading whose window matches NOBODY is refused outright — nothing is written anywhere',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.11) < 1e-9
        && Math.abs(w.readCache(w.LINK).sevenDay.utilization - 0.98) < 1e-9
        && Math.abs(w.readCache(w.FISH).sevenDay.utilization - 0.33) < 1e-9,
        JSON.stringify([w.readCache(w.SPARE).sevenDay.utilization, w.readCache(w.LINK).sevenDay.utilization, w.readCache(w.FISH).sevenDay.utilization]));
    }
    {   // NO EVIDENCE ⇒ NO REFUSAL, both ways: an agreeing window, and no windows at all
      const w = mkIncidentWorld();
      renderKeyed(TOOL_PATH, w, w.SPARE, { pct: 42, sevenDayReset: w.WIN[w.SPARE] });
      ok('§15 …while a reading that AGREES with the target is written unchanged',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.42) < 1e-9 && w.readCache(w.SPARE).source === 'passive',
        JSON.stringify(w.readCache(w.SPARE).sevenDay));
      const w4 = mkIncidentWorld({ stampWindows: false });
      renderKeyed(TOOL_PATH, w4, w4.SPARE, { pct: 96, sevenDayReset: w4.WIN[w4.LINK] });
      ok('§15 …and with NO established windows the guard is INERT, so an instance that has never refreshed a panel behaves exactly as before',
        Math.abs(w4.readCache(w4.SPARE).sevenDay.utilization - 0.96) < 1e-9, JSON.stringify(w4.readCache(w4.SPARE).sevenDay));
    }
    // NEGATIVE CONTROL — the guard removed from the shipped file, nothing else.
    {
      const w = mkIncidentWorld();
      const preFix = path.join(w.root, 'vibespace-usage.no-guard');
      fs.writeFileSync(preFix, shipped.replace(GUARD_ASK, GUARD_OFF), { mode: 0o755 });
      renderKeyed(preFix, w, w.SPARE, { pct: 96, sevenDayReset: w.WIN[w.LINK] });
      ok('§15 NEGATIVE CONTROL: without it, the highest-frequency producer on the instance writes another member\'s numbers onto whatever key its spawn was given',
        Math.abs(w.readCache(w.SPARE).sevenDay.utilization - 0.96) < 1e-9, JSON.stringify(w.readCache(w.SPARE).sevenDay));
    }
    // SOURCE PINS — each fix is one line, and each is the kind a later edit
    // "simplifies" back. The rule they enforce is in the module's own header.
    ok('§15 SOURCE PIN: the shipped tool dates the RE-POINT from the link the pool re-minted, and keeps `st.at` only as forensics',
      /fs\.lstatSync\(process\.env\.VIBESPACE_ACCOUNT_LINK\)\.mtimeMs/.test(shipped)
      && /repointAgeMs: repointAgeMs\(\),/.test(shipped)
      && !/repointAgeMs: Date\.now\(\) - \(Number\(st\.at\)/.test(shipped)
      && /at: Date\.now\(\) \}/.test(shipped), '');
    ok('§15 SOURCE PIN: in BOTH spellings the clock bound sits BELOW the two window rungs, and a null age does not expire',
      [read('src/reading-lag.js'), shipped].every((txt) => {
        const w1 = txt.indexOf("why: 'window-of-previous-slot'");
        const w2 = txt.indexOf("why: 'window-of-new-slot'");
        const cl = txt.indexOf("why: 'shadow-expired'");
        return w1 > 0 && w2 > w1 && cl > w2 && /repointAgeMs != null && \(!\(Number\(repointAgeMs\) >= 0\)/.test(txt);
      }), '');
  }

  // ── THE FIVE-HOUR RUNG (r2, reproduced), through the REAL producer. A
  //    `five_hour` rate_limit_event of the session's OWN slot must stay there
  //    even when a sibling's stamped 5h lines up with it: 5h resets snap to the
  //    clock (47 colliding values in this instance's corpus) and drift from the
  //    account's own stamped value on 7.2 %/7.4 % of the two busiest streams,
  //    so the rung that used to answer here invented the very misattribution
  //    the guard exists to prevent (50 real moments in the same corpus).
  {
    const now5 = Math.floor(Date.now() / 1000);
    const LINK_5H = now5 + 1800, SPARE_5H = now5 + 7200;   // LINK is really in the block SPARE's window names
    /** The windows are built PER WORLD — every mkWorld() mints new account ids,
     *  and a map keyed by another world's ids yields `undefined` windows, i.e.
     *  a leg that quietly tests nothing. */
    const mk5 = () => {
      const w = mkWorld();
      const W7 = { [w.LINK]: now5 + 3 * 86400, [w.SPARE]: now5 + 5 * 86400, [w.FISH]: now5 + 6 * 86400 };
      const own5 = { [w.LINK]: LINK_5H, [w.SPARE]: SPARE_5H, [w.FISH]: now5 - 3600 };
      for (const id of [w.LINK, w.SPARE, w.FISH]) {
        w.writeCache(id, { fetchedAt: Date.now() - 60000, source: 'on-demand', fiveHour: { utilization: 0.2, resetsAt: own5[id] }, sevenDay: { utilization: 0.3, resetsAt: W7[id] } });
        w.stampWindow(id, { sevenDay: W7[id], fiveHour: own5[id], scoped: {} });
      }
      return { ...w, W7, own5 };
    };
    const w = mk5();
    const cap = quiet();
    w.eng.recordRateLimitEvent(w.session, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.55, resets_at: SPARE_5H, resetsAt: SPARE_5H } });
    const lines = cap.done();
    ok('§15 FIVE-HOUR: a `five_hour` reading of the session\'s OWN slot is not stolen by a sibling whose stamped 5h lines up',
      Math.abs(w.readCache(w.LINK).fiveHour.utilization - 0.55) < 1e-9, JSON.stringify(w.readCache(w.LINK).fiveHour));
    ok('§15 …the sibling received nothing', Math.abs(w.readCache(w.SPARE).fiveHour.utilization - 0.2) < 1e-9, JSON.stringify(w.readCache(w.SPARE).fiveHour));
    ok('§15 …and nothing was archived either (with one sibling matching this was a re-file; with none it would have been a silent DROP of fresh evidence)',
      !fs.existsSync(path.join(w.dataDir, 'archive', 'readings-window-mismatch.ndjson')));
    ok('§15 …and the guard said nothing about it', !lines.some((l) => /window says these numbers|refusing to write/.test(l)), lines.filter((l) => /\[usage\]/.test(l)).join(' | ').slice(0, 200));
    // the WEEKLY guard is still armed in the very same world (the 5h rung was
    // removed, not the guard) — otherwise this leg would pass on a dead guard
    const w3 = mk5();
    const cap3 = quiet();
    w3.reading(0.66, { resetsAt: w3.W7[w3.SPARE] });       // LINK's slot, SPARE's WEEK
    cap3.done();
    ok('§15 POSITIVE CONTROL: in the same world a WEEKLY reading that is not the target\'s is still re-filed (only the 5h rung was retired)',
      Math.abs(w3.readCache(w3.SPARE).sevenDay.utilization - 0.66) < 1e-9 && Math.abs(w3.readCache(w3.LINK).sevenDay.utilization - 0.3) < 1e-9,
      JSON.stringify([w3.readCache(w3.LINK).sevenDay, w3.readCache(w3.SPARE).sevenDay]));
  }
}

// ── §16 THE WINDOW REPAIR, on a fixture shaped like this instance's stores ──
// The 2026-09-07 repair acted only where a member's own credential file DATED
// its death (`members:1` on this instance), so everything mis-filed between two
// LOGGED-IN accounts survived it. The window is the evidence it lacked.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-winrepair-')); cleanup.push(d);
  const dataDir = path.join(d, 'data');
  const anchors = path.join(dataDir, 'usage-anchors'), cache = path.join(dataDir, 'usage-cache');
  for (const p of [anchors, cache]) fs.mkdirSync(p, { recursive: true });
  const A = 'sub-aaaaaaaaaaaa', B = 'sub-bbbbbbbbbbbb', GONE = 'sub-cccccccccccc';
  const WA = 1789030800, WB = 1789142400, WGONE = WA + 604800;  // GONE shares A's PHASE, on purpose
  const T0 = Date.parse('2026-09-08T00:00:00Z');
  const rec = (acct, ident, ts, u, resetsAt, source = 'on-demand', extra = {}) => ({
    ts, fetchedAt: ts, source, accountId: acct, identityKey: ident,
    buckets: { fiveHour: { u: 0.2, resetsAt: 1 }, sevenDay: { u, resetsAt }, scopedWeekly: [] },
    prevFetchedAt: null, elapsedSec: null, costSince: null, ...extra,
  });
  const writeStream = (ident, rows) => fs.writeFileSync(path.join(anchors, `anchors-${ident}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // A: 8 honest panel readings + a chained pair whose FIRST half is foreign
  const aRows = [];
  for (let i = 0; i < 8; i++) aRows.push(rec(A, 'org_aaaa', T0 + i * 60000, 0.1 + i * 0.01, i % 2 ? WA : WA - 60));
  aRows.push(rec(A, 'org_aaaa', T0 + 9 * 60000, 0.9, WB, 'rate-limit-event'));                 // ← B's window, filed on A
  aRows.push({ ...rec(A, 'org_aaaa', T0 + 10 * 60000, 0.2, WA, 'rate-limit-event'), prevFetchedAt: T0 + 9 * 60000, elapsedSec: 60, costSince: { total: 7 } });
  writeStream('org_aaaa', aRows);
  // B: 8 honest panel readings
  writeStream('org_bbbb', Array.from({ length: 8 }, (_, i) => rec(B, 'org_bbbb', T0 + i * 60000, 0.5, i % 2 ? WB : WB - 60)));
  // a REMOVED account's stream that shares A's weekly phase — it must never be
  // a re-file target, and its own rows must not be judged (too few readings)
  writeStream('org_gone', [rec(GONE, 'org_gone', T0, 0.4, WGONE), rec(GONE, 'org_gone', T0 + 60000, 0.41, WGONE)]);
  fs.writeFileSync(path.join(anchors, 'rates.json'), JSON.stringify({ 'org_aaaa': { computedAt: 1 } }));
  // a cache snapshot carrying the WRONG account's window
  fs.writeFileSync(path.join(cache, A + '.json'), JSON.stringify({ fetchedAt: T0 + 9 * 60000, source: 'rate-limit-event', fiveHour: { utilization: 0.2 }, sevenDay: { utilization: 0.9, resetsAt: WB }, orgUuid: 'aaaa' }));
  fs.writeFileSync(path.join(cache, B + '.json'), JSON.stringify({ fetchedAt: T0, source: 'on-demand', sevenDay: { utilization: 0.5, resetsAt: WB }, orgUuid: 'bbbb' }));

  const rep = repair.repairByWindow({ dataDir, roster: [A, B], id: 'W' });
  const rows = (f) => fs.readFileSync(path.join(anchors, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('§16 each stream establishes its window from its OWN panel readings only', rep.identities.length === 2 && rep.identities.every((i) => i.own === 8),
    JSON.stringify(rep.identities.map((i) => [i.key, i.own, i.of, i.canReceive])));
  ok('§16 …a stream with too few own readings establishes nothing (a coincidence is not a fingerprint)', !rep.identities.some((i) => i.key === 'org_gone'));
  ok('§16 the foreign anchor is RE-FILED onto the account whose window it carries', rep.anchors.refiled === 1 && rep.anchors.archived === 0, JSON.stringify(rep.anchors));
  ok('§16 …and a REMOVED account that shares the phase is not a candidate, so the answer stays unambiguous', rows('anchors-org_bbbb.ndjson').some((r) => Math.abs(r.buckets.sevenDay.u - 0.9) < 1e-9));
  ok('§16 …inserted IN TIME ORDER, unchained and uncosted (its Δu is real for that account, the cost interval is not)', (() => {
    const b = rows('anchors-org_bbbb.ndjson');
    const moved = b.find((r) => Math.abs(r.buckets.sevenDay.u - 0.9) < 1e-9);
    return moved && moved.prevFetchedAt === null && moved.costSince === null && moved.accountId === B && moved.identityKey === 'org_bbbb' && moved.refiledFrom === 'org_aaaa'
      && b.every((r, i) => i === 0 || r.fetchedAt >= b[i - 1].fetchedAt);
  })(), JSON.stringify(rows('anchors-org_bbbb.ndjson').map((r) => [r.fetchedAt - T0, r.buckets.sevenDay.u])));
  ok('§16 the pair it broke is VOIDED, not silently re-pointed at a different interval', (() => {
    const a = rows('anchors-org_aaaa.ndjson');
    const after = a.find((r) => r.fetchedAt === T0 + 10 * 60000);
    return rep.anchors.voided === 1 && after && after.costSince === null && after.prevFetchedAt === T0 + 7 * 60000;
  })(), JSON.stringify(rep.anchors));
  ok('§16 ARCHIVE-NEVER-DESTROY: every moved row is archived with the reason, and the corpus keeps every record', (() => {
    const arch = fs.readFileSync(path.join(dataDir, 'archive', 'readings-window-anchors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const total = ['anchors-org_aaaa.ndjson', 'anchors-org_bbbb.ndjson', 'anchors-org_gone.ndjson'].reduce((n, f) => n + rows(f).length, 0);
    return arch.length === 1 && arch[0].action === 'refiled' && /is not org_aaaa's/.test(arch[0].reason) && total === 10 + 8 + 2;
  })());
  ok('§16 the cache snapshot carrying another account\'s window is archived and REBUILT from that account\'s newest own-window reading', (() => {
    const c = JSON.parse(fs.readFileSync(path.join(cache, A + '.json'), 'utf8'));
    return rep.caches.foreign === 1 && rep.caches.restored === 1 && Math.abs(c.sevenDay.utilization - 0.2) < 1e-9 && c.orgUuid === 'aaaa';
  })(), JSON.stringify(JSON.parse(fs.readFileSync(path.join(cache, A + '.json'), 'utf8'))));
  ok('§16 every roster account is SEEDED with its own window, so the live guard is armed on THIS boot, not on the next panel refresh',
    rep.caches.seeded === 2 && readWindow(cache, A)?.sevenDay === WA && readWindow(cache, B)?.sevenDay === WB
    // …into the SIDECAR, so the next statusline render cannot delete what the
    // migration just established (r2 — that is the whole point of the move)
    && JSON.parse(fs.readFileSync(path.join(cache, A + '.json'), 'utf8')).ownWindow === undefined,
    JSON.stringify([rep.caches.seeded, readWindow(cache, A), readWindow(cache, B)]));
  ok('§16 the learned rates are archived and dropped so the estimator re-learns from the cleaned pairs',
    !fs.existsSync(path.join(anchors, 'rates.json')) && fs.existsSync(path.join(dataDir, 'archive', 'readings-window-rates.ndjson')));
  const rep2 = repair.repairByWindow({ dataDir, roster: [A, B], id: 'W' });
  ok('§16 IDEMPOTENT: a second run finds nothing left to move', rep2.anchors.refiled === 0 && rep2.anchors.archived === 0 && rep2.caches.foreign === 0, JSON.stringify(rep2.anchors));

  // a reading that matches NOBODY is archived, never guessed at
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-winrepair2-')); cleanup.push(d2);
    const dd = path.join(d2, 'data');
    fs.mkdirSync(path.join(dd, 'usage-anchors'), { recursive: true });
    fs.mkdirSync(path.join(dd, 'usage-cache'), { recursive: true });
    const rs = Array.from({ length: 8 }, (_, i) => rec(A, 'org_aaaa', T0 + i * 60000, 0.1, WA));
    rs.push(rec(A, 'org_aaaa', T0 + 9 * 60000, 0.9, WA + 3 * 86400, 'rate-limit-event'));
    fs.writeFileSync(path.join(dd, 'usage-anchors', 'anchors-org_aaaa.ndjson'), rs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = repair.repairByWindow({ dataDir: dd, roster: [A], id: 'W2' });
    const arch = fs.readFileSync(path.join(dd, 'archive', 'readings-window-anchors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('§16 a foreign reading matching NO account is ARCHIVED with the reason, never re-filed on a guess', r.anchors.archived === 1 && r.anchors.refiled === 0 && /matches no known account/.test(arch[0].reason), JSON.stringify(r.anchors));
  }
  ok('§16 the migration is registered append-only with a dated id, and says out loud what it did',
    /id: '2026-09-refile-readings-by-window'/.test(read('src/server/migrations.js')) && /\[migrate\] readings-by-window:/.test(read('src/server/migrations.js')));
  ok('§16 …and it hands the CURRENT roster as the only accounts that may RECEIVE a reading (a removed subscription cannot hold one)',
    /roster = accounts\.filter\(\(a\) => a\.type === 'subscription'\)\.map\(\(a\) => a\.id\)/.test(read('src/server/migrations.js')));
  ok('§16 …and the RECORDS as well (r5): resolving a cache FILE to its identity is `usageIdentityGroups`\' job, which reads backend + type + email — ids alone would make this a second, weaker spelling of the engine\'s map',
    /accounts = \(st\?\.accounts \|\| \[\]\)\.filter\(\(a\) => a && a\.id\)/.test(read('src/server/migrations.js'))
    && /repairByWindow\(\{ dataDir, roster, accounts, id:/.test(read('src/server/migrations.js')));
}

// ── §16b PER BUCKET, NEVER WHOLESALE (r4, reproduced on a COPY of this
// instance's stores) ─────────────────────────────────────────────────────────
// An anchor is a snapshot of a usage-cache FILE, and that file has more than
// one writer: the statusline rewrites {5h, 7d} from its own payload and
// PRESERVES whatever `scopedWeekly` the file already held (it has no scoped
// buckets of its own). So a reading that landed on the wrong key before the
// window guard existed leaves a record that is ITSELF A MIX — another account's
// 7d sitting on top of this stream's own Fable bucket. Measured on a copy of
// this instance's stores: 444 such records against 32 whose halves are BOTH
// foreign and 4466 clean ones.
//
// The r3 repair established each account's window as {sevenDay, fiveHour:null,
// scoped:{}} — it DISCARDED the scoped half of the evidence — so it decided on
// the 7d alone and moved 443 of its 476 re-files complete with a Fable bucket
// the target's own weekly phase contradicts; `repairCachesByWindow` then
// rebuilt a cache from one of them and wrote another member's model-scoped
// bucket, resetsAt and scopedFetchedAt over the target's own.
// `src/account-pool-auto.js` reads `cache.scopedWeekly` for accountRemaining /
// weeklyDeadline / bucketRems, so that is a misattributed reading that can flip
// a pool switch — the 2.305.0 scoped-bucket class, created BY THE REPAIR.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-winrepair-mix-')); cleanup.push(d);
  const A = 'sub-aaaaaaaaaaaa', B = 'sub-bbbbbbbbbbbb';
  const WA = 1789030800, WB = 1789142400;   // two distinct weekly phases
  const T0 = Date.parse('2026-09-08T00:00:00Z');
  // a record's Fable bucket travels SEPARATELY from its {5h,7d} half, exactly
  // as the two live writers produce it
  const rec = (acct, ident, ts, u, resetsAt, fableAt, fableU, source = 'on-demand') => ({
    ts, fetchedAt: ts, source, accountId: acct, identityKey: ident,
    buckets: {
      fiveHour: { u: 0.2, resetsAt: 1 }, sevenDay: { u, resetsAt },
      scopedWeekly: fableAt ? [{ name: 'Fable', u: fableU, resetsAt: fableAt, asOf: ts - 1000 }] : [],
    },
    prevFetchedAt: null, elapsedSec: null, costSince: null,
  });
  /** Build the fixture fresh for each arm: A and B each with 8 of their OWN
   *  panel readings (7d and Fable both on their own phase), plus ONE MIXED
   *  record newest in B's stream — 7d = A's phase, Fable = B's. A's cache
   *  carries a FOREIGN snapshot (B's 7d) so the rebuild branch fires, and its
   *  scopedWeekly is A's OWN Fable. */
  const build = (root) => {
    const dataDir = path.join(root, 'data');
    const anchors = path.join(dataDir, 'usage-anchors'), cache = path.join(dataDir, 'usage-cache');
    for (const p of [anchors, cache]) fs.mkdirSync(p, { recursive: true });
    const aRows = Array.from({ length: 8 }, (_, i) => rec(A, 'org_aaaa', T0 + i * 60000, 0.1 + i * 0.01, WA, WA, 0.90 + i * 0.005));
    const bRows = Array.from({ length: 8 }, (_, i) => rec(B, 'org_bbbb', T0 + i * 60000, 0.5, WB, WB, 0.80));
    bRows.push(rec(B, 'org_bbbb', T0 + 20 * 60000, 0.20, WA, WB, 0.38, 'rate-limit-event'));   // ← THE MIXED RECORD
    fs.writeFileSync(path.join(anchors, 'anchors-org_aaaa.ndjson'), aRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(anchors, 'anchors-org_bbbb.ndjson'), bRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(cache, A + '.json'), JSON.stringify({
      fetchedAt: T0 + 21 * 60000, source: 'rate-limit-event',
      fiveHour: { utilization: 0.2, resetsAt: 1 }, sevenDay: { utilization: 0.20, resetsAt: WB },   // ← foreign 7d
      // A's OWN Fable cap is nearly spent while its 5h/7d are healthy — the
      // 2.305.0 shape, so which repair ran decides a pool SWITCH.
      scopedWeekly: [{ name: 'Fable', utilization: 0.96, resetsAt: WA }], scopedFetchedAt: T0 + 7 * 60000,
      orgUuid: 'aaaa',
    }));
    fs.writeFileSync(path.join(cache, B + '.json'), JSON.stringify({ fetchedAt: T0, source: 'on-demand', sevenDay: { utilization: 0.5, resetsAt: WB }, orgUuid: 'bbbb' }));
    return dataDir;
  };
  const rowsOf = (dataDir, f) => fs.readFileSync(path.join(dataDir, 'usage-anchors', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const cacheOf = (dataDir, id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-cache', id + '.json'), 'utf8'));
  const fableOf = (c) => (c.scopedWeekly || []).find((s) => String(s.name).toLowerCase() === 'fable') || null;

  // (a) THE SCOPED HALF IS ESTABLISHED AT ALL — the evidence r3 threw away
  const dataDir = build(path.join(d, 'fix'));
  const rep = repair.repairByWindow({ dataDir, roster: [A, B], id: 'W4' });
  ok('§16b each identity establishes its model-scoped weekly phases from its OWN panel readings too (r3 established `scoped:{}` and was therefore blind to half the record)',
    rep.identities.length === 2 && rep.identities.every((i) => i.scoped && i.scoped.fable && i.scoped.fable.n === 8),
    JSON.stringify(rep.identities.map((i) => [i.key, i.phase, i.scoped])));
  ok('§16b …and the SEEDED sidecar carries them, so the live guard is armed on the scoped buckets exactly as the panel producer arms it (usage-routes stamps windowOf(merged), which includes scopedWeekly)',
    readWindow(path.join(dataDir, 'usage-cache'), A)?.scoped?.fable === WA
    && readWindow(path.join(dataDir, 'usage-cache'), B)?.scoped?.fable === WB,
    JSON.stringify([readWindow(path.join(dataDir, 'usage-cache'), A), readWindow(path.join(dataDir, 'usage-cache'), B)]));

  // (b) THE RECORD MOVES CARRYING ONLY WHAT AGREES WITH WHERE IT LANDS
  const movedA = rowsOf(dataDir, 'anchors-org_aaaa.ndjson').find((r) => r.refiledFrom === 'org_bbbb');
  ok('§16b the mixed record\'s 7-day half is filed on the account whose window it carries…',
    !!movedA && Math.abs(movedA.buckets.sevenDay.u - 0.20) < 1e-9 && movedA.buckets.sevenDay.resetsAt === WA && movedA.accountId === A,
    JSON.stringify(movedA && movedA.buckets));
  ok('§16b …while its Fable bucket — whose weekly phase is the OTHER account\'s — does NOT travel with it',
    !!movedA && (movedA.buckets.scopedWeekly || []).length === 0 && Array.isArray(movedA.droppedBuckets) && movedA.droppedBuckets.includes('fable'),
    JSON.stringify(movedA && [movedA.buckets.scopedWeekly, movedA.droppedBuckets]));
  ok('§16b …and the five-hour half travels WITH the seven-day one (one payload, one producer, one credential — a 5h window names a TIME and can prove nothing alone)',
    !!movedA && movedA.buckets.fiveHour && movedA.buckets.fiveHour.resetsAt === 1, JSON.stringify(movedA && movedA.buckets.fiveHour));

  // (c) THE DROPPED BUCKET IS ARCHIVED WITH A REASON THAT NAMES ITS OWNER
  const archRows = fs.readFileSync(path.join(dataDir, 'archive', 'readings-window-anchors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const line = archRows.find((r) => r.action === 'refiled' && r.to === 'org_aaaa');
  ok('§16b the Fable half is ARCHIVED with its OWN reason, naming the account it does belong to',
    !!line && Array.isArray(line.buckets) && line.buckets.length === 1 && line.buckets[0].bucket === 'fable'
    && /is org_bbbb's, not org_aaaa's/.test(line.buckets[0].reason),
    JSON.stringify(line && line.buckets));
  ok('§16b …and that line keeps the ORIGINAL WHOLE RECORD, so nothing is destroyed and the corpus still re-derives offline',
    !!line && line.entry && line.entry.buckets.scopedWeekly.length === 1 && line.entry.buckets.scopedWeekly[0].resetsAt === WB
    && Math.abs(line.entry.buckets.sevenDay.u - 0.20) < 1e-9,
    JSON.stringify(line && line.entry && line.entry.buckets));
  ok('§16b the report counts the two kinds apart (a partial move is not a whole one)',
    rep.anchors.refiled === 1 && rep.anchors.refiledPartial === 1 && rep.anchors.refiledWhole === 0 && rep.anchors.bucketsArchived === 1 && rep.anchors.archived === 0,
    JSON.stringify(rep.anchors));

  // (d) THE CACHE REBUILD NEVER IMPORTS A FOREIGN BUCKET
  const cA = cacheOf(dataDir, A);
  ok('§16b A\'s cache is rebuilt from a record ALL of whose weekly buckets are its own — here the 7-day half that just moved in, which is A\'s real newest number',
    rep.caches.foreign === 1 && rep.caches.restored === 1
    && Math.abs(cA.sevenDay.utilization - 0.20) < 1e-9 && cA.sevenDay.resetsAt === WA && cA.orgUuid === 'aaaa',
    JSON.stringify([rep.caches, cA.sevenDay]));
  ok('§16b …and it KEEPS ITS OWN Fable bucket: that record states none, and a rebuild that simply replaced the snapshot would DELETE the model cap the pool reads (the 2.70.0 Fable-vanishing class the three live writers all preserve-merge against)',
    fableOf(cA)?.resetsAt === WA && Math.abs(fableOf(cA).utilization - 0.96) < 1e-9
    && cA.scopedFetchedAt === T0 + 7 * 60000 && cA.scopedPreservedBy === 'window-repair',
    JSON.stringify([cA.scopedWeekly, cA.scopedFetchedAt, cA.scopedPreservedBy]));

  // (e) IDEMPOTENT + THE CENSUS THIS ROUND EXISTS TO SATISFY
  const rep2 = repair.repairByWindow({ dataDir, roster: [A, B], id: 'W4' });
  ok('§16b IDEMPOTENT: a second run moves nothing, drops no bucket and rebuilds no cache',
    rep2.anchors.refiled === 0 && rep2.anchors.archived === 0 && rep2.anchors.bucketsArchived === 0 && rep2.anchors.stripped === 0 && rep2.caches.foreign === 0 && rep2.caches.scopedStripped === 0,
    JSON.stringify([rep2.anchors, rep2.caches]));
  ok('§16b …and the census holds: NO stream and NO cache ends with a weekly bucket whose phase contradicts its account',
    (() => {
      const phase = { org_aaaa: { sevenDay: WA, fable: WA }, org_bbbb: { sevenDay: WB, fable: WB } };
      let bad = 0;
      for (const [ident, w] of Object.entries(phase)) {
        for (const r of rowsOf(dataDir, `anchors-${ident}.ndjson`)) {
          if (Number(r.buckets?.sevenDay?.resetsAt) > 0 && readingLag.weeklyNear(r.buckets.sevenDay.resetsAt, w.sevenDay) === false) bad++;
          for (const s of (r.buckets?.scopedWeekly || [])) if (Number(s.resetsAt) > 0 && readingLag.weeklyNear(s.resetsAt, w.fable) === false) bad++;
        }
      }
      for (const [id, w] of [[A, { sevenDay: WA, fable: WA }], [B, { sevenDay: WB, fable: WB }]]) {
        const c = cacheOf(dataDir, id);
        if (Number(c.sevenDay?.resetsAt) > 0 && readingLag.weeklyNear(c.sevenDay.resetsAt, w.sevenDay) === false) bad++;
        for (const s of (c.scopedWeekly || [])) if (Number(s.resetsAt) > 0 && readingLag.weeklyNear(s.resetsAt, w.fable) === false) bad++;
      }
      return bad === 0;
    })());

  // (f) NEGATIVE CONTROL — the r3 repair, as a PATCHED COPY of the real module
  // (never a re-typed one), with EXACTLY the decisions this round changed
  // reverted: the scoped half is dropped from the established window again, and
  // the record is decided and moved as a whole. Each replacement is asserted to
  // have hit, so this can never silently become a second green arm.
  {
    const src = read('src/reading-repair.js');
    const SUB = [
      // ① establishedWindows discards the scoped evidence
      ['window: { sevenDay: top.resetsAt, fiveHour: null, scoped: sc },',
        'window: { sevenDay: top.resetsAt, fiveHour: null, scoped: {} },'],
      // ② the record is decided as a whole, and every bucket travels with it
      ['      const prim = win.sevenDay ? _bucketVerdict(ident, { sevenDay: win.sevenDay, fiveHour: null, scoped: {} }, all) : null;',
        '      const prim = win.sevenDay ? _bucketVerdict(ident, win, all) : null;'],
      ['        if (v.target === dest) keptScoped.push(s);\n        else drops.push({ bucket: nm, reason: _dropReason(v, dest, ident) });',
        '        keptScoped.push(s);'],
      // ③ the cache rebuild picks the newest record whose 7d is ours, whole
      ['        if (!_recordAgreesWholly(r, w.window)) continue;',
        '        const rw = windowOf(r.buckets || {}); if (!rw.sevenDay || weeklyNear(rw.sevenDay, w.window.sevenDay) !== true) continue;'],
      ['      if (best) { next = _cacheFromAnchor(best, cur, w.window); res.restored++; }',
        '      if (best) { next = _cacheFromAnchor(best, cur); res.restored++; }'],
    ];
    let patched = src, hits = 0;
    for (const [from, to] of SUB) { if (patched.split(from).length === 2) { patched = patched.replace(from, to); hits++; } }
    ok('§16b NEGATIVE CONTROL setup: all 5 pre-fix replacements hit the real module (a control that silently stops applying is a second green arm)', hits === SUB.length, `hits=${hits}/${SUB.length}`);
    const R3 = patchedModule(path.join(d, 'prefix-src'), 'reading-repair.js', patched);
    const dd = build(path.join(d, 'pre'));
    const r3 = R3.repairByWindow({ dataDir: dd, roster: [A, B], id: 'W3' });
    const movedPre = rowsOf(dd, 'anchors-org_aaaa.ndjson').find((r) => r.refiledFrom === 'org_bbbb');
    ok('§16b NEGATIVE CONTROL: the r3 repair moves the record WHOLE — the other account\'s Fable bucket lands in A\'s stream',
      r3.anchors.refiled === 1 && !!movedPre && (movedPre.buckets.scopedWeekly || []).length === 1 && movedPre.buckets.scopedWeekly[0].resetsAt === WB,
      JSON.stringify(movedPre && movedPre.buckets.scopedWeekly));
    const cPre = cacheOf(dd, A);
    ok('§16b NEGATIVE CONTROL: …and the cache rebuild then writes that bucket — value, resetsAt AND scopedFetchedAt — over A\'s own',
      fableOf(cPre)?.resetsAt === WB && Math.abs(fableOf(cPre).utilization - 0.38) < 1e-9 && cPre.scopedFetchedAt !== (T0 + 7 * 60000),
      JSON.stringify([cPre.scopedWeekly, cPre.scopedFetchedAt]));
    // …and the harm is MONEY: the pool reads exactly that bucket
    const { bucketRems, accountRemaining, decidePoolSwitch } = require(path.join(REPO, 'src/account-pool-auto.js'));
    const nowSec = Math.floor((T0 + 22 * 60000) / 1000);
    const fixRems = bucketRems(cA, nowSec).filter((x) => x.label === 'Fable');
    const preRems = bucketRems(cPre, nowSec).filter((x) => x.label === 'Fable');
    const members = [{ id: A, name: 'A' }, { id: B, name: 'B' }];
    const verdict = (cache) => decidePoolSwitch({ currentId: A, members, readCache: (id) => (id === A ? cache : cacheOf(dataDir, B)), nowSec, hot: true });
    ok('§16b NEGATIVE CONTROL: THE HARM IS MONEY — the same account\'s Fable cap reads nearly SPENT under the fix and mostly free under r3, and `accountRemaining` (the min across buckets) follows it',
      fixRems.length === 1 && preRems.length === 1
      && Math.abs(fixRems[0].remaining - 4) < 0.5 && Math.abs(preRems[0].remaining - 62) < 0.5
      && Math.abs(accountRemaining(cA, nowSec).remaining - 4) < 0.5 && Math.abs(accountRemaining(cPre, nowSec).remaining - 62) < 0.5,
      JSON.stringify([fixRems[0], preRems[0], accountRemaining(cA, nowSec), accountRemaining(cPre, nowSec)]));
    ok('§16b NEGATIVE CONTROL: …and that is a POOL SWITCH — the real engine\'s own decider moves off A under the fix and stays on it under r3, on the same two accounts at the same instant',
      verdict(cA)?.to === B && verdict(cA)?.reason === 'exhausted' && verdict(cPre) === null,
      JSON.stringify([verdict(cA), verdict(cPre)]));
    ok('§16b NEGATIVE CONTROL: …and the reset the r3 cache carries for A is B\'s, so a stranger\'s instant is among A\'s weekly-deadline candidates',
      preRems[0].resetsAt === WB && fixRems[0].resetsAt === WA, JSON.stringify([preRems[0].resetsAt, fixRems[0].resetsAt]));
  }

  // (g) A RECORD WITH NO AGREEING BUCKET IS ARCHIVED, NOT MOVED
  {
    const dd = build(path.join(d, 'noowner'));
    const rows = rowsOf(dd, 'anchors-org_bbbb.ndjson');
    rows[rows.length - 1].buckets.sevenDay.resetsAt = WA + 3 * 86400;        // nobody's 7d …
    rows[rows.length - 1].buckets.scopedWeekly[0].resetsAt = WA + 3 * 86400; // … and nobody's Fable
    fs.writeFileSync(path.join(dd, 'usage-anchors', 'anchors-org_bbbb.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = repair.repairByWindow({ dataDir: dd, roster: [A, B], id: 'W5' });
    const arch = fs.readFileSync(path.join(dd, 'archive', 'readings-window-anchors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('§16b a record with NO bucket that can be proven to belong anywhere is ARCHIVED WHOLE, never moved on a guess',
      r.anchors.archived === 1 && r.anchors.refiled === 0 && arch.some((x) => x.action === 'archived' && /matches no known account/.test(x.reason)),
      JSON.stringify([r.anchors, arch.map((x) => x.action)]));
  }

  // (h) A SCOPED-ONLY FOREIGN BUCKET IS STRIPPED IN PLACE — the shape the
  // rebuild branch structurally cannot reach (its 7d agrees), so before r4
  // nothing on any path could clean it, while the pool reads it every tick.
  {
    const dd = build(path.join(d, 'scopedonly'));
    const rows = rowsOf(dd, 'anchors-org_bbbb.ndjson');
    rows[rows.length - 1].buckets.sevenDay.resetsAt = WB;            // 7d is B's own …
    rows[rows.length - 1].buckets.scopedWeekly[0].resetsAt = WA;     // … but the Fable bucket is A's
    fs.writeFileSync(path.join(dd, 'usage-anchors', 'anchors-org_bbbb.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const cB = cacheOf(dd, B);
    cB.scopedWeekly = [{ name: 'Fable', utilization: 0.38, resetsAt: WA }]; cB.scopedFetchedAt = T0;
    fs.writeFileSync(path.join(dd, 'usage-cache', B + '.json'), JSON.stringify(cB));
    const r = repair.repairByWindow({ dataDir: dd, roster: [A, B], id: 'W6' });
    const kept = rowsOf(dd, 'anchors-org_bbbb.ndjson').find((x) => x.fetchedAt === T0 + 20 * 60000);
    ok('§16b a record whose 7-day half is its own but whose Fable bucket is another account\'s STAYS, stripped of that bucket (it is not a re-file — only the bucket is foreign)',
      r.anchors.stripped === 1 && r.anchors.refiled === 0 && !!kept && (kept.buckets.scopedWeekly || []).length === 0
      && kept.buckets.sevenDay.resetsAt === WB && Array.isArray(kept.strippedBuckets) && kept.strippedBuckets.includes('fable'),
      JSON.stringify([r.anchors, kept && kept.buckets]));
    ok('§16b …and the report COUNTS that stream — "streams: 0" about a run that rewrote one is the quiet lie the per-bucket counters exist to prevent',
      r.anchors.streams === 1, JSON.stringify(r.anchors));
    ok('§16b …and the CACHE carrying that bucket is stripped too — its 7d agrees, so the rebuild branch can never see it, and the pool reads `cache.scopedWeekly` directly',
      r.caches.scopedStripped === 1 && (cacheOf(dd, B).scopedWeekly || []).length === 0 && cacheOf(dd, B).scopedFetchedAt === undefined
      && Math.abs(cacheOf(dd, B).sevenDay.utilization - 0.5) < 1e-9,
      JSON.stringify(cacheOf(dd, B)));
    const arch = fs.readFileSync(path.join(dd, 'archive', 'readings-window-usage-cache.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('§16b …with the snapshot archived under its own action and a reason naming the buckets and why they matter',
      arch.some((x) => x.action === 'scoped-stripped' && /Fable@/.test(x.reason) && /accountRemaining/.test(x.reason)), JSON.stringify(arch.map((x) => [x.key, x.action])));
  }

  // (h2) THE `best` PICKER IS ITS OWN BARRIER, and it needs its own control.
  // After a full pass the anchor half has already cleaned every stream, so a
  // 7d-only picker would choose the same record — a guard nobody can delete and
  // redden is not a guard. It speaks where the anchor pass has NOT run:
  // `repairCachesByWindow` is separately exported and separately called, and it
  // is the barrier that must still hold if a future change to the anchor half
  // ever leaves a mixed row behind. So drive it ALONE over a store that still
  // holds one.
  {
    const dd = build(path.join(d, 'cacheonly'));
    const files = [];
    for (const fn of fs.readdirSync(path.join(dd, 'usage-anchors'))) {
      const fp = path.join(dd, 'usage-anchors', fn);
      files.push({ file: fp, name: fn, rows: fs.readFileSync(fp, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) });
    }
    const windows = repair.establishedWindows(files, { roster: [A, B] });
    // the mixed record, still whole, moved into A's stream by hand — exactly
    // what the r3 anchor pass produced, and newer than every clean A reading
    const mixed = windows.get('org_bbbb').file.rows.find((r) => r.source === 'rate-limit-event');
    windows.get('org_aaaa').file.rows.push({ ...mixed, accountId: A, identityKey: 'org_aaaa', refiledFrom: 'org_bbbb' });
    const res = repair.repairCachesByWindow({ cacheDir: path.join(dd, 'usage-cache'), archiveDir: path.join(dd, 'archive'), windows, id: 'W7' });
    const c = cacheOf(dd, A);
    ok('§16b the cache rebuild refuses a record that carries ANY contradicting weekly bucket, even when its 7-day half is the account\'s own and it is the newest',
      res.foreign === 1 && res.restored === 1 && fableOf(c)?.resetsAt === WA && Math.abs(fableOf(c).utilization - 0.935) < 1e-9,
      JSON.stringify([res, c.scopedWeekly, c.sevenDay]));
    ok('§16b …and it fell back to an OLDER WHOLLY-AGREEING reading rather than to the mixed one (both halves come from that record: 7d 0.17 and Fable 0.935, never the mixed record\'s 0.20 / 0.38)',
      Math.abs(c.sevenDay.utilization - 0.17) < 1e-9 && c.sevenDay.resetsAt === WA && c.scopedPreservedBy === undefined,
      JSON.stringify(c.sevenDay));
  }

  // (i) THE LIVE WRITER PATH: no producer can carry a MIXED payload, so the
  // guard's whole-payload verdict already IS a per-bucket verdict there.
  // A `rate_limit_event` names exactly ONE bucket (kind sevenDay|fiveHour|
  // scoped); a `get_usage` control answer, a `/usage` panel result and a codex
  // snapshot are each ONE credential's single response. The MIX in the store is
  // manufactured downstream by the per-key preserve-merge — and each of those
  // preserves reads the TARGET's own previous list, AFTER the guard has moved
  // `key`. So this is a source pin, not a behaviour change.
  {
    const eng = read('src/server/usage-pool-engine.js');
    const calls = [...eng.matchAll(/(?<!function )guardReadingTarget\(([^,]+),\s*([^,]+),/g)].map((m) => m[2].trim());
    ok('§16b every live guard call is handed a PRODUCER PAYLOAD, never a merged cache snapshot (a merged snapshot is the one shape that can be mixed)',
      calls.length === 3 && calls.every((a) => /^readingLag\.windowOf\((parsed|snap)\)$/.test(a) || a === 'win'),
      JSON.stringify(calls));
    ok('§16b …and the one that is not a whole payload is a rate_limit_event, which names exactly ONE bucket',
      /const win = ev\.status === 'rejected' \? null : readingLag\.windowOf\(ev\);/.test(eng)
      && /if \(x\.kind === 'sevenDay'\) out\.sevenDay = r;/.test(read('src/reading-lag.js')), '');
    ok('§16b …and each cache writer preserves the TARGET\'s own scopedWeekly, read AFTER the guard has chosen the key (so a re-file can never import a stranger\'s bucket)',
      (() => {
        const tool = read('data/bin/vibespace-usage');
        const refile = tool.indexOf("if (d.action === 'refile') key = d.key;");
        const openFile = tool.indexOf("const f = path.join(CACHE_DIR, key + '.json');", refile);
        const preserve = tool.indexOf('scopedWeekly: (prev && Array.isArray(prev.scopedWeekly)) ? prev.scopedWeekly : []', openFile);
        return /if \(\(!parsed\.scopedWeekly \|\| !parsed\.scopedWeekly\.length\) && Array\.isArray\(prev\.scopedWeekly\)/.test(eng)
          && refile > 0 && openFile > refile && preserve > openFile;
      })(), '');
  }
}

// ── §16c ONE IDENTITY, MORE THAN ONE CACHE FILE (r5, reproduced on a COPY of
// this instance's stores) ────────────────────────────────────────────────────
// r4 keyed the cache half on ONE account per stream — `w.accountId`, the most
// frequent accountId among the stream's rows. That answers "who is this stream
// mostly about", not "which usage-cache files hold this identity's readings",
// and an org-merged login is exactly the case where the two differ:
// `usageIdentityGroups` puts `__global__.json` (the machine login) and the
// named subscription in ONE group because they are ONE quota. On this instance
// `usage-cache/__global__.json` carries the same orgUuid as its named sibling
// and that identity's stream holds 47 rows keyed to it, so r4 left it out of
// every one of its three jobs, silently:
//   · never REPAIRED  — a foreign window in it survives the migration;
//   · never SEEDED    — `guardReadingTarget` keys `windows` by CACHE FILE NAME,
//                       so with no `.window-__global__` the live guard is
//                       structurally inert on that key and writes whatever the
//                       bookkeeping asked;
//   · and `sweepUsageAnchors` anchors the FRESHEST cache of a group, so one
//     ordinary sweep re-poisons the stream the migration has just cleaned.
// Measured on a copy of this instance's stores, SAME frozen snapshot, only the
// repair changed: r4 leaves __global__ carrying the stranger's 7d and writes 7
// sidecars; r5 archives + rebuilds it and writes 8.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-winrepair-multi-')); cleanup.push(d);
  const A = 'sub-aaaaaaaaaaaa', B = 'sub-bbbbbbbbbbbb';
  const WA = 1789030800, WB = 1789142400;
  const T0 = Date.parse('2026-09-08T00:00:00Z');
  const rec = (acct, ident, ts, u, resetsAt, source = 'on-demand') => ({
    ts, fetchedAt: ts, source, accountId: acct, identityKey: ident,
    buckets: { fiveHour: { u: 0.2, resetsAt: 1 }, sevenDay: { u, resetsAt }, scopedWeekly: [{ name: 'Fable', u: 0.5, resetsAt, asOf: ts - 1000 }] },
    prevFetchedAt: null, elapsedSec: null, costSince: null,
  });
  /** A's identity is carried by TWO cache files — the named sub and the machine
   *  login `__global__` — exactly as an org-merged login is on disk here. The
   *  MACHINE LOGIN's snapshot is the poisoned one AND the freshest in the
   *  group, which is what makes it anchor material for the next sweep. */
  const build = (root) => {
    const dataDir = path.join(root, 'data');
    const anchors = path.join(dataDir, 'usage-anchors'), cache = path.join(dataDir, 'usage-cache');
    for (const p of [anchors, cache]) fs.mkdirSync(p, { recursive: true });
    const aRows = Array.from({ length: 8 }, (_, i) => rec(A, 'org_aaaa', T0 + i * 60000, 0.10 + i * 0.01, WA));
    // …and the identity's own stream really does hold rows keyed to the machine
    // login, which is how the engine writes them (accountId = the group's
    // freshest cache, identityKey = the group)
    aRows.push(rec(null, 'org_aaaa', T0 + 8 * 60000, 0.19, WA));
    fs.writeFileSync(path.join(anchors, 'anchors-org_aaaa.ndjson'), aRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(anchors, 'anchors-org_bbbb.ndjson'),
      Array.from({ length: 8 }, (_, i) => rec(B, 'org_bbbb', T0 + i * 60000, 0.5, WB)).map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(cache, A + '.json'), JSON.stringify({
      fetchedAt: T0 + 8 * 60000, source: 'on-demand', orgUuid: 'aaaa',
      fiveHour: { utilization: 0.2, resetsAt: 1 }, sevenDay: { utilization: 0.19, resetsAt: WA },
      scopedWeekly: [{ name: 'Fable', utilization: 0.5, resetsAt: WA }], scopedFetchedAt: T0,
    }));
    fs.writeFileSync(path.join(cache, '__global__.json'), JSON.stringify({
      fetchedAt: T0 + 30 * 60000, source: 'control', orgUuid: 'aaaa', orgEmail: 'a@example.test',
      fiveHour: { utilization: 0.4, resetsAt: 2 },
      sevenDay: { utilization: 0.93, resetsAt: WB },   // ← B's weekly phase, on A's machine login
      scopedWeekly: [{ name: 'Fable', utilization: 0.5, resetsAt: WA }], scopedFetchedAt: T0,
    }));
    fs.writeFileSync(path.join(cache, B + '.json'), JSON.stringify({ fetchedAt: T0, source: 'on-demand', orgUuid: 'bbbb', sevenDay: { utilization: 0.5, resetsAt: WB } }));
    // files the product's own predicate refuses — none may be seeded or judged
    fs.writeFileSync(path.join(cache, '__models__.json'), JSON.stringify({ models: [] }));
    fs.writeFileSync(path.join(cache, 'host-h1.json'), JSON.stringify({ fetchedAt: T0, orgUuid: 'aaaa', sevenDay: { utilization: 0.1, resetsAt: WB } }));
    fs.writeFileSync(path.join(cache, 'sub-zombiezombie.json'), JSON.stringify({ fetchedAt: T0, orgUuid: 'aaaa', sevenDay: { utilization: 0.1, resetsAt: WB } }));
    fs.writeFileSync(path.join(cache, 'pool-000000000000.json'), JSON.stringify({ fetchedAt: T0, orgUuid: 'aaaa', sevenDay: { utilization: 0.1, resetsAt: WB } }));
    return dataDir;
  };
  const ROSTER = [A, B];
  const ACCOUNTS = [{ id: A, type: 'subscription', backend: 'claude' }, { id: B, type: 'subscription', backend: 'claude' },
    { id: 'pool-000000000000', type: 'pooled', backend: 'claude' }];
  const cacheOf = (dataDir, id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-cache', id + '.json'), 'utf8'));
  const rowsOf = (dataDir, f) => fs.readFileSync(path.join(dataDir, 'usage-anchors', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const streams = (dd) => fs.readdirSync(path.join(dd, 'usage-anchors')).map((fn) => ({
    file: path.join(dd, 'usage-anchors', fn), name: fn,
    rows: fs.readFileSync(path.join(dd, 'usage-anchors', fn), 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
  }));

  // (a) THE MAP: every accepted file resolved with the PRODUCT's own rule
  const dataDir = build(path.join(d, 'fix'));
  {
    const windows = repair.establishedWindows(streams(dataDir), { roster: ROSTER });
    const keys = repair.identityCacheKeys(path.join(dataDir, 'usage-cache'), windows, { accounts: ACCOUNTS });
    const by = Object.fromEntries(keys.map((k) => [k.key, k.ident ? `${k.ident}/${k.via}` : `-/${k.why}`]));
    ok('§16c the MACHINE LOGIN and the named subscription resolve to the SAME identity — one quota, two files, exactly as `usageIdentityGroups` groups them',
      by['__global__'] === 'org_aaaa/identity' && by[A] === 'org_aaaa/identity' && by[B] === 'org_bbbb/identity', JSON.stringify(by));
    ok('§16c …and the product\'s own predicate is what refuses the rest: `__models__` and `host-*` never reach the map at all, while a zombie file of a removed account and a POOL are named and skipped',
      !('__models__' in by) && !('host-h1' in by)
      && /no roster record/.test(by['sub-zombiezombie'] || '') && /pool holds no quota/.test(by['pool-000000000000'] || ''), JSON.stringify(by));
  }

  // (b) …so the machine login is REPAIRED and SEEDED like any other key
  const rep = repair.repairByWindow({ dataDir, roster: ROSTER, accounts: ACCOUNTS, id: 'W8' });
  ok('§16c the poisoned MACHINE-LOGIN snapshot is archived and rebuilt from the identity\'s own newest wholly-agreeing reading (r4 could not see this file at all)',
    rep.caches.foreign === 1 && rep.caches.restored === 1
    && cacheOf(dataDir, '__global__').sevenDay.resetsAt === WA && cacheOf(dataDir, '__global__').orgUuid === 'aaaa',
    JSON.stringify([rep.caches, cacheOf(dataDir, '__global__').sevenDay]));
  ok('§16c EVERY key of an identity is seeded, not one per stream — `guardReadingTarget` keys `windows` by CACHE FILE NAME, so a key with no sidecar is a key the live guard can refuse nothing on',
    rep.caches.keys === 3 && rep.caches.seeded === 3
    && readWindow(path.join(dataDir, 'usage-cache'), '__global__')?.sevenDay === WA
    && readWindow(path.join(dataDir, 'usage-cache'), A)?.sevenDay === WA
    && readWindow(path.join(dataDir, 'usage-cache'), B)?.sevenDay === WB,
    JSON.stringify([rep.caches, readWindow(path.join(dataDir, 'usage-cache'), '__global__')]));
  ok('§16c …and the files the predicate refused are left exactly as they were, sidecar and all (a migration that seeds a host bucket it has no window for is inventing one)',
    !fs.existsSync(path.join(dataDir, 'usage-cache', readingLag.windowSidecarName('host-h1')))
    && !fs.existsSync(path.join(dataDir, 'usage-cache', readingLag.windowSidecarName('__models__')))
    && !fs.existsSync(path.join(dataDir, 'usage-cache', readingLag.windowSidecarName('sub-zombiezombie')))
    && cacheOf(dataDir, 'host-h1').sevenDay.resetsAt === WB);

  // (c) WHAT THE SEEDING BUYS: the live guard, keyed by cache FILE NAME
  {
    /** `establishedWindows()` in the engine, in shape: read the sidecar beside
     *  every cache file and key the map by that FILE's name. */
    const liveWindows = (dir) => {
      const out = {};
      for (const fn of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('__models__'))) {
        const w = readWindow(dir, fn.slice(0, -5));
        if (w && (w.sevenDay || w.fiveHour || (w.scoped && Object.keys(w.scoped).length))) out[fn.slice(0, -5)] = w;
      }
      return out;
    };
    ok('§16c SOURCE PIN: that IS how the live guard is keyed — the engine reads `.window-<cache file name>`, so an identity with two files needs two sidecars',
      /files = fs\.readdirSync\(USAGE_CACHE_DIR\)\.filter\(\(f\) => f\.endsWith\('\.json'\) && !f\.startsWith\('__models__'\)\);/.test(read('src/server/usage-pool-engine.js'))
      && /const key = fn\.slice\(0, -5\);[\s\S]{0,200}readingLag\.windowSidecarName\(key\)/.test(read('src/server/usage-pool-engine.js')), '');
    const dir = path.join(dataDir, 'usage-cache');
    const stranger = { kind: 'sevenDay', resetsAt: WB };   // a reading that is provably B's
    const groupOf = (id) => (id === '__global__' || id === A ? A : id);
    const after = readingLag.decideReadingTarget({ key: '__global__', readingWindow: stranger, windows: liveWindows(dir), groupOf });
    ok('§16c THE GUARD IS NOW ARMED ON THE MACHINE LOGIN: a reading whose weekly window is another member\'s is re-filed instead of written',
      after.action === 'refile' && after.key === B, JSON.stringify(after));
    // the same instant, on the store r4 leaves behind: no sidecar for this key.
    // Read/restore defensively — a MUTATION run must reach the legs below this
    // one and report, not die on a file the mutant never wrote.
    const sc = path.join(dir, readingLag.windowSidecarName('__global__'));
    const saved = fs.existsSync(sc) ? fs.readFileSync(sc) : null;
    if (saved) fs.rmSync(sc);
    const before = readingLag.decideReadingTarget({ key: '__global__', readingWindow: stranger, windows: liveWindows(dir), groupOf });
    ok('§16c NEGATIVE CONTROL: with that one sidecar missing — the state r4 leaves — the same guard, the same reading, WRITES, and says out loud it had nothing to contradict',
      before.action === 'write' && before.key === '__global__' && before.reason === 'no established window to contradict', JSON.stringify(before));
    if (saved) fs.writeFileSync(sc, saved);
  }

  // (d) THE NEXT SWEEP: a cache the migration could not see is anchor material
  // the very next tick. `usageIdentityGroups` keeps the FRESHEST cache of a
  // group and `sweepUsageAnchors` hands exactly that to `maybeRecord`, so the
  // REAL recorder is driven here with the real freshest-cache choice.
  {
    const eng = read('src/server/usage-pool-engine.js');
    ok('§16c SOURCE PIN: the sweep anchors the FRESHEST cache of an identity group, so the machine login\'s snapshot is what the next tick records for the whole identity',
      /if \(!g\.cache \|\| cache\.fetchedAt > g\.cache\.fetchedAt\) \{ g\.cache = cache; g\.accountId = accountId; \}/.test(eng)
      && /usageAnchors\.maybeRecord\(\{ identityKey, accountId: g\.accountId, cache: g\.cache,/.test(eng), '');
    const { UsageAnchors, identityKeyFor } = require(path.join(REPO, 'src/usage-anchors.js'));
    const sweepOnce = (dd) => {
      const dir = path.join(dd, 'usage-cache');
      const groups = new Map();
      for (const fn of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('__models__') && !f.startsWith('host-'))) {
        const accountId = fn === '__global__.json' ? null : fn.slice(0, -5);
        if (accountId && !ROSTER.includes(accountId)) continue;
        const cache = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8'));
        const key = identityKeyFor({ accountId, cache });
        const g = groups.get(key) || { cache: null, accountId: null };
        if (!g.cache || cache.fetchedAt > g.cache.fetchedAt) { g.cache = cache; g.accountId = accountId; }
        groups.set(key, g);
      }
      const ua = new UsageAnchors({ dataDir: dd });
      for (const [key, g] of groups) ua.maybeRecord({ identityKey: key, accountId: g.accountId, cache: g.cache });
    };
    const foreignRows = (dd) => rowsOf(dd, 'anchors-org_aaaa.ndjson').filter((r) => Number(r.buckets?.sevenDay?.resetsAt) > 0 && readingLag.weeklyNear(r.buckets.sevenDay.resetsAt, WA) === false);
    sweepOnce(dataDir);
    ok('§16c …and after the repair that sweep adds NOTHING foreign to the stream it just cleaned',
      foreignRows(dataDir).length === 0, JSON.stringify(rowsOf(dataDir, 'anchors-org_aaaa.ndjson').slice(-1)));
    const dd = build(path.join(d, 'unrepaired'));
    sweepOnce(dd);
    ok('§16c NEGATIVE CONTROL: on the store r4 leaves — the machine login still carrying the stranger\'s window — ONE sweep re-poisons that stream, which is why the fix has to be the cache half and not a second anchor pass',
      foreignRows(dd).length === 1 && foreignRows(dd)[0].buckets.sevenDay.resetsAt === WB, JSON.stringify(foreignRows(dd).map((r) => r.buckets.sevenDay)));
  }

  // (e) THE `acct:` FALLBACK — `identityKeyFor`'s own documented LAST RESORT,
  // and the only rung that may look at the streams. The engine still keys such
  // an account by EMAIL because `accounts.list()` reads it out of the
  // credential dir; this migration runs before any AccountManager exists, and
  // two live members on this instance are in exactly that state.
  {
    const dd = build(path.join(d, 'fallback'));
    const dir = path.join(dd, 'usage-cache');
    const bare = cacheOf(dd, B); delete bare.orgUuid;      // the file states no identity at all
    fs.writeFileSync(path.join(dir, B + '.json'), JSON.stringify(bare));
    const one = repair.identityCacheKeys(dir, repair.establishedWindows(streams(dd), { roster: ROSTER }), { accounts: ACCOUNTS }).find((k) => k.key === B);
    ok('§16c a cache file that states NO identity is resolved by the one established stream that names it — its own rows, written beside `identityKey` from the SAME group at the SAME moment',
      one && one.ident === 'org_bbbb' && one.via === 'stream', JSON.stringify(one && [one.ident, one.via, one.why]));
    // …and never on a guess: two streams naming it is UNKNOWN, not a coin toss
    const rowsA = rowsOf(dd, 'anchors-org_aaaa.ndjson'); rowsA[0].accountId = B;
    fs.writeFileSync(path.join(dd, 'usage-anchors', 'anchors-org_aaaa.ndjson'), rowsA.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const amb = repair.identityCacheKeys(dir, repair.establishedWindows(streams(dd), { roster: ROSTER }), { accounts: ACCOUNTS }).find((k) => k.key === B);
    ok('§16c …and when TWO established streams name it, it is left alone and SAID — an unresolvable key is never seeded with a window it cannot be shown to have',
      amb && amb.ident === null && /2 established streams name this account/.test(amb.why), JSON.stringify(amb && [amb.ident, amb.why]));
    // a pseudo key is NEVER resolved this way: the engine records accountId
    // `null` for BOTH `__global__.json` and `__global_codex__.json`, so a null
    // row cannot tell the two apart (measured: this instance's codex stream is
    // 1532 null-keyed rows, exactly like a claude machine login's would be)
    const bareG = cacheOf(dd, '__global__'); delete bareG.orgUuid; delete bareG.orgEmail;
    fs.writeFileSync(path.join(dir, '__global__.json'), JSON.stringify(bareG));
    const g = repair.identityCacheKeys(dir, repair.establishedWindows(streams(dd), { roster: ROSTER }), { accounts: ACCOUNTS }).find((k) => k.key === '__global__');
    ok('§16c …and a PSEUDO key is never resolved from the streams at all: `accountId: null` cannot tell the machine login from the codex one',
      g && g.ident === null && /no established stream names this account/.test(g.why), JSON.stringify(g && [g.ident, g.why]));
    ok('§16c SOURCE PIN: that is the engine\'s own spelling — both pseudo caches are recorded with a null accountId',
      /const accountId = \(fn === '__global__\.json' \|\| fn === '__global_codex__\.json'\) \? null : fn\.slice\(0, -5\);/.test(read('src/server/usage-pool-engine.js')));
  }

  // (f) NEGATIVE CONTROL — the r4 cache half, as a PATCHED COPY of the real
  // module with exactly this round's decision reverted: the cache keyed on the
  // stream's dominant accountId instead of on the files the product accepts.
  {
    const src = read('src/reading-repair.js');
    const SUB = [
      ['  for (const k of identityCacheKeys(cacheDir, windows, { accounts })) {\n'
        + '    if (!k.ident) { res.unresolved.push({ key: k.key, why: k.why }); continue; }\n'
        + '    const acct = k.key, w = windows.get(k.ident);\n'
        + '    const fp = path.join(cacheDir, k.file);\n'
        + '    const cur = k.cache;\n'
        + '    if (!cur) continue;\n'
        + '    res.keys++;',
      '  const byAcct = new Map();\n'
        + '  for (const [ident0, w0] of windows) if (w0.canReceive && w0.accountId) byAcct.set(w0.accountId, { ident: ident0, ...w0 });\n'
        + '  for (const [acct, w] of byAcct) {\n'
        + "    const fp = path.join(cacheDir, String(acct).replace(/[^\\w.-]/g, '_') + '.json');\n"
        + '    const cur = _readJson(fp);\n'
        + '    if (!cur) continue;\n'
        + '    res.keys++;'],
    ];
    let patched = src, hits = 0;
    for (const [from, to] of SUB) { if (patched.split(from).length === 2) { patched = patched.replace(from, to); hits++; } }
    ok('§16c NEGATIVE CONTROL setup: the pre-fix replacement hits the real module (a control that silently stops applying is a second green arm)', hits === SUB.length, `hits=${hits}/${SUB.length}`);
    const R4 = patchedModule(path.join(d, 'r4-src'), 'reading-repair.js', patched);
    const dd = build(path.join(d, 'pre'));
    const r4 = R4.repairByWindow({ dataDir: dd, roster: ROSTER, accounts: ACCOUNTS, id: 'W8pre' });
    ok('§16c NEGATIVE CONTROL: r4 touches ONE key per stream, so the machine login keeps the stranger\'s weekly window and gets no sidecar at all',
      r4.caches.keys === 2 && r4.caches.seeded === 2 && r4.caches.foreign === 0
      && cacheOf(dd, '__global__').sevenDay.resetsAt === WB
      && readWindow(path.join(dd, 'usage-cache'), '__global__') === null,
      JSON.stringify([r4.caches, cacheOf(dd, '__global__').sevenDay]));
  }

  // (g) THE CENSUS this round exists to satisfy: EVERY accepted cache key that
  // belongs to an identity ends with a sidecar AND with no bucket that
  // identity's own phases contradict.
  {
    const dd = build(path.join(d, 'census'));
    repair.repairByWindow({ dataDir: dd, roster: ROSTER, accounts: ACCOUNTS, id: 'W8c' });
    const windows = repair.establishedWindows(streams(dd), { roster: ROSTER });
    const dir = path.join(dd, 'usage-cache');
    const contradicts = (win, w) => {
      const bad = [];
      if (win.sevenDay && readingLag.weeklyNear(win.sevenDay, w.window.sevenDay) === false) bad.push('7d');
      for (const [nm, v] of Object.entries(win.scoped || {})) {
        const o = w.window.scoped[nm];
        if (o != null && readingLag.weeklyNear(v, o) === false) bad.push(nm);
      }
      return bad;
    };
    let inIdentity = 0; const missing = [], contra = [];
    for (const k of repair.identityCacheKeys(dir, windows, { accounts: ACCOUNTS })) {
      if (!k.ident) continue;
      inIdentity++;
      if (!readWindow(dir, k.key)) missing.push(k.key);
      const bad = contradicts(readingLag.windowOf(cacheOf(dd, k.key)), windows.get(k.ident));
      if (bad.length) contra.push([k.key, bad]);
    }
    let rowBad = 0;
    for (const f of streams(dd)) {
      const w = windows.get(f.name.replace(/^anchors-|\.ndjson$/g, ''));
      if (!w) continue;
      for (const r of f.rows) if (contradicts(readingLag.windowOf(r.buckets || {}), w).length) rowBad++;
    }
    ok('§16c CENSUS: every accepted cache key that belongs to an identity ends with a sidecar and with no bucket that identity contradicts — and no anchor row does either',
      inIdentity === 3 && !missing.length && !contra.length && rowBad === 0, JSON.stringify([inIdentity, missing, contra, rowBad]));
  }

  // (h) THE SECOND SNAPSHOT OF THE SAME KEY (r6, reproduced end to end on a
  // COPY of this instance's stores with the REAL `setupUsage()` and the REAL
  // `/api/usage` route). `repairCachesByWindow` walks the usage-cache
  // DIRECTORY — but the machine login's snapshot is persisted TWICE, and the
  // second copy is `data/usage-cache.json` (USAGE_CACHE_FILE): the boot seed of
  // `_rateLimitCache`, whose `.claude` payload IS the `__global__` slot, and
  // which the same-account merge (usage-routes ~:310-316) also writes the named
  // subscription's snapshot into whenever the two are one quota.
  // Because a rebuild REWINDS `fetchedAt` to the anchor it restored from, that
  // untouched copy is GUARANTEED to win the newest-wins merge that reads it —
  // so after the r5 migration the directory is clean and `/api/usage` still
  // serves the stranger on BOTH rows, for good: the migration is one-shot and
  // ledger-gated.
  {
    const express = require('express');   // a repo dependency (server.js runs on it); resolved the way node resolves it, not by a hand-built path
    const { setupUsage } = require(path.join(REPO, 'src/usage-routes.js'));
    const EMAIL = 'a@example.test';   // the machine login's own address (the poisoned __global__ states it)
    const ACCT_MAIL = [{ id: A, type: 'subscription', backend: 'claude', name: 'A', email: EMAIL },
      { id: B, type: 'subscription', backend: 'claude', name: 'B', email: 'b@example.test' },
      { id: 'pool-000000000000', type: 'pooled', backend: 'claude' }];
    /** the fixture, plus the sibling file carrying the SAME poisoned payload and
     *  the freshest `fetchedAt` of the identity — the state a rebuild
     *  guarantees, since it rewinds every directory copy to an older anchor */
    const withSibling = (where, mutate = null) => {
      const dd = build(path.join(d, where));
      const g = JSON.parse(fs.readFileSync(path.join(dd, 'usage-cache', '__global__.json'), 'utf8'));
      const claude = mutate ? mutate({ ...g }) : { ...g, fetchedAt: T0 + 90 * 60000 };
      if (claude) fs.writeFileSync(path.join(dd, 'usage-cache.json'), JSON.stringify({ claude }, null, 2));
      return dd;
    };
    const sibOf = (dd) => { try { return JSON.parse(fs.readFileSync(path.join(dd, 'usage-cache.json'), 'utf8')).claude; } catch { return null; } };
    /** THE REAL ROUTE: the shipped `setupUsage` on a real express app, reading
     *  the repaired store off disk exactly as the server does at boot. */
    const serveUsage = async (dd) => {
      const app = express();
      const emptyDir = (n) => { const q = path.join(dd, '..', n + '-' + Math.random().toString(36).slice(2)); fs.mkdirSync(q, { recursive: true }); return q; };
      const accounts = {
        list: () => ({ accounts: ACCT_MAIL }),
        codexGlobalStatus: () => ({ loggedIn: false, email: null }),
        subscriptionStatus: () => ({ loggedIn: true, email: EMAIL }),
        subCredsPath: () => path.join(dd, 'no-such-creds', '.credentials.json'),
        usageToken: () => null,
      };
      setupUsage({
        app, accounts, hosts: { list: () => [] }, usageHistory: null, activeSessions: new Map(),
        serverSetting: () => false, ensureDir: (x) => fs.mkdirSync(x, { recursive: true }),
        USAGE_CACHE_FILE: path.join(dd, 'usage-cache.json'), USAGE_CACHE_DIR: path.join(dd, 'usage-cache'),
        CODEX_SESSIONS_DIR: emptyDir('codex'), META_DIR: emptyDir('meta'),
        AVAILABLE_MODELS: { claude: [] }, BUFFERS_DIR: emptyDir('buffers'),
        probeUsageForAccountKey: null, CLAUDE_CMD: 'claude',
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server.once('listening', r));
      const body = await fetch('http://127.0.0.1:' + server.address().port + '/api/usage').then((x) => x.json());
      server.close();
      return body;
    };

    const dd = withSibling('sibling');
    const rep6 = repair.repairByWindow({ dataDir: dd, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8h' });
    ok('§16c the machine login\'s SECOND snapshot — `data/usage-cache.json`, which is NOT in the directory the repair walks — is judged too, and says so in the report',
      rep6.globalFile === 'archived' && /data\/usage-cache\.json/.test(rep6.globalFileWhy || '') && /newest-wins/.test(rep6.globalFileWhy || ''),
      JSON.stringify([rep6.globalFile, rep6.globalFileWhy]));
    ok('§16c …ARCHIVE-NEVER-DESTROY: the line names its own store and keeps the WHOLE original payload, and only then is the copy removed',
      (() => {
        const rows = fs.readFileSync(path.join(dd, 'archive', 'readings-window-usage-cache.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const mine = rows.filter((r) => r.store === 'usage-cache.json');
        return mine.length === 1 && mine[0].action === 'unlinked' && mine[0].key === '__global__'
          && mine[0].entry.sevenDay.resetsAt === WB && !fs.existsSync(path.join(dd, 'usage-cache.json'));
      })(), '');
    const fixed = await serveUsage(dd);
    ok('§16c THE REAL /api/usage NOW SERVES THE REPAIRED NUMBERS ON BOTH ROWS — the machine login from `_rateLimitCache`, and the named subscription because the same-account merge hands the freshest of the pair to both',
      fixed.rateLimit?.sevenDay?.resetsAt === WA && fixed.accounts?.[A]?.sevenDay?.resetsAt === WA && fixed.globalLogin?.accountId === A,
      JSON.stringify([fixed.rateLimit?.sevenDay, fixed.accounts?.[A]?.sevenDay, fixed.globalLogin?.accountId]));
    ok('§16c …and the file is RE-SEEDED by the product\'s own `!_rateLimitCache` branch, from the repaired directory — so it agrees with the window this migration seeded for `__global__`, and its `fetchedAt` can never outrank it again',
      (() => {
        const sib = sibOf(dd), seeded = readWindow(path.join(dd, 'usage-cache'), '__global__');
        return !!sib && !!seeded && readingLag.weeklyNear(readingLag.windowOf(sib).sevenDay, seeded.sevenDay) === true
          && sib.fetchedAt === JSON.parse(fs.readFileSync(path.join(dd, 'usage-cache', '__global__.json'), 'utf8')).fetchedAt;
      })(), JSON.stringify([sibOf(dd)?.sevenDay, readWindow(path.join(dd, 'usage-cache'), '__global__')?.sevenDay]));
    ok('§16c …and a second run has nothing left to do (idempotent: the copy is gone, and what re-seeded it came FROM the repaired directory)',
      (() => { const r2 = repair.repairByWindow({ dataDir: dd, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8h2' }); return r2.globalFile === 'clean' && sibOf(dd)?.sevenDay?.resetsAt === WA; })(), '');

    // NEGATIVE CONTROL — the r5 module, which never looked at this file, driven
    // through the SAME real route on the SAME fixture.
    {
      const src = read('src/reading-repair.js');
      const SUB = [
        ["  const gf = repairGlobalFile({ dataDir, cacheDir, archiveDir, windows, accounts, id, now });\n"
          + "  report.globalFile = gf.state;",
          "  report.globalFile = 'r5-never-looked';\n  const gf = { state: 'r5-never-looked', why: null };\n  void gf.state;"],
      ];
      let patched = src, hits = 0;
      for (const [from, to] of SUB) { if (patched.split(from).length === 2) { patched = patched.replace(from, to); hits++; } }
      ok('§16c NEGATIVE CONTROL setup: the pre-fix replacement hits the real module (a control that silently stops applying is a second green arm)', hits === SUB.length, `hits=${hits}/${SUB.length}`);
      const R5 = patchedModule(path.join(d, 'r5-src'), 'reading-repair.js', patched);
      const pre = withSibling('r6-pre');
      const r5rep = R5.repairByWindow({ dataDir: pre, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8pre6' });
      const served = await serveUsage(pre);
      ok('§16c NEGATIVE CONTROL: r5 repairs the DIRECTORY and leaves the second copy alone — so the real route serves the stranger\'s 93% on BOTH rows, and the file still holds it afterwards (one-shot migration ⇒ nothing runs again to notice)',
        r5rep.caches.foreign === 1 && JSON.parse(fs.readFileSync(path.join(pre, 'usage-cache', '__global__.json'), 'utf8')).sevenDay.resetsAt === WA
        && served.rateLimit?.sevenDay?.resetsAt === WB && Math.abs(served.rateLimit.sevenDay.utilization - 0.93) < 1e-9
        && served.accounts?.[A]?.sevenDay?.resetsAt === WB && sibOf(pre)?.sevenDay?.resetsAt === WB,
        JSON.stringify([r5rep.globalFile, served.rateLimit?.sevenDay, served.accounts?.[A]?.sevenDay, sibOf(pre)?.sevenDay]));
    }

    // A SCOPED bucket contradicts on its own — the pool reads `scopedWeekly`
    // for accountRemaining / weeklyDeadline / bucketRems, and this copy feeds
    // the same two panel rows.
    {
      const sc = withSibling('sibling-scoped', (g) => ({ ...g, sevenDay: { utilization: 0.2, resetsAt: WA }, scopedWeekly: [{ name: 'Fable', utilization: 0.9, resetsAt: WB }], fetchedAt: T0 + 90 * 60000 }));
      const r = repair.repairByWindow({ dataDir: sc, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8sc' });
      ok('§16c …ANY contradicting bucket removes the copy, not just the 7-day one: this file is a COPY of a snapshot just repaired in both shapes, so the honest repair for either is to drop it and let it be re-seeded',
        r.globalFile === 'archived' && /fable@/.test(r.globalFileWhy || '') && !fs.existsSync(path.join(sc, 'usage-cache.json')), JSON.stringify([r.globalFile, r.globalFileWhy]));
    }
    // …and an AGREEING copy is left byte-identical: this half only ever acts on
    // a contradiction, exactly like the directory half.
    {
      const cl = withSibling('sibling-clean', (g) => ({ ...g, sevenDay: { utilization: 0.19, resetsAt: WA }, fetchedAt: T0 + 90 * 60000 }));
      const before = fs.readFileSync(path.join(cl, 'usage-cache.json'));
      const r = repair.repairByWindow({ dataDir: cl, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8cl' });
      ok('§16c NEGATIVE CONTROL: a copy whose window IS this identity\'s is left byte-identical and reported clean',
        r.globalFile === 'clean' && r.globalFileWhy === null && fs.readFileSync(path.join(cl, 'usage-cache.json')).equals(before), JSON.stringify([r.globalFile, r.globalFileWhy]));
    }
    // …and with no copy at all there is simply nothing to say.
    {
      const ab = build(path.join(d, 'sibling-absent'));
      ok('§16c …and `absent` is its own answer, so the one-shot log never claims a file it never saw',
        repair.repairByWindow({ dataDir: ab, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8ab' }).globalFile === 'absent');
    }
    // UNRESOLVABLE: judged by the DIRECTORY half's own answer for `__global__`,
    // never by a second `identityKeyFor` over this payload — and a copy we
    // cannot attribute is not a copy we may delete.
    {
      const un = withSibling('sibling-unresolvable');
      const g = JSON.parse(fs.readFileSync(path.join(un, 'usage-cache', '__global__.json'), 'utf8'));
      delete g.orgUuid; delete g.orgEmail;                      // pseudo key, never resolved from the streams
      fs.writeFileSync(path.join(un, 'usage-cache', '__global__.json'), JSON.stringify(g));
      const before = fs.readFileSync(path.join(un, 'usage-cache.json'));
      const r = repair.repairByWindow({ dataDir: un, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8un' });
      ok('§16c …an UNRESOLVABLE `__global__` leaves the copy exactly where it is and SAYS which evidence is missing — the payload still states the identity, and asking it directly would be the second, weaker map r5 exists to remove',
        r.globalFile === 'unresolvable' && /no established stream names this account/.test(r.globalFileWhy || '')
        && fs.readFileSync(path.join(un, 'usage-cache.json')).equals(before)
        && !!sibOf(un).orgUuid, JSON.stringify([r.globalFile, r.globalFileWhy]));
      // …including the shape where the directory holds no `__global__.json` at
      // all, so the map never names the key this file is a copy of
      const un2 = withSibling('sibling-nodir');
      const b2 = fs.readFileSync(path.join(un2, 'usage-cache.json'));
      fs.rmSync(path.join(un2, 'usage-cache', '__global__.json'));
      const r2 = repair.repairByWindow({ dataDir: un2, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8un2' });
      ok('§16c …and with no `usage-cache/__global__.json` at all the answer is the same refusal, naming that as the missing evidence',
        r2.globalFile === 'unresolvable' && /__global__\.json is absent/.test(r2.globalFileWhy || '')
        && fs.readFileSync(path.join(un2, 'usage-cache.json')).equals(b2), JSON.stringify([r2.globalFile, r2.globalFileWhy]));
    }
    // THE SECOND LOOKUP MUST GIVE THE FIRST ONE'S ANSWER. This half asks
    // `identityCacheKeys` again, AFTER the directory half has rewritten those
    // files, so it leans on both rebuild branches preserving IDENTITY_FIELDS.
    // Driven against the shape that keeps the LEAST — the emptied snapshot a
    // key with no surviving own-window reading is left as (`next = {}` plus the
    // identity fields), which is exactly where a lost `orgUuid` would silently
    // turn every later run into "unresolvable, left alone".
    {
      const em = withSibling('sibling-emptied');
      fs.writeFileSync(path.join(em, 'usage-cache', '__global__.json'), JSON.stringify({ orgUuid: 'aaaa', orgEmail: EMAIL, repairedBy: 'earlier-run' }));
      const r = repair.repairByWindow({ dataDir: em, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8em' });
      ok('§16c …and the second lookup still names the identity when the directory copy has been EMPTIED down to its identity fields — the post-state this half is read in',
        r.globalFile === 'archived' && !fs.existsSync(path.join(em, 'usage-cache.json')), JSON.stringify([r.globalFile, r.globalFileWhy]));
    }
    // NO SILENT FAILURE: 'archived' claims the copy is GONE. If the unlink
    // cannot happen, the file is still what `/api/usage` serves, so the run
    // must fail loudly (the runner logs it verbatim and retries next boot)
    // rather than report a repair that did not take.
    {
      const nf = withSibling('sibling-nounlink');
      repair.repairByWindow({ dataDir: nf, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8nf1' });   // creates data/archive
      const g = JSON.parse(fs.readFileSync(path.join(nf, 'usage-cache', '__global__.json'), 'utf8'));
      fs.writeFileSync(path.join(nf, 'usage-cache.json'), JSON.stringify({ claude: { ...g, sevenDay: { utilization: 0.93, resetsAt: WB }, fetchedAt: T0 + 90 * 60000 } }));
      let threw = null;
      fs.chmodSync(nf, 0o555);
      try { repair.repairByWindow({ dataDir: nf, roster: ROSTER, accounts: ACCT_MAIL, id: 'W8nf2' }); } catch (e) { threw = e; }
      finally { fs.chmodSync(nf, 0o755); }
      ok('§16c …and a copy that CANNOT be removed fails the migration loudly instead of reporting it archived — the ledger row stays unwritten and the next boot retries',
        !!threw && /usage-cache\.json/.test(String(threw.message)) && fs.existsSync(path.join(nf, 'usage-cache.json'))
        && JSON.parse(fs.readFileSync(path.join(nf, 'archive', 'readings-window-usage-cache.ndjson'), 'utf8').trim().split('\n').pop()).store === 'usage-cache.json',
        String(threw && threw.message).slice(0, 160));
    }
    // SOURCE PINS: the two product facts this half stands on — the file the
    // seed is read from, and the newest-wins merge a stale copy wins.
    ok('§16c SOURCE PIN: `data/usage-cache.json` really is the `__global__` slot\'s other home — one reader, one writer, and the same-account merge writes the NAMED subscription\'s snapshot into it',
      /const USAGE_CACHE_FILE = path\.join\(__dirname, 'data', 'usage-cache\.json'\);/.test(read('server.js'))
      && /function readUsageCache\(\) \{[\s\S]{0,200}JSON\.parse\(fs\.readFileSync\(USAGE_CACHE_FILE, 'utf-8'\)\)[\s\S]{0,80}cached\?\.claude/.test(read('src/usage-routes.js'))
      && /const \{ name, email, \.\.\.usage \} = newest;\s*\n\s*_rateLimitCache = usage; writeUsageCache\(\);/.test(read('src/usage-routes.js'))
      // …and the wrapper holds NOTHING but that payload, which is why archiving
      // `.claude` archives the whole file
      && /fs\.writeFileSync\(tmpPath, JSON\.stringify\(\{ claude: _rateLimitCache \}, null, 2\)\);/.test(read('src/usage-routes.js')), '');
    ok('§16c SOURCE PIN: …and it is read back NEWEST-WINS, which is why a rewound rebuild can never displace a stale copy — and why `!_rateLimitCache` re-seeds it once the copy is gone',
      /if \(!_rateLimitCache \|\| \(u\.fetchedAt > \(_rateLimitCache\.fetchedAt \|\| 0\)\)\) \{ _rateLimitCache = u; writeUsageCache\(\); \}/.test(read('src/usage-routes.js'))
      && /out\.fetchedAt = anchor\.fetchedAt;/.test(read('src/reading-repair.js')), '');

    // STANDING SWEEP — "is there a THIRD home for a reading snapshot?" is a
    // number to re-measure, not a fact to inherit (the r5 lesson, one level up:
    // r5 fixed "one identity, more than one cache FILE" and still assumed the
    // directory was every file). The set is DERIVED from the source rather than
    // listed, and printed, so a new persistence root fails here instead of
    // surviving the next migration the way this one did.
    {
      const roots = [path.join(REPO, 'server.js'), path.join(REPO, 'src'), path.join(REPO, 'data', 'bin')];
      const files = [];
      const walk = (fp) => {
        let st; try { st = fs.statSync(fp); } catch { return; }
        if (st.isDirectory()) { for (const e of fs.readdirSync(fp).sort()) walk(path.join(fp, e)); return; }
        // runtime artefacts the product DOWNLOADS into data/bin (the 64 MB
        // rclone) are not source; nothing under 1 MiB here is one. The esbuild
        // daemon BUNDLE is named out too — it is a copy of src/agentd + the
        // shared modules, so its sites are duplicates of theirs, and it is a
        // build output that a fresh checkout does not have (a census whose set
        // changes with `npm run build` is not a census).
        if (st.size > 1024 * 1024) return;
        if (path.relative(REPO, fp) === path.join('data', 'bin', 'vibespace-agentd.js')) return;
        files.push(fp);
      };
      for (const r of roots) walk(r);
      const entries = [];
      for (const fp of files) { try { entries.push({ file: path.relative(REPO, fp), text: fs.readFileSync(fp, 'utf8') }); } catch { } }
      const SITE = /(path\.join\([^)]*['"]usage-cache)|VIBESPACE_USAGE_CACHE/;
      /** THE HOMES A CLAUDE READING SNAPSHOT IS PERSISTED IN, each with the
       *  reason it is in or out of this migration's scope. Driven off an
       *  INJECTED file list so the verdict below can be driven a second time
       *  with a synthetic third home — a sweep whose "nothing else exists"
       *  arm cannot be made to fail has proven nothing. */
      const bucket = (t) => t.includes("'usage-cache.json'") ? 'sibling'
        : (/VIBESPACE_USAGE_CACHE|'\.vibespace', 'usage-cache'/.test(t) ? 'device' : 'directory');
      const census = (list) => {
        const by = { sibling: [], device: [], directory: [] }, all = [];
        for (const e of list) e.text.split('\n').forEach((line, i) => {
          if (!SITE.test(line)) return;
          all.push(e.file + ':' + (i + 1));
          by[bucket(line.trim())].push(e.file + ':' + (i + 1));
        });
        return { by, all };
      };
      /** the verdict this sweep exists to make: exactly two sites name a
       *  persisted snapshot outside the directory, and both are the ones r6
       *  accounts for */
      const onlyKnownSibling = (by) => by.sibling.length === 2
        && by.sibling.some((x) => x.startsWith('server.js:')) && by.sibling.some((x) => x.startsWith('src/reading-repair.js:'));
      const { by, all } = census(entries);
      console.log('    census: ' + JSON.stringify(by));
      ok('§16c STANDING SWEEP: the census covers the files that actually hold these roots (an assert that can walk an empty set is not an assert)',
        all.length >= 8 && ['server.js', 'src/reading-repair.js', 'src/agentd/agentd.js', 'data/bin/vibespace-usage'].every((f) => all.some((x) => x.startsWith(f + ':'))),
        JSON.stringify(all));
      ok('§16c STANDING SWEEP: the only persisted claude snapshot OUTSIDE the usage-cache directory is `data/usage-cache.json` — the constant in server.js and the half that now judges it — so a THIRD home would fail here',
        onlyKnownSibling(by), JSON.stringify(by.sibling));
      ok('§16c STANDING SWEEP CONTROL: …and it really would — the same verdict over the same tree PLUS one synthetic module persisting the slot somewhere else says no',
        !onlyKnownSibling(census([...entries, { file: 'src/fake-third-home.js', text: "const f = path.join(dataDir, 'usage-cache.json');" }]).by));
      ok('§16c STANDING SWEEP: …and the remaining root is a DEVICE\'s own store (`~/.vibespace/usage-cache`), NAMED out of scope: it belongs to that machine, reaches us only as `usage-cache/host-*.json`, and the repair\'s own predicate refuses those because no anchor stream describes a host\'s login — it has no established window to judge or seed one with',
        by.device.some((x) => x.startsWith('src/agentd/agentd.js:')) && by.device.some((x) => x.startsWith('data/bin/vibespace-usage:'))
        && /!f\.startsWith\('host-'\)/.test(read('src/reading-repair.js'))
        && /host-\*` is excluded for the same reason the engine excludes it from/.test(read('src/reading-repair.js')),
        JSON.stringify(by.device));
    }
  }
}

// ── §16d THE PRIMARY HALF IS DECIDED ON THE RECORD'S BUCKETS (r5) ───────────
// {5h, 7d} is ONE payload, so they leave together — but the drop lines were
// written off the DATED view of the window, so a record whose primary half
// states no `resetsAt` had it deleted from the moved row with no line at all:
// `bucketsArchived: 0`, counted as a WHOLE re-file, and the placeholder reason
// `'window'` in both the journal and the archive. The shape is ordinary —
// `vibespace-usage` writes `{u: 0}` with no window for an absent bucket and
// `maybeRecord` keeps the utilization, and 2392 of this instance's 7106 anchors
// carry an undated primary bucket beside a dated scoped one. (Zero of them are
// ALSO 7d-less today, which is why this is latent rather than measured harm —
// but a bucket moved onto an account it cannot be shown to belong to is the
// whole class of defect this repair is made of, and it was moving silently.)
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-winrepair-undated-')); cleanup.push(d);
  const A = 'sub-aaaaaaaaaaaa', B = 'sub-bbbbbbbbbbbb';
  const WA = 1789030800, WB = 1789142400;
  const T0 = Date.parse('2026-09-08T00:00:00Z');
  const rec = (acct, ident, ts, buckets, source = 'on-demand') => ({
    ts, fetchedAt: ts, source, accountId: acct, identityKey: ident, buckets,
    prevFetchedAt: null, elapsedSec: null, costSince: null,
  });
  const own = (u, w) => ({ fiveHour: { u: 0.2, resetsAt: 1 }, sevenDay: { u, resetsAt: w }, scopedWeekly: [{ name: 'Fable', u: 0.5, resetsAt: w, asOf: T0 }] });
  /** THE RECORD: a dated Fable bucket that is A's, sitting on B's stream beside
   *  an UNDATED 5h and an UNDATED 7d that both carry real utilizations. */
  const build = (root) => {
    const dataDir = path.join(root, 'data');
    const anchors = path.join(dataDir, 'usage-anchors'), cache = path.join(dataDir, 'usage-cache');
    for (const p of [anchors, cache]) fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(anchors, 'anchors-org_aaaa.ndjson'),
      Array.from({ length: 8 }, (_, i) => rec(A, 'org_aaaa', T0 + i * 60000, own(0.1 + i * 0.01, WA))).map((r) => JSON.stringify(r)).join('\n') + '\n');
    const bRows = Array.from({ length: 8 }, (_, i) => rec(B, 'org_bbbb', T0 + i * 60000, own(0.5, WB)));
    bRows.push(rec(B, 'org_bbbb', T0 + 20 * 60000, {
      fiveHour: { u: 0.77 },                                                // ← states no window
      sevenDay: { u: 0.66 },                                                // ← states no window
      scopedWeekly: [{ name: 'Fable', u: 0.42, resetsAt: WA, asOf: T0 }],   // ← A's
    }, 'rate-limit-event'));
    fs.writeFileSync(path.join(anchors, 'anchors-org_bbbb.ndjson'), bRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(cache, A + '.json'), JSON.stringify({ fetchedAt: T0, source: 'on-demand', orgUuid: 'aaaa', sevenDay: { utilization: 0.17, resetsAt: WA } }));
    fs.writeFileSync(path.join(cache, B + '.json'), JSON.stringify({ fetchedAt: T0, source: 'on-demand', orgUuid: 'bbbb', sevenDay: { utilization: 0.5, resetsAt: WB } }));
    return dataDir;
  };
  const ACCOUNTS = [{ id: A, type: 'subscription' }, { id: B, type: 'subscription' }];
  const rowsOf = (dataDir, f) => fs.readFileSync(path.join(dataDir, 'usage-anchors', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const dataDir = build(path.join(d, 'fix'));
  const rep = repair.repairByWindow({ dataDir, roster: [A, B], accounts: ACCOUNTS, id: 'W9' });
  const moved = rowsOf(dataDir, 'anchors-org_aaaa.ndjson').find((r) => r.refiledFrom === 'org_bbbb');
  const arch = fs.readFileSync(path.join(dataDir, 'archive', 'readings-window-anchors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const line = arch.find((r) => r.action === 'refiled');
  ok('§16d a record whose only weekly evidence is a SCOPED bucket follows that bucket, and its undated primary half does not ride along',
    !!moved && moved.buckets.sevenDay === null && moved.buckets.fiveHour === null
    && (moved.buckets.scopedWeekly || []).length === 1 && moved.buckets.scopedWeekly[0].resetsAt === WA,
    JSON.stringify(moved && moved.buckets));
  ok('§16d …and EACH primary bucket the record actually STATES gets its own archived line — an undated bucket states no weekly window, so it cannot be shown to belong to the destination',
    !!line && Array.isArray(line.buckets) && line.buckets.length === 2
    && line.buckets.map((b) => b.bucket).join(',') === 'sevenDay,fiveHour'
    && /states no weekly window, so it cannot be shown to be org_aaaa's/.test(line.buckets[0].reason)
    && /five-hour window names a TIME/.test(line.buckets[1].reason),
    JSON.stringify(line && line.buckets));
  ok('§16d …the move is counted PARTIAL, naming the buckets it dropped (a WHOLE re-file that silently deleted two buckets is a report about a run that did not happen)',
    rep.anchors.refiled === 1 && rep.anchors.refiledPartial === 1 && rep.anchors.refiledWhole === 0 && rep.anchors.bucketsArchived === 2
    && Array.isArray(moved.droppedBuckets) && moved.droppedBuckets.join(',') === 'sevenDay,fiveHour',
    JSON.stringify([rep.anchors, moved && moved.droppedBuckets]));
  ok('§16d …and the reason the record MOVED is the verdict of the bucket that decided it — never a drop line (that sentence is about a bucket that stayed behind) and never the `window` placeholder',
    !!line && /matches exactly one account/.test(line.reason) && line.reason === moved.refiledReason && !/cannot be shown/.test(line.reason),
    JSON.stringify([line && line.reason, moved && moved.refiledReason]));
  ok('§16d ARCHIVE-NEVER-DESTROY holds for the silent half too: the line keeps the ORIGINAL record, undated utilizations and all',
    !!line && Math.abs(line.entry.buckets.sevenDay.u - 0.66) < 1e-9 && Math.abs(line.entry.buckets.fiveHour.u - 0.77) < 1e-9,
    JSON.stringify(line && line.entry.buckets));

  // NEGATIVE CONTROL — the r4 lines, as a PATCHED COPY of the real module
  {
    const src = read('src/reading-repair.js');
    const SUB = [
      ['      if (!primKept) drops.push(..._primaryDrops(prim, dest, ident, r.buckets));',
        "      if (!prim && dest !== ident && win.fiveHour) drops.push({ bucket: 'fiveHour', reason: `a five-hour window names a TIME, not an account, and this record states no 7-day window to travel with — it cannot be shown to be ${dest}'s` });\n      else if (prim && !primKept) drops.push({ bucket: 'sevenDay', reason: _dropReason(prim, dest, ident), alsoDropped: win.fiveHour ? ['fiveHour'] : undefined });"],
      ["refiledReason: (primKept && prim ? prim.reason : (([...scv.values()].find((v) => v.target === dest) || {}).reason || (drops[0] && drops[0].reason) || 'window')),",
        "refiledReason: (primKept && prim ? prim.reason : (drops[0] && drops[0].reason) || 'window'),"],
    ];
    let patched = src, hits = 0;
    for (const [from, to] of SUB) { if (patched.split(from).length === 2) { patched = patched.replace(from, to); hits++; } }
    ok('§16d NEGATIVE CONTROL setup: both pre-fix replacements hit the real module', hits === SUB.length, `hits=${hits}/${SUB.length}`);
    const R4 = patchedModule(path.join(d, 'r4-src'), 'reading-repair.js', patched);
    const dd = build(path.join(d, 'pre'));
    const r4 = R4.repairByWindow({ dataDir: dd, roster: [A, B], accounts: ACCOUNTS, id: 'W9pre' });
    const mv = rowsOf(dd, 'anchors-org_aaaa.ndjson').find((r) => r.refiledFrom === 'org_bbbb');
    const ar = fs.readFileSync(path.join(dd, 'archive', 'readings-window-anchors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.action === 'refiled');
    ok('§16d NEGATIVE CONTROL: r4 deletes both primary buckets from the moved row with NO line, calls it a WHOLE re-file with `bucketsArchived: 0`, and files it under the placeholder reason',
      !!mv && mv.buckets.sevenDay === null && mv.buckets.fiveHour === null && mv.droppedBuckets === undefined
      && r4.anchors.refiledWhole === 1 && r4.anchors.refiledPartial === 0 && r4.anchors.bucketsArchived === 0
      && !!ar && ar.buckets === undefined && ar.reason === 'window',
      JSON.stringify([r4.anchors, mv && mv.buckets, ar && ar.reason]));
  }
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
        // §12c IN THE REAL PANEL: the CODEX section used to say "via unknown /
        // No producer recorded this reading" about the only codex producer we
        // ship. Feed the snapshot the way /api/usage carries it (codexRateLimit
        // is what the 'auto' selection falls back to with no codex accounts).
        const cxSnap = { limitId: 'codex', limitName: '', planType: 'plus', fiveHour: { utilization: 0.2, usedPercent: 20, resetsAt: 0 }, sevenDay: { utilization: 0.3, usedPercent: 30, resetsAt: 0 }, fetchedAt: Date.now() };
        const renderCodex = async (snap) => {
          const p2 = { ...payload, accounts: {}, logins: {}, codexRateLimit: snap };
          const h = await ev('(() => {'
            + 'window.app._accounts = { accounts: [], defaultAccountId: null, defaultCodexAccountId: null };'
            + 'window.app._applyUsage(' + JSON.stringify(p2) + ');'
            + 'window.app._renderUsage();'
            + "return document.getElementById('usage-popup').innerHTML;"
            + '})()');
          // the codex section is the one that starts at its own 5-hour bar
          const i = String(h || '').indexOf('5-hour limit');
          return i >= 0 ? String(h).slice(i) : '';
        };
        const Hcx = await renderCodex({ ...cxSnap, source: 'codex-rate-limits' });
        ok('§10 the CODEX panel names its producer instead of "via unknown"', /class="usage-src"/.test(Hcx) && /own session/.test(Hcx) && !/unknown/.test(Hcx) && !/No producer recorded/.test(Hcx), Hcx.replace(/\s+/g, ' ').slice(-280));
        const HcxOld = await renderCodex(cxSnap);   // the PRE-FIX snapshot: no `source` at all
        ok('§10 NEGATIVE CONTROL: the pre-fix codex snapshot (no `source`) renders exactly the sentence the fix removes', /unknown/.test(HcxOld) && /No producer recorded/.test(HcxOld), HcxOld.replace(/\s+/g, ' ').slice(-280));
        cws.close();
      }
    } catch (e) {
      ok('§10 the browser leg ran', false, String(e && e.message).slice(0, 300));
    } finally { kill(); }
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);

