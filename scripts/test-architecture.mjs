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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_REDIRECTORS, gitEnvFrom } from './git-env.mjs';

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
  'src/collab-row.js', // codex multi-agent collab row labels/HTML — esc/t/icons injected, so the XSS rule is unit-provable
  // login-session lifetime (2026-09-07): the claude harness descriptor reads the
  // credential file, this decides what the numbers MEAN; pool decisions + accounts
  // + the watcher all consume it, so it must stay dependency-free
  'src/login-expiry.js',
  // THE RESUME LADDER (B-6b6d): "the conversation's own value wins on a resume,
  // the instance default is a NEW-session default" — ONE decision for the spawn
  // (ws-create) and for what the client is allowed to send (session-lifecycle).
  'src/resume-continuity.js',
  // WHOSE NUMBERS ARE THESE (inc-mts8a8mr-ulmm): the lag shadow + the window
  // identity guard. PURE because the shipped statusline tool carries a VERBATIM
  // mirror of its core block (a checkout-less host cannot require src/), and a
  // rule with an import is a rule that cannot be mirrored.
  'src/reading-lag.js',
  // THE SPEND CEILING (design-account-hardening §4.4c / P9): the decision every
  // producer of a turn nobody typed passes through, plus `overageState` — the
  // ONE reader of the overage record, asked by the authorizer, by the pool's
  // voluntary-target rule and by BOTH quota panels. PURE so the browser can
  // bundle it and the rule is unit-provable in one place.
  'src/spend-authorizer.js',
  'src/rewind-ops.js', // claude tombstone / codex thread_rolled_back → ONE 'rewound' meta op; index-stable marking, no I/O
  // THE FRESH-WINDOW EDGE (2026-09-08): does a normalized quota reading say the
  // wall a conversation is waiting on is gone? PURE because both producers ask
  // it (claude rate_limit_event, codex rate_limits_updated) and because the
  // answer AUTHORISES A BILLED TURN — that decision must be unit-testable
  // without a server.
  'src/auto-resume-signal.js',
  'src/turn-state.js', // authoritative turn state: the live consumer and the attach reconciliation must decide identically
  'src/opencode-remote.js', // S9 remainder: the OpenCode-serve OP TABLE + runOpencodeOp — one definition the local rung, the agentd op and the shipped ssh script all obey
  'src/permission-rules.js', // READ-ONLY permission-rule model + DOM-free tree renderer (owner ruling 10) — shared server (readers) + browser (the view)
  'src/local-oracles.js', // the human-triggered zero-network CLI oracle registry + its measured proofs and REJECTED candidates (ruling 6) — server runs them, the menu mirrors them
  // THE TYPED QUOTA MODEL (B-9213/B-8b12): what a LIMIT SET is, which limit
  // governs a model, and whether a window has started. Three consumers need the
  // identical rules and only one has a checkout — the orchestrator's write path
  // + pool, the browser bundle's three quota panels, and (like reading-lag) the
  // shipped statusline tool. A rule with an import is a rule that cannot be
  // mirrored, and a second spelling of "does this bucket count" is the twin
  // class this file exists to fail.
  'src/quota-model.js']);
const SHARED = new Set(['src/discovery-facts.js', 'src/sysinfo.js', 'src/machine-probes.js', 'src/usage-walker.js',
  'src/transcript-service.js', 'src/ctx-sync.js', 'src/writer-sweep.js', 'src/remote-shell.js', 'src/account-material.js',
  // THE agent-CLI process identity, one rule in two spellings (B-3185 r3): the JS twin
  // (discovery-facts, so the daemon bundles it) beside the shell text the sweep and the
  // ssh discovery CO leg embed verbatim. node builtins only.
  'src/cli-identity.js',
  // THE ONE usage-cache write path (quota-model-v2, 2.369.86): fs/path + the PURE model +
  // lazily the harness parsers; the daemon bundles it, so it may never reach up into ORCH.
  // Listed here so a cross-tier edge fails on the classification rule itself, not only
  // transitively via the daemon-bundle marker check (round-6 verifier).
  'src/usage-cache-write.js',
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
  'src/opencode-serve.js',
  // S9 remainder (B-eac2): the LIVE lane that replaced the 10s list poll —
  // the serve's SSE stream + an fs.watch on the sqlite store (the only lane
  // that sees another opencode process). Node builtins only; the daemon
  // bundles it with opencode-serve.
  'src/opencode-events.js']);
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
  ['src/lib/usage-meter.js->src/quota-model.js', 'pure module, shared server+browser by design — the quota panels ask the SAME accessor the pool and the write path do (B-9213: an account holds several limits and the panel used to show whichever pushed last)'],
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
//
//     ROUND 6 — THE CENSUS'S OWN GIT INHERITED THE AMBIENT ENVIRONMENT. Round
//     5 answered "what is SOURCE" with git, and then ran git — read AND write
//     — with `process.env`. But git's whole repository-location layer lives in
//     the environment: GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR
//     / GIT_OBJECT_DIRECTORY / GIT_CONFIG_PARAMETERS … each one silently
//     re-points a `git -C <tmpdir> …` at a DIFFERENT repository, and this
//     suite runs inside `npm run build`, which runs inside the release gate
//     and the in-app "Update VibeSpace…" — i.e. inside hook processes that
//     export exactly those names (measured on git 2.51: a pre-commit hook is
//     handed GIT_INDEX_FILE and GIT_PREFIX; GIT_DIR is normal for any tool
//     driving a worktree). Reproduced three ways, in throwaway repos:
//     (a) GIT_DIR at a linked worktree's gitdir ⇒ the control's `git init`
//     REINITIALISED that repo and flipped core.bare=false→true in the SHARED
//     config, after which `git status` in the main checkout dies "this
//     operation must be run in a work tree" — which breaks scripts/update.sh's
//     `git pull --ff-only`, ci.mjs's green marker, and (see the SKIP note
//     below) makes the census itself SKIP green forever; this happened to the
//     production checkout and was repaired by hand. (b) GIT_INDEX_FILE at
//     another repo's index ⇒ the REPO census read the FOREIGN listing (432
//     files → 1) so the suite went RED describing a tree that is not ours,
//     while `git add -f` staged the raw-NUL fixture into that repo and
//     replaced its .gitignore entry. (c) plain repo + GIT_DIR ⇒ the fixture is
//     staged there too. The fix is ONE sanitized environment used by EVERY git
//     this suite spawns; the explicit --git-dir/--work-tree on the write side
//     is belt-and-braces only, because it is NOT sufficient: measured,
//     `git --git-dir=A --work-tree=A add` under GIT_INDEX_FILE=B/.git/index
//     still writes B's index. A test that has to run inside someone else's
//     process must NAME the environment it runs its own tools in.
//
//     ROUND 6b — A SKIP MUST QUOTE THE FAILURE, NOT GUESS THE CAUSE. The skip
//     line asserted "no readable git index (export/tarball)" without ever
//     checking that. A checkout whose core.bare was flipped TRUE prints the
//     same green line even though `git ls-files` there answers perfectly (only
//     `rev-parse --show-toplevel` dies, because bare means "no work tree") —
//     so the accident above disabled the census AND told everyone the tree was
//     a tarball. Now: --show-toplevel failing falls back to `rev-parse
//     --git-dir` (ownership = <base>/.git is itself a repository entry, so a
//     tmpdir merely sitting INSIDE another repo still cannot borrow that
//     index), and every skip carries git's own failing command + its stderr.
//
//     ROUND 7a — THE NEGATIVE CONTROL WAS STILL RUNNING IN SOMEONE ELSE'S
//     ENVIRONMENT. Round 6 sanitized every git EXCEPT the one whose whole job
//     is to be unsanitized: the RAW leg that proves the sanitizer matters. It
//     built its `git add -f` env as `{ ...process.env, GIT_DIR, GIT_WORK_TREE,
//     GIT_INDEX_FILE }` — three of the 25 names GIT_REDIRECTORS enumerates
//     pinned, the other 22 still ambient. Measured, in throwaway repos: with
//     GIT_OBJECT_DIRECTORY (or GIT_COMMON_DIR) exported at a third repository,
//     that write puts its blobs THERE — a repo this suite was never pointed at
//     — and `npm run build` stays green while doing it; and when the same
//     ambient name points somewhere unwritable (a nonexistent dir, a 0500 dir)
//     or at a non-repo, `npm run build` goes RED on the line "the guarded
//     assert above is the sanitizer working, not the controls failing to run"
//     — a message that accuses the sanitizer of a failure caused by a variable
//     nobody in this file ever named. A negative control is a control: it may
//     differ from the guarded run in exactly ONE named way. So the raw leg's
//     env is now the SANITIZED base plus exactly the three decoy redirectors
//     it is testing, and `repoStamp` hashes the WHOLE .git tree (round 6's
//     config/index/HEAD stamp could not see the object channel at all, which
//     is precisely the channel those two names steer). The block's own
//     negative control for THIS finding is a third repository: the two names
//     really are exported into our process for the whole block, and it must be
//     byte-identical afterwards — with a sacrificial fourth repo proving the
//     pre-fix base still reaches one (i.e. that the environment is genuinely
//     hostile and the stamp genuinely detects the write).
//
//     ROUND 7b — THE SENTENCE OVERCLAIMED ITS SCOPE. "no source file carries a
//     NUL byte" was measured over `git ls-files -- src data/bin scripts`, i.e.
//     432 of the repository's 556 tracked files. The 124 outside included
//     server.js (the bootstrap this very suite ratchets), install.sh, run.sh,
//     editor-helper.sh, deploy/docker/*.sh, docs/screenshot-helper.js and
//     docs/examples/hello-plugin/server.js — every one of them a file a human
//     greps. The roots were never the point (the point was "tracked", which is
//     what puts the 64 MB rclone out of scope), so the pathspec is gone: the
//     census reads EVERY tracked file, and the scope pin now names server.js
//     and install.sh alongside the three root witnesses.
{
  // A legitimately binary FIXTURE is not source; everything else in the index
  // is text by construction. Measured 2026-09-07 over all 556 tracked files:
  // 24 are skipped by extension (4 .png screenshots + 20 .woff2 fonts) and 0
  // of the remaining 532 carry a NUL. A NEW binary fixture ⇒ add its extension
  // here WITH a comment naming the file; never a directory exclusion (the
  // tracked CLIs in data/bin must stay in scope).
  const BINARY_EXT = new Set(['.zst', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.wasm', '.pdf', '.zip', '.tar']);

  const tmpDirs = [];
  const mkTmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `arch-nul-${tag}-`)); tmpDirs.push(d); return d; };
  // A repo's on-disk identity, byte-exact: EVERY file under .git, content-
  // hashed (round 7 — the old ['config','index','HEAD'] stamp was blind to
  // .git/objects, and the object store is exactly what GIT_OBJECT_DIRECTORY
  // and GIT_COMMON_DIR re-point). Anything a redirected git touches shows up.
  const repoStamp = (repo) => {
    const out = [];
    const walk = (dir, rel) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { out.push(`${rel || '.'}/:<unreadable:${e.code}>`); return; }
      for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else { try { out.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); } catch (err) { out.push(`${r}:<unreadable:${err.code}>`); } }
      }
    };
    walk(path.join(repo, '.git'), '');
    return JSON.stringify(out);
  };

  // ── THE ONE SANITIZED GIT ENVIRONMENT (round 6) ──────────────────────────
  // Audited against git 2.51's own documented GIT_* list (git(1) "ENVIRONMENT
  // VARIABLES", gitrepository-layout(5), git-config(1)). We DELETE every name
  // that can re-point git at another repository, index, object store or config
  // — the config channels included, because `core.bare` / `core.worktree` /
  // `safe.directory` injected through them reach the same place indirectly.
  // We deliberately KEEP: PATH and the rest of the process env (we want the
  // machine's real git and its real ~/.gitconfig — the controls pass `-f` so a
  // global core.excludesFile still cannot shrink them); GIT_CONFIG_NOSYSTEM
  // and GIT_ATTR_NOSYSTEM (they only REMOVE ambient system files — strictly
  // more isolation, never less); GIT_EXEC_PATH (it belongs to the git on PATH);
  // GIT_AUTHOR_*/GIT_COMMITTER_*/GIT_EDITOR/GIT_PAGER/GIT_TERMINAL_PROMPT and
  // the GIT_TRACE* diagnostics (this suite never commits, never opens an
  // editor and never touches a network, so none of them can steer it).
  //
  // THE LIST AND THE FILTER NOW LIVE IN scripts/git-env.mjs (the fast/heavy
  // gate split, 2026-09-07): the pre-push hook DETACHES a heavy gate run, and
  // that child inherits the hook's git environment exactly like this suite
  // does — two spellings of "which names re-point git" would be two behaviours
  // the moment either is touched. This block's controls below still prove the
  // shared filter on real repositories, so the import is covered, not assumed.

  // ── ROUND 7: THIS BLOCK REALLY RUNS IN A HOSTILE ENVIRONMENT ─────────────
  // The suite cannot re-exec itself, so it exports the two redirectors that
  // own git's OBJECT channel — the ones round 6's stamp could not see and the
  // raw leg left ambient — into its own process, aimed at a throwaway repo,
  // for the whole of the block below. Every git spawned from here on is
  // therefore running with GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR set at a
  // repository nobody names on any command line; the assert at the end of the
  // block is that it is byte-identical. Created BEFORE the injection, with an
  // env sanitized by the same function, so the fixture itself cannot be bent.
  let ambientThird = null, ambientBefore = null;
  const ambientSaved = new Map();
  const restoreAmbient = () => {
    for (const [k, v] of ambientSaved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    ambientSaved.clear();
  };
  {
    const bootEnv = gitEnvFrom(process.env);
    const d = mkTmp('ambient-third');
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src/third.js'), 'const third = 1;\n');
    const i = spawnSync('git', ['init', '-q', d], { cwd: d, encoding: 'utf-8', env: bootEnv });
    const a = (!i.error && i.status === 0)
      ? spawnSync('git', ['--git-dir', path.join(d, '.git'), '--work-tree', d, 'add', '-A'], { cwd: d, encoding: 'utf-8', env: bootEnv })
      : { status: 1 };
    if (!i.error && i.status === 0 && a.status === 0) {
      ambientThird = d;
      for (const [k, v] of [['GIT_OBJECT_DIRECTORY', path.join(d, '.git', 'objects')], ['GIT_COMMON_DIR', path.join(d, '.git')]]) {
        ambientSaved.set(k, process.env[k]);
        process.env[k] = v;
      }
      ambientBefore = repoStamp(d);
    }
  }

  const GIT_ENV = gitEnvFrom(process.env);
  // EVERY git in this block goes through these, read side and write side.
  const gitIn = (base, args, env = GIT_ENV, opts = {}) =>
    spawnSync('git', ['-C', base, ...args], { encoding: 'utf-8', env, ...opts });
  const gitWhy = (r) => (!r ? '(not run)' : r.error
    ? `spawn failed: ${r.error.code || r.error.message}`
    : `exit ${r.status}: ${String(r.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 160) || '(no stderr)'}`);
  const samePath = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };

  // The tracked-source listing for a tree: { files } when git can answer FOR
  // THAT TREE, else { skip: <git's own failing command + stderr> }. Ownership
  // matters because a tmpdir that happens to sit inside some other repo must
  // never borrow that repo's index.
  const trackedSource = (base, env = GIT_ENV) => {
    let owns = false, why = '';
    const top = gitIn(base, ['rev-parse', '--show-toplevel'], env);
    if (!top.error && top.status === 0) {
      owns = samePath(top.stdout.trim(), base);
      if (!owns) why = `git -C <base> rev-parse --show-toplevel → ${JSON.stringify(top.stdout.trim())}, which is not <base> (a tmpdir inside someone else's repo may not borrow its index)`;
    } else {
      // core.bare=true kills --show-toplevel ("must be run in a work tree")
      // while leaving the index perfectly readable. Ask for the git dir.
      const gd = gitIn(base, ['rev-parse', '--git-dir'], env);
      let entry = false; try { entry = fs.existsSync(path.join(base, '.git')); } catch {}
      if (!gd.error && gd.status === 0 && entry) owns = true;
      else why = `git -C <base> rev-parse --show-toplevel: ${gitWhy(top)}; --git-dir: ${gitWhy(gd)}${entry ? '' : '; and <base>/.git is not a repository entry'}`;
    }
    if (!owns) return { skip: why };
    // NO PATHSPEC (round 7): "source" is defined by the INDEX, not by a list of
    // directories — the roots were an unstated 432-of-556 sample that quietly
    // excluded server.js, install.sh, run.sh and every deploy/docs script.
    const ls = gitIn(base, ['ls-files', '-z'], env, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    if (ls.error || ls.status !== 0) return { skip: `git -C <base> ls-files: ${gitWhy(ls)}` };
    return { files: (ls.stdout ? ls.stdout.toString('utf-8') : '').split('\0').filter(Boolean) };
  };
  const census = (base, env = GIT_ENV) => {
    const t = trackedSource(base, env);
    if (t.skip) return t; // the caller SKIPS — never fails
    const offenders = [];
    for (const f of t.files) {
      if (BINARY_EXT.has(path.extname(f).toLowerCase())) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(base, f)); } catch { continue; } // tracked but absent from the work tree
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${f} (byte ${at}, line ${buf.slice(0, at).toString('utf-8').split('\n').length})`);
    }
    return { files: t.files, offenders };
  };

  const c42 = census(REPO);
  if (c42.skip) {
    ok(true, `NUL-byte census SKIPPED — the tracked-source listing is genuinely unobtainable here, and a census must never fail a build over files it cannot scope; git's own words: ${c42.skip}`);
  } else {
    ok(!c42.offenders.length,
      `no TRACKED file carries a NUL byte — one makes the WHOLE file invisible to grep/rg (${c42.files.length} tracked files, whole index; ${c42.offenders.slice(0, 3).join('; ') || 'clean'})`);
    // SCOPE PIN: a mis-scoped listing (wrong pathspec, wrong repo, renamed
    // tree) passes VACUOUSLY. Name files the census MUST have read — the
    // incident's own module, this suite, a tracked extension-less data/bin CLI
    // (the root where the untracked artifacts live), and two files that live
    // in NEITHER of the old roots: the bootstrap this suite ratchets, and the
    // installer every new checkout runs.
    const seen = new Set(c42.files);
    const pins = ['src/codex-session-store.js', 'scripts/test-architecture.mjs', 'data/bin/vibespace-task', 'server.js', 'install.sh'];
    ok(pins.every((f) => seen.has(f)),
      `census scope really is the WHOLE index — src + scripts + data/bin AND the root files outside them (a vacuous listing cannot pass; ${c42.files.length} files; missing: ${JSON.stringify(pins.filter((f) => !seen.has(f)))})`);
  }

  // ── CONTROLS, in throwaway repos ─────────────────────────────────────────
  // "Source" is defined by the INDEX, so the fixture has to have one.
  // Planted-but-untracked is the rclone class and must be structurally
  // invisible; that is the whole point of the round-5 fix.
  const plantFixture = (dir) => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/clean.js'), 'const k = `a\\u0000b`; // the escape, not the byte\n');
    fs.writeFileSync(path.join(dir, 'src/dirty.js'), Buffer.concat([Buffer.from('const k = `a'), Buffer.from([0]), Buffer.from('b`;\n')]));
    fs.writeFileSync(path.join(dir, 'src/rollout.zst'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]));
    // the rclone class: an extension-less binary the PRODUCT installs into a
    // scanned root, gitignored exactly like the real one.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/bin/rclone\n');
    fs.writeFileSync(path.join(dir, 'data/bin/rclone'), Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(2048)]));
    // ...and an untracked source file, to prove the gate is the INDEX and not .gitignore.
    fs.writeFileSync(path.join(dir, 'src/untracked.js'), Buffer.concat([Buffer.from('x'), Buffer.from([0]), Buffer.from('\n')]));
  };
  // WRITE SIDE: the target repo is named on the command line (positional dir
  // for init, --git-dir/--work-tree for add/config) AND cwd is that repo AND
  // the env is sanitized. Only the last of the three defeats GIT_INDEX_FILE.
  const initRepo = (repo, env = GIT_ENV) =>
    spawnSync('git', ['init', '-q', repo], { cwd: repo, encoding: 'utf-8', env });
  // -f so a developer's global core.excludesFile (e.g. a blanket *.zst) can
  // never quietly shrink the control — we still never add data/bin/rclone.
  const addFixture = (repo, env = GIT_ENV) =>
    spawnSync('git', ['--git-dir', path.join(repo, '.git'), '--work-tree', repo,
      'add', '-f', '--', 'src/clean.js', 'src/dirty.js', 'src/rollout.zst', '.gitignore'],
    { cwd: repo, encoding: 'utf-8', env });
  const setBare = (repo, v, env = GIT_ENV) =>
    spawnSync('git', ['--git-dir', path.join(repo, '.git'), 'config', 'core.bare', v],
      { cwd: repo, encoding: 'utf-8', env });
  const tmp42 = mkTmp('ctl');
  try {
    plantFixture(tmp42);

    const noMeta = census(tmp42);
    ok(!!noMeta.skip && /rev-parse/.test(noMeta.skip),
      `CONTROL: a tree with no git metadata SKIPS, and the skip QUOTES git instead of guessing a cause (${JSON.stringify(String(noMeta.skip).slice(0, 110))})`);

    const init = initRepo(tmp42);
    const add = (!init.error && init.status === 0) ? addFixture(tmp42) : null;
    if (init.error || init.status !== 0 || !add || add.status !== 0) {
      ok(true, `CONTROLS SKIPPED: git init/add unavailable here (${gitWhy(add && add.status !== 0 ? add : init)})`);
    } else {
      const found = census(tmp42);
      ok(!found.skip && found.offenders.length === 1 && found.offenders[0].startsWith('src/dirty.js (byte 12, line 1)'),
        `CONTROL: a TRACKED NUL is found, while the \\u0000 escape and a binary fixture are not (${JSON.stringify(found.offenders || found.skip)})`);
      ok(!found.skip && !found.files.some((f) => f === 'data/bin/rclone' || f === 'src/untracked.js'),
        `CONTROL: files the product installs/generates at runtime are OUT OF SCOPE — untracked never reaches the census, however big or binary (${JSON.stringify(found.files || found.skip)})`);

      // ROUND 6b: the state the accident LEFT BEHIND. core.bare=true makes
      // --show-toplevel die while ls-files still answers; before the --git-dir
      // fallback this printed the same green "export/tarball" SKIP forever.
      const flip = setBare(tmp42, 'true');
      const topWhileBare = gitIn(tmp42, ['rev-parse', '--show-toplevel']);
      const bared = flip.status === 0 ? census(tmp42) : null;
      const unflip = flip.status === 0 ? setBare(tmp42, 'false') : null;
      ok(flip.status === 0 && topWhileBare.status !== 0 && !!bared && !bared.skip && bared.offenders.length === 1
        && !!unflip && unflip.status === 0 && !census(tmp42).skip,
        `CONTROL: a core.bare=true checkout has no work tree (--show-toplevel: ${gitWhy(topWhileBare)}) yet a perfectly readable index, so the census RUNS instead of skipping green (${JSON.stringify(bared && (bared.offenders || bared.skip))})`);

      // OWNERSHIP PIN for that fallback: `--git-dir` answers from ANY depth,
      // so the relaxation must not let a directory borrow an ancestor repo's
      // index — with the work tree alive (--show-toplevel names the ancestor)
      // and with it flagged bare (only <base>/.git can say "the repo is here").
      const inner = path.join(tmp42, 'src');
      const innerLive = census(inner);
      const flip2 = setBare(tmp42, 'true');
      const innerBare = flip2.status === 0 ? census(inner) : null;
      if (flip2.status === 0) setBare(tmp42, 'false');
      ok(!!innerLive.skip && !!innerBare && !!innerBare.skip,
        `CONTROL: a directory INSIDE another repo never borrows that repo's index — bare or not (live: ${JSON.stringify(String(innerLive.skip).slice(0, 70))}; bare: ${JSON.stringify(String(innerBare && innerBare.skip).slice(0, 70))})`);

      // ── ROUND 6a: THE AMBIENT-ENVIRONMENT NEGATIVE CONTROL ───────────────
      // Two decoy repos, one hostile environment. Through the sanitizer the
      // decoy must be BYTE-IDENTICAL afterwards; raw, it must change — the
      // second half is what proves the first is the sanitizer's doing and not
      // the controls quietly failing to run at all.
      const makeDecoy = (tag) => {
        const d = mkTmp(tag);
        fs.mkdirSync(path.join(d, 'src'), { recursive: true });
        fs.writeFileSync(path.join(d, 'src/decoy.js'), 'const decoy = 1;\n');
        fs.writeFileSync(path.join(d, '.gitignore'), 'decoy-ignores-nothing\n');
        if (initRepo(d).status !== 0) return null;
        const a = spawnSync('git', ['--git-dir', path.join(d, '.git'), '--work-tree', d, 'add', '-A'],
          { cwd: d, encoding: 'utf-8', env: GIT_ENV });
        return a.status === 0 ? d : null;
      };
      const hostileFor = (decoy) => ({
        ...process.env,
        GIT_DIR: path.join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
        GIT_PREFIX: 'src/', GIT_NAMESPACE: 'decoy', GIT_CEILING_DIRECTORIES: decoy,
        GIT_OBJECT_DIRECTORY: path.join(decoy, '.git', 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git', 'objects'),
        GIT_COMMON_DIR: path.join(decoy, '.git'), GIT_TEMPLATE_DIR: decoy,
        GIT_LITERAL_PATHSPECS: '1', GIT_INDEX_VERSION: '4', GIT_CONFIG_NOSYSTEM: '1',
      });
      const guarded = makeDecoy('decoy-guarded');
      const exposed = makeDecoy('decoy-exposed');
      if (!guarded || !exposed) {
        ok(true, 'CONTROLS SKIPPED: could not build the ambient-environment decoy repos');
      } else {
        const hostile = hostileFor(guarded);
        const cleaned = gitEnvFrom(hostile);
        ok(GIT_REDIRECTORS.every((k) => !(k in cleaned)) && !('GIT_CONFIG_KEY_0' in cleaned) && !('GIT_CONFIG_VALUE_0' in cleaned)
          && cleaned.PATH === hostile.PATH && cleaned.GIT_CONFIG_NOSYSTEM === '1',
          `CONTROL: the sanitizer drops every repo/index/object/config REDIRECTOR incl. the numbered GIT_CONFIG_KEY_n/VALUE_n pairs, and keeps PATH + the strictly-more-isolating GIT_CONFIG_NOSYSTEM (${GIT_REDIRECTORS.length} names audited)`);

        // (a) SANITIZED: run the whole control sequence (skip-probe + init +
        //     add + census) in a fresh fixture while the hostile names point
        //     at `guarded`. Nothing outside the fixture may move.
        const under = mkTmp('ctl-guarded');
        plantFixture(under);
        const beforeG = repoStamp(guarded);
        const preSkip = census(under, gitEnvFrom(hostile));
        const gi = initRepo(under, gitEnvFrom(hostile));
        const ga = gi.status === 0 ? addFixture(under, gitEnvFrom(hostile)) : { status: 1 };
        const gc = census(under, gitEnvFrom(hostile));
        ok(repoStamp(guarded) === beforeG,
          'CONTROL (the round-6 finding itself): with the sanitized environment, a hostile GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_CONFIG_* leaves the OTHER repo byte-identical — every file under .git content-hashed, objects included (round 7)');
        ok(!!preSkip.skip && gi.status === 0 && ga.status === 0 && !gc.skip && gc.offenders.length === 1 && gc.offenders[0].startsWith('src/dirty.js'),
          `CONTROL: ...and the controls still did their real work in the throwaway repo, so the assert above is not vacuous (${JSON.stringify(gc.offenders || gc.skip)})`);

        // (b) RAW: the fixture repo really exists (created sanitized), and only
        //     the `add` runs with the three decoy redirectors in place. It must
        //     reach `exposed` — measured: --git-dir/--work-tree do NOT override
        //     GIT_INDEX_FILE, which is exactly why the env is the fix.
        //     ROUND 7: the base is GIT_ENV, not process.env. A negative control
        //     may differ from the guarded run in exactly the ONE way it is
        //     testing; `{ ...process.env, <3 names> }` left the other 22
        //     redirectors ambient, so this write landed wherever the caller's
        //     GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR said (measured: a third repo,
        //     silently — or, when that name pointed at a nonexistent/read-only
        //     directory, a RED build blaming the sanitizer for it).
        const overExposed = mkTmp('ctl-exposed');
        plantFixture(overExposed);
        const rawEnv = { ...GIT_ENV, GIT_DIR: path.join(exposed, '.git'), GIT_WORK_TREE: exposed, GIT_INDEX_FILE: path.join(exposed, '.git', 'index') };
        const beforeE = repoStamp(exposed);
        const ei = initRepo(overExposed);
        const ea = ei.status === 0 ? addFixture(overExposed, rawEnv) : { status: 1 };
        // …and SAY the one-variable rule at the site, so a future `...process.env`
        // fails here rather than only through the whole-block assert below.
        const rawCarries = GIT_REDIRECTORS.filter((k) => k in rawEnv);
        ok(ei.status === 0 && ea.status === 0 && repoStamp(exposed) !== beforeE
          && JSON.stringify(rawCarries) === JSON.stringify(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']),
          `NEGATIVE CONTROL: the same write control, differing from the guarded run in EXACTLY the three redirectors it names (${JSON.stringify(rawCarries)}), DOES reach the other repo (${gitWhy(ea)}) — the guarded assert above is the sanitizer working, not the controls failing to run`);

        // (c) ROUND 7's own negative control, on a SACRIFICIAL fourth repo: the
        //     PRE-FIX base — `{ ...process.env, GIT_DIR, GIT_WORK_TREE,
        //     GIT_INDEX_FILE }`, three of 25 names pinned — really does carry
        //     `git add` into a repository named on no command line, because
        //     the ambient environment owns the object channel. We aim the two
        //     ambient names at `probe` for the duration of this one call so
        //     that `ambientThird` (asserted untouched below, over the WHOLE
        //     block) keeps its meaning. If this leg ever goes green-by-nothing,
        //     the ambient environment is not hostile and the assert below is
        //     vacuous — so they are two halves of one control.
        const probe = ambientThird ? makeDecoy('decoy-probe') : null;
        const leakField = probe ? mkTmp('ctl-leak') : null;
        let leakMoved = false, leakWhy = 'probe repo unavailable', preFixCarries = null;
        if (probe && leakField) {
          plantFixture(leakField);
          const beforeP = repoStamp(probe);
          const li = initRepo(leakField);
          const aimed = new Map();
          for (const [k, v] of [['GIT_OBJECT_DIRECTORY', path.join(probe, '.git', 'objects')], ['GIT_COMMON_DIR', path.join(probe, '.git')]]) {
            aimed.set(k, process.env[k]); process.env[k] = v;
          }
          //     THE SAME ONE-VARIABLE RULE AS (b), APPLIED TO THIS LEG: the
          //     pre-fix base is spelled on the SANITIZED env plus exactly the
          //     two ambient names this control is about. `{ ...process.env, … }`
          //     left the other twenty redirectors ambient, so a caller whose
          //     shell already exported GIT_LITERAL_PATHSPECS=1/
          //     GIT_ICASE_PATHSPECS=1 (git perfectly healthy) or
          //     GIT_CONFIG_COUNT=1 turned `npm run build` RED here — with a
          //     message blaming the round-7 finding for its own environment.
          //     What is being demonstrated is the OBJECT channel, and that is
          //     named, not inherited.
          const preFixEnv = {
            ...GIT_ENV,
            GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
            GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
            GIT_DIR: path.join(exposed, '.git'),
            GIT_WORK_TREE: exposed,
            GIT_INDEX_FILE: path.join(exposed, '.git', 'index'),
          };
          for (const k of Object.keys(preFixEnv)) if (preFixEnv[k] === undefined) delete preFixEnv[k];
          preFixCarries = GIT_REDIRECTORS.filter((k) => k in preFixEnv);
          const la = li.status === 0 ? addFixture(leakField, preFixEnv) : { status: 1 };
          for (const [k, v] of aimed) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
          leakMoved = li.status === 0 && la.status === 0 && repoStamp(probe) !== beforeP;
          leakWhy = gitWhy(la);
        }
        const PREFIX_EXPECTED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
        ok(leakMoved && JSON.stringify(preFixCarries) === JSON.stringify(PREFIX_EXPECTED),
          `NEGATIVE CONTROL (the round-7 finding itself): the PRE-FIX base — sanitized, PLUS exactly the object-channel names this leg demonstrates (${JSON.stringify(preFixCarries)}) — carries the very same write into a THIRD repository named on no command line, because 3 pinned names cannot protect the object channel (${leakWhy})`);
      }
    }

    // ── ROUND 7: THE WHOLE BLOCK, MEASURED FROM OUTSIDE ────────────────────
    // Every git above ran with GIT_OBJECT_DIRECTORY and GIT_COMMON_DIR
    // exported at `ambientThird`. Not one of them may have written a byte
    // there — including the raw negative control, whose entire job is to be
    // hostile in the three ways it NAMES. The env assert keeps this honest:
    // an assert about an environment that was never set is not an assert.
    if (!ambientThird) {
      ok(true, 'CONTROLS SKIPPED: could not build the ambient third repository (git init/add unavailable here)');
    } else {
      const stillHostile = process.env.GIT_OBJECT_DIRECTORY === path.join(ambientThird, '.git', 'objects')
        && process.env.GIT_COMMON_DIR === path.join(ambientThird, '.git');
      const after = repoStamp(ambientThird);
      ok(stillHostile && after === ambientBefore,
        `CONTROL (the round-7 finding itself): with GIT_OBJECT_DIRECTORY + GIT_COMMON_DIR exported at a third repository for the WHOLE census block, that repository is byte-identical afterwards — every .git file hashed, objects included (hostile env still set: ${stillHostile})`);
    }
  } finally {
    restoreAmbient();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// 43. THE GATE CENSUS (2026-09-07, B-4c5a — the fast/heavy split). A test
//     suite that is in no runner is not a test: before the split, 99 of the
//     184 files matching scripts/test-*.mjs were in NO list at all — not in
//     the gate, not written down as skipped, invisible to everyone including
//     the people who wrote them (test-usage-estimator and test-task-wakeup-
//     card each spent months in that hole and joined the gate only after an
//     incident). So the tier table is now a CENSUS: every scripts/test-*.mjs
//     is either 'fast', 'heavy' (with a stated reason: chrome / server / cli /
//     binary / slow) or in EXCLUDED with the reason it cannot be gated. This
//     assert lives here so it runs inside `npm run build` — i.e. inside BOTH
//     tiers and the in-app "Update VibeSpace…" — and not only in the gate that
//     the new suite might not be in yet.
//
//     SCOPE: readdir, not `git ls-files`. §42 round 5 reads the source list
//     from git because the PRODUCT writes runtime products into the working
//     tree (data/bin/rclone) — nothing writes scripts/test-*.mjs, and the case
//     this census exists for is precisely a suite you just wrote and have not
//     committed. Reading the index would let exactly that one fall through.
{
  const ci = await import('./ci.mjs');
  const disk = ci.listSuiteFiles(REPO);
  const f = ci.censusFindings(disk);
  ok(disk.length > 100, `census scope is non-vacuous (${disk.length} scripts/test-*.mjs on disk)`);
  ok(!f.unclassified.length, `every scripts/test-*.mjs is in a tier or EXCLUDED (${f.unclassified.slice(0, 6).join(', ') || 'none missing'})`);
  ok(!f.inBoth.length, `no suite is both tiered and excluded (${f.inBoth.join(', ') || 'clean'})`);
  ok(!f.duplicated.length, `no suite is listed twice (${f.duplicated.join(', ') || 'clean'})`);
  ok(!f.ghosts.length, `every listed suite has a scripts/<name>.mjs (${f.ghosts.join(', ') || 'clean'})`);
  ok(!f.badTier.length, `every tier is 'fast' or 'heavy' (${f.badTier.join(', ') || 'clean'})`);
  ok(!f.reasonless.length, `every heavy/excluded entry states WHY (${f.reasonless.slice(0, 6).join(', ') || 'clean'})`);
  ok(f.counted.fast > 0 && f.counted.heavy > 0,
    `both tiers are populated (${f.counted.fast} fast + ${f.counted.heavy} heavy + ${f.counted.excluded} excluded = ${f.counted.fast + f.counted.heavy + f.counted.excluded} of ${f.counted.disk})`);
  // NEGATIVE CONTROL: the census must actually be able to go red. Feed it a
  // disk listing containing a suite nobody classified and a table naming a
  // file that does not exist — an assert that cannot fail is not an assert.
  const nc = ci.censusFindings([...disk, 'test-not-in-any-tier'],
    [{ name: 'test-ghost-suite', tier: 'heavy', why: 'chrome' }, { name: 'test-ghost-suite', tier: 'fast' }, ...ci.SUITES],
    ci.EXCLUDED);
  ok(nc.unclassified.includes('test-not-in-any-tier') && nc.ghosts.includes('test-ghost-suite') && nc.duplicated.includes('test-ghost-suite'),
    'NEGATIVE CONTROL: the census reports an unclassified suite, a ghost entry and a duplicate (it can go red)');
  // THE WIRING PINS (hook ⇄ workflow ⇄ package.json) LIVE IN
  // scripts/test-ci-gate.mjs, NOT HERE, and that is a rule with a scar: this
  // block runs inside `npm run build`, and several browser suites build a
  // PARTIAL COPY of the tree in a throwaway worktree (test-window-menu copies
  // src+public+server.js+scripts onto a HEAD checkout). A build-time assert
  // that compares files OUTSIDE the copied set fails in every one of those
  // worktrees for reasons that have nothing to do with the code under test —
  // measured: the package.json pin turned test-window-menu into a 300 s
  // timeout and then a bare "Command failed: npm run build". A build-time
  // check may only read what a build reads; cross-file wiring is a suite's job.
}

// 44. THE SETTINGS CATEGORY CENSUS (2026-09-09). `SETTINGS_CATEGORIES` is not
//     a hint about ordering — it IS SettingsUI's render loop. `_renderContent`
//     groups every row by `schema.category` (creating a bucket for whatever it
//     finds) and then renders by iterating that ARRAY, so a category nobody
//     listed is grouped and dropped: its rows are unreachable in the product
//     and invisible to the search box, which answers "No settings match your
//     search." There is no second write path — `serverSetting()` reads the
//     sparse data/settings.json, and only this UI writes it.
//
//     Measured before the fix: 118 settings, 108 rendered, 10 NEVER RENDERED —
//     the seven `Spending` rows (every unattended-spend ceiling, the overage
//     consent and the EDF reserve floor, while the pool's blocked notice, the
//     spend guard's inbox item and the overage chip all told the user to open
//     "Settings → Spending") plus three `OpenCode` rows that had been invisible
//     since the day they shipped. Nothing was red: no suite compared the two
//     sets, which is exactly why the second omission could ride in behind the
//     first.
//
//     It lives HERE, in the build, because the defect is one missing array
//     entry in a file every feature touches, and because it reads only
//     src/lib/** — inside the partial-copy set the browser suites build (the
//     §43 scar). The assert is the CONSEQUENCE ("every row renders"), not just
//     set inclusion, and the UI's own coupling is pinned so the replay cannot
//     drift away from the loop it stands for.
{
  const schemaMod = await import('../src/lib/settings-schema.js');
  const { SETTINGS_SCHEMA, SETTINGS_CATEGORIES } = schemaMod;
  const ui = read('src/lib/settings-ui.js');

  /** SettingsUI._renderContent, verbatim in shape: group by category, then
   *  render by walking the ordered list. Returns the paths that reach a
   *  section. */
  const renderedPaths = (schema, cats) => {
    const grouped = {};
    for (const cat of cats) grouped[cat] = [];
    for (const [p, s] of Object.entries(schema)) {
      const cat = s.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }
    const out = [];
    for (const cat of cats) for (const p of grouped[cat] || []) out.push(p);
    return out;
  };

  const all = Object.keys(SETTINGS_SCHEMA);
  const cats = [...new Set(Object.values(SETTINGS_SCHEMA).map((s) => s.category))];
  ok(all.length > 50 && cats.length > 5 && SETTINGS_CATEGORIES.length > 5,
    `settings census scope is non-vacuous (${all.length} settings in ${cats.length} categories, ${SETTINGS_CATEGORIES.length} listed)`);
  ok(/for \(const cat of SETTINGS_CATEGORIES\)/.test(ui) && /grouped\[cat\]/.test(ui),
    'SettingsUI still RENDERS by iterating SETTINGS_CATEGORIES (the coupling this census stands for)');

  const rendered = renderedPaths(SETTINGS_SCHEMA, SETTINGS_CATEGORIES);
  const dropped = all.filter((p) => !rendered.includes(p));
  ok(dropped.length === 0,
    `every setting reaches a rendered section (${rendered.length}/${all.length}${dropped.length ? ' — DROPPED: ' + dropped.slice(0, 6).join(', ') : ''})`);
  const unlisted = cats.filter((c) => !SETTINGS_CATEGORIES.includes(c));
  ok(unlisted.length === 0, `every schema category is in SETTINGS_CATEGORIES (${unlisted.join(', ') || 'clean'})`);
  // A listed category with no rows is a nav entry that can never appear — the
  // dead-allowlist-row rule, applied to the other direction of the same list.
  const empty = SETTINGS_CATEGORIES.filter((c) => !cats.includes(c));
  ok(empty.length === 0, `no listed category is empty (${empty.join(', ') || 'clean'})`);

  // NEGATIVE CONTROL: the same code, over a schema carrying a category nobody
  // listed, must drop it — an assert that cannot go red is not an assert.
  const ncSchema = { ...SETTINGS_SCHEMA, 'zz.synthetic': { type: 'boolean', default: false, label: 'x', description: 'x', category: 'Nobody Listed This' } };
  const ncRendered = renderedPaths(ncSchema, SETTINGS_CATEGORIES);
  ok(!ncRendered.includes('zz.synthetic') && ncRendered.length === rendered.length,
    'NEGATIVE CONTROL: a row in an unlisted category is silently dropped by the render loop (this census can go red)');
  ok(renderedPaths(ncSchema, [...SETTINGS_CATEGORIES, 'Nobody Listed This']).includes('zz.synthetic'),
    'POSITIVE CONTROL: listing that category is the whole fix (one array entry)');
}

// 45. THE PER-ITEM SPAWN CENSUS (2026-09-09, userW's pod: 27 of 27 session
//     creates and kills followed by an 11-17 s event-loop block). A spawn is
//     paid by the PARENT — fork(2) copies the caller's page tables on the
//     calling thread (measured on this box: 1.8 ms at 45 MB RSS, 18.8 ms at
//     543 MB, 67-73 ms at 1.5 GB) — and a loop over N sessions lines N of them
//     up inside ONE tick, whether it awaits or not. The rule is therefore not
//     "few spawns" but "NO SPAWN PER ITEM" on anything a poll, a create or a
//     kill can reach: those facts come from /proc through THE process reader
//     (src/cli-identity.js), and the survivors are one-per-sweep or no-/proc
//     fallbacks, each named below WITH its reason.
//
//     ROUND 2 — THE FILE SET IS DERIVED, NOT TYPED. Round 1 wrote the three
//     sweep modules into a literal array, and the very next reader of the very
//     same fact — `refreshWebuiPids()` in server.js, one SYNCHRONOUS
//     `pgrep -P <childPid>` per live session, in-band on every kill and 3 s
//     after every create — was invisible to it: measured 9.16 s of blocked
//     loop for 61 sessions at 1.5 GB RSS, for the identical 244 pids /proc
//     hands over in 1.6 ms. A hand-written file list is the tool this class has
//     already defeated twice here (test-writer-sweep §17 r7 is the first), so
//     both halves below derive their scope and PRINT what they walked:
//
//       (a) THE PID-QUESTION CENSUS — repo-wide. Every tracked JS file the
//           server or the daemon runs, every spawn whose argv names a
//           process-table tool (`ps`/`pgrep`/`pidof`/`pstree`/`lsof`/`fuser`).
//           That family IS what this incident is made of ("who is this pid's
//           parent", "what did it fork", "who holds this file"), it is small
//           enough to reason about one row at a time, and it is the half that
//           would have caught server.js.
//       (b) THE SWEEP-MODULE CENSUS — every spawn, in the modules that answer
//           the sweep's own named facts. The file set is resolved BY LOOKING UP
//           WHERE EACH FACT IS DEFINED, so moving a function keeps its
//           enforcement and a fact that grew a second definition goes red.
//           This half is what catches a per-session `git` or `stat` — a fork
//           that (a) would never see.
//
//     WHAT THESE TWO CANNOT SEE, stated as narrowly as the code allows (round 3
//     had to correct this sentence once already, so it is worth being exact):
//       · (a) matches a call whose FIRST ARGUMENT is a process-table tool
//         spelled as a LITERAL, whatever the callee is named. A tool name held
//         in a VARIABLE (`execFile(cmd, ['-p', pid])`) is invisible to it.
//       · (b) is blind to a module that neither defines a sweep fact nor is
//         one — a per-session `execFile('git', …)` in src/ws-handler.js still
//         passes both halves.
//     Both gaps are covered from the other side by the FILE-BLIND consequence
//     census in scripts/test-discovery-spawn.mjs, which counts every
//     child_process entry point the REAL sweep, the REAL refreshWebuiPids and
//     the REAL kill-path socket lookup take, wherever the fork was written.
{
  const GIT_ENV45 = gitEnvFrom(process.env);
  const lsFiles = spawnSync('git', ['-C', REPO, 'ls-files', '-z'],
    { encoding: 'utf-8', env: GIT_ENV45, maxBuffer: 64 * 1024 * 1024 });
  // SKIP QUOTES GIT (§42 round 6): a self-invented reason turns "this census
  // was switched off" into "there was nothing to look at". Half (b) still runs
  // — it reads named files and needs no index.
  const gitOk = !lsFiles.error && lsFiles.status === 0 && lsFiles.stdout;
  const gitWhy45 = lsFiles.error ? `spawn failed: ${lsFiles.error.code || lsFiles.error.message}`
    : `exit ${lsFiles.status}: ${String(lsFiles.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 160) || '(no stderr)'}`;
  // SCOPE: EVERY tracked JS except two named exclusions — over-inclusion only
  // widens enforcement, a false negative IS the defect (test-writer-sweep §17
  // r7). `scripts/` is out because the suites deliberately SPELL the forbidden
  // shapes as controls (this very block holds two `execFileSync('ps', …)`
  // literals) and because no product path requires anything from there — which
  // is ASSERTED below rather than assumed. `public/` is out because it is the
  // built bundle: a tracked bundle.js would carry cli-identity's own allowlisted
  // `ps` calls under a second filename and redden the build for a legitimate
  // act. `docs/` is IN (2 tracked files, measured clean) — the earlier "it's
  // prose" exclusion was an unaudited sample, and docs/examples/hello-plugin is
  // code somebody runs. The listing is the git INDEX, never a readdir, because
  // data/bin holds a 64 MB untracked `rclone` (the §42 round-5 lesson, same
  // directory).
  const inScope = (f) => /\.(js|mjs|cjs)$/.test(f)
    && !f.startsWith('scripts/') && !f.startsWith('public/');
  const tracked = gitOk
    ? (lsFiles.stdout || '').split('\0').filter(Boolean).filter(inScope)
    : [];

  // Every way this repo STARTS A CHILD PROCESS, in JS. `exec` is the awkward
  // one: `re.exec(str)` is a regex match, not a fork, so the bare form is taken
  // only when it is NOT a method call, plus the dotted spellings of
  // child_process itself. A DECLARATION is not a call (`function execFileP(cmd,
  // args…)`), so it is blanked first.
  const SPAWN_CALL = /\b(?:execFileSync|execFileP|execFile|execSync|spawnSync|spawn|execImpl)\s*\(|(?<![.\w$])exec\s*\(|\b(?:cp|childProcess|child_process|proc)\.exec\s*\(/;
  // A PROMISIFIED ALIAS IS STILL A FORK (round 3). SPAWN_CALL is a list of
  // CALLEE NAMES, so `execFileAsync(` (src/ws-handler.js's own idiom, handed to
  // ws-create through ctx) and `sh(` (src/incident.js) match none of them —
  // `execFile` needs a `(` immediately after it. Two live process-table spawns
  // were therefore absent from the census's own printed inventory, and a
  // per-session `pgrep -P` loop spelled that way passed EVERY gate on the kill
  // path, i.e. the incident's own trigger. The signal this census claims to
  // census is the ARGV, so derive from the TOOL: a call whose FIRST argument is
  // a process-table tool name is a site whatever the callee is called. The
  // trailing `,` keeps `_trimGapDom('top')`-shaped calls out, and `top` is
  // deliberately NOT in this list (a bare `snap('top')` is not a fork) — the
  // union with SPAWN_CALL still covers `execFile('top', …)`. MEASURED over the
  // same 243 tracked files: 16 sites → 18, zero false positives.
  const TOOL_FIRST = /[A-Za-z_$][\w$]*\s*\(\s*['"`](?:ps|pgrep|pkill|pidof|pstree|lsof|fuser)['"`]\s*,/;
  const PID_TOOL = /['"`](?:ps|pgrep|pkill|pidof|pstree|lsof|fuser|top)['"`]/;
  const spawnScan = (l) => String(l).replace(/\bfunction\s+\w+\s*\(/g, 'function DECLARED(');
  const isSpawnComment = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
  // The tool name usually sits on the spawn's own line; a wrapped call puts it
  // on the next one or two. Over-inclusion is the safe direction here — it can
  // only demand one more reason row.
  const spawnSites = (text, { pidOnly }) => {
    const lines = String(text).split('\n');
    const out = [];
    lines.forEach((line, i) => {
      const scanned = spawnScan(line);
      if (isSpawnComment(line) || !(SPAWN_CALL.test(scanned) || TOOL_FIRST.test(scanned))) return;
      if (pidOnly && !PID_TOOL.test(lines.slice(i, i + 3).filter((l) => !isSpawnComment(l)).join('\n'))) return;
      out.push({ n: i + 1, line });
    });
    return out;
  };

  // ── (a) THE PID-QUESTION CENSUS ────────────────────────────────────────────
  const PID_ALLOWED = [
    { file: 'src/cli-identity.js', needle: "execFileSync('ps', ['-p', String(pid), '-o', 'args=']", why: 'NO-/proc FALLBACK ONLY (procArgv, rung 2 of the identity rule).' },
    { file: 'src/cli-identity.js', needle: "execImpl('ps', ['-p', String(pid), '-o', 'uid=,args=']", why: 'NO-/proc FALLBACK ONLY (readPsIdentity, per-pid memo) — the {uid, argv} value read the signalling callers share.' },
    { file: 'src/cli-identity.js', needle: "execImpl('ps', ['-eo', 'pid=,ppid=']", why: 'NO-/proc FALLBACK ONLY, and ONE PER SWEEP for the WHOLE table (parentIndex, memoised) — this is the shape that REPLACED one `ps` per pid. Never reached where /proc exists.' },
    { file: 'src/cli-identity.js', needle: "execFile('pgrep', ['-f', String(needle)]", why: 'NO-/proc FALLBACK ONLY (pidsMatchingCmdline) — ONE per question for the WHOLE table, never one per candidate. Where /proc exists the rung above it reads every `/proc/<pid>/cmdline` into ONE reused buffer, which is why the kill path now starts no child process at all.' },
    { file: 'src/session-store.js', needle: "execFileP('ps', ['-p', String(pid), '-o', 'comm=']", why: 'NO-/proc FALLBACK ONLY (isProcessClaudeAsync), reached from isLockClaude when a lock carries no numeric procStart AND there is no procfs. On a procfs machine the rung above it is `isCliProcess`, pure file reads.' },
    { file: 'src/discovery-facts.js', needle: "spawnSync('lsof', ['-Fpn', '+D', root]", why: 'NO-/proc FALLBACK ONLY (macOS/BSD codex liveness), ONE per scan of the whole sessions tree.' },
    { file: 'src/agentd/agentd.js', needle: "spawnSync('ps', ['-p', String(pid), '-o', 'lstart=']", why: 'NO-/proc FALLBACK ONLY (pidStartTime) — /proc/<pid>/stat field 22 is the rung above it. Asked when a pipe session is adopted, not per poll.' },
    { file: 'src/agentd/agentd.js', needle: "execFileSync('ps', ['-p', String(pid), '-o', 'command=']", why: 'NO-/proc FALLBACK ONLY (acquireSingleton), and ONCE per daemon start — /proc/<pid>/cmdline is the rung above it.' },
    { file: 'src/plugins.js', needle: "execFileSync('pgrep', ['-x', 'tailscaled']", why: 'ONE per tailscale status read (a plugin card), never per session; the loop under it reads /proc cmdlines, not more spawns.' },
    { file: 'src/server/boot-restore.js', needle: "execFileSync('fuser', [path.join(SOCKETS_DIR, sockFile)]", why: 'BOOT ONLY (restoreSessions, once per surviving socket, before this server serves anybody) — "is this dtach socket still owned" has no /proc rung that does not re-implement fuser. Out of scope on purpose: the incident is create/kill/poll, and a boot pays this once.' },
    { file: 'src/server/boot-restore.js', needle: "execFileSync('fuser', [socketPath]", why: 'BOOT ONLY (same sweep, the per-socket branch).' },
    { file: 'src/server/boot-restore.js', needle: "execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf-8', timeout: 2000 });", why: 'BOOT ONLY — the second rung of the same liveness question when `fuser` is absent.' },
    { file: 'src/server/boot-restore.js', needle: "for (const p of execFileSync('pgrep', ['-f', socketPath]", why: 'BOOT ONLY, and only for a socket already judged a DUPLICATE husk that must be retired — a handful per boot at most.' },
    { file: 'src/sysinfo.js', needle: "execFile('ps', ['aux', '--sort=-rss']", why: 'ONE per sysinfo read (topProcs), never per item; PS_MAX_BUFFER governs its size.' },
    { file: 'src/sysinfo.js', needle: "execFile('ps', ['aux']", why: 'ONE per sysinfo read — the fallback for a `ps` with no --sort.' },
    { file: 'src/sysinfo.js', needle: "execFile('ps', ['axo', PS_COLUMNS]", why: 'ONE per process-list read (listProcs), the System panel table.' },
    { file: 'src/transcript-service.js', needle: "execFileSync('fuser', [fp]", why: 'ONE per human-triggered `rescue` — the two-writer refusal. Not on any poll.' },
    { file: 'src/incident.js', needle: "sh('ps', ['-eo', 'pid,ppid,lstart,etime,rss,stat,args']", why: 'ONE per HUMAN-TRIGGERED incident capture ("Report a problem"), and the WHOLE-TABLE form — the frozen scene is exactly what a human needs and /proc would only re-implement `ps`. Not on any poll, create or kill. Spelled through a promisified alias, which is why TOOL_FIRST exists.' },
  ];
  if (!gitOk) {
    ok(true, `(a) PID-QUESTION CENSUS SKIPPED — \`git -C <repo> ls-files\` could not answer here: ${gitWhy45}`);
  } else {
    const pidWalked = [], pidStray = [], pidHit = new Set();
    for (const f of tracked) {
      for (const s of spawnSites(read(f), { pidOnly: true })) {
        pidWalked.push(`${f}:${s.n}`);
        const a = PID_ALLOWED.find((x) => x.file === f && s.line.includes(x.needle));
        if (a) pidHit.add(a.needle); else pidStray.push(`${f}:${s.n}: ${s.line.trim().slice(0, 110)}`);
      }
    }
    console.log(`  · (a) pid-question census walked ${tracked.length} tracked files, ${pidWalked.length} sites: ${pidWalked.join(', ')}`);
    ok(tracked.length > 100 && pidWalked.length >= 10,
      `(a) scope is non-vacuous (${tracked.length} files, ${pidWalked.length} process-table spawns)`);
    // SCOPE SELF-PROOF: an assert that cannot name the files it exists for is
    // a census of nothing. These four are the incident's own modules.
    for (const must of ['server.js', 'src/session-store.js', 'src/cli-identity.js', 'src/server/boot-restore.js']) {
      ok(tracked.includes(must), `(a) scope really covers ${must}`);
    }
    ok(!pidStray.length, `(a) every process-table spawn is allowlisted WITH a reason (${pidStray.slice(0, 4).join(' | ') || 'clean'})`);
    const pidDead = PID_ALLOWED.filter((a) => !pidHit.has(a.needle)).map((a) => `${a.file}:${a.needle}`);
    ok(!pidDead.length, `(a) no dead allowlist rows (${pidDead.join(' | ') || 'all live'})`);
    // THE FIX ITSELF, asserted where it was made: server.js asks the reader.
    const srv = read('server.js');
    const srvCode = srv.split('\n').filter((l) => !isSpawnComment(l)).join('\n');
    ok(!/pgrep/.test(srvCode), '(a) no `pgrep` survives in server.js code (refreshWebuiPids was the last one)');
    ok(/readChildPids\(meta\.childPid\)/.test(srvCode) && /require\('\.\/src\/cli-identity'\)/.test(srvCode),
      '(a) refreshWebuiPids asks THE process reader for the wrapper\'s children');
    // …and `scripts/` really is out of the product's path, which is the only
    // thing that makes excluding it from the scope honest.
    const productRequiresScripts = tracked.filter((f) => /require\(['"][^'"]*\/scripts\//.test(read(f)));
    ok(!productRequiresScripts.length, `(a) no in-scope file requires anything from scripts/ (${productRequiresScripts.join(', ') || 'clean'})`);
  }

  // ── (b) THE SWEEP-MODULE CENSUS ────────────────────────────────────────────
  // The facts a poll / create / kill asks for, and therefore the modules whose
  // EVERY spawn needs a reason. Resolved by definition lookup: a fact that
  // moved keeps its enforcement, a fact that grew a twin or vanished goes red.
  const SWEEP_FACTS = ['discoverClaudeSessions', 'refreshWebuiPids', 'readChildPids', 'readPpid',
    'findTmuxTargetAsync', 'getTmuxPaneMapAsync', 'listOpenCodexRolloutPaths'];
  const defOwner = (name, pool) => {
    const def = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(|^\\s*(?:const|let)\\s+${name}\\s*=`, 'm');
    return pool.filter((f) => def.test(read(f)));
  };
  // Where git could not answer, fall back to the modules this repo has always
  // held these facts in — SAID, not silently.
  const defPool = gitOk ? tracked
    : ['server.js', 'src/session-store.js', 'src/cli-identity.js', 'src/discovery-facts.js'];
  const sweepFiles = new Set();
  const ambiguous = [];
  for (const name of SWEEP_FACTS) {
    const owners = defOwner(name, defPool);
    if (owners.length !== 1) ambiguous.push(`${name} → ${JSON.stringify(owners)}`);
    for (const o of owners) sweepFiles.add(o);
  }
  ok(!ambiguous.length,
    `(b) every sweep fact resolves to exactly ONE defining module (${ambiguous.join(' | ') || 'clean'})`);
  const SWEEP_ALLOWED = [
    { file: 'src/session-store.js', needle: 'execFile(cmd, args,', why: 'THE async exec primitive itself, the body of execFileP. It starts nothing on its own — this census is about its CALLERS.' },
    { file: 'src/session-store.js', needle: "execFileP('tmux', ['list-panes'", why: 'ONE PER SWEEP, and only where a `tmux` binary is on PATH (statted, never `which`); the map is cached for TMUX_MAP_TTL_MS so a create/kill burst shares it. This is the one child process a sweep may start.' },
    { file: 'src/session-store.js', needle: "execFileP('ps', ['-p', String(pid), '-o', 'comm=']", why: 'NO-/proc FALLBACK ONLY (isProcessClaudeAsync) — see (a).' },
    { file: 'src/cli-identity.js', needle: "execFileSync('ps', ['-p', String(pid), '-o', 'args=']", why: 'NO-/proc FALLBACK ONLY (procArgv) — see (a).' },
    { file: 'src/cli-identity.js', needle: "execImpl('ps', ['-p', String(pid), '-o', 'uid=,args=']", why: 'NO-/proc FALLBACK ONLY (readPsIdentity) — see (a).' },
    { file: 'src/cli-identity.js', needle: "execImpl('ps', ['-eo', 'pid=,ppid=']", why: 'NO-/proc FALLBACK ONLY, ONE per sweep for the whole table — see (a).' },
    { file: 'src/cli-identity.js', needle: "execFile('pgrep', ['-f', String(needle)]", why: 'NO-/proc FALLBACK ONLY (pidsMatchingCmdline), ONE per question — see (a).' },
    { file: 'src/discovery-facts.js', needle: "spawnSync('lsof', ['-Fpn', '+D', root]", why: 'NO-/proc FALLBACK ONLY (macOS/BSD codex liveness), ONE per scan — see (a).' },
    { file: 'server.js', needle: "execFileSync('git', ['-C', repoDir, 'pull', '--ff-only']", why: 'BOOT ONLY, ONCE (the auto-update pull, before anything is served).' },
    { file: 'server.js', needle: "execFileSync('npm', ['install'", why: 'BOOT ONLY, ONCE, and only when the pull actually moved.' },
    { file: 'server.js', needle: "execFileSync('npm', ['run', 'build']", why: 'BOOT ONLY, ONCE, same branch.' },
    { file: 'server.js', needle: "execFileSync('/usr/bin/which', [name]", why: 'BOOT ONLY, ONCE PER COMMAND NAME (resolveCmd, three of them) — node-pty needs absolute paths. Never on a session path.' },
  ];
  const swWalked = [], swStray = [], swHit = new Set();
  for (const f of [...sweepFiles].sort()) {
    const text = read(f);
    ok(text.length > 0, `(b) census can read ${f}`);
    for (const s of spawnSites(text, { pidOnly: false })) {
      swWalked.push(`${f}:${s.n}`);
      const a = SWEEP_ALLOWED.find((x) => x.file === f && s.line.includes(x.needle));
      if (a) swHit.add(a.needle); else swStray.push(`${f}:${s.n}: ${s.line.trim().slice(0, 110)}`);
    }
  }
  console.log(`  · (b) sweep-module census walked ${[...sweepFiles].sort().join(', ')} — ${swWalked.length} sites: ${swWalked.join(', ')}`);
  ok(sweepFiles.size >= 4 && swWalked.length >= SWEEP_ALLOWED.length,
    `(b) scope is non-vacuous (${sweepFiles.size} modules, ${swWalked.length} spawn sites)`);
  ok(sweepFiles.has('server.js'),
    '(b) server.js is IN SCOPE because it defines refreshWebuiPids — the reader round 1 could not see');
  ok(!swStray.length, `(b) every spawn in a sweep module is allowlisted WITH a reason (${swStray.slice(0, 4).join(' | ') || 'clean'})`);
  const swDead = SWEEP_ALLOWED.filter((a) => !swHit.has(a.needle)).map((a) => `${a.file}:${a.needle}`);
  ok(!swDead.length, `(b) no dead allowlist rows (${swDead.join(' | ') || 'all live'})`);

  // ── NEGATIVE CONTROLS, over the SAME scanner, without touching the tree ────
  // ① the two retired per-item shapes, verbatim, must be caught by (a);
  // ② the exact mutation that proved round 1 blind — a per-session
  //    `ps -p … -o ppid=` inside refreshWebuiPids — must be caught in
  //    server.js's real text with the line spliced in;
  // ③ a per-session `git` spawn, which (a) cannot see by construction, must be
  //    caught by (b) — the reason (b) exists;
  // ④ the same lines behind a `//` are prose, not offenders.
  const retired = [
    "    const out = await execFileP('pgrep', ['-P', String(childPid)], { timeout: 2000 });",
    "  const out = await execFileP('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 2000 });",
    "          const ch = execFileSync('pgrep', ['-P', String(meta.childPid)], { encoding: 'utf-8', timeout: 2000 }).trim();",
  ];
  const caughtByA = retired.filter((line) => spawnSites(line, { pidOnly: true }).length === 1);
  ok(caughtByA.length === 3,
    `NEGATIVE CONTROL ①②: the retired per-lock \`ps -o ppid=\`, the retired per-session \`pgrep -P\` and the shipped server.js spelling are all caught by (a) (${caughtByA.length}/3)`);
  // Both splices are measured as a DELTA against the tree as it stands, so the
  // control describes what IT added and nothing else — on a tree somebody has
  // already broken, an absolute count would go red for a reason that is not
  // this control's subject and would say the wrong thing about why.
  const ANCHOR45 = 'for (const p of readChildPids(meta.childPid)) webuiPids.add(p);';
  const srvText = read('server.js');
  ok(srvText.includes(ANCHOR45), 'NEGATIVE CONTROL setup: the splice anchor exists in server.js (a control that cannot be built proves nothing)');
  const strayCount = (text, pidOnly, allow) => spawnSites(text, { pidOnly })
    .filter((s) => !allow.some((x) => x.file === 'server.js' && s.line.includes(x.needle))).length;
  const splice = (line) => srvText.replace(ANCHOR45, `${ANCHOR45}\n        ${line}`);
  const psMut = splice("try { execFileSync('ps', ['-p', String(meta.pid), '-o', 'ppid=']); } catch {}");
  const dA = strayCount(psMut, true, PID_ALLOWED) - strayCount(srvText, true, PID_ALLOWED);
  const dB = strayCount(psMut, false, SWEEP_ALLOWED) - strayCount(srvText, false, SWEEP_ALLOWED);
  ok(dA === 1 && dB === 1,
    `NEGATIVE CONTROL ②: the exact mutation that left round 1's census GREEN is now a stray in BOTH halves (a:+${dA}, b:+${dB})`);
  const gitMut = splice("try { execFileSync('git', ['-C', meta.cwd, 'status']); } catch {}");
  const gA = strayCount(gitMut, true, PID_ALLOWED) - strayCount(srvText, true, PID_ALLOWED);
  const gB = strayCount(gitMut, false, SWEEP_ALLOWED) - strayCount(srvText, false, SWEEP_ALLOWED);
  ok(gA === 0 && gB === 1,
    `NEGATIVE CONTROL ③: a per-session \`git\` spawn is invisible to (a) (+${gA}) and a stray in (b) (+${gB}) — the reason both halves exist`);
  ok(retired.every((l) => isSpawnComment('  // ' + l.trim())),
    'NEGATIVE CONTROL ④: the same lines behind a `//` are prose, not offenders');
  // ⑤ THE ROUND-3 SHAPE: the retired per-session `pgrep -P`, spelled through a
  //    PROMISIFIED ALIAS. Round 2's census matched callee NAMES, so this line
  //    was invisible to BOTH halves — verified on the real tree by splicing it
  //    into ws-handler.js's kill case, where `node scripts/test-architecture.mjs`,
  //    `test-discovery-spawn.mjs` and `test-ws-contract.mjs` all answered
  //    ALL PASS. It is driven twice: as a bare line (the rule) and spliced into
  //    ws-handler's REAL text at the incident's own trigger (the consequence).
  const aliasRetired = "                const out = await execFileAsync('pgrep', ['-P', String(ls._childPid)], { timeout: 2000 });";
  ok(spawnSites(aliasRetired, { pidOnly: true }).length === 1,
    'NEGATIVE CONTROL ⑤: the retired per-session `pgrep -P` spelled through a promisified ALIAS is a site (round 3: it was invisible, and that is how it re-entered the kill path)');
  const WS_ANCHOR = 'refreshWebuiPids();';
  const wsText = read('src/ws-handler.js');
  ok(wsText.includes(WS_ANCHOR),
    'NEGATIVE CONTROL ⑤ setup: the splice anchor exists in src/ws-handler.js\'s kill case (a control that cannot be built proves nothing)');
  const wsStray = (text) => spawnSites(text, { pidOnly: true })
    .filter((s) => !PID_ALLOWED.some((x) => x.file === 'src/ws-handler.js' && s.line.includes(x.needle))).length;
  const wsMut = wsText.replace(WS_ANCHOR, `${WS_ANCHOR}\n${aliasRetired}`);
  const wA = wsStray(wsMut) - wsStray(wsText);
  ok(wA === 1,
    `NEGATIVE CONTROL ⑤: spliced into ws-handler's real kill case it is a stray in (a) (+${wA}) — the exact mutation round 2's census answered ALL PASS on`);
  // …and the FIX itself, asserted where it was made: the kill path asks THE
  // process reader, so ws-handler carries no process-table spawn of its own.
  ok(!wsStray(wsText) && /pidsMatchingCmdline\(session\.socketPath\)/.test(wsText)
    && /require\('\.\/cli-identity'\)/.test(wsText),
    '(a) the kill path asks THE process reader (`pidsMatchingCmdline`) and ws-handler starts no process-table child of its own');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
