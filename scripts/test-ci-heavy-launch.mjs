#!/usr/bin/env node
// THE HEAVY RUN, FOR REAL (2026-09-07, B-4c5a). scripts/test-ci-gate.mjs proves
// the gate's DECISIONS (census, block rule, hook control flow) in seconds; this
// suite proves the MACHINERY by actually doing it: `ci.mjs --heavy-launch`
// detaches a child, the child checks out an isolated worktree at the named sha,
// runs a slice of the heavy tier there, writes data/ci-heavy/<sha>.{green,red},
// removes its pid file and cleans the worktree up.
//
// WHY IT IS IN THE FAST TIER even though it costs a real worktree + build +
// suite (measured: 5.5 s when written, 11.6 s after round 2's concurrency
// legs, 16.2 s with round 3's supersede A/B and its retry control, 21.5 s with
// round 4's crash-verdict and abort-exit-code A/Bs — it drives eight real
// heavy runs against stub repositories): the launcher is a
// SILENT-FAILURE path. If
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

// A throwaway REPOSITORY whose scripts/ci.mjs is the real module — or a copy of
// it with one guard reverted — and whose "heavy suites" are stubs we control.
// It is the only honest way to drive a tier whose suites sleep, crash or flake
// on demand: the real heavy suites cannot be asked to do any of those, and a
// control arm has to be the REAL module with exactly one thing changed.
const GIT_ID = { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };
function stubGateRepo(tag, { ciSource, suites, commits = 1 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vs-ci-${tag}-`));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'ci.mjs'), ciSource);
  fs.copyFileSync(path.join(REPO, 'scripts', 'git-env.mjs'), path.join(root, 'scripts', 'git-env.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { build: 'node -e "0"' } }) + '\n');
  for (const [name, src] of Object.entries(suites)) fs.writeFileSync(path.join(root, 'scripts', name + '.mjs'), src);
  const genv = { ...GIT_ENV, ...GIT_ID };
  spawnSync('git', ['init', '-q', root], { env: GIT_ENV });
  const shas = [];
  for (let i = 0; i < commits; i++) {
    if (i) fs.writeFileSync(path.join(root, 'commit-' + i), String(i));
    spawnSync('git', ['-C', root, 'add', '-A'], { env: genv });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'c' + i], { env: genv });
    shas.push((spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8', env: genv }).stdout || '').trim());
  }
  return { root, shas, sha: shas[0], lock: path.join(root, 'lock'), markers: () => { try { return fs.readdirSync(path.join(root, 'data', 'ci-heavy')); } catch { return []; } } };
}
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
  // "THE RUN FINISHED" AND "THE RUN HAS TIDIED UP" ARE TWO MOMENTS (round 4).
  // The marker is written inside heavyGate's `try` and `cleanup()` is its
  // `finally`, so between the marker appearing and the pid file / worktree
  // going away there is a window — and the window contains a `git worktree
  // remove --force` plus a `git worktree prune` against a repository this box
  // shares with ~160 checkouts. Reading the end state ONCE, immediately after
  // the marker, made these asserts a coin toss under load: measured failing
  // inside a full `npm run ci` run and passing in isolation seconds later,
  // which is a FALSE RED that blocks a push — the exact thing this whole split
  // exists to remove. So wait for the state being asserted, bounded, and say
  // how long it took (a cleanup that suddenly needs 25 s is a real finding).
  const waitFor = async (pred, ms = 30000) => {
    const t = Date.now();
    for (;;) { if (pred()) return Date.now() - t; if (Date.now() - t >= ms) return null; await sleep(50); }
  };
  const pidGoneMs = await waitFor(() => !fs.existsSync(pidFile));
  ok(pidGoneMs !== null, `the pid file is removed when the run ends (a dead pid must never read as "in flight"; ${pidGoneMs === null ? '>30000' : pidGoneMs}ms after the marker)`);

  // OUR worktree is gone. Deliberately NOT "no vs-ci-heavy- registration
  // exists" and NOT a line count: `git worktree list` is shared by every
  // checkout of this repository (~160 on this box), so another agent's heavy
  // run — or any of them adding a worktree while this suite runs — used to
  // fail this assert for reasons that have nothing to do with the launcher.
  // The child names its worktree after its own sha and pid, so we can ask
  // about exactly the one we caused.
  const ourWt = `vs-ci-heavy-${SHA.slice(0, 8)}-${pidRec.pid}`;
  const wtGoneMs = await waitFor(() => {
    const listed = spawnSync('git', ['-C', REPO, 'worktree', 'list'], { encoding: 'utf-8', env: GIT_ENV }).stdout || '';
    return !listed.includes(ourWt) && !fs.existsSync(path.join(os.tmpdir(), ourWt));
  });
  ok(wtGoneMs !== null,
    `the isolated worktree is cleaned up (${ourWt}: no registration, no directory; ${wtGoneMs === null ? '>30000' : wtGoneMs}ms after the marker)`);
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

    // (1d) SUPERSESSION MUST FREE THE MACHINE — SO IT NEVER RETRIES THE SUITE
    //      IT JUST KILLED. Superseding SIGTERMs the process GROUP, so the suite
    //      in flight dies of OUR kill; retry-once then re-ran it — a whole heavy
    //      suite (up to its budget) — before the loop top asked `abandoned()`
    //      again, and the superseded run HELD the machine lock throughout while
    //      the newer run printed "waiting up to 40 min for the machine". That is
    //      the opposite of why supersession kills instead of queueing (round 2
    //      ①a). Measured in a throwaway repo with a 90 s heavy stub, superseded
    //      6 s in; the verdict never changed (a signalled run writes none either
    //      way), the COST did.
    //
    //      It runs against a stub REPOSITORY — its own git history, its own
    //      ci.mjs copy, its own lock, one instant and one sleeping "heavy"
    //      suite — because the real tier's suites cannot be made to sleep, and
    //      the control arm has to be the REAL module with this one fix reverted.
    {
      const SLOW = (SUITES.find((x) => x.tier === 'heavy' && x.name !== SLICE) || {}).name;
      const CI_SRC = fs.readFileSync(path.join(REPO, 'scripts', 'ci.mjs'), 'utf-8');
      const GUARD = /\n\s*abandonedWhy = abandoned\(\);\n\s*if \(abandonedWhy\) \{ console\.log\(`\\n\[ci:heavy\] stopping: \$\{abandonedWhy\}`\); break; \}\n(\s*\/\/ RETRY ONCE)/;
      const preFix = CI_SRC.replace(GUARD, '\n$1');
      ok(!!SLOW && GUARD.test(CI_SRC) && preFix !== CI_SRC,
        `the ask-before-retry guard is present and the control's patch applies (slow slice: ${SLOW})`);

      const stubRepo = (ciSource) => {
        // The sleeping suite announces itself so the supersede lands while it
        // is really running, instead of at a guessed moment.
        const r = stubGateRepo('supersede', { ciSource, commits: 2, suites: {
          [SLOW]: `import fs from 'node:fs';\nfs.writeFileSync(process.env.VS_SUPERSEDE_SENTINEL, String(process.pid));\nsetTimeout(() => console.log('ALL PASS (1)'), 10000);\n`,
          [SLICE]: "console.log('ALL PASS (1)');\n",
        } });
        return { root: r.root, A: r.shas[0], B: r.shas[1], lock: r.lock, sentinel: path.join(r.root, 'started') };
      };

      // ONE arm, used for the product and for the pre-fix control: launch a run
      // for A whose only suite sleeps, wait until that suite is really running,
      // then push a DESCENDANT — the production supersede path.
      const arm = async (ciSource, patience = 400) => {
        const r = stubRepo(ciSource);
        const env = { ...GIT_ENV, VS_SUPERSEDE_SENTINEL: r.sentinel };
        const ciOf = (...a) => spawnSync(process.execPath, [path.join(r.root, 'scripts', 'ci.mjs'), ...a, '--lock=' + r.lock, '--lock-wait-ms=20000'],
          { cwd: r.root, encoding: 'utf-8', env, timeout: 60000 });
        ciOf('--heavy-launch', r.A, '--only=' + SLOW);
        for (let i = 0; i < 200 && !fs.existsSync(r.sentinel); i++) await sleep(50);
        const started = fs.existsSync(r.sentinel);
        const pidRec = (() => { try { return JSON.parse(fs.readFileSync(path.join(r.root, 'data', 'ci-heavy', `${r.A}.pid`), 'utf-8')); } catch { return null; } })();
        const sup = ciOf('--heavy-launch', r.B, '--only=' + SLICE);
        const logA = () => { try { return fs.readFileSync(path.join(r.root, 'data', 'ci-heavy', `${r.A}.log`), 'utf-8'); } catch { return ''; } };
        // The polls exit the moment they are satisfied, so the product arm's
        // budget is generous (a loaded box must not make a fast-tier suite
        // flaky); the control arm is given 2 s, long enough to catch the retry
        // in the act and far short of the 10 s suite it is re-running.
        let closed = false;
        for (let i = 0; i < patience && !closed; i++) { closed = /HEAVY (GATE|TIER) (GREEN|RED|ABORTED|SKIPPED)/.test(logA()); if (!closed) await sleep(50); }
        const markers = () => { try { return fs.readdirSync(path.join(r.root, 'data', 'ci-heavy')); } catch { return []; } };
        let bDone = false;
        for (let i = 0; i < patience && !bDone; i++) { bDone = markers().some((f) => f === `${r.B}.green` || f === `${r.B}.red`); if (!bDone) await sleep(50); }
        const bPid = (() => { try { return JSON.parse(fs.readFileSync(path.join(r.root, 'data', 'ci-heavy', `${r.B}.pid`), 'utf-8')).pid; } catch { return null; } })();
        const out = { started, closed, bDone, log: logA(), sup: (sup.stdout || '') + (sup.stderr || ''),
          lockHolder: (() => { try { return JSON.parse(fs.readFileSync(r.lock, 'utf-8')).pid; } catch { return null; } })(),
          aPid: pidRec && pidRec.pid, markers: markers(), root: r.root, A: r.A, B: r.B };
        // Leave nothing running or checked out: the pre-fix arm is killed
        // mid-retry ON PURPOSE, so its own cleanup never runs. Each isolated
        // worktree is named after the sha and the pid that made it, so this
        // removes OURS and can never touch another run's (round 2 ④).
        for (const [pid, sha2] of [[out.aPid, r.A], [bPid, r.B]]) {
          if (!pid) continue;
          try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { } }
          try { fs.rmSync(path.join(os.tmpdir(), `vs-ci-heavy-${sha2.slice(0, 8)}-${pid}`), { recursive: true, force: true }); } catch { }
        }
        return out;
      };

      const good = await arm(CI_SRC);
      ok(good.started && /superseded the run for/.test(good.sup), 'the sleeping suite was really running when the newer push superseded it');
      ok(!/retrying once/.test(good.log), '…and the superseded run does NOT re-run the suite our own SIGTERM just killed');
      ok(good.closed && /stopping: /.test(good.log), `…it stops instead, saying why (${(good.log.match(/stopping: [^\n]*/) || ['(never said)'])[0]})`);
      ok(!good.markers.some((f) => new RegExp(`^${good.A}\\.(green|red)$`).test(f)), '…and still claims nothing for the commit it did not finish');
      ok(good.bDone, '…and the MACHINE IS FREED: the superseding run gets the lock and finishes (this is what supersession is for)');
      try { fs.rmSync(good.root, { recursive: true, force: true }); } catch { }

      // NEGATIVE CONTROL: the same fixture against the REAL module with this
      // one guard reverted — it must re-run the killed suite and sit on the
      // lock while the newer run waits, or the assertions above prove nothing.
      const bad = await arm(preFix, 40);  // 2 s: long enough to catch the retry, far short of the 10 s suite
      ok(bad.started, 'NEG: the pre-fix arm reached the same starting point');
      ok(/retrying once/.test(bad.log), 'NEG: without the guard the superseded run RETRIES the suite it was killed in');
      ok(!bad.bDone && bad.lockHolder === bad.aPid,
        `NEG: …and holds the machine lock meanwhile, so the newer run waits (holder pid ${bad.lockHolder}, superseded pid ${bad.aPid})`);
      try { fs.rmSync(bad.root, { recursive: true, force: true }); } catch { }
    }

    // (1e) …AND RETRY-ONCE STILL RETRIES. (1d) added a question immediately
    //      before the retry, so the control it needs is the case it must NOT
    //      change: a suite that fails for its OWN reasons, with nobody
    //      superseding anything, must still be re-run — and a pass on the
    //      second try is recorded as FLAKY, which is the entire reason
    //      retry-once exists. Same stub repository, run in the FOREGROUND (no
    //      supersede, no kill), with a suite that fails once and then passes.
    {
      const SLOW = (SUITES.find((x) => x.tier === 'heavy' && x.name !== SLICE) || {}).name;
      // The marker lives OUTSIDE the checkout: --isolate runs the suite in a
      // fresh worktree, so anything written inside it is invisible to the retry.
      const { root, sha } = stubGateRepo('retry', {
        ciSource: fs.readFileSync(path.join(REPO, 'scripts', 'ci.mjs'), 'utf-8'),
        suites: { [SLOW]: `import fs from 'node:fs';\nconst m = process.env.VS_FLAKY_MARKER;\nif (fs.existsSync(m)) { console.log('ALL PASS (1)'); } else { fs.writeFileSync(m, '1'); console.log('1 FAILED (0 passed)'); process.exit(1); }\n` },
      });
      const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'ci.mjs'), '--heavy', '--sha=' + sha, '--isolate',
        '--only=' + SLOW, '--lock=' + path.join(root, 'lock'), '--lock-wait-ms=20000'],
        { cwd: root, encoding: 'utf-8', env: { ...GIT_ENV, VS_FLAKY_MARKER: path.join(root, 'flaky-marker') }, timeout: 120000 });
      const out = (r.stdout || '') + (r.stderr || '');
      ok(/retrying once/.test(out), 'a suite that fails on its OWN is still retried (the guard added in (1d) does not swallow the flaky path)');
      const marker = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'data', 'ci-heavy', `${sha}.green`), 'utf-8')); } catch { return null; } })();
      ok(!!marker && r.status === 0, `…and a pass on the second try is a GREEN verdict, not a red (exit ${r.status})`);
      ok(!!marker && (marker.flaky || []).includes(SLOW), `…recorded as FLAKY, never laundered into a plain green (${marker && JSON.stringify(marker.flaky)})`);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { }
    }

    // (1f) A SUITE THAT CRASHES IS A VERDICT, NOT A SUPERSESSION (round 4).
    //      `killedFromOutside` read ANY signal except our own ETIMEDOUT as
    //      "somebody terminated this run", so a suite dying of a V8 heap-limit
    //      OOM (measured on this box: {status:null, signal:'SIGABRT'}), a
    //      native crash (SIGSEGV) or the kernel OOM killer ({signal:'SIGKILL'})
    //      abandoned the tier AT that suite: every later suite skipped, NO
    //      marker written, and — because `failed` is empty for an abandoned run
    //      — exit 0. The Actions heavy job's only signal IS the exit code
    //      (`--heavy --dirty-ok`, the runner is thrown away), so it showed a
    //      GREEN tick for a tier that crashed and ran nothing after; locally
    //      nothing blocked the next push either.
    //      Driven on a stub REPOSITORY because no real heavy suite can be asked
    //      to abort, and the control arm is the REAL module with exactly the two
    //      guards this round added reverted.
    {
      const heavyNames = SUITES.filter((s) => s.tier === 'heavy' && s.name !== SLICE).map((s) => s.name);
      const [OOM, RED] = heavyNames;
      const CI_SRC = fs.readFileSync(path.join(REPO, 'scripts', 'ci.mjs'), 'utf-8');
      const NARROW = "export const killedFromOutside = (r) => !!(r && r.signal && OUTSIDE_SIGNALS.includes(r.signal) && !(r.error && r.error.code === 'ETIMEDOUT'));";
      const WIDE = "export const killedFromOutside = (r) => !!(r && r.signal && !(r.error && r.error.code === 'ETIMEDOUT'));";
      const ABORT_EXIT = '    if (abandonedWhy) return 4;\n';
      const preFix = CI_SRC.replace(NARROW, WIDE).replace(ABORT_EXIT, '');
      ok(!!OOM && !!RED && CI_SRC.includes(NARROW) && CI_SRC.includes(ABORT_EXIT)
        && preFix !== CI_SRC && !preFix.includes(NARROW) && !preFix.includes(ABORT_EXIT),
        `both round-4 guards are present and the pre-fix control's patch applies (crashing slice: ${OOM}, red slice: ${RED})`);

      // `--only` preserves the ORDER GIVEN, so the crash really is first and
      // "the second suite ran" is a statement about not abandoning the tier.
      const suites = {
        // A V8 heap-limit OOM aborts the process; process.abort() raises the
        // same signal in 3 ms instead of minutes and gigabytes.
        [OOM]: 'process.abort();\n',
        [RED]: "console.log('1 FAILED (0 passed)');\nprocess.exit(1);\n",
      };
      const crashArm = (ciSource) => {
        const s = stubGateRepo('crash', { ciSource, suites });
        const r = spawnSync(process.execPath, [path.join(s.root, 'scripts', 'ci.mjs'), '--heavy', '--sha=' + s.sha, '--isolate',
          '--only=' + OOM + ',' + RED, '--lock=' + s.lock, '--lock-wait-ms=20000'],
          { cwd: s.root, encoding: 'utf-8', env: GIT_ENV, timeout: 180000 });
        const out = (r.stdout || '') + (r.stderr || '');
        const red = s.markers().find((f) => f === `${s.sha}.red`);
        return { status: r.status, out, markers: s.markers(), root: s.root,
          rec: red ? JSON.parse(fs.readFileSync(path.join(s.root, 'data', 'ci-heavy', red), 'utf-8')) : null };
      };

      const crash = crashArm(CI_SRC);
      ok(/SIGABRT/.test(crash.out), `the crashing suite really died on a signal (${(crash.out.match(/✗ [^\n]*SIG[^\n]*/) || ['NO SIGNAL — this leg is vacuous'])[0].trim()})`);
      ok(!!crash.rec, 'a CRASHED suite is a fact about the code under test: the tier writes a RED marker');
      ok(!!crash.rec && crash.rec.failed.includes(OOM) && crash.rec.failed.includes(RED),
        `…naming BOTH — the crash no longer abandons the tier before the next suite runs (${JSON.stringify((crash.rec || {}).failed)})`);
      ok(crash.status === 1, `…and the run exits 1 = RED (got ${crash.status})`);
      try { fs.rmSync(crash.root, { recursive: true, force: true }); } catch { }

      const preCrash = crashArm(preFix);
      ok(!preCrash.markers.some((f) => /\.(green|red)$/.test(f)),
        `NEG: reading ANY signal as "outside" abandons the tier at the crash and writes no verdict (${preCrash.markers.join(' ') || 'no markers'})`);
      ok(/stopping: this run was terminated from outside/.test(preCrash.out) && /ABORTED/.test(preCrash.out),
        'NEG: …it calls a crash a termination and stops there');
      ok(!new RegExp(`✓ ${RED}|✗ ${RED} FAILED`).test(preCrash.out), `NEG: …so ${RED} never runs at all`);
      ok(preCrash.status === 0,
        'NEG: …and it EXITS 0 — the green Actions tick for a tier that crashed and ran nothing (the defect, end to end)');
      try { fs.rmSync(preCrash.root, { recursive: true, force: true }); } catch { }

      // …AND AN ABORTED TIER NEVER EXITS 0, whatever abandoned it. A missing
      // pid file is the supersede signal the launcher sends (it unlinks ours),
      // so pointing --pid-file at a path that does not exist is the production
      // abort with no 16-minute wait attached.
      const abortArm = (ciSource) => {
        const s = stubGateRepo('abort', { ciSource, suites: { [SLICE]: "console.log('ALL PASS (1)');\n" } });
        const r = spawnSync(process.execPath, [path.join(s.root, 'scripts', 'ci.mjs'), '--heavy', '--sha=' + s.sha, '--isolate',
          '--only=' + SLICE, '--lock=' + s.lock, '--lock-wait-ms=20000', '--pid-file=' + path.join(s.root, 'never-written.pid')],
          { cwd: s.root, encoding: 'utf-8', env: GIT_ENV, timeout: 180000 });
        const out = (r.stdout || '') + (r.stderr || '');
        try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { }
        return { status: r.status, out, markers: s.markers() };
      };
      const aborted = abortArm(CI_SRC);
      ok(/HEAVY TIER ABORTED/.test(aborted.out) && !aborted.markers.some((f) => /\.(green|red)$/.test(f)),
        'a superseded run stops, says ABORTED and writes no verdict');
      ok(aborted.status === 4, `…and exits 4 = ABORTED, never 0 (got ${aborted.status}) — Actions cannot show a green tick for it`);
      const preAborted = abortArm(CI_SRC.replace(ABORT_EXIT, ''));
      ok(preAborted.status === 0,
        'NEG: without that one line the same abandoned run exits 0, i.e. reports success for a tier that ran nothing');
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
