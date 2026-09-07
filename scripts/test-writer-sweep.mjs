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
// THE identity rule's own home (B-3185 r3): the shell text AND its JS twin. The
// sweep re-exports the shell half, so importing it from BOTH here is also how
// the re-export is proven to be the same function object (§12).
const cliIdentity = require('../src/cli-identity.js');
const { isCliProcess } = cliIdentity;

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
  ok(/\{ tr [^{}]*< "\/proc\/\$1\/cmdline"[^{}]*\| sed[^{}]*; \} 2>\/dev\/null/.test(idFns),
    'vs_argv silences the WHOLE cmdline compound, not just `tr` (a failed redirect is a shell-level error)');
  const gone = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
  const r = spawnSync('sh', ['-c', `${idFns}\nvs_argv ${gone} 0; vs_is_cli ${gone} claude`], { encoding: 'utf8', timeout: 20000 });
  // NOTE WHAT THIS LEG DOES AND DOES NOT COVER (r3, defect 3). For a pid that is
  // not there `[ -r /proc/<pid>/cmdline ]` is FALSE, so this exercises the `ps`
  // FALLBACK branch and the `readlink` — it never reaches the redirect the fix
  // silences, and therefore passes identically on the unfixed code. It is kept
  // as the fallback-branch assertion and is NOT the silencing control; that one
  // is below.
  ok((r.stderr || '') === '', 'vs_argv/vs_is_cli say NOTHING on stderr for a pid that is not there (the `ps` fallback + readlink branches)', { stderr: r.stderr });
  // THE SILENCING CONTROL, made to DISCRIMINATE (r3, defect 3). The failure the
  // fix exists for needs `[ -r ]` to PASS and the OPEN to FAIL — in production
  // that is the TOCTOU race of a pid exiting mid-scan, which is not schedulable
  // (and a machine-wide scan of this box found zero pids whose cmdline passes
  // the test but fails the read, so there is no static /proc stand-in). So the
  // SHIPPED text is driven with exactly ONE literal substituted — the /proc
  // root — against a path with that exact property: a unix SOCKET, which
  // access(2) reports readable and open(2) rejects (ENXIO), so the SHELL prints
  // `cannot open …` precisely as it does for the vanished pid. Everything the
  // fix is about (where the braces are, where the `2>/dev/null` sits) is the
  // shipped text, and the control is the VERBATIM pre-fix line.
  //   A directory looks like the obvious fixture and is the WRONG one: O_RDONLY
  // on a directory SUCCEEDS, so `tr` fails at read time and its own
  // `2>/dev/null` swallows it in both spellings — a control that passes either
  // way, which is the very defect being fixed here.
  const net = await import('node:net');
  const argvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-argv-'));
  fs.mkdirSync(path.join(argvDir, '7'), { recursive: true });
  const argvSock = path.join(argvDir, '7', 'cmdline');
  const srv = net.createServer(() => { });
  await new Promise((res) => srv.listen(argvSock, res));
  const rReadable = spawnSync('sh', ['-c', '[ -r "$1" ] && echo YES', 'sh', argvSock], { encoding: 'utf8', timeout: 20000 });
  ok((rReadable.stdout || '').trim() === 'YES',
    'the control path PASSES `[ -r ]` and still cannot be OPENED — the redirect the fix silences is actually reached (the vanished-pid leg above never reaches it)');
  ok((idFns.match(/\/proc\/\$1\/cmdline/g) || []).length === 2,
    'vs_argv names the cmdline through exactly the two literals the re-root substitutes (the substitution cannot silently miss one)');
  const rerooted = idFns.split('/proc/$1/cmdline').join(`${argvDir}/$1/cmdline`);
  const shippedCompound = `{ tr '\\n' '\\001' < "${argvDir}/$1/cmdline" | tr '\\0' '\\n' | sed -n "$(($2 + 1))p" | tr '\\001' '\\n'; } 2>/dev/null`;
  // git 3b928ca4:src/writer-sweep.js — the redirect FIRST, `2>/dev/null` on the
  // reading `tr` ALONE, so the shell's own complaint about the failed open is
  // never covered. (Spelled against the r4 pipeline: the defect under test is
  // WHERE the redirection sits, not how many stages follow it.)
  const preFixCompound = `tr '\\n' '\\001' < "${argvDir}/$1/cmdline" 2>/dev/null | tr '\\0' '\\n' | sed -n "$(($2 + 1))p" | tr '\\001' '\\n'`;
  const preFixed = rerooted.replace(shippedCompound, preFixCompound);
  ok(rerooted !== idFns && !rerooted.includes('/proc/$1/cmdline') && rerooted.includes(shippedCompound),
    'the re-rooted copy changed ONLY the /proc path — the silencing structure under test is the shipped text');
  ok(preFixed !== rerooted && preFixed.includes(preFixCompound),
    'the negative control is that same line in its VERBATIM pre-fix spelling (redirect first, `2>/dev/null` on `tr` alone)');
  const runArgv = (fns) => spawnSync('sh', ['-c', `${fns}\nvs_argv 7 0`], { encoding: 'utf8', timeout: 20000 });
  const argvFixed = runArgv(rerooted), argvBuggy = runArgv(preFixed);
  ok((argvFixed.stderr || '') === '',
    'vs_argv is SILENT when the cmdline OPEN fails after `[ -r ]` passed (the pid-exits-mid-scan shape) — the whole compound is redirected', { stderr: argvFixed.stderr });
  ok(/cannot open/.test(argvBuggy.stderr || ''),
    'NEGATIVE CONTROL: the pre-fix spelling leaks the SHELL\'s `cannot open …` for that exact input — the noise this fix removed from every machine-wide scan', { stderr: argvBuggy.stderr });
  await new Promise((res) => srv.close(res));
  fs.rmSync(argvDir, { recursive: true, force: true });
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

  // THE IMAGE WAS REPLACED WHILE THE SESSION RAN (r3, defect 2). When the file
  // behind a running process is unlinked, the kernel appends ` (deleted)` to
  // /proc/<pid>/exe — and that is not an exotic state: it is exactly what
  // `claude` auto-update and `npm i -g @openai/codex` do to LIVE sessions. On
  // this box RIGHT NOW two of the four running agent CLIs report a `(deleted)`
  // image (claude 2.1.235/2.1.229 and the codex vendor binary), so the suffix
  // is the NORMAL state a few minutes after an update — and a mid-update CLI
  // still appending to the transcript is precisely the double-writer the sweep
  // exists to stop. Without the strip BOTH executable rungs miss it: basename
  // `claude (deleted)`, and the "nothing was renamed" disjunct compares
  // `2.1.258` against `2.1.258 (deleted)`. Two fixtures, one per exe rung, each
  // with an argv[0] that CANNOT answer through rung 1 or 2 (otherwise the exe
  // rung is never reached and the fixture proves nothing).
  const delDir = path.join(dir, 'upd');
  fs.mkdirSync(path.join(delDir, '.local', 'share', 'claude', 'versions'), { recursive: true });
  fs.mkdirSync(path.join(delDir, 'bin'), { recursive: true });
  const delHolder = (img, argv0) => {
    fs.copyFileSync(fs.realpathSync('/bin/sh'), img);
    fs.chmodSync(img, 0o755);
    const fd = fs.openSync(jsonl, 'r');
    const p = spawn(img, ['-c', 'read x'], { argv0, cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore', fd] });
    fs.closeSync(fd);
    fs.unlinkSync(img); // ← the update: the running image is now `<path> (deleted)`
    return p;
  };
  const delVersImg = path.join(delDir, '.local', 'share', 'claude', 'versions', '2.1.258');
  const wDelVersions = delHolder(delVersImg, delVersImg);           // rung 3b: exe under versions/, argv[0] IS the image
  const delBinImg = path.join(delDir, 'bin', 'claude');
  const wDelBasename = delHolder(delBinImg, '/opt/launch/agent-runner'); // rung 3a: exe basename IS the CLI, launcher argv[0]
  const delFixtures = [['w-deleted-versions', wDelVersions], ['w-deleted-basename', wDelBasename]];

  // A WORD OF argv MAY CONTAIN A NEWLINE (r4, defect 3). argv is a list of
  // NUL-separated words: the JS twin reads that list, but the shell could not,
  // so it turned NULs into newlines and took the Nth LINE — i.e. the FIRST LINE
  // of the Nth word. The two spellings then answered DIFFERENTLY about the same
  // live process, in both directions, and one of them is a kill decision:
  //   · `/usr/bin/claude<LF>/usr/bin/tail` — basename `tail` (JS: not the CLI),
  //     first line `/usr/bin/claude` (old shell: the CLI) ⇒ the sweep SIGTERMs a
  //     reader, the exact B-3185 harm through a different door;
  //   · `<dir>/dir<LF>name/claude` — basename `claude` (JS: the CLI), first line
  //     `<dir>/dir` (old shell: not the CLI) ⇒ a real writer survives the sweep
  //     and the double-writer corruption the sweep exists to prevent happens.
  // Neither fixture holds the transcript (identity is the whole question here),
  // and the image lives OUTSIDE any `versions/` dir so rung 3 cannot answer for
  // them — the verdict is about argv[0] and nothing else.
  const nlDir = path.join(dir, 'nl');
  fs.mkdirSync(nlDir, { recursive: true });
  const nlImg = path.join(nlDir, 'runner');
  fs.copyFileSync(fs.realpathSync('/bin/sh'), nlImg);
  fs.chmodSync(nlImg, 0o755);
  const nlHolder = (argv0) => spawn(nlImg, ['-c', 'read x'], { argv0, cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore'] });
  const rNlFirstLine = nlHolder('/usr/bin/claude\n/usr/bin/tail');   // JS: no · pre-r4 shell: YES (a kill)
  const wNlInWord = nlHolder(path.join(nlDir, 'dir\nname', 'claude')); // JS: YES · pre-r4 shell: no (a survivor)
  const nlFixtures = [['r-nl-first-line', rNlFirstLine, false], ['w-nl-in-word', wNlInWord, true]];

  // …AND THE OTHER HALF OF THE SAME DEFECT: THE WORD'S *TRAILING* BYTES.
  // Parking newlines on \001 fixes "the Nth line is the Nth record", but the
  // value still had to survive `$(…)`, which strips EVERY trailing newline —
  // so a word (or an exe path) that ENDS in one read `…/claude` in the shell
  // and `…/claude<LF>` in JS, and the shell's answer is the permissive one, on
  // a path that kills. Three fixtures, one per capture vs_cap now protects:
  //   · argv[0] `…/claude<LF>`      — rung 1, the `$(vs_argv …)` capture;
  //   · argv[0] `…/claude<0x01>`    — the \001 park itself: it becomes a newline
  //     on the way out, so WITHOUT the sentinel it too was eaten (the code
  //     comment used to claim this residue could only ever look LESS like the
  //     CLI — for a TRAILING \001 that was false);
  //   · exe `…/claude<LF>` with a launcher argv[0] — rung 3, the `$(readlink …)`
  //     capture, which no argv fixture can reach.
  const nlTrailImg = path.join(nlDir, 'claude\n');   // a REAL image whose basename ends in LF
  fs.copyFileSync(fs.realpathSync('/bin/sh'), nlTrailImg);
  fs.chmodSync(nlTrailImg, 0o755);
  const rArgvTrailNl = nlHolder('/usr/bin/claude\n');
  const rArgvTrailCtl = nlHolder('/usr/bin/claude' + String.fromCharCode(1)); // a LITERAL \001, spelled so no editor eats it
  const rExeTrailNl = spawn(nlTrailImg, ['-c', 'read x'], { argv0: '/opt/launch/agent-runner', cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore'] });
  // every one of them is NOT the CLI — the shared rule compares against a name
  // that carries neither byte, so a trailing one can only mean "not it".
  const capFixtures = [['r-argv-trail-nl', rArgvTrailNl], ['r-argv-trail-ctl', rArgvTrailCtl], ['r-exe-trail-nl', rExeTrailNl]];

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
  const allHolding = () => !holders.some((h) => !fs.existsSync(h.ready)) && holdsIt(rTail.pid) && [...versFixtures, ...delFixtures].every(([, p]) => holdsIt(p.pid));
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
  // ── THE `(deleted)` IMAGE (r3, defect 2), with its own negative control ──
  const exeRaw = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } };
  ok(delFixtures.every(([, p]) => / \(deleted\)$/.test(exeRaw(p.pid))) && delFixtures.every(([, p]) => holdsIt(p.pid)),
    'the auto-update fixtures really are in the state under test: /proc/<pid>/exe ends in ` (deleted)` AND they hold the transcript open',
    { exes: delFixtures.map(([n, p]) => [n, exeRaw(p.pid)]) });
  ok(delFixtures.every(([, p]) => isCliWith(shippedIdent, p.pid, 'claude')),
    'a LIVE claude whose image was replaced on disk is still the CLI to the shell rung (` (deleted)` stripped)',
    { verdicts: delFixtures.map(([n, p]) => [n, isCliWith(shippedIdent, p.pid, 'claude')]) });
  ok(delFixtures.every(([, p]) => isCliProcess(p.pid, 'claude') === true),
    '…and to the JS twin, which strips the same suffix');
  // The control strips the strip — same text, the comment + assignment removed.
  // Anchored on the ASSIGNMENT rather than its exact quoting, so re-quoting the
  // pattern (as the zsh fix below does) cannot silently turn this control into a
  // no-op that compares the shipped text against itself.
  const noStripIdent = shippedIdent.replace(/\n *# the kernel appends[\s\S]*?\n  vs_c_e=\$\{vs_c_e%[^\n]*\}/, '');
  ok(noStripIdent !== shippedIdent && !/deleted/.test(noStripIdent) && shParses(noStripIdent),
    'the `(deleted)` negative control is the shipped identity with ONLY the strip removed — and it PARSES (a broken revert answers NO for everything and fakes a pass)');
  ok(isCliWith(noStripIdent, wNative.pid, 'claude'),
    '…and it is NOT simply dead: without the strip, a normal claude (rung 1) still answers YES');
  ok(delFixtures.every(([, p]) => !isCliWith(noStripIdent, p.pid, 'claude')),
    'NEGATIVE CONTROL: without the strip BOTH exe rungs miss the very process the sweep exists to stop — the CLI that was auto-updated mid-session',
    { verdicts: delFixtures.map(([n, p]) => [n, isCliWith(noStripIdent, p.pid, 'claude')]) });

  // ── A NEWLINE INSIDE AN argv WORD (r4, defect 3) ──────────────────────────
  // The fixtures must really be in the state under test before any verdict
  // means anything: argv[0] present AND containing a newline.
  const argv0Of = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || ''; } catch { return ''; } };
  const tNl = Date.now();
  while (nlFixtures.some(([, p]) => !argv0Of(p.pid).includes('\n')) && Date.now() - tNl < 10000) await new Promise((r) => setTimeout(r, 20));
  ok(nlFixtures.every(([, p]) => argv0Of(p.pid).includes('\n')),
    'the newline fixtures really carry a newline INSIDE argv[0] (read back out of /proc — the state under test, not a description of it)',
    { argv0s: nlFixtures.map(([n, p]) => [n, JSON.stringify(argv0Of(p.pid))]) });
  // The control is the shipped text with ONLY the /proc reader reverted to the
  // pre-r4 line — one substitution, everything else byte-identical.
  const R4_ARGV_NEW = `tr '\\n' '\\001' < "/proc/$1/cmdline" | tr '\\0' '\\n' | sed -n "$(($2 + 1))p" | tr '\\001' '\\n'`;
  const R4_ARGV_OLD = `tr '\\0' '\\n' < "/proc/$1/cmdline" | sed -n "$(($2 + 1))p"`;
  const preR4Ident = shippedIdent.replace(R4_ARGV_NEW, () => R4_ARGV_OLD);
  ok(preR4Ident !== shippedIdent && !preR4Ident.includes(R4_ARGV_NEW) && shParses(preR4Ident),
    'the newline negative control is the shipped identity with ONLY the pre-r4 `vs_argv` /proc reader put back — and it PARSES (a broken revert answers NO for everything and fakes a pass)');
  ok(isCliWith(preR4Ident, wNative.pid, 'claude') && !isCliWith(preR4Ident, rTail.pid, 'claude'),
    '…and it is NOT simply dead: the pre-r4 reader still answers YES for a normal claude and NO for `tail`');
  ok(nlFixtures.every(([, p, want]) => isCliProcess(p.pid, 'claude') === want),
    'the JS twin reads the NUL-separated record: `…/claude<LF>…/tail` is NOT the CLI, `…/dir<LF>name/claude` IS',
    { js: nlFixtures.map(([n, p]) => [n, isCliProcess(p.pid, 'claude')]) });
  ok(nlFixtures.every(([, p, want]) => isCliWith(preR4Ident, p.pid, 'claude') !== want),
    'NEGATIVE CONTROL: the pre-r4 shell answers the OPPOSITE of the JS twin on BOTH fixtures — it would have SIGTERMed a `tail` reader and spared a real writer, on the same live pids',
    { preR4: nlFixtures.map(([n, p]) => [n, isCliWith(preR4Ident, p.pid, 'claude')]) });
  ok(nlFixtures.every(([, p, want]) => isCliWith(shippedIdent, p.pid, 'claude') === want),
    'the SHIPPED shell now agrees with the JS twin on both — "the Nth line" is "the Nth NUL-record" in either spelling');

  // …and the TRAILING half of the same defect (`$(…)` eats trailing newlines).
  // Its control reverts the three CAPTURES vs_cap replaced and nothing else.
  const CAPS = [
    ['vs_cap vs_argv "$1" 0\n  vs_c_a0=$vs_c_v', 'vs_c_a0=$(vs_argv "$1" 0)'],
    ['vs_cap vs_argv "$1" "$vs_c_i"\n        vs_c_a=$vs_c_v', 'vs_c_a=$(vs_argv "$1" "$vs_c_i")'],
    ['vs_cap readlink "/proc/$1/exe"\n  vs_c_e=$vs_c_v', 'vs_c_e=$(readlink "/proc/$1/exe" 2>/dev/null)'],
  ];
  ok(CAPS.every(([now]) => shippedIdent.includes(now)),
    'every capture the trailing-bytes fix protects is present in the SHIPPED text under the exact spelling the control reverts (the substitution cannot silently miss one)');
  const preCapIdent = CAPS.reduce((t, [now, was]) => t.replace(now, () => was), shippedIdent);
  ok(preCapIdent !== shippedIdent && !/vs_cap (vs_argv|readlink)/.test(preCapIdent) && shParses(preCapIdent),
    'the trailing-bytes negative control is the shipped identity with ONLY those three captures put back — no `vs_cap` call survives, and it PARSES');
  ok(isCliWith(preCapIdent, wNative.pid, 'claude') && !isCliWith(preCapIdent, rTail.pid, 'claude'),
    '…and it is NOT simply dead: the pre-vs_cap captures still answer YES for a normal claude and NO for `tail`');
  const tCap = Date.now();
  const capReady = () => argv0Of(rArgvTrailNl.pid).endsWith('\n')
    && argv0Of(rArgvTrailCtl.pid).endsWith(String.fromCharCode(1))
    && exeOf(rExeTrailNl.pid).endsWith('\n');
  while (!capReady() && Date.now() - tCap < 10000) await new Promise((r) => setTimeout(r, 20));
  ok(capReady(),
    'the trailing-byte fixtures really END in the byte under test — argv[0] in LF / in \\001, and an exe PATH in LF (all read back out of /proc)',
    { argv0s: capFixtures.map(([n, p]) => [n, JSON.stringify(argv0Of(p.pid))]), exe: JSON.stringify(exeOf(rExeTrailNl.pid)) });
  ok(capFixtures.every(([, p]) => isCliProcess(p.pid, 'claude') === false),
    'THE identity says NO to all three: a name that ends in a byte the CLI\'s name does not carry is a different name');
  ok(capFixtures.every(([, p]) => isCliWith(preCapIdent, p.pid, 'claude') === true),
    'NEGATIVE CONTROL: without vs_cap the shell says YES to all three — `$(…)` ate the trailing byte, so the sweep and the remote Terminate would SIGTERM a process THE identity refuses (and the \\001 residue the code comment called harmless was not)',
    { preCap: capFixtures.map(([n, p]) => [n, isCliWith(preCapIdent, p.pid, 'claude')]) });
  ok(capFixtures.every(([, p]) => isCliWith(shippedIdent, p.pid, 'claude') === false),
    'the SHIPPED shell agrees with the JS twin on all three — the capture preserves the word, including its last byte');

  // ── THE SHELL THAT RUNS THIS TEXT IS NOT `sh` (r3 round 2) ────────────────
  // The device rung runs the script as `sh -c`, but BOTH ssh rungs — the
  // sweep's fallback (sweepWriters) and the discovery CO leg (hosts.js `_ssh`)
  // — hand it to `ssh host -- <script>`, which the REMOTE USER'S LOGIN SHELL
  // interprets. So the identity text has to mean the same thing in every login
  // shell, and the `(deleted)` strip is where that bit immediately: in zsh
  // `(…)` is a glob GROUP, so an UNQUOTED `${e% (deleted)}` matches " deleted"
  // and strips NOTHING — the r3 fix would have been dead on exactly the hosts
  // whose login shell is zsh (a very common default, this dev box included),
  // while every `sh -c` test stayed green. Drive the SHIPPED text through every
  // login shell present and demand identical verdicts.
  const SHELL_CANDIDATES = [['dash', ['/bin/dash']], ['bash', ['/bin/bash']], ['busybox', ['/usr/bin/busybox', 'sh']], ['zsh', ['/bin/zsh']], ['ksh', ['/bin/ksh']], ['mksh', ['/bin/mksh']]];
  const shells = SHELL_CANDIDATES.filter(([, a]) => fs.existsSync(a[0]));
  const isCliUnder = (argv, fns, pid, name) => {
    try { execFileSync(argv[0], [...argv.slice(1), '-c', `${fns}\nvs_is_cli "$1" ${name}`, 'sh', String(pid)], { timeout: 20000 }); return true; }
    catch { return false; }
  };
  // the fixtures whose verdict DEPENDS on the strip, plus two that must not move
  // (the trailing-byte fixtures ride along on purpose: `${v%"$nl"}` is exactly
  //  the quoted-pattern construct the `(deleted)` strip got wrong under zsh)
  const shellProbe = [...delFixtures, ...nlFixtures.map(([n, p]) => [n, p]), ...capFixtures, ['w-native', wNative], ['r-helper-reexec', rHelperReexec]];
  const verdictsUnder = (argv, fns) => shellProbe.map(([n, p]) => `${n}=${isCliUnder(argv, fns, p.pid, 'claude')}`).join(',');
  const shBaseline = verdictsUnder(['/bin/sh'], shippedIdent);
  ok(/vs_c_e=\$\{vs_c_e%'[^']* \(deleted\)[^']*'\}|vs_c_e=\$\{vs_c_e%"[^"]* \(deleted\)[^"]*"\}|\\\(deleted\\\)/.test(shippedIdent),
    'the ` (deleted)` pattern is QUOTED in the shipped text — unquoted, `(…)` is a glob GROUP in zsh and the strip silently does nothing');
  const shellDiff = shells.filter(([, argv]) => verdictsUnder(argv, shippedIdent) !== shBaseline);
  ok(shellDiff.length === 0,
    `the shipped identity gives IDENTICAL verdicts under every login shell present (${shells.map(([n]) => n).join(', ')}) — ssh runs it under the remote user's shell, not \`sh\``,
    { baseline: shBaseline, diverged: shellDiff.map(([n, argv]) => [n, verdictsUnder(argv, shippedIdent)]) });
  // …and the probe must actually contain a shell where the two spellings differ,
  // or the parity above is agreement among shells that all behave like `sh`.
  const zsh = shells.find(([n]) => n === 'zsh');
  const unquotedIdent = shippedIdent.replace(/vs_c_e=\$\{vs_c_e%'( \(deleted\))'\}/, 'vs_c_e=${vs_c_e%$1}');
  ok(unquotedIdent !== shippedIdent && shParses(unquotedIdent) && verdictsUnder(['/bin/sh'], unquotedIdent) === shBaseline,
    'the zsh negative control is the shipped text with ONLY the quotes removed — it PARSES and is INDISTINGUISHABLE under `sh` (which is why every sh-only test stayed green)');
  if (!zsh) console.log('  · zsh absent — the cross-shell negative control below is vacuous here (it is the shell that discriminates)');
  ok(!zsh || verdictsUnder(zsh[1], unquotedIdent) !== shBaseline,
    'NEGATIVE CONTROL: under zsh the UNQUOTED spelling gives different verdicts — an auto-updated CLI stops being a writer on every zsh-login host',
    { zshUnquoted: zsh ? verdictsUnder(zsh[1], unquotedIdent) : null, baseline: shBaseline });
  ok(!zsh || verdictsUnder(zsh[1], shippedIdent) === shBaseline,
    '…and the SHIPPED (quoted) spelling holds under zsh — the fix, proven on the shell that broke it');

  // ── JS ⇄ SHELL IDENTITY PARITY (r3, defect 1 — the STANDING-SWEEP twin) ──
  // "Is pid N the agent CLI?" is asked by the sweep (shell, decides who gets a
  // SIGTERM), by the ssh discovery CO leg (shell — the SAME text, embedded
  // verbatim, pinned in §12) and by src/discovery-facts.js (JS, decides whether
  // a card reads RUNNING). r1/r2 fixed the shell copies and RECORDED the JS one
  // as a deliberate twin; this drives BOTH spellings over the same live pids in
  // the same instant. A one-sided edit turns this red.
  const parityFixtures = [
    ['w-native', wNative.pid], ['w-npm', wNpm.pid], ['w-shim', wShim.pid],
    ['r-tail', rTail.pid], ['r-worktree', rWorktree.pid], ['r-othercli', rOtherCli.pid], ['r-neutral', rNeutral.pid],
    ['w-image-direct', wImageDirect.pid], ['w-presents-as-cli', wPresentsAsCli.pid], ['r-helper-reexec', rHelperReexec.pid],
    ['w-deleted-versions', wDelVersions.pid], ['w-deleted-basename', wDelBasename.pid],
    ['r-nl-first-line', rNlFirstLine.pid], ['w-nl-in-word', wNlInWord.pid],
    ...capFixtures.map(([n, p]) => [n, p.pid]),
    ['self-abs', selfAbs.pid], ['self-rel', selfRel.pid], ['lock-writer', lockWriter.pid], ['lock-stale', lockStale.pid],
    ['this-suite', process.pid], ['dead-pid', Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1],
  ];
  const parityRows = [];
  for (const [label, pid] of parityFixtures) for (const nm of ['claude', 'codex']) {
    parityRows.push({ label, nm, js: isCliProcess(pid, nm), sh: isCliWith(shippedIdent, pid, nm) });
  }
  const parityBad = parityRows.filter((r) => r.js !== r.sh);
  ok(parityBad.length === 0,
    `PARITY: the JS predicate and the shell function agree on all ${parityRows.length} (live pid × CLI name) pairs — one rule, two spellings`,
    { mismatches: parityBad });
  ok(parityRows.filter((r) => r.sh).length >= 4 && parityRows.filter((r) => !r.sh).length >= 10,
    'the parity matrix is not vacuous: it contains both verdicts (agreement on "everything is false" would prove nothing)',
    { yes: parityRows.filter((r) => r.sh).map((r) => `${r.label}/${r.nm}`) });
  // …and the twin that was there until r3 would have FAILED that assert.
  const retiredJsClaude = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude'); } catch { return false; } };
  const retiredBad = parityFixtures.filter(([, pid]) => retiredJsClaude(pid) !== isCliWith(shippedIdent, pid, 'claude'));
  ok(retiredBad.length > 0,
    'NEGATIVE CONTROL: the RETIRED JS rule (`cmdline.includes(\'claude\')`, what discovery-facts ran until r3) DISAGREES with the shell on live fixtures — the parity assert above really does fail a divergence',
    { disagreements: retiredBad.map(([l]) => l) });
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
  ok(wasSweptPid(wDelVersions) && wasSweptPid(wDelBasename),
    'AUTO-UPDATE WRITERS swept: both `(deleted)`-image holders (exe under `<name>/versions/`, and exe basename `claude`) — the CLI whose binary was replaced mid-session is still a writer', { swept });
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
  for (const h of [...holders.map((h) => h.p), rTail, lockWriter, lockStale, ...versFixtures.map(([, p]) => p), ...delFixtures.map(([, p]) => p), ...nlFixtures.map(([, p]) => p), ...capFixtures.map(([, p]) => p)]) { try { h.kill('SIGKILL'); } catch {} }
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

  // ── THE CO LEG'S OTHER BRANCH (r3): macOS/BSD has no /proc, so the leg has a
  // SECOND body — and being unreachable from Linux is exactly how it kept the
  // rule the rest of B-3185 retired: `lsof -Fcn … | awk '… c ~ /codex/'`, i.e.
  // lsof's COMMAND field (comm, matched as a SUBSTRING). Worse, r1/r2 emitted
  // the shared shell functions INSIDE the `then` block, so `vs_is_cli` did not
  // even EXIST down there. Reachable now by substituting ONE literal — the
  // /proc probe — leaving the loop, the identity test and the terminator as
  // shipped (the same technique as the vs_argv control in §1).
  const noProcCo = coLeg.replace('if [ -d /proc/self ]; then', 'if [ -d /proc/self/definitely-not-here ]; then');
  ok(noProcCo !== coLeg && noProcCo.includes('lsof -Fpn') && !/\[ -d \/proc\/self \]/.test(noProcCo),
    'the no-/proc control changed ONLY the /proc probe — the lsof body under test is the shipped text');
  const haveLsof = (() => { try { execFileSync('sh', ['-c', 'command -v lsof'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!haveLsof) console.log('  · lsof absent — the CO leg\'s no-/proc branch legs below are vacuous here');
  const runCoNoProc = (script) => runCoRaw(script).out.split('\n').filter((l) => l.startsWith('CO ')).map((l) => l.slice(3).trim());
  // a holder whose NAME merely contains `codex` — the shape comm-substring
  // confuses. A COPY of /bin/sh (not a symlink: node renames its own comm).
  const keeperBin = path.join(home, 'bin', 'codex-keeper');
  fs.copyFileSync(fs.realpathSync('/bin/sh'), keeperBin);
  fs.chmodSync(keeperBin, 0o755);
  const keeperFd = fs.openSync(rollout, 'r');
  const coKeeper = spawn(keeperBin, ['-c', 'read x'], { stdio: ['pipe', 'ignore', 'ignore', keeperFd] });
  fs.closeSync(keeperFd);
  await sleep(300);
  ok(!haveLsof || runCoNoProc(noProcCo).includes(rollout),
    'the no-/proc branch REACHES the real codex holder — `vs_is_cli` is DEFINED there now (r1/r2 emitted it inside the `then` block, so this branch called an undefined function)',
    { reported: haveLsof ? runCoNoProc(noProcCo) : null });
  // …and the verbatim pre-r3 body, so the control is the old code itself.
  const preR3Lsof = `lsof -Fcn +D "$HOME"/.codex/sessions 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/ && c ~ /codex/ && $0 ~ /rollout-.*\\.jsonl(\\.zst)?$/ {print "CO " substr($0,2)}'`;
  // a REPLACER FUNCTION, not a replacement string: `$0`/`$&` in the pre-r3 awk
  // are String.replace substitution patterns and would be rewritten.
  const preR3Co = noProcCo.replace(/lsof -Fpn[\s\S]*?\n {10}done\n/, () => preR3Lsof + '\n');
  ok(preR3Co !== noProcCo && preR3Co.includes("c ~ /codex/"),
    'the negative control is that branch in its VERBATIM pre-r3 spelling (lsof COMMAND field, substring-matched)');
  coReal.kill('SIGKILL');
  await exited(coReal);
  await sleep(300);
  ok(!haveLsof || runCoNoProc(preR3Co).includes(rollout),
    'NEGATIVE CONTROL: with only `codex-keeper` holding it, the pre-r3 branch calls the rollout RUNNING — a stopped thread that never stops showing as live on every mac host',
    { reported: haveLsof ? runCoNoProc(preR3Co) : null });
  ok(!haveLsof || runCoNoProc(noProcCo).length === 0,
    '…and the shipped branch reports nothing for that same holder: one identity rule on BOTH branches of BOTH rungs');
  // …and the SAME exit-status invariant holds down here: this is still the ssh
  // discovery script's LAST command, and the `while read` loop now present in
  // the else-branch exits with its last iteration's status — which, in the
  // state just asserted (the only holder is NOT the CLI), is non-zero.
  ok(!haveLsof || runCoRaw(noProcCo).status === 0,
    'the no-/proc branch EXITS 0 even when its last row names a non-CLI holder (the trailing `:` covers the branch the r3 port gave a `while` loop)',
    { status: haveLsof ? runCoRaw(noProcCo).status : null });
  coKeeper.kill('SIGKILL');
  coMaster.kill('SIGKILL');
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
  // r3: the macOS/BSD branch survives the port AND is the SAME rule. `-Fpn`
  // (pid + name) feeding `vs_is_cli`, never `-Fcn` + `c ~ /codex/`; and the
  // shared function definitions are emitted ABOVE the `if`, or `vs_is_cli`
  // simply does not exist in the branch that needs it. Driven for real above.
  ok(co.includes('lsof -Fpn') && !co.includes('lsof -Fcn') && !co.includes('c ~ /codex/'),
    'the macOS/BSD lsof branch (no /proc) survives the port AND asks the shared identity — not lsof\'s COMMAND field');
  ok(co.indexOf(cliIdentityShellFns()) < co.indexOf('if [ -d /proc/self ]'),
    'the shared shell functions are defined BEFORE the /proc branch, so the lsof branch can call vs_is_cli at all');
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

  // THE TWIN IS GONE, AND STAYS GONE (r3, defect 1 — the standing sweep's whole
  // point: "twin-sets = 0" is a MEASUREMENT). r2 ported the shell CO leg and
  // RECORDED the third copy — src/discovery-facts.js identifying processes by
  // command line (`pidLooksClaude` = `cmdline.includes('claude')`,
  // `isCodexCommandLine` = a whole-argv regex) — as a deliberate twin, on the
  // grounds that it only labels a card RUNNING and never SIGTERMs anything.
  // That difference in blast radius is real and is still not a reason for two
  // spellings: measured on this box, the loose rule answered YES for 106 of
  // 4277 processes against 16 real claude CLIs (dtach masters, chat-wrappers,
  // the fake `code` editor helper, a zsh shell-snapshot), so a lock file whose
  // pid had been RECYCLED by any of them produced exactly the phantom "running"
  // session pidLooksClaude exists to prevent. One rule now, in
  // src/cli-identity.js; §6 drives both spellings over the same live pids.
  const identSrc = fs.readFileSync(new URL('../src/cli-identity.js', import.meta.url), 'utf8');
  const facts = fs.readFileSync(new URL('../src/discovery-facts.js', import.meta.url), 'utf8');
  const sweepSrc = fs.readFileSync(new URL('../src/writer-sweep.js', import.meta.url), 'utf8');
  // The retired-shape pins below run over CODE, not prose: these files DESCRIBE
  // the rules they retired (that is the kb contract), and a pin that a comment
  // can turn red is a pin the next author deletes.
  const codeOnly = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const factsCode = codeOnly(facts), identCode = codeOnly(identSrc);
  ok(/function isCliProcess/.test(identSrc) && /function cliIdentityShellFns/.test(identSrc),
    'THE identity rule has ONE home: src/cli-identity.js carries the JS predicate AND the shell text');
  ok(cliIdentity.cliIdentityShellFns === cliIdentityShellFns,
    'writer-sweep RE-EXPORTS that shell text rather than keeping a copy (same function object)');
  ok(/require\('\.\/cli-identity'\)/.test(sweepSrc) && /require\('\.\/cli-identity'\)/.test(facts),
    'WIRING PIN: both the sweep and discovery-facts take the identity from the shared module');
  ok(/isCliProcess\(pid, 'claude'\)/.test(facts) && /isCliProcess\(pid, 'codex'\)/.test(facts),
    'discovery-facts asks the shared predicate for BOTH CLI names (the lock scan and the open-rollout scan)');
  // the three retired JS shapes, proven on the verbatim pre-r3 source
  const retiredCommIncludes = /comm\.includes\('claude'\)/;
  const retiredCmdlineIncludes = /readFileSync\(`\/proc\/\$\{pid\}\/cmdline`, 'utf-8'\)\.includes\('claude'\)/;
  const retiredCodexArgvRegex = /\(\^\|\\0\|\[\\\/\\s\]\)codex/;
  const PRE_R3_FACTS = `function pidLooksClaude(pid) {
  try {
    const comm = fs.readFileSync(\`/proc/\${pid}/comm\`, 'utf-8').trim();
    if (comm) return comm.includes('claude') || cmdlineLooksClaude(pid);
  } catch { }
}
function cmdlineLooksClaude(pid) {
  try { return fs.readFileSync(\`/proc/\${pid}/cmdline\`, 'utf-8').includes('claude'); } catch { return false; }
}
function isCodexCommandLine(cmdline = '') {
  return /(^|\\0|[\\/\\s])codex(\\0|\\s|$)/.test(String(cmdline || ''));
}`;
  ok(retiredCommIncludes.test(PRE_R3_FACTS) && retiredCmdlineIncludes.test(PRE_R3_FACTS) && retiredCodexArgvRegex.test(PRE_R3_FACTS),
    'NEGATIVE CONTROL: all three JS pins FIRE on the exact pre-r3 discovery-facts text (git baa66775 src/discovery-facts.js) — pins that can match the drift they name');
  ok(!retiredCommIncludes.test(factsCode) && !retiredCmdlineIncludes.test(factsCode) && !retiredCodexArgvRegex.test(factsCode),
    'and NONE of them fire on the shipped discovery-facts CODE: no comm substring, no cmdline substring, no whole-argv codex regex');
  const identRequires = [...identSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  ok(identRequires.length > 0 && identRequires.every((r) => !r.startsWith('.')),
    `cli-identity stays dependency-free — node builtins only (${identRequires.join(', ')}) — because the daemon bundles discovery-facts, which now pulls it in`);
  // ONE assert either way — §13 checks the total against the number the kb
  // advertises, so a conditionally-present assert would make that number depend
  // on whether the tree happens to be built.
  const agentdBundle = new URL('../data/bin/vibespace-agentd.js', import.meta.url);
  const bundleBuilt = fs.existsSync(agentdBundle);
  if (!bundleBuilt) console.log('  · daemon bundle not built in this tree — the carry pin below is vacuous (run `npm run build:agentd`)');
  ok(!bundleBuilt || /isCliProcess/.test(fs.readFileSync(agentdBundle, 'utf8')),
    'the BUILT daemon bundle carries the shared predicate (the device snapshot answers identity the way this machine does)');
  // THE LINE THAT MUST NOT BE CROSSED, unchanged: discovery answers "RUNNING",
  // it never answers "who receives a SIGTERM".
  ok(!/SIGTERM|process\.kill|kill -TERM/.test(factsCode) && !/SIGTERM|process\.kill|kill -TERM/.test(identCode),
    'neither discovery-facts nor the shared identity module contains a kill path (they classify; only the sweep script kills)');
}

// ── 14. THE OTHER KILL PATHS (r4, defect 1 — the standing sweep, re-measured
// on the question "who else decides that a pid may be SIGTERMed?"). B-3185
// fixed the sweep, then discovery; both of THOSE are enumerated by §12. The
// answer nobody had asked for is /api/kill-pid — the sidebar's Terminate for a
// discovered EXTERNAL session — and it was a two-spelling rule on BOTH sides:
//   · remote (hosts.js killRemotePid): `case "$(ps -p N -o args=)" in
//     *claude*|*codex*)` — the retired whole-argv substring, live on a kill
//     path, on a machine the user cannot look at. A remote `tail -f` on a
//     transcript, an editor, a wrapper whose ARGUMENTS name `…/bin/codex`, or a
//     dtach master carrying `…/claude --resume …` (killing which destroys the
//     session) all matched, and the route reported success.
//   · local: `ps -o comm=` + `.includes('claude')` — which is neither an
//     executable test (node renames its own main thread to `MainThread`, so an
//     npm-installed `node …/claude-code/cli.js` was NOT killable at all) nor a
//     whole match (`claude-keeper` was).
// Both now ask THE identity. Driven functionally: the real shell text against
// real processes, and the real express handler through the real router.
if (fs.existsSync('/proc/self')) {
  const { execFileSync, spawn } = await import('node:child_process');
  const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-kill-'));
  const kproj = path.join(kdir, '.claude', 'projects', '-w');
  fs.mkdirSync(kproj, { recursive: true });
  const ktx = path.join(kproj, 'rid-kill.jsonl');
  fs.writeFileSync(ktx, '{}\n');
  const krollout = path.join(kdir, '.codex', 'sessions', '2026', 'rollout-2026-09-07T00-00-00-abc.jsonl');
  fs.mkdirSync(path.dirname(krollout), { recursive: true });
  fs.writeFileSync(krollout, '{}\n');
  // EVERY fixture is registered with the argv it must ALREADY have before any
  // verdict is taken. "cmdline contains a NUL" is not enough: between fork and
  // exec the child still shows the SUITE's own command line — which, run from
  // an agent worktree, contains `.claude` — so a too-early read would judge the
  // wrong argv (and, for the real-CLI fixtures, the wrong way).
  const kprocs = [];
  const kargv = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
  const track = (p, expect) => { kprocs.push({ p, expect }); return p; };
  // READERS whose ARGV merely names a CLI path — the shape the retired rule
  // could not tell from a writer. Two identical claude-shaped ones: the control
  // gets to kill its own victim, so the shipped verdict is not measured on a
  // process the control already destroyed.
  const reader = (file) => track(spawn('tail', ['-f', file], { cwd: os.tmpdir(), stdio: 'ignore' }), (a) => a[0]?.endsWith('tail') && a[2] === file);
  const rVictim = reader(ktx);           // for the retired script
  const rClaudePath = reader(ktx);       // for the shipped remote script
  const rLocalPath = reader(ktx);        // for the shipped LOCAL route — its own fixture, so a
                                         // remote-leg regression cannot also redden the local assert
  const rCodexPath = reader(krollout);   // argv names …/.codex/…rollout… ⇒ matched `*codex*`
  // REAL CLIs — a copy of /bin/sh named `claude` / `codex` (rung 1: argv[0]
  // basename). A symlink would resolve /proc/<pid>/exe back to the interpreter.
  const realCli = (name, sub = 'bin') => {
    const img = path.join(kdir, sub, name);
    fs.mkdirSync(path.dirname(img), { recursive: true });
    fs.copyFileSync(fs.realpathSync('/bin/sh'), img);
    fs.chmodSync(img, 0o755);
    return track(spawn(img, ['-c', 'read x'], { cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore'] }), (a) => a[0] === img);
  };
  const wClaude = realCli('claude');
  const wCodex = realCli('codex');
  // …and the shape the LOCAL comm rule could never kill: an npm-install CLI.
  const cliJs = path.join(kdir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cliJs), { recursive: true });
  fs.writeFileSync(cliJs, 'setTimeout(() => {}, 60000);');
  const wNpmCli = track(spawn(process.execPath, [cliJs], { cwd: os.tmpdir(), stdio: 'ignore' }), (a) => a[1] === cliJs);
  const alive2 = (p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } };
  const kReady = ({ p, expect }) => expect(kargv(p.pid));
  const tK = Date.now();
  while (kprocs.some((e) => !kReady(e)) && Date.now() - tK < 10000) await new Promise((r) => setTimeout(r, 20));
  ok(kprocs.every((e) => kReady(e) && alive2(e.p)),
    'every kill-path fixture is live and has EXEC\'d its own argv (not the suite\'s, which a pre-exec read would have judged) before any verdict is taken',
    { argvs: kprocs.map((e) => kargv(e.p.pid).join(' ').slice(0, 60)) });

  // ── the REMOTE script, run for real (it is transport-agnostic text) ──
  const { killPidShell } = require('../src/hosts.js');
  // A non-zero exit is a RESULT here (a failing `kill` is the one thing the
  // script is allowed to report that way) — read it, never throw out of the
  // section: an exception is not a red assertion.
  const runKill = (script) => {
    try { return String(execFileSync('sh', ['-c', script], { encoding: 'utf8', timeout: 20000 }) || '').trim(); }
    catch (e) { return String(e.stdout || '').trim() + `|EXIT:${e.status}`; }
  };
  // git 77ac0825:src/hosts.js — the verbatim pre-r4 line.
  const retiredKillShell = (p) => `C=$(ps -p ${p} -o args= 2>/dev/null); case "$C" in *claude*|*codex*) kill -TERM ${p} && echo VS_OK;; "") echo VS_GONE;; *) echo VS_NOTAGENT;; esac`;
  const retiredSays = runKill(retiredKillShell(rVictim.pid));
  await new Promise((r) => setTimeout(r, 300));
  ok(retiredSays.includes('VS_OK') && !alive2(rVictim),
    'NEGATIVE CONTROL: the pre-r4 remote script KILLS `tail -f …/.claude/projects/<id>.jsonl` and reports success — a reader terminated on a machine the user cannot see',
    { out: retiredSays });
  const shippedClaudePath = runKill(killPidShell(rClaudePath.pid));
  const shippedCodexPath = runKill(killPidShell(rCodexPath.pid));
  await new Promise((r) => setTimeout(r, 300));
  ok(shippedClaudePath.includes('VS_NOTAGENT') && alive2(rClaudePath),
    'the shipped remote script REFUSES a pid whose argv merely NAMES a claude transcript, and the reader survives', { out: shippedClaudePath });
  ok(shippedCodexPath.includes('VS_NOTAGENT') && alive2(rCodexPath),
    '…and the same for a codex rollout path (the retired rule matched `*codex*` there too)', { out: shippedCodexPath });
  const killedClaude = runKill(killPidShell(wClaude.pid));
  const killedCodex = runKill(killPidShell(wCodex.pid));
  await new Promise((r) => setTimeout(r, 300));
  ok(killedClaude.includes('VS_OK') && !alive2(wClaude),
    'POSITIVE CONTROL: a REAL claude CLI is still terminated by the shipped script (the narrowing did not break Terminate)', { out: killedClaude });
  ok(killedCodex.includes('VS_OK') && !alive2(wCodex),
    '…and a real codex CLI too (both names go through the shared identity)', { out: killedCodex });
  const deadPid = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
  ok(runKill(killPidShell(deadPid)).includes('VS_GONE'),
    'a pid that is not there still answers VS_GONE — the caller\'s three outcomes are unchanged');
  ok(killPidShell(4242).includes(cliIdentityShellFns()) && !/\*claude\*\|\*codex\*/.test(killPidShell(4242)),
    'the remote Terminate script embeds THE shared identity VERBATIM and carries no whole-argv case');
  let badPidRejected = false;
  try { killPidShell('7; kill -9 -1'); } catch { badPidRejected = true; }
  ok(badPidRejected, 'the script builder rejects a non-integer pid AT the place that builds shell text (never "the caller validated it")');

  // …and the script through the METHOD that ships it. A builder used by a
  // method but referenced as a free identifier throws only when the METHOD RUNS
  // (the 5th/6th/7th lost-binding incidents), and no structural pin can see
  // that. The device link is stubbed with "run it right here", which is exactly
  // what a device does with `sh -c <script>`.
  const { HostManager } = require('../src/hosts.js');
  const hmDir = path.join(kdir, 'hm');
  fs.mkdirSync(hmDir, { recursive: true });
  const hm = new HostManager({ dataDir: hmDir });
  hm._state.hosts = [{ id: 'h1', name: 'h1', transport: 'dial', host: 'x', user: 'u' }];
  hm.deviceBounded = async () => ({
    async runCmd(cmd, args) { try { return { stdout: execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }) }; } catch (e) { return { stdout: String(e.stdout || '') }; } },
  });
  hm.invalidateDiscovery = () => { };
  const rMethod = reader(ktx), wMethod = realCli('claude', 'bin2'); // a SECOND real CLI: same name, own dir
  { const t = Date.now(); while ([rMethod, wMethod].some((p) => !kprocs.find((e) => e.p === p) || !kReady(kprocs.find((e) => e.p === p))) && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 20)); }
  let methodRefused = '';
  try { await hm.killRemotePid('h1', rMethod.pid); } catch (e) { methodRefused = e.message; }
  ok(/not a claude\/codex process/.test(methodRefused) && alive2(rMethod),
    'killRemotePid ITSELF (the shipped method, device link stubbed to run the script here) refuses the reader — the builder is really wired, not just exported', { methodRefused });
  const methodKilled = await hm.killRemotePid('h1', wMethod.pid).catch((e) => ({ error: e.message }));
  await new Promise((r) => setTimeout(r, 300));
  ok(methodKilled?.success === true && !alive2(wMethod),
    '…and terminates a real CLI through that same method', { methodKilled });

  // ── the LOCAL branch, through the REAL express handler ──
  const sessionsMod = require('../src/routes/sessions.js');
  sessionsMod.setup({
    activeSessions: new Map(), webuiPids: new Set(), refreshWebuiPids: () => { },
    createSessionMessages: () => ({}), BUFFERS_DIR: kdir, PERMISSION_MODES: [],
    execFileSync, hosts: { device: async () => { throw new Error('no device in this test'); } },
    accounts: null, sessionAuth: () => ({}), serverSetting: () => undefined,
  });
  const killLayer = sessionsMod.router.stack.find((l) => l.route?.path === '/api/kill-pid');
  const callKill = (pid) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    Promise.resolve(killLayer.route.stack[0].handle({ body: { pid } }, res)).catch((e) => resolve({ code: 0, body: { error: String(e) } }));
  });
  ok(!!killLayer, 'the /api/kill-pid route is reachable through the real router (the handler below is the shipped one)');
  // NEGATIVE CONTROL for the local branch: the retired comm rule, verbatim.
  const retiredComm = (pid) => { try { const c = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 2000 }).trim(); return c === 'claude' || c.includes('claude'); } catch { return false; } };
  ok(retiredComm(wNpmCli.pid) === false && isCliProcess(wNpmCli.pid, 'claude') === true,
    'NEGATIVE CONTROL: the retired `ps -o comm=` rule says NOT-claude for a live `node …/@anthropic-ai/claude-code/cli.js` (node renames its main thread to `MainThread`) — Terminate could never kill an npm-installed CLI',
    { comm: (() => { try { return execFileSync('ps', ['-p', String(wNpmCli.pid), '-o', 'comm='], { encoding: 'utf-8' }).trim(); } catch { return '?'; } })() });
  const localReader = await callKill(rLocalPath.pid);
  await new Promise((r) => setTimeout(r, 200));
  ok(localReader.code === 400 && /not a claude\/codex process/.test(localReader.body?.error || '') && alive2(rLocalPath),
    'LOCAL branch: a reader whose argv merely names a transcript is REFUSED (400) and survives', { got: localReader });
  const localNpm = await callKill(wNpmCli.pid);
  await new Promise((r) => setTimeout(r, 300));
  ok(localNpm.body?.success === true && !alive2(wNpmCli),
    'LOCAL branch: the npm-shape CLI the comm rule could not see IS terminated now', { got: localNpm });

  // ── the structural line: no kill path asks anything but THE identity ──
  const sessSrc = fs.readFileSync(new URL('../src/routes/sessions.js', import.meta.url), 'utf8');
  const storeSrc = fs.readFileSync(new URL('../src/session-store.js', import.meta.url), 'utf8');
  const hostsSrc2 = fs.readFileSync(new URL('../src/hosts.js', import.meta.url), 'utf8');
  const codeOnly2 = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/isCliProcess\(pid, 'claude'\)/.test(sessSrc) && /isCliProcess\(pid, 'codex'\)/.test(sessSrc) && !/isProcessClaude/.test(sessSrc),
    'WIRING PIN: /api/kill-pid\'s local branch asks the shared predicate for BOTH names, and the comm-substring import is gone from the route module');
  ok(/const cmd = killPidShell\(p\);/.test(hostsSrc2) && !/\*claude\*\|\*codex\*/.test(codeOnly2(hostsSrc2)),
    'WIRING PIN: killRemotePid builds its script from killPidShell, and no copy of the retired whole-argv case survives in hosts.js CODE');
  ok(/\*claude\*\|\*codex\*/.test(retiredKillShell(1234)) && /comm/.test(String(retiredComm)),
    'NEGATIVE CONTROL: both pins name shapes that really exist — they FIRE on the verbatim pre-r4 remote line and on the retired comm rule');
  // The surviving comm twin is DISCOVERY-ONLY, and that is the whole record
  // r3 got wrong (it named "the local sweep's PID-reuse fallback" and missed
  // that its SYNC twin gated a SIGTERM). One caller, named here so a second one
  // turns this red.
  const asyncCallers = storeSrc.split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /isProcessClaudeAsync\(/.test(l) && !/^async function|^\s*(\/\/|\*)/.test(l));
  ok(asyncCallers.length === 1 && /return isProcessClaudeAsync\(pid\);/.test(asyncCallers[0].l),
    'the surviving `comm` twin has exactly ONE caller — isLockClaude\'s no-procStart fallback (a card label, never a kill)',
    { callers: asyncCallers.map((c) => c.l.trim()) });
  ok(!/isProcessClaude\b(?!Async)/.test(codeOnly2(storeSrc)),
    'and its SYNC twin — the one that gated /api/kill-pid\'s SIGTERM — no longer exists');
  for (const { p } of kprocs) { try { p.kill('SIGKILL'); } catch { } }
  fs.rmSync(kdir, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the kill-path legs'); }

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
