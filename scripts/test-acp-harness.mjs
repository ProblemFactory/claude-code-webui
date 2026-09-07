#!/usr/bin/env node
// S8 — the GENERIC ACP v1 harness (docs/design-harness-plugins.md §2.3):
// drives the REAL data/bin/acp-wrapper.js against scripts/dev/mock-acp-agent.mjs
// (a dependency-free ACP v1 agent) over plain pipes — no pty, no dtach — and
// asserts the wire (initialize → session/new → prompt → request_permission →
// cancel → load), the 'acp-events' journal, the sidecar meta, every stdin
// verb, then the normalizer (AcpMessageManager) + store reader shapes, and
// the wiring pins (stdout consumer, spawn gate, picker, permission card).
// Run: node scripts/test-acp-harness.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const WRAPPER = path.join(REPO, 'data/bin/acp-wrapper.js');
const MOCK = path.join(REPO, 'scripts/dev/mock-acp-agent.mjs');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 400) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The suite runs INSIDE a VibeSpace session on the dev box: strip the agent
// env so the wrapper never calls the real prompt-context/stop-check API.
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^VIBESPACE_|^ACP_WEBUI_|^CLAUDE_CODE_/.test(k)) delete CLEAN_ENV[k];

function startWrapper({ env = {}, dir } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acp-'));
  const buf = path.join(dir, 's.buf'), meta = path.join(dir, 's.json'), mockLog = path.join(dir, 'mock.log');
  const child = spawn(process.execPath, [WRAPPER, buf, meta, process.execPath, MOCK], { env: { ...CLEAN_ENV, ACP_WEBUI_CWD: dir, ACP_WEBUI_BACKEND: 'opencode', MOCK_ACP_LOG: mockLog, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { dir, buf, meta, mockLog, child, records: [], acks: 0, stderr: '', sent: 0, exited: null };
  let lb = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    lb += d; let i;
    while ((i = lb.indexOf('\n')) !== -1) {
      const line = lb.slice(0, i).trim(); lb = lb.slice(i + 1);
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.type === '_stdin_ack') h.acks++; else h.records.push(r); } catch { h.records.push({ type: 'raw', line }); }
    }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { h.stderr += d; });
  child.on('exit', (code, sig) => { h.exited = { code, sig }; });
  h.send = (o) => { h.sent++; child.stdin.write(JSON.stringify(o) + '\n'); };
  h.find = (kind, pred = () => true) => h.records.find((r) => r.type === 'acp' && r.kind === kind && pred(r));
  h.findAll = (kind, pred = () => true) => h.records.filter((r) => r.type === 'acp' && r.kind === kind && pred(r));
  h.updates = (su) => h.records.filter((r) => r.type === 'acp' && r.kind === 'update' && r.update?.sessionUpdate === su);
  h.waitFor = async (pred, ms = 8000, what = 'condition') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(20); } throw new Error(`timeout waiting for ${what} (records: ${h.records.map((r) => r.kind || r.type).join(',')}; stderr: ${h.stderr.slice(-300)})`); };
  h.mockCalls = () => { try { return fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  h.metaJson = () => { try { return JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { return null; } };
  h.stop = async () => { try { child.kill('SIGTERM'); } catch {} await sleep(150); };
  return h;
}

let firstSessionId = null, historyRecords = null;
console.log('— wrapper vs mock ACP agent: new session');
{
  const w = startWrapper();
  try {
    const ses = await w.waitFor(() => w.find('session'), 10000, 'session record');
    firstSessionId = ses.sessionId;
    ok('session/new → `session` record with the agent id, how:new, cwd, agent info + capabilities', /^ses_mock_/.test(ses.sessionId) && ses.how === 'new' && ses.cwd === w.dir && ses.agentInfo?.name === 'mock-acp' && ses.capabilities?.loadSession === true && ses.protocolVersion === 1, ses);
    ok('…carries the agent\'s offered models + current model/mode (config options flattened)', Array.isArray(ses.models) && ses.models.map((m) => m.id).join(',') === 'mock/fast,mock/smart' && ses.model === 'mock/fast' && ses.mode === 'build' && ses.modeValues.join(',') === 'build,plan', ses.models);
    const init = w.mockCalls().find((c) => c.method === 'initialize');
    ok('initialize advertises protocolVersion 1 and NO fs/terminal capabilities (we never implement them)', init?.params?.protocolVersion === 1 && init.params.clientCapabilities?.fs?.readTextFile === false && init.params.clientCapabilities?.terminal === false && init.params.clientInfo?.name === 'vibespace', init?.params);
    await w.waitFor(() => w.updates('available_commands_update').length, 3000, 'available_commands_update');
    ok('the agent\'s available_commands_update is journaled as an `update` record', w.updates('available_commands_update')[0].update.availableCommands.map((c) => c.name).join(',') === 'review,plan');
    await sleep(300); // sidecar meta debounce
    const m = w.metaJson();
    ok('sidecar meta (the capability gate\'s ONLY source): mode chat, backend, sessionId, caps.frameFile, agent info, commands, model', m?.mode === 'chat' && m.backend === 'opencode' && m.sessionId === ses.sessionId && m.caps?.frameFile === true && m.caps.peerMessage === false && m.acp?.agentInfo?.name === 'mock-acp' && m.availableCommands?.length === 2 && m.model === 'mock/fast' && m.streaming === false, m);

    // ── prompt → permission → completion ──
    w.send({ type: 'chat-input', text: 'please read the file', msgId: 'u1' });
    const user = await w.waitFor(() => w.find('user', (r) => r.msgId === 'u1'), 3000, 'user record');
    ok('chat-input → `user` record (msgId + content blocks) BEFORE the prompt goes out', user.content?.[0]?.text === 'please read the file' && user.peer === null);
    const ps = await w.waitFor(() => w.find('prompt_start'), 3000, 'prompt_start');
    ok('prompt_start marks the turn (streaming on)', /^p1-/.test(ps.promptId) && ps.blocks === 1);
    const perm = await w.waitFor(() => w.find('permission_request'), 5000, 'permission_request');
    ok('agent → session/request_permission journaled with the tool call + ORDERED options (kinds)', perm.toolCall?.toolCallId === perm.toolCall?.toolCallId && perm.options?.map((o) => o.kind).join(',') === 'allow_once,allow_always,reject_once' && perm.options.map((o) => o.optionId).join(',') === 'once,always,no', perm);
    ok('…the tool_call update preceded it (kind read, title, rawInput, locations)', w.updates('tool_call').length === 1 && w.updates('tool_call')[0].update.kind === 'read' && w.updates('tool_call')[0].update.rawInput?.path === '/repo/README.md');
    const promptCall = w.mockCalls().find((c) => c.method === 'session/prompt');
    ok('session/prompt carries the text block verbatim (no context prefix without VIBESPACE_API)', promptCall?.params?.sessionId === ses.sessionId && promptCall.params.prompt.length === 1 && promptCall.params.prompt[0].text === 'please read the file', promptCall?.params);
    await sleep(250);
    const mMid = w.metaJson();
    ok('sidecar meta mid-turn: streaming true + the pending request recorded', mMid?.streaming === true && mMid.activePromptId === ps.promptId && Object.keys(mMid.pendingRequests || {}).length === 1, mMid);
    w.send({ type: 'permission-response', requestId: perm.requestId, approved: true, optionId: 'once' });
    const res = await w.waitFor(() => w.find('permission_resolved'), 3000, 'permission_resolved');
    ok('permission-response (explicit optionId) → the request is answered with that option', res.outcome === 'selected' && res.optionId === 'once' && res.optionKind === 'allow_once', res);
    const end = await w.waitFor(() => w.find('prompt_end'), 5000, 'prompt_end');
    ok('the turn completes: tool_call_update completed (content), plan, agent text, usage_update, prompt_end end_turn', end.stopReason === 'end_turn' && end.error === null && w.updates('tool_call_update').some((u) => u.update.status === 'completed') && w.updates('plan').length === 2 && w.updates('usage_update').length === 1 && w.updates('agent_message_chunk').some((u) => /Done \(once\)/.test(u.update.content?.text || '')), end);
    ok('every stdin line got its _stdin_ack (the server\'s broken-pty detector)', w.acks === w.sent, { acks: w.acks, sent: w.sent });
    await sleep(250);
    ok('sidecar meta after the turn: streaming false, todos from the plan, usage recorded', w.metaJson()?.streaming === false && w.metaJson().todos?.length === 2 && w.metaJson().usage?.used === 1234, w.metaJson());

    // ── deny via approved:false (no optionId) → reject kind ──
    w.send({ type: 'chat-input', text: 'edit it now', msgId: 'u2' });
    const perm2 = await w.waitFor(() => w.findAll('permission_request').length === 2 && w.findAll('permission_request')[1], 5000, 'second permission_request');
    w.send({ type: 'permission-response', requestId: perm2.requestId, approved: false });
    const end2 = await w.waitFor(() => w.findAll('prompt_end').length === 2 && w.findAll('prompt_end')[1], 5000, 'second prompt_end');
    const res2 = w.findAll('permission_resolved')[1];
    ok('permission-response approved:false (no optionId) picks the reject option by kind', res2?.optionId === 'no' && res2.optionKind === 'reject_once', res2);
    ok('…the agent sees the rejection: tool_call_update failed + its "not doing that" text, end_turn', end2.stopReason === 'end_turn' && w.updates('tool_call_update').some((u) => u.update.status === 'failed') && w.updates('agent_message_chunk').some((u) => /not doing that/.test(u.update.content?.text || '')));
    ok('an edit tool call arrives with kind edit (renderer maps it to a write-fold card)', w.updates('tool_call')[1]?.update.kind === 'edit');

    // ── interrupt: session/cancel + cancelled stop reason ──
    w.send({ type: 'chat-input', text: 'slow run it', msgId: 'u3' });
    await w.waitFor(() => w.findAll('prompt_start').length === 3, 3000, 'third prompt_start');
    await sleep(100);
    w.send({ type: 'interrupt' });
    const end3 = await w.waitFor(() => w.findAll('prompt_end').length === 3 && w.findAll('prompt_end')[2], 8000, 'third prompt_end');
    ok('interrupt → session/cancel notification; the prompt resolves with stopReason cancelled', end3.stopReason === 'cancelled' && w.mockCalls().some((c) => c.method === 'session/cancel'), end3);

    // ── config verbs ──
    w.send({ type: 'set-model', model: 'mock/smart' });
    const cfg = await w.waitFor(() => w.find('config', (r) => r.source === 'set:model'), 3000, 'config set:model');
    ok('set-model → session/set_config_option on the model category; `config` record carries the new model', cfg.model === 'mock/smart' && w.find('notice', (r) => /Model → mock\/smart/.test(r.text)), cfg);
    w.send({ type: 'set-model', model: 'bogus/model' });
    const rej = await w.waitFor(() => w.find('notice', (r) => r.noticeKind === 'rejected'), 3000, 'rejected notice');
    ok('a model the agent rejects → LOUD notice naming the offered models (never a silent no-op)', /rejected by the agent/.test(rej.text) && /mock\/fast/.test(rej.text), rej);
    w.send({ type: 'set-permission-mode', mode: 'plan' });
    const cfg2 = await w.waitFor(() => w.find('config', (r) => r.source === 'set:mode'), 3000, 'config set:mode');
    ok('set-permission-mode → the mode config option; agent echoes current_mode_update', cfg2.mode === 'plan' && w.updates('current_mode_update').some((u) => u.update.modeId === 'plan'), cfg2);
    w.send({ type: 'set-effort', effort: 'high' });
    const uns = await w.waitFor(() => w.find('notice', (r) => r.noticeKind === 'unsupported' && /effort/.test(r.text)), 3000, 'unsupported notice');
    ok('set-effort on an agent without a thought_level option → explicit unsupported notice', /reasoning-effort/.test(uns.text));
    w.send({ type: 'bogus-verb' });
    await w.waitFor(() => w.find('notice', (r) => r.noticeKind === 'unknown-verb'), 3000, 'unknown-verb notice');
    ok('an unknown stdin verb is refused loudly', true);

    // ── fs request from the agent → refused cleanly ──
    w.send({ type: 'chat-input', text: 'use fs please', msgId: 'u4' });
    const end4 = await w.waitFor(() => w.findAll('prompt_end').length === 4 && w.findAll('prompt_end')[3], 5000, 'fourth prompt_end');
    const creq = w.find('client_request');
    ok('agent → fs/read_text_file is answered with a JSON-RPC error (unsupported) and journaled; the turn still completes', creq?.method === 'fs/read_text_file' && creq.replied === 'unsupported' && end4.stopReason === 'end_turn' && w.updates('agent_message_chunk').some((u) => /fs refused/.test(u.update.content?.text || '')), creq);

    // ── frame file pointer ──
    const fp = path.join(w.dir, 'frame.json');
    fs.writeFileSync(fp, JSON.stringify({ type: 'chat-input', text: 'read via frame', msgId: 'u5' }));
    w.send({ type: '_frame_file', path: fp });
    const u5 = await w.waitFor(() => w.find('user', (r) => r.msgId === 'u5'), 3000, 'frame-file user record');
    ok('_frame_file pointer → the frame is read, unlinked, and handled as chat-input', u5.content[0].text === 'read via frame' && !fs.existsSync(fp));
    // permission_requests so far: u1, u2 (the slow prompt was cancelled before its request; the fs prompt asks none) → the frame prompt's is the 3rd
    const perm5 = await w.waitFor(() => w.findAll('permission_request').length === 3 && w.findAll('permission_request')[2], 5000, 'frame prompt permission');
    w.send({ type: 'permission-response', requestId: perm5.requestId, approved: true, alwaysAllow: true });
    await w.waitFor(() => w.findAll('prompt_end').length === 5, 5000, 'fifth prompt_end');
    ok('approved + alwaysAllow (no optionId) prefers the allow_always option', w.findAll('permission_resolved')[2]?.optionId === 'always');
    fs.writeFileSync(path.join(w.dir, 'bad.json'), '{not json');
    w.send({ type: '_frame_file', path: path.join(w.dir, 'bad.json') });
    const lost = await w.waitFor(() => w.find('notice', (r) => r.noticeKind === 'lost-input'), 3000, 'lost-input notice');
    ok('a corrupt frame file → lost-input notice (the user is told to resend), file unlinked', /did not reach the agent/.test(lost.text) && !fs.existsSync(path.join(w.dir, 'bad.json')));
    w.child.stdin.write('this is not json\n');
    await w.waitFor(() => w.findAll('notice', (r) => r.noticeKind === 'lost-input').length === 2, 3000, 'second lost-input');
    ok('an unparseable stdin line is refused loudly (never silently dropped)', true);

    // ── peer message ──
    w.send({ type: 'peer-message', text: 'ping from B', fromName: 'B', cardText: 'B says hi' });
    // the peer prompt runs a full mock turn (with a permission request) before peer_result lands
    await w.waitFor(() => w.findAll('permission_request').length === 4, 5000, 'peer prompt permission');
    w.send({ type: 'permission-response', requestId: w.findAll('permission_request')[3].requestId, approved: true });
    const pr = await w.waitFor(() => w.find('peer_result'), 8000, 'peer_result');
    await w.waitFor(() => w.findAll('prompt_end').length === 6, 5000, 'sixth prompt_end');
    const pu = w.find('user', (r) => r.peer);
    ok('peer-message → a `user` record with the peer envelope + a prompt prefixed "Message from B:" + peer_result ok', pr.ok === true && pu?.peer?.name === 'B' && pu.peer.body === 'B says hi' && w.mockCalls().some((c) => c.method === 'session/prompt' && /^Message from B:\nping from B/.test(c.params.prompt[0]?.text || '')), pr);

    await sleep(1200); // buffer persist debounce
    historyRecords = w.records.filter((r) => r.type === 'acp');
    const bufRecs = fs.readFileSync(w.buf, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // the mock's available_commands_update can land BEFORE the session/new reply resolves (microtask order) — compare the SEQUENCE, not a fixed first record
    ok('the buffer file mirrors the stdout journal (history survives a server restart)', bufRecs.length === historyRecords.length && bufRecs.map((r) => r.kind).join() === historyRecords.map((r) => r.kind).join(), { buf: bufRecs.length, out: historyRecords.length });
  } finally { await w.stop(); }
}

console.log('— resume (session/load replay)');
{
  const w = startWrapper({ env: { ACP_WEBUI_RESUME_ID: firstSessionId, ACP_WEBUI_MODEL: 'mock/smart', ACP_WEBUI_MODE: 'plan' } });
  try {
    const ses = await w.waitFor(() => w.find('session'), 10000, 'session record');
    ok('ACP_WEBUI_RESUME_ID + loadSession capability → session/load, how:load, the SAME session id', ses.how === 'load' && ses.sessionId === firstSessionId && w.mockCalls().some((c) => c.method === 'session/load' && c.params.sessionId === firstSessionId), ses);
    ok('replayed history updates are tagged replay:true (user + agent chunks + an old tool call)', w.updates('user_message_chunk').some((u) => u.replay === true) && w.updates('agent_message_chunk').some((u) => u.replay === true) && w.updates('tool_call').some((u) => u.replay === true));
    await w.waitFor(() => w.find('config', (r) => r.source === 'set:model') && w.find('config', (r) => r.source === 'set:mode'), 5000, 'initial model/mode applied');
    ok('initial model + mode from env are applied right after the session is up', w.find('config', (r) => r.source === 'set:model').model === 'mock/smart' && w.find('config', (r) => r.source === 'set:mode').mode === 'plan');
  } finally { await w.stop(); }
}

console.log('— Stop means stop (the cancel race + the local queue)');
{
  // The prompt-context round trip is a REAL http call the wrapper awaits AFTER
  // it has already claimed the turn. This server holds the response until the
  // test releases it, so the "Stop lands mid-await" window is deterministic.
  let release = null, hits = 0;
  const ctxSrv = http.createServer((req, res) => { hits++; release = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ context: 'task ctx' })); }; });
  await new Promise((r) => ctxSrv.listen(0, '127.0.0.1', r));
  const w = startWrapper({ env: { VIBESPACE_API: `http://127.0.0.1:${ctxSrv.address().port}`, VIBESPACE_SESSION_TOKEN: 'vsst_test' } });
  try {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    w.send({ type: 'chat-input', text: 'please read the file', msgId: 'c1' });
    await w.waitFor(() => hits === 1, 5000, 'prompt-context request');   // the turn is claimed, the await is open
    w.send({ type: 'interrupt' });                                        // ← Stop, mid-await
    await w.waitFor(() => w.find('prompt_end'), 5000, 'prompt_end');
    release();
    await sleep(400);
    ok('Stop during the context round trip: NOTHING reaches the agent — no session/prompt, and no session/cancel for a turn it never saw (a latched cancel would eat the NEXT turn)', !w.mockCalls().some((c) => c.method === 'session/prompt' || c.method === 'session/cancel'), w.mockCalls().map((c) => c.method));
    ok('…and the turn ends honestly: prompt_end cancelled, no prompt_start, streaming cleared in the sidecar', w.findAll('prompt_end').length === 1 && w.find('prompt_end').stopReason === 'cancelled' && !w.find('prompt_start') && w.metaJson()?.streaming === false && w.metaJson()?.activePromptId === null, { ends: w.findAll('prompt_end'), meta: w.metaJson() });
    // POSITIVE CONTROL: the same path with no Stop still prefixes the context
    hits = 0;
    w.send({ type: 'chat-input', text: 'please read the file', msgId: 'c2' });
    await w.waitFor(() => hits === 1, 5000, 'second prompt-context request');
    release();
    const ps = await w.waitFor(() => w.find('prompt_start'), 5000, 'prompt_start');
    const call = w.mockCalls().find((c) => c.method === 'session/prompt');
    ok('positive control: without a Stop the same prompt goes out WITH the <vibespace-context> prefix', !!call && call.params.prompt.length === 2 && /<vibespace-context>\ntask ctx/.test(call.params.prompt[0].text) && ps.blocks === 2, call?.params?.prompt?.map((b) => b.text?.slice(0, 30)));
    const perm = await w.waitFor(() => w.find('permission_request'), 5000, 'permission_request');
    w.send({ type: 'permission-response', requestId: perm.requestId, approved: true, optionId: 'once' });
    await w.waitFor(() => w.findAll('prompt_end').length === 2, 5000, 'second prompt_end');
  } finally { await w.stop(); ctxSrv.close(); }
}
{
  const w = startWrapper();
  try {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    w.send({ type: 'chat-input', text: 'slow run it', msgId: 'q1' });     // the mock holds this turn 3s
    await w.waitFor(() => w.find('prompt_start'), 5000, 'prompt_start');
    w.send({ type: 'chat-input', text: 'please read the file', msgId: 'q2' });
    // the queued state is a `queued_input` record (→ a chip on the bubble),
    // not a system card — codex parity, one client path for both harnesses
    await w.waitFor(() => w.find('queued_input', (r) => r.msg_id === 'q2'), 3000, 'queued_input');
    w.send({ type: 'peer-message', text: 'ping from B', fromName: 'B' });  // queues too (silently)
    await w.waitFor(() => w.find('peer_result', (r) => r.mode === 'queued'), 3000, 'queued peer_result');
    // A VIBESPACE NOTIFICATION (2026-09-07): on codex a busy one is STEERED
    // into the running turn (turn/steer). ACP v1 has NO steer method —
    // session/prompt is one-at-a-time, which is why opencode's queueVerbs omit
    // 'steer' — so it QUEUES here, and the result SAYS the steer was
    // unavailable rather than accepting the tag and ignoring it (2.361.4 law).
    w.send({ type: 'peer-message', text: '[VibeSpace Background Work] task "nightly" (job-1): done.', fromName: 'Background Work · nightly', kind: 'notification' });
    const notifRes = await w.waitFor(() => w.find('peer_result', (r) => r.steer === 'unsupported'), 3000, 'notification peer_result');
    ok("a busy VibeSpace NOTIFICATION queues here and says the steer was unavailable (ACP v1 has no steer verb — codex steers, this harness cannot)", notifRes.ok === true && notifRes.mode === 'queued' && notifRes.steer === 'unsupported', notifRes);
    ok('…and it really is queued (nothing is dropped by the tag)', w.mockCalls().filter((c) => c.method === 'session/prompt').length === 1, w.mockCalls().map((c) => c.method).join(','));
    w.send({ type: 'interrupt' });
    await w.waitFor(() => w.find('prompt_end'), 8000, 'prompt_end');
    await sleep(1500); // long enough for a drained queue prompt to reach the agent
    ok('Stop with messages queued behind the turn: the queue is DROPPED — one prompt on the wire, one prompt_start, one cancelled prompt_end', w.mockCalls().filter((c) => c.method === 'session/prompt').length === 1 && w.findAll('prompt_start').length === 1 && w.findAll('prompt_end').length === 1 && w.find('prompt_end').stopReason === 'cancelled', { wire: w.mockCalls().map((c) => c.method), starts: w.findAll('prompt_start').length, ends: w.findAll('prompt_end').map((e) => e.stopReason) });
    const cleared = w.find('notice', (r) => r.noticeKind === 'queue-cleared');
    ok('…the drop is LOUD and counts what was dropped (never a silent discard)', !!cleared && /dropped 1 queued message —/.test(cleared.text), cleared);
    // B-7638: the PEER entry dropped alongside it is NOT the user's to re-send.
    // It goes straight back to the delivery ladder (peer_result ok:false, below)
    // and arrives again on its own, so counting it here told the user to
    // re-send a message they never sent and could not reach.
    ok('…and a dropped PEER message is not counted in the "send it again" hint (it returns via the delivery ladder, the user never sent it)', !/2 queued/.test(cleared?.text || '') && !/queued messages/.test(cleared?.text || ''), cleared);
    const pr = w.findAll('peer_result');
    const dropped = pr.filter((r) => r.ok === false);
    ok('…a dropped PEER message goes back to the delivery ladder (peer_result ok:false with its text — the consumer re-stashes it)', dropped.some((r) => r.text === 'ping from B' && r.fromName === 'B' && /Stop/.test(r.reason || '')), pr);
    ok('…and so does the dropped NOTIFICATION (a promised message is a promised message, whoever sent it)', dropped.some((r) => /Background Work/.test(r.fromName || '') && /Stop/.test(r.reason || '')), dropped);
    // THE BUBBLES must say REMOVED, not go blank. The normalizer clears the
    // chip of anything that leaves the queue with no explicit result — that
    // reads as "it ran", the opposite of what Stop did (round-1 review). So
    // each dropped entry gets its own removal result BEFORE the republish.
    {
      const rms = w.findAll('queue_op_result', (r) => r.op === 'remove' && r.ok === true);
      ok("…each dropped bubble is told it was REMOVED (a cleared chip would claim the message RAN)", rms.length === 3 && rms.some((r) => r.msg_id === 'q2') && rms.every((r) => r.reason === 'stopped'), rms);
      const at = (pred) => w.records.map((r, i) => [r, i]).filter(([r]) => r.type === 'acp' && pred(r)).slice(-1)[0]?.[1] ?? -1;
      const lastRm = at((r) => r.kind === 'queue_op_result');
      const emptyQ = at((r) => r.kind === 'queue_changed' && (r.items || []).length === 0);
      ok('…and the removals are recorded BEFORE the emptied queue is republished (order is the whole fix)', lastRm >= 0 && emptyQ > lastRm, { lastRm, emptyQ });
    }
    ok('…and the session stays usable: streaming cleared, no pending permission left', w.metaJson()?.streaming === false && Object.keys(w.metaJson()?.pendingRequests || {}).length === 0, w.metaJson());
  } finally { await w.stop(); }
}

console.log('— the input queue: published, removable, order-preserving (no steer in ACP v1)');
{
  const w = startWrapper();
  try {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    w.send({ type: 'chat-input', text: 'slow run it', msgId: 'qa' });     // the mock holds this turn 3s
    await w.waitFor(() => w.find('prompt_start'), 5000, 'prompt_start');
    w.send({ type: 'chat-input', text: 'first queued', msgId: 'qb' });
    w.send({ type: 'chat-input', text: 'second queued', msgId: 'qc' });
    const last = () => w.findAll('queue_changed').slice(-1)[0];
    await w.waitFor(() => last()?.items?.length === 2, 4000, 'two queued');
    ok('the ACP wrapper PUBLISHES its promptQueue the way codex publishes the app-server\'s (one client path, a capability row apart)',
      last().items.map((i) => i.msgId).join(',') === 'qb,qc' && last().items[0].preview === 'first queued' && last().items.every((i) => i.id && i.kind === 'user'), last().items);
    // steer is denied by the CAPS row before it leaves the browser; a frame that
    // reaches the wrapper anyway is REFUSED with a reason, never silently dropped
    w.send({ type: 'queue-op', op: 'steer', id: last().items[0].id });
    const refused = await w.waitFor(() => w.find('queue_op_result', (r) => r.op === 'steer'), 3000, 'steer refusal');
    ok('a steer that reaches an ACP wrapper is refused with reason not-steerable (ACP v1 has no steer)', refused.ok === false && refused.reason === 'not-steerable', refused);
    ok('…and the queue is untouched by the refusal', last().items.length === 2, last().items);
    // run-now / run-all are declared FALSE for this harness for a STRUCTURAL
    // reason (the queue only exists while a prompt runs), so a frame that
    // reaches the wrapper anyway must say that, not "unknown op".
    w.send({ type: 'queue-op', op: 'run-now', id: last().items[0].id });
    const notStartable = await w.waitFor(() => w.find('queue_op_result', (r) => r.op === 'run-now'), 3000, 'run-now refusal');
    ok('run-now on an ACP harness is refused with the structural reason (one prompt at a time — it starts as soon as this one ends)', notStartable.ok === false && notStartable.reason === 'not-startable' && /one prompt at a time/.test(notStartable.detail || ''), notStartable);

    // REORDER: a local array splice, driven by the SAME relative frame the
    // codex wrapper translates into a full-order array.
    {
      const ids = last().items.map((i) => i.id);
      w.send({ type: 'queue-op', op: 'reorder', id: ids[0], afterId: ids[1] });
      const r = await w.waitFor(() => w.find('queue_op_result', (r) => r.op === 'reorder'), 3000, 'reorder result');
      ok('reorder moves the entry behind its anchor and reports ok', r.ok === true && r.msg_id === 'qb', r);
      await w.waitFor(() => last().items.map((i) => i.msgId).join(',') === 'qc,qb', 3000, 'reordered');
      ok('…and the republished queue is the new order (the strip renders it)', last().items.map((i) => i.msgId).join(',') === 'qc,qb', last().items.map((i) => i.msgId));
      w.send({ type: 'queue-op', op: 'reorder', id: last().items[0].id, afterId: null });
      await w.waitFor(() => w.findAll('queue_op_result', (r) => r.op === 'reorder').length === 2, 3000, 'front move');
      ok('afterId null means the FRONT (already there ⇒ still ok, still published)', last().items.map((i) => i.msgId).join(',') === 'qc,qb', last().items.map((i) => i.msgId));
      w.send({ type: 'queue-op', op: 'reorder', id: last().items[0].id, afterId: 'no-such-entry' });
      const anchorGone = await w.waitFor(() => w.findAll('queue_op_result', (r) => r.op === 'reorder').slice(-1)[0]?.reason === 'anchor-gone' ? w.findAll('queue_op_result', (r) => r.op === 'reorder').slice(-1)[0] : null, 3000, 'anchor-gone');
      ok('an anchor that is no longer queued moves NOTHING and says why', anchorGone.ok === false, anchorGone);
      ok('…and the entry really is back where it was (a failed move must not eat the row)', last().items.map((i) => i.msgId).join(',') === 'qc,qb', last().items.map((i) => i.msgId));
      // put the order back so the drain assertions below read as written
      w.send({ type: 'queue-op', op: 'reorder', id: last().items.find((i) => i.msgId === 'qb').id, afterId: null });
      await w.waitFor(() => last().items.map((i) => i.msgId).join(',') === 'qb,qc', 3000, 'order restored');
    }
    // EDIT: the same exclusion rule, on ACP content blocks.
    {
      const target = last().items.find((i) => i.msgId === 'qb');
      ok('a queued entry carries its FULL text, so the edit control opens the message and not a truncated preview', target.text === 'first queued', target);
      w.send({ type: 'queue-op', op: 'edit', id: target.id, text: 'first queued, rewritten' });
      const e = await w.waitFor(() => w.find('queue_op_result', (r) => r.op === 'edit'), 3000, 'edit result');
      ok('edit rewrites the queued text and reports ok', e.ok === true && e.msg_id === 'qb', e);
      await w.waitFor(() => (last().items.find((i) => i.msgId === 'qb')?.preview || '').includes('rewritten'), 3000, 'edited preview');
      ok('…and the republished strip shows the new words', /rewritten/.test(last().items.find((i) => i.msgId === 'qb').preview), last().items);
      const emptyEdit = (() => { w.send({ type: 'queue-op', op: 'edit', id: target.id, text: '   ' }); return true; })();
      const refusedEdit = await w.waitFor(() => w.findAll('queue_op_result', (r) => r.op === 'edit').slice(-1)[0]?.ok === false ? w.findAll('queue_op_result', (r) => r.op === 'edit').slice(-1)[0] : null, 3000, 'empty edit refused');
      ok('an empty edit is refused (blanking a queued message is not an edit)', emptyEdit && refusedEdit.reason === 'empty-text', refusedEdit);
    }
    // remove the FIRST: the second keeps its relative order and is what runs
    const firstId = last().items[0].id;
    w.send({ type: 'queue-op', op: 'remove', id: firstId });
    const rm = await w.waitFor(() => w.find('queue_op_result', (r) => r.op === 'remove'), 3000, 'remove result');
    ok('remove takes the named entry out and names the bubble it belonged to', rm.ok === true && rm.msg_id === 'qb', rm);
    await w.waitFor(() => last().items.length === 1 && last().items[0].msgId === 'qc', 3000, 'one left');
    // removing a GONE id is reported honestly, never a fake success
    w.send({ type: 'queue-op', op: 'remove', id: firstId });
    const gone = await w.waitFor(() => w.findAll('queue_op_result', (r) => r.op === 'remove').slice(-1)[0]?.ok === false ? w.findAll('queue_op_result', (r) => r.op === 'remove').slice(-1)[0] : null, 3000, 'gone result');
    ok('removing an entry that is already gone says so (no fake success)', gone.reason === 'gone', gone);
    // the turn ends → the survivor drains, in order (the mock asks permission
    // before finishing every prompt; answering it is what ENDS the turn)
    const perm = await w.waitFor(() => w.find('permission_request'), 6000, 'permission_request');
    w.send({ type: 'permission-response', requestId: perm.requestId, approved: true, optionId: 'once' });
    await w.waitFor(() => w.findAll('prompt_start').length === 2, 8000, 'the queued prompt ran');
    const wire = JSON.stringify(w.mockCalls().filter((c) => c.method === 'session/prompt'));
    ok('drain order: the removed entry NEVER reaches the agent, the survivor does', wire.includes('second queued') && !wire.includes('first queued'), wire.slice(0, 200));
    ok('…and the EDIT really changed what the agent would have received (the rewritten words never ran because that entry was removed, and its original text is nowhere on the wire)', !wire.includes('first queued'), wire.slice(0, 200));
    await w.waitFor(() => last().items.length === 0, 3000, 'queue empty');
    ok('…and the emptied queue is published (the strip clears)', last().items.length === 0);
  } finally { await w.stop(); }
}

console.log('— the ACP wrapper adverts the queue verbs it serves');
{
  const w = startWrapper();
  try {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    await w.waitFor(() => w.findAll('queue_changed').length > 0, 5000, 'a baseline queue publication');
    const verbs = ['remove', 'reorder', 'edit'];
    ok('every queue_changed carries the verb list in-band (the only advert a remote session sees)', w.findAll('queue_changed').every((q) => JSON.stringify(q.verbs) === JSON.stringify(verbs)), w.findAll('queue_changed').slice(-1)[0]?.verbs);
    const meta = w.metaJson();
    ok('…and the sidecar adverts the same list (what a LOCAL server reads)', JSON.stringify(meta?.caps?.queueVerbs) === JSON.stringify(verbs), meta?.caps);
    const { capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
    ok('…which is exactly the harness caps row (a wrapper that served less would be refused those verbs, not silently drop them)', JSON.stringify(capsOf('opencode').inputModes.queueVerbs) === JSON.stringify(verbs), capsOf('opencode').inputModes.queueVerbs);
  } finally { await w.stop(); }
}

console.log('— the stop-time bookkeeping nudge survives a Stop that drops it from the queue');
{
  // The nudge is FETCHED by endPrompt (a /api/agent/stop-check round trip) and
  // dispatched only when the answer lands — by then drainPromptQueue has usually
  // started the next turn, so the nudge itself goes into the LOCAL QUEUE. A Stop
  // drops that queue, and the drop used to strand `nudgeTurnActive` at true
  // (only the nudge's OWN endPrompt clears it, which a dropped queue entry never
  // reaches): every later end_turn then took the `!nudgeTurnActive` branch and
  // the session never nudged again — the bookkeeping reminder was gone for good.
  let stopChecks = 0;
  const api = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // "fs" in the reason puts the mock on its fs branch, so the nudge turn needs
    // no permission and ends by itself.
    if (String(req.url).startsWith('/api/agent/stop-check')) { stopChecks++; res.end(JSON.stringify({ block: true, reason: 'fs — report your progress with vibespace-task' })); }
    else res.end(JSON.stringify({ context: '' }));   // prompt-context: no prefix, so the wire stays readable
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const ENV = { VIBESPACE_API: `http://127.0.0.1:${api.address().port}`, VIBESPACE_SESSION_TOKEN: 'vsst_test' };
  const reminders = (w) => w.mockCalls().filter((c) => c.method === 'session/prompt' && JSON.stringify(c.params?.prompt || []).includes('vibespace-reminder'));
  const queued = (w) => w.findAll('queued_input');
  // The nudge is ours: it rides the queue (kind 'system', so the strip is
  // honest about what is waiting) but emits NO `queued_input` — that record is
  // what paints a "Queued" card on a bubble the user sent, and there is no such
  // bubble here (B-7638; peer messages already queue silentQueue for the same
  // reason).
  const nudgeInQueue = (w) => w.findAll('queue_changed').some((r) => (r.items || []).some((i) => i.kind === 'system'));
  // bounded wait that never throws: a regression must read as a FAILED ASSERT
  // (with its counters), not as an exception that kills the rest of the suite.
  const settle = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(20); } return false; };
  // drives a wrapper into the exact state the bug needs: a nudge sitting in the
  // local queue behind a running turn.
  async function nudgeIntoQueue(w) {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    w.send({ type: 'chat-input', text: 'slow read it', msgId: 'n1' });            // turn A
    const perm = await w.waitFor(() => w.find('permission_request'), 8000, 'permission_request A');
    w.send({ type: 'chat-input', text: 'slow read it again', msgId: 'n2' });      // queues behind turn A
    await w.waitFor(() => queued(w).length === 1, 3000, 'the user message queued');
    w.send({ type: 'permission-response', requestId: perm.requestId, approved: true, optionId: 'once' });
    await w.waitFor(() => w.find('prompt_end', (r) => r.stopReason === 'end_turn'), 8000, 'turn A end_turn');
    await w.waitFor(() => nudgeInQueue(w), 8000, 'the nudge queued behind the drained turn');
  }
  const w = startWrapper({ env: ENV });
  try {
    await nudgeIntoQueue(w);
    ok('a stop-time nudge whose turn is already taken goes into the LOCAL QUEUE (stop-check answered, nothing on the wire yet)', stopChecks === 1 && reminders(w).length === 0 && nudgeInQueue(w), { stopChecks, prompts: w.mockCalls().filter((c) => c.method === 'session/prompt').length });
    ok('…and it queues SILENTLY: one `queued_input` for the ONE message the user queued, none for our bookkeeping nudge (it would paint a "Queued" card with no bubble behind it)', queued(w).length === 1 && queued(w)[0].msg_id === 'n2', queued(w));
    w.send({ type: 'interrupt' });                                               // ← Stop drops the QUEUED nudge
    await w.waitFor(() => w.find('prompt_end', (r) => r.stopReason === 'cancelled'), 8000, 'the running turn ends cancelled');
    await sleep(300);
    ok('…Stop drops it without sending it, and never tells the user to re-send a message they did not queue (the nudge is ours, not theirs)', reminders(w).length === 0 && !w.find('notice', (r) => r.noticeKind === 'queue-cleared'), { reminders: reminders(w).length, cleared: w.find('notice', (r) => r.noticeKind === 'queue-cleared') });
    w.send({ type: 'chat-input', text: 'fs check', msgId: 'n3' });                // a later turn that ends end_turn
    const again = await settle(() => stopChecks === 2 && reminders(w).length === 1);
    ok('THE FIX: the dropped queue entry takes its latch with it — the NEXT completed turn asks stop-check again and the reminder goes out (before: nudgeTurnActive stayed true for the rest of the session)', again && /vibespace-reminder>fs/.test(JSON.stringify(reminders(w)[0]?.params?.prompt || '')), { stopChecks, reminders: reminders(w).length, ends: w.findAll('prompt_end').map((e) => e.stopReason) });
  } finally { await w.stop(); }

  // CONTROL — the same setup with NO Stop: the queued nudge runs, and the turn
  // it waited behind must NOT fetch a second one. Green both before and after
  // the fix: it proves the harness sees nudges at all, and that the fix is about
  // the dropped entry rather than about deleting the latch (a wrapper that reset
  // nudgeTurnActive on every turn would double-nudge here).
  stopChecks = 0;
  const c = startWrapper({ env: ENV });
  try {
    await nudgeIntoQueue(c);
    const permB = await c.waitFor(() => c.findAll('permission_request')[1], 8000, 'permission_request B');
    c.send({ type: 'permission-response', requestId: permB.requestId, approved: true, optionId: 'once' });
    const ran = await settle(() => reminders(c).length === 1 && c.findAll('prompt_end').length === 3, 12000);
    ok('control: with no Stop the queued nudge RUNS after the turn it waited for, and that turn\'s own end_turn does not queue a second nudge (the latch holds)', ran && stopChecks === 1 && reminders(c).length === 1, { stopChecks, reminders: reminders(c).length, ends: c.findAll('prompt_end').map((e) => e.stopReason) });
    await sleep(600);
    ok('negative control: the nudge turn\'s own end_turn does NOT nudge again — one reminder, one stop-check, no reminder loop', stopChecks === 1 && reminders(c).length === 1 && c.findAll('prompt_end').length === 3, { stopChecks, reminders: reminders(c).length, ends: c.findAll('prompt_end').map((e) => e.stopReason) });
  } finally { await c.stop(); api.close(); }
}

console.log('— Stop lands INSIDE the stop-check round trip: no billed nudge turn afterwards');
{
  // maybeStopNudge is a round trip: endPrompt fires it on end_turn and the turn
  // is already over when the answer lands. A Stop inside that window used to
  // change nothing — the fetch resolved into runPrompt, activePrompt was null,
  // and the wrapper BILLED a fresh turn the user had just asked to stop (the
  // only trace: a reminder appearing out of nowhere). The interrupt now records
  // itself (epoch) and aborts the request in flight; a late answer is discarded.
  let stopChecks = 0, holdMs = 900;
  const api = http.createServer((req, res) => {
    if (String(req.url).startsWith('/api/agent/stop-check')) {
      stopChecks++;
      setTimeout(() => { try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ block: true, reason: 'fs — report your progress with vibespace-task' })); } catch { } }, holdMs);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ context: '' }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const ENV = { VIBESPACE_API: `http://127.0.0.1:${api.address().port}`, VIBESPACE_SESSION_TOKEN: 'vsst_test' };
  const reminders = (w) => w.mockCalls().filter((c) => c.method === 'session/prompt' && JSON.stringify(c.params?.prompt || []).includes('vibespace-reminder'));
  const wlog = (w) => { try { return fs.readFileSync(path.join(w.dir, 'acp-wrapper.log'), 'utf8'); } catch { return ''; } };

  const w = startWrapper({ env: ENV });
  try {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    w.send({ type: 'chat-input', text: 'fs check', msgId: 's1' });               // ends end_turn with no permission
    await w.waitFor(() => w.find('prompt_end', (r) => r.stopReason === 'end_turn'), 8000, 'turn end_turn');
    await w.waitFor(() => stopChecks === 1, 3000, 'the stop-check round trip is in the air');
    w.send({ type: 'interrupt' });                                               // ← Stop, mid round trip
    await sleep(holdMs + 900);                                                   // let the held answer land
    ok('a Stop inside the stop-check round trip discards its answer — NO nudge turn is dispatched afterwards', reminders(w).length === 0 && w.findAll('prompt_start').length === 1, { reminders: reminders(w).length, starts: w.findAll('prompt_start').length, stopChecks });
    ok('…and the drop is recorded, not silent (the reason names the race)', /stop nudge dropped: Stop landed while the stop-check was in flight/.test(wlog(w)), wlog(w).split('\n').filter((l) => /stop nudge/.test(l)).join(' | '));
    ok('…the latch is not stranded either: nothing is queued and no phantom "send it again" notice', !w.find('notice', (r) => r.noticeKind === 'queue-cleared') && !w.findAll('queue_changed').some((r) => (r.items || []).length), w.findAll('queue_changed').map((r) => r.items?.length));
    // and the session still nudges LATER — the discarded answer is not a latch
    const later = await (async () => { const t0 = Date.now(); w.send({ type: 'chat-input', text: 'fs again', msgId: 's2' }); while (Date.now() - t0 < 9000) { if (reminders(w).length === 1) return true; await sleep(20); } return false; })();
    ok('…and the NEXT completed turn nudges normally (the discarded answer left no latch behind)', later && stopChecks === 2, { stopChecks, reminders: reminders(w).length });
  } finally { await w.stop(); }

  // CONTROL: the very same held round trip, with NO Stop — the reminder DOES go
  // out. Without this the assert above would also pass on a wrapper whose
  // delayed stop-check simply never works.
  stopChecks = 0;
  const c = startWrapper({ env: ENV });
  try {
    await c.waitFor(() => c.find('session'), 10000, 'session record');
    c.send({ type: 'chat-input', text: 'fs check', msgId: 'c1' });
    await c.waitFor(() => c.find('prompt_end', (r) => r.stopReason === 'end_turn'), 8000, 'turn end_turn');
    const got = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 9000) { if (reminders(c).length === 1) return true; await sleep(20); } return false; })();
    ok('control: with no Stop the SAME held stop-check produces the reminder (the discard above is the Stop, not the delay)', got && stopChecks === 1, { stopChecks, reminders: reminders(c).length });
  } finally { await c.stop(); api.close(); }
}

console.log('— a Deny never selects an ALLOW option (fail closed)');
{
  const w = startWrapper();
  try {
    await w.waitFor(() => w.find('session'), 10000, 'session record');
    // "noreject" → the mock offers ONLY [allow_once, allow_always]
    w.send({ type: 'chat-input', text: 'noreject please read the file', msgId: 'd1' });
    const perm = await w.waitFor(() => w.find('permission_request'), 5000, 'permission_request');
    ok('the agent offers no reject-kind option (the shape that used to execute the tool on Deny)', perm.options.map((o) => o.kind).join(',') === 'allow_once,allow_always', perm.options);
    w.send({ type: 'permission-response', requestId: perm.requestId, approved: false });
    const res = await w.waitFor(() => w.find('permission_resolved'), 5000, 'permission_resolved');
    const end = await w.waitFor(() => w.find('prompt_end'), 8000, 'prompt_end');
    ok('Deny with no reject option → {outcome:cancelled}, NEVER an allow option', res.outcome === 'cancelled' && res.optionId === null && res.optionKind === null, res);
    ok('…the tool did not run (tool_call_update failed, no "completed", no "Done (always)" text)', w.updates('tool_call_update').every((u) => u.update.status !== 'completed') && w.updates('tool_call_update').some((u) => u.update.status === 'failed') && !w.updates('agent_message_chunk').some((u) => /Done \(/.test(u.update.content?.text || '')) && end.stopReason === 'cancelled', w.updates('tool_call_update').map((u) => u.update.status));
    ok('…and the user is TOLD what their Deny became (cancelled ends the turn; the tool was refused)', /^This agent offered no "reject" option/.test(w.find('notice', (r) => r.noticeKind === 'deny-cancelled')?.text || ''), w.find('notice', (r) => r.noticeKind === 'deny-cancelled'));
    // POSITIVE CONTROL: with a reject option offered, Deny still picks it
    w.send({ type: 'chat-input', text: 'please read the file', msgId: 'd2' });
    const perm2 = await w.waitFor(() => w.findAll('permission_request').length === 2 && w.findAll('permission_request')[1], 5000, 'second permission_request');
    w.send({ type: 'permission-response', requestId: perm2.requestId, approved: false });
    await w.waitFor(() => w.findAll('permission_resolved').length === 2, 5000, 'second permission_resolved');
    ok('positive control: an agent that DOES offer reject_once still gets the explicit rejection (no behaviour change)', w.findAll('permission_resolved')[1].optionKind === 'reject_once' && w.findAll('notice', (r) => r.noticeKind === 'deny-cancelled').length === 1, w.findAll('permission_resolved')[1]);
  } finally { await w.stop(); }
}

console.log('— boot failure honesty');
{
  const w = startWrapper({ env: { ACP_WEBUI_BACKEND: 'opencode' } });
  // kill the mock from under the wrapper before it answers: the wrapper must
  // report, not hang. Use a command that exits immediately instead.
  await w.stop();
  const w2 = { ...startWrapper({}), };
  await w2.stop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acp-'));
  const child = spawn(process.execPath, [WRAPPER, path.join(dir, 's.buf'), path.join(dir, 's.json'), process.execPath, '-e', 'process.exit(3)'], { env: { ...CLEAN_ENV, ACP_WEBUI_CWD: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  ok('an agent that exits before initialize → LOUD boot-failed/agent-exited notice + non-zero wrapper exit (never a silent hang)', code !== 0 && /agent-exited|boot-failed/.test(out) && /exited before the session was ready|could not start/.test(out), { code, out: out.slice(0, 300) });
  // …AND when it exits 0 (a CLI that prints usage / an unauthenticated agent
  // that gives up quietly). finalizeExit() exits synchronously, so boot()'s own
  // catch never runs from the child-exit path: gating the notice on code !== 0
  // produced ZERO records — a blank chat window that never said why.
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acp-'));
  const buf0 = path.join(dir0, 's.buf');
  const c0 = spawn(process.execPath, [WRAPPER, buf0, path.join(dir0, 's.json'), process.execPath, '-e', 'process.exit(0)'], { env: { ...CLEAN_ENV, ACP_WEBUI_CWD: dir0 }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out0 = ''; c0.stdout.setEncoding('utf8'); c0.stdout.on('data', (d) => { out0 += d; });
  await new Promise((r) => c0.on('exit', () => r()));
  const recs0 = out0.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const bufRecs0 = (() => { try { return fs.readFileSync(buf0, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  ok('an agent that exits 0 before answering initialize is STILL reported (exit code 0 is not success when no session exists)', recs0.some((r) => r.kind === 'notice' && r.noticeKind === 'agent-exited' && /exited before the session was ready \(exit code 0\)/.test(r.text)), recs0);
  ok('…and the notice is in the BUFFER FILE too — the journal IS the history, so the window shows it after a restart (never blank)', bufRecs0.some((r) => r.kind === 'notice' && r.noticeKind === 'agent-exited'), bufRecs0);
}

console.log('— normalizer (AcpMessageManager) over the journal');
{
  const { AcpMessageManager, AcpSessionMessages, collapseKindOf, toolNameOf } = require(path.join(REPO, 'src/acp-message-manager.js'));
  const mm = new AcpMessageManager('s1');
  const msgs = mm.convertHistory(historyRecords);
  const users = msgs.filter((m) => m.role === 'user');
  ok('user prompts become user messages (msgId-keyed; peer message carries its envelope)', users.length === 6 && users[0].content[0].text === 'please read the file' && users.at(-1).originKind === 'peer-message' && users.at(-1).peerFrom === 'B' && users.at(-1).content[0].text === 'B says hi', users.map((u) => u.content[0]?.text));
  const texts = msgs.filter((m) => m.role === 'assistant' && m.content[0]?.type === 'text');
  ok('agent_message_chunks with one messageId MERGE into one assistant text ("Looking at your request.")', texts.some((t) => t.content[0].text === 'Looking at your request.') && texts.every((t) => t.status === 'complete'), texts.map((t) => t.content[0].text));
  ok('agent_thought_chunk → a thinking block', msgs.some((m) => m.role === 'assistant' && m.content[0]?.type === 'thinking' && /check the file first/.test(m.content[0].text)));
  const tools = msgs.filter((m) => m.role === 'tool');
  const readCard = tools.find((t) => t.toolName === 'Read');
  ok('tool_call kind read → Read card, collapseKind read, completed with the tool output + permission resolved (allowed, option once)', readCard && readCard.collapseKind === 'read' && readCard.status === 'complete' && readCard.content[0].type === 'tool_result' && /hello/.test(readCard.content[0].output) && readCard.permission?.resolved === 'allowed' && readCard.permission.selectedOptionId === 'once' && readCard.permission.options.length === 3 && readCard.backendMeta.acpKind === 'read', readCard);
  const editCard = tools.find((t) => t.toolName === 'Edit');
  ok('tool_call kind edit → Edit card (write fold) — denied: error status + denied permission', editCard && editCard.collapseKind === 'write' && editCard.status === 'error' && editCard.permission?.resolved === 'denied' && editCard.permission.selectedOptionId === 'no', editCard);
  const bashCard = tools.find((t) => t.toolName === 'Bash');
  ok('tool_call kind execute → Bash card (bash fold) with the command as input; cancelled turn → error status', bashCard && bashCard.collapseKind === 'bash' && bashCard.content[0].input?.command === 'ls -la' && bashCard.status === 'error', bashCard);
  ok('the cancelled prompt leaves an Interrupted marker; the fs refusal turn has no error card', msgs.some((m) => m.role === 'system' && m.status === 'interrupted') && !msgs.some((m) => m.role === 'system' && m.status === 'error' && /prompt failed/.test(m.content[0]?.text || '')));
  ok('wrapper notices become system cards (rejected model = error status, unsupported effort, unknown verb)', msgs.filter((m) => m.role === 'system' && m.noticeKind === 'rejected').length === 1 && msgs.some((m) => m.noticeKind === 'unsupported') && msgs.some((m) => m.noticeKind === 'unknown-verb'));
  const st = mm.status();
  ok('status(): model/mode follow the config records, slash commands from available_commands_update, context window from usage_update', st.model === 'mock/smart' && st.permissionMode === 'plan' && st.permissionModes.join(',') === 'build,plan' && st.slashCommands.join(',') === 'review,plan' && st.contextWindow === 200000 && st.lastUsage?.input_tokens === 1234 && st.models.length === 2 && st.agentInfo?.name === 'mock-acp', st);
  ok('taskState() todos come from the last plan', mm.taskState().todos.length === 2 && mm.taskState().todos[0].status === 'completed');
  ok('turnMap() has one entry per user turn with previews', mm.turnMap().filter((t) => t.role === 'user').length === 6 && mm.turnMap()[0].preview);
  ok('search() finds tool output', mm.search('hello').length >= 1);
  ok('history rebuild produces NO init card (a live artefact); ids are content-derived and stable across rebuilds', !msgs.some((m) => m.content[0]?.type === 'system_info' && m.content[0].initData) && new AcpMessageManager('s1').convertHistory(historyRecords).map((m) => m.id).join() === msgs.map((m) => m.id).join());
  // live path: ops + init card + permission card BEFORE resolution
  const live = new AcpMessageManager('s2'); const ops = []; live.onOp((o) => ops.push(o));
  for (const r of historyRecords.slice(0, historyRecords.findIndex((r) => r.kind === 'permission_resolved'))) live.processLive(r);
  const pendingCard = live.messages.find((m) => m.permission && !m.permission.resolved);
  ok('live: the init card is created from the session record; the permission card is PENDING with ordered options', ops[0]?.op === 'create' && ops[0].message.content[0].initData?.model === 'mock/fast' && pendingCard && pendingCard.permission.options.map((o) => o.optionId).join(',') === 'once,always,no' && pendingCard.permission.kind === 'approval', ops[0]);
  live.processLive({ type: 'permission-response', requestId: pendingCard.permission.requestId, approved: true, optionId: 'once' });
  ok('the ws-handler\'s echoed permission-response frame resolves the pending card (survives a refresh)', pendingCard.permission.resolved === 'allowed' && pendingCard.permission.selectedOptionId === 'once' && ops.at(-1).op === 'edit');
  ok('collapseKindOf/toolNameOf cover every ACP ToolKind', ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'].every((k) => toolNameOf(k)) && collapseKindOf('switch_mode') === null && collapseKindOf('fetch') === 'mcp' && collapseKindOf('think') === 'thinking');
  // store reader over the buffer
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acp-buf-'));
  fs.writeFileSync(path.join(bdir, 's1.json'), JSON.stringify({ mode: 'chat', streaming: true, todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }], model: 'mock/smart' }));
  const sm = new AcpSessionMessages({ buffer: historyRecords.map((r) => JSON.stringify(r)).join('\n') + '\n' }, 's1', { buffersDir: bdir });
  ok('AcpSessionMessages reads raw/tail/slice from the buffer, chatStatus from the journal, todos + streaming from the sidecar', sm.total === historyRecords.length && sm.tail(2).length === 2 && sm.slice(0, 1)[0].type === 'acp' && sm.chatStatus()?.model === 'mock/smart' && sm.taskState().todos.length === 2 && sm.isStreaming === true, { todos: sm.taskState().todos, streaming: sm.isStreaming });
  fs.rmSync(bdir, { recursive: true, force: true });
  const empty = new AcpSessionMessages({ buffer: '' }, 'none', { buffersDir: os.tmpdir() });
  ok('…an empty buffer → null chatStatus, no todos (never throws)', empty.chatStatus() === null && empty.taskState().todos.length === 0);
  // registry / adapter
  const { AcpAdapter } = require(path.join(REPO, 'src/adapters/acp.js'));
  const { acpHarness } = require(path.join(REPO, 'src/harnesses/acp.js'));
  const h = acpHarness({ id: 'mockacp', label: 'Mock', command: 'mock-agent', args: ['acp', '--x'] });
  const ad = new h.Adapter(h.adapterConfig({ acpWrapper: '/w/acp', ptyWrapper: '/w/pty', acpCommands: { mockacp: null } }));
  ok('acpHarness factory: descriptor id/kind/caps/streamProtocol/creds:null/inject acp; adapter reports installed=false when cli-env found no executable', h.id === 'mockacp' && h.kind === 'chat' && h.caps.streamProtocol === 'acp-events' && h.creds === null && h.inject.kind === 'acp' && ad instanceof AcpAdapter && ad.installed === false);
  const spec = new h.Adapter(h.adapterConfig({ acpWrapper: '/w/acp', ptyWrapper: '/w/pty', acpCommands: { mockacp: '/usr/bin/mock-agent' } })).buildSessionArgs({ cwd: '/tmp/x', mode: 'chat', model: 'm1', permissionMode: 'plan', resumeId: 'ses_1', extraArgs: ['--v'] });
  ok('buildSessionArgs(chat): the resolved executable + acp args + extra args under the shared wrapper; facts ride ACP_WEBUI_* env (never argv)', spec.cmd === '/usr/bin/mock-agent' && spec.args.join(' ') === 'acp --x --v' && spec.wrapper === '/w/acp' && spec.env.ACP_WEBUI_MODEL === 'm1' && spec.env.ACP_WEBUI_MODE === 'plan' && spec.env.ACP_WEBUI_RESUME_ID === 'ses_1' && spec.env.ACP_WEBUI_BACKEND === 'mockacp' && spec.cwd === '/tmp/x', spec);
  let threw = null; try { acpHarness({ id: 'Bad Id', command: 'x' }); } catch (e) { threw = e.message; }
  ok('acpHarness refuses a non-slug id', /lowercase slug/.test(threw || ''));
  const fmt = ad.formatPermissionResponse({ requestId: 7, approved: true, optionId: 'always', permissionUpdates: [{ kind: 'allow_always' }] });
  ok('formatPermissionResponse forwards requestId/approved/optionId/alwaysAllow to the wrapper verb', JSON.parse(fmt).optionId === 'always' && JSON.parse(fmt).alwaysAllow === true && JSON.parse(fmt).type === 'permission-response');
}

console.log('— wiring pins');
{
  // S5: the acp-events consumer is its own module behind the stdout registry (src/server/stdout/acp-events.js)
  const so = read('src/server/stdout/acp-events.js');
  ok('stdout/acp-events.js is the acp-events consumer: id adoption from the session record, streaming from prompt_start/prompt_end, todos from plan, feedLive gate', /^const protocol = 'acp-events';$/m.test(so) && /msg\.kind === 'session'/.test(so) && /msg\.kind === 'prompt_end'\) \{\s*\n\s*session\._isStreaming = false/.test(so) && /u\.sessionUpdate === 'plan'/.test(so) && /noteHarnessModels\?\.\(session\.backend, msg\.models\)/.test(so));
  ok('…registered under its protocol in the stdout registry, and every ACP record reaches the normalizer through feedLive (never processLive)', /'acp-events': require\('\.\/acp-events\.js'\)/.test(read('src/server/stdout/index.js')) && (so.match(/feedLive\(session, msg\)/g) || []).length === 2 && !/_normalizer\.processLive/.test(so));
  const sv = read('server.js');
  ok('server.js wires noteHarnessModels into the stdout engine and exposes harnessAvailability on app.locals', /noteHarnessModels: \(\.\.\.a\) => noteHarnessModels\(\.\.\.a\)/.test(sv) && /app\.locals\.harnessAvailability = harnessAvailability/.test(sv));
  const ce = read('src/server/cli-env.js');
  ok('cli-env resolves each ACP harness executable once (env <ID>_CMD override) and hands acpWrapper/acpCommands to the adapter registry', /ACP_COMMANDS\[h\.id\] = raw\.startsWith\('\/'\) \? raw : \(resolveCmd\(raw\) \|\| null\)/.test(ce) && /acpWrapper: path\.join\(rootDir, 'data', 'bin', 'acp-wrapper\.js'\)/.test(ce) && /acpCommands: ACP_COMMANDS/.test(ce) && /function harnessAvailability\(\)/.test(ce) && /function noteHarnessModels\(backend, models\)/.test(ce));
  const wc = read('src/ws-create.js');
  ok('ws-create refuses an uninstalled ACP harness BEFORE any spawn (loud error with the fix)', /if \(adapter\.installed === false\)/.test(wc) && /is not installed on this machine/.test(wc));
  ok('files.js /api/home carries harness availability for the picker', /harnesses = typeof req\.app\.locals\.harnessAvailability === 'function'/.test(read('src/routes/files.js')));
  const app = read('src/lib/app.js');
  ok('app.js: the picker unhides an ACP backend only when installed; opencode session options row (build/plan, no effort ladder); effort row hidden by META caps', /opt\.hidden = !h\.installed/.test(app) && /opencode: \{\n    models: \[\{ id: '', label: t\('Default'\) \}\],/.test(app) && /BACKEND_META\[backend\]\?\.caps\?\.effort === false/.test(app) && /!BACKEND_SESSION_OPTIONS\[be\] \|\| !data\[be\]\?\.length\) continue;/.test(app));
  ok('index.html lists the opencode option hidden by default', /<option value="opencode" hidden>OpenCode<\/option>/.test(read('public/index.html')));
  const cr = read('src/lib/chat-renderers.js');
  ok('chat-renderers renders ORDERED permission options (harness-neutral) and replies with the chosen optionId', /Array\.isArray\(msg\.permission\.options\) && msg\.permission\.options\.length/.test(cr) && /optionId: o\?\.optionId \|\| null/.test(cr) && /data-option-id="\$\{escHtml\(String\(o\.optionId\)\)\}"/.test(cr));
  ok('backend-caps + harness registry: opencode row (streamProtocol acp-events, pool false, frameFile) registered as a built-in', /opencode: \{\n    pool: false, hotSwitch: 'unverified'[\s\S]{0,200}streamProtocol: 'acp-events'/.test(read('src/backend-caps.js')) && /require\('\.\/opencode'\)/.test(read('src/harnesses/index.js')));
  ok('mounts-plugins-wiring dispatches SessionMessages through the descriptor for non-claude/codex harnesses', /h\?\.store\?\.SessionMessages\) return new h\.store\.SessionMessages/.test(read('src/server/mounts-plugins-wiring.js')));
  ok('wrapper-files recognises the ACP wrapper in the dtach master argv (collision resolver)', /\(chat\|acp\)-wrapper\\\.js/.test(read('src/server/wrapper-files.js')));
  ok('settings schema: opencode.defaultModel/defaultPermissionMode/defaultExtraArgs under an OpenCode category; zh+ja carry the new strings', /'opencode\.defaultModel'/.test(read('src/lib/settings-schema.js')) && /'opencode\.defaultPermissionMode'/.test(read('src/lib/settings-schema.js')) && /"OpenCode":/.test(read('src/lib/i18n-zh.js')) && /"Build":/.test(read('src/lib/i18n-ja.js')));
  ok('test-architecture places the ACP files in the SHARED tier; ci.mjs runs this suite', /'src\/harnesses\/acp\.js', 'src\/harnesses\/opencode\.js', 'src\/adapters\/acp\.js', 'src\/acp-message-manager\.js'/.test(read('scripts/test-architecture.mjs')) && /'test-acp-harness'/.test(read('scripts/ci.mjs')));
  ok('the wrapper never touches a vendor API and never puts a secret in argv (program-use billing law)', !/api\.anthropic\.com|api\.openai\.com|Authorization: 'Bearer sk-/.test(read('data/bin/acp-wrapper.js')) && /clientCapabilities: \{ fs: \{ readTextFile: false, writeTextFile: false \}, terminal: false \}/.test(read('data/bin/acp-wrapper.js')));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
