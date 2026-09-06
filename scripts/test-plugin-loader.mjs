#!/usr/bin/env node
// Plugin Ph2 minimal (2.369.24, docs/design-harness-plugins.md §3): the manifest
// validator (PURE), and the loader against a REAL fixture plugin (the shipped
// docs/examples/hello-plugin): iframe assets under the opaque-origin sandbox
// CSP, a forked server process reached over IPC (proxied routes + agent tool),
// the generated agent-tool shim, enable/disable lifecycle, path-traversal
// refusal, invalid-manifest loudness. Plus client wiring pins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); } return !!(await pred()); };

// ── ① validator matrix ──
const { validateManifest, compareVersions } = require(path.join(REPO, 'src/plugin-manifest.js'));
const base = { id: 'acme.tool', version: '1.0.0', engines: { vibespace: '2.369.24' }, client: 'iframe', server: true, contributes: { windows: [{ id: 'main', title: 'Main', entry: 'index.html' }], agentTools: [{ name: 'do', description: 'does', args: { type: 'object' } }], routes: true } };
ok(validateManifest(base, { hostVersion: '2.369.24' }).ok, 'a complete manifest validates');
ok(validateManifest(base, { hostVersion: '2.369.24', folderName: 'acme.tool' }).ok && !validateManifest(base, { folderName: 'other' }).ok, 'id must equal the folder name');
ok(!validateManifest({ ...base, id: 'Acme.Tool' }).ok && !validateManifest({ ...base, id: 'tool' }).ok, 'id is <publisher>.<name> lowercase');
ok(!validateManifest({ ...base, version: '1.0' }).ok && !validateManifest({ ...base, engines: {} }).ok, 'version + engines.vibespace are required semver');
ok(!validateManifest(base, { hostVersion: '2.300.0' }).ok && /requires VibeSpace ≥/.test(validateManifest(base, { hostVersion: '2.300.0' }).errors.join()), 'an older host is refused with the minimum named');
ok(!validateManifest({ ...base, contributes: { windows: [{ id: 'x', title: 'X', entry: '../secret.html' }] } }).ok, 'window entries must be relative paths inside ui/ (no ..)');
ok(!validateManifest({ ...base, server: false }).ok && /needs server: true/.test(validateManifest({ ...base, server: false }).errors.join()), 'agentTools/routes need server: true');
ok(!validateManifest({ ...base, client: 'none' }).ok, 'iframe windows need client: iframe');
ok(validateManifest({ ...base, icon: '<svg onload="x()"></svg>' }).manifest.icon === undefined && validateManifest({ ...base, icon: '<svg viewBox="0 0 1 1"/>' }).manifest.icon, 'icons: inline svg only, handlers/scripts rejected (kept as a warning, not a fatal)');
ok(validateManifest({ ...base, contributes: { ...base.contributes, keybindings: [{ a: 1 }] } }).warnings.some((w) => /reserved/.test(w)) && !validateManifest({ ...base, contributes: { ...base.contributes, settings: { a: 1 } } }).ok, 'reserved contributions (keybindings/…) warn, never fail; settings is real since Ph4 (a non-array is an error)');
ok(compareVersions('2.369.24', '2.369.9') > 0 && compareVersions('2.369.24', '2.370.0') < 0 && compareVersions('1.0.0', '1.0.0') === 0, 'compareVersions is numeric per segment');

// ── ② loader against the shipped example plugin ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-plug-'));
const pdir = path.join(root, 'data', 'plugins', 'example.hello');
fs.cpSync(path.join(REPO, 'docs/examples/hello-plugin'), pdir, { recursive: true });
fs.mkdirSync(path.join(root, 'data', 'plugins', 'broken.one'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'plugins', 'broken.one', 'vibespace-plugin.json'), JSON.stringify({ id: 'broken.one', version: 'nope' }));
const express = require(path.join(REPO, 'node_modules/express'));
const app = express();
app.use(express.json({ limit: '1mb' }));
const broadcasts = [];
const sessions = new Map([['sess-1', { agentToken: 'vsst_ok' }]]);
const { create } = require(path.join(REPO, 'src/server/plugin-loader.js'));
const loader = create({ rootDir: root, app, hostVersion: '2.369.24', log: { log() {}, warn() {} }, broadcast: (m) => broadcasts.push(m), agentEnv: () => ({ PATH: process.env.PATH }),
  agentAuth: (req) => { const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); for (const [id, s] of sessions) if (s.agentToken === tok) return { sessionId: id }; return null; } });
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base_ = `http://127.0.0.1:${srv.address().port}`;
const j = async (p, opt) => { const r = await fetch(base_ + p, opt); let b = null; try { b = await r.clone().json(); } catch { b = await r.text(); } return { status: r.status, headers: r.headers, body: b }; };

let m = await j('/api/plugins/manifests');
ok(m.status === 200 && m.body.plugins.some((p) => p.id === 'example.hello' && p.valid && !p.enabled), 'manifests lists the example plugin (valid, disabled by default)');
ok(m.body.plugins.some((p) => p.id === 'broken.one' && !p.valid && p.errors.length), 'an invalid manifest is listed LOUDLY with its errors (never silently skipped)');
ok((await j('/plugins/example.hello/index.html')).status === 404, 'assets are 404 while disabled');
// contributed agent tools are a declared capability since 2.369.43 (the shim is
// a program on every session's PATH, outside the plugin sandbox) → consent gate
const noConsent = await j('/api/plugins/manifests/example.hello/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
ok(noConsent.status === 409 && noConsent.body.consentRequired === true && noConsent.body.capabilities.some((c) => c.id === 'agent-tools'), 'a plugin contributing agent tools cannot be enabled without consent (409 naming the tools)', noConsent.body);
const en = await j('/api/plugins/manifests/example.hello/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, trusted: true }) });
ok(en.status === 200 && en.body.plugin.enabled, 'enable persists and starts the plugin');
ok(fs.existsSync(path.join(root, 'data', 'plugin-registry.json')), 'registry is written atomically to data/plugin-registry.json');
ok(await waitFor(async () => (await j('/api/plugins/manifests')).body.plugins.find((p) => p.id === 'example.hello').state === 'running'), 'the forked server process says hello → state running');
ok(broadcasts.some((b) => b.type === 'plugins-manifests-updated'), 'every change broadcasts plugins-manifests-updated (multi-client law)');
const asset = await j('/plugins/example.hello/index.html');
ok(asset.status === 200 && /^sandbox allow-scripts/.test(asset.headers.get('content-security-policy') || '') && !/allow-same-origin/.test(asset.headers.get('content-security-policy') || ''), 'iframe assets ride the opaque-origin sandbox CSP (never allow-same-origin)');
ok(/text\/html/.test(asset.headers.get('content-type') || '') && asset.headers.get('cache-control') === 'no-cache', 'assets carry a real content-type and no-cache');
ok((await j('/plugins/example.hello/../../plugin-registry.json')).status !== 200 && (await j('/plugins/example.hello/..%2F..%2Fplugin-registry.json')).status !== 200, 'path traversal out of ui/ is refused');
ok((await j('/plugins/example.hello/nope.html')).status === 404, 'missing asset → 404');
const ping = await j('/api/plugins/example.hello/x/ping');
ok(ping.status === 200 && ping.body.pong === true, 'proxied route reaches the plugin process over IPC (GET /x/ping)');
const c1 = await j('/api/plugins/example.hello/x/count', { method: 'POST' }); const c2 = await j('/api/plugins/example.hello/x/count', { method: 'POST' });
ok(c1.body.count === 1 && c2.body.count === 2, 'the plugin keeps state in its own VIBESPACE_PLUGIN_DATA dir (POST /x/count increments)');
ok((await j('/api/plugins/example.hello/x/missing')).status === 404, 'unknown plugin route → the plugin answers 404');
const tool = await j('/api/agent/plugin-tool/example.hello/hello', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer vsst_ok' }, body: JSON.stringify({ args: { name: 'Ada' } }) });
ok(tool.status === 200 && tool.body.ok && /hello, Ada!/.test(tool.body.output) && /session sess-1/.test(tool.body.output), 'agent tool call reaches the plugin with the calling session identity');
ok((await j('/api/agent/plugin-tool/example.hello/hello', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer vsst_bad' }, body: '{}' })).status === 401, 'an unknown vsst_ token is refused (the route is cookie-exempt, so it MUST validate the bearer)');
const shim = path.join(root, 'data', 'bin', 'vibespace-tool-example.hello-hello');
ok(fs.existsSync(shim) && (fs.statSync(shim).mode & 0o111) !== 0, 'an executable agent-tool shim is generated in data/bin');
const help = spawnSync(process.execPath, [shim, '--help'], { encoding: 'utf8' });
ok(help.status === 0 && /greeting/.test(help.stdout), 'the shim explains itself (--help prints the manifest description + args)');
// async: the shim calls THIS process's server — a sync spawn would deadlock the event loop
const run = await new Promise((r) => execFile(process.execPath, [shim, '--name', 'Grace'], { encoding: 'utf8', env: { PATH: process.env.PATH, VIBESPACE_API: base_, VIBESPACE_SESSION_TOKEN: 'vsst_ok' } }, (err, stdout, stderr) => r({ status: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
ok(run.status === 0 && /hello, Grace!/.test(run.stdout), `the shim posts to the host with the session token and prints the output (${JSON.stringify(run.stdout.trim().slice(0, 60))})`);
const noEnv = spawnSync(process.execPath, [shim, '--name', 'x'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
ok(noEnv.status === 3 && /not inside a VibeSpace session/.test(noEnv.stderr), 'outside a session the shim fails loudly');
const dis = await j('/api/plugins/manifests/example.hello/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
ok(dis.status === 200 && !dis.body.plugin.enabled, 'disable persists');
ok(await waitFor(async () => (await j('/api/plugins/manifests')).body.plugins.find((p) => p.id === 'example.hello').state === 'stopped'), 'the plugin process is stopped on disable');
ok((await j('/plugins/example.hello/index.html')).status === 404 && (await j('/api/plugins/example.hello/x/ping')).status === 404 && !fs.existsSync(shim), 'disabled: assets 404, routes 404, shim removed');
ok((await j('/api/plugins/manifests/broken.one/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).status === 400, 'an invalid plugin cannot be enabled (400 with the errors)');
ok((await j('/api/plugins/manifests/nope.nope/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' })).status === 404, 'unknown id → 404');
loader.shutdown(); srv.close();
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

// ── ③ wiring pins ──
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const pc = read('src/lib/plugin-client.js');
const sandboxConst = (pc.match(/const IFRAME_SANDBOX = '([^']*)'/) || [])[1] || '';
ok(/registerWindowType\(\{/.test(pc) && /action: w\.action/.test(pc) && /sandbox', IFRAME_SANDBOX/.test(pc) && sandboxConst.includes('allow-scripts') && !sandboxConst.includes('allow-same-origin'), `plugin-client registers contributed windows as window types and frames them sandboxed (never allow-same-origin): "${sandboxConst}"`);
ok(/plugins-manifests-updated/.test(pc), 'plugin-client re-applies on the manifests broadcast');
const appSrc = read('src/lib/app.js');
const gearSrc = read('src/lib/gear-menu.js');
ok(/installPluginClient\(this\)/.test(appSrc) && /pluginClient\?\.contributedWindows\?\.\(\)/.test(appSrc + gearSrc), 'app installs the plugin client and the ⚙ menu (gear-menu.js since Ph1) lists contributed windows');
const wiring = read('src/server/mounts-plugins-wiring.js');
ok(/require\('\.\/plugin-loader\.js'\)\.create\(/.test(wiring) && /agentAuth: \(req\) =>/.test(wiring) && /s\.agentToken === tok/.test(wiring) && /pluginLoader\.shutdown\(\)/.test(wiring), 'wiring creates the loader with a vsst_-validating agentAuth and shuts plugin processes down with the server');
ok(/, activeSessions,$/m.test(read('server.js')) && /pluginLoader,$/m.test(read('server.js')) && /const \{ agentEnv \} = require\('\.\.\/ws-handler'\);/.test(wiring), 'server.js passes activeSessions and receives the loader; the wiring takes agentEnv from ws-handler (the ONE sanitized-env builder)');
ok(/'src\/plugin-manifest\.js'/.test(read('scripts/test-architecture.mjs')), 'the manifest validator is in the PURE tier');
const pui = read('src/lib/plugins-ui.js');
ok(/fetchJson\('\/api\/plugins\/manifests'\)/.test(pui) && /\/api\/plugins\/manifests\/\$\{encodeURIComponent\(p\.id\)\}\/enabled/.test(pui) && /manifests\/reload/.test(pui) && /this\.pluginClient\?\.open\?\./.test(pui), 'the Plugins panel lists manifest plugins with enable/disable, rescan and open-window actions');
ok(/escHtml\(p\.errors\.join/.test(pui) && /escHtml\(p\.id\)/.test(pui), 'manifest fields are escHtml-ed in the panel (ids/errors come from disk, never trusted HTML)');
for (const dict of ['src/lib/i18n-zh.js', 'src/lib/i18n-ja.js']) ok(['Installed plugins', 'Rescan', 'Plugin enabled', 'parked after repeated crashes'].every((k) => read(dict).includes(JSON.stringify(k) + ':')), `${dict} carries the new panel strings`);
ok(/\/api\/agent\/plugin-tool\//.test(read('src/server/plugin-loader.js')) && /res\.status\(401\)/.test(read('src/server/plugin-loader.js')), 'the tool route lives under the cookie-exempt /api/agent/ prefix and enforces the bearer itself');

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
