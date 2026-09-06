'use strict';
// PLUGIN LOADER (Plugin Ph2 minimal 2.369.24; Ph4 trusted tier + consent +
// contributions + install sources + capability ENFORCEMENT 2.369.30 —
// docs/design-harness-plugins.md §3, docs/plugins.md). Manifest-driven plugins
// under data/plugins/<id>/vibespace-plugin.json:
//   • client tier `iframe`: assets served at /plugins/<id>/<path> from the
//     plugin's ui/ folder under the SAME opaque-origin sandbox CSP the
//     published pages use (never allow-same-origin); the client registers each
//     contributed window through the window-type registry.
//   • client tier `module` (TRUSTED): /plugins/<id>/<clientEntry> is served
//     SAME-ORIGIN as application/javascript ONLY while the registry says
//     enabled && trusted (consent recorded by the owner — never from the
//     manifest alone); otherwise 403 with a JSON error naming the missing
//     consent. The client `import()`s it and calls activate(api).
//   • `server: true`: server.js is FORKED as its own process under
//     `node --permission` (IPC-only API, never require()d into the
//     orchestrator): fs allowlist = the plugin dir (read) + its data dir
//     (read/write) + whatever capabilities.server.fs declares; child processes
//     only with capabilities.server.childProcess. Node's permission model does
//     NOT restrict network — `net` is declared/shown, not enforced. A denied
//     access surfaces as ERR_ACCESS_DENIED inside the plugin (or a crash the
//     loader reports as the plugin's error), never as a VibeSpace failure.
//   • /api/plugins/<id>/x/* is proxied over IPC; agentTools become generated
//     shims in data/bin (`vibespace-tool-<id>-<name>`) that POST
//     /api/agent/plugin-tool/<id>/<name> with the session's vsst_ token — the
//     plugin never sees a credential. Shims ship to ssh hosts / dial devices
//     with the other agent tools (hosts.js agentTools()) and call back through
//     VIBESPACE_API (the session's reverse tunnel) or, failing that, this
//     instance's PUBLIC URL baked at generation time (instance-url.js — the
//     only permitted source); with neither they fail with a clear message.
//   • contributes.settings / contributes.themes are validated here and exposed
//     on the manifest list; theme JSON files are served at /plugins/<id>/<file>.
// CONSENT: enabling a `module` plugin, any plugin with declared capabilities,
// or any plugin contributing agent tools needs { trusted: true } on the enable
// request (the panel shows the capability list first). The registry stores
// { trusted, trustedAt, capabilitiesHash }; a manifest whose consent-relevant
// surface later changes hashes differently → disabled at discovery with a
// notice, re-prompted. CONSENT IS PER PACKAGE, NOT PER ID (2.369.43): the
// install record carries the package's contentHash, and installing over an
// existing id keeps enabled/trust only when the package is byte-identical AND
// from the same recorded source — otherwise it is new code behind a trusted
// name, so it lands disabled with a notice (update() = the owner pulling the
// source they already chose, consent rides along).
// State: data/plugin-registry.json { enabled, trust, installs } (atomic).
// Every change broadcasts `plugins-manifests-updated` (multi-client law).
// Uninstall NEVER deletes: plugin dir + state dir move to data/plugins-trash/.
//
// IPC PROTOCOL (api version 1; the child is any Node script):
//   child → parent : { t:'hello', api:1 }
//   parent → child : { t:'route', id, method, path, query, headers:{}, body }   → child: { t:'route-reply', id, status, body }
//   parent → child : { t:'tool', id, name, args, session:{ sessionId } }        → child: { t:'tool-reply', id, ok, output }
//   parent → child : { t:'shutdown' }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { validateManifest, needsConsent, capabilitySummary, capabilitiesHash } = require('../plugin-manifest');

const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-downloads allow-modals allow-forms";
const PROXY_CSP = "sandbox; default-src 'none'";   // proxied route replies are DATA on the app origin — never a live document
const DOCUMENT_CT = /^\s*(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i;
const IPC_TIMEOUT_MS = 30000;
const MAX_CRASHES = 5;          // within CRASH_WINDOW_MS ⇒ parked (a crash loop must not hammer the box)
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_THEME_BYTES = 100 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json' };

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const STOPPING = Symbol('vibespace.plugin.intentional-stop'); // per-CHILD mark: this process is being stopped on purpose
const httpErr = (status, msg, payload) => Object.assign(new Error(msg), { status, payload });

/** JS source literal for ANY manifest-supplied value. JSON.stringify escapes
 *  quotes/backslashes/control characters but leaves U+2028/U+2029 (legal in a
 *  string literal only since ES2019, and a statement terminator everywhere
 *  else) — the shims run on remote hosts under whatever node is there, so both
 *  get \uXXXX'd. The ONLY way manifest text may enter generated code. */
function jsLiteral(v) {
  return JSON.stringify(v === undefined ? null : v).replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** The tool's args schema as one JSON string (never a code fragment). */
function jsonOf(v) { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } }

/** Theme file contract = the custom-theme shape ThemeManager.registerCustomTheme
 *  takes: { css: { '--var': 'value' }, terminal?: { background, … } }. Same
 *  key/value hygiene as POST /api/custom-themes (a bad value would inject CSS
 *  on every client — themes reach all of them). */
function readThemeFile(dir, file) {
  const fp = path.resolve(dir, file);
  if (fp !== path.resolve(dir) && !fp.startsWith(path.resolve(dir) + path.sep)) return { ok: false, error: 'file escapes the plugin dir' };
  let st; try { st = fs.statSync(fp); } catch { return { ok: false, error: `${file}: missing` }; }
  if (!st.isFile()) return { ok: false, error: `${file}: not a file` };
  if (st.size > MAX_THEME_BYTES) return { ok: false, error: `${file}: larger than ${MAX_THEME_BYTES / 1024} KB` };
  let raw; try { raw = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (e) { return { ok: false, error: `${file}: ${e.message}` }; }
  if (!raw || typeof raw !== 'object' || !raw.css || typeof raw.css !== 'object' || Array.isArray(raw.css)) return { ok: false, error: `${file}: must be { "css": { "--var": "value" }, "terminal"?: {…} }` };
  for (const [k, v] of Object.entries(raw.css)) {
    if (!/^--[\w-]+$/.test(k)) return { ok: false, error: `${file}: css key "${String(k).slice(0, 40)}" must be a --custom-property` };
    if (typeof v !== 'string' || /[{};]/.test(v) || v.length > 200) return { ok: false, error: `${file}: css value for ${k} must be a short string without { } ;` };
  }
  if (raw.terminal !== undefined && (!raw.terminal || typeof raw.terminal !== 'object' || Array.isArray(raw.terminal) || Object.values(raw.terminal).some((v) => typeof v !== 'string' || v.length > 100))) return { ok: false, error: `${file}: terminal must be an object of color strings` };
  return { ok: true, css: raw.css, terminal: raw.terminal || null };
}

/** Node's ERR_ACCESS_DENIED trace names the permission + resource; turn the
 *  stderr tail into one line the panel can show. */
function classifyExit(tail, code, signal) {
  const t = String(tail || '');
  if (/ERR_ACCESS_DENIED/.test(t)) {
    const perm = (t.match(/permission: '([^']+)'/) || [])[1];
    const res = (t.match(/resource: '([^']+)'/) || [])[1];
    return `denied ${perm ? perm.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : 'access'}${res ? ' of ' + res : ''} outside its declared capabilities (ERR_ACCESS_DENIED — declare it under capabilities.server in vibespace-plugin.json, then enable again)`;
  }
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !/^\(node:\d+\)|^\(Use `node --trace|SecurityWarning/.test(l));
  const last = lines.length ? lines[lines.length - 1].slice(0, 300) : '';
  return `exited (${signal || 'code ' + code})${last ? ': ' + last : ''}`;
}

function create({ rootDir, app, broadcast = () => {}, agentEnv = () => ({ ...process.env }), agentAuth = () => null, log = console, hostVersion = null, binDir = null, autoStart = true, instanceUrl = null, telemetry = null } = {}) {
  const pluginsDir = path.join(rootDir, 'data', 'plugins');
  const stateDir = path.join(rootDir, 'data', 'plugins-state');
  const registryFile = path.join(rootDir, 'data', 'plugin-registry.json');
  const shimDir = binDir || path.join(rootDir, 'data', 'bin');
  // A declared fs capability may never cover VibeSpace's own files (the loader's
  // implicit grants — plugin dir + data/plugins-state/<id> — are inside data/
  // but are added by us, never declared).
  const forbiddenRoots = [{ path: path.resolve(rootDir), label: 'the VibeSpace install dir' }, { path: path.join(path.resolve(rootDir), 'data'), label: 'the VibeSpace data dir' }];
  const installer = require('./plugin-install.js').create({ rootDir, hostVersion, forbiddenRoots, log });
  const plugins = new Map(); // id → { id, dir, manifest, errors, warnings, enabled, child, state, crashes:[], pending:Map, nextId, themes:{}, notice, errTail }
  let registry = { enabled: {}, trust: {}, installs: {} };
  try { registry = { ...registry, ...(JSON.parse(fs.readFileSync(registryFile, 'utf-8')) || {}) }; } catch { }
  for (const k of ['enabled', 'trust', 'installs']) if (!registry[k] || typeof registry[k] !== 'object') registry[k] = {};
  const saveRegistry = () => { try { fs.mkdirSync(path.dirname(registryFile), { recursive: true }); writeJsonAtomic(registryFile, registry); } catch (e) { log.warn?.('[plugins] registry write failed:', e.message); } };
  const notify = () => { try { broadcast({ type: 'plugins-manifests-updated', plugins: list() }); } catch { } };
  const tele = (name, detail) => { try { telemetry?.({ kind: 'event', name, detail: String(detail || '').slice(0, 300) }); } catch { } };
  const hashOf = (rec) => (rec?.manifest ? capabilitiesHash(rec.manifest) : null);
  const isTrusted = (rec) => { const t = registry.trust[rec.id]; return !!(t && t.trusted && rec.manifest && t.capabilitiesHash === hashOf(rec)); };

  // ── discovery ──
  function discover() {
    let dirs = [];
    try { dirs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { }
    const seen = new Set();
    let registryDirty = false;
    for (const name of dirs) {
      const dir = path.join(pluginsDir, name);
      let raw = null, errors = [], warnings = [], manifest = null;
      try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'vibespace-plugin.json'), 'utf-8')); }
      catch (e) { errors = [`vibespace-plugin.json: ${e.code === 'ENOENT' ? 'missing' : e.message}`]; }
      if (raw) { const v = validateManifest(raw, { hostVersion, folderName: name, homeDir: os.homedir(), forbiddenRoots }); errors = v.errors; warnings = v.warnings; manifest = v.manifest; }
      if (manifest?.server && !fs.existsSync(path.join(dir, 'server.js'))) { errors.push('server: true but server.js is missing'); manifest = null; }
      if (manifest?.client === 'module' && !fs.existsSync(path.join(dir, manifest.clientEntry))) { errors.push(`client: module but ${manifest.clientEntry} is missing`); manifest = null; }
      const themes = {};
      for (const th of manifest?.contributes?.themes || []) { const r = readThemeFile(dir, th.file); themes[th.id] = r.ok ? { ok: true } : { ok: false, error: r.error }; if (!r.ok) warnings.push(`theme "${th.id}": ${r.error}`); }
      const id = manifest?.id || name;
      seen.add(id);
      const prev = plugins.get(id);
      const rec = prev || { id, crashes: [], pending: new Map(), nextId: 1, child: null, state: 'stopped', notice: null, errTail: '' };
      Object.assign(rec, { dir, manifest, errors, warnings, themes, enabled: !!registry.enabled[id] && !!manifest });
      // CONSENT DRIFT: an enabled plugin whose consent-relevant surface changed
      // (new capability, tier flip, new tool) is switched OFF until the owner
      // reviews it again — the trust record names what was agreed to.
      if (rec.enabled && needsConsent(manifest) && !isTrusted(rec)) {
        const had = registry.trust[id];
        registry.enabled[id] = false; rec.enabled = false; registryDirty = true;
        rec.notice = had ? 'capabilities changed since you trusted this plugin — review them and enable it again' : 'this plugin needs your consent — review its capabilities and enable it';
        log.warn?.(`[plugins] ${id}: disabled — ${rec.notice}`);
        tele('plugin-consent-drift', id);
      }
      plugins.set(id, rec);
      if (errors.length) log.warn?.(`[plugins] ${id}: invalid — ${errors.join('; ')}`);
    }
    for (const id of [...plugins.keys()]) if (!seen.has(id)) { stopChild(plugins.get(id)); plugins.delete(id); }
    if (registryDirty) saveRegistry();
  }

  // ── server child lifecycle (node --permission = the safety belt, per design §3.2 layer 4) ──
  function permissionArgs(rec, dataDir) {
    const caps = rec.manifest?.capabilities?.server || {};
    const args = ['--permission', `--allow-fs-read=${rec.dir}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`];
    for (const p of caps.fs?.read || []) args.push(`--allow-fs-read=${p}`);
    for (const p of caps.fs?.write || []) { args.push(`--allow-fs-write=${p}`); if (!(caps.fs?.read || []).includes(p)) args.push(`--allow-fs-read=${p}`); } // write implies read
    if (caps.childProcess) args.push('--allow-child-process');
    return args;
  }
  function startChild(rec) {
    if (!rec.manifest?.server || rec.child || !rec.enabled) return;
    const now = Date.now();
    rec.crashes = rec.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (rec.crashes.length >= MAX_CRASHES) { rec.state = 'parked'; log.warn?.(`[plugins] ${rec.id}: parked after ${MAX_CRASHES} crashes in 10min`); return; }
    const dataDir = path.join(stateDir, rec.id);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch { }
    const env = { ...agentEnv(), VIBESPACE_PLUGIN_ID: rec.id, VIBESPACE_PLUGIN_DIR: rec.dir, VIBESPACE_PLUGIN_DATA: dataDir, VIBESPACE_PLUGIN_API_VERSION: '1' };
    delete env.NODE_OPTIONS; // the permission flags are ours; an inherited NODE_OPTIONS must not widen them
    let child;
    try {
      child = fork(path.join(rec.dir, 'server.js'), [], { cwd: rec.dir, env, execArgv: permissionArgs(rec, dataDir), serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (e) { rec.state = 'error'; rec.lastError = e.message; log.warn?.(`[plugins] ${rec.id}: fork failed: ${e.message}`); return; }
    rec.child = child; rec.state = 'starting'; rec.startedAt = now; rec.lastError = null; rec.errTail = '';
    // an IPC send racing the child's exit surfaces as an 'error' EVENT (ERR_IPC_CHANNEL_CLOSED) — unhandled it would crash the HOST
    child.on('error', (e) => { rec.lastError = rec.lastError || e.message; log.warn?.(`[plugins] ${rec.id}: child error: ${e.message}`); });
    child.stdout?.on('data', (d) => log.log?.(`[plugin ${rec.id}] ${String(d).trimEnd()}`));
    child.stderr?.on('data', (d) => { const s = String(d); rec.errTail = (rec.errTail + s).slice(-4096); if (!/SecurityWarning: The flag --allow-child-process/.test(s)) log.warn?.(`[plugin ${rec.id}] ${s.trimEnd()}`); });
    child.on('message', (m) => onChildMessage(rec, m));
    child.on('exit', (code, signal) => {
      if (rec.child !== child) return;
      rec.child = null;
      for (const [, p] of rec.pending) { clearTimeout(p.timer); p.reject(new Error('plugin process exited')); }
      rec.pending.clear();
      // PER-CHILD stop mark (2.369.43): rec._stopping was one flag for a
      // record that can hold TWO live children — while an old child was still
      // exiting (SIGTERM…SIGKILL, up to 3s), a freshly started child that
      // crashed at once read the OLD child's flag and was filed as an
      // intentional stop: no crash count, no lastError, no restart. The mark
      // belongs to the child that is being stopped.
      const wanted = rec.enabled && !child[STOPPING];
      rec.state = wanted ? 'crashed' : 'stopped';
      if (wanted) {
        rec.crashes.push(Date.now());
        rec.lastError = classifyExit(rec.errTail, code, signal);
        const delay = Math.min(10000, 1000 * Math.pow(2, rec.crashes.length - 1));
        log.warn?.(`[plugins] ${rec.id}: ${rec.lastError} — restart in ${delay}ms`);
        tele('plugin-crash', `${rec.id} ${rec.lastError}`);
        rec._restartTimer = setTimeout(() => { rec._restartTimer = null; startChild(rec); notify(); }, delay);
        rec._restartTimer.unref?.();
      }
      notify();
    });
  }
  function stopChild(rec) {
    if (rec._restartTimer) { clearTimeout(rec._restartTimer); rec._restartTimer = null; }
    const child = rec.child;
    if (!child) { rec.state = 'stopped'; return; }
    // DETACH FIRST (2.369.37, CI-caught): while the old process was still
    // exiting, rec.child stayed set, so the startChild that install()/update()
    // issue right after this returned early and the plugin only came back
    // through the OLD child's exit handler + crash-backoff — fast on a laptop,
    // >10s on the CI runner. The exit handler ignores a child that is no
    // longer rec.child, so nulling it here is exactly the intentional-stop mark.
    rec.child = null; rec.state = 'stopped';
    child[STOPPING] = true;
    try { child.send({ t: 'shutdown' }); } catch { }
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, 3000);
    killer.unref?.();
    try { child.kill('SIGTERM'); } catch { }
    child.once('exit', () => { clearTimeout(killer); });
  }
  function onChildMessage(rec, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') { rec.state = 'running'; rec.api = m.api || 1; notify(); return; }
    if (m.t === 'route-reply' || m.t === 'tool-reply') {
      const p = rec.pending.get(m.id);
      if (!p) return;
      rec.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m);
    }
  }
  function ask(rec, msg, timeoutMs = IPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!rec.child || rec.state === 'parked') return reject(Object.assign(new Error(`plugin ${rec.id} is not running (${rec.state})`), { status: 503 }));
      const id = rec.nextId++;
      const timer = setTimeout(() => { rec.pending.delete(id); reject(Object.assign(new Error('plugin did not answer in time'), { status: 504 })); }, timeoutMs);
      rec.pending.set(id, { resolve, reject, timer });
      try { rec.child.send({ ...msg, id }); } catch (e) { rec.pending.delete(id); clearTimeout(timer); reject(Object.assign(e, { status: 503 })); }
    });
  }

  // ── agent tool shims ──
  function shimName(pluginId, tool) { return `vibespace-tool-${pluginId.replace(/[^a-z0-9.-]/g, '')}-${tool}`; }
  function wantedShims() {
    const wanted = new Map();
    for (const rec of plugins.values()) {
      if (!rec.enabled || !rec.manifest?.server) continue;
      for (const t of rec.manifest.contributes.agentTools) wanted.set(shimName(rec.id, t.name), { rec, t });
    }
    return wanted;
  }
  /** Names of every shim that exists right now — hosts.js agentTools() ships them with the core tools. */
  function shimNames() { return [...wantedShims().keys()]; }
  function bakedInstanceUrl() { try { return String(instanceUrl?.url?.() || '').replace(/\/+$/, ''); } catch { return ''; } }
  function syncShims() {
    try { fs.mkdirSync(shimDir, { recursive: true }); } catch { }
    const wanted = wantedShims();
    let existing = [];
    try { existing = fs.readdirSync(shimDir).filter((f) => f.startsWith('vibespace-tool-')); } catch { }
    for (const f of existing) if (!wanted.has(f)) { try { fs.unlinkSync(path.join(shimDir, f)); } catch { } }
    const baked = bakedInstanceUrl();
    for (const [name, { rec, t }] of wanted) {
      // NEVER interpolate manifest free text into generated CODE (2.369.43): a
      // lone CR / U+2028 / U+2029 in a description ends a `//` comment and the
      // rest of it becomes executable JavaScript in a file that runs OUTSIDE
      // the plugin sandbox with the session token in its env. Description and
      // args ride jsLiteral() — a JSON string constant with every line
      // terminator escaped — and the comment header carries only the
      // regex-validated id/tool slugs.
      const body = `#!/usr/bin/env node
// GENERATED by VibeSpace (plugin ${rec.id} tool "${t.name}") — do not edit; regenerated on every plugin change.
// Usage: ${name} [--key value ...] | ${name} '<json args>'    (run with --help for the description + args schema)
const DESCRIPTION = ${jsLiteral(t.description)};
const ARGS_SCHEMA = ${jsLiteral(jsonOf(t.args))};
const argv = process.argv.slice(2);
let args = {};
if (argv.length === 1 && /^\\s*\\{/.test(argv[0])) { try { args = JSON.parse(argv[0]); } catch { console.error('args must be JSON or --key value pairs'); process.exit(2); } }
else { for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; args[k] = v; } } }
if (argv.includes('--help') || argv.includes('-h')) { console.log(DESCRIPTION); console.log('args: ' + ARGS_SCHEMA); process.exit(0); }
// Call-back address: the session's own channel first (VIBESPACE_API — on a remote
// host this is the reverse tunnel back to the instance), else the instance's
// PUBLIC URL baked in when this shim was generated. Never a guess.
const INSTANCE_URL = ${JSON.stringify(baked)};
const api = process.env.VIBESPACE_API || INSTANCE_URL, token = process.env.VIBESPACE_SESSION_TOKEN;
if (!token) { console.error('not inside a VibeSpace session (VIBESPACE_SESSION_TOKEN unset)'); process.exit(3); }
if (!api) { console.error('not inside a VibeSpace session (VIBESPACE_API unset) and this VibeSpace has no public URL configured — set Settings → agentd.publicUrl or map the instance in the Ports panel, then re-enable the plugin so the tool learns the address'); process.exit(3); }
fetch(api + '/api/agent/plugin-tool/${rec.id}/${t.name}', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ args }) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) { console.error(j.error || ('HTTP ' + r.status)); process.exit(1); } process.stdout.write(typeof j.output === 'string' ? j.output + (j.output.endsWith('\\n') ? '' : '\\n') : JSON.stringify(j.output, null, 2) + '\\n'); })
  .catch((e) => { console.error('request failed: ' + e.message); process.exit(1); });
`;
      const fp = path.join(shimDir, name);
      try { if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf-8') === body) continue; fs.writeFileSync(fp, body, { mode: 0o755 }); fs.chmodSync(fp, 0o755); } catch (e) { log.warn?.(`[plugins] shim ${name}: ${e.message}`); }
    }
  }

  // ── public ──
  function list() {
    return [...plugins.values()].map((r) => {
      const m = r.manifest;
      const inst = registry.installs[r.id] || null;
      return {
        id: r.id, version: m?.version || null, label: m?.label || r.id, description: m?.description || '', icon: m?.icon || null,
        client: m?.client || 'none', clientEntry: m?.clientEntry || null, server: !!m?.server,
        contributes: m ? { ...m.contributes, themes: (m.contributes.themes || []).map((t) => ({ ...t, ...(r.themes?.[t.id] || {}) })) } : { windows: [], agentTools: [], routes: false, settings: [], themes: [] },
        capabilities: m?.capabilities || { server: { fs: { read: [], write: [] }, childProcess: false, net: [] } },
        capabilitySummary: m ? capabilitySummary(m) : [], capabilitiesHash: hashOf(r),
        needsConsent: needsConsent(m), trusted: isTrusted(r), consentRequired: needsConsent(m) && !isTrusted(r), trustedAt: registry.trust[r.id]?.trustedAt || null,
        install: inst ? { source: inst.source, value: inst.value, installedAt: inst.installedAt, updatedAt: inst.updatedAt || null } : null,
        enabled: !!r.enabled, valid: !!m, errors: r.errors || [], warnings: r.warnings || [], notice: r.notice || null,
        state: m?.server ? r.state : (r.enabled ? 'running' : 'stopped'), lastError: r.lastError || null,
      };
    });
  }
  function setEnabled(id, on, { trusted = false } = {}) {
    const rec = plugins.get(id);
    if (!rec) throw httpErr(404, `unknown plugin "${id}"`);
    if (on && !rec.manifest) throw httpErr(400, `plugin "${id}" is invalid: ${rec.errors.join('; ')}`);
    if (on && needsConsent(rec.manifest)) {
      const hash = hashOf(rec);
      if (trusted) { registry.trust[id] = { trusted: true, trustedAt: Date.now(), capabilitiesHash: hash }; tele('plugin-trusted', id); }
      else if (!isTrusted(rec)) {
        const had = registry.trust[id];
        throw httpErr(409, had ? `"${id}" changed its capabilities since you trusted it — review them and enable it with "Enable (trusted)"` : `"${id}" needs your consent: it asks for capabilities beyond the sandbox — review them and enable it with "Enable (trusted)"`,
          { consentRequired: true, capabilities: capabilitySummary(rec.manifest), capabilitiesHash: hash, changed: !!had });
      }
    }
    registry.enabled[id] = !!on; saveRegistry();
    rec.enabled = !!on && !!rec.manifest;
    rec.notice = null;
    if (rec.enabled) { rec.crashes = []; if (rec.state === 'parked') rec.state = 'stopped'; startChild(rec); }
    else stopChild(rec);
    syncShims(); notify();
    tele(on ? 'plugin-enable' : 'plugin-disable', id);
    return list().find((p) => p.id === id);
  }
  function reload() { discover(); for (const rec of plugins.values()) { if (rec.enabled) startChild(rec); else stopChild(rec); } syncShims(); notify(); return list(); }
  function shutdown() { for (const rec of plugins.values()) stopChild(rec); }
  function get(id) { return plugins.get(id) || null; }

  async function install({ source, value, file } = {}) {
    const r = await installer.install({ source, value, file });
    const prevInst = registry.installs[r.id] || null;
    // CONSENT DOES NOT TRANSFER TO NEW CODE (2.369.43): `enabled` and `trust`
    // are keyed by plugin ID, so installing a DIFFERENT package that declares
    // an already-trusted id used to inherit both — auto-enabled, still trusted,
    // its client module served same-origin without a single dialog (a manifest
    // that copies the trusted one's capability surface even keeps
    // capabilitiesHash identical, so the drift check never fires). The consent
    // fast path survives only for a byte-identical package from the SAME
    // recorded source; anything else is new code and must be reviewed again.
    const sameSource = !!prevInst && prevInst.source === r.source && prevInst.value === r.value;
    const sameContent = !!prevInst && !!prevInst.contentHash && prevInst.contentHash === r.contentHash;
    const reconsent = r.replaced && !(sameSource && sameContent) && (!!registry.enabled[r.id] || !!registry.trust[r.id]);
    if (reconsent) { registry.enabled[r.id] = false; delete registry.trust[r.id]; }
    registry.installs[r.id] = { source: r.source, value: r.value, contentHash: r.contentHash || null, installedAt: prevInst?.installedAt || Date.now(), updatedAt: prevInst ? Date.now() : null };
    saveRegistry();
    const prev = plugins.get(r.id);
    if (prev) stopChild(prev);
    discover();
    const rec = plugins.get(r.id);
    if (rec && reconsent) { rec.notice = 'replaced by a different package — review what it asks for and enable it again'; log.warn?.(`[plugins] ${r.id}: ${rec.notice}`); tele('plugin-replaced-untrusted', r.id); }
    if (rec?.enabled) { rec.crashes = []; startChild(rec); }
    syncShims(); notify();
    tele('plugin-install', `${source} ${r.id}@${r.version}${r.replaced ? ' (replaced)' : ''}`);
    const plugin = list().find((p) => p.id === r.id);
    return { plugin, replaced: r.replaced, previous: r.previous, warnings: r.warnings, disabled: reconsent, consentRequired: reconsent && !!plugin?.needsConsent, notice: reconsent ? rec?.notice || null : null };
  }
  function uninstall(id) {
    const rec = plugins.get(id);
    if (!rec) throw httpErr(404, `unknown plugin "${id}"`);
    stopChild(rec);
    const trashPath = installer.trash(id, { reason: 'uninstall' });
    delete registry.enabled[id]; delete registry.trust[id]; delete registry.installs[id]; saveRegistry();
    plugins.delete(id);
    discover(); syncShims(); notify();
    log.log?.(`[plugins] uninstalled ${id} → ${trashPath || '(nothing on disk)'}`);
    tele('plugin-uninstall', id);
    return { ok: true, id, trash: trashPath };
  }
  async function update(id) {
    const rec = plugins.get(id);
    if (!rec) throw httpErr(404, `unknown plugin "${id}"`);
    const inst = registry.installs[id];
    if (!inst) throw httpErr(400, `"${id}" has no recorded install source (it was placed by hand) — reinstall it through Install plugin… to make it updatable`);
    if (inst.source === 'zip') throw httpErr(400, `"${id}" was installed from an uploaded file — upload the new .vsp through Install plugin… (it replaces the installed copy)`);
    stopChild(rec);
    const r = await installer.install({ source: inst.source, value: inst.value, expectId: id });
    // Update = the owner deliberately pulling a new version of THIS plugin from
    // the source they already chose; consent rides along (a changed capability
    // surface still trips the discovery drift check). The new fingerprint must
    // be recorded, or a later reinstall would compare against a stale one.
    registry.installs[id] = { ...inst, value: r.value, contentHash: r.contentHash || null, updatedAt: Date.now() }; saveRegistry();
    discover();
    const fresh = plugins.get(id);
    if (fresh?.enabled) { fresh.crashes = []; startChild(fresh); }
    syncShims(); notify();
    tele('plugin-update', `${inst.source} ${id}@${r.version}`);
    return { plugin: list().find((p) => p.id === id), previous: r.previous, warnings: r.warnings };
  }

  // ── routes ──
  if (app) {
    const sendErr = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.payload || {}) });
    app.get('/api/plugins/manifests', (req, res) => res.json({ plugins: list(), hostVersion }));
    app.post('/api/plugins/manifests/reload', (req, res) => res.json({ plugins: reload() }));
    app.post('/api/plugins/manifests/:id/enabled', (req, res) => {
      try { res.json({ plugin: setEnabled(String(req.params.id), !!req.body?.enabled, { trusted: req.body?.trusted === true }) }); }
      catch (e) { sendErr(res, e); }
    });
    app.get('/api/plugins/manifests/:id/capabilities', (req, res) => {
      const rec = plugins.get(String(req.params.id));
      if (!rec) return res.status(404).json({ error: 'unknown plugin' });
      res.json({ id: rec.id, valid: !!rec.manifest, needsConsent: needsConsent(rec.manifest), trusted: isTrusted(rec), trust: registry.trust[rec.id] || null, capabilitiesHash: hashOf(rec), capabilities: rec.manifest?.capabilities || null, summary: rec.manifest ? capabilitySummary(rec.manifest) : [] });
    });
    // INSTALL: JSON { source, value } or multipart (source=zip, field "file" = the .vsp)
    let uploadMw = (req, res, next) => next();
    try {
      const multer = require('multer');
      const up = multer({ dest: path.join(os.tmpdir(), 'vibespace-plugin-uploads'), limits: { fileSize: require('./plugin-install.js').MAX_ZIP_BYTES, files: 1 } }).single('file');
      uploadMw = (req, res, next) => up(req, res, (err) => (err ? res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'the .vsp is larger than 50 MB' : err.message }) : next()));
    } catch (e) { log.warn?.('[plugins] multer unavailable — .vsp uploads disabled: ' + e.message); }
    app.post('/api/plugins/install', uploadMw, async (req, res) => {
      try { res.json(await install({ source: req.body?.source, value: req.body?.value, file: req.file?.path || null })); }
      catch (e) { tele('plugin-install-failed', `${req.body?.source || '?'} ${e.message}`); sendErr(res, e); }
    });
    app.delete('/api/plugins/manifests/:id', (req, res) => { try { res.json(uninstall(String(req.params.id))); } catch (e) { sendErr(res, e); } });
    app.post('/api/plugins/manifests/:id/update', async (req, res) => {
      try { res.json(await update(String(req.params.id))); }
      catch (e) { tele('plugin-update-failed', `${req.params.id} ${e.message}`); sendErr(res, e); }
    });
    // plugin assets: declared theme files (any tier) → the trusted client
    // module (same-origin, consent-gated) → iframe-tier ui/ (opaque-origin sandbox)
    app.get('/plugins/:id/*', (req, res) => {
      const rec = plugins.get(String(req.params.id));
      const rel = String(req.params[0] || '');
      if (!rec || !rec.enabled || !rec.manifest) return res.status(404).type('text').send('plugin not found or disabled');
      const inside = (root, p) => p === root || p.startsWith(root + path.sep);
      const theme = rec.manifest.contributes.themes.find((t) => t.file === rel);
      if (theme) {
        const fp = path.resolve(rec.dir, rel);
        if (!inside(path.resolve(rec.dir), fp) || !fs.existsSync(fp)) return res.status(404).type('text').send('not found');
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-cache');
        res.type('application/json');
        return fs.createReadStream(fp).pipe(res);
      }
      if (rec.manifest.client === 'module' && rel === rec.manifest.clientEntry) {
        if (!isTrusted(rec)) return res.status(403).json({ error: `plugin "${rec.id}" is not trusted — its client module loads only after you enable it with "Enable (trusted)" (⚙ → Plugins)`, consentRequired: true });
        const fp = path.resolve(rec.dir, rel);
        if (!inside(path.resolve(rec.dir), fp) || !fs.existsSync(fp)) return res.status(404).type('text').send('not found');
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-cache');
        res.type('text/javascript; charset=utf-8'); // same-origin by design: NO sandbox CSP here
        return fs.createReadStream(fp).pipe(res);
      }
      if (rec.manifest.client === 'none') return res.status(404).type('text').send('plugin has no UI');
      const uiRoot = path.resolve(rec.dir, 'ui');
      const fp = path.resolve(uiRoot, rel);
      if (!inside(uiRoot, fp)) return res.status(400).type('text').send('bad path');
      let st; try { st = fs.statSync(fp); } catch { return res.status(404).type('text').send('not found'); }
      if (!st.isFile()) return res.status(404).type('text').send('not found');
      res.setHeader('Content-Security-Policy', SANDBOX_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      res.type(MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
      fs.createReadStream(fp).pipe(res);
    });
    // proxied plugin routes (server tier) — after cookie auth like every /api/*.
    // The reply is DATA on the APP ORIGIN, never a document: a plugin that is
    // enabled without consent picked its own content-type, so
    // `contentType: 'text/html'` + a <script> was same-origin XSS against
    // VibeSpace itself (2.369.43). Every proxied reply rides nosniff + an
    // opaque-origin sandbox CSP, and a document type from an untrusted plugin
    // is served as text (loudly, once per plugin). Plugin UI belongs in ui/.
    app.all('/api/plugins/:id/x/*', async (req, res) => {
      const rec = plugins.get(String(req.params.id));
      if (!rec || !rec.enabled || !rec.manifest?.contributes?.routes) return res.status(404).json({ error: 'plugin route not found' });
      try {
        const r = await ask(rec, { t: 'route', method: req.method, path: '/' + String(req.params[0] || ''), query: req.query || {}, headers: { 'content-type': req.headers['content-type'] || '' }, body: req.body ?? null });
        const status = Number(r.status) || 200;
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', PROXY_CSP);
        if (r.body !== undefined && typeof r.body !== 'string') return res.status(status).json(r.body);
        let ct = String(r.contentType || 'text/plain');
        if (!/^[\w.+-]+\/[\w.+-]+/.test(ct)) ct = 'text/plain; charset=utf-8'; // not a media type ⇒ express would look it up as an extension
        if (DOCUMENT_CT.test(ct) && !isTrusted(rec)) {
          if (!rec._ctWarned) { rec._ctWarned = true; log.warn?.(`[plugins] ${rec.id}: route answered ${ct} — served as text/plain (a document content-type on the app origin needs "Enable (trusted)"); serve UI from ui/ instead`); }
          ct = 'text/plain; charset=utf-8';
        }
        return res.status(status).type(ct).send(r.body === undefined ? '' : String(r.body));
      } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
    // agent tool calls: under /api/agent/ (cookie-exempt like every agent
    // endpoint) — the route REQUIRES the session's vsst_ bearer (agentAuth)
    app.post('/api/agent/plugin-tool/:id/:name', async (req, res) => {
      const rec = plugins.get(String(req.params.id));
      const tool = rec?.manifest?.contributes?.agentTools?.find((t) => t.name === String(req.params.name));
      if (!rec || !rec.enabled || !tool) return res.status(404).json({ ok: false, error: 'plugin tool not found' });
      let session = null;
      try { session = agentAuth(req) || null; } catch { session = null; }
      if (!session) return res.status(401).json({ ok: false, error: 'missing or unknown session token (vsst_)' });
      try {
        const r = await ask(rec, { t: 'tool', name: tool.name, args: (req.body && typeof req.body.args === 'object') ? req.body.args : {}, session: session ? { sessionId: session.sessionId || null } : null });
        res.status(r.ok === false ? 400 : 200).json({ ok: r.ok !== false, output: r.output ?? '', error: r.error || undefined });
      } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
    });
  }

  discover();
  if (autoStart) { for (const rec of plugins.values()) if (rec.enabled) startChild(rec); }
  syncShims();
  return { list, get, setEnabled, reload, shutdown, discover, syncShims, shimNames, install, uninstall, update, isTrusted: (id) => { const r = plugins.get(id); return !!r && isTrusted(r); }, SANDBOX_CSP, pluginsDir, shimDir, trashDir: installer.trashDir };
}

module.exports = { create, SANDBOX_CSP, readThemeFile, classifyExit };
