#!/usr/bin/env node
// THE READ-ONLY PERMISSION-RULE VIEW + the human-triggered LOCAL ORACLES
// (owner rulings 10 and 6 of docs/design-harness-features.md §5.1).
//
//   Part 1 — the PURE model + the DOM-free tree renderer: per-harness fixtures
//            taken from REAL responses (a `codex config/read` on this machine,
//            an OpenCode v1 `/config`, a real claude settings hierarchy), the
//            HONEST empty states, and the XSS rule proved with a marker
//            escaper (every harness-controlled string leaves through it).
//   Part 2 — the SERVER reader against real files and a fake live session:
//            routing by the caps row (never a backend id), the wrapper-advert
//            skew gate, the typed refusal codes, and the oracle runner's
//            "callers cannot supply argv" property.
//   Part 3 — headless chrome at 375×667 (SKIPs without chrome): the real
//            Manage Agents door → the real modal → the real tree, measured for
//            overflow and tap-target size, plus the oracle modal.
//
// READ-ONLY is asserted structurally, not promised: no write verb exists on
// the adapters, no route mutates, and the wrapper never sends codex's write
// twins (`config/value/write` / `config/batchWrite`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let passed = 0, failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.error('  ✗ ' + name + (extra ? '\n    ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PR = require(path.join(REPO, 'src/permission-rules.js'));
const { capsOf, BACKEND_CAPS } = require(path.join(REPO, 'src/backend-caps.js'));
const ORACLES_MOD = require(path.join(REPO, 'src/local-oracles.js'));

console.log('— Part 1: the PURE model + renderer');

// ── claude: WHERE the settings hierarchy lives ──
{
  const L = PR.claudeSettingsPaths({ cwd: '/w/proj', home: '/h', platform: 'linux' });
  check('claude layers resolve in the CLI\'s own order, least→most authoritative',
    L.map((x) => x.id).join(',') === 'userSettings,projectSettings,localSettings,policySettings', L.map((x) => x.id).join(','));
  check('claude layer labels are the CLI\'s OWN words (2.1.257 `sZe()`)',
    L.find((x) => x.id === 'policySettings').label === 'enterprise managed settings' && L.find((x) => x.id === 'localSettings').label === 'project local settings');
  check('claude paths: user=~/.claude/settings.json, project=<cwd>/.claude/settings.json, local=<cwd>/.claude/settings.local.json',
    L[0].file === '/h/.claude/settings.json' && L[1].file === '/w/proj/.claude/settings.json' && L[2].file === '/w/proj/.claude/settings.local.json', JSON.stringify(L.map((x) => x.file)));
  check('managed layer = /etc/claude-code/managed-settings.json + its managed-settings.d drop-in dir (linux; binary `hu()`/`getDropInDir`)',
    L[3].file === '/etc/claude-code/managed-settings.json' && L[3].dropInDir === '/etc/claude-code/managed-settings.d');
  const mac = PR.claudeSettingsPaths({ cwd: '', home: '/Users/x', platform: 'darwin' });
  check('darwin managed dir is "/Library/Application Support/ClaudeCode" (per-platform, from the binary)',
    mac.find((x) => x.id === 'policySettings').file === '/Library/Application Support/ClaudeCode/managed-settings.json');
  check('NO cwd (instance scope) ⇒ the project/local layers do not exist at all — never invented paths',
    mac.map((x) => x.id).join(',') === 'userSettings,policySettings');
  const noFlag = PR.claudeSettingsPaths({ cwd: '/w', home: '/h' });
  const withFlag = PR.claudeSettingsPaths({ cwd: '/w', home: '/h', flagSettings: '/tmp/s.json' });
  check('the --settings (flag) layer is reported ONLY when the caller knows there was one',
    !noFlag.some((x) => x.id === 'flagSettings') && withFlag.find((x) => x.id === 'flagSettings')?.file === '/tmp/s.json');
  const noHome = PR.claudeSettingsPaths({ cwd: '/w', home: '' });
  check('an unknown HOME drops the user layer instead of pointing at "/.claude/settings.json"',
    !noHome.some((x) => x.id === 'userSettings'));
}

// ── claude: settings blob → rules ──
{
  const g = PR.claudeRulesFromSettings({ permissions: { allow: ['Bash(git *)', 'Read(**)'], deny: ['Bash(curl *)'], ask: ['WebFetch'], defaultMode: 'plan', additionalDirectories: ['/a', '/b'] } });
  check('allow/deny/ask arrays become rules of their own kind', g.rules.filter((r) => r.kind === 'allow').length === 2 && g.rules.some((r) => r.kind === 'deny') && g.rules.some((r) => r.kind === 'ask'));
  check('non-list permission keys become kind "value" (defaultMode, additionalDirectories)',
    g.rules.find((r) => r.key === 'permissions.defaultMode')?.value === 'plan' && g.rules.find((r) => r.key === 'permissions.additionalDirectories')?.value === '/a, /b');
  const none = PR.claudeRulesFromSettings({ model: 'opus' });
  check('a settings file with NO permissions block is reported as such (hasPermissions=false), not as "no rules"', none.hasPermissions === false && none.rules.length === 0);
  const many = PR.claudeRulesFromSettings({ permissions: { allow: Array.from({ length: 40 }, (_, i) => 'r' + i) } }, { maxRules: 10 });
  check('the rule cap TRUNCATES and SAYS so (never a silently short list)', many.rules.length === 10 && many.truncated === true);
}
{
  const rec = PR.claudeRulesRecord([
    { layer: 'userSettings', file: '/h/.claude/settings.json', present: true, settings: { permissions: { allow: ['A'] } } },
    { layer: 'projectSettings', file: '/w/.claude/settings.json', present: false },
    { layer: 'localSettings', file: '/w/.claude/settings.local.json', present: true, error: 'not valid JSON (…)' },
    { layer: 'policySettings', file: '/etc/claude-code/managed-settings.json', present: true, settings: {}, dropIns: [{ file: '/etc/claude-code/managed-settings.d/10-org.json', settings: { permissions: { deny: ['Bash(sudo *)'] } } }] },
  ], { cwd: '/w' });
  const by = Object.fromEntries(rec.layers.map((l) => [l.id, l]));
  check('a MISSING file and an UNREADABLE file are different notes', by.projectSettings.note === 'not present' && /not valid JSON/.test(by.localSettings.note));
  check('an existing file with no permissions block says "no permissions block"', by.policySettings.note === 'no permissions block');
  check('each managed drop-in is its OWN source with its OWN path (copy-path must point at the right file)',
    by['policySettings:drop-in']?.file === '/etc/claude-code/managed-settings.d/10-org.json' && by['policySettings:drop-in'].rules[0].value === 'Bash(sudo *)');
}

// ── codex: config/read layers + origins (fixture from a REAL 0.153.4 response) ──
const CODEX_FIXTURE = {
  config: {
    approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access',
    sandbox_workspace_write: null, permissions: null, default_permissions: null, include_permissions_instructions: true,
    projects: { '/w/proj': { trust_level: 'trusted' }, '/somebody/else': { trust_level: 'trusted' } },
  },
  origins: {
    approval_policy: { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    approvals_reviewer: { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    sandbox_mode: { name: { type: 'sessionFlags' }, version: '' },
    include_permissions_instructions: { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'sha256:bb' },
    'projects./w/proj.trust_level': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    'projects./somebody/else.trust_level': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
  },
  layers: [
    { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'sha256:bb' },
  ],
};
{
  const rec = PR.codexRulesRecord(CODEX_FIXTURE, { cwd: '/w/proj' });
  const by = Object.fromEntries(rec.layers.map((l) => [l.id, l]));
  check('codex: each key is attributed to the layer `origins` says WON it', by.user.rules.some((r) => r.key === 'approval_policy' && r.value === 'never'));
  check('codex: the `sessionFlags` layer exists, has NO file, and owns the key it won — the whole reason the SESSION rung exists',
    by.sessionFlags && by.sessionFlags.file === null && by.sessionFlags.rules.some((r) => r.key === 'sandbox_mode'));
  check('codex: a layer that contributed NOTHING still appears (an empty /etc/codex/config.toml is a real, useful fact)',
    !!by.system && by.system.file === '/etc/codex/config.toml');
  check('codex: only the SESSION\'s own directory trust level travels — never the whole projects table (a real store had 378 origin keys)',
    rec.layers.flatMap((l) => l.rules).filter((r) => /^projects\./.test(r.key)).length === 1
    && rec.layers.flatMap((l) => l.rules).some((r) => r.key === 'projects./w/proj.trust_level' && r.value === 'trusted'));
  check('codex: a null config value is NOT reported as a rule ("not set" is the layer\'s business)',
    !rec.layers.flatMap((l) => l.rules).some((r) => r.key === 'sandbox_workspace_write'));
  const noCwd = PR.codexRulesRecord(CODEX_FIXTURE, { cwd: null, scope: 'instance' });
  check('codex instance scope reports no per-directory trust level at all', !noCwd.layers.flatMap((l) => l.rules).some((r) => /^projects\./.test(r.key)));
  const unknown = PR.codexRulesRecord({ config: { approval_policy: 'on-request' }, origins: { approval_policy: { name: { type: 'quantumLayer' } } }, layers: [] }, {});
  check('an UNKNOWN codex layer type is named, never dropped (upstream adds variants)', unknown.layers[0].label.includes('quantumLayer'));
  check('every ConfigLayerSource variant in the 0.153.4 schema has a label',
    ['packagedDefaults', 'mdm', 'system', 'enterpriseManaged', 'user', 'project', 'sessionFlags', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm']
      .every((t) => !PR.codexLayerLabel({ type: t }).label.startsWith('unknown layer')));
  check('codex with no config at all = an HONEST unavailable record, not an empty tree',
    PR.codexRulesRecord({}, {}).ok === false && PR.codexRulesRecord({}, {}).reason === 'no-config');
}

// ── opencode: the v1 /config permission block (fixture = a REAL 1.18.29 body) ──
{
  const rec = PR.opencodeRulesRecord({
    $schema: 'https://opencode.ai/config.json',
    permission: { edit: 'allow', bash: { 'git push*': 'deny', 'rm -rf*': 'deny', '*': 'ask' }, external_directory: 'deny', webfetch: 'ask' },
  });
  const rules = rec.layers[0].rules;
  check('opencode: a tool→action entry becomes one rule of that action', rules.some((r) => r.key === 'permission.edit' && r.kind === 'allow'));
  check('opencode: a tool→{pattern:action} map becomes one rule PER PATTERN, pattern in the key',
    rules.filter((r) => r.key.startsWith('permission.bash[')).length === 3 && rules.some((r) => r.key === 'permission.bash[git push*]' && r.kind === 'deny'));
  check('opencode: ONE layer, and its note says the serve reports no per-key origin (never a fake file attribution)',
    rec.layers.length === 1 && rec.layers[0].file === null && /does not say which file/.test(rec.layers[0].note));
  const whole = PR.opencodeRulesRecord({ permission: 'ask' });
  check('opencode: the whole-agent string form is a rule too', whole.layers[0].rules[0].key === 'permission' && whole.layers[0].rules[0].kind === 'ask');
  const bare = PR.opencodeRulesRecord({ $schema: 'x' });
  check('opencode with NO permission block says what that means (its own defaults decide), and is still ok:true',
    bare.ok === true && bare.layers[0].rules.length === 0 && /no permission block/.test(bare.layers[0].note));
}

// ── honest empty states ──
{
  for (const r of PR.UNAVAILABLE_REASONS) {
    const rec = PR.unavailable('claude', r, 'because');
    if (rec.reason !== r || rec.ok !== false || rec.layers.length !== 0) { check(`unavailable(${r}) is well-formed`, false); break; }
  }
  check('every declared reason code produces a well-formed unavailable record', true);
  check('an unavailable record NEVER carries layers (an empty tree would read as "no rules")', PR.unavailable('codex', 'wrapper-old', 'x').layers.length === 0);
}

// ── the DOM-free renderer + the XSS rule (marker escaper) ──
{
  const MARK = (s) => '⟦' + String(s == null ? '' : s) + '⟧';
  const evil = '<img src=x onerror=alert(1)>';
  const rec = PR.claudeRulesRecord([{ layer: 'userSettings', file: '/h/' + evil + '/settings.json', present: true, settings: { permissions: { allow: [evil], defaultMode: evil } } }], { cwd: '/w' });
  const html = PR.renderRuleTree(rec, { esc: MARK, t: (s) => s, icons: { copy: '<svg/>' } });
  // A MARKER escaper does not neutralise anything — it PROVES routing: strip
  // everything that went through it and nothing model-controlled may remain.
  // (Asserting `!html.includes(evil)` would be wrong here and would pass for
  // the WRONG reason with a real escaper: it must fail loudly if a value is
  // ever interpolated raw, whatever the escaper does.)
  const outsideMarkers = html.replace(/⟦[\s\S]*?⟧/g, '·');
  check('renderRuleTree: EVERY harness-controlled string leaves through the injected escaper (rule text, key, path)',
    !/onerror|<img/.test(outsideMarkers)                    // nothing model-controlled outside a marker
    && html.split(MARK(evil)).length - 1 === 2              // both rule VALUES went through it
    && html.includes(MARK('/h/' + evil + '/settings.json')), outsideMarkers.slice(0, 240));
  check('renderRuleTree: the injected icon is the ONLY raw html', (html.match(/<svg\/>/g) || []).length === 1);
  const un = PR.renderRuleTree(PR.unavailable('opencode', 'store-unavailable', evil), { esc: MARK, t: (s) => s });
  check('an unavailable record renders its DETAIL (escaped) and carries the reason code for the UI to branch on',
    un.includes(MARK(evil)) && un.includes('data-reason="' + MARK('store-unavailable') + '"'));
  const real = PR.renderRuleTree(rec, { esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), t: (s) => s });
  check('copy-path rides data-copy on a BUTTON (never a link, never an href), and is escaped there too',
    /<button [^>]*class="perm-layer-path" data-copy="[^"]*&lt;img/.test(real), real.slice(real.indexOf('perm-layer-path') - 40, real.indexOf('perm-layer-path') + 160));
  check('allow/deny/ask badges are the HARNESS\'s own words, NOT translated (they appear verbatim in the user\'s own settings file)',
    PR.renderRuleTree(rec, { esc: (s) => String(s), t: () => 'TRANSLATED' }).includes('>allow<'));
  check('the tree offers NO edit control of any kind (ruling 10 is read-only)',
    !/<input|<select|<textarea|contenteditable|data-edit/i.test(real));
}
{
  check('ruleTreeSummary: counts the sources that CONTRIBUTED and every rule',
    PR.ruleTreeSummary(PR.codexRulesRecord(CODEX_FIXTURE, { cwd: '/w/proj' }), { t: (s, p) => s.replace('{layers}', p.layers).replace('{rules}', p.rules) }) === '3 source(s) · 5 rule(s)',
    PR.ruleTreeSummary(PR.codexRulesRecord(CODEX_FIXTURE, { cwd: '/w/proj' }), { t: (s, p) => s.replace('{layers}', p.layers).replace('{rules}', p.rules) }));
  check('ruleTreeSummary on an unavailable record shows the DETAIL, not a count', PR.ruleTreeSummary(PR.unavailable('claude', 'remote-session', 'lives on h1'), {}) === 'lives on h1');
}

// ── the caps row is the ONE gate (never a backend id) ──
{
  check('the source vocabulary is closed and every declared harness source is in it',
    Object.values(BACKEND_CAPS).every((r) => r.permissionRules.source === null || PR.PERMISSION_RULE_SOURCES.includes(r.permissionRules.source)),
    JSON.stringify(Object.fromEntries(Object.entries(BACKEND_CAPS).map(([k, v]) => [k, v.permissionRules.source]))));
  check('shell declares NO rule surface (no agent ⇒ no rules, and the section is never drawn)', capsOf('shell').permissionRules.source === null);
  check('opencode declares instance-only (its serve reports ONE resolved config with no per-key origin)',
    capsOf('opencode').permissionRules.instance === true && capsOf('opencode').permissionRules.session === false);
  check('codex is the only harness whose session rung needs the RUNNING wrapper (liveVerb)',
    capsOf('codex').permissionRules.liveVerb === true && capsOf('claude').permissionRules.liveVerb === false && capsOf('opencode').permissionRules.liveVerb === false);
  const unknown = capsOf('gemini-that-does-not-exist').permissionRules;
  check('an unknown backend gets the all-false row (chrome shows nothing it cannot do)', unknown.source === null && unknown.session === false && unknown.instance === false);
}

// ── READ-ONLY, structurally ──
{
  const wrapper = fs.readFileSync(path.join(REPO, 'data/bin/codex-chat-wrapper.js'), 'utf8');
  // the CONSTRUCTION, not the word: the module comments name the write twins
  // deliberately (so the next reader knows they exist and why they are not
  // used), so the assert is that no `request(...)` ever carries one.
  check('the codex wrapper NEVER sends codex\'s config WRITE twins (§4.5: expectedVersion turns a careless write into data loss)',
    !/request\(\s*'config\/(value\/write|batchWrite)'/.test(wrapper) && /request\(\s*'config\/read'/.test(wrapper));
  check('the codex wrapper serves the read verb and asks for layers+origins',
    /'read-permission-rules'/.test(wrapper) && /request\('config\/read', \{ cwd: cwd \|\| null, includeLayers: true \}/.test(wrapper));
  const acp = fs.readFileSync(path.join(REPO, 'data/bin/acp-wrapper.js'), 'utf8');
  check('BOTH wrappers serve the new stdin verb in the SAME batch (design §6 landing discipline)', /case 'read-permission-rules'/.test(acp));
  check('the ACP wrapper answers with a TYPED refusal (ACP v1 has no config-read method), never silence',
    /reason: 'unsupported-by-protocol'/.test(acp));
  check('the ACP wrapper\'s unknown-verb path NAMES the new verb (data/bin/acp-wrapper.js is the loud template)',
    /Unknown stdin verb[\s\S]{0,240}read-permission-rules/.test(acp));
  const routes = fs.readFileSync(path.join(REPO, 'src/server/permission-rules.js'), 'utf8');
  check('the server module registers exactly ONE GET (the read) and ONE POST (the human-triggered oracle) — no write route',
    (routes.match(/app\.(get|post|put|patch|delete)\(/g) || []).join(',') === 'app.get(,app.post(');
  const pure = fs.readFileSync(path.join(REPO, 'src/permission-rules.js'), 'utf8');
  check('the PURE module imports nothing at all (PURE tier)', !/require\(|^import /m.test(pure));
}

console.log('— Part 2: the server reader + the oracle runner');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-permrules-'));
const HOME = path.join(TMP, 'home'), PROJ = path.join(TMP, 'proj');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'], defaultMode: 'acceptEdits' } }));
fs.writeFileSync(path.join(PROJ, '.claude/settings.json'), JSON.stringify({ permissions: { ask: ['WebFetch'] } }));
fs.writeFileSync(path.join(PROJ, '.claude/settings.local.json'), '{ this is not json');

const activeSessions = new Map();
const written = [];
const mkModule = (over = {}) => require(path.join(REPO, 'src/server/permission-rules.js')).create({
  activeSessions,
  adapterRegistry: require(path.join(REPO, 'src/adapters/index.js')).createAdapterRegistry({ claudeCmd: 'claude', codexCmd: 'codex', codexSandboxSupported: true, chatWrapper: '/w/c', codexChatWrapper: '/w/x', acpWrapper: '/w/a', acpCommands: {}, ptyWrapper: '/w/p', buffersDir: TMP }),
  accounts: null, agentEnv: () => ({ PATH: process.env.PATH }), buffersDir: TMP, codexCmdRef: () => null,
  ...over,
});
const mod = mkModule();

{
  const rec = await mod.readClaudeRules({ cwd: PROJ, home: HOME });
  const by = Object.fromEntries(rec.layers.map((l) => [l.id, l]));
  check('claude reader: real files on disk → the real hierarchy (user + project + local + managed)', rec.ok && rec.layers.length === 4);
  check('claude reader: rules come from the FILES, never from prose', by.userSettings.rules.some((r) => r.value === 'Bash(git status)' && r.kind === 'allow'));
  check('claude reader: an UNPARSEABLE settings file says so verbatim (the CLI ignores it — the user must know)',
    /not valid JSON/.test(by.localSettings.note || ''), by.localSettings.note);
  const inst = await mod.readClaudeRules({ cwd: '', home: HOME, scope: 'instance' });
  check('claude reader: instance scope has no project/local layers at all', !inst.layers.some((l) => l.id === 'projectSettings' || l.id === 'localSettings'));
}
{
  const big = path.join(TMP, 'big'); fs.mkdirSync(path.join(big, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(big, '.claude/settings.json'), 'x'.repeat((1 << 20) + 10));
  const rec = await mod.readClaudeRules({ cwd: big, home: HOME });
  const l = rec.layers.find((x) => x.id === 'projectSettings');
  check('claude reader: an absurdly large "settings file" is refused with its size, not read into the server (the byte-cap law)', /too large to be a settings file/.test(l.note || ''), l.note);
}
{
  const r1 = await mod.read({ backend: 'shell', scope: 'session' });
  check('routing: a harness with source:null answers unsupported-harness (shell)', r1.ok === false && r1.reason === 'unsupported-harness');
  const r2 = await mod.read({ backend: 'claude', scope: 'session', host: 'h1', cwd: '/x' });
  check('routing: a REMOTE session says the rules live on that machine (never this machine\'s files under a remote label)',
    r2.ok === false && r2.reason === 'remote-session' && /h1/.test(r2.detail));
  const r3 = await mod.read({ backend: 'opencode', scope: 'session' });
  check('routing: opencode refuses the SESSION scope with the honest reason (it reports one machine-wide resolved config)',
    r3.ok === false && r3.reason === 'unsupported-harness' && /whole machine/.test(r3.detail));
  const r4 = await mod.read({ backend: 'codex', scope: 'session', sessionId: 'nope' });
  check('routing: codex session scope with no live session = no-live-session (a stopped session\'s rules are not recorded anywhere)',
    r4.ok === false && r4.reason === 'no-live-session');
  const r5 = await mod.read({ backend: 'codex', scope: 'instance', cwd: '/x' });
  check('routing: codex instance scope with no codex installed = not-installed (honest, never an empty tree)',
    r5.ok === false && r5.reason === 'not-installed');
}
// the wrapper-advert SKEW gate + the live round trip
{
  const SID = 'sess-pr-1';
  activeSessions.set(SID, { backend: 'codex', mode: 'chat', cwd: PROJ, socketPath: null, pty: { write: (s) => written.push(s) } });
  fs.writeFileSync(path.join(TMP, SID + '.json'), JSON.stringify({ pid: 1, startedAt: Date.now(), caps: { frameFile: true } }));
  const old = await mod.readViaSession(SID, { timeoutMs: 300 });
  check('SKEW GATE: a running wrapper that does not ADVERT the verb is refused with a reason (never a frame it would drop silently)',
    old.ok === false && old.reason === 'wrapper-old' && written.length === 0, JSON.stringify(old).slice(0, 160));

  fs.writeFileSync(path.join(TMP, SID + '.json'), JSON.stringify({ pid: 1, startedAt: Date.now(), caps: { frameFile: true, permissionRules: true } }));
  const p = mod.readViaSession(SID, { timeoutMs: 4000 });
  await sleep(60);
  check('an adverting wrapper gets exactly ONE read frame, and it is the read verb', written.length === 1 && JSON.parse(written[0]).type === 'read-permission-rules', written[0]);
  const rid = JSON.parse(written[0]).requestId;
  check('the frame carries a requestId (the answer is correlated, never "the next record wins")', !!rid);
  mod.onWrapperRecord(SID, { type: 'permission_rules', ok: true, requestId: rid, cwd: PROJ, config: CODEX_FIXTURE.config, origins: CODEX_FIXTURE.origins, layers: CODEX_FIXTURE.layers });
  const rec = await p;
  check('the wrapper answer is SHAPED server-side into the shared record (the wrapper ships as a single file and forwards codex\'s own fields)',
    rec.ok === true && rec.backend === 'codex' && rec.layers.some((l) => l.id === 'sessionFlags'));

  written.length = 0;
  const p2 = mod.readViaSession(SID, { timeoutMs: 300 });
  const t2 = await p2;
  check('a wrapper that never answers TIMES OUT into a typed record (no hung UI, no silent failure)', t2.ok === false && t2.reason === 'read-failed' && /did not answer/.test(t2.detail));

  written.length = 0;
  const p3 = mod.readViaSession(SID, { timeoutMs: 4000 });
  await sleep(60);
  const rid3 = JSON.parse(written[0]).requestId;
  mod.onWrapperRecord(SID, { type: 'permission_rules', ok: false, requestId: rid3, reason: 'unsupported-by-protocol', detail: 'ACP v1 has no config-read method', mode: 'build', modes: ['build', 'plan'] });
  const rec3 = await p3;
  check('an ACP-style refusal maps to a DECLARED reason code and keeps the one permission fact the protocol does carry (the live mode)',
    rec3.ok === false && PR.UNAVAILABLE_REASONS.includes(rec3.reason) && rec3.mode === 'build');
  activeSessions.delete(SID);
}
// ── the local oracles ──
{
  const r = await mod.runOracle('no-such-oracle');
  check('oracle: an unknown id is refused (the registry is the ONLY source of a command)', r.ok === false && r.reason === 'unknown-oracle');
  const src = fs.readFileSync(path.join(REPO, 'src/server/permission-rules.js'), 'utf8');
  check('oracle: the runner takes NO argv from its caller — it spawns `o.argv` from the frozen registry',
    /spawn\(cmd, o\.argv\.slice\(\)/.test(src) && !/spawn\(cmd, *\(?(opts|req|body|params)/.test(src));
  check('oracle: the route is a POST (a GET would be pre-fetchable — "never on a timer" must not lose by accident)',
    /app\.post\('\/api\/local-oracle\/:id'/.test(src) && !/app\.get\('\/api\/local-oracle/.test(src));
  check('oracle: nothing in the module schedules one (no setInterval / boot call)', !/setInterval/.test(src));
  const off = mkModule({ codexCmdRef: () => null });
  const r2 = await off.runOracle('codex-login-status');
  check('oracle: with the CLI absent the answer is not-installed, never a fake success', r2.ok === false && r2.reason === 'not-installed');
  // "no command is wired for this harness" and "the CLI is not installed" are
  // DIFFERENT facts, and the second one sends the reader off to install
  // something that is already there (error-text-is-not-diagnosis, in
  // miniature). Only codex ships oracles today, so the second refusal is only
  // reachable through the pure helper — which is exactly why it is exported.
  const { resolveOracleCmd } = require(path.join(REPO, 'src/server/permission-rules.js'));
  check('oracle: a harness with NO wired command ref answers no-runner, never a false "not installed"',
    resolveOracleCmd('claude', { codex: () => '/usr/bin/codex' }).reason === 'no-runner'
    && resolveOracleCmd('codex', { codex: () => null }).reason === 'not-installed'
    && resolveOracleCmd('codex', { codex: () => '/usr/bin/codex' }).cmd === '/usr/bin/codex',
    JSON.stringify(resolveOracleCmd('claude', { codex: () => '/usr/bin/codex' })));
  check('oracle: every shipped oracle\'s backend HAS a wired command ref (a future claude oracle must add one, not inherit a lie)',
    ORACLES_MOD.ORACLES.every((o) => resolveOracleCmd(o.backend, { codex: () => '/x' }).reason !== 'no-runner'));
}
// a REAL run when codex is installed (the whole point of an oracle is that it runs)
{
  let codexPath = null;
  try { codexPath = execSync('command -v codex', { encoding: 'utf8' }).trim() || null; } catch { codexPath = null; }
  if (!codexPath) {
    console.log('  SKIP: codex is not on PATH — the live oracle run is not exercised (`command -v codex` found nothing)');
  } else {
    const live = mkModule({ codexCmdRef: () => codexPath, agentEnv: () => ({ PATH: process.env.PATH, HOME: path.join(TMP, 'oraclehome') }) });
    fs.mkdirSync(path.join(TMP, 'oraclehome'), { recursive: true });
    const r = await live.runOracle('codex-login-status');
    check('oracle (REAL run): `codex login status` answers, and BOTH streams travel — its answer is on stderr',
      r.ok === true && ((r.stdout || '') + (r.stderr || '')).toLowerCase().includes('logged in'), JSON.stringify({ exit: r.exitCode, out: (r.stdout || '').slice(0, 80), err: (r.stderr || '').slice(-120) }));
    const r2 = await live.runOracle('codex-mcp-list');
    check('oracle (REAL run): a --json oracle is parsed into typed JSON, and the modal gets an object rather than text',
      r2.ok === true && r2.json !== null && !r2.jsonError, JSON.stringify({ exit: r2.exitCode, jsonError: r2.jsonError, out: (r2.stdout || '').slice(0, 80) }));
  }
}
// the registry's own shape (the vendor-whitelist suite enforces the proofs)
{
  check('every shipped oracle declares argv + a json flag + a proof', ORACLES_MOD.ORACLES.every((o) => Array.isArray(o.argv) && o.argv.length && typeof o.json === 'boolean' && o.proof));
  check('the three candidates the design proposed are all in NOT_ORACLES (measured, rejected) and in no shipped row',
    ['claude-auth-status', 'claude-agents-list', 'codex-doctor'].every((id) => ORACLES_MOD.rejected(id) && !ORACLES_MOD.oracle(id)));
  check('no shipped oracle is a claude one — every measured claude candidate reached api.anthropic.com',
    ORACLES_MOD.ORACLES.every((o) => o.backend !== 'claude'));
  // A gate outside the gate rots (test-tool-toggles rode a stale CLI count for
  // 27 releases exactly this way).
  check('ci.mjs runs this suite', /'test-permission-rules'/.test(fs.readFileSync(path.join(REPO, 'scripts/ci.mjs'), 'utf8')));
}

console.log('— Part 3: headless chrome at 375×667');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
// The worktree server needs the checkout's node_modules. In a git WORKTREE the
// repo's own `node_modules` is itself a symlink that a caller may not have
// created — that is an environment fact, and it must SKIP with the reason
// rather than fail as "the server never answered" (the SKIP-quotes-the-failure
// rule: say what was missing, never guess).
const NODE_MODULES = path.join(REPO, 'node_modules');
const HAVE_MODULES = fs.existsSync(path.join(NODE_MODULES, 'express', 'package.json'));
if (!CHROME) {
  console.log('  SKIP: no chrome/chromium on this machine — the mobile measurement is not run');
} else if (!HAVE_MODULES) {
  console.log(`  SKIP: ${NODE_MODULES} has no installed packages (a worktree without its node_modules link) — the live-server + chrome legs are not run`);
} else {
  const PORT = 3971 + (process.pid % 20), CDP_PORT = 9371 + (process.pid % 20);
  const wt = path.join(os.tmpdir(), `vs-permrules-wt-${process.pid}`);
  const fakeHome = wt + '-home';
  // WORKTREE-ONLY (the #127 rule): never boot a server from the repo dir — its
  // data/ is PRODUCTION and would attach to live dtach sessions.
  execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
  for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
  fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
  // a real settings hierarchy under the throwaway HOME, so the tree has content
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude/settings.json'), JSON.stringify({
    permissions: {
      allow: ['Bash(git status:*)', 'Read(/a/very/long/path/that/should/ellipsize/not/overflow/**)', 'WebSearch'],
      deny: ['Bash(curl:*)', 'Bash(rm -rf /*)'], ask: ['WebFetch'], defaultMode: 'acceptEdits',
    },
  }));
  // The boot log is KEPT (never `stdio:'ignore'`): when this server fails to
  // come up, the log is the only thing that says why — and an unguarded
  // `fetch` after the wait loop turns that into an unhandled rejection that
  // reports nothing at all (it did, once, on a slow boot).
  const srvLog = `${wt}-server.log`;
  const logFd = fs.openSync(srvLog, 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_PASSWORD: '' }, stdio: ['ignore', logFd, logFd] });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
    '--window-size=375,667', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { }
    try { srv.kill('SIGKILL'); } catch { }
    try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
    try { fs.closeSync(logFd); } catch { }
    for (const d of [`${wt}-chrome`, fakeHome, srvLog]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  };
  process.on('exit', cleanup);
  let booted = false;
  for (let i = 0; i < 160 && !booted; i++) {   // 40s: a cold worktree server on a busy box has taken >20s
    try { await fetch(`http://127.0.0.1:${PORT}/api/home`); booted = true; } catch { await sleep(250); }
  }
  if (!booted) {
    // HEAD and tail: the MESSAGE ("Cannot find module 'x'") is the first line
    // of a boot crash and the stack is the last — a tail-only excerpt showed
    // frames without the sentence that names the cause.
    let tail = '';
    try {
      const lines = fs.readFileSync(srvLog, 'utf8').split('\n');
      tail = (lines.length > 20 ? [...lines.slice(0, 8), '  …', ...lines.slice(-12)] : lines).join('\n');
    } catch (e) { tail = `(no log: ${e.message})`; }
    check(`the worktree server booted on :${PORT}`, false, `server never answered /api/home — last log lines:\n    ${tail.replace(/\n/g, '\n    ')}`);
  }
  // the ROUTE itself, from the live worktree server (the 2.333.0 route-battery lesson)
  if (booted) {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/permission-rules?backend=claude&scope=instance`)).json();
    check('live server: GET /api/permission-rules answers a well-formed record for claude', r.ok === true && Array.isArray(r.layers) && r.layers.some((l) => l.id === 'userSettings'));
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/local-oracle/not-a-thing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('live server: POST /api/local-oracle/<unknown> is a 404 with a typed reason (never a 5xx)', bad.status === 404);
  }
  const WebSocket = require('ws');
  let target = null;
  for (let i = 0; i < 120 && !target && booted; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { }
    if (!target) await sleep(250);
  }
  if (!target) { if (booted) check('chrome exposed a CDP page target', false); }
  else {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
    await new Promise((r) => ws.on('open', r));
    let seq = 0; const pend = new Map();
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evaljs = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      return r.result?.result?.value;
    };
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 100; i++) { if (await evaljs('!!(window.app && window.app.ready)').catch(() => false)) break; await sleep(300); }
    await evaljs('window.app.ready.then(() => true)').catch(() => { });
    await sleep(900);
    // The REAL door: the shared menu block → the REAL modal → the REAL tree.
    const tree = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const items = window.app._rulesAndChecksItems('claude', {});
      const rules = items.find((i) => i.label && i.label.startsWith('Permission rules'));
      if (!rules) return { error: 'no Permission rules row: ' + JSON.stringify(items.map((i) => i.label || 'sep')) };
      rules.action();
      let el = null;
      for (let i = 0; i < 80 && !el; i++) { el = document.querySelector('.perm-rules .perm-layer'); if (!el) await sleep(150); }
      if (!el) return { error: 'tree never rendered' };
      const root = document.querySelector('.perm-rules');
      const dlg = root.closest('.modal-dialog, .modal-overlay, [id]') || document.body;
      const pathBtn = root.querySelector('.perm-layer-path[data-copy]');
      const rule = root.querySelector('.perm-rule');
      return {
        layers: root.querySelectorAll('.perm-layer').length,
        rules: root.querySelectorAll('.perm-rule').length,
        rootW: Math.round(root.getBoundingClientRect().width),
        rootScrollW: root.scrollWidth,
        rootClientW: root.clientWidth,
        pathH: pathBtn ? Math.round(pathBtn.getBoundingClientRect().height) : 0,
        pathOverflowsRight: pathBtn ? Math.round(pathBtn.getBoundingClientRect().right) - Math.round(root.getBoundingClientRect().right) : 0,
        ruleWrapped: rule ? rule.getBoundingClientRect().width <= root.getBoundingClientRect().width + 1 : false,
        docScrollW: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        editControls: root.querySelectorAll('input, select, textarea, [contenteditable]').length,
        copiable: !!pathBtn && !!pathBtn.dataset.copy,
      };
    })()`);
    check('375×667: the REAL Manage-Agents door renders the REAL tree (layers + rules present)',
      !tree.error && tree.layers >= 1 && tree.rules >= 3, JSON.stringify(tree));
    check('375×667: nothing overflows horizontally (the tree, and the page it sits in)',
      !tree.error && tree.rootScrollW <= tree.rootClientW + 1 && tree.docScrollW <= tree.inner + 1, JSON.stringify(tree));
    check('375×667: the copy-path button is a real tap target and stays inside the tree',
      !tree.error && tree.pathH >= 20 && tree.pathOverflowsRight <= 1, JSON.stringify(tree));
    check('375×667: the tree carries NO edit control (ruling 10 is read-only, in the rendered DOM too)', !tree.error && tree.editControls === 0);
    // the ORACLE modal on the same viewport
    const oracle = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelectorAll('.modal-overlay, #perm-rules-dialog').forEach((e) => e.remove());
      const items = window.app._rulesAndChecksItems('codex', {});
      const row = items.find((i) => i.label && /Login status/.test(i.label));
      if (!row) return { error: 'no oracle row: ' + JSON.stringify(items.map((i) => i.label || 'sep')) };
      row.action();
      let body = null;
      for (let i = 0; i < 80 && !body; i++) { body = document.querySelector('.oracle-output'); if (!body) await sleep(150); }
      if (!body) return { error: 'oracle modal never rendered' };
      for (let i = 0; i < 60; i++) { if (!/Running/.test(body.textContent)) break; await sleep(200); }
      const pre = body.querySelector('.oracle-body');
      return {
        text: body.textContent.slice(0, 120),
        preScrollW: pre ? pre.scrollWidth : 0, preClientW: pre ? pre.clientWidth : 0,
        docScrollW: document.documentElement.scrollWidth, inner: window.innerWidth,
        hasNote: !!document.querySelector('#local-oracle-dialog .agents-note, .agents-note'),
      };
    })()`);
    check('375×667: the oracle modal renders and says something honest (output, or the reason it could not run)',
      !oracle.error && !!oracle.text && !/Running/.test(oracle.text), JSON.stringify(oracle));
    check('375×667: the oracle output wraps instead of scrolling the page sideways',
      !oracle.error && oracle.preScrollW <= oracle.preClientW + 1 && oracle.docScrollW <= oracle.inner + 1, JSON.stringify(oracle));

    // ── THE SECOND SURFACE: Session Properties, through the REAL door ──
    // `app.openSessionProps(sessionObject)` is the method every card/menu/chat
    // header calls. A structural grep would have passed for a section that
    // never renders (the 2.355.0 unstaged-wiring class), so this drives the
    // real window and CLICKS the real button. Windows are closed by the ids
    // this eval created — never by a heuristic match (the shared-browser law).
    const props = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelectorAll('.modal-overlay, #perm-rules-dialog, #local-oracle-dialog').forEach((e) => e.remove());
      const mk = (backend) => ({ sessionId: 'pr-' + backend, webuiId: 'pr-' + backend, backend, mode: 'chat', cwd: '/tmp', name: 'perm-rules probe ' + backend, status: 'stopped' });
      const out = { made: [] };
      const openFor = (backend) => {
        const w = window.app.openSessionProps(mk(backend));
        if (w && w.id) out.made.push(w.id);
        return w;
      };
      const wClaude = openFor('claude');
      if (!wClaude) return { error: 'openSessionProps returned nothing for claude' };
      const root = wClaude.content.querySelector('.session-props');
      const labels = [...wClaude.content.querySelectorAll('.task-detail-label')].map((e) => e.textContent);
      out.claudeHasSection = labels.includes('Permission rules');
      const btn = [...wClaude.content.querySelectorAll('button')].find((b) => /Show rules/.test(b.textContent));
      out.hasButton = !!btn;
      out.loadedBeforeClick = !!wClaude.content.querySelector('.perm-layer');   // MUST be false: human-triggered
      if (btn) {
        btn.click();
        for (let i = 0; i < 80; i++) { if (wClaude.content.querySelector('.perm-rules .perm-layer')) break; await sleep(150); }
      }
      const tree = wClaude.content.querySelector('.perm-rules');
      out.layers = tree ? tree.querySelectorAll('.perm-layer').length : 0;
      out.rules = tree ? tree.querySelectorAll('.perm-rule').length : 0;
      out.editControls = tree ? tree.querySelectorAll('input, select, textarea, [contenteditable]').length : 0;
      out.btnRelabeled = btn ? /Reload rules/.test(btn.textContent) : false;
      out.treeScrollW = tree ? tree.scrollWidth : 0; out.treeClientW = tree ? tree.clientWidth : 0;
      out.docScrollW = document.documentElement.scrollWidth; out.inner = window.innerWidth;
      // shell: NO section at all (source:null on the caps row)
      const wShell = openFor('shell');
      out.shellHasSection = [...(wShell ? wShell.content.querySelectorAll('.task-detail-label') : [])].some((e) => e.textContent === 'Permission rules');
      // opencode: the section exists but says machine-wide, never per-session
      const wOc = openFor('opencode');
      out.ocHasSection = [...(wOc ? wOc.content.querySelectorAll('.task-detail-label') : [])].some((e) => e.textContent === 'Permission rules');
      out.ocHint = wOc ? ([...wOc.content.querySelectorAll('.agents-note')].map((e) => e.textContent).find((x) => /Read-only/.test(x)) || '') : '';
      for (const id of out.made) { try { window.app.wm.closeWindow(id); } catch (e) { } }
      return out;
    })()`);
    check('375×667: the REAL Session Properties door draws a "Permission rules" section for a claude session, with a button and NOTHING loaded until it is clicked (human-triggered)',
      !props.error && props.claudeHasSection === true && props.hasButton === true && props.loadedBeforeClick === false, JSON.stringify(props));
    check('375×667: clicking it renders the REAL tree off this machine\'s settings hierarchy, read-only, and relabels the button',
      !props.error && props.layers >= 1 && props.rules >= 3 && props.editControls === 0 && props.btnRelabeled === true, JSON.stringify(props));
    check('375×667: the Session-Properties tree does not overflow either',
      !props.error && props.treeScrollW <= props.treeClientW + 1 && props.docScrollW <= props.inner + 1, JSON.stringify(props));
    check('a SHELL session gets no section at all, and an OPENCODE one says machine-wide (the caps row gates the chrome, not a backend id)',
      !props.error && props.shellHasSection === false && props.ocHasSection === true && /machine-wide/.test(props.ocHint || ''), JSON.stringify(props));
    try { ws.close(); } catch { }
  }
  cleanup();
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
