#!/usr/bin/env node
// SESSION BLACKBOARD GUARD (拆分P3): every `session._field` / `sess._field`
// WRITE in the server-side session-handling files must be registered in
// src/session-schema.js with an owner. A new field added without a schema row
// fails here — the blackboard can grow, but never anonymously. Dead schema
// rows fail too (they hide future violations behind them).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const { SESSION_FIELDS } = require(path.join(REPO, 'src/session-schema.js'));
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (extra ? ' — ' + extra : '')); } };

// The server-side files that hold session objects. Client-side (src/lib) uses
// its own window/session mirrors — different objects, not in scope.
const FILES = [
  'server.js', 'src/ws-handler.js', 'src/ws-create.js', 'src/normalizers.js', // normalizers: the rebuild gate writes _rebuildQueue/_rebuildPromise (2.369.16)
  'src/routes/sessions.js', 'src/agent-routes.js', 'src/usage-routes.js',
  ...fs.readdirSync(path.join(REPO, 'src/server')).filter((f) => f.endsWith('.js')).map((f) => 'src/server/' + f),
  ...fs.readdirSync(path.join(REPO, 'src/server/stdout')).filter((f) => f.endsWith('.js')).map((f) => 'src/server/stdout/' + f), // S5: the per-protocol stdout consumers (owner 'stdout')
];

// THE DETECTOR READS ANY RECEIVER (design-account-hardening §4.4f, 2026-09-08).
// It used to match `session._x =` / `sess._x =` only — and the live session
// object is passed around as `s`, `s2`, `sessionObj`, … everywhere, so eight
// real fields were invisible to it, including `s._lastStopNudge`: the sole
// rate limiter on the largest measured automatic spender in the product (550
// Stop-nudge mini-turns in 3 days on this instance). A blackboard guard that
// only sees one spelling of the blackboard is not a guard.
//
// Widening to "any identifier" also catches receivers that are NOT sessions
// (ws clients, plugin records, the `data` payload of a create), so those are
// an ALLOWLIST WITH A REASON, in the shape every other census in this repo
// uses: an entry that stops matching anything FAILS too, so the list cannot
// quietly grow stale around a field that became a session field.
const NON_SESSION = [
  { recv: 'global', why: 'the two global telemetry hooks (__vsEvent/__vsMetric) — the process, not a session' },
  { recv: 'wss', why: 'the WebSocket SERVER (heartbeat pulse/timer) — src/server/ws-heartbeat.js' },
  { recv: 'ws', why: 'one WebSocket CLIENT connection (liveness), not the session it is attached to' },
  { recv: 'client', why: 'the same client connection under its other local name (heartbeat misses)' },
  { recv: 'rec', why: 'a PLUGIN registry record (crash timer / content-type warning) — src/server/plugin-loader.js' },
  { recv: 'dm', why: 'a DeviceManager handle (dial pairing stream), not a session' },
  { recv: 'locals', why: "express app.locals (the login-wake floor) — src/server/account-usage-routes.js" },
  { recv: 'out', why: 'a response payload being assembled (the __global__ usage key), not a session' },
  { recv: 'p', why: 'a workflow PHASE row while titles are being merged — src/routes/sessions.js' },
  { recv: 'h', why: 'a workflow-watcher handle (announced-once latch) — src/server/usage-pool-engine.js' },
  { recv: 'data', why: 'the ws CREATE payload (spawn-time hints: _placementModelHint, _effOutputStyle) — it is consumed at spawn and never stored on the session' },
  { recv: 'spawnAccount', why: 'the resolved ACCOUNT record for one spawn (_hostSubReady), not a session' },
];
const writes = new Map();   // field → Set(file) — SESSION fields
const others = new Map();   // receiver → Set(field) — everything the allowlist covers
for (const f of FILES) {
  let src = '';
  try { src = fs.readFileSync(path.join(REPO, f), 'utf-8'); } catch { continue; }
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\._([A-Za-z0-9_]+)\s*=[^=]/g)) {
    const recv = m[1], field = '_' + m[2];
    if (NON_SESSION.some((n) => n.recv === recv)) {
      if (!others.has(recv)) others.set(recv, new Set());
      others.get(recv).add(field);
      continue;
    }
    if (!writes.has(field)) writes.set(field, new Set());
    writes.get(field).add(f);
  }
}
const deadAllow = NON_SESSION.filter((n) => !others.has(n.recv));
ok(deadAllow.length === 0,
  `every non-session receiver on the allowlist still exists (${NON_SESSION.length} entries)`,
  deadAllow.map((n) => n.recv).join(', '));

ok(writes.size >= 40, `field inventory found (${writes.size} distinct written fields, any receiver)`);
const unregistered = [...writes.keys()].filter((k) => !(k in SESSION_FIELDS));
ok(unregistered.length === 0,
  'every written session._field is registered in src/session-schema.js (new field ⇒ add a row WITH an owner)',
  unregistered.map((k) => `${k} (${[...writes.get(k)].join(',')})`).slice(0, 6).join('; '));

// Dead = the field appears NOWHERE in the file set (object-literal
// initialization and reads count as alive — the write scanner only sees
// assignments, but a literal-initialized field like _resumeSpawn is real).
const allSrc = FILES.map((f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf-8'); } catch { return ''; } }).join('\n');
const dead = Object.keys(SESSION_FIELDS).filter((k) => !allSrc.includes(k));
ok(dead.length === 0, 'no dead schema rows (field gone from the codebase ⇒ remove its row)', dead.join(', '));

for (const [k, v] of Object.entries(SESSION_FIELDS)) {
  if (!v.owner || !('persisted' in v)) { fail++; console.error(`  ✗ ${k}: schema row missing owner/persisted`); }
}
ok(true, 'every schema row carries owner + persisted');

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
