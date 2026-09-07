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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  'src/search-card.js', // web-search card renderer + title query + twin key — shared server (codex normalizer) + browser (chat-renderers)
  'src/collab-row.js']); // codex multi-agent collab row labels/HTML — esc/t/icons injected, so the XSS rule is unit-provable
const SHARED = new Set(['src/discovery-facts.js', 'src/sysinfo.js', 'src/machine-probes.js', 'src/usage-walker.js',
  'src/transcript-service.js', 'src/ctx-sync.js', 'src/writer-sweep.js', 'src/remote-shell.js', 'src/account-material.js',
  // THE agent-CLI process identity, one rule in two spellings (B-3185 r3): the JS twin
  // (discovery-facts, so the daemon bundles it) beside the shell text the sweep and the
  // ssh discovery CO leg embed verbatim. node builtins only.
  'src/cli-identity.js',
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

// 42. NO CONTROL BYTES IN SOURCE (steer-all round 4). Two raw NUL bytes — one
//     used as the separator inside a Map key, one echoed in the comment above
//     it — made src/codex-session-store.js BINARY: file(1) called it "data",
//     `grep -n USER_RETRACTION_EVENT` on the very file that DEFINES that
//     constant printed nothing at all, and ripgrep answered "binary file
//     matches" with no line. Every search-driven read of that module — a
//     review, an incident, a twin sweep — silently skipped it. A separator
//     that cannot collide with the data is fine; spelling it as a raw byte
//     instead of the escape (byte-identical at runtime) is not.
//
//     ROUND 5 — THE CENSUS READS SOURCE, NOT THE WORKING TREE. Round 4 walked
//     the three roots with readdirSync, but data/bin is exactly where the
//     PRODUCT installs its own runtime artifacts: installRclone() drops a
//     64 MB arch-specific `rclone` there (gitignored since 2.368.9) plus
//     rclone-dl.zip, and boot generates vibespace-status and the agentd
//     bundle. Byte 7 of that download is a NUL, so the census turned
//     `npm run build` RED on every instance that had ever used a storage
//     mount — and this build is not optional: it is the pre-push release gate
//     AND the in-app "Update VibeSpace…" step, so the service never
//     restarted. `git ls-files` answers "what is SOURCE" structurally, which
//     puts every gitignored runtime artifact out of scope BY CONSTRUCTION
//     rather than by an extension blocklist the next 64 MB download would
//     evade again (432 tracked files: ~3 ms to LIST, ~25 ms to read the
//     9.3 MB of source — where the walk it replaces also read that 64 MB
//     binary in full just to look at byte 7). No git metadata
//     (tarball / git-archive / npm pack) ⇒ the source list is unknowable ⇒
//     SKIP with a reason: a census may decline to run, but it must never fail
//     a build over files it was never meant to read.
{
  // A legitimately binary FIXTURE is not source; everything else in these
  // trees is text by construction (the census at the time: .js .mjs .sh .json
  // .jsonl .ps1 plus the extension-less agent CLIs in data/bin).
  const BINARY_EXT = new Set(['.zst', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.wasm', '.pdf', '.zip', '.tar']);
  const CENSUS_ROOTS = ['src', 'data/bin', 'scripts'];
  // The tracked-source listing for a tree, or null when git cannot answer FOR
  // THAT TREE (no git binary, no metadata, or `base` is not itself the work
  // tree root — a tmpdir that happens to sit inside some other repo must not
  // borrow that repo's index).
  const trackedSource = (base) => {
    try {
      const top = spawnSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
      if (top.error || top.status !== 0) return null;
      if (fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(base)) return null;
    } catch { return null; }
    const ls = spawnSync('git', ['-C', base, 'ls-files', '-z', '--', ...CENSUS_ROOTS], { maxBuffer: 64 * 1024 * 1024 });
    if (ls.error || ls.status !== 0 || !ls.stdout) return null;
    return ls.stdout.toString('utf-8').split('\0').filter(Boolean);
  };
  const census = (base) => {
    const files = trackedSource(base);
    if (!files) return null; // the caller SKIPS — never fails
    const offenders = [];
    for (const f of files) {
      if (BINARY_EXT.has(path.extname(f).toLowerCase())) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(base, f)); } catch { continue; } // tracked but absent from the work tree
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${f} (byte ${at}, line ${buf.slice(0, at).toString('utf-8').split('\n').length})`);
    }
    return { files, offenders };
  };

  const c42 = census(REPO);
  if (!c42) {
    ok(true, 'NUL-byte census SKIPPED: this tree has no readable git index (export/tarball) — the source list is unknowable, and a census never fails a build over files it cannot scope');
  } else {
    ok(!c42.offenders.length,
      `no source file carries a NUL byte — one makes the WHOLE file invisible to grep/rg (${c42.files.length} tracked files; ${c42.offenders.slice(0, 3).join('; ') || 'clean'})`);
    // SCOPE PIN: a mis-scoped listing (wrong roots, wrong repo, renamed tree)
    // passes VACUOUSLY. Name files the census MUST have read — the incident's
    // own module, this suite, and a tracked extension-less data/bin CLI (the
    // root where the untracked artifacts live).
    const seen = new Set(c42.files);
    ok(seen.has('src/codex-session-store.js') && seen.has('scripts/test-architecture.mjs') && seen.has('data/bin/vibespace-task'),
      `census scope really covers src + scripts + data/bin (a vacuous listing cannot pass; ${c42.files.length} files)`);
  }

  // CONTROLS, in a throwaway repo — "source" is now defined by the INDEX, so
  // the fixture has to have one. Planted-but-untracked is the rclone class and
  // must be structurally invisible; that is the whole point of the round-5 fix.
  const tmp42 = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-nul-'));
  try {
    fs.mkdirSync(path.join(tmp42, 'src'));
    fs.mkdirSync(path.join(tmp42, 'data', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp42, 'src/clean.js'), 'const k = `a\\u0000b`; // the escape, not the byte\n');
    fs.writeFileSync(path.join(tmp42, 'src/dirty.js'), Buffer.concat([Buffer.from('const k = `a'), Buffer.from([0]), Buffer.from('b`;\n')]));
    fs.writeFileSync(path.join(tmp42, 'src/rollout.zst'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]));
    // the rclone class: an extension-less binary the PRODUCT installs into a
    // scanned root, gitignored exactly like the real one.
    fs.writeFileSync(path.join(tmp42, '.gitignore'), 'data/bin/rclone\n');
    fs.writeFileSync(path.join(tmp42, 'data/bin/rclone'), Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(2048)]));
    // ...and an untracked source file, to prove the gate is the INDEX and not .gitignore.
    fs.writeFileSync(path.join(tmp42, 'src/untracked.js'), Buffer.concat([Buffer.from('x'), Buffer.from([0]), Buffer.from('\n')]));

    ok(census(tmp42) === null,
      'CONTROL: a tree with no git metadata SKIPS (unknowable source list is not a build failure — the tarball/export case)');

    const init = spawnSync('git', ['-C', tmp42, 'init', '-q'], { encoding: 'utf-8' });
    // -f so a developer's global core.excludesFile (e.g. a blanket *.zst) can
    // never quietly shrink the control — we still never add data/bin/rclone.
    const add = spawnSync('git', ['-C', tmp42, 'add', '-f', '--', 'src/clean.js', 'src/dirty.js', 'src/rollout.zst', '.gitignore'], { encoding: 'utf-8' });
    if (init.error || init.status !== 0 || add.status !== 0) {
      ok(true, `CONTROLS SKIPPED: git init/add unavailable here (${(init.stderr || add.stderr || init.error?.message || '').trim().slice(0, 80)})`);
    } else {
      const found = census(tmp42);
      ok(!!found && found.offenders.length === 1 && found.offenders[0].startsWith('src/dirty.js (byte 12, line 1)'),
        `CONTROL: a TRACKED NUL is found, while the \\u0000 escape and a binary fixture are not (${JSON.stringify(found && found.offenders)})`);
      ok(!!found && !found.files.some((f) => f === 'data/bin/rclone' || f === 'src/untracked.js'),
        `CONTROL: files the product installs/generates at runtime are OUT OF SCOPE — untracked never reaches the census, however big or binary (${JSON.stringify(found && found.files)})`);
    }
  } finally { try { fs.rmSync(tmp42, { recursive: true, force: true }); } catch {} }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
