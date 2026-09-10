#!/usr/bin/env node
// THE FORK COST OF ONE DISCOVERY SWEEP — the measuring instrument behind the
// "zero spawns per session" fix (2026-09-09; userW's pod: every session create
// and every kill was followed by an 11-17 s event-loop block).
//
// WHY IT EXISTS: `execFile` is asynchronous about the WAIT, not about the
// FORK. fork(2)/posix_spawn copies the parent's page tables ON THE CALLING
// THREAD, so a spawn from a 1.5 GB server costs the parent tens of
// milliseconds of BLOCKED loop before any child runs — and `Promise.all` over
// N spawns serialises N of those forks into ONE tick. The 2.235-era comment in
// src/session-store.js had already measured "each sync fork is 100-300ms under
// load" and then fixed only the wait.
//
// Usage:
//   node scripts/dbg-discovery-sweep-cost.mjs [--locks=50] [--rss=1500]
//        [--impl=src/session-store.js] [--runs=3] [--no-tmux] [--spawn-bench]
//
// Everything lives under a scratch HOME (scripts/scratch.mjs) — the developer's
// real ~/.claude is never read and never written.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scratch, scratchHome } from './scratch.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes(`--${k}`);
const LOCKS = Number(arg('locks', 50));
const RSS_MB = Number(arg('rss', 0));
const RUNS = Number(arg('runs', 3));
const IMPL = arg('impl', 'src/session-store.js');

// ── the spawn census: patch child_process BEFORE the module under test
//    destructures it (session-store and cli-identity both do so at require).
const cp = require('child_process');
let counting = false;
const spawns = new Map();
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
  const orig = cp[name];
  cp[name] = function (...args) {
    if (counting) {
      const key = `${name}:${String(args[0]).split('/').pop()}`;
      spawns.set(key, (spawns.get(key) || 0) + 1);
    }
    return orig.apply(this, args);
  };
}

const HOME = scratchHome('disc-cost', fs);
process.env.HOME = HOME;
const emptyPath = scratch('disc-cost-nopath');
fs.mkdirSync(emptyPath, { recursive: true });
if (has('no-tmux')) process.env.PATH = emptyPath;

// N live children, each with a lock file carrying its REAL procStart
const kids = [];
for (let i = 0; i < LOCKS; i++) kids.push(cp.spawn('/bin/sleep', ['300'], { stdio: 'ignore' }));
const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
const sessionsDir = path.join(HOME, '.claude', 'sessions');
const activeSessions = new Map();
kids.forEach((k, i) => {
  const sid = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
  fs.writeFileSync(path.join(sessionsDir, `${k.pid}.json`), JSON.stringify({
    pid: k.pid, sessionId: sid, cwd: path.join(HOME, 'proj' + i), procStart: procStart(k.pid),
  }));
  activeSessions.set('sess-' + i, { claudeSessionId: sid, _childPid: k.pid });
});

// inflate RSS the way a long-lived server is inflated: mapped AND TOUCHED
let ballast = null;
if (RSS_MB > 0) {
  ballast = Buffer.alloc(RSS_MB * 1024 * 1024);
  for (let o = 0; o < ballast.length; o += 4096) ballast[o] = 1;
}
const rss = () => Math.round(process.memoryUsage().rss / 1048576);

const store = require(path.join(REPO, IMPL));
const results = [];
counting = true;
for (let r = 0; r < RUNS; r++) {
  spawns.clear();
  const t0 = process.hrtime.bigint();
  const sessions = await store.discoverClaudeSessions({ activeSessions, webuiPids: new Set() });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let total = 0; for (const v of spawns.values()) total += v;
  results.push({ ms: +ms.toFixed(1), spawns: total, byCmd: Object.fromEntries(spawns), sessions: sessions.length });
}
counting = false;

if (has('spawn-bench')) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) cp.spawnSync('/bin/true');
  console.log(`spawnSync('/bin/true') at ${rss()} MB RSS: ${(Number(process.hrtime.bigint() - t0) / 1e6 / 20).toFixed(2)} ms/spawn`);
}

console.log(JSON.stringify({ impl: IMPL, locks: LOCKS, rssMB: rss(), tmux: !has('no-tmux'), runs: results }, null, 1));
if (ballast) ballast = null;
for (const k of kids) { try { k.kill('SIGKILL'); } catch { } }
fs.rmSync(HOME, { recursive: true, force: true });
try { fs.rmSync(emptyPath, { recursive: true, force: true }); } catch { }
