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

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
