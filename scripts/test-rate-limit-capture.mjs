#!/usr/bin/env node
// rate_limit_event passive quota capture (B-e5c9). ONE shared implementation
// (src/rate-limit-capture.js) drives BOTH local and remote chat sessions —
// this pins the parse + the identity-group cache discipline that the server
// wiring depends on. Real captured-sample shapes + the anti-poison fetchedAt
// rule (a resetsAt-only event must not promote a stale file to "freshest").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { parseRateLimitEvent, captureRateLimitEvent } = require(REPO + '/src/rate-limit-capture.js');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? '\n    ' + e : '')); } };

// ── parse ──
// the EXACT shape captured from a real 2.1.226 buffer (5h, allowed, overage)
const real = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1786332600, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled_until', isUsingOverage: false }, uuid: 'x', session_id: 's' });
ok(real && real.kind === 'fiveHour' && real.status === 'allowed' && real.resetsAt === 1786332600, 'parses a real captured 5h event');
ok(real.utilization === null, 'no utilization in that sample → null (not fabricated)');
ok(real.overage.status === 'rejected' && real.overage.inUse === false, 'overage fields carried');

const withU = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 63, resetsAt: 1786900000 } });
ok(withU.kind === 'sevenDay' && withU.utilization === 0.63, 'integer-percent utilization normalized to 0..1');

const rej = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1786900000 } });
ok(rej.status === 'rejected', 'rejected status parsed (structured exhaustion signal)');

ok(parseRateLimitEvent({ type: 'assistant' }) === null, 'non-event returns null');
ok(parseRateLimitEvent({ type: 'rate_limit_event' }) === null, 'event with no info returns null');
// camelCase defensive path (2.227.6 — a future JSONL copy)
const camel = parseRateLimitEvent({ type: 'rate_limit_event', rateLimitInfo: { status: 'allowed', rate_limit_type: 'five_hour', used_percentage: 42 } });
ok(camel && camel.kind === 'fiveHour' && camel.utilization === 0.42, 'both key casings accepted');

// ── capture: identity-group cache discipline ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rle-'));
const read = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch { return null; } };

// a utilization reading writes the bucket + bumps fetchedAt (becomes an anchor)
const r1 = captureRateLimitEvent({ cacheDir: dir, key: 'sub-A', identityIds: ['sub-A'], ev: withU, now: 1000 });
ok(r1.ok && r1.wroteReading && !r1.dead, 'utilization reading writes + flags a reading');
ok(read('sub-A').sevenDay.utilization === 0.63 && read('sub-A').fetchedAt === 1000, 'reading lands + fetchedAt bumped');

// a resetsAt-ONLY event (no utilization, allowed) must NOT promote the file
const noReading = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: 1786999999 } });
const r2 = captureRateLimitEvent({ cacheDir: dir, key: 'sub-A', identityIds: ['sub-A'], ev: noReading, now: 5000 });
ok(r2.ok && !r2.wroteReading, 'resetsAt-only event is not a reading');
ok(read('sub-A').sevenDay.resetsAt === 1786999999, 'resetsAt updated in place');
ok(read('sub-A').fetchedAt === 1000, 'fetchedAt NOT bumped by a non-reading (anti-poison: no false anchor promotion)');

// rejected ⇒ dead bucket, utilization 1, self-expiring reset
const r3 = captureRateLimitEvent({ cacheDir: dir, key: 'sub-A', identityIds: ['sub-A'], ev: rej, now: 9000 });
ok(r3.dead && read('sub-A').fiveHour.utilization === 1 && read('sub-A').fiveHour.status === 'limited', 'rejected marks the bucket dead (utilization 1)');

// identity group: freshest file is the base; siblings marked WITHOUT gaining freshness
fs.writeFileSync(path.join(dir, 'gid-fresh.json'), JSON.stringify({ fetchedAt: 8000, fiveHour: { utilization: 0.1 } }));
fs.writeFileSync(path.join(dir, 'gid-stale.json'), JSON.stringify({ fetchedAt: 100, fiveHour: { utilization: 0.9 } }));
const deadEv = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
captureRateLimitEvent({ cacheDir: dir, key: '__global__', identityIds: ['__global__', 'gid-fresh', 'gid-stale'], ev: deadEv, now: 12000 });
ok(read('__global__').fiveHour.utilization === 1 && read('__global__').fiveHour.utilization === 1, 'primary (__global__) marked dead');
ok(read('gid-fresh').fiveHour.utilization === 1 && read('gid-fresh').fetchedAt === 8000, 'existing sibling marked dead but fetchedAt UNTOUCHED');
ok(read('gid-stale').fiveHour.utilization === 1 && read('gid-stale').fetchedAt === 100, 'stale sibling marked dead, still stale (never promoted)');
ok(read('__global__').fetchedAt === 12000, 'primary reading is dead ⇒ fetchedAt bumped (it IS a reading)');

// never CREATE a sibling that did not exist
ok(read('nonexistent') === null && !fs.existsSync(path.join(dir, 'never.json')), 'a missing sibling is never created');

// unknown bucket type surfaces, never silently drops
const scoped = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'weekly_scoped_fable' } });
const rS = captureRateLimitEvent({ cacheDir: dir, key: 'sub-A', identityIds: ['sub-A'], ev: scoped, now: 20000 });
ok(!rS.ok && rS.unknownType === 'weekly_scoped_fable', 'unknown bucket type surfaces unknownType (no silent drop)');

fs.rmSync(dir, { recursive: true, force: true });
// ── ④ scoped weekly capture (2.340.0): seven_day_<model> → scopedWeekly ─────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlc-scoped-'));
  fs.writeFileSync(path.join(dir, 'sub-s1.json'), JSON.stringify({ fetchedAt: Date.now() - 60000, sevenDay: { utilization: 0.4 } }));
  const ev = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day_opus', status: 'allowed_warning', utilization: 0.91, resetsAt: Math.floor(Date.now() / 1000) + 86400 } });
  ok(ev.kind === 'scoped' && ev.scopedName === 'opus', '④ seven_day_opus parses as a scoped reading');
  const r = captureRateLimitEvent({ cacheDir: dir, key: 'sub-s1', identityIds: ['sub-s1'], ev });
  ok(r.ok && r.wroteReading, '④ scoped reading is written (freshest-bump discipline applies)');
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'sub-s1.json'), 'utf-8'));
  const s = (cache.scopedWeekly || []).find((x) => x.name === 'opus');
  ok(s && Math.abs(s.utilization - 0.91) < 1e-9 && s.asOf > 0, '④ scopedWeekly entry carries utilization + asOf', JSON.stringify(s));
  const evR = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day_opus', status: 'rejected' } });
  captureRateLimitEvent({ cacheDir: dir, key: 'sub-s1', identityIds: ['sub-s1'], ev: evR });
  const cache2 = JSON.parse(fs.readFileSync(path.join(dir, 'sub-s1.json'), 'utf-8'));
  ok((cache2.scopedWeekly || []).find((x) => x.name === 'opus')?.utilization === 1, '④ scoped rejection marks the bucket dead (utilization 1)');
  const evO = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day_overage_included', status: 'allowed' } });
  ok(evO.kind !== 'scoped', '④ seven_day_overage_included is NOT a scoped model bucket');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑤ the monthly-spend-cap reject (live incident 2026-08-20): the weekly
//     overage-included lane IS the enforced weekly bucket — a rejected event
//     must mark sevenDay dead with the EVENT's resetsAt, and the overage
//     fields (org_level_disabled_until) must land in the cache. Mapping it to
//     'other' surfaced-but-never-marked: the pool kept re-picking a member
//     that was hard-dead until its reset.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlc-ovg-'));
  fs.writeFileSync(path.join(dir, 'sub-m1.json'), JSON.stringify({ fetchedAt: 1000, sevenDay: { utilization: 0.53, status: 'allowed' } }));
  // shape from the REAL captured buffer record (sess-2-1787194614944)
  const ev = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1787328000, rateLimitType: 'seven_day_overage_included', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled_until', isUsingOverage: false } });
  ok(ev.kind === 'sevenDay' && ev.status === 'rejected', '⑤ overage-included weekly reject parses as sevenDay');
  const r = captureRateLimitEvent({ cacheDir: dir, key: 'sub-m1', identityIds: ['sub-m1'], ev, now: 1787194614944 });
  ok(r.ok && r.dead, '⑤ capture reports dead (caller triggers immediate pool eval)');
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'sub-m1.json'), 'utf-8'));
  ok(c.sevenDay.utilization === 1 && c.sevenDay.status === 'limited' && c.sevenDay.resetsAt === 1787328000, '⑤ sevenDay marked dead until the EVENT reset (not a 24h guess)', JSON.stringify(c.sevenDay));
  ok(c.overage && c.overage.disabledReason === 'org_level_disabled_until', '⑤ monthly-spend-cap state (overage fields) lands in the cache');
  // the warning form carries the enforced-lane utilization — written as sevenDay
  const evW = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1787677200, rateLimitType: 'seven_day_overage_included', utilization: 0.77, isUsingOverage: false, surpassedThreshold: 0.75 } });
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlc-ovg2-'));
  fs.writeFileSync(path.join(dir2, 'sub-m2.json'), JSON.stringify({ fetchedAt: 1000 }));
  captureRateLimitEvent({ cacheDir: dir2, key: 'sub-m2', identityIds: ['sub-m2'], ev: evW, now: 2000 });
  const c2 = JSON.parse(fs.readFileSync(path.join(dir2, 'sub-m2.json'), 'utf-8'));
  ok(Math.abs(c2.sevenDay.utilization - 0.77) < 1e-9 && c2.sevenDay.status === 'allowed_warning', '⑤ overage-included utilization reading writes as sevenDay (the enforced lane)');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true });
}

// ── ⑥ reading attribution wiring ──
// B-b3cd's rule ("the OTel-observed org must match the link, else re-attribute
// the reading to the observed org") was REFUTED on 2026-09-07: organization.id
// is the identity the CLI cached in its config dir at SPAWN, and the credential
// file IS re-read on a re-point's mtime bump — so the rule filed a hot-switched
// session's readings under the account it STARTED on, permanently. A member
// whose login had been wiped on 09-02 kept "reporting" until 09-07.
// Now: a READING is keyed to the same thing a REJECTION is — the validated
// credential slot, resolved ONCE per turn (readingSlotFor / rejectionSlotFor);
// the observation only corroborates.
{
  const fs2 = await import('node:fs');
  const eng = fs2.readFileSync(new URL('../src/server/usage-pool-engine.js', import.meta.url), 'utf8');
  const engCode = eng.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/\borgVerifiedKey\b/.test(engCode), '⑥ REFUTED AND REMOVED: no executable line calls orgVerifiedKey — nothing may key a reading on the observed org (the comments keep the record)');
  ok(/function corroborateReading\(session, key, what\)[\s\S]{0,800}observedOrgFor\?\.\(session\?\.claudeSessionId\)/.test(eng), '⑥ the observation survives as CORROBORATION: same query, logs + telemetry, no return into the key');
  ok(/const slot = ev\.status === 'rejected' \? rejectionSlotFor\(session\) : readingSlotFor\(session\);/.test(eng), '⑥ rate_limit_event: rejection AND reading both resolve a credential slot (turn-pinned twins)');
  ok(/const key = slot\.key \|\| readingSlotFor\(session\)\.key \|\| usageCacheKeyFor\(session\)/.test(eng), '⑥ limit-banner marks land on the slot too (same physics, same resolver)');
  ok(/function resolveUsageKey\(session\)[\s\S]{0,900}sessionBillingMember\(session, acct\)\.id/.test(eng), '⑥ VALUES follow the credential slot as well — there is no longer a "reading member" different from the billing member');
  ok(/\(prev\.source \|\| 'unknown'\) === \(g\.cache\.source \|\| 'unknown'\)/.test(eng), '⑥ calib pairs are same-source (cross-source offset is attribution, not prediction error — mirrors extractPairs 2.340.0)');
  const sv = fs2.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok(/getOtelIngest: \(\) => \{ try \{ return otelIngest; \}/.test(sv), '⑥ server.js hands the engine a lazy otelIngest (TDZ: created later in the file)');
  ok(/observedOrgFor\(sid\)/.test(fs2.readFileSync(new URL('../src/server/otel-ingest.js', import.meta.url), 'utf8')), '⑥ the ingest exposes the per-session observed org');
  // ⑦ a DELETED account's zombie cache file must not join identity groups —
  // it poisoned org→account resolution (OTel booked live spend to the dead
  // id, atype 'unknown', outside every quota view: the org-29c4 implied-full
  // crash, 2026-08-24). A cache file with no roster record contributes
  // nothing true.
  ok(/if \(accountId && !acctRec\) continue;/.test(eng), '⑦ unregistered (deleted) account cache files are excluded from identity groups');
}

// ⑧ B-2c9b: the wall machine's ground-truth demotion rides THIS write path
// with source 'wall' (one write discipline — never a twin writer); the
// default label is unchanged for readings.
{
  const dir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rle8-'));
  const rd = (id) => JSON.parse(fs.readFileSync(path.join(dir8, id + '.json'), 'utf8'));
  fs.writeFileSync(path.join(dir8, 'sub-W.json'), JSON.stringify({ fetchedAt: 1000, source: 'cli-usage', fiveHour: { utilization: 0.2, resetsAt: 2_000_000_000 } }));
  const wall = captureRateLimitEvent({ cacheDir: dir8, key: 'sub-W', identityIds: ['sub-W'], ev: { kind: 'fiveHour', status: 'rejected', utilization: null, resetsAt: null, overage: {} }, now: 5000, source: 'wall' });
  ok(wall.ok && wall.dead && wall.wroteReading && rd('sub-W').source === 'wall' && rd('sub-W').fetchedAt === 5000, "⑧ source:'wall' labels the demotion write (a reading: fetchedAt bumped)");
  ok(rd('sub-W').fiveHour.utilization === 1 && rd('sub-W').fiveHour.resetsAt === 2_000_000_000, '⑧ …no signal reset ⇒ the cached FUTURE reset is kept (the wall machine\'s resetsAt ladder: signal > cached > bounded guess)');
  const rd2 = captureRateLimitEvent({ cacheDir: dir8, key: 'sub-W', identityIds: ['sub-W'], ev: rej, now: 6000 });
  ok(rd2.ok && rd('sub-W').source === 'rate-limit-event', "⑧ the default label stays 'rate-limit-event' for real events");
  ok(/source: 'wall'/.test(fs.readFileSync(new URL('../src/server/usage-pool-engine.js', import.meta.url), 'utf8')), '⑧ WIRING: the engine\'s demotion passes source wall through captureRateLimitEvent (no second writer)');
  try { fs.rmSync(dir8, { recursive: true, force: true }); } catch { }
}

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
