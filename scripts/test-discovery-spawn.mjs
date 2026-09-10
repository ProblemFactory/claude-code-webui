#!/usr/bin/env node
// ZERO SPAWNS PER SESSION ON THE PATHS A POLL, A CREATE OR A KILL RUNS
// (2026-09-09, userW's pod: every session create and every kill was followed by
// an 11-17 s event-loop block, 27 of 27 over seven days).
//
// THE INVARIANT THIS SUITE IS, in two halves:
//   §3-§7  one /api/sessions sweep costs AT MOST ONE child process —
//          `tmux list-panes`, and only where a tmux binary exists — no matter
//          how many claude lock files and live sessions the machine has.
//   §8     `refreshWebuiPids()`, the OTHER reader of "what did this wrapper
//          fork", costs ZERO. It runs IN-BAND on every kill and 3 s after every
//          create, and round 1 fixed the sweep while leaving this twin holding
//          one SYNCHRONOUS `pgrep -P` per live session (r2, the verifier's
//          HIGH: 9.16 s of blocked loop at 61 sessions / 1.5 GB RSS on this
//          box, for the identical 244 pids /proc hands over in 2.3 ms).
//
// Not "few". Not "cached". A fork is paid by the PARENT: it copies the caller's
// page tables on the calling thread (measured here: 1.8 ms at 45 MB RSS,
// 18.8 ms at 543 MB, 67-73 ms at 1.5 GB), `Promise.all` lines N of them up
// inside ONE tick, and a SYNCHRONOUS one additionally waits out the child's own
// runtime (`pgrep` walks a 3,000-process /proc: ~80 ms each). 2.242.0 moved the
// WAIT off the loop and left the FORK — this is the other half.
//
// The census PRINTS what it counted, the fixture is a scratch HOME (the real
// ~/.claude is never read), and each half has `master`'s own copy of the module
// under test as its NEGATIVE CONTROL — the sweep's dropped in beside the real
// one, refreshWebuiPids' sliced out of `git show master:server.js`.
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

// ── §8 THE OTHER READER OF THE SAME FACT (r2, the round-1 verifier's HIGH).
//    Round 1 deleted the per-session `pgrep -P` from the discovery sweep and
//    left its TWIN: `refreshWebuiPids()` in server.js runs ONE **synchronous**
//    `execFileSync('pgrep', ['-P', childPid])` per live session, and it runs
//    IN-BAND on every kill (ws-handler, between `activeSessions.delete` and the
//    broadcast) and 3 s after every create — exactly the two moments the
//    incident reports as an 11-17 s block. Synchronous is strictly worse than
//    the sweep's `execFileP`: the caller pays the fork AND `pgrep`'s own
//    runtime (~80 ms while it walks a 3,000-process /proc), one after another.
//
//    server.js is a bootstrap that cannot be required (it binds a port), so the
//    arms are the SHIPPED FUNCTION TEXT, sliced out and given its free names —
//    the same "drive the published bytes" idiom test-writer-sweep uses for its
//    shell builders. The control is `master`'s copy of that same function.
//
//    VS_WEBUI_RSS_MB inflates this process the way a long-lived server is
//    inflated (mapped AND touched) — the wall-clock numbers in the essay were
//    taken with 1500; the ASSERTS are spawn counts and answer equality, which
//    are RSS-independent, so the default is 0 and the gate stays cheap.
{
  const WEBUI_N = Number(process.env.VS_WEBUI_N || 20);
  const RSS_MB = Number(process.env.VS_WEBUI_RSS_MB || 0);
  const BUFS = scratch('disc-webui-bufs');
  fs.rmSync(BUFS, { recursive: true, force: true });
  fs.mkdirSync(BUFS, { recursive: true });
  process.on('exit', () => { try { fs.rmSync(BUFS, { recursive: true, force: true }); } catch { } });

  // Brace-matched slice of a top-level function declaration. Naive about braces
  // inside strings — asserted sane below, and the arms only run if it parses.
  const sliceFn = (text, name) => {
    const start = text.indexOf(`function ${name}(`);
    if (start < 0) return null;
    let depth = 0;
    for (let i = text.indexOf('{', start); i >= 0 && i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  };
  const headSrc = sliceFn(fs.readFileSync(path.join(REPO, 'server.js'), 'utf8'), 'refreshWebuiPids');
  ok(!!headSrc && /activeSessions/.test(headSrc) && headSrc.endsWith('}'),
    `the shipped refreshWebuiPids() sliced out of server.js (${headSrc ? headSrc.length + ' chars' : 'NOT FOUND'})`);
  ok(!!headSrc && !/pgrep/.test(headSrc) && /readChildPids\(meta\.childPid\)/.test(headSrc),
    'the shipped copy asks THE process reader and carries no `pgrep`');

  // THE FIXTURE: N pty-wrapper stand-ins, each with TWO real children — the
  // "claude forks from the node-pty spawn" shape the function exists to catch.
  // If `sh` did not fork, BOTH arms would agree on a smaller set and every
  // assert under this would be vacuous, so the child count is asserted.
  const webuiSessions = new Map();
  for (let i = 0; i < WEBUI_N; i++) {
    const k = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300 & read x'], { stdio: ['pipe', 'ignore', 'ignore'] });
    kids.push(k);
    const id = `cw-${i}-webui`;
    webuiSessions.set(id, {});
    fs.writeFileSync(path.join(BUFS, id + '.json'), JSON.stringify({ pid: 900000 + i, childPid: k.pid }));
  }
  await new Promise((r) => setTimeout(r, 800));   // let the shells fork
  const realChildren = [...webuiSessions.keys()].reduce((n, id) => {
    const meta = JSON.parse(fs.readFileSync(path.join(BUFS, id + '.json'), 'utf8'));
    return n + ident.readChildPids(meta.childPid).length;
  }, 0);
  ok(realChildren === WEBUI_N * 2,
    `POSITIVE CONTROL: the fixture really forked ${WEBUI_N * 2} grandchildren (${realChildren}) — without them both arms would agree on nothing`);

  let webuiBallast = null;
  if (RSS_MB > 0) {
    webuiBallast = Buffer.allocUnsafe(RSS_MB * 1024 * 1024);
    for (let o = 0; o < webuiBallast.length; o += 4096) webuiBallast[o] = (o & 255);
    // held on a GLOBAL on purpose: V8 collects a block-scoped binding after its
    // last READ, so a `let` whose only remaining mention is `= null` is dead and
    // the RSS this leg exists to simulate evaporates before the arms run
    // (measured: 59 MB where 1554 was asked for).
    globalThis.__vsWebuiBallast = webuiBallast;
  }

  // A slice that will not build is a LOUD red, never a thrown suite: the brace
  // matcher is naive about `{` inside a string, and the day that bites, the
  // gate must say which copy it could not build rather than die at line 1.
  const runRefresher = (src) => {
    if (!src) return { error: 'no function text to run' };
    const set = new Set();
    const sessions = new Map([...webuiSessions.keys()].map((id) => [id, {}]));
    // `execFileSync` is injected as the PATCHED module method — the same object
    // server.js destructures at require time — so the suite's own census is the
    // ONE counter here, and it also sees anything readChildPids might start.
    let fn;
    try {
      const make = new Function('fs', 'path', 'execFileSync', 'readChildPids', 'activeSessions', 'BUFFERS_DIR', 'webuiPids',
        `${src}\nreturn refreshWebuiPids;`);
      fn = make(fs, path, CP.execFileSync, ident.readChildPids, sessions, BUFS, set);
    } catch (e) { return { error: `could not build the sliced function: ${e.message}` }; }
    censusStart();
    const t0 = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const tally = censusStop();
    return { ms: +ms.toFixed(1), spawns: tally.spawns, byCmd: tally.byCmd, set, stamped: [...sessions.values()].filter((s) => s._childPid).length };
  };

  const head = runRefresher(headSrc);
  console.log(`  · refreshWebuiPids, SHIPPED, ${WEBUI_N} live sessions at ${Math.round(process.memoryUsage().rss / 1048576)} MB RSS: ${JSON.stringify(head.error ? head : { ms: head.ms, spawns: head.spawns, pids: head.set.size })}`);
  ok(!head.error, `the shipped copy runs (${head.error || 'ok'})`);
  ok(head.spawns === 0,
    `ZERO child processes for ${WEBUI_N} live sessions (${head.spawns}: ${JSON.stringify(head.byCmd)}) — in-band on every kill, so this is the fork the incident is made of`);
  ok(head.set?.size === WEBUI_N * 4,
    `and it still names every pid: wrapper + 2 children + the meta pid, ${WEBUI_N * 4} of them (${head.set?.size})`);
  ok(head.stamped === WEBUI_N,
    `and it still stamps session._childPid for every session (${head.stamped}/${WEBUI_N}) — the other thing this function is for`);

  // NEGATIVE CONTROL: master's own copy of the SAME function, same fixture, one
  // variable. Without it, "0 spawns" could mean the arm never reached the loop.
  {
    const git = spawnSync('git', ['show', 'master:server.js'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: gitEnvFrom(process.env) });
    if (git.status !== 0 || !git.stdout) {
      ok(true, `NEGATIVE CONTROL SKIPPED — \`git show master:server.js\` is unavailable here: ${(git.stderr || git.error?.message || 'no output').trim().slice(0, 160)}`);
    } else {
      const preSrc = sliceFn(git.stdout, 'refreshWebuiPids');
      ok(!!preSrc && /execFileSync\('pgrep', \['-P'/.test(preSrc),
        'the control copy really carries the retired per-session `pgrep -P` (or it controls nothing)');
      const pre = runRefresher(preSrc);
      console.log(`  · refreshWebuiPids, PRE-FIX, same fixture: ${JSON.stringify(pre.error ? pre : { ms: pre.ms, spawns: pre.spawns, pids: pre.set.size })}`);
      ok(!pre.error, `the control copy runs (${pre.error || 'ok'})`);
      ok(pre.spawns >= WEBUI_N,
        `PRE-FIX: ${pre.spawns} SYNCHRONOUS child processes for ${WEBUI_N} live sessions — the defect reproduces`);
      const same = !!pre.set && !!head.set && pre.set.size === head.set.size && [...pre.set].every((p) => head.set.has(p));
      ok(same,
        `and the two answers are IDENTICAL (${pre.set?.size} === ${head.set?.size} pids) — the fork bought nothing`);
      ok(pre.ms > head.ms,
        `PRE-FIX blocked the loop ${pre.ms} ms where the shipped copy takes ${head.ms} ms (same box, same fixture; ~9.16 s vs 1.6 ms at 61 sessions / 1.5 GB RSS — VS_WEBUI_N=61 VS_WEBUI_RSS_MB=1500)`);
    }
  }
  webuiBallast = null; delete globalThis.__vsWebuiBallast;

  // WIRING PIN: this leg is only worth running because that function is on the
  // create/kill path. If it stops being called, the reason changes and somebody
  // must re-read this section rather than keep a green that means nothing.
  {
    const callers = ['src/ws-handler.js', 'src/ws-create.js', 'src/server/boot-restore.js']
      .filter((f) => /refreshWebuiPids\(\)/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    ok(callers.length >= 3, `refreshWebuiPids is still called from the kill / create / restore paths (${callers.join(', ')})`);
    ok(/activeSessions\.delete\(data\.sessionId\);\s*\n\s*refreshWebuiPids\(\);/.test(fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8')),
      'and the kill case still calls it IN-BAND, before the broadcast — the shape that made a Terminate blank the window for 30 s');
  }
}

// ── §9 THE LAST FORK ON THE KILL PATH (r3, the round-2 verifier's finding).
//    Beside `refreshWebuiPids` the kill case asks a SECOND process-table
//    question — "which dtach process owns this session's socket" — and it asked
//    it with `execFileAsync('pgrep', ['-f', socketPath])`. That is one per kill
//    rather than one per session, so it is not the 11-17 s block; it is the
//    same COST though, and it grows with the server: measured here, the
//    synchronous part of that call (the fork) is 2.9 ms at 78 MB RSS, 25 ms at
//    582 MB and 70.9 ms at 1,587 MB, while a /proc cmdline scan of the same
//    3,075 processes is ~20 ms whatever the server weighs — and end to end 20 ms
//    against `pgrep`'s 83-150 ms. A fleet server IS a 1.5 GB process.
//
//    Why this leg exists AT ALL: the census in test-architecture §45 is a text
//    scan, and round 2's could not see that call because it was spelled through
//    a promisified alias. This half is FILE-BLIND — it counts what the SHIPPED
//    kill-path bytes actually start, wherever they were written.
{
  // The kill case is not a function, so slice its `try` BODY. The anchor is the
  // kill case's OWN comment, not `if (session.socketPath) {` — that spelling
  // also opens the broken-stdin detector 780 lines earlier, and slicing THAT
  // one builds a body full of names this leg does not inject, i.e. a red that
  // says nothing about the fork under test.
  const KILL_ANCHOR = '// Kill the dtach session process (which kills claude as its child)';
  const sliceKillBody = (text) => {
    const a = text.indexOf(KILL_ANCHOR);
    if (a < 0) return null;
    const i = text.indexOf('if (session.socketPath) {', a);
    if (i < 0) return null;
    const t = text.indexOf('try {', i);
    if (t < 0) return null;
    const open = text.indexOf('{', t);
    let depth = 0;
    for (let k = open; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}' && --depth === 0) return text.slice(open + 1, k);
    }
    return null;
  };

  const NEEDLE = path.join(scratch('disc-kill-sock'), 'cw-kill-fixture');  // never a real socket
  const killKids = [];
  for (let i = 0; i < 3; i++) {
    // argv = ['sh','-c','sleep 300', NEEDLE] — the needle is $0, so it is in
    // the command line exactly the way a dtach master carries its socket path.
    const k = spawn('/bin/sh', ['-c', 'sleep 300', NEEDLE], { stdio: 'ignore' });
    killKids.push(k); kids.push(k);
  }
  // WAIT FOR THE CONDITION, NOT FOR A CLOCK: this box hosts ~160 checkouts and
  // a detached heavy tier, so a fixed settle is a gate that goes red for a
  // reason that is not its subject. Poll until the three execs have landed.
  const settleDeadline = Date.now() + 15000;
  let wantPids = [];
  for (;;) {
    wantPids = (await ident.pidsMatchingCmdline(NEEDLE)).sort((a, b) => a - b);
    if (wantPids.length === 3 || Date.now() > settleDeadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(wantPids.length === 3,
    `POSITIVE CONTROL: the fixture really carries the needle in 3 live command lines (${JSON.stringify(wantPids)}) — without them every count below would be a zero from doing no work`);

  // The session's OWN attach pty is excluded by both copies — give it one of
  // the three so the exclusion is exercised rather than assumed.
  const PTY_PID = wantPids[0];
  const expectKilled = wantPids.slice(1);

  const runKill = async (src, label) => {
    if (!src) return { error: `no kill-path body to run (${label})` };
    const killed = [];
    const fakeProcess = { kill: (pid) => { killed.push(pid); } };   // NEVER signals anything
    const execFileAsync = (cmd, args, opts) => new Promise((res, rej) =>
      CP.execFile(cmd, args, opts || {}, (e, out) => (e && !out ? rej(e) : res(out))));
    let fn;
    try {
      fn = new Function('session', 'pidsMatchingCmdline', 'execFileAsync', 'process', 'fs',
        `return (async () => {${src}})();`);
    } catch (e) { return { error: `could not build the sliced body: ${e.message}` }; }
    censusStart();
    const t0 = process.hrtime.bigint();
    try {
      await fn({ socketPath: NEEDLE, pty: { pid: PTY_PID } }, ident.pidsMatchingCmdline, execFileAsync, fakeProcess, fs);
    } catch (e) { censusStop(); return { error: `the sliced body threw: ${e.message}` }; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const tally = censusStop();
    return { ms: +ms.toFixed(1), spawns: tally.spawns, byCmd: tally.byCmd, killed: killed.sort((a, b) => a - b) };
  };

  const shippedSrc = sliceKillBody(fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8'));
  // WHOLE-LINE COMMENTS ARE BLANKED FIRST: the prose above the call NAMES
  // `pgrep -f` on purpose (it says what this replaced and what it cost), and a
  // word-match would fail the fix on the comment that explains it. This is the
  // same rule test-architecture §45 applies — a census reads CODE.
  const codeOnly = (s) => String(s || '').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!!shippedSrc && /pidsMatchingCmdline\(session\.socketPath\)/.test(codeOnly(shippedSrc))
    && !/pgrep/.test(codeOnly(shippedSrc)),
    `the shipped kill-path body asks THE process reader and spawns no \`pgrep\` (${shippedSrc ? shippedSrc.length + ' chars' : 'NOT FOUND'})`);
  const kHead = await runKill(shippedSrc, 'shipped');
  console.log(`  · kill-path socket lookup, SHIPPED: ${JSON.stringify(kHead.error ? kHead : { ms: kHead.ms, spawns: kHead.spawns, killed: kHead.killed })}`);
  ok(!kHead.error, `the shipped copy runs (${kHead.error || 'ok'})`);
  ok(kHead.spawns === 0,
    `ZERO child processes to find the dtach master (${kHead.spawns}: ${JSON.stringify(kHead.byCmd)}) — the last fork on the kill path`);
  ok(JSON.stringify(kHead.killed) === JSON.stringify(expectKilled),
    `and it SIGTERMs exactly the right pids, minus the session's own attach pty (${JSON.stringify(kHead.killed)} === ${JSON.stringify(expectKilled)})`);

  // NEGATIVE CONTROL: master's own bytes, same fixture, one variable.
  {
    const git = spawnSync('git', ['show', 'master:src/ws-handler.js'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: gitEnvFrom(process.env) });
    if (git.status !== 0 || !git.stdout) {
      ok(true, `NEGATIVE CONTROL SKIPPED — \`git show master:src/ws-handler.js\` is unavailable here: ${(git.stderr || git.error?.message || 'no output').trim().slice(0, 160)}`);
    } else {
      const preSrc = sliceKillBody(git.stdout);
      ok(!!preSrc && /execFileAsync\('pgrep', \['-f', session\.socketPath\]/.test(preSrc),
        'the control copy really carries the retired `pgrep -f <socketPath>` (or it controls nothing)');
      const kPre = await runKill(preSrc, 'pre-fix');
      console.log(`  · kill-path socket lookup, PRE-FIX: ${JSON.stringify(kPre.error ? kPre : { ms: kPre.ms, spawns: kPre.spawns, killed: kPre.killed })}`);
      ok(!kPre.error, `the control copy runs (${kPre.error || 'ok'})`);
      ok(kPre.spawns === 1 && Object.keys(kPre.byCmd).some((k) => k.endsWith(':pgrep')),
        `PRE-FIX: ONE child process per kill (${kPre.spawns}: ${JSON.stringify(kPre.byCmd)}) — the fork whose cost grows with the server's RSS`);
      // `undefined === undefined` is not an agreement: name the pids BOTH arms
      // had to find, or this assert passes hardest when neither arm ran.
      ok(Array.isArray(kPre.killed) && kPre.killed.length === expectKilled.length
        && JSON.stringify(kPre.killed) === JSON.stringify(kHead.killed),
        `and the two answers are IDENTICAL (${JSON.stringify(kPre.killed)}) — the fork bought nothing`);
    }
  }

  // The no-/proc rung is ONE `pgrep -f` for the WHOLE question, never one per
  // candidate — driven on Linux by re-rooting procfs, the r5 `vs_argv` lesson.
  {
    censusStart();
    const viaPs = await ident.pidsMatchingCmdline(NEEDLE, { procRoot: path.join(scratch('disc-kill-noproc'), 'nope') });
    const t = censusStop();
    ok(t.spawns === 1 && Object.keys(t.byCmd).some((k) => k.endsWith(':pgrep')),
      `no-/proc rung: ONE \`pgrep -f\` for the whole question (${t.spawns}: ${JSON.stringify(t.byCmd)})`);
    ok(JSON.stringify(viaPs.sort((a, b) => a - b)) === JSON.stringify(wantPids),
      `and it names the SAME pids as the /proc rung (${JSON.stringify(viaPs)})`);
  }
  ident.resetProcTables();
}

cleanup();
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
