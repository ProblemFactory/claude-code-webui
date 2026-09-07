#!/usr/bin/env node
// THE claude INIT FRAME, WIDENED + `commands_changed` (design-harness-features
// §2.6). Before this, `_processSystem` kept three fields of the frame (model /
// permissionMode / slash_commands) and dropped the rest — so:
//   · a FAILED MCP server was invisible (its tools simply did not exist, and
//     nothing said why; this instance's own live sessions carry such servers),
//   · terminal-bound commands (/doctor, /color) sat in the chat composer's
//     completion doing nothing when picked,
//   · agent-memory classification ran on a HARDCODED regex while the frame
//     names the directories (upstream's stated reason for the field),
//   · a mid-session `commands_changed` push was dropped entirely, so the
//     command list went stale for the rest of the session.
//
// Part 1 (node): the SCHEMA PIN (every field name we read is re-grepped out of
//   the installed 2.1.257 binary's own zod schema — dumped, never guessed;
//   explicit SKIP with evidence when no binary is installed), the normalizer
//   over the real fixture frame (ops, REPLACE semantics, degradation on an old
//   CLI), the pure client rules (completion filter / health strip / memory
//   paths) and the chatStatus attach twin.
// Part 2 (headless chrome, SKIPs without chrome): the real ChatRenderers in a
//   real document — the health strip is in the ALWAYS-VISIBLE summary, the
//   inventory is behind the <details>, an old-CLI frame renders NOTHING, and
//   the 375×667 measurement (nothing overflows sideways).
// Run: node scripts/test-init-frame.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e !== undefined ? '\n    ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : '')); } };
const skip = (n, why) => { skipped++; console.log(`  SKIP ${n} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FRAME = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/claude-init-frame.json'), 'utf8'));
const { MessageManager, initFrameFacts, commandNames } = require(path.join(REPO, 'src/message-manager.js'));
const AM = await import(path.join(REPO, 'src/lib/agent-meta.js'));

// ── 1. SCHEMA PIN: the field names come from the binary, not from us ────────
console.log('— schema pin (2.1.257 zod, dumped)');
const CONSUMED = ['tools', 'mcp_servers', 'agents', 'skills', 'plugins', 'plugin_errors', 'plugin_warnings',
  'mcp_server_errors', 'terminal_slash_commands', 'output_style', 'memory_paths', 'betas', 'claude_code_version', 'slash_commands'];
let claudeBin = null;
try { claudeBin = fs.realpathSync(execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()); } catch { }
// A bounded window after a literal marker inside the (215MB, single-line)
// binary. `grep -o '<marker>.\{0,9000\}'` needs half a minute on a line that
// long — a streaming indexOf is ~200ms and is exactly as literal.
const binWindow = (file, marker, len) => {
  const fd = fs.openSync(file, 'r');
  try {
    const CH = 8 << 20, buf = Buffer.alloc(CH);
    let carry = '', out = null, pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CH, pos);
      if (!n) break;
      pos += n;
      const chunk = carry + buf.toString('latin1', 0, n);
      if (out !== null) out += chunk;
      else { const i = chunk.indexOf(marker); if (i >= 0) out = chunk.slice(i); }
      if (out !== null && out.length >= len) break;
      carry = chunk.slice(-Math.max(marker.length, 64));
    }
    return out ? out.slice(0, len) : '';
  } finally { fs.closeSync(fd); }
};
if (!claudeBin || !fs.existsSync(claudeBin)) {
  skip('every consumed init field exists in the CLI\'s own schema', 'no claude binary on this box (the fixture keys stand unverified here — a box with the CLI re-greps them)');
} else {
  const win = binWindow(claudeBin, 'subtype:I("init"),agents', 9000);
  if (!win) {
    skip('every consumed init field exists in the CLI\'s own schema', `the init schema window was not found in ${claudeBin} (upstream reshaped it — re-dump before trusting the reader)`);
  } else {
    const missing = CONSUMED.filter((f) => !win.includes(f + ':'));
    ok(`every consumed init field is in the installed CLI's zod schema (${path.basename(claudeBin)})`, missing.length === 0, missing.join(', '));
    ok('…the fixture invents no field the schema does not declare', Object.keys(FRAME).filter((k) => !k.startsWith('_') && !['type', 'subtype', 'uuid', 'session_id'].includes(k)).every((k) => win.includes(k + ':')),
      Object.keys(FRAME).filter((k) => !k.startsWith('_') && !win.includes(k + ':')).join(', '));
    ok('…NEGATIVE CONTROL: an invented field name is NOT in the schema window', !win.includes('memory_dirs:') && !win.includes('mcp_status:'));
    ok('…`terminal_slash_commands` carries upstream\'s own "Phone/remote UIs should hide these" reason (that is WHY we filter)', /Phone\/remote UIs should hide these/.test(win));
    ok('…`memory_paths` carries upstream\'s own "classify Read/Write/Edit tool calls on these paths as memory operations" reason', /classify Read\/Write\/Edit tool calls on these paths as memory operations/.test(win));
  }
  const cc = binWindow(claudeBin, 'commands_changed"),commands:', 600);
  ok('`commands_changed` is a full-list REPLACE push in the CLI\'s own words ("Clients should REPLACE their cached command list")', /REPLACE their cached command list/.test(cc), cc.slice(0, 200));
}

// ── 2. the normalizer over the REAL frame ──────────────────────────────────
console.log('— normalizer');
const runLive = (records) => {
  const mm = new MessageManager('sess-init');
  const ops = [];
  mm.onOp((op) => ops.push(op));
  for (const r of records) mm.processLive(r);
  return { mm, ops };
};
{
  const { mm, ops } = runLive([FRAME]);
  const init = ops.find((o) => o.op === 'create')?.message;
  const f = init?.content?.[0]?.initData?.frame;
  ok('the init frame still creates exactly one card + keeps the three old fields', ops.filter((o) => o.op === 'create').length === 1
    && init.content[0].initData.model === 'claude-fable-5' && init.content[0].initData.permissionMode === 'default'
    && init.content[0].initData.slashCommands.join(',') === FRAME.slash_commands.join(','), JSON.stringify(init?.content?.[0]?.initData || null).slice(0, 200));
  ok('…and now the WHOLE frame: tools/agents/skills/plugins/mcp servers/errors/output style/version/betas/memory paths/terminal commands', !!f
    && f.tools.length === FRAME.tools.length && f.agents.length === 3 && f.skills.length === 3
    && f.plugins[0].name === 'commit-commands' && f.plugins[0].version === '1.2.0'
    && f.mcpServers.length === 3 && f.mcpServers[1].status === 'failed'
    && f.pluginErrors[0].plugin === 'old-helper' && f.mcpServerErrors[0].name === 'notes' && f.pluginWarnings[0].plugin === 'commit-commands'
    && f.outputStyle === 'Explanatory' && f.version === '2.1.257' && f.betas[0] === 'context-1m'
    && f.memoryPaths.auto.endsWith('/memory') && f.memoryPaths.team.endsWith('/team-memory')
    && f.terminalSlashCommands.join(',') === 'doctor,color', JSON.stringify(f).slice(0, 400));
  const meta = ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
  ok('…the command list rides ONE meta op (the shape a mid-session push reuses), carrying the terminal subset', meta.length === 1
    && meta[0].data.commands.join(',') === FRAME.slash_commands.join(',') && meta[0].data.terminal.join(',') === 'doctor,color', JSON.stringify(meta[0]?.data));
  ok('…the card itself is unchanged for consumers that only read text/id (no id churn, status complete)', init.role === 'system' && init.status === 'complete' && init.content[0].text === 'Model: claude-fable-5');
  ok('history rebuild (convertHistory) keeps the same widened frame — the buffer replay a restarted window reads', (() => {
    const msgs = new MessageManager('sess-init').convertHistory([FRAME]);
    return msgs[0]?.content?.[0]?.initData?.frame?.mcpServers?.[1]?.status === 'failed';
  })());
}
{
  // OLD CLI: a frame that predates every widened field ⇒ nothing extra, no crash.
  const old = { type: 'system', subtype: 'init', model: 'claude-opus-4', permissionMode: 'default', slash_commands: ['compact'], session_id: 's', uuid: 'u-old' };
  const { ops } = runLive([old]);
  const f = ops[0].message.content[0].initData.frame;
  ok('DEGRADE: an old-CLI init frame yields only what it said (slashCommands) — absent keys stay ABSENT, never empty arrays that would read as "zero skills"',
    Object.keys(f).join(',') === 'slashCommands' && !('skills' in f) && !('mcpServers' in f) && !('memoryPaths' in f), JSON.stringify(f));
  ok('…and its command list still reaches the composer, with an EMPTY terminal subset (filters nothing)',
    ops.some((o) => o.op === 'meta' && o.subtype === 'slash-commands' && o.data.commands.join() === 'compact' && o.data.terminal.length === 0));
}
{
  // commands_changed: REPLACE, not append.
  const changed = {
    type: 'system', subtype: 'commands_changed', session_id: 's', uuid: 'u-cc',
    commands: [
      { name: 'compact', description: 'compact the conversation', argumentHint: '' },
      { name: 'doctor', description: 'diagnose', argumentHint: '' },
      { name: 'skill-just-discovered', description: 'new', argumentHint: '<file>', aliases: ['sjd'] },
    ],
  };
  const { mm, ops } = runLive([FRAME, changed]);
  const metas = ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
  ok('a mid-session commands_changed emits a SECOND command-list op…', metas.length === 2);
  ok('…whose list REPLACES wholesale: the new command is in, and every command the push omitted is GONE (an append would keep them)',
    metas[1].data.commands.join(',') === 'compact,doctor,skill-just-discovered'
    && !metas[1].data.commands.includes('model') && !metas[1].data.commands.includes('usage'), JSON.stringify(metas[1].data));
  ok('…the terminal subset survives (the push does not re-send it) but is INTERSECTED with the new list — "color" is gone upstream, so it is gone here',
    metas[1].data.terminal.join(',') === 'doctor', JSON.stringify(metas[1].data.terminal));
  ok('…and the init CARD is patched in place, so a window that rebuilds history sees the current list',
    ops.some((o) => o.op === 'edit') && mm.messages[0].content[0].initData.slashCommands.includes('skill-just-discovered'));
  ok('rich rows are read by NAME (the payload is {name,description,argumentHint,aliases?}, not strings like init\'s slash_commands)',
    commandNames(changed.commands).join(',') === 'compact,doctor,skill-just-discovered');
  ok('…a bare-string payload is still read (a producer that ever sends strings is not dropped), and a payload with NO array does nothing',
    commandNames(['a', 'b']).join(',') === 'a,b' && commandNames(undefined) === null && commandNames({}) === null);
  ok('an EMPTY commands array is a real answer (every command gone), not "say nothing"', (() => {
    const r = runLive([FRAME, { ...changed, commands: [] }]);
    const m = r.ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
    return m.length === 2 && m[1].data.commands.length === 0;
  })());
}
{
  // The breadcrumb must NOT fire for a subtype we now handle (2.227.5 rule).
  const prev = global.__vsEvent; const seen = [];
  global.__vsEvent = (k, d) => seen.push([k, d]);
  MessageManager._seenUnknownSubtypes?.clear?.();
  runLive([FRAME, { type: 'system', subtype: 'commands_changed', commands: [{ name: 'x' }], uuid: 'u1' }, { type: 'system', subtype: 'brand_new_thing', uuid: 'u2' }]);
  global.__vsEvent = prev;
  ok('commands_changed is a HANDLED subtype (no unknown-subtype breadcrumb), while a genuinely new subtype still trips it',
    !seen.some(([k, d]) => k === 'cli-unknown-system-subtype' && d === 'commands_changed')
    && seen.some(([k, d]) => k === 'cli-unknown-system-subtype' && d === 'brand_new_thing'), JSON.stringify(seen));
}

// ── 3. the pure client rules ───────────────────────────────────────────────
console.log('— pure client rules');
{
  const f = initFrameFacts(FRAME);
  const list = AM.slashCompletionList(f.slashCommands, f.terminalSlashCommands);
  ok('terminal-bound commands are FILTERED OUT of the composer completion (/doctor, /color are terminal UX — upstream says hide them)',
    !list.includes('/doctor') && !list.includes('/color') && list.includes('/compact') && list.includes('/model') && list.length === FRAME.slash_commands.length - 2, list.join(' '));
  ok('…every entry carries its slash exactly once, whichever spelling the caller passes',
    AM.slashCompletionList(['/compact', 'model'], []).join(',') === '/compact,/model');
  ok('…NEGATIVE CONTROL: with no terminal subset (old CLI / codex / ACP) nothing is filtered',
    AM.slashCompletionList(f.slashCommands, null).length === FRAME.slash_commands.length && AM.slashCompletionList(f.slashCommands, []).includes('/doctor'));

  const issues = AM.initHealthIssues(f);
  ok('the health strip names every server that is NOT connected, plus skipped configs and demoted plugins (3 here: failed + needs-auth + a config error + a plugin error)',
    issues.length === 4 && issues.filter((i) => i.kind === 'mcp-server').map((i) => `${i.name}/${i.detail}`).join(',') === 'github/failed,drive/needs-auth'
    && issues.some((i) => i.kind === 'mcp-config' && i.name === 'notes') && issues.some((i) => i.kind === 'plugin' && i.name === 'old-helper'), JSON.stringify(issues));
  ok('…the status vocabulary is OPEN: an unknown status is reported verbatim, never mapped away',
    AM.initHealthIssues({ mcpServers: [{ name: 'x', status: 'reconnecting-v2' }] })[0]?.detail === 'reconnecting-v2');
  ok('…NEGATIVE CONTROL: an all-connected frame with no error keys has NOTHING to report (and we never claim "all healthy" — an absent key is not a clean load)',
    AM.initHealthIssues({ mcpServers: [{ name: 'a', status: 'connected' }], skills: ['s'] }).length === 0 && AM.initHealthIssues(null).length === 0);

  AM._resetMemoryPaths();
  const custom = '/w/store/agent-memory/NOTES.md';
  ok('memory classification BEFORE the frame speaks: the hardcoded regex only (today\'s behaviour)',
    AM.isAgentMemoryPath('/h/.claude/projects/p/memory/M.md') && !AM.isAgentMemoryPath(custom));
  AM.noteMemoryPaths({ auto: '/w/store/agent-memory', team: '/w/proj/.claude/team-memory' });
  ok('…AFTER it: a directory the CLI NAMED classifies as memory (the regex could never know it), and the regex still covers the default dirs',
    AM.isAgentMemoryPath(custom) && AM.isAgentMemoryPath('/w/proj/.claude/team-memory/T.md') && AM.isAgentMemoryPath('/h/.claude/projects/p/memory/M.md'));
  ok('…a declared dir matches as a PATH PREFIX, not a string prefix (…/agent-memory must not swallow …/agent-memory-backup)',
    !AM.isAgentMemoryPath('/w/store/agent-memory-backup/N.md') && AM.isAgentMemoryPath('/w/store/agent-memory/sub/N.md'));
  AM._resetMemoryPaths();
}

// ── 4. the attach/HTTP twin (session-store chatStatus) ─────────────────────
console.log('— chatStatus twin (attach path)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-initframe-'));
  const cwd = path.join(tmp, 'proj');
  const sid = '11111111-2222-4333-8444-555555555555';
  const proj = path.join(tmp, '.claude', 'projects', cwd.replace(/[/._]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: ts }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 5, output_tokens: 2 } }, uuid: 'u2', timestamp: ts }),
  ].join('\n') + '\n');
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  const { SessionMessages } = require(path.join(REPO, 'src/session-store.js'));
  // init + a later commands_changed, as they really arrive: stdout-only
  // records in the session BUFFER, never in the JSONL.
  const buffer = [JSON.stringify({ ...FRAME, session_id: sid }),
    JSON.stringify({ type: 'system', subtype: 'commands_changed', session_id: sid, uuid: 'u-cc', commands: [{ name: 'compact' }, { name: 'doctor' }, { name: 'newly-found' }] })].join('\n');
  const st = new SessionMessages({ backend: 'claude', backendSessionId: sid, claudeSessionId: sid, cwd, buffer }, null, { buffersDir: path.join(tmp, 'buf'), permissionModes: [] }).chatStatus();
  process.env.HOME = prevHome;
  ok('a window that ATTACHES (or reloads) gets the same two facts as one that watched the push live: the CURRENT list + the terminal subset',
    st && st.slashCommands.join(',') === 'compact,doctor,newly-found' && st.initFrame?.terminalSlashCommands.join(',') === 'doctor', JSON.stringify({ sc: st?.slashCommands, tf: st?.initFrame?.terminalSlashCommands }));
  ok('…and the memory dirs + health facts, so a window whose init card is outside the loaded tail still classifies memory writes and can be told what is broken',
    st.initFrame?.memoryPaths?.auto?.endsWith('/memory') && AM.initHealthIssues(st.initFrame).length === 4, JSON.stringify(st.initFrame?.memoryPaths));
  ok('…the completion the composer would build from the attach payload hides the terminal commands too (ONE rule, both paths)',
    !AM.slashCompletionList(st.slashCommands, st.initFrame.terminalSlashCommands).includes('/doctor'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
}

// ── 5. wiring pins (the 2.331.0 lesson: a pure fix with no call site is dead) ──
console.log('— wiring pins');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const cv = read('src/lib/chat-view.js'), ci = read('src/lib/chat-input.js'), cr = read('src/lib/chat-renderers.js');
  ok("ChatView routes the 'slash-commands' meta op into the composer (an `edit` on the init card can NOT do this: a complete system card is never re-rendered, so its side effects never re-run)",
    /op\.subtype === 'slash-commands'/.test(cv) && /setSlashCommands\(op\.data\?\.commands \|\| \[\], \{ terminal: op\.data\?\.terminal \|\| null \}\)/.test(cv));
  ok('…the init card\'s side effect and the attach path both pass the terminal subset',
    /setSlashCommands\(se\.slashCommands, \{ terminal: se\.terminalSlashCommands \|\| null \}\)/.test(cv) && /setSlashCommands\(status\.slashCommands, \{ terminal: status\.initFrame\?\.terminalSlashCommands \|\| null \}\)/.test(cv));
  ok('…and both feed the frame-declared memory dirs to the classifier', (cv.match(/noteMemoryPaths\(/g) || []).length >= 2);
  ok('setSlashCommands REPLACES through the ONE pure rule (no local filtering twin)', /this\._slashCommands = slashCompletionList\(cmds, terminal\);/.test(ci));
  ok('the renderer builds the card from the frame and returns it (it used to return el:null unconditionally)', /return \{ el: this\.buildInitCard\(f\), sideEffect \};/.test(cr));
  for (const [file, what] of [['src/acp-message-manager.js', 'ACP available_commands_update'], ['src/codex-message-manager.js', 'codex wrapper_meta']]) {
    ok(`${what} emits the SAME meta op (one client path, no local/remote twin)`, /op: 'meta', subtype: 'slash-commands'/.test(read(file)));
  }
}

// ── 6. the card in a REAL browser + the 375×667 measurement ────────────────
console.log('— the card in chrome');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  skip('the init card in a real document (health strip visibility + 375×667)', 'no chrome/chromium on this box');
} else {
  const http = await import('node:http');
  const net = await import('node:net');
  const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
  const WebSocket = require('ws');
  const freePort = () => new Promise((res, rej) => { const sv = net.createServer(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const pt = sv.address().port; sv.close(() => res(pt)); }); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-initcard-${process.pid}-`));
  const stub = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'bv' })); b.onLoad({ filter: /.*/, namespace: 'bv' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
  const entry = path.join(tmp, 'entry.js');
  fs.writeFileSync(entry, `export { ChatRenderers } from ${JSON.stringify(path.join(REPO, 'src/lib/chat-renderers.js'))};\n`);
  const bundle = path.join(tmp, 'init.iife.js');
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', globalName: 'VS', platform: 'browser', target: 'es2022', outfile: bundle, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stub] });
  const js = fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(REPO, 'public/chat.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const base = fs.readFileSync(path.join(REPO, 'public/style.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>init card</title>`
    + `<style>${base}</style><style>${css}</style>`
    + `<style>html,body{margin:0;height:100%}#host{position:fixed;inset:0;display:flex;flex-direction:column}#list{flex:1;min-height:0;overflow:auto}</style>`
    + `<body><div id="host" class="chat-view"><div id="list" class="chat-message-list"></div></div><script>${js}</script>`;
  const port = await freePort(), cdpPort = await freePort();
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); }).listen(port, '127.0.0.1');
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${tmp}/chrome`, 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 120 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch { }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('chrome never exposed a CDP page target');
    ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    let seq = 0; const pend = new Map();
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evaljs = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      return r.result?.result?.value;
    };
    await cdp('Runtime.enable'); await cdp('Page.enable');
    const setViewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 768 });
    await setViewport(1280, 800);
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 80; i++) { if (await evaljs('!!(window.VS && window.VS.ChatRenderers)').catch(() => false)) break; await sleep(150); }

    // The REAL renderSystemMsg path over the REAL normalizer output — not a
    // hand-built element: the card, its side effect and the frame all have to
    // survive the same trip a live session takes.
    const mkFrame = JSON.stringify(FRAME);
    const render = async (frameJson) => evaljs(`(() => {
      const list = document.getElementById('list');
      list.innerHTML = '';
      const r = new VS.ChatRenderers({ sessionId: 'view-x', backend: 'claude', messageList: list });
      const msg = ${frameJson};
      const out = r.renderSystemMsg(msg);
      if (out.el) list.appendChild(out.el);
      const card = list.querySelector('.chat-msg-init');
      const summary = card && card.querySelector('.chat-init-summary');
      const warn = card && card.querySelector('.chat-init-warn');
      const details = card && card.querySelector('.chat-init-details');
      const cs = warn ? getComputedStyle(warn) : null;
      return {
        rendered: !!card,
        sideEffect: out.sideEffect,
        summaryText: summary ? summary.textContent.replace(/\\s+/g, ' ').trim() : '',
        warnText: warn ? warn.textContent.replace(/\\s+/g, ' ').trim() : '',
        warnVisible: !!(warn && cs.display !== 'none' && cs.visibility !== 'hidden' && warn.getBoundingClientRect().width > 0),
        warnInSummary: !!(warn && summary && summary.contains(warn)),
        detailsOpen: details ? details.open : null,
        bodyText: card ? (card.querySelector('.chat-init-body')?.textContent || '').replace(/\\s+/g, ' ').trim() : '',
        bodyHeight: card && card.querySelector('.chat-init-body') ? card.querySelector('.chat-init-body').getBoundingClientRect().height : -1,
        svgInWarn: !!(warn && warn.querySelector('svg')),
        rawHtml: card ? card.innerHTML : '',
      };
    })()`);
    // a normalized message, exactly as the normalizer builds it
    const norm = (frame) => {
      const mm = new MessageManager('sess-b');
      const msgs = mm.convertHistory([frame]);
      return JSON.stringify(msgs[0]);
    };
    const r1 = await render(norm(FRAME));
    ok('the widened frame renders a card (it used to render nothing at all)', r1.rendered, JSON.stringify(r1).slice(0, 300));
    ok('the HEALTH STRIP is in the always-visible summary and VISIBLE while the card is still collapsed — a dead MCP server behind a click would not fix the invisibility this exists for',
      r1.warnInSummary && r1.warnVisible && r1.detailsOpen === false && /4/.test(r1.warnText), JSON.stringify({ warn: r1.warnText, vis: r1.warnVisible, open: r1.detailsOpen }));
    ok('…its icon is an inline SVG from icons.js (never an emoji)', r1.svgInWarn && !/[\u{1F300}-\u{1FAFF}]/u.test(r1.rawHtml));
    ok('the summary answers "what is this session" at a glance: skills count + output style', /Session start/.test(r1.summaryText) && /3 skills/.test(r1.summaryText) && /Explanatory/.test(r1.summaryText), r1.summaryText);
    ok('the collapsed body is not taking vertical space, and holds the inventory + the per-issue detail lines', r1.bodyHeight === 0
      && /github \(failed\)/.test(r1.bodyText) && /dataviz/.test(r1.bodyText) && /commit-commands 1\.2\.0/.test(r1.bodyText) && /old-helper/.test(r1.bodyText) && /2\.1\.257/.test(r1.bodyText), JSON.stringify({ h: r1.bodyHeight, t: r1.bodyText.slice(0, 200) }));
    ok('the card\'s side effect still carries model/mode/commands, plus the terminal subset and the memory dirs the client needs',
      r1.sideEffect.model === 'claude-fable-5' && r1.sideEffect.permMode === 'default'
      && r1.sideEffect.terminalSlashCommands.join(',') === 'doctor,color' && !!r1.sideEffect.memoryPaths.auto, JSON.stringify(r1.sideEffect).slice(0, 300));
    // XSS: every value from the frame is peer-controlled text (a plugin name
    // reaches every client) — it must never become markup.
    const nasty = { ...FRAME, skills: ['<img src=x onerror=window.__pwned=1>'], plugins: [{ name: '"><script>window.__pwned=1</script>', path: '/p', source: 's' }] };
    const r2 = await render(norm(nasty));
    ok('XSS: frame text is escaped, never markup (a plugin/skill name syncs to every client)',
      (await evaljs('!window.__pwned')) && !/<img src=x/.test(r2.rawHtml) && /&lt;img src=x/.test(r2.rawHtml), r2.rawHtml.slice(0, 200));

    const old = { type: 'system', subtype: 'init', model: 'claude-opus-4', permissionMode: 'default', slash_commands: ['compact'], uuid: 'u-old' };
    const r3 = await render(norm(old));
    ok('NEGATIVE CONTROL: an old-CLI / codex / ACP init record renders NOTHING (today\'s behaviour is preserved exactly), yet still applies its side effect',
      r3.rendered === false && r3.sideEffect.model === 'claude-opus-4' && r3.sideEffect.slashCommands.join() === 'compact', JSON.stringify(r3).slice(0, 200));

    const healthy = { ...FRAME, mcp_servers: [{ name: 'a', status: 'connected' }], plugin_errors: undefined, mcp_server_errors: undefined };
    const r4 = await render(norm(healthy));
    ok('a healthy session gets the card WITHOUT a health strip (and no "all good" claim — an absent error key is not a clean load)',
      r4.rendered && !r4.warnText, JSON.stringify({ w: r4.warnText }));

    // ── ≤768px (375×667): the standing rule ──
    await setViewport(375, 667);
    await sleep(120);
    const m = await evaljs(`(() => {
      const list = document.getElementById('list');
      list.innerHTML = '';
      const r = new VS.ChatRenderers({ sessionId: 'view-x', backend: 'claude', messageList: list });
      const out = r.renderSystemMsg(${norm(FRAME)});
      list.appendChild(out.el);
      const card = list.querySelector('.chat-msg-init');
      const summary = card.querySelector('.chat-init-summary');
      const warn = card.querySelector('.chat-init-warn');
      const details = card.querySelector('.chat-init-details');
      const before = { cardW: card.getBoundingClientRect().width, sumRight: summary.getBoundingClientRect().right, warnRight: warn.getBoundingClientRect().right,
        listScrollW: list.scrollWidth, listClientW: list.clientWidth, sumH: summary.getBoundingClientRect().height,
        sumWrap: getComputedStyle(summary).flexWrap, sumScrollW: summary.scrollWidth, sumClientW: summary.clientWidth };
      details.open = true;
      const body = card.querySelector('.chat-init-body');
      const after = { bodyRight: body.getBoundingClientRect().right, listScrollW: list.scrollWidth, listClientW: list.clientWidth, bodyH: body.getBoundingClientRect().height };
      return { vw: innerWidth, before, after };
    })()`);
    ok(`375×667 collapsed: the card and its health strip stay inside the viewport (card ${Math.round(m.before.cardW)} ≤ ${m.vw}, strip right ${Math.round(m.before.warnRight)} ≤ ${m.vw}) and the list does not scroll sideways (${m.before.listScrollW} ≤ ${m.before.listClientW})`,
      m.before.cardW <= m.vw + 1 && m.before.warnRight <= m.vw + 1 && m.before.listScrollW <= m.before.listClientW + 1, m);
    ok(`375×667: the summary is a WRAPPING row, and at this width it does not overflow its own box (flex-wrap ${m.before.sumWrap}, scrollWidth ${m.before.sumScrollW} ≤ ${m.before.sumClientW}, height ${Math.round(m.before.sumH)}px) — a longer style name or a bigger count wraps to a second line instead of clipping`,
      m.before.sumWrap === 'wrap' && m.before.sumScrollW <= m.before.sumClientW + 1, m.before);
    ok(`375×667 expanded: the inventory wraps too — long verbatim lists break instead of pushing the transcript sideways (body right ${Math.round(m.after.bodyRight)} ≤ ${m.vw}, scrollWidth ${m.after.listScrollW} ≤ ${m.after.listClientW}, body ${Math.round(m.after.bodyH)}px tall)`,
      m.after.bodyRight <= m.vw + 1 && m.after.listScrollW <= m.after.listClientW + 1 && m.after.bodyH > 0, m.after);
  } catch (e) {
    ok('the chrome leg ran', false, String(e).slice(0, 400));
  } finally {
    try { ws?.close(); } catch { }
    try { chrome.kill('SIGKILL'); } catch { }
    try { srv.close(); } catch { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed${skipped ? `, ${skipped} skipped` : ''})` : `\nALL PASS (${pass}${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(fail ? 1 : 0);
