#!/usr/bin/env node
// THE OPENCODE BACKGROUND SERVICE IS A PLUGIN, DEFAULT OFF (owner decision
// 2026-09-07). This suite is the gate for that decision:
//   ① PluginManager: the third built-in def, its status/serviceState shape,
//      the prompted flag, config refusal, install honesty, broadcasts
//   ② decideAutostart: env override > plugin record; DEFAULT OFF
//   ③ a REAL keeper driven by the plugin: fresh data spawns NOTHING, enable →
//      started, disable → the process is gone (incl. an ADOPTED one) and never
//      respawns, boot replay brings an enabled+desiredUp service back
//   ④ a REAL server (isolated worktree, restore-smoke pattern): zero spawns on
//      a fresh instance even while the session list is polled, enable over
//      HTTP, SIGKILL → reboot → replay, disable → stopped, env override
//   ⑤ headless chrome: the first-use dialog appears ONCE from a real call
//      site, "Enable & start" proceeds, "Not now" is remembered instance-wide
//   ⑥ wiring pins (the call sites, the removed setting, i18n)
// Run: node scripts/test-opencode-plugin.mjs   (⑤ SKIPs without chrome)
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO, 'scripts/dev/mock-opencode-serve.mjs');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e !== undefined ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 600) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const serve = require(path.join(REPO, 'src/opencode-serve.js'));
const { PluginManager, OPENCODE_SERVE_ID } = require(path.join(REPO, 'src/plugins.js'));

// A stand-in `opencode` binary: `<stub> serve --port N …` starts the mock serve.
// (Never the real CLI — a gate must not depend on what is installed, and it
// must never touch the developer's own OpenCode store.)
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ocp-bin-'));
const STUB = path.join(stubDir, 'opencode');
fs.writeFileSync(STUB, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK)} "$@"\n`);
fs.chmodSync(STUB, 0o755);
const strays = new Set();
const tmpDirs = new Set([stubDir]);
// a gate that litters /tmp on every run is a gate people stop running
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ocp-')); tmpDirs.add(d); return d; };
process.on('exit', () => {
  for (const p of strays) { try { process.kill(p, 'SIGKILL'); } catch { } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
});

const mkManager = (dir, { serveModule = serve, broadcast = () => { } } = {}) =>
  new PluginManager({ dataDir: dir, broadcast, opencodeServe: serveModule });

console.log('— ① the built-in plugin def + its state');
{
  const dir = mkTmp();
  const sent = [];
  // an UNWIRED serve module (no cli-env install) — NULL_FACTS, exactly what a
  // bare `require` sees; the panel must still render something honest
  const pm = mkManager(dir, { broadcast: (m) => sent.push(m) });
  const def = pm.defs()[OPENCODE_SERVE_ID];
  ok('a THIRD built-in plugin exists next to tailscale/frp, with the same def shape', !!def && def.id === 'opencode-serve' && /OpenCode/.test(def.label) && def.description.length > 40 && Object.keys(pm.defs()).length === 3);
  const st0 = pm.status(OPENCODE_SERVE_ID);
  ok('FRESH instance ⇒ OFF: enabled false, desiredUp false, prompted false, running false (the owner decision, no migration needed)', st0.enabled === false && st0.desiredUp === false && st0.prompted === false && st0.running === false);
  ok('wantsServiceUp is false on a fresh record (this is the plugin half of the autostart decision)', pm.wantsServiceUp(OPENCODE_SERVE_ID) === false);
  const svc = pm.serviceState(OPENCODE_SERVE_ID);
  ok('serviceState is the compact row the client gates on (id/label/enabled/prompted/installed/running/envForced/reason)', svc.id === 'opencode-serve' && svc.enabled === false && svc.prompted === false && 'installed' in svc && 'running' in svc && svc.envForced === null && typeof svc.description === 'string');
  ok('serviceState(unknown) is null, never a fabricated row', pm.serviceState('nope') === null);
  ok('list() carries it too (the ⚙ → Plugins panel)', pm.list().some((p) => p.id === 'opencode-serve' && p.enabled === false));
  let cfgErr = null; try { pm.setConfig(OPENCODE_SERVE_ID, { port: 1 }); } catch (e) { cfgErr = e; }
  ok('there is NOTHING to configure — setConfig refuses loudly instead of pretending to store a port', /nothing to configure/.test(cfgErr?.message || ''), cfgErr?.message);
  let insErr = null; try { pm._ocInstall(); } catch (e) { insErr = e; }
  ok('install() with no `opencode` on PATH says how to get it (VibeSpace runs YOUR CLI, it never downloads one)', /not on PATH/.test(insErr?.message || '') && /opencode\.ai/.test(insErr?.message || ''), insErr?.message);

  pm.setPrompted(OPENCODE_SERVE_ID);
  ok('setPrompted persists the "we already asked" flag and BROADCASTS it (instance state, never per-browser localStorage)', pm.status(OPENCODE_SERVE_ID).prompted === true && sent.some((m) => m.type === 'plugins-updated' && m.services?.[OPENCODE_SERVE_ID]?.prompted === true));
  ok('…and it survives a reload of the store (data/plugins.json)', mkManager(dir).status(OPENCODE_SERVE_ID).prompted === true);
  ok('every plugins-updated broadcast now carries `services` (the client maps servicePlugin → BACKEND_META.service from it)', sent.every((m) => m.type !== 'plugins-updated' || (m.services && m.services.tailscale && m.services.frp && m.services[OPENCODE_SERVE_ID])));
  {
    // status('tailscale') SHELLS OUT on the event loop — the panel rows and the
    // service rows must come from ONE walk, not two (never-block-the-loop)
    let calls = 0; const spy = mkManager(dir);
    const real = spy.status.bind(spy); spy.status = (id) => { calls++; return real(id); };
    spy._snapshot();
    ok('list + services are built in ONE pass (one status() per plugin), never two walks over a probing status()', calls === 3, calls);
  }
  pm.setPrompted(OPENCODE_SERVE_ID, false);
  ok('the flag can be cleared (a re-offer is possible; nothing is one-way)', pm.status(OPENCODE_SERVE_ID).prompted === false);
}

console.log('— ①b the /api/home "broken store" predicate (a deliberately-off service is NOT broken)');
{
  // REGRESSION (the every-page-load red toast): /api/home used to flag the
  // store as FAILED whenever `!ready && autostart === false`. That condition
  // only ever meant "ops set VIBESPACE_OPENCODE_SERVE=0" while autostart
  // defaulted ON — the moment the service became an opt-in plugin (DEFAULT
  // OFF) it became the NORMAL shipped state, and app.js toasts a red error
  // for every reason /api/home carries: one per page load, on a fresh
  // instance, after "Not now", and on instances that never had OpenCode.
  const { storeFailureReason } = require(path.join(REPO, 'src/server/cli-env.js'));
  const mk = (st, why = 'because') => ({ id: 'opencode', store: { serveState: () => st, unavailableReason: () => why } });
  ok('DEFAULT OFF (the shipped state) is NOT a store failure ⇒ no storeReason ⇒ no red toast on every load', storeFailureReason(mk({ ready: false, parked: false, autostart: false, envForced: null, installed: true })) === null);
  ok('…nor after the user answered "Not now", nor where the CLI is absent (same state)', storeFailureReason(mk({ ready: false, parked: false, autostart: false, envForced: null, installed: false })) === null);
  ok('…nor when OPS forced it off — that is a deliberate choice the ⚙ card and the sidebar row explain, not an error', storeFailureReason(mk({ ready: false, parked: false, autostart: false, envForced: false })) === null);
  ok('a CRASH park still speaks — that is what this channel is for (2.369.42 burned two hours in silence)', storeFailureReason(mk({ parked: true, parkedKind: 'crash' }, 'parked after 5 crashes')) === 'parked after 5 crashes');
  ok('…and a RUNAWAY park speaks with the guard sentence', storeFailureReason(mk({ parked: true, parkedKind: 'runaway' }, 'stopped as a RUNAWAY — 190% CPU')) === 'stopped as a RUNAWAY — 190% CPU');
  ok('a park whose harness has no reason text falls back to lastError, never to an empty string', storeFailureReason({ store: { serveState: () => ({ parked: true, lastError: 'boom' }) } }) === 'boom');
  ok('a harness with no store (claude/codex/shell) is never flagged, and a THROWING store never breaks /api/home', storeFailureReason({ id: 'claude' }) === null && storeFailureReason({ store: { serveState: () => { throw new Error('x'); } } }) === null);
  const ce = read('src/server/cli-env.js');
  ok('ONE predicate: /api/home AND the live harness-store-updated push both call it (they were twins that disagreed — and the loud half was /api/home)', /const failed = storeFailureReason\(h\);/.test(ce) && /const reason = storeFailureReason\(harnessOf\('opencode'\), st\);/.test(ce) && !/autostart === false/.test(ce));
}

console.log('— ② decideAutostart: the ONE decision');
{
  ok('DEFAULT OFF: no env, plugin not enabled ⇒ false', serve.decideAutostart({ env: {}, pluginWantsUp: false }) === false);
  ok('the plugin record is the switch: enabled+desiredUp ⇒ true', serve.decideAutostart({ env: {}, pluginWantsUp: true }) === true);
  ok('VIBESPACE_OPENCODE_SERVE=0 WINS over an enabled plugin (ops override)', serve.decideAutostart({ env: { VIBESPACE_OPENCODE_SERVE: '0' }, pluginWantsUp: true }) === false);
  ok('VIBESPACE_OPENCODE_SERVE=1 WINS over a disabled plugin (ops override)', serve.decideAutostart({ env: { VIBESPACE_OPENCODE_SERVE: '1' }, pluginWantsUp: false }) === true);
  ok('an EMPTY env value is not an override (an unset var in a shell wrapper reads as "")', serve.serveEnvOverride({ VIBESPACE_OPENCODE_SERVE: '' }) === null && serve.serveEnvOverride({}) === null && serve.decideAutostart({ env: { VIBESPACE_OPENCODE_SERVE: '' }, pluginWantsUp: false }) === false);
  ok('the SKIP_AGENT_HOOKS smoke belt is GONE — with default OFF no harness needs it, and the plugin record is the only switch', serve.decideAutostart({ env: { VIBESPACE_SKIP_AGENT_HOOKS: '1' }, pluginWantsUp: true }) === true && !/VIBESPACE_SKIP_AGENT_HOOKS/.test(read('src/opencode-serve.js')));
  ok('the module NAMES its control plugin (the harness descriptor mirrors it as store.servicePlugin)', serve.SERVICE_PLUGIN_ID === 'opencode-serve' && /servicePlugin: serve\.SERVICE_PLUGIN_ID/.test(read('src/harnesses/opencode.js')));
}

console.log('— ③ a REAL keeper driven by the plugin record');
{
  const dir = mkTmp();
  let spawns = 0;
  const spawnImpl = (cmd, args, opts) => { spawns++; const c = spawn(cmd, args, opts); strays.add(c.pid); return c; };
  // the REAL install() wiring shape: autostart reads the plugin through the
  // same function cli-env passes
  let pm = null;
  const facts = serve.install({
    dataDir: dir, command: () => STUB, env: () => ({ ...process.env }), log: null,
    spawnImpl, bootTimeoutMs: 15000,
    autostart: () => serve.decideAutostart({ env: {}, pluginWantsUp: !!pm?.wantsServiceUp(OPENCODE_SERVE_ID) }),
  });
  pm = mkManager(dir);

  ok('DISABLED plugin ⇒ a whole discovery tick spawns NOTHING and lists nothing (never a silent throw)', (await facts.discover({})).length === 0 && spawns === 0);
  ok('…and the user-facing reason NAMES the plugin, not a setting', /background service is off/.test(facts.reasonUnavailable()) && /⚙ → Plugins/.test(facts.reasonUnavailable()), facts.reasonUnavailable());
  ok('…and no record file was written for a service that never started', !fs.existsSync(path.join(dir, 'opencode-serve.json')));

  // ENABLE (the "Enable & start" path)
  pm.start(OPENCODE_SERVE_ID);
  ok('start() flips enabled AND desiredUp (Start IS the enable — autostart reads both)', pm.wantsServiceUp(OPENCODE_SERVE_ID) === true && pm.status(OPENCODE_SERVE_ID).enabled === true);
  pm.setEnabled(OPENCODE_SERVE_ID, false); pm.setEnabled(OPENCODE_SERVE_ID, true);
  ok('enabled/desiredUp move in LOCKSTEP — ticking the switch cannot leave an "enabled but autostart:false" limbo (a visible no-op)', pm.wantsServiceUp(OPENCODE_SERVE_ID) === true && pm.status(OPENCODE_SERVE_ID).enabled === true && pm.status(OPENCODE_SERVE_ID).desiredUp === true);
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); if (facts.state().ready) up = facts.state(); }
  ok('…the keeper actually started a serve and adopted it', !!up && up.source === 'spawned' && spawns === 1 && !!up.port, facts.state());
  const pid1 = facts.state().pid;
  ok('…the record is on disk for the next boot to reuse', fs.existsSync(path.join(dir, 'opencode-serve.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'opencode-serve.json'), 'utf8')).pid === pid1);
  ok('…and discovery now returns the store (the whole point of the service)', (await facts.discover({})).length > 0);
  const pstat = pm.status(OPENCODE_SERVE_ID);
  ok('the panel status reports running with the port/pid/source it can only get from the ONE keeper', pstat.running === true && pstat.port === facts.state().port && pstat.pid === pid1 && pstat.source === 'spawned' && pstat.installed === true);

  // DISABLE — the process must be GONE and must not come back
  pm.setEnabled(OPENCODE_SERVE_ID, false);
  for (let i = 0; i < 40 && alive(pid1); i++) await sleep(100);
  ok('disable STOPS the daemon (a background process the user just turned off must not keep running)', !alive(pid1) && facts.state().ready === false && pm.status(OPENCODE_SERVE_ID).enabled === false && pm.wantsServiceUp(OPENCODE_SERVE_ID) === false);
  ok('…clears the record so nothing adopts it later', !fs.existsSync(path.join(dir, 'opencode-serve.json')));
  const spawnsAfter = spawns;
  await facts.discover({});
  await sleep(400);
  await facts.discover({});
  ok('…and NEVER respawns: the keeper stays down while the plugin is off', spawns === spawnsAfter && facts.state().ready === false);
  ok('…the reason after a disable names the plugin again', /background service is off/.test(facts.reasonUnavailable()));

  // RE-ENABLE after a stop(): the locator must be re-armable (a stop() used to be terminal)
  pm.start(OPENCODE_SERVE_ID);
  let up2 = null;
  for (let i = 0; i < 60 && !up2; i++) { await sleep(250); if (facts.state().ready) up2 = facts.state(); }
  ok('re-enabling after a stop starts it again (an explicit user start re-arms a stopped/parked keeper)', !!up2 && up2.ready === true && spawns === spawnsAfter + 1, facts.state());
  const pid2 = facts.state().pid;

  // BOOT REPLAY: a fresh manager + a fresh locator over the SAME data dir
  serve.uninstall();
  for (let i = 0; i < 20 && alive(pid2); i++) await sleep(100);
  ok('uninstall() (the process-exit path) stops OUR child', !alive(pid2));
  const facts2 = serve.install({
    dataDir: dir, command: () => STUB, env: () => ({ ...process.env }), log: null,
    spawnImpl, bootTimeoutMs: 15000,
    autostart: () => serve.decideAutostart({ env: {}, pluginWantsUp: !!pm2?.wantsServiceUp(OPENCODE_SERVE_ID) }),
  });
  const pm2 = mkManager(dir);
  ok('the enabled+desiredUp intent SURVIVED the restart in data/plugins.json', pm2.wantsServiceUp(OPENCODE_SERVE_ID) === true);
  pm2.bootReplay();
  let up3 = null;
  for (let i = 0; i < 60 && !up3; i++) { await sleep(250); if (facts2.state().ready) up3 = facts2.state(); }
  ok('boot replay brings the service back with the server (enabled + desiredUp ⇒ start)', !!up3 && up3.ready === true, facts2.state());

  // (teardown of an ADOPTED instance — the killRecorded path — is asserted on
  //  the real server in ④, where a SIGKILLed server genuinely leaves one behind)
  const pid3 = facts2.state().pid;
  serve.uninstall();
  for (let i = 0; i < 20 && alive(pid3); i++) await sleep(100);
  ok('the replayed child is stopped again on process exit (stop() is idempotent across install/uninstall cycles)', !alive(pid3));

  const pm3 = mkManager(dir);
  pm3.setEnabled(OPENCODE_SERVE_ID, false);
  ok('a disable with the serve module UNWIRED never throws (NULL_FACTS has no locator)', pm3.wantsServiceUp(OPENCODE_SERVE_ID) === false);
}

console.log('— ③b the ops kill switch is authoritative over ADOPTION, not just over spawning');
{
  // REGRESSION: locate() reuses a recorded serve at step 1, BEFORE the
  // autostart gate — so a serve that outlived a restart kept running (and
  // indexing) under VIBESPACE_OPENCODE_SERVE=0, while the panel disabled every
  // control BECAUSE it is forced off. "Off" must mean the process is gone.
  const dir = mkTmp();
  const recPath = path.join(dir, 'opencode-serve.json');
  // a serve nobody owns: started by hand + a record, exactly the shape a
  // SIGKILLed server hands over (no keeper attached, so nothing respawns it)
  const startOrphan = async () => {
    const port = await freePort();
    const child = spawn(STUB, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--log-level', 'WARN'], { cwd: dir, env: { ...process.env }, stdio: 'ignore', detached: true });
    strays.add(child.pid); child.unref();
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/global/health`); if (r.ok) break; } catch { } await sleep(200); }
    fs.writeFileSync(recPath, JSON.stringify({ port, pid: child.pid, startedAt: Date.now(), command: STUB, cwd: null }));
    return { port, pid: child.pid };
  };
  const orphan = await startOrphan();
  // NEGATIVE CONTROL first: without the switch this very fixture IS adopted,
  // so the assert below is about the kill switch, not a broken fixture.
  delete process.env.VIBESPACE_OPENCODE_SERVE;
  const fA = serve.install({ dataDir: dir, command: () => STUB, env: () => ({ ...process.env }), log: null, spawnImpl: () => { throw new Error('must not spawn — this leg only adopts'); }, autostart: () => serve.decideAutostart({ pluginWantsUp: true }) });
  await fA.discover({});
  ok('(negative control) with no ops switch the recorded serve is ADOPTED, so the fixture is genuinely adoptable', fA.state().ready === true && fA.state().source === 'reused' && fA.state().pid === orphan.pid, fA.state());
  serve.uninstall();                       // leaves an ADOPTED serve alone (the next boot reuses it)
  ok('(setup) uninstall leaves the adopted process and its record alone', alive(orphan.pid) && fs.existsSync(recPath));

  process.env.VIBESPACE_OPENCODE_SERVE = '0';
  const fB = serve.install({ dataDir: dir, command: () => STUB, env: () => ({ ...process.env }), log: null, spawnImpl: () => { throw new Error('must not spawn under the ops switch'); }, autostart: () => serve.decideAutostart({ pluginWantsUp: true }) });
  for (let i = 0; i < 60 && alive(orphan.pid); i++) await sleep(200);   // install() runs the ladder once — no discovery needed
  ok('VIBESPACE_OPENCODE_SERVE=0 STOPS the serve it inherited instead of adopting it, and clears the record', !alive(orphan.pid) && !fs.existsSync(recPath) && fB.state().ready === false, fB.state());
  ok('…so nothing is left running that the (correctly) locked panel could not stop', fB.state().pid === null && fB.state().source === null);
  ok('…and the reason names the env switch', /VIBESPACE_OPENCODE_SERVE=0/.test(fB.reasonUnavailable()), fB.reasonUnavailable());
  await fB.discover({});
  ok('…a later discovery still adopts nothing and spawns nothing', fB.state().ready === false);
  delete process.env.VIBESPACE_OPENCODE_SERVE;
  serve.uninstall();
}

console.log('— ④ a REAL server: fresh = nothing spawned; enable/replay/disable over HTTP');
{
  const wt = `/tmp/vs-ocp-server-${process.pid}`;
  const PORT = await freePort();
  try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
  execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
  for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
  let srv = null;
  const cleanup = () => {
    try { srv?.kill('SIGKILL'); } catch { }
    try { const r = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'opencode-serve.json'), 'utf8')); if (r.pid) process.kill(r.pid, 'SIGKILL'); } catch { }
    try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(143); });

  const boot = (extraEnv = {}) => spawn(process.execPath, ['server.js'], {
    cwd: wt, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), VIBESPACE_PASSWORD: '', OPENCODE_CMD: STUB, VIBESPACE_OPENCODE_SERVE: '', ...extraEnv },
  });
  const waitReady = (p) => new Promise((res, rej) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('Ready.')) res(out); });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => rej(new Error('boot timeout\n' + out.slice(-2000))), 30000);
  });
  const api = async (p, init) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, init); return { status: r.status, body: await r.json().catch(() => null) }; };
  const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const svcRow = async () => (await api('/api/plugins/opencode-serve/status')).body;
  const recordPath = path.join(wt, 'data', 'opencode-serve.json');

  srv = boot(); await waitReady(srv);
  const home = (await api('/api/home')).body;
  const ocRow = (home.harnesses || []).find((h) => h.id === 'opencode');
  ok('/api/home carries the harness\'s CONTROL PLUGIN state (the client gates the first-use prompt on this, not on a backend id)', !!ocRow?.service && ocRow.service.id === 'opencode-serve' && ocRow.service.enabled === false && ocRow.service.installed === true, ocRow);
  // poll the session list a few times: discovery is what used to start it
  for (let i = 0; i < 3; i++) { await api('/api/sessions'); await sleep(300); }
  ok('A FRESH INSTANCE STARTS NOTHING: three session-list polls, no serve record, no `opencode serve` process', !fs.existsSync(recordPath));
  ok('…and creates nothing either — not even the isolated serve cwd (a service nobody turned on touches no disk)', !fs.existsSync(path.join(wt, 'data', 'opencode-serve')));
  // REGRESSION (the every-page-load red toast): a DEFAULT-OFF service is not a
  // BROKEN store. app.js pops a red error toast for every storeReason it finds
  // on /api/home, so one here = one error per page load forever.
  ok('a default-off service carries NO storeReason on /api/home (the client turns any reason into a RED error toast, once per load)', ocRow && ocRow.storeReason === undefined, ocRow);
  await post('/api/plugins/opencode-serve/prompted', { prompted: true });
  const homeAsked = (await api('/api/home')).body;
  const ocAsked = (homeAsked.harnesses || []).find((h) => h.id === 'opencode');
  ok('…and STILL none after the user answered "Not now" (the answer is remembered, never escalated to an error)', ocAsked && ocAsked.storeReason === undefined && ocAsked.service?.prompted === true, ocAsked);
  await post('/api/plugins/opencode-serve/prompted', { prompted: false });
  const listRow = (await api('/api/plugins')).body.plugins.find((p) => p.id === 'opencode-serve');
  ok('⚙ → Plugins shows it off but INSTALLED (the stub CLI resolves) with a reason that names the plugin', listRow.enabled === false && listRow.installed === true && /background service is off/.test(listRow.reason || ''), listRow);

  // ENABLE over HTTP, exactly what the dialog's "Enable & start" does
  ok('POST /enabled then /start are accepted', (await post('/api/plugins/opencode-serve/enabled', { enabled: true })).body?.ok === true && (await post('/api/plugins/opencode-serve/start')).body?.starting === true);
  let running = null;
  for (let i = 0; i < 60 && !running; i++) { await sleep(400); const s = await svcRow(); if (s?.running) running = s; }
  ok('…the serve comes up and the panel says so (port + pid + version from the ONE keeper)', !!running && !!running.port && !!running.pid, running);
  const pidA = running.pid;
  ok('…the record is written for the next boot', fs.existsSync(recordPath) && JSON.parse(fs.readFileSync(recordPath, 'utf8')).pid === pidA);

  // SIGKILL the server (restore-smoke pattern) → the serve OUTLIVES it → boot replay adopts it
  srv.kill('SIGKILL'); await sleep(800);
  ok('a SIGKILLed server leaves the serve running (the record is the handover)', alive(pidA));
  srv = boot(); await waitReady(srv);
  let after = null;
  for (let i = 0; i < 60 && !after; i++) { await sleep(400); const s = await svcRow(); if (s?.running) after = s; }
  ok('BOOT REPLAY after a SIGKILL: the service is up again, reusing the surviving instance instead of piling up a second one', !!after && after.running === true && after.pid === pidA && after.source === 'reused', after);

  // DISABLE → the ADOPTED process must die too (killRecorded)
  await post('/api/plugins/opencode-serve/enabled', { enabled: false });
  for (let i = 0; i < 40 && alive(pidA); i++) await sleep(150);
  ok('disable stops even an ADOPTED serve (a user turning the service off means the process is gone, not "we stopped looking")', !alive(pidA) && !fs.existsSync(recordPath));
  for (let i = 0; i < 3; i++) { await api('/api/sessions'); await sleep(300); }
  ok('…and nothing respawns it while the plugin is off', !fs.existsSync(recordPath) && (await svcRow()).running === false);

  // the prompted flag round-trips over HTTP and rides the plugins-updated broadcast
  ok('POST /prompted records "we already asked" for the whole instance', (await post('/api/plugins/opencode-serve/prompted', { prompted: true })).body?.prompted === true && (await svcRow()).prompted === true);

  // ENV OVERRIDE: forced off beats an enabled plugin — INCLUDING a serve that
  // outlived the restart. REGRESSION: adoption runs before the autostart gate,
  // so the ops kill switch used to leave an inherited daemon running while the
  // panel disabled every control BECAUSE it is forced off.
  await post('/api/plugins/opencode-serve/enabled', { enabled: true });
  let pidB = null;
  for (let i = 0; i < 60 && !pidB; i++) { await sleep(400); const s = await svcRow(); if (s?.running) pidB = s.pid; }
  ok('(setup) the service is up again before the ops switch is flipped', !!pidB && alive(pidB), pidB);
  srv.kill('SIGKILL'); await sleep(800);
  ok('(setup) it outlived the SIGKILLed server, with its record on disk — the adoption handover', alive(pidB) && fs.existsSync(recordPath));
  srv = boot({ VIBESPACE_OPENCODE_SERVE: '0' }); await waitReady(srv);
  for (let i = 0; i < 60 && alive(pidB); i++) await sleep(250);
  ok('VIBESPACE_OPENCODE_SERVE=0 STOPS the inherited serve instead of adopting it, and clears the record', !alive(pidB) && !fs.existsSync(recordPath));
  const forced = await svcRow();
  ok('…the panel reports envForced with nothing running, so no daemon is left without a control surface', forced.envForced === false && forced.running === false && !forced.pid, forced);
  const forcedRow = ((await api('/api/home')).body.harnesses || []).find((h) => h.id === 'opencode');
  ok('…and an ops-off service is not a "broken store" either (no storeReason ⇒ no red toast per page load)', forcedRow && forcedRow.storeReason === undefined, forcedRow);
  const refused = await post('/api/plugins/opencode-serve/start');
  ok('…and Start refuses with the env named (never a silent no-op)', refused.status === 400 && /VIBESPACE_OPENCODE_SERVE=0/.test(refused.body?.error || ''), refused.body);
  srv.kill('SIGKILL'); await sleep(400);
}

console.log('— ⑤ the first-use dialog in a real browser');
{
  const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!CHROME) console.log('  SKIP: no chrome/chromium (the node legs above still gate the mechanism)');
  else {
    const wt = `/tmp/vs-ocp-chrome-${process.pid}`;
    const PORT = await freePort(), CDP = await freePort();
    try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
    execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
    for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
    const srv = spawn(process.execPath, ['server.js'], { cwd: wt, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), VIBESPACE_PASSWORD: '', OPENCODE_CMD: STUB, VIBESPACE_OPENCODE_SERVE: '' } });
    const udd = `/tmp/vs-ocp-chrome-udd-${process.pid}`;
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
    const cleanup2 = () => {
      try { chrome.kill('SIGKILL'); } catch { }
      try { srv.kill('SIGKILL'); } catch { }
      try { const r = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'opencode-serve.json'), 'utf8')); if (r.pid) process.kill(r.pid, 'SIGKILL'); } catch { }
      try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch { }
      try { fs.rmSync(udd, { recursive: true, force: true }); } catch { }
    };
    process.on('exit', cleanup2);
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
    const WebSocket = require('ws');
    let target = null;
    for (let i = 0; i < 120 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === 'page'); } catch { }
      if (!target) await sleep(250);
    }
    if (!target) { ok('chrome exposed a CDP page target', false); }
    else {
      const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((r) => ws.on('open', r));
      let seq = 0; const pend = new Map();
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
      const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
        return r.result?.result?.value;
      };
      await send('Page.enable'); await send('Runtime.enable');
      await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) { await sleep(500); ready = await evaluate('try { await window.app?.ready; return !!window.app; } catch { return false; }').catch(() => false); }
      ok('the app booted in headless chrome', !!ready);

      // LEG 0 (REGRESSION): a default-off service must not NAG. Every
      // storeReason /api/home carries becomes a RED error toast on load, and
      // "the plugin is off" used to be one — on a fresh instance, after "Not
      // now", and on instances that never had OpenCode.
      const toastsOf = () => evaluate(`
        return { err: [...document.querySelectorAll('#global-toasts .global-toast-error')].map(e => e.textContent.slice(0, 200)) };
      `);
      const t0 = await toastsOf();
      ok('a FRESH default-off instance shows no error toast at all after boot', !!ready && Array.isArray(t0?.err) && t0.err.length === 0, t0);
      await evaluate(`await fetch('/api/plugins/opencode-serve/prompted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompted: true }) }); return 1;`);
      await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?r=2` });
      let ready2 = false;
      for (let i = 0; i < 80 && !ready2; i++) { await sleep(500); ready2 = await evaluate('try { await window.app?.ready; return !!window.app; } catch { return false; }').catch(() => false); }
      const t1 = await toastsOf();
      ok('…and a SECOND load after the user answered "Not now" shows none either (this was one red error per page load, forever)', ready2 === true && Array.isArray(t1?.err) && t1.err.length === 0, t1);
      await evaluate(`await fetch('/api/plugins/opencode-serve/prompted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompted: false }) }); return 1;`);

      // LEG 1: a REAL call site (opening a stopped OpenCode conversation) pops
      // exactly ONE dialog, and it explains what the service does.
      const leg1 = await evaluate(`
        window.__vsWin = window.app.viewSession('ses_a1', '/tmp', 'OC history', { backend: 'opencode', backendSessionId: 'ses_a1' });
        for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (document.getElementById('harness-service-dialog')) break; }
        const d = document.getElementById('harness-service-dialog');
        return { shown: !!d, count: document.querySelectorAll('#harness-service-dialog').length, text: d ? d.textContent.slice(0, 1200) : '', buttons: d ? [...d.querySelectorAll('button')].map(b => b.textContent) : [] };
      `);
      ok('opening a STOPPED OpenCode conversation shows the first-use dialog (ONE, never a native confirm)', leg1?.shown === true && leg1.count === 1, leg1);
      ok('…and it says what the service does + how to undo it', /background service/i.test(leg1?.text || '') && /127\.0\.0\.1/.test(leg1?.text || '') && /Plugins/.test(leg1?.text || '') && (leg1?.buttons || []).some((b) => /Not now/.test(b)) && (leg1?.buttons || []).some((b) => /Enable/.test(b)), leg1);

      // LEG 2: "Not now" is remembered INSTANCE-wide and never asks again.
      const leg2 = await evaluate(`
        const d = document.getElementById('harness-service-dialog');
        [...d.querySelectorAll('button')].find(b => /Not now/.test(b.textContent)).click();
        for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 200)); const s = await (await fetch('/api/plugins/opencode-serve/status')).json(); if (s.prompted) return { prompted: true, dialog: !!document.getElementById('harness-service-dialog') }; }
        return { prompted: false };
      `);
      ok('"Not now" closes the dialog and records the flag on the SERVER (asked once per instance, not per browser)', leg2?.prompted === true && leg2.dialog === false, leg2);
      const leg2b = await evaluate(`
        await window.app.maybeOfferHarnessService('opencode', { needsService: true });
        await new Promise(r => setTimeout(r, 600));
        return { dialog: !!document.getElementById('harness-service-dialog') };
      `);
      ok('…and a second use never re-asks', leg2b?.dialog === false, leg2b);

      // LEG 3: Enable proceeds — the service starts and the pending action runs.
      const leg3 = await evaluate(`
        await fetch('/api/plugins/opencode-serve/prompted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompted: false }) });
        let retried = 0;
        const p = window.app.maybeOfferHarnessService('opencode', { needsService: true, retry: () => { retried++; } });
        for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 200)); if (document.getElementById('harness-service-dialog')) break; }
        const d = document.getElementById('harness-service-dialog');
        if (!d) return { shown: false };
        [...d.querySelectorAll('button')].find(b => /Enable/.test(b.textContent)).click();
        const okv = await p;
        const s = await (await fetch('/api/plugins/opencode-serve/status')).json();
        return { shown: true, okv, retried, enabled: s.enabled, running: s.running };
      `);
      ok('the offer is shown again once the flag is cleared (nothing is one-way)', leg3?.shown === true, leg3);
      ok('"Enable & start" enables the plugin, waits for the serve, and RESUMES the pending action (never a spinner forever)', leg3?.okv === true && leg3.enabled === true && leg3.running === true && leg3.retried === 1, leg3);

      // LEG 4: with the service on, the sidebar hint row is gone; with it off
      // (and already asked) the row is there with its Enable action.
      const leg4 = await evaluate(`
        window.app.sidebar._render();
        const onRow = document.querySelectorAll('.sidebar-service-hint').length;
        await fetch('/api/plugins/opencode-serve/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
        // wait for the plugins-updated BROADCAST to land (the multi-client law:
        // no client polls for this, the server pushes it)
        let row = null;
        for (let i = 0; i < 50 && !row; i++) { await new Promise(r => setTimeout(r, 200)); row = document.querySelector('.sidebar-service-hint'); }
        return { onRow, offRow: !!row, text: row ? row.textContent : '', action: row ? !!row.querySelector('.sidebar-service-enable') : false };
      `);
      ok('the sidebar says NOTHING while the service is running (no nagging)', leg4?.onRow === 0, leg4);
      ok('…and once it is off (after we asked) the list admits its history is hidden AND carries the way back', leg4?.offRow === true && /hidden/.test(leg4.text) && leg4.action === true, leg4);
      ws.close();
    }
    cleanup2();
  }
}

console.log('— ⑥ wiring pins');
{
  const sl = read('src/lib/session-lifecycle.js');
  ok('createSession (the ONE create/resume/fork funnel) offers the service without BLOCKING the spawn, and never as an unhandled rejection', /this\.maybeOfferHarnessService\?\.\(backend, \{ needsService: false \}\)/.test(sl) && /if \(!fork\) \{ try \{ Promise\.resolve\(this\.maybeOfferHarnessService/.test(sl) && (sl.match(/\)\.catch\(\(\) => \{\}\);/g) || []).length >= 2);
  ok('a FORK awaits it — a fork is minted THROUGH the service, so it genuinely cannot proceed without it', /async _doForkSession\(/.test(sl) && /await this\.maybeOfferHarnessService\?\.\(backend, \{ needsService: true \}\)/.test(sl));
  ok('viewSession (opening stopped history) offers it and RE-OPENS the window after an enable', /if \(offerService\) try \{[\s\S]{0,400}maybeOfferHarnessService\?\.\(backend, \{[\s\S]{0,200}retry: \(\) => \{/.test(sl) && /this\.viewSession\(sessionId, cwd, sessionName, \{ syncId, backend/.test(sl));
  ok('a layout REPLAY (and the retry\'s own re-open) is not a user action — those call sites pass offerService:false, so the dialog never fires on boot or twice', (sl.match(/offerService: false/g) || []).length === 3 && /viewSession\(sessionId, cwd, sessionName, \{ syncId, backend = 'claude'[^)]*offerService = true/.test(sl));
  ok('the re-opened history window keeps its geometry AND its home desktop (the 2.295.0 class: a rebuilt window must not land on whatever desktop is active)', /const dm = this\.desktopManager, home = bounds\?\.desktopId;/.test(sl) && /dm\.moveWindowToDesktop\(again\.id, home\)/.test(sl));
  const pu = read('src/lib/plugins-ui.js');
  ok('the dialog is createModalShell (never prompt/alert/confirm) with Enable & start / Not now', /_harnessServiceDialog\(meta, st\)/.test(pu) && /createModalShell\(\{[\s\S]{0,200}id: 'harness-service-dialog'/.test(pu) && /t\('Not now'\)/.test(pu) && /t\('Enable & start'\)/.test(pu) && !/\b(confirm|alert|prompt)\(/.test(pu));
  ok('ONE offer at a time (a layout restore can open five history windows in a tick)', /this\._svcOffers \|\|= new Map\(\)/.test(pu) && /if \(inFlight\) return inFlight\.then/.test(pu));
  ok('"Not now" POSTs the instance-wide flag; Enable POSTs enabled+start and then WAITS bounded for the serve', /\/prompted`, \{ method: 'POST'/.test(pu) && /post\('enabled', \{ enabled: true \}\)/.test(pu) && /post\('start'\)/.test(pu) && /SERVICE_START_WAIT_MS/.test(pu));
  ok('every failure on that path reaches the user (no silent failure)', /showToast\(e\.message \|\| t\('Failed'\), \{ type: 'error' \}\); return false;/.test(pu) && /has not answered yet/.test(pu));
  ok('the ⚙ → Plugins card renders the service (state, env-forced notice, Start/Stop, the on-switch) without a config box', /const isOc = p\.id === 'opencode-serve'/.test(pu) && /Forced OFF by the environment/.test(pu) && /t\('Enable & start'\)/.test(pu) && /Run this service whenever VibeSpace runs/.test(pu));
  const app = read('src/lib/app.js');
  ok('app.js fills BACKEND_META.service from /api/home AND keeps it live from plugins-updated + harness-store-updated (multi-client law)', /BACKEND_META\[h\.id\]\.service = h\.service \|\| null;/.test(app) && /msg\.type !== 'plugins-updated' \|\| !msg\.services/.test(app) && /if \(msg\.service !== undefined\) BACKEND_META\[msg\.backend\]\.service = msg\.service \|\| null;/.test(app));
  ok('agent-meta declares the control plugin for opencode (the client mirror of store.servicePlugin)', /servicePlugin: 'opencode-serve'/.test(read('src/lib/agent-meta.js')));
  const sb = read('src/lib/sidebar.js');
  ok('the sidebar hint row is generic over BACKEND_META.servicePlugin (never a backend id) and only shows once the user has met the harness', /_renderServiceHintRows\(sessions\) \{/.test(sb) && /const svc = meta\.servicePlugin \? meta\.service : null;/.test(sb) && /svc\.prompted \|\| \(sessions \|\| \[\]\)\.some/.test(sb));
  ok('…and an OPS-forced-off service gets the same EXPLANATION with no Enable button (nothing the user clicks there could work) — it is the only in-product word left now that "off" is not an error toast', /if \(svc\.envForced !== false\) \{[\s\S]{0,400}sidebar-service-enable[\s\S]{0,300}row\.append\(enable\);/.test(sb) && !/svc\.envForced === false\) continue;/.test(sb));
  ok('…and it is rendered by the WORKBENCH, the one builder that owns the sessions list on desktop AND mobile (it wipes listEl, so a row added in _renderInner would be silently thrown away — how this shipped broken once)', /this\._renderServiceHintRows\?\.\(sessions\);/.test(read('src/lib/sidebar-workbench.js')) && !/_renderServiceHintRows\?\.\(/.test(sb));
  const mw = read('src/server/mounts-plugins-wiring.js');
  ok('POST /api/plugins/:id/prompted exists next to the other plugin routes', /app\.post\('\/api\/plugins\/:id\/prompted'/.test(mw));
  const os_ = read('src/opencode-serve.js');
  ok('the ops kill switch is checked INSIDE the adoption rung (before the reuse is taken), not only at the spawn gate below it', /serveEnvOverride\(\) === false\s*\n?\s*\? 'VIBESPACE_OPENCODE_SERVE=0 is set on this instance/.test(os_) && /const bad = serveEnvOverride\(\) === false/.test(os_));
  ok('…and install() runs the ladder ONCE under the switch, so an instance nobody polls does not leave an inherited daemon indexing', /if \(serveEnvOverride\(\) === false && locator\?\.ensure\)/.test(os_) && /setImmediate\(\(\) => \{ Promise\.resolve\(locator\.ensure\(\)\)/.test(os_));
  const pl = read('src/plugins.js');
  ok('plugins.js is the CONTROL SURFACE only: it holds no keeper, no spawn of `opencode serve`, and reads every fact from the shared module', /this\._serve = opencodeServe \|\| require\('\.\/opencode-serve'\)/.test(pl) && !/spawn\([^)]*serve/.test(pl) && /_ocServeState\(\)/.test(pl) && /_ocLocator\(\)\?\.stop\?\.\(\{ killRecorded: true \}\)/.test(pl));
  ok('cli-env puts the control plugin\'s state on the harness row (declaration-driven, not an id list)', /if \(h\.store\?\.servicePlugin\) \{ try \{ row\.service = getPlugins\(\)\?\.serviceState\?\.\(h\.store\.servicePlugin\)/.test(read('src/server/cli-env.js')));
  const zh = read('src/lib/i18n-zh.js'), ja = read('src/lib/i18n-ja.js');
  const keys = ['Not now', 'Enable & start', 'Run this service whenever VibeSpace runs'];
  ok('the new user-visible strings carry zh + ja entries (i18n-check parity)', keys.every((k) => zh.includes(`"${k}"`) && ja.includes(`"${k}"`)), keys.filter((k) => !zh.includes(`"${k}"`) || !ja.includes(`"${k}"`)));
  ok('docs updated: kb-file-structure (plugins.js + opencode-serve + plugins-ui), kb-features, the design S9 row, docs/settings.md', /opencode-serve.*PLUGIN|OpenCode background service/.test(read('docs/kb-file-structure.md')) && /OpenCode background service/.test(read('docs/kb-features.md')) && /OpenCode background service/.test(read('docs/design-harness-plugins.md')) && /Removed 2026-09-07/.test(read('docs/settings.md')) && /## Built-in plugins/.test(read('docs/plugins.md')) && /POST \/api\/plugins\/:id\/prompted/.test(read('docs/kb-api.md')));
  ok('ci.mjs runs this suite', /'test-opencode-plugin'/.test(read('scripts/ci.mjs')));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
