#!/usr/bin/env node
// Codex feature-completeness pins (2.368.15, owner audit of a real session):
// a 582-record rollout normalized into a view with 52 tool cards stuck
// "pending" forever (custom_tool_call_output was NEVER ROUTED — only the
// function_call twin was), invisible sub-agents, and a live status bar that
// could not show context% until re-attach. Shapes below are verbatim from
// the real rollout (ids sanitized).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = await import('node:path');
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { CodexMessageManager } = require(REPO + '/src/codex-message-manager.js');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };

// ── custom_tool_call + its output twin (the stuck-card fix) ──
{
  const mm = new CodexMessageManager('t1');
  const msgs = mm.convertHistory([
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_A', name: 'shell', input: '{"command":"vibespace-status done"}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_A', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: 'status set: done\n' }] } },
  ]);
  const tool = msgs.find((m) => m.role === 'tool');
  ok('custom_tool_call_output is ROUTED (52 cards stuck pending in one real session)', tool && tool.status === 'complete', JSON.stringify(tool?.status));
  ok('array-of-blocks output is flattened to text, not a JSON blob', tool?.content?.[0]?.output === 'Script completed\nstatus set: done\n', JSON.stringify(tool?.content?.[0]?.output));
}

// ── sub-agent visibility (Codex sub-agent threads, 2026-08 CLI) ──
{
  const mm = new CodexMessageManager('t2');
  const msgs = mm.convertHistory([
    { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'call_B', occurred_at_ms: 1, agent_thread_id: '01a0338e-79d3-7820-a298-b119d4ec5bb3', agent_path: '/root/paper_analysis', kind: 'started' } },
    { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'call_B', occurred_at_ms: 2, agent_thread_id: '01a0338e-79d3-7820-a298-b119d4ec5bb3', agent_path: '/root/paper_analysis', kind: 'interacted' } },
  ]);
  // B-21e4 item 2: the announcement is a COMPLETE tool card in the 'agent' fold
  // kind (a system line split every surrounding run), never a task chip
  const lines = msgs.filter((m) => m.role === 'tool' && m.toolName === 'Sub-agent');
  ok('a sub-agent spawn is announced (it was fully invisible)', lines.length === 1 && /paper_analysis/.test(JSON.stringify(lines[0].content)) && lines[0].collapseKind === 'agent' && lines[0].status === 'complete');
  ok("'interacted' churn does not spam extra lines", lines.length === 1 && !msgs.some((m) => m.role === 'system'));
}

// ── live context%: contextWindow rides the usage meta ──
{
  const mm = new CodexMessageManager('t3');
  const metas = [];
  mm.onOp((op) => { if (op.op === 'meta' && op.subtype === 'usage') metas.push(op.data); });
  mm.processLive({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 16371, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 125, reasoning_output_tokens: 104, total_tokens: 16496 }, last_token_usage: { input_tokens: 16371, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 125, reasoning_output_tokens: 104, total_tokens: 16496 }, model_context_window: 828400 } } });
  ok('usage meta carries contextWindow (live context% showed "?" until re-attach)', metas.length === 1 && metas[0].contextWindow === 828400, JSON.stringify(metas[0]));
  const sb = require('node:fs').readFileSync(REPO + '/src/lib/chat-status-bar.js', 'utf8');
  ok('…and the status bar consumes it in updateUsage', /updateUsage\(usageData\)[\s\S]{0,600}u\.contextWindow\) this\._statusContextWindow = u\.contextWindow/.test(sb));
}

// ── encrypted reasoning: silently absent, never a broken card ──
{
  const mm = new CodexMessageManager('t4');
  const msgs = mm.convertHistory([
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAA…' } },
  ]);
  ok('encrypted reasoning (no summary) yields no message — upstream withholds the text; a blank thinking card would read as a bug', msgs.length === 0, JSON.stringify(msgs));
}

// ── interleaved concurrent message streams (owner's "不是人话" fragments) ──
// Real buffer shape: collab/sub-agent turns stream TWO message items delta-by-
// delta ("…464ab10d" and "…73147228" alternating per character). Finalizing
// every open stream on each key switch chopped both messages into per-run
// fragments ("断 AA 边", "缘小", " 1440、1024" — verbatim from the report).
{
  const mm = new CodexMessageManager('t5');
  const D = (id, delta) => ({ type: 'event_msg', payload: { type: 'agent_message_delta', item_id: id, delta } });
  const seq = [D('A', '推'), D('A', '断'), D('B', '最终'), D('A', ' AA'), D('A', ' 边'), D('B', '审'), D('B', '计'), D('A', '界')];
  for (const r of seq) mm.processLive(r, false);
  const asst = mm.messages.filter((m) => m.role === 'assistant');
  ok('interleaved deltas accumulate into exactly TWO streams, not per-run fragments', asst.length === 2, JSON.stringify(asst.map((m) => m.content[0].text)));
  ok('…each stream reads as continuous text', asst.some((m) => m.content[0].text === '推断 AA 边界') && asst.some((m) => m.content[0].text === '最终审计'), JSON.stringify(asst.map((m) => m.content[0].text)));
  // the full response_item still finalizes ITS stream by key
  mm.processLive({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'A', content: [{ type: 'output_text', text: '推断 AA 边界(定稿)' }] } }, false);
  const a = mm.messages.filter((m) => m.role === 'assistant').find((m) => /定稿/.test(m.content[0].text));
  ok('the finalizing response_item replaces its OWN stream in place (no duplicate)', a && a.status === 'complete' && mm.messages.filter((m) => m.role === 'assistant').length === 2);
}

// ── the account surfaces name the ChatGPT login, never the claude CLI's ──
{
  const fs2 = require('node:fs');
  const sl = fs2.readFileSync(REPO + '/src/lib/session-lifecycle.js', 'utf8');
  ok("billing switcher's global row is backend-aware (ChatGPT login for codex)", /isCodex \? t\('ChatGPT login'\) : t\('CLI login'\)/.test(sl));
  // 2.369.21: the codex row shows the CODEX quota (__global_codex__), never the claude machine quota
  ok('…and the CLAUDE machine quota chips never dress the codex row (it shows the codex quota instead)', /isCodex \? \(rHostId \? '' : usageHint\(this\._codexAccountUsage\?\.__global_codex__, this\._usageEstimates\?\.__global_codex__\)\) : usageHint\(rHostId \? this\._hostOwnUsage/.test(sl));
  const sb = fs2.readFileSync(REPO + '/src/lib/chat-status-bar.js', 'utf8');
  ok('status-bar billing chip is backend-aware too', /this\._backend === 'codex' \? t\('ChatGPT login'\) : t\('CLI login'\)/.test(sb));
}

// ── Track B: semantic collapse kinds (owner: codex的exec卡片/agent wait/send
// message等没有参与折叠) — the normalizer stamps collapseKind so the chat
// view's folding never needs backend tool names.
{
  const mm = new CodexMessageManager('t6');
  const msgs = mm.convertHistory([
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'c1', call_id: 'k1', name: 'exec', input: '{"command":["bash","-lc","ls"]}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'o1', call_id: 'k1', output: [{ type: 'input_text', text: 'ok' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'c2', call_id: 'k2', name: 'wait_agent', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call', id: 'c3', call_id: 'k3', name: 'send_message', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'c4', call_id: 'k4', name: 'apply_patch', input: '*** patch' } },
  ]);
  const kinds = Object.fromEntries(msgs.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.collapseKind]));
  ok("exec stamps 'bash' (the 0.149.x bare name — even formatToolName's exec_command mapping missed it)", kinds.k1 === 'bash', JSON.stringify(kinds));
  ok("collab family stamps 'agent' (wait_agent / send_message)", kinds.k2 === 'agent' && kinds.k3 === 'agent');
  ok("apply_patch stamps 'write'", kinds.k4 === 'write');
  ok("…and exec now also gets the Bash display name", msgs.find((m) => m.toolCallId === 'k1')?.toolName === 'Bash');
  const cv = require('node:fs').readFileSync(REPO + '/src/lib/chat-view.js', 'utf8');
  ok('the chat-view classifier consumes the semantic hint FIRST (name map = legacy fallback)', /const ck = m\?\.collapseKind;[\s\S]{0,220}return ck;/.test(cv));
  ok("claude Agent/Task cards join the 'agent' kind via the fallback map", /tn === 'Agent' \|\| tn === 'Task'\) return 'agent'/.test(cv));
  const ss = require('node:fs').readFileSync(REPO + '/src/lib/settings-schema.js', 'utf8');
  ok("the settings checkboxes are SEMANTIC (one global set; 'agent' kind exists and defaults on)", /value: 'agent', label: t\('Sub-agent orchestration/.test(ss) && /'skill', 'agent', 'search', 'image'\]/.test(ss));
  ok('per-backend fallback model list lives on BACKEND_META (codex never lists claude models offline)', /fallbackModels: \['gpt-/.test(require('node:fs').readFileSync(REPO + '/src/lib/agent-meta.js', 'utf8')) && /getBackendMeta\(backend\)\?\.fallbackModels/.test(require('node:fs').readFileSync(REPO + '/src/lib/chat-status-bar.js', 'utf8')));
}

// ── apply_patch file names (owner: "codex里的writes和read似乎不展示文件名") —
// the patch envelope is the only place the touched paths live.
{
  const mm = new CodexMessageManager('t7');
  const patch = '*** Begin Patch\n*** Update File: src/app/views.js\n@@\n-a\n+b\n*** Add File: docs/report.md\n+hello\n*** End Patch';
  const msgs = mm.convertHistory([
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'c1', call_id: 'k1', name: 'apply_patch', input: patch } },
  ]);
  const inp = msgs.find((m) => m.role === 'tool')?.content?.[0]?.input || {};
  ok('patch envelope files are parsed into input.files (+file_path)', Array.isArray(inp.files) && inp.files.join(',') === 'src/app/views.js,docs/report.md' && inp.file_path === 'src/app/views.js', JSON.stringify(inp.files));
  // the LIVE channel's shape (real buffer record): apply_patch arrives as a
  // FUNCTION_CALL whose arguments are structured JSON {reason, changes} — the
  // first fix parsed only the custom_tool_call envelope and live sessions
  // still showed no file names (owner re-report; fixture-not-from-real-data
  // twice in one feature).
  const mm2 = new CodexMessageManager('t7b');
  const msgs2 = mm2.convertHistory([
    { type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'kf1', name: 'apply_patch', arguments: JSON.stringify({ reason: '', changes: [{ path: '/home/u/services/app/src/views.js', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' }] }) } },
  ]);
  const inp2 = msgs2.find((m) => m.role === 'tool')?.content?.[0]?.input || {};
  ok('function_call JSON {changes[].path} shape yields files + a synthesized patch text', inp2.files?.[0] === '/home/u/services/app/src/views.js' && /\*\*\* Update File: \/home\/u\/services\/app\/src\/views\.js/.test(inp2.patch || ''), JSON.stringify({ files: inp2.files, head: (inp2.patch || '').slice(0, 40) }));
  ok("…and the card stamps collapseKind 'write' via the function_call path too", msgs2.find((m) => m.role === 'tool')?.collapseKind === 'write');
  // unknown external/dynamic tools fold as 'mcp' instead of BREAKING runs
  const mm3 = new CodexMessageManager('t7c');
  const msgs3 = mm3.convertHistory([
    { type: 'response_item', payload: { type: 'function_call', id: 'f2', call_id: 'kf2', name: 'browser_console_read', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'dynamic_tool_call', id: 'd1', call_id: 'kd1', name: 'some_plugin_tool', input: '{}' } },
    { type: 'response_item', payload: { type: 'dynamic_tool_call_output', id: 'd2', call_id: 'kd1', output: [{ type: 'input_text', text: 'done' }] } },
  ]);
  ok("unknown tool names classify as 'mcp' (external-tool kind) — they used to break every surrounding fold", msgs3.filter((m) => m.role === 'tool').every((m) => m.collapseKind === 'mcp'), JSON.stringify(msgs3.map((m) => m.collapseKind)));
  ok('dynamic_tool_call/output are routed like custom tools (were unrouted)', msgs3.find((m) => m.toolCallId === 'kd1')?.status === 'complete');
  ok('the pre-agent-kind settings migration exists in the registry', /2026-08-collapse-kinds-agent-default/.test(require('node:fs').readFileSync(REPO + '/src/server/migrations.js', 'utf8')));
  const cv = require('node:fs').readFileSync(REPO + '/src/lib/chat-view.js', 'utf8');
  ok('fold summaries list ALL of a patch\'s files (fileLabelsOf over input.files)', /fileLabelsOf = \(el\)[\s\S]{0,300}Array\.isArray\(inp\.files\)/.test(cv) && /for \(const fl of fileLabelsOf\(el\)\)/.test(cv));
  ok('…and the ✎ write mark keys on the semantic hint too', /el\._rawMsg\?\.collapseKind === 'write' \|\| tn === 'Write'/.test(cv));
}

// ── Per-message metadata (owner 2026-09-06: "codex会话是不是依然看不到每条消息的
// 详细信息、计费账号、使用模型") — the popup showed Role/Time/uuid only because
// _create threaded no meta. Fixture = the head of a REAL 0.153.4 rollout
// (paths/ids anonymised, numbers verbatim): codex stamps usage per RESPONSE
// (items → token_usage_record → tool outputs → token_count), never per item.
{
  const fs = require('node:fs'), os = require('node:os');
  const TID = '01a07386-3386-7203-adfb-7c4ba193e24d';
  const R = (type, payload, ts) => ({ timestamp: ts || '2026-09-05T21:42:49.991Z', type, payload });
  const U = (input, cached, output, reasoning, total) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total });
  const rollout = [
    R('session_meta', { id: TID, timestamp: '2026-09-05T21:42:49.990Z', cwd: '/home/u/proj', originator: 'claude-code-webui', cli_version: '0.153.4' }),
    R('turn_context', { turn_id: 'turn-A', cwd: '/home/u/proj', approval_policy: 'never', model: 'gpt-6-astra', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-astra', reasoning_effort: 'ultra' } }, multi_agent_version: 'v2', effort: 'ultra', summary: 'auto' }),
    R('response_item', { type: 'message', id: 'msg_u1', role: 'user', content: [{ type: 'input_text', text: 'review the site' }] }),
    R('event_msg', { type: 'task_started', turn_id: 'turn-A', model_context_window: 828400 }),
    // real 0.153 reasoning is encrypted (no card); a summary is given here so a thinking card EXISTS to carry meta
    R('response_item', { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Reading the files first' }] }),
    R('response_item', { type: 'function_call', id: 'fc_1', name: 'send_message', namespace: 'collaboration', arguments: '{"target":"/root","message":"…"}', call_id: 'call_A' }),
    R('token_usage_record', { thread_id: TID, turn_id: 'turn-A', session_id: TID, root_turn_id: 'turn-A', response_id: 'resp_A', usage: U(29940, 28416, 119, 0, 30059), turn_token_usage: U(29940, 28416, 119, 0, 30059), thread_token_usage: U(29940, 28416, 119, 0, 30059) }, '2026-09-05T21:42:56.678Z'),
    R('response_item', { type: 'function_call_output', id: 'fco_1', call_id: 'call_A', output: '' }, '2026-09-05T21:42:56.679Z'),
    R('event_msg', { type: 'token_count', info: { total_token_usage: U(29940, 28416, 119, 0, 30059), last_token_usage: U(29940, 28416, 119, 0, 30059), model_context_window: 828400 }, rate_limits: { limit_id: 'codex', primary: { used_percent: 12.0, window_minutes: 10080, resets_at: 1789224035 }, plan_type: 'pro' } }, '2026-09-05T21:42:56.680Z'),
    R('response_item', { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_B', name: 'exec', input: 'const results=await Promise.allSettled([tools.exec_command({cmd:"cat package.json"})]);' }, '2026-09-05T21:43:03.826Z'),
    R('token_usage_record', { thread_id: TID, turn_id: 'turn-A', session_id: TID, root_turn_id: 'turn-A', response_id: 'resp_B', usage: U(30071, 29824, 188, 0, 30259), turn_token_usage: U(60011, 58240, 307, 0, 60318), thread_token_usage: U(60011, 58240, 307, 0, 60318) }, '2026-09-05T21:43:04.827Z'),
    R('response_item', { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_B', output: [{ type: 'input_text', text: 'Script completed\n' }] }, '2026-09-05T21:43:04.846Z'),
    R('event_msg', { type: 'token_count', info: { total_token_usage: U(60011, 58240, 307, 0, 60318), last_token_usage: U(30071, 29824, 188, 0, 30259), model_context_window: 828400 } }, '2026-09-05T21:43:04.847Z'),
    R('response_item', { type: 'message', id: 'msg_a1', role: 'assistant', content: [{ type: 'output_text', text: '只读审查完成。' }] }, '2026-09-05T22:15:16.482Z'),
    R('token_usage_record', { thread_id: TID, turn_id: 'turn-A', session_id: TID, root_turn_id: 'turn-A', response_id: 'resp_C', usage: U(117791, 117248, 267, 227, 118058), turn_token_usage: U(177802, 175488, 574, 227, 178376), thread_token_usage: U(177802, 175488, 574, 227, 178376) }, '2026-09-05T22:15:16.550Z'),
    R('event_msg', { type: 'token_count', info: { total_token_usage: U(177802, 175488, 574, 227, 178376), last_token_usage: U(117791, 117248, 267, 227, 118058), model_context_window: 828400 } }, '2026-09-05T22:15:16.551Z'),
    R('event_msg', { type: 'task_complete', turn_id: 'turn-A', last_agent_message: '只读审查完成。' }, '2026-09-05T22:15:16.554Z'),
  ];
  const mm = new CodexMessageManager('t8');
  const msgs = mm.convertHistory(rollout);
  const user = msgs.find((m) => m.role === 'user');
  const think = msgs.find((m) => m.role === 'assistant' && m.content[0]?.type === 'thinking');
  const callA = msgs.find((m) => m.toolCallId === 'call_A');
  const callB = msgs.find((m) => m.toolCallId === 'call_B');
  const text = msgs.find((m) => m.role === 'assistant' && m.content[0]?.type === 'text');
  ok('history rebuild threads meta onto the FIRST response (thinking + tool card) with the ledger rid `cx:<thread>:<cumulative>` and the response id', think?.meta?.requestId === `cx:${TID}:30059` && callA?.meta?.requestId === `cx:${TID}:30059` && callA.meta.msgId === 'resp_A' && callA.meta.requestIdKind === 'ledger' && callA.meta.msgIdKind === 'response', JSON.stringify({ think: think?.meta, callA: callA?.meta }));
  ok('usage numbers mirror the ledger split (input = fresh = input − cached, cache read = cached, output, reasoning)', callA?.meta?.usage?.input_tokens === 29940 - 28416 && callA.meta.usage.cache_read_input_tokens === 28416 && callA.meta.usage.output_tokens === 119 && callA.meta.usage.reasoning_output_tokens === 0 && callA.meta.usage.cache_write_input_tokens === 0, JSON.stringify(callA?.meta?.usage));
  ok('model + effort ride the meta from the turn_context (gpt-6-astra / ultra)', callA?.meta?.model === 'gpt-6-astra' && callA.meta.effort === 'ultra');
  ok('the SECOND response (a tool card whose output arrived between token_usage_record and token_count) gets ITS OWN meta — the first is not overwritten', callB?.meta?.requestId === `cx:${TID}:60318` && callB.meta.msgId === 'resp_B' && callB.meta.usage.input_tokens === 30071 - 29824 && callB.meta.usage.output_tokens === 188 && callA.meta.msgId === 'resp_A', JSON.stringify(callB?.meta));
  ok('the final assistant text carries the third response (reasoning tokens 227 of 267 output)', text?.meta?.requestId === `cx:${TID}:178376` && text.meta.msgId === 'resp_C' && text.meta.usage.reasoning_output_tokens === 227 && text.meta.usage.output_tokens === 267, JSON.stringify(text?.meta));
  ok('user records carry no meta (a response usage never belongs to the prompt)', user && user.meta == null);

  // THE JOIN: the meta's requestId must equal the rid the ledger walker mints
  // for the SAME rollout (the key baked into every already-scanned ledger) and
  // its msgId the walker's mid — else the billing row can never resolve.
  const { runUsageWalk } = require(REPO + '/src/usage-walker.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxmeta-'));
  const cxDir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(cxDir, { recursive: true });
  fs.writeFileSync(path.join(cxDir, `rollout-2026-09-05T14-42-49-${TID}.jsonl`), rollout.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const walk = runUsageWalk({ home, codexSessionsDir: path.join(home, '.codex', 'sessions'), cursorFile: path.join(home, 'cursor.json') });
  const evs = walk.events.map((l) => JSON.parse(l));
  ok('the ledger walker emits exactly the three responses with UNCHANGED rids (the dedup key already in permanent ledgers)', evs.length === 3 && evs.map((e) => e.rid).join(',') === [30059, 60318, 178376].map((n) => `cx:${TID}:${n}`).join(','), evs.map((e) => e.rid).join(','));
  ok('normalizer requestId === walker rid, normalizer msgId === walker mid, for every response', [callA, callB, text].every((m, i) => m.meta.requestId === evs[i].rid && m.meta.msgId === evs[i].mid) && evs.every((e) => e.effort === 'ultra' && e.model === 'gpt-6-astra'), JSON.stringify(evs.map((e) => [e.rid, e.mid, e.effort])));
  ok('walker fresh-input matches the meta (i = input − cached; cr = cached)', evs[0].i === callA.meta.usage.input_tokens && evs[0].cr === callA.meta.usage.cache_read_input_tokens && evs[2].o === text.meta.usage.output_tokens);
  fs.rmSync(home, { recursive: true, force: true });

  // LIVE stream: the wrapper relays thread/tokenUsage/updated as a token_count
  // whose inner objects keep the v2 camelCase (real live buffer shape); no
  // token_usage_record exists live (msgId null, honest) — the rid is derived
  // from wrapper_meta.threadId + total.totalTokens and the SAME 'edit' op
  // claude uses carries the meta to an open window.
  const live = new CodexMessageManager('t9'); const ops = []; live.onOp((o) => ops.push(o));
  live.processLive({ type: 'wrapper_meta', payload: { threadId: TID, model: 'gpt-6-astra', permissionMode: 'yolo' } });
  live.processLive({ type: 'turn_context', payload: { turn_id: 't-live', cwd: '/home/u/proj', model: 'gpt-6-astra', effort: 'xhigh', summary: 'none' } });
  live.processLive({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-live' } });
  live.processLive({ type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'it-1', delta: 'Hello' } });
  live.processLive({ type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'it-1', delta: ' world' } });
  live.processLive({ type: 'response_item', payload: { type: 'message', item_id: 'it-1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] } });
  live.processLive({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { totalTokens: 147473, inputTokens: 147168, cachedInputTokens: 144768, cacheWriteInputTokens: 0, outputTokens: 305, reasoningOutputTokens: 227 }, total_token_usage: { totalTokens: 3357139, inputTokens: 3319196, cachedInputTokens: 3205120, cacheWriteInputTokens: 0, outputTokens: 37943, reasoningOutputTokens: 8151 }, model_context_window: 828400 } } });
  const am = live.messages.find((m) => m.role === 'assistant');
  ok('live token_count (v2 camelCase) attaches meta to the streamed assistant message: ledger rid from wrapper_meta.threadId + cumulative totalTokens, fresh input, reasoning, effort', am?.meta?.requestId === `cx:${TID}:3357139` && am.meta.usage.input_tokens === 147168 - 144768 && am.meta.usage.reasoning_output_tokens === 227 && am.meta.usage.output_tokens === 305 && am.meta.effort === 'xhigh' && am.meta.model === 'gpt-6-astra', JSON.stringify(am?.meta));
  ok('no token_usage_record live ⇒ msgId is null (never an invented id), kind null', am?.meta?.msgId === null && am.meta.msgIdKind === null);
  const editOp = ops.find((o) => o.op === 'edit' && o.id === am?.id && o.fields?.meta);
  ok("the live path emits claude's 'edit' op with fields.meta so an open window's popup refreshes", !!editOp && editOp.fields.meta.requestId === `cx:${TID}:3357139`);
  ok('the init system card never gets response meta', live.messages.filter((m) => m.role === 'system').every((m) => m.meta == null));
  // a heartbeat token_count (info:null / empty usage) neither attaches nor advances anything
  live.processLive({ type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'it-2', delta: 'next' } });
  live.processLive({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 12 } } } });
  const am2 = live.messages.filter((m) => m.role === 'assistant')[1];
  ok('a rate-limit heartbeat token_count attaches nothing (the next real one will)', am2 && am2.meta == null);

  // WIRING PINS (the 2.355.0 lesson: a normalizer fix with no consumer is dead):
  const cv = fs.readFileSync(REPO + '/src/lib/chat-view.js', 'utf8');
  ok('popup labels the ledger key honestly + shows the response id, reasoning tokens, effort, codex cache write', /requestIdKind === 'ledger' \? t\('Ledger request key'\) : t\('Request ID'\)/.test(cv) && /msgIdKind === 'response' \? t\('Response ID'\) : t\('Message ID'\)/.test(cv) && /t\('Reasoning tokens'\)/.test(cv) && /if \(meta\.effort\) add\(t\('Effort'\)/.test(cv) && /\|\| \(u\.cache_write_input_tokens \|\| 0\)/.test(cv));
  ok("popup's session-level fallback reads the REAL auth shape (source: codex-subscription / codex-cli / pooled / subscription / api-*)", /a\.source === 'codex-subscription'/.test(cv) && /a\.source === 'codex-cli'/.test(cv) && /a\.source === 'pooled'/.test(cv) && !/a\.accountName \|\| \(a\.kind ===/.test(cv));
  ok('global-bucket billing row names the ChatGPT login for codex events (route returns be)', /r\.be === 'codex' \? t\('ChatGPT login'\) : t\('CLI login'\)/.test(cv) && /be: ev\.be \|\| 'claude', model: ev\.model \|\| null, effort: ev\.effort \|\| null/.test(fs.readFileSync(REPO + '/src/server/account-usage-routes.js', 'utf8')));
  for (const dict of ['i18n-zh.js', 'i18n-ja.js']) {
    const d = fs.readFileSync(REPO + '/src/lib/' + dict, 'utf8');
    ok(`${dict} carries the new popup keys`, ['"Reasoning tokens"', '"Ledger request key"', '"Response ID"'].every((k) => d.includes(k)));
  }
}


// ── THREAD ID = the rollout being rendered, never the parent's (adversarial
// verifier, real-data refutation of the first cut): a codex SUB-AGENT rollout
// carries its OWN session_meta at line 0 and the PARENT's at line 1 (11/79
// local rollouts, 2320/10251 messages); "last session_meta wins" keyed every
// meta.requestId `cx:<parent>:<cum>` — and 64 of those keys COLLIDED with real
// ledger events of the parent conversation, so the billing row named the
// wrong conversation's account. The ledger walker keys by the FILE's uuid
// (= the first session_meta; 79/79 local rollouts, incl. all 29 multi-meta
// ones). Fixture = the head of a real 0.149.1 sub-agent rollout, verbatim
// (paths/instructions anonymised; no token_usage_record exists in that file).
{
  const fs = require('node:fs'), os = require('node:os');
  const CHILD = '01a0338e-79d3-7820-a298-b119d4ec5bb3', PARENT = '01a0338c-b464-7ed3-8c11-bfa028cb0e2d';
  const TURN = '01a0338c-d448-7e50-ba61-6f1daff2402b';
  const TS = '2026-08-24T11:36:10.481Z';
  const R = (type, payload) => ({ timestamp: TS, type, payload });
  const BASE = { text: '[base instructions — trimmed]', provenance: { type: 'model', model: 'gpt-5.6-sol' } };
  const COLLAB = { mode: 'default', settings: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra', developer_instructions: null } };
  const turnCtx = (turn_id) => ({ turn_id, cwd: '/home/u', workspace_roots: ['/home/u'], current_date: '2026-08-24', timezone: 'UTC', approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' }, model: 'gpt-5.6-sol', comp_hash: '3000', personality: 'pragmatic', collaboration_mode: COLLAB, multi_agent_version: 'v2', realtime_active: false, effort: 'ultra', summary: 'auto' });
  const U16496 = { input_tokens: 16371, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 125, reasoning_output_tokens: 104, total_tokens: 16496 };
  const subagentHead = [
    R('session_meta', { session_id: PARENT, id: CHILD, forked_from_id: PARENT, parent_thread_id: PARENT, timestamp: '2026-08-24T11:36:10.451Z', cwd: '/home/u', originator: 'claude-code-webui', cli_version: '0.149.1', source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: '/root/paper_analysis', agent_nickname: 'Poincare', agent_role: null } } }, thread_source: 'subagent', agent_nickname: 'Poincare', agent_path: '/root/paper_analysis', model_provider: 'openai', base_instructions: BASE, history_mode: 'legacy', multi_agent_version: 'v2', context_window: { window_id: '01a0338e-79d3-7820-a298-b12d89fcc9fe' } }),
    R('session_meta', { session_id: PARENT, id: PARENT, timestamp: '2026-08-24T11:34:14.373Z', cwd: '/home/u', originator: 'claude-code-webui', cli_version: '0.149.1', source: 'vscode', model_provider: 'openai', base_instructions: BASE, history_mode: 'legacy', context_window: { window_id: '01a0338c-b464-7ed3-8c11-bfb930f54094' } }),
    R('response_item', { type: 'message', id: 'msg_01a0338c-d441-7903-b87e-fe719da45bcb', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills\n[trimmed]\n</skills_instructions>' }] }),
    R('response_item', { type: 'message', id: 'msg_01a0338c-d441-7903-b87e-fea476070d70', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\n[trimmed]\n</recommended_plugins>' }] }),
    R('world_state', { full: true, state: { agents_md: {}, apps_instructions: true, collaboration_mode: { mode: 'default', model: 'gpt-5.6-sol', instructions: 'dfd53114f5f6f9f5fd7816370d0bf2847806246d' }, environments: { environments: { local: { cwd: '/home/u', status: 'available', shell: 'zsh' } }, current_date: '2026-08-24', timezone: 'UTC' } } }),
    R('turn_context', turnCtx('auto-compact-1')),
    R('response_item', { type: 'message', id: 'msg_01a0338c-d446-7800-ac02-ca0e7dced051', role: 'developer', content: [{ type: 'input_text', text: '<vibespace-reminder>[trimmed]</vibespace-reminder>' }] }),
    R('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', approval_policy: 'never', approvals_reviewer: 'user', permission_profile: { type: 'disabled' }, cwd: '/home/u', reasoning_effort: 'ultra', personality: 'pragmatic', collaboration_mode: COLLAB } }),
    R('event_msg', { type: 'task_started', turn_id: TURN, started_at: 1787571262, model_context_window: 828400, collaboration_mode_kind: 'default' }),
    R('turn_context', turnCtx(TURN)),
    R('response_item', { type: 'message', id: 'msg_01a0338c-d500-7661-9b98-34472caf9c1a', role: 'user', content: [{ type: 'input_text', text: '你好' }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1787571262.720582 } }),
    R('event_msg', { type: 'user_message', message: '你好', images: [], local_images: [], audio: [], local_audio: [], text_elements: [] }),
    R('response_item', { type: 'message', id: 'msg_01a0338c-d502-7a11-8de6-a39523a740ed', role: 'developer', content: [{ type: 'input_text', text: '<vibespace-reminder>[trimmed]</vibespace-reminder>' }] }),
    R('event_msg', { type: 'agent_message', message: '你好！很高兴见到你，我随时可以帮忙。', phase: 'final_answer', memory_citation: null }),
    R('response_item', { type: 'message', id: 'msg_0809e1b195756599016a8c2c419a4087d0a3dbc4dedc9d851d', role: 'assistant', content: [{ type: 'output_text', text: '你好！很高兴见到你，我随时可以帮忙。' }], phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1787571263.046728 } }),
    R('event_msg', { type: 'token_count', info: { total_token_usage: U16496, last_token_usage: U16496, model_context_window: 828400 }, rate_limits: { limit_id: 'codex', limit_name: null, primary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1788175818 }, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, individual_limit: null, spend_control_reached: null, plan_type: 'pro', rate_limit_reached_type: null } }),
    R('event_msg', { type: 'task_complete', turn_id: TURN, last_agent_message: '你好！很高兴见到你，我随时可以帮忙。', started_at: 1787571262, completed_at: 1787571266, duration_ms: 3754, time_to_first_token_ms: 3083 }),
  ];
  const ridsOf = (msgs) => [...new Set(msgs.map((m) => m.meta?.requestId).filter(Boolean))];
  // bare replay of the file (what the corpus smoke below and the walker see)
  const bare = new CodexMessageManager('t10').convertHistory(subagentHead);
  const reply = bare.find((m) => m.role === 'assistant');
  ok('sub-agent rollout: the FIRST session_meta (the file\'s own id) keys every meta — the parent\'s line-1 session_meta never overwrites it (was cx:<parent>:…)', reply?.meta?.requestId === `cx:${CHILD}:16496` && ridsOf(bare).every((r) => r.startsWith(`cx:${CHILD}:`)), JSON.stringify(ridsOf(bare)));
  ok('…no token_usage_record in a 0.149 file ⇒ msgId null (never invented)', reply?.meta?.msgId === null && reply.meta.msgIdKind === null);
  // the walker keys the same file by its NAME uuid — the join must hold
  const { runUsageWalk } = require(REPO + '/src/usage-walker.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxsub-'));
  const cxDir = path.join(home, '.codex', 'sessions', '2026', '08', '24');
  fs.mkdirSync(cxDir, { recursive: true });
  fs.writeFileSync(path.join(cxDir, `rollout-2026-08-24T04-36-10-${CHILD}.jsonl`), subagentHead.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const evs = runUsageWalk({ home, codexSessionsDir: path.join(home, '.codex', 'sessions'), cursorFile: path.join(home, 'cursor.json') }).events.map((l) => JSON.parse(l));
  ok('walker rid for the sub-agent file === normalizer requestId (cx:<child>:16496, sid = the filename uuid)', evs.length === 1 && evs[0].rid === `cx:${CHILD}:16496` && evs[0].rid === reply?.meta?.requestId, JSON.stringify(evs.map((e) => e.rid)));
  fs.rmSync(home, { recursive: true, force: true });

  // The READER's thread id is preferred when the manager is constructed with
  // one: CodexSessionMessages prepends the fork ANCESTRY (parent session_meta
  // first, oldest → newest) before the thread's own records, and a gap slab
  // may hold no session_meta at all — only the constructor knows the file.
  const pinned = new CodexMessageManager('t10b', { threadId: CHILD }).convertHistory([
    R('session_meta', { session_id: PARENT, id: PARENT, timestamp: '2026-08-24T11:34:14.373Z', cwd: '/home/u', originator: 'claude-code-webui', cli_version: '0.149.1', source: 'vscode', model_provider: 'openai', base_instructions: BASE }), // prepended ancestry
    ...subagentHead,
  ]);
  ok('constructed with the reader\'s thread id: a PREPENDED fork-ancestry session_meta, the own one, the parent-provenance one — none re-points the key', ridsOf(pinned).length === 1 && ridsOf(pinned)[0] === `cx:${CHILD}:16496`, JSON.stringify(ridsOf(pinned)));
  const slab = new CodexMessageManager('t10c', { threadId: CHILD }).convertHistory(subagentHead.slice(9)); // gap slab: no session_meta in range
  ok('a gap slab (no session_meta in the line range) still keys by the constructor thread id', ridsOf(slab)[0] === `cx:${CHILD}:16496`, JSON.stringify(ridsOf(slab)));
  // precedence without a pin: first session_meta wins; wrapper_meta (the
  // wrapper's OWN live record — a mid-life thread/fork re-points the file it
  // writes) replaces; token_usage_record.thread_id only fills a void
  const prec = new CodexMessageManager('t10d');
  prec.processLive({ type: 'token_usage_record', payload: { thread_id: 'fill-only', response_id: 'resp_x', usage: { total_tokens: 1 } } }, false);
  ok('token_usage_record.thread_id fills an EMPTY thread id', prec._threadId === 'fill-only');
  const prec2 = new CodexMessageManager('t10e');
  prec2.processLive({ type: 'session_meta', payload: { id: 'first' } }, false);
  prec2.processLive({ type: 'session_meta', payload: { id: 'second' } }, false);
  prec2.processLive({ type: 'token_usage_record', payload: { thread_id: 'third', response_id: 'resp_x', usage: { total_tokens: 1 } } }, false);
  ok('first session_meta wins over later session_meta / token_usage_record thread ids', prec2._threadId === 'first');
  prec2.processLive({ type: 'wrapper_meta', payload: { threadId: 'live' } }, false);
  ok('wrapper_meta.threadId (the live wrapper\'s own record) replaces — the file currently being written', prec2._threadId === 'live');
  const pinnedLive = new CodexMessageManager('t10f', { threadId: 'pin' });
  pinnedLive.processLive({ type: 'session_meta', payload: { id: 'other2' } }, false);
  pinnedLive.processLive({ type: 'token_usage_record', payload: { thread_id: 'other3', response_id: 'resp_y', usage: { total_tokens: 1 } } }, false);
  ok('a constructor thread id is the DEFAULT: session_meta / token_usage_record ids (ancestry, parent provenance, copied records) never replace it', pinnedLive._threadId === 'pin');
  pinnedLive.processLive({ type: 'wrapper_meta', payload: { threadId: 'other' } }, false);
  ok("…but the wrapper's OWN wrapper_meta.threadId re-points it — the file the wrapper writes NOW (a mid-life thread/fork); the pin is a default, not a lock (round 3)", pinnedLive._threadId === 'other');

  // LIVE RE-POINT SEQUENCE (round 3, minor): codex-events.js re-points
  // session.backendSessionId on wrapper_meta and pushes the old id onto
  // forkedFrom, but a normalizer pinned at rebuild to the OLD id kept minting
  // cx:<old>:… for every later token_count while the walker keyed the NEW file
  // (cx:old-thread-x:4242 vs cx:new-thread-y:4242). The wrapper's thread/fork
  // result records session_meta{id:new} then wrapper_meta{threadId:new}
  // (codex-chat-wrapper updateMetaFromThread), so the SAME record that
  // re-points the session re-points the normalizer, in stream order.
  {
    const OLD = '01a07400-0000-7000-8000-00000000000a', NEW = '01a07400-0000-7000-8000-00000000000b';
    const U = (i, c, o, r, t) => ({ input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: r, total_tokens: t });
    const R2 = (type, payload, ts) => ({ timestamp: ts, type, payload });
    const oldHalf = [
      R2('session_meta', { id: OLD, cwd: '/home/u/proj', cli_version: '0.153.4' }, '2026-09-06T10:00:00.000Z'),
      R2('turn_context', { turn_id: 't-old', model: 'gpt-6-astra', effort: 'high' }, '2026-09-06T10:00:01.000Z'),
      R2('response_item', { type: 'message', id: 'msg_old', role: 'assistant', content: [{ type: 'output_text', text: 'before the fork' }] }, '2026-09-06T10:00:02.000Z'),
      R2('event_msg', { type: 'token_count', info: { total_token_usage: U(4000, 0, 242, 0, 4242), last_token_usage: U(4000, 0, 242, 0, 4242), model_context_window: 828400 } }, '2026-09-06T10:00:03.000Z'),
    ];
    const newHalf = [
      R2('session_meta', { id: NEW, forked_from_id: OLD, cwd: '/home/u/proj', cli_version: '0.153.4' }, '2026-09-06T10:01:00.000Z'),
      R2('turn_context', { turn_id: 't-new', model: 'gpt-6-astra', effort: 'high' }, '2026-09-06T10:01:01.000Z'),
      R2('response_item', { type: 'message', id: 'msg_new', role: 'assistant', content: [{ type: 'output_text', text: 'after the fork' }] }, '2026-09-06T10:01:02.000Z'),
      R2('event_msg', { type: 'token_count', info: { total_token_usage: U(4000, 0, 242, 0, 4242), last_token_usage: U(4000, 0, 242, 0, 4242), model_context_window: 828400 } }, '2026-09-06T10:01:03.000Z'),
    ];
    // the live stream as the wrapper emits it: wrapper_meta right after each session_meta
    const stream = [oldHalf[0], R2('wrapper_meta', { threadId: OLD, model: 'gpt-6-astra' }, oldHalf[0].timestamp), ...oldHalf.slice(1), newHalf[0], R2('wrapper_meta', { threadId: NEW, model: 'gpt-6-astra' }, newHalf[0].timestamp), ...newHalf.slice(1)];
    const keysOf = (mm) => mm._ledgerKeys.map((k) => k.rid);
    for (const [label, mm] of [['pinned at rebuild to the OLD id', new CodexMessageManager('t10g', { threadId: OLD })], ['fresh spawn (no pin)', new CodexMessageManager('t10h')]]) {
      for (const r of stream) mm.processLive(r);
      const before = mm.messages.find((m) => JSON.stringify(m.content).includes('before the fork')), after = mm.messages.find((m) => JSON.stringify(m.content).includes('after the fork'));
      ok(`live re-point, ${label}: the message before the fork keys cx:<old>:4242, the one after keys cx:<new>:4242 (same cumulative, two files), both minted once, default now = new`, before?.meta?.requestId === `cx:${OLD}:4242` && after?.meta?.requestId === `cx:${NEW}:4242` && keysOf(mm).join(',') === `cx:${OLD}:4242,cx:${NEW}:4242` && mm._threadId === NEW, JSON.stringify({ before: before?.meta?.requestId, after: after?.meta?.requestId, keys: keysOf(mm), tid: mm._threadId }));
    }
    // the walker over the two files the two halves land in
    const { runUsageWalk } = require(REPO + '/src/usage-walker.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxrepoint-'));
    const cxDir = path.join(home, '.codex', 'sessions', '2026', '09', '06');
    fs.mkdirSync(cxDir, { recursive: true });
    fs.writeFileSync(path.join(cxDir, `rollout-2026-09-06T10-00-00-${OLD}.jsonl`), oldHalf.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(cxDir, `rollout-2026-09-06T10-01-00-${NEW}.jsonl`), newHalf.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const evs = runUsageWalk({ home, codexSessionsDir: path.join(home, '.codex', 'sessions'), cursorFile: path.join(home, 'cursor.json') }).events.map((l) => JSON.parse(l));
    ok('walker: the same cumulative total in two files is TWO rids (cx:<old>:4242, cx:<new>:4242) — the set the re-pointed normalizer minted', evs.map((e) => e.rid).sort().join(',') === [`cx:${OLD}:4242`, `cx:${NEW}:4242`].sort().join(','), JSON.stringify(evs.map((e) => e.rid)));
    fs.rmSync(home, { recursive: true, force: true });
    const ce = fs.readFileSync(REPO + '/src/server/stdout/codex-events.js', 'utf8');
    ok('WIRING: codex-events re-points session.backendSessionId on wrapper_meta.threadId and hands the SAME record to feedLive (the normalizer follows it in stream order — no direct re-pin from the consumer)', /msg\.type === 'wrapper_meta'\s*\?\s*payload\.threadId/.test(ce) && /session\.backendSessionId = nextThreadId/.test(ce) && /feedLive\(session, msg\)/.test(ce) && !/_normalizer\._threadId/.test(ce));
  }
  // WIRING: every reader that has the thread id passes it (a normalizer fix
  // with no consumer is dead — 2.355.0)
  const nz = fs.readFileSync(REPO + '/src/normalizers.js', 'utf8');
  ok('createMessageManager forwards opts to the normalizer ctor; rebuildHistory pins the session\'s backend thread id', /function createMessageManager\(backend, sessionId, opts\)[\s\S]{0,300}new Ctor\(sessionId, opts\)/.test(nz) && /createMessageManager\(session\.backend \|\| 'claude', sessionId, \{ threadId: session\.backendSessionId \|\| session\.claudeSessionId \|\| null \}\)/.test(nz));
  const wsh = fs.readFileSync(REPO + '/src/ws-handler.js', 'utf8');
  ok('the view-only (dead session) attach pins the thread id', /createMessageManager\(data\.backend \|\| 'claude', data\.sessionId \|\| 'view', \{ threadId: backendSessionId \}\)/.test(wsh));
  const tsv = fs.readFileSync(REPO + '/src/transcript-service.js', 'utf8');
  ok('transcript-service view() + gapSlab() pin the thread id (gap slabs carry no session_meta)', /createMessageManager\(r\.backend, 'api', \{ threadId: r\.sessionId \}\)/.test(tsv) && /createMessageManager\(r\.backend, 'gap', \{ threadId: r\.sessionId \}\)/.test(tsv));
}

// ── DUPLICATE token_count (verifier, real data: 394/8513 = 4.6% across 79
// rollouts; re-measured 369/8490 with the bare-cum probe): codex re-emits an
// IDENTICAL token_count (same last_token_usage, same cumulative total). The
// walker dedups on rid (`rid === cur.lastRid`); the first cut of
// _threadUsageMeta did not — it stamped the PREVIOUS response's key/numbers on
// the NEXT response's messages and advanced _usageMark so they were never
// re-stamped (45/1143 checkable messages wrong). Fixture = the real window
// verbatim (rollout-2026-09-05T13-26-05-01a0733f…, lines 108–127; paths and
// the reply text trimmed): token_count → item_completed → assistant message →
// DUPLICATE token_count → token_usage_record → next token_count.
{
  const fs = require('node:fs'), os = require('node:os');
  const TID = '01a0733f-f028-7462-9769-be3e761a4f19', TURN = '01a07340-04bc-7482-97fb-28ed6ed5a438';
  const U = (i, c, o, r, t) => ({ input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: r, total_tokens: t });
  const RL = { limit_id: 'codex', limit_name: null, primary: { used_percent: 6.0, window_minutes: 10080, resets_at: 1789224035 }, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, individual_limit: null, spend_control_reached: null, plan_type: 'pro', rate_limit_reached_type: null };
  const O = (ordinal, ts, type, payload) => ({ timestamp: ts, ordinal, type, payload });
  const CUM_A = U(401568, 374016, 3567, 568, 405135), LAST_A = U(46596, 45952, 233, 21, 46829);
  const CUM_B = U(448867, 420864, 3598, 568, 452465), LAST_B = U(47299, 46848, 31, 0, 47330);
  const RESP_A = 'resp_0f70caa71c94cdcc016a9c7b9a0b5887d091c099492fce3b09', RESP_B = 'resp_0f70caa71c94cdcc016a9c7bacb49087d0a16d9758e8f9c292';
  const window = [
    O(0, '2026-09-05T20:26:10.474Z', 'session_meta', { session_id: TID, id: TID, timestamp: '2026-09-05T20:26:05.224Z', cwd: '/home/u/proj', originator: 'claude-code-webui', cli_version: '0.153.4', source: 'vscode', model_provider: 'openai' }),
    O(10, '2026-09-05T20:26:10.502Z', 'turn_context', { turn_id: TURN, root_turn_id: TURN, cwd: '/home/u/proj', workspace_roots: ['/home/u/proj'], current_date: '2026-09-05', timezone: 'UTC', approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' }, model: 'gpt-6-astra', comp_hash: '3000', personality: 'pragmatic', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-astra', reasoning_effort: 'ultra', developer_instructions: null } }, multi_agent_version: 'v2', realtime_active: false, effort: 'ultra', summary: 'auto' }),
    O(112, '2026-09-05T20:29:22.048Z', 'response_item', { type: 'custom_tool_call', id: 'ctc_0f70caa71c94cdcc016a9c7b9c306887d0bb99e97501949ff3', status: 'completed', call_id: 'call_825hA5p3YQWaT3uDn2R4voLd', name: 'exec', input: 'text(await tools.exec_command({cmd:"vibespace-task progress \'…\'",max_output_tokens:1500}));' }),
    O(113, '2026-09-05T20:29:22.082Z', 'token_usage_record', { thread_id: TID, turn_id: TURN, session_id: TID, root_turn_id: TURN, response_id: RESP_A, usage: LAST_A, turn_token_usage: CUM_A, thread_token_usage: CUM_A }),
    O(114, '2026-09-05T20:29:22.266Z', 'event_msg', { type: 'item_completed', thread_id: TID, turn_id: TURN, item: { type: 'CommandExecution', id: 'exec-816df4b3-1751-490f-aa07-bbb19833b4ad', process_id: '65391', command: ['/usr/bin/zsh', '-lc', 'vibespace-task progress …'], cwd: 'file:///home/u/proj', parsed_cmd: [{ type: 'unknown', cmd: 'vibespace-task progress …' }], source: 'unified_exec_startup', status: 'completed', stdout: 'progress recorded (with detail)\n' }, started_at_ms: 1788640162082, completed_at_ms: 1788640162266 }),
    O(116, '2026-09-05T20:29:22.312Z', 'response_item', { type: 'custom_tool_call_output', id: 'ctco_01a07342-f208-7171-b944-d5ea501a4c8e', call_id: 'call_825hA5p3YQWaT3uDn2R4voLd', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' }, { type: 'input_text', text: '{"chunk_id":"44c163","wall_time_seconds":0.050621277,"exit_code":0,"original_token_count":63,"output":"progress recorded (with detail)\\n"}' }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640162.3128173 } }),
    O(117, '2026-09-05T20:29:22.313Z', 'event_msg', { type: 'token_count', info: { total_token_usage: CUM_A, last_token_usage: LAST_A, model_context_window: 828400 }, rate_limits: RL }),
    O(118, '2026-09-05T20:29:32.025Z', 'event_msg', { type: 'item_completed', thread_id: TID, turn_id: TURN, item: { type: 'AgentMessage', id: 'msg_0f70caa71c94cdcc016a9c7ba6fe1487d0ab25b5060ee21f5e', content: [{ type: 'Text', text: '空间方案已收敛到 5.45 米长的高顶 Van。' }], phase: 'commentary' }, started_at_ms: 1788640167014, completed_at_ms: 1788640172025 }),
    O(119, '2026-09-05T20:29:32.028Z', 'response_item', { type: 'message', id: 'msg_0f70caa71c94cdcc016a9c7ba6fe1487d0ab25b5060ee21f5e', role: 'assistant', content: [{ type: 'output_text', text: '空间方案已收敛到 5.45 米长的高顶 Van。' }], phase: 'commentary', internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640162.65853, content_item_kinds: ['unknown'] } }),
    O(120, '2026-09-05T20:29:32.028Z', 'event_msg', { type: 'token_count', info: { total_token_usage: CUM_A, last_token_usage: LAST_A, model_context_window: 828400 }, rate_limits: RL }), // ← the DUPLICATE
    O(121, '2026-09-05T20:29:32.030Z', 'inter_agent_communication_metadata', { trigger_turn: false }),
    O(122, '2026-09-05T20:29:32.030Z', 'response_item', { type: 'agent_message', id: 'amsg_01a07343-17fe-7883-9616-88ea3029f89e', author: '/root/interior_research', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/interior_research\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAAABqnHujj9fbPqJeTp7u…' }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640172.0300913 } }),
    O(123, '2026-09-05T20:29:35.246Z', 'response_item', { type: 'function_call', id: 'fc_0f70caa71c94cdcc016a9c7bae93f887d0af84c316cb7878d5', name: 'wait', arguments: '{"cell_id":"3","max_tokens":3000,"yield_time_ms":1000}', call_id: 'call_6G7f6gJNAxEwx4ft6dCxz9ex', internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640173.032581 } }),
    O(124, '2026-09-05T20:29:35.303Z', 'token_usage_record', { thread_id: TID, turn_id: TURN, session_id: TID, root_turn_id: TURN, response_id: RESP_B, usage: LAST_B, turn_token_usage: CUM_B, thread_token_usage: CUM_B }),
    O(125, '2026-09-05T20:29:35.320Z', 'response_item', { type: 'function_call_output', id: 'fco_01a07343-24d8-7b60-8c39-fad74db93027', call_id: 'call_6G7f6gJNAxEwx4ft6dCxz9ex', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: 'Warning: truncated output (original token count: 753317)\nTotal output lines: 1\n\n{"image_url":"data:image/png;base64,…"}' }], internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1788640175.3201 } }),
    O(126, '2026-09-05T20:29:35.321Z', 'event_msg', { type: 'token_count', info: { total_token_usage: CUM_B, last_token_usage: LAST_B, model_context_window: 828400 }, rate_limits: RL }),
  ];
  const msgs = new CodexMessageManager('t11').convertHistory(window);
  const exec = msgs.find((m) => m.toolCallId === 'call_825hA5p3YQWaT3uDn2R4voLd');
  const reply = msgs.find((m) => m.role === 'assistant' && m.content[0]?.type === 'text');
  const wait = msgs.find((m) => m.toolCallId === 'call_6G7f6gJNAxEwx4ft6dCxz9ex');
  ok('the exec card (output landed before the first token_count) carries response A: cx:…:405135 / resp_A', exec?.meta?.requestId === `cx:${TID}:405135` && exec.meta.msgId === RESP_A && exec.meta.usage.output_tokens === 233, JSON.stringify(exec?.meta));
  ok('the assistant reply created AFTER token_count A is NOT stamped by the DUPLICATE token_count — it gets response B: cx:…:452465, resp_B, input 47299−46848 fresh / 46848 cached / output 31', reply?.meta?.requestId === `cx:${TID}:452465` && reply.meta.msgId === RESP_B && reply.meta.usage.input_tokens === 47299 - 46848 && reply.meta.usage.cache_read_input_tokens === 46848 && reply.meta.usage.output_tokens === 31 && reply.meta.usage.reasoning_output_tokens === 0, JSON.stringify(reply?.meta));
  ok('…and the wait card of the same response shares it (the duplicate advanced no mark)', wait?.meta?.requestId === `cx:${TID}:452465` && wait.meta.msgId === RESP_B);
  ok('every stamped message keys to one of the TWO real responses (never a third phantom)', msgs.filter((m) => m.meta).every((m) => [405135, 452465].some((n) => m.meta.requestId === `cx:${TID}:${n}`)), JSON.stringify(msgs.map((m) => m.meta?.requestId)));
  // walker on the same window: two events, deduped identically
  const { runUsageWalk } = require(REPO + '/src/usage-walker.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxdup-'));
  const cxDir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(cxDir, { recursive: true });
  fs.writeFileSync(path.join(cxDir, `rollout-2026-09-05T13-26-05-${TID}.jsonl`), window.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const evs = runUsageWalk({ home, codexSessionsDir: path.join(home, '.codex', 'sessions'), cursorFile: path.join(home, 'cursor.json') }).events.map((l) => JSON.parse(l));
  ok('walker emits exactly two events for the window (the duplicate deduped on rid) with the same rids + mids the normalizer stamped', evs.length === 2 && evs[0].rid === exec?.meta?.requestId && evs[0].mid === RESP_A && evs[1].rid === reply?.meta?.requestId && evs[1].mid === RESP_B && evs[1].i === reply.meta.usage.input_tokens && evs[1].o === 31, JSON.stringify(evs.map((e) => [e.rid, e.mid, e.i, e.o])));
  fs.rmSync(home, { recursive: true, force: true });
  // live path: the same duplicate through processLive neither stamps nor advances
  const live = new CodexMessageManager('t11b'); const ops = []; live.onOp((o) => ops.push(o));
  for (const r of window.slice(0, 10)) live.processLive(r); // through the duplicate (ordinal 120)
  const liveReply = live.messages.find((m) => m.role === 'assistant' && m.content[0]?.type === 'text');
  ok('live: after the duplicate the reply is still unstamped (no phantom edit op)', liveReply && liveReply.meta == null && !ops.some((o) => o.op === 'edit' && o.id === liveReply.id && o.fields?.meta));
  for (const r of window.slice(10)) live.processLive(r);
  ok('live: the NEXT real token_count stamps it with response B and emits the edit', liveReply.meta?.requestId === `cx:${TID}:452465` && ops.some((o) => o.op === 'edit' && o.id === liveReply.id && o.fields?.meta?.msgId === RESP_B));
}

// ── rid-info model/effort CONSUMER (verifier item 3): the route returns the
// ledger's served model + codex effort; the popup falls back to them when the
// record's own meta has none (rows appended only when the sync rows lacked them).
{
  const cv = require('node:fs').readFileSync(REPO + '/src/lib/chat-view.js', 'utf8');
  ok('popup appends Model / Effort from the ledger event when meta.model / meta.effort are empty', /if \(!meta\.model && r\.model\) addAsyncRow\(t\('Model'\), r\.model\)/.test(cv) && /if \(!meta\.effort && r\.effort\) addAsyncRow\(t\('Effort'\), r\.effort\)/.test(cv));
}

// ── MERGED READ = per-RECORD file provenance (round-3 verifier, real data):
// CodexSessionMessages prepends the fork PARENT's records (native 0.153 forks:
// session_meta.forked_from_id + forked_from_ordinal_exclusive, cut at the
// boundary; the wrapper's forkedFrom chain, whole) before the thread's own, so
// a reader-wide thread id keyed every parent-half message `cx:<child>:<parent
// cumulative>` — a key the ledger never minted for that thread and sometimes a
// REAL child event's key (byte copies of two real rollouts: parentCorrect 0/30,
// two parent messages resolving to CHILD ledger events; base e54b41e8 had
// 28/30). Fixture = scripts/fixtures/codex-native-fork/: verbatim cuts of the
// two real 0.153.4 rollouts (a sub-agent + its own sub-agent; ids, numbers,
// ordinals, timestamps and response ids verbatim; paths/instructions/long text
// anonymised) with `forked_from_ordinal_exclusive: 53` INJECTED into the
// child's own session_meta (marked in the record) so the parent is a
// Referenced-fork ancestor cut at parent ordinal 53. The walker's ground truth
// stays per FILE — parent-half keys must be the parent file's rids.
{
  const fs = require('node:fs'), os = require('node:os');
  const PARENT = '01a072d7-92f1-7c20-987b-a96af83c2e76', CHILD = '01a072d7-eeb4-73c3-b30f-486701a44580';
  const FIX = path.join(REPO, 'scripts', 'fixtures', 'codex-native-fork');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxfork-'));
  const cxDir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(cxDir, { recursive: true });
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(cxDir, f));
  // adapters/codex binds CODEX_SESSIONS_DIR from os.homedir() at require time:
  // HOME points at the fixture home for the FIRST require of the store only,
  // then is restored (the corpus smoke below reads the real home).
  ok('adapters/codex is not loaded before the fixture home is bound (CODEX_SESSIONS_DIR is a require-time constant)', !Object.keys(require.cache).some((k) => /[\\/]adapters[\\/]codex\.js$/.test(k)));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  let ST;
  try { ST = require(REPO + '/src/codex-session-store.js'); } finally { process.env.HOME = realHome; }
  const { runUsageWalk } = require(REPO + '/src/usage-walker.js');
  const walkRids = new Map(); // sid → Set(rid)
  for (const l of runUsageWalk({ home, codexSessionsDir: path.join(home, '.codex', 'sessions'), cursorFile: path.join(home, 'cursor.json') }).events) {
    const e = JSON.parse(l);
    if (!walkRids.has(e.sid)) walkRids.set(e.sid, new Set());
    walkRids.get(e.sid).add(e.rid);
  }
  const P_RIDS = [20614, 41430, 67165, 2994636].map((n) => `cx:${PARENT}:${n}`), C_RIDS = [20674, 41391, 2989029].map((n) => `cx:${CHILD}:${n}`);
  const sorted = (a) => [...a].sort().join(',');
  ok('walker ground truth is per FILE: 4 parent + 3 child rids (cumulative totals verbatim from the real rollouts)', sorted(walkRids.get(PARENT) || []) === sorted(P_RIDS) && sorted(walkRids.get(CHILD) || []) === sorted(C_RIDS), JSON.stringify([...walkRids].map(([k, v]) => [k, [...v]])));
  ok('the injected boundary makes the parent a Referenced-fork ancestor cut at parent ordinal 53 (the parent\'s own sub-agent ancestry ends there: no boundary of its own)', JSON.stringify(ST.resolveCodexForkAncestry(CHILD, [])) === JSON.stringify([{ id: PARENT, untilOrdinal: 53 }]), JSON.stringify(ST.resolveCodexForkAncestry(CHILD, [])));

  // Drive the merged read record by record (what convertHistory does) and
  // remember which FILE created each message — the verifier's measurement.
  const drive = (session, label, pin) => {
    const recs = new ST.CodexSessionMessages(session, label, {}).raw();
    const mm = new CodexMessageManager(label, { threadId: pin });
    const origin = new Map(), seen = new Set();
    for (const r of recs) {
      mm._processRecord(r, false);
      for (const m of mm.messages) if (!seen.has(m.id)) { seen.add(m.id); origin.set(m.id, ST.recordThreadOf(r)); }
    }
    mm._finalizeStreaming(false, { includeReasoning: true });
    const s = { parentMsgs: 0, parentCorrect: 0, parentToChild: 0, parentNowhere: 0, childMsgs: 0, childCorrect: 0, childBad: 0, untagged: recs.filter((r) => !ST.recordThreadOf(r)).length };
    for (const m of mm.messages) {
      const rid = m.meta?.requestId; if (!rid) continue;
      if (origin.get(m.id) === PARENT) { s.parentMsgs++; if (walkRids.get(PARENT).has(rid)) s.parentCorrect++; else if (walkRids.get(CHILD).has(rid)) s.parentToChild++; else s.parentNowhere++; }
      else { s.childMsgs++; if (walkRids.get(CHILD).has(rid)) s.childCorrect++; else s.childBad++; }
    }
    const minted = (tid) => mm._ledgerKeys.filter((k) => k.tid === tid).map((k) => k.rid);
    return { recs, mm, s, minted };
  };
  // ① the native fork — no session state at all, the reader resolves the ancestry from the files
  const nf = drive({ backend: 'codex', backendSessionId: CHILD, buffer: '' }, 'nf', CHILD);
  ok('every merged record carries its FILE as provenance (parent-half tagged PARENT, child-half CHILD; nothing untagged; the tag is non-enumerable — never serialized)', nf.s.untagged === 0 && nf.recs.some((r) => ST.recordThreadOf(r) === PARENT) && nf.recs.some((r) => ST.recordThreadOf(r) === CHILD) && nf.recs.every((r) => !Object.keys(r).includes('__threadId')) && !JSON.stringify(nf.recs).includes('__threadId'), JSON.stringify(nf.s));
  ok(`native fork: EVERY parent-half message keys to a PARENT-file ledger event — parentCorrect ${nf.s.parentCorrect}/${nf.s.parentMsgs} (the absolute pin: 0/N), zero parent→child collisions, zero nowhere`, nf.s.parentMsgs > 0 && nf.s.parentCorrect === nf.s.parentMsgs && nf.s.parentToChild === 0 && nf.s.parentNowhere === 0, JSON.stringify(nf.s));
  ok(`native fork: every child-half message keys to a CHILD-file ledger event — ${nf.s.childCorrect}/${nf.s.childMsgs}`, nf.s.childMsgs > 0 && nf.s.childCorrect === nf.s.childMsgs && nf.s.childBad === 0, JSON.stringify(nf.s));
  ok('native fork: parent-half MINTED keys ⊆ walker rids of the parent file = exactly the three below the boundary (the parent\'s post-fork response 2994636 is never minted — the parent\'s alone)', sorted(nf.minted(PARENT)) === sorted(P_RIDS.slice(0, 3)), JSON.stringify(nf.minted(PARENT)));
  ok('native fork: child-half MINTED keys == walker rids of the child file (whole file); 6 keys minted, each once', sorted(nf.minted(CHILD)) === sorted(C_RIDS) && nf.mm._ledgerKeys.length === 6, JSON.stringify(nf.minted(CHILD)));
  ok('native fork: every stamped message key is a minted key; no key under any third thread id', nf.mm.messages.filter((m) => m.meta?.requestId).every((m) => nf.mm._ledgerKeys.some((k) => k.rid === m.meta.requestId)) && nf.mm._ledgerKeys.every((k) => k.tid === PARENT || k.tid === CHILD));
  // ② the wrapper-chain shape (session.forkedFrom names a superseded incarnation, merged WHOLE):
  //    the same two files with the roles swapped so the ancestor carries NO native boundary
  const wc = drive({ backend: 'codex', backendSessionId: PARENT, forkedFrom: [CHILD], buffer: '' }, 'wc', PARENT);
  ok('wrapper chain (whole-file ancestor): ancestor-half minted keys == the walker\'s rids for the ancestor file; own-half == own file; 7 keys, every stamped key minted, no cross-file key', sorted(wc.minted(CHILD)) === sorted(C_RIDS) && sorted(wc.minted(PARENT)) === sorted(P_RIDS) && wc.mm._ledgerKeys.length === 7 && wc.mm.messages.filter((m) => m.meta?.requestId).every((m) => wc.mm._ledgerKeys.some((k) => k.rid === m.meta.requestId)), JSON.stringify({ c: wc.minted(CHILD), p: wc.minted(PARENT), s: wc.s }));
  // ③ a gap slab / tail-only read of the child file ALONE (no provenance tags — the reader's id is the default)
  const bareChild = new CodexMessageManager('gap', { threadId: CHILD });
  for (const line of fs.readFileSync(path.join(cxDir, fs.readdirSync(cxDir).find((f) => f.includes(CHILD))), 'utf8').split('\n')) { if (line) bareChild._processRecord(JSON.parse(line), false); }
  ok('provenance-less records (gap slab / tail-only read) key by the reader\'s default id — the child file alone mints exactly the walker\'s child rids', sorted(bareChild._ledgerKeys.map((k) => k.rid)) === sorted(C_RIDS) && bareChild._ledgerKeys.every((k) => k.tid === CHILD), JSON.stringify(bareChild._ledgerKeys));
  fs.rmSync(home, { recursive: true, force: true });
}

// ── CORPUS SMOKE (verifier item 4): when this machine has ~/.codex/sessions,
// drive the normalizer over up to 30 local rollouts and demand (a) every
// meta.requestId starts with `cx:<that file's uuid>:` and (b) the set of
// ledger keys the normalizer MINTS equals the walker's rid set for the same
// file (and the mids agree) — minted, not merely stamped: a CARDLESS response
// (back-to-back token_counts with no item between them; an agent_message
// event with no response_item twin — 215/835 responses in one real sub-agent
// rollout) has no message to carry its key, yet the ledger counts it.
// Skipped with a printed reason where the directory is absent (CI).
{
  const fs = require('node:fs'), os = require('node:os');
  const sessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let rollouts = [];
  try { rollouts = fs.readdirSync(sessionsDir, { recursive: true }).map(String).filter((f) => /rollout-.*\.jsonl$/.test(f)); } catch { }
  if (!rollouts.length) {
    console.log(`  – corpus smoke SKIPPED: no codex rollouts under ${sessionsDir} on this machine (CI runners have none)`);
  } else {
    const MAX_FILES = 30, MAX_BYTES = 24 * 1024 * 1024;
    const picked = rollouts.map((rel) => { const fp = path.join(sessionsDir, rel); let st; try { st = fs.statSync(fp); } catch { return null; } return st && st.isFile() && st.size <= MAX_BYTES ? { rel, fp, size: st.size, mtime: st.mtimeMs } : null; })
      .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
    const { runUsageWalk } = require(REPO + '/src/usage-walker.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxcorpus-'));
    const cxDir = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(cxDir, { recursive: true });
    for (const p of picked) fs.symlinkSync(p.fp, path.join(cxDir, path.basename(p.rel))); // the walker keys by the file NAME uuid; a symlink keeps it and the bytes
    const bySid = new Map();
    for (const l of runUsageWalk({ home, codexSessionsDir: cxDir, cursorFile: path.join(home, 'cursor.json') }).events) {
      const e = JSON.parse(l);
      if (!bySid.has(e.sid)) bySid.set(e.sid, new Map());
      bySid.get(e.sid).set(e.rid, e.mid || null);
    }
    fs.rmSync(home, { recursive: true, force: true });
    let files = 0, msgsSeen = 0, minted = 0, cardless = 0, prefixBad = [], setBad = [], midBad = [], stampedBad = [];
    for (const p of picked) {
      const uuid = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(p.rel)[1].toLowerCase();
      const records = [];
      for (const line of fs.readFileSync(p.fp, 'utf8').split('\n')) { if (!line) continue; try { records.push(JSON.parse(line)); } catch { } }
      const mm = new CodexMessageManager('corpus'); // bare: no pinned id — the file's own first session_meta must carry it
      const msgs = mm.convertHistory(records);
      files++;
      const stamped = msgs.filter((m) => m.meta?.requestId);
      msgsSeen += stamped.length;
      const wrong = stamped.filter((m) => !m.meta.requestId.startsWith(`cx:${uuid}:`));
      if (wrong.length) prefixBad.push(`${path.basename(p.rel).slice(0, 44)}: ${wrong.length}/${stamped.length} keyed ${wrong[0].meta.requestId.slice(0, 48)}`);
      const keys = mm._ledgerKeys; minted += keys.length; cardless += keys.filter((k) => !k.n).length;
      const normSet = new Set(keys.map((k) => k.rid));
      const walkMap = bySid.get(uuid) || new Map();
      const missing = [...walkMap.keys()].filter((r) => !normSet.has(r)), extra = [...normSet].filter((r) => !walkMap.has(r));
      if (missing.length || extra.length || normSet.size !== keys.length) setBad.push(`${path.basename(p.rel).slice(0, 44)}: walker-only ${missing.length} (${missing.slice(0, 2).join(',')}) normalizer-only ${extra.length} (${extra.slice(0, 2).join(',')}) minted ${keys.length} distinct ${normSet.size}`);
      const notMinted = stamped.filter((m) => !normSet.has(m.meta.requestId));
      if (notMinted.length) stampedBad.push(`${path.basename(p.rel).slice(0, 44)}: ${notMinted.length} stamped keys never minted`);
      const midMismatch = keys.filter((k) => walkMap.has(k.rid) && (walkMap.get(k.rid) || null) !== (k.mid || null));
      if (midMismatch.length) midBad.push(`${path.basename(p.rel).slice(0, 44)}: ${midMismatch.length} mids differ (${midMismatch[0].rid.slice(-8)}: ${walkMap.get(midMismatch[0].rid)} vs ${midMismatch[0].mid})`);
    }
    console.log(`  · corpus smoke: ${files} local rollouts (≤${MAX_BYTES / 1048576}MB each, newest first), ${minted} ledger keys minted (${cardless} cardless), ${msgsSeen} stamped messages, ${[...bySid.values()].reduce((n, m) => n + m.size, 0)} walker events`);
    ok(`corpus: every meta.requestId starts with cx:<the file's own uuid>: (${files} rollouts)`, files > 0 && prefixBad.length === 0, prefixBad.slice(0, 5).join(' | '));
    ok('corpus: the set of ledger keys the normalizer MINTS EQUALS the walker\'s rid set for every file, each minted once (dedup + heartbeat skip + thread id all agree)', files > 0 && setBad.length === 0, setBad.slice(0, 5).join(' | '));
    ok('corpus: every stamped message key is a minted key', files > 0 && stampedBad.length === 0, stampedBad.slice(0, 5).join(' | '));
    ok('corpus: the response id (msgId) matches the walker\'s mid on every minted key', files > 0 && midBad.length === 0, midBad.slice(0, 5).join(' | '));
  }
}
// ── web search (2.369.43, owner: every codex web_search card read
// {"query":"","action":null} + "(empty)"). Shapes verbatim from real rollouts
// (2026-08 0.153: event_msg web_search_end ONLY, call_id 'exec-…';
// 2026-05 0.14x: web_search_end 'ws_…' immediately followed by an id-less
// web_search_call item; ids/queries anonymised).
{
  const results = [
    { type: 'text_result', domain: 'support.example.org', ref_id: 'turn4search0', snippet: 'The overall fraction of mastery points  for that course that you have achieved. ... We hope', title: 'What are Course and Unit Mastery? – Help Center', url: 'https://support.example.org/hc/en-us/articles/1' },
    { type: 'text_result', domain: 'support.example.org', ref_id: 'turn4search1', snippet: 'Learn more about Mastery and Proficiency here.', title: 'How do Course Levels work? – Help Center', url: 'https://support.example.org/hc/en-us/articles/2' },
  ];
  // ① rollout rebuild (0.153): the search lives ONLY in web_search_end → a complete 'search' card
  const mm = new CodexMessageManager('ws1');
  const msgs = mm.convertHistory([
    { timestamp: '2026-08-24T11:36:38.601Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'exec-535c79a7-85aa-4e48-bf1a-d5211414fa3d', query: 'site:example.org interactive learning math', action: { type: 'search', queries: ['site:example.org interactive learning math', 'site:example.org mastery points skills'] }, results } },
    { timestamp: '2026-08-24T11:36:47.983Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'exec-c437b77a-036c-462b-8645-fa4e41bd1303', query: 'https://example.org/s6.pdf', action: { type: 'open_page', url: 'https://example.org/s6.pdf' }, results: [{ type: 'text_result', ref_id: 'turn6view0', snippet: 'Total lines: 1', title: 'Internal Error' }] } },
    { timestamp: '2026-04-14T10:22:36.550Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'ws_0a7dc088f2d154ff0169de156303b4819aab594cfac5296bc7', query: "'JSON output' in https://developers.example.org/cli", action: { type: 'find_in_page', url: 'https://developers.example.org/cli', pattern: 'JSON output' } } },
  ]);
  const cards = msgs.filter((m) => m.role === 'tool');
  ok('a rollout with web_search_end ONLY (0.153) rebuilds every search as a card (it rendered none)', cards.length === 3 && cards.every((m) => m.collapseKind === 'search' && m.status === 'complete' && m.toolStatus === 'ok'), JSON.stringify(cards.map((m) => [m.collapseKind, m.status])));
  const s0 = cards[0]?.content?.[0];
  ok('search card input carries the final query + action', s0?.input?.query === 'site:example.org interactive learning math' && s0?.input?.action?.type === 'search' && s0.input.action.queries.length === 2, JSON.stringify(s0?.input));
  ok('results render as "title — url\\nsnippet" blocks (whitespace collapsed), not raw JSON', s0?.output === 'What are Course and Unit Mastery? – Help Center — https://support.example.org/hc/en-us/articles/1\nThe overall fraction of mastery points for that course that you have achieved. ... We hope\n\nHow do Course Levels work? – Help Center — https://support.example.org/hc/en-us/articles/2\nLearn more about Mastery and Proficiency here.', JSON.stringify(s0?.output));
  ok("open_page renders 'opened <url>' + the page result", cards[1]?.content?.[0]?.output === 'opened https://example.org/s6.pdf\n\nInternal Error\nTotal lines: 1', JSON.stringify(cards[1]?.content?.[0]?.output));
  ok("find_in_page renders \"found '<pattern>' in <url>\" (no results key at all)", cards[2]?.content?.[0]?.output === "found 'JSON output' in https://developers.example.org/cli", JSON.stringify(cards[2]?.content?.[0]?.output));
  ok('no unknown-record telemetry / system card for the handled event', !msgs.some((m) => m.role === 'system') && !CodexMessageManager.SKIPPED_EVENT_TYPES.has('web_search_end') && !CodexMessageManager.SKIPPED_EVENT_TYPES.has('web_search_begin'));

  // ② LIVE: the wrapper's item/started function_call (EMPTY stub) + its
  // web_search_end + the rollout's byte-identical web_search_end on re-attach → ONE card, edited in place
  const live = new CodexMessageManager('ws2'); const ops = []; live.onOp((o) => ops.push(o));
  const end = { type: 'web_search_end', call_id: 'exec-1', query: 'vibespace acp', action: { type: 'search', queries: ['vibespace acp'] }, results: [results[0]] };
  live.processLive({ timestamp: '2026-09-06T00:00:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'web_search', arguments: '{"query":"","action":null}', call_id: 'exec-1' } });
  const pendingBefore = live.messages.filter((m) => m.role === 'tool');
  ok('live: the item/started stub is a pending search card', pendingBefore.length === 1 && pendingBefore[0].status === 'pending' && pendingBefore[0].collapseKind === 'search');
  live.processLive({ timestamp: '2026-09-06T00:00:01.000Z', type: 'event_msg', payload: end });
  live.processLive({ timestamp: '2026-09-06T00:00:01.050Z', type: 'event_msg', payload: { ...end } });
  const liveCards = live.messages.filter((m) => m.role === 'tool');
  const lb = liveCards[0]?.content?.[0];
  ok('live: web_search_end (wrapper) + its rollout twin = still ONE card, complete, query merged into the input, results rendered', liveCards.length === 1 && liveCards[0].status === 'complete' && lb?.input?.query === 'vibespace acp' && lb?.input?.action?.type === 'search' && /Help Center — https:/.test(lb?.output || ''), JSON.stringify([liveCards.length, lb?.input, lb?.output]));
  ok('live: ops = one create + edits on the SAME id (never a second create)', ops.filter((o) => o.op === 'create').length === 1 && ops.filter((o) => o.op === 'edit').every((o) => o.id === liveCards[0].id), JSON.stringify(ops.map((o) => o.op + ':' + o.id)));
  // begin (not persisted by codex; live-stream tolerance): unknown call → pending card; known → query patch, still pending
  const beg = new CodexMessageManager('ws3');
  beg.processLive({ timestamp: '2026-09-06T00:00:00.000Z', type: 'event_msg', payload: { type: 'web_search_begin', call_id: 'exec-9', query: 'early q' } });
  const bc = beg.messages.filter((m) => m.role === 'tool');
  ok('web_search_begin without a card = pending search card with the query', bc.length === 1 && bc[0].status === 'pending' && bc[0].content[0].input.query === 'early q' && bc[0].collapseKind === 'search', JSON.stringify(bc[0]));
  beg.processLive({ timestamp: '2026-09-06T00:00:00.500Z', type: 'event_msg', payload: { type: 'web_search_begin', call_id: 'exec-9', query: 'patched q' } });
  beg.processLive({ timestamp: '2026-09-06T00:00:01.000Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'exec-9', query: 'patched q', action: { type: 'search', queries: ['patched q'] }, results: [] } });
  const bc2 = beg.messages.filter((m) => m.role === 'tool');
  ok('begin+begin+end on one call_id = one card, completed with "no results"', bc2.length === 1 && bc2[0].status === 'complete' && bc2[0].content[0].input.query === 'patched q' && bc2[0].content[0].output === 'no results', JSON.stringify(bc2[0]?.content));
  // error → is_error card (typed field on the item, relayed by the wrapper)
  const er = new CodexMessageManager('ws4');
  er.convertHistory([{ timestamp: '2026-09-06T00:00:01.000Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'exec-e', query: 'q', action: { type: 'search', queries: ['q'] }, error: 'rate limited' } }]);
  ok('a search error is an error card carrying the message', er.messages[0]?.toolStatus === 'error' && er.messages[0]?.content[0].output === 'rate limited' && er.messages[0]?.content[0].status === 'error');

  // ③ 0.14x twin pair: web_search_end then the id-less web_search_call (same action) → ONE card; an orphan call still renders
  const twin = new CodexMessageManager('ws5');
  const tm = twin.convertHistory([
    { timestamp: '2026-05-09T15:21:38.791Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'ws_0c1fb930c3f4', query: 'GitHub request code review pull request', action: { type: 'search', query: 'GitHub request code review pull request', queries: ['GitHub request code review pull request', 'code review request API'] } } },
    { timestamp: '2026-05-09T15:21:38.792Z', type: 'response_item', payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'GitHub request code review pull request', queries: ['GitHub request code review pull request', 'code review request API'] } } },
    { timestamp: '2026-05-15T12:35:22.275Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'ws_067ac040eb74', query: 'https://ai.example.dev/docs/document-processing', action: { type: 'open_page', url: 'https://ai.example.dev/docs/document-processing' } } },
    { timestamp: '2026-05-15T12:35:22.275Z', type: 'response_item', payload: { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://ai.example.dev/docs/document-processing' } } },
    { timestamp: '2026-04-15T01:01:48.300Z', type: 'response_item', payload: { type: 'web_search_call', status: 'completed' } },
  ]);
  const tc = tm.filter((m) => m.role === 'tool');
  ok('0.14x rollouts: web_search_end + its id-less web_search_call twin = ONE card each (2 searches + 1 orphan call = 3 cards, not 5)', tc.length === 3 && tc[0].content[0].input.query === 'GitHub request code review pull request' && tc[1].content[0].input.action?.url === 'https://ai.example.dev/docs/document-processing' && tc[2].content[0].output === 'status: completed', JSON.stringify(tc.map((m) => m.content[0].input)));
  // reverse order (call first, then end) also pairs
  const rev = new CodexMessageManager('ws6');
  const rm = rev.convertHistory([
    { timestamp: '2026-05-09T15:21:38.791Z', type: 'response_item', payload: { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://x.example/p' } } },
    { timestamp: '2026-05-09T15:21:38.792Z', type: 'event_msg', payload: { type: 'web_search_end', call_id: 'ws_r', query: 'https://x.example/p', action: { type: 'open_page', url: 'https://x.example/p' }, results: [{ type: 'text_result', title: 'P', url: 'https://x.example/p', snippet: 'body' }] } },
  ]);
  const rc = rm.filter((m) => m.role === 'tool');
  ok('…and in the reverse order: the end adopts the call\'s card (one card, results rendered)', rc.length === 1 && rc[0].content[0].output === 'opened https://x.example/p\n\nP — https://x.example/p\nbody', JSON.stringify(rc.map((m) => m.content[0].output)));
  // wrapper: the completion path is codex's OWN shape; the empty-stub started record is the pending card
  const wr = require('node:fs').readFileSync(REPO + '/data/bin/codex-chat-wrapper.js', 'utf8');
  ok("wrapper records item/completed webSearch as event_msg web_search_end {call_id, query, action, results} — never a function_call_output of raw JSON", /if \(type === 'webSearch'\) \{[\s\S]{0,1400}emitTaskEvent\('web_search_end', ev\)/.test(wr) && !/type === 'mcpToolCall' \|\| type === 'dynamicToolCall' \|\| type === 'webSearch'/.test(wr));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
