'use strict';
/**
 * PERMISSION RULES — the PURE model + renderer for the READ-ONLY "where does
 * this rule come from" view (owner ruling 10 of docs/design-harness-features.md
 * §5.1: **(a) 只读**; the §2.14 row "权限规则面").
 *
 * Deliberately dependency-free (PURE tier, CJS pulled into the bundle like
 * src/collab-row.js and src/search-card.js): the escaper, the translator and
 * the icon set are INJECTED, so the whole surface is unit-testable in node AND
 * the XSS rule is *provable* — a test passes a marker escaper and proves that
 * every harness-controlled string (a glob out of someone's settings.json, an
 * absolute path out of a config layer) leaves through it.
 *
 * THE SHAPE EVERY HARNESS PRODUCES (typed record, never parsed prose):
 *   {
 *     backend, scope: 'session'|'instance', cwd, host,
 *     ok, reason, detail,            // reason = a CODE, detail = the words
 *     layers: [ {
 *        id,                          // the harness's OWN layer id, verbatim
 *        label,                       // the harness's OWN name for it
 *        file,                        // absolute path | null (no file layer)
 *        present,                     // did we actually find/read it
 *        note,                        // honest per-layer state (empty/unreadable)
 *        rules: [ { kind, key, value, note? } ],
 *     } ],
 *     truncated,                      // a cap was hit (never silently)
 *   }
 * `kind` is the DISPLAY class of one rule and the closed set lives here:
 *   'allow' | 'deny' | 'ask' | 'value'   ('value' = a setting that is not an
 *   allow/deny/ask rule but decides permissions, e.g. codex `approval_policy`
 *   or claude `permissions.defaultMode`).
 *
 * WHY A LAYER IS NOT A FILE: codex answers `config/read` with `origins`
 * (key → the layer that won) and `layers` (each layer's own contribution), and
 * one of those layers — `sessionFlags` — has NO file at all. claude's managed
 * layer is a directory + a drop-in dir. OpenCode reports only the RESOLVED
 * config with no origin information whatsoever. The record above can say all
 * three honestly; a "path → rules" map could not.
 *
 * READ-ONLY, ALWAYS: nothing in this module writes, and nothing downstream of
 * it offers an edit. The only ACTION a rule carries is "copy path".
 */

// ── the closed display vocabulary ──
const RULE_KINDS = Object.freeze(['allow', 'deny', 'ask', 'value']);

/** claude's settings hierarchy, in the CLI's OWN vocabulary (2.1.257 binary:
 *  `sZe()` gives the sentence form, `dvt()` the short form, `MH()` the scope
 *  hint). Ordered LEAST→MOST authoritative, which is the order the CLI resolves
 *  them in — the view prints them in this order and says which one wins.
 *  `flagSettings` (a `--settings` file/JSON on the command line) is REAL but
 *  is not a fixed path, so it is only ever reported when the caller knows the
 *  session was spawned with one. */
const CLAUDE_LAYERS = Object.freeze([
  Object.freeze({ id: 'userSettings', label: 'user settings', short: 'User', scope: 'user', rel: '.claude/settings.json', base: 'config' }),
  Object.freeze({ id: 'projectSettings', label: 'shared project settings', short: 'Project', scope: 'project', rel: '.claude/settings.json', base: 'cwd' }),
  Object.freeze({ id: 'localSettings', label: 'project local settings', short: 'Local', scope: 'project, gitignored', rel: '.claude/settings.local.json', base: 'cwd' }),
  Object.freeze({ id: 'flagSettings', label: 'command line arguments', short: 'Flag', scope: 'cli flag', rel: null, base: 'flag' }),
  Object.freeze({ id: 'policySettings', label: 'enterprise managed settings', short: 'Managed', scope: 'managed', rel: 'managed-settings.json', base: 'managed' }),
]);

/** Where claude looks for the MANAGED layer, per platform. Read out of the
 *  2.1.257 binary (`hu()`): there is no env override in this build — the
 *  function that would supply one returns undefined. `managed-settings.d/` is
 *  the drop-in directory beside it (`getDropInDir`). */
const CLAUDE_MANAGED_DIR = Object.freeze({
  linux: '/etc/claude-code',
  darwin: '/Library/Application Support/ClaudeCode',
  win32: 'C:\\Program Files\\ClaudeCode',
});
const CLAUDE_MANAGED_DROPIN = 'managed-settings.d';

/** The permission-bearing keys of a claude settings file (2.1.257: the
 *  `permissions` object's own shape). allow/deny/ask are ARRAYS OF RULES;
 *  the rest are single values that still decide what may run. */
const CLAUDE_PERMISSION_LISTS = Object.freeze(['allow', 'deny', 'ask']);
const CLAUDE_PERMISSION_VALUES = Object.freeze(['defaultMode', 'disableBypassPermissionsMode', 'additionalDirectories']);

/** The codex config keys that decide permissions (0.153.4 `config/read`
 *  response, measured against a real config). `projects.<path>.trust_level`
 *  is handled separately: it is per-directory, and only the SESSION's own
 *  directory is ever shown (a real store had 378 origin keys, hundreds of
 *  them other people's project paths). */
const CODEX_PERMISSION_KEYS = Object.freeze([
  'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write',
  'permissions', 'default_permissions', 'include_permissions_instructions',
]);

/** codex's ConfigLayerSource variants → a human label + the file (when the
 *  variant HAS one). Verbatim from the 0.153.4 schema's own descriptions. */
function codexLayerLabel(name) {
  const type = name && typeof name === 'object' ? String(name.type || '') : String(name || '');
  switch (type) {
    case 'packagedDefaults': return { label: 'packaged defaults', file: name.file || null };
    case 'mdm': return { label: `managed preferences (MDM ${name.domain || ''}${name.key ? ' / ' + name.key : ''})`.trim(), file: null };
    case 'system': return { label: 'system config', file: name.file || null };
    case 'enterpriseManaged': return { label: `enterprise-managed layer${name.name ? ' “' + name.name + '”' : ''}`, file: null };
    case 'user': return { label: name.profile ? `user config (profile “${name.profile}”)` : 'user config', file: name.file || null };
    case 'project': return { label: 'project config', file: name.dotCodexFolder || null };
    case 'sessionFlags': return { label: 'this session’s own -c flags', file: null };
    case 'legacyManagedConfigTomlFromFile': return { label: 'legacy managed_config.toml', file: name.file || null };
    case 'legacyManagedConfigTomlFromMdm': return { label: 'legacy managed_config.toml (MDM)', file: null };
    default: return { label: type ? `unknown layer “${type}”` : 'unknown layer', file: (name && name.file) || null };
  }
}

// ── path helpers (PURE: no `path` require, the separator is a parameter) ──
function joinPath(sep, ...parts) {
  const s = sep || '/';
  const out = [];
  for (const p of parts) {
    if (p == null || p === '') continue;
    out.push(String(p).replace(/[\\/]+$/, ''));
  }
  if (!out.length) return '';
  let joined = out.join(s);
  // an absolute POSIX head must keep its leading slash
  if (String(parts[0] || '').startsWith('/') && !joined.startsWith('/')) joined = '/' + joined;
  return joined.replace(new RegExp(`\\${s}{2,}`, 'g'), s === '\\' ? '\\' : s).replace(/^(\w:)\\\\/, '$1\\');
}

/**
 * WHERE claude reads its settings from, for a given session — PURE, no I/O.
 * The caller does the reading; this decides the SET and the ORDER.
 * @param {{cwd?:string, home?:string, platform?:string, configDir?:string, sep?:string, flagSettings?:string}} o
 *   configDir — CLAUDE_CONFIG_DIR when the spawn set one (VibeSpace's named
 *   accounts relocate the SECRET store with CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *   which is a DIFFERENT variable and does NOT move settings.json; passing it
 *   here would point the view at a directory that holds no settings at all).
 * @returns {Array<{id,label,short,scope,file,dir,dropInDir}>}
 */
function claudeSettingsPaths({ cwd = '', home = '', platform = 'linux', configDir = '', sep = '/', flagSettings = '' } = {}) {
  const managedDir = CLAUDE_MANAGED_DIR[platform] || CLAUDE_MANAGED_DIR.linux;
  const userDir = configDir || joinPath(sep, home, '.claude');
  const out = [];
  for (const l of CLAUDE_LAYERS) {
    if (l.base === 'flag') {
      if (!flagSettings) continue;                       // no --settings ⇒ the layer does not exist for this session
      out.push({ ...l, file: flagSettings, dir: null, dropInDir: null });
      continue;
    }
    if (l.base === 'config') {
      if (!home && !configDir) continue;                 // unknown HOME ⇒ do not invent a path
      out.push({ ...l, file: joinPath(sep, userDir, 'settings.json'), dir: userDir, dropInDir: null });
      continue;
    }
    if (l.base === 'cwd') {
      if (!cwd) continue;                                // instance scope: there is no project
      out.push({ ...l, file: joinPath(sep, cwd, l.rel), dir: joinPath(sep, cwd, '.claude'), dropInDir: null });
      continue;
    }
    out.push({ ...l, file: joinPath(sep, managedDir, 'managed-settings.json'), dir: managedDir, dropInDir: joinPath(sep, managedDir, CLAUDE_MANAGED_DROPIN) });
  }
  return out;
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** One claude settings BLOB → the rules it contributes. PURE. A file that
 *  exists but carries no `permissions` block is NOT the same as a missing
 *  file, and the note says which. */
function claudeRulesFromSettings(settings, { maxRules = 200 } = {}) {
  const rules = [];
  let truncated = false;
  const perm = isObj(settings) && isObj(settings.permissions) ? settings.permissions : null;
  if (!perm) return { rules, truncated, hasPermissions: false };
  for (const kind of CLAUDE_PERMISSION_LISTS) {
    for (const r of asArray(perm[kind])) {
      if (typeof r !== 'string' || !r) continue;
      if (rules.length >= maxRules) { truncated = true; break; }
      rules.push({ kind, key: `permissions.${kind}`, value: r });
    }
    if (truncated) break;
  }
  for (const key of CLAUDE_PERMISSION_VALUES) {
    if (!(key in perm)) continue;
    const v = perm[key];
    if (v == null) continue;
    if (rules.length >= maxRules) { truncated = true; break; }
    rules.push({ kind: 'value', key: `permissions.${key}`, value: Array.isArray(v) ? v.join(', ') : String(v) });
  }
  return { rules, truncated, hasPermissions: true };
}

/**
 * claude: the read LAYERS (each already carrying its parsed blob or its
 * failure) → the typed record. PURE — the caller did the fs work.
 * @param reads Array<{layer, file, dir, dropInDir, present, error?, settings?, dropIns?}>
 */
function claudeRulesRecord(reads, { cwd = null, host = null, scope = 'session', maxRules = 200 } = {}) {
  const layers = [];
  let truncated = false;
  for (const r of asArray(reads)) {
    const meta = CLAUDE_LAYERS.find((l) => l.id === r.layer) || { id: r.layer, label: r.layer, short: r.layer, scope: '' };
    const base = { id: meta.id, label: meta.label, short: meta.short, scope: meta.scope, file: r.file || null, present: !!r.present, note: null, rules: [] };
    if (r.error) { base.note = r.error; layers.push(base); continue; }
    if (!r.present) { base.note = 'not present'; layers.push(base); continue; }
    const got = claudeRulesFromSettings(r.settings, { maxRules });
    truncated = truncated || got.truncated;
    base.rules = got.rules;
    if (!got.hasPermissions) base.note = 'no permissions block';
    else if (!got.rules.length) base.note = 'permissions block is empty';
    // drop-in files (managed-settings.d/) are their OWN sources: each keeps its path
    for (const d of asArray(r.dropIns)) {
      const g = claudeRulesFromSettings(d.settings, { maxRules });
      truncated = truncated || g.truncated;
      layers.push({ id: meta.id + ':drop-in', label: meta.label + ' (drop-in)', short: meta.short, scope: meta.scope, file: d.file || null, present: true, note: g.hasPermissions ? (g.rules.length ? null : 'permissions block is empty') : 'no permissions block', rules: g.rules });
    }
    layers.push(base);
  }
  // report in resolution order, most authoritative LAST (matches the CLI)
  return { backend: 'claude', scope, cwd, host, ok: true, reason: null, detail: null, layers, truncated };
}

/**
 * codex: a `config/read {cwd, includeLayers:true}` response → the typed
 * record. PURE. `origins` (key → the layer that WON) is the whole point of
 * this view; `layers` gives each layer its file and version.
 * The session's OWN directory trust level is the only `projects.*` key shown —
 * a real store had 378 origin keys, most of them unrelated project paths.
 */
function codexRulesRecord(resp, { cwd = null, host = null, scope = 'session', maxRules = 200 } = {}) {
  const config = isObj(resp) && isObj(resp.config) ? resp.config : null;
  if (!config) return unavailable('codex', 'no-config', 'codex returned no config', { cwd, host, scope });
  const origins = isObj(resp.origins) ? resp.origins : {};
  const layerList = asArray(resp.layers);
  // key → layer id (the layer that WON that key)
  const layerIdOf = (name) => {
    const t = name && typeof name === 'object' ? String(name.type || '') : String(name || '');
    const prof = name && typeof name === 'object' && name.profile ? ':' + name.profile : '';
    return t + prof;
  };
  const buckets = new Map();     // layerId → {id,label,file,version,rules[]}
  const bucket = (name) => {
    const id = layerIdOf(name);
    if (!buckets.has(id)) {
      const { label, file } = codexLayerLabel(name);
      buckets.set(id, { id: id || 'unknown', label, short: label, scope: '', file: file || null, present: true, note: null, rules: [] });
    }
    return buckets.get(id);
  };
  // seed the buckets from `layers` so a layer that contributes NOTHING still
  // shows up (an empty /etc/codex/config.toml is a real, useful fact)
  for (const l of layerList) {
    if (!isObj(l)) continue;
    const b = bucket(l.name);
    if (l.version) b.version = String(l.version);
    if (l.disabledReason) b.note = String(l.disabledReason);
  }
  let truncated = false;
  const push = (key, value, kind) => {
    const origin = origins[key];
    const b = bucket(origin ? origin.name : { type: 'packagedDefaults' });
    if (b.rules.length >= maxRules) { truncated = true; return; }
    b.rules.push({ kind, key, value, note: origin ? null : 'not set in any layer — the packaged default' });
  };
  for (const key of CODEX_PERMISSION_KEYS) {
    if (!(key in config)) continue;
    const v = config[key];
    if (v == null) continue;                       // a null in codex's config = "not set"; the layer note carries that
    push(key, stringifyValue(v), 'value');
  }
  // the SESSION's own directory trust level (never the whole projects table)
  if (cwd) {
    const key = `projects.${cwd}.trust_level`;
    const trust = isObj(config.projects) && isObj(config.projects[cwd]) ? config.projects[cwd].trust_level : undefined;
    if (trust !== undefined && trust !== null) push(key, String(trust), 'value');
  }
  const layers = [...buckets.values()];
  return { backend: 'codex', scope, cwd, host, ok: true, reason: null, detail: null, layers, truncated };
}

/**
 * opencode: the v1 `GET /config` body → the typed record.
 * HONESTY NOTE, and it is the important part: OpenCode answers with the
 * RESOLVED config only — it does not say which file any value came from. So
 * this record has exactly ONE layer and its note says so, rather than
 * pretending the global config file is the origin.
 * ROUTE LAW (2.369.50, re-measured 2026-09-07 on 1.18.29): the source is the
 * v1 `/config` route. `GET /api/permission/saved` — the obvious-looking one —
 * BOOTS AN OPENCODE INSTANCE (measured: threads 15→37, inotify fds 0→2,
 * RSS 316→482 MB), so it is never called.
 */
function opencodeRulesRecord(config, { cwd = null, host = null, scope = 'instance', maxRules = 200 } = {}) {
  if (!isObj(config)) return unavailable('opencode', 'no-config', 'the OpenCode serve returned no config', { cwd, host, scope });
  const perm = config.permission;
  const rules = [];
  let truncated = false;
  const add = (key, value) => {
    if (rules.length >= maxRules) { truncated = true; return; }
    const kind = value === 'allow' || value === 'deny' || value === 'ask' ? value : 'value';
    rules.push({ kind, key, value: String(value) });
  };
  if (typeof perm === 'string') add('permission', perm);                       // the whole-agent form
  else if (isObj(perm)) {
    for (const [tool, v] of Object.entries(perm)) {
      if (typeof v === 'string') add(`permission.${tool}`, v);
      else if (isObj(v)) for (const [pattern, action] of Object.entries(v)) add(`permission.${tool}[${pattern}]`, action);
    }
  }
  const layer = {
    id: 'opencode-config', label: 'OpenCode config (resolved)', short: 'Config', scope: '',
    file: null, present: true,
    note: perm == null ? 'no permission block — OpenCode asks for everything its defaults ask for'
      : 'OpenCode reports the resolved config only — it does not say which file a value came from',
    rules,
  };
  return { backend: 'opencode', scope, cwd, host, ok: true, reason: null, detail: null, layers: [layer], truncated };
}

function stringifyValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** The HONEST empty/unavailable record. `reason` is a CODE the UI may branch
 *  on; `detail` is the sentence a human reads. Never an empty tree pretending
 *  the harness has no rules. */
function unavailable(backend, reason, detail, { cwd = null, host = null, scope = 'session' } = {}) {
  return { backend, scope, cwd, host, ok: false, reason: String(reason || 'unknown'), detail: detail ? String(detail) : null, layers: [], truncated: false };
}

/** The reason codes this module and its readers speak. A UI that branches on a
 *  code not in here is a bug, and the suite pins the set. */
const UNAVAILABLE_REASONS = Object.freeze([
  'unsupported-harness',   // the harness has no permission-rule surface at all (shell)
  'remote-session',        // the rules live on another machine and we only read local ones
  'not-installed',         // the CLI/daemon that owns the rules is not on this machine
  'store-unavailable',     // opencode: the serve is off/parked
  'wrapper-old',           // the running wrapper predates the read verb
  'no-live-session',       // codex session scope needs the session's own app-server
  // the only way to answer THIS scope was MEASURED to reach the vendor, so it
  // is not offered (§ban-safety). Distinct from 'unsupported-harness' on
  // purpose (the 2.363.1 law — one refusal type with several meanings must
  // carry a code): the harness CAN answer, we decline to ask it that way, and
  // the detail carries the measurement. src/local-oracles.js holds the proof.
  'would-connect',
  'read-failed',           // the read was attempted and failed (detail carries the words)
  'no-config',             // the harness answered, with nothing in it
  'unknown',
]);

/** The closed VOCABULARY of "where a harness's permission rules come from".
 *  WHICH harness uses which source is declared exactly once, on the caps row
 *  (src/backend-caps.js `permissionRules.source`, mirrored in
 *  src/lib/agent-meta.js and deep-compared by test-harness-contract) — not
 *  here, so there is no second table to drift.
 *    'settings-files' — a documented file hierarchy read off disk (claude)
 *    'config-read'    — the harness's own layered config RPC (codex)
 *    'serve-config'   — a local HTTP facts service (opencode's v1 /config)
 *    'acp-mode'       — the protocol carries only a live MODE, no rules
 *  A harness whose source is null has no permission-rule surface at all. */
const PERMISSION_RULE_SOURCES = Object.freeze(['settings-files', 'config-read', 'serve-config', 'acp-mode']);

// ── the DOM-free renderer ──
/**
 * renderRuleTree(record, {esc, t, icons}) → HTML string.
 * DOM-free so it is unit-testable in node and the escaping is provable. EVERY
 * harness-controlled string (rule text, key, file path, note, detail) leaves
 * through `esc`; nothing is interpolated raw. `t` translates the CHROME only —
 * rule text and paths are data and are never translated.
 */
function renderRuleTree(record, { esc, t, icons = {} } = {}) {
  const e = typeof esc === 'function' ? esc : (s) => String(s == null ? '' : s);
  const tr = typeof t === 'function' ? t : (s) => s;
  const rec = isObj(record) ? record : null;
  if (!rec) return `<div class="perm-rules-empty">${e(tr('No permission-rule data.'))}</div>`;
  if (!rec.ok) {
    return `<div class="perm-rules-empty" data-reason="${e(rec.reason || 'unknown')}">${e(rec.detail || tr('These rules are not available here.'))}</div>`;
  }
  const withRules = asArray(rec.layers).filter((l) => asArray(l.rules).length);
  if (!withRules.length && !asArray(rec.layers).length) {
    return `<div class="perm-rules-empty">${e(tr('No permission rules are configured — the agent asks about everything its own defaults ask about.'))}</div>`;
  }
  const parts = [];
  for (const l of asArray(rec.layers)) {
    const rules = asArray(l.rules);
    const head = [
      `<div class="perm-layer-head">`,
      `<span class="perm-layer-name">${e(l.label || l.id || '')}</span>`,
      l.scope ? `<span class="perm-layer-scope">${e(l.scope)}</span>` : '',
      `<span class="perm-layer-count">${e(rules.length ? tr('{n} rule(s)', { n: rules.length }) : tr('no rules'))}</span>`,
      `</div>`,
    ].join('');
    const path = l.file
      ? `<button type="button" class="perm-layer-path" data-copy="${e(l.file)}" title="${e(tr('Copy path'))}">${icons.copy || ''}<span>${e(l.file)}</span></button>`
      : `<div class="perm-layer-path perm-layer-path-none">${e(tr('no file — this layer is not stored on disk'))}</div>`;
    const note = l.note ? `<div class="perm-layer-note">${e(l.note)}</div>` : '';
    const body = rules.length
      ? `<ul class="perm-rule-list">${rules.map((r) => renderRule(r, e, tr)).join('')}</ul>`
      : '';
    parts.push(`<div class="perm-layer${l.present ? '' : ' perm-layer-absent'}" data-layer="${e(l.id || '')}">${head}${path}${note}${body}</div>`);
  }
  if (rec.truncated) parts.push(`<div class="perm-rules-note">${e(tr('The list was capped — this machine has more rules than the view shows.'))}</div>`);
  return parts.join('');
}

function renderRule(r, e, tr) {
  const kind = RULE_KINDS.includes(r && r.kind) ? r.kind : 'value';
  // allow / deny / ask are the HARNESS's OWN words — they appear verbatim in
  // the user's settings.json and config.toml, so they are PROTOCOL VALUES and
  // are never translated (i18n §16: t() is for chrome, not stored strings). A
  // user grepping their own file for "deny" must find the word they saw here.
  // 'setting' is OUR label for "a value that is not an allow/deny/ask rule",
  // so that one IS chrome.
  const KIND_LABEL = { allow: 'allow', deny: 'deny', ask: 'ask', value: tr('setting') };
  return [
    `<li class="perm-rule perm-rule-${e(kind)}">`,
    `<span class="perm-rule-kind">${e(KIND_LABEL[kind])}</span>`,
    `<span class="perm-rule-value">${e(r && r.value != null ? r.value : '')}</span>`,
    `<span class="perm-rule-key">${e(r && r.key ? r.key : '')}</span>`,
    r && r.note ? `<span class="perm-rule-note">${e(r.note)}</span>` : '',
    `</li>`,
  ].join('');
}

/** A one-line summary for the collapsed row ("3 layers · 41 rules"). PURE. */
function ruleTreeSummary(record, { t } = {}) {
  const tr = typeof t === 'function' ? t : (s) => s;
  const rec = isObj(record) ? record : null;
  if (!rec) return tr('not loaded');
  if (!rec.ok) return rec.detail || tr('not available');
  const layers = asArray(rec.layers);
  const withRules = layers.filter((l) => asArray(l.rules).length).length;
  const n = layers.reduce((a, l) => a + asArray(l.rules).length, 0);
  if (!n) return tr('no rules configured');
  return tr('{layers} source(s) · {rules} rule(s)', { layers: withRules, rules: n });
}

module.exports = {
  RULE_KINDS, CLAUDE_LAYERS, CLAUDE_MANAGED_DIR, CLAUDE_MANAGED_DROPIN,
  CLAUDE_PERMISSION_LISTS, CLAUDE_PERMISSION_VALUES, CODEX_PERMISSION_KEYS,
  PERMISSION_RULE_SOURCES, UNAVAILABLE_REASONS,
  joinPath, claudeSettingsPaths, claudeRulesFromSettings, claudeRulesRecord,
  codexLayerLabel, codexRulesRecord, opencodeRulesRecord,
  unavailable, renderRuleTree, ruleTreeSummary, stringifyValue,
};
