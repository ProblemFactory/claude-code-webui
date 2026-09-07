#!/usr/bin/env node
// ACP chat wrapper (S8 of docs/design-harness-plugins.md §2.3) — the GENERIC
// Agent Client Protocol v1 client that runs inside dtach exactly like
// codex-chat-wrapper.js: it OWNS the agent subprocess's stdio (`opencode acp`
// today; any ACP v1 agent tomorrow), speaks JSON-RPC 2.0 over the pipe,
// journals every protocol event as ONE JSON line to stdout AND the buffer
// file in the VibeSpace 'acp-events' record shape (below), keeps the sidecar
// meta the server reads (caps advert, streaming flag, session id, agent
// info/capabilities), and serves the WRAPPER CONTRACT stdin verbs.
//
//   argv: <bufferFile> <sidecarMetaFile> <agentCommand> [agentArgs…]
//   env:  ACP_WEBUI_CWD          working directory for session/new|load
//         ACP_WEBUI_MODEL        initial model (set_config_option 'model' category when offered)
//         ACP_WEBUI_MODE         initial agent mode (config 'mode' category → session/set_mode fallback)
//         ACP_WEBUI_RESUME_ID    ACP session id to load (session/load when the agent adverts loadSession,
//                                session/resume when it adverts sessionCapabilities.resume, else LOUD notice + new)
//         ACP_WEBUI_SESSION_NAME VibeSpace session name (recorded only — ACP has no session naming)
//         ACP_WEBUI_BACKEND      harness id stamped into meta/records ('opencode')
//         VIBESPACE_API / VIBESPACE_SESSION_TOKEN — task-context prompt prefix + stop-time bookkeeping nudge
//
// 'acp-events' RECORD SHAPE (every line: {ts, type:'acp', kind, …}):
//   session             {sessionId, cwd, how:'new'|'load'|'resume', agentInfo, capabilities, protocolVersion,
//                        authMethods, configOptions, modes, models, model, mode}  — id adoption source
//   config              {configOptions, modes, models, model, mode, source}       — set_config_option/set_mode
//                        results and agent-side config_option_update/current_mode_update
//   user                {msgId, content:[{type:'text',text}|{type:'image',mediaType,data}], peer:{name,body}|null}
//   prompt_start        {promptId}                                               — session/prompt sent (streaming on)
//   prompt_end          {promptId, stopReason, error:{message}|null}             — reply/error (streaming off)
//   update              {sessionId, update:<raw ACP SessionUpdate>, replay?:true} — every session/update verbatim
//   permission_request  {requestId, toolCall, options:[{optionId,name,kind}]}
//   permission_resolved {requestId, outcome:'selected'|'cancelled', optionId, optionKind}
//   client_request      {requestId, method, replied:'unsupported'}               — fs/*, terminal/*, unknown
//   notification        {method, params}                                         — non-update notifications
//   notice              {level:'info'|'error', text, noticeKind}                 — loud wrapper-side outcomes
//   peer_result         {ok, mode, reason, text, fromName}                        — peer-message honesty
//   queued_input        {msg_id, turn_id}                                        — a send landed in the queue
//   queue_changed       {items:[{id,msgId,preview,ts,kind,from}], turn_id}       — the WHOLE queue, on every change
//   queue_op_result     {op, id, ok, reason, detail, msg_id}                     — queue-op honesty
//   plus the bare {type:'_stdin_ack', timestamp} line per stdin line (server broken-pty detector).
//
// STDIN VERBS: chat-input → session/prompt (queued while a prompt runs — ACP has
// no queue verb, so the queue is OURS: published as queue_changed, mutable
// through queue-op 'remove'; there is no steer, and backend-caps
// inputModes.steer=false stops one before it reaches this file);
// queue-op → remove a queued entry (a queued peer message goes back to the
// delivery ladder, exactly as Stop does); interrupt → session/cancel (+ every pending request_permission
// answered 'cancelled', per spec) AND the local queue is always dropped (a
// queued peer message goes back to the delivery ladder as peer_result ok:false);
// a prompt cancelled while it was still awaiting its context prefix is never
// dispatched (prompt_end 'cancelled'); permission-response → the pending
// request_permission reply (explicit optionId, else the option whose kind
// matches approved/alwaysAllow — a Deny with no reject-kind option FAILS CLOSED
// to {outcome:'cancelled'}, never an allow option); set-model/set-effort → set_config_option on the
// 'model'/'thought_level' category; set-mode/set-permission-mode → 'mode'
// category, else session/set_mode; peer-message → a prompt prefixed
// 'Message from <name>:'; _frame_file; _stdin_ack per line.
//
// Program-use billing law: the agent runs its OWN interactive channel (its
// login / provider config) — this wrapper never holds a vendor secret and
// never calls a vendor API.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const bufferFile = process.argv[2];
const metaFile = process.argv[3];
const cmd = process.argv[4];
const args = process.argv.slice(5);
const logFile = path.join(path.dirname(bufferFile || '/tmp/acp-wrapper'), 'acp-wrapper.log');

const HARNESS = process.env.ACP_WEBUI_BACKEND || 'acp';
const baseCwd = process.env.ACP_WEBUI_CWD || process.cwd();
const initialModel = process.env.ACP_WEBUI_MODEL || '';
const initialMode = process.env.ACP_WEBUI_MODE || '';
const resumeId = process.env.ACP_WEBUI_RESUME_ID || '';
const sessionName = process.env.ACP_WEBUI_SESSION_NAME || '';
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'vibespace', title: 'VibeSpace', version: process.env.ACP_WEBUI_CLIENT_VERSION || '2' };
const MAX_BUFFER = 800000;

function log(msg) {
  try {
    try { if (fs.statSync(logFile).size > 5242880) fs.renameSync(logFile, logFile + '.old'); } catch {}
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${HARNESS}] ${msg}\n`);
  } catch {}
}
function now() { return new Date().toISOString(); }
function safeJsonParse(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }
function asArray(v) { return Array.isArray(v) ? v : []; }
function clip(v, n = 4000) { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s && s.length > n ? s.slice(0, n) + '…' : s; }

if (!bufferFile || !metaFile || !cmd) {
  log('Missing required arguments (bufferFile, metaFile, agent command)');
  process.exit(1);
}

// ── sidecar meta (the file THIS process writes; the server's capability gate
// reads caps from HERE — the 2.361.1/2.364.1 law) ──
// THE VERBS THIS BUILD SERVES (ACP v1 has no queue in the protocol, so the
// wrapper's own promptQueue is the queue and these are array ops). Read by the
// sidecar advert AND by every `queue_changed` publication — a remote wrapper's
// sidecar is not on the orchestrator's disk.
const ACP_QUEUE_VERBS = ['remove', 'reorder', 'edit'];

const meta = {
  pid: process.pid,
  startedAt: Date.now(),
  mode: 'chat',
  backend: HARNESS,
  cwd: baseCwd,
  sessionId: resumeId || null,
  sessionName: sessionName || null,
  streaming: false,
  activePromptId: null,
  model: '',
  agentMode: '',
  configOptions: [],
  modes: null,
  availableCommands: [],
  todos: [],
  usage: null,
  pendingRequests: {},
  acp: { agentInfo: null, capabilities: null, protocolVersion: null, authMethods: [] },
  // frameFile: >64KB chat frames may arrive as a _frame_file pointer.
  // peerMessage: false — the server's live lane stays 'stash-only' for ACP
  // harnesses (backend-caps peerDelivery); the verb below exists for direct
  // callers/tests and flips this advert when the lane is switched on.
  // inputQueue: ACP v1 has NO queue verb, so this wrapper's promptQueue IS the
  // queue — it publishes `queue_changed` and serves the `queue-op` stdin verb.
  // queueVerbs: remove / reorder / edit, which on a LOCAL ARRAY are three
  // splices. NOT steer (a running session/prompt cannot be injected into) and
  // NOT run-now/run-all (this queue only has entries WHILE a prompt runs — an
  // idle wrapper dispatches immediately — so "run it now" could only ever
  // answer busy). Declaring either would be the accept-and-ignore failure.
  caps: { frameFile: true, peerMessage: false, inputQueue: true, queueVerbs: ACP_QUEUE_VERBS },
  queue: [],
};

let buffer = '';
let writeTimer = null;
let metaTimer = null;
function persistBuffer() {
  writeTimer = null;
  try { fs.mkdirSync(path.dirname(bufferFile), { recursive: true }); fs.writeFileSync(bufferFile, buffer); } catch {}
}
function persistMeta() {
  metaTimer = null;
  try { fs.mkdirSync(path.dirname(metaFile), { recursive: true }); fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch {}
}
function schedulePersist() { if (!writeTimer) writeTimer = setTimeout(persistBuffer, 1000); }
function scheduleMeta() { if (!metaTimer) metaTimer = setTimeout(persistMeta, 200); }

function writeRecord(rec) {
  const line = JSON.stringify(rec);
  buffer += `${line}\n`;
  if (buffer.length > MAX_BUFFER) {
    const idx = buffer.indexOf('\n', buffer.length - MAX_BUFFER);
    if (idx > 0) buffer = buffer.slice(idx + 1);
  }
  try { process.stdout.write(`${line}\n`); } catch {}
  schedulePersist();
}
function record(kind, fields = {}) { writeRecord({ ts: now(), type: 'acp', kind, ...fields }); }
function notice(level, text, noticeKind = null) {
  record('notice', { level, text, noticeKind });
  log(`${level}: ${text}`);
}

// ── JSON-RPC 2.0 over the child's stdio ──
let child = null;
let nextId = 1;
const pendingRequests = new Map();      // id → {resolve, reject, method}
const pendingPermissions = new Map();   // requestId(string) → {id, params}
let shuttingDown = false;
let lineBufB = Buffer.alloc(0);

function send(payload) {
  if (!child?.stdin?.writable) { log(`drop outbound (${payload.method || 'reply ' + payload.id}) — child stdin not writable`); return false; }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  return true;
}
function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (!send({ id, method, params })) { reject(new Error(`${method}: agent stdin closed`)); return; }
    const timer = timeoutMs > 0 ? setTimeout(() => { pendingRequests.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs) : null;
    pendingRequests.set(id, {
      method,
      resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
      reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
    });
  });
}
function notify(method, params) { send({ method, params }); }
function reply(id, result) { send({ id, result }); }
function replyError(id, code, message, data) { send({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }

// ── config helpers (session config options; modes as the legacy fallback) ──
function flattenSelect(opt) {
  const out = [];
  for (const it of asArray(opt?.options)) {
    if (it && Array.isArray(it.options)) out.push(...it.options.filter(Boolean)); // grouped select
    else if (it) out.push(it);
  }
  return out;
}
function findOption(category, idGuess) {
  const list = asArray(meta.configOptions);
  return list.find((o) => o && o.category === category) || list.find((o) => o && o.id === idGuess) || null;
}
function modelsOffered() {
  const opt = findOption('model', 'model');
  return opt ? flattenSelect(opt).map((o) => ({ id: String(o.value), label: o.name || String(o.value) })) : [];
}
function modeValues() {
  const opt = findOption('mode', 'mode');
  if (opt) return flattenSelect(opt).map((o) => String(o.value));
  return asArray(meta.modes?.availableModes).map((m) => m.id);
}
function currentModelValue() { const o = findOption('model', 'model'); return o ? String(o.currentValue ?? '') : ''; }
function currentModeValue() { const o = findOption('mode', 'mode'); return o ? String(o.currentValue ?? '') : (meta.modes?.currentModeId || ''); }
function configSnapshot() {
  return { configOptions: meta.configOptions, modes: meta.modes, models: modelsOffered(), modeValues: modeValues(), model: meta.model, mode: meta.agentMode };
}
function applyConfigOptions(list, source) {
  if (Array.isArray(list)) meta.configOptions = list;
  meta.model = currentModelValue() || meta.model || '';
  meta.agentMode = currentModeValue() || meta.agentMode || '';
  record('config', { ...configSnapshot(), source });
  scheduleMeta();
}
async function setConfigOption(configId, value) {
  const r = await request('session/set_config_option', { sessionId: meta.sessionId, configId, value }, 30000);
  applyConfigOptions(r?.configOptions, `set:${configId}`);
  return r;
}
async function applyModel(model, { loud = true } = {}) {
  const m = String(model || '');
  if (!m) return false;
  const opt = findOption('model', 'model');
  if (!opt) { if (loud) notice('error', `This agent offers no model selector — model "${m}" was not applied (the agent keeps its own default).`, 'unsupported'); return false; }
  try { await setConfigOption(opt.id, m); notice('info', `Model → ${meta.model || m}`, 'command_applied'); return true; }
  catch (e) { notice('error', `Model "${m}" was rejected by the agent: ${e.message}${modelsOffered().length ? ` (offered: ${modelsOffered().map((x) => x.id).slice(0, 12).join(', ')})` : ''}`, 'rejected'); return false; }
}
async function applyEffort(effort) {
  const v = String(effort || '');
  const opt = findOption('thought_level', 'effort') || findOption('thought_level', 'reasoning') || findOption('thought_level', 'thinking');
  if (!opt) { notice('error', `This agent offers no reasoning-effort option — effort "${v || '(default)'}" was not applied.`, 'unsupported'); return false; }
  if (!v) { notice('info', 'Effort unchanged (the agent keeps its current thought level; ACP has no "default" value to reset to).', 'command_applied'); return false; }
  try { await setConfigOption(opt.id, v); notice('info', `Effort → ${v}`, 'command_applied'); return true; }
  catch (e) { notice('error', `Effort "${v}" was rejected by the agent: ${e.message}`, 'rejected'); return false; }
}
async function applyMode(mode) {
  const v = String(mode || '');
  if (!v) return false;
  const opt = findOption('mode', 'mode');
  try {
    if (opt) { await setConfigOption(opt.id, v); }
    else if (asArray(meta.modes?.availableModes).some((m) => m.id === v)) {
      await request('session/set_mode', { sessionId: meta.sessionId, modeId: v }, 30000);
      meta.modes = { ...(meta.modes || {}), currentModeId: v };
      meta.agentMode = v;
      record('config', { ...configSnapshot(), source: 'set_mode' });
      scheduleMeta();
    } else {
      notice('error', `This agent offers no mode "${v}"${modeValues().length ? ` (available: ${modeValues().join(', ')})` : ' (no modes advertised)'} — mode was not applied.`, 'unsupported');
      return false;
    }
    notice('info', `Mode → ${meta.agentMode || v}`, 'command_applied');
    return true;
  } catch (e) { notice('error', `Mode "${v}" was rejected by the agent: ${e.message}`, 'rejected'); return false; }
}

// ── prompt lifecycle ──
let promptSeq = 0;
let activePrompt = null;          // {id, cancelled}
const promptQueue = [];           // [{blocks, meta}] — ACP has no queue verb; hold locally
let replaying = false;            // session/load replay window (records carry replay:true)
let nudgeTurnActive = false;
let stopEpoch = 0;                // bumped by every interrupt — see maybeStopNudge
let stopCheckAbort = null;        // the stop-check round trip currently in the air
let markReady = null, markReadyFailed = null;
const readyPromise = new Promise((resolve, reject) => { markReady = resolve; markReadyFailed = reject; });
readyPromise.catch(() => {});

async function fetchContextPrefix() {
  const api = process.env.VIBESPACE_API, token = process.env.VIBESPACE_SESSION_TOKEN;
  if (!api || !token) return '';
  try {
    const res = await fetch(api + '/api/agent/prompt-context', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return '';
    const data = await res.json();
    return data && typeof data.context === 'string' ? data.context : '';
  } catch (e) { log(`prompt-context skipped: ${e.message}`); return ''; }
}
/** The stop-time bookkeeping nudge. It is OURS, not the user's — which decides
 *  both of its edges:
 *   · A Stop that lands INSIDE the stop-check round trip must not be followed
 *     by a nudge turn. The fetch resolves after the interrupt has finished
 *     (activePrompt is already null), so the old code walked straight into
 *     runPrompt and BILLED a turn the user had just asked to stop — and the
 *     only visible trace was a reminder appearing out of nowhere. The interrupt
 *     bumps `stopEpoch` and aborts the request; the answer is discarded when
 *     the epoch it started in is gone.
 *   · When it does queue behind a running turn it queues SILENTLY: a
 *     `queued_input` for an internal reminder painted a "Queued" system card
 *     the user never sent and cannot act on (peer messages already ride
 *     silentQueue for the same reason). */
async function maybeStopNudge() {
  const api = process.env.VIBESPACE_API, token = process.env.VIBESPACE_SESSION_TOKEN;
  if (!api || !token || !meta.sessionId) return;
  const epoch = stopEpoch;
  const ac = new AbortController();
  stopCheckAbort = ac;
  const to = setTimeout(() => { try { ac.abort(new Error('stop-check timed out after 2500ms')); } catch { } }, 2500);
  try {
    const res = await fetch(api + '/api/agent/stop-check', { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal });
    if (!res.ok) return;
    const d = await res.json();
    if (!d || !d.block || !d.reason) return;
    if (epoch !== stopEpoch) { log('stop nudge dropped: Stop landed while the stop-check was in flight'); return; }
    nudgeTurnActive = true;
    log('stop nudge: one bookkeeping turn');
    await runPrompt([{ type: 'text', text: '<vibespace-reminder>' + d.reason + '</vibespace-reminder>' }], { nudge: true, silentQueue: true });
  } catch (e) {
    nudgeTurnActive = false;
    log(epoch !== stopEpoch ? 'stop nudge dropped: Stop landed while the stop-check was in flight'
      : 'stop nudge skipped: ' + (e && e.message ? e.message : e));
  } finally { clearTimeout(to); if (stopCheckAbort === ac) stopCheckAbort = null; }
}

// ── THE INPUT QUEUE (remove / reorder / edit; no steer in ACP v1) ──
// promptQueue is the queue, so the wrapper is also its PUBLISHER: the client's
// queue strip and the bubble chips read `queue_changed`, exactly as they do for
// codex — the difference between the harnesses is a capability row, never a
// different client path.
let queueSeq = 0;
function acpQueuePreview(blocks) {
  const parts = [];
  for (const b of asArray(blocks)) {
    if (b?.type === 'text' && b.text) parts.push(String(b.text));
    else if (b?.type === 'image') parts.push('[image]');
  }
  const text = String(parts.join(' ')).replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 119) + '…' : text;
}
/** The FULL text of a queued prompt (the codex wrapper's twin): the client's
 *  edit control opens THIS, never the 120-char preview — editing a truncated
 *  copy would silently delete the rest. Capped; an item with no `text` offers
 *  no edit control. */
const QUEUE_EDIT_MAX_CHARS = 20000;
function acpQueueFullText(blocks) {
  const parts = [];
  for (const b of asArray(blocks)) if (b?.type === 'text' && b.text) parts.push(String(b.text));
  return parts.join('\n');
}
function publishQueue() {
  const items = promptQueue.map((q) => ({
    id: q.id,
    msgId: q.opts?.msgId || '',
    preview: acpQueuePreview(q.blocks),
    ...(!q.opts?.peer && !q.opts?.nudge && acpQueueFullText(q.blocks) && acpQueueFullText(q.blocks).length <= QUEUE_EDIT_MAX_CHARS ? { text: acpQueueFullText(q.blocks) } : {}),
    ts: q.ts || null,
    kind: q.opts?.peer ? 'peer' : q.opts?.nudge ? 'system' : 'user',
    from: q.opts?.peerFrom || null,
  }));
  meta.queue = items;
  scheduleMeta();
  // `verbs` rides every publication — the in-band twin of the sidecar advert
  // (a remote wrapper's sidecar is not on the orchestrator's disk).
  record('queue_changed', { items, turn_id: meta.activePromptId || null, verbs: ACP_QUEUE_VERBS });
}

function drainPromptQueue() {
  if (activePrompt || !promptQueue.length) return;
  const next = promptQueue.shift();
  publishQueue();
  runPrompt(next.blocks, next.opts).catch((e) => log('queued prompt failed: ' + e.message));
}

/** queue-op stdin verb — remove / reorder / edit (ACP_QUEUE_VERBS). The queue
 *  is a LOCAL ARRAY here, so all three are splices; the ws layer and the
 *  adapter already refuse steer / run-now / run-all with their reasons, and
 *  the arm below exists so a frame that somehow reaches us is REPORTED, never
 *  silently dropped.
 *  The RELATIVE `afterId` vocabulary is the codex one verbatim (afterId null =
 *  the front) — one client control, one meaning, whatever the harness. */
function handleQueueOp(msg) {
  const op = String(msg?.op || '');
  const id = String(msg?.id || '');
  if (!ACP_QUEUE_VERBS.includes(op)) {
    record('queue_op_result', {
      op, id, ok: false,
      reason: op === 'steer' || op === 'steer-all' ? 'not-steerable' : (op === 'run-now' || op === 'run-all' ? 'not-startable' : 'unknown-op'),
      detail: op === 'steer' || op === 'steer-all'
        ? 'this agent cannot inject into a running prompt — the message runs after it'
        : (op === 'run-now' || op === 'run-all'
          ? 'this agent runs one prompt at a time — a queued message only exists while one is running, and starts as soon as it ends'
          : `this agent has no queue action "${op}"`),
    });
    return;
  }
  const idx = promptQueue.findIndex((q) => q.id === id);
  if (idx < 0) { record('queue_op_result', { op, id, ok: false, reason: 'gone', detail: 'it is no longer queued' }); publishQueue(); return; }
  if (op === 'reorder') {
    const afterId = msg?.afterId === null || msg?.afterId === undefined ? null : String(msg.afterId);
    const [moved] = promptQueue.splice(idx, 1);
    if (afterId === null) promptQueue.unshift(moved);
    else {
      const at = promptQueue.findIndex((q) => q.id === afterId);
      if (at < 0) {
        // The anchor left the queue between the drag and the drop (it ran, or
        // Stop dropped it): put the item BACK where it was and say so.
        promptQueue.splice(idx, 0, moved);
        record('queue_op_result', { op, id, ok: false, reason: 'anchor-gone', detail: 'the message it was dropped after is no longer queued', msg_id: moved.opts?.msgId || '' });
        publishQueue();
        return;
      }
      promptQueue.splice(at + 1, 0, moved);
    }
    record('queue_op_result', { op, id, ok: true, msg_id: moved.opts?.msgId || '' });
    publishQueue();
    return;
  }
  if (op === 'edit') {
    const entry = promptQueue[idx];
    // Another agent's words are not ours to rewrite (the codex rule, same
    // sentence) — and a nudge entry is the server's own bookkeeping turn.
    if (entry.opts?.peer || entry.opts?.nudge) {
      record('queue_op_result', { op, id, ok: false, reason: 'not-editable', detail: entry.opts?.peer ? 'it was sent by another agent — you can remove it, but not rewrite it' : 'it is a VibeSpace bookkeeping message, not yours to rewrite', msg_id: entry.opts?.msgId || '' });
      return;
    }
    const text = typeof msg?.text === 'string' ? msg.text : '';
    if (!text.trim()) { record('queue_op_result', { op, id, ok: false, reason: 'empty-text', detail: 'an edited message needs some text — remove it instead', msg_id: entry.opts?.msgId || '' }); return; }
    // BY EXCLUSION, exactly like the codex wrapper: the first text block takes
    // the new words, every other block (image, audio, resource_link, …) stays
    // where it is — a whitelist would delete a future ACP content type.
    const blocks = asArray(entry.blocks);
    const out = []; let replaced = false;
    for (const b of blocks) {
      if (b && b.type === 'text') { if (!replaced) { replaced = true; out.push({ type: 'text', text }); } continue; }
      out.push(b);
    }
    if (!replaced) out.unshift({ type: 'text', text });
    entry.blocks = out;
    record('queue_op_result', { op, id, ok: true, msg_id: entry.opts?.msgId || '' });
    publishQueue();
    return;
  }
  const [dropped] = promptQueue.splice(idx, 1);
  // A queued PEER message was already reported delivered — removing it must
  // hand the text back to the delivery ladder (the Stop-drop rule).
  if (dropped.opts?.peer && dropped.opts.peerText) record('peer_result', { ok: false, reason: 'removed from the queue before it was delivered', text: dropped.opts.peerText, fromName: dropped.opts.peerFrom || null });
  if (dropped.opts?.nudge) nudgeTurnActive = false;
  record('queue_op_result', { op, id, ok: true, msg_id: dropped.opts?.msgId || '' });
  publishQueue();
}

function endPrompt(mine, stopReason, error, opts) {
  record('prompt_end', { promptId: mine.id, stopReason, error: error || null });
  if (activePrompt === mine) activePrompt = null;
  meta.streaming = false; meta.activePromptId = null; scheduleMeta();
  if (nudgeTurnActive && opts.nudge) nudgeTurnActive = false;
  else if (stopReason === 'end_turn' && !opts.nudge && !nudgeTurnActive) maybeStopNudge().catch(() => {});
  drainPromptQueue();
}

async function runPrompt(blocks, opts = {}) {
  if (!meta.sessionId) throw new Error('no ACP session yet');
  if (activePrompt) {
    promptQueue.push({ id: `q${++queueSeq}-${process.pid}`, ts: Date.now(), blocks, opts });
    publishQueue();
    if (!opts.silentQueue) record('queued_input', { msg_id: opts.msgId || '', turn_id: meta.activePromptId || null });
    return;
  }
  const promptId = `p${++promptSeq}-${process.pid}`;
  const mine = { id: promptId, cancelled: false, dispatched: false };
  activePrompt = mine;
  meta.streaming = true; meta.activePromptId = promptId; scheduleMeta();
  const prompt = [...blocks];
  if (!opts.nudge && !opts.peer) {
    const ctx = await fetchContextPrefix();
    if (ctx) prompt.unshift({ type: 'text', text: '<vibespace-context>\n' + ctx + '\n</vibespace-context>' });
  }
  // The turn is CLAIMED synchronously (so a second message queues) but the
  // context prefix above is a real HTTP round trip: a Stop landing inside it
  // sees activePrompt and flips `cancelled` — dispatching afterwards put the
  // cancel BEFORE the prompt on the wire, and an agent that has not started the
  // turn ignores (or worse, LATCHES) that cancel, so Stop silently ran the whole
  // turn. Re-check after EVERY await before dispatching; a cancelled prompt ends
  // as 'cancelled' and never reaches the agent at all.
  if (mine.cancelled) { endPrompt(mine, 'cancelled', null, opts); return; }
  record('prompt_start', { promptId, blocks: prompt.length });
  let stopReason = 'end_turn', error = null;
  try {
    mine.dispatched = true;
    const r = await request('session/prompt', { sessionId: meta.sessionId, prompt }, 0);
    stopReason = r?.stopReason || 'end_turn';
  } catch (e) {
    stopReason = mine.cancelled ? 'cancelled' : 'error';
    error = { message: e.message };
  }
  endPrompt(mine, stopReason, error, opts);
}

// ── stdin verbs ──
function normalizeChatInput(rawText) {
  let text = typeof rawText === 'string' ? rawText : '';
  const images = [];
  const parsed = safeJsonParse(text);
  if (parsed?.type === 'user' && parsed.message) {
    text = '';
    for (const block of asArray(parsed.message.content)) {
      if (block.type === 'text' && block.text) text = block.text;
      if (block.type === 'image' && block.source?.data) images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data });
    }
  }
  return { text, images };
}
function promptBlocksFor({ text, images }) {
  const blocks = [];
  const imageOk = !!meta.acp.capabilities?.promptCapabilities?.image;
  for (const im of images) {
    if (imageOk) blocks.push({ type: 'image', mimeType: im.mediaType, data: im.data });
    else notice('error', 'This agent does not accept images in prompts (promptCapabilities.image is off) — the attached image was dropped; the text was sent.', 'unsupported');
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}
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
  if (err) { notice('error', `Your message did not reach the agent: its frame file could not be delivered (${err}) — please send it again.`, 'lost-input'); return null; }
  log(`frame-file ${path.basename(fp)} delivered (${body.length} bytes, type ${payload.type || '?'})`);
  return payload;
}
function rejectStdinLine(line) {
  const head = line.slice(0, 48).replace(/\s+/g, ' ');
  log(`stdin line unparseable (${line.length} bytes, starts ${JSON.stringify(head)}) — dropped`);
  notice('error', `Your message did not reach the agent: the input line was corrupted in transit (${line.length} bytes, unparseable) — please send it again.`, 'lost-input');
}

function resolvePermission(msg) {
  const key = String(msg.requestId);
  const p = pendingPermissions.get(key);
  if (!p) { notice('error', `permission-response for an unknown/expired request (${msg.requestId}) — ignored.`, 'stale'); return; }
  const options = asArray(p.params?.options);
  let outcome, opt = null;
  if (msg.abort) outcome = { outcome: 'cancelled' };
  else {
    if (msg.optionId) opt = options.find((o) => o && o.optionId === msg.optionId) || null;
    if (!opt) {
      const want = msg.approved ? (msg.alwaysAllow ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always']) : ['reject_once', 'reject_always'];
      for (const k of want) { opt = options.find((o) => o && o.kind === k); if (opt) break; }
    }
    if (!opt) opt = options.find((o) => o && (msg.approved ? /^allow/.test(o.kind || '') : /^reject/.test(o.kind || ''))) || null;
    // FAIL CLOSED on a rejection. The old last-resort `options[options.length-1]`
    // picked the LAST option for a Deny — on an agent that offers only
    // [allow_once, allow_always] that is allow_always, so pressing Deny ran the
    // tool AND stood the permission down for the rest of the session. A Deny we
    // cannot express as a reject option is answered {outcome:'cancelled'} (ACP's
    // own no-answer outcome) and SAYS so; approvals keep the positional fallback.
    if (!opt && msg.approved) opt = options[0] || null;
    if (!opt && !msg.approved) notice('info', `This agent offered no "reject" option for that permission (${options.map((o) => o?.kind || '?').join(', ') || 'no options'}) — your Deny was answered with "cancelled": the tool did not run, but the agent may end the turn instead of continuing.`, 'deny-cancelled');
    outcome = opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
  }
  reply(p.id, { outcome });
  record('permission_resolved', { requestId: p.id, outcome: outcome.outcome, optionId: outcome.optionId || null, optionKind: opt?.kind || null });
  pendingPermissions.delete(key);
  delete meta.pendingRequests[key];
  scheduleMeta();
}
function cancelPendingPermissions(reason) {
  for (const [key, p] of pendingPermissions) {
    reply(p.id, { outcome: { outcome: 'cancelled' } });
    record('permission_resolved', { requestId: p.id, outcome: 'cancelled', optionId: null, optionKind: null, reason });
    delete meta.pendingRequests[key];
  }
  pendingPermissions.clear();
  scheduleMeta();
}

async function handleInput(msg) {
  if (!msg || typeof msg !== 'object') return;
  await readyPromise;
  switch (msg.type) {
    case 'chat-input': {
      const norm = normalizeChatInput(msg.text || '');
      const content = [...norm.images.map((im) => ({ type: 'image', mediaType: im.mediaType, data: im.data })), ...(norm.text ? [{ type: 'text', text: norm.text }] : [])];
      if (!content.length) return;
      record('user', { msgId: msg.msgId || '', content, peer: null });
      const blocks = promptBlocksFor(norm);
      if (!blocks.length) return;
      // msgId rides the opts so a QUEUED entry can name the bubble it belongs
      // to (the chip join, same as codex's clientUserMessageId).
      await runPrompt(blocks, { msgId: msg.msgId || '' });
      return;
    }
    case 'interrupt': {
      // A stop-check round trip in the air belongs to the turn the user just
      // stopped: record the Stop (epoch) and abort the request, so its answer
      // is discarded instead of dispatching a billed nudge turn afterwards.
      stopEpoch++;
      if (stopCheckAbort) { try { stopCheckAbort.abort(new Error('interrupted by Stop')); } catch { } }
      // Stop means stop: ALWAYS drop what the user queued behind the running
      // turn. ACP has no queue verb so the queue is OURS — clearing it only in
      // the "nothing is running" branch meant the cancelled turn's own
      // drainPromptQueue() dispatched the queued prompt the instant Stop
      // landed, i.e. the agent kept working after Stop.
      const dropped = promptQueue.splice(0, promptQueue.length);
      // Each dropped entry gets its OWN removal result BEFORE the republish.
      // Order is load-bearing: the normalizer clears the chip of any bubble
      // that left the queue without an explicit result (= "it ran"), so a bare
      // `queue_changed: []` here would tell the user their message RAN when
      // Stop threw it away. The result stamps 'removed' first, and the empty
      // republish then leaves those bubbles alone (round-1 review).
      for (const q of dropped) record('queue_op_result', { op: 'remove', id: q.id, ok: true, msg_id: q.opts?.msgId || '', reason: 'stopped' });
      if (dropped.length) publishQueue();
      if (activePrompt) {
        activePrompt.cancelled = true;
        // Only cancel a turn the agent KNOWS about: a session/cancel for a
        // prompt we never dispatched is at best a no-op and at worst latched by
        // the agent, cancelling the NEXT turn instead (the mock agent does
        // exactly that). runPrompt drops the undispatched prompt itself.
        if (activePrompt.dispatched) {
          notify('session/cancel', { sessionId: meta.sessionId });
          log('session/cancel sent');
        } else log('interrupt before dispatch — the prompt is dropped, no session/cancel sent');
      }
      // Always: a Stop leaves no question hanging (per spec every pending
      // request_permission is answered 'cancelled'), including one left over
      // from a turn the agent abandoned.
      cancelPendingPermissions('cancelled');
      // A queued PEER message was already reported delivered (peer_result
      // ok/queued) — dropping it silently would lose a promised message, so it
      // goes back to the delivery ladder's stash (the acp-events consumer
      // re-stashes on ok:false).
      let droppedNudges = 0, droppedPeers = 0;
      for (const q of dropped) {
        if (q.opts?.peer) droppedPeers++;
        if (q.opts?.peer && q.opts.peerText) record('peer_result', { ok: false, reason: 'dropped by Stop before it was delivered', text: q.opts.peerText, fromName: q.opts.peerFrom || null });
        // A dropped NUDGE takes its latch with it. `nudgeTurnActive` is cleared
        // by endPrompt for the nudge's OWN turn — a queue entry that never runs
        // never reaches endPrompt, so leaving the flag set silently disabled
        // the stop-time bookkeeping nudge for the REST OF THE SESSION (every
        // later end_turn took the `!nudgeTurnActive` branch and skipped
        // stop-check entirely). Per-turn state dies with the turn it belongs to.
        if (q.opts?.nudge) { droppedNudges++; nudgeTurnActive = false; }
      }
      // Count only what the USER queued. The bookkeeping nudge is ours, and a
      // dropped PEER message was never the user's to re-send either — it goes
      // straight back to the delivery ladder above (peer_result ok:false) and
      // arrives on its own, so "send it again" is both impossible and wrong
      // advice. The log line below still carries the true total.
      const userDropped = dropped.length - droppedNudges - droppedPeers;
      if (userDropped) notice('info', `Stop also dropped ${userDropped} queued message${userDropped === 1 ? '' : 's'} — send ${userDropped === 1 ? 'it' : 'them'} again to run ${userDropped === 1 ? 'it' : 'them'}.`, 'queue-cleared');
      log(`interrupt: active=${!!activePrompt} dropped=${dropped.length} (nudges=${droppedNudges}, peers=${droppedPeers})`);
      return;
    }
    case 'queue-op': handleQueueOp(msg); return;
    case 'permission-response': resolvePermission(msg); return;
    case 'set-model': await applyModel(msg.model); return;
    case 'set-effort': await applyEffort(msg.effort); return;
    case 'set-mode':
    case 'set-permission-mode': await applyMode(msg.mode); return;
    case 'peer-message': {
      const text = String(msg.text || '');
      if (!text.trim()) return;
      const fromName = msg.fromName ? String(msg.fromName) : null;
      const cardText = typeof msg.cardText === 'string' && msg.cardText.trim() ? msg.cardText : null;
      // The delivery ladder types the frame ('notification' = VibeSpace itself
      // speaking, 'peer' = another session's message). On codex a BUSY
      // notification is STEERED into the running turn (turn/steer); ACP v1 has
      // NO steer method at all — `session/prompt` is one-at-a-time and there is
      // no verb to inject into a running prompt (backend-caps: opencode's
      // queueVerbs deliberately omit 'steer') — so a notification arriving mid
      // prompt QUEUES here like any other message. That is not accept-and-
      // ignore: the result SAYS the steer was unavailable, so the difference is
      // on the wire rather than only in this comment.
      const peerKind = msg.kind === 'notification' ? 'notification' : 'peer';
      const body = `Message from ${fromName || 'another session'}:\n${text}`;
      try {
        record('user', { msgId: '', content: [{ type: 'text', text }], peer: { name: fromName, body: cardText } });
        const queued = !!activePrompt;
        // peerText/peerFrom ride the queue entry so a Stop that drops it can
        // hand the message back to the delivery ladder instead of losing it.
        await runPrompt([{ type: 'text', text: body }], { peer: true, silentQueue: true, peerText: text, peerFrom: fromName });
        record('peer_result', { ok: true, mode: queued ? 'queued' : 'turn', ...(peerKind === 'notification' && queued ? { steer: 'unsupported' } : {}) });
      } catch (e) {
        record('peer_result', { ok: false, reason: e.message, text, fromName });
      }
      return;
    }
    default:
      notice('error', `Unknown stdin verb "${msg.type}" — ignored (ACP wrapper serves chat-input/interrupt/queue-op/permission-response/set-model/set-effort/set-mode/set-permission-mode/peer-message/_frame_file).`, 'unknown-verb');
  }
}

// ── agent → client traffic ──
function handleUpdate(params) {
  const update = params?.update || {};
  const kind = update.sessionUpdate;
  record('update', { sessionId: params?.sessionId || meta.sessionId, update, ...(replaying ? { replay: true } : {}) });
  if (kind === 'plan') {
    meta.todos = asArray(update.entries).map((e) => ({ content: String(e?.content || ''), status: e?.status === 'in_progress' ? 'in_progress' : e?.status === 'completed' ? 'completed' : 'pending', priority: e?.priority || null })).filter((t) => t.content);
    scheduleMeta();
  } else if (kind === 'available_commands_update') {
    meta.availableCommands = asArray(update.availableCommands).map((c) => ({ name: String(c?.name || ''), description: String(c?.description || ''), hint: c?.input?.hint || null })).filter((c) => c.name);
    scheduleMeta();
  } else if (kind === 'config_option_update') {
    applyConfigOptions(update.configOptions, 'agent');
  } else if (kind === 'current_mode_update') {
    if (update.modeId) { meta.modes = { ...(meta.modes || {}), currentModeId: update.modeId }; meta.agentMode = String(update.modeId); record('config', { ...configSnapshot(), source: 'agent_mode' }); scheduleMeta(); }
  } else if (kind === 'usage_update') {
    meta.usage = { used: update.used ?? null, size: update.size ?? null, cost: update.cost || null, at: Date.now() };
    scheduleMeta();
  } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') {
    if (!meta.streaming && activePrompt) { meta.streaming = true; scheduleMeta(); }
  }
}
function handleAgentRequest(id, method, params) {
  if (method === 'session/request_permission') {
    const key = String(id);
    pendingPermissions.set(key, { id, params: params || {} });
    meta.pendingRequests[key] = { id, method, toolCallId: params?.toolCall?.toolCallId || null, options: asArray(params?.options) };
    record('permission_request', { requestId: id, sessionId: params?.sessionId || meta.sessionId, toolCall: params?.toolCall || null, options: asArray(params?.options) });
    scheduleMeta();
    if (activePrompt?.cancelled) { cancelPendingPermissions('cancelled'); } // late request after cancel — spec: answer cancelled
    return;
  }
  // fs/*, terminal/*, elicitation/*, anything else: we advertised none of it —
  // answer with a JSON-RPC error so the agent's call FAILS CLEANLY instead of
  // hanging (never crash on an unexpected request).
  record('client_request', { requestId: id, method, replied: 'unsupported', params: clip(params, 600) });
  replyError(id, -32601, `Method not found: VibeSpace's ACP client does not support ${method} (fs/terminal capabilities were not advertised)`);
}
function handleStdoutLine(line) {
  const msg = safeJsonParse(line);
  if (!msg || typeof msg !== 'object') { log(`agent stdout non-JSON: ${clip(line, 200)}`); return; }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
  if (hasId && !msg.method) {
    const p = pendingRequests.get(msg.id);
    if (!p) { log(`reply for unknown request id ${msg.id}`); return; }
    pendingRequests.delete(msg.id);
    if (msg.error) { const e = new Error(msg.error.message || `JSON-RPC ${p.method} failed`); e.code = msg.error.code; e.data = msg.error.data; p.reject(e); }
    else p.resolve(msg.result);
    return;
  }
  if (hasId && msg.method) { handleAgentRequest(msg.id, msg.method, msg.params || {}); return; }
  if (msg.method === 'session/update') { handleUpdate(msg.params || {}); return; }
  if (msg.method) { record('notification', { method: msg.method, params: clip(msg.params, 2000) }); }
}

function finalizeExit(code) {
  shuttingDown = true;
  meta.streaming = false; meta.activePromptId = null;
  if (writeTimer) clearTimeout(writeTimer);
  if (metaTimer) clearTimeout(metaTimer);
  persistBuffer(); persistMeta();
  log(`session ended code=${code}`);
  process.exit(code ?? 0);
}

function startChild() {
  try {
    child = spawn(cmd, args, { cwd: baseCwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { log(`failed to spawn ${cmd}: ${err.message}`); notice('error', `Could not start the agent (${cmd}): ${err.message}`, 'spawn-failed'); finalizeExit(1); return; }
  meta.childPid = child.pid; scheduleMeta();
  log(`spawned ${cmd} ${args.join(' ')} pid=${child.pid}`);
  child.stdout.on('data', (chunk) => {
    lineBufB = lineBufB.length ? Buffer.concat([lineBufB, chunk]) : chunk;
    let idx;
    while ((idx = lineBufB.indexOf(10)) !== -1) {
      const line = lineBufB.subarray(0, idx).toString('utf8').trim();
      lineBufB = lineBufB.subarray(idx + 1);
      if (line) handleStdoutLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { const t = chunk.trim(); if (t) log(`[stderr] ${clip(t, 2000)}`); });
  child.on('error', (err) => { log(`child error: ${err.message}`); notice('error', `Agent process error: ${err.message}`, 'child-error'); });
  child.on('exit', (code, signal) => {
    for (const [, p] of pendingRequests) p.reject(new Error(`agent exited (${signal || code})`));
    pendingRequests.clear();
    if (!shuttingDown && activePrompt) record('prompt_end', { promptId: activePrompt.id, stopReason: 'error', error: { message: `agent exited (${signal || code})` } });
    // ANY exit before the session is ready is a boot failure — including exit 0.
    // finalizeExit() calls process.exit() synchronously, so boot()'s catch (the
    // 'boot-failed' notice) never runs from here: gating this on code !== 0 left
    // an agent that quits 0 before answering initialize (a CLI that prints usage
    // and exits, an unauthenticated agent that gives up quietly) with ZERO
    // records — a blank chat window that never says why.
    if (!shuttingDown && !markReadyDone) notice('error', `The agent exited before the session was ready (${signal ? `signal ${signal}` : `exit code ${code}`}) — no ACP session was created. Check that "${cmd}" runs in ACP mode and is logged in (see acp-wrapper.log).`, 'agent-exited');
    finalizeExit(code ?? 0);
  });
}
let markReadyDone = false;

async function setupSession() {
  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: CLIENT_INFO,
  }, 60000);
  meta.acp = {
    agentInfo: init?.agentInfo || null,
    capabilities: init?.agentCapabilities || {},
    protocolVersion: init?.protocolVersion ?? null,
    authMethods: asArray(init?.authMethods),
  };
  scheduleMeta();
  if (init?.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`agent speaks ACP protocol version ${init?.protocolVersion} — this wrapper implements v${PROTOCOL_VERSION}`);
  }
  const caps = meta.acp.capabilities;
  let how = 'new', res = null;
  const params = { cwd: baseCwd, mcpServers: [] };
  if (resumeId) {
    if (caps.loadSession) {
      replaying = true;
      try { res = await request('session/load', { ...params, sessionId: resumeId }, 600000); }
      finally { replaying = false; }
      how = 'load'; meta.sessionId = resumeId;
    } else if (caps.sessionCapabilities?.resume) {
      res = await request('session/resume', { ...params, sessionId: resumeId }, 120000);
      how = 'resume'; meta.sessionId = resumeId;
    } else {
      notice('error', `This agent cannot load session ${resumeId} (no loadSession/resume capability) — a NEW session was started; the old conversation is not in this window.`, 'no-load');
    }
  }
  if (how === 'new') {
    try { res = await request('session/new', params, 120000); }
    catch (e) {
      const auth = meta.acp.authMethods.map((m) => `${m.name || m.id}${m.description ? ` — ${m.description}` : ''}`).join('; ');
      throw new Error(`session/new failed: ${e.message}${auth ? ` (agent auth methods: ${auth})` : ''}`);
    }
    meta.sessionId = res?.sessionId || null;
    if (!meta.sessionId) throw new Error('session/new returned no sessionId');
  }
  if (res?.modes) meta.modes = res.modes;
  if (Array.isArray(res?.configOptions)) meta.configOptions = res.configOptions;
  meta.model = currentModelValue() || '';
  meta.agentMode = currentModeValue() || '';
  record('session', {
    sessionId: meta.sessionId, cwd: baseCwd, how, sessionName: sessionName || null,
    agentInfo: meta.acp.agentInfo, capabilities: meta.acp.capabilities, protocolVersion: meta.acp.protocolVersion, authMethods: meta.acp.authMethods,
    ...configSnapshot(),
  });
  scheduleMeta();
  if (initialModel) await applyModel(initialModel);
  if (initialMode) await applyMode(initialMode);
  // State the (empty) queue once, so a client attaching later starts from a
  // fact instead of from nothing — parity with the codex wrapper's baseline.
  publishQueue();
}

async function boot() {
  try { fs.mkdirSync(path.dirname(bufferFile), { recursive: true }); fs.mkdirSync(path.dirname(metaFile), { recursive: true }); } catch {}
  persistMeta();
  startChild();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  let stdinBuf = '';
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    let idx;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      const line = stdinBuf.slice(0, idx).replace(/\r/g, '').trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      // ack BEFORE parsing: "the pipe is alive", not "the line was valid"
      try { process.stdout.write(JSON.stringify({ type: '_stdin_ack', timestamp: Date.now() }) + '\n'); } catch {}
      let msg = safeJsonParse(line);
      if (!msg || typeof msg !== 'object') { rejectStdinLine(line); continue; }
      if (msg.type === '_frame_file') { msg = loadFrameFile(msg); if (!msg) continue; }
      handleInput(msg).catch((err) => { log(`stdin handler error: ${err.message}`); notice('error', err.message, 'handler-error'); });
    }
  });
  await setupSession();
  markReadyDone = true;
  markReady?.();
}

boot().catch((err) => {
  markReadyFailed?.(err);
  log(`boot failed: ${err.message}\n${err.stack || ''}`);
  notice('error', `ACP session could not start: ${err.message}`, 'boot-failed');
  try { child?.kill(); } catch {}
  finalizeExit(1);
});
