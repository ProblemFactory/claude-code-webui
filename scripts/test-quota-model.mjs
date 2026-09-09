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
      ['data/bin/vibespace-usage', 'the SHIPPED statusline tool: a single file on hosts with no checkout, so it cannot require src/ — the same documented exception as vibespace-usage-scan, and it mirrors the RULES it needs byte-for-byte'],
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
      ['src/account-pool-auto.js', ['migrated', 'bucketRemaining/weeklyDeadline call bucketCounts — an empty window is neither a constraint nor a deadline']],
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

  // bucketRems: the report names only buckets that make a claim
  const rems = POOL.bucketRems(A, nowSec);
  ok(rems.length === 1 && rems[0].kind === 'weekly' && rems[0].remaining === 0,
    `⑫ bucketRems reports one spent weekly bucket and no empty ones (${JSON.stringify(rems)})`);

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

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
