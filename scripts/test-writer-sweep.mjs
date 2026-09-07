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
const require = createRequire(import.meta.url);
const { writerSweepScript, sweepWriters, parseSwept, fdScanShellFns } = require('../src/writer-sweep.js');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };
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
for (const [name, s] of [['claude', script], ['codex', writerSweepScript('rid-abc', shq, { backend: 'codex' })]]) {
  ok((s.match(/\/proc\/\[0-9\]\*/g) || []).length === 1 && s.includes('vs_fd_scan'), `${name}: exactly ONE /proc walk, through the shared batched scan`);
  ok(!/ls -l "\$pdir/.test(s) && !/ps -p "\$pid" -o args=\S*\) in \*/.test(s), `${name}: no per-process ls fork and no whole-argv substring identity test`);
}

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
  // …and the suite itself: same fd, and (when run from an agent worktree) the
  // very argv that used to match. A SIGTERM here must not kill the run.
  let selfTermed = false;
  const onTerm = () => { selfTermed = true; };
  process.on('SIGTERM', onTerm);
  const selfFd = fs.openSync(jsonl, 'r');

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
  while ((holders.some((h) => !fs.existsSync(h.ready)) || !holdsIt(rTail.pid)) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
  ok(holdsIt(rTail.pid), '`tail -f` fixture really has the transcript open (the negative control is not vacuous)');
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
  ok(wasSwept('w-native', wNative), 'WRITER swept: a native `…/bin/claude` holder (argv[0] basename) — positive control that the scan reached the holder at all', { swept });
  ok(wasSwept('w-npm', wNpm), 'WRITER swept: `node …/@anthropic-ai/claude-code/cli.js` (the npm entry point)', { swept });
  ok(wasSwept('w-shim', wShim), 'WRITER swept: `node <prefix>/bin/claude` (the shebang bin shim)', { swept });
  ok(!swept.includes(rTail.pid) && alive(rTail.pid), 'READER survives: `tail -f <HOME>/.claude/projects/…/<id>.jsonl` is NOT a transcript writer (B-3185)', { swept, pid: rTail.pid });
  ok(survived('r-worktree', rWorktree), 'READER survives: a process running from a path under .claude/worktrees/ (the suite\'s own self-kill shape)', { swept });
  ok(survived('r-othercli', rOtherCli), 'READER survives: a `cli.js` that is not under a claude package', { swept });
  ok(survived('r-neutral', rNeutral), 'READER survives: a neutral `node -e` holder', { swept });
  ok(!selfTermed && !swept.includes(process.pid), `the SUITE ITSELF holds the transcript open and is never swept (ran from ${process.argv[1].includes('.claude') ? 'a .claude path — the real regression shape' : 'a non-.claude path'})`, { swept, pid: process.pid });
  ok(swept.includes(lockWriter.pid) && !alive(lockWriter.pid), 'LOCK-FILE leg: a claude named by its own ~/.claude/sessions/<pid>.json is swept even though it holds no fd (the leg that reaches a REAL live claude)', { swept });
  ok(!swept.includes(lockStale.pid) && alive(lockStale.pid), 'LOCK-FILE leg: a STALE lock file whose pid was reused by something that is not claude kills nothing', { swept });
  console.log(`  · fd scan + sweep wall time: ${scanMs}ms over ${execFileSync('sh', ['-c', 'ls -d /proc/[0-9]* 2>/dev/null | wc -l'], { encoding: 'utf8' }).trim()} processes`);
  fs.closeSync(selfFd);
  process.off('SIGTERM', onTerm);
  for (const h of [...holders.map((h) => h.p), rTail, lockWriter, lockStale]) { try { h.kill('SIGKILL'); } catch {} }
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
  ok(!/for p in \/proc\/\[0-9\]\*\/fd\/\*/.test(boot), 'boot-restore no longer forks a readlink per FD (ARG_MAX overflow + guaranteed timeout)');
  ok(/console\.warn\('\[boot-restore\] live-conversation fd scan failed/.test(boot), 'a failed probe SAYS SO instead of silently degrading to "nobody is live"');
  const fns = fdScanShellFns();
  ok(fns.includes('vs_fd_scan') && fns.includes('vs_fd_pids') && fns.includes('/proc/self/fd'),
    'the shared scan exports both entry points and keeps the >1-operand guarantee `ls -l` needs for its headers');
  ok(writerSweepScript('r', shq).includes(fns) && writerSweepScript('r', shq, { backend: 'codex' }).includes(fns),
    'both backends embed the scan VERBATIM (no per-backend copy to drift)');
}

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
