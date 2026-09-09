#!/usr/bin/env node
// Migration framework (2.328.0, plan B): shared runner semantics + the first
// real local migration, against a THROWAWAY data dir (never production data/).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runMigrations } = require('../src/migration-runner.js');
const { create } = require('../src/server/migrations.js');
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + JSON.stringify(e) : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-mig-'));
try {
  // ── runner semantics ──
  const ledger = path.join(tmp, 'ledger.json');
  let ran = 0, boom = 0;
  const mig = [
    { id: 'a', run: () => { ran++; } },
    { id: 'b', run: () => { boom++; throw new Error('disk full'); } },
  ];
  let r = runMigrations({ ledgerPath: ledger, migrations: mig, log: () => {}, warn: () => {} });
  ok(ran === 1 && r.find((x) => x.id === 'a').status === 'ran', 'migration runs once');
  ok(r.find((x) => x.id === 'b').status === 'failed', 'failure reported, not thrown');
  r = runMigrations({ ledgerPath: ledger, migrations: mig, log: () => {}, warn: () => {} });
  ok(ran === 1 && r.find((x) => x.id === 'a').status === 'already', 'second run: applied id skipped (ledger)');
  ok(boom === 2, 'FAILED migration re-attempts next run (never recorded)');
  const led = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
  ok(led.applied.a && !led.applied.b, 'ledger records success only');

  // ── the dormant-plan archive migration ──
  const rootDir = path.join(tmp, 'inst');
  fs.mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'data', 'task-groups.json'), JSON.stringify({
    tasks: {
      t1: { title: 'A', plan: [{ text: 'old item', done: false }] },
      t2: { title: 'B', plan: [] },
      t3: { title: 'C' },
    },
  }));
  // a pre-2.368.19 collapse-kinds save (no 'agent' — the option didn't exist)
  fs.writeFileSync(path.join(rootDir, 'data', 'settings.json'), JSON.stringify({
    'chat.collapseKinds': ['thinking', 'bash', 'read'], 'window.closeBehavior': 'detach',
  }));
  const notices = [];
  const m = create({ rootDir, serverNotice: (k, txt) => notices.push(k) });
  m.runLocalMigrations();
  {
    const st = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'settings.json'), 'utf-8'));
    ok(st['chat.collapseKinds'].includes('agent'), "pre-'agent' collapse saves gain the new default-on kind once (a saved multiSelect can't tell 'unchecked' from 'predates the option')");
    ok(st['window.closeBehavior'] === 'detach' && st['chat.collapseKinds'][0] === 'thinking', 'everything else in settings.json untouched');
    // after the one-shot, an explicit un-tick sticks (ledger, not content-sniffing)
    st['chat.collapseKinds'] = st['chat.collapseKinds'].filter((k) => k !== 'agent');
    fs.writeFileSync(path.join(rootDir, 'data', 'settings.json'), JSON.stringify(st));
    m.runLocalMigrations();
    const st2 = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'settings.json'), 'utf-8'));
    ok(!st2['chat.collapseKinds'].includes('agent'), 'a post-migration explicit un-tick is never re-added');
  }
  const doc = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'task-groups.json'), 'utf-8'));
  ok(!('plan' in doc.tasks.t1) && !('plan' in doc.tasks.t2), 'plan keys stripped from the live store');
  ok(doc.tasks.t1.title === 'A' && doc.tasks.t3.title === 'C', 'everything else untouched');
  const arch = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'archive', 'task-plans-legacy.json'), 'utf-8'));
  ok(arch.t1?.[0]?.text === 'old item', 'non-empty plans ARCHIVED, never destroyed');
  ok(!('t2' in arch), 'empty plans stripped without archiving noise');
  // idempotent: second boot changes nothing and archives nothing twice
  fs.writeFileSync(path.join(rootDir, 'data', 'task-groups.json'), JSON.stringify({ tasks: { t9: { title: 'later', plan: [{ text: 'x' }] } } }));
  m.runLocalMigrations();
  const doc2 = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'task-groups.json'), 'utf-8'));
  ok('plan' in doc2.tasks.t9, 'already-applied migration never re-runs (ledger, not content-sniffing)');
  ok(notices.length === 0, 'no failure notices on the happy path');

  // ── the test-fixture ledger purge (2026-09-09) ────────────────────────────
  // Two suites wrote SYNTHETIC transcripts into the developer's real
  // ~/.claude/projects and the production usage walk ingested them: 79,533
  // fabricated rows on this instance claiming tokens nobody spent, attributed
  // to the machine login and counted into the costSince of its anchor pairs.
  // The fixture below is built in the SHAPE OF DISK (an ndjson shard, a cursor
  // map keyed by absolute path, anchor records with prevFetchedAt/costSince) —
  // a self-consistent invented shape is how the readings-repair r3 defect
  // stayed green.
  {
    const root2 = path.join(tmp, 'inst2');
    const hist = path.join(root2, 'data', 'usage-history');
    const anch = path.join(root2, 'data', 'usage-anchors');
    fs.mkdirSync(hist, { recursive: true });
    fs.mkdirSync(anch, { recursive: true });
    const FX = 'e2e00000-0000-4000-8000-000000000001';
    const REAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const row = (o) => JSON.stringify({ rid: o.rid, ts: o.ts, sid: o.sid, be: 'claude', model: 'claude-fable-5', acct: o.acct ?? null, atype: 'global', cwd: o.cwd ?? null, i: o.i ?? 10, cw5: 0, cw1: 0, cr: 0, o: o.o ?? 50, tier: null });
    fs.writeFileSync(path.join(hist, 'events-2026-08.ndjson'), [
      row({ rid: 'real_1', ts: 1000, sid: REAL, cwd: '/home/u/work', i: 7, o: 3 }),      // keep
      row({ rid: 'fx_sid_1', ts: 2000, sid: FX, i: 10, o: 50 }),                          // FABRICATED (no cwd — the real shape)
      row({ rid: 'fx_cwd_1', ts: 3000, sid: REAL, cwd: '/tmp/vs-chat-e2e-cwd-Q9oyO8', i: 1, o: 2 }), // real turn, fixture cwd
      row({ rid: 'real_2', ts: 9000, sid: REAL, cwd: '/home/u/work', i: 5, o: 5 }),      // keep
      'not json at all',                                                                  // unparseable stays
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(hist, '_cursors.json'), JSON.stringify({
      '/home/u/.claude/projects/-home-u-work/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl': { offset: 12, lastRid: 'real_2' },
      '/home/u/.claude/projects/-tmp-vs-chatpage-test-620924/e2e00000-0000-4000-8000-000000000001.jsonl': { offset: 4, lastRid: 'fx_sid_1' },
      '/home/u/.claude/projects/-home-u-work/e2e00000-0000-4000-8000-000000000002.jsonl': { offset: 4, lastRid: 'x' },
    }));
    fs.writeFileSync(path.join(hist, 'attribution.ndjson'),
      [JSON.stringify({ sid: REAL, acct: 'sub-a', ts: 1000 }), JSON.stringify({ sid: FX, acct: 'sub-a', ts: 2000 })].join('\n') + '\n');
    fs.writeFileSync(path.join(anch, 'anchors-org_x.ndjson'), [
      JSON.stringify({ accountId: 'sub-a', fetchedAt: 2500, prevFetchedAt: 1500, costSince: { total: 9 } }),  // interval holds fx_sid_1 (ts 2000) ⇒ VOID
      JSON.stringify({ accountId: 'sub-a', fetchedAt: 8000, prevFetchedAt: 4000, costSince: { total: 4 } }),  // holds nothing removed ⇒ KEEP
      JSON.stringify({ accountId: 'sub-a', fetchedAt: 3500, prevFetchedAt: 2900, costSince: { total: 2 } }),  // holds fx_cwd_1 (ts 3000) ⇒ VOID
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(anch, 'rates.json'), JSON.stringify({ 'sub-a': { rate: 1.5 } }));

    const notices2 = [];
    const m2 = create({ rootDir: root2, serverNotice: (k) => notices2.push(k) });
    const res2 = m2.runLocalMigrations();
    ok(res2.find((r) => r.id === '2026-09-purge-test-fixture-ledger')?.status === 'ran', 'the fixture purge is registered and ran');

    const left = fs.readFileSync(path.join(hist, 'events-2026-08.ndjson'), 'utf-8').split('\n').filter(Boolean);
    const rids = left.map((l) => { try { return JSON.parse(l).rid; } catch { return '<unparseable>'; } });
    ok(rids.join(',') === 'real_1,real_2,<unparseable>',
      `only the real rows survive, and an unparseable line is NEVER removed (we only drop what we can NAME): ${rids.join(',')}`);

    const arch = fs.readdirSync(path.join(root2, 'data', 'archive')).filter((f) => f.startsWith('fixture-ledger-rows-'));
    ok(arch.length === 1, `the archive shard is DATED (append-only; two rotations in one millisecond must not overwrite): ${arch.join(',')}`);
    const archLines = fs.readFileSync(path.join(root2, 'data', 'archive', arch[0]), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rowLines = archLines.filter((l) => l.store === 'usage-history');
    ok(rowLines.length === 2 && rowLines.every((l) => l.entry && l.reason && l.migration === '2026-09-purge-test-fixture-ledger'),
      'every archived row keeps the WHOLE record plus a reason and the migration id');
    ok(/no API request ever happened/.test(rowLines.find((l) => l.entry.rid === 'fx_sid_1').reason)
      && /throwaway cwd/.test(rowLines.find((l) => l.entry.rid === 'fx_cwd_1').reason),
      'the two classes carry DIFFERENT reasons (fabricated vs a real turn in a fixture cwd) — the whole subject of this repair');

    const cur2 = JSON.parse(fs.readFileSync(path.join(hist, '_cursors.json'), 'utf-8'));
    const curKeys = Object.keys(cur2);
    ok(curKeys.length === 1 && /-home-u-work\/aaaaaaaa/.test(curKeys[0]),
      `dead cursors dropped by project dir AND by synthetic sid, the real one kept (${curKeys.length} left)`);

    const attr2 = fs.readFileSync(path.join(hist, 'attribution.ndjson'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok(attr2.length === 1 && attr2[0].sid === REAL, 'attribution entries naming a synthetic conversation are archived');

    const anchors2 = fs.readFileSync(path.join(anch, 'anchors-org_x.ndjson'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const voided = anchors2.filter((a) => a.costSince === null);
    ok(voided.length === 2 && voided.every((a) => a.repairedBy === '2026-09-purge-test-fixture-ledger'),
      `only the anchors whose interval CONTAINED a removed row are voided (${voided.length}/3), and they say who did it`);
    ok(anchors2.find((a) => a.fetchedAt === 8000).costSince.total === 4,
      'NEGATIVE CONTROL: an anchor whose interval held nothing removed keeps its costSince (this is not a blanket wipe)');
    ok(anchors2.length === 3, 'no anchor RECORD is removed — the readings are real, only the cost measured beside them is not');
    ok(!fs.existsSync(path.join(anch, 'rates.json')) && archLines.some((l) => l.store === 'usage-anchors/rates.json'),
      'the learned rates are archived and dropped so the estimator re-learns from the cleaned pairs');
    ok(notices2.includes('fixture-ledger-purged'), 'the user is TOLD (a repair nobody can see ran is a repair nobody can verify ran)');

    // IDEMPOTENT — and, because the ledger is keyed by id, a second boot does
    // not even re-enter it.
    const beforeBytes = fs.readFileSync(path.join(hist, 'events-2026-08.ndjson'), 'utf-8');
    const beforeArch = fs.readFileSync(path.join(root2, 'data', 'archive', arch[0]), 'utf-8');
    m2.runLocalMigrations();
    ok(fs.readFileSync(path.join(hist, 'events-2026-08.ndjson'), 'utf-8') === beforeBytes
      && fs.readFileSync(path.join(root2, 'data', 'archive', arch[0]), 'utf-8') === beforeArch,
      'second boot: the ledger row keeps it from re-running, and nothing is archived twice');
    // …and running the FUNCTION again on the cleaned stores is also a no-op
    // (the ledger is a belt; the repair itself must be idempotent).
    const { purgeFixtureLedger } = require('../src/fixture-ledger-purge.js');
    const again = purgeFixtureLedger({ dataDir: path.join(root2, 'data'), id: 'again' });
    ok(again.rowsRemoved === 0 && again.cursors === 0 && again.anchorsVoided === 0,
      'the repair itself is idempotent on already-clean stores', JSON.stringify(again));

    // A CLEAN instance is untouched and says so.
    const root3 = path.join(tmp, 'inst3');
    fs.mkdirSync(path.join(root3, 'data', 'usage-history'), { recursive: true });
    fs.writeFileSync(path.join(root3, 'data', 'usage-history', 'events-2026-08.ndjson'), row({ rid: 'r', ts: 1, sid: REAL, cwd: '/home/u/work' }) + '\n');
    const notices3 = [];
    create({ rootDir: root3, serverNotice: (k) => notices3.push(k) }).runLocalMigrations();
    ok(fs.readFileSync(path.join(root3, 'data', 'usage-history', 'events-2026-08.ndjson'), 'utf-8').includes('"rid":"r"')
      && !notices3.includes('fixture-ledger-purged'),
      'a clean instance keeps every row and is not told about a repair that did nothing');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
