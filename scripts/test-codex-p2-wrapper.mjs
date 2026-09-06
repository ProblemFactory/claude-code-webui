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
let b = ''; let turns = 0;
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
      turns++; const tid = 'turn-' + turns;
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
        send({ method: 'item/completed', params: { item: { type: 'imageView', id: 'img-1', path: '/tmp/shot.png' } } });
        // per-response usage (v2 camelCase shape, as the real app-server sends it) — the wrapper relays it as a token_count
        send({ method: 'thread/tokenUsage/updated', params: { threadId: 'th-p2', turnId: tid, tokenUsage: { total: { totalTokens: 5150, inputTokens: 5000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 150, reasoningOutputTokens: 40 }, last: { totalTokens: 5150, inputTokens: 5000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 150, reasoningOutputTokens: 40 }, modelContextWindow: 828400 } } });
      }
      continue;
    }
    if (m.method === 'thread/queue/add') { send({ id: m.id, result: {} }); continue; }
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

// ② second input while the turn is active → queued, never a second turn/start
sendLine({ type: 'chat-input', text: 'second', msgId: 'm2' });
ok(await waitFor(() => rpc().some((m) => m.method === 'thread/queue/add')), 'a chat-input during an ACTIVE turn goes to thread/queue/add');
const qa = rpc().find((m) => m.method === 'thread/queue/add');
ok(qa && qa.params.threadId === 'th-p2' && JSON.stringify(qa.params.input).includes('second') && qa.params.clientUserMessageId === 'm2', 'queue/add carries the thread, the encoded input and the client message id');
ok(rpc().filter((m) => m.method === 'turn/start').length === 1, 'no second turn/start (the old path steered/rejected)');
ok(await waitFor(() => events().some((e) => e.type === 'event_msg' && e.payload?.type === 'queued_input' && e.payload.msg_id === 'm2')), 'a queued_input event tells the client the message is queued');
{ const users = bufRecords().filter((r) => r.type === 'response_item' && r.payload?.role === 'user').map((r) => JSON.stringify(r.payload.content)); ok(users.some((u) => /first/.test(u)) && users.some((u) => /second/.test(u)), 'both user messages are recorded (the bubble renders either way)'); }

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
  ok(searches.length === 1 && searches[0].status === 'complete' && b?.input?.query === 'vibespace acp' && b?.input?.action?.queries?.length === 2, `the webSearch item is ONE complete card with the final query/action (${searches.length} cards; input ${JSON.stringify(b?.input)})`);
  ok(b && b.output === 'ACP <b>spec</b> — https://example.org/acp\nAgent Client Protocol overview', `…and a human result list, not raw JSON: ${JSON.stringify(b?.output)}`);
}
const sys = mm.messages.filter((m) => m.role === 'system').map((m) => m.content?.[0]?.text || '');
ok(sys.some((t) => /Queued — runs after the current turn/.test(t)), 'the queued notice renders as a system card');
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
ok(/if \(meta\.threadId && meta\.activeTurnId\) \{\s*await request\('thread\/queue\/add'/.test(wsrc), 'wrapper pin: chat-input queues on an active turn');
ok(/thread\/compact\/start/.test(wsrc) && /applySlashCommand\(text\)/.test(wsrc), 'wrapper pin: slash commands + real compact');
const cm = fs.readFileSync(path.join(REPO, 'src/codex-message-manager.js'), 'utf8');
ok(/this\._status\.slashCommands \|\| \[\]/.test(cm) && !/slashCommands: \[\],/.test(cm), 'normalizer pin: init slashCommands come from wrapper_meta (no hardcoded empty list left)');

try { w.kill('SIGTERM'); } catch {}
await sleep(300);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
