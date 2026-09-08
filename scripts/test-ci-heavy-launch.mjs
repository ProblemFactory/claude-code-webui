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
// that could block a real push, and with --lock pointed at a temp file, so it
// neither waits for the box's real heavy tier nor makes it wait (2026-09-07
// round 2: the machine lock is real infrastructure and a fast-tier suite must
// never queue behind sixteen minutes of somebody else's run).
//
// THE SLICE IT RUNS MUST CLAIM NOTHING (same round). It used to be
// test-attach-ack, which bound a fixed :3991 and force-removed a fixed
// /tmp/vs-ack-smoke — so this FAST-tier, fail-fast, no-retry, push-blocking
// suite went red whenever any other checkout on this box was mid-heavy-tier.
// Reproduced: a bare listener on :3991 and this suite's slice hangs to its
// budget. The slice is now a pure-logic heavy suite, and test-ci-gate §6
// asserts that — for this file's SLICE and for every fast-tier suite — via
// ci.mjs `machineGlobalFixtures`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUITES, machineGlobalFixtures } from './ci.mjs';
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
// loudly, instead of silently changing what this suite exercises. It must be
// PURE LOGIC — see the header: what is under test is the launcher, and a slice
// that binds a port or a fixed /tmp path makes this fast-tier suite fail for
// reasons that have nothing to do with the launcher.
const SLICE = 'test-eml';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ci-heavy-e2e-'));
// Our OWN machine lock, so this never queues behind (or blocks) the box's real
// heavy tier, and a 5 s wait budget so a leftover from a previous run of THIS
// suite fails loudly instead of hanging.
const LOCK = path.join(dir, 'lock');
const lockArgs = ['--lock=' + LOCK, '--lock-wait-ms=5000'];
const worktreesBefore = spawnSync('git', ['-C', REPO, 'worktree', 'list'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';

try {
  ok(SUITES.some((s) => s.name === SLICE && s.tier === 'heavy'), `${SLICE} is in the heavy tier (this suite runs it through the launcher)`);
  const sliceFixtures = machineGlobalFixtures(fs.readFileSync(path.join(REPO, 'scripts', SLICE + '.mjs'), 'utf-8'));
  ok(!sliceFixtures.ports.length && !sliceFixtures.paths.length,
    `${SLICE} claims no machine-global port or /tmp path (${[...sliceFixtures.ports, ...sliceFixtures.paths].join(', ') || 'clean'})`);

  const t0 = Date.now();
  const launch = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + dir, '--only=' + SLICE, ...lockArgs],
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

  // OUR worktree is gone. Deliberately NOT "no vs-ci-heavy- registration
  // exists" and NOT a line count: `git worktree list` is shared by every
  // checkout of this repository (~160 on this box), so another agent's heavy
  // run — or any of them adding a worktree while this suite runs — used to
  // fail this assert for reasons that have nothing to do with the launcher.
  // The child names its worktree after its own sha and pid, so we can ask
  // about exactly the one we caused.
  const worktreesAfter = spawnSync('git', ['-C', REPO, 'worktree', 'list'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';
  const ourWt = `vs-ci-heavy-${SHA.slice(0, 8)}-${pidRec.pid}`;
  ok(!worktreesAfter.includes(ourWt) && !fs.existsSync(path.join(os.tmpdir(), ourWt)),
    `the isolated worktree is cleaned up (${ourWt}: no registration, no directory)`);
  ok(worktreesBefore.includes(REPO) || worktreesBefore.length > 0, 'the before/after worktree listing was readable (the assert above is non-vacuous)');

  // A second launch for a sha that is already running must not start a twin.
  fs.writeFileSync(pidFile, JSON.stringify({ sha: SHA, pid: process.pid, startedAt: Date.now() }));
  const twin = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + dir, '--only=' + SLICE, ...lockArgs],
    { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
  ok(/already running/.test(twin.stderr || ''), 'a second launch for an in-flight sha is refused, out loud');
  fs.unlinkSync(pidFile);

  // ── ONE HEAVY TIER PER MACHINE (2026-09-07 round 2) ────────────────────
  // Reproduced before the fix: two `--heavy-launch` calls ~20 ms apart for
  // DIFFERENT shas each started a full heavy tier, and the two runs ate each
  // other's ports and /tmp checkouts until the loser stamped a red that
  // blocked the next push. Here the two mechanisms are exercised for real.
  {
    // (1) SUPERSEDE — and its negative control, decided by the SAME launch so
    //     neither can pass vacuously: an in-flight run for an ANCESTOR of the
    //     sha being pushed is killed (the newer commit subsumes it), while a
    //     run for a commit that is NOT an ancestor is left alone (superseding
    //     it would throw away a verdict nobody is replacing — it queues on the
    //     machine lock instead).
    const sleeper = () => {
      const r = spawnSync(process.execPath, ['-e', 'const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},120000)"],{detached:true,stdio:"ignore"});c.unref();console.log(c.pid)'], { encoding: 'utf-8' });
      return Number((r.stdout || '').trim());
    };
    const parent = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD~1'], { encoding: 'utf-8', env: GIT_ENV });
    if (parent.status === 0) {
      const OLD = parent.stdout.trim();
      const NOTANC = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const vpid = sleeper(), opid = sleeper();
      fs.writeFileSync(path.join(dir, `${OLD}.pid`), JSON.stringify({ sha: OLD, pid: vpid, startedAt: Date.now() }));
      fs.writeFileSync(path.join(dir, `${NOTANC}.pid`), JSON.stringify({ sha: NOTANC, pid: opid, startedAt: Date.now() }));
      const sup = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + dir, '--only=' + SLICE, ...lockArgs],
        { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
      ok(/superseded the run for/.test(sup.stderr || ''), `an in-flight run for an ANCESTOR is superseded, out loud (${(sup.stderr || '').trim().split('\n')[0] || 'silent'})`);
      ok(!fs.existsSync(path.join(dir, `${OLD}.pid`)), '…its pid file is removed (it is no longer in flight)');
      let dead = false;
      for (let i = 0; i < 60 && !dead; i++) { try { process.kill(vpid, 0); await sleep(50); } catch { dead = true; } }
      ok(dead, `…and the process it named is gone (pid ${vpid})`);
      let stillAlive = false; try { process.kill(opid, 0); stillAlive = true; } catch { }
      ok(stillAlive && fs.existsSync(path.join(dir, `${NOTANC}.pid`)),
        'NEG: the SAME launch leaves the run for a NON-ancestor alone (pid alive, pid file kept)');
      try { process.kill(-opid, 'SIGKILL'); } catch { try { process.kill(opid, 'SIGKILL'); } catch { } }
      try { fs.unlinkSync(path.join(dir, `${NOTANC}.pid`)); } catch { }
      // The launch we just made is real; let it finish before the temp dir goes.
      for (let i = 0; i < 300 && fs.existsSync(path.join(dir, `${SHA}.pid`)); i++) await sleep(1000);
    }

    // (1b) A SUPERSEDED RUN CLEANS UP AFTER ITSELF. Superseding SIGTERMs a run
    //      that is minutes into its tier, and node's default SIGTERM does not
    //      run `finally` — so the killed run would leave a full checkout in
    //      /tmp, a `git worktree list` registration that `worktree prune`
    //      cannot remove (the directory still exists), and the machine lock
    //      held. Drive it directly so the kill lands AFTER the worktree exists.
    {
      const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ci-heavy-kill-'));
      const klock = path.join(kdir, 'lock');
      const child = spawnSync(process.execPath, ['-e',
        `const {spawn}=require('child_process');const c=spawn(process.argv[1],[process.argv[2],'--heavy','--sha='+process.argv[3],'--isolate','--markers='+process.argv[4],'--only='+process.argv[5],'--lock='+process.argv[6]],{detached:true,stdio:'ignore',cwd:process.argv[7]});c.unref();console.log(c.pid)`,
        process.execPath, path.join(REPO, 'scripts', 'ci.mjs'), SHA, kdir, SLICE, klock, REPO], { encoding: 'utf-8', env: GIT_ENV });
      const kpid = Number((child.stdout || '').trim());
      const wtName = `vs-ci-heavy-${SHA.slice(0, 8)}-${kpid}`;
      const wtPath = path.join(os.tmpdir(), wtName);
      let appeared = false;
      for (let i = 0; i < 200 && !appeared; i++) { appeared = fs.existsSync(wtPath); if (!appeared) await sleep(50); }
      ok(appeared, `a running heavy child really has an isolated checkout to leak (${wtName})`);
      if (appeared) {
        ok(fs.existsSync(klock), '…and really holds the machine lock while it runs');
        try { process.kill(-kpid, 'SIGTERM'); } catch { try { process.kill(kpid, 'SIGTERM'); } catch { } }
        let gone = false;
        for (let i = 0; i < 200 && !gone; i++) { gone = !fs.existsSync(wtPath); if (!gone) await sleep(50); }
        ok(gone, '…and on SIGTERM (this is what superseding does) it removes that checkout');
        const wlist = spawnSync('git', ['-C', REPO, 'worktree', 'list'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';
        ok(!wlist.includes(wtName), '…leaves no registration behind in `git worktree list`');
        let lockGone = false;
        for (let i = 0; i < 100 && !lockGone; i++) { lockGone = !fs.existsSync(klock); if (!lockGone) await sleep(50); }
        ok(lockGone, '…and releases the machine lock (a killed run must not block the tier forever)');
        ok(!fs.readdirSync(kdir).some((f) => /\.(green|red)$/.test(f)), '…and writes NO verdict (it never finished)');
      }
      try { fs.rmSync(kdir, { recursive: true, force: true }); } catch { }
    }

    // (2) THE MACHINE LOCK: a second heavy run does not start while another
    //     holds it, and says NO VERDICT WRITTEN instead of stamping one.
    const heldLock = path.join(dir, 'held.lock');
    const hpid = sleeper();
    fs.writeFileSync(heldLock, JSON.stringify({ pid: hpid, sha: 'f'.repeat(40), startedAt: Date.now() }));
    const waitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ci-heavy-lock-'));
    const t2 = Date.now();
    const blocked = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy', '--sha=' + SHA, '--isolate', '--markers=' + waitDir, '--only=' + SLICE, '--lock=' + heldLock, '--lock-wait-ms=2000'],
      { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 120000 });
    const bout = (blocked.stdout || '') + (blocked.stderr || '');
    ok(blocked.status === 3, `a heavy run that never gets the machine lock exits 3 = did not run (got ${blocked.status})`);
    ok(/HEAVY TIER SKIPPED/.test(bout) && /NO VERDICT WRITTEN/.test(bout), '…and says SKIPPED / NO VERDICT WRITTEN, never "GATE GREEN"');
    ok(!fs.existsSync(path.join(waitDir, `${SHA}.green`)) && !fs.existsSync(path.join(waitDir, `${SHA}.red`)),
      '…and writes NO green/red marker (a run that did not happen claims nothing)');
    ok(fs.existsSync(path.join(waitDir, `${SHA}.skipped`)), '…but leaves a `skipped` note so ci:status can say the commit has no verdict');
    ok(Date.now() - t2 >= 2000, `…after actually waiting for its budget (${Date.now() - t2}ms ≥ 2000)`);
    try { process.kill(-hpid, 'SIGKILL'); } catch { try { process.kill(hpid, 'SIGKILL'); } catch { } }
    // NEGATIVE CONTROL: the same command with a DEAD holder steals the stale
    // lock and runs — otherwise one crashed run would block the tier forever.
    fs.writeFileSync(heldLock, JSON.stringify({ pid: hpid, sha: 'f'.repeat(40), cmd: 'ci.mjs', startedAt: Date.now() }));
    const stolen = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy', '--sha=' + SHA, '--isolate', '--markers=' + waitDir, '--only=' + SLICE, '--lock=' + heldLock, '--lock-wait-ms=2000'],
      { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 300000 });
    ok(stolen.status === 0 && fs.existsSync(path.join(waitDir, `${SHA}.green`)),
      `NEG: a lock whose holder is DEAD is stolen and the tier runs (exit ${stolen.status})`);
    ok(!fs.existsSync(path.join(waitDir, `${SHA}.skipped`)), '…and the green verdict replaces the earlier skipped note');
    ok(!fs.existsSync(heldLock), 'the machine lock is released when the run ends');
    fs.rmSync(waitDir, { recursive: true, force: true });
  }

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
