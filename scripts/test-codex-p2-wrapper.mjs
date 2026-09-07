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
//   ⑦ THE VERB TABLE — reorder / edit / run-now / run-all against a stub whose
//      queue/list PAGINATES and whose reorder enforces the real full-order
//      rule; items injected behind the wrapper's back model the peer lane.
//   ⑤ STOP CLEARS THE QUEUE + its three round-2 regressions (§②d): a delete the
//      app-server REFUSES ({deleted:false} = the item was drained, it RAN), a
//      turn/started landing MID-SWEEP (the cached-list republish), and an
//      app-server that stops answering (Stop is a safety control, it is capped).
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
// Touch this file and the stub app-server ends its active turn NATURALLY (status
// 'completed') and drains one queued item — the path where a queued message really
// RUNS, as opposed to a turn ended by Stop.
const endTurnFile = path.join(dir, 'end-turn');
// Stub app-server: thread/start → id; turn/start → turn id + a turn/started
// notification and (on the FIRST turn) an MCP item pair + a web search item
// (the turn never completes = stays active); thread/queue/add → {};
// thread/compact/start → {} + a contextCompaction item; everything logged.
const STUB = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let reviewTurn = false; let activeTurn = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// The app-server owns the queue and drains it itself when a turn ends: one item
// leaves and starts a turn with NO turn/start from the client.
const drain = () => {
  if (!queue.length) return;
  queue.shift();
  send({ method: 'thread/queue/changed', params: { threadId: 'th-p2' } });
  const tid = 'turn-' + (++turns); activeTurn = tid;
  send({ method: 'turn/started', params: { turn: { id: tid } } });
};
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
      // …and the app-server drains the queue on its own, EVEN when the turn was
      // ended by an interrupt (measured on 0.153.4). This is deliberately left
      // in: it is exactly the race the wrapper's Stop has to win by deleting
      // the queue BEFORE it interrupts — a stub that stopped draining here
      // would pass the Stop assertions for the wrong reason.
      drain();
      continue;
    }
    if (m.method === 'thread/compact/start') { send({ id: m.id, result: {} }); send({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'cc-1' } } }); continue; }
    send({ id: m.id, result: {} });
  }
});
// A turn that ends on its own (harness-driven, so the timing is deterministic):
// turn/completed 'completed' + the same drain. This is the ONLY natural end in
// the stub; every other end goes through turn/interrupt.
setInterval(() => {
  try { fs.unlinkSync(${JSON.stringify(endTurnFile)}); } catch { return; }
  if (!activeTurn) return;
  const ended = activeTurn; activeTurn = null;
  send({ method: 'turn/completed', params: { turn: { id: ended }, status: 'completed' } });
  drain();
}, 40);
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
// A REFUSED steer-all must speak ONCE. It used to emit the per-item failure
// AND a `{op:'steer-all', ok:false, reason}` summary — two cards from one
// failure, and the summary carried no `kind`, so the normalizer's sentence
// defaulted to "review" and named a compact turn wrong (round-1 review).
{
  sendLine({ type: 'chat-input', text: 'also during review', msgId: 'm11' });
  ok(await waitFor(() => lastQueue().length === 2), 'two queued behind the un-steerable review turn');
  const before = opResults().length;
  sendLine({ type: 'queue-op', op: 'steer-all' });
  ok(await waitFor(() => opResults().length > before), 'steer-all answers');
  const after = opResults().slice(before);
  ok(after.filter((r) => r.ok === false).length === 1, `a refused steer-all reports the failure ONCE — the per-item result, not a second batch card (${JSON.stringify(after)})`);
  ok(after[0].op === 'steer' && after[0].reason === 'not-steerable' && after[0].kind === 'review' && after[0].batch === 'steer-all', '…and THAT result carries the real reason, the real turn kind and its batch provenance', JSON.stringify(after[0]));
  ok(!after.some((r) => r.op === 'steer-all'), 'no {op:"steer-all", ok:false} summary event at all (it lives in the wrapper journal)', JSON.stringify(after));
  ok(lastQueue().length === 2, 'both items stay queued in order after the refused batch', JSON.stringify(lastQueue()));
  // put the queue back to ONE item: the stub app-server drains a single entry
  // per turn end, and the next assertions are about that drain.
  sendLine({ type: 'queue-op', op: 'remove', id: lastQueue()[1].id });
  ok(await waitFor(() => lastQueue().length === 1 && lastQueue()[0].msgId === 'm10'), 'the extra probe message is removed again', JSON.stringify(lastQueue()));
}
// a turn that ends ON ITS OWN → the APP-SERVER drains the queue itself and the
// wrapper republishes; the drained bubble's chip clears because it RAN.
fs.writeFileSync(endTurnFile, '1');
ok(await waitFor(() => lastQueue().length === 0), 'when the turn ends on its own the queued message runs (the app-server drains) and the published queue empties');
ok(await waitFor(() => readMeta()?.activeTurnId === 'turn-2'), 'the drained item is running as the app-server\'s own turn (no turn/start from us)', JSON.stringify(readMeta()?.activeTurnId));

// ②c STOP CLEARS THE QUEUE (owner decision 2026-09-07 — codex now matches ACP).
// The app-server drains its queue when the turn ends INCLUDING a turn ended by
// Stop, so the messages queued behind it used to run the instant Stop landed.
{
  sendLine({ type: 'chat-input', text: 'stop me', msgId: 'm12' });
  ok(await waitFor(() => lastQueue().length === 1 && lastQueue()[0].msgId === 'm12'), 'a typed message queues behind the running turn', JSON.stringify(lastQueue()));
  sendLine({ type: 'peer-message', text: 'ping from C', fromName: 'session C' });
  ok(await waitFor(() => lastQueue().length === 2 && lastQueue().some((i) => i.kind === 'peer')), 'and an agent-to-agent message queues on the same lane', JSON.stringify(lastQueue()));
  const queuedIds = lastQueue().map((i) => i.id);
  const rpcBefore = rpc().length;
  const startsBefore = rpc().filter((m) => m.method === 'turn/start').length;
  const opsBefore = opResults().length;
  const peersBefore = events().filter((e) => e.payload?.type === 'peer_message_result').length;
  sendLine({ type: 'interrupt' });
  ok(await waitFor(() => lastQueue().length === 0), 'Stop empties the queue (the strip clears)', JSON.stringify(lastQueue()));
  const win = rpc().slice(rpcBefore);
  const dels = win.filter((m) => m.method === 'thread/queue/delete');
  ok(dels.length === 2 && dels.map((m) => m.params.queuedSubmissionId).sort().join(',') === queuedIds.slice().sort().join(','), `exactly one thread/queue/delete per queued item (${JSON.stringify(dels.map((m) => m.params?.queuedSubmissionId))})`);
  ok(win.filter((m) => m.method === 'turn/interrupt').length === 1, 'and exactly one turn/interrupt', JSON.stringify(win.map((m) => m.method)));
  // ORDER IS THE FIX: deleting AFTER the interrupt loses the race with the
  // app-server's own drain (the stub still drains on interrupt, deliberately).
  ok(win.findIndex((m) => m.method === 'turn/interrupt') > win.map((m) => m.method).lastIndexOf('thread/queue/delete'), 'every delete goes out BEFORE turn/interrupt — the app-server drains what is left when the turn ends', JSON.stringify(win.map((m) => m.method)));
  const rms = opResults().slice(opsBefore).filter((r) => r.op === 'remove');
  ok(rms.length === 2 && rms.every((r) => r.ok === true && r.reason === 'stopped'), `each dropped item is reported as a removal with reason 'stopped' (${JSON.stringify(rms)})`);
  ok(rms.some((r) => r.msg_id === 'm12'), 'the typed message\'s removal names its bubble', JSON.stringify(rms));
  // the chips must be stamped BEFORE the emptied republish: a bubble that
  // leaves the queue with no result reads as "it RAN" (the ACP round-1 lesson)
  const evAll = events().filter((e) => e.type === 'event_msg');
  const lastRemoveIdx = evAll.map((e) => e.payload?.type === 'queue_op_result' && e.payload.reason === 'stopped').lastIndexOf(true);
  const emptyIdx = evAll.findIndex((e, i) => i > lastRemoveIdx && e.payload?.type === 'queue_changed' && (e.payload.items || []).length === 0);
  ok(lastRemoveIdx >= 0 && emptyIdx > lastRemoveIdx, 'the removal results are emitted BEFORE the emptied queue_changed (a bare empty republish would claim the messages RAN)');
  const peers = events().filter((e) => e.payload?.type === 'peer_message_result').slice(peersBefore).map((e) => e.payload);
  ok(peers.some((r) => r.ok === false && r.text === 'ping from C' && r.fromName === 'session C'), 'the queued agent-to-agent message goes back to the delivery ladder (ok:false with its text + label ⇒ the consumer re-stashes it)', JSON.stringify(peers));
  // NOTHING RUNS AFTER THE TURN: the queue was empty when the turn ended, so
  // the app-server had nothing to drain and started no turn of its own.
  await sleep(400);
  ok(rpc().filter((m) => m.method === 'turn/start').length === startsBefore, 'no turn/start after the Stop', String(rpc().filter((m) => m.method === 'turn/start').length - startsBefore));
  ok(!readMeta()?.activeTurnId && readMeta()?.streaming === false, 'and the app-server drained NOTHING — the session is idle after Stop', JSON.stringify({ t: readMeta()?.activeTurnId, s: readMeta()?.streaming }));
  ok(lastQueue().length === 0, 'the published queue stays empty', JSON.stringify(lastQueue()));
}

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
// Stop-dropped bubbles read 'Removed' through the REAL normalizer — never a
// cleared chip, which the client renders as "it ran".
ok(userMsg('stop me')?.queueState === 'removed', `a message Stop dropped from the queue wears the 'removed' chip (${userMsg('stop me')?.queueState})`);
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
ok(/noteQueued\(cid, \{ kind: 'user', msgId: msg\.msgId \|\| '' \}\);[\s\S]{0,200}?await request\('thread\/queue\/add'/.test(wsrc) && /noteQueued\(cid, \{ kind: 'user'[\s\S]{0,200}?noteRecordedUserCid\(cid\);/.test(wsrc), "wrapper pin: the item's identity is registered BEFORE the add (the queue/changed refresh can beat the reply) — and so is the fact that its bubble already exists");
ok(!/request\('thread\/queue\/remove'/.test(wsrc) && /thread\/queue\/delete', \{ threadId: meta\.threadId, queuedSubmissionId/.test(wsrc), 'wrapper pin: removal is thread/queue/DELETE with queuedSubmissionId — 0.153.4 has no thread/queue/remove');
ok(/await request\('turn\/steer'[\s\S]{0,300}expectedTurnId: meta\.activeTurnId/.test(wsrc), 'wrapper pin: every steer carries the ACTIVE turn id as its precondition');
ok(/try \{ await clearQueueForStop\(\); \}[\s\S]{0,600}?if \(stopTurnId\) await interruptTurn\(stopTurnId\);/.test(wsrc) && /entry\.promise = request\('turn\/interrupt'/.test(wsrc), 'wrapper pin: Stop clears the queue BEFORE turn/interrupt (the app-server drains what is left when the turn ends), and a sweep that throws may not eat the interrupt');
// round-3 pins: BOTH halves of Stop are single-flight (stdin dispatches
// handleInput without awaiting it, so two frames really do overlap)
ok(/let stopSweepInFlight = null;\s*\nasync function clearQueueForStop\(\) \{\s*\n\s*if \(stopSweepInFlight\) return stopSweepInFlight;/.test(wsrc) && /async function _clearQueueForStop\(\) \{/.test(wsrc), 'wrapper pin: the Stop sweep is SINGLE-FLIGHT — a second Stop rides the running one instead of re-listing the queue it is deleting');
ok(/if \(interruptInFlight && interruptInFlight\.turnId === turnId\)/.test(wsrc), 'wrapper pin: turn/interrupt coalesces per TURN + a live RPC (never a time window — an answered RPC with the turn still running is a real retry)');
ok(/emitTaskEvent\('queue_op_result', \{ op: 'remove', id, ok: true, msg_id: known\?\.msgId \|\| '', reason: 'stopped' \}\);/.test(wsrc) && /await refreshQueue\(\{ timeoutMs: rpcBudget\(\) \}\);\s*\n\s*return removed;/.test(wsrc), "wrapper pin: every dropped item is reported as a removal BEFORE the republish (a cleared chip reads as 'it ran'), and that republish is BUDGETED like the rest of the sweep");
// round-2 pins: the three defects, in the source
ok(/if \(queueSweepActive\) return;\n\s*const fp = JSON\.stringify/.test(wsrc), 'wrapper pin: the sweep latch sits on publishQueue — the ONE choke point (turn/started republishes the CACHED list with no RPC at all)');
ok(/return resp\?\.deleted !== false;/.test(wsrc) && /ours = await deleteQueuedItem\(id, rpcBudget\(\)\);/.test(wsrc), "wrapper pin: the delete's own {deleted:false} verdict is READ (an item drained between the list and the delete RAN — it is not a Stop removal)");
ok(/const deadline = Date\.now\(\) \+ STOP_SWEEP_TOTAL_MS;/.test(wsrc) && /const rpcBudget = \(\) => Math\.min\(STOP_SWEEP_RPC_MS/.test(wsrc), 'wrapper pin: the sweep is budgeted per-RPC AND overall — Stop is a safety control, not a queue-management routine');
ok(/if \(method === 'thread\/queue\/changed'\) \{ refreshQueue\(\); return; \}/.test(wsrc), 'wrapper pin: the app-server\'s queue/changed drives a re-LIST (the notification carries no items)');
ok(/thread\/compact\/start/.test(wsrc) && /applySlashCommand\(text\)/.test(wsrc), 'wrapper pin: slash commands + real compact');
ok(/const foreign = foreignThreadOf\(params\);/.test(wsrc) && /!THREAD_ID_NOT_SCOPE\.has\(method\)/.test(wsrc) && !/THREAD_SCOPED_METHODS/.test(wsrc), 'wrapper pin: the gate is INVERTED — a notification NAMING another thread is foreign unless allowlisted (a method whitelist goes stale: error / thread/compacted / thread/queue/changed / turn/diff/updated were all missing)');
ok(/if \(replyAgentPath\) meta\.agentPath = replyAgentPath;/.test(wsrc), 'wrapper pin: meta.agentPath is ASSIGNED from the thread reply (it used to be read-only, so every fallback was dead)');
ok(/itemCtx = \{ threadId: asString\(params\?\.threadId/.test(wsrc) && /function recordItem\(payload\)/.test(wsrc), 'wrapper pin: item records carry the notification\'s thread/turn context');
const cm = fs.readFileSync(path.join(REPO, 'src/codex-message-manager.js'), 'utf8');
ok(/this\._status\.slashCommands \|\| \[\]/.test(cm) && !/slashCommands: \[\],/.test(cm), 'normalizer pin: init slashCommands come from wrapper_meta (no hardcoded empty list left)');

// ── ②d STOP, ROUND 2: the three defects an adversarial verifier found in the
// first cut. Each needs an app-server the main stub deliberately is NOT (one
// that refuses a delete / announces a turn mid-sweep / stops answering), so
// each leg drives its OWN wrapper against its own stub — reaching these states
// from the main stub would poison every assertion above.
console.log('— ②d Stop, round 2: the refused delete, the mid-sweep republish, the wedged app-server');
const spawnStub = (tag, stubBody) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `vs-cxp2-${tag}-`));
  const sid = `sess-${tag}-1700000000009`;
  const b = path.join(d, sid + '.buf'), mt = path.join(d, sid + '.json'), rl = path.join(d, 'rpc.jsonl');
  const proc = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), b, mt, process.execPath, '-e', stubBody.replace(/__RPCLOG__/g, JSON.stringify(rl))], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_WEBUI_CWD: d, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
  });
  let o = ''; proc.stdout.on('data', (x) => { o += x; }); proc.stderr.on('data', () => {});
  const evs = () => o.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    events: evs,
    msgs: () => evs().filter((e) => e.type === 'event_msg').map((e) => e.payload),
    ops: () => evs().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_op_result').map((e) => e.payload),
    queues: () => evs().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_changed').map((e) => e.payload),
    lastQueue: () => (evs().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_changed').slice(-1)[0]?.payload?.items) || [],
    rpc: () => { try { return fs.readFileSync(rl, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    meta: () => { try { return JSON.parse(fs.readFileSync(mt, 'utf8')); } catch { return null; } },
    send: (x) => proc.stdin.write(JSON.stringify(x) + '\n'),
    dir: d,
    journal: () => { try { return fs.readFileSync(path.join(d, 'codex-chat-wrapper.log'), 'utf8'); } catch { return ''; } },
    stop: () => { try { proc.kill('SIGTERM'); } catch {} try { fs.rmSync(d, { recursive: true, force: true }); } catch {} },
  };
};

// (1)+(2) — an app-server that DRAINS a queued item between our list and our
// delete: it answers {deleted:false} (0.153.4 answers the flag, it does not
// error) and the drained item starts a turn, so a `turn/started` lands while
// the sweep is still deleting.
const STUB_RACE = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let activeTurn = null; let announced = false;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(__RPCLOG__, line + '\\n');
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-race' } } }); continue; }
    if (m.method === 'turn/start') { turns++; const tid = 'turn-' + turns; activeTurn = tid; send({ id: m.id, result: { turn: { id: tid } } }); send({ method: 'turn/started', params: { turn: { id: tid } } }); continue; }
    if (m.method === 'thread/queue/add') { const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId }; queue.push(q); send({ id: m.id, result: { queuedSubmission: q } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-race' } }); continue; }
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: queue.slice(), nextCursor: null } }); continue; }
    if (m.method === 'thread/queue/delete') {
      const at = queue.findIndex((q) => q.id === m.params.queuedSubmissionId);
      if (at >= 0 && JSON.stringify(queue[at].input).includes('[ran]')) {
        // THE RACE: this one was drained a moment ago and is RUNNING now, so
        // the delete is refused — and the drained item's own turn/started
        // arrives before the reply, i.e. while the sweep is mid-flight.
        queue.splice(at, 1);
        if (!announced) { announced = true; turns++; activeTurn = 'turn-' + turns; send({ method: 'turn/started', params: { turn: { id: activeTurn } } }); }
        send({ id: m.id, result: { deleted: false } });
        send({ method: 'thread/queue/changed', params: { threadId: 'th-race' } });
        continue;
      }
      if (at < 0) { send({ id: m.id, error: { code: -32600, message: 'queued submission not found' } }); continue; }
      queue.splice(at, 1); send({ id: m.id, result: { deleted: true } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-race' } }); continue;
    }
    if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); const e = activeTurn; activeTurn = null; send({ method: 'turn/completed', params: { turn: { id: e }, status: 'interrupted' } }); continue; }
    send({ id: m.id, result: {} });
  }
});
`;
{
  const A = spawnStub('race', STUB_RACE);
  ok(await waitFor(() => A.meta()?.threadId === 'th-race'), 'race stub: the wrapper has a thread');
  A.send({ type: 'chat-input', text: 'go', msgId: 'a0' });
  ok(await waitFor(() => A.meta()?.activeTurnId === 'turn-1'), 'race stub: a turn is running');
  A.send({ type: 'chat-input', text: '[ran] runaway', msgId: 'a1' });
  A.send({ type: 'peer-message', text: '[ran] ping from D', fromName: 'session D' });
  A.send({ type: 'chat-input', text: 'really stopped', msgId: 'a3' });
  ok(await waitFor(() => A.lastQueue().length === 3), `race stub: three items queued behind it (${JSON.stringify(A.lastQueue().map((i) => i.preview))})`);
  const qItems = A.lastQueue();
  const byPreview = (needle) => qItems.find((i) => i.preview.includes(needle));
  const runaway = byPreview('runaway'), peerItem = byPreview('ping from D'), stopped = byPreview('really stopped');
  const sweptIds = qItems.map((i) => i.id);
  const peersBeforeA = A.msgs().filter((m) => m.type === 'peer_message_result').length;
  A.send({ type: 'interrupt' });
  ok(await waitFor(() => A.ops().filter((r) => r.op === 'remove').length >= 3), `race stub: Stop reports every listed item (${JSON.stringify(A.ops())})`);
  // (1) a delete the app-server REFUSED is not a removal. The item left the
  // queue on its own = it RAN, and the chip must not read `Removed`.
  const rRun = A.ops().find((r) => r.id === runaway.id);
  ok(rRun && rRun.ok === false && rRun.reason === 'gone' && rRun.msg_id === 'a1', `a {deleted:false} reply is reported ok:false reason 'gone' — never a fake 'stopped' removal (${JSON.stringify(rRun)})`);
  const rPeer = A.ops().find((r) => r.id === peerItem.id);
  ok(rPeer && rPeer.ok === false && rPeer.reason === 'gone', `…the same verdict for a peer item the app-server drained (${JSON.stringify(rPeer)})`, JSON.stringify(A.ops()));
  // …and a peer message that really RAN must NOT go back to the delivery
  // ladder: it was delivered, re-stashing it would deliver it a second time.
  const peersA = A.msgs().filter((m) => m.type === 'peer_message_result').slice(peersBeforeA);
  ok(!peersA.some((r) => r.ok === false && String(r.text || '').includes('ping from D')), `an agent-to-agent message that RAN is not re-stashed (a second delivery) — ${JSON.stringify(peersA)}`);
  // the item that really was deleted still reports the Stop removal
  const rStop = A.ops().find((r) => r.id === stopped.id);
  ok(rStop && rStop.ok === true && rStop.reason === 'stopped' && rStop.msg_id === 'a3', `the item Stop really did drop is still reported ok:true reason 'stopped' (${JSON.stringify(rStop)})`);
  // (2) the turn/started that landed MID-SWEEP must not republish the wrapper's
  // CACHED item list: those bubbles have already been told they are gone.
  const evA = A.events().filter((e) => e.type === 'event_msg');
  const startedIdx = evA.findIndex((e) => e.payload?.type === 'task_started' && e.payload.turn_id === 'turn-2');
  const lastOpIdx = evA.map((e) => e.payload?.type === 'queue_op_result').lastIndexOf(true);
  ok(startedIdx >= 0 && startedIdx < lastOpIdx, `the drained item's turn/started really arrived WHILE the sweep was running (task_started@${startedIdx} < last removal result@${lastOpIdx})`);
  const resurrected = evA.slice(startedIdx + 1).filter((e) => e.payload?.type === 'queue_changed' && (e.payload.items || []).some((it) => sweptIds.includes(it.id)));
  ok(resurrected.length === 0, `no publish after the mid-sweep turn/started resurrects a swept item (the republish rides the CACHED list and carries the real msgIds) — ${JSON.stringify(resurrected.map((e) => e.payload.items))}`);
  ok(await waitFor(() => A.lastQueue().length === 0), `the sweep's own closing refresh is the one truthful publish, and it is empty (${JSON.stringify(A.lastQueue())})`);
  // through the REAL normalizer: the runaway bubble must not wear `Removed`
  const mmA = new CodexMessageManager('p2-race');
  mmA.convertHistory(A.events());
  const userA = (needle) => mmA.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes(needle));
  ok(userA('runaway') && userA('runaway').queueState !== 'removed', `the bubble of a message that RAN never reads 'Removed' (${userA('runaway')?.queueState || 'no chip'})`);
  ok(userA('really stopped')?.queueState === 'removed', `…while the one Stop really dropped does (${userA('really stopped')?.queueState})`);
  const sysA = mmA.messages.filter((m) => m.role === 'system').map((m) => m.content?.[0]?.text || '');
  ok(sysA.some((t) => /no longer queued — it already ran/.test(t)), 'and the user is TOLD that one already ran (nothing silent)', sysA.join(' | '));
  A.stop();
}

// (3) — an app-server that stops answering. Stop is a SAFETY CONTROL: it must
// reach turn/interrupt on a budget and REPORT what it could not clear, never
// sit behind 15s-per-RPC × N items with the user's Stop button dead.
const STUB_WEDGE = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let activeTurn = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(__RPCLOG__, line + '\\n');
    if (m.method === __STALL__) continue;   // WEDGED: received, logged, never answered
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-wedge' } } }); continue; }
    if (m.method === 'turn/start') { turns++; const tid = 'turn-' + turns; activeTurn = tid; send({ id: m.id, result: { turn: { id: tid } } }); send({ method: 'turn/started', params: { turn: { id: tid } } }); continue; }
    if (m.method === 'thread/queue/add') { const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId }; queue.push(q); send({ id: m.id, result: { queuedSubmission: q } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-wedge' } }); continue; }
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: queue.slice(), nextCursor: null } }); continue; }
    if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); const e = activeTurn; activeTurn = null; send({ method: 'turn/completed', params: { turn: { id: e }, status: 'interrupted' } }); continue; }
    send({ id: m.id, result: {} });
  }
});
`;
{
  // (3a) the LIST never answers: nothing can be enumerated, so nothing may be
  // claimed cleared — and the interrupt still goes out on the sweep's budget.
  const B = spawnStub('wedge-list', STUB_WEDGE.replace(/__STALL__/g, "'thread/queue/list'"));
  ok(await waitFor(() => B.meta()?.threadId === 'th-wedge'), 'wedged-list stub: the wrapper has a thread');
  B.send({ type: 'chat-input', text: 'go', msgId: 'b0' });
  ok(await waitFor(() => B.meta()?.activeTurnId === 'turn-1'), 'wedged-list stub: a turn is running');
  B.send({ type: 'chat-input', text: 'queued behind it', msgId: 'b1' });
  ok(await waitFor(() => B.rpc().some((m) => m.method === 'thread/queue/add')), 'wedged-list stub: a message is queued');
  const t0 = Date.now();
  B.send({ type: 'interrupt' });
  const gotB = await waitFor(() => B.rpc().some((m) => m.method === 'turn/interrupt'), 20000);
  const elapsedB = Date.now() - t0;
  ok(gotB && elapsedB < 10000, `Stop reaches turn/interrupt on the sweep's budget even when thread/queue/list never answers (${elapsedB}ms; the 15s-per-RPC cut took 15s+ before sending it)`);
  ok(B.ops().some((r) => r.op === 'remove' && r.ok === false), `…and it SPEAKS: the queue was NOT cleared (${JSON.stringify(B.ops())})`);
  ok(!B.ops().some((r) => r.ok === true), 'nothing is reported removed when nothing could be read', JSON.stringify(B.ops()));
  B.stop();
}
{
  // (3b) the DELETEs never answer: the cap must expire mid-sweep, the items it
  // never reached must be reported (they stay queued and WILL run), and the
  // interrupt must go out anyway.
  const C = spawnStub('wedge-del', STUB_WEDGE.replace(/__STALL__/g, "'thread/queue/delete'"));
  ok(await waitFor(() => C.meta()?.threadId === 'th-wedge'), 'wedged-delete stub: the wrapper has a thread');
  C.send({ type: 'chat-input', text: 'go', msgId: 'c0' });
  ok(await waitFor(() => C.meta()?.activeTurnId === 'turn-1'), 'wedged-delete stub: a turn is running');
  for (const n of [1, 2, 3, 4]) C.send({ type: 'chat-input', text: `queued ${n}`, msgId: `c${n}` });
  ok(await waitFor(() => C.lastQueue().length === 4), `wedged-delete stub: four messages queued (${C.lastQueue().length})`);
  const queuedIds = C.lastQueue().map((i) => i.id);
  const t0 = Date.now();
  C.send({ type: 'interrupt' });
  const gotC = await waitFor(() => C.rpc().some((m) => m.method === 'turn/interrupt'), 25000);
  const elapsedC = Date.now() - t0;
  ok(gotC && elapsedC < 10000, `Stop reaches turn/interrupt within the overall cap when every thread/queue/delete hangs (${elapsedC}ms for 4 items; 15s each before)`);
  const rms = C.ops().filter((r) => r.op === 'remove');
  ok(rms.length === 4 && rms.every((r) => r.ok === false) && queuedIds.every((id) => rms.some((r) => r.id === id)), `every item Stop could NOT clear is reported ok:false, by id (${JSON.stringify(rms.map((r) => [r.id, r.ok, r.reason]))})`);
  ok(rms.some((r) => r.reason === 'timeout' && /did not answer/.test(r.detail || '')), 'the items the expired cap never even reached are reported as timeouts — reporting what was NOT cleared is the point', JSON.stringify(rms.map((r) => r.reason)));
  ok(C.lastQueue().length === 4, `…and the strip still lists them: they are still queued and will run (${C.lastQueue().length})`);
  C.stop();
}

// ── ②e STOP, ROUND 3: the SECOND Stop frame (double-click, or a second
// attached client). stdin dispatches handleInput WITHOUT awaiting it, so two
// `interrupt` frames 50ms apart really do run concurrently — and against a
// SLOW app-server the second sweep used to enumerate the queue the first was
// still deleting and then report those items `gone` ("it already ran"), the
// exact falsehood this round exists to remove (and on that verdict a queued
// peer message is deliberately NOT re-stashed, so the duplicate also lost a
// promised message). The stub answers list/delete on a delay — the ONLY way
// to hold the two sweeps open at the same time — and reports {deleted:false}
// for an id that is already gone, exactly like the 0.153.4 app-server.
console.log('— ②e Stop, round 3: two interrupt frames = ONE sweep, ONE interrupt');
const STUB_SLOW = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let activeTurn = null;
const D = 250;   // every queue RPC answers this late: the two sweeps overlap
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const note = (o) => fs.appendFileSync(__RPCLOG__, JSON.stringify(o) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(__RPCLOG__, line + '\\n');
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-slow' } } }); continue; }
    if (m.method === 'turn/start') { turns++; const tid = 'turn-' + turns; activeTurn = tid; send({ id: m.id, result: { turn: { id: tid } } }); send({ method: 'turn/started', params: { turn: { id: tid } } }); continue; }
    if (m.method === 'thread/queue/add') { const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId }; queue.push(q); send({ id: m.id, result: { queuedSubmission: q } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-slow' } }); continue; }
    if (m.method === 'thread/queue/list') {
      // The answer is what the queue looks like WHEN WE ANSWER, and the count
      // is logged: "how many enumerations saw a non-empty queue" is how the
      // test sees a second sweep without guessing at timings.
      const id = m.id;
      setTimeout(() => { note({ method: '__list_result__', n: queue.length }); send({ id, result: { data: queue.slice(), nextCursor: null } }); }, D);
      continue;
    }
    if (m.method === 'thread/queue/delete') {
      const id = m.id, qid = m.params.queuedSubmissionId;
      setTimeout(() => {
        const at = queue.findIndex((q) => q.id === qid);
        // Already gone = the 0.153.4 verdict for "something else got it first"
        if (at < 0) { note({ method: '__delete_result__', id: qid, deleted: false }); send({ id, result: { deleted: false } }); return; }
        queue.splice(at, 1);
        note({ method: '__delete_result__', id: qid, deleted: true });
        send({ id, result: { deleted: true } });
        send({ method: 'thread/queue/changed', params: { threadId: 'th-slow' } });
      }, D);
      continue;
    }
    if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); const e = activeTurn; activeTurn = null; send({ method: 'turn/completed', params: { turn: { id: e }, status: 'interrupted' } }); continue; }
    send({ id: m.id, result: {} });
  }
});
`;
{
  const D = spawnStub('slow', STUB_SLOW);
  ok(await waitFor(() => D.meta()?.threadId === 'th-slow'), 'slow stub: the wrapper has a thread');
  D.send({ type: 'chat-input', text: 'go', msgId: 'd0' });
  ok(await waitFor(() => D.meta()?.activeTurnId === 'turn-1'), 'slow stub: a turn is running');
  D.send({ type: 'chat-input', text: 'queued one', msgId: 'd1' });
  D.send({ type: 'peer-message', text: 'ping from E', fromName: 'session E' });
  ok(await waitFor(() => D.lastQueue().length === 2), `slow stub: two messages queued behind the turn (${JSON.stringify(D.lastQueue().map((i) => i.preview))})`);
  const queuedIds = D.lastQueue().map((i) => i.id);
  // Let the adds' own queue/changed refreshes finish answering (D=250ms) —
  // a list REQUESTED before the mark answers after it, and its enumeration is
  // not the sweep's. Marking a quiet wire is what makes the count below mean
  // "the sweep listed once".
  await sleep(700);
  const mark = D.rpc().length;
  const after = () => D.rpc().slice(mark);
  // THE DOUBLE CLICK. 50ms is a real double-click gap and far inside the
  // sweep (250ms per RPC × 3 here); a second attached client's Stop is the
  // same two frames on the same stdin.
  D.send({ type: 'interrupt' });
  await sleep(50);
  D.send({ type: 'interrupt' });
  ok(await waitFor(() => after().some((m) => m.method === 'turn/interrupt'), 15000), 'the Stop reaches turn/interrupt');
  await sleep(900);   // let a SECOND sweep, if there were one, finish and speak
  const enumerations = after().filter((m) => m.method === '__list_result__' && m.n > 0);
  ok(enumerations.length === 1, `exactly ONE enumeration saw the queue — the second Stop rode the running sweep instead of listing it again (${enumerations.length})`, JSON.stringify(after().filter((m) => m.method === '__list_result__')));
  const deletes = after().filter((m) => m.method === 'thread/queue/delete').map((m) => m.params.queuedSubmissionId);
  ok(deletes.length === 2 && new Set(deletes).size === 2 && queuedIds.every((id) => deletes.includes(id)), `ONE thread/queue/delete per queued item, no duplicates (${JSON.stringify(deletes)})`);
  const interrupts = after().filter((m) => m.method === 'turn/interrupt');
  ok(interrupts.length === 1, `exactly ONE turn/interrupt for the two frames — the duplicate is coalesced on the turn it names (${interrupts.length})`, JSON.stringify(interrupts.map((m) => m.params)));
  const rms = D.ops().filter((r) => r.op === 'remove');
  ok(rms.length === 2 && rms.every((r) => r.ok === true && r.reason === 'stopped'), `every Stop-removed item is reported ONCE and as 'stopped' (${JSON.stringify(rms.map((r) => [r.id, r.ok, r.reason]))})`);
  ok(!rms.some((r) => r.reason === 'gone'), "…and NOTHING is reported 'gone' — no item Stop removed may be described as having already run", JSON.stringify(rms.map((r) => r.reason)));
  ok(!after().some((m) => m.method === '__delete_result__' && m.deleted === false), 'the app-server never had to refuse a delete: no item was deleted twice', JSON.stringify(after().filter((m) => m.method === '__delete_result__')));
  ok(after().findIndex((m) => m.method === 'turn/interrupt') > after().map((m) => m.method).lastIndexOf('thread/queue/delete'), 'the ordering still holds under the double Stop: every delete precedes the interrupt', JSON.stringify(after().map((m) => m.method)));
  ok(/already in flight — this Stop rides it/.test(D.journal()), 'the wrapper journal RECORDS the coalescing decision (a silent no-op would be indistinguishable from a lost frame)', D.journal().split('\n').filter((l) => /interrupt/.test(l)).slice(-3).join(' | '));
  ok(D.lastQueue().length === 0, `the queue really is empty afterwards (${JSON.stringify(D.lastQueue())})`);
  // the peer entry Stop dropped goes back to the delivery ladder EXACTLY once
  const back = D.msgs().filter((p) => p.type === 'peer_message_result' && p.ok === false);
  ok(back.length === 1 && /ping from E/.test(back[0].text || ''), `the dropped peer message is handed back to the ladder once, not twice (${JSON.stringify(back.map((b) => b.reason))})`);
  D.stop();
}

// ── ②f a STEER whose delete is REFUSED: `{deleted:false}` after a landed steer
// means the app-server drained the item, i.e. it now runs twice (injected into
// the current turn AND as its own). r2 read that verdict in the Stop sweep but
// not here, and returned a bare ok:true — the silent half of the very failure
// `steered-not-dequeued` exists to announce.
console.log('— ②f the steer whose queued copy could not be removed');
{
  const E = spawnStub('steer-drained', STUB_RACE);
  ok(await waitFor(() => E.meta()?.threadId === 'th-race'), 'drained-steer stub: the wrapper has a thread');
  E.send({ type: 'chat-input', text: 'go', msgId: 'e0' });
  ok(await waitFor(() => E.meta()?.activeTurnId === 'turn-1'), 'drained-steer stub: a turn is running');
  E.send({ type: 'chat-input', text: '[ran] steer me', msgId: 'e1' });
  ok(await waitFor(() => E.lastQueue().length === 1), `drained-steer stub: one message queued (${E.lastQueue().length})`);
  const qid = E.lastQueue()[0].id;
  E.send({ type: 'queue-op', op: 'steer', id: qid });
  ok(await waitFor(() => E.ops().some((r) => r.op === 'steer')), 'the steer answers');
  const r = E.ops().find((x) => x.op === 'steer');
  ok(r?.ok === true && r.reason === 'steered-not-dequeued' && /already left the queue/.test(r.detail || ''), `a landed steer whose delete is REFUSED warns about the second run (${JSON.stringify(r)})`);
  ok(r?.msg_id === 'e1', 'the warning is joined to the bubble it is about', JSON.stringify(r));
  // through the REAL normalizer: the chip still flips to 'steered' (it WAS
  // steered) and the possible double run is a visible notice, never silence
  {
    const nm = new CodexMessageManager('drained');
    const now = new Date().toISOString();
    nm.processLive({ timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: 'e1', content: [{ type: 'input_text', text: 'steer me' }] } });
    nm.processLive({ timestamp: now, type: 'event_msg', payload: { type: 'queue_op_result', ...r } });
    const bubble = nm.messages.find((m) => m.role === 'user');
    const notice = nm.messages.filter((m) => m.role === 'system').map((m) => m.content?.[0]?.text || '');
    ok(bubble?.queueState === 'steered', `the bubble reads 'steered' — it was (${bubble?.queueState})`);
    ok(notice.some((t) => /may run a second time/.test(t)), 'and the possible double run is SAID', notice.join(' | '));
  }
  E.stop();
}


// ── ⑥ THE INHERITED QUEUE (owner 2026-09-07: "我刚才在那个codex session里全给插入
// 了，但是我只能看到我最后插入的一条消息") ──────────────────────────────────
// The app-server's queue belongs to the THREAD, so a resumed thread hands the
// NEW wrapper a queue it never filled (measured on the owner's session:
// `queue_changed n=25` two seconds after boot, every clientUserMessageId minted
// by the wrapper this one replaced). Steering it put 25 messages into the turn
// and produced ZERO bubbles: the app-server's own carrier for a submission
// entering the turn — `item/completed {item:{type:'userMessage', clientId}}`,
// 0.153.4 UserMessageThreadItem — fell off the end of _handleItemCompletedInner
// with no branch and no breadcrumb. This leg drives the REAL wrapper against a
// stub that behaves the way the app-server measurably does: it hands over an
// inherited queue, keeps steered items until we delete them, and COMMITS them
// (the item/completed twins) only later, at the next turn boundary.
console.log('— ⑥ an INHERITED queue: every steered message gets its bubble, exactly once');
const STUB_INHERIT = `
const fs = require('fs');
let b = ''; let turns = 0; let qseq = 0; let activeTurn = null; let committed = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// Twelve submissions queued by the wrapper this one REPLACED: their client ids
// are webui msgIds minted in a session that is gone, and this wrapper has never
// heard of any of them.
const queue = [];
for (let i = 1; i <= 12; i++) queue.push({ id: 'iq' + i, clientUserMessageId: '1788731' + (200000 + i * 137) + '-inh' + i, input: [{ type: 'text', text: 'inherited message ' + i }] });
const commit = (q) => {
  // The commit is the app-server's, and it is LATE: on the owner's session the
  // twins arrived 42s after the steers' replies.
  send({ method: 'item/completed', params: { threadId: 'th-inh', turnId: activeTurn, item: { type: 'userMessage', id: 'um-' + (++committed), clientId: q.clientUserMessageId, content: q.input.map((x) => ({ ...x, text_elements: [] })) } } });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(__RPCLOG__, line + '\\n');
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-inh' } } }); continue; }
    if (m.method === 'turn/start') {
      turns++; const tid = 'turn-' + turns; activeTurn = tid;
      send({ id: m.id, result: { turn: { id: tid } } });
      send({ method: 'turn/started', params: { turn: { id: tid } } });
      // our OWN send: the app-server commits it too, with NO clientId (turn/start
      // carries none) — the wrapper already wrote that bubble in handleInput
      send({ method: 'item/completed', params: { threadId: 'th-inh', turnId: tid, item: { type: 'userMessage', id: 'um-own-' + turns, clientId: null, content: [{ type: 'text', text: 'typed here', text_elements: [] }] } } });
      // …and one kind nothing routes, so the breadcrumb has something to say
      send({ method: 'item/completed', params: { threadId: 'th-inh', turnId: tid, item: { type: 'holoDeck', id: 'hd-1' } } });
      send({ method: 'item/completed', params: { threadId: 'th-inh', turnId: tid, item: { type: 'hookPrompt', id: 'hp-1', fragments: [] } } });
      continue;
    }
    if (m.method === 'thread/queue/add') { const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId }; queue.push(q); send({ id: m.id, result: { queuedSubmission: q } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-inh' } }); continue; }
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: queue.slice(), nextCursor: null } }); continue; }
    if (m.method === 'thread/queue/delete') {
      const at = queue.findIndex((q) => q.id === m.params.queuedSubmissionId);
      if (at < 0) { send({ id: m.id, error: { code: -32600, message: 'queued submission not found' } }); continue; }
      queue.splice(at, 1); send({ id: m.id, result: { deleted: true } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-inh' } }); continue;
    }
    if (m.method === 'turn/steer') {
      if (m.params.expectedTurnId !== activeTurn) { send({ id: m.id, error: { code: -32600, message: 'expected active turn id \\'' + m.params.expectedTurnId + '\\' but found \\'' + activeTurn + '\\'' } }); continue; }
      send({ id: m.id, result: { turnId: activeTurn } });
      // the steer LANDED; the commit twin follows later, out of band
      const q = { clientUserMessageId: m.params.clientUserMessageId, input: m.params.input };
      setTimeout(() => commit(q), 200);
      continue;
    }
    send({ id: m.id, result: {} });
  }
});
// A DRAINED item (no steer at all): the app-server ends the turn, starts a new
// one for the next queued submission and commits it — the other way an
// inherited message enters a turn.
const DRAIN_FILE = __RPCLOG__.replace(/rpc\.jsonl$/, 'drain');
setInterval(() => {
  try { fs.unlinkSync(DRAIN_FILE); } catch { return; }
  // whatever is still queued — or, once a steer-all has emptied the queue, one
  // more submission from the session that is gone: the point is that NOTHING
  // but the commit twin ever mentions it to this wrapper
  const q = queue.shift() || { id: 'iq13', clientUserMessageId: '1788731999999-inh13', input: [{ type: 'text', text: 'inherited message 13' }] };
  const ended = activeTurn; activeTurn = 'turn-drain';
  send({ method: 'turn/completed', params: { turn: { id: ended }, status: 'completed' } });
  send({ method: 'thread/queue/changed', params: { threadId: 'th-inh' } });
  send({ method: 'turn/started', params: { turn: { id: 'turn-drain' } } });
  commit(q);
}, 40);
`;
{
  const I = spawnStub('inherit', STUB_INHERIT);
  const userRecs = () => I.events().filter((e) => e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user');
  ok(await waitFor(() => I.meta()?.threadId === 'th-inh'), 'inherit stub: the wrapper has a thread');
  ok(await waitFor(() => I.lastQueue().length === 12), `the resumed thread's queue arrives at boot, all twelve items (${I.lastQueue().length})`);
  ok(I.lastQueue().every((it, i) => it.msgId === `1788731${200000 + (i + 1) * 137}-inh${i + 1}`),
    'an INHERITED row advertises the app-server\'s own clientUserMessageId as its msgId — the id the bubble will carry, so the strip row and the chip join', JSON.stringify(I.lastQueue().slice(0, 2)));
  ok(userRecs().length === 0, 'nothing has been recorded for them yet: a queued message is not in the turn', JSON.stringify(userRecs().map((r) => r.payload.content)));

  // a turn has to be running before anything can be steered into it
  I.send({ type: 'chat-input', text: 'typed here', msgId: 'own-1' });
  ok(await waitFor(() => I.meta()?.activeTurnId === 'turn-1'), 'a turn is running');
  ok(await waitFor(() => userRecs().length === 1), 'our own send has its bubble, written by handleInput as always');

  I.send({ type: 'queue-op', op: 'steer-all' });
  ok(await waitFor(() => I.ops().filter((r) => r.op === 'steer' && r.ok).length === 12, 15000), `all twelve steer (${I.ops().filter((r) => r.op === 'steer').length})`);
  const inherited = () => userRecs().filter((r) => r.payload.webui_queue_id);
  ok(inherited().length === 12, `THE FIX: twelve steered messages, twelve bubbles — written AT THE STEER, not at the app-server's much later commit (${inherited().length})`, JSON.stringify(inherited().map((r) => r.payload.content[0].text)));
  ok(inherited().every((r, i) => r.payload.content[0].text === `inherited message ${i + 1}`), 'in queue order', JSON.stringify(inherited().map((r) => r.payload.content[0].text)));
  ok(inherited().every((r, i) => r.payload.webui_queue_id === `1788731${200000 + (i + 1) * 137}-inh${i + 1}`), 'each stamped with the submission id its queue row advertised');
  ok(I.ops().filter((r) => r.op === 'steer' && r.ok).every((r) => /-inh\d+$/.test(r.msg_id || '')), 'every steer result names the same id, so the chip can flip', JSON.stringify(I.ops().filter((r) => r.op === 'steer').slice(0, 2)));
  // THE COMMIT TWINS land ~200ms later: they must add NOTHING (this is the
  // dedupe that keeps one message one bubble when both producers speak).
  await sleep(700);
  ok(inherited().length === 12, `the app-server's own item/completed twins add no second copy (${inherited().length})`, JSON.stringify(inherited().map((r) => r.payload.webui_queue_id)));
  ok(userRecs().length === 13, `thirteen user records for thirteen messages, no duplicates (${userRecs().length})`);
  ok(!userRecs().some((r) => r.payload.webui_queue_id && r.payload.webui_msg_id), 'a record carries ONE identity — the queue id or the webui msgId, never both');
  ok(!userRecs().some((r) => /typed here/.test(JSON.stringify(r.payload.content)) && r.payload.webui_queue_id),
    'our own message is never re-recorded from its clientId-less commit twin (turn/start carries no clientId — that bubble already exists)');

  // THROUGH THE REAL NORMALIZER — the frames the REAL wrapper emitted, fed to
  // the REAL server-side normalizer the ws layer feeds: this is what the chat
  // window renders.
  {
    const nm = new CodexMessageManager('inh');
    for (const e of I.events()) nm.processLive(e);
    const users = nm.messages.filter((m) => m.role === 'user');
    ok(users.length === 13, `LIVE: the wrapper's own frames render 13 user bubbles (${users.length})`, JSON.stringify(users.map((m) => (m.content || []).map((c) => c.text).join('').slice(0, 24))));
    const texts = users.map((m) => (m.content || []).map((c) => c.text || '').join(''));
    ok(new Set(texts).size === 13, 'each exactly once', JSON.stringify(texts));
    ok(texts.slice(1).every((t, i) => t === `inherited message ${i + 1}`), 'in queue order, after the message typed here', JSON.stringify(texts));
    const chipped = users.filter((m) => m.queueState === 'steered');
    ok(chipped.length === 12, `and every steered bubble wears the Steered chip — the join the inherited msgId exists for (${chipped.length})`, JSON.stringify(users.map((m) => m.queueState || null)));
  }

  // THE DRAIN PATH: an inherited item the app-server runs by itself when a turn
  // ends. No steer, so the item/completed twin is the ONLY notice we get.
  {
    const before = inherited().length;
    fs.writeFileSync(path.join(I.dir, 'drain'), '1');
    ok(await waitFor(() => inherited().length === before + 1), `a DRAINED inherited item gets its bubble from the commit twin alone (${inherited().length - before})`);
    const last = inherited().slice(-1)[0];
    ok(/inherited message/.test(last.payload.content[0].text) && /-inh\d+$/.test(last.payload.webui_queue_id), 'with the same shape and the same id', JSON.stringify(last.payload));
  }

  // NO SILENT DROPS: the unrouted kind is named, the deliberate no-op is not.
  ok(await waitFor(() => !!I.meta()?.unhandledItems?.holoDeck), `an item/completed kind nothing routes is COUNTED in the sidecar (${JSON.stringify(I.meta()?.unhandledItems)})`);
  ok(/unhandled item kind "holoDeck"/.test(I.journal()), 'and logged once, verbatim, in the wrapper journal');
  ok(!I.meta()?.unhandledItems?.hookPrompt && !I.meta()?.unhandledItems?.userMessage, 'a NAMED no-op (hookPrompt) and the now-routed userMessage are not "unhandled"', JSON.stringify(I.meta()?.unhandledItems));
  I.stop();

  // THE NEGATIVE CONTROL, against the SHIPPED code: the same stub, the same
  // steer-all, driven by the wrapper as it was before this fix. It is a
  // dependency-free single file (fs/path/child_process), so it runs verbatim
  // from git. If master ever stops reproducing the failure the control says so
  // instead of passing for the wrong reason.
  {
    const { execFileSync } = await import('node:child_process');
    let before = '';
    try { before = execFileSync('git', ['-C', REPO, 'show', 'master:data/bin/codex-chat-wrapper.js'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch (e) { before = ''; }
    if (!before) {
      console.log('  SKIP: `git show master:data/bin/codex-chat-wrapper.js` produced nothing — the pre-fix control did not run');
    } else if (/type === 'userMessage'/.test(before)) {
      console.log('  SKIP: master already routes item/completed userMessage — this control has served its purpose (it can only fail once)');
    } else {
      const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxp2-prefix-'));
      const cw = path.join(cd, 'codex-chat-wrapper.js');
      fs.writeFileSync(cw, before);
      const sid = 'sess-prefix-1700000000009';
      const cb = path.join(cd, sid + '.buf'), cm2 = path.join(cd, sid + '.json'), crl = path.join(cd, 'rpc.jsonl');
      const p2 = spawn(process.execPath, [cw, cb, cm2, process.execPath, '-e', STUB_INHERIT.replace(/__RPCLOG__/g, JSON.stringify(crl))], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CODEX_WEBUI_CWD: cd, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
      });
      let o2 = ''; p2.stdout.on('data', (x) => { o2 += x; }); p2.stderr.on('data', () => {});
      const ev2 = () => o2.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const users2 = () => ev2().filter((e) => e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user');
      const meta2 = () => { try { return JSON.parse(fs.readFileSync(cm2, 'utf8')); } catch { return null; } };
      const ops2 = () => ev2().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_op_result').map((e) => e.payload);
      await waitFor(() => meta2()?.threadId === 'th-inh');
      p2.stdin.write(JSON.stringify({ type: 'chat-input', text: 'typed here', msgId: 'own-1' }) + '\n');
      await waitFor(() => meta2()?.activeTurnId === 'turn-1');
      p2.stdin.write(JSON.stringify({ type: 'queue-op', op: 'steer-all' }) + '\n');
      await waitFor(() => ops2().filter((r) => r.op === 'steer' && r.ok).length === 12, 15000);
      await sleep(900);   // long enough for every commit twin to have arrived
      ok(ops2().filter((r) => r.op === 'steer' && r.ok).length === 12, 'PRE-FIX CONTROL: the shipped wrapper steers all twelve too — the messages DID enter the turn');
      ok(users2().length === 1, `PRE-FIX CONTROL: …and renders ONE bubble, the message typed here — exactly the owner's report ("我只能看到我最后插入的一条消息") (${users2().length})`, JSON.stringify(users2().map((r) => r.payload.content?.[0]?.text)));
      ok(!/unhandled item kind/.test((() => { try { return fs.readFileSync(path.join(cd, 'codex-chat-wrapper.log'), 'utf8'); } catch { return ''; } })()),
        '…and said nothing about the twelve item kinds it dropped — the silence this fix also closes');
      try { p2.kill('SIGTERM'); } catch {}
      try { fs.rmSync(cd, { recursive: true, force: true }); } catch {}
    }
  }
}
// ── ⑦ THE VERB TABLE: reorder / edit / run-now / run-all (2026-09-07) ──────
// A stub whose queue/list PAGINATES (2 per page, opaque cursors — the real
// 0.153.4 answers `nextCursor` for a `limit`ed list, measured), whose
// `reorder` enforces the real server's rule ("must include every queued
// submission exactly once"), and which can have items INJECTED behind the
// wrapper's back — the peer lane adding between a render and a drop, which is
// exactly the race the relative `afterId` frame exists to survive.
console.log('— ⑦ reorder / edit / run-now / run-all against a paginating stub');
const STUB_VERBS = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let activeTurn = null;
const PAGE = 2;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const changed = () => send({ method: 'thread/queue/changed', params: { threadId: 'th-verbs' } });
// INJECTION: items that appear in the queue with NO queue/add from the wrapper
// (a peer message posted by the server, or a thread resumed with items on it).
// Deliberately SILENT — no queue/changed — so the wrapper's last published
// queue is stale, which is the state a relative reorder has to survive.
setInterval(() => {
  let raw; try { raw = fs.readFileSync(__INJECT__, 'utf8'); } catch { return; }
  try { fs.unlinkSync(__INJECT__); } catch {}
  let items; try { items = JSON.parse(raw); } catch { return; }
  for (const it of items) queue.push({ id: it.id || ('inj' + (++qseq)), input: it.input, clientUserMessageId: it.cid || ('inj-cid-' + qseq) });
}, 40);
// A turn that ends WITHOUT draining: the resumed-thread shape (idle thread,
// non-empty queue) — the only state in which run-now/run-all can do anything.
setInterval(() => {
  try { fs.unlinkSync(__ENDTURN__); } catch { return; }
  if (!activeTurn) return;
  const e = activeTurn; activeTurn = null;
  send({ method: 'turn/completed', params: { turn: { id: e }, status: 'completed' } });
}, 40);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(__RPCLOG__, line + '\\n');
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-verbs' } } }); continue; }
    if (m.method === 'turn/start') { turns++; const tid = 'turn-' + turns; activeTurn = tid; send({ id: m.id, result: { turn: { id: tid } } }); send({ method: 'turn/started', params: { turn: { id: tid } } }); continue; }
    if (m.method === 'thread/queue/add') { const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId }; queue.push(q); send({ id: m.id, result: { queuedSubmission: q } }); changed(); continue; }
    if (m.method === 'thread/queue/list') {
      const off = m.params.cursor ? parseInt(m.params.cursor, 10) : 0;
      const data = queue.slice(off, off + PAGE);
      const next = off + PAGE < queue.length ? String(off + PAGE) : null;
      send({ id: m.id, result: { data, nextCursor: next } });
      continue;
    }
    if (m.method === 'thread/queue/delete') {
      const at = queue.findIndex((q) => q.id === m.params.queuedSubmissionId);
      if (at < 0) { send({ id: m.id, result: { deleted: false } }); continue; }
      queue.splice(at, 1); send({ id: m.id, result: { deleted: true } }); changed(); continue;
    }
    if (m.method === 'thread/queue/reorder') {
      const want = m.params.queuedSubmissionIds || [];
      const have = queue.map((q) => q.id);
      const same = want.length === have.length && new Set(want).size === want.length && have.every((id) => want.includes(id));
      if (!same) { send({ id: m.id, error: { code: -32600, message: 'queue reorder must include every queued submission exactly once' } }); continue; }
      queue = want.map((id) => queue.find((q) => q.id === id));
      send({ id: m.id, result: {} }); changed(); continue;
    }
    if (m.method === 'thread/queue/update') {
      const at = queue.findIndex((q) => q.id === m.params.queuedSubmissionId);
      if (at < 0) { send({ id: m.id, error: { code: -32600, message: 'queued submission not found: ' + m.params.queuedSubmissionId } }); continue; }
      queue[at] = { ...queue[at], input: m.params.input };
      send({ id: m.id, result: { queuedSubmission: queue[at] } }); changed(); continue;
    }
    if (m.method === 'thread/queue/start') {
      const qid = m.params.queuedSubmissionId;
      if (qid) { const at = queue.findIndex((q) => q.id === qid); if (at >= 0) queue.splice(at, 1); }
      else queue = [];
      turns++; activeTurn = 'turn-' + turns;
      send({ id: m.id, result: { turn: { id: activeTurn } } });
      send({ method: 'turn/started', params: { turn: { id: activeTurn } } });
      changed(); continue;
    }
    if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); const e = activeTurn; activeTurn = null; send({ method: 'turn/completed', params: { turn: { id: e }, status: 'interrupted' } }); continue; }
    send({ id: m.id, result: {} });
  }
});
`;
{
  const injectFile = path.join(os.tmpdir(), `vs-cxp2-inject-${process.pid}.json`);
  const endFile = path.join(os.tmpdir(), `vs-cxp2-endturn-${process.pid}.json`);
  try { fs.unlinkSync(injectFile); } catch { }
  try { fs.unlinkSync(endFile); } catch { }
  const V = spawnStub('verbs', STUB_VERBS.replace(/__INJECT__/g, JSON.stringify(injectFile)).replace(/__ENDTURN__/g, JSON.stringify(endFile)));
  const inject = (items) => fs.writeFileSync(injectFile, JSON.stringify(items));
  const lastOp = (op) => V.ops().filter((r) => r.op === op).slice(-1)[0] || null;
  const rpcOf = (method) => V.rpc().filter((m) => m.method === method);
  ok(await waitFor(() => V.meta()?.threadId === 'th-verbs'), 'verb stub: the wrapper has a thread');

  // A turn, then FIVE queued messages = three pages of two.
  V.send({ type: 'chat-input', text: 'go', msgId: 'v0' });
  ok(await waitFor(() => V.meta()?.activeTurnId === 'turn-1'), 'verb stub: a turn is running');
  for (let i = 1; i <= 5; i++) V.send({ type: 'chat-input', text: 'msg ' + i, msgId: 'v' + i });
  ok(await waitFor(() => V.lastQueue().length === 5), `THE PAGING FIX: a queue longer than one page is published WHOLE (${V.lastQueue().length} items; the pre-verb-table refreshQueue dropped nextCursor and published the first page only)`, JSON.stringify(V.lastQueue().map((i) => i.msgId)));
  ok(rpcOf('thread/queue/list').some((m) => m.params.cursor), 'the wrapper really follows `cursor` (not just a bigger single request)', JSON.stringify(rpcOf('thread/queue/list').slice(-3).map((m) => m.params)));

  // REORDER, with an item the client never saw injected in between.
  {
    const known = V.lastQueue().map((i) => i.id);
    inject([{ id: 'peer-x', input: [{ type: 'text', text: 'posted by a peer' }] }]);
    await sleep(200);
    const before = rpcOf('thread/queue/reorder').length;
    // move the FIRST item behind the THIRD — a relative frame, exactly what the
    // client's drag sends.
    V.send({ type: 'queue-op', op: 'reorder', id: known[0], afterId: known[2] });
    ok(await waitFor(() => rpcOf('thread/queue/reorder').length > before), 'a relative reorder frame becomes a thread/queue/reorder RPC');
    const sent = rpcOf('thread/queue/reorder').slice(-1)[0].params.queuedSubmissionIds;
    ok(sent.length === 6 && sent.includes('peer-x'), `THE MERGE: the order is computed from a FRESH list, so an id queued between the render and the drop is IN it (${JSON.stringify(sent)})`);
    ok(sent.indexOf('peer-x') === 5, '…at the place the SERVER has it, not appended by guesswork', JSON.stringify(sent));
    ok(sent.indexOf(known[0]) === sent.indexOf(known[2]) + 1, '…and the moved item sits directly behind its anchor', JSON.stringify(sent));
    ok(await waitFor(() => lastOp('reorder')?.ok === true), 'the reorder is reported ok', JSON.stringify(lastOp('reorder')));
    ok(await waitFor(() => JSON.stringify(V.lastQueue().map((i) => i.id)) === JSON.stringify(sent)), 'and the CLOSING PUBLISH is the truth (the strip renders the order the server now has)', JSON.stringify(V.lastQueue().map((i) => i.id)));
  }
  // AN ANCHOR THAT LEFT: nothing is moved, and the user is told why.
  {
    const ids = V.lastQueue().map((i) => i.id);
    const before = rpcOf('thread/queue/reorder').length;
    V.send({ type: 'queue-op', op: 'reorder', id: ids[0], afterId: 'no-such-id' });
    ok(await waitFor(() => lastOp('reorder')?.reason === 'anchor-gone'), `an anchor that is no longer queued answers 'anchor-gone' with what happened (${JSON.stringify(lastOp('reorder'))})`);
    ok(rpcOf('thread/queue/reorder').length === before, 'and NO reorder RPC goes out — a guessed position is worse than a refusal');
  }
  // EDIT: every UserInput variant that is not the replaced text survives.
  {
    const SEVEN = [
      { type: 'text', text: 'first', text_elements: [{ byteRange: { start: 0, end: 5 }, placeholder: '@x' }] },
      { type: 'image', url: 'data:image/png;base64,AAAA', detail: 'high' },
      { type: 'localImage', path: '/tmp/a.png', detail: null },
      { type: 'audio', url: 'https://example.org/a.wav' },
      { type: 'localAudio', path: '/tmp/a.wav' },
      { type: 'skill', name: 'design', path: '/skills/design' },
      { type: 'mention', name: 'notes', path: '/tmp/notes.md' },
      { type: 'text', text: 'trailing words' },
    ];
    inject([{ id: 'mixed-1', input: SEVEN }]);
    await sleep(250);
    const before = rpcOf('thread/queue/update').length;
    V.send({ type: 'queue-op', op: 'edit', id: 'mixed-1', text: 'rewritten' });
    ok(await waitFor(() => rpcOf('thread/queue/update').length > before), 'an edit frame becomes a thread/queue/update RPC');
    const p = rpcOf('thread/queue/update').slice(-1)[0].params;
    ok(p.threadId === 'th-verbs' && p.queuedSubmissionId === 'mixed-1' && Array.isArray(p.input), 'update carries {threadId, queuedSubmissionId, input} — the WHOLE input array', JSON.stringify(p).slice(0, 200));
    ok(p.input[0].type === 'text' && p.input[0].text === 'rewritten', 'the first text element carries the new words');
    ok(Array.isArray(p.input[0].text_elements) && p.input[0].text_elements.length === 0, 'THE STALE SPANS ARE CLEARED: text_elements index the OLD buffer, so keeping them would describe a string that no longer exists', JSON.stringify(p.input[0]));
    const kept = p.input.slice(1).map((x) => x.type);
    ok(JSON.stringify(kept) === JSON.stringify(['image', 'localImage', 'audio', 'localAudio', 'skill', 'mention']), `PRESERVED BY EXCLUSION, in place: every non-text variant survives — including audio/localAudio, which a whitelist would have deleted (${JSON.stringify(kept)})`);
    ok(JSON.stringify(p.input[1]) === JSON.stringify(SEVEN[1]) && JSON.stringify(p.input[6]) === JSON.stringify(SEVEN[6]), '…byte for byte, not re-encoded', JSON.stringify([p.input[1], p.input[6]]));
    ok(!p.input.some((x, i) => i > 0 && x.type === 'text'), 'the trailing text element is gone (its words are what the user just rewrote)', JSON.stringify(p.input.map((x) => x.type)));
    ok(await waitFor(() => lastOp('edit')?.ok === true), 'the edit is reported ok', JSON.stringify(lastOp('edit')));
    ok(await waitFor(() => (V.lastQueue().find((i) => i.id === 'mixed-1')?.preview || '').startsWith('rewritten')), 'and the republished strip shows the NEW words (the visible confirmation of an edit)', JSON.stringify(V.lastQueue().find((i) => i.id === 'mixed-1')));
    ok((V.lastQueue().find((i) => i.id === 'mixed-1')?.text || '') === 'rewritten', '…and the FULL text rides the item, so a second edit opens the real message and not a 120-char preview', JSON.stringify(V.lastQueue().find((i) => i.id === 'mixed-1')?.text));
  }
  // A PEER item is not editable — rewriting another agent's words would put
  // text in its mouth. The client hides the control; this is the gate that
  // MEANS it.
  {
    V.send({ type: 'peer-message', text: 'ping from F', fromName: 'session F' });
    ok(await waitFor(() => V.lastQueue().some((i) => i.kind === 'peer')), 'a peer message is queued on the same lane');
    const peer = V.lastQueue().find((i) => i.kind === 'peer');
    ok(!('text' in peer), 'a peer row carries NO full text (nothing to open an editor on)', JSON.stringify(peer));
    const before = rpcOf('thread/queue/update').length;
    V.send({ type: 'queue-op', op: 'edit', id: peer.id, text: 'words I put in its mouth' });
    ok(await waitFor(() => lastOp('edit')?.reason === 'not-editable'), `editing a peer item is REFUSED with the reason (${JSON.stringify(lastOp('edit'))})`);
    ok(rpcOf('thread/queue/update').length === before, '…and no update RPC is sent at all');
    V.send({ type: 'queue-op', op: 'remove', id: peer.id });
    ok(await waitFor(() => !V.lastQueue().some((i) => i.kind === 'peer')), '…while removing it still works (you can drop it, you just cannot rewrite it)');
  }
  // RUN NOW / RUN ALL — refused while a turn runs, honoured when idle.
  {
    const beforeStart = rpcOf('thread/queue/start').length;
    const target = V.lastQueue()[0].id;
    V.send({ type: 'queue-op', op: 'run-now', id: target });
    ok(await waitFor(() => lastOp('run-now')?.reason === 'busy'), `run-now during a turn is REFUSED with 'busy' and what is true instead (${JSON.stringify(lastOp('run-now'))})`);
    ok(/runs as soon as it ends/.test(lastOp('run-now')?.detail || ''), '…the refusal says the message runs when the turn ends (never accept-and-ignore)', lastOp('run-now')?.detail);
    V.send({ type: 'queue-op', op: 'run-all', id: null });
    ok(await waitFor(() => lastOp('run-all')?.reason === 'busy'), 'run-all during a turn is refused the same way', JSON.stringify(lastOp('run-all')));
    ok(rpcOf('thread/queue/start').length === beforeStart, 'NO thread/queue/start goes out while a turn is running', JSON.stringify(rpcOf('thread/queue/start').map((m) => m.params)));

    // …now the turn ends WITHOUT draining (the resumed-thread shape).
    fs.writeFileSync(endFile, '1');
    ok(await waitFor(() => !V.meta()?.activeTurnId), 'the turn ends, leaving an IDLE thread with a non-empty queue (a resumed thread looks exactly like this)');
    const queuedNow = V.lastQueue().map((i) => i.id);
    V.send({ type: 'queue-op', op: 'run-now', id: queuedNow[1] });
    ok(await waitFor(() => rpcOf('thread/queue/start').length === beforeStart + 1), 'run-now on an idle thread sends thread/queue/start');
    const p1 = rpcOf('thread/queue/start').slice(-1)[0].params;
    ok(p1.threadId === 'th-verbs' && p1.queuedSubmissionId === queuedNow[1], 'RUN-NOW NAMES ITS ITEM (an id-less start would drain the whole queue)', JSON.stringify(p1));
    ok(await waitFor(() => lastOp('run-now')?.ok === true), 'and it is reported ok', JSON.stringify(lastOp('run-now')));

    // and run-all: the SAME RPC with NO id at all. Wait for the wrapper to
    // REGISTER the turn run-now started before ending it — the sidecar lags
    // the in-memory state by a debounce, so "not busy on disk" is not "not
    // busy", and racing it here would test the wrong refusal.
    ok(await waitFor(() => !!V.meta()?.activeTurnId), 'the started item is running as a turn');
    fs.writeFileSync(endFile, '1');
    ok(await waitFor(() => !V.meta()?.activeTurnId), 'and that turn ends, idle again');
    const before2 = rpcOf('thread/queue/start').length;
    V.send({ type: 'queue-op', op: 'run-all', id: null });
    ok(await waitFor(() => rpcOf('thread/queue/start').length === before2 + 1), 'run-all on an idle thread sends thread/queue/start too');
    const p2 = rpcOf('thread/queue/start').slice(-1)[0].params;
    ok(p2.threadId === 'th-verbs' && !('queuedSubmissionId' in p2), 'RUN-ALL OMITS the id entirely — a DIFFERENT request, not run-now with a lost argument', JSON.stringify(p2));
    ok(await waitFor(() => V.lastQueue().length === 0), 'the queue drains and the closing publish says so', JSON.stringify(V.lastQueue()));
    ok(await waitFor(() => !!V.meta()?.activeTurnId), 'the drain is running as a turn');
    fs.writeFileSync(endFile, '1');
    ok(await waitFor(() => !V.meta()?.activeTurnId), 'which ends, idle with an empty queue');
    V.send({ type: 'queue-op', op: 'run-all', id: null });
    ok(await waitFor(() => lastOp('run-all')?.reason === 'empty'), 'run-all with nothing queued says so instead of firing an empty start', JSON.stringify(lastOp('run-all')));
  }
  // The wrapper ADVERTS the verbs it serves, in the sidecar AND in-band (a
  // remote wrapper's sidecar is on the other machine).
  ok(JSON.stringify(V.meta()?.caps?.queueVerbs) === JSON.stringify(['remove', 'steer', 'steer-all', 'reorder', 'edit', 'run-now', 'run-all']), 'the sidecar adverts the verb list this build serves', JSON.stringify(V.meta()?.caps));
  ok(V.queues().every((q) => Array.isArray(q.verbs) && q.verbs.includes('reorder')), 'EVERY queue_changed carries the same list in-band (the only advert a remote session ever sees)', JSON.stringify(V.queues().slice(-1)[0]?.verbs));
  V.stop();
  try { fs.unlinkSync(injectFile); } catch { }
  try { fs.unlinkSync(endFile); } catch { }
}


// ── ②f NOTIFICATIONS STEER, HUMANS QUEUE (owner decision 2026-09-07: a codex
// session had accumulated 20 "[VibeSpace Background Work] … done" items as 20
// SEPARATE queued submissions = 20 billed turns after the one it was running;
// "系统通知默认应该是steering的", then "按照TUI实现吧").
// THE RULE, and what each leg below proves:
//   · a VIBESPACE NOTIFICATION (frame kind:'notification') arriving while a
//     turn runs is STEERED into that turn — one turn/steer, no queue/add.
//   · the steer carries ONLY ITSELF: the queue is neither read nor written,
//     so items already queued keep their place AND their order (the negative
//     control for the "carry the queue along" variant, which would have had
//     to delete them).
//   · a HUMAN peer message (kind:'peer', and any untyped frame from an older
//     server) keeps today's behaviour: thread/queue/add, its own turn.
//   · a REFUSED steer is a designed path — the message falls back to the
//     queue/turn lane and the result SAYS the steer was refused.
// Upstream sources for "a steer carries only itself" (rust-v0.153.4):
//   app-server/src/request_processors/turn_processor.rs:1023-1039 — turn/steer
//   maps `params.input` into ONE TurnInput::UserInput, TurnInputMode::Steer;
//   core/src/session/turn.rs:312-323 → session/input_queue.rs
//   `get_pending_input` (`pending_input.items.split_off(0)`) — core drains all
//   pending steers wholesale before each model request, so consecutive
//   notifications merge by themselves.
console.log('— ②f notifications steer, humans queue');
const STUB_NOTIF = `
const fs = require('fs');
let b = ''; let turns = 0; let queue = []; let qseq = 0; let activeTurn = null;
const STEER = __STEERMODE__;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(__RPCLOG__, line + '\\n');
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-notif' } } }); continue; }
    if (m.method === 'turn/start') { turns++; const tid = 'turn-' + turns; activeTurn = tid; send({ id: m.id, result: { turn: { id: tid } } }); send({ method: 'turn/started', params: { turn: { id: tid } } }); continue; }
    if (m.method === 'thread/queue/add') { const q = { id: 'q' + (++qseq), input: m.params.input, clientUserMessageId: m.params.clientUserMessageId }; queue.push(q); send({ id: m.id, result: { queuedSubmission: q } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-notif' } }); continue; }
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: queue.slice(), nextCursor: null } }); continue; }
    if (m.method === 'thread/queue/delete') {
      const at = queue.findIndex((q) => q.id === m.params.queuedSubmissionId);
      if (at < 0) { send({ id: m.id, error: { code: -32600, message: 'queued submission not found' } }); continue; }
      queue.splice(at, 1); send({ id: m.id, result: { deleted: true } }); send({ method: 'thread/queue/changed', params: { threadId: 'th-notif' } }); continue;
    }
    if (m.method === 'turn/steer') {
      if (STEER === 'review') { send({ id: m.id, error: { code: -32600, message: 'cannot steer a review turn' } }); continue; }
      if (STEER === 'ended') {
        // THE RACE THE FALLBACK EXISTS FOR: the turn finished between the
        // wrapper's activeTurnId check and this RPC. The notification lands
        // FIRST (that is the order a real app-server produces), then the error.
        const e = activeTurn; activeTurn = null;
        send({ method: 'turn/completed', params: { turn: { id: e }, status: 'completed' } });
        send({ id: m.id, error: { code: -32600, message: 'no active turn to steer' } });
        continue;
      }
      if (m.params.expectedTurnId !== activeTurn) { send({ id: m.id, error: { code: -32600, message: 'expected active turn id \`' + m.params.expectedTurnId + '\` but found \`' + activeTurn + '\`' } }); continue; }
      send({ id: m.id, result: { turnId: activeTurn } });
      continue;
    }
    if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); const e = activeTurn; activeTurn = null; send({ method: 'turn/completed', params: { turn: { id: e }, status: 'interrupted' } }); continue; }
    send({ id: m.id, result: {} });
  }
});
`;
const NOTIF_TEXT = '[VibeSpace Background Work] task "nightly" (job-1): done.';
{
  const N = spawnStub('notif', STUB_NOTIF.replace(/__STEERMODE__/g, "'ok'"));
  const peerResults = () => N.msgs().filter((m) => m.type === 'peer_message_result');
  ok(await waitFor(() => N.meta()?.threadId === 'th-notif'), 'notif stub: the wrapper has a thread');
  N.send({ type: 'chat-input', text: 'long running work', msgId: 'n0' });
  ok(await waitFor(() => N.meta()?.activeTurnId === 'turn-1'), 'notif stub: a turn is running');

  // (1) EMPTY QUEUE — one steer, nothing queued
  N.send({ type: 'peer-message', text: NOTIF_TEXT, fromName: 'Background Work · nightly', kind: 'notification' });
  ok(await waitFor(() => peerResults().length === 1), 'the notification is answered', JSON.stringify(peerResults()));
  ok(peerResults()[0].ok === true && peerResults()[0].mode === 'steered', `…with mode 'steered' (${JSON.stringify(peerResults()[0])})`);
  {
    const st = N.rpc().filter((m) => m.method === 'turn/steer');
    ok(st.length === 1 && st[0].params.expectedTurnId === 'turn-1' && JSON.stringify(st[0].params.input) === JSON.stringify([{ type: 'text', text: NOTIF_TEXT }]),
      `EXACTLY ONE turn/steer, on the running turn, carrying only the notification (${JSON.stringify(st.map((m) => m.params))})`);
    ok(!N.rpc().some((m) => m.method === 'thread/queue/add'), 'and ZERO thread/queue/add — a notification never becomes a turn of its own', JSON.stringify(N.rpc().map((m) => m.method)));
    ok(N.lastQueue().length === 0, `the queue stays empty (${JSON.stringify(N.lastQueue())})`);
  }

  // (2) THREE QUEUED ITEMS — the steer must not touch them (negative control
  // for the "carry the queue with it" variant: that one deletes what it sends)
  for (const n of [1, 2, 3]) N.send({ type: 'chat-input', text: `queued ${n}`, msgId: `n${n}` });
  ok(await waitFor(() => N.lastQueue().length === 3), `three messages queued behind the turn (${JSON.stringify(N.lastQueue().map((i) => i.preview))})`);
  const idsBefore = N.lastQueue().map((i) => i.id).join(',');
  const previewsBefore = N.lastQueue().map((i) => i.preview).join('|');
  const steersBefore = N.rpc().filter((m) => m.method === 'turn/steer').length;
  const delsBefore = N.rpc().filter((m) => m.method === 'thread/queue/delete').length;
  const addsBefore = N.rpc().filter((m) => m.method === 'thread/queue/add').length;
  N.send({ type: 'peer-message', text: '[VibeSpace Background Work] task "hourly" (job-2): failed.', fromName: 'Background Work · hourly', kind: 'notification' });
  ok(await waitFor(() => peerResults().length === 2), 'the second notification is answered');
  ok(peerResults()[1].mode === 'steered', `…also steered, with a non-empty queue (${JSON.stringify(peerResults()[1])})`);
  ok(N.rpc().filter((m) => m.method === 'turn/steer').length === steersBefore + 1, 'exactly ONE more turn/steer (never one per queued item)');
  ok(N.rpc().filter((m) => m.method === 'thread/queue/delete').length === delsBefore, 'ZERO thread/queue/delete — the steer carried only itself, so nothing had to be dequeued', String(N.rpc().filter((m) => m.method === 'thread/queue/delete').length - delsBefore));
  ok(N.rpc().filter((m) => m.method === 'thread/queue/add').length === addsBefore, 'ZERO thread/queue/add for the notification');
  ok(N.lastQueue().map((i) => i.id).join(',') === idsBefore && N.lastQueue().map((i) => i.preview).join('|') === previewsBefore,
    `the three queued messages are all still there, in the same ORDER (${JSON.stringify(N.lastQueue().map((i) => i.preview))})`);
  {
    const st = N.rpc().filter((m) => m.method === 'turn/steer').slice(-1)[0];
    ok(!JSON.stringify(st.params.input).includes('queued 1'), 'and the steer body carries no queued item', JSON.stringify(st.params.input));
  }

  // (3) A HUMAN PEER MESSAGE queues, exactly as before — including an UNTYPED
  // frame (an older server that does not send `kind` at all).
  N.send({ type: 'peer-message', text: 'Message from session "B" (via vibespace-msg): can you look at X?', fromName: 'session B', kind: 'peer' });
  ok(await waitFor(() => N.lastQueue().length === 4), `a human peer message QUEUES (${JSON.stringify(N.lastQueue().map((i) => i.kind))})`);
  ok(peerResults().slice(-1)[0].mode === 'queued', `…and reports mode 'queued' (${JSON.stringify(peerResults().slice(-1)[0])})`);
  ok(N.rpc().filter((m) => m.method === 'turn/steer').length === steersBefore + 1, "no steer for a human message — a person's message is its own turn");
  N.send({ type: 'peer-message', text: 'Message from session "C" (via vibespace-msg): untyped frame', fromName: 'session C' });
  ok(await waitFor(() => N.lastQueue().length === 5), 'an UNTYPED frame (older server) queues too — unknown origin takes the conservative lane');
  ok(peerResults().slice(-1)[0].mode === 'queued', `…reported as queued (${JSON.stringify(peerResults().slice(-1)[0])})`);

  // (4) THE NORMALIZER: the steered notification is a LABELLED peer card, live
  // and on a rebuild from the same records (one card, never a "You" bubble).
  {
    const live = new CodexMessageManager('p2-notif-live'); const liveOps = [];
    live.onOp((o) => liveOps.push(o));
    for (const r of N.events()) live.processLive(r);
    const card = live.messages.filter((m) => m.originKind === 'peer-message' && JSON.stringify(m.content).includes('nightly'));
    ok(card.length === 1 && card[0].role === 'user' && card[0].peerFrom === 'Background Work · nightly',
      `LIVE: the steered notification renders as ONE labelled peer card (${JSON.stringify(card.map((m) => [m.originKind, m.peerFrom]))})`);
    ok(liveOps.some((o) => o.op === 'create' && o.message?.id === card[0]?.id), '…delivered to open windows through the normal create op');
    const rebuilt = new CodexMessageManager('p2-notif-rebuild');
    rebuilt.convertHistory(N.events());
    const rcard = rebuilt.messages.filter((m) => m.originKind === 'peer-message' && JSON.stringify(m.content).includes('nightly'));
    ok(rcard.length === 1 && rcard[0].peerFrom === 'Background Work · nightly',
      `REBUILD: the same record replays to the same ONE card (${JSON.stringify(rcard.map((m) => m.peerFrom))})`);
    // A steered message ends up in codex's OWN rollout too (the app-server
    // records the user input it was handed), so on the next attach the buffer
    // copy and the rollout copy are twins. They collapse at the REAL seam —
    // mergeCodexRecords' fingerprint, which strips the wrapper's webui_peer
    // marker exactly so these two are the same record. Feed it both.
    {
      const { mergeCodexRecords } = require(path.join(REPO, 'src/codex-session-store.js'));
      const ours = N.events().filter((e) => e.type === 'response_item' && JSON.stringify(e.payload?.webui_peer || {}).includes('nightly'));
      const rolloutTwin = { timestamp: ours[0].timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: NOTIF_TEXT }], id: 'item-rollout-1' } };
      const merged = mergeCodexRecords([rolloutTwin], JSON.parse(JSON.stringify(ours)));
      ok(ours.length === 1 && merged.length === 1, `the buffer copy and codex's rollout copy of the steered message are ONE record after the merge (${merged.length})`, JSON.stringify(merged));
      const both = new CodexMessageManager('p2-notif-merged');
      both.convertHistory(merged);
      const cards = both.messages.filter((m) => JSON.stringify(m.content).includes('nightly'));
      ok(cards.length === 1 && cards[0].originKind === 'peer-message' && cards[0].peerFrom === 'Background Work · nightly',
        `…so a re-attach renders ONE labelled card, not a doubled bubble (${JSON.stringify(cards.map((m) => [m.originKind, m.peerFrom]))})`);
      // …and the marker-less rollout copy ALONE still reads as a notification
      // (the server frame shape is the fallback carrier on a buffer-less rebuild)
      const roll = new CodexMessageManager('p2-notif-rollout');
      roll.convertHistory([rolloutTwin]);
      ok(roll.messages[0]?.originKind === 'peer-message', 'the frame text alone still reads as a notification on a marker-less rebuild', roll.messages[0]?.originKind);
    }
  }

  // (5) XSS: a notification's text and its LABEL are peer-controlled and sync
  // to every client — they must reach the renderer as DATA, never as markup.
  {
    const evil = '<img src=x onerror="alert(1)">';
    N.send({ type: 'peer-message', text: `[VibeSpace Background Work] task "${evil}" (job-3): done.`, fromName: `Background Work · ${evil}`, kind: 'notification' });
    ok(await waitFor(() => N.events().some((e) => e.type === 'response_item' && JSON.stringify(e.payload?.webui_peer || {}).includes('onerror'))), 'the hostile label reaches the record verbatim (the wrapper builds no HTML)');
    const mmx = new CodexMessageManager('p2-notif-xss');
    mmx.convertHistory(N.events());
    const bad = mmx.messages.find((m) => m.originKind === 'peer-message' && String(m.peerFrom || '').includes('onerror'));
    ok(bad && bad.peerFrom === `Background Work · ${evil}` && bad.content[0].text.includes(evil) && !JSON.stringify(bad).includes('<span'),
      'the normalizer carries text and label as DATA — no markup is ever built here', JSON.stringify(bad && [bad.peerFrom, bad.content[0].text]).slice(0, 200));
    const cr = fs.readFileSync(path.join(REPO, 'src/lib/chat-renderers.js'), 'utf8');
    ok(/const nameHtml = msg\.peerFrom[\s\S]{0,200}escHtml\(msg\.peerFrom\)/.test(cr), 'renderer pin: the peer/notification LABEL goes through escHtml before it enters innerHTML');
    ok(/<div class="chat-text">\$\{this\.renderMarkdown\(core\.trim\(\)\)\}<\/div>/.test(cr) && /renderMarkdown\(text\) \{[\s\S]{0,400}DOMPurify\.sanitize\(marked\.parse/.test(cr), 'renderer pin: the BODY goes through renderMarkdown, i.e. DOMPurify (the XSS law)');
  }
  N.stop();
}
{
  // (6) A REFUSED STEER FALLS BACK — and says so. Two shapes:
  //   (a) the turn ended between the check and the RPC ⇒ the message runs as
  //       its own turn (the idle lane), never lost.
  const E = spawnStub('notif-ended', STUB_NOTIF.replace(/__STEERMODE__/g, "'ended'"));
  const eRes = () => E.msgs().filter((m) => m.type === 'peer_message_result');
  ok(await waitFor(() => E.meta()?.threadId === 'th-notif'), 'ended-race stub: the wrapper has a thread');
  E.send({ type: 'chat-input', text: 'work', msgId: 'e0' });
  ok(await waitFor(() => E.meta()?.activeTurnId === 'turn-1'), 'ended-race stub: a turn is running');
  const startsBeforeE = E.rpc().filter((m) => m.method === 'turn/start').length;
  E.send({ type: 'peer-message', text: NOTIF_TEXT, fromName: 'Background Work · nightly', kind: 'notification' });
  ok(await waitFor(() => eRes().length === 1), 'the notification is answered even though the steer was refused', JSON.stringify(eRes()));
  ok(eRes()[0].ok === true && eRes()[0].mode === 'turn' && eRes()[0].steerFailed === 'no-active-turn',
    `…the turn ended mid-flight ⇒ it runs as its OWN turn and the result NAMES the refused steer (${JSON.stringify(eRes()[0])})`);
  ok(E.rpc().filter((m) => m.method === 'turn/start').length === startsBeforeE + 1, 'exactly one turn/start for the fallen-back notification');
  ok(E.events().some((e) => e.type === 'response_item' && JSON.stringify(e.payload?.webui_peer || {}).includes('nightly')), 'the message is recorded on the fallback path too (the card still renders)');
  E.stop();
}
{
  //   (b) a turn that CANNOT be steered (review/compact) ⇒ it queues, and the
  //       result names the refusal instead of silently looking like a normal
  //       queue decision.
  const R = spawnStub('notif-review', STUB_NOTIF.replace(/__STEERMODE__/g, "'review'"));
  const rRes = () => R.msgs().filter((m) => m.type === 'peer_message_result');
  ok(await waitFor(() => R.meta()?.threadId === 'th-notif'), 'unsteerable stub: the wrapper has a thread');
  R.send({ type: 'chat-input', text: 'work', msgId: 'r0' });
  ok(await waitFor(() => R.meta()?.activeTurnId === 'turn-1'), 'unsteerable stub: a turn is running');
  R.send({ type: 'peer-message', text: NOTIF_TEXT, fromName: 'Background Work · nightly', kind: 'notification' });
  ok(await waitFor(() => rRes().length === 1), 'the notification is answered');
  ok(rRes()[0].ok === true && rRes()[0].mode === 'queued' && rRes()[0].steerFailed === 'not-steerable' && /review/.test(rRes()[0].steerDetail || ''),
    `an unsteerable turn ⇒ QUEUED, with the refusal named and the server's own words kept (${JSON.stringify(rRes()[0])})`);
  ok(await waitFor(() => R.lastQueue().some((i) => i.kind === 'peer')), 'and the message really is in the queue (nothing was lost)', JSON.stringify(R.lastQueue()));
  ok(R.rpc().filter((m) => m.method === 'turn/steer').length === 1, 'the refused steer is tried ONCE, never retried in a loop');
  R.stop();
}
// wrapper pins for the rule (the 2.355.0 unstaged-wiring lesson: a behaviour
// with no call-site pin can be reverted by an extraction and stay green)
ok(/const peerKind = msg\.kind === 'notification' \? 'notification' : 'peer';/.test(wsrc), "wrapper pin: the frame's typed origin decides the lane, and an untyped frame is a PEER");
ok(/if \(peerKind === 'notification' && meta\.activeTurnId\) \{[\s\S]{0,200}?await steerInput\(encodeUserInput\(text, \[\]\), /.test(wsrc), 'wrapper pin: a notification on a busy session takes the steer lane');
ok(/async function steerInput\(input, clientUserMessageId\) \{[\s\S]{0,400}?await request\('turn\/steer'/.test(wsrc) && /steerInput\(item\.input, cid\)/.test(wsrc), 'wrapper pin: ONE turn/steer call site (steerInput), shared by the queue verb and the notification lane');
ok(!/steerInput[\s\S]{0,300}queue\/list/.test(wsrc) && /input,\n\s*expectedTurnId: meta\.activeTurnId,/.test(wsrc), "wrapper pin: steerInput sends the caller's input and nothing else — it never reads or writes the queue");
ok(/mode: 'steered'/.test(wsrc) && /steerFailed: steerFailed\.reason/.test(wsrc), 'wrapper pin: the result reports the lane, and a fallback names the refused steer');

try { w.kill('SIGTERM'); } catch {}
await sleep(300);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
