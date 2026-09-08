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
    // (1) SUPERSEDE, WITH BOTH OF ITS NEGATIVE CONTROLS DECIDED BY THE SAME
    //     LAUNCH so none of the three can pass vacuously:
    //       · an in-flight run for an ANCESTOR of the sha being pushed is
    //         killed — the newer commit subsumes it;
    //       · a run for a commit that is NOT an ancestor is left alone —
    //         superseding it would throw away a verdict nobody is replacing,
    //         so it queues on the machine lock instead;
    //       · a pid that does not READ as a heavy run is never killed, even
    //         for an ancestor. Superseding SIGTERMs a process GROUP, so the
    //         cost of a recycled pid (or of a pid file an older ci.mjs wrote
    //         without a `cmd`) is somebody else's work. Reading trusts;
    //         killing demands positive evidence.
    //     The two that must DIE or SURVIVE as heavy runs are real, parked
    //     `ci.mjs --heavy` processes (waiting on a lock somebody else holds),
    //     not stand-ins: the predicate under test reads /proc, so the fixture
    //     has to be the thing.
    const detach = (argv) => {
      const r = spawnSync(process.execPath, ['-e',
        'const {spawn}=require("child_process");const a=JSON.parse(process.argv[1]);const c=spawn(a[0],a.slice(1),{detached:true,stdio:"ignore",cwd:process.argv[2]});c.unref();console.log(c.pid)',
        JSON.stringify(argv), REPO], { encoding: 'utf-8', env: GIT_ENV });
      return Number((r.stdout || '').trim());
    };
    const sleeper = () => detach([process.execPath, '-e', 'setTimeout(()=>{},120000)']);
    const parkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ci-heavy-park-'));
    const parkLock = path.join(parkDir, 'lock');
    const parkHolder = sleeper();
    fs.writeFileSync(parkLock, JSON.stringify({ pid: parkHolder, sha: 'f'.repeat(40), startedAt: Date.now() }));
    const parkedHeavy = (forSha) => detach([process.execPath, path.join(REPO, 'scripts', 'ci.mjs'),
      '--heavy', '--sha=' + forSha, '--isolate', '--markers=' + parkDir, '--only=' + SLICE, '--lock=' + parkLock, '--lock-wait-ms=600000']);

    const p1 = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD~1'], { encoding: 'utf-8', env: GIT_ENV });
    const p2 = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD~2'], { encoding: 'utf-8', env: GIT_ENV });
    // The "not an ancestor" control has to be a commit this repo KNOWS —
    // `deadbeef…` would be skipped by the unknown-commit branch and never
    // reach the ancestry test at all, which is exactly the kind of control
    // that passes without testing anything. `commit-tree` mints a real,
    // dangling commit off HEAD~1: it exists, and HEAD does not descend from it.
    const minted = spawnSync('git', ['-C', REPO, 'commit-tree', 'HEAD^{tree}', '-p', (p1.stdout || '').trim() || 'HEAD', '-m', 'test-ci-heavy-launch: a commit HEAD does not descend from'],
      { encoding: 'utf-8', env: { ...GIT_ENV, GIT_AUTHOR_NAME: 'gate test', GIT_AUTHOR_EMAIL: 'gate@test.local', GIT_COMMITTER_NAME: 'gate test', GIT_COMMITTER_EMAIL: 'gate@test.local' } });
    if (p1.status === 0 && p2.status === 0 && minted.status === 0) {
      const OLD = p1.stdout.trim(), OLD2 = p2.stdout.trim();
      const NOTANC = minted.stdout.trim();
      ok(spawnSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', NOTANC, SHA], { env: GIT_ENV }).status !== 0
        && spawnSync('git', ['-C', REPO, 'cat-file', '-e', NOTANC + '^{commit}'], { env: GIT_ENV }).status === 0,
        `the NON-ancestor control is a commit this repo knows but HEAD does not descend from (${NOTANC.slice(0, 8)}) — so it reaches the ancestry test`);
      const vpid = parkedHeavy(OLD);       // a real heavy run for an ancestor ⇒ must die
      const opid = parkedHeavy(NOTANC);    // a real heavy run, not an ancestor ⇒ must live
      const spid = sleeper();              // NOT a heavy run, but an ancestor ⇒ must live
      // The parked runs must actually BE parked heavy runs before we judge them.
      const reads = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' '); } catch { return ''; } };
      for (let i = 0; i < 100 && !(reads(vpid).includes('ci.mjs') && reads(opid).includes('ci.mjs')); i++) await sleep(50);
      ok(reads(vpid).includes('--heavy') && reads(opid).includes('--heavy'),
        'the supersede fixtures are REAL parked `ci.mjs --heavy` processes (the predicate reads /proc)');
      ok(!reads(spid).includes('ci.mjs'), '…and the third fixture deliberately is not one');
      for (const [s, p] of [[OLD, vpid], [NOTANC, opid], [OLD2, spid]]) {
        fs.writeFileSync(path.join(dir, `${s}.pid`), JSON.stringify({ sha: s, pid: p, startedAt: Date.now() }));
      }
      const sup = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + dir, '--only=' + SLICE, ...lockArgs],
        { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
      const serr = sup.stderr || '';
      ok(/superseded the run for/.test(serr), `an in-flight run for an ANCESTOR is superseded, out loud (${serr.trim().split('\n').find((l) => /superseded/.test(l)) || 'silent'})`);
      ok(!fs.existsSync(path.join(dir, `${OLD}.pid`)), '…its pid file is removed (it is no longer in flight)');
      let dead = false;
      for (let i = 0; i < 100 && !dead; i++) { try { process.kill(vpid, 0); await sleep(50); } catch { dead = true; } }
      ok(dead, `…and the process it named is gone (pid ${vpid})`);
      let oAlive = false; try { process.kill(opid, 0); oAlive = true; } catch { }
      ok(oAlive && fs.existsSync(path.join(dir, `${NOTANC}.pid`)),
        'NEG: the SAME launch leaves the run for a NON-ancestor alone (pid alive, pid file kept)');
      let sAlive = false; try { process.kill(spid, 0); sAlive = true; } catch { }
      ok(sAlive && /NOT superseding/.test(serr),
        'NEG: …and refuses to kill an ANCESTOR whose pid does not read as a heavy run, out loud (queues instead)');
      for (const p of [opid, spid, parkHolder]) { try { process.kill(-p, 'SIGKILL'); } catch { try { process.kill(p, 'SIGKILL'); } catch { } } }
      for (const s of [NOTANC, OLD2]) { try { fs.unlinkSync(path.join(dir, `${s}.pid`)); } catch { } }
      // The launch we just made is real; let it finish before the temp dir goes.
      for (let i = 0; i < 300 && fs.existsSync(path.join(dir, `${SHA}.pid`)); i++) await sleep(1000);
    } else {
      // A shallow CI checkout has no HEAD~2, and a runner with no git identity
      // cannot mint the control commit. SKIP loudly rather than pretend.
      console.log(`  – SKIP supersede legs: need HEAD~1/HEAD~2 and a mintable control commit (rev-parse ${p1.status}/${p2.status}, commit-tree ${minted.status}: ${(minted.stderr || '').trim().slice(0, 80)})`);
      try { process.kill(parkHolder, 'SIGKILL'); } catch { }
    }
    try { fs.rmSync(parkDir, { recursive: true, force: true }); } catch { }

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
      // os.tmpdir(), not machineTmpDir(): a scratch CHECKOUT should follow
      // TMPDIR (it is per-run scratch, named by sha+pid). Only the LOCK has to
      // be a machine-wide name, which is why exactly one of them ignores it.
      const wtPath = path.join(os.tmpdir(), wtName);
      // WAIT UNTIL THE CHILD IS PAST `git worktree add`, NOT MERELY INSIDE IT.
      // Measured while mutation-testing this leg: killing during the add made
      // the "checkout removed" assert pass with the handlers DELETED, because
      // GIT cleans up its own interrupted add — the leg was measuring git, not
      // us. heavyGate symlinks node_modules only after the add SUCCEEDS, so
      // that symlink is the "the checkout is now ours to leak" signal. (A/B
      // with the corrected timing: handlers on ⇒ gone/unregistered/unlocked;
      // handlers off ⇒ all three left behind.)
      let appeared = false;
      for (let i = 0; i < 400 && !appeared; i++) { try { fs.lstatSync(path.join(wtPath, 'node_modules')); appeared = true; } catch { await sleep(50); } }
      ok(appeared, `a running heavy child really has an isolated checkout to leak, past \`worktree add\` (${wtName})`);
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

    // (1c) A SUPERSEDED RUN STOPS AND CLAIMS NOTHING — the production path.
    //      heavyGate is spawnSync from top to bottom, so the SIGTERM handler
    //      cannot preempt it; the abort is a synchronous QUESTION asked between
    //      suites, and the launcher's removal of our pid file is the answer.
    //      Without it a superseded run finished the tier and stamped a marker
    //      whose build had been KILLED — a RED for the very commit the newer
    //      run replaced (measured while mutation-testing (1b)).
    {
      const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ci-heavy-sup-'));
      const slock = path.join(sdir, 'lock');
      spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci.mjs'), '--heavy-launch', SHA, '--markers=' + sdir, '--only=' + SLICE, '--lock=' + slock, '--lock-wait-ms=5000'],
        { cwd: REPO, encoding: 'utf-8', env: GIT_ENV, timeout: 60000 });
      const spidFile = path.join(sdir, `${SHA}.pid`);
      ok(fs.existsSync(spidFile), 'a launched run has a pid file — the thing superseding removes');
      // Remove it while the run is still working (its build alone takes ~2 s).
      try { fs.unlinkSync(spidFile); } catch { }
      // Wait for the run to CLOSE. `/HEAVY/` alone matches its own opening
      // line ("release gate — HEAVY tier: …"), so it has to be the summary.
      const readLog = () => { try { return fs.readFileSync(path.join(sdir, `${SHA}.log`), 'utf-8'); } catch { return ''; } };
      let done = false;
      for (let i = 0; i < 600 && !done; i++) { done = /HEAVY (GATE|TIER) (GREEN|RED|ABORTED|SKIPPED)/.test(readLog()); if (!done) await sleep(50); }
      const slog = readLog();
      ok(done, `the superseded run reached its closing line (${(slog.trim().split('\n').pop() || '(no output)').slice(0, 90)})`);
      ok(/stopping: superseded by a newer push/.test(slog), `…and removing it makes the run STOP, saying why (${(slog.match(/stopping: [^\n]*/) || ['(never said)'])[0]})`);
      ok(!fs.readdirSync(sdir).some((f) => /\.(green|red)$/.test(f)),
        `…and it writes NO verdict for a commit whose run it did not finish (${fs.readdirSync(sdir).join(' ')})`);
      ok(/NO VERDICT WRITTEN/.test(slog), '…and its closing line says so');
      ok(/HEAVY TIER ABORTED/.test(slog) && !/HEAVY (GATE|TIER) GREEN/.test(slog),
        '…and calls itself ABORTED, never GREEN — a tier that ran zero suites did not pass, and "HEAVY TIER GREEN" is quotable out of context');
      try { fs.rmSync(sdir, { recursive: true, force: true }); } catch { }
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
