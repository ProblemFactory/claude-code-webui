#!/usr/bin/env node
// MOCK ACP v1 AGENT (scripts/test-acp-harness.mjs drives data/bin/acp-wrapper.js
// against THIS instead of a real agent). Speaks JSON-RPC 2.0 over stdio per
// schema/v1 of agentclientprotocol/agent-client-protocol:
//   initialize            → protocolVersion 1, agentCapabilities {loadSession,
//                           promptCapabilities.image, sessionCapabilities.resume}, agentInfo
//   session/new           → sessionId + configOptions (model select, mode select) + modes
//   session/load          → replays a stored conversation as user/agent chunks, then result
//   session/prompt        → agent_message_chunk ×2 → agent_thought_chunk → plan → tool_call
//                           (kind from the prompt text: "edit"→edit, "run"→execute, else read)
//                           → session/request_permission (allow_once/allow_always/reject_once;
//                             a prompt containing "noreject" offers ONLY the two allow options)
//                           → tool_call_update in_progress → completed (content) → agent text → end_turn
//                           a prompt containing "fs" first calls fs/read_text_file (must be refused)
//   session/cancel        → the running prompt resolves with stopReason 'cancelled'
//   session/set_config_option / session/set_mode → full config state back
//   available_commands_update after session/new; usage_update after each turn
// Every request the wrapper sends is appended to $MOCK_ACP_LOG (JSON lines) so
// the suite can assert the wire. Deliberately tiny and dependency-free.
import fs from 'node:fs';

const LOG = process.env.MOCK_ACP_LOG || '';
const logReq = (o) => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch {} } };
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1000;
const pending = new Map(); // our own requests to the client (request_permission, fs/*)
function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

const state = { sessions: new Map(), model: 'mock/fast', mode: 'build', cancelled: new Set(), active: null };
const configOptions = () => ([
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model, options: [{ value: 'mock/fast', name: 'Mock Fast' }, { value: 'mock/smart', name: 'Mock Smart' }] },
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: state.mode, options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }] },
]);
const modes = () => ({ currentModeId: state.mode, availableModes: [{ id: 'build', name: 'build' }, { id: 'plan', name: 'plan' }] });

async function runPrompt(id, params) {
  const sid = params.sessionId;
  const text = (params.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = (params.prompt || []).filter((b) => b.type === 'image').length;
  state.active = { id, sid };
  const cancelledAt = () => state.cancelled.has(sid);
  const finish = (stopReason) => { state.active = null; state.cancelled.delete(sid); send({ id, result: { stopReason } }); };
  if (/\bfs\b/.test(text)) {
    const r = await ask('fs/read_text_file', { sessionId: sid, path: '/etc/hostname' });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm-fs', content: { type: 'text', text: r?.error ? `fs refused: ${r.error.message}` : 'fs allowed?!' } });
    await sleep(20);
    return finish('end_turn');
  }
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1-' + id, content: { type: 'text', text: 'Looking at ' } });
  await sleep(20);
  if (cancelledAt()) return finish('cancelled');
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1-' + id, content: { type: 'text', text: `your request${images ? ` (+${images} image)` : ''}.` } });
  update(sid, { sessionUpdate: 'agent_thought_chunk', messageId: 't1-' + id, content: { type: 'text', text: 'I should check the file first.' } });
  update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Inspect', priority: 'high', status: 'in_progress' }, { content: 'Answer', priority: 'medium', status: 'pending' }] });
  const kind = /\bedit\b/.test(text) ? 'edit' : /\brun\b/.test(text) ? 'execute' : 'read';
  const callId = 'call-' + id;
  update(sid, { sessionUpdate: 'tool_call', toolCallId: callId, title: kind === 'execute' ? 'Running ls' : kind === 'edit' ? 'Editing README.md' : 'Reading README.md', kind, status: 'pending', rawInput: kind === 'execute' ? { command: 'ls -la' } : { path: '/repo/README.md' }, locations: [{ path: '/repo/README.md' }] });
  if (/\bslow\b/.test(text)) { await sleep(3000); if (cancelledAt()) { update(sid, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed' }); return finish('cancelled'); } }
  // "noreject" = an agent that offers ONLY allow options (real agents do: the
  // spec's PermissionOption list is the agent's choice) — the client must never
  // answer a Deny by selecting one of these.
  const options = /\bnoreject\b/.test(text)
    ? [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }]
    : [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }];
  const perm = await ask('session/request_permission', {
    sessionId: sid,
    toolCall: { toolCallId: callId, title: 'Permission to proceed', kind, status: 'pending' },
    options,
  });
  const outcome = perm?.result?.outcome;
  if (cancelledAt() || outcome?.outcome === 'cancelled') { update(sid, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed' }); return finish('cancelled'); }
  if (outcome?.optionId === 'no') {
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected by user' } }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm2-' + id, content: { type: 'text', text: 'Okay, not doing that.' } });
    return finish('end_turn');
  }
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'in_progress' });
  await sleep(20);
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed', content: kind === 'edit'
    ? [{ type: 'diff', path: '/repo/README.md', oldText: '# old', newText: '# new' }]
    : [{ type: 'content', content: { type: 'text', text: '# README\nhello' } }] });
  update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Inspect', priority: 'high', status: 'completed' }, { content: 'Answer', priority: 'medium', status: 'in_progress' }] });
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm2-' + id, content: { type: 'text', text: `Done (${outcome?.optionId}). Model ${state.model}, mode ${state.mode}.` } });
  update(sid, { sessionUpdate: 'usage_update', used: 1234, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
  await sleep(10);
  finish('end_turn');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && !m.method) { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } continue; } // client replies
    logReq({ id: m.id, method: m.method, params: m.params });
    const { id, method, params = {} } = m;
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { resume: {}, list: {} } }, authMethods: [{ id: 'mock-login', name: 'Login with mock', description: 'Run `mock auth login`' }], agentInfo: { name: 'mock-acp', title: 'Mock ACP Agent', version: '0.1.0' } } });
    } else if (method === 'session/new') {
      const sid = 'ses_mock_' + Math.random().toString(36).slice(2, 8);
      state.sessions.set(sid, { cwd: params.cwd, history: [] });
      send({ id, result: { sessionId: sid, configOptions: configOptions(), modes: modes() } });
      update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the diff' }, { name: 'plan', description: 'Plan a change', input: { hint: 'what to plan' } }] });
    } else if (method === 'session/load') {
      const sid = params.sessionId;
      update(sid, { sessionUpdate: 'user_message_chunk', messageId: 'u-old', content: { type: 'text', text: 'earlier question' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'a-old', content: { type: 'text', text: 'earlier answer' } });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-old', title: 'Old read', kind: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'old output' } }] });
      state.sessions.set(sid, { cwd: params.cwd, history: [] });
      send({ id, result: { configOptions: configOptions(), modes: modes() } });
    } else if (method === 'session/resume') {
      state.sessions.set(params.sessionId, { cwd: params.cwd, history: [] });
      send({ id, result: { configOptions: configOptions(), modes: modes() } });
    } else if (method === 'session/prompt') {
      if (!state.sessions.has(params.sessionId)) { send({ id, error: { code: -32602, message: 'unknown session' } }); continue; }
      runPrompt(id, params).catch((e) => send({ id, error: { code: -32603, message: e.message } }));
    } else if (method === 'session/cancel') {
      state.cancelled.add(params.sessionId);
      // pending permission for that session → nothing to do; the client MUST answer 'cancelled'
    } else if (method === 'session/set_config_option') {
      const opts = configOptions();
      const o = opts.find((x) => x.id === params.configId);
      if (!o || !o.options.some((v) => v.value === params.value)) { send({ id, error: { code: -32602, message: `invalid ${params.configId} value ${params.value}` } }); continue; }
      if (params.configId === 'model') state.model = params.value; else state.mode = params.value;
      send({ id, result: { configOptions: configOptions() } });
      if (params.configId === 'mode') update(params.sessionId, { sessionUpdate: 'current_mode_update', modeId: state.mode });
    } else if (method === 'session/set_mode') {
      state.mode = params.modeId;
      send({ id, result: {} });
      update(params.sessionId, { sessionUpdate: 'current_mode_update', modeId: state.mode });
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
