#!/usr/bin/env node
// STDOUT CONSUMER REGISTRY (harness S5, docs/design-harness-plugins.md §2.4):
// setupSessionPty no longer branches on the protocol — it resolves the harness
// descriptor's caps.streamProtocol through src/server/stdout/index.js and
// attaches ONE consumer. This suite pins (1) the registry shape + the
// descriptor↔consumer coverage, (2) LOUD failure for a chat backend whose
// protocol has no consumer (and today's text for a backend with no protocol) —
// output passes through RAW, never parsed as stream-json, (3) every consumer on
// a fake pty: one representative record per protocol reaches the session's
// REAL normalizer through feedLive, and the per-protocol side effects fire (id
// adoption → meta write, streaming flag, _stdin_ack, todos, quota/turn-end
// engine calls), plus split-chunk line buffering and non-JSON passthrough,
// (4) the wiring pins (the 2.331.0 lesson: a seam with an unstaged call site
// is dead while unit tests glow green).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; process.stderr.write('  ✗ ' + n + (e ? ' — ' + e : '') + '\n'); } }; // stderr directly: console.error is captured below
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

const { CONSUMERS, PROTOCOLS, hasConsumer, createStdoutRegistry } = require(path.join(REPO, 'src/server/stdout/index.js'));
const { BACKEND_CAPS, capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
const { HARNESSES, chatHarnessIds } = require(path.join(REPO, 'src/harnesses/index.js'));
const { createMessageManager } = require(path.join(REPO, 'src/normalizers.js'));
const { reconcileAttachStreaming, turnStateEffect } = require(path.join(REPO, 'src/turn-state.js'));

// ── 1. registry shape ──
console.log('— registry');
ok('three built-in protocols registered (stream-json / codex-events / acp-events)', PROTOCOLS.join(',') === 'stream-json,codex-events,acp-events', PROTOCOLS.join(','));
ok('every registry key agrees with its module\'s declared protocol', Object.entries(CONSUMERS).every(([k, m]) => m.protocol === k && typeof m.create === 'function'));
ok('every chat harness\'s caps.streamProtocol has a consumer (descriptor NAMES it, registry RESOLVES it)', chatHarnessIds().every((id) => hasConsumer(HARNESSES[id].caps.streamProtocol)), chatHarnessIds().map((id) => `${id}:${HARNESSES[id].caps.streamProtocol}`).join(','));
ok('no dead consumer row: every registered protocol is declared by some chat harness', PROTOCOLS.every((p) => chatHarnessIds().some((id) => HARNESSES[id].caps.streamProtocol === p)));
ok('an unregistered / empty protocol has NO consumer (never a stream-json fallback)', !hasConsumer('gemini-events') && !hasConsumer(null) && !hasConsumer(undefined) && !hasConsumer(''));
ok('the terminal-only harness declares no protocol at all', capsOf('shell').streamProtocol === null);

// ── 2. a real session-stdout engine over fake deps ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-stdout-reg-'));
const BUFFERS_DIR = path.join(tmp, 'buffers'), META_DIR = path.join(tmp, 'meta');
fs.mkdirSync(BUFFERS_DIR, { recursive: true });
const calls = { broadcasts: [], active: 0, turnEnd: [], codexQuota: [], harnessModels: [], sbSeen: [], modelSeen: [], produced: [], events: [], stashed: [] };
const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); };
const prevEvent = global.__vsEvent;
global.__vsEvent = (k, d) => calls.events.push([k, d]);
const activeSessions = new Map();
const engine = {
  _vsuPending: new Map(), armWorkflowUsageWatcher() { }, kickPoolEval() { }, markLimitBanner() { }, maybePoolAutoSwitch() { },
  maybeRepinLockedModel() { }, maybeStopOnFallback() { }, notePoolAuthFailure() { }, modelsMatch: () => false,
  noteSessionProduced(s) { calls.produced.push(s); }, noteTurnEnd(s) { calls.turnEnd.push(s); }, noteWallSignal() { },
  recordRateLimitEvent() { }, recordCodexQuotaSignal(s, p) { calls.codexQuota.push(p); }, resolveUsageKey: () => '__global__',
  usageEstimator: { noteLive() { } },
};
const so = require(path.join(REPO, 'src/server/session-stdout.js')).create({
  rootDir: tmp, BUFFERS_DIR, META_DIR, DTACH_CMD: 'dtach', USAGE_SCANNER_PATH: path.join(tmp, 'nonexistent'),
  CLAUDE_STREAM_TYPES: new Set(['system', 'assistant', 'user', 'result', '_stdin_ack', 'tool_progress', 'set_in_progress_tool_use_ids', 'compact_progress', 'tombstone']), _seenStreamTypes: new Set(), activeSessions, engine,
  checkClaudeGoalStatus() { }, broadcastToSession: (s, id, m) => calls.broadcasts.push({ id, ...m }), broadcastActiveSessions: () => { calls.active++; },
  noteModelSeen: (m) => calls.modelSeen.push(m), noteHarnessModels: (b, ms) => calls.harnessModels.push([b, ms]), recordUsageAttribution() { }, daemonPtyShim: (h) => h,
  sbSeenFirst: (s, msg) => { calls.sbSeen.push(msg.type); return true; }, getDeviceMgr: () => null, getHosts: () => null,
  getUsageHistory: () => ({ _cost: () => 0, ingestRemoteEvents() { } }), getTelemetry: () => null, getNoConvoRef: () => ({ map: new Map() }),
  getDeliver: () => ({ stashFor: (cid, e) => calls.stashed.push([cid, e]) }),
});
const fakePty = () => { const h = { data: null, exit: null, onData(cb) { h.data = cb; }, onExit(cb) { h.exit = cb; } }; return h; };
const mkSession = (backend, id, { normalizer = true } = {}) => {
  const s = { mode: 'chat', backend, name: 'n-' + id, cwd: tmp, sockName: 'cw-' + id, buffer: '', createdAt: Date.now(), backendSessionId: null, claudeSessionId: null };
  s._fed = [];
  if (normalizer) {
    s._normalizer = createMessageManager(backend, id);
    s._ops = []; s._normalizer.onOp((op) => s._ops.push(op));
    const pl = s._normalizer.processLive.bind(s._normalizer);
    s._normalizer.processLive = (m) => { s._fed.push(m); return pl(m); };
  } else {
    s._normalizer = { listeners: [], processLive: (m) => { s._fed.push(m); } };
  }
  activeSessions.set(id, s);
  return s;
};
const J = (o) => JSON.stringify(o) + '\n';
const meta = (s) => { try { return JSON.parse(fs.readFileSync(path.join(META_DIR, s.sockName + '.json'), 'utf8')); } catch { return null; } };
const labels = (id) => calls.broadcasts.filter((b) => b.id === id && b.type === 'streaming-label').map((b) => b.label);
const outputs = (id) => calls.broadcasts.filter((b) => b.id === id && b.type === 'output').map((b) => b.data);

// ── 3a. claude stream-json consumer ──
console.log('— stream-json (claude)');
{
  const s = mkSession('claude', 'w-claude'); const p = fakePty();
  so.setupSessionPty(s, 'w-claude', p);
  ok('attach wires onData + onExit on the pty', typeof p.data === 'function' && typeof p.exit === 'function');
  p.data(J({ type: 'system', subtype: 'init', session_id: 'sid-claude-1', apiKeySource: 'none', permissionMode: 'default', model: 'claude-fable-5' }));
  ok('init record → id adoption (backendSessionId + claudeSessionId) persisted to session-meta', s.backendSessionId === 'sid-claude-1' && s.claudeSessionId === 'sid-claude-1' && meta(s)?.claudeSessionId === 'sid-claude-1' && meta(s)?.webuiSessionId === 'w-claude', JSON.stringify(meta(s)));
  ok('…apiKeySource + permissionMode truth adopted from the init record', s._apiKeySource === 'none' && s._permissionMode === 'default' && meta(s)?.apiKeySource === 'none');
  ok('…and the init record reached the REAL normalizer through feedLive', s._fed.some((m) => m.type === 'system' && m.subtype === 'init'));
  const asst = { type: 'assistant', session_id: 'sid-claude-1', uuid: 'u-asst-1', message: { id: 'msg_1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'text', text: 'hello from claude' }], usage: { input_tokens: 10, output_tokens: 5 } } };
  const asstLine = J(asst);
  p.data(asstLine.slice(0, 40)); // split across two pty chunks — line buffering
  ok('a partial line is buffered (nothing parsed yet)', !s._fed.some((m) => m.type === 'assistant'));
  p.data(asstLine.slice(40));
  ok('assistant record (real shape) → REAL normalizer emitted a create op with the text', s._fed.some((m) => m.type === 'assistant') && s._ops.some((o) => o.op === 'create' && (o.message || o.msg)?.role === 'assistant' && JSON.stringify((o.message || o.msg).content).includes('hello from claude')), JSON.stringify(s._ops.filter((o) => o.op === 'create').slice(-1)));
  ok('…REGISTERED through sbSeenFirst (session-brain first-writer-wins gate) before the side-effect families', calls.sbSeen.includes('assistant'));
  ok('…served-model latch + model registry + noteSessionProduced fired (main-thread record)', s._servedModel === 'claude-fable-5' && calls.modelSeen.includes('claude-fable-5') && calls.produced.includes(s));
  ok("…streaming label 'responding' broadcast for a text-final assistant record", labels('w-claude').includes('responding'));
  p.data(J({ type: '_stdin_ack', timestamp: Date.now() }));
  ok('_stdin_ack → session._stdinAckReceived (broken-pty detector input)', s._stdinAckReceived === true);
  p.data(J({ type: 'user', session_id: 'sid-claude-1', message: { role: 'user', content: 'hi' } }));
  ok("user record → streaming ON + 'thinking...' label", s._isStreaming === true && labels('w-claude').includes('thinking...'));
  p.data(J({ type: 'result', subtype: 'success', session_id: 'sid-claude-1', duration_ms: 1 }));
  ok('result record → streaming OFF + noteTurnEnd (the turn boundary owner)', s._isStreaming === false && calls.turnEnd.includes(s));
  p.data('dtach noise, not json\n');
  ok('a non-JSON line is passed through as raw output (never swallowed)', outputs('w-claude').some((d) => /dtach noise/.test(d)));
  p.data(J({ type: 'tool_progress', tool_use_id: 'toolu_X-heartbeat-0', tool_name: 'Bash', parent_tool_use_id: 'toolu_X', elapsed_time_seconds: 30, heartbeat: true, session_id: 'sid-claude-1' }));
  ok('tool_progress rides its own channel, never the subagent path', calls.broadcasts.some((b) => b.id === 'w-claude' && b.type === 'tool-progress' && b.elapsedSeconds === 30) && !calls.broadcasts.some((b) => b.id === 'w-claude' && b.type === 'subagent-message'));
  ok('the session buffer accumulates the raw stream', s.buffer.includes('hello from claude'));
}

// ── 3a-B3. TURN TRUTH: authoritative turn state, the run set, compaction stage,
//           retraction — every record shape below is the 2.1.257 binary's own
//           zod schema, dumped, not remembered:
//   session_state_changed      c({type:I("system"),subtype:I("session_state_changed"),
//                                 state:ee(["idle","running","requires_action"]),uuid:X(),session_id:i()})
//   set_in_progress_tool_use_ids c({type:I(...),op:c({action:ee(["add","remove"]),ids:T(i())}),uuid,session_id})
//   compact_progress           c({type:I(...),event:ki("type",[c({type:I("hooks_start"),hook_type:ee(["pre_compact","post_compact","session_start"])}),
//                                 c({type:I("compact_start"),hint_text:i().nullable().optional()}),c({type:I("compact_end")})]),uuid,session_id})
//   tombstone                  c({type:I("tombstone"),message:de(),uuid:X(),session_id:i()})
console.log('— B3 turn truth (claude)');
const turnStates = (id) => calls.broadcasts.filter((b) => b.id === id && b.type === 'turn-state').map((b) => b.state);
const inflight = (id) => calls.broadcasts.filter((b) => b.id === id && b.type === 'tools-in-progress').map((b) => b.ids.join(','));
{
  // ① ENV-ABSENT DEGRADATION — the default path. No session_state_changed ever
  //    arrives (an old CLI, or a session spawned before the spawn env), so the
  //    derived result/user inference must be untouched and NOTHING may claim
  //    authority. This leg runs FIRST because it is the shape most sessions in
  //    the fleet will have for weeks.
  const s = mkSession('claude', 'w-b3-derived'); const p = fakePty();
  so.setupSessionPty(s, 'w-b3-derived', p);
  p.data(J({ type: 'user', session_id: 'sid-d', message: { role: 'user', content: 'go' } }));
  ok('env absent: a user record still starts the turn (derived path intact)', s._isStreaming === true && s._turnStateSeen === undefined && s._turnState === undefined);
  p.data(J({ type: 'result', subtype: 'success', session_id: 'sid-d', duration_ms: 1 }));
  ok('env absent: a result still ENDS the turn (no authority ⇒ no change in behaviour)', s._isStreaming === false && !turnStates('w-b3-derived').length);
  const rec0 = reconcileAttachStreaming({ turnStateSeen: false, turnState: null, isStreaming: true, sidecar: { streaming: false, ageMs: 4000 } });
  ok('env absent: attach reconciliation is exactly the 2.339.2 sidecar heal (3s settle)', rec0.action === 'sidecar-heal' && rec0.isStreaming === false && rec0.staleAuthority === false, JSON.stringify(rec0));
}
{
  const s = mkSession('claude', 'w-b3'); const p = fakePty();
  so.setupSessionPty(s, 'w-b3', p);
  // ② the FIRST authoritative record
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'u-st-1', session_id: 'sid-b3' }));
  ok("session_state_changed 'running' → streaming ON, state latched, turn-state broadcast", s._isStreaming === true && s._turnState === 'running' && s._turnStateSeen === true && turnStates('w-b3').join(',') === 'running');
  ok('…and it does NOT re-broadcast the session list: the card payload carries no turn state, so that would be a cost with no reader', calls.broadcasts.filter((b) => b.id === 'w-b3' && b.type === 'turn-state').length === 1);
  // ③ the third state
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'requires_action', uuid: 'u-st-2', session_id: 'sid-b3' }));
  ok("'requires_action' keeps the turn ALIVE (it is paused on the user, not over) and labels it", s._isStreaming === true && s._turnState === 'requires_action' && labels('w-b3').includes('waiting for you'));
  // ④ THE POINT: a result no longer ends a turn the harness says is running
  p.data(J({ type: 'result', subtype: 'success', session_id: 'sid-b3', duration_ms: 1 }));
  ok('under authority a `result` does NOT end the turn (the CLI’s idle fires later, after the bg-agent loop)', s._isStreaming === true && s._turnState === 'requires_action');
  ok('…but the turn-boundary owner still ran (noteTurnEnd is about billing/pool, not about streaming)', calls.turnEnd.includes(s));
  // ⑤ a stray user record cannot restart a turn the harness has not restarted
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u-st-3', session_id: 'sid-b3' }));
  ok("'idle' ends the turn and clears the label", s._isStreaming === false && s._streamingLabel === '');
  p.data(J({ type: 'user', session_id: 'sid-b3', message: { role: 'user', content: 'peer note' } }));
  ok('under authority a user record does NOT flip streaming back on (the derived write stood down)', s._isStreaming === false);
  ok('…and the state broadcasts are exactly the three transitions, no repeats', turnStates('w-b3').join(',') === 'running,requires_action,idle');
  // ⑥ an out-of-enum state changes NOTHING (never coerced to idle)
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'wedged', uuid: 'u-st-4', session_id: 'sid-b3' }));
  ok('an unknown state leaves the belief untouched (no coercion to idle)', s._turnState === 'idle' && turnStates('w-b3').length === 3);
  // ⑦ the tool-granular run set
  p.data(J({ type: 'set_in_progress_tool_use_ids', op: { action: 'add', ids: ['toolu_a', 'toolu_b'] }, uuid: 'u-ip-1', session_id: 'sid-b3' }));
  p.data(J({ type: 'set_in_progress_tool_use_ids', op: { action: 'remove', ids: ['toolu_a'] }, uuid: 'u-ip-2', session_id: 'sid-b3' }));
  ok('set_in_progress_tool_use_ids add/remove resolve to a SET, broadcast whole each time', inflight('w-b3').join(' | ') === 'toolu_a,toolu_b | toolu_b' && [...s._inProgressTools].join(',') === 'toolu_b', inflight('w-b3').join(' | '));
  ok('…and it is card-less: nothing about it reached the normalizer', !s._fed.some((m) => m.type === 'set_in_progress_tool_use_ids'));
  {
    const before = calls.events.length;
    p.data(J({ type: 'set_in_progress_tool_use_ids', op: { action: 'toggle', ids: ['toolu_c'] }, uuid: 'u-ip-3', session_id: 'sid-b3' }));
    ok('an unknown op action is a BREADCRUMB, not a silent guess (the set is unchanged)', calls.events.slice(before).some(([k, d]) => k === 'cli-unknown-inprogress-action' && d === 'toggle') && [...s._inProgressTools].join(',') === 'toolu_b');
  }
  // ⑧ compaction stage — three records, three labels, one broadcast each
  p.data(J({ type: 'compact_progress', event: { type: 'hooks_start', hook_type: 'pre_compact' }, uuid: 'u-cp-1', session_id: 'sid-b3' }));
  ok("compact_progress hooks_start → a REAL stage label (not the hardcoded apology)", labels('w-b3').includes('Compacting: running pre compact hooks…') && s._streamingKind === 'compacting');
  p.data(J({ type: 'compact_progress', event: { type: 'compact_start', hint_text: 'summarizing 812 messages' }, uuid: 'u-cp-2', session_id: 'sid-b3' }));
  ok('…compact_start carries the CLI’s own hint_text into the label', labels('w-b3').includes('Compacting: summarizing 812 messages'));
  p.data(J({ type: 'compact_progress', event: { type: 'compact_start' }, uuid: 'u-cp-2b', session_id: 'sid-b3' }));
  ok('…a hint-less compact_start still says what is happening (hint_text is nullable+optional in the schema)', labels('w-b3').includes('Compacting the conversation…'));
  p.data(J({ type: 'compact_progress', event: { type: 'compact_end' }, uuid: 'u-cp-3', session_id: 'sid-b3' }));
  ok('compact_end clears the compacting kind (the Stop two-step guard goes back to normal)', s._streamingKind === null);
  const cps = calls.broadcasts.filter((b) => b.id === 'w-b3' && b.type === 'compact-progress').map((b) => b.event);
  ok('every compact_progress record reaches the client (the card swaps its apology for the stage)', cps.join(',') === 'hooks_start,compact_start,compact_start,compact_end', cps.join(','));
  ok('…and it is card-less too: no compaction message was normalized', !s._ops.some((o) => o.op === 'create' && JSON.stringify(o.message?.content || '').includes('Compacting')));
}
{
  // ⑨ RETRACTION on the live stream: a tombstone for a message we rendered
  const s = mkSession('claude', 'w-b3-tomb'); const p = fakePty();
  so.setupSessionPty(s, 'w-b3-tomb', p);
  p.data(J({ type: 'assistant', session_id: 'sid-t', uuid: 'u-partial', message: { id: 'msg_partial', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'text', text: 'half a sentence' }] } }));
  const created = s._ops.find((o) => o.op === 'create' && JSON.stringify(o.message?.content || '').includes('half a sentence'));
  ok('the partial assistant message rendered first (there is something to retract)', !!created);
  p.data(J({ type: 'tombstone', message: { type: 'assistant', uuid: 'u-partial', message: { id: 'msg_partial' } }, uuid: 'u-tomb', session_id: 'sid-t' }));
  const rew = s._ops.filter((o) => o.op === 'meta' && o.subtype === 'rewound');
  ok("tombstone → ONE normalized 'rewound' meta op naming the message", rew.length === 1 && rew[0].data.ids.includes(created.message.id) && rew[0].data.toMessageId === created.message.id, JSON.stringify(rew[0]?.data));
  ok("…kind 'superseded' (the CLI replaced a partial orphan — the view removes it), harness named, numTurns null but PRESENT", rew[0].data.kind === 'superseded' && rew[0].data.harness === 'claude' && 'numTurns' in rew[0].data && rew[0].data.numTurns === null);
  ok('…and the normalizer’s own copy is marked, so a rebuild shows the same thing', s._normalizer.messages.find((m) => m.id === created.message.id)?.rewound === 'superseded');
  ok('…the message is MARKED, never spliced: total is unchanged (the virtual window’s indices are load-bearing)', s._normalizer.total === s._normalizer.messages.length && s._normalizer.messages.some((m) => m.id === created.message.id));
  {
    const before = s._ops.length;
    p.data(J({ type: 'tombstone', message: { type: 'assistant', uuid: 'u-never-seen' }, uuid: 'u-tomb-2', session_id: 'sid-t' }));
    ok('NEGATIVE CONTROL: a tombstone for a message we never rendered emits nothing (no op telling the view to strike what it does not have)', s._ops.length === before);
  }
}
{
  // ⑩ ATTACH RECONCILIATION — the PURE decision both the consumer and the ws
  //    attach path read (a twin between those two is the 2.339.2 class).
  const live = reconcileAttachStreaming({ turnStateSeen: true, turnState: 'running', isStreaming: false, sidecar: null });
  ok('attach: the harness says running while the server thinks idle ⇒ streaming is turned back ON (a direction the derived path never had)', live.action === 'authoritative' && live.isStreaming === true && live.clearLabel === false);
  const done = reconcileAttachStreaming({ turnStateSeen: true, turnState: 'idle', isStreaming: true, sidecar: null });
  ok('attach: the harness says idle ⇒ streaming off + label cleared', done.action === 'authoritative' && done.isStreaming === false && done.clearLabel === true);
  const held = reconcileAttachStreaming({ turnStateSeen: true, turnState: 'running', isStreaming: true, sidecar: { streaming: false, ageMs: 5000 } });
  ok('attach: a sidecar that disagreed 5s ago does NOT outrank the harness (that is the derived observer we replaced)', held.action === 'none' && held.isStreaming === true);
  const stale = reconcileAttachStreaming({ turnStateSeen: true, turnState: 'running', isStreaming: true, sidecar: { streaming: false, ageMs: 45000 } });
  ok('attach: after 30s of disagreement the backstop fires anyway AND says so (a lost `idle` must never wedge a session on "thinking")', stale.action === 'sidecar-heal' && stale.isStreaming === false && stale.staleAuthority === true);
  const noSidecar = reconcileAttachStreaming({ turnStateSeen: false, turnState: null, isStreaming: true, sidecar: null });
  ok('attach: an unreadable sidecar heals nothing (absence is not evidence)', noSidecar.action === 'none' && noSidecar.isStreaming === true);
  const cantStart = reconcileAttachStreaming({ turnStateSeen: false, turnState: null, isStreaming: false, sidecar: { streaming: true, ageMs: 60000 } });
  ok('attach: the sidecar can only END a turn, never start one (a stale streaming:true is not evidence THIS turn is alive)', cantStart.action === 'none' && cantStart.isStreaming === false);
  ok('turnStateEffect is the ONE reading of each state (the consumer and the reconciler share it)',
    turnStateEffect('idle').streaming === false && turnStateEffect('idle').label === ''
    && turnStateEffect('running').streaming === true && turnStateEffect('running').label === 'thinking...'
    && turnStateEffect('running', { hasLabel: true }).label === null   // a live tool label is not stomped by a bare 'running'
    && turnStateEffect('requires_action').streaming === true && turnStateEffect('requires_action').label === 'waiting for you'
    && turnStateEffect('wedged') === null);
}

// ── 3b. codex-events consumer ──
console.log('— codex-events');
{
  const s = mkSession('codex', 'w-codex'); const p = fakePty();
  so.setupSessionPty(s, 'w-codex', p);
  p.data(J({ type: 'session_meta', payload: { id: 'thr_1', cwd: tmp } }));
  ok('session_meta → thread id adoption persisted to session-meta (claudeSessionId stays null)', s.backendSessionId === 'thr_1' && s.claudeSessionId === null && meta(s)?.backendSessionId === 'thr_1' && meta(s)?.claudeSessionId === null, JSON.stringify(meta(s)));
  ok('…and the meta record reached the REAL codex normalizer through feedLive', s._fed.some((m) => m.type === 'session_meta'));
  p.data('\x1b[0m' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }) + '\x1b[0m\n');
  ok("ANSI-wrapped task_started → streaming ON + 'thinking...' (the stripper is per-attach state)", s._isStreaming === true && labels('w-codex').includes('thinking...'));
  p.data(J({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi from codex' }] } }));
  ok('assistant response_item (real shape) → REAL codex normalizer emitted a create op', s._ops.some((o) => o.op === 'create' && (o.message || o.msg)?.role === 'assistant' && JSON.stringify((o.message || o.msg).content).includes('hi from codex')), JSON.stringify(s._ops.slice(-1)));
  p.data(J({ type: '_stdin_ack', timestamp: Date.now() }));
  ok('_stdin_ack → session._stdinAckReceived', s._stdinAckReceived === true);
  p.data(J({ type: 'event_msg', payload: { type: 'rate_limits_updated', rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } } }));
  ok('rate_limits_updated → recordCodexQuotaSignal (the S4 quota entry point)', calls.codexQuota.some((pl) => pl.type === 'rate_limits_updated'));
  p.data(J({ type: 'event_msg', payload: { type: 'plan_updated', plan: [{ step: 'a', status: 'inProgress' }, { step: 'b', status: 'completed' }] } }));
  ok('plan_updated → live todos {done,total,current}', s._todos?.done === 1 && s._todos?.total === 2 && s._todos?.current === 'a', JSON.stringify(s._todos));
  p.data(J({ type: 'event_msg', payload: { type: 'task_complete' } }));
  ok('task_complete → streaming OFF + noteTurnEnd', s._isStreaming === false && calls.turnEnd.includes(s));
  p.data('garbage line\n');
  ok('a non-JSON line is passed through as raw output', outputs('w-codex').some((d) => /garbage line/.test(d)));
}

// ── 3c. acp-events consumer ──
console.log('— acp-events');
{
  const s = mkSession('opencode', 'w-acp'); const p = fakePty();
  so.setupSessionPty(s, 'w-acp', p);
  p.data(J({ ts: Date.now(), type: 'acp', kind: 'session', sessionId: 'ses_1', cwd: tmp, how: 'new', agentInfo: { name: 'mock' }, models: [{ id: 'm1', name: 'M1' }], model: 'm1' }));
  ok('session record → id adoption persisted (backendSessionId, claudeSessionId null)', s.backendSessionId === 'ses_1' && s.claudeSessionId === null && meta(s)?.backendSessionId === 'ses_1', JSON.stringify(meta(s)));
  ok('…the agent\'s offered models reach the model registry (noteHarnessModels)', calls.harnessModels.some(([b, ms]) => b === 'opencode' && ms[0]?.id === 'm1'));
  ok('…and the session record reached the REAL ACP normalizer through feedLive', s._fed.some((m) => m.type === 'acp' && m.kind === 'session'));
  p.data(J({ ts: Date.now(), type: 'acp', kind: 'prompt_start', promptId: 'p1' }));
  ok("prompt_start → streaming ON + 'thinking...'", s._isStreaming === true && labels('w-acp').includes('thinking...'));
  p.data(J({ type: '_stdin_ack', timestamp: Date.now() }));
  ok('_stdin_ack → session._stdinAckReceived', s._stdinAckReceived === true);
  p.data(J({ ts: Date.now(), type: 'acp', kind: 'update', sessionId: 'ses_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi from acp' } } }));
  ok("agent_message_chunk → 'responding' label + the chunk reached the normalizer", labels('w-acp').includes('responding') && s._fed.some((m) => m.kind === 'update'));
  p.data(J({ ts: Date.now(), type: 'acp', kind: 'update', sessionId: 'ses_1', update: { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'completed' }] } }));
  ok('plan update → live todos', s._todos?.done === 1 && s._todos?.total === 2 && s._todos?.current === 'a', JSON.stringify(s._todos));
  p.data(J({ ts: Date.now(), type: 'acp', kind: 'prompt_end', promptId: 'p1', stopReason: 'end_turn', error: null }));
  ok('prompt_end → streaming OFF + noteTurnEnd', s._isStreaming === false && calls.turnEnd.includes(s));
  p.data('not json either\n');
  ok('a non-JSON line is passed through as raw output', outputs('w-acp').some((d) => /not json either/.test(d)));
}

// ── 4. LOUD failure: declared protocol with no consumer / no protocol at all ──
console.log('— unknown protocol');
{
  const before = errors.length;
  BACKEND_CAPS.mockproto = { ...BACKEND_CAPS.opencode, streamProtocol: 'mock-events' }; // a backend whose declared protocol nobody registered
  const s = mkSession('mockproto', 'w-mock', { normalizer: false }); const p = fakePty();
  so.setupSessionPty(s, 'w-mock', p);
  const said = errors.slice(before);
  ok('a declared-but-unregistered protocol is reported LOUDLY at session start (console.error names the backend, the protocol and the fix)', said.some((e) => /mockproto/.test(e) && /mock-events/.test(e) && /registers no consumer/.test(e) && /src\/server\/stdout\/index\.js/.test(e)), said.join(' | '));
  ok('…and lands in telemetry (chat-protocol-no-consumer backend/protocol)', calls.events.some(([k, d]) => k === 'chat-protocol-no-consumer' && d === 'mockproto/mock-events'));
  p.data(J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'would be claude' }] } }));
  ok('…its output passes through RAW — never parsed as stream-json (normalizer untouched, raw output broadcast)', s._fed.length === 0 && outputs('w-mock').some((d) => /would be claude/.test(d)) && s.backendSessionId === null);
  delete BACKEND_CAPS.mockproto;
  const before2 = errors.length;
  const s2 = mkSession('shell', 'w-shell-chat', { normalizer: false }); const p2 = fakePty();
  so.setupSessionPty(s2, 'w-shell-chat', p2);
  const said2 = errors.slice(before2);
  ok("a chat backend with NO streamProtocol keeps today's console.error text + chat-backend-no-protocol event", said2.some((e) => /has no streamProtocol in src\/backend-caps\.js/.test(e)) && calls.events.some(([k, d]) => k === 'chat-backend-no-protocol' && d === 'shell'), said2.join(' | '));
  p2.data('raw shell bytes\n');
  ok('…RAW passthrough there too', outputs('w-shell-chat').some((d) => /raw shell bytes/.test(d)) && s2._fed.length === 0);
  const before3 = errors.length;
  const s3 = mkSession('claude', 'w-claude-2'); so.setupSessionPty(s3, 'w-claude-2', fakePty());
  ok('NEGATIVE CONTROL: a registered protocol attaches silently (no error, no no-consumer event)', errors.length === before3 && !calls.events.some(([k, d]) => k === 'chat-protocol-no-consumer' && /claude/.test(d)));
}

// ── 5. registry builder contract ──
console.log('— builder');
{
  const reg = createStdoutRegistry({ activeSessions, engine, CLAUDE_STREAM_TYPES: new Set(), _seenStreamTypes: new Set(), USAGE_SCANNER_PATH: '', checkClaudeGoalStatus() { }, noteModelSeen() { }, noteHarnessModels() { }, sbSeenFirst: () => true, hosts: null, usageHistory: null, deliverRef: null });
  ok('createStdoutRegistry builds every consumer once: get(known) → {protocol, attach}, get(unknown) → null', PROTOCOLS.every((p) => reg.get(p)?.protocol === p && typeof reg.get(p).attach === 'function') && reg.get('mock-events') === null && reg.has('stream-json') && !reg.has('mock-events') && reg.protocols().join(',') === PROTOCOLS.join(','));
}

// ── 6. wiring pins ──
console.log('— wiring pins');
{
  const ss = read('src/server/session-stdout.js');
  ok('session-stdout requires the registry and builds it ONCE in create() with the orchestrator deps', /require\('\.\/stdout\/index\.js'\)/.test(ss) && (ss.match(/createStdoutRegistry\(/g) || []).length === 1 && /createStdoutRegistry\(\{ activeSessions, engine, CLAUDE_STREAM_TYPES, _seenStreamTypes, USAGE_SCANNER_PATH,\s*\n\s*checkClaudeGoalStatus, noteModelSeen, noteHarnessModels, sbSeenFirst, hosts, usageHistory, deliverRef \}\)/.test(ss));
  ok('…hands its own closures (feedLive, broadcasts, meta store, todo helpers) as ONE helpers object', /const stdoutHelpers = \{ feedLive, broadcastToSession, broadcastActiveSessions, readSessionMeta, writeSessionMeta,\s*\n\s*updateSessionTodos, applyTaskToolUpdate, emitTaskListTodos \};/.test(ss));
  ok('…setupSessionPty resolves caps.streamProtocol → registry → attach (no protocol branch left in session-stdout)', /const consumer = streamProto \? stdoutConsumers\.get\(streamProto\) : null;/.test(ss) && /consumer\.attach\(session, id, ptyProcess, stdoutHelpers\);/.test(ss) && !/streamProto === '/.test(ss) && !/feedLive\(session, /.test(ss) && !/_stdin_ack/.test(ss));
  ok('…the no-protocol text is unchanged and the no-consumer case is its own loud line + event', /has no streamProtocol in src\/backend-caps\.js — chat output passes through RAW \(register a pipeline\)/.test(ss) && /registers no consumer for it — chat output passes through RAW \(register one\)/.test(ss) && /'chat-protocol-no-consumer'/.test(ss));
  ok('…still dispatches on capsOf(session.backend) (the `backend || claude` default + NO_CAPS fallback are unchanged)', /const streamProto = capsOf\(session\.backend\)\.streamProtocol;/.test(ss));
  const idx = read('src/server/stdout/index.js');
  ok('registry maps the three protocols to their modules', /'stream-json': require\('\.\/claude-stream-json\.js'\)/.test(idx) && /'codex-events': require\('\.\/codex-events\.js'\)/.test(idx) && /'acp-events': require\('\.\/acp-events\.js'\)/.test(idx));
  for (const [m, proto] of [['claude-stream-json', 'stream-json'], ['codex-events', 'codex-events'], ['acp-events', 'acp-events']]) {
    const src = read(`src/server/stdout/${m}.js`);
    ok(`${m}.js: create(deps) → { protocol: '${proto}', attach(session, id, ptyProcess, helpers) }, feeds the normalizer only through feedLive`, new RegExp(`^const protocol = '${proto}';$`, 'm').test(src) && /function attach\(session, id, ptyProcess, \{ feedLive, broadcastToSession, broadcastActiveSessions, readSessionMeta, writeSessionMeta/.test(src) && /return \{ protocol, attach \};/.test(src) && /feedLive\(session, msg\)/.test(src) && !/_normalizer\.processLive/.test(src));
  }
  ok('the claude consumer keeps the session-brain wiring EXACTLY (sbSeenFirst registration precedes the served-model latch; sbSeenFirst arrives via deps)', /sbSeenFirst\(session, msg\);\s*\n\s*if \(msg\.type === 'assistant' && !msg\.parent_tool_use_id && !msg\.isSidechain\s*\n\s*&& msg\.message\?\.model/.test(read('src/server/stdout/claude-stream-json.js')) && /checkClaudeGoalStatus, noteModelSeen, sbSeenFirst, hosts, usageHistory \}\)/.test(read('src/server/stdout/claude-stream-json.js')));
  ok('test-harness-contract pins descriptor↔consumer coverage; ci.mjs runs this suite; test-session-schema + test-attach-rebuild scan src/server/stdout/', /hasConsumer\(h\.caps\.streamProtocol\)/.test(read('scripts/test-harness-contract.mjs')) && /'test-stdout-registry'/.test(read('scripts/ci.mjs')) && /src\/server\/stdout/.test(read('scripts/test-session-schema.mjs')) && /src\/server\/stdout/.test(read('scripts/test-attach-rebuild.mjs')));
  // B3 turn truth (§2.5/§2.10/§2.11) — the seams a green unit test cannot see
  {
    const cs = read('src/server/stdout/claude-stream-json.js');
    const ad = read('src/adapters/claude-code.js');
    const mm = read('src/message-manager.js');
    const wsh = read('src/ws-handler.js');
    const srv = read('server.js');
    // FUNCTIONAL, not a regex: the record only exists if the real adapter puts
    // the env on the real spawn spec. A grep would pass on a commented-out line.
    {
      const { ClaudeCodeAdapter } = require(path.join(REPO, 'src/adapters/claude-code.js'));
      const ca = new ClaudeCodeAdapter({ claudeCmd: 'claude', chatWrapper: '/w/chat', ptyWrapper: '/w/pty', buffersDir: '/b' });
      const chat = ca.buildSessionArgs({ cwd: '/tmp', mode: 'chat', permissionMode: 'default' });
      const term = ca.buildSessionArgs({ cwd: '/tmp', mode: 'terminal' });
      ok('the spawn env that MAKES the record exist is on every claude CHAT spawn (without it the whole consumer is dead code)',
        chat.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1', JSON.stringify(chat.env));
      ok('…and NOT on a terminal spawn: the stream-json parse is its only reader, and we did not verify what the TUI sink does with an extra record',
        term.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === undefined, JSON.stringify(term.env));
      ok('…it rides the spawn env, never an allowlist: agentEnv() is a DROP table, so ws-handler needs no entry for it',
        /AGENT_ENV_DROP/.test(wsh) && !/CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS/.test(wsh) && /env\.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';/.test(ad));
    }
    ok('session_state_changed is listed as HANDLED so the unknown-subtype breadcrumb stops lying about it',
      /'session_state_changed',/.test(mm.slice(0, mm.indexOf('])'))));
    ok('the three new top-level types are in server.js CLAUDE_STREAM_TYPES (the 2.289.0 mistake: the set lagging the handler)',
      /'set_in_progress_tool_use_ids', 'compact_progress', 'tombstone'/.test(srv));
    ok('the consumer reads the PURE turn-state module, and so does the ws attach path (ONE decision, no twin)',
      /require\('\.\.\/\.\.\/turn-state\.js'\)/.test(cs) && /turnStateEffect\(st, \{ hasLabel: !!session\._streamingLabel \}\)/.test(cs)
      && /reconcileAttachStreaming \} = require\('\.\/turn-state'\)/.test(wsh) && /const rec = reconcileAttachStreaming\(\{/.test(wsh));
    ok('the derived writes are GATED on the authority latch, not deleted (an old CLI keeps every one of them)',
      /const authoritative = session\._turnStateSeen === true;/.test(cs) && /if \(!authoritative\) session\._isStreaming = false;/.test(cs) && /if \(!authoritative\) session\._isStreaming = true;/.test(cs));
    ok('the attach payload carries the tri-state turnState + the run set (null = never reported, NOT idle)',
      /turnState: session\._turnStateSeen \? \(session\._turnState \|\| null\) : null,/.test(wsh) && /inProgressTools: session\._inProgressTools \? \[\.\.\.session\._inProgressTools\] : \[\],/.test(wsh));
    const cv = read('src/lib/chat-view.js');
    const sb = read('src/lib/chat-status-bar.js');
    const cr = read('src/lib/chat-renderers.js');
    ok('the client consumes all three pushes and both payload keys',
      /msg\.type === 'turn-state'/.test(cv) && /msg\.type === 'tools-in-progress'/.test(cv) && /msg\.type === 'compact-progress'/.test(cv)
      && /if \('turnState' in meta\)/.test(cv) && /if \('inProgressTools' in meta\)/.test(cv));
    ok("the status bar draws the third state and NEVER asserts one it was not told (null ≠ idle)",
      /this\._turnState === 'requires_action'/.test(sb) && /const next = \(v === 'idle' \|\| v === 'running' \|\| v === 'requires_action'\) \? v : null;/.test(sb));
    ok('the hardcoded compaction apology is now the FALLBACK of one hint function, used by the card',
      /compactHintText\(\) \{/.test(cr) && /if \(!s\) return t\('Compacting a large conversation takes 1/.test(cr)
      && /chat-ctx-full-hint">\$\{escHtml\(this\.compactHintText\(\)\)\}/.test(cr)
      && (cr.match(/Compacting a large conversation takes 1/g) || []).length === 1);
    const ro = read('src/rewind-ops.js');
    ok("both harnesses emit the SAME 'rewound' op through the one PURE builder",
      /rewoundOp\(\{ harness: 'claude'/.test(mm) && /rewoundOp\(\{ harness: 'codex'/.test(read('src/codex-message-manager.js'))
      && /module\.exports = \{ rewoundByRecord, rewoundByTurns, applyRewound, rewoundOp, REWOUND_KINDS \};/.test(ro));
    ok("codex's thread_rolled_back is OUT of SKIPPED_EVENT_TYPES and routed (it was invisible history)",
      !/'thread_rolled_back'/.test(read('src/codex-message-manager.js').split('SKIPPED_EVENT_TYPES')[1].split('\n]')[0])
      && /if \(type === 'thread_rolled_back'\) return this\._processRolledBack\(event, emit\);/.test(read('src/codex-message-manager.js')));
    ok('both normalizers drop rewound messages from turnMap (the minimap must not point at ghosts)',
      /if \(m\.rewound\) continue;/.test(mm) && /if \(m\.rewound\) continue;/.test(read('src/codex-message-manager.js')));
    const css = read('public/chat.css');
    ok('the two retraction kinds have their OWN display rules (no global .hidden in this project)',
      /\.chat-msg-superseded \{ display: none; \}/.test(css) && /\.chat-msg-rewound \{/.test(css) && /\.chat-tool-inflight \.chat-tool-label::after/.test(css));
  }
  const arch = read('scripts/test-architecture.mjs');
  ok('test-architecture tiers src/server/stdout/ as ORCH by path (startsWith src/server/) — the consumers may use the engine; SHARED descriptors never reach up into them', /p\.startsWith\('src\/server\/'\)/.test(arch) && !/src\/server\/stdout/.test(read('src/harnesses/index.js').replace(/\/\/[^\n]*/g, '')) && !/require\(['"]\.\.\/server\//.test(read('src/harnesses/index.js')));
}

console.error = origErr;
global.__vsEvent = prevEvent;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
