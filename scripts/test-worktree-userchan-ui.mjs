#!/usr/bin/env node
// THE TWO NEW SURFACES, MEASURED ON A PHONE (owner rulings 8(c) + 9).
//
// Both things this batch adds are CHROME the user touches, and this project's
// rule is that a UI change carries a ≤768px behaviour AND a real measurement —
// not a screenshot someone eyeballed (feedback_visual_verification: reading a
// picture is not a measurement; feedback_ui_visual_verdict: a number that is
// not the rendered result is not a verdict). So this suite drives the REAL
// shipped bundle in headless chrome at 375×667 (iPhone SE, the narrowest
// device this product supports) and asserts geometry:
//
//   A. the New Session dialog's "Run in a git worktree" checkbox — present for
//      claude, GONE for a harness without the flag (and cleared when it goes,
//      so a stale tick cannot ride the create), tappable, and inside the
//      dialog's own box with no horizontal overflow.
//   B. the SendUserMessage card — the highlighted "message for you" card that
//      IS the reply when a session runs with --brief. Rendered from the very
//      builder chat-renderers uses, inside the real chat DOM chain, and
//      measured for the failure a narrow viewport actually produces: a card
//      that pushes the message list sideways. Its sibling SendUserFile card is
//      measured with a hostile long path, because that is the string that
//      breaks a 375px column.
//
// SKIPs cleanly (exit 0) without chrome. Worktree-isolated like every other
// boot smoke — the repo's own data/ is PRODUCTION (#127 class).
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';
import { scratch } from './scratch.mjs';

const require = createRequire(import.meta.url);
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error(`  ✗ ${n}${e ? '\n      ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. NODE leg: the card HTML itself (no browser needed for the escaping) ──
console.log('— user-channel card builder');
const { userChannelRecord, userMessageCardHtml, userFileCardHtml } = require(path.join(repo, 'src/user-channel.js'));
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p && k in p ? p[k] : `{${k}}`));
const MARKER = '"><img src=x onerror=alert(1)>';
{
  const rec = userChannelRecord({ toolName: 'SendUserMessage', input: { message: MARKER, status: 'proactive', attachments: [MARKER] }, output: null });
  const html = userMessageCardHtml(rec, { esc: escHtml, t, icons: { mail: '<svg></svg>' } });
  ok('the message card escapes every interpolation (the marker never becomes a tag)',
    !html.includes('<img src=x') && html.includes('&lt;img') && html.includes('chat-userchan-message'), html.slice(0, 160));
  const fileHtml = userFileCardHtml(
    userChannelRecord({ toolName: 'SendUserFile', input: { files: [MARKER], caption: MARKER, status: 'normal' }, output: null }),
    { esc: escHtml, t, icons: { upload: '<svg></svg>' }, link: () => '/p/pg' + 'a'.repeat(10) });
  ok('…and so does the file card, INCLUDING the href it was handed',
    !fileHtml.includes('<img src=x') && fileHtml.includes('href="/p/pg'), fileHtml.slice(0, 160));
}


// ── 1b. NODE leg: THE message-element swap (round-2 verifier, MAJOR) ────────
// A rendered message element carries the bookkeeping the rest of ChatView
// reads it BY — `dataset.msgId` (both trims, jumpToIndex, search reveal, the
// minimap, and the `_elements` key), `dataset.ts`, `dataset.line`, the
// `.chat-gap-msg` exemption, and the two element-keyed run-fold marks. None of
// it comes from the renderers, so a swap that forgets any of it silently
// unregisters the message. `_rerenderToolCard` (the SendUserFile link path)
// was a bare `replaceWith`; this drives the REAL method through the prototype
// against DOM doubles, then reproduces the pre-fix statement verbatim.
console.log('— _swapMessageEl bookkeeping');
{
  const { ChatView } = await import(path.join(repo, 'src/lib/chat-view.js'));
  if (!globalThis.CSS) globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  const mkEl = (over = {}) => {
    const el = {
      dataset: {}, _rawMsg: null, parent: null,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
      replaceWith(next) { const l = this.parent; if (!l) return; l.children[l.children.indexOf(this)] = next; next.parent = l; this.parent = null; },
      ...over,
    };
    return el;
  };
  const mkView = ({ gap = false } = {}) => {
    const raw = { id: 'm1', role: 'tool', toolCallId: 'tc1', ts: 1757200000000, content: [{ type: 'tool_call', toolName: 'SendUserFile', input: { files: ['/tmp/a.png'] } }] };
    const oldEl = mkEl({ dataset: { msgId: 'm1', ts: '1757200000000', line: '4242' }, _rawMsg: raw });
    if (gap) oldEl.classList.add('chat-gap-msg');
    const list = { children: [oldEl], querySelector: () => oldEl };
    oldEl.parent = list;
    const rendered = [];
    const v = Object.assign(Object.create(ChatView.prototype), {
      _messageList: list,
      _elements: new Map([['m1', oldEl]]),
      _runExpanded: new Set([oldEl]),
      _runStickyOpen: new Set([oldEl]),
      _renderers: {
        renderToolMsg: (m) => { const e = mkEl({ _rawMsg: m }); rendered.push(e); return e; },
        addWrapToggles: (e) => { e.__wrap = true; },
        addOpenInEditorBtn: (e) => { e.__editor = true; },
      },
    });
    return { v, list, oldEl, rendered };
  };

  const w = mkView();
  w.v._rerenderToolCard('tc1');
  const next = w.list.children[0];
  ok('_rerenderToolCard swaps the element in place', next !== w.oldEl && w.rendered[0] === next);
  ok('…and the new element keeps its message id (the key both trims, the minimap and search all read)', next.dataset.msgId === 'm1', JSON.stringify(next.dataset));
  ok('…its time coordinate and file offset ride across', next.dataset.ts === 1757200000000 && next.dataset.line === '4242', JSON.stringify(next.dataset));
  ok('…_elements now points at the ATTACHED node (the detached entry is what froze the card at pending)', w.v._elements.get('m1') === next && next.parent === w.list);
  ok('…the element-keyed run-fold marks transfer (an open fold must not snap shut on a link arriving)', w.v._runExpanded.has(next) && w.v._runStickyOpen.has(next));
  ok('…and the per-element affordances are re-installed', next.__wrap === true && next.__editor === true);

  const g = mkView({ gap: true });
  g.v._rerenderToolCard('tc1');
  ok('a GAP-loaded card stays gap-loaded across the swap (else it is promoted into the window accounting both trims do)',
    g.list.children[0].classList.contains('chat-gap-msg'));

  // NEGATIVE CONTROL: the pre-fix statement, verbatim (`if (next) el.replaceWith(next);`).
  const n = mkView();
  { const el = n.list.querySelector(); const raw = el._rawMsg; const nx = n.v._renderers.renderToolMsg(raw); if (nx) el.replaceWith(nx); }
  const bad = n.list.children[0];
  ok('NEGATIVE CONTROL: the pre-fix bare replaceWith loses the msgId AND strands _elements on the detached node — reproduced, so the asserts above measure the fix',
    bad.dataset.msgId === undefined && n.v._elements.get('m1') === n.oldEl && n.oldEl.parent === null,
    JSON.stringify({ ds: bad.dataset, stranded: n.v._elements.get('m1') === n.oldEl }));
  // …and the shipped source really does route all three swap sites through it.
  const cvSrc = fs.readFileSync(path.join(repo, 'src/lib/chat-view.js'), 'utf8');
  ok('…and no swap site hand-rolls the bookkeeping any more (3 call sites, one helper)',
    (cvSrc.match(/this\._swapMessageEl\(/g) || []).length === 3 && !/if \(next\) el\.replaceWith\(next\);/.test(cvSrc));
}

// ── 1b-bis. NODE leg: a RELOADED history re-attaches its SendUserFile links ──
// The live path keys published rows by toolCallId (the broadcast carries it).
// A reloaded history has no broadcast: `_loadPublishedUserFiles` reads the
// conversation's pages and matches them to the cards BY PATH. Round 3 gave the
// channel its own `srcKey` namespace (`userfile:<conv>:<abs>`, so a delivered
// file cannot take over the user's own page) but left this reader stripping a
// `local:` prefix off the key — a no-op on the new shape, so every ABSOLUTE
// path stopped resolving while relative ones kept working by accident through
// the basename fallback. Driven against the REAL published-pages module (the
// producer of the very keys this reader parses) and the REAL ChatView method.
console.log('— reloaded history: SendUserFile links (round-4 verifier)');
{
  const { ChatView } = await import(path.join(repo, 'src/lib/chat-view.js'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ucf-pages-'));
  const pages = require(path.join(repo, 'src/server/published-pages.js')).create({ dataDir });
  const CONV = 'conv-9f2a';
  // The publisher's own call, verbatim from src/server/stdout/claude-stream-json.js.
  const publish = (abs) => pages.publishContent({
    html: Buffer.from('# hi'), name: abs.split('/').pop(),
    srcKey: `userfile:${CONV}:${abs}`, srcPath: abs,
    sessionId: 'sess-1', conversationId: CONV, mediaType: 'text/plain',
  });
  const ABS = '/tmp/vs-ucf/report.md';        // what `files: ['absolute or relative to cwd']` documents
  const REL_ABS = '/repo/wt/notes.md';        // published from a RELATIVE path the CLI resolved
  const pubAbs = publish(ABS), pubRel = publish(REL_ABS);
  ok('the real publisher stores both pages under the channel key namespace, with their PATH recorded alongside it',
    pubAbs.page.srcKey === `userfile:${CONV}:${ABS}` && pubAbs.page.srcPath === ABS && pubRel.page.srcPath === REL_ABS,
    JSON.stringify([pubAbs.page.srcKey, pubAbs.page.srcPath]));

  const mkCard = (toolCallId, files) => ({
    _rawMsg: { id: 'm-' + toolCallId, role: 'tool', toolCallId, content: [{ type: 'tool_call', toolName: 'SendUserFile', input: { files } }] },
  });
  const cards = [mkCard('tc-abs', [ABS]), mkCard('tc-rel', ['notes.md'])];
  const rerendered = [];
  const listed = pages.list({ conversationId: CONV });
  let askedUrl = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { askedUrl = String(url); return { json: async () => ({ pages: listed }) }; };
  const view = Object.assign(Object.create(ChatView.prototype), {
    _getSessionIds: () => ({ backend: 'claude', backendSessionId: CONV }),
    _messageList: { querySelectorAll: () => cards },
    _rerenderToolCard: (tc) => rerendered.push(tc),
  });
  try { await view._loadPublishedUserFiles(); } finally { globalThis.fetch = realFetch; }

  ok('it asks for THIS conversation’s pages (a card must never link a page another conversation published)',
    askedUrl.includes('/api/pages?conversationId=' + encodeURIComponent(CONV)), askedUrl);
  const rows = view._publishedUserFiles || new Map();
  ok('an ABSOLUTE path in the record gets its link back after a reload — the exact case the round-3 key change silently broke',
    rows.get('tc-abs')?.[0]?.link === pubAbs.page.path && rerendered.includes('tc-abs'),
    JSON.stringify({ rows: [...rows], rerendered }));
  ok('…and a RELATIVE one still resolves by basename (the client does not know the CLI’s cwd and must not guess)',
    rows.get('tc-rel')?.[0]?.link === pubRel.page.path && rerendered.includes('tc-rel'), JSON.stringify([...rows]));

  // NEGATIVE CONTROL: the pre-fix statement, verbatim, over the SAME real list.
  const preMap = new Map(listed.map((p) => [String(p.srcKey || '').replace(/^local:/, ''), p]));
  const preLookup = (f) => {
    const abs = String(f).startsWith('/') ? String(f) : '';
    const page = abs ? preMap.get(abs) : null;
    const hit = page || [...preMap.entries()].find(([k]) => k.endsWith('/' + String(f).replace(/^\.\//, '')))?.[1];
    return hit ? hit.path : null;
  };
  ok('NEGATIVE CONTROL: the pre-fix `srcKey.replace(/^local:/,"")` map finds NOTHING for the absolute path (while the relative one still hits) — path-shape-dependent silence, reproduced on the real records',
    preLookup(ABS) === null && preLookup('notes.md') === pubRel.page.path, JSON.stringify({ abs: preLookup(ABS), rel: preLookup('notes.md') }));
  ok('…and the shipped reader no longer hand-parses the upsert key at all (it reads the page’s own srcPath)',
    !/srcKey \|\| ''\)\.replace\(\/\^local:/.test(fs.readFileSync(path.join(repo, 'src/lib/chat-view.js'), 'utf8')));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
}

// ── 1c. NODE leg: the payload → _merge() whitelist (round-3 verifier, BLOCKER) ──
// `_merge()` REBUILDS the session row rather than spreading it (the webui half
// is renamed into webuiId/webuiName/webuiMode, `cwd` becomes the composed
// display/grouping key, `status` is derived), so any live fact it does not
// name is DROPPED — and `/api/sessions` discovery carries none of them, so the
// `...s` spread cannot supply them either. Three were dead when this guard was
// written: worktree/worktreePath (the badge, the Session Properties path, and
// the fork's `live` half), outputStyle (2.369.58) and remoteState (2.219.1).
// The drift guard re-derives the payload's OWN key set from server.js so the
// SEVENTH strike of this class fails here instead of shipping.
console.log('— active-sessions payload → _merge() (whitelist drift)');
{
  const srv = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
  const pushed = srv.split('function activeSessionsPayload()')[1].split('\n  return activeList;')[0].split('activeList.push({')[1];
  const payloadKeys = new Set();
  let depth = 0;
  for (const raw of pushed.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    if (/^\s*\}\);/.test(line)) break;
    if (depth === 0) for (const m of line.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) payloadKeys.add(m[1]);
    depth += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length;
  }
  ok('the active-sessions payload parsed (the guard has something to compare against)', payloadKeys.size >= 20, [...payloadKeys].join(','));

  const sb = fs.readFileSync(path.join(repo, 'src/lib/sidebar.js'), 'utf8');
  const listSrc = sb.split('const LIVE_SESSION_FACTS = Object.freeze({')[1].split('\n});')[0];
  // Each row is `name: { digest: <projection|null> }` — the fact is always
  // CARRIED, and `digest` says whether it also GATES the re-render (round-4).
  const factRows = [...listSrc.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:\s*\{\s*digest:\s*(null|\()/gm)].map((m) => [m[1], m[2] !== 'null']);
  const facts = factRows.map(([k]) => k);
  const gating = factRows.filter(([, g]) => g).map(([k]) => k);
  // Keys _merge() handles by NAME (renamed, derived, or composed) — everything
  // else in the payload must ride LIVE_SESSION_FACTS.
  const HANDLED = new Set(['id', 'name', 'cwd', 'host', 'hostName', 'createdAt', 'backend', 'backendSessionId',
    'sessionKey', 'claudeSessionId', 'sourceKind', 'agentKind', 'agentRole', 'agentNickname', 'parentThreadId', 'mode']);
  const missing = [...payloadKeys].filter((k) => !HANDLED.has(k) && !facts.includes(k));
  const dead = facts.filter((k) => !payloadKeys.has(k));
  ok('EVERY live fact the server publishes is either renamed/derived by name or carried by LIVE_SESSION_FACTS — a new payload key fails HERE, not silently in production',
    missing.length === 0, 'not carried: ' + JSON.stringify(missing));
  ok('…and no dead entries (a fact the payload stopped sending must leave the list)', dead.length === 0, 'dead: ' + JSON.stringify(dead));
  ok('…the facts this round found dead are on it', ['worktree', 'worktreePath', 'outputStyle', 'remoteState'].every((k) => facts.includes(k)), facts.join(','));
  ok('…every row states its render-gate choice (the parse saw all of them — a row this regex cannot read would silently drop out of BOTH halves of the guard)',
    facts.length >= 8 && facts.length === (listSrc.match(/digest:/g) || []).length, JSON.stringify(factRows));
  // ROUND 4: reaching `_merge()` is only half the hop — `_mergeAndRender()`
  // re-renders only when its DIGEST changes, and the digest named none of
  // these, so the `worktree-path` broadcast repainted nothing.
  ok('the four facts whose SURFACES have no partial-update path gate the render digest (badge, path tooltip, transport chip, response-style row)',
    ['worktree', 'worktreePath', 'remoteState', 'outputStyle'].every((k) => gating.includes(k)), gating.join(','));
  ok('…and the object-valued ones are carried-only ON PURPOSE (`todo` changes several times per TURN, `auth` is re-pointed by the pool — gating on either is the 2.72.0/2.106.1 re-render churn)',
    !gating.includes('todo') && !gating.includes('auth'), gating.join(','));
  // WIRING PIN (the 2.331.0 lesson: a pure helper nobody calls is dead code
  // with a green unit test) — the digest expression must USE the projection.
  const digestLine = sb.split('\n').find((l) => l.includes('const digest = JSON.stringify('));
  ok('…and the render gate actually CALLS the projection (a fact list the digest does not read is the same drift one level down)',
    !!digestLine && digestLine.includes('${liveFactsDigestPart(s)}'), String(digestLine).slice(0, 200));
  // NEGATIVE CONTROL: the SHIPPED digest expression with that one call removed
  // (a patched copy, asserted to have hit) cannot tell the two rows apart —
  // the failure this round found, reproduced on the real expression.
  {
    const mkRow = (over) => ({ sessionKey: 'claude:conv-9', status: 'live', name: 'p', webuiName: 'p', webuiId: 'sess-9',
      agentKind: 'primary', agentRole: '', agentNickname: '', worktree: true, worktreePath: '/repo/.claude/worktrees/w1',
      remoteState: null, outputStyle: null, ...over });
    const body = digestLine.trim().replace(/^const digest = /, '').replace(/;$/, '');
    const prefix = body.replace('${liveFactsDigestPart(s)}', '');
    ok('NEGATIVE CONTROL: the mutation really removed the call (else the control below is comparing the fixed expression with itself)', prefix !== body && !prefix.includes('liveFactsDigestPart'));
    const evalDigest = (expr, rows) => {
      const self = { _allSessions: rows, _getSessionStateKey: (s) => s.sessionKey };
      // eslint-disable-next-line no-new-func
      return new Function('liveFactsDigestPart', 'return ' + expr).call(self, (s) => `:${s.worktree ? 1 : 0}:${s.worktreePath || ''}:${s.remoteState || ''}:${s.outputStyle || ''}`);
    };
    const isolated = [mkRow({})];
    const retired = [mkRow({ worktree: false, worktreePath: null })];
    const unreachable = [mkRow({ remoteState: 'reconnecting' })];
    ok('NEGATIVE CONTROL: without the projection the digest is IDENTICAL for "isolated" vs "the CLI just retired the fact" and for "host unreachable" — nothing repaints',
      evalDigest(prefix, isolated) === evalDigest(prefix, retired) && evalDigest(prefix, isolated) === evalDigest(prefix, unreachable));
    ok('…and WITH it all three differ (the shipped expression, driven — this is what makes the broadcast repaint the card)',
      evalDigest(body, isolated) !== evalDigest(body, retired) && evalDigest(body, isolated) !== evalDigest(body, unreachable));
  }
  // NEGATIVE CONTROL: the guard must actually be able to fail.
  const negFacts = facts.filter((k) => k !== 'worktree');
  ok('NEGATIVE CONTROL: with `worktree` removed from the list the guard names it as uncarried (the check is not vacuous)',
    [...payloadKeys].filter((k) => !HANDLED.has(k) && !negFacts.includes(k)).join(',') === 'worktree');
  // …and BOTH branches of _merge must spread it (the matched one and the
  // webui-only unshift): a fix applied to one branch is half a fix.
  ok('both _merge branches carry the list (matched system session AND the webui-only unshift)',
    (sb.match(/\.\.\.liveSessionFacts\(/g) || []).length === 2
    && /\.\.\.liveSessionFacts\(wm\)/.test(sb) && /\.\.\.liveSessionFacts\(ws\)/.test(sb));
}

// ── 1d. NODE leg: §17 on the CSS this branch ADDED ──
// The branch's own summary called out a literal colour it removed from
// chat.css; its twin shipped in style.css, outside every scanning suite.
console.log('— §17: no literal colours in the new CSS');
{
  const cssBlocks = [
    ['public/style.css', '.badge-worktree {', '.acct-type-icon {'],
    ['public/chat.css', '.chat-userchan {', '[data-role-indicator] .chat-msg.chat-msg-userchan'],
  ];
  for (const [file, from, to] of cssBlocks) {
    const css = fs.readFileSync(path.join(repo, file), 'utf8');
    const seg = css.split(from)[1].split(to)[0];
    ok(`${file}: the block this branch added carries theme vars only — no literal colours, not even as a var() fallback (§17)`,
      !/#[0-9a-fA-F]{3,8}\b/.test(seg) && !/\brgba?\(/.test(seg), (seg.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || []).join(' '));
  }
  // NEGATIVE CONTROL: the scan really does catch the shape that was there.
  ok('NEGATIVE CONTROL: the same scan flags the removed `var(--green, #3fb950)` fallback — it is not a vacuous regex',
    /#[0-9a-fA-F]{3,8}\b/.test('color: var(--green, #3fb950);'));
}

// ── 2. BROWSER leg ──
// IT MEASURES THE BUILT BUNDLE, NOT src/ (round 4, caught in the act): the
// worktree overlay copies `public/` as it stands, so a bundle older than the
// sources under test silently measures the PREVIOUS build — which is how three
// green legs turned red the moment the real bundle came back, with nothing in
// the output naming the cause. Say it out loud instead.
{
  // src/agentd/ is EXCLUDED: it is the daemon's own tree (never in the client
  // bundle — test-architecture enforces that), and `npm run build:agentd`
  // rewrites src/agentd/version.js AFTER esbuild, so it is newer than a
  // perfectly fresh bundle every single time.
  const newest = (dir) => {
    let t = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'agentd') t = Math.max(t, newest(f)); }
      else if (/\.(js|css)$/.test(e.name)) t = Math.max(t, fs.statSync(f).mtimeMs);
    }
    return t;
  };
  const bundle = path.join(repo, 'public/bundle.js');
  const built = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
  const src = newest(path.join(repo, 'src'));
  ok('the built bundle is at least as new as src/ — the browser legs below measure public/bundle.js, so a stale one measures the previous build (run `npm run build`)',
    built >= src, `bundle ${built ? new Date(built).toISOString() : 'MISSING'} < src ${new Date(src).toISOString()}`);
}
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium — the 375×667 measurement did not run'); console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`); process.exit(fail ? 1 : 0); }

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), CDP_PORT = await freePort();
const wt = `/tmp/vs-wtui-${process.pid}`;
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch { }
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// Overlay the WORKING TREE (a pre-commit run must measure what is about to
// ship, not HEAD) — the same rule test-client-boot/test-restore-smoke follow.
for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
const chromeDir = `/tmp/vs-wtui-chrome-${process.pid}`;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${chromeDir}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { }
  try { srv.kill('SIGKILL'); } catch { }
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch { }
  try { fs.rmSync(chromeDir, { recursive: true, force: true }); } catch { }
};
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(143); });

for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { }
  if (!target) await sleep(250);
}
if (!target) { console.error('  ✗ chrome never exposed a CDP page target'); cleanup(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.result?.value;
};
await cdp('Runtime.enable');
await cdp('Page.enable');
// 375×667 = iPhone SE, the narrowest viewport this product supports and the
// one the ≤768px rules are written for.
const VW = 375, VH = 667;
await cdp('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: true });
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
let ready = false;
for (let i = 0; i < 180 && !ready; i++) {
  ready = await ev(`(async () => { if (!window.app || !window.app.ready) return false; await Promise.race([window.app.ready, new Promise(r => setTimeout(r, 100))]); return !!document.querySelector('.sidebar'); })()`).catch(() => false);
  if (!ready) await sleep(300);
}
ok('the app boots at 375×667 (mobile chrome renders)', !!ready);
ok('…and it really is a phone viewport, not a desktop one the suite forgot to shrink',
  (await ev(`innerWidth`)) === VW && (await ev(`matchMedia('(max-width: 768px)').matches`)) === true);

console.log('— A. New Session: the worktree checkbox at 375×667');
{
  const openWith = async (backend) => ev(`(() => {
    window.app.hideDialogs();
    window.app.showNewSessionDialog({ backend: ${JSON.stringify(backend)} });
    const row = document.getElementById('row-worktree');
    const cb = document.getElementById('input-worktree');
    const dlg = document.getElementById('dialog-new-session');
    const body = dlg.querySelector('.dialog-body');
    const rr = row.getBoundingClientRect(), cr = cb.getBoundingClientRect(), br = body.getBoundingClientRect();
    const hint = document.getElementById('worktree-hint');
    return {
      display: getComputedStyle(row).display,
      visible: rr.width > 0 && rr.height > 0,
      checked: cb.checked,
      row: { l: rr.left, r: rr.right, w: rr.width, h: rr.height },
      cb: { w: cr.width, h: cr.height },
      body: { l: br.left, r: br.right, w: br.width, sw: body.scrollWidth, cw: body.clientWidth },
      hintText: (hint?.textContent || '').trim().length,
      hintTop: hint ? hint.getBoundingClientRect().top : 0,
      cbTop: cr.top,
      label: (row.querySelector('span:not(.dialog-check-hint)')?.textContent || '').trim(),
    };
  })()`);

  const claude = await openWith('claude');
  ok('claude: the row is RENDERED (not display:none) and has real box',
    claude.display !== 'none' && claude.visible, JSON.stringify(claude));
  ok('…it stays inside the dialog body — no horizontal overflow at 375px (the phone failure this measures)',
    claude.row.l >= claude.body.l - 0.5 && claude.row.r <= claude.body.r + 0.5 && claude.body.sw <= claude.body.cw + 1,
    JSON.stringify({ row: claude.row, body: claude.body }));
  ok('…and inside the VIEWPORT itself (a dialog wider than the phone is the same bug one level up)',
    claude.row.l >= 0 && claude.row.r <= VW + 0.5, JSON.stringify(claude.row));
  ok('…the checkbox is a real, tappable control (both dimensions ≥ 12px, row ≥ 24px tall)',
    claude.cb.w >= 12 && claude.cb.h >= 12 && claude.row.h >= 24, JSON.stringify({ cb: claude.cb, h: claude.row.h }));
  ok('…the hint sits BELOW the box on its own line (the grid row-2 rule), so the label is never squeezed to one character per line',
    claude.hintText > 20 && claude.hintTop > claude.cbTop, JSON.stringify({ hintText: claude.hintText, hintTop: claude.hintTop, cbTop: claude.cbTop }));
  ok('…and it is labelled', /worktree/i.test(claude.label) || claude.label.length > 4, claude.label);

  // Tick it, then switch to a harness WITHOUT the flag: the row must vanish
  // AND the tick must be cleared, or a stale DOM value rides the next create.
  await ev(`(() => { document.getElementById('input-worktree').checked = true; })()`);
  const shell = await openWith('shell');
  ok('shell: the row is GONE (gated on the caps row, not a backend id)', shell.display === 'none' && !shell.visible, JSON.stringify(shell));
  ok('…and the tick was CLEARED, so a stale checkbox cannot ride a create for a harness with no such flag', shell.checked === false);
  const codex = await openWith('codex');
  ok('codex: also gone — claude is the only harness whose CLI has the flag', codex.display === 'none' && !codex.visible);
  const claude2 = await openWith('claude');
  ok('back to claude: the row returns, still unticked (default OFF)', claude2.display !== 'none' && claude2.checked === false);
  await ev(`window.app.hideDialogs()`);
}

console.log('— B. the SendUserMessage / SendUserFile cards at 375×667');
{
  // The cards are built by the SAME pure module chat-renderers calls, and are
  // injected into the SAME DOM chain wrapMsg produces for a 'tool' role
  // (el.innerHTML = html on a .chat-msg.chat-msg-assistant.chat-msg-tool-result
  // element, plus .chat-msg-userchan) inside a real .chat-messages column
  // sized to the phone. That makes this a measurement of the shipped CSS.
  const msgRec = userChannelRecord({
    toolName: 'SendUserMessage',
    input: { message: 'Build is green — 3 tests added, and the flaky one in `writer-sweep` is gone.\n\nNext I will look at the resume path.', status: 'proactive' },
    output: null,
  });
  const msgHtml = userMessageCardHtml(msgRec, { esc: escHtml, t, icons: { mail: '<svg viewBox="0 0 16 16" width="12" height="12"></svg>' } });
  // The row shows the BASENAME (the full path rides the title, so a 375px
  // column can still show the size beside it), which means the string that can
  // actually overflow is a long unbreakable FILE NAME — exactly what an agent
  // produces when it timestamps a deliverable.
  const LONG = '/home/u/workspace/proj/.claude/worktrees/worktree-swift-owl-9f2a/2026-09-07T11-42-08_run-report_before-vs-after_final-candidate-v3.png';
  const fileRec = userChannelRecord({ toolName: 'SendUserFile', input: { files: [LONG], caption: 'the run', status: 'normal' }, output: null });
  const fileHtml = userFileCardHtml(fileRec, { esc: escHtml, t, icons: { upload: '<svg viewBox="0 0 16 16" width="12" height="12"></svg>' }, link: () => '/p/pgabcdefghij' });

  const m = await ev(`(() => {
    document.getElementById('vs-card-probe')?.remove();
    const host = document.createElement('div');
    host.id = 'vs-card-probe';
    // A real chat column on a phone: the message list is the scroller, and
    // the workspace gives it the full viewport width at <=768px.
    host.style.cssText = 'position:fixed;left:0;top:0;width:' + innerWidth + 'px;height:400px;z-index:99999;overflow:hidden';
    host.innerHTML = '<div class="chat-view"><div class="chat-messages" style="width:100%;overflow-x:hidden"></div></div>';
    document.body.appendChild(host);
    const list = host.querySelector('.chat-messages');
    const mk = (html) => { const el = document.createElement('div'); el.className = 'chat-msg chat-msg-assistant chat-msg-tool-result chat-msg-userchan'; el.innerHTML = html; list.appendChild(el); return el; };
    const a = mk(${JSON.stringify(msgHtml)});
    const b = mk(${JSON.stringify(fileHtml)});
    const rect = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; };
    const card = a.querySelector('.chat-userchan');
    const label = a.querySelector('.chat-userchan-label');
    const chip = a.querySelector('.chat-userchan-chip');
    const link = b.querySelector('.chat-userfile-link');
    const cs = getComputedStyle(card);
    return {
      listW: list.clientWidth, listSW: list.scrollWidth,
      msg: rect(a), card: rect(card), label: rect(label), chip: chip ? rect(chip) : null,
      file: rect(b), link: link ? rect(link) : null,
      linkText: link ? link.textContent.trim() : '',
      linkTitle: link ? (link.getAttribute('title') || '') : '',
      accentLeft: cs.borderLeftWidth, bg: cs.backgroundColor,
      labelColor: getComputedStyle(label).color,
      bodyText: (a.querySelector('.chat-userchan-text, .chat-text')?.textContent || '').trim().length,
      docSW: document.documentElement.scrollWidth, docCW: document.documentElement.clientWidth,
    };
  })()`);

  ok('the message card fits the 375px column — the list never gains a horizontal scrollbar',
    m.listSW <= m.listW + 1 && m.card.w > 0 && m.card.r <= m.listW + 0.5, JSON.stringify({ listW: m.listW, listSW: m.listSW, card: m.card }));
  ok('…and the PAGE does not gain one either (a card that overflows the document is the same bug, one level out)',
    m.docSW <= m.docCW + 1, JSON.stringify({ docSW: m.docSW, docCW: m.docCW }));
  ok('…the "Message for you" label row renders inside the card', m.label.w > 0 && m.label.h > 0 && m.label.r <= m.card.r + 0.5, JSON.stringify(m.label));
  ok('…the proactive chip is drawn (status is a real fact of the record, not decoration)', !!m.chip && m.chip.w > 0, JSON.stringify(m.chip));
  ok('…the message text itself is present (a highlighted EMPTY card would be worse than a tool card)', m.bodyText > 40, String(m.bodyText));
  ok('…it is visually a channel card, not a tool card: an accent left rule + a tinted background',
    parseFloat(m.accentLeft) >= 2 && m.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify({ accentLeft: m.accentLeft, bg: m.bg }));
  ok('the file card wraps a long unbreakable file name instead of pushing the column sideways (the string that actually breaks 375px)',
    m.link && m.link.r <= m.listW + 0.5 && m.link.h > 20 && m.linkText.length > 60,
    JSON.stringify({ link: m.link, listW: m.listW, len: m.linkText.length }));
  ok('…and the full path is still reachable on the row rather than dropped (the title carries what the label cannot)',
    m.linkTitle.startsWith('/home/u/workspace/proj/') && m.linkTitle.length > m.linkText.length, JSON.stringify(m.linkTitle));

  // NEGATIVE CONTROL: the same measurement, with the card CSS neutralised —
  // it must go RED, or the asserts above are measuring nothing.
  // The FAILURE row (round-3 verifier) is new chrome, so it carries its own
  // ≤768px measurement: the CLI's reason is an arbitrary-length string and it
  // sits in the same 375px column as everything else.
  const f = await ev(`(() => {
    const host = document.getElementById('vs-card-probe');
    const list = host.querySelector('.chat-messages');
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant chat-msg-tool-result chat-msg-userchan';
    el.innerHTML = ${JSON.stringify(userFileCardHtml(
      userChannelRecord({
        toolName: 'SendUserFile',
        input: { files: ['/home/u/workspace/proj/out/2026-09-07T11-42-08_run-report_final-candidate-v3.png'], status: 'normal' },
        output: 'Error: EACCES /home/u/workspace/proj/out/2026-09-07T11-42-08_run-report_final-candidate-v3.png is outside the workspace the sandbox allows this session to read',
        status: 'error',
      }),
      { esc: escHtml, t, icons: { upload: '<svg viewBox="0 0 16 16" width="12" height="12"></svg>' }, link: () => '', note: 'Files sent from a remote session are not published here.' },
    ))};
    list.appendChild(el);
    const card = el.querySelector('.chat-userchan');
    const row = el.querySelector('.chat-userchan-failed');
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, h: b.height }; };
    return {
      hasRow: !!row, card: r(card), row: row ? r(row) : null,
      rowColor: row ? getComputedStyle(row).color : '',
      cardRule: getComputedStyle(card).borderLeftColor,
      labelColor: getComputedStyle(el.querySelector('.chat-userchan-label')).color,
      listW: list.clientWidth, listSW: list.scrollWidth,
      docSW: document.documentElement.scrollWidth, docCW: document.documentElement.clientWidth,
      text: (row?.textContent || '').trim(),
      note: !!el.querySelector('.chat-userfile-meta'),
    };
  })()`);
  ok('a FAILED user-channel card draws its reason row and wraps it inside the 375px column (no new scrollbar, on the list or the page)',
    f.hasRow && f.row.h > 0 && f.row.r <= f.listW + 0.5 && f.listSW <= f.listW + 1 && f.docSW <= f.docCW + 1,
    JSON.stringify(f));
  ok('…it reads as a failure, not a delivery: the red rule + red label + the CLI’s own reason, and no "sent from a remote session" note',
    f.rowColor === f.cardRule && f.rowColor === f.labelColor && /outside the workspace/.test(f.text) && f.note === false,
    JSON.stringify({ rowColor: f.rowColor, rule: f.cardRule, label: f.labelColor, note: f.note }));
  const themeRed = await ev(`(() => { const p = document.createElement('span'); p.style.color = 'var(--red)'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
  ok('…and that colour IS the theme variable resolved, not a literal baked into the markup (§17 — the card carries classes, the theme carries colour)',
    f.rowColor === themeRed && /^rgba?\(/.test(themeRed), JSON.stringify({ row: f.rowColor, themeRed }));

  const neg = await ev(`(() => {
    const st = document.createElement('style'); st.id = 'vs-card-probe-neg';
    st.textContent = '.chat-userfile-link{word-break:normal !important;white-space:nowrap !important} .chat-messages{overflow-x:visible !important}';
    document.head.appendChild(st);
    const host = document.getElementById('vs-card-probe');
    const list = host.querySelector('.chat-messages');
    const link = host.querySelectorAll('.chat-msg')[1].querySelector('.chat-userfile-link');
    const r = link.getBoundingClientRect();
    const out = { listW: list.clientWidth, listSW: list.scrollWidth, linkR: r.right, linkH: r.height };
    st.remove();
    return out;
  })()`);
  ok('NEGATIVE CONTROL: neutralise the wrap rule and the long path DOES overflow the 375px column — the pass above is the CSS working',
    neg.linkR > neg.listW + 1 || neg.listSW > neg.listW + 1, JSON.stringify(neg));
  await ev(`document.getElementById('vs-card-probe')?.remove()`);
}


console.log('— C. a REAL ChatView: the SendUserFile card lifecycle');
{
  // The node leg above proves the helper. This one proves the PATH: a real
  // ChatView (created by app.viewSession, so it is the shipped constructor,
  // renderers and DOM), a real SendUserFile tool message through _onOp, the
  // real `user-file-published` handler, then the real tool_result edit — which
  // is exactly the ordering the server produces with `claude.brief` on.
  const CONV = '9f2a0000-1111-2222-3333-444455556666';
  const setup = await ev(`(async () => {
    window.app.viewSession(${JSON.stringify(CONV)}, '/tmp', 'wt-userfile-probe', { backend: 'claude', offerService: false });
    await new Promise(r => setTimeout(r, 400));
    const entry = [...window.app.sessions.entries()].find(([, v]) => v && v.sessionId === 'view-' + ${JSON.stringify(CONV)});
    if (!entry) return { ok: false, ids: [...window.app.sessions.keys()] };
    window.__wtProbe = { winId: entry[0], v: entry[1] };
    return { ok: true, winId: entry[0], hasList: !!entry[1]._messageList };
  })()`);
  ok('a real read-only ChatView exists to drive (shipped constructor + renderers, not a hand-built chain)', setup?.ok === true && setup.hasList, JSON.stringify(setup));

  const lifecycle = await ev(`(() => {
    const v = window.__wtProbe.v;
    v._pinned = true; v._teleported = false; v._loadingHistory = false;   // a live tail, so a create RENDERS rather than counting
    const MID = 'ucf-probe-1', TCID = 'toolu_wtprobe1';
    const call = { type: 'tool_call', toolName: 'SendUserFile', input: { files: ['/tmp/vs-probe-report.png'], caption: 'the run' } };
    v._onOp({ op: 'create', message: { id: MID, role: 'tool', toolCallId: TCID, ts: Date.now(), status: 'pending', content: [call] } });
    const list = v._messageList;
    const snap = (tag) => {
      const el = list.querySelector('[data-tool-id="' + TCID + '"]');
      const mapped = v._elements.get(MID);
      const link = el && el.querySelector('.chat-userfile-link');
      return {
        tag,
        cards: list.querySelectorAll('.chat-msg-userchan').length,
        msgId: el ? (el.dataset.msgId || null) : null,
        ts: el ? !!el.dataset.ts : false,
        mappedIsVisible: mapped === el,
        mappedConnected: !!(mapped && mapped.isConnected),
        href: link ? link.getAttribute('href') : null,
        // the tool_result's own attachments[].size — present ONLY once the
        // resolved output has been merged into the record (a visible,
        // record-derived difference between pending and resolved)
        meta: el ? [...el.querySelectorAll('.chat-userfile-meta')].map(e => e.textContent.trim()).join('|') : null,
        trimSees: [...list.querySelectorAll('.chat-msg:not(.chat-gap-msg)')].filter(e => e.dataset.msgId === MID).length,
      };
    };
    const before = snap('pending');
    // the server's own broadcast shape (claude-stream-json 'user-file-published')
    v._notePublishedUserFiles(TCID, [{ path: '/tmp/vs-probe-report.png', name: 'vs-probe-report.png', link: '/p/pgwtprobe1' }]);
    const published = snap('published');
    // …and then the tool_result lands, which re-renders through the OTHER swap site
    const result = { attachments: [{ path: '/tmp/vs-probe-report.png', size: 20480 }], sentAt: '2026-09-07T12:00:00Z' };
    v._onOp({ op: 'edit', id: MID, fields: { status: 'complete', content: [{ ...call, type: 'tool_result', output: JSON.stringify(result) }] } });
    const done = snap('resolved');
    return { before, published, done };
  })()`);

  ok('the pending card renders and is registered (data-msg-id + _elements + the trims can see it)',
    lifecycle.before.msgId === 'ucf-probe-1' && lifecycle.before.mappedIsVisible && lifecycle.before.trimSees === 1,
    JSON.stringify(lifecycle.before));
  // absUrl joins the RELATIVE link the server published with the browser's own
  // origin (2.366.1 — the server never guesses an absolute URL), so the href is
  // origin + /p/<id> and it is the SUFFIX that is the product's fact.
  ok('the user-file-published broadcast puts the LINK on the card…',
    /^https?:\/\/[^/]+\/p\/pgwtprobe1$/.test(lifecycle.published.href || '') && lifecycle.published.cards === 1, JSON.stringify(lifecycle.published));
  ok('…and the swapped-in element is STILL the registered one — attached, msgId intact, visible to both trims (round-2 verifier: it used to be an orphan)',
    lifecycle.published.msgId === 'ucf-probe-1' && lifecycle.published.mappedIsVisible && lifecycle.published.mappedConnected && lifecycle.published.trimSees === 1,
    JSON.stringify(lifecycle.published));
  ok('the tool_result then reaches the VISIBLE card (the edit used to "replace" a parentless node — a spec no-op — so the card stayed pending forever)',
    lifecycle.done.msgId === 'ucf-probe-1' && lifecycle.done.mappedIsVisible && /\/p\/pgwtprobe1$/.test(lifecycle.done.href || '')
    && lifecycle.done.cards === 1 && lifecycle.published.meta === '' && /20 KB/.test(lifecycle.done.meta || ''),
    JSON.stringify(lifecycle.done));

  // MUTATION CONTROL: the pre-fix swap, on the same real view and the same
  // sequence — a bare replaceWith, which is what `_rerenderToolCard` did.
  const neg = await ev(`(() => {
    const v = window.__wtProbe.v;
    const orig = v._swapMessageEl;
    v._swapMessageEl = function (oldEl, newEl) { if (oldEl && newEl) oldEl.replaceWith(newEl); return newEl; };
    try {
      const MID = 'ucf-probe-2', TCID = 'toolu_wtprobe2';
      const call = { type: 'tool_call', toolName: 'SendUserFile', input: { files: ['/tmp/vs-probe-two.png'] } };
      v._onOp({ op: 'create', message: { id: MID, role: 'tool', toolCallId: TCID, ts: Date.now(), status: 'pending', content: [call] } });
      v._notePublishedUserFiles(TCID, [{ path: '/tmp/vs-probe-two.png', name: 'vs-probe-two.png', link: '/p/pgwtprobe2' }]);
      const list = v._messageList;
      const el = list.querySelector('[data-tool-id="' + TCID + '"]');
      const mapped = v._elements.get(MID);
      const result = { attachments: [{ path: '/tmp/vs-probe-two.png', size: 20480 }], sentAt: '2026-09-07T12:00:00Z' };
      v._onOp({ op: 'edit', id: MID, fields: { status: 'complete', content: [{ ...call, type: 'tool_result', output: JSON.stringify(result) }] } });
      const after = list.querySelector('[data-tool-id="' + TCID + '"]');
      return {
        msgId: el ? (el.dataset.msgId || null) : null,
        stranded: !!(mapped && !mapped.isConnected),
        // the resolved size never reaches the visible card: the edit replaced a
        // PARENTLESS node (a spec no-op), so the card is frozen at pending
        editReachedTheVisibleCard: after ? [...after.querySelectorAll('.chat-userfile-meta')].some(e => /20 KB/.test(e.textContent)) : null,
        visibleIsMapped: after === v._elements.get(MID),
        trimSees: [...list.querySelectorAll('.chat-msg:not(.chat-gap-msg)')].filter(e => e.dataset.msgId === MID).length,
      };
    } finally { v._swapMessageEl = orig; }
  })()`);
  ok('NEGATIVE CONTROL: with the pre-fix bare replaceWith the same sequence strands _elements on a detached node and the visible card loses its msgId — the failure, reproduced on the real view',
    neg.msgId === null && neg.stranded === true && neg.visibleIsMapped === false && neg.trimSees === 0 && neg.editReachedTheVisibleCard === false,
    JSON.stringify(neg));

  // Close ONLY the window this leg created (feedback_no_browser_cleanup_heuristics).
  await ev(`(() => { const id = window.__wtProbe?.winId; if (id) window.app.wm.closeWindow(id); delete window.__wtProbe; return true; })()`);
}


console.log('— D. the worktree-path frame RECORDS the pick (round-2 verifier, the dead write)');
{
  // The `worktree-path` frame is the FIRST moment a brand-new isolated session
  // can record its pick: the box is ticked before the conversation has an id,
  // the `created` payload arrives before the CLI has announced one, and the
  // creator never gets an 'attached' (2.368.4). This drives the REAL ws branch
  // — the frame goes through WsManager's own global handler list, exactly as
  // the server's broadcast would.
  const CONV = '7c130000-aaaa-bbbb-cccc-ddddeeeeffff';
  const prep = await ev(`(async () => {
    window.app.viewSession(${JSON.stringify(CONV)}, '/tmp', 'wt-latch-probe', { backend: 'claude', offerService: false });
    await new Promise(r => setTimeout(r, 400));
    const entry = [...window.app.sessions.entries()].find(([, v]) => v && v.sessionId === 'view-' + ${JSON.stringify(CONV)});
    if (!entry) return { ok: false };
    window.__wtLatch = { winId: entry[0], v: entry[1], key: { backend: 'claude', backendSessionId: ${JSON.stringify(CONV)} } };
    return { ok: true, ids: entry[1]._getSessionIds() };
  })()`);
  ok('the latch probe resolves the conversation identity the frame will be recorded against',
    prep?.ok === true && prep.ids?.backendSessionId === CONV, JSON.stringify(prep));

  // Both entry points are PROTOTYPE methods (`_onWorktreePath` for the live
  // frame, `_applyLiveMeta` for the attach payload), so this drives the real
  // code — not a re-implementation — against the real sidebar store. `null` is
  // used for "no key on record" because an `undefined` property is dropped by
  // CDP's returnByValue and would make an absent assert look like a pass.
  const run = await ev(`(() => {
    const { v, key } = window.__wtLatch;
    const sb = window.app.sidebar;
    const saved = () => { const c = sb.getSessionConfig(key) || {}; return 'worktree' in c ? c.worktree : null; };
    const clear = () => { const c = sb.getSessionConfig(key) || {}; delete c.worktree; sb.setSessionConfig(key, { ...c }); };
    const frame = (worktree) => v._onWorktreePath({ type: 'worktree-path', sessionId: v.sessionId, worktree, worktreePath: worktree ? '/repo/.claude/worktrees/swift-owl' : null });
    const out = {};
    clear(); out.beforeAny = saved();
    frame(true); out.afterOn = saved(); out.liveOn = v._worktree;
    // an explicit UNTICK must survive a run that IS isolated
    sb.setSessionConfig(key, { ...(sb.getSessionConfig(key) || {}), worktree: false });
    frame(true); out.afterOnWithExplicitFalse = saved();
    // and a NOT-isolated run must not write a pick at all
    clear(); frame(false); out.afterOff = saved(); out.liveOff = v._worktree;
    // a frame that says nothing about the worktree must not touch either fact
    clear(); frame(true); v._onWorktreePath({ type: 'worktree-path', sessionId: v.sessionId }); out.afterSilent = saved(); out.liveSilent = v._worktree;
    // the ATTACH payload runs the same latch (the other entry point)
    clear(); v._worktree = false; v._applyLiveMeta({ worktree: true }); out.afterMeta = saved(); out.liveMeta = v._worktree;
    // PRE-FIX: the branch wrote _worktree and nothing else (the field is
    // reassigned on the line above its only reader, so it was unobservable)
    clear();
    const orig = v._latchWorktreePick;
    v._latchWorktreePick = function () { };
    try { frame(true); out.preFixSaved = saved(); out.preFixLive = v._worktree; } finally { v._latchWorktreePick = orig; }
    clear();
    return out;
  })()`);

  ok('an ABSENT pick is recorded the moment the CLI says this run is isolated (a new worktree session’s tick finally reaches the store)',
    run.beforeAny === null && run.afterOn === true && run.liveOn === true, JSON.stringify(run));
  ok('…and the ATTACH payload runs the same latch (one implementation, two entry points)',
    run.afterMeta === true && run.liveMeta === true, JSON.stringify(run));
  ok('NEGATIVE CONTROL: an explicit UNTICK is not overruled by the same frame (a fact never overrides a decision)',
    run.afterOnWithExplicitFalse === false, JSON.stringify(run));
  ok('NEGATIVE CONTROL: a NOT-isolated run writes no pick at all — the latch is ONE-WAY (the live fact drops, the preference is untouched)',
    run.afterOff === null && run.liveOff === false, JSON.stringify(run));
  ok('NEGATIVE CONTROL: a frame that carries no `worktree` key changes neither fact (carries-the-key guard)',
    run.afterSilent === true && run.liveSilent === true, JSON.stringify(run));
  ok('NEGATIVE CONTROL: with the latch removed the frame records NOTHING while still writing the live field — the pre-fix branch, reproduced (it was pinned as if it were the mechanism)',
    run.preFixSaved === null && run.preFixLive === true, JSON.stringify(run));

  await ev(`(() => { const id = window.__wtLatch?.winId; if (id) window.app.wm.closeWindow(id); delete window.__wtLatch; return true; })()`);
}

console.log('— E. the active-sessions payload really reaches the surfaces that read it');
{
  // The BLOCKER this round: `_merge()` never copied `worktree`/`worktreePath`,
  // so the badge, Session Properties and the FORK's `live` half were all dead
  // against a real payload. This drives the REAL `sidebar._merge()` with the
  // shape server.js broadcasts, then asks the REAL renderer / properties
  // window / fork call site what they see — the payload→merge→surface hop,
  // not a hand-built object handed straight to a renderer.
  const ROOT = scratch('wt-probe-repo'); // per-process; interpolated into the BROWSER-evaluated string below (scratch() does not exist there)
  const WT = ROOT + '/.claude/worktrees/worktree-swift-owl';
  const merged = await ev(`(() => {
    const sb = window.app.sidebar;
    window.__mergeProbe = { sysBak: sb._systemSessions, webBak: sb._webuiSessions, allBak: sb._allSessions };
    // exactly the row activeSessionsPayload() builds for a live isolated session
    sb._systemSessions = [];
    sb._webuiSessions = [{
      id: 'sess-9', name: 'probe', cwd: ${JSON.stringify(ROOT)}, host: null, hostName: null,
      remoteState: null, createdAt: Date.now(), backend: 'claude', backendSessionId: 'conv-9',
      sessionKey: 'claude:conv-9', claudeSessionId: 'conv-9', sourceKind: null, agentKind: 'primary',
      agentRole: '', agentNickname: '', parentThreadId: null, accountId: null, accountName: null,
      accountTail: null, todo: null, auth: null, mode: 'chat',
      outputStyle: 'Concise', worktree: true, worktreePath: ${JSON.stringify(WT)},
    }];
    sb._merge();
    const m = sb._allSessions.find((x) => x.webuiId === 'sess-9');
    return { keys: Object.keys(m || {}), worktree: m?.worktree, worktreePath: m?.worktreePath, outputStyle: m?.outputStyle, has: !!m };
  })()`);
  ok('the merged row carries the payload’s worktree facts (they used to be dropped by the hand-picked key list)',
    merged.has && merged.worktree === true && merged.worktreePath === WT, JSON.stringify(merged));
  ok('…and its TWIN from the same payload (outputStyle, 2.369.58 — the standing-sweep sibling)', merged.outputStyle === 'Concise', JSON.stringify(merged.keys));

  const card = await ev(`(() => {
    const sb = window.app.sidebar;
    const m = sb._allSessions.find((x) => x.webuiId === 'sess-9');
    const badgeOf = (row) => { const b = sb._buildSessionCard(row, {}).querySelector('.badge-worktree'); return b ? (b.getAttribute('data-tip') || 'yes') : ''; };
    const stripped = { ...m }; delete stripped.worktree; delete stripped.worktreePath;
    return { tip: badgeOf(m), preFix: badgeOf(stripped) };
  })()`);
  ok('the session card draws the worktree badge from the merged row, and its tooltip names the CLI-announced path',
    card.tip.includes(WT), JSON.stringify(card));
  ok('NEGATIVE CONTROL: strip those two keys back out of the same row and the badge disappears — the pre-fix merge, reproduced on the real renderer',
    card.preFix === '', JSON.stringify(card));

  // THE FORK CALL SITE, for real: _doForkSession resolves the pick and hands it
  // to createSession. Stub only createSession (nothing is ever spawned).
  const fork = await ev(`(async () => {
    const app = window.app;
    const sb = app.sidebar;
    const m = sb._allSessions.find((x) => x.webuiId === 'sess-9');
    const cfg = sb.getSessionConfig(m) || {}; delete cfg.worktree; sb.setSessionConfig(m, { ...cfg });
    const orig = app.createSession; const seen = [];
    app.createSession = (spec) => { seen.push(spec); return null; };
    try {
      await app._doForkSession(m, 'hello');
      const stripped = { ...m }; delete stripped.worktree; delete stripped.worktreePath;
      await app._doForkSession(stripped, 'hello');
    } finally { app.createSession = orig; }
    return { withFacts: seen[0]?.worktree ?? null, withoutFacts: seen[1]?.worktree ?? null, forkFlag: seen[0]?.fork, n: seen.length };
  })()`);
  ok('a FORK of this conversation with NO saved pick asks for a worktree — the live half of worktreePick finally has a producer at the real call site',
    fork.n === 2 && fork.forkFlag === true && fork.withFacts === true, JSON.stringify(fork));
  ok('NEGATIVE CONTROL: the same fork over a row missing those keys asks for nothing (the pre-fix merge would have run in the user’s real working tree)',
    fork.withoutFacts === null, JSON.stringify(fork));

  // Session Properties, opened on the merged row through the real window.
  const props = await ev(`(() => {
    const sb = window.app.sidebar;
    const m = sb._allSessions.find((x) => x.webuiId === 'sess-9');
    sb.setSessionConfig(m, { ...(sb.getSessionConfig(m) || {}), worktree: true });
    const win = window.app.openSessionProps(m);
    const root = win.content.querySelector('.session-props');
    const txt = root.textContent || '';
    window.__mergeProbe.propWin = win.id;
    return { showsPath: txt.includes(${JSON.stringify(WT)}), saysNotIsolated: /not isolated in this run/i.test(txt), style: /Concise/.test(txt) };
  })()`);
  ok('Session Properties shows the announced worktree path instead of claiming the session is not isolated',
    props.showsPath === true && props.saysNotIsolated === false, JSON.stringify(props));
  ok('…and the response-style row finally has a live value to show (the sibling fact from the same payload)', props.style === true, JSON.stringify(props));

  // ── THE RENDER GATE (round-4 verifier) ──────────────────────────────────
  // Reaching `_merge()` is half the hop. `_mergeAndRender()` only re-renders
  // when its DIGEST changes, and the digest named none of the live facts — so
  // the `worktree-path` broadcast this branch added specifically to keep the
  // badge honest repainted NOTHING, and the "host unreachable" chip could not
  // draw on the transition either (neither surface has a partial-update path:
  // both exist only inside renderSessionCard). Driven on the REAL sidebar with
  // the REAL payload rows, counting the REAL renders.
  const gate = await ev(`(() => {
    const sb = window.app.sidebar;
    const base = sb._webuiSessions[0];
    const n = { c: 0 };
    const orig = sb._render;
    sb._render = function () { n.c++; };
    // Each pass changes EXACTLY ONE fact relative to the previous one — a
    // pass rebuilt from the base would also revert the previous field, and
    // then every step would look like it gated the render.
    let cur = { ...base };
    const pass = (patch) => { cur = { ...cur, ...patch }; sb._webuiSessions = [cur]; sb._mergeAndRender(); return n.c; };
    try {
      const first = pass({});
      const same = pass({});                                                    // identical payload ⇒ no churn
      const wtGone = pass({ worktree: false, worktreePath: null });             // the worktree-path broadcast's own shape
      const wtBack = pass({ worktree: true, worktreePath: base.worktreePath });
      const unreachable = pass({ remoteState: 'reconnecting' });                // 2.219.1 chip
      const style = pass({ outputStyle: 'Explanatory' });                       // 2.369.58 row
      const todo = pass({ todo: { done: 2, total: 5, current: 'writing the thing' } });
      return { first, same, wtGone, wtBack, unreachable, style, todo };
    } finally { sb._render = orig; }
  })()`);
  ok('the live worktree fact GATES the re-render: flipping it repaints the list (the broadcast finally reaches the badge)',
    gate.wtGone === gate.same + 1 && gate.wtBack === gate.wtGone + 1, JSON.stringify(gate));
  ok('…so do the transport chip and the response-style row (the same class, found by the same measurement)',
    gate.unreachable === gate.wtBack + 1 && gate.style === gate.unreachable + 1, JSON.stringify(gate));
  ok('NEGATIVE CONTROL: an IDENTICAL payload still renders nothing — the digest keeps suppressing the 5s-poll churn it exists for',
    gate.same === gate.first, JSON.stringify(gate));
  ok('NEGATIVE CONTROL: `todo` is carried but deliberately NOT gating (it changes several times per turn; gating on it is the churn the digest forbids) — a measured choice, pinned so it cannot flip silently',
    gate.todo === gate.style, JSON.stringify(gate));

  // …and the consequence on the rendered CARD, not just the counter.
  const painted = await ev(`(() => {
    const sb = window.app.sidebar;
    const base = { ...sb._webuiSessions[0], worktree: true, worktreePath: ${JSON.stringify(WT)} };
    // At 375px the list renders FOLDER GROUPS until you drill into one, so the
    // measurement drills in deliberately — leaving it to whatever state an
    // earlier leg left behind made this leg order-dependent (it measured zero
    // cards and called it a pass-or-fail at random).
    const drill = { type: 'folder', key: base.cwd, label: 'probe' };
    const bakDrill = sb._mobileDrilldown, bakTab = sb._activeTab, bakView = sb._activeView;
    sb._mobileDrilldown = drill; sb._activeTab = 'sessions'; sb._activeView = null;
    const badges = () => sb.listEl.querySelectorAll('.badge-worktree').length;
    try {
      sb._webuiSessions = [base]; sb._sessionDigest = null; sb._mergeAndRender();
      const before = badges();
      const cards = sb.listEl.querySelectorAll('.session-item-card').length;
      sb._webuiSessions = [{ ...base, worktree: false, worktreePath: null }]; sb._mergeAndRender();
      return { before, after: badges(), cards, drilled: !!sb._mobileMode };
    } finally { sb._mobileDrilldown = bakDrill; sb._activeTab = bakTab; sb._activeView = bakView; }
  })()`);
  ok('the probe row really is rendered in the 375px list (else the badge measurement below would pass by drawing nothing)', painted.cards >= 1, JSON.stringify(painted));
  ok('the drawn card follows: the badge is in the list while the run is isolated and GONE once the CLI retires the fact (the pre-fix digest left it there until an unrelated field changed)',
    painted.before >= 1 && painted.after === 0, JSON.stringify(painted));

  await ev(`(() => {
    const p = window.__mergeProbe;
    if (p.propWin) window.app.wm.closeWindow(p.propWin);
    const sb = window.app.sidebar;
    sb._systemSessions = p.sysBak; sb._webuiSessions = p.webBak; sb._allSessions = p.allBak;
    delete window.__mergeProbe; return true;
  })()`);
}

ws.close();
cleanup();
console.log(fail ? `\nFAIL (${fail}) — ${pass} passed` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
