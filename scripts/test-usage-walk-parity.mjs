#!/usr/bin/env node
// LOCAL ↔ REMOTE usage-walk PARITY (2.275.0, campaign Phase 4).
//
// The remote ledger scanner (data/bin/vibespace-usage-scan, shipped to hosts
// over ssh stdin as ONE self-contained file) is a REIMPLEMENTATION of the
// local UsageHistory walk. It has silently lagged its twin twice:
//   • 2.265.0 taught the LOCAL walk to mine <sid>/subagents/** and
//     subagents/workflows/wf_*/agent-*.jsonl (workflow-agent spend exists
//     ONLY there) — the remote copy kept scanning top-level transcripts only,
//     so every remote machine under-reported its workflow spend for 6 weeks.
//   • The fix was ported by hand in 2.271.0 — which is exactly the mechanism
//     that produced the divergence in the first place.
// The scanner cannot `require` a shared module (it must stay one file on a
// machine that has no VibeSpace checkout), so the structural guard is this
// BEHAVIOURAL parity test: run BOTH walkers over one fixture tree and demand
// the same coverage. Any future one-sided fix fails here immediately.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { UsageHistory } = require(path.join(REPO, 'src/usage-history.js'));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-walkpar-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-walkpar-data-'));
const proj = path.join(home, '.claude', 'projects', '-home-u-work');
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// One assistant record carrying usage — the only shape either walker counts.
let n = 0;
const rec = (model = 'claude-fable-5') => JSON.stringify({
  type: 'assistant', requestId: 'req_' + (++n), timestamp: new Date().toISOString(),
  message: { id: 'msg_' + n, model, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 7 } } },
}) + '\n';

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
// (a) top-level session transcript — both walkers always covered this
write(path.join(proj, SID + '.jsonl'), rec());
// (b) plain subagent transcript (2.265.0)
write(path.join(proj, SID, 'subagents', 'agent-plain1.jsonl'), rec());
// (c) WORKFLOW agent transcript — the one the remote twin missed for 6 weeks
write(path.join(proj, SID, 'subagents', 'workflows', 'wf_run1', 'agent-wfa.jsonl'), rec());
write(path.join(proj, SID, 'subagents', 'workflows', 'wf_run1', 'agent-wfb.jsonl'), rec());
// (d) noise that NEITHER may count (journal is bookkeeping, not usage)
write(path.join(proj, SID, 'subagents', 'workflows', 'wf_run1', 'journal.jsonl'),
  JSON.stringify({ type: 'result', key: 'x' }) + '\n');

// ── LOCAL walk ──
const uh = new UsageHistory({ dataDir, homeDir: home });
uh.scan({ force: true });
const localEvents = uh._loadEvents ? uh._loadEvents() : null;
const localRids = new Set((localEvents?.events || localEvents || []).map((e) => e.rid).filter(Boolean));

// ── REMOTE walk (the shipped scanner, exactly as a host runs it) ──
const cursor = path.join(dataDir, 'remote-cursor.json');
const stdout = execFileSync(process.execPath, [path.join(REPO, 'data/bin/vibespace-usage-scan')], {
  encoding: 'utf8', env: { ...process.env, HOME: home, VIBESPACE_USAGE_CURSOR: cursor }, timeout: 30000,
});
const remoteRids = new Set(stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).rid; } catch { return null; } }).filter(Boolean));

console.log(`  local rids: ${localRids.size} | remote rids: ${remoteRids.size}`);
ok(localRids.size === 4, 'local walk counts all 4 usage records (top-level + subagent + 2 workflow agents)');
ok(remoteRids.size === 4, 'remote walk counts all 4 — the 2.265.0/2.271.0 workflow lag would fail HERE');
const onlyLocal = [...localRids].filter((r) => !remoteRids.has(r));
const onlyRemote = [...remoteRids].filter((r) => !localRids.has(r));
ok(onlyLocal.length === 0, 'nothing counted locally is missed remotely' + (onlyLocal.length ? ` (missed: ${onlyLocal})` : ''));
ok(onlyRemote.length === 0, 'nothing counted remotely is missed locally' + (onlyRemote.length ? ` (extra: ${onlyRemote})` : ''));

// mid field parity (the 2.267.3 join rule): live stdout records lack a
// requestId, so per-message billing lookups join on message.id — BOTH walkers
// must carry it or remote replies can never attribute in the popup.
const remoteEvs = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
ok(remoteEvs.every((e) => e.mid && e.mid.startsWith('msg_')), 'remote walker emits the mid join field on every event');
const localEvsAll = (localEvents?.events || localEvents || []);
ok(localEvsAll.every((e) => e.mid && String(e.mid).startsWith('msg_')), 'local walker bakes mid on every event');

// Cursor semantics: a second run must emit NOTHING new (both sides are
// incremental; a re-emitting scanner would double-count on every harvest).
const stdout2 = execFileSync(process.execPath, [path.join(REPO, 'data/bin/vibespace-usage-scan')], {
  encoding: 'utf8', env: { ...process.env, HOME: home, VIBESPACE_USAGE_CURSOR: cursor }, timeout: 30000,
});
ok(stdout2.split('\n').filter(Boolean).length === 0, 'remote cursor is incremental (re-run emits nothing)');

// Growth is picked up on BOTH sides from the same append.
fs.appendFileSync(path.join(proj, SID, 'subagents', 'workflows', 'wf_run1', 'agent-wfa.jsonl'), rec());
const stdout3 = execFileSync(process.execPath, [path.join(REPO, 'data/bin/vibespace-usage-scan')], {
  encoding: 'utf8', env: { ...process.env, HOME: home, VIBESPACE_USAGE_CURSOR: cursor }, timeout: 30000,
});
ok(stdout3.split('\n').filter(Boolean).length === 1, 'remote walk picks up an append inside a workflow agent file');
uh.scan({ force: true });
const after = uh._loadEvents ? uh._loadEvents() : null;
const afterRids = new Set((after?.events || after || []).map((e) => e.rid).filter(Boolean));
ok(afterRids.size === 5, 'local walk picks up the same append');

// ── THIRD walker (R4, 2.286.0): src/usage-walker.js — the MODULE the device
// daemon bundles and runs as its `usage-scan` op. Same fixture, same events
// as the shipped scanner, byte for byte — plus the module's deliberate
// difference: it NEVER persists the cursor (the caller two-phase-commits). ──
{
  const { runUsageWalk } = require(path.join(REPO, 'src/usage-walker.js'));
  const modCursor = path.join(dataDir, 'module-cursor.json');
  const r1 = runUsageWalk({ home, cursorFile: modCursor });
  const modRids = new Set(r1.events.map((l) => { try { return JSON.parse(l).rid; } catch { return null; } }).filter(Boolean));
  ok(modRids.size === 5, `walker MODULE counts everything the scanner does (${modRids.size}/5)`);
  ok([...afterRids].every((r) => modRids.has(r)), 'module coverage identical to the local walk');
  ok(r1.events.every((l) => { const e = JSON.parse(l); return e.mid && e.mid.startsWith('msg_'); }), 'module emits the mid join field on every event');
  ok(!fs.existsSync(modCursor), 'module NEVER persists the cursor itself (two-phase commit is the caller)');
  // caller-committed cursor → next walk emits nothing (incremental holds)
  fs.writeFileSync(modCursor, JSON.stringify(r1.cursors));
  const r2 = runUsageWalk({ home, cursorFile: modCursor });
  ok(r2.events.length === 0, 'committed cursor makes the module incremental (re-run emits nothing)');
  // an append after commit is picked up
  fs.appendFileSync(path.join(proj, SID + '.jsonl'), rec());
  const r3 = runUsageWalk({ home, cursorFile: modCursor });
  ok(r3.events.length === 1, 'module picks up an append past the committed cursor');
}

// ── CODEX rollouts (walker v2, R4 step 2): all three walkers must count the
// same rollout events — synthetic rid = cumulative total, model/cwd from the
// preceding turn_context, input-minus-cached split, heartbeats skipped. ──
{
  const TID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const cxDir = path.join(home, '.codex', 'sessions', '2026', '08', '11');
  const cxts = (i) => new Date(Date.UTC(2026, 7, 11, 0, 0, i)).toISOString();
  // walker v3 (per-message meta work): the 0.153 token_usage_record that
  // PRECEDES a token_count names the vendor response id → `mid`; the
  // turn_context effort → `effort`. rid is UNCHANGED (the dedup key already
  // baked into permanent ledgers — changing it would double-count every
  // scanned rollout). The second response has no record (pre-0.153 shape) —
  // no mid may be invented for it.
  const rollout = [
    { timestamp: cxts(0), type: 'session_meta', payload: { id: TID, cwd: '/tmp/cx', cli_version: '0.153.4' } },
    { timestamp: cxts(0), type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.6-sol', cwd: '/tmp/cx', effort: 'high' } },
    { timestamp: cxts(1), type: 'response_item', payload: { type: 'message', id: 'msg_a1', role: 'assistant', content: [{ type: 'output_text', text: 'first reply' }] } },
    { timestamp: cxts(1), type: 'token_usage_record', payload: { thread_id: TID, turn_id: 't1', response_id: 'resp_p1', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 }, thread_token_usage: { total_tokens: 1050 } } },
    { timestamp: cxts(1), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 }, total_token_usage: { total_tokens: 1050 } } } },
    { timestamp: cxts(2), type: 'event_msg', payload: { type: 'token_count', info: null } }, // rate-limit heartbeat — skip
    { timestamp: cxts(3), type: 'response_item', payload: { type: 'message', id: 'msg_a2', role: 'assistant', content: [{ type: 'output_text', text: 'second reply' }] } },
    { timestamp: cxts(3), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 1100, output_tokens: 80 }, total_token_usage: { total_tokens: 2330 } } } },
  ];
  fs.mkdirSync(cxDir, { recursive: true });
  const rolloutFile = path.join(cxDir, `rollout-2026-08-11T00-00-00-${TID}.jsonl`);
  fs.writeFileSync(rolloutFile, rollout.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const runScanner = (cursorEnv) => execFileSync(process.execPath, [path.join(REPO, 'data/bin/vibespace-usage-scan')], {
    encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), VIBESPACE_USAGE_CURSOR: cursorEnv }, timeout: 30000,
  });
  const scCursor = path.join(dataDir, 'cx-scan-cursor.json');
  const scOut = runScanner(scCursor);
  const scEvs = scOut.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const scCx = scEvs.filter((e) => e.be === 'codex');
  ok(scCx.length === 2, `scanner emits 2 codex events, heartbeat skipped (${scCx.length})`);
  ok(scCx[0].rid === 'cx:' + TID + ':1050' && scCx[1].rid === 'cx:' + TID + ':2330', 'codex rids = cumulative totals (replay-dedupable) — UNCHANGED by the mid/effort fields');
  ok(scCx[0].model === 'gpt-5.6-sol' && scCx[0].cwd === '/tmp/cx', 'model/cwd carried from the preceding turn_context');
  ok(scCx[0].i === 200 && scCx[0].cr === 800 && scCx[0].o === 50, 'input-minus-cached split (i=fresh, cr=cached)');
  ok(scCx[0].mid === 'resp_p1' && scCx[0].effort === 'high', 'scanner bakes mid = the preceding token_usage_record response_id + effort from turn_context');
  ok(!('mid' in scCx[1]) && scCx[1].effort === 'high', 'a token_count with no token_usage_record (pre-0.153) gets NO invented mid; effort persists');

  const { runUsageWalk: walk2 } = require(path.join(REPO, 'src/usage-walker.js'));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(home, '.codex');
  const modCursor = path.join(dataDir, 'cx-mod-cursor.json');
  const mod = walk2({ home, cursorFile: modCursor });
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
  const modCx = mod.events.map((l) => JSON.parse(l)).filter((e) => e.be === 'codex');
  ok(JSON.stringify(modCx) === JSON.stringify(scCx), 'module codex events BYTE-IDENTICAL to the scanner (mid + effort included)');

  process.env.CODEX_HOME = path.join(home, '.codex');
  const uh3 = new UsageHistory({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vs-walkpar-cx2-')), homeDir: home });
  uh3.scan({ force: true });
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
  const l3 = uh3._loadEvents();
  const localCx = (l3?.events || l3 || []).filter((e) => e.be === 'codex');
  ok(localCx.length === 2 && localCx.every((e, i) => e.rid === scCx[i].rid), 'LOCAL walk counts the same codex rids (three-walker parity)');
  ok(localCx[0].mid === 'resp_p1' && localCx[0].effort === 'high' && !('mid' in localCx[1]), 'LOCAL ledger bakes the same mid/effort (scan enrichment passes them through)');
  // the rid-info route's two lookups (rid first, mid fallback) resolve a codex event
  ok(uh3.eventForRid('cx:' + TID + ':1050')?.mid === 'resp_p1', 'eventForRid finds the codex event by its ledger key');
  ok(uh3.eventForMid('resp_p1')?.rid === 'cx:' + TID + ':1050', 'eventForMid finds the codex event by its response id');

  // THE JOIN the popup depends on: the codex normalizer must derive the SAME
  // requestId the ledger minted for this rollout, and the same msgId.
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const msgs = new CodexMessageManager('cx-join').convertHistory(rollout).filter((m) => m.role === 'assistant');
  ok(msgs.length === 2 && msgs[0].meta?.requestId === scCx[0].rid && msgs[0].meta.msgId === scCx[0].mid && msgs[1].meta?.requestId === scCx[1].rid && msgs[1].meta.msgId === null, `normalizer meta.requestId === ledger rid / meta.msgId === ledger mid for the same rollout (${msgs.map((m) => m.meta?.requestId + '/' + m.meta?.msgId).join(', ')})`);
  ok(msgs[0].meta.usage.input_tokens === scCx[0].i && msgs[0].meta.usage.cache_read_input_tokens === scCx[0].cr && msgs[0].meta.usage.output_tokens === scCx[0].o && msgs[0].meta.effort === scCx[0].effort, 'normalizer usage split + effort equal the ledger fields');

  // SCAN BOUNDARY between the pair: the pending response id is parked in the
  // cursor, so a harvest that lands between token_usage_record and its
  // token_count still yields the mid on the next run (both walkers).
  fs.appendFileSync(rolloutFile, JSON.stringify({ timestamp: cxts(4), type: 'token_usage_record', payload: { thread_id: TID, turn_id: 't1', response_id: 'resp_p3', usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, total_tokens: 600 } } }) + '\n');
  ok(runScanner(scCursor).split('\n').filter(Boolean).length === 0, 'scanner: a trailing token_usage_record alone emits nothing');
  fs.writeFileSync(modCursor, JSON.stringify(mod.cursors));
  process.env.CODEX_HOME = path.join(home, '.codex');
  const modMid = walk2({ home, cursorFile: modCursor });
  ok(modMid.events.length === 0 && modMid.cursors[rolloutFile]?.pendMid === 'resp_p3', 'module: the pending response id rides the returned cursor (two-phase commit keeps it)');
  fs.writeFileSync(modCursor, JSON.stringify(modMid.cursors));
  fs.appendFileSync(rolloutFile, JSON.stringify({ timestamp: cxts(5), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, total_tokens: 600 }, total_token_usage: { total_tokens: 2930 } } } }) + '\n');
  const scLate = runScanner(scCursor).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const modLate = walk2({ home, cursorFile: modCursor }).events.map((l) => JSON.parse(l));
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
  ok(scLate.length === 1 && scLate[0].rid === 'cx:' + TID + ':2930' && scLate[0].mid === 'resp_p3', 'scanner: the token_count in the NEXT run still pairs with the parked record');
  ok(JSON.stringify(modLate) === JSON.stringify(scLate), 'module: identical late event (parity across the boundary)');
}

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
