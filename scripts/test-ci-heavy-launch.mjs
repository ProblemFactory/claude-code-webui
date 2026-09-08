#!/usr/bin/env node
// THE HEAVY RUN, FOR REAL (2026-09-07, B-4c5a). scripts/test-ci-gate.mjs proves
// the gate's DECISIONS (census, block rule, hook control flow) in seconds; this
// suite proves the MACHINERY by actually doing it: `ci.mjs --heavy-launch`
// detaches a child, the child checks out an isolated worktree at the named sha,
// runs a slice of the heavy tier there, writes data/ci-heavy/<sha>.{green,red},
// removes its pid file and cleans the worktree up.
//
// WHY IT IS IN THE FAST TIER even though it costs a real worktree + build +
// suite (measured 5.5 s here): the launcher is a SILENT-FAILURE path. If
// detaching breaks, nothing throws and nobody waits — the heavy tier simply
// never runs again and the only symptom is `npm run ci:status` staying empty,
// which looks exactly like "nobody has pushed lately". A guard for that has to
// run on every push, not in the tier it is guarding.
//
// It runs with --markers pointed at a temp dir, so it never writes a marker
// that could block a real push.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUITES } from './ci.mjs';
import { gitEnvFrom } from './git-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ENV = gitEnvFrom(process.env);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf-8', env: GIT_ENV });
if (head.status !== 0) { console.log('SKIP: not a git checkout (no HEAD to name a marker after)'); process.exit(0); }
const SHA = head.stdout.trim();

// The slice to run inside the launched child. It is named explicitly (not
// "whatever is first") so that moving it out of the heavy tier fails HERE,
// loudly, instead of silently changing what this suite exercises.
const SLICE = 'test-attach-ack';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ci-heavy-e2e-'));
const worktreesBefore = spawnSync('git', ['-C', REPO, 'worktree', 'list'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';

try {
  ok(SUITES.some((s) => s.name === SLICE && s.tier === 'heavy'), `${SLICE} is in the heavy tier (this suite runs it through the launcher)`);

  const t0 = Date.now();
  const launch = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + dir, '--only=' + SLICE],
    { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
  ok(launch.status === 0, `--heavy-launch returns immediately (exit ${launch.status}, ${Date.now() - t0}ms)`);
  ok(Date.now() - t0 < 20000, `…and it does NOT wait for the run (${Date.now() - t0}ms — the hook must not stall the push)`);

  const pidFile = path.join(dir, `${SHA}.pid`);
  ok(fs.existsSync(pidFile), 'a pid file names the detached child while it runs');
  const pidRec = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
  ok(pidRec.pid > 0 && pidRec.pid !== process.pid, `the run is a SEPARATE process (pid ${pidRec.pid})`);
  ok(fs.existsSync(path.join(dir, `${SHA}.log`)), 'its output goes to <sha>.log');

  // Wait for a verdict. The child does: worktree add → npm run build → one
  // heavy suite. Generous, because this box also runs other agents' gates.
  const deadline = Date.now() + 8 * 60 * 1000;
  const marker = () => ['green', 'red'].map((k) => path.join(dir, `${SHA}.${k}`)).find((p) => fs.existsSync(p));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (!marker() && Date.now() < deadline) await sleep(1000);
  const found = marker();
  ok(!!found, `the detached run finished and wrote a marker (${Math.round((Date.now() - t0) / 1000)}s)`);
  if (found) {
    const rec = JSON.parse(fs.readFileSync(found, 'utf-8'));
    ok(rec.sha === SHA, 'the marker names the sha it was launched for');
    ok(rec.isolated === true, 'the run was ISOLATED (a marker that names a commit must have tested that commit)');
    ok(Array.isArray(rec.partial) && rec.partial.join() === SLICE, `the record says which slice ran (${(rec.partial || []).join()})`);
    ok(rec.result === (rec.failed.length ? 'red' : 'green'), 'green/red matches the recorded failure list');
    ok(typeof rec.ms === 'number' && rec.ms > 0 && Array.isArray(rec.timings), 'the record carries a duration and per-suite timings');
    ok(rec.result === 'green', `the slice passed inside the isolated worktree (${rec.failed.join(', ') || 'no failures'})`);
    const log = fs.readFileSync(path.join(dir, `${SHA}.log`), 'utf-8');
    ok(log.includes('HEAVY tier') && log.includes(SLICE), 'the log records what ran');
  }
  ok(!fs.existsSync(pidFile), 'the pid file is removed when the run ends (a dead pid must never read as "in flight")');

  const worktreesAfter = spawnSync('git', ['-C', REPO, 'worktree', 'list'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';
  ok(worktreesAfter.split('\n').length === worktreesBefore.split('\n').length && !worktreesAfter.includes('vs-ci-heavy-'),
    'the isolated worktree is cleaned up (no registration left behind)');

  // A second launch for a sha that is already running must not start a twin.
  fs.writeFileSync(pidFile, JSON.stringify({ sha: SHA, pid: process.pid, startedAt: Date.now() }));
  const twin = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + dir, '--only=' + SLICE],
    { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
  ok(/already running/.test(twin.stderr || ''), 'a second launch for an in-flight sha is refused, out loud');
  fs.unlinkSync(pidFile);

  // An unknown commit is refused rather than stamped.
  const bogus = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--markers=' + dir],
    { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
  ok(/unknown commit/.test(bogus.stderr || ''), 'launching for a commit this repo does not know is refused, out loud');

  // --only with a name that is not a heavy suite must be LOUD: silently
  // running zero suites and stamping a GREEN marker is the worst outcome.
  const typo = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy', '--sha=' + SHA, '--markers=' + dir, '--only=test-typo-not-a-suite'],
    { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
  ok(typo.status === 2 && /not a heavy suite/.test(typo.stderr || ''), 'a typo in --only exits loudly instead of stamping a vacuous green');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { spawnSync('git', ['-C', REPO, 'worktree', 'prune'], { env: GIT_ENV }); } catch {}
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
