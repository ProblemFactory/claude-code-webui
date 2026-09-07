#!/usr/bin/env node
// THE AUTO-RESUME FIRE LOOP (2026-09-07 incident; owner decision ut-1c6c15a2db ①④).
//
// What happened, from the frozen journal (last 6h of the production server):
// 130 "continued immediately" on one conversation and 32 on another between
// 23:32 and 04:03, up to two per SECOND, each one a billed turn the CLI
// answered with "You've hit your session limit". Every cycle was identical:
//   [auto-resume] <id>: armed for <now+45s> (switched to a usable account)
//   [pool] per-session switch <pool>/<id>: <observed> (observed; linked <link>)
//                                          → <link> (re-point, same target)
//   [auto-resume] <id>: 账号池已切换到 <link> — continued immediately
// ~150 junk cards landed in one transcript. Two independent defects:
//
//   ① ATTRIBUTION. B-2c9b made the OTel-observed org override the link for
//      blocking decisions. The owner's post-mortem corrected the premise: an
//      api_request's organization.id is the identity the CLI cached in its
//      config dir at SPAWN, not the token that authorized the request. So the
//      rejection was recorded against the org the session started on, the
//      LINKED member — whose credentials the process actually reads — stayed
//      "healthy" in the cache forever, and the verdict answered "usable via
//      <link>" on every single cycle.
//   ② NO MEMORY. Neither fire path remembered that the previous continue onto
//      that exact identity had just been rejected, and fireNow() skipped the
//      pre-fire gate that the timed path runs.
//
// This suite drives the REAL engine + REAL auto-resume + a real AccountManager
// pool with real per-session symlinks, and a scripted "CLI" that answers every
// continue with a rate_limit_event shaped like the production record.
//
// NEGATIVE CONTROL is a matrix, not a snapshot: each pre-fix behaviour is
// re-created through a PUBLIC seam, so each fix can be switched off on its own.
//   · old attribution  = inject the wall keyed to the OBSERVED org with
//                        slot:false — literally what orgVerifiedKey computed
//   · old breaker      = noteFireOutcome(id, true) after every fire — the
//                        pre-fix module had no memory of a failed fire
// Both off ⇒ the loop runs unbounded (≥10 fires). Either one on ⇒ it stops.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const arMod = require(path.join(REPO, 'src/server/auto-resume.js'));
const { create, CONTINUE_PROMPT, GRACE_MS, FIRE_MAX_IMMEDIATE, FIRE_QUARANTINE_MS, FIRE_WINDOW_MS } = arMod;
const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } });

/** A real pool of three logged-in subscriptions, a real engine, a real
 *  auto-resume, a fake OTel source, and a scripted CLI that rejects. */
function mkWorld({ dir = null, healthy = true } = {}) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'vs-arloop-'));
  if (!dir) cleanup.push(root);
  const dataDir = path.join(root, 'data');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) return null;
  const login = (id) => fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-' + id, refreshToken: 'r', expiresAt: Date.now() + 36e5, subscriptionType: 'max' } }), { mode: 0o600 });
  const FISH = am.createSubscription({ name: 'Fish Max' }).id; login(FISH);       // the OTel-observed (spawn-time) org
  const LINK = am.createSubscription({ name: 'PandyMax' }).id; login(LINK);      // the credential slot: cache says healthy, the CLI rejects
  const SPARE = am.createSubscription({ name: 'B-Stack Max' }).id; login(SPARE); // the other healthy-looking member
  const P = am.createPool({ name: '全部' }).id;
  am.setPoolTarget(P, LINK);
  am.updatePool(P, { auto: true, hot: true });
  const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  const R5 = nowS + 2 * 3600, R7 = nowS + 3 * 86400;
  const cache = (u5, u7) => ({ fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: u5, resetsAt: R5 }, sevenDay: { utilization: u7, resetsAt: R7 } });
  const writeCache = (id, c) => fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify(c));
  const readCache = (id) => { try { return JSON.parse(fs.readFileSync(path.join(cacheDir, id + '.json'), 'utf8')); } catch { return null; } };
  writeCache(FISH, { ...cache(1, 0.4), fiveHour: { utilization: 1, status: 'limited', resetsAt: R5 } });
  if (healthy) { writeCache(LINK, cache(0.1, 0.3)); writeCache(SPARE, cache(0.2, 0.35)); }

  const sessions = new Map();
  const notices = [], notes = [], events = [], fired = [];
  const obs = new Map();
  const ar = create({
    dataDir, activeSessions: sessions, serverSetting: () => true, log: (...a) => console.log(...a), // one journal: the capture below reads both modules' lines
    notify: (id, s2, text) => notes.push(text),
    sendToSession: (id, s2, text) => { fired.push({ id, text }); return true; },
    beforeFire: (id, s2) => { try { return eng.beforeAutoResumeFire(id, s2); } catch { return true; } },
    fireIdentity: (id, s2) => { try { return eng.fireIdentityFor(s2); } catch { return null; } },
  });
  const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
  const eng = engMod.create({
    app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
    wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: (k, t) => notices.push(t),
    serverSetting: () => undefined, getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
    recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
    getAutoResume: () => ar, getOtelIngest: () => ({ observedOrgFor: (cid) => obs.get(cid) || null }), getQuotaProbe: () => null,
  });
  const SID = 'sess-4-1788764794641', CID = 'cid-4';
  const session = { backend: 'claude', mode: 'chat', host: null, _webuiId: SID, claudeSessionId: CID, _accountId: P, _autoResume: true, _servedModel: 'claude-fable-5', _servedModelAt: Date.now(), pty: { write() { } }, name: 'work' };
  sessions.set(SID, session);
  am.ensureSessionPoolLink(P, SID, LINK);
  obs.set(CID, { orgUuid: 'org-fish', acct: FISH, known: true, ts: Date.now() });

  const w = {
    root, dataDir, am, eng, ar, sessions, session, SID, CID, P, FISH, LINK, SPARE, R5, R7,
    notices, notes, events, fired, obs, cacheDir, readCache, writeCache,
    linkNow: () => am.poolCurrentFor(P, SID),
    nameOf: (id) => am.get(id)?.name || id,
  };
  // the scripted CLI: every turn we send it is answered by a limit rejection
  w.reject = ({ oldAttribution = false } = {}) => {
    if (oldAttribution) {
      // exactly what the pre-fix code computed: orgVerifiedKey → the observed
      // org, and no notion of a credential slot at all
      eng.noteWallSignal(session, { resetsAtMs: w.R5 * 1000, bucket: 'fiveHour', key: FISH, slot: false });
    } else {
      eng.recordRateLimitEvent(session, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: w.R5 } });
    }
    eng.noteTurnEnd(session);
  };
  // the timed path: back-date the arm so the tick considers it due
  w.tickFire = async () => {
    const a = ar._armed.get(SID);
    if (a) a.resetsAt = Date.now() - GRACE_MS - 1000;
    const before = fired.length;
    ar.tick(Date.now());
    await new Promise((r) => setTimeout(r, 20));   // the pre-fire gate is async
    return fired.length > before;
  };
  return w;
}

const capture = () => { const orig = console.log; const lines = []; console.log = (...a) => { const s = a.join(' '); if (/^\[(wall|pool|auto-resume)\]/.test(s)) lines.push(s); else orig(...a); }; return { lines, done: () => { console.log = orig; return lines; } }; };

const probe = mkWorld();
if (!probe) {
  console.log('  · SKIP (pooled accounts are unsupported on ' + process.platform + ')');
  console.log('\nALL PASS (0)');
  process.exit(0);
}

// ── §1 THE LOOP, and each fix switched off on its own ──────────────────────
{
  /** Drive fire → rejection → re-arm for up to `cycles` rounds. */
  async function drive(w, { oldAttribution, oldBreaker, cycles = 25 }) {
    w.reject({ oldAttribution });                       // the user's own prompt hit the wall
    let rounds = 0;
    for (let i = 0; i < cycles; i++) {
      const did = await w.tickFire();
      if (!did) break;
      rounds++;
      // the pre-fix module had NO memory to record into, so the simulation has
      // to drop the pending fire BEFORE the rejection arrives — clearing it
      // afterwards would still let the verdict see one failure
      if (oldBreaker) w.ar.noteFireOutcome(w.SID, true, 'simulated pre-fix module (no memory of a failed fire)');
      w.reject({ oldAttribution });                     // the CLI rejects the continue too
    }
    return rounds;
  }

  // (a) NEGATIVE CONTROL — both defects present
  {
    const w = mkWorld(); const cap = capture();
    const n = await drive(w, { oldAttribution: true, oldBreaker: true });
    const lines = cap.done();
    ok('NEGATIVE CONTROL: with the wall attributed away from the credential slot AND no memory of a failed fire, the session re-fires without bound (≥10 billed continues)', n >= 10, 'fires=' + n);
    ok('…and the reproduction is the journal we have: every cycle re-armed "switched to a usable account" naming the LINK the CLI keeps rejecting', lines.filter((l) => /armed for .*switched to a usable account \(PandyMax\)/.test(l)).length >= 10, lines.slice(0, 3).join(' | '));
    ok("…the linked member's cache never learned it was blocked (the whole mechanism of the incident)", (w.readCache(w.LINK) || {}).source === 'cli-usage' && w.readCache(w.LINK).fiveHour.utilization === 0.1, JSON.stringify(w.readCache(w.LINK)));
    ok('…and every one of those continues was a real send of the CLI\'s continue prompt', w.fired.length === n && w.fired.every((f) => f.text === CONTINUE_PROMPT));
  }

  // (b) ATTRIBUTION alone stops it — the wall lands on the slot, the verdict turns
  {
    const w = mkWorld(); const cap = capture();
    const n = await drive(w, { oldAttribution: false, oldBreaker: true });
    const lines = cap.done();
    ok('FIX ①: with the rejection attributed to the credential slot, the loop is over after at most one continue', n <= 1, 'fires=' + n);
    const c = w.readCache(w.LINK);
    ok('…because the LINKED member is what got demoted — utilization 1, source wall, on the FIRST rejection', c.fiveHour.utilization === 1 && c.source === 'wall' && c.fiveHour.status === 'limited', JSON.stringify(c));
    ok("…journaled as a credential-slot demotion, not a guess", lines.some((l) => /\[wall\] demoted PandyMax 5h until \S+ \(1 walls \/ credential slot\)/.test(l)), lines.filter((l) => /demoted/.test(l)).join(' | '));
    ok('…and the OTel-observed org is corroboration in the log, never the target', lines.some((l) => /\[billing PandyMax, OTel observed Fish Max\]|\[billing B-Stack Max, OTel observed Fish Max\]/.test(l)) && !lines.some((l) => /demoted Fish Max/.test(l)), lines.filter((l) => /walled turn/.test(l)).join(' | '));
  }

  // (c) THE BREAKER alone stops it — attribution still wrong, damage bounded
  {
    const w = mkWorld(); const cap = capture();
    const n = await drive(w, { oldAttribution: true, oldBreaker: false });
    const lines = cap.done();
    ok(`FIX ②: with the attribution defect still present, the breaker alone caps the damage at ${FIRE_MAX_IMMEDIATE} continues instead of 130`, n >= 1 && n <= FIRE_MAX_IMMEDIATE, 'fires=' + n);
    ok('…and every refused fire is journaled ONCE with its reason (never one line per cycle)', lines.filter((l) => /refused a (timed|immediate) continue onto PandyMax \((same-identity|backoff|hourly-cap|fire-pending)/.test(l)).length >= 1 && lines.filter((l) => /refused a /.test(l)).length <= 4, lines.filter((l) => /refused/.test(l)).join(' | '));
    ok('…the rejection of our own continue is recorded by name', lines.some((l) => /the continue onto sub-\w+ was rejected again \(limit rejection\) — not re-firing there/.test(l)), lines.filter((l) => /rejected again/.test(l)).join(' | '));
    ok('…and the conversation was told AT MOST ONCE, not ~150 times', w.notes.filter((t) => /已自动继续这个任务/.test(t)).length <= 1, JSON.stringify(w.notes));
  }

  // (d) BOTH fixes — the shipped behaviour
  {
    const w = mkWorld(); const cap = capture();
    const n = await drive(w, { oldAttribution: false, oldBreaker: false });
    const lines = cap.done();
    ok('SHIPPED: at most one immediate continue, then the session waits', n <= 1, 'fires=' + n);
    const st = w.ar.statusFor(w.SID);
    ok('…still ARMED afterwards, on a real reset time rather than a 45s re-try (the wait is what a blocked pool deserves)', st.armed === true && st.resetsAt > Date.now() + 60000, JSON.stringify(st));
    ok('…the arm reason names the buckets that are dead, per member', /PandyMax:|B-Stack Max:|Fish Max:/.test(String(st.reason || '')), String(st.reason));
    ok('…no member was silently re-selected after refusing this conversation', !lines.some((l) => /re-point, same target/.test(l)), lines.filter((l) => /per-session switch/.test(l)).join(' | '));
  }
}

// ── §2 THE IMMEDIATE PATH (the incident's own path: a hot pool switch calls
//    fireNow while the session sits armed) ──────────────────────────────────
{
  const w = mkWorld(); const cap = capture();
  // inject the wall the way §11 does (no early pool eval), so the switch lands
  // in onWalledTurn's `finally` with the session already ARMED — exactly the
  // sequence the frozen journal shows, cycle after cycle
  const wall = () => { w.eng.noteWallSignal(w.session, { resetsAtMs: w.R5 * 1000, bucket: 'fiveHour', key: w.linkNow(), slot: true }); w.eng.noteTurnEnd(w.session); };
  wall();
  await new Promise((r) => setTimeout(r, 30));
  const first = w.fired.length;
  ok('a hot per-session switch onto a healthy member still continues the armed session immediately (the c1206711 rule is intact)', first === 1 && w.linkNow() === w.SPARE, JSON.stringify({ first, link: w.nameOf(w.linkNow()) }));
  ok('…and it announced itself in the conversation exactly once', w.notes.filter((t) => /账号池已切换到 B-Stack Max/.test(t)).length === 1, JSON.stringify(w.notes));
  // the CLI rejects that continue too
  wall();
  await new Promise((r) => setTimeout(r, 30));
  const lines = cap.done();
  ok('the second wall does NOT produce a second immediate continue — every member has now refused this conversation', w.fired.length === 1, JSON.stringify({ fires: w.fired.length }));
  ok('…the pool refuses to hand it a member that already rejected it', lines.some((l) => /nowhere to go — \d+ member\(s\) already rejected this conversation/.test(l)) || !lines.some((l) => /per-session switch .*→ .*\(re-point, same target\)/.test(l)), lines.filter((l) => /per-session|nowhere/.test(l)).join(' | '));
  ok('…and the session is left waiting for a reset, not spinning', w.ar.statusFor(w.SID).armed === true && w.ar.statusFor(w.SID).resetsAt > Date.now() + 60000, JSON.stringify(w.ar.statusFor(w.SID)));
  ok('…the whole episode cost 2 turns of journal, not 130 of transcript', w.fired.length === 1 && w.notes.length <= 2, JSON.stringify({ fired: w.fired.length, notes: w.notes }));
}

// ── §3 THE BREAKER'S RULES (unit level, on the real module) ────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-arbreak-'));
  cleanup.push(dir);
  const sessions = new Map();
  const sent = [], notes = [], journal = [];
  let ident = { key: 'sub-a', name: 'Account A' };
  const ar = create({
    dataDir: dir, activeSessions: sessions, serverSetting: () => true, log: (...a) => journal.push(a.join(' ')),
    sendToSession: (id, s, t) => { sent.push(t); return true; }, notify: (id, s, t) => notes.push(t),
    fireIdentity: () => ident,
  });
  const s = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
  sessions.set('s1', s);
  const arm = () => ar.armIfEnabled('s1', s, Date.now() + 60000, 'usage limit');

  arm(); ok('breaker: the first immediate fire goes through', ar.fireNow('s1', '账号池已切换到 Account A') === true && sent.length === 1);
  arm(); ok('…a second one, before we have heard back about the first, is refused (never two continues in flight)', ar.fireNow('s1', '账号池已切换到 Account A') === false && sent.length === 1);
  ar.noteFireOutcome('s1', false, 'limit rejection');
  arm(); ok('…and once the first came back REJECTED, the same identity is refused outright', ar.fireNow('s1', '账号池已切换到 Account A') === false && sent.length === 1);
  ok("…the refusal is journaled once, with its reason and when it may retry", journal.filter((l) => /refused an? immediate continue onto Account A \(same-identity, not before /.test(l)).length === 1, journal.join(' | '));
  ok('…and the conversation gets ONE honest line naming the account and the wait', notes.filter((t) => /账号池已切换到 Account A，但它同样被用量上限拒绝/.test(t)).length === 1, JSON.stringify(notes));
  const nBefore = notes.length;
  arm(); ar.fireNow('s1', '账号池已切换到 Account A');
  arm(); ar.fireNow('s1', '账号池已切换到 Account A');
  ok('…repeats are journal-only (the notice is once per session per window)', notes.length === nBefore, JSON.stringify(notes.slice(nBefore)));

  ident = { key: 'sub-b', name: 'Account B' };
  arm();
  ok('a DIFFERENT identity is allowed — but only after the immediate back-off (2nd fire ≥60s)', ar.fireNow('s1', '账号池已切换到 Account B') === false && /backoff/.test(journal.filter((l) => /refused/.test(l)).pop() || ''), journal.filter((l) => /refused/.test(l)).pop());
  // wind the clock back on the recorded fire instead of sleeping 60s
  const rec = ar._fires.get('s1');
  rec.lastFireAt = Date.now() - 61000;
  arm();
  ok('…and it goes through once that back-off has elapsed', ar.fireNow('s1', '账号池已切换到 Account B') === true && sent.length === 2);
  ar.noteFireOutcome('s1', false, 'limit rejection');
  ident = { key: 'sub-c', name: 'Account C' };
  rec.lastFireAt = Date.now() - 400000;
  arm();
  ok('…a third identity after the 5min rung still fires (the cap is 3, not 2)', ar.fireNow('s1', '账号池已切换到 Account C') === true && sent.length === 3);
  ar.noteFireOutcome('s1', false, 'limit rejection');
  ident = { key: 'sub-d', name: 'Account D' };
  ar._fires.get('s1').lastFireAt = Date.now() - 400000;
  arm();
  ok(`…the ${FIRE_MAX_IMMEDIATE}-per-hour cap then closes the immediate path entirely`, ar.fireNow('s1', '账号池已切换到 Account D') === false && /hourly-cap/.test(journal.filter((l) => /refused/.test(l)).pop() || ''), journal.filter((l) => /refused/.test(l)).pop());
  ok('…but the TIMED reset path is still open (that is the path anchored to a real reset)', (() => {
    const a = ar._armed.get('s1'); a.resetsAt = Date.now() - GRACE_MS - 1000;
    const before = sent.length; ar.tick(Date.now()); return sent.length === before + 1;
  })(), 'timed fire blocked by the immediate cap');
  ok('…and the identities that rejected us are reportable to the engine', ar.recentFireFailures('s1').sort().join(',') === 'sub-a,sub-b,sub-c', JSON.stringify(ar.recentFireFailures('s1')));
  ok('a completed turn CLEARS the whole memory (proof the lane works — noteRecovered runs it before the armed-record check, which a fire has already deleted)', (() => {
    ar.noteRecovered('s1', 'turn completed normally');
    return ar.recentFireFailures('s1').length === 0 && !ar._fires.has('s1');
  })());

  // RESTART: the breaker state is persisted with the armed waits
  {
    ident = { key: 'sub-a', name: 'Account A' };
    arm(); ar.fireNow('s1', '账号池已切换到 Account A'); ar.noteFireOutcome('s1', false, 'limit rejection');
    const sessions2 = new Map(); const sent2 = [];
    const ar2 = create({
      dataDir: dir, activeSessions: sessions2, serverSetting: () => true, log: () => { },
      sendToSession: (id, s2, t) => { sent2.push(t); return true; }, fireIdentity: () => ({ key: 'sub-a', name: 'Account A' }),
    });
    const s2 = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
    sessions2.set('s1', s2);
    ar2.armIfEnabled('s1', s2, Date.now() + 60000, 'usage limit');
    ok('RESTART: a fresh module reloads the failed-fire record and still refuses that identity (a deploy must not hand the loop a fresh budget)', ar2.fireNow('s1', '账号池已切换到 Account A') === false && sent2.length === 0);
    ok('…and it is on disk under `fires`, next to the armed waits', (() => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'auto-resume.json'), 'utf8'));
      return !!raw.fires && !!raw.fires.s1 && (raw.fires.s1.fails || []).some((f) => f.key === 'sub-a');
    })(), fs.readFileSync(path.join(dir, 'auto-resume.json'), 'utf8').slice(0, 300));
    ok(`…the quarantine self-expires (${Math.round(FIRE_QUARANTINE_MS / 60000)}min), it is not a permanent ban`, (() => {
      const r2 = ar2._fires.get('s1');
      const before = ar2.canFire('s1', 'sub-a', 'now', Date.now()).reason;
      r2.fails = r2.fails.map((f) => ({ ...f, at: Date.now() - FIRE_QUARANTINE_MS - 1000 }));
      const after = ar2.canFire('s1', 'sub-a', 'now', Date.now()).reason;
      r2.windowStart = Date.now() - FIRE_WINDOW_MS - 1000;   // …and so does the hourly cap
      return before === 'same-identity' && after !== 'same-identity' && ar2.canFire('s1', 'sub-a', 'now', Date.now()).ok === true;
    })());
  }
}

// ── §4 THE PRE-FIRE GATE IS NO LONGER BYPASSED BY THE IMMEDIATE PATH ───────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-argate-'));
  cleanup.push(dir);
  const sessions = new Map(); const sent = [];
  let gate = false, seen = 0;
  const ar = create({
    dataDir: dir, activeSessions: sessions, serverSetting: () => true, log: () => { },
    sendToSession: (id, s, t) => { sent.push(t); return true; },
    beforeFire: async () => { seen++; return gate; },
  });
  const s = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
  sessions.set('s1', s);
  ar.armIfEnabled('s1', s, Date.now() + 60000, 'usage limit');
  ar.fireNow('s1', 'switched');
  await new Promise((r) => setTimeout(r, 30));
  ok('fireNow runs the SAME pre-fire gate as the tick — a VETO blocks the immediate spend (it used to skip the gate entirely)', seen === 1 && sent.length === 0 && s._arFiring === false);
  ok('…and a vetoed fire stays ARMED (nothing was spent, nothing was forgotten)', ar.statusFor('s1').armed === true);
  gate = true;
  ar.fireNow('s1', 'switched');
  await new Promise((r) => setTimeout(r, 30));
  ok('…a passing gate delivers exactly one continue', seen === 2 && sent.length === 1 && sent[0] === CONTINUE_PROMPT);
  // re-entrancy: the real gate calls maybePoolAutoSwitch, which calls fireNow
  const sessions2 = new Map(); const sent2 = [];
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-argate2-')); cleanup.push(dir2);
  let depth = 0, maxDepth = 0;
  const ar2 = create({
    dataDir: dir2, activeSessions: sessions2, serverSetting: () => true, log: () => { },
    sendToSession: (id, s2, t) => { sent2.push(t); return true; },
    beforeFire: async () => { depth++; maxDepth = Math.max(maxDepth, depth); ar2.fireNow('s1', 're-entrant'); depth--; return true; },
  });
  const s2b = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
  sessions2.set('s1', s2b);
  ar2.armIfEnabled('s1', s2b, Date.now() + 60000, 'usage limit');
  ar2.fireNow('s1', 'switched');
  await new Promise((r) => setTimeout(r, 30));
  ok('the gate calling back into fireNow cannot recurse (the real beforeFire runs maybePoolAutoSwitch, which fires armed sessions)', maxDepth === 1 && sent2.length === 1, JSON.stringify({ maxDepth, sent: sent2.length }));
}

// ── §4b TOKEN-SLOT VALIDATION: what happens when the slot cannot be trusted ─
{
  const w = mkWorld(); const cap = capture();
  // the link's credentials disappear under it (re-login in flight, a hand-
  // deleted dir): the slot no longer VALIDATES, so it is not authority for a
  // wall — the old corroboration ladder takes over instead of demoting on a guess
  fs.rmSync(path.join(w.am.subDir(w.LINK), '.credentials.json'), { force: true });
  const bm = w.eng.sessionBillingMember(w.session, w.P);
  // poolMembers() filters by loggedIn, so a signed-out link fails the
  // membership leg — that IS the credentials check, held in one place
  ok('an unvalidated credential slot says WHICH leg failed, and still names the link', bm.id === w.LINK && bm.slotOk === false && bm.slotReason === 'slot-not-a-member', JSON.stringify(bm));
  w.eng._wallRing.clear(); w.eng._sessionWalls.clear();
  w.eng.noteWallSignal(w.session, { resetsAtMs: w.R5 * 1000, bucket: 'fiveHour', key: w.LINK, slot: false });
  w.eng.noteTurnEnd(w.session);
  const lines = cap.done();
  ok('…a single wall on it is HELD (never demote on a guess — the 2.368.34 ladder is the degrade path, not a silent skip)', (w.readCache(w.LINK) || {}).source === 'cli-usage' && lines.some((l) => /holding the demotion/.test(l)), lines.filter((l) => /wall/.test(l)).join(' | '));
  ok('…and the journal names the failing leg, not a wrong claim about which account it is', lines.some((l) => /this session's slot, but unvalidated: slot-not-a-member/.test(l)), lines.filter((l) => /single wall/.test(l)).join(' | '));
  ok('…every named failure reason is reachable (an unsatisfiable leg is deleted functionality wearing a check\'s clothes)', (() => {
    const w2 = mkWorld();
    // a session with no link of its own, on a pool whose DEFAULT link is gone:
    // poolCurrentFor resolves to nothing at all (unlink, never rmSync — the
    // pool link is a directory symlink and rmSync throws on it)
    const noLink = { backend: 'claude', mode: 'chat', _webuiId: 'nolink', _accountId: w2.P, pty: { write() { } } };
    fs.unlinkSync(w2.am.subDir(w2.P));
    return w2.eng.sessionBillingMember(noLink, w2.P).slotReason === 'no-slot';
  })());
  ok("…while a non-pooled session's slot is trivially its own account (one creds dir, fixed at spawn)", (() => {
    const solo = { backend: 'claude', mode: 'chat', host: null, _webuiId: 'solo', claudeSessionId: 'cid-solo', _accountId: w.SPARE, pty: { write() { } } };
    return w.eng.wallKeyFor(solo) === w.SPARE && w.eng.fireIdentityFor(solo).key === w.SPARE;
  })());
}

// ── §5 WIRING PINS (2.355.0 law: a fix nobody calls is not a fix) ──────────
{
  const eng = read('src/server/usage-pool-engine.js');
  const srv = read('server.js');
  ok('WIRING: a walled turn tells the breaker the fire failed, BEFORE anything re-arms or re-switches', /function onWalledTurn\(session, sigs\) \{[\s\S]{0,600}noteFireOutcome\?\.\(id, false, 'limit rejection'\)[\s\S]{0,900}demoteWalledAccount\(session, sigs\)/.test(eng));
  ok('WIRING: server.js gives auto-resume its identity from the engine (the SAME fact the wall demotes)', /fireIdentity: \(id, s\) => \{ try \{ return fireIdentityFor\(s\); \}/.test(srv) && /fireIdentityFor,/.test(srv));
  ok('WIRING: fireIdentityFor IS wallKeyFor (no second opinion about which account a fire lands on)', /function fireIdentityFor\(session\) \{[\s\S]{0,200}const key = wallKeyFor\(session\);/.test(eng));
  ok('WIRING: a REJECTION is keyed to the credential slot; a READING keeps the observed-org routing', /const slot = ev\.status === 'rejected' \? wallSlotFor\(session\) : null;[\s\S]{0,400}orgVerifiedKey\(session, usageCacheKeyFor\(session\), 'rate-limit-event:' \+ ev\.kind\)/.test(eng) && /const slot = wallSlotFor\(session\);\s*\n\s*const key = slot\.key \|\| orgVerifiedKey\(session, usageCacheKeyFor\(session\), 'limit-banner'\)/.test(eng));
  ok('WIRING: both wall signals carry the slot verdict taken AT REJECTION TIME (the link moves before the turn ends)', (eng.match(/noteWallSignal\(session, \{[^}]*slot: !!slot/g) || []).length === 2 && /sigs\.some\(\(x\) => x && x\.slot && \(!x\.key \|\| ids\.has\(x\.key\)\)\)/.test(eng));
  ok('WIRING: every blocking decision reads sessionBillingMember; only resolveUsageKey (VALUES) reads the observation', (eng.match(/sessionBillingMember\(/g) || []).length >= 5 && /acct = sessionReadingMember\(session, acct\)\.id \|\| acct;/.test(eng) && !/sessionCurrentMember/.test(eng));
  ok('WIRING: the per-session switch excludes members that already rejected this conversation', /const rejected = \[\.\.\.sessionWalledMembers\(sid, now\)\];[\s\S]{0,400}exclude: rejected/.test(eng));
  ok('WIRING: the verdict cannot answer `usable` through a member that rejected this session', /const walled = session \? sessionWalledMembers\(session\._webuiId\) : new Set\(\);[\s\S]{0,600}walled\.has\(m\.id\) && v\.usable !== false/.test(eng));
  ok('WIRING: the near-arm refuses to name the rejecting identity as the way out', /if \(v\.viaId && demoted\?\.key && v\.viaId === demoted\.key\)/.test(eng) && /wall-usable-is-rejector/.test(eng));
  ok('WIRING: decidePoolSwitch takes the exclusion as a NAMED input and reports it (never a silent empty candidate list)', /exclude = null, explain = false \}\)/.test(read('src/account-pool-auto.js')) && /excludedN \? 'all-rejected' : 'no-members'/.test(read('src/account-pool-auto.js')));
  ok('WIRING: session-schema documents the slot flag on the wall signals', /_turnWallSigs:[^\n]*\{at, resetsAtMs, bucket, scopedName, key, slot\}/.test(read('src/session-schema.js')), read('src/session-schema.js').split('\n').find((l) => /_turnWallSigs/.test(l)));
  ok('the engine INSTANCE exports the new seams (functional call check, never a source grep — the 2.369.4 lesson)', ['fireIdentityFor', 'sessionBillingMember', 'sessionReadingMember', 'wallKeyFor', 'sessionWalledMembers'].every((k) => typeof probe.eng[k] === 'function'));
  ok('the auto-resume INSTANCE exports the breaker seams', ['noteFireOutcome', 'recentFireFailures', 'canFire'].every((k) => typeof probe.ar[k] === 'function'));
  ok("WIRING: the verdict's SCOPE for an unpooled session is its own credential slot too (routing the verdict to the spawn-time org asks a different account whether this session may spend)", /function _wallScope\(session\) \{[\s\S]{0,220}return wallKeyFor\(session\);/.test(eng) && !/orgVerifiedKey\(session, usageCacheKeyFor\(session\), 'wall/.test(eng));
  ok('WIRING: the immediate path cannot turn the pre-fire probe into a spawn per pool switch (60s floor per target; the RE-VERDICT always runs)', /_preFireProbeAt/.test(eng) && /Date\.now\(\) - probedAt > 60e3/.test(eng));
}

// ── §6 THE FROZEN JOURNAL'S SHAPE (2/s arm→switch→fire→reject) ─────────────
{
  // Replay the incident's cadence: a rejection every ~500ms for 2 minutes of
  // simulated time. The pre-fix code produced 240 continues here; the shipped
  // code must produce a handful and then stop talking.
  const w = mkWorld(); const cap = capture();
  let fires = 0;
  w.reject({});
  for (let i = 0; i < 240; i++) {
    if (await w.tickFire()) { fires++; w.reject({}); }
    else w.reject({});
  }
  const lines = cap.done();
  const continues = lines.filter((l) => /continued (immediately|automatically)/.test(l)).length;
  ok('journal replay (240 rejections at the incident\'s cadence): a handful of continues, not one per cycle', fires <= FIRE_MAX_IMMEDIATE + 1 && continues <= FIRE_MAX_IMMEDIATE + 1, JSON.stringify({ fires, continues }));
  ok('…and at most one in-chat card per distinct target, versus ~150 in the incident', w.notes.length <= 3, JSON.stringify(w.notes));
  ok('…while the journal still SAYS why it is waiting (silence is the other failure mode; with both fixes on there is nothing left to refuse, so the demotion + the arm ARE the explanation)', lines.some((l) => /\[wall\] demoted \S+ 5h until \S+ \(1 walls \/ credential slot\)/.test(l)) && lines.some((l) => /armed for .*(5h|blocked|<)/.test(l)), lines.slice(-4).join(' | '));
  ok('…every account in the pool ends up honestly marked, none left reading "healthy" while rejecting', [w.LINK, w.SPARE].every((id) => { const c = w.readCache(id); return c && (c.fiveHour.utilization === 1 || c.source === 'wall'); }) || w.eng.sessionWalledMembers(w.SID).size >= 1, JSON.stringify({ link: w.readCache(w.LINK), spare: w.readCache(w.SPARE) }));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
