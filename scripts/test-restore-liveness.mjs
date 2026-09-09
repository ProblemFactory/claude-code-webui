#!/usr/bin/env node
// SESSION LIVENESS AFTER RESTORE (2026-09-09 production incident).
//
// THE PROMISE: dtach sessions survive a server restart BY DESIGN, so a
// restored session must stream live output to an attached client WITHOUT the
// user typing anything. On 2026-09-08 22:20 PDT (v2.369.77) it did not: twelve
// sessions were restored while `deviceMgr.connect()` was still in flight
// (journal: `spawned local daemon` 22:20:56 / `daemon 2.369.75 ≠ 2.369.77 —
// upgrading` / `routing ENABLED` 22:21:02, against a restore that ran
// 22:20:22–22:20:53), one claude session sat on "3 Bash · running…" for ~8
// minutes while its wrapper kept appending to its buffer FILE, and the only
// thing that healed it was the ws broken-stdin detector at 22:29:05 — i.e. the
// user typing.
//
// THE DEFECT under test: `attachToDtach`'s daemon path FIRE-AND-FORGOT the
// open. `deviceMgr.openSession()` resolves as soon as the `open-session`
// control frame is WRITTEN; the daemon's answer lives on `handle.ready`
// (`session-open` / `session-error` / pre-ready link death), which nothing
// awaited, and `setupSessionPty` ran on the shim regardless — a bridge the
// daemon never opened is then a SILENTLY dead pty (no journal line, session
// still LIVE, and the shim's onExit never fires so the re-attach ladder never
// runs either). Boot ordering put every restore behind exactly that window.
//
// WHAT THIS SUITE DRIVES: the REAL src/server/session-stdout.js, a REAL
// vibespace-device daemon on a real unix socket, REAL dtach sockets, and a
// REAL worktree server. The daemon's `open-session` handler is FAULT-INJECTED
// in a THROWAWAY copy of the bundle (three shapes: refuses / never answers /
// answers but relays nothing) because the journal proves neither a
// `session-error` nor an `[agentd] connection lost` in the incident window, so
// which silent shape hit those sessions is NOT established — all three are the
// same dead bridge and all three are covered.
//
// NEGATIVE CONTROL: a PATCHED COPY of the real module carrying master's
// pre-fix attach (no connected-gate, no `ready` await, no probe), asserted to
// have taken every patch. Under the same faults it produces no bytes at all.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { scratch, freePort } = await import(path.join(REPO, 'scripts/scratch.mjs'));

// Master's fire-and-forget leaves `handle.ready` REJECTIONS unattached. In the
// server they are swallowed by server.js's global `unhandledRejection` handler
// (one context-free line, no session id); here they would kill the suite, so
// we mirror that handler and MEASURE them instead. NOTE for the incident file:
// the production journal carries no `unhandledRejection:` line in the restore
// window either, which is evidence AGAINST the `session-error` shape and for
// one of the two silent ones.
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String((e && e.message) || e)));

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (extra ? `\n      ${extra}` : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── throwaway everything (2.369.76 law: per-process paths, free ports) ──
const ROOT = scratch('restore-liveness');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// The pre-fix control must be a SIBLING of the real module (its own relative
// requires — ./agent-tool-generators.js, ../normalizers — resolve from there).
const CONTROL_MODULE = path.join(REPO, 'src/server/session-stdout.__prefix_control.js');
// every patched copy we write beside the real module (gitignored as
// `session-stdout.__*_control.js`; a SIGKILL must never dirty the tree, which
// is what the release gate REFUSES on)
const controlModules = new Set([CONTROL_MODULE]);
const daemonRoots = new Set();      // every VIBESPACE_AGENTD_ROOT we spawned into
const servers = new Set();          // every worktree server child
const stray = new Set();            // dtach fixture sockets
// Every `git worktree add` we made. It is REGISTERED here rather than removed
// at the end of the block that created it, because a leg may bail out early
// (an unmeasurable fixture is a loud fail, not a reason to skip §5/§6) and a
// worktree whose FILES were deleted with ROOT still leaves a prunable entry in
// the shared .git — we clean up after ourselves on every exit path.
const worktrees = new Set();

function killDaemons() {
  for (const root of daemonRoots) {
    try {
      const pid = Number(fs.readFileSync(path.join(root, 'state', 'agentd.pid'), 'utf8'));
      if (pid > 0) process.kill(pid, 'SIGKILL');
    } catch { }
  }
}
function cleanup() {
  killDaemons();
  for (const s of servers) { try { s.kill('SIGKILL'); } catch { } }
  for (const sock of stray) { try { execFileSync('pkill', ['-f', sock], { stdio: 'ignore' }); } catch { } }
  // …and everything ELSE still living under our scratch root. The §4 fixture's
  // dtach master is spawned by the SERVER (a ws `create`), so it is in no set
  // of ours, and `dtach -c` deliberately outlives the process that started it
  // — that is the very property under test. Deleting ROOT does not end it: it
  // would keep running against an unlinked socket path forever (MEASURED: 8
  // stranded `dtach -c` + pty-wrapper + zsh trees, some 3.5 h old, before this
  // line existed). ROOT is per-pid (scripts/scratch.mjs), so this pattern can
  // only ever match processes this run created; it runs BEFORE the rmSync so
  // the paths it matches on still exist.
  try { execFileSync('pkill', ['-f', ROOT], { stdio: 'ignore' }); } catch { }
  for (const wt of worktrees) { try { execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }); } catch { } }
  for (const m of controlModules) { try { fs.unlinkSync(m); } catch { } }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { }
}
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });

// ── the FAULT-INJECTED daemon bundle ───────────────────────────────────────
// The shipped bundle keeps the source text verbatim, so `msg.op ===
// "open-session"` is a single unambiguous anchor. VS_FAULT_OPEN picks the
// shape; unset = the real handler, untouched.
const REAL_BUNDLE = path.join(REPO, 'data/bin/vibespace-agentd.js');
const OPEN_ANCHOR = 'if (msg.op === "open-session") {';
const FAULT = `${OPEN_ANCHOR}
        const __vsFault = process.env.VS_FAULT_OPEN || "";
        if (__vsFault === "silent") return;                                  /* never answers: \`ready\` stays PENDING forever */
        if (__vsFault === "error") { mux.control({ op: "session-error", chan: msg.chan, error: "injected fault: open-session refused" }); return; }
        if (__vsFault === "deadchan") { mux.control({ op: "session-open", chan: msg.chan, pid: 999999 }); return; } /* opens, then relays nothing, ever */`;

function buildBundle(dst, { version = null, fault = true } = {}) {
  let src = fs.readFileSync(REAL_BUNDLE, 'utf-8');
  if (fault) {
    if (src.split(OPEN_ANCHOR).length - 1 !== 1) throw new Error('fault anchor is not unique in the daemon bundle');
    src = src.replace(OPEN_ANCHOR, FAULT);
  }
  if (version) {
    const m = /VERSION: "[\d.]+"/.exec(src);
    if (!m) throw new Error('no VERSION literal in the daemon bundle');
    src = src.replace(m[0], `VERSION: "${version}"`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, src);
  return dst;
}

const REAL_VERSION = require(path.join(REPO, 'package.json')).version;
const FAULT_BUNDLE = buildBundle(path.join(ROOT, 'bundles', 'faulty.js'), { fault: true });
ok(fs.readFileSync(FAULT_BUNDLE, 'utf-8').includes('injected fault: open-session refused'),
  'PATCH LANDED: the throwaway daemon bundle carries the open-session fault injector');

// ── the PRE-FIX control module (master's attach, patched into a real copy) ──
{
  const src = fs.readFileSync(path.join(REPO, 'src/server/session-stdout.js'), 'utf-8');
  let out = src, hits = 0;
  const gateA = "if (deviceMgr && !session.host && deviceMgr.status?.().connected) {";
  if (out.includes(gateA)) { out = out.replace(gateA, 'if (deviceMgr && !session.host) {'); hits++; }
  const start = out.indexOf('    deviceMgr.openSession({');
  const tail = '\n    return;\n  }\n  localAttach();\n}';
  const end = out.indexOf(tail, start);
  if (start > 0 && end > start) {
    out = out.slice(0, start) + `    deviceMgr.openSession({ cmd: DTACH_CMD, args: ['-a', socketPath, '-E', '-r', 'winch'], cols: 120, rows: 30 })
      .then((h) => { setupSessionPty(session, id, daemonPtyShim(h)); repaintClients(); })
      .catch((e) => { console.warn('[device] session attach failed — local pty fallback:', e.message); localAttach(); });` + out.slice(end);
    hits++;
  }
  const armLocal = "    armProbe(attachPty, 'local');\n";
  if (out.includes(armLocal)) { out = out.replace(armLocal, ''); hits++; }
  ok(hits === 3, 'PATCH LANDED: the pre-fix control took all 3 replacements (gate, fire-and-forget open, no local probe)', `hits=${hits}`);
  ok(!out.includes('h.ready.then') && !out.includes("armProbe(shim, 'device')"),
    'PATCH LANDED: the control observes neither `ready` nor the attach probe');
  fs.writeFileSync(CONTROL_MODULE, out);
}

// ── harness: a session-stdout engine over a given DeviceManager ────────────
const dial = require(path.join(REPO, 'src/server/dial-pairing.js')).create({
  rootDir: REPO, AGENTD_DIR: path.join(ROOT, 'agentd-dir'), agentdHostToken: () => 'vsht_test',
  getHosts: () => null, getMounts: () => null, getMachineMounts: () => null,
  getPortForwards: () => null, getExitProxy: () => null,
});

function makeEngine({ getDeviceMgr, modulePath }) {
  const activeSessions = new Map();
  const frames = [];
  const eng = require(modulePath).create({
    rootDir: REPO, BUFFERS_DIR: path.join(ROOT, 'buffers'), META_DIR: path.join(ROOT, 'meta'),
    DTACH_CMD: 'dtach', USAGE_SCANNER_PATH: '', CLAUDE_STREAM_TYPES: new Set(), _seenStreamTypes: new Set(),
    activeSessions, engine: {}, checkClaudeGoalStatus: () => { },
    broadcastToSession: (s, id, m) => frames.push(m), broadcastActiveSessions: () => { },
    noteModelSeen: () => { }, noteHarnessModels: () => { }, recordUsageAttribution: () => { },
    daemonPtyShim: dial.daemonPtyShim, agentEnv: () => process.env, sbSeenFirst: () => { },
    getDeviceMgr, getHosts: () => null, getUsageHistory: () => null, getTelemetry: () => null,
    getNoConvoRef: () => null, getDeliver: () => null, getPages: () => null, getPermissionRules: () => null,
  });
  return { eng, activeSessions, frames };
}

// a REAL dtach session whose program prints a marker on a timer
let sockSeq = 0;
function mkDtachFixture(tag) {
  const dir = path.join(ROOT, 'dtach', tag + '-' + (++sockSeq));
  fs.mkdirSync(dir, { recursive: true });
  const prog = path.join(dir, 'emit.js');
  fs.writeFileSync(prog, `let n=0;setInterval(()=>process.stdout.write('TICK'+(++n)+'\\n'),250);setTimeout(()=>process.exit(0),120000);\n`);
  const sock = path.join(dir, 's.sock');
  execFileSync('dtach', ['-n', sock, '-E', '-z', process.execPath, prog]);
  stray.add(sock);
  return sock;
}
function mkQuietFixture(tag) {
  const dir = path.join(ROOT, 'dtach', tag + '-' + (++sockSeq));
  fs.mkdirSync(dir, { recursive: true });
  const prog = path.join(dir, 'quiet.js');
  fs.writeFileSync(prog, `process.stdin.resume();setTimeout(()=>process.exit(0),120000);\n`);
  const sock = path.join(dir, 's.sock');
  execFileSync('dtach', ['-n', sock, '-E', '-z', process.execPath, prog]);
  stray.add(sock);
  return sock;
}

const { DeviceManager } = require(path.join(REPO, 'src/agentd/client.js'));
function newDaemon(tag, { fault = '', bundle = FAULT_BUNDLE } = {}) {
  const root = path.join(ROOT, 'daemons', tag);
  process.env.VIBESPACE_AGENTD_ROOT = root;
  process.env.VIBESPACE_NODE_MODULES = path.join(REPO, 'node_modules');
  if (fault) process.env.VS_FAULT_OPEN = fault; else delete process.env.VS_FAULT_OPEN;
  daemonRoots.add(root);
  return new DeviceManager({
    dataDir: path.join(root, 'data'), bundlePath: bundle, version: REAL_VERSION,
    nodeModules: path.join(REPO, 'node_modules'), log: () => { },
  });
}

// ── § 1 THE PROBE'S PREMISE (measured, both transports) ────────────────────
console.log('— §1 dtach -a emits its redraw preamble even when the program is SILENT —');
{
  const pty = require(path.join(REPO, 'node_modules/node-pty'));
  const sock = mkQuietFixture('quiet-local');
  const p = pty.spawn('dtach', ['-a', sock, '-E', '-r', 'winch'], { name: 'xterm-256color', cols: 120, rows: 30, env: process.env });
  let seen = '';
  p.onData((d) => { seen += d; });
  await sleep(800);
  ok(seen.length > 0, 'local: a healthy attach to a SILENT program produces bytes (the probe can tell alive from dead)', JSON.stringify(seen));
  ok(/\x1b\[H|\x1b\[[0-3]?J/.test(seen), 'local: those bytes are dtach\'s redraw preamble (what the terminal branch already strips)', JSON.stringify(seen));
  try { p.kill(); } catch { }

  const dm = newDaemon('premise');
  await dm.connect();
  const h = await dm.openSession({ cmd: 'dtach', args: ['-a', sock, '-E', '-r', 'winch'], cols: 120, rows: 30 });
  let devSeen = '';
  h.onData = (b) => { devSeen += b.toString('utf-8'); };
  await h.ready;
  await sleep(800);
  ok(devSeen.length > 0, 'through the DAEMON: the same preamble relays over the mux (the probe works on both transports)', JSON.stringify(devSeen));
  try { h.kill(); } catch { }
  dm.stop();
}

// ── § 2 THE MECHANISM MATRIX (real daemon, real dtach, real module) ────────
console.log('— §2 a device attach that never opens must FALL BACK / HEAL, not go silent —');
const BUDGET_MS = 8000;   // > ATTACH_PROBE_MS(4000) + confirm(600) and > DEVICE_OPEN_READY_MS(5000)

async function attachLeg({ label, fault, modulePath, expectBytes, expectDaemon = null }) {
  const dm = newDaemon('leg-' + label.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), { fault });
  await dm.connect();
  const { eng, activeSessions, frames } = makeEngine({ getDeviceMgr: () => dm, modulePath });
  const id = 'sess-' + label.replace(/[^a-z0-9]+/gi, '') + '-' + Date.now();
  const sock = mkDtachFixture(label);
  const session = { mode: 'terminal', backend: 'shell', clients: new Map(), buffer: '', socketPath: sock, name: label, cwd: ROOT };
  activeSessions.set(id, session);
  const logs = [];
  const realWarn = console.warn, realLog = console.log;
  console.warn = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
  try {
    eng.attachToDtach(id, sock, session);
    const t0 = Date.now();
    while (Date.now() - t0 < BUDGET_MS) { if (frames.some((f) => /TICK/.test(f.data || ''))) break; await sleep(150); }
  } finally { console.warn = realWarn; console.log = realLog; }
  const gotBytes = frames.some((f) => /TICK/.test(f.data || ''));
  // READ THE VERDICT BEFORE TEARING DOWN. Killing the pty fires the product's
  // own detach ladder (session.pty = null, re-attach in 1s) against a
  // DeviceManager we are about to stop — so a verdict read after the teardown
  // is a verdict about the teardown.
  const onDaemon = session.pty?._daemon === true;
  const hasPty = !!session.pty;
  activeSessions.delete(id);
  try { session.pty?.kill?.(); } catch { }
  dm.stop();
  return { gotBytes, logs, onDaemon, hasPty, label };
}

for (const [fault, what] of [['', 'a healthy daemon'], ['error', 'open-session REFUSED'], ['silent', 'open-session NEVER ANSWERED'], ['deadchan', 'open-session answered but the channel relays NOTHING']]) {
  const fixed = await attachLeg({ label: 'fixed-' + (fault || 'healthy'), fault, modulePath: path.join(REPO, 'src/server/session-stdout.js'), expectBytes: true });
  ok(fixed.gotBytes, `FIX / ${what}: the session streams within ${BUDGET_MS} ms with ZERO input`,
    fixed.logs.join(' | '));
  if (fault === '') {
    ok(fixed.onDaemon, 'FIX / a healthy daemon: the attach really ran through the DEVICE (the daemon path is not disabled)',
      fixed.logs.join(' | '));
  } else {
    ok(fixed.hasPty && !fixed.onDaemon, `FIX / ${what}: it ended on a LOCAL pty (fallback or heal)`);
    ok(fixed.logs.some((l) => /local pty fallback|re-attaching dtach locally/.test(l)),
      `FIX / ${what}: it SAID so (never a silent degrade)`, fixed.logs.join(' | '));
  }
  if (fault) {
    const before = unhandled.length;
    const ctl = await attachLeg({ label: 'ctl-' + fault, fault, modulePath: CONTROL_MODULE, expectBytes: false });
    ok(!ctl.gotBytes, `PRE-FIX CONTROL / ${what}: NOTHING arrives — the incident's silent dead pty`, ctl.logs.join(' | '));
    ok(!ctl.logs.some((l) => /local pty fallback|re-attaching/.test(l)),
      `PRE-FIX CONTROL / ${what}: and it never even SAYS anything (no journal line to find it by)`, ctl.logs.join(' | '));
    if (fault === 'error') {
      ok(unhandled.length > before && /open-session refused/.test(unhandled.join(' | ')),
        'PRE-FIX CONTROL / open-session REFUSED: master leaves the `ready` rejection UNHANDLED (the server prints one context-free line, with no session id)',
        unhandled.join(' | '));
    }
  }
}

// ── § 2b BYTES THAT ARRIVE BEFORE THERE IS A LISTENER ──────────────────────
// The daemon's session channel exists from `conn.sessions.set(chan, …)`, which
// runs BEFORE the open-session frame is even written, so DATA on that channel
// is protocol-legal before `session-open`. `ready` is a PROMISE, so anything
// that keys off it settles a microtask later than the synchronous dispatch of
// whatever frames came in the same socket read — bytes in that gap reach a
// `handle.onData` that is still null and are dropped. For a chatty session
// that is invisible; for a SILENT one (an idle claude waiting on a prompt) the
// preamble is the probe's ONLY evidence, so the loss turns a healthy daemon
// into a heal on every attach — the fix's own guard firing on the fix.
// HONEST MEASUREMENT (scripts/dbg-open-coalesce.mjs, this box, a daemon
// patched to answer session-open and write a data frame in the same tick):
// 0/8 landed in the same read — the reader is scheduled between the two
// writes here — so this leg does NOT wait for a coalesced read it cannot make
// happen. It drives the SHAPE the contract allows, directly.
console.log('— §2b a byte that arrives before `ready` settles must not be dropped —');
{
  const earlyLeg = async (modulePath) => {
    const { eng, activeSessions, frames } = makeEngine({
      modulePath,
      getDeviceMgr: () => ({
        status: () => ({ connected: true }),
        // data BEFORE ready, in the same tick — exactly the window above
        openSession: async () => {
          const h = { pid: 424242, write() { }, resize() { }, kill() { } };
          let settle; h.ready = new Promise((r) => { settle = r; });
          setTimeout(() => { try { h.onData?.(Buffer.from('VSEARLYBYTE\n')); } catch { } settle({ pid: 424242 }); }, 30);
          return h;
        },
      }),
    });
    const id = 'sess-early-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const sock = mkDtachFixture('early');
    const session = { mode: 'terminal', backend: 'shell', clients: new Map(), buffer: '', socketPath: sock, cwd: ROOT };
    activeSessions.set(id, session);
    const logs = [];
    const realWarn = console.warn, realLog = console.log;
    console.warn = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
    try {
      eng.attachToDtach(id, sock, session);
      const t0 = Date.now();                       // > the probe's 4.0 s + 0.6 s confirm
      while (Date.now() - t0 < 7000) { if (frames.some((f) => /TICK/.test(f.data || ''))) break; await sleep(150); }
    } finally { console.warn = realWarn; console.log = realLog; }
    const r = {
      early: frames.some((f) => /VSEARLYBYTE/.test(f.data || '')),
      onDaemon: session.pty?._daemon === true,
      healed: logs.some((l) => /re-attaching dtach locally/.test(l)),
      tick: frames.some((f) => /TICK/.test(f.data || '')),
      heals: Number(session._attachProbeHeals || 0),
      logs,
    };
    activeSessions.delete(id);
    try { session.pty?.kill?.(); } catch { }
    return r;
  };

  const fixed = await earlyLeg(path.join(REPO, 'src/server/session-stdout.js'));
  ok(fixed.early, 'FIX: a byte delivered before `ready` settles still reaches the clients (buffered, replayed once the shim has listeners)', fixed.logs.join(' | '));
  ok(fixed.onDaemon && !fixed.healed, 'FIX: …and it counts as the attach\'s proof of life — a session that says nothing else is NOT healed off the daemon', `onDaemon=${fixed.onDaemon} healed=${fixed.healed} | ${fixed.logs.join(' | ')}`);
  ok(fixed.heals === 0, 'FIX: an attach that produced a byte leaves the heal counter at 0 (the bound is on CONSECUTIVE silent attaches, never a lifetime cap)', `heals=${fixed.heals}`);

  // NEGATIVE CONTROL — a copy of the REAL module with ONLY the early-data
  // replay removed. One mechanism, one control: the byte is lost AND the
  // probe then heals a bridge that was working the whole time.
  const noReplay = path.join(REPO, 'src/server/session-stdout.__noreplay_control.js');
  {
    const src = fs.readFileSync(path.join(REPO, 'src/server/session-stdout.js'), 'utf-8');
    const line = "      for (const buf of (h._earlyData || []).splice(0)) { try { h.onData(buf); } catch { } }\n";
    ok(src.includes(line), 'PATCH LANDED: the early-data replay is where the control expects it');
    fs.writeFileSync(noReplay, src.replace(line, ''));
    controlModules.add(noReplay);
  }
  const ctl = await earlyLeg(noReplay);
  ok(!ctl.early, 'NEGATIVE CONTROL: without the replay that byte is dropped on the floor (no listener existed yet)', ctl.logs.join(' | '));
  ok(ctl.healed, 'NEGATIVE CONTROL: …and the probe then heals a bridge that was never broken', `healed=${ctl.healed} | ${ctl.logs.join(' | ')}`);
  ok(ctl.tick, 'NEGATIVE CONTROL: the local heal does rescue it (the cost is a needless re-attach, not a lost session)');
  ok(ctl.heals === 1, 'NEGATIVE CONTROL: …and exactly ONE heal is counted (the counter moves only when the probe really acted)', `heals=${ctl.heals}`);
  fs.unlinkSync(noReplay); controlModules.delete(noReplay);
}

// ── § 3 BOOT ORDERING: the daemon path is taken only on an ALREADY-LIVE link ─
console.log('— §3 a restore must not race the daemon connect/self-upgrade —');
{
  const dm = newDaemon('ordering');                     // constructed, NOT connected
  ok(dm.status().connected === false, 'precondition: the link is not established yet (exactly the boot window)');
  const { eng, activeSessions, frames } = makeEngine({ getDeviceMgr: () => dm, modulePath: path.join(REPO, 'src/server/session-stdout.js') });
  const sock = mkDtachFixture('ordering');
  const id = 'sess-ordering-' + Date.now();
  const session = { mode: 'terminal', backend: 'shell', clients: new Map(), buffer: '', socketPath: sock, cwd: ROOT };
  activeSessions.set(id, session);
  eng.attachToDtach(id, sock, session);
  ok(session.pty && !session.pty._daemon, 'FIX: a restore while the link is still connecting attaches LOCALLY, in the same tick');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !frames.some((f) => /TICK/.test(f.data || ''))) await sleep(120);
  ok(frames.some((f) => /TICK/.test(f.data || '')), 'FIX: and it streams immediately (no blind window while the daemon comes up)');
  try { session.pty?.kill?.(); } catch { }

  // control: master takes the daemon path in that same window
  const ctl = makeEngine({ getDeviceMgr: () => dm, modulePath: CONTROL_MODULE });
  const sock2 = mkDtachFixture('ordering-ctl');
  const id2 = 'sess-ordering-ctl-' + Date.now();
  const s2 = { mode: 'terminal', backend: 'shell', clients: new Map(), buffer: '', socketPath: sock2, cwd: ROOT };
  ctl.activeSessions.set(id2, s2);
  ctl.eng.attachToDtach(id2, sock2, s2);
  const t1 = Date.now();
  while (Date.now() - t1 < 8000 && !s2.pty) await sleep(120);
  ok(s2.pty?._daemon === true, 'PRE-FIX CONTROL: master attaches through the daemon in that same window (the gate is what changed)');
  try { s2.pty?.kill?.(); } catch { }

  // and once the link IS live, the fix still uses the daemon
  await dm.connect();
  const sock3 = mkDtachFixture('ordering-live');
  const id3 = 'sess-ordering-live-' + Date.now();
  const s3 = { mode: 'terminal', backend: 'shell', clients: new Map(), buffer: '', socketPath: sock3, cwd: ROOT };
  activeSessions.set(id3, s3);
  eng.attachToDtach(id3, sock3, s3);
  const t2 = Date.now();
  while (Date.now() - t2 < 5000 && !s3.pty?._daemon) await sleep(120);
  ok(s3.pty?._daemon === true, 'FIX: with the link already live the daemon path is still taken (this is a gate, not a removal)');
  try { s3.pty?.kill?.(); } catch { }
  dm.stop();
}

// ── § 4 END-TO-END: a real worktree server, a real daemon at a MISMATCHED
//       version (so the self-upgrade + re-exec really happens under the
//       restore), a real ws client, and ZERO input. ───────────────────────────
console.log('— §4 end-to-end restore over a self-upgrading daemon —');
e2e: {
  const wt = path.join(ROOT, 'wt');
  worktrees.add(wt);
  execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', wt, 'HEAD'], { stdio: 'ignore' });
  for (const f of ['src', 'public', 'server.js', 'package.json']) {   // overlay the WORKING tree (2.335.1)
    execFileSync('rm', ['-rf', path.join(wt, f)]);
    execFileSync('cp', ['-r', path.join(REPO, f), path.join(wt, f)]);
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
  fs.mkdirSync(path.join(wt, 'data', 'bin'), { recursive: true });
  // The bundle the SERVER streams during the self-upgrade carries the real
  // version AND the fault; the daemon it finds already installed carries an
  // OLD version, so the hello-ack mismatch → upgrade → re-exec path runs.
  buildBundle(path.join(wt, 'data/bin/vibespace-agentd.js'), { fault: true });
  const staleBundle = buildBundle(path.join(ROOT, 'bundles', 'stale.js'), { fault: true, version: '0.0.1' });
  const wtRoot = path.join(ROOT, 'daemons', 'e2e');
  daemonRoots.add(wtRoot);
  const installStale = () => {
    killDaemons();
    fs.rmSync(wtRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(wtRoot, '0.0.1'), { recursive: true });
    fs.copyFileSync(staleBundle, path.join(wtRoot, '0.0.1', 'agentd.js'));
    fs.chmodSync(path.join(wtRoot, '0.0.1', 'agentd.js'), 0o700);
    try { fs.unlinkSync(path.join(wtRoot, 'current')); } catch { }
    fs.symlinkSync(path.join(wtRoot, '0.0.1'), path.join(wtRoot, 'current'));
  };

  const PORT = await freePort();
  const bootEnv = {
    ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '',
    VIBESPACE_AGENTD_ROOT: wtRoot, VIBESPACE_NODE_MODULES: path.join(REPO, 'node_modules'),
    VS_FAULT_OPEN: 'deadchan', // the incident's exact shape: the open is ANSWERED, the channel never relays
  };
  const boot = () => { const c = spawn('node', ['server.js'], { cwd: wt, env: bootEnv, stdio: ['ignore', 'pipe', 'pipe'] }); servers.add(c); return c; };
  const waitReady = (p) => new Promise((res, rej) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('Ready.')) res(out); });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => rej(new Error('boot timeout\n' + out.slice(-2000))), 45000);
  });
  const journal = (p) => { let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); return () => out; };

  // ① create a terminal session that keeps printing on a timer
  installStale();
  let srv = boot(); let jrn = journal(srv); await waitReady(srv);
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws1.on('open', r));
  const msgs = []; ws1.on('message', (d) => { try { msgs.push(JSON.parse(d)); } catch { } });
  ws1.send(JSON.stringify({ type: 'create', backend: 'shell', mode: 'terminal', cwd: ROOT, cols: 80, rows: 24, reqId: 'r1' }));
  await new Promise((res, rej) => {
    const t = setInterval(() => { if (msgs.some((m) => m.type === 'created')) { clearInterval(t); res(); } }, 200);
    setTimeout(() => { clearInterval(t); rej(new Error('no created reply: ' + JSON.stringify(msgs.map((m) => m.type)))); }, 20000);
  });
  const sid = msgs.find((m) => m.type === 'created').sessionId;
  // THE FIXTURE COMMAND IS PARSED BY WHOEVER $SHELL IS. Typing
  // `while :; do echo VSTICK; sleep 0.4; done` at a fixed 1.2 s into an
  // INTERACTIVE login shell is a coin flip: measured here (scripts/
  // dbg-shell-fixture.mjs, zsh + oh-my-zsh) it lands mid-startup, the shell
  // parses a fragment, answers `parse error near \`do'` and sits at its prompt
  // — and then the control leg's "nothing arrived" is VACUOUS. So: two script
  // FILES (no quoting, no `;`, nothing a line editor can mangle), a readiness
  // HANDSHAKE whose marker cannot be matched by its own terminal echo (the
  // typed line names a path; only the script PRINTS the marker), and a retry
  // on each — because "did the shell take the command" is the thing being
  // established, not something to assume.
  const readySh = path.join(ROOT, 'ready.sh'), tickSh = path.join(ROOT, 'tick.sh');
  fs.writeFileSync(readySh, 'echo VSREADY_OK\n');
  fs.writeFileSync(tickSh, 'while :; do echo VSTICK; sleep 0.4; done\n');
  const outText = () => msgs.filter((m) => m.type === 'output' && m.sessionId === sid).map((m) => m.data || '').join('');
  const typeUntil = async (line, re, tries, waitMs) => {
    for (let i = 0; i < tries; i++) {
      ws1.send(JSON.stringify({ type: 'input', sessionId: sid, data: line + '\n' }));
      const t = Date.now();
      while (Date.now() - t < waitMs) { if (re.test(outText())) return true; await sleep(150); }
    }
    return re.test(outText());
  };
  const shellReady = await typeUntil(`sh ${readySh}`, /VSREADY_OK/, 12, 1500);
  ok(shellReady, 'e2e setup: the login shell inside dtach is taking commands (the handshake marker only the SCRIPT can print)',
    JSON.stringify(outText().slice(-300)));
  if (!shellReady) { ws1.close(); srv.kill('SIGKILL'); servers.delete(srv); break e2e; }  // failed LOUDLY above; every leg below would be vacuous
  const ticking = await typeUntil(`exec sh ${tickSh}`, /VSTICK[\s\S]*VSTICK/, 3, 4000);
  ok(ticking, 'e2e setup: the session is emitting on a timer before the restart', JSON.stringify(outText().slice(-300)));
  if (!ticking) { ws1.close(); srv.kill('SIGKILL'); servers.delete(srv); break e2e; }      // ditto
  ws1.close(); srv.kill('SIGKILL'); servers.delete(srv);
  await sleep(600);

  // An INDEPENDENT reader of the same dtach socket: it answers "is the fixture
  // still printing?" without going through the server at all, so a zero from
  // the control below can never be a zero about a dead shell (a vacuous
  // control is worse than no control).
  const nodePty = require(path.join(REPO, 'node_modules/node-pty'));
  const sockDir = path.join(wt, 'data', 'sockets');
  const fixtureSock = () => path.join(sockDir, fs.readdirSync(sockDir).filter((f) => f.startsWith('cw-'))[0]);
  const fixtureAlive = async () => {
    const p2 = nodePty.spawn('dtach', ['-a', fixtureSock(), '-E', '-r', 'winch'], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
    let seen = '';
    p2.onData((d) => { seen += d; });
    await sleep(2500);
    try { p2.kill(); } catch { }
    return /VSTICK/.test(seen);
  };
  ok(await fixtureAlive(), 'e2e precondition: the dtach session is STILL printing after the restart (an independent reader says so)');

  // ② the CONTROL boot: master's attach + the dead channel
  installStale();
  const savedFixed = fs.readFileSync(path.join(wt, 'src/server/session-stdout.js'), 'utf-8');
  fs.writeFileSync(path.join(wt, 'src/server/session-stdout.js'), fs.readFileSync(CONTROL_MODULE, 'utf-8'));
  srv = boot(); jrn = journal(srv); await waitReady(srv);
  {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => ws.on('open', r));
    const got = [], all = [];
    ws.on('message', (d) => { try { const m = JSON.parse(d); all.push(m); if (m.type === 'output' && /VSTICK/.test(m.data || '')) got.push(m); } catch { } });
    ws.send(JSON.stringify({ type: 'attach', sessionId: sid, cols: 80, rows: 24 }));
    await sleep(12000);   // > the whole fixed budget, and ZERO input the entire time
    // A zero that comes from "the attach never happened" would be a VACUOUS
    // control, so the attach itself is asserted first.
    ok(all.some((m) => m.type === 'attached' && m.sessionId === sid),
      'PRE-FIX CONTROL e2e: the client really attached (the zero below is about output, not about a failed attach)',
      JSON.stringify(all.map((m) => m.type)));
    ok(got.length === 0, 'PRE-FIX CONTROL e2e: the restored session streams NOTHING with no input — the production incident',
      `frames=${got.length}; journal tail: ${jrn().slice(-400)}`);
    ok(await fixtureAlive(), 'PRE-FIX CONTROL e2e: …while the session itself never stopped printing (the zero is the BRIDGE, not the shell)');
    ok(/upgrading \(attempt 1\/3\)/.test(jrn()), 'PRE-FIX CONTROL e2e: the daemon really took the self-upgrade path (the incident environment)',
      jrn().slice(-400));
    ws.close();
  }
  srv.kill('SIGKILL'); servers.delete(srv);
  fs.writeFileSync(path.join(wt, 'src/server/session-stdout.js'), savedFixed);
  await sleep(600);

  // ③ the FIXED boot: same daemon fault, same version skew, no input at all
  installStale();
  srv = boot(); jrn = journal(srv); await waitReady(srv);
  {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => ws.on('open', r));
    const got = [], all = [];
    ws.on('message', (d) => { try { const m = JSON.parse(d); all.push(m); if (m.type === 'output' && /VSTICK/.test(m.data || '')) got.push(m); } catch { } });
    ws.send(JSON.stringify({ type: 'attach', sessionId: sid, cols: 80, rows: 24 }));
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && got.length === 0) await sleep(200);
    ok(all.some((m) => m.type === 'attached' && m.sessionId === sid), 'FIX e2e: the client attached',
      JSON.stringify(all.map((m) => m.type)));
    ok(got.length > 0, 'FIX e2e: the restored session streams to an attached client with ZERO input',
      `frames=${JSON.stringify(all.map((m) => m.type))}; journal tail: ${jrn().slice(-900)}`);
    // The environment claim is asserted with a BOUNDED WAIT, not read at
    // whatever instant the leg above happened to finish. The fix makes the
    // session stream in ~1 s while the daemon's version handshake + bundle
    // upload + re-exec take several; the control leg only ever passed this
    // because it sat on a flat 12 s sleep. An assertion whose subject may not
    // have HAPPENED yet measures the other leg's duration, not the daemon.
    const tUp = Date.now();
    while (Date.now() - tUp < 25000 && !/upgrading \(attempt 1\/3\)/.test(jrn())) await sleep(250);
    ok(/upgrading \(attempt 1\/3\)/.test(jrn()), 'FIX e2e: measured in the SAME environment — the daemon self-upgraded under the restore',
      jrn().slice(-400));
    ws.close();
  }
  srv.kill('SIGKILL'); servers.delete(srv);
}   // the worktree is removed by cleanup() — see `worktrees` above

// ── § 5 ONE HEALER, TWO TRIGGERS ───────────────────────────────────────────
console.log('— §5 the attach probe and the input detector share ONE re-attach —');
{
  const wsSrc = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf-8');
  ok(/reattachLocalPty\(data\.sessionId, session, 'Broken pty stdin detected'/.test(wsSrc),
    'WIRING PIN: the broken-stdin detector calls the shared reattachLocalPty');
  ok(!/pty\.spawn\(DTACH_CMD/.test(wsSrc),
    'WIRING PIN: ws-handler no longer spawns its own dtach attach (one implementation, not two)');
  ok(/ptyQuietSince\(session, sentAt\)/.test(wsSrc),
    'WIRING PIN: the detector asks the liveness STAMP, not session.buffer.length');
  const stdoutSrc = fs.readFileSync(path.join(REPO, 'src/server/session-stdout.js'), 'utf-8');
  ok((stdoutSrc.match(/pty\.spawn\(DTACH_CMD/g) || []).length === 2,
    'WIRING PIN: exactly two local dtach spawns remain (the first attach + the ONE healer)');
  ok(/ptyProcess\.onData\(\(\) => \{ session\._lastPtyDataAt = Date\.now\(\); \}\);/.test(stdoutSrc),
    'WIRING PIN: the liveness stamp is registered in setupSessionPty — the one place every pty is wired');

  // functional: the healer re-attaches and RESENDS
  const dmNone = null;
  const { eng, activeSessions, frames } = makeEngine({ getDeviceMgr: () => dmNone, modulePath: path.join(REPO, 'src/server/session-stdout.js') });
  const sock = mkQuietFixture('healer');
  const id = 'sess-healer-' + Date.now();
  const session = { mode: 'terminal', backend: 'shell', clients: new Map(), buffer: '', socketPath: sock, cwd: ROOT };
  activeSessions.set(id, session);
  eng.attachToDtach(id, sock, session);
  await sleep(400);
  const before = session.pty;
  ok(eng.ptyQuietSince(session, Date.now()) === true, 'ptyQuietSince: no byte since NOW (the reader is not vacuously true)');
  ok(eng.ptyQuietSince(session, 0) === false, 'ptyQuietSince: a byte HAS arrived since epoch (the stamp is really written)');
  // THE TIE. The stamp is milliseconds and both callers take `since` right
  // before the thing they time, so a byte landing in that same millisecond is
  // the byte they are waiting for. It must read ALIVE: the losing side of this
  // tie RE-SENDS the user's keystroke (ws-handler's detector), and a local
  // terminal's echo really can come back inside the same ms as the write.
  ok(eng.ptyQuietSince(session, Number(session._lastPtyDataAt)) === false,
    'ptyQuietSince: a byte stamped in the SAME millisecond as `since` reads ALIVE (the tie may not cost a duplicated keystroke)');
  const healed = eng.reattachLocalPty(id, session, 'test heal', { resend: 'echo VSHEALED' });
  ok(healed === true && session.pty !== before, 'reattachLocalPty replaces the pty and reports it');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !frames.some((f) => /VSHEALED/.test(f.data || ''))) await sleep(150);
  ok(frames.some((f) => /VSHEALED/.test(f.data || '')), 'reattachLocalPty RESENDS the payload the detector was holding');
  try { session.pty?.kill?.(); } catch { }
}

// daemonPtyShim must serve MORE THAN ONE data listener (the stamp + the consumer)
console.log('— §6 the device pty shim is a real node-pty duck (multi-listener) —');
{
  const seen = [];
  const fakeHandle = { write() { }, resize() { }, kill() { } };
  const shim = dial.daemonPtyShim(fakeHandle);
  const d1 = shim.onData((s) => seen.push('a:' + s));
  shim.onData((s) => seen.push('b:' + s));
  fakeHandle.onData(Buffer.from('x'));
  ok(seen.join(',') === 'a:x,b:x', 'both onData listeners fire (a single-slot shim silently killed the stdout consumer)', seen.join(','));
  d1.dispose();
  seen.length = 0;
  fakeHandle.onData(Buffer.from('y'));
  ok(seen.join(',') === 'b:y', 'dispose() removes only its OWN listener', seen.join(','));
}

console.log(fail ? `\nFAIL (${fail} failed, ${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
