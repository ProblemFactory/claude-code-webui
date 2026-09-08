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
// MEASURED 2026-09-07 against `codex app-server` 0.153.4 (codex-cli 0.153.4)
// driven initialize→initialized→config/read{includeLayers:true} under an empty
// HOME with `[sandbox_workspace_write]` in config.toml and the session spawned
// `-c sandbox_workspace_write.network_access=true` (the exact form
// src/adapters/codex.js uses, and the form any user `codex.extraArgs` takes):
//   • `'sandbox_workspace_write' in origins` is FALSE — a TABLE-valued key is
//     keyed by its LEAVES (`.writable_roots.0` / `.network_access` / …)
//   • the session flag lands on the LEAF as `sessionFlags`
//   • `layers` = [sessionFlags, user, system] — there is NO packagedDefaults
//     layer in the answer, so one may never be synthesised in codex's name
//     (its schema REQUIRES a `file`).
// The whole codex SESSION rung exists to show the sessionFlags layer; asking
// only the top level left it EMPTY and filed the user's own config under a
// forged "packaged defaults" layer noted "not set in any layer".
const CODEX_FIXTURE = {
  config: {
    approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access',
    sandbox_workspace_write: { writable_roots: ['/tmp/a'], network_access: true, exclude_tmpdir_env_var: true, exclude_slash_tmp: false },
    permissions: null, default_permissions: null, include_permissions_instructions: true,
    projects: { '/w/proj': { trust_level: 'trusted' }, '/somebody/else': { trust_level: 'trusted' } },
  },
  origins: {
    approval_policy: { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    approvals_reviewer: { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    sandbox_mode: { name: { type: 'sessionFlags' }, version: '' },
    'sandbox_workspace_write.writable_roots.0': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    'sandbox_workspace_write.exclude_tmpdir_env_var': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    'sandbox_workspace_write.network_access': { name: { type: 'sessionFlags' }, version: '' },
    'projects./w/proj.trust_level': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
    'projects./somebody/else.trust_level': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
  },
  layers: [
    { name: { type: 'sessionFlags' }, version: 'sha256:00' },
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
    !rec.layers.flatMap((l) => l.rules).some((r) => r.key === 'permissions' || r.key === 'default_permissions'));

  // ── the LEAF-KEYED TABLE (round 4, MEASURED against a real 0.153.4) ──
  // Not "is the code reached" but "does the view say the true thing": the
  // session's OWN -c flag must show up as the sessionFlags layer's rule, with
  // its value, and nothing may be attributed to a layer that did not set it.
  {
    const all = rec.layers.flatMap((l) => l.rules.map((r) => ({ ...r, layer: l.id })));
    const net = all.find((r) => r.key === 'sandbox_workspace_write.network_access');
    check('codex TABLE key: the session\'s own `-c sandbox_workspace_write.network_access=true` is attributed to sessionFlags WITH ITS VALUE — `sandbox_workspace_write` itself is never in `origins` (measured)',
      !!net && net.layer === 'sessionFlags' && net.value === 'true' && net.note === null, JSON.stringify(net));
    check('codex TABLE key: the leaves the FILE won stay with the file — a split table is one rule per leaf, codex\'s own model',
      all.some((r) => r.key === 'sandbox_workspace_write.exclude_tmpdir_env_var' && r.layer === 'user' && r.value === 'true')
      && all.some((r) => r.key === 'sandbox_workspace_write.writable_roots' && r.layer === 'user' && r.value === '["/tmp/a"]'),
      JSON.stringify(all.filter((r) => r.key.startsWith('sandbox_workspace_write'))));
    check('codex TABLE key: array-index leaves that agree on a layer collapse to their parent path (a real config had 700 writable_roots = 701 leaf origins)',
      !all.some((r) => /\.writable_roots\.\d+$/.test(r.key)));
    check('THE FINDING, measured on the consequence: a key the user\'s own layers set is NEVER filed as "the packaged default", and the sessionFlags layer is NOT empty',
      !all.some((r) => r.key.startsWith('sandbox_workspace_write') && r.note === PR.CODEX_DEFAULT_NOTE)
      && by.sessionFlags.rules.length >= 2, JSON.stringify(all.map((r) => [r.layer, r.key, r.note])));
    // ── A STALE PER-INDEX ORIGIN IS NOT A RULE (residual, ruling 10) ──
    // codex keys `origins` per ARRAY INDEX and KEEPS the lower layer's indices
    // after a higher layer replaced the array with a SHORTER one. Those origins
    // name elements the RESOLVED config does not have, so the view — whose one
    // question is "where does this rule come from" — used to print a row for a
    // rule that is not in force, with an empty value and the note "value not
    // carried in the answer", which reads as "we could not read it".
    {
      const shrunk = {
        config: {
          approval_policy: 'never',
          // the layer in force replaced a 3-element array with a 1-element one
          sandbox_workspace_write: { writable_roots: ['/w/only'], network_access: true },
        },
        origins: {
          approval_policy: { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
          'sandbox_workspace_write.writable_roots.0': { name: { type: 'sessionFlags' }, version: '' },
          // …the FILE's own indices 1 and 2 survive in the origin map
          'sandbox_workspace_write.writable_roots.1': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
          'sandbox_workspace_write.writable_roots.2': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
          // …and a CARRIED leaf the FILE won, so the surviving leaves really do
          // disagree — otherwise the whole table collapses to one layer and the
          // per-leaf path this fixture is about never runs.
          'sandbox_workspace_write.network_access': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
        },
        layers: [
          { name: { type: 'sessionFlags' }, version: 'sha256:00' },
          { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' },
        ],
      };
      const rs = PR.codexRulesRecord(shrunk, { cwd: '/w/proj' });
      const rules = rs.layers.flatMap((l) => l.rules.map((r) => ({ ...r, layer: l.id })));
      check('a per-index origin the RESOLVED config no longer carries is DROPPED — no row, no empty value, no "could not read it" note',
        !rules.some((r) => /\.writable_roots\.[12]$/.test(r.key)) && !rules.some((r) => r.value === '' || r.value == null),
        JSON.stringify(rules.map((r) => [r.layer, r.key, r.value, r.note])));
      // …and dropping them BEFORE the agreement test is what makes the answer
      // right rather than merely quieter: the surviving element has ONE owner.
      const wr = rules.filter((r) => r.key.startsWith('sandbox_workspace_write.writable_roots'));
      check('…and the shorter array now reads as one rule owned by the layer that actually set it (the phantoms had made it look SPLIT)',
        wr.length === 1 && wr[0].layer === 'sessionFlags' && wr[0].key === 'sandbox_workspace_write.writable_roots' && wr[0].value === '["/w/only"]' && wr[0].note === null,
        JSON.stringify(wr));
      // NEGATIVE CONTROL: the pre-fix behaviour, reproduced through the module's
      // own leaf reader, so "it used to print that row" is measured and not
      // remembered — the phantom index resolves to `undefined` in the config
      // that is in force, which is exactly the row the view used to render.
      const leafOf = (cfg, key, path) => {
        let cur = cfg[key];
        for (const seg of path.slice(key.length + 1).split('.')) {
          if (cur == null) return undefined;
          if (Array.isArray(cur)) { const i = Number(seg); cur = Number.isInteger(i) && i >= 0 ? cur[i] : undefined; }
          else if (cur && typeof cur === 'object') cur = cur[seg];
          else return undefined;
        }
        return cur;
      };
      check('NEGATIVE CONTROL: those indices really are unresolvable in the config in force (index 0 resolves, 1 and 2 do not) — the dropped rows had no value to show',
        leafOf(shrunk.config, 'sandbox_workspace_write', 'sandbox_workspace_write.writable_roots.0') === '/w/only'
        && leafOf(shrunk.config, 'sandbox_workspace_write', 'sandbox_workspace_write.writable_roots.1') === undefined
        && leafOf(shrunk.config, 'sandbox_workspace_write', 'sandbox_workspace_write.writable_roots.2') === undefined);
      // POSITIVE CONTROL: a genuinely SPLIT table still splits — the filter
      // must not have turned "one rule per leaf" off for the case it is for.
      check('POSITIVE CONTROL: a table whose CARRIED leaves disagree is still one rule per leaf, each under its own layer',
        rules.some((r) => r.key === 'sandbox_workspace_write.network_access' && r.layer === 'user' && r.value === 'true'),
        JSON.stringify(rules.filter((r) => r.key.startsWith('sandbox_workspace_write'))));
      // …and when NOTHING maps, we say who set the key rather than inventing
      // "nobody did" (defaults) or "we were capped" (unknown).
      const allGone = {
        config: { sandbox_workspace_write: { writable_roots: [] } },
        origins: { 'sandbox_workspace_write.writable_roots.0': { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' } },
        layers: [{ name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'sha256:aa' }],
      };
      const ag = PR.codexRulesRecord(allGone, { cwd: '/w/proj' }).layers.flatMap((l) => l.rules.map((r) => ({ ...r, layer: l.id })));
      check('when NO per-element origin maps onto the value in force, the key is still attributed to the layer that set it — never "the packaged default", never "the answer was capped"',
        ag.length === 1 && ag[0].layer === 'user' && ag[0].note === PR.CODEX_STALE_INDEX_NOTE
        && ag[0].note !== PR.CODEX_DEFAULT_NOTE && ag[0].note !== PR.CODEX_CAPPED_NOTE, JSON.stringify(ag));
    }
    // NEGATIVE CONTROL: a key with NO origin at all — neither top-level nor
    // leaf — must still read "the packaged default". (Measured: 0.153.4 gives
    // `include_permissions_instructions` no origin entry of any kind.)
    const inc = all.find((r) => r.key === 'include_permissions_instructions');
    check('NEGATIVE CONTROL: a key with no origin AT ALL (no top level, no leaf) still reads "not set in any layer — the packaged default"',
      !!inc && inc.note === PR.CODEX_DEFAULT_NOTE, JSON.stringify(inc));
    // …and the bucket it lands in must not IMPERSONATE codex's own layer
    // variant: PackagedDefaultsConfigLayerSource REQUIRES a `file` per the
    // 0.153.4 schema, and 0.153.4 lists no such layer at all (measured).
    check('the "nobody set it" bucket does not forge codex\'s packagedDefaults variant (whose schema REQUIRES a file) when codex listed no such layer',
      inc.layer === 'builtinDefaults' && !rec.layers.some((l) => l.id === 'packagedDefaults'));
    const html = PR.renderRuleTree(rec, { esc: (s) => String(s == null ? '' : s), t: (s) => s });
    check('…and it never renders "no file — this layer is not stored on disk" about a layer that, by its own schema, IS a file',
      !/codex built-in defaults[\s\S]{0,300}not stored on disk/.test(html));
    // When codex DOES report a packagedDefaults layer, we speak in its name —
    // with the file it named.
    const withPkg = PR.codexRulesRecord({
      config: { approval_policy: 'on-request' }, origins: {},
      layers: [{ name: { type: 'packagedDefaults', file: '/opt/codex/defaults.toml' }, version: 'sha256:cc' }],
    }, {});
    const pkg = withPkg.layers.find((l) => l.id === 'packagedDefaults');
    check('when codex DOES list a packagedDefaults layer the rules go there, with the FILE codex named (never a file-less forgery)',
      !!pkg && pkg.file === '/opt/codex/defaults.toml' && pkg.rules.some((r) => r.key === 'approval_policy'), JSON.stringify(pkg));
  }

  // ── the >32KiB degrade path: "we dropped the origin map" ≠ "no layer set it" ──
  {
    const capped = PR.codexRulesRecord({ ...CODEX_FIXTURE, origins: {}, originsDropped: true }, { cwd: '/w/proj' });
    const cr = capped.layers.flatMap((l) => l.rules.map((r) => ({ ...r, layer: l.id })));
    check('THE FINDING (degrade path): when the producer dropped `origins` to fit its cap, NO rule claims "the packaged default" — they are filed under an explicit unknown-source layer that says the origin map never travelled',
      cr.length > 0 && cr.every((r) => r.layer === 'originUnknown' && r.note === PR.CODEX_CAPPED_NOTE)
      && /capped/.test(capped.layers.find((l) => l.id === 'originUnknown').note), JSON.stringify(cr.map((r) => [r.layer, r.note])));
    // NEGATIVE CONTROL: the SAME empty origin map WITHOUT the flag is the
    // honest "no layer set any of this" answer and must keep saying so.
    const noFlag = PR.codexRulesRecord({ ...CODEX_FIXTURE, origins: {} }, { cwd: '/w/proj' });
    const nr = noFlag.layers.flatMap((l) => l.rules.map((r) => ({ ...r, layer: l.id })));
    check('NEGATIVE CONTROL: the same empty origin map WITHOUT `originsDropped` still reads "the packaged default" (the two facts must not collapse into one sentence)',
      nr.length > 0 && nr.every((r) => r.note === PR.CODEX_DEFAULT_NOTE) && !noFlag.layers.some((l) => l.id === 'originUnknown'));
    check('the two notes are distinct strings (a degrade path may never borrow the honest answer\'s words)', PR.CODEX_CAPPED_NOTE !== PR.CODEX_DEFAULT_NOTE);
  }
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
  // 3 contributing sources (user / sessionFlags / built-in defaults) × 8 rules:
  // approval_policy, approvals_reviewer, sandbox_mode, the three
  // sandbox_workspace_write leaves (two collapsed under `user`, network_access
  // under sessionFlags), include_permissions_instructions, and THIS project's
  // trust_level. `system` contributed nothing and is not counted.
  check('ruleTreeSummary: counts the sources that CONTRIBUTED and every rule',
    PR.ruleTreeSummary(PR.codexRulesRecord(CODEX_FIXTURE, { cwd: '/w/proj' }), { t: (s, p) => s.replace('{layers}', p.layers).replace('{rules}', p.rules) }) === '3 source(s) · 8 rule(s)',
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
  // round-2 verifier: the codex INSTANCE scope is OFF because the only way to
  // answer it (a fresh `codex app-server`) was measured connecting to
  // chatgpt.com. The caps row is the ONE gate every surface reads, so it is
  // where the decision lives — and the rejection record must agree with it.
  check('codex declares session-ONLY: the instance scope would need a fresh app-server child, measured connecting to the vendor',
    capsOf('codex').permissionRules.session === true && capsOf('codex').permissionRules.instance === false);
  {
    const blk = ORACLES_MOD.blockedCapability('codex', 'permissionRules.instance');
    check('the switched-off capability is explained by a MEASURED rejection, not by a hand-written sentence',
      !!blk && blk.id === 'codex-app-server-config-read' && blk.measured.inetConnects > 0 && /chatgpt\.com/.test(blk.measured.host || ''),
      JSON.stringify(blk && blk.measured));
    check('NEGATIVE CONTROL: a capability that is ON has no blocking rejection (the mechanism cannot mark a live feature)',
      ORACLES_MOD.blockedCapability('claude', 'permissionRules.instance') === null && capsOf('claude').permissionRules.instance === true);
    check('the measured-and-rejected app-server read can never be looked up as a runnable oracle',
      !ORACLES_MOD.oracle('codex-app-server-config-read') && !!ORACLES_MOD.rejected('codex-app-server-config-read'));
  }
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
  // ── the codex INSTANCE scope is not offered, and it SAYS WHY (round 2) ──
  // It used to spawn `codex app-server`, which was measured opening 7 INET
  // connects (2 × chatgpt.com:443) with an EMPTY CODEX_HOME. The refusal must
  // carry its own reason code — 'unsupported-harness' would have been a lie
  // (this harness CAN answer; we decline to ask it that way).
  const r5 = await mod.read({ backend: 'codex', scope: 'instance', cwd: '/x' });
  check('routing: codex instance scope answers would-connect and NAMES the measurement (never a silent capability, never a spawn)',
    r5.ok === false && r5.reason === 'would-connect' && /chatgpt\.com/.test(r5.detail || '') && /strace/.test(r5.detail || '')
    && r5.layers.length === 0, JSON.stringify(r5).slice(0, 300));
  check('routing: would-connect is a DECLARED reason code (a UI branching on an undeclared code is a bug)',
    PR.UNAVAILABLE_REASONS.includes('would-connect'));
  // NEGATIVE CONTROL: the sibling refusal is still the generic one, so
  // 'would-connect' cannot be what this reader says whenever a scope is off.
  const r5b = await mod.read({ backend: 'opencode', scope: 'session' });
  check('NEGATIVE CONTROL: a scope that is off for an ORDINARY reason still answers unsupported-harness (would-connect is not the new default)',
    r5b.ok === false && r5b.reason === 'unsupported-harness' && !/chatgpt/.test(r5b.detail || ''));
  // …and the read must not have started anything. The strongest available
  // proof in-process: with a codexCmdRef that would BE the spawn, an instance
  // read still refuses without ever asking for the command.
  {
    let asked = 0;
    const armed = mkModule({ codexCmdRef: () => { asked++; return '/usr/bin/codex'; } });
    const r = await armed.read({ backend: 'codex', scope: 'instance', cwd: '/x', accountId: 'acct-1' });
    check('the instance refusal never even resolves the codex command — there is no path left that could spawn (asked=' + asked + ')',
      asked === 0 && r.reason === 'would-connect');
  }
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
  check('…and the SESSION rung really shows the session\'s own -c flag as such (leaf-keyed table origins survive the whole seam)',
    rec.layers.find((l) => l.id === 'sessionFlags')?.rules.some((r) => r.key === 'sandbox_workspace_write.network_access' && r.value === 'true'),
    JSON.stringify(rec.layers.map((l) => [l.id, l.rules.map((r) => r.key)])));

  // WIRING PIN (the 2.355.0 unstaged-wiring law): `originsDropped` is only a
  // fact if the SERVER hands it to the pure reader. Driven through the real
  // readViaSession seam, and MEASURED on the consequence (the layer the rules
  // land in), never grepped.
  written.length = 0;
  {
    const pd = mod.readViaSession(SID, { timeoutMs: 4000 });
    await sleep(60);
    mod.onWrapperRecord(SID, { type: 'permission_rules', ok: true, requestId: JSON.parse(written[0]).requestId, cwd: PROJ, config: CODEX_FIXTURE.config, origins: {}, originsDropped: true, truncated: true });
    const recD = await pd;
    const rulesD = recD.layers.flatMap((l) => l.rules.map((r) => ({ ...r, layer: l.id })));
    check('WIRING PIN: a capped wrapper answer (`originsDropped`) reaches the reader — every rule lands under the explicit unknown-source layer, none claims "the packaged default"',
      recD.truncated === true && rulesD.length > 0 && rulesD.every((r) => r.layer === 'originUnknown' && r.note === PR.CODEX_CAPPED_NOTE),
      JSON.stringify(rulesD.map((r) => [r.layer, r.note])));
    written.length = 0;
    const pn = mod.readViaSession(SID, { timeoutMs: 4000 });
    await sleep(60);
    mod.onWrapperRecord(SID, { type: 'permission_rules', ok: true, requestId: JSON.parse(written[0]).requestId, cwd: PROJ, config: CODEX_FIXTURE.config, origins: {}, truncated: true });
    const recN = await pn;
    check('NEGATIVE CONTROL through the same seam: without the flag an empty origin map is still the honest "the packaged default" answer',
      !recN.layers.some((l) => l.id === 'originUnknown')
      && recN.layers.flatMap((l) => l.rules).every((r) => r.note === PR.CODEX_DEFAULT_NOTE));
  }

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
// ── the ANSWER is a side channel, not a record (round-2 verifier) ──
// `permission_rules` travels on the same stdout stream as conversation
// records, so it reaches the normalizer too. It must be DELIBERATELY SKIPPED:
// an unlisted type fires `codex-unknown-record:<type>`, and that breadcrumb's
// only job is to announce a genuine upstream addition. Every user who clicked
// "Show rules…" on a codex session was poisoning it.
{
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const fire = (type) => {
    CodexMessageManager._seenUnknownRecords?.clear?.();
    const seen = [];
    const prev = global.__vsEvent;
    global.__vsEvent = (n, d) => seen.push([n, d]);
    try {
      new CodexMessageManager('t-pr').processLive({
        type: 'event_msg',
        payload: { type, ok: true, requestId: 'pr1', cwd: '/w', config: {}, origins: {}, layers: [] },
      });
    } finally { global.__vsEvent = prev; }
    return seen;
  };
  check('the wrapper\'s permission_rules answer fires NO unknown-record breadcrumb (it is a named side channel, deliberately card-less)',
    fire('permission_rules').length === 0, JSON.stringify(fire('permission_rules')));
  // NEGATIVE CONTROL: the detector still sees a genuinely unknown type, so the
  // zero above is a measurement and not a blind spot.
  const ctl = fire('some_future_codex_event');
  check('NEGATIVE CONTROL: a genuinely unknown event_msg type still fires the breadcrumb (the signal this fix protects is alive)',
    ctl.length === 1 && ctl[0][0] === 'codex-unknown-record:some_future_codex_event', JSON.stringify(ctl));
  // the comment that promised a client broadcast the client never had
  const ce = fs.readFileSync(path.join(REPO, 'src/server/stdout/codex-events.js'), 'utf8');
  check('the codex stdout consumer no longer promises a live broadcast to other windows (nothing on the client reads this record)',
    /permission_rules/.test(ce) && !/second window watching the same session sees the same tree/.test(ce));
  check('…and no client module consumes a permission_rules record, which is why that promise had to go',
    execSync(`grep -rl "permission_rules" ${JSON.stringify(path.join(REPO, 'src/lib'))} || true`, { encoding: 'utf8' }).trim() === '');
}

// ── WIRING PIN: the answer travels through the REAL stdout seam (round 3) ──
// The block above proves the SHAPING; this proves the DELIVERY, because the
// two failed independently. The suite used to call `mod.onWrapperRecord(...)`
// on the module directly — green — while the only production caller was
// `permissionRulesRef?.()`, and `permissionRulesRef` is an mk() Proxy whose
// TARGET IS A PLAIN OBJECT: truthy, `?.` passes, and the call is a TypeError.
// Every "Show rules…" on a live codex session therefore waited out the 20s
// timeout and reported `read-failed`. That is the 2.355.0 unstaged-wiring
// class, and only a test that goes through `createStdoutRegistry` with an
// mk()-wrapped ref — exactly as src/server/session-stdout.js builds it — can
// see it.
{
  const { createStdoutRegistry } = require(path.join(REPO, 'src/server/stdout/index.js'));
  const { mk } = require(path.join(REPO, 'src/server/lazy.js'));
  // The primitive, stated once so the reason the asserts below exist is not folklore.
  {
    let threw = null;
    const ref = mk(() => ({ onWrapperRecord() { return 'ok'; } }));
    try { ref?.(); } catch (e) { threw = e.message; }
    check('THE PRIMITIVE: an mk() lazy ref is NOT callable — `ref()` throws even though `ref?.` passes (its Proxy target is `{}`)',
      /is not a function/.test(threw || ''), String(threw));
    check('THE PRIMITIVE: …and property access through it returns a BOUND method, which is why every consumer must use `ref?.method?.()`',
      ref?.onWrapperRecord?.() === 'ok' && mk(() => null)?.onWrapperRecord?.() === undefined);
  }
  // Drive the real consumers on a fake pty, with the deps wired the way the
  // engine wires them.
  const driveConsumer = (protocol, { pr, deliver } = {}) => {
    const warns = [], logs = [];
    const oWarn = console.warn, oLog = console.log, oErr = console.error;
    console.warn = (...a) => warns.push(a.join(' '));
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => warns.push(a.join(' '));
    let reg, consumer, feed = null;
    try {
      reg = createStdoutRegistry({
        activeSessions: new Map(),
        engine: { noteTurnEnd() { }, noteTurnStart() { }, recordCodexQuotaSignal() { }, recordClaudeQuotaSignal() { } },
        CLAUDE_STREAM_TYPES: new Set(), _seenStreamTypes: new Set(), USAGE_SCANNER_PATH: '/nonexistent',
        checkClaudeGoalStatus() { }, noteModelSeen() { }, noteHarnessModels() { }, sbSeenFirst() { },
        hosts: mk(() => null), usageHistory: mk(() => null),
        deliverRef: mk(() => deliver ?? null),
        permissionRulesRef: mk(() => pr ?? null),
      });
      consumer = reg.get(protocol);
      const session = { buffer: '', backend: protocol === 'acp-events' ? 'opencode' : 'codex', backendSessionId: 'cid-1' };
      consumer.attach(session, 'sess-wire', { onData: (cb) => { feed = cb; }, onExit: () => { } }, {
        feedLive() { }, broadcastToSession() { }, broadcastActiveSessions() { },
        readSessionMeta: () => ({}), writeSessionMeta() { }, updateSessionTodos() { },
        applyTaskToolUpdate() { }, emitTaskListTodos() { },
      });
    } finally { console.warn = oWarn; console.log = oLog; console.error = oErr; }
    return {
      feed: (obj) => {
        const w = console.warn, l = console.log, e2 = console.error;
        console.warn = (...a) => warns.push(a.join(' '));
        console.log = (...a) => logs.push(a.join(' '));
        console.error = (...a) => warns.push(a.join(' '));
        try { feed(JSON.stringify(obj) + '\n'); } finally { console.warn = w; console.log = l; console.error = e2; }
      },
      warns, logs,
    };
  };
  const codexAnswer = (rid) => ({ type: 'event_msg', payload: { type: 'permission_rules', ok: true, requestId: rid, cwd: '/w', config: CODEX_FIXTURE.config, origins: CODEX_FIXTURE.origins, layers: CODEX_FIXTURE.layers } });
  const codexFailedPeer = { type: 'event_msg', payload: { type: 'peer_message_result', ok: false, reason: 'queue-refused', text: 'hello peer', fromName: 'bob' } };
  // `type:'acp'` is load-bearing — the consumer forwards anything else straight
  // to feedLive, so a fixture without it would test nothing and pass.
  const acpAnswer = (rid) => ({ type: 'acp', kind: 'permission_rules', ok: false, requestId: rid, reason: 'unsupported-by-protocol', detail: 'ACP v1 has no config-read method', mode: 'build', modes: ['build'] });
  const acpFailedPeer = { type: 'acp', kind: 'peer_result', ok: false, reason: 'no-lane', text: 'hello acp', fromName: 'bob' };

  for (const [protocol, answer, failedPeer] of [['codex-events', codexAnswer, codexFailedPeer], ['acp-events', acpAnswer, acpFailedPeer]]) {
    // ① the real seam delivers the permission-rule answer to the real sink
    const got = [];
    const d = driveConsumer(protocol, { pr: { onWrapperRecord: (sid, p) => got.push([sid, p]) }, deliver: { stashFor() { } } });
    d.feed(answer('rq-1'));
    check(`WIRING PIN (${protocol}): a permission_rules answer reaches the reader's onWrapperRecord through the REAL registry + a real mk() ref`,
      got.length === 1 && got[0][0] === 'sess-wire', JSON.stringify({ got: got.length, warns: d.warns }));
    check(`WIRING PIN (${protocol}): …and it arrives with its requestId, so the pending read can be matched (never "the next record wins")`,
      got.length === 1 && (got[0][1]?.requestId || got[0][1]?.payload?.requestId) === 'rq-1', JSON.stringify(got[0]?.[1] || null));

    // ② NEGATIVE CONTROL — a neutered ref must make this leg RED, so the pass
    // above is a measurement of the seam and not of a fake in the path.
    const neutered = driveConsumer(protocol, { pr: null, deliver: null });
    neutered.feed(answer('rq-2'));
    check(`NEGATIVE CONTROL (${protocol}): with the singleton not up yet the answer simply goes nowhere — no throw, no crash of the stdout loop`,
      neutered.warns.length === 0, JSON.stringify(neutered.warns));

    // ③ the degrade path LOGS VERBATIM (2.276.0): a sink that throws must be
    // reported, because a silent catch is exactly how this bug survived.
    const boom = driveConsumer(protocol, { pr: { onWrapperRecord() { throw new Error('sink exploded'); } }, deliver: { stashFor() { } } });
    boom.feed(answer('rq-3'));
    check(`WIRING PIN (${protocol}): a throwing sink is reported with the message VERBATIM (a catch that hides its own bug is how this one lived)`,
      boom.warns.some((w) => /sink exploded/.test(w)), JSON.stringify(boom.warns));

    // ④ the SAME primitive on the delivery lane — "a promised message never
    // silently dies" was false here too: deliverRef() threw into a bare catch,
    // so the log said "re-stashing" and nothing was stashed.
    const wantText = failedPeer.payload?.text ?? failedPeer.text;
    const stashed = [];
    const dl = driveConsumer(protocol, { pr: { onWrapperRecord() { } }, deliver: { stashFor: (cid, o) => stashed.push([cid, o]) } });
    dl.feed(failedPeer);
    check(`WIRING PIN (${protocol}): a FAILED peer delivery really reaches stashFor — the log line and the stash are now the same fact`,
      stashed.length === 1 && stashed[0][0] === 'cid-1' && stashed[0][1].text === wantText,
      JSON.stringify({ stashed, logs: dl.logs, warns: dl.warns }));
    check(`WIRING PIN (${protocol}): …and the "re-stashing" log is not a promise the code does not keep`,
      dl.logs.some((l) => /re-stashing/.test(l)) && stashed.length === 1, JSON.stringify({ logs: dl.logs, stashed: stashed.length }));
    const dlBoom = driveConsumer(protocol, { pr: { onWrapperRecord() { } }, deliver: { stashFor() { throw new Error('stash exploded'); } } });
    dlBoom.feed(failedPeer);
    check(`WIRING PIN (${protocol}): a stash that throws SAYS SO (the bare catch that ate this for 3 releases is gone)`,
      dlBoom.warns.some((w) => /stash exploded/.test(w)), JSON.stringify(dlBoom.warns));
  }

  // ⑤ STANDING SWEEP: every module that builds mk() refs, not just this one.
  // The two offenders were copies of each other in src/server/stdout/, but the
  // PROPERTY that makes them wrong ("an mk() ref is a Proxy over `{}`, so a call
  // is always a TypeError") belongs to src/server/lazy.js and holds in every
  // module that uses it. Enumerating the directory I had just been looking at is
  // the tool this class of bug has already beaten twice, so the file set is
  // DERIVED (every .js under src/ + server.js that REQUIRES src/server/lazy.js
  // and binds an mk() ref) and PRINTED. Per file, the names are the ones THAT
  // file binds: `hosts` in session-stdout is a lazy ref, `hosts` elsewhere may
  // be an ordinary object.
  {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
    });
    const candidates = [...walk(path.join(REPO, 'src')), path.join(REPO, 'server.js')];
    const builders = [];       // [relPath, [lazy names it binds]]
    const offenders = [];
    for (const full of candidates) {
      const src = fs.readFileSync(full, 'utf8');
      // `mk` must be THE lazy bridge, not a name collision: src/lib/terminal.js
      // has a local `const mk = (cls) => …` DOM helper, and sweeping its
      // `badge` binding would some day fail a legitimate call. Over-inclusion
      // is cheap, but not when it can turn an unrelated line red.
      if (!/require\((['"])[.\/]*lazy\.js\1\)/.test(src)) continue;
      const names = [...new Set([...src.matchAll(/const\s+(\w+)\s*=\s*mk\(/g)].map((m) => m[1]))];
      if (!names.length) continue;
      const rel = path.relative(REPO, full);
      builders.push([rel, names]);
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                     // comments may NAME the retired spelling
        // `ref(` or `ref?.(` — a CALL. `ref?.method?.(` and `ref.method(` do
        // not match, because the `(` must follow the name (with at most an
        // optional-chain punctuator between), never a property name.
        for (const n of names) {
          if (new RegExp(`\\b${n}\\s*(\\?\\.)?\\s*\\(`).test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
        }
      });
    }
    // The consumers do not BUILD their refs (session-stdout hands them in), so
    // they are swept with the names their engine binds — the seam the bug used.
    const engine = builders.find(([rel]) => rel === 'src/server/session-stdout.js');
    if (engine) {
      for (const f of fs.readdirSync(path.join(REPO, 'src/server/stdout')).filter((n) => n.endsWith('.js'))) {
        const rel = path.join('src/server/stdout', f);
        fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          for (const n of engine[1]) {
            if (new RegExp(`\\b${n}\\s*(\\?\\.)?\\s*\\(`).test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
          }
        });
      }
    }
    console.log('    swept for mk()-ref CALLS: ' + builders.map(([rel, n]) => `${rel}(${n.length})`).join(', ') + ' + src/server/stdout/*');
    check('standing sweep: the derived file set is non-empty, is every real importer of src/server/lazy.js, and includes the engine that hands the refs to the stdout consumers',
      builders.length >= 5 && !!engine && engine[1].length >= 4
      && !builders.some(([r]) => r === 'src/lib/terminal.js'), JSON.stringify(builders.map(([r]) => r)));
    check('standing sweep: NOTHING calls a lazy mk() ref as a function (its Proxy target is `{}` — the call is always a TypeError)',
      offenders.length === 0, offenders.join('\n    '));
    // NEGATIVE CONTROL: the detector really matches the two lines that shipped,
    // and does NOT match the two that replaced them — otherwise the zero above
    // is a broken regex rather than a clean tree.
    const bad = ['try { permissionRulesRef?.()?.onWrapperRecord?.(id, msg.payload); } catch (e) {}',
      'try { if (cid) deliverRef()?.stashFor(cid, { source: \'agent\' }); } catch {}'];
    const good = ['try { permissionRulesRef?.onWrapperRecord?.(id, msg.payload); } catch (e) {}',
      'try { if (cid) deliverRef?.stashFor?.(cid, { source: \'agent\' }); } catch (e) {}',
      'const r = hosts.device(hostId); usageHistory.record(ev);'];
    const hits = (s) => ['permissionRulesRef', 'deliverRef', 'hosts', 'usageHistory'].some((n) => new RegExp(`\\b${n}\\s*(\\?\\.)?\\s*\\(`).test(s));
    check('NEGATIVE CONTROL: the sweep matches BOTH lines that shipped, and neither of the two that replaced them (nor an ordinary `ref.method()`)',
      bad.every(hits) && good.every((s) => !hits(s)), JSON.stringify({ bad: bad.map(hits), good: good.map(hits) }));
  }
}

// ── COMMENTS STATE WHAT THE CODE DOES (round 3) ──
// This batch's own stated value is that a comment describing a mechanism that
// was deleted (or never existed) is a defect — it is what shipped the
// "second window sees the same tree" promise in round 2. Two more were found
// in round 3, so both are pinned the same way, each with a control that fails
// if the pin is checking a string nobody would write anyway.
{
  const view = fs.readFileSync(path.join(REPO, 'src/lib/permission-rules-view.js'), 'utf8');
  check('the view no longer justifies its human-trigger rule with the codex INSTANCE rung — round 2 DELETED that rung (`permissionRules.instance:false`)',
    !/instance rung spawns a bounded app-server child/.test(view));
  check('…and it states the reason that is actually true today: the codex SESSION rung is a round trip to that session\'s own app-server',
    /session rung is a full round trip/.test(view) && /would-connect/.test(view));
  const base = fs.readFileSync(path.join(REPO, 'src/adapters/base.js'), 'utf8');
  const prDoc = base.slice(Math.max(0, base.indexOf('READ-ONLY PERMISSION-RULE READ')), base.indexOf('formatReadPermissionRules ='));
  check('the adapter doc for the read verb no longer names ws-handler as its gate — there is no ws message for this verb at all',
    prDoc.length > 100 && !/ws-handler/.test(prDoc), prDoc.slice(0, 240));
  check('…and it names the REAL gates: src/server/permission-rules.js read() (caps row) + readViaSession() (the wrapper advert)',
    /server\/permission-rules\.js/.test(prDoc) && /readViaSession/.test(prDoc) && /wrapperCaps/.test(prDoc), prDoc.slice(0, 400));
  // the FACT the comment now asserts, measured rather than believed
  const wsSrc = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8');
  const createSrc = fs.readFileSync(path.join(REPO, 'src/ws-create.js'), 'utf8');
  check('MEASURED: no ws layer calls formatReadPermissionRules — the ONLY caller is the HTTP reader',
    !/formatReadPermissionRules/.test(wsSrc) && !/formatReadPermissionRules/.test(createSrc)
    && /formatReadPermissionRules/.test(fs.readFileSync(path.join(REPO, 'src/server/permission-rules.js'), 'utf8')));
  check('NEGATIVE CONTROL: its two SIBLING verbs really are ws-gated, so "no ws-handler" is a distinction this file draws and not a blanket that would pass anywhere',
    /formatSetResponseStyle/.test(wsSrc) && /formatQueueOp/.test(wsSrc));
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

    // ── the MISSING button is explained where the button would have been ──
    // codex ships three oracles, so the old "rejections only when there are
    // none" rule would have hidden the one rejection that explains why
    // "Permission rules…" is absent for a codex account (round-2 verifier).
    const menus = await evaljs(`(() => {
      const row = (b) => window.app._rulesAndChecksItems(b, {}).map((i) => ({ label: i.label || (i.separator ? '—' : ''), disabled: !!i.disabled, title: i.title || '' }));
      return { codex: row('codex'), claude: row('claude'), shell: row('shell') };
    })()`);
    const cRows = menus.codex || [];
    check('375×667: a codex account gets NO "Permission rules…" row (the instance rung would have spawned a connecting app-server)',
      !cRows.some((r) => /^Permission rules/.test(r.label)), JSON.stringify(cRows.map((r) => r.label)));
    check('375×667: …and it gets a DISABLED row naming the measurement instead, right where the button would have been',
      cRows.some((r) => r.disabled && /app-server/.test(r.label) && /chatgpt\.com/.test(r.title)), JSON.stringify(cRows));
    check('375×667: its three measured-clean oracles are still offered and still enabled (the fix removed one rung, not the feature)',
      cRows.filter((r) => !r.disabled && /…$/.test(r.label)).length === 3, JSON.stringify(cRows.map((r) => r.label)));
    check('NEGATIVE CONTROL: claude — which has NO oracles at all — still lists ALL its rejected candidates, and still offers its own rule view',
      (menus.claude || []).some((r) => /^Permission rules/.test(r.label))
      && (menus.claude || []).filter((r) => r.disabled).length === ORACLES_MOD.rejectedFor('claude').length
      && ORACLES_MOD.rejectedFor('claude').length >= 2,
      JSON.stringify((menus.claude || []).map((r) => r.label)));
    check('NEGATIVE CONTROL: shell contributes no rows at all (no agent ⇒ no rules and no checks)', (menus.shell || []).length === 0, JSON.stringify(menus.shell));

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

    // ── 375×667: the SHAPES round 4 introduced, in the REAL DOM ──
    // A leaf-split table produces the longest keys this view can carry
    // (`sandbox_workspace_write.exclude_tmpdir_env_var`), and the capped
    // answer introduces a file-less layer whose path line is a SENTENCE
    // ("no path — the origin map was dropped to fit the answer") rather than
    // the short stock one. Both are rendered through the real view, off the
    // server's own record, and measured for overflow on the phone viewport.
    const leafRec = PR.codexRulesRecord(CODEX_FIXTURE, { cwd: '/w/proj', scope: 'session' });
    const cappedRec = PR.codexRulesRecord({ ...CODEX_FIXTURE, origins: {}, originsDropped: true }, { cwd: '/w/proj', scope: 'session' });
    const shapes = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelectorAll('.modal-overlay, #perm-rules-dialog, #local-oracle-dialog').forEach((e) => e.remove());
      const RECS = { leaf: ${JSON.stringify(leafRec)}, capped: ${JSON.stringify(cappedRec)} };
      const out = { made: [] };
      const realFetch = window.fetch;
      let which = 'leaf';
      window.fetch = function (u) {
        if (String(u).includes('/api/permission-rules')) return Promise.resolve(new Response(JSON.stringify(RECS[which]), { headers: { 'content-type': 'application/json' } }));
        return realFetch.apply(this, arguments);
      };
      try {
        for (const key of ['leaf', 'capped']) {
          which = key;
          const s = { sessionId: 'pr-shape-' + key, webuiId: 'pr-shape-' + key, backend: 'codex', mode: 'chat', cwd: '/w/proj', name: 'shape ' + key, status: 'live' };
          const w = window.app.openSessionProps(s);
          if (!w) { out[key] = { error: 'no window' }; continue; }
          out.made.push(w.id);
          const btn = [...w.content.querySelectorAll('button')].find((b) => /Show rules/.test(b.textContent));
          if (!btn) { out[key] = { error: 'no Show rules button on a codex session' }; continue; }
          btn.click();
          for (let i = 0; i < 80; i++) { if (w.content.querySelector('.perm-rules .perm-layer')) break; await sleep(150); }
          const root = w.content.querySelector('.perm-rules');
          if (!root) { out[key] = { error: 'tree never rendered' }; continue; }
          const keys = [...root.querySelectorAll('.perm-rule-key')].map((e) => e.textContent);
          const longest = keys.slice().sort((a, b) => b.length - a.length)[0] || '';
          const boxes = [...root.querySelectorAll('.perm-rule, .perm-layer-path, .perm-layer-head, .perm-layer-note')];
          const overflowing = boxes.filter((e) => Math.round(e.getBoundingClientRect().right) > Math.round(root.getBoundingClientRect().right) + 1).length;
          out[key] = {
            measured: boxes.length,
            layers: root.querySelectorAll('.perm-layer').length,
            keys, longest,
            noteTexts: [...root.querySelectorAll('.perm-rule-note')].map((e) => e.textContent),
            pathNone: [...root.querySelectorAll('.perm-layer-path-none')].map((e) => e.textContent),
            scrollW: root.scrollWidth, clientW: root.clientWidth,
            docScrollW: document.documentElement.scrollWidth, inner: window.innerWidth,
            overflowing,
          };
        }
      } finally {
        window.fetch = realFetch;
        for (const id of out.made) { try { window.app.wm.closeWindow(id); } catch (e) { } }
      }
      return out;
    })()`);
    check('375×667: a LEAF-SPLIT codex table renders through the real view — the session\'s own -c flag appears as its own rule under its own layer',
      !shapes.error && shapes.leaf && !shapes.leaf.error && shapes.leaf.keys.includes('sandbox_workspace_write.network_access'),
      JSON.stringify(shapes.leaf));
    check('375×667: …and the longest key it can produce still does not overflow (no element right of the tree, no sideways page scroll)',
      !shapes.leaf.error && shapes.leaf.longest.length >= 40 && shapes.leaf.measured >= 8 && shapes.leaf.overflowing === 0
      && shapes.leaf.scrollW <= shapes.leaf.clientW + 1 && shapes.leaf.docScrollW <= shapes.leaf.inner + 1,
      JSON.stringify(shapes.leaf));
    check('375×667: the CAPPED answer renders its own layer saying the origin map is gone, while the layer that genuinely has no file keeps the stock line — two different sentences on one screen, never "the packaged default"',
      !shapes.capped.error
      && shapes.capped.noteTexts.length > 0 && shapes.capped.noteTexts.every((t) => t === PR.CODEX_CAPPED_NOTE)
      && shapes.capped.pathNone.some((t) => /origin map was dropped/.test(t))
      && shapes.capped.pathNone.some((t) => /not stored on disk/.test(t)),
      JSON.stringify(shapes.capped));
    check('375×667: …and that sentence-length path line wraps instead of scrolling the phone sideways',
      !shapes.capped.error && shapes.capped.measured >= 8 && shapes.capped.overflowing === 0
      && shapes.capped.scrollW <= shapes.capped.clientW + 1 && shapes.capped.docScrollW <= shapes.capped.inner + 1,
      JSON.stringify(shapes.capped));

    // ── WIRING PIN: a REMOTE session, through the REAL door (round 2) ──
    // The server's `remote-session` guard was already correct and its own test
    // was green — but the CLIENT read `s.hostId`, a field a session record
    // does not have (`hostId` is an OPENSPEC name), so `host=` went out EMPTY
    // and the panel answered a remote session with THIS machine's
    // ~/.claude/settings.json. A test that calls `read({host})` directly can
    // never see that (the 2.355.0 unstaged-wiring class), so this drives
    // `app.openSessionProps` with a merged record shaped exactly like
    // sidebar.js _merge builds one: `host` set, and `cwd` carrying the
    // host-labeled DISPLAY string that must never be used as a path.
    const remote = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelectorAll('.modal-overlay, #perm-rules-dialog, #local-oracle-dialog').forEach((e) => e.remove());
      const out = { made: [], sent: [] };
      // capture what the door actually asks the server for
      const realFetch = window.fetch;
      window.fetch = function (u, o) { try { if (String(u).includes('/api/permission-rules')) out.sent.push(String(u)); } catch (e) { } return realFetch.apply(this, arguments); };
      try {
        const s = { sessionId: 'pr-remote', webuiId: 'pr-remote', backend: 'claude', mode: 'chat',
                    cwd: 'aidev-box: /home/remoteuser/proj', host: 'aidev-box', hostName: 'aidev-box',
                    name: 'perm-rules remote probe', status: 'live' };
        const w = window.app.openSessionProps(s);
        if (!w) return { error: 'openSessionProps returned nothing for the remote session' };
        out.made.push(w.id);
        const btn = [...w.content.querySelectorAll('button')].find((b) => /Show rules/.test(b.textContent));
        if (!btn) return { error: 'no Show rules button on the remote session' };
        btn.click();
        // NOT '.perm-rules-empty' alone — loadInto uses that same class for its
        // "Reading…" placeholder, so polling for it lands on the in-flight
        // state. The rendered REFUSAL is the one that carries data-reason.
        let empty = null;
        for (let i = 0; i < 80 && !empty; i++) { empty = w.content.querySelector('.perm-rules .perm-rules-empty[data-reason]'); if (!empty) await sleep(150); }
        const tree = w.content.querySelector('.perm-rules');
        out.reason = empty ? (empty.dataset.reason || '') : '';
        out.text = empty ? empty.textContent : '';
        out.layers = tree ? tree.querySelectorAll('.perm-layer').length : 0;
        out.paths = tree ? [...tree.querySelectorAll('.perm-layer-path[data-copy]')].map((b) => b.dataset.copy) : [];
      } finally {
        window.fetch = realFetch;
        for (const id of out.made) { try { window.app.wm.closeWindow(id); } catch (e) { } }
      }
      return out;
    })()`);
    check('375×667 WIRING PIN: a REMOTE session\'s Properties says the rules live on that machine — never this machine\'s files under a remote label',
      !remote.error && remote.reason === 'remote-session' && /aidev-box/.test(remote.text || '') && remote.layers === 0, JSON.stringify(remote));
    check('375×667 WIRING PIN: the door really sent host= (the field is `s.host`; `hostId` is an openSpec name and does not exist on a session)',
      !remote.error && (remote.sent || []).some((u) => /[?&]host=aidev-box/.test(u)), JSON.stringify(remote.sent));
    {
      // the DISPLAY cwd ("aidev-box: /home/remoteuser/proj") is a grouping KEY
      // and must never travel as a path (2.225.2). It must arrive stripped.
      const cwds = (remote.sent || []).map((u) => new URL(u, 'http://x').searchParams.get('cwd'));
      check('375×667 WIRING PIN: it never sends the host-labeled DISPLAY cwd as a path (2.225.2 — that string must not reach an operation)',
        !remote.error && cwds.length > 0 && cwds.every((c) => c === '/home/remoteuser/proj'), JSON.stringify(cwds));
    }
    check('375×667 WIRING PIN: no copy-path button offers a path that exists on neither machine',
      !remote.error && (remote.paths || []).length === 0, JSON.stringify(remote.paths));

    // ── THE WINDOW'S OWN RE-RENDER MUST NOT EAT THE ANSWER (round 3) ──
    // `render()` opens with `root.innerHTML = ''` and re-runs on every
    // 'active-sessions' broadcast — which fires on every session
    // create/exit/attach AND on every agent TodoWrite (coalesced to 500ms
    // server-side), i.e. continuously while the very session you opened
    // Properties for is working. The tree the user paid a click (and, on
    // codex, a 20s agent round trip) for vanished within a second and the
    // button went back to "Show rules…". Reproduced here at 375×667 before the
    // fix: layers 4 → 0, label "Reload rules" → "Show rules…".
    // The SENTINEL is what makes this leg non-vacuous: it must be GONE
    // afterwards, proving the broadcast really rebuilt the body and the tree
    // survived a real re-render rather than a no-op.
    const rerender = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelectorAll('.modal-overlay, #perm-rules-dialog, #local-oracle-dialog').forEach((e) => e.remove());
      const out = { made: [], reads: 0 };
      const realFetch = window.fetch;
      window.fetch = function (u) { try { if (String(u).includes('/api/permission-rules')) out.reads++; } catch (e) { } return realFetch.apply(this, arguments); };
      try {
        const s = { sessionId: 'pr-rerender', webuiId: 'pr-rerender', backend: 'claude', mode: 'chat',
                    cwd: '/tmp', name: 'perm-rules rerender probe', status: 'live' };
        const w = window.app.openSessionProps(s);
        if (!w) return { error: 'openSessionProps returned nothing' };
        out.made.push(w.id);
        const btnOf = () => [...w.content.querySelectorAll('button')].find((b) => /Show rules|Reload rules/.test(b.textContent));
        const btn = btnOf();
        if (!btn) return { error: 'no rules button' };
        btn.click();
        for (let i = 0; i < 80; i++) { if (w.content.querySelector('.perm-rules .perm-layer')) break; await sleep(150); }
        out.layersAfterClick = w.content.querySelectorAll('.perm-rules .perm-layer').length;
        out.labelAfterClick = (btnOf() || {}).textContent || '';
        out.readsAfterClick = out.reads;
        const sentinel = document.createElement('i');
        sentinel.id = 'pr-rerender-sentinel';
        w.content.querySelector('.session-props').appendChild(sentinel);
        // byte-identical to WsManager's own dispatch (src/lib/ws.js onmessage)
        [...window.app.ws.globalHandlers].forEach((h) => { try { h({ type: 'active-sessions', sessions: [] }); } catch (e) { } });
        await sleep(900);                                   // past the 300ms trailing-edge debounce
        out.sentinelSurvived = !!w.content.querySelector('#pr-rerender-sentinel');
        out.layersAfterBroadcast = w.content.querySelectorAll('.perm-rules .perm-layer').length;
        out.rulesAfterBroadcast = w.content.querySelectorAll('.perm-rules .perm-rule').length;
        out.labelAfterBroadcast = (btnOf() || {}).textContent || '';
        out.editControls = w.content.querySelectorAll('.perm-rules input, .perm-rules select, .perm-rules textarea, .perm-rules [contenteditable]').length;
        out.readsAfterBroadcast = out.reads;
        // …and a record only answers the question it was ASKED. Change the
        // session's cwd underneath and the held tree must be DROPPED, not
        // relabelled onto a different question.
        s.cwd = '/tmp/somewhere-else';
        [...window.app.ws.globalHandlers].forEach((h) => { try { h({ type: 'active-sessions', sessions: [] }); } catch (e) { } });
        await sleep(900);
        out.layersAfterCwdChange = w.content.querySelectorAll('.perm-rules .perm-layer').length;
        out.labelAfterCwdChange = (btnOf() || {}).textContent || '';
        out.readsAfterCwdChange = out.reads;
      } finally {
        window.fetch = realFetch;
        try { document.getElementById('pr-rerender-sentinel').remove(); } catch (e) { }
        for (const id of out.made) { try { window.app.wm.closeWindow(id); } catch (e) { } }
      }
      return out;
    })()`);
    check('375×667 RE-RENDER PIN: an active-sessions broadcast really rebuilt the body (the sentinel is gone) — so the next assert is a measurement, not a no-op',
      !rerender.error && rerender.layersAfterClick >= 1 && rerender.sentinelSurvived === false, JSON.stringify(rerender));
    check('375×667 RE-RENDER PIN: …and the loaded tree SURVIVES it, layer-for-layer, with the button still saying "Reload rules"',
      !rerender.error && rerender.layersAfterBroadcast === rerender.layersAfterClick && rerender.rulesAfterBroadcast >= 3
      && /Reload rules/.test(rerender.labelAfterBroadcast || '') && rerender.editControls === 0, JSON.stringify(rerender));
    check('375×667 RE-RENDER PIN: it survives by RE-RENDERING the held record — the broadcast asks the server (and, on codex, the agent) NOTHING',
      !rerender.error && rerender.readsAfterClick === 1 && rerender.readsAfterBroadcast === 1, JSON.stringify(rerender));
    check('NEGATIVE CONTROL: change the question (the session\'s cwd) and the held tree is DROPPED back to "Show rules…" — a tree answers ONE query, and nothing re-fetches on its own',
      !rerender.error && rerender.layersAfterCwdChange === 0 && /Show rules/.test(rerender.labelAfterCwdChange || '')
      && rerender.readsAfterCwdChange === 1, JSON.stringify(rerender));

    // A broadcast landing WHILE the read is in flight detaches the tree, and
    // loadInto correctly refuses to paint a detached node — so the answer
    // would be held and never shown. It must repaint from the held record,
    // still without a second fetch.
    const inflight = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelectorAll('.modal-overlay, #perm-rules-dialog, #local-oracle-dialog').forEach((e) => e.remove());
      const out = { made: [], reads: 0 };
      const realFetch = window.fetch;
      window.fetch = function (u) {
        const isRead = String(u).includes('/api/permission-rules');
        if (isRead) out.reads++;
        const p = realFetch.apply(this, arguments);
        return isRead ? p.then(async (r) => { await sleep(1200); return r; }) : p;
      };
      try {
        const s = { sessionId: 'pr-inflight', webuiId: 'pr-inflight', backend: 'claude', mode: 'chat',
                    cwd: '/tmp', name: 'perm-rules inflight probe', status: 'live' };
        const w = window.app.openSessionProps(s);
        if (!w) return { error: 'openSessionProps returned nothing' };
        out.made.push(w.id);
        const btnOf = () => [...w.content.querySelectorAll('button')].find((b) => /Show rules|Reload rules/.test(b.textContent));
        const btn = btnOf();
        if (!btn) return { error: 'no rules button' };
        btn.click();
        await sleep(150);                                   // still reading
        [...window.app.ws.globalHandlers].forEach((h) => { try { h({ type: 'active-sessions', sessions: [] }); } catch (e) { } });
        await sleep(500);                                   // the rebuild happened mid-flight
        out.detachedMidFlight = w.content.querySelectorAll('.perm-rules .perm-layer').length === 0;
        for (let i = 0; i < 80; i++) { if (w.content.querySelector('.perm-rules .perm-layer')) break; await sleep(150); }
        out.layers = w.content.querySelectorAll('.perm-rules .perm-layer').length;
        out.label = (btnOf() || {}).textContent || '';
      } finally {
        window.fetch = realFetch;
        for (const id of out.made) { try { window.app.wm.closeWindow(id); } catch (e) { } }
      }
      return out;
    })()`);
    check('375×667 RE-RENDER PIN: a broadcast DURING the read does not lose the answer — it lands on the rebuilt section, from the held record, with no second fetch',
      !inflight.error && inflight.detachedMidFlight === true && inflight.layers >= 1
      && /Reload rules/.test(inflight.label || '') && inflight.reads === 1, JSON.stringify(inflight));

    try { ws.close(); } catch { }
  }
  cleanup();
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
