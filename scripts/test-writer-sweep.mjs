#!/usr/bin/env node
// ONE writer sweep, any machine (CS separation, 2.276.0).
//
// Before this, the sweep existed three times — ssh, dial, and NOT AT ALL for
// local — so a local resume of a conversation still held by a claude in an
// external terminal had the double-writer risk the remote paths had been
// protected from since B-4058. The asymmetry was not a decision; it is what
// happens when `hostId` is a BRANCH instead of a PARAMETER: whoever fixes the
// remote bug never touches the local twin.
//
// This test drives the SAME sweepWriters() against a fake local device and a
// fake remote device and demands identical behaviour — which is only
// meaningful because there is now one implementation to drive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// HOLDER MODE (r2): the suite file itself, run as a transcript holder. §6 copies
// this file into a `.claude/worktrees/<wt>/scripts/` checkout and runs THE COPY
// both ways the CLI ever runs a suite — by absolute path (the argv shape that
// made the pre-B-3185 guard kill the suite: exit 143, gate red, code fine) and
// RELATIVELY from that checkout (the shape `npm run ci` actually types, which
// carries no `.claude` in argv at all). Both must survive the sweep, whatever
// path THIS run happens to have been started with. It must sit above the
// createRequire below: the copy has no ../src to require.
if (process.env.VS_SWEEP_HOLDER) {
  fs.openSync(process.env.VS_SWEEP_HOLDER, 'r'); // held for the process's life
  if (process.env.VS_SWEEP_READY) fs.writeFileSync(process.env.VS_SWEEP_READY, '1');
  await new Promise((r) => setTimeout(r, 60000));
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { writerSweepScript, sweepWriters, parseSwept, fdScanShellFns, cliIdentityShellFns } = require('../src/writer-sweep.js');

let pass = 0, fail = 0;
const ok = (c, n, diag) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); if (diag) console.error('      ' + JSON.stringify(diag)); } };
const shq = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

// A fake machine: records what it was asked to run and answers with SWEPT lines.
const fakeDevice = (name, { swept = [], fail: shouldFail = false } = {}) => ({
  name, calls: [],
  async runCmd(cmd, args) {
    this.calls.push({ cmd, script: args[1] });
    if (shouldFail) throw new Error('device link lost');
    return { stdout: swept.map((p) => `SWEPT:${p}`).join('\n'), code: 0 };
  },
});

const mkHosts = (dev, { hostRec = null } = {}) => ({
  _dev: dev,
  async deviceBounded() { return dev; },
  get() { if (!hostRec) throw new Error('host not found'); return hostRec; },
  sshArgs() { return ['-p', '22', 'user@h']; },
});

// ── 1. The script itself is machine-agnostic ──
const script = writerSweepScript('rid-abc', shq);
ok(script.includes("RID='rid-abc'"), 'script quotes the conversation id');
ok(script.includes('/proc') && script.includes('lsof'), 'script covers Linux (/proc) AND macOS/BSD (lsof)');
ok(script.includes('.claude/sessions') && script.includes('.vibespace'), 'script sweeps lock files and pipe-session metas');
// Intent, not a count: a sweep is destructive, so NO kill may be silent. (The
// count form broke the moment B-3185 collapsed three copy-pasted kill lines
// into one function — the same assertion, expressed as a fact about the text.)
for (const [name, s] of [['claude', script], ['codex', writerSweepScript('rid-abc', shq, { backend: 'codex' })]]) {
  const kills = s.split('\n').filter((l) => /kill -TERM/.test(l));
  ok(kills.length >= 2 && kills.every((l) => l.includes('SWEPT:')), `${name}: every kill leg reports what it terminated (${kills.length} legs)`);
}
// B-3185: the fd scan is BATCHED — one `ls -l` per 400 fd directories, never a
// fork PER PROCESS. `/proc/[0-9]*` may therefore appear exactly once (inside
// vs_fd_scan) in either script.
// THE PIN MUST BE SATISFIABLE (r2). r1's version — `/ps -p "\$pid" -o args=\S*\) in \*/`
// — matched NEITHER the code it was written against (`\S*` cannot cross the
// space in `args= 2>/dev/null`) NOR the codex twin (which used `$1`), so it was
// a guard that could never fire while the kb advertised it. These three regexes
// are asserted against the EXACT pre-B-3185 lines (git 3b928ca4^ src/writer-sweep.js)
// before they are asserted against the shipped scripts: a drift pin that cannot
// match the drift is not a pin.
const PREFIX_SHAPES = {
  'claude identity': 'case "$(ps -p "$pid" -o args= 2>/dev/null)" in *claude*) kill -TERM "$pid" 2>/dev/null && echo "SWEPT:$pid";; esac',
  'codex identity': '  case "$(ps -p "$1" -o args= 2>/dev/null)" in *codex*) ;; *) return 0;; esac',
  'per-process ls': '    ls -l "$pdir/fd" 2>/dev/null | grep -q "/$RID.jsonl" || continue',
};
const wholeArgvIdentity = /case\s+"\$\(\s*ps\s+-p\s+"?\$\w+"?\s+-o\s+args=[^)]*\)"\s+in\s+\*/;
const perProcessLs = /ls -l "\$\w+\/fd"/;
ok(wholeArgvIdentity.test(PREFIX_SHAPES['claude identity'])
  && wholeArgvIdentity.test(PREFIX_SHAPES['codex identity'])
  && perProcessLs.test(PREFIX_SHAPES['per-process ls']),
  'drift pin is SATISFIABLE: both regexes match the exact pre-B-3185 lines they exist to catch');
// …and the pin is proven ON THE SHIPPED SCRIPT by REINTRODUCING the drift: a
// guard that has never once been seen to go red is a claim, not a guard. The
// splice anchors are asserted too, so a rename cannot quietly make these two
// negative controls vacuous.
const reIdentity = script.replace('vs_claude_kill() {\n', 'vs_claude_kill() {\n  ' + PREFIX_SHAPES['claude identity'] + '\n');
ok(reIdentity !== script && wholeArgvIdentity.test(reIdentity),
  'NEGATIVE CONTROL: splicing the pre-B-3185 whole-argv identity line back into the shipped claude script turns the pin RED');
const reLs = script.replace('vs_fd_scan() {\n', 'vs_fd_scan() {\n' + PREFIX_SHAPES['per-process ls'] + '\n');
ok(reLs !== script && perProcessLs.test(reLs),
  'NEGATIVE CONTROL: splicing the pre-B-3185 per-process `ls` fork back in turns the batching pin RED');
for (const [name, s] of [['claude', script], ['codex', writerSweepScript('rid-abc', shq, { backend: 'codex' })]]) {
  ok((s.match(/\/proc\/\[0-9\]\*/g) || []).length === 1 && s.includes('vs_fd_scan'), `${name}: exactly ONE /proc walk, through the shared batched scan`);
  ok(!perProcessLs.test(s) && !wholeArgvIdentity.test(s), `${name}: no per-process ls fork and no whole-argv substring identity test`);
}

// ── 1b. THE AWK PID ATTRIBUTION (r2, defect 2) — functional, with a negative
// control. `/proc/self/fd` is appended to EVERY chunk on purpose (`ls -l` only
// prints the `<dir>:` headers the attribution reads when it has more than one
// operand) — and it is the fd table of the `ls` PROCESS, which inherits every
// fd of the sweeping shell. The old awk reset `p` only on a header it
// RECOGNISED, so `/proc/self/fd:` left the previous numeric pid in place and
// an INHERITED matching fd (the sweep shell's own redirect, an editor's, the
// caller's) was attributed to whichever pid happened to come last in that
// chunk — and the sweep SIGTERMs on that attribution. The probe below opens
// the target on fd 9 in the shell itself, so `ls` inherits it in every chunk:
// the only honest answer is "the shell holds it", once.
if (fs.existsSync('/proc/self')) {
  const { execFileSync } = await import('node:child_process');
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-awk-'));
  const target = path.join(adir, 'rid-awk.jsonl');
  fs.writeFileSync(target, '{}\n');
  // $1 = the file (no quoting games); $$ names the only process that really has it.
  const probe = (fns) => {
    const out = execFileSync('sh', ['-c', `exec 9< "$1"\necho "SHELL:$$"\n${fns}\nvs_fd_scan '/rid-awk[.]jsonl'\n`, 'sh', target],
      { encoding: 'utf8', timeout: 120000 });
    const shellPid = /SHELL:(\d+)/.exec(out)?.[1] || '';
    const pids = new Set(out.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[0]));
    return { shellPid, pids };
  };
  const fixed = probe(fdScanShellFns());
  // the OLD awk, restored one line at a time — same scan, sticky `p`
  const stickyFns = fdScanShellFns().replace(
    '$0 ~ "^/.*:$" { p = ""; if ($0 ~ "^/proc/[0-9]+/fd:$") p = substr($0, 7, length($0) - 10); next }',
    '$0 ~ "^/proc/[0-9]+/fd:$" { p = substr($0, 7, length($0) - 10); next }');
  ok(stickyFns !== fdScanShellFns(), 'the sticky-`p` negative control really is the shipped awk with only that line reverted');
  const buggy = probe(stickyFns);
  ok(fixed.pids.has(fixed.shellPid), 'awk attribution: the shell that really holds the fd IS found (the control is not vacuous — the scan reached it)');
  ok(fixed.pids.size === 1, 'awk attribution: NOBODY ELSE is named — an fd inherited by `ls` under /proc/self/fd is attributed to no pid at all',
    { named: [...fixed.pids], shell: fixed.shellPid });
  ok(buggy.pids.size > fixed.pids.size && [...buggy.pids].some((x) => x !== buggy.shellPid),
    'NEGATIVE CONTROL: with the pre-fix sticky `p`, the SAME inherited fd is attributed to processes that never had it (one per chunk) — these are the pids the sweep would have SIGTERMed',
    { buggy: [...buggy.pids].slice(0, 8), shell: buggy.shellPid });
  fs.rmSync(adir, { recursive: true, force: true });

  // vs_argv MUST BE SILENT. A machine-wide walk races every exiting process, so
  // `/proc/<pid>/cmdline` routinely disappears between the `[ -r ]` test and the
  // open — and a FAILING REDIRECT is reported by the SHELL, not by `tr`, so
  // silencing `tr` alone left `cannot open /proc/N/cmdline` on stderr of a
  // script whose stderr the callers read. The whole compound is silenced now.
  const { spawnSync } = await import('node:child_process');
  const idFns = cliIdentityShellFns();
  ok(/\{ tr '\\0' '\\n' < "\/proc\/\$1\/cmdline" \| sed[^}]*; \} 2>\/dev\/null/.test(idFns),
    'vs_argv silences the WHOLE cmdline compound, not just `tr` (a failed redirect is a shell-level error)');
  const gone = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
  const r = spawnSync('sh', ['-c', `${idFns}\nvs_argv ${gone} 0; vs_is_cli ${gone} claude`], { encoding: 'utf8', timeout: 20000 });
  ok((r.stderr || '') === '', 'vs_argv/vs_is_cli say NOTHING on stderr for a pid that is not there', { stderr: r.stderr });
} else { console.log('  · /proc absent — skipping the awk attribution leg'); }

// ── 2. LOCAL and REMOTE run the IDENTICAL script ──
const localDev = fakeDevice('local', { swept: ['111'] });
const remoteDev = fakeDevice('remote', { swept: ['222'] });
const rLocal = await sweepWriters(mkHosts(localDev), null, 'rid-abc', { shq });
const rRemote = await sweepWriters(mkHosts(remoteDev, { hostRec: { transport: 'ssh' } }), 'h1', 'rid-abc', { shq });
ok(localDev.calls[0].script === remoteDev.calls[0].script, 'local and remote receive a BYTE-IDENTICAL script (one implementation)');
ok(rLocal.via === 'device' && rRemote.via === 'device', 'both run over the device link — no transport-specific path');
ok(rLocal.swept[0] === '111' && rRemote.swept[0] === '222', 'each machine reports its own swept pids');

// ── 3. A dial machine must NOT fall back to ssh (it has none) ──
let threw = null;
try {
  await sweepWriters(mkHosts(fakeDevice('dial', { fail: true }), { hostRec: { transport: 'dial' } }), 'd1', 'rid-abc',
    { shq, execFileAsync: async () => { throw new Error('ssh must never be attempted for dial'); } });
} catch (e) { threw = e; }
ok(threw && /device link lost/.test(threw.message), 'dial failure surfaces the DEVICE error (no bogus ssh fallback)');

// ── 4. An ssh machine keeps its legacy per-op channel as the fallback ──
let sshUsed = false;
const rFallback = await sweepWriters(mkHosts(fakeDevice('ssh', { fail: true }), { hostRec: { transport: 'ssh' } }), 'h2', 'rid-abc',
  { shq, execFileAsync: async () => { sshUsed = true; return 'SWEPT:333\n'; } });
ok(sshUsed && rFallback.via === 'ssh' && rFallback.swept[0] === '333', 'ssh host falls back to the per-op channel when the device is down');

// ── 5. LOCAL has no second channel — a down daemon must throw, not pretend ──
threw = null;
try { await sweepWriters(mkHosts(fakeDevice('local', { fail: true })), null, 'rid-abc', { shq, execFileAsync: async () => 'SWEPT:999' }); }
catch (e) { threw = e; }
ok(threw, 'local failure throws (caller decides to warn) instead of silently claiming a sweep');

// ── 6. Real script execution against real holder processes on this machine ──
// Proves the fd-scan leg finds a holder AND that "is this the CLI?" is decided
// by the EXECUTABLE, not by a substring of the command line (B-3185).
//
// The old guard substring-matched 'claude' anywhere in `ps -o args=`, so it
// killed anything whose argv merely NAMED a path under ~/.claude —
// `tail -f ~/.claude/projects/<id>.jsonl`, an editor, and (the incident that
// forced the workaround this section used to carry) THIS SUITE, whose own argv
// is an absolute path inside a git worktree under ~/.claude/worktrees/ where
// the worktree-only-smokes law puts every agent: it matched its own guard and
// SIGTERMed itself before the assertion ran — exit 143, gate red, code fine.
// So the suite now HOLDS THE TRANSCRIPT ITSELF as the primary negative control
// (with a SIGTERM trap, so a regression is a red assertion instead of a
// mysterious 143) and the fixtures cover every shape the real CLI ships in.
if (fs.existsSync('/proc/self')) {
  const { execFileSync, spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sweep-'));
  const proj = path.join(dir, '.claude', 'projects', '-w');
  fs.mkdirSync(proj, { recursive: true });
  const jsonl = path.join(proj, 'rid-live.jsonl');
  fs.writeFileSync(jsonl, '{}\n');
  const holderSrc = (readyPath) => `require('fs').openSync(${JSON.stringify(jsonl)}, 'r'); require('fs').writeFileSync(${JSON.stringify(readyPath)}, '1'); setTimeout(() => {}, 60000);`;
  const holders = [];
  const spawnHolder = (name, cmd, args, opts = {}) => {
    const ready = path.join(dir, 'ready-' + name);
    const p = spawn(cmd, args.map((a) => (a === '@SRC@' ? holderSrc(ready) : a)), { cwd: os.tmpdir(), stdio: 'ignore', ...opts });
    holders.push({ name, p, ready });
    return p;
  };
  const mkScript = (rel, ready) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, holderSrc(path.join(dir, 'ready-' + ready))); return f; };

  // WRITERS (must be swept) — the three shapes the CLI actually ships in.
  const nativeBin = path.join(dir, 'bin', 'claude');            // native install / bin shim
  fs.mkdirSync(path.dirname(nativeBin), { recursive: true });
  fs.symlinkSync(process.execPath, nativeBin);
  const wNative = spawnHolder('w-native', nativeBin, ['-e', '@SRC@']);
  const wNpm = spawnHolder('w-npm', process.execPath, [mkScript('node_modules/@anthropic-ai/claude-code/cli.js', 'w-npm')]);
  const shimPath = mkScript('lib/bin/claude', 'w-shim');          // `node <prefix>/bin/claude` (shebang shim)
  const wShim = spawnHolder('w-shim', process.execPath, [shimPath]);

  // READERS (must survive) — every one of them was killed by the old guard.
  const rTail = spawn('tail', ['-f', jsonl], { cwd: os.tmpdir(), stdio: 'ignore' });
  const rWorktree = spawnHolder('r-worktree', process.execPath, [mkScript('.claude/worktrees/wf_x/scripts/suite.js', 'r-worktree')]);
  const rOtherCli = spawnHolder('r-othercli', process.execPath, [mkScript('tools/cli.js', 'r-othercli')]); // a cli.js NOT under a claude package
  const rNeutral = spawnHolder('r-neutral', process.execPath, ['-e', '@SRC@']);
  // RUNG 3 — ONE IMAGE, THREE PRESENTATIONS (r2, defect 4). The native install's
  // image IS the version FILE (`~/.local/share/claude/versions/2.1.257`), so its
  // basename is a version number and the rung has to accept the install
  // DIRECTORY. But the CLI RE-EXECS THAT SAME IMAGE as its bundled helper tools:
  // measured live on this box, 18–19 processes have an exe under
  // `…/.local/share/claude/versions/<ver>` and 2–3 of them are
  // `ugrep -G --ignore-files …` with argv[0] a bare `ugrep`. r1's rung said
  // "anything running out of versions/ is the CLI", so a search helper that
  // inherited its parent's transcript fd was a SIGTERM target — a WIDENING
  // smuggled into a narrowing fix, and untested. All three fixtures run THE SAME
  // binary and differ ONLY in argv[0], which is the whole point: `exe` cannot
  // separate them, the presentation can. The binary is a COPY of /bin/sh — a
  // symlink would resolve /proc/<pid>/exe back to the real interpreter and test
  // nothing — and each holds the transcript on fd 3 while blocking on an empty
  // pipe (no child, so a swept fixture leaves nothing behind).
  const versDir = path.join(dir, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versDir, { recursive: true });
  const versImg = path.join(versDir, '2.1.257');
  fs.copyFileSync(fs.realpathSync('/bin/sh'), versImg);
  fs.chmodSync(versImg, 0o755);
  const versHolder = (argv0) => {
    const fd = fs.openSync(jsonl, 'r');
    const p = spawn(versImg, ['-c', 'read x'], { argv0, cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore', fd] });
    fs.closeSync(fd);
    return p;
  };
  const wImageDirect = versHolder(versImg);                      // `exec "$IMG" "$@"` — nothing renamed
  const wPresentsAsCli = versHolder('/opt/pkg/bin/claude-native'); // a launcher that names the CLI
  const rHelperReexec = versHolder('ugrep');                     // THE MEASURED SHAPE: the CLI re-execing its own image as a helper
  const versFixtures = [['w-image-direct', wImageDirect], ['w-presents-as-cli', wPresentsAsCli], ['r-helper-reexec', rHelperReexec]];

  // …and the suite itself: same fd, and (when run from an agent worktree) the
  // very argv that used to match. A SIGTERM here must not kill the run.
  let selfTermed = false;
  const onTerm = () => { selfTermed = true; };
  process.on('SIGTERM', onTerm);
  const selfFd = fs.openSync(jsonl, 'r');
  // THE SUITE'S OWN SHAPE, REPRODUCED rather than hoped for (r2, defect 5): r1
  // labelled this leg from `process.argv[1]`, which node ABSOLUTISES, while the
  // guard reads the command line AS TYPED — run as `node scripts/test-…mjs`
  // from an agent worktree, r1 announced "the real regression shape" for an
  // argv that contains no `.claude` at all. A COPY of this file now runs in a
  // `.claude/worktrees/` checkout both ways a suite is ever started: by
  // absolute path (the shape that SIGTERMed the suite pre-B-3185) and
  // RELATIVELY from that checkout (the shape `npm run ci` types).
  const wtScripts = path.join(dir, '.claude', 'worktrees', 'wf_r2', 'scripts');
  fs.mkdirSync(wtScripts, { recursive: true });
  const suiteCopy = path.join(wtScripts, 'test-writer-sweep.mjs');
  fs.copyFileSync(new URL(import.meta.url), suiteCopy);
  const suiteHolder = (name, args, cwd) => {
    const ready = path.join(dir, 'ready-' + name);
    const p = spawn(process.execPath, args, {
      cwd, stdio: 'ignore',
      env: { ...process.env, VS_SWEEP_HOLDER: jsonl, VS_SWEEP_READY: ready },
    });
    holders.push({ name, p, ready });
    return p;
  };
  const selfAbs = suiteHolder('self-abs', [suiteCopy], os.tmpdir());
  const selfRel = suiteHolder('self-rel', ['scripts/test-writer-sweep.mjs'], path.dirname(wtScripts));

  // THE LOCK-FILE LEG is the one that actually reaches a live claude: measured
  // on the installed CLI (2.1.226, native), a running claude does NOT keep its
  // transcript open — it appends and closes, and a machine-wide scan found zero
  // holders of any ~/.claude/projects/**.jsonl while 16 CLIs were running. So
  // the CLI's own ~/.claude/sessions/<pid>.json registry gets the same two
  // controls, with neither fixture holding the fd (only the lock file names it).
  const sessDir = path.join(dir, '.claude', 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const lockWriter = spawn(nativeBin, ['-e', 'setTimeout(()=>{},60000)'], { cwd: os.tmpdir(), stdio: 'ignore' });
  const lockStale = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: os.tmpdir(), stdio: 'ignore' });
  for (const p of [lockWriter, lockStale]) fs.writeFileSync(path.join(sessDir, `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'rid-live', cwd: dir, version: '2.1.226' }) + '\n');

  // A negative control is only meaningful once the scan can actually SEE the
  // holder: wait until every fixture really has the transcript open.
  const holdsIt = (pid) => {
    try { return fs.readdirSync(`/proc/${pid}/fd`).some((f) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${f}`) === jsonl; } catch { return false; } }); }
    catch { return false; }
  };
  const t0 = Date.now();
  const allHolding = () => !holders.some((h) => !fs.existsSync(h.ready)) && holdsIt(rTail.pid) && versFixtures.every(([, p]) => holdsIt(p.pid));
  while (!allHolding() && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 20));
  ok(holdsIt(rTail.pid), '`tail -f` fixture really has the transcript open (the negative control is not vacuous)');
  // Rung 3's three fixtures must be REACHABLE before the verdicts mean anything:
  // if the helper never had the fd, "it survived" says nothing at all.
  const versHold = versFixtures.filter(([, p]) => holdsIt(p.pid)).map(([n]) => n);
  ok(versHold.length === 3, 'all three rung-3 fixtures really hold the transcript open (one binary, three argv[0]s — the verdicts below are about the presentation, nothing else)', { holding: versHold });
  // …and they really are ONE image: /proc/<pid>/exe is byte-identical for all three.
  const exeOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } };
  ok(versFixtures.every(([, p]) => exeOf(p.pid) === versImg),
    'all three rung-3 fixtures report the SAME /proc/<pid>/exe (the exe test alone cannot tell them apart — only argv[0] can)',
    { exes: versFixtures.map(([n, p]) => [n, exeOf(p.pid)]) });
  // RUNG 3's NEGATIVE CONTROL, on the predicate itself and BEFORE the sweep
  // (the writers are about to die). Same live pids, same shell function, only
  // rung 3 reverted to r1's `*/"$2"/versions/*) return 0` — the version that
  // said "runs the CLI's binary image" and meant "is the CLI".
  const isCliWith = (fns, pid, name) => {
    try { execFileSync('sh', ['-c', `${fns}\nvs_is_cli "$1" ${name}`, 'sh', String(pid)], { timeout: 20000 }); return true; }
    catch { return false; }
  };
  const shippedIdent = cliIdentityShellFns();
  const rungStart = shippedIdent.indexOf('  case "$vs_c_e" in\n');
  const rungEnd = shippedIdent.indexOf('\n  return 1\n}');
  const r1Ident = rungStart > 0 && rungEnd > rungStart
    ? shippedIdent.slice(0, rungStart) + '  case "$vs_c_e" in */"$2"/versions/*) return 0;; esac' + shippedIdent.slice(rungEnd)
    : shippedIdent;
  // A REVERT THAT DOES NOT PARSE ANSWERS "NO" FOR EVERYTHING — and a negative
  // control that silently answers NO looks exactly like a narrowing that works.
  const shParses = (t) => { try { execFileSync('sh', ['-n', '-c', t], { timeout: 20000 }); return true; } catch { return false; } };
  ok(r1Ident !== shippedIdent && /versions\/\*\) return 0/.test(r1Ident) && !/vs_c_a0##/.test(r1Ident.slice(rungStart)) && shParses(r1Ident),
    'the rung-3 negative control is the shipped identity with ONLY rung 3 reverted to r1 — and it PARSES (a broken revert would answer NO for everything and fake a pass)');
  ok(isCliWith(r1Ident, rHelperReexec.pid, 'claude'),
    'NEGATIVE CONTROL: r1\'s rung 3 answers YES for the re-exec\'d helper — the widening, reproduced on a live process');
  ok(!isCliWith(shippedIdent, rHelperReexec.pid, 'claude'), 'the shipped rung answers NO for that same live helper');
  ok(isCliWith(shippedIdent, wImageDirect.pid, 'claude') && isCliWith(shippedIdent, wPresentsAsCli.pid, 'claude'),
    '…and still YES for both CLI presentations of the SAME image (the narrowing did not make rung 3 unreachable)');
  // argv[0] captured BEFORE the sweep, so the labels below are facts, not hopes
  // (r1 read process.argv[1], which node ABSOLUTISES — it announced "the real
  // regression shape" for an argv that never contained `.claude`).
  const argvOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { return ''; } };
  const absArgv = argvOf(selfAbs.pid), relArgv = argvOf(selfRel.pid);
  // 90s, not the production 20s budget: the assertion is about the script's
  // BEHAVIOUR and a load-dependent timeout would make the release gate a coin
  // flip. (The batched scan itself measures ~3s at 3678 processes.)
  const scanStart = Date.now();
  const out = execFileSync('sh', ['-c', writerSweepScript('rid-live', shq)], { encoding: 'utf8', timeout: 90000, env: { ...process.env, HOME: dir } });
  const scanMs = Date.now() - scanStart;
  await new Promise((r) => setTimeout(r, 300));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const swept = parseSwept(out).map(Number);
  const started = (name) => fs.existsSync(path.join(dir, 'ready-' + name));
  const wasSwept = (name, p) => started(name) && swept.includes(p.pid) && !alive(p.pid);
  const survived = (name, p) => started(name) && !swept.includes(p.pid) && alive(p.pid);
  // the rung-3 fixtures announce themselves by HOLDING the fd (asserted above),
  // not by a ready file — they are `sh`, not node
  const wasSweptPid = (p) => swept.includes(p.pid) && !alive(p.pid);
  const survivedPid = (p) => !swept.includes(p.pid) && alive(p.pid);
  ok(wasSwept('w-native', wNative), 'WRITER swept: a native `…/bin/claude` holder (argv[0] basename) — positive control that the scan reached the holder at all', { swept });
  ok(wasSwept('w-npm', wNpm), 'WRITER swept: `node …/@anthropic-ai/claude-code/cli.js` (the npm entry point)', { swept });
  ok(wasSwept('w-shim', wShim), 'WRITER swept: `node <prefix>/bin/claude` (the shebang bin shim)', { swept });
  ok(!swept.includes(rTail.pid) && alive(rTail.pid), 'READER survives: `tail -f <HOME>/.claude/projects/…/<id>.jsonl` is NOT a transcript writer (B-3185)', { swept, pid: rTail.pid });
  ok(survived('r-worktree', rWorktree), 'READER survives: a process running from a path under .claude/worktrees/ (the suite\'s own self-kill shape)', { swept });
  ok(survived('r-othercli', rOtherCli), 'READER survives: a `cli.js` that is not under a claude package', { swept });
  ok(survived('r-neutral', rNeutral), 'READER survives: a neutral `node -e` holder', { swept });
  ok(!selfTermed && !swept.includes(process.pid), 'the SUITE ITSELF holds the transcript open and is never swept', { swept, pid: process.pid });
  // RUNG 3, both directions — same image, different presentation.
  ok(wasSweptPid(wImageDirect), 'RUNG 3 WRITER swept: exe under `<name>/versions/`, argv[0] IS that image (a wrapper\'s `exec "$IMG"` — nothing renamed)', { swept });
  ok(wasSweptPid(wPresentsAsCli), 'RUNG 3 WRITER swept: the same image behind a launcher argv[0] that PRESENTS as the CLI (`…/claude-native`)', { swept });
  ok(survivedPid(rHelperReexec), 'RUNG 3 READER survives: the same image re-exec\'d as a HELPER (argv[0] `ugrep`) — the measured shape r1 would have SIGTERMed as a transcript writer', { swept });
  // THE SUITE'S OWN SHAPE, run rather than described (r2, defect 5).
  ok(absArgv.includes('.claude') && !relArgv.includes('.claude'),
    'the two suite-copy legs really are the two argv shapes: absolute carries `.claude`, relative (what `npm run ci` types) carries none',
    { absArgv, relArgv });
  ok(survived('self-abs', selfAbs), 'READER survives: a COPY of this suite run BY ABSOLUTE PATH out of a `.claude/worktrees/` checkout — the exact argv that SIGTERMed the suite pre-B-3185', { swept });
  ok(survived('self-rel', selfRel), 'READER survives: the same copy run RELATIVELY from that checkout (`node scripts/test-writer-sweep.mjs`, the shape the gate types)', { swept });
  ok(swept.includes(lockWriter.pid) && !alive(lockWriter.pid), 'LOCK-FILE leg: a claude named by its own ~/.claude/sessions/<pid>.json is swept even though it holds no fd (the leg that reaches a REAL live claude)', { swept });
  ok(!swept.includes(lockStale.pid) && alive(lockStale.pid), 'LOCK-FILE leg: a STALE lock file whose pid was reused by something that is not claude kills nothing', { swept });
  console.log(`  · fd scan + sweep wall time: ${scanMs}ms over ${execFileSync('sh', ['-c', 'ls -d /proc/[0-9]* 2>/dev/null | wc -l'], { encoding: 'utf8' }).trim()} processes`);
  fs.closeSync(selfFd);
  process.off('SIGTERM', onTerm);
  for (const h of [...holders.map((h) => h.p), rTail, lockWriter, lockStale, ...versFixtures.map(([, p]) => p)]) { try { h.kill('SIGKILL'); } catch {} }
  fs.rmSync(dir, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the live fd-scan leg'); }

// ── 7. FORK EXCLUSION drift guard (2.284.4, real incident on the dev
// machine): forking a LIVE conversation ran the sweep against the parent's
// own rid and SIGTERMed the parent's claude mid-turn. A fork only READS the
// parent transcript and writes a NEW id's JSONL — no double-writer exists —
// so EVERY sweepWriters call site in the create handler must sit under a
// `!data.fork` gate. This guard fails anyone adding a new site without it.
{
  const src = fs.readFileSync(new URL('../src/ws-handler.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/ws-create.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  let sites = 0, gated = 0;
  lines.forEach((l, i) => {
    if (!/await sweepWriters\(/.test(l)) return;
    sites++;
    const window = lines.slice(Math.max(0, i - 15), i).join('\n');
    if (/!data\.fork/.test(window)) gated++;
  });
  ok(sites >= 3, `found the expected sweep call sites in ws-handler (${sites})`);
  ok(gated === sites, `EVERY sweep call site is gated on !data.fork (${gated}/${sites}) — forking a live session must never kill the parent`);
}

// ── 8. CODEX legs (P1 codex double-writer): the wrapper's thread/resume
// REUSES the thread id (only thread/fork mints one), and a codex app-server
// keeps rollout-*-<threadId>.jsonl open for its whole lifetime — a
// `codex resume <id>` TUI in an external terminal or an orphaned app-server is
// the same B-4058 double-writer class the claude legs exist for. The claude
// script must stay byte-identical (every existing caller passes no backend).
{
  const codexScript = writerSweepScript('01a0338c-b464-7ed3-8c11-bfa028cb0e2d', shq, { backend: 'codex', protectSids: ['sess-3-1787571254232'] });
  ok(codexScript.includes('/rollout-.*-$RID.jsonl') && codexScript.includes('.codex/sessions') && codexScript.includes('lsof'), 'codex script scans open rollout files (/proc fd leg + lsof leg)');
  ok(codexScript.includes('*codex*resume*"$RID"*') && codexScript.includes('CODEX_WEBUI_RESUME_ID=$RID'), 'codex script has the argv leg (external `codex resume <id>` TUI + orphaned wrapper)');
  ok(codexScript.includes("PROTECT='sess-3-1787571254232'") && codexScript.includes('CLAUDE_WEBUI_SESSION_ID='), 'protect list reaches the script and is matched on the holder\'s CLAUDE_WEBUI_SESSION_ID');
  ok(codexScript.includes('VS_WRITER_SWEEP'), 'the sweep shell self-skip sentinel is present (its own argv carries RID)');
  ok(!codexScript.includes('*claude*'), 'codex script never kills claude processes');
  ok(codexScript.includes('.vibespace') && codexScript.includes('vibespace-remote-keeper'), 'shared pipe-session + keeper legs stay in the codex script');
  ok(writerSweepScript('x', shq, { backend: 'codex', protectSids: ['ok-1', 'bad sid; rm -rf /'] }).includes("PROTECT='ok-1'"), 'malformed protect ids are dropped before they reach the shell');
  ok(writerSweepScript('rid-abc', shq, { backend: 'claude' }) === writerSweepScript('rid-abc', shq), 'backend defaults to claude — the claude script is unchanged for every existing caller');
  const l = fakeDevice('local'), r = fakeDevice('remote');
  await sweepWriters(mkHosts(l), null, 'tid-1', { shq, backend: 'codex', protectSids: ['s1'] });
  await sweepWriters(mkHosts(r, { hostRec: { transport: 'ssh' } }), 'h1', 'tid-1', { shq, backend: 'codex', protectSids: ['s1'] });
  ok(l.calls[0].script === r.calls[0].script && l.calls[0].script.includes("PROTECT='s1'"), 'codex: local and remote receive a BYTE-IDENTICAL script (one implementation)');
}

// ── 9. Real codex holders on this machine (Linux /proc). Fixture shapes are
// REAL: the rollout path mirrors ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl,
// the holder's argv names `codex` (the vendor binary runs as `…/bin/codex
// app-server`), and the protect marker rides the environ exactly as the dtach
// spawn sets it (CLAUDE_WEBUI_SESSION_ID=<webuiId>, verified on a live
// app-server's /proc/<pid>/environ).
if (fs.existsSync('/proc/self')) {
  const { spawn, execFileSync } = await import('node:child_process');
  const crypto = await import('node:crypto');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sweep-codex-'));
  const tid = crypto.randomUUID();
  const day = path.join(home, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-09-05T10-00-00-${tid}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: '2026-09-05T10:00:00.000Z', type: 'session_meta', payload: { id: tid, cwd: home, originator: 'claude-code-webui', source: 'vscode' } }) + '\n');
  const runScript = (script) => parseSwept(execFileSync('sh', ['-c', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: home } }));
  const runSweep = (opts = {}) => runScript(writerSweepScript(tid, shq, { backend: 'codex', ...opts }));
  const idle = 'setTimeout(() => {}, 60000)';
  // B-3185: the fixture's EXECUTABLE has to be the codex binary, because that
  // is what the guard now reads. The real vendor binary is
  // …/@openai/codex-linux-x64/vendor/<triple>/bin/codex (the npm `codex.js`
  // shim spawns it by path), so a node symlinked to that basename reproduces
  // exactly what `ps`/`/proc/<pid>/exe` show for a live app-server.
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const codexBin = path.join(home, 'bin', 'codex');
  fs.symlinkSync(process.execPath, codexBin);
  // a process that holds `file` open (fd 0), running `cmd` with the given argv
  const holder = (file, extraEnv = {}, cmd = codexBin, argvTail = []) => {
    const fd = fs.openSync(file, 'r');
    const p = spawn(cmd, ['-e', idle, ...argvTail], { stdio: [fd, 'ignore', 'ignore'], env: { ...process.env, ...extraEnv } });
    fs.closeSync(fd);
    return p;
  };
  const exited = (p) => new Promise((res) => { if (p.exitCode !== null || p.signalCode) return res(p.signalCode); p.once('exit', (c, s) => res(s)); });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const h1 = holder(rollout);
  await sleep(300);
  ok(runSweep().includes(String(h1.pid)), `an external codex app-server holding rollout-*-<threadId>.jsonl open is swept (SWEPT:${h1.pid})`);
  ok((await exited(h1)) === 'SIGTERM', 'the holder actually received SIGTERM');
  ok(runSweep().length === 0, 'released → the sweep finds nothing (clean)');

  const h2 = holder(rollout, { CLAUDE_WEBUI_SESSION_ID: 'sess-live-1' });
  await sleep(300);
  ok(!runSweep({ protectSids: ['sess-live-1'] }).includes(String(h2.pid)) && alive(h2.pid), 'a holder under a LIVE VibeSpace codex session (protect list) is NEVER swept');
  ok(runSweep({ protectSids: ['sess-other'] }).includes(String(h2.pid)), 'the same holder IS swept once its session is not live (protect mismatch)');
  await exited(h2);

  const h3 = spawn(process.execPath, ['-e', idle, 'codex', 'resume', tid], { stdio: 'ignore' });
  await sleep(300);
  ok(runSweep().includes(String(h3.pid)), 'a `codex resume <threadId>` argv (external TUI) is swept by the argv leg');
  await exited(h3);

  const zst = rollout + '.zst';
  fs.writeFileSync(zst, 'zst');
  const h4 = holder(zst);
  await sleep(300);
  ok(runSweep().includes(String(h4.pid)), 'an open rollout-*-<threadId>.jsonl.zst (codex ≥0.153 compression) holder is swept');
  await exited(h4);

  const h5 = holder(rollout, {}, process.execPath);
  // The codex twin of the B-3185 report: `tail -f` on a rollout has '/.codex/'
  // in its argv, which is all the old `*codex*` substring guard demanded.
  const h5b = spawn('tail', ['-f', rollout], { stdio: 'ignore' });
  await sleep(300);
  const sweptRun = runSweep();
  ok(!sweptRun.includes(String(h5.pid)) && alive(h5.pid), 'a NON-codex holder of the rollout is never killed (executable guard)');
  ok(!sweptRun.includes(String(h5b.pid)) && alive(h5b.pid), '`tail -f <HOME>/.codex/sessions/…/rollout-….jsonl` is never killed (B-3185)');
  h5.kill('SIGKILL'); h5b.kill('SIGKILL');

  const h6 = holder(rollout);
  await sleep(300);
  ok(!runScript(writerSweepScript(tid, shq)).includes(String(h6.pid)) && alive(h6.pid), 'the CLAUDE script never sweeps a codex holder (backend legs are disjoint)');
  h6.kill('SIGKILL');
  await exited(h6);

  // ── THE DISCOVERY TWIN, functionally (r2, defect 6 — the STANDING SWEEP).
  // hosts.js's remote-discovery `CO` leg answers a different question with the
  // same two mechanisms: "which rollouts are held OPEN by a codex process" =
  // which threads are RUNNING (codex has no lock files). It carried all three
  // shapes B-3185 retired — a `tr`+`grep` fork PAIR per process over
  // /proc/[0-9]* (measured here: 5.02s/8068 forks at 4034 processes, inside a
  // per-host discovery budget), a `readlink` fork PER FD under every match, and
  // an identity test that regex-matched the WHOLE argv. It now runs the SAME
  // shared functions (3.52s/~20 forks on the same box), so the sweep and
  // discovery answer "is this process the codex CLI" identically BY
  // CONSTRUCTION rather than by two people remembering to edit both.
  const { codexOpenRolloutsShell } = require('../src/hosts.js');
  const coLeg = codexOpenRolloutsShell();
  // status is asserted, not swallowed: this leg is the LAST command of the ssh
  // discovery script and `_ssh` REJECTS a non-zero exit — a leg that returns
  // its last iteration's status sends the whole host to the stale cache.
  const coStatuses = [];
  const runCoRaw = (script) => {
    try { return { status: 0, out: execFileSync('sh', ['-c', script], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: home } }) }; }
    catch (e) { return { status: e.status ?? -1, out: String(e.stdout || '') }; }
  };
  const runCo = () => {
    const r = runCoRaw(coLeg);
    coStatuses.push(r.status);
    return r.out.split('\n').filter((l) => l.startsWith('CO ')).map((l) => l.slice(3).trim());
  };
  await sleep(300);
  ok(runCo().length === 0, 'discovery CO leg: with every fixture released it reports nothing (clean baseline)');
  // A dtach master / VibeSpace wrapper: it NAMES `…/bin/codex resume <tid>` in
  // its ARGUMENTS and holds an INHERITED rollout fd. That is the shape the old
  // regex called "codex" — so a thread whose app-server had already exited kept
  // showing as RUNNING for as long as its master lived.
  const coMaster = holder(rollout, {}, process.execPath, [codexBin, 'resume', tid]);
  await sleep(300);
  ok(runCo().length === 0, 'discovery CO leg: a wrapper/dtach-master that merely NAMES the codex binary in its arguments is NOT a running thread', { pid: coMaster.pid });
  const retiredArgvIdentity = (pid) => {
    try {
      execFileSync('sh', ['-c', `tr '\\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -qE '(^|[/ ])codex( |$)|/@openai/codex/|/codex-linux-'`, 'sh', String(pid)], { timeout: 20000 });
      return true;
    } catch { return false; }
  };
  ok(retiredArgvIdentity(coMaster.pid),
    'NEGATIVE CONTROL: the RETIRED argv-regex identity answers YES for that very process — the false RUNNING the discovery twin used to produce');
  const coReal = holder(rollout);
  await sleep(300);
  ok(runCo().includes(rollout),
    'discovery CO leg: a real codex holder of the rollout IS reported (positive control — the ported leg is not simply dead)');
  ok(coStatuses.every((st) => st === 0),
    'discovery CO leg EXITS 0 in every state — nothing found, a non-CLI holder found, a real holder found (it is the ssh script\'s LAST command and _ssh rejects non-zero)',
    { statuses: coStatuses });
  // NEGATIVE CONTROL for that, made DETERMINISTIC: which fd the live scan
  // happens to hand the loop LAST is not controllable (that is the whole bug —
  // the status is data-dependent), so the scan is swapped for one synthetic row
  // while the loop, the shared identity test and the terminator stay exactly as
  // shipped. One row naming a NON-CLI holder is the last iteration by
  // construction.
  const oneRow = (pid) => coLeg.replace('vs_fd_scan "/rollout-[^/]*[.]jsonl"', `printf '%s\\t%s\\n' ${pid} "${rollout}"`);
  ok(oneRow(coMaster.pid) !== coLeg, 'the exit-status control really substituted the scan (the loop + identity + terminator are untouched)');
  const withTerm = runCoRaw(oneRow(coMaster.pid));
  ok(withTerm.status === 0 && !withTerm.out.includes('CO '),
    'one row naming a NON-CLI holder: reported as nothing AND exits 0 (the shipped leg)', { status: withTerm.status });
  const noTerm = runCoRaw(oneRow(coMaster.pid).replace(/\n\s*:[^\n]*$/, ''));
  ok(noTerm.status !== 0,
    'NEGATIVE CONTROL: strip the terminator and that same row makes the leg exit non-zero — which _ssh turns into "host unreachable, serving stale sessions" for the whole host',
    { status: noTerm.status });
  const rowReal = runCoRaw(oneRow(coReal.pid));
  ok(rowReal.status === 0 && rowReal.out.includes('CO ' + rollout),
    'one row naming the real codex holder: reported AND exits 0 (the substitution is not simply muting the loop)');
  coMaster.kill('SIGKILL'); coReal.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the live codex holder legs'); }

// ── 10. ws-create pins: the resume-already-live guard covers codex (functional,
// real handler instantiation) + every sweep site passes the backend/protect list.
{
  const { createWsCreateHandler } = require('../src/ws-create.js');
  const drive = async (activeSessions, data) => {
    const sent = [];
    const ws = { send: (s) => sent.push(JSON.parse(s)) };
    const ctx = { activeSessions, adapterRegistry: { get: () => ({}) } };
    const h = createWsCreateHandler({ ctx, noConvoRef: { map: new Map() }, crashLoopRef: { map: new Map() } });
    // a create that passes the guard runs on into the real spawn path, which
    // this bare ctx cannot serve — the throw is expected and irrelevant here.
    try { await h(ws, data, new Map()); } catch { }
    return sent.find((m) => m.code === 'resume-already-live') || null;
  };
  const live = new Map([
    ['sess-1', { backend: 'codex', backendSessionId: 'tid-live', host: null, name: 'codex live', cwd: '/w', mode: 'chat' }],
    ['sess-2', { backend: 'claude', claudeSessionId: 'cid-live', host: null, name: 'claude live', cwd: '/w', mode: 'chat' }],
    ['sess-3', { backend: 'codex', backendSessionId: 'tid-remote', host: 'h1', name: 'codex remote', cwd: '/w', mode: 'chat' }],
    ['sess-4', { backend: 'opencode', backendSessionId: 'oc-live', host: null, name: 'opencode live', cwd: '/w', mode: 'chat' }],
  ]);
  // S9 (2.369.42): the guard is gated on the harness CAPS row, not an id list —
  // a live OpenCode session (acp-wrapper on one serve session) refuses a second resume too
  ok((await drive(live, { backend: 'opencode', resume: true, resumeId: 'oc-live' }))?.existingId === 'sess-4', 'opencode resume of a LIVE serve session is refused with the live session handed back');
  ok(!(await drive(live, { backend: 'opencode', resume: true, resumeId: 'oc-other' })), 'opencode resume of a session nobody holds passes');
  ok(!(await drive(live, { backend: 'shell', resume: true, resumeId: 'oc-live' })), 'shell (no stream protocol) never enters the guard');
  const hit = await drive(live, { backend: 'codex', resume: true, resumeId: 'tid-live' });
  ok(hit && hit.existingId === 'sess-1' && hit.existingName === 'codex live', 'codex resume of a LIVE thread is refused with the live session handed back');
  ok(!(await drive(live, { backend: 'codex', resume: true, resumeId: 'tid-live', fork: true })), 'codex FORK of a live thread passes (thread/fork mints a new id)');
  ok(!(await drive(live, { backend: 'codex', resume: true, resumeId: 'tid-other' })), 'codex resume of a thread nobody holds passes');
  ok(!(await drive(live, { backend: 'codex', resume: true, resumeId: 'tid-remote' })), 'host semantics: a thread live on h1 is not "live" for a local resume');
  ok((await drive(live, { backend: 'codex', resume: true, resumeId: 'tid-remote', hostId: 'h1' }))?.existingId === 'sess-3', 'host semantics: the same thread IS live for a resume on h1');
  ok((await drive(live, { backend: 'claude', resume: true, resumeId: 'cid-live' }))?.existingId === 'sess-2', 'claude guard unchanged');
  ok(!(await drive(live, { backend: 'claude', resume: true, resumeId: 'tid-live' })), 'backends never cross-match (a claude resume of a codex thread id is not refused)');

  const src = fs.readFileSync(new URL('../src/ws-create.js', import.meta.url), 'utf8');
  ok(!/codex resume forks a new thread id by design \(not affected\)/.test(src), 'the FALSE "codex resume forks a new thread id" exemption is gone');
  ok(/if \(capsOf\(backend\)\.streamProtocol && data\.resume && data\.resumeId && !data\.fork\)/.test(src), 'resume-already-live guard is gated on the harness caps row (no backend id list)');
  const sites = src.split('\n').filter((l) => /await sweepWriters\(/.test(l));
  ok(sites.length >= 3 && sites.every((l) => /\.\.\.sweepOpts\(/.test(l)), `every sweep call site passes the backend + protect list via sweepOpts (${sites.length})`);
  ok(/const sweepOpts = \(hostId\) => backend === 'codex'/.test(src) && /\(es\.backend \|\| 'claude'\) === 'codex' && \(es\.host \|\| null\) === \(hostId \|\| null\)/.test(src), 'protect list = live codex sessions on the TARGET machine');
  ok(/&& \(backend === 'claude' \|\| backend === 'codex'\) && \/\^\[\\w-\]\+\$\/\.test\(data\.resumeId\) && hosts\)/.test(src), 'the LOCAL sweep gate admits codex');
  const client = fs.readFileSync(new URL('../src/lib/session-lifecycle.js', import.meta.url), 'utf8');
  ok(/resend: \(backend === 'claude' \|\| backend === 'codex'\) && !!resumeId && !fork/.test(client), 'client re-sends codex resumes on reconnect (safe only because the guard now covers codex)');
}

// ── 11. THE fd scan is ONE implementation (B-3185 wiring pin). boot-restore's
// "which conversations does a live claude still hold?" probe is the same scan
// with the kill removed; it used to be its own per-FD `readlink` loop, which
// on this machine meant 405,735 forks against a 6s timeout — it ALWAYS failed,
// and the bare catch turned that into "nobody is live". A fix that lives in
// one copy and not the other is the twin-drift class, so pin the wiring.
{
  const boot = fs.readFileSync(new URL('../src/server/boot-restore.js', import.meta.url), 'utf8');
  ok(/require\('\.\.\/writer-sweep\.js'\)/.test(boot) && /fdScanShellFns\(\)/.test(boot), 'boot-restore builds its live-conversation probe from THE shared fd scan');
  ok(!/for p in \/proc\/\[0-9\]\*\/fd\/\*/.test(boot), 'boot-restore no longer forks a readlink per FD (405,735 forks against its own 6s timeout)');
  // THE RATIONALE IS PART OF THE FIX (r2, defect 3). r1 justified the chunking
  // with "the old fd-level glob overflows ARG_MAX" — wrong: that glob was
  // consumed by a SHELL for-loop, which expands in the shell's own memory and
  // never reaches execve, so ARG_MAX never applied to it. ARG_MAX bounds
  // `vs_fd_chunk`, which EXECS `ls` — which is why THAT is chunked. A comment
  // that names the wrong mechanism is how the next person removes the right
  // guard, so both copies and both kb twins are pinned.
  const wsrc = fs.readFileSync(new URL('../src/writer-sweep.js', import.meta.url), 'utf8');
  const kbFile = fs.readFileSync(new URL('../docs/kb-file-structure.md', import.meta.url), 'utf8');
  const kbBug = fs.readFileSync(new URL('../docs/kb-bugfix-invariants.md', import.meta.url), 'utf8');
  const wrongArgMax = /glob (also )?(already )?overflows ARG_MAX|glob .{0,40}ALREADY overflows ARG_MAX/;
  ok(![wsrc, boot, kbFile, kbBug].some((t) => wrongArgMax.test(t)),
    'the WRONG ARG_MAX rationale (a shell for-loop overflowing ARG_MAX) is gone from the code AND from both kb twins');
  ok(/never reach(ed|es) execve/.test(wsrc) && /never reach(ed|es) execve/.test(boot),
    'both copies state the real reason instead: the for-loop glob never reached execve (its problem was the per-FD forks)');
  ok(/EXECS `ls`/.test(wsrc) && /ARG_MAX/.test(wsrc),
    'and the chunking is justified where it actually applies — `vs_fd_chunk` execs `ls`, so ITS argv is the one ARG_MAX bounds');
  ok(!/Both codex legs kill only `\*codex\*` cmdlines/.test(kbFile),
    'kb: the retired "both codex legs kill only *codex* cmdlines" claim is gone (identity is the EXECUTABLE since B-3185)');
  ok(/console\.warn\('\[boot-restore\] live-conversation fd scan failed/.test(boot), 'a failed probe SAYS SO instead of silently degrading to "nobody is live"');
  const fns = fdScanShellFns();
  ok(fns.includes('vs_fd_scan') && fns.includes('vs_fd_pids') && fns.includes('/proc/self/fd'),
    'the shared scan exports both entry points and keeps the >1-operand guarantee `ls -l` needs for its headers');
  ok(writerSweepScript('r', shq).includes(fns) && writerSweepScript('r', shq, { backend: 'codex' }).includes(fns),
    'both backends embed the scan VERBATIM (no per-backend copy to drift)');
}

// ── 12. THE DISCOVERY TWIN, structurally (r2, defect 6). The standing-sweep
// law: "twin-sets = 0" is a metric to re-measure, not a state. B-3185 fixed the
// sweep's /proc walk and its identity test and left the SAME two mechanisms
// untouched in hosts.js's remote-discovery CO leg — the second copy is where
// the fix does not land. It is now built from the shared exports, and the three
// retired shapes are pinned with the pre-B-3185 leg itself as the control.
{
  const { codexOpenRolloutsShell } = require('../src/hosts.js');
  const co = codexOpenRolloutsShell();
  ok(co.includes(fdScanShellFns()) && co.includes(cliIdentityShellFns()),
    'discovery CO leg embeds THE shared batched scan AND THE shared identity test VERBATIM (one implementation, two call sites)');
  ok(co.includes('vs_fd_scan "/rollout-') && co.includes('vs_is_cli "$copid" codex'),
    'the CO leg decides RUNNING by (shared scan → fd evidence) + (shared identity → is it the codex CLI)');
  ok(co.includes('lsof -Fcn'), 'the macOS/BSD lsof branch (no /proc) survives the port');
  // The three shapes B-3185 retired, each proven against the leg it came from.
  const perProcCmdlineFork = /for p in \/proc\/\[0-9\]\*/;
  const perFdReadlink = /readlink "\$l"/;
  const argvRegexIdentity = /grep -qE '\(\^\|\[\/ \]\)codex/;
  const PRE_B3185_CO_LEG = `        if [ -d /proc/self ]; then
          for p in /proc/[0-9]*; do
            tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qE '(^|[/ ])codex( |$)|/@openai/codex/|/codex-linux-' || continue
            for l in "$p"/fd/*; do t=$(readlink "$l" 2>/dev/null) || continue; case "$t" in "$HOME"/.codex/sessions/*rollout-*.jsonl|"$HOME"/.codex/sessions/*rollout-*.jsonl.zst) echo "CO $t";; esac; done
          done
        else`;
  ok(perProcCmdlineFork.test(PRE_B3185_CO_LEG) && perFdReadlink.test(PRE_B3185_CO_LEG) && argvRegexIdentity.test(PRE_B3185_CO_LEG),
    'NEGATIVE CONTROL: all three pins FIRE on the exact pre-B-3185 CO leg (git 3b928ca4^ src/hosts.js) — the pins can match the drift they name');
  ok(!perProcCmdlineFork.test(co) && !perFdReadlink.test(co) && !argvRegexIdentity.test(co),
    'and NONE of them fire on the shipped leg: no per-process fork pair, no per-FD readlink, no whole-argv identity');
  const hostsSrc = fs.readFileSync(new URL('../src/hosts.js', import.meta.url), 'utf8');
  ok(/\$\{codexOpenRolloutsShell\(\)\}/.test(hostsSrc) && !perFdReadlink.test(hostsSrc) && !argvRegexIdentity.test(hostsSrc),
    'WIRING PIN: the discovery script builds its CO leg from that one function, and no copy of the retired shapes is left anywhere in hosts.js');
  ok(/require\('\.\/writer-sweep'\)/.test(hostsSrc) || /require\('\.\/writer-sweep\.js'\)/.test(hostsSrc),
    'hosts.js takes the scan + identity from the SHARED module (not a local re-implementation)');

  // THE TWIN THAT IS STILL THERE — recorded, not silently left (the standing
  // sweep's "twin-sets = 0" is a MEASUREMENT, and an unrecorded twin is how the
  // metric lies). src/discovery-facts.js still identifies processes by command
  // line: `pidLooksClaude` is literally `cmdline.includes('claude')` and
  // `isCodexCommandLine` is a whole-argv regex — the rule B-3185 retired. It is
  // NOT ported here because its blast radius is different in kind: it decides
  // whether a card says RUNNING, it never decides who receives a SIGTERM. THAT
  // is the line these two asserts hold; if a future change wires this loose
  // rule into a kill path, or lets the sweep borrow it, the B-3185 incident
  // comes back through the side door.
  const facts = fs.readFileSync(new URL('../src/discovery-facts.js', import.meta.url), 'utf8');
  ok(/function pidLooksClaude/.test(facts) && /function isCodexCommandLine/.test(facts),
    'the RECORDED remaining twin is still exactly where the kb says it is (discovery-facts.js cmdline identity)');
  const sweepSrc = fs.readFileSync(new URL('../src/writer-sweep.js', import.meta.url), 'utf8');
  ok(!/SIGTERM|process\.kill|kill -TERM/.test(facts) && !/pidLooksClaude|isCodexCommandLine/.test(sweepSrc) && !/pidLooksClaude|isCodexCommandLine/.test(hostsSrc),
    'and it never crosses the line: no kill in discovery-facts, and neither the sweep nor the discovery CO leg borrows the loose rule');
}

// ── 13. THE KB ADVERTISES A NUMBER (r2, defect 7). It said 66 while the suite
// ran 68 — a small lie, but the kb is the operating manual and the number is
// how a reader decides whether an essay still describes the code. Self-checking
// so it can never drift again. (Skipped where the live /proc legs are skipped:
// the count is genuinely smaller there.)
if (fs.existsSync('/proc/self')) {
  const total = pass + fail + 1; // including this assert
  // EVERY doc that advertises a number, not just the one that was wrong: the
  // kb essay says `test-writer-sweep.mjs (N)`, the CLAUDE.md index says
  // `test-writer-sweep N`. Both are read as "does this essay still describe the
  // code", and both drifted.
  const claims = ['../docs/kb-bugfix-invariants.md', '../CLAUDE.md'].map((rel) => {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    return { rel, ns: [...src.matchAll(/test-writer-sweep(?:\.mjs)?[ (]+(\d+)/g)].map((m) => Number(m[1])) };
  });
  // ONE assert on purpose: `total` counts itself, so a second assert in this
  // block would make the number it checks wrong by one.
  ok(claims.every((c) => c.ns.length > 0 && c.ns.every((n) => n === total)),
    `every doc that names this suite advertises the REAL assert count (${total})`,
    claims.map((c) => [c.rel, c.ns]));
} else { console.log('  · /proc absent — skipping the advertised-assert-count pin'); }

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
