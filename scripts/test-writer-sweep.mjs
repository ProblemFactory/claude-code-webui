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
const { writerSweepScript, sweepWriters, parseSwept } = require('../src/writer-sweep.js');

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
ok((script.match(/SWEPT:/g) || []).length >= 3, 'every kill leg reports what it terminated');

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

// ── 6. Real script execution against a real process on this machine ──
// Proves the script's fd-scan leg actually finds a holder (Linux only).
if (fs.existsSync('/proc/self')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sweep-'));
  const jsonl = path.join(dir, 'rid-live.jsonl');
  fs.writeFileSync(jsonl, '{}\n');
  const fd = fs.openSync(jsonl, 'r'); // THIS process now holds it open
  const { execFileSync } = await import('node:child_process');
  // ps -o args= for our pid contains 'node', not 'claude' → must NOT be killed
  const out = execFileSync('sh', ['-c', writerSweepScript('rid-live', shq)], { encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: dir } });
  fs.closeSync(fd);
  ok(parseSwept(out).length === 0, 'a NON-claude holder of the transcript is never killed (cmdline guard)');
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
  // a process that holds `file` open (fd 0) with the given argv tail + env
  const holder = (file, argvTail, extraEnv = {}) => {
    const fd = fs.openSync(file, 'r');
    const p = spawn(process.execPath, ['-e', idle, ...argvTail], { stdio: [fd, 'ignore', 'ignore'], env: { ...process.env, ...extraEnv } });
    fs.closeSync(fd);
    return p;
  };
  const exited = (p) => new Promise((res) => { if (p.exitCode !== null || p.signalCode) return res(p.signalCode); p.once('exit', (c, s) => res(s)); });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const h1 = holder(rollout, ['codex', 'app-server']);
  await sleep(300);
  ok(runSweep().includes(String(h1.pid)), `an external codex app-server holding rollout-*-<threadId>.jsonl open is swept (SWEPT:${h1.pid})`);
  ok((await exited(h1)) === 'SIGTERM', 'the holder actually received SIGTERM');
  ok(runSweep().length === 0, 'released → the sweep finds nothing (clean)');

  const h2 = holder(rollout, ['codex', 'app-server'], { CLAUDE_WEBUI_SESSION_ID: 'sess-live-1' });
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
  const h4 = holder(zst, ['codex', 'app-server']);
  await sleep(300);
  ok(runSweep().includes(String(h4.pid)), 'an open rollout-*-<threadId>.jsonl.zst (codex ≥0.153 compression) holder is swept');
  await exited(h4);

  const h5 = holder(rollout, ['viewer']);
  await sleep(300);
  ok(!runSweep().includes(String(h5.pid)) && alive(h5.pid), 'a NON-codex holder of the rollout is never killed (cmdline guard)');
  h5.kill('SIGKILL');

  const h6 = holder(rollout, ['codex', 'app-server']);
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

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
