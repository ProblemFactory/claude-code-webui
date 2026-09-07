#!/usr/bin/env node
// S9 (B-03f2) — OpenCode serve-mode STORE facts (docs/design-harness-plugins.md
// §2.4): src/opencode-serve.js against scripts/dev/mock-opencode-serve.mjs (a
// node http mock of the 1.18.29 API subset we use) —
//   ① the client (list/get/messages/first-message/fork; 404 + timeout + refused → OpencodeServeError)
//   ② messagesToAcpRecords: the documented part→record mapping, rendered by the REAL AcpMessageManager
//   ③ facts.discover: entry shape, live marking, first-user-message names, 10s cache, negative cache,
//      a HUNG serve resolves within 2s with the last good list; readConversation/forkSession are LOUD
//   ④ the locator/keeper: record reuse (no spawn), spawn + boot wait + record + OpenAPI caps probe,
//      client() never waits past its budget, crash loop → parked, stop() kills + clears the record, no CLI
//   ⑤ the serve-backed reader + the harness descriptor store contract (installed singleton, journal for live)
//   ⑥ capsOf('opencode').fork flips ONLY through setVerifiedCap (the OpenAPI evidence)
//   ⑦ wiring pins (cli-env install + broadcast, server.js hook, createReader dispatch, transcript-service
//      prepare, ws-create fork-before-spawn, app.js caps merge + live update, arch/ci/docs registration)
// Run: node scripts/test-opencode-serve.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const MOCK = path.join(REPO, 'scripts/dev/mock-opencode-serve.mjs');
const { startMockServe, createMockState } = await import(MOCK);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e !== undefined ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serve = require(path.join(REPO, 'src/opencode-serve.js'));
const { AcpMessageManager } = require(path.join(REPO, 'src/acp-message-manager.js'));
const { capsOf, BACKEND_CAPS, setVerifiedCap } = require(path.join(REPO, 'src/backend-caps.js'));
const children = new Set();
process.on('exit', () => { for (const c of children) { try { process.kill(c, 'SIGKILL'); } catch { } } });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

console.log('— ① client over the mock serve');
{
  const mock = await startMockServe();
  const c = new serve.OpencodeServeClient(mock.url);
  ok('health() reads /global/health', (await c.health()).healthy === true);
  const all = await c.listAllSessions();
  ok('listAllSessions rung 1 = the DIRECTORY-LESS listing (verified 1.18.29: store-wide, boots no instance), rung 2 = scope=project for REAL worktrees only', all.length === 4 && mock.state.requests.includes('GET /session?limit=500') && mock.state.requests.some((r) => r.startsWith('GET /project')) && mock.state.requests.includes('GET /session?limit=500&directory=%2Fwork%2Falpha&scope=project'), mock.state.requests);
  ok('…and NEVER bootstraps "/" or the vcs-less catch-all project (2.369.42: directory=/ every 10s against a serve whose only project WAS "/")', !mock.state.requests.some((r) => r.includes('directory=%2F&scope=project')) && c.skippedWorktrees.includes('/'), { skipped: c.skippedWorktrees, reqs: mock.state.requests.filter((r) => r.includes('scope=project')) });
  ok('bootstrappableWorktree: a vcs-backed project dir yes; "/", $HOME, tmpdir, the vcs-less "global" row, a relative path, "" — no', serve.bootstrappableWorktree({ worktree: '/work/alpha', vcs: 'git' }) === true && serve.bootstrappableWorktree({ worktree: '/', vcs: 'git' }) === false && serve.bootstrappableWorktree({ worktree: os.homedir(), vcs: 'git' }) === false && serve.bootstrappableWorktree({ worktree: os.tmpdir(), vcs: 'git' }) === false && serve.bootstrappableWorktree({ worktree: '/work/alpha' }) === false && serve.bootstrappableWorktree({ worktree: 'work/alpha', vcs: 'git' }) === false && serve.bootstrappableWorktree({}) === false && serve.bootstrappableWorktree(null) === false);
  ok('unsafeWorktreeReason names "/" and $HOME (the 2.369.42 leftover shapes) and clears a real dir', /WHOLE filesystem/.test(serve.unsafeWorktreeReason('/') || '') && /home directory/.test(serve.unsafeWorktreeReason(os.homedir()) || '') && serve.unsafeWorktreeReason('/work/alpha') === null && serve.unsafeWorktreeReason('') === null && serve.unsafeWorktreeReason(null) === null);
  ok('a bare directory filter is an EXACT match (verified 1.18.29: `directory=/` lists nothing — the bug the live run caught)', (await c.listSessions({ directory: '/' })).length === 0 && (await c.listSessions({ directory: '/work/alpha' })).length === 2);
  ok('disposeInstance = POST /instance/dispose?directory=', (await c.disposeInstance('/work/alpha')) === true && mock.state.disposed.includes('/work/alpha'));
  ok('currentProject = GET /project/current (the serve\'s OWN project — what the boot self-heal probes)', (await c.currentProject()).worktree === '/work/alpha');
  ok('getSession', (await c.getSession('ses_a2')).title === 'Fix the flaky test');
  const msgs = await c.listMessages('ses_a1');
  ok('listMessages returns the v1 [{info, parts}] list', Array.isArray(msgs) && msgs.length === 5 && msgs[0].info.role === 'user' && Array.isArray(msgs[0].parts));
  const tail = await c.listMessages('ses_a1', { limit: 2 });
  ok('v1 limit = the NEWEST N (so naming must not use it)', tail.length === 2 && tail[1].info.id === 'msg_u3');
  const reqBefore = mock.state.requests.length;
  const first = await c.firstUserMessage('ses_a1');
  ok('firstUserMessage reads the v1 list (oldest-first) → the first NON-SYNTHETIC user text', first?.id === 'msg_u1' && first.text === 'please read README.md and fix the typo' && mock.state.requests.slice(reqBefore).includes('GET /session/ses_a1/message'), first);
  ok('THE 2.369.42 RULE: naming NEVER touches the v2 per-session family (every /api/session/{id}/… route boots an OpenCode instance that indexes the session\'s whole directory tree — measured)', !mock.state.requests.some((r) => /^GET \/api\/session\/[^/?]+\//.test(r)) && mock.state.instances.size === 0, { reqs: mock.state.requests.filter((r) => r.includes('/api/session')), instances: [...mock.state.instances] });
  ok('…null when the session has no user message yet', (await c.firstUserMessage('ses_g1')) === null);
  let eBig = null; try { await c.firstUserMessage('ses_a1', { maxBytes: 64 }); } catch (e) { eBig = e; }
  ok('the naming read is BYTE-CAPPED (six unbounded whole-conversation fetches into this process = an OOM): over the cap → code too-large, never a giant string', eBig?.code === 'too-large' && /exceeded 64 bytes/.test(eBig.message), eBig?.message);
  let e404 = null; try { await c.getSession('ses_nope'); } catch (e) { e404 = e; }
  ok('404 → OpencodeServeError {status:404} carrying the server message', e404 instanceof serve.OpencodeServeError && e404.status === 404 && /Session not found/.test(e404.message), e404?.message);
  const forked = await c.fork('ses_a2', { directory: '/work/alpha/sub' });
  ok('fork → POST /session/:id/fork?directory= → the new Session', forked.id === 'ses_a2_fork1' && /fork #1/.test(forked.title) && mock.state.requests.includes('POST /session/ses_a2/fork?directory=%2Fwork%2Falpha%2Fsub'));
  mock.state.hang = true;
  const t0 = Date.now(); let et = null; try { await c.listSessions({ timeoutMs: 300 }); } catch (e) { et = e; }
  ok('a hung serve → code timeout at the budget', et?.code === 'timeout' && Date.now() - t0 < 1500, et?.message);
  mock.state.hang = false;
  const dead = new serve.OpencodeServeClient('http://127.0.0.1:1');
  let ec = null; try { await dead.health({ timeoutMs: 500 }); } catch (e) { ec = e; }
  ok('connection refused → OpencodeServeError (never a bare fetch error)', ec instanceof serve.OpencodeServeError && ec.code !== 'timeout', ec?.code);
  await mock.close();
}

console.log('— ② acp-events synthesis + the real normalizer');
{
  const st = createMockState();
  const session = st.sessions.find((s) => s.id === 'ses_a1');
  const recs = serve.messagesToAcpRecords(st.messages.ses_a1, session);
  ok('every record is {ts, type:acp, kind}', recs.every((r) => typeof r.ts === 'string' && r.type === 'acp' && typeof r.kind === 'string'));
  ok('session record: how serve, model provider/id, mode = agent, cwd = directory', recs[0].kind === 'session' && recs[0].how === 'serve' && recs[0].model === 'opencode/big-pickle' && recs[0].mode === 'build' && recs[0].cwd === '/work/alpha' && recs[0].sessionId === 'ses_a1', recs[0]);
  const users = recs.filter((r) => r.kind === 'user');
  ok('user messages → user records keyed by message id; non-synthetic text + a [file:] line; synthetic text dropped', users.length === 3 && users[0].msgId === 'msg_u1' && users[0].content[0].text === 'please read README.md and fix the typo\n[file: shot.png]' && users[2].content[0].text === 'try again', users.map((u) => u.content[0].text));
  const ups = recs.filter((r) => r.kind === 'update').map((r) => r.update);
  const thought = ups.find((u) => u.sessionUpdate === 'agent_thought_chunk');
  ok('reasoning part → agent_thought_chunk', thought && thought.content.text === 'I should look at the file first.' && thought.messageId === 'prt_r1');
  const texts = ups.filter((u) => u.sessionUpdate === 'agent_message_chunk');
  ok('text parts → agent_message_chunk per part (messageId = part id)', texts.length === 2 && texts[0].content.text === 'Found the typo, fixing it now.' && texts[0].messageId === 'prt_x1' && texts[1].content.text === 'Done.');
  const readCall = ups.find((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call_read_1');
  const readDone = ups.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_read_1');
  ok('completed tool part → tool_call (kind read, rawInput, locations) + tool_call_update completed with the output', readCall && readCall.kind === 'read' && readCall.status === 'in_progress' && readCall.rawInput.filePath === '/work/alpha/README.md' && readCall.rawInput.tool === 'read' && readCall.locations[0].path === '/work/alpha/README.md' && readCall.title === 'README.md' && readDone && readDone.status === 'completed' && readDone.content[0].content.text === '# Alpha\nTeh project', { readCall, readDone });
  const editDone = ups.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_edit_1');
  ok('errored edit part → tool_call_update failed with the error text + an Edit diff (oldString/newString)', editDone && editDone.status === 'failed' && editDone.content[0].content.text === 'permission denied' && editDone.content[1].type === 'diff' && editDone.content[1].oldText === 'Teh' && editDone.content[1].newText === 'The' && editDone.rawOutput === 'permission denied', editDone);
  const task = ups.find((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'prt_t3');
  ok('subtask part → a completed tool_call kind other titled Task: <description>', task && task.kind === 'other' && task.status === 'completed' && task.title === 'Task: typo sweep' && task.rawInput.agent === 'explore' && task.rawInput.model === 'opencode/big-pickle');
  const bash = ups.find((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call_bash_1');
  ok('a RUNNING tool part → tool_call in_progress and NO tool_call_update', bash && bash.kind === 'execute' && bash.status === 'in_progress' && bash.rawInput.command === 'npm test' && !ups.some((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_bash_1'));
  ok('compaction part → notice', recs.some((r) => r.kind === 'notice' && r.noticeKind === 'compaction' && r.text === 'Context compacted (automatic)'));
  const ends = recs.filter((r) => r.kind === 'prompt_end');
  ok('assistant end → prompt_end: completed = end_turn, MessageAbortedError = cancelled; a trailing user message gets none', ends.length === 2 && ends[0].promptId === 'msg_a1' && ends[0].stopReason === 'end_turn' && ends[1].promptId === 'msg_a2' && ends[1].stopReason === 'cancelled', ends);
  const cfg = recs.find((r) => r.kind === 'config');
  const cfgIdx = recs.indexOf(cfg), a2Idx = recs.findIndex((r) => r.kind === 'update' && r.update.toolCallId === 'call_bash_1');
  ok('a model/agent switch between assistant messages → config record BEFORE that message', cfg && cfg.model === 'deepseek/deepseek-v4' && cfg.mode === 'plan' && cfgIdx < a2Idx && recs.filter((r) => r.kind === 'config').length === 1);
  ok('step-start/step-finish are not rendered', !ups.some((u) => /step/.test(u.sessionUpdate)) && !recs.some((r) => /step/.test(r.kind)));
  ok('tool id → ACP kind map', serve.acpKindOfTool('read') === 'read' && serve.acpKindOfTool('grep') === 'search' && serve.acpKindOfTool('write') === 'edit' && serve.acpKindOfTool('bash') === 'execute' && serve.acpKindOfTool('webfetch') === 'fetch' && serve.acpKindOfTool('todowrite') === 'think' && serve.acpKindOfTool('mcp_github_search') === 'other' && serve.acpStatusOfState('running') === 'in_progress' && serve.acpStatusOfState('error') === 'failed');
  ok('sessionTitle: the "New session - <date>" placeholder names nothing, a real title does', serve.sessionTitle(session) === '' && serve.sessionTitle(st.sessions[1]) === 'Fix the flaky test');
  ok('an empty conversation → just the session record; garbage input never throws', serve.messagesToAcpRecords([], session).length === 1 && serve.messagesToAcpRecords(null, null).length === 1 && serve.messagesToAcpRecords([{ info: null, parts: null }, { info: { role: 'assistant' }, parts: [{ type: 'tool' }, null, 7] }], {}).length >= 1);
  // the REAL normalizer renders the synthesized stream
  const mm = new AcpMessageManager('ses_a1');
  const msgs = mm.convertHistory(recs);
  const u = msgs.filter((m) => m.role === 'user');
  ok('normalizer: 3 user bubbles in order', u.length === 3 && u[0].content[0].text.startsWith('please read README.md') && u[2].content[0].text === 'try again');
  ok('normalizer: assistant text cards + a thinking block', msgs.some((m) => m.role === 'assistant' && m.content[0].type === 'text' && m.content[0].text === 'Found the typo, fixing it now.') && msgs.some((m) => m.role === 'assistant' && m.content[0].type === 'thinking' && /look at the file/.test(m.content[0].text)));
  const rc = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_read_1');
  ok('normalizer: Read card complete with output, fold read', rc && rc.toolName === 'Read' && rc.status === 'complete' && rc.collapseKind === 'read' && /Teh project/.test(rc.content[0].output) && rc.content[0].input.file_path === '/work/alpha/README.md', rc);
  const ec = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_edit_1');
  ok('normalizer: Edit card = error status with old/new strings', ec && ec.toolName === 'Edit' && ec.status === 'error' && ec.content[0].input.old_string === 'Teh' && ec.content[0].input.new_string === 'The', ec);
  ok('normalizer: Task card completed, Bash card pending, Interrupted marker, compaction notice', msgs.some((m) => m.role === 'tool' && m.toolCallId === 'prt_t3' && m.status === 'complete') && msgs.some((m) => m.role === 'tool' && m.toolCallId === 'call_bash_1' && m.status === 'pending') && msgs.some((m) => m.role === 'system' && m.status === 'interrupted') && msgs.some((m) => m.role === 'system' && /Context compacted/.test(m.content[0].text)));
  const stt = mm.status();
  ok('normalizer status: the LAST model/mode (config record) — deepseek/deepseek-v4, plan', stt.model === 'deepseek/deepseek-v4' && stt.permissionMode === 'plan', stt);
  ok('turnMap: one entry per user turn', mm.turnMap().filter((t) => t.role === 'user').length === 3);
  ok('ids are content-derived (a second rebuild reproduces them)', new AcpMessageManager('ses_a1').convertHistory(recs).map((m) => m.id).join() === msgs.map((m) => m.id).join());
}

console.log('— ③ facts.discover / readConversation / forkSession');
{
  const mock = await startMockServe();
  let now = 1_000_000; const clock = () => now;
  let invalidated = 0;
  const fakeLocator = (client, extra = {}) => ({ client: async () => client, ensure: async () => client, state: () => ({ installed: true, ready: !!client, parked: false, lastError: null, caps: { fork: true }, version: '1.18.29', crashes: 0, ...extra }), invalidate: () => { invalidated++; }, stop() { }, command: () => '/usr/bin/opencode' });
  const client = new serve.OpencodeServeClient(mock.url);
  const facts = serve.createFacts(fakeLocator(client), { now: clock });
  const active = new Map([['w1', { backend: 'opencode', backendSessionId: 'ses_a2', name: 'my live one', mode: 'chat' }], ['w2', { backend: 'claude', claudeSessionId: 'x' }]]);
  const e1 = await facts.discover({ activeSessions: active });
  ok('entries: backend/backendSessionId/sessionId/sessionKey/cwd/startedAt/status/name', e1.length === 4 && e1.every((e) => e.backend === 'opencode' && e.sessionId === e.backendSessionId && e.sessionKey === 'opencode:' + e.backendSessionId && typeof e.cwd === 'string' && typeof e.startedAt === 'number' && ['live', 'stopped'].includes(e.status) && typeof e.name === 'string'), e1[0]);
  const live = e1.find((e) => e.backendSessionId === 'ses_a2');
  ok('a session held by a LIVE opencode webui session is live with its webui id/name/mode', live && live.status === 'live' && live.webuiId === 'w1' && live.webuiName === 'my live one' && live.webuiMode === 'chat' && e1.filter((e) => e.status === 'live').length === 1, live);
  ok('a child session (parentID) is a subagent with parentThreadId; roots are primary', e1.find((e) => e.backendSessionId === 'ses_child').agentKind === 'subagent' && e1.find((e) => e.backendSessionId === 'ses_child').parentThreadId === 'ses_a2' && e1.find((e) => e.backendSessionId === 'ses_a1').agentKind === 'primary');
  ok('sorted by updated time desc; cwd = directory', e1.map((e) => e.backendSessionId).join() === 'ses_g1,ses_a2,ses_child,ses_a1' && e1[0].cwd === '/tmp/x');
  ok('before the first-message lookup lands: the OpenCode title names a session, the placeholder names nothing', e1.find((e) => e.backendSessionId === 'ses_a1').name === '' && e1.find((e) => e.backendSessionId === 'ses_a2').name === 'Fix the flaky test');
  await sleep(200);
  const reqCount = mock.state.requests.length;
  const e2 = await facts.discover({ activeSessions: new Map() });
  ok('a second discover inside 10s is served from the cache (zero requests)', mock.state.requests.length === reqCount && e2.length === 4);
  ok('names = nameFromText(first user message) via the v1 list; a session without one keeps the title fallback', e2.find((e) => e.backendSessionId === 'ses_a1').name === 'please read README.md and fix the typo' && e2.find((e) => e.backendSessionId === 'ses_a2').name === 'Fix the flaky test in ci' && e2.find((e) => e.backendSessionId === 'ses_g1').name === '' && mock.state.requests.includes('GET /session/ses_a1/message'), e2.map((e) => e.name));
  ok('a WHOLE discovery tick (list + names) bootstraps ZERO OpenCode instances — the 2.369.42 regression gate', mock.state.instances.size === 0 && !mock.state.requests.some((r) => /^GET \/api\/session\/[^/?]+\//.test(r)) && !mock.state.requests.some((r) => r.includes('directory=%2F&scope=project')), { instances: [...mock.state.instances], v2: mock.state.requests.filter((r) => r.includes('/api/session/')) });
  now += 11000; mock.state.fail = true;
  const e3 = await facts.discover({ activeSessions: new Map() });
  ok('a failing refresh keeps the LAST GOOD list (silent in the poll)', e3.length === 4 && /HTTP 500/.test(facts.state().lastError || ''), facts.state().lastError);
  const rc = mock.state.requests.length; now += 5000;
  await facts.discover({});
  ok('negative cache: no request for 10s after a failure', mock.state.requests.length === rc);
  now += 6000; mock.state.fail = false; mock.state.hang = true;
  const t0 = Date.now(); const e4 = await facts.discover({}); const dt = Date.now() - t0;
  ok(`a HUNG serve: discover resolves within 2s (${dt}ms) with the last good list — the poll never stalls`, dt < 2000 && e4.length === 4);
  mock.state.hang = false;
  now += 11000;
  const conv = await facts.readConversation('ses_a1');
  ok('readConversation → {session, messages, records}', conv.session.id === 'ses_a1' && conv.messages.length === 5 && conv.records.length > 10 && conv.records[0].kind === 'session');
  let e404 = null; try { await facts.readConversation('ses_nope'); } catch (e) { e404 = e; }
  ok('a missing conversation is LOUD (user action) with the status', e404 instanceof serve.OpencodeServeError && e404.status === 404 && /could not be read/.test(e404.message), e404?.message);
  const f = await facts.forkSession('ses_a1', { cwd: '/work/alpha' });
  ok('forkSession → POST fork with the directory → the new session; the list cache is invalidated', f.id === 'ses_a1_fork1' && mock.state.requests.includes('POST /session/ses_a1/fork?directory=%2Fwork%2Falpha') && (await facts.discover({})).some((e) => e.backendSessionId === 'ses_a1_fork1'));
  ok('…and DISPOSES the instance for that directory afterwards (fork is the one call that hands a directory to a mutating endpoint)', mock.state.disposed.includes('/work/alpha') && mock.state.requests.includes('POST /instance/dispose?directory=%2Fwork%2Falpha'), mock.state.disposed);
  const facts2 = serve.createFacts(fakeLocator(client, { caps: { fork: false }, version: '1.10.0' }), { now: clock });
  let ef = null; try { await facts2.forkSession('ses_a1'); } catch (e) { ef = e; }
  ok('forkSession is REFUSED (code unsupported) when the serve OpenAPI has no fork endpoint', ef?.code === 'unsupported' && /no session fork endpoint/.test(ef.message) && /1\.10\.0/.test(ef.message), ef?.message);
  const facts3 = serve.createFacts({ client: async () => null, ensure: async () => null, state: () => ({ installed: false, parked: false }), invalidate() { }, stop() { }, command: () => null }, { now: clock });
  ok('no CLI → discover [] silently', (await facts3.discover({})).length === 0);
  let eu = null; try { await facts3.readConversation('ses_a1'); } catch (e) { eu = e; }
  ok('…but a user action says WHY (not installed, how to fix)', /not installed/.test(eu?.message) && /OPENCODE_CMD/.test(eu?.message), eu?.message);
  const facts4 = serve.createFacts({ client: async () => null, ensure: async () => null, state: () => ({ installed: true, parked: true, crashes: 5, lastError: 'opencode serve exited (code 3)' }), invalidate() { }, stop() { }, command: () => '/x' }, { now: clock });
  let ep = null; try { await facts4.forkSession('ses_a1'); } catch (e) { ep = e; }
  ok('a PARKED keeper: discover [] silently, fork says parked after N crashes', (await facts4.discover({})).length === 0 && /parked after 5 crashes/.test(ep?.message), ep?.message);
  await mock.close();
}

console.log('— ④ locator / keeper');
{
  const spawnOpts = [];
  const spawnMock = (cmd, args, opts) => { spawnOpts.push({ cmd, args, ...opts }); const ch = spawn(process.execPath, [MOCK, ...args], { ...opts, stdio: 'ignore', detached: false, env: { ...process.env, ...(opts.env || {}) } }); children.add(ch.pid); return ch; };
  // reuse a recorded, healthy instance — no spawn
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const mock = await startMockServe();
  fs.writeFileSync(path.join(dir, 'opencode-serve.json'), JSON.stringify({ port: mock.port, pid: process.pid, startedAt: Date.now() }));
  let spawns = 0, capsSeen = null;
  const loc = serve.createServeLocator({ dataDir: dir, command: '/usr/bin/opencode', log: null, spawnImpl: () => { spawns++; throw new Error('must not spawn'); }, onCaps: (c) => { capsSeen = c; } });
  const c1 = await loc.client({ budgetMs: 3000 });
  ok('a recorded instance that answers /global/health is REUSED (no spawn)', !!c1 && loc.state().source === 'reused' && spawns === 0 && loc.state().port === mock.port && loc.state().ready === true, loc.state());
  ok('…and its OpenAPI is probed once: fork verdict true (1.18.29 carries POST /session/{sessionID}/fork); version from /global/health', capsSeen?.fork === true && loc.state().caps.fork === true && loc.state().version === '1.18.29' && loc.state().capsProbed === true);
  ok('stop() on a reused instance never kills a process it did not spawn', (loc.stop(), pidAlive(process.pid)));
  await mock.close();
  // dead record → spawn a fresh one (mock child), wait for health, write the record, probe caps (no fork this time)
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  fs.writeFileSync(path.join(dir2, 'opencode-serve.json'), JSON.stringify({ port: 1, pid: 999999999, startedAt: 1 }));
  let caps2 = null;
  const loc2 = serve.createServeLocator({ dataDir: dir2, command: () => 'opencode', log: null, spawnImpl: spawnMock, env: () => ({ MOCK_OPENCODE_NO_FORK: '1', MOCK_OPENCODE_BOOT_DELAY_MS: '400' }), bootTimeoutMs: 15000, onCaps: (c) => { caps2 = c; } });
  const t0 = Date.now();
  const c2 = await loc2.client({ budgetMs: 100 });
  ok('client({budgetMs}) NEVER waits past its budget while the serve boots (returns null, boot continues)', c2 === null && Date.now() - t0 < 1000);
  const c3 = await loc2.ensure();
  ok('a dead record → spawn `<cmd> serve --port <free> --hostname 127.0.0.1` → adopted once healthy', !!c3 && loc2.state().source === 'spawned' && loc2.state().pid > 0 && (await c3.health()).healthy === true, loc2.state());
  // THE 2.369.42 SPAWN-CWD RULE — OpenCode resolves its default project from
  // the cwd (git walk UP, else the '/' catch-all) and indexes that tree
  const wantCwd = path.join(dir2, 'opencode-serve', 'cwd');
  ok('the serve is spawned from ITS OWN data/opencode-serve/cwd — never the server process cwd/$HOME (2.369.42 ran with cwd=$HOME ⇒ project "/")', spawnOpts.length === 1 && spawnOpts[0].cwd === wantCwd && loc2.state().cwd === wantCwd && spawnOpts[0].cwd !== os.homedir(), spawnOpts[0]);
  ok('…and that directory is EMPTY and its own throwaway git repo (a plain dir inside a checkout resolves the WHOLE checkout — measured; a fake .git does not stop the walk)', fs.existsSync(path.join(wantCwd, '.git')) && fs.readdirSync(wantCwd).filter((f) => f !== '.git').length === 0 && loc2.state().cwdIsolated === true && fs.existsSync(path.join(dir2, 'opencode-serve', 'README.txt')));
  const rec = JSON.parse(fs.readFileSync(path.join(dir2, 'opencode-serve.json'), 'utf8'));
  ok('data/opencode-serve.json = {port, pid, startedAt, command, cwd}', rec.port === loc2.state().port && rec.pid === loc2.state().pid && rec.startedAt > 0 && rec.command === 'opencode' && rec.cwd === wantCwd, rec);
  ok('an OpenAPI WITHOUT the fork path → fork verdict false', caps2?.fork === false && loc2.state().caps.fork === false);
  ok('the record\'s stale tmp file is not left behind (atomic write)', !fs.readdirSync(dir2).some((f) => f.endsWith('.tmp')));
  const pid2 = loc2.state().pid;
  loc2.stop();
  let gone = false; for (let i = 0; i < 40 && !gone; i++) { await sleep(50); gone = !pidAlive(pid2); }
  ok('stop() kills the spawned serve and clears the record', gone && !fs.existsSync(path.join(dir2, 'opencode-serve.json')) && loc2.state().ready === false);
  ok('after stop(), client() stays null (no respawn)', (await loc2.client({ budgetMs: 200 })) === null);
  // crash loop → backoff → parked
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const warned = [];
  const loc3 = serve.createServeLocator({ dataDir: dir3, command: 'opencode', log: { warn: (m) => warned.push(m), error: (m) => warned.push(m), log() { } }, spawnImpl: spawnMock, env: () => ({ MOCK_OPENCODE_CRASH: '1' }), bootTimeoutMs: 3000, backoffBaseMs: 5, maxCrashes: 3 });
  const c4 = await loc3.ensure();
  let parked = false; for (let i = 0; i < 100 && !parked; i++) { await sleep(50); parked = loc3.state().parked; }
  ok('a serve that exits at once: respawn with backoff, PARKED after maxCrashes', c4 === null && parked && loc3.state().crashes >= 3 && /exited/.test(loc3.state().lastError) && warned.some((m) => /respawn in \d+ms/.test(m)) && warned.some((m) => /PARKED after/.test(m)), { state: loc3.state(), warned });
  ok('parked → client() null; a user action through the facts says parked', (await loc3.client({ budgetMs: 200 })) === null && await serve.createFacts(loc3).forkSession('x').then(() => false, (e) => /parked after 3 crashes/.test(e.message)));
  ok('the crash loop leaves no record behind', !fs.existsSync(path.join(dir3, 'opencode-serve.json')));
  // no CLI → nothing to start
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const loc4 = serve.createServeLocator({ dataDir: dir4, command: null, log: null, spawnImpl: () => { throw new Error('must not spawn'); } });
  ok('no opencode CLI → client() null with the reason, never a spawn', (await loc4.client()) === null && /not installed/.test(loc4.state().lastError) && loc4.state().installed === false);
  // autostart off (smoke harnesses): reuse a recorded instance, never spawn
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  let spawns5 = 0;
  const loc5 = serve.createServeLocator({ dataDir: dir5, command: '/usr/bin/opencode', log: null, autostart: false, spawnImpl: () => { spawns5++; throw new Error('must not spawn'); } });
  ok('autostart:false → no spawn, the reason names the switch', (await loc5.client()) === null && spawns5 === 0 && /autostart is off/.test(loc5.state().lastError) && /VIBESPACE_OPENCODE_SERVE=0/.test(loc5.state().lastError) && loc5.state().autostart === false);
  const mock5 = await startMockServe();
  fs.writeFileSync(path.join(dir5, 'opencode-serve.json'), JSON.stringify({ port: mock5.port, pid: process.pid, startedAt: Date.now() }));
  ok('…but a recorded live instance is still reused', !!(await loc5.client({ budgetMs: 3000 })) && loc5.state().source === 'reused' && spawns5 === 0);
  await mock5.close();
  // autostart may be a FUNCTION (the live setting): flipping it takes effect without a restart
  const dir5b = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  let allow = false;
  const loc5b = serve.createServeLocator({ dataDir: dir5b, command: 'opencode', log: null, autostart: () => allow, spawnImpl: spawnMock, env: () => ({}), bootTimeoutMs: 15000 });
  ok('autostart accepts a FUNCTION (agents.opencodeServeAutostart, read live): false → no spawn and the reason names the setting', (await loc5b.client()) === null && loc5b.state().autostart === false && /agents\.opencodeServeAutostart/.test(loc5b.state().lastError));
  allow = true;
  ok('…flipping the setting on lets the very next ensure() start it (no restart)', !!(await loc5b.ensure()) && loc5b.state().source === 'spawned' && loc5b.state().autostart === true, loc5b.state());
  loc5b.stop();

  // ── boot SELF-HEAL of a 2.369.42 leftover: a recorded serve whose own
  //    project worktree is '/' (or $HOME) is stopped and replaced, no manual step
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const leftover = spawn(process.execPath, [MOCK, 'serve', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, MOCK_OPENCODE_WORKTREE: '/' } });
  children.add(leftover.pid);
  const leftoverUrl = await new Promise((r) => { let b = ''; leftover.stdout.on('data', (d) => { b += d; const m = /listening on (\S+)/.exec(b); if (m) r(m[1]); }); });
  const leftoverPort = Number(new URL(leftoverUrl).port);
  fs.writeFileSync(path.join(dir6, 'opencode-serve.json'), JSON.stringify({ port: leftoverPort, pid: leftover.pid, startedAt: Date.now(), command: 'opencode' })); // pre-2.369.50 record: no cwd
  const warned6 = [];
  const loc6 = serve.createServeLocator({ dataDir: dir6, command: 'opencode', log: { warn: (m) => warned6.push(m), error: (m) => warned6.push(m), log() { } }, spawnImpl: spawnMock, env: () => ({}), bootTimeoutMs: 15000 });
  const c6 = await loc6.ensure();
  ok('BOOT SELF-HEAL: a recorded serve whose GET /project/current worktree is "/" is NOT adopted — it is SIGTERMed and a fresh one spawns from the isolated cwd', !!c6 && loc6.state().source === 'spawned' && loc6.state().port !== leftoverPort && loc6.state().cwd === path.join(dir6, 'opencode-serve', 'cwd') && warned6.some((m) => /replacing the recorded serve/.test(m) && /WHOLE filesystem/.test(m)), { st: loc6.state(), warned6 });
  let dead6 = false; for (let i = 0; i < 40 && !dead6; i++) { await sleep(50); dead6 = !pidAlive(leftover.pid); }
  ok('…and the leftover process is actually gone', dead6);
  loc6.stop();
  // a HEALTHY record whose worktree is safe is still reused (no churn), and a probe failure never churns
  const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const mock7 = await startMockServe({ state: createMockState({ currentWorktree: '/work/alpha' }) });
  fs.writeFileSync(path.join(dir7, 'opencode-serve.json'), JSON.stringify({ port: mock7.port, pid: process.pid, startedAt: Date.now() }));
  let spawns7 = 0;
  const loc7 = serve.createServeLocator({ dataDir: dir7, command: 'opencode', log: null, spawnImpl: () => { spawns7++; throw new Error('must not spawn'); } });
  ok('a recorded serve with a SAFE project worktree is reused unchanged (the self-heal never churns a healthy instance)', !!(await loc7.client({ budgetMs: 3000 })) && loc7.state().source === 'reused' && spawns7 === 0);
  loc7.stop(); await mock7.close();

  // ── the RUNAWAY guard: sustained CPU / RSS blowout stops + parks + notifies
  const dir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const mock8 = await startMockServe();
  fs.writeFileSync(path.join(dir8, 'opencode-serve.json'), JSON.stringify({ port: mock8.port, pid: 999000001, startedAt: Date.now(), cwd: path.join(dir8, 'opencode-serve', 'cwd') }));
  let t8 = 1_000_000, proc8 = { cpuTicks: 0, rssBytes: 300 * 2 ** 20 }, killed8 = 0;
  const tele8 = [], errs8 = [], states8 = [];
  const loc8 = serve.createServeLocator({
    dataDir: dir8, command: 'opencode', log: { warn() { }, log() { }, error: (m) => errs8.push(m) },
    spawnImpl: () => { throw new Error('must not spawn'); }, now: () => t8, guardSampleMs: 0,
    readProc: () => proc8, telemetry: (ev) => tele8.push(ev), onState: (s) => states8.push(s),
    killPid: () => { killed8++; },
  });
  await loc8.client({ budgetMs: 3000 });
  const tick = (dtMs, cpuPct, rssMb) => { t8 += dtMs; proc8 = { cpuTicks: proc8.cpuTicks + (cpuPct * dtMs / 1000), rssBytes: (rssMb ?? 300) * 2 ** 20 }; loc8._sampleGuard(); };
  tick(60000, 0); tick(60000, 20);
  ok('the guard samples /proc without parking a calm serve (20% CPU, 300 MB)', !loc8.state().parked && Math.abs(loc8.state().cpuPct - 20) < 1 && loc8.state().rssBytes === 300 * 2 ** 20, loc8.state());
  for (let i = 0; i < 5; i++) tick(60000, 165);          // the sustain clock starts at the FIRST hot sample: 4 minutes elapsed
  ok('165% CPU for 4 minutes is NOT yet a runaway (the bound is SUSTAINED, not a spike)', !loc8.state().parked, loc8.state());
  tick(60000, 165);                                       // …the 5-minute mark
  const st8 = loc8.state();
  ok('>150% CPU sustained ≥5 min → the serve is STOPPED and the locator is parked:runaway with the numbers in the reason', st8.parked === true && st8.parkedKind === 'runaway' && /165% CPU sustained for 5 min/.test(st8.lastError) && st8.ready === false && killed8 === 1 && !fs.existsSync(path.join(dir8, 'opencode-serve.json')), st8);
  ok('…telemetry fires ONCE as opencode-serve-runaway with the detail, and the console says WHY + what to turn off', tele8.length === 1 && tele8[0].name === 'opencode-serve-runaway' && /165% CPU/.test(tele8[0].detail) && errs8.some((m) => /RUNAWAY/.test(m) && /agents\.opencodeServeAutostart/.test(m)), { tele8, errs8 });
  ok('…the parked state is PUSHED (onState) so the harness reason reaches open clients', states8.some((s) => s.parked && s.parkedKind === 'runaway'));
  ok('a parked runaway refuses to restart inside the cooldown; the store reason names the runaway (no silent failure)', (await loc8.client({ budgetMs: 200 })) === null && /RUNAWAY/.test(serve.createFacts(loc8).reasonUnavailable()) && /not restart for up to an hour/i.test(serve.createFacts(loc8).reasonUnavailable()), serve.createFacts(loc8).reasonUnavailable());
  tick(30 * 60000, 0);
  ok('…still refuses 30 min later (at most ONE respawn per hour)', (await loc8.client({ budgetMs: 200 })) === null && loc8.state().parked === true);
  t8 += 31 * 60000;
  ok('…and after the hour it tries exactly once more (the record is gone, so it takes the spawn rung)', (await loc8.client({ budgetMs: 500 })) === null && loc8.state().parked === false && /must not spawn/.test(loc8.state().lastError || ''), loc8.state());
  loc8.stop(); await mock8.close();
  // the RSS bound trips at once (no sustain window)
  const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-loc-'));
  const mock9 = await startMockServe();
  fs.writeFileSync(path.join(dir9, 'opencode-serve.json'), JSON.stringify({ port: mock9.port, pid: 999000002, startedAt: Date.now(), cwd: path.join(dir9, 'opencode-serve', 'cwd') }));
  let t9 = 5_000_000; const tele9 = [];
  const loc9 = serve.createServeLocator({ dataDir: dir9, command: 'opencode', log: null, spawnImpl: () => { throw new Error('nope'); }, now: () => t9, guardSampleMs: 0, readProc: () => ({ cpuTicks: 0, rssBytes: 5.0 * 2 ** 30 }), telemetry: (ev) => tele9.push(ev) });
  await loc9.client({ budgetMs: 3000 });
  t9 += 60000; loc9._sampleGuard();
  ok('RSS past the bound is a runaway on the FIRST sample (the owner\'s instance sat at 5.0 GB) — no sustain window', loc9.state().parked && loc9.state().parkedKind === 'runaway' && /RSS 5\.0 GB \(limit 2\.0 GB\)/.test(loc9.state().lastError) && tele9.length === 1, loc9.state());
  ok('an unreadable /proc (a reused instance on another machine, a vanished pid) never parks anything', (() => { const l = serve.createServeLocator({ dataDir: dir9, command: 'opencode', log: null, guardSampleMs: 0, readProc: () => null }); l._sampleGuard(); const s = l.state(); l.stop(); return !s.parked && s.cpuPct === null; })());
  loc9.stop(); await mock9.close();
  for (const d of [dir, dir2, dir3, dir4, dir5, dir5b, dir6, dir7, dir8, dir9]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('— ⑤ serve-backed reader + the harness store contract');
{
  const mock = await startMockServe();
  const locator = { client: async () => new serve.OpencodeServeClient(mock.url), ensure: async () => new serve.OpencodeServeClient(mock.url), state: () => ({ installed: true, ready: true, parked: false, caps: { fork: true }, version: '1.18.29' }), invalidate() { }, stop() { }, command: () => '/x' };
  const facts = serve.install({ locator });
  const h = require(path.join(REPO, 'src/harnesses/opencode.js'));
  ok('descriptor store: discover/createReader/forkSession/forkChain/locate(null)/conversationIdField/SessionMessages', typeof h.store.discover === 'function' && typeof h.store.createReader === 'function' && typeof h.store.forkSession === 'function' && typeof h.store.forkChain === 'function' && h.store.locate('ses_a1', '/x') === null && h.store.locateTranscript('ses_a1') === null && h.store.conversationIdField === 'backendSessionId' && h.store.Reader === serve.OpencodeServeSessionMessages);
  const entries = await h.store.discover({ activeSessions: new Map() });
  ok('descriptor discover reads the INSTALLED facts (4 entries)', entries.length === 4 && entries.every((e) => e.backend === 'opencode'));
  const rd = h.store.createReader({ backend: 'opencode', backendSessionId: 'ses_a1', cwd: '/work/alpha', buffer: '' }, undefined, { buffersDir: os.tmpdir(), live: false });
  ok('the STOPPED (synthetic) shape: a serve-backed reader, empty until prepare()', rd instanceof serve.OpencodeServeSessionMessages && rd.source === 'serve' && rd.total === 0 && rd.chatStatus() === null);
  await rd.prepare();
  ok('prepare(): raw/tail/slice/chatStatus/taskState rebuilt from the serve', rd.total > 10 && rd.raw()[0].kind === 'session' && rd.tail(1)[0].kind === 'user' && rd.slice(0, 1)[0].how === 'serve' && rd.chatStatus()?.model === 'deepseek/deepseek-v4' && rd.chatStatus().permissionMode === 'plan' && rd.taskState().todos.length === 0 && rd.isStreaming === false, rd.chatStatus());
  const journal = JSON.stringify({ ts: 'x', type: 'acp', kind: 'user', msgId: 'live1', content: [{ type: 'text', text: 'from the journal' }] }) + '\n';
  const liveRd = h.store.createReader({ backend: 'opencode', backendSessionId: 'ses_a1', buffer: journal }, 'w1', { buffersDir: os.tmpdir(), live: true });
  await liveRd.prepare();
  ok('a LIVE session reads its wrapper journal, never the serve (prepare is a no-op)', liveRd.source === 'journal' && liveRd.total === 1 && liveRd.raw()[0].msgId === 'live1');
  const liveEmpty = h.store.createReader({ backend: 'opencode', backendSessionId: 'ses_a1', buffer: '' }, 'w1', { buffersDir: os.tmpdir(), live: true });
  await liveEmpty.prepare();
  ok('a live session with an EMPTY journal (just spawned, replay pending) stays on the journal — the wrapper\'s session/load replay must not be doubled by a serve read', liveEmpty.source === 'journal' && liveEmpty.total === 0);
  ok('forkSession through the descriptor', (await h.store.forkSession('ses_a2', { cwd: '/work/alpha/sub' })).id === 'ses_a2_fork1' && h.store.forkChain('ses_a2_fork1').length === 0);
  ok('unavailableReason/serveState are exposed for user-action errors', typeof h.store.unavailableReason() === 'string' && h.store.serveState().ready === true);
  await mock.close(); facts.invalidate();
  const rd2 = h.store.createReader({ backend: 'opencode', backendSessionId: 'ses_a1', buffer: '' }, undefined, { live: false });
  let er = null; try { await rd2.prepare(); } catch (e) { er = e; }
  ok('serve down while a user opens a stopped conversation → prepare() throws (LOUD, reaches the route error)', er instanceof serve.OpencodeServeError && /could not be read/.test(er.message), er?.message);
  serve.uninstall();
  let en = null; try { await h.store.forkSession('ses_a1'); } catch (e) { en = e; }
  ok('uninstalled (no cli-env wiring, e.g. a bare require): discover [] silently, fork says not configured', (await h.store.discover({})).length === 0 && /not configured/.test(en?.message));
}

console.log('— ⑥ caps verdict');
{
  const h = require(path.join(REPO, 'src/harnesses/opencode.js'));
  ok('shipped verdict: capsOf(opencode).fork is false until the serve OpenAPI proves it', capsOf('opencode').fork === false && /fork: false,\n    streamProtocol: 'acp-events'/.test(read('src/backend-caps.js')));
  ok('setVerifiedCap flips the SAME row object the descriptor holds', setVerifiedCap('opencode', 'fork', true) === true && capsOf('opencode').fork === true && h.caps === capsOf('opencode') && h.caps.fork === true && BACKEND_CAPS.opencode.fork === true);
  ok('setVerifiedCap refuses an unknown backend or key (returns false, no row grows)', setVerifiedCap('gemini', 'fork', true) === false && setVerifiedCap('claude', 'nope', 1) === false && !('nope' in BACKEND_CAPS.claude));
  setVerifiedCap('opencode', 'fork', false);
}

console.log('— ⑦ wiring pins');
{
  const ce = read('src/server/cli-env.js');
  ok('cli-env installs the locator ONCE: data dir, resolved opencode command, agentEnv, stopOnExit, caps verdict + harness-caps-updated broadcast', /require\('\.\.\/opencode-serve'\)\.install\(\{/.test(ce) && /command: \(\) => ACP_COMMANDS\.opencode \|\| null/.test(ce) && /env: \(\) => require\('\.\.\/ws-handler'\)\.agentEnv\(\)/.test(ce) && /stopOnExit: true/.test(ce) && /setVerifiedCap\('opencode', 'fork', !!caps\.fork\)/.test(ce) && /type: 'harness-caps-updated', backend: 'opencode', caps: \{ fork: !!caps\.fork \}/.test(ce) && /dataDir: path\.join\(rootDir, 'data'\)/.test(ce));
  ok('autostart precedence: VIBESPACE_OPENCODE_SERVE wins, the test-harness belt VIBESPACE_SKIP_AGENT_HOOKS=1 forces off, else the SETTING agents.opencodeServeAutostart (default ON) — read through a function so a live flip needs no restart', /process\.env\.VIBESPACE_OPENCODE_SERVE \? process\.env\.VIBESPACE_OPENCODE_SERVE !== '0'\s*\n?\s*: \(process\.env\.VIBESPACE_SKIP_AGENT_HOOKS === '1' \? false : null\)/.test(ce) && /getSetting\('agents\.opencodeServeAutostart'\) !== false/.test(ce) && /autostart: opencodeServeAutostart,/.test(ce) && !/autostart: OPENCODE_SERVE_AUTOSTART/.test(ce));
  ok('the setting EXISTS in the schema with default true (a setting with no code behind it is banned, and so is code with no setting)', /'agents\.opencodeServeAutostart': \{\s*\n\s*type: 'boolean', default: true,/.test(read('src/lib/settings-schema.js')));
  ok('cli-env feeds the guard: telemetry record + the parked/runaway state PUSHED as harness-store-updated, and harnessAvailability carries storeReason', /telemetry: \(ev\) => \{ try \{ getTelemetry\(\)\?\.record\(\{ kind: 'event', \.\.\.ev \}\); \} catch \{ \} \}/.test(ce) && /type: 'harness-store-updated', backend: 'opencode', parked: !!st\.parked/.test(ce) && /row\.storeReason = String\(h\.store\.unavailableReason\(\)\)/.test(ce));
  ok('server.js passes the lazy telemetry + settings getters (both singletons are defined BELOW the cli-env create — the lost-binding class)', /getTelemetry: \(\) => \{ try \{ return telemetry; \} catch \{ return null; \} \}, getSetting: \(k\) => serverSetting\(k\)/.test(read('server.js')));
  ok('app.js surfaces a parked/runaway harness store: BACKEND_META.storeReason from /api/home AND a toast on the live harness-store-updated push (no silent failure)', /msg\.type !== 'harness-store-updated'/.test(read('src/lib/app.js')) && /BACKEND_META\[msg\.backend\]\.storeReason = msg\.reason \|\| null;/.test(read('src/lib/app.js')) && /showToast\(`\$\{BACKEND_META\[msg\.backend\]\.label \|\| msg\.backend\}: \$\{msg\.reason\}`, \{ type: 'error' \}\)/.test(read('src/lib/app.js')) && /BACKEND_META\[h\.id\]\.storeReason = h\.storeReason \|\| null;/.test(read('src/lib/app.js')));
  ok('the runaway guard is REAL in the shipped module: /proc sampling, the CPU/RSS bounds, the once-an-hour respawn floor, and telemetry opencode-serve-runaway', /\/proc\/\$\{pid\}\/stat/.test(read('src/opencode-serve.js')) && /VmRSS:/.test(read('src/opencode-serve.js')) && /GUARD_CPU_PCT = 150/.test(read('src/opencode-serve.js')) && /GUARD_RSS_BYTES = 2 \* 1024 \* 1024 \* 1024/.test(read('src/opencode-serve.js')) && /RUNAWAY_COOLDOWN_MS = 60 \* 60 \* 1000/.test(read('src/opencode-serve.js')) && /name: 'opencode-serve-runaway'/.test(read('src/opencode-serve.js')));
  ok('the discovery path may NEVER call the instance-booting v2 per-session family (2.369.42) — the module contains no such request', !/\/api\/session\/\$\{encodeURIComponent\(id\)\}/.test(read('src/opencode-serve.js')) && /THE NAMING LOOKUP MUST STAY ON THE v1 ROUTE/.test(read('src/opencode-serve.js')));
  ok('the serve is spawned from the isolated data/opencode-serve/cwd, never os.homedir() as the default', /cwd: state\.cwd \|\| cwd \|\| os\.homedir\(\)/.test(read('src/opencode-serve.js')) && /function serveCwdPath\(dataDir\) \{ return path\.join\(dataDir, 'opencode-serve', 'cwd'\); \}/.test(read('src/opencode-serve.js')));
  ok('harnessAvailability carries the verified caps for ACP harnesses only', /\.\.\.\(h\.acp \? \{ caps: \{ fork: !!capsOf\(h\.id\)\.fork \} \} : \{\}\)/.test(ce));
  ok('server.js hands the broadcaster to cli-env (no new line — the size ratchet)', /refreshCodexModels: \(\.\.\.a\) => refreshCodexModels\(\.\.\.a\), broadcast: \(m\) => bcastAll\(m\)/.test(read('server.js')) && read('server.js').split('\n').length - 1 <= 2100);
  const mw = read('src/server/mounts-plugins-wiring.js');
  ok('createSessionMessages dispatches store.createReader WITH the live fact (activeSessions membership), SessionMessages stays the fallback', /typeof h\?\.store\?\.createReader === 'function'/.test(mw) && /for \(const s of activeSessions\.values\(\)\) if \(s === session\) \{ live = true; break; \}/.test(mw) && /h\.store\.createReader\(session, sessionId, \{ buffersDir: BUFFERS_DIR, live \}\)/.test(mw) && /h\?\.store\?\.SessionMessages\) return new h\.store\.SessionMessages/.test(mw));
  const ts = read('src/transcript-service.js');
  ok('transcript-service awaits sm.prepare() on all three reader sites (view/status/taskState)', (ts.match(/if \(typeof sm\.prepare === 'function'\) await sm\.prepare\(\);/g) || []).length === 3);
  const rt = read('src/routes/sessions.js');
  ok('/api/session-messages catches a reader refusal and ANSWERS (404 unknown conversation / 502 unreachable store) — an uncaught async throw was a hung request (the HTTP probe caught it)', /router\.get\('\/api\/session-messages', async \(req, res\) => \{[\s\S]{0,600}try \{[\s\S]{0,2000}res\.status\(e\?\.status === 404 \? 404 : 502\)\.json\(\{ error: e\?\.message \|\| String\(e\), code: e\?\.code \|\| 'transcript-error' \}\)/.test(rt));
  const wc = read('src/ws-create.js');
  const mint = wc.indexOf("typeof harnessOf(backend).store?.forkSession === 'function'"), build = wc.indexOf('const sessionSpec = adapter.buildSessionArgs({');
  ok('ws-create mints the store fork BEFORE buildSessionArgs, resumes the forked id, refuses loudly on failure', mint > 0 && build > mint && /require\('\.\/harnesses'\)/.test(wc) && /data\.fork && data\.resume && data\.resumeId && !data\.hostId/.test(wc) && /data\.resumeId = forked\.id;/.test(wc) && /code: 'fork-failed', message: `Fork failed: \$\{e\.message\}`/.test(wc) && /forkSession\(data\.resumeId, \{ cwd \}\)/.test(wc));
  const app = read('src/lib/app.js');
  ok('app.js merges verified caps from /api/home and the live harness-caps-updated broadcast (then re-renders the sidebar)', /if \(h\.caps && BACKEND_META\[h\.id\]\?\.caps\) Object\.assign\(BACKEND_META\[h\.id\]\.caps, h\.caps\);/.test(app) && /msg\.type !== 'harness-caps-updated'/.test(app) && /Object\.assign\(BACKEND_META\[msg\.backend\]\.caps, msg\.caps\);/.test(app) && /this\.sidebar\?\._render\?\.\(\);/.test(app));
  ok('the sidebar Fork row + fork command gate on META caps (no id list)', /when: \(c\) => !!backendFeatureCaps\(c\.s\.backend \|\| 'claude'\)\.fork/.test(read('src/lib/session-card.js')));
  ok('backend-caps exports setVerifiedCap (PURE setter, in-place row mutation)', /function setVerifiedCap\(backend, key, value\)/.test(read('src/backend-caps.js')) && /module\.exports = \{ BACKEND_CAPS, capsOf, setVerifiedCap \};/.test(read('src/backend-caps.js')));
  ok('test-architecture places src/opencode-serve.js in SHARED; ci.mjs runs this suite', /'src\/opencode-serve\.js'\]\);/.test(read('scripts/test-architecture.mjs')) && /'test-opencode-serve'/.test(read('scripts/ci.mjs')));
  const oc = read('src/opencode-serve.js');
  ok('opencode-serve talks to 127.0.0.1 only, never a vendor host, never a secret in argv', /http:\/\/127\.0\.0\.1:\$\{port\}/.test(oc) && /'--hostname', '127\.0\.0\.1'/.test(oc) && !/api\.anthropic\.com|api\.openai\.com|Bearer sk-/.test(oc) && !/OPENCODE_SERVER_PASSWORD.*args/.test(oc));
  ok('the record is written atomically (tmp + rename) and the serve is spawned detached with ignored stdio under the caller env', /fs\.renameSync\(tmp, file\)/.test(oc) && /stdio: 'ignore', detached: true/.test(oc) && /env: env\(\)/.test(oc));
  ok('docs: kb-file-structure essay + design S9 row + CLAUDE.md index line', /src\/opencode-serve\.js — /.test(read('docs/kb-file-structure.md')) && /\| S9 ✅/.test(read('docs/design-harness-plugins.md')) && /opencode-serve\.js — /.test(read('CLAUDE.md')));
  ok('the manual live script exists', fs.existsSync(path.join(REPO, 'scripts/dev/opencode-serve-live.mjs')));
}


// ── ⑨ verifier round on the runaway fix (2.369.50 follow-ups) ──
{
  // (a) a deterministic naming refusal (too-large / 404) is PERMANENT — never re-asked every 60s
  let calls = 0; let t9 = 5_000_000; const clock9 = () => t9;
  const c9 = {
    async listAllSessions() { return [{ id: 'ses_big', title: 'Big one', time: { created: 1, updated: 2 }, directory: '/w/big', version: '1.18.29' }]; },
    async firstUserMessage() { calls++; throw new serve.OpencodeServeError('GET /session/ses_big/message response exceeded 1048576 bytes', { code: 'too-large' }); },
    async listMessages() { return []; },
  };
  const loc9 = { client: async () => c9, ensure: async () => c9, state: () => ({ installed: true, ready: true, parked: false, autostart: true, caps: { fork: false } }), invalidate() { }, stop() { }, command: () => '/x/opencode' };
  const f9 = serve.createFacts(loc9, { now: clock9 });
  await f9.discover({ activeSessions: new Map() }); await new Promise((r) => setTimeout(r, 30));
  const c1 = calls;
  t9 += serve.LIST_CACHE_MS + 61_000; await f9.discover({ activeSessions: new Map() }); await new Promise((r) => setTimeout(r, 30));
  t9 += serve.LIST_CACHE_MS + 61_000; await f9.discover({ activeSessions: new Map() }); await new Promise((r) => setTimeout(r, 30));
  ok('a too-large naming refusal is terminal: ONE firstUserMessage call, never re-requested after NAME_RETRY_MS (the forever-poke pattern on a cheaper route)', c1 === 1 && calls === 1, { c1, calls });
  // (b) ensureServeCwd trusts a REPO, not a bare .git entry (a died git init / a backup without .git contents)
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-cwd-'));
  const cwd9 = serve.serveCwdPath(dd); fs.mkdirSync(cwd9, { recursive: true }); fs.mkdirSync(path.join(cwd9, '.git'));
  const r9 = await serve.ensureServeCwd(dd, {});
  ok('a bare .git entry is re-initialised into a real repo (HEAD exists) so OpenCode\'s upward walk stops there', r9.isolated === true && fs.existsSync(path.join(cwd9, '.git', 'HEAD')), r9);
  fs.rmSync(dd, { recursive: true, force: true });
  const src9 = fs.readFileSync(path.join(REPO, 'src/opencode-serve.js'), 'utf8');
  ok('the reuse-safety cwd shortcut only applies when OUR cwd is a VERIFIED repo (state.cwdIsolated === true)', /state\.cwdIsolated === true && state\.cwd && rec\.cwd/.test(src9));
  const ce9 = fs.readFileSync(path.join(REPO, 'src/server/cli-env.js'), 'utf8');
  ok('harnessAvailability reports a store reason only when the store is actually unavailable (parked, or not ready with autostart off) — a reused healthy serve is never called "not running"', /st\.parked \|\| \(!st\.ready && st\.autostart === false\)/.test(ce9));
}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
