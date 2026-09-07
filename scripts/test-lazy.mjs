#!/usr/bin/env node
// lazy.js Proxy bridge gate (2.343.0, 7th decomposition incident): reads
// resolve live, methods bind, and — the incident — ASSIGNMENTS reach the real
// singleton (a get-only Proxy silently swallowed `portForwards.plugins = x`
// for 17 releases; publish was dead the whole time).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mk } = require('../src/server/lazy.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };
let real = null;
const proxy = mk(() => real);
ok(proxy.anything === undefined, 'pre-singleton reads yield undefined');
proxy.plugins = { x: 1 }; // pre-singleton write drops (documented semantics)
real = { val: 7, fn() { return this.val; } };
ok(proxy.val === 7 && proxy.fn() === 7, 'reads + bound methods resolve to the live singleton');
proxy.plugins = { frp: true };
ok(real.plugins && real.plugins.frp === true, 'ASSIGNMENT reaches the REAL singleton (the incident class)');
const real2 = { val: 8 }; real = real2;
proxy.late = 1;
ok(real2.late === 1, 're-created singleton receives subsequent writes');
// A lazy ref is NOT a getter FUNCTION (2026-09-07, the permission-rule answer
// sink): the Proxy target is a plain `{}`, so `ref()` is a TypeError while
// `ref?.` happily passes — two consumers shipped `ref()?.method(...)` inside a
// `try`, one of them with a bare `catch {}`, and the answers were dropped for
// every session. Property access is the ONLY calling convention.
// scripts/test-permission-rules.mjs carries the drift guard over
// src/server/stdout/; this is the property it depends on.
let threw = null;
try { proxy(); } catch (e) { threw = e.message; }
ok(/is not a function/.test(threw || ''), 'a lazy ref is NOT callable — `ref()` throws (consumers must use `ref?.method?.()`)');
ok(mk(() => null)?.method?.() === undefined, '…and property access before the singleton exists is a silent undefined, which is the whole null check');
console.log(fail ? `\n${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
