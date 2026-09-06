#!/usr/bin/env node
// Codex 0.153.4 remainder of B-21e4 (+ B-8ebb's last row lives in test-incident):
//   ① FORK ORDINAL — a paginated ('Referenced') fork's rollout carries NONE of
//      its parent's records, only a parent-numbered boundary (history_base /
//      forked_from_ordinal_exclusive); the read-only view prepends the parent
//      prefix BELOW that ordinal, never the parent's later turns; sub-agent
//      rollouts (subagent_history_start_ordinal, child-numbered, context copied
//      in) add no ancestor; the wrapper chain keeps its old whole-file merge;
//      native fork parents stay LISTED (their own conversation).
// Shapes: SessionMeta in codex-rs protocol.rs + the 0.153.4 `codex app-server
// generate-ts` bindings (Thread.forkedFromId, ThreadReadParams…); the
// sub-agent fixture mirrors a real 0.153.4 rollout head (ordinal 0 = own meta,
// ordinal 1 = the copied parent meta, subagent_history_start_ordinal=36).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 400) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// isolated HOME: adapters/codex reads CODEX_SESSIONS_DIR at require time
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cx0153-'));
process.env.HOME = home; process.env.CODEX_HOME = path.join(home, '.codex');
const cxDir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
fs.mkdirSync(cxDir, { recursive: true });
const P = '01a07000-0000-7000-8000-000000000001', C = '01a07000-0000-7000-8000-000000000002', G = '01a07000-0000-7000-8000-000000000003', S = '01a07000-0000-7000-8000-000000000004';
const ts = (i) => `2026-09-05T10:00:${String(i).padStart(2, '0')}.000Z`;
const line = (ordinal, type, payload, i = ordinal) => JSON.stringify({ timestamp: ts(i), ordinal, type, payload }) + '\n';
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const asst = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const rollout = (tid, lines) => fs.writeFileSync(path.join(cxDir, `rollout-2026-09-05T10-00-00-${tid}.jsonl`), lines.join(''));
// P: a paginated root; the fork happens after ordinal 4 (so 0..4 is the child's prefix)
rollout(P, [
  line(0, 'session_meta', { id: P, session_id: P, cwd: '/w', cli_version: '0.153.4', history_mode: 'paginated' }),
  line(1, 'response_item', user('root prompt')),
  line(2, 'turn_context', { turn_id: 'p-t1', model: 'gpt-6-astra', effort: 'high' }),
  line(3, 'response_item', asst('root answer')),
  line(4, 'event_msg', { type: 'task_complete', turn_id: 'p-t1' }),
  line(5, 'response_item', user('after fork — parent only')),
  line(6, 'turn_context', { turn_id: 'p-t2', model: 'gpt-6-astra', effort: 'high' }),
  line(7, 'response_item', asst('parent-only answer')),
]);
// C: forked from P with history_base (Referenced): NO copy of P's records
rollout(C, [
  line(0, 'session_meta', { id: C, session_id: P, forked_from_id: P, cwd: '/w', cli_version: '0.153.4', history_mode: 'paginated', history_base: { thread_id: P, end_ordinal_exclusive: 5 } }, 20),
  line(1, 'response_item', user('child prompt'), 21),
  line(2, 'turn_context', { turn_id: 'c-t1', model: 'gpt-6-astra', effort: 'medium' }, 22),
  line(3, 'response_item', asst('child answer'), 23),
  line(4, 'response_item', user('child later — not in grandchild'), 24),
  line(5, 'response_item', asst('child later answer'), 25),
]);
// G: forked from C through the explicit ordinal field
rollout(G, [
  line(0, 'session_meta', { id: G, session_id: P, forked_from_id: C, forked_from_ordinal_exclusive: 4, cwd: '/w', cli_version: '0.153.4', history_mode: 'paginated' }, 30),
  line(1, 'response_item', user('grandchild prompt'), 31),
  line(2, 'response_item', asst('grandchild answer'), 32),
]);
// S: a sub-agent spawn — own meta, then the COPIED parent meta, inherited context, then its own history from ordinal 4
rollout(S, [
  line(0, 'session_meta', { id: S, session_id: P, forked_from_id: P, parent_thread_id: P, cwd: '/w', cli_version: '0.153.4', history_mode: 'paginated', thread_source: 'subagent', agent_nickname: 'Beauvoir', source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: '/root/x', agent_nickname: 'Beauvoir', agent_role: null } } }, subagent_history_start_ordinal: 4 }, 40),
  line(1, 'session_meta', { id: P, session_id: P, cwd: '/w', cli_version: '0.153.4', history_mode: 'paginated' }, 41),
  line(2, 'response_item', user('root prompt'), 42),
  line(3, 'response_item', asst('root answer'), 43),
  line(4, 'response_item', user('sub-agent task'), 44),
  line(5, 'response_item', asst('sub-agent answer'), 45),
]);

console.log('— ① fork ordinal: meta, ancestry, the read-only merge, listing');
const CX = require(path.join(REPO, 'src/adapters/codex.js'));
const ST = require(path.join(REPO, 'src/codex-session-store.js'));
const fp = (tid) => CX.findCodexSessionJsonlPath(tid);
const mC = CX.extractCodexThreadMeta(fp(C)), mG = CX.extractCodexThreadMeta(fp(G)), mS = CX.extractCodexThreadMeta(fp(S)), mP = CX.extractCodexThreadMeta(fp(P));
ok(mC.forkedFromId === P && mC.forkedFromOrdinal === 5 && mC.historyMode === 'paginated', 'history_base {thread_id, end_ordinal_exclusive} → forkedFromId + forkedFromOrdinal (parent-numbered)', { forkedFromId: mC.forkedFromId, forkedFromOrdinal: mC.forkedFromOrdinal, historyMode: mC.historyMode });
ok(mG.forkedFromId === C && mG.forkedFromOrdinal === 4, 'forked_from_ordinal_exclusive is read as the boundary too', { forkedFromId: mG.forkedFromId, forkedFromOrdinal: mG.forkedFromOrdinal });
ok(mS.forkedFromId === P && mS.forkedFromOrdinal === null && mS.ownHistoryStartOrdinal === 4 && mS.threadId === S && mS.agentKind === 'subagent', 'a sub-agent rollout: child-numbered subagent_history_start_ordinal, NO parent boundary; the copied parent meta (ordinal 1) never overrides the thread\'s own', { forkedFromOrdinal: mS.forkedFromOrdinal, own: mS.ownHistoryStartOrdinal, threadId: mS.threadId, kind: mS.agentKind });
ok(mP.forkedFromId === null && mP.forkedFromOrdinal === null && mP.ownHistoryStartOrdinal === null && mP.historyMode === 'paginated', 'a root thread carries nulls (no fabricated boundary)', mP);
ok(JSON.stringify(ST.resolveCodexForkAncestry(G)) === JSON.stringify([{ id: P, untilOrdinal: 5 }, { id: C, untilOrdinal: 4 }]), 'ancestry walks native fork parents oldest → newest with each boundary', ST.resolveCodexForkAncestry(G));
ok(JSON.stringify(ST.resolveCodexForkAncestry(G, ['w-old', C])) === JSON.stringify([{ id: P, untilOrdinal: 5 }, { id: 'w-old', untilOrdinal: null }, { id: C, untilOrdinal: 4 }]), 'the wrapper chain merges whole (untilOrdinal null); an id in BOTH takes the boundary; nothing lists twice', ST.resolveCodexForkAncestry(G, ['w-old', C]));
ok(ST.resolveCodexForkAncestry(S).length === 0 && ST.resolveCodexForkAncestry(P).length === 0, 'a sub-agent (context already copied in) and a root add no ancestor');
ok(ST.cutRecordsAtOrdinal([{ ordinal: 0 }, { ordinal: 4 }, { ordinal: 5 }, { x: 1 }], 5).length === 3 && ST.cutRecordsAtOrdinal([{ ordinal: 9 }], null).length === 1, 'cutRecordsAtOrdinal keeps records below the boundary and every ordinal-less record');
const texts = (sm) => sm.raw().filter((r) => r.type === 'response_item' && r.payload?.type === 'message').map((r) => r.payload.content[0].text);
const viewG = texts(new ST.CodexSessionMessages({ backend: 'codex', backendSessionId: G, buffer: '' }, 'g'));
ok(JSON.stringify(viewG) === JSON.stringify(['root prompt', 'root answer', 'child prompt', 'child answer', 'grandchild prompt', 'grandchild answer']), 'the grandchild\'s read-only view = P prefix (<5) + C prefix (<4) + its own, in order; the parents\' later turns are absent', viewG);
const viewC = texts(new ST.CodexSessionMessages({ backend: 'codex', backendSessionId: C, buffer: '' }, 'c'));
ok(viewC[0] === 'root prompt' && viewC.includes('child later — not in grandchild') && !viewC.includes('after fork — parent only'), 'the child\'s view keeps its own later turns and still excludes the parent\'s post-fork turns', viewC);
const viewS = texts(new ST.CodexSessionMessages({ backend: 'codex', backendSessionId: S, buffer: '' }, 's'));
ok(JSON.stringify(viewS) === JSON.stringify(['root prompt', 'root answer', 'sub-agent task', 'sub-agent answer']), 'a sub-agent view reads its own file only (inherited context is already inside it — no double prefix)', viewS);
const viewW = texts(new ST.CodexSessionMessages({ backend: 'codex', backendSessionId: G, forkedFrom: [S], buffer: '' }, 'w'));
ok(viewW.includes('sub-agent task') && viewW.includes('sub-agent answer') && viewW.includes('grandchild answer'), 'a wrapper-chain id (superseded conversation, no boundary of its own) still merges WHOLE — unchanged behaviour (fingerprint dedup stays turn-scoped as before)', viewW);
const viewWP = texts(new ST.CodexSessionMessages({ backend: 'codex', backendSessionId: G, forkedFrom: [P], buffer: '' }, 'wp'));
ok(!viewWP.includes('after fork — parent only') && viewWP[0] === 'root prompt', 'a wrapper-chain id that codex ALSO names as a bounded fork parent takes the boundary (the more precise truth wins)', viewWP);
const listing = ST.assembleCodexThreads(ST.collectCodexThreadMetas(), { activeSessions: new Map(), openThreadIds: new Set() });
const ids = listing.map((e) => e.backendSessionId);
ok([P, C, G, S].every((t) => ids.filter((x) => x === t).length === 1), 'every thread lists exactly once — a native fork parent is NOT hidden (it is its own live conversation)', ids);
const eC = listing.find((e) => e.backendSessionId === C);
ok(eC && eC.forkedFromId === P && eC.forkedFromOrdinal === 5 && eC.historyMode === 'paginated', 'listing entries carry forkedFromId/forkedFromOrdinal/historyMode (additive)', eC && { forkedFromId: eC.forkedFromId, forkedFromOrdinal: eC.forkedFromOrdinal, historyMode: eC.historyMode });
{
  // the wrapper chain still hides its superseded ids (zero behaviour change)
  const W = '01a07000-0000-7000-8000-000000000009';
  rollout(W, [line(0, 'session_meta', { id: W, cwd: '/w', forked_from: [S] }, 50), line(1, 'response_item', user('resumed incarnation'), 51)]);
  const l2 = ST.assembleCodexThreads(ST.collectCodexThreadMetas(), { activeSessions: new Map(), openThreadIds: new Set() }).map((e) => e.backendSessionId);
  ok(l2.includes(W) && !l2.includes(S), 'a wrapper forked_from chain still hides the superseded id (unchanged)', l2);
  fs.unlinkSync(fp(W));
}
{
  // wrapper: thread/fork → the session_meta record echoes forked_from_id and dedupes forked_from
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cx0153-w-'));
  const SID = 'sess-1-1700000000001';
  const buf = path.join(dir, SID + '.buf'), meta = path.join(dir, SID + '.json');
  const STUB = `const fs=require('fs');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.id!==undefined&&m.method){const r=m.method==='thread/fork'?{thread:{id:'th-forked',forkedFromId:'th-old',model:'gpt-6-astra'},model:'gpt-6-astra',reasoningEffort:'high'}:{};process.stdout.write(JSON.stringify({id:m.id,result:r})+'\\n');}}});setInterval(()=>{},1e3);`;
  const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, meta, process.execPath, '-e', STUB], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_WEBUI_CWD: dir, CODEX_WEBUI_RESUME_ID: 'th-old', CODEX_WEBUI_FORK: '1', CODEX_WEBUI_FORKED_FROM: 'th-older,th-old,th-old', VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
  });
  let out = ''; w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', () => {});
  const recs = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let t0 = Date.now(); while (Date.now() - t0 < 8000 && !recs().some((r) => r.type === 'session_meta')) await sleep(100);
  const sm = recs().find((r) => r.type === 'session_meta');
  ok(sm && sm.payload.id === 'th-forked' && sm.payload.forked_from_id === 'th-old', 'wrapper session_meta echoes codex\'s forked_from_id from the thread/fork response', sm?.payload);
  ok(sm && JSON.stringify(sm.payload.forked_from) === JSON.stringify(['th-older', 'th-old']), 'CODEX_WEBUI_FORKED_FROM is deduped (each superseded id once, own id dropped)', sm?.payload?.forked_from);
  try { w.kill('SIGTERM'); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('— ② 0.153 record tolerance: known skips, agent chatter, sub-agent cards, unknowns → telemetry once');
{
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const events = [];
  const prevEv = global.__vsEvent;
  global.__vsEvent = (name, detail) => events.push({ name, detail });
  const mm = new CodexMessageManager('t0153');
  const R = (type, payload, ordinal = 0) => ({ timestamp: '2026-09-05T17:49:40.476Z', ordinal, type, payload });
  // shapes verbatim from a real 0.153.4 rollout (ids sanitized) + the schema for the unknowns
  const seq = [
    R('session_meta', { id: 'th-1', cwd: '/w', cli_version: '0.153.4', history_mode: 'paginated' }),
    R('world_state', { full: true, state: { agents_md: {}, environments: { environments: { local: { cwd: '/w' } } } } }),
    R('turn_context', { turn_id: 't1', cwd: '/w', model: 'gpt-5.6-sol', effort: 'ultra', approval_policy: 'never' }),
    R('event_msg', { type: 'thread_settings_applied', thread_id: 'th-1', thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', approval_policy: 'never', cwd: '/w', reasoning_effort: 'ultra', personality: 'pragmatic' } }),
    R('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'design my van' }] }),
    R('event_msg', { type: 'item_completed', thread_id: 'th-1', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'design my van' }] } }),
    R('token_usage_record', { thread_id: 'th-1', turn_id: 't1', usage: { input_tokens: 17842, output_tokens: 351, total_tokens: 18193 } }),
    R('response_item', { type: 'function_call', call_id: 'k1', name: 'exec', arguments: '{"command":["ls"]}' }),
    R('response_item', { type: 'function_call_output', call_id: 'k1', output: 'a b' }),
    R('event_msg', { type: 'sub_agent_activity', event_id: 'call_B', occurred_at_ms: 1, agent_thread_id: '01a072b1-186b-7711-8176-817d3f6d0fee', agent_path: '/root/water_waste', kind: 'started' }),
    R('event_msg', { type: 'sub_agent_activity', event_id: 'call_B', occurred_at_ms: 2, agent_thread_id: '01a072b1-186b-7711-8176-817d3f6d0fee', agent_path: '/root/water_waste', kind: 'interacted' }),
    R('inter_agent_communication_metadata', { trigger_turn: false }),
    R('response_item', { type: 'agent_message', id: 'amsg_1', author: '/root/water_waste', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/water_waste\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAAABq…' }] }),
    R('event_msg', { type: 'sub_agent_activity', event_id: 'call_B', occurred_at_ms: 3, agent_thread_id: '01a072b1-186b-7711-8176-817d3f6d0fee', agent_path: '/root/water_waste', kind: 'completed' }),
    R('response_item', { type: 'brand_new_item', id: 'x1', whatever: 1 }),
    R('response_item', { type: 'brand_new_item', id: 'x2', whatever: 2 }),
    R('event_msg', { type: 'brand_new_event', foo: 'bar' }),
    R('brand_new_record', { anything: true }),
    R('response_item', { type: 'web_search_call', status: 'completed' }),
    R('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'here is the van' }] }),
    R('event_msg', { type: 'task_complete', turn_id: 't1' }),
  ];
  for (const r of seq) mm.processLive(r);
  global.__vsEvent = prevEv;
  const roles = mm.messages.map((m) => m.role);
  ok(!mm.messages.some((m) => m.role === 'system' && m.status !== 'complete'), 'no error card for any of the known/unknown 0.153 records', roles);
  ok(mm.messages.filter((m) => m.role === 'system').length === 1, 'known skips (world_state / token_usage_record / inter_agent_communication_metadata / item_completed) render NOTHING (only the init card exists)', roles);
  // B-7473: the sub-agent traffic is COLLAB ROWS now (an ENCRYPTED inbound
  // message has no body to show), and consecutive rows coalesce into one
  // message — 'started' + 'interacted' + the encrypted FINAL_ANSWER +
  // 'completed' are four rows on ONE 'agent'-kind message, no blob in sight.
  const collab = mm.messages.filter((m) => m.collab);
  const rows = collab.flatMap((m) => m.collab.rows);
  ok(collab.length === 1 && collab[0].role === 'tool' && collab[0].collapseKind === 'agent' && collab[0].status === 'complete', 'sub-agent traffic coalesces into ONE agent-kind message', collab.map((m) => m.content[0].output));
  const inbound = rows.find((r) => r.dir === 'in');
  ok(inbound && inbound.agentPath === '/root/water_waste' && inbound.agentName === 'water_waste' && inbound.msgType === 'FINAL_ANSWER' && inbound.encrypted === true, 'the encrypted agent_message is an inbound row with its msgType, marked encrypted', inbound);
  ok(!/gAAAAAB/.test(JSON.stringify(mm.messages)), 'no encrypted blob reaches any rendered string');
  const kinds = rows.filter((r) => r.dir === 'activity').map((r) => r.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(['started', 'interacted', 'completed']) && rows.every((r) => r.threadId === '01a072b1-186b-7711-8176-817d3f6d0fee'), 'started/interacted/completed each render once and carry the child thread id (click-through needs no lookup)', kinds);
  ok(mm.status().subagents['/root/water_waste'] === '01a072b1-186b-7711-8176-817d3f6d0fee', 'status().subagents maps agentPath → agentThreadId', mm.status().subagents);
  const st = mm.status();
  ok(st.model === 'gpt-5.6-sol' && st.effort === 'ultra', 'thread_settings_applied + turn_context.effort feed status().model/effort (typed source, no card)', st);
  const asst = mm.messages.find((m) => m.role === 'assistant');
  const userMsg = mm.messages.find((m) => m.role === 'user');
  ok(asst && userMsg && asst.turnIndex === userMsg.turnIndex && asst.content[0].text === 'here is the van' && asst.status === 'complete', 'the assistant reply after a run of unknown records lands in the SAME turn and completes (nothing dropped the turn)', { a: asst?.turnIndex, u: userMsg?.turnIndex });
  const ws = mm.messages.find((m) => m.collapseKind === 'search');
  ok(ws && ws.role === 'tool' && ws.status === 'complete', "an old-style web_search_call (no action) renders as a complete 'search'-kind card instead of vanishing", ws);
  const names = events.map((e) => e.name);
  ok(names.filter((n) => n === 'codex-unknown-record:brand_new_item').length === 1 && names.includes('codex-unknown-record:brand_new_event') && names.includes('codex-unknown-record:brand_new_record'), 'unknown response_item / event_msg / record types fire telemetry codex-unknown-record:<type> ONCE per type', names);
  ok(!names.some((n) => /world_state|token_usage_record|inter_agent|item_completed|thread_settings|sub_agent|agent_message/.test(n)), 'known types never fire the unknown-record telemetry', names);
  const S = CodexMessageManager;
  // item_completed STAYS in the exported generic set and is DISPATCHED before
  // it (_processEvent's first lines) — the router is an allowlist, so a kind it
  // does not name falls through to the same skip it always had. The pin that
  // matters is the ORDER, not the membership (test-codex-history mirrors it).
  const cmSrc = fs.readFileSync(path.join(REPO, 'src/codex-message-manager.js'), 'utf8');
  ok(S.SKIPPED_RECORD_TYPES.has('world_state') && S.SKIPPED_EVENT_TYPES.has('item_started') && S.SKIPPED_EVENT_TYPES.has('item_completed') && /if \(type === 'item_completed'\) return this\._processItemCompleted\(event, emit\);[\s\S]*if \(SKIPPED_EVENT_TYPES\.has\(type\)\) return;/.test(cmSrc) && S.SKIPPED_RESPONSE_ITEM_TYPES.has('additional_tools'), 'the skip sets are explicit and exported; item_completed is ROUTED FIRST (B-7473: the only 0.153.4 carrier of SubAgentActivity) and only then falls through the generic skip, its response_item twins named in the router');
}

console.log('— ③ effort enum: ultra offered when the served model reports it, with its delegation hint (zh/ja)');
{
  const am = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  ok(am.BACKEND_META.codex.effortHints?.ultra && !am.BACKEND_META.claude.effortHints, "META.codex.effortHints names 'ultra' (claude has no such level)");
  ok(am.effortLabel('codex', 'ultra', { capitalize: true }).startsWith('Ultra — ') && am.effortLabel('codex', 'ultra').startsWith('ultra — ') && am.effortLabel('codex', 'high', { capitalize: true }) === 'High' && am.effortLabel('claude', 'ultra') === 'ultra', 'effortLabel appends the hint for codex ultra only (plain names otherwise, no id comparison)', am.effortLabel('codex', 'ultra'));
  const app = read('src/lib/app.js'), sb = read('src/lib/chat-status-bar.js');
  ok(/const rank = \['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'\];/.test(app) && /label: effortLabel\('codex', e, \{ capitalize: true \}\)/.test(app) && /SETTINGS_SCHEMA\['codex\.defaultEffort'\]\.options = efforts\.map/.test(app), 'New-Session + settings pickers build the codex ladder from the served models\' union (ultra last) with the hinted label');
  ok(/label: effortLabel\(this\._backend, v\)/.test(sb) && /cur\?\.efforts\?\.length \? cur\.efforts/.test(sb), 'status-bar dropdown prefers the CURRENT model\'s reported levels and labels them through effortLabel');
  ok(/efforts: \(m\.supported_reasoning_levels \|\| \[\]\)\.map\(l => l && l\.effort\)/.test(read('server.js')), '/api/available-models carries each model\'s supported_reasoning_levels (the ultra source)');
  const key = 'delegates to sub-agents (multi-agent), extra usage';
  ok(read('src/lib/i18n-zh.js').includes(`"${key}":`) && read('src/lib/i18n-ja.js').includes(`"${key}":`), 'zh + ja carry the hint');
}

console.log('— ④ explicit model + effort on EVERY turn/start (resume continuity for effort)');
{
  const CX2 = require(path.join(REPO, 'src/adapters/codex.js'));
  ok(CX2.lastCodexTurnEffort(P) === 'high' && CX2.lastCodexTurnModel(P) === 'gpt-6-astra' && CX2.lastCodexTurnEffort('00000000-0000-4000-8000-000000000000') === null, 'lastCodexTurnEffort = the last turn_context.effort (model twin unchanged; unknown thread → null)');
  const wc = read('src/ws-create.js');
  ok(/if \(!sessionSpec\.env\.CODEX_WEBUI_EFFORT\) \{ try \{ const le = lastCodexTurnEffort\(data\.resumeId\); if \(le\) sessionSpec\.env\.CODEX_WEBUI_EFFORT = le; \} catch \{ \} \}/.test(wc) && /lastCodexTurnModel, lastCodexTurnEffort/.test(wc), 'ws-create: a codex resume without an explicit effort carries the last-run effort (client choice still wins)');
  // the REAL wrapper against a stub app-server: resume reply names model + effort → every turn/start carries both
  const run = async (env, label) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cx0153-e-'));
    const SID = 'sess-4-1700000000004';
    const buf = path.join(dir, SID + '.buf'), meta = path.join(dir, SID + '.json'), rpcLog = path.join(dir, 'rpc.jsonl');
    const STUB = `const fs=require('fs');let b='';let n=0;const send=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.id===undefined||!m.method)continue;fs.appendFileSync(${JSON.stringify(rpcLog)},l+'\\n');if(m.method==='thread/resume'){send({id:m.id,result:{thread:{id:'th-r',model:'gpt-6-astra',reasoningEffort:'high'},model:'gpt-6-astra',reasoningEffort:'high'}});continue;}if(m.method==='turn/start'){n++;const t='turn-'+n;send({id:m.id,result:{turn:{id:t}}});send({method:'turn/completed',params:{turn:{id:t},status:'completed'}});continue;}send({id:m.id,result:{}});}});setInterval(()=>{},1e3);`;
    const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, meta, process.execPath, '-e', STUB], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_WEBUI_CWD: dir, CODEX_WEBUI_RESUME_ID: 'th-r', CODEX_WEBUI_MODEL: '', CODEX_WEBUI_EFFORT: '', VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1', ...env },
    });
    w.stdout.on('data', () => {}); w.stderr.on('data', () => {});
    const rpc = () => { try { return fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const readMeta = () => { try { return JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { return null; } };
    const send = (o) => w.stdin.write(JSON.stringify(o) + '\n');
    let t0 = Date.now(); while (Date.now() - t0 < 8000 && readMeta()?.threadId !== 'th-r') await sleep(100);
    send({ type: 'chat-input', text: 'first', msgId: 'm1' });
    t0 = Date.now(); while (Date.now() - t0 < 8000 && !rpc().some((m) => m.method === 'turn/start')) await sleep(100);
    const t1 = rpc().find((m) => m.method === 'turn/start');
    send({ type: 'set-effort', effort: 'xhigh' });
    await sleep(200);
    send({ type: 'chat-input', text: 'second', msgId: 'm2' });
    t0 = Date.now(); while (Date.now() - t0 < 8000 && rpc().filter((m) => m.method === 'turn/start').length < 2) await sleep(100);
    const t2 = rpc().filter((m) => m.method === 'turn/start')[1];
    try { w.kill('SIGTERM'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    return { t1: t1?.params, t2: t2?.params, meta: readMeta() };
  };
  const a = await run({}, 'no commanded effort');
  ok(a.t1?.model === 'gpt-6-astra' && a.t1?.effort === 'high', 'no commanded effort: the first turn/start after thread/resume carries the thread\'s model AND effort explicitly (adopted from the resume reply)', a.t1 && { model: a.t1.model, effort: a.t1.effort });
  ok(a.t2?.effort === 'xhigh' && a.t2?.model === 'gpt-6-astra', 'set-effort rewrites the per-turn effort (explicit on the next turn/start too)', a.t2 && { model: a.t2.model, effort: a.t2.effort });
  const b = await run({ CODEX_WEBUI_EFFORT: 'low' }, 'commanded effort');
  ok(b.t1?.effort === 'low' && b.t1?.model === 'gpt-6-astra', 'a COMMANDED effort (spawn env, e.g. the last-run effort ws-create carries) wins over the resume reply', b.t1 && { effort: b.t1.effort });
  const w = read('data/bin/codex-chat-wrapper.js');
  ok(/model: meta\.model \|\| undefined,\s*\n\s*effort: effort \|\| undefined,/.test(w) && /if \(!effort && typeof resp\?\.reasoningEffort === 'string' && resp\.reasoningEffort\) \{ effort = resp\.reasoningEffort;/.test(w), 'wrapper pin: turn/start passes model + effort; an uncommanded effort is adopted from the thread reply');
}

console.log('— ⑤ thread/read fallback for a thread with NO rollout (0.153 paginated history; local only)');
{
  const TR = require(path.join(REPO, 'src/codex-thread-read.js'));
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const MISSING = '01a07000-0000-7000-8000-00000000aaaa', UNKNOWN = '01a07000-0000-7000-8000-00000000bbbb', OTHER = '01a07000-0000-7000-8000-00000000cccc';
  // v2 Thread fixture in the 0.153.4 `thread/read {includeTurns:true}` shape (field names from the generated bindings;
  // the live probe on this machine answered a real thread with exactly these item types)
  const T0 = 1788600000;
  const THREAD = { id: MISSING, sessionId: MISSING, forkedFromId: null, parentThreadId: null, preview: 'hello from thread/read', ephemeral: false, historyMode: 'paginated', modelProvider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'ultra', createdAt: T0, updatedAt: T0 + 100, status: { type: 'idle' }, path: null, cwd: '/w', cliVersion: '0.153.4', source: 'appServer', threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: 'Van design', turns: [
    { id: 't1', status: 'completed', error: null, startedAt: T0 + 1, completedAt: T0 + 20, durationMs: 19000, itemsView: 'full', items: [
      { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'hello from thread/read', text_elements: [] }] },
      { type: 'reasoning', id: 'r1', summary: ['thinking about it'], content: [] },
      { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/w', status: 'completed', aggregatedOutput: 'total 0', exitCode: 0, durationMs: 5, processId: null, source: 'agent', commandActions: [], pluginId: null, scriptPath: null },
      { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'list_issues', status: 'completed', arguments: { repo: 'x/y' }, result: { content: [{ type: 'text', text: '3 issues' }], structuredContent: null, _meta: null }, error: null, durationMs: 9, appContext: null, pluginId: null, readOnlyHint: null },
      { type: 'fileChange', id: 'f1', changes: [{ path: '/w/a.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }], status: 'completed' },
      { type: 'webSearch', id: 'w1', query: 'rv solar', action: { type: 'search', query: 'rv solar' } },
      { type: 'imageView', id: 'i1', path: '/w/x.png' },
      { type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: '01a07000-0000-7000-8000-0000000000dd', agentPath: '/root/water' },
      { type: 'agentMessage', id: 'a1', text: 'done: here is the plan', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
    ] },
    { id: 't2', status: 'failed', error: { message: 'usage limit', codexErrorInfo: 'usage_limit_reached', additionalDetails: null, misalignment: null }, startedAt: T0 + 30, completedAt: T0 + 31, durationMs: 1000, itemsView: 'full', items: [
      { type: 'userMessage', id: 'u2', clientId: null, content: [{ type: 'text', text: 'second', text_elements: [] }] },
      { type: 'contextCompaction', id: 'cc1' },
    ] },
    { id: 't3', status: 'inProgress', error: null, startedAt: T0 + 40, completedAt: null, durationMs: null, itemsView: 'full', items: [
      { type: 'userMessage', id: 'u3', clientId: null, content: [{ type: 'text', text: 'third', text_elements: [] }] },
      { type: 'commandExecution', id: 'c3', command: 'sleep 100', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null, processId: null, source: 'agent', commandActions: [], pluginId: null, scriptPath: null },
      { type: 'hookPrompt', id: 'h1', fragments: [] },
    ] },
  ] };
  // (a) PURE mapper → the normalizer renders it with the existing card pipeline
  const recs = TR.threadToRecords(THREAD);
  ok(recs[0].type === 'session_meta' && recs[0].payload.id === MISSING && recs[0].payload.model === 'gpt-6-astra' && recs[0].payload.read_via === 'thread/read', 'threadToRecords leads with a session_meta (id/model/cwd/history_mode) marked read_via', recs[0].payload);
  const mm = new CodexMessageManager('tr');
  mm.convertHistory(recs);
  const users = mm.messages.filter((m) => m.role === 'user').map((m) => m.content[0].text);
  ok(JSON.stringify(users) === JSON.stringify(['hello from thread/read', 'second', 'third']) && new Set(mm.messages.filter((m) => m.role === 'user').map((m) => m.turnIndex)).size === 3, 'three turns → three user bubbles on three turn indexes', users);
  ok(mm.messages.some((m) => m.role === 'assistant' && m.content[0].type === 'text' && m.content[0].text === 'done: here is the plan') && mm.messages.some((m) => m.content[0].type === 'thinking' && /thinking about it/.test(m.content[0].text)), 'agentMessage → assistant text; reasoning summary → thinking block');
  const tools = Object.fromEntries(mm.messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, { k: m.collapseKind, s: m.status, out: m.content[0].output, files: m.content[0].input?.files }]));
  ok(tools.c1?.k === 'bash' && tools.c1.s === 'complete' && tools.c1.out === 'total 0', 'commandExecution → Bash card with its aggregated output', tools.c1);
  ok(tools.m1?.k === 'mcp' && tools.m1.s === 'complete' && tools.m1.out === '3 issues', 'mcpToolCall → mcp fold card with the result text', tools.m1);
  ok(tools.f1?.k === 'write' && tools.f1.s === 'complete' && tools.f1.files?.[0] === '/w/a.js', 'fileChange → apply_patch write card naming the file', tools.f1);
  const saMsg = mm.messages.find((m) => m.collab?.rows?.some((r) => r.dir === 'activity'));
  ok(tools.w1?.k === 'search' && tools.i1?.k === 'image' && saMsg?.collapseKind === 'agent' && saMsg.collab.rows[0].threadId === '01a07000-0000-7000-8000-0000000000dd', 'webSearch / imageView / subAgentActivity land in their fold kinds (the sub-agent row carries the child thread)', { w: tools.w1?.k, i: tools.i1?.k, sa: saMsg?.collab?.rows?.[0] });
  ok(tools.c3?.s === 'pending', 'an inProgress command stays a pending card (the turn is still open)', tools.c3);
  ok(mm.messages.some((m) => m.isCompact) && mm.messages.some((m) => m.role === 'system' && m.status === 'error' && /usage limit/.test(m.content[0].text)), 'contextCompaction → compaction marker; a failed turn → its error card');
  ok(TR.threadToRecords(null).length === 0 && TR.itemToRecords({ type: 'someFutureItem', id: 'z' }, '2026-09-05T00:00:00.000Z').length === 0, 'null thread / unknown item kinds map to nothing (never throw)');
  // (b) the REAL fetch path against a stub app-server (a shell shim standing in for `codex`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cx0153-tr-'));
  const rpcLog = path.join(dir, 'rpc.jsonl');
  fs.writeFileSync(path.join(dir, 'stub.js'), `const fs=require('fs');const THREAD=${JSON.stringify(THREAD)};let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}fs.appendFileSync(${JSON.stringify(rpcLog)},l+'\\n');if(m.id===undefined||!m.method)continue;if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');continue;}if(m.method==='thread/read'){if(m.params.threadId===THREAD.id&&m.params.includeTurns===true)process.stdout.write(JSON.stringify({id:m.id,result:{thread:THREAD}})+'\\n');else process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'thread not loaded: '+m.params.threadId}})+'\\n');continue;}process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});setInterval(()=>{},1e3);`);
  const fake = path.join(dir, 'fake-codex');
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = "app-server" ] || { echo "expected app-server, got $1" >&2; exit 2; }\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'stub.js'))}\n`, { mode: 0o755 });
  const rpc = () => { try { return fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const reads = () => rpc().filter((m) => m.method === 'thread/read').length;
  TR._resetForTests();
  TR.configure({ codexCmd: fake, enabled: true });
  const { HARNESSES } = require(path.join(REPO, 'src/harnesses/index.js'));
  const warm = HARNESSES.codex.store.warmTranscript;
  ok(typeof warm === 'function', 'the codex descriptor declares store.warmTranscript (the S3 pre-read hook claude already had)');
  ok(await warm(MISSING, '/w', { remote: false }) === true && reads() === 1, 'a thread with NO rollout is read through ONE bounded app-server thread/read {includeTurns:true}', rpc().map((m) => m.method));
  ok(rpc().some((m) => m.method === 'initialize' && m.params?.capabilities?.experimentalApi === true) && rpc().some((m) => m.method === 'initialized'), 'the read handshakes like the wrapper (initialize + initialized)');
  ok((CX.parseCodexSessionJsonl(MISSING) || []).length === recs.length, 'parseCodexSessionJsonl serves the cached thread/read records when the rollout is missing');
  const view = new ST.CodexSessionMessages({ backend: 'codex', backendSessionId: MISSING, buffer: '' }, 'tr');
  ok(texts(view).includes('hello from thread/read') && view.chatStatus()?.model === 'gpt-6-astra', 'the read-only reader (CodexSessionMessages) renders the thread and its chatStatus names the model', { model: view.chatStatus()?.model });
  ok(await warm(MISSING, '/w', {}) === true && reads() === 1, 'a second warm is a cache hit — no second app-server spawn');
  ok(await warm(P, '/w', {}) === false && reads() === 1, 'a thread whose rollout EXISTS never triggers thread/read (the file is authoritative)');
  ok(await warm(UNKNOWN, '/w', {}) === false && reads() === 2 && await warm(UNKNOWN, '/w', {}) === false && reads() === 2, 'an unknown thread (JSON-RPC error) → false, negative-cached (one spawn for two asks)');
  ok(await warm(OTHER, '/w', { remote: true }) === false && reads() === 2, 'a REMOTE thread never spawns the local app-server (it knows no remote thread)');
  TR.configure({ enabled: false });
  ok(await warm(OTHER, '/w', {}) === false && reads() === 2, 'disabled (no codex on this box) → no spawn, honest false');
  TR.configure({ enabled: true });
  // timeout: a shim that never answers is killed and rejects within the bound
  const dead = path.join(dir, 'dead-codex');
  fs.writeFileSync(dead, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1e3)"\n`, { mode: 0o755 });
  const t0 = Date.now();
  const err = await TR.readThreadViaAppServer(OTHER, { codexCmd: dead, timeoutMs: 800 }).then(() => null, (e) => e.message);
  ok(/timed out/.test(err || '') && Date.now() - t0 < 5000, `a silent app-server is killed on the timeout bound (${err})`);
  fs.rmSync(dir, { recursive: true, force: true });
  TR._resetForTests();
  // (c) wiring pins — consumers reach the hook through the DESCRIPTOR (no claude ternary left)
  const wsh = read('src/ws-handler.js'), tsv = read('src/transcript-service.js');
  ok((wsh.match(/harnessOf\((?:session|data)\.backend \|\| 'claude'\)\.store\?\.warmTranscript/g) || []).length === 2 && !/if \(\(session\.backend \|\| 'claude'\) === 'claude'\) \{\s*\n\s*try \{ await warmSessionJsonlAsync/.test(wsh), 'ws-handler attach AND view-only paths warm through the descriptor (the claude-only ternary is gone)');
  ok(/harnessOf\(r\.backend \|\| 'claude'\)\.store\?\.warmTranscript/.test(tsv) && !/if \(r\.backend === 'claude'\) \{\s*\n\s*try \{ await warmSessionJsonlAsync/.test(tsv), 'transcript-service.view warms through the descriptor');
  ok(/require\('\.\.\/codex-thread-read'\)\.configure\(\{ codexCmd: CODEX_CMD \|\| null, enabled: !!CODEX_CMD \}\)/.test(read('src/server/cli-env.js')) && !/codex-thread-read/.test(read('server.js')), 'cli-env configures the fallback where CODEX_CMD is resolved (disabled when codex is absent; server.js untouched — the size ratchet)');
  ok(/'src\/codex-thread-read\.js'[,\]]/.test(read('scripts/test-architecture.mjs')), 'the module is registered in the SHARED tier');
  ok(HARNESSES.claude.store.warmTranscript === require(path.join(REPO, 'src/session-store.js')).warmSessionJsonlAsync, 'claude\'s hook is still the worker parse-cache warm (unchanged)');
}

console.log("— ⑥ multi-agent v2: sub-agent chatter is ATTRIBUTED, never a root reply (B-7473)");
{
  // FIXTURES CUT VERBATIM from a real 0.153.4 root rollout (session_meta
  // cli_version "0.153.4", 2072 records, 12 sub-agents): ids/paths shortened,
  // home paths scrubbed, encrypted blobs truncated to their fernet prefix.
  // The owner's report: a sub-agent's "已完成，仅修改约定两文件：…" appeared as an
  // ORDINARY assistant message in the ROOT window, some of them twice.
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const TID = '01a0733f-f028-7462-9769-be3e761a4f19';
  const TURN = '01a07340-04bc-7482-97fb-28ed6ed5a438';
  const CHILD = '01a07340-6597-74f2-882c-f7092fecd5a0';
  const BLOB = 'gAAAAABqnHsPfu_QPd2BKoPUgU269iLFrmymKTAuV3u1rIHFQtoiO-OHBkGdAPC4fGDNEkZ4JCp2Q9w1ZRr0YK0rpfiVBKLL2mp6cf9A3D3jevFG';
  const ev = (item, extra = {}) => ({ timestamp: '2026-09-05T20:26:35.297Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: TID, turn_id: TURN, item, started_at_ms: 1788639995297, completed_at_ms: 1788639995297, ...extra } });
  const ri = (payload) => ({ timestamp: '2026-09-05T20:27:00.118Z', type: 'response_item', payload });
  const SA = (kind, id, threadId = CHILD, agentPath = '/root/water_research') => ev({ type: 'SubAgentActivity', id, kind, agent_thread_id: threadId, agent_path: agentPath });
  const PLAIN_BODY = '完成水系统研究：[water.md](research/water.md)。\n\n关键结论：\n\n- 主候选：**纯电焚烧＋循环淋浴**；车规安装仍需验证。';
  const ROLLOUT_REPORT = ri({ type: 'agent_message', id: 'amsg_01a0734d-7cf3', author: '/root/water_research', recipient: '/root', content: [{ type: 'input_text', text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/water_research\nPayload:\n${PLAIN_BODY}` }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640853.235 } });
  const seq = [
    { timestamp: '2026-09-05T20:26:10.474Z', type: 'session_meta', payload: { session_id: TID, id: TID, cwd: '/w/vanlife', originator: 'claude-code-webui', cli_version: '0.153.4', source: 'vscode', history_mode: 'paginated' } },
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我构建设计一个房车' }] }),
    // the root's OWN commentary reply — must stay an assistant bubble
    ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我会把它做成一个可推敲的完整房车方案。' }], phase: 'commentary' }),
    // item_completed TWINS of records the response_item stream already rendered
    ev({ type: 'AgentMessage', id: 'msg_0f70caa7', content: [{ type: 'Text', text: '我会把它做成一个可推敲的完整房车方案。' }], phase: 'commentary' }),
    ev({ type: 'Reasoning', id: 'rs_0f70caa7', summary_text: [], raw_content: [] }),
    ev({ type: 'CommandExecution', id: 'exec-e7475734', command: ['/usr/bin/zsh', '-lc', 'vibespace-status working'], status: 'completed', aggregated_output: 'status set: working\n', exit_code: 0 }),
    ev({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '帮我构建设计一个房车' }] }),
    // three spawns (the `message` argument is a fernet blob in the rollout)
    ri({ type: 'function_call', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'water_research', message: BLOB }), call_id: 'call_ZCITcZYBFfmtfzyEdl6ATO27' }),
    SA('started', 'call_ZCITcZYBFfmtfzyEdl6ATO27'),
    ri({ type: 'function_call_output', id: 'fco_1', call_id: 'call_ZCITcZYBFfmtfzyEdl6ATO27', output: '{"task_name":"/root/water_research"}' }),
    ri({ type: 'function_call', id: 'fc_2', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'energy_research', message: BLOB }), call_id: 'call_t5pCGb2B' }),
    ri({ type: 'function_call_output', id: 'fco_2', call_id: 'call_t5pCGb2B', output: '{"task_name":"/root/energy_research"}' }),
    ri({ type: 'function_call', id: 'fc_3', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'interior_research', message: BLOB }), call_id: 'call_iR3' }),
    ri({ type: 'function_call_output', id: 'fco_3', call_id: 'call_iR3', output: '{"task_name":"/root/interior_research"}' }),
    // interleaved inbound mail: ENCRYPTED MESSAGE, then the PLAINTEXT FINAL_ANSWER
    { type: 'inter_agent_communication_metadata', payload: { trigger_turn: false } },
    ri({ type: 'agent_message', id: 'amsg_01a07340-c696', author: '/root/water_research', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/water_research\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: BLOB }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640020.118 } }),
    ri({ type: 'function_call', id: 'fc_4', name: 'send_message', namespace: 'collaboration', arguments: JSON.stringify({ target: 'interior_research', message: BLOB }), call_id: 'call_XUSz' }),
    ri({ type: 'function_call_output', id: 'fco_4', call_id: 'call_XUSz', output: '' }),
    SA('interacted', 'call_SBIpWR9V'),
    ri({ type: 'function_call', id: 'fc_5', name: 'wait', arguments: JSON.stringify({ cell_id: '3', max_tokens: 3000, yield_time_ms: 1000 }), call_id: 'call_6G7f' }),
    SA('completed', 'subagent-completed-01a07340-65a1'),
    ROLLOUT_REPORT,
    ri({ type: 'function_call', id: 'fc_6', name: 'followup_task', namespace: 'collaboration', arguments: JSON.stringify({ target: 'water_research', message: BLOB }), call_id: 'call_W5Bs' }),
    ri({ type: 'function_call_output', id: 'fco_6', call_id: 'call_W5Bs', output: '' }),
  ];
  const mm = new CodexMessageManager('t6473');
  mm.convertHistory(seq);
  const dump = JSON.stringify(mm.messages);

  const assistants = mm.messages.filter((m) => m.role === 'assistant' && m.content[0]?.type === 'text');
  ok(assistants.length === 1 && assistants[0].content[0].text === '我会把它做成一个可推敲的完整房车方案。', 'the ROOT\'s own reply is the ONLY assistant bubble — a sub-agent report never becomes one', assistants.map((m) => m.content[0].text));
  ok(!/水系统研究/.test(JSON.stringify(assistants)), "the sub-agent's FINAL_ANSWER text is NOT in any assistant message (the owner's report)");
  const report = mm.messages.find((m) => m.collab?.report);
  ok(report && report.role === 'tool' && report.collapseKind === 'report' && report.collab.dir === 'in' && report.collab.agentName === 'water_research' && report.collab.msgType === 'FINAL_ANSWER' && report.content[0].output === PLAIN_BODY, 'the plaintext FINAL_ANSWER is an ATTRIBUTED sub-agent report in its OWN fold kind (author + msgType + markdown body, envelope stripped)', report && { c: report.collab, o: report.content[0].output.slice(0, 30) });
  ok(report.collab.threadId === CHILD, 'the report carries the child thread id from SubAgentActivity (click-through needs no server lookup)', report.collab.threadId);
  ok(!dump.includes(BLOB) && !/gAAAAAB/.test(dump), 'no encrypted blob reaches ANY rendered string (spawn/send/followup arguments + the encrypted inbound message)');
  const rows = mm.messages.flatMap((m) => m.collab?.rows || []);
  const byDir = rows.reduce((a, r) => { a[r.dir] = (a[r.dir] || 0) + 1; return a; }, {});
  // NO DOUBLE RENDER (the merge rule, B-7473 integration 2026-09-06): a SubAgentActivity record whose
  // own id IS a rendered collab call (0.153.4 census: started → spawn_agent
  // 18/18, interacted → send_message/followup_task 214/214) is MAP-ONLY — the
  // spawn row is already that fact. Here: 'started' rides call_ZCITc… (the
  // spawn_agent call) ⇒ no row; 'interacted' rides a call this rollout cut does
  // not contain ⇒ its own row; 'completed' synthesises subagent-completed-… ⇒
  // its own row. The thread id is learned either way (next assert).
  ok(byDir.spawn === 3 && byDir.out === 2 && byDir.wait === 1 && byDir.activity === 2 && byDir.in === 2, 'every collab record becomes exactly one row, and a lifecycle record that IS its own call renders no second row: 3 spawns, send+followup, wait, 2 lifecycle rows, 2 inbound', byDir);
  // ── ENCRYPTED TWIN-DEDUP (B-7473 integration 2026-09-06 verifier finding, MAJOR): three DISTINCT
  // encrypted messages from ONE agent inside ONE turn. VERBATIM from the owner's
  // root rollout rollout-2026-09-05T13-26-05 (lines 49 / 71 / 159, cli_version
  // 0.153.4, blobs truncated to their fernet prefix): distinct ids, distinct
  // blobs, IDENTICAL visible envelope — body '' and msgType MESSAGE for all
  // three. The old fallback key (turn, author, msgType, body) made them ONE
  // (101 of that rollout's encrypted messages were dropped that way).
  {
    const ENVELOPE = 'Message Type: MESSAGE\nTask name: /root\nSender: /root/water_research\nPayload:\n';
    const encMsg = (id, blob) => ri({ type: 'agent_message', id, author: '/root/water_research', recipient: '/root', content: [{ type: 'input_text', text: ENVELOPE }, { type: 'encrypted_content', encrypted_content: blob }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640020.118 } });
    const enc = new CodexMessageManager('t6473enc');
    enc.convertHistory([
      { timestamp: '2026-09-05T20:26:10.474Z', type: 'session_meta', payload: { session_id: TID, id: TID, cwd: '/w/vanlife', cli_version: '0.153.4' } },
      ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我构建设计一个房车' }] }),
      encMsg('amsg_01a07340-c696-7080-a3f3-c55a42e62d04', 'gAAAAABqnHsPfu_QPd2BKoPUgU269iLFrmymKTAu…'),
      encMsg('amsg_01a07341-d6a0-7862-8a6a-e8b7c7605847', 'gAAAAABqnHtJgvt7L7pxSssR69Sd8L3t83ffOkdg…'),
      encMsg('amsg_01a0734d-7cf1-7401-9eae-556113fb55c3', 'gAAAAABqnHv8pHXVGQgtKRtX5C0c_AF1ySQUFv24…'),
    ]);
    const encRows = enc.messages.flatMap((m) => m.collab?.rows || []);
    const encMsgs = enc.messages.filter((m) => m.collab);
    ok(encRows.length === 3 && encRows.every((r) => r.dir === 'in' && r.encrypted && r.agentName === 'water_research'), 'THREE distinct encrypted messages from one agent in one turn stay THREE rows (the content leg cannot fire without content)', JSON.stringify(encRows));
    ok(encMsgs.length === 1 && /3 messages/.test(encMsgs[0].content[0].output) && /water_research/.test(encMsgs[0].content[0].output), '…coalesced into ONE item that says "3 messages · water_research"', encMsgs.map((m) => m.content[0].output));
    // the id leg still collapses a genuine re-read of the SAME record
    enc.convertHistory([encMsg('amsg_01a07340-c696-7080-a3f3-c55a42e62d04', 'gAAAAABqnHsPfu_QPd2BKoPUgU269iLFrmymKTAu…')]);
    ok(enc.messages.flatMap((m) => m.collab?.rows || []).length === 3, '…and re-feeding one of them (same id) adds NO fourth row (the id leg is intact)');
  }
  const spawnRow = rows.find((r) => r.dir === 'spawn' && r.agentPath === '/root/water_research');
  ok(spawnRow && spawnRow.threadId === CHILD, "…and the suppressed 'started' record still taught the map: the spawn row carries the child thread id (click-through never depends on drawing a row)", spawnRow);
  ok(rows.filter((r) => r.dir === 'spawn').every((r) => r.agentPath.startsWith('/root/')), 'the spawn OUTPUT ({"task_name":"/root/x"}) upgrades the row to the full agent path', rows.filter((r) => r.dir === 'spawn').map((r) => r.agentPath));
  const encRow = rows.find((r) => r.dir === 'in' && r.encrypted);
  ok(encRow && encRow.msgType === 'MESSAGE' && encRow.agentName === 'water_research', 'the ENCRYPTED inbound message is a one-line row with its msgType (no body to show)', encRow);
  ok(rows.find((r) => r.dir === 'wait')?.cellId === '3' && rows.find((r) => r.dir === 'out')?.msgType === 'message' && rows.some((r) => r.dir === 'out' && r.msgType === 'followup'), 'wait carries its cell, send_message/followup_task carry their kinds', rows.filter((r) => r.dir === 'out' || r.dir === 'wait'));
  const collabMsgs = mm.messages.filter((m) => m.collab && !m.collab.report);
  ok(collabMsgs.length < rows.length && collabMsgs.every((m) => m.collapseKind === 'agent' && m.role === 'tool'), `consecutive one-line rows COALESCE (${rows.length - 1} rows in ${collabMsgs.length} messages), all 'agent'-kind`, collabMsgs.map((m) => m.content[0].output));
  ok(mm.status().subagents['/root/water_research'] === CHILD, 'status().subagents exposes the agentPath → threadId map the client clicks through', mm.status().subagents);
  const tools = mm.messages.filter((m) => m.role === 'tool' && !m.collab);
  ok(tools.length === 0, 'the item_completed TWINS (AgentMessage/Reasoning/CommandExecution/UserMessage) render NOTHING extra', tools.map((m) => m.toolName));

  // ── LIVE twin vs ROLLOUT twin: ONE message ──
  // The wrapper records a child's item/completed agentMessage as an
  // agent_message with the payload in output_text (no envelope, id msg_…);
  // codex later writes its own copy into the ROOT rollout with the envelope
  // and a DIFFERENT id (amsg_…). Merged, they must render once.
  const LIVE_TWIN = { timestamp: '2026-09-05T20:40:53.100Z', type: 'response_item', payload: { type: 'agent_message', id: 'msg_0defcfe57bd8', thread_id: CHILD, turn_id: TURN, author: '/root/water_research', recipient: '/root', content: [{ type: 'output_text', text: PLAIN_BODY }], phase: 'final_answer', delivery: null, msg_type: 'FINAL_ANSWER' } };
  for (const order of [[LIVE_TWIN, ROLLOUT_REPORT], [ROLLOUT_REPORT, LIVE_TWIN]]) {
    const m2 = new CodexMessageManager('twin');
    m2.convertHistory([SA('started', 'call_ZCITcZYBFfmtfzyEdl6ATO27'), ...order]);
    const reports = m2.messages.filter((x) => x.collab?.report);
    ok(reports.length === 1 && reports[0].content[0].output === PLAIN_BODY, `live twin + rollout twin → ONE report (${order[0] === LIVE_TWIN ? 'live first' : 'rollout first'})`, reports.length);
  }
  // …and the wrapper's thread_id/turn_id never break the buffer⇄rollout merge
  const { mergeCodexRecords } = require(path.join(REPO, 'src/codex-session-store.js'));
  const bufCopy = { timestamp: '2026-09-05T20:26:17.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"command":"ls"}', call_id: 'call_X', thread_id: TID, turn_id: TURN } };
  const rollCopy = { timestamp: '2026-09-05T20:26:17.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"command":"ls"}', call_id: 'call_X', id: 'fc_X' } };
  ok(mergeCodexRecords([rollCopy], [bufCopy]).length === 1, 'the wrapper item context (thread_id/turn_id) is stripped from the merge fingerprint — buffer and rollout twins still collide');
  ok(CodexMessageManager.recordKey(bufCopy) === CodexMessageManager.recordKey(rollCopy), '…and from recordKey, so a rebuild mints the same message ids');

  // ── LIVE coalescing must reach the DOM ──
  // ChatView._onEditMessage only re-renders the element for a TERMINAL status;
  // a content-only edit updates the stored message and leaves the old row on
  // screen. Every coalescing edit therefore carries `status`.
  {
    const live = new CodexMessageManager('live6473');
    const ops = [];
    live.onOp((o) => ops.push(o));
    live.processLive(SA('started', 'call_A'));
    live.processLive(SA('completed', 'call_B'));
    const edits = ops.filter((o) => o.op === 'edit');
    ok(ops.filter((o) => o.op === 'create').length === 1 && edits.length === 1, 'a second consecutive row EDITS the first message instead of creating another', ops.map((o) => o.op).join(','));
    ok(edits[0].fields.status === 'complete' && Array.isArray(edits[0].fields.collab?.rows) && edits[0].fields.collab.rows.length === 2, 'the coalescing edit carries status + the grown rows (or the DOM keeps the stale row)', JSON.stringify(edits[0].fields.collab?.rows?.length));
    const cvSrc = read('src/lib/chat-view.js');
    ok(/if \(fields\.status === 'complete' \|\| fields\.status === 'error' \|\| fields\.status === 'interrupted'\) \{/.test(cvSrc), 'WIRING PIN: the client re-render really is gated on a terminal status in fields');
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
