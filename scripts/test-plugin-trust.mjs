#!/usr/bin/env node
// Plugin Ph4 (2.369.30, docs/plugins.md; design §3.3): the trusted client tier
// + owner consent, contributed settings/themes, install sources, node
// --permission capability ENFORCEMENT, remote shim shipping — against REAL
// fixture plugins under a temp root (never the repo's data/). Client pins last.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); } return !!(await pred()); };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };

// ── ① validator: contributions + capabilities + module tier + consent helpers ──
console.log('— validator');
const PM = require(path.join(REPO, 'src/plugin-manifest.js'));
const { validateManifest, needsConsent, hasDeclaredCapabilities, capabilitySummary, capabilitiesHash, normalizeFsPath } = PM;
const base = { id: 'acme.tool', version: '1.0.0', engines: { vibespace: '2.369.24' }, server: true };
const V = (m, o = {}) => validateManifest(m, { hostVersion: '2.369.30', ...o });
ok(V({ ...base, contributes: { settings: [{ key: 'greeting', type: 'string', default: 'hi', label: 'Greeting' }, { key: 'n', type: 'number', default: 3, label: 'N', min: 0, max: 9 }, { key: 'on', type: 'boolean', default: true, label: 'On' }, { key: 'lvl', type: 'select', default: 'a', label: 'Level', options: ['a', { value: 'b', label: 'Bee' }] }] } }).ok, 'settings: string/number/boolean/select validate and normalize');
ok(!V({ ...base, contributes: { settings: [{ key: 'x', type: 'select', default: 'z', label: 'X', options: ['a'] }] } }).ok && !V({ ...base, contributes: { settings: [{ key: 'x', type: 'boolean', default: 'yes', label: 'X' }] } }).ok && !V({ ...base, contributes: { settings: [{ key: 'bad key', type: 'string', label: 'X' }] } }).ok && !V({ ...base, contributes: { settings: [{ key: 'a', type: 'string', label: 'A' }, { key: 'a', type: 'string', label: 'B' }] } }).ok, 'settings: wrong default type / default outside options / bad key / duplicate key are errors');
ok(V({ ...base, contributes: { themes: [{ id: 'night', label: 'Night', file: 'themes/night.json' }] } }).ok && !V({ ...base, contributes: { themes: [{ id: 'night', label: 'Night', file: '../x.json' }] } }).ok && !V({ ...base, contributes: { themes: [{ id: 'Night!', label: 'N', file: 't.json' }] } }).ok, 'themes: relative .json inside the plugin dir, slug ids');
const home = '/home/tester';
const capsV = V({ ...base, capabilities: { server: { fs: { read: ['~/data', '/srv/x/'], write: ['~/data'] }, spawn: ['ls'], net: ['api.example.com', { host: 'x.example.com' }] } } }, { homeDir: home });
ok(capsV.ok && capsV.manifest.capabilities.server.fs.read.join() === '/home/tester/data,/srv/x' && capsV.manifest.capabilities.server.fs.write.join() === '/home/tester/data' && capsV.manifest.capabilities.server.childProcess === true && capsV.manifest.capabilities.server.net.join() === 'api.example.com,x.example.com' && capsV.warnings.some((w) => /spawn is treated as childProcess/.test(w)), 'capabilities normalize: ~ expands, trailing slash trimmed, spawn ⇒ childProcess (warned), net hosts', capsV);
ok(!V({ ...base, capabilities: { server: { fs: { read: ['../etc'] } } } }).ok && !V({ ...base, capabilities: { server: { fs: { read: ['relative/path'] } } } }).ok && !V({ ...base, capabilities: { server: { fs: { read: ['/'] } } } }, { forbiddenRoots: ['/srv/vibespace'] }).ok, 'capabilities: .., relative and / are refused');
const forb = V({ ...base, capabilities: { server: { fs: { read: ['/srv/vibespace/data/plugins'] } } } }, { forbiddenRoots: [{ path: '/srv/vibespace/data', label: 'the VibeSpace data dir' }] });
ok(!forb.ok && /covers the VibeSpace data dir/.test(forb.errors.join()) && !V({ ...base, capabilities: { server: { fs: { read: ['/srv'] } } } }, { forbiddenRoots: ['/srv/vibespace'] }).ok, 'a declared path covering (or covered by) a forbidden root is an error, named');
ok(normalizeFsPath('~', { homeDir: home }).path === home && normalizeFsPath('/a//', {}).path === '/a' && normalizeFsPath('', {}).error, 'normalizeFsPath edge cases');
const modV = V({ ...base, client: 'module' });
ok(modV.ok && modV.manifest.clientEntry === 'client.js' && V({ ...base, client: 'module', clientEntry: 'ui/app.mjs' }).manifest.clientEntry === 'ui/app.mjs' && !V({ ...base, client: 'module', clientEntry: '../x.js' }).ok && !V({ ...base, client: 'module', clientEntry: 'x.html' }).ok, 'module tier: clientEntry defaults to client.js, relative .js only');
const alias = V({ ...base, client: 'trusted' });
ok(alias.ok && alias.manifest.client === 'module' && alias.warnings.some((w) => /alias/.test(w)), '"trusted" is accepted as an alias of "module" with a warning');
ok(!needsConsent(V(base).manifest) && needsConsent(modV.manifest) && needsConsent(capsV.manifest) && hasDeclaredCapabilities(capsV.manifest) && !hasDeclaredCapabilities(V(base).manifest), 'needsConsent = module tier or any declared server capability');
const sumIds = capabilitySummary({ ...capsV.manifest, client: 'module', contributes: { ...capsV.manifest.contributes, agentTools: [{ name: 'do' }] } }).map((i) => i.id);
ok(sumIds.join() === 'client-module,server-process,fs-read,fs-write,child-process,net,agent-tools' && capabilitySummary(V({ ...base, server: false }).manifest)[0].id === 'none', `capabilitySummary lists every declared power in a fixed order (${sumIds.join(',')})`);
const h1 = capabilitiesHash(capsV.manifest), h2 = capabilitiesHash(V({ ...base, capabilities: { server: { net: ['api.example.com', { host: 'x.example.com' }], spawn: ['ls'], fs: { write: ['~/data'], read: ['~/data', '/srv/x/'] } } } }, { homeDir: home }).manifest); // same lists, different OBJECT key order
ok(h1 && h1 === h2 && h1 !== capabilitiesHash(V({ ...base, capabilities: { server: { fs: { read: ['~/data'] } } } }, { homeDir: home }).manifest) && h1 !== capabilitiesHash({ ...capsV.manifest, contributes: { ...capsV.manifest.contributes, agentTools: [{ name: 'x' }] } }), 'capabilitiesHash is key-order independent and changes on any consent-relevant change (capability or agent tool)');

// ── ② loader against fixture plugins ──
console.log('— loader: consent, trusted module, themes, --permission');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-trust-'));
const pdir = (id) => path.join(root, 'data', 'plugins', id);
const trustyManifest = { id: 'acme.trusty', version: '1.0.0', engines: { vibespace: '2.369.24' }, label: 'Trusty', client: 'module', clientEntry: 'client.js', server: true,
  contributes: { routes: true, settings: [{ key: 'greeting', type: 'string', default: 'hi', label: 'Greeting' }], themes: [{ id: 'night', label: 'Night', file: 'themes/night.json' }, { id: 'bad', label: 'Bad', file: 'themes/bad.json' }] },
  capabilities: { server: { fs: { read: ['/etc'] } } } };
writeJson(path.join(pdir('acme.trusty'), 'vibespace-plugin.json'), trustyManifest);
fs.writeFileSync(path.join(pdir('acme.trusty'), 'client.js'), 'export function activate(api) { globalThis.__trustyActivated = api.id; }\nexport function deactivate() { globalThis.__trustyActivated = null; }\n');
writeJson(path.join(pdir('acme.trusty'), 'themes', 'night.json'), { css: { '--accent': '#123456' }, terminal: { background: '#000' } });
writeJson(path.join(pdir('acme.trusty'), 'themes', 'bad.json'), { css: { '--accent': 'red; } body { color: red' } });
fs.writeFileSync(path.join(pdir('acme.trusty'), 'server.js'), `'use strict';
const fs = require('fs');
process.on('message', (m) => {
  if (m.t === 'route') { if (m.path === '/host') { let h = ''; try { h = fs.readFileSync('/etc/hostname', 'utf8').trim() || '(empty)'; } catch (e) { return process.send({ t: 'route-reply', id: m.id, status: 500, body: { error: e.code || e.message } }); } return process.send({ t: 'route-reply', id: m.id, status: 200, body: { hostname: h } }); }
    return process.send({ t: 'route-reply', id: m.id, status: 404, body: { error: 'nope' } }); }
  if (m.t === 'shutdown') process.exit(0);
});
process.send({ t: 'hello', api: 1 });
`);
// greedy: no declared capability, reads outside its sandbox at startup → must be DENIED (crash the loader reports), never a host failure
writeJson(path.join(pdir('acme.greedy'), 'vibespace-plugin.json'), { id: 'acme.greedy', version: '0.1.0', engines: { vibespace: '2.369.24' }, server: true });
fs.writeFileSync(path.join(pdir('acme.greedy'), 'server.js'), "const fs = require('fs'); fs.readFileSync('/etc/hostname', 'utf8'); process.on('message', (m) => { if (m.t === 'shutdown') process.exit(0); }); process.send({ t: 'hello', api: 1 });\n");
const express = require(path.join(REPO, 'node_modules/express'));
const app = express();
app.use(express.json({ limit: '1mb' }));
const broadcasts = [], tele = [];
const { create } = require(path.join(REPO, 'src/server/plugin-loader.js'));
const loader = create({ rootDir: root, app, hostVersion: '2.369.30', log: { log() {}, warn() {} }, broadcast: (m) => broadcasts.push(m), agentEnv: () => ({ PATH: process.env.PATH }), agentAuth: () => null, instanceUrl: { url: () => 'https://vs.example.test/' }, telemetry: (ev) => tele.push(ev) });
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base_ = `http://127.0.0.1:${srv.address().port}`;
const j = async (p, opt) => { const r = await fetch(base_ + p, opt); let b = null; try { b = await r.clone().json(); } catch { b = await r.text(); } return { status: r.status, headers: r.headers, body: b }; };
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const row = async (id) => (await j('/api/plugins/manifests')).body.plugins.find((p) => p.id === id);

let tr = await row('acme.trusty');
ok(tr && tr.valid && !tr.enabled && tr.needsConsent && tr.consentRequired && !tr.trusted && tr.client === 'module' && tr.clientEntry === 'client.js' && tr.label === 'Trusty', 'the module-tier fixture lists as valid, disabled, consent required', tr);
ok(tr.capabilitySummary.map((i) => i.id).join() === 'client-module,server-process,fs-read' && /\/etc/.test(tr.capabilitySummary[2].params.paths) && tr.capabilitiesHash, 'the list row carries the consent summary + hash the panel renders');
ok(tr.contributes.settings.length === 1 && tr.contributes.themes.find((t) => t.id === 'night').ok === true && tr.contributes.themes.find((t) => t.id === 'bad').ok === false && tr.warnings.some((w) => /theme "bad"/.test(w)), 'theme files are validated at discovery (a bad one is flagged, never served as CSS)');
const denied = await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: true });
ok(denied.status === 409 && denied.body.consentRequired === true && Array.isArray(denied.body.capabilities) && denied.body.capabilities[0].id === 'client-module' && /needs your consent/.test(denied.body.error), 'enable WITHOUT trusted → 409 consentRequired with the capability list (the manifest alone never grants trust)', denied.body);
ok((await j('/plugins/acme.trusty/client.js')).status === 404, 'the client module is not served while disabled');
const en = await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: true, trusted: true });
ok(en.status === 200 && en.body.plugin.enabled && en.body.plugin.trusted && en.body.plugin.trustedAt && !en.body.plugin.consentRequired, 'enable WITH trusted:true records consent (trusted + trustedAt) and starts the plugin');
const reg = JSON.parse(fs.readFileSync(path.join(root, 'data', 'plugin-registry.json'), 'utf8'));
ok(reg.trust['acme.trusty']?.trusted === true && reg.trust['acme.trusty'].capabilitiesHash === tr.capabilitiesHash, 'the registry stores { trusted, trustedAt, capabilitiesHash }');
const mod = await j('/plugins/acme.trusty/client.js');
ok(mod.status === 200 && /text\/javascript/.test(mod.headers.get('content-type') || '') && !mod.headers.get('content-security-policy') && /activate/.test(mod.body) && mod.headers.get('x-content-type-options') === 'nosniff', 'the trusted client module is served SAME-ORIGIN as javascript (no sandbox CSP), nosniff');
const th = await j('/plugins/acme.trusty/themes/night.json');
ok(th.status === 200 && /application\/json/.test(th.headers.get('content-type') || '') && th.body.css['--accent'] === '#123456', 'declared theme files are served as JSON');
ok((await j('/plugins/acme.trusty/server.js')).status === 404 && (await j('/plugins/acme.trusty/../acme.greedy/server.js')).status !== 200, 'nothing else in the plugin dir is served (server.js, traversal)');
ok(await waitFor(async () => (await row('acme.trusty')).state === 'running'), 'the server process runs under node --permission');
const host = await j('/api/plugins/acme.trusty/x/host');
ok(host.status === 200 && typeof host.body.hostname === 'string' && host.body.hostname.length > 0, `a DECLARED fs path (/etc) is readable inside the sandbox (${JSON.stringify(host.body).slice(0, 80)})`);
const caps = await j('/api/plugins/manifests/acme.trusty/capabilities');
ok(caps.status === 200 && caps.body.trusted === true && caps.body.trust.capabilitiesHash === tr.capabilitiesHash && caps.body.summary.length === 3, 'GET …/capabilities returns the summary + the trust record (Show capabilities…)');
// undeclared access → denied inside the plugin, reported by the loader, host unaffected
const g = await post('/api/plugins/manifests/acme.greedy/enabled', { enabled: true });
ok(g.status === 200, 'a plugin with no declared capabilities enables without consent');
ok(await waitFor(async () => /ERR_ACCESS_DENIED|denied file system read/.test((await row('acme.greedy')).lastError || ''), 8000), `an UNDECLARED read (/etc/hostname) is denied by node --permission and surfaced as the plugin's error: ${(await row('acme.greedy')).lastError}`);
ok(['crashed', 'starting', 'parked', 'stopped'].includes((await row('acme.greedy')).state) && (await row('acme.trusty')).state === 'running' && (await j('/api/plugins/manifests')).status === 200, 'the host and the other plugin are unaffected by the denied plugin');
await post('/api/plugins/manifests/acme.greedy/enabled', { enabled: false });
ok(tele.some((e) => e.name === 'plugin-trusted') && tele.some((e) => e.name === 'plugin-crash'), 'consent + crashes reach telemetry');
// consent drift: a manifest that grows a capability is switched off until reviewed
writeJson(path.join(pdir('acme.trusty'), 'vibespace-plugin.json'), { ...trustyManifest, capabilities: { server: { fs: { read: ['/etc'] }, childProcess: true } } });
await post('/api/plugins/manifests/reload', {});
tr = await row('acme.trusty');
ok(!tr.enabled && /capabilities changed/.test(tr.notice || '') && tr.consentRequired && !tr.trusted, 'CONSENT DRIFT: after the manifest gained childProcess, reload disables the plugin with a notice (old consent does not carry over)', tr);
ok((await j('/plugins/acme.trusty/client.js')).status === 404, '…and the module is no longer served');
const again = await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: true });
ok(again.status === 409 && again.body.changed === true && /changed its capabilities/.test(again.body.error) && again.body.capabilities.some((c) => c.id === 'child-process'), 'enable without re-consent → 409 changed:true naming the new capability');
ok((await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: true, trusted: true })).body.plugin.trusted === true, 're-consent enables it again');
await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: false });

// ── ③ install sources ──
console.log('— install / update / uninstall');
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-trust-src-'));
fs.cpSync(path.join(REPO, 'docs/examples/hello-plugin'), path.join(src, 'hello'), { recursive: true });
const inst = await post('/api/plugins/install', { source: 'path', value: path.join(src, 'hello') });
ok(inst.status === 200 && inst.body.plugin?.id === 'example.hello' && inst.body.plugin.install?.source === 'path' && !inst.body.replaced && fs.existsSync(path.join(pdir('example.hello'), 'vibespace-plugin.json')), 'install from a local path lands under data/plugins/<id> with the source recorded', inst.body);
ok((await row('example.hello')).contributes.settings.length === 1 && (await row('example.hello')).contributes.themes[0].ok === true && (await row('example.hello')).needsConsent, 'the shipped example contributes a setting + a theme, and needs consent for its agent tool (2.369.43: a shim on every session PATH is a capability)');
ok((await post('/api/plugins/manifests/example.hello/enabled', { enabled: true, trusted: true })).status === 200 && await waitFor(async () => (await row('example.hello')).state === 'running', 25000), 'the installed example runs');
const inst2 = await post('/api/plugins/install', { source: 'path', value: path.join(src, 'hello') });
ok(inst2.status === 200 && inst2.body.replaced === true && !inst2.body.disabled && (await row('example.hello')).trusted && inst2.body.previous && fs.existsSync(path.join(inst2.body.previous, 'plugin', 'vibespace-plugin.json')) && fs.existsSync(path.join(inst2.body.previous, 'why.json')), 'reinstalling the IDENTICAL package MOVES the previous copy to data/plugins-trash (never deleted) and keeps the plugin enabled + trusted', inst2.body);
ok(await waitFor(async () => (await row('example.hello')).state === 'running', 25000), '…and restarts it (a fresh child, not the crash-backoff path)');
fs.symlinkSync('/etc', path.join(src, 'hello', 'etc-link'));
const sym = await post('/api/plugins/install', { source: 'path', value: path.join(src, 'hello') });
ok(sym.status === 400 && /symlink/.test(sym.body.error), 'a package containing a symlink is refused');
fs.unlinkSync(path.join(src, 'hello', 'etc-link'));
ok((await post('/api/plugins/install', { source: 'git', value: 'file:///tmp/x; rm -rf /' })).status === 400 && (await post('/api/plugins/install', { source: 'github-release', value: '../../x' })).status === 400 && (await post('/api/plugins/install', { source: 'ftp', value: 'x' })).status === 400, 'git/github-release/unknown sources validate their input before any process runs');
// zip (.vsp) upload — built with python's zipfile (a top-level folder wrap like GitHub zips)
const vsp = path.join(src, 'hello.vsp');
execFileSync('python3', ['-c', `import zipfile,os,sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w') as z:
    for d, _, fs_ in os.walk(src):
        for f in fs_:
            p = os.path.join(d, f); z.write(p, os.path.join('hello-plugin-main', os.path.relpath(p, src)))
`, path.join(src, 'hello'), vsp]);
const fd = new FormData(); fd.append('source', 'zip'); fd.append('value', 'hello.vsp'); fd.append('file', new Blob([fs.readFileSync(vsp)]), 'hello.vsp');
const zr = await fetch(base_ + '/api/plugins/install', { method: 'POST', body: fd }); const zb = await zr.json();
ok(zr.status === 200 && zb.plugin?.id === 'example.hello' && zb.replaced === true && zb.plugin.install.source === 'zip', 'a .vsp upload (multipart) installs, unwrapping the single top-level folder', zb);
ok(zb.disabled === true && !(await row('example.hello')).enabled && !(await row('example.hello')).trusted, 'replacing an enabled plugin from a DIFFERENT source drops its consent (2.369.43 — consent covers a package, not an id)', zb);
const evil = path.join(src, 'evil.vsp');
execFileSync('python3', ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('vibespace-plugin.json', '{}'); z.writestr('../evil.txt', 'x')
`, evil]);
const fd2 = new FormData(); fd2.append('source', 'zip'); fd2.append('file', new Blob([fs.readFileSync(evil)]), 'evil.vsp');
const er = await fetch(base_ + '/api/plugins/install', { method: 'POST', body: fd2 }); const eb = await er.json();
ok(er.status === 400 && /path traversal/.test(eb.error) && !fs.existsSync(path.join(root, 'data', 'evil.txt')), 'Zip-Slip entries are refused before extraction');
const up0 = await post('/api/plugins/manifests/example.hello/update', {});
ok(up0.status === 400 && /uploaded file/.test(up0.body.error), 'update of a zip-installed plugin explains that a new upload replaces it');
await post('/api/plugins/install', { source: 'path', value: path.join(src, 'hello') });
await post('/api/plugins/manifests/example.hello/enabled', { enabled: true, trusted: true }); // the source swap above dropped consent — re-give it, then Update must keep it
const up = await post('/api/plugins/manifests/example.hello/update', {});
ok(up.status === 200 && up.body.plugin?.id === 'example.hello' && up.body.previous && (await row('example.hello')).install.updatedAt && (await row('example.hello')).trusted, 'update re-runs the recorded source (path), trashes the previous copy and KEEPS consent (the owner asked for this version from the source they already trusted; a changed capability surface still trips the drift check)');
ok((await post('/api/plugins/manifests/example.hello/update', {})).status === 200 && (await post('/api/plugins/manifests/nope.nope/update', {})).status === 404, 'update: unknown id → 404');
const stateFile = path.join(root, 'data', 'plugins-state', 'example.hello', 'counter.json');
// the update just restarted the plugin process — wait for it (gate flake: POST /x/count raced a 'starting' state)
ok(await waitFor(async () => (await row('example.hello')).state === 'running', 25000), 'the updated example is running again');
await j('/api/plugins/example.hello/x/count', { method: 'POST' });
ok(await waitFor(() => fs.existsSync(stateFile)), 'the example wrote its state file (so uninstall has state to preserve)');
const un = await j('/api/plugins/manifests/example.hello', { method: 'DELETE' });
ok(un.status === 200 && un.body.trash && fs.existsSync(path.join(un.body.trash, 'plugin', 'vibespace-plugin.json')) && fs.existsSync(path.join(un.body.trash, 'state', 'counter.json')) && !fs.existsSync(pdir('example.hello')) && !(await row('example.hello')), 'uninstall moves plugin + state to the trash, drops registry rows, and the list no longer shows it', un.body);
ok(!JSON.parse(fs.readFileSync(path.join(root, 'data', 'plugin-registry.json'), 'utf8')).installs['example.hello'], 'registry install record removed');
ok((await j('/api/plugins/manifests/nope.nope', { method: 'DELETE' })).status === 404, 'uninstall unknown → 404');
// a package declaring a capability over the host's own data dir is refused at install
fs.cpSync(path.join(REPO, 'docs/examples/hello-plugin'), path.join(src, 'evilcap'), { recursive: true });
writeJson(path.join(src, 'evilcap', 'vibespace-plugin.json'), { ...JSON.parse(fs.readFileSync(path.join(src, 'evilcap', 'vibespace-plugin.json'), 'utf8')), capabilities: { server: { fs: { read: [path.join(root, 'data')] } } } });
const ec = await post('/api/plugins/install', { source: 'path', value: path.join(src, 'evilcap') });
ok(ec.status === 400 && /covers the VibeSpace (install|data) dir/.test(ec.body.error), 'a capability over VibeSpace\'s own install/data dir is refused at install (named)', ec.body);
ok(tele.some((e) => e.name === 'plugin-install') && tele.some((e) => e.name === 'plugin-uninstall') && tele.some((e) => e.name === 'plugin-install-failed'), 'install/uninstall/failures reach telemetry');

// ── ④ remote shim shipping ──
console.log('— shims');
await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: true, trusted: true });
writeJson(path.join(pdir('acme.trusty'), 'vibespace-plugin.json'), { ...trustyManifest, capabilities: { server: { fs: { read: ['/etc'] }, childProcess: true } }, contributes: { ...trustyManifest.contributes, agentTools: [{ name: 'ping', description: 'pong', args: {} }] } });
await post('/api/plugins/manifests/reload', {});
await post('/api/plugins/manifests/acme.trusty/enabled', { enabled: true, trusted: true }); // the tool changed the hash → re-consent
const shim = path.join(root, 'data', 'bin', 'vibespace-tool-acme.trusty-ping');
ok(fs.existsSync(shim) && /const INSTANCE_URL = "https:\/\/vs\.example\.test";/.test(fs.readFileSync(shim, 'utf8')) && loader.shimNames().includes('vibespace-tool-acme.trusty-ping'), 'shims bake the instance public URL (instance-url.js) as the fallback call-back and are listed by shimNames()');
const { HostManager } = require(path.join(REPO, 'src/hosts.js'));
HostManager.extraAgentTools = () => ['vibespace-tool-acme.trusty-ping', 'bad name', 'vibespace-status'];
ok(HostManager.agentTools().includes('vibespace-tool-acme.trusty-ping') && HostManager.agentTools().filter((n) => n === 'vibespace-status').length === 1 && !HostManager.agentTools().includes('bad name'), 'HostManager.agentTools() = static tools + valid plugin shims (deduped, filtered)');
HostManager.extraAgentTools = () => [];
loader.shutdown(); srv.close();
try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); } catch {}

// ── ⑤ wiring pins ──
console.log('— wiring pins');
const pc = read('src/lib/plugin-client.js');
ok(/if \(!m\.trusted\) \{ if \(cur\) await this\._deactivate\(m\.id\); return; \}/.test(pc) && /await import\(\/\* @vite-ignore \*\/ url\)/.test(pc) && /mod\.activate\(api\)/.test(pc) && /cur\.mod\?\.deactivate/.test(pc) && /ctl\.abort\(\)/.test(pc), 'plugin-client imports a module ONLY when the server says trusted, calls activate(api), deactivates + aborts on disable');
ok(/registerPluginSettings\(m\.id, m\.label \|\| m\.id, items\)/.test(pc) && /unregisterPluginSettings\(id\)/.test(pc) && /registerPluginTheme\?\.\(key, `\$\{th\.label\} \(plugin\)`/.test(pc) && /unregisterPluginTheme\?\.\(key\)/.test(pc) && /this\.errors\.set\(m\.id, msg\)/.test(pc) && /showToast\(t\('Plugin \{id\} failed to load: \{error\}'/.test(pc), 'plugin-client registers/unregisters contributed settings + themes and reports module load errors (toast + errors map)');
ok(/fetch: \(p, opts\) => \{[\s\S]{0,300}\/api\/plugins\/\$\{encodeURIComponent\(id\)\}\/x\$\{rel\}/.test(pc) && /app\.settings\?\.on\?\.\(p, h\)/.test(pc), 'the host API scopes fetch to the plugin\'s own routes and subscribes settings per path (settings.js on(path, cb))');
const pui = read('src/lib/plugins-ui.js');
ok(/_pluginConsentDialog\(p, rr\.capabilities\)/.test(pui) && /enablePlugin\(p, \{ trusted: true \}\)/.test(pui) && /t\('Enable \(trusted\)'\)/.test(pui) && /escHtml\(t\(it\.text, it\.params \|\| \{\}\)\)/.test(pui), 'the panel turns a 409 consentRequired into the consent dialog (capability items via t(text, params)) and re-enables with trusted:true');
ok(/_pluginInstallDialog\(/.test(pui) && /\/api\/plugins\/install/.test(pui) && /new FormData\(\)/.test(pui) && /method: 'DELETE'/.test(pui) && /\/update`, \{ method: 'POST' \}/.test(pui) && /showConfirmDialog\(\{ title: t\('Uninstall plugin'\)/.test(pui), 'the panel has Install plugin… (JSON + multipart), Update, and a confirmed Uninstall');
ok(/escHtml\(p\.notice\)/.test(pui) && /escHtml\(t\('Client module error: \{error\}'/.test(pui) && /data-plugin="\$\{escHtml\(p\.id\)\}"/.test(pui), 'notices / errors / ids are escHtml-ed (manifest strings sync to every client)');
const ss = read('src/lib/settings-schema.js');
ok(/export function registerPluginSettings\(pluginId, label, items\)/.test(ss) && /export function unregisterPluginSettings\(pluginId\)/.test(ss) && /export function pluginSettingPath\(pluginId, key\)/.test(ss) && /t\('Plugin: \{name\}'/.test(ss), 'settings-schema exposes register/unregister/path (the only mutation path)');
const tj = read('src/lib/themes.js');
ok(/registerPluginTheme\(key, label, cssVars, terminalColors\)/.test(tj) && /unregisterPluginTheme\(key\)/.test(tj) && /getPluginThemes\(\)/.test(tj) && /this\._pendingTheme\.startsWith\('plugin-'\)/.test(tj), 'ThemeManager registers plugin themes under plugin-* and keeps a pending plugin theme instead of falling back to dark');
ok(/getPluginThemes\?\.\(\)/.test(read('src/lib/app.js')), 'the theme picker lists plugin themes in their own group');
const ld = read('src/server/plugin-loader.js');
ok(/execArgv: permissionArgs\(rec, dataDir\)/.test(ld) && /'--permission'/.test(ld) && /--allow-child-process/.test(ld) && /delete env\.NODE_OPTIONS/.test(ld) && /ERR_ACCESS_DENIED/.test(ld), 'the loader forks plugin servers under node --permission with allowlists from the manifest (NODE_OPTIONS stripped) and classifies denials');
ok(/registry\.trust\[id\] = \{ trusted: true, trustedAt: Date\.now\(\), capabilitiesHash: hash \}/.test(ld) && /needsConsent\(manifest\) && !isTrusted\(rec\)/.test(ld) && /res\.status\(403\)\.json\(\{ error: `plugin "\$\{rec\.id\}" is not trusted/.test(ld), 'trust is recorded with the capabilities hash, drift disables at discovery, the module route is 403 without it');
ok(/HostManager\.extraAgentTools = \(\) => pluginLoader\.shimNames\(\)/.test(read('src/server/mounts-plugins-wiring.js')) && /instanceUrl\?\.onChange\?\./.test(read('src/server/mounts-plugins-wiring.js')) && (read('src/ws-create.js').match(/HostManager\.agentTools\(\)/g) || []).length === 2 && !/HostManager\.AGENT_TOOLS\b/.test(read('src/ws-create.js')), 'shims ship with the core tools: wiring installs the provider, ws-create distributes agentTools() (ssh + dial), instance-url changes regenerate them');
ok(fs.existsSync(path.join(REPO, 'docs/plugins.md')) && /contributes\.settings/.test(read('docs/plugins.md')) && /--permission/.test(read('docs/plugins.md')) && /plugins\.md/.test(read('docs/README.md')), 'docs/plugins.md documents the manifest, tiers, consent, install sources and enforcement; indexed in docs/README.md');
ok(/'test-plugin-trust'/.test(read('scripts/ci.mjs')), 'this suite is in the release gate');
for (const dict of ['src/lib/i18n-zh.js', 'src/lib/i18n-ja.js']) ok(['Install plugin…', 'Enable (trusted)', 'Uninstall…', 'Plugin: {name}', 'Server: read files under {paths}'].every((k) => read(dict).includes(JSON.stringify(k) + ':')), `${dict} carries the Ph4 strings`);
const ex = JSON.parse(read('docs/examples/hello-plugin/vibespace-plugin.json'));
ok(ex.contributes.settings?.length === 1 && ex.contributes.themes?.length === 1 && fs.existsSync(path.join(REPO, 'docs/examples/hello-plugin', ex.contributes.themes[0].file)), 'the shipped example demonstrates a contributed setting and theme');

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
