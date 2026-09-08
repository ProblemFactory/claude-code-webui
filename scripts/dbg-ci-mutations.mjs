#!/usr/bin/env node
// MUTATION BATTERY FOR THE RELEASE GATE (2026-09-07, B-4c5a) — the evidence
// behind "every new guard has an assert that dies with it". For each guard it
// removes that guard from the REAL product file, runs the suite that is
// supposed to be holding it, and requires RED. Not a test suite (it edits the
// product and takes minutes), so it is deliberately NOT scripts/test-*.mjs and
// the census never sees it; run it by hand after touching ci.mjs or the hook:
//
//     node scripts/dbg-ci-mutations.mjs        # exits 1 if any guard is unheld
//     node scripts/dbg-ci-mutations.mjs '--only=round 4' # just those mutations
//     node scripts/dbg-ci-mutations.mjs --reap-only      # just clear the litter
//
// IT EDITS THE PRODUCT, SO IT OBEYS INVARIANT ⑳. Signal handlers are NOT
// enough and it is worth being precise about why: this script spends ~all of
// its wall time inside `spawnSync`, so a SIGTERM sits queued behind the child
// and a SIGKILL (or a timeout, or a harness whose session dies) runs nothing at
// all. Measured twice: once it stranded the pre-push hook, once it stranded
// `killedFromOutside = () => false` in scripts/ci.mjs — a gate with its own
// abort evidence disabled, sitting in the working tree of the branch shipping
// the gate. So the real protection is a SELF-HEAL at start, out of a SIDECAR
// (TMPDIR/vs-ci-mutations-backup-<uid>.json) holding the exact pre-mutation
// bytes, written before the first mutation and removed on a clean finish.
//
// The sidecar, not `git show HEAD:<path>`, for two reasons that are the whole
// point: (1) these files are usually being WORKED on — HEAD's copy would throw
// away the very edit the battery is being run to check; (2) a mutation can be a
// DELETION (`to: ''`), which leaves no fingerprint to recognise, so "does it
// carry a mutant's replacement text" can never see it. The sidecar makes the
// test exact instead of heuristic: a file is healed only when it is byte-equal
// to `backup.replace(from, to)` for one of the mutations — that is a file this
// tool mutated and did not restore, and nothing else can look like it.
// (The other half of the containment is the gate itself: a dirty tree earns no
// `.git/ci-green` and `--heavy` refuses a verdict at t=0.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnvFrom } from './git-env.mjs';

const ARGS = process.argv.slice(2);
const REPO = ARGS.find((a) => !a.startsWith('--')) || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `--reap-only` does the cleanup below and stops — the battery itself takes
// minutes, and the litter is worth being able to clear on its own.
const REAP_ONLY = ARGS.includes('--reap-only');
// `--only=<substring>` runs just the mutations whose NAME matches — the full
// battery takes ~20 minutes, and after touching one guard the question is
// usually about that guard. The count in the closing line says what ran.
const ONLY = ((ARGS.find((a) => a.startsWith('--only=')) || '').slice(7) || '').toLowerCase();
const GIT_ENV = gitEnvFrom(process.env);
const CI = path.join(REPO, 'scripts', 'ci.mjs');
const HOOK = path.join(REPO, 'scripts', 'git-hooks', 'pre-push');
const OPS = path.join(REPO, 'src', 'server', 'ops-routes.js');

const MUTANTS = [
  { name: 'supersede loop removed', file: CI, suite: 'test-ci-heavy-launch',
    from: '  for (const old of running) {', to: '  for (const old of []) {' },
  { name: 'kill-identity gate removed (looksLikeHeavyRun)', file: CI, suite: 'test-ci-heavy-launch',
    from: '    if (!looksLikeHeavyRun(old.pid)) {', to: '    if (false) {' },
  { name: 'machine lock never taken', file: CI, suite: 'test-ci-heavy-launch',
    from: '  const held = acquireMachineLock(lockPath, {', to: '  const held = ((x) => ({ ok: true, release() {} }))({' },
  // heavyGate's handler loop. The two-space `) {` spelling is what makes this
  // anchor unique: fastGate's twin (round 5) is `if (isolate) for (const sig of
  // OUTSIDE_SIGNALS) process.on(…)` — one signal SET, two call sites, two
  // anchors.
  { name: 'SIGTERM cleanup handlers removed', file: CI, suite: 'test-ci-heavy-launch',
    from: '  for (const sig of OUTSIDE_SIGNALS) {', to: '  for (const sig of []) {' },
  { name: 'aborted run calls itself GREEN again', file: CI, suite: 'test-ci-heavy-launch',
    from: '    const verdict = abandonedWhy', to: '    const verdict = false' },
  { name: 'abandoned run stamps a verdict again', file: CI, suite: 'test-ci-heavy-launch',
    from: "    if (abandonedWhy || (abandonedWhy = abandoned())) noVerdict = abandonedWhy;", to: '    if (false) { }' },
  { name: 'killed-from-outside evidence removed', file: CI, suite: 'test-ci-heavy-launch',
    from: "export const killedFromOutside = (r) => !!(r && r.signal && OUTSIDE_SIGNALS.includes(r.signal) && !(r.error && r.error.code === 'ETIMEDOUT'));",
    to: 'export const killedFromOutside = (r) => false;' },
  // ROUND 4 — the two guards that keep a CRASH from reading as a supersession.
  { name: 'outside-signal allowlist widened back to "any signal" (round 4)', file: CI, suite: 'test-ci-heavy-launch',
    from: "export const killedFromOutside = (r) => !!(r && r.signal && OUTSIDE_SIGNALS.includes(r.signal) && !(r.error && r.error.code === 'ETIMEDOUT'));",
    to: "export const killedFromOutside = (r) => !!(r && r.signal && !(r.error && r.error.code === 'ETIMEDOUT'));" },
  { name: 'an ABORTED tier exits 0 again (round 4)', file: CI, suite: 'test-ci-heavy-launch',
    from: '    if (abandonedWhy) return 4;\n', to: '' },
  { name: 'the green marker unlocks a push of some OTHER branch (round 4)', file: HOOK, suite: 'test-ci-gate',
    from: ' && [ "$pushed_all_marked" = "1" ]', to: '' },
  { name: 'a new branch is judged by its TIP commit only (round 4)', file: HOOK, suite: 'test-ci-gate',
    from: 'range_cmd=(git log --name-only --format= "$local_sha" --not --remotes)',
    to: 'range_cmd=(git show --name-only --format= "$local_sha")' },
  { name: 'a range git cannot read counts as "nothing changed" (round 4)', file: HOOK, suite: 'test-ci-gate',
    from: '  if [ "$rc" != "0" ]; then', to: '  if false; then' },
  { name: 'pid-file abort removed (supersede no longer stops the run)', file: CI, suite: 'test-ci-heavy-launch',
    from: "    if (pidFile && !fs.existsSync(pidFile)) return 'superseded by a newer push (our pid file was removed)';", to: '' },
  { name: 'a marker kind reaches the CLI but not the route', file: OPS, suite: 'test-ci-gate',
    from: "/^([0-9a-f]{7,40})\\.(green|red|pid|skipped)$/", to: "/^([0-9a-f]{7,40})\\.(green|red|pid)$/" },
  { name: 'dirty tree refused at the END again, not up front', file: CI, suite: 'test-ci-gate',
    from: '  if (dirtyAtStart && !dirtyOk) {', to: '  if (false) {' },
  { name: 'comments no longer stripped before the fixture scan', file: CI, suite: 'test-ci-gate',
    from: '  const src = stripComments(source);', to: '  const src = source;' },
  { name: 'machine lock back on os.tmpdir() (TMPDIR moves it)', file: CI, suite: 'test-ci-gate',
    from: "  try { if (process.platform !== 'win32' && fs.statSync('/tmp').isDirectory()) return '/tmp'; } catch { }",
    to: '  if (0) { }' },
  { name: 'hook asks about HEAD again, not the pushed refs', file: HOOK, suite: 'test-ci-gate',
    from: '  node scripts/ci.mjs --check-heavy --head="$sha" >&2 || exit 1',
    to: '  node scripts/ci.mjs --check-heavy >&2 || exit 1' },
  { name: 'superseded run retries the suite it was killed in (round 3)', file: CI, suite: 'test-ci-heavy-launch',
    from: '          abandonedWhy = abandoned();\n          if (abandonedWhy) { console.log(`\\n[ci:heavy] stopping: ${abandonedWhy}`); break; }\n', to: '' },
  // ROUND 5 — the two halves of "what the fast tier is a verdict ABOUT".
  { name: 'the fast tier gates the WORKING TREE again, not the pushed sha (round 5)', file: HOOK, suite: 'test-ci-gate',
    from: '    if [ "$sha" = "$head_sha" ]; then', to: '    if true; then' },
  { name: 'ci.mjs ignores --isolate on the fast tier (round 5)', file: CI, suite: 'test-ci-heavy-launch',
    from: "    if (isolate) { wt = addScratchWorktree(sha, 'fast'); runRoot = wt; }",
    to: "    if (false) { wt = addScratchWorktree(sha, 'fast'); runRoot = wt; }" },
  // A mutation may need SEVERAL edits when the guard is an ORDERING rather than
  // a condition: moving the docs-only exit back above the heavy verdict is a
  // deletion plus an insertion, and approximating it with one edit would test
  // a different hook than the one that shipped before round 4.
  { name: 'docs-only exits BEFORE the heavy verdict is asked (round 4)', file: HOOK, suite: 'test-ci-gate',
    edits: [
      ['if [ "$only_docs" = "1" ] && [ "${#REFS[@]}" -gt 0 ]; then\n  echo "[ci] docs-only push — fast tier skipped" >&2\n  exit 0\nfi\n', ''],
      ['# ── HEAVY-TIER VERDICT FIRST (2026-09-07) ─',
        'if [ "$only_docs" = "1" ] && [ "${#REFS[@]}" -gt 0 ]; then\n  echo "[ci] docs-only push — fast tier skipped" >&2\n  exit 0\nfi\n\n# ── HEAVY-TIER VERDICT FIRST (2026-09-07) ─'],
    ] },
  // …and the other half of round 5: the "not code" set was a statement about
  // how a path LOOKS. Dropping both gate-input arms is the pre-round-5 hook.
  { name: 'a .md path the gate READS counts as documentation again (round 5)', file: HOOK, suite: 'test-ci-gate',
    edits: [
      ['    CLAUDE.md|CHANGELOG.md|docs/kb-*.md|docs/design-*.md|docs/agent/*|docs/examples/*) return 0 ;;\n', ''],
      ['    docs/README.md|docs/plugins.md|docs/settings.md|docs/keyboard-shortcuts.md) return 0 ;;\n', ''],
    ] },
];

// A mutation is one or more edits; `from`/`to` is the one-edit shorthand.
const editsOf = (m) => m.edits || [[m.from, m.to]];
const anchorsHold = (src, m) => editsOf(m).every(([from]) => src.includes(from));
const mutate = (src, m) => editsOf(m).reduce((s, [from, to]) => s.replace(from, to), src);

// SELF-HEAL FIRST (see the header): a previous run may have been killed before
// it could restore. The sidecar holds that run's pre-mutation bytes, so the
// test is exact — a file is healed only when it is byte-equal to one of the
// mutations applied to those bytes.
const BACKUP = path.join(os.tmpdir(), `vs-ci-mutations-backup-${typeof process.getuid === 'function' ? process.getuid() : 'u'}.json`);
{
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(BACKUP, 'utf-8')); } catch { }
  for (const [f, was] of Object.entries(prev || {})) {
    let cur;
    try { cur = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    if (cur === was) continue;
    const stranded = MUTANTS.find((m) => m.file === f && anchorsHold(was, m) && mutate(was, m) === cur);
    if (!stranded) {
      console.log(`  · ${path.relative(REPO, f)} differs from the last run's backup but is not one of its mutations — left alone (that is your edit, not our damage)`);
      continue;
    }
    fs.writeFileSync(f, was);
    console.log(`  ↺ healed ${path.relative(REPO, f)} — a previous run was killed mid-mutation ("${stranded.name}")`);
  }
  try { fs.unlinkSync(BACKUP); } catch { }
}

// AND REAP WHAT THIS TOOL LEAVES BEHIND. Several mutations exist precisely to
// KILL a heavy run (supersession, the SIGTERM-cleanup guard), and a run that
// dies without running its `finally` leaves a full checkout in TMPDIR *and* a
// `git worktree list` registration that `worktree prune` can never remove —
// the directory still exists (round 2's own note). Measured on this box after
// a few rounds of this battery: 196 MB across 18 registrations. Both tiers
// name their scratch worktree `vs-ci-<tier>-<sha8>-<pid>` (addScratchWorktree,
// round 5 — the fast tier gets one when a pushed ref's tip is not HEAD), so the
// pid in the name is the identity: reap only OUR shape, and only when that pid
// is gone.
// EPERM means alive (somebody else's process on a recycled number) — the one
// answer a reaper must not get wrong.
const pidGone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } };
const reapAbandoned = () => {
  const tmp = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const m = /^vs-ci-(?:heavy|fast)-[0-9a-f]{8}-(\d+)$/.exec(name);
    if (!m || !pidGone(Number(m[1]))) continue;
    const dir = path.join(tmp, name);
    spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', dir], { env: GIT_ENV });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    n++;
  }
  // A REGISTRATION KILLED DURING `worktree add` IS LOCKED, AND PRUNE SKIPS
  // LOCKED WORKTREES FOREVER. git takes its own transient lock with the reason
  // `initializing` while it checks the new worktree out and releases it when
  // the add completes — so a run killed inside that window (which is most of
  // what the SIGTERM mutations do) leaves a registration whose directory is
  // GONE and which no prune will ever remove. Measured: four of them on this
  // box, surviving every reap. Unlock ONLY that exact shape: our naming, a dead
  // pid, a directory that no longer exists, and the reason `initializing` —
  // any other reason is a human saying "don't touch this", and it is not ours
  // to overrule.
  let unlocked = 0;
  const listed = spawnSync('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8', env: GIT_ENV });
  let wt = null;
  for (const line of (listed.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) { wt = line.slice(9); continue; }
    if (!wt || !line.startsWith('locked')) continue;
    const reason = line.slice(6).trim();
    const m = /^vs-ci-(?:heavy|fast)-[0-9a-f]{8}-(\d+)$/.exec(path.basename(wt));
    if (reason === 'initializing' && m && pidGone(Number(m[1])) && !fs.existsSync(wt)) {
      spawnSync('git', ['-C', REPO, 'worktree', 'unlock', wt], { env: GIT_ENV });
      unlocked++;
    }
  }
  if (unlocked) console.log(`  ↺ unlocked ${unlocked} registration(s) git left locked as \`initializing\` when their run was killed mid-add`);
  // ALWAYS prune, not just when we removed something: a registration whose
  // directory is already gone (somebody cleared /tmp, or an earlier reap ran
  // with a different REPO) is exactly what prune is for, and gating it on our
  // own removals left four of them behind on this box — measured.
  spawnSync('git', ['-C', REPO, 'worktree', 'prune'], { env: GIT_ENV });
  return n;
};
const reaped = reapAbandoned();
console.log(reaped ? `  ↺ reaped ${reaped} abandoned heavy-run worktree(s) whose runner is gone` : '  · no abandoned heavy-run worktrees to reap');
if (REAP_ONLY) process.exit(0);

const orig = { [CI]: fs.readFileSync(CI, 'utf-8'), [HOOK]: fs.readFileSync(HOOK, 'utf-8'), [OPS]: fs.readFileSync(OPS, 'utf-8') };
// Written BEFORE the first mutation, removed on a clean finish: it is what the
// NEXT run heals from when this one is killed where no handler can run.
fs.writeFileSync(BACKUP, JSON.stringify(orig));
const restore = () => { for (const [f, s] of Object.entries(orig)) { try { if (fs.readFileSync(f, 'utf-8') !== s) fs.writeFileSync(f, s); } catch { } } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { restore(); process.exit(143); });

let bad = 0;
for (const m of MUTANTS) {
  if (ONLY && !m.name.toLowerCase().includes(ONLY)) continue;
  const src = orig[m.file];
  if (!anchorsHold(src, m)) { console.log(`  ?? ${m.name}: PATCH DID NOT APPLY (the anchor moved — this mutation proved nothing)`); bad++; continue; }
  fs.writeFileSync(m.file, mutate(src, m));
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', m.suite + '.mjs')], { cwd: REPO, encoding: 'utf-8', timeout: 600000 });
  restore();
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = /(\d+) FAILED/.exec(out);
  const red = r.status !== 0;
  console.log(`  ${red ? '✓' : '✗'} ${m.name} ⇒ ${m.suite} ${red ? `RED (${failed ? failed[1] + ' asserts' : 'exit ' + r.status})` : 'STAYED GREEN — the guard is not held by any assert'}`);
  if (red && failed) console.log(`      ${out.split('\n').filter((l) => l.startsWith('  ✗')).slice(0, 3).map((l) => l.trim()).join(' | ')}`);
  if (!red) bad++;
}
restore();
try { fs.unlinkSync(BACKUP); } catch { }   // finished cleanly: nothing left to heal
const ran = MUTANTS.filter((m) => !ONLY || m.name.toLowerCase().includes(ONLY)).length;
console.log(bad ? `\n${bad} mutation(s) did not go red` : `\nevery guard has an assert that dies with it (${ran} of ${MUTANTS.length} mutations${ONLY ? `, --only=${ONLY}` : ''})`);
process.exit(bad ? 1 : 0);
