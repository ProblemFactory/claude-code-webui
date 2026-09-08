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
import { SUITES, EXCLUDED, censusFindings, listSuiteFiles, heavyBlocker, machineGlobalFixtures, defaultLockPath, killedFromOutside, OUTSIDE_SIGNALS } from './ci.mjs';
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
// `date` (optional) pins the COMMITTER date: the round-6 leg asserts which of
// several pushed shas is the newest, and commits made in the same second would
// make that a coin toss wearing a rule's clothes.
function commit(repo, file, body, msg, date) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), body);
  git(repo, ['add', '-f', file]);
  git(repo, ['commit', '-q', '-m', msg], date ? { ...GIT_ENV, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : GIT_ENV);
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
note({ mode: 'fast', isolate: argv.includes('--isolate'), sha: (argv.find((a) => a.startsWith('--sha=')) || '').slice(6) || null });
process.exit(fs.existsSync(path.join(repo, 'FAST_RED')) ? 1 : 0);
`);
  fs.copyFileSync(path.join(REPO, 'scripts', 'git-hooks', 'pre-push'), path.join(repo, 'pre-push'));
  fs.chmodSync(path.join(repo, 'pre-push'), 0o755);
  const ZERO = '0'.repeat(40);
  const calls = () => { try { return fs.readFileSync(path.join(repo, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // `hook` is a parameter so a PRE-FIX COPY of the real hook can be driven
  // through the exact same fixture: every round-4 leg below states the answer
  // the shipped hook gives AND the answer the defect gave, or it proves nothing.
  const runHookRefs = (stdin, env = {}, hook = path.join(repo, 'pre-push')) => {
    try { fs.unlinkSync(path.join(repo, 'calls.ndjson')); } catch {}
    const r = spawnSync('bash', [hook, 'origin', 'git@example.invalid:x/y.git'], {
      cwd: repo, input: stdin, encoding: 'utf-8', env: { ...GIT_ENV, ...env },
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), calls: calls() };
  };
  // A copy of the REAL hook with one guard reverted to the shape that caused
  // the finding. An anchor that no longer matches is a RED assert (not a
  // throw): a control that quietly becomes "the same hook twice" proves
  // nothing, and the suite still has to report the behavioural asserts around
  // it — that is what the mutation battery reads.
  const hookSrc = fs.readFileSync(path.join(REPO, 'scripts', 'git-hooks', 'pre-push'), 'utf-8');
  const preFixHook = (tag, ...edits) => {
    let patched = hookSrc;
    for (const [from, to] of edits) {
      const next = patched.replace(from, to);
      if (next === patched) {
        ok(false, `pre-fix control "${tag}": the anchor ${JSON.stringify(String(from).slice(0, 50))} is not in the shipped hook — the control would be a second copy of it, so its NEG leg proves nothing`);
        return null;
      }
      patched = next;
    }
    const p = path.join(repo, `pre-push.prefix-${tag}`);
    fs.writeFileSync(p, patched); fs.chmodSync(p, 0o755);
    return p;
  };
  // The docs-only block, verbatim, so the "it used to exit before asking"
  // control can put it back where it was instead of approximating it.
  const DOCS_ONLY_BLOCK = 'if [ "$only_docs" = "1" ] && [ "${#REFS[@]}" -gt 0 ]; then\n  echo "[ci] docs-only push — fast tier skipped" >&2\n  exit 0\nfi\n';
  const HEAVY_FIRST_ANCHOR = '# ── HEAVY-TIER VERDICT FIRST (2026-09-07) ─';
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
  ok(r5.status === 0 && !r5.calls.some((c) => c.mode === 'fast') && !r5.calls.some((c) => c.mode === 'heavy-launch'),
    'a docs-only push skips the fast tier (and launches nothing new to test)');
  ok(r5.calls.some((c) => c.mode === 'check-heavy' && c.head === D),
    '…but the heavy VERDICT is still asked about it (round 4: a red ancestor is red whether or not this push carries code)');
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

  // ── ROUND 4 (a): A DOCS-ONLY PUSH IS STILL SUBJECT TO A RED ANCESTOR ───
  // The docs-only skip used to be the hook's FIRST decision, so a red heavy
  // verdict on an ancestor was never even asked about. The block exists to
  // stop more work being stacked on a known-broken commit, and a docs commit
  // is more work.
  {
    git(repo, ['checkout', '-q', '-b', 'docsred', SIDE]);
    const DR = commit(repo, 'src/dr.js', '//code that will go red\n', 'DR');
    const DRDOCS = commit(repo, 'docs/dr.md', '# notes\n', 'docs on top of the red commit');
    writeMarker(path.join(repo, 'data', 'ci-heavy'), DR, 'red', ['test-fold-ux']);
    const r9 = runHookRefs(`refs/heads/docsred ${DRDOCS} refs/heads/docsred ${DR}\n`);
    ok(r9.status === 1 && /PUSH BLOCKED/.test(r9.out),
      'a DOCS-ONLY push riding on a heavy-red ancestor is blocked (the verdict is asked before the docs-only exit)');
    ok(!r9.calls.some((c) => c.mode === 'fast'), '…and still without spending the fast tier');
    // The control is the hook with the docs-only exit MOVED BACK above the
    // verdict — the literal pre-round-4 file, not an approximation of it.
    const preSkip = preFixHook('docsfirst',
      [DOCS_ONLY_BLOCK, ''],
      [HEAVY_FIRST_ANCHOR, DOCS_ONLY_BLOCK + '\n' + HEAVY_FIRST_ANCHOR]);
    if (preSkip) {
      const r9n = runHookRefs(`refs/heads/docsred ${DRDOCS} refs/heads/docsred ${DR}\n`, {}, preSkip);
      ok(r9n.status === 0 && !r9n.calls.length,
        'NEG: a hook that exits on docs-only BEFORE asking ships the same commit on top of the same red, silently');
    }
    try { fs.unlinkSync(path.join(repo, 'data', 'ci-heavy', `${DR}.red`)); } catch {}
  }

  // ── ROUND 4 (b): A NEW BRANCH PUBLISHES ITS WHOLE RANGE ────────────────
  // `remote_sha` is zeros for a new branch and the hook inspected only the TIP
  // commit, so [code commit][docs commit] pushed as a new branch printed
  // "docs-only push — gate skipped" with ZERO gate calls. This branch's own
  // history has that shape.
  {
    // A remote-tracking ref, so "the range being published" is really the two
    // new commits and not the whole history — otherwise this leg would pass
    // for the wrong reason (any repo without remotes lists everything).
    git(repo, ['update-ref', 'refs/remotes/origin/main', SIDE]);
    git(repo, ['checkout', '-q', '-b', 'newbranch', SIDE]);
    commit(repo, 'src/nb.js', '//code — the commit the tip-only look could not see\n', 'NB code');
    const NBTIP = commit(repo, 'docs/nb.md', '# docs\n', 'NB docs (the tip)');
    const published = git(repo, ['log', '--name-only', '--format=', NBTIP, '--not', '--remotes']).split('\n').filter(Boolean).sort();
    ok(published.join(',') === 'docs/nb.md,src/nb.js',
      `the published range is exactly the two new commits' paths (${published.join(', ') || 'EMPTY'}) — not the whole history, and not just the tip`);
    const refs = `refs/heads/newbranch ${NBTIP} refs/heads/newbranch ${ZERO}\n`;
    const r10 = runHookRefs(refs);
    ok(r10.calls.some((c) => c.mode === 'fast'),
      'a NEW BRANCH whose TIP is docs but whose RANGE carries code runs the fast tier');
    ok(r10.status === 0 && r10.calls.some((c) => c.mode === 'heavy-launch'), '…and its heavy run is launched');
    const preTip = preFixHook('tiponly',
      ['range_cmd=(git log --name-only --format= "$local_sha" --not --remotes)',
        'range_cmd=(git show --name-only --format= "$local_sha")']);
    if (preTip) {
      const r10n = runHookRefs(refs, {}, preTip);
      ok(!r10n.calls.some((c) => c.mode === 'fast') && /docs-only/.test(r10n.out),
        'NEG: the tip-only approximation calls exactly that push docs-only and runs nothing');
    }

    // ── ROUND 4 (c): "WE COULD NOT TELL" IS NOT "NOTHING CHANGED" ────────
    // An unresolvable range (a remote sha this checkout never fetched) makes
    // git exit non-zero with an EMPTY list, which the pre-fix hook read as
    // "no code path changed".
    const UNFETCHED = 'f'.repeat(39) + '1';
    const badRefs = `refs/heads/newbranch ${NBTIP} refs/heads/newbranch ${UNFETCHED}\n`;
    ok(spawnSync('git', ['-C', repo, 'diff', '--name-only', `${UNFETCHED}..${NBTIP}`], { encoding: 'utf-8', env: GIT_ENV }).status !== 0,
      'the unfetched-remote-sha range really does fail (the leg below is non-vacuous)');
    const r11 = runHookRefs(badRefs);
    ok(r11.calls.some((c) => c.mode === 'fast'), 'a range git CANNOT read is never treated as docs-only');
    ok(/could not list the paths/.test(r11.out), '…and it says so out loud (§no-silent-failures), naming the command and git\'s own message');
    const preQuiet = preFixHook('quietfail', ['  if [ "$rc" != "0" ]; then', '  if false; then']);
    if (preQuiet) {
      const r11n = runHookRefs(badRefs, {}, preQuiet);
      ok(!r11n.calls.some((c) => c.mode === 'fast') && /docs-only/.test(r11n.out),
        'NEG: without the exit-status check the same push is "docs-only", silently');
    }
  }

  // ── ROUND 4 (d): THE .git/ci-green SHORTCUT IS ABOUT THE PUSHED REFS ───
  // Keyed to HEAD alone, `git push origin <other-branch>` skipped the WHOLE
  // fast tier for a never-gated commit — and said "fast gate already GREEN on
  // this exact tree" while doing it. Today NO test drives the marker branch at
  // all, which is how it survived round 2 (which fixed exactly this defect for
  // `--check-heavy --head`).
  {
    // The shortcut also requires a CLEAN tree, so git is told to ignore the
    // files this fixture itself writes into the throwaway checkout.
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'),
      ['calls.ndjson', 'FAST_RED', 'scripts/', 'data/', 'pre-push', 'pre-push.prefix-*', ''].join('\n'));
    git(repo, ['checkout', '-q', '-b', 'marked', SIDE]);
    const G = commit(repo, 'src/g.js', '//gated\n', 'G — the commit the green marker names');
    git(repo, ['checkout', '-q', '-b', 'ungated', G]);
    const F = commit(repo, 'src/broken.js', '//never gated by anything\n', 'F — pushed from another branch');
    git(repo, ['checkout', '-q', 'marked']);
    ok(git(repo, ['status', '--porcelain']) === '' && git(repo, ['rev-parse', 'HEAD']) === G,
      'the fixture is in the shape the shortcut needs: clean tree, HEAD = the marker\'s sha');
    fs.writeFileSync(path.join(repo, '.git', 'ci-green'), `${G} ${Date.now()}\n`);

    const r12 = runHookRefs(`refs/heads/marked ${G} refs/heads/marked ${SIDE}\n`);
    ok(r12.status === 0 && /already GREEN/.test(r12.out) && !r12.calls.some((c) => c.mode === 'fast'),
      'a fresh green marker naming EVERY pushed sha skips the in-hook fast run (the marker branch, exercised at last)');
    ok(r12.calls.some((c) => c.mode === 'heavy-launch'), '…and the heavy tier is still launched for it');

    const otherRefs = `refs/heads/ungated ${F} refs/heads/ungated ${ZERO}\n`;
    const r13 = runHookRefs(otherRefs);
    ok(r13.calls.some((c) => c.mode === 'fast'),
      'NEG-by-behaviour: pushing a DIFFERENT branch\'s tip runs the fast tier — the marker says nothing about that commit');
    ok(!/already GREEN/.test(r13.out), '…and never claims the tree it did not gate is already green');
    const preHeadOnly = preFixHook('markerhead', [' && [ "$pushed_all_marked" = "1" ]', '']);
    if (preHeadOnly) {
      const r13n = runHookRefs(otherRefs, {}, preHeadOnly);
      ok(!r13n.calls.some((c) => c.mode === 'fast') && /already GREEN/.test(r13n.out),
        'NEG: keyed to HEAD alone, the same push skips the whole fast tier for a never-gated commit');
    }

    // A marker for a commit nobody is pushing must not unlock anything either.
    fs.writeFileSync(path.join(repo, '.git', 'ci-green'), `${F} ${Date.now()}\n`);
    const r14 = runHookRefs(`refs/heads/marked ${G} refs/heads/marked ${SIDE}\n`);
    ok(r14.calls.some((c) => c.mode === 'fast'), '…and a marker naming some OTHER commit does not skip this push either');
    try { fs.unlinkSync(path.join(repo, '.git', 'ci-green')); } catch {}
  }

  // ── ROUND 5 (a): A .md PATH THE GATE READS IS A CODE PATH ─────────────
  // The docs-only classifier said "not code" for `docs/*|*.md`, which is a
  // statement about how a path LOOKS. Several such paths are GATE INPUTS, so
  // a "docs-only" push shipped a tree the gate would have refused — and THIS
  // BRANCH'S OWN TIP (docs/kb-file-structure.md alone) is that shape.
  // The list in the hook is not trusted: it is DERIVED here from the tier
  // table's own suite sources plus src/agent-routes.js's AGENT_DOC_TOPICS, and
  // classified by running the hook's OWN `is_code_path` — no re-spelling of
  // the pattern, so drift in either direction is caught.
  {
    const scratch = mktmp('classify');
    /** The `name() { … }` function, verbatim, out of the tracked hook. */
    const hookFn = (name, src) => {
      const start = src.indexOf(`${name}() {`);
      if (start < 0) return null;
      const end = src.indexOf('\n}\n', start);
      return end < 0 ? null : src.slice(start, end + 2);
    };
    /** Run a bash classifier over paths → ['CODE'|'DOCS', …]. */
    const classifyWith = (fnSrc, paths) => {
      const f = path.join(scratch, 'classify-' + crypto.randomBytes(4).toString('hex') + '.sh');
      fs.writeFileSync(f, `${fnSrc}\nfor p in "$@"; do if is_code_path "$p"; then echo CODE; else echo DOCS; fi; done\n`);
      const r = spawnSync('bash', [f, ...paths], { encoding: 'utf-8' });
      return (r.stdout || '').trim().split('\n').filter(Boolean);
    };
    // THE DERIVATION. Every gated suite's source is scanned for repo-relative
    // `docs/…` / `*.md` literals. The literal must be the WHOLE string (a
    // `${x}:` / `${x}/` prefix allowed — the version pin reads
    // `${REF}:CHANGELOG.md`), because a path that merely appears INSIDE a
    // sentence or a fixture VALUE is not a path this repo reads: '/w/README.md'
    // and 'please read README.md and fix the typo' are fixture data in
    // test-image-cards / test-opencode-serve, and pulling the root README.md
    // into the code set would kill the escape hatch entirely (measured: the
    // loose version derived it, the anchored one does not). A bare name with
    // no directory component additionally has to sit on a line that reads
    // something — that is what separates `read('CLAUDE.md')` from
    // `readCall.title === 'README.md'`.
    // BOTH TIERS, on purpose: a docs-only push exits before the heavy LAUNCH
    // too, so a heavy suite's doc input is exactly as unguarded.
    const LIT = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    const WHOLE = /^(?:\$\{[^}]*\}[:/])?((?:docs\/[A-Za-z0-9._/-]+)|(?:[A-Za-z0-9][A-Za-z0-9._-]*\.md))$/;
    const READ_CTX = /readFileSync|readdirSync|createReadStream|copyFileSync|cpSync|existsSync|statSync|path\.join|\bread\s*\(|\bgit\s*\(/;
    const gateInputs = new Map();   // repo-relative path → suites that read it
    const noteInput = (p, who) => { if (!gateInputs.has(p)) gateInputs.set(p, new Set()); gateInputs.get(p).add(who); };
    const docLiterals = (src) => {
      const out = [];
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'));
      for (const line of code) {
        for (const m of line.matchAll(LIT)) {
          const w = WHOLE.exec(m[2]);
          if (!w) continue;
          if (!fs.existsSync(path.join(REPO, w[1]))) continue;
          out.push({ p: w[1], line, reads: READ_CTX.test(line) });
        }
      }
      return out;
    };
    // THIS suite is the one file that TALKS about doc paths without reading
    // them — its own controls below hand `docs/getting-started.md` and friends
    // to the classifier, and scanning itself made the derivation demand that
    // the hook call them code, which would have emptied the escape hatch.
    // The exclusion is MEASURED, not assumed: if test-ci-gate ever really
    // reads a doc, the assert right here says so.
    const selfReads = docLiterals(fs.readFileSync(path.join(REPO, 'scripts', 'test-ci-gate.mjs'), 'utf-8')).filter((h) => h.reads);
    ok(!selfReads.length, `test-ci-gate itself reads no documentation, so excluding it from the scan is a measurement${selfReads.length ? ' — it reads ' + selfReads.map((h) => h.p).join(', ') : ''}`);
    // THE SCAN SET IS "EVERY SCRIPT THE GATE RUNS", and the FAST tier is
    // `build + suites` — so the scripts `npm run build` chains are gate inputs
    // exactly like a suite is, even though they are in ci.mjs's EXCLUDED list
    // (`chained by npm run build`) and therefore not in SUITES. They read no
    // documentation TODAY (measured: 0 of the five), which is a fact that can
    // change with one commit, and the derivation is the thing that would
    // notice.
    const buildCmd = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).scripts.build || '';
    const buildScripts = [...new Set([...String(buildCmd).matchAll(/scripts\/([A-Za-z0-9._-]+)\.mjs/g)].map((m) => m[1]))];
    ok(buildScripts.length >= 4 && buildScripts.includes('test-architecture'),
      `\`npm run build\`'s own chained scripts are in the scan set (${buildScripts.length}: ${buildScripts.join(', ')}) — the fast tier is build + suites`);
    for (const name of [...SUITES.map((s) => s.name), ...buildScripts]) {
      if (name === 'test-ci-gate') continue;
      let src; try { src = fs.readFileSync(path.join(REPO, 'scripts', name + '.mjs'), 'utf-8'); } catch { continue; }
      for (const h of docLiterals(src)) {
        if (!h.p.includes('/') && !h.reads) continue;
        noteInput(h.p, name);
      }
    }
    // …plus the agent manuals, which are RUNTIME PRODUCT DATA: src/agent-routes.js
    // serves them from the running checkout (`GET /api/agent/docs/:topic`).
    const routes = fs.readFileSync(path.join(REPO, 'src', 'agent-routes.js'), 'utf-8');
    const topics = /const AGENT_DOC_TOPICS = \{([^}]*)\}/.exec(routes);
    const manuals = topics ? [...topics[1].matchAll(/'([^']+\.md)'/g)].map((m) => 'docs/agent/' + m[1]) : [];
    for (const p of manuals) if (fs.existsSync(path.join(REPO, p))) noteInput(p, 'src/agent-routes.js AGENT_DOC_TOPICS');
    ok(manuals.length >= 5 && manuals.includes('docs/agent/msg-manual.md'),
      `AGENT_DOC_TOPICS parsed out of src/agent-routes.js (${manuals.length} manuals — the parse is non-vacuous)`);

    const derived = [...gateInputs.keys()].sort();
    console.log(`     derived gate inputs (${derived.length}): ${derived.join(' ')}`);
    // NON-VACUITY: the derivation really did find the paths the incident named,
    // attributed to the suites that read them. A derivation that quietly stops
    // finding anything would make every assert below pass.
    const namedBy = (p, suite) => gateInputs.has(p) && gateInputs.get(p).has(suite);
    ok(namedBy('docs/kb-file-structure.md', 'test-codex-effort-meta')
      && namedBy('CLAUDE.md', 'test-opencode-serve')
      && namedBy('CHANGELOG.md', 'test-codex-effort-meta')
      && namedBy('docs/examples/hello-plugin', 'test-plugin-loader')
      && namedBy('docs/agent/msg-manual.md', 'test-agent-msg'),
      'the derivation finds the incident\'s own paths, attributed to the suites that read them');
    ok(!gateInputs.has('README.md'),
      'and it does NOT drag in the root README.md (a fixture VALUE in test-image-cards / test-opencode-serve, not a path they read) — the escape hatch has to keep meaning something');

    const shipped = hookFn('is_code_path', hookSrc);
    ok(!!shipped, 'the tracked hook defines is_code_path (the classifier is extractable, so this leg runs the hook\'s OWN pattern)');
    if (shipped) {
      const verdicts = classifyWith(shipped, derived);
      const stillDocs = derived.filter((p, i) => verdicts[i] !== 'CODE');
      ok(verdicts.length === derived.length && !stillDocs.length,
        `every derived gate input is a CODE path to the shipped hook (${derived.length} paths)${stillDocs.length ? ' — STILL DOCS: ' + stillDocs.join(', ') + ' (add it to is_code_path)' : ''}`);
      // …and ordinary documentation still skips, or the escape hatch is gone.
      const docs = ['README.md', 'docs/getting-started.md', 'docs/terminal.md', 'docs/screenshots/overview.png', 'docs/window-manager.md'];
      const dv = classifyWith(shipped, docs);
      ok(dv.every((v) => v === 'DOCS'), `real documentation is still documentation (${docs.join(', ')})`);
      ok(classifyWith(shipped, ['src/a.js', 'server.js', 'package.json']).every((v) => v === 'CODE'), 'and code is still code');
      // NEGATIVE CONTROL — the pre-round-5 classifier, verbatim: every one of
      // those gate inputs was documentation to it, which is the defect.
      const preFix = 'is_code_path() {\n  case "$1" in\n    docs/*|*.md) return 1 ;;\n  esac\n  return 0\n}\n';
      const pv = classifyWith(preFix, derived);
      const missed = derived.filter((p, i) => pv[i] !== 'CODE');
      ok(missed.length === derived.length,
        `NEG: the pre-round-5 pattern called ALL ${derived.length} of them documentation (so a push touching only one skipped both tiers)`);
    }
  }

  // ── ROUND 5 (b): A GATE-INPUT DOC PUSH RUNS THE TIER, END TO END ──────
  {
    git(repo, ['checkout', '-q', '-b', 'docsinput', SIDE]);
    const BASE5 = commit(repo, 'src/base5.js', '//base\n', 'the commit the docs legs below sit on');
    const KB = commit(repo, 'docs/kb-file-structure.md', '# kb\n', 'kb only — this branch\'s own tip shape');
    const rKB = runHookRefs(`refs/heads/docsinput ${KB} refs/heads/docsinput ${BASE5}\n`);
    ok(rKB.calls.some((c) => c.mode === 'fast'),
      'a push touching ONLY docs/kb-file-structure.md runs the FAST tier (it is source-pinned by test-codex-effort-meta)');
    ok(rKB.calls.some((c) => c.mode === 'heavy-launch'), '…and its heavy run is launched too');
    const MAN = commit(repo, 'docs/agent/msg-manual.md', '# manual\n', 'an agent manual — runtime product data');
    ok(runHookRefs(`refs/heads/docsinput ${MAN} refs/heads/docsinput ${KB}\n`).calls.some((c) => c.mode === 'fast'),
      'a push touching ONLY docs/agent/msg-manual.md runs the FAST tier (the server serves that file)');
    const EX = commit(repo, 'docs/examples/hello-plugin/vibespace-plugin.json', '{}\n', 'the shipped example plugin');
    ok(runHookRefs(`refs/heads/docsinput ${EX} refs/heads/docsinput ${MAN}\n`).calls.some((c) => c.mode === 'fast'),
      'a push touching ONLY docs/examples/hello-plugin/** runs the FAST tier (three plugin suites cpSync it)');
    // …and a REAL docs-only push still skips, or the escape hatch is gone.
    const RM = commit(repo, 'README.md', '# readme\n', 'genuinely docs-only');
    const rRM = runHookRefs(`refs/heads/docsinput ${RM} refs/heads/docsinput ${EX}\n`);
    ok(rRM.status === 0 && !rRM.calls.some((c) => c.mode === 'fast') && /docs-only/.test(rRM.out),
      'a genuinely docs-only push (README.md) still skips the fast tier');
    const preDocs = preFixHook('gateinputs',
      ['    CLAUDE.md|CHANGELOG.md|docs/kb-*.md|docs/design-*.md|docs/agent/*|docs/examples/*) return 0 ;;\n', ''],
      ['    docs/README.md|docs/plugins.md|docs/settings.md|docs/keyboard-shortcuts.md) return 0 ;;\n', '']);
    if (preDocs) {
      const n = runHookRefs(`refs/heads/docsinput ${KB} refs/heads/docsinput ${BASE5}\n`, {}, preDocs);
      ok(!n.calls.some((c) => c.mode === 'fast') && /docs-only/.test(n.out),
        'NEG: without the gate-input arm the same kb-only push skips BOTH tiers (the shape this branch\'s own tip has)');
    }
  }

  // ── ROUND 5 (c): THE FAST TIER GATES THE COMMIT BEING PUSHED ──────────
  // Invariant ⑭ in the last place it had not reached. Round 2 fixed the heavy
  // VERDICT and round 4 the marker SHORTCUT; the fast RUN still executed in
  // the working tree. Reproduced: standing on `marked`, pushing `ungated`
  // (tip F adds src/broken.js) ⇒ the tier ran in a tree without that file and
  // said ALL GREEN. r13 above proved a fast run HAPPENED — never its SUBJECT.
  {
    git(repo, ['checkout', '-q', '-b', 'elsewhere5', SIDE]);
    const STANDING = commit(repo, 'src/standing.js', '//the tree we have checked out\n', 'STANDING — where the developer is');
    git(repo, ['checkout', '-q', '-b', 'ungated5', SIDE]);
    const UNGATED = commit(repo, 'src/broken5.js', '//never gated by anything\n', 'UNGATED — the tip being pushed');
    git(repo, ['checkout', '-q', 'elsewhere5']);
    ok(git(repo, ['rev-parse', 'HEAD']) === STANDING && !fs.existsSync(path.join(repo, 'src', 'broken5.js')),
      'the fixture is the incident\'s shape: HEAD is STANDING and the working tree does NOT contain the pushed commit\'s file');
    const rIso = runHookRefs(`refs/heads/ungated5 ${UNGATED} refs/heads/ungated5 ${ZERO}\n`);
    const fastCall = rIso.calls.find((c) => c.mode === 'fast');
    ok(!!fastCall && fastCall.isolate === true && fastCall.sha === UNGATED,
      `pushing a ref whose tip is NOT HEAD gates THAT COMMIT (--isolate --sha=${UNGATED.slice(0, 8)}), not the tree you have checked out`);
    ok(/is NOT the commit you have checked out/.test(rIso.out), '…and says so, naming the ref and the sha (§no-silent-failures)');
    // The ordinary push is untouched — this must not cost every push a worktree.
    const rPlain = runHookRefs(`refs/heads/elsewhere5 ${STANDING} refs/heads/elsewhere5 ${SIDE}\n`);
    const plainCall = rPlain.calls.find((c) => c.mode === 'fast');
    ok(!!plainCall && !plainCall.isolate,
      'the ordinary push (every pushed sha IS HEAD) still runs in place — the ≤2 min budget is untouched');
    // Two refs at the SAME sha are one run, not two.
    git(repo, ['branch', '-f', 'twin5', UNGATED]);
    const rTwin = runHookRefs(`refs/heads/ungated5 ${UNGATED} refs/heads/ungated5 ${ZERO}\nrefs/heads/twin5 ${UNGATED} refs/heads/twin5 ${ZERO}\n`);
    ok(rTwin.calls.filter((c) => c.mode === 'fast').length === 1, 'two refs pointing at ONE commit run the fast tier once');
    const preSubject = preFixHook('fastsubject', ['    if [ "$sha" = "$head_sha" ]; then', '    if true; then']);
    if (preSubject) {
      const n = runHookRefs(`refs/heads/ungated5 ${UNGATED} refs/heads/ungated5 ${ZERO}\n`, {}, preSubject);
      const nf = n.calls.find((c) => c.mode === 'fast');
      ok(!!nf && !nf.isolate && !nf.sha,
        'NEG: before the fix the same push ran the tier against the WORKING TREE and said ALL GREEN about it');
    }
  }

  // ── ROUND 6: ONE FAST SUBJECT PER PUSH ────────────────────────────────
  // Round 5 made the fast run a LOOP over the distinct pushed shas, so the
  // ≤2 min budget — and the real billed haiku turn inside it — was multiplied
  // by the number of refs, inside the live SSH session. Reproduced with this
  // fixture before the fix: a three-ref push ⇒ THREE fast runs. `git push
  // --all` in this repository is 315 branches and `git push --tags` is 41.
  // The other refs are not ungated: `--heavy-launch` still runs for every
  // pushed sha, which is the tier that gives a multi-ref push its per-commit
  // coverage — and the hook SAYS which commits the fast tier did not look at.
  {
    git(repo, ['checkout', '-q', '-b', 'multi6', SIDE]);
    const M_HEAD = commit(repo, 'src/m-head.js', '//head\n', 'M_HEAD — the commit we are standing on');
    git(repo, ['checkout', '-q', '-b', 'multi6b', SIDE]);
    // Explicit committer dates: the subject for a push that does NOT include
    // HEAD is the NEWEST of the pushed shas, and `git rev-list --no-walk` sorts
    // by COMMITTER date — two commits made in the same second would make that
    // assert a coin toss dressed up as a rule.
    const M_OLD = commit(repo, 'src/m-old.js', '//old\n', 'M_OLD — older by committer date', '2026-01-01T00:00:00 +0000');
    git(repo, ['checkout', '-q', '-b', 'multi6c', SIDE]);
    const M_NEW = commit(repo, 'src/m-new.js', '//new\n', 'M_NEW — newer by committer date', '2026-06-01T00:00:00 +0000');
    git(repo, ['checkout', '-q', 'multi6']);
    const threeRefs = `refs/heads/multi6 ${M_HEAD} refs/heads/multi6 ${ZERO}\nrefs/heads/multi6b ${M_OLD} refs/heads/multi6b ${ZERO}\nrefs/heads/multi6c ${M_NEW} refs/heads/multi6c ${ZERO}\n`;
    ok(git(repo, ['rev-parse', 'HEAD']) === M_HEAD, 'the fixture stands on M_HEAD, and the push carries three distinct commits');
    const rMulti = runHookRefs(threeRefs);
    const fastCalls = rMulti.calls.filter((c) => c.mode === 'fast');
    ok(fastCalls.length === 1, `a three-ref push runs the fast tier ONCE (got ${fastCalls.length}) — not three builds, three tiers and three billed chat turns inside the SSH session`);
    ok(fastCalls.length === 1 && !fastCalls[0].isolate,
      '…in place, because HEAD is one of the pushed shas (the ordinary push is unchanged: same cost as a single-ref push)');
    ok(rMulti.calls.filter((c) => c.mode === 'heavy-launch').length === 3,
      '…while the HEAVY tier is still launched for EVERY pushed sha (that is where the other refs are covered)');
    ok(/publishes 2 other commit\(s\)/.test(rMulti.out) && rMulti.out.includes(M_OLD.slice(0, 8)) && rMulti.out.includes(M_NEW.slice(0, 8)),
      '…and the hook NAMES the commits the fast tier did not look at (a silent one-of-three would read as "all of them were gated")');
    ok(rMulti.status === 0, 'and the push proceeds');

    // HEAD not being pushed at all: still ONE run, isolated, at the NEWEST.
    git(repo, ['checkout', '-q', 'elsewhere5']);
    const rMultiAway = runHookRefs(`refs/heads/multi6b ${M_OLD} refs/heads/multi6b ${ZERO}\nrefs/heads/multi6c ${M_NEW} refs/heads/multi6c ${ZERO}\n`);
    const awayFast = rMultiAway.calls.filter((c) => c.mode === 'fast');
    ok(awayFast.length === 1 && awayFast[0].isolate === true && awayFast[0].sha === M_NEW,
      `a multi-ref push with HEAD not among the pushed shas gates ONE of them — the newest (${M_NEW.slice(0, 8)}), isolated (got ${awayFast.length} run(s) at ${(awayFast[0] || {}).sha || '-'})`);
    ok(/refs\/heads\/multi6c tips at/.test(rMultiAway.out) && /publishes 1 other commit\(s\)/.test(rMultiAway.out),
      '…named by its ref, with the one it did not cover named too');

    // A one-ref push says nothing about "other commits" — the message is a
    // statement of fact, not decoration.
    git(repo, ['checkout', '-q', 'multi6']);
    const rOne = runHookRefs(`refs/heads/multi6 ${M_HEAD} refs/heads/multi6 ${ZERO}\n`);
    ok(rOne.calls.filter((c) => c.mode === 'fast').length === 1 && !/other commit\(s\)/.test(rOne.out),
      'a single-ref push is byte-for-byte the old behaviour: one in-place run, and no claim about commits it skipped');

    // NEGATIVE CONTROL: the selection put back to "every distinct sha", which
    // is the round-5 hook's behaviour verbatim (the loop below it is unchanged).
    const preOne = preFixHook('onesubject', ['  fast_subjects="$subject"', '  fast_subjects="$distinct"']);
    if (preOne) {
      const n = runHookRefs(threeRefs, {}, preOne);
      ok(n.calls.filter((c) => c.mode === 'fast').length === 3,
        `NEG: with the selection reverted the same push runs the whole fast tier THREE times (got ${n.calls.filter((c) => c.mode === 'fast').length}) — N× the budget and N billed turns`);
    }
  }
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

  // "KILLED FROM OUTSIDE" MUST NOT LAUNDER A HANG — OR A CRASH (round 4).
  // A heavy run refuses to write a verdict when a child died on a signal it
  // did not send: that is how a superseded or Ctrl-C'd run stops stamping a
  // RED built from its own interruption. Two things must not get in under
  // that rule:
  //   · a suite that HANGS is killed by our own budget with the same SIGTERM,
  //     and that one IS a red — spawnSync reports ETIMEDOUT for its own kill;
  //   · a suite that CRASHES dies on a signal nobody sent it, and that is the
  //     most literal possible fact about the code under test. Measured on this
  //     box (scripts/ci.mjs quotes the numbers): a V8 heap-limit OOM exits
  //     {status:null, signal:'SIGABRT'} and an external-memory OOM is taken by
  //     the kernel as {status:null, signal:'SIGKILL'}. Reading either as
  //     supersession abandoned the tier at that suite and exited 0.
  // So OUTSIDE is an ALLOWLIST of the signals a supersede or an operator
  // sends, and everything else is a verdict about the suite.
  ok(killedFromOutside({ signal: 'SIGTERM' }) === true, 'a child killed by SIGTERM with no error of ours reads as killed from OUTSIDE (this is what supersession sends)');
  ok(killedFromOutside({ signal: 'SIGINT' }) === true && killedFromOutside({ signal: 'SIGHUP' }) === true,
    '…SIGINT (Ctrl-C) and SIGHUP (the terminal went away) too');
  ok(killedFromOutside({ signal: 'SIGABRT' }) === false,
    'NEG: SIGABRT does NOT — that is how a V8 heap-limit OOM dies, i.e. a fact about the code under test (measured: {status:null, signal:"SIGABRT"})');
  ok(killedFromOutside({ signal: 'SIGKILL' }) === false,
    'NEG: nor SIGKILL — the kernel OOM killer\'s signal; an operator\'s kill -9 is indistinguishable from here, and a wrong RED costs one re-run while a wrong "abandoned" is a silent green');
  ok(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE'].every((s) => killedFromOutside({ signal: s }) === false),
    'NEG: nor any native crash signal (SIGSEGV/SIGBUS/SIGILL/SIGFPE)');
  ok(killedFromOutside({ signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }) === false,
    'NEG: our OWN budget kill (ETIMEDOUT) does NOT — a hung suite is a red, never a "no verdict"');
  ok(killedFromOutside({ status: 1 }) === false && killedFromOutside({ status: 0 }) === false && killedFromOutside(null) === false,
    'NEG: an ordinary failure, an ordinary pass and a missing result are not signals');
  // The allowlist is the thing under test, so it is READ from the module
  // rather than re-spelled here: a signal added to it tomorrow has to be one
  // of the three a supersede/operator sends, and this states that out loud.
  ok(OUTSIDE_SIGNALS.join(',') === 'SIGTERM,SIGINT,SIGHUP',
    `the OUTSIDE set is exactly the signals somebody SENDS this run (${OUTSIDE_SIGNALS.join(', ')})`);
  ok(OUTSIDE_SIGNALS.every((s) => killedFromOutside({ signal: s }) === true),
    '…and every member of it really reads as outside (the list is not decorative)');

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

  // MARKER KINDS HAVE THREE READERS. ci.mjs writes them and names them in one
  // regex, GET /api/ci-heavy (src/server/ops-routes.js) re-spells that regex to
  // serve them, and the Diagnostics report renders the verdict words. `skipped`
  // was added in round 2, and a kind that only ever reaches the CLI is a
  // verdict the UI silently DROPS — the absence looks exactly like "nobody has
  // pushed lately", which is the failure mode invariant ⑪ exists to kill. So the
  // API leg is derived from ci.mjs's own list (a FIFTH kind added tomorrow has
  // to be served too), while the RENDERER leg names `skipped` on purpose: `pid`
  // is not a verdict there (an in-flight run is the RUNNING row), so "render
  // every kind" would be the wrong rule.
  {
    // ONE detector, used by the real files and by the controls below — a
    // negative control has to exercise the code under test, not a paraphrase.
    const readsKind = (src, k) => new RegExp(`\\(([a-z|]*\\|)?${k}(\\||\\))`).test(src);
    const ciSrc = fs.readFileSync(path.join(REPO, 'scripts', 'ci.mjs'), 'utf-8');
    const kinds = (/\\\.\(([a-z|]+)\)\$/.exec(ciSrc) || [, ''])[1].split('|').filter(Boolean);
    ok(kinds.includes('green') && kinds.includes('red') && kinds.includes('skipped') && kinds.includes('pid'),
      `ci.mjs reads the marker kinds it writes (${kinds.join(', ') || 'NONE FOUND — the regex moved'})`);
    const ops = fs.readFileSync(path.join(REPO, 'src', 'server', 'ops-routes.js'), 'utf-8');
    const missing = kinds.filter((k) => !readsKind(ops, k));
    ok(!missing.length, `GET /api/ci-heavy reads every marker kind ci.mjs writes (missing: ${missing.join(', ') || 'none'})`);
    const rendersSkipped = (src) => /'skipped'/.test(src) && /SKIP/.test(src);
    const flows = fs.readFileSync(path.join(REPO, 'src', 'lib', 'setup-flows.js'), 'utf-8');
    ok(rendersSkipped(flows), 'the Diagnostics report renders the skipped kind (a verdict-less run is visible, not dropped)');

    // NEGATIVE CONTROLS. Both asserts above are greps, and a grep that matches
    // anything is not an assert: mutate each source the way the defect would
    // and require the SAME detector to name the missing kind.
    const opsPreFix = ops.replace(/\(green\|red\|pid\|skipped\)/g, '(green|red|pid)');
    ok(opsPreFix !== ops && kinds.filter((k) => !readsKind(opsPreFix, k)).join(',') === 'skipped',
      'NEG: an /api/ci-heavy that still reads only the pre-round-2 kinds is caught, and named ("skipped")');
    ok(!rendersSkipped(flows.replace(/'skipped'/g, "'green'")),
      'NEG: a Diagnostics renderer with the skipped branch removed is caught (that row would silently vanish from the report)');

    // …AND SO DOES THE `absent` FIELD (round 6). It is not a kind, it is what
    // makes `suites` mean something else: a run is isolated at a sha, and this
    // gate's table can name suites that sha never contained (measured: 42 of 97
    // at master~300), so a green row printing the total contradicts its own
    // record. Same three readers, same rule — one detector per reader, each with
    // the mutation that would drop it.
    const writesAbsent = (src) => /absent: absent\.length \? absent : undefined/.test(src);
    const servesAbsent = (src) => /absent: Array\.isArray\(rec\.absent\) \? rec\.absent\.length : 0/.test(src);
    const rendersAbsent = (src) => /r\.absent \?/.test(src) && /\{n\} not present at that commit/.test(src);
    ok(writesAbsent(ciSrc), 'ci.mjs records the suites the gated commit did not contain (marker field `absent`)');
    ok(servesAbsent(ops), '…GET /api/ci-heavy serves it');
    ok(rendersAbsent(flows), '…and the Diagnostics report renders it (a field that only reaches the CLI is the marker-kind lesson again)');
    ok(!servesAbsent(ops.replace(/absent: Array\.isArray\(rec\.absent\) \? rec\.absent\.length : 0, /, '')),
      'NEG: a route that drops the field is caught');
    ok(!rendersAbsent(flows.replace(/\$\{r\.absent \?/g, '${false ?')),
      'NEG: …as is a report that has the number and does not print it');
    // The CLI is the FOURTH reader, and it is the one an operator actually runs
    // — so this leg is FUNCTIONAL rather than a grep: a real marker through the
    // real `--status`, with a marker that has no absent list as the control.
    {
      const sdir = mktmp('status-absent');
      const sha = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '').trim();
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, `${sha}.green`), JSON.stringify({ sha, result: 'green', failed: [], suites: 97, absent: ['test-a', 'test-b'], endedAt: Date.now(), ms: 1000 }));
      const run = () => {
        const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--status', '--markers=' + sdir, '--head=' + sha], { cwd: REPO, encoding: 'utf-8', env: GIT_ENV });
        return (r.stdout || '') + (r.stderr || '');
      };
      const withAbsent = run();
      ok(/97 suites/.test(withAbsent) && /2 not present at that commit/.test(withAbsent),
        'ci:status prints the absent count beside the suite total (the number is what makes "97 suites" true or false)');
      fs.writeFileSync(path.join(sdir, `${sha}.green`), JSON.stringify({ sha, result: 'green', failed: [], suites: 97, endedAt: Date.now(), ms: 1000 }));
      ok(!/not present at that commit/.test(run()),
        'CONTROL: a marker with no absent list says nothing about absence (the row is not decorated unconditionally)');
    }
  }

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
