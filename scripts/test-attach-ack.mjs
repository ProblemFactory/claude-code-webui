#!/usr/bin/env node
// attach-ack proof-of-life contract (2.234.1, userL mass false-death
// incident): EVERY ws attach — real, sub-, or nonexistent id — must get a
// synchronous attach-ack BEFORE the (possibly slow) attached/error reply, so
// the client can tell "server alive and processing" from "server gone" and
// stop declaring live sessions dead on slow replies.
//
// NOTHING HERE IS MACHINE-GLOBAL (2026-09-07 round 2). This suite used to bind
// a fixed :3991 and check its worktree out at a fixed /tmp/vs-ack-smoke — which
// it FORCE-REMOVED first. On a box hosting ~160 checkouts of this repo driven
// by parallel agents that is not a fixture, it is a weapon: a second run of any
// gate deleted the first run's checkout mid-suite, and the loser's red blocked
// a push. (Three more suites share :3991 and four share :3989; the heavy tier's
// machine lock in scripts/ci.mjs keeps THEM serial. This one is fixed at the
// source because it is the destructive one.) The rule is asserted for the whole
// fast tier by test-ci-gate §6 via ci.mjs `machineGlobalFixtures`.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ack-smoke-'));
const wt = path.join(tmpRoot, 'wt');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? ' — ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) {
  execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
}
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

const probe = (sessionId) => new Promise((resolve) => {
  const seen = [];
  const h = (d) => {
    let m = {}; try { m = JSON.parse(d); } catch { return; }
    if (m.sessionId !== sessionId && m.type !== 'error') return;
    seen.push(m.type);
    if (m.type === 'attached' || m.type === 'error') { ws.off('message', h); resolve(seen); }
  };
  ws.on('message', h);
  ws.send(JSON.stringify({ type: 'attach', sessionId }));
  setTimeout(() => { ws.off('message', h); resolve(seen); }, 8000);
});

const dead = await probe('sess-does-not-exist-123');
check('nonexistent id: ack precedes the error reply', dead[0] === 'attach-ack', JSON.stringify(dead));
check('nonexistent id: still gets a terminal reply', dead.includes('error') || dead.includes('attached'), JSON.stringify(dead));

const sub = await probe('sub-agent-deadbeef00000000');
check('sub- viewer attach also acked first', sub[0] === 'attach-ack', JSON.stringify(sub));

ws.close();
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
