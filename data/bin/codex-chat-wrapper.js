#!/usr/bin/env node
// Codex chat wrapper — runs inside dtach, spawns `codex app-server`,
// persists a line-oriented event stream compatible with Codex session JSONL,
// and bridges stdin commands from the WebUI to JSON-RPC requests.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const bufferFile = process.argv[2];
const metaFile = process.argv[3];
const cmd = process.argv[4];
const args = process.argv.slice(5);
const logFile = path.join(path.dirname(bufferFile || '/tmp/codex-chat-wrapper'), 'codex-chat-wrapper.log');

function log(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function writeRecord(record) {
  const line = JSON.stringify(record);
  buffer += `${line}\n`;
  if (buffer.length > MAX_BUFFER) {
    const idx = buffer.indexOf('\n', buffer.length - MAX_BUFFER);
    if (idx > 0) buffer = buffer.slice(idx + 1);
  }
  try { process.stdout.write(`${line}\n`); } catch {}
  schedulePersist();
}

function now() {
  return new Date().toISOString();
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function oneLine(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function normalizeNestedAnswers(value) {
  const source = value && typeof value === 'object' ? value : {};
  const answers = {};
  for (const [key, entry] of Object.entries(source)) {
    if (Array.isArray(entry)) {
      answers[key] = { answers: entry.map((item) => String(item)) };
      continue;
    }
    if (entry && typeof entry === 'object' && Array.isArray(entry.answers)) {
      answers[key] = { answers: entry.answers.map((item) => String(item)) };
    }
  }
  return answers;
}

function describeServerRequestDecision(decision) {
  if (typeof decision === 'string') return decision;
  if (decision && typeof decision === 'object') {
    if (decision.acceptWithExecpolicyAmendment) return 'acceptWithExecpolicyAmendment';
  }
  return 'decline';
}

function encodeUserInput(text, attachments) {
  const items = [];
  if (text) items.push({ type: 'text', text });
  for (const item of attachments || []) {
    if (item?.type === 'input_image' && item.image_url) items.push({ type: 'image', url: item.image_url });
    if (item?.type === 'local_image' && item.path) items.push({ type: 'localImage', path: item.path });
    if (item?.type === 'skill' && item.path && item.name) items.push({ type: 'skill', path: item.path, name: item.name });
    if (item?.type === 'mention' && item.path && item.name) items.push({ type: 'mention', path: item.path, name: item.name });
  }
  return items;
}

function normalizeChatInput(rawText) {
  let text = typeof rawText === 'string' ? rawText : '';
  const attachments = [];
  const parsed = safeJsonParse(text);
  if (parsed?.type === 'user' && parsed.message) {
    text = '';
    for (const block of parsed.message.content || []) {
      if (block.type === 'text' && block.text) text = block.text;
      if (block.type === 'image' && block.source?.data) {
        attachments.push({
          type: 'input_image',
          image_url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`,
        });
      }
    }
  }
  return { text, attachments };
}

function resolvePermissionMode(mode) {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
    case 'safe-yolo':
      return { approvalPolicy: 'on-failure', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } };
  }
}

function formatToolName(name) {
  if (name === 'spawnAgent') return 'spawn_agent';
  if (name === 'sendInput') return 'send_input';
  if (name === 'resumeAgent') return 'resume_agent';
  if (name === 'wait') return 'wait_agent';
  if (name === 'closeAgent') return 'close_agent';
  return name || 'tool';
}

function normalizeOutput(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

if (!bufferFile || !metaFile || !cmd) {
  log('Missing required arguments');
  process.exit(1);
}

const clientInfo = {
  name: 'claude-code-webui',
  title: 'Claude Code WebUI',
  version: '2.0.0',
};

const sessionName = process.env.CODEX_WEBUI_SESSION_NAME || '';
const resumeId = process.env.CODEX_WEBUI_RESUME_ID || '';
const model = process.env.CODEX_WEBUI_MODEL || '';
const effort = process.env.CODEX_WEBUI_EFFORT || '';
const backendPermissionMode = process.env.CODEX_WEBUI_PERMISSION_MODE || 'default';
const baseCwd = process.env.CODEX_WEBUI_CWD || process.cwd();
let permissionMode = backendPermissionMode;
let currentPermission = resolvePermissionMode(permissionMode);

const meta = {
  pid: process.pid,
  startedAt: Date.now(),
  mode: 'chat',
  backend: 'codex',
  cwd: baseCwd,
  threadId: resumeId || null,
  threadName: sessionName || null,
  activeTurnId: null,
  streaming: false,
  model: model || '',
  modelProvider: 'openai',
  permissionMode,
  approvalPolicy: currentPermission.approvalPolicy,
  sandbox: currentPermission.sandbox,
  effort: effort || '',
  tasks: {},
  pendingRequests: {},
  subagentMetas: [],
};

let buffer = '';
const MAX_BUFFER = 800000;
let writeTimer = null;
let metaTimer = null;
let nextId = 1;
let pendingRequests = new Map();
let pendingServerRequests = new Map();
let child = null;
let stdoutBuf = '';
let stdinBuf = '';
let currentTurnId = null;
let lastReasoningByItem = new Map();
let lastAgentDeltaByItem = new Map();
let lastCommandDeltaByItem = new Map();
let itemState = new Map();
let markReady = null;
let markReadyFailed = null;
const readyPromise = new Promise((resolve, reject) => {
  markReady = resolve;
  markReadyFailed = reject;
});

function persistBuffer() {
  writeTimer = null;
  try {
    fs.mkdirSync(path.dirname(bufferFile), { recursive: true });
    fs.writeFileSync(bufferFile, buffer);
  } catch {}
}

function persistMeta() {
  metaTimer = null;
  try {
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify(meta));
  } catch {}
}

function schedulePersist() {
  if (!writeTimer) writeTimer = setTimeout(persistBuffer, 1000);
}

function scheduleMeta() {
  if (!metaTimer) metaTimer = setTimeout(persistMeta, 200);
}

function send(payload) {
  if (!child?.stdin?.writable) return;
  const line = JSON.stringify(payload);
  child.stdin.write(`${line}\n`);
}

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
  });
}

function notify(method, params) {
  send({ method, params });
}

function record(type, payload) {
  writeRecord({ timestamp: now(), type, payload });
}

function resolveThreadName(payload = {}) {
  return asString(
    payload?.thread?.name
    || payload?.name
    || payload?.threadName
    || payload?.session_name
    || payload?.sessionName,
  );
}

function updateMetaFromThread(resp) {
  const thread = resp?.thread || {};
  const threadId = thread.id || meta.threadId;
  const threadSource = thread.source || 'appServer';
  const threadName = resolveThreadName(resp) || resolveThreadName(thread) || meta.threadName || sessionName;
  meta.threadId = threadId;
  meta.threadName = threadName || null;
  meta.model = resp?.model || thread.model || meta.model;
  meta.modelProvider = resp?.modelProvider || thread.modelProvider || meta.modelProvider;
  meta.cwd = resp?.cwd || thread.cwd || meta.cwd;
  meta.approvalPolicy = typeof resp?.approvalPolicy === 'string' ? resp.approvalPolicy : meta.approvalPolicy;
  meta.permissionMode = permissionMode;
  if (resp?.reasoningEffort) meta.effort = resp.reasoningEffort;
  record('session_meta', {
    id: threadId,
    timestamp: now(),
    cwd: meta.cwd,
    originator: 'webui',
    cli_version: process.env.CODEX_WEBUI_CLI_VERSION || null,
    source: threadSource,
    model: meta.model,
    model_provider: meta.modelProvider,
    session_name: meta.threadName,
    agent_role: thread.agentRole || null,
    agent_nickname: thread.agentNickname || null,
  });
  record('wrapper_meta', {
    threadId: meta.threadId,
    threadName: meta.threadName,
    model: meta.model,
    permissionMode: meta.permissionMode,
    approvalPolicy: meta.approvalPolicy,
    sandbox: meta.sandbox,
    contextWindow: meta.contextWindow || 0,
  });
  scheduleMeta();
}

function buildTurnContext(turnId) {
  return {
    turn_id: turnId,
    cwd: meta.cwd,
    approval_policy: currentPermission.approvalPolicy,
    sandbox_policy: currentPermission.sandboxPolicy,
    model: meta.model || model || '',
    effort: effort || null,
    summary: 'none',
  };
}

function emitTaskEvent(type, payload = {}) {
  record('event_msg', { type, ...payload });
}

function trackTask(callId, patch) {
  if (!callId) return;
  meta.tasks[callId] = { ...(meta.tasks[callId] || {}), ...patch };
  scheduleMeta();
}

function handleItemStarted(item, itemId) {
  const type = item.type;
  itemState.set(itemId, { type, item, startedAt: Date.now() });
  if (type === 'commandExecution') {
    const command = asString(item.command) || asArray(item.command).join(' ');
    const input = { command, cwd: item.cwd || meta.cwd };
    record('response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify(input),
      call_id: itemId,
    });
    emitTaskEvent('exec_command_begin', { call_id: itemId, command, cwd: item.cwd || meta.cwd });
    return;
  }
  if (type === 'fileChange') {
    const input = { reason: item.reason || '', changes: item.changes || null, grantRoot: item.grantRoot || null };
    record('response_item', {
      type: 'function_call',
      name: 'apply_patch',
      arguments: JSON.stringify(input),
      call_id: itemId,
    });
    emitTaskEvent('patch_apply_begin', { call_id: itemId, reason: item.reason || '' });
    return;
  }
  if (type === 'collabAgentToolCall') {
    const tool = formatToolName(item.tool);
    const input = { ...(item.input || {}), receiverThreadIds: item.receiverThreadIds || [] };
    record('response_item', {
      type: 'function_call',
      name: tool,
      arguments: JSON.stringify(input),
      call_id: itemId,
    });
    emitTaskEvent('collab_agent_begin', {
      call_id: itemId,
      tool,
      description: item.agentNickname || item.agentRole || oneLine(item.input?.description || ''),
      receiver_thread_ids: item.receiverThreadIds || [],
      agent_role: item.agentRole || '',
      agent_nickname: item.agentNickname || '',
    });
    if (tool === 'spawn_agent') {
      const metas = (item.receiverThreadIds || []).map((threadId) => ({
        threadId,
        description: item.input?.description || item.agentNickname || 'Agent',
        agentNickname: item.agentNickname || '',
        agentRole: item.agentRole || '',
      }));
      if (metas.length) {
        meta.subagentMetas = [...meta.subagentMetas.filter((entry) => !metas.some((m) => m.threadId === entry.threadId)), ...metas];
        scheduleMeta();
      }
    }
    trackTask(itemId, {
      id: itemId,
      type: 'agent',
      description: item.input?.description || item.agentNickname || item.agentRole || 'Agent',
      status: 'running',
      receiverThreadIds: item.receiverThreadIds || [],
    });
    return;
  }
  if (type === 'enteredReviewMode') {
    emitTaskEvent('entered_review_mode', { item_id: itemId });
    return;
  }
  if (type === 'exitedReviewMode') {
    emitTaskEvent('exited_review_mode', { item_id: itemId });
  }
}

function handleItemCompleted(item, itemId) {
  const state = itemState.get(itemId) || {};
  const type = state.type || item.type;
  if (type === 'agentMessage') {
    const contentText = asArray(item.content)
      .filter((entry) => entry.type === 'output_text' || entry.type === 'text')
      .map((entry) => entry.text || '')
      .join('');
    const text = asString(item.text) || contentText;
    if (text) {
      record('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
        phase: item.phase || null,
        item_id: itemId,
      });
    }
    meta.streaming = false;
    scheduleMeta();
    return;
  }
  if (type === 'reasoning') {
    const reasoningText = lastReasoningByItem.get(itemId) || '';
    if (reasoningText) {
      record('response_item', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: reasoningText }],
        content: null,
        item_id: itemId,
      });
    }
    return;
  }
  if (type === 'commandExecution') {
    const output = normalizeOutput(item.aggregatedOutput || item.output || item.result || '');
    record('response_item', {
      type: 'function_call_output',
      call_id: itemId,
      output,
      is_error: (item.status && item.status !== 'completed') || !!item.error,
    });
    emitTaskEvent('exec_command_end', {
      call_id: itemId,
      output,
      error: item.error || null,
      status: item.status || '',
      exit_code: item.exitCode ?? item.exit_code ?? null,
    });
    return;
  }
  if (type === 'fileChange') {
    const output = normalizeOutput(item.aggregatedOutput || item.output || item.result || '');
    record('response_item', {
      type: 'function_call_output',
      call_id: itemId,
      output,
      is_error: item.success === false || !!item.error,
    });
    emitTaskEvent('patch_apply_end', {
      call_id: itemId,
      output,
      success: item.success !== false,
      changes: item.changes || null,
      error: item.error || null,
      status: item.status || '',
    });
    return;
  }
  if (type === 'collabAgentToolCall') {
    const output = normalizeOutput(item.output || item.result || item.message || '');
    record('response_item', {
      type: 'function_call_output',
      call_id: itemId,
      output,
      is_error: item.status === 'failed' || !!item.error,
    });
    emitTaskEvent('collab_agent_end', {
      call_id: itemId,
      output,
      status: item.status || '',
      receiver_thread_ids: item.receiverThreadIds || [],
    });
    trackTask(itemId, { status: item.status === 'failed' ? 'failed' : 'completed', resultText: output });
  }
}

function handleNotification(method, params) {
  if (method === 'thread/started' || method === 'thread/resumed') {
    updateMetaFromThread(params || {});
    return;
  }
  if (method === 'thread/status/changed') return;
  if (method === 'thread/name/updated') {
    updateMetaFromThread({ thread: { id: params?.threadId || meta.threadId, name: resolveThreadName(params) } });
    return;
  }
  if (method === 'turn/plan/updated') return;
  if (method === 'account/rateLimits/updated') return;
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = params?.tokenUsage || params?.token_usage || params || {};
    meta.lastTokenUsage = tokenUsage.last_token_usage || tokenUsage.lastTokenUsage || meta.lastTokenUsage || null;
    meta.contextWindow = tokenUsage.model_context_window || tokenUsage.modelContextWindow || meta.contextWindow || 0;
    meta.rateLimits = params?.rateLimits || meta.rateLimits || null;
    meta.rateLimitsFetchedAt = Date.now();
    emitTaskEvent('token_count', { info: tokenUsage, rate_limits: params?.rateLimits || null });
    scheduleMeta();
    return;
  }
  if (method === 'turn/started') {
    currentTurnId = params?.turn?.id || params?.turnId || params?.id || currentTurnId;
    meta.activeTurnId = currentTurnId;
    meta.streaming = true;
    record('turn_context', buildTurnContext(currentTurnId));
    emitTaskEvent('task_started', { turn_id: currentTurnId, model_context_window: meta.contextWindow || 0 });
    scheduleMeta();
    return;
  }
  if (method === 'turn/completed') {
    const status = params?.status || params?.turn?.status || 'completed';
    meta.activeTurnId = null;
    meta.streaming = false;
    if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') emitTaskEvent('turn_aborted', { turn_id: currentTurnId });
    else if (status === 'failed' || status === 'error') emitTaskEvent('task_failed', { turn_id: currentTurnId, error: params?.error || params?.message || '' });
    else emitTaskEvent('task_complete', { turn_id: currentTurnId, last_agent_message: '' });
    currentTurnId = null;
    scheduleMeta();
    return;
  }
  if (method === 'item/agentMessage/delta') {
    const itemId = params?.itemId || params?.item_id || params?.id || 'agent';
    const delta = asString(params?.delta || params?.text || params?.message);
    if (!delta) return;
    lastAgentDeltaByItem.set(itemId, (lastAgentDeltaByItem.get(itemId) || '') + delta);
    emitTaskEvent('agent_message_delta', { item_id: itemId, delta });
    meta.streaming = true;
    scheduleMeta();
    return;
  }
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const itemId = params?.itemId || params?.item_id || params?.id || 'reasoning';
    const delta = asString(params?.delta || params?.text || params?.message);
    if (!delta) return;
    lastReasoningByItem.set(itemId, (lastReasoningByItem.get(itemId) || '') + delta);
    emitTaskEvent('agent_reasoning_delta', { item_id: itemId, delta });
    return;
  }
  if (method === 'item/reasoning/summaryPartAdded') {
    const itemId = params?.itemId || params?.item_id || params?.id || 'reasoning';
    emitTaskEvent('agent_reasoning_section_break', { item_id: itemId });
    return;
  }
  if (method === 'item/commandExecution/outputDelta') {
    const itemId = params?.itemId || params?.item_id || params?.id;
    const delta = asString(params?.delta || params?.output || params?.stdout);
    if (!itemId || !delta) return;
    lastCommandDeltaByItem.set(itemId, (lastCommandDeltaByItem.get(itemId) || '') + delta);
    emitTaskEvent('exec_command_output_delta', { call_id: itemId, delta });
    return;
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = params?.item || params || {};
    const itemId = params?.itemId || params?.item_id || item.id;
    if (!itemId) return;
    if (method === 'item/started') handleItemStarted(item, itemId);
    else handleItemCompleted(item, itemId);
    return;
  }
  if (method === 'error') {
    emitTaskEvent('task_failed', { error: params?.message || params?.error?.message || 'Unknown error' });
  }
}

async function startThread() {
  const params = {
    cwd: baseCwd,
    approvalPolicy: currentPermission.approvalPolicy,
    sandbox: currentPermission.sandbox,
    personality: 'pragmatic',
  };
  if (model) params.model = model;
  if (sessionName) params.config = { 'thread.name': sessionName };
  const method = resumeId ? 'thread/resume' : 'thread/start';
  if (resumeId) params.threadId = resumeId;
  const resp = await request(method, params, 120000);
  updateMetaFromThread(resp || {});
}

async function startTurn(text, attachments = []) {
  if (!meta.threadId) throw new Error('No threadId available for turn/start');
  const input = encodeUserInput(text, attachments);
  if (!input.length) return;
  const resp = await request('turn/start', {
    threadId: meta.threadId,
    input,
    cwd: meta.cwd,
    approvalPolicy: currentPermission.approvalPolicy,
    sandboxPolicy: currentPermission.sandboxPolicy,
    model: meta.model || undefined,
    effort: effort || undefined,
    personality: 'pragmatic',
  }, 120000);
  currentTurnId = resp?.turn?.id || currentTurnId;
  meta.activeTurnId = currentTurnId;
  meta.streaming = true;
  scheduleMeta();
}

async function respondToServerRequest(msg) {
  const requestId = msg.requestId;
  const original = pendingServerRequests.get(String(requestId));
  if (!original) return;
  const method = original.method;
  let result = { decision: 'decline' };

  if (method === 'item/tool/requestUserInput') {
    if (msg.responseData?.decision === 'accept') {
      const answers = normalizeNestedAnswers(msg.responseData.answers || {});
      result = Object.keys(answers).length > 0
        ? { decision: 'accept', answers }
        : { decision: 'cancel' };
    } else {
      result = { decision: msg.abort ? 'cancel' : 'decline' };
    }
  } else if (msg.approved) {
    if (Array.isArray(msg.permissionUpdates) && msg.permissionUpdates.length > 0 && original.params?.proposedExecpolicyAmendment) {
      result = {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: msg.permissionUpdates,
          },
        },
      };
    } else {
      result = { decision: msg.alwaysAllow ? 'acceptForSession' : 'accept' };
    }
  } else {
    result = { decision: msg.abort ? 'cancel' : 'decline' };
  }

  send({ id: requestId, result });
  record('server_request_resolved', {
    id: requestId,
    decision: describeServerRequestDecision(result.decision),
    answers: result.answers || null,
  });
  delete meta.pendingRequests[String(requestId)];
  pendingServerRequests.delete(String(requestId));
  scheduleMeta();
}

async function setPermissionMode(mode) {
  permissionMode = mode || 'default';
  currentPermission = resolvePermissionMode(permissionMode);
  meta.permissionMode = permissionMode;
  meta.approvalPolicy = currentPermission.approvalPolicy;
  meta.sandbox = currentPermission.sandbox;
  record('wrapper_meta', {
    threadId: meta.threadId,
    model: meta.model,
    permissionMode: meta.permissionMode,
    approvalPolicy: meta.approvalPolicy,
    sandbox: meta.sandbox,
    contextWindow: meta.contextWindow || 0,
  });
  scheduleMeta();
}

async function handleInput(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'set-permission-mode') await readyPromise;
  if (msg.type === 'chat-input') {
    const normalized = normalizeChatInput(msg.text || '');
    const attachments = [...normalized.attachments, ...(msg.attachments || [])];
    const text = normalized.text || '';
    record('response_item', {
      type: 'message',
      role: 'user',
      webui_msg_id: msg.msgId || '',
      content: [
        ...attachments.map((item) => ({ type: 'input_image', image_url: item.image_url })),
        ...(text ? [{ type: 'input_text', text }] : []),
      ],
    });
    await startTurn(text, attachments);
    return;
  }
  if (msg.type === 'interrupt') {
    if (meta.threadId && meta.activeTurnId) {
      await request('turn/interrupt', { threadId: meta.threadId, turnId: meta.activeTurnId }, 30000).catch(() => {});
    }
    return;
  }
  if (msg.type === 'permission-response') {
    await respondToServerRequest(msg);
    return;
  }
  if (msg.type === 'set-permission-mode') {
    await setPermissionMode(msg.mode);
    return;
  }
  if (msg.type === 'review-start') {
    if (!meta.threadId) throw new Error('No threadId available for review/start');
    const target = msg.target;
    if (!target || typeof target !== 'object') throw new Error('Missing review target');
    const delivery = msg.delivery || undefined;
    const response = await request('review/start', {
      threadId: meta.threadId,
      target,
      delivery,
    }, 120000);
    emitTaskEvent('review_started', {
      review_thread_id: response?.reviewThreadId || meta.threadId,
      delivery: delivery || 'inline',
      target,
    });
    return;
  }
  if (msg.type === 'set-thread-name') {
    if (!meta.threadId) throw new Error('No threadId available for thread/name/set');
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    const response = await request('thread/name/set', { threadId: meta.threadId, name }, 30000);
    updateMetaFromThread(response || { thread: { id: meta.threadId, name } });
  }
}

function handleStdoutLine(line) {
  const msg = safeJsonParse(line);
  if (!msg) return;

  if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || `JSON-RPC ${msg.id} failed`));
    else pending.resolve(msg.result);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.method) {
    pendingServerRequests.set(String(msg.id), msg);
    meta.pendingRequests[String(msg.id)] = { id: msg.id, method: msg.method, params: msg.params || {} };
    record('server_request', { id: msg.id, method: msg.method, params: msg.params || {} });
    scheduleMeta();
    return;
  }

  if (msg.method) {
    handleNotification(msg.method, msg.params || {});
  }
}

async function boot() {
  try {
    fs.mkdirSync(path.dirname(bufferFile), { recursive: true });
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  } catch {}
  persistMeta();

  child = spawn(cmd, args, {
    cwd: baseCwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  meta.childPid = child.pid;
  scheduleMeta();
  log(`spawned ${cmd} ${args.join(' ')} pid=${child.pid}`);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      handleStdoutLine(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = chunk.trim();
    if (text) log(`[stderr] ${text}`);
  });

  // Match the Claude wrapper: raw mode avoids PTY line buffering/truncation
  // when the server sends large JSON lines (for example base64 image turns).
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    let idx;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      const line = stdinBuf.slice(0, idx).replace(/\r/g, '').trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      const msg = safeJsonParse(line);
      if (!msg) continue;
      handleInput(msg).catch((err) => {
        log(`stdin handler error: ${err.message}`);
        record('event_msg', { type: 'task_failed', error: err.message });
      });
    }
  });

  child.on('exit', (code) => {
    meta.streaming = false;
    meta.activeTurnId = null;
    scheduleMeta();
    if (writeTimer) clearTimeout(writeTimer);
    if (metaTimer) clearTimeout(metaTimer);
    persistBuffer();
    persistMeta();
    log(`child exited code=${code}`);
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    log(`child error: ${err.message}`);
    record('event_msg', { type: 'task_failed', error: err.message });
  });

  await request('initialize', { clientInfo, capabilities: { experimentalApi: true } }, 30000);
  notify('initialized');
  await startThread();
  markReady?.();
}

boot().catch((err) => {
  markReadyFailed?.(err);
  log(`boot failed: ${err.message}\n${err.stack || ''}`);
  record('event_msg', { type: 'task_failed', error: err.message });
  if (writeTimer) clearTimeout(writeTimer);
  if (metaTimer) clearTimeout(metaTimer);
  persistBuffer();
  persistMeta();
  process.exit(1);
});

readyPromise.catch(() => {});
