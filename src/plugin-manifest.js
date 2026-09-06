'use strict';
// PURE manifest validator for VibeSpace plugins (Plugin Ph2 2.369.24, Ph4
// trusted tier + contributions + capabilities 2.369.30; docs/plugins.md is the
// user-facing schema reference, docs/design-harness-plugins.md §3 the design).
// One manifest = `vibespace-plugin.json` at the plugin's root. ZERO requires:
// the loader (server), the client and the tests all validate with THIS
// function — one contract, no drift. Everything the consent dialog shows
// (capability wording + the change-detection hash) lives here too, so the
// server that records consent and the client that renders it agree by
// construction.
//
//   {
//     "id": "<publisher>.<name>",        lowercase slug.slug, must equal the folder name
//     "version": "1.2.3",
//     "engines": { "vibespace": "2.369.24" },   minimum host version
//     "description": "…", "icon": "<svg …>" (optional, inline svg ≤ 4 KiB),
//     "client": "none" | "iframe" | "module",    UI tier. iframe = sandboxed opaque-origin windows.
//                                                 module = TRUSTED same-origin ES module (clientEntry) — loads ONLY
//                                                 after the owner enabled it with "Enable (trusted)" (registry
//                                                 record, never the manifest alone). "trusted" = alias of module.
//     "clientEntry": "client.js",                 module tier: relative .js path inside the plugin dir (default client.js)
//     "server": true | false,                     server.js forked as its own process (IPC-only API, node --permission)
//     "contributes": {
//       "windows":    [{ "id", "title", "entry": "index.html" }],           iframe windows (served from ui/)
//       "agentTools": [{ "name", "description", "args": { JSON-schema-ish } }], generated `vibespace-tool-<id>-<name>` shims
//       "routes": true | false,                  /api/plugins/<id>/x/* proxied to the server process
//       "settings":   [{ "key", "type": boolean|string|number|select, "default", "label", "description"?, "options"? }],
//                                                → Settings window category "Plugin: <label>", keys plugin.<id>.<key>
//       "themes":     [{ "id", "label", "file": "themes/x.json" }],       JSON { css: {--var: value}, terminal?: {…} }
//       "keybindings": [...]                     accepted, reserved for a later phase (ignored with a warning)
//     },
//     "capabilities": {                          DECLARED at install, shown at enable, ENFORCED server-side:
//       "server": { "fs": { "read": [abs|~ paths], "write": [abs|~ paths] },   node --permission allowlists (+ plugin dir, data dir)
//                                                                               a path may end in ONE "*" (node's prefix wildcard); never over VibeSpace's own dirs
//                   "childProcess": true,                                       --allow-child-process
//                   "net": ["host", …] }                                        declared ONLY — node's permission model does not restrict network
//     }
//   }
// 2.369.43-.44 (security review) — four rules this file OWNS:
//   • every free-text field goes through cleanText(): manifest text ends up in
//     generated agent-tool shims, and a CR / U+2028 / U+2029 used to end the
//     `//` comment there and execute the rest.
//   • declared fs paths are COLLAPSED (duplicate slashes, `.` segments) before
//     the forbidden-root test — node's permission model collapses them, so
//     `/home/u//vibespace/data` and `/./` were grants nobody checked.
//   • declared fs paths are matched the way node MATCHES them: a `*` truncates
//     the pattern into a string prefix, so `/*` (and `<parent>/*`) had to be
//     modelled or they walked straight past the forbidden roots — see
//     normalizeFsPath.
//   • needsConsent covers contributed agentTools: a shim is a program on every
//     session's PATH (local, ssh hosts, paired devices), outside the sandbox.
const ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CLIENT_TIERS = ['none', 'iframe', 'module'];
const CLIENT_TIER_ALIASES = { trusted: 'module' };
const SETTING_TYPES = ['boolean', 'string', 'number', 'select'];
const RESERVED_CONTRIBUTIONS = ['keybindings', 'panels', 'viewers', 'commands', 'menus', 'statusChips', 'backends'];
const MAX_LIST = 32;

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
  return 0;
}

function safeRelPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.startsWith('/') || p.includes('\\') || p.split('/').some((seg) => seg === '..' || seg === '')) return false;
  return true;
}

/** Free manifest TEXT (descriptions, labels, titles) is shown to humans AND —
 *  for agent-tool descriptions — copied into generated files. Control
 *  characters and the JS line terminators U+2028/U+2029 have no place in any of
 *  them: a lone CR once ended a `//` comment in a generated shim and turned the
 *  rest of the description into executable code (2.369.43). One choke point:
 *  every free-text field in a manifest goes through here. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Collapse a POSIX path the way Node's permission model does before it
 *  compares grants: duplicate slashes and `.` segments disappear (`/./` grants
 *  `/`, `/a//b` grants `/a/b`). Returns null when a `..` segment survives.
 *  MUST run before any prefix test — comparing the raw string let
 *  `/home/u//vibespace/data` and `/./` slip past the forbidden roots. */
function collapsePosixPath(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return '/' + out.join('/');
}

/** Normalize one declared fs path: absolute or `~`-rooted, no `..`, never the
 *  whole filesystem and never inside (or over) a forbidden root (the VibeSpace
 *  data dir / repo root). Returns { path } or { error }. `homeDir` expands `~`
 *  (falsy = keep literal).
 *
 *  WILDCARDS ARE PART OF THE GRAMMAR (2.369.44). Node's permission model reads
 *  a declared path only up to the FIRST `*` and grants every path whose string
 *  starts with what came before it — verified against node v24:
 *  `--allow-fs-read=/t/a/*` and `--allow-fs-read=/t/a/*\/never-used` both read
 *  `/t/a/b/c/f.txt`, `--allow-fs-read=/t/a/z*` reads `/t/a/zz.txt` but not
 *  `/t/a/b/…`, and `--allow-fs-read=/*` reads /etc/hostname. The forbidden-root
 *  test therefore has to run on that literal prefix: modelling the pattern as
 *  a plain path let `["/*"]` — or `["<parent-of-the-install-dir>/*"]` — hand a
 *  plugin process VibeSpace's own files while validation said nothing. So:
 *    • at most ONE `*`, only as the LAST character (a `*` in the middle grants
 *      everything before it and silently ignores the rest — refused loudly
 *      rather than accepted as something narrower than it is);
 *    • containment is tested against the literal prefix: a forbidden root that
 *      STARTS WITH the prefix is covered by the grant (a wildcard on a parent
 *      of a forbidden root is forbidden), and a prefix inside a forbidden root
 *      is forbidden as before;
 *    • `/` and `/*` are refused with or without forbidden roots. */
function normalizeFsPath(raw, { homeDir = null, forbiddenRoots = [] } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'must be a non-empty string' };
  let p = raw.trim();
  const tilde = p === '~' || p.startsWith('~/');
  if (tilde) p = homeDir ? String(homeDir).replace(/\/+$/, '') + p.slice(1) : p;
  else if (!p.startsWith('/')) return { error: `"${raw}" must be absolute or start with ~/` };
  if (p.split('/').some((seg) => seg === '..')) return { error: `"${raw}" must not contain ".."` };
  // Split the wildcard off BEFORE collapsing: `/dir/*` (subtree) and `/dir*`
  // (string prefix, so `/dirty` too) are different grants and collapsing the
  // trailing slash away would silently widen the first into the second.
  const star = p.indexOf('*');
  if (star >= 0 && star !== p.length - 1) return { error: `"${raw}" puts "*" in the middle — node's permission model stops reading there and grants everything under "${p.slice(0, star)}", so write the pattern you mean with a single trailing "*"` };
  let tail = '';
  if (star >= 0) {
    p = p.slice(0, -1);
    if (p.endsWith('/')) { tail = '/*'; p = p.replace(/\/+$/, ''); } else tail = '*';
  }
  if (p.startsWith('/')) {
    const collapsed = collapsePosixPath(p);
    if (collapsed === null) return { error: `"${raw}" must not contain ".."` };
    p = collapsed;
  } else if (p.length > 1) p = p.replace(/\/+$/, ''); // literal ~/… (no homeDir): trailing slashes only
  // after collapsing nothing may still hide a slash trick — a belt on the braces
  if (p.includes('//') || /(^|\/)\.(\/|$)/.test(p)) return { error: `"${raw}" is not a plain absolute path` };
  if (p === '/' || p === '') return { error: `"${raw}" grants the whole filesystem — refused (a plugin may never be granted every file this user can reach)` };
  // The STRING node compares against: everything at or under `p` for a plain
  // path and for `…/*`, everything starting with `p` for `…pre*`.
  const prefix = tail === '*' ? p : p + '/';
  for (const root of forbiddenRoots || []) {
    const rp = typeof root === 'string' ? root : root?.path;
    const label = typeof root === 'string' ? root : (root?.label || root?.path);
    if (!rp) continue;
    const r = String(rp).replace(/\/+$/, '');
    if (p === r || p.startsWith(r + '/') || r.startsWith(prefix)) return { error: `"${raw}" covers ${label} — refused (a plugin may never be granted VibeSpace's own files)` };
  }
  return { path: p + tail };
}

/**
 * Validate + normalize a manifest. Never throws.
 * opts: hostVersion, folderName, homeDir (expands `~` in capability paths),
 *       forbiddenRoots ([{path,label}|string] — declared fs paths covering them are errors)
 * @returns {{ ok: boolean, errors: string[], warnings: string[], manifest: object|null }}
 */
function validateManifest(raw, { hostVersion = null, folderName = null, homeDir = null, forbiddenRoots = [] } = {}) {
  const errors = [], warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['manifest must be a JSON object'], warnings, manifest: null };
  const m = {};
  // identity
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push('id must be "<publisher>.<name>" (lowercase letters, digits, hyphens)');
  else if (raw.id.length > 64) errors.push('id must be ≤ 64 characters');
  else m.id = raw.id;
  if (folderName && m.id && folderName !== m.id) errors.push(`id "${m.id}" must equal its folder name "${folderName}"`);
  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version)) errors.push('version must be x.y.z'); else m.version = raw.version;
  const eng = raw.engines && typeof raw.engines === 'object' ? raw.engines.vibespace : undefined;
  if (typeof eng !== 'string' || !SEMVER_RE.test(eng)) errors.push('engines.vibespace must name the minimum host version (x.y.z)');
  else { m.engines = { vibespace: eng }; if (hostVersion && compareVersions(hostVersion, eng) < 0) errors.push(`requires VibeSpace ≥ ${eng} (this host is ${hostVersion})`); }
  m.description = cleanText(raw.description, 500);
  m.label = cleanText(raw.label, 60) || (m.id ? m.id.split('.').slice(1).join('.') : '');
  if (raw.icon !== undefined) {
    if (typeof raw.icon === 'string' && raw.icon.trimStart().startsWith('<svg') && raw.icon.length <= 4096 && !/<script|on[a-z]+=|javascript:|<foreignObject/i.test(raw.icon)) m.icon = raw.icon;
    else warnings.push('icon ignored: must be an inline <svg …> ≤ 4 KiB with no scripts/handlers');
  }
  // tiers
  let client = raw.client === undefined ? 'none' : raw.client;
  if (typeof client === 'string' && CLIENT_TIER_ALIASES[client]) { warnings.push(`client "${client}" is an alias of "${CLIENT_TIER_ALIASES[client]}" — use the canonical name`); client = CLIENT_TIER_ALIASES[client]; }
  if (!CLIENT_TIERS.includes(client)) errors.push(`client must be one of ${CLIENT_TIERS.join('|')}`); else m.client = client;
  if (m.client === 'module') {
    const entry = raw.clientEntry === undefined ? 'client.js' : raw.clientEntry;
    if (!safeRelPath(entry) || !/\.m?js$/i.test(entry)) errors.push('clientEntry must be a relative .js path inside the plugin dir (module tier)');
    else m.clientEntry = entry;
  } else if (raw.clientEntry !== undefined) warnings.push('clientEntry is only used by client: "module" — ignored');
  if (raw.server !== undefined && typeof raw.server !== 'boolean') errors.push('server must be true|false'); else m.server = !!raw.server;
  // contributions
  const c = raw.contributes && typeof raw.contributes === 'object' ? raw.contributes : {};
  m.contributes = { windows: [], agentTools: [], routes: !!c.routes, settings: [], themes: [] };
  if (c.windows !== undefined) {
    if (!Array.isArray(c.windows)) errors.push('contributes.windows must be an array');
    else c.windows.forEach((w, i) => {
      if (!w || typeof w !== 'object') return errors.push(`contributes.windows[${i}] must be an object`);
      if (typeof w.id !== 'string' || !SLUG_RE.test(w.id)) errors.push(`contributes.windows[${i}].id must be a slug`);
      if (typeof w.title !== 'string' || !w.title.trim()) errors.push(`contributes.windows[${i}].title required`);
      if (!safeRelPath(w.entry) || !/\.html?$/i.test(w.entry)) errors.push(`contributes.windows[${i}].entry must be a relative .html path inside ui/`);
      if (m.client === 'none') errors.push(`contributes.windows[${i}] needs client: "iframe" (or "module")`);
      m.contributes.windows.push({ id: String(w.id), title: cleanText(w.title, 80), entry: String(w.entry || ''), singleton: w.singleton !== false });
    });
  }
  if (c.agentTools !== undefined) {
    if (!Array.isArray(c.agentTools)) errors.push('contributes.agentTools must be an array');
    else c.agentTools.forEach((t, i) => {
      if (!t || typeof t !== 'object') return errors.push(`contributes.agentTools[${i}] must be an object`);
      if (typeof t.name !== 'string' || !SLUG_RE.test(t.name)) errors.push(`contributes.agentTools[${i}].name must be a slug`);
      if (typeof t.description !== 'string' || !t.description.trim()) errors.push(`contributes.agentTools[${i}].description required (agents read it)`);
      if (t.args !== undefined && (typeof t.args !== 'object' || Array.isArray(t.args))) errors.push(`contributes.agentTools[${i}].args must be a JSON-schema object`);
      if (!m.server) errors.push(`contributes.agentTools[${i}] needs server: true (the tool runs in the plugin's process)`);
      m.contributes.agentTools.push({ name: String(t.name), description: cleanText(t.description, 400), args: t.args && typeof t.args === 'object' ? t.args : { type: 'object', properties: {} } });
    });
  }
  if (m.contributes.routes && !m.server) errors.push('contributes.routes needs server: true');
  if (c.settings !== undefined) {
    if (!Array.isArray(c.settings)) errors.push('contributes.settings must be an array of { key, type, default, label }');
    else if (c.settings.length > 50) errors.push('contributes.settings: at most 50 entries');
    else {
      const seen = new Set();
      c.settings.forEach((s, i) => {
        const at = `contributes.settings[${i}]`;
        if (!s || typeof s !== 'object') return errors.push(`${at} must be an object`);
        if (typeof s.key !== 'string' || !KEY_RE.test(s.key) || s.key.length > 40) return errors.push(`${at}.key must be a short identifier (letters, digits, _ -)`);
        if (seen.has(s.key)) return errors.push(`${at}.key "${s.key}" is duplicated`);
        seen.add(s.key);
        if (!SETTING_TYPES.includes(s.type)) return errors.push(`${at}.type must be one of ${SETTING_TYPES.join('|')}`);
        if (typeof s.label !== 'string' || !s.label.trim()) return errors.push(`${at}.label required`);
        const out = { key: s.key, type: s.type, label: cleanText(s.label, 80), description: cleanText(s.description, 300) };
        if (s.type === 'boolean') { if (typeof s.default !== 'boolean') return errors.push(`${at}.default must be true|false`); out.default = s.default; }
        else if (s.type === 'number') {
          if (typeof s.default !== 'number' || !Number.isFinite(s.default)) return errors.push(`${at}.default must be a number`);
          out.default = s.default;
          for (const k of ['min', 'max', 'step']) if (s[k] !== undefined) { if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) return errors.push(`${at}.${k} must be a number`); out[k] = s[k]; }
        } else if (s.type === 'string') { if (s.default !== undefined && typeof s.default !== 'string') return errors.push(`${at}.default must be a string`); out.default = typeof s.default === 'string' ? s.default.slice(0, 2000) : ''; }
        else if (s.type === 'select') {
          if (!Array.isArray(s.options) || !s.options.length || s.options.length > MAX_LIST) return errors.push(`${at}.options must be a non-empty array (≤ ${MAX_LIST}) of "value" or { value, label }`);
          const options = [];
          for (const o of s.options) {
            if (typeof o === 'string') options.push({ value: o, label: o });
            else if (o && typeof o === 'object' && typeof o.value === 'string') options.push({ value: o.value, label: typeof o.label === 'string' && o.label ? o.label.slice(0, 80) : o.value });
            else return errors.push(`${at}.options entries must be strings or { value, label }`);
          }
          if (typeof s.default !== 'string' || !options.some((o) => o.value === s.default)) return errors.push(`${at}.default must be one of its options`);
          out.default = s.default; out.options = options;
        }
        m.contributes.settings.push(out);
      });
    }
  }
  if (c.themes !== undefined) {
    if (!Array.isArray(c.themes)) errors.push('contributes.themes must be an array of { id, label, file }');
    else if (c.themes.length > 16) errors.push('contributes.themes: at most 16 entries');
    else {
      const seen = new Set();
      c.themes.forEach((th, i) => {
        const at = `contributes.themes[${i}]`;
        if (!th || typeof th !== 'object') return errors.push(`${at} must be an object`);
        if (typeof th.id !== 'string' || !SLUG_RE.test(th.id) || th.id.length > 40) return errors.push(`${at}.id must be a slug`);
        if (seen.has(th.id)) return errors.push(`${at}.id "${th.id}" is duplicated`);
        seen.add(th.id);
        if (typeof th.label !== 'string' || !th.label.trim()) return errors.push(`${at}.label required`);
        if (!safeRelPath(th.file) || !/\.json$/i.test(th.file)) return errors.push(`${at}.file must be a relative .json path inside the plugin dir`);
        m.contributes.themes.push({ id: th.id, label: cleanText(th.label, 40), file: th.file });
      });
    }
  }
  for (const k of Object.keys(c)) if (RESERVED_CONTRIBUTIONS.includes(k)) warnings.push(`contributes.${k} is reserved for a later phase — ignored`);
  // capabilities — normalized + validated; enforced by the loader (node --permission)
  const cap = raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities) ? raw.capabilities : {};
  m.capabilities = { server: { fs: { read: [], write: [] }, childProcess: false, net: [] } };
  const srv = cap.server && typeof cap.server === 'object' ? cap.server : {};
  const fsDecl = srv.fs && typeof srv.fs === 'object' ? srv.fs : {};
  for (const mode of ['read', 'write']) {
    const list = fsDecl[mode];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { errors.push(`capabilities.server.fs.${mode} must be an array of paths`); continue; }
    if (list.length > MAX_LIST) { errors.push(`capabilities.server.fs.${mode}: at most ${MAX_LIST} paths`); continue; }
    list.forEach((p, i) => {
      const r = normalizeFsPath(p, { homeDir, forbiddenRoots });
      if (r.error) errors.push(`capabilities.server.fs.${mode}[${i}] ${r.error}`);
      else if (!m.capabilities.server.fs[mode].includes(r.path)) m.capabilities.server.fs[mode].push(r.path);
    });
  }
  if (srv.childProcess !== undefined) { if (typeof srv.childProcess !== 'boolean') errors.push('capabilities.server.childProcess must be true|false'); else m.capabilities.server.childProcess = srv.childProcess; }
  if (Array.isArray(srv.spawn) && srv.spawn.length) { m.capabilities.server.childProcess = true; warnings.push('capabilities.server.spawn is treated as childProcess: true (spawn lists are not enforced per command)'); }
  if (srv.net !== undefined) {
    if (!Array.isArray(srv.net)) errors.push('capabilities.server.net must be an array of hosts');
    else if (srv.net.length > MAX_LIST) errors.push(`capabilities.server.net: at most ${MAX_LIST} hosts`);
    else srv.net.forEach((h, i) => {
      const host = typeof h === 'string' ? h.trim() : (h && typeof h === 'object' && typeof h.host === 'string' ? h.host.trim() : '');
      if (!host || host.length > 200 || /[\s"'<>]/.test(host)) errors.push(`capabilities.server.net[${i}] must be a host name (or { host })`);
      else if (!m.capabilities.server.net.includes(host)) m.capabilities.server.net.push(host);
    });
  }
  if ((m.capabilities.server.fs.read.length || m.capabilities.server.fs.write.length || m.capabilities.server.childProcess || m.capabilities.server.net.length) && !m.server) warnings.push('capabilities.server declared but server: false — nothing runs server-side, so they grant nothing');
  if (cap.client !== undefined && cap.client !== m.client) warnings.push(`capabilities.client "${cap.client}" ignored — the client tier is the manifest's "client" field (${m.client})`);
  return { ok: errors.length === 0, errors, warnings, manifest: errors.length ? null : m };
}

/** True when the manifest declares server-side power beyond the loader's
 *  implicit sandbox (plugin dir + data dir). */
function hasDeclaredCapabilities(m) {
  const s = m?.capabilities?.server || {};
  return !!(s.fs?.read?.length || s.fs?.write?.length || s.childProcess || s.net?.length);
}
/** Contributed agent tools are a CAPABILITY, not a convenience (2.369.43):
 *  each one becomes an executable `data/bin/vibespace-tool-<id>-<name>` on
 *  every session's PATH — local, on every ssh host and on every paired device —
 *  running OUTSIDE the plugin's `node --permission` sandbox with the session's
 *  token in its env. That is a bigger grant than the sandboxed process itself,
 *  so it goes through the consent dialog like the other declared powers. */
function contributesAgentTools(m) { return !!(m?.contributes?.agentTools?.length); }
/** True when enabling this plugin must go through the consent dialog: a
 *  trusted (same-origin) client module, any server-side power beyond the
 *  loader's implicit sandbox, or contributed agent tools. */
function needsConsent(m) { return !!m && (m.client === 'module' || hasDeclaredCapabilities(m) || contributesAgentTools(m)); }

/**
 * Plain-words capability list for the consent dialog — the SAME items on the
 * server (409 payload, tests) and the client (dialog). Each item is
 * { id, text, params }: `text` is the English sentence with {param} slots so
 * the client can hand it to t(text, params) verbatim; `id` lets tests and the
 * client branch without string matching.
 */
function capabilitySummary(m) {
  const items = [];
  if (!m) return items;
  const s = m.capabilities?.server || {};
  if (m.client === 'module') items.push({ id: 'client-module', text: 'Trusted client code: runs in this page with the same access as VibeSpace itself — it can read everything this page can, including your session, and act as you. Equivalent to adding code to VibeSpace.', params: {} });
  else if (m.client === 'iframe') items.push({ id: 'client-iframe', text: 'Sandboxed UI: its windows run in an isolated origin and cannot read this page.', params: {} });
  if (m.server) items.push({ id: 'server-process', text: 'Runs its own server process, confined to its plugin folder and its data folder.', params: {} });
  if (s.fs?.read?.length) items.push({ id: 'fs-read', text: 'Server: read files under {paths}', params: { paths: s.fs.read.join(', ') } });
  if (s.fs?.write?.length) items.push({ id: 'fs-write', text: 'Server: write AND read files under {paths}', params: { paths: s.fs.write.join(', ') } }); // write implies read in the permission args — the summary must say so
  if (s.childProcess) items.push({ id: 'child-process', text: 'Server: run other programs (child processes) — those programs are NOT confined and can reach anything the server user can.', params: {} });
  if (s.net?.length) items.push({ id: 'net', text: 'Server: network access to {hosts} — declared only; the sandbox does not restrict network access.', params: { hosts: s.net.join(', ') } });
  const tools = (m.contributes?.agentTools || []).map((t) => t.name);
  if (tools.length) items.push({ id: 'agent-tools', text: 'Adds agent tools every session can call: {names} — installed as programs on every session\'s PATH (this machine, ssh hosts and paired devices) and run OUTSIDE the plugin sandbox.', params: { names: tools.join(', ') } });
  if (!items.length) items.push({ id: 'none', text: 'No special capabilities declared.', params: {} });
  return items;
}

// Deterministic JSON with sorted keys — the hash must not depend on manifest key order.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
/** Change-detection fingerprint of everything consent covers (tiers,
 *  capabilities, agent tools, routes). A manifest that later grows a
 *  capability hashes differently ⇒ the loader disables it and re-prompts.
 *  Not a security primitive — a collision merely skips a re-prompt. */
function capabilitiesHash(m) {
  if (!m) return null;
  const subject = canonical({
    client: m.client || 'none', server: !!m.server, capabilities: m.capabilities || {},
    agentTools: (m.contributes?.agentTools || []).map((t) => t.name).sort(), routes: !!m.contributes?.routes,
  });
  return fnv1a(subject, 0x811c9dc5) + fnv1a(subject.split('').reverse().join(''), 0x9747b28c);
}

module.exports = { validateManifest, compareVersions, safeRelPath, normalizeFsPath, cleanText, hasDeclaredCapabilities, contributesAgentTools, needsConsent, capabilitySummary, capabilitiesHash, ID_RE, CLIENT_TIERS, SETTING_TYPES };
