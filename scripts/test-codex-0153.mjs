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
  const chatter = mm.messages.find((m) => m.toolName === 'Agent Message');
  ok(chatter && chatter.role === 'tool' && chatter.collapseKind === 'agent' && chatter.status === 'complete' && /FINAL_ANSWER/.test(chatter.content[0].output) && /encrypted payload/.test(chatter.content[0].output) && chatter.content[0].input.author === '/root/water_waste', "agent_message (sub-agent ↔ root chatter) renders as a complete 'agent'-kind tool card, encrypted payload named", chatter && chatter.content[0]);
  const sub = mm.messages.filter((m) => m.toolName === 'Sub-agent');
  ok(sub.length === 1 && sub[0].collapseKind === 'agent' && /completed/.test(sub[0].content[0].output) && sub[0].status === 'complete', "sub_agent_activity started/interacted/completed = ONE 'agent'-kind card, edited in place on completion", sub.map((m) => m.content[0].output));
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
  ok(S.SKIPPED_RECORD_TYPES.has('world_state') && S.SKIPPED_EVENT_TYPES.has('item_completed') && S.SKIPPED_RESPONSE_ITEM_TYPES.has('additional_tools'), 'the skip sets are explicit and exported for the audit');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
