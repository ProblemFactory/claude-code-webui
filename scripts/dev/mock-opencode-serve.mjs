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

export function createMockState(opts = {}) {
  return {
    hang: false, fail: false, withFork: opts.withFork !== false, sessions: SESSIONS(),
    messages: JSON.parse(JSON.stringify(MESSAGES)), requests: [], forks: 0, delayMs: 0,
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

export function makeHandler(state) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  return (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (state.hang) return; // never answers — the client's timeout is the only way out
    if (state.fail) return json(res, 500, { name: 'InternalError', data: { message: 'mock failure' } });
    const run = () => {
      const p = url.pathname;
      if (req.method === 'GET' && p === '/global/health') return json(res, 200, { healthy: true, version: '1.18.29' });
      if (req.method === 'GET' && p === '/doc') return json(res, 200, openapiDoc({ withFork: state.withFork }));
      if (req.method === 'GET' && p === '/project') return json(res, 200, PROJECTS);
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
      if (req.method === 'GET' && p === '/session/status') return json(res, 200, {});
      return json(res, 404, { name: 'NotFoundError', data: { message: 'Not Found' } });
    };
    if (state.delayMs) setTimeout(run, state.delayMs); else run();
  };
}

export function startMockServe({ port = 0, state = null } = {}) {
  const st = state || createMockState();
  const server = http.createServer(makeHandler(st));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ state: st, server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
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
