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

const writes = new Map(); // field → [file, ...]
for (const f of FILES) {
  let src = '';
  try { src = fs.readFileSync(path.join(REPO, f), 'utf-8'); } catch { continue; }
  for (const m of src.matchAll(/\b(?:session|sess)\._([A-Za-z0-9_]+)\s*=[^=]/g)) {
    const field = '_' + m[1];
    if (!writes.has(field)) writes.set(field, new Set());
    writes.get(field).add(f);
  }
}

ok(writes.size >= 40, `field inventory found (${writes.size} distinct written fields)`);
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
