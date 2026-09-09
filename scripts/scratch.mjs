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
import net from 'node:net';

/** `/tmp/vs-<name>-<pid>` — unique per process, cleaned by the owning suite. */
export function scratch(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`scratch(): bad name ${JSON.stringify(name)}`);
  return `/tmp/vs-${name}-${process.pid}`;
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
