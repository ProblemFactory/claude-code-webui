#!/usr/bin/env node
// Codex P2 wrapper-side rows of docs/design-harness-plugins.md §1 (2.369.20):
//   ① SEND WHILE BUSY — a chat-input during an active turn rides
//      thread/queue/add (runs after the turn) instead of turn/start (codex
//      steers a regular turn / rejects review+compact turns and the text
//      was lost); the client sees a queued_input notice.
//   ② SLASH COMMANDS — /compact = REAL thread/compact/start, /review,
//      /model, /effort; the wrapper adverts them in wrapper_meta so the
//      chat-input autocomplete has something to show.
//   ③ LIVE VISIBILITY — mcpToolCall / dynamicToolCall / webSearch /
//      imageView / contextCompaction items become function_call twins and
//      notices while the turn runs (they used to appear only after re-attach).
// Functional: the REAL codex-chat-wrapper against a stub app-server that
// keeps the first turn ACTIVE and pushes item notifications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxp2-'));
const SID = 'sess-9-1700000000009';
const buf = path.join(dir, SID + '.buf'), meta = path.join(dir, SID + '.json'), rpcLog = path.join(dir, 'rpc.jsonl');
// Stub app-server: thread/start → id; turn/start → turn id + a turn/started
// notification and (on the FIRST turn) an MCP item pair + a web search item
// (the turn never completes = stays active); thread/queue/add → {};
// thread/compact/start → {} + a contextCompaction item; everything logged.
const STUB = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let reviewTurn = false; let activeTurn = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(${JSON.stringify(rpcLog)}, line + '\\n');
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-p2' } } }); continue; }
    if (m.method === 'turn/start') {
      turns++; const tid = 'turn-' + turns; activeTurn = tid;
      send({ id: m.id, result: { turn: { id: tid } } });
      send({ method: 'turn/started', params: { turn: { id: tid } } });
      if (turns === 1) {
        send({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'mcp-1', server: 'github', tool: 'list_issues', arguments: { repo: 'x/y' }, status: 'inProgress' } } });
        send({ method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 'mcp-1', server: 'github', tool: 'list_issues', arguments: { repo: 'x/y' }, status: 'completed', result: { content: [{ type: 'text', text: '3 issues' }] } } } });
        // the REAL v2 sequence (0.153.4 WebSearchItem): item/started is an EMPTY
        // stub (query '', action null) — the query/action/results exist only on
        // item/completed (owner screenshot: every card read {"query":"","action":null})
        send({ method: 'item/started', params: { item: { type: 'webSearch', id: 'ws-1', query: '', action: null, results: null } } });
        send({ method: 'item/completed', params: { item: { type: 'webSearch', id: 'ws-1', query: 'vibespace acp', action: { type: 'search', queries: ['vibespace acp', 'vibespace agent client protocol'] }, results: [{ type: 'text_result', ref_id: 'turn1search0', domain: 'example.org', title: 'ACP <b>spec</b>', url: 'https://example.org/acp', snippet: 'Agent  Client Protocol\\n overview' }] } } });
        // a page open: the v2 WebSearchAction spells it CAMELCASE (openPage / findInPage, schema 0.153.4) and the
        // item id is the same 'exec-…' the rollout's Extension web.search item carries (one card live + rebuilt)
        send({ method: 'item/started', params: { item: { type: 'webSearch', id: 'exec-a73a6d39-77ea-472b-b77d-c97a8f5a02e7', query: '', action: null, results: null } } });
        send({ method: 'item/completed', params: { item: { type: 'webSearch', id: 'exec-a73a6d39-77ea-472b-b77d-c97a8f5a02e7', query: 'https://www.example9.org/shop', action: { type: 'openPage', url: 'https://www.example9.org/shop' }, results: [{ type: 'text_result', domain: 'www.example9.org', ref_id: 'turn96view0', snippet: 'Total lines: 217', title: 'Shop Infinity Showers', url: 'https://www.example9.org/shop' }] } } });
        // a real ImageView item carries a file:// URL (0.153.4 rollouts: 48/48) — the id is the rollout item's id
        send({ method: 'item/completed', params: { item: { type: 'imageView', id: 'exec-fc9387a4-6df5-4b06-9f60-ed7b69463d26', path: 'file:///tmp/shot.png' } } });
        // per-response usage (v2 camelCase shape, as the real app-server sends it) — the wrapper relays it as a token_count
        send({ method: 'thread/tokenUsage/updated', params: { threadId: 'th-p2', turnId: tid, tokenUsage: { total: { totalTokens: 5150, inputTokens: 5000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 150, reasoningOutputTokens: 40 }, last: { totalTokens: 5150, inputTokens: 5000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 150, reasoningOutputTokens: 40 }, modelContextWindow: 828400 } } });
        // B-7473 THREAD GATE: the app-server relays notifications for EVERY
        // thread it hosts. (iii) own-thread lifecycle names the child; (i) the
        // CHILD's own agentMessage; (ii) an own-thread message written FOR
        // another agent (inter-agent envelope); (iv) the only real root reply.
        send({ method: 'item/completed', params: { threadId: 'th-p2', turnId: tid, item: { type: 'subAgentActivity', id: 'call-sa1', kind: 'started', agentThreadId: 'th-child', agentPath: '/root/water_research' } } });
        send({ method: 'item/completed', params: { threadId: 'th-child', turnId: 'turn-child', item: { type: 'agentMessage', id: 'msg-child', text: 'child FINAL_ANSWER body', phase: 'final_answer' } } });
        send({ method: 'item/completed', params: { threadId: 'th-p2', turnId: tid, item: { type: 'agentMessage', id: 'msg-env', text: 'Message Type: FINAL_ANSWER\\nTask name: /root\\nSender: /root/usecases_v4\\nPayload:\\nenvelope body' } } });
        send({ method: 'item/completed', params: { threadId: 'th-child', turnId: 'turn-child', item: { type: 'commandExecution', id: 'exec-child', command: ['ls'], status: 'completed', aggregatedOutput: 'x' } } });
        // (v) an OWN-thread agentMessage with delivery 'async' and NO envelope:
        // a question the USER must read. The first cut treated 'async' as
        // inter-agent and DROPPED the text entirely (B-7473 integration 2026-09-06).
        send({ method: 'item/completed', params: { threadId: 'th-p2', turnId: tid, item: { type: 'agentMessage', id: 'msg-async', text: 'Which layout do you prefer', phase: 'commentary', delivery: 'async' } } });
        // (vi) a CHILD thread's ERROR notification (ErrorNotification carries
        // threadId in the 0.153.4 bindings): it must never become the ROOT's
        // task_failed / system card / turn end — it is the child's failure.
        send({ method: 'error', params: { threadId: 'th-child', message: 'sub-agent ran out of context' } });
        send({ method: 'item/completed', params: { threadId: 'th-p2', turnId: tid, item: { type: 'agentMessage', id: 'msg-root', text: 'root reply to the user', phase: 'commentary' } } });
      }
      continue;
    }
    // ── THE QUEUE, as measured against a live 0.153.4 app-server ──
    //   add → {queuedSubmission:{id,input,clientUserMessageId}} + thread/queue/changed
    //   list → {data:[…], nextCursor}
    //   delete → {deleted:true} (queuedSubmissionId; there is NO 'remove' verb)
    //   steer → {turnId}, or -32600 with the server's own message text
    //   turn end → the APP-SERVER drains the queue itself (an add on an idle
    //   thread starts a turn with no turn/start from us — measured)
    if (m.method === 'thread/queue/add') {
      const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId };
      queue.push(q);
      send({ id: m.id, result: { queuedSubmission: q } });
      send({ method: 'thread/queue/changed', params: { threadId: 'th-p2' } });
      continue;
    }
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: queue.slice(), nextCursor: null } }); continue; }
    if (m.method === 'thread/queue/delete') {
      const i = queue.findIndex((q) => q.id === m.params.queuedSubmissionId);
      if (i < 0) { send({ id: m.id, error: { code: -32600, message: 'queued submission not found' } }); continue; }
      queue.splice(i, 1);
      send({ id: m.id, result: { deleted: true } });
      send({ method: 'thread/queue/changed', params: { threadId: 'th-p2' } });
      continue;
    }
    if (m.method === 'turn/steer') {
      if (m.params.expectedTurnId !== activeTurn) { send({ id: m.id, error: { code: -32600, message: 'expected active turn id \`' + m.params.expectedTurnId + '\` but found \`' + activeTurn + '\`' } }); continue; }
      if (reviewTurn) { send({ id: m.id, error: { code: -32600, message: 'cannot steer a review turn' } }); continue; }
      send({ id: m.id, result: { turnId: activeTurn } });
      continue;
    }
    if (m.method === 'review/start') { reviewTurn = true; send({ id: m.id, result: { reviewThreadId: 'th-review' } }); continue; }
    if (m.method === 'turn/interrupt') {
      send({ id: m.id, result: {} });
      const ended = activeTurn; activeTurn = null;
      send({ method: 'turn/completed', params: { turn: { id: ended }, status: 'interrupted' } });
      // …and the app-server drains the queue on its own (no turn/start from us)
      if (queue.length) {
        queue.shift();
        send({ method: 'thread/queue/changed', params: { threadId: 'th-p2' } });
        const tid = 'turn-' + (++turns); activeTurn = tid;
        send({ method: 'turn/started', params: { turn: { id: tid } } });
      }
      continue;
    }
    if (m.method === 'thread/compact/start') { send({ id: m.id, result: {} }); send({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'cc-1' } } }); continue; }
    send({ id: m.id, result: {} });
  }
});
setInterval(() => {}, 1e3);
`;
const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, meta, process.execPath, '-e', STUB], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_WEBUI_CWD: dir, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
});
let out = ''; w.stdout.on('data', (d) => { out += d; }); let err = ''; w.stderr.on('data', (d) => { err += d; });
const readMeta = () => { try { return JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { return null; } };
const rpc = () => { try { return fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const events = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// In chat mode the SERVER owns the .buf file (session-meta bufferOwner:'server'); the
// wrapper's records ride its stdout — read them there.
const bufRecords = () => events();
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return pred(); };
const sendLine = (o) => w.stdin.write(JSON.stringify(o) + '\n');

ok(await waitFor(() => readMeta()?.threadId === 'th-p2'), 'wrapper handshake against the stub app-server');
const wm = bufRecords().find((r) => r.type === 'wrapper_meta');
ok(Array.isArray(wm?.payload?.slashCommands) && ['compact', 'review', 'model', 'effort'].every((c) => wm.payload.slashCommands.includes(c)), 'wrapper_meta adverts the wrapper-served slash commands');

// ① first input → turn/start; the stub keeps it active and pushes MCP/web/image items
sendLine({ type: 'chat-input', text: 'first', msgId: 'm1' });
ok(await waitFor(() => rpc().some((m) => m.method === 'turn/start') && readMeta()?.activeTurnId === 'turn-1'), 'first chat-input starts a turn and the wrapper adopts it as active');
ok(await waitFor(() => bufRecords().some((r) => r.type === 'response_item' && r.payload?.type === 'function_call' && r.payload.name === 'mcp__github__list_issues')), 'a LIVE mcpToolCall item is recorded as a function_call (mcp__<server>__<tool>)');
ok(await waitFor(() => bufRecords().some((r) => r.payload?.type === 'function_call_output' && r.payload.call_id === 'mcp-1' && /3 issues/.test(r.payload.output))), 'its completion lands as function_call_output with the MCP result');
ok(await waitFor(() => bufRecords().some((r) => r.payload?.type === 'function_call' && r.payload.name === 'web_search' && r.payload.call_id === 'ws-1')), 'a webSearch item is a visible web_search call from item/started (the pending card)');
// 2.369.43: the completion is codex's OWN rollout shape (event_msg web_search_end) carrying the FINAL query/action/results — not a function_call_output of raw JSON
ok(await waitFor(() => bufRecords().some((r) => r.type === 'event_msg' && r.payload?.type === 'web_search_end' && r.payload.call_id === 'ws-1' && r.payload.query === 'vibespace acp' && r.payload.action?.type === 'search' && Array.isArray(r.payload.results) && r.payload.results[0]?.url === 'https://example.org/acp')), 'item/completed lands as event_msg web_search_end {call_id, query, action, results} (the rollout twin shape)');
{ const wse = bufRecords().find((r) => r.type === 'event_msg' && r.payload?.type === 'web_search_end'); ok(wse && Object.keys(wse.payload).join(',') === 'type,call_id,query,action,results', `web_search_end key order mirrors codex-rs (fingerprint dedup with the rollout copy): ${wse && Object.keys(wse.payload).join(',')}`); }
ok(!bufRecords().some((r) => r.payload?.type === 'function_call_output' && r.payload.call_id === 'ws-1'), 'no function_call_output twin for the search (one completion record, one edit)');
ok(await waitFor(() => bufRecords().some((r) => r.payload?.type === 'function_call' && r.payload.name === 'view_image' && /shot\.png/.test(r.payload.arguments))), 'an imageView item is a visible view_image call');
// live and rebuilt must render the SAME card: the rollout's ImageView item is routed with file:// stripped,
// so the live copy strips it too — otherwise the one card (same item id) rewrote its own text on re-attach
{ const fc = bufRecords().find((r) => r.payload?.type === 'function_call' && r.payload.name === 'view_image');
  await waitFor(() => bufRecords().some((r) => r.payload?.type === 'function_call_output' && r.payload.call_id === fc?.payload.call_id));
  const fo = bufRecords().find((r) => r.payload?.type === 'function_call_output' && r.payload.call_id === fc?.payload.call_id)?.payload;
  ok(fc && JSON.parse(fc.payload.arguments).path === '/tmp/shot.png' && fo?.output === 'viewed /tmp/shot.png', `the live view_image card carries the file://-stripped path, byte-identical to the rollout copy (${JSON.stringify([fc && JSON.parse(fc.payload.arguments).path, fo?.output])})`); }

// ② second input while the turn is active → queued, never a second turn/start
sendLine({ type: 'chat-input', text: 'second', msgId: 'm2' });
ok(await waitFor(() => rpc().some((m) => m.method === 'thread/queue/add')), 'a chat-input during an ACTIVE turn goes to thread/queue/add');
const qa = rpc().find((m) => m.method === 'thread/queue/add');
ok(qa && qa.params.threadId === 'th-p2' && JSON.stringify(qa.params.input).includes('second') && qa.params.clientUserMessageId === 'm2', 'queue/add carries the thread, the encoded input and the client message id');
ok(rpc().filter((m) => m.method === 'turn/start').length === 1, 'no second turn/start (the old path steered/rejected)');
ok(await waitFor(() => events().some((e) => e.type === 'event_msg' && e.payload?.type === 'queued_input' && e.payload.msg_id === 'm2')), 'a queued_input event tells the client the message is queued');
{ const users = bufRecords().filter((r) => r.type === 'response_item' && r.payload?.role === 'user').map((r) => JSON.stringify(r.payload.content)); ok(users.some((u) => /first/.test(u)) && users.some((u) => /second/.test(u)), 'both user messages are recorded (the bubble renders either way)'); }

// ②b QUEUE + STEER (owner ask 2026-09-06: codex has two send modes)
const qEvents = () => events().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_changed').map((e) => e.payload);
const lastQueue = () => (qEvents().slice(-1)[0]?.items) || [];
const opResults = () => events().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_op_result').map((e) => e.payload);
ok(await waitFor(() => lastQueue().length === 1 && lastQueue()[0].msgId === 'm2'), `queue_changed publishes the WHOLE queue on every change (${JSON.stringify(lastQueue())})`);
ok(lastQueue()[0].preview === 'second' && lastQueue()[0].kind === 'user' && !!lastQueue()[0].id, 'each item carries {id, msgId, preview, ts, kind} — the preview is what will actually be sent', JSON.stringify(lastQueue()[0]));
sendLine({ type: 'chat-input', text: 'third', msgId: 'm7' });
ok(await waitFor(() => lastQueue().length === 2 && lastQueue().map((i) => i.msgId).join(',') === 'm2,m7'), `two queued, in order (${lastQueue().map((i) => i.msgId).join(',')})`);
// steer the SECOND one: only IT is injected, #1 keeps its place
const second = lastQueue()[1];
sendLine({ type: 'queue-op', op: 'steer', id: second.id });
ok(await waitFor(() => rpc().some((m) => m.method === 'turn/steer')), 'a steer sends turn/steer');
{
  const st = rpc().filter((m) => m.method === 'turn/steer');
  ok(st.length === 1 && st[0].params.expectedTurnId === 'turn-1' && JSON.stringify(st[0].params.input).includes('third') && !JSON.stringify(st[0].params.input).includes('second') && st[0].params.clientUserMessageId === 'm7',
    `…with the ACTIVE turn id as the precondition and ONLY that item's input (${JSON.stringify(st[0]?.params)})`);
}
ok(await waitFor(() => rpc().some((m) => m.method === 'thread/queue/delete' && m.params.queuedSubmissionId === second.id)), 'a steered item is DELETED from the queue (a steer does not dequeue — measured) so it never runs twice');
ok(await waitFor(() => lastQueue().length === 1 && lastQueue()[0].msgId === 'm2'), `…and the other item keeps its place in the queue (${JSON.stringify(lastQueue())})`);
ok(opResults().some((r) => r.op === 'steer' && r.ok === true && r.msg_id === 'm7'), 'queue_op_result names the bubble that was steered', JSON.stringify(opResults().slice(-1)));
// remove
const first = lastQueue()[0];
sendLine({ type: 'queue-op', op: 'remove', id: first.id });
ok(await waitFor(() => lastQueue().length === 0), 'remove empties the queue');
ok(opResults().some((r) => r.op === 'remove' && r.ok === true && r.msg_id === 'm2'), 'queue_op_result names the removed bubble');
// steer-all: sequential steers IN ORDER (measured: several steers per turn are accepted)
sendLine({ type: 'chat-input', text: 'alpha', msgId: 'm8' });
sendLine({ type: 'chat-input', text: 'beta', msgId: 'm9' });
ok(await waitFor(() => lastQueue().length === 2), 'two more queued for steer-all');
const steersBefore = rpc().filter((m) => m.method === 'turn/steer').length;
sendLine({ type: 'queue-op', op: 'steer-all' });
ok(await waitFor(() => rpc().filter((m) => m.method === 'turn/steer').length === steersBefore + 2), 'steer-all is one turn/steer PER ITEM (the app-server accepts several per turn), not one concatenated blob');
{
  const st = rpc().filter((m) => m.method === 'turn/steer').slice(steersBefore);
  ok(JSON.stringify(st[0].params.input).includes('alpha') && JSON.stringify(st[1].params.input).includes('beta'), 'steer-all preserves queue ORDER', st.map((m) => JSON.stringify(m.params.input)).join(' | '));
}
ok(await waitFor(() => lastQueue().length === 0), 'steer-all empties the queue');
ok(opResults().some((r) => r.op === 'steer-all' && r.ok === true && r.done === 2), 'steer-all reports how many landed', JSON.stringify(opResults().slice(-1)));
// a queued PEER message is listed + labelled, and REMOVING it hands the text
// back to the delivery ladder (it was already reported delivered — a silent
// loss here is a promised message gone)
sendLine({ type: 'peer-message', text: 'ping from B', fromName: 'session B' });
ok(await waitFor(() => lastQueue().some((i) => i.kind === 'peer')), 'an agent-to-agent message queued on the same lane is LISTED and labelled', JSON.stringify(lastQueue()));
{
  const peer = lastQueue().find((i) => i.kind === 'peer');
  ok(peer.from === 'session B' && peer.preview === 'ping from B', 'the peer row carries its sender + preview', JSON.stringify(peer));
  sendLine({ type: 'queue-op', op: 'remove', id: peer.id });
  ok(await waitFor(() => events().some((e) => e.payload?.type === 'peer_message_result' && e.payload.ok === false && e.payload.text === 'ping from B' && e.payload.fromName === 'session B')),
    'removing it re-reports peer_message_result ok:false with the text + label (the consumer re-stashes for next-turn injection)', JSON.stringify(events().filter((e) => e.payload?.type === 'peer_message_result').map((e) => e.payload)));
  ok(await waitFor(() => !lastQueue().some((i) => i.kind === 'peer')), 'and it leaves the queue');
}

// a turn that CANNOT be steered (review/compact → ActiveTurnNotSteerable): the
// item STAYS queued and the client is told why
sendLine({ type: 'review-start', target: { type: 'uncommittedChanges' } });
ok(await waitFor(() => rpc().some((m) => m.method === 'review/start')), 'a review turn is running');
sendLine({ type: 'chat-input', text: 'during review', msgId: 'm10' });
ok(await waitFor(() => lastQueue().length === 1 && lastQueue()[0].msgId === 'm10'), 'a message sent during the review turn queues');
sendLine({ type: 'queue-op', op: 'steer', id: lastQueue()[0].id });
ok(await waitFor(() => opResults().some((r) => r.op === 'steer' && r.ok === false && r.reason === 'not-steerable' && r.kind === 'review')), `a review turn refuses the steer, CLASSIFIED (${JSON.stringify(opResults().slice(-1))})`);
ok(lastQueue().length === 1 && lastQueue()[0].msgId === 'm10', 'the refused item STAYS queued (it still runs when the turn ends)', JSON.stringify(lastQueue()));
// turn end → the APP-SERVER drains the queue itself; the wrapper republishes
sendLine({ type: 'interrupt' });
ok(await waitFor(() => lastQueue().length === 0), 'when the turn ends the queued message runs (the app-server drains) and the published queue empties');

// ③ slash commands
sendLine({ type: 'chat-input', text: '/compact', msgId: 'm3' });
ok(await waitFor(() => rpc().some((m) => m.method === 'thread/compact/start' && m.params.threadId === 'th-p2')), '/compact runs a REAL thread/compact/start');
ok(await waitFor(() => events().some((e) => e.payload?.type === 'compact_started')) && await waitFor(() => events().some((e) => e.payload?.type === 'context_compacted' && e.payload.source === 'item')), 'compact_started + context_compacted (from the contextCompaction item) are emitted');
ok(rpc().filter((m) => m.method === 'turn/start').length === 1 && !rpc().some((m) => m.method === 'thread/queue/add' && JSON.stringify(m.params.input).includes('/compact')), '/compact is consumed — no model turn, not queued');
sendLine({ type: 'chat-input', text: '/model gpt-6-astra', msgId: 'm4' });
ok(await waitFor(() => readMeta()?.model === 'gpt-6-astra'), '/model sets the next-turn model through the set-model verb');
ok(await waitFor(() => events().some((e) => e.payload?.type === 'command_applied' && e.payload.command === 'model' && e.payload.value === 'gpt-6-astra')), '…and reports command_applied');
sendLine({ type: 'chat-input', text: '/effort high', msgId: 'm5' });
ok(await waitFor(() => readMeta()?.effortOverride === 'high'), '/effort sets the next-turn effort');
sendLine({ type: 'chat-input', text: '/review', msgId: 'm6' });
ok(await waitFor(() => rpc().some((m) => m.method === 'review/start' && m.params.target?.type === 'uncommittedChanges')), '/review starts a review of the uncommitted changes');

// ④ THREAD GATE (B-7473) — a sub-agent's message is never a root assistant bubble
const isAM = (r) => r.type === 'response_item' && r.payload?.type === 'agent_message';
ok(await waitFor(() => bufRecords().filter(isAM).length >= 2), 'the child-thread and envelope messages are recorded as agent_message records');
const ams = bufRecords().filter(isAM);
const childAm = ams.find((r) => r.payload.id === 'msg-child');
ok(childAm && childAm.payload.thread_id === 'th-child' && childAm.payload.author === '/root/water_research' && childAm.payload.recipient === '/root' && /child FINAL_ANSWER body/.test(JSON.stringify(childAm.payload.content)), '(i) a CHILD thread\'s agentMessage is an attributed agent_message (author from the subAgentActivity map, its thread, its item id)', JSON.stringify(childAm?.payload));
const envAm = ams.find((r) => r.payload.id === 'msg-env');
ok(envAm && envAm.payload.author === '/root/usecases_v4' && envAm.payload.msg_type === 'FINAL_ANSWER' && envAm.payload.thread_id === 'th-p2', '(ii) an OWN-thread message carrying the inter-agent envelope is attributed to its Sender, never a root reply', JSON.stringify(envAm?.payload));
const rootAsst = bufRecords().filter((r) => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'assistant');
// (iv) the root's OWN messages — the plain reply AND the delivery:'async'
// question (B-7473 integration 2026-09-06: 'async' is not an inter-agent signal, the ENVELOPE is;
// treating it as one dropped the question from the transcript entirely).
ok(rootAsst.length === 2 && rootAsst.map((r) => r.payload.item_id).sort().join(',') === 'msg-async,msg-root' && /Which layout do you prefer/.test(JSON.stringify(rootAsst.map((r) => r.payload.content))), "(iv) the root's OWN messages are recorded as assistant messages — including a delivery:'async' question", rootAsst.map((r) => r.payload.item_id).join(','));
// (vi) a CHILD's error notification never becomes the ROOT's task_failed
const evs = bufRecords().filter((r) => r.type === 'event_msg');
ok(!evs.some((r) => r.payload?.type === 'task_failed'), "(vi) a foreign thread's `error` notification is NOT the root's task_failed", JSON.stringify(evs.filter((r) => r.payload?.type === 'task_failed').map((r) => r.payload)));
const errAct = evs.find((r) => r.payload?.type === 'sub_agent_activity' && r.payload.kind === 'errored');
ok(errAct && errAct.payload.agent_thread_id === 'th-child' && /ran out of context/.test(errAct.payload.detail || ''), '…it is recorded as the CHILD\'s activity (kind errored, message on the row)', JSON.stringify(errAct?.payload));
const saRec = bufRecords().find((r) => r.type === 'event_msg' && r.payload?.type === 'sub_agent_activity');
ok(saRec && saRec.payload.agent_thread_id === 'th-child' && saRec.payload.agent_path === '/root/water_research' && saRec.payload.kind === 'started', '(iii) a subAgentActivity item becomes the live sub_agent_activity event', JSON.stringify(saRec?.payload));
ok(readMeta()?.subagents?.['/root/water_research'] === 'th-child', '…and fills the agentPath → threadId map in the sidecar', JSON.stringify(readMeta()?.subagents));
ok(readMeta()?.foreignDrops?.threads?.['th-child']?.agentMessages === 1 && readMeta().foreignDrops.threads['th-child'].dropped >= 1, 'other child-thread kinds are DROPPED and counted per thread (the commandExecution never became a root card)', JSON.stringify(readMeta()?.foreignDrops));
ok(!bufRecords().some((r) => r.payload?.call_id === 'exec-child'), '…no exec_command record from the child thread');
ok(readMeta()?.caps?.threadScoped === true, 'the wrapper adverts caps.threadScoped (features gate on what the process declares)');
{
  const rec = bufRecords().find((r) => r.type === 'response_item' && r.payload?.type === 'function_call' && r.payload.call_id === 'mcp-1');
  ok(rec?.payload?.thread_id === 'th-p2' && rec.payload.turn_id === 'turn-1', 'every item record carries its thread_id/turn_id context', JSON.stringify({ t: rec?.payload?.thread_id, u: rec?.payload?.turn_id }));
}

// normalizer view of the same records
const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
const mm = new CodexMessageManager('p2');
mm.convertHistory([...bufRecords(), ...events().filter((e) => e.type === 'event_msg')]);
const tools = mm.messages.filter((m) => m.role === 'tool');
ok(tools.some((m) => m.toolName && /list_issues/.test(m.toolName) && m.collapseKind === 'mcp' && m.toolStatus === 'ok'), `the MCP call renders as a tool card in the mcp fold kind, completed (${tools.map((m) => m.toolName + ':' + m.collapseKind + ':' + m.toolStatus).join(', ')})`);
ok(tools.some((m) => (m.collapseKind === 'image' && /view_image|View Image/i.test(m.toolName)) || (m.collapseKind === 'search' && /web_search|Web Search/i.test(m.toolName))), 'view_image folds as image, web search / image view cards never fold (visible work)');
{ // 2.369.43: ONE complete search card whose input carries the FINAL query/action and whose output is the rendered result list
  const searches = tools.filter((m) => m.collapseKind === 'search');
  const b = searches[0]?.content?.[0];
  ok(searches.length === 2 && searches[0].status === 'complete' && b?.input?.query === 'vibespace acp' && b?.input?.action?.queries?.length === 2, `the webSearch item is ONE complete card with the final query/action (${searches.length} cards; input ${JSON.stringify(b?.input)})`);
  ok(b && b.output === 'ACP <b>spec</b> — https://example.org/acp\nAgent Client Protocol overview', `…and a human result list, not raw JSON: ${JSON.stringify(b?.output)}`);
  // the v2 camelCase page action (0.153.4 schema) renders its head live — and the exec-… id is the rollout Extension item's id
  const o = searches[1]?.content?.[0];
  ok(searches[1]?.status === 'complete' && o?.toolCallId === 'exec-a73a6d39-77ea-472b-b77d-c97a8f5a02e7' && o?.output === 'opened https://www.example9.org/shop\n\nShop Infinity Showers — https://www.example9.org/shop\nTotal lines: 217', `a live v2 openPage item is ONE complete card with the 'opened <url>' head (${JSON.stringify(o?.output)})`);
}
{ // live wrapper records + the rollout's OWN ImageView item_completed (same item id, file:// URL) = ONE card, one text
  const before = mm.messages.filter((m) => m.collapseKind === 'image');
  mm.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ImageView', id: 'exec-fc9387a4-6df5-4b06-9f60-ed7b69463d26', path: 'file:///tmp/shot.png' } } });
  const after = mm.messages.filter((m) => m.collapseKind === 'image');
  ok(before.length === 1 && after.length === 1 && after[0].content[0].output === 'viewed /tmp/shot.png' && after[0].content[0].output === before[0].content[0].output, `the rollout ImageView copy edits the live card in place — one card, unchanged text (${JSON.stringify([before.length, after.length, after[0]?.content?.[0]?.output])})`);
}
const collabRows = mm.messages.flatMap((m) => m.collab?.rows || []);
const asstTexts = mm.messages.filter((m) => m.role === 'assistant' && m.content?.[0]?.type === 'text').map((m) => m.content[0].text);
ok(asstTexts.length === 2 && asstTexts.includes('root reply to the user') && asstTexts.includes('Which layout do you prefer'), 'normalizer view: the root\'s OWN messages are the only assistant bubbles — the sub-agent traffic is elsewhere', asstTexts);
// (3) an own-thread agentMessage marked delivery:'async' is the ROOT talking to
// the USER (a question) — the ENVELOPE is the only inter-agent signal
ok(asstTexts.includes('Which layout do you prefer') && !mm.messages.some((m) => m.collab && JSON.stringify(m.collab).includes('Which layout')), "an own-thread delivery:'async' message stays in the transcript (it is not inter-agent)", asstTexts);
// (2) a CHILD's error is the CHILD's: a collab activity row, never the root's failure
const errRow = mm.messages.flatMap((m) => m.collab?.rows || []).find((r) => r.kind === 'errored');
ok(errRow && errRow.threadId === 'th-child' && /ran out of context/.test(errRow.detail || ''), "a FOREIGN thread's error notification becomes a collab activity row with the message on hover", errRow);
ok(!mm.messages.some((m) => m.role === 'system' && /error|failed/i.test(m.content?.[0]?.text || '')), "…and never the ROOT's task_failed / error system card", mm.messages.filter((m) => m.role === 'system').map((m) => m.content?.[0]?.text));
ok(mm.messages.some((m) => m.collab?.report && m.collab.agentName === 'water_research') && mm.messages.some((m) => m.collab?.report && m.collab.agentName === 'usecases_v4'), 'both attributed messages render as sub-agent REPORTS with their author', mm.messages.filter((m) => m.collab?.report).map((m) => m.collab.agentName));
ok(collabRows.some((r) => r.dir === 'activity' && r.threadId === 'th-child'), 'the lifecycle row carries the child thread id', collabRows.filter((r) => r.dir === 'activity'));
const sys = mm.messages.filter((m) => m.role === 'system').map((m) => m.content?.[0]?.text || '');
// The queue state lives ON the bubble (a chip) + in the strip above the input —
// the old "Queued — runs after the current turn" SYSTEM CARD said the same
// thing a third time and is gone (the card survives only as the fallback for a
// queued entry with no bubble of its own, e.g. a peer message).
const userMsg = (needle) => mm.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes(needle));
ok(!sys.some((t) => /Queued — runs after the current turn/.test(t)), 'the queued SYSTEM CARD is gone — the state is a chip on the bubble', sys.join(' | '));
ok(userMsg('third')?.queueState === 'steered', `the steered message's bubble wears a 'steered' chip (${userMsg('third')?.queueState})`);
ok(userMsg('second')?.queueState === 'removed', `the removed message's bubble wears a 'removed' chip (${userMsg('second')?.queueState})`);
{ // the QUEUED→ran lifecycle, replayed record by record: the chip appears while
  // it waits and CLEARS when the app-server drains it (it left the queue with no
  // steer and no remove ⇒ it RAN — a bubble must never claim to be queued forever)
  const inc = new CodexMessageManager('p2-inc'); const seen = [];
  for (const r of bufRecords()) {
    inc.processLive(r);
    const m = inc.messages.find((x) => x.role === 'user' && JSON.stringify(x.content).includes('during review'));
    if (m) seen.push(m.queueState || 'none');
  }
  ok(seen.includes('queued') && seen[seen.length - 1] === 'none', `a waiting message wears 'queued', and the chip clears when it RUNS (${[...new Set(seen)].join('→')})`);
}
ok(sys.some((t) => /Cannot steer during a review turn/.test(t)), 'the refused steer is a VISIBLE notice naming the reason', sys.join(' | '));
{ // the meta op is SESSION STATE, never a transcript message
  const liveQ = new CodexMessageManager('p2-q'); const qops = [];
  liveQ.onOp((o) => qops.push(o));
  for (const r of bufRecords()) liveQ.processLive(r);
  const metaOps = qops.filter((o) => o.op === 'meta' && o.subtype === 'queue');
  ok(metaOps.length >= 4 && Array.isArray(metaOps[0].items), `queue_changed becomes a {op:'meta', subtype:'queue'} op (${metaOps.length} of them)`);
  ok(liveQ.queueState().length === 0 && !liveQ.messages.some((m) => JSON.stringify(m.content || '').includes('queue_changed')), 'queueState() is the attach payload; no queue message ever enters the transcript');
  ok(qops.some((o) => o.op === 'edit' && o.fields?.queueState === 'queued') && qops.some((o) => o.op === 'edit' && o.fields?.queueState === 'steered'), 'chips ride the normal edit op (live windows update in place)');
}
ok(sys.some((t) => /Compacting context/.test(t)) && sys.some((t) => /Context compacted/.test(t)), 'compaction start + compacted render as system cards');
ok(mm.turnMap().some((t) => t.isCompact), 'turnMap marks the compaction (minimap red marker parity with claude)');
ok(sys.some((t) => /\/model → gpt-6-astra/.test(t)), 'command_applied renders what was set');
// the init card is a LIVE artefact (processLive): boot wrapper_meta creates it, the
// thread wrapper_meta patches the commands in (edit op) — assert both
const live = new CodexMessageManager('p2-live'); const ops = []; live.onOp((o) => ops.push(o));
for (const r of bufRecords()) live.processLive(r);
const init = live.messages.find((m) => m.content?.[0]?.initData);
ok(init && init.content[0].initData.slashCommands.includes('compact'), 'the live init record carries the wrapper-served slash commands (chat-input autocomplete source)');
ok(ops.some((o) => o.op === 'edit' && o.id === init?.id && JSON.stringify(o.fields).includes('compact')) || (bufRecords().find((r) => r.type === 'wrapper_meta')?.payload?.slashCommands?.length > 0), 'clients learn the commands: either the first wrapper_meta already carries them or a later one patches the init card (edit op)');
// per-message META on the LIVE chain (wrapper → token_count → normalizer):
// the stub's thread/tokenUsage/updated became a token_count record; the tool
// cards of that response carry the ledger key `cx:<thread>:<cumulative>`
// (wrapper_meta.threadId + total.totalTokens) and the same 'edit' op claude
// uses delivered it to the (would-be) open window.
const tc = bufRecords().find((r) => r.type === 'event_msg' && r.payload?.type === 'token_count');
ok(tc && tc.payload.info?.total_token_usage?.totalTokens === 5150, 'the wrapper relays thread/tokenUsage/updated as a token_count (v2 camelCase inside the snake_case envelope)');
const mcpCard = live.messages.find((m) => m.role === 'tool' && /list_issues/.test(m.toolName || ''));
ok(mcpCard?.meta?.requestId === 'cx:th-p2:5150' && mcpCard.meta.requestIdKind === 'ledger' && mcpCard.meta.usage.input_tokens === 1000 && mcpCard.meta.usage.cache_read_input_tokens === 4000 && mcpCard.meta.usage.output_tokens === 150 && mcpCard.meta.usage.reasoning_output_tokens === 40 && mcpCard.meta.msgId === null, `live tool cards carry the response meta with the LEDGER rid (${JSON.stringify(mcpCard?.meta)})`);
ok(ops.some((o) => o.op === 'edit' && o.id === mcpCard?.id && o.fields?.meta?.requestId === 'cx:th-p2:5150'), "…delivered live through the 'edit' op (open-window popup refresh)");

// pins
const wsrc = fs.readFileSync(path.join(REPO, 'data/bin/codex-chat-wrapper.js'), 'utf8');
ok(/if \(meta\.threadId && meta\.activeTurnId\) \{[\s\S]{0,600}?await request\('thread\/queue\/add'/.test(wsrc), 'wrapper pin: chat-input queues on an active turn');
ok(/noteQueued\(cid, \{ kind: 'user', msgId: msg\.msgId \|\| '' \}\);\s*\n\s*await request\('thread\/queue\/add'/.test(wsrc), "wrapper pin: the item's identity is registered BEFORE the add (the queue/changed refresh can beat the reply)");
ok(!/request\('thread\/queue\/remove'/.test(wsrc) && /thread\/queue\/delete', \{ threadId: meta\.threadId, queuedSubmissionId/.test(wsrc), 'wrapper pin: removal is thread/queue/DELETE with queuedSubmissionId — 0.153.4 has no thread/queue/remove');
ok(/await request\('turn\/steer'[\s\S]{0,300}expectedTurnId: meta\.activeTurnId/.test(wsrc), 'wrapper pin: every steer carries the ACTIVE turn id as its precondition');
ok(/if \(method === 'thread\/queue\/changed'\) \{ refreshQueue\(\); return; \}/.test(wsrc), 'wrapper pin: the app-server\'s queue/changed drives a re-LIST (the notification carries no items)');
ok(/thread\/compact\/start/.test(wsrc) && /applySlashCommand\(text\)/.test(wsrc), 'wrapper pin: slash commands + real compact');
ok(/const foreign = foreignThreadOf\(params\);/.test(wsrc) && /!THREAD_ID_NOT_SCOPE\.has\(method\)/.test(wsrc) && !/THREAD_SCOPED_METHODS/.test(wsrc), 'wrapper pin: the gate is INVERTED — a notification NAMING another thread is foreign unless allowlisted (a method whitelist goes stale: error / thread/compacted / thread/queue/changed / turn/diff/updated were all missing)');
ok(/if \(replyAgentPath\) meta\.agentPath = replyAgentPath;/.test(wsrc), 'wrapper pin: meta.agentPath is ASSIGNED from the thread reply (it used to be read-only, so every fallback was dead)');
ok(/itemCtx = \{ threadId: asString\(params\?\.threadId/.test(wsrc) && /function recordItem\(payload\)/.test(wsrc), 'wrapper pin: item records carry the notification\'s thread/turn context');
const cm = fs.readFileSync(path.join(REPO, 'src/codex-message-manager.js'), 'utf8');
ok(/this\._status\.slashCommands \|\| \[\]/.test(cm) && !/slashCommands: \[\],/.test(cm), 'normalizer pin: init slashCommands come from wrapper_meta (no hardcoded empty list left)');

try { w.kill('SIGTERM'); } catch {}
await sleep(300);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
