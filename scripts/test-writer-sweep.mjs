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

// ── 15. THE `ps` FALLBACK RUNG — THE NO-/proc HALF NOBODY HAD DRIVEN (r5,
// defect 1). `vs_argv`'s `else` branch is what runs on a machine with no /proc
// (macOS/BSD ssh hosts), and r4 changed it — it flattens the `ps` blob with
// `tr '\n' ' '` first, "the way the JS twin's /\s+/ split always did". That
// sentence was a DESCRIPTION: the branch had no assertion of its own and no
// control, on this Linux box every fixture takes the /proc rung, and the one
// leg that reaches the branch at all (the vanished-pid stderr leg in §1) only
// looks at stderr. So the half of the r4 fix that lives here shipped unproven —
// (r) again: a branch no test can reach is a branch that drifts.
//
// Reaching it needs TWO environment substitutions and NO edit to the text under
// test: (a) re-root `/proc/$1/` so BOTH reads miss, which is exactly what
// "there is no /proc here" means (r3's re-root technique, widened from the
// cmdline literal to the exe one — leaving the exe read live let rung 3 answer
// from `/proc/<pid>/exe` and the ps rung was never the decider); (b) a `ps` on
// PATH that does NOT flatten a newline inside an argv word. (b) is a stand-in
// on purpose and the assertion says so: measured here, procps 4.x `ps -o args=`
// RENDERS an embedded newline as a space, so this box's own `ps` cannot produce
// the multi-line blob the fix is about — and the branch only ever runs on a
// platform whose `ps` this box does not have. The stand-in reads the REAL argv
// out of /proc and joins the words with single spaces, so the only thing it
// invents is the one byte the local `ps` refuses to emit.
//
// The invariant under test is PARITY OF THE SAME RUNG: the shell's ps fallback
// and the JS twin's ps fallback see the identical lossy blob (`ps` cannot
// recover word boundaries — both spellings answer `claude` for fixture A, which
// the /proc rung calls `tail`; that is a property of `ps`, not a defect), and
// they must read it the same way. And the JS side is DRIVEN, not mirrored: a
// child node process with a preload that makes the two /proc reads throw runs
// the SHIPPED `procArgv`/`isCliProcess` on the same live pids.
if (fs.existsSync('/proc/self')) {
  const { spawn, spawnSync } = await import('node:child_process');
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-psfb-'));
  const shimDir = path.join(pdir, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPs = path.join(shimDir, 'ps');
  fs.writeFileSync(shimPs, `#!/bin/sh
# Stand-in for a \`ps\` on a machine with no /proc: \`-p PID -o args=\` prints the
# argv words joined by single spaces WITHOUT flattening a newline inside a word.
# It invents nothing else — the words come from the live process.
pid=""
while [ $# -gt 0 ]; do case "$1" in -p) shift; pid=$1;; esac; shift; done
[ -n "$pid" ] || exit 1
[ -r "/proc/$pid/cmdline" ] || exit 1
tr '\\0' ' ' < "/proc/$pid/cmdline" | sed 's/ $//'
echo
`);
  fs.chmodSync(shimPs, 0o755);
  const pmk = (rel) => { const p = path.join(pdir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(fs.realpathSync('/bin/sh'), p); fs.chmodSync(p, 0o755); return p; };
  const pprocs = [];
  const pspawn = (img, argv0) => { const p = spawn(img, ['-c', 'read x'], { argv0, cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore'] }); pprocs.push(p); return p; };
  // the SAME two directions §6's /proc fixtures use, plus a plain one so the
  // control can be shown to be alive rather than simply answering NO.
  const imgNlA = pmk('a/claude');
  const psNlTail = pspawn(imgNlA, imgNlA + '\n/usr/bin/tail');   // …/claude<LF>/usr/bin/tail
  const imgNlB = pmk('d\nname/claude');
  const psNlCli = pspawn(imgNlB, imgNlB);                        // …/d<LF>name/claude
  const imgPlain = pmk('c/claude');
  const psPlain = pspawn(imgPlain, imgPlain);                    // …/c/claude
  const psFix = [['ps-nl-tail', psNlTail], ['ps-nl-cli', psNlCli], ['ps-plain', psPlain]];
  const pArgv0 = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || ''; } catch { return ''; } };
  { const t = Date.now(); while (psFix.some(([, p]) => !pArgv0(p.pid)) && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 20)); }
  ok(psFix.every(([, p]) => !!pArgv0(p.pid)) && pArgv0(psNlTail.pid).includes('\n') && pArgv0(psNlCli.pid).includes('\n'),
    'the ps-rung fixtures are live and have EXEC\'d their own argv, two of them carrying a newline INSIDE argv[0] (read back out of /proc)',
    { argv0s: psFix.map(([n, p]) => [n, JSON.stringify(pArgv0(p.pid))]) });
  // THE STAND-IN IS THE POINT, SO IT IS ASSERTED: this box's `ps` cannot make
  // the input the fix is about, which is why the branch was never exercised.
  const realPsOut = spawnSync('ps', ['-p', String(psNlTail.pid), '-o', 'args='], { encoding: 'utf8' }).stdout || '';
  ok(realPsOut.trimEnd().split('\n').length === 1,
    'MEASURED: this box\'s procps `ps -o args=` renders the embedded newline as a SPACE — one line — so the local `ps` cannot produce the multi-line blob the r4 flattening exists for (the stand-in below is not decoration)',
    { realPs: JSON.stringify(realPsOut) });
  const shimOut = spawnSync(shimPs, ['-p', String(psNlTail.pid), '-o', 'args='], { encoding: 'utf8' }).stdout || '';
  ok(shimOut.trimEnd().split('\n').length === 2 && shimOut.startsWith(pArgv0(psNlTail.pid).split('\n')[0]),
    '…and the stand-in DOES — its blob is two lines built from the live process\'s own argv words (the control below has something to get wrong)',
    { shim: JSON.stringify(shimOut) });
  // (a) the re-root: BOTH /proc reads must miss, or rung 3 decides instead.
  const psIdent = cliIdentityShellFns();
  ok((psIdent.match(/\/proc\/\$1\//g) || []).length === 3,
    'the identity text reaches /proc through exactly the three literals the re-root rewrites (two cmdline + one exe) — the substitution cannot silently miss one');
  const noProcIdent = psIdent.split('/proc/$1/').join(`${pdir}/noproc/$1/`);
  const SHIPPED_PS_LINE = `ps -p "$1" -o args= 2>/dev/null | tr '\\n' ' ' | awk -v i="$(($2 + 1))" '{ print $i }'`;
  // git 77ac0825:src/cli-identity.js — the verbatim pre-r4 fallback line.
  const PRE_R4_PS_LINE = `ps -p "$1" -o args= 2>/dev/null | awk -v i="$(($2 + 1))" '{ print $i }'`;
  ok(noProcIdent !== psIdent && !noProcIdent.includes('/proc/$1/') && noProcIdent.includes(SHIPPED_PS_LINE),
    'the no-/proc copy changed ONLY the /proc root — the `ps` fallback under test is the SHIPPED line, byte for byte');
  const preR4Ps = noProcIdent.replace(SHIPPED_PS_LINE, () => PRE_R4_PS_LINE);
  const psParses = (t) => { try { return spawnSync('sh', ['-n', '-c', t], { timeout: 20000 }).status === 0; } catch { return false; } };
  ok(preR4Ps !== noProcIdent && preR4Ps.includes(PRE_R4_PS_LINE) && !preR4Ps.includes(SHIPPED_PS_LINE) && psParses(preR4Ps),
    'the negative control is that same copy with ONLY the `tr \'\\n\' \' \'` flattening removed — the VERBATIM pre-r4 line — and it PARSES (a broken revert answers NO for everything and fakes a pass)');
  // (b) the environment: the stand-in `ps` first on PATH, for BOTH spellings.
  const psEnv = { ...process.env, PATH: shimDir + ':' + process.env.PATH };
  const shArgvWord = (fns, pid, i) => String(spawnSync('sh', ['-c', `${fns}\nvs_cap vs_argv "$1" ${i}; printf '%s' "$vs_c_v"`, 'sh', String(pid)], { encoding: 'utf8', env: psEnv, timeout: 20000 }).stdout || '');
  const shSaysCli = (fns, pid) => spawnSync('sh', ['-c', `${fns}\nvs_is_cli "$1" claude`, 'sh', String(pid)], { encoding: 'utf8', env: psEnv, timeout: 20000 }).status === 0;
  // The JS twin is DRIVEN into the same rung, not mirrored: the shipped
  // procArgv/isCliProcess run in a child whose /proc reads throw.
  const jsDrv = path.join(pdir, 'noproc-driver.cjs');
  const identPath = new URL('../src/cli-identity.js', import.meta.url).pathname;
  fs.writeFileSync(jsDrv, `const fs = require('fs');
const rr = fs.readFileSync, rl = fs.readlinkSync;
const gone = () => { const e = new Error('ENOENT: this machine has no /proc'); e.code = 'ENOENT'; throw e; };
fs.readFileSync = (p, ...r) => (typeof p === 'string' && /^\\/proc\\/\\d+\\/cmdline$/.test(p) ? gone() : rr(p, ...r));
fs.readlinkSync = (p, ...r) => (typeof p === 'string' && /^\\/proc\\/\\d+\\/exe$/.test(p) ? gone() : rl(p, ...r));
const { procArgv, isCliProcess } = require(${JSON.stringify(identPath)});
const pid = process.argv[2];
console.log(JSON.stringify({ argv: [0, 1, 2].map((i) => procArgv(pid, i)), isCli: isCliProcess(pid, 'claude') }));
`);
  const jsNoProc = (pid) => { try { return JSON.parse(spawnSync(process.execPath, [jsDrv, String(pid)], { encoding: 'utf8', env: psEnv, timeout: 20000 }).stdout || 'null'); } catch { return null; } };
  const jsRows = psFix.map(([n, p]) => [n, jsNoProc(p.pid)]);
  ok(jsRows.every(([, r]) => r && Array.isArray(r.argv) && r.argv[0]),
    'the JS twin really TOOK its own `ps` fallback (the /proc reads throw in that child) and answered from the stand-in blob — it is driven, not mirrored',
    { js: jsRows.map(([n, r]) => [n, r && r.argv[0]]) });
  ok(psFix.every(([n, p], k) => [0, 1, 2].every((i) => shArgvWord(noProcIdent, p.pid, i) === jsRows[k][1].argv[i])),
    'PARITY: the SHIPPED shell `ps` fallback returns the identical word for argv[0..2] on all three fixtures — the two spellings index the same blob the same way',
    { shell: psFix.map(([n, p]) => [n, [0, 1, 2].map((i) => shArgvWord(noProcIdent, p.pid, i))]), js: jsRows.map(([n, r]) => [n, r.argv]) });
  ok(psFix.every(([, p], k) => shSaysCli(noProcIdent, p.pid) === jsRows[k][1].isCli),
    '…and the same VERDICT on all three (this rung reads a blob `ps` already flattened: fixture A is `claude` to BOTH spellings, which the /proc rung calls `tail` — a property of `ps`, not a divergence)',
    { shell: psFix.map(([n, p]) => [n, shSaysCli(noProcIdent, p.pid)]), js: jsRows.map(([n, r]) => [n, r.isCli]) });
  const preR4Verdicts = psFix.map(([n, p]) => [n, shSaysCli(preR4Ps, p.pid)]);
  ok(preR4Verdicts[2][1] === jsRows[2][1].isCli,
    'the control is NOT simply dead: on the fixture with no newline it agrees with the JS twin exactly as the shipped line does');
  ok(preR4Verdicts[0][1] !== jsRows[0][1].isCli && preR4Verdicts[1][1] !== jsRows[1][1].isCli,
    'NEGATIVE CONTROL: without the flattening, `awk` prints field i of EVERY line, so the pre-r4 fallback answers the OPPOSITE of the JS twin on BOTH newline fixtures — a real writer survives the sweep (A) and a `tail` reader is SIGTERMed (B), on the same live pids',
    { preR4: preR4Verdicts, js: jsRows.map(([n, r]) => [n, r.isCli]) });
  for (const p of pprocs) { try { p.kill('SIGKILL'); } catch { } }
  fs.rmSync(pdir, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the `ps`-fallback rung legs'); }

// ── 16. THE REMOTE TERMINATE UNDER BUSYBOX (r5, defect 3). §14 proved
// killPidShell asks THE identity; it drove the script under `sh` only. The
// EXISTENCE test in front of that identity was `C=$(ps -p N -o args=)` — and
// busybox `ps` has no `-p` (measured below, busybox 1.37.0: it prints a usage
// block to stderr and exits 1), so the capture, whose whole point is
// `2>/dev/null`, is EMPTY for a live pid exactly as it is for a dead one. On a
// busybox login shell EVERY Terminate answered VS_GONE and killRemotePid
// returned `{success:true, gone:true}` while NOTHING had been signalled: the
// route said the process was already gone, the card flipped, the CLI kept
// running and kept writing. Same class as (q): the text runs under the REMOTE
// USER'S shell, so "POSIX sh" is the floor and busybox is a real floor.
//
// The fix is a ladder of POSITIVE evidence (`kill -0`, then `[ -d /proc/N ]`,
// then `ps -p N`) plus a fourth outcome — a pid that EXISTS but whose argv and
// exe are both unreadable is VS_UNKNOWN, never "gone" and never "not an agent".
if (fs.existsSync('/proc/self')) {
  const { spawn, spawnSync } = await import('node:child_process');
  const { killPidShell: kps } = require('../src/hosts.js');
  const bbPath = ['/usr/bin/busybox', '/bin/busybox'].find((p) => fs.existsSync(p));
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-bbkill-'));
  const btx = path.join(bdir, '.claude', 'projects', '-w', 'rid.jsonl');
  fs.mkdirSync(path.dirname(btx), { recursive: true });
  fs.writeFileSync(btx, '{}\n');
  const bprocs = [];
  const bReader = () => { const p = spawn('tail', ['-f', btx], { cwd: os.tmpdir(), stdio: 'ignore' }); bprocs.push(p); return p; };
  const bCli = (name, sub) => {
    const img = path.join(bdir, sub, name);
    fs.mkdirSync(path.dirname(img), { recursive: true });
    fs.copyFileSync(fs.realpathSync('/bin/sh'), img); fs.chmodSync(img, 0o755);
    const p = spawn(img, ['-c', 'read x'], { cwd: os.tmpdir(), stdio: ['pipe', 'ignore', 'ignore'] });
    bprocs.push(p); return p;
  };
  const bReaderCtl = bReader(), bReaderShip = bReader(), bReaderUnk = bReader();
  const bCliCtl = bCli('claude', 'b1'), bCliShip = bCli('codex', 'b2');
  const bArgv = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
  { const t = Date.now(); while (bprocs.some((p) => bArgv(p.pid).length === 0) && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 20)); }
  const bAlive = (p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } };
  ok(bprocs.every((p) => bArgv(p.pid).length > 0 && bAlive(p)),
    'every busybox kill-path fixture is live and has EXEC\'d its own argv before any verdict is taken',
    { argvs: bprocs.map((p) => bArgv(p.pid).join(' ').slice(0, 50)) });
  if (!bbPath) console.log('  · busybox absent — the busybox kill-path legs below are SKIPPED (install busybox to run them)');
  const runIn = (argv, script) => {
    const r = spawnSync(argv[0], [...argv.slice(1), '-c', script], { encoding: 'utf8', timeout: 20000 });
    return String(r.stdout || '').trim();
  };
  const bbArgv = bbPath ? [bbPath, 'sh'] : null;
  // busybox `ps` really cannot answer the pre-r5 probe — asserted, not assumed.
  const bbPsOut = bbPath ? spawnSync(bbPath, ['ps', '-p', String(bReaderCtl.pid), '-o', 'args='], { encoding: 'utf8' }) : null;
  ok(!bbPath || ((bbPsOut.stdout || '') === '' && /invalid option/.test(bbPsOut.stderr || '')),
    'MEASURED: busybox `ps -p N -o args=` prints NOTHING on stdout and complains on stderr — the pre-r5 capture is empty for a LIVE pid',
    { stdout: bbPsOut && bbPsOut.stdout, stderr: bbPsOut && String(bbPsOut.stderr || '').split('\n')[0] });
  // git ddab79bf:src/hosts.js — the verbatim pre-r5 script.
  const preR5Kill = (p) => `${cliIdentityShellFns()}
C=$(ps -p ${p} -o args= 2>/dev/null)
if [ -z "$C" ]; then echo VS_GONE
elif vs_is_cli ${p} claude || vs_is_cli ${p} codex; then kill -TERM ${p} && echo VS_OK
else echo VS_NOTAGENT
fi`;
  const ctlReader = bbPath ? runIn(bbArgv, preR5Kill(bReaderCtl.pid)) : null;
  const ctlCli = bbPath ? runIn(bbArgv, preR5Kill(bCliCtl.pid)) : null;
  await new Promise((r) => setTimeout(r, 250));
  ok(!bbPath || (ctlReader === 'VS_GONE' && ctlCli === 'VS_GONE' && bAlive(bReaderCtl) && bAlive(bCliCtl)),
    'NEGATIVE CONTROL: under busybox the pre-r5 script answers VS_GONE for BOTH a live reader AND a live `claude` — killRemotePid would have returned {success:true, gone:true} with nothing signalled, and both processes are still running',
    { reader: ctlReader, cli: ctlCli, readerAlive: bAlive(bReaderCtl), cliAlive: bAlive(bCliCtl) });
  ok(!bbPath || runIn(bbArgv, kps(bReaderShip.pid)) === 'VS_NOTAGENT',
    'the SHIPPED script under busybox REFUSES the reader by name (VS_NOTAGENT) instead of calling it gone');
  ok(!bbPath || bAlive(bReaderShip), '…and that reader is still alive');
  const bbKilled = bbPath ? runIn(bbArgv, kps(bCliShip.pid)) : null;
  await new Promise((r) => setTimeout(r, 300));
  ok(!bbPath || (bbKilled === 'VS_OK' && !bAlive(bCliShip)),
    'POSITIVE CONTROL: a real `codex` IS terminated by the shipped script under busybox — the ladder did not simply stop answering', { out: bbKilled });
  const bDead = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
  ok(!bbPath || runIn(bbArgv, kps(bDead)) === 'VS_GONE',
    '…and a pid that is really not there still answers VS_GONE under busybox (the ladder is not stuck on "alive")');
  // THE FOURTH OUTCOME. "Alive but unreadable" is reachable exactly where the
  // incident lives: no /proc (macOS/BSD) AND a `ps` that cannot answer -p.
  // Re-root every /proc literal in the WHOLE script — identity, vs_alive's
  // `[ -d /proc/N ]` and vs_known's exe read — because that is one fact about
  // the machine, not three edits.
  const shippedKill = kps(bReaderUnk.pid);
  const noProcKill = shippedKill.split('/proc/').join(`${bdir}/noproc/`);
  ok(noProcKill !== shippedKill && !noProcKill.includes('/proc/') && noProcKill.includes('kill -0 "$1"'),
    'the no-/proc copy of the kill script changed ONLY the /proc root — vs_alive\'s `kill -0` rung and the identity text are the shipped bytes');
  const unkOut = bbPath ? runIn(bbArgv, noProcKill) : null;
  const unkCtl = bbPath ? runIn(bbArgv, noProcKill.replace(/if ! vs_alive \d+; then[\s\S]*$/, () => {
    const p = bReaderUnk.pid;
    return `C=$(ps -p ${p} -o args= 2>/dev/null)\nif [ -z "$C" ]; then echo VS_GONE\nelif vs_is_cli ${p} claude || vs_is_cli ${p} codex; then kill -TERM ${p} && echo VS_OK\nelse echo VS_NOTAGENT\nfi`;
  })) : null;
  await new Promise((r) => setTimeout(r, 250));
  ok(!bbPath || (unkOut === 'VS_UNKNOWN' && bAlive(bReaderUnk)),
    'no /proc AND a `ps` that cannot answer ⇒ VS_UNKNOWN: the pid is known ALIVE (kill -0) and NOTHING about it could be read, so the script says so instead of guessing — and the process survives',
    { out: unkOut });
  ok(!bbPath || unkCtl === 'VS_GONE',
    'NEGATIVE CONTROL: the pre-r5 decision block on that SAME machine shape answers VS_GONE — the outcome the fourth verdict exists to stop', { out: unkCtl });
  // …and the CALLER must not turn either honest refusal into a success.
  const { HostManager: HM5 } = require('../src/hosts.js');
  const hmDir5 = path.join(bdir, 'hm');
  fs.mkdirSync(hmDir5, { recursive: true });
  const hm5 = new HM5({ dataDir: hmDir5 });
  hm5._state.hosts = [{ id: 'h5', name: 'h5', transport: 'dial', host: 'x', user: 'u' }];
  hm5.invalidateDiscovery = () => { };
  const stubOut = (text) => { hm5.deviceBounded = async () => ({ async runCmd() { return { stdout: text }; } }); };
  const callKill5 = async (text) => { stubOut(text); try { return { ok: await hm5.killRemotePid('h5', 4242) }; } catch (e) { return { err: e.message }; } };
  const unknownReply = await callKill5('VS_UNKNOWN\n');
  ok(/could not be read/.test(unknownReply.err || '') && !unknownReply.ok,
    'killRemotePid THROWS on VS_UNKNOWN with an explanation — never {success:true}, and never the generic `kill failed: <token>` line', { unknownReply });
  const goneReply = await callKill5('VS_GONE\n');
  const okReply = await callKill5('VS_OK\n');
  ok(goneReply.ok?.success === true && goneReply.ok?.gone === true && okReply.ok?.success === true && okReply.ok?.gone === false,
    '…and the two outcomes that MAY return still do (VS_GONE ⇒ gone:true, VS_OK ⇒ gone:false) — the new branch did not swallow them', { goneReply, okReply });
  // STRUCTURAL: the busybox-unsafe probe must not come back, and the ladder is
  // now the SHARED text — r6 killed the enumerated sibling instead of reasoning
  // about it (§17).
  const kpsText = kps(4242);
  ok(/kill -0 "\$1" 2>\/dev\/null && return 0/.test(kpsText) && !/^C=\$\(ps -p \d+ -o args=/m.test(kpsText),
    'WIRING PIN: the shipped kill script probes existence with `kill -0` and carries no `C=$(ps -p N -o args=)` existence capture');
  ok(/^C=\$\(ps -p \d+ -o args=/m.test(preR5Kill(4242)),
    'NEGATIVE CONTROL: that pin names a shape that really exists — it FIRES on the verbatim pre-r5 script');
  ok(kpsText.includes(cliIdentity.pidAliveShellFn()),
    'WIRING PIN: killPidShell embeds the SHARED `vs_alive` text verbatim — the ladder has one author (B-3185 r6)');
  for (const p of bprocs) { try { p.kill('SIGKILL'); } catch { } }
  fs.rmSync(bdir, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the busybox kill-path legs'); }

// ── 17. THE SIGNAL VERDICT UNDER BUSYBOX (r6, found by review). §16 fixed the
// existence probe on ONE kill path and ENUMERATED the other —
// `src/server/sysinfo-wiring.js signalProc`, the sidebar process manager's
// Terminate — leaving its `ps -p` alive on a hand-written reason: "there it
// sits on the FAILURE branch of a kill that was already ATTEMPTED, so it can
// only mislabel EPERM as ESRCH, never manufacture a success."
//
// That script has TWO `ps -p` calls and the reason was only true of the
// second. The FIRST is the post-signal aliveness check on the SUCCESS branch,
// and there a busybox-blind probe manufactures exactly the outcome §16 exists
// to stop: `kill -TERM` succeeds, `ps -p` cannot answer, so the script says
// OK-GONE and signalProc returns `{ok:true, gone:true}` — the row flips to
// gone while the process runs on. Measured below on a live process with
// `trap "" TERM`, plus the failure branch's mislabel on a real foreign pid.
//
// THE FIX IS NOT A SECOND CORRECT REASON, IT IS ONE PROBE: `vs_alive` moved to
// src/cli-identity.js and BOTH scripts embed it, so there is no per-site
// judgement left to make — and §17f sweeps the tree so a THIRD site cannot
// quietly grow one.
if (fs.existsSync('/proc/self')) {
  const { spawn, spawnSync } = await import('node:child_process');
  const { signalVerdictScript } = require('../src/server/sysinfo-wiring.js');
  const bbPath = ['/usr/bin/busybox', '/bin/busybox'].find((p) => fs.existsSync(p));
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sigv-'));
  const spids = [];
  // TWO fixture shapes, because the two verdicts differ only in what the
  // process does with the signal: one IGNORES SIGTERM (must read OK-ALIVE),
  // one accepts it (must read OK-GONE). The bug is invisible against the
  // second — which is why "it reported gone" always looked right.
  //
  // THE FIXTURES ARE DOUBLE-FORKED ORPHANS, and that is not tidiness. A
  // process whose parent has not reaped it is a ZOMBIE, and a zombie reads
  // ALIVE to every existence probe there is — `kill -0`, `/proc/<pid>`, procps
  // `ps -p`, and the local branch's own `process.kill(pid, 0)` (asserted
  // below, because a divergence there would be a REAL behaviour change). A
  // node-parented fixture is guaranteed to be one here: `spawnSync` blocks the
  // event loop for the whole verdict, so node cannot reap while the script
  // runs. Orphaning hands the reap to init/the user subreaper, which is also
  // the real shape — the processes this route signals are never our children.
  const orphan = (body, tag) => {
    const pf = path.join(sdir, 'pid-' + tag);
    spawnSync('/bin/sh', ['-c', `setsid /bin/sh -c 'echo $$ > ${pf}; ${body}' </dev/null >/dev/null 2>&1 &`], { cwd: os.tmpdir() });
    // WAIT FOR A PARSEABLE pid, NOT FOR THE FILE: `echo $$ >` creates it empty
    // first, so an existsSync spin reads '' ⇒ pid 0 ⇒ the builder's own
    // validation throws and ABORTS the suite mid-section (observed once, and
    // it is exactly why the count of red asserts in a revert run is itself
    // evidence: the first revert check reported "1 RED" because the run died
    // here rather than because the fix was untested).
    const t = Date.now();
    let n = 0;
    while (Date.now() - t < 10000) {
      try { n = Number(String(fs.readFileSync(pf, 'utf8')).trim()); } catch { n = 0; }
      if (Number.isInteger(n) && n > 1) break;
      spawnSync('/bin/true'); // yield without needing the (blocked) event loop
    }
    if (!(Number.isInteger(n) && n > 1)) throw new Error(`orphan fixture ${tag} never published a pid`);
    spids.push(n);
    return n;
  };
  const sIgnore = orphan('trap "" TERM; sleep 60', 'i');    // survives a TERM
  const sIgnoreCtl = orphan('trap "" TERM; sleep 60', 'c');  // the same, for the pre-r6 control
  const sDies = orphan('exec sleep 60', 'd');                // dies on a TERM
  await new Promise((r) => setTimeout(r, 400));
  const sAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pState = (pid) => { try { return String(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[0]; } catch { return 'ABSENT'; } };
  ok(spids.every((p) => sAlive(p) && pState(p) !== 'Z'),
    'every signal-verdict fixture is live (and NOT a zombie) before any verdict is taken', { states: spids.map(pState) });
  // THE ZOMBIE EDGE, pinned so the ladder cannot be blamed for it later: a
  // reaped-pending process answers ALIVE to all four probes — the shipped
  // ladder, this box's procps `ps -p`, and the LOCAL branch's `process.kill`.
  // The ladder changed nothing here; it is the kernel's answer, and it is the
  // same one the pre-r6 spelling gave on a non-busybox host.
  {
    const z = spawn('/bin/sh', ['-c', 'exec sleep 60'], { stdio: 'ignore', cwd: os.tmpdir() });
    await new Promise((r) => setTimeout(r, 250));
    try { process.kill(z.pid, 'SIGKILL'); } catch { }
    const t0 = Date.now();
    while (pState(z.pid) !== 'Z' && Date.now() - t0 < 3000) spawnSync('/bin/true'); // block the loop so node cannot reap
    const zZombie = pState(z.pid) === 'Z';
    const zLadder = String((spawnSync('/bin/sh', ['-c', `${cliIdentity.pidAliveShellFn()}\nif vs_alive ${z.pid}; then echo ALIVE; else echo GONE; fi`], { encoding: 'utf8' }).stdout) || '').trim();
    const zPs = spawnSync('ps', ['-p', String(z.pid)], { stdio: 'ignore' }).status === 0;
    ok(!zZombie || (zLadder === 'ALIVE' && zPs && sAlive(z.pid)),
      'HONEST EDGE: a ZOMBIE reads ALIVE to the shared ladder, to procps `ps -p` and to the local branch\'s `process.kill(pid,0)` alike — the ladder introduced no divergence, and it is why the fixtures above are orphans',
      { zZombie, zLadder, zPs });
    if (!zZombie) console.log('  · could not produce a zombie in 3s — the zombie-edge leg asserted vacuously');
  }
  const runIn2 = (argv, script) => String((spawnSync(argv[0], [...argv.slice(1), '-c', script], { encoding: 'utf8', timeout: 20000 }).stdout) || '').trim();
  const bbArgv2 = bbPath ? [bbPath, 'sh'] : null;
  if (!bbPath) console.log('  · busybox absent — the §17 busybox legs are SKIPPED (install busybox to run them)');
  // (a) THE CAPABILITY THE PRE-r6 PROBE ASSUMED — asserted, not inherited from
  // §16 (that leg measured `ps -p N -o args=`; this one measures the QUIET
  // form the signal script actually used).
  const bbQuiet = bbPath ? spawnSync(bbPath, ['sh', '-c', `if ps -p ${sIgnore} >/dev/null 2>&1; then echo ALIVE; else echo GONE; fi`], { encoding: 'utf8' }) : null;
  ok(!bbPath || (String(bbQuiet.stdout || '').trim() === 'GONE' && sAlive(sIgnore)),
    'MEASURED: under busybox `ps -p N >/dev/null 2>&1` answers NON-ZERO for a LIVE pid — the quiet existence form the signal script used is blind there too',
    { out: bbQuiet && String(bbQuiet.stdout || '').trim() });
  // git cf20753a:src/server/sysinfo-wiring.js — the verbatim pre-r6 script.
  const preR6Sig = (pid, sig) => `if kill -${sig} ${pid} 2>/dev/null; then `
    + (sig === 'STOP' || sig === 'CONT' ? 'echo OK; '
      : `sleep 0.5; if ps -p ${pid} >/dev/null 2>&1; then echo OK-ALIVE; else echo OK-GONE; fi; `)
    + `else if ps -p ${pid} >/dev/null 2>&1; then echo EPERM; else echo ESRCH; fi; fi`;
  // (b) NEGATIVE CONTROL: the pre-r6 script manufactures the false success.
  const ctlOut = bbPath ? runIn2(bbArgv2, preR6Sig(sIgnoreCtl, 'TERM')) : null;
  ok(!bbPath || (ctlOut === 'OK-GONE' && sAlive(sIgnoreCtl)),
    'NEGATIVE CONTROL: under busybox the pre-r6 script answers OK-GONE for a LIVE process that ignored the SIGTERM — signalProc would have returned {ok:true, gone:true} and the row would read "gone" while the process kept running',
    { out: ctlOut, stillAlive: sAlive(sIgnoreCtl) });
  // (c) the SHIPPED builder, same machine shape, same fixture shape.
  const shipAlive = bbPath ? runIn2(bbArgv2, signalVerdictScript(sIgnore, 'TERM')) : null;
  ok(!bbPath || (shipAlive === 'OK-ALIVE' && sAlive(sIgnore)),
    'the SHIPPED script under busybox says OK-ALIVE for that same process — and it is still alive', { out: shipAlive });
  // (d) POSITIVE CONTROL: the ladder is not simply stuck on "alive".
  const shipGone = bbPath ? runIn2(bbArgv2, signalVerdictScript(sDies, 'TERM')) : null;
  await new Promise((r) => setTimeout(r, 250));
  ok(!bbPath || (shipGone === 'OK-GONE' && pState(sDies) === 'ABSENT'),
    'POSITIVE CONTROL: a process that DOES die from the TERM still reads OK-GONE under busybox — the ladder answers "gone" when the pid is really gone (and /proc agrees: fully reaped, not a zombie)',
    { out: shipGone, state: pState(sDies) });
  const deadPid = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
  ok(!bbPath || runIn2(bbArgv2, signalVerdictScript(deadPid, 'TERM')) === 'ESRCH',
    '…and a pid that was never there reads ESRCH (the kill itself failed, and no rung can see it)');
  // (e) THE FAILURE BRANCH'S OWN LIE, on a REAL EPERM (no simulation: a live
  // process this uid may not signal). Skipped rather than faked where the
  // environment cannot produce one (running as root, or a lone-uid container).
  let foreignPid = null;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const n = Number(d);
    if (n <= 1) continue;
    try { process.kill(n, 0); } catch (e) { if (e.code === 'EPERM') { foreignPid = n; break; } }
  }
  if (!foreignPid) console.log('  · no live pid this uid may not signal — the §17 EPERM legs are SKIPPED (running as root?)');
  ok(!bbPath || !foreignPid || runIn2(bbArgv2, signalVerdictScript(foreignPid, 'TERM')) === 'EPERM',
    'the SHIPPED script under busybox explains a permission-denied kill as EPERM — the /proc rung sees a process we may not signal', { foreignPid });
  ok(!bbPath || !foreignPid || runIn2(bbArgv2, preR6Sig(foreignPid, 'TERM')) === 'ESRCH',
    'NEGATIVE CONTROL: the pre-r6 script called that same live process ESRCH — "no such process (already gone)", the r4 objection the busybox-blind probe re-created', { foreignPid });
  // (f) THE CALLER must map each verdict honestly — the pure text above is only
  // half the fix if signalProc reads it wrong.
  const { create: createSysWiring } = require('../src/server/sysinfo-wiring.js');
  const sigReply = async (text) => {
    const stubHosts = {
      get: () => ({ id: 'h6', transport: 'dial' }),
      deviceBounded: async () => ({ async runCmd() { return { stdout: text }; } }),
    };
    const { signalProc } = createSysWiring({ getHosts: () => stubHosts });
    try { return { ok: await signalProc('h6', 4242, 'TERM') }; } catch (e) { return { err: e.message }; }
  };
  const rAlive = await sigReply('OK-ALIVE\n');
  const rGone = await sigReply('OK-GONE\n');
  const rEperm = await sigReply('EPERM\n');
  const rEsrch = await sigReply('ESRCH\n');
  ok(rAlive.ok?.gone === false && rGone.ok?.gone === true
    && /permission denied/.test(rEperm.err || '') && /no such process/.test(rEsrch.err || ''),
    'signalProc maps the four verdicts honestly (OK-ALIVE ⇒ gone:false, OK-GONE ⇒ gone:true, EPERM/ESRCH ⇒ explained throws)',
    { rAlive, rGone, rEperm, rEsrch });
  // (g) STRUCTURAL: one probe, one author, and the kill still comes FIRST.
  const sigText = signalVerdictScript(4242, 'TERM');
  ok(sigText.includes(cliIdentity.pidAliveShellFn()) && !/ps -p 4242/.test(sigText),
    'WIRING PIN: the signal script embeds the SHARED `vs_alive` text verbatim and carries no bare `ps -p <pid>` existence test');
  ok(/ps -p \d+/.test(preR6Sig(4242, 'TERM')),
    'NEGATIVE CONTROL: that pin names a shape that really existed — it FIRES on the verbatim pre-r6 script');
  ok(sigText.indexOf('if kill -TERM 4242') < sigText.indexOf('vs_alive 4242'),
    'the kill is still ATTEMPTED before any existence probe runs — the probe explains an outcome, it never gates one (no probe-then-kill TOCTOU)');
  const badPids = [1, 0, -5, 1.5, NaN, '4242; rm -rf /'];
  ok(badPids.every((p) => { try { signalVerdictScript(p, 'TERM'); return false; } catch { return true; } })
    && (() => { try { signalVerdictScript(4242, 'USR1'); return false; } catch { return true; } })(),
    'the builder validates pid and signal ITSELF — a hostile pid never reaches the shell text, whatever the caller checked');
  // (h) THE STANDING SWEEP (the point of (g) in the B-3185 essay, applied to
  // the probe rather than the identity): NO `ps -p` may serve as an EXISTENCE
  // test on any kill/signal path. Every surviving occurrence is listed here
  // WITH its reason, and a dead entry fails too — an allowlist nobody prunes
  // is how the last one survived.
  //
  // r7 (found by review): that invariant was true and the INSTRUMENT enforcing
  // it was a HAND-WRITTEN list of seven files. A hand list is the same
  // instrument this bug has already defeated three times — r4 found the retired
  // rule alive on a kill path nobody had counted (hosts.js killRemotePid), r5
  // counted the sibling and let it go, r6 found that the reason r5 wrote for it
  // described only the SECOND of that script's two `ps -p` calls. A hand list
  // enforces a rule exactly where its author already looked, which is never
  // where the next one lands. So the file set is DERIVED, by grep, from the
  // question the rule is about: every non-test file under src/, data/bin/ and
  // scripts/ — plus the repo-root scripts, where server.js lives — whose text
  // SENDS OR PROBES A SIGNAL (kill -TERM/-9/-0/…, SIGTERM/SIGKILL, pkill,
  // process.kill(, killRemotePid, signalProc, vs_alive). Embedded remote
  // scripts ride along twice: as the source they are written in, and (leg (k))
  // as the text their builders actually EMIT. The derived list is PRINTED, so
  // a reviewer checks what was swept instead of trusting this comment's count
  // of it.
  //
  // A grep OVER-approximates on purpose and the printed list says so: the
  // i18n dictionaries and the process-manager UI match on the WORD `SIGSTOP`,
  // the adapters on `SIGINT`. A false positive only widens where the rule is
  // enforced; a false NEGATIVE is the entire bug this leg exists for.
  // (r7 verify: the alternation also has to name the OTHER spellings a kill
  // takes — `kill -s TERM`, numeric `kill -15`, bare `kill "$pid"` and node's
  // `handle.kill()` — or six real terminators stay outside the swept set.)
  const KILL_MARKERS = /kill\s+-(?:TERM|KILL|HUP|INT|QUIT|STOP|CONT|USR1|USR2|9|0)\b|kill\s+-s\s|kill\s+-\d+\b|kill\s+[\"'$]|\.kill\s*\(|\bSIG(?:TERM|KILL|HUP|INT|QUIT|STOP|CONT)\b|\bpkill\b|process\.kill\s*\(|\bkillRemotePid\b|\bsignalProc\b|\bvs_alive\b/;
  const SWEEP_ROOTS = ['src', 'data/bin', 'scripts'];
  const CODE_EXT = /\.(?:js|mjs|cjs|sh)$/;
  const PS_P_ALLOWED = [
    { file: 'src/cli-identity.js', needle: `ps -p "$1" -o args= 2>/dev/null | tr`,
      why: 'ARGV READ (vs_argv, the no-/proc rung). It asks for a VALUE, never for existence: a `ps` that cannot answer yields an empty word, and an empty argv word already means "no evidence" to vs_is_cli / vs_known.' },
    { file: 'src/cli-identity.js', needle: 'ps -p "$1" >/dev/null 2>&1',
      why: 'THE no-/proc rung of `vs_alive` itself — the one existence `ps -p` in the tree, and the LAST rung of a positive-evidence ladder (kill -0, then [ -d /proc/N ]), so a busybox `ps` that cannot answer merely declines to add evidence instead of deciding.' },
    { file: 'src/cli-identity.js', needle: `execImpl('ps', ['-p', String(pid), '-o', 'uid=,args=']`,
      why: 'ARGV+UID READ (readPsIdentity, the no-/proc rung of the {uid, argv} ladder every signalling caller shares since B-eac2 residual (c) — opencode-serve\'s keeper and the shipped ssh op were its other spellings). It asks for a VALUE: an unanswerable `ps` yields `null`, which the callers read as "no evidence", never as "gone". Existence is `kill -0` (pidAlive / pidAliveShellFn), and classifyRecordedPid turns this null into the verdicts that REFUSE to signal, never into a licence to.' },
    { file: 'data/bin/vibespace-opencode-op', needle: `execImpl('ps', ['-p', String(pid), '-o', 'uid=,args=']`,
      why: 'The SHIPPED PARITY TWIN of the row above — a checkout-less ssh host cannot require src/cli-identity.js, which is the documented exception the usage scanner also lives under. Same ladder, same value-not-existence rule, driven against the local rung by scripts/test-opencode-remote.mjs.' },
    { file: 'src/writer-sweep.js', needle: `ps -p "$1" -o args= 2>/dev/null | tr ' '`,
      why: 'ARGV READ (vs_sid_of: the PROTECT session id out of argv). Existence is the caller\'s open-fd evidence, not this line.' },
    { file: 'src/writer-sweep.js', needle: `ps -p "$1" -E -o command=`,
      why: 'ENVIRON READ (vs_sid_of\'s BSD rung, same value, same non-decision).' },
    // ── the JS spelling (`execFileSync('ps', ['-p', …])`), invisible to this
    //    sweep until B-eac2 residual (c) taught `namesPsP` about it. Every one
    //    of these existed before that and every one of them is a VALUE read;
    //    what was missing was the REASON, which is the thing the sweep is for.
    { file: 'src/cli-identity.js', needle: `execFileSync('ps', ['-p', String(pid), '-o', 'args=']`,
      why: 'ARGV READ — the JS twin of vs_argv\'s allowlisted `ps -p "$1" -o args=` rung, same non-decision: an unanswerable `ps` yields the empty word that already means "no evidence" to isCliProcess.' },
    { file: 'src/agentd/agentd.js', needle: `spawnSync('ps', ['-p', String(pid), '-o', 'lstart=']`,
      why: 'START-TIME READ (the no-/proc rung of the pid-identity stamp): it makes a recycled pid DISTINGUISHABLE from the original. An unanswerable `ps` returns \'\' = "no stamp", which is compared as a non-match and therefore never credits a stranger with being ours.' },
    { file: 'src/agentd/agentd.js', needle: `execFileSync('ps', ['-p', String(pid), '-o', 'command=']`,
      why: 'ARGV READ inside the single-instance lock check, and existence is decided on the NEXT line by `process.kill(pid, 0)`. The empty answer is deliberately treated as "could be ours" (it BLOCKS a second daemon) — the conservative direction, the opposite of a false all-clear.' },
    { file: 'src/session-store.js', needle: `execFileSync('ps', ['-p', String(pid), '-o', 'ppid=']`,
      why: 'PARENT READ (tmux pane lookup, sync twin): the answer names a pane or does not. It signals nothing and decides no liveness.' },
    { file: 'src/session-store.js', needle: `execFileP('ps', ['-p', String(pid), '-o', 'ppid=']`,
      why: 'PARENT READ (the async twin of the line above, on the discovery sweep path).' },
    { file: 'src/session-store.js', needle: `execFileP('ps', ['-p', String(pid), '-o', 'comm=']`,
      why: 'NAME READ — `isProcessClaudeAsync`, the documented B-3185 r4 twin: its ONE caller is isLockClaude, it decides whether a CARD READS RUNNING, and it is on no kill path (the /api/kill-pid gate asks src/cli-identity.js instead). Kept because the path that reaches it is macOS-per-lock, where the shared predicate is synchronous — a per-lock blocking fork is the 2.242.0 stall.' },
    { file: 'scripts/vibespace-agentd-install.sh', needle: `OLDCMD=$(ps -p "$OLDPID" -o command=`,
      why: 'ARGV READ; existence was already decided one line above by `kill -0 "$OLDPID"`, and an unreadable answer falls through to NOT killing.' },
    { file: 'scripts/vibespace-agentd-install.sh', needle: `case "$(ps -p "$P" -o command=`,
      why: 'ARGV READ gated by `kill -0 "$P" || return 1`, and daemon_up explicitly ACCEPTS the empty answer (`""` is a matching case) — a `ps` that cannot answer never reports a healthy daemon as down.' },
  ];
  const isComment = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
  // `ps -p` HAS TWO SPELLINGS AND ONLY ONE OF THEM IS A STRING (B-eac2 residual
  // (c)). Shell text says `ps -p "$1"`; JS says
  // `execFileSync('ps', ['-p', String(pid), …])`, where the flag and the
  // program never touch. The sweep's whole claim is "no `ps -p` on a
  // kill/signal path outside the allowlist", and until this pattern existed the
  // claim silently excluded every JS caller — including src/opencode-serve.js,
  // which killPid()s, and which carried an unlisted uid+argv read for three
  // rounds while this suite stayed green. Both spellings are the same probe and
  // owe the same reason.
  const PS_ARGV_JS = /['"`]ps['"`]\s*,\s*\[\s*['"`]-p['"`]/;
  const namesPsP = (line) => line.includes('ps -p') || PS_ARGV_JS.test(line);
  // The line scanner, used against BOTH files on disk and the shell text a
  // builder composes at RUNTIME (leg (k) — a source scan cannot see a probe
  // assembled from pieces).
  const scanPsP = (label, text, allow) => {
    const stray = [], hit = new Set();
    String(text).split('\n').forEach((line, i) => {
      if (isComment(line) || !namesPsP(line)) return;
      const a = allow.find((x) => (x.file === label || x.file === '*') && line.includes(x.needle));
      if (a) hit.add(a2key(a)); else stray.push(`${label}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
    return { stray, hit };
  };
  // GENERATED files are a THIRD bucket, not a skip and not an allowlist row.
  // `data/bin/vibespace-agentd.js` is the esbuild bundle of src/agentd/** — it
  // carries cli-identity's and writer-sweep's `ps -p` lines VERBATIM, under a
  // filename that can never appear in a per-file allowlist (and rebuilding it
  // is what every developer does before running a suite, so a naive sweep goes
  // red on a clean tree — measured here before this bucket existed). Skipping
  // it outright would be an enumeration by another name, so instead the rule
  // for a generated file is STRICTER and needs no author: every `ps -p` line in
  // it must appear VERBATIM in an AUTHORED file this sweep already walked. A
  // build step that injected a probe of its own has nowhere to hide, and the
  // authored copy is still the only place a reason may be written.
  //
  // GITIGNORED is the predicate on purpose, and it is not "trusted": a file git
  // is told to ignore is not part of the shipped SOURCE, so "which author owes
  // this line a reason" is not a question it can answer — "does it faithfully
  // copy text that already has one" is. Everything else, tracked or untracked,
  // is AUTHORED and gets the strict allowlist (see control ⑥: the temp roots
  // have no git at all, so nothing there can claim this bucket).
  const gitIgnoredSet = (root, rels) => {
    if (!rels.length) return new Set();
    // No git (the temp roots in (j)) ⇒ empty ⇒ every file counts as AUTHORED,
    // which is the safe direction: an unprovable file gets the strict allowlist.
    const r = spawnSync('git', ['check-ignore', '--stdin'], { cwd: root, input: rels.join('\n') + '\n', encoding: 'utf8', maxBuffer: 32 << 20 });
    return new Set(String(r.stdout || '').split('\n').filter(Boolean));
  };
  // THE DERIVATION, parameterised by ROOT precisely so the controls in (j) can
  // point the SHIPPED sweep at a tree that DOES contain the retired shape — a
  // sweep only ever run against a clean tree is a sweep proven to say nothing.
  const sweepKillPaths = (root, allow, generatedFor = gitIgnoredSet) => {
    const all = [];
    const walk = (rel) => {
      const abs = path.join(root, rel);
      let st; try { st = fs.statSync(abs); } catch { return; }
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(abs).sort()) {
          if (e === 'node_modules' || e === '.git') continue;
          walk(path.join(rel, e));
        }
        return;
      }
      all.push(rel);
    };
    for (const r of SWEEP_ROOTS) walk(r);
    for (const e of fs.readdirSync(root).sort()) {   // the repo ROOT itself: server.js, run.sh, install.sh
      try { if (fs.statSync(path.join(root, e)).isFile()) all.push(e); } catch { }
    }
    const gen = generatedFor(root, all);
    const files = [], generated = [], stray = [], hit = new Set(), skipped = [], genLines = [];
    for (const rel of all) {
      // The SUITES are excluded on purpose, and this file is the proof: a
      // regression test for a retired shape has to be able to write it down.
      if (/^test-/.test(path.basename(rel))) { skipped.push(rel); continue; }
      let buf; try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; }
      if (buf.length > (4 << 20) || buf.includes(0)) continue;    // oversized / binaries
      const src = buf.toString('utf8');
      if (!CODE_EXT.test(rel) && !src.startsWith('#!')) continue; // .md/.json, and the extension-less agent CLIs by shebang
      if (!KILL_MARKERS.test(src)) continue;
      if (gen.has(rel)) {
        generated.push(rel);
        src.split('\n').forEach((line, i) => {
          if (!isComment(line) && line.includes('ps -p')) genLines.push({ at: `${rel}:${i + 1}`, text: line.trim() });
        });
        continue;
      }
      files.push(rel);
      const r = scanPsP(rel, src, allow);
      stray.push(...r.stray);
      for (const k of r.hit) hit.add(k);
    }
    // Every authored `ps -p` line, for the generated bucket to be judged against.
    const authored = new Set();
    for (const rel of files) {
      for (const line of fs.readFileSync(path.join(root, rel), 'utf8').split('\n')) {
        if (!isComment(line) && line.includes('ps -p')) authored.add(line.trim());
      }
    }
    const genUnauthored = genLines.filter((l) => !authored.has(l.text)).map((l) => `${l.at}: ${l.text.slice(0, 90)}`);
    return { files, generated, stray, hit, skipped, genUnauthored };
  };
  const REPO_ROOT = new URL('..', import.meta.url).pathname;
  const swp = sweepKillPaths(REPO_ROOT, PS_P_ALLOWED);
  console.log(`  · STANDING SWEEP derived ${swp.files.length} files that send or name a signal (by grep, not by hand — deliberately over-inclusive):`);
  for (let i = 0; i < swp.files.length; i += 4) console.log('      ' + swp.files.slice(i, i + 4).join('  '));
  ok(!swp.stray.length,
    'STANDING SWEEP: no `ps -p` on any kill/signal path outside the allowlist — a new one must be added there WITH its reason (existence tests are not allowed at all)',
    { stray: swp.stray });
  const deadEntries = PS_P_ALLOWED.filter((a) => !swp.hit.has(a2key(a))).map((a) => `${a.file}: ${a.needle}`);
  ok(!deadEntries.length,
    '…and every allowlist entry still names a line that EXISTS — a stale exemption is how the last busybox-blind probe survived a round of review',
    { deadEntries });
  if (swp.generated.length) console.log(`  · …plus ${swp.generated.length} GENERATED kill/signal-path file(s), judged against the authored text instead of the allowlist: ${swp.generated.join(' ')}`);
  ok(!swp.genUnauthored.length,
    'a GENERATED kill/signal-path file (the esbuild daemon bundle) carries no `ps -p` line that is not VERBATIM in an authored file the sweep walked — a build step cannot introduce a probe, and the reason still lives with the author',
    { genUnauthored: swp.genUnauthored, generated: swp.generated });
  // (i) THE r7 DEFECT ITSELF, pinned in both directions.
  // git 1d81ff5c:scripts/test-writer-sweep.mjs — the verbatim r6 hand list.
  const R6_HAND = new Set(['src/cli-identity.js', 'src/writer-sweep.js', 'src/hosts.js',
    'src/server/sysinfo-wiring.js', 'src/session-store.js', 'src/routes/sessions.js',
    'scripts/vibespace-agentd-install.sh',
    ...String(spawnSync('git', ['ls-files', 'data/bin'], { encoding: 'utf8', cwd: REPO_ROOT }).stdout || '').split('\n').filter(Boolean)]);
  const lostByDerivation = [...R6_HAND].filter((f) => {
    let src = ''; try { src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'); } catch { return false; }
    return KILL_MARKERS.test(src) && !swp.files.includes(f);
  });
  ok(!lostByDerivation.length,
    'the DERIVED set loses nothing the r6 hand list covered — every hand-listed file that really is a kill/signal path is still swept (this reddens if the walk roots are ever narrowed)',
    { lostByDerivation });
  // Named because they are PERMANENT kill paths, not because a list of names is
  // the rule: jobs kills its own wrapper handles, boot-restore retires dtach
  // sessions, plugins/vnc/port-forward/opencode-serve stop daemons they
  // started, the agentd owns device-side session pipes, ws-handler/ws-create
  // carry the kill+teardown cases, and server.js wires signalProc. Every one
  // was a place a new `ps -p` existence probe could have landed under r6
  // without reddening a thing.
  const R7_GAINED_MUST = ['server.js', 'src/jobs.js', 'src/server/boot-restore.js',
    'src/plugins.js', 'src/vnc.js', 'src/port-forward.js', 'src/agentd/agentd.js',
    'src/ws-handler.js', 'src/ws-create.js', 'src/opencode-serve.js'];
  const gained = swp.files.filter((f) => !R6_HAND.has(f));
  ok(R7_GAINED_MUST.every((f) => swp.files.includes(f) && !R6_HAND.has(f)) && gained.length >= R7_GAINED_MUST.length,
    `REGRESSION PIN (r7): the r6 hand list MISSED ${gained.length} real kill/signal-path files — the derivation covers them, and re-narrowing to any hand list turns this red`,
    { missing: R7_GAINED_MUST.filter((f) => !swp.files.includes(f)), gained });
  // (j) NEGATIVE + POSITIVE CONTROLS, against a TEMP ROOT built to contain each
  // shape, so "no stray" above is a measurement rather than a tautology.
  const ncRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sweep-nc-'));
  fs.mkdirSync(path.join(ncRoot, 'src', 'server'), { recursive: true });
  fs.mkdirSync(path.join(ncRoot, 'data', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(ncRoot, 'scripts'), { recursive: true });
  // ① the retired shape on a BRAND-NEW kill path (git cf20753a's probe, moved
  //    into a file no hand list would ever have named).
  fs.writeFileSync(path.join(ncRoot, 'src', 'server', 'new-kill-path.js'),
    'function sig(pid) {\n'
    + '  return `if kill -TERM ${pid} 2>/dev/null; then sleep 0.5; '
    + 'if ps -p ${pid} >/dev/null 2>&1; then echo OK-ALIVE; else echo OK-GONE; fi; fi`;\n}\n');
  // ② an ALLOWLISTED line copied verbatim into another file: the exemption is
  //    per FILE, so the copy is still stray — an allowlist that travelled with
  //    the text would exempt every future paste of it.
  fs.writeFileSync(path.join(ncRoot, 'src', 'impostor.js'),
    'const t = `kill -TERM "$1"\n  ps -p "$1" >/dev/null 2>&1\n`;\n');
  // ③ POSITIVE CONTROL: a kill path with no `ps -p` is swept and NOT stray.
  fs.writeFileSync(path.join(ncRoot, 'src', 'clean-kill-path.js'),
    'function stop(p) { process.kill(p, "SIGTERM"); }\n');
  // ④ SCOPE, stated rather than assumed: a `ps -p` with no signal anywhere in
  //    the file is not a kill path — this rule is about the probe before a kill.
  fs.writeFileSync(path.join(ncRoot, 'src', 'not-a-kill-path.js'),
    'const argv = `ps -p "$1" -o args=`;\n');
  // ⑤ the suites must stay free to write the retired shape down.
  fs.writeFileSync(path.join(ncRoot, 'scripts', 'test-something.mjs'),
    'const retired = `kill -TERM ${p}; ps -p ${p} >/dev/null 2>&1`;\n');
  // ⑥ the extension-less agent CLIs (vibespace-job, vibespace-remote-keeper …)
  //    ship onto every host; r6 reached data/bin only by shelling out to
  //    `git ls-files`, which does not see a GENERATED tool (vibespace-status is
  //    deliberately untracked) — the shebang rung is what reaches them now.
  fs.writeFileSync(path.join(ncRoot, 'data', 'bin', 'vibespace-newtool'),
    '#!/bin/sh\nkill -TERM "$1" 2>/dev/null\nif ps -p "$1" >/dev/null 2>&1; then echo ALIVE; fi\n');
  // ⑨⑩ the OTHER spellings of a kill (r7 verify): `kill -s TERM` / numeric
  //    `kill -15` / bare `kill "$pid"` in shell, and node's `handle.kill()` —
  //    each next to the retired probe, each must be swept AND caught.
  fs.writeFileSync(path.join(ncRoot, 'src', 'kill-dash-s.sh'),
    '#!/bin/sh\nkill -s TERM "$1" 2>/dev/null || kill -15 "$1" || kill "$1"\nif ps -p "$1" >/dev/null 2>&1; then echo ALIVE; fi\n');
  fs.writeFileSync(path.join(ncRoot, 'src', 'handle-kill.js'),
    'function stop(h, pid) { h.kill(); return `ps -p ${pid} >/dev/null 2>&1`; }\n');
  // ⑪ THE JS SPELLING (B-eac2 residual (c)): `execFileSync('ps', ['-p', …])`
  //    is the same probe with the flag in an argv array, so the string `ps -p`
  //    never appears. Until `namesPsP` learned it, EVERY JS caller was outside
  //    the sweep's claim — six of them were live in this tree, one of them in a
  //    module that killPid()s. Both the stray and the allowlisted forms are
  //    controlled here so the pattern cannot rot into "matches nothing".
  fs.writeFileSync(path.join(ncRoot, 'src', 'js-ps-probe.js'),
    'const { execFileSync } = require("child_process");\n'
    + 'function stop(pid) {\n'
    + '  process.kill(pid, "SIGTERM");\n'
    + '  try { execFileSync("ps", ["-p", String(pid)], { encoding: "utf8" }); return "ALIVE"; } catch { return "GONE"; }\n'
    + '}\n');
  //    …and the pattern must not fire on a DIFFERENT program that merely takes
  //    a `-p` flag: over-inclusion in the FILE set is harmless (it only widens
  //    enforcement), but a needle that flagged `psql` would force reasons to be
  //    written for lines that are not this probe at all.
  fs.writeFileSync(path.join(ncRoot, 'src', 'js-not-ps.js'),
    'const { execFileSync } = require("child_process");\n'
    + 'function dump(pid) {\n'
    + '  process.kill(pid, "SIGTERM");\n'
    + '  return execFileSync("psql", ["-p", "5432", "-c", "select 1"], { encoding: "utf8" });\n'
    + '}\n');
  const nc = sweepKillPaths(ncRoot, PS_P_ALLOWED);
  const ncStray = (f) => nc.stray.some((s) => s.startsWith(f + ':'));
  ok(ncStray('src/server/new-kill-path.js'),
    'NEGATIVE CONTROL: a NEW file carrying the retired `ps -p N >/dev/null 2>&1` existence probe next to a kill IS caught — the derivation reaches files no hand list named',
    { stray: nc.stray });
  ok(ncStray('src/impostor.js'),
    'NEGATIVE CONTROL: an ALLOWLISTED line copied into a different file is still stray — the exemption is per file, it does not travel with the text');
  ok(nc.files.includes('src/clean-kill-path.js') && !ncStray('src/clean-kill-path.js'),
    'POSITIVE CONTROL: a kill path with no `ps -p` at all is swept and stays green — the sweep is not simply stuck on "stray"');
  ok(ncStray('src/js-ps-probe.js'),
    "NEGATIVE CONTROL (residual (c)): a JS `execFileSync('ps', ['-p', …])` next to a kill IS caught — the argv spelling is the same probe, and it was invisible to this sweep while six real ones lived in the tree",
    { stray: nc.stray });
  ok(nc.files.includes('src/js-not-ps.js') && !ncStray('src/js-not-ps.js'),
    'POSITIVE CONTROL (residual (c)): `execFileSync("psql", ["-p", …])` on a kill path is NOT flagged — the pattern names the `ps` PROGRAM, so it does not make every -p flag owe a reason');
  ok(!nc.files.includes('src/not-a-kill-path.js'),
    'SCOPE, measured not assumed: a `ps -p` in a file that signals nothing is NOT swept — the rule is about the probe in front of a kill');
  ok(!nc.files.includes('scripts/test-something.mjs') && nc.skipped.includes('scripts/test-something.mjs'),
    '…and the suites are excluded, which is the only reason THIS file may write the retired shape down as a control');
  ok(nc.files.includes('data/bin/vibespace-newtool') && ncStray('data/bin/vibespace-newtool'),
    'the extension-less agent CLIs are reached by their SHEBANG — a GENERATED (untracked) tool on every host\'s PATH was outside r6\'s `git ls-files data/bin` sweep');
  ok(nc.files.includes('src/kill-dash-s.sh') && ncStray('src/kill-dash-s.sh'),
    'NEGATIVE CONTROL (r7 verify): `kill -s TERM` / `kill -15` / bare `kill "$pid"` are kill paths too — swept by the widened markers and their retired probe is caught');
  ok(nc.files.includes('src/handle-kill.js') && ncStray('src/handle-kill.js'),
    'NEGATIVE CONTROL (r7 verify): node `handle.kill()` is a kill path — swept, and its retired probe is caught');
  // ⑦⑧ THE GENERATED BUCKET, both ways. ⑦ a bundle that only COPIES an
  //     authored probe passes (this is the daemon bundle's real shape, and the
  //     reason a clean `npm run build` must not redden the sweep); ⑧ the same
  //     bundle with ONE extra probe its sources never contained is caught.
  //     (the copy is line-for-line, exactly as esbuild emits a template
  //     literal — that is what makes "verbatim in an authored file" decidable.)
  fs.writeFileSync(path.join(ncRoot, 'data', 'bin', 'fake-bundle.js'),
    'const t = `kill -TERM "$1"\n  ps -p "$1" >/dev/null 2>&1\n`;\n');
  const genOnly = (root, rels) => new Set(rels.filter((r) => /fake-bundle|injected-bundle/.test(r)));
  const ncGen = sweepKillPaths(ncRoot, PS_P_ALLOWED, genOnly);
  ok(ncGen.generated.includes('data/bin/fake-bundle.js') && !ncGen.genUnauthored.length
    && !ncGen.stray.some((s) => s.startsWith('data/bin/fake-bundle.js')),
    'POSITIVE CONTROL: a GENERATED file whose only `ps -p` is a verbatim COPY of an authored one passes — a rebuilt daemon bundle never reddens a clean tree (it did before this bucket existed)',
    { generated: ncGen.generated, genUnauthored: ncGen.genUnauthored });
  fs.writeFileSync(path.join(ncRoot, 'data', 'bin', 'injected-bundle.js'),
    'kill -TERM\nconst injected = `if ps -p $PID 2>/dev/null; then :; fi`;\n');
  const ncGen2 = sweepKillPaths(ncRoot, PS_P_ALLOWED, genOnly);
  ok(ncGen2.genUnauthored.some((s) => s.startsWith('data/bin/injected-bundle.js')),
    'NEGATIVE CONTROL: a GENERATED file carrying a `ps -p` line that exists in NO authored file is caught — "generated" buys a different question, never an exemption',
    { genUnauthored: ncGen2.genUnauthored });
  fs.rmSync(ncRoot, { recursive: true, force: true });
  // (k) THE EMBEDDED REMOTE SCRIPTS, as the machine actually receives them.
  // Every leg above reads FILES; a builder that composes its probe at runtime
  // ships a shape no source scan can see. These are the shipped bytes — the
  // same texts §14/§16/§17 run for real.
  const { killPidShell: kpsSweep, codexOpenRolloutsShell: corSweep } = require('../src/hosts.js');
  const BUILT = [
    ['cli-identity.pidAliveShellFn()', cliIdentity.pidAliveShellFn()],
    ['cli-identity.cliIdentityShellFns()', cliIdentity.cliIdentityShellFns()],
    ['writer-sweep.fdScanShellFns()', fdScanShellFns()],
    ['writer-sweep.writerSweepScript(claude)', writerSweepScript('rid-sweep', shq)],
    ['writer-sweep.writerSweepScript(codex)', writerSweepScript('rid-sweep', shq, { backend: 'codex', protectSids: ['sess-1'] })],
    ['hosts.killPidShell(4242)', kpsSweep(4242)],
    ['hosts.codexOpenRolloutsShell()', corSweep()],
    ['sysinfo-wiring.signalVerdictScript(4242,TERM)', signalVerdictScript(4242, 'TERM')],
  ];
  // Matched by NEEDLE only here (`file: '*'`): a built script is a COMPOSITION
  // of several files, so "which file authored this line" is not a question it
  // can answer — and every needle is already justified above.
  const anyFile = PS_P_ALLOWED.map((a) => ({ ...a, file: '*' }));
  const builtStray = BUILT.flatMap(([label, text]) => scanPsP(label, text, anyFile).stray);
  console.log('  · embedded remote scripts, `ps -p` occurrences as BUILT: '
    + BUILT.map(([l, t]) => `${l.split('(')[0]}=${(String(t).match(/ps -p/g) || []).length}`).join(' '));
  ok(!builtStray.length,
    'the EMBEDDED REMOTE SCRIPTS carry no `ps -p` beyond the allowlisted argv/environ reads and `vs_alive`\'s own last rung — checked on the BUILT text, the only place a runtime-composed probe exists',
    { builtStray });
  ok(scanPsP('pre-r6 signal script', preR6Sig(4242, 'TERM'), anyFile).stray.length === 1,
    'NEGATIVE CONTROL: that same built-text scanner FIRES on the verbatim pre-r6 signal script — leg (k) is a measurement, not an empty loop');
  for (const p of spids) { try { process.kill(p, 'SIGKILL'); } catch { } }
  fs.rmSync(sdir, { recursive: true, force: true });
} else { console.log('  · /proc absent — skipping the signal-verdict legs'); }
function a2key(a) { return a.file + '\u0000' + a.needle; }

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
