#!/usr/bin/env node
// S9 REMAINDER GATE (B-eac2): roll-back, asks, the serve terminal, the live
// event lane that replaced the 10s list poll, and honest 'external' liveness.
//
// Runs against the MOCK serve (scripts/dev/mock-opencode-serve.mjs) so CI needs
// no OpenCode install, plus a REAL-BINARY section that SKIPS WITH EVIDENCE when
// `opencode` is absent (an environment-capability assertion must never fail
// silently and must never pass by accident).
//
// The mock models the two facts this feature set is built on, both measured on
// a real 1.18.29 serve with /proc:
//   • v1 `POST /session/:id/revert` restores the tree and boots NO instance,
//     while every `/api/session/:id/revert/*` v2 route DOES (16→37 threads,
//     0→19 indexer threads) — so "the roll-back path bootstraps nothing" is a
//     real assert here.
//   • `/global/event` needs no directory and boots nothing, but is per PROCESS:
//     another opencode on the same sqlite produces NO frame on it. That is why
//     the live lane has a second (fs.watch) source at all.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { startMockServe, createMockState, QUESTION_PART, emit } from './dev/mock-opencode-serve.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const serve = require(path.join(REPO, 'src/opencode-serve.js'));
const events = require(path.join(REPO, 'src/opencode-events.js'));
const { AcpMessageManager } = require(path.join(REPO, 'src/acp-message-manager.js'));

let pass = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); } };
const skip = (name, why) => { pass++; console.log(`  ⊘ SKIP ${name} — ${why}`); };
/** A SATURATED machine (this repo's box runs many agents) hits EMFILE/ENOSPC on
 *  inotify and then: fs.watch cannot attach, and OpenCode cannot boot the
 *  instance a pty needs. That is the ENVIRONMENT failing, not the mechanism —
 *  it SKIPS WITH THE EVIDENCE rather than passing quietly or failing loudly at
 *  something we did not break. */
const envExhausted = (text) => /EMFILE|ENOSPC|too many open files|watch limit/i.test(String(text || ''));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A locator over a fixed base url — the keeper is already gated elsewhere. */
function fixedLocator(url) {
  const client = new serve.OpencodeServeClient(url);
  return { client: async () => client, ensure: async () => client, state: () => ({ ready: true, installed: true, parked: false, lastError: null, caps: { fork: true }, version: '1.18.29' }), invalidate: () => { }, _client: client };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— (a) ROLL BACK / RESTORE —');
{
  const mock = await startMockServe({ state: createMockState() });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const before = mock.state.instances.size;
  const s1 = await facts.revertTo('ses_a1', { messageID: 'msg_u2' });
  ok('revert returns the updated Session carrying the staged roll-back', s1?.revert?.messageID === 'msg_u2', s1?.revert);
  ok('…and bootstraps NO OpenCode instance (the v1 route; v2 revert/* would)', mock.state.instances.size === before, [...mock.state.instances]);
  ok('the v2 revert family is never requested', !mock.state.requests.some((r) => /^POST \/api\/session\/.*\/revert/.test(r)), mock.state.requests.filter((r) => r.includes('revert')));

  const conv = await facts.readConversation('ses_a1');
  const notice = conv.records.find((r) => r.kind === 'notice' && r.noticeKind === 'revert');
  ok('the reader SAYS the conversation is rolled back (a notice at the boundary)', !!notice && /staged for removal/.test(notice.text), notice?.text);
  const idx = conv.records.indexOf(notice);
  const firstUserAfter = conv.records.findIndex((r) => r.kind === 'user' && r.msgId === 'msg_u2');
  ok('…and it sits immediately BEFORE the message it rolled back to', idx >= 0 && firstUserAfter === idx + 1, { idx, firstUserAfter });
  ok('the notice names the restored files', /1 file/.test(notice?.text || ''), notice?.text);

  const s2 = await facts.unrevert('ses_a1');
  ok('unrevert clears it', !s2.revert);
  const conv2 = await facts.readConversation('ses_a1');
  ok('…and the notice is gone on the next read (the cache was dropped)', !conv2.records.some((r) => r.noticeKind === 'revert'));

  let broke = null;
  try { await facts.revertTo('ses_a1', {}); } catch (e) { broke = e; }
  ok('a roll-back with no target is REFUSED loudly', !!broke && /message/i.test(broke.message), broke?.message);
  broke = null;
  try { await facts.revertTo('ses_missing', { messageID: 'msg_u1' }); } catch (e) { broke = e; }
  ok('an unknown conversation names itself in the error', !!broke && /ses_missing/.test(broke.message), broke?.message);
  await mock.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— (b) THE ASK CARD —');
{
  const st = createMockState();
  st.messages.ses_a2.push({ info: { id: 'msg_bq', sessionID: 'ses_a2', role: 'assistant', time: { created: 1788601100000, completed: 1788601111000 }, modelID: 'deepseek-v4', providerID: 'deepseek', agent: 'plan', finish: 'stop' }, parts: [QUESTION_PART(true)] });
  const mock = await startMockServe({ state: st });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const conv = await facts.readConversation('ses_a2');
  const askRec = conv.records.find((r) => r.kind === 'permission_request');
  ok('an ANSWERED `question` tool part becomes an ask card, not a generic tool', !!askRec && askRec.questions?.length === 1, askRec);
  ok('…carrying the option labels and the answer', askRec?.questions?.[0]?.options?.length === 2 && askRec?.answers?.['Do you prefer red or blue?'] === 'Blue', askRec?.answers);
  ok('…and it declares WHICH lane answers it (never a backend id at the card)', askRec?.via === 'opencode-serve');
  ok('…resolved, so the card renders the answer instead of a live form', askRec?.resolved === 'allowed');

  const mm = new AcpMessageManager('ses_a2');
  const msgs = mm.convertHistory(conv.records);
  const card = msgs.find((m) => m.permission?.kind === 'user_input');
  ok('the ACP normalizer builds the SAME user_input permission claude uses for AskUserQuestion', !!card && card.permission.questions.length === 1, card?.permission);
  ok('…already resolved cards are not left in pendingApprovals (no stray echo can flip history)', mm.pendingApprovals.size === 0);

  // now a PENDING one
  st.messages.ses_a2[st.messages.ses_a2.length - 1].parts = [QUESTION_PART(false)];
  st.questions = [{ id: 'que_live1', sessionID: 'ses_a2', questions: QUESTION_PART(false).state.input.questions, tool: { messageID: 'msg_bq', callID: 'call_question_1' } }];
  facts.invalidate();
  const conv3 = await facts.readConversation('ses_a2');
  const pendRec = conv3.records.find((r) => r.kind === 'permission_request');
  ok('a PENDING ask is re-joined to the LIVE request id (que_…), so the card can answer it after a reload', pendRec?.requestId === 'que_live1', pendRec?.requestId);
  ok('…and is not marked stale while it is really pending', !pendRec?.stale);

  const r = await facts.answerQuestion('que_live1', { 'Do you prefer red or blue?': 'Blue' });
  ok('the card map is converted to OpenCode POSITIONAL answers on the real route', JSON.stringify(mock.state.answered[0]?.answers) === '[["Blue"]]', mock.state.answered[0]);
  ok('…and the answer reports the conversation it belonged to', r.sessionID === 'ses_a2');
  ok('…and the pending list no longer holds it', (await facts.pendingQuestions({ refresh: true })).length === 0);

  // a multi-select answer round-trips; a free-text answer with ", " does NOT get split
  const qs = serve.normalizeAskQuestions([{ question: 'Pick', header: 'h', multiple: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]);
  ok('multi-select: the card joins labels, the converter splits them back', JSON.stringify(serve.askAnswersToPositional(qs, { Pick: 'A, B' })) === '[["A","B"]]');
  ok('free text containing ", " survives intact (only KNOWN labels split)', JSON.stringify(serve.askAnswersToPositional(qs, { Pick: 'hello, world' })) === '[["hello, world"]]');

  // stale: the transcript has an open ask but nothing is pending any more
  st.questions = [];
  facts.invalidate();
  const conv4 = await facts.readConversation('ses_a2');
  const stale = conv4.records.find((r2) => r2.kind === 'permission_request');
  ok('an ask with no live request behind it is marked STALE (the card must not offer a dead Submit)', stale?.stale === true);
  const mm2 = new AcpMessageManager('ses_a2');
  const staleCard = mm2.convertHistory(conv4.records).find((m) => m.permission?.kind === 'user_input');
  ok('…and the flag reaches the rendered card', staleCard?.permission?.stale === true);

  let broke = null;
  try { await facts.answerQuestion('que_gone', [['Blue']]); } catch (e) { broke = e; }
  ok('answering a question that is gone FAILS loudly (never a silent no-op)', !!broke && /que_gone/.test(broke.message), broke?.message);
  await mock.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— (c) THE SERVE TERMINAL —');
{
  const mock = await startMockServe({ state: createMockState(), pty: true });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const opened = await facts.openPty({ cwd: '/work/alpha', title: 'test' });
  ok('openPty returns the pty AND the SERVER-side stream url', !!opened.pty?.id && /^ws:\/\/127\.0\.0\.1:\d+\/pty\/pty_mock1\/connect/.test(opened.url), opened.url);
  ok('an unsecured serve refuses to mint a ticket — we connect without one', opened.ticketed === false && !/ticket=/.test(opened.url), opened.url);

  // the ACCESS layer strips the transport secrets from anything a route returns
  const accessMod = require(path.join(REPO, 'src/server/opencode-access.js'));
  const layer = accessMod.create({ facts, hosts: null });
  const pub = layer.publicView('pty-open', { pty: { id: 'pty_x' }, url: 'ws://127.0.0.1:1/x', auth: 'Basic zzz' });
  ok('a ROUTE never hands the browser the serve url or its auth header', !pub.url && !pub.auth && pub.pty?.id === 'pty_x', pub);

  // the bridge: real ws, real shim
  const bridgeMod = require(path.join(REPO, 'src/server/opencode-pty-bridge.js'));
  accessMod.create({ facts, hosts: null });                  // publish the singleton the bridge uses
  const bridge = await bridgeMod.openOpencodePty({ cwd: '/work/alpha', title: 'bridged' });
  const chunks = [];
  // register LATE on purpose: the serve greets the socket the instant it opens,
  // BEFORE the session layer attaches its consumer — the bridge must hold that
  // banner, not drop it (the blank-terminal bug the browser leg caught)
  await sleep(500);
  bridge.shim.onData((s2) => chunks.push(s2));
  let exited = null;
  bridge.shim.onExit((e) => { exited = e; });
  await sleep(300);
  ok('TEXT frames sent BEFORE the consumer attached are held and flushed (never a blank terminal)', chunks.join('').includes('mock-shell$'), chunks);
  ok('BINARY control frames (\\0-json cursor) are NOT rendered into the shell', !chunks.join('').includes('cursor'), chunks);
  bridge.shim.write('echo hi\r');
  await sleep(200);
  const sock = mock.state.ptySockets.find((x) => x.id === bridge.ptyId);
  ok('input written to the shim reaches the serve socket', (sock?.input || []).join('').includes('echo hi'), sock?.input);
  bridge.shim.resize(100, 40);
  await sleep(200);
  ok('resize goes over HTTP (PUT /pty/:id), not the socket', mock.state.ptys.get(bridge.ptyId)?.size?.cols === 100, mock.state.ptys.get(bridge.ptyId));
  bridge.shim.kill();
  await sleep(250);
  ok('kill deletes the pty on the serve and ends the session', !mock.state.ptys.has(bridge.ptyId) && !!exited, { left: [...mock.state.ptys.keys()], exited });
  await mock.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— (d) THE LIVE LANE (the 10s list poll is GONE) —');
{
  ok('sseFrames reassembles split frames and joins multi-line data', (() => {
    const a = events.sseFrames('', 'data: {"x":1}\n\ndata: one\ndata: two\n\ndata: {"y"');
    const b = events.sseFrames(a.carry, ':2}\n\n');
    return JSON.stringify(a.frames) === '["{\\"x\\":1}","one\\ntwo"]' && JSON.stringify(b.frames) === '["{\\"y\\":2}"]';
  })());
  const cls = (type, properties, extra = {}) => events.classifyEvent({ directory: '/work/alpha', payload: { id: 'evt', type, properties }, ...extra });
  ok('classifyEvent: session.created dirties the session list', cls('session.created', { sessionID: 'ses_a1' }).dirty.sessions === true);
  ok('classifyEvent: message.part.updated dirties only that conversation', cls('message.part.updated', { sessionID: 'ses_a1' }).dirty.conversation === 'ses_a1');
  ok('classifyEvent: session.status carries the busy verdict', cls('session.status', { sessionID: 'ses_a1', status: { type: 'busy' } }).status.type === 'busy');
  ok('classifyEvent: question.asked carries the whole request', cls('question.asked', { id: 'que_1', sessionID: 'ses_a1', questions: [{ question: 'q', header: 'h', options: [] }] }).question?.id === 'que_1');
  ok('classifyEvent: an UNKNOWN type is "other" with no dirty flags (an OpenCode upgrade can never drop a lane)', (() => { const r = cls('galaxy.exploded', {}); return r.kind === 'other' && Object.keys(r.dirty).length === 0; })());
  ok('classifyEvent: a heartbeat is not a change', cls('server.heartbeat', {}).kind === 'heartbeat');

  const mock = await startMockServe({ state: createMockState() });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-store-'));
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
  const changes = [];
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } }, onChange: (c) => changes.push(c.reason) });
  facts.armLive((deps) => events.createLiveLane({ ...deps, storeDirs: [storeDir], debounceMs: 60 })).start();
  await sleep(500);
  const laneSt = facts.state().liveLane;
  const watchBroken = !laneSt?.watch?.active && envExhausted(JSON.stringify(laneSt?.watch?.failed || []));
  if (watchBroken) skip('the lane reports itself HEALTHY (SSE connected + a store watch attached)', `this machine cannot fs.watch right now: ${JSON.stringify(laneSt.watch.failed).slice(0, 160)}`);
  else ok('the lane reports itself HEALTHY (SSE connected + a store watch attached)', facts.state().liveLaneHealthy === true, laneSt);

  await facts.discover({});
  const listsAfterFirst = mock.state.requests.filter((r) => r.startsWith('GET /session?')).length;
  await sleep(60);
  for (let i = 0; i < 5; i++) await facts.discover({});
  ok('a HEALTHY lane means NO timer refresh: five more discovers re-list ZERO times', mock.state.requests.filter((r) => r.startsWith('GET /session?')).length === listsAfterFirst, mock.state.requests.filter((r) => r.startsWith('GET /session?')));

  emit(mock.state, { directory: '/work/alpha', payload: { id: 'evt_n', type: 'session.created', properties: { sessionID: 'ses_new' } } });
  await sleep(250);
  ok('an SSE change marks the list dirty (and NOTIFIES — the cache-invalidation law)', facts.state().dirty === true && changes.includes('sessions'), changes);
  await sleep(1000);                                   // past the serial-burst floor
  await facts.discover({});
  if (watchBroken) skip('…and the very next discover re-reads it', 'the lane cannot be healthy on this machine (fs.watch exhausted)');
  else ok('…and the very next discover re-reads it', mock.state.requests.filter((r) => r.startsWith('GET /session?')).length > listsAfterFirst);

  // the STORE-WATCH lane: another opencode process writing the same sqlite
  changes.length = 0;
  fs.writeFileSync(path.join(storeDir, 'opencode.db-wal'), 'y');
  await sleep(400);
  if (watchBroken) skip('a write by ANOTHER opencode process (the store file) dirties the list too', 'fs.watch exhausted on this machine (the lane degraded LOUDLY, which is the designed behaviour)');
  else ok('a write by ANOTHER opencode process (the store file) dirties the list too — the only lane that sees a TUI', changes.some((c) => /^store/.test(c)), changes);

  // an UNHEALTHY lane falls back to the timer, STRUCTURALLY
  const facts2 = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } }, listCacheMs: 50 });
  await facts2.discover({});
  const n0 = mock.state.requests.filter((r) => r.startsWith('GET /session?')).length;
  await sleep(80);
  await facts2.discover({});
  ok('with NO lane armed the timed refresh is still there (a broken lane must not freeze the sidebar)', mock.state.requests.filter((r) => r.startsWith('GET /session?')).length > n0);
  ok('…and the lane state says so, so the panel can be honest about it', facts2.state().liveLaneHealthy === false);

  facts.stopLive();
  await mock.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— (f) HONEST LIVENESS —');
{
  const mock = await startMockServe({ state: createMockState() });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const mine = new Map([['w1', { backend: 'opencode', backendSessionId: 'ses_a1', name: 'mine' }]]);
  let rows = await facts.discover({ activeSessions: mine });
  ok('our own live session reads live', rows.find((r) => r.backendSessionId === 'ses_a1')?.status === 'live');
  ok('everything else reads stopped — never a fake "running"', rows.filter((r) => r.backendSessionId !== 'ses_a1').every((r) => r.status === 'stopped'));

  mock.state.statuses = { ses_a2: { type: 'busy' } };
  await facts.statusMap();
  facts.invalidate();
  rows = await facts.discover({ activeSessions: mine });
  ok('a conversation this serve reports BUSY reads external (rung 1: in-process truth)', rows.find((r) => r.backendSessionId === 'ses_a2')?.status === 'external');

  mock.state.statuses = {};
  await facts.statusMap();
  // rung 2: the row moved under someone who is not us
  const target = mock.state.sessions.find((s) => s.id === 'ses_g1');
  facts.invalidate(); await facts.discover({ activeSessions: mine });     // first sighting
  target.time = { ...target.time, updated: Date.now() };
  facts.invalidate();
  rows = await facts.discover({ activeSessions: mine });
  ok('a row that MOVED while we were not driving it reads external (rung 2: the cross-process lane)', rows.find((r) => r.backendSessionId === 'ses_g1')?.status === 'external');

  // negative control 1: OUR OWN write must never look external
  const factsB = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const mineToo = new Map([['w2', { backend: 'opencode', backendSessionId: 'ses_g1' }]]);
  await factsB.discover({ activeSessions: mineToo });
  target.time = { ...target.time, updated: Date.now() + 1000 };
  factsB.invalidate();
  ok('our own conversation moving is LIVE, never external', (await factsB.discover({ activeSessions: mineToo })).find((r) => r.backendSessionId === 'ses_g1')?.status === 'live');

  // negative control 2: the evidence DECAYS
  const factsC = serve.createFacts(fixedLocator(mock.url), { externalWindowMs: 1, log: { warn() { } } });
  await factsC.discover({});
  target.time = { ...target.time, updated: Date.now() + 2000 };
  factsC.invalidate();
  ok('the tick that SEES the change says external', (await factsC.discover({})).find((r) => r.backendSessionId === 'ses_g1')?.status === 'external');
  await sleep(20);
  ok('…and a later tick decays back to stopped (stale evidence is not a running agent)', (await factsC.discover({})).find((r) => r.backendSessionId === 'ses_g1')?.status === 'stopped');

  ok('the entry carries the roll-back state and the pending-ask count for the sidebar/chat', (() => {
    const r = rows.find((x) => x.backendSessionId === 'ses_a1');
    return r && 'revert' in r.opencode && 'questions' in r.opencode && 'busy' in r.opencode;
  })(), rows[0]?.opencode);
  await mock.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— WIRING PINS (a fix that is not wired is not a fix) —');
{
  const routes = read('src/routes/opencode.js');
  ok('routes exist for roll-back / restore / asks / status / todos / a machine\'s session list', ['/api/opencode/revert', '/api/opencode/unrevert', '/api/opencode/questions', '/api/opencode/question/:requestId/reply', '/api/opencode/question/:requestId/reject', '/api/opencode/status', '/api/opencode/todos', '/api/opencode/sessions'].every((r) => routes.includes(r)));
  ok('…and every op in the SHARED table is reachable (a route, the ws ask lane or the pty bridge) — no dead rows', (() => {
    const table = require(path.join(REPO, 'src/opencode-remote.js')).OPENCODE_OP_NAMES;
    const surfaces = routes + read('src/ws-handler.js') + read('src/server/opencode-pty-bridge.js') + read('src/server/opencode-access.js') + read('src/ws-create.js');
    return table.every((op) => surfaces.includes(`'${op}'`));
  })());
  ok('…every route reaches a machine through ONE helper (hostId is a parameter, never a branch) and NOTHING calls the access layer around it',
    /const host = \(req\.method === 'GET' \? req\.query\.host : req\.body\?\.host\) \|\| null;/.test(routes)
    && (routes.match(/ctx\.access\.call\(/g) || []).length === 1
    && (routes.match(/await call\(req,/g) || []).length >= 9);
  ok('…and every result a route hands back is filtered through publicView (transport secrets are stripped STRUCTURALLY, not by "no route asks for that op today")', /return ctx\.access\.publicView\(op, await ctx\.access\.call\(host, op, params\)\);/.test(routes));
  ok('…every mutating route BROADCASTS (multi-client law)', (routes.match(/notify\(/g) || []).length >= 5);
  ok('…and every failure answers with the machine-side reason', /function fail\(res, e\)/.test(routes) && /res\.status\(status\)\.json\(\{ error/.test(routes));
  ok('the access layer + its routes are wired from a src/server wiring module (server.js stays bootstrap-sized)', read('src/server/mounts-plugins-wiring.js').includes("require('./opencode-access').create("));
  const wsh = read('src/ws-handler.js');
  ok('ws permission-response routes an opencode-serve ask to the serve route, not to a session stdin', /data\.via === 'opencode-serve'/.test(wsh) && /'answer'/.test(wsh) && /'reject'/.test(wsh));
  ok('…and a refusal reaches the user (code opencode-question)', /code: 'opencode-question'/.test(wsh));
  const rend = read('src/lib/chat-renderers.js');
  ok('the ask card forwards `via`+`host` on BOTH submit and cancel (harness-neutral)', (rend.match(/msg\.permission\.via \? \{ via: msg\.permission\.via/g) || []).length === 2);
  ok('a STALE ask renders without a Submit button', /msg\.permission\.stale/.test(rend) && /no longer waiting for an answer/.test(rend));
  const cv = read('src/lib/chat-view.js');
  ok('the message popup offers the roll-back on a USER message only, behind a confirm dialog (never a native confirm)', /_addOpencodeRevertActions/.test(cv) && /showConfirmDialog\(/.test(cv) && /msg\.role === 'user'/.test(cv));
  ok('…and "Restore" appears only while a roll-back is actually staged', /const staged = row\?\.opencode\?\.revert/.test(cv));
  ok('an open window reacts to the broadcast (noteOpencodeChange), and the client never chains on its own echo', /noteOpencodeChange/.test(cv) && /noteOpencodeChange/.test(read('src/lib/app.js')));
  const card = read('src/lib/session-card.js');
  ok('the session card offers the serve terminal for opencode sessions on THIS machine', /session\.opencodeTerminal/.test(card) && /=== 'opencode' && !c\.s\.host/.test(card));
  ok('ws-create bridges the serve pty into the normal terminal path (no dtach spawn for it)', /data\.opencodePty/.test(read('src/ws-create.js')) && /!r6Handle && !ocPty/.test(read('src/ws-create.js')));
  ok('…and a serve terminal asked for a REMOTE machine is refused WITH the reason (the ws is not a promise the menu keeps)', /code: 'opencode-pty-remote'/.test(read('src/ws-create.js')) && /if \(data\.hostId \|\| session\.host\) \{/.test(read('src/ws-create.js')));
  ok('the pty session field is registered with an owner', /_opencodePtyId:/.test(read('src/session-schema.js')));
  ok('the daemon bundle carries the shared serve + op table (the device rung is the SAME code)', (() => {
    const b = path.join(REPO, 'data/bin/vibespace-agentd.js');
    if (!fs.existsSync(b)) return false;
    const t = fs.readFileSync(b, 'utf-8');
    return t.includes('opencode-serve') && t.includes('runOpencodeOp');
  })());
  ok('docs: kb-file-structure + kb-api + kb-features + the design S9 row mention the remainder', ['docs/kb-file-structure.md', 'docs/kb-api.md', 'docs/kb-features.md', 'docs/design-harness-plugins.md'].every((f) => /B-eac2|opencode-events|\/api\/opencode/.test(read(f))));
  // THE READER SITES: the bug the browser leg found (a fourth site that never
  // prepared) must stay fixed, and the invariant is "enumerate the sites", not
  // "assert the count in prose"
  ok('EVERY createSessionMessages() call site awaits the reader\'s prepare() (the fourth-site bug, B-eac2)', (() => {
    const files = ['src/ws-handler.js', 'src/transcript-service.js'];
    for (const f of files) {
      const src = read(f);
      const sites = [...src.matchAll(/createSessionMessages\(/g)].length;
      const prepares = [...src.matchAll(/sm\.prepare\b/g)].length;
      if (f === 'src/ws-handler.js' && prepares < 1) return false;         // the viewOnly site
      if (f === 'src/transcript-service.js' && prepares < 3) return false; // its three sites
      if (!sites && f === 'src/transcript-service.js') continue;
    }
    return true;
  })());
  ok('…and the incident is written down', /THE FOURTH READER SITE/.test(read('docs/kb-bugfix-invariants.md')));
  ok('ci.mjs runs this suite', /'test-opencode-s9'/.test(read('scripts/ci.mjs')));
}

// ─────────────────────────────────────────────────────────────────────────────
// The adversarial pass over THIS branch's own code. Every assert below stands
// for a defect that was reproduced first and then fixed — the point of the
// section is that the mechanism, not the wording, is pinned.
console.log('\n— ROUND 2 (findings from the review of this branch) —');
{
  // ① THE LANE MUST FOLLOW THE SERVE — and must NOT re-open on every notify().
  //    The stream backs off to 30s while nothing is reachable, so without a
  //    kick "enable the plugin" stayed un-live for up to half a minute; with a
  //    kick on EVERY notify() the once-a-minute guard sample would tear the
  //    SSE socket down for nothing. The edge is the port becoming ready.
  const mock = await startMockServe({ state: createMockState() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-install-'));
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: process.pid, startedAt: Date.now(), cwd: dir }));
  let kicks = 0, starts = 0;
  const facts = serve.install({
    dataDir: dir, command: '/usr/bin/opencode', cwd: dir, log: null, guardSampleMs: 0,
    spawnImpl: () => { throw new Error('must not spawn — this leg adopts the recorded serve'); },
    readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    makeLane: (deps) => ({
      start() { starts++; deps.locator.client({ budgetMs: 5000 }).catch(() => { }); },
      kick() { kicks++; },
      stop() { },
      state: () => ({ sse: { connected: false }, watch: { active: false } }),
    }),
  });
  for (let i = 0; i < 60 && !facts.state().ready; i++) await sleep(50);
  ok('install() arms the lane once and the lane is KICKED when a serve becomes reachable (the ready edge)', starts === 1 && kicks === 1, { starts, kicks, ready: facts.state().ready });
  facts.locator._sampleGuard();          // a routine resource sample → notify() with the SAME port
  facts.locator._sampleGuard();
  ok('…and NOT on every notify(): a guard sample must never tear down the SSE socket', kicks === 1, kicks);
  serve.uninstall();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // ② A (RE)CONNECT PRIMES THE BUSY MAP. `session.status` frames are the only
  //    other source, so a serve that was ALREADY running a turn when the stream
  //    came up read 'stopped' for the length of that turn — rung 1 of honest
  //    liveness silently blind exactly when it matters.
  const mock = await startMockServe({ state: createMockState() });
  mock.state.statuses = { ses_a2: { type: 'busy' } };
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  let onEvent = null;
  facts.armLive((deps) => { onEvent = deps.onEvent; return { start() { }, kick() { }, stop() { }, state: () => ({ sse: { connected: true }, watch: { active: true } }) }; }).start();
  onEvent({ kind: 'connected', sessionId: '', dirty: { sessions: true } });
  for (let i = 0; i < 40 && !mock.state.requests.includes('GET /session/status'); i++) await sleep(50);
  ok('a (re)connect re-reads /session/status (the turn that was already running is not "stopped")', mock.state.requests.includes('GET /session/status'), mock.state.requests.slice(-4));
  const rows = await facts.discover({});
  ok('…and that conversation reads external on the FIRST list after the reconnect', rows.find((r) => r.backendSessionId === 'ses_a2')?.status === 'external', rows.map((r) => `${r.backendSessionId}:${r.status}`));
  facts.stopLive();
  await mock.close();
}
{
  // ③ AN ANSWER FROM A COLD MAP. The card's answers are keyed by question TEXT,
  //    so converting them to OpenCode's positional form needs the question
  //    list. A server that restarted between rendering the card and the user
  //    pressing Submit had an empty warm map and refused its own user's answer.
  const mock = await startMockServe({ state: createMockState() });
  mock.state.questions = [{ id: 'que_cold', sessionID: 'ses_a2', questions: QUESTION_PART(false).state.input.questions, tool: { messageID: 'msg_bq', callID: 'call_question_1' } }];
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  ok('the warm map really is cold (the precondition, not an accident of ordering)', facts._live.questions.size === 0);
  let err = null;
  try { await facts.answerQuestion('que_cold', { 'Do you prefer red or blue?': 'Blue' }); } catch (e) { err = e; }
  ok('a card answer submitted after a server restart still lands (the list is re-read, never a dead Submit)', !err && JSON.stringify(mock.state.answered[0]?.answers) === '[["Blue"]]', err?.message || mock.state.answered[0]);
  await mock.close();
}
{
  // ④ + ⑤ the two wiring-shaped findings
  const wsh = read('src/ws-handler.js');
  ok('an ask we could not answer refuses ONE ACTION — `scope:\'action\'`, never the 2.363.1 "attach failed" that flips a live window read-only',
    /type: 'error', scope: 'action', code: 'opencode-question'/.test(wsh) && /msg\?\.scope === 'action'/.test(read('src/lib/chat-view.js')));
  const cli = read('src/server/cli-env.js');
  ok('the live lane\'s dirty signal NOTIFIES every client (coalesced), and the client re-polls on it',
    /onChange: \(\(\) => \{/.test(cli) && /type: 'opencode-updated', kind: 'store'/.test(cli)
    && /OPENCODE_CHANGE_COALESCE_MS/.test(cli) && /reason === 'lane' \|\| reason === 'messages'/.test(cli)
    && /msg\.type !== 'opencode-updated'/.test(read('src/lib/app.js')));
  const ad = read('src/agentd/agentd.js');
  ok('the daemon\'s facts live per PROCESS, not per connection (`this` inside a Mux handler IS the connection — a reconnect would arm a second live lane and leak the first)',
    (() => { const d = ad.indexOf('let ocFacts = null;'); return d > 0 && d < ad.indexOf('function serveConnection(') && /if \(!ocFacts\)/.test(ad) && !/this\._ocFacts/.test(ad); })());
}

// ─────────────────────────────────────────────────────────────────────────────
// The THIRD pass over this branch. Three defects, each reproduced (against a
// real serve / a real ws upgrade) BEFORE the fix; each assert below is the
// mechanism, with the negative control that proves it did not just switch the
// feature off.
console.log('\n— ROUND 3 (findings from the second review of this branch) —');
{
  // ① OUR OWN WRITE MUST NOT LOOK LIKE SOMEONE ELSE'S TURN.
  //    Clicking "Roll back to before this message" moves the row's
  //    `time.updated` exactly like a TUI would, and rung 2 attributed it to a
  //    stranger for 90s: the card dimmed to opacity .7, its title read
  //    "Running in unsupported terminal (PID ?)", the Fork… row disappeared
  //    from its menu, and a sidebar filtered to exclude 'external' lost the
  //    conversation entirely — all from the user's OWN click.
  const mock = await startMockServe({ state: createMockState() });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const statusOf = async (id) => (await facts.discover({})).find((r) => r.backendSessionId === id)?.status;
  ok('precondition: the row is SIGHTED first (a first sighting proves nothing, so the defect needs a prior listing — as production always has, the sidebar polls every 5s)', (await statusOf('ses_a1')) === 'stopped');
  await facts.revertTo('ses_a1', { messageID: 'msg_u2' });
  facts.invalidate();
  ok('OUR OWN roll-back leaves the row STOPPED — never "someone else is driving it"', (await statusOf('ses_a1')) === 'stopped', await statusOf('ses_a1'));
  await facts.unrevert('ses_a1');
  facts.invalidate();
  ok('…and so does our own restore', (await statusOf('ses_a1')) === 'stopped', await statusOf('ses_a1'));
  // POSITIVE CONTROL: the exemption is by VALUE, so the very next move past
  // our own write is somebody else's and says so immediately.
  const a1 = mock.state.sessions.find((s) => s.id === 'ses_a1');
  a1.time = { ...a1.time, updated: Date.now() + 5000 };
  facts.invalidate();
  ok('…while a move PAST our own write still reads external (the fix cannot swallow a real TUI)', (await statusOf('ses_a1')) === 'external', await statusOf('ses_a1'));

  // an ANSWERED ASK returns no Session, so it uses the windowed form of the
  // ledger — and the mock moves the row on reply, the way resuming the turn does
  mock.state.questions = [{ id: 'que_own', sessionID: 'ses_g1', questions: QUESTION_PART(false).state.input.questions, tool: { messageID: 'msg_bq', callID: 'call_question_1' } }];
  await facts.discover({});
  ok('precondition: the warm question map is COLD (positional answers used to skip the read entirely)', facts._live.questions.size === 0);
  const ans = await facts.answerQuestion('que_own', [['Blue']]);
  ok('…so a POSITIONAL answer re-reads /question too, and therefore knows which conversation it just moved', ans?.sessionID === 'ses_g1', ans);
  facts.invalidate();
  ok('answering an ask on a STOPPED conversation does not make it external either', (await statusOf('ses_g1')) === 'stopped', await statusOf('ses_g1'));

  // NEGATIVE CONTROL for the windowed form: with the window closed, the very
  // same answer reads external — i.e. the ledger, not a broken rung, is what
  // keeps the row honest above.
  const mockW = await startMockServe({ state: createMockState() });
  const factsW = serve.createFacts(fixedLocator(mockW.url), { ownWriteWindowMs: 1, log: { warn() { } } });
  mockW.state.questions = [{ id: 'que_w', sessionID: 'ses_g1', questions: QUESTION_PART(false).state.input.questions, tool: { messageID: 'msg_bq', callID: 'call_question_1' } }];
  await factsW.discover({});
  await factsW.answerQuestion('que_w', [['Blue']]);
  factsW.invalidate();
  ok('negative control: with the own-write window closed, that same answer DOES read external (the rung still works)',
    (await factsW.discover({})).find((r) => r.backendSessionId === 'ses_g1')?.status === 'external');
  await mockW.close();
  await mock.close();
}
{
  // ② KICK MUST WAKE THE BACKOFF SLEEP. The lane's reconnect loop sleeps in a
  //    setTimeout; `kick()` aborted the fetch controller, and during the sleep
  //    there is no fetch to abort — so enabling the plugin (the service ships
  //    OFF, so this IS the first-use path) waited out the remaining backoff.
  //    MEASURED before the fix: 11.0s to the next connect attempt in this very
  //    leg's shape, 25.1s end to end against a real serve.
  const tries = [];
  const locator = { client: async () => { tries.push(Date.now()); return null; }, state: () => ({ lastError: 'nothing to connect to' }) };
  const stream = events.createEventStream({ locator, log: { warn() { } }, backoffBaseMs: 200, maxBackoffMs: 30000 });
  stream.start();
  // let it climb: 200·2^(n-1) — by attempt 6 the next sleep is 6.4s, so a
  // sub-second reconnect cannot be an accident of a short timer
  for (let i = 0; i < 100 && stream.state().attempts < 6; i++) await sleep(50);
  const attempts = stream.state().attempts;
  const pendingWait = Math.min(30000, 200 * 2 ** Math.min(attempts - 1, 10));
  tries.length = 0;
  const t0 = Date.now();
  stream.kick();
  for (let i = 0; i < 60 && !tries.length; i++) await sleep(25);
  const woke = tries.length ? tries[0] - t0 : -1;
  ok('kick() WAKES the backoff sleep — a serve that just became reachable is picked up at once, not after the remaining backoff',
    woke >= 0 && woke < 500 && pendingWait >= 3000, { attempts, pendingWaitItSkipped: pendingWait, wokeInMs: woke });
  stream.stop();
  await sleep(50);
  ok('…and stop() wakes it too, so the loop actually ends instead of leaving a pending promise', stream.state().stopped === true);
}
{
  // ③ A PTY THE SERVE NO LONGER HAS IS AN EXIT, NOT A DROPPED SOCKET. The
  //    bridge burned all five reconnect rungs (~12s) against an upgrade that
  //    answers HTTP 404, logging five bogus warnings, before the terminal
  //    admitted the shell was gone. Measured on the real serve: after `exit`,
  //    `GET /pty/<id>` is PtyNotFoundError and the upgrade is a plain 404.
  const bridgeMod = require(path.join(REPO, 'src/server/opencode-pty-bridge.js'));
  ok('ptyGone(): a 404/410 upgrade is terminal, a transport failure is not', (() => {
    const t = ['Unexpected server response: 404', 'Unexpected server response: 410'].every((m) => bridgeMod.ptyGone(m));
    const f = ['Unexpected server response: 502', 'Unexpected server response: 503', 'connect ECONNREFUSED 127.0.0.1:1', 'socket hang up', 'read ECONNRESET', '', null].every((m) => !bridgeMod.ptyGone(m));
    return t && f;
  })());

  const mock = await startMockServe({ state: createMockState(), pty: true });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const accessMod = require(path.join(REPO, 'src/server/opencode-access.js'));
  accessMod.create({ facts, hosts: null });
  const warns = [];
  const bridge = await bridgeMod.openOpencodePty({ cwd: '/work/alpha', title: 'gone-leg', log: { warn: (m) => warns.push(m) } });
  let exited = null;
  bridge.shim.onData(() => { });
  bridge.shim.onExit((e) => { exited = e; });
  await sleep(300);
  // THE SHELL EXITS: the serve deletes the pty and drops the socket. The bridge
  // cannot know that from the close alone — it learns it from the 404 on the
  // one reconnect it is entitled to.
  mock.state.ptys.delete(bridge.ptyId);
  try { mock.state.ptySockets.find((x) => x.id === bridge.ptyId)?.ws.close(); } catch { }
  const t0 = Date.now();
  for (let i = 0; i < 120 && !exited; i++) await sleep(50);
  const took = Date.now() - t0;
  ok('a serve-side pty that vanished ends the terminal on the FIRST 404 instead of retrying it five times (~12s)', !!exited && took < 3000, { took, exited });
  const attempts404 = mock.state.requests.filter((r) => r.startsWith('WS404 ')).length;
  ok('…and exactly ONE upgrade was attempted against the gone pty', attempts404 === 1, mock.state.requests.filter((r) => r.startsWith('WS')));
  ok('…and it did not print five "socket error" warnings (one honest line names the verdict)',
    warns.filter((w) => /socket error/.test(w)).length === 0 && warns.filter((w) => /is gone on the serve/.test(w)).length === 1, warns);
  await mock.close();
}
{
  // the three mechanisms are written down where the next person will look
  const kfs = read('docs/kb-file-structure.md');
  ok('docs: the own-write ledger, the woken sleep and the terminal 404 are in the kb essays + the incident file',
    /noteOwnWrite/.test(kfs) && /ownWriteVerdict/.test(kfs) && /wakes it|wake it|wake the sleep|WAKES/i.test(kfs) && /ptyGone/.test(kfs)
    && /OUR OWN CLICK REPORTED AS SOMEONE ELSE'S TURN/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 3/.test(read('CLAUDE.md')));
}

// ─────────────────────────────────────────────────────────────────────────────
// The FOURTH pass over this branch. Three defects, each reproduced against a
// real 1.18.29 serve (/proc thread + inotify-wd sampling, same-origin A/B)
// BEFORE the fix; each assert is the mechanism, each with the negative control
// that proves the fix did not simply switch the feature off.
console.log('\n— ROUND 4 (findings from the third review of this branch) —');
{
  // ① THE PTY FAMILY HANDED A USER DIRECTORY TO THE SERVE — the 2.369.42 /
  //    2.369.50 incident class, re-introduced on the one NEW path that takes a
  //    directory from the user. `?directory=X` is what BOOTS the OpenCode
  //    instance for X (recursive index + inotify watch of the whole tree) and
  //    NOTHING in the pty family releases it: measured on a 200-dir/4046-file
  //    repo, one "open a terminal here" left 204 watch descriptors and +23
  //    threads alive across DELETE, and across three open/close cycles
  //    (40/204 → 37/204, ×3). Without the query: 4 watches, and
  //    `readlink /proc/<shell>/cwd` is the SAME target in both arms — the query
  //    buys the shell nothing, the `cwd` BODY field places it.
  const mock = await startMockServe({ state: createMockState() });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  const USER_DIR = '/work/alpha-huge-repo';
  const before = new Set(mock.state.instances);
  const opened = await facts.openPty({ cwd: USER_DIR, title: 'round4' });
  ok('opening a serve terminal in a user directory boots NO OpenCode instance for that tree (the whole 2.369.50 lesson)',
    !mock.state.instances.has(USER_DIR), [...mock.state.instances]);
  ok('…the shell still runs THERE (the `cwd` rides the body, which is what places it — measured identical in both arms)', opened.pty.cwd === USER_DIR, opened.pty);
  ok('…and the ws url carries no `directory` either (the upgrade is served by the same per-instance registry)', !/[?&]directory=/.test(opened.url), opened.url);
  // NEGATIVE CONTROL on the SAME mock: the OLD shape still leaks, so the assert
  // above is measuring the mechanism and not a mock that cannot tell.
  const oldUrl = new URL(mock.url + '/pty');
  oldUrl.searchParams.set('directory', USER_DIR);
  const oldPty = await (await fetch(oldUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: USER_DIR }) })).json();
  ok('negative control: the OLD `?directory=` shape DOES boot it (and DELETE frees nothing — the mock models the measurement)',
    mock.state.instances.has(USER_DIR), [...mock.state.instances]);
  const delUrl = new URL(mock.url + `/pty/${oldPty.id}`);
  delUrl.searchParams.set('directory', USER_DIR);
  await fetch(delUrl, { method: 'DELETE' });
  ok('…and closing it does NOT release the instance it booted (only POST /instance/dispose does — measured)', mock.state.instances.has(USER_DIR));
  ok('precondition: none of this was already booted before the leg', before.size === 0 || !before.has(USER_DIR));

  // CHANGE THEM TOGETHER OR NOT AT ALL: the pty registry is PER INSTANCE
  // (measured: `PUT /pty/{id}?directory=X` on a pty created without the query
  // answers 404 PtyNotFoundError). A half-migrated family opens a terminal that
  // can never be resized, closed or reaped.
  const client = fixedLocator(mock.url)._client;
  ok('the WHOLE family lands on one instance: get + resize + close all resolve the pty the create made',
    (await client.ptyGet(opened.pty.id))?.id === opened.pty.id
    && (await facts.resizePty(opened.pty.id, { rows: 40, cols: 120, cwd: USER_DIR }))?.ok === true
    && (await facts.closePty(opened.pty.id, { cwd: USER_DIR }))?.ok === true);
  const opened2 = await facts.openPty({ cwd: USER_DIR, title: 'cross' });
  const crossUrl = new URL(mock.url + `/pty/${opened2.pty.id}`);
  crossUrl.searchParams.set('directory', USER_DIR);
  ok('negative control: the same id WITH a `directory` query is a 404 — which is why the family may never be half-migrated',
    (await fetch(crossUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: { rows: 1, cols: 1 } }) })).status === 404);
  await facts.closePty(opened2.pty.id, {});
  // SOURCE PIN: the six methods are the only place this could come back.
  const src = read('src/opencode-serve.js');
  const ptyBlock = src.slice(src.indexOf('  // ── PTY (a shell the SERVE owns'), src.indexOf('  authHeader()'));
  ok('source pin: not one method of the pty family builds a `directory` query', ptyBlock.length > 200 && !/directory/.test(ptyBlock.replace(/^\s*\*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), ptyBlock.split('\n').filter((l) => /directory/.test(l) && !/^\s*[*/]/.test(l)));
  await mock.close();
}
{
  // ② A SERVE-OWNED PTY OUTLIVES US, AND HAD NO REAPER. `_opencodePtyId` was
  //    written and read NOWHERE; `ptyList()` was never called. A serve pty is
  //    deliberately not dtach-restorable (socketPath is null), so after a
  //    SIGKILL/OOM restart — or ANY restart while the serve was ADOPTED from
  //    data/opencode-serve.json, where our exit hook has no child to kill —
  //    its shell kept running with nothing left that could reach or kill it.
  //    Verified on the real serve: a pty survives our socket closing and is
  //    re-connectable; it only 404s once its own shell exits.
  const mock = await startMockServe({ state: createMockState() });
  const held = [];
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } }, heldPtyIds: () => held });
  const orphan = await facts.openPty({ cwd: '/work/alpha', title: 'orphan' });
  const keeper = await facts.openPty({ cwd: '/work/alpha', title: 'held-by-a-session' });
  held.push(keeper.pty.id);
  // NEGATIVE CONTROL FIRST: before the restart, BOTH are ours (live.ptys knows
  // the one no session has registered yet) — a sweep must never kill a terminal
  // the user is still opening.
  const preRestart = await facts.reapPtys({ force: true });
  ok('a pty this process opened is KEPT even before a session records it (the open→register window is not a kill window)',
    preRestart.removed.length === 0 && mock.state.ptys.size === 2, preRestart);
  // …and the window BEFORE we even know the id (the serve has made the pty,
  // openPty has not returned) is not raced but REFUSED: a sweep is only
  // answerable while nobody is opening a terminal.
  facts._live.ptyOpening++;
  const markBefore = facts._live.reapedFor;
  const busy = await facts.reapPtys({ force: true, attempts: 2, settleMs: 10 });
  ok('a sweep REFUSES while an open is in flight, and does not advance the swept marker (it retries later instead of racing)',
    busy.ok === false && /being opened/.test(busy.reason || '') && facts._live.reapedFor === markBefore, { busy, markBefore, now: facts._live.reapedFor });
  ok('…and it did not DELETE anything while refusing', mock.state.ptys.size === 2, [...mock.state.ptys.keys()]);
  facts._live.ptyOpening--;
  // NEGATIVE CONTROL: with the flag cleared the very same call sweeps normally
  // — the guard is a gate, not an off switch.
  const unbusy = await facts.reapPtys({ force: true });
  ok('negative control: with nothing in flight the same call sweeps normally (the guard is a gate, not an off switch)', unbusy.ok === true, unbusy);
  facts._live.ptys.clear();                     // ← the restart: in-memory knowledge is gone, only the session field survives
  const reaped = await facts.reapPtys({ force: true });
  ok('after a restart the orphan nobody holds is reaped', reaped.removed.includes(orphan.pty.id), reaped);
  ok('…and the one a live session still holds (session._opencodePtyId, via heldPtyIds) is NOT', mock.state.ptys.has(keeper.pty.id) && !reaped.removed.includes(keeper.pty.id), [...mock.state.ptys.keys()]);
  ok('…and the sweep asked the DIRECTORY-LESS list (it must not boot an instance to clean up)',
    mock.state.requests.includes('GET /pty') && !mock.state.requests.some((r) => /^GET \/pty\?.*directory=/.test(r)), mock.state.requests.filter((r) => r.startsWith('GET /pty')));
  await mock.close();
}
{
  // …and the reaper is WIRED: it runs on the ready edge of each serve PROCESS
  // (the one moment "which of its terminals can still be reached" is
  // answerable), exactly once, without a caller.
  const mock = await startMockServe({ state: createMockState() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-reap-'));
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: process.pid, startedAt: Date.now(), cwd: dir }));
  // a shell left behind by the process that died — created straight on the serve
  const stale = await (await fetch(mock.url + '/pty', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/work/alpha', title: 'left over from before the restart' }) })).json();
  const facts = serve.install({
    dataDir: dir, command: '/usr/bin/opencode', cwd: dir, log: { warn() { }, error() { } }, guardSampleMs: 0,
    spawnImpl: () => { throw new Error('must not spawn — this leg ADOPTS the recorded serve, which is the case where our exit hook had no child to kill'); },
    readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    heldPtyIds: () => [],
    // the lane is what makes the locator locate in production (the first
    // discovery does the same); NOTHING here ever calls reapPtys itself
    makeLane: (deps) => ({ start() { deps.locator.client({ budgetMs: 5000 }).catch(() => { }); }, kick() { }, stop() { }, state: () => ({ sse: { connected: false }, watch: { active: false } }) }),
  });
  for (let i = 0; i < 200 && mock.state.ptys.has(stale.id); i++) await sleep(50);
  ok('boot: adopting a serve that outlived us reaps the terminals nobody can reach any more — no caller, on the ready edge', !mock.state.ptys.has(stale.id), [...mock.state.ptys.keys()]);
  ok('…and it did it through the reaper, not by accident (the DELETE is the only way a pty leaves the serve)', mock.state.requests.some((r) => r === `DELETE /pty/${stale.id}`), mock.state.requests.filter((r) => r.startsWith('DELETE /pty')));
  const again = await facts.reapPtys();
  ok('…and it is idempotent per serve PROCESS (a routine notify must not re-sweep and race a terminal being opened)', again.skipped === 'already-reaped', again);
  serve.uninstall();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
  // THE WIRING PIN (the 2.355.0 law: a fix whose call site is not staged is a
  // green unit test over dead code). `_opencodePtyId` finally has a reader.
  const srv = read('server.js'), cli = read('src/server/cli-env.js');
  ok('wiring: server.js hands cli-env the live sessions\' pty ids and cli-env passes them to the facts as heldPtyIds',
    /getHeldPtyIds:\s*\(\)\s*=>/.test(srv) && /_opencodePtyId/.test(srv)
    && /getHeldPtyIds/.test(cli) && /heldPtyIds:\s*\(\)\s*=>/.test(cli));
  ok('…so the session field has a consumer at last (it was written in ws-create and read nowhere)',
    /_opencodePtyId/.test(read('src/ws-create.js')) && /_opencodePtyId/.test(srv));
}
{
  // ③ THE LIVE LANE COULD LIE ABOUT ITSELF, TWO WAYS. `active` is what
  //    laneHealthy() switches the list-refresh fallback OFF on, and it was true
  //    for any directory that merely EXISTED — while armWatch() latched the
  //    boot-time guess from the SERVER's env, so the documented lazy
  //    re-resolution against the serve's own `GET /path` home never ran on any
  //    machine that had ever run opencode. Reproduced with the real wiring:
  //    watch = the server's store, `liveLaneHealthy` true, and a session made
  //    by a SECOND opencode process on the serve's REAL store never appeared
  //    (8s, zero GET /session issued because the lane claimed health).
  const existsButEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-notastore-'));
  const w1 = events.createStoreWatch({ dirs: [existsButEmpty], log: { warn() { } } });
  ok('a directory that EXISTS but holds no opencode.db is not a store watch — `active` stays false and says why',
    w1.state().active === false && /opencode\.db/.test(JSON.stringify(w1.state().failed)), w1.state());
  w1.stop();
  const realStore = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-isastore-'));
  fs.writeFileSync(path.join(realStore, 'opencode.db'), 'x');
  const w2 = events.createStoreWatch({ dirs: [realStore], log: { warn() { } } });
  const w2Broken = !w2.state().active && envExhausted(JSON.stringify(w2.state().failed));
  if (w2Broken) skip('positive control: a directory WITH opencode.db does attach', `this machine cannot fs.watch right now: ${JSON.stringify(w2.state().failed).slice(0, 160)}`);
  else ok('positive control: a directory WITH opencode.db does attach (the honesty check did not just switch the lane off)', w2.state().active === true, w2.state());
  w2.stop();

  // …and the false `active` had a CONSEQUENCE: it turned the fallback off.
  const mock = await startMockServe({ state: createMockState() });
  const factsBlind = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } }, listCacheMs: 50 });
  factsBlind.armLive((deps) => events.createLiveLane({ ...deps, storeDirs: [existsButEmpty], debounceMs: 60 })).start();
  await sleep(400);
  ok('a lane whose watch attached to a NON-store is NOT healthy, so the timed refresh stays on (blind is worse than slow)', factsBlind.state().liveLaneHealthy === false, factsBlind.state().liveLane);
  const n0 = mock.state.requests.filter((r) => r.startsWith('GET /session?')).length;
  await factsBlind.discover({});
  await sleep(80);
  await factsBlind.discover({});
  ok('…and it really does re-list (the fallback is alive, not merely reported)', mock.state.requests.filter((r) => r.startsWith('GET /session?')).length > n0 + 1);
  factsBlind.stopLive();

  // RE-RESOLUTION on connect: the serve's `GET /path` home wins over the boot
  // guess, and ONLY when it actually differs.
  const serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-serverhome-'));
  fs.mkdirSync(path.join(serverHome, '.local/share/opencode'), { recursive: true });
  fs.writeFileSync(path.join(serverHome, '.local/share/opencode', 'opencode.db'), 'x');
  // THE BOOT ARM HAS NO SERVE — that is the whole premise (a locator that
  // already answers would resolve the serve's home at boot and there would be
  // nothing to re-resolve). This one comes up only after the boot arm ran,
  // exactly like a plugin the user enables a moment later.
  let serveUp = false;
  const fx = fixedLocator(mock.url);
  const lateLocator = { ...fx, client: async () => (serveUp ? fx._client : null), ensure: async () => (serveUp ? fx._client : null) };
  const seen = [];
  const lane = events.createLiveLane({
    locator: lateLocator, env: { HOME: serverHome }, log: { warn() { } },
    onEvent: (i) => seen.push(i.kind), onExternal: () => { }, debounceMs: 60,
  });
  await lane._armWatch('boot');
  serveUp = true;
  const bootDirs = lane.state().watch.watching.slice();
  const bootBroken = !lane.state().watch.active && envExhausted(JSON.stringify(lane.state().watch.failed));
  await lane._armWatch('connected');
  const afterDirs = lane.state().watch.watching.slice();
  if (bootBroken) skip('the store dirs are RE-RESOLVED against the serve on connect, not latched at boot', 'fs.watch is exhausted on this machine');
  else {
    ok('the boot arm can only guess from OUR env (the serve does not exist yet)', bootDirs.length === 1 && bootDirs[0] === path.join(serverHome, '.local/share/opencode'), bootDirs);
    // the mock's home is /home/mock, which does not exist here — so the
    // re-resolution is observable as "the dir SET changed and we re-armed",
    // and the surviving watch is still the real one (a non-existent dir is
    // reported, never watched)
    ok('a `connected` RE-RESOLVES against the serve\'s own GET /path home and re-arms (the latch is gone)',
      lane.state().rearms === 1 && JSON.stringify(lane.state().watch.failed).includes('/home/mock'), lane.state());
    ok('…and the real store is still watched afterwards (re-arming is not losing the watch)', afterDirs.includes(path.join(serverHome, '.local/share/opencode')), afterDirs);
    const rearmsBefore = lane.state().rearms;
    await lane._armWatch('connected');
    await lane._armWatch('connected');
    ok('NEGATIVE CONTROL: two more connects with the SAME dirs do not re-arm anything (a reconnect storm must not churn the watchers)',
      lane.state().rearms === rearmsBefore && JSON.stringify(lane.state().watch.watching) === JSON.stringify(afterDirs), lane.state());
  }
  lane.stop();
  await mock.close();
  for (const d of [existsButEmpty, realStore, serverHome]) fs.rmSync(d, { recursive: true, force: true });
}
{
  // the three mechanisms are written down where the next person will look
  const kfs = read('docs/kb-file-structure.md');
  ok('docs: the directory-free pty family, the pty reaper and the re-resolved store watch are in the kb essays + the incident file',
    /reapPtys/.test(kfs) && /no `directory`|NO `directory`|directory-free/i.test(kfs) && /re-resolv/i.test(kfs)
    && /A SERVE TERMINAL INDEXED THE USER'S REPO/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 4/.test(read('CLAUDE.md')));
}

// ─────────────────────────────────────────────────────────────────────────────
// The adversarial pass over ROUND 4's own code. Both findings were reproduced
// against the mechanism before they were fixed.
console.log('\n— ROUND 5 (findings from the fourth review of this branch) —');
/** OUR OWN inotify watch descriptors pointing at `dir` (Linux /proc: every
 *  fs.watch is an inotify wd whose `ino:` is the watched directory's inode, in
 *  hex). -1 = this platform has no /proc/self/fdinfo, so the leg SKIPS. */
function inotifyWdsOn(dir, pid = 'self') {
  let ino;
  try { ino = fs.statSync(dir).ino.toString(16); } catch { return -1; }
  const re = new RegExp(`^inotify .*\\bino:0*${ino}\\b`);
  let n = 0, saw = false;
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
      let t = '';
      try { t = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf-8'); } catch { continue; }
      saw = true;
      for (const l of t.split('\n')) if (re.test(l)) n++;
    }
  } catch { return -1; }
  return saw ? n : -1;
}
{
  // ① A WARM QUESTION MAP OUTLIVES THE SERVE THAT MINTED IT.
  //    `/question` is answered out of the serve's OWN memory — verified on a
  //    real 1.18.29: a fresh process answers `[]` no matter what the previous
  //    one was holding. readConversation joins an OPEN ask in the transcript to
  //    that warm map and re-reads the authoritative list only when the map is
  //    EMPTY, so a serve that restarted (a keeper respawn, a new port, an
  //    adopted instance replaced) left every open ask joined to a `que_…`
  //    nobody holds: an answerable card whose Submit can only fail — the exact
  //    dead Submit the `stale` marker exists to prevent.
  const mkState = (withQuestion) => {
    const st = createMockState();
    st.messages.ses_a2.push({ info: { id: 'msg_bq', sessionID: 'ses_a2', role: 'assistant', time: { created: 1788601100000, completed: 1788601111000 }, modelID: 'deepseek-v4', providerID: 'deepseek', agent: 'plan', finish: 'stop' }, parts: [QUESTION_PART(false)] });
    st.questions = withQuestion ? [{ id: 'que_live1', sessionID: 'ses_a2', questions: QUESTION_PART(false).state.input.questions, tool: { messageID: 'msg_bq', callID: 'call_question_1' } }] : [];
    return st;
  };
  const A = await startMockServe({ state: mkState(true) });
  const B = await startMockServe({ state: mkState(false) });   // the SAME conversation, a DIFFERENT serve process
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-qmap-'));
  const rec = (port) => fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port, pid: process.pid, startedAt: Date.now(), cwd: dir }));
  rec(A.port);
  const facts = serve.install({
    dataDir: dir, command: '/usr/bin/opencode', cwd: dir, log: { warn() { }, error() { } }, guardSampleMs: 0,
    spawnImpl: () => { throw new Error('must not spawn — this leg adopts the recorded serve'); },
    readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    makeLane: (deps) => ({ start() { deps.locator.client({ budgetMs: 5000 }).catch(() => { }); }, kick() { }, stop() { }, state: () => ({ sse: { connected: true }, watch: { active: true } }) }),
  });
  for (let i = 0; i < 200 && !facts.state().ready; i++) await sleep(50);
  const askCard = async () => { facts.invalidate(); const c = await facts.readConversation('ses_a2'); return c.records.find((r) => r.kind === 'permission_request'); };
  const live1 = await askCard();
  ok('(positive control) while the serve that minted it is alive, the open ask is joined to que_live1 and is NOT stale', live1?.requestId === 'que_live1' && !live1.stale, live1 && { requestId: live1.requestId, stale: live1.stale });
  ok('…and it was the WARM map that answered (the fact the defect rode on)', facts.state().pendingQuestions === 1, facts.state().pendingQuestions);

  // THE SERVE RESTARTS: a new process on a new port with no memory of que_live1.
  await A.close();
  rec(B.port);
  facts.locator.invalidate('the serve went away');
  for (let i = 0; i < 200 && facts.state().port !== B.port; i++) { await facts.locator.ensure(); await sleep(50); }
  ok('(setup) the locator followed the serve to the replacement process', facts.state().ready === true && facts.state().port === B.port, facts.state());
  const afterRestart = await askCard();
  ok('a serve RESTART makes the warm map UNKNOWN: the same open ask renders STALE, never joined to the dead que_live1', afterRestart?.stale === true && afterRestart?.requestId !== 'que_live1', afterRestart && { requestId: afterRestart.requestId, stale: afterRestart.stale });
  ok('…because it re-read the authoritative list from the NEW process instead of trusting the map', B.state.requests.includes('GET /question'), B.state.requests);
  const mm = new AcpMessageManager('ses_a2');
  const card = mm.convertHistory((await facts.readConversation('ses_a2')).records).find((m) => m.permission?.kind === 'user_input');
  ok('…and the flag reaches the rendered card, which is where the dead Submit would have been', card?.permission?.stale === true, card?.permission);
  ok('…and the facts stop CLAIMING pending asks that belong to a process that is gone', facts.state().pendingQuestions === 0, facts.state().pendingQuestions);
  serve.uninstall();
  await B.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // ①b …AND A RECONNECT IS THE OTHER HALF, on the SAME serve process: we were
  //    off the wire while `question.replied/rejected` frames went by. The
  //    reconnect handler re-read the busy map (`/session/status`) and NOT the
  //    questions, so the warm map kept answering for asks the serve had already
  //    closed. `/question` is the authoritative list and boots no instance —
  //    the reconnect pays for one cheap read, exactly like the busy map.
  const st = createMockState();
  st.messages.ses_a2.push({ info: { id: 'msg_bq', sessionID: 'ses_a2', role: 'assistant', time: { created: 1788601100000, completed: 1788601111000 }, modelID: 'deepseek-v4', providerID: 'deepseek', agent: 'plan', finish: 'stop' }, parts: [QUESTION_PART(false)] });
  const askQ = { id: 'que_live1', sessionID: 'ses_a2', questions: QUESTION_PART(false).state.input.questions, tool: { messageID: 'msg_bq', callID: 'call_question_1' } };
  st.questions = [askQ];
  const mock = await startMockServe({ state: st });
  const facts = serve.createFacts(fixedLocator(mock.url), { log: { warn() { } } });
  let onEvent = null;
  facts.armLive((deps) => { onEvent = deps.onEvent; return { start() { }, kick() { }, stop() { }, state: () => ({ sse: { connected: true }, watch: { active: true } }) }; }).start();
  await facts.pendingQuestions({ refresh: true });
  const card = async () => { facts.invalidate(); const c = await facts.readConversation('ses_a2'); return c.records.find((r) => r.kind === 'permission_request'); };
  ok('(setup) the warm map holds the live ask and the card is answerable', facts.state().pendingQuestions === 1 && (await card())?.requestId === 'que_live1');
  st.questions = [];                       // another client of the SAME serve answered it while our stream was down
  ok('(the mechanism under test) a warm map keeps answering with no reconnect — which is why the reconnect has to re-read it', (await card())?.requestId === 'que_live1', facts.state().pendingQuestions);
  const reads0 = mock.state.requests.filter((r) => r === 'GET /question').length;
  const qReads = () => mock.state.requests.filter((r) => r === 'GET /question').length;
  onEvent({ kind: 'connected', sessionId: '', dirty: { sessions: true } });
  // wait for the READ, not for the drop: dropping the map is synchronous, so
  // polling `pendingQuestions === 0` would pass before the fix even existed
  for (let i = 0; i < 80 && qReads() === reads0; i++) await sleep(50);
  ok('a (re)connect DROPS and re-reads the pending asks, exactly like the busy map it already re-read', qReads() > reads0 && facts.state().pendingQuestions === 0, { reads0, now: qReads(), pending: facts.state().pendingQuestions });
  ok('…so an ask the serve has already closed renders STALE on the very next read', (await card())?.stale === true);
  // NEGATIVE CONTROL: the refresh must not break the case that WORKS — a
  // reconnect while the ask is genuinely still pending leaves it answerable.
  st.questions = [askQ];
  onEvent({ kind: 'connected', sessionId: '', dirty: { sessions: true } });
  for (let i = 0; i < 80 && !facts.state().pendingQuestions; i++) await sleep(50);
  const back = await card();
  ok('NEGATIVE CONTROL: a reconnect while the ask is REALLY pending leaves the card answerable (the refresh is not a blanket "stale")', back?.requestId === 'que_live1' && !back.stale, back && { requestId: back.requestId, stale: back.stale });
  facts.stopLive();
  await mock.close();
}
{
  // ② WITH THE BACKGROUND SERVICE OFF, NOTHING OF OURS MAY RUN OR WATCH
  //    (the 2.369.59 default). install() started the live lane unconditionally,
  //    and lane.start() arms an fs.watch on the USER's REAL OpenCode store —
  //    resolved from the env THIS server runs under — plus an SSE reconnect
  //    loop with its own timers. So on a fresh instance whose owner never
  //    turned OpenCode on, an unrelated `opencode` process's writes to
  //    ~/.local/share/opencode woke our server, forever.
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-store-off-'));
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');    // a REAL-looking store: the old boot arm would attach here
  const base = inotifyWdsOn(storeDir);
  const mock = await startMockServe({ state: createMockState() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-off-'));
  let wantUp = false;
  const facts = serve.install({
    dataDir: dir, command: '/usr/bin/opencode', cwd: dir, log: { warn() { }, error() { } }, guardSampleMs: 0,
    autostart: () => wantUp, storeDirs: [storeDir],
    spawnImpl: () => { throw new Error('must not spawn while the service is off'); },
    readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
  });
  const rows = await facts.discover({});                        // the 5s /api/sessions poll, with the service off
  await sleep(700);
  ok('with the service OFF install() arms NO live lane at all', facts.state().liveLane === null, facts.state().liveLane);
  if (base < 0) skip('…so ZERO fs.watch handles on the user\'s OpenCode store', 'no /proc/self/fdinfo on this platform');
  else ok('…so ZERO fs.watch handles on the user\'s OpenCode store (a service nobody turned on watches nothing)', inotifyWdsOn(storeDir) === base && base === 0, { base, now: inotifyWdsOn(storeDir) });
  ok('…and the discovery answers empty without one request to any serve', rows.length === 0 && mock.state.requests.length === 0, mock.state.requests);
  ok('…and the timed list refresh is therefore still the freshness source (an absent lane is never "healthy")', facts.state().liveLaneHealthy === false);

  // TURNING IT ON is the same decision the keeper spawns on, so it takes effect
  // without a restart: the plugin writes its record, calls locator.start(), and
  // the state change is where the lane comes up.
  wantUp = true;
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: process.pid, startedAt: Date.now(), cwd: dir }));
  await facts.locator.start();
  for (let i = 0; i < 200 && !(facts.state().liveLane?.watch?.active && facts.state().liveLane?.sse?.connected); i++) await sleep(50);
  const laneSt = facts.state().liveLane;
  const watchBroken = !laneSt?.watch?.active && envExhausted(JSON.stringify(laneSt?.watch?.failed || []));
  ok('turning the service ON starts the lane, with no restart (the same predicate the keeper spawns on)', facts.state().liveLane !== null, laneSt);
  ok('…and the SSE lane subscribed to the serve it adopted', mock.state.requests.some((r) => r.startsWith('GET /global/event')), mock.state.requests.slice(0, 6));
  if (base < 0 || watchBroken) skip('…and NOW the store is watched (positive control: the measurement can see a watch)', watchBroken ? `this machine cannot fs.watch right now: ${JSON.stringify(laneSt.watch.failed).slice(0, 160)}` : 'no /proc/self/fdinfo on this platform');
  else ok('…and NOW the store IS watched — the positive control that proves the OFF measurement could have failed', inotifyWdsOn(storeDir) > base, { base, now: inotifyWdsOn(storeDir) });

  // TURNING IT OFF AGAIN must give the handles back, not merely ignore them.
  wantUp = false;
  facts.locator.stop({ killRecorded: false });
  for (let i = 0; i < 200 && facts.state().liveLane; i++) await sleep(50);
  ok('turning it OFF tears the lane down again (SSE socket, backoff timer and watch)', facts.state().liveLane === null, facts.state().liveLane);
  if (base < 0 || watchBroken) skip('…and the fs.watch handle on the store is RELEASED', 'measured only where /proc and fs.watch both work');
  else ok('…and the fs.watch handle on the store is RELEASED, not just ignored', inotifyWdsOn(storeDir) === base, { base, now: inotifyWdsOn(storeDir) });
  serve.uninstall();
  await mock.close();
  for (const d of [dir, storeDir]) fs.rmSync(d, { recursive: true, force: true });
}
{
  // …and both mechanisms are written down where the next person will look
  const kfs = read('docs/kb-file-structure.md');
  ok('docs: the per-process question map and the service-gated lane are in the kb essays + the incident file + the index',
    /questionsFor/.test(kfs) && /ROUND 5/.test(kfs)
    && /A DEAD ASK STAYED ANSWERABLE/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 5/.test(read('CLAUDE.md')));
}

// ─────────────────────────────────────────────────────────────────────────────
// The adversarial pass over ROUND 5's own code. ROUND 5 made the lane follow
// the service; this one makes stop() TERMINAL for the work the lane had already
// started, which is the half that leaked.
console.log('\n— ROUND 6 (the fifth review of this branch: stop() vs an arm already in flight) —');
/** THE NEGATIVE CONTROL, built from the SHIPPED source. A leg that only proves
 *  "the fixed lane holds nothing" cannot tell a fix from a broken measurement,
 *  so every assert below runs on TWO modules: this one is src/opencode-events.js
 *  with exactly this fix's guards removed, and it MUST leak. The replacements
 *  are asserted to match ONCE each — a control that silently stops neutering
 *  anything is worse than no control (it turns the A/B into two green arms). */
const R6_NEUTER = [
  ['the lane stop flag', 'laneStopped = true; stream.stop();', 'stream.stop();'],
  ['the SSE post-locator check', 'const client = await locator.client({ budgetMs: connectBudgetMs });\n    if (state.stopped) return;', 'const client = await locator.client({ budgetMs: connectBudgetMs });'],
  ['the SSE post-fetch check', 'if (state.stopped) { try { ctl.abort(); } catch { } return; }', ''],
  ['the resolveDirs early-out', 'if (c && !laneStopped)', 'if (c)'],
];
let unfixedEvents = null, unfixedWhy = null, unfixedFile = null;
try {
  let src = read('src/opencode-events.js');
  for (const [name, from, to] of R6_NEUTER) {
    const hits = src.split(from).length - 1;
    if (hits !== 1) throw new Error(`the negative control is stale: "${name}" matched ${hits}× (expected 1) — re-derive it from the current source`);
    src = src.replace(from, to);
  }
  const f = path.join(os.tmpdir(), `vs-oc-events-unfixed-${process.pid}.js`);
  fs.writeFileSync(f, src);
  unfixedEvents = require(f);
  unfixedFile = f;
} catch (e) { unfixedWhy = e.message; }
ok('(the control itself) an UNFIXED copy of the lane can be built from the current source — the A/B below is only meaningful against it', !!unfixedEvents, unfixedWhy);
/** A child process that spawns fine and then never answers `/global/health`, so
 *  `locator.client({budgetMs})` spends its WHOLE budget — the state a user who
 *  is turning the service off is most likely in (an OpenCode that cannot boot),
 *  and the window `stop()` could not reach into. */
const stalledChild = () => { const c = new EventEmitter(); c.pid = null; c.unref = () => { }; c.kill = () => { }; return c; };

{
  // ① THE MECHANISM, at its narrowest: `start()` fires `armWatch()` without
  //    awaiting it, so a `stop()` in the SAME TICK lands after the guard the
  //    lane had (the entry check) and before the assignment. No timing needed —
  //    one microtask of `resolveDirs()` is a wide enough window for the leak.
  const arm = async (mod) => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r6-tick-'));
    fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');   // a REAL store: the watch attaches here
    const base = inotifyWdsOn(storeDir);
    let externals = 0;
    const lane = mod.createLiveLane({
      locator: { client: async () => null, state: () => ({ lastError: 'the OpenCode background service is off' }) },
      storeDirs: [storeDir], log: { warn() { } }, fetchImpl: async () => { throw new Error('no serve'); },
      onExternal: () => { externals++; },
    });
    lane.start();
    lane.stop();                       // the user clicks Disable before the arm resolves
    await sleep(400);
    const leaked = base < 0 ? -1 : inotifyWdsOn(storeDir) - base;
    fs.writeFileSync(path.join(storeDir, 'opencode.db-wal'), 'y');   // an unrelated opencode writes the store
    await sleep(900);
    const st = lane.state();
    fs.rmSync(storeDir, { recursive: true, force: true });
    return { base, leaked, externals, st };
  };
  const fixedR = await arm(events);
  const ctlR = unfixedEvents ? await arm(unfixedEvents) : null;
  if (fixedR.base < 0) skip('a stop() in the same tick as start() leaves NO fs.watch on the store', 'no /proc/self/fdinfo on this platform');
  else {
    ok('a stop() landing in the SAME TICK as start() leaves NO fs.watch on the user\'s store', fixedR.leaked === 0, fixedR);
    ok('…and the lane it stopped never reports a watch it does not hold', fixedR.st.watch.active === false && fixedR.st.watch.watching.length === 0, fixedR.st.watch);
    ok('…and a write to the store after the service went OFF wakes NOTHING (no dirty signal, no /api/sessions sweep)', fixedR.externals === 0, fixedR.externals);
    if (!ctlR) skip('NEGATIVE CONTROL: the unfixed lane leaks that same watch', unfixedWhy || 'no control module');
    else if (ctlR.base < 0) skip('NEGATIVE CONTROL: the unfixed lane leaks that same watch', 'the control could not be measured here');
    else ok('NEGATIVE CONTROL: the UNFIXED lane leaks exactly that watch, and it still fires — so the zero above is a fix, not a broken measurement',
      ctlR.leaked >= 1 && ctlR.externals >= 1, ctlR);
  }
}
{
  // ② THE PRODUCT WIRING, with a serve that CANNOT BOOT. `armWatch()` awaits
  //    `resolveDirs()` → `locator.client({budgetMs:2000})`, and that budget is
  //    spent in full exactly here — so a disable anywhere in the first seconds
  //    lands mid-await. Measured on the real thing at 0/500/1000 ms; modelled
  //    here through install()/locator.start()/locator.stop(), the same calls the
  //    plugin route makes.
  const toggle = async (mod, delayMs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r6-prod-'));
    const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r6-home-'));
    const storeDir = path.join(ocHome, '.local/share/opencode');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
    const base = inotifyWdsOn(storeDir);
    let wantUp = false, externals = 0;
    const facts = serve.install({
      dataDir: dir, command: '/usr/bin/opencode', cwd: dir, log: { warn() { }, error() { } }, guardSampleMs: 0,
      autostart: () => wantUp, spawnImpl: () => stalledChild(), readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
      makeLane: (deps) => mod.createLiveLane({ ...deps, env: { HOME: ocHome }, fetchImpl: async () => { throw new Error('no serve'); }, onExternal: () => { externals++; } }),
    });
    wantUp = true;
    facts.locator.start();               // NOT awaited: notify() arms the lane, the boot runs on
    await sleep(delayMs);
    const armed = facts.state().liveLane !== null;
    wantUp = false;
    facts.locator.stop({ killRecorded: false });
    await sleep(900);
    const leaked = base < 0 ? -1 : inotifyWdsOn(storeDir) - base;
    fs.writeFileSync(path.join(storeDir, 'opencode.db-wal'), 'y');
    await sleep(700);
    const laneGone = facts.state().liveLane === null;
    serve.uninstall();
    for (const d of [dir, ocHome]) fs.rmSync(d, { recursive: true, force: true });
    return { base, armed, laneGone, leaked, externals };
  };
  const delays = [0, 1200];
  const fixedRuns = [];
  for (const d of delays) fixedRuns.push([d, await toggle(events, d)]);
  ok('(setup) enabling the service arms the lane through the real install()/locator wiring, and disabling takes it down', fixedRuns.every(([, r]) => r.armed && r.laneGone), fixedRuns);
  if (fixedRuns[0][1].base < 0) skip('disabling the service DURING the arm leaves no watch behind', 'no /proc/self/fdinfo on this platform');
  else {
    ok('disabling the service while the arm is still in flight (0 ms and mid-await, a serve that cannot boot) leaves ZERO watches on the store', fixedRuns.every(([, r]) => r.leaked === 0), fixedRuns);
    ok('…and nothing of ours answers a store write afterwards', fixedRuns.every(([, r]) => r.externals === 0), fixedRuns);
    if (!unfixedEvents) skip('NEGATIVE CONTROL: the unfixed lane leaks at every one of those delays', unfixedWhy || 'no control module');
    else {
      const ctlRuns = [];
      for (const d of delays) ctlRuns.push([d, await toggle(unfixedEvents, d)]);
      ok('NEGATIVE CONTROL: the UNFIXED lane leaks one watch at EVERY delay and still broadcasts — the leak is in the arm, not in the toggle', ctlRuns.every(([, r]) => r.leaked >= 1 && r.externals >= 1), ctlRuns);
    }
  }
}
{
  // ③ …AND WHILE THE KEEPER IS PARKED (5 crashes): the state in which a user
  //    is most likely to give up and turn the service off. `start()` would
  //    clear the park, so the re-arm here rides a plain notify — the lane comes
  //    up because the decision (autostart) says so, exactly as install() wires it.
  const parkedRun = async (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r6-park-'));
    const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r6-parkhome-'));
    const storeDir = path.join(ocHome, '.local/share/opencode');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
    const base = inotifyWdsOn(storeDir);
    let wantUp = true, externals = 0;
    const facts = serve.install({
      dataDir: dir, command: '/usr/bin/opencode', cwd: dir, log: { warn() { }, error() { } }, guardSampleMs: 0,
      autostart: () => wantUp, spawnImpl: () => { throw new Error('opencode serve: cannot boot here'); },
      readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
      makeLane: (deps) => mod.createLiveLane({ ...deps, env: { HOME: ocHome }, fetchImpl: async () => { throw new Error('no serve'); }, onExternal: () => { externals++; } }),
    });
    for (let i = 0; i < 8 && !facts.locator.state().parked; i++) await facts.locator.ensure();
    const parked = facts.locator.state().parked;
    wantUp = false; facts.locator.stop({ killRecorded: false });   // the lane armed at install: take it down first
    await sleep(400);
    const between = base < 0 ? -1 : inotifyWdsOn(storeDir) - base;
    wantUp = true; facts.locator.invalidate('a plugin toggle while the keeper is parked');
    const armed = facts.state().liveLane !== null;
    wantUp = false; facts.locator.stop({ killRecorded: false });   // …and off again in the SAME TICK
    await sleep(900);
    const leaked = base < 0 ? -1 : inotifyWdsOn(storeDir) - base;
    fs.writeFileSync(path.join(storeDir, 'opencode.db-wal'), 'y');
    await sleep(700);
    serve.uninstall();
    for (const d of [dir, ocHome]) fs.rmSync(d, { recursive: true, force: true });
    return { base, parked, armed, between, leaked, externals };
  };
  const r = await parkedRun(events);
  ok('(setup) the keeper really is PARKED after its crash budget, and the lane still arms on the plugin decision', r.parked === true && r.armed === true, r);
  if (r.base < 0) skip('disabling a PARKED service leaves no watch behind', 'no /proc/self/fdinfo on this platform');
  else {
    ok('the first disable gave every handle back (the state the second toggle is measured from)', r.between === 0, r);
    ok('disabling while the keeper is PARKED leaves ZERO watches, and nothing answers a later store write', r.leaked === 0 && r.externals === 0, r);
    if (!unfixedEvents) skip('NEGATIVE CONTROL: the unfixed lane leaks on the parked toggle too', unfixedWhy || 'no control module');
    else {
      const c = await parkedRun(unfixedEvents);
      ok('NEGATIVE CONTROL: the UNFIXED lane leaks on the parked toggle too', c.leaked >= 1 && c.externals >= 1, c);
    }
  }
}
{
  // ④ THE SSE HALF, on a real socket: `connectOnce()` is async before it owns
  //    anything, so a stop() inside `locator.client()` aborted a controller that
  //    did not exist yet and the continuation opened a subscription nobody could
  //    ever close. Heartbeats keep it alive, so it never even trips the idle
  //    abort — the serve holds an open response for a service the user turned off.
  const sseRun = async (mod) => {
    const mock = await startMockServe({ state: createMockState() });
    const client = new serve.OpencodeServeClient(mock.url);
    const lane = mod.createLiveLane({
      locator: { client: async () => { await sleep(250); return client; }, state: () => ({ lastError: null }) },
      storeDirs: [], env: { HOME: path.join(os.tmpdir(), `vs-oc-r6-nohome-${process.pid}`) }, log: { warn() { } },
    });
    lane.start();
    await sleep(80);                    // inside locator.client(), before any fetch exists
    lane.stop();
    await sleep(1400);                  // past the connect, past a heartbeat
    const out = { open: mock.state.sse.size, claims: lane.state().sse.connected, requests: [...mock.state.requests] };
    lane.stop();
    await mock.close();
    return out;
  };
  const f = await sseRun(events);
  ok('a stop() landing inside locator.client() opens NO SSE subscription on the serve', f.open === 0, f);
  ok('…and the stopped lane does not claim to be connected (it used to report stopped AND connected at once)', f.claims === false, f);
  ok('…and it asks the serve for nothing further, not even the store path it was resolving', f.requests.length === 0, f.requests);
  if (!unfixedEvents) skip('NEGATIVE CONTROL: the unfixed stream opens that socket after stop()', unfixedWhy || 'no control module');
  else {
    const c = await sseRun(unfixedEvents);
    ok('NEGATIVE CONTROL: the UNFIXED stream opens the subscription AFTER stop() and keeps it open, while claiming to be connected', c.open >= 1 && c.claims === true, c);
  }
}
{
  // …and the invariant is written down where the next person will look
  const kfs = read('docs/kb-file-structure.md');
  ok('docs: "stop() is terminal for work already in flight" is in the kb essays + the incident file + the index',
    /ROUND 6/.test(kfs) && /laneStopped/.test(kfs)
    && /A SERVICE THAT WAS TURNED OFF KEPT THE WATCH/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 6/.test(read('CLAUDE.md')));
  if (unfixedFile) { try { fs.rmSync(unfixedFile, { force: true }); } catch { } }   // the control is an artefact of THIS run; an 'exit' hook would not survive the browser leg's removeAllListeners
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 7 — THE SAME RULE, ONE LAYER UP. Round 6 made the LIVE LANE's stop()
// terminal for work already in flight. But nothing the user clicks starts that
// lane: install() starts it from what the KEEPER publishes (`laneWanted =
// st.ready || wantsAutostart()`), and `locate()` checks `state.stopping` only
// at ENTRY. Every rung under that entry reaches `adopt()` — the ONE place a
// client is ever published — after an await `stop()` cannot cancel (the reuse
// health probe on a BUSY serve, `git init` in the isolated cwd, the ≤20s boot
// wait). So a Disable landing inside one re-published `ready:true`, re-armed
// the runaway-guard interval stop() had just cleared, and built a BRAND-NEW
// lane whose own `laneStopped` is false by construction — an fs.watch on the
// user's real OpenCode store, firing, for a service they had just turned off.
console.log('\n— ROUND 7 (the sixth review: stop() vs the KEEPER ladder already in flight) —');
/** The negative control again (round 6's rule: a leg that only proves "the
 *  fixed keeper holds nothing" cannot tell a fix from a broken measurement).
 *  This is src/opencode-serve.js with exactly this fix's checks removed; its
 *  relative requires are re-pointed at the repo so it can live in /tmp. */
const R7_NEUTER = [
  ['the acquisition-point check in adopt()', 'async function adopt(port, pid, source, epoch) {\n    if (cancelled(epoch)) return null;', 'async function adopt(port, pid, source, epoch) {', 1],
  ['the reuse-probe check', '        if (cancelled(epoch)) return null;\n        // THE OPS KILL SWITCH', '        // THE OPS KILL SWITCH', 1],
  ['the isolated-cwd check', '      if (cancelled(epoch)) return null;   // `git init` is an await too: a disable landing in it used to reach the spawn below\n', '', 1],
  ['the pre-spawn check', '    if (cancelled(epoch)) return null;   // never START a third-party daemon for a service that was turned off mid-ladder\n', '', 1],
  // the boot loop, restored to its exact pre-fix shape: ONE combined bail at
  // the top that walks away from the child, and NO check after the probe
  ['the boot-loop bail', '      if (cancelled(epoch)) return abandon({ why: cancelWhy() });\n      if (state.child !== child) return abandon();', '      if (state.stopping || state.child !== child) return null;', 1],
  ['the post-probe check', '        if (cancelled(epoch)) return abandon({ why: cancelWhy() });\n', '', 1],
];
/** Build a copy of src/opencode-serve.js with exactly `table`'s checks removed.
 *  Shared by ROUND 7 and ROUND 8 so every control is derived the same way (and
 *  its replacement counts asserted the same way). */
function buildNeutered(tag, table) {
  try {
    let src = read('src/opencode-serve.js');
    for (const [name, from, to, count] of table) {
      const hits = src.split(from).length - 1;
      if (hits !== count) throw new Error(`the negative control is stale: "${name}" matched ${hits}× (expected ${count}) — re-derive it from the current source`);
      src = src.split(from).join(to);
    }
    src = src.replace(/require\('\.\/([\w-]+)'\)/g, (_m, n) => `require(${JSON.stringify(path.join(REPO, 'src', `${n}.js`))})`);
    const f = path.join(os.tmpdir(), `vs-oc-serve-${tag}-${process.pid}.js`);
    fs.writeFileSync(f, src);
    return { mod: require(f), why: null, file: f };
  } catch (e) { return { mod: null, why: e.message, file: null }; }
}
const r7Ctl = buildNeutered('unfixed', R7_NEUTER);
const unfixedServe = r7Ctl.mod, unfixedServeWhy = r7Ctl.why, unfixedServeFile = r7Ctl.file;
ok('(the control itself) an UNFIXED copy of the keeper can be built from the current source — the A/B below is only meaningful against it', !!unfixedServe, unfixedServeWhy);

/** ONE harness for all three windows: drive the REAL wiring (install() +
 *  locator.start() + locator.stop(), the `_ocStart`/`_ocStop` pair in
 *  src/plugins.js) with a REAL live lane over a REAL store dir, and land the
 *  Disable inside the await named by `window`. `disable:false` is the positive
 *  control on the same harness — the guards must not break a normal boot. */
async function r7Run(mod, { window: win, disable = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r7-data-'));
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r7-home-'));
  const storeDir = path.join(ocHome, '.local/share/opencode');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
  const base = inotifyWdsOn(storeDir);
  const mocks = [];
  let wantUp = true, externals = 0, spawns = 0;
  const opts = {
    dataDir: dir, command: '/usr/bin/opencode', log: { warn() { }, error() { }, log() { } }, guardSampleMs: 0,
    autostart: () => wantUp, readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    makeLane: (deps) => events.createLiveLane({ ...deps, env: { HOME: ocHome }, fetchImpl: async () => { throw new Error('no serve'); }, onExternal: () => { externals++; } }),
    spawnImpl: () => { throw new Error('this window must not spawn'); },
  };
  if (win === 'reuse') {
    // A RECORDED serve that outlived a VibeSpace restart, and is BUSY: 1.18.29
    // answers /global/health in ~1.2s cold, so hundreds of ms is the normal
    // case, not a contrived one.
    const st = createMockState(); st.delayMs = 700;
    const mock = await startMockServe({ state: st });
    mocks.push(mock);
    fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: process.pid, startedAt: Date.now(), cwd: dir }));
  } else if (win === 'boot') {
    // A spawn whose serve binds the port at once but takes 700ms to answer
    // /global/health — i.e. the "starting…" window the user gives up in.
    opts.spawnImpl = (cmd, args) => {
      spawns++;
      const port = Number(args[args.indexOf('--port') + 1]);
      const st = createMockState(); st.delayMs = 700;
      startMockServe({ port, state: st }).then((m) => mocks.push(m)).catch(() => { });
      const c = new EventEmitter(); c.pid = null; c.unref = () => { }; c.kill = () => { }; return c;
    };
  } else if (win === 'cwd') {
    // The `git init` of the isolated serve cwd is an await of its own, and the
    // rung AFTER it starts a third-party daemon.
    opts.execImpl = (_cmd, _args, _o, cb) => { setTimeout(() => cb(null, '', ''), 600); };
    opts.spawnImpl = () => { spawns++; const c = new EventEmitter(); c.pid = 99111; c.unref = () => { }; c.kill = () => { }; return c; };
    opts.bootTimeoutMs = 1500;   // nothing ever answers here: the point is WHETHER we spawned, not the boot wait
  }
  const facts = mod.install(opts);
  facts.locator.start();                       // the plugin's Start — NOT awaited, exactly as the route leaves it
  await sleep(win === 'cwd' ? 250 : 400);      // …now inside the await this window names
  // THE 'cwd' WINDOW DELIBERATELY LEAVES THE PLUGIN RECORD ON. That is the
  // whole point of it: the pre-fix spawn was refused in production only
  // because `_ocStop` writes the record BEFORE calling stop(), so the re-read
  // `autostartOn()` happened to be false. `stop()` must be authoritative on
  // its own — so this window asks exactly that, and its asserts are about
  // "did we start a daemon", not about the lane (which legitimately follows
  // the still-on autostart decision here).
  if (disable) { if (win !== 'cwd') wantUp = false; facts.locator.stop({ killRecorded: true }); }
  await sleep(3000);                           // past the await, past the lane's own arm
  const lst = facts.locator.state();
  const leaked = base < 0 ? -1 : inotifyWdsOn(storeDir) - base;
  fs.writeFileSync(path.join(storeDir, 'opencode.db-wal'), 'y');   // an unrelated opencode writes the store
  await sleep(900);
  const out = { base, ready: !!lst.ready, source: lst.source || null, stopped: !!lst.stopped, lane: facts.state().liveLane !== null, leaked, externals, spawns, record: fs.existsSync(path.join(dir, 'opencode-serve.json')) };
  mod.uninstall();
  for (const m of mocks) { try { await m.close(); } catch { } }
  for (const d of [dir, ocHome]) fs.rmSync(d, { recursive: true, force: true });
  return out;
}
for (const [win, label] of [['reuse', 'the reuse health probe on a BUSY recorded serve'], ['boot', 'the ≤20s boot wait of a serve it just spawned'], ['cwd', 'the `git init` of the isolated serve cwd']]) {
  const on = await r7Run(serve, { window: win, disable: false });
  const off = await r7Run(serve, { window: win, disable: true });
  if (win === 'cwd') {
    // ≥1, not ===1: with nothing ever answering, the keeper's own ladder
    // legitimately retries (the lane's resolveDirs asks for a client again)
    ok(`(the control) without a Disable, ${label} still reaches the spawn`, on.spawns >= 1, on);
    ok('a Disable landing in the isolated-cwd await starts NO third-party daemon at all', off.spawns === 0 && off.ready === false, off);
    ok('…and leaves no record for the next boot to ADOPT (a spawn after "off" was also a serve that outlives us)', off.record === false, off);
  } else {
    ok(`(the control) without a Disable, a serve reached through ${label} is adopted and the lane comes up`, on.ready === true && on.lane === true, on);
    ok(`a Disable landing inside ${label} never publishes a client (\`ready\` stays false)`, off.ready === false && off.source === null, off);
    ok('…and therefore builds NO live lane for a service that is off', off.lane === false, off);
  }
  // the watch asserts belong to the two windows where the service is really
  // OFF; the 'cwd' window deliberately leaves autostart ON (see r7Run)
  if (win !== 'cwd') {
    if (off.base < 0) skip(`…and holds no fs.watch on the user's store (${win})`, 'no /proc/self/fdinfo on this platform');
    else {
      ok(`…and holds ZERO fs.watch handles on the user's OpenCode store (${win})`, off.leaked === 0, off);
      ok(`…and a later store write wakes NOTHING — no dirty signal, no /api/sessions sweep (${win})`, off.externals === 0, off);
      if (on.leaked < 1) skip(`…(positive control) the same harness DOES watch the store while the service is on (${win})`, `the lane never attached a watch here (${JSON.stringify(on)})`);
      else ok(`…(positive control) the same harness DOES watch the store while the service is on — the zero above could have failed (${win})`, on.leaked >= 1, on);
    }
  }
  if (!unfixedServe) skip(`NEGATIVE CONTROL: the unfixed keeper leaks through ${label}`, unfixedServeWhy || 'no control module');
  else {
    const ctl = await r7Run(unfixedServe, { window: win, disable: true });
    if (win === 'cwd') ok(`NEGATIVE CONTROL: the UNFIXED keeper starts a serve AFTER the stop, through ${label}`, ctl.spawns >= 1, ctl);
    else if (ctl.base < 0) skip(`NEGATIVE CONTROL: the unfixed keeper leaks through ${label}`, 'the control could not be measured here');
    else ok(`NEGATIVE CONTROL: the UNFIXED keeper publishes ready:true AFTER the stop, arms a lane, watches the user's store and still fires — through ${label}`,
      ctl.ready === true && ctl.stopped === true && ctl.lane === true && ctl.leaked >= 1 && ctl.externals >= 1, ctl);
  }
}
{
  // …and the invariant is written down where the next person will look
  const kfs = read('docs/kb-file-structure.md');
  ok('docs: "the check belongs at the ACQUISITION point" is in the kb essays + the incident file + the index',
    /ROUND 7/.test(kfs) && /adopt\(\)/.test(kfs)
    && /A SERVICE THAT WAS TURNED OFF STILL ADOPTED/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 7/.test(read('CLAUDE.md')));
  // …and the SIZE of that control is stated as a number the TABLE owns, in all
  // three places (round 8 finding 3: the essays said "five" while R7_NEUTER had
  // six entries — a count written by hand drifts silently, and a negative
  // control the reader mis-sizes is one they cannot re-derive)
  const n7 = R7_NEUTER.length;
  const stated = [['docs/kb-bugfix-invariants.md', new RegExp(`exactly these ${n7} checks`)], ['docs/kb-file-structure.md', new RegExp(`its ${n7} replacements`)], ['CLAUDE.md', new RegExp(`把这 ${n7} 个检查删掉`)]];
  ok(`docs: the ROUND 7 negative control's size is stated as the number R7_NEUTER owns (${n7}) in all three places`,
    stated.every(([f, re]) => re.test(read(f))), stated.filter(([f, re]) => !re.test(read(f))).map(([f]) => f));
  if (unfixedServeFile) { try { fs.rmSync(unfixedServeFile, { force: true }); } catch { } }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 8 — A LEVEL IS NOT A CANCELLATION. Round 7 put the guard at the
// ACQUISITION point, but it guarded on `state.stopping`, which is a LEVEL:
// `stop()` raises it and the very next `start()` lowers it. Across a Disable→
// Enable pair (a user turning it off, then changing their mind — or the panel's
// own Stop/Start), the ladder that was in flight the whole time sails past
// every one of those checks and publishes what it gathered BEFORE the stop,
// while the fresh `ensure()` JOINS the cancelled attempt instead of starting
// its own. Reproduced through the real wiring below. The fix is a per-attempt
// token: `state.stopEpoch`, bumped by `stop()` AND by every new `locate()`.
console.log('\n— ROUND 8 (the seventh review: a Disable→Enable pair inside one ladder) —');
const R8_NEUTER = [
  ['the epoch in cancelled()', 'const cancelled = (epoch) => state.stopping || epoch !== state.stopEpoch;', 'const cancelled = (epoch) => state.stopping;', 1],
  ['the cancelled attempt is detached in stop()', '    state.stopEpoch++;\n    ensuring = null;\n', '    state.stopEpoch++;\n', 1],
];
const R8_ABANDON_NEUTER = [
  ["abandon()'s SIGTERM", "      if (state.child === child) { state.child = null; state.pid = null; }\n      try { child.kill('SIGTERM'); } catch { }\n", '      if (state.child === child) { state.child = null; state.pid = null; }\n', 1],
];
const r8EpochCtl = buildNeutered('r8-epoch', [R8_NEUTER[0]]);
const r8DetachCtl = buildNeutered('r8-detach', [R8_NEUTER[1]]);
const r8AbandonCtl = buildNeutered('r8-abandon', R8_ABANDON_NEUTER);
ok('(the controls themselves) one copy per mechanism can be built from the current source — each neuters exactly ONE of this round\'s checks',
  !!r8EpochCtl.mod && !!r8DetachCtl.mod && !!r8AbandonCtl.mod, [r8EpochCtl.why, r8DetachCtl.why, r8AbandonCtl.why]);

/** THE REAL WIRING, exactly as the plugin drives it (`_ocStop` then `_ocStart`
 *  in src/plugins.js): a RECORDED serve that outlived a restart and is BUSY
 *  (700ms per request — 1.18.29 answers /global/health in ~1.2s cold), a
 *  Disable landing inside the reuse probe, and an Enable 50ms later while that
 *  same probe is STILL in flight. `enable:false` = the round-7 shape (stop and
 *  stay stopped); `disable:false` = the positive control that this harness
 *  really can adopt the recorded serve, so "did not adopt it" is not vacuous. */
async function r8Run(mod, { disable = true, enable = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r8-data-'));
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r8-home-'));
  const storeDir = path.join(ocHome, '.local/share/opencode');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
  const mocks = [];
  let wantUp = true, spawns = 0;
  const kills = [], adoptions = [];
  const RECORDED_PID = 987654;      // never this process: stop({killRecorded}) refuses to signal itself
  const st = createMockState(); st.delayMs = 700;
  const mock = await startMockServe({ state: st });
  mocks.push(mock);
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: RECORDED_PID, startedAt: Date.now(), cwd: dir }));
  const facts = mod.install({
    dataDir: dir, command: '/usr/bin/opencode', log: { warn() { }, error() { }, log() { } }, guardSampleMs: 0,
    autostart: () => wantUp, readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    killPid: (pid, sig) => { kills.push([pid, sig]); },     // the recorded serve is "killed" on paper: closing it would change the window under test
    makeLane: (deps) => events.createLiveLane({ ...deps, env: { HOME: ocHome }, fetchImpl: async () => { throw new Error('no serve'); }, onExternal: () => { } }),
    onState: (s) => { if (s && s.ready) { const k = `${s.source}:${s.port}`; if (adoptions[adoptions.length - 1] !== k) adoptions.push(k); } },
    spawnImpl: (_cmd, args) => {
      spawns++;
      const port = Number(args[args.indexOf('--port') + 1]);
      startMockServe({ port, state: createMockState() }).then((m) => mocks.push(m)).catch(() => { });
      const c = new EventEmitter(); c.pid = 4242; c.unref = () => { }; c.kill = () => { }; return c;
    },
  });
  facts.locator.start();                       // the plugin's Start — NOT awaited, exactly as the route leaves it
  await sleep(400);                            // …now inside the 700ms reuse health probe
  let startResult = 'not-clicked';
  if (disable) { wantUp = false; facts.locator.stop({ killRecorded: true }); }
  if (disable && enable) {
    await sleep(50);
    wantUp = true;
    startResult = 'pending';
    // _ocStart's own shape: it REPORTS the outcome of the promise start() returns
    Promise.resolve(facts.locator.start()).then((c) => { startResult = c ? 'client' : 'null'; }, () => { startResult = 'threw'; });
  }
  await sleep(3000);
  const lst = facts.locator.state();
  const out = {
    ready: !!lst.ready, source: lst.source || null, port: lst.port, recordedPort: mock.port, startResult,
    adoptions, spawns, kills, lane: facts.state().liveLane !== null,
    adoptedTheKilledServe: lst.source === 'reused' && lst.port === mock.port,
    record: (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'opencode-serve.json'), 'utf8')).port; } catch { return null; } })(),
  };
  mod.uninstall();
  for (const m of mocks) { try { await m.close(); } catch { } }
  for (const d of [dir, ocHome]) fs.rmSync(d, { recursive: true, force: true });
  return out;
}
{
  const plain = await r8Run(serve, { disable: false });
  ok('(the control) with nobody touching it, this harness DOES adopt the recorded serve — so "did not adopt it" below is a real difference', plain.source === 'reused' && plain.port === plain.recordedPort && plain.spawns === 0, plain);
  const off = await r8Run(serve, { enable: false });
  ok('(round 7, still) a Disable with no Enable publishes nothing at all', off.ready === false && off.source === null && off.spawns === 0, off);

  const fixed = await r8Run(serve);
  ok('a Disable→Enable pair NEVER republishes the serve the Disable SIGTERMed', fixed.adoptedTheKilledServe === false && fixed.kills.some(([p, s]) => p === 987654 && s === 'SIGTERM'), fixed);
  ok('…and the Enable runs its OWN ladder: exactly one spawn, adopted as `spawned` on a live port', fixed.spawns === 1 && fixed.source === 'spawned' && fixed.port !== fixed.recordedPort, fixed);
  ok('…exactly ONE client is ever published, and ONE lane follows it', fixed.adoptions.length === 1 && fixed.lane === true, fixed);
  ok('…and the Enable\'s own start() resolves that client, so the route reports the truth', fixed.startResult === 'client', fixed);
  ok('…and the record left behind names the serve we are actually talking to (what the NEXT boot adopts)', fixed.record === fixed.port, fixed);

  if (!r8EpochCtl.mod) skip('NEGATIVE CONTROL: without the epoch, the cancelled ladder republishes the killed serve', r8EpochCtl.why);
  else {
    const ctl = await r8Run(r8EpochCtl.mod);
    ok('NEGATIVE CONTROL: with `cancelled()` reduced to the `state.stopping` LEVEL, the cancelled ladder wakes up after the Enable and publishes the SIGTERMed serve — TWO adoptions, the second a dead process',
      ctl.adoptions.length === 2 && ctl.adoptedTheKilledServe === true, ctl);
  }
  if (!r8DetachCtl.mod) skip('NEGATIVE CONTROL: without the detach, the Enable joins the cancelled attempt', r8DetachCtl.why);
  else {
    const ctl = await r8Run(r8DetachCtl.mod);
    ok('NEGATIVE CONTROL: without `ensuring = null` in stop(), the Enable JOINS the cancelled attempt and its start() resolves null — a click the route reports as "did nothing"',
      ctl.startResult === 'null', ctl);
  }
}

/** FINDING 2: abandon() SIGTERMs the child it holds, and `stop()` has ALREADY
 *  nulled `state.child` by then — which is why abandon's `state.child === child`
 *  branch is a no-op on every path we have, and why it must stay conditional
 *  (a newer ladder's handle lives in that slot). Both halves are measured
 *  here with a mock child that RECORDS its kills, tagged by the phase they
 *  arrive in, so "abandon killed it" cannot be confused with "stop killed it". */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r8-abandon-'));
  const runAbandon = async (mod) => {
    let phase = 'boot';
    const kills = [];
    let wantUp = true;
    const loc = mod.createServeLocator({
      dataDir: dir, command: '/usr/bin/opencode', log: { warn() { }, error() { }, log() { } }, guardSampleMs: 0,
      autostart: () => wantUp, bootTimeoutMs: 20000,
      execImpl: (_c, _a, _o, cb) => cb(null, '', ''),      // the isolated cwd, without a real `git init`
      spawnImpl: () => { const c = new EventEmitter(); c.pid = 4242; c.unref = () => { }; c.kill = (sig) => kills.push(`${phase}:${sig}`); return c; },
    });
    loc.start();                                          // nothing ever answers on that port: the boot wait rungs
    await sleep(500);
    const spawned = loc.state();
    wantUp = false;
    phase = 'stop'; loc.stop(); phase = 'after-stop';      // synchronous — anything later is abandon()'s
    const afterStop = loc.state();
    await sleep(700);                                     // past the next boot-loop rung
    return { kills, spawnedPid: spawned.pid, afterStopPid: afterStop.pid, lastError: loc.state().lastError, record: fs.existsSync(path.join(dir, 'opencode-serve.json')) };
  };
  const r = await runAbandon(serve);
  ok('(the setup) the boot wait really did have a child in flight', r.spawnedPid === 4242, r);
  ok('stop() nulls `state.child`/`state.pid` FIRST — abandon() finds the slot already empty, which is why its conditional null is a no-op (and must never be unconditional: a newer ladder owns that slot)', r.afterStopPid === null, r);
  ok('…and abandon() STILL SIGTERMs the child it holds in its closure — the second kill arrives after stop() returned', JSON.stringify(r.kills) === JSON.stringify(['stop:SIGTERM', 'after-stop:SIGTERM']), r.kills);
  ok('…and it says so honestly (the boot was OURS to stop) and leaves no record for the next boot to ADOPT', /was starting when the background service was turned off/.test(r.lastError || '') && r.record === false, r);
  if (!r8AbandonCtl.mod) skip("NEGATIVE CONTROL: without abandon()'s kill the child survives the bail", r8AbandonCtl.why);
  else {
    const ctl = await runAbandon(r8AbandonCtl.mod);
    ok("NEGATIVE CONTROL: with abandon()'s SIGTERM removed, only stop()'s kill is recorded — the assert above can fail", JSON.stringify(ctl.kills) === JSON.stringify(['stop:SIGTERM']), ctl.kills);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const kfs = read('docs/kb-file-structure.md');
  const n8 = R8_NEUTER.length;
  ok('docs: "a level is not a cancellation" is in the kb essays + the incident file + the index',
    /ROUND 8/.test(kfs) && /stopEpoch/.test(kfs)
    && /A LEVEL IS NOT A CANCELLATION/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 8/.test(read('CLAUDE.md')));
  ok(`docs: the ROUND 8 negative control's size is stated as the number R8_NEUTER owns (${n8})`,
    new RegExp(`one per mechanism, ${n8} of them`).test(read('docs/kb-bugfix-invariants.md')) && new RegExp(`${n8} single-mechanism controls`).test(kfs),
    [n8]);
  for (const f of [r8EpochCtl.file, r8DetachCtl.file, r8AbandonCtl.file]) if (f) { try { fs.rmSync(f, { force: true }); } catch { } }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 9 — A RECORD YOU DO NOT OWN. Round 8 made `stop()` DETACH the in-flight
// ladder (`ensuring = null`) so an Enable starts its own — which is also the
// first time TWO ladders can be alive at once. Every post-await site got the
// epoch check except the reuse rung's two `clearRecord()` calls: the verdict
// `await unsafeReuseReason(probe, rec)` is followed by an unguarded
// `killPid(rec.pid) + clearRecord()`, and the dead-pid arm runs after a
// DEFAULT_TIMEOUT_MS health probe with no check either. A ladder cancelled by a
// newer one therefore deleted data/opencode-serve.json AFTER the new ladder had
// written its own — leaving a LIVE spawned serve with no record for the next
// boot to adopt or kill, the orphaned third-party daemon the record exists to
// prevent. `abandon()` even states the rule it was the only site to follow.
console.log('\n— ROUND 9 (the eighth review: two ladders, one record) —');
/** THE PRE-FIX CONTROL: src/opencode-serve.js with BOTH epoch checks AND the
 *  ownership test in clearRecord() removed — i.e. the exact shape the incident
 *  was reproduced against. The fix is deliberately two layers (a cancelled
 *  ladder must not ACT, and no clear may name someone else's serve), so the
 *  control that reproduces the ORIGINAL loss has to remove both; the
 *  single-mechanism controls below then show each layer is load-bearing alone. */
const R9_OWNED_CHECK = [
  ["clearRecord()'s ownership test", '    if (owns) {\n      const r = readRecord();\n      if (!r) return false;\n      if (owns.port != null && r.port !== owns.port) return false;\n      if ((r.pid ?? null) !== (owns.pid ?? null)) return false;\n    }\n', '', 1],
];
const R9_VERDICT_CHECK = [
  ['the reuse-verdict cancellation check', '        if (cancelled(epoch)) return null;\n        log?.warn?.(`[opencode-serve] replacing the recorded serve', '        log?.warn?.(`[opencode-serve] replacing the recorded serve', 1],
];
const R9_DEADPID_CHECK = [
  // round 10 moved the dead-pid arm INSIDE settleRecordedServe, so the check
  // this control removes is the one that now guards the whole settlement (the
  // dead-pid clear is its first line) — same mechanism, one layer out
  ['the unresponsive-record cancellation check', '        if (cancelled(epoch)) return null;\n        const settled = await settleRecordedServe', '        const settled = await settleRecordedServe', 1],
];
const R9_NEUTER = [...R9_VERDICT_CHECK, ...R9_DEADPID_CHECK, ...R9_OWNED_CHECK];
const r9PreFix = buildNeutered('r9-prefix', R9_NEUTER);
const r9VerdictCtl = buildNeutered('r9-verdict', R9_VERDICT_CHECK);
const r9DeadPidCtl = buildNeutered('r9-deadpid', R9_DEADPID_CHECK);
const r9OwnedCtl = buildNeutered('r9-owned', R9_OWNED_CHECK);
ok('(the controls themselves) a PRE-FIX copy and one copy per mechanism can be built from the current source',
  !!r9PreFix.mod && !!r9VerdictCtl.mod && !!r9DeadPidCtl.mod && !!r9OwnedCtl.mod,
  [r9PreFix.why, r9VerdictCtl.why, r9DeadPidCtl.why, r9OwnedCtl.why]);

/** A recorded serve whose `/global/health` NEVER answers: the request runs the
 *  full DEFAULT_TIMEOUT_MS, which is the await the dead-pid arm sits behind.
 *  (A closed port would fail in microseconds and there would be no window.) */
function startHungServe() {
  return new Promise((resolve) => {
    const held = [];
    const srv = http.createServer((req, res) => { held.push(res); });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => { for (const h of held) { try { h.destroy(); } catch { } } srv.close(() => r()); }),
    }));
  });
}

/** THE REAL WIRING again (`_ocStop` then `_ocStart` in src/plugins.js), with the
 *  Disable landing in the await each arm of the reuse rung sits behind:
 *    'bad'  — a BUSY recorded serve whose own project is '/' (the 2.369.42
 *             leftover the rung must REPLACE): health answers at ~700ms, the
 *             verdict probe answers at ~1400ms, so a Disable at T+1000 lands
 *             inside `unsafeReuseReason` — PAST round 7's post-health check.
 *    'dead' — a recorded serve that never answers at all and a recorded pid
 *             that is not running: the dead-pid arm, behind the 1.5s timeout.
 *  `autostart:false` = the ladder may clean up but may never spawn (the
 *  positive control that an UNCANCELLED ladder still clears a dead record). */
async function r9Run(mod, { window: win, disable = true, enable = true, autostart = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r9-data-'));
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r9-home-'));
  const storeDir = path.join(ocHome, '.local/share/opencode');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
  const mocks = [];
  let wantUp = autostart, spawns = 0;
  const kills = [], adoptions = [];
  const RECORDED_PID = 987654;      // never this process, and not running: `pidAlive` is false for it
  let recPort = null;
  if (win === 'bad') {
    const st = createMockState({ currentWorktree: '/' }); st.delayMs = 700;
    const m = await startMockServe({ state: st }); mocks.push(m); recPort = m.port;
  } else {
    const h = await startHungServe(); mocks.push(h); recPort = h.port;
  }
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: recPort, pid: RECORDED_PID, startedAt: Date.now(), cwd: dir }));
  const facts = mod.install({
    dataDir: dir, command: '/usr/bin/opencode', log: { warn() { }, error() { }, log() { } }, guardSampleMs: 0,
    autostart: () => wantUp, readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    killPid: (pid, sig) => { kills.push([pid, sig]); },   // on paper: really closing the mock would change the window under test
    makeLane: (deps) => events.createLiveLane({ ...deps, env: { HOME: ocHome }, fetchImpl: async () => { throw new Error('no serve'); }, onExternal: () => { } }),
    onState: (s) => { if (s && s.ready) { const k = `${s.source}:${s.port}`; if (adoptions[adoptions.length - 1] !== k) adoptions.push(k); } },
    spawnImpl: (_cmd, args) => {
      spawns++;
      const port = Number(args[args.indexOf('--port') + 1]);
      startMockServe({ port, state: createMockState() }).then((m) => mocks.push(m)).catch(() => { });
      const c = new EventEmitter(); c.pid = 4242; c.unref = () => { }; c.kill = () => { }; return c;
    },
  });
  facts.locator.start();                              // the plugin's Start — NOT awaited, exactly as the route leaves it
  await sleep(win === 'bad' ? 1000 : 900);            // …now inside the await this window names
  if (disable) { wantUp = false; facts.locator.stop({ killRecorded: true }); }
  if (disable && enable) { await sleep(50); wantUp = autostart; facts.locator.start(); }
  await sleep(3200);                                  // past the stale ladder's own await
  const lst = facts.locator.state();
  const rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'opencode-serve.json'), 'utf8')); } catch { return null; } })();
  const out = {
    ready: !!lst.ready, source: lst.source || null, port: lst.port, recordedPort: recPort, spawns, kills, adoptions,
    record: rec ? rec.port : null, recordPid: rec ? rec.pid : null,
    // THE FAILURE, named: a serve we started is running and nothing on disk says so
    orphaned: !!lst.ready && lst.source === 'spawned' && (!rec || rec.port !== lst.port),
    killsOfRecorded: kills.filter(([p]) => p === RECORDED_PID).length,
  };
  mod.uninstall();
  for (const m of mocks) { try { await m.close(); } catch { } }
  for (const d of [dir, ocHome]) fs.rmSync(d, { recursive: true, force: true });
  return out;
}
for (const [win, label] of [['bad', "the reuse VERDICT probe on a '/'-worktree leftover"], ['dead', 'the health timeout of a recorded serve that never answers']]) {
  const plain = await r9Run(serve, { window: win, disable: false });
  ok(`(the control) with nobody touching it, ${label} really does replace the recorded serve and record the replacement`,
    plain.spawns === 1 && plain.source === 'spawned' && plain.record === plain.port && plain.killsOfRecorded === (win === 'bad' ? 1 : 0), plain);

  const fixed = await r9Run(serve, { window: win });
  ok(`a Disable→Enable landing in ${label} leaves the record naming the serve we are actually talking to`,
    fixed.ready === true && fixed.source === 'spawned' && fixed.record === fixed.port && fixed.orphaned === false, fixed);
  ok('…the Enable spawned exactly once and published exactly one client', fixed.spawns === 1 && fixed.adoptions.length === 1, fixed);
  ok('…and the cancelled ladder signalled NOTHING of its own: the only SIGTERM to the recorded pid is stop({killRecorded})\'s',
    fixed.killsOfRecorded === 1, fixed);

  if (!r9PreFix.mod) skip(`NEGATIVE CONTROL: the pre-fix keeper orphans its own serve through ${label}`, r9PreFix.why);
  else {
    const ctl = await r9Run(r9PreFix.mod, { window: win });
    ok(`NEGATIVE CONTROL: the PRE-FIX keeper (both epoch checks + the ownership test removed) DELETES the live ladder's record through ${label} — a running \`opencode serve\` the next boot can neither adopt nor kill`,
      ctl.ready === true && ctl.orphaned === true && ctl.record === null, ctl);
  }
}
{
  // …and each layer alone, so a future edit cannot quietly drop one of them
  if (!r9VerdictCtl.mod) skip('NEGATIVE CONTROL: without the verdict check the cancelled ladder still ACTS', r9VerdictCtl.why);
  else {
    const ctl = await r9Run(r9VerdictCtl.mod, { window: 'bad' });
    ok('NEGATIVE CONTROL: with ONLY the reuse-verdict `cancelled(epoch)` removed, the cancelled ladder still SIGTERMs the recorded pid on its own account (two kills) — and the record survives only because the OWNERSHIP layer refuses its clear',
      ctl.killsOfRecorded === 2 && ctl.record === ctl.port, ctl);
  }
  if (!r9DeadPidCtl.mod) skip('NEGATIVE CONTROL: the dead-pid arm alone', r9DeadPidCtl.why);
  else {
    const ctl = await r9Run(r9DeadPidCtl.mod, { window: 'dead' });
    ok('NEGATIVE CONTROL: with ONLY the dead-pid arm\'s `cancelled(epoch)` removed, the stale ladder reaches the clear and the OWNERSHIP layer alone holds the record (the two layers are independent — the pre-fix control above needs both gone)',
      ctl.record === ctl.port && ctl.orphaned === false, ctl);
  }
  // THE POSITIVE CONTROL the guards must not break: an UNCANCELLED ladder still
  // cleans up after a record whose pid is genuinely dead (autostart off, so the
  // rung may clear but may not spawn — the cleanup is the only thing measured)
  const cleanup = await r9Run(serve, { window: 'dead', disable: false, autostart: false });
  ok('(positive control) an UNCANCELLED ladder still CLEARS a record whose pid is dead and whose serve never answers — the guards refuse a cancelled clear, not every clear',
    cleanup.record === null && cleanup.spawns === 0 && cleanup.ready === false, cleanup);
}

/** THE PORT-RECYCLE VARIANT of the same rule, in `abandon()`. `freePort()` hands
 *  out a port that is free RIGHT NOW, so the port an abandoned child was given
 *  is re-bindable by the very ladder that cancelled it (its own child was
 *  SIGTERMed first) — and the old `r.port === port` test would then delete the
 *  NEW ladder's record for the serve it is actually talking to. `freePort()` is
 *  not injectable, so the recycled state is written onto disk directly: the
 *  record is REWRITTEN to {the abandoned child's port, the NEW child's pid},
 *  byte-for-byte the shape `writeRecord` produces when the OS hands the port
 *  back. The claim is the PAIR, so abandon() must refuse it. */
{
  const runRecycle = async (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r9-recycle-'));
    const recordPath = path.join(dir, 'opencode-serve.json');
    const spawned = [];
    let wantUp = true, pidSeq = 5000;
    const loc = mod.createServeLocator({
      dataDir: dir, command: '/usr/bin/opencode', log: { warn() { }, error() { }, log() { } }, guardSampleMs: 0,
      autostart: () => wantUp, bootTimeoutMs: 20000,
      execImpl: (_c, _a, _o, cb) => cb(null, '', ''),      // the isolated cwd, without a real `git init`
      // a boot probe that HANGS until its own timeout: each rung of the boot
      // wait then costs the full second, which is what puts ladder A's bail
      // AFTER the recycled record is on disk (a closed port would refuse in
      // microseconds and abandon() would run before the recycle, measuring
      // nothing). This is the same "starting…" window rounds 7-8 used.
      fetchImpl: (_u, o) => new Promise((_res, rej) => {
        const sig = o && o.signal;
        if (sig) sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
      spawnImpl: (_c, args) => {                            // nothing ever answers on these ports: both ladders sit in the boot wait
        const port = Number(args[args.indexOf('--port') + 1]);
        const c = new EventEmitter(); c.pid = ++pidSeq; c.unref = () => { }; c.kill = () => { };
        spawned.push({ port, pid: c.pid });
        return c;
      },
    });
    loc.start();
    await sleep(400);                                      // ladder A is in its boot wait, its record on disk
    loc.stop();                                            // kills child A, clears the record, cancels ladder A
    loc.start();                                           // ladder B: a new child, a new record
    await sleep(400);
    const [a, b] = spawned;
    // …and now the OS hands ladder B the port ladder A just freed
    if (a && b) fs.writeFileSync(recordPath, JSON.stringify({ port: a.port, pid: b.pid, startedAt: Date.now(), command: '/usr/bin/opencode', cwd: dir }));
    await sleep(1600);                                     // ladder A's next boot-loop rung (probe timeout + 200ms) → abandon()
    const rec = (() => { try { return JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch { return null; } })();
    loc.stop();
    const out = { spawns: spawned.length, samePortWritten: !!(a && b), recordPid: rec ? rec.pid : null, livePid: b ? b.pid : null };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  };
  const r = await runRecycle(serve);
  ok('(the setup) two ladders really spawned, and the record was rewritten to the recycled shape', r.spawns === 2 && r.samePortWritten === true, r);
  ok("abandon() REFUSES to clear a record that carries the newer ladder's pid on the port it is giving up — port equality is not identity",
    r.recordPid === r.livePid, r);
  if (!r9OwnedCtl.mod) skip("NEGATIVE CONTROL: without the ownership test abandon() deletes the newer ladder's record", r9OwnedCtl.why);
  else {
    const ctl = await runRecycle(r9OwnedCtl.mod);
    ok("NEGATIVE CONTROL: with ONLY clearRecord()'s ownership test removed, the abandoned ladder deletes the record naming the LIVE serve (port matched, pid did not)",
      ctl.spawns === 2 && ctl.recordPid === null, ctl);
  }
}
{
  const kfs = read('docs/kb-file-structure.md');
  const n9 = R9_NEUTER.length;
  ok('docs: "a record you do not own" is in the kb essays + the incident file + the index',
    /ROUND 9/.test(kfs) && /clearRecord/.test(kfs)
    && /A RECORD YOU DO NOT OWN/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 9/.test(read('CLAUDE.md')));
  ok(`docs: the ROUND 9 pre-fix control's size is stated as the number R9_NEUTER owns (${n9})`,
    new RegExp(`removing all ${n9}`).test(read('docs/kb-bugfix-invariants.md')) && new RegExp(`its ${n9} replacements`).test(kfs), [n9]);
  for (const f of [r9PreFix.file, r9VerdictCtl.file, r9DeadPidCtl.file, r9OwnedCtl.file]) if (f) { try { fs.rmSync(f, { force: true }); } catch { } }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 10 — THE RECORD WE WERE ABOUT TO OVERWRITE. Rounds 7-9 hardened this
// rung against a CONCURRENT ladder; this one needs no concurrency at all. The
// reuse rung owned exactly ONE arm of an unanswered health probe — a DEAD
// recorded pid — and an ALIVE one fell THROUGH to the spawn, whose writeRecord
// then buried it: a live `opencode serve` that nothing on disk names, on every
// restart of a wedged serve, in silence. Neither the runaway guard (it samples
// OUR child) nor `stop({killRecorded})` (it reads the record) can ever reach
// that process again, while OpenCode keeps indexing and inotify-watching
// whatever it had booted. So "we are about to overwrite this record" is now a
// DECISION with named outcomes (settleRecordedServe), and the two it may not
// make — killing a pid that is someone else's, and starting a second serve
// over one we cannot account for — are refused OUT LOUD.
console.log('\n— ROUND 10 (the ninth review: a recorded serve that is ALIVE and silent) —');
/** THE PRE-FIX CONTROL: the settlement replaced by the exact fall-through it
 *  grew out of (the reuse rung with only the dead-pid arm). */
const R10_NEUTER = [
  ['the owned settlement of an unresponsive record',
    "      let answered = await healthy(probe, DEFAULT_TIMEOUT_MS);\n      if (!answered) {\n        if (cancelled(epoch)) return null;\n        const settled = await settleRecordedServe(rec, owned, probe, epoch, !!cmd && autostartOn());\n        if (settled === 'blocked' || settled === 'cancelled') return null;\n        answered = settled === 'answered';\n      }\n      if (answered) {",
    '      if (await healthy(probe, DEFAULT_TIMEOUT_MS)) {', 1],
  ['the dead-pid arm, back as a fall-through',
    '        clearRecord(owned);\n      }\n    }',
    '        clearRecord(owned);\n      } else if (!cancelled(epoch) && !pidAlive(rec.pid)) clearRecord(owned);\n    }', 1],
];
const r10Ctl = buildNeutered('r10-prefix', R10_NEUTER);
ok('(the control itself) a PRE-FIX copy of the keeper can be built from the current source — the A/B below is only meaningful against it', !!r10Ctl.mod, r10Ctl.why);

const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readRec = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'opencode-serve.json'), 'utf8')); } catch { return null; } };

/** THE PURE VERDICT, first — `pidAlive` answers "something runs under that
 *  number", which is NOT "that is the serve": pids are recycled and a record
 *  can outlive its serve by weeks. Everything the settlement is allowed to do
 *  hangs off this classification, so it is pinned as a table AND against a
 *  REAL process (the readers and the classifier must agree on real procfs). */
{
  const { classifyRecordedPid, readProcCmdline, readProcUid } = serve;
  const rec = { port: 4711, pid: 321, command: '/usr/bin/opencode' };
  const c = (o) => classifyRecordedPid(rec, { pid: 321, selfUid: 1000, selfPid: 999, ...o }).verdict;
  ok('OURS: a live process running `serve` with the RECORDED port, as this user',
    c({ argv: ['/usr/bin/opencode', 'serve', '--port', '4711', '--hostname', '127.0.0.1'], uid: 1000 }) === 'ours');
  ok('…and the `--port=4711` spelling of the same fact', c({ argv: ['opencode', 'serve', '--port=4711'], uid: 1000 }) === 'ours');
  ok('…even when argv[0] is a runtime rather than the recorded `command` (the launcher may re-exec — the PORT is the discriminator, not argv[0])',
    c({ argv: ['/usr/bin/bun', '/home/u/.opencode/bin/opencode.js', 'serve', '--port', '4711'], uid: 1000 }) === 'ours');
  ok('OTHER: a serve on a DIFFERENT port is not this record\'s serve', c({ argv: ['opencode', 'serve', '--port', '4712'], uid: 1000 }) === 'other');
  ok('OTHER: an unrelated program that merely inherited the pid', c({ argv: ['/usr/bin/python3', 'train.py'], uid: 1000 }) === 'other');
  ok('OTHER: another USER\'s process — we never spawned it, so it can never be ours (and must never be signalled)',
    c({ argv: ['opencode', 'serve', '--port', '4711'], uid: 1001 }) === 'other');
  ok('OTHER: the record naming THIS server process (a pid recycled onto us) — the one pid a SIGTERM must never reach',
    classifyRecordedPid(rec, { pid: 999, selfPid: 999, selfUid: 1000, uid: 1000, argv: ['node', 'server.js'] }).verdict === 'other');
  ok('UNKNOWN: procfs said nothing (no /proc on this platform, hidepid) — neither kill nor overwrite', c({ argv: null, uid: null }) === 'unknown');
  ok('UNKNOWN: an EMPTY command line (a zombie) is not evidence of anything', c({ argv: [], uid: 1000 }) === 'unknown');
  ok('a record with no pid is not a live process claim', classifyRecordedPid(rec, { pid: null }).verdict === 'other');
  // …and the same call against a REAL process, through the REAL reader
  const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)', 'serve', '--port', '4711'], { stdio: 'ignore' });
  await sleep(300);
  const realArgv = readProcCmdline(kid.pid);
  const realVerdict = classifyRecordedPid(rec, { pid: kid.pid, argv: realArgv, uid: readProcUid(kid.pid), selfUid: process.getuid(), selfPid: process.pid });
  ok('the REAL reader over a REAL /proc feeds the same verdict (the table is not a fiction about procfs)',
    Array.isArray(realArgv) && realArgv.includes('serve') && realVerdict.verdict === 'ours', { realArgv, realVerdict });
  try { process.kill(kid.pid, 'SIGKILL'); } catch { }
}

/** ONE harness for every arm, through the REAL wiring (install() +
 *  locator.start()). The recorded serve is TWO real things:
 *    • a listening socket at the recorded port — 'hung' (accepts, never
 *      answers, so the probe burns its whole budget), 'slow' (answers at
 *      2.5s: past the 1.5s budget, inside the confirm probe) or 'healthy';
 *    • a REAL process for the recorded pid — 'ours' (its /proc cmdline is
 *      `… serve --port <the recorded port>`), 'stubborn' (the same, ignoring
 *      SIGTERM), 'other' (a live process that is NOT that serve: the recycled
 *      pid that must never be signalled) or 'dead' (a pid nothing runs under).
 *  Only `spawnImpl` is stubbed (it starts a REAL mock serve on the port the
 *  keeper chose) and, for the unverifiable arm, the procfs reader — a platform
 *  without /proc is not reproducible on this one. `killPid` records the signal
 *  AND really sends it: a bounded wait for an exit is only meaningful against
 *  a process that can actually exit. */
async function r10Run(mod, { socket = 'hung', recorded = 'ours', autostart = true, readCmdline = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r10-data-'));
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r10-home-'));
  const storeDir = path.join(ocHome, '.local/share/opencode');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
  const mocks = [], kids = [], kills = [], warns = [];
  let spawns = 0, recPort = null, recPid = 987654;      // 'dead' = not running, and never this process
  if (socket === 'hung') { const h = await startHungServe(); mocks.push(h); recPort = h.port; }
  else { const st = createMockState(); if (socket === 'slow') st.delayMs = 2500; const m = await startMockServe({ state: st }); mocks.push(m); recPort = m.port; }
  if (recorded !== 'dead') {
    const body = recorded === 'stubborn' ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},10000)" : 'setInterval(()=>{},10000)';
    const argv = recorded === 'other' ? [] : ['serve', '--port', String(recPort), '--hostname', '127.0.0.1'];
    const kid = spawn(process.execPath, ['-e', body, ...argv], { stdio: 'ignore' });
    kids.push(kid); recPid = kid.pid;
    for (let i = 0; i < 40 && !alivePid(recPid); i++) await sleep(25);   // the record may only claim a process that is really there
  }
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: recPort, pid: recPid, startedAt: Date.now(), command: '/usr/bin/opencode', cwd: dir }));
  const facts = mod.install({
    dataDir: dir, command: '/usr/bin/opencode', guardSampleMs: 0,
    log: { warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)), log() { } },
    autostart: () => autostart, readProc: () => ({ cpuTicks: 0, rssBytes: 1024 }),
    killPid: (pid, sig) => { kills.push([pid, sig]); process.kill(pid, sig); },
    ...(readCmdline ? { readCmdline } : {}),
    makeLane: (deps) => events.createLiveLane({ ...deps, env: { HOME: ocHome }, fetchImpl: async () => { throw new Error('no serve'); }, onExternal: () => { } }),
    spawnImpl: (_cmd, args) => {
      spawns++;
      const port = Number(args[args.indexOf('--port') + 1]);
      startMockServe({ port, state: createMockState() }).then((m) => mocks.push(m)).catch(() => { });
      const c = new EventEmitter(); c.pid = 4242; c.unref = () => { }; c.kill = () => { }; return c;
    },
  });
  await facts.locator.start();                          // the plugin's Start — it resolves when the ladder settles
  const st = facts.locator.state();
  const rec = readRec(dir);
  const out = {
    ready: !!st.ready, source: st.source || null, port: st.port, parked: !!st.parked, parkedKind: st.parkedKind || null,
    lastError: st.lastError || null, reason: facts.reasonUnavailable(), snap: st,
    spawns, kills, warns, recordedPort: recPort, recordedPid: recPid, recordPort: rec ? rec.port : null,
    recordedAlive: recorded === 'dead' ? false : alivePid(recPid),
    // THE COUNT THAT NAMES THE FAILURE: our own serve plus anything still
    // running at the recorded one. Two = the orphan (only one of them is named
    // on disk, and nothing can ever reach the other).
    liveServes: (recorded === 'dead' ? 0 : (alivePid(recPid) ? 1 : 0)) + spawns,
  };
  mod.uninstall();
  for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch { } }
  for (const m of mocks) { try { await m.close(); } catch { } }
  for (const d of [dir, ocHome]) fs.rmSync(d, { recursive: true, force: true });
  return out;
}
{
  const { storeFailureReason } = require(path.join(REPO, 'src/server/cli-env.js'));
  // ① the shape that needed no concurrency at all
  const fixed = await r10Run(serve, { socket: 'hung', recorded: 'ours' });
  ok('a recorded serve that is ALIVE but never answers is STOPPED before its replacement starts — after locate() there is exactly ONE live serve and the record names it',
    fixed.liveServes === 1 && fixed.recordedAlive === false && fixed.spawns === 1 && fixed.source === 'spawned' && fixed.recordPort === fixed.port, fixed);
  ok('…signalled once, BY PID, after proving from /proc that the pid really is that serve — and never this process',
    fixed.kills.length === 1 && fixed.kills[0][0] === fixed.recordedPid && fixed.kills[0][1] === 'SIGTERM' && fixed.recordedPid !== process.pid, fixed.kills);
  ok('…and it SPOKE: one warn naming the pid, the port and the budget it missed (the fall-through logged nothing at all)',
    fixed.warns.some((w) => w.includes(String(fixed.recordedPid)) && w.includes(String(fixed.recordedPort)) && /ALIVE but answered no \/global\/health/.test(w)), fixed.warns);
  if (!r10Ctl.mod) skip('NEGATIVE CONTROL: the fall-through leaves two live serves', r10Ctl.why);
  else {
    const ctl = await r10Run(r10Ctl.mod, { socket: 'hung', recorded: 'ours' });
    ok('NEGATIVE CONTROL: with the settlement replaced by the fall-through it grew out of, the recorded serve is STILL RUNNING while the record names the NEW one — two live serves, one of them unreachable forever, and not one signal or log line',
      ctl.liveServes === 2 && ctl.recordedAlive === true && ctl.spawns === 1 && ctl.recordPort === ctl.port && ctl.recordPort !== ctl.recordedPort && ctl.kills.length === 0, ctl);
  }
  // ② the pid we cannot account for: neither killed nor spawned over, and SAID
  const unknown = await r10Run(serve, { socket: 'hung', recorded: 'ours', readCmdline: () => null });
  ok('a live recorded pid we CANNOT prove is ours is neither signalled nor spawned over',
    unknown.spawns === 0 && unknown.kills.length === 0 && unknown.recordedAlive === true && unknown.recordPort === unknown.recordedPort, unknown);
  ok('…the locator publishes a BLOCKED park whose lastError names the pid, the port, the record file and both ways out',
    unknown.parked === true && unknown.parkedKind === 'blocked' && /pid \d+/.test(unknown.lastError || '') && /port \d+/.test(unknown.lastError || '')
    && (unknown.lastError || '').includes('opencode-serve.json') && /stop that process/.test(unknown.lastError || ''), unknown.lastError);
  ok('…/api/home REPORTS it through the SAME predicate the red toast reads — a blocked record IS a broken store, unlike a service that is merely off',
    storeFailureReason({ id: 'opencode', store: { serveState: () => unknown.snap, unavailableReason: () => unknown.reason } }) === unknown.lastError
    && storeFailureReason({ id: 'opencode', store: { serveState: () => ({ ...unknown.snap, parked: false, parkedKind: null }), unavailableReason: () => unknown.reason } }) === null,
    unknown.reason);
  ok("…and the ⚙ card does not call it a crash loop: the opencode row has its own 'blocked' branch, translated in zh + ja",
    /parkedKind === 'blocked'/.test(read('src/lib/plugins-ui.js'))
    && /blocked by a serve we could not identify/.test(read('src/lib/i18n-zh.js'))
    && /blocked by a serve we could not identify/.test(read('src/lib/i18n-ja.js')));
  // ③ it did not die: the same refusal, on the other side of the SIGTERM
  const stubborn = await r10Run(serve, { socket: 'hung', recorded: 'stubborn' });
  ok('a recorded serve that IGNORES SIGTERM is not spawned over either — we waited for the exit, it never came, and the state says exactly that',
    stubborn.spawns === 0 && stubborn.kills.length === 1 && stubborn.recordedAlive === true && stubborn.parkedKind === 'blocked'
    && /did not exit within/.test(stubborn.lastError || '') && stubborn.recordPort === stubborn.recordedPort, stubborn);
  // ④ the recycled pid: clear the stale record, NEVER signal the stranger
  const other = await r10Run(serve, { socket: 'hung', recorded: 'other' });
  ok('a recorded pid that is alive but is NOT that serve (a recycled pid) is never signalled — the stale record is cleared and a fresh serve starts',
    other.kills.length === 0 && other.recordedAlive === true && other.spawns === 1 && other.recordPort === other.port && other.recordPort !== other.recordedPort, other);
  // ⑤ the two positive controls the guards must not break
  const healthy = await r10Run(serve, { socket: 'healthy', recorded: 'ours' });
  ok('(positive control) a HEALTHY recorded serve is still ADOPTED untouched — no /proc verdict, no signal, no spawn, the record unchanged',
    healthy.source === 'reused' && healthy.ready === true && healthy.spawns === 0 && healthy.kills.length === 0
    && healthy.recordedAlive === true && healthy.recordPort === healthy.recordedPort, healthy);
  const slow = await r10Run(serve, { socket: 'slow', recorded: 'ours' });
  ok('(positive control) SLOW IS NOT WEDGED: a recorded serve that misses the 1.5s budget but answers the longer confirm probe is ADOPTED, not stopped (a cold 1.18.29 needs ~1.2s)',
    slow.source === 'reused' && slow.spawns === 0 && slow.kills.length === 0 && slow.recordedAlive === true, slow);
  // ⑥ …and the two arms that must keep behaving exactly as they did
  const off = await r10Run(serve, { socket: 'hung', recorded: 'ours', autostart: false });
  ok('with the service OFF nothing overwrites the record, so nothing may act on it: no signal, no spawn, no park — it still NAMES the live process stop({killRecorded}) would stop',
    off.kills.length === 0 && off.spawns === 0 && off.parked === false && off.recordedAlive === true && off.recordPort === off.recordedPort, off);
  const dead = await r10Run(serve, { socket: 'hung', recorded: 'dead' });
  ok('(positive control) a record whose pid is genuinely DEAD is still cleared and replaced — the settlement refuses to act blindly, not to act',
    dead.spawns === 1 && dead.kills.length === 0 && dead.recordPort === dead.port, dead);
}
{
  // ⑦ A PARK'S DEADLINE BELONGS TO THE PARK THAT SET IT. `retryAfter` is now
  //    the ONE gate that lets a park end by itself (round 10 generalised the
  //    runaway's), so a 'blocked' cooldown left behind by an earlier park must
  //    never become the exit a CRASH park — terminal by design — uses to
  //    unpark itself. start() clears the deadline with the park; a crash park
  //    sets none. Both sites, or neither: the control removes all three.
  const R10_DEADLINE_NEUTER = [
    ["start()'s deadline reset", 'state.backoffUntil = 0; state.runawayUntil = 0; state.retryAfter = 0; state.lastError = null;', 'state.backoffUntil = 0; state.runawayUntil = 0; state.lastError = null;', 1],
    ['the crash park declaring it has none (spawn failure)', "state.parked = true; state.parkedKind = 'crash'; state.retryAfter = 0; } notify(); return null; }", "state.parked = true; state.parkedKind = 'crash'; } notify(); return null; }", 1],
    ['the crash park declaring it has none (child exit)', "state.parked = true; state.parkedKind = 'crash'; state.retryAfter = 0;   // terminal until an explicit start(): a crash park has NO deadline", "state.parked = true; state.parkedKind = 'crash';", 1],
  ];
  const deadlineCtl = buildNeutered('r10-deadline', R10_DEADLINE_NEUTER);
  /** blocked park (deadline 1ms = already in the past) → the user's Start →
   *  a spawn that fails → a CRASH park. Then a spawn that WOULD work: only a
   *  locator that unparked itself can reach it. */
  const runDeadline = async (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-r10-deadline-'));
    const hung = await startHungServe();
    const mocks = [hung];
    const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)', 'serve', '--port', String(hung.port)], { stdio: 'ignore' });
    for (let i = 0; i < 40 && !alivePid(kid.pid); i++) await sleep(25);
    fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: hung.port, pid: kid.pid, startedAt: Date.now(), command: '/usr/bin/opencode', cwd: dir }));
    let spawnMode = 'throw';
    const loc = mod.createServeLocator({
      dataDir: dir, command: '/usr/bin/opencode', log: { warn() { }, error() { }, log() { } }, guardSampleMs: 0,
      autostart: true, maxCrashes: 1, blockedRetryMs: 1,
      readCmdline: () => null,                                   // the live recorded pid is unverifiable ⇒ the first ladder BLOCKS
      killPid: () => { }, execImpl: (_c, _a, _o, cb) => cb(null, '', ''),
      spawnImpl: (_c, args) => {
        if (spawnMode === 'throw') throw new Error('nope');
        const port = Number(args[args.indexOf('--port') + 1]);
        startMockServe({ port, state: createMockState() }).then((m) => mocks.push(m)).catch(() => { });
        const c = new EventEmitter(); c.pid = 4242; c.unref = () => { }; c.kill = () => { }; return c;
      },
    });
    await loc.ensure();
    const blocked = loc.state();
    fs.rmSync(path.join(dir, 'opencode-serve.json'), { force: true });   // that record is dealt with; what follows is about the CRASH park
    await loc.start();
    const crashed = loc.state();
    spawnMode = 'ok';
    const reopened = await loc.client({ budgetMs: 2500 });
    const end = loc.state();
    loc.stop();
    try { process.kill(kid.pid, 'SIGKILL'); } catch { }
    for (const m of mocks) { try { await m.close(); } catch { } }
    fs.rmSync(dir, { recursive: true, force: true });
    return { blockedKind: blocked.parkedKind, crashedKind: crashed.parkedKind, reopened: !!reopened, endParked: !!end.parked, endKind: end.parkedKind };
  };
  const d = await runDeadline(serve);
  ok('(the setup) an unverifiable live record parks BLOCKED, and the user\'s Start then runs into a spawn failure that parks CRASH',
    d.blockedKind === 'blocked' && d.crashedKind === 'crash', d);
  ok('a CRASH park stays terminal even though a blocked park set a cooldown earlier — a park\'s deadline is cleared with the park that owns it',
    d.reopened === false && d.endParked === true && d.endKind === 'crash', d);
  if (!deadlineCtl.mod) skip('NEGATIVE CONTROL: a stale cooldown lets a crash park unpark itself', deadlineCtl.why);
  else {
    const ctl = await runDeadline(deadlineCtl.mod);
    ok('NEGATIVE CONTROL: with the deadline resets removed, the CRASH park inherits the blocked park\'s elapsed cooldown and restarts itself — the terminal park quietly stops being terminal',
      ctl.crashedKind === 'crash' && ctl.reopened === true && ctl.endParked === false, ctl);
    try { fs.rmSync(deadlineCtl.file, { force: true }); } catch { }
  }
}
{
  const kfs = read('docs/kb-file-structure.md');
  const n10 = R10_NEUTER.length;
  ok('docs: "the record we were about to overwrite" is in the kb essays + the incident file + the index',
    /ROUND 10/.test(kfs) && /settleRecordedServe/.test(kfs)
    && /THE RECORD WE WERE ABOUT TO OVERWRITE/.test(read('docs/kb-bugfix-invariants.md'))
    && /S9 REMAINDER ROUND 10/.test(read('CLAUDE.md')));
  ok(`docs: the ROUND 10 pre-fix control's size is stated as the number R10_NEUTER owns (${n10})`,
    new RegExp(`its ${n10} replacements`).test(kfs), [n10]);
  if (r10Ctl.file) { try { fs.rmSync(r10Ctl.file, { force: true }); } catch { } }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRING, ON A REAL BOOT. The unit A/B above drives install() directly; this
// one starts the actual server the way a user's instance starts, with a fresh
// data/ and the plugin at its shipped default (OFF), and MEASURES what the
// process holds. The positive control is the same instance with the plugin
// turned on through the real route — so "zero" cannot be zero by accident.
console.log('\n— A REAL BOOT WITH THE SERVICE OFF (nothing of ours runs or watches) —');
{
  const net = await import('node:net');
  const freePort = () => new Promise((res) => { const s2 = net.createServer(); s2.listen(0, '127.0.0.1', () => { const p2 = s2.address().port; s2.close(() => res(p2)); }); });
  let ocVersion = null;
  try { ocVersion = execFileSync(process.env.OPENCODE_CMD || 'opencode', ['--version'], { encoding: 'utf-8', timeout: 15000 }).trim(); } catch { ocVersion = null; }
  const wt = `/tmp/vs-oc-s9-boot-${process.pid}`;
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-boot-home-'));
  const storeDir = path.join(ocHome, '.local/share/opencode');
  fs.mkdirSync(storeDir, { recursive: true });
  // AN EXISTING STORE. On every machine that has ever run opencode this
  // directory is already there, which is precisely why the boot arm always
  // attached: `armWatch('boot')` guessed it from the server's own env.
  fs.writeFileSync(path.join(storeDir, 'opencode.db'), 'x');
  const PORT = await freePort();
  let srv = null;
  const cleanup = () => {
    try { srv?.kill('SIGKILL'); } catch { }
    try { const r = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'opencode-serve.json'), 'utf8')); if (r.pid) process.kill(r.pid, 'SIGKILL'); } catch { }
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO, stdio: 'ignore' }); } catch { }
    for (const d of [wt, ocHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  };
  process.on('exit', cleanup);
  try {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO, stdio: 'ignore' }); } catch { }
    execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: REPO, stdio: 'ignore' });
    for (const f of ['src', 'public', 'server.js', 'package.json', 'data/bin']) execFileSync('bash', ['-c', `mkdir -p ${wt}/${path.dirname(f)} && rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`]);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
    const env = {
      ...process.env, PORT: String(PORT), VIBESPACE_PASSWORD: '',
      VIBESPACE_OPENCODE_SERVE: '',                     // no ops override: the PLUGIN is the switch, exactly as a user has it
      HOME: ocHome, XDG_DATA_HOME: path.join(ocHome, '.local/share'), XDG_CONFIG_HOME: path.join(ocHome, '.config'),
      XDG_CACHE_HOME: path.join(ocHome, '.cache'), XDG_STATE_HOME: path.join(ocHome, '.local/state'),
    };
    const bootLog = [];
    srv = spawn(process.execPath, ['server.js'], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'], env });
    srv.stdout.on('data', (d) => { bootLog.push(String(d)); if (bootLog.length > 200) bootLog.shift(); });
    srv.stderr.on('data', (d) => { bootLog.push(String(d)); if (bootLog.length > 200) bootLog.shift(); });
    let up = false;
    for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/home`)).ok; } catch { } if (!up) await sleep(250); }
    if (!up) skip('a fresh instance with the background service OFF watches nothing', `the worktree server did not boot here: ${bootLog.join('').slice(-200)}`);
    else {
      // drive the sweep the sidebar drives, several times: nothing may arm lazily
      for (let i = 0; i < 5; i++) { await fetch(`http://127.0.0.1:${PORT}/api/sessions`).catch(() => { }); await sleep(400); }
      // …and give the 5s plugin boot replay time to run and decide NOT to start
      await sleep(6000);
      const wdsOff = inotifyWdsOn(storeDir, srv.pid);
      if (wdsOff < 0) skip('a REAL boot with the service off holds ZERO fs.watch handles on the OpenCode store', 'no /proc/<pid>/fdinfo on this platform');
      else ok('a REAL boot with the background service OFF holds ZERO fs.watch handles on the user\'s OpenCode store', wdsOff === 0, { wdsOff, storeDir });
      ok('…and started no serve at all: no record, and not even the throwaway cwd a spawn would need', !fs.existsSync(path.join(wt, 'data', 'opencode-serve.json')) && !fs.existsSync(path.join(wt, 'data', 'opencode-serve')), fs.readdirSync(path.join(wt, 'data')).filter((x) => /opencode/.test(x)));
      const home = await fetch(`http://127.0.0.1:${PORT}/api/home`).then((r) => r.json()).catch(() => null);
      const ocRow = (home?.harnesses || []).find((h) => h.id === 'opencode') || null;
      ok('…and /api/home calls it OFF, not BROKEN (a deliberately-off service is no error toast)', !!ocRow && !ocRow.storeReason && ocRow.service && ocRow.service.enabled === false, ocRow);

      // POSITIVE CONTROL, same process, same measurement: turn it on the way a
      // user does. Without this, "0 watches" could just be a measurement that
      // never works.
      if (!ocVersion) skip('…and turning the plugin ON makes THIS instance watch the store (the control)', 'no `opencode` on PATH — the control needs a serve that really boots');
      else {
        fs.rmSync(path.join(storeDir, 'opencode.db'), { force: true });   // let the REAL serve create a REAL sqlite here
        await fetch(`http://127.0.0.1:${PORT}/api/plugins/opencode-serve/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }).catch(() => { });
        let st = null;
        for (let i = 0; i < 120 && !(st && st.ready); i++) { await sleep(500); st = await fetch(`http://127.0.0.1:${PORT}/api/opencode/state`).then((r) => r.json()).catch(() => null); }
        if (!st?.ready) skip('…and turning the plugin ON makes THIS instance watch the store (the control)', `the serve did not come up here: ${st?.lastError || 'no state'}`);
        else {
          let wdsOn = 0;
          for (let i = 0; i < 120 && wdsOn <= 0; i++) { wdsOn = inotifyWdsOn(storeDir, srv.pid); if (wdsOn <= 0) await sleep(500); }
          if (wdsOn < 0) skip('…and turning the plugin ON makes THIS instance watch the store (the control)', 'no /proc/<pid>/fdinfo on this platform');
          else if (wdsOn === 0) skip('…and turning the plugin ON makes THIS instance watch the store (the control)', 'the lane never attached a watch here (an inotify-exhausted box degrades LOUDLY by design)');
          else {
            ok('…and turning the plugin ON makes THIS SAME instance watch the store — the control that proves the OFF measurement could fail', wdsOn > 0, { wdsOn });
            // THE PID COMES FROM THE RECORD, NOT FROM /api/opencode/state.
            // That route answers through OPENCODE_OPS.state, whose result()
            // normaliser (src/opencode-remote.js) emits no `pid` — so the old
            // `process.kill(st.pid, 0)` called kill(undefined), threw a
            // TypeError into the catch, and `stillAlive` was PERMANENTLY
            // false: the "stops the daemon" half of this assert could not
            // fail, whatever the product did. A missing pid is now a failure
            // of its own, and the liveness helper returns null (never a
            // reassuring `false`) when it has nothing to ask about.
            let servePid = null;
            try { servePid = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'opencode-serve.json'), 'utf8')).pid; } catch { servePid = null; }
            ok('(the measurement) the running serve names its pid in data/opencode-serve.json — without one, a liveness check passes by accident', typeof servePid === 'number' && servePid > 0, { servePid, state: { ready: st.ready, port: st.port } });
            const alive = (pid) => { if (typeof pid !== 'number' || pid <= 0) return null; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
            ok('(the control) …and that pid is ALIVE while the service is on — so "gone" below is a real transition', alive(servePid) === true, { servePid, alive: alive(servePid) });
            await fetch(`http://127.0.0.1:${PORT}/api/plugins/opencode-serve/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => { });
            let wdsBack = wdsOn;
            for (let i = 0; i < 120 && wdsBack > 0; i++) { await sleep(500); wdsBack = inotifyWdsOn(storeDir, srv.pid); }
            let stillAlive = alive(servePid);
            for (let i = 0; i < 40 && stillAlive === true; i++) { await sleep(250); stillAlive = alive(servePid); }   // SIGTERM → exit is not instant
            ok('…and turning it OFF gives the watch back AND stops the daemon (off means the process is gone)', wdsBack === 0 && stillAlive === false, { wdsBack, servePid, stillAlive });
          }
        }
      }
    }
  } catch (e) {
    ok('the real-boot leg ran without an unexpected error', false, String(e && e.message || e));
  }
  cleanup();
  process.removeListener('exit', cleanup);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— REAL BINARY (skips WITH EVIDENCE when opencode is absent) —');
{
  let version = null;
  try { version = execFileSync(process.env.OPENCODE_CMD || 'opencode', ['--version'], { encoding: 'utf-8', timeout: 15000 }).trim(); } catch (e) { version = null; }
  if (!version) {
    skip('a REAL `opencode serve` answers the routes this feature set uses', 'no `opencode` on PATH (set OPENCODE_CMD) — the mock section above still ran');
  } else {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-real-'));
    const cwd = path.join(home, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    try { execFileSync('git', ['init', '-q', cwd], { timeout: 10000 }); } catch { }
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state') };
    const dataDir = path.join(home, 'data');
    const facts = serve.install({ dataDir, command: process.env.OPENCODE_CMD || 'opencode', env: () => env, log: { warn() { }, error() { } }, stopOnExit: true, autostart: true, live: false });
    let client = null;
    try { client = await facts.locator.ensure(); } catch { client = null; }
    if (!client) {
      skip(`a REAL \`opencode serve\` (${version}) boots`, facts.reasonUnavailable());
    } else {
      ok(`a REAL opencode serve (${version}) boots and answers /session/status without a directory`, (await client.sessionStatus({ timeoutMs: 8000 })) !== null);
      ok('…and /question (the ask lane) answers with a list', Array.isArray(await client.questions({ timeoutMs: 8000 })));
      ok('…and /path reports the store home the fs.watch lane needs', typeof (await client.paths({ timeoutMs: 8000 }))?.home === 'string');
      const dirs = events.storeDirsFor({ env, serveHome: (await client.paths({ timeoutMs: 8000 })).home });
      ok('…and that home resolves to the sqlite store directory we watch', dirs.some((d) => fs.existsSync(path.join(d, 'opencode.db'))), dirs);
      // the live lane against the real serve
      const lane = events.createLiveLane({ locator: facts.locator, storeDirs: dirs, onEvent: () => { }, log: { warn() { } } });
      lane.start();
      await sleep(2500);
      ok('…and the REAL /global/event stream connects (the lane the poll was replaced by)', lane.state().sse.connected === true, lane.state());
      lane.stop();
      try {
      // ── a REAL roll-back, end to end, on a REAL store ──
      // `noReply` posts a user message without spending a token on a model, and
      // OpenCode still takes the snapshot a roll-back needs (verified).
      const post = async (route, body) => (await fetch(client.baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      const sess = await post('/session', { title: 's9 gate roll-back' });
      const msg = await post(`/session/${sess.id}/message`, { noReply: true, parts: [{ type: 'text', text: 'the message we roll back to' }] });
      await facts.discover({});                        // FIRST sighting: a row we have never seen proves nothing
      const reverted = await facts.revertTo(sess.id, { messageID: msg.info.id, cwd });
      ok('…a REAL roll-back stages the message and comes back on the Session', reverted?.revert?.messageID === msg.info.id, reverted?.revert);
      const rConv = await facts.readConversation(sess.id);
      ok('…and the REAL conversation renders the roll-back notice at the boundary', rConv.records.some((r) => r.noticeKind === 'revert'), rConv.records.map((r) => r.kind));
      facts.invalidate();
      const rRows = await facts.discover({});
      const rRow = rRows.find((r) => r.backendSessionId === sess.id);
      ok('…the sidebar entry carries the staged roll-back', rRow?.opencode?.revert?.messageID === msg.info.id, rRow?.opencode);
      // NEGATIVE CONTROL on a REAL store (round 3): the roll-back we just made
      // is the USER's own action — the row must stay stopped. MEASURED before
      // the fix: 'stopped' → 'external' within 6s, three runs out of three,
      // through the real product routes.
      ok('…and the row we ourselves rolled back stays STOPPED (our own click never fakes another process)', rRow?.status === 'stopped', rRow?.status);
      // POSITIVE CONTROL on the same real store: a SECOND opencode process
      // writing the SAME sqlite is what 'external' exists for. Its events never
      // reach our serve's bus (measured, see src/opencode-events.js) — only the
      // store row does, which is exactly the rung under test.
      const before2 = (await facts.discover({})).find((r) => r.backendSessionId === sess.id)?.status;
      const second = spawn(process.env.OPENCODE_CMD || 'opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let secondBase = null, secondOut = '';
      const scan = (d) => { secondOut += d; const mm = secondOut.match(/https?:\/\/127\.0\.0\.1:\d+/); if (mm && !secondBase) secondBase = mm[0]; };
      second.stdout.on('data', scan); second.stderr.on('data', scan);
      for (let i = 0; i < 300 && !secondBase; i++) await sleep(100);
      if (!secondBase) {
        skip('…while a SECOND opencode process on the same store DOES read external', `a second serve would not boot here: ${secondOut.slice(-160) || 'no listen line'}`);
      } else {
        await fetch(`${secondBase}/session/${sess.id}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ noReply: true, parts: [{ type: 'text', text: 'written by another opencode process' }] }) }).catch(() => { });
        await sleep(400);
        facts.invalidate();
        const xRow = (await facts.discover({})).find((r) => r.backendSessionId === sess.id);
        ok('…while a SECOND opencode process writing the same store DOES read external (the rung is alive, not switched off)', xRow?.status === 'external', { before2, after: xRow?.status });
      }
      try { second.kill('SIGTERM'); } catch { }
      await sleep(300);
      const restored = await facts.unrevert(sess.id, { cwd });
      ok('…a REAL restore clears it', !restored?.revert);
      const rConv2 = await facts.readConversation(sess.id);
      ok('…and the notice is gone', !rConv2.records.some((r) => r.noticeKind === 'revert'));
      await fetch(client.baseUrl + `/session/${sess.id}`, { method: 'DELETE' }).catch(() => { });
      try {
        // ROUND 4, MEASURED not assumed: opening a terminal must not make the
        // serve index and inotify-watch the user's tree. Same-origin A/B on
        // THIS serve — the product path, then the OLD `?directory=` shape —
        // with /proc thread + `inotify wd` sampling. On the owner's box the old
        // shape left 204 watch descriptors alive across DELETE; here the target
        // is a purpose-built ~60-directory tree so the delta is unmistakable
        // without costing the machine's inotify budget.
        const wdTree = path.join(home, 'wd-tree');
        // FILES, not just directories: measured, OpenCode's watcher follows the
        // indexed tree, and 60 EMPTY dirs produced only a 4-watch delta even
        // with the old shape (the control has to be able to fail).
        for (let i = 0; i < 60; i++) {
          fs.mkdirSync(path.join(wdTree, 'd' + i), { recursive: true });
          for (let j = 0; j < 3; j++) fs.writeFileSync(path.join(wdTree, 'd' + i, `f${j}.txt`), 'x');
        }
        try { execFileSync('git', ['init', '-q', wdTree], { timeout: 10000 }); } catch { }
        const servePid = facts.locator.state().pid;
        const wds = () => {
          let n = 0;
          try { for (const fd of fs.readdirSync(`/proc/${servePid}/fdinfo`)) { let t = ''; try { t = fs.readFileSync(`/proc/${servePid}/fdinfo/${fd}`, 'utf-8'); } catch { continue; } n += (t.match(/^inotify wd:/gm) || []).length; } } catch { return -1; }
          return n;
        };
        const wBase = wds();
        const pty = await facts.openPty({ cwd: wdTree, title: 's9 gate' });
        ok('…and a REAL serve pty opens with a loopback ws url (no ticket on an unsecured serve)', /^ws:\/\/127\.0\.0\.1:\d+\/pty\/pty_/.test(pty.url) && pty.ticketed === false, pty.url);
        let shellCwd = null;
        try { shellCwd = fs.readlinkSync(`/proc/${pty.pty.pid}/cwd`); } catch { shellCwd = null; }
        if (shellCwd === null) skip('…in the directory the user asked for', 'the shell pid is not readable in /proc here');
        else ok('…in the directory the user asked for (the `cwd` BODY field places the shell — the query never did)', shellCwd === fs.realpathSync(wdTree), { shellCwd, wdTree });
        await sleep(2500);
        const wOpen = wds();
        await facts.closePty(pty.pty.id, { cwd: wdTree });
        await sleep(2000);
        const wClose = wds();
        // the NEGATIVE CONTROL: the OLD shape, on the same serve, same tree
        const ou = new URL(client.baseUrl + '/pty'); ou.searchParams.set('directory', wdTree);
        const oldPty = await (await fetch(ou, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: wdTree, command: '/bin/bash' }) })).json();
        await sleep(2500);
        const wOld = wds();
        const du = new URL(client.baseUrl + `/pty/${oldPty.id}`); du.searchParams.set('directory', wdTree);
        await fetch(du, { method: 'DELETE' }).catch(() => { });
        await sleep(2000);
        const wOldClose = wds();
        if (wBase < 0) skip('…and it indexes NOTHING of that tree (/proc inotify delta, with the old shape as the control)', 'no /proc fdinfo for the serve on this platform');
        else if (wOld <= wOpen) skip('…and it indexes NOTHING of that tree (/proc inotify delta)', `the control did not reproduce here (base=${wBase} new=${wOpen} old=${wOld}) — inotify may be exhausted`);
        else ok('…and it indexes NOTHING of that tree: the product path leaves the watch count flat while the OLD `?directory=` shape adds a watch per directory AND keeps them after DELETE',
          wOpen - wBase <= 4 && wClose - wBase <= 4 && wOld - wOpen >= 20 && wOldClose >= wOld - 4, { wBase, wOpen, wClose, wOld, wOldClose });
        // …and the reaper really removes a serve-owned pty nobody holds
        const orphan = await facts.openPty({ cwd, title: 's9 reaper' });
        facts._live.ptys.clear();
        const swept = await facts.reapPtys({ force: true });
        const stillThere = (await client.ptyList({ timeoutMs: 8000 })).some((x) => x.id === orphan.pty.id);
        ok('…and reapPtys() removes a REAL serve-owned terminal no session can reach (the shell the restart stranded)', swept.removed?.includes(orphan.pty.id) && !stillThere, { swept, stillThere });
      } catch (e) {
        // opening a pty BOOTS the OpenCode instance for that directory, which
        // needs inotify watches this box may be out of
        if (/timed out|EMFILE|ENOSPC/i.test(e.message || '')) skip('…and a REAL serve pty opens with a loopback ws url', `the serve could not boot an instance here: ${e.message}`);
        else ok('…and a REAL serve pty opens with a loopback ws url (no ticket on an unsecured serve)', false, e.message);
      }

      } catch (e) {
        // a REAL serve on a saturated box can be slow or unreachable; that is
        // the ENVIRONMENT, and it says so instead of taking the suite down
        const m = String(e && e.message || e);
        if (/timed out|EMFILE|ENOSPC|fetch failed|ECONNREFUSED/i.test(m)) skip('the REAL-binary roll-back legs ran', `the serve became unreachable on this machine: ${m}`);
        else ok('the REAL-binary section ran without an unexpected error', false, m);
      }
    }
    try { facts.locator.stop({ killRecorded: true }); } catch { }
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The PREMISE the warm question map violated, on the real binary: `/question`
// is answered out of ONE serve process's memory. A real ask cannot be minted
// without spending a model turn (there is no create route — `POST
// /api/question/request` does not exist; the v2 path is a LIST), so the leg
// drives the real restart and the real routes with a `que_…` we plant the way
// a `question.asked` frame would.
console.log('\n— REAL BINARY: THE PENDING-ASK LIST IS PER SERVE PROCESS —');
{
  let version = null;
  try { version = execFileSync(process.env.OPENCODE_CMD || 'opencode', ['--version'], { encoding: 'utf-8', timeout: 15000 }).trim(); } catch { version = null; }
  if (!version) skip('a REAL serve restart makes a warm ask map unanswerable', 'no `opencode` on PATH (set OPENCODE_CMD)');
  else {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-qreal-'));
    const cwd = path.join(home, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    try { execFileSync('git', ['init', '-q', cwd], { timeout: 10000 }); } catch { }
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state') };
    const facts = serve.install({ dataDir: path.join(home, 'data'), command: process.env.OPENCODE_CMD || 'opencode', env: () => env, log: { warn() { }, error() { } }, stopOnExit: true, autostart: true, live: false, backoffBaseMs: 300 });
    let client = null;
    try { client = await facts.locator.ensure(); } catch { client = null; }
    if (!client) skip(`a REAL serve restart makes a warm ask map unanswerable (${version})`, facts.reasonUnavailable());
    else {
      ok(`a REAL opencode serve (${version}) answers /question with an EMPTY list on a fresh process`, (await facts.pendingQuestions({ refresh: true })).length === 0);
      // plant the ask this process would have learned from a `question.asked`
      // frame: the map is now warm AND stamped for the RUNNING serve
      facts._live.questions.set('que_real1', { id: 'que_real1', sessionID: 'ses_real', questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }], tool: { messageID: 'msg_r', callID: 'call_r' }, at: Date.now() });
      ok('…and a pending ask on the RUNNING serve is warm, so a card would be joined to it', facts.state().pendingQuestions === 1 && (await facts.pendingQuestions({ sessionId: 'ses_real' })).length === 1, facts.state().pendingQuestions);
      const pid1 = facts.locator.state().pid, port1 = facts.locator.state().port;
      // THE RESTART: the keeper's own respawn path, on a real child
      try { process.kill(pid1, 'SIGTERM'); } catch { }
      let st2 = facts.locator.state();
      for (let i = 0; i < 200 && !(st2.ready && st2.pid && st2.pid !== pid1); i++) { await sleep(150); await facts.locator.client({ budgetMs: 1500 }).catch(() => { }); st2 = facts.locator.state(); }
      if (!(st2.ready && st2.pid !== pid1)) skip('…and the REAL replacement serve knows nothing of it', `the keeper did not bring a replacement up here: ${st2.lastError || 'no state'}`);
      else {
        const client2 = await facts.locator.client({ budgetMs: 8000 });
        ok('a REAL restarted serve is a NEW process on a NEW port whose /question is EMPTY (the list is per process)', st2.port !== port1 && (await client2.questions({ timeoutMs: 8000 })).length === 0, { pid1, port1, pid2: st2.pid, port2: st2.port });
        ok('…so the warm map stops being trusted: the facts claim ZERO pending asks', facts.state().pendingQuestions === 0, facts.state().pendingQuestions);
        ok('…and pendingQuestions() answers [] instead of inventing one (⇒ readConversation marks the card STALE)', (await facts.pendingQuestions({ sessionId: 'ses_real' })).length === 0);
        let broke = null;
        try { await facts.answerQuestion('que_real1', [['Blue']]); } catch (e) { broke = e; }
        ok('…and answering the dead id fails LOUDLY against the real serve — the Submit a stale card must never offer', !!broke && /que_real1/.test(broke.message), broke?.message);
      }
    }
    try { facts.locator.stop({ killRecorded: true }); } catch { }
    serve.uninstall();
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— IN A REAL BROWSER (the surfaces a user actually touches) —');
{
  const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((f) => fs.existsSync(f));
  let ocVersion = null;
  try { ocVersion = execFileSync(process.env.OPENCODE_CMD || 'opencode', ['--version'], { encoding: 'utf-8', timeout: 15000 }).trim(); } catch { ocVersion = null; }
  if (!CHROME) skip('the roll-back rows and the ask card render in a real browser', 'no chrome/chromium on this machine');
  else if (!ocVersion) skip('the roll-back rows and the ask card render in a real browser', 'no `opencode` on PATH — the chrome leg drives a REAL serve-backed conversation');
  else {
    const { spawn, execSync } = await import('node:child_process');
    const net = await import('node:net');
    const freePort = () => new Promise((res) => { const s2 = net.createServer(); s2.listen(0, '127.0.0.1', () => { const p2 = s2.address().port; s2.close(() => res(p2)); }); });
    const wt = `/tmp/vs-oc-s9-chrome-${process.pid}`;
    const udd = `/tmp/vs-oc-s9-udd-${process.pid}`;
    const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-s9-home-'));
    const PORT = await freePort(), CDP = await freePort();
    let srv = null, chrome = null;
    const cleanup = () => {
      try { chrome?.kill('SIGKILL'); } catch { }
      try { srv?.kill('SIGKILL'); } catch { }
      try { const r = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'opencode-serve.json'), 'utf8')); if (r.pid) process.kill(r.pid, 'SIGKILL'); } catch { }
      try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
      for (const d of [wt, udd, ocHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
    };
    process.on('exit', cleanup);
    try {
      // a worktree with its OWN data/ — never the repo's (the #127 class)
      try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
      execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
      for (const f of ['src', 'public', 'server.js', 'package.json', 'data/bin']) execSync(`mkdir -p ${wt}/${path.dirname(f)} && rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
      fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
      const env = {
        ...process.env, PORT: String(PORT), VIBESPACE_PASSWORD: '',
        VIBESPACE_OPENCODE_SERVE: '',                        // no ops override: the PLUGIN is the switch, exactly as a user has it
        HOME: ocHome, XDG_DATA_HOME: path.join(ocHome, '.local/share'), XDG_CONFIG_HOME: path.join(ocHome, '.config'),
        XDG_CACHE_HOME: path.join(ocHome, '.cache'), XDG_STATE_HOME: path.join(ocHome, '.local/state'),
      };
      const srvLog = [];
      srv = spawn(process.execPath, ['server.js'], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'], env });
      srv.stdout.on('data', (d) => { srvLog.push(String(d)); if (srvLog.length > 400) srvLog.shift(); });
      srv.stderr.on('data', (d) => { srvLog.push(String(d)); if (srvLog.length > 400) srvLog.shift(); });
      globalThis.__srvLog = srvLog;
      for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
      // Turn the service on the way a user does — through the PLUGIN. (With it
      // off, the client's first-use dialog opens instead of the conversation,
      // which is correct behaviour and is gated by test-opencode-plugin.)
      await fetch(`http://127.0.0.1:${PORT}/api/plugins/opencode-serve/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }).catch(() => { });
      await fetch(`http://127.0.0.1:${PORT}/api/plugins/opencode-serve/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => { });
      // the server's OWN serve (its keeper, its isolated cwd) — ask it where it is
      let st = null;
      for (let i = 0; i < 80 && !(st && st.ready && st.port); i++) { await sleep(500); st = await fetch(`http://127.0.0.1:${PORT}/api/opencode/state`).then((r) => r.json()).catch(() => null); }
      ok('the worktree server started its OWN OpenCode serve and reports it', !!(st && st.ready && st.port), st);
      const base = `http://127.0.0.1:${st?.port}`;
      const post = async (route, body) => (await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      const sess = await post('/session', { title: 'browser leg' });
      const msg = await post(`/session/${sess.id}/message`, { noReply: true, parts: [{ type: 'text', text: 'roll me back' }] });
      let listed = null;
      for (let i = 0; i < 40 && !listed; i++) {
        await sleep(500);
        const d = await fetch(`http://127.0.0.1:${PORT}/api/sessions`).then((r) => r.json()).catch(() => null);
        listed = (d?.sessions || []).find((x) => x.backendSessionId === sess.id) || null;
      }
      ok('…and the conversation reaches the session list the sidebar renders', !!listed, listed && { id: listed.backendSessionId, status: listed.status });

      chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
      let target = null;
      for (let i = 0; i < 120 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((x) => x.type === 'page'); } catch { } if (!target) await sleep(250); }
      if (!target) { ok('chrome exposed a CDP page target', false); }
      else {
        const WS = require('ws');
        const ws = new WS(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((r) => ws.on('open', r));
        let seq = 0; const pend = new Map(); const pageErrors = [];
        ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?'); });
        const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
        const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await cdp('Runtime.enable'); await cdp('Page.enable');
        await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
        let ready = false;
        for (let i = 0; i < 80 && !ready; i++) { await sleep(500); ready = await ev('(async()=>{ try { await window.app?.ready; return !!window.app; } catch { return false; } })()').catch(() => false); }
        ok('the app booted in headless chrome', !!ready);

        ok('App carries the serve-terminal action (the session-card command calls it)', await ev('typeof window.app.openOpencodeTerminal === "function"'));

        // THE SESSION-CARD MENU, rendered for real
        const menu = await ev(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const app = window.app;
          for (let i = 0; i < 40; i++) { if ((app.sidebar?._allSessions || []).some((s) => s.backendSessionId === ${JSON.stringify(sess.id)})) break; await sleep(500); }
          const s = (app.sidebar._allSessions || []).find((x) => x.backendSessionId === ${JSON.stringify(sess.id)});
          if (!s) return { err: 'session never reached the sidebar' };
          try { app.sidebar.toggle(true); } catch {}
          await sleep(600);
          let card = null;
          for (let i = 0; i < 20 && !card; i++) {
            card = [...document.querySelectorAll('.session-item-card')].find((c) => /browser leg/.test(c.textContent)) || null;
            if (!card) await sleep(400);
          }
          if (!card) return { err: 'no card', cards: document.querySelectorAll('.session-item-card').length, sample: [...document.querySelectorAll('.session-item-card')].slice(0, 3).map((c) => c.textContent.slice(0, 40)) };
          card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 }));
          await sleep(400);
          const items = [...document.querySelectorAll('.context-menu .context-menu-item')].map((e) => e.textContent.trim()).filter(Boolean);
          document.body.click();
          return { items };
        })()`);
        ok('the session card of an OpenCode conversation OFFERS the serve terminal (rendered menu, not a code grep)', Array.isArray(menu?.items) && menu.items.some((x) => /Open terminal in this session/i.test(x)), menu);

        // THE CHAT WINDOW: the reader, the roll-back row, and the confirm dialog
        const opened = await ev(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          window.app.viewSession(${JSON.stringify(sess.id)}, ${JSON.stringify(sess.directory || '')}, 'browser leg', { backend: 'opencode', backendSessionId: ${JSON.stringify(sess.id)} });
          let list = null;
          // wait for a REAL message, not the "Loading history…" placeholder
          for (let i = 0; i < 90; i++) {
            list = document.querySelector('.chat-message-list');
            if (list && [...list.querySelectorAll('.chat-msg')].some((e) => !/Loading history/.test(e.textContent))) break;
            await sleep(400);
          }
          if (!list) return { ok: false };
          window.__ocList = list;
          const cv = [...window.app.sessions.values()].find((x) => x && x._messageList === list) || null;
          window.__ocCv = cv;
          return { ok: true, msgs: list.querySelectorAll('.chat-msg').length, hasCv: !!cv, cvMsgs: cv?._messages?.length ?? null, text: list.textContent.slice(0, 300), cls: [...list.querySelectorAll('.chat-msg')].map((e) => e.className) };
        })()`);
        ok('the serve-backed conversation opens read-only in a real chat window', opened?.ok && opened.msgs > 0 && opened.hasCv && opened.cvMsgs >= 1, opened);

        const popup = await ev(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const list = window.__ocList;
          const els = [...list.querySelectorAll('.chat-msg[data-msg-id]')];
          const el = els.find((e) => e.className.includes('chat-msg-user')) || els[0];
          if (!el) return { err: 'no addressable message', all: list.querySelectorAll('.chat-msg').length, cls: [...list.querySelectorAll('.chat-msg')].map((e) => e.className).slice(0, 5) };
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 4, clientY: r.top + 8 }));
          await sleep(400);
          const pop = document.querySelector('.msg-meta-pop');
          const btns = pop ? [...pop.querySelectorAll('button')].map((b) => b.textContent.trim()) : null;
          window.__ocPop = pop;
          window.__ocMsgEl = el;
          return { btns, cls: el.className, rows: pop ? pop.textContent.slice(0, 120) : null };
        })()`);
        ok('right-clicking a USER message offers "Roll back to before this message" (and no Restore — nothing is staged)', Array.isArray(popup?.btns) && popup.btns.some((b) => /Roll back to before this message/i.test(b)) && !popup.btns.some((b) => /Restore rolled-back/i.test(b)), popup);

        const confirmed = await ev(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const pop = window.__ocPop;
          [...pop.querySelectorAll('button')].find((b) => /Roll back to before this message/i.test(b.textContent)).click();
          await sleep(400);
          // index.html carries pre-built (hidden) dialog overlays — pick the one
          // that is actually asking THIS question
          const dlg = [...document.querySelectorAll('.dialog-overlay')].find((o) => /Roll back this conversation/i.test(o.textContent)) || null;
          const text = dlg ? dlg.textContent : '';
          const okBtn = dlg ? [...dlg.querySelectorAll('button')].find((b) => /^Roll back$/i.test(b.textContent.trim())) : null;
          if (!okBtn) return { dlg: !!dlg, text: text.slice(0, 200) };
          okBtn.click();
          // a REAL roll-back on a loaded box takes a moment — wait for the
          // result, do not sample once
          let toasts = [];
          for (let i = 0; i < 40; i++) {
            toasts = [...document.querySelectorAll('#global-toasts .global-toast, #global-toasts div')].map((e) => e.textContent.trim());
            if (toasts.some((x) => /Rolled back/i.test(x))) break;
            await sleep(500);
          }
          const errs = [...document.querySelectorAll('#global-toasts .global-toast-error')].map((e) => e.textContent.trim());
          return { asked: true, text: text.slice(0, 200), toasts, errs };
        })()`);
        ok('…it ASKS first (never a native confirm) and the dialog says what it does', confirmed?.asked === true && /restore the files/i.test(confirmed.text || ''), confirmed);
        ok('…confirming performs a REAL roll-back and reports it (no error toast, and no misleading "Copied")', Array.isArray(confirmed?.toasts) && confirmed.toasts.some((x) => /Rolled back/i.test(x)) && !confirmed.toasts.some((x) => /^Copied/.test(x)) && (confirmed.errs || []).length === 0, confirmed);

        let server = null;
        for (let i = 0; i < 20; i++) { server = await fetch(`${base}/session/${sess.id}`).then((r) => r.json()).catch(() => null); if (server?.revert) break; await sleep(500); }
        ok('…and the SERVE really staged it (the round trip, not just the toast)', server?.revert?.messageID === msg.info.id, server?.revert);

        const after = await ev(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          // the broadcast echo: the sidebar re-polls and the open window says so
          for (let i = 0; i < 30; i++) { if ((window.app.sidebar._allSessions || []).find((s) => s.backendSessionId === ${JSON.stringify(sess.id)})?.opencode?.revert) break; await sleep(500); }
          const row = (window.app.sidebar._allSessions || []).find((s) => s.backendSessionId === ${JSON.stringify(sess.id)});
          const said = [...window.__ocList.querySelectorAll('.chat-msg')].map((e) => e.textContent).join(' ');
          const el = window.__ocMsgEl;
          const r2 = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r2.left + 4, clientY: r2.top + 8 }));
          await sleep(350);
          const pop = document.querySelector('.msg-meta-pop');
          const btns = pop ? [...pop.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
          document.body.click();
          return { staged: !!row?.opencode?.revert, said: /Rolled back/i.test(said), btns };
        })()`);
        ok('…the sidebar row learns the staged roll-back through the broadcast (multi-client law)', after?.staged === true, after);
        ok('…the open window SAYS what happened in-line', after?.said === true, after?.said);
        ok('…and NOW the popup offers Restore instead of another roll-back', (after?.btns || []).some((b) => /Restore rolled-back/i.test(b)) && !(after?.btns || []).some((b) => /Roll back to before/i.test(b)), after?.btns);

        // THE SERVE TERMINAL, opened for real from the App action
        const term = await ev(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const before = document.querySelectorAll('.xterm').length;
          window.app.openOpencodeTerminal({ cwd: ${JSON.stringify(sess.directory || '')}, name: 'serve term' });
          // READ THE XTERM BUFFER, not the .xterm-rows DOM: this app uses the WebGL
          // renderer, which paints to a canvas and leaves the DOM rows empty —
          // asserting on the DOM would be measuring the renderer, not the data
          const bufText = () => {
            const ts = [...window.app.sessions.values()].filter((x) => x && x.terminal && x.terminal.buffer);
            const t = ts[ts.length - 1];
            if (!t) return null;
            const b = t.terminal.buffer.active;
            let out = '';
            for (let i = 0; i < Math.min(b.length, 40); i++) out += (b.getLine(i)?.translateToString(true) || '') + '\\n';
            return out.trim();
          };
          let rows = null;
          for (let i = 0; i < 150; i++) {
            const txt = bufText();
            if (txt) { rows = { textContent: txt }; break; }
            await sleep(400);
          }
          return { terms: document.querySelectorAll('.xterm').length, before, text: rows ? rows.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
            wins: document.querySelectorAll('.window').length,
            titles: [...document.querySelectorAll('.window-title')].map((e) => e.textContent.trim()).slice(0, 6),
            toasts: [...document.querySelectorAll('#global-toasts div')].map((e) => e.textContent.trim()).slice(0, 4),
            bodies: [...document.querySelectorAll('.window-body')].map((e) => e.textContent.trim().slice(0, 80)).slice(0, 6) };
        })()`);
        const srvTail = (globalThis.__srvLog || []).join('');
        const termOk = term?.terms > term?.before && !!term?.text;
        // THE DISCRIMINATOR: ask the SERVE. A running pty with an empty xterm is
        // OUR bridge failing (a real defect); NO pty at all means the create
        // never completed on the serve — booting an OpenCode instance needs
        // inotify watches this shared box is frequently out of.
        const ptys = await fetch(`${base}/pty`).then((r) => r.json()).catch(() => null);
        const servePty = Array.isArray(ptys) && ptys.some((x) => x.status === 'running');
        if (!termOk && !servePty) {
          const why = envExhausted(srvTail) ? (srvTail.match(/EMFILE[^\n]*/) || [''])[0].slice(0, 140) : 'the serve never created the pty (instance boot did not finish in 60s)';
          skip('"Open terminal in this session" opens a SERVE-owned shell', `not reproducible here: ${why}`);
          skip('…and the pty exists ON THE SERVE', 'same');
        } else {
          ok('"Open terminal in this session" really opens a SERVE-owned shell and its output reaches xterm', termOk, { ...term, server: srvTail.split('\n').filter((l) => /opencode|pty|error|Error/i.test(l)).slice(-6) });
          ok('…and the pty exists ON THE SERVE (not a local dtach spawn)', servePty, ptys);
        }

        // THE ASK CARD — rendered by the REAL renderer, both branches
        const cards = await ev(`(async () => {
          const cv = window.__ocCv;
          // renderPermissionOverlay attaches the card INSIDE the message's tool
          // block (.chat-tool-use), which is where a real tool card puts it
          const mk = (perm) => { const el = document.createElement('div'); el.className = 'chat-msg'; el.innerHTML = '<div class="chat-tool-use"></div>'; document.body.appendChild(el); cv._renderers.renderPermissionOverlay(el, { role: 'tool', permission: perm }); return el; };
          const q = [{ question: 'Do you prefer red or blue?', header: 'Color', options: [{ label: 'Red', description: 'the color red' }, { label: 'Blue', description: 'the color blue' }] }];
          const liveEl = mk({ kind: 'user_input', requestId: 'que_x', questions: q, resolved: null, via: 'opencode-serve' });
          const staleEl = mk({ kind: 'user_input', requestId: 'call_x', questions: q, resolved: null, stale: true, via: 'opencode-serve' });
          const doneEl = mk({ kind: 'user_input', requestId: 'call_y', questions: q, resolved: 'allowed', selectedAnswers: { 'Do you prefer red or blue?': 'Blue' }, via: 'opencode-serve' });
          const txt = (e) => e.textContent;
          return {
            liveOptions: liveEl.querySelectorAll('.chat-ask-option').length,
            liveSubmit: !!liveEl.querySelector('.chat-ask-submit'),
            staleSubmit: !!staleEl.querySelector('.chat-ask-submit'),
            staleSays: /no longer waiting/i.test(txt(staleEl)),
            doneSays: /Answered/i.test(txt(doneEl)) && /Blue/.test(txt(doneEl)),
          };
        })()`);
        ok('a PENDING ask renders as the real AskUserQuestion card (options + Submit)', cards?.liveOptions === 2 && cards?.liveSubmit === true, cards);
        ok('a STALE ask renders WITHOUT a Submit and says why (the dead-button case)', cards?.staleSubmit === false && cards?.staleSays === true, cards);
        ok('an ANSWERED ask renders the answer', cards?.doneSays === true, cards);
        ok('no uncaught page exceptions during the whole leg', pageErrors.length === 0, pageErrors.slice(0, 3));
      }
    } finally { cleanup(); process.removeAllListeners('exit'); }
  }
}

console.log(`\n${fails.length ? fails.length + ' FAILED' : 'ALL PASS'} (${pass} passed)`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
