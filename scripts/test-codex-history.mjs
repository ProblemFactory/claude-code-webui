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

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
