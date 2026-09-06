#!/usr/bin/env node
// ARCHITECTURE CONFORMANCE (2.323.0, owner directive "更强有力的手段保证分离"):
// the three-tier separation is enforced STRUCTURALLY, not by documentation —
// the vendor-whitelist mechanic generalized to the whole dependency graph.
// Any new cross-tier require FAILS this suite until it is DELIBERATELY added
// to an allowlist below with a reason. Documentation rots; a red test does not.
//
// TIERS (docs/design-three-tier.md):
//   DEVICE     src/agentd/agentd.js + mux/reexec/ws-min — runs on EVERY machine
//   SHARED     fact modules the daemon bundles — one implementation per concern
//   PURE       decision modules — no I/O AT ALL (safe in any process, incl. browser)
//   ORCH       server.js, hosts.js, ws-handler.js, routes/* — this instance only
//   CLIENT     src/lib/** — the browser
//
// RULES (direction of knowledge): DEVICE/SHARED/PURE know nothing of ORCH or
// CLIENT. ORCH may use everything below it. CLIENT may use only PURE (via the
// esbuild bundle) — never ORCH internals.
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');
const read = (f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf-8'); } catch { return ''; } };
function requiresOf(f) {
  const s = read(f);
  const out = new Set();
  for (const m of s.matchAll(/require\(['"]([^'"]+)['"]\)/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g)) out.add(m[1]); // re-exports are imports too
  return [...out];
}
const resolveRel = (from, spec) => {
  if (!spec.startsWith('.')) return null; // builtin or package
  let p = path.normalize(path.join(path.dirname(from), spec)).replace(/\\/g, '/');
  if (!p.endsWith('.js') && fs.existsSync(path.join(REPO, p + '.js'))) p += '.js';
  return p;
};

// ── Tier membership (path-based; NEW files inherit their directory's tier) ──
const PURE = new Set(['src/plugin-manifest.js', 'src/account-pool-auto.js', 'src/model-family.js', 'src/task-color-seq.js', 'src/ssh-key-format.js', 'src/session-schema.js', 'src/otel-truth.js', 'src/msg-acl.js', 'src/backend-caps.js',
  'src/search-card.js']); // web-search card renderer + title query + twin key — shared server (codex normalizer) + browser (chat-renderers)
const SHARED = new Set(['src/discovery-facts.js', 'src/sysinfo.js', 'src/machine-probes.js', 'src/usage-walker.js',
  'src/transcript-service.js', 'src/ctx-sync.js', 'src/writer-sweep.js', 'src/remote-shell.js', 'src/account-material.js',
  'src/session-store.js', 'src/codex-session-store.js', 'src/normalizers.js', 'src/message-manager.js',
  'src/codex-message-manager.js', 'src/adapters/base.js', 'src/adapters/claude-code.js', 'src/adapters/codex.js',
  'src/adapters/shell.js', 'src/adapters/index.js', 'src/usage-estimator.js', 'src/usage-anchors.js', 'src/safe-fs.js',
  'src/transcript-worker.js', 'src/ssh-key.js', 'src/migration-runner.js', 'src/peer-messaging.js',
  // rate-limit-capture is fs/path-only by design ("so the device daemon can bundle it") — SHARED, not ORCH
  'src/rate-limit-capture.js',
  // harness descriptors (docs/design-harness-plugins.md §2.2): declarations + pure hooks over SHARED parsers;
  // the daemon may bundle them (S5 kept the stream CONSUMERS in ORCH under src/server/stdout/ — descriptors only NAME the protocol) — they must never reach up into ORCH
  'src/harnesses/index.js', 'src/harnesses/claude.js', 'src/harnesses/codex.js', 'src/harnesses/shell.js',
  'src/harnesses/claude-quota.js', 'src/harnesses/codex-quota.js', 'src/harnesses/null-quota.js',
  // ACP v1 harness (S8): generic descriptor factory + first agent, adapter, normalizer (+ store reader)
  'src/harnesses/acp.js', 'src/harnesses/opencode.js', 'src/adapters/acp.js', 'src/acp-message-manager.js',
  // codex 0.153 thread/read fallback (B-21e4 item 5): pure Thread→records mapper + one bounded app-server read; node builtins only
  'src/codex-thread-read.js',
  // OpenCode serve-mode store facts (S9): 127.0.0.1 client + locator/keeper + 'acp-events' synthesis — facts about a machine
  'src/opencode-serve.js']);
const DEVICE = new Set(['src/agentd/agentd.js', 'src/agentd/mux.js', 'src/agentd/reexec.js', 'src/agentd/version.js', 'src/agentd/ws-min.js']);
const ORCH_FILES = ['server.js', 'src/hosts.js', 'src/ws-handler.js', 'src/ws-create.js', 'src/agentd/client.js'];
const isOrch = (p) => p === 'server.js' || p === 'src/ws-handler.js' || p === 'src/ws-create.js' || p === 'src/hosts.js' || p === 'src/agentd/client.js'
  || p.startsWith('src/routes/') || p.startsWith('src/server/') || ['src/mounts.js', 'src/accounts.js', 'src/task-groups.js', 'src/usage-history.js',
    'src/usage-routes.js', 'src/agent-routes.js', 'src/session-status.js', 'src/user-todos.js', 'src/webdav.js', 'src/vnc.js',
    'src/auth.js', 'src/clerk-auth.js', 'src/telemetry.js', 'src/opslog.js', 'src/incident.js', 'src/remote-fs.js',
    'src/machine-mounts.js', 'src/exit-proxy.js', 'src/port-forward.js', 'src/plugins.js', 'src/gmail-sync.js',
    'src/sync-store.js', 'src/conversation-index.js'].includes(p);
const isClient = (p) => p.startsWith('src/lib/') || p === 'src/client.js';

// Deliberate exceptions — each with a reason (the vendor-whitelist mechanic).
const EXCEPTIONS = new Map([
  // client bundles PURE modules directly (CJS pulled into esbuild) — by design
  ['src/lib/utils.js->src/task-color-seq.js', 'pure module, shared server+browser by design (re-exported)'],
  ['src/lib/sidebar-mounts.js->src/ssh-key-format.js', 'pure module, shared server+browser by design'],
]);

// 1) PURE modules: zero requires of ANY kind beyond other PURE modules.
for (const f of PURE) {
  const reqs = requiresOf(f);
  const badBuiltin = reqs.filter((r) => !r.startsWith('.'));
  const badRel = reqs.map((r) => resolveRel(f, r)).filter((p) => p && !PURE.has(p));
  ok(!badBuiltin.length && !badRel.length, `PURE ${f} imports nothing but pure (${badBuiltin.join(',') || badRel.join(',') || 'clean'})`);
}

// 2) SHARED modules: may use node builtins + PURE + other SHARED — never ORCH/CLIENT/DEVICE.
for (const f of SHARED) {
  const bad = requiresOf(f).map((r) => resolveRel(f, r)).filter((p) => p && (isOrch(p) || isClient(p) || DEVICE.has(p)));
  ok(!bad.length, `SHARED ${f} never reaches up (${bad.join(',') || 'clean'})`);
}

// 3) DEVICE tier: only SHARED + PURE + its own files. Reaching into the
//    orchestrator from the daemon is the exact re-coupling this suite exists
//    to prevent — the daemon runs on machines that have no orchestrator.
for (const f of DEVICE) {
  const bad = requiresOf(f).map((r) => resolveRel(f, r)).filter((p) => p && !SHARED.has(p) && !PURE.has(p) && !DEVICE.has(p));
  ok(!bad.length, `DEVICE ${f} pulls only shared/pure/device (${bad.join(',') || 'clean'})`);
}

// 4) CLIENT: never imports ORCH or DEVICE modules (ws/HTTP is the ONLY channel).
const libFiles = fs.readdirSync(path.join(REPO, 'src/lib')).filter((x) => x.endsWith('.js')).map((x) => 'src/lib/' + x);
let clientBad = [];
for (const f of [...libFiles, 'src/client.js']) {
  for (const r of requiresOf(f)) {
    const p = resolveRel(f, r);
    if (!p) continue;
    if ((isOrch(p) || DEVICE.has(p) || SHARED.has(p)) && !EXCEPTIONS.has(`${f}->${p}`)) clientBad.push(`${f} -> ${p}`);
  }
}
ok(!clientBad.length, `CLIENT talks to the server over the wire only (${clientBad.slice(0, 4).join('; ') || 'clean'})`);

// 5) the daemon BUNDLE self-containment: build output must exist and must not
//    mention orchestrator filenames (a bundled hosts.js would mean the device
//    tier swallowed the orchestrator).
const bundle = read('data/bin/vibespace-agentd.js');
ok(bundle.length > 0, 'daemon bundle exists');
// match module MARKERS (esbuild emits '// src/<path>' banners per bundled
// file), not free text — comments legitimately mention orchestrator names
ok(!/\/\/ src\/ws-handler\.js|\/\/ src\/ws-create\.js|\/\/ src\/hosts\.js|\/\/ server\.js/.test(bundle), 'daemon bundle contains no orchestrator modules');

// 6) server.js is BOOTSTRAP + WIRING only (2.325.0 decomposition terminal
//    state: 6423 → ~1900 lines, mechanisms live in src/server/*). The budget
//    is a ratchet — new server-side code goes in a src/server module (see the
//    CLAUDE.md routing table), never back into server.js. If a legitimate
//    wiring stanza pushes past the budget, raise it deliberately in the same
//    commit that explains why.
{
  const serverLines = read('server.js').split('\n').length;
  ok(serverLines <= 2100, `server.js stays bootstrap-sized (${serverLines} ≤ 2100 lines — new mechanisms go in src/server/*)`);
  const mods = fs.readdirSync(path.join(REPO, 'src/server')).filter((f) => f.endsWith('.js'));
  ok(mods.length >= 14, `src/server/ holds the decomposed modules (${mods.length} ≥ 14)`);
}

// 7) freeze the exceptions list: an exception nobody uses anymore must be
//    removed (dead allowlist entries hide future violations behind them).
for (const [edge] of EXCEPTIONS) {
  const [from, to] = edge.split('->');
  const live = requiresOf(from).map((r) => resolveRel(from, r)).includes(to);
  ok(live, `exception still in use: ${edge} (remove dead allowlist entries)`);
}

// 8) every RELATIVE require/import must RESOLVE to an existing file (2.341.1,
//    userW's mount outage — 6th lost-binding incident, first of the
//    RELATIVE-PATH subclass: extraction #13 carried server.js's
//    require('./package.json') into src/server/dial-pairing.js where it
//    resolves to nothing and throws only when a dial op RUNS. Free-variable
//    checks, boot smokes and the route battery all miss a call-time require
//    with a bad relative path; this static walk cannot.)
{
  const allFiles = ['server.js'];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(REPO, dir))) {
      const p = dir + '/' + e;
      if (fs.statSync(path.join(REPO, p)).isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e)) allFiles.push(p);
    }
  })('src');
  const broken = [];
  for (const f of allFiles) {
    const s = read(f);
    for (const m of s.matchAll(/(?:require\(|from\s+)['"](\.[^'"]+)['"]/g)) {
      const base = path.normalize(path.join(path.dirname(f), m[1])).replace(/\\/g, '/');
      const cands = [base, base + '.js', base + '.json', base + '.mjs', base + '/index.js'];
      if (!cands.some((c) => fs.existsSync(path.join(REPO, c)))) broken.push(`${f}: ${m[1]}`);
    }
  }
  ok(!broken.length, `every relative require/import resolves (${broken.slice(0, 3).join('; ') || 'all resolve'})`);
}

// 9) SERVER-side private methods that are CALLED must be DEFINED in-file
//    (2.343.1, the _notify incident: a dead-code sweep deleted PluginManager's
//    _notify() while 8 call sites remained — every plugin broadcast and the
//    publish path threw for weeks; no battery saw a call-time method miss).
//    Scoped to server tiers only — src/lib uses prototype mixins (methods
//    defined across files) and would false-positive.
{
  const svFiles = allFilesFor9().filter((f) => !f.startsWith('src/lib/'));
  const broken = [];
  for (const f of svFiles) {
    const s9 = read(f);
    const called = new Set([...s9.matchAll(/this\.(_[a-zA-Z0-9]+)\(/g)].map((m) => m[1]));
    for (const name of called) {
      const woCalls = s9.replace(new RegExp(`this\\.${name}\\(`, 'g'), '');
      const defined = new RegExp(`(^|\\s)${name}\\s*\\(`, 'm').test(woCalls) || new RegExp(`this\\.${name}\\s*=`).test(s9) || new RegExp(`${name}\\s*:`).test(s9);
      if (!defined) broken.push(`${f}: this.${name}() called but never defined`);
    }
  }
  ok(!broken.length, `server-side private methods are defined where called (${broken.slice(0, 3).join('; ') || 'clean'})`);
  function allFilesFor9() {
    const out = ['server.js'];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(REPO, dir))) {
        const p9 = dir + '/' + e;
        if (fs.statSync(path.join(REPO, p9)).isDirectory()) walk(p9);
        else if (p9.endsWith('.js')) out.push(p9);
      }
    })('src');
    return out;
  }
}

// 41. Settings bounds/defaults have ONE home (inc-mt0mozsp): the Manage
//     Agents instructions tab carried a hardcoded pre-2.210.0 copy of the
//     stop-nudge bounds ([min 1/2] + `Number(v) || dflt`) that silently
//     reverted an explicit 0 ("every stop" mode) back to 10/30. UI code must
//     read SETTINGS_SCHEMA, never re-declare a schema row's numbers inline.
{
  const ma = read('src/lib/manage-agents.js');
  ok(!/stopNudge\w*Minutes'\s*:\s*\[/.test(ma) && ma.includes('SETTINGS_SCHEMA[key]'),
    'manage-agents reads stop-nudge bounds from SETTINGS_SCHEMA (no hardcoded twin)');
  ok(!/Number\(inp\.value\)\s*\|\|/.test(ma),
    'no falsy-default coalescing on number inputs (explicit 0 is a valid value)');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
