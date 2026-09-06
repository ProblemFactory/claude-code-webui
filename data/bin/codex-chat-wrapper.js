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
  try {
    // Rotate at 5MB (shared by all sessions' wrappers, grew without bound)
    try { if (fs.statSync(logFile).size > 5242880) fs.renameSync(logFile, logFile + '.old'); } catch {}
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
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

// A stdin line the wrapper cannot parse is a LOST USER MESSAGE (the pty/dtach
// channel shreds multi-hundred-KB single lines — mid-line bytes and the
// newline drop, the remains glue onto the next send). It used to be a silent
// `continue`; the user saw nothing and codex never got the text. Log it AND
// surface a task_failed event (rendered as a system error card by
// CodexMessageManager, same channel as every other stdin-handler failure).
// Only a short prefix is quoted: the line may carry base64 image data.
function rejectStdinLine(line) {
  const head = line.slice(0, 48).replace(/\s+/g, ' ');
  log(`stdin line unparseable (${line.length} bytes, starts ${JSON.stringify(head)}) — dropped, NOT sent to codex`);
  record('event_msg', {
    type: 'task_failed',
    error: `Your message did not reach codex: the input line was corrupted in transit (${line.length} bytes, unparseable) — please send it again.`,
  });
}

// `_frame_file` (mirrors data/bin/chat-wrapper.js): the server writes a big
// frame (>64KB — image pastes) to data/chat-frames/<id>-<ts>.json and sends
// only {type:'_frame_file', path} on stdin; the file holds EXACTLY the JSON
// line the server would otherwise have written on stdin (a 'chat-input'
// frame from CodexAdapter.formatChatInput today, any stdin verb in principle).
// Read → unlink (always, even on failure — never leave orphans) → must parse
// as ONE object → dispatched as if it had arrived on stdin. A nested pointer
// is refused (no recursion, no arbitrary-file reads). Any failure is LOUD.
function loadFrameFile(msg) {
  const fp = typeof msg.path === 'string' ? msg.path : '';
  let body = null, err = null;
  try { body = fs.readFileSync(fp, 'utf8').trim(); } catch (e) { err = 'read failed: ' + e.message; }
  try { if (fp) fs.unlinkSync(fp); } catch {}
  let payload = null;
  if (!err) {
    payload = safeJsonParse(body);
    if (!payload || typeof payload !== 'object') err = `not ONE valid JSON frame (${body.length} bytes)`;
    else if (payload.type === '_frame_file') err = 'nested _frame_file pointer refused';
  }
  if (err) {
    log(`frame-file ${path.basename(fp || '(no path)')} ${err} — dropped, NOT sent to codex`);
    record('event_msg', {
      type: 'task_failed',
      error: `Your message did not reach codex: its frame file could not be delivered (${err}) — please send it again.`,
    });
    return null;
  }
  log(`frame-file ${path.basename(fp)} delivered (${body.length} bytes, type ${payload.type || '?'})`);
  return payload;
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

// LOOPBACK MUST STAY OPEN (2.369.17, P0 of docs/design-harness-plugins.md §1):
// codex's sandbox network policy defaults to networkAccess:false, which the
// seccomp filter enforces on 127.0.0.1 too (measured: connect → EPERM,
// CODEX_SANDBOX_NETWORK_DISABLED=1; AF_UNIX is blocked as well). Every
// vibespace-* agent tool POSTs to VIBESPACE_API on loopback, so without this
// flag the agent is taught tools that cannot run and the Stop nudge keeps
// asking for bookkeeping it cannot do. Filesystem sandboxing is unchanged;
// only network egress from the sandboxed process is opened, and only when
// the VibeSpace integration is on (VIBESPACE_API set by the spawner).
const NET_OPEN = !!process.env.VIBESPACE_API;
function resolvePermissionMode(mode) {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: NET_OPEN } };
    case 'safe-yolo':
      return { approvalPolicy: 'on-failure', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: NET_OPEN } };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: NET_OPEN } };
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
// meta.modelPinned (2.369.32): set when the spawn carried a model or set-model ran — see updateMetaFromThread
let effort = process.env.CODEX_WEBUI_EFFORT || ''; // mutable: set-effort updates it mid-session
const backendPermissionMode = process.env.CODEX_WEBUI_PERMISSION_MODE || 'default';
const isFork = process.env.CODEX_WEBUI_FORK === '1';
const forkedFromEnv = process.env.CODEX_WEBUI_FORKED_FROM || '';
const forkedFrom = forkedFromEnv ? forkedFromEnv.split(',').filter(Boolean) : [];
const baseCwd = process.env.CODEX_WEBUI_CWD || process.cwd();
// ── REMOTE MODE (2.139.0, B-0588 — mirrors chat-wrapper.js 2.124.0) ──
// env VIBESPACE_REMOTE_SID set by the server for remote codex chat: the child
// is `ssh → vibespace-remote-keeper run <sid> __VS_OFFSET__ -- codex app-server`.
// The keeper is a content-agnostic byte pipe, so bidirectional JSON-RPC rides
// it fine; byte-offset replay redelivers missed responses/server-requests
// exactly once. The HANDSHAKE (initialize/startThread) runs ONCE per wrapper
// lifetime — a transport reconnect respawns ssh only, never re-initializes
// (the remote app-server keeps its state; re-running thread/start would fork).
const REMOTE_SID = process.env.VIBESPACE_REMOTE_SID || '';
let remoteOffset = 0;      // bytes consumed from the keeper buffer (byte-exact)
let remoteExited = null;   // set by the _remote_exit sentinel = codex REALLY ended
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;
const outQueue = [];       // outbound JSON-RPC lines queued while the pipe is down
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
  // Capability advert (the 2.361.1/2.364.1 law: features gate on what THIS
  // process declares in the file THIS process writes, never on version guesses).
  // frameFile: the server may hand >64KB chat frames over as a `_frame_file`
  // pointer line (design-harness-plugins §1 P1 — the bypass used to exclude
  // codex BY BACKEND ID, so a multi-image paste rode raw pty stdin and could
  // be shredded exactly like the 79928a2b claude poisoning, silently).
  caps: { peerMessage: true, frameFile: true },
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
  const line = JSON.stringify(payload);
  if (!child?.stdin?.writable) {
    // remote: the ssh pipe is down — queue and flush after reconnect (the old
    // silent drop lost approvals/turn starts). Local: preserve old behavior.
    if (REMOTE_SID && !shuttingDown && outQueue.length < 200) outQueue.push(line);
    return;
  }
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
  // a model the USER chose (spawn env or set-model) is pinned: the app-server's
  // thread.model is the thread's START model and must not silently revert a
  // mid-conversation switch on resume/rename (2.369.32, owner report)
  meta.model = meta.modelPinned ? (meta.model || resp?.model || thread.model || '') : (resp?.model || thread.model || meta.model);
  meta.modelProvider = resp?.modelProvider || thread.modelProvider || meta.modelProvider;
  meta.cwd = resp?.cwd || thread.cwd || meta.cwd;
  meta.approvalPolicy = typeof resp?.approvalPolicy === 'string' ? resp.approvalPolicy : meta.approvalPolicy;
  meta.permissionMode = permissionMode;
  if (resp?.reasoningEffort) meta.effort = resp.reasoningEffort;
  // EXPLICIT EFFORT ON EVERY TURN (B-21e4 item 4, the effort twin of the
  // modelPinned rule): with no COMMANDED effort (spawn env / set-effort) adopt
  // the thread's own current effort from the start/resume/fork response
  // (`reasoningEffort`, 0.153.4 bindings) so every turn/start carries an
  // explicit `effort` — the app-server's per-thread defaults can then never
  // flip a resumed conversation (0.153.4: gpt-6-astra defaults to LOW when
  // config.toml names no model). A later set-effort still wins (it rewrites
  // `effort`); a set-effort back to '' deliberately hands the choice back.
  if (!effort && typeof resp?.reasoningEffort === 'string' && resp.reasoningEffort) { effort = resp.reasoningEffort; meta.effortAdopted = effort; }
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
    permissionMode: meta.permissionMode,
    // Newer codex resumes keep the SAME thread id (no fork) — the env chain
    // built at spawn assumed a fork and includes the resume target, so drop
    // our own id to avoid a self-referencing fork chain (it made discovery
    // hide the thread from the session list after termination)
    forked_from: (() => { const c = [...new Set(forkedFrom)].filter((id) => id !== meta.threadId); return c.length ? c : undefined; })(),
    // codex's OWN fork parent (thread/fork → Thread.forkedFromId in the 0.153.4
    // bindings), echoed so the wrapper's copy of the meta names it too. The
    // fork BOUNDARY ordinal is not on the wire — the rollout's own session_meta
    // (history_base / forked_from_ordinal_exclusive) is its only source and
    // extractCodexThreadMeta reads it from the file.
    forked_from_id: thread.forkedFromId || thread.forked_from_id || undefined,
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
    slashCommands: SLASH_COMMANDS, // the wrapper-served commands (chat-input autocomplete)
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
    modelPinned: !!model,
    effort: effort || null,
    summary: 'none',
  };
}

function emitTaskEvent(type, payload = {}) {
  record('event_msg', { type, ...payload });
}

function trackTask(callId, patch) {
  if (!callId) return;
  const next = { ...(meta.tasks[callId] || {}), ...patch };
  // Completed/failed tasks are dropped (mirrors chat-wrapper, which deletes on
  // task_notification) — meta is re-serialized to disk on every change, so a
  // monotonically growing tasks map made each write larger forever
  if (next.status === 'completed' || next.status === 'failed') delete meta.tasks[callId];
  else meta.tasks[callId] = next;
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
  // LIVE VISIBILITY (P2): MCP / dynamic / web-search / image-view items were
  // only known from the rollout merge on re-attach — a live turn showed
  // minutes of "thinking…" while an MCP call ran. Record them as the
  // function_call / function_call_output twins the normalizer already
  // renders (names chosen so collapseKindOf lands in the right fold kind).
  if (type === 'mcpToolCall') {
    record('response_item', { type: 'function_call', name: `mcp__${item.server || 'mcp'}__${item.tool || 'tool'}`, arguments: JSON.stringify(item.arguments ?? {}), call_id: itemId });
    emitTaskEvent('mcp_tool_call_begin', { call_id: itemId, server: item.server || '', tool: item.tool || '' });
    return;
  }
  if (type === 'dynamicToolCall') {
    record('response_item', { type: 'function_call', name: item.namespace ? `${item.namespace}.${item.tool || 'tool'}` : (item.tool || 'dynamic_tool'), arguments: JSON.stringify(item.arguments ?? {}), call_id: itemId });
    return;
  }
  if (type === 'webSearch') {
    record('response_item', { type: 'function_call', name: 'web_search', arguments: JSON.stringify({ query: item.query || '', action: item.action || null }), call_id: itemId });
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
  try { _handleItemCompletedInner(item, itemId); } finally {
    // Per-item state would otherwise accumulate for the wrapper's lifetime
    itemState.delete(itemId);
    lastReasoningByItem.delete(itemId);
  }
}

function _handleItemCompletedInner(item, itemId) {
  const state = itemState.get(itemId) || {};
  const type = state.type || item.type;
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') {
    if (!state.type) handleItemStarted(item, itemId); // completed without a started (rollout merge / short call)
    const failed = !!item.error || item.status === 'failed' || item.success === false;
    const out = item.error ? (item.error.message || JSON.stringify(item.error)) : (item.result ?? item.contentItems ?? item.results ?? '');
    record('response_item', { type: 'function_call_output', call_id: itemId, output: typeof out === 'string' ? out : JSON.stringify(out), is_error: failed });
    return;
  }
  if (type === 'imageView') {
    record('response_item', { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: item.path || '' }), call_id: itemId });
    record('response_item', { type: 'function_call_output', call_id: itemId, output: `viewed ${item.path || 'image'}`, is_error: false });
    return;
  }
  if (type === 'contextCompaction') {
    compactionSeen = true;
    emitTaskEvent('context_compacted', { item_id: itemId, source: 'item' });
    return;
  }
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
  if (method === 'thread/goal/updated') {
    const goal = params?.goal;
    meta.goal = goal?.objective || null;
    meta.goalStatus = goal?.status || null;
    meta.goalElapsed = (goal?.timeUsedSeconds || goal?.time_used_seconds || 0) * 1000;
    meta.goalTokensUsed = goal?.tokensUsed || goal?.tokens_used || 0;
    scheduleMeta();
    record('event_msg', { type: 'goal_updated', goal });
    return;
  }
  if (method === 'thread/goal/cleared') {
    meta.goal = null;
    meta.goalStatus = null;
    meta.goalElapsed = 0;
    scheduleMeta();
    record('event_msg', { type: 'goal_cleared', threadId: params?.threadId });
    return;
  }
  if (method === 'thread/name/updated') {
    updateMetaFromThread({ thread: { id: params?.threadId || meta.threadId, name: resolveThreadName(params) } });
    return;
  }
  if (method === 'turn/plan/updated') {
    // Codex's plan tool (update_plan) — the analog of Claude's TodoWrite.
    // Forward as plan_updated so the TODO display above the input works for
    // Codex too; persist in meta for attach-time restore.
    const plan = Array.isArray(params?.plan) ? params.plan : [];
    meta.plan = plan;
    scheduleMeta();
    emitTaskEvent('plan_updated', { explanation: params?.explanation || null, plan });
    return;
  }
  if (method === 'account/rateLimits/updated') {
    // This is the ONLY notification that carries rate limits (the old code
    // looked for them on thread/tokenUsage/updated, which has no such field —
    // meta.rateLimits never populated and the taskbar's live path was dead)
    if (params?.rateLimits) {
      meta.rateLimits = params.rateLimits;
      meta.rateLimitsFetchedAt = Date.now();
      scheduleMeta();
      // …and RELAY to the server (P2): the sidecar is display-only — the pool
      // auto-switch / auto-resume engine consumes this stdout event.
      emitTaskEvent('rate_limits_updated', { rateLimits: params.rateLimits });
    }
    return;
  }
  if (method === 'thread/tokenUsage/updated') {
    // v2 protocol shape: { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
    // (the old code read tokenUsage.last_token_usage — a field that doesn't
    // exist — so lastTokenUsage was always null and live context% never updated)
    const tokenUsage = params?.tokenUsage || params?.token_usage || params || {};
    const last = tokenUsage.last || tokenUsage.last_token_usage || tokenUsage.lastTokenUsage || null;
    const total = tokenUsage.total || tokenUsage.total_token_usage || tokenUsage.totalTokenUsage || null;
    meta.lastTokenUsage = last || meta.lastTokenUsage || null;
    meta.totalTokenUsage = total || meta.totalTokenUsage || null;
    meta.contextWindow = tokenUsage.modelContextWindow || tokenUsage.model_context_window || meta.contextWindow || 0;
    // Emit in the rollout-native snake_case shape that all consumers
    // (codex-message-manager, CodexSessionMessages.chatStatus) already parse
    emitTaskEvent('token_count', { info: {
      last_token_usage: last,
      total_token_usage: total,
      model_context_window: meta.contextWindow || null,
    } });
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
    { const doneId = params?.turn?.id || params?.turnId || currentTurnId; if (doneId) { completedTurns.add(doneId); if (completedTurns.size > 50) completedTurns.delete(completedTurns.values().next().value); } }
    const normalEnd = status === 'completed' || status === 'success' || !status;
    meta.activeTurnId = null;
    meta.streaming = false;
    if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') emitTaskEvent('turn_aborted', { turn_id: currentTurnId });
    else if (status === 'failed' || status === 'error') emitTaskEvent('task_failed', { turn_id: currentTurnId, error: params?.error || params?.message || '' });
    else emitTaskEvent('task_complete', { turn_id: currentTurnId, last_agent_message: '' });
    currentTurnId = null;
    // Drop server requests the turn ended without resolving (interrupt/abort) —
    // they can never be answered now, but used to persist in meta forever and
    // resurface as stale permission prompts on attach
    for (const [rid] of pendingServerRequests) {
      record('server_request_resolved', { id: rid, decision: 'stale_turn_end', answers: null });
      delete meta.pendingRequests[String(rid)];
    }
    pendingServerRequests.clear();
    scheduleMeta();

    // Stop-equivalent bookkeeping nudge (codex has no blockable Stop hook in
    // JSON-RPC mode — the wrapper's turn/completed IS the stop point). The
    // server gates by status freshness + a 30min cooldown; the nudge turn
    // itself must never re-nudge (nudgeTurnActive).
    if (nudgeTurnActive) { nudgeTurnActive = false; }
    else if (normalEnd) maybeStopNudge();
    // Refresh goal state after each turn (time_used_seconds updated in DB)
    if (meta.goal && meta.threadId) {
      request('thread/goal/get', { threadId: meta.threadId }, 5000).then(resp => {
        const g = resp?.goal;
        if (g) {
          meta.goalStatus = g.status || meta.goalStatus;
          meta.goalElapsed = (g.timeUsedSeconds || g.time_used_seconds || 0) * 1000;
          meta.goalTokensUsed = g.tokensUsed || g.tokens_used || 0;
          if (g.status === 'complete' || g.status === 'blocked') meta.goal = null;
          scheduleMeta();
          record('event_msg', { type: 'goal_updated', goal: g });
        }
      }).catch(() => {});
    }
    return;
  }
  if (method === 'item/agentMessage/delta') {
    const itemId = params?.itemId || params?.item_id || params?.id || 'agent';
    const delta = asString(params?.delta || params?.text || params?.message);
    if (!delta) return;
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
    // The typed enum (codex_error_info: usage_limit_reached / quota_exceeded /
    // unauthorized / …) used to be DROPPED here — it is the exhaustion signal
    // the pool auto-switch gates on (P2). Both casings, defensively; the
    // UsageLimitReachedError family also carries resets_at + a rate_limits
    // snapshot — forward whatever is present.
    emitTaskEvent('task_failed', {
      error: params?.message || params?.error?.message || 'Unknown error',
      codexErrorInfo: params?.codexErrorInfo ?? params?.codex_error_info ?? params?.error?.codexErrorInfo ?? params?.error?.codex_error_info ?? null,
      resetsAt: params?.resetsAt ?? params?.resets_at ?? params?.error?.resetsAt ?? params?.error?.resets_at ?? null,
      rateLimits: params?.rateLimits ?? params?.rate_limits ?? params?.error?.rateLimits ?? null,
    });
  }
}

// Proactive quota read: one JSON-RPC on the EXISTING app-server child — the
// official client makes the fetch (§ban-safety: same class as claude's ⟳
// get_usage; runs once at startup + on explicit request, never a timer).
// Response carries rate limits AND rateLimitResetCredits.availableCount —
// the ONLY channel the stored-reset count arrives on (the passive
// account/rateLimits/updated push has no credits field).
async function readAccountLimits(onDemand = false) {
  try {
    const r = await request('account/rateLimits/read', {}, 20000);
    const rl = r?.rateLimits || r?.rate_limits || null;
    const credits = r?.rateLimitResetCredits || r?.rate_limit_reset_credits || null;
    if (rl) { meta.rateLimits = rl; meta.rateLimitsFetchedAt = Date.now(); }
    if (credits) meta.rateLimitResetCredits = credits;
    scheduleMeta();
    emitTaskEvent('rate_limits_updated', { rateLimits: rl, resetCredits: credits, onDemand });
  } catch (e) { if (onDemand) emitTaskEvent('rate_limits_updated', { error: String(e.message || e), onDemand: true }); }
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
  const method = resumeId ? (isFork ? 'thread/fork' : 'thread/resume') : 'thread/start';
  if (resumeId) params.threadId = resumeId;
  const resp = await request(method, params, 120000);
  updateMetaFromThread(resp || {});

  // Query goal state from app-server (authoritative source)
  if (meta.threadId) {
    try {
      const goalResp = await request('thread/goal/get', { threadId: meta.threadId }, 10000);
      const goal = goalResp?.goal;
      if (goal) {
        meta.goal = goal.objective || null;
        meta.goalStatus = goal.status || null;
        meta.goalElapsed = (goal.timeUsedSeconds || goal.time_used_seconds || 0) * 1000;
        meta.goalTokensUsed = goal.tokensUsed || goal.tokens_used || 0;
        log(`Goal from thread/goal/get: status=${meta.goalStatus} elapsed=${meta.goalElapsed}ms tokens=${meta.goalTokensUsed} objective=${(meta.goal || '').substring(0, 60)}`);
        // Emit immediately so the server learns the restored goal NOW.
        // Resuming a thread with an active goal auto-continues (Codex design)
        // — without this event the status bar stayed empty for the entire
        // first turn (the only other emit happens at turn/completed), leaving
        // the user looking at a silently-running goal.
        record('event_msg', { type: 'goal_updated', goal });
      } else {
        meta.goal = null;
        meta.goalStatus = null;
        meta.goalElapsed = 0;
      }
      scheduleMeta();
    } catch (e) { log(`thread/goal/get failed: ${e.message}`); }
  }
}

// VibeSpace task context for Codex — Codex's app-server does NOT inject hook
// additionalContext (empirically confirmed), so we deliver it natively via
// `thread/inject_items` (a first-class app-server method that appends a
// developer-role message to the thread's model-visible history WITHOUT starting
// a user turn — verified). Called before each turn: the server's
// /api/agent/prompt-context returns the shared context of every Task Group this
// session belongs to on the first turn and a refresh whenever any of them changed
// since the session last saw it, plus any status-override notice. Group belonging
// is resolved SERVER-SIDE from the token (live — a UI bind reaches the agent on
// its next turn with no respawn), so we do NOT gate on a task-id env var; we call
// every turn and let the server decide (it returns '' when there's nothing new).
// Best-effort — never blocks or breaks a turn.
async function injectTaskContextForTurn() {
  const api = process.env.VIBESPACE_API, token = process.env.VIBESPACE_SESSION_TOKEN;
  if (!api || !token || !meta.threadId) return;
  try {
    const res = await fetch(api + '/api/agent/prompt-context', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.context) {
      await request('thread/inject_items', {
        threadId: meta.threadId,
        items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: data.context }] }],
      }, 10000);
      log(`injected task context (${data.context.length} chars) via thread/inject_items`);
    }
  } catch (e) { log(`task context inject skipped: ${e.message}`); }
}

let nudgeTurnActive = false;
async function maybeStopNudge() {
  const api = process.env.VIBESPACE_API, token = process.env.VIBESPACE_SESSION_TOKEN;
  if (!api || !token || !meta.threadId) return;
  try {
    const res = await fetch(api + '/api/agent/stop-check', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return;
    const d = await res.json();
    if (!d || !d.block || !d.reason) return;
    nudgeTurnActive = true;
    log('stop nudge: starting one bookkeeping turn');
    await startTurn('<vibespace-reminder>' + d.reason + '</vibespace-reminder>');
  } catch (e) { nudgeTurnActive = false; log('stop nudge skipped: ' + e.message); }
}

const SLASH_COMMANDS = ['compact', 'review', 'model', 'effort'];
/** Wrapper-served slash commands (see chat-input). Returns true when consumed. */
async function applySlashCommand(text) {
  const m = /^\/(compact|review|model|effort)(?:\s+(.*))?$/s.exec(String(text || '').trim());
  if (!m) return false;
  const [, cmd, argRaw] = m;
  const arg = (argRaw || '').trim();
  if (!meta.threadId) throw new Error(`No threadId available for /${cmd}`);
  try {
    if (cmd === 'compact') {
      emitTaskEvent('compact_started', { turn_id: meta.activeTurnId || null });
      await request('thread/compact/start', { threadId: meta.threadId }, 300000);
      // the contextCompaction item completion emits context_compacted; a
      // server that answers without an item still gets the marker
      if (!compactionSeen) emitTaskEvent('context_compacted', { source: 'rpc' });
      compactionSeen = false;
    } else if (cmd === 'review') {
      await handleInput({ type: 'review-start', target: { type: 'uncommittedChanges' } });
    } else if (cmd === 'model') {
      await handleInput({ type: 'set-model', model: arg });
      emitTaskEvent('command_applied', { command: cmd, value: arg || '(default)' });
    } else if (cmd === 'effort') {
      await handleInput({ type: 'set-effort', effort: arg });
      emitTaskEvent('command_applied', { command: cmd, value: arg || '(default)' });
    }
  } catch (e) {
    emitTaskEvent('task_failed', { error: `/${cmd} failed: ${e.message}` });
    log(`/${cmd} failed: ${e.message}`);
  }
  return true;
}
let compactionSeen = false;

async function startTurn(text, attachments = []) {
  if (!meta.threadId) throw new Error('No threadId available for turn/start');
  const input = encodeUserInput(text, attachments);
  if (!input.length) return;
  await injectTaskContextForTurn(); // deliver task context/updates before the turn
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
  const startedId = resp?.turn?.id || currentTurnId;
  // The turn/completed notification can be processed BEFORE this reply's
  // promise resolves (same stdout chunk; notifications are handled
  // synchronously, replies on a microtask) — a turn that already ended must
  // not be re-marked active, or every later chat-input would queue forever.
  if (completedTurns.has(startedId)) { completedTurns.delete(startedId); return; }
  currentTurnId = startedId;
  meta.activeTurnId = currentTurnId;
  meta.streaming = true;
  scheduleMeta();
}
const completedTurns = new Set();

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
      slashCommands: SLASH_COMMANDS,
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
    // SLASH COMMANDS (P2, design-harness-plugins §1): codex's init carries no
    // command list, so the wrapper serves the ones it can actually honour —
    // /compact runs a REAL compaction (thread/compact/start, verified on
    // 0.153.4) instead of a wasted model turn, /review starts a review of the
    // uncommitted changes, /model + /effort reuse the set-* verbs.
    if (!attachments.length && await applySlashCommand(text)) return;
    // SEND WHILE BUSY (P2): a turn is active ⇒ thread/queue/add (runs right
    // after the current turn — the same lane peer messages use) instead of
    // turn/start, which codex either STEERS into the running turn or, for
    // review/compact turns, rejects with ActiveTurnNotSteerable and the text
    // was lost. The user record above already renders the bubble; the
    // queued_input event renders a "queued" notice under it.
    if (meta.threadId && meta.activeTurnId) {
      await request('thread/queue/add', {
        threadId: meta.threadId,
        input: encodeUserInput(text, attachments),
        clientUserMessageId: msg.msgId || `queued-${process.pid}-${nextId++}`,
      }, 30000);
      emitTaskEvent('queued_input', { msg_id: msg.msgId || '', turn_id: meta.activeTurnId });
      log('chat-input queued (turn active; runs after the current turn)');
      return;
    }
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
  if (msg.type === 'peer-message') {
    // Live agent-to-agent delivery (peerDelivery 'rpc-queue'): we OWN the
    // app-server connection, so idle ⇒ turn/start (billed turn + reply —
    // claude-inbox parity); busy ⇒ thread/queue/add, which the app-server
    // runs right after the current turn (upstream-test-pinned). The user
    // message is recorded HERE (item notifications never carry userMessage,
    // so nothing double-renders). Failure is reported, never swallowed —
    // the server stashes the text for next-turn injection on ok:false.
    // The record carries the out-of-band marker `webui_peer: {name, body}`
    // (the delivery site's fromName / cardText): the normalizer maps it to a
    // LABELLED peer card instead of an anonymous "You" bubble — we are the
    // party holding the sender's identity, so we write it into our own
    // record (claude parity: its CLI stamps origin.kind='peer'). The marker
    // is metadata only — the text the model receives is untouched, so this
    // copy stays byte-identical to codex's rollout copy of the same user
    // message and the two dedup on rebuild (recordKey + mergeCodexRecords
    // both strip webui_peer). Absent name ⇒ the normalizer falls back to
    // parsing the server frame, exactly as a rollout-only rebuild does.
    const text = String(msg.text || '');
    if (!text.trim()) return;
    const fromName = msg.fromName ? String(msg.fromName) : null;
    const cardText = typeof msg.cardText === 'string' && msg.cardText.trim() ? msg.cardText : null;
    const recordPeerMessage = () => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }], webui_peer: { name: fromName, body: cardText } });
    try {
      if (meta.activeTurnId) {
        await request('thread/queue/add', {
          threadId: meta.threadId,
          input: encodeUserInput(text, []),
          clientUserMessageId: `peer-${process.pid}-${nextId++}`,
        }, 30000);
        recordPeerMessage();
        emitTaskEvent('peer_message_result', { ok: true, mode: 'queued' });
        log('peer message queued (turn active; runs after the current turn)');
      } else {
        await startTurn(text);
        recordPeerMessage();
        emitTaskEvent('peer_message_result', { ok: true, mode: 'turn' });
      }
    } catch (e) {
      // fromName rides the failure echo so the server's re-stash keeps the
      // label the drain-site card will show
      emitTaskEvent('peer_message_result', { ok: false, reason: e.message, text, fromName });
      log('peer-message delivery failed: ' + e.message);
    }
    return;
  }
  if (msg.type === 'codex-read-limits') {
    await readAccountLimits(true);
    return;
  }
  if (msg.type === 'codex-reset-credit') {
    // Consume a stored rate-limit reset credit (owner ask: let the user choose
    // reset vs switching accounts). Outcomes seen in the binary enum:
    // reset | nothingToReset | alreadyRedeemed (+ cooldown_active state).
    try {
      const r = await request('account/rateLimitResetCredit/consume', {}, 30000);
      emitTaskEvent('reset_credit_result', { result: r || null, outcome: r?.outcome || null });
      // refresh limits so every consumer sees the post-reset state
      try {
        const r2 = await request('account/rateLimits/read', {}, 20000);
        const rl2 = r2?.rateLimits || r2?.rate_limits || null;
        if (rl2) { meta.rateLimits = rl2; meta.rateLimitsFetchedAt = Date.now(); scheduleMeta(); emitTaskEvent('rate_limits_updated', { rateLimits: rl2, resetCredits: r2?.rateLimitResetCredits || null }); }
      } catch { }
    } catch (e) { emitTaskEvent('reset_credit_result', { error: String(e.message || e) }); }
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
  if (msg.type === 'set-goal') {
    if (msg.goal && meta.threadId) {
      try {
        // status:'active' is REQUIRED to (re)start the goal loop. thread/goal/set
        // without status is a partial update that KEEPS the current status — a
        // goal parked in usageLimited/paused/blocked stays parked, and the
        // app-server's continue_if_idle only fires for Active goals (so the
        // "Continue Goal" button silently did nothing on a usageLimited goal).
        await request('thread/goal/set', { threadId: meta.threadId, objective: msg.goal, status: 'active' }, 30000);
        meta.goal = msg.goal;
        meta.goalStatus = 'active';
        log('Goal set via thread/goal/set: ' + msg.goal.substring(0, 80));
      } catch (e) { log('thread/goal/set failed: ' + e.message); meta.goal = msg.goal; }
    } else if (!msg.goal && meta.threadId) {
      try {
        await request('thread/goal/clear', { threadId: meta.threadId }, 30000);
        log('Goal cleared via thread/goal/clear');
      } catch (e) { log('thread/goal/clear failed: ' + e.message); }
      meta.goal = null;
    } else {
      meta.goal = msg.goal || null;
    }
    scheduleMeta();
    return;
  }
  if (msg.type === 'set-effort') {
    // Applied on the NEXT turn/start (effort is a per-turn param).
    effort = msg.effort || '';
    meta.effortOverride = effort;
    scheduleMeta();
    log('Effort set for next turn: ' + (effort || '(default)'));
    return;
  }
  if (msg.type === 'set-model') {
    // Applied on the NEXT turn/start (model is a per-turn param). turn_context
    // in the rollout JSONL confirms the switch authoritatively.
    meta.model = msg.model || '';
    meta.modelPinned = !!msg.model;
    scheduleMeta();
    log('Model set for next turn: ' + (msg.model || '(default)'));
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

  // keeper sentinel: codex REALLY ended on the host (vs a mere ssh drop)
  if (msg.type === '_remote_exit') {
    remoteExited = msg.code ?? 0;
    log(`remote session ended (code ${remoteExited}${msg.crashed ? ', crashed' : ''}${msg.missing ? ', missing' : ''})`);
    finalizeExit(remoteExited);
    return;
  }

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

// Shared exit body (natural child exit locally, or the remote sentinel).
function finalizeExit(code) {
  shuttingDown = true;
  meta.streaming = false;
  meta.activeTurnId = null;
  scheduleMeta();
  if (writeTimer) clearTimeout(writeTimer);
  if (metaTimer) clearTimeout(metaTimer);
  persistBuffer();
  persistMeta();
  log(`session ended code=${code}`);
  process.exit(code ?? 0);
}

let lineBufB = Buffer.alloc(0); // Buffer-based: byte-exact offsets + no multibyte splits

function startChild() {
  reconnectTimer = null;
  // Remote reconnect: substitute the consumed-bytes offset so the keeper
  // replays exactly what we missed (__VS_OFFSET__ rides inside the ssh
  // inner-command string).
  const spawnArgs = REMOTE_SID ? args.map((a) => a.split('__VS_OFFSET__').join(String(remoteOffset))) : args;
  try {
    child = spawn(cmd, spawnArgs, {
      // remote: baseCwd is the REMOTE path — spawning ssh there ENOENTs
      cwd: REMOTE_SID ? process.cwd() : baseCwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    log(`failed to spawn: ${err.message}`);
    if (REMOTE_SID && !shuttingDown) { scheduleReconnect(); return; }
    process.exit(1);
  }

  meta.childPid = child.pid;
  scheduleMeta();
  log(`spawned ${cmd} ${spawnArgs.length !== args.length ? '(offset-substituted) ' : ''}pid=${child.pid}${REMOTE_SID ? ` offset=${remoteOffset} attempt=${reconnectAttempts}` : ''}`);

  // Buffer-based line splitting (both modes): remote offsets must be BYTE-exact
  // across reconnects, and a chunk boundary may split a multibyte char — only
  // complete lines are utf8-decoded (the chat-wrapper 2.124.0 lesson).
  child.stdout.on('data', (chunk) => {
    if (REMOTE_SID) {
      remoteOffset += chunk.length;
      if (meta.remote?.state !== 'connected') {
        reconnectAttempts = 0;
        meta.remote = { state: 'connected', at: Date.now() };
        scheduleMeta();
        record('event_msg', { type: '_remote_state', state: 'connected' });
      }
    }
    lineBufB = lineBufB.length ? Buffer.concat([lineBufB, chunk]) : chunk;
    let idx;
    while ((idx = lineBufB.indexOf(10)) !== -1) {
      const line = lineBufB.subarray(0, idx).toString('utf8').trim();
      lineBufB = lineBufB.subarray(idx + 1);
      if (!line) continue;
      handleStdoutLine(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = chunk.trim();
    if (text) log(`[stderr] ${text}`);
  });

  child.on('exit', (code) => {
    // remote + no sentinel + not told to die = TRANSPORT death → reconnect
    if (REMOTE_SID && remoteExited === null && !shuttingDown) {
      meta.remote = { state: 'reconnecting', attempts: reconnectAttempts + 1, at: Date.now() };
      scheduleMeta();
      scheduleReconnect();
      return;
    }
    finalizeExit(remoteExited !== null ? remoteExited : code);
  });

  child.on('error', (err) => {
    log(`child error: ${err.message}`);
    if (REMOTE_SID && remoteExited === null && !shuttingDown) { scheduleReconnect(); return; }
    record('event_msg', { type: 'task_failed', error: err.message });
  });

  // Flush JSON-RPC lines queued while the pipe was down
  if (outQueue.length && child.stdin.writable) {
    log(`flushing ${outQueue.length} queued outbound line(s)`);
    for (const l of outQueue.splice(0, outQueue.length)) child.stdin.write(l + '\n');
  }
}

function scheduleReconnect() {
  if (reconnectTimer || shuttingDown) return;
  reconnectAttempts++;
  const delay = [1000, 2000, 5000, 10000, 30000][Math.min(4, reconnectAttempts - 1)];
  log(`reconnect #${reconnectAttempts} in ${delay}ms (offset=${remoteOffset})`);
  meta.remote = { state: 'reconnecting', attempts: reconnectAttempts, at: Date.now() };
  scheduleMeta();
  record('event_msg', { type: '_remote_state', state: 'reconnecting', attempts: reconnectAttempts });
  reconnectTimer = setTimeout(startChild, delay);
}

async function boot() {
  try {
    fs.mkdirSync(path.dirname(bufferFile), { recursive: true });
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  } catch {}
  persistMeta();

  startChild();

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
      // Immediate stdin ACK on stdout (mirrors chat-wrapper; the server's
      // codex-events branch consumes it). Without it the broken-pty detector
      // in ws-handler saw "no ack + no buffer growth within 5s" during a slow
      // cold start (big thread resume), re-attached dtach and RE-SENT the same
      // line: a duplicate turn on the raw path, and with the frame-file
      // bypass a spurious "frame file could not be delivered" error (the
      // first delivery had already consumed the file). Fires BEFORE parsing:
      // the ack means "the pipe is alive", not "the line was valid".
      try { process.stdout.write(JSON.stringify({ type: '_stdin_ack', timestamp: Date.now() }) + '\n'); } catch {}
      let msg = safeJsonParse(line);
      if (!msg || typeof msg !== 'object') { rejectStdinLine(line); continue; }
      // Large-frame FILE BYPASS: the payload rides the filesystem, stdin only
      // carries the pointer. Resolved HERE (not inside handleInput) so the file
      // is consumed + unlinked immediately, before the ready gate.
      if (msg.type === '_frame_file') { msg = loadFrameFile(msg); if (!msg) continue; }
      handleInput(msg).catch((err) => {
        log(`stdin handler error: ${err.message}`);
        record('event_msg', { type: 'task_failed', error: err.message });
      });
    }
  });

  await request('initialize', { clientInfo, capabilities: { experimentalApi: true } }, 30000);
  notify('initialized');
  await startThread();
  readAccountLimits(false); // surface reset-credit count without user action (fire-and-forget)
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
