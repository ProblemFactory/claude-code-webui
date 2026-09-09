#!/usr/bin/env node
// THE SPEND CEILING (docs/design-account-hardening.md §4.4c, P9, owner
// decisions D2 / D3 / D6 / D8).
//
// WHAT IT GUARDS. Producers in this tree can start a BILLED turn with no
// per-occurrence owner action; §2's census derives them from the source and
// PRINTS what it walked (measured on this commit: 14 files carrying a turn-
// injection primitive, of which 5 make the decision — auto-resume, the Stop
// nudge, the delivery ladder for jobs and peer messages, and the codex reset
// credit — and 9 are allowlisted with a reason, one of them being the HUMAN
// path). Each of the five carried its own local floor — auto-resume's loop
// breaker, the Stop nudge's in-memory `_lastStopNudge`, the jobs engine's
// 30s flood floor — and not one of them was a bound on MONEY: they pace ONE
// producer, they are per SESSION (nine conversations can sit on one
// subscription) and they reset on every release restart. Measured on this
// instance's own transcripts — ALL 8,087 of them, not a recently-touched
// sample (that sample lies: `find -mtime -3` selects FILES, and a long-lived
// conversation's file carries records from months back):
//   603 Stop-nudge mini-turns across 72 conversations, 2026-07-10 → 2026-09-09
//   999 forced assistant records reading 536,353,861 cached tokens
//   peaks: 93 in a day, 184 in a rolling 72h, 21 on ONE conversation in ONE hour
// (this instance runs with stopNudgeStaleMinutes=0 AND stopNudgeCooldownMinutes=0,
// i.e. every-stop mode — which is exactly why the cooldown was never the bound.)
// REPLAYED through the real guard with the shipped D6 numbers, that history is
// refused 20 times (7 slots) to 55 times (one slot) out of 603: this ceiling is
// a BACKSTOP against bursts and loops, not a routine throttle, and saying
// otherwise would oversell it.
//
// THE LEGS
//   §1  the PURE rules (src/spend-authorizer.js): caps, windows, retryAfter,
//       overage, credential state, the two "fail closed" refusals
//   §2  THE CENSUS — grep-derived from the tracked source, PRINTED, with a
//       non-session allowlist that dies when it stops matching, a NEGATIVE
//       CONTROL (a synthetic producer in a scratch tree must be caught) and a
//       POSITIVE control (the same producer, gated, is clean)
//   §3  the ORCH guard: persistence across a restart, one journal line, one
//       inbox item, the 80% notice
//   §4  the REAL auto-resume + REAL pool engine: the ceiling refuses a continue
//       the loop breaker would have allowed, the arm survives, and an
//       owner-typed prompt is never counted
//   §5  the REAL delivery ladder: a refusal STASHES (nothing is lost) and an
//       allowed delivery is charged exactly once
//   §6  the REAL Stop-nudge route: the cooldown survives a restart, the exit
//       condition fires for a session that never reports, the ceiling refuses
//   §7  overage: unattended refused, the human path untouched, the panel says it
//   §8  the EDF reserve floor: voluntary refused, escape allowed
//   §9  FAIL CLOSED: an authorizer that throws spends nothing, at four sites
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { gitEnvFrom } from './git-env.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const GIT_ENV = gitEnvFrom(process.env); // §2 asks git for the tracked source INSIDE `npm run build`
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { return ''; } };
const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } });
const tmpdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanup.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const A = require(path.join(REPO, 'src/spend-authorizer.js'));
const guardMod = require(path.join(REPO, 'src/server/spend-guard.js'));
const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
const arMod = require(path.join(REPO, 'src/server/auto-resume.js'));
const deliverMod = require(path.join(REPO, 'src/server/conversation-deliver.js'));
const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));
const { decidePoolSwitch } = require(path.join(REPO, 'src/account-pool-auto.js'));
const { capsOf, notificationDelivery } = require(path.join(REPO, 'src/backend-caps.js')); // §5b reads the LANE off the caps row, never a backend id
const { setupAgentRoutes } = require(path.join(REPO, 'src/agent-routes.js'));

// ── §1 THE PURE RULES ───────────────────────────────────────────────────────
console.log('\n§1 the pure decision (src/spend-authorizer.js)');
{
  const ID = { key: 'sub-a', name: 'A' };
  const L = A.BUDGET_DEFAULTS;
  ok('§1 D6 defaults are the shipped numbers (12/h · 60/day · 200/day instance · notice at 80%)',
    L.perIdentityHour === 12 && L.perIdentityDay === 60 && L.perInstanceDay === 200 && L.noticePct === 80, JSON.stringify(L));
  const lim = A.budgetLimits((k) => ({ 'spend.unattendedPerIdentityHour': 3, 'spend.unattendedPerIdentityDay': 0, 'spend.budgetNoticePct': -4 }[k]));
  ok('§1 a setting overrides its default, an EXPLICIT 0 is a choice, garbage falls back',
    lim.perIdentityHour === 3 && lim.perIdentityDay === 0 && lim.perInstanceDay === 200 && lim.noticePct === 80, JSON.stringify(lim));
  // A settings reader that answers `true` to everything (a harness stub, a
  // corrupted store) would set every ceiling to ONE by coercion — a value
  // nobody chose. Only a number is a number.
  const boolLim = A.budgetLimits(() => true);
  ok('§1 a BOOLEAN is never a cap (Number(true) === 1 must not become the ceiling)',
    boolLim.perIdentityHour === 12 && boolLim.perIdentityDay === 60 && boolLim.perInstanceDay === 200, JSON.stringify(boolLim));

  let st = A.emptyBudget();
  const now = 1_800_000_000_000;
  ok('§1 an empty ledger authorizes', A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: st, now }).ok === true);
  for (let i = 0; i < 12; i++) st = A.noteUnattendedSpend(st, { identity: ID, at: now + i }).state;
  const capped = A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: st, now: now + 100 });
  ok('§1 the 13th unattended turn in an hour is refused, by NAME', capped.ok === false && capped.why === 'hour-cap', JSON.stringify(capped.why));
  ok('§1 …and it says WHEN the window frees a slot (the oldest stamp + 1h), never a guess',
    capped.retryAfter === now + A.HOUR_MS, `${capped.retryAfter - now} vs ${A.HOUR_MS}`);
  ok('§1 …an hour later the same ledger authorizes again (rolling window, not a bucket)',
    A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: st, now: now + A.HOUR_MS + 1000 }).ok === true);
  ok('§1 a DIFFERENT identity is unaffected by the first one\'s hour (the unit is the credential slot)',
    A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: { key: 'sub-b', name: 'B' }, state: st, now: now + 100 }).ok === true);

  // the instance ceiling: 200 spends spread over 20 identities
  let inst = A.emptyBudget();
  for (let i = 0; i < 200; i++) inst = A.noteUnattendedSpend(inst, { identity: { key: 'sub-' + (i % 20), name: 'x' }, at: now + i }).state;
  const iv = A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: { key: 'sub-fresh', name: 'F' }, state: inst, now: now + 500 });
  ok('§1 the INSTANCE ceiling holds even for an identity that has spent nothing', iv.ok === false && iv.why === 'instance-cap', JSON.stringify(iv.why));

  ok('§1 FAIL CLOSED: an identity we cannot name is refused (a ceiling nobody can be charged against is not a ceiling)',
    A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: null, state: A.emptyBudget(), now }).why === 'identity-unknown');
  ok('§1 FAIL CLOSED: a reason outside the declared set is refused',
    A.authorizeUnattendedSpend({ reason: 'something-new', identity: ID, state: A.emptyBudget(), now }).why === 'unknown-reason');
  ok('§1 every declared reason says what it spends, and one of them is not a turn (the codex reset credit)',
    Object.values(A.SPEND_REASONS).every((r) => typeof r.what === 'string' && typeof r.turn === 'boolean')
    && A.SPEND_REASONS['codex-reset-credit'].turn === false && A.SPEND_REASONS['auto-resume'].turn === true);

  const cred = (serves) => A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: A.emptyBudget(), credential: { serves, state: 'wiped' }, now });
  ok('§1 a credential that CANNOT serve is refused (the turn would only buy a junk card)', cred('no').why === 'identity-cannot-serve');
  ok('§1 …but P6 holds: an UNKNOWN credential state is not a claim and does not block', cred('unknown').ok === true && cred('yes').ok === true);

  const ov = (inUse, policy) => A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: A.emptyBudget(), overage: { inUse }, overagePolicy: policy, now });
  ok('§1 D3b: while an account bills PAID OVERAGE every unattended turn is refused', ov('yes', 'refuse').why === 'overage-in-use');
  ok('§1 …an explicit opt-in allows it, and "unknown"/"no" never block', ov('yes', 'allow').ok === true && ov('unknown', 'refuse').ok === true && ov('no', 'refuse').ok === true);

  // the 80% notice
  let n = A.emptyBudget(); let warns = [];
  for (let i = 0; i < 12; i++) { const r = A.noteUnattendedSpend(n, { identity: ID, at: now + i }); n = r.state; if (r.warn) warns.push(r.warn); }
  ok('§1 the 80% notice fires ONCE, at the crossing (10th of 12), naming the axis', warns.length === 1 && warns[0].scope === 'hour' && warns[0].used === 10, JSON.stringify(warns));
  ok('§1 …and its sentence names the account and both numbers', /A has used 10 of its 12 unattended turns this hour \(83%\)/.test(A.noticeText(warns[0])), A.noticeText(warns[0]));

  const pruned = A.pruneBudget({ identities: { x: [now - A.DAY_MS - 1, now - 5] }, instance: [now - A.DAY_MS - 1], notices: {} }, now);
  ok('§1 pruning drops everything older than a day and keeps the rest', pruned.identities.x.length === 1 && pruned.instance.length === 0);
  const src = { identities: { x: [now] }, instance: [now], notices: {} };
  A.pruneBudget(src, now + A.DAY_MS + 1);
  ok('§1 …and it never mutates the caller\'s ledger (a refused authorization leaves no half-pruned state)', src.identities.x.length === 1);

  // DATED, because that is what the producer writes: src/rate-limit-capture.js
  // stamps `asOf` on the very line it merges the overage record.
  const ovRec = (extra = {}) => ({ overage: { inUse: true, asOf: now, ...extra } });
  ok('§1 overageState is THREE-state (yes / no / unknown), never a boolean', A.overageState(ovRec(), { now }).inUse === 'yes'
    && A.overageState({ overage: { inUse: false } }).inUse === 'no' && A.overageState({}).inUse === 'unknown' && A.overageState(null).inUse === 'unknown');
  ok('§1 …and it carries the SPEND figure when the payload has one', A.overageText({ ...ovRec(), spend: { used: 12.5, limit: 50 } }, { now }) === 'paid overage in use — $12.50 of $50.00 this period',
    A.overageText({ ...ovRec(), spend: { used: 12.5, limit: 50 } }, { now }));
  ok('§1 …and says nothing at all when overage is off or unknown', A.overageText({ overage: { inUse: false } }) === null && A.overageText({}) === null);
  // …and the SENTENCE runs on the same clock as the GATE: a text built with its
  // own Date.now() would say "paid overage in use" about a record the
  // authorizer has already expired — two faces of one record, disagreeing.
  ok('§1 …and it is silent about a record the authorizer has expired (one clock, both faces)',
    A.overageText({ overage: { inUse: true, asOf: now - A.OVERAGE_STALE_MS - 1 } }, { now }) === null
    && A.overageText({ ...ovRec(), spend: { used: 1, limit: 2 } }, { now }) !== null);

  // ── r2: THE CLAIM THAT BLOCKS IS THE ONE THAT NEEDS A DATE ────────────────
  // `asOf` was captured and never consulted, so a record that stopped being
  // refreshed refused every unattended turn FOREVER — including the continue
  // for an auto-resume-armed session, which is by definition idle and produces
  // no events to refresh it with — and `retryAfter` printed a reset instant in
  // the PAST. Measured on this instance: seven live records, ages up to 33 h on
  // a cache refreshed 4 minutes ago, and 0 of 7 carrying a `resetsAt`.
  {
    const ovAuth = (cache) => A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: A.emptyBudget(), overage: A.overageState(cache, { now }), now });
    const fresh = { overage: { inUse: true, asOf: now - 60e3 } };
    const aged = { overage: { inUse: true, asOf: now - A.OVERAGE_STALE_MS - 1 } };
    const ended = { overage: { inUse: true, asOf: now - 60e3, resetsAt: Math.floor((now - 3600e3) / 1000) } };
    const undated = { overage: { inUse: true } };
    ok('§1 a FRESH overage record still refuses (D3b is intact — this is the positive control)',
      ovAuth(fresh).ok === false && ovAuth(fresh).why === 'overage-in-use');
    ok('§1 …and it SAYS how old the evidence is (a refusal that never dates itself cannot be told from a stale file)',
      / \(last reported 1 min ago\)/.test(ovAuth(fresh).detail), ovAuth(fresh).detail);
    ok('§1 a STALE record neither blocks nor claims (P6) and says which rung expired it',
      ovAuth(aged).ok === true && A.overageState(aged, { now }).inUse === 'unknown'
      && A.overageState(aged, { now }).evidence === 'stale' && A.overageState(aged, { now }).stated === 'yes');
    ok('§1 …a record whose OWN resetsAt has passed describes a period that ENDED, so it is not a claim about now',
      ovAuth(ended).ok === true && A.overageState(ended, { now }).evidence === 'period-ended');
    ok('§1 …and an UNDATED record cannot claim the present either', ovAuth(undated).ok === true && A.overageState(undated, { now }).evidence === 'undated');
    ok('§1 NEGATIVE CONTROL: an expired claim never turns into a REFUSAL of a different kind — it simply stops blocking',
      ovAuth(aged).why === null && ovAuth(ended).why === null && ovAuth(undated).why === null);
    ok('§1 …and a still-future resetsAt keeps its retryAfter in the FUTURE (the old shape printed an instant in the past)',
      ovAuth({ overage: { inUse: true, asOf: now - 60e3, resetsAt: Math.floor((now + 3600e3) / 1000) } }).retryAfter > now);
    ok('§1 …while `inUse:no` is deliberately NOT date-bounded (it blocks nothing, so no decision changes)',
      A.overageState({ overage: { inUse: false, asOf: now - A.OVERAGE_STALE_MS * 4 } }, { now }).inUse === 'no');
  }
  ok('§1 the PURE module imports nothing (P1: one rule, no tier crossings)', !/^\s*(const|let|var)\s+\w+\s*=\s*require\(/m.test(read('src/spend-authorizer.js')));

  // ── r2: THE OFFERED RANGE AND THE ENFORCEABLE RANGE ARE ONE SET ───────────
  // Round 1 kept a flat `MAX_STAMPS = 4 * 200` while the settings schema
  // offered 2000 per identity/day and 10000 per instance/day and budgetLimits
  // clamped at 100000/1000000 — so every value the UI accepted above 800 was
  // silently unenforceable: 1500 charged spends against a 1000/day cap counted
  // 800 and authorized the 1501st. A setting that reads as a money bound and is
  // not one is worse than no setting.
  {
    const schema = read('src/lib/settings-schema.js');
    const maxOf = (key) => {
      const i = schema.indexOf(`'${key}': {`);
      if (i < 0) return null;
      const m = /max:\s*(\d+)/.exec(schema.slice(i, i + 400));
      return m ? Number(m[1]) : null;
    };
    const rows = { perIdentityHour: 'spend.unattendedPerIdentityHour', perIdentityDay: 'spend.unattendedPerIdentityDay', perInstanceDay: 'spend.unattendedPerInstanceDay' };
    const schemaMax = Object.fromEntries(Object.entries(rows).map(([k, key]) => [k, maxOf(key)]));
    ok('§1 the census can read all three schema rows (an unreadable schema would make the next assert vacuous)',
      Object.values(schemaMax).every((v) => Number.isFinite(v)), JSON.stringify(schemaMax));
    ok('§1 the authorizer\'s clamp IS the schema\'s own max, row for row — widening one without the other goes red here',
      Object.entries(schemaMax).every(([k, v]) => A.CAP_MAX[k] === v), JSON.stringify({ schemaMax, CAP_MAX: A.CAP_MAX }));
    // and the ledger can COUNT to the biggest cap the schema offers
    const bigLimits = { perIdentityHour: 200, perIdentityDay: 2000, perInstanceDay: 10000, noticePct: 0 };
    ok('§1 retention is a FUNCTION of the limits, so the biggest offered cap is reachable',
      A.stampCap(bigLimits) > bigLimits.perInstanceDay && A.stampCap(bigLimits) <= A.CAP_MAX.perInstanceDay + 128,
      String(A.stampCap(bigLimits)));
    // the reproduction, end to end, at a cap ABOVE the retired constant
    const L2 = { perIdentityHour: 1000, perIdentityDay: 1000, perInstanceDay: 1000, noticePct: 0 };
    let st2 = A.emptyBudget();
    for (let i = 0; i < 1000; i++) st2 = A.noteUnattendedSpend(st2, { identity: ID, at: now + i, limits: L2 }).state;
    const c2 = A.spendCounts(st2, ID.key, now + 1000);
    ok('§1 a 1000/hour cap really counts 1000 (the retired 800-stamp ledger topped out below every value above it)',
      c2.hour === 1000, JSON.stringify(c2));
    ok('§1 …and the 1001st is REFUSED (this authorized before: the ceiling could not be reached, so it never fired)',
      A.authorizeUnattendedSpend({ reason: 'auto-resume', identity: ID, state: st2, limits: L2, now: now + 1000 }).why === 'hour-cap');
    ok('§1 NEGATIVE CONTROL: the retired flat retention would still top out at 800 on that same ledger',
      st2.identities[ID.key].slice(-800).length === 800 && c2.hour > 800);
    ok('§1 …and the ledger stays BOUNDED (retention never exceeds the clamped instance cap plus head-room)',
      st2.identities[ID.key].length <= A.CAP_MAX.perInstanceDay + 128);
    // the clamp itself
    ok('§1 a setting ABOVE the schema max is clamped to it, never silently accepted as unenforceable',
      A.budgetLimits((k) => ({ 'spend.unattendedPerInstanceDay': 999999 }[k])).perInstanceDay === A.CAP_MAX.perInstanceDay);
  }
}

// ── §2 THE CENSUS ───────────────────────────────────────────────────────────
// Grep-derived from the TRACKED source, exactly like the writer-sweep and NUL
// censuses: the file set is a property (what git tracks under the server-side
// roots), never a hand-written list, and the set it walked is PRINTED.
console.log('\n§2 the census: every producer of a turn nobody typed is under the ceiling');

// A producer PRIMITIVE = a way to put a user turn into a live session.
const PRIMITIVES = [
  { id: 'user-frame', re: /formatChatInput\s*\(/, why: 'composes a USER message frame for a live session' },
  { id: 'continue-send', re: /sendToSession\s*\(/, why: 'hands a session a user turn it did not ask for (auto-resume\'s continue)' },
  { id: 'cli-inbox', re: /\b(postToPeer|postChannelEvent|peerPost)\s*\(/, why: "writes into the CLI's own cross-session inbox — idle ⇒ a billed turn" },
  { id: 'rpc-peer-frame', re: /type:\s*'peer-message'/, why: "hands the wrapper a peer message — idle ⇒ turn/start" },
  { id: 'deliver-ladder', re: /deliverToConversation\s*\(/, why: 'the delivery ladder itself (jobs notifications, agent messages)' },
  { id: 'stop-nudge', re: /block:\s*true/, why: 'the Stop hook arbiter — block+reason IS an extra billed mini-turn' },
  { id: 'reset-credit', re: /type:\s*'codex-reset-credit'/, why: 'consumes a stored reset credit (money already paid for)' },
];
// GATED = the file ASKS THE GATE. It must be a CALL, never a mention: r2 found
// `src/server/usage-pool-engine.js` reported GATED because it CONSTRUCTS the
// guard (`require('./spend-guard.js').create({…})`) while its own producer —
// the codex reset credit — went through `authorizeSpend`, a dep server.js never
// passed. The census said "gated" about the one file that also happens to be
// where the guard is built, so the producer inside it was invisible. Matching
// the call shape means the construction line alone no longer satisfies it.
const GATED_RE = /(?:authorizeSpend|spendGuard\.authorize|authorizeUnattendedSpend)\s*\(/;
// NOT a spend site — each entry says why, and an entry that stops matching
// anything FAILS (a dead allowlist row hides the next real producer).
const ALLOW = [
  { file: 'src/ws-handler.js', why: 'THE HUMAN PATH: a ws `input` message is the owner typing, and the codex reset-credit case is the owner clicking it. Owner-typed turns are never counted (D6) — this row IS that rule' },
  { file: 'src/adapters/claude-code.js', why: 'a FORMATTER: builds the frame, never sends it' },
  { file: 'src/adapters/codex.js', why: 'a FORMATTER: builds the frame, never sends it' },
  { file: 'src/adapters/acp.js', why: 'a FORMATTER: builds the frame, never sends it' },
  { file: 'src/peer-messaging.js', why: 'the PRIMITIVE (unix-socket write). Policy lives at the ladder that calls it — this file has no idea who asked' },
  { file: 'src/agentd/agentd.js', why: 'the DEVICE half of a delivery the hub already authorized (the peer-post op)' },
  { file: 'src/agentd/client.js', why: 'the hub-side RPC stub for that same op' },
  { file: 'src/server/jobs-wiring.js', why: 'a pass-through that forwards to the gated ladder' },
  { file: 'src/jobs.js', why: 'the jobs engine calls the gated ladder and stashes what it refuses (its own 30s floor is pacing, not money)' },
];

/** The census, parameterized by ROOT so the negative control can run the very
 *  same code over a scratch tree (a census that cannot be driven over a tree
 *  with a known offender is a census nobody has ever seen go red). */
function censusOver(root, files) {
  const hits = [];   // {file, prim, gated}
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const gated = GATED_RE.test(src);
    for (const p of PRIMITIVES) if (p.re.test(src)) hits.push({ file: f, prim: p.id, gated });
  }
  return hits;
}
function trackedServerSource() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'src', 'server.js', 'data/bin'], { env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 }).toString();
  return out.split('\0').filter(Boolean)
    .filter((f) => f.endsWith('.js') && !f.startsWith('src/lib/'));  // src/lib = the browser; it cannot spend
}
{
  let files = [];
  let gitOk = true;
  try { files = trackedServerSource(); } catch (e) { gitOk = false; console.log('  · SKIP: git could not list the tracked source (' + e.message.split('\n')[0] + ')'); }
  if (gitOk) {
    ok('§2 census scope is non-vacuous and covers the known producers', files.length > 50
      && ['server.js', 'src/server/auto-resume.js', 'src/server/conversation-deliver.js', 'src/agent-routes.js', 'src/server/usage-pool-engine.js'].every((f) => files.includes(f)),
      `${files.length} tracked server-side files`);
    const hits = censusOver(REPO, files);
    const byFile = new Map();
    for (const h of hits) { if (!byFile.has(h.file)) byFile.set(h.file, { gated: h.gated, prims: new Set() }); byFile.get(h.file).prims.add(h.prim); }
    console.log('    producers found (' + byFile.size + '):');
    for (const [f, v] of [...byFile].sort()) console.log(`      ${v.gated ? 'GATED   ' : 'allowed?'} ${f}  [${[...v.prims].join(', ')}]`);
    const allowSet = new Set(ALLOW.map((a) => a.file));
    const unwired = [...byFile].filter(([f, v]) => !v.gated && !allowSet.has(f)).map(([f]) => f);
    ok('§2 every producer of an unattended turn is under the authorizer (or allowlisted WITH a reason)', unwired.length === 0, unwired.join(', '));
    const deadAllow = ALLOW.filter((a) => !byFile.has(a.file));
    ok('§2 no dead allowlist entry (a row that matches nothing hides the next real producer)', deadAllow.length === 0, deadAllow.map((a) => a.file).join(', '));
    ok('§2 every allowlist row states WHY', ALLOW.every((a) => typeof a.why === 'string' && a.why.length > 20));
    const gatedFiles = [...byFile].filter(([, v]) => v.gated).map(([f]) => f);
    // THE REASON TABLE, BOTH WAYS: every reason a producer passes must be
    // declared (an undeclared one is refused at runtime — §1 — so it would be a
    // silently dead producer), and every declared reason must have a producer
    // (a spare slot is what the next producer slides into without a decision).
    const passed = new Set();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/(?:spendReason|reason):\s*'([a-z-]+)'/g)) if (A.SPEND_REASONS[m[1]] || /^(auto-resume|stop-nudge|job-notification|peer-message|codex-reset-credit)$/.test(m[1])) passed.add(m[1]);
    }
    const undeclared = [...passed].filter((r) => !A.SPEND_REASONS[r]);
    ok('§2 every spend reason a producer passes is DECLARED', undeclared.length === 0, undeclared.join(', '));
    const unused = Object.keys(A.SPEND_REASONS).filter((r) => !passed.has(r));
    ok('§2 …and every DECLARED reason has a producer (' + [...passed].sort().join(', ') + ')', unused.length === 0, 'declared with no producer: ' + unused.join(', '));

    ok('§2 the four wired consumers are all in the GATED set', ['src/server/auto-resume.js', 'src/server/conversation-deliver.js', 'src/agent-routes.js', 'src/server/usage-pool-engine.js'].every((f) => gatedFiles.includes(f)), gatedFiles.join(', '));

    // NEGATIVE CONTROL: a synthetic producer in a scratch tree.
    const scratch = tmpdir('vs-spend-census-');
    fs.mkdirSync(path.join(scratch, 'src', 'server'), { recursive: true });
    const producer = "'use strict';\nfunction notifyOwner(session, text) {\n  const { stdinPayload } = adapter.formatChatInput(text, 'x');\n  session.pty.write(stdinPayload + '\\n');\n}\nmodule.exports = { notifyOwner };\n";
    fs.writeFileSync(path.join(scratch, 'src/server/new-producer.js'), producer);
    const cHits = censusOver(scratch, ['src/server/new-producer.js']);
    ok('§2 NEGATIVE CONTROL: a NEW producer that opens a turn is CAUGHT by the same code, unwired',
      cHits.length === 1 && cHits[0].prim === 'user-frame' && cHits[0].gated === false, JSON.stringify(cHits));
    fs.writeFileSync(path.join(scratch, 'src/server/new-producer.js'),
      producer.replace('function notifyOwner(session, text) {', 'function notifyOwner(session, text) {\n  if (!authorizeSpend({ reason: \'job-notification\', session }).ok) return false;'));
    const cHits2 = censusOver(scratch, ['src/server/new-producer.js']);
    ok('§2 POSITIVE CONTROL: the same producer, wired to the authorizer, is clean',
      cHits2.length === 1 && cHits2[0].gated === true, JSON.stringify(cHits2));
    // r2's OWN blind spot, as a permanent control: a file that BUILDS the guard
    // and holds a producer that does not ask it must be caught. The round-1
    // regex matched the word `spendGuard` anywhere, so this file read GATED and
    // the assert below ("the wired consumers are all in the GATED set") was a
    // false green about the one producer that was in fact dead in production.
    fs.writeFileSync(path.join(scratch, 'src/server/new-producer.js'),
      "'use strict';\nconst spendGuard = require('./spend-guard.js').create({ dataDir: 'x' });\n"
      + "function notifyOwner(session, text) {\n  const { stdinPayload } = adapter.formatChatInput(text, 'x');\n  session.pty.write(stdinPayload + '\\n');\n}\nmodule.exports = { notifyOwner, spendGuard };\n");
    const cHits3 = censusOver(scratch, ['src/server/new-producer.js']);
    ok('§2 NEGATIVE CONTROL: a file that CONSTRUCTS the guard but never ASKS it is NOT gated (r2: this is how the reset credit hid)',
      cHits3.length === 1 && cHits3[0].gated === false, JSON.stringify(cHits3));
    ok('§2 …and the retired regex would have called that same file gated (the blind spot, kept as a control)',
      /authorizeSpend|spendGuard|spend-authorizer/.test(fs.readFileSync(path.join(scratch, 'src/server/new-producer.js'), 'utf8')));
  }

  // WIRING PIN — the census proves a file ASKS; these prove server.js HANDS it
  // the real guard (an unwired dep degrades to "allow", which is the shape a
  // test harness needs and production must never have).
  const srv = read('server.js');
  ok('§2 WIRING: the engine constructs the ONE guard and server.js re-exports it',
    /spendGuard,/.test(srv) && /const spendGuard = require\('\.\/spend-guard\.js'\)\.create\(\{/.test(read('src/server/usage-pool-engine.js')));
  ok('§2 WIRING: auto-resume is created WITH authorizeSpend + noteSpend',
    /authorizeSpend: \(id, s, identity\) => spendGuard\.authorize\(\{ reason: 'auto-resume'/.test(srv) && /noteSpend: \(id, s, identity\) => spendGuard\.note\(/.test(srv));
  ok('§2 WIRING: the delivery ladder is created WITH authorizeSpend + noteSpend',
    /authorizeSpend: \(req\) => spendGuard\.authorize\(req\), noteSpend: \(rec\) => spendGuard\.note\(rec\)/.test(srv));
  ok('§2 WIRING: the agent routes (the Stop nudge lives there) receive the guard', /setupAgentRoutes\(\{[^)]*spendGuard,/.test(srv));
  // THE ENGINE'S OWN PRODUCER (r2). The other three consumers get the guard
  // handed to them by server.js and have a pin each; the codex reset credit
  // lives INSIDE the file that constructs it, so its pin is that it asks the
  // module-local object DIRECTLY — never an injected dep. That dep was the
  // defect: `create()` declared `authorizeSpend = null` and server.js never
  // passed it, so the gate was dead in production while a harness that DID pass
  // it kept §9(d) green.
  {
    const eng = read('src/server/usage-pool-engine.js');
    ok('§2 WIRING: the codex reset credit asks the module-local guard, not an injected dep',
      /spendGuard\.authorize\(\{ reason: 'codex-reset-credit'/.test(eng) && /spendGuard\.note\(\{ reason: 'codex-reset-credit'/.test(eng));
    ok('§2 …and the engine takes NO authorizeSpend/noteSpend deps any more (a gate depending on a dep nobody passes is nobody\'s gate)',
      !/authorizeSpend\s*=\s*null/.test(eng) && !/noteSpend\s*=\s*null/.test(eng));
    ok('§2 …and the guard the reset credit asks is the one this file constructs',
      eng.indexOf("require('./spend-guard.js').create({") > 0
      && eng.indexOf("require('./spend-guard.js').create({") < eng.indexOf("spendGuard.authorize({ reason: 'codex-reset-credit'"));
  }
  ok('§2 WIRING: the two callers of the ladder TYPE themselves (jobs ⇒ job-notification, agent messaging ⇒ peer-message)',
    /spendReason: 'job-notification'/.test(read('src/jobs.js')) && /spendReason: 'peer-message'/.test(read('src/agent-routes.js')));
  ok('§2 WIRING: the ledger is FLUSHED on the routine restart path (a debounced-only write hands the next boot a fresh hour)',
    /spendGuard\.flush\(\)/.test(srv) && /function shutdown\(\)[\s\S]{0,900}spendGuard\.flush\(\)/.test(srv));
  ok('§2 §ban-safety: the vendor whitelist is untouched by this change (design §7 — if it needed a change, the design is wrong)',
    !/spend-authorizer|spend-guard|spend-budget/.test(read('scripts/test-vendor-whitelist.mjs')));
}

// ── §3 THE ORCH GUARD ───────────────────────────────────────────────────────
console.log('\n§3 the guard: persisted counters, one journal line, one inbox item');
{
  const dataDir = tmpdir('vs-spend-guard-');
  const logs = [], inbox = [];
  const settings = { 'spend.unattendedPerIdentityHour': 2 };
  const mk = () => guardMod.create({
    dataDir, serverSetting: (k) => settings[k],
    identityOf: (s) => (s && s.id ? { key: s.id, name: s.id.toUpperCase() } : null),
    getUserTodos: () => ({ add: (key, item) => { inbox.push({ key, ...item }); return { id: 'ut-' + inbox.length }; } }),
    log: (...a) => logs.push(a.join(' ')),
  });
  let g = mk();
  const S = { id: 'sub-a', name: 'conv' };
  ok('§3 the first two unattended turns are authorized', g.authorize({ reason: 'auto-resume', session: S }).ok === true);
  g.note({ reason: 'auto-resume', session: S });
  g.note({ reason: 'auto-resume', session: S });
  const r3 = g.authorize({ reason: 'auto-resume', session: S, sessionName: 'my conversation' });
  ok('§3 the third is refused by the hour cap', r3.ok === false && r3.why === 'hour-cap');
  ok('§3 the refusal reaches the JOURNAL once, naming the reason, the identity and the session',
    logs.filter((l) => /refused auto-resume/.test(l)).length === 1 && /SUB-A/.test(logs.join('\n')) && /hour-cap/.test(logs.join('\n')), logs.join(' | '));
  g.authorize({ reason: 'auto-resume', session: S }); g.authorize({ reason: 'auto-resume', session: S });
  ok('§3 …and repeats inside the 5min floor stay out of the journal (the incident wrote ~150 identical cards)',
    logs.filter((l) => /refused auto-resume/.test(l)).length === 1);
  const refusals = inbox.filter((i) => /VibeSpace refused/.test(i.text));
  ok('§3 the refusal reaches the USER: exactly one "For you" item, in the accounts row, naming the ceiling',
    refusals.length === 1 && refusals[0].key === 'accounts' && /cap 2/.test(refusals[0].text) && /2\/2 this hour/.test(refusals[0].detail), JSON.stringify(refusals[0] || inbox[0] || {}).slice(0, 220));

  g.flush();
  ok('§3 the ledger is on disk', fs.existsSync(path.join(dataDir, 'spend-budget.json')));
  const g2 = mk();  // ← A RESTART
  ok('§3 THE COUNTERS SURVIVE A RESTART (a release restart that hands the spenders a fresh hour is not a ceiling)',
    g2.authorize({ reason: 'auto-resume', session: S }).why === 'hour-cap');
  ok('§3 …and a different identity is still free after that restart',
    g2.authorize({ reason: 'auto-resume', session: { id: 'sub-b' } }).ok === true);

  // the 80% notice reaches the inbox too
  const inbox0 = inbox.length;   // (the 80% notice already fired above, at 2 of 2)
  settings['spend.unattendedPerIdentityHour'] = 10;
  const g3 = mk();
  for (let i = 0; i < 8; i++) g3.note({ reason: 'stop-nudge', session: { id: 'sub-c' } });
  ok('§3 the 80% notice is filed once, in the inbox, naming the budget', inbox.length === inbox0 + 1 && /8 of its 10 unattended turns/.test(inbox[inbox.length - 1].text), inbox[inbox.length - 1]?.text);
  const before = inbox.length;
  g3.note({ reason: 'stop-nudge', session: { id: 'sub-c' } });
  ok('§3 …and NOT again inside the same window', inbox.length === before);
}

// ── §3b THE CREDENTIAL READER IS THE ACCOUNT'S, NOT THE SLOT'S (r2) ─────────
// `credentialStateOf` was wired to `memberLoginState`, which reads the
// credential FILE and is deliberately oat-blind: it answers for a credential
// SLOT, and re-pointing a symlink can never hand a long-lived token to a
// running CLI. Asked about an ACCOUNT it is wrong for a supported, spawnable
// configuration — B-211a `oatOnly`, where `resolveForSpawn` returns
// `{oatOnly:true, localEnv:{CLAUDE_CODE_OAUTH_TOKEN}}` and there is NO
// credential file at all. Every unattended producer was refused on such an
// account FOREVER (unlike the hour/day caps this refusal never expires), with a
// reason — "cannot authorize a request right now" — that is factually false
// about an account serving turns normally.
console.log('\n§3b an oat-only subscription serves turns, so the ceiling must not call it dead');
{
  const dataDir = tmpdir('vs-spend-oat-');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) {
    console.log('  · SKIP (pooled accounts are unsupported on ' + process.platform + ')');
  } else {
    const OAT = am.createSubscription({ name: 'OatOnly' }).id;
    am.setOat(OAT, 'sk-ant-oat01-' + 'z'.repeat(48));
    // NEGATIVE CONTROL: wiped credential file, no token — nothing can serve it
    const DEAD = am.createSubscription({ name: 'Wiped' }).id;
    fs.writeFileSync(path.join(am.subDir(DEAD), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: Date.now() + 29 * 86400e3 } }), { mode: 0o600 });
    // the shape the product actually spawns — the whole reason this matters
    let spawn = null; try { spawn = am.resolveForSpawn(OAT, 'claude'); } catch (e) { spawn = { err: e.message }; }
    ok('§3b the account is SPAWNABLE with no credential file (oatOnly ⇒ the token rides spawn env)',
      spawn && spawn.oatOnly === true && !!spawn.localEnv?.CLAUDE_CODE_OAUTH_TOKEN, JSON.stringify(spawn).slice(0, 140));

    // THE ENGINE'S OWN READERS, both of them, on the same account
    const eng2 = engMod.create({
      app: { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} },
      rootDir: path.dirname(dataDir), USAGE_CACHE_DIR: path.join(dataDir, 'usage-cache'),
      activeSessions: new Map(), wss: { clients: new Set() }, WS_OPEN: 1,
      broadcastToSession() { }, serverNotice() { }, serverSetting: () => undefined,
      getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
      recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
      getAutoResume: () => null, getOtelIngest: () => ({ observedOrgFor: () => null }), getQuotaProbe: () => null,
      getUserTodos: () => null,
    });
    ok('§3b the SLOT reader still calls it unusable — deliberately, and that is its correct answer about a slot',
      eng2.memberLoginState(OAT)?.usable === false, JSON.stringify(eng2.memberLoginState(OAT)));
    ok('§3b the ACCOUNT reader says it CAN serve, and names the channel',
      eng2.accountCredentialState(OAT)?.usable === true && eng2.accountCredentialState(OAT)?.state === 'oat',
      JSON.stringify(eng2.accountCredentialState(OAT)));
    ok('§3b NEGATIVE CONTROL: a wiped account with no token is still dead to BOTH readers',
      eng2.memberLoginState(DEAD)?.usable === false && eng2.accountCredentialState(DEAD)?.usable === false);
    ok('§3b …and a key that is not a claude subscription gets NO OPINION from either (P6)',
      eng2.accountCredentialState('__global__') === null && eng2.accountCredentialState('pool-x') === null);

    // and the GUARD, through the engine's own construction, refuses nothing
    for (const reason of Object.keys(A.SPEND_REASONS)) {
      const v = eng2.spendGuard.authorize({ reason, identity: { key: OAT, name: 'OatOnly' } });
      ok(`§3b the ceiling AUTHORIZES ${reason} on the oat-only account`, v.ok === true, v.why + ': ' + v.detail);
    }
    const vd = eng2.spendGuard.authorize({ reason: 'auto-resume', identity: { key: DEAD, name: 'Wiped' } });
    ok('§3b NEGATIVE CONTROL: the wiped account is still refused (the fix widens nothing else)',
      vd.ok === false && vd.why === 'identity-cannot-serve', JSON.stringify(vd).slice(0, 140));

    // WIRING PIN: the guard must be built with the ACCOUNT reader
    const engSrc = read('src/server/usage-pool-engine.js');
    ok('§3b WIRING: the guard is constructed with accountCredentialState, not memberLoginState',
      /credentialStateOf: \(key\) => accountCredentialState\(key\)/.test(engSrc));
    ok('§3b …and memberLoginState is still what SLOT validation asks (the two questions stay two)',
      /const st = memberLoginState\(linkedId\)/.test(engSrc));
  }
}

// ── §4 THE REAL AUTO-RESUME + THE REAL POOL ENGINE ──────────────────────────
console.log('\n§4 the real auto-resume: the ceiling refuses what the loop breaker would allow');
/** The world: one pooled member, one conversation, real symlinks, real engine
 *  (which constructs the real guard), real auto-resume wired exactly as
 *  server.js wires it. */
function mkWorld({ settings = {} } = {}) {
  const root = tmpdir('vs-spend-world-');
  const dataDir = path.join(root, 'data');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) return null;
  const login = (id) => fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, subscriptionType: 'max' } }), { mode: 0o600 });
  const M1 = am.createSubscription({ name: 'Alpha' }).id; login(M1);
  const M2 = am.createSubscription({ name: 'Beta' }).id; login(M2);
  const P = am.createPool({ name: 'pool' }).id;
  am.setPoolTarget(P, M1);
  am.updatePool(P, { auto: true, hot: true });
  const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  const R5 = nowS + 3600, R7 = nowS + 3 * 86400;
  const writeCache = (id, c) => fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify(c));
  const healthy = (extra = {}) => ({ fetchedAt: Date.now(), source: 'on-demand', fiveHour: { utilization: 0.1, resetsAt: R5 }, sevenDay: { utilization: 0.2, resetsAt: R7 }, ...extra });
  writeCache(M1, healthy()); writeCache(M2, healthy());

  const sessions = new Map();
  const notices = [], notes = [], fired = [], inbox = [];
  const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
  const eng = engMod.create({
    app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
    wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: (k, t) => notices.push(t),
    serverSetting: (k) => settings[k], getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
    recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
    getAutoResume: () => ar, getOtelIngest: () => ({ observedOrgFor: () => null }), getQuotaProbe: () => null,
    getUserTodos: () => ({ add: (key, item) => { inbox.push({ key, ...item }); return { id: 'ut' }; } }),
  });
  const ar = arMod.create({
    dataDir, activeSessions: sessions, serverSetting: () => true, log: () => { },
    notify: (id, s2, text) => notes.push({ id, text }),
    sendToSession: (id, s2, text) => { fired.push({ id, text }); return true; },
    beforeFire: (id, s2) => { try { return eng.beforeAutoResumeFire(id, s2); } catch { return false; } },
    fireIdentity: (id, s2) => { try { return eng.fireIdentityFor(s2); } catch { return null; } },
    authorizeSpend: (id, s2, identity) => eng.spendGuard.authorize({ reason: 'auto-resume', session: s2, sessionId: id, sessionName: s2 && s2.name, identity }),
    noteSpend: (id, s2, identity) => eng.spendGuard.note({ reason: 'auto-resume', session: s2, identity }),
  });
  const mkSession = (sid) => {
    const s = { backend: 'claude', mode: 'chat', _webuiId: sid, claudeSessionId: 'cid-' + sid, _accountId: P, _autoResume: true, _servedModel: 'claude-fable-5', _servedModelAt: Date.now(), pty: { write() { } }, name: sid };
    sessions.set(sid, s); am.ensureSessionPoolLink(P, sid, M1); return s;
  };
  return {
    root, dataDir, am, eng, ar, sessions, P, M1, M2, notices, notes, fired, inbox, writeCache, healthy, cacheDir,
    mkSession,
    // An arm needs a reset in the FUTURE (armIfEnabled refuses a past one), and
    // the tick is driven with an explicit `now` past reset + GRACE_MS instead
    // of sleeping 15s.
    arm: (s) => ar.armIfEnabled(s._webuiId, s, Date.now() + 60_000, 'usage limit'),
    fireDue: async () => { ar.tick(Date.now() + 120_000); await tick(80); },
  };
}
const probe = mkWorld();
if (!probe) {
  console.log('  · SKIP (pooled accounts are unsupported on ' + process.platform + ')');
  console.log(`\n${fail ? fail + ' FAILED' : 'ALL PASS'} (${pass})`);
  process.exit(fail ? 1 : 0);
}
{
  const w = mkWorld({ settings: { 'spend.unattendedPerIdentityHour': 1 } });
  const s = w.mkSession('sess-1-1');
  // fire #1 — allowed
  w.arm(s); await w.fireDue();
  ok('§4 the first continue is delivered', w.fired.length === 1, JSON.stringify(w.fired.map((f) => f.id)));
  // the loop breaker itself would allow a TIMED fire for a different arm, so
  // this next one is refused by the CEILING and by nothing else
  const s2 = w.mkSession('sess-2-2');
  ok('§4 control: the loop breaker has no objection to the second session (a fresh record, no failed fire)',
    w.ar.canFire('sess-2-2', w.M1, 'timed', Date.now()).ok === true);
  w.arm(s2); await w.fireDue();
  ok('§4 THE CEILING refuses it: the identity has spent its hour', w.fired.length === 1, JSON.stringify(w.fired.map((f) => f.id)));
  ok('§4 …and the PROMISE is kept: the session is still armed, so a later hour continues it', !!w.ar._armed.get('sess-2-2'));
  ok('§4 …and the refusal reached the user through the guard, not through a second card class',
    w.inbox.some((i) => /refused/.test(i.text) && /hour/.test(i.detail || '')) && !w.notes.some((n) => /预算/.test(n.text)), JSON.stringify(w.inbox.map((i) => i.text)));

  // the budget on disk counts exactly the delivered turn
  w.eng.spendGuard.flush();
  const led = JSON.parse(fs.readFileSync(path.join(w.dataDir, 'spend-budget.json'), 'utf8'));
  ok('§4 the ledger records exactly ONE spend, against the credential slot the continue landed on',
    (led.budget.identities[w.M1] || []).length === 1 && (led.budget.instance || []).length === 1, JSON.stringify(led.budget.identities));

  // OWNER-TYPED TURNS ARE NEVER COUNTED
  const before = (led.budget.instance || []).length;
  w.ar.noteRecovered('sess-2-2', 'user sent a prompt');
  w.eng.noteTurnEnd(w.sessions.get('sess-2-2'));
  w.eng.spendGuard.flush();
  const led2 = JSON.parse(fs.readFileSync(path.join(w.dataDir, 'spend-budget.json'), 'utf8'));
  ok('§4 an OWNER-TYPED prompt (and the turn end it produces) charges nothing (D6)', (led2.budget.instance || []).length === before);
}

// ── §5 THE REAL DELIVERY LADDER ─────────────────────────────────────────────
console.log('\n§5 the delivery ladder: a refusal stashes, an allowed delivery is charged once');
{
  const dataDir = tmpdir('vs-spend-deliver-');
  const settings = { 'spend.unattendedPerIdentityHour': 1 };
  const guard = guardMod.create({
    dataDir, serverSetting: (k) => settings[k],
    identityOf: (s) => (s && s._acct ? { key: s._acct, name: s._acct } : null),
    getUserTodos: () => null, log: () => { },
  });
  const posted = [];
  const sessions = new Map([['w1', { backend: 'claude', mode: 'chat', claudeSessionId: 'cid-1', _acct: 'sub-a', pty: { write() { } } }]]);
  const deliver = deliverMod.create({
    dataDir, activeSessions: sessions,
    peerMsg: { findPeer: (cid) => ({ socketPath: '/tmp/x', name: 'peer' }), postToPeer: async (p, t) => { posted.push(t); return { ok: true }; }, postChannelEvent: async () => ({ ok: false }) },
    getHosts: () => null, getConvIndex: () => null, serverSetting: () => undefined, emitPeerCard: () => { },
    authorizeSpend: (req) => guard.authorize(req), noteSpend: (rec) => guard.note(rec),
    log: () => { },
  });
  const r1 = await deliver.deliverToConversation('cid-1', 'hello', { spendReason: 'job-notification' });
  ok('§5 the first Background Work notification is delivered live', r1.ok === true && posted.length === 1, JSON.stringify(r1));
  const r2 = await deliver.deliverToConversation('cid-1', 'hello again', { spendReason: 'job-notification' });
  ok('§5 the second is REFUSED by the ceiling, with a reason the caller can read', r2.ok === false && r2.refused === 'spend' && /spend budget/.test(r2.reason), JSON.stringify(r2));
  ok('§5 …and nothing was posted for it (the CLI never saw a frame)', posted.length === 1);
  // NOTHING IS LOST: the caller stashes, and the stash is what the next
  // injection drains — the same words, riding a turn that was going to happen.
  deliver.stashFor('cid-1', { source: 'agent', text: 'hello again' });
  ok('§5 the refused message is STASHED and drains into the next injection (a refusal is not a dropped promise)',
    deliver.stashCount('cid-1') === 1 && deliver.drainStash('cid-1')[0].text === 'hello again');
  ok('§5 the jobs engine stashes exactly this shape on a not-ok answer (source pin at the caller)',
    /if \(r && r\.ok\) \{[\s\S]{0,400}\} else \{\s*\n\s*this\._stashNotif\(cid, job, ev,/.test(read('src/jobs.js')));
  const led = guard.snapshot();
  ok('§5 the ledger charged the delivered one ONLY', (led.budget.identities['sub-a'] || []).length === 1, JSON.stringify(led.budget.identities));
}

// ── §5b A DELIVERY THAT OPENS NO TURN IS NOT A SPEND (r2) ───────────────────
// The ladder charged a full unattended turn for EVERY accepted delivery,
// including a notification STEERED into a turn already running — which the
// wrapper folds into that turn (it carries only itself, the queue is untouched)
// and which therefore bills nothing. Twelve mid-turn Background Work
// notifications on one subscription exhausted the default 12/hour ceiling on
// zero turns, and the NEXT auto-resume continue — the one that does cost money
// — was refused with 'hour-cap'. Everything else still charges: claude's
// cli-inbox QUEUES a mid-turn delivery and runs it as its own billed turn, and
// a codex `peer` frame is thread/queue/add, likewise its own turn afterwards.
console.log('\n§5b a steered notification opens no turn, so it spends no budget');
{
  const mkLadder = () => {
    const dataDir = tmpdir('vs-spend-steer-');
    fs.mkdirSync(path.join(dataDir, 'session-buffers'), { recursive: true });
    // the wrapper sidecar the rpc rung gates on (caps.peerMessage)
    fs.writeFileSync(path.join(dataDir, 'session-buffers', 'w1.json'), JSON.stringify({ caps: { peerMessage: true } }));
    const settings = { 'spend.unattendedPerIdentityHour': 12 };
    const guard = guardMod.create({
      dataDir, serverSetting: (k) => settings[k],
      identityOf: () => ({ key: 'slot-A', name: 'Alpha' }),
      getUserTodos: () => null, log: () => { },
    });
    const frames = [];
    const S = {
      backend: 'codex', mode: 'chat', _webuiId: 'w1', backendSessionId: 'cid-1',
      _isStreaming: true, pty: { write: (x) => frames.push(String(x)) }, name: 'busy',
    };
    const sessions = new Map([['w1', S]]);
    const deliver = deliverMod.create({
      dataDir, activeSessions: sessions,
      peerMsg: { findPeer: () => null, postToPeer: async () => ({ ok: false }), postChannelEvent: async () => ({ ok: false }) },
      getHosts: () => null, getConvIndex: () => null, serverSetting: () => undefined, emitPeerCard: () => { },
      authorizeSpend: (req) => guard.authorize(req), noteSpend: (rec) => guard.note(rec), log: () => { },
    });
    const charged = () => (guard.snapshot().budget.identities['slot-A'] || []).length;
    return { deliver, guard, S, frames, charged };
  };
  // the LANE fact this is gated on, read off the caps row (never a backend id)
  ok('§5b codex declares the steer lane for notifications; claude does not',
    notificationDelivery(capsOf('codex')) === 'steer' && notificationDelivery(capsOf('claude')) === 'cli-inbox');

  {   // THE INCIDENT: three notifications into a session that is MID-TURN
    const L = mkLadder();
    for (let i = 0; i < 3; i++) await L.deliver.deliverToConversation('cid-1', 'job ' + i, { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b all three are DELIVERED (this is not a refusal — the message rides the running turn)', L.frames.length === 3);
    ok('§5b …and the ledger charged NOTHING for them (they opened no turn)', L.charged() === 0, String(L.charged()));
    ok('§5b …so the auto-resume continue — a REAL billed turn — is still authorized',
      L.guard.authorize({ reason: 'auto-resume', session: L.S }).ok === true);
    ok('§5b the ladder SAYS it steered, so the caller and the journal can tell the two apart',
      (await L.deliver.deliverToConversation('cid-1', 'job 4', { kind: 'notification', spendReason: 'job-notification' })).steered === true);
  }
  {   // POSITIVE CONTROL 1: the same session, IDLE ⇒ turn/start ⇒ a billed turn
    const L = mkLadder(); L.S._isStreaming = false;
    await L.deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b POSITIVE CONTROL: an IDLE target opens a turn, and it IS charged', L.charged() === 1, String(L.charged()));
  }
  {   // POSITIVE CONTROL 2: a HUMAN peer message queues as its own turn, always
    const L = mkLadder();
    await L.deliver.deliverToConversation('cid-1', 'hi', { kind: 'peer', spendReason: 'peer-message' });
    ok('§5b POSITIVE CONTROL: a human PEER message is charged even mid-turn (queued ⇒ its own turn afterwards)', L.charged() === 1, String(L.charged()));
  }
  {   // POSITIVE CONTROL 3: claude's cli-inbox lane is never treated as free
    const dataDir = tmpdir('vs-spend-steer-cl-');
    const guard = guardMod.create({ dataDir, serverSetting: () => 12, identityOf: () => ({ key: 'slot-A', name: 'Alpha' }), getUserTodos: () => null, log: () => { } });
    const sessions = new Map([['w1', { backend: 'claude', mode: 'chat', claudeSessionId: 'cid-1', _isStreaming: true, pty: { write() { } } }]]);
    const deliver = deliverMod.create({
      dataDir, activeSessions: sessions,
      peerMsg: { findPeer: () => ({ socketPath: '/tmp/x', name: 'p' }), postToPeer: async () => ({ ok: true }), postChannelEvent: async () => ({ ok: false }) },
      getHosts: () => null, getConvIndex: () => null, serverSetting: () => undefined, emitPeerCard: () => { },
      authorizeSpend: (req) => guard.authorize(req), noteSpend: (rec) => guard.note(rec), log: () => { },
    });
    await deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b POSITIVE CONTROL: claude MID-TURN is charged — its CLI queues the delivery and then runs it as its own billed turn',
      (guard.snapshot().budget.identities['slot-A'] || []).length === 1);
  }
  {   // THE SETTLEMENT: the prediction can be wrong, and the wrapper says so
    const L = mkLadder();
    await L.deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b a predicted-free delivery is held UNSETTLED, not silently forgotten', L.deliver._unsettledCount('cid-1') === 1);
    ok('§5b …the wrapper answering `mode:steered` confirms it was free', L.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'steered' }) === 'free' && L.charged() === 0);
    await L.deliver.deliverToConversation('cid-1', 'job2', { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b …but a steer that FELL BACK to the queue really did open a turn, and is charged THEN',
      L.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'queued' }) === 'charged' && L.charged() === 1);
    ok('§5b an unknown conversation settles to nothing (no phantom charges)', L.deliver.settleRpcDelivery('cid-nope', { ok: true, mode: 'queued' }) === null);
  }
  // ── r2 round 2: A MODE-LESS ANSWER IS NOT AN ANSWER ABOUT OUR FRAME ───────
  // Reproduced: a Stop landing between our write and the wrapper's reply emits
  // `peer_message_result {ok:false, text}` ABOUT AN EARLIER queued item, the
  // settlement shifted our pending entry on it, and the real answer — a
  // `thread/queue/add`, a BILLED turn — then found an empty queue and charged
  // nothing. The rule is the PRODUCER's, so the census below derives it.
  {
    const wrapper = read('data/bin/codex-chat-wrapper.js');
    const emitters = [...wrapper.matchAll(/emitTaskEvent\('peer_message_result', \{([^}]*)\}/g)].map((m) => m[1]);
    ok('§5b the wrapper has all six peer_message_result emitters (an unreadable census makes the next two vacuous)',
      emitters.length === 6, String(emitters.length));
    ok('§5b every ok:TRUE answer carries a `mode` — that is what makes it an answer about the frame we just wrote',
      emitters.filter((e) => /ok: true/.test(e)).length === 3 && emitters.filter((e) => /ok: true/.test(e)).every((e) => /mode: '/.test(e)));
    ok('§5b …and every ok:FALSE answer carries `text` and NO mode — two of the three are about a DIFFERENT, earlier message',
      emitters.filter((e) => /ok: false/.test(e)).length === 3
      && emitters.filter((e) => /ok: false/.test(e)).every((e) => /(?:^|[\s,])text\b/.test(e) && !/mode: '/.test(e)),
      JSON.stringify(emitters.filter((e) => /ok: false/.test(e))));
    const L = mkLadder();
    await L.deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b a Stop dropping an EARLIER queued item settles nothing here (it is not about this frame)',
      L.deliver.settleRpcDelivery('cid-1', { ok: false, reason: 'dropped by Stop before it was delivered', text: 'older', mode: null }) === 'not-ours'
      && L.deliver._unsettledCount('cid-1') === 1);
    ok('§5b …so OUR answer still arrives, and a queue-add is charged (PRE-FIX: this stayed at 0 — a billed turn made free)',
      L.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'queued' }) === 'charged' && L.charged() === 1);
  }
  {   // …and the queue holds EVERY frame, so an earlier answer cannot take a later frame's entry
    const L = mkLadder();
    await L.deliver.deliverToConversation('cid-1', 'typed by a human', { kind: 'peer', spendReason: 'peer-message' });      // charged on the spot
    await L.deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });      // predicted free
    ok('§5b both frames are tracked, not only the predicted-free one', L.deliver._unsettledCount('cid-1') === 2 && L.charged() === 1);
    ok('§5b the FIRST answer belongs to the first frame, which was already charged (no second charge)',
      L.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'queued' }) === 'already-charged' && L.charged() === 1);
    ok('§5b …and the notification keeps its own answer: steered ⇒ still free',
      L.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'steered' }) === 'free' && L.charged() === 1);
  }
  {   // a STRANDED frame is dropped, never left to absorb a later message's answer
    const L = mkLadder();
    await L.deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });
    // the wrapper died between our write and its reply; the suite winds the
    // clock forward rather than sleeping through the settle window
    ok('§5b a frame stranded past the settle window is dropped, not charged to the next message',
      L.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'queued', now: Date.now() + 121 * 1000 }) === null && L.charged() === 0);
    const L2 = mkLadder();
    await L2.deliver.deliverToConversation('cid-1', 'job', { kind: 'notification', spendReason: 'job-notification' });
    ok('§5b …CONTROL: the same answer INSIDE the window charges it (the drop is the age, not the answer)',
      L2.deliver.settleRpcDelivery('cid-1', { ok: true, mode: 'queued', now: Date.now() + 119 * 1000 }) === 'charged' && L2.charged() === 1);
  }
  // WIRING PIN: the settlement is reachable from the consumer that already
  // reads this record — an unwired settle would make every fallback free.
  {
    const ce = read('src/server/stdout/codex-events.js');
    ok('§5b WIRING: the codex stdout consumer settles on peer_message_result, by PROPERTY ACCESS on the lazy ref',
      /peer_message_result[\s\S]{0,900}deliverRef\?\.settleRpcDelivery\?\.\(/.test(ce));
    ok('§5b …and the ladder gates on the CAPS ROW, never on a backend id',
      /notificationDelivery\(capsOf\(rpc\.s\.backend\)\) === 'steer'/.test(read('src/server/conversation-deliver.js')));
  }
}

// ── §6 THE REAL STOP-NUDGE ROUTE ────────────────────────────────────────────
console.log('\n§6 the Stop nudge: a persisted cooldown, an exit condition, and the ceiling');
{
  const dataDir = tmpdir('vs-spend-nudge-');
  const settings = { 'agents.stopNudgeStaleMinutes': 0, 'agents.stopNudgeCooldownMinutes': 30, 'spend.unattendedPerIdentityHour': 12 };
  const statuses = new Map();
  const sessions = new Map();
  let guard;
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  const mkGuard = () => guardMod.create({
    dataDir, serverSetting: (k) => settings[k],
    identityOf: () => ({ key: 'sub-a', name: 'Alpha' }), getUserTodos: () => null, log: () => { },
  });
  guard = mkGuard();
  setupAgentRoutes({
    app, activeSessions: sessions, tasks: { list: () => [], forSession: () => [] },
    sessionStatus: { snapshot: () => ({}), get: (k) => statuses.get(k) || null, consumeNotice: () => null, rekey: () => { }, history: () => [] },
    SessionStatusManager: { renderNotice: () => '' },
    userTodos: { rekey: () => { }, forSession: () => [] },
    sessionStatusKey: (s, id) => `claude:${id}`,
    serverSetting: (k) => settings[k],
    spendGuard: { nudgeRec: (k) => guard.nudgeRec(k), noteNudge: (k, o) => guard.noteNudge(k, o), authorize: (r) => guard.authorize(r), note: (r) => guard.note(r) },
    scheduleCtxSync: () => { }, remoteCtxBaseFor: () => null,
  });
  const session = { agentToken: 'vsst_t', backend: 'claude', cwd: dataDir, name: 'conv' };
  sessions.set('s1', session);
  const stopCheck = () => {
    let out;
    routes['GET /api/agent/stop-check']({ headers: { authorization: 'Bearer vsst_t' }, query: {}, body: {} },
      { json: (o) => { out = o; return this; }, status: () => ({ json: (o) => { out = o; } }) });
    return out;
  };
  ok('§6 the first stop nudges', stopCheck().block === true);
  ok('§6 the cooldown holds inside the window', stopCheck().block === false);
  // A RESTART: the live session object is rebuilt (the field is gone), and the
  // persisted record must still hold the cooldown.
  delete session._lastStopNudge;
  guard.flush();
  guard = mkGuard();
  ok('§6 THE COOLDOWN SURVIVES A RESTART (this was an in-memory field only; the instance restarts several times a day)',
    stopCheck().block === false);
  ok('§6 …and the record is on disk under the session-status key', /"claude:s1"/.test(fs.readFileSync(path.join(dataDir, 'spend-budget.json'), 'utf8')));

  // THE EXIT CONDITION, on its OWN session so the count starts at zero (the
  // nudges above already left three unanswered ones on s1 — that IS the
  // mechanism, and reusing it would measure the fixture instead).
  settings['agents.stopNudgeCooldownMinutes'] = 0;   // the owner's own setting on this instance
  settings['agents.stopNudgeMaxUnanswered'] = 3;
  sessions.clear();
  const s2 = { agentToken: 'vsst_t', backend: 'claude', cwd: dataDir, name: 'conv2' };
  sessions.set('s2', s2);
  const n0 = [stopCheck(), stopCheck(), stopCheck()];
  ok('§6 with cooldown 0 it nudges every stop — until the exit condition', n0.every((r) => r.block === true), JSON.stringify(n0.map((r) => r.block)));
  ok('§6 the 4th nudge to a session that has NEVER reported a status is refused (D8 exit condition)', stopCheck().block === false);
  statuses.set('claude:s2', { at: Date.now(), state: 'working' });
  ok('§6 …and a single status report re-opens it (the counter measures "answered", not age)', stopCheck().block === true);

  // THE CEILING
  statuses.clear();
  settings['agents.stopNudgeMaxUnanswered'] = 0;    // exit condition off — isolate the ceiling
  settings['agents.stopNudgeCooldownMinutes'] = 0;
  settings['spend.unattendedPerIdentityHour'] = 1;
  guard.flush(); guard = mkGuard();
  const budgetState = guard.snapshot().budget.identities['sub-a'] || [];
  ok('§6 control: this identity has already spent its (now 1/hour) budget on the nudges above', budgetState.length >= 1);
  ok('§6 the ceiling refuses the nudge — silently to the AGENT (the hook has no "later"), never to the user',
    stopCheck().block === false);
}

// ── §7 OVERAGE ──────────────────────────────────────────────────────────────
console.log('\n§7 paid overage: refused for unattended spend, visible where the owner decides');
{
  const w = mkWorld({ settings: {} });
  const s = w.mkSession('sess-ov-1');
  // the member starts billing paid overage — the CLI's own record
  w.writeCache(w.M1, w.healthy({ overage: { inUse: true, status: 'allowed', asOf: Date.now() }, spend: { used: 4.25, limit: 20, pct: 21 } }));
  w.arm(s); await w.fireDue();
  ok('§7 D3b: the auto-continue is REFUSED while the account bills paid overage', w.fired.length === 0);
  ok('§7 …and the refusal names it (the panel word and the inbox word are the same)',
    w.inbox.some((i) => /paid overage/.test(i.text)), JSON.stringify(w.inbox.map((i) => i.text)));
  ok('§7 …the session stays armed (this is money, not a broken promise)', !!w.ar._armed.get('sess-ov-1'));

  // the opt-in
  const w2 = mkWorld({ settings: { 'spend.allowOverageTurns': true } });
  const s2 = w2.mkSession('sess-ov-2');
  w2.writeCache(w2.M1, w2.healthy({ overage: { inUse: true, asOf: Date.now() } }));
  w2.arm(s2); await w2.fireDue();
  ok('§7 with the explicit opt-in it continues (the setting is the consent)', w2.fired.length === 1);

  // the ONE reader, shared by the engine, the authorizer and the panels
  ok('§7 the engine exposes the ONE overage reader and it agrees with the raw cache',
    w.eng.overageState(w.eng.readRawUsageCache(w.M1)).inUse === 'yes' && w.eng.overageState(w.eng.readRawUsageCache(w.M2)).inUse === 'unknown');
  const um = read('src/lib/usage-meter.js'), ma = read('src/lib/manage-agents.js');
  ok('§7 PANEL: the usage popup renders the overage chip from that same PURE rule',
    /import \{ overageState \} from '\.\.\/spend-authorizer\.js'/.test(um) && /overageChip\(overageState\(snap\)/.test(um));
  ok('§7 PANEL: Manage Agents — where the owner picks a switch target — renders it too (design §1.4: provenance reached one panel of four)',
    /overageChip\(overageState\(u\)/.test(ma) && /acct-usage-overage/.test(ma));
  const chip = require(path.join(REPO, 'src/lib/usage-source.js'));
  ok('§7 the chip says nothing when overage is off/unknown, and says the money when it is on',
    chip.overageChip(A.overageState({ overage: { inUse: false } })) === null
    && /paid overage in use — \$4\.25 \/ \$20\.00/.test(chip.overageChip(A.overageState({ overage: { inUse: true, asOf: Date.now() }, spend: { used: 4.25, limit: 20 } })).label));
  ok('§7 …and it says NOTHING about a record that stopped being refreshed (the chip tip promises a refusal that no longer happens)',
    chip.overageChip(A.overageState({ overage: { inUse: true, asOf: Date.now() - A.OVERAGE_STALE_MS - 1 } })) === null);
}

// ── §8 THE EDF RESERVE FLOOR ────────────────────────────────────────────────
console.log('\n§8 the EDF reserve floor (D2): a voluntary move stops at the floor, an escape does not');
{
  const NOW = 1_800_000_000, H = 3600, D = 86400;
  const acct = (u7, inSec, { u5 = 0 } = {}) => ({ fiveHour: { utilization: u5, resetsAt: NOW + 1800 }, sevenDay: { utilization: u7, resetsAt: NOW + inSec } });
  const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const run = (caches, opts = {}) => decidePoolSwitch({ currentId: 'b', members, readCache: (id) => caches[id] ?? null, nowSec: NOW, proactive: true, hot: true, explain: true, ...opts });
  const caches = { b: acct(0.54, 6 * D), a: acct(0.88, 12 * H) };
  ok('§8 CONTROL (the repurposed test-pool-auto:85-88 pin): with NO floor, an 88%-consumed member with the sooner deadline IS a proactive target',
    run(caches, { reserveFloorPct: 0 }).to === 'a');
  const held = run(caches, { reserveFloorPct: 15 });
  ok('§8 with the 15% floor it is not — and the verdict NAMES what it held back', held.to === null && held.reserveBlocked?.[0]?.id === 'a' && held.reserveFloorPct === 15, JSON.stringify(held).slice(0, 200));
  ok('§8 …the floor is measured on the WEEKLY budget, not on the 5h burst limiter (a member at 90% weekly / 20% 5h is a fine target)',
    run({ b: acct(0.54, 6 * D), a: acct(0.10, 12 * H, { u5: 0.80 }) }, { reserveFloorPct: 15 }).to === 'a');
  // P6: a member with NO weekly reading is not barred — and the leg is built so
  // only the floor can decide it (a soft-exhausted current member, one
  // candidate below the floor and one with no weekly bucket at all).
  const three = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const noWeekly = { fiveHour: { utilization: 0.5, resetsAt: NOW + 1800 } };
  const soft = decidePoolSwitch({
    currentId: 'b', members: three, nowSec: NOW, proactive: false, hot: true, reserveFloorPct: 15, explain: true,
    readCache: (id) => ({ b: acct(0.96, 6 * D), a: noWeekly, c: acct(0.88, 12 * H) })[id] ?? null,
  });
  ok('§8 …and an UNKNOWN weekly reading is never barred (P6: ignorance is not a claim) while the 12%-weekly sibling is',
    soft.to === 'a' && !(soft.reserveBlocked || []).some((m) => m.id === 'a'), JSON.stringify(soft).slice(0, 220));
  // THE ESCAPE: current member hard-dead, the only candidate is below the floor
  const esc = decidePoolSwitch({ currentId: 'b', members, readCache: (id) => ({ b: acct(0.999, 6 * D), a: acct(0.88, 12 * H) })[id] ?? null, nowSec: NOW, proactive: true, hot: true, reserveFloorPct: 15, explain: true });
  ok('§8 an ESCAPE from a hard-dead member ignores the floor (liveness beats efficiency) and SAYS where it landed',
    esc.to === 'a' && esc.toReserve?.id === 'a' && esc.reason === 'exhausted', JSON.stringify(esc).slice(0, 200));
  // the overage bar, same shape
  const ovr = run(caches, { reserveFloorPct: 0, overageIds: ['a'] });
  ok('§8 D3c: an overage member is barred from a voluntary move and named separately (dollars, not a spent window)',
    ovr.to === null && ovr.overageBlocked?.[0]?.id === 'a' && !ovr.reserveBlocked, JSON.stringify(ovr).slice(0, 160));
  const ovrEsc = decidePoolSwitch({ currentId: 'b', members, readCache: (id) => ({ b: acct(0.999, 6 * D), a: acct(0.2, 12 * H) })[id] ?? null, nowSec: NOW, proactive: true, hot: true, overageIds: ['a'], explain: true });
  ok('§8 …and the escape still uses it, saying so', ovrEsc.to === 'a' && ovrEsc.toOverage?.id === 'a');
  // the sentence
  const { poolBlockedNotice } = require(path.join(REPO, 'src/account-pool-auto.js'));
  const sentence = poolBlockedNotice(held, { poolName: 'All', currentName: 'B' });
  ok('§8 the blocked notice says the SPENDING limit, not "out of quota" (which prescribes waiting for a reset)',
    /held back by your spending limits/i.test(sentence) && /15% reserve floor/.test(sentence) && !/out of quota/.test(sentence), sentence);
  const quotaWall = poolBlockedNotice(run({ b: acct(0.99, 6 * D), a: acct(0.995, 12 * H) }, { reserveFloorPct: 15 }), { poolName: 'All', currentName: 'B' });
  ok('§8 CONTROL: a quota-emptied list still says the quota sentence, verbatim as before', /no member can serve it — spent:/.test(quotaWall), quotaWall);
  ok('§8 the engine reads both bars from SETTINGS and hands them to the pure decision',
    /reserveFloorPct: reserveFloorPct\(\), overageIds: overageMemberIds\(/.test(read('src/server/usage-pool-engine.js')));
  const w = mkWorld({ settings: {} });
  ok('§8 the shipped default floor is 15% (D2), read per decision', w.eng.reserveFloorPct() === 15);
  const w0 = mkWorld({ settings: { 'pool.reserveFloorPct': 0 } });
  ok('§8 …and 0 turns it off (the pre-2026-09 behaviour, one setting away)', w0.eng.reserveFloorPct() === 0);
}

// ── §9 FAIL CLOSED ──────────────────────────────────────────────────────────
console.log('\n§9 fail closed: an authorizer that throws spends nothing (P8)');
{
  // (a) auto-resume
  const root = tmpdir('vs-spend-fc-');
  const sessions = new Map();
  const fired = [];
  const ar = arMod.create({
    dataDir: root, activeSessions: sessions, serverSetting: () => true, log: () => { },
    sendToSession: (id, s, text) => { fired.push(id); return true; },
    fireIdentity: () => ({ key: 'k', name: 'K' }),
    authorizeSpend: () => { throw new Error('boom'); },
  });
  const s = { backend: 'claude', mode: 'chat', _webuiId: 'x1', _autoResume: true, name: 'c' };
  sessions.set('x1', s);
  ar.armIfEnabled('x1', s, Date.now() + 60_000, 'usage limit');
  ar.tick(Date.now() + 120_000);
  await tick(40);
  ok('§9 auto-resume: a throwing authorizer refuses the continue', fired.length === 0);
  ok('§9 …and the arm survives (the promise is intact; it is the money that is unavailable)', !!ar._armed.get('x1'));

  // (b) the delivery ladder
  const dd = tmpdir('vs-spend-fc2-');
  const posted = [];
  const deliver = deliverMod.create({
    dataDir: dd, activeSessions: new Map(),
    peerMsg: { findPeer: () => ({ socketPath: '/x' }), postToPeer: async () => { posted.push(1); return { ok: true }; }, postChannelEvent: async () => ({ ok: false }) },
    getHosts: () => null, getConvIndex: () => null, serverSetting: () => undefined, emitPeerCard: () => { },
    authorizeSpend: () => { throw new Error('boom'); }, noteSpend: () => { }, log: () => { },
  });
  const r = await deliver.deliverToConversation('cid-x', 'hi', { spendReason: 'peer-message' });
  ok('§9 the ladder: a throwing authorizer delivers nothing and says why (the caller stashes)',
    r.ok === false && r.refused === 'spend' && posted.length === 0, JSON.stringify(r));

  // (c) the pre-fire gate itself — design §1.4 named BOTH sites as failing OPEN
  ok('§9 the pre-fire gate fails CLOSED in the engine (was `catch { return true; }`)',
    /refusing the continue \(fail closed\)[\s\S]{0,200}return false;/.test(read('src/server/usage-pool-engine.js')));
  ok('§9 …and at the wiring site in server.js (one alone stayed green: a throw was answered with a billed turn at BOTH layers)',
    /beforeFire: \(id, s\) => \{ try \{ return beforeAutoResumeFire\(id, s\); \} catch \(e\) \{[^}]*return false; \} \}/.test(read('server.js')));
  const engSrc = read('src/server/usage-pool-engine.js');
  const gateAt = engSrc.indexOf('async function beforeAutoResumeFire');
  const gateEnd = engSrc.indexOf('\nfunction ', gateAt);   // the next top-level declaration
  const gateBody = gateAt >= 0 && gateEnd > gateAt ? engSrc.slice(gateAt, gateEnd) : '';
  // SCOPED, and comments stripped first: server.js has an UNRELATED and correct
  // `catch { return true; }` (the Integration master switch defaults ON), so the
  // control names the beforeFire wiring itself; and the fix's own comment QUOTES
  // the retired shape
  // (that is how the next reader learns what it replaced), and a census that
  // reads its own documentation as a violation would force the explanation out.
  const code = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('§9 NEGATIVE CONTROL: master\'s shape (`catch { return true; }`) is gone from BOTH sites — read on the gate\'s own body, not a window',
    gateBody.length > 200 && !/catch \{ return true; \}/.test(code(gateBody)) && !/beforeAutoResumeFire\(id, s\); \} catch \{ return true; \}/.test(code(read('server.js'))));

  // (d) the codex reset credit — THE PRODUCTION SHAPE, with a positive control.
  // r2 found this leg vacuous TWICE OVER: it passed `{method:'task_failed',
  // params:{error:{message:…}}}`, which matches no branch at all (the engine
  // switches on `payload.type` and src/harnesses/codex-quota.js requires
  // `payload.codexErrorInfo` matching EXHAUSTION_RE), so `!WROTE` was true for
  // a reason unrelated to the ceiling — and mkWorld builds the engine exactly
  // as server.js does, i.e. WITHOUT the authorizeSpend dep the gate then
  // depended on. Both halves are now driven: the real exhaustion payload, and
  // a positive control proving the path is REACHED when the budget allows it.
  const resetPayload = () => ({ type: 'task_failed', codexErrorInfo: 'usage_limit_reached', resetsAt: Math.floor(Date.now() / 1000) + 7200 });
  const creditWorld = (hour) => {
    const w2 = mkWorld({ settings: { 'codex.limitResetCredit': 'auto', 'spend.unattendedPerIdentityHour': hour } });
    const wrote = [];
    const s2 = { backend: 'codex', mode: 'chat', _webuiId: 'cx1', _accountId: w2.P, pty: { write: (x) => wrote.push(String(x)) }, name: 'cx' };
    w2.sessions.set('cx1', s2);
    w2.eng.recordCodexQuotaSignal(s2, resetPayload());
    return { w: w2, spent: wrote.some((x) => /codex-reset-credit/.test(x)) };
  };
  const allowed = creditWorld(100);
  ok('§9 POSITIVE CONTROL: the reset-credit path is REACHED — with budget the credit IS spent (an unreached path proves nothing)',
    allowed.spent === true);
  const denied = creditWorld(0);
  ok('§9 the codex reset credit is under the same ceiling (0/hour ⇒ no credit is spent), in the shape server.js builds',
    denied.spent === false);
  // and the LEDGER agrees with the pty in both directions (an assertion about
  // the frame alone cannot tell "refused" from "charged but never written")
  allowed.w.eng.spendGuard.flush(); denied.w.eng.spendGuard.flush();
  const ledOf = (w2) => { try { return JSON.parse(fs.readFileSync(path.join(w2.dataDir, 'spend-budget.json'), 'utf8')); } catch { return { budget: { instance: [] } }; } };
  ok('§9 …and the ledger CHARGED the credit that was spent and charged nothing for the one refused',
    (ledOf(allowed.w).budget.instance || []).length === 1 && (ledOf(denied.w).budget.instance || []).length === 0,
    JSON.stringify({ allowed: (ledOf(allowed.w).budget.instance || []).length, denied: (ledOf(denied.w).budget.instance || []).length }));
}

console.log(`\n${fail ? fail + ' FAILED' : 'ALL PASS'} (${pass})`);
process.exit(fail ? 1 : 0);
