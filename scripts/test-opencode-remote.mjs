#!/usr/bin/env node
// PARITY GATE for "reach the OpenCode serve on ANY machine" (S9 remainder
// piece (e), B-eac2) — the CS separation law made testable.
//
// There is ONE definition of what can be asked of an OpenCode serve:
// src/opencode-remote.js's OPENCODE_OPS table. Three rungs must obey it:
//   1. LOCAL   — runOpencodeOp against the in-process facts (hostId falsy);
//   2. DEVICE  — the `opencode-serve` agentd op, which BUNDLES the shared
//                module and calls the very same runOpencodeOp;
//   3. SSH     — data/bin/vibespace-opencode-op, the shipped single file for a
//                checkout-less host (the documented exception: it cannot
//                require the module, so it MIRRORS the table — and that mirror
//                is exactly what silently drifted twice for the usage scanner,
//                which is why this suite exists).
//
// A one-sided edit (a new op, a renamed param, a changed result key) fails
// here BEFORE it can ship as a feature that works on one machine and not
// another.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { startMockServe, createMockState } from './dev/mock-opencode-serve.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const remote = require(path.join(REPO, 'src/opencode-remote.js'));
const serve = require(path.join(REPO, 'src/opencode-serve.js'));

let pass = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); } };
const skip = (name, why) => { pass++; console.log(`  ⊘ SKIP ${name} — ${why}`); };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8');
const SCRIPT = read('data/bin/vibespace-opencode-op');

console.log('\n— THE OP TABLE IS ONE DEFINITION —');
{
  const names = remote.OPENCODE_OP_NAMES;
  ok('the table is non-empty and frozen', names.length >= 12 && Object.isFrozen(names), names);
  // the shipped ssh script's own OPS object, parsed out of the source
  const opsBlock = SCRIPT.slice(SCRIPT.indexOf('const OPS = {'), SCRIPT.indexOf('\n};', SCRIPT.indexOf('const OPS = {')));
  // exactly-two-space indent = a top-level entry of the OPS object; anything
  // deeper is code inside one (a loose \s+ matched `for`/`if` and passed)
  const shipped = [...opsBlock.matchAll(/^ {2}(?:async ([A-Za-z]+)\(|'([^']+)': async)/gm)].map((m) => m[1] || m[2]);
  const missing = names.filter((n) => !shipped.includes(n));
  const extra = shipped.filter((n) => !names.includes(n));
  ok('the SHIPPED ssh script implements EVERY op in the table (the usage-scanner drift class)', missing.length === 0, missing);
  ok('…and invents none of its own', extra.length === 0, extra);

  // required params must match, or a rung fails with a different error than the others
  const requiredIn = (op) => remote.OPENCODE_OPS[op].required;
  ok("the local rung REFUSES a call missing a required param, naming the op and the key", (() => {
    try { remote.checkOpParams('revert', { id: 'ses_a1' }); return false; } catch (e) { return /revert/.test(e.message) && /messageID/.test(e.message); }
  })());
  ok('an UNKNOWN op is refused with the known list (never a silent 500)', (() => {
    try { remote.checkOpParams('teleport', {}); return false; } catch (e) { return /teleport/.test(e.message) && /discover/.test(e.message); }
  })());
  ok("the ssh script refuses an unknown op the same way", /unknown opencode op/.test(SCRIPT) && /known:/.test(SCRIPT));
  ok('every required param the table names is READ by the shipped script', requiredIn('revert').every((k) => SCRIPT.includes(`p.${k}`)) && requiredIn('answer').every((k) => SCRIPT.includes(`p.${k}`)));
}

console.log('\n— RESULT SHAPES —');
{
  const mock = await startMockServe({ state: createMockState() });
  const client = new serve.OpencodeServeClient(mock.url);
  const facts = serve.createFacts({ client: async () => client, ensure: async () => client, state: () => ({ ready: true, installed: true, parked: false, caps: { fork: true }, version: '1.18.29' }), invalidate: () => { } }, { log: { warn() { } } });

  const local = {};
  for (const op of ['state', 'discover', 'read', 'questions', 'status', 'todos']) {
    local[op] = await remote.runOpencodeOp(facts, op, op === 'read' || op === 'todos' ? { id: 'ses_a1' } : {});
  }
  ok('local `discover` returns {sessions:[…]} in the entry shape the sidebar consumes', Array.isArray(local.discover.sessions) && local.discover.sessions[0]?.sessionKey?.startsWith('opencode:'), local.discover.sessions[0]);
  ok('local `read` returns {session, records}', !!local.read.session && Array.isArray(local.read.records));
  ok('local `state` reports the shape the panel reads', ['installed', 'ready', 'parked', 'version', 'liveLaneHealthy'].every((k) => k in local.state), local.state);

  // the SSH rung, for real: run the shipped script against the same mock serve
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-ssh-'));
  fs.mkdirSync(path.join(home, '.vibespace'), { recursive: true });
  fs.writeFileSync(path.join(home, '.vibespace', 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: process.pid, startedAt: Date.now(), cwd: home }));
  const runShipped = (op, params = {}) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(REPO, 'data/bin/vibespace-opencode-op')], { env: { ...process.env, HOME: home }, timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error(err.message + '\n' + stdout));
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (e) { reject(new Error('unparsable: ' + stdout)); }
    });
    child.stdin.end(JSON.stringify({ op, params }));
  });
  const sshDiscover = await runShipped('discover');
  ok('the SSH rung reuses a RECORDED healthy serve instead of starting one', sshDiscover.ok === true, sshDiscover);
  const keys = (o) => Object.keys(o || {}).sort().join(',');
  ok('…and its `discover` entries carry the SAME keys as the local rung', keys(sshDiscover.result.sessions[0]) === keys(local.discover.sessions[0]), { ssh: keys(sshDiscover.result.sessions[0]), local: keys(local.discover.sessions[0]) });
  ok('…including the opencode sub-object', keys(sshDiscover.result.sessions[0].opencode) === keys(local.discover.sessions[0].opencode), { ssh: keys(sshDiscover.result.sessions[0].opencode), local: keys(local.discover.sessions[0].opencode) });

  const sshState = await runShipped('state');
  ok('…and `state` answers the same keys', ['installed', 'ready', 'parked', 'version', 'liveLaneHealthy'].every((k) => k in sshState.result), sshState.result);

  const sshRead = await runShipped('read', { id: 'ses_a1' });
  ok('…`read` ships the RAW v1 messages (a checkout-less host has no record synthesis)', Array.isArray(sshRead.result.messages) && sshRead.result.records === null);
  // …and the ACCESS layer turns them into the SAME records the local rung returns
  const accessMod = require(path.join(REPO, 'src/server/opencode-access.js'));
  const layer = accessMod.create({ facts, hosts: { opencodeOp: async (_h, op, p) => (await runShipped(op, p)).result } });
  const viaSsh = await layer.readConversation('h1', 'ses_a1');
  const viaLocal = await layer.readConversation(null, 'ses_a1');
  ok('the hub synthesises the records ONCE for every rung (ssh === local, record for record)', JSON.stringify(viaSsh.records) === JSON.stringify(viaLocal.records), { ssh: viaSsh.records.length, local: viaLocal.records.length });

  const sshQ = await runShipped('questions');
  ok('…`questions` answers {questions:[…]}', Array.isArray(sshQ.result.questions));
  const sshRevert = await runShipped('revert', { id: 'ses_a1', messageID: 'msg_u2' });
  ok('…`revert` returns {session} with the staged roll-back, exactly like the local rung', sshRevert.result.session?.revert?.messageID === 'msg_u2', sshRevert.result.session?.revert);
  await runShipped('unrevert', { id: 'ses_a1' });

  const sshBad = await runShipped('revert', { id: 'ses_a1' });
  ok('a missing required param FAILS on the ssh rung too (never a half-done action)', sshBad.ok === false && /messageID|400|required/i.test(sshBad.error), sshBad);
  const sshPty = await runShipped('pty-open', {});
  ok('the ssh rung REFUSES the pty ops and says why (the serve ws is loopback-only on that host)', sshPty.ok === false && /loopback|websocket/i.test(sshPty.error), sshPty.error);
  ok('…and the ACCESS layer refuses them for ANY remote machine before the transport is even used', await (async () => {
    try { await layer.call('h1', 'pty-open', {}); return false; } catch (e) { return /only works on this machine/.test(e.message); }
  })());

  fs.rmSync(home, { recursive: true, force: true });
  await mock.close();
}

console.log('\n— THE DEVICE RUNG (three-touch rule) —');
{
  const agentd = read('src/agentd/agentd.js');
  const client = read('src/agentd/client.js');
  ok('the daemon handles the op and runs THE SHARED runOpencodeOp (not a re-implementation)', /msg\.op === 'opencode-serve'/.test(agentd) && /runOpencodeOp/.test(agentd) && /require\('\.\/\.\.\/opencode-serve\.js'\)/.test(agentd));
  ok('the reply carries `op` (an op-less reply times out — the 2.300.0 rule)', /op: 'opencode-serve-result'/.test(agentd));
  ok('…and the client ROUTES that op in its id-keyed set', /m\.op === 'opencode-serve-result'/.test(client));
  ok('the capability is advertised in the hello-ack', /'opencode-serve'\]/.test(agentd) || /'peer-post', 'opencode-serve'/.test(agentd));
  ok('the client GATES on the capability (an old daemon is never asked — unknown ops HANG)', /capabilities\?\.includes\?\.\('opencode-serve'\)/.test(client));
  // ONE PER PROCESS, and the shape of the mistake matters: inside a Mux
  // control handler `this` is the CONNECTION, so a `this._ocFacts` cache is
  // rebuilt on every reconnect and each install() arms another live lane
  // (SSE + fs.watch) while the old one keeps running — a silent unbounded
  // leak on a dial device that reconnects on every link blip.
  ok('the daemon keeps ONE facts singleton PER PROCESS (never on `this` — that is the connection)', (() => {
    const decl = agentd.indexOf('let ocFacts = null;');
    return decl > 0 && decl < agentd.indexOf('function serveConnection(') && /if \(!ocFacts\)/.test(agentd) && !/this\._ocFacts/.test(agentd);
  })());
  ok('the daemon bundle actually carries the shared module + table', (() => {
    const b = path.join(REPO, 'data/bin/vibespace-agentd.js');
    if (!fs.existsSync(b)) return false;
    const t = fs.readFileSync(b, 'utf-8');
    return t.includes('runOpencodeOp') && t.includes('OpencodeServeClient');
  })(), 'run npm run build:agentd');

  const hosts = read('src/hosts.js');
  ok('hosts.opencodeOp prefers the DEVICE rung and falls back to ssh only for a real ssh host', /async opencodeOp\(/.test(hosts) && /dm\.opencodeServe\(/.test(hosts) && /if \(h\.transport === 'dial'\) throw e;/.test(hosts));
  // …and the fallback must not COST anything: both rungs key off the SAME
  // record, so an ssh retry after a device failure REUSES the daemon's serve
  // instead of starting a second `opencode serve` on that machine.
  ok('the device rung and the shipped script share ONE serve record (a fallback never spawns a second serve)', (() => {
    const daemonDataDir = /dataDir: path\.join\(process\.env\.HOME \|\| require\('os'\)\.homedir\(\), '\.vibespace'\)/.test(read('src/agentd/agentd.js'));
    const locatorRecord = /const recordPath = path\.join\(dataDir, 'opencode-serve\.json'\);/.test(read('src/opencode-serve.js'));
    const scriptRecord = /const BASE = path\.join\(HOME, '\.vibespace'\);/.test(SCRIPT) && /const RECORD = path\.join\(BASE, 'opencode-serve\.json'\);/.test(SCRIPT);
    return daemonDataDir && locatorRecord && scriptRecord;
  })());
  ok('…the shipped script rides the COMMAND (base64), never stdin next to the payload (head -c over-reads a pipe)', /base64 -d > "\$HOME\/\.vibespace\/bin\/vibespace-opencode-op"/.test(hosts));
  ok('…and a failing rung THROWS with the machine-side reason', /throw new Error\(parsed\.error/.test(hosts));
  ok('the access layer routes by hostId ALONE (no second "is this remote" branch downstream)', /if \(!hostId\) return runOpencodeOp/.test(read('src/server/opencode-access.js')));
}

console.log('\n— RESOURCE DISCIPLINE ON SOMEONE ELSE\'S MACHINE —');
{
  ok('the shipped script starts the serve from its OWN empty repo, never $HOME', /opencode-serve-cwd/.test(SCRIPT) && /git', \['init'/.test(SCRIPT) && !/cwd: HOME/.test(SCRIPT));
  // strip comments first: the header EXPLAINS the v2 rule, the code must not USE it
  const CODE = SCRIPT.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  ok('…uses v1 routes ONLY (every /api/session/:id/… route boots an indexing instance)', !/\/api\/session/.test(CODE), (CODE.match(/.*\/api\/session.*/g) || []).slice(0, 3));
  ok('…takes the DIRECTORY-LESS listing and never bootstraps a project on a host that is not ours', /'\/session' \+ q\(\{ limit/.test(SCRIPT) && !/scope=project/.test(SCRIPT) && !/scope: 'project'/.test(SCRIPT));
  ok('…caps every response it reads into memory', /maxBytes/.test(SCRIPT));
  ok('…writes its record atomically (tmp + rename)', /renameSync/.test(SCRIPT));
  ok('…and reuses a healthy recorded serve instead of spawning per call, then SETTLES the record before anything overwrites it (round 11)',
    /if \(await healthy\(rec\.port\)\) return rec\.port;/.test(SCRIPT) && /await settleRecordedServe\(rec\) === 'answered'/.test(SCRIPT));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDED-SERVE SETTLEMENT IS ONE DECISION ON EVERY MACHINE (round 11).
//
// Round 10 fixed the local keeper: a recorded serve that is ALIVE but silent is
// never spawned over. The shipped script carried the UNFIXED twin — `locate()`
// probed the recorded port and, on any non-answer, started a second serve and
// overwrote the record. Out here that is strictly worse than at home: an ssh
// host has no keeper, no runaway guard, no park and no ⚙ card, so an orphaned
// `opencode serve` keeps indexing + inotify-watching whatever tree it was
// started on and NOTHING can ever reach it again (the 2.369.50 burn, on someone
// else's machine).
//
// This section is the usage-scanner parity pattern applied to a DECISION rather
// than to a data walk: the two classifiers are driven over the SAME table and
// must not disagree, the three budgets are pinned to the module's exported
// numbers, and then the real script is driven through each verdict against a
// real silent socket and real processes.
console.log('\n— THE RECORDED-SERVE SETTLEMENT IS ONE DECISION ON EVERY MACHINE (round 11) —');
{
  /** The script cannot be require()d (it is a stdin CLI, and a checkout-less
   *  host is the whole point), so the classifier is lifted out of its source
   *  by brace-matching and evaluated. It is a PURE function of its two
   *  arguments — if that ever stops being true this extraction throws and the
   *  assert below goes red rather than quietly testing nothing. */
  const scriptClassify = (() => {
    const i = SCRIPT.indexOf('function classifyRecordedPid(');
    if (i < 0) return null;
    let depth = 0, end = -1;
    for (let k = SCRIPT.indexOf('{', i); k < SCRIPT.length; k++) {
      if (SCRIPT[k] === '{') depth++;
      else if (SCRIPT[k] === '}' && --depth === 0) { end = k; break; }
    }
    if (end < 0) return null;
    try { return new Function(`${SCRIPT.slice(i, end + 1)}; return classifyRecordedPid;`)(); } catch { return null; }
  })();
  ok('the shipped script carries its OWN copy of the verdict, and it is extractable — so "the two rungs agree" is testable at all', typeof scriptClassify === 'function');

  const REC = { port: 4711, pid: 321, command: '/usr/bin/opencode' };
  const self = { selfUid: 1000, selfPid: 999 };
  // one row per DECISION the settlement can reach, on both rungs
  const TABLE = [
    ['a live serve running the recorded port, as us', { pid: 321, argv: ['/usr/bin/opencode', 'serve', '--port', '4711'], uid: 1000 }, 'ours'],
    ['…the `--port=N` spelling of the same fact', { pid: 321, argv: ['opencode', 'serve', '--port=4711'], uid: 1000 }, 'ours'],
    ['…re-exec\'d through a runtime (argv[0] is not the discriminator, the PORT is)', { pid: 321, argv: ['/usr/bin/bun', 'opencode.js', 'serve', '--port', '4711'], uid: 1000 }, 'ours'],
    ['a serve on a DIFFERENT port is not this record\'s serve', { pid: 321, argv: ['opencode', 'serve', '--port', '4712'], uid: 1000 }, 'other'],
    // …and the two halves of "ours" are BOTH required, each pinned on its own:
    // a loosened word test or a dropped port test is exactly the one-sided edit
    // this parity gate exists to catch (it slipped through once, unpinned).
    ['a word that merely LOOKS like it (`server`, not `serve`)', { pid: 321, argv: ['opencode', 'server', '--port', '4711'], uid: 1000 }, 'other'],
    ['`serve` with no port at all', { pid: 321, argv: ['opencode', 'serve'], uid: 1000 }, 'other'],
    ['the recorded port on a process that is not serving', { pid: 321, argv: ['curl', 'http://127.0.0.1', '--port', '4711'], uid: 1000 }, 'other'],
    ['a port that only PREFIX-matches the record (4711 vs 47110)', { pid: 321, argv: ['opencode', 'serve', '--port', '47110'], uid: 1000 }, 'other'],
    ['an unrelated program that inherited the pid', { pid: 321, argv: ['/usr/bin/python3', 'train.py'], uid: 1000 }, 'other'],
    ['another USER\'s process — never ours, never signalled', { pid: 321, argv: ['opencode', 'serve', '--port', '4711'], uid: 1001 }, 'other'],
    ['the record naming THIS process (a recycled pid)', { pid: 999, argv: ['node', 'x.js'], uid: 1000 }, 'other'],
    ['a record with no pid at all', { pid: null }, 'other'],
    ['UNREADABLE on a host that reads other processes (hidepid / it just vanished)', { pid: 321, argv: null, uid: null, hostReadable: true }, 'unknown'],
    ['an EMPTY command line there (a zombie)', { pid: 321, argv: [], uid: 1000, hostReadable: true }, 'unknown'],
    ['…the SAME silence on a host that cannot read its own pid = no reader at all', { pid: 321, argv: null, uid: null, hostReadable: false }, 'blind'],
    ['…and evidence still beats the host-level claim', { pid: 321, argv: ['opencode', 'serve', '--port', '4711'], uid: 1000, hostReadable: false }, 'ours'],
  ];
  const rows = TABLE.map(([label, o, want]) => ({
    label, want,
    local: serve.classifyRecordedPid(REC, { ...self, ...o }).verdict,
    ssh: scriptClassify ? scriptClassify(REC, { ...self, ...o }).verdict : null,
  }));
  ok('PARITY: every input reaches the SAME verdict on the local rung and the shipped script — and it is the verdict the table names',
    rows.every((r) => r.local === r.want && r.ssh === r.want), rows.filter((r) => r.local !== r.want || r.ssh !== r.want));
  // …and a one-sided edit is what this catches, so prove the comparison BITES
  ok('(the control) the comparison is not vacuous: a deliberately wrong expectation is rejected by both rungs',
    !!scriptClassify && serve.classifyRecordedPid(REC, { ...self, pid: 321, argv: ['python3'], uid: 1000 }).verdict !== 'ours'
    && scriptClassify(REC, { ...self, pid: 321, argv: ['python3'], uid: 1000 }).verdict !== 'ours');
  const num = (name) => { const m = new RegExp(`const ${name} = (\\d+);`).exec(SCRIPT); return m ? Number(m[1]) : null; };
  ok('…and the two rungs wait the SAME number of milliseconds before deciding (confirm probe / SIGTERM budget / poll)',
    num('RECORD_CONFIRM_TIMEOUT_MS') === serve.RECORD_CONFIRM_TIMEOUT_MS && num('RECORD_KILL_WAIT_MS') === serve.RECORD_KILL_WAIT_MS
    && num('RECORD_KILL_POLL_MS') === serve.RECORD_KILL_POLL_MS,
    { ssh: ['RECORD_CONFIRM_TIMEOUT_MS', 'RECORD_KILL_WAIT_MS', 'RECORD_KILL_POLL_MS'].map(num), local: [serve.RECORD_CONFIRM_TIMEOUT_MS, serve.RECORD_KILL_WAIT_MS, serve.RECORD_KILL_POLL_MS] });
  ok('…and the script names the two ways out in its refusal, exactly like the local park does (stop that process, or delete the record)',
    /Refusing to start a second serve over it: stop that process, or delete/.test(SCRIPT));
}

/** …AND NOW THE REAL SCRIPT, against a real silent socket and real processes.
 *  Only two things are faked: the `opencode` binary (OPENCODE_CMD → a script
 *  that logs every invocation, so "spawned NOTHING" is a measurement, not an
 *  inference) and the recorded serve's socket. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const homes = [], kids = [], servers = [];

  /** accepts, answers the first `hangFirst` requests never, then answers. */
  const socket = async (hangFirst = Infinity) => {
    let seen = 0; const held = [];
    const srv = http.createServer((req, res) => {
      if (++seen <= hangFirst) { held.push(res); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ healthy: true, version: '1.18.29' }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const h = { port: srv.address().port, close: () => new Promise((r) => { for (const x of held) { try { x.destroy(); } catch { } } srv.close(() => r()); }) };
    servers.push(h); return h;
  };
  const mkHome = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r11-')); fs.mkdirSync(path.join(d, '.vibespace'), { recursive: true }); homes.push(d); return d; };
  const writeRec = (home, rec) => fs.writeFileSync(path.join(home, '.vibespace', 'opencode-serve.json'), JSON.stringify(rec));
  const readRec = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.vibespace', 'opencode-serve.json'), 'utf8')); } catch { return null; } };
  /** a fake `opencode` that ANSWERS /global/health — so a spawn that happens
   *  really succeeds, and the leg can tell "refused to spawn" from "spawned
   *  and the boot failed". Every invocation appends to spawn.log. */
  const fakeCli = (home) => {
    const p = path.join(home, 'fake-opencode');
    fs.writeFileSync(p, `#!/usr/bin/env node
const fs=require('fs'),http=require('http');
fs.appendFileSync(process.env.FAKE_LOG, process.pid+' '+process.argv.slice(2).join(' ')+'\\n');
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({healthy:true,version:'fake'}))}).listen(port,'127.0.0.1');
`, { mode: 0o755 });
    return p;
  };
  /** a REAL process the record can name. `ours:true` ⇒ its /proc cmdline is
   *  `… serve --port <port>`; `stubborn:true` ⇒ it records SIGTERM and lives. */
  const holder = async (home, { ours, port, stubborn = false }) => {
    const sigFile = path.join(home, `sigterm-${Math.random().toString(36).slice(2)}`);
    const body = `const fs=require('fs');process.on('SIGTERM',()=>{try{fs.appendFileSync(${JSON.stringify(sigFile)},'x')}catch{}${stubborn ? '' : ';process.exit(0)'}});setInterval(()=>{},10000)`;
    const argv = ours ? ['serve', '--port', String(port), '--hostname', '127.0.0.1'] : ['train.py', '--epochs', '3'];
    const kid = spawn(process.execPath, ['-e', body, ...argv], { stdio: 'ignore' });
    kids.push(kid);
    for (let i = 0; i < 40 && !alive(kid.pid); i++) await sleep(25);
    return { pid: kid.pid, signalled: () => fs.existsSync(sigFile) };
  };
  /** the REAL shipped script (or a pre-fix copy of it), one op, one HOME. */
  const runIn = (home, { script = path.join(REPO, 'data/bin/vibespace-opencode-op'), op = 'state', params = {} } = {}) => new Promise((resolve) => {
    const child = execFile(process.execPath, [script], {
      env: { ...process.env, HOME: home, OPENCODE_CMD: fakeCli(home), FAKE_LOG: path.join(home, 'spawn.log') }, timeout: 60000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: 'RUNNER: ' + err.message + '\n' + stdout });
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ ok: false, error: 'unparsable: ' + stdout }); }
    });
    child.stdin.end(JSON.stringify({ op, params }));
  });
  const spawns = (home) => { try { return fs.readFileSync(path.join(home, 'spawn.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

  // the PRE-FIX copy of the script: the one line round 11 replaced
  const preFix = (() => {
    const from = "  if (rec) {\n    if (await healthy(rec.port)) return rec.port;\n    if (await settleRecordedServe(rec) === 'answered') return rec.port;\n  }";
    if (SCRIPT.split(from).length - 1 !== 1) return null;
    const f = path.join(os.tmpdir(), `vs-oc-op-prefix-${process.pid}`);
    fs.writeFileSync(f, SCRIPT.split(from).join('  if (rec && await healthy(rec.port)) return rec.port;'), { mode: 0o755 });
    return f;
  })();
  ok('(the control itself) a PRE-FIX copy of the shipped script can be built — the A/B below is only meaningful against it', !!preFix);

  // ① THE ONE THE ROUND FIXED: alive, verifiably that serve, and it will not die.
  {
    const home = mkHome(); const sock = await socket();
    const h = await holder(home, { ours: true, port: sock.port, stubborn: true });
    writeRec(home, { port: sock.port, pid: h.pid, startedAt: Date.now(), cwd: home });
    const r = await runIn(home);
    const rec = readRec(home);
    ok('a recorded serve that is ALIVE and silent is NOT spawned over: the op fails honestly and starts nothing',
      r.ok === false && spawns(home).length === 0, { r, spawns: spawns(home) });
    ok('…the record still names the OLD serve (the next op can still find it; nothing was orphaned)',
      !!rec && rec.port === sock.port && rec.pid === h.pid, rec);
    ok('…the refusal names the pid, the port, the record file and both ways out',
      /did not exit within/.test(r.error || '') && (r.error || '').includes(String(h.pid)) && (r.error || '').includes(String(sock.port))
      && /opencode-serve\.json/.test(r.error || '') && /stop that process, or delete/.test(r.error || ''), r.error);
    ok('…and it DID try to stop it first (a refusal is the last rung, not the first)', h.signalled() === true && alive(h.pid) === true);
    if (!preFix) skip('NEGATIVE CONTROL: the pre-fix script orphans that serve', 'no pre-fix copy');
    else {
      const home2 = mkHome(); const sock2 = await socket();
      const h2 = await holder(home2, { ours: true, port: sock2.port, stubborn: true });
      writeRec(home2, { port: sock2.port, pid: h2.pid, startedAt: Date.now(), cwd: home2 });
      const ctl = await runIn(home2, { script: preFix });
      const rec2 = readRec(home2);
      ok('NEGATIVE CONTROL: the PRE-FIX script starts a SECOND serve and overwrites the record — the live one is now unnamed, and on an ssh host nothing can ever reach it again',
        ctl.ok === true && spawns(home2).length === 1 && !!rec2 && rec2.port !== sock2.port && alive(h2.pid) === true, { ctl, rec2, spawns: spawns(home2) });
    }
  }

  // ② THE DEAD PID: the record is stale bookkeeping — clear it and start one.
  {
    const home = mkHome(); const sock = await socket();
    const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((r) => gone.once('exit', r));
    for (let i = 0; i < 40 && alive(gone.pid); i++) await sleep(25);
    writeRec(home, { port: sock.port, pid: gone.pid, startedAt: Date.now(), cwd: home });
    const r = await runIn(home);
    const rec = readRec(home);
    ok('a recorded serve whose pid is DEAD is cleared and replaced — the op succeeds on the new serve',
      r.ok === true && spawns(home).length === 1 && !!rec && rec.port !== sock.port, { r, rec, spawns: spawns(home) });
  }

  // ③ A RECYCLED PID: alive, provably NOT that serve — replace the record, and
  //    never signal a stranger by number.
  {
    const home = mkHome(); const sock = await socket();
    const h = await holder(home, { ours: false, port: sock.port });
    writeRec(home, { port: sock.port, pid: h.pid, startedAt: Date.now(), cwd: home });
    const r = await runIn(home);
    const rec = readRec(home);
    ok('a recorded pid that is alive but is NOT that serve (a recycled number) is cleared and replaced',
      r.ok === true && spawns(home).length === 1 && !!rec && rec.port !== sock.port, { r, rec, spawns: spawns(home) });
    ok('…and that stranger is never signalled — it is still running, and it never saw a SIGTERM',
      alive(h.pid) === true && h.signalled() === false);
  }

  // ④ SLOW IS NOT WEDGED: the confirm probe answers, so the serve is REUSED and
  //    nothing is stopped or started (the positive control the refusal needs).
  {
    const home = mkHome(); const sock = await socket(1);   // the first probe hangs, the confirm probe answers
    const h = await holder(home, { ours: true, port: sock.port });
    writeRec(home, { port: sock.port, pid: h.pid, startedAt: Date.now(), cwd: home });
    const r = await runIn(home);
    const rec = readRec(home);
    ok('a recorded serve that misses the first probe but answers the LONGER confirm one is adopted, not replaced',
      r.ok === true && spawns(home).length === 0 && !!rec && rec.port === sock.port && rec.pid === h.pid, { r, rec, spawns: spawns(home) });
    ok('…and it is never signalled for being slow', alive(h.pid) === true && h.signalled() === false);
  }

  for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch { } }
  for (const h of homes) { for (const l of spawns(h)) { const pid = Number(l.split(' ')[0]); try { process.kill(pid, 'SIGKILL'); } catch { } } }
  for (const s of servers) { try { await s.close(); } catch { } }
  if (preFix) { try { fs.rmSync(preFix, { force: true }); } catch { } }
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}

console.log(`\n${fails.length ? fails.length + ' FAILED' : 'ALL PASS'} (${pass} passed)`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
