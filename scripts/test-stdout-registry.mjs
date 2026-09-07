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
// the PURE client rules the init frame feeds (composer completion + health strip)
const { slashCompletionList, initHealthIssues } = await import(path.join(REPO, 'src/lib/agent-meta.js'));

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
  // ③ the third state. It keeps the turn alive and it does NOT touch the
  //    spinner line — the chip is that state's one voice (round 8; see the
  //    dedicated leg ⑨ below for why a spinner line here can never be retracted).
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'requires_action', uuid: 'u-st-2', session_id: 'sid-b3' }));
  ok("'requires_action' keeps the turn ALIVE (it is paused on the user, not over) and writes NO spinner line — the chip is that state's one voice",
    s._isStreaming === true && s._turnState === 'requires_action' && s._streamingLabel === 'thinking...' && !labels('w-b3').includes('waiting for you'), `label=${JSON.stringify(s._streamingLabel)} labels=${JSON.stringify(labels('w-b3'))}`);
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
  // ── ⑨ THE PERMISSION PAUSE, END TO END (round 8) ─────────────────────────
  //    The exact wire sequence a permission prompt produces, MEASURED on
  //    claude 2.1.257 in the wrapper's spawn shape (--output-format stream-json
  //    --input-format stream-json --verbose --permission-prompt-tool stdio,
  //    piped, + --permission-mode default):
  //
  //      2344ms  assistant  tool_use:Write
  //      3073ms  system/session_state_changed  state=requires_action
  //      3073ms  control_request can_use_tool
  //      9079ms  ANSWERED allow
  //      9080ms  system/session_state_changed  state=running
  //      9086ms  user  tool_result
  //
  //    Note what the `running` record does NOT carry: which tool is executing.
  //    So a spinner line that is only true DURING the pause can never be
  //    RETRACTED from the wire — the round-7 shape wrote 'waiting for you'
  //    onto the line at `requires_action`, and then `running` (whose whole job
  //    is "leave the derived label alone") faithfully preserved it for the
  //    entire tool run, while the status-bar chip had already flipped back to
  //    'running'. Two surfaces, one fact, opposite answers — and the label was
  //    wrong for as long as the tool ran (minutes, for a Bash).
  //    The turn state's voice is the CHIP (kb-features §Turn truth: "`idle` and
  //    `running` draw nothing … one fact must not have two voices"); the
  //    spinner line belongs to the records that name what is happening.
  const s = mkSession('claude', 'w-b3-perm'); const p = fakePty();
  so.setupSessionPty(s, 'w-b3-perm', p);
  const L = () => labels('w-b3-perm');
  const T = () => turnStates('w-b3-perm');
  // the two surfaces, sampled at the same instant, all the way through
  const film = [];
  const shot = (at) => film.push({ at, label: s._streamingLabel ?? null, chip: T()[T().length - 1] ?? null });
  p.data(J({ type: 'user', session_id: 'sid-p', message: { role: 'user', content: 'write a file' } }));
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'p1', session_id: 'sid-p' }));
  shot('turn-start');
  p.data(J({ type: 'assistant', session_id: 'sid-p', uuid: 'p2', message: { id: 'm1', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} }] } }));
  shot('tool_use');
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'requires_action', uuid: 'p3', session_id: 'sid-p' }));
  shot('parked');
  p.data(J({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'p4', session_id: 'sid-p' }));
  shot('answered');
  // the tool now RUNS. tool_progress heartbeats are the only records a long
  // tool emits (real shape, captured from a `Bash sleep 6` turn) — none of
  // them touches the label, which is exactly why a stale one survives.
  for (let i = 1; i <= 6; i++) p.data(J({ type: 'tool_progress', tool_use_id: 'toolu_1-h' + i, tool_name: 'Write', parent_tool_use_id: 'toolu_1', elapsed_time_seconds: i * 30, heartbeat: true, session_id: 'sid-p' }));
  shot('3min-later');
  p.data(J({ type: 'user', session_id: 'sid-p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }));
  shot('tool_result');
  const at = (k) => film.find((f) => f.at === k) || {};
  ok("the parked turn keeps the DERIVED line ('running Write') — the tool card is still what is happening; the chip carries 'waiting for you'",
    at('parked').label === 'running Write' && at('parked').chip === 'requires_action', JSON.stringify(at('parked')));
  ok('THE DEFECT: once the permission is answered the line must not still say "waiting for you" — nothing on the wire could ever retract it',
    at('answered').label !== 'waiting for you' && at('answered').chip === 'running', JSON.stringify(at('answered')));
  ok("…and it is the accurate line that survives the pause, not a generic one ('running Write', for the whole tool run)",
    at('answered').label === 'running Write' && at('3min-later').label === 'running Write', JSON.stringify([at('answered'), at('3min-later')]));
  // THE CONSEQUENCE, stated as the invariant rather than as one sample: at no
  // point may the spinner line claim the turn is parked while the chip says it
  // is running. This is the assert that fails on the round-7 shape for four of
  // the six frames, not just one.
  const contradictions = film.filter((f) => f.label === 'waiting for you' && f.chip !== 'requires_action');
  ok('the two surfaces never contradict each other across the whole sequence (one fact, one voice)',
    contradictions.length === 0, JSON.stringify(film));
  ok('…and the spinner never carried that line at all — the chip is the only place that state is said',
    !L().includes('waiting for you'), JSON.stringify(L()));
  ok('the tool_result closes the tool and the line goes back to the generic one', at('tool_result').label === 'thinking...', JSON.stringify(at('tool_result')));
  ok('the chip itself is unchanged by this fix: exactly the three transitions the harness reported', T().join(',') === 'running,requires_action,running', T().join(','));
  // NEGATIVE CONTROL 1 — the fix must not turn the 'running' branch into a
  // no-op: onto an EMPTY line a bare 'running' still says something.
  const s2 = mkSession('claude', 'w-b3-perm2'); const p2 = fakePty();
  so.setupSessionPty(s2, 'w-b3-perm2', p2);
  p2.data(J({ type: 'system', subtype: 'session_state_changed', state: 'requires_action', uuid: 'q1', session_id: 'sid-q' }));
  const parkedFromCold = s2._streamingLabel;
  p2.data(J({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'q2', session_id: 'sid-q' }));
  ok("NEGATIVE CONTROL: a bare 'running' onto an EMPTY line still writes 'thinking...' (the branch is gated, not deleted)",
    s2._streamingLabel === 'thinking...' && labels('w-b3-perm2').includes('thinking...'), `parkedFromCold=${JSON.stringify(parkedFromCold)} then=${JSON.stringify(s2._streamingLabel)}`);
  // NEGATIVE CONTROL 2 — turn state may still CLEAR the line. 'idle' is the one
  // label write that is a retirement, and it must survive the fix.
  p2.data(J({ type: 'assistant', session_id: 'sid-q', uuid: 'q3', message: { id: 'm2', model: 'claude-fable-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }] } }));
  const beforeIdle = s2._streamingLabel;
  p2.data(J({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'q4', session_id: 'sid-q' }));
  ok("NEGATIVE CONTROL: 'idle' still CLEARS the line (the one label write that is a retirement is untouched)",
    beforeIdle === 'running Bash' && s2._streamingLabel === '' && s2._isStreaming === false, `beforeIdle=${JSON.stringify(beforeIdle)} after=${JSON.stringify(s2._streamingLabel)}`);
}
{
  // ⓑ SHAPE PARITY INSIDE A LANE THAT NEVER REACHES US. Round 4 corrected the
  //    header this leg used to carry ("the spelling that is actually on the
  //    wire"): `compact_progress` is not on OUR wire in ANY spelling — the host
  //    callback `onCompactEvent` consumes it (`case"compact_progress":
  //    P.main.applyCompactProgress(x.event);return`, 201341255) and only its
  //    `sdk_status` twin is forwarded to us, as `system/status` (leg ⓓ, the one
  //    §2.11 actually runs on). What these legs still pin is REAL and worth
  //    keeping: IF a CLI ever forwards the record, the reader must survive the
  //    two spellings — because inside the CLI the emitters and the schema
  //    already disagree. Every producer builds camelCase, and `onCompactEvent:
  //    (k)=>r.enqueue(k)` (182861070) would forward the object VERBATIM:
  //      183979983  {type:"compact_progress",event:{type:"hooks_start",hookType:"pre_compact"}}
  //      183980713  {type:"compact_start",hintText:F}
  //      185190125 / 185193937 / 185195701 / 185198872 / 185209427 / 192261073
  //      189086200  the CLI's OWN consumer: t.hookType==="pre_compact" / t.hintText??null
  //    `grep -aob 'hint_text:'` over the binary finds exactly ONE hit — the
  //    schema literal. Both spellings, ONE read point.
  const s2 = mkSession('claude', 'w-b3-cc'); const p2 = fakePty();
  so.setupSessionPty(s2, 'w-b3-cc', p2);
  const ccB = () => calls.broadcasts.filter((b) => b.id === 'w-b3-cc' && b.type === 'compact-progress');
  const ccL = () => labels('w-b3-cc').slice(-1)[0];
  p2.data(J({ type: 'compact_progress', event: { type: 'hooks_start', hookType: 'pre_compact' }, uuid: 'u-cc-1', session_id: 'sid-cc' }));
  ok("EMITTED shape: camelCase hookType names the hook phase in the label (not the generic 'hook')", ccL() === 'Compacting: running pre compact hooks\u2026', ccL());
  ok('…and it reaches the client broadcast, which is what the card reads', ccB().slice(-1)[0]?.hookType === 'pre_compact', JSON.stringify(ccB().slice(-1)[0]));
  p2.data(J({ type: 'compact_progress', event: { type: 'compact_start', hintText: 'summarizing 812 messages' }, uuid: 'u-cc-2', session_id: 'sid-cc' }));
  ok("EMITTED shape: camelCase hintText carries the CLI's own hint into the label", ccL() === 'Compacting: summarizing 812 messages', ccL());
  ok('…and into the broadcast (§2.11 exists to show exactly this string)', ccB().slice(-1)[0]?.hint === 'summarizing 812 messages', JSON.stringify(ccB().slice(-1)[0]));
  p2.data(J({ type: 'compact_progress', event: { type: 'compact_start', hint_text: 'schema wins', hintText: 'emitter loses' }, uuid: 'u-cc-3', session_id: 'sid-cc' }));
  ok('both spellings present ⇒ the DECLARED one wins (the schema is the contract; camelCase is the compatibility rung)', ccL() === 'Compacting: schema wins', ccL());
  // NEGATIVE CONTROLS — an absent value is still absent under the wider read
  p2.data(J({ type: 'compact_progress', event: { type: 'compact_start' }, uuid: 'u-cc-4', session_id: 'sid-cc' }));
  ok('NEGATIVE CONTROL: no hint in either spelling ⇒ the generic sentence and hint:null (nothing is invented)', ccL() === 'Compacting the conversation\u2026' && ccB().slice(-1)[0]?.hint === null, JSON.stringify([ccL(), ccB().slice(-1)[0]?.hint]));
  p2.data(J({ type: 'compact_progress', event: { type: 'hooks_start' }, uuid: 'u-cc-5', session_id: 'sid-cc' }));
  ok('NEGATIVE CONTROL: a hooks_start with no hook name falls back to the generic word, it never guesses a phase', ccL() === 'Compacting: running hook hooks\u2026' && ccB().slice(-1)[0]?.hookType === null, ccL());
  // DRIFT GUARD (the 2.331.0 lesson): the fix is ONE `??` pair at ONE read
  // point — a later "clean-up to the documented schema" silently restores the
  // production bug, and only the camelCase legs above would catch it.
  const csj = read('src/server/stdout/claude-stream-json.js');
  ok('the read point still accepts BOTH spellings (drift guard)', /ev\.hook_type \?\? ev\.hookType/.test(csj) && /ev\.hint_text \?\? ev\.hintText/.test(csj), 'claude-stream-json.js stopped reading both compact_progress spellings');
  const strays = csj.replace(/ev\.hook_type \?\? ev\.hookType/g, '').replace(/ev\.hint_text \?\? ev\.hintText/g, '');
  ok('…and nothing downstream re-reads the raw event (one read, one normalized broadcast)', !/ev\.hook_type|ev\.hint_text|ev\.hookType|ev\.hintText/.test(strays));
}
{
  // ⓒ THE FIXTURE vs THE BINARY (facts law: dump, never remember). The legs
  //    above are hand-written record shapes, and a hand-written fixture is
  //    exactly how the snake_case bug stayed green for a release. When a claude
  //    CLI is installed, ASK IT which spelling it emits; when it is not,
  //    SKIP LOUDLY with the reason (an environment-capability assert must carry
  //    evidence, never quietly pass).
  let bin = null;
  try { bin = fs.realpathSync(require('child_process').execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()); } catch { }
  if (!bin || !fs.existsSync(bin)) {
    console.log('  SKIP: no claude CLI on PATH — the emitted-vs-declared spelling was not re-dumped (the fixtures above still run)');
  } else {
    const hits = (needle) => { try { return Number(require('child_process').execFileSync('grep', ['-c', '-a', '-F', needle, bin], { encoding: 'utf8' }).trim()) || 0; } catch { return 0; } };
    const camelHooks = hits('type:"hooks_start",hookType:');
    const camelHint = hits('type:"compact_start",hintText:');
    const snakeHooksEmit = hits('type:"hooks_start",hook_type:');
    const snakeHintEmit = hits('type:"compact_start",hint_text:');
    const schemaDecl = hits('hook_type:ee(["pre_compact"');
    const ver = (() => { try { return require('child_process').execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(); } catch { return '?'; } })();
    ok(`${ver}: the installed CLI EMITS camelCase compact_progress (hookType ${camelHooks} sites, hintText ${camelHint} sites) — the compatibility rung is load-bearing, not defensive`, camelHooks > 0 && camelHint > 0, `hookType=${camelHooks} hintText=${camelHint}`);
    ok('…and it DECLARES snake_case in the same binary (both rungs are justified; the schema is not fiction)', schemaDecl > 0, `hook_type:ee([...]) sites=${schemaDecl}`);
    ok('…and no emitter uses the declared spelling yet — the day one does, the schema-first read still wins (leg ⓑ pins that)', snakeHooksEmit === 0 && snakeHintEmit === 0, `snake emitters hooks=${snakeHooksEmit} hint=${snakeHintEmit}`);
  }
}
{
  // ⓓ THE COMPACTION LANE THAT IS ACTUALLY ON OUR WIRE (§2.11, round 4).
  //    Records copied VERBATIM out of a production buffer — a REAL AUTO
  //    compaction (data/session-buffers/sess-5-1788332329337.buf lines 57-62,
  //    pre_tokens 997587 → post_tokens 11159, duration_ms 174751):
  //      system/status {status:"compacting"}
  //      system/hook_started SessionStart:compact  → hook_response
  //      system/status {status:null, compact_result:"success"}
  //      system/compact_boundary {compact_metadata:{trigger:"auto",…}}
  //    Zero `compact_progress` records appeared in that file, or in any of the
  //    24 buffers on this machine (212 tool_use blocks between them). AUTO is
  //    the case ws-handler's /compact send-site label structurally cannot see.
  const s3 = mkSession('claude', 'w-b3-st'); const p3 = fakePty();
  so.setupSessionPty(s3, 'w-b3-st', p3);
  const stB = () => calls.broadcasts.filter((b) => b.id === 'w-b3-st' && b.type === 'compact-progress');
  const stL = () => labels('w-b3-st').slice(-1)[0];
  p3.data(J({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'sid-st', uuid: 'u-st-a' }));
  ok("system/status 'compacting' → the compacting KIND (the Stop two-step guard) + a real label", s3._streamingKind === 'compacting' && stL() === 'Compacting the conversation…', `${s3._streamingKind} / ${stL()}`);
  ok('…and a compact_start frame reaches the card (ONE frame shape, whichever lane produced it)', stB().slice(-1)[0]?.event === 'compact_start' && stB().slice(-1)[0]?.result === null, JSON.stringify(stB().slice(-1)[0]));
  p3.data(J({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:compact', hook_event: 'SessionStart', session_id: 'sid-st', uuid: 'u-st-b' }));
  ok('the hooks phase INSIDE a compaction names itself (the one intermediate stage this lane really has)', stL() === 'Compacting: running SessionStart:compact hooks…' && stB().slice(-1)[0]?.event === 'hooks_start', stL());
  p3.data(J({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: 'sid-st', uuid: 'u-st-c' }));
  ok('status:null + compact_result ENDS the compaction (kind cleared, turn continues) and reports the OUTCOME', s3._streamingKind === null && stL() === 'thinking...' && stB().slice(-1)[0]?.event === 'compact_end' && stB().slice(-1)[0]?.result === 'success', JSON.stringify([s3._streamingKind, stL(), stB().slice(-1)[0]]));
  {
    const before = stB().length;
    p3.data(J({ type: 'system', subtype: 'compact_boundary', uuid: 'u-st-d', session_id: 'sid-st', compact_metadata: { trigger: 'auto', pre_tokens: 997587, post_tokens: 11159, duration_ms: 174751 } }));
    ok('NEGATIVE CONTROL: the compact_boundary that FOLLOWS it (real order, line 62) adds no second compact_end frame', stB().length === before, `${before} → ${stB().length}`);
  }
  // NEGATIVE CONTROLS — the same subtype carries the CLI's permission-mode echo
  // (`_r(p,P)` = {status:null, permissionMode, …}, offset 199038328). One of
  // those must never be read as "the compaction finished", and one arriving
  // outside a compaction must not invent a stage at all.
  {
    const before = stB().length, lbefore = labels('w-b3-st').length;
    p3.data(J({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', session_id: 'sid-st', uuid: 'u-st-e' }));
    ok('NEGATIVE CONTROL: a permission-mode echo (status:null, no outcome) outside a compaction changes NOTHING', stB().length === before && labels('w-b3-st').length === lbefore && s3._streamingKind === null);
  }
  {
    p3.data(J({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'sid-st', uuid: 'u-st-f' }));
    const before = stB().length, kindBefore = s3._streamingKind;
    p3.data(J({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', session_id: 'sid-st', uuid: 'u-st-g' }));
    // Stated as "the echo changed nothing", not as "we are compacting" — a
    // negative control must stay green when the FEATURE is neutered, or it is
    // measuring the feature instead of the failure mode.
    ok('NEGATIVE CONTROL: a permission-mode echo DURING a compaction does not end it (the outcome field, or its absence, is what makes the record ours)', s3._streamingKind === kindBefore && stB().length === before, `${kindBefore}→${s3._streamingKind} ${before}→${stB().length}`);
    p3.data(J({ type: 'system', subtype: 'status', status: null, compact_error: 'ran out of context', session_id: 'sid-st', uuid: 'u-st-h' }));
    ok('a compact_error ends it and SAYS the failure (silently reverting to the 1-2-minute apology would be a lie)', s3._streamingKind === null && stB().slice(-1)[0]?.event === 'compact_end' && stB().slice(-1)[0]?.error === 'ran out of context' && stB().slice(-1)[0]?.result === 'error', JSON.stringify(stB().slice(-1)[0]));
  }
  {
    // hook_started is the CLI's most common system record (13 of 24 production
    // buffers) — outside a compaction this branch must be invisible.
    const s4 = mkSession('claude', 'w-b3-hook'); const p4 = fakePty();
    so.setupSessionPty(s4, 'w-b3-hook', p4);
    p4.data(J({ type: 'system', subtype: 'hook_started', hook_id: 'h9', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', session_id: 'sid-h', uuid: 'u-h-1' }));
    ok('NEGATIVE CONTROL: hook_started in a NORMAL turn produces no compaction stage and no label', !calls.broadcasts.some((b) => b.id === 'w-b3-hook' && b.type === 'compact-progress') && !labels('w-b3-hook').length && !s4._streamingKind);
  }
  {
    // ⓓ' A COMPACTION THAT ENDS WITHOUT AN OUTCOME RECORD (round 6).
    //    `_streamingKind === 'compacting'` is a claim about RIGHT NOW, and the
    //    client mirrors it as a held `_compactStage` whose `compactInFlight()`
    //    gates the ENTIRE "Prompt is too long" guidance card. Only the
    //    `status:null` outcome record retired that claim out loud; the other two
    //    exits cleared it SILENTLY, so a compaction that produced no outcome
    //    record left the client saying "Compacting: running <hook> hooks…"
    //    forever and every later card lost its rewind-and-retry sentence.
    //    REPRODUCED on this engine: frames ["hooks_start"], _streamingKind null,
    //    no compact_end. Both exits are real: a PreCompact hook that BLOCKS the
    //    compaction makes the CLI emit a bare `sdk_status status:null` with no
    //    metadata (which this branch correctly refuses to read as an outcome),
    //    and ws-handler sets the kind on a `/compact` SEND, before the CLI has
    //    said anything at all.
    const s5 = mkSession('claude', 'w-b3-unterm'); const p5 = fakePty();
    so.setupSessionPty(s5, 'w-b3-unterm', p5);
    const uB = () => calls.broadcasts.filter((b) => b.id === 'w-b3-unterm' && b.type === 'compact-progress');
    s5._streamingLabel = 'Compacting context…'; s5._streamingKind = 'compacting'; // ws-handler.js's /compact send site
    p5.data(J({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'UserPromptSubmit:vibespace', session_id: 'sid-un', uuid: 'u-un-1' }));
    ok('a hook_started inside the send-site compaction still names the stage (unchanged)', uB().slice(-1)[0]?.event === 'hooks_start', JSON.stringify(uB().map((b) => b.event)));
    p5.data(J({ type: 'result', subtype: 'success', session_id: 'sid-un', duration_ms: 1 }));
    ok('THE TURN ENDING retires the compaction OUT LOUD — the client can never be left holding "running hooks…" for a compaction the server already retired',
      s5._streamingKind === null && uB().slice(-1)[0]?.event === 'compact_end', JSON.stringify([s5._streamingKind, uB().map((b) => b.event)]));
    ok('…and it says ENDED, not SUCCEEDED (result:null) — nothing told us it worked (round 5\'s law, on the new exit)',
      uB().slice(-1)[0]?.result === null && uB().slice(-1)[0]?.error === null, JSON.stringify(uB().slice(-1)[0]));
    {
      const before = uB().length;
      p5.data(J({ type: 'result', subtype: 'success', session_id: 'sid-un', duration_ms: 1 }));
      ok('NEGATIVE CONTROL: a SECOND turn end with no compaction in flight broadcasts nothing (the frame reports a retirement, it is not a turn heartbeat)', uB().length === before, `${before} → ${uB().length}`);
    }
    // The CLI's OWN turn state is the other silent exit — a session whose
    // harness publishes session_state_changed never reaches the `result` branch
    // above for its streaming flag, and cleared the kind there instead.
    const s6 = mkSession('claude', 'w-b3-unterm2'); const p6 = fakePty();
    so.setupSessionPty(s6, 'w-b3-unterm2', p6);
    const u2B = () => calls.broadcasts.filter((b) => b.id === 'w-b3-unterm2' && b.type === 'compact-progress');
    s6._streamingKind = 'compacting';
    p6.data(J({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sid-un2', uuid: 'u-un2-1' }));
    ok("…and so does the harness's OWN idle turn state (the authoritative exit, §2.5) — both silent clears now speak",
      s6._streamingKind === null && u2B().slice(-1)[0]?.event === 'compact_end' && u2B().slice(-1)[0]?.result === null, JSON.stringify([s6._streamingKind, u2B().map((b) => b.event)]));
    {
      const s7 = mkSession('claude', 'w-b3-unterm3'); const p7 = fakePty();
      so.setupSessionPty(s7, 'w-b3-unterm3', p7);
      p7.data(J({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: 'sid-un3', uuid: 'u-un3-1' }));
      p7.data(J({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sid-un3', uuid: 'u-un3-2' }));
      ok('NEGATIVE CONTROL: an ordinary turn (no compaction) ends with NO compact-progress frame at either exit',
        !calls.broadcasts.some((b) => b.id === 'w-b3-unterm3' && b.type === 'compact-progress'));
    }
    // ── THE EXIT WITH NO RECORD AT ALL: the wrapper dies (round 7) ─────────
    //    `result` and the idle turn state are the exits the consumer can SEE.
    //    Teardown is the one it cannot: the process is gone, nothing will ever
    //    arrive, and before this the server left `_streamingKind` set — every
    //    attached client kept "Compacting: running <hook> hooks…" for a
    //    compaction whose producer no longer exists. Driven on the REAL engine
    //    through the real onExit path.
    {
      const s8 = mkSession('claude', 'w-b3-death'); const p8 = fakePty();
      so.setupSessionPty(s8, 'w-b3-death', p8);
      const dB = () => calls.broadcasts.filter((b) => b.id === 'w-b3-death' && b.type === 'compact-progress');
      s8._streamingKind = 'compacting';
      p8.data(J({ type: 'system', subtype: 'hook_started', hook_id: 'h9', hook_name: 'PreCompact:guard', session_id: 'sid-death', uuid: 'u-death-1' }));
      p8.exit({ exitCode: 1 });
      ok('THE WRAPPER DYING retires the compaction too — the exit no record can announce, announced by the one that knows (session-stdout → session._retireCompaction)',
        s8._streamingKind === null && dB().slice(-1)[0]?.event === 'compact_end' && dB().slice(-1)[0]?.result === null,
        JSON.stringify([s8._streamingKind, dB().map((b) => b.event)]));
      ok('…and the retirement frame goes out BEFORE the `exited` broadcast (a client that has already read "the session is over" cannot act on a later stage frame)',
        (() => { const list = calls.broadcasts.filter((b) => b.id === 'w-b3-death'); const e = list.findIndex((b) => b.type === 'exited'); const c = list.findIndex((b) => b.type === 'compact-progress' && b.event === 'compact_end'); return c >= 0 && e >= 0 && c < e; })(),
        JSON.stringify(calls.broadcasts.filter((b) => b.id === 'w-b3-death').map((b) => b.type + (b.event ? '/' + b.event : ''))));
    }
    {
      // NEGATIVE CONTROL: a session that was NOT compacting dies silently — the
      // frame reports a retirement, it is not an obituary.
      const s9 = mkSession('claude', 'w-b3-death2'); const p9 = fakePty();
      so.setupSessionPty(s9, 'w-b3-death2', p9);
      p9.data(J({ type: 'result', subtype: 'success', session_id: 'sid-death2', duration_ms: 1 }));
      p9.exit({ exitCode: 0 });
      ok('NEGATIVE CONTROL: a session that never compacted dies with NO compact-progress frame at all',
        !calls.broadcasts.some((b) => b.id === 'w-b3-death2' && b.type === 'compact-progress')
        && calls.broadcasts.some((b) => b.id === 'w-b3-death2' && b.type === 'exited'),
        JSON.stringify(calls.broadcasts.filter((b) => b.id === 'w-b3-death2').map((b) => b.type)));
    }
    // ── THE PIN HAS TO SEE A *SILENT* EXIT (round 7) ───────────────────────
    //    Round 6 counted CALL SITES (`retires === 2`), which detects a deleted
    //    call and is blind to the defect it was written for: a FOURTH exit that
    //    clears the kind on its own. REPRODUCED on this suite — inserting
    //      if (msg.type === 'system' && msg.subtype === 'vs_fake_silent_exit')
    //        { session._streamingKind = null; }
    //    into the consumer left ALL 168 asserts green, pin included. So the pin
    //    is now on the ASSIGNMENTS: `endCompaction` is the ONE WRITER of the
    //    cleared kind (it broadcasts, and `retireCompaction` is the guarded
    //    wrapper both turn-lifecycle exits call), and a fifth exit is a NEW
    //    write, which this census makes red by construction.
    const csj2 = read('src/server/stdout/claude-stream-json.js');
    // Comment lines are prose ABOUT the rule (this file's own essay quotes the
    // assignment) — the census is about code.
    const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    const clearsIn = (src) => codeLines(src)
      .map((l) => ({ l }))
      .filter(({ l }) => /_streamingKind\s*(=[^=]|\]\s*=[^=])/.test(l) && /=\s*null/.test(l));
    const clears = clearsIn(csj2);
    ok(`CENSUS: exactly ONE line in the consumer clears _streamingKind, and it is inside endCompaction (${clears.length} found)`,
      clears.length === 1 && /sess\._streamingKind = null;/.test(clears[0].l)   // `sess` is endCompaction's own parameter name
      && /const endCompaction = \(sess, sid, \{ result = null, error = null, announce = true \}/.test(csj2)
      && /const retireCompaction = \(sess, sid\) => \(sess\._streamingKind === 'compacting' \? endCompaction\(sess, sid\) : false\);/.test(csj2),
      JSON.stringify(clears.map((c) => c.l.trim())));
    ok('…and that one writer BROADCASTS the retirement (a clear that does not speak is the whole defect)',
      /sess\._streamingKind = null;[^]{0,500}?if \(announce\) broadcastToSession\(sess, sid, \{ type: 'compact-progress'[^]{0,120}?event: 'compact_end'/.test(csj2),
      'endCompaction no longer broadcasts compact_end next to the clear');
    // The ONE announce-suppressed caller is the dormant compact_progress lane,
    // which publishes its own frame for the same transition a few lines down.
    const suppressed = [...csj2.matchAll(/announce: false/g)].length;
    ok(`…and exactly ONE caller suppresses the announcement (${suppressed}) — the dormant compact_progress lane, which broadcasts its own frame for the same end`,
      suppressed === 1 && /if \(ev\.type === 'compact_end'\) endCompaction\(session, id, \{ announce: false \}\);/.test(csj2));
    // NEGATIVE CONTROL: the census must SEE the injected exit that fooled the
    // round-6 pin. Run it over the same source with that line put back.
    const injected = csj2.replace('const authoritative = session._turnStateSeen === true;',
      "const authoritative = session._turnStateSeen === true;\n            if (msg.type === 'system' && msg.subtype === 'vs_fake_silent_exit') { session._streamingKind = null; }");
    ok('NEGATIVE CONTROL: the census FLAGS the exact fourth silent exit that left round 6\'s call-site pin green',
      clearsIn(injected).length === clears.length + 1, JSON.stringify(clearsIn(injected).map((c) => c.l.trim())));
    // …and no OTHER module may clear it either (the teardown path retires
    // through the consumer's own bound function — session-schema row).
    const otherClearers = ['src/ws-handler.js', 'src/server/session-stdout.js', 'src/server/stdout/codex-events.js', 'src/server/stdout/acp-events.js']
      .filter((f) => clearsIn(read(f)).length > 0);
    ok('…and no other module clears the claim behind the consumer\'s back (the teardown exit calls session._retireCompaction)',
      otherClearers.length === 0 && /session\._retireCompaction\?\.\(\)/.test(read('src/server/session-stdout.js'))
      && /_retireCompaction:/.test(read('src/session-schema.js')), JSON.stringify(otherClearers));
  }
  {
    // ── THE LAW, MEASURED: a clear that does not SPEAK is a defect ──────────
    //    The census above is source-shaped; this one is behavioural, and it
    //    reads the consumer's OWN vocabulary so a record shape added later is
    //    swept automatically: every literal the file compares `msg.type` /
    //    `msg.subtype` against is fed to the REAL consumer with the kind armed,
    //    and the law is "either the claim survives, or a compact_end frame went
    //    out in the same record". (The fake `vs_fake_silent_exit` branch of the
    //    reproduction is caught here too — its subtype is in the vocabulary.)
    const csj3 = read('src/server/stdout/claude-stream-json.js');
    const subtypes = [...new Set([...csj3.matchAll(/msg\.subtype === '([a-z_0-9]+)'/g)].map((m) => m[1]))];
    const types = [...new Set([...csj3.matchAll(/msg\.type === '([a-z_0-9]+)'/g)].map((m) => m[1]))];
    const shapes = [
      ...subtypes.map((st) => ({ name: `system/${st}`, rec: { type: 'system', subtype: st, state: 'idle', session_id: 'sid-law', uuid: `u-law-${st}` } })),
      ...types.filter((t) => t !== 'system').map((t) => ({ name: t, rec: { type: t, session_id: 'sid-law', uuid: `u-law-${t}` } })),
    ];
    const violations = [], undrivable = [];
    let n = 0;
    for (const { name, rec } of shapes) {
      const wid = `w-b3-law-${n++}`;
      let sess, pty;
      try {
        sess = mkSession('claude', wid); pty = fakePty();
        so.setupSessionPty(sess, wid, pty);
        sess._streamingKind = 'compacting';
        const before = calls.broadcasts.length;
        pty.data(J(rec));
        const spoke = calls.broadcasts.slice(before).some((b) => b.id === wid && b.type === 'compact-progress' && b.event === 'compact_end');
        if (sess._streamingKind !== 'compacting' && !spoke) violations.push(name);
      } catch (e) { undrivable.push(`${name}: ${e.message}`); }
    }
    ok(`THE LAW over the consumer's own vocabulary (${shapes.length} record shapes): nothing clears an in-flight compaction WITHOUT broadcasting compact_end`,
      violations.length === 0, `silent exits: ${JSON.stringify(violations)}`);
    ok('…and every shape was really driven (a sweep that quietly failed to run measures nothing)',
      undrivable.length === 0 && shapes.length >= 8, JSON.stringify({ undrivable, shapes: shapes.length }));
    // POSITIVE CONTROL: the sweep really does exercise the exits it exists for.
    ok('POSITIVE CONTROL: the vocabulary contains both turn-lifecycle exits and the outcome record (the sweep is not scanning an empty set)',
      types.includes('result') && subtypes.includes('session_state_changed') && subtypes.includes('status'),
      JSON.stringify({ types, subtypes }));
    // NEGATIVE CONTROL: the detector itself. A clear with no frame must be seen.
    {
      const wid = 'w-b3-law-neg';
      const sess = mkSession('claude', wid); const pty = fakePty();
      so.setupSessionPty(sess, wid, pty);
      sess._streamingKind = 'compacting';
      const before = calls.broadcasts.length;
      sess._streamingKind = null; // exactly what a fifth silent exit does
      const spoke = calls.broadcasts.slice(before).some((b) => b.id === wid && b.type === 'compact-progress' && b.event === 'compact_end');
      ok('NEGATIVE CONTROL: a clear with no frame IS a violation by this detector (it is not vacuously green)',
        sess._streamingKind !== 'compacting' && !spoke);
    }
  }
  ok("'status' is listed as HANDLED so the unknown-subtype breadcrumb stops firing for the record that marks every real compaction",
    /'status',/.test(read('src/message-manager.js').slice(0, read('src/message-manager.js').indexOf('])'))));
}
{
  // ⓔ ASK THE BINARY why leg ⓓ exists and leg ⓑ is dormant (facts law: dump,
  //    never remember). SKIP LOUDLY without a CLI.
  let bin = null;
  try { bin = fs.realpathSync(require('child_process').execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()); } catch { }
  if (!bin || !fs.existsSync(bin)) {
    console.log('  SKIP: no claude CLI on PATH — the sdk_status↔compact_progress fork was not re-dumped (leg ⓓ still runs on the production-buffer fixtures)');
  } else {
    const hits = (needle) => { try { return Number(require('child_process').execFileSync('grep', ['-c', '-a', '-F', needle, bin], { encoding: 'utf8' }).trim()) || 0; } catch { return 0; } };
    ok('the SDK sink MAPS sdk_status → system/status with compact_result (this is where §2.11 gets its facts)',
      hits('type:"system",subtype:"status",status:Oe.status') > 0 || hits('subtype:"status",status:Oe.status') > 0, 'sdk_status→system/status mapper not found');
    ok('…while compact_progress is CONSUMED by a host callback and never forwarded (the swallowing callback, named)',
      hits('case"compact_progress":') > 0, 'the onCompactEvent compact_progress case is gone — re-measure whether the record now reaches stdout');
    ok('…and set_in_progress_tool_use_ids goes to onInProgressToolUseIDs, not to the stream (why caps.inProgressTools is false)',
      hits('n.onInProgressToolUseIDs?.(e.op)') > 0 || hits('onInProgressToolUseIDs?.(e.op)') > 0, 'the swallowing callback is gone — re-run the wire probe, the cap may be flippable');
  }
}
{
  // ⓕ THE WIRE. Everything above feeds records WE wrote. This leg spawns the
  //    installed CLI in chat-wrapper.js's exact flag shape, runs read-only
  //    tools, and censuses what actually lands on stdout — the ONE leg that can
  //    tell "we parse it right" from "it never arrives" (scripts/
  //    probe-claude-stdout.mjs; one turn, cheapest model, ~10s).
  //    It FAILS only on a real contradiction: the wire and the caps row
  //    disagreeing. Anything that makes the measurement impossible (no CLI, no
  //    tool ran, a timeout) SKIPS LOUDLY — a probe that could not measure is
  //    never evidence of absence.
  let res = null, why = '';
  try {
    const raw = require('child_process').execFileSync(process.execPath, [path.join(REPO, 'scripts/probe-claude-stdout.mjs')], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] });
    res = JSON.parse(String(raw).trim().split('\n').filter(Boolean).pop() || '{}');
  } catch (e) { why = e.message; }
  if (!res || res.skip || !res.ok) console.log(`  SKIP: wire probe did not run (${res?.skip || why || 'unknown'}) — the caps rows were not re-measured against a live CLI`);
  else if (!res.toolUses) console.log(`  SKIP: wire probe ran ${res.version} but no tool executed (${JSON.stringify(res.types)}) — nothing to measure the run-set record against`);
  else {
    const n = (t) => res.types[t] || 0;
    ok(`${res.version} wire probe: ${res.toolUses} tool_use / ${res.toolResults} tool_result really executed in the wrapper's flag shape`, res.toolResults > 0, JSON.stringify(res.types));
    // POSITIVE CONTROL — without this the absence below proves nothing about
    // the CLI, only about our reader.
    ok('…POSITIVE CONTROL: system/session_state_changed DID arrive on the same stdout (the reader works, and the spawn env is real)', n('system/session_state_changed') > 0, JSON.stringify(res.types));
    // THE MEASUREMENT, in BOTH directions. Today: 0 records ⇒ the cap must be
    // false. The day a CLI forwards one, this goes RED and the fix is to flip
    // src/backend-caps.js + src/lib/agent-meta.js to true (the consumer, the
    // broadcast, the attach field and the CSS dot are already written).
    ok(`caps.inProgressTools agrees with the wire (${n('set_in_progress_tool_use_ids')} set_in_progress_tool_use_ids records observed for ${res.toolUses} tool_use blocks)`,
      (n('set_in_progress_tool_use_ids') > 0) === capsOf('claude').inProgressTools,
      n('set_in_progress_tool_use_ids') > 0
        ? 'THE RECORD NOW ARRIVES — flip inProgressTools to true in src/backend-caps.js AND src/lib/agent-meta.js; the consumer is already written'
        : 'caps says the CLI reports a run set, but none arrived — demote the row, no surface may claim the executing dot');
    ok(`compact_progress is still absent from our stdout (${n('compact_progress')}) — §2.11 runs on system/status, and leg ⓑ is shape parity only`, n('compact_progress') === 0, JSON.stringify(res.types));
  }
  // ── ⓕ' THE PROBE LEAVES NOTHING BEHIND ────────────────────────────────────
  //    This leg runs on EVERY non-docs push (pre-push → npm run ci) against the
  //    developer's REAL $HOME — it needs the machine's actual credentials, so
  //    it cannot be handed a throwaway one. A real CLI turn therefore writes a
  //    real transcript, and the product's OWN discovery lists it: 12 junk
  //    "stopped" sessions (and 12 junk cwd folder groups) had accumulated in
  //    the sidebar, one per push. Measured as the CONSEQUENCE — asked of
  //    session-store, not of the filesystem.
  //
  //    ROUND 6 — A CLEANUP ASSERT MUST APPLY THE SWEEP'S RULE, NOT ITS OWN.
  //    The sweep removes probe leftovers only when they are STALE (>10min):
  //    a probe running RIGHT NOW owns a fresh cwd + transcript and must
  //    survive, and two worktrees pushing minutes apart really do overlap (the
  //    2 leftovers the first round-5 run swept were two other verifier
  //    worktrees' probes, dated the same minute). Round 5 asserted ABSOLUTE
  //    ABSENCE, so a concurrent probe — the exact case the sweep exists to
  //    spare — turned the mandatory pre-push gate red and blamed the sweep for
  //    it. REPRODUCED: a fresh `-tmp-vs-wire-probe-*` dir with a transcript in
  //    the real $HOME failed BOTH readers here (the readdir one AND the
  //    discovery one). So the probe now REPORTS its rule (`cleaned.staleMs`,
  //    `cleaned.spared`) and both readers below filter by it, with the
  //    consequence measured in both directions on the SAME directory.
  if (res?.ok) {
    const { cwdToProjectDir, discoverClaudeSessions } = require(path.join(REPO, 'src/session-store.js'));
    const home = process.env.HOME || os.homedir();
    const PROJECTS = path.join(home, '.claude', 'projects');
    const PROJ_PREFIX = cwdToProjectDir(path.join(os.tmpdir(), 'vs-wire-probe-'));
    const projDir = path.join(PROJECTS, cwdToProjectDir(res.cwd));
    const staleMs = res.cleaned?.staleMs;
    const sweptAt = res.cleaned?.sweptAt;
    // THE SWEEP'S DECISION LIST, by name. Round 6 had the readers re-derive
    // staleness from the reported THRESHOLD — but on their own, LATER clock,
    // so a leftover the sweep spared at 9m58s was reported and then flagged at
    // 10m01s (round 7; reproduced deterministically with the fake CLI below).
    // A spared name is a VERDICT, not a measurement: never ask the clock about
    // it again.
    const sparedNames = new Set((res.cleaned?.spared || []).map((x) => x.name));
    // THE TWO READERS, as pure functions of (facts, threshold, clock) so the
    // controls below can drive them in both directions. The default clock is
    // the SWEEP'S, not `Date.now()`.
    const staleLeftovers = (root, ms, now = sweptAt) => {
      let names = []; try { names = fs.readdirSync(root); } catch { return []; }
      return names.filter((d) => d.startsWith(PROJ_PREFIX) && !sparedNames.has(d)).filter((d) => {
        try { return now - fs.statSync(path.join(root, d)).mtimeMs > ms; } catch { return false; }
      });
    };
    const staleJunk = (list, ms, now = sweptAt) =>
      list.filter((s) => /vs-wire-probe-/.test(s.cwd || '')
        && !sparedNames.has(cwdToProjectDir(s.cwd || ''))
        && now - (s.startedAt || 0) > ms);

    ok(`the probe REPORTS the sweep rule it used (staleMs=${staleMs}, spared ${res.cleaned?.spared?.length}) — a cleanup assert applies the rule instead of guessing one`,
      Number.isFinite(staleMs) && staleMs > 0 && Array.isArray(res.cleaned?.spared), JSON.stringify(res.cleaned));
    ok(`…and it reports the CLOCK it decided on (sweptAt=${sweptAt}), not just the threshold — a reader on its own, later clock re-judges what the sweep already judged`,
      Number.isFinite(sweptAt) && sweptAt > 0 && sweptAt <= Date.now(), JSON.stringify(res.cleaned));
    ok('…and everything it SPARED really is younger than that threshold ON THAT CLOCK (it never calls a stale leftover "concurrent")',
      (res.cleaned?.spared || []).every((s) => s.ageMs >= 0 && s.ageMs <= staleMs), JSON.stringify(res.cleaned?.spared));
    ok(`the probe removed its own temp cwd (${res.cwd})`, !fs.existsSync(res.cwd), 'the throwaway cwd survived — it becomes a junk folder group in the sidebar');
    ok('…and the transcript the CLI wrote for it (no junk session in the user’s sidebar)', !fs.existsSync(projDir), projDir);
    ok('…and no STALE leftover of an earlier run survived the sweep',
      staleLeftovers(PROJECTS, staleMs).length === 0,
      `a STALE probe leftover survived the sweep: ${JSON.stringify(staleLeftovers(PROJECTS, staleMs).slice(0, 3))}`);
    // NEGATIVE CONTROL: the raw capture is deliberately KEPT, at ONE fixed path
    // outside the deleted cwd — cleanup must not mean "lost the evidence".
    ok('NEGATIVE CONTROL: the raw stdout capture survives at one fixed, overwritten path (a failure is still debuggable)',
      typeof res.raw === 'string' && !res.raw.startsWith(res.cwd) && fs.existsSync(res.raw), `raw=${res.raw} rawSkip=${res.rawSkip}`);

    // THE CONSEQUENCE, asked of the product: discovery must not see a leftover
    // one — and must not be fooled into calling a LIVE probe one either. The
    // control dir below is byte-for-byte what a concurrently running probe
    // leaves behind, and it is measured at BOTH ages.
    const ctlCwd = path.join(os.tmpdir(), `vs-wire-probe-CONCURRENT-CONTROL-${process.pid}`);
    const ctlDir = path.join(PROJECTS, cwdToProjectDir(ctlCwd));
    const ctlSid = 'c07c0000-0000-4000-8000-' + String(process.pid).padStart(12, '0').slice(-12);
    const ctlJsonl = path.join(ctlDir, `${ctlSid}.jsonl`);
    const rmCtl = () => { try { fs.rmSync(ctlDir, { recursive: true, force: true }); } catch { } };
    process.on('exit', rmCtl); // a SIGKILL'd suite leaves a FRESH dir the next probe sweeps in 10min
    try {
      fs.mkdirSync(ctlDir, { recursive: true });
      fs.writeFileSync(ctlJsonl, JSON.stringify({ type: 'user', cwd: ctlCwd, sessionId: ctlSid, message: { role: 'user', content: 'concurrent probe' } }) + '\n');
      const listLive = await discoverClaudeSessions({ activeSessions: new Map() });
      const junkLive = staleJunk(listLive, staleMs);
      ok(`the product’s own session discovery lists ZERO STALE probe sessions (${listLive.length} sessions scanned)`, junkLive.length === 0,
        JSON.stringify(junkLive.slice(0, 3).map((s) => ({ cwd: s.cwd, status: s.status, ageMs: Date.now() - (s.startedAt || 0) }))));
      ok('REGRESSION: a probe running CONCURRENTLY (fresh cwd + transcript — what the sweep deliberately spares) fails NEITHER reader',
        staleLeftovers(PROJECTS, staleMs).length === 0 && junkLive.length === 0
          && listLive.some((s) => s.cwd === ctlCwd), // it IS visible — the filters skip it on AGE, not by failing to see it
        JSON.stringify({ leftovers: staleLeftovers(PROJECTS, staleMs).slice(0, 3), junk: junkLive.length, seen: listLive.some((s) => s.cwd === ctlCwd) }));
      // NEGATIVE CONTROL: the SAME directory, backdated past the threshold, is
      // a real leftover — both readers must flag it, or they are vacuous.
      const old = (Date.now() - staleMs - 60000) / 1000;
      fs.utimesSync(ctlJsonl, old, old); fs.utimesSync(ctlDir, old, old);
      const listOld = await discoverClaudeSessions({ activeSessions: new Map() });
      ok('NEGATIVE CONTROL: the SAME dir backdated past the threshold IS flagged by both readers (they filter on age, they are not blind to the name)',
        staleLeftovers(PROJECTS, staleMs).includes(path.basename(ctlDir)) && staleJunk(listOld, staleMs).some((s) => s.cwd === ctlCwd),
        JSON.stringify({ leftovers: staleLeftovers(PROJECTS, staleMs), junk: staleJunk(listOld, staleMs).map((s) => s.cwd) }));
    } finally { rmCtl(); }
  }
}
{
  // ── ⓕ″ THE PROBE'S OWN CONTRACTS, measured deterministically ──────────────
  //    Everything above depends on a real CLI turn, so it SKIPs on a machine
  //    without one — and the two contracts round 6 fixed (the sweep's staleness
  //    rule, and where the raw capture is allowed to write) are exactly the
  //    kind that must not depend on that. These legs run the REAL probe end to
  //    end against a FAKE claude on PATH, in an isolated HOME + TMPDIR: zero
  //    vendor cost, no real-$HOME side effects, and every branch driven on
  //    purpose instead of waited for.
  //
  //    ROUND 7 — A HARNESS THAT CANNOT RUN MUST SAY SO, NOT CRASH. The whole
  //    leg lives in a labelled block: if the probe cannot be driven at all
  //    (a broken fake CLI, a PATH without the interpreter, a probe that
  //    exits early) ONE assert goes red naming the reason and the leg bails,
  //    so the ~65 asserts AFTER it still run. Round 6 read `r1.raw` before
  //    checking `r1.ok`, and an early `skip` therefore killed the process with
  //    a TypeError that named nothing — the mandatory pre-push gate went red
  //    for the wrong reason, which is the exact class this batch keeps fixing.
  FAKE_CLI: {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-probe-contract-'));
  // A suite that measures "the probe leaves nothing behind" does not get to
  // leak its own scratch tree when an assertion throws — and this name is
  // outside the probe's sweep prefix, so nothing else would ever collect it.
  process.on('exit', () => { try { fs.rmSync(tdir, { recursive: true, force: true }); } catch { } });
  const bin = path.join(tdir, 'bin'), fhome = path.join(tdir, 'home'), ftmp = path.join(tdir, 'tmp');
  for (const d of [bin, ftmp, path.join(fhome, '.claude', 'projects')]) fs.mkdirSync(d, { recursive: true });
  // A fake `claude` that speaks just enough stream-json for the probe to finish
  // — AND leaves the same footprint the real one does: a transcript under the
  // encoded cwd and a per-session env dir. Without those the "left nothing
  // behind" assertions would be vacuously true.
  // THE SHEBANG NAMES THE INTERPRETER RUNNING THIS SUITE (round 7). `#!/usr/bin/
  // env node` looks harmless and is a landmine: the probe below is handed a
  // PATH built for the FAKE cli, so `env node` resolves against THAT PATH, and
  // a machine whose node is not in it (nvm-only dev box, the project's own
  // node:22-bookworm-slim image at /usr/local/bin/node, a GitHub runner using
  // actions/setup-node) makes the fake CLI unrunnable — the probe reports
  // `claude --version failed: env: 'node': No such file or directory`, three
  // asserts go red and the leg used to die on `path.dirname(undefined)`. It
  // passed HERE only by luck (Debian's apt nodejs also left a v20 at
  // /usr/bin/node). `process.execPath` is the one interpreter we KNOW exists.
  const NODE_DIR = path.dirname(process.execPath);
  // A path with whitespace cannot be a shebang argument on Linux; fall back to
  // the PATH lookup, which works because NODE_DIR is on the PATH we hand over.
  const SHEBANG = /\s/.test(process.execPath) ? '#!/usr/bin/env node' : `#!${process.execPath}`;
  fs.writeFileSync(path.join(bin, 'claude'), `${SHEBANG}
const fs = require('fs'), path = require('path'), os = require('os');
if (process.argv.includes('--version')) { process.stdout.write('0.0.0-fake (probe contract harness)\\n'); process.exit(0); }
const sid = '11111111-2222-4333-8444-' + String(process.pid).padStart(12, '0').slice(-12);
const home = process.env.HOME || os.homedir();
const proj = path.join(home, '.claude', 'projects', process.cwd().replace(/[/._]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, sid + '.jsonl'), JSON.stringify({ type: 'user', cwd: process.cwd(), sessionId: sid, message: { role: 'user', content: 'probe' } }) + '\\n');
const senv = path.join(home, '.claude', 'session-env', sid);
fs.mkdirSync(senv, { recursive: true });
// A LEDGER of what this run really created, outside everything the probe
// sweeps — so the suite can assert "these exact paths existed, and are gone"
// instead of asserting the absence of something that may never have been made.
fs.appendFileSync(path.join(home, 'fake-cli-footprint.jsonl'), JSON.stringify({ cwd: process.cwd(), sid, proj: path.join(proj, sid + '.jsonl'), senv }) + '\\n');
const e = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', () => {});
setTimeout(() => {
  e({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sid });
  e({ type: 'assistant', session_id: sid, message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
  e({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } });
  e({ type: 'result', session_id: sid, subtype: 'success' });
}, 30);
setTimeout(() => process.exit(0), 60000);
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  // The fake bin FIRST (so `command -v claude` finds it even if a real claude
  // sits next to node), then the interpreter's own directory.
  const PROBE_PATH = `${bin}:${NODE_DIR}:/usr/bin:/bin`;
  const runProbe = (over = {}) => {
    const raw = require('child_process').execFileSync(process.execPath, [path.join(REPO, 'scripts/probe-claude-stdout.mjs')],
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: PROBE_PATH, HOME: fhome, TMPDIR: ftmp, ...over } });
    return JSON.parse(String(raw).trim().split('\n').filter(Boolean).pop() || '{}');
  };
  const { cwdToProjectDir } = require(path.join(REPO, 'src/session-store.js'));
  const fProjects = path.join(fhome, '.claude', 'projects');
  const mkLeftover = (name, ageMs) => {
    const c = path.join(ftmp, `vs-wire-probe-${name}`);
    const d = path.join(fProjects, cwdToProjectDir(c));
    fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(d, '00000000-0000-4000-8000-00000000000a.jsonl'), JSON.stringify({ type: 'user', cwd: c }) + '\n');
    const t = (Date.now() - ageMs) / 1000;
    for (const p of [d, c]) fs.utimesSync(p, t, t);
    return { c, d };
  };
  const oldOne = mkLeftover('OLD', 30 * 60 * 1000);   // a real leftover
  const liveOne = mkLeftover('LIVE', 5 * 1000);       // a probe running right now
  const r1 = runProbe();
  ok(`the probe runs end-to-end against a fake CLI (${r1.version}) — the cleanup contracts are measurable with no vendor call`, r1.ok === true && r1.toolUses === 1, JSON.stringify(r1).slice(0, 300));
  // EVERYTHING BELOW READS r1's REPORT. A probe that could not run has no
  // report, and reading it anyway is how round 6 turned a red assert into a
  // process-killing TypeError. One loud line, then bail — never SKIP silently:
  // this harness is entirely ours, so "it did not run" is a failure, not an
  // absence of evidence.
  if (r1.ok !== true) {
    ok(`the fake-CLI harness produced a report — otherwise every probe CONTRACT below is UNMEASURED (${r1.skip || 'no skip reason'})`, false, JSON.stringify(r1).slice(0, 300));
    break FAKE_CLI;
  }
  const footprints = () => (() => { try { return fs.readFileSync(path.join(fhome, 'fake-cli-footprint.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const fp1 = footprints();
  ok('POSITIVE CONTROL: the fake CLI left the real one\'s footprint (a transcript under the encoded cwd + a per-session env dir) — "left nothing behind" is not vacuous',
    fp1.length === 1 && fp1[0].cwd === r1.cwd && /vs-wire-probe-/.test(fp1[0].proj) && /session-env/.test(fp1[0].senv), JSON.stringify(fp1));
  ok('THE SWEEP: a STALE leftover (30min) is removed — cwd AND the transcript the CLI wrote for it',
    !fs.existsSync(oldOne.c) && !fs.existsSync(oldOne.d), JSON.stringify({ cwd: fs.existsSync(oldOne.c), proj: fs.existsSync(oldOne.d) }));
  ok('…and a CONCURRENT one (5s) SURVIVES — killing a running probe\'s cwd out from under it is the failure this threshold exists to prevent',
    fs.existsSync(liveOne.c) && fs.existsSync(liveOne.d));
  ok('…and the report NAMES the spared one, with its age (the rule a reader must apply)',
    (r1.cleaned?.spared || []).some((s) => s.name === path.basename(liveOne.d) && s.ageMs < r1.cleaned.staleMs) && r1.cleaned.swept >= 1,
    JSON.stringify(r1.cleaned));
  ok('…and the probe removed its OWN footprint — the exact transcript and session-env dir the CLI just created, and the temp cwd',
    !fs.existsSync(r1.cwd) && fp1.every((f) => !fs.existsSync(f.proj) && !fs.existsSync(f.senv) && !fs.existsSync(path.dirname(f.proj))),
    JSON.stringify({ cwd: fs.existsSync(r1.cwd), fp: fp1.map((f) => [fs.existsSync(f.proj), fs.existsSync(f.senv)]) }));
  // THE RAW CAPTURE. Round 5 wrote it to a predictable name directly in the
  // shared /tmp with `fs.writeFileSync`, which FOLLOWS symlinks: /tmp's sticky
  // bit stops another local user deleting our file, not creating that name
  // first. REPRODUCED on the round-5 script: a planted
  // `/tmp/vs-wire-probe.last.jsonl -> victim` had the victim's contents
  // replaced by CLI stdout, under the developer's own uid, on every push.
  ok('POSITIVE CONTROL: the raw capture IS written, at one fixed path, in a dir this uid owns (0700)',
    typeof r1.raw === 'string' && fs.existsSync(r1.raw) && /session_state_changed/.test(fs.readFileSync(r1.raw, 'utf8'))
    && (fs.statSync(path.dirname(r1.raw)).mode & 0o777) === 0o700, `raw=${r1.raw} rawSkip=${r1.rawSkip}`);
  ok('…and it is NOT a bare predictable name in the shared /tmp root (the shape that made it a symlink target)',
    path.dirname(r1.raw) !== ftmp && path.dirname(path.dirname(r1.raw)) === ftmp, r1.raw);
  const victim = path.join(tdir, 'victim.txt'), VICTIM = 'IMPORTANT USER FILE\n';
  // Removing a PLANT is not `fs.rmSync(p, {force:true})`: node resolves the
  // path first, so that throws ERR_FS_EISDIR on a symlink→directory (verified
  // on node v24) and would never touch the link. Unlink the link itself.
  const unplant = (p) => {
    try { if (fs.lstatSync(p).isSymbolicLink()) { fs.unlinkSync(p); return; } } catch { return; }
    fs.rmSync(p, { recursive: true, force: true });
  };
  {
    // ATTACK A: the final component is a planted symlink.
    fs.writeFileSync(victim, VICTIM);
    unplant(r1.raw); fs.symlinkSync(victim, r1.raw);
    const r2 = runProbe();
    ok('ATTACK: a symlink planted at the capture path is NOT followed — the victim file is untouched and the probe SAYS why',
      fs.readFileSync(victim, 'utf8') === VICTIM && r2.raw === null && /ELOOP|not a directory|open /.test(String(r2.rawSkip)), `rawSkip=${r2.rawSkip} victim=${JSON.stringify(fs.readFileSync(victim, 'utf8').slice(0, 40))}`);
    ok('…and the probe still MEASURED the wire (a refused capture degrades the evidence, it does not fail the run)', r2.ok === true && r2.toolUses === 1, JSON.stringify(r2).slice(0, 200));
    ok('…and the plant is still a SYMLINK afterwards — the probe never replaced it with a file of its own', fs.lstatSync(r1.raw).isSymbolicLink());
    unplant(r1.raw);
  }
  {
    // ATTACK B: the capture DIR itself is a planted symlink (the write would
    // land wherever it points, with the final component still a fresh name).
    const vdir = path.join(tdir, 'victimdir'); fs.mkdirSync(vdir, { recursive: true });
    const rawDir = path.dirname(r1.raw);
    unplant(rawDir); fs.symlinkSync(vdir, rawDir);
    const r3 = runProbe();
    ok('ATTACK: a symlink planted at the capture DIR is refused by name+owner check — nothing is written through it',
      fs.readdirSync(vdir).length === 0 && r3.raw === null && /not a directory/.test(String(r3.rawSkip)), `rawSkip=${r3.rawSkip} dir=${JSON.stringify(fs.readdirSync(vdir))}`);
    unplant(rawDir);
    const r4 = runProbe();
    ok('NEGATIVE CONTROL: with the plant removed the capture works again (the guard refuses an attack, it does not disable the feature)',
      r4.raw && fs.existsSync(r4.raw) && r4.rawSkip == null, `raw=${r4.raw} rawSkip=${r4.rawSkip}`);
    // A dir we OWN but that is group/other-writable is a shared namespace
    // again — the whole point of moving out of /tmp. We own it, so close it.
    fs.chmodSync(rawDir, 0o777);
    const r5 = runProbe();
    ok('…and a capture dir left world-writable is CLOSED before use (owning it is not enough — it has to stay ours alone)',
      (fs.statSync(rawDir).mode & 0o777) === 0o700 && r5.raw && fs.existsSync(r5.raw) && r5.rawSkip == null,
      `mode=${(fs.statSync(rawDir).mode & 0o777).toString(8)} rawSkip=${r5.rawSkip}`);
  }
  {
    // ── THE HARNESS MUST NOT ASSUME WHERE node LIVES (round 7) ──────────────
    //    Reproduced by running this leg verbatim with `/usr/bin:/bin` swapped
    //    for a node-less directory: the fake CLI (`#!/usr/bin/env node`) could
    //    not start, the probe reported `claude --version failed: /usr/bin/env:
    //    'node': No such file or directory`, three asserts went red and the
    //    process then DIED on `path.dirname(undefined)`, taking ~65 later
    //    asserts with it. Measured as the consequence: the probe is driven with
    //    a PATH that has NO node anywhere except through the fake CLI's own
    //    shebang, which is what an nvm-only box / the node:22-slim image / an
    //    actions/setup-node runner all look like.
    const nodeless = path.join(tdir, 'nodeless');
    fs.mkdirSync(nodeless, { recursive: true });
    // `sh` only — the probe resolves `sh -c 'command -v claude'` through PATH.
    try { fs.symlinkSync(fs.realpathSync('/bin/sh'), path.join(nodeless, 'sh')); } catch { }
    const noNode = `${bin}:${nodeless}`;
    const rNo = runProbe({ PATH: noNode });
    ok(`REGRESSION: the fake CLI starts with NO node on the probe's PATH (${rNo.version || rNo.skip}) — the harness names the interpreter running this suite, it does not assume /usr/bin/node`,
      rNo.ok === true && rNo.toolUses === 1, JSON.stringify(rNo).slice(0, 220));
    // NEGATIVE CONTROL: the round-6 spelling, same PATH. If this went green the
    // leg above would be measuring nothing (it would mean node IS reachable).
    const bin6 = path.join(tdir, 'bin-round6');
    fs.mkdirSync(bin6, { recursive: true });
    fs.writeFileSync(path.join(bin6, 'claude'), fs.readFileSync(path.join(bin, 'claude'), 'utf8').replace(/^#![^\n]*/, '#!/usr/bin/env node'));
    fs.chmodSync(path.join(bin6, 'claude'), 0o755);
    const rOld = runProbe({ PATH: `${bin6}:${nodeless}` });
    ok('NEGATIVE CONTROL: the SAME fake CLI with round 6\'s `#!/usr/bin/env node` cannot start on that PATH, and the probe SAYS so (a skip, not a crash)',
      rOld.ok !== true && /--version failed|no claude CLI/.test(String(rOld.skip)), JSON.stringify(rOld).slice(0, 220));
    // …and the report is still a report: the gate above reads `ok` FIRST, so a
    // skip like that one can never reach `path.dirname(r.raw)`.
    ok('…and a skipped probe still reports the sweep it ran before the CLI check (the contract asserts have something to read, or bail loudly)',
      rOld.cleaned && Number.isFinite(rOld.cleaned.staleMs) && Number.isFinite(rOld.cleaned.sweptAt), JSON.stringify(rOld.cleaned));
  }
  {
    // ── THE SWEEP'S CLOCK, not the reader's (round 7) ───────────────────────
    //    Round 6 exported the THRESHOLD and the reader re-derived staleness at
    //    ASSERTION time. A leftover younger than the threshold when the sweep
    //    looked, but older by the time the probe reports (the window is the
    //    probe's own runtime: ~2s here, 5-40s with a real haiku turn, up to
    //    BUDGET_MS), was spared AND THEN FLAGGED — the mandatory gate going red
    //    on precisely the case the sweep exists to spare, blaming the sweep.
    //    Driven deterministically: EDGE is planted 1.5s under the threshold and
    //    the probe's own post-result beat (2s) carries it over.
    const staleMs = r1.cleaned.staleMs;
    const edge = mkLeftover('EDGE', staleMs - 1500);
    const rE = runProbe();
    const edgeName = path.basename(edge.d);
    const sparedE = (rE.cleaned?.spared || []).find((x) => x.name === edgeName);
    ok('the sweep SPARED the edge leftover and reported its age ON ITS OWN CLOCK (under the threshold), not on the reader\'s later one',
      !!sparedE && sparedE.ageMs <= staleMs && fs.existsSync(edge.d), JSON.stringify({ spared: rE.cleaned?.spared, exists: fs.existsSync(edge.d) }));
    // The consequence, on BOTH readers, exactly as leg ⓕ′ builds them.
    const sparedNames = new Set((rE.cleaned?.spared || []).map((x) => x.name));
    const reader = (now) => fs.readdirSync(fProjects)
      .filter((d) => d.startsWith(cwdToProjectDir(path.join(ftmp, 'vs-wire-probe-'))) && !sparedNames.has(d))
      .filter((d) => { try { return now - fs.statSync(path.join(fProjects, d)).mtimeMs > staleMs; } catch { return false; } });
    ok('…so the round-7 reader (sweep clock + the spared DECISION LIST) flags nothing',
      reader(rE.cleaned.sweptAt).length === 0, JSON.stringify(reader(rE.cleaned.sweptAt)));
    // NEGATIVE CONTROL: the round-6 reader — its own clock, no decision list —
    // flags the very directory the sweep deliberately kept. Wait for the
    // threshold to be crossed (bounded) so the control cannot pass by accident.
    const deadline = Date.now() + 5000;
    const r6reader = () => fs.readdirSync(fProjects)
      .filter((d) => d.startsWith(cwdToProjectDir(path.join(ftmp, 'vs-wire-probe-'))))
      .filter((d) => { try { return Date.now() - fs.statSync(path.join(fProjects, d)).mtimeMs > staleMs; } catch { return false; } });
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
    while (r6reader().length === 0 && Date.now() < deadline) sleepSync(200);
    ok('NEGATIVE CONTROL: the round-6 reader (its OWN, later clock, no decision list) flags that spared leftover — which is the failure, reproduced',
      r6reader().includes(edgeName), JSON.stringify({ r6: r6reader(), edgeName, ageMs: Date.now() - fs.statSync(edge.d).mtimeMs }));
    // …and the NEXT run really does collect it: sparing is a deferral, not an
    // exemption (or the sweep would leak one dir per overlapping run forever).
    const rF = runProbe();
    ok('…and the NEXT probe run sweeps it (sparing defers, it does not exempt)',
      !fs.existsSync(edge.d) && !fs.existsSync(edge.c) && rF.cleaned.swept >= 1, JSON.stringify(rF.cleaned));
  }
  fs.rmSync(tdir, { recursive: true, force: true });
  }
}
{
  // ⑨ RETRACTION on the live stream: a tombstone for a message we rendered.
  //    UNVERIFIED ON OUR WIRE, deliberately (round 4, and said in the docs the
  //    same way): 0 in 24 production buffers, 0 in the wire probe above, and
  //    `grep -rl '"type":"tombstone"' ~/.claude/projects/` → 0 files, so the
  //    persisted path cannot produce one either. Unlike the two records this
  //    round demoted, it is NOT disproven — it is *yielded* on the query
  //    stream (`for(let eu of Bu) yield{type:"tombstone",message:eu}`, offsets
  //    185068785 / 185075330), not handed to a callback. It is also not cheaply
  //    triggerable: BOTH emitters sit on the server REFUSAL-FALLBACK path
  //    (`ks.type==="refusal_no_fallback"` and the `server_fallback` /
  //    `api_refusal_category` branch), i.e. the safety classifier refusing
  //    mid-stream — no deterministic probe exists that does not amount to
  //    deliberately provoking a refusal, which is not something a test suite
  //    should do. So the claude half of §2.10 stays as DORMANT code with the
  //    behaviour pinned here, and the shipped retraction lane is codex's
  //    `thread_rolled_back` (verified in 3 real local rollouts).
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
    // round 8: 'requires_action' writes NO line, with or without one there.
    // Every label this function DOES write ('' on idle, 'thinking...' onto an
    // empty line) stays true for as long as the turn runs; 'waiting for you'
    // would not, and nothing on the wire can retract it (see leg ⑨).
    && turnStateEffect('requires_action').streaming === true && turnStateEffect('requires_action').label === null
    && turnStateEffect('requires_action', { hasLabel: true }).label === null
    && turnStateEffect('requires_action', { hasLabel: false }).label === null
    && turnStateEffect('wedged') === null);
// ── 3a-bis. the WIDENED init frame + commands_changed over the same consumer ──
// (design-harness-features §2.6). The frame is the fixture the schema pin in
// scripts/test-init-frame.mjs re-greps out of the installed 2.1.257 binary;
// here it travels the REAL pty→consumer→normalizer path a live session uses.
console.log('— stream-json: init frame widening + commands_changed');
{
  const FRAME = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/claude-init-frame.json'), 'utf8'));
  const s = mkSession('claude', 'w-init'); const p = fakePty();
  so.setupSessionPty(s, 'w-init', p);
  p.data(J({ ...FRAME, session_id: 'sid-init-1' }));
  const initMsg = s._ops.find((o) => o.op === 'create')?.message;
  const frame = initMsg?.content?.[0]?.initData?.frame;
  ok('the init record still adopts the session id (unchanged side effects)', s.backendSessionId === 'sid-init-1' && s._permissionMode === 'default');
  ok('…and the WHOLE frame reaches the client through initData: a FAILED mcp server, the demoted plugin, skills, output style, memory dirs, terminal-bound commands',
    !!frame && frame.mcpServers.some((m) => m.status === 'failed') && frame.pluginErrors[0].plugin === 'old-helper'
    && frame.skills.length === 3 && frame.outputStyle === 'Explanatory' && !!frame.memoryPaths.auto
    && frame.terminalSlashCommands.join(',') === 'doctor,color', JSON.stringify(frame).slice(0, 300));
  const cmdOps = () => s._ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
  ok('…the command list rides ONE meta op carrying the terminal-bound subset (what the composer must hide)',
    cmdOps().length === 1 && cmdOps()[0].data.commands.includes('doctor') && cmdOps()[0].data.terminal.join(',') === 'doctor,color');
  p.data(J({ type: 'system', subtype: 'commands_changed', session_id: 'sid-init-1', uuid: 'u-cc', commands: [{ name: 'compact', description: 'x', argumentHint: '' }, { name: 'brand-new', description: 'y', argumentHint: '' }] }));
  ok('a mid-session commands_changed REPLACES the list wholesale (the CLI\'s own contract) — the new command is in, the dropped ones are gone',
    cmdOps().length === 2 && cmdOps()[1].data.commands.join(',') === 'compact,brand-new' && !cmdOps()[1].data.commands.includes('model'), JSON.stringify(cmdOps()[1]?.data));
  ok('…and the completion the composer builds from it hides nothing that is gone upstream, everything else keeps its slash',
    slashCompletionList(cmdOps()[1].data.commands, cmdOps()[1].data.terminal).join(',') === '/compact,/brand-new');
  ok('the composer completion from the INIT push hides the terminal-bound commands (/doctor, /color) and keeps the rest',
    (() => { const l = slashCompletionList(cmdOps()[0].data.commands, cmdOps()[0].data.terminal); return !l.includes('/doctor') && !l.includes('/color') && l.includes('/compact'); })());
  ok('the health strip has something to say for this frame (a failed + a needs-auth server, a skipped config, a demoted plugin)…',
    initHealthIssues(frame).length === 4, JSON.stringify(initHealthIssues(frame)));
  ok('…NEGATIVE CONTROL: an OLD CLI\'s three-field init frame carries no widened facts at all (absent ≠ empty) and reports no health issues, so nothing renders',
    (() => {
      const s2 = mkSession('claude', 'w-init-old'); const p2 = fakePty();
      so.setupSessionPty(s2, 'w-init-old', p2);
      p2.data(J({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'claude-opus-4', permissionMode: 'default', slash_commands: ['compact'], uuid: 'u-old' }));
      const f2 = s2._ops.find((o) => o.op === 'create')?.message?.content?.[0]?.initData?.frame;
      return f2 && Object.keys(f2).join(',') === 'slashCommands' && initHealthIssues(f2).length === 0;
    })());
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
    ok('the hardcoded compaction apology is now the FALLBACK of one hint function (ONE copy of the sentence, in compactFallbackHint)',
      /compactHintText\(\) \{/.test(cr) && /compactFallbackHint\(\) \{/.test(cr) && /if \(!s\) return this\.compactFallbackHint\(\);/.test(cr)
      && (cr.match(/Compacting a large conversation takes 1/g) || []).length === 1);
    // WIRING PIN (round 5): the fix lives at the CARD's build site — a held
    // terminal stage must not become the view's permanent voice. A pure
    // predicate whose call site is not staged is the 2.355.0 class.
    ok('…and a NEW card gates that sentence on compactInFlight(), never on the held stage',
      /compactInFlight\(\) \{/.test(cr) && /s\.event !== 'compact_end'/.test(cr)
      && /chat-ctx-full-hint">\$\{escHtml\(this\.compactInFlight\(\) \? this\.compactHintText\(\) : this\.compactFallbackHint\(\)\)\}/.test(cr),
      'appendContextFullCard renders the held stage into a card built after the compaction ended');
    ok('…and only the CLI’s own "success" is reported as FINISHED (a hook-blocked compaction ends with no outcome and compacted nothing)',
      /if \(s\.result === 'success'\) return t\('Compaction finished\.'\);/.test(cr) && /return t\('Compaction ended\.'\);/.test(cr),
      'a compact_end with result:null still claims success');
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
