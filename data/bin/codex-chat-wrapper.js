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

// {<question id>: {answers: [string]}} — the ToolRequestUserInputResponse shape
// (and the source of an elicitation's typed content). TWO things it must do
// that the 2.369.53 version did not, both of which silently ATE the answer:
//   · the unified AskUserQuestion UI sends ONE PLAIN STRING per question (the
//     chosen label / the typed text). A non-array, non-{answers} value used to
//     be skipped, the map came out EMPTY and the caller then reported "the user
//     answered nothing" — an answered question vanished.
//   · that UI keys its map by the question TEXT (it never sees the id), while
//     codex routes by question ID. `questions` (the request's own params) is
//     the dictionary back.
function normalizeNestedAnswers(value, questions = []) {
  const source = value && typeof value === 'object' ? value : {};
  const byKey = new Map();
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!q || typeof q !== 'object') continue;
    const id = String(q.id ?? q.question ?? '');
    if (!id) continue;
    if (q.question) byKey.set(String(q.question), id);
    byKey.set(id, id);
  }
  const answers = {};
  for (const [key, entry] of Object.entries(source)) {
    const id = byKey.get(String(key)) || String(key);
    let list = null;
    if (Array.isArray(entry)) list = entry;
    else if (entry && typeof entry === 'object' && Array.isArray(entry.answers)) list = entry.answers;
    else if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') list = [entry];
    if (!list) continue;
    const vals = list.map((item) => String(item)).filter((item) => item !== '');
    if (vals.length) answers[id] = { answers: vals };
  }
  return answers;
}

// A one-word label for the RESULT we actually sent — per method, because the
// five reply schemas do not share a field, let alone a vocabulary. Purely for
// the transcript record + the resolved card ("Allowed"/"Denied"); the wire
// value is the untouched result object.
function describeServerRequestDecision(result) {
  if (!result || typeof result !== 'object') return 'decline';
  if ('action' in result) return String(result.action || 'decline');          // elicitation
  if ('permissions' in result) {
    // The DENY reply is the one we build with both keys explicitly null; every
    // other grant (including one that echoes an empty requested profile) is an
    // approval. Sniffing "does it look non-empty" reported an approved empty
    // profile as Denied.
    const p = result.permissions || {};
    const denied = 'fileSystem' in p && 'network' in p && p.fileSystem === null && p.network === null;
    return denied ? 'decline' : 'granted';
  }
  if ('answers' in result && !('decision' in result)) {                       // requestUserInput
    return Object.keys(result.answers || {}).length ? 'accept' : 'cancel';
  }
  const decision = result.decision;
  if (typeof decision === 'string') return decision;
  if (decision && typeof decision === 'object') {
    if (decision.acceptWithExecpolicyAmendment) return 'acceptWithExecpolicyAmendment';
    if (decision.applyNetworkPolicyAmendment) return 'applyNetworkPolicyAmendment';
    if (decision.approved_execpolicy_amendment) return 'approved_execpolicy_amendment';
    if (decision.network_policy_amendment) return 'network_policy_amendment';
    if (decision.denied) return 'denied';
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
  // 0.153 multi-agent v2 CollabAgentTool names (bindings: sendMessage /
  // followupTask / interruptAgent / listAgents) — recorded in the rollout's
  // snake_case so the live twin and the rollout twin classify identically.
  if (name === 'sendMessage') return 'send_message';
  if (name === 'followupTask') return 'followup_task';
  if (name === 'interruptAgent') return 'interrupt_agent';
  if (name === 'listAgents') return 'list_agents';
  return name || 'tool';
}

// The inter-agent envelope codex 0.153 puts in front of every sub-agent ↔ root
// message ("Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/x\n
// Payload:\n…"). An OWN-thread agentMessage that starts with it is a message
// the model wrote FOR ANOTHER AGENT, never a reply to the user — it must not
// become a root assistant bubble (the owner's "根本没区分出这是subagent消息").
// Mirrored in src/codex-message-manager.js (parseAgentEnvelope); the wrapper is
// a shipped single file and cannot require it.
const AGENT_ENVELOPE_RE = /^Message Type:[ \t]*([A-Z_]+)\r?\n(?:Task name:[ \t]*(\S*)\r?\n)?Sender:[ \t]*(\S+)\r?\n/;
function parseAgentEnvelope(text) {
  const m = AGENT_ENVELOPE_RE.exec(String(text || ''));
  return m ? { msgType: m[1], taskName: m[2] || '', sender: m[3] } : null;
}

function itemContentText(item) {
  return asArray(item.content)
    .filter((entry) => entry && (entry.type === 'output_text' || entry.type === 'text' || entry.type === 'input_text'))
    .map((entry) => entry.text || '')
    .join('');
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
let effort = process.env.CODEX_WEBUI_EFFORT || ''; // mutable: set-effort updates it mid-session — the COMMANDED effort for the NEXT turn, never a statement about the running one
// ── THE EFFORT A TURN IS RUNNING AT (2.369.62, owner's "调成了 ultra 但 metadata 显示 xhigh") ──
// turn_context is the record every reader takes a turn's reasoning effort from
// (the message-meta popup bakes it onto each message of the turn). OURS is
// SYNTHESIZED at `turn/started`, and the 0.153.4 schema settles where the value
// can come from: TurnStartedNotification = {threadId, turn:{id,status,startedAt,
// items,…}} — no effort, no model. So it can only come from our own bookkeeping,
// and the two turn origins have DIFFERENT answers:
//   • a turn WE start runs at the effort we put on turn/start (TurnStartParams.
//     effort, documented "Override the reasoning effort for this turn and
//     SUBSEQUENT turns" ⇒ commanding one also re-points the thread);
//   • a turn the APP-SERVER starts — a queue drain, a resume auto-continue, a
//     goal continuation — runs at the THREAD's effort and never sees our
//     pending value. Printing `effort` there is how a conversation codex ran at
//     'ultra' (its own rollout turn_context, 21/21) got labelled 'xhigh' from a
//     stale spawn env, permanently: the merge fingerprint is `turn_context:<turn
//     id>` and ours is the EARLIER of the twins, so it also suppressed codex's.
// `threadEffort` = the app-server's own word for this thread (thread/start |
// resume | fork reply `reasoningEffort`, `thread/settings/updated`, and our own
// accepted commands). `turnEffort` = what the ACTIVE turn is running at.
let threadEffort = '';
let turnEffort = '';
let turnStartsInFlight = 0; // our own turn/start calls awaiting a reply (= the next turn/started is OURS)
let activeTurnOwned = false;
const backendPermissionMode = process.env.CODEX_WEBUI_PERMISSION_MODE || 'default';
// ── RESPONSE STYLE / PERSONALITY (2.369.58) ──
// codex's `Personality` enum, read out of `codex app-server
// generate-json-schema --experimental` on 0.153.4: exactly none | friendly |
// pragmatic. THE UNSET RULE: an EMPTY value means the user made no choice and
// the key is then NEVER put on thread/start | thread/resume | turn/start — the
// agent keeps whatever ~/.codex/config.toml says. (Until 2.369.58 the wrapper
// hardcoded 'pragmatic' into both calls and silently overrode every user's own
// config; 'none' is a REAL codex value meaning "no persona", so it can only
// ever arrive from an explicit pick.) Mutable: `set-response-style` applies it
// LIVE through thread/settings/update.
const PERSONALITY_VALUES = ['none', 'friendly', 'pragmatic'];
let personality = PERSONALITY_VALUES.includes(process.env.CODEX_WEBUI_PERSONALITY || '')
  ? process.env.CODEX_WEBUI_PERSONALITY : '';
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

// THE VERBS THIS BUILD SERVES — one list, read by the sidecar advert (what a
// LOCAL server reads) and by every `queue_changed` publication (what a REMOTE
// server reads: the sidecar lives on this machine, not on the orchestrator).
// It mirrors backend-caps `inputModes.queueVerbs` for codex; a wrapper older
// than a verb simply never names it, and the server refuses that verb for it.
const QUEUE_VERBS_SERVED = ['remove', 'steer', 'steer-all', 'reorder', 'edit', 'run-now', 'run-all'];

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
  // THREE effort facts, never one (2.369.62): `effort` = the LIVE turn's (what
  // the popup must show for its messages), `effortNext` = the commanded value
  // the next turn will use, `threadEffort` = the app-server's own word for the
  // thread. They differ exactly when a user re-picks mid-turn — which is the
  // moment the old single field lied.
  effort: effort || '',
  effortNext: effort || '',
  threadEffort: '',
  tasks: {},
  pendingRequests: {},
  subagentMetas: [],
  // 0.153 multi-agent v2: agentPath → agentThreadId learned from this thread's
  // own subAgentActivity items (the ONLY live carrier of the child thread id;
  // the rollout persists the same fact as item_completed/SubAgentActivity).
  subagents: {},
  // THREAD GATE (B-7473): the app-server relays notifications for EVERY thread
  // it hosts — a sub-agent's agentMessage arrived here with the child's
  // threadId and was recorded as a ROOT assistant message (owner report: a
  // sub-agent's FINAL_ANSWER rendered as an ordinary reply, twice). Foreign-
  // thread notifications are dropped and COUNTED here; only a child's
  // agentMessage is kept, as an agent_message record attributed to the child.
  foreignDrops: { total: 0, threads: {} },
  // Capability advert (the 2.361.1/2.364.1 law: features gate on what THIS
  // process declares in the file THIS process writes, never on version guesses).
  // frameFile: the server may hand >64KB chat frames over as a `_frame_file`
  // pointer line (design-harness-plugins §1 P1 — the bypass used to exclude
  // codex BY BACKEND ID, so a multi-image paste rode raw pty stdin and could
  // be shredded exactly like the 79928a2b claude poisoning, silently).
  // threadScoped: every recorded item carries thread_id/turn_id and foreign
  // threads never become root messages (B-7473).
  // inputQueue: this wrapper OWNS the app-server's input queue — it publishes
  // `queue_changed` on every change and serves the `queue-op` stdin verb.
  // queueVerbs: WHICH verbs this build serves (the verb table of
  // backend-caps `inputModes.queueVerbs`). backend-caps says what the HARNESS
  // can do; this advert is the per-PROCESS truth for a long-lived wrapper that
  // predates a verb (the 2.361.1/2.364.1 law) — a server reading `inputQueue`
  // with no list must assume the pre-verb-table set, never the current one.
  // responseStyle: this wrapper serves `set-response-style` and applies it
  // LIVE (thread/settings/update). backend-caps `responseStyle.live` is what
  // the ws layer + the chip gate on; this advert is the per-PROCESS truth for
  // a wrapper spawned before the feature existed.
  caps: { peerMessage: true, frameFile: true, threadScoped: true, inputQueue: true, queueVerbs: QUEUE_VERBS_SERVED, responseStyle: true },
  // The response style (codex Personality) this session actually runs with.
  // '' = the user made no choice ⇒ the key is never sent and ~/.codex/config.toml
  // decides. Reported so Session Properties can name the EFFECTIVE value.
  personality,
  // The queue as last read from thread/queue/list (sidecar mirror; the live
  // consumer is the queue_changed event).
  queue: [],
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
  // THIS thread's own agent path — the reference point that makes an
  // agentMessage inbound or outbound (meta.agentPath is read in the agentMessage
  // and foreign-thread paths; it was READ but never assigned until B-7473 integration 2026-09-06).
  // 0.153.4's Thread struct carries agentNickname / agentRole / parentThreadId
  // but NO agentPath (checked against the installed binary's serde field list),
  // so this only fills in if a later version adds it — the reads keep their
  // '/root' default, which is what a VibeSpace-spawned thread always is (we
  // never spawn a sub-agent thread ourselves; a RESUMED sub-agent conversation
  // gets the real path from codex's own session_meta at line 0 of its rollout).
  const replyAgentPath = asString(resp?.agentPath || resp?.agent_path || thread.agentPath || thread.agent_path);
  if (replyAgentPath) meta.agentPath = replyAgentPath;
  meta.permissionMode = permissionMode;
  // THE APP-SERVER'S OWN WORD for this thread's effort (Thread.reasoningEffort /
  // ThreadResumeResponse.reasoningEffort, 0.153.4). It is the effort every turn
  // the APP-SERVER starts will run at — not necessarily the one we would send.
  if (typeof resp?.reasoningEffort === 'string' && resp.reasoningEffort) {
    threadEffort = resp.reasoningEffort;
    meta.threadEffort = threadEffort;
  }
  // EXPLICIT EFFORT ON EVERY TURN (B-21e4 item 4, the effort twin of the
  // modelPinned rule): with no COMMANDED effort (spawn env / set-effort) adopt
  // the thread's own current effort from the start/resume/fork response
  // (`reasoningEffort`, 0.153.4 bindings) so every turn/start carries an
  // explicit `effort` — the app-server's per-thread defaults can then never
  // flip a resumed conversation (0.153.4: gpt-6-astra defaults to LOW when
  // config.toml names no model). A later set-effort still wins (it rewrites
  // `effort`); a set-effort back to '' deliberately hands the choice back.
  if (!effort && typeof resp?.reasoningEffort === 'string' && resp.reasoningEffort) { effort = resp.reasoningEffort; meta.effortAdopted = effort; }
  meta.effortNext = effort || threadEffort || '';
  // LIVE-TWIN CORRECTION (2.369.62): the resume reply can land AFTER the
  // app-server has already pushed `turn/started` for a turn it auto-continued —
  // that is the incident's exact stdout order (goal_cleared, turn/started, then
  // the thread/resume reply, all inside one millisecond). The turn_context we
  // synthesized a moment ago could only quote the spawn env; now we know what
  // the thread actually runs at, so re-state THIS turn's context. Same turn id
  // ⇒ no new turn for any reader (the normalizer bumps turnIndex on a CHANGED
  // id, the merge folds a repeat into the first copy).
  if (threadEffort && meta.activeTurnId && !activeTurnOwned && turnEffort !== threadEffort) {
    noteTurnEffort(threadEffort, 'thread-reply');
  }
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
    // only when the server actually told us (never a guessed '/root': the
    // normalizer's FIRST session_meta wins, and a wrong one would flip every
    // inbound message to outbound)
    agent_path: meta.agentPath || undefined,
  });
  recordWrapperMeta();
  scheduleMeta();
}

/** The wrapper's own status record — emitted on every thread reply AND whenever
 *  a per-session knob changes (set-effort / set-model), because it is the only
 *  live carrier of facts the app-server never repeats. `activeTurnId` rides it
 *  deliberately: the merge fingerprint is `wrapper_meta:<thread>:<activeTurnId>`,
 *  so a per-turn refresh survives a history rebuild instead of collapsing onto
 *  the boot copy. */
function recordWrapperMeta() {
  // The SIDECAR's `effort` is read as "what this session is running at"
  // (codex-session-store.chatStatus) — keep it on the same one definition as
  // the record below, or a resumed session with no turn yet reports the spawn
  // env forever (updateMetaFromThread used to assign the thread's own
  // reasoningEffort straight into meta.effort; that assignment now lives here,
  // where `threadEffort` is one of the three ranked facts).
  meta.effort = liveTurnEffort();
  record('wrapper_meta', {
    threadId: meta.threadId,
    threadName: meta.threadName,
    model: meta.model,
    permissionMode: meta.permissionMode,
    approvalPolicy: meta.approvalPolicy,
    sandbox: meta.sandbox,
    contextWindow: meta.contextWindow || 0,
    activeTurnId: meta.activeTurnId || null,
    slashCommands: SLASH_COMMANDS, // the wrapper-served commands (chat-input autocomplete)
    // TWO honest effort facts (2.369.62): what the live turn RUNS at, and what
    // the next one WILL run at. A client attaching mid-turn reads both from
    // this record — no rollout re-read, no waiting for the next turn_context.
    effort: liveTurnEffort() || null,
    effortNext: effort || threadEffort || null,
  });
}

/** The effort the ACTIVE (or most recent) turn is running at — the value the
 *  message-meta popup must show for that turn's messages. */
function liveTurnEffort() {
  return turnEffort || threadEffort || effort || '';
}

function buildTurnContext(turnId) {
  return {
    turn_id: turnId,
    cwd: meta.cwd,
    approval_policy: currentPermission.approvalPolicy,
    sandbox_policy: currentPermission.sandboxPolicy,
    model: meta.model || model || '',
    modelPinned: !!model,
    wrapper: true, // this copy is SYNTHESIZED — codex's own turn_context outranks it (merge fold)
    // THIS TURN's effort, never the pending one (2.369.62). `effort_next` is
    // stated only when a re-pick is waiting for the next turn — a reader that
    // sees both can say "running at X, switching to Y" instead of guessing.
    effort: liveTurnEffort() || null,
    ...(effort && effort !== liveTurnEffort() ? { effort_next: effort } : {}),
    summary: 'none',
  };
}

/** Restate the ACTIVE turn's context because we learned its real effort late
 *  (the resume-reply race) — same turn id, so no reader sees a new turn. */
function noteTurnEffort(next, why) {
  const value = String(next || '');
  if (!meta.activeTurnId || value === turnEffort) return;
  const prev = turnEffort;
  turnEffort = value;
  meta.effort = turnEffort;
  record('turn_context', buildTurnContext(meta.activeTurnId));
  recordWrapperMeta();
  scheduleMeta();
  log(`turn ${meta.activeTurnId} effort corrected ${prev || '(none)'} → ${turnEffort} (${why})`);
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

// ── Item context + thread gate (B-7473) ──
// Every item notification names its thread + turn (ItemStartedNotification /
// ItemCompletedNotification = {item, threadId, turnId, …} in the 0.153.4
// bindings); the handlers below run synchronously, so the current item's
// context rides a module variable and lands on every record as thread_id /
// turn_id (stripped from the merge fingerprint + record key by the readers).
let itemCtx = { threadId: null, turnId: null };
function recordItem(payload) {
  const ctx = {};
  if (itemCtx.threadId) ctx.thread_id = itemCtx.threadId;
  if (itemCtx.turnId) ctx.turn_id = itemCtx.turnId;
  record('response_item', { ...payload, ...ctx });
}
// THE GATE IS INVERTED (B-7473 integration 2026-09-06): the app-server relays notifications for
// EVERY thread it hosts, so the question is not "is this method in my list of
// thread-scoped methods" (a list is a whitelist that goes stale — `error`,
// `thread/compacted`, `thread/queue/changed` and `turn/diff/updated` all carry
// threadId in the 0.153.4 bindings and were all MISSING from the first cut, so
// a CHILD's error became the ROOT's task_failed + system card + turn_complete).
// The question is: does THIS notification name a thread, and is it mine?
//   params.threadId present && !== meta.threadId  ⇒ FOREIGN (unless allowlisted)
//   no threadId, or equal, or meta.threadId not known yet (the thread/start
//   reply is still in flight)                     ⇒ ours, handled as before.
// A child's agentMessage is KEPT as an attributed agent_message record and a
// child's error becomes a collab activity row; everything else is dropped +
// counted in meta.foreignDrops.
// Allowlist: methods whose threadId names something OTHER than the conversation
// scope and must be processed anyway. thread/started + thread/resumed are NOT
// here because they are handled ABOVE the gate — they are what TEACHES us our
// own id. Empty today; a new method goes in here only with a reason.
const THREAD_ID_NOT_SCOPE = new Set([]);
function foreignThreadOf(params) {
  const tid = asString(params?.threadId || params?.thread_id);
  return tid && meta.threadId && tid !== meta.threadId ? tid : null;
}
const foreignLogged = new Set();
function agentPathForThread(tid) {
  for (const [p, id] of Object.entries(meta.subagents || {})) if (id === tid) return p;
  return null;
}
function noteForeignDrop(method, tid, what) {
  const fd = meta.foreignDrops || (meta.foreignDrops = { total: 0, threads: {} });
  fd.total++;
  const t = fd.threads[tid] || (fd.threads[tid] = { dropped: 0, agentMessages: 0, agentPath: null });
  if (what === 'agent_message') t.agentMessages++; else t.dropped++;
  if (!t.agentPath) t.agentPath = agentPathForThread(tid);
  if (!foreignLogged.has(tid)) {
    foreignLogged.add(tid);
    log(`notification from another thread ${tid}${t.agentPath ? ` (${t.agentPath})` : ''} via ${method}${what ? ' / ' + what : ''} — not this conversation; gated (later ones only counted in meta.foreignDrops)`);
  }
  scheduleMeta();
}
function noteSubagent(item) {
  const p = asString(item.agentPath || item.agent_path), tid = asString(item.agentThreadId || item.agent_thread_id);
  if (!p || !tid) return;
  if (meta.subagents[p] === tid) return;
  meta.subagents[p] = tid;
  scheduleMeta();
}
// The agent_message record — the rollout's own shape for sub-agent ↔ root
// chatter ({author, recipient, content:[input_text envelope]}) plus the fields
// only the live side knows: the item id (dedup against the rollout twin), the
// author's thread, and msg_type/phase (a child's final_answer IS the
// FINAL_ANSWER the rollout later stores in plaintext; commentary = MESSAGE).
function recordAgentMessage({ id, threadId, turnId, author, recipient, text, phase, delivery, envelope }) {
  record('response_item', {
    type: 'agent_message',
    id,
    thread_id: threadId || null,
    turn_id: turnId || null,
    author,
    recipient,
    content: [{ type: envelope ? 'input_text' : 'output_text', text }],
    phase: phase || null,
    delivery: delivery || null,
    msg_type: envelope ? envelope.msgType : (phase === 'final_answer' ? 'FINAL_ANSWER' : 'MESSAGE'),
  });
}
// Monotonic suffix for the synthesized foreign-error id: `Date.now()` alone is
// NOT unique (two child failures inside one millisecond shared an id, and any
// id-keyed dedupe downstream would then swallow the second — round-5).
let foreignErrorSeq = 0;
function handleForeignThreadNotification(method, params, tid) {
  const item = params?.item;
  // A CHILD's failure is the CHILD's: it must never become this conversation's
  // task_failed (which the client renders as a failed turn + a system card and
  // which ends the root's streaming state). It is recorded as a collab activity
  // row instead — the agent errored, with the message on the row's hover.
  if (method === 'error') {
    const msg = asString(params?.message || params?.error?.message) || 'error';
    record('event_msg', {
      type: 'sub_agent_activity',
      event_id: `foreign-error-${tid}-${Date.now()}-${++foreignErrorSeq}`,
      occurred_at_ms: Date.now(),
      agent_thread_id: tid,
      agent_path: agentPathForThread(tid) || '',
      kind: 'errored',
      detail: msg.slice(0, 300),
      thread_id: meta.threadId || null,
    });
    noteForeignDrop(method, tid, 'error');
    return;
  }
  if (method === 'item/completed' && item?.type === 'agentMessage') {
    const text = asString(item.text) || itemContentText(item);
    if (text) {
      recordAgentMessage({
        id: item.id, threadId: tid, turnId: params?.turnId || null,
        author: agentPathForThread(tid) || tid, recipient: meta.agentPath || '/root',
        text, phase: item.phase, delivery: item.delivery, envelope: null,
      });
      noteForeignDrop(method, tid, 'agent_message');
      return;
    }
  }
  if (item?.type === 'subAgentActivity') noteSubagent(item); // a grandchild's path→thread is still worth knowing
  noteForeignDrop(method, tid, item?.type || null);
}

function handleItemStarted(item, itemId) {
  const type = item.type;
  itemState.set(itemId, { type, item, startedAt: Date.now() });
  if (type === 'commandExecution') {
    const command = asString(item.command) || asArray(item.command).join(' ');
    const input = { command, cwd: item.cwd || meta.cwd };
    recordItem({
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
    recordItem({
      type: 'function_call',
      name: 'apply_patch',
      arguments: JSON.stringify(input),
      call_id: itemId,
    });
    emitTaskEvent('patch_apply_begin', { call_id: itemId, reason: item.reason || '' });
    return;
  }
  if (type === 'subAgentActivity') {
    // learn agentPath → agentThreadId as early as possible (a child's
    // agentMessage may arrive before this item's completed notification)
    noteSubagent(item);
    return;
  }
  if (type === 'collabAgentToolCall') {
    const tool = formatToolName(item.tool);
    // v2 CollabAgentToolCall carries prompt/model/reasoningEffort/receiverThreadIds
    // (no `input`); older shapes had input.description. The prompt is plaintext
    // here (the rollout stores it encrypted) — kept, it is what the user asked
    // the sub-agent to do.
    const input = { ...(item.input || {}), receiverThreadIds: item.receiverThreadIds || [] };
    if (item.prompt) input.prompt = item.prompt;
    if (item.model) input.model = item.model;
    if (item.reasoningEffort) input.reasoningEffort = item.reasoningEffort;
    recordItem({
      type: 'function_call',
      name: tool,
      namespace: 'collaboration',
      arguments: JSON.stringify(input),
      call_id: itemId,
    });
    emitTaskEvent('collab_agent_begin', {
      call_id: itemId,
      tool,
      description: item.agentNickname || item.agentRole || oneLine(item.input?.description || item.prompt || '').slice(0, 160),
      receiver_thread_ids: item.receiverThreadIds || [],
      agent_role: item.agentRole || '',
      agent_nickname: item.agentNickname || '',
    });
    if (tool === 'spawn_agent') {
      const metas = (item.receiverThreadIds || []).map((threadId) => ({
        threadId,
        description: item.input?.description || item.agentNickname || oneLine(item.prompt || '').slice(0, 120) || 'Agent',
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
      description: item.input?.description || item.agentNickname || item.agentRole || oneLine(item.prompt || '').slice(0, 120) || 'Agent',
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
    recordItem({ type: 'function_call', name: `mcp__${item.server || 'mcp'}__${item.tool || 'tool'}`, arguments: JSON.stringify(item.arguments ?? {}), call_id: itemId });
    emitTaskEvent('mcp_tool_call_begin', { call_id: itemId, server: item.server || '', tool: item.tool || '' });
    return;
  }
  if (type === 'dynamicToolCall') {
    recordItem({ type: 'function_call', name: item.namespace ? `${item.namespace}.${item.tool || 'tool'}` : (item.tool || 'dynamic_tool'), arguments: JSON.stringify(item.arguments ?? {}), call_id: itemId });
    return;
  }
  if (type === 'webSearch') {
    recordItem({ type: 'function_call', name: 'web_search', arguments: JSON.stringify({ query: item.query || '', action: item.action || null }), call_id: itemId });
    return;
  }
  // MEDIA + SLEEP (2.369.58): a generated image was INVISIBLE while streaming
  // (it only appeared after a re-attach merged the rollout) and a `sleep` had no
  // branch anywhere — a 20-minute deliberate wait read as a hang. Both open a
  // PENDING card here with the same input keys their completion carries, so the
  // live card and a rollout-only rebuild are the same object.
  if (type === 'imageGeneration') {
    recordItem({ type: 'function_call', name: 'image_gen', arguments: JSON.stringify({ prompt: asString(item.revisedPrompt), path: asString(item.savedPath) }), call_id: itemId });
    return;
  }
  if (type === 'sleep') {
    recordItem({ type: 'function_call', name: 'sleep', arguments: JSON.stringify({ durationMs: Number(item.durationMs) || 0 }), call_id: itemId });
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
  if (type === 'webSearch') {
    if (!state.type) handleItemStarted(item, itemId); // completed without a started (short call)
    // The v2 WebSearchItem is EMPTY at item/started (query '', action null) and
    // only complete here — so the completion is recorded in codex's OWN rollout
    // shape, `event_msg web_search_end {call_id, query, action, results}`, and
    // the normalizer renders it (query/action merged into the pending card's
    // input, results rendered as title — url / snippet). One renderer for the
    // live record and the rollout twin; key order mirrors codex-rs so the two
    // copies dedupe by fingerprint on re-attach. `results` is omitted when the
    // item has none (codex skips a None), `error` only when the item carries one.
    const ev = { call_id: itemId, query: asString(item.query), action: item.action && typeof item.action === 'object' ? item.action : null };
    if (Array.isArray(item.results)) ev.results = item.results;
    if (item.error) ev.error = typeof item.error === 'string' ? item.error : (item.error.message || JSON.stringify(item.error));
    emitTaskEvent('web_search_end', ev);
    return;
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    if (!state.type) handleItemStarted(item, itemId); // completed without a started (rollout merge / short call)
    const failed = !!item.error || item.status === 'failed' || item.success === false;
    const out = item.error ? (item.error.message || JSON.stringify(item.error)) : (item.result ?? item.contentItems ?? item.results ?? '');
    recordItem({ type: 'function_call_output', call_id: itemId, output: typeof out === 'string' ? out : JSON.stringify(out), is_error: failed });
    return;
  }
  if (type === 'imageView') {
    // the rollout's own ImageView item carries a file:// URL and the normalizer
    // strips it — the live copy must render the SAME text or the one card
    // (same item id) rewrites itself on re-attach
    const p = String(item.path || '').replace(/^file:\/\//, '');
    recordItem({ type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: p }), call_id: itemId });
    recordItem({ type: 'function_call_output', call_id: itemId, output: `viewed ${p || 'image'}`, is_error: false });
    return;
  }
  if (type === 'imageGeneration' || type === 'sleep') {
    // Recorded in codex's OWN rollout spelling (`item_completed` with an
    // `Extension` item) — the same record the rollout persists and the same one
    // codex-thread-read synthesizes, so all three producers hit ONE card path
    // and the live copy converges with the rollout copy on the item id.
    // `item.result` — the 3 MB base64 PNG — is deliberately NOT carried: the
    // card names savedPath and the browser draws the file (2.369.35 law).
    const payload = type === 'imageGeneration'
      ? { type: 'Extension', kind: 'image_gen.generation', id: itemId, status: asString(item.status), revisedPrompt: asString(item.revisedPrompt), savedPath: asString(item.savedPath), failure: item.failure ?? null }
      : { type: 'Extension', kind: 'clock.sleep', id: itemId, durationMs: Number(item.durationMs) || 0 };
    record('event_msg', { type: 'item_completed', item: payload });
    return;
  }
  if (type === 'contextCompaction') {
    compactionSeen = true;
    emitTaskEvent('context_compacted', { item_id: itemId, source: 'item' });
    return;
  }
  if (type === 'subAgentActivity') {
    // Own-thread sub-agent lifecycle (0.153 v2: {id, kind, agentThreadId,
    // agentPath}) → the live sub_agent_activity event the normalizer already
    // renders (same shape the 0.149 rollouts persisted; 0.153 rollouts carry
    // it as item_completed/SubAgentActivity — the normalizer routes both to
    // ONE card path). The path→thread map is what makes the child clickable.
    noteSubagent(item);
    record('event_msg', {
      type: 'sub_agent_activity',
      event_id: itemId,
      occurred_at_ms: Date.now(),
      agent_thread_id: asString(item.agentThreadId || item.agent_thread_id),
      agent_path: asString(item.agentPath || item.agent_path),
      kind: asString(item.kind),
      thread_id: itemCtx.threadId || meta.threadId || null,
    });
    return;
  }
  if (type === 'agentMessage') {
    const text = asString(item.text) || itemContentText(item);
    if (text) {
      const envelope = parseAgentEnvelope(text);
      // The ENVELOPE is the verified signal that this text was written FOR
      // another agent. `delivery === 'async'` is NOT (B-7473 integration 2026-09-06): on an
      // OWN-thread agentMessage it marks a question/async reply the user is
      // meant to read, and treating it as inter-agent DROPPED the text from the
      // transcript entirely (an asked question simply vanished).
      if (envelope) {
        // Written FOR another agent (inter-agent envelope) — an agent_message
        // record, never a root assistant message.
        recordAgentMessage({
          id: itemId, threadId: itemCtx.threadId || meta.threadId, turnId: itemCtx.turnId,
          author: envelope ? envelope.sender : (meta.agentPath || '/root'),
          recipient: envelope ? (envelope.taskName || meta.agentPath || '/root') : '',
          text, phase: item.phase, delivery: item.delivery, envelope,
        });
      } else {
        recordItem({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          phase: item.phase || null,
          item_id: itemId,
        });
      }
    }
    meta.streaming = false;
    scheduleMeta();
    return;
  }
  if (type === 'reasoning') {
    const reasoningText = lastReasoningByItem.get(itemId) || '';
    if (reasoningText) {
      recordItem({
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
    recordItem({
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
    recordItem({
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
    if (!state.type) handleItemStarted(item, itemId); // completed without a started (short spawn)
    // v2 carries agentsStates {threadId: state} — the closest thing to the
    // rollout's {"task_name": "/root/x"} output; never a message body.
    const output = normalizeOutput(item.output || item.result || item.message || (item.agentsStates && Object.keys(item.agentsStates).length ? item.agentsStates : ''));
    recordItem({
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
  // THREAD GATE (B-7473, inverted B-7473 integration 2026-09-06): anything that NAMES another thread
  // is not this conversation — see handleForeignThreadNotification.
  if (!THREAD_ID_NOT_SCOPE.has(method)) {
    const foreign = foreignThreadOf(params);
    if (foreign) { handleForeignThreadNotification(method, params, foreign); return; }
  }
  if (method === 'thread/status/changed') return;
  // The app-server's own queue-mutation signal (add / delete / drain at turn
  // end). It carries NO items — the list call is the truth (0.153.4:
  // ThreadQueueChangedNotification = {threadId}).
  if (method === 'thread/queue/changed') { refreshQueue(); return; }
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
  if (method === 'thread/settings/updated') {
    // The app-server's OWN confirmation of the thread's settings
    // (ThreadSettingsUpdatedNotification = {threadId, threadSettings}, 0.153.4).
    // It is the authority for what a turn the APP-SERVER starts will run at —
    // including changes made outside this wrapper (the codex TUI, another
    // client). Recorded in codex's OWN rollout shape (`thread_settings_applied`
    // with snake_case `reasoning_effort`) so the live twin and the rebuilt
    // history feed the normalizer the same record — but MARKED `wrapper: true`
    // (r2 review), because the record is still one WE wrote: codex's own
    // rollout copy carries 9 thread_settings keys (model_provider_id,
    // approvals_reviewer, collaboration_mode, permission_profile…) to our 5, so
    // the two never share a fingerprint and a rebuilt history would otherwise
    // hold an unattributable twin. mergeCodexRecords folds ours into codex's.
    const s = params?.threadSettings || params?.thread_settings || {};
    if (typeof s.effort === 'string' && s.effort) { threadEffort = s.effort; meta.threadEffort = threadEffort; }
    else if (s.effort === null) { threadEffort = ''; meta.threadEffort = ''; }
    if (typeof s.personality === 'string' || s.personality === null) { personality = s.personality || ''; meta.personality = personality; }
    if (!effort) meta.effortNext = threadEffort || '';
    record('event_msg', {
      type: 'thread_settings_applied',
      thread_id: params?.threadId || meta.threadId,
      wrapper: true,
      thread_settings: {
        model: s.model || meta.model || '',
        approval_policy: s.approvalPolicy || meta.approvalPolicy || '',
        cwd: s.cwd || meta.cwd || '',
        reasoning_effort: (typeof s.effort === 'string' && s.effort) ? s.effort : null,
        personality: (typeof s.personality === 'string' && s.personality) ? s.personality : null,
      },
    });
    scheduleMeta();
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
    // WHOSE turn is this, and what does it run at (2.369.62)? A turn/start of
    // ours is in flight ⇒ ours, at the effort we just sent (which also became
    // the thread's). Otherwise the app-server started it (drain / auto-continue)
    // ⇒ the THREAD's effort. `effort` is only the last-resort guess, and the
    // resume race that made it wrong is repaired by noteTurnEffort().
    activeTurnOwned = turnStartsInFlight > 0;
    turnEffort = threadEffort || effort || '';
    meta.effort = turnEffort;
    record('turn_context', buildTurnContext(currentTurnId));
    emitTaskEvent('task_started', { turn_id: currentTurnId, model_context_window: meta.contextWindow || 0 });
    // Re-publish the queue with the NEW turn id: a client attaching mid-turn
    // replays the buffer, and the last queue_changed may have scrolled out of
    // it during a long turn. Cheap (no RPC) and self-correcting.
    if (meta.queue?.length) publishQueue(meta.queue, { force: true });
    scheduleMeta();
    return;
  }
  if (method === 'turn/completed') {
    const status = params?.status || params?.turn?.status || 'completed';
    { const doneId = params?.turn?.id || params?.turnId || currentTurnId; if (doneId) { completedTurns.add(doneId); if (completedTurns.size > 50) completedTurns.delete(completedTurns.values().next().value); } }
    const normalEnd = status === 'completed' || status === 'success' || !status;
    meta.activeTurnId = null;
    meta.streaming = false;
    activeTurnOwned = false; // the next turn/started decides its own ownership
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
    itemCtx = { threadId: asString(params?.threadId || params?.thread_id) || meta.threadId || null, turnId: asString(params?.turnId || params?.turn_id) || currentTurnId || null };
    try {
      if (method === 'item/started') handleItemStarted(item, itemId);
      else handleItemCompleted(item, itemId);
    } finally { itemCtx = { threadId: null, turnId: null }; }
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
  };
  // ONLY when the user chose one (see PERSONALITY_VALUES above). thread/fork
  // has no `personality` field at all in the 0.153.4 schema — the fork
  // inherits its parent's, and a live `set-response-style` re-points it.
  if (personality && !(resumeId && isFork)) params.personality = personality;
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
  // COMMANDING an effort re-points the THREAD too (TurnStartParams.effort:
  // "Override the reasoning effort for this turn and subsequent turns",
  // 0.153.4) — so our belief about the thread moves the moment we send it, and
  // the turn_context synthesized when `turn/started` comes back (usually BEFORE
  // this reply resolves) quotes the value this turn really runs at. Reverted if
  // the call is refused, so a rejected command never relabels a later turn.
  const priorThreadEffort = threadEffort;
  if (effort) { threadEffort = effort; meta.threadEffort = threadEffort; }
  turnStartsInFlight++;
  let resp;
  try {
    resp = await request('turn/start', {
      threadId: meta.threadId,
      input,
      cwd: meta.cwd,
      approvalPolicy: currentPermission.approvalPolicy,
      sandboxPolicy: currentPermission.sandboxPolicy,
      model: meta.model || undefined,
      effort: effort || undefined,
      // unset ⇒ absent (never `null`: a null CLEARS the thread's personality,
      // which is not the same as "leave the agent's own config alone")
      ...(personality ? { personality } : {}),
    }, 120000);
  } catch (e) {
    threadEffort = priorThreadEffort;
    meta.threadEffort = threadEffort;
    throw e;
  } finally {
    turnStartsInFlight--;
  }
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

// ── THE INPUT QUEUE (queue + steer, design-harness-plugins §1 P2 follow-up) ──
// The app-server OWNS the queue; we do not keep a shadow copy of it. Measured
// against a live 0.153.4 `codex app-server` (scripts/test-codex-p2-wrapper
// mirrors every shape):
//   thread/queue/add     {threadId, input, clientUserMessageId}
//                        → {queuedSubmission:{id, input, clientUserMessageId}}
//   thread/queue/list    {threadId, cursor?, limit?}
//                        → {data:[QueuedSubmission], nextCursor:string|null}
//   thread/queue/delete  {threadId, queuedSubmissionId} → {deleted:boolean}
//   thread/queue/update  {threadId, queuedSubmissionId, input}   // input REQUIRED
//                        → {queuedSubmission}
//   thread/queue/reorder {threadId, queuedSubmissionIds:[string]} → {}  // FULL ORDER
//   thread/queue/start   {threadId, queuedSubmissionId?:string|null} → {turn}
//                        // …with NO id = "run the whole queue now"
//   turn/steer           {threadId, input, expectedTurnId, clientUserMessageId?}
//                        → {turnId}
// There is NO `thread/queue/remove` on 0.153.4 — the removal verb is
// `delete` and its field is `queuedSubmissionId`. Shapes above are from the
// 0.153.4 schema dump (`codex app-server generate-json-schema`), not guesses.
// THE TWO DISCIPLINES OF THE FULL-ORDER VERB (design-harness-features §2.1):
//   (a) `reorder` replaces the ENTIRE order, so the list it is computed from
//       must be paged to the END — a truncated page + a full-order replace
//       DELETES every queued item we never read. listQueueAll() is the only
//       reader allowed to feed it, and it reports `complete` honestly.
//   (b) the order is computed from a FRESH list at landing time, never from
//       what the client had on screen: the peer lane (backend-caps
//       peerDelivery 'rpc-queue') can `queue/add` between the render and the
//       drop, and those unknown ids keep their server-side place simply
//       because they are IN that fresh list. The ws frame therefore speaks
//       RELATIVE (`afterId`, null = front) and the absolute array is born
//       here, one RPC before it is sent.
// Two measured facts drive the steer implementation:
//   (1) turn/steer does NOT dequeue the item, not even when the steer carries
//      the queued item's own clientUserMessageId => we delete it ourselves, or
//      the message runs twice.
//   (2) several turn/steer calls inside ONE turn are accepted => "steer all" is
//      sequential steers in queue order, each keeping its own input (images and
//      per-message ids survive), not one concatenated blob.
// ORDER: steer FIRST, delete on success. A steer failing is a DESIGNED path
// (review/compact turns answer ActiveTurnNotSteerable, and a turn can end
// between the click and the RPC), and on that path the item must simply stay
// queued in its original position — which delete-first could not restore.
const queueMeta = new Map();   // clientUserMessageId → {kind:'user'|'peer', msgId, ts, from}
let queueFingerprint = null;
let queueRefreshInFlight = false, queueRefreshAgain = false;
// Stop is emptying the queue: hold every publish until the sweep has emitted
// its per-item removal results (see clearQueueForStop — a republish that
// overtakes a result tells the user the message RAN). The latch lives on
// publishQueue, the ONE choke point, because refreshQueue is NOT the only
// publisher: `turn/started` re-publishes meta.queue with no RPC at all, and
// mid-sweep that cached list is stale — it resurrected bubbles the sweep had
// already reported as removed, with their real msgIds (round-2 review).
// queueSweepSeq additionally invalidates a list that was already IN FLIGHT
// when the sweep began: it answers after the latch drops, with pre-sweep rows.
let queueSweepActive = false;
let queueSweepSeq = 0;
// Stop is a SAFETY CONTROL: it must not sit behind a wedged app-server. Every
// RPC the sweep makes is budgeted, the whole sweep is capped, and whatever is
// left when the cap expires is REPORTED (ok:false) instead of delaying the
// interrupt (round-2 review: 15s per RPC × N items before the user's Stop).
const STOP_SWEEP_RPC_MS = 2500;
const STOP_SWEEP_TOTAL_MS = 6000;

function noteQueued(clientUserMessageId, info) {
  if (!clientUserMessageId) return;
  queueMeta.set(String(clientUserMessageId), { kind: 'user', msgId: '', ts: Date.now(), from: null, ...info });
  if (queueMeta.size > 200) queueMeta.delete(queueMeta.keys().next().value);
}

/** <=120 chars of what this queued submission will actually send. */
function queuePreview(input) {
  const parts = [];
  for (const item of asArray(input)) {
    if (item?.type === 'text' && item.text) parts.push(String(item.text));
    else if (item?.type === 'image' || item?.type === 'localImage') parts.push('[image]');
    else if (item?.type === 'audio' || item?.type === 'localAudio') parts.push('[audio]');
    else if (item?.type === 'skill' && item.name) parts.push(`[skill ${item.name}]`);
    else if (item?.type === 'mention' && item.name) parts.push(`[@${item.name}]`);
  }
  const text = oneLine(parts.join(' '));
  return text.length > 120 ? text.slice(0, 119) + '…' : text;
}

/** The FULL text of a queued submission (its text elements, joined). The
 *  client's edit control opens THIS, never the 120-char `preview`: editing a
 *  truncated copy and sending it back would silently delete the rest of the
 *  message. Capped — a megabyte paste is not something to ship on every
 *  `queue_changed`, and an item with no `text` field simply offers no edit
 *  control (an honest absence beats a lossy editor). */
const QUEUE_EDIT_MAX_CHARS = 20000;
function queuedFullText(input) {
  const parts = [];
  for (const item of asArray(input)) if (item?.type === 'text' && item.text) parts.push(String(item.text));
  return parts.join('\n');
}

function queueItemsFrom(data) {
  return asArray(data).map((q) => {
    const cid = asString(q?.clientUserMessageId);
    const known = queueMeta.get(cid) || null;
    const full = queuedFullText(q?.input);
    return {
      id: asString(q?.id),
      msgId: known?.msgId || '',
      preview: queuePreview(q?.input),
      ...((known?.kind || 'user') === 'user' && full && full.length <= QUEUE_EDIT_MAX_CHARS ? { text: full } : {}),
      ts: known?.ts || null,
      // 'user' = typed here; 'peer' = an agent-to-agent / job message riding
      // the SAME lane (peerDelivery 'rpc-queue'). Hiding peers would make the
      // strip lie about what runs next, so they are listed and labelled.
      kind: known?.kind || 'user',
      from: known?.from || null,
    };
  }).filter((it) => it.id);
}

/** Publish the queue to every consumer (client strip, attach replay, sidecar). */
function publishQueue(items, { force = false } = {}) {
  // THE LATCH (see queueSweepActive): while Stop empties the queue the only
  // truthful publish is the one the sweep itself makes when it is done. Every
  // other publisher — a per-delete queue/changed refresh, the turn/started
  // republish of the CACHED list — would list items the user has already been
  // told were removed.
  if (queueSweepActive) return;
  const fp = JSON.stringify(items.map((it) => [it.id, it.msgId, it.kind]));
  if (!force && fp === queueFingerprint) return;
  queueFingerprint = fp;
  meta.queue = items;
  scheduleMeta();
  // `verbs` rides EVERY publication: for a REMOTE session the orchestrator
  // cannot read this machine's sidecar, so the in-band list is the only advert
  // it will ever see (a publication with no `verbs` = a pre-verb-table build).
  emitTaskEvent('queue_changed', { items, turn_id: meta.activeTurnId || null, verbs: QUEUE_VERBS_SERVED });
}

/** THE FULL QUEUE, paged to the END (`nextCursor`). Returns
 *  {rows, complete} — `complete:false` means the walk stopped early (budget /
 *  a server that keeps handing out cursors), and the caller must decide:
 *  publishing a partial list is a degraded but honest view, computing a FULL
 *  ORDER from one would silently delete the unread tail. Never collapse the
 *  two — the pre-verb-table `refreshQueue` read page 1 and threw the cursor away,
 *  which was harmless only because nothing consumed the order.
 *  A cursor that repeats (or a page that never ends) stops the walk as
 *  INCOMPLETE rather than looping forever. */
const QUEUE_LIST_MAX_PAGES = 50;
async function listQueueAll({ timeoutMs = 15000, budgetMs = null, deadline = null } = {}) {
  const rows = [];
  let cursor = null, pages = 0, complete = true;
  const seen = new Set();
  for (;;) {
    if (deadline && Date.now() >= deadline) { complete = false; log(`thread/queue/list: out of budget after ${pages} page(s) — the queue was read PARTIALLY`); break; }
    const params = { threadId: meta.threadId };
    if (cursor) params.cursor = cursor;
    const timeout = budgetMs ? budgetMs() : timeoutMs;
    const resp = await request('thread/queue/list', params, timeout);
    rows.push(...asArray(resp?.data || resp?.items));
    const next = resp?.nextCursor;
    if (next === undefined || next === null || next === '') break;
    cursor = String(next);
    if (seen.has(cursor)) { complete = false; log(`thread/queue/list: the app-server repeated cursor ${cursor} — stopping, the queue was read PARTIALLY`); break; }
    seen.add(cursor);
    if (++pages >= QUEUE_LIST_MAX_PAGES) { complete = false; log(`thread/queue/list: ${QUEUE_LIST_MAX_PAGES} pages without an end — stopping, the queue was read PARTIALLY`); break; }
  }
  return { rows, complete };
}

/** Re-read the authoritative queue. Single-flight + coalescing: the app-server
 *  fires thread/queue/changed per mutation and a steer-all makes several.
 *  Pages to the end: a queue longer than one page used to publish (and mirror
 *  into the sidecar) as if the tail did not exist. */
async function refreshQueue({ timeoutMs = 15000 } = {}) {
  if (!meta.threadId) return;
  // The deletes a Stop sweep makes each fire thread/queue/changed; listing
  // mid-sweep is pure waste (publishQueue is latched anyway) and on a wedged
  // app-server it piles hanging RPCs behind the user's Stop. The sweep always
  // ends with its own refresh, so nothing is lost by dropping these.
  if (queueSweepActive) return;
  if (queueRefreshInFlight) { queueRefreshAgain = true; return; }
  queueRefreshInFlight = true;
  try {
    do {
      queueRefreshAgain = false;
      const gen = queueSweepSeq;
      const listed = await listQueueAll({ timeoutMs });
      // A sweep OWNS the publish while it runs — drop this answer, prune
      // nothing (the sweep ends with its own refresh).
      if (queueSweepActive) return;
      // A sweep that STARTED and FINISHED while this list was in flight makes
      // the answer stale: it enumerates rows Stop has since dropped. Re-list
      // instead of returning — the sweep's own closing refresh coalesced into
      // this call (single-flight), so returning here would publish NOTHING and
      // leave the strip showing the removed items.
      if (gen !== queueSweepSeq) { queueRefreshAgain = true; continue; }
      const rows = listed.rows;
      const items = queueItemsFrom(rows);
      // PRUNE ONLY ON A COMPLETE READ: a partial list would evict the meta
      // (kind 'peer', the bubble's msgId) of every item on the pages we never
      // reached, and those items are still queued.
      if (listed.complete) {
        const live = new Set(rows.map((q) => asString(q?.clientUserMessageId)));
        for (const cid of [...queueMeta.keys()]) if (!live.has(cid)) queueMeta.delete(cid);
      }
      publishQueue(items);
    } while (queueRefreshAgain);
  } catch (e) {
    // A degrade path that logs the message VERBATIM (the 2.284.2 lesson):
    // an unreadable queue must never masquerade as an empty one.
    log('thread/queue/list failed: ' + e.message);
  } finally { queueRefreshInFlight = false; }
}

/** Classify a turn/steer rejection into something the USER can act on. The
 *  0.153.4 wire carries only {code:-32600, message} — the typed CodexErrorInfo
 *  variants (NoActiveTurn / ExpectedTurnMismatch / ActiveTurnNotSteerable) never
 *  reach the client — so the message text is the only discriminator we have. */
/** Classify a queue-MUTATION rejection. Measured against a live 0.153.4
 *  app-server (logged-out isolated CODEX_HOME — the queue verbs are server-side
 *  bookkeeping and need no API):
 *    update/delete on an id the server has drained →
 *      "queued submission not found: <id>"        ⇒ reason 'gone' (it RAN)
 *    reorder with an array that is not the whole queue →
 *      "queue reorder must include every queued submission exactly once"
 *                                                 ⇒ reason 'stale-order'
 *      (measured 2026-09-07: a truncated full order is REFUSED, it does NOT
 *      silently delete the missing items — which is why paging to the end
 *      matters for the op to WORK, not to avoid data loss.)
 *  Everything else keeps the server's own words in `detail`. */
function classifyQueueMutationFailure(message) {
  const m = String(message || '');
  if (/not found/i.test(m)) return { reason: 'gone' };
  if (/every queued submission exactly once/i.test(m)) return { reason: 'stale-order' };
  return { reason: 'error' };
}

function classifySteerFailure(message) {
  const m = String(message || '');
  if (/cannot steer a (review|compact) turn/i.test(m)) return { reason: 'not-steerable', kind: /review/i.test(m) ? 'review' : 'compact' };
  if (/expected active turn id/i.test(m)) return { reason: 'turn-mismatch' };
  if (/no active turn to steer/i.test(m)) return { reason: 'no-active-turn' };
  if (/only user input can steer/i.test(m)) return { reason: 'not-steerable' };
  return { reason: 'error' };
}

async function steerOne(item) {
  const cid = asString(item?.clientUserMessageId);
  const known = queueMeta.get(cid) || null;
  const base = { op: 'steer', id: asString(item?.id), msg_id: known?.msgId || '' };
  if (!meta.activeTurnId) return { ...base, ok: false, reason: 'no-active-turn' };
  try {
    await request('turn/steer', {
      threadId: meta.threadId,
      input: item.input,
      expectedTurnId: meta.activeTurnId,
      clientUserMessageId: cid || undefined,
    }, 30000);
  } catch (e) {
    log(`turn/steer rejected for ${base.id}: ${e.message}`);
    return { ...base, ok: false, detail: e.message, ...classifySteerFailure(e.message) };
  }
  // The steer landed: the message is now IN the turn, so the queued copy must
  // go or it runs a second time (measured: steer never dequeues). The delete's
  // VERDICT is read here exactly as the Stop sweep reads it (round-3 review):
  // `{deleted:false}` is not an error, it means the app-server had already
  // DRAINED the item — so it is running as its own turn AND it was just
  // injected into the current one, i.e. the double run this delete exists to
  // prevent already happened. Returning a bare ok:true there was the silent
  // half of the very failure `steered-not-dequeued` was invented to announce.
  let dequeued;
  try {
    dequeued = await deleteQueuedItem(base.id);
  } catch (e) {
    log(`steered ${base.id} but thread/queue/delete failed (${e.message}) — it may run a SECOND time`);
    return { ...base, ok: true, reason: 'steered-not-dequeued', detail: e.message };
  }
  if (!dequeued) {
    log(`steered ${base.id} but the app-server had already drained it (deleted:false) — it may run a SECOND time`);
    return { ...base, ok: true, reason: 'steered-not-dequeued', detail: 'it had already left the queue (it may run a second time)' };
  }
  queueMeta.delete(cid);
  return { ...base, ok: true };
}

/** `thread/queue/delete` WITH the app-server's own verdict. `{deleted:false}`
 *  is a real outcome, not an error: the item left the queue between our list
 *  and this call, and since the app-server DRAINS its own queue, "left the
 *  queue" means it RAN. Ignoring the flag chips a `Removed` on a message that
 *  is running right now, and hands an already-delivered peer message back to
 *  the delivery ladder for a SECOND delivery (round-2 review).
 *  @returns {Promise<boolean>} true = we removed it; false = it was already gone.
 *  An app-server that omits the flag ACKED the delete — only an explicit
 *  `false` is a refusal. */
async function deleteQueuedItem(id, timeoutMs = 15000) {
  const resp = await request('thread/queue/delete', { threadId: meta.threadId, queuedSubmissionId: id }, timeoutMs);
  return resp?.deleted !== false;
}

/** STOP CLEARS THE QUEUE (owner decision 2026-09-07 — every harness now, the
 *  ACP wrapper already did). The app-server DRAINS its own queue when a turn
 *  ends, including a turn ended by turn/interrupt (measured: the drained item
 *  starts a turn with no turn/start from us), so a Stop used to be followed
 *  instantly by whatever was queued behind it. Two orderings are load-bearing:
 *   (a) the deletes run BEFORE turn/interrupt, or the drain wins the race;
 *   (b) each removal result is emitted BEFORE the emptied republish, because
 *       the normalizer clears the chip of anything that left the queue with no
 *       explicit result (= "it ran") — a bare empty queue_changed would tell
 *       the user their message RAN when Stop threw it away (the ACP round-1
 *       review lesson, same frame, same reason).
 *   (c) the app-server's OWN verdict decides what we claim: {deleted:false}
 *       means it drained the item first, so that message is RUNNING — it is
 *       reported ok:false reason 'gone', never a `Removed` chip, and a peer
 *       entry on that path is NOT handed back to the delivery ladder;
 *   (d) the sweep is BUDGETED (per-RPC + overall): Stop is a safety control,
 *       so a wedged app-server gets the interrupt anyway and whatever is still
 *       queued is REPORTED instead of the button hanging (round-2 review).
 *  Nothing here is silent: a failed delete reports queue_op_result ok:false
 *  (the item is still queued and WILL run) and lands in the wrapper journal.
 *
 *  SINGLE-FLIGHT (round-3 review), because a second Stop is NORMAL: stdin
 *  dispatches `handleInput` WITHOUT awaiting it, so a double-click — or a
 *  second attached client's Stop, which nothing on this machine coordinates —
 *  used to start a second sweep on top of the running one. The second sweep
 *  listed the queue the first was still deleting and then reported those very
 *  items `gone` ("it already ran"), which is the exact falsehood this round
 *  exists to delete, and on that verdict a queued peer entry is deliberately
 *  NOT re-stashed — so the duplicate sweep also lost a promised message.
 *  A second Stop therefore RIDES the running sweep. What it clears is what
 *  that sweep LISTED; anything queued after that list is not silently
 *  swallowed — the sweep's closing publish still lists it, truthfully.
 *  @returns {Promise<number>} how many items left the queue. */
let stopSweepInFlight = null;
async function clearQueueForStop() {
  if (stopSweepInFlight) return stopSweepInFlight;
  stopSweepInFlight = _clearQueueForStop();
  try { return await stopSweepInFlight; } finally { stopSweepInFlight = null; }
}

async function _clearQueueForStop() {
  if (!meta.threadId) return 0;
  // THE BUDGET (round-2 review): Stop is a safety control. Every RPC below is
  // short-fused and the whole sweep is capped, so a wedged app-server costs
  // the user seconds, not 15s per item, before `turn/interrupt` goes out.
  const deadline = Date.now() + STOP_SWEEP_TOTAL_MS;
  const rpcBudget = () => Math.min(STOP_SWEEP_RPC_MS, Math.max(250, deadline - Date.now()));
  let data = [], listComplete = true;
  try {
    // Paged like every other reader, inside the SAME budget: a queue longer
    // than one page used to leave its tail untouched by Stop, silently.
    const listed = await listQueueAll({ budgetMs: rpcBudget, deadline });
    data = listed.rows; listComplete = listed.complete;
  } catch (e) {
    // The degrade path logs the message VERBATIM (2.284.2) and SPEAKS: an
    // unreadable queue means Stop could not clear it, which the user must know.
    log('interrupt: thread/queue/list failed: ' + e.message + ' — the queue was NOT cleared');
    emitTaskEvent('queue_op_result', { op: 'remove', id: '', ok: false, reason: 'error', detail: e.message });
    return 0;
  }
  if (!listComplete) {
    // Whatever we DID read is still deleted below — but the user must not be
    // told the queue was cleared when part of it was never even enumerated.
    log(`interrupt: the queue could not be read to the end (${data.length} item(s) enumerated) — anything beyond that stays queued and will run`);
    emitTaskEvent('queue_op_result', { op: 'remove', id: '', ok: false, reason: 'incomplete', detail: 'the queue could not be read to the end — anything Stop did not enumerate is still queued and will run' });
  }
  if (!data.length) return 0;
  queueSweepSeq++;
  queueSweepActive = true;
  let removed = 0;
  try {
    for (let i = 0; i < data.length; i++) {
      const q = data[i];
      const id = asString(q?.id);
      const cid = asString(q?.clientUserMessageId);
      const known = queueMeta.get(cid) || null;
      // OUT OF BUDGET: report everything still queued (it WILL run) and let the
      // interrupt go out NOW. A Stop that waits on a dead app-server is a dead
      // button — the one failure mode this control may never have.
      if (Date.now() >= deadline) {
        const left = data.slice(i);
        log(`interrupt: queue sweep out of budget (${STOP_SWEEP_TOTAL_MS}ms) with ${left.length} item(s) still queued — they stay queued and will run`);
        for (const r of left) {
          const rknown = queueMeta.get(asString(r?.clientUserMessageId)) || null;
          emitTaskEvent('queue_op_result', { op: 'remove', id: asString(r?.id), ok: false, reason: 'timeout', detail: `the app-server did not answer within ${STOP_SWEEP_TOTAL_MS}ms — Stop did not wait`, msg_id: rknown?.msgId || '' });
        }
        break;
      }
      let ours = false;
      try {
        ours = await deleteQueuedItem(id, rpcBudget());
      } catch (e) {
        log(`interrupt: thread/queue/delete failed for ${id} (${e.message}) — it stays queued and will run`);
        emitTaskEvent('queue_op_result', { op: 'remove', id, ok: false, reason: 'error', detail: e.message, msg_id: known?.msgId || '' });
        continue;
      }
      queueMeta.delete(cid);
      if (!ours) {
        // {deleted:false}: the app-server drained it between our list and this
        // call, so it is RUNNING. `gone` renders "no longer queued — it already
        // ran"; a `Removed` chip here would be a lie, and re-stashing a peer
        // message that really ran would deliver it a second time.
        log(`interrupt: ${id} had already left the queue (deleted:false) — it RAN, it was not stopped`);
        emitTaskEvent('queue_op_result', { op: 'remove', id, ok: false, reason: 'gone', msg_id: known?.msgId || '' });
        continue;
      }
      removed++;
      emitTaskEvent('queue_op_result', { op: 'remove', id, ok: true, msg_id: known?.msgId || '', reason: 'stopped' });
      // A queued PEER/job message was already reported delivered (peer_message_result
      // ok:'queued'), so dropping it silently would lose a promised message —
      // ok:false hands the text back to the delivery ladder, which re-stashes it
      // for next-turn injection (the explicit `remove` path's rule, verbatim).
      if (known?.kind === 'peer' && known.text) emitTaskEvent('peer_message_result', { ok: false, reason: 'dropped by Stop before it was delivered', text: known.text, fromName: known.from || null });
    }
  } finally { queueSweepActive = false; }
  // The republish comes AFTER every result above — the truth, not an assumed
  // empty: an item whose delete failed is still there and must still be listed.
  // Budgeted like the rest of the sweep: `turn/interrupt` is the caller's very
  // next statement and must not wait on this list.
  await refreshQueue({ timeoutMs: rpcBudget() });
  return removed;
}

/** `turn/interrupt`, at most ONE in flight per turn (round-3 review, the twin
 *  of the sweep's single-flight). A duplicate Stop frame that arrives while the
 *  interrupt RPC is still unanswered is the SAME stop, so it rides that call.
 *  The key is the TURN plus a live RPC — never a time window (the "identify an
 *  action by what defines it" rule): once the RPC has answered and the turn is
 *  somehow STILL running, a further Stop is a genuine retry and goes out. A
 *  duplicate that slips through anyway is harmless — the app-server rejects an
 *  interrupt for a finished turn and the rejection is logged, not surfaced. */
let interruptInFlight = null;   // {turnId, promise}
function interruptTurn(turnId) {
  if (interruptInFlight && interruptInFlight.turnId === turnId) {
    log(`interrupt: a turn/interrupt for ${turnId} is already in flight — this Stop rides it`);
    return interruptInFlight.promise;
  }
  const entry = { turnId, promise: null };
  entry.promise = request('turn/interrupt', { threadId: meta.threadId, turnId }, 30000)
    .catch((e) => { log(`turn/interrupt failed for ${turnId}: ${e.message}`); })
    .then(() => { if (interruptInFlight === entry) interruptInFlight = null; });
  interruptInFlight = entry;
  return entry.promise;
}

/** EDIT BY EXCLUSION (design-harness-features §2.1 / owner decision 1): the
 *  new text replaces the FIRST `text` element and every other element is
 *  carried over UNTOUCHED, IN PLACE — image / localImage / audio / localAudio /
 *  skill / mention, and whatever an eighth UserInput variant turns out to be.
 *  A whitelist ("keep the kinds I know") deletes attachments the day the
 *  protocol grows, which is exactly what `queuePreview`'s [image] / [skill …] /
 *  [@…] markers are telling the user is in there.
 *  `text_elements` on the replaced element is CLEARED: those byteRanges index
 *  the OLD text buffer, so keeping them would describe spans of a string that
 *  no longer exists. Further text elements are dropped (their content is what
 *  the user just rewrote); an input with no text element at all gets one at
 *  index 0, matching encodeUserInput's own order (text first, attachments
 *  after).
 *  @returns {Array} the full replacement `input` array. PURE. */
function replaceQueuedText(input, text) {
  const out = [];
  let replaced = false;
  for (const el of asArray(input)) {
    if (el && el.type === 'text') {
      if (!replaced) { replaced = true; out.push({ type: 'text', text, text_elements: [] }); }
      continue;
    }
    out.push(el);
  }
  if (!replaced) out.unshift({ type: 'text', text, text_elements: [] });
  return out;
}

/** The order a RELATIVE move means, computed against the FRESH server order.
 *  `afterId === null` = the front. Ids the caller never saw (a peer add
 *  between render and landing) are already in `ids` at their server position
 *  and simply stay there — that is the whole reason this translation happens
 *  here and not in the client. Returns null when the anchor is gone.
 *  PURE. */
function reorderedIds(ids, id, afterId) {
  const rest = ids.filter((x) => x !== id);
  if (afterId === null) return [id, ...rest];
  const at = rest.indexOf(afterId);
  if (at < 0) return null;
  return [...rest.slice(0, at + 1), id, ...rest.slice(at + 1)];
}

async function handleQueueOp(msg) {
  const op = asString(msg?.op);
  const id = asString(msg?.id);
  if (!meta.threadId) { emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'no-thread', detail: 'the session has no codex thread yet' }); return; }
  let data = [], listComplete = true;
  try {
    // FRESH and to the END — every verb below reasons about the whole queue,
    // and `reorder` REPLACES it (a partial read there deletes the tail).
    const listed = await listQueueAll({ timeoutMs: 15000 });
    data = listed.rows; listComplete = listed.complete;
  } catch (e) {
    log(`queue-op ${op}: thread/queue/list failed: ${e.message}`);
    emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'error', detail: e.message });
    return;
  }
  if (op === 'remove') {
    const item = data.find((q) => asString(q?.id) === id);
    // Gone = it already ran; say so instead of reporting a fake success.
    if (!item) { emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'gone' }); await refreshQueue(); return; }
    const known = queueMeta.get(asString(item.clientUserMessageId)) || null;
    try {
      // The SAME verdict the Stop sweep reads: {deleted:false} = the item was
      // drained between the list above and this call ⇒ it RAN. Reporting a
      // removal would chip a running message and re-stash a delivered one.
      const ours = await deleteQueuedItem(id);
      queueMeta.delete(asString(item.clientUserMessageId));
      if (!ours) {
        log(`thread/queue/delete refused for ${id} (deleted:false) — it had already left the queue, i.e. it ran`);
        emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'gone', msg_id: known?.msgId || '' });
        await refreshQueue();
        return;
      }
      // A queued PEER/job message was already reported delivered (peer_message_result
      // ok:'queued') — removing it must give the text back to the ladder, which
      // re-stashes it for next-turn injection. Never a silent loss.
      if (known?.kind === 'peer' && known.text) emitTaskEvent('peer_message_result', { ok: false, reason: 'removed from the queue before it was delivered', text: known.text, fromName: known.from || null });
      emitTaskEvent('queue_op_result', { op, id, ok: true, msg_id: known?.msgId || '' });
    } catch (e) {
      log(`thread/queue/delete failed for ${id}: ${e.message}`);
      emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'error', detail: e.message, msg_id: known?.msgId || '' });
    }
    await refreshQueue();
    return;
  }
  if (op === 'steer') {
    const item = data.find((q) => asString(q?.id) === id);
    if (!item) { emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'gone' }); await refreshQueue(); return; }
    emitTaskEvent('queue_op_result', await steerOne(item));
    await refreshQueue();
    return;
  }
  if (op === 'steer-all') {
    // IN QUEUE ORDER, one steer per item: the ones that land leave the queue,
    // the rest keep their relative order and still run after the turn. Stops at
    // the first failure — a review turn refuses ALL of them, and pushing on
    // would just print the same refusal N times.
    let done = 0;
    for (const item of data) {
      const r = await steerOne(item);
      emitTaskEvent('queue_op_result', { ...r, op: 'steer', batch: 'steer-all' });
      if (!r.ok) {
        // NO SECOND EVENT for the abort: the per-item result above is the
        // user-facing one and it carries the real reason AND the real turn
        // kind. A `{op:'steer-all', reason}` summary rendered a SECOND card
        // from the same failure, and its wording defaulted the kind to
        // "review" — so a compact turn was refused twice, once wrongly
        // (round-1 review). The abort stays in the journal, where an operator
        // reading the wrapper log wants it.
        log(`steer-all aborted after ${done}/${data.length}: ${r.reason}${r.detail ? ' — ' + r.detail : ''}`);
        await refreshQueue();
        return;
      }
      done++;
    }
    emitTaskEvent('queue_op_result', { op: 'steer-all', ok: true, done });
    await refreshQueue();
    return;
  }
  // ── REORDER (relative in, ABSOLUTE FULL ORDER out) ──
  if (op === 'reorder') {
    // A full-order replace computed from a partial read would DELETE every
    // item on the pages we never got. Refuse, loudly, with what happened.
    if (!listComplete) {
      log(`queue-op reorder ${id}: the queue could not be read to the end — refusing to send a full order`);
      emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'incomplete', detail: 'the queue could not be read to the end, and reordering replaces the whole order — nothing was changed' });
      await refreshQueue();
      return;
    }
    const ids = data.map((q) => asString(q?.id)).filter(Boolean);
    const known = queueMeta.get(asString(data.find((q) => asString(q?.id) === id)?.clientUserMessageId)) || null;
    if (!ids.includes(id)) { emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'gone', detail: 'it is no longer queued' }); await refreshQueue(); return; }
    const afterId = msg?.afterId === null || msg?.afterId === undefined ? null : asString(msg.afterId);
    const order = reorderedIds(ids, id, afterId);
    if (!order) {
      // The item it was dropped after left the queue in the meantime (it ran,
      // or a peer/Stop removed it). Say so — do NOT invent a position.
      emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'anchor-gone', detail: 'the message it was dropped after is no longer queued', msg_id: known?.msgId || '' });
      await refreshQueue();
      return;
    }
    if (order.join(',') === ids.join(',')) { emitTaskEvent('queue_op_result', { op, id, ok: true, reason: 'unchanged', msg_id: known?.msgId || '' }); await refreshQueue(); return; }
    try {
      await request('thread/queue/reorder', { threadId: meta.threadId, queuedSubmissionIds: order }, 15000);
      emitTaskEvent('queue_op_result', { op, id, ok: true, msg_id: known?.msgId || '' });
    } catch (e) {
      log(`thread/queue/reorder failed for ${id}: ${e.message}`);
      emitTaskEvent('queue_op_result', { op, id, ok: false, ...classifyQueueMutationFailure(e.message), detail: e.message, msg_id: known?.msgId || '' });
    }
    await refreshQueue();
    return;
  }
  // ── EDIT (text only; every other input element survives by exclusion) ──
  if (op === 'edit') {
    const item = data.find((q) => asString(q?.id) === id);
    if (!item) {
      emitTaskEvent('queue_op_result', { op, id, ok: false, reason: listComplete ? 'gone' : 'incomplete', detail: listComplete ? 'it is no longer queued' : 'the queue could not be read to the end, so that message could not be found' });
      await refreshQueue();
      return;
    }
    const cid = asString(item.clientUserMessageId);
    const known = queueMeta.get(cid) || null;
    // A PEER entry is another agent's words (jobs / vibespace-msg ride this
    // same lane). Rewriting them would put text in someone else's mouth —
    // the client hides the control too, and this is the gate that MEANS it.
    if (known?.kind === 'peer') {
      emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'not-editable', detail: 'it was sent by another agent — you can remove it, but not rewrite it', msg_id: known?.msgId || '' });
      return;
    }
    const text = typeof msg?.text === 'string' ? msg.text : '';
    if (!text.trim()) { emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'empty-text', detail: 'an edited message needs some text — remove it instead', msg_id: known?.msgId || '' }); return; }
    try {
      await request('thread/queue/update', { threadId: meta.threadId, queuedSubmissionId: id, input: replaceQueuedText(item.input, text) }, 15000);
      emitTaskEvent('queue_op_result', { op, id, ok: true, msg_id: known?.msgId || '' });
    } catch (e) {
      log(`thread/queue/update failed for ${id}: ${e.message}`);
      emitTaskEvent('queue_op_result', { op, id, ok: false, ...classifyQueueMutationFailure(e.message), detail: e.message, msg_id: known?.msgId || '' });
    }
    await refreshQueue();
    return;
  }
  // ── RUN NOW / RUN ALL (thread/queue/start, with and without an id) ──
  if (op === 'run-now' || op === 'run-all') {
    // BUSY = an explicit refusal, never a wait: "it will run when this turn
    // ends" is already true, and queueing the request behind the turn would be
    // accept-and-ignore (2.361.4) wearing a different hat.
    if (meta.activeTurnId) {
      emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'busy', detail: 'a turn is running — the queue runs as soon as it ends' });
      return;
    }
    if (!data.length) { emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'empty', detail: 'nothing is queued' }); await refreshQueue(); return; }
    if (op === 'run-now') {
      const item = data.find((q) => asString(q?.id) === id);
      if (!item) {
        emitTaskEvent('queue_op_result', { op, id, ok: false, reason: listComplete ? 'gone' : 'incomplete', detail: listComplete ? 'it is no longer queued' : 'the queue could not be read to the end, so that message could not be found' });
        await refreshQueue();
        return;
      }
    }
    const known = op === 'run-now' ? (queueMeta.get(asString(data.find((q) => asString(q?.id) === id)?.clientUserMessageId)) || null) : null;
    try {
      // The id is only ever OMITTED for the deliberate 'run-all' verb —
      // thread/queue/start without one drains the whole queue.
      const params = op === 'run-now' ? { threadId: meta.threadId, queuedSubmissionId: id } : { threadId: meta.threadId };
      await request('thread/queue/start', params, 30000);
      emitTaskEvent('queue_op_result', { op, id, ok: true, msg_id: known?.msgId || '' });
    } catch (e) {
      log(`thread/queue/start failed (${op}${id ? ' ' + id : ''}): ${e.message}`);
      emitTaskEvent('queue_op_result', { op, id, ok: false, ...classifyQueueMutationFailure(e.message), detail: e.message, msg_id: known?.msgId || '' });
    }
    await refreshQueue();
    return;
  }
  emitTaskEvent('queue_op_result', { op, id, ok: false, reason: 'unknown-op', detail: `this agent has no queue action "${op}"` });
}

// ── SERVER REQUESTS: ONE EXPLICIT BRANCH PER METHOD (2.369.58) ──
// The app-server is also a CLIENT of ours: it sends JSON-RPC *requests* and
// BLOCKS until we answer. Every method has its OWN result schema (dumped with
// `codex app-server generate-json-schema --experimental` on 0.153.4) and they
// share no vocabulary:
//   item/commandExecution/requestApproval → {decision: accept|acceptForSession|
//        {acceptWithExecpolicyAmendment}|{applyNetworkPolicyAmendment}|decline|cancel}
//        (we send only the three PLAIN variants — see the branch comment)
//   item/fileChange/requestApproval       → {decision: accept|acceptForSession|decline|cancel}
//   item/permissions/requestApproval      → {permissions: GrantedPermissionProfile, scope?, strictAutoReview?}
//   item/tool/requestUserInput            → {answers: {<question id>: {answers: [string]}}}   (NO decision field)
//   mcpServer/elicitation/request         → {action: accept|decline|cancel, content?}
//   applyPatchApproval / execCommandApproval (v1) → {decision: ReviewDecision}
//        = approved | approved_for_session | {denied:{rejection}} | abort | …
//   currentTime/read                      → {currentTimeAt: <unix seconds>}
//   item/tool/call / attestation/generate / account/chatgptAuthTokens/refresh
//        → values only a client that OWNS them can produce; we own none.
// Until 2.369.58 exactly ONE method was matched by name and everything else got
// `{decision: 'decline'}` — a result the server cannot deserialize for four of
// them, i.e. a hung turn nobody could explain, plus a bogus "Permission" card
// for requests no human should ever see.
// THE RULE: every method in the ServerRequest union has an explicit branch. One
// we cannot answer is refused with a JSON-RPC ERROR (the ACP wrapper's
// precedent — the call FAILS CLEANLY) plus a VISIBLE system line; never a
// silent wrong-shaped result, never a hang.
const approvedOf = (msg) => msg?.approved === true || msg?.responseData?.decision === 'accept';
const abortOf = (msg) => !!msg?.abort || msg?.responseData?.decision === 'cancel';
const alwaysOf = (msg) => !!msg?.alwaysAllow;
const rejectionOf = (msg) => asString(msg?.reason) || asString(msg?.responseData?.reason) || 'Denied by the user in VibeSpace.';
const answersOf = (msg) => (msg?.responseData && msg.responseData.answers) || (msg?.toolInput && msg.toolInput.answers) || {};

const SERVER_REQUEST_SPEC = {
  'item/commandExecution/requestApproval': { kind: 'ask', reply: (msg) => {
    if (!approvedOf(msg)) return { decision: abortOf(msg) ? 'cancel' : 'decline' };
    // NO `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` here.
    // Two independent reasons, and the first one is the very bug this table
    // exists to kill (r2 review — the one branch that never validated was the
    // one the first cut of the gate certified):
    //  ① SHAPE. `execpolicy_amendment` is `string[]` — execpolicy RULE LINES,
    //     which only the server can author (it proposes them in
    //     `params.proposedExecpolicyAmendment`). The only thing this side ever
    //     holds is the CLIENT's `permissionUpdates`, an array of OPTION
    //     OBJECTS (`[{kind:'allow_always'}]`, chat-renderers.js) — posting it
    //     is a deserialization failure, i.e. the hung turn again.
    //  ② SCOPE. "Always Allow" in our UI is a SESSION-scoped promise;
    //     an execpolicy amendment outlives the session. Upgrading one to the
    //     other is a product decision (owner-gated), never a serialization
    //     detail — `acceptForSession` says exactly what the button said.
    // A future UI affordance for the amendment must echo the SERVER's own
    // `proposedExecpolicyAmendment` strings, never anything client-built.
    return { decision: alwaysOf(msg) ? 'acceptForSession' : 'accept' };
  } },
  // FileChangeApprovalDecision has NO execpolicy/network amendment variants —
  // sending one here would be a deserialization failure, not a nicer answer.
  'item/fileChange/requestApproval': { kind: 'ask', reply: (msg) => (approvedOf(msg)
    ? { decision: alwaysOf(msg) ? 'acceptForSession' : 'accept' }
    : { decision: abortOf(msg) ? 'cancel' : 'decline' }) },
  // A GRANT, not a decision: GrantedPermissionProfile has the same shape as the
  // RequestPermissionProfile in the params, so approving = handing back exactly
  // what was asked for and denying = granting nothing.
  'item/permissions/requestApproval': { kind: 'ask', reply: (msg, orig) => {
    const asked = orig.params && orig.params.permissions && typeof orig.params.permissions === 'object' ? orig.params.permissions : {};
    if (!approvedOf(msg)) return { permissions: { fileSystem: null, network: null }, scope: 'turn' };
    return { permissions: asked, scope: alwaysOf(msg) ? 'session' : 'turn' };
  } },
  'item/tool/requestUserInput': { kind: 'ask', reply: (msg, orig) => (approvedOf(msg)
    ? { answers: normalizeNestedAnswers(answersOf(msg), asArray(orig.params?.questions)) }
    // The schema has no decline variant: an EMPTY map is the only well-formed
    // way to say "the user answered nothing".
    : { answers: {} }) },
  'mcpServer/elicitation/request': { kind: 'ask', reply: (msg, orig) => {
    if (!approvedOf(msg)) return { action: abortOf(msg) ? 'cancel' : 'decline' };
    const content = elicitationContent(orig.params || {}, msg);
    // `content` is nullable in the schema (decline/cancel carry none) and a
    // url-mode accept has nothing to send — omit rather than post an empty {}.
    return Object.keys(content).length ? { action: 'accept', content } : { action: 'accept' };
  } },
  // v1 legacy pair — a DIFFERENT enum (ReviewDecision), which is exactly why
  // one shared `{decision:'accept'}` was wrong.
  'applyPatchApproval': { kind: 'ask', reply: replyReviewDecision },
  'execCommandApproval': { kind: 'ask', reply: replyReviewDecision },
  // A fact we simply KNOW — answered instantly, never a card. Leaving it to a
  // human would hang the turn behind a question nobody can answer.
  'currentTime/read': { kind: 'auto', reply: () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }) },
  'item/tool/call': { kind: 'unsupported', why: 'this client declares no dynamic tools (thread/start sends no dynamicTools)' },
  'account/chatgptAuthTokens/refresh': { kind: 'unsupported', why: 'codex reads its own auth.json under CODEX_HOME; VibeSpace holds no ChatGPT refresh flow' },
  'attestation/generate': { kind: 'unsupported', why: 'VibeSpace cannot mint client attestation tokens' },
};

function replyReviewDecision(msg) {
  if (approvedOf(msg)) return { decision: alwaysOf(msg) ? 'approved_for_session' : 'approved' };
  if (abortOf(msg)) return { decision: 'abort' };
  return { decision: { denied: { rejection: rejectionOf(msg) } } };
}

// An MCP elicitation's requestedSchema → the SAME question rows the
// AskUserQuestion card family already renders. ONE derivation, used both when
// the request is RECORDED (so the card has rows) and when the reply is BUILT
// (so an answer maps back onto the right property) — a second copy in the
// normalizer would be a twin that drifts.
function elicitationQuestions(params) {
  const mode = asString(params?.mode);
  const message = asString(params?.message) || 'The MCP server is asking for input.';
  const header = asString(params?.serverName) || 'MCP';
  if (mode === 'url') {
    return [{ id: 'url', header, question: `${message}\n${asString(params?.url)}`, options: null }];
  }
  const schema = params && typeof params.requestedSchema === 'object' && params.requestedSchema ? params.requestedSchema : null;
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!props) return [{ id: 'response', header, question: message, options: null }];
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const out = [];
  for (const [name, specRaw] of Object.entries(props)) {
    const spec = specRaw && typeof specRaw === 'object' ? specRaw : {};
    const label = asString(spec.title) || asString(spec.description) || name;
    let options = null;
    if (Array.isArray(spec.enum) && spec.enum.length) {
      const names = Array.isArray(spec.enumNames) ? spec.enumNames : [];
      options = spec.enum.map((v, i) => ({ label: String(v), description: asString(names[i]) }));
    } else if (Array.isArray(spec.oneOf) && spec.oneOf.length && spec.oneOf.every((o) => o && o.const !== undefined)) {
      options = spec.oneOf.map((o) => ({ label: String(o.const), description: asString(o.title) }));
    } else if (String(spec.type || '') === 'boolean') {
      options = [{ label: 'true', description: '' }, { label: 'false', description: '' }];
    }
    out.push({ id: name, header: `${header}${required.includes(name) ? ' *' : ''}`, question: `${message} — ${label}`, options, isSecret: !!spec.secret });
  }
  return out;
}

// The accepted elicitation's `content`, typed per the requestedSchema (the MCP
// contract: a boolean property must arrive as a JSON boolean, not "true").
function elicitationContent(params, msg) {
  const schema = params && typeof params.requestedSchema === 'object' && params.requestedSchema ? params.requestedSchema : null;
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  const answers = normalizeNestedAnswers(answersOf(msg), elicitationQuestions(params));
  if (!props) {
    const only = answers.response || answers.url || null;
    return only ? { response: only.answers[0] } : {};
  }
  const content = {};
  for (const [name, specRaw] of Object.entries(props)) {
    const got = answers[name];
    if (!got || !got.answers.length) continue;
    const spec = specRaw && typeof specRaw === 'object' ? specRaw : {};
    const type = String(spec.type || 'string');
    const first = got.answers[0];
    if (type === 'boolean') content[name] = /^(true|yes|on|1)$/i.test(first);
    else if (type === 'number' || type === 'integer') { const n = Number(first); if (Number.isFinite(n)) content[name] = n; }
    else if (type === 'array') content[name] = got.answers.slice();
    else content[name] = first;
  }
  return content;
}

// The arrival side of the same table: classify BEFORE a card is ever created.
function handleServerRequest(msg) {
  const method = asString(msg.method);
  const spec = SERVER_REQUEST_SPEC[method] || null;
  if (spec && spec.kind === 'auto') {
    let result = null;
    try { result = spec.reply(msg); } catch (e) { log(`server request ${method} auto-reply failed: ${e.message}`); }
    if (result) { send({ id: msg.id, result }); log(`server request ${method} answered automatically`); return; }
  }
  if (!spec || spec.kind !== 'ask') {
    const why = spec ? (spec.why || `VibeSpace could not produce the ${method} value it owes`) : 'VibeSpace implements no branch for this app-server request';
    send({ id: msg.id, error: { code: -32601, message: `Method not supported by the VibeSpace client: ${method} — ${why}` } });
    // LOUD, not silent: the user sees a system line, Diagnostics gets the
    // once-per-method breadcrumb (the normalizer fires it), the journal keeps
    // the detail. An upstream method we have never seen shows up HERE.
    record('event_msg', { type: 'client_request_unsupported', method, reason: why, request_id: msg.id ?? null });
    log(`server request ${method} REFUSED with a JSON-RPC error (${why})`);
    return;
  }
  pendingServerRequests.set(String(msg.id), msg);
  meta.pendingRequests[String(msg.id)] = { id: msg.id, method, params: msg.params || {} };
  const rec = { id: msg.id, method, params: msg.params || {} };
  // The elicitation rows travel WITH the record so the card and the reply
  // mapping come from the same derivation.
  if (method === 'mcpServer/elicitation/request') rec.questions = elicitationQuestions(msg.params || {});
  record('server_request', rec);
  scheduleMeta();
}

async function respondToServerRequest(msg) {
  const requestId = msg.requestId;
  const original = pendingServerRequests.get(String(requestId));
  if (!original) return;
  const method = asString(original.method);
  const spec = SERVER_REQUEST_SPEC[method] || null;
  let result;
  if (spec && spec.kind === 'ask') {
    try { result = spec.reply(msg, original); }
    catch (e) {
      log(`server request ${method} reply builder failed: ${e.message}`);
      send({ id: requestId, error: { code: -32603, message: `VibeSpace could not build a reply for ${method}: ${e.message}` } });
      record('event_msg', { type: 'client_request_unsupported', method, reason: `reply builder failed: ${e.message}`, request_id: requestId });
      delete meta.pendingRequests[String(requestId)];
      pendingServerRequests.delete(String(requestId));
      scheduleMeta();
      return;
    }
  } else {
    // Belt and braces: a card can only exist for an 'ask' method, but a pending
    // entry that survived a wrapper upgrade must not be answered in some other
    // method's vocabulary.
    send({ id: requestId, error: { code: -32601, message: `Method not supported by the VibeSpace client: ${method}` } });
    delete meta.pendingRequests[String(requestId)];
    pendingServerRequests.delete(String(requestId));
    scheduleMeta();
    return;
  }

  send({ id: requestId, result });
  record('server_request_resolved', {
    id: requestId,
    method,
    decision: describeServerRequestDecision(result),
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
      const cid = msg.msgId || `queued-${process.pid}-${nextId++}`;
      // Register the identity BEFORE the RPC: the app-server answers the add
      // with a thread/queue/changed notification, and the refresh it triggers
      // can win the race with this call's own reply — an item whose msgId we
      // learn late renders with no bubble chip.
      noteQueued(cid, { kind: 'user', msgId: msg.msgId || '' });
      await request('thread/queue/add', {
        threadId: meta.threadId,
        input: encodeUserInput(text, attachments),
        clientUserMessageId: cid,
      }, 30000);
      emitTaskEvent('queued_input', { msg_id: msg.msgId || '', turn_id: meta.activeTurnId });
      log('chat-input queued (turn active; runs after the current turn)');
      refreshQueue();
      return;
    }
    await startTurn(text, attachments);
    return;
  }
  if (msg.type === 'interrupt') {
    if (meta.threadId) {
      // STOP MEANS STOP — on every harness (owner decision 2026-09-07; the ACP
      // wrapper, whose queue is its own, always did this). The app-server
      // DRAINS its queue when the turn ends, so clearing it AFTER the interrupt
      // would lose the race: delete first, interrupt second. Both halves are
      // single-flight (a second Stop frame rides them); the sweep's own throw
      // may never eat the interrupt — Stop is a safety control, so the failure
      // is logged VERBATIM and the turn is interrupted anyway.
      try { await clearQueueForStop(); } catch (e) { log(`interrupt: the queue sweep threw: ${e.message} — interrupting anyway`); }
      // The turn to interrupt is the one running AFTER the sweep (an item the
      // app-server drained mid-sweep opened its own turn, and Stop means that
      // one stops too), captured ONCE so the coalescing key and the RPC name
      // the same turn.
      const stopTurnId = meta.activeTurnId;
      if (stopTurnId) await interruptTurn(stopTurnId);
      // Re-read once more: the interrupt itself is a queue-mutating event on
      // the server side, and an unreadable/undeletable item must still be shown.
      refreshQueue();
    }
    return;
  }
  if (msg.type === 'queue-op') {
    await handleQueueOp(msg);
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
        const cid = `peer-${process.pid}-${nextId++}`;
        // `text` rides the entry so a REMOVE can hand the message back to the
        // delivery ladder instead of losing something we already reported
        // delivered (the ACP wrapper's Stop-drop rule, same reason).
        noteQueued(cid, { kind: 'peer', msgId: '', from: fromName, text });
        await request('thread/queue/add', {
          threadId: meta.threadId,
          input: encodeUserInput(text, []),
          clientUserMessageId: cid,
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
    // Applied on the NEXT turn — effort is a per-turn param and the RUNNING
    // turn keeps the one it started with (that is what the popup shows for its
    // messages).
    effort = msg.effort || '';
    meta.effortOverride = effort;
    meta.effortNext = effort || threadEffort || '';
    // …and tell the APP-SERVER, not just ourselves (2.369.62): only turn/start
    // carries our value, so before this a turn the app-server starts on its own
    // (queue drain, resume auto-continue, goal continuation) still ran at the
    // OLD effort while our UI claimed the new one. ThreadSettingsUpdateParams
    // .effort is documented "Override the reasoning effort for subsequent
    // turns" (0.153.4) — exactly this verb. Our belief moves only if it is
    // ACCEPTED; a refusal leaves the per-turn path (turn/start) as the fallback
    // it always was.
    let settingsAccepted = false;
    if (meta.threadId) {
      try {
        await request('thread/settings/update', { threadId: meta.threadId, effort: effort || null }, 30000);
        threadEffort = effort;
        meta.threadEffort = threadEffort;
        settingsAccepted = true;
      } catch (e) {
        log('thread/settings/update (effort) refused, per-turn effort still applies: ' + e.message);
      }
    }
    // ONLY WHAT CODEX AGREED TO (r2 review). `thread_settings_applied` states
    // what the THREAD is set to; emitting it after a REFUSED
    // thread/settings/update wrote a record — in codex's own rollout spelling,
    // unmarked — describing a setting codex had just rejected, and a rebuilt
    // history kept it forever (our 5-key payload never dedups against codex's
    // 9-key one). So: applied ⇒ record it, marked `wrapper: true` the way the
    // synthesized turn_context is; refused (or no thread to command yet) ⇒ say
    // nothing about the thread. The PENDING pick still reaches every other
    // client and any mid-turn attach either way, through the wrapper's own
    // status record below (`effortNext`) — that one is a statement about US,
    // which is exactly what a refusal leaves true.
    if (settingsAccepted) {
      record('event_msg', {
        type: 'thread_settings_applied',
        thread_id: meta.threadId,
        wrapper: true,
        thread_settings: {
          model: meta.model || '',
          approval_policy: meta.approvalPolicy || '',
          cwd: meta.cwd || '',
          reasoning_effort: effort || null,
          personality: personality || null,
        },
      });
    }
    recordWrapperMeta();
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
  if (msg.type === 'set-response-style') {
    // LIVE style switch (codex `thread/settings/update`, 0.153.4 schema:
    // {threadId, personality} — "Override the personality for subsequent
    // turns"). Unlike claude's spawn-only --settings outputStyle this needs no
    // restart. An unknown value is REFUSED LOUDLY, never sent (the enum is
    // closed; a bad value would make the whole update fail server-side and the
    // user would see nothing).
    const want = typeof msg.style === 'string' ? msg.style.trim() : '';
    if (want && !PERSONALITY_VALUES.includes(want)) {
      emitTaskEvent('task_failed', { error: `Unknown response style "${want}" — codex accepts ${PERSONALITY_VALUES.join(' / ')} (or none of them, which keeps your config.toml setting).` });
      return;
    }
    if (!meta.threadId) throw new Error('No threadId available for thread/settings/update');
    // Clearing is a REAL update (`personality: null` = drop the thread
    // override) — that is the only way back to the config-file default on a
    // thread we already styled.
    await request('thread/settings/update', { threadId: meta.threadId, personality: want || null }, 30000);
    personality = want;
    meta.personality = want;
    scheduleMeta();
    emitTaskEvent('command_applied', { command: 'style', value: want || '(config default)' });
    log('Response style set live: ' + (want || '(config default)'));
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
    handleServerRequest(msg);   // classify FIRST (auto / unsupported / ask) — 2.369.58
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
  // Baseline queue publish: a RESUMED thread can come back with items already
  // queued, and an empty queue still has to be stated once so a reconnecting
  // client's strip starts from a fact rather than from nothing.
  refreshQueue().then(() => publishQueue(meta.queue || [], { force: true }));
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
