#!/usr/bin/env node
// MOCK `opencode serve` (S9 gate fixture): the HTTP subset src/opencode-serve.js
// uses, shaped after the 1.18.29 OpenAPI (/doc, /global/health, /project,
// /session[?directory&limit&roots], /session/:id, /session/:id/message,
// /session/:id/children, /api/session/:id/message?limit&order, POST
// /session/:id/fork). Runs in-process (startMockServe) for the suite and as a
// child (`node mock-opencode-serve.mjs serve --port N …`) for the keeper's
// spawn path. Switches: state.hang (never answer), state.fail (HTTP 500),
// state.withFork (advertise + serve the fork endpoint), state.delayMs.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const SESSIONS = () => ([
  { id: 'ses_a1', slug: 'sunny-falcon', projectID: 'proj_a', directory: '/work/alpha', path: '', title: 'New session - 2026-09-05T10:00:00.000Z', agent: 'build', model: { id: 'big-pickle', providerID: 'opencode' }, version: '1.18.29', time: { created: 1788600000000, updated: 1788600500000 }, cost: 0, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
  { id: 'ses_a2', slug: 'kind-pixel', projectID: 'proj_a', directory: '/work/alpha/sub', path: 'sub', title: 'Fix the flaky test', agent: 'plan', model: { id: 'deepseek-v4', providerID: 'deepseek' }, version: '1.18.29', time: { created: 1788601000000, updated: 1788602000000 }, cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  { id: 'ses_child', slug: 'tiny-otter', projectID: 'proj_a', directory: '/work/alpha', path: '', parentID: 'ses_a2', title: 'subtask child', agent: 'build', model: { id: 'big-pickle', providerID: 'opencode' }, version: '1.18.29', time: { created: 1788601500000, updated: 1788601600000 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  { id: 'ses_g1', slug: 'quick-tiger', projectID: 'global', directory: '/tmp/x', path: 'tmp/x', title: 'New session - 2026-09-05T11:00:00.000Z', agent: 'build', model: { id: 'big-pickle', providerID: 'opencode' }, version: '1.18.29', time: { created: 1788603000000, updated: 1788603000000 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
]);
// Shaped after a real 1.18.29 store: a git-backed project row carries `vcs`,
// the 'global' catch-all does NOT and its worktree is whatever the last serve's
// cwd resolved to — on the owner's 2.369.42 box, "/" (the whole filesystem).
export const PROJECTS = [{ id: 'proj_a', worktree: '/work/alpha', vcs: 'git', time: { created: 1, updated: 2 }, sandboxes: [] }, { id: 'global', worktree: '/', time: { created: 1, updated: 2 }, sandboxes: [] }];

/** The v1 `GET /config` body (operationId `config.get`, optional `directory`)
 *  — the READ-ONLY permission-rule view's source. Shape verified against a
 *  real 1.18.29 serve: the top-level keys are that machine's own answer, and
 *  the `permission` block follows the doc's `PermissionConfig` schema —
 *  `anyOf` [ an action string | an object whose keys are the 15 tool names
 *  (read/edit/glob/grep/list/lsp/bash/webfetch/websearch/task/skill/question/
 *  todowrite/doom_loop/external_directory) each holding an action string or a
 *  {pattern: action} map ]. */
export const CONFIG = {
  $schema: 'https://opencode.ai/config.json', command: {}, plugin: [], username: 'someone', mode: {}, agent: {},
  permission: { edit: 'allow', bash: { 'git push*': 'deny', 'rm -rf*': 'deny', '*': 'ask' }, external_directory: 'deny', webfetch: 'ask' },
};

/** v1 messages for ses_a1: user → assistant (reasoning, text, read tool ok, edit tool error, subtask, step parts) → user → aborted assistant → user (no reply yet) */
export const MESSAGES = {
  ses_a1: [
    { info: { id: 'msg_u1', sessionID: 'ses_a1', role: 'user', time: { created: 1788600001000 }, agent: 'build', model: { providerID: 'opencode', modelID: 'big-pickle' } },
      parts: [{ id: 'prt_u1a', sessionID: 'ses_a1', messageID: 'msg_u1', type: 'text', text: 'please read README.md and fix the typo' }, { id: 'prt_u1b', sessionID: 'ses_a1', messageID: 'msg_u1', type: 'text', text: '<injected>', synthetic: true }, { id: 'prt_u1c', sessionID: 'ses_a1', messageID: 'msg_u1', type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' }] },
    { info: { id: 'msg_a1', sessionID: 'ses_a1', role: 'assistant', time: { created: 1788600002000, completed: 1788600009000 }, modelID: 'big-pickle', providerID: 'opencode', mode: 'build', agent: 'build', path: { cwd: '/work/alpha', root: '/work/alpha' }, cost: 0, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }, finish: 'stop' },
      parts: [
        { id: 'prt_s1', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'step-start' },
        { id: 'prt_r1', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'reasoning', text: 'I should look at the file first.', time: { start: 1788600002100, end: 1788600002500 } },
        { id: 'prt_t1', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'tool', callID: 'call_read_1', tool: 'read', state: { status: 'completed', input: { filePath: '/work/alpha/README.md' }, output: '# Alpha\nTeh project', title: 'README.md', metadata: {}, time: { start: 1788600003000, end: 1788600003500 } } },
        { id: 'prt_x1', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'text', text: 'Found the typo, fixing it now.', time: { start: 1788600004000, end: 1788600004100 } },
        { id: 'prt_t2', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'tool', callID: 'call_edit_1', tool: 'edit', state: { status: 'error', input: { filePath: '/work/alpha/README.md', oldString: 'Teh', newString: 'The' }, error: 'permission denied', time: { start: 1788600005000, end: 1788600005200 } } },
        { id: 'prt_t3', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'subtask', prompt: 'grep for other typos', description: 'typo sweep', agent: 'explore', model: { providerID: 'opencode', modelID: 'big-pickle' } },
        { id: 'prt_x2', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'text', text: 'Done.', time: { start: 1788600008000, end: 1788600008100 } },
        { id: 'prt_f1', sessionID: 'ses_a1', messageID: 'msg_a1', type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } } },
      ] },
    { info: { id: 'msg_u2', sessionID: 'ses_a1', role: 'user', time: { created: 1788600010000 }, agent: 'plan', model: { providerID: 'deepseek', modelID: 'deepseek-v4' } },
      parts: [{ id: 'prt_u2a', sessionID: 'ses_a1', messageID: 'msg_u2', type: 'text', text: 'now run the tests' }] },
    { info: { id: 'msg_a2', sessionID: 'ses_a1', role: 'assistant', time: { created: 1788600011000 }, modelID: 'deepseek-v4', providerID: 'deepseek', mode: 'plan', agent: 'plan', path: { cwd: '/work/alpha', root: '/work/alpha' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } },
      parts: [
        { id: 'prt_t4', sessionID: 'ses_a1', messageID: 'msg_a2', type: 'tool', callID: 'call_bash_1', tool: 'bash', state: { status: 'running', input: { command: 'npm test' }, title: 'npm test', metadata: {}, time: { start: 1788600011500 } } },
        { id: 'prt_c1', sessionID: 'ses_a1', messageID: 'msg_a2', type: 'compaction', auto: true },
      ] },
    { info: { id: 'msg_u3', sessionID: 'ses_a1', role: 'user', time: { created: 1788600020000 }, agent: 'plan', model: { providerID: 'deepseek', modelID: 'deepseek-v4' } },
      parts: [{ id: 'prt_u3a', sessionID: 'ses_a1', messageID: 'msg_u3', type: 'text', text: 'try again' }] },
  ],
  ses_a2: [
    { info: { id: 'msg_b1', sessionID: 'ses_a2', role: 'user', time: { created: 1788601001000 }, agent: 'plan', model: { providerID: 'deepseek', modelID: 'deepseek-v4' } }, parts: [{ id: 'prt_b1', sessionID: 'ses_a2', messageID: 'msg_b1', type: 'text', text: 'Fix the flaky test in ci' }] },
  ],
};

export function openapiDoc({ withFork = true } = {}) {
  const paths = {
    '/global/health': { get: { operationId: 'global.health' } },
    '/session': { get: { operationId: 'session.list' } },
    '/session/{sessionID}': { get: { operationId: 'session.get' } },
    '/session/{sessionID}/message': { get: { operationId: 'session.messages' } },
    '/session/{sessionID}/revert': { post: { operationId: 'session.revert' } },
    '/question/{requestID}/reply': { post: { operationId: 'question.reply' } },
  };
  if (withFork) paths['/session/{sessionID}/fork'] = { post: { operationId: 'session.fork' } };
  return { openapi: '3.1.1', info: { title: 'opencode', version: withFork ? '1.18.29' : '1.10.0' }, paths, components: { schemas: {} } };
}

/** A `question` tool part exactly as a real 1.18.29 turn records it: the input
 *  carries the questions, and once answered `state.metadata.answers` carries
 *  ONE array of labels per question, in order (captured live). */
export const QUESTION_PART = (answered) => ({
  id: 'prt_q1', sessionID: 'ses_a2', messageID: 'msg_bq', type: 'tool', callID: 'call_question_1', tool: 'question',
  state: answered
    ? { status: 'completed', input: { questions: [{ question: 'Do you prefer red or blue?', header: 'Color preference', options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }] }] }, output: 'User has answered your questions: "Do you prefer red or blue?"="Blue".', title: 'Asked 1 question', metadata: { answers: [['Blue']] }, time: { start: 1788601100000, end: 1788601110000 } }
    : { status: 'running', input: { questions: [{ question: 'Do you prefer red or blue?', header: 'Color preference', options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }] }] }, title: 'Asking 1 question', metadata: {}, time: { start: 1788601100000 } },
});

export function createMockState(opts = {}) {
  return {
    hang: false, fail: false, withFork: opts.withFork !== false, sessions: SESSIONS(),
    messages: JSON.parse(JSON.stringify(MESSAGES)), requests: [], forks: 0, delayMs: 0,
    // ── S9 remainder (B-eac2) ──
    questions: [],            // pending QuestionRequest[] (GET /question)
    todos: { ses_a1: [{ content: 'fix the typo', status: 'completed', priority: 'high' }] },
    answered: [],             // {requestID, answers} / {requestID, rejected}
    ptys: new Map(),          // ptyID → Pty
    ptySeq: 0,
    ptyTicketsAllowed: opts.ptyTicketsAllowed === true,  // an UNSECURED 1.18.29 serve refuses to mint one
    statuses: {},             // GET /session/status
    sse: new Set(),           // open /global/event responses
    paths: opts.paths || { home: '/home/mock', state: '/home/mock/.local/state/opencode', config: '/home/mock/.config/opencode', worktree: '/work/alpha', directory: '/work/alpha' },
    config: opts.config || JSON.parse(JSON.stringify(CONFIG)),   // the v1 /config body (permission rules)
    // the serve's OWN project (GET /project/current) — what the 2.369.42
    // self-heal probes on a recorded instance; '/' = the leftover shape
    currentWorktree: opts.currentWorktree || '/work/alpha',
    // MEASURED on the real 1.18.29 serve: any v2 /api/session/{id}/… route
    // bootstraps an instance for that session's DIRECTORY (fff indexer +
    // recursive inotify watch); the v1 routes boot nothing. The mock records
    // it so the suite can assert the discovery path bootstraps NOTHING.
    instances: new Set(), disposed: [],
  };
}

/** Push one `/global/event` frame to every open subscriber. Frame shape is
 *  the REAL one, captured on the wire: {directory, project, payload:{id,type,properties}}. */
export function emit(state, frame) {
  const line = `data: ${JSON.stringify({ project: 'proj_a', ...frame })}\n\n`;
  for (const res of state.sse) { try { res.write(line); } catch { } }
}

/** Move a conversation's `time.updated`, the way any write to it does on the
 *  real serve — the ONE fact the honest-liveness rung 2 reads. */
export function touch(state, sessionID, at = Date.now()) {
  const s0 = state.sessions.find((x) => x.id === sessionID);
  if (s0) s0.time = { ...s0.time, updated: at };
  return s0 || null;
}

function readBody(req, cb) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { let j = null; try { j = raw ? JSON.parse(raw) : null; } catch { } cb(j); });
}

export function makeHandler(state) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  return (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.method === 'GET' && url.pathname === '/global/event') {
      // NO instance boot (measured on the real serve) and no `directory` query
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ payload: { id: 'evt_c', type: 'server.connected', properties: {} } }) + '\n\n');
      state.sse.add(res);
      req.on('close', () => state.sse.delete(res));
      return;
    }
    if (state.hang) return; // never answers — the client's timeout is the only way out
    if (state.fail) return json(res, 500, { name: 'InternalError', data: { message: 'mock failure' } });
    const run = () => {
      const p = url.pathname;
      if (req.method === 'GET' && p === '/global/health') return json(res, 200, { healthy: true, version: '1.18.29' });
      if (req.method === 'GET' && p === '/doc') return json(res, 200, openapiDoc({ withFork: state.withFork }));
      if (req.method === 'GET' && p === '/project') return json(res, 200, PROJECTS);
      // v1 `config.get` — the permission-rule view's ONE source. MEASURED on a
      // real 1.18.29 serve (2026-09-07, /proc, same method as 2.369.50): four
      // calls left threads at 15, inotify fds at 0 and RSS flat ⇒ it boots no
      // instance, which is why the view may call it.
      if (req.method === 'GET' && p === '/config') return json(res, 200, state.config || CONFIG);
      // …and the v2 TWIN that must never be called. MEASURED on the same
      // process minutes later: `GET /api/permission/saved` took it from
      // threads 13 → 37, inotify fds 0 → 2, RSS 345 → 507 MB. Modelled here so
      // a reader that reaches for the obvious-looking route turns this suite
      // red instead of turning the fleet slow.
      if (req.method === 'GET' && p === '/api/permission/saved') {
        state.instances.add(state.currentWorktree);
        return json(res, 200, { data: [] });
      }
      if (req.method === 'GET' && p === '/project/current') return json(res, 200, { id: 'global', worktree: state.currentWorktree, time: { created: 1, updated: 2 }, sandboxes: [] });
      if (req.method === 'POST' && p === '/instance/dispose') {
        const dir = url.searchParams.get('directory') || '';
        state.disposed.push(dir); state.instances.delete(dir);
        return json(res, 200, true);
      }
      if (req.method === 'GET' && p === '/session') {
        // verified 1.18.29 semantics: bare directory = EXACT directory match ("/" matches nothing);
        // scope=project + directory=<worktree> = every session of that project
        const dir = url.searchParams.get('directory');
        const scope = url.searchParams.get('scope');
        const roots = url.searchParams.get('roots') === 'true';
        const limit = Number(url.searchParams.get('limit') || 0) || Infinity;
        let list = state.sessions;
        if (scope === 'project') { const proj = PROJECTS.find((pr) => pr.worktree === dir)?.id || 'global'; list = list.filter((s) => s.projectID === proj); }
        else if (dir) list = list.filter((s) => s.directory === dir);
        if (roots) list = list.filter((s) => !s.parentID);
        list = [...list].sort((a, b) => b.time.updated - a.time.updated).slice(0, limit);
        return json(res, 200, list);
      }
      let m;
      if (req.method === 'GET' && p === '/session/status') return json(res, 200, state.statuses || {});
      if (req.method === 'GET' && p === '/path') return json(res, 200, state.paths);
      if ((m = p.match(/^\/session\/([^/]+)$/)) && req.method === 'GET') {
        const s = state.sessions.find((x) => x.id === decodeURIComponent(m[1]));
        return s ? json(res, 200, s) : json(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${m[1]}` } });
      }
      if ((m = p.match(/^\/session\/([^/]+)\/message$/)) && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        if (!state.sessions.some((x) => x.id === id)) return json(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${id}` } });
        const all = state.messages[id] || [];
        const limit = Number(url.searchParams.get('limit') || 0);
        return json(res, 200, limit ? all.slice(-limit) : all); // v1: limit = the NEWEST N
      }
      if ((m = p.match(/^\/api\/session\/([^/]+)/)) && req.method === 'GET') {
        // EVERY v2 per-session route boots the instance (measured) — model it
        const id = decodeURIComponent(m[1]);
        const s0 = state.sessions.find((x) => x.id === id);
        if (s0 && s0.directory) state.instances.add(s0.directory);
      }
      if ((m = p.match(/^\/api\/session\/([^/]+)\/message$/)) && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const all = state.messages[id] || [];
        const asc = url.searchParams.get('order') === 'asc';
        const limit = Number(url.searchParams.get('limit') || 0) || all.length;
        const ordered = asc ? all : [...all].reverse();
        const data = ordered.slice(0, limit).map((x) => x.info.role === 'user'
          ? { id: x.info.id, type: 'user', time: x.info.time, text: x.parts.filter((q) => q.type === 'text' && !q.synthetic).map((q) => q.text).join('\n'), files: [] }
          : { id: x.info.id, type: 'assistant', time: x.info.time, agent: x.info.agent, model: { providerID: x.info.providerID, modelID: x.info.modelID }, content: [] });
        return json(res, 200, { data, cursor: { previous: null, next: null } });
      }
      if ((m = p.match(/^\/session\/([^/]+)\/todo$/)) && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        if (!state.sessions.some((x) => x.id === id)) return json(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } });
        return json(res, 200, state.todos?.[id] || []);
      }
      if ((m = p.match(/^\/session\/([^/]+)\/children$/)) && req.method === 'GET') return json(res, 200, state.sessions.filter((s) => s.parentID === decodeURIComponent(m[1])));
      if ((m = p.match(/^\/session\/([^/]+)\/fork$/)) && req.method === 'POST') {
        if (!state.withFork) return json(res, 404, { name: 'NotFoundError', data: { message: 'Not Found' } });
        const src = state.sessions.find((x) => x.id === decodeURIComponent(m[1]));
        if (!src) return json(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${m[1]}` } });
        state.forks++;
        const forked = { ...src, id: `${src.id}_fork${state.forks}`, slug: `fork-${state.forks}`, title: `${src.title} (fork #${state.forks})`, time: { created: Date.now(), updated: Date.now() }, directory: url.searchParams.get('directory') || src.directory };
        delete forked.parentID;
        state.sessions.unshift(forked);
        state.messages[forked.id] = JSON.parse(JSON.stringify(state.messages[src.id] || []));
        return json(res, 200, forked);
      }
      // ── REVERT (v1: boots NO instance — measured on the real serve) ──
      if ((m = p.match(/^\/session\/([^/]+)\/revert$/)) && req.method === 'POST') {
        const s0 = state.sessions.find((x) => x.id === decodeURIComponent(m[1]));
        if (!s0) return json(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } });
        return readBody(req, (body) => {
          if (!body || !body.messageID) return json(res, 400, { name: 'BadRequest', data: { message: 'messageID required' } });
          s0.revert = { messageID: body.messageID, ...(body.partID ? { partID: body.partID } : {}), snapshot: 'deadbeef', diff: 'diff --git a/hello.txt b/hello.txt\ndeleted file mode 100644\n', files: [{ path: 'hello.txt', added: 0, removed: 1 }] };
          s0.time = { ...s0.time, updated: Date.now() };
          emit(state, { directory: s0.directory, payload: { id: 'evt_r', type: 'session.updated', properties: { sessionID: s0.id, info: s0 } } });
          return json(res, 200, s0);
        });
      }
      if ((m = p.match(/^\/session\/([^/]+)\/unrevert$/)) && req.method === 'POST') {
        const s0 = state.sessions.find((x) => x.id === decodeURIComponent(m[1]));
        if (!s0) return json(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } });
        delete s0.revert;
        s0.time = { ...s0.time, updated: Date.now() };
        emit(state, { directory: s0.directory, payload: { id: 'evt_u', type: 'session.updated', properties: { sessionID: s0.id, info: s0 } } });
        return json(res, 200, s0);
      }
      // the v2 revert family — modelled ONLY so the suite can prove we never
      // call it: like every /api/session/:id/… route it boots an instance
      if ((m = p.match(/^\/api\/session\/([^/]+)\/revert\//)) && req.method === 'POST') {
        const s0 = state.sessions.find((x) => x.id === decodeURIComponent(m[1]));
        if (s0 && s0.directory) state.instances.add(s0.directory);
        return json(res, 200, { data: { messageID: 'msg_u1' } });
      }

      // ── QUESTION ──
      if (req.method === 'GET' && p === '/question') return json(res, 200, state.questions);
      if ((m = p.match(/^\/question\/([^/]+)\/reply$/)) && req.method === 'POST') {
        const rid = decodeURIComponent(m[1]);
        const q = state.questions.find((x) => x.id === rid);
        if (!q) return json(res, 404, { name: 'QuestionNotFoundError', data: { message: 'Question not found' } });
        return readBody(req, (body) => {
          if (!body || !Array.isArray(body.answers)) return json(res, 400, { name: 'BadRequest', data: { message: 'answers required' } });
          state.answered.push({ requestID: rid, answers: body.answers });
          state.questions = state.questions.filter((x) => x.id !== rid);
          // answering resumes the turn, so the conversation MOVES — the reply
          // route itself returns no Session, which is exactly why the own-write
          // ledger needs its windowed form for this action
          touch(state, q.sessionID);
          emit(state, { payload: { id: 'evt_qr', type: 'question.replied', properties: { sessionID: q.sessionID, requestID: rid, answers: body.answers } } });
          return json(res, 200, true);
        });
      }
      if ((m = p.match(/^\/question\/([^/]+)\/reject$/)) && req.method === 'POST') {
        const rid = decodeURIComponent(m[1]);
        const q = state.questions.find((x) => x.id === rid);
        if (!q) return json(res, 404, { name: 'QuestionNotFoundError', data: { message: 'Question not found' } });
        state.answered.push({ requestID: rid, rejected: true });
        state.questions = state.questions.filter((x) => x.id !== rid);
        touch(state, q.sessionID);
        emit(state, { payload: { id: 'evt_qj', type: 'question.rejected', properties: { sessionID: q.sessionID, requestID: rid } } });
        return json(res, 200, true);
      }

      // ── PTY ──
      // TWO MEASURED FACTS, both modelled here because the product's whole pty
      // fix depends on them (real 1.18.29, /proc + inotify-wd sampling):
      //  ① `?directory=X` BOOTS the instance for X (a full recursive index +
      //     inotify watch of that tree: 204 wds on a 200-dir repo) and NOTHING
      //     in the pty family releases it — only POST /instance/dispose does.
      //     With no query, the DEFAULT-directory instance is used instead (our
      //     own empty throwaway repo: 4 wds). The `cwd` BODY field places the
      //     SHELL and boots nothing.
      //  ② the pty REGISTRY is PER INSTANCE: `PUT /pty/{id}?directory=X` on a
      //     pty created WITHOUT the query answers 404 PtyNotFoundError, and
      //     vice versa. So a half-migrated family = a terminal that can be
      //     opened and never resized, closed or reaped.
      const ptyInstance = (u) => u.searchParams.get('directory') || state.paths.worktree;
      const ptyLookup = (id, u) => { const t = state.ptys.get(id); return t && t._instance === ptyInstance(u) ? t : null; };
      if (req.method === 'GET' && p === '/pty') {
        const inst = ptyInstance(url);
        state.instances.add(inst);
        return json(res, 200, [...state.ptys.values()].filter((t) => t._instance === inst).map(({ _instance, ...rest }) => rest));
      }
      if (req.method === 'POST' && p === '/pty') {
        return readBody(req, (body) => {
          const id = `pty_mock${++state.ptySeq}`;
          const inst = ptyInstance(url);
          const pty = { id, title: (body && body.title) || 'shell', command: (body && body.command) || '/bin/bash', args: [], cwd: (body && body.cwd) || state.paths.worktree, status: 'running', pid: 4242 + state.ptySeq };
          Object.defineProperty(pty, '_instance', { value: inst, enumerable: false });
          state.ptys.set(id, pty);
          state.instances.add(inst);      // ONLY the query's directory — never the body's cwd
          emit(state, { directory: inst, payload: { id: 'evt_pc', type: 'pty.created', properties: { info: pty } } });
          return json(res, 200, pty);
        });
      }
      if ((m = p.match(/^\/pty\/([^/]+)$/)) && req.method === 'GET') { const t = ptyLookup(decodeURIComponent(m[1]), url); return t ? json(res, 200, t) : json(res, 404, { name: 'PtyNotFoundError', data: { message: 'PTY session not found: ' + decodeURIComponent(m[1]) } }); }
      if ((m = p.match(/^\/pty\/([^/]+)$/)) && req.method === 'PUT') {
        const t = ptyLookup(decodeURIComponent(m[1]), url);
        if (!t) return json(res, 404, { name: 'PtyNotFoundError', data: { message: 'PTY session not found: ' + decodeURIComponent(m[1]) } });
        return readBody(req, (body) => { if (body && body.size) t.size = body.size; if (body && body.title) t.title = body.title; return json(res, 200, t); });
      }
      if ((m = p.match(/^\/pty\/([^/]+)$/)) && req.method === 'DELETE') {
        const id = decodeURIComponent(m[1]);
        const t = ptyLookup(id, url);
        if (!t) return json(res, 404, { name: 'PtyNotFoundError', data: { message: 'PTY session not found: ' + id } });
        state.ptys.delete(id);
        // the shell dies; the INSTANCE the create booted is deliberately NOT
        // released — that is the leak the product now refuses to create
        emit(state, { directory: t._instance, payload: { id: 'evt_pd', type: 'pty.deleted', properties: { id } } });
        return json(res, 200, true);
      }
      if ((m = p.match(/^\/pty\/([^/]+)\/connect-token$/)) && req.method === 'POST') {
        // a real UNSECURED 1.18.29 serve refuses this (PtyForbiddenError) while
        // the ws upgrade itself needs no ticket — the bridge must cope
        if (!ptyLookup(decodeURIComponent(m[1]), url)) return json(res, 404, { name: 'PtyNotFoundError', data: { message: 'PTY session not found: ' + decodeURIComponent(m[1]) } });
        if (!state.ptyTicketsAllowed) return json(res, 403, { name: 'PtyForbiddenError', data: { message: 'Invalid PTY connect token request' } });
        return json(res, 200, { ticket: 'tkt_' + decodeURIComponent(m[1]), expires_in: 60 });
      }
      return json(res, 404, { name: 'NotFoundError', data: { message: 'Not Found' } });
    };
    if (state.delayMs) setTimeout(run, state.delayMs); else run();
  };
}

export function startMockServe({ port = 0, state = null, pty = false } = {}) {
  const st = state || createMockState();
  const server = http.createServer(makeHandler(st));
  let wss = null;
  if (pty) {
    // GET /pty/:id/connect upgrades to a websocket. Verified on the real
    // 1.18.29 serve: TEXT frames are terminal output, BINARY frames are
    // \0-prefixed control json, and frames written IN reach the shell.
    const { WebSocketServer } = createRequire(import.meta.url)('ws');
    wss = new WebSocketServer({ noServer: true });
    st.ptySockets = st.ptySockets || [];
    server.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const m = u.pathname.match(/^\/pty\/([^/]+)\/connect$/);
      if (!m) { socket.destroy(); return; }
      // A PTY THE SERVE NO LONGER HAS answers the UPGRADE with a plain HTTP
      // 404 — measured on the real 1.18.29 serve after a shell `exit`
      // (`GET /pty/<id>` → PtyNotFoundError, the upgrade → 404, which the ws
      // client surfaces as `Unexpected server response: 404`). Modelled here
      // because the bridge's reconnect rule depends on telling that verdict
      // apart from a dropped transport.
      // …and the ws upgrade is served by the SAME per-instance registry, so a
      // `directory` query on a pty created without one is a 404 here too (that
      // is the whole reason the pty family must change together).
      const upPty = st.ptys.get(decodeURIComponent(m[1]));
      const upInstance = u.searchParams.get('directory') || st.paths.worktree;
      if (!upPty || upPty._instance !== upInstance) {
        st.requests.push(`WS404 ${u.pathname}${u.search}`);
        const body = JSON.stringify({ _tag: 'PtyNotFoundError', message: 'PTY session not found' });
        socket.end(`HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        return;
      }
      st.requests.push(`WS ${u.pathname}${u.search}`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const id = decodeURIComponent(m[1]);
        st.ptySockets.push({ id, ws, ticket: u.searchParams.get('ticket'), auth: req.headers.authorization || null, input: [] });
        ws.on('message', (d, isBin) => { st.ptySockets.find((x) => x.ws === ws)?.input.push(isBin ? d.toString('utf8') : d.toString('utf8')); });
        // greet exactly like the real serve: a text banner, then a binary
        // \0-json control frame the bridge must NOT render
        ws.send('mock-shell$ ');
        ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify({ cursor: 12 }))]), { binary: true });
      });
    });
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ state: st, server, wss, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { try { wss?.close(); } catch { } server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

// child mode: `node mock-opencode-serve.mjs serve --port N [--hostname H] [--log-level L]`
//   MOCK_OPENCODE_CRASH=1 exits 3 at once (keeper crash loop), MOCK_OPENCODE_NO_FORK=1 hides the fork endpoint,
//   MOCK_OPENCODE_BOOT_DELAY_MS delays the listen (boot-wait path),
//   MOCK_OPENCODE_WORKTREE overrides GET /project/current's worktree (default: the child's own cwd —
//   so the keeper's isolated-cwd spawn reports a SAFE project and a hand-started '/' serve reports '/')
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'serve') {
  const argv = process.argv.slice(3);
  if (argv.includes('--crash') || process.env.MOCK_OPENCODE_CRASH === '1') process.exit(3);
  const port = Number(argv[argv.indexOf('--port') + 1] || 0);
  const st = createMockState({ withFork: !argv.includes('--no-fork') && process.env.MOCK_OPENCODE_NO_FORK !== '1', currentWorktree: process.env.MOCK_OPENCODE_WORKTREE || process.cwd() });
  const delay = Number(process.env.MOCK_OPENCODE_BOOT_DELAY_MS || 0);
  setTimeout(() => { startMockServe({ port, state: st }).then((m) => { process.stdout.write(`mock opencode serve listening on ${m.url}\n`); }); }, delay);
}
