#!/usr/bin/env node
/**
 * The remote "Recent" zone kept showing a terminated session as live until the
 * user pressed ⟳: the server dropped ITS discovery cache and told nobody, and
 * the client's per-host list has no TTL. This pins the notification to the one
 * invalidation entry point — the bug existed precisely because one call site
 * (/api/kill-pid) had a hand-wired refresh and the ws terminate path did not.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);
const { HostManager } = require('../src/hosts.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const h = new HostManager({ dataDir: scratch('disc-dirty') });
const seen = [];
h.onDiscoveryDirty = (id) => seen.push(id);

h._discoveryCache.set('h1', { at: Date.now(), sessions: [{ id: 'a' }] });
h.invalidateDiscovery('h1');
ok(!h._discoveryCache.has('h1'), 'invalidateDiscovery drops the cached list');
ok(seen.length === 1 && seen[0] === 'h1', 'invalidateDiscovery notifies with the host id');

// no hook installed must never throw (server may not have wired it yet at boot)
h.onDiscoveryDirty = null;
let threw = false;
try { h.invalidateDiscovery('h2'); } catch { threw = true; }
ok(!threw, 'a missing hook is harmless');
h.onDiscoveryDirty = () => { throw new Error('boom'); };
threw = false;
try { h.invalidateDiscovery('h3'); } catch { threw = true; }
ok(!threw, 'a throwing consumer cannot break invalidation');

// DRIFT GUARD: every other site must route through invalidateDiscovery, or the
// next feature silently reintroduces "server knows, client does not".
const src = readFileSync(new URL('../src/hosts.js', import.meta.url), 'utf-8');
const raw = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('_discoveryCache.delete'));
// allowed: inside invalidateDiscovery itself, and host REMOVAL (the record is
// gone; a dirty signal for a host that no longer exists is meaningless —
// hosts-updated covers that case)
ok(raw.length <= 2, `raw _discoveryCache.delete confined to invalidate+remove (found ${raw.length}: lines ${raw.map(([n]) => n).join(',')})`);

// The client must react to the broadcast — and must NOT fan out ssh scans for
// hosts nobody is displaying.
const wb = readFileSync(new URL('../src/lib/sidebar-workbench.js', import.meta.url), 'utf-8');
ok(/'remote-sessions'/.test(wb), 'client applies the pushed session list');
ok(!/_loadRemoteHost\(id, \{ fresh: true \}\)[\s\S]{0,80}remote-sessions/.test(wb) && !/remote-discovery-dirty/.test(wb),
   'client does NOT re-fetch on the signal (the computation is not the orchestrator-side clients\' job)');
ok(/msg\.error[\s\S]{0,200}sessions: cur\?\.sessions \|\| null/.test(wb), 'an unreachable machine degrades to the labelled last-known list');
const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf-8');
ok(/onDiscoveryDirty[\s\S]{0,900}discoverSessions[\s\S]{0,300}remote-sessions/.test(srv), 'server computes once and pushes the RESULT');
ok(/onDiscoveryDirty[\s\S]{0,700}wss\.clients\.size/.test(srv), 'no computation when nobody is connected');

// ── SWR cold start (2.320.0, inc-msp2srj2): a cold discoverSessions with a
// persisted last-known list returns it INSTANTLY (stale-marked) and kicks the
// background refresh through the same dirty→push channel; an explicit ⟳
// (ttlMs 0) still blocks for the real scan.
{
  const h2 = new HostManager({ dataDir: scratch('disc-swr') });
  h2._state.hosts.push({ id: 'hX', name: 'X' });
  h2._persistedDisc['hX'] = { at: Date.now() - 3600e3, sessions: [{ sessionId: 'aaa', status: 'remote-running' }] };
  let kicked = null; h2.onDiscoveryDirty = (id) => { kicked = id; };
  const t0 = Date.now();
  const r = await h2.discoverSessions('hX', {});
  ok(Date.now() - t0 < 200 && r.length === 1 && r[0].stale === true, 'cold call serves the persisted list instantly, stale-marked');
  ok(kicked === 'hX', 'and kicks the background refresh through the dirty channel');
  // ttlMs 0 must NOT serve stale (the ⟳ contract) — it runs the real ladder,
  // which for a fake host fails into the stale-cache rung of the ladder
  // itself (a different, labelled path) or throws; either way NOT the 1ms
  // instant return (we assert it does not return the instant-stale shape
  // by checking the SWR branch is gated on ttlMs > 0 in source).
  const src2 = readFileSync(new URL('../src/hosts.js', import.meta.url), 'utf-8');
  ok(/ttlMs > 0 && !hit && this\._persistedDisc/.test(src2), 'SWR branch is gated on ttlMs > 0 (explicit ⟳ still scans)');
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
