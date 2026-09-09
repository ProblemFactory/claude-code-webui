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
    const r = G.fixtureLitter(entries);
    console.log(`  scanned ${entries.length} project dirs in ${projects}; spared ${r.spared.length} declared in-flight`);
    ok(r.offenders.length === 0,
      `the real ~/.claude/projects carries no fixture project dir (${entries.length} entries scanned)`,
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
  const realHomeWriters = (source) => {
    // WHAT COUNTS AS "the real home" — widened the moment this census first ran
    // for real: `os.homedir()` directly, AND the very common indirection
    // `const home = process.env.HOME || os.homedir()`. The one suite that
    // genuinely writes there spells it the second way, so the narrow version
    // reported a clean sheet while missing its only true subject.
    const roots = new Set(['os.homedir()', 'homedir()']);
    for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env\.HOME\s*\|\|\s*)?(?:os\.)?homedir\(\)/g)) roots.add(m[1]);
    const rootAlt = [...roots].map((r) => r.replace(/[.()$]/g, '\\$&')).join('|');
    const names = new Set();
    for (const m of source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*(?:` + rootAlt + String.raw`)[^;\n]*?['"` + '`' + String.raw`]\.claude['"` + '`' + String.raw`]`, 'g'))) names.add(m[1]);
    const hits = [];
    for (const n of names) {
      const esc = n.replace(/\$/g, '\\$');
      for (const w of WRITES) {
        // fs.writeFileSync(X, …) / fs.mkdirSync(path.join(X, …)) / fs.rmSync(X…
        const re = new RegExp(`\\.${w}\\(\\s*(?:path\\.join\\(\\s*)?${esc}\\b`);
        if (re.test(source)) hits.push(`${w}(${n})`);
      }
    }
    return hits;
  };
  // THE ONE EXEMPTION, with the property that replaces it. This suite's own
  // CONTROLS are synthetic sources spelled inline, so a text census finds the
  // forbidden shape in its own string literals — the same reason
  // test-architecture excludes itself from the NUL census. Instead of trusting
  // it, the exemption is paid for below: §4 (the only place this file touches
  // the real home) is extracted and asserted to contain NO write call at all.
  const CENSUS_SELF = 'test-fixture-isolation.mjs';
  // THE DECLARED WRITE EXCEPTIONS. Exactly one suite really does plant a
  // directory under the real ~/.claude, and it must: it tests the WIRE PROBE's
  // residue contract, and the probe writes where the probe writes. Everything
  // it plants carries the declared `vs-wire-probe-` prefix (so the sweep's own
  // spare/flag rule governs it) and is removed in a `finally` plus an exit
  // handler. Asserted LIVE and PAID FOR below — a dead exemption fails, like
  // every other allowlist in this repo.
  const WRITE_EXEMPT = [
    { file: 'test-stdout-registry.mjs', why: "tests the wire probe's residue contract, so it must plant where the probe plants; every dir it creates carries the declared vs-wire-probe- prefix and is removed in a finally + an exit handler" },
  ];
  const exemptWriters = new Set([CENSUS_SELF, ...WRITE_EXEMPT.map((e) => e.file)]);
  for (const e of WRITE_EXEMPT) {
    const t = src(e.file);
    ok(realHomeWriters(t).length > 0, `write exemption is LIVE: ${e.file} really writes under the real ~/.claude (${e.why})`);
    ok(/vs-wire-probe-/.test(t) && /process\.on\('exit'/.test(t) && /finally\s*\{[^}]*rmCtl/.test(t),
      `…and it is PAID FOR: ${e.file} plants only DECLARED-prefix names and removes them in a finally + an exit handler`);
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
  const PRE_FIX_REF = process.env.VIBESPACE_FIXTURE_PREFIX_REF || 'master';
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

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
