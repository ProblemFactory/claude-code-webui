#!/usr/bin/env node
// THE TYPED QUOTA MODEL (src/quota-model.js) + THE ONE WRITE PATH
// (src/usage-cache-write.js) + the per-harness typed producers.
//
// The three incidents this suite exists for, each with the measurement that
// produced its fixture (all taken from this instance's own session buffers and
// usage-cache, anonymised — no ids, no emails, no tokens):
//
//  B-9213  the codex app-server pushes ONE rate_limits_updated PER LIMIT and we
//          collapsed them into one cache file. Measured on sess-13 (one
//          conversation, 208 pushes): `codex` 32× (plan, 10080min, 5 %…100 %),
//          `codex_bengalfox`/"GPT-5.3-Codex-Spark" 149× (300+10080min, 0 %/0 %),
//          `premium` 27× (no windows at all). The file on disk held the SPARK
//          limit and the plan limit was gone.
//  B-8b12  an EMPTY window reports resetsAt = now + windowDuration at every
//          read. Measured over 328 empty readings: elapsed-into-window ∈
//          [8 s, 489 s]; over 125 running readings: ≥ 1151 s. A 662-second dead
//          band, and `EMPTY_WINDOW_JITTER_SEC` sits inside it.
//  (c)     claude's model-scoped cap exists for one family and lives in a
//          `scopedWeekly[]` array; codex has no such shape. Every reader
//          special-cased both.
//
// Run: node scripts/test-quota-model.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QM = require(path.join(ROOT, 'src/quota-model.js'));
const W = require(path.join(ROOT, 'src/usage-cache-write.js'));
const CODEXQ = require(path.join(ROOT, 'src/harnesses/codex-quota.js'));
const CLAUDEQ = require(path.join(ROOT, 'src/harnesses/claude-quota.js'));
const NULLQ = require(path.join(ROOT, 'src/harnesses/null-quota.js'));
const { familyOfScopedBucket } = require(path.join(ROOT, 'src/model-family.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
// scratch dirs this suite makes (mkdtemp, never a fixed /tmp name — the fast tier
// forbids a suite claiming a machine-global path); swept on exit so a run that
// drives the shipped tool repeatedly does not leave a directory per assert.
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } });
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}`);

// ── the CORPUS: real payload shapes, anonymised ─────────────────────────────
// Captured verbatim from data/session-buffers/sess-13-*.buf and sess-4-*.buf
// (the owner's own codex conversations) with nothing but the timestamps
// re-based. These are the three limits, in the order they arrive.
const T0 = 1788900000000; // the arrival instant the windows below were measured at
const CODEX_PREMIUM = { limitId: 'premium', limitName: null, primary: null, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null };
const CODEX_PLAN = { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1789509325 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null };
const CODEX_PLAN_FULL = { ...CODEX_PLAN, primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789356983 } };
// The Spark limit's sliding reset: resetsAt === measuredAt + window − 40 s
// (the measured median offset over 328 real readings).
const sparkAt = (ms) => ({
  limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
  primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.round(ms / 1000) + 300 * 60 - 40 },
  secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: Math.round(ms / 1000) + 10080 * 60 - 40 },
  credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null,
  spendControlReached: null, planType: 'pro', rateLimitReachedType: null,
});

console.log('\n① the VALIDATOR refuses what the readers cannot read');
{
  const good = QM.makeLimitSet({ identity: 'sub-x', fetchedAt: T0, source: 'test', limits: [QM.makeLimit({ limitId: 'plan', scope: 'plan', windows: [QM.makeWindow({ kind: '7d', usedPct: 40, resetsAt: 1789509325, measuredAt: T0 })] })] });
  ok(QM.validateLimitSet(good).ok, 'a well-formed set validates');
  ok(!QM.validateLimitSet(null).ok, 'null is not a set');
  ok(!QM.validateLimitSet({ limits: 'nope' }).ok, 'limits must be an array');
  const dup = { ...good, limits: [good.limits[0], good.limits[0]] };
  const vd = QM.validateLimitSet(dup);
  ok(!vd.ok && /duplicate/.test(vd.errors.join(' ')), 'two records for one limitId is a duplicate, named');
  const badScope = { ...good, limits: [{ ...good.limits[0], scope: 'whatever' }] };
  ok(!QM.validateLimitSet(badScope).ok, 'an unknown scope is refused (the closed set is the contract)');
  const badPct = { ...good, limits: [{ ...good.limits[0], windows: [{ ...good.limits[0].windows[0], usedPct: 140 }] }] };
  ok(!QM.validateLimitSet(badPct).ok, 'usedPct outside 0..100 is refused');
  const badState = { ...good, limits: [{ ...good.limits[0], windows: [{ ...good.limits[0].windows[0], state: 'maybe' }] }] };
  ok(!QM.validateLimitSet(badState).ok, 'an unknown window state is refused');
  const dupKind = { ...good, limits: [{ ...good.limits[0], windows: [good.limits[0].windows[0], good.limits[0].windows[0]] }] };
  ok(!QM.validateLimitSet(dupKind).ok, 'two windows of one kind inside one limit is refused');
  ok(QM.validateLimitSet(QM.makeLimitSet({})).ok, 'an EMPTY set is valid — "this harness has no limits" is a statement');
}

console.log('\n② windowState: an empty window is a sliding reset, not a deadline (B-8b12)');
{
  // the measured shape, at the median offset and at both measured extremes
  for (const off of [8, 40, 489]) {
    const w = QM.makeWindow({ kind: '5h', minutes: 300, usedPct: 0, resetsAt: Math.round(T0 / 1000) + 300 * 60 - off, measuredAt: T0 });
    ok(w.state === 'empty', `usedPct 0 with the reset ${off}s inside a full window ⇒ empty (measured range was 8–489 s)`);
  }
  // the +3 s drift fixture: two reads three seconds apart, both empty, and the
  // reset MOVED — which is the whole reason it may not be a deadline
  const a = QM.makeWindow({ kind: '5h', minutes: 300, usedPct: 0, resetsAt: Math.round(T0 / 1000) + 18000 - 40, measuredAt: T0 });
  const b = QM.makeWindow({ kind: '5h', minutes: 300, usedPct: 0, resetsAt: Math.round((T0 + 3000) / 1000) + 18000 - 40, measuredAt: T0 + 3000 });
  ok(a.state === 'empty' && b.state === 'empty', '+3 s apart, both reads are empty');
  ok(b.resetsAt - a.resetsAt === 3, '…and the "reset time" moved by exactly the 3 s between the reads');
  // the running side of the measured dead band
  for (const off of [1017, 1146, 11611, 35037]) {
    const w = QM.makeWindow({ kind: '7d', minutes: 10080, usedPct: 0, resetsAt: Math.round(T0 / 1000) + 10080 * 60 - off, measuredAt: T0 });
    ok(w.state === 'running', `a reset PINNED ${off}s into the window ⇒ running, even at 0 % used (measured min was 1151 s)`);
  }
  ok(QM.makeWindow({ kind: '7d', usedPct: 42, resetsAt: 1789509325, measuredAt: T0 }).state === 'running', 'anything spent is running');
  ok(QM.makeWindow({ kind: '7d', usedPct: 0, resetsAt: null, measuredAt: T0 }).state === 'unknown', 'no reset stated ⇒ unknown, never "empty" and never a deadline');
  ok(QM.makeWindow({ kind: '7d', usedPct: null, resetsAt: 1789509325, measuredAt: T0 }).state === 'unknown', 'no usage stated ⇒ unknown');
  ok(QM.makeWindow({ kind: 'monthly', minutes: 0, usedPct: 0, resetsAt: 1789509325, measuredAt: T0 }).state === 'unknown', 'no duration to compare against ⇒ unknown, we do not guess');
  ok(QM.EMPTY_WINDOW_JITTER_SEC > 489 && QM.EMPTY_WINDOW_JITTER_SEC < 1017, 'the jitter constant sits inside the measured dead band (489 s empty max … 1017 s running min)');
}

console.log('\n③ limitFor: the ONE accessor, never a collapsed guess');
{
  const set = QM.mergeLimitSets(
    CODEXQ.toLimitSet(CODEX_PLAN, { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 }),
    CODEXQ.toLimitSet(sparkAt(T0 + 1000), { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 + 1000 }));
  ok(QM.limitFor(set, {}).limitId === 'codex', 'no model named ⇒ the PLAN limit');
  ok(QM.limitFor(set, { model: 'GPT-5.3-Codex-Spark' }).limitId === 'codex_bengalfox', 'the served model names its own limit');
  ok(QM.limitFor(set, { model: 'gpt-5.3-codex' }).limitId === 'codex', 'a model no limit names falls back to the plan limit, never to "some model limit"');
  ok(QM.limitFor(QM.makeLimitSet({}), {}) === null, 'an empty set says NOTHING — null, not a fabricated limit');
  // claude: family matching through the injected vocabulary
  const cl = CLAUDEQ.toLimitSet({ fiveHour: { utilization: 0.5, resetsAt: 1788924600 }, sevenDay: { utilization: 0.78, resetsAt: 1789318800 }, scopedWeekly: [{ name: 'Fable', utilization: 0.89, resetsAt: 1789318800 }], fetchedAt: T0 }, { identity: 'sub-a', source: 'on-demand', nowMs: T0, familyOf: familyOfScopedBucket });
  ok(QM.limitFor(cl, { family: 'fable' }).name === 'Fable', 'a claude scoped weekly is found by FAMILY');
  ok(QM.limitFor(cl, { family: 'opus' }).limitId === 'plan', 'a family with no scoped cap gets the plan limit');
  eq(QM.applicableLimits(cl, { family: 'fable' }).map((l) => l.limitId), ['plan', 'model:fable'], 'both limits constrain a fable spend (a model cap is a COMPONENT of the plan window)');
}

console.log('\n④ mergeLimitSets merges PER limitId — the B-9213 fixture');
{
  // the real arrival order on sess-13: premium, then Spark, then the plan limit
  let set = QM.makeLimitSet({ identity: '__global_codex__' });
  const seq = [
    ['premium', CODEX_PREMIUM, T0],
    ['spark', sparkAt(T0 + 1000), T0 + 1000],
    ['plan', CODEX_PLAN, T0 + 2000],
    ['spark again (3 s later, the reset has slid)', sparkAt(T0 + 4000), T0 + 4000],
  ];
  for (const [, raw, at] of seq) {
    set = QM.mergeLimitSets(set, CODEXQ.toLimitSet(raw, { identity: '__global_codex__', source: 'codex-rate-limits', fetchedAt: at }));
  }
  eq(set.limits.filter((l) => l.scope === 'plan' || l.scope === 'model').map((l) => l.limitId), ['premium', 'codex_bengalfox', 'codex'], 'THREE quota limits survive the sequence, in arrival order');
  ok(set.limits.some((l) => l.limitId === 'credits' && l.scope === 'credits'), '…plus the credits limit every push carries (money, not quota — its own scope)');
  ok(QM.limitFor(set, {}).limitId === 'codex', 'the plan limit is still the plan limit after 2 Spark pushes');
  eq(QM.windowOfKind(QM.limitFor(set, {}), '7d').usedPct, 5, 'the plan limit still reads 5 % — the Spark push was not news about it');
  ok(QM.limitState(set.limits[0]) === 'unknown', '`premium` reports no windows at all (27/27 measured pushes) and is kept as such');
  ok(QM.planLimit(set).limitId === 'codex', 'a window-less plan limit never displaces the one that reports windows');
  // NEGATIVE CONTROL: the old single-object merge
  const collapsed = [CODEX_PREMIUM, sparkAt(T0 + 1000), CODEX_PLAN, sparkAt(T0 + 4000)]
    .map((r) => CODEXQ.normalizeCodexRateLimit(r, T0))
    .filter(Boolean)
    .reduce((acc, s) => ({ ...acc, ...s })); // last-writer-wins, verbatim
  ok(collapsed.limitId === 'codex_bengalfox' && collapsed.sevenDay.usedPercent === 0,
    'NEGATIVE CONTROL: last-writer-wins ends on the Spark limit at 0 % — the plan limit at 5 % is GONE (the incident)');
  // panel view names all three
  const ordered = QM.orderLimits(set, { model: 'GPT-5.3-Codex-Spark' });
  eq(ordered.slice(0, 3).map((l) => QM.limitLabel(l)), ['GPT-5.3-Codex-Spark', 'codex', 'premium'], 'the panel view names all three, served model first');
  ok(ordered.length === set.limits.length, '…and nothing is dropped from the view');
}

console.log('\n⑤ remaining/deadline IGNORE empty windows');
{
  let set = QM.mergeLimitSets(
    CODEXQ.toLimitSet(CODEX_PLAN, { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 }),
    CODEXQ.toLimitSet(sparkAt(T0 + 1000), { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 + 1000 }));
  const nowSec = Math.round(T0 / 1000);
  const r = QM.remaining(set, { nowSec });
  ok(r.known && r.remaining === 95 && r.by === 'codex', 'remaining = the PLAN limit (95 %), never the empty Spark bucket');
  const d = QM.deadline(set, { nowSec });
  ok(d === 1789509325, 'the deadline is the plan window\'s pinned reset, NOT the Spark bucket\'s sliding one');
  const sparkLimit = set.limits.find((l) => l.limitId === 'codex_bengalfox');
  ok(d !== QM.windowOfKind(sparkLimit, '7d').resetsAt, '…and the Spark bucket\'s "reset" is a different (nearer) number, which is exactly the trap');
  // a Spark 0 % bucket never grants headroom the plan bucket lacks
  let dead = QM.mergeLimitSets(
    CODEXQ.toLimitSet(CODEX_PLAN_FULL, { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 }),
    CODEXQ.toLimitSet(sparkAt(T0 + 1000), { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 + 1000 }));
  const rd = QM.remaining(dead, { nowSec });
  ok(rd.known && rd.remaining === 0, 'plan limit at 100 % + Spark at 0 % ⇒ 0 % remaining (a Spark bucket never grants headroom the plan lacks)');
  ok(rd.by === 'codex', '…and it names WHICH limit is spent');
  const rep = QM.bucketReport(dead, { nowSec });
  const spark7 = rep.find((x) => x.limitId === 'codex_bengalfox' && x.kind === '7d');
  ok(spark7 && spark7.state === 'empty' && spark7.counts === false && spark7.resetsAt === 0,
    'the report SHOWS the empty bucket (the panel must) but marks it counts:false with no reset to print');
  // the 5h window is a burst rate limiter, never a budget deadline
  const withBurst = QM.mergeLimitSets(set, CLAUDEQ.limitSetFromEvent({ kind: 'fiveHour', utilization: 0.9, resetsAt: nowSec + 600, status: 'allowed' }, { identity: 'cx', nowMs: T0 }));
  ok(QM.deadline(withBurst, { nowSec }) === 1789509325, 'a 5h window never becomes the budget deadline (it refills ~33×/week)');
}

console.log('\n⑥ the claude producers: three shapes, one typed set');
{
  const panel = CLAUDEQ.toLimitSet({
    fiveHour: { utilization: 0.11, resetsAt: 1788924000, status: 'allowed' },
    sevenDay: { utilization: 0.95, resetsAt: 1789142400, status: 'allowed_warning' },
    scopedWeekly: [{ name: 'Fable', utilization: 0.94, resetsAt: 1789142400, severity: 'normal' }],
    spend: { used: 12.5, limit: 100, pct: 12.5, currency: 'USD', resetsAt: 1790000000 },
    fetchedAt: T0, orgUuid: 'REDACTED',
  }, { identity: 'sub-a', source: 'on-demand', nowMs: T0, familyOf: familyOfScopedBucket });
  eq(panel.limits.map((l) => l.limitId), ['plan', 'model:fable', 'overage'], 'the /usage panel becomes plan + one model limit + an overage limit');
  ok(panel.limits[1].family === 'fable', 'the scoped bucket carries its FAMILY (injected vocabulary, never guessed in the pure model)');
  ok(panel.limits[2].scope === 'overage' && panel.limits[2].flags.used === 12.5, 'extra usage is its OWN limit with real dollars on it (design §1.4: zero readers today)');
  ok(panel.extra && panel.extra.orgUuid === 'REDACTED', 'the identity fields ride `extra` and are never lost');
  // ONE rate_limit_event = ONE limit, ONE window
  const ev = CLAUDEQ.limitSetFromEvent({ kind: 'sevenDay', utilization: 0.5, resetsAt: 1789142400, status: 'allowed', overage: { inUse: false } }, { identity: 'sub-a', nowMs: T0 + 1000 });
  eq(ev.limits.map((l) => [l.limitId, l.windows.map((w) => w.kind)]), [['plan', ['7d']], ['overage', []]], 'a rate_limit_event carries exactly one bucket (plus its overage state)');
  const after = QM.mergeLimitSets(panel, ev);
  eq(QM.windowOfKind(QM.limitFor(after, {}), '5h').usedPct, 11, 'merging a 7d-only event does NOT erase the 5h window (the per-bucket apply this replaces had to hand-preserve it)');
  eq(QM.windowOfKind(QM.limitFor(after, {}), '7d').usedPct, 50, '…and the 7d window took the newer reading');
  eq(QM.limitFor(after, { family: 'fable' }).windows[0].usedPct, 94, '…and the Fable cap is untouched (this is the field that has been lost five times)');
  const rej = CLAUDEQ.limitSetFromEvent({ kind: 'sevenDay', status: 'rejected', resetsAt: 1789142400 }, { identity: 'sub-a', nowMs: T0 });
  eq(rej.limits[0].windows[0].usedPct, 100, 'a REJECTION is a reading of 100 %');
  ok(rej.limits[0].windows[0].status === 'limited', '…and states the limited status');
  const scoped = CLAUDEQ.limitSetFromEvent({ kind: 'scoped', scopedName: 'fable', utilization: 0.7, resetsAt: 1789142400 }, { identity: 'sub-a', nowMs: T0, familyOf: familyOfScopedBucket });
  ok(scoped.limits[0].scope === 'model' && scoped.limits[0].family === 'fable', 'a seven_day_<model> event becomes a MODEL limit');
  ok(CLAUDEQ.toLimitSet('not a usage panel', { nowMs: T0 }) === null, 'a payload that is not a claude reading returns null — never a fabricated set');
}

console.log('\n⑦ the null harness answers the same questions');
{
  const set = NULLQ.NULL_QUOTA.toLimitSet({ identity: 'shell-1', source: 'none', fetchedAt: T0 });
  ok(QM.validateLimitSet(set).ok, 'the null harness produces a VALID empty set (not null — every reader asks the same questions)');
  ok(QM.limitFor(set, {}) === null && QM.remaining(set, {}).known === false && QM.deadline(set, {}) === null, 'and every accessor answers "no claim"');
}

console.log('\n⑧ the ONE write path: per-limit merge on disk, derived legacy view');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsq-write-'));
  const key = '__global_codex__';
  const seq = [[CODEX_PREMIUM, T0], [sparkAt(T0 + 1000), T0 + 1000], [CODEX_PLAN, T0 + 2000], [sparkAt(T0 + 4000), T0 + 4000]];
  for (const [raw, at] of seq) {
    const set = CODEXQ.toLimitSet(raw, { identity: key, source: 'codex-rate-limits', fetchedAt: at });
    const r = W.writeReading({ cacheDir: dir, key, set, source: 'codex-rate-limits', backend: 'codex' });
    ok(r.ok, `wrote ${raw.limitId} @${at - T0}ms`);
  }
  const obj = W.readCacheObject(dir, key);
  eq(obj.limits.filter((l) => l.scope !== 'credits').map((l) => l.limitId), ['premium', 'codex_bengalfox', 'codex'], 'the FILE holds all three quota limits');
  eq(obj.sevenDay.usedPercent, 5, 'the DERIVED legacy view shows the PLAN limit — a legacy reader no longer flips to 0 %');
  ok(obj.scopedWeekly && obj.scopedWeekly[0].name === 'GPT-5.3-Codex-Spark' && obj.scopedWeekly[0].state === 'empty',
    'the Spark limit is projected as a model cap AND carries state:"empty" so no reader counts its sliding reset');
  ok(obj.source === 'codex-rate-limits', 'a producer WE SHIP names itself at the write');
  ok(obj.limits.every((l) => l.source === 'codex-rate-limits' && l.fetchedAt), 'provenance is stamped PER LIMIT');
  // a re-read is a stable round trip
  const lifted = W.limitsOfCache(obj);
  eq(lifted.limits.filter((l) => l.scope !== 'credits').map((l) => l.limitId), ['premium', 'codex_bengalfox', 'codex'], 'lifting the file back gives the same three limits');
  ok(QM.limitFor(lifted, {}).limitId === 'codex', '…and the accessor still answers with the plan limit');
  ok(QM.deadline(lifted, { nowSec: Math.round(T0 / 1000) }) === 1789509325, '…and the deadline is still the plan window (empty windows survive the round trip as empty)');

  // a malformed producer set is REFUSED, and the file is untouched
  const before = fs.readFileSync(W.cacheFileFor(dir, key), 'utf8');
  let refused = null;
  const bad = QM.makeLimitSet({ identity: key, fetchedAt: T0, source: 'x', limits: [{ limitId: 'plan', scope: 'nonsense', windows: [] }] });
  const rb = W.writeReading({ cacheDir: dir, key, set: bad, source: 'x', onRefuse: (why) => { refused = why; } });
  ok(!rb.ok && refused, 'a malformed set is REFUSED loudly (our own producer being wrong is a bug we do not persist)');
  ok(fs.readFileSync(W.cacheFileFor(dir, key), 'utf8') === before, '…and the stored file is byte-identical');

  // a CORRUPT file on disk must not block a new reading
  fs.writeFileSync(W.cacheFileFor(dir, 'corrupt'), JSON.stringify({ fetchedAt: T0, limits: [{ limitId: 'p', scope: 'bogus', windows: [] }] }));
  const rc = W.writeReading({ cacheDir: dir, key: 'corrupt', set: CODEXQ.toLimitSet(CODEX_PLAN, { identity: 'corrupt', source: 'codex-rate-limits', fetchedAt: T0 }), source: 'codex-rate-limits', backend: 'codex' });
  ok(rc.ok, 'a corrupt file already on disk does not block a new reading (one bad write must never be permanent)');
  eq(W.readCacheObject(dir, 'corrupt').limits.map((l) => l.limitId), ['codex', 'credits'], '…and the canonical half is rebuilt from the reading');

  // legacy file (no `limits`) merges correctly
  fs.writeFileSync(W.cacheFileFor(dir, 'sub-legacy'), JSON.stringify({
    fiveHour: { utilization: 0.58, resetsAt: 1788924600 },
    sevenDay: { utilization: 0.78, resetsAt: 1789318800, status: 'allowed_warning' },
    scopedWeekly: [{ name: 'Fable', utilization: 0.89, resetsAt: 1789318800 }],
    fetchedAt: T0, source: 'rate-limit-event', orgUuid: 'REDACTED',
  }));
  const evSet = CLAUDEQ.limitSetFromEvent({ kind: 'fiveHour', utilization: 0.6, resetsAt: 1788925000, status: 'allowed' }, { identity: 'sub-legacy', nowMs: T0 + 5000 });
  const rl = W.writeReading({ cacheDir: dir, key: 'sub-legacy', set: evSet, extras: { orgUuid: 'REDACTED' }, source: 'rate-limit-event', backend: 'claude', familyOf: familyOfScopedBucket });
  ok(rl.ok, 'a 5h-only event writes onto a pre-model legacy file');
  const lo = W.readCacheObject(dir, 'sub-legacy');
  eq([lo.fiveHour.utilization, lo.sevenDay.utilization, lo.scopedWeekly[0].name], [0.6, 0.78, 'Fable'],
    'the 5h moved, the 7d and the Fable cap were carried forward — the lift + per-limit merge does what nine hand-written preserve lists were doing');
  ok(lo.orgUuid === 'REDACTED', 'the org identity survives');

  // the sidecar rule
  ok(W.writeSidecar(dir, '.window-sub-legacy', { sevenDay: 1789318800 }), 'a sidecar writes beside the cache');
  let threw = null; try { W.writeSidecar(dir, 'thing.json', {}); } catch (e) { threw = e.message; }
  ok(threw && /\.json/.test(threw), 'a sidecar may never end in .json (every usage-cache scanner would pick it up)');
  ok(!W.isCacheFileName('.window-sub-legacy') && W.isCacheFileName('sub-legacy.json'), 'isCacheFileName tells snapshots from sidecars');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n⑨ backend shape detection is by FIELDS, never by key name');
{
  ok(W.backendOfCacheObject({ limitId: 'codex', fiveHour: { usedPercent: 5, windowMinutes: 300 } }) === 'codex', 'limitId ⇒ codex');
  ok(W.backendOfCacheObject({ fiveHour: { utilization: 0.5 }, scopedWeekly: [] }) === 'claude', 'scopedWeekly ⇒ claude');
  ok(W.backendOfCacheObject({ fiveHour: { utilization: 0.5, resetsAt: 1 } }) === 'claude', 'a bare pair of buckets is the historical claude default');
  ok(W.backendOfCacheObject({ spendControlReached: null, fiveHour: { utilization: 0 } }) === 'codex', 'a codex-only field ⇒ codex, whatever the key is called');
}


// ── ⑩ THE WRITE-PATH CENSUS (P4) ────────────────────────────────────────────
// GREP-DERIVED and deliberately OVER-INCLUSIVE: a false positive only widens
// enforcement, a false negative is the defect itself. The file set comes from
// `git ls-files` (the product installs 64 MB binaries into data/bin — a
// worktree walk is not a source listing), and the walked set is PRINTED.
{
  const { execFileSync } = await import('child_process');
  let tracked = null, skipWhy = null;
  try {
    // TRACKED **plus** untracked-but-not-ignored: the set a commit of this tree
    // would contain. Plain `ls-files` alone makes a brand-new module invisible
    // to its own census (this file was the first one), while `--others` without
    // `--exclude-standard` would drag in the 64 MB rclone the product installs
    // into data/bin — the exact reason this listing is not a worktree walk.
    const ls = (args) => execFileSync('git', ['-C', ROOT, 'ls-files', '-z', ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean);
    tracked = [...new Set([...ls([]), ...ls(['--others', '--exclude-standard'])])];
  } catch (e) { skipWhy = `git -C <root> ls-files: ${String(e.message).slice(0, 120)}`; }
  if (!tracked) {
    console.log('  ⚠ SKIP the write-path census —', skipWhy, '(no source listing; a worktree walk would read runtime products)');
  } else {
    const scope = tracked.filter((f) => (/^src\//.test(f) || /^data\/bin\//.test(f) || f === 'server.js') && !/^scripts\/test-/.test(f));
    ok(scope.includes('src/usage-cache-write.js') && scope.includes('data/bin/vibespace-usage') && scope.includes('src/usage-routes.js') && scope.includes('server.js'),
      `⑩ the census scope is non-vacuous (${scope.length} tracked files: src/ + data/bin/ + server.js)`);
    const WRITE = /writeFileSync|renameSync|writeJsonAtomic|appendFileSync/;
    const CACHEY = /USAGE_CACHE_DIR|USAGE_CACHE_FILE|usage-cache|cacheDir/;
    // FILE-LEVEL, not line-level. A proximity window (`a write within N lines
    // of a cache token`) misses the two files that matter most: the write path
    // itself, whose one `atomicWrite` helper sits far from the word "cache",
    // and the shipped statusline, whose writes name a local `f`. A file that
    // both knows about this store AND holds a raw write primitive is a
    // candidate — over-inclusive on purpose, because a false positive costs one
    // allowlist row with a reason while a false negative is the defect.
    const hits = new Map();
    for (const f of scope) {
      let txt; try { txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
      if (!CACHEY.test(txt)) continue;
      const lines = txt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!WRITE.test(lines[i])) continue;
        if (!hits.has(f)) hits.set(f, []);
        hits.get(f).push(i + 1);
      }
    }
    // EVERY entry states WHY it may write there. A dead entry fails too — an
    // allowlist nobody prunes is how a retired exception becomes a licence.
    const ALLOW = new Map([
      ['src/usage-cache-write.js', 'THE write path itself'],
      ['src/reading-repair.js', 'its generic _writeAtomic serves the ANCHOR and ATTRIBUTION stores; its three usage-cache writes go through _writeCacheAtomic → writeCacheObject({replace:true})'],
      ['src/quota-model-migrate.js', 'the backfill migration: its usage-cache writes go through writeCacheObject({replace:true}); its own appendFileSync is the archive-never-destroy ndjson'],
      ['src/server/cli-env.js', 'writes __models__.json — the served-model list, not a reading; every cache scanner excludes it by name (isCacheFileName)'],
      ['src/usage-routes.js', "writeUsageCache() writes data/usage-cache.json — the machine login's SECOND snapshot and the boot seed of _rateLimitCache, a different file outside the directory (the r6 repair essay names it)"],
      ['src/server/usage-pool-engine.js', "writes data/archive/readings-window-mismatch.ndjson — the window guard's ARCHIVE of readings it refused, a different store; its own cache writes go through the write path"],
      // The rest are candidates because the rule is FILE-LEVEL: they mention this
      // store (a constant, a comment, an env name) and hold a write primitive
      // for a DIFFERENT one. Each says which.
      ["server.js", "declares USAGE_CACHE_DIR/USAGE_CACHE_FILE and hands them to the engine + usage routes; its own writes are layouts/session-meta/etc."],
      ["src/agentd/agentd.js", "the DEVICE's own ~/.vibespace/usage-cache, read for the usage-scan op — a machine's own store, and it reaches us only as usage-cache/host-*.json"],
      ["src/mounts.js", "matched on the identifier cacheDir — the rclone download cache under ~/.cache/vibespace, nothing to do with quota"],
      ["src/server/agent-tool-generators.js", "ensureDir(USAGE_CACHE_DIR) at boot + it GENERATES data/bin/vibespace-status; the statusline tool it ships is the tracked file above"],
      ["src/server/migrations.js", "names this store in the two repair migrations' notes; the writing is reading-repair's"],
      ["src/server/otel-ingest.js", "names it in one warning string (\"no usage-cache orgUuid match\"); it writes the OTel stash"],
      ["src/server/spend-guard.js", "the P4 spend ceiling (2.369.81): it READS a usage-cache object through an injected dep (deps.readCacheFor, for the overage verdict) and its own writeJsonAtomic writes data/spend-budget.json — the persisted per-identity budget, a different store"],
      ["src/usage-anchors.js", "writes the ANCHOR streams (data/usage-anchors/*.ndjson) — a different store, fed BY cache writes"],
      ["src/ws-create.js", "names VIBESPACE_USAGE_CACHE when shipping the remote tools; it writes session state"],
      ['data/bin/vibespace-usage', 'the SHIPPED statusline tool: a single file on hosts with no checkout, so it cannot require src/ — the same documented exception as vibespace-usage-scan. WHAT IT MIRRORS IS THE READING-LAG RULE, byte-for-byte between sentinels and pinned by test-readings-attribution §13 (r2: round 1 said "the RULES it needs", which was true of `windowOf` and false of the MERGE — and the merge is where it deleted `limits`). It does NOT mirror the write path: it spreads the stored object, states only the buckets it measured, and DROPS the one limit it can measure so the lift reconstructs it. §⑮ drives the real file.'],
    ]);
    console.log('  … writers found:', [...hits.keys()].map((f) => `${f}(${hits.get(f).length})`).join(' ') || '(none)');
    const stray = [...hits.keys()].filter((f) => !ALLOW.has(f));
    ok(!stray.length, `⑩ no module outside the write path writes a usage-cache file (stray: ${JSON.stringify(stray)})`);
    const dead = [...ALLOW.keys()].filter((f) => !hits.has(f));
    ok(!dead.length, `⑩ no DEAD allowlist entry (an exception nobody prunes becomes a licence; dead: ${JSON.stringify(dead)})`);
    // the repair's named exception is structural, not a promise
    const rr = fs.readFileSync(path.join(ROOT, 'src/reading-repair.js'), 'utf8');
    ok(/function _writeCacheAtomic\([\s\S]{0,400}writeCacheObject\(\{ cacheDir, key, obj, replace: true/.test(rr),
      "⑩ …and the repair's exception is REPLACE mode through the write path, not a second writer");
    ok((rr.match(/_writeCacheAtomic\(/g) || []).length >= 4, '⑩ …used at every one of its cache write sites (definition + 3 calls)');
    // NEGATIVE CONTROL: a synthetic offender is caught by this exact rule
    const offender = "const f = require('path').join(USAGE_CACHE_DIR, 'x.json');\nrequire('fs').writeFileSync(f, '{}');\n";
    const innocent = "// nothing to do with quota\nrequire('fs').writeFileSync(outPath, '{}');\n";
    const detects = (txt) => CACHEY.test(txt) && txt.split('\n').some((L) => WRITE.test(L));
    ok(detects(offender), '⑩ NEGATIVE CONTROL: a module writing USAGE_CACHE_DIR directly IS detected by this rule');
    ok(!detects(innocent), '⑩ …and a module that writes somewhere else entirely is not (the rule is over-inclusive, not vacuous)');
  }
}

// ── ⑪ THE READER CENSUS ─────────────────────────────────────────────────────
// Who still touches the RAW legacy buckets? Same shape as ⑩: derived, printed,
// every entry stating what it is. The point is that "readers migrated" is a
// METRIC to re-measure (the standing-sweep rule), not a state somebody once
// asserted in a comment.
{
  const { execFileSync } = await import('child_process');
  let tracked = null;
  try {
    const ls = (args) => execFileSync('git', ['-C', ROOT, 'ls-files', '-z', ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean);
    tracked = [...new Set([...ls([]), ...ls(['--others', '--exclude-standard'])])];
  } catch { }
  if (!tracked) {
    console.log('  ⚠ SKIP the reader census — no readable git index');
  } else {
    const scope = tracked.filter((f) => (/^src\//.test(f) || /^data\/bin\//.test(f) || f === 'server.js') && !/^scripts\/test-/.test(f));
    const RAW = /\bsevenDay\b|\bfiveHour\b|\bscopedWeekly\b/;
    const found = scope.filter((f) => { try { return RAW.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return false; } });
    const CLASSES = {
      model: 'the model itself, or the ONE write path: this IS where the shape is defined',
      parser: 'a PARSER/PRODUCER: it turns a vendor payload into the legacy shape by definition',
      migrated: 'MIGRATED: asks quota-model whether a bucket counts before acting on it',
      // A class earned by MEASUREMENT, not by courtesy: the module reads the raw
      // shape but the only question it asks of a bucket is "is it SPENT", and an
      // empty window answers `usedPct 0` — so the B-8b12 harm (a sliding reset
      // becoming a deadline) is unreachable from here. §⑬ DRIVES that property
      // rather than asserting it in prose, because a claim in a comment can
      // never go red.
      'spent-only': 'reads the raw shape, but only ever asks "is this bucket spent" — an empty window can never answer yes',
      // A class earned by MEASUREMENT too (⑯c): the module asks quota-model's
      // predicate but reads the PROJECTED view, so its answer is exactly as
      // good as `toLegacyView`. That is a real dependency and it is named, not
      // filed under 'migrated' — a projection that loses a window makes this
      // module wrong while every predicate it calls stays right.
      'view-only': 'reads the DERIVED view (with quota-model`s predicate), never the accessor — so the projection`s own invariant is what protects it, and ⑯c drives it',
      mention: 'names a bucket field in prose only; it holds no bucket read',
      pending: 'NOT MIGRATED YET — named, with what it still does raw',
    };
    const TABLE = new Map([
      ['src/quota-model.js', ['model', '']],
      ['src/usage-cache-write.js', ['model', '']],
      ['src/harnesses/claude-quota.js', ['parser', 'the three claude reading shapes']],
      ['src/harnesses/codex-quota.js', ['parser', 'the codex rate_limits shapes']],
      ['src/adapters/claude-code.js', ['parser', 'parseGetUsageResponse — the get_usage control payload']],
      ['src/model-family.js', ['parser', 'the family projection over scopedWeekly names']],
      // NOT 'migrated' (r3): it calls `bucketCounts`, which is why the
      // empty-window harm cannot reach it — but it reads the DERIVED VIEW and
      // never the accessor, so it can only ever be as right as the projection
      // is. That gap is what hid a model limit's 5-hour window from the pool
      // (⑯c). The honest class is 'view-only', and the invariant that keeps it
      // safe is DRIVEN in ⑯c ("the view is never more optimistic than the
      // accessor") rather than assumed here.
      ['src/account-pool-auto.js', ['view-only', 'bucketRemaining/weeklyDeadline call bucketCounts, so no empty window can become a constraint or a deadline — but they read the projected view, so ⑯c drives the projection`s own invariant']],
      ['src/usage-anchors.js', ['migrated', 'an empty bucket anchors as no-bucket, like the fabricated status:unknown one']],
      ['src/usage-estimator.js', ['migrated', 'overlayCache never replaces a bucket the raw reading marks empty']],
      ['src/reading-lag.js', ['migrated', 'windowOf skips empty windows — a sliding reset is not identity evidence']],
      ['src/lib/usage-meter.js', ['migrated', 'renders every limit, and an empty window says "starts on first use" instead of a reset']],
      ['src/rate-limit-capture.js', ['migrated', 'produces the bucket, writes through the one path']],
      ['src/usage-routes.js', ['migrated', 'every writer goes through the write path; the codex summariser accumulates PER limitId']],
      ['src/server/usage-pool-engine.js', ['migrated', 'its verdicts read bucketRems → bucketRemaining, so an empty window cannot set blockedUntil or an auto-resume arm time']],
      ['src/reading-repair.js', ['migrated', 'writes through the path in replace mode; its window judgements use windowOf, which now skips empty windows']],
      ['data/bin/vibespace-usage', ['migrated', 'the shipped statusline: carries the byte-identical reading-lag mirror, which skips empty windows']],
      ['src/auto-resume-signal.js', ['spent-only', 'statedBuckets/bucketSpent/windowOpened decide only whether a window is SPENT (utilization >= 1 or status limited); an empty window is 0 % used, so it is never spent and its sliding reset can never become an arm time — driven in §⑬']],
      ['src/server/auto-resume.js', ['mention', 'one comment cites a sevenDay reset while explaining why the loop breaker keys on the WALL and not on a reset instant; it reads no bucket']],
      ['src/lib/manage-agents.js', ['pending', 'the Agents roster donuts read u.fiveHour/u.sevenDay/u.scopedWeekly directly — they show the DERIVED view (now the plan limit, deterministically) but do not yet render the other limits or the not-started note']],
      ['src/lib/session-lifecycle.js', ['pending', "the billing switcher's per-account chips read the legacy pair for a one-line summary"]],
      ['src/lib/usage-pace.js', ['pending', "the pace/burn helper is a parity port of claude-swap's pace.py and reads the legacy pair verbatim"]],
      ['server.js', ['pending', 'wiring only — it passes cache objects through to the engine']],
    ]);
    console.log('  … readers found:', found.length);
    const unlisted = found.filter((f) => !TABLE.has(f));
    ok(!unlisted.length, `⑪ every module touching the raw buckets is CLASSIFIED (unlisted: ${JSON.stringify(unlisted)})`);
    const deadRows = [...TABLE.keys()].filter((f) => !found.includes(f));
    ok(!deadRows.length, `⑪ no dead row (a class that no longer describes anything: ${JSON.stringify(deadRows)})`);
    ok([...TABLE.values()].every(([c]) => CLASSES[c]), `⑪ every row names one of the ${Object.keys(CLASSES).length} classes`);
    const pending = [...TABLE.entries()].filter(([, [c]]) => c === 'pending').map(([f]) => f);
    // A METRIC, not a state: printed every run so the next change can see
    // whether it moved (the standing-sweep rule).
    console.log(`  … readers NOT migrated: ${pending.length}/${found.length} — ${pending.join(', ')}`);
    ok(pending.length <= 4, `⑪ the not-migrated set is bounded and named (${pending.length})`);

    // ── ⑬ 'spent-only' IS A PROPERTY, SO IT IS DRIVEN ────────────────────────
    // The classification above says an empty window can never reach the arm
    // path. That is a claim about the REAL module, so the real module answers
    // it — with the empty shape B-8b12 measured (usedPct 0 and a reset a full
    // window out, sliding a few seconds on every read).
    const AR = require(path.join(ROOT, 'src/auto-resume-signal.js'));
    const nowSec = Math.round(T0 / 1000);
    const emptySnap = { limitId: 'codex', fiveHour: { utilization: 0, resetsAt: nowSec + 300 * 60 - 40 } };
    const spentSnap = { limitId: 'codex', fiveHour: { utilization: 1, resetsAt: nowSec + 1200 } };
    ok(!AR.spentBuckets(emptySnap, nowSec).length,
      '⑬ an EMPTY window is never a spent bucket — its sliding reset can never become an arm time',
      JSON.stringify(AR.spentBuckets(emptySnap, nowSec)));
    ok(AR.spentBuckets(spentSnap, nowSec).length === 1,
      '⑬ POSITIVE CONTROL: a genuinely spent window still is one (the rule is not vacuous)');
    ok(AR.statedBuckets(emptySnap).length === 1,
      '⑬ …and the panel-facing reader still SEES that window (this is a ranking rule, never a hiding rule)');
  }
}


// ── ⑫ THE POOL, DRIVEN THROUGH ITS REAL DECISION FUNCTIONS ──────────────────
// ⑤ proved the model's answer; this proves the PRODUCT's, on caches the one
// write path actually produced.
{
  const POOL = require(path.join(ROOT, 'src/account-pool-auto.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsq-pool-'));
  const nowSec = Math.round(T0 / 1000);
  // A: the plan limit is SPENT, and a Spark model cap sits at 0 % beside it.
  for (const [raw, at] of [[CODEX_PLAN_FULL, T0], [sparkAt(T0 + 1000), T0 + 1000]]) {
    W.writeReading({ cacheDir: dir, key: 'cxs-A', set: CODEXQ.toLimitSet(raw, { identity: 'cxs-A', source: 'codex-rate-limits', fetchedAt: at }), source: 'codex-rate-limits', backend: 'codex' });
  }
  // B: a healthy plan limit, same shape.
  W.writeReading({ cacheDir: dir, key: 'cxs-B', set: CODEXQ.toLimitSet(CODEX_PLAN, { identity: 'cxs-B', source: 'codex-rate-limits', fetchedAt: T0 }), source: 'codex-rate-limits', backend: 'codex' });
  W.writeReading({ cacheDir: dir, key: 'cxs-B', set: CODEXQ.toLimitSet(sparkAt(T0 + 1000), { identity: 'cxs-B', source: 'codex-rate-limits', fetchedAt: T0 + 1000 }), source: 'codex-rate-limits', backend: 'codex' });
  const A = W.readCacheObject(dir, 'cxs-A'), B = W.readCacheObject(dir, 'cxs-B');

  const remA = POOL.accountRemaining(A, nowSec);
  ok(remA.known && remA.remaining === 0, `⑫ the SPENT account reads 0 % remaining — a Spark bucket at 0 % never grants headroom the plan bucket lacks (${JSON.stringify(remA)})`);
  const remB = POOL.accountRemaining(B, nowSec);
  ok(remB.known && remB.remaining === 95, `⑫ the healthy account reads its PLAN limit, not whichever limit pushed last (${JSON.stringify(remB)})`);

  // the empty bucket is never the earliest deadline
  const dlA = POOL.weeklyDeadline(A, nowSec);
  ok(dlA === 1789356983, `⑫ the deadline is the plan window's PINNED reset (${dlA}), not the Spark bucket's sliding one`);
  ok(A.scopedWeekly.every((s) => s.state === 'empty'), '⑫ …the panel still SEES that bucket (it is rendered, marked not-started) — this is a ranking rule, not a hiding rule');
  // THE TRAP, on the account whose plan window is HEALTHY — which is where EDF
  // actually rank members. Both windows are ~7 days out, so the sliding one
  // wins the min() by the 40 seconds it slid: 1789504761 vs 1789509325. That
  // is the whole defect in two numbers, and it re-decides on every read.
  const dlB = POOL.weeklyDeadline(B, nowSec);
  const sparkResetB = B.scopedWeekly.find((s) => /Spark/i.test(s.name)).resetsAt;
  ok(dlB === 1789509325, `⑫ the healthy member's deadline is its PLAN window (${dlB})`);
  ok(sparkResetB && sparkResetB < dlB, `⑫ …while the Spark bucket's sliding "reset" (${sparkResetB}) is NEARER, so EDF would have picked it every single evaluation`);

  // bucketRems: every bucket that states a spend is REPORTED with what it has
  // left — including the untouched one, which is 100 % free (r4) — but only a
  // bucket that may name a DEADLINE publishes its reset. That split is the
  // whole r4 fix on one row.
  const rems = POOL.bucketRems(A, nowSec);
  const spentRow = rems.find((r) => r.label === '7d');
  const emptyRow = rems.find((r) => /Spark/i.test(r.label));
  ok(rems.length === 2 && spentRow && spentRow.remaining === 0 && spentRow.resetsAt === 1789356983,
    `⑫ bucketRems reports the SPENT weekly bucket at 0 % with its pinned reset (${JSON.stringify(rems)})`);
  ok(emptyRow && emptyRow.remaining === 100 && emptyRow.resetsAt === 0,
    `⑫ …and the untouched one at 100 % free with NO reset — it is headroom, never a deadline (${JSON.stringify(emptyRow)})`);

  // the VERDICT the wall machine arms auto-resume from
  const vA = POOL.quotaVerdict(A, nowSec);
  ok(vA.usable === false && vA.blockedUntil === 1789356983 * 1000,
    `⑫ the verdict blocks until the PLAN window resets — auto-resume can never arm on a sliding reset (${JSON.stringify({ u: vA.usable, b: vA.blockedUntil })})`);

  // NEGATIVE CONTROL: strip the state stamps (the pre-fix world) and the same
  // caches hand the pool a nearer, fabricated deadline.
  const strip = (c) => JSON.parse(JSON.stringify(c, (k, v) => (k === 'state' ? undefined : v)));
  const dlPre = POOL.weeklyDeadline(strip(B), nowSec);
  ok(dlPre === sparkResetB, `⑫ NEGATIVE CONTROL: without the empty-window stamp the SAME cache ranks the Spark bucket's sliding reset as the deadline (${dlPre} vs ${dlB})`);
  const remPre = POOL.accountRemaining(strip(A), nowSec);
  ok(remPre.remaining === 0, '⑫ NEGATIVE CONTROL: …the remaining is unchanged (an empty bucket is 100 % free, so it never HID an exhaustion) — the harm was always the deadline');
  const bucketsPre = POOL.bucketRems(strip(B), nowSec);
  ok(bucketsPre.some((b) => b.resetsAt === sparkResetB), '⑫ NEGATIVE CONTROL: …and the honest "which bucket is spent" report counted it as a real bucket');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑭ AN ACCOUNT WITH NO PLAN LIMIT KEEPS ITS NUMBERS ───────────────────────
// Found by RUNNING the migration on a copy of this instance, not by reading the
// code: `usage-cache/__global_codex__.json` holds the GPT-5.3-Codex-Spark model
// limit and a `credits` limit and NO plan limit — B-9213 had already overwritten
// it away before the typed model existed. Projecting "the plan limit" onto that
// file yields nothing, and a view that yields nothing DELETES the buckets (the
// write path clears a legacy bucket the view does not carry, so a stale bucket
// can never outlive the model). Measured before the fix: two real buckets went
// to `undefined`, which every unmigrated reader — the pool, the panels,
// auto-resume — reads as "no reading at all".
{
  const at = T0;
  const noPlan = QM.makeLimitSet({
    identity: '__global_codex__', fetchedAt: at, source: 'codex-rate-limits',
    limits: [
      QM.makeLimit({
        limitId: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', scope: 'model', fetchedAt: at,
        windows: [
          QM.makeWindow({ kind: '5h', minutes: 300, usedPct: 7, resetsAt: Math.round(at / 1000) + 1200, measuredAt: at }),
          QM.makeWindow({ kind: '7d', minutes: 10080, usedPct: 3, resetsAt: Math.round(at / 1000) + 300000, measuredAt: at }),
        ],
      }),
      QM.makeLimit({ limitId: 'credits', scope: 'credits', fetchedAt: at, windows: [], flags: { hasCredits: false } }),
    ],
  });
  const view = QM.toLegacyView(noPlan);
  ok(!!view.fiveHour && !!view.sevenDay && view.fiveHour.resetsAt === Math.round(at / 1000) + 1200,
    '⑭ a set with NO plan limit still projects the legacy pair — from its only window-bearing limit: ' + JSON.stringify({ fiveHour: view.fiveHour, sevenDay: view.sevenDay }));
  ok(QM.legacyWindowLimit(noPlan).limitId === 'codex_bengalfox',
    '⑭ …and `legacyWindowLimit` NAMES which limit that was (a fallback that cannot be inspected is a guess)');

  // NEGATIVE CONTROL: the plan limit still WINS whenever there is one — the
  // fallback must not become a second way to pick the displayed bucket, which
  // is the last-writer-wins behaviour this whole file exists to end.
  const withPlan = QM.mergeLimitSets(noPlan, QM.makeLimitSet({
    identity: '__global_codex__', fetchedAt: at + 1000, source: 'codex-rate-limits',
    limits: [QM.makeLimit({
      limitId: 'codex', scope: 'plan', fetchedAt: at + 1000,
      windows: [QM.makeWindow({ kind: '5h', minutes: 300, usedPct: 55, resetsAt: Math.round(at / 1000) + 9999, measuredAt: at + 1000 })],
    })],
  }));
  ok(QM.legacyWindowLimit(withPlan).limitId === 'codex' && QM.toLegacyView(withPlan).fiveHour.utilization === 0.55,
    '⑭ NEGATIVE CONTROL: once a plan limit exists it wins — the Spark bucket never displaces it again: ' + JSON.stringify(QM.toLegacyView(withPlan).fiveHour));
  ok(QM.limitsOf(withPlan).length === 3 && QM.limitsOf(withPlan).some((l) => l.limitId === 'codex_bengalfox'),
    '⑭ …and the Spark limit is still THERE, as its own limit (nothing was collapsed to make room): ' + QM.limitsOf(withPlan).map((l) => l.limitId).join(','));

  // NEVER INVENT: a set whose limits carry no plan-shaped window at all must
  // project an EMPTY view, not a fabricated bucket.
  const noWindows = QM.makeLimitSet({
    identity: 'x', fetchedAt: at,
    limits: [QM.makeLimit({ limitId: 'credits', scope: 'credits', fetchedAt: at, windows: [], flags: { hasCredits: false } })],
  });
  ok(!QM.toLegacyView(noWindows).fiveHour && !QM.toLegacyView(noWindows).sevenDay,
    '⑭ a set with no window-bearing limit projects NO bucket (never invent one)');
}


// ── ⑮ THE SHIPPED STATUSLINE MAY NOT DELETE THE CANONICAL HALF ──────────────
// (r2, the round-1 verifier's third finding, reproduced against the REAL tool.)
//
// `data/bin/vibespace-usage` is the highest-frequency writer on the instance —
// up to once per 8 s per account — and an ALLOWLISTED exception to the one
// write path, because it ships as a single file to hosts with no checkout. It
// rebuilt the cache object from a hand-written list of fields to PRESERVE, and
// that list did not name `limits`. Measured, over a migrated copy of a real
// cache file: three limits in, ZERO out, the `overage` object gone with them,
// and the next reader re-deriving the limits under THIS producer's name and
// clock — so the model claimed a model-scoped Fable cap had been measured by
// the statusline at a time the very same file's `scopedFetchedAt` contradicts.
//
// A list of what to KEEP is a promise every future edit has to remember, and it
// has now been forgotten six times on this one file (`scopedWeekly`, the org
// identity, `spend`, `corroborated`, the established window — which is why THAT
// moved to a sidecar — and `limits`). So the tool no longer enumerates: it
// spreads what was there, states only what it measured, and DROPS the single
// limit it is able to measure (the plan one), whose reading it has just written
// into the legacy buckets where `liftCacheObject` reconstructs it with this
// object's own provenance. A producer that cannot express a window state or
// another limit's age can never forge one.
//
// This leg drives the REAL FILE. Its negative control is a patched copy with
// the spread reverted to round 1's enumerated literal.
{
  const { execFileSync } = await import('child_process');
  const TOOL = path.join(ROOT, 'data/bin/vibespace-usage');
  const nowSec = Math.floor(Date.now() / 1000);
  const KEY = 'sub-quotamodel15';

  // A migrated snapshot in the shape the write path produces: three limits,
  // each with its OWN source and its OWN age, and only one of them (the plan)
  // is something the statusline can measure.
  const mkDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qm15-'));
    tmpDirs.push(dir);
    const legacy = {
      fiveHour: { utilization: 0.71, resetsAt: nowSec + 2 * 3600 },
      sevenDay: { utilization: 0.44, resetsAt: nowSec + 3 * 86400 },
      scopedWeekly: [{ name: 'Fable', utilization: 0.93, resetsAt: nowSec + 3 * 86400 }],
      scopedFetchedAt: Date.now() - 3600e3,
      overage: { status: 'allowed', inUse: false },
      orgUuid: 'org-anon', orgName: 'Anon', overallStatus: 'allowed',
      fetchedAt: Date.now() - 3600e3, source: 'on-demand',
    };
    W.writeCacheObject({ cacheDir: dir, key: KEY, obj: legacy, source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude' });
    // …and give the model cap a DIFFERENT, older provenance than the plan one,
    // the way three real readings on one account differ.
    const f = W.cacheFileFor(dir, KEY);
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    o.limits = o.limits.map((l) => (l.limitId === 'plan' ? l : { ...l, source: 'on-demand', fetchedAt: Date.now() - 7200e3 }));
    fs.writeFileSync(f, JSON.stringify(o));
    const old = Date.now() - 60000;                       // past the tool's own 8 s throttle
    fs.utimesSync(f, old / 1000, old / 1000);
    return { dir, f };
  };
  const render = (tool, dir) => {
    const payload = JSON.stringify({
      session_id: 'sess-qm15', model: { id: 'claude-fable-5', display_name: 'Fable 5' },
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: nowSec + 3600, status: 'allowed' },
        seven_day: { used_percentage: 46, resets_at: nowSec + 200000, status: 'allowed' },
      },
    });
    execFileSync(tool, [], { input: payload, encoding: 'utf8', env: { ...process.env, VIBESPACE_USAGE_CACHE: dir, VIBESPACE_ACCOUNT_KEY: KEY, HOME: dir } });
  };
  const limitsOf = (o) => W.limitsOfCache(o, { identity: KEY, backend: 'claude', familyOf: familyOfScopedBucket }).limits;
  const byId = (ls, id) => ls.find((l) => l.limitId === id) || null;

  const A = mkDir();
  const before = JSON.parse(fs.readFileSync(A.f, 'utf8'));
  const beforeModel = byId(before.limits, 'model:fable');
  render(TOOL, A.dir);
  const after = JSON.parse(fs.readFileSync(A.f, 'utf8'));

  ok(Array.isArray(after.limits), '⑮ one render of the SHIPPED tool leaves the canonical half in place');
  const afterLimits = limitsOf(after);
  ok(afterLimits.length === before.limits.length && ['plan', 'model:fable', 'overage'].every((id) => byId(afterLimits, id)),
    `⑮ …with every limit the account holds (${afterLimits.map((l) => l.limitId).join(',')})`);
  const am = byId(after.limits, 'model:fable');
  ok(am && beforeModel && am.source === beforeModel.source && am.fetchedAt === beforeModel.fetchedAt,
    '⑮ …and a limit this producer cannot measure keeps ITS OWN source and ITS OWN age (never re-stamped)');
  ok(byId(after.limits, 'overage'), '⑮ …including the overage limit, which the pre-fix literal dropped entirely');
  const ap = byId(afterLimits, 'plan');
  ok(ap && ap.source === 'passive' && ap.fetchedAt >= before.fetchedAt,
    `⑮ …while the PLAN limit — the one it did measure — carries this producer's own name and clock (${ap && ap.source})`);
  ok(ap && QM.windowOfKind(ap, '5h')?.usedPct === 12 && QM.windowOfKind(ap, '7d')?.usedPct === 46,
    '⑮ …and its numbers are the ones this render actually read');
  ok(after.scopedFetchedAt === before.scopedFetchedAt && !!after.overage && after.orgUuid === 'org-anon',
    '⑮ …every other field survives by construction, not by being remembered (spread, not a preserve list)');

  ok(!('corroborated' in after),
    '⑮ …and the ONE field it refuses to inherit is `corroborated` — a verdict about a different reading, which this producer has no observation to re-earn');

  // THE RECONSTRUCTION RUNG IS CLAUDE-ONLY. codex names its own limits
  // ('codex', 'codex_bengalfox', 'premium'…) and none of them is called
  // 'plan', so a backend-blind rung would invent a plan limit on every codex
  // file out of buckets that already belong to a named limit.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qm15c-')); tmpDirs.push(dir);
    const cxKey = '__global_codex__';
    const set = CODEXQ.toLimitSet(sparkAt(T0), { identity: cxKey, source: 'codex-rate-limits', fetchedAt: T0 });
    W.writeReading({ cacheDir: dir, key: cxKey, set, source: 'codex-rate-limits', backend: 'codex' });
    const o = JSON.parse(fs.readFileSync(W.cacheFileFor(dir, cxKey), 'utf8'));
    const ids = (hint) => W.limitsOfCache(o, { identity: cxKey, backend: hint, familyOf: familyOfScopedBucket }).limits.map((l) => l.limitId);
    ok(!ids('codex').includes('plan') && !ids(null).includes('plan'),
      `⑮ a CODEX snapshot never gains an invented plan limit, told or inferred (${ids(null).join(',')})`);
  }

  // THE TOOL NEVER AUTHORS THE CANONICAL HALF. A file that has not been
  // migrated has no `limits`, and a one-element array claiming to be all of
  // them would DELETE that file's scoped cap and its overage the moment
  // anything lifted it (liftCacheObject prefers `limits` over the legacy view).
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qm15b-')); tmpDirs.push(dir);
    const f = W.cacheFileFor(dir, KEY);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({
      fiveHour: { utilization: 0.5, resetsAt: nowSec + 3600 }, sevenDay: { utilization: 0.2, resetsAt: nowSec + 86400 },
      scopedWeekly: [{ name: 'Fable', utilization: 0.9, resetsAt: nowSec + 86400 }], fetchedAt: Date.now() - 3600e3, source: 'cli-usage',
    }));
    const old = Date.now() - 60000; fs.utimesSync(f, old / 1000, old / 1000);
    render(TOOL, dir);
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok(!('limits' in o), '⑮ on a NOT-YET-MIGRATED file the tool writes no `limits` at all (a producer that knows one limit may not author the list of all of them)');
    ok(limitsOf(o).some((l) => l.limitId === 'model:fable'), '⑮ …so the scoped cap on that file is still reachable');
  }

  // ── NEGATIVE CONTROL: round 1's enumerated literal, in a patched copy of the
  // real tool. The patch is asserted to hit, so this can never silently become
  // a second green arm.
  {
    const shipped = fs.readFileSync(TOOL, 'utf8');
    const SPREAD = "    ...(prev && typeof prev === 'object' ? prev : {}),\n";
    ok(shipped.split(SPREAD).length === 2, '⑮ NEGATIVE CONTROL setup: the rewrite decision is a single line in the shipped tool');
    const B = mkDir();
    const preFix = path.join(B.dir, 'vibespace-usage.prefix');
    fs.writeFileSync(preFix, shipped.replace(SPREAD, ''), { mode: 0o755 });
    render(preFix, B.dir);
    const o = JSON.parse(fs.readFileSync(B.f, 'utf8'));
    ok(!Array.isArray(o.limits) && !o.overage,
      `⑮ NEGATIVE CONTROL: with the preserve list back, ONE render deletes the canonical half and the overage (keys: ${Object.keys(o).join(',')})`);
    const relifted = limitsOf(o);
    ok(!relifted.some((l) => l.limitId === 'overage') && relifted.every((l) => l.source === 'passive'),
      `⑮ NEGATIVE CONTROL: …and the re-lift stamps THIS producer's name on limits it never measured (${relifted.map((l) => l.limitId + '=' + l.source).join(',')})`);
  }
}


// ── ⑯ THE ROUND-3 DEFECTS: THREE WAYS A BUCKET STOPPED COUNTING ─────────────
// All three were found by an adversarial verifier ON THIS BRANCH, all three
// were reproduced end to end before being fixed, and all three cost money in
// the same way: a bucket that makes a real claim is dropped from
// `accountRemaining` / `weeklyDeadline` / `bucketRems` / the anchor stream, so
// the pool goes on spending against a member that is actually walled.
//
// Each leg drives the REAL modules. Each negative control is a PATCHED COPY of
// a real module written beside it (siblings, or the relative requires do not
// resolve — the same idiom as test-auto-resume §12a and test-readings-attribution
// §18), and every patch is ASSERTED TO HIT so a control can never quietly turn
// into a second green arm.
console.log('\n⑯ the round-3 defects: three ways a counting bucket stopped counting');
{
  const MUT = `vs-qmr3-mut-${process.pid}-`;
  // Sweep any sibling left by a run that was SIGKILLed (a crashed suite must
  // never be able to dirty the tree and block the release gate).
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
      const m = /^vs-qmr3-mut-(\d+)-/.exec(f);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); continue; } catch { }   // still running: leave it
      try { fs.unlinkSync(path.join(ROOT, 'src', f)); } catch { }
    }
  } catch { }
  const mutants = [];
  process.on('exit', () => { for (const f of mutants) { try { fs.unlinkSync(f); } catch { } } });

  /** Write patched sibling copies of `names` (paths under src/) and return a
   *  require()-able map. `patches` is {file: [[from, to], …]}; every entry must
   *  hit exactly once. Cross-requires between the copies are re-pointed so the
   *  mutant world is closed — a control that half-loads the real module is not
   *  a control. */
  const mutantWorld = (tag, names, patches) => {
    const out = {}, hits = [];
    const nameOf = (n) => `${MUT}${tag}-${path.basename(n)}`;
    for (const n of names) {
      let src = fs.readFileSync(path.join(ROOT, n), 'utf8');
      for (const other of names) {
        const rel = './' + path.basename(other);
        if (src.includes(`require('${rel}')`)) src = src.split(`require('${rel}')`).join(`require('./${nameOf(other)}')`);
      }
      for (const [from, to] of (patches[n] || [])) {
        hits.push([n, src.split(from).length - 1]);
        src = src.split(from).join(to);
      }
      const dst = path.join(ROOT, 'src', nameOf(n));
      fs.writeFileSync(dst, src);
      mutants.push(dst);
      out[n] = dst;
    }
    return { out, hits };
  };
  const load = (w, n) => require(w.out[n]);
  const patchHit = (w, label) => ok(w.hits.length > 0 && w.hits.every(([, c]) => c === 1),
    `⑯ NEGATIVE CONTROL setup: ${label} — every patch anchor hit exactly once (${JSON.stringify(w.hits)})`);

  const POOL = require(path.join(ROOT, 'src/account-pool-auto.js'));
  const CAP = require(path.join(ROOT, 'src/rate-limit-capture.js'));
  const { UsageAnchors } = require(path.join(ROOT, 'src/usage-anchors.js'));
  const QMFILE = 'src/quota-model.js', WFILE = 'src/usage-cache-write.js', CFILE = 'src/rate-limit-capture.js', PFILE = 'src/account-pool-auto.js';

  /** What the REAL anchor stream records for a cache object. This is the third
   *  reader of `bucketCounts` (the pool's two are remaining and deadline) and
   *  the one whose harm nothing else can stand in for: an anchor is the
   *  estimator's entire training input AND the corpus the by-window repair
   *  fingerprints identities from. Driven through `UsageAnchors` itself — the
   *  predicate is not re-spelled here. */
  const anchorBuckets = (cache) => {
    const d = scratch();
    const A = new UsageAnchors({ dataDir: d });
    A.maybeRecord({ identityKey: 'acct:probe', accountId: 'probe', cache, costSince: null });
    return (A.lastAnchor('acct:probe') || {}).buckets || { fiveHour: null, sevenDay: null, scopedWeekly: [] };
  };
  const NOW = 1788970000000, nowSec = Math.floor(NOW / 1000);
  const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qm16-')); tmpDirs.push(d); return d; };
  // ⑯c builds the view-vs-accessor shape matrix; ⑯d re-drives it against its
  // own mutant to show the matrix now covers the defect that walked past it.
  let propShapes = null, propNow = 0, propOpt = () => false;
  // ⑯e migrates a real-shape file and then re-reads it under its own mutant.
  let migAfter = null;
  const rd = (d, k) => JSON.parse(fs.readFileSync(path.join(d, k + '.json'), 'utf8'));

  // ── ⑯a A STATED SPEND WITH NO RESET ───────────────────────────────────────
  // `windowState` asked for the deadline BEFORE it asked whether anything had
  // been spent, so "we know the utilization but not the reset" collapsed into
  // 'unknown' — which `bucketCounts` drops.
  console.log('\n  ⑯a a stated spend is decisive even when the reset is unknown');
  {
    // PURE: the rule itself.
    ok(QM.windowState({ kind: '5h', usedPct: 100, resetsAt: null, measuredAt: NOW }) === 'running',
      '⑯a a window the vendor says is 100 % gone is RUNNING, reset or no reset');
    ok(QM.windowState({ kind: '5h', usedPct: 0.4, resetsAt: null, measuredAt: NOW }) === 'running',
      '⑯a …any stated spend does it (the test is "> 0", not "looks big")');
    // POSITIVE CONTROL: the rule did not swallow the honest-unknown case.
    ok(QM.windowState({ kind: '5h', usedPct: 0, resetsAt: null, measuredAt: NOW }) === 'unknown',
      '⑯a POSITIVE CONTROL: 0 % with no reset is still UNKNOWN — untouched and just-started stay indistinguishable');
    ok(QM.windowState({ kind: '5h', usedPct: null, resetsAt: nowSec + 3000, measuredAt: NOW }) === 'unknown',
      '⑯a POSITIVE CONTROL: …and no usage figure at all is still UNKNOWN (ignorance is never a claim)');

    // REACHABILITY, from the product's own parser. THIS IS THE WHOLE PATH: the
    // `· resets` clause is optional on a real claude panel line,
    // `refreshViaCliPanel` deliberately refuses to project the 5-hour reset,
    // and the panel is the on-demand ⟳ every member gets. So a member can be
    // 95 % through its burst window with no reset anywhere in the product.
    const panel = CLAUDEQ.parseCliUsageText('Current session: 95% used\nCurrent week (all models): 20% used · resets Jan 2, 3am (America/Los_Angeles)', NOW);
    ok(panel && panel.fiveHour && panel.fiveHour.utilization === 0.95 && panel.fiveHour.resetsAt === undefined,
      `⑯a REACHABILITY: a real panel line without "· resets" parses to a SPENT bucket with NO reset (${JSON.stringify(panel.fiveHour)})`);

    // PRODUCT, end to end, through the one write path. Deliberately NO wall
    // here: a wall supplies its own bounded-guess reset, which would let ⑯b's
    // defect stand in for this one. This leg must fail for exactly one reason.
    const world = (Q) => {
      const dir = scratch();
      const P = Q.POOL || POOL;
      Q.W.writeCacheObject({ cacheDir: dir, key: 'A', obj: { ...panel, fetchedAt: NOW }, measuredAt: NOW, source: 'cli-usage' });
      Q.W.writeCacheObject({ cacheDir: dir, key: 'B', obj: { fiveHour: { utilization: 0.2, resetsAt: nowSec + 3000 }, sevenDay: { utilization: 0.1, resetsAt: nowSec + 300000 }, fetchedAt: NOW }, measuredAt: NOW, source: 'cli-usage' });
      const caches = { A: rd(dir, 'A'), B: rd(dir, 'B') };
      return {
        caches,
        rem: P.accountRemaining(caches.A, nowSec),
        anchors: anchorBuckets(caches.A),
        dec: P.decidePoolSwitch({ currentId: 'A', members: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], readCache: (id) => caches[id] ?? null, nowSec, hot: true, explain: true }),
      };
    };
    const real = world({ W, CAP });
    ok(real.rem.known && real.rem.remaining === 5,
      `⑯a the member 95 % through its burst window reads 5 % remaining (${JSON.stringify(real.rem)})`);
    ok(real.dec && real.dec.to === 'B',
      `⑯a …and the pool LEAVES it (${JSON.stringify({ to: real.dec && real.dec.to, why: real.dec && real.dec.reason })})`);
    ok(real.caches.A.fiveHour.state === undefined,
      `⑯a …because the reset-less bucket counts on the strength of its spend alone (${JSON.stringify(real.caches.A.fiveHour)})`);
    ok(real.anchors.fiveHour && real.anchors.fiveHour.u === 0.95,
      `⑯a …and the reading reaches the ANCHOR stream, which is what the estimator learns from (${JSON.stringify(real.anchors.fiveHour)})`);

    // NEGATIVE CONTROL: put the deadline test back in front of the spend test.
    const w = mutantWorld('a', [QMFILE, WFILE, CFILE], {
      [QMFILE]: [
        ["  if (used == null) return 'unknown';", "  const resetsAt0 = posNum(win.resetsAt);\n  if (used == null || resetsAt0 == null) return 'unknown';"],
        ["  const resetsAt = posNum(win.resetsAt);\n  if (resetsAt == null) return 'unknown';", '  const resetsAt = resetsAt0;'],
      ],
    });
    patchHit(w, '⑯a restores the pre-fix ordering in windowState');
    const pre = world({ W: load(w, WFILE), CAP: load(w, CFILE) });
    ok(pre.caches.A.fiveHour.state === 'unknown' && pre.caches.A.fiveHour.utilization === 0.95,
      `⑯a NEGATIVE CONTROL: with the old ordering the bucket is 95 % spent AND stamped unknown (${JSON.stringify(pre.caches.A.fiveHour)})`);
    // WHAT THE `windowState` ORDERING UNIQUELY PROTECTS, AFTER r4. The r4 split
    // gave the REMAINING its own predicate (`bucketStatesSpend`), so a stated
    // 95 % is worth 5 % free whatever the stamp says — the two fixes are two
    // independent belts against one money harm, and each needs its own control
    // (⑯a-x below removes the OTHER belt and shows this shape go dark again).
    // What only THIS fix protects is everything keyed on `bucketCounts`: the
    // ANCHOR STREAM, which is the estimator's entire input and the corpus the
    // window fingerprint identifies accounts from.
    ok(pre.anchors.fiveHour === null,
      `⑯a NEGATIVE CONTROL: …so the 95 % reading never becomes an ANCHOR — the estimator and the window guard never see it (${JSON.stringify(pre.anchors)})`);
    ok(pre.rem.remaining === 5 && pre.dec && pre.dec.to === 'B',
      `⑯a NEGATIVE CONTROL: …while the pool is held by the OTHER belt, which is why this control may not claim the remaining (${JSON.stringify({ rem: pre.rem.remaining, to: pre.dec && pre.dec.to })})`);

    // ⑯a-x THE SECOND BELT, ALONE. Remove the r4 split and keep the r3 stamp
    // ordering broken: this is the branch as the r3 verifier found it, and it
    // reproduces the number that commit measured (80 % free on the 7d window
    // alone, the pool staying on a member 95 % through its burst window).
    const wax = mutantWorld('ax', [QMFILE, WFILE, CFILE, PFILE], {
      [QMFILE]: [
        ["  if (used == null) return 'unknown';", "  const resetsAt0 = posNum(win.resetsAt);\n  if (used == null || resetsAt0 == null) return 'unknown';"],
        ["  const resetsAt = posNum(win.resetsAt);\n  if (resetsAt == null) return 'unknown';", '  const resetsAt = resetsAt0;'],
        ['    for (const w of spendingWindows(l)) {', '    for (const w of countingWindows(l)) {'],
      ],
      [PFILE]: [['  if (!bucketStatesSpend(b)) return null;', '  if (!bucketCounts(b)) return null;']],
    });
    patchHit(wax, '⑯a-x removes BOTH belts (the r3 defect with the r4 split undone)');
    const preX = world({ W: load(wax, WFILE), CAP: load(wax, CFILE), POOL: load(wax, PFILE) });
    ok(preX.rem.remaining === 80,
      `⑯a-x NEGATIVE CONTROL (both belts): the member reads ${preX.rem.remaining} % free on its 7d window alone — the burst window it is nearly through is invisible`);
    ok(preX.dec === null || (preX.dec && preX.dec.to === null),
      `⑯a-x NEGATIVE CONTROL (both belts): …and the pool stays on it (${JSON.stringify(preX.dec && preX.dec.reason)})`);
  }

  // ── ⑯b A STORED VERDICT MAY NOT OUTLIVE THE READING IT DESCRIBES ──────────
  // `state` is a verdict computed by the projection from a
  // (usedPct, resetsAt, measuredAt) triple, but it lives on the bucket object
  // every producer spreads forward — so it rode onto numbers it no longer
  // described. Two halves, two mechanisms, two negative controls.
  console.log('\n  ⑯b a stored window verdict may not outlive the reading it describes');
  {
    const WEEK = 7 * 24 * 3600;
    // B1 — THE BELT'S OWN CASE: a stale stamp that arrives from a FILE, not
    // from a producer this build can patch. An older build stamped the bucket
    // 'unknown' while it had no reset; the account has since been read properly
    // and the bucket is 95 % spent and fully dated, but the stamp is still on
    // disk. Nothing in this leg re-states the 5h bucket, so the producer half
    // can never fire — only `fromLegacy`'s belt heals it, on the next write.
    //
    // NOT HYPOTHETICAL: four of the nine live claude cache files on this
    // instance hold a reset-less `fiveHour`, which is precisely how this stamp
    // gets written.
    const b1 = (Q) => {
      const dir = scratch();
      const stale = {
        fiveHour: { utilization: 0.95, resetsAt: nowSec + 4000, state: 'unknown' },
        sevenDay: { utilization: 0.2, resetsAt: nowSec + 300000 },
        fetchedAt: NOW, source: 'cli-usage',
      };
      fs.writeFileSync(path.join(dir, 'C.json'), JSON.stringify(stale));
      // any later write that does NOT touch the 5h bucket
      Q.CAP.captureRateLimitEvent({ cacheDir: dir, key: 'C', identityIds: ['C'], ev: { kind: 'sevenDay', status: 'allowed', utilization: 0.2, resetsAt: nowSec + 300000 }, now: NOW + 1000 });
      const c = rd(dir, 'C');
      return { c, rem: (Q.POOL || POOL).accountRemaining(c, nowSec), anchors: anchorBuckets(c) };
    };
    const r1 = b1({ W, CAP });
    ok(r1.c.fiveHour.state === undefined,
      `⑯b a stale stamp left on disk by an older build HEALS on the next write (${JSON.stringify(r1.c.fiveHour)})`);
    ok(r1.rem.remaining === 5, `⑯b …and the 95 % bucket is worth 5 % remaining again (${JSON.stringify(r1.rem)})`);

    // B2: an EMPTY stamp survives a real spend — the routine post-weekly-roll
    // shape, and inc-msof8i22 / 2.305.0 re-opened (a spent model cap the pool
    // cannot see).
    const b2 = (Q) => {
      const dir = scratch();
      const weekOut = nowSec + WEEK - 30;
      Q.W.writeCacheObject({
        cacheDir: dir, key: 'D', measuredAt: NOW, source: 'cli-usage',
        obj: { fiveHour: { utilization: 0.1, resetsAt: nowSec + 3000 }, sevenDay: { utilization: 0, resetsAt: weekOut }, scopedWeekly: [{ name: 'Fable', utilization: 0, resetsAt: weekOut }], fetchedAt: NOW },
      });
      const seeded = rd(dir, 'D');
      Q.CAP.captureRateLimitEvent({ cacheDir: dir, key: 'D', identityIds: ['D'], ev: { kind: 'sevenDay', status: 'allowed', utilization: 0.9, resetsAt: weekOut }, now: NOW + 2000 });
      Q.CAP.captureRateLimitEvent({ cacheDir: dir, key: 'D', identityIds: ['D'], ev: { kind: 'scoped', scopedName: 'fable', status: 'allowed', utilization: 1, resetsAt: weekOut }, now: NOW + 3000 });
      const c = rd(dir, 'D');
      const P = Q.POOL || POOL;
      return { seeded, c, weekOut, rem: P.accountRemaining(c, nowSec), dl: P.weeklyDeadline(c, nowSec), rems: P.bucketRems(c, nowSec), anchors: anchorBuckets(c) };
    };
    const r2 = b2({ W, CAP });
    ok(r2.seeded.sevenDay.state === 'empty' && r2.seeded.scopedWeekly[0].state === 'empty',
      '⑯b SETUP: at the weekly roll both budget windows are correctly stamped EMPTY (this stamp is right when it is written)');
    ok(r2.rem.known && r2.rem.remaining === 0,
      `⑯b …after three real readings climb them, the spent model cap is worth 0 % (${JSON.stringify(r2.rem)})`);
    ok(r2.dl === r2.weekOut, `⑯b …the account has its weekly deadline back (${r2.dl})`);
    ok(r2.rems.length === 3, `⑯b …and all three buckets are reported again (${JSON.stringify(r2.rems.map((x) => (x.label || x.kind) + ' ' + Math.round(x.remaining)))})`);
    ok(r2.anchors.sevenDay && r2.anchors.sevenDay.u === 0.9 && r2.anchors.scopedWeekly.length === 1,
      `⑯b …and both climbed readings reach the ANCHOR stream (${JSON.stringify(r2.anchors)})`);

    // B3 — THE PRODUCER HALF'S OWN CASE, which the belt structurally cannot
    // catch: a window correctly stamped EMPTY, then re-stated by a real event
    // that still reads 0 % but now carries a PINNED reset an hour out — the
    // window did open, the member just barely used it. `usedPct` is 0, so "a
    // stated spend voids the verdict" says nothing; only the producer, which
    // knows it just replaced the numbers, can drop the verdict that described
    // the old ones. The cost of keeping it is the member's real weekly
    // deadline: EDF cannot rank an account whose deadline reads null.
    const b3 = (Q) => {
      const dir = scratch();
      Q.W.writeCacheObject({ cacheDir: dir, key: 'E', measuredAt: NOW, source: 'cli-usage', obj: { sevenDay: { utilization: 0, resetsAt: nowSec + WEEK - 40 }, fetchedAt: NOW } });
      const seeded = rd(dir, 'E');
      const pinned = nowSec + 3600;
      Q.CAP.captureRateLimitEvent({ cacheDir: dir, key: 'E', identityIds: ['E'], ev: { kind: 'sevenDay', status: 'allowed', utilization: 0, resetsAt: pinned }, now: NOW + 60000 });
      const c = rd(dir, 'E');
      return { seeded, c, pinned, dl: POOL.weeklyDeadline(c, nowSec) };
    };
    const r3 = b3({ W, CAP });
    ok(r3.seeded.sevenDay.state === 'empty', '⑯b SETUP: the window starts out correctly stamped EMPTY (0 %, sliding reset)');
    ok(r3.c.sevenDay.state === undefined,
      `⑯b a window re-stated at 0 % with a now-PINNED reset becomes RUNNING — the EMPTY verdict described the old numbers (${JSON.stringify(r3.c.sevenDay)})`);
    ok(r3.dl === r3.pinned, `⑯b …so the member gets its real weekly deadline back (${r3.dl})`);

    // POSITIVE CONTROL: a status-only event changes no number, so the reading
    // is unchanged and the verdict MUST survive — dropping it there would hand
    // `fromLegacy` the file's clock and flip a genuinely empty window.
    {
      const dir = scratch();
      const weekOut = nowSec + WEEK - 40;
      W.writeCacheObject({ cacheDir: dir, key: 'F', measuredAt: NOW, source: 'cli-usage', obj: { sevenDay: { utilization: 0, resetsAt: weekOut }, fetchedAt: NOW } });
      ok(rd(dir, 'F').sevenDay.state === 'empty', '⑯b POSITIVE CONTROL setup: a genuinely empty weekly window');
      CAP.captureRateLimitEvent({ cacheDir: dir, key: 'F', identityIds: ['F'], ev: { kind: 'sevenDay', status: 'allowed' }, now: NOW + 30 * 60000 });
      const c = rd(dir, 'F');
      ok(c.sevenDay.state === 'empty',
        `⑯b POSITIVE CONTROL: a status-only event 30 min later restates no number, so the EMPTY verdict survives (${JSON.stringify(c.sevenDay)})`);
      ok(POOL.weeklyDeadline(c, nowSec) === null,
        '⑯b POSITIVE CONTROL: …and the sliding reset still never becomes a deadline (this is the reason the stamp is trusted at all)');
    }

    // NEGATIVE CONTROL 1 — the belt: `fromLegacy` trusts a stamp unconditionally.
    const wBelt = mutantWorld('b1', [QMFILE, WFILE, CFILE], {
      [QMFILE]: [["if (STATES.includes(b.state) && !(usedPct > 0)) w.state = b.state;", 'if (STATES.includes(b.state)) w.state = b.state;']],
    });
    patchHit(wBelt, '⑯b restores the unconditional stored-state preserve');
    const preBelt = { W: load(wBelt, WFILE), CAP: load(wBelt, CFILE) };
    const p1 = b1(preBelt);
    ok(p1.c.fiveHour.state === 'unknown' && p1.anchors.fiveHour === null,
      `⑯b NEGATIVE CONTROL (belt): the stale on-disk stamp NEVER heals, so the 95 % reading never becomes an ANCHOR (${JSON.stringify({ state: p1.c.fiveHour.state, anchor: p1.anchors.fiveHour })})`);
    ok(p1.rem.remaining === 5,
      `⑯b NEGATIVE CONTROL (belt): …while the r4 split holds the pool's remaining at ${p1.rem.remaining} % — a second belt, measured by ⑯b-x below`);
    // …and the belt is what makes ⑯b's headline case survive an unpatched
    // producer too, so it is measured on that shape as well.
    const wBoth = mutantWorld('b1x', [QMFILE, WFILE, CFILE], {
      [QMFILE]: [['if (STATES.includes(b.state) && !(usedPct > 0)) w.state = b.state;', 'if (STATES.includes(b.state)) w.state = b.state;']],
      [CFILE]: [['const restated = (b) => { const c = { ...b }; delete c.state; return c; };', 'const restated = (b) => ({ ...b });']],
    });
    patchHit(wBoth, '⑯b removes BOTH halves (the branch as the verifier found it)');
    const p2 = b2({ W: load(wBoth, WFILE), CAP: load(wBoth, CFILE) });
    ok(p2.dl === null && p2.anchors.sevenDay === null && p2.anchors.scopedWeekly.length === 0,
      `⑯b NEGATIVE CONTROL (both halves): the stale EMPTY verdict rides onto the climbed numbers, so the member has NO weekly deadline (${p2.dl}) and neither reading anchors (${JSON.stringify(p2.anchors)}) — EDF cannot rank it and the estimator never learns`);

    // ⑯b-x THE SECOND BELT, ALONE — the same shapes with the r4 split undone,
    // which is what makes ⑯b's own controls measure only what ⑯b's fix
    // protects. These are the numbers the r3 commit measured; they are
    // reproduced here so the claim "the remaining is held by the OTHER belt"
    // is a MEASUREMENT and not a reading of the diff.
    const wbx = mutantWorld('b2x', [QMFILE, WFILE, CFILE, PFILE], {
      [QMFILE]: [
        ['if (STATES.includes(b.state) && !(usedPct > 0)) w.state = b.state;', 'if (STATES.includes(b.state)) w.state = b.state;'],
        ['    for (const w of spendingWindows(l)) {', '    for (const w of countingWindows(l)) {'],
      ],
      [CFILE]: [['const restated = (b) => { const c = { ...b }; delete c.state; return c; };', 'const restated = (b) => ({ ...b });']],
      [PFILE]: [['  if (!bucketStatesSpend(b)) return null;', '  if (!bucketCounts(b)) return null;']],
    });
    patchHit(wbx, '⑯b-x removes BOTH belts (the r3 defect with the r4 split undone)');
    const pbx1 = b1({ W: load(wbx, WFILE), CAP: load(wbx, CFILE), POOL: load(wbx, PFILE) });
    ok(pbx1.rem.remaining === 80,
      `⑯b-x NEGATIVE CONTROL (both belts): the stale stamp makes the 95 % bucket invisible and the member reads ${pbx1.rem.remaining} % free`);
    const pbx2 = b2({ W: load(wbx, WFILE), CAP: load(wbx, CFILE), POOL: load(wbx, PFILE) });
    ok(pbx2.rem.remaining === 90 && pbx2.dl === null && pbx2.rems.length === 1,
      `⑯b-x NEGATIVE CONTROL (both belts): the spent Fable cap is INVISIBLE (${pbx2.rem.remaining} % free, deadline ${pbx2.dl}, ${pbx2.rems.length} bucket row) — inc-msof8i22 re-opened`);

    // NEGATIVE CONTROL 2 — the producer half: the writer keeps a verdict it
    // just invalidated. Only this half catches the re-statement DOWN to 0 %,
    // which is why there are two controls and not one.
    const wProd = mutantWorld('b2', [CFILE], {
      [CFILE]: [['const restated = (b) => { const c = { ...b }; delete c.state; return c; };', 'const restated = (b) => ({ ...b });']],
    });
    patchHit(wProd, '⑯b restores the producer that carries a stale verdict forward');
    const p3 = b3({ W, CAP: load(wProd, CFILE) });
    ok(p3.c.sevenDay.state === 'empty' && p3.dl === null,
      `⑯b NEGATIVE CONTROL (producer): the stale EMPTY verdict rides onto the re-stated window, so the member's real 1-hour deadline reads ${p3.dl} — and the belt cannot help, because 0 % refutes nothing`);
  }

  // ── ⑯c THE VIEW MAY NEVER BE MORE OPTIMISTIC THAN THE SET ─────────────────
  // A model limit's FIVE-HOUR window had no home in the legacy view: the scoped
  // projection takes only BUDGET windows and `fiveHour` was read off the plan
  // limit alone. `account-pool-auto` reads the VIEW.
  console.log('\n  ⑯c the derived view may never be more optimistic than the set it projects');
  {
    // The two REAL codex push shapes (§⑫'s fixtures, with the Spark limit
    // SPENT on its burst window — §⑫ only ever tested the 0 % direction).
    const sparkSpent = {
      ...sparkAt(T0), primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: Math.round(T0 / 1000) + 1200 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1789509325 },
    };
    const nowC = Math.round(T0 / 1000);
    const set = QM.mergeLimitSets(
      CODEXQ.toLimitSet(CODEX_PLAN, { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 }),
      CODEXQ.toLimitSet(sparkSpent, { identity: 'cx', source: 'codex-rate-limits', fetchedAt: T0 + 3000 }),
    );
    const view = QM.toLegacyView(set);
    const acc = QM.remaining(set, { nowSec: nowC });
    const viaPool = POOL.accountRemaining(view, nowC);
    ok(acc.known && acc.remaining === 10 && acc.kind === '5h',
      `⑯c the ACCESSOR binds on the Spark burst window (${JSON.stringify(acc)})`);
    ok(viaPool.known && viaPool.remaining === 10,
      `⑯c …and the pool, which reads the VIEW, now agrees (${JSON.stringify(viaPool)})`);
    ok(view.fiveHour && view.fiveHour.utilization === 0.9,
      `⑯c …because fiveHour means THE BINDING BURST CONSTRAINT, not "the plan limit's" (${JSON.stringify(view.fiveHour)})`);
    ok(view.scopedWeekly && view.scopedWeekly.length === 1 && view.scopedWeekly[0].utilization === 0.1,
      '⑯c …and nothing was collapsed: the Spark WEEKLY window is still its own scoped row');

    // POSITIVE CONTROL: the plan limit still wins when it is the binding one —
    // this is a min, not "the model limit always".
    const setPlanBinds = QM.mergeLimitSets(
      CODEXQ.toLimitSet(CODEX_PLAN_FULL, { identity: 'cx2', source: 'codex-rate-limits', fetchedAt: T0 }),
      CODEXQ.toLimitSet(sparkSpent, { identity: 'cx2', source: 'codex-rate-limits', fetchedAt: T0 + 3000 }),
    );
    ok(POOL.accountRemaining(QM.toLegacyView(setPlanBinds), nowC).remaining === 0,
      '⑯c POSITIVE CONTROL: a SPENT plan limit still decides — the projection is a min, not a preference for model caps');
    // POSITIVE CONTROL: an EMPTY model burst window is not a candidate (it makes
    // no claim), so the plan's own bucket is what the view shows.
    const setEmptySpark = QM.mergeLimitSets(
      CODEXQ.toLimitSet(CODEX_PLAN, { identity: 'cx3', source: 'codex-rate-limits', fetchedAt: T0 }),
      CODEXQ.toLimitSet(sparkAt(T0), { identity: 'cx3', source: 'codex-rate-limits', fetchedAt: T0 }),
    );
    const vEmpty = QM.toLegacyView(setEmptySpark);
    ok(POOL.accountRemaining(vEmpty, nowC).remaining === 95,
      '⑯c POSITIVE CONTROL: an EMPTY Spark burst window never displaces the plan bucket (§⑫’s 0 % direction still holds)');

    // THE PROPERTY, DERIVED RATHER THAN ENUMERATED. The hole existed because
    // one window KIND had nowhere to go in the projection; the guard against
    // the next one is not a list of kinds but the invariant itself, driven over
    // every shape this suite knows how to build.
    const shapes = [];
    for (const planW of [null, CODEX_PLAN, CODEX_PLAN_FULL]) {
      for (const modelW of [null, sparkAt(T0), sparkSpent]) {
        if (!planW && !modelW) continue;
        let s = QM.makeLimitSet({ identity: 'p', fetchedAt: T0 });
        if (planW) s = QM.mergeLimitSets(s, CODEXQ.toLimitSet(planW, { identity: 'p', source: 'codex-rate-limits', fetchedAt: T0 }));
        if (modelW) s = QM.mergeLimitSets(s, CODEXQ.toLimitSet(modelW, { identity: 'p', source: 'codex-rate-limits', fetchedAt: T0 + 3000 }));
        shapes.push(s);
      }
    }
    // …plus a claude-shaped set (model caps are weekly-only there — the rule
    // must be one rule, with no backend branch, and must not disturb claude).
    shapes.push(QM.fromLegacy({
      fiveHour: { utilization: 0.71, resetsAt: nowC + 2 * 3600 },
      sevenDay: { utilization: 0.44, resetsAt: nowC + 3 * 86400 },
      scopedWeekly: [{ name: 'Fable', utilization: 0.93, resetsAt: nowC + 3 * 86400 }],
    }, { identity: 'cl', fetchedAt: T0, limitId: 'plan', familyOf: familyOfScopedBucket }));
    // …and a set whose model burst window has ROLLED OVER while the plan's
    // still binds. The first version of this matrix had only future resets, so
    // the property could not see ⑯d — the defect this very fix introduced.
    shapes.push(QM.makeLimitSet({
      identity: 'rolled', fetchedAt: T0, source: 'codex-rate-limits',
      limits: [
        QM.makeLimit({ limitId: 'codex', scope: 'plan', fetchedAt: T0, windows: [{ kind: '5h', minutes: 300, usedPct: 50, resetsAt: nowC + 3000, measuredAt: T0 }] }),
        QM.makeLimit({ limitId: 'codex_spark', name: 'Spark', scope: 'model', model: 'Spark', fetchedAt: T0, windows: [{ kind: '5h', minutes: 300, usedPct: 90, resetsAt: nowC - 60, measuredAt: T0 - 7200000 }] }),
      ],
    }));
    // The view is asked with the SAME clock as the accessor: "which window
    // binds" is a question about now, so comparing a real-clock projection with
    // a `nowC` accessor would measure the leg's own inconsistency, not the
    // product's.
    // …and a set whose window states a RESET but no number. r4's own positive
    // control caught the projection writing `utilization: 0` for it — "the
    // vendor said nothing" rendered as "the vendor said zero" — which is a
    // violation the ORIGINAL property could not see, because it compared two
    // KNOWN answers and here the accessor is the one that says nothing. So the
    // property grew a second clause (`moreOptimistic`), and the shape that
    // exposed the blind spot is in the matrix beside it.
    shapes.push(QM.makeLimitSet({
      identity: 'mute', fetchedAt: T0, source: 'cli-usage',
      limits: [QM.makeLimit({ limitId: 'plan', scope: 'plan', fetchedAt: T0, windows: [{ kind: '5h', usedPct: null, resetsAt: nowC + 3600, measuredAt: T0 }] })],
    }));
    // CLAIMING TO KNOW IS ITSELF AN OPTIMISM. `known:false` costs a member
    // UNKNOWN_REMAINING_PCT; `known:true` at a number the set cannot support is
    // a headroom the model never stated.
    //
    // WHAT THIS PROPERTY STRUCTURALLY CANNOT SEE, stated so the next round does
    // not over-trust it: it compares two PROJECTIONS of one set, so an error
    // both of them make is invisible here — and that is precisely the r4 defect
    // (§⑯e), where the view and the accessor agreed that a free member had no
    // reading. A property that bounds A against B guards the SEAM, never the
    // shared rule underneath it; the rule itself needs a leg that names an
    // answer, which ⑯e is.
    const moreOptimistic = (a, v) => (v.known && !a.known) || (a.known && v.known && v.remaining > a.remaining + 1e-9);
    const optimistic = shapes.filter((s) => moreOptimistic(QM.remaining(s, { nowSec: nowC }), POOL.accountRemaining(QM.toLegacyView(s, { nowSec: nowC }), nowC)));
    propShapes = shapes; propNow = nowC; propOpt = moreOptimistic;
    ok(shapes.length === 11, `⑯c PROPERTY scope is non-vacuous (${shapes.length} shapes, codex plan × model × claude × a rolled-over burst window × a numberless one)`);
    ok(!optimistic.length,
      `⑯c PROPERTY: over every shape, the derived view is NEVER more optimistic than the accessor — including by CLAIMING TO KNOW (${optimistic.length} violations)`);

    // NEGATIVE CONTROL: read fiveHour off the plan limit alone again.
    const wC = mutantWorld('c', [QMFILE], { [QMFILE]: [['const f5 = toBucket(bind5 || planW5);', 'const f5 = toBucket(planW5);']] });
    patchHit(wC, '⑯c restores the plan-only fiveHour projection');
    const QMpre = load(wC, QMFILE);
    const vPre = QMpre.toLegacyView(set);
    const poolPre = POOL.accountRemaining(vPre, nowC);
    ok(vPre.fiveHour === undefined && poolPre.remaining === 90,
      `⑯c NEGATIVE CONTROL: the Spark burst window vanishes and the pool reads ${poolPre.remaining} % where the accessor says ${acc.remaining} % (${JSON.stringify(vPre.fiveHour)})`);
    // …and that this was a REGRESSION, not merely a gap: the pre-model commit's
    // last-writer-wins collapse kept the Spark 5h and answered 10 %.
    const collapsed = { ...CODEXQ.normalizeCodexRateLimit(CODEX_PLAN, T0), ...CODEXQ.normalizeCodexRateLimit(sparkSpent, T0 + 3000) };
    ok(POOL.accountRemaining(collapsed, nowC).remaining === 10,
      '⑯c NEGATIVE CONTROL: …while the collapse this model REPLACED answered 10 % — the projection had made the answer worse');
    const violPre = shapes.filter((s) => moreOptimistic(QM.remaining(s, { nowSec: nowC }), POOL.accountRemaining(QMpre.toLegacyView(s, { nowSec: nowC }), nowC)));
    ok(violPre.length > 0, `⑯c NEGATIVE CONTROL: …and the PROPERTY itself goes red on the same matrix (${violPre.length} violations)`);
  }

  // ── ⑯d "MORE CONSTRAINED" IS A QUESTION ABOUT NOW ─────────────────────────
  // Found by driving ⑯c's own property with a PASSED reset, i.e. by this
  // branch mutation-testing its own new leg. ⑯c's first spelling ranked the
  // 5-hour windows by raw `usedPct`, which is not what "binding" means: a
  // window whose reset has passed rolled over since we read it, so its stale
  // utilization means nothing and it is FULL (`windowRemaining`'s rule, and
  // `bucketRemaining` — the pool's — applies it to whatever bucket we emit).
  // A 90 %-spent-but-rolled-over model window therefore DISPLACED a plan
  // window with a real 50 % left, and the view came out MORE optimistic than
  // the set: the exact defect ⑯c exists to prevent, inside the fix for it.
  console.log('\n  ⑯d the binding burst window is decided on remaining, not on raw percentage');
  {
    const nowD = 1788970000, T = nowD * 1000;
    const mk = (planPct, plan5Reset, modelPct, model5Reset) => QM.makeLimitSet({
      identity: 'cx', fetchedAt: T, source: 'codex-rate-limits',
      limits: [
        QM.makeLimit({
          limitId: 'codex', scope: 'plan', fetchedAt: T, windows: [
            { kind: '5h', minutes: 300, usedPct: planPct, resetsAt: plan5Reset, measuredAt: T },
            { kind: '7d', minutes: 10080, usedPct: 10, resetsAt: nowD + 300000, measuredAt: T },
          ],
        }),
        QM.makeLimit({
          limitId: 'codex_spark', name: 'Spark', scope: 'model', model: 'Spark', fetchedAt: T,
          windows: [{ kind: '5h', minutes: 300, usedPct: modelPct, resetsAt: model5Reset, measuredAt: T - 7200000 }],
        }),
      ],
    });
    // The model window reads 90 % spent, but its reset PASSED ⇒ it is full.
    const rolled = mk(50, nowD + 3000, 90, nowD - 60);
    const accD = QM.remaining(rolled, { nowSec: nowD });
    const poolD = POOL.accountRemaining(QM.toLegacyView(rolled, { nowSec: nowD }), nowD);
    ok(accD.remaining === 50 && poolD.remaining === 50,
      `⑯d a rolled-over model window never displaces a plan window that really binds (accessor ${accD.remaining} %, pool ${poolD.remaining} %)`);
    // POSITIVE CONTROL: while it is genuinely running, it still takes the slot.
    const live = mk(50, nowD + 3000, 90, nowD + 1200);
    ok(POOL.accountRemaining(QM.toLegacyView(live, { nowSec: nowD }), nowD).remaining === 10,
      '⑯d POSITIVE CONTROL: …while a RUNNING model window at 90 % still binds (the rule is not "prefer the plan")');
    // THE PLAN WINS EVERY TIE — this is ⑭'s invariant, and after ⑯c it depends
    // on the plan window being SEEDED rather than on iteration order. Every
    // window of a set read long after it was measured ties at 100.
    const stale = mk(50, nowD - 600, 90, nowD - 60);
    const vStale = QM.toLegacyView(stale, { nowSec: nowD });
    ok(vStale.fiveHour && vStale.fiveHour.utilization === 0.5,
      `⑯d when every 5h window has rolled over they TIE at 100 %, and the plan's is the one emitted (${JSON.stringify(vStale.fiveHour)})`);

    // NEGATIVE CONTROL: rank by raw percentage again (⑯c's first spelling).
    const wD = mutantWorld('d', [QMFILE], {
      [QMFILE]: [["const rank = (w) => (w && w.state === 'running' ? windowRemaining(w, now) : null);",
        "const rank = (w) => (w && w.state === 'running' && w.usedPct != null ? 100 - w.usedPct : null);"]],
    });
    patchHit(wD, '⑯d ranks the 5h windows by raw usedPct again');
    const QMd = load(wD, QMFILE);
    const poolPreD = POOL.accountRemaining(QMd.toLegacyView(rolled, { nowSec: nowD }), nowD);
    ok(poolPreD.remaining === 90,
      `⑯d NEGATIVE CONTROL: ranking on the raw percentage reads ${poolPreD.remaining} % where the accessor says ${accD.remaining} % — the view is more optimistic than the set`);
    ok(POOL.accountRemaining(QMd.toLegacyView(live, { nowSec: nowD }), nowD).remaining === 10,
      '⑯d NEGATIVE CONTROL: …and it is right about the RUNNING case, which is why only the passed reset exposes it');
    // THE PROPERTY NOW COVERS IT. ⑯c's matrix had only future resets, so this
    // defect walked straight through the guard written to prevent its whole
    // class. A property is worth exactly the shapes it is driven over, so the
    // matrix earning its keep is itself an assertion.
    const violD = (propShapes || []).filter((s) => propOpt(QM.remaining(s, { nowSec: propNow }), POOL.accountRemaining(QMd.toLegacyView(s, { nowSec: propNow }), propNow)));
    ok(propShapes && propShapes.length === 11 && violD.length > 0,
      `⑯d …and ⑯c's PROPERTY, once its matrix carries a rolled-over window, goes red on this mutant too (${violD.length} violations over ${propShapes ? propShapes.length : 0} shapes) — it could not before`);
  }

  // ── ⑯e A FREE MEMBER IS NOT AN UNKNOWN ONE ────────────────────────────────
  // The r4 verifier's finding, reproduced end to end before it was fixed. r3
  // asked ONE predicate — "may this bucket name a deadline" — of BOTH questions
  // a bucket answers, so a window the vendor reported at 0 % used was dropped
  // from the REMAINING as well. A fully free member then read back to the pool
  // as "no usage data", which is not neutral: it ranks at UNKNOWN_REMAINING_PCT
  // (50), it is never `usable === true`, and it is not settleable — so a pool
  // sitting on an EXHAUSTED member would not move onto it.
  //
  // The fix splits the two questions (`bucketStatesSpend` / `windowStatesSpend`
  // beside `bucketCounts` / `countingWindows`). B-8b12 is untouched: an empty
  // window still names no deadline, still never anchors, and still publishes no
  // reset. The POSITIVE CONTROLS below are what make that a measurement.
  console.log('\n  ⑯e a window the vendor reported at 0 % is 100 % free, not "no usage data"');
  {
    // PURE: the two predicates, and the P6 line between "said zero" and "said
    // nothing" (`Number(null)` is 0 — which is why `num()` and not `Number()`).
    ok(QM.windowStatesSpend({ usedPct: 0 }) === true && QM.bucketStatesSpend({ utilization: 0 }) === true,
      '⑯e a stated 0 % IS a claim, in both spellings');
    ok(QM.windowStatesSpend({ usedPct: null }) === false && QM.bucketStatesSpend({ utilization: null }) === false
      && QM.bucketStatesSpend({}) === false && QM.bucketStatesSpend({ utilization: '' }) === false,
      '⑯e POSITIVE CONTROL: …and a bucket with no number is not — `Number(null)` is 0, `num(null)` is null (P6)');
    ok(QM.bucketCounts({ utilization: 0, state: 'empty' }) === false && QM.bucketCounts({ utilization: 0, state: 'unknown' }) === false,
      '⑯e POSITIVE CONTROL: the DEADLINE predicate is unchanged — an empty window still names no deadline (B-8b12)');

    // REACHABILITY, from the product's own parser. This is the ordinary shape,
    // not a corner: the `· resets` clause of a claude panel line is optional
    // and `refreshViaCliPanel` refuses to project the 5-hour one, so a
    // brand-new account — which has no prior reset to carry forward either —
    // comes back with BOTH plan buckets at 0 % and no reset anywhere.
    const fresh = CLAUDEQ.parseCliUsageText('Current session:  0% used\nCurrent week (all models):  0% used', NOW);
    ok(fresh && fresh.fiveHour.utilization === 0 && fresh.fiveHour.resetsAt === undefined
      && fresh.sevenDay.utilization === 0 && fresh.sevenDay.resetsAt === undefined,
      `⑯e REACHABILITY: a real panel for an untouched account parses to two reset-less 0 % buckets (${JSON.stringify(fresh)})`);

    // PRODUCT, end to end, through the one write path: an EXHAUSTED current
    // member and a brand-new one beside it.
    const eWorld = (Q) => {
      const dir = scratch();
      const P = Q.POOL || POOL;
      Q.W.writeCacheObject({ cacheDir: dir, key: 'NEW', obj: { ...fresh, fetchedAt: NOW }, measuredAt: NOW, source: 'cli-usage', backend: 'claude' });
      Q.W.writeCacheObject({ cacheDir: dir, key: 'CUR', obj: { fiveHour: { utilization: 0.2, resetsAt: nowSec + 3600 }, sevenDay: { utilization: 0.96, resetsAt: nowSec + 86400 }, fetchedAt: NOW }, measuredAt: NOW, source: 'cli-usage', backend: 'claude' });
      const caches = { NEW: rd(dir, 'NEW'), CUR: rd(dir, 'CUR') };
      const verdicts = ['CUR', 'NEW'].map((id) => ({ id, v: P.quotaVerdict(caches[id], nowSec) }));
      return {
        caches, verdicts,
        rem: P.accountRemaining(caches.NEW, nowSec),
        dl: P.weeklyDeadline(caches.NEW, nowSec),
        rems: P.bucketRems(caches.NEW, nowSec),
        anchors: anchorBuckets(caches.NEW),
        ranked: P.rankPoolMembers({ members: [{ id: 'CUR', name: 'Current' }, { id: 'NEW', name: 'BrandNew' }], readCache: (id) => caches[id] ?? null, nowSec }),
        dec: P.decidePoolSwitch({ currentId: 'CUR', members: [{ id: 'CUR', name: 'Current' }, { id: 'NEW', name: 'BrandNew' }], readCache: (id) => caches[id] ?? null, nowSec, hot: true, explain: true }),
        // THE ENGINE'S OWN GATE, applied verbatim (pinned below): a pool is
        // usable only if some member's verdict is exactly `true`.
        poolUsable: verdicts.find((x) => x.v.usable === true) || null,
      };
    };
    const e = eWorld({ W, CAP });
    ok(e.caches.NEW.fiveHour.state === 'unknown' && e.caches.NEW.sevenDay.state === 'unknown',
      `⑯e SETUP: both buckets land stamped 'unknown' — untouched and just-started are genuinely indistinguishable without a reset (${JSON.stringify(e.caches.NEW.fiveHour)})`);
    ok(e.rem.known && e.rem.remaining === 100,
      `⑯e the free member reads 100 % remaining, KNOWN (${JSON.stringify(e.rem)})`);
    ok(e.verdicts.find((x) => x.id === 'NEW').v.usable === true,
      `⑯e …its verdict is usable (${JSON.stringify(e.verdicts.find((x) => x.id === 'NEW').v.reason)})`);
    ok(e.poolUsable && e.poolUsable.id === 'NEW',
      `⑯e …so the POOL has a usable member (${JSON.stringify(e.poolUsable && e.poolUsable.id)})`);
    ok((e.ranked.find((r) => r.id === 'NEW') || {}).eff === 100,
      `⑯e …it ranks on its real headroom, not on UNKNOWN_REMAINING_PCT (${JSON.stringify(e.ranked)})`);
    ok(e.dec && e.dec.to === 'NEW' && e.dec.reason === 'exhausted',
      `⑯e …and the pool LEAVES the exhausted member for it (${JSON.stringify({ to: e.dec && e.dec.to, why: e.dec && e.dec.reason })})`);

    // POSITIVE CONTROLS — B-8b12 is not re-opened by any of that.
    ok(e.dl === null,
      `⑯e POSITIVE CONTROL: the free member still has NO weekly deadline — a reset-less/sliding window may not be ranked on (${e.dl})`);
    ok(e.anchors.fiveHour === null && e.anchors.sevenDay === null,
      `⑯e POSITIVE CONTROL: …and neither bucket ANCHORS: the estimator learns from windows that ran, not from ones that never opened (${JSON.stringify(e.anchors)})`);
    ok(e.rems.length === 2 && e.rems.every((r) => r.remaining === 100 && r.resetsAt === 0),
      `⑯e POSITIVE CONTROL: …the report states the headroom and publishes NO reset, so nothing downstream can turn one into a blockedUntil (${JSON.stringify(e.rems)})`);
    // A bucket with NO number at all is still ignorance, not 100 %.
    {
      const dir = scratch();
      W.writeCacheObject({ cacheDir: dir, key: 'MUTE', obj: { fiveHour: { resetsAt: nowSec + 3600 }, fetchedAt: NOW }, measuredAt: NOW, source: 'cli-usage', backend: 'claude' });
      const mute = rd(dir, 'MUTE');
      ok(POOL.accountRemaining(mute, nowSec).known === false,
        `⑯e POSITIVE CONTROL: a bucket the vendor gave no number for is still UNKNOWN — the fix follows the STATED spend, it does not assume zero (${JSON.stringify(POOL.accountRemaining(mute, nowSec))})`);
    }
    // …and a genuinely SPENT account is still refused (the fix is a min, so a
    // 100 %-free bucket can never lift another bucket's exhaustion).
    ok(e.verdicts.find((x) => x.id === 'CUR').v.usable === false,
      `⑯e POSITIVE CONTROL: the exhausted member is still refused (${JSON.stringify(e.verdicts.find((x) => x.id === 'CUR').v.reason)})`);

    // WIRING PIN: the gate this leg models is the engine's, verbatim. If the
    // engine stops asking `usable === true`, the sentence above stops being
    // about the product.
    const engSrc = fs.readFileSync(path.join(ROOT, 'src/server/usage-pool-engine.js'), 'utf8');
    ok(engSrc.includes('const ok = verdicts.find((x) => x.v.usable === true);'),
      '⑯e WIRING PIN: the pool gate really is `verdicts.find((x) => x.v.usable === true)` — a member reading `usable:null` can never satisfy it');

    // THE MIGRATION, on the shape this instance actually holds. `usage-cache/
    // __global_codex__.json` is the measured B-8b12 file — the Spark limit
    // alone, both windows fresh — and running this branch's own backfill over a
    // copy of the real directory flipped exactly that one file (12 scanned /
    // 12 stamped / 31 limits / idempotent) from usable to "no usage data".
    // Driven here on the corpus's anonymised twin.
    {
      const dir = scratch();
      const legacy = { ...CODEXQ.normalizeCodexRateLimit(sparkAt(NOW), NOW), fetchedAt: NOW, source: 'codex-rate-limits' };
      fs.writeFileSync(path.join(dir, '__global_codex__.json'), JSON.stringify(legacy));
      const { backfillLimits } = require(path.join(ROOT, 'src/quota-model-migrate.js'));
      const res = backfillLimits({ cacheDir: dir, archiveDir: path.join(dir, 'archive'), id: 'test', log: () => { } });
      const after = rd(dir, '__global_codex__');
      ok(res.stamped === 1 && Array.isArray(after.limits),
        `⑯e MIGRATION: the backfill stamps the file (${JSON.stringify({ scanned: res.scanned, stamped: res.stamped, limits: res.limits })})`);
      ok(POOL.quotaVerdict(after, nowSec).usable === true && POOL.weeklyDeadline(after, nowSec) === null,
        `⑯e MIGRATION: …and the account it describes stays USABLE with no fabricated deadline (${JSON.stringify(POOL.quotaVerdict(after, nowSec).reason)})`);
      migAfter = after;
    }

    // NEGATIVE CONTROL: ask the DEADLINE predicate about the REMAINING again —
    // r3, with everything else on this branch intact.
    const wE = mutantWorld('e', [QMFILE, WFILE, CFILE, PFILE], {
      [QMFILE]: [['    for (const w of spendingWindows(l)) {', '    for (const w of countingWindows(l)) {']],
      [PFILE]: [['  if (!bucketStatesSpend(b)) return null;', '  if (!bucketCounts(b)) return null;']],
    });
    patchHit(wE, '⑯e restores the single predicate (the deadline rule asked about the remaining)');
    const POOLpre = load(wE, PFILE), QMpreE = load(wE, QMFILE);
    const preE = eWorld({ W: load(wE, WFILE), CAP: load(wE, CFILE), POOL: POOLpre });
    ok(preE.rem.known === false,
      `⑯e NEGATIVE CONTROL: the free member reads "no usage data" (${JSON.stringify(preE.rem)})`);
    ok(preE.verdicts.find((x) => x.id === 'NEW').v.usable === null && preE.poolUsable === null,
      `⑯e NEGATIVE CONTROL: …its verdict is ${JSON.stringify(preE.verdicts.find((x) => x.id === 'NEW').v.reason)}, so the POOL has no usable member at all`);
    ok((preE.ranked.find((r) => r.id === 'NEW') || {}).eff === POOLpre.UNKNOWN_REMAINING_PCT,
      `⑯e NEGATIVE CONTROL: …it ranks at UNKNOWN_REMAINING_PCT instead of 100 (${JSON.stringify(preE.ranked)})`);
    ok(preE.dec && preE.dec.to === null && preE.dec.reason === 'no-settleable',
      `⑯e NEGATIVE CONTROL: …and the pool STAYS on the exhausted member (${JSON.stringify({ to: preE.dec && preE.dec.to, why: preE.dec && preE.dec.reason, from: preE.dec && preE.dec.fromRemaining })})`);
    ok(POOLpre.quotaVerdict(migAfter, nowSec).usable === null,
      `⑯e NEGATIVE CONTROL: …and the migrated real-shape file goes dark too (${JSON.stringify(POOLpre.quotaVerdict(migAfter, nowSec).reason)})`);
    // The ACCESSOR half needs its own control: the pool reads the view today,
    // but `remaining()` is the path every migrated reader will take.
    const setE = W.limitsOfCache(e.caches.NEW, { identity: 'NEW' });
    ok(QM.remaining(setE, { nowSec }).remaining === 100 && QMpreE.remaining(setE, { nowSec }).known === false,
      `⑯e NEGATIVE CONTROL: …and the typed accessor moves with it (${JSON.stringify(QM.remaining(setE, { nowSec }))} vs ${JSON.stringify(QMpreE.remaining(setE, { nowSec }))})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑰ THE ROUND-4 DEFECTS: who MEASURED this limit, and who may RETIRE one.
//
// Both were found by an adversarial verifier against the round-3 branch and
// both were reproduced against a copy of this instance's own post-migration
// cache file before anything was changed. They share a root: `writeCacheObject`
// lifts a LEGACY object, and a legacy object is ONE reading spread over a
// carry-forward of everything else — the lift could not tell the halves apart,
// so it stamped the whole file with this producer's name and clock (⑰a) while
// `mergeLimitSets` let nobody ever say a limit was gone (⑰b).
//
// These legs drive the REAL producers through the REAL write path — the §17
// panel leg in test-readings-attribution feeds a HAND-BUILT `limits` array and
// never goes through the write path, which is exactly why 659 green asserts
// said nothing about either defect.
console.log('\n⑰ per-limit provenance and the right to retire a limit');
{
  const MUT17 = `vs-qmr4-mut-${process.pid}-`;
  // Same crashed-run sweep as ⑯: a SIGKILLed suite must never leave a sibling
  // in src/ that dirties the tree and blocks the release gate.
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
      const m = /^vs-qmr4-mut-(\d+)-/.exec(f);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); continue; } catch { }
      try { fs.unlinkSync(path.join(ROOT, 'src', f)); } catch { }
    }
  } catch { }
  const mutants17 = [];
  process.on('exit', () => { for (const f of mutants17) { try { fs.unlinkSync(f); } catch { } } });
  const mutantWorld17 = (tag, names, patches) => {
    const out = {}, hits = [];
    const nameOf = (n) => `${MUT17}${tag}-${path.basename(n)}`;
    for (const n of names) {
      let src = fs.readFileSync(path.join(ROOT, n), 'utf8');
      for (const other of names) {
        const rel = './' + path.basename(other);
        if (src.includes(`require('${rel}')`)) src = src.split(`require('${rel}')`).join(`require('./${nameOf(other)}')`);
      }
      for (const [from, to] of (patches[n] || [])) {
        hits.push([n, src.split(from).length - 1]);
        src = src.split(from).join(to);
      }
      const dst = path.join(ROOT, 'src', nameOf(n));
      fs.writeFileSync(dst, src);
      mutants17.push(dst);
      out[n] = dst;
    }
    return { out, hits };
  };
  const load17 = (w, n) => require(w.out[n]);
  const hit17 = (w, label) => ok(w.hits.length > 0 && w.hits.every(([, c]) => c === 1),
    `⑰ NEGATIVE CONTROL setup: ${label} — every patch anchor hit exactly once (${JSON.stringify(w.hits)})`);

  const WF = 'src/usage-cache-write.js', QF = 'src/quota-model.js', CF = 'src/rate-limit-capture.js';
  const CAP17 = require(path.join(ROOT, 'src/rate-limit-capture.js'));
  const SRC = require(path.join(ROOT, 'src/lib/usage-source.js'));

  const T17 = 1788974610137;                 // the real file's own fetchedAt
  const OVER_AT = 1788911228197;             // …and its overage limit's own asOf
  const NOW17 = T17 + 607363;                // the event, ~10 min later

  // THE REAL SHAPE, verbatim from this instance's `usage-cache/sub-*.json`
  // (anonymised: the org/email fields are dropped, no ids, no tokens). Three
  // limits after the backfill — plan, the Fable model cap, and overage — each
  // with its own producer and its own age.
  const realShape = () => ({
    fiveHour: { utilization: 0 },
    sevenDay: { utilization: 0.83, resetsAt: 1789318800 },
    scopedWeekly: [{ name: 'Fable', utilization: 1, resetsAt: 1789318800 }],
    overallStatus: 'allowed',
    fetchedAt: T17, source: 'on-demand', scopedFetchedAt: T17 + 2,
    overage: { inUse: false, asOf: OVER_AT, status: 'rejected', disabledReason: 'org_level_disabled' },
  });

  /** Migrate the real-shape file into a dir, then fire ONE five-hour
   *  rate_limit_event through the REAL producer. `Wm`/`Cm` let a control swap
   *  in a patched copy of the write path / the producer. */
  const runEvent = (Wm, Cm) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm17-${process.pid}-`));
    const key = 'sub-anon';
    // the migration's own stamping rung, driven through the write path under test
    const set0 = Wm.liftCacheObject(realShape(), { identity: key, familyOf: familyOfScopedBucket });
    Wm.writeCacheObject({ cacheDir: dir, key, obj: realShape(), set: set0, replace: true, familyOf: familyOfScopedBucket, source: 'on-demand' });
    const before = Wm.readCacheObject(dir, key);
    Cm.captureRateLimitEvent({
      cacheDir: dir, key, identityIds: [key], now: NOW17, familyOf: familyOfScopedBucket,
      ev: { kind: 'fiveHour', rawType: 'five_hour', status: 'allowed', utilization: 0.88, resetsAt: 0, overage: {} },
    });
    return { dir, key, before, after: Wm.readCacheObject(dir, key) };
  };
  const limOf = (obj, id) => (obj.limits || []).find((l) => l && l.limitId === id) || null;

  // ── ⑰a a limit this write only CARRIED FORWARD keeps its own producer ──────
  {
    const r = runEvent(W, CAP17);
    const b = { plan: limOf(r.before, 'plan'), fable: limOf(r.before, 'model:fable'), over: limOf(r.before, 'overage') };
    ok(b.plan && b.fable && b.over && b.fable.source === 'on-demand' && b.fable.fetchedAt === T17,
      `⑰a the migrated real-shape file holds three limits, each with its own producer (${(r.before.limits || []).map((l) => `${l.limitId}:${l.source}@${l.fetchedAt}`).join(' | ')})`);

    const a = { plan: limOf(r.after, 'plan'), fable: limOf(r.after, 'model:fable'), over: limOf(r.after, 'overage') };
    ok(a.plan.source === 'rate-limit-event' && a.plan.fetchedAt === NOW17,
      `⑰a the PLAN limit — the one this event measured — is re-stamped with the producer and its clock (${a.plan.source}@${a.plan.fetchedAt})`);
    const w5 = QM.windowOfKind(a.plan, '5h');
    ok(w5 && w5.usedPct === 88 && w5.measuredAt === NOW17,
      `⑰a …and the reading LANDED (5h ${w5 && w5.usedPct}% measured at ${w5 && w5.measuredAt})`);
    ok(a.fable.source === 'on-demand' && a.fable.fetchedAt === T17,
      `⑰a the model-scoped cap — which this record says NOTHING about — keeps the producer that measured it (${a.fable.source}@${a.fable.fetchedAt})`);
    const wf = QM.windowOfKind(a.fable, '7d');
    ok(wf && wf.measuredAt === T17 && wf.usedPct === 100,
      `⑰a …down to the instant its window was measured (${wf && wf.measuredAt}, still ${wf && wf.usedPct}%)`);
    ok(a.over.source === 'on-demand' && a.over.fetchedAt === OVER_AT,
      `⑰a the overage limit likewise (${a.over.source}@${a.over.fetchedAt})`);
    // The 7d window of the plan limit was carried forward INSIDE a limit this
    // event did measure: the limit is the producer's, the untouched window is
    // still the panel-read's.
    const w7 = QM.windowOfKind(a.plan, '7d');
    ok(w7 && w7.usedPct === 83 && w7.measuredAt === T17,
      `⑰a a window carried forward inside a MEASURED limit keeps its own measuredAt too (7d ${w7 && w7.usedPct}% @${w7 && w7.measuredAt})`);

    // THE USER-VISIBLE HALF: the panel rows this feature added.
    const rows = SRC.limitRows(QM, W.limitsOfCache(r.after, { identity: r.key }), { t: (s) => s });
    const rowF = rows.find((x) => x.limitId === 'model:fable');
    ok(rowF && rowF.source === 'on-demand' && rowF.fetchedAt === T17,
      `⑰a …so the panel row says "via ${rowF && rowF.sourceLabel}" and dates it ${rowF && rowF.fetchedAt}, not "just now"`);

    // NEGATIVE CONTROL: the round-3 write path, which lifted the whole object.
    const wA = mutantWorld17('a', [WF, QF], {
      [WF]: [['    next = carryUnmeasuredLimits(prevSet, next);\n', '']],
    });
    hit17(wA, '⑰a removes the carried-forward rule');
    const CAPa = mutantWorld17('ac', [CF], { [CF]: [["require('./usage-cache-write.js')", `require('./${MUT17}a-usage-cache-write.js')`]] });
    hit17(CAPa, '⑰a re-points the real producer at the patched write path');
    const pre = runEvent(load17(wA, WF), load17(CAPa, CF));
    const pf = limOf(pre.after, 'model:fable'), po = limOf(pre.after, 'overage');
    ok(pf.source === 'rate-limit-event' && pf.fetchedAt === NOW17,
      `⑰a NEGATIVE CONTROL: the pre-fix path stamps the Fable cap as this producer's, just now (${pf.source}@${pf.fetchedAt})`);
    ok(QM.windowOfKind(pf, '7d').measuredAt === NOW17,
      `⑰a NEGATIVE CONTROL: …and moves the window's measuredAt onto a number nobody re-measured (${QM.windowOfKind(pf, '7d').measuredAt})`);
    ok(po.source === 'rate-limit-event',
      `⑰a NEGATIVE CONTROL: …and the overage limit too (${po.source})`);
    const preRows = SRC.limitRows(QM, load17(wA, WF).limitsOfCache(pre.after, { identity: pre.key }), { t: (s) => s });
    ok((preRows.find((x) => x.limitId === 'model:fable') || {}).fetchedAt === NOW17,
      '⑰a NEGATIVE CONTROL: …which is the sentence the panel row printed');

    // SECOND NEGATIVE CONTROL, ONE MECHANISM: keep the rule but resolve it per
    // LIMIT instead of per WINDOW (this fix's own round-1 shape). Everything
    // above stays green — only the carried-forward 7-day window inside the
    // MEASURED plan limit moves, which is why it needs its own control.
    const wW = mutantWorld17('w', [WF, QF], {
      [WF]: [['    for (const w of quotaModel.windowsOf(prev)) if (w) prevByKind.set(w.kind, w);\n', '']],
    });
    hit17(wW, '⑰a resolves the rule per LIMIT instead of per WINDOW');
    const CAPw = mutantWorld17('wc', [CF], { [CF]: [["require('./usage-cache-write.js')", `require('./${MUT17}w-usage-cache-write.js')`]] });
    hit17(CAPw, '⑰a re-points the real producer at the per-limit copy');
    const preW = runEvent(load17(wW, WF), load17(CAPw, CF));
    const pwPlan = limOf(preW.after, 'plan'), pwFable = limOf(preW.after, 'model:fable');
    ok(QM.windowOfKind(pwPlan, '7d').measuredAt === NOW17 && QM.windowOfKind(pwPlan, '7d').usedPct === 83,
      `⑰a NEGATIVE CONTROL: per-LIMIT granularity re-clocks the 7-day number this event never mentioned (@${QM.windowOfKind(pwPlan, '7d').measuredAt})`);
    ok(pwFable.source === 'on-demand' && pwFable.fetchedAt === T17,
      '⑰a NEGATIVE CONTROL: …while the wholly-untouched limits are unaffected, so only the window leg can catch it');
  }

  // ── ⑰b only a producer that ENUMERATED may retire a limit ─────────────────
  {
    const POOL17 = require(path.join(ROOT, 'src/account-pool-auto.js'));
    const nowSec = Math.floor(Date.now() / 1000);
    const now = nowSec * 1000;
    const panel = (scoped, at) => ({
      fiveHour: { utilization: 0.2, resetsAt: nowSec + 3600 },
      sevenDay: { utilization: 0.2, resetsAt: nowSec + 500000 },
      scopedWeekly: scoped, fetchedAt: at, source: 'on-demand',
    });
    const TWO = [{ name: 'OldModel', utilization: 1, resetsAt: nowSec + 300 }, { name: 'Fable', utilization: 0.1, resetsAt: nowSec + 500000 }];
    const ONE = [{ name: 'Fable', utilization: 0.1, resetsAt: nowSec + 500000 }];

    /** Two panel reads: the first lists two model caps, the second lists only
     *  one — the shape a cap retirement/rename produces. */
    const runPanel = (Wm, { authoritative = true } = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm17b-${process.pid}-`));
      const key = 'acct';
      const one = (scoped, at) => Wm.writeCacheObject({
        cacheDir: dir, key, obj: panel(scoped, at), measuredAt: at, source: 'on-demand',
        familyOf: familyOfScopedBucket, backend: 'claude',
        authoritativeScopes: authoritative && scoped.length ? ['model'] : null,
      });
      one(TWO, now);
      const mid = Wm.readCacheObject(dir, key);
      one(ONE, now + 1000);
      return { dir, key, mid, after: Wm.readCacheObject(dir, key) };
    };

    const r = runPanel(W);
    ok(POOL17.accountRemaining(r.mid, nowSec).remaining === 0,
      `⑰b with BOTH caps reported, the exhausted one governs the account (${JSON.stringify(POOL17.accountRemaining(r.mid, nowSec))})`);
    ok(!limOf(r.after, 'model:oldmodel') && !!limOf(r.after, 'model:fable'),
      `⑰b the next panel read names only one cap, and the one it dropped is RETIRED (${(r.after.limits || []).map((l) => l.limitId).join(',')})`);
    ok((r.after.scopedWeekly || []).length === 1 && r.after.scopedWeekly[0].name === 'Fable',
      `⑰b …the derived view follows (${JSON.stringify(r.after.scopedWeekly)})`);
    const rem = POOL17.accountRemaining(r.after, nowSec);
    ok(rem.remaining === 80 && rem.known === true,
      `⑰b …and the pool follows the LIVE reading (${JSON.stringify(rem)}) — which is what the base commit answered`);

    // NEGATIVE CONTROL 1: the round-3 merge, which kept every prev limitId.
    const wB = mutantWorld17('b', [WF, QF], {
      [WF]: [['  const base = replace ? prevSet : retireUnnamedScopes(prevSet, next, authoritativeScopes, { key, source: source || (obj && obj.source) || null });',
        '  const base = prevSet;']],
    });
    hit17(wB, '⑰b removes the retirement');
    const preB = runPanel(load17(wB, WF));
    ok(!!limOf(preB.after, 'model:oldmodel'),
      `⑰b NEGATIVE CONTROL: the pre-fix merge resurrects the retired cap (${(preB.after.limits || []).map((l) => l.limitId).join(',')})`);
    ok(POOL17.accountRemaining(preB.after, nowSec).remaining === 0,
      `⑰b NEGATIVE CONTROL: …at 0 %, so the pool excludes a member whose live reading says 80 (${JSON.stringify(POOL17.accountRemaining(preB.after, nowSec))})`);

    // POSITIVE CONTROL: a producer that did NOT enumerate must never retire.
    // (The statusline writes `scopedWeekly: prev.scopedWeekly` and the
    // rate_limit_event knows about one bucket — both carry the set forward.)
    const rNo = runPanel(W, { authoritative: false });
    ok(!!limOf(rNo.after, 'model:oldmodel'),
      `⑰b POSITIVE CONTROL: without the producer's own claim, the cap is carried forward as before (${(rNo.after.limits || []).map((l) => l.limitId).join(',')})`);
    // …and the same holds for a REAL non-enumerating producer on a live file.
    const dirS = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm17s-${process.pid}-`));
    W.writeCacheObject({ cacheDir: dirS, key: 'acct', obj: panel(TWO, now), measuredAt: now, source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude', authoritativeScopes: ['model'] });
    CAP17.captureRateLimitEvent({
      cacheDir: dirS, key: 'acct', identityIds: ['acct'], now: now + 1000, familyOf: familyOfScopedBucket,
      ev: { kind: 'fiveHour', rawType: 'five_hour', status: 'allowed', utilization: 0.5, resetsAt: 0, overage: {} },
    });
    const afterEv = W.readCacheObject(dirS, 'acct');
    ok(!!limOf(afterEv, 'model:oldmodel') && !!limOf(afterEv, 'model:fable'),
      `⑰b POSITIVE CONTROL: a real rate_limit_event retires nothing (${(afterEv.limits || []).map((l) => l.limitId).join(',')})`);

    // WIRING PIN: a pure rule with no call site is the 2.355.0 class. Only the
    // producers whose OWN parse enumerates may pass it, and each must gate on
    // that parse — never on the preserve-merged object.
    const routes = fs.readFileSync(path.join(ROOT, 'src/usage-routes.js'), 'utf8');
    const engine = fs.readFileSync(path.join(ROOT, 'src/server/usage-pool-engine.js'), 'utf8');
    const sites = (routes.match(/authoritativeScopes:/g) || []).length + (engine.match(/authoritativeScopes:/g) || []).length;
    // The count is a PIN, not trivia: five ⟳ legs in usage-routes (the local
    // panel, the two host-per-account legs, the two host-global legs) plus the
    // bare-token ⟳ and the engine's control-channel probe. A seventh site is a
    // new claim of authority and must be looked at.
    ok(sites === 7, `⑰b WIRING PIN: exactly seven enumerating producers pass it (found ${sites})`);
    ok(!/authoritativeScopes:\s*\[/.test(routes) && !/authoritativeScopes:\s*\[/.test(engine),
      '⑰b WIRING PIN: …every one of them GATES on its own parse, never unconditionally');
    // r6: the gate is the ONE pure rule, asked of the PARSE. A hand-spelled
    // `scopedWeekly?.length` is a fact about the array — it says a model cap was
    // seen, never that all of them were — and that is the whole of §⑱.
    const gateRe = /authoritativeScopes: (?:quotaModel\.)?authoritativeScopesOf\((cliPanel|u|parsed)\)/g;
    const gates = [...routes.matchAll(gateRe), ...engine.matchAll(gateRe)].map((m) => m[1]);
    ok(gates.length === sites,
      `⑰b WIRING PIN: …through the ONE rule, asked of THIS read's own parse (${gates.length}/${sites}: ${[...new Set(gates)].join(', ')})`);
    ok(!/scopedWeekly\?\.length \? \['model'\]/.test(routes) && !/scopedWeekly\?\.length \? \['model'\]/.test(engine),
      '⑰b WIRING PIN: …and no site re-spells the rule as "the array is non-empty" (the r5 shape §⑱ reproduces)');
    const capture = fs.readFileSync(path.join(ROOT, 'src/rate-limit-capture.js'), 'utf8');
    const statusline = fs.readFileSync(path.join(ROOT, 'data/bin/vibespace-usage'), 'utf8');
    ok(!capture.includes('authoritativeScopes') && !statusline.includes('authoritativeScopes')
      && !/authoritativeScopes/.test(fs.readFileSync(path.join(ROOT, 'src/quota-model-migrate.js'), 'utf8')),
      '⑰b WIRING PIN: …and the single-bucket producers, the statusline and the migration never claim it');
  }

  // ── ⑰c the claim key is about NUMBERS, never about clocks ─────────────────
  {
    const w = { kind: '7d', minutes: 10080, usedPct: 83, resetsAt: 1789318800, measuredAt: 1, state: 'running' };
    ok(QM.windowClaimKey(w) === QM.windowClaimKey({ ...w, measuredAt: 999, state: 'empty' }),
      '⑰c the same numbers under a different clock and a different derived verdict are ONE claim');
    ok(QM.windowClaimKey(w) !== QM.windowClaimKey({ ...w, usedPct: 84 })
      && QM.windowClaimKey(w) !== QM.windowClaimKey({ ...w, resetsAt: 1789318801 })
      && QM.windowClaimKey(w) !== QM.windowClaimKey({ ...w, status: 'limited' }),
      '⑰c …and any number the vendor stated moving makes it a different one');
    const L = (over) => QM.makeLimit({ limitId: 'overage', scope: 'overage', flags: { inUse: false, asOf: over }, windows: [] });
    ok(QM.sameLimitClaim(L(1), L(1)) && !QM.sameLimitClaim(L(1), L(2)),
      '⑰c a windowless limit is compared on its FLAGS (the overage limit states nothing else)');
    ok(QM.sameLimitClaim(QM.makeLimit({ limitId: 'p', windows: [w, { ...w, kind: '5h' }] }),
      QM.makeLimit({ limitId: 'p', windows: [{ ...w, kind: '5h' }, w] })),
      '⑰c window order is not a claim');
  }
}

// ── ⑱ THE RIGHT TO RETIRE BELONGS TO A PARSE THAT SAW THE WHOLE SET (r6) ────
//
// r5 gave a producer the right to RETIRE a model cap the file holds and this
// read did not name, gated on `u.scopedWeekly?.length` — a fact about the
// ARRAY. Seven call sites, three different parsers, and they do not agree on
// one vendor state: six of the seven ran a parser that silently drops a named
// cap stated without a `resets_at`, so an enumerating write retired a REAL,
// SPENT cap and `accountRemaining` went 0 → 80. That is inc-msof8i22 re-opened
// by the mechanism built to end its mirror image.
console.log('\n⑱ only a parse that ENUMERATED may retire a limit (r6)');
{
  const MUT18 = `vs-qmr6-mut-${process.pid}-`;
  const MUT_DIRS = ['src', 'src/harnesses', 'src/adapters'];
  // Same crashed-run sweep as ⑯/⑰ — a SIGKILLed suite must never leave a
  // sibling in the tree, because a dirty tree is what the release gate REFUSES
  // on. (r5's own prefix was never added to .gitignore; ⑱-0 below is why that
  // cannot happen again silently.)
  for (const d of MUT_DIRS) {
    try {
      for (const f of fs.readdirSync(path.join(ROOT, d))) {
        const m = /^vs-qmr6-mut-(\d+)-/.exec(f);
        if (!m || Number(m[1]) === process.pid) continue;
        try { process.kill(Number(m[1]), 0); continue; } catch { }
        try { fs.unlinkSync(path.join(ROOT, d, f)); } catch { }
      }
    } catch { }
  }
  const mutants18 = [];
  process.on('exit', () => { for (const f of mutants18) { try { fs.unlinkSync(f); } catch { } } });
  /** A patched copy BESIDE the original (same directory, or its `../` requires
   *  do not resolve). Returns {path, hits} so the patch can be asserted to hit. */
  const mutantBeside = (rel, patches) => {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const hits = [];
    for (const [from, to] of patches) { hits.push(src.split(from).length - 1); src = src.split(from).join(to); }
    const dst = path.join(ROOT, path.dirname(rel), MUT18 + path.basename(rel));
    fs.writeFileSync(dst, src);
    mutants18.push(dst);
    return { path: dst, hits };
  };
  const hit18 = (m, label) => ok(m.hits.length > 0 && m.hits.every((c) => c === 1),
    `⑱ NEGATIVE CONTROL setup: ${label} — every patch anchor hit exactly once (${JSON.stringify(m.hits)})`);

  // ── ⑱0 the copies this leg writes can never become tree state ─────────────
  // r5 introduced `vs-qmr4-mut-*` and never added it to .gitignore, so a
  // SIGKILL between its two writes would have left a file in src/ that dirties
  // the tree, blocks every push, AND is walked by the architecture suite as
  // source. The rule is only real if the suite asks git itself.
  {
    const { execFileSync } = await import('node:child_process');
    const { gitEnvFrom } = await import('./git-env.mjs');
    const env = gitEnvFrom(process.env); // this suite runs inside `npm run ci` and inside the pre-push hook
    const ask = (p) => {
      try { execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', p], { env, stdio: 'ignore' }); return true; }
      catch (e) { if (e && e.status === 1) return false; throw e; }
    };
    try {
      const probes = [...MUT_DIRS.map((d) => `${d}/${MUT18}x.js`), `src/vs-qmr3-mut-${process.pid}-x.js`, `src/vs-qmr4-mut-${process.pid}-x.js`];
      const bad = probes.filter((p) => !ask(p));
      ok(bad.length === 0, `⑱0 every mutant-copy path this file can write is git-ignored (${bad.length ? 'NOT IGNORED: ' + bad.join(', ') : probes.length + ' checked'})`);
      ok(ask('src/quota-model.js') === false, '⑱0 …and the probe is not answering "ignored" to everything (a real source file is not)');
    } catch (e) {
      // No git / no repo (a tarball or `git archive` export): SKIP LOUDLY with
      // the failure, never a green line that invented its own reason.
      ok(true, `⑱0 SKIPPED — cannot ask git whether the mutant paths are ignored: ${String(e && e.message || e).split('\n')[0]}`);
    }
  }

  const CQ = require(path.join(ROOT, 'src/harnesses/claude-quota.js'));
  const { ClaudeCodeAdapter: ADP } = require(path.join(ROOT, 'src/adapters/claude-code.js'));
  const POOL18 = require(path.join(ROOT, 'src/account-pool-auto.js'));

  // ONE VENDOR STATE, three wire formats. Plan 20 %/20 %, a Fable cap at 10 %
  // with a reset, and an OPUS CAP AT 100 % STATED WITHOUT A RESET — the shape
  // 2.305.0 found in a real payload, in the form this instance's own anchors
  // say is routine: 704 of 5631 scoped readings and 615 of 7978 seven-day
  // readings carry no reset at all (692 of the scoped ones produced by the ⟳
  // panel, 3 by the control channel's own array branch). Honest boundary: every
  // reset-less bucket ever recorded HERE sits at u=0, so the exact combination
  // is latent on this instance, not live.
  const nowSec18 = Math.floor(Date.now() / 1000);
  const R5x = nowSec18 + 3600, R7x = nowSec18 + 400000;
  const ISO = (s) => new Date(s * 1000).toISOString();
  const PANEL_TEXT = [
    'Current session: 20% used · resets Aug 12, 12:20am (America/Los_Angeles)',
    'Current week (all models): 20% used · resets Aug 15, 12:20am (America/Los_Angeles)',
    'Current week (Fable): 10% used · resets Aug 15, 12:20am (America/Los_Angeles)',
    'Current week (Opus): 100% used',
  ].join('\n');
  const OAUTH = () => ({
    five_hour: { utilization: 20, resets_at: ISO(R5x) }, seven_day: { utilization: 20, resets_at: ISO(R7x) },
    limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 10, resets_at: ISO(R7x) }],
    seven_day_opus: { utilization: 100 },
  });
  const CTRL = () => ({ rate_limits: {
    five_hour: { utilization: 20, resets_at: R5x }, seven_day: { utilization: 20, resets_at: R7x },
    model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: R7x }],
    seven_day_opus: { utilization: 100 },
  } });
  const idsOf = (u) => u ? QM.limitsOf(QM.fromLegacy({ ...u, fetchedAt: Date.now() }, {
    identity: 'k', limitId: 'plan', familyOf: familyOfScopedBucket, extraKeys: CLAUDEQ.CLAUDE_EXTRA_KEYS, source: 'x', fetchedAt: Date.now(),
  })).map((l) => l.limitId).sort() : null;

  // ── ⑱a the three enumerating parsers agree on ONE vendor state ────────────
  {
    const a = idsOf(CQ.parseCliUsageText(PANEL_TEXT, Date.now()));
    const b = idsOf(CQ.parseOAuthUsage(OAUTH()));
    const c = idsOf(ADP.parseGetUsageResponse(CTRL()));
    eq(a, ['model:fable', 'model:opus', 'plan'], '⑱a the ⟳ panel parse sees plan + both model caps');
    ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
      `⑱a …and so do the OAuth and control parses (${JSON.stringify(b)} / ${JSON.stringify(c)})`);
    ok(CQ.parseOAuthUsage(OAUTH()).scopedWeekly.find((x) => x.name === 'Opus')?.utilization === 1,
      '⑱a …with the SPENT number intact (a bucket with no reset is still a bucket)');

    // NEGATIVE CONTROL: today's `!resets_at` skips, restored one at a time.
    const mq = mutantBeside('src/harnesses/claude-quota.js',
      [['if (pctRaw == null) { dropped++; continue; } // shaped like a weekly bucket, states no number we can read',
        'if (pctRaw == null || !v.resets_at) continue;']]);
    hit18(mq, '⑱a restores the OAuth parser\'s reset requirement');
    const ma = mutantBeside('src/adapters/claude-code.js',
      [['        if (typeof v.utilization !== \'number\' && typeof v.used_percentage !== \'number\') {\n          if (WINDOWISH.some((f) => f in v)) dropped++;\n          continue;\n        }',
        '        if (typeof v.utilization !== \'number\' && typeof v.used_percentage !== \'number\') continue;\n        if (!v.resets_at) continue;']]);
    hit18(ma, '⑱a restores the control parser\'s reset requirement');
    const preB = idsOf(require(mq.path).parseOAuthUsage(OAUTH()));
    const preC = idsOf(require(ma.path).ClaudeCodeAdapter.parseGetUsageResponse(CTRL()));
    eq(preB, ['model:fable', 'plan'], '⑱a NEGATIVE CONTROL: the pre-fix OAuth parse loses the spent cap');
    eq(preC, ['model:fable', 'plan'], '⑱a NEGATIVE CONTROL: …and so does the pre-fix control parse');
    ok(JSON.stringify(a) !== JSON.stringify(preB),
      '⑱a NEGATIVE CONTROL: …i.e. two parsers disagreed with the third about the SAME account');
  }

  // ── ⑱b end-to-end: a producer that could not see the cap must not retire it ─
  {
    /** The ⟳ ladder as it really runs: the CLI-panel rung writes first (it is
     *  the only parser that saw the cap), then a later rung re-reads the same
     *  vendor state through the OAuth parse and writes the SAME key. `gate` is
     *  the call-site expression, which the ⑰b WIRING PIN keeps honest. */
    const runLadder = (Wm, parseOAuth, gate) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm18-${process.pid}-`));
      tmpDirs.push(dir);
      const key = 'acct';
      const panel = CQ.parseCliUsageText(PANEL_TEXT, Date.now());
      const u1 = { ...panel, source: 'on-demand', scopedFetchedAt: Date.now() };
      Wm.writeCacheObject({ cacheDir: dir, key, obj: u1, source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude',
        authoritativeScopes: gate(panel) });
      const mid = Wm.readCacheObject(dir, key);
      const u2 = parseOAuth(OAUTH());
      u2.source = 'on-demand';
      Wm.writeCacheObject({ cacheDir: dir, key, obj: u2, source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude',
        authoritativeScopes: gate(u2) });
      return { dir, key, mid, after: Wm.readCacheObject(dir, key) };
    };
    const idsIn = (o) => (o.limits || []).map((l) => l.limitId).sort();

    const r = runLadder(W, CQ.parseOAuthUsage, QM.authoritativeScopesOf);
    eq(idsIn(r.mid), ['model:fable', 'model:opus', 'plan'], '⑱b the panel read establishes both model caps');
    ok(POOL18.accountRemaining(r.mid, nowSec18).remaining === 0,
      `⑱b …and the spent one governs the account (${JSON.stringify(POOL18.accountRemaining(r.mid, nowSec18))})`);
    eq(idsIn(r.after), ['model:fable', 'model:opus', 'plan'], '⑱b a later rung re-reads the same state and the cap SURVIVES');
    const rem = POOL18.accountRemaining(r.after, nowSec18);
    ok(rem.remaining === 0 && rem.known === true,
      `⑱b …so the pool still sees a spent account (${JSON.stringify(rem)})`);

    // NEGATIVE CONTROL: the pre-fix world — the parser that drops the cap, and
    // r5's gate ("the array is non-empty"). This is the verifier's reproduction,
    // driven through the real write path and the real pool accessor.
    const mq2 = mutantBeside('src/harnesses/claude-quota.js',
      [['if (pctRaw == null) { dropped++; continue; } // shaped like a weekly bucket, states no number we can read',
        'if (pctRaw == null || !v.resets_at) continue;']]);
    hit18(mq2, '⑱b restores the pre-fix OAuth parser');
    const r5gate = (u) => (u.scopedWeekly?.length ? ['model'] : null); // the r5 call-site expression, verbatim
    const pre = runLadder(W, require(mq2.path).parseOAuthUsage, r5gate);
    eq(idsIn(pre.mid), ['model:fable', 'model:opus', 'plan'], '⑱b NEGATIVE CONTROL: the panel read still establishes both caps');
    eq(idsIn(pre.after), ['model:fable', 'plan'],
      '⑱b NEGATIVE CONTROL: …and the read that could never have SEEN the spent cap retires it');
    const preRem = POOL18.accountRemaining(pre.after, nowSec18);
    ok(preRem.remaining === 80 && preRem.known === true,
      `⑱b NEGATIVE CONTROL: …so the pool reads 80 % free on an account whose Opus is gone (${JSON.stringify(preRem)}) — inc-msof8i22`);

    // …and ONE mechanism at a time: the r5 GATE alone, with the FIXED parser,
    // retires nothing (the parser half is what made the gate lethal).
    const half = runLadder(W, CQ.parseOAuthUsage, r5gate);
    eq(idsIn(half.after), ['model:fable', 'model:opus', 'plan'],
      '⑱b CONTROL: with the parser fixed, even the r5 gate has nothing to retire');
  }

  // ── ⑱c the claim is FALSIFIABLE: a parse that dropped something claims none ─
  {
    const scoped = QM.authoritativeScopesOf;
    ok(JSON.stringify(scoped(CQ.parseOAuthUsage(OAUTH()))) === '["model"]', '⑱c a clean OAuth parse claims the model scope');
    const noName = OAUTH(); noName.limits.push({ kind: 'weekly_scoped', scope: {}, percent: 50, resets_at: ISO(R7x) });
    ok(scoped(CQ.parseOAuthUsage(noName)) === null,
      '⑱c a weekly_scoped entry it could not NAME costs the claim (the cap is real, we just cannot key it)');
    const noNum = OAUTH(); noNum.seven_day_zebra = { resets_at: ISO(R7x) };
    ok(scoped(CQ.parseOAuthUsage(noNum)) === null,
      '⑱c …as does a bucket-shaped field it could not read a number from');
    const nulls = OAUTH(); nulls.seven_day_sonnet = null; nulls.seven_day_oauth_apps = null;
    ok(JSON.stringify(scoped(CQ.parseOAuthUsage(nulls))) === '["model"]',
      '⑱c …but a NULL field is the vendor saying "no such limit", not a drop');

    ok(JSON.stringify(scoped(ADP.parseGetUsageResponse(CTRL()))) === '["model"]', '⑱c a clean control parse claims it');
    const cNoName = CTRL(); cNoName.rate_limits.model_scoped.push({ utilization: 50, resets_at: R7x });
    ok(scoped(ADP.parseGetUsageResponse(cNoName)) === null, '⑱c …and an unnameable model_scoped entry costs it');
    const cNoNum = CTRL(); cNoNum.rate_limits.nimbus_quill = { resets_at: null, percent: null };
    ok(scoped(ADP.parseGetUsageResponse(cNoNum)) === null, '⑱c …as does a window-shaped field with no readable number');
    const cOther = CTRL(); cOther.rate_limits.some_flag = { enabled: true };
    ok(JSON.stringify(scoped(ADP.parseGetUsageResponse(cOther))) === '["model"]',
      '⑱c …while an object that is not window-shaped at all is not a bucket and not a drop');

    ok(JSON.stringify(scoped(CQ.parseCliUsageText(PANEL_TEXT, Date.now()))) === '["model"]', '⑱c a clean panel parse claims it');
    const drift = PANEL_TEXT + '\nCurrent week (Zebra): unavailable';
    ok(scoped(CQ.parseCliUsageText(drift, Date.now())) === null,
      '⑱c …and a `Current week (…)` line its own regex could not read costs the claim (format drift ⇒ no retirement)');

    // The r5 half, kept on purpose: an EMPTY list still states nothing.
    const noScoped = CQ.parseCliUsageText('Current session: 20% used\nCurrent week (all models): 20% used', Date.now());
    ok(QM.scopedEnumeration(noScoped) === true && scoped(noScoped) === null,
      '⑱c an enumerated but EMPTY list claims nothing — indistinguishable from a broken parse, and retiring a spent cap is the money-losing direction');
  }

  // ── ⑱d the claim is a fact about ONE READ: never stored, never forgeable ───
  {
    const parse = CQ.parseOAuthUsage(OAUTH());
    ok(QM.scopedEnumeration(parse) === true, '⑱d the parse itself carries the claim');
    ok(QM.authoritativeScopesOf(JSON.parse(JSON.stringify(parse))) === null,
      '⑱d a JSON round trip loses it (a device wire, a cache file — every one of them fails SAFE)');
    ok(QM.authoritativeScopesOf({ ...parse }) === null,
      '⑱d a spread loses it (which is why the panel call site asks `cliPanel`, not the `{...cliPanel}` it writes)');
    ok(QM.authoritativeScopesOf({ ...parse, scopedComplete: true }) === null,
      '⑱d and a STORED object cannot forge it — the mark is symbol-keyed, so no JSON can express it');
    ok(Object.keys(parse).indexOf('scopedComplete') === -1 && !JSON.stringify(parse).includes('scopedComplete'),
      '⑱d …nor does it ever reach a payload we serialize');
    // The POSITIVE twin, and four of the seven call sites depend on it: the
    // host/token legs mutate the parse in place (`u.source = …`,
    // `Object.assign(u, org)` in `_fetchOAuthRoles`/`_consumeDeviceQuota`) and
    // then gate on `u`. Mutation keeps the object, so it keeps the claim.
    const mutated = CQ.parseOAuthUsage(OAUTH());
    mutated.source = 'on-demand'; Object.assign(mutated, { orgUuid: 'o', scopedFetchedAt: Date.now() });
    ok(JSON.stringify(QM.authoritativeScopesOf(mutated)) === '["model"]',
      '⑱d …while mutating the parse in place (what the token and host legs do) keeps it — the object is the same object');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm18d-${process.pid}-`));
    tmpDirs.push(dir);
    W.writeCacheObject({ cacheDir: dir, key: 'acct', obj: parse, source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude',
      authoritativeScopes: QM.authoritativeScopesOf(parse) });
    ok(!fs.readFileSync(W.cacheFileFor(dir, 'acct'), 'utf8').includes('scopedComplete'),
      '⑱d …and the file this write persists carries no trace of it');
  }

  // ── ⑱f THE PANEL PRODUCER'S AUTHORITY, DRIVEN END TO END ──────────────────
  //
  // WHY A FUNCTIONAL LEG AND NOT ANOTHER PIN. The r5 WIRING PIN asserts that
  // each of the seven sites gates on a variable — and the panel site is the one
  // whose parse result and whose WRITE PAYLOAD are different objects
  // (`u = {...cliPanel, …}`). Since the enumeration mark is deliberately
  // non-enumerable, asking `u` instead of `cliPanel` silently answers "no
  // authority" for ever: the retirement dies at the one producer that most
  // deserves it, no test goes red, and the r5 feature becomes a guard that
  // cannot fire. Mutation-tested: swapping the argument reddens NOTHING else in
  // this suite. So this leg runs the REAL `refreshViaCliPanel` through the REAL
  // setupUsage factory with a FAKE `claude` on CLAUDE_CMD (zero vendor cost,
  // real execFile, real parse, real write path) and reads the CONSEQUENCE.
  {
    const { AccountManager } = require(path.join(ROOT, 'src/accounts.js'));
    const usageMod = require(path.join(ROOT, 'src/usage-routes.js'));
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const at = (ms) => { const d = new Date(Date.now() + ms); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCHours() % 12 || 12}${d.getUTCHours() < 12 ? 'am' : 'pm'} (UTC)`; };
    const panelText = (caps) => `Current session: 20% used · resets ${at(3 * 3600e3)}\n`
      + `Current week (all models): 20% used · resets ${at(3 * 86400e3)}\n`
      + caps.map((c) => `Current week (${c.name}): ${c.pct}% used · resets ${at(3 * 86400e3)}\n`).join('');

    const mkPanelWorld = (usageModule) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm18f-${process.pid}-`));
      tmpDirs.push(root);
      const dataDir = path.join(root, 'data');
      const am = new AccountManager({ dataDir });
      const id = am.createSubscription({ name: 'Panel Acct' }).id;
      fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'), JSON.stringify({ claudeAiOauth: {
        accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 36e5, refreshTokenExpiresAt: Date.now() + 29 * 86400e3, subscriptionType: 'max',
      } }), { mode: 0o600 });
      const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const bin = path.join(root, 'fake-claude');
      const say = (caps) => fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${panelText(caps)}EOF\n`, { mode: 0o755 });
      say([]);
      const u = usageModule.setupUsage({
        app: { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} },
        accounts: am, hosts: null, usageHistory: null, activeSessions: new Map(),
        serverSetting: () => undefined, ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
        USAGE_CACHE_FILE: path.join(dataDir, 'usage-cache.json'), USAGE_CACHE_DIR: cacheDir,
        CODEX_SESSIONS_DIR: path.join(root, 'codex-sessions'), META_DIR: path.join(dataDir, 'session-meta'),
        AVAILABLE_MODELS: [], BUFFERS_DIR: path.join(dataDir, 'session-buffers'),
        probeUsageForAccountKey: async () => false, onMemberReadingFresh: () => ({}), CLAUDE_CMD: bin,
      });
      const readBack = () => W.readCacheObject(cacheDir, id);
      return { root, am, id, cacheDir, u, say, readBack };
    };

    const TWO_CAPS = [{ name: 'OldModel', pct: 100 }, { name: 'Fable', pct: 10 }];
    const ONE_CAP = [{ name: 'Fable', pct: 10 }];
    const runPanels = async (w) => {
      w.say(TWO_CAPS); const ok1 = await w.u.refreshViaCliPanel(w.id);
      const mid = w.readBack();
      w.say(ONE_CAP); const ok2 = await w.u.refreshViaCliPanel(w.id);
      return { ok1, ok2, mid, after: w.readBack() };
    };
    const idsIn = (o) => (o && o.limits || []).map((l) => l.limitId).sort();

    const w = mkPanelWorld(usageMod);
    const r = await runPanels(w);
    ok(r.ok1 === true && r.ok2 === true, `⑱f both panel reads landed through the real refresher (${r.ok1}/${r.ok2})`);
    eq(idsIn(r.mid), ['model:fable', 'model:oldmodel', 'plan'], '⑱f the first panel establishes both model caps');
    eq(idsIn(r.after), ['model:fable', 'plan'],
      '⑱f the second panel enumerates one and the cap it no longer reports is RETIRED — the r5 feature, proven at its call site');

    // NEGATIVE CONTROL: ask the SPREAD instead of the parse. It is one argument,
    // it type-checks, it satisfies the wiring pin's shape — and it silently
    // disables the panel's authority for ever.
    const mSpread = mutantBeside('src/usage-routes.js',
      [['authoritativeScopes: authoritativeScopesOf(cliPanel) });', 'authoritativeScopes: authoritativeScopesOf(u) });']]);
    hit18(mSpread, '⑱f asks the spread `u` instead of the parse `cliPanel`');
    const w2 = mkPanelWorld(require(mSpread.path));
    const r2 = await runPanels(w2);
    eq(idsIn(r2.after), ['model:fable', 'model:oldmodel', 'plan'],
      '⑱f NEGATIVE CONTROL: asking the spread retires nothing — the mark does not survive `{...cliPanel}`, and no other assert in this file can see it');
  }

  // ── ⑱e the retirement says WHAT CLAIM it is dropping ──────────────────────
  // A legitimate retirement is a vendor change; the line that records it is the
  // only artefact that answers "did a constraint just disappear?" when the pool
  // starts spending on an account it now thinks is free.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qm18e-${process.pid}-`));
    tmpDirs.push(dir);
    const base = {
      fiveHour: { utilization: 0.2, resetsAt: nowSec18 + 3600 }, sevenDay: { utilization: 0.2, resetsAt: nowSec18 + 500000 },
      scopedWeekly: [{ name: 'OldModel', utilization: 1, resetsAt: nowSec18 + 300 }, { name: 'Fable', utilization: 0.1, resetsAt: nowSec18 + 500000 }],
      fetchedAt: Date.now(), source: 'on-demand',
    };
    W.writeCacheObject({ cacheDir: dir, key: 'acct', obj: base, measuredAt: Date.now(), source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude', authoritativeScopes: ['model'] });
    const said = [];
    const realLog = console.log;
    console.log = (...a) => { said.push(a.join(' ')); };
    try {
      W.writeCacheObject({ cacheDir: dir, key: 'acct', obj: { ...base, scopedWeekly: [base.scopedWeekly[1]], fetchedAt: Date.now() + 1000 },
        measuredAt: Date.now() + 1000, source: 'on-demand', familyOf: familyOfScopedBucket, backend: 'claude', authoritativeScopes: ['model'] });
    } finally { console.log = realLog; }
    const line = said.find((s) => s.includes('retiring')) || '';
    ok(/model:oldmodel \(100% 7d, running\)/.test(line),
      `⑱e the retirement names the claim it drops, not just the id (${JSON.stringify(line)})`);
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
