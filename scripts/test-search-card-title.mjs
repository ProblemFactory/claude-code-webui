#!/usr/bin/env node
// Search cards show their QUERY in the title (2.369.43, owner ask: "see what
// was searched without expanding") — all harnesses:
//   ① src/search-card.js (PURE, shared server+browser): searchQueryOf over the
//      real input shapes (claude WebSearch {query} / WebFetch {url}, codex
//      web_search {query, action} incl. the EMPTY item/started stub, ACP search),
//      renderSearchOutput (results / open_page / find_in_page / error / caps),
//      searchActionKey (0.120-0.130 twin pairing).
//   ② the REAL chat-renderers (esbuild-bundled for node, DOM shimmed): the
//      generic/error/pending card headers carry `.chat-tool-query` with the
//      query, XSS-escaped in both the text and the title attribute — the text
//      is MODEL/WEB-controlled and syncs to every client.
//   ③ source pins: every search-card header path calls the one chip helper;
//      the fold summary line in chat-view is untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

console.log('— ① search-card.js (pure)');
{
  const { searchQueryOf, renderSearchOutput, searchActionKey, MAX_RESULTS, MAX_OUTPUT_BYTES } = require(path.join(REPO, 'src/search-card.js'));
  ok('claude WebSearch {query}', searchQueryOf({ query: 'vibespace acp' }) === 'vibespace acp');
  ok('claude WebFetch {url, prompt}', searchQueryOf({ url: 'https://example.org/x', prompt: 'summarize' }) === 'https://example.org/x');
  ok('codex EMPTY started stub → nothing to show', searchQueryOf({ query: '', action: null }) === '');
  ok('codex completed {query, action.queries} → the query', searchQueryOf({ query: 'q1', action: { type: 'search', queries: ['q1', 'q2'] } }) === 'q1');
  ok('codex action-only (web_search_call twin) → queries joined', searchQueryOf({ query: '', action: { type: 'search', queries: ['a', 'b'] } }) === 'a | b');
  ok('codex open_page → the url', searchQueryOf({ query: '', action: { type: 'open_page', url: 'https://x.example/p' } }) === 'https://x.example/p');
  ok("codex find_in_page → 'pattern' in url", searchQueryOf({ action: { type: 'find_in_page', url: 'https://x.example/p', pattern: 'JSON output' } }) === "'JSON output' in https://x.example/p");
  ok('ACP search {pattern} / string input / garbage', searchQueryOf({ pattern: 'TODO' }) === 'TODO' && searchQueryOf('raw q') === 'raw q' && searchQueryOf(null) === '' && searchQueryOf(42) === '' && searchQueryOf({ action: 'search' }) === '');
  const r = renderSearchOutput({ query: 'q', action: { type: 'search', queries: ['q'] }, results: [{ type: 'text_result', title: 'T1', url: 'https://u1', snippet: 'a  b\n c' }, { type: 'text_result', domain: 'd2', url: 'https://u2' }, 'plain', 7] });
  ok('search results: title — url / snippet blocks; domain stands in for a missing title; non-object results stringified', r.output === 'T1 — https://u1\na b c\n\nd2 — https://u2\n\nplain\n\n7' && r.isError === false, r.output);
  ok('open_page head + results', renderSearchOutput({ action: { type: 'open_page', url: 'https://p' }, results: [{ title: 'P', snippet: 'Total lines: 3' }] }).output === 'opened https://p\n\nP\nTotal lines: 3');
  ok('find_in_page head, no results key', renderSearchOutput({ action: { type: 'find_in_page', url: 'https://p', pattern: 'x' } }).output === "found 'x' in https://p");
  ok('no results, no head → "no results"', renderSearchOutput({ query: 'q', action: { type: 'search' }, results: [] }).output === 'no results');
  ok('error (string / object) → is_error with the message', renderSearchOutput({ error: 'boom' }).isError === true && renderSearchOutput({ error: 'boom' }).output === 'boom' && renderSearchOutput({ error: { message: 'm' } }).output === 'm');
  const many = renderSearchOutput({ results: Array.from({ length: 25 }, (_, i) => ({ title: 't' + i, url: 'https://u/' + i })) });
  ok(`results cap at ${MAX_RESULTS} with a "+N more" marker`, many.output.split('\n\n').length === MAX_RESULTS + 1 && /… \+5 more$/.test(many.output), many.output.slice(-40));
  const big = renderSearchOutput({ results: Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i, url: 'https://u/' + i, snippet: '汉字'.repeat(200) })) });
  ok(`output byte cap ${MAX_OUTPUT_BYTES} on a char boundary (CJK)`, Buffer.byteLength(big.output, 'utf8') <= MAX_OUTPUT_BYTES && big.output.endsWith('…') && !big.output.includes('�'), Buffer.byteLength(big.output, 'utf8'));
  ok('twin key: end (query+action) == id-less call (action only), per action type', searchActionKey({ type: 'search', query: 'Q', queries: ['Q', 'Q2'] }, 'Q') === searchActionKey({ type: 'search', query: 'Q', queries: ['Q', 'Q2'] }, 'Q')
    && searchActionKey({ type: 'open_page', url: 'https://p' }, 'https://p') === searchActionKey({ type: 'open_page', url: 'https://p' }, undefined)
    && searchActionKey({ type: 'search', queries: ['a'] }, 'a') !== searchActionKey({ type: 'search', queries: ['b'] }, 'b'));
  ok('module is PURE (no requires) and registered in the PURE tier', !/require\(/.test(read('src/search-card.js')) && /'src\/search-card\.js'/.test(read('scripts/test-architecture.mjs')));

  // ── verifier-refuted 2026-09-06 (real-data shapes, fleet scan by session_meta.cli_version) ──
  const { actionType } = require(path.join(REPO, 'src/search-card.js'));
  // the v2 app-server / 0.153.4 Extension item spells the page actions camelCase (schema: openPage / findInPage, url + pattern NULLABLE)
  ok('actionType normalises both spellings (v2 camelCase + core snake_case) and unknown → other', actionType({ type: 'openPage' }) === 'open_page' && actionType({ type: 'findInPage' }) === 'find_in_page' && actionType({ type: 'open_page' }) === 'open_page' && actionType({ type: 'search' }) === 'search' && actionType({ type: 'other' }) === 'other' && actionType({ type: 'bogus' }) === 'other' && actionType(null) === '');
  ok("v2 openPage renders 'opened <url>' like open_page", renderSearchOutput({ query: 'https://www.example9.org/shop', action: { type: 'openPage', url: 'https://www.example9.org/shop' }, results: [{ type: 'text_result', domain: 'www.example9.org', ref_id: 'turn96view0', snippet: 'Total lines: 217', title: 'Shop', url: 'https://www.example9.org/shop' }] }).output === 'opened https://www.example9.org/shop\n\nShop — https://www.example9.org/shop\nTotal lines: 217');
  ok("v2 findInPage with url:null (real 0.153.4 record, query = the quoted pattern) → \"found '<pattern>'\" with NO fake location", renderSearchOutput({ query: "'openable window'", action: { type: 'findInPage', url: null, pattern: 'openable window' }, results: [{ type: 'text_result', domain: 'd', ref_id: 'r', snippet: 'Total lines: 1033', url: 'https://d/x.pdf' }] }).output === "found 'openable window'\n\nd — https://d/x.pdf\nTotal lines: 1033");
  ok('searchQueryOf reads the camelCase actions too (title chip)', searchQueryOf({ query: '', action: { type: 'openPage', url: 'https://x.example/p' } }) === 'https://x.example/p' && searchQueryOf({ action: { type: 'findInPage', url: 'https://x.example/p', pattern: 'q' } }) === "'q' in https://x.example/p");
  // 'no results' is a CLAIM only an EMPTY ARRAY supports — 0.120/0.125/0.130 ends never carry the key (1698 ends, 0 with it; 42/200 cards on the real 0.125 file claimed 'no results'), while 0.149.1 + 0.153.4 always do
  ok("results ABSENT + plain search → 'searched: <query>' (no emptiness claim)", renderSearchOutput({ query: 'GitHub request code review', action: { type: 'search', query: 'GitHub request code review', queries: ['GitHub request code review', 'alt'] } }).output === 'searched: GitHub request code review');
  ok("results ABSENT + open_page → the head only", renderSearchOutput({ query: 'https://p', action: { type: 'open_page', url: 'https://p' } }).output === 'opened https://p');
  ok("results ABSENT + action {type:'other'} + query '' (real 0.120.0 end) → 'status: completed', never 'no results'", renderSearchOutput({ query: '', action: { type: 'other' } }).output === 'status: completed');
  ok("results [] stays 'no results' (real 0.153.4 record with results: [])", renderSearchOutput({ query: 'q', action: { type: 'search', query: null, queries: ['q'] }, results: [] }).output === 'no results');
  // twin key: {type:'other'} end ↔ action-less call are ONE bucket (real 2026-04-14 rollout lines 6417/6418)
  ok("twin key: end {query:'', action:{type:'other'}} == call with NO action", searchActionKey({ type: 'other' }, '') === searchActionKey(undefined, undefined) && searchActionKey({ type: 'other' }, '') === searchActionKey(null, ''));
  ok('twin key: a bare query without an action is still a SEARCH bucket, not other', searchActionKey(null, 'q') !== searchActionKey({ type: 'other' }, '') && searchActionKey(null, 'q') === searchActionKey({ type: 'search', query: 'q' }, undefined));
  ok('twin key: camelCase and snake_case page actions key the same', searchActionKey({ type: 'openPage', url: 'https://p' }, 'https://p') === searchActionKey({ type: 'open_page', url: 'https://p' }, undefined));
}

console.log('— ② the real renderer (esbuild → node, DOM shimmed)');
{
  const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sct-')), 'chat-renderers.mjs');
  // build-version.js is GENERATED by `npm run build` (gitignored) — stub it so the suite runs on a fresh checkout too
  const stubBuildVersion = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
  await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/chat-renderers.js')], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: out, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stubBuildVersion] });
  // minimal DOM: the renderer builds HTML strings; only the element wrapper + the delegated link handler touch the DOM
  const mkEl = () => ({ className: '', dataset: {}, _html: '', classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; } });
  const noop = () => {};
  for (const [k, v] of Object.entries({ addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }), requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop, getComputedStyle: () => ({ getPropertyValue: () => '' }), innerWidth: 1024, innerHeight: 768, location: { origin: 'http://test', href: 'http://test/', hostname: 'test', protocol: 'http:' }, scrollTo: noop })) {
    try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {}
  }
  class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  for (const k of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) { try { Object.defineProperty(globalThis, k, { value: NoopObserver, configurable: true, writable: true }); } catch {} }
  globalThis.window = globalThis;
  globalThis.document = { createElement: mkEl, getElementById: () => null, body: mkEl(), documentElement: mkEl(), head: mkEl(), addEventListener: noop, removeEventListener: noop, querySelector() { return null; }, querySelectorAll() { return []; }, createTextNode: (t) => ({ textContent: t }) };
  // node ≥21 ships a getter-only `navigator`; i18n only reads .language (auto → en fallback), so a failed override is fine
  try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', userAgent: 'node' }, configurable: true, writable: true }); } catch {}
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { ChatRenderers, searchQueryChipHtml } = await import(out);
  const r = new ChatRenderers({ ws: null, sessionId: 's', app: {}, backend: 'claude', compact: false, messageList: mkEl() });
  const evil = '<img src=x onerror=alert(1)>" onmouseover="x';
  const card = (toolName, input, extra = {}) => ({ role: 'tool', status: 'complete', toolStatus: 'ok', toolName, content: [{ type: 'tool_result', toolCallId: 'c', toolName, input, output: 'ok', status: 'ok' }], ...extra });
  const chip = (html) => { const m = /<span class="chat-tool-query" title="([^"]*)">([^<]*)<\/span>/.exec(html); return m ? { title: m[1], text: m[2] } : null; };
  const ws = r.renderToolResult(card('WebSearch', { query: 'best van build 2026' }).content[0], card('WebSearch', { query: 'best van build 2026' }));
  ok('claude WebSearch: title carries the query', chip(ws)?.text === 'best van build 2026' && /Web search/.test(ws), ws.slice(0, 300));
  const wf = card('WebFetch', { url: 'https://example.org/page', prompt: 'x' });
  ok('claude WebFetch: title carries the url', chip(r.renderToolResult(wf.content[0], wf))?.text === 'https://example.org/page');
  const cx = card('web_search', { query: 'vibespace acp', action: { type: 'search', queries: ['vibespace acp'] } }, { collapseKind: 'search' });
  const cxHtml = r.renderToolResult(cx.content[0], cx);
  ok('codex web_search (collapseKind hint): title carries the query + the localized "Web search" label', chip(cxHtml)?.text === 'vibespace acp' && /Web search/.test(cxHtml) && !/>web_search</.test(cxHtml), cxHtml.slice(0, 300));
  const op = card('web_search', { query: '', action: { type: 'open_page', url: 'https://x.example/p' } }, { collapseKind: 'search' });
  ok('codex open_page: title carries the url', chip(r.renderToolResult(op.content[0], op))?.text === 'https://x.example/p');
  const acp = card('Search', { query: 'needle' }, { collapseKind: 'search' });
  ok('ACP search tool (kind search): title carries the query', chip(r.renderToolResult(acp.content[0], acp))?.text === 'needle');
  const bash = card('Bash', { command: 'ls', query: 'not a search' });
  ok('a non-search card gets NO chip (no behaviour change)', chip(r.renderToolResult(bash.content[0], bash)) === null && !/chat-tool-query/.test(r.renderToolResult(bash.content[0], bash)));
  const xss = card('WebSearch', { query: evil });
  const xh = r.renderToolResult(xss.content[0], xss);
  const xc = chip(xh);
  ok('XSS: the query is escaped in the chip text AND its title attribute', xc && !xh.includes('<img') && !/onmouseover="x/.test(xh) && xc.text.includes('&lt;img') && xc.title.includes('&quot;') && xc.title.includes('&lt;img'), xh.slice(0, 400));
  const long = 'q'.repeat(200);
  const lc = chip(r.renderToolResult(card('WebSearch', { query: long }).content[0], card('WebSearch', { query: long })));
  ok('long queries truncate at ~90 chars in the chip, full text in the title', lc && lc.text.length === 90 && lc.text.endsWith('…') && lc.title === long);
  const errCard = { ...card('WebSearch', { query: 'err q' }), toolStatus: 'error', status: 'error' }; errCard.content[0].status = 'error';
  ok('error card header carries the query too', chip(r.renderToolResult(errCard.content[0], errCard))?.text === 'err q');
  // pending (tool_call block): codex empty stub = no chip; claude pending WebSearch = chip
  const pendCodex = { role: 'tool', status: 'pending', toolName: 'web_search', collapseKind: 'search', content: [{ type: 'tool_call', toolCallId: 'p', toolName: 'web_search', input: { query: '', action: null } }] };
  const pendClaude = { role: 'tool', status: 'pending', toolName: 'WebSearch', content: [{ type: 'tool_call', toolCallId: 'p', toolName: 'WebSearch', input: { query: 'pending q' } }] };
  ok('pending codex stub (empty query) renders NO empty chip', r.renderToolMsg(pendCodex)._html && !/chat-tool-query/.test(r.renderToolMsg(pendCodex)._html));
  ok('pending claude WebSearch header carries the query while running', chip(r.renderToolMsg(pendClaude)._html)?.text === 'pending q', r.renderToolMsg(pendClaude)._html.slice(0, 300));
  ok('searchQueryChipHtml is exported and empty for non-search / empty input', searchQueryChipHtml({ toolName: 'Read', input: { query: 'x' } }, {}) === '' && searchQueryChipHtml({ toolName: 'WebSearch', input: {} }, {}) === '');
}

console.log('— ③ wiring pins');
{
  const cr = read('src/lib/chat-renderers.js');
  ok('the three tool-card header paths (pending/interrupted, error, generic) all append searchQueryChipHtml', (cr.match(/\$\{searchQueryChipHtml\(block, msg\)\}/g) || []).length === 3);
  ok('the chip escapes both text and title', /title="\$\{escHtml\(q\)\}">\$\{escHtml\(short\)\}/.test(cr));
  ok('client imports the shared PURE module (no duplicate query logic)', /import \{ searchQueryOf \} from '\.\.\/search-card\.js'/.test(cr));
  const css = read('public/chat.css');
  ok('.chat-tool-query styled with theme vars only', /\.chat-tool-query \{[\s\S]{0,400}var\(--text-secondary\)/.test(css) && !/\.chat-tool-query \{[^}]*#[0-9a-f]{3}/i.test(css));
  const cv = read('src/lib/chat-view.js');
  ok('the fold summary line (per-kind counts, "N web searches") is untouched', /\['search', '\{n\} web searches'\]|t\('\{n\} web searches', \{ n: byKind\.search \}\)/.test(cv + read('src/lib/chat-run-summary.js')));
  const cm = read('src/codex-message-manager.js');
  ok('the codex normalizer renders through the same PURE module', /require\('\.\/search-card'\)/.test(cm) && /renderSearchOutput\(\{ query, action, results: event\.results, error: event\.error \}\)/.test(cm));
  ok("the 0.153.4 carrier (event_msg item_completed Extension web.search) is dispatched BEFORE the generic item_completed skip into the same web-search path", /if \(type === 'item_completed'\) return this\._processItemCompleted\(event, emit\);/.test(cm) && /it\.kind === 'web\.search'[\s\S]{0,200}_processWebSearchEvent\(\{ type: 'web_search_end', call_id: it\.id/.test(cm));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
