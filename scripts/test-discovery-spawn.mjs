#!/usr/bin/env node
// ZERO SPAWNS PER SESSION IN THE LOCAL DISCOVERY SWEEP (2026-09-09, userW's
// pod: every session create and every kill was followed by an 11-17 s
// event-loop block, 27 of 27 over seven days).
//
// THE INVARIANT THIS SUITE IS: one /api/sessions sweep costs AT MOST ONE child
// process — `tmux list-panes`, and only where a tmux binary exists — no matter
// how many claude lock files and live sessions the machine has. Not "few". Not
// "cached". The per-item shapes it replaces (`ps -p <pid> -o ppid=` per lock,
// `pgrep -P <childPid>` per live session) are per-item forks, and a fork is
// paid by the PARENT: it copies the caller's page tables on the calling thread
// (measured on this box: 1.8 ms at 45 MB RSS, 18.8 ms at 543 MB, 67-73 ms at
// 1.5 GB), and `Promise.all` lines N of them up inside ONE tick. 2.242.0 moved
// the WAIT off the loop and left the FORK — this is the other half.
//
// The census PRINTS what it counted, the fixture is a scratch HOME (the real
// ~/.claude is never read), and the NEGATIVE CONTROL is `master`'s own
// session-store.js dropped in beside the real one, which must count ≥ N.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { scratch, scratchHome } from './scratch.mjs';
import { gitEnvFrom } from './git-env.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);

// ── THE ARM: this same file, re-executed with a config in the environment.
//    It must run in its own PROCESS because (a) HOME decides SESSIONS_DIR at
//    require time, (b) PATH decides the tmux lookup and that answer is
//    memoised per process, and (c) the pre-fix control is a DIFFERENT copy of
//    the module under test.
// THE CENSUS ITSELF, installed BEFORE any product module is required. That
// order is load-bearing and it is a trap this suite already fell into: both
// session-store and cli-identity DESTRUCTURE child_process at require time
// (`const { execFile } = require('child_process')`), so a patch installed
// afterwards counts nothing and every "0 spawns" assert under it is vacuous.
const CP = require('node:child_process');
const CENSUS = { counts: new Map(), on: false };
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
  const orig = CP[name];
  CP[name] = function (...args) {
    if (CENSUS.on) {
      const key = `${name}:${String(args[0]).split('/').pop()}`;
      CENSUS.counts.set(key, (CENSUS.counts.get(key) || 0) + 1);
    }
    return orig.apply(this, args);
  };
}
const censusStart = () => { CENSUS.counts.clear(); CENSUS.on = true; };
const censusStop = () => { CENSUS.on = false; let n = 0; for (const v of CENSUS.counts.values()) n += v; return { spawns: n, byCmd: Object.fromEntries(CENSUS.counts) }; };

if (process.env.VS_DISC_ARM) {
  const cfg = JSON.parse(process.env.VS_DISC_ARM);
  const store = require(path.join(REPO, cfg.impl));
  const activeSessions = new Map();
  for (const s of cfg.sessions) activeSessions.set(s.id, { claudeSessionId: s.sid, _childPid: s.pid });
  censusStart();
  const t0 = process.hrtime.bigint();
  const sessions = await store.discoverClaudeSessions({ activeSessions, webuiPids: new Set() });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const tally = censusStop();
  process.stdout.write(JSON.stringify({
    ...tally, sessions: sessions.length, ms: +ms.toFixed(1),
    running: sessions.filter((s) => s.status !== 'stopped').length,
  }));
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.error('  ✗ ' + n + (extra ? ' — ' + JSON.stringify(extra) : '')); }
};

// ── §0 the pre-fix copy lives BESIDE the real module (relative requires) and
//    can therefore dirty the tree, which is what the release gate refuses on.
//    Two protections, as a pair: a .gitignore stanza and a PID sweep that only
//    removes copies whose owner is GONE (this suite can legitimately run twice
//    in one worktree, and deleting a LIVE run's module is worse than litter).
const MUT_PREFIX = '.session-store.spawnfix-';
const mutPath = (pid) => path.join(REPO, 'src', `${MUT_PREFIX}${pid}.js`);
{
  const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  ok(gi.includes(`src/${MUT_PREFIX}*.js`), `.gitignore covers src/${MUT_PREFIX}*.js (a SIGKILL must never leave a tracked file)`);
  const swept = [], spared = [];
  for (const f of fs.readdirSync(path.join(REPO, 'src'))) {
    if (!f.startsWith(MUT_PREFIX) || !f.endsWith('.js')) continue;
    const pid = Number(f.slice(MUT_PREFIX.length, -3));
    let alive = false; try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive && pid !== process.pid) { spared.push(f); continue; }
    try { fs.unlinkSync(path.join(REPO, 'src', f)); swept.push(f); } catch { }
  }
  ok(true, `stale pre-fix copies swept by PID liveness (swept ${swept.length}, spared-because-live ${spared.length})`);
}
process.on('exit', () => { try { fs.unlinkSync(mutPath(process.pid)); } catch { } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { fs.unlinkSync(mutPath(process.pid)); } catch { } process.exit(1); });

const ident = require(path.join(REPO, 'src/cli-identity.js'));

// ── THE MEASUREMENT NEEDS A PROCFS, AND SAYING SO IS NOT A VERDICT. Every
//    number below is about the rung that replaced a fork with a /proc read; on
//    a machine with no procfs the sweep legitimately keeps ONE `ps -eo` table
//    plus the `ps -o comm=` rung for locks with no procStart, so asserting the
//    Linux bounds there would be a red gate over a platform difference we
//    deliberately shipped. Skip LOUDLY with the reason (the repo's rule) rather
//    than pretend a green.
if (!ident.hasProcfs()) {
  ok(true, 'SKIPPED — this machine has no procfs, so the /proc rungs and the zero-spawn bound they buy cannot be measured here (the no-/proc rungs keep ONE `ps -eo` per sweep by design)');
  console.log(`\nALL PASS (${pass}) — 1 skipped with a reason`);
  process.exit(0);
}

// ── §1 THE PROCESS-TREE READS (the /proc rungs, on live pids of our own)
const kids = [];
{
  const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  kids.push(child);
  await new Promise((r) => setTimeout(r, 120));
  ok(ident.hasProcfs() === true, 'this box has a procfs (the rung under test)');
  ok(ident.readPpid(child.pid) === process.pid,
    `readPpid names the real parent (${ident.readPpid(child.pid)} === ${process.pid})`);
  const mine = ident.readChildPids(process.pid);
  ok(mine.includes(child.pid), `readChildPids lists a live child (${JSON.stringify(mine)})`);
  ok(ident.readChildPids(child.pid).length === 0, 'a childless pid answers with an EMPTY list, not a guess');
  ok(ident.readPpid(0) === null && ident.readPpid(-1) === null && ident.readChildPids(0).length === 0,
    'a nonsense pid is refused without touching anything');
}

// ── §1b the /proc/<pid>/stat PARSE. `comm` may contain spaces AND parens, so
//    the fields are counted from the LAST ')'. Driven over a re-rooted procfs
//    because this box cannot be asked to run a process called `x) (y`.
{
  const root = scratch('disc-proc-parse');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'self'), { recursive: true });
  const mk = (pid, comm, ppid) => {
    fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(root, String(pid), 'stat'),
      `${pid} (${comm}) S ${ppid} ${pid} 0 0 -1 4194304 ` + Array.from({ length: 30 }, (_, i) => i).join(' ') + '\n');
  };
  mk(4242, 'sleep', 99);
  mk(4243, 'weird (name) with spaces', 77);
  ident.resetProcTables();
  ok(ident.readPpid(4242, { procRoot: root }) === 99, 'stat parse: ordinary comm');
  ok(ident.readPpid(4243, { procRoot: root }) === 77,
    `stat parse: comm with spaces AND parens (${ident.readPpid(4243, { procRoot: root })} === 77)`);
  // NEGATIVE CONTROL: the naive "split on spaces, field 4" reading of the same
  // bytes gets the SECOND one wrong, which is why the rule is written down.
  const naive = fs.readFileSync(path.join(root, '4243', 'stat'), 'utf8').split(' ')[3];
  ok(naive !== '77', `NEGATIVE CONTROL: a naive field-4 split reads ${JSON.stringify(naive)}, not 77`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── §2 THE NO-/proc RUNG, DRIVEN (the r5 lesson: a rung no test can reach is
//    prose). A procRoot with no `self` is a machine with no procfs; the table
//    must then come from EXACTLY ONE `ps -eo pid=,ppid=` for the whole sweep,
//    however many pids are asked about.
{
  const root = scratch('disc-noproc');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });   // exists, but has no `self` ⇒ no procfs
  let execs = 0, lastArgs = null;
  const execImpl = (cmd, args) => {
    execs++; lastArgs = [cmd, ...args];
    return '  100 1\n  200 100\n  201 100\n  300 200\n';
  };
  ident.resetProcTables();
  const opts = { procRoot: root, execImpl };
  ok(ident.hasProcfs(root) === false, 'a root with no `self` reads as NO procfs (the rung is reachable)');
  const answers = [ident.readPpid(200, opts), ident.readPpid(300, opts), ident.readPpid(100, opts)];
  const children = [ident.readChildPids(100, opts).sort(), ident.readChildPids(200, opts)];
  ok(JSON.stringify(answers) === JSON.stringify([100, 200, 1]), `no-/proc readPpid answers from the table (${JSON.stringify(answers)})`);
  ok(JSON.stringify(children) === JSON.stringify([[200, 201], [300]]), `no-/proc readChildPids answers from the table (${JSON.stringify(children)})`);
  ok(execs === 1, `ONE \`ps\` for FIVE questions (execs=${execs}) — never one exec per pid`);
  ok(JSON.stringify(lastArgs) === JSON.stringify(['ps', '-eo', 'pid=,ppid=']),
    `and it is the whole-table form (${JSON.stringify(lastArgs)})`);
  // an unanswerable `ps` is NO EVIDENCE, never "gone" (the §17 value-read rule)
  ident.resetProcTables();
  const boom = { procRoot: root, execImpl: () => { throw new Error('ps: not found'); } };
  ok(ident.readPpid(200, boom) === null && ident.readChildPids(100, boom).length === 0,
    'an unanswerable `ps` yields null/[] = no evidence (it never claims a pid is gone)');
  ident.resetProcTables();
  fs.rmSync(root, { recursive: true, force: true });
}

// ── §3 THE CENSUS. N=50 locks + N=50 live sessions in a scratch HOME, the real
//    discoverClaudeSessions, every child_process entry point counted.
const N = 50;          // locks that carry a numeric procStart (the Linux shape)
const NO_PS = 5;       // …and locks that do NOT (macOS, or a pid that raced its own exit)
const TOTAL = N + NO_PS;
const HOME = scratchHome('disc-spawn', fs);
const sessionsDir = path.join(HOME, '.claude', 'sessions');
const armSessions = [];
{
  const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
  for (let i = 0; i < N; i++) {
    const k = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    kids.push(k);
    const sid = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
    fs.writeFileSync(path.join(sessionsDir, `${k.pid}.json`), JSON.stringify({
      pid: k.pid, sessionId: sid, cwd: path.join(HOME, 'proj' + i), procStart: procStart(k.pid),
    }));
    armSessions.push({ id: 'sess-' + i, sid, pid: k.pid });
  }
  // …plus NO_PS locks that carry NO numeric procStart — the shape macOS writes,
  // and the shape a pid that exited between `isPidAlive` and the stat leaves on
  // Linux too. That is the rung `isLockClaude` used to buy with a `ps -o comm=`
  // PER LOCK; it now asks THE identity, which on a procfs machine is file reads.
  // The pid must therefore really PRESENT as claude (argv[0] basename), so the
  // fixture is a real binary copied under that name — the same reason
  // test-local-discovery-device stopped using a shell script for it.
  // A COPY OF /bin/sh, not of /bin/sleep: `sleep` can be a uutils multi-call
  // binary that DISPATCHES ON argv[0] and exits 1 when renamed (measured here
  // — the first draft of this leg silently had five dead pids). `sh -c 'read x'
  // blocks on an empty stdin pipe and needs no child of its own.
  const fakeClaude = path.join(HOME, 'claude');
  fs.copyFileSync(fs.realpathSync('/bin/sh'), fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  for (let i = 0; i < NO_PS; i++) {
    const k = spawn(fakeClaude, ['-c', 'read x'], { stdio: ['pipe', 'ignore', 'ignore'] });
    kids.push(k);
    const sid = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
    fs.writeFileSync(path.join(sessionsDir, `${k.pid}.json`), JSON.stringify({
      pid: k.pid, sessionId: sid, cwd: path.join(HOME, 'nops' + i),   // NO procStart on purpose
    }));
  }
}
const cleanup = () => {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
};
process.on('exit', cleanup);

const noTmuxDir = scratch('disc-spawn-nopath');
fs.mkdirSync(noTmuxDir, { recursive: true });
process.on('exit', () => { try { fs.rmSync(noTmuxDir, { recursive: true, force: true }); } catch { } });

function runArm(impl, { noTmux = false } = {}) {
  const env = {
    ...process.env, HOME,
    VS_DISC_ARM: JSON.stringify({ impl, sessions: armSessions }),
  };
  if (noTmux) env.PATH = noTmuxDir;
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname], { env, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { error: `arm exited ${r.status}: ${(r.stderr || '').slice(-400)}` };
  try { return JSON.parse(r.stdout); } catch { return { error: `unparseable arm output: ${(r.stdout || '').slice(0, 200)}` }; }
}

const hasTmux = !!require(path.join(REPO, 'src/session-store.js')).tmuxOnPath();
{
  const withPath = runArm('src/session-store.js');
  console.log(`  · sweep WITH this box's PATH (tmux ${hasTmux ? 'present' : 'absent'}): ${JSON.stringify(withPath)}`);
  ok(!withPath.error, `the arm ran (${withPath.error || 'ok'})`);
  // POSITIVE CONTROL FIRST: a zero that comes from doing no work proves nothing.
  ok(withPath.sessions === TOTAL, `the sweep really discovered all ${TOTAL} locks — ${N} with procStart + ${NO_PS} without (${withPath.sessions})`);
  ok(withPath.running === TOTAL, `and it verified EVERY one as RUNNING (${withPath.running}) — both identity rungs really ran`);
  ok(withPath.spawns <= 1, `≤ 1 child process for ${TOTAL} locks + ${N} live sessions (${withPath.spawns}: ${JSON.stringify(withPath.byCmd)})`);
  if (hasTmux) ok(Object.keys(withPath.byCmd).every((k) => k.endsWith(':tmux')), 'the only survivor is `tmux list-panes` (ONE per sweep)');

  const noTmux = runArm('src/session-store.js', { noTmux: true });
  console.log(`  · sweep with a PATH that has NO tmux: ${JSON.stringify(noTmux)}`);
  ok(!noTmux.error, `the no-tmux arm ran (${noTmux.error || 'ok'})`);
  ok(noTmux.sessions === TOTAL, `the no-tmux sweep still discovered all ${TOTAL} locks (${noTmux.sessions})`);
  ok(noTmux.spawns === 0, `ZERO child processes when no tmux binary exists (${noTmux.spawns}: ${JSON.stringify(noTmux.byCmd)})`);
}

// ── §4 NEGATIVE CONTROL: `master`'s own session-store, beside the real one.
//    Without it, "0 spawns" could just mean the fixture never reaches the code.
{
  const git = spawnSync('git', ['show', 'master:src/session-store.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: gitEnvFrom(process.env) });
  if (git.status !== 0 || !git.stdout) {
    ok(true, `NEGATIVE CONTROL SKIPPED — \`git show master:src/session-store.js\` is unavailable here: ${(git.stderr || git.error?.message || 'no output').trim().slice(0, 160)}`);
  } else {
    const pre = git.stdout;
    // the control must really BE the retired shape, or it controls nothing
    ok(/pgrep/.test(pre) && /'ps', \['-p', String\(pid\), '-o', 'ppid='\]/.test(pre),
      'the control copy really carries the retired per-item shapes (`pgrep -P`, `ps -p -o ppid=`)');
    fs.writeFileSync(mutPath(process.pid), pre);
    // …with this box's NORMAL PATH, on purpose: master's identity rung for a
    // lock without procStart IS a `ps`, so an emptied PATH would make it fail
    // for a reason that has nothing to do with forks and the two arms would no
    // longer differ in ONE variable (measured: 50 of 55 locks vanish).
    const preRun = runArm(`src/${MUT_PREFIX}${process.pid}.js`);
    console.log(`  · PRE-FIX sweep, same fixture, same PATH: ${JSON.stringify(preRun)}`);
    ok(!preRun.error, `the control arm ran (${preRun.error || 'ok'})`);
    ok(preRun.sessions === TOTAL, `the control discovered the same ${TOTAL} locks (${preRun.sessions}) — same fixture, one variable`);
    ok(preRun.spawns >= TOTAL, `PRE-FIX: ${preRun.spawns} child processes for ${TOTAL} locks (${JSON.stringify(preRun.byCmd)}) — the defect reproduces`);
    fs.unlinkSync(mutPath(process.pid));
  }
}

// ── §5 WIRING PINS — the two decisions that make the numbers above possible,
//    asserted where they are made rather than inferred from a total.
{
  const store = require(path.join(REPO, 'src/session-store.js'));
  censusStart();
  const t = await store.findTmuxTargetAsync(process.pid, new Map());
  const filled = new Map([[process.pid, 'x:0.0']]);
  const named = await store.findTmuxTargetAsync(process.pid, filled);
  const kid = kids[0];
  const viaParent = await store.findTmuxTargetAsync(kid.pid, new Map([[process.pid, 'y:1.2']]));
  const tally = censusStop();
  ok(t === null, 'an EMPTY pane map answers null — the shape on every machine without tmux');
  ok(named === 'x:0.0', 'a pane map that names the pid still answers (the lookup is not simply disabled)');
  ok(viaParent === 'y:1.2', 'and the PARENT lookup still works — read from /proc, not bought with a `ps`');
  ok(tally.spawns === 0, `none of the three pane lookups spawned anything (${JSON.stringify(tally)}) — the third one is the load-bearing case: master bought that parent with a \`ps\` per lock`);

  const src = fs.readFileSync(path.join(REPO, 'src/session-store.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/pgrep/.test(code), 'no `pgrep` survives in session-store code');
  ok(!/_childPidCache/.test(code), 'the 15s per-childPid cache is gone with the fork it existed to blunt');
  ok(!/'ppid='/.test(code), 'no per-pid `ps -o ppid=` survives in session-store code');
  ok(/readChildPids\(/.test(code) && /readPpid\(/.test(code), 'session-store asks THE process reader (src/cli-identity.js) for both facts');
}

// ── §6 the PATH lookup itself must not spawn (a `which` would be one more fork
//    per sweep on exactly the machines this fix is for).
{
  const store = require(path.join(REPO, 'src/session-store.js'));
  censusStart();
  const answer = store.tmuxOnPath();
  const tally = censusStop();
  ok(tally.spawns === 0, `tmuxOnPath() stats PATH entries and spawns nothing (${JSON.stringify(tally)}, answer=${JSON.stringify(answer)})`);
}

// ── §7 THE CENSUS CAN SEE. An installer that patches child_process AFTER the
//     module under test destructured it counts ZERO forever, and every assert
//     above would be theatre — so prove the instrument works on a KNOWN spawn.
{
  censusStart();
  CP.spawnSync('/bin/true', [], { stdio: 'ignore' });   // through the PATCHED module object
  const t1 = censusStop();
  ok(t1.spawns === 1, `POSITIVE CONTROL: the census counts a real spawn (${JSON.stringify(t1)})`);
  // …and its mirror image, stated because it bit while this suite was written:
  // an ESM `import { spawnSync }` is bound at LINK time, so this file's own
  // arm/git spawns are invisible to the census. That is the same binding rule
  // the product modules follow with their CJS destructure, which is exactly
  // why the installer above has to be hoisted over every require.
  censusStart();
  spawnSync('/bin/true', [], { stdio: 'ignore' });
  const t1b = censusStop();
  ok(t1b.spawns === 0, `and an ESM-bound spawnSync is NOT counted (${JSON.stringify(t1b)}) — the binding rule that makes the hoist load-bearing`);
  const store = require(path.join(REPO, 'src/session-store.js'));
  censusStart();
  // isProcessClaudeAsync is the module's own `ps` caller, reached through the
  // destructured reference the trap is about — if the patch were installed too
  // late this would read 0 and so would everything above it.
  await store.isProcessClaudeAsync(process.pid);
  const t2 = censusStop();
  ok(t2.spawns === 1 && Object.keys(t2.byCmd)[0].endsWith(':ps'),
    `POSITIVE CONTROL: the census sees session-store's OWN destructured exec (${JSON.stringify(t2)})`);
}

cleanup();
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
