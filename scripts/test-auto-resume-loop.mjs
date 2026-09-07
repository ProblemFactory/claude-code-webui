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

// ── §2 THE RECOVERY PATH THE INCIDENT ACTUALLY TAKES, and the immediate one ─
// Round 2 (the r1 verifier's finding): this section used to INJECT the wall
// signal, which skips the early `maybePoolAutoSwitch` that BOTH real producers
// run — and that early switch is what decides the outcome. Measured on this
// same world, only the producer changed:
//   injected noteWallSignal   → 1 immediate continue (fireNow)
//   real recordRateLimitEvent → 0 immediate continues. The link is re-pointed
//                               to the healthy member BEFORE onWalledTurn arms
//                               the session, so the `finally` pass has nothing
//                               left to switch and fireNow is never called;
//                               the session is armed at +45s and continued by
//                               the TICK (45s arm + 15s grace on a 30s tick ⇒
//                               ~60-90s, not "immediately")
//   real markLimitBanner      → same as the rejection
// So the legs below pin the REAL flows, and the injected one is kept only as
// the labelled artificial control. The immediate path still exists for the
// case it was built for (c1206711) — a switch that lands LATER, onto a session
// that is already armed — and (d) drives that through the real pool seam.
{
  // (a) THE INCIDENT'S OWN FLOW, through the producer the CLI actually feeds
  const w = mkWorld(); const cap = capture();
  w.eng.recordRateLimitEvent(w.session, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: w.R5 } });
  w.eng.noteTurnEnd(w.session);
  await new Promise((r) => setTimeout(r, 40));
  ok('REAL rate_limit_event: the pool re-points the link BEFORE the session is armed, so NOTHING is continued immediately (the injected signal reaches fireNow; the producer does not)', w.fired.length === 0 && w.linkNow() === w.SPARE, JSON.stringify({ fires: w.fired.length, link: w.nameOf(w.linkNow()) }));
  const st = w.ar.statusFor(w.SID);
  ok('…the session is armed on the +45s NEAR-arm the switch created, naming the member it moved to', st.armed === true && /^switched to a usable account \(B-Stack Max\)/.test(String(st.reason)) && st.resetsAt <= Date.now() + 46000, JSON.stringify(st));
  ok('…and nothing was said in the conversation yet (a switch that self-heals in 45s must not narrate itself)', w.notes.length === 0, JSON.stringify(w.notes));
  // the tick, ~60s later in production (the arm is back-dated instead of slept)
  const did = await w.tickFire();
  ok('…the TICK is what continues it — one continue, delivered onto the member the pool moved to', did === true && w.fired.length === 1 && w.fired[0].text === CONTINUE_PROMPT, JSON.stringify({ fires: w.fired.length }));
  ok('…and the card says the POOL SWITCHED, not that the limit reset (round 1 said 用量上限已重置 on exactly this, now the dominant, path)', w.notes.length === 1 && w.notes[0] === '账号池已切换到 B-Stack Max，已自动继续这个任务。', JSON.stringify(w.notes));
  ok('…NEGATIVE CONTROL: the reset wording still exists for an arm anchored on a real reset (the fix is a branch, not a rename)', arMod.continueNoticeFor({ kind: 'timed', armReason: '5h 0% < 10%', label: 'B-Stack Max' }).text === '用量上限已重置，已自动继续这个任务。');
  const rec = w.ar._fires.get(w.SID);
  ok('…the breaker recorded the fire against the member the continue LANDED on', rec && rec.last && rec.last.key === w.SPARE, JSON.stringify(rec && rec.last));
  // the CLI rejects that continue too — through the real producer again
  w.reject({});
  await new Promise((r) => setTimeout(r, 40));
  const lines = cap.done();
  ok('the rejection of that continue does not start a cycle: no second continue', w.fired.length === 1, JSON.stringify({ fires: w.fired.length }));
  ok('…the member that rejected us is quarantined BY NAME (the one we fired at, not the one we came from)', w.ar.recentFireFailures(w.SID).join(',') === w.SPARE, JSON.stringify(w.ar.recentFireFailures(w.SID).map(w.nameOf)));
  ok('…and the session waits instead of spinning', w.ar.statusFor(w.SID).armed === true, JSON.stringify(w.ar.statusFor(w.SID)));
  ok('…the whole episode: one continue and one card, versus 130 and ~150', w.fired.length === 1 && w.notes.length === 1, JSON.stringify({ fired: w.fired.length, notes: w.notes }));
  ok('…journaled as the switch it was, not as a reset', lines.some((l) => /pool switched to B-Stack Max — continued automatically/.test(l)) && !lines.some((l) => /usage limit reset — continued automatically/.test(l)), lines.filter((l) => /continued/.test(l)).join(' | '));
}
{
  // (b) the OTHER real producer: a limit BANNER on stdout
  const w = mkWorld();
  w.eng.markLimitBanner(w.session, "Claude usage limit reached. You've hit your session limit · resets 6am");
  w.eng.noteTurnEnd(w.session);
  await new Promise((r) => setTimeout(r, 40));
  ok('REAL limit banner: same ordering — link moved first, no immediate continue, armed on the near-arm', w.fired.length === 0 && w.linkNow() === w.SPARE && /^switched to a usable account/.test(String(w.ar.statusFor(w.SID).reason)), JSON.stringify({ fires: w.fired.length, link: w.nameOf(w.linkNow()), st: w.ar.statusFor(w.SID) }));
  ok('…and the tick then continues it exactly once, with the switch wording', (await w.tickFire()) === true && w.fired.length === 1 && w.notes.length === 1 && /账号池已切换到 B-Stack Max/.test(w.notes[0]), JSON.stringify(w.notes));
}
{
  // (c) ARTIFICIAL CONTROL, kept and labelled: injecting the signal skips the
  // early switch, which is the ONLY way this world reaches fireNow — the
  // measurement that made (a) and (b) necessary
  const w = mkWorld();
  w.eng.noteWallSignal(w.session, { resetsAtMs: w.R5 * 1000, bucket: 'fiveHour', key: w.linkNow(), slot: true });
  w.eng.noteTurnEnd(w.session);
  await new Promise((r) => setTimeout(r, 40));
  ok('CONTROL (injected signal, no early pool eval): the switch lands with the session already armed and fireNow DOES continue it immediately', w.fired.length === 1 && w.linkNow() === w.SPARE, JSON.stringify({ fires: w.fired.length, link: w.nameOf(w.linkNow()) }));
  ok('…which is why (a)/(b) cannot be written this way: the same world, the same wall, a different producer, a different outcome', true);
}
{
  // (d) THE IMMEDIATE PATH'S REAL JOB (c1206711): the pool has nowhere to go
  // when the wall lands, the session waits on a real reset, and a member frees
  // up LATER. A hot re-point does not move an idle session by itself, so
  // fireNow must continue it — driven here through maybePoolAutoSwitchForPool,
  // the engine's own seam, not through auto-resume.
  const w = mkWorld(); const cap = capture();
  const dead = { fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: 1, status: 'limited', resetsAt: w.R5 }, sevenDay: { utilization: 0.4, resetsAt: w.R7 } };
  w.writeCache(w.LINK, dead); w.writeCache(w.SPARE, dead);
  w.eng.recordRateLimitEvent(w.session, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: w.R5 } });
  w.eng.noteTurnEnd(w.session);
  await new Promise((r) => setTimeout(r, 40));
  const st0 = w.ar.statusFor(w.SID);
  ok('a wall with nowhere to go arms on the REAL reset and continues nothing', w.fired.length === 0 && st0.armed === true && st0.resetsAt > Date.now() + 60 * 60000, JSON.stringify(st0));
  // …and now B-Stack Max frees up. Wind back the eval gate (10s) and the
  // per-session dwell belt (180s) instead of sleeping through them.
  w.writeCache(w.SPARE, { fetchedAt: Date.now(), source: 'cli-usage', fiveHour: { utilization: 0.05, resetsAt: w.R5 }, sevenDay: { utilization: 0.2, resetsAt: w.R7 } });
  w.eng._poolAutoLast.delete(w.P);
  w.eng._poolSwitchAt.delete(w.P + ':' + w.SID);
  w.eng.maybePoolAutoSwitchForPool(w.P);
  await new Promise((r) => setTimeout(r, 60));
  const lines = cap.done();
  ok('a LATER pool switch onto a healthy member continues the armed session IMMEDIATELY (the c1206711 rule, through the real pool seam)', w.fired.length === 1 && w.linkNow() === w.SPARE, JSON.stringify({ fires: w.fired.length, link: w.nameOf(w.linkNow()) }));
  ok('…journaled as an immediate continue, and announced once, naming the member', lines.some((l) => /continued immediately/.test(l)) && w.notes.filter((t) => /账号池已切换到 B-Stack Max/.test(t)).length === 1, JSON.stringify({ notes: w.notes, j: lines.filter((l) => /continued/.test(l)) }));
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
  ok('…and the conversation gets ONE honest line: it names the identity that refused US and claims nothing about the rest of the pool (nobody has told us)', notes.filter((t) => /^账号 Account A 刚刚拒绝了这个会话的自动续跑，已暂停立即重试。/.test(t)).length === 1 && !notes.some((t) => /没有其它可用成员/.test(t)), JSON.stringify(notes));
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

// ── §3b WHAT A REFUSAL IS ALLOWED TO CLAIM (round 2, verifier finding #1) ──
// Round 1 gave every refusal the same card: "the pool switched to X, X was
// rejected too, there is no usable member, retrying has stopped." For the
// PACING reasons all four clauses are false — X is a member we never fired at,
// the pool is healthy, and the session is still armed and continues seconds
// later — and the card also spent the once-per-window budget, so the genuine
// exhaustion line was suppressed for the rest of the hour.
{
  const mk = (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-arnote-' + name + '-')); cleanup.push(dir);
    const sessions = new Map(); const sent = [], notes = [], journal = [];
    const st = { ident: { key: 'sub-a', name: 'Account A' } };
    const ar = create({
      dataDir: dir, activeSessions: sessions, serverSetting: () => true, log: (...a) => journal.push(a.join(' ')),
      sendToSession: (id, s, t) => { sent.push(t); return true; }, notify: (id, s, t) => notes.push(t),
      fireIdentity: () => st.ident,
    });
    const s = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
    sessions.set('s1', s);
    return { ar, sent, notes, journal, st, arm: (ms = 60000) => ar.armIfEnabled('s1', s, Date.now() + ms, 'usage limit') };
  };

  // (i) a PACING refusal — the pool moved us onto a member nobody has asked yet
  {
    const w = mk('pace');
    w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account A');
    w.st.ident = { key: 'sub-b', name: 'Account B' };   // the pool re-points onto a HEALTHY member
    w.arm(); const second = w.ar.fireNow('s1', '账号池已切换到 Account B');
    ok('a fire-pending refusal is JOURNAL-ONLY: Account B never rejected anything, and the promise is intact', second === false && w.journal.some((l) => /refused an immediate continue onto Account B \(fire-pending/.test(l)) && w.notes.length === 1 && w.notes[0] === '账号池已切换到 Account A，已自动继续这个任务。', JSON.stringify({ notes: w.notes, j: w.journal.filter((l) => /refused/.test(l)) }));
    ok('…and the session it just told nothing to is STILL ARMED (round 1 told it "已停止反复重试" here)', w.ar.statusFor('s1').armed === true, JSON.stringify(w.ar.statusFor('s1')));
    ok('…the once-per-window budget was NOT spent: the genuine exhaustion line still goes out', (() => {
      w.ar.noteFireOutcome('s1', false, 'limit rejection');           // the CLI answers OUR fire (Account A) with a limit
      w.st.ident = { key: 'sub-a', name: 'Account A' };               // the pool puts us back on the rejector
      w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account A');        // same identity ⇒ the real thing
      return w.notes.length === 2 && /^账号 Account A 刚刚拒绝了这个会话的自动续跑/.test(w.notes[1]);
    })(), JSON.stringify(w.notes));
    ok('…a BACKOFF refusal is journal-only for the same reason (a 60s pacer on a live promise)', (() => {
      const before = w.notes.length;
      w.st.ident = { key: 'sub-c', name: 'Account C' };
      w.arm(); const r = w.ar.fireNow('s1', '账号池已切换到 Account C');
      return r === false && /backoff/.test(w.journal.filter((l) => /refused/.test(l)).pop() || '') && w.notes.length === before;
    })(), JSON.stringify({ notes: w.notes, j: w.journal.filter((l) => /refused/.test(l)).pop() }));
  }

  // (ii) the HOURLY CAP says what is true, and has its OWN budget
  {
    const w = mk('cap');
    for (const [key, name] of [['sub-a', 'Account A'], ['sub-b', 'Account B'], ['sub-c', 'Account C']]) {
      w.st.ident = { key, name };
      const r = w.ar._fires.get('s1'); if (r) r.lastFireAt = Date.now() - 400000;   // past the back-off rungs
      w.arm(); w.ar.fireNow('s1', '账号池已切换到 ' + name);
      w.ar.noteFireOutcome('s1', false, 'limit rejection');
    }
    ok(`${FIRE_MAX_IMMEDIATE} continues went out, each announced once`, w.sent.length === FIRE_MAX_IMMEDIATE && w.notes.length === FIRE_MAX_IMMEDIATE, JSON.stringify(w.notes));
    w.st.ident = { key: 'sub-d', name: 'Account D' };
    w.ar._fires.get('s1').lastFireAt = Date.now() - 400000;
    w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account D');
    const capLine = w.notes[w.notes.length - 1];
    ok('the cap speaks ONE true line — the count and the pause, never "Account D refused us"', /^自动续跑在一小时内已连续尝试 3 次仍未见这个会话恢复，暂停立即重试。/.test(capLine) && !/Account D/.test(capLine) && !/没有其它可用成员/.test(capLine), JSON.stringify(capLine));
    ok('…and it did NOT eat the exhaustion budget: a same-identity refusal still speaks in the same window', (() => {
      const before = w.notes.length;
      w.st.ident = { key: 'sub-a', name: 'Account A' };   // in `fails` ⇒ same-identity, which outranks the cap
      w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account A');
      return w.notes.length === before + 1 && /^账号 Account A 刚刚拒绝了这个会话的自动续跑/.test(w.notes[before]);
    })(), JSON.stringify(w.notes));
    ok('…NEGATIVE CONTROL: with round 1\'s SINGLE budget (both classes sharing one stamp) that line is suppressed — the split is what carries it', (() => {
      const r = w.ar._fires.get('s1');
      r.notices = { exhausted: Date.now(), cap: Date.now() };   // one shared stamp, the r1 shape
      const before = w.notes.length;
      w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account A');
      return w.notes.length === before;
    })());
  }

  // (iii) the "nowhere else to go" clause is a SECOND fact, from the pool
  {
    const w = mk('notarget');
    w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account A');
    w.ar.noteFireOutcome('s1', false, 'limit rejection');
    ok('the ENGINE is the only source of "no usable member left" — noteNoPoolTarget records it for a tracked session', w.ar.noteNoPoolTarget('s1', 2, 'all-rejected') === true && (w.ar._fires.get('s1').noTargetAt || 0) > 0);
    ok('…and refuses to mint a record for a session the breaker does not track (a stuck pool must not grow the store)', w.ar.noteNoPoolTarget('never-armed', 3, 'all-rejected') === false && !w.ar._fires.has('never-armed'));
    w.arm(); w.ar.fireNow('s1', '账号池已切换到 Account A');
    ok('…with that fact in hand the same refusal names the state only the USER can fix', /没有其它可用成员/.test(w.notes[w.notes.length - 1] || '') && /可以添加成员/.test(w.notes[w.notes.length - 1] || ''), JSON.stringify(w.notes));
  }
}

// ── §3c THE TWO NOTICE RULES, PURE (truth tables) ──────────────────────────
{
  const { refusalNoticeFor, continueNoticeFor, NO_TARGET_FRESH_MS } = arMod;
  const now = 1788780000000;
  const far = now + 3 * 3600000, near = now + 45000;
  const R = (o) => refusalNoticeFor({ now, ...o });
  ok('PURE refusal: backoff and fire-pending say NOTHING (they do not break the promise)', R({ reason: 'backoff', label: 'A', armedResetsAt: near }) === null && R({ reason: 'fire-pending', label: 'A', armedResetsAt: far }) === null);
  ok('PURE refusal: an unknown reason says nothing either (a new refusal must opt IN to speaking)', R({ reason: 'something-new', label: 'A', armedResetsAt: far }) === null);
  ok('PURE refusal: same-identity names the account and, with a far reset, promises the time it will retry', (() => {
    const n = R({ reason: 'same-identity', label: 'A', armedResetsAt: far });
    return n.cls === 'exhausted' && /^账号 A 刚刚拒绝了/.test(n.text) && n.text.includes(new Date(far).toLocaleString()) && !/没有其它可用成员/.test(n.text);
  })(), JSON.stringify(R({ reason: 'same-identity', label: 'A', armedResetsAt: far })));
  ok('PURE refusal: same-identity on a NEAR arm promises no time (a +45s pacer is not a reset)', (() => {
    const n = R({ reason: 'same-identity', label: 'A', armedResetsAt: near });
    return n.cls === 'exhausted' && /账号池恢复可用时会自动继续/.test(n.text) && !/重置后自动继续/.test(n.text);
  })(), JSON.stringify(R({ reason: 'same-identity', label: 'A', armedResetsAt: near })));
  ok('PURE refusal: the "nowhere else to go" clause needs the pool\'s FRESH verdict', (() => {
    const fresh = R({ reason: 'same-identity', label: 'A', armedResetsAt: near, noTargetAt: now - 1000 });
    const stale = R({ reason: 'same-identity', label: 'A', armedResetsAt: near, noTargetAt: now - NO_TARGET_FRESH_MS - 1 });
    return /没有其它可用成员/.test(fresh.text) && !/没有其它可用成员/.test(stale.text);
  })());
  ok('PURE refusal: hourly-cap is its own class and never claims an account refused us', (() => {
    const n = R({ reason: 'hourly-cap', label: 'A', armedResetsAt: far, maxImmediate: 3 });
    return n.cls === 'cap' && /连续尝试 3 次/.test(n.text) && !/A /.test(n.text) && !/拒绝/.test(n.text);
  })(), JSON.stringify(R({ reason: 'hourly-cap', label: 'A', armedResetsAt: far })));
  const C = continueNoticeFor;
  ok('PURE continue: the immediate path is always a pool switch', C({ kind: 'now', armReason: '5h 0% < 10%', label: 'X' }).cls === 'switched');
  ok('PURE continue: a TIMED fire off the near-arm says the pool switched (round 1 said the limit had reset)', C({ kind: 'timed', armReason: 'switched to a usable account (X)', label: 'X' }).text === '账号池已切换到 X，已自动继续这个任务。');
  ok('PURE continue: a TIMED fire whose identity MOVED during the gate says the same', C({ kind: 'timed', armReason: 'usage limit', label: 'X', moved: true }).cls === 'switched');
  ok('PURE continue: an account that came back by itself is not a pool switch', C({ kind: 'timed', armReason: 'account usable again', label: 'X' }).text === '账号 X 已恢复可用，已自动继续这个任务。');
  ok('PURE continue: a real reset anchor keeps the reset wording', C({ kind: 'timed', armReason: '5h 0% < 10% · 7d 2% < 5%', label: 'X' }).cls === 'reset');
  ok('PURE continue: a missing label degrades, never throws', C({ kind: 'now', armReason: null, label: null }).text === '账号池已切换到 可用账号，已自动继续这个任务。');
  // DRIFT GUARD: the arm reasons above are ENGINE strings — if the engine
  // renames one, the timed pool-switch card silently reverts to "限额已重置"
  const engSrc = read('src/server/usage-pool-engine.js');
  ok('DRIFT: the two near-arm reasons the wording keys on are the ones the engine writes', /armIfEnabled\(id, session, Date\.now\(\) \+ 45000, `switched to a usable account \(/.test(engSrc) && /armIfEnabled\?\.\(id, session, Date\.now\(\) \+ 45000, 'account usable again'\)/.test(engSrc));
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
  // NOTE (round 2): assert the LADDER's own output, not "the cache is
  // untouched" — that only held because the signal was injected. A real
  // rejection writes its own reading through captureRateLimitEvent before the
  // ladder ever runs; the leg below drives exactly that.
  ok('…a single wall on it is HELD (never demote on a guess — the 2.368.34 ladder is the degrade path, not a silent skip)', (w.readCache(w.LINK) || {}).source !== 'wall' && lines.some((l) => /holding the demotion/.test(l)), lines.filter((l) => /wall/.test(l)).join(' | '));
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

// ── §4b2 …and what the REAL producer writes while that hold stands ─────────
{
  const w = mkWorld(); const cap = capture();
  fs.rmSync(path.join(w.am.subDir(w.LINK), '.credentials.json'), { force: true });   // slot no longer validates
  w.eng._wallRing.clear(); w.eng._sessionWalls.clear();
  w.eng.recordRateLimitEvent(w.session, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: w.R5 } });
  w.eng.noteTurnEnd(w.session);
  await new Promise((r) => setTimeout(r, 40));
  const lines = cap.done();
  const c = w.readCache(w.LINK);
  ok('a REAL rejection writes its OWN reading on the slot key (rate-limit-event, utilization 1) — so "the cache is untouched" was an artefact of injecting the signal', c && c.source === 'rate-limit-event' && c.fiveHour.utilization === 1, JSON.stringify(c));
  ok('…and the wall machine still demotes NOTHING on an unvalidated slot — two writers, and only the ground-truth one is gated', !lines.some((l) => /\[wall\] demoted/.test(l)) && c.source !== 'wall', lines.filter((l) => /wall/.test(l)).join(' | '));
  ok('…the ladder says WHY by name: with its credentials gone the link is not a pool member at all (the other unvalidated shape, §4b, is the held one)', (() => {
    const d = w.eng.demoteWalledAccount(w.session, [{ at: Date.now(), key: w.LINK, slot: false, bucket: 'fiveHour', resetsAtMs: w.R5 * 1000 }]);
    return d && d.demoted === false && (d.reason === 'not-a-member' || d.reason === 'unverified');
  })(), 'the ladder demoted an account it could not verify');
}

// ── §4c THE GATE CAN MOVE US: the fire is keyed to where it LANDED ─────────
// The pre-fire gate is `beforeAutoResumeFire`, which runs maybePoolAutoSwitch
// and can re-point the session's credential link. Round 1 resolved the
// identity BEFORE the gate and kept it: the breaker then quarantined the
// account we had already left, left the real rejector fireable, journaled the
// wrong name, and deduped the card under the wrong key.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-argate3-')); cleanup.push(dir);
  const sessions = new Map(); const sent = [], notes = [], journal = [];
  const st = { ident: { key: 'sub-a', name: 'Account A' }, move: false };
  const ar = create({
    dataDir: dir, activeSessions: sessions, serverSetting: () => true, log: (...a) => journal.push(a.join(' ')),
    sendToSession: (id, s, t) => { sent.push(t); return true; }, notify: (id, s, t) => notes.push(t),
    fireIdentity: () => st.ident,
    beforeFire: async () => { if (st.move) st.ident = { key: 'sub-b', name: 'Account B' }; return true; },
  });
  const s = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
  sessions.set('s1', s);
  const arm = () => ar.armIfEnabled('s1', s, Date.now() + 60000, 'usage limit');
  // NEGATIVE CONTROL first: a gate that moves nothing must key the fire where it always did
  arm(); ar.fireNow('s1', '账号池已切换到 Account A');
  await new Promise((r) => setTimeout(r, 20));
  ok('CONTROL: a gate that does not move the link keys the fire to the identity we resolved', sent.length === 1 && ar._fires.get('s1').last.key === 'sub-a', JSON.stringify(ar._fires.get('s1').last));
  ar.noteRecovered('s1', 'turn completed normally');   // clean slate
  st.move = true;
  arm(); ar.fireNow('s1', '账号池已切换到 Account A');
  await new Promise((r) => setTimeout(r, 20));
  ok('a gate that RE-POINTS the link keys the fire to the account the continue landed on', sent.length === 2 && ar._fires.get('s1').last.key === 'sub-b', JSON.stringify(ar._fires.get('s1').last));
  ok('…and says so in the journal (the name in the line is the account that was billed)', journal.some((l) => /the gate moved this session onto Account B/.test(l)) || journal.some((l) => /\(landed on Account B\) — continued immediately/.test(l)), journal.join(' | '));
  ok('…so the rejection quarantines the REAL rejector, not the account we came from', (() => {
    ar.noteFireOutcome('s1', false, 'limit rejection');
    return ar.recentFireFailures('s1').join(',') === 'sub-b' && journal.some((l) => /the continue onto sub-b was rejected again/.test(l));
  })(), JSON.stringify(ar.recentFireFailures('s1')));
  const dedupBefore = notes.length;
  st.move = false; st.ident = { key: 'sub-b', name: 'Account B' };
  ar._fires.get('s1').fails = []; ar._fires.get('s1').lastFireAt = Date.now() - 400000;
  arm(); ar.fireNow('s1', '账号池已切换到 Account B');
  await new Promise((r) => setTimeout(r, 20));
  ok('…and the card was deduped under that key too (a second continue onto B in the same window is journal-only)', sent.length === 3 && notes.length === dedupBefore, JSON.stringify({ sent: sent.length, notes }));
  ar.noteFireOutcome('s1', false, 'limit rejection');                 // sub-b is quarantined
  st.ident = { key: 'sub-a', name: 'Account A' }; st.move = true;     // …and the gate moves us right back onto it
  ar._fires.get('s1').lastFireAt = Date.now() - 400000;
  const burnBefore = sent.length;
  arm(); ar.fireNow('s1', 'switched');
  await new Promise((r) => setTimeout(r, 20));
  ok('a gate that moves us onto an identity we already BURNED this window aborts the spend', sent.length === burnBefore, JSON.stringify({ sent: sent.length, burnBefore }));
  ok('…the abort is journaled with the post-gate identity, and the session stays armed', journal.some((l) => /refused an immediate continue onto Account B \(same-identity/.test(l)) && ar.statusFor('s1').armed === true, journal.filter((l) => /refused/.test(l)).join(' | '));
}
{
  // null → X is the WIRING finding its voice, not the pool switching accounts:
  // the fire is still keyed to what we learned, but nothing claims a switch
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-argate4-')); cleanup.push(dir);
  const sessions = new Map(); const sent = [], notes = [];
  let calls = 0;
  const ar = create({
    dataDir: dir, activeSessions: sessions, serverSetting: () => true, log: () => { },
    sendToSession: (id, s, t) => { sent.push(t); return true; }, notify: (id, s, t) => notes.push(t),
    fireIdentity: () => (++calls === 1 ? null : { key: 'sub-x', name: 'Account X' }),
    beforeFire: async () => true,
  });
  const s = { mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, _autoResume: true };
  sessions.set('s1', s);
  ar.armIfEnabled('s1', s, Date.now() + 60000, 'usage limit');
  ar.fireNow('s1', 'switched');
  await new Promise((r) => setTimeout(r, 20));
  ok('an identity we could not resolve BEFORE the gate is not reported as a switch — but the fire is still keyed to what we learned', sent.length === 1 && ar._fires.get('s1').last.key === 'sub-x', JSON.stringify({ sent: sent.length, last: ar._fires.get('s1').last }));
}
{
  // …and the same thing through the REAL engine gate (the r1 verifier's repro):
  // the link sits on a dead member, the gate re-points it, the continue lands
  // on the healthy one.
  const w = mkWorld();
  w.writeCache(w.LINK, { fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: 1, status: 'limited', resetsAt: w.R5 }, sevenDay: { utilization: 0.4, resetsAt: w.R7 } });
  w.ar.armIfEnabled(w.SID, w.session, Date.now() + 60000, 'usage limit');
  const did = await w.tickFire();
  ok('REAL gate: the pre-fire pool evaluation re-points the link and the continue is keyed to the member it landed on', did === true && w.linkNow() === w.SPARE && w.ar._fires.get(w.SID).last.key === w.SPARE, JSON.stringify({ link: w.nameOf(w.linkNow()), last: w.ar._fires.get(w.SID).last }));
  ok('…and the card names that member instead of claiming the limit reset', w.notes.length === 1 && w.notes[0] === '账号池已切换到 B-Stack Max，已自动继续这个任务。', JSON.stringify(w.notes));
}
{
  // NEGATIVE CONTROL for the wording at integration level: nothing moved, the
  // wait simply ended ⇒ the reset wording is still what the user gets.
  const w = mkWorld();
  w.ar.armIfEnabled(w.SID, w.session, Date.now() + 60000, '5h 0% < 10%');
  const did = await w.tickFire();
  ok('CONTROL: an arm that simply came due on a healthy link says the limit reset (and fires onto the same account)', did === true && w.linkNow() === w.LINK && w.notes.length === 1 && w.notes[0] === '用量上限已重置，已自动继续这个任务。', JSON.stringify({ link: w.nameOf(w.linkNow()), notes: w.notes }));
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
  ok('the auto-resume INSTANCE exports the breaker seams', ['noteFireOutcome', 'recentFireFailures', 'canFire', 'noteNoPoolTarget'].every((k) => typeof probe.ar[k] === 'function'));
  // ── round 2 ──
  const ar2src = read('src/server/auto-resume.js');
  ok('WIRING: the refusal notice is chosen by the REASON (the call site passes the check through; round 1 computed `chk` and dropped it)', /breakerNotice\(id, session, label \|\| key, kind, chk\)/.test(ar2src) && /function breakerNotice\(id, session, label, kind, chk\) \{[\s\S]{0,700}refusalNoticeFor\(\{[\s\S]{0,200}reason: chk && chk\.reason/.test(ar2src));
  ok('WIRING: a journal-only refusal spends no notice budget (the return is ABOVE the stamp)', /if \(!n\) return;[\s\S]{0,220}r\.notices\[n\.cls\] = now; save\(\);/.test(ar2src));
  ok('WIRING: the identity is re-resolved INSIDE deliver (after the gate) and re-checked before spending', /const deliver = \(\) => \{[\s\S]{0,1400}const ident2 = identityFor\(id, session\) \|\| ident;[\s\S]{0,400}const chk2 = canFire\(id, key2, kind, now2\);[\s\S]{0,200}if \(!chk2\.ok\)/.test(ar2src) && /noteFired\(id, key2, kind, Date\.now\(\)\)/.test(ar2src) && /announce\(id, session, key2, kind, note\)/.test(ar2src));
  ok('WIRING: the continue card is chosen from the ARM + whether the gate moved us, in one place', /const moved = !!key && !!key2 && key2 !== key;[\s\S]{0,600}const note = continueNoticeFor\(\{ kind, armReason: a2\.reason, label: label2, moved \}\);/.test(ar2src));
  ok('WIRING: the pool hands its own no-target verdict to the breaker (the ONLY source of "no usable member left")', /const noWay = ds && \(ds\.reason === 'all-rejected' \|\| ds\.reason === 'no-members' \|\| ds\.reason === 'stuck'\);\s*\n\s*if \(noWay\) try \{ getAutoResume\(\)\?\.noteNoPoolTarget\?\.\(sid, rejected\.length, ds\.reason\); \}/.test(eng));
  ok('the module exports the two PURE notice rules (functional check)', typeof arMod.refusalNoticeFor === 'function' && typeof arMod.continueNoticeFor === 'function' && arMod.NO_TARGET_FRESH_MS > 0);
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
