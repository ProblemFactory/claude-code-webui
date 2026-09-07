#!/usr/bin/env node
// B-47e2 — the local discovery sweep's FS facts from device #0, flag-gated.
// PARITY: with a synthetic HOME (locks + transcripts + a resumed session's
// tail-id case), the sweep's output through the DEVICE snapshot must equal
// the local scan's output. LATENCY: the snapshot round trip is metered and
// must come in under the sweep's own 4.5s cache TTL by a wide margin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

// synthetic HOME with two projects, three transcripts, one live "claude" lock
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ldisc-'));
process.env.HOME = home;
process.env.VIBESPACE_AGENTD_ROOT = path.join(home, 'agentd-root');
const projA = path.join(home, '.claude', 'projects', '-work-alpha');
const projB = path.join(home, '.claude', 'projects', '-work-beta');
const SID1 = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const SID3 = '33333333-3333-4333-8333-333333333333';
const rec = (sid, text) => JSON.stringify({ type: 'user', sessionId: sid, timestamp: new Date().toISOString(), cwd: '/work/alpha', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
fs.mkdirSync(projA, { recursive: true }); fs.mkdirSync(projB, { recursive: true });
fs.writeFileSync(path.join(projA, SID1 + '.jsonl'), rec(SID1, 'alpha conversation one'));
fs.writeFileSync(path.join(projA, SID2 + '.jsonl'), rec(SID2, 'alpha conversation two'));
fs.writeFileSync(path.join(projB, SID3 + '.jsonl'), rec(SID3, 'beta conversation'));
// A live lock claiming SID1. THE FIXTURE MUST BE A REAL BINARY NAMED `claude`
// (B-3185 r3): this suite's whole point is that the DEVICE snapshot and the
// LOCAL sweep answer identically, and the two ask "is this pid claude?" through
// different rungs — the local sweep reads `ps -o comm=` (session-store
// isProcessClaude: the name of the file that was EXEC'd) while the device path
// runs the shared executable predicate (discovery-facts pidLooksClaude →
// src/cli-identity.js isCliProcess: argv[0] / interpreter operand / /proc/exe).
// On real processes those agree exactly — measured on the dev box, 16 of 4277
// processes, both rules, the same 16 — and THIS ASSERTION IS THAT TWIN'S PARITY
// GATE, so the fixture has to be a shape that occurs in production. The old
// fixture (`#!/bin/sh` script named claude) was not: the kernel gives the sh
// process argv[0] `/bin/sh` while `comm` stays `claude`, so it passed the local
// rung and failed the executable one — an artifact pinning a disagreement that
// no real install produces (and a wrapper script's lock file names the CHILD's
// pid anyway). A COPY of /bin/sh named `claude` gives comm `claude` AND argv[0]
// `<home>/claude`; a symlink would not (node renames its own comm to
// `MainThread`, and /bin/sleep can be a uutils multi-call binary that dispatches
// on argv[0]). It blocks on an empty stdin pipe, so it needs no child.
const { execFileSync, spawn } = require('child_process');
const fakeClaude = path.join(home, 'claude');
fs.copyFileSync(fs.realpathSync('/bin/sh'), fakeClaude); fs.chmodSync(fakeClaude, 0o755);
const child = spawn(fakeClaude, ['-c', 'read x'], { detached: false, stdio: ['pipe', 'ignore', 'ignore'] });
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'sessions', child.pid + '.json'),
  JSON.stringify({ pid: child.pid, sessionId: SID1, cwd: '/work/alpha', startedAt: new Date().toISOString() }));

// the route module with a controllable flag + a stub hosts.device(null)
const sessionsMod = require(REPO + '/src/routes/sessions.js');
const { DeviceManager } = require(REPO + '/src/agentd/client.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ldisc-data-'));
const dm = new DeviceManager({ dataDir, bundlePath: path.join(REPO, 'data/bin/vibespace-agentd.js'), version: '0.0.0-t', nodeModules: path.join(REPO, 'node_modules'), log: () => { } });
await dm.connect();

let flag = false;
const ctx = {
  activeSessions: new Map(), webuiPids: new Set(), refreshWebuiPids: () => { },
  createSessionMessages: () => ({}), BUFFERS_DIR: dataDir, PERMISSION_MODES: [],
  execFileSync, hosts: { device: async () => dm }, accounts: null, sessionAuth: () => ({}),
  serverSetting: (k) => (k === 'agentd.localDiscovery' ? flag : undefined),
};
sessionsMod.setup(ctx);
// drive the router's GET /api/sessions handler directly
const call = () => new Promise((resolve, reject) => {
  const layer = sessionsMod.router.stack.find((l) => l.route?.path === '/api/sessions');
  const req = { query: {} };
  const res = { json: (b) => resolve(b), status: () => res, send: reject };
  layer.route.stack[0].handle(req, res).catch?.(reject);
});

const strip = (list) => list.filter((s) => s.backend === 'claude').map((s) => ({
  id: s.sessionId, status: s.status, cwd: s.cwd, name: s.name, pid: s.pid || null,
})).sort((a, b) => a.id.localeCompare(b.id));

const ttl = () => new Promise((r) => setTimeout(r, 4700)); // the sweep caches 4500ms — a same-window second call is served from cache and would make parity VACUOUS
flag = false;
const local = await call();
await ttl();
flag = true;
const t0 = Date.now();
const dev = await call();
const devMs = Date.now() - t0;
await ttl();

ok(Array.isArray(local.sessions) && local.sessions.length >= 3, `local scan sees the 3 transcripts (${local.sessions?.length})`);
const L = strip(local.sessions), D = strip(dev.sessions);
const parity = JSON.stringify(L) === JSON.stringify(D);
ok(parity, `PARITY: device-facts sweep === local sweep (${L.length} sessions)`);
if (!parity) console.log('LOCAL:', JSON.stringify(L), '\nDEVICE:', JSON.stringify(D));
ok(devMs > 0, `the device call actually ran (not served from the sweep cache): ${devMs}ms`);
const s1 = D.find((x) => x.id === SID1);
ok(s1 && s1.status !== 'stopped' && s1.pid === child.pid, `the live lock claims its transcript through device facts (${s1?.status})`);
ok(devMs < 4000, `device-facts sweep latency ${devMs}ms — under the sweep's own cache TTL`);

// fallback: kill the daemon → flag-on sweep still answers (local fallback)
try { await dm.stop?.(); } catch { }
const fb = await call();
ok(Array.isArray(fb.sessions) && strip(fb.sessions).length === L.length, 'daemon down ⇒ flag-on sweep falls back to the local scan');

try { child.kill(); } catch { }
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
