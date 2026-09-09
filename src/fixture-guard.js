'use strict';
/**
 * fixture-guard.js — THE ONE DECLARATION OF WHAT A TEST FIXTURE LOOKS LIKE,
 * so that no production reader can ever count one (2026-09-09).
 *
 * WHY THIS EXISTS. Three suites (test-chat-paging, test-minimap-jump,
 * test-desktop-resume-paging) build a SYNTHETIC claude transcript — hand-made
 * `assistant` records that name a model and carry a `usage` block although no
 * API request ever happened — and two of them wrote it into the developer's
 * REAL `~/.claude/projects` (they spawned the worktree server with the
 * inherited HOME, and the server can only discover a transcript that lives
 * under the home it is running with). While the suite runs, the machine's
 * PRODUCTION VibeSpace instance is walking that same directory: the sidebar
 * listed the fixture as a stopped "conversation", and the usage walk ingested
 * every fabricated `usage` block into the permanent ledger.
 *
 * MEASURED on the author's instance (2026-09-09 14:39 UTC): 79,533 ledger rows
 * for the two synthetic session ids, claiming 982,140 tokens of
 * `claude-fable-5` that were never spent; 245 more from REAL CI-probe turns in
 * a throwaway cwd; and 222 permanently dead cursor entries. `acct` is null on
 * every fabricated one, so they were attributed to the machine login
 * `__global__` and counted into the `costSince` of its anchor pairs — i.e.
 * into the learned burn rate the quota estimator spends against. The owner saw
 * a Fable conversation, and Fable usage, that never happened. The count was
 * still GROWING while this was written: another worktree running the unfixed
 * suite added 5,406 rows at 14:26 UTC.
 *
 * THE FIX IS TWO-SIDED and this module is the side both halves share:
 *   ① every suite that boots a server and needs discovery runs it under an
 *      ISOLATED HOME and writes its fixture there (scripts/scratch.mjs mints
 *      those paths from the constants below);
 *   ② no production reader counts a fixture even if one leaks — the usage walk
 *      (src/usage-walker.js + its shipped twin data/bin/vibespace-usage-scan)
 *      and session discovery (src/session-store.js) both skip them.
 * ① alone is not enough: a suite killed by a signal, an OOM, or a `git
 * worktree` cleanup that never reached its exit handler leaves the fixture
 * behind, and the production instance picks it up seconds later.
 *
 * PURE (imports nothing) because it is asked from three tiers — the SHARED
 * walk, SHARED discovery, and the ESM test scripts — and because the shipped
 * single-file scanner (a checkout-less ssh host cannot `require` src/) carries
 * a VERBATIM MIRROR of the two predicates, pinned by
 * scripts/test-usage-walk-parity.mjs. A rule with an import is a rule that
 * cannot be mirrored.
 *
 * THE COST, STATED. Skipping the whole fixture-cwd convention also skips the
 * handful of REAL turns the CI probes run in a throwaway cwd under the real
 * home (the wire probe, scripts/probe-claude-stdout.mjs). Measured on the same
 * ledger: 245 rows over its whole lifetime — 0.04 % of 573,802 — of genuine
 * machine-login spend stops being ledgered, against 79,533 fabricated rows
 * that stop being possible and a cursor file that stops growing. Those
 * transcripts are deleted by their own suites seconds later anyway, so the
 * ledger was keeping rows for conversations the product itself removes.
 */

// The basename prefix every throwaway fixture path carries, under a tmp root.
// scripts/scratch.mjs mints `<tmp>/<FIXTURE_CWD_PREFIX><name>-<pid>` and
// nothing else may hand a suite a cwd — that is what keeps the suites and the
// sweep from drifting (they read this same constant).
const FIXTURE_CWD_PREFIX = 'vs-';

// Synthetic session ids. A hand-written transcript names its own conversation,
// and this family is the ONLY evidence that survives when the fixture carries
// no cwd at all: the 79,533 poisoned rows have `cwd: null`, because a
// synthetic `assistant` record has no `cwd` field. Suites MUST take their
// session ids from here.
const FIXTURE_SID_PREFIX = 'e2e00000-0000-4000-8000-';

// Tmp roots a fixture cwd may live under. `/tmp` is what scratch() mints;
// `/var/tmp` is the only other place a TMPDIR realistically points on the
// platforms this ships to. Callers that know their own `os.tmpdir()` pass it.
const TMP_ROOTS = ['/tmp', '/var/tmp'];

// Fixture cwd prefixes that MUST run under the developer's REAL home, with the
// reason — the standing sweep spares exactly these and nothing else. Today
// there is one: the wire probe needs the machine's ACTUAL claude credentials
// (it measures what the installed CLI puts on our stdout, which is a property
// of that install), so it cannot be given a throwaway HOME. Its own residue
// contract — sweep at start, purge at report, >10 min = stale — is asserted by
// scripts/test-stdout-registry.mjs; the sweep below only has to not fight it.
const REAL_HOME_FIXTURE_PREFIXES = [
  { prefix: 'vs-wire-probe-', why: 'the wire probe measures the INSTALLED CLI with the machine\'s real credentials — a throwaway HOME would measure a different install (its own residue contract is pinned by test-stdout-registry)' },
];

// How old a fixture project dir under the real home must be before it is
// litter rather than a run in flight. Shared with the wire probe's own sweep
// so the two can never disagree about the same directory (test-stdout-registry
// asserts the probe reports this value and the clock it decided on).
const FIXTURE_STALE_MS = 10 * 60 * 1000;

/** cwdToProjectDir's rule (src/session-store.js), restated. It cannot be
 *  imported: session-store requires THIS module, and PURE imports nothing. */
function encodeCwd(cwd) {
  return String(cwd == null ? '' : cwd).replace(/[/._]/g, '-');
}

/** Is this `~/.claude/projects/<name>` entry the encoding of a fixture cwd? */
function isFixtureProjectDir(name, tmpRoots = TMP_ROOTS) {
  const n = String(name == null ? '' : name);
  for (const root of tmpRoots) {
    const head = encodeCwd(root) + '-' + FIXTURE_CWD_PREFIX;
    if (n.length <= head.length || !n.startsWith(head)) continue;
    // the tail is one encoded path segment chain — never a stray separator
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(n.slice(head.length))) return true;
  }
  return false;
}

/** Is this a synthetic conversation id minted by a suite? */
function isFixtureSid(sid) {
  return typeof sid === 'string' && sid.toLowerCase().startsWith(FIXTURE_SID_PREFIX);
}

/** Is this cwd one of the throwaway fixture paths? (the ledger row's own
 *  `cwd` field — the walk asks by project dir, consumers of stored rows ask
 *  by this.) */
function isFixtureCwd(cwd) {
  return isFixtureProjectDir(encodeCwd(cwd));
}

/** Does a fixture cwd legitimately live under the REAL home? Returns the
 *  declared reason, or null. Asked by name, never re-derived. */
function realHomeFixtureReason(name, tmpRoots = TMP_ROOTS) {
  const n = String(name == null ? '' : name);
  for (const root of tmpRoots) {
    const head = encodeCwd(root) + '-';
    if (!n.startsWith(head)) continue;
    const base = n.slice(head.length);
    for (const e of REAL_HOME_FIXTURE_PREFIXES) if (base.startsWith(e.prefix)) return e.why;
  }
  return null;
}

// The sentence the standing sweep prints. It is the RULE, not a description of
// the code: a sweep whose rule is only in its assert message teaches nobody
// what to do when it goes red.
const SWEEP_RULE = [
  'A suite\'s synthetic transcript must never reach the real ~/.claude/projects:',
  'the production instance discovers it as a conversation and ledgers its fabricated',
  'usage. Every suite that boots a server and needs discovery runs under an ISOLATED',
  'HOME (scripts/scratch.mjs mints the paths). The only fixture cwds allowed under the',
  'real home are the DECLARED ones in src/fixture-guard.js REAL_HOME_FIXTURE_PREFIXES,',
  `and even those only while in flight (< ${FIXTURE_STALE_MS / 60000} min old).`,
].join('\n    ');

/** THE SWEEP, as a pure decision over a directory listing.
 *  `entries`: [{name, mtimeMs}] from ~/.claude/projects.
 *  Returns {offenders, spared, rule} — offenders is what makes the gate red.
 *  Parameterised by root listing + clock so the negative control can plant one
 *  under a throwaway HOME and prove the rule catches it. */
function fixtureLitter(entries, { now = Date.now(), staleMs = FIXTURE_STALE_MS, tmpRoots = TMP_ROOTS } = {}) {
  const offenders = [], spared = [];
  for (const e of entries || []) {
    const name = e && e.name;
    if (!isFixtureProjectDir(name, tmpRoots)) continue;
    const ageMs = Math.max(0, now - (Number(e.mtimeMs) || 0));
    const why = realHomeFixtureReason(name, tmpRoots);
    if (why && ageMs <= staleMs) { spared.push({ name, ageMs, why }); continue; }
    offenders.push({ name, ageMs, declared: !!why });
  }
  return { offenders, spared, rule: SWEEP_RULE, staleMs, now };
}

module.exports = {
  FIXTURE_CWD_PREFIX, FIXTURE_SID_PREFIX, TMP_ROOTS, REAL_HOME_FIXTURE_PREFIXES,
  FIXTURE_STALE_MS, SWEEP_RULE,
  encodeCwd, isFixtureProjectDir, isFixtureSid, isFixtureCwd, realHomeFixtureReason, fixtureLitter,
};
