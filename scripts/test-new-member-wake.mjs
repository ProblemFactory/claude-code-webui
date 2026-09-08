#!/usr/bin/env node
// A MEMBER BECAME USABLE AND NOBODY NOTICED (2026-09-08, from the production
// journal of this instance).
//
//   02:00:02 [notice] Pool "全部": no member can serve it — spent: 5h 0% …
//   02:18:33 [pool] per-session switch <pool>/<sid>: <old> → <new>
//                    (fam=fable, from 0%)                                  ×8
//   02:18:37 [auto-resume] <sid>: armed for 2026-09-08T10:20:00.000Z
//              (re-armed at fire: <new>: no usage data | Fish Max: 5h 0% …)
//   02:18:40 [auto-cli] quota refresh <new>: failed (drift 0pt)
//   02:22:10 [auto-resume] <opus sid>: pool switched to <new> —
//              continued automatically            ← a TURN ENDED. unrelated.
//   02:25:01 [auto-resume] <sid>: disarmed (user sent a prompt)
//   02:31:43 [auto-cli] quota refresh <new>: ok (drift 4pt)
//
// The owner added a subscription in the middle of a full-pool exhaustion. The
// pool moved eight fable conversations onto it while it had NO reading at all,
// auto-resume re-armed them for a reset EIGHT HOURS away, the auto-cli panel
// read failed (doubling its backoff — the next read was 13 minutes later), the
// owner clicked ⟳ by hand and that route wrote a reading and told the pool
// NOTHING, and the conversations were released only when he typed a prompt.
//
// THE POOL NEVER GOT TO DECIDE. It re-evaluates on turn ends and on streamed
// usage records, and a conversation that is ARMED produces neither. Two edges
// make a member's first usable reading exist — a login succeeding, and a human
// ⟳ — and neither re-drove anything.
//
// This suite drives the REAL engine + REAL AccountManager pool with real
// per-session symlinks + REAL auto-resume + the real rejection producer, and
// the real account-usage-routes factory for the login exits.
//
// THE NEGATIVE CONTROLS ARE THE POINT:
//   §1b  master reproduced — the credentials land, three ticks pass, the
//        conversation is still waiting for the far reset. Then ONE call to the
//        edge continues it.
//   §1c  each half of the wake switched off ON ITS OWN, through a real
//        production state (a pool with auto:false / an auto-resume that
//        publishes no fireNow), because a wake has two halves and the incident
//        was the second one.
//   §2   the edge refuses: no reading, a stale reading, a reading whose weekly
//        window is another member's, a member that is itself still spent.
//   §3   both floors, and the fingerprint gate on the polled routes.
//   §4   the loop breaker still holds against a member that keeps rejecting.
//   §8   (r2) the three real shapes in which the pool CANNOT move a
//        conversation onto the newcomer — a MANUAL pool, a REMOTE conversation
//        and a COLD one — where round 1 spent a turn on the member the
//        conversation was already stuck on and called it "recovered"; the
//        controls are PATCHED COPIES of the real engine, hit-count asserted.
//        (r3) §8c′ adds the fourth: a CODEX pool carrying `hot:true`, where
//        round 2's gate read the raw flag instead of the caps-gated verdict the
//        engine acts on, so the capability gate delivered the spend the
//        pool-level path had just refused.
//   §9   (r3) the panel refresher's own belt: a `claude -p /usage` that answers
//        after its account was removed writes no cache file and no window
//        sidecar — driven through the real setupUsage factory with a FAKE
//        `claude` on CLAUDE_CMD, so it costs nothing and still exercises the
//        real execFile → parse → write path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { gitEnvFrom } from './git-env.mjs';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
// §8g reads master's copy of continueNoticeFor. This suite runs inside
// `npm run build`, i.e. inside a process git itself populates (GIT_DIR /
// GIT_INDEX_FILE / GIT_PREFIX) — see scripts/git-env.mjs for the incident.
const GIT_ENV = gitEnvFrom(process.env);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const arMod = require(path.join(REPO, 'src/server/auto-resume.js'));
const { create: createAR, CONTINUE_PROMPT, GRACE_MS, FIRE_MAX_IMMEDIATE, FIRE_QUARANTINE_MS, continueNoticeFor } = arMod;
const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));
const readingLag = require(path.join(REPO, 'src/reading-lag.js'));
const { capsOf } = require(path.join(REPO, 'src/backend-caps.js')); // §8c′: hotness is a CAPABILITY verdict, not the user's checkbox

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// attemptFire returns TRUE the moment the async PRE-FIRE GATE is in flight —
// `fired` is a decision, the send lands one or more turns later (the gate runs
// maybePoolAutoSwitch and a caps-routed probe). Every assertion about
// DELIVERIES waits this out first; asserting straight after the wake measures
// the scheduler, not the product (measured: one of two sessions had landed).
const settle = () => tick(60);

/** THE INCIDENT'S WORLD. Two exhausted members, a pool that holds both, two
 *  conversations parked and ARMED for a reset eight hours out — and a THIRD
 *  member the owner is in the middle of adding, which starts with no
 *  credentials and no reading at all.
 *
 *  `auto` / `withFireNow` are the §1c controls: both are real production
 *  states, not stubs of the code under test. `auto:false` (a MANUAL pool),
 *  `hot:false` (a COLD pool) and `host` (a REMOTE conversation) are §8's — the
 *  three real shapes in which the pool structurally CANNOT move a conversation
 *  onto the member that just became usable. */
function mkWorld({ auto = true, hot = true, host = null, withFireNow = true, newLoggedIn = true, parkOn = null, engineModule = engMod } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-wake-'));
  cleanup.push(root);
  const dataDir = path.join(root, 'data');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) return null;
  const login = (id, { expiresAt = Date.now() + 36e5, refreshToken = 'r' } = {}) =>
    fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-' + id, refreshToken, expiresAt, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, subscriptionType: 'max' } }), { mode: 0o600 });

  const FISH = am.createSubscription({ name: 'Fish Max' }).id; login(FISH);
  const PANDY = am.createSubscription({ name: 'PandyMax' }).id; login(PANDY);
  // The owner's new subscription. AT 02:18:33 IT WAS LOGGED IN AND UNREAD —
  // that is the incident's state, and it is the only state in which the pool
  // would move anybody onto it (`poolMembers` filters on the roster's
  // loggedIn). `newLoggedIn:false` is the EARLIER state, where the record
  // exists and the device-auth flow has not finished: §4 measures that the
  // auto-cli loop already skipped it there.
  const NEW = am.createSubscription({ name: 'UCI Max' }).id;
  if (newLoggedIn) login(NEW);
  const P = am.createPool({ name: '全部' }).id;
  am.setPoolTarget(P, FISH);
  am.updatePool(P, { auto, hot });

  const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  const R5 = nowS + 8 * 3600;                 // the FAR reset the journal shows (10:20Z)
  const R7 = nowS + 3 * 86400;
  const cacheFile = (id) => path.join(cacheDir, id + '.json');
  const writeCache = (id, c) => fs.writeFileSync(cacheFile(id), JSON.stringify(c));
  const readCache = (id) => { try { return JSON.parse(fs.readFileSync(cacheFile(id), 'utf8')); } catch { return null; } };
  const spent = () => ({ fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: 1, status: 'limited', resetsAt: R5 }, sevenDay: { utilization: 0.38, resetsAt: R7 } });
  writeCache(FISH, spent());
  writeCache(PANDY, spent());
  // NEW has NO cache file at all — "no usage data", exactly the arm reason

  const sessions = new Map();
  const notices = [], notes = [], fired = [], wsSent = [];
  const ar = createAR({
    dataDir, activeSessions: sessions, serverSetting: () => true, log: () => { },
    notify: (id, s2, text) => notes.push({ id, text }),
    sendToSession: (id, s2, text) => { fired.push({ id, text }); return true; },
    beforeFire: (id, s2) => { try { return eng.beforeAutoResumeFire(id, s2); } catch { return true; } },
    fireIdentity: (id, s2) => { try { return eng.fireIdentityFor(s2); } catch { return null; } },
  });
  // §1c HALF ② OFF, as a real degrade: an auto-resume that publishes no
  // fireNow is what the engine sees from an older module — the edge must then
  // re-decide the pool and continue nobody.
  const arSeenByEngine = withFireNow ? ar : new Proxy(ar, { get: (t, p) => (p === 'fireNow' ? undefined : t[p]) });

  // THE READ RUNG, at the real seam. probeQuotaForKey dispatches on the
  // identity's harness and calls getQuotaProbe() for claude — i.e. exactly
  // where usage-routes' refreshViaCliPanel is wired in production. Here it
  // writes the cache the real panel would write, so no CLI is spawned and the
  // dispatcher, the key it resolves and the write are all real.
  const probes = [];
  let probeAnswer = null; // set by the test: what the panel "sees"
  const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
  // `engineModule` is §8's negative-control seam: a PATCHED COPY of the real
  // engine, wired through this same harness so the two arms differ in exactly
  // the one named replacement.
  const eng = engineModule.create({
    app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
    wss: { clients: new Set([{ readyState: 1, send: (p2) => wsSent.push(p2) }]) }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: (k, t) => notices.push(t),
    serverSetting: () => undefined, getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
    recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
    getAutoResume: () => arSeenByEngine, getOtelIngest: () => ({ observedOrgFor: () => null }),
    getQuotaProbe: () => async (key) => {
      probes.push(key);
      if (!probeAnswer) return false;
      writeCache(key, probeAnswer(key));
      return true;
    },
  });

  const mkSession = (sid, cid) => {
    const s = { backend: 'claude', mode: 'chat', host, _webuiId: sid, claudeSessionId: cid, _accountId: P, _autoResume: true, _servedModel: 'claude-fable-5', _servedModelAt: Date.now(), pty: { write() { } }, name: sid };
    sessions.set(sid, s);
    am.ensureSessionPoolLink(P, sid, parkOn || FISH);
    return s;
  };
  const A = mkSession('sess-5-1788764794647', 'cid-5');
  const B = mkSession('sess-6-1788764795107', 'cid-6');

  const w = {
    root, dataDir, am, eng, ar, sessions, A, B, P, FISH, PANDY, NEW, R5, R7,
    notices, notes, fired, wsSent, cacheDir, readCache, writeCache, spent, probes, login,
    coldRestarts: () => wsSent.filter((p2) => /"type":"pool-auto-switched"/.test(String(p2))).length,
    setProbeAnswer: (f) => { probeAnswer = f; },
    linkOf: (sid) => am.poolCurrentFor(P, sid),
    healthy: () => ({ fetchedAt: Date.now(), source: 'on-demand', fiveHour: { utilization: 0.04, resetsAt: R5 }, sevenDay: { utilization: 0.10, resetsAt: R7 } }),
    // the REAL rejection producer, exactly as test-auto-resume-loop drives it
    reject: (s) => {
      eng.recordRateLimitEvent(s, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: R5 } });
      eng.noteTurnEnd(s);
    },
    // wind the wall-clock gates back rather than sleeping through them
    unthrottle: () => {
      eng._poolAutoLast.clear(); eng._poolSwitchAt.clear();
      eng._memberWakeAt.clear(); eng._loginReadAt.clear();
    },
    ticks: async (n) => { for (let i = 0; i < n; i++) { ar.tick(Date.now()); await tick(5); } },
  };
  return w;
}

const probeWorld = mkWorld();
if (!probeWorld) {
  console.log('  · SKIP (pooled accounts are unsupported on ' + process.platform + ')');
  console.log('\nALL PASS (0)');
  process.exit(0);
}

// ── §1 THE INCIDENT ────────────────────────────────────────────────────────
console.log('\n§1 the incident: a member becomes usable while two conversations wait');
{
  /** Reproduce the state at 02:18:37: every member spent, the newcomer with NO
   *  reading, the pool having parked both conversations on it (through the
   *  REAL per-session pass), both ARMED for the reset eight hours out. */
  async function park(w) {
    // the pool's own per-session pass moves them onto the unknown newcomer —
    // UNKNOWN_REMAINING_PCT (50) beats a spent member's 0
    w.eng.maybePoolAutoSwitchForPool(w.P);
    await tick(5);
    for (const s of [w.A, w.B]) w.ar.armIfEnabled(s._webuiId, s, w.R5 * 1000, `re-armed at fire: UCI Max: no usage data | Fish Max: 5h 0% < 10%`);
    w.unthrottle();
  }

  // (a) THE SHAPE ITSELF — the conversations are parked on the newcomer, so
  //     nothing can switch and a switch-driven nudge is unreachable
  {
    const w = mkWorld();
    await park(w);
    ok('the pool parked both conversations on the member that has NO reading (UNKNOWN beats a spent 0%)',
      w.linkOf(w.A._webuiId) === w.NEW && w.linkOf(w.B._webuiId) === w.NEW,
      `${w.linkOf(w.A._webuiId)} / ${w.linkOf(w.B._webuiId)}`);
    ok('…and both are ARMED for the far reset (the journal: "armed for …T10:20:00.000Z")',
      w.ar._armed.get(w.A._webuiId)?.resetsAt === w.R5 * 1000 && w.ar._armed.get(w.B._webuiId)?.resetsAt === w.R5 * 1000);
    ok('…the newcomer has no cache file at all — "no usage data", not 0%', w.readCache(w.NEW) === null);
    // the per-session pass runs again and CANNOT help: they are already there
    const before = w.fired.length;
    w.eng.maybePoolAutoSwitchForPool(w.P);
    await tick(10);
    ok('NEGATIVE CONTROL (the incident\'s own shape): re-running the pool changes nothing and continues nobody — they are already on it, so the switch-driven nudge is structurally unreachable',
      w.fired.length === before && w.linkOf(w.A._webuiId) === w.NEW, `fired=${w.fired.length - before}`);
  }

  // (b) MASTER REPRODUCED: the credentials land, ticks pass, nothing happens.
  //     Then ONE call to the edge continues both.
  {
    const w = mkWorld();
    await park(w);
    w.login(w.NEW);                       // 02:24:42 — the device-auth login finishes
    w.setProbeAnswer(() => w.healthy());
    await w.ticks(3);
    ok('NEGATIVE CONTROL (master): credentials land and three auto-resume ticks pass — the conversations are STILL waiting for the reset eight hours away',
      w.fired.length === 0 && w.ar._armed.get(w.A._webuiId)?.resetsAt === w.R5 * 1000, `fired=${w.fired.length}`);
    ok('…and nothing has read the new member either (the auto-cli loop is in its backoff)', w.probes.length === 0 && w.readCache(w.NEW) === null);

    const r = await w.eng.onMemberLoginSuccess(w.NEW, 'login success');
    await settle();
    // Every read on this path goes through the ONE caps-routed dispatcher and
    // names this member. The FIRST is the login edge's own; the later ones are
    // the pre-fire gate re-verdicting the target before it spends, which is
    // that gate's whole job (§3 pins that the EDGE reads once per login edge).
    ok('the login edge reads the member through the EXISTING caps-routed rung (the claude cli-usage rung)',
      r.ok === true && w.probes[0] === w.NEW && w.probes.every((p) => p === w.NEW), JSON.stringify({ ok: r.ok, probes: w.probes }));
    ok('…the reading is now on disk', (w.readCache(w.NEW) || {}).fiveHour?.utilization === 0.04);
    ok('…the wake ACTED and named the pool it re-decided', r.wake.acted === true && r.wake.pools.includes(w.P), JSON.stringify(r.wake));
    ok('…and BOTH waiting conversations were continued, exactly once each',
      r.wake.fired.length === 2 && w.fired.length === 2 && new Set(w.fired.map((f) => f.id)).size === 2, JSON.stringify(w.fired.map((f) => f.id)));
    ok('…with the CLI\'s own continue prompt (a real send, not a notice)', w.fired.every((f) => f.text === CONTINUE_PROMPT));
    ok('…and they are no longer armed', !w.ar._armed.get(w.A._webuiId) || w.ar._armed.get(w.A._webuiId).fired === true);
    const card = w.notes.map((n) => n.text).join(' | ');
    ok('the card names WHAT UNBLOCKED IT — the account became usable — not a pool switch that never happened',
      /UCI Max 已恢复可用/.test(card) && !/账号池已切换到/.test(card), card.slice(0, 200));
  }

  // (c) EACH HALF IS LOAD-BEARING, FOR A DIFFERENT SHAPE
  {
    // HALF ② is the incident's own shape: the conversations are ALREADY on the
    // newcomer, so half ① re-decides and moves NOBODY. Switch half ② off (an
    // auto-resume that publishes no fireNow — a real degrade, that is what an
    // older module looks like from the engine) and the incident replays.
    const w = mkWorld({ withFireNow: false });
    await park(w);
    const linksBefore = [w.linkOf(w.A._webuiId), w.linkOf(w.B._webuiId)];
    w.setProbeAnswer(() => w.healthy());
    const r = await w.eng.onMemberLoginSuccess(w.NEW, 'login success');
    await settle();
    ok('HALF ② OFF: the pool half still runs and the reading still lands…',
      r.wake.acted === true && r.wake.pools.includes(w.P) && (w.readCache(w.NEW) || {}).fiveHour?.utilization === 0.04);
    ok('…the pool re-decide moves NOBODY (they were already parked on the newcomer — the incident\'s own shape)',
      w.linkOf(w.A._webuiId) === linksBefore[0] && w.linkOf(w.B._webuiId) === linksBefore[1] && linksBefore[0] === w.NEW);
    ok('…so nobody is continued, and the wake SAYS why rather than claiming success',
      w.fired.length === 0 && r.wake.fired.length === 0 && r.wake.reason === 'no-auto-resume', JSON.stringify(r.wake));

    // HALF ① is load-bearing for the shape where NOBODY IS ARMED: two live
    // conversations sit on a spent member and have not hit the wall yet, so
    // nothing fires — and the pre-fire gate, which re-decides the pool itself,
    // never runs. Only half ① can move them.
    //
    // (This leg is mutation-driven. Its first spelling armed the conversations,
    // and then half ② did half ①'s work as a side effect of the spending gate
    // — removing half ① changed nothing and the assertion was decorative.)
    const w2 = mkWorld();
    ok('control setup: both conversations are LIVE on a SPENT member and nobody is armed',
      w2.linkOf(w2.A._webuiId) === w2.FISH && w2.ar.armedIds().length === 0);
    // …and the pool was evaluated seconds ago, so its 10s event-kick gate is
    // SHUT. A member's first reading is not a kick; without `force` the wake
    // would be swallowed by a throttle meant for per-record chatter.
    w2.eng._poolAutoLast.set(w2.P, Date.now());
    w2.writeCache(w2.NEW, w2.healthy());
    const r2 = w2.eng.onMemberReadingFresh(w2.NEW, 'manual refresh');
    await settle();
    ok('HALF ①: the pool re-decide moves both conversations off the spent member onto the newcomer — through a shut event-kick gate, and with no fire to do it for us',
      w2.linkOf(w2.A._webuiId) === w2.NEW && w2.linkOf(w2.B._webuiId) === w2.NEW, JSON.stringify(r2));
    ok('…and nothing was spent doing it: nobody was armed, so no continue was delivered',
      w2.fired.length === 0, `fired=${w2.fired.length}`);
  }

  // (d) THE HUMAN ⟳ TAKES THE SAME EDGE (defect B), with no login involved
  {
    const w = mkWorld();
    await park(w);
    w.login(w.NEW);
    w.writeCache(w.NEW, w.healthy());   // what /api/usage/refresh's rung just wrote
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('a manual refresh that reveals a usable member re-drives the pool and continues both waiting conversations',
      r.acted === true && r.fired.length === 2 && w.fired.length === 2, JSON.stringify({ r, fired: w.fired.length }));
    // …and the edge itself reads NOTHING. Measured where the pre-fire gate
    // cannot run at all (nobody armed), because the gate's own probe is
    // synchronous inside attemptFire and would otherwise be counted as ours.
    const w2 = mkWorld();
    w2.writeCache(w2.NEW, w2.healthy());
    const r2 = w2.eng.onMemberReadingFresh(w2.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('…and the edge itself spawns NOTHING: the reading was already there, it only looks again',
      r2.acted === true && w2.probes.length === 0, JSON.stringify({ r2, probes: w2.probes }));
  }
}

// ── §2 THE EDGE REFUSES ────────────────────────────────────────────────────
console.log('\n§2 "no reading" is a refusal to act, never a verdict of 0%');
{
  const base = async () => {
    const w = mkWorld();
    w.eng.maybePoolAutoSwitchForPool(w.P); await tick(5);
    for (const s of [w.A, w.B]) w.ar.armIfEnabled(s._webuiId, s, w.R5 * 1000, 'usage limit');
    w.unthrottle();
    return w;
  };
  {
    const w = await base();
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh');
    ok('NO reading ⇒ refuse, named', r.acted === false && r.reason === 'no-reading' && w.fired.length === 0, JSON.stringify(r));
  }
  {
    const w = await base();
    w.writeCache(w.NEW, { ...w.healthy(), fetchedAt: Date.now() - 30 * 60e3 });
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh');
    ok('a STALE reading (30 min old) ⇒ refuse: a wake acts on a reading taken now, never on an old file',
      r.acted === false && r.reason === 'stale-reading' && w.fired.length === 0, JSON.stringify(r));
  }
  {
    const w = await base();
    w.writeCache(w.NEW, { ...w.spent(), fetchedAt: Date.now() }); // fresh, and still spent
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh');
    ok('NEGATIVE CONTROL: a fresh reading of a member that is still SPENT re-decides the pool but continues nobody',
      r.acted === true && r.reason === 'member-not-usable' && r.fired.length === 0 && w.fired.length === 0, JSON.stringify(r));
  }
  // FOREIGN NUMBERS: compose with the landed window-fingerprint work
  // (inc-mts8a8mr-ulmm) — a reading whose weekly window belongs to ANOTHER
  // member was produced on that member's credentials, not this one's.
  {
    const w = await base();
    const foreignWeekly = w.R7 + 3 * 86400;  // a different weekly PHASE
    const sidecar = (id, weekly) => fs.writeFileSync(path.join(w.cacheDir, readingLag.windowSidecarName(id)), JSON.stringify({ sevenDay: weekly, fiveHour: w.R5, scoped: {}, at: Date.now(), source: 'on-demand' }));
    sidecar(w.NEW, w.R7);                    // the newcomer's OWN established window
    sidecar(w.PANDY, foreignWeekly);         // and somebody else's
    w.writeCache(w.NEW, { ...w.healthy(), sevenDay: { utilization: 0.1, resetsAt: foreignWeekly } });
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh');
    ok('a FOREIGN reading (its weekly window is another member\'s) ⇒ refuse, and say whose',
      r.acted === false && r.reason === 'foreign-reading' && /PandyMax/.test(String(r.detail)), JSON.stringify(r));
    ok('…and the edge composes with the ONE predicate rather than copying it (src/reading-lag.js decideReadingTarget, rule ②)',
      /decideReadingTarget/.test(read('src/server/usage-pool-engine.js').split('function readingForeignForWake')[1].slice(0, 600)));
    ok('…READ-ONLY: refusing to wake never archives or moves the reading (guardReadingTarget is the write path, this is not)',
      JSON.parse(fs.readFileSync(path.join(w.cacheDir, w.NEW + '.json'), 'utf8')).sevenDay.resetsAt === foreignWeekly);
    // …and the incident's own case still acts: a brand-new member has no
    // established window of its own, so there is nothing to contradict.
    const w2 = await base();
    fs.writeFileSync(path.join(w2.cacheDir, readingLag.windowSidecarName(w2.PANDY)), JSON.stringify({ sevenDay: w2.R7, fiveHour: w2.R5, scoped: {}, at: Date.now() }));
    w2.writeCache(w2.NEW, w2.healthy());
    const r2 = w2.eng.onMemberReadingFresh(w2.NEW, 'manual refresh');
    ok('…but a member with NO established window of its own has nothing to contradict — that is the incident\'s own case and it must still act',
      r2.acted === true && r2.fired.length === 2, JSON.stringify(r2));
  }
}

// ── §3 THE FLOORS ──────────────────────────────────────────────────────────
console.log('\n§3 idempotent, rate-floored, and never an unbounded side effect on a polled route');
{
  {
    const w = mkWorld();
    w.eng.maybePoolAutoSwitchForPool(w.P); await tick(5);
    for (const s of [w.A, w.B]) w.ar.armIfEnabled(s._webuiId, s, w.R5 * 1000, 'usage limit');
    w.unthrottle();
    w.writeCache(w.NEW, w.healthy());
    const now = Date.now();
    const r1 = w.eng.onMemberReadingFresh(w.NEW, 'refresh 1', { at: now });
    const r2 = w.eng.onMemberReadingFresh(w.NEW, 'refresh 2', { at: now + 100 });
    await settle();
    ok('two refreshes 100 ms apart are ONE wake', r1.acted === true && r2.acted === false && r2.reason === 'wake-floor');
    ok('…and only one round of continues was delivered', w.fired.length === 2, `fired=${w.fired.length}`);
    ok('…the floor is stamped only when the wake ACTED (a declined wake must not eat the real one)',
      /THE FLOOR IS STAMPED ONLY WHEN WE ACT/.test(read('src/server/usage-pool-engine.js')));
  }
  {
    const w = mkWorld();
    w.login(w.NEW); w.setProbeAnswer(() => w.healthy());
    await w.eng.onMemberLoginSuccess(w.NEW, 'login success');
    const n1 = w.probes.length;
    await w.eng.onMemberLoginSuccess(w.NEW, 'login success');
    ok('the login edge reads ONCE per login edge — a second call inside the floor spawns nothing',
      n1 === 1 && w.probes.length === 1, `probes=${w.probes.length}`);
  }
  {
    // ONE ATTEMPT CLOCK: the auto-cli loop must see the login edge's read as
    // one of its own attempts, or it spawns a second panel seconds later.
    const w = mkWorld();
    w.login(w.NEW); w.setProbeAnswer(() => w.healthy());
    const t0 = Date.now();
    await w.eng.onMemberLoginSuccess(w.NEW, 'login success');
    ok('…and the loop can see it: lastMemberReadAt names the instant of that read', w.eng.lastMemberReadAt(w.NEW) >= t0);
    ok('…which server.js folds into the loop\'s own lastAttemptAt', /Math\.max\(attempts\.get\(a\.id\) \|\| 0, lastMemberReadAt\(a\.id\)\)/.test(read('server.js')));
  }
}

// ── §4 NOT READY IS NOT FAILED ─────────────────────────────────────────────
console.log('\n§4 not ready is not failed (the auto-cli readiness gate)');
{
  const w = mkWorld({ newLoggedIn: false });
  const claudeHarness = require(path.join(REPO, 'src/harnesses/claude.js'));
  ok('a member with NO credentials is not ready', w.eng.autoCliReady(w.NEW) === false);
  ok('…and the roster already agreed about THAT half (parseAuth: no file ⇒ loggedIn false) — measured, so the guard does not claim credit for it',
    claudeHarness.creds.parseAuth(w.am.subDir(w.NEW)).loggedIn === false);
  // the reachable hole: access AND refresh both expired. parseAuth says
  // loggedIn:true (an accessToken STRING exists), so the pre-fix loop spawned a
  // panel that could not possibly answer and doubled its backoff forever.
  fs.writeFileSync(path.join(w.am.subDir(w.NEW), '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'stale', refreshToken: '', expiresAt: Date.now() - 86400e3, refreshTokenExpiresAt: Date.now() - 3600e3, subscriptionType: 'max' },
  }), { mode: 0o600 });
  ok('THE SATISFIABLE GAP: a doubly-expired credential file still reads loggedIn:true to parseAuth…',
    claudeHarness.creds.parseAuth(w.am.subDir(w.NEW)).loggedIn === true);
  ok('…and autoCliReady says NO, through the same credential-FILE reader the pool\'s slot validation uses',
    w.eng.autoCliReady(w.NEW) === false);
  w.login(w.NEW);
  ok('a live login is ready', w.eng.autoCliReady(w.NEW) === true);
  ok('an id that is not a claude subscription never blocks (null = no claim)', w.eng.autoCliReady('__global__') === true && w.eng.autoCliReady(w.P) === true);
  ok('the loop asks it before it spends a spawn (wiring pin)', /\|\| !autoCliReady\(a\.id\)\) continue;/.test(read('server.js')));
  ok('…and the FILE reader is the right one because the rung strips the long-lived token from the child env',
    /delete env\.CLAUDE_CODE_OAUTH_TOKEN;/.test(read('src/usage-routes.js')));
}

// ── §5 THE LOOP BREAKER IS UNTOUCHED ───────────────────────────────────────
console.log('\n§5 the wake never spends by itself');
{
  const w = mkWorld();
  w.eng.maybePoolAutoSwitchForPool(w.P); await tick(5);
  w.unthrottle();
  w.writeCache(w.NEW, w.healthy());
  // the newcomer rejects this conversation: the 2026-09-07 quarantine
  w.ar.armIfEnabled(w.A._webuiId, w.A, w.R5 * 1000, 'usage limit');
  const r1 = w.eng.onMemberReadingFresh(w.NEW, 'refresh 1');
  await settle();
  ok('the first wake continues the conversation', r1.fired.length === 1 && w.fired.length === 1);
  w.reject(w.A);                                     // the CLI answers with a limit
  w.ar.armIfEnabled(w.A._webuiId, w.A, w.R5 * 1000, 'usage limit');
  w.eng._memberWakeAt.clear();
  w.writeCache(w.NEW, w.healthy());                  // a reading keeps arriving
  const r2 = w.eng.onMemberReadingFresh(w.NEW, 'refresh 2');
  await settle();
  ok('SAME-IDENTITY QUARANTINE HOLDS: a member that just rejected this conversation is not fired at again, however many fresh readings arrive',
    r2.fired.length === 0 && w.fired.length === 1, JSON.stringify({ r2: r2.fired, fired: w.fired.length }));
  const chk = w.ar.canFire(w.A._webuiId, w.NEW, 'now', Date.now());
  ok('…and the breaker names the reason', chk.ok === false && chk.reason === 'same-identity', JSON.stringify(chk));

  // the hourly cap: a DIFFERENT identity each time, so only the cap can stop it
  const w2 = mkWorld();
  w2.eng.maybePoolAutoSwitchForPool(w2.P); await tick(5);
  w2.unthrottle();
  w2.writeCache(w2.NEW, w2.healthy());
  for (let i = 0; i < FIRE_MAX_IMMEDIATE + 3; i++) {
    w2.ar.armIfEnabled(w2.A._webuiId, w2.A, w2.R5 * 1000, 'usage limit');
    w2.eng._memberWakeAt.clear();
    // WIND THE CLOCK, DO NOT CLEAR THE RECORD. `noteFireOutcome(id,true)` is a
    // DELETE — it resets the 3/hour counter this leg exists to measure (the
    // 2026-09-07 r4 lesson). Only the two TIME gates are wound back, so `n`
    // and `windowStart` — the cap itself — are untouched.
    const rec = w2.ar._fires.get(w2.A._webuiId);
    if (rec) { rec.last = null; rec.lastFireAt = 0; }
    w2.eng.onMemberReadingFresh(w2.NEW, 'refresh ' + i);
    await settle();
  }
  ok(`HOURLY CAP HOLDS: repeated wakes cannot exceed the ${FIRE_MAX_IMMEDIATE}/hour immediate budget (delivered ${w2.fired.length})`,
    w2.fired.length > 0 && w2.fired.length <= FIRE_MAX_IMMEDIATE, `delivered=${w2.fired.length}`);
  ok('…and every release went through attemptFire, not around it (wiring pin)',
    /return attemptFire\(id, session, a, 'now', why, cause\);/.test(read('src/server/auto-resume.js')));
}

// ── §6 THE PRODUCERS ───────────────────────────────────────────────────────
console.log('\n§6 every producer of a fresh reading takes the SAME edge');
{
  const usageSrc = read('src/usage-routes.js');
  for (const rung of ['manual refresh (session)', 'manual refresh (cli-panel)', 'manual refresh (token)']) {
    ok(`/api/usage/refresh takes the edge on the ${rung.replace(/manual refresh \(|\)/g, '')} rung`, usageSrc.includes(`wakePool(key, '${rung}')`));
  }
  ok('…and the HOST branch takes none of them (a remote machine\'s pool is not ours to decide for)',
    /LOCAL ONLY, DELIBERATELY/.test(usageSrc));
  ok('…the edge reaches the routes as an injected dep, not a require (tier: usage-routes stays ORCH wiring)',
    /probeUsageForAccountKey, onMemberReadingFresh, CLAUDE_CMD \}\) \{/.test(usageSrc) && /onMemberReadingFresh, CLAUDE_CMD \}\);/.test(read('server.js')));

  const srv = read('server.js');
  ok('the auto-cli loop — the THIRD producer, whose successful read at 02:31:43 changed nothing — takes the same edge, and only on success',
    /const ok = await usage\.refreshViaCliPanel\(key\)[\s\S]{0,200}?if \(ok\) onMemberReadingFresh\(key, 'auto-cli refresh'\);/.test(srv));
  ok('…and the edge is NOT buried inside refreshViaCliPanel, where the pre-fire spend gate also calls it (a gate that fires conversations as a side effect of asking a question is not a gate)',
    !/onMemberReadingFresh/.test(read('src/usage-routes.js').split('async function refreshViaCliPanel')[1].split('\n}\n')[0]));

  // THE FIVE LOGIN EXITS, through the REAL route factory.
  const routes = require(path.join(REPO, 'src/server/account-usage-routes.js'));
  const routesSrc0 = read('src/server/account-usage-routes.js');
  const routeMutants = [];
  process.on('exit', () => { for (const f of routeMutants) { try { fs.unlinkSync(f); } catch { } } });
  let mutR = 0;
  /** A patched copy of the ROUTES module, as a SIBLING of the real one so its
   *  relative requires resolve — same shape as §8's mutantEngine, same name
   *  prefix so its stale-PID sweep collects these too, and gitignored. Every
   *  replacement is counted and the count is asserted by the caller: an
   *  unpatched "control" is not a control. */
  function mutantRoutes(edits) {
    let src = routesSrc0, hits = 0;
    for (const [from, to] of edits) {
      if (!src.includes(from)) return { err: 'needle missing: ' + from.slice(0, 70) };
      src = src.split(from).join(to); hits++;
    }
    const f = path.join(REPO, 'src/server/vs-wake-mut-' + process.pid + '-r' + (++mutR) + '.js');
    fs.writeFileSync(f, src); routeMutants.push(f);
    return { mod: require(f), hits };
  }
  function mkRoutes(opts = {}) {
    const w = mkWorld(opts);
    const routesModule = opts.routesModule || routes;
    const handlers = new Map();
    const app = {
      get: (p, h) => handlers.set('GET ' + p, h), post: (p, h) => handlers.set('POST ' + p, h),
      put: (p, h) => handlers.set('PUT ' + p, h), delete: (p, h) => handlers.set('DELETE ' + p, h),
      patch: (p, h) => handlers.set('PATCH ' + p, h), use: () => { }, locals: {},
    };
    const swept = [];
    routesModule.create({
      app, rootDir: w.root, HOST: '127.0.0.1', CLAUDE_CMD: 'claude', NODE_CMD: 'node',
      CLAUDE_SUBSCRIPTION_LOGIN_HELPER: '/dev/null', activeSessions: w.sessions,
      auth: { enabled: false }, engine: w.eng, serverSetting: () => undefined,
      // `liveIds` is EXIT 4b's control: a running session on either side makes
      // `mergeSubscription` refuse with code 'merge-account-live', which is the
      // reachable exit where the fold does NOT happen and the fresh record is
      // still the one holding the login.
      recordUsageAttribution() { }, liveAccountIdSet: () => new Set(opts.liveIds || []),
      buildClaudeSubscriptionLoginCommand: () => 'true',
      getAccounts: () => w.am, getHosts: () => null, getMounts: () => null,
      getTelemetry: () => ({ ingestRemote: () => 0, centralSummary: () => ({}) }),
      getUsageHistory: () => null,
      getLoginExpiryWatch: () => ({ sweep: () => { swept.push(1); return { resolved: [] }; } }),
    });
    const call = async (key, params, body = {}) => {
      const h = handlers.get(key);
      if (!h) throw new Error('no handler for ' + key);
      let out = null;
      const res = { json: (o) => { out = o; return res; }, status: () => res };
      await h({ params, body, headers: {} }, res);
      // the wake is fire-and-forget BY DESIGN (a login must never wait on a
      // quota read) — awaiting the parked promise is what makes the negative
      // controls below non-vacuous
      await app.locals._lastLoginWake;
      await tick(5);
      return out;
    };
    return { w, app, call, swept, handlers };
  }

  ok('the routes module registers all three finalize routes', (() => {
    const { handlers } = mkRoutes();
    return ['POST /api/accounts/:id/relogin-finalize', 'POST /api/accounts/subscription/:id/finalize', 'POST /api/accounts/codex-subscription/:id/finalize'].every((k) => handlers.has(k));
  })());

  // exit 1: relogin-finalize 'same' — the ordinary in-place re-login
  {
    const { w, call } = mkRoutes();
    w.login(w.NEW); w.setProbeAnswer(() => w.healthy());
    await call('POST /api/accounts/:id/relogin-finalize', { id: w.NEW });
    ok('EXIT 1 relogin-finalize (in-place re-login) reads the member exactly once', w.probes.length === 1 && w.probes[0] === w.NEW, JSON.stringify(w.probes));
    // …and it is polled ~100×: the fingerprint gate is what keeps it bounded
    for (let i = 0; i < 25; i++) {
      // Wind the ENGINE's own 5-minute read floor back before each poll, so the
      // only thing that can still hold the line is the ROUTE's fingerprint
      // gate. Two belts get two controls, or the second one is decorative
      // (mutation-driven: deleting the fingerprint gate used to change nothing).
      w.eng._loginReadAt.clear();
      await call('POST /api/accounts/:id/relogin-finalize', { id: w.NEW });
    }
    ok('NEGATIVE CONTROL: 25 further polls of the same answer spawn NOTHING even with the engine floor wound back — the route gates on the answer\'s own credential fingerprint (a polled route may not carry an unbounded side effect)',
      w.probes.length === 1, `probes=${w.probes.length}`);
  }
  // exit 2: relogin-finalize 'pending' — nothing on disk yet, stay silent
  {
    const { w, call } = mkRoutes({ newLoggedIn: false });
    w.setProbeAnswer(() => w.healthy());   // (never reached)
    const r = await call('POST /api/accounts/:id/relogin-finalize', { id: w.NEW });
    ok('EXIT 2 NEGATIVE CONTROL: a finalize that captured nothing ("pending") reads nothing',
      r?.outcome === 'pending' && w.probes.length === 0, JSON.stringify({ r, probes: w.probes }));
  }
  // exit 3: Add-subscription finalize
  {
    const { w, call } = mkRoutes();
    w.login(w.NEW); w.setProbeAnswer(() => w.healthy());
    await call('POST /api/accounts/subscription/:id/finalize', { id: w.NEW });
    ok('EXIT 3 subscription finalize (the Add flow, the incident\'s own path) reads the member once', w.probes.length === 1 && w.probes[0] === w.NEW, JSON.stringify(w.probes));
    for (let i = 0; i < 25; i++) { w.eng._loginReadAt.clear(); await call('POST /api/accounts/subscription/:id/finalize', { id: w.NEW }); }
    ok('…and the Add flow is polled every 3 s for 5 minutes too: still one read (engine floor wound back, so this is the fingerprint gate alone)',
      w.probes.length === 1, `probes=${w.probes.length}`);
  }
  // exit 4: the auto-merge exit wakes the SURVIVOR, not the throwaway
  //
  // r3: this leg used to reach for an email SETTER this AccountManager does not
  // have and then SKIP, so the whole auto-merge exit went unmeasured — and what
  // it was not measuring is that the route woke `req.params.id` UNCONDITIONALLY
  // first, i.e. spawned a `claude -p /usage` panel for the record it was about
  // to DELETE. The route's dup lookup reads `x.email || (a name containing @)`,
  // so `rename` is all this needs; MEASURED before the fix: 2 panel spawns, one
  // of them for the throwaway, and `usage-cache/<deleted-id>.json` left behind
  // (nothing removes cache entries when an account goes away, and
  // establishedWindows() reads that directory with no roster filter).
  {
    const { w, call } = mkRoutes();
    // the survivor is an EXISTING record the pool holds, identified by the same
    // email; the throwaway is the fresh one the Add flow just logged into
    w.am.rename(w.PANDY, 'owner@example.com');
    fs.writeFileSync(path.join(w.am.subDir(w.NEW), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-new', refreshToken: 'r', expiresAt: Date.now() + 36e5, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, email: 'owner@example.com', subscriptionType: 'max' } }), { mode: 0o600 });
    w.setProbeAnswer(() => w.healthy());
    const r = await call('POST /api/accounts/subscription/:id/finalize', { id: w.NEW });
    ok('control setup: the Add flow really took the auto-merge exit (this leg is worthless if it did not)',
      r?.merged === true && !w.am.get(w.NEW), JSON.stringify({ merged: r?.merged, throwawayGone: !w.am.get(w.NEW) }));
    ok('EXIT 4 the auto-merge exit wakes the SURVIVOR — waking the throwaway would read a record about to stop existing and leave the one the pool holds unread',
      w.probes.includes(w.PANDY), JSON.stringify(w.probes));
    ok('…and it wakes NOBODY ELSE: the throwaway is never probed, so no panel is spawned for a record that is about to be deleted',
      !w.probes.includes(w.NEW) && w.probes.length === 1, JSON.stringify(w.probes));
    ok('…and no usage-cache entry is left keyed to the deleted record (nothing ever removes those, and establishedWindows() reads them all)',
      w.readCache(w.NEW) === null, JSON.stringify(w.readCache(w.NEW)));
    ok('…and the survivor is named at the call site, not inferred', /wakeOnLoginSuccess\(dup\.id, merged, 'subscription login merge', merged\?\.id \|\| dup\.id\)/.test(read('src/server/account-usage-routes.js')));
    // NEGATIVE CONTROL: the PRE-FIX route — the wake ungated, above the merge
    const mutR = mutantRoutes([
      ["    if (fin?.loggedIn && !dupOf) wakeOnLoginSuccess(req.params.id, fin, 'subscription login');",
        "    if (fin?.loggedIn) wakeOnLoginSuccess(req.params.id, fin, 'subscription login'); // PRE-FIX: ungated"],
      ["        if (fin?.loggedIn) wakeOnLoginSuccess(req.params.id, fin, 'subscription login');\n        if (me.code !== 'merge-account-live') throw me;",
        "        if (me.code !== 'merge-account-live') throw me; // PRE-FIX: no catch-side wake"],
    ]);
    ok('control setup: the PRE-FIX routes copy applied both replacements', mutR.hits === 2, JSON.stringify(mutR));
    const { w: w2, call: call2 } = mkRoutes({ routesModule: mutR.mod });
    w2.am.rename(w2.PANDY, 'owner@example.com');
    fs.writeFileSync(path.join(w2.am.subDir(w2.NEW), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-new', refreshToken: 'r', expiresAt: Date.now() + 36e5, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, email: 'owner@example.com', subscriptionType: 'max' } }), { mode: 0o600 });
    w2.setProbeAnswer(() => w2.healthy());
    const r2 = await call2('POST /api/accounts/subscription/:id/finalize', { id: w2.NEW });
    ok('NEGATIVE CONTROL (pre-fix): the same exit spawns TWO panels — one of them for the record it then deletes — and leaves a usage-cache entry keyed to a phantom',
      r2?.merged === true && !w2.am.get(w2.NEW) && w2.probes.length === 2 && w2.probes.includes(w2.NEW) && w2.readCache(w2.NEW) !== null,
      JSON.stringify({ probes: w2.probes, phantomCache: !!w2.readCache(w2.NEW) }));
  }
  // exit 4b: the fold did NOT happen, so this record still holds the login
  //
  // Gating the pre-merge wake on `dup` would otherwise DROP the edge on every
  // exit where the merge is refused — and 'merge-account-live' is a documented,
  // user-reachable one (a session using either account is running). The wake
  // therefore moves into the catch, above BOTH the rethrow and the blocked
  // answer, so the login edge is still taken exactly once, on whichever record
  // ends up holding the login.
  {
    const live = [];                       // filled once the world names its ids
    const { w, call } = mkRoutes({ liveIds: live });
    live.push(w.PANDY);                    // a running session on the SURVIVOR
    w.am.rename(w.PANDY, 'owner@example.com');
    fs.writeFileSync(path.join(w.am.subDir(w.NEW), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-new', refreshToken: 'r', expiresAt: Date.now() + 36e5, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, email: 'owner@example.com', subscriptionType: 'max' } }), { mode: 0o600 });
    w.setProbeAnswer(() => w.healthy());
    const r = await call('POST /api/accounts/subscription/:id/finalize', { id: w.NEW });
    ok('control setup: a running session really blocked the auto-fold (both records survive)',
      r?.merged === false && !!r?.mergeBlocked && !!w.am.get(w.NEW) && !!w.am.get(w.PANDY),
      JSON.stringify({ merged: r?.merged, blocked: !!r?.mergeBlocked, newAlive: !!w.am.get(w.NEW) }));
    ok('EXIT 4b the blocked-merge exit still takes the edge, on the record that KEPT the login — a deferred wake must not become a dropped one',
      w.probes.length === 1 && w.probes[0] === w.NEW, JSON.stringify(w.probes));
  }
  // exit 5: codex device-auth
  {
    const src = read('src/server/account-usage-routes.js');
    ok('EXIT 5 codex device-auth finalize takes the edge', /if \(fin\?\.loggedIn\) wakeOnLoginSuccess\(req\.params\.id, fin, 'codex device-auth'\);/.test(src));
    ok('…and \'moved\' wakes the record the login was RELOCATED INTO', /r\?\.movedTo\?\.id \|\| r\?\.account\?\.id \|\| req\.params\.id/.test(src));
    ok('…the gate is the EXISTING transition predicate (loginFingerprint off the answer the route already holds), never a second credential reader',
      /const fp = loginFingerprint\(r\);/.test(src.split('const wakeOnLoginSuccess')[1].slice(0, 800)));
    ok('…on its OWN latch, so disabling one of the two side effects cannot silently disable the other',
      /const lastWakeFingerprint = new Map\(\)/.test(src));
  }
}

// ── §8 THE CONTINUE MUST LAND ON THE MEMBER THAT BECAME USABLE ─────────────
// r2 (adversarial verifier). Half ② used to filter on POOL MEMBERSHIP and fire
// anyway, so in every shape where the pool structurally CANNOT move a
// conversation onto the newcomer the continue was billed to the member that
// conversation was already stuck on — and the card called THAT member
// "recovered". The pre-fire gate cannot catch it: `quotaVerdictFor` answers a
// POOLED scope with "any member usable", which is true and beside the point.
//
// The three shapes are real production states, and they are mkWorld's own
// controls (declared since round 1, never driven — which is exactly why they
// went unmeasured):
//   auto:false   a MANUAL pool — maybePoolAutoSwitchForPool returns at the top
//   host:'…'     a REMOTE conversation — the per-session pass skips it BY DESIGN
//   hot:false    a COLD pool — it RESTARTS the conversation through the client
//
// THE NEGATIVE CONTROLS ARE PATCHED COPIES OF THE PRODUCT MODULE (each
// replacement asserted to have HIT), because "0 continues delivered" is also
// what a leg that never ran prints.
console.log('\n§8 half ② fires only the conversations nothing could move (r2)');
{
  const engPath = path.join(REPO, 'src/server/usage-pool-engine.js');
  const engSrc0 = read('src/server/usage-pool-engine.js');
  const mutants = [];
  process.on('exit', () => { for (const f of mutants) { try { fs.unlinkSync(f); } catch { } } });
  // A run killed with SIGKILL leaves its copies behind. Sweep them, but only
  // the ones whose PID is GONE — this suite can legitimately be running twice
  // in one worktree, and deleting a LIVE run's module mid-require is worse than
  // the litter. (Same shape as the wire probe's stale sweep: the cleaner states
  // its own rule instead of assuming it is alone.)
  // Both directories hold copies: §6/§8 write engine + routes mutants into
  // src/server/, §9 writes a usage-routes mutant into src/ (a patched copy must
  // be a SIBLING of the real module or its relative requires do not resolve).
  for (const dir of ['src/server', 'src']) {
    try {
      for (const f of fs.readdirSync(path.join(REPO, dir))) {
        const m = /^vs-wake-(?:mut|master-ar)-(\d+)[-.]/.exec(f);
        if (!m || Number(m[1]) === process.pid) continue;
        try { process.kill(Number(m[1]), 0); continue; } catch (e) { if (e.code === 'EPERM') continue; }
        try { fs.unlinkSync(path.join(REPO, dir, f)); } catch { }
      }
    } catch { }
  }
  let mutN = 0;
  /** A patched copy of the engine, as a SIBLING of the real one so its relative
   *  requires resolve. Every replacement is counted, and the count is asserted
   *  by the caller — an unpatched "control" is not a control. */
  function mutantEngine(edits) {
    let src = engSrc0, hits = 0;
    for (const [from, to] of edits) {
      if (!src.includes(from)) return { err: 'needle missing: ' + from.slice(0, 70) };
      src = src.split(from).join(to); hits++;
    }
    const f = path.join(REPO, 'src/server/vs-wake-mut-' + process.pid + '-' + (++mutN) + '.js');
    fs.writeFileSync(f, src); mutants.push(f);
    return { mod: require(f), hits };
  }

  /** The world, ARMED through the REAL rejection producer, with the newcomer
   *  becoming usable. `engineModule` lets a leg drive a patched copy of the
   *  product through the SAME wiring. */
  async function walled(opts, engineModule = engMod) {
    const w = mkWorld({ ...opts, engineModule });
    w.reject(w.A);                       // the real producer: rate_limit_event + turn end
    await tick(20);
    w.unthrottle();
    w.writeCache(w.NEW, w.healthy());    // ⟳ / login: the newcomer can serve now
    return w;
  }
  const cardsOf = (w) => w.notes.map((n) => n.text).join(' | ');

  // (a) MANUAL pool — the link never moves, so a continue would bill the SPENT member
  {
    const w = await walled({ auto: false });
    const linkBefore = w.linkOf(w.A._webuiId);
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('MANUAL pool (auto:false): the wake continues NOBODY — half ① cannot move the link, so a continue would land on the spent member',
      r.acted === true && r.fired.length === 0 && w.fired.length === 0, JSON.stringify(r));
    ok('…and it SAYS which conversation it left alone and where a continue would have landed',
      r.skipped.length === 1 && r.skipped[0].id === w.A._webuiId && r.skipped[0].landsOn === linkBefore && r.skipped[0].why === 'lands-elsewhere', JSON.stringify(r.skipped));
    ok('…and no card claims a member recovered', !/已恢复可用/.test(cardsOf(w)), cardsOf(w));

    // NEGATIVE CONTROL: the pre-fix spelling (membership only), on a patched copy
    const mut = mutantEngine([
      ["      const before = landedBefore.has(id) ? landedBefore.get(id) : null;",
        "      const before = memberId; // PRE-FIX: membership was the only filter"],
      ["      let landsOn = null;\n      try { landsOn = fireIdentityFor(s)?.key || null; } catch { }",
        "      let landsOn = memberId; // PRE-FIX"],
      ["      const cold = !!(pa && pa.type === 'pooled' && !(pa.hot && capsOf(pa.backend).hotSwitch === 'verified'));",
        "      const cold = false; // PRE-FIX"],
    ]);
    ok('control setup: the PRE-FIX copy applied all three replacements', mut.hits === 3, JSON.stringify(mut));
    const w2 = await walled({ auto: false }, mut.mod);
    const r2 = w2.eng.onMemberReadingFresh(w2.NEW, 'manual refresh (cli-panel)');
    await settle();
    const spentCache = w2.readCache(w2.linkOf(w2.A._webuiId));
    ok('NEGATIVE CONTROL (pre-fix): the same world DOES spend a turn — on a member measured at 100% utilization — and the card names that member as recovered',
      r2.fired.length === 1 && w2.fired.length === 1 && spentCache?.fiveHour?.utilization === 1 && /Fish Max 已恢复可用/.test(cardsOf(w2)),
      JSON.stringify({ fired: w2.fired.length, util: spentCache?.fiveHour?.utilization, cards: cardsOf(w2) }));
  }

  // (b) REMOTE conversation — the per-session pass skips `s.host` BY DESIGN
  {
    const w = await walled({ host: 'aidev' });
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('REMOTE conversation (s.host): same verdict — the per-session pass skips it by design, so the wake must not fire it either',
      r.acted === true && r.fired.length === 0 && w.fired.length === 0 && r.skipped[0]?.why === 'lands-elsewhere', JSON.stringify(r));
    ok('…and the pool half still ran (this is a refusal to SPEND, not a refusal to think)', r.pools.includes(w.P), JSON.stringify(r.pools));
  }

  // (c) COLD pool — the pool RESTARTS such a conversation through the client
  {
    const w = await walled({ hot: false });
    ok('control setup: a COLD pool moved the conversation onto the newcomer and broadcast the client restart',
      w.linkOf(w.A._webuiId) === w.NEW && w.coldRestarts() >= 1, `onNew=${w.linkOf(w.A._webuiId) === w.NEW} restarts=${w.coldRestarts()}`);
    const restarts = w.coldRestarts();
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('COLD pool (hot:false): the wake continues NOBODY — a cold conversation is RESTARTED, and master guards its own fireNow with the same `if (a.hot)`',
      r.acted === true && r.fired.length === 0 && w.fired.length === 0 && /^cold pool/.test(r.skipped[0]?.why || ''), JSON.stringify(r));
    ok('…and it added no second restart broadcast either (it only declined to spend)', w.coldRestarts() === restarts, `${restarts} → ${w.coldRestarts()}`);

    // NEGATIVE CONTROL: ONLY the cold clause removed — one mechanism, one control
    const mut = mutantEngine([
      ["      const cold = !!(pa && pa.type === 'pooled' && !(pa.hot && capsOf(pa.backend).hotSwitch === 'verified'));", "      const cold = false; // MUTANT: no cold gate"],
    ]);
    ok('control setup: the no-cold-gate copy applied its replacement', mut.hits === 1, JSON.stringify(mut));
    const w2 = await walled({ hot: false }, mut.mod);
    const r2 = w2.eng.onMemberReadingFresh(w2.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('NEGATIVE CONTROL (no cold gate): the same world spends a continue into a CLI the pool just told the client to replace',
      r2.fired.length === 1 && w2.fired.length === 1, JSON.stringify({ fired: w2.fired.length }));
  }

  // (c′) A CODEX POOL — hot:true that the ENGINE ITSELF refuses to act on (r3).
  // `a.hot` is a WISH the user's checkbox persists; the pool-level path asks
  // `!!a.hot && capsOf(a.backend).hotSwitch === 'verified'` before its own
  // `if (hot)` spend, and `capsOf('codex').hotSwitch` is 'impossible' (the
  // 2026-08-24 experiment: CODEX_HOME is canonicalized at startup and the
  // tokens live in process memory), so a codex pool ALWAYS cold-restarts.
  // Half ② read the RAW flag, so the capability gate delivered exactly the
  // spend the pool-level path had just refused — (c)'s failure mode arriving
  // through a door round 2 did not check.
  //
  // REACHABILITY, not a hypothesis: manage-agents offered the "Hot switch (no
  // restart)" row inside a bare `if (a?.pooled && !selectedHost)` until
  // 2026-09-05, and PATCH /api/accounts/pool/:id still writes `hot` with no
  // caps gate — the flag is inert on every other path, so a user who set it
  // saw nothing happen and had no reason to unset it.
  {
    ok('the two backends really disagree about hotness (this leg is ABOUT the caps half, so it must not be vacuous)',
      capsOf('claude').hotSwitch === 'verified' && capsOf('codex').hotSwitch === 'impossible',
      `claude=${capsOf('claude').hotSwitch} codex=${capsOf('codex').hotSwitch}`);

    /** The incident's shape on a CODEX pool: armed by the REAL codex rejection
     *  producer, the pool default already moved onto a member with no reading,
     *  then that member's first reading arrives. The session ANSWERS the
     *  rpc-rate-limits probe with the wrapper's own error reply, so the 20 s
     *  waiter settles at once instead of racing the wake — measured: without
     *  it the wall probe re-arms mid-gate and the continue is dropped for an
     *  UNRELATED reason, i.e. a leg that would go green on the wrong fact. */
    async function codexWalled(engineModule = engMod) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-wake-cx-'));
      cleanup.push(root);
      const dataDir = path.join(root, 'data');
      const am = new AccountManager({ dataDir });
      const cxLogin = (id) => fs.writeFileSync(path.join(am.codexSubDir(id), 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-' + id } }), { mode: 0o600 });
      const OLD = am.createCodexSubscription({ name: 'ChatGPT Old' }).id; cxLogin(OLD);
      const NEW = am.createCodexSubscription({ name: 'ChatGPT New' }).id; cxLogin(NEW);
      const P = am.createPool({ name: 'codex pool', backend: 'codex' }).id;
      am.setPoolTarget(P, OLD);
      am.updatePool(P, { auto: true, hot: true });   // the state PATCH /pool/:id still accepts

      const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const nowS = Math.floor(Date.now() / 1000);
      const R5 = nowS + 8 * 3600, R7 = nowS + 3 * 86400;
      const writeCache = (id, c) => fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify(c));
      writeCache(OLD, { fetchedAt: Date.now() - 60000, source: 'codex-rate-limits', fiveHour: { utilization: 1, status: 'limited', resetsAt: R5 }, sevenDay: { utilization: 1, status: 'limited', resetsAt: R7 } });
      // NEW has no cache file at all — "no usage data", the incident's state

      const sessions = new Map();
      const notes = [], fired = [], wsSent = [];
      let eng;
      const ar = createAR({
        dataDir, activeSessions: sessions, serverSetting: () => true, log: () => { },
        notify: (id, s2, text) => notes.push({ id, text }),
        sendToSession: (id, s2, text) => { fired.push({ id, text }); return true; },
        beforeFire: (id, s2) => { try { return eng.beforeAutoResumeFire(id, s2); } catch { return true; } },
        fireIdentity: (id, s2) => { try { return eng.fireIdentityFor(s2); } catch { return null; } },
      });
      const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
      eng = engineModule.create({
        app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
        wss: { clients: new Set([{ readyState: 1, send: (p2) => wsSent.push(p2) }]) }, WS_OPEN: 1, broadcastToSession() { },
        serverNotice() { }, serverSetting: () => undefined,
        getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
        recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
        getAutoResume: () => ar, getOtelIngest: () => ({ observedOrgFor: () => null }),
        getQuotaProbe: () => async () => false,   // the CLAUDE rung; never routed to for a codex identity
      });
      const s = { backend: 'codex', mode: 'chat', _webuiId: 'sess-9-1788764799999', claudeSessionId: 'cid-9', backendSessionId: 'cid-9', _accountId: P, _autoResume: true, name: 'sess-9' };
      s.pty = { write(line) { if (/codex-read-limits/.test(String(line))) setImmediate(() => { try { eng.recordCodexQuotaSignal(s, { type: 'rate_limits_updated', error: 'no app-server in this harness' }); } catch { } }); } };
      sessions.set(s._webuiId, s);
      eng.recordCodexQuotaSignal(s, { type: 'task_failed', codexErrorInfo: 'usage_limit_reached' });
      await tick(300);   // let the wall probe the rejection scheduled settle first
      eng._poolAutoLast.clear(); eng._poolSwitchAt.clear(); eng._memberWakeAt.clear(); eng._loginReadAt.clear();
      writeCache(NEW, { fetchedAt: Date.now(), source: 'codex-rate-limits', fiveHour: { utilization: 0.04, resetsAt: R5 }, sevenDay: { utilization: 0.10, resetsAt: R7 } });
      const wake = async (why) => { const x = eng.onMemberReadingFresh(NEW, why); await tick(400); return x; };
      return {
        am, eng, ar, s, P, OLD, NEW, notes, fired, wake,
        armed: () => !!ar._armed.get(s._webuiId),
        linkOf: () => am.poolCurrentFor(P, s._webuiId),
        coldRestarts: () => wsSent.filter((p2) => /"type":"pool-auto-switched"/.test(String(p2))).length,
        cards: () => notes.map((n) => n.text).join(' | '),
      };
    }

    const w = await codexWalled();
    ok('control setup (codex): the REAL codex rejection producer armed it, and the pool COLD-restarted it onto the newcomer',
      w.armed() && w.linkOf() === w.NEW && w.coldRestarts() >= 1,
      `armed=${w.armed()} onNew=${w.linkOf() === w.NEW} restarts=${w.coldRestarts()}`);
    const restarts = w.coldRestarts();
    const r = await w.wake('manual refresh (cli-panel)');
    ok('CODEX pool with hot:true: the wake continues NOBODY — hotness is the caps-gated verdict the engine acts on, never the raw flag',
      r.acted === true && r.fired.length === 0 && w.fired.length === 0 && /^cold pool/.test(r.skipped[0]?.why || ''), JSON.stringify(r));
    ok('…and it added no second restart broadcast either (it only declined to spend)', w.coldRestarts() === restarts, `${restarts} → ${w.coldRestarts()}`);
    ok('…and no card claims a member recovered', !/已恢复可用/.test(w.cards()), w.cards());

    // NEGATIVE CONTROL: ONLY the caps half removed — the raw-flag spelling
    const mutC = mutantEngine([
      ["      const cold = !!(pa && pa.type === 'pooled' && !(pa.hot && capsOf(pa.backend).hotSwitch === 'verified'));",
        "      const cold = !!(pa && pa.type === 'pooled' && !pa.hot); // PRE-FIX: the RAW flag"],
    ]);
    ok('control setup: the raw-flag copy applied its replacement', mutC.hits === 1, JSON.stringify(mutC));
    const w2 = await codexWalled(mutC.mod);
    const r2 = await w2.wake('manual refresh (cli-panel)');
    ok('NEGATIVE CONTROL (raw flag): the same world DELIVERS a continue into a codex CLI that cannot re-read credentials, while the pool was restarting that very conversation',
      r2.fired.length === 1 && w2.fired.length === 1 && w2.coldRestarts() >= 1 && /ChatGPT New 已恢复可用/.test(w2.cards()),
      JSON.stringify({ fired: w2.fired.length, restarts: w2.coldRestarts(), cards: w2.cards() }));
  }

  // (d) THE INCIDENT ITSELF still works — this gate must not close the door it opened
  {
    const w = mkWorld();
    w.eng.maybePoolAutoSwitchForPool(w.P); await tick(5);   // park both on the newcomer
    for (const s of [w.A, w.B]) w.ar.armIfEnabled(s._webuiId, s, w.R5 * 1000, 'UCI Max: no usage data | Fish Max: 5h 0% < 10%');
    w.unthrottle();
    w.writeCache(w.NEW, w.healthy());
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('THE INCIDENT: both conversations were ALREADY parked on the newcomer, so the continue lands on the member that became usable — both released',
      r.fired.length === 2 && w.fired.length === 2 && r.skipped.length === 0, JSON.stringify({ fired: r.fired.length, sent: w.fired.length, skipped: r.skipped }));
    ok('…and the card names the account that recovered', /UCI Max 已恢复可用/.test(cardsOf(w)), cardsOf(w));
  }

  // (e) "THE WAKE MOVED IT" IS HALF ①'s SPEND, NOT HALF ②'s — the LOGIN shape:
  //     armed while the newcomer had no login at all (so it was not a candidate),
  //     then the login lands. Half ①'s per-session pass moves the link AND fires
  //     it itself; half ② must not offer a second continue for the same event.
  {
    const w = mkWorld({ newLoggedIn: false });
    w.reject(w.A); await tick(20);
    ok('control setup: the conversation is armed and STILL on the spent member (the newcomer had no login, so it was not a candidate)',
      !!w.ar._armed.get(w.A._webuiId) && w.linkOf(w.A._webuiId) === w.FISH, `link=${w.linkOf(w.A._webuiId)}`);
    w.unthrottle();
    w.login(w.NEW); w.writeCache(w.NEW, w.healthy());
    const r = w.eng.onMemberReadingFresh(w.NEW, 'login success');
    await settle();
    ok('half ① moved the link and fired it ITSELF, so half ② stands down and names why',
      w.linkOf(w.A._webuiId) === w.NEW && r.fired.length === 0 && r.skipped[0]?.why === 'the wake moved it', JSON.stringify(r));
    ok('…and EXACTLY ONE continue was delivered, worded as the pool switch it was',
      w.fired.length === 1 && /账号池已切换到 UCI Max/.test(cardsOf(w)), JSON.stringify({ fired: w.fired.length, cards: cardsOf(w) }));
    // HONEST BOUNDARY, measured: deleting this snapshot changes no outcome today
    // — auto-resume refuses the second fire on its own (§8f drives that). It
    // stays so half ②'s money-safety is not OWED to another module's private
    // in-flight flag, and the source has to SAY that it is redundant.
    ok('…and the source says so at the snapshot (a redundant guard must announce that it is redundant)',
      /MEASURED HONESTLY: deleting this snapshot changes no outcome TODAY/.test(engSrc0));
  }

  // (f) THE INTERLOCK ITSELF — what actually prevents the second fire today,
  //     driven so (e)'s honesty is checkable rather than asserted.
  {
    const w = mkWorld();
    w.eng.maybePoolAutoSwitchForPool(w.P); await tick(5);
    w.ar.armIfEnabled(w.A._webuiId, w.A, w.R5 * 1000, 'usage limit');
    w.unthrottle(); w.writeCache(w.NEW, w.healthy());
    w.A._arFiring = true;                     // a pre-fire gate is in flight for this session
    const r = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('INTERLOCK: auto-resume refuses a re-entrant fire while its own gate is in flight (attemptFire\'s _arFiring)',
      r.fired.length === 0 && w.fired.length === 0 && !!w.ar._armed.get(w.A._webuiId), JSON.stringify(r));
    w.A._arFiring = false;
    w.eng._memberWakeAt.clear();
    const r2 = w.eng.onMemberReadingFresh(w.NEW, 'manual refresh (cli-panel)');
    await settle();
    ok('…and with the gate clear the same wake DOES continue it (the interlock is a gate, not a wall)',
      r2.fired.length === 1 && w.fired.length === 1, JSON.stringify(r2));
  }

  // (g) THE CARD'S ORDERING — `cause` may only REFINE master's precedence.
  //     Round 1 hoisted the 'account usable again' arm ABOVE kind:'now' and so
  //     silently changed a PRE-EXISTING pair: the engine's near-arm (:1491)
  //     followed by a real pool switch firing with kind:'now' started reading
  //     as "the account recovered".
  {
    const C = (o) => continueNoticeFor(o).text;
    ok('a REAL pool switch on a near-armed session is still described as a switch (the pair round 1 changed)',
      C({ kind: 'now', armReason: 'account usable again', label: 'X' }) === '账号池已切换到 X，已自动继续这个任务。');
    ok('…and the engine really writes both halves of that pair (drift pin: the near-arm reason and a kind:\'now\' switch fire)',
      /armIfEnabled\?\.\(id, session, Date\.now\(\) \+ 45000, 'account usable again'\)/.test(engSrc0)
      && /if \(a\.hot\) \{ try \{ getAutoResume\(\)\?\.fireNow\?\.\(sid, `账号池已切换到 \$\{toName\}`\)/.test(engSrc0));
    ok('the account that came back BY ITSELF (timed path) still reads as a recovery',
      C({ kind: 'timed', armReason: 'account usable again', label: 'X' }) === '账号 X 已恢复可用，已自动继续这个任务。');
    ok('the WAKE names the member that became usable', C({ kind: 'now', armReason: 'usage limit', label: 'X', cause: 'member-usable' }) === '账号 X 已恢复可用，已自动继续这个任务。');
    ok('…but `moved` still outranks `cause`: if the pre-fire gate re-pointed us, the continue lands on a member the wake never spoke about',
      C({ kind: 'now', armReason: 'usage limit', label: 'Y', moved: true, cause: 'member-usable' }) === '账号池已切换到 Y，已自动继续这个任务。');

    // BYTE-IDENTITY WITH MASTER for every pre-existing caller shape. Round 1's
    // commit claimed this and nothing measured it.
    let masterAr = null, gitErr = null;
    try {
      const src = execFileSync('git', ['-C', REPO, 'show', 'master:src/server/auto-resume.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: GIT_ENV });
      const f = path.join(REPO, 'src/server/vs-wake-master-ar-' + process.pid + '.js');
      fs.writeFileSync(f, src); mutants.push(f);
      masterAr = require(f);
    } catch (e) { gitErr = e.message; }
    if (masterAr?.continueNoticeFor) {
      const SHAPES = [
        { kind: 'now', armReason: 'account usable again', label: 'X' },
        { kind: 'now', armReason: 'account usable again', label: 'X', moved: true },
        { kind: 'timed', armReason: 'account usable again', label: 'X' },
        { kind: 'now', armReason: 'Fish Max: 5h 0% < 10%', label: 'X' },
        { kind: 'timed', armReason: 'Fish Max: 5h 0% < 10%', label: 'X' },
        { kind: 'timed', armReason: 'switched to a usable account (X)', label: 'X' },
        { kind: 'now', armReason: 'switched to a usable account (X)', label: 'X' },
        { kind: 'timed', armReason: 'Fish Max: 5h 0%', label: 'X', moved: true },
      ];
      const diffs = SHAPES.filter((s) => JSON.stringify(continueNoticeFor(s)) !== JSON.stringify(masterAr.continueNoticeFor(s)));
      ok(`every pre-existing caller shape is byte-identical to master (cause defaults to null) — ${SHAPES.length} shapes`,
        diffs.length === 0, JSON.stringify(diffs));
      ok('…and the comparison is not vacuous: master\'s copy really answers these', masterAr.continueNoticeFor(SHAPES[0]).text.length > 0);
    } else {
      ok('· SKIP (git could not read master:src/server/auto-resume.js — ' + (gitErr || '?') + ')', true);
    }
  }
}

// ── §7 §ban-safety ─────────────────────────────────────────────────────────
console.log('\n§7 no new vendor surface');
{
  const engSrc = read('src/server/usage-pool-engine.js');
  const wake = engSrc.split('async function onMemberLoginSuccess')[1].split('\n}')[0];
  ok('the login half reads through the EXISTING caps-routed dispatcher and constructs nothing itself',
    /probeQuotaForKey\(memberId\)/.test(wake) && !/https|request\(|fetch\(/.test(wake));
  ok('…and the dispatcher is the one that routes claude → the cli panel and codex → its app-server twin (no claude spawn for a codex identity)',
    /rung === 'cli-usage'/.test(engSrc) && /rung === 'rpc-rate-limits'/.test(engSrc));
  const w = mkWorld();
  // a codex member has no cli-usage rung: the edge must not spawn a claude panel
  let CX = null;
  try { CX = w.am.createCodexSubscription?.({ name: 'ChatGPT' })?.id || null; } catch { CX = null; }
  if (CX && (w.am.get(CX)?.backend || 'claude') === 'codex') {
    const r = await w.eng.onMemberLoginSuccess(CX, 'codex device-auth');
    ok('a codex member never reaches the claude cli-usage rung — the dispatcher routes it to its own (here: absent) app-server twin',
      w.probes.length === 0 && r.ok === false && r.probe?.rung !== 'cli-usage', JSON.stringify({ probes: w.probes, r: r.probe }));
  } else {
    ok('· SKIP (no codex subscription factory on this AccountManager)', true);
  }
}


// ── §9 THE PANEL MAY NOT WRITE FOR A RECORD THAT STOPPED EXISTING ──────────
// The BELT behind §6 EXIT 4 (r3). `refreshViaCliPanel` checks the roster ONCE,
// before a `claude -p /usage` child with a 60-second timeout, and an account
// CAN stop existing inside that window — the subscription auto-merge deletes
// the throwaway milliseconds after the login edge, and "remove this account" is
// an ordinary user action too. Nothing in accounts.js or the routes removes
// usage-cache entries when an account goes away, and `establishedWindows()`
// reads every `.json` in that directory with no roster filter, so a write here
// leaves a cache file AND a window sidecar keyed to an id that names nothing.
//
// Driven through the REAL setupUsage factory with a FAKE `claude` on
// CLAUDE_CMD (zero vendor cost, real execFile, real parse, real writes): the
// panel takes ~400 ms, the account is removed at ~120 ms, exactly as the merge
// exit does it.
console.log('\n§9 the /usage panel refresher answers for a record that no longer exists');
{
  const usageMod = require(path.join(REPO, 'src/usage-routes.js'));
  const usageSrc0 = read('src/usage-routes.js');
  const usageMutants = [];
  process.on('exit', () => { for (const f of usageMutants) { try { fs.unlinkSync(f); } catch { } } });
  let mutU = 0;
  /** A patched copy of src/usage-routes.js, as a SIBLING of the real one (its
   *  requires are relative to src/); same name prefix as the other mutants so
   *  §8's stale-PID sweep collects it, and gitignored. */
  function mutantUsage(edits) {
    let src = usageSrc0, hits = 0;
    for (const [from, to] of edits) {
      if (!src.includes(from)) return { err: 'needle missing: ' + from.slice(0, 70) };
      src = src.split(from).join(to); hits++;
    }
    const f = path.join(REPO, 'src/vs-wake-mut-' + process.pid + '-u' + (++mutU) + '.js');
    fs.writeFileSync(f, src); usageMutants.push(f);
    return { mod: require(f), hits };
  }
  // A panel WITH reset clauses: the window sidecar is stamped only when the
  // reading actually names a window, and both writes have to be in play for
  // the removal leg to prove both are refused.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const at = (ms) => { const d = new Date(Date.now() + ms); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCHours() % 12 || 12}${d.getUTCHours() < 12 ? 'am' : 'pm'} (UTC)`; };
  const PANEL = `Current session: 4% used · resets ${at(3 * 3600e3)}\nCurrent week (all models): 10% used · resets ${at(3 * 86400e3)}\n`;

  function mkUsage({ delayMs = 400, usageModule = usageMod } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-wake-panel-'));
    cleanup.push(root);
    const dataDir = path.join(root, 'data');
    const am = new AccountManager({ dataDir });
    const id = am.createSubscription({ name: 'UCI Max' }).id;
    fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 36e5, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, subscriptionType: 'max' } }), { mode: 0o600 });
    const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
    // the fake CLI: sleeps, then prints a panel this build's own parser accepts
    const bin = path.join(root, 'fake-claude');
    fs.writeFileSync(bin, `#!/bin/sh\nsleep ${(delayMs / 1000).toFixed(2)}\ncat <<'EOF'\n${PANEL}EOF\n`, { mode: 0o755 });
    const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
    const u = usageModule.setupUsage({
      app, accounts: am, hosts: null, usageHistory: null, activeSessions: new Map(),
      serverSetting: () => undefined, ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
      USAGE_CACHE_FILE: path.join(dataDir, 'usage-cache.json'), USAGE_CACHE_DIR: cacheDir,
      CODEX_SESSIONS_DIR: path.join(root, 'codex-sessions'), META_DIR: path.join(dataDir, 'session-meta'),
      AVAILABLE_MODELS: [], BUFFERS_DIR: path.join(dataDir, 'session-buffers'),
      probeUsageForAccountKey: async () => false, onMemberReadingFresh: () => ({}), CLAUDE_CMD: bin,
    });
    const files = () => fs.readdirSync(cacheDir).filter((f) => f.includes(id)).sort();
    return { root, am, id, cacheDir, u, files };
  }

  // POSITIVE CONTROL FIRST: the guard is a refusal, not an off-switch
  {
    const w = mkUsage();
    const okd = await w.u.refreshViaCliPanel(w.id);
    ok('a panel for a LIVE account still lands (the belt refuses, it does not disable the refresher)',
      okd === true && w.files().length >= 1 && JSON.parse(fs.readFileSync(path.join(w.cacheDir, w.id + '.json'), 'utf8')).fiveHour?.utilization === 0.04,
      JSON.stringify(w.files()));
    ok('…and it stamped the account\'s own window sidecar too (so the removal leg below can prove BOTH writes are refused)',
      w.files().some((f) => f.startsWith('.window-')), JSON.stringify(w.files()));
  }

  // THE RACE: the record is removed while the panel is running
  {
    const w = mkUsage();
    const p = w.u.refreshViaCliPanel(w.id);
    await tick(120);
    w.am.remove(w.id);
    const okd = await p;
    ok('a panel that answers AFTER its account was removed writes NOTHING — no cache file, no window sidecar, and it says the reading was not recorded',
      okd === false && w.files().length === 0 && !w.am.get(w.id), JSON.stringify({ okd, files: w.files() }));

    // NEGATIVE CONTROL: the pre-fix refresher — roster asked only at the SPAWN
    const mut = mutantUsage([
      ["  if (!isGlobal && !(accounts.list().accounts || []).some((x) => x.id === key)) {",
        "  if (false) { // PRE-FIX: the roster is asked only before the spawn"],
    ]);
    ok('control setup: the pre-fix refresher copy applied its replacement', mut.hits === 1, JSON.stringify(mut));
    const w2 = mkUsage({ usageModule: mut.mod });
    const p2 = w2.u.refreshViaCliPanel(w2.id);
    await tick(120);
    w2.am.remove(w2.id);
    const okd2 = await p2;
    ok('NEGATIVE CONTROL (pre-fix): the same race leaves a cache file AND a window sidecar keyed to an id the roster no longer knows',
      okd2 === true && !w2.am.get(w2.id) && w2.files().some((f) => f.endsWith('.json')) && w2.files().some((f) => f.startsWith('.window-')),
      JSON.stringify({ okd2, files: w2.files() }));
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
