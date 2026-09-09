#!/usr/bin/env node
// R5 step 2 — the discovery fact-line INTERPRETATION is ONE shared function
// (discovery-facts.interpretDiscoveryLines), so the device can compute its
// own claims (discovery.v2) with the byte-identical logic the server ran
// centrally. This pins the extraction: a golden fixture of LOCK/J/H/N/T/C/HC/K
// lines → the exact session-card set, covering the claim algorithm's tricky
// cases (resumed session via tail-id, N-parallel-in-one-cwd, lock-with-no-
// jsonl, stopped transcript, codex rollout, keeper adoption).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { interpretDiscoveryLines, pidLooksClaude, listOpenCodexRolloutPaths, listOpenRolloutPathsViaLsof, isCliProcess, LSOF_BUDGET_MS } = require(REPO + '/src/discovery-facts.js');
const { cliIdentityShellFns } = require(REPO + '/src/cli-identity.js');
const { claimJsonls } = require(REPO + '/src/session-store.js');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? '\n    ' + e : '')); } };

const run = (lines) => interpretDiscoveryLines(lines.join('\n'), { hostId: 'host-x', hostName: 'BoxX', claimJsonls });

// ── case 1: a running lock over its own transcript (exact-id claim) ──
{
  const proj = '/HOME/.claude/projects/-home-u-proj';
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const s = run([
    `LOCK {"pid":1001,"sessionId":"${A}","cwd":"/home/u/proj","startedAt":1700000000}`,
    `J 1700000100.5 5000 ${proj}/${A}.jsonl`,
    `H ${proj}/${A}.jsonl\t"cwd":"/home/u/proj"`,
    `N ${proj}/${A}.jsonl\t{"type":"user","message":{"role":"user","content":"first real question"}}`,
    `T ${proj}/${A}.jsonl\t${A},`,
  ]);
  ok(s.length === 1 && s[0].sessionId === A && s[0].status === 'remote-running' && s[0].pid === 1001, 'running lock → one running card with pid');
  ok(s[0].host === 'host-x' && s[0].hostName === 'BoxX', 'host descriptor injected as parameters');
}

// ── case 2: a RESUMED session — lock id ≠ filename, current id in the tail ──
{
  const proj = '/HOME/.claude/projects/-home-u-work';
  const ORIG = 'bbbbbbbb-1111-2222-3333-444444444444';
  const CUR = 'cccccccc-9999-8888-7777-666666666666';
  const s = run([
    `LOCK {"pid":2002,"sessionId":"${CUR}","cwd":"/home/u/work","startedAt":1700000000}`,
    `J 1700000200 8000 ${proj}/${ORIG}.jsonl`, // filename keeps the ORIGINAL id
    `T ${proj}/${ORIG}.jsonl\t${ORIG},${CUR},`, // tail carries the current writer last
  ]);
  ok(s.length === 1 && s[0].sessionId === ORIG && s[0].status === 'remote-running', 'resumed session claims its ORIGINAL-named transcript via the tail id (not stolen, not doubled)');
}

// ── case 3: two parallel sessions in ONE cwd — no mtime mis-attribution ──
{
  const proj = '/HOME/.claude/projects/-home-u-multi';
  const P = 'dddddddd-0000-0000-0000-000000000001';
  const Q = 'eeeeeeee-0000-0000-0000-000000000002';
  const s = run([
    `LOCK {"pid":3003,"sessionId":"${P}","cwd":"/home/u/multi","startedAt":1700000000}`,
    `LOCK {"pid":3004,"sessionId":"${Q}","cwd":"/home/u/multi","startedAt":1700000000}`,
    `J 1700000300 100 ${proj}/${P}.jsonl`,
    `J 1700000400 100 ${proj}/${Q}.jsonl`,
    `T ${proj}/${P}.jsonl\t${P},`,
    `T ${proj}/${Q}.jsonl\t${Q},`,
  ]);
  const ids = s.map((x) => x.sessionId).sort();
  ok(s.length === 2 && ids[0] === P && ids[1] === Q && s.every((x) => x.status === 'remote-running'), 'two locks in one cwd each claim their OWN transcript (the N-parallel incident)');
}

// ── case 4: a lock with no flushed transcript yet → listed by its own id ──
{
  const F = 'ffffffff-0000-0000-0000-000000000003';
  const s = run([`LOCK {"pid":4004,"sessionId":"${F}","cwd":"/home/u/fresh","startedAt":1700000500}`]);
  ok(s.length === 1 && s[0].sessionId === F && s[0].status === 'remote-running' && s[0].cwd === '/home/u/fresh', 'brand-new lock with no jsonl → listed by its own id (never dropped/stealing)');
}

// ── case 5: a stopped transcript (no lock) → resumable STOPPED card + name ──
{
  const proj = '/HOME/.claude/projects/-home-u-old';
  const S = '99999999-0000-0000-0000-000000000004';
  const s = run([
    `J 1699999999 3000 ${proj}/${S}.jsonl`,
    `H ${proj}/${S}.jsonl\t"cwd":"/home/u/old"`,
    `N ${proj}/${S}.jsonl\t{"type":"user","message":{"role":"user","content":"an old session about migrations"}}`,
  ]);
  ok(s.length === 1 && s[0].sessionId === S && s[0].status === 'remote-stopped' && s[0].cwd === '/home/u/old', 'unclaimed transcript → stopped card with cwd');
  ok(s[0].name === 'an old session about migrations', 'name taken from the first real user message (shared naming rule)');
}

// ── case 6: codex rollout → resumable stopped codex card ──
{
  const T = '11111111-2222-3333-4444-555555555555';
  const rp = `/HOME/.codex/sessions/2026/08/11/rollout-2026-08-11T00-00-00-${T}.jsonl`;
  const s = run([
    `C 1700001000 4000 ${rp}`,
    `HC ${rp}\t"cwd":"/home/u/cx"`,
  ]);
  ok(s.length === 1 && s[0].sessionId === T && s[0].backend === 'codex' && s[0].status === 'remote-stopped' && s[0].cwd === '/home/u/cx', 'codex rollout → resumable stopped codex card');
}

// ── case 7: keeper meta adopts a running session (keeperSid on the card) ──
{
  const proj = '/HOME/.claude/projects/-home-u-keep';
  const K = '22222222-3333-4444-5555-666666666666';
  const s = run([
    `LOCK {"pid":5005,"sessionId":"${K}","cwd":"/home/u/keep","startedAt":1700002000}`,
    `J 1700002100 200 ${proj}/${K}.jsonl`,
    `T ${proj}/${K}.jsonl\t${K},`,
    `K sess-9\t{"claudeSessionId":"${K}","childPid":5006}`,
  ]);
  ok(s.length === 1 && s[0].keeperSid === 'sess-9', 'a live keeper meta attaches its sid to the running card (reattach-not-respawn)');
}

// ── 8. THE PROCESS-IDENTITY TWIN (B-3185 r3) ──────────────────────────────
// Discovery does not only interpret LINES; it also answers "is this pid the
// agent CLI" — for the lock scan's PID-reuse guard (pidLooksClaude, the device
// snapshot's liveness label) and for the codex CO lines (an open rollout fd IS
// the running thread). The writer sweep asks that same question in POSIX shell
// on this machine, on ssh hosts and on dialed devices, and B-3185 replaced the
// substring rule with an EXECUTABLE test THERE while this side kept
// `cmdline.includes('claude')` for two more rounds. One rule now
// (src/cli-identity.js); this section drives the JS spelling and the shell
// spelling over the same live processes and demands the same verdict.
if (fs.existsSync('/proc/self')) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ident-'));
  const proj = path.join(home, '.claude', 'projects', '-w');
  fs.mkdirSync(proj, { recursive: true });
  const jsonl = path.join(proj, 'ident-rid.jsonl');
  fs.writeFileSync(jsonl, '{}\n');
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '06');
  fs.mkdirSync(codexDir, { recursive: true });
  const rollout = path.join(codexDir, 'rollout-2026-09-06T10-00-00-11111111-2222-4333-8444-555555555555.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const claudeBin = path.join(home, 'bin', 'claude');
  const codexBin = path.join(home, 'bin', 'codex');
  fs.symlinkSync(process.execPath, claudeBin);
  fs.symlinkSync(process.execPath, codexBin);
  // The fixtures live until the suite KILLS them (line ~312), not for a fixed
  // 60 s: `lsof +D` walks every process's fd table and measured 11.8 s per call
  // on this box (~3,900 processes), and the suite runs it six times — the
  // fixtures were dead before the parity matrix ran (2.369.76 push: three
  // asserts red, "exactly the two real CLIs answer YES" saw every row false).
  // 10 min is a backstop against a crashed suite, never the lifetime.
  const idle = 'setTimeout(() => {}, 600000)';
  // holds `file` on fd 0, so an INHERITED-fd shape is reproducible too
  const holder = (cmd, file, argvTail = []) => {
    const fd = fs.openSync(file, 'r');
    const p = spawn(cmd, ['-e', idle, ...argvTail], { stdio: [fd, 'ignore', 'ignore'] });
    fs.closeSync(fd);
    return p;
  };
  const realClaude = holder(claudeBin, jsonl);
  const realCodex = holder(codexBin, rollout);
  // the shapes the retired rule called "the CLI": a reader, and a wrapper /
  // dtach master that carries the CLI's path as ARGUMENTS while holding an
  // inherited transcript fd
  const readerTail = spawn('tail', ['-f', jsonl], { stdio: 'ignore' });
  const wrapper = holder(process.execPath, rollout, [codexBin, 'resume', '11111111-2222-4333-8444-555555555555', claudeBin]);
  // …and the shape that only the NO-/proc rung can be fooled by: a process
  // whose NAME merely contains `codex`. lsof's COMMAND field is `comm` — the
  // exec'd file's name, truncated, and prctl-settable by the process itself —
  // so the retired `/codex/.test(cmd)` substring said YES to a keeper, a
  // renamed dtach master, `codexd`, anything. A COPY of /bin/sh (not a symlink:
  // node renames its own comm, and /bin/sleep may be a multi-call binary that
  // dispatches on argv[0]); it blocks on an empty stdin pipe, so no child.
  const keeperBin = path.join(home, 'bin', 'codex-keeper');
  fs.copyFileSync(fs.realpathSync('/bin/sh'), keeperBin);
  fs.chmodSync(keeperBin, 0o755);
  const keeperFd = fs.openSync(rollout, 'r');
  const keeper = spawn(keeperBin, ['-c', 'read x'], { stdio: ['pipe', 'ignore', 'ignore', keeperFd] });
  fs.closeSync(keeperFd);
  const holdsIt = (pid, target) => {
    try { return fs.readdirSync(`/proc/${pid}/fd`).some((f) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${f}`) === target; } catch { return false; } }); }
    catch { return false; }
  };
  const t0 = Date.now();
  while (!(holdsIt(realCodex.pid, rollout) && holdsIt(wrapper.pid, rollout) && holdsIt(keeper.pid, rollout) && holdsIt(readerTail.pid, jsonl)) && Date.now() - t0 < 15000) {
    execFileSync('sleep', ['0.05']);
  }

  // wiring — the rule has one home and both sides take it from there
  const facts = fs.readFileSync(REPO + '/src/discovery-facts.js', 'utf8');
  ok(/require\('\.\/cli-identity'\)/.test(facts) && /return isCliProcess\(pid, 'claude'\)/.test(facts),
    'WIRING: discovery-facts takes "is this pid the CLI" from the shared module (pidLooksClaude delegates)');
  ok(/isCliProcess\(pid, 'codex'\)/.test(facts) && !/isCodexCommandLine/.test(facts),
    'WIRING: the open-rollout scan asks the same predicate — the whole-argv codex regex is gone');

  // the PID-reuse guard, functionally
  ok(pidLooksClaude(realClaude.pid) === true,
    'pidLooksClaude: a real `<prefix>/bin/claude` process IS claude (the narrowing did not break detection)');
  ok(holdsIt(readerTail.pid, jsonl) && pidLooksClaude(readerTail.pid) === false,
    '…and a `tail -f <HOME>/.claude/projects/<id>.jsonl` reader is NOT — even though it holds the transcript open');
  const retiredRule = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes('claude'); } catch { return false; } };
  ok(retiredRule(readerTail.pid) === true && retiredRule(wrapper.pid) === true,
    'NEGATIVE CONTROL: the RETIRED rule (`cmdline.includes(\'claude\')`) says YES to BOTH — a recycled lock pid on either would have read as a phantom "running" session');

  // the codex CO lines, functionally
  const open = listOpenCodexRolloutPaths({ sessionsDir: path.join(home, '.codex', 'sessions') });
  ok(open.includes(rollout),
    'listOpenCodexRolloutPaths: a real codex holder of the rollout IS reported (positive control — the scan reached it)');
  ok(holdsIt(wrapper.pid, rollout) && !isCliProcess(wrapper.pid, 'codex'),
    'a wrapper/dtach-master that merely NAMES the codex binary in its arguments — while holding the rollout fd — is not the codex CLI, so a dead thread stops reading RUNNING');

  // ── THE NO-/proc RUNG (r3): the branch no test could reach ────────────────
  // listOpenCodexRolloutPaths has a second body for machines without /proc
  // (macOS/BSD ssh hosts). Being unreachable is how it kept TWO defects the
  // rest of B-3185 had already retired elsewhere:
  //   · the LOOSE identity — it asked lsof's COMMAND field (`/codex/.test(cmd)`
  //     = comm, matched as a substring), while the shell twin has always run
  //     `lsof -t … | vs_is_cli "$pid" codex`;
  //   · `execFileSync`, which THROWS on a non-zero exit — and `lsof +D <dir>`
  //     exits 1 whenever any file under the tree has no open instance, i.e.
  //     almost always. The catch turned that into `[]` = "no codex thread is
  //     running", so the rung could only ever degrade (B-3185's "a path that
  //     always fails is a path that was never written"). A shell never had this
  //     bug because it consumes lsof's STDOUT and ignores its status.
  // lsof exists on Linux too, so the rung is EXPORTED and driven here.
  const haveLsof = (() => { try { execFileSync('sh', ['-c', 'command -v lsof'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!haveLsof) console.log('  · lsof absent — the no-/proc rung legs below are vacuous here');
  const codexRoot = path.join(home, '.codex', 'sessions');
  const viaLsof = haveLsof ? listOpenRolloutPathsViaLsof(codexRoot) : [];
  // An lsof that could not answer inside the product's budget (a loaded box:
  // the 2.369.75 gate ran 74 suites on a 3,900-process machine) is UNKNOWN,
  // marked on the array — not evidence about holders. The legs below are
  // about lsof's ANSWER, so they SKIP with that evidence instead of reading a
  // timeout as "no holders" (the very degrade the product no longer commits).
  const lsofUnknown = !!(viaLsof && viaLsof.unknown);
  if (lsofUnknown) console.log(`  ⚠ SKIP: lsof could not answer within ${LSOF_BUDGET_MS} ms on this box (${viaLsof.unknown}) — the no-/proc rung legs are not evidence this round`);
  // "INSTALLED" IS NOT "ANSWERED" (2026-09-09, found by the fast tier going red
  // on an unrelated branch). Four asserts below already ask `haveLsofAnswer`,
  // but three asked `haveLsof` while still CALLING lsof — so on a busy box the
  // SKIP above announced "the no-/proc rung legs are not evidence this round"
  // and then those three ran anyway: one went RED (the pre-r3 IDENTITY control,
  // which needs lsof to REPORT something) and two passed VACUOUSLY (both assert
  // an EMPTY list, which a timed-out lsof also returns). Measured on this box:
  // 4371 processes, six lsof calls at ~22 s each against a 20 s budget ⇒ the
  // whole fast tier RED; with the budget raised to 180 s for one run, lsof
  // answers, no SKIP is printed, and all three run and pass — so they are live
  // where they can be, and silent where the suite has already said it is blind.
  const haveLsofAnswer = haveLsof && !lsofUnknown;
  ok(!haveLsofAnswer || viaLsof.includes(rollout),
    'the no-/proc rung REACHES the real codex holder (positive control — an empty answer would make every assert below pass)', JSON.stringify(viaLsof));
  ok(!haveLsof || (holdsIt(keeper.pid, rollout) && !isCliProcess(keeper.pid, 'codex')),
    'the `codex-keeper` fixture holds the rollout open and is NOT the codex CLI (the shape the loose rule confuses)');
  // THE MEASURED FACT the status fix rests on: lsof answers correctly on STDOUT
  // and exits non-zero — the product consumes stdout and IGNORES both the exit
  // status and stderr. It deliberately does NOT assert an empty stderr: lsof
  // stats every entry in the mount table during startup (independent of `+D`)
  // and warns to stderr about any it cannot stat — a docker overlayfs mount, a
  // stale NFS handle, an autofs point — none of which is an error signal and
  // none of which the product reads. (A machine with docker overlay mounts made
  // this leg's old `!stderr.trim()` clause a false RED — 2.369.71 gate.)
  const rawLsof = haveLsof ? spawnSync('lsof', ['-Fpn', '+D', codexRoot], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }) : null;
  ok(!haveLsofAnswer || (rawLsof.status !== 0 && rawLsof.stdout.includes(rollout)),
    '`lsof +D` reports the holder CORRECTLY on stdout and still exits non-zero (its status is not an error signal — stderr warnings about unstat-able mounts are ignored, as the product ignores them)',
    JSON.stringify({ status: rawLsof && rawLsof.status, stderrLen: rawLsof && String(rawLsof.stderr || '').length }));
  // …and the product's own reader is PROVEN indifferent to that stderr: it read
  // the same tree correctly above (viaLsof.includes(rollout)) on this very box.
  ok(!haveLsofAnswer || viaLsof.includes(rollout),
    'the product reader (listOpenRolloutPathsViaLsof) returns the holder even when lsof warned on stderr — stderr is not consumed');
  // NEGATIVE CONTROL #1 — the pre-r3 EXIT-STATUS handling with the SHIPPED
  // identity: `execFileSync` throws on that status and the catch eats it.
  const preR3StatusViaLsof = (root) => {
    try {
      const output = execFileSync('lsof', ['-Fpn', '+D', root], { encoding: 'utf-8', timeout: LSOF_BUDGET_MS, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      const set = new Set();
      let cli = false;
      for (const line of output.split('\n')) {
        if (line.startsWith('p')) { cli = isCliProcess(line.slice(1).trim(), 'codex'); continue; }
        if (!cli || !line.startsWith('n')) continue;
        const fp = line.slice(1).trim();
        if (/^rollout-.*\.jsonl(?:\.zst)?$/i.test(path.basename(fp))) set.add(fp);
      }
      return [...set];
    } catch { return []; }
  };
  ok(!haveLsofAnswer || preR3StatusViaLsof(codexRoot).length === 0,
    'NEGATIVE CONTROL: with `execFileSync` (the pre-r3 spelling) the SAME fixtures yield NOTHING — the macOS/BSD codex liveness fact was a degradation path that could only degrade');
  // NEGATIVE CONTROL #2 — the pre-r3 IDENTITY (`-Fpcn`, the `c` line,
  // `/codex/.test(cmd)`) over stdout that IS read, so the two controls isolate
  // one defect each. Driven against a tree the real CLI does not touch, so the
  // verdict is about WHO was credited, not about what was found.
  const preR3IdentityViaLsof = (root) => {
    const r = spawnSync('lsof', ['-Fpcn', '+D', root], { encoding: 'utf-8', timeout: LSOF_BUDGET_MS, maxBuffer: 8 * 1024 * 1024 });
    const set = new Set();
    let cmd = '';
    for (const line of String(r.stdout || '').split('\n')) {
      if (line.startsWith('c')) { cmd = line.slice(1); continue; }
      if (!line.startsWith('n')) continue;
      const fp = line.slice(1).trim();
      if (!/codex/.test(cmd) || !/^rollout-.*\.jsonl(?:\.zst)?$/i.test(path.basename(fp))) continue;
      set.add(fp);
    }
    return [...set];
  };
  const keeperOnlyRoot = path.join(home, 'keeper-only');
  fs.mkdirSync(keeperOnlyRoot, { recursive: true });
  const keeperRollout = path.join(keeperOnlyRoot, 'rollout-2026-09-06T11-00-00-99999999-8888-4777-8666-555555555555.jsonl');
  fs.writeFileSync(keeperRollout, '{}\n');
  const keeperFd2 = fs.openSync(keeperRollout, 'r');
  const keeper2 = spawn(keeperBin, ['-c', 'read x'], { stdio: ['pipe', 'ignore', 'ignore', keeperFd2] });
  fs.closeSync(keeperFd2);
  const t1 = Date.now();
  while (!holdsIt(keeper2.pid, keeperRollout) && Date.now() - t1 < 15000) execFileSync('sleep', ['0.05']);
  ok(!haveLsofAnswer || preR3IdentityViaLsof(keeperOnlyRoot).includes(keeperRollout),
    'NEGATIVE CONTROL: the pre-r3 IDENTITY reports a rollout held ONLY by `codex-keeper` — lsof\'s COMMAND field is a substring test over comm');
  ok(!haveLsofAnswer || listOpenRolloutPathsViaLsof(keeperOnlyRoot).length === 0,
    '…and the shipped rung reports NOTHING for it: the same predicate as /proc and as the shell (a stopped thread stops reading RUNNING on macOS too)',
    JSON.stringify(haveLsof ? listOpenRolloutPathsViaLsof(keeperOnlyRoot) : []));
  ok(!haveLsofAnswer || JSON.stringify([...viaLsof].sort()) === JSON.stringify([...listOpenCodexRolloutPaths({ sessionsDir: codexRoot })].sort()),
    'PARITY: the /proc rung and the no-/proc rung return the SAME set for the same fixtures (the two bodies are one rule)',
    JSON.stringify({ lsof: viaLsof, proc: open }));

  // PARITY with the shell spelling, on the very same pids
  const shellSays = (pid, name) => {
    try { execFileSync('sh', ['-c', `${cliIdentityShellFns()}\nvs_is_cli "$1" ${name}`, 'sh', String(pid)], { timeout: 20000 }); return true; }
    catch { return false; }
  };
  const rows = [];
  for (const [label, pid] of [['real-claude', realClaude.pid], ['real-codex', realCodex.pid], ['reader-tail', readerTail.pid], ['wrapper', wrapper.pid], ['codex-keeper', keeper.pid], ['this-suite', process.pid]]) {
    for (const nm of ['claude', 'codex']) rows.push({ label, nm, js: isCliProcess(pid, nm), sh: shellSays(pid, nm) });
  }
  const bad = rows.filter((r) => r.js !== r.sh);
  ok(bad.length === 0, `PARITY: the discovery (JS) and sweep (shell) spellings agree on all ${rows.length} (pid × CLI name) pairs`, JSON.stringify(bad));
  ok(rows.filter((r) => r.sh).length === 2 && rows.filter((r) => !r.sh).length === 10,
    'the parity matrix is not vacuous: exactly the two real CLIs answer YES on both sides', JSON.stringify(rows.map((r) => [r.label, r.nm, r.sh])));

  for (const p of [realClaude, realCodex, readerTail, wrapper, keeper, keeper2]) { try { p.kill('SIGKILL'); } catch { } }
  fs.rmSync(home, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the process-identity twin'); }

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
