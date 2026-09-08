#!/usr/bin/env node
// THE RELEASE GATE'S OWN GATE (2026-09-07, B-4c5a — the fast/heavy split).
//
// The gate is now a machine with opinions: a tier table, a census, a detached
// background run, and a rule that BLOCKS a push based on git ancestry. Every
// one of those can be wrong in a way that is invisible (a census that cannot
// go red; a block rule that blocks forever; a hook that runs the two-minute
// tier before discovering it was going to refuse the push anyway; a detached
// child that inherits the hook's GIT_DIR and does `git worktree add` in
// somebody else's repository). So they are tested here, against REAL git
// history in throwaway repositories and against the REAL tracked hook file —
// never a mock of git and never a paraphrase of the hook.
//
// Sections: §1 census (+ negative controls) · §2 tier hygiene · §3 the block
// rule over real commits · §4 the hook's control flow end-to-end · §5 the git
// environment the detached child must NOT inherit (with the damage as the
// negative control) · §6 no FAST-tier suite claims a machine-global fixture,
// and every "no verdict" path says so up front and at the end (round 2).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUITES, EXCLUDED, censusFindings, listSuiteFiles, heavyBlocker, machineGlobalFixtures, defaultLockPath, killedFromOutside } from './ci.mjs';
import { GIT_REDIRECTORS, gitEnvFrom } from './git-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ENV = gitEnvFrom(process.env);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };
const tmpDirs = [];
const mktmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `vs-cigate-${tag}-`)); tmpDirs.push(d); return d; };
const git = (root, args, env = GIT_ENV) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
};

// A throwaway repository with REAL commits — the block rule is a statement
// about ancestry and there is no honest way to test it without one.
function makeRepo(tag) {
  const d = mktmp(tag);
  git(d, ['init', '-q', '-b', 'main']);
  git(d, ['config', 'user.email', 'gate@test.local']);
  git(d, ['config', 'user.name', 'gate test']);
  git(d, ['config', 'commit.gpgsign', 'false']);
  return d;
}
function commit(repo, file, body, msg) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), body);
  git(repo, ['add', '-f', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}
const writeMarker = (dir, sha, result, failed = [], partial = undefined, flaky = undefined) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.${result}`), JSON.stringify({ sha, result, failed, partial, flaky, endedAt: Date.now(), ms: 1000, suites: 3 }));
};

try {
// ── §1 THE CENSUS ────────────────────────────────────────────────────────
console.log('\n§1 census');
{
  const disk = listSuiteFiles(REPO);
  const f = censusFindings(disk);
  ok(disk.length > 100, `${disk.length} scripts/test-*.mjs on disk (scope is non-vacuous)`);
  ok(!f.unclassified.length, `every suite is tiered or excluded (${f.unclassified.slice(0, 5).join(', ') || 'none missing'})`);
  ok(!f.ghosts.length && !f.inBoth.length && !f.duplicated.length && !f.badTier.length && !f.reasonless.length,
    'no ghosts / double listings / duplicates / bad tiers / reasonless entries');
  ok(f.counted.fast + f.counted.heavy + f.counted.excluded === f.counted.disk,
    `the three buckets EXACTLY partition the disk set (${f.counted.fast}+${f.counted.heavy}+${f.counted.excluded}=${f.counted.disk})`);
  // THIS suite must itself be in the census — a gate that forgets to gate
  // itself is the exact failure mode this file exists for.
  ok(SUITES.some((s) => s.name === 'test-ci-gate'), 'test-ci-gate is in a tier (the gate gates itself)');

  // NEGATIVE CONTROLS — an assert that cannot fail is not an assert.
  const nc1 = censusFindings([...disk, 'test-brand-new-and-unlisted']);
  ok(nc1.unclassified.includes('test-brand-new-and-unlisted'), 'NEG: a new unlisted suite is reported as unclassified');
  const nc2 = censusFindings(disk, [...SUITES, { name: 'test-not-on-disk', tier: 'heavy', why: 'chrome' }]);
  ok(nc2.ghosts.includes('test-not-on-disk'), 'NEG: a table entry with no file is reported as a ghost');
  const nc3 = censusFindings(disk, [...SUITES, { name: SUITES[0].name, tier: 'heavy', why: 'x' }]);
  ok(nc3.duplicated.includes(SUITES[0].name), 'NEG: a suite listed twice is reported');
  const nc4 = censusFindings(disk, [...SUITES.filter((s) => s.tier !== 'heavy'), { name: SUITES.find((s) => s.tier === 'heavy').name, tier: 'heavy' }]);
  ok(nc4.reasonless.length === 1, 'NEG: a heavy entry with no stated reason is reported');
  const nc5 = censusFindings(disk, SUITES, [...EXCLUDED, { name: SUITES[0].name, why: 'x' }]);
  ok(nc5.inBoth.includes(SUITES[0].name), 'NEG: a suite both tiered and excluded is reported');
}

// ── §2 TIER HYGIENE ──────────────────────────────────────────────────────
console.log('\n§2 tier hygiene');
{
  const fast = SUITES.filter((s) => s.tier === 'fast');
  const heavy = SUITES.filter((s) => s.tier === 'heavy');
  ok(fast.length >= 20 && heavy.length >= 20, `both tiers are real batteries (${fast.length} fast / ${heavy.length} heavy)`);
  ok(heavy.every((s) => /chrome|server|cli|binary|slow|adopted/.test(s.why || '')),
    'every heavy row names a category (chrome/server/cli/binary/slow/adopted)');
  ok(heavy.every((s) => /\d/.test(s.why || '')), 'every heavy row carries a measured number (tiering is a measurement, not an opinion)');
  // The documented exception: one real chat turn costs ~10s and real quota,
  // so by the rule it is heavy — it stays fast because it is the only proof in
  // the whole battery that a real turn works.
  ok(fast.some((s) => s.name === 'test-chat-e2e'), 'the ONE real haiku turn stays in the FAST tier (owner decision)');
  // A chrome suite in the fast tier would silently reintroduce the 70s+ cost
  // the split exists to remove.
  const chromeInFast = fast.filter((s) => /chrome/.test(s.why || ''));
  ok(!chromeInFast.length, `no chrome suite in the fast tier (${chromeInFast.map((s) => s.name).join(', ') || 'clean'})`);
  ok(EXCLUDED.every((e) => (e.why || '').length > 15), 'every EXCLUDED entry gives a real reason, not a shrug');

  // WIRING. A tier table nobody invokes is documentation. These pins live HERE
  // and not in test-architecture §43 on purpose: §43 runs inside `npm run
  // build`, and several browser suites build a PARTIAL COPY of the tree
  // (test-window-menu copies src+public+server.js+scripts onto a HEAD
  // checkout), so a build-time assert that reads package.json or .github fails
  // there for reasons unrelated to the code under test — measured, that pin
  // turned test-window-menu into a 300 s timeout.
  const read = (f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf-8'); } catch { return ''; } };
  const hook = read('scripts/git-hooks/pre-push');
  const wf = read('.github/workflows/ci.yml');
  const pkg = read('package.json');
  ok(hook.includes('--check-heavy') && hook.includes('--heavy-launch'),
    'the tracked pre-push hook checks the heavy verdict AND launches the heavy tier');
  ok(hook.indexOf('--check-heavy') < hook.indexOf('node scripts/ci.mjs ||'),
    'the hook asks for the heavy verdict BEFORE it spends the fast tier');
  ok(/node scripts\/ci\.mjs\s*$/m.test(wf) && wf.includes('node scripts/ci.mjs --heavy'),
    'the Actions mirror runs BOTH tiers');
  ok(/"ci:heavy"\s*:/.test(pkg) && /"ci:status"\s*:/.test(pkg), 'package.json exposes ci:heavy + ci:status');
  // `npm run ci:heavy` is the command the block message tells a blocked
  // developer to run, so it has to be able to WRITE the marker that clears the
  // block. In place it can only do that on a clean tree; --isolate always can
  // (round 2: the manual path used to run 16 minutes and then refuse silently).
  ok(/"ci:heavy"\s*:\s*"[^"]*--isolate/.test(pkg), 'ci:heavy runs ISOLATED, so the recovery command always earns a marker');
  ok(read('.gitignore').includes('data/ci-heavy'), 'the marker directory is gitignored');
}

// ── §3 THE BLOCK RULE, OVER REAL COMMITS ─────────────────────────────────
console.log('\n§3 the block rule (real git history)');
{
  const repo = makeRepo('block');
  const A = commit(repo, 'src/a.js', '//a\n', 'A');
  const B = commit(repo, 'src/b.js', '//b\n', 'B');
  const C = commit(repo, 'src/c.js', '//c\n', 'C');
  git(repo, ['checkout', '-q', '-b', 'side', A]);
  const S = commit(repo, 'src/s.js', '//s\n', 'S on a side branch');
  git(repo, ['checkout', '-q', 'main']);
  const at = (head, ...markers) => {
    const dir = mktmp('markers');
    for (const [sha, res, failed, partial, flaky] of markers) writeMarker(dir, sha, res, failed || [], partial, flaky);
    return heavyBlocker({ dir, head, repoRoot: repo });
  };
  ok(at(C, [A, 'red', ['test-client-boot']])?.sha === A, 'a RED on an ancestor of HEAD blocks');
  ok(at(A, [A, 'red', ['test-client-boot']])?.sha === A, 'a RED on HEAD itself blocks');
  ok(at(C, [A, 'red'], [B, 'green']) === null, 'a GREEN on a later commit clears the earlier red');
  ok(at(C, [B, 'red'], [A, 'green']) === null || at(C, [B, 'red'], [A, 'green']).sha === B, 'an EARLIER green does not clear a later red');
  ok(at(C, [B, 'red'], [A, 'green'])?.sha === B, '…and the later red still blocks');
  ok(at(C, [S, 'red']) === null, 'a RED on a divergent branch does not block this history');
  ok(at(C, ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'red']) === null, 'a RED for a commit this repo does not know is ignored (amended/rebased away)');
  ok(at(C, [A, 'green'], [B, 'green']) === null, 'greens alone never block');
  // A `--only=` re-run proves one suite, not the tier. If a partial green
  // could clear a block, re-running the suite you just fixed would unlock a
  // commit the rest of the tier never saw.
  ok(at(C, [A, 'red', ['boom']], [B, 'green', [], ['test-attach-ack']])?.sha === A,
    'a PARTIAL green does not clear a red (it is not evidence the tier passed)');
  ok(at(C, [A, 'red', ['boom'], ['test-attach-ack']])?.sha === A, 'a PARTIAL red still blocks (a suite really did fail there)');
  // FLAKY is a full green with a note: a suite that failed and passed on the
  // retry did not fail the tier, so the marker clears the block; the note
  // rides along so nobody has to pretend it never failed.
  ok(at(C, [A, 'red', ['boom']], [B, 'green', [], undefined, ['test-desktop-drop']]) === null,
    'a green that records FLAKY suites still clears the block (it is a full run)');
  ok(at(C, [A, 'red', ['x']]).failed.join() === 'x', 'the blocker carries the failing suite names for the message');
  // The clearing green must be on OUR history too: a green on a side branch
  // that descends from nothing we are pushing must not unlock anything.
  const sideGreenRepo = mktmp('markers');
  writeMarker(sideGreenRepo, A, 'red', ['boom']);
  writeMarker(sideGreenRepo, S, 'green');
  ok(heavyBlocker({ dir: sideGreenRepo, head: C, repoRoot: repo })?.sha === A,
    'a green on a DIVERGENT descendant does not clear a red on this branch');
}

// ── §4 THE HOOK'S CONTROL FLOW, END TO END ───────────────────────────────
// The REAL tracked scripts/git-hooks/pre-push, driven with real pre-push
// stdin, in a throwaway repo whose scripts/ci.mjs is a RECORDING stub that
// delegates the verdict to the REAL heavyBlocker. What is under test is the
// hook's control flow — the order of its steps, what it refuses, what it
// launches — so the fast tier is the only thing stubbed.
console.log('\n§4 the pre-push hook, end to end');
{
  const repo = makeRepo('hook');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data', 'ci-heavy'), { recursive: true });
  const realCi = path.join(REPO, 'scripts', 'ci.mjs').replace(/\\/g, '/');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci.mjs'), `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
import { heavyBlocker } from ${JSON.stringify(realCi)};
const repo = ${JSON.stringify(repo)};
const dir = path.join(repo, 'data', 'ci-heavy');
const argv = process.argv.slice(2);
const note = (o) => fs.appendFileSync(path.join(repo, 'calls.ndjson'), JSON.stringify(o) + '\\n');
const headArg = (argv.find((a) => a.startsWith('--head=')) || '').slice(7) || null;
if (argv.includes('--check-heavy')) {
  note({ mode: 'check-heavy', head: headArg });
  const b = heavyBlocker({ dir, repoRoot: repo, head: headArg || undefined });
  if (b) { console.error('PUSH BLOCKED failed: ' + (b.failed || []).join(', ')); process.exit(1); }
  process.exit(0);
}
const li = argv.indexOf('--heavy-launch');
if (li >= 0) { note({ mode: 'heavy-launch', sha: argv[li + 1] }); process.exit(0); }
note({ mode: 'fast' });
process.exit(fs.existsSync(path.join(repo, 'FAST_RED')) ? 1 : 0);
`);
  fs.copyFileSync(path.join(REPO, 'scripts', 'git-hooks', 'pre-push'), path.join(repo, 'pre-push'));
  fs.chmodSync(path.join(repo, 'pre-push'), 0o755);
  const ZERO = '0'.repeat(40);
  const calls = () => { try { return fs.readFileSync(path.join(repo, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const runHookRefs = (stdin, env = {}) => {
    try { fs.unlinkSync(path.join(repo, 'calls.ndjson')); } catch {}
    const r = spawnSync('bash', [path.join(repo, 'pre-push'), 'origin', 'git@example.invalid:x/y.git'], {
      cwd: repo, input: stdin, encoding: 'utf-8', env: { ...GIT_ENV, ...env },
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), calls: calls() };
  };
  const runHook = (localSha, remoteSha = ZERO, env = {}) =>
    runHookRefs(`refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`, env);

  const A = commit(repo, 'src/a.js', '//a\n', 'A');
  const r1 = runHook(A);
  ok(r1.status === 0, 'fast tier green ⇒ the push proceeds');
  ok(r1.calls.map((c) => c.mode).join(',') === 'check-heavy,fast,heavy-launch',
    `the hook checks the heavy verdict FIRST, then runs fast, then launches heavy (got: ${r1.calls.map((c) => c.mode).join(',')})`);
  ok(r1.calls.find((c) => c.mode === 'heavy-launch')?.sha === A, 'the heavy run is launched for the sha being PUSHED');

  // …the background heavy run comes back RED for A.
  writeMarker(path.join(repo, 'data', 'ci-heavy'), A, 'red', ['test-client-boot', 'test-fold-ux']);
  const B = commit(repo, 'src/b.js', '//b\n', 'B (built on the red commit)');
  const r2 = runHook(B, A);
  ok(r2.status === 1, 'a RED heavy result on an ancestor BLOCKS the next push');
  ok(/test-client-boot/.test(r2.out) && /test-fold-ux/.test(r2.out), 'the refusal names the failing suites');
  ok(r2.calls.map((c) => c.mode).join(',') === 'check-heavy',
    'and it refuses BEFORE spending the fast tier (no fast run, no launch)');

  // …a green heavy run on the newer commit clears it.
  writeMarker(path.join(repo, 'data', 'ci-heavy'), B, 'green');
  const r3 = runHook(B, A);
  ok(r3.status === 0, 'a GREEN heavy run on a newer commit unblocks the push');
  ok(r3.calls.map((c) => c.mode).join(',') === 'check-heavy,fast,heavy-launch', 'and the full flow runs again');

  // A red fast tier must block AND must not launch anything.
  fs.writeFileSync(path.join(repo, 'FAST_RED'), '1');
  const C = commit(repo, 'src/c.js', '//c\n', 'C');
  writeMarker(path.join(repo, 'data', 'ci-heavy'), C, 'green'); // keep §4's older red cleared
  const r4 = runHook(C, B);
  ok(r4.status === 1, 'a RED fast tier blocks the push');
  ok(!r4.calls.some((c) => c.mode === 'heavy-launch'), 'a RED fast tier launches NO heavy run (nothing is being pushed)');
  fs.unlinkSync(path.join(repo, 'FAST_RED'));

  // The two documented escape hatches still behave.
  const D = commit(repo, 'docs/x.md', '# x\n', 'docs only');
  const r5 = runHook(D, C);
  ok(r5.status === 0 && !r5.calls.length, 'a docs-only push skips the gate entirely');
  const E = commit(repo, 'src/e.js', '//e\n', 'E');
  writeMarker(path.join(repo, 'data', 'ci-heavy'), E, 'red', ['boom']);
  const r6 = runHook(E, D, { VIBESPACE_SKIP_CI: '1' });
  ok(r6.status === 0 && !r6.calls.length, 'VIBESPACE_SKIP_CI=1 bypasses even a blocking red');

  // ── THE VERDICT IS ABOUT THE REFS BEING PUSHED (2026-09-07 round 2) ────
  // Reproduced before the fix: the hook asked `--check-heavy` with no --head,
  // so the answer was about the CHECKED-OUT commit. `git push origin main`
  // from a different branch therefore shipped a commit riding on a heavy-red
  // ancestor with no block and no message.
  // E's red belonged to the bypass leg above; leave it there and this leg is
  // asking about two reds at once.
  try { fs.unlinkSync(path.join(repo, 'data', 'ci-heavy', `${E}.red`)); } catch {}
  git(repo, ['checkout', '-q', '-b', 'shipping', E]);
  const R = commit(repo, 'src/r.js', '//r\n', 'R — the commit that will go red');
  const RIDER = commit(repo, 'src/rider.js', '//rider\n', 'RIDER — rides on the red, and is what we push');
  git(repo, ['checkout', '-q', '-b', 'elsewhere', E]);
  const SIDE = commit(repo, 'src/side.js', '//side\n', 'the branch we are STANDING on — unrelated to the red');
  writeMarker(path.join(repo, 'data', 'ci-heavy'), R, 'red', ['test-fold-ux']);
  // Non-vacuity, stated as the two answers the fix is choosing between.
  ok(heavyBlocker({ dir: path.join(repo, 'data', 'ci-heavy'), head: SIDE, repoRoot: repo }) === null,
    'the checked-out branch is NOT blocked (this is what the hook used to ask about)');
  ok(heavyBlocker({ dir: path.join(repo, 'data', 'ci-heavy'), head: RIDER, repoRoot: repo })?.sha === R,
    '…while the ref being pushed IS blocked (this is what it must ask about)');
  const r7 = runHookRefs(`refs/heads/shipping ${RIDER} refs/heads/shipping ${R}\n`);
  ok(r7.status === 1, 'pushing a ref whose tip is NOT HEAD is blocked by a red in THAT ref\'s history');
  ok(r7.calls.every((c) => c.mode !== 'fast'), '…and refused before the fast tier, like every other block');
  ok(r7.calls.some((c) => c.mode === 'check-heavy' && c.head === RIDER), `…because the hook asked about the pushed sha (${(r7.calls[0] || {}).head || 'HEAD'})`);
  // Every pushed ref is asked about, not just the first.
  git(repo, ['branch', '-f', 'clean-branch', SIDE]);
  const r8 = runHookRefs(`refs/heads/clean-branch ${SIDE} refs/heads/clean-branch ${ZERO}\nrefs/heads/shipping ${RIDER} refs/heads/shipping ${R}\n`);
  ok(r8.status === 1 && r8.calls.filter((c) => c.mode === 'check-heavy').length >= 2,
    'a multi-ref push asks about EVERY ref (a clean one first does not excuse the red one)');
}

// ── §5 THE GIT ENVIRONMENT THE DETACHED CHILD MUST NOT INHERIT ───────────
// A pre-push hook process exports GIT_DIR / GIT_INDEX_FILE / GIT_PREFIX, and
// the heavy tier's very first act is `git worktree add`. Inheriting them means
// creating a worktree of whatever repository the environment names. This is
// the same class as test-architecture §42 rounds 6-7 and shares its ONE list
// (scripts/git-env.mjs) — here it is proven on the operation the heavy gate
// actually performs, with the damage as the negative control.
console.log('\n§5 the detached child\'s git environment');
{
  const decoy = makeRepo('decoy');
  commit(decoy, 'x.txt', 'x\n', 'decoy');
  const stamp = (root) => {
    const out = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else { try { out.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); } catch { out.push(`${r}:?`); } }
      }
    })(path.join(root, '.git'), '');
    return out.join('\n');
  };
  const ours = makeRepo('ours');
  commit(ours, 'y.txt', 'y\n', 'ours');
  const hostile = {
    ...process.env,
    GIT_DIR: path.join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
  };
  const before = stamp(decoy);
  ok(GIT_REDIRECTORS.includes('GIT_DIR') && GIT_REDIRECTORS.includes('GIT_INDEX_FILE') && GIT_REDIRECTORS.length >= 25,
    `the shared sanitizer covers the hook's own exports (${GIT_REDIRECTORS.length} names)`);

  const wt1 = path.join(mktmp('wt'), 'guarded');
  const guarded = spawnSync('git', ['-C', ours, 'worktree', 'add', '--detach', wt1, 'HEAD'], { encoding: 'utf-8', env: gitEnvFrom(hostile) });
  ok(guarded.status === 0 && fs.existsSync(path.join(wt1, 'y.txt')),
    'with the sanitized environment, `git worktree add` checks out OUR repository');
  ok(stamp(decoy) === before, '…and the decoy repository is byte-identical afterwards');

  const wt2 = path.join(mktmp('wt'), 'raw');
  const raw = spawnSync('git', ['-C', ours, 'worktree', 'add', '--detach', wt2, 'HEAD'], { encoding: 'utf-8', env: hostile });
  const decoyTouched = stamp(decoy) !== before;
  ok(decoyTouched || raw.status !== 0,
    `NEGATIVE CONTROL: the SAME command with the hook's environment inherited does not do the same thing (decoy touched: ${decoyTouched}, exit ${raw.status})`);
  ok(!fs.existsSync(path.join(wt2, 'y.txt')),
    'NEGATIVE CONTROL: …and it certainly does not check out OUR commit (this is the damage the sanitizer prevents)');
  // Leave no worktree registrations behind in the throwaway repos.
  for (const [root, wt] of [[ours, wt1], [ours, wt2], [decoy, wt2]]) { try { spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', wt], { env: GIT_ENV }); } catch {} }
}

// ── §6 MACHINE-GLOBAL FIXTURES + "NO VERDICT" HONESTY (round 2) ──────────
// Two rules the round-2 findings turned into asserts.
//
// (a) A FAST-tier suite must not claim a name the whole BOX shares. The fast
//     tier is fail-fast, has no retry and blocks the push directly, so one
//     squatter from any of this machine's ~160 checkouts of this repo turns an
//     unrelated push red. Measured: with a bare listener on :3991,
//     test-attach-ack — which the fast tier reached through the launcher
//     self-test's slice — hung to its budget. The rule covers the slice that
//     test-ci-heavy-launch launches too: it is fast-tier cost by transitivity.
// (b) A run that writes no verdict must say so at the START (so nobody spends
//     sixteen minutes to be told) and must not print "HEAVY GATE GREEN" at the
//     end (a claim about a commit that nobody recorded).
console.log('\n§6 machine-global fixtures + no-verdict honesty');
{
  const srcOf = (n) => { try { return fs.readFileSync(path.join(REPO, 'scripts', n + '.mjs'), 'utf-8'); } catch { return ''; } };
  const fast = SUITES.filter((s) => s.tier === 'fast');
  const offenders = fast.map((s) => ({ s, f: machineGlobalFixtures(srcOf(s.name)) }))
    .filter(({ f }) => f.ports.length || f.paths.length);
  ok(!offenders.length, `no FAST-tier suite claims a fixed port or /tmp path (${offenders.map(({ s, f }) => `${s.name}: ${[...f.ports, ...f.paths].join(' ')}`).join('; ') || `${fast.length} suites clean`})`);

  const launcherSrc = srcOf('test-ci-heavy-launch');
  const slice = (/const SLICE = '([^']+)'/.exec(launcherSrc) || [])[1];
  ok(!!slice && SUITES.some((s) => s.name === slice && s.tier === 'heavy'), `the launcher self-test's slice is a heavy suite (${slice})`);
  const sliceF = machineGlobalFixtures(srcOf(slice));
  ok(!sliceF.ports.length && !sliceF.paths.length,
    `…and it claims nothing machine-global either — the FAST tier pays for it (${[...sliceF.ports, ...sliceF.paths].join(' ') || 'clean'})`);
  ok(/--lock=/.test(launcherSrc), '…and it drives its OWN machine lock, so it never queues behind a real heavy run');

  // THE MACHINE LOCK MUST NAME THE MACHINE. `os.tmpdir()` follows TMPDIR, so a
  // lock derived from it is per-PROCESS-environment: two agents with different
  // TMPDIRs would each take "the machine lock" and neither would wait, while
  // the things it protects (a bound port, the literal `/tmp` checkouts the
  // suites claim) do not move with TMPDIR at all.
  const beforeTmp = process.env.TMPDIR;
  const lockDefault = defaultLockPath();
  try {
    process.env.TMPDIR = path.join(mktmp('tmpdir'), 'elsewhere');
    ok(defaultLockPath() === lockDefault, `TMPDIR does not move the machine lock (${lockDefault})`);
  } finally { if (beforeTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = beforeTmp; }
  ok(/(^|\/)vibespace-ci-heavy-\d+\.lock$/.test(lockDefault) && os.tmpdir !== undefined,
    '…and it is per-uid, so two users never fight over one file neither can unlink');

  // NEGATIVE CONTROLS — the detector must fire on the exact shapes that caused
  // the incident and stay quiet on the ones that replaced them. They live in
  // scripts/fixtures/machine-global-shapes/ rather than inline because the
  // assert above scans every fast-tier suite's SOURCE and this file is one:
  // a verbatim `const PORT = 3991` control made the suite report ITSELF as an
  // offender (first run of this section — a control has to read as data).
  const shape = (n) => fs.readFileSync(path.join(REPO, 'scripts', 'fixtures', 'machine-global-shapes', n), 'utf-8');
  const flagged = machineGlobalFixtures(shape('flagged.js.txt'));
  ok(flagged.ports.includes(3991) && flagged.paths.includes('/tmp/vs-ack-smoke'),
    `NEG: the pre-fix test-attach-ack shape (fixed :3991 + a fixed /tmp worktree it force-removes) is detected (${flagged.paths.join(' ')})`);
  ok(flagged.ports.includes(18941) && flagged.ports.includes(18942),
    'NEG: a comma-declared fixed pair (the pre-fix test-proxy-post shape) is detected');
  ok(flagged.ports.includes(3993) && flagged.ports.includes(3989),
    'NEG: a literal bound through a NAME — listened on, or handed to a child as PORT — is detected too');
  const clean = machineGlobalFixtures(shape('clean.js.txt'));
  ok(!clean.ports.length && !clean.paths.length,
    `NEG: the replacement shapes (freePort, mkdtemp, per-pid paths) AND the two that must never be flagged (a /tmp fixture VALUE, a lowercase port: config field) are all quiet (${[...clean.ports, ...clean.paths].join(' ') || 'clean'})`);

  // "KILLED FROM OUTSIDE" MUST NOT LAUNDER A HANG. A heavy run refuses to
  // write a verdict when a child died on a signal it did not send — that is
  // how a superseded or Ctrl-C'd run stops stamping a RED built from its own
  // interruption. But a suite that HANGS is killed by our own budget, with the
  // same SIGTERM, and that one IS a red. spawnSync tells them apart by
  // reporting ETIMEDOUT for its own kill, and this is the whole distinction.
  ok(killedFromOutside({ signal: 'SIGTERM' }) === true, 'a child killed by SIGTERM with no error of ours reads as killed from OUTSIDE');
  ok(killedFromOutside({ signal: 'SIGKILL' }) === true, '…SIGKILL too');
  ok(killedFromOutside({ signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }) === false,
    'NEG: our OWN budget kill (ETIMEDOUT) does NOT — a hung suite is a red, never a "no verdict"');
  ok(killedFromOutside({ status: 1 }) === false && killedFromOutside({ status: 0 }) === false && killedFromOutside(null) === false,
    'NEG: an ordinary failure, an ordinary pass and a missing result are not signals');

  // (b) THE DIRTY-TREE PATH, FOR REAL. A probe file makes this checkout dirty
  //     for the length of two runs; `finally` removes it.
  // THIS LEG DIRTIES THE REPOSITORY, so it must clean up on SIGNALS too, not
  // only in `finally`. Learned the hard way in this very round: a killed
  // process does not run `finally` (or `process.on('exit')`), and ci.mjs's own
  // per-suite budget kill is a SIGTERM — a stray probe then leaves the tree
  // dirty, which blocks the fast tier's green marker AND makes the next
  // in-place `npm run ci:heavy` refuse. It also self-heals a stale one, because
  // the previous run may have been the one that was killed.
  const probe = path.join(REPO, '.ci-gate-dirty-probe');
  const rmProbe = () => { try { fs.unlinkSync(probe); } catch {} };
  rmProbe();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { rmProbe(); process.exit(143); });
  process.on('exit', rmProbe);
  const mdir = mktmp('dirty');
  try {
    fs.writeFileSync(probe, 'round-2 dirty-tree probe\n');
    const porcelain = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';
    ok(porcelain.includes('.ci-gate-dirty-probe'), 'the probe really makes this tree dirty (the two legs below are non-vacuous)');
    const t0 = Date.now();
    const refused = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy', '--markers=' + mdir, '--only=test-eml'],
      { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 120000 });
    const rout = (refused.stdout || '') + (refused.stderr || '');
    ok(refused.status === 2 && /REFUSED/.test(rout), `a dirty in-place heavy run is REFUSED (exit ${refused.status})`);
    ok(Date.now() - t0 < 15000, `…UP FRONT, before the build and the suites (${Date.now() - t0}ms — the whole point)`);
    ok(!/npm run build/.test(rout), '…so it does not spend a build first');
    ok(/--isolate|ci:heavy/.test(rout), '…and the refusal names the way to get a real verdict');
    ok(!fs.readdirSync(mdir).length, '…and writes no marker');

    // The dirty tree only has to exist until the run CAPTURES it (heavyGate
    // reads `git status` once, at t=0, and announces it on the next line), so
    // the probe is removed as soon as the child says it saw one. That keeps the
    // repository dirty for ~200 ms instead of for the whole run — the window in
    // which killing this suite would strand the probe, dirty the tree, and cost
    // the next push its green marker. Belt and braces with the self-heal above:
    // shrink the hazard, then clean up after it anyway.
    const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy', '--dirty-ok', '--markers=' + mdir, '--only=test-eml', '--lock=' + path.join(mdir, 'lock')],
      { cwd: REPO, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let aout = '';
    child.stdout.on('data', (d) => { aout += d; });
    child.stderr.on('data', (d) => { aout += d; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 600 && !/--dirty-ok: this tree is dirty/.test(aout); i++) await sleep(50);
    ok(/--dirty-ok: this tree is dirty/.test(aout), 'the run announces the dirty tree as soon as it captures it (so the probe can go)');
    rmProbe();
    const anyway = await new Promise((res) => child.on('exit', (code) => res({ status: code })));
    ok(/NO VERDICT will be written/i.test(aout), '--dirty-ok says NO VERDICT at the START of the run');
    ok(/NO VERDICT WRITTEN/.test(aout) && !/HEAVY GATE GREEN/.test(aout),
      '…and the closing line says NO VERDICT WRITTEN instead of "HEAVY GATE GREEN"');
    ok(!fs.existsSync(path.join(mdir, 'x')) && !fs.readdirSync(mdir).some((f) => /\.(green|red)$/.test(f)),
      '…and still writes no green/red marker');
  } finally { try { fs.unlinkSync(probe); } catch {} }

  // The block message must point at something REACHABLE. It used to offer "or
  // wait for the next push's background run" — but that run is launched BY a
  // push, and the push is what is being refused.
  // The red has to name a commit THIS repository knows (a marker for an
  // unknown sha is ignored on purpose), so it is HEAD — with the markers in a
  // temp dir, so no real push is ever blocked by this assert.
  const bdir = mktmp('blockmsg');
  const bA = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '').trim();
  writeMarker(bdir, bA, 'red', ['test-client-boot']);
  const blocked = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--check-heavy', '--markers=' + bdir, '--head=' + bA],
    { cwd: REPO, encoding: 'utf-8', env: GIT_ENV });
  const bout = (blocked.stdout || '') + (blocked.stderr || '');
  ok(blocked.status === 1 && /PUSH BLOCKED/.test(bout), 'the block message is produced by a real red marker');
  ok(/npm run ci:heavy/.test(bout), '…and names npm run ci:heavy');
  ok(!/wait for the next push/.test(bout), '…and no longer offers the unreachable "wait for the next push\'s background run"');
}
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
