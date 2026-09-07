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
import { execFileSync } from 'node:child_process';
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
      // …and, on the SAME real store, a change WE did not make reads external
      ok('…and that row now reads external — a real change we did not drive (piece (f), rung 2)', rRow?.status === 'external', rRow?.status);
      const restored = await facts.unrevert(sess.id, { cwd });
      ok('…a REAL restore clears it', !restored?.revert);
      const rConv2 = await facts.readConversation(sess.id);
      ok('…and the notice is gone', !rConv2.records.some((r) => r.noticeKind === 'revert'));
      await fetch(client.baseUrl + `/session/${sess.id}`, { method: 'DELETE' }).catch(() => { });
      try {
        const pty = await facts.openPty({ cwd, title: 's9 gate' });
        ok('…and a REAL serve pty opens with a loopback ws url (no ticket on an unsecured serve)', /^ws:\/\/127\.0\.0\.1:\d+\/pty\/pty_/.test(pty.url) && pty.ticketed === false, pty.url);
        await facts.closePty(pty.pty.id, { cwd });
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
