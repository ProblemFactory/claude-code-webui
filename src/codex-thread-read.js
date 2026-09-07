'use strict';
// codex-thread-read.js — `thread/read` FALLBACK for a codex thread whose rollout
// file is MISSING on this machine (B-21e4 item 5; SHARED tier — node builtins
// only, never requires adapters/codex so the adapter can require THIS lazily).
//
// Since 0.153 codex keeps thread history in its own paginated store
// (`codex migrate-rollouts`, thread_history_1.sqlite): a thread can exist for
// the app-server with NO rollout-*.jsonl for us to parse. The 0.153.4 protocol
// exposes `thread/read {threadId, includeTurns}` as the read-only replay —
// verified against the generated bindings (ThreadReadParams/Response, Thread,
// Turn, ThreadItem) AND a live probe: a real local thread answered in ~140ms
// with turns + items; an unknown id → JSON-RPC error "thread not loaded".
//
//   threadToRecords(thread)        PURE: v2 Thread → rollout-shaped records the
//                                  normalizer already renders (no new render path)
//   readThreadViaAppServer(id, o)  ONE bounded `codex app-server` child:
//                                  initialize → initialized → thread/read → kill.
//                                  Not a session, no stdin of a live thread, no
//                                  network of ours (the app-server reads its store)
//   warmMissingThread(id, o)       the descriptor's store.warmTranscript hook:
//                                  no-op when the rollout exists / remote /
//                                  disabled; single-flight per id; positive LRU
//                                  (records, 10min) + negative cache (60s)
//   cachedThreadRecords(id)        sync read for parseCodexSessionJsonl's fallback
//   configure({codexCmd, enabled}) wired from server.js (the resolved CODEX_CMD)
const { spawn } = require('child_process');

const READ_TIMEOUT_MS = 15000;
const CACHE_MAX = 16;
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000;

const _cfg = { codexCmd: null, extraArgs: [], enabled: true };
const _cache = new Map();     // threadId → { records, at }
const _neg = new Map();       // threadId → at (last failure)
const _inflight = new Map();  // threadId → Promise<boolean>

function configure({ codexCmd, extraArgs, enabled } = {}) {
  if (codexCmd !== undefined) _cfg.codexCmd = codexCmd || null;
  if (Array.isArray(extraArgs)) _cfg.extraArgs = extraArgs.slice();
  if (enabled !== undefined) _cfg.enabled = !!enabled;
  return { ..._cfg };
}

// ── PURE mapper ──
const iso = (sec, fallbackMs) => new Date(Number.isFinite(sec) && sec > 0 ? sec * 1000 : fallbackMs).toISOString();
const collabName = (tool) => ({ spawnAgent: 'spawn_agent', sendInput: 'send_input', resumeAgent: 'resume_agent', wait: 'wait_agent', closeAgent: 'close_agent', sendMessage: 'send_message', followupTask: 'followup_task', interruptAgent: 'interrupt_agent', listAgents: 'list_agents' }[tool] || tool || 'tool');
const textOf = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.text ?? x.content ?? '') : String(x ?? ''))).join('');
  if (typeof v === 'object') return v.text ?? v.content ?? (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return String(v);
};
const callPair = (ts, callId, name, input, { output = '', isError = false, pending = false } = {}) => {
  const recs = [{ timestamp: ts, type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(input ?? {}), call_id: callId } }];
  if (!pending) recs.push({ timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: textOf(output), is_error: !!isError } });
  return recs;
};
const failedStatus = (s) => s === 'failed' || s === 'declined';

/** One ThreadItem (0.153.4 v2 union) → rollout-shaped records. Unknown item
 *  types map to nothing (never throw — a stray item must not lose the turn). */
function itemToRecords(item, ts) {
  if (!item || typeof item !== 'object') return [];
  const id = item.id || null;
  switch (item.type) {
    case 'userMessage': {
      const content = [];
      for (const b of Array.isArray(item.content) ? item.content : []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') content.push({ type: 'input_text', text: b.text || '' });
        else if (b.type === 'image' && b.url) content.push({ type: 'input_image', image_url: b.url });
        else if (b.type === 'localImage' && b.path) content.push({ type: 'input_text', text: `[image: ${b.path}]` });
        else if ((b.type === 'skill' || b.type === 'mention') && b.name) content.push({ type: 'input_text', text: `[${b.type}: ${b.name}]` });
      }
      return content.length ? [{ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content, item_id: id } }] : [];
    }
    case 'agentMessage':
      return item.text ? [{ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }], phase: item.phase || null, item_id: id } }] : [];
    case 'reasoning': {
      const summary = (Array.isArray(item.summary) ? item.summary : []).map((s) => ({ type: 'summary_text', text: textOf(s) })).filter((s) => s.text);
      const content = (Array.isArray(item.content) ? item.content : []).map((c) => ({ type: 'reasoning_text', text: textOf(c) })).filter((c) => c.text);
      return summary.length || content.length ? [{ timestamp: ts, type: 'response_item', payload: { type: 'reasoning', summary, content: content.length ? content : null, item_id: id } }] : [];
    }
    case 'commandExecution':
      return callPair(ts, id, 'exec_command', { command: item.command || '', cwd: item.cwd || '' }, { output: item.aggregatedOutput ?? '', isError: failedStatus(item.status) || (Number.isInteger(item.exitCode) && item.exitCode !== 0), pending: item.status === 'inProgress' });
    case 'fileChange':
      return callPair(ts, id, 'apply_patch', { changes: Array.isArray(item.changes) ? item.changes : [] }, { output: '', isError: failedStatus(item.status), pending: item.status === 'inProgress' });
    case 'mcpToolCall':
      return callPair(ts, id, `mcp__${item.server || 'mcp'}__${item.tool || 'tool'}`, item.arguments ?? {}, { output: item.error ? (item.error.message || textOf(item.error)) : textOf(item.result?.content ?? item.result ?? ''), isError: !!item.error || item.status === 'failed', pending: item.status === 'inProgress' });
    case 'dynamicToolCall':
      return callPair(ts, id, item.namespace ? `${item.namespace}.${item.tool || 'tool'}` : (item.tool || 'dynamic_tool'), item.arguments ?? {}, { output: textOf(item.contentItems ?? ''), isError: item.success === false || item.status === 'failed', pending: item.status === 'inProgress' });
    case 'collabAgentToolCall':
      return callPair(ts, id, collabName(item.tool), { prompt: item.prompt || '', model: item.model || null, receiverThreadIds: item.receiverThreadIds || [] }, { output: item.agentsStates ? JSON.stringify(item.agentsStates) : '', isError: item.status === 'failed', pending: item.status === 'inProgress' });
    case 'subAgentActivity':
      return [{ timestamp: ts, type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: id, agent_thread_id: item.agentThreadId || '', agent_path: item.agentPath || '', kind: item.kind || '' } }];
    case 'webSearch':
      return callPair(ts, id, 'web_search', { query: item.query || '', action: item.action || null }, { output: '' });
    case 'imageView':
      return callPair(ts, id, 'view_image', { path: item.path || '' }, { output: `viewed ${item.path || 'image'}` });
    // MEDIA + SLEEP (2.369.57): emitted in the ROLLOUT's own spelling, not as a
    // hand-rolled callPair — that made this the third, DIFFERENT producer of the
    // same fact (it read `item.prompt`, which the v2 ImageGeneration item does
    // not even have; the prompt is `revisedPrompt` and the file is `savedPath`).
    // One shape ⇒ one card path (_processImageGenEvent / _processSleepEvent),
    // pinned across all three producers by scripts/test-harness-honesty.mjs.
    case 'imageGeneration':
      return [{ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id, status: typeof item.status === 'string' ? item.status : '', revisedPrompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt : '', savedPath: typeof item.savedPath === 'string' ? item.savedPath : '', failure: item.failure ?? null } } }];
    case 'sleep':
      return [{ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'clock.sleep', id, durationMs: Number(item.durationMs) || 0 } } }];
    case 'plan':
      return callPair(ts, id, 'update_plan', { text: item.text || '' }, { output: '' });
    case 'functionCallOutput':
      return [{ timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: textOf(item.output), is_error: false } }];
    case 'contextCompaction':
      return [{ timestamp: ts, type: 'event_msg', payload: { type: 'context_compacted', item_id: id, source: 'thread-read' } }];
    case 'enteredReviewMode':
      return [{ timestamp: ts, type: 'event_msg', payload: { type: 'entered_review_mode', item_id: id } }];
    case 'exitedReviewMode':
      return [{ timestamp: ts, type: 'event_msg', payload: { type: 'exited_review_mode', item_id: id } }];
    default:
      return []; // hookPrompt, future kinds: not conversation content
  }
}

/** v2 Thread (with turns, as thread/read {includeTurns:true} returns it) →
 *  rollout-shaped records: session_meta, then per turn turn_context +
 *  task_started + items + the terminal event (task_complete / turn_aborted /
 *  task_failed; an inProgress turn stays open). */
function threadToRecords(thread) {
  if (!thread || typeof thread !== 'object' || !thread.id) return [];
  const recs = [];
  const baseMs = Number.isFinite(thread.createdAt) && thread.createdAt > 0 ? thread.createdAt * 1000 : Date.now();
  const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  recs.push({ timestamp: iso(thread.createdAt, baseMs), type: 'session_meta', payload: drop({
    id: thread.id, session_id: thread.sessionId || thread.id,
    forked_from_id: thread.forkedFromId || undefined, parent_thread_id: thread.parentThreadId || undefined,
    cwd: thread.cwd || '', originator: 'thread-read', cli_version: thread.cliVersion || '',
    model: thread.model || undefined, model_provider: thread.modelProvider || undefined,
    session_name: thread.name || undefined, history_mode: thread.historyMode || undefined,
    agent_nickname: thread.agentNickname || undefined, agent_role: thread.agentRole || undefined,
    thread_source: thread.threadSource || undefined, source: thread.source,
    read_via: 'thread/read',
  }) });
  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    if (!turn || typeof turn !== 'object') continue;
    const ts = iso(turn.startedAt, baseMs);
    recs.push({ timestamp: ts, type: 'turn_context', payload: drop({ turn_id: turn.id, cwd: thread.cwd || '', model: thread.model || undefined, effort: thread.reasoningEffort || undefined }) });
    recs.push({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } });
    for (const item of Array.isArray(turn.items) ? turn.items : []) for (const r of itemToRecords(item, ts)) recs.push(r);
    const end = iso(turn.completedAt, Date.parse(ts) || baseMs);
    if (turn.status === 'failed') recs.push({ timestamp: end, type: 'event_msg', payload: { type: 'task_failed', turn_id: turn.id, error: turn.error?.message || 'turn failed', codexErrorInfo: turn.error?.codexErrorInfo ?? null } });
    else if (turn.status === 'interrupted') recs.push({ timestamp: end, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn.id } });
    else if (turn.status === 'completed') recs.push({ timestamp: end, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id, last_agent_message: '' } });
  }
  return recs;
}

// ── the bounded app-server read ──
function readThreadViaAppServer(threadId, { codexCmd, extraArgs, timeoutMs = READ_TIMEOUT_MS, env } = {}) {
  const cmd = codexCmd || _cfg.codexCmd;
  return new Promise((resolve, reject) => {
    if (!threadId) return reject(new Error('threadId required'));
    if (!cmd) return reject(new Error('codex command not configured'));
    let child, settled = false, buf = '', nextId = 1;
    const pending = new Map();
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill('SIGTERM'); } catch { }
      setTimeout(() => { try { child?.kill('SIGKILL'); } catch { } }, 2000).unref?.();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`thread/read timed out after ${timeoutMs}ms`)), timeoutMs);
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); } catch (e) { pending.delete(id); rej(e); }
    });
    try {
      child = spawn(cmd, ['app-server', ...(Array.isArray(extraArgs) ? extraArgs : _cfg.extraArgs)], { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
    } catch (e) { return finish(e); }
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`app-server exited (${code}) before thread/read answered`)));
    child.stderr.on('data', () => { });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m && m.id !== undefined && !m.method && pending.has(m.id)) {
          const p = pending.get(m.id); pending.delete(m.id);
          if (m.error) p.rej(new Error(m.error.message || `JSON-RPC ${m.id} failed`)); else p.res(m.result);
        }
      }
    });
    (async () => {
      await request('initialize', { clientInfo: { name: 'claude-code-webui', title: 'VibeSpace thread-read', version: '2.0.0' }, capabilities: { experimentalApi: true } });
      try { child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); } catch { }
      const r = await request('thread/read', { threadId, includeTurns: true });
      if (!r || !r.thread || !r.thread.id) throw new Error('thread/read returned no thread');
      finish(null, r.thread);
    })().catch((e) => finish(e));
  });
}

// ── the store.warmTranscript hook ──
function _prune() {
  if (_cache.size <= CACHE_MAX) return;
  const aged = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [id] of aged.slice(0, _cache.size - CACHE_MAX)) _cache.delete(id);
}
/** Returns true when records for the thread are cached (now or already), false
 *  when nothing could be read (rollout present → not needed; remote; disabled;
 *  the app-server failed — negative-cached for NEG_TTL_MS). Never throws. */
function warmMissingThread(threadId, { locate, remote = false, codexCmd, timeoutMs } = {}) {
  if (!threadId || remote || !_cfg.enabled || !(codexCmd || _cfg.codexCmd)) return Promise.resolve(false);
  try { if (typeof locate === 'function' && locate(threadId)) return Promise.resolve(false); } catch { }
  const hit = _cache.get(threadId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(true);
  const neg = _neg.get(threadId);
  if (neg && Date.now() - neg < NEG_TTL_MS) return Promise.resolve(false);
  if (_inflight.has(threadId)) return _inflight.get(threadId);
  const p = (async () => {
    try {
      const thread = await readThreadViaAppServer(threadId, { codexCmd, timeoutMs });
      const records = threadToRecords(thread);
      if (!records.length) throw new Error('thread/read yielded no records');
      _cache.set(threadId, { records, at: Date.now() });
      _neg.delete(threadId);
      _prune();
      return true;
    } catch (e) {
      _neg.set(threadId, Date.now());
      if (_neg.size > 256) _neg.delete(_neg.keys().next().value);
      console.warn(`[codex-thread-read] ${String(threadId).slice(0, 13)}… fallback failed: ${e.message}`);
      return false;
    } finally { _inflight.delete(threadId); }
  })();
  _inflight.set(threadId, p);
  return p;
}
function cachedThreadRecords(threadId) {
  const hit = _cache.get(threadId);
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_TTL_MS) { _cache.delete(threadId); return null; }
  return hit.records;
}
function _resetForTests() { _cache.clear(); _neg.clear(); _inflight.clear(); }

module.exports = { configure, threadToRecords, itemToRecords, readThreadViaAppServer, warmMissingThread, cachedThreadRecords, _resetForTests, READ_TIMEOUT_MS, CACHE_MAX, NEG_TTL_MS };
