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
  ok('…and reuses a healthy recorded serve instead of spawning per call', /if \(rec && await healthy\(rec\.port\)\) return rec\.port;/.test(SCRIPT));
}

console.log(`\n${fails.length ? fails.length + ' FAILED' : 'ALL PASS'} (${pass} passed)`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
