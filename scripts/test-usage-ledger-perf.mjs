#!/usr/bin/env node
// inc-mtox23xw (2.369.36): Debugger.pause caught the server's main thread inside
// usageHistory._events ← costBetweenMulti ← learnRates ← ratesFor three times —
// a FULL ledger scan (plus a readdir+stat per shard) for EVERY anchor pair on
// EVERY recompute, recomputed on every new anchor. Loop gaps of 10-59s, every
// request slow, heartbeat terminations, reconnect storms. This suite pins the
// fix: a sorted view with binary-searched intervals, a 1s readdir throttle,
// and an interval memo — with brute-force parity so the numbers never drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 300) : '')); } };
const { UsageHistory } = require(path.join(REPO, 'src/usage-history.js'));
const { costBetweenMulti } = require(path.join(REPO, 'src/usage-anchors.js'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ledger-perf-'));
fs.mkdirSync(path.join(dataDir, 'usage-history'), { recursive: true });
// 60k events over 30 days, deliberately NOT in time order (remote harvests interleave)
const N = 60000, T0 = Date.UTC(2026, 7, 6), SPAN = 30 * 86400000;
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const lines = [];
for (let i = 0; i < N; i++) {
  const ts = T0 + Math.floor(rnd() * SPAN);
  const acct = ['sub-a', 'sub-b', '__global__', 'sub-c'][i % 4];
  lines.push(JSON.stringify({ rid: 'r' + i, ts, sid: 's' + (i % 50), acct, model: i % 3 ? 'claude-fable-5-1' : 'claude-opus-5', cwd: '/w', i: 100 + (i % 500), cw5: i % 7 ? 0 : 2000, cw1: 0, cr: 3000 + (i % 900), o: 40 + (i % 60), tier: 'default' }));
}
fs.writeFileSync(path.join(dataDir, 'usage-history', 'events-2026-08.ndjson'), lines.slice(0, 30000).join('\n') + '\n');
fs.writeFileSync(path.join(dataDir, 'usage-history', 'events-2026-09.ndjson'), lines.slice(30000).join('\n') + '\n');
const uh = new UsageHistory({ dataDir, homeDir: dataDir });
const all = uh._loadEvents();
ok(all.length === N, `ledger loads ${all.length} events across two shards`);

// brute-force reference (the pre-2.369.36 semantics, insertion order, full scan)
const brute = (ids, from, to) => {
  const want = new Set(ids);
  const out = { total: 0, requests: 0 };
  for (const ev of all) { if (ev.ts < from || ev.ts > to) continue; const a = ev.acct || '__global__'; if (!want.has(a)) continue; out.total += uh._cost(ev); out.requests++; }
  out.total = Math.round(out.total * 10000) / 10000; return out;
};
let mismatches = 0; const intervals = [];
for (let k = 0; k < 40; k++) { const a = T0 + Math.floor(rnd() * SPAN), b = a + Math.floor(rnd() * 3 * 86400000); intervals.push([a, b]); }
for (const [a, b] of intervals) {
  const r = costBetweenMulti(uh, ['sub-a', '__global__'], a, b), ref = brute(['sub-a', '__global__'], a, b);
  if (Math.abs(r.total - ref.total) > 1e-6 || r.requests !== ref.requests) mismatches++;
}
ok(mismatches === 0, 'costBetweenMulti (sorted + binary search) matches the brute-force full scan on 40 random intervals over an UNSORTED ledger');
// the MEMOIZED answer is the same answer — the parity loop above only ever
// exercised the miss path, so a bad hit-path copy would have been invisible
let warmMismatches = 0;
for (const [a, b] of intervals) {
  const r = costBetweenMulti(uh, ['sub-a', '__global__'], a, b), ref = brute(['sub-a', '__global__'], a, b);
  if (Math.abs(r.total - ref.total) > 1e-6 || r.requests !== ref.requests) warmMismatches++;
}
ok(warmMismatches === 0, '…and the MEMOIZED second reading of those 40 intervals is identical (hit path parity)');
ok(uh._evCountUpTo(T0 - 1) === 0 && uh._evCountUpTo(T0 + SPAN + 1) === N && uh._evCountUpTo(T0 + SPAN / 2) > 0.4 * N && uh._evCountUpTo(T0 + SPAN / 2) < 0.6 * N, '_evCountUpTo is a correct upper-bound count on the sorted view');
const gen = [...uh._events(T0 + 86400000, T0 + 2 * 86400000)];
ok(gen.every((e, i) => i === 0 || e.ts >= gen[i - 1].ts) && gen.every((e) => e.ts >= T0 + 86400000 && e.ts <= T0 + 2 * 86400000) && gen.length === all.filter((e) => e.ts >= T0 + 86400000 && e.ts <= T0 + 2 * 86400000).length, '_events yields exactly the interval, in time order');

// timing: 2000 pair-costs (a realistic learn) must be far below one loop-blocking second
const pairs = []; for (let k = 0; k < 2000; k++) { const a = T0 + Math.floor(rnd() * SPAN), b = a + 5 * 3600000; pairs.push([a, b]); }
let t = Date.now(); for (const [a, b] of pairs) costBetweenMulti(uh, ['sub-a', '__global__'], a, b); const cold = Date.now() - t;
t = Date.now(); for (const [a, b] of pairs) costBetweenMulti(uh, ['sub-a', '__global__'], a, b); const warm = Date.now() - t;
ok(cold < 1500, `2000 interval costs over 60k events, cold: ${cold}ms (was a full 60k scan per pair)`);
ok(warm < 60, `…and memoized on the second learn: ${warm}ms`);
// memo invalidation: a late event INSIDE an interval changes its cost
const [a0, b0] = pairs[0]; const before = costBetweenMulti(uh, ['sub-a'], a0, b0).total;
fs.appendFileSync(path.join(dataDir, 'usage-history', 'events-2026-09.ndjson'), JSON.stringify({ rid: 'late-1', ts: a0 + 1000, sid: 'sx', acct: 'sub-a', model: 'claude-fable-5-1', cwd: '/w', i: 100000, cw5: 0, cw1: 0, cr: 0, o: 1000, tier: 'default' }) + '\n');
uh._evCache = null; // what scan() does when a shard grew
const after = costBetweenMulti(uh, ['sub-a'], a0, b0).total;
ok(after > before, 'a backfilled event INSIDE a memoized interval invalidates that memo (count-at-or-before-`to` key)');
// readdir throttle: repeated _loadEvents calls within 1s must not re-stat the shards
const realReaddir = fs.readdirSync; let calls = 0; fs.readdirSync = (...a) => { if (String(a[0]).includes('usage-history')) calls++; return realReaddir(...a); };
for (let k = 0; k < 200; k++) uh._loadEvents();
fs.readdirSync = realReaddir;
ok(calls <= 2, `_loadEvents re-checks the shard dir at most once per second (${calls} readdir calls for 200 lookups)`);

// ── PRICING IS PART OF THE MEMO VERSION (2.369.43) ──────────────────────────
// The 2.369.36 key was ids|from|to|events-at-or-before-`to`. A pricing edit
// (tier rate or per-account discount — POST /api/usage-stats/pricing, or a
// config import through persistence.js) changes every historical cost while
// the ledger is untouched, so the memo kept serving pre-edit dollars into the
// learned rates and every anchor's costSince. Reproduced before the fix: a 10×
// tier edit AND a 50% account discount both returned the ORIGINAL total.
const priceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ledger-price-'));
fs.mkdirSync(path.join(priceDir, 'usage-history'), { recursive: true });
const P0 = Date.UTC(2026, 7, 6);
const priceLines = [];
for (let i = 0; i < 200; i++) priceLines.push(JSON.stringify({ rid: 'p' + i, ts: P0 + i * 60000, sid: 's1', acct: 'sub-a', model: 'claude-opus-5', cwd: '/w', i: 1000, cw5: 0, cw1: 0, cr: 0, o: 500, tier: 'default' }));
fs.writeFileSync(path.join(priceDir, 'usage-history', 'events-2026-08.ndjson'), priceLines.join('\n') + '\n');
const uhP = new UsageHistory({ dataDir: priceDir, homeDir: priceDir });
const wFrom = P0 - 1, wTo = P0 + 200 * 60000;
const priceTruth = () => { let t = 0; for (const ev of uhP._loadEvents()) t += uhP._cost(ev); return Math.round(t * 10000) / 10000; };
const c0 = costBetweenMulti(uhP, ['sub-a'], wFrom, wTo).total;
ok(Math.abs(c0 - priceTruth()) < 1e-6, `baseline interval cost matches the live price table ($${c0})`);
uhP.setPricing({ tiers: { opus: { input: 50, output: 250, cacheWrite5m: 62.5, cacheWrite1h: 100, cacheRead: 5 } } });
const c1 = costBetweenMulti(uhP, ['sub-a'], wFrom, wTo).total;
ok(Math.abs(c1 - priceTruth()) < 1e-6 && c1 > c0 * 9, `a TIER edit recomputes the memoized historical interval ($${c0} → $${c1}, was frozen at $${c0})`);
uhP.setPricing({ accounts: { 'sub-a': { discount: 0.5 } } });
const c2 = costBetweenMulti(uhP, ['sub-a'], wFrom, wTo).total;
ok(Math.abs(c2 - priceTruth()) < 1e-6 && Math.abs(c2 - c1 / 2) < 1e-4, `a per-ACCOUNT discount recomputes it too ($${c1} → $${c2})`);
const tokDiscounted = uhP.pricingToken();
ok(uhP.pricingToken() === tokDiscounted, 'the pricing token is stable while the table is (no per-call rehash)');
uhP.setPricing({ accounts: { 'sub-a': null } });
ok(uhP.pricingToken() !== tokDiscounted && Math.abs(costBetweenMulti(uhP, ['sub-a'], wFrom, wTo).total - priceTruth()) < 1e-6, 'clearing the override moves the token back and the cost with it');

// ── ONE MEMO PER LEDGER: identical ids|interval|count|pricing, different data ──
const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ledger-other-'));
fs.mkdirSync(path.join(otherDir, 'usage-history'), { recursive: true });
fs.writeFileSync(path.join(otherDir, 'usage-history', 'events-2026-08.ndjson'),
  priceLines.map((l) => JSON.stringify({ ...JSON.parse(l), i: 4000 })).join('\n') + '\n');
const uhO = new UsageHistory({ dataDir: otherDir, homeDir: otherDir });
const cOther = costBetweenMulti(uhO, ['sub-a'], wFrom, wTo).total;
let otherTruth = 0; for (const ev of uhO._loadEvents()) otherTruth += uhO._cost(ev);
ok(Math.abs(cOther - Math.round(otherTruth * 10000) / 10000) < 1e-6 && cOther !== costBetweenMulti(uhP, ['sub-a'], wFrom, wTo).total,
  `a SECOND ledger with the same key inputs gets its own costs ($${cOther} ≠ $${costBetweenMulti(uhP, ['sub-a'], wFrom, wTo).total}) — the memo is per-UsageHistory`);

// ── EVICTION MUST DEGRADE, NOT CLIFF (2.369.43) ─────────────────────────────
// learnRates walks one identity's pairs in the SAME order every recompute — a
// cyclic reference string, where FIFO (and LRU) go from 100% to 0% the moment
// the working set passes the cap. Measured on the pre-fix code: 20000 keys →
// 100% hits, 21000 → 0.0%, i.e. the per-pair ledger walk of inc-mtox23xw came
// straight back. Real anchor files are append-only forever (production: 5124
// pairs over 28 days across 8 identities, ~180/day), so the cap IS reached.
const realEvents = uh._events.bind(uh);
let evWalks = 0;
uh._events = function* (f, t) { evWalks++; yield* realEvents(f, t); };
const cyclic = []; // 1-minute intervals ⇒ cheap misses; only the HIT RATE is under test
for (let k = 0; k < 26000; k++) { const a = T0 + k * 60000; cyclic.push([a, a + 60000]); }
const sweep = () => { evWalks = 0; for (const [a, b] of cyclic) costBetweenMulti(uh, ['sub-c'], a, b); return 1 - evWalks / cyclic.length; };
sweep(); sweep();
const hitRate = sweep();
uh._events = realEvents;
ok(hitRate > 0.4, `a working set 30% past the 20000-entry cap still hits ${(hitRate * 100).toFixed(1)}% (FIFO measured 0.0% on the same input — the cliff is what brings the full-scan cost back)`);

// wiring: the estimator + the pool sweep still reach the same function
const ua = fs.readFileSync(path.join(REPO, 'src/usage-anchors.js'), 'utf8');
ok(/const _costMemos = new WeakMap\(\);/.test(ua) && /usageHistory\._evCountUpTo\(toMs \|\| Infinity\)/.test(ua) && /usageHistory\.pricingToken\(\)/.test(ua) && /_memoPut\(memo, memoKey/.test(ua),
  'costBetweenMulti memo is per-ledger and keyed by ids|from|to|count-up-to|pricing-token');
ok(/Math\.floor\(Math\.random\(\) \* m\.keys\.length\)/.test(ua), 'eviction picks a RANDOM victim (a cyclic scan defeats FIFO/LRU completely)');
ok(/typeof usageHistory\?\.pricingToken === 'function'/.test(ua), 'a ledger that cannot version its prices is NOT memoized at all');
const uhs = fs.readFileSync(path.join(REPO, 'src/usage-history.js'), 'utf8');
ok(/_sortedEvents\(\) \{/.test(uhs) && /if \(Date\.now\(\) - \(c\.checkedAt \|\| 0\) < 1000\) return c\.events;/.test(uhs) && /if \(to && ev\.ts > to\) break;/.test(uhs), 'usage-history has the sorted view, the 1s throttle and the early break');
ok(/pricingToken\(\) \{/.test(uhs) && /this\._priceTokFor === this\._pricing/.test(uhs), 'usage-history exposes the price-table token, recomputed only when the table object is REPLACED');
// the client half of inc-mtox23xw lives in scripts/test-chat-trim-guard.mjs
// (the 2.369.36 `rendered < 30` gate was unsatisfiable — see that suite)
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(priceDir, { recursive: true, force: true });
fs.rmSync(otherDir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
