#!/usr/bin/env node
// Run-fold UX (2.369.37, owner report on a claude window): the fold summary
// read "9 条 Bash · 1 次 MCP · 1 ✗" over a run whose only non-Bash card was a
// ToolSearch — the classifier lumped tool-schema lookups into 'mcp' and the
// label CLAIMED an MCP call that never happened; and an expanded run taller
// than a screen was indistinguishable from loose cards, with re-collapsing a
// scroll-up hunt for the summary line.
//   Part 1 (node, DOM-free): the PURE classifier + summary composer in
//     src/lib/chat-run-summary.js — ToolSearch is 'lookup' (folds under the
//     MCP toggle, labelled "N tool lookups"), the MCP count + "(server)"
//     suffix cover only mcp__server__tool calls, every kind the classifier
//     returns has a summary line (the 2.369.34 NaN class, now structural).
//   Part 2 (headless chrome, SKIPs without chrome): a throwaway worktree
//     server + a synthetic transcript with one long tool run. Expanding marks
//     members with the rail classes + inserts the footer; scrolling past the
//     header shows the floating bar with the run's label; clicking it
//     collapses WITHOUT a scroll jump (header lands within ±8px of the
//     viewport top); the footer collapses and lands the header the same way;
//     the footer exists only while expanded; the bar hides while the header
//     is on screen (negative control) and "jump to top" keeps the run open.
// Run: node scripts/test-fold-ux.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, passed = 0;
const check = (n, c, e) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 400) : ''}`); } };
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Part 1: pure classifier + summary composer ──────────────────────────────
const S = await import(path.join(repo, 'src/lib/chat-run-summary.js'));
const t = (k, p) => k.replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? String(p[x]) : m));
const tool = (toolName, input = {}, extra = {}) => ({ role: 'assistant', content: [{ type: 'tool_use', toolName, input }], ...extra });
const kindOf = (m, opts = {}) => S.messageKind(m, { toolCard: true, ...opts });

check('ToolSearch classifies as lookup (NOT mcp)', kindOf(tool('ToolSearch', { query: 'select:Read' })) === 'lookup');
check('mcp__server__tool classifies as mcp', kindOf(tool('mcp__chrome-devtools__click')) === 'mcp');
check('lookup folds under the MCP toggle (no new checkbox; customised kind lists keep folding what they fold today)', S.foldToggleFor('lookup') === 'mcp' && S.foldToggleFor('bash') === 'bash' && S.foldToggleFor('mcp') === 'mcp');
check('claude name map: Bash/Grep/Read/Edit/WebSearch/Skill/Agent/image-Read', kindOf(tool('Bash')) === 'bash' && kindOf(tool('Grep')) === 'read' && kindOf(tool('Read', { file_path: '/a/b.js' })) === 'read'
  && kindOf(tool('Edit', { file_path: '/a/b.js' })) === 'write' && kindOf(tool('WebSearch')) === 'search' && kindOf(tool('Skill')) === 'skill' && kindOf(tool('Agent')) === 'agent'
  && kindOf(tool('Read', { file_path: '/shots/x.PNG' })) === 'image');
check('semantic collapseKind hint wins (codex exec → bash) and memory paths override read/write hints', kindOf(tool('exec', {}, { collapseKind: 'bash' })) === 'bash'
  && kindOf(tool('Patch', { file_path: '/home/u/.claude/projects/x/memory/MEMORY.md' }, { collapseKind: 'write' }), { isMemoryPath: (fp) => /\/memory\//.test(fp) }) === 'memory');
check('unknown tool → null (breaks the run — every new tool name needs a kind); pure thinking → thinking; text → null',
  kindOf(tool('SomethingNew')) === null && S.messageKind({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] }, { toolCard: false }) === 'thinking'
  && S.messageKind({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, { toolCard: false }) === null);

// the owner's run: 9 Bash (one failed) + 1 ToolSearch
const ownerKinds = [...Array(9).fill('bash'), 'lookup'];
const ownerLabel = S.runSummaryLabel({ byKind: S.countKinds(ownerKinds), mcpServers: new Set(), nErr: 1 }, t);
check('owner run label = "9 Bash · 1 tool lookups · 1 ✗" (no MCP claimed)', ownerLabel === '9 Bash · 1 tool lookups · 1 ✗', ownerLabel);
check('the MCP line + "(server)" suffix cover ONLY real MCP calls', S.runSummaryParts(S.countKinds(['mcp', 'mcp']), new Set(['chrome-devtools']), t).join(' · ') === '2 MCP (chrome-devtools)'
  && S.runSummaryParts(S.countKinds(['mcp', 'mcp']), new Set(['a', 'b']), t).join(' · ') === '2 MCP'
  && S.runSummaryParts(S.countKinds(['mcp', 'lookup']), new Set(['x']), t).join(' · ') === '1 MCP (x) · 1 tool lookups');
check('every kind the classifier can return has a summary line entry (the 2.369.34 NaN class, structural)', S.RUN_KINDS.every((k) => S.SUMMARY_ORDER.some(([kk]) => kk === k)));
check('countKinds zero-fills every kind and still counts an unlisted one (never NaN)', (() => {
  const c = S.countKinds(['lookup', 'bash', 'bash', null, 'brandnew']);
  return S.RUN_KINDS.every((k) => Number.isFinite(c[k])) && c.lookup === 1 && c.bash === 2 && c.brandnew === 1 && c.mcp === 0;
})());
check('files/errors/running composition', S.runSummaryLabel({ byKind: S.countKinds(['read', 'read']), files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], running: true }, t) === '2 file reads — a.js, b.js, c.js, d.js, +1 · running…');
check('mcpParts splits mcp__server__tool and rejects the rest', JSON.stringify(S.mcpParts('mcp__a__b_c')) === '{"server":"a","tool":"b_c"}' && S.mcpParts('Bash') === null && S.mcpParts('') === null);
check('the pure module imports nothing (DOM-free by construction)', !/^\s*import /m.test(read('src/lib/chat-run-summary.js')));

// ── wiring pins (a pure fix with an unstaged call site is dead: the 2.355.0 lesson) ──
const cv = read('src/lib/chat-view.js');
check('chat-view imports the classifier + composer from chat-run-summary.js', /import \{ mcpParts, messageKind, foldToggleFor, countKinds, runSummaryLabel \} from '\.\/chat-run-summary\.js';/.test(cv));
check('chat-view builds the label ONLY through runSummaryLabel (no inline per-kind t() lines left)', /runSummaryLabel\(\{ byKind, mcpServers, files, nErr, running \}, t\)/.test(cv) && !cv.includes("t('{n} MCP'") && !cv.includes("t('{n} Bash'"));
check('memberKind delegates to messageKind; folding gates on foldToggleFor', /messageKind\(el\._rawMsg, \{ toolCard: el\.classList\.contains\('chat-msg-tool-result'\), isMemoryPath \}\)/.test(cv) && /kinds\.has\(foldToggleFor\(mk\)\)/.test(cv));
check('chat-renderers re-exports the ONE mcpParts from the pure module', /import \{ mcpParts \} from '\.\/chat-run-summary\.js';/.test(read('src/lib/chat-renderers.js')) && /export \{ mcpParts \};/.test(read('src/lib/chat-renderers.js')));
// legibility affordances
check('expanded members carry the rail classes; collapsed runs carry none (one _setRunOpen writer)', /el\.classList\.toggle\('chat-run-member', run\.open\);/.test(cv) && /el\.classList\.toggle\('chat-run-first', run\.open && i === 0\);/.test(cv) && /el\.classList\.toggle\('chat-run-last', run\.open && i === n - 1\);/.test(cv));
check('the footer is a non-.chat-msg list child removed by every runs pass with the headers', /querySelectorAll\(':scope > \.chat-run-header, :scope > \.chat-run-footer'\)\.forEach\(\(h\) => h\.remove\(\)\);/.test(cv) && /f\.className = 'chat-run-footer';/.test(cv));
check('trims still count .chat-msg only (header/footer invisible to the window accounting)', (cv.match(/querySelectorAll\('\.chat-msg:not\(\.chat-gap-msg\)'\)/g) || []).length >= 2);
check('the floating bar lives on the .chat-view container, never in the list', /bar\.className = 'chat-run-bar hidden';[\s\S]{0,900}this\._container\.appendChild\(bar\);/.test(cv) && !/_messageList\.appendChild\(bar\)/.test(cv));
check('bar state is computed in the scroll rAF with the frame\'s already-read scrollTop, BEFORE the programmatic-scroll early return', /const \{ scrollTop, scrollHeight, clientHeight \} = this\._messageList;\n[^\n]*\n\s*this\._updateRunBar\(scrollTop\);\n\s*if \(this\._programmaticScroll\) return;/.test(cv));
const barBody = cv.slice(cv.indexOf('  _updateRunBar(scrollTop) {'), cv.indexOf('  dispose() {'));
check('_updateRunBar never pages/trims/pins (no _extendTop/_extendBottom/_trim*/_pinned writes)', barBody.length > 100 && !/_extendTop|_extendBottom|_trimTop|_trimBottom|_pinned =/.test(barBody));
check('_setRunOpen hides its OWN footer mutation from the observer when called outside a pass (a user click is not a pass — the record used to schedule the pass that closed the run)',
  /const outsidePass = !this\._runsMutating;/.test(cv) && /if \(outsidePass\) this\._runsMutating = true;/.test(cv) && /if \(mutated\) this\._runsObserver\?\.takeRecords\(\);/.test(cv));
check('the pinned auto-refold still folds every non-last run EXCEPT one the user opened deliberately (_runStickyOpen, keyed by member like _runExpanded)',
  /this\._runStickyOpen = new WeakSet\(\);/.test(cv) && /for \(const r of built\.slice\(0, -1\)\) \{/.test(cv)
  && /if \(r\.members\.some\(\(el\) => this\._runStickyOpen\.has\(el\)\)\) continue;/.test(cv)
  && /const isLast = this\._runs\?\.length \? this\._runs\[this\._runs\.length - 1\] === run : false;/.test(cv));
check('collapse-from-bar/footer lands ABSOLUTELY on the header under the programmatic-scroll mute', /_landOnHeader\(run\) \{[\s\S]{0,700}this\._programmaticScroll = true;[\s\S]{0,400}list\.scrollTop = run\.header\.offsetTop;/.test(cv) && /_collapseRunTo\(run\) \{[\s\S]{0,200}this\._setRunOpen\(run, false\);\s*this\._landOnHeader\(run\);/.test(cv));
const suspendBody = cv.slice(cv.indexOf('  setSuspended(on) {'), cv.indexOf('  async _extendTop('));
check('suspend hides the bar; resume + every runs pass re-schedule it; dispose cancels the rAF', /if \(on\) this\._updateRunBar\(0\);/.test(suspendBody) && /this\._lastStructuralAt = Date\.now\(\);\n\s*this\._scheduleRunBar\(\);/.test(suspendBody) && /this\._runsObserver\?\.takeRecords\(\);\n\s*this\._scheduleRunBar\(\);/.test(cv) && /cancelAnimationFrame\(this\._runBarRaf\)/.test(cv));
check('_withViewportAnchor + the seek gap anchor skip run chrome (header/footer are rebuilt by the pass = dead anchors)', /const runChrome = \(c\) => c\.classList\.contains\('chat-run-header'\) \|\| c\.classList\.contains\('chat-run-footer'\);/.test(cv)
  && /chat-run-header'\) \|\| gapA\.classList\?\.contains\('chat-run-footer'\)/.test(read('src/lib/chat-view-seek.js')));
check('no Esc binding for the run chrome (data-popover owns Esc)', !/Escape/.test(barBody) && !/key === 'Escape'[\s\S]{0,200}chat-run/.test(cv));
const css = read('public/chat.css');
check('chat.css: rail on members in BOTH role-indicator families, footer + bar styled with theme vars only', /\.chat-msg\.chat-run-member \{/.test(css) && /\[data-role-indicator="border"\] \.chat-msg\.chat-run-member \{/.test(css)
  && /\.chat-run-footer \{/.test(css) && /\.chat-run-bar \{/.test(css) && /\.chat-run-bar\.hidden \{ display: none; \}/.test(css)
  && !/chat-run-(member|footer|bar)[^}]*#[0-9a-f]{3,6}/i.test(css.slice(css.indexOf('Expanded-run legibility'))));
check('the history-load pill is positioned by the STYLESHEET (an inline top beats every selector) and drops below the bar with the position pill',
  !/chat-history-status';\n\s*el\.style\.cssText/.test(cv) && /\.chat-history-status \{\n\s*position: absolute; top: 6px;/.test(css)
  && /\.chat-view\.chat-run-bar-on \.chat-pos-indicator,\n\.chat-view\.chat-run-bar-on \.chat-history-status \{ top: 34px; \}/.test(css));
check('icons: SVG chevron + arrow-up-to-line in icons.js (no emoji)', /chevronUp:\s+_s\(/.test(read('src/lib/icons.js')) && /arrowUpToLine:\s+_s\(/.test(read('src/lib/icons.js')));
for (const f of ['src/lib/i18n-zh.js', 'src/lib/i18n-ja.js']) {
  const d = read(f);
  check(`${path.basename(f)} carries the new keys`, ['"{n} tool lookups":', '"Collapse":', '"Collapse run":', '"Jump to top of run":'].every((k) => d.includes(k)));
}

// ── Part 2: headless chrome over a real view-only ChatView ──────────────────
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log(`  SKIP: no chrome/chromium — browser half not run`);
  console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
}
const PORT = 3951 + (process.pid % 20), CDP_PORT = 9351 + (process.pid % 20);
const wt = `/tmp/vs-foldux-${process.pid}`;
const fakeHome = `${wt}-home`;
const CWD = `${wt}-cwd`;
const SID = 'f01d0000-0000-4000-8000-00000000ffee';
// 28 Bash + 1 ToolSearch = a run taller than the window; 8 tall text turns
// AFTER it so the header can land at the viewport top once the run collapses
// (with nothing below, scrollTop just clamps to 0), then a SHORT mcp run after
// the last text turn. TWO runs is not decoration: the pinned auto-refold only
// exists when built.length > 1 and its `built.slice(0, -1)` shape closes every
// run except the LAST — with a single-run fixture the whole branch (and the
// 2026-09-06 open-then-refold bug under it) was unreachable while 51 asserts
// stayed green. Total 50 = exactly the initial tail window, so the whole
// transcript renders without paging.
const NBASH = 28, NTAIL = 8, NMCP = 2;
{
  const lines = [];
  let ts0 = Date.now() - 3600e3;
  const ts = () => new Date((ts0 += 5e3)).toISOString();
  let n = 0;
  const push = (o) => lines.push(JSON.stringify(o));
  const FAT = 'a fat line of tool output that adds real rendered height 0123456789\n';
  push({ type: 'user', message: { role: 'user', content: 'please do the thing' }, uuid: `u-${n++}`, timestamp: ts() });
  push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'On it.' }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `a-${n++}`, timestamp: ts() });
  for (let b = 0; b < NBASH; b++) {
    const tid = `toolu_b${b}`;
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: `echo step ${b}` } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: b === 3, content: `output ${b}\n` + FAT.repeat(12) }] }, uuid: `tr-${n++}`, timestamp: ts() });
  }
  push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 'toolu_ts', name: 'ToolSearch', input: { query: 'select:Read', max_results: 1 } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ts', content: '<functions>…</functions>' }] }, uuid: `tr-${n++}`, timestamp: ts() });
  push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'All done.' }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `af-${n++}`, timestamp: ts() });
  const PROSE = 'line of explanatory prose that wraps around and adds real rendered height\n'.repeat(14);
  for (let k = 0; k < NTAIL; k++) {
    push({ type: 'user', message: { role: 'user', content: `follow-up ${k}` }, uuid: `u-${n++}`, timestamp: ts() });
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `reply ${k}:\n${PROSE}` }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `af-${n++}`, timestamp: ts() });
  }
  // run 2 — a short mcp run after the last text turn (the LAST run: the one
  // the pinned auto-refold deliberately spares)
  for (let m = 0; m < NMCP; m++) {
    const tid = `toolu_m${m}`;
    push({ type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: tid, name: 'mcp__chrome-devtools__click', input: { uid: `e${m}` } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `clicked ${m}\n` }] }, uuid: `tr-${n++}`, timestamp: ts() });
  }
  const proj = path.join(fakeHome, '.claude', 'projects', CWD.replace(/[/._]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines.join('\n') + '\n');
}

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// NO rebuild (the gate-admission diet): overlay the ALREADY-BUILT public/ —
// the gate's step 1 built it; standalone runs test the last `npm run build`.
for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  for (const d of [`${wt}-chrome`, fakeHome, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('✗ chrome never exposed a CDP page target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map(); const pageErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') { try { pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown'); } catch {} }
});
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 100; i++) { if (await evaljs('!!(window.app && window.app.ready && window.app.wm)').catch(() => false)) break; await sleep(300); }
await evaljs('window.app.ready.then(() => true)').catch(() => {});
await sleep(1200);

// open the view-only chat and wait for the fold header
const opened = await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.app.viewSession('${SID}', '${CWD}', 'fold ux');
  let list = null, header = null;
  for (let i = 0; i < 80; i++) {
    list = document.querySelector('.chat-message-list');
    header = list && list.querySelector(':scope > .chat-run-header');
    if (header) break;
    await sleep(250);
  }
  for (let i = 0; i < 40 && list.querySelectorAll(':scope > .chat-run-header').length < 2; i++) await sleep(150);
  if (!header) return { ok: false, n: list ? list.querySelectorAll('.chat-msg').length : -1 };
  await sleep(900); // fold settle + initial pin
  window.__list = list;
  const view = document.querySelector('.chat-view');
  return { ok: true, n: list.querySelectorAll(':scope > .chat-msg').length, headers: list.querySelectorAll(':scope > .chat-run-header').length,
    label: header.textContent.trim(), ch: list.clientHeight, sh: list.scrollHeight, cv: !!view };
})()`);
check('view-only chat rendered with TWO fold headers (the long tool run + the short mcp run)', opened?.ok && opened.headers === 2, JSON.stringify(opened));
check(`header label = "${NBASH} Bash · 1 tool lookups · 1 ✗" — the ToolSearch is a tool lookup, never MCP (got: ${opened?.label})`, (opened?.label || '').replace(/^▸\s*/, '') === `${NBASH} Bash · 1 tool lookups · 1 ✗`);

const state = () => evaljs(`(() => {
  const list = window.__list; const view = document.querySelector('.chat-view');
  const header = list.querySelector(':scope > .chat-run-header');
  const bar = view.querySelector('.chat-run-bar');
  const members = [...list.querySelectorAll(':scope > .chat-msg.chat-run-member')];
  return {
    open: header?.classList.contains('open') || false,
    members: members.length,
    first: members[0]?.classList.contains('chat-run-first') || false,
    last: members[members.length - 1]?.classList.contains('chat-run-last') || false,
    firstIsCard: members[0]?.classList.contains('chat-msg-tool-result') || false,
    collapsed: list.querySelectorAll(':scope > .chat-msg.chat-run-collapsed').length,
    footers: list.querySelectorAll(':scope > .chat-run-footer').length,
    footerText: list.querySelector(':scope > .chat-run-footer')?.textContent.trim() || '',
    footerIsMsg: !!list.querySelector(':scope > .chat-run-footer.chat-msg'),
    barShown: !!bar && !bar.classList.contains('hidden'),
    barLabel: bar?.querySelector('.chat-run-bar-label')?.textContent || '',
    barInList: !!list.querySelector('.chat-run-bar'),
    barTop: bar ? bar.offsetTop : -1, listTop: list.offsetTop,
    headerTop: header ? header.offsetTop : -1, st: list.scrollTop, sh: list.scrollHeight, ch: list.clientHeight,
    label: header?.textContent.trim() || '',
    msgs: list.querySelectorAll(':scope > .chat-msg').length,
  };
})()`);
const scrollTo = async (expr, waitMs = 120) => evaljs(`(async () => {
  const list = window.__list; const header = list.querySelector(':scope > .chat-run-header');
  list.scrollTop = ${expr}; list.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, ${waitMs}));
  return list.scrollTop;
})()`);
const click = async (sel, waitMs = 120) => evaljs(`(async () => {
  const el = document.querySelector('.chat-view ' + ${JSON.stringify(sel)});
  if (!el) return false;
  el.click();
  await new Promise((r) => setTimeout(r, ${waitMs}));
  return true;
})()`);

// collapsed: nothing of the expanded chrome
const s0 = await state();
check('collapsed run: no rail classes, no footer, no bar', !s0.open && s0.members === 0 && s0.footers === 0 && !s0.barShown && s0.collapsed === NBASH + 1 + NMCP, JSON.stringify(s0));
check('the list stays FLAT (members are direct .chat-msg children; footer/bar are not .chat-msg)', s0.msgs > NBASH && !s0.footerIsMsg && !s0.barInList);

// expand via the header
await click('.chat-run-header', 400);
const s1 = await state();
check(`expanded: every member carries .chat-run-member (${s1.members}/${NBASH + 1}), first/last marked`, s1.open && s1.members === NBASH + 1 && s1.first && s1.last && s1.firstIsCard && s1.collapsed === NMCP, JSON.stringify(s1));
check('expanded: the footer exists (non-.chat-msg) and reads "Collapse · <label>"', s1.footers === 1 && !s1.footerIsMsg && /^Collapse · /.test(s1.footerText) && s1.footerText.includes('tool lookups'), s1.footerText);
check('expanded run is taller than the viewport (the reported situation)', s1.sh > s1.ch * 1.5, `sh=${s1.sh} ch=${s1.ch}`);
check('header on screen ⇒ no floating bar (negative control)', (() => { const headerVisible = s1.headerTop >= s1.st && s1.headerTop < s1.st + s1.ch; return !headerVisible || !s1.barShown; })(), JSON.stringify(s1));

// scroll past the header → the bar shows with the run's label, pinned to the list's top edge
await scrollTo('header.offsetTop + Math.round(list.clientHeight * 0.8)', 150);
const s2 = await state();
check('header scrolled above the viewport ⇒ floating bar shown with the run label', s2.barShown && s2.barLabel === s2.label.replace(/^▸\s*/, '') && s2.headerTop < s2.st, JSON.stringify({ shown: s2.barShown, barLabel: s2.barLabel, label: s2.label, headerTop: s2.headerTop, st: s2.st }));
check('the bar sits on the container at the message list\'s top edge', !s2.barInList && Math.abs(s2.barTop - s2.listTop) <= 1, `barTop=${s2.barTop} listTop=${s2.listTop}`);

// "jump to top of run" keeps the run open and lands the header at the top
await click('.chat-run-bar-top', 150);
const s3 = await state();
check('jump-to-top: run stays expanded, header lands within ±8px of the viewport top, bar hides', s3.open && s3.members === NBASH + 1 && Math.abs(s3.headerTop - s3.st) <= 8 && !s3.barShown, JSON.stringify({ open: s3.open, d: s3.headerTop - s3.st, bar: s3.barShown }));

// scroll past again, then collapse FROM THE BAR — no scroll jump beyond ±8px of the header
await scrollTo('header.offsetTop + Math.round(list.clientHeight * 1.2)', 150);
const s4 = await state();
check('bar shown again after scrolling past the header', s4.barShown, JSON.stringify(s4));
await click('.chat-run-bar', 80);
const s5 = await state();
check('bar click collapses the run: rail classes gone, footer gone, header closed', !s5.open && s5.members === 0 && s5.footers === 0 && s5.collapsed === NBASH + 1 + NMCP, JSON.stringify(s5));
check('fixture sanity: after the collapse the list can still scroll far enough to put the header at the top (else the landing would be unobservable)', s5.sh - s5.ch >= s5.headerTop, `sh=${s5.sh} ch=${s5.ch} headerTop=${s5.headerTop}`);
check('…and the viewport lands on the header (within ±8px), bar hidden', Math.abs(s5.headerTop - s5.st) <= 8 && !s5.barShown, `headerTop=${s5.headerTop} st=${s5.st}`);
await sleep(500); // the footer removal is a childList mutation → a debounced runs pass rebuilds the header
const s6 = await state();
check('after the observer pass: still collapsed, header still within ±8px (no late jump)', !s6.open && s6.footers === 0 && Math.abs(s6.headerTop - s6.st) <= 8, `headerTop=${s6.headerTop} st=${s6.st} open=${s6.open}`);

// expand again → scroll to the footer → collapse from the footer line
await click('.chat-run-header', 400);
const s7 = await state();
check('re-expanded: footer back, rail back', s7.open && s7.footers === 1 && s7.members === NBASH + 1, JSON.stringify(s7));
await scrollTo('list.scrollHeight', 150);
await click('.chat-run-footer', 80);
const s8 = await state();
check('footer click collapses and scrolls the header into view (±8px); footer gone', !s8.open && s8.footers === 0 && Math.abs(s8.headerTop - s8.st) <= 8, `headerTop=${s8.headerTop} st=${s8.st} open=${s8.open}`);
await sleep(400);
const s9 = await state();
check('footer exists ONLY while expanded (still absent after the rebuild pass)', s9.footers === 0 && !s9.open && s9.members === 0);
// ── PINNED + TWO runs: a user-opened run must survive the pass its own toggle
//    causes (2026-09-06 refutation, measured on this fixture's parent: clicking
//    any run header except the last, while pinned, opened the run and closed it
//    again ~180ms later — _setRunOpen's footer insert is a childList mutation
//    OUTSIDE a pass, so the observer scheduled one, and the pinned auto-refold
//    (`built.slice(0, -1)`) closed exactly the run the click had opened). ──
const chatView = (body) => evaljs(`(async () => {
  const list = window.__list;
  const cv = [...window.app.sessions.values()].find((s) => s && s._messageList === list);
  if (!cv) return { err: 'no ChatView for the list' };
  ${body}
})()`);
const runsState = () => chatView(`
  const heads = [...list.querySelectorAll(':scope > .chat-run-header')];
  return { pinned: !!cv._pinned, runs: cv._runs?.length || 0, heads: heads.length,
    open: heads.map((h) => h.classList.contains('open')),
    footers: list.querySelectorAll(':scope > .chat-run-footer').length,
    members: list.querySelectorAll(':scope > .chat-msg.chat-run-member').length };`);

// pin at the live tail (bottom-follow owns the scroll there — the state the
// auto-refold exists for)
await chatView(`list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 300)); return 1;`);
const p0 = await runsState();
check('fixture: TWO runs built and the view is PINNED at the tail (the auto-refold branch is now reachable)', p0.runs === 2 && p0.heads === 2 && p0.pinned && !p0.open[0] && !p0.open[1], JSON.stringify(p0));

// expand the FIRST (non-last) run — the case the auto-refold used to eat
await click('.chat-run-header', 600);
const p1 = await runsState();
check('PINNED: expanding the FIRST run is still open 600ms later (past the 180ms observer debounce) with its footer', p1.open[0] && p1.footers === 1 && p1.members === NBASH + 1, JSON.stringify(p1));
// …and through an explicit pass (what a live append/trim would trigger)
const p2 = await chatView(`cv._updateRuns(); await new Promise((r) => setTimeout(r, 250));
  const heads = [...list.querySelectorAll(':scope > .chat-run-header')];
  return { pinned: !!cv._pinned, open: heads.map((h) => h.classList.contains('open')), footers: list.querySelectorAll(':scope > .chat-run-footer').length, runs: cv._runs.length };`);
check('PINNED: a full runs pass does NOT re-collapse the run the user opened (the deliberate toggle beats the heuristic)', p2.pinned && p2.open[0] && p2.footers === 1 && p2.runs === 2, JSON.stringify(p2));

// the LAST run's behaviour is unchanged (it was always excluded by slice(0,-1))
await chatView(`list.querySelectorAll(':scope > .chat-run-header')[1].click(); await new Promise((r) => setTimeout(r, 600)); return 1;`);
const p3 = await runsState();
check('PINNED: the LAST run still expands and stays open (unchanged), both runs open at once', p3.open[0] && p3.open[1] && p3.footers === 2 && p3.members === NBASH + 1 + NMCP, JSON.stringify(p3));
const p4 = await chatView(`cv._updateRuns(); await new Promise((r) => setTimeout(r, 250));
  const heads = [...list.querySelectorAll(':scope > .chat-run-header')];
  return { open: heads.map((h) => h.classList.contains('open')), footers: list.querySelectorAll(':scope > .chat-run-footer').length };`);
check('PINNED: both survive the next pass', p4.open[0] && p4.open[1] && p4.footers === 2, JSON.stringify(p4));

// NEGATIVE CONTROL — the 2.227.x invariant the auto-refold exists for: an
// INHERITED open flag (a run that was the live tail when it was opened and
// then stopped being last) is still re-folded while pinned. Dropping the
// user-intent mark leaves exactly that state.
const p5 = await chatView(`
  list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 250));
  const pinnedBefore = !!cv._pinned;             // the flag the branch reads
  cv._runStickyOpen = new WeakSet();             // …leaving only the inherited flag
  cv._updateRuns();
  await new Promise((r) => setTimeout(r, 250));
  const heads = [...list.querySelectorAll(':scope > .chat-run-header')];
  return { pinnedBefore, open: heads.map((h) => h.classList.contains('open')), footers: list.querySelectorAll(':scope > .chat-run-footer').length };`);
check('negative control: without the user-intent mark the pinned auto-refold still folds every non-last run (2.227.x "一部分没折叠" holds)', p5.pinnedBefore && !p5.open[0] && p5.open[1] && p5.footers === 1, JSON.stringify(p5));

// the history-load pill must not land ON the floating bar (both are absolutely
// positioned .chat-view children; the pill used to carry an inline top:6px that
// no stylesheet rule could push aside)
const p6 = await chatView(`
  cv._runStickyOpen = new WeakSet();
  const h0 = list.querySelector(':scope > .chat-run-header');
  if (!h0.classList.contains('open')) h0.click();
  await new Promise((r) => setTimeout(r, 400));
  list.scrollTop = h0.offsetTop + Math.round(list.clientHeight * 0.8); list.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 200));
  cv._showHistoryStatus('Loading history…', { spinner: true, kind: 'loading' });
  await new Promise((r) => setTimeout(r, 120));
  const view = document.querySelector('.chat-view');
  const bar = view.querySelector('.chat-run-bar'), pill = view.querySelector('.chat-history-status');
  const r = { barShown: !!bar && !bar.classList.contains('hidden'), barBottom: bar ? bar.offsetTop + bar.offsetHeight : -1,
    pillTop: pill ? pill.offsetTop : -1, pillInline: pill ? (pill.style.top || '') : 'none' };
  cv._hideHistoryStatus();
  return r;`);
check('the history-load pill sits BELOW the floating run bar (no inline top left to beat the stylesheet)', p6.barShown && p6.pillTop >= p6.barBottom && p6.pillInline === '', JSON.stringify(p6));

check('zero uncaught page exceptions during the whole flow', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

ws.close();
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
