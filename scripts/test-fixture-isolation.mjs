#!/usr/bin/env node
// THE STANDING SWEEP: no suite's synthetic transcript may live in the REAL
// ~/.claude/projects (2026-09-09).
//
// WHY. Two of the three synthetic-transcript suites spawned the worktree server
// with the INHERITED HOME and wrote their fixture into the developer's own
// `~/.claude/projects`, because the server can only discover a transcript that
// lives under the home it is running with. The machine's PRODUCTION VibeSpace
// instance polls that directory: it listed the fixture as a stopped
// "conversation", and its usage walk ingested every hand-written `usage` block
// into the permanent ledger. MEASURED on the author's instance:
//   · 79,533 ledger rows for the two synthetic session ids, claiming 982,140
//     tokens of `claude-fable-5` that were never spent
//   · 222 permanently dead cursor entries in data/usage-history/_cursors.json
//   · `acct: null` on every row ⇒ attributed to the machine login `__global__`
//     and counted into the `costSince` of its anchor pairs — i.e. into the
//     learned burn rate the quota estimator spends against.
// The owner saw a Fable conversation, and Fable usage, that never happened.
//
// WHAT THIS SUITE IS. The suites now isolate HOME and the production readers
// skip the convention, but neither is a MEASUREMENT. This is: it runs the PURE
// rule (src/fixture-guard.js `fixtureLitter`) over the real projects directory
// and goes red when a fixture entry is there. It PRINTS the rule, because a
// sweep whose rule lives only in its assert message teaches nobody what to do
// when it is red.
//
// SCOPE, STATED. It is a FAST-tier suite placed LAST in the table, so within
// the fast tier it truly runs after every suite that could litter. The heavy
// tier is detached and runs later — a heavy-tier leak is caught by the NEXT
// push's fast tier, not by this run. Naming that boundary is cheaper than
// pretending it does not exist.
//
// Run: node scripts/test-fixture-isolation.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../src/fixture-guard.js');
const { scratch, scratchHome, fixtureSid } = await import('./scratch.mjs');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? '\n    ' + String(e).slice(0, 400) : '')); } };

console.log('\nTHE RULE\n    ' + G.SWEEP_RULE + '\n');

// ── ① THE PURE RULE ────────────────────────────────────────────────────────
{
  const enc = (p) => p.replace(/[/._]/g, '-');
  ok(G.isFixtureProjectDir(enc('/tmp/vs-chatpage-test-4242')), 'a scratch() cwd encodes to a fixture project dir');
  ok(G.isFixtureProjectDir(enc('/tmp/vs-chat-e2e-cwd-Q9oyO8')), '…including mkdtemp-style suffixes with UPPERCASE random chars');
  ok(G.isFixtureProjectDir(enc('/var/tmp/vs-mmjump-test-9')), '…and a /var/tmp TMPDIR');
  ok(!G.isFixtureProjectDir(enc('/home/u/workspace/vibespace')), 'a real project dir is NOT a fixture');
  ok(!G.isFixtureProjectDir(enc('/tmp/vsv-probe')), "a /tmp dir that does not carry the 'vs-' prefix is not the convention (an older one-off name is out of scope, and this suite says so rather than widening silently)");
  ok(!G.isFixtureProjectDir('-tmp-vs-'), 'the bare prefix with no tail is not a fixture dir');
  ok(G.isFixtureSid(fixtureSid('1')) && G.isFixtureSid('E2E00000-0000-4000-8000-00000000000A'),
    'the synthetic sid family is recognised, case-insensitively');
  ok(!G.isFixtureSid('c136a0b4-1111-4222-8333-444444444444'), 'a real conversation UUID is not a fixture sid');
  ok(G.isFixtureCwd('/tmp/vs-deskresume-cwd-7') && !G.isFixtureCwd('/home/u/work'),
    'isFixtureCwd answers the same question about a stored row’s cwd field');
  // scratch() and the guard must agree BY CONSTRUCTION — that is the whole
  // point of the shared constant.
  ok(G.isFixtureProjectDir(enc(scratch('sweep-selftest'))),
    'scratch() mints a path this rule recognises (the suites and the sweep read ONE constant)');
}

// ── ② THE SWEEP DECISION (pure, so the controls can drive it) ──────────────
{
  const now = 1_000_000_000_000;
  const old = now - G.FIXTURE_STALE_MS - 60_000;
  const young = now - 5_000;
  const r = G.fixtureLitter([
    { name: '-home-u-workspace-vibespace', mtimeMs: old },       // a real project
    { name: '-tmp-vs-chatpage-test-1', mtimeMs: old },           // LITTER
    { name: '-tmp-vs-wire-probe-abc', mtimeMs: young },          // declared, in flight
    { name: '-tmp-vs-wire-probe-def', mtimeMs: old },            // declared, but STALE
  ], { now });
  ok(r.offenders.some((o) => o.name === '-tmp-vs-chatpage-test-1'), 'an undeclared fixture dir is an offender');
  ok(!r.offenders.some((o) => o.name === '-home-u-workspace-vibespace'), 'a real project dir is never an offender');
  ok(r.spared.some((s) => s.name === '-tmp-vs-wire-probe-abc' && s.why),
    'a DECLARED real-home fixture in flight is SPARED, with the declared reason');
  ok(r.offenders.some((o) => o.name === '-tmp-vs-wire-probe-def' && o.declared),
    '…and the same declared prefix past the staleness threshold IS an offender (declared means "while running", not "for ever")');
  ok(typeof r.rule === 'string' && r.rule.length > 100, 'the decision carries the rule it applied');

  // ── ②b THE IN-FLIGHT GRACE (r3) ────────────────────────────────────────────
  // REPRODUCED before this was written: on this box, running the full fast
  // tier, a `-tmp-vs-chat-e2e-cwd-<mkdtemp>` dir 4 min old — created by a
  // CONCURRENT PRE-FIX checkout, a shape only master's test-chat-e2e can mint —
  // made `npm run ci` exit 1 here, in a worktree that could not have created
  // it, cannot remove it (every sweeper's floor is FIXTURE_STALE_MS) and is
  // provably unharmed by it (the walk ingests 0 events, discovery skips it).
  // The grace is OPT-IN so the per-suite censuses keep absolute strictness.
  {
    const nowMs = 2_000_000_000_000;
    const younger = nowMs - 4 * 60_000;          // the reproduced 4-min leftover
    const stale = nowMs - G.FIXTURE_STALE_MS - 1_000;
    const rows = [{ name: '-tmp-vs-chat-e2e-cwd-paw5IT', mtimeMs: younger }];
    const swept = G.fixtureLitter(rows, { now: nowMs, graceMs: G.FIXTURE_STALE_MS });
    const sp = swept.spared.find((s) => s.name === '-tmp-vs-chat-e2e-cwd-paw5IT');
    ok(swept.offenders.length === 0 && sp && sp.declared === false && /concurrent|running right now/i.test(sp.why),
      'GRACE: the whole-directory sweep SPARES an undeclared fixture dir younger than the threshold, and NAMES it (undeclared ⇒ declared:false, with a reason that says why nothing may remove it yet)',
      JSON.stringify(swept));
    // NEGATIVE CONTROL ①: the grace expires. A grace that never expires is the
    // vacuous direction — it would delete the sweep.
    const stillSwept = G.fixtureLitter([{ name: '-tmp-vs-chat-e2e-cwd-paw5IT', mtimeMs: stale }],
      { now: nowMs, graceMs: G.FIXTURE_STALE_MS });
    ok(stillSwept.offenders.length === 1 && stillSwept.offenders[0].declared === false,
      'NEGATIVE CONTROL: the SAME dir past the threshold is still an offender (the grace expires; it is "not yet litter", never "not litter")',
      JSON.stringify(stillSwept));
    // NEGATIVE CONTROL ②: the grace is OPT-IN. The four per-suite censuses call
    // fixtureLitter(added) with no options, on entries they already know are
    // new — mtime ≈ now, so ageMs can be 0. `graceMs > 0` is what keeps
    // `0 <= 0` from silently sparing a suite's own litter.
    const perSuite = G.fixtureLitter([
      { name: '-tmp-vs-chatpage-test-1', mtimeMs: nowMs },        // ageMs === 0
      { name: '-tmp-vs-chat-e2e-cwd-paw5IT', mtimeMs: younger },
    ], { now: nowMs });
    ok(perSuite.offenders.length === 2 && perSuite.spared.length === 0,
      'NEGATIVE CONTROL: with NO graceMs (the per-suite censuses\' call shape) a brand-new fixture dir — ageMs === 0 included — is STILL an offender',
      JSON.stringify(perSuite));
    // …and the decision reports the grace it applied, so the printed line and
    // the assert text cannot drift from the rule.
    ok(swept.graceMs === G.FIXTURE_STALE_MS && perSuite.graceMs === 0,
      'the decision carries the grace it applied (0 unless the caller opted in)');
    // The DECLARED spare keeps its own shape: same field, different reason.
    const dec = G.fixtureLitter([{ name: '-tmp-vs-wire-probe-abc', mtimeMs: younger }], { now: nowMs, graceMs: G.FIXTURE_STALE_MS });
    ok(dec.spared.length === 1 && dec.spared[0].declared === true && dec.spared[0].why !== G.IN_FLIGHT_WHY,
      'a DECLARED prefix is still spared for its OWN declared reason, never absorbed into the in-flight grace (the two answers stay distinguishable)',
      JSON.stringify(dec.spared));
  }
}

// ── ③ THE CONTROL: plant one under a THROWAWAY home and prove it is caught ──
// The real home must never be written to by this suite — so the "can this rule
// go red" proof happens somewhere disposable, and the assertion below about the
// REAL home is a pure read.
{
  const home = scratchHome('fixiso-control', fs);
  const projects = path.join(home, '.claude', 'projects');
  const cwd = scratch('fixiso-planted');
  const planted = path.join(projects, cwd.replace(/[/._]/g, '-'));
  const innocent = path.join(projects, '-home-u-some-real-project');
  fs.mkdirSync(planted, { recursive: true });
  fs.mkdirSync(innocent, { recursive: true });
  fs.writeFileSync(path.join(planted, `${fixtureSid('1')}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 50 } } }) + '\n');
  // back-date it past the threshold so it is litter, not a run in flight
  const old = (Date.now() - G.FIXTURE_STALE_MS - 60_000) / 1000;
  fs.utimesSync(planted, old, old);

  const entries = fs.readdirSync(projects, { withFileTypes: true })
    .map((d) => ({ name: d.name, mtimeMs: fs.statSync(path.join(projects, d.name)).mtimeMs }));
  const r = G.fixtureLitter(entries);
  ok(r.offenders.length === 1 && r.offenders[0].name === path.basename(planted),
    'CONTROL: a planted fixture under a throwaway home IS caught (the rule can go red)', JSON.stringify(r.offenders));
  ok(!r.offenders.some((o) => o.name === path.basename(innocent)),
    'CONTROL: the innocent project dir beside it is left alone');

  // …and the PRODUCTION readers refuse it even while it sits there.
  const { runUsageWalk } = require('../src/usage-walker.js');
  const walk = runUsageWalk({ home, cursorFile: path.join(home, 'cursor.json') });
  ok(walk.events.length === 0, `the usage walk ingests NOTHING from it (${walk.events.length} events)`, JSON.stringify(walk.events.slice(0, 1)));
  // NEGATIVE CONTROL for the walk: the same record in a REAL project dir is
  // counted, so "0 events" above is the guard and not a broken fixture.
  fs.mkdirSync(path.join(innocent), { recursive: true });
  fs.writeFileSync(path.join(innocent, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_real', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 50 } } }) + '\n');
  const walk2 = runUsageWalk({ home, cursorFile: path.join(home, 'cursor2.json') });
  ok(walk2.events.length === 1, `NEGATIVE CONTROL: a real project dir still walks (${walk2.events.length} event)`, JSON.stringify(walk2.events.slice(0, 1)));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ── ④ THE REAL HOME (read-only) ────────────────────────────────────────────
{
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let entries = null;
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtimeMs: (() => { try { return fs.statSync(path.join(projects, d.name)).mtimeMs; } catch { return 0; } })() }));
  } catch (e) {
    // No projects dir at all (a fresh box, a container) is not a failure — but
    // it must be SAID, or a green line would claim a measurement nobody took.
    console.log(`  ⚠ SKIP: cannot read ${projects} (${e.code || e.message}) — nothing measured here`);
  }
  if (entries) {
    // THE ONLY CALLER THAT PASSES `graceMs`. This is a shared directory other
    // checkouts on this box write to, and nothing in this tree may remove a
    // fixture dir younger than FIXTURE_STALE_MS (every sweeper's own floor), so
    // an in-flight entry is NAMED with its age instead of demanding a removal
    // that is not yet allowed. It becomes an offender the moment it goes stale.
    // The four per-suite censuses deliberately pass NO grace: their entries are
    // already diffed against a pre-run listing, so a grace there would spare
    // the suite's own litter. §2 controls both directions; §6 pins that no
    // other suite passes graceMs, and that this call still does.
    const r = G.fixtureLitter(entries, { graceMs: G.FIXTURE_STALE_MS });
    const declared = r.spared.filter((s) => s.declared), inFlight = r.spared.filter((s) => !s.declared);
    console.log(`  scanned ${entries.length} project dirs in ${projects}; spared ${declared.length} declared in-flight, ${inFlight.length} undeclared but younger than ${Math.round(r.graceMs / 60000)} min`);
    ok(r.offenders.length === 0,
      `the real ~/.claude/projects carries no STALE fixture project dir (${entries.length} entries scanned, grace ${Math.round(r.graceMs / 60000)} min)`,
      r.offenders.length
        ? `LITTER: ${JSON.stringify(r.offenders.slice(0, 5))}\n    A suite wrote a synthetic transcript into your real home. Isolate it\n    (scripts/scratch.mjs scratchHome) and remove the leftovers:\n    ${r.offenders.slice(0, 5).map((o) => 'rm -rf ' + JSON.stringify(path.join(projects, o.name))).join('\n    ')}`
        : '');
    for (const s of r.spared) console.log(`    spared ${s.name} (${Math.round(s.ageMs / 1000)}s old) — ${s.why}`);
  }
}


// ── ⑤ THE CENSUSES: derived by GREP over every suite, and PRINTED ─────────
// A hand-written list of "the suites that write fixtures" is the exact tool
// this class of defect has already defeated (kb: cli-identity r7 — a seven-file
// list missed 47 real signal paths). Both censuses below derive their file set
// from the sources, print what they walked, and are deliberately OVER-inclusive:
// a false positive widens enforcement, a false negative IS the defect.
{
  const here = path.dirname(new URL(import.meta.url).pathname);
  const suites = fs.readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
  const src = (f) => { try { return fs.readFileSync(path.join(here, f), 'utf-8'); } catch { return ''; } };

  // (a) NO SUITE MAY WRITE UNDER THE REAL ~/.claude. This is the defect itself,
  //     stated as a property of the source: bind anything to a path rooted at
  //     os.homedir()/.claude and then hand that binding to a write.
  //     READING the real home is fine (this suite does; test-codex-effort-meta
  //     measures the real corpus) — writing is not.
  const WRITES = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'openSync', 'writeSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'renameSync', 'symlinkSync', 'utimesSync', 'cpSync'];
  // THIS CENSUS HAS BEEN WIDENED TWICE, both times because it resolved exactly
  // the spellings its author had looked at. Recorded here because the SHAPE of
  // the two misses is the same and the next one will be too:
  //   ① the HOME spelling. The first version knew only `os.homedir()`, so the
  //      one suite that genuinely writes under the real home spelled it
  //      `process.env.HOME || os.homedir()` and the census printed a clean
  //      sheet while missing its only true subject.
  //   ② the TARGET spelling (this round). The write's first argument had to BE
  //      the bound name or `path.join(<bound name>, …)`, so ONE hop of
  //      aliasing defeated it: test-chat-e2e.mjs does
  //      `const p = path.join(REAL_PROJECTS, d.name)` and then `fs.rmSync(p)` —
  //      an `rm -rf` under the developer's real home that the census could not
  //      see, while the assert below said "no suite writes under the REAL
  //      ~/.claude". MEASURED before the fix: bound names ["REAL_PROJECTS"],
  //      hits [].
  // Both misses were "one more hop". So the resolver no longer stops at a hop
  // count: it takes the FIXPOINT of "a name derived from a name already known
  // to be rooted at the real home", and the write matcher asks whether the
  // call's FIRST ARGUMENT mentions such a name at all rather than whether it is
  // spelled one of two ways. Deliberately over-inclusive, and the cost was
  // measured rather than assumed: over all 197 suites the transitive rule flags
  // exactly one file the narrow one missed (test-chat-e2e, declared below) and
  // no others.
  const ESC = (n) => n.replace(/[.()$]/g, '\\$&');
  const realHomeWriters = (source) => {
    const roots = new Set(['os.homedir()', 'homedir()']);
    for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env\.HOME\s*\|\|\s*)?(?:os\.)?homedir\(\)/g)) roots.add(m[1]);
    const rootAlt = [...roots].map(ESC).join('|');
    // SEED: `const NAME = path.join(<a real home>, … '.claude' …)`.
    const names = new Set();
    for (const m of source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*(?:` + rootAlt + String.raw`)[^;\n]*?['"` + '`' + String.raw`]\.claude['"` + '`' + String.raw`]`, 'g'))) names.add(m[1]);
    // FIXPOINT: a path derived from one of those names is one of those names.
    // Two derivation shapes cover what this repo actually writes: the known
    // name as the HEAD of the right-hand side (plain alias, `X + '/y'`,
    // `` `${X}/y` ``) and the known name ANYWHERE inside a path.join/resolve.
    for (let pass = 0; pass < 8; pass++) {
      const before = names.size;
      for (const n of [...names]) {
        const e = ESC(n);
        for (const m of source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\`\$\{\s*)?` + e + String.raw`\b`, 'g'))) names.add(m[1]);
        for (const m of source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\([^;\n]{0,200}?\b` + e + String.raw`\b`, 'g'))) names.add(m[1]);
      }
      if (names.size === before) break;
    }
    const hits = [];
    for (const n of names) {
      const e = ESC(n);
      for (const w of WRITES) {
        // Does the call's FIRST argument mention the name? `[^,)]` cannot cross
        // into a later argument, so `fs.writeFileSync(elsewhere, X)` (X as the
        // CONTENT) is not a hit, while `fs.rmSync(X, …)`,
        // `fs.mkdirSync(path.join(X, …))` and ``fs.writeFileSync(`${X}/y`, …)``
        // all are.
        if (new RegExp(`\\.${w}\\(\\s*[^,)]{0,200}?\\b${e}\\b`).test(source)) hits.push(`${w}(${n})`);
      }
    }
    return hits;
  };
  /** The census re-run over a source with one region cut out — how a write
   *  exception is scoped to a BLOCK instead of to a whole file. */
  const realHomeWritersOutside = (source, startMark, endMark) => {
    const a = source.indexOf(startMark), b = source.indexOf(endMark);
    if (a < 0 || b <= a) return { ok: false, hits: [], region: 0 };
    return { ok: true, region: b - a, hits: realHomeWriters(source.slice(0, a) + source.slice(b + endMark.length)) };
  };
  // THE ONE EXEMPTION, with the property that replaces it. This suite's own
  // CONTROLS are synthetic sources spelled inline, so a text census finds the
  // forbidden shape in its own string literals — the same reason
  // test-architecture excludes itself from the NUL census. Instead of trusting
  // it, the exemption is paid for below: §4 (the only place this file touches
  // the real home) is extracted and asserted to contain NO write call at all.
  const CENSUS_SELF = 'test-fixture-isolation.mjs';
  // THE DECLARED WRITE EXCEPTIONS. Two suites really do touch the real
  // ~/.claude, and each must. Asserted LIVE and PAID FOR below — a dead
  // exemption fails, like every other allowlist in this repo — and each pays
  // with the property that actually bounds ITS damage, never with a note:
  //   · test-stdout-registry PLANTS directories (it tests the wire probe's
  //     residue contract, and the probe writes where the probe writes), so it
  //     pays with the DECLARED PREFIX + a cleanup that survives a signal.
  //   · test-chat-e2e DELETES, and only names it minted itself. It pays with a
  //     REGION SCOPE: the exemption covers the block between its sentinels and
  //     nothing else, and its three gates are pinned so a widened filter goes
  //     red. A file-scoped exemption would have silently blessed every future
  //     write in that file — the exemption is the dangerous half of a census,
  //     so it gets the tighter property the shape allows.
  const WRITE_EXEMPT = [
    { file: 'test-stdout-registry.mjs', why: "tests the wire probe's residue contract, so it must plant where the probe plants; every dir it creates carries the declared vs-wire-probe- prefix and is removed in a finally + an exit handler" },
    { file: 'test-chat-e2e.mjs', why: 'sweeps ITS OWN pre-fix leftovers out of the real home, exactly like the wire probe: a DELETE, gated on the declared fixture convention + this suite\'s own name + the shared staleness threshold, inside one sentinel-marked block that is the file\'s only real-home write' },
  ];
  const exemptWriters = new Set([CENSUS_SELF, ...WRITE_EXEMPT.map((e) => e.file)]);
  for (const e of WRITE_EXEMPT) {
    const t = src(e.file);
    ok(realHomeWriters(t).length > 0, `write exemption is LIVE: ${e.file} really writes under the real ~/.claude (${e.why})`);
  }
  {
    const t = src('test-stdout-registry.mjs');
    ok(/vs-wire-probe-/.test(t) && /process\.on\('exit'/.test(t) && /finally\s*\{[^}]*rmCtl/.test(t),
      '…and it is PAID FOR: test-stdout-registry.mjs plants only DECLARED-prefix names and removes them in a finally + an exit handler');
  }
  {
    // PAYING FOR test-chat-e2e's exemption, in two halves.
    const t = src('test-chat-e2e.mjs');
    const START = '// >>> real-home sweep', END = '// <<< real-home sweep';
    // ① SCOPE. Cut the declared block out and re-run the census: what is left
    //    must be EMPTY. This is what keeps the exemption from covering the
    //    whole file — a second real-home write anywhere else in this suite goes
    //    red even though the suite is on the list.
    const outside = realHomeWritersOutside(t, START, END);
    ok(outside.ok && outside.hits.length === 0,
      `…and it is PAID FOR ①: test-chat-e2e.mjs's exemption is scoped to its sentinel-marked sweep (${outside.region} chars); the REST of the file writes nothing under the real home`,
      JSON.stringify({ found: outside.ok, hits: outside.hits }));
    // ② THE GATES. The block may only delete this suite's own stale fixtures,
    //    so all three filters must be in it. Widening any of them (dropping the
    //    convention check, the suite-name check, or the age check) is what would
    //    turn a self-sweep into an rm -rf of the developer's conversations.
    const region = outside.ok ? t.slice(t.indexOf(START), t.indexOf(END)) : '';
    const gates = {
      convention: /isFixtureProjectDir\(/.test(region),
      ownName: /includes\(\s*['"`]chat-e2e['"`]\s*\)/.test(region),
      staleness: /FIXTURE_STALE_MS/.test(region),
      deleteOnly: WRITES.filter((w) => new RegExp(`\\.${w}\\(`).test(region)).join(',') === 'rmSync',
    };
    ok(Object.values(gates).every(Boolean),
      '…and it is PAID FOR ②: that sweep only DELETES, and only what passes the declared convention + its own suite name + the shared staleness threshold',
      JSON.stringify(gates));
  }
  const writerOffenders = suites.filter((f) => !exemptWriters.has(f))
    .map((f) => ({ f, hits: realHomeWriters(src(f)) })).filter((x) => x.hits.length);
  console.log(`  census (a): walked ${suites.length - exemptWriters.size} suites (+${exemptWriters.size} exempt: ${[...exemptWriters].join(', ')}) for a WRITE rooted at the real home's .claude`);
  ok(writerOffenders.length === 0,
    'no suite writes under the REAL ~/.claude (reading it is fine; writing is the defect)',
    JSON.stringify(writerOffenders));
  {
    // PAYING FOR THE EXEMPTION: this file's real-home section is READ-ONLY.
    const self = src(CENSUS_SELF);
    const a = self.indexOf('// \u2500\u2500 \u2463 THE REAL HOME');
    const b = self.indexOf('// \u2500\u2500 \u2464 THE CENSUSES');
    const region = a >= 0 && b > a ? self.slice(a, b) : '';
    const writesHere = WRITES.filter((w) => new RegExp(`\\.${w}\\(`).test(region));
    ok(region.length > 200 && writesHere.length === 0,
      `the exemption is PAID FOR: this suite's own real-home section is read-only (${region.length} chars, 0 write calls)`,
      JSON.stringify({ region: region.length, writesHere }));
    // …and the exemption is LIVE (it really would trip the census), so it can
    // never quietly become a dead entry nobody notices.
    ok(realHomeWriters(self).length > 0,
      `the exemption is LIVE: ${CENSUS_SELF} really carries the forbidden shape (in its CONTROL strings) — a dead exemption fails`);
  }
  // CONTROLS for (a): the rule must be able to go red, and must not fire on a
  // read. Synthetic sources, so nothing on disk has to be broken to prove it.
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nfs.mkdirSync(path.join(P, 'x'), { recursive: true });").length === 1,
    'CONTROL (a): a write rooted at the real ~/.claude IS caught');
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nconst n = fs.readdirSync(P).length;").length === 0,
    'CONTROL (a): a READ of the real ~/.claude is not (this suite and the corpus measurement do exactly that)');
  ok(realHomeWriters("const P = path.join(fakeHome, '.claude', 'projects');\nfs.mkdirSync(P, { recursive: true });").length === 0,
    'CONTROL (a): a write under an ISOLATED home is not flagged');
  ok(realHomeWriters("const home = process.env.HOME || os.homedir();\nconst P = path.join(home, '.claude', 'projects');\nfs.mkdirSync(P, { recursive: true });").length === 1,
    'CONTROL (a): the INDIRECT spelling (const home = process.env.HOME || os.homedir()) is caught too — the narrow first version missed the one suite that really writes there');
  // THE SECOND WIDENING'S CONTROLS. Each is the shape that defeated a previous
  // version, kept forever as a negative control the way this repo keeps retired
  // rules: the first is test-chat-e2e's own spelling, byte-for-byte.
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nconst p = path.join(P, d.name);\nfs.rmSync(p, { recursive: true, force: true });").length === 1,
    'CONTROL (a): ONE HOP of aliasing (const p = path.join(P, d)) is caught — this exact shape is an rm -rf under the real home that the shipped census reported as a clean sheet');
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nconst q = path.join(P, a);\nconst r = path.join(q, b);\nfs.writeFileSync(r, '');").length === 1,
    'CONTROL (a): TWO hops are caught as well — the resolver takes a fixpoint, so the rule is not "the author thought of one more level"');
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nconst p = `${P}/x`;\nfs.writeFileSync(p, '');").length === 1,
    'CONTROL (a): a TEMPLATE-LITERAL derivation is caught (path.join is not the only way to build a path)');
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nfs.writeFileSync(`${P}/x`, '');").length === 1,
    'CONTROL (a): …and the same spelling INLINE as the write target is caught');
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nconst p = path.join(P, d);\nconst n = fs.readdirSync(p).length;\nconst s = fs.statSync(p);").length === 0,
    'CONTROL (a): an aliased READ of the real ~/.claude is STILL not flagged — the widening did not turn every reader into an offender');
  ok(realHomeWriters("const P = path.join(os.homedir(), '.claude', 'projects');\nfs.writeFileSync(path.join(scratchDir, 'log'), P);").length === 0,
    'CONTROL (a): the real-home path used as CONTENT (a later argument) is not a write TO it — the matcher cannot cross into another argument');
  // CONTROLS for the REGION SCOPE: it must catch a write outside the sentinels
  // (that is its whole job) and must not be satisfiable by an absent block.
  {
    const inside = "const P = path.join(os.homedir(), '.claude', 'projects');\n// >>> real-home sweep\nconst p = path.join(P, d);\nfs.rmSync(p, {});\n// <<< real-home sweep\n";
    const alsoOutside = inside + "const q = path.join(P, other);\nfs.rmSync(q, {});\n";
    ok(realHomeWritersOutside(inside, '// >>> real-home sweep', '// <<< real-home sweep').hits.length === 0,
      'CONTROL: a real-home write INSIDE the declared sentinels is covered by the exemption');
    ok(realHomeWritersOutside(alsoOutside, '// >>> real-home sweep', '// <<< real-home sweep').hits.length === 1,
      'CONTROL: a SECOND real-home write outside them is NOT — the exemption is scoped to the block, not to the file');
    ok(realHomeWritersOutside(inside.replace('// <<< real-home sweep', ''), '// >>> real-home sweep', '// <<< real-home sweep').ok === false,
      'CONTROL: a missing sentinel is a FAILURE, not an empty region that passes vacuously');
  }

  // (b) THE ISOLATION CENSUS — THE DEFECT ITSELF, AS A PROPERTY OF THE SOURCE.
  //     Set = every suite that spawns `server.js` AND writes a transcript into
  //     a `.claude/projects` path. Such a server can only discover what lives
  //     under the home it is RUNNING with, so the suite must NAME a HOME in
  //     that spawn env; the two offenders named none and inherited the
  //     developer's. Derived, printed, and green for the five suites that were
  //     already doing it right — the point is that the class is covered, not
  //     that three files are listed somewhere.
  // The commit whose bytes carried the defect. `master` is the integration
  // branch this work is cut from; if it ever stops containing the pre-fix
  // shape the control SKIPs loudly rather than claiming a measurement.
  // A PINNED commit, never a branch name: `master` was pre-fix only until this
  // fix MERGED into it, after which the control read the FIXED bytes and went
  // red on the release gate that carried the fix (2.369.85's first push).
  // e87d9893 = 2.369.83, the last master commit whose copies of both suites
  // still spawn a server with no HOME in its env. Unreachable (shallow clone,
  // tarball) ⇒ the loud SKIP below, never a red.
  const PRE_FIX_REF = process.env.VIBESPACE_FIXTURE_PREFIX_REF || 'e87d9893';
  const spawnsServer = (t) => /\[\s*['"`]server\.js['"`]\s*\]/.test(t);
  const writesTranscript = (t) => /['"`]\.claude['"`]\s*,\s*['"`]projects['"`]/.test(t) && /writeFileSync|writeSync|openSync/.test(t);
  const namesHome = (t) => {
    // the HOME must be in the env of a server.js spawn, not merely mentioned
    for (const m of t.matchAll(/spawn\([^;]*?['"`]server\.js['"`][^;]*?\{[^;]*?env\s*:\s*\{([^}]*)\}/gs)) {
      if (!/\bHOME\s*:/.test(m[1])) return false;
    }
    return /spawn\([^;]*?['"`]server\.js['"`]/s.test(t);
  };
  // Excluded for the same reason as (a): the CONTROLS below spell the shape
  // inline. Paid for by a stronger property than any exemption note — this file
  // never imports child_process, so it structurally CANNOT spawn a server.
  const serverWriters = suites.filter((f) => f !== CENSUS_SELF && spawnsServer(src(f)) && writesTranscript(src(f)));
  {
    // PAYING FOR THE (b) EXEMPTION. This file DOES start a child — the
    // retired-bytes control runs `git show` — so "it never imports
    // child_process" would be a false claim (it was true for about ten
    // minutes, until that control was added; an exemption proof that quietly
    // stops being true is worse than no exemption). The honest, checkable
    // property is that every child it starts is `git`: it never runs
    // server.js, so it cannot be the defect it measures.
    const selfSrc = src(CENSUS_SELF);
    const spawns = [...selfSrc.matchAll(/\b(?:execFileSync|execSync|spawnSync|spawn)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)]
      .map((m) => m[1] ?? m[2] ?? m[3]);
    ok(spawns.length > 0 && spawns.every((c) => c === 'git'),
      `the (b) exemption is PAID FOR: every child ${CENSUS_SELF} starts is git (${JSON.stringify(spawns)}) — it never runs server.js`);
  }
  ok(spawnsServer(src(CENSUS_SELF)) && writesTranscript(src(CENSUS_SELF)),
    `the (b) exemption is LIVE: ${CENSUS_SELF} really carries the shape (in its CONTROL strings) — a dead exemption fails`);
  console.log(`  census (b): suites that spawn server.js AND write a transcript: ${serverWriters.join(', ') || '(none)'}`);
  ok(serverWriters.length >= 3, `the isolation census found the class (${serverWriters.length} suites)`, JSON.stringify(serverWriters));
  const unisolated = serverWriters.filter((f) => !namesHome(src(f)));
  ok(unisolated.length === 0,
    'every one of them NAMES a HOME in the server spawn env (the defect was naming none and inheriting the developer\'s)',
    JSON.stringify(unisolated));
  // CONTROLS for (b), synthetic sources so nothing on disk must be broken.
  {
    const bad = "fs.writeFileSync(path.join(h, '.claude', 'projects', d, 'x.jsonl'), '');\nconst srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });";
    const good = bad.replace('PORT: String(PORT)', 'PORT: String(PORT), HOME: fakeHome');
    ok(spawnsServer(bad) && writesTranscript(bad) && !namesHome(bad), 'CONTROL (b): the PRE-FIX shape (no HOME in the spawn env) IS caught');
    ok(namesHome(good), 'CONTROL (b): adding HOME to that same spawn env is the whole fix');
  }
  // THE STRONGEST CONTROL: the RETIRED BYTES, not a paraphrase of them. The two
  // offenders exist verbatim in git history, so the census is run against what
  // actually shipped rather than against what this file remembers of it. A
  // paraphrased control is a control for the paraphrase (kb: "negative controls
  // must be the real module's patched copy"). git is asked through the SHARED
  // sanitized environment — this suite runs inside `npm run ci`, i.e. inside a
  // pre-push hook that exports GIT_DIR/GIT_INDEX_FILE — and a tree git cannot
  // read (a tarball, an export, no git on PATH) is a LOUD SKIP, never a red.
  {
    let skip = null, caught = [];
    try {
      const { execFileSync } = await import('node:child_process');
      const { gitEnvFrom } = await import('./git-env.mjs');
      const env = gitEnvFrom(process.env);
      const repoRoot = path.join(here, '..');
      for (const f of ['scripts/test-chat-paging.mjs', 'scripts/test-minimap-jump.mjs']) {
        let t = '';
        try { t = execFileSync('git', ['-C', repoRoot, 'show', `${PRE_FIX_REF}:${f}`], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { skip = `git show ${PRE_FIX_REF}:${f} failed: ${String(e.stderr || e.message).trim().slice(0, 160)}`; break; }
        caught.push({ f, inScope: spawnsServer(t) && writesTranscript(t), caught: spawnsServer(t) && writesTranscript(t) && !namesHome(t) });
      }
    } catch (e) { skip = `cannot ask git: ${e.message}`; }
    if (skip) console.log(`  ⚠ SKIP: the retired-bytes control could not run — ${skip}`);
    else {
      ok(caught.length === 2 && caught.every((c) => c.inScope && c.caught),
        `RETIRED-BYTES CONTROL: the census catches BOTH offenders as they actually shipped at ${PRE_FIX_REF} (${JSON.stringify(caught)})`);
    }
  }

  // (c) THE SUITES THAT CARRY A SYNTHETIC SESSION ID must mint it, clean up on
  //     signals, and census the real home themselves. Set derived from whoever
  //     calls fixtureSid(). Scoped to THEM on purpose: a suite that hands the
  //     family to the code under test IN-PROCESS (test-usage-walk-parity's
  //     parity table, test-migrations' disk-shaped fixture) must be able to
  //     SPELL what the guard refuses, and a drifted literal there fails that
  //     suite's own assertion immediately — no silent coverage gap.
  const carriers = suites.filter((f) => /fixtureSid\(/.test(src(f)) && f !== CENSUS_SELF);
  console.log(`  census (c): suites carrying a synthetic session id into a server's home: ${carriers.join(', ') || '(none)'}`);
  ok(carriers.length >= 3, `the census found the fixture-carrying suites (${carriers.length})`, JSON.stringify(carriers));
  ok(carriers.every((f) => serverWriters.includes(f)),
    'every fixture carrier is in the isolation census too (the two sets are about one class of suite)');
  const SID_LITERAL = /['"`]e2e00000-0000-4000-8000-/i;
  for (const f of carriers) {
    const t = src(f);
    ok(/scratchHome\(/.test(t) && /HOME:\s*fakeHome/.test(t),
      `${f} runs its server under an ISOLATED home (scratchHome + HOME: fakeHome)`);
    ok(!SID_LITERAL.test(t), `${f} MINTS its session id (fixtureSid), never a hand-spelled literal that could drift from the guard`);
    ok(/for \(const sig of \[/.test(t) && /SIGTERM/.test(t) && /SIGINT/.test(t),
      `${f} cleans up on SIGNALS too ('exit' does not fire for a default-terminated SIGINT/SIGTERM)`);
    ok(/fixtureLitter\(/.test(t),
      `${f} asserts the real ~/.claude/projects gained no fixture entry (its own per-suite census)`);
  }

  // (d) scratch.mjs is the ONE minter, and it reads the ONE constant.
  const scratchSrc = src('scratch.mjs') || (() => { try { return fs.readFileSync(path.join(here, 'scratch.mjs'), 'utf-8'); } catch { return ''; } })();
  ok(/fixture-guard\.js/.test(scratchSrc) && /FIXTURE_CWD_PREFIX/.test(scratchSrc),
    'scratch.mjs mints paths from src/fixture-guard.js, never from its own literals');
  // Comments may SAY `/tmp/vs-<name>-<pid>` (that is the documentation); code
  // may not spell it. Whole-line comments blanked, like every census here.
  const scratchCode = scratchSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/['"`]\/tmp\/vs-/.test(scratchCode), 'scratch.mjs CODE carries no hand-spelled /tmp/vs- literal (comments may document the shape)');

  // (e) test-chat-e2e runs a REAL turn; it gets the same isolation + an
  //     unconditional cleanup (its old one sat past four early exits).
  const e2e = src('test-chat-e2e.mjs');
  ok(/scratchHome\(/.test(e2e) && /HOME:\s*fakeHome/.test(e2e),
    'test-chat-e2e runs its real haiku turn under an ISOLATED home (measured viable: the CLI serves a turn on the oat alone)');
  ok(/process\.on\('exit', cleanup\)/.test(e2e) && /for \(const sig of \[/.test(e2e),
    'test-chat-e2e cleans up unconditionally (exit + signals), not at the end of the happy path');

  // (f) The PRODUCTION readers ask the shared rule — the half that survives a
  //     leftover no cleanup ever reached.
  for (const [rel, why] of [['../src/usage-walker.js', 'the usage walk'], ['../src/session-store.js', 'session discovery']]) {
    const t = (() => { try { return fs.readFileSync(path.join(here, rel), 'utf-8'); } catch { return ''; } })();
    ok(/require\(['"]\.\/fixture-guard\.js['"]\)/.test(t) && /isFixtureProjectDir\(/.test(t) && /isFixtureSid\(/.test(t),
      `${why} asks src/fixture-guard.js (a leftover can never become usage or a conversation)`);
  }
  // …and the shipped single-file scanner carries the INLINE copy (a
  // checkout-less ssh host cannot require src/), behaviourally pinned by
  // test-usage-walk-parity.
  const scan = (() => { try { return fs.readFileSync(path.join(here, '..', 'data', 'bin', 'vibespace-usage-scan'), 'utf-8'); } catch { return ''; } })();
  ok(/isFixtureProjectDir/.test(scan) && /isFixtureSid/.test(scan) && /FIXTURE_SID_PREFIX/.test(scan),
    'the shipped scanner carries the inline copy of the convention (parity-pinned by test-usage-walk-parity)');
}

// ── ⑥ THE GRACE IS WIRED TO EXACTLY ONE CALLER (r3 WIRING PIN) ─────────────
// The in-flight grace is a RELAXATION, so its blast radius is the thing to
// pin: it belongs to the whole-directory sweep, which looks at a shared
// resource, and to nothing else. The four per-suite censuses hand
// fixtureLitter() entries they already diffed against a pre-run listing — a
// grace there would spare the suite's OWN litter, which is the whole defect
// this suite exists to catch. Derived by grep over every suite and PRINTED,
// like the censuses above: a pure-function relaxation with no wiring pin is
// the "unstaged wiring" class (2.355.0) waiting to happen in reverse.
{
  const here = path.dirname(new URL(import.meta.url).pathname);
  const suites = fs.readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
  const src = (f) => { try { return fs.readFileSync(path.join(here, f), 'utf-8'); } catch { return ''; } };
  const SELF = 'test-fixture-isolation.mjs';
  // A call site = `fixtureLitter(` plus its argument text up to the statement
  // end; `[^;\n]` cannot cross into the next statement, so a later mention of
  // graceMs is not attributed to this call.
  const graceCallers = [];
  const callers = [];
  for (const f of suites) {
    const t = src(f);
    for (const m of t.matchAll(/fixtureLitter\(([^;]{0,300})/g)) {
      callers.push(f);
      if (/graceMs/.test(m[1])) graceCallers.push(f);
    }
  }
  const others = [...new Set(graceCallers.filter((f) => f !== SELF))];
  console.log(`  census (g): ${callers.length} fixtureLitter() call sites across ${new Set(callers).size} suites; graceMs passed by: ${[...new Set(graceCallers)].join(', ') || '(none)'}`);
  ok(others.length === 0,
    'ONLY the standing sweep may pass graceMs — no per-suite census relaxes its own measurement',
    JSON.stringify(others));
  // …and the sweep really does pass it: a relaxation nobody wired is the
  // reproduced defect still shipping (that is what the OTHER half of a wiring
  // pin is for — this assert goes red if §4 loses the option).
  {
    const self = src(SELF);
    const a = self.indexOf('// ── ④ THE REAL HOME');
    const b = self.indexOf('// ── ⑤ THE CENSUSES');
    const region = a >= 0 && b > a ? self.slice(a, b) : '';
    ok(region.length > 200 && /fixtureLitter\([^;]{0,300}graceMs:\s*G\.FIXTURE_STALE_MS/.test(region),
      '…and §4 (the whole-directory sweep) DOES pass it, at the shared FIXTURE_STALE_MS — the floor every sweeper in this tree already refuses to delete below',
      JSON.stringify({ region: region.length }));
  }
  // CONTROLS: the census can go red, and it does not fire on a plain call.
  const scan = (t) => { const out = []; for (const m of t.matchAll(/fixtureLitter\(([^;]{0,300})/g)) if (/graceMs/.test(m[1])) out.push(1); return out.length; };
  ok(scan('const lit = fixtureLitter(added, { graceMs: G.FIXTURE_STALE_MS });') === 1,
    'CONTROL (g): a per-suite census that relaxed itself WOULD be caught');
  ok(scan('const lit = fixtureLitter(added);\nconst graceMs = 0;') === 0,
    'CONTROL (g): a plain call is not flagged by a later mention of graceMs (the matcher cannot cross the statement end)');
}

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
