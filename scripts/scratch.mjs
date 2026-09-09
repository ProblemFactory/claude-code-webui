// Per-PROCESS scratch paths + free ports for the suites that spawn a throwaway
// server / headless chrome / git worktree (2.369.76). Fixed `/tmp/vs-<name>`
// paths and fixed ports were a MACHINE-wide collision: the heavy tier, a
// verifier agent running the same gate suite in its own worktree, and a
// developer's local run all shared `/tmp/vs-chatpage-smoke`, the chrome
// profile dir and port 3990 — one run's cleanup `git worktree remove --force`
// deleted another run's worktree mid-build (heavy tier RED at 40ad936d on
// test-chat-paging: esbuild lost its input, the retry's `worktree add` hit the
// path the other run had just recreated). 2.369.46 fixed ONE instance
// (test-chat-e2e's port 3995) inline; this is the third strike, so the idiom is
// shared and test-architecture sweeps every scripts/test-*.mjs for the fixed
// shapes. NOT a test-*.mjs on purpose: the tier census would demand a tier.
//
// SINCE 2026-09-09 the prefix and the tmp root are NOT literals here: they come
// from src/fixture-guard.js, the ONE declaration of what a fixture looks like.
// The production usage walk and session discovery skip exactly what this
// function mints, and the standing sweep (scripts/test-fixture-isolation.mjs)
// checks the real ~/.claude/projects for exactly what this function mints — so
// a suite that renames its scratch dir cannot walk out from under the guard.
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FIXTURE_CWD_PREFIX, TMP_ROOTS, FIXTURE_SID_PREFIX } = require('../src/fixture-guard.js');

/** `/tmp/vs-<name>-<pid>` — unique per process, cleaned by the owning suite. */
export function scratch(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`scratch(): bad name ${JSON.stringify(name)}`);
  return path.join(TMP_ROOTS[0], `${FIXTURE_CWD_PREFIX}${name}-${process.pid}`);
}

/** An ISOLATED $HOME for a suite that boots a server and needs discovery
 *  (2026-09-09). The server can only discover transcripts under the home it
 *  runs with, so the fixture goes HERE and the developer's real ~/.claude is
 *  never touched. `dirs` are pre-created because a spawned CLI/server must not
 *  race the first mkdir. Returns the home path; the caller removes it in its
 *  exit AND signal handlers. */
export function scratchHome(name, fs, dirs = ['.claude/projects', '.claude/sessions', '.config', '.vibespace']) {
  const home = scratch(name);
  for (const d of dirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

/** A suite's synthetic conversation id: `e2e00000-0000-4000-8000-<12 hex>`.
 *  Nothing else may mint one — the walk and discovery both refuse this family
 *  wherever it lands, which is the only guard that still works when the
 *  fixture carries no cwd at all (a hand-written `assistant` record has none). */
export function fixtureSid(suffix) {
  if (!/^[0-9a-f]{1,12}$/.test(suffix)) throw new Error(`fixtureSid(): bad suffix ${JSON.stringify(suffix)}`);
  return FIXTURE_SID_PREFIX + suffix.padStart(12, '0');
}

const listen0 = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => res(s));
});

/** N distinct free loopback ports. Every listener is held open until ALL are
 *  chosen (closing each before the next listen(0) may hand the same port back). */
export async function freePorts(n) {
  const servers = [];
  for (let i = 0; i < n; i++) servers.push(await listen0());
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

export async function freePort() { return (await freePorts(1))[0]; }
