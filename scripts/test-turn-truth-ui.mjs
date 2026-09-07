#!/usr/bin/env node
// B3 TURN TRUTH — the BROWSER half (design-harness-features §2.5 / §2.10 / §2.11).
//
// The server suites (test-stdout-registry, test-codex-history, test-attach-rebuild,
// test-harness-contract) prove the records are consumed and the ops are right.
// This one proves the three things a user can actually SEE, measured in a real
// headless chrome at 375×667 — the ≤768px viewport, where this product's status
// bar becomes a single swipeable lane and a chip that "renders" can still be
// unreachable:
//   ① the status bar's THIRD state ('requires_action') — the value we never had
//   ② the compaction card's hint: the hardcoded 1–2-minute apology BEFORE any
//      progress record, the CLI's real stage after one
//   ③ retraction: a claude tombstone is REMOVED (its own instruction), a codex
//      rollback is STRUCK IN PLACE (hiding it would rewrite what someone read)
//   ④ the tool-granular run set marks the executing card, not every pending one
//   ⑤ and BOTH of those per-element marks survive every rebuild — the three
//      paths that build an element for a message (create/_renderDetached,
//      the status re-render in _onEditMessage, _rerenderVisible). Round-2
//      finding: they were written straight to the DOM and dropped on the
//      first replacement, and the tombstone's own case ALWAYS gets one.
//
// SKIPs (exit 0) without chrome, like every other browser suite here.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
};
const done = () => { console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`); process.exit(failed ? 1 : 0); };

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('  SKIP: no chrome/chromium — the browser measurement did not run'); done(); }

const PORT = 3991 + (process.pid % 20), CDP_PORT = 9391 + (process.pid % 20);
const wt = `/tmp/vs-turntruth-${process.pid}`;
const fakeHome = `${wt}-home`;
const CWD = `${wt}-cwd`;
const SID = 'b3000000-0000-4000-8000-0000000000b3';

// ── fixture: two answered turns + one PENDING tool call (so a [data-tool-id]
//    card exists to mark as executing). Small on purpose — this suite measures
//    chrome, not paging.
{
  const lines = [];
  let ts0 = Date.now() - 3600e3;
  const ts = () => new Date((ts0 += 5e3)).toISOString();
  const push = (o) => lines.push(JSON.stringify(o));
  let n = 0;
  for (const k of [0, 1]) {
    push({ type: 'user', message: { role: 'user', content: `question ${k}` }, uuid: `u-${n++}`, timestamp: ts() });
    push({ type: 'assistant', message: { id: `msg_a${k}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: `answer ${k}` }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `a-${n++}`, timestamp: ts() });
    push({ type: 'result', subtype: 'success', duration_ms: 5, total_cost_usd: 0.001, timestamp: ts() });
  }
  push({ type: 'user', message: { role: 'user', content: 'run the two tools' }, uuid: `u-${n++}`, timestamp: ts() });
  for (const b of [0, 1]) {
    push({ type: 'assistant', message: { id: `msg_t${b}`, role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: `toolu_${b}`, name: 'Bash', input: { command: `echo ${b}` } }], usage: {} }, uuid: `tu-${n++}`, timestamp: ts() });
  }
  const proj = path.join(fakeHome, '.claude', 'projects', CWD.replace(/[/._]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines.join('\n') + '\n');
}

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch { }
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
// Overlay the ALREADY-BUILT public/ (the gate's build step ran first); a
// standalone run measures whatever the last `npm run build` produced.
for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
// 375×667 = the mobile viewport this project measures at. --window-size is the
// OUTER size in headless=new, so the inner viewport is set through CDP below.
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=375,667',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { }
  try { srv.kill('SIGKILL'); } catch { }
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch { }
  for (const d of [`${wt}-chrome`, fakeHome, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
};
process.on('exit', cleanup);
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { }
  if (!target) await sleep(250);
}
if (!target) { console.error('✗ chrome never exposed a CDP page target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map(); const pageErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') { try { pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown'); } catch { } }
});
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 100; i++) { if (await evaljs('!!(window.app && window.app.ready && window.app.wm)').catch(() => false)) break; await sleep(300); }
await evaljs('window.app.ready.then(() => true)').catch(() => { });
await sleep(1200);

const vp = await evaljs('JSON.stringify({ w: innerWidth, h: innerHeight, mobile: !!(window.app && window.app.isMobile) })');
check(`viewport is the 375×667 mobile shape (${vp})`, /"w":375/.test(vp) && /"h":667/.test(vp), vp);

const opened = await evaljs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.app.viewSession('${SID}', '${CWD}', 'turn truth');
  for (let i = 0; i < 80; i++) {
    const v = [...(window.app.sessions?.values?.() || [])].pop();
    if (v && v._messageList && v._messageList.querySelectorAll('.chat-msg').length >= 5) { window.__v = v; return { ok: true, n: v._messageList.querySelectorAll('.chat-msg').length }; }
    await sleep(250);
  }
  const v = [...(window.app.sessions?.values?.() || [])].pop();
  window.__v = v || null;
  return { ok: false, n: v?._messageList?.querySelectorAll('.chat-msg').length ?? -1 };
})()`);
check(`the view-only chat rendered the fixture (${JSON.stringify(opened)})`, opened?.ok === true, opened);
if (!opened?.ok) { console.error(pageErrors.join('\n')); done(); }

// ── ① the status bar's THIRD state at 375px ─────────────────────────────────
{
  const before = await evaljs(`(() => {
    const bar = window.__v._statusBar?._element || document.querySelector('.chat-status-bar');
    return JSON.stringify({ hasBar: !!bar, chips: bar ? bar.querySelectorAll('.chat-status-turnstate').length : -1 });
  })()`);
  check('nothing is drawn before the harness reports a state (null ≠ idle ≠ a claim)', /"chips":0/.test(before), before);
  const idle = await evaljs(`(() => { window.__v._statusBar.setTurnState('idle'); const bar = window.__v._statusBar._element; return bar.querySelectorAll('.chat-status-turnstate').length; })()`);
  check("'idle' and 'running' draw nothing either — the composer's spinner already says that, and one fact must not have two voices", idle === 0, String(idle));
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sb = window.__v._statusBar;
    sb.setTurnState('requires_action');
    await sleep(120);
    const bar = sb._element;
    const chip = bar.querySelector('.chat-status-turnstate');
    if (!chip) return { chip: false };
    // the ≤768px lane is horizontally SWIPEABLE — a chip past the fold is
    // reachable, not lost; scroll it into view and measure it there.
    chip.scrollIntoView({ block: 'nearest', inline: 'end' });
    await sleep(120);
    const cs = getComputedStyle(chip), br = bar.getBoundingClientRect(), cr = chip.getBoundingClientRect();
    return {
      chip: true, text: chip.textContent.trim(), title: chip.getAttribute('title') || '',
      w: Math.round(cr.width), h: Math.round(cr.height),
      display: cs.display, visibility: cs.visibility,
      insideBar: cr.left >= br.left - 1 && cr.right <= br.right + 1,
      insideViewport: cr.left >= -1 && cr.right <= innerWidth + 1,
      barScrolls: bar.scrollWidth >= bar.clientWidth,
      barOverflowX: getComputedStyle(bar).overflowX,
      barH: Math.round(br.height),
    };
  })()`);
  check(`'requires_action' draws the third state at 375×667 (${JSON.stringify(m)})`, m?.chip === true && m.w > 0 && m.h > 0 && m.display !== 'none' && m.visibility !== 'hidden', m);
  check('…it says what it means, and the tooltip names WHO reported it', /waiting for you|等你操作|あなた待ち/.test(m?.text || '') && /harness/.test(m?.title || ''), JSON.stringify([m?.text, m?.title]));
  check('…and at ≤768px it lands inside the swipeable status lane, fully within the 375px viewport (no clipped chip)', m?.insideBar === true && m?.insideViewport === true && m?.barOverflowX === 'auto', m);
  check('…the bar stayed ONE line (mobile rule: never wrap into rows that eat the space above the input)', m?.barH > 0 && m.barH <= 40, String(m?.barH));
  const back = await evaljs(`(() => { window.__v._statusBar.setTurnState('idle'); return window.__v._statusBar._element.querySelectorAll('.chat-status-turnstate').length; })()`);
  check('…and it goes away again when the harness says idle (the chip is a live state, not a sticky banner)', back === 0, String(back));
}

// ── ② the compaction card: apology → real stage ─────────────────────────────
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    v._renderers.appendContextFullCard('Prompt is too long');
    await sleep(80);
    const hintEl = () => v._messageList.querySelector('.chat-ctx-full-hint');
    const fallback = hintEl().textContent.trim();
    v._onCompactProgress({ event: 'hooks_start', hookType: 'pre_compact', hint: null });
    await sleep(60);
    const stage1 = hintEl().textContent.trim();
    v._onCompactProgress({ event: 'compact_start', hookType: null, hint: 'summarizing 812 messages' });
    await sleep(60);
    const stage2 = hintEl().textContent.trim();
    const r = hintEl().getBoundingClientRect();
    v._onCompactProgress({ event: 'compact_end', hookType: null, hint: null });
    await sleep(60);
    const ended = hintEl().textContent.trim();
    return { fallback, stage1, stage2, ended, w: Math.round(r.width), inViewport: r.left >= -1 && r.right <= innerWidth + 1 };
  })()`);
  check('before any progress record the card shows the hardcoded 1–2-minute apology (the FALLBACK, unchanged)', /1.2 minutes|1–2|1〜2|do not press Stop|不要按 Stop|Stop を押さないで/.test(m?.fallback || ''), m?.fallback);
  check('a hooks_start record replaces it with the REAL stage (the hook phase, named)', /pre compact|pre_compact|hooks|フック|hooks…/.test(m?.stage1 || '') && m.stage1 !== m.fallback, m?.stage1);
  check("a compact_start carries the CLI's own hint_text into the card", /summarizing 812 messages/.test(m?.stage2 || ''), m?.stage2);
  check('compact_end returns the card to the fallback (there is no longer a stage to report)', m?.ended === m?.fallback, JSON.stringify([m?.ended, m?.fallback]));
  check(`the hint fits the 375px viewport (${m?.w}px, no horizontal overflow)`, m?.inViewport === true && m?.w > 0 && m.w <= 375, m);
}

// ── ③ retraction: two kinds, two treatments ─────────────────────────────────
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const users = v._messages.filter((x) => x.role === 'user');
    const assts = v._messages.filter((x) => x.role === 'assistant');
    const rollbackId = users[users.length - 1].id, supersededId = assts[assts.length - 1].id;
    v._applyRewound({ harness: 'codex', numTurns: 1, ids: [rollbackId], kind: 'rollback', ts: Date.now() });
    v._applyRewound({ harness: 'claude', toMessageId: supersededId, ids: [supersededId], kind: 'superseded', ts: Date.now() });
    await sleep(120);
    const rb = v._elements.get(rollbackId), sup = v._elements.get(supersededId);
    const rbCs = getComputedStyle(rb), supCs = getComputedStyle(sup);
    const rbRect = rb.getBoundingClientRect();
    const tag = rb.querySelector('.chat-rewound-tag');
    // idempotence: the same op again (a reconnect replay) must not double the tag
    v._applyRewound({ harness: 'codex', numTurns: 1, ids: [rollbackId], kind: 'rollback', ts: Date.now() });
    await sleep(60);
    return {
      rollbackVisible: supCs.display === 'none' ? true : true,
      rbDisplay: rbCs.display, rbOpacity: Number(rbCs.opacity), rbH: Math.round(rbRect.height),
      rbInViewport: rbRect.left >= -1 && rbRect.right <= innerWidth + 1,
      supDisplay: supCs.display,
      tagText: tag ? tag.textContent.trim() : null,
      tagCount: rb.querySelectorAll('.chat-rewound-tag').length,
      modelRewound: v._messages.find((x) => x.id === rollbackId)?.rewound || null,
    };
  })()`);
  check('a codex ROLLBACK stays on screen, dimmed (hiding it would silently rewrite what the reader remembers)', m?.rbDisplay !== 'none' && m?.rbH > 0 && m?.rbOpacity > 0 && m.rbOpacity < 1, m);
  check('…wearing a "rewound" tag that says why', !!m?.tagText, m?.tagText);
  check('a claude TOMBSTONE is REMOVED instead — the CLI\'s own instruction for a superseded partial', m?.supDisplay === 'none', m?.supDisplay);
  check('the op is idempotent: a replayed op does not stack a second tag', m?.tagCount === 1, String(m?.tagCount));
  // The model field is a PRECONDITION for leg ⑤, not evidence — "so a
  // re-render keeps it" was the claim the round-2 verifier falsified (the
  // replacement paths dropped the DOM mark while this field stayed set).
  check('…and the client message model carries the mark too (the precondition leg ⑤ then MEASURES)', m?.modelRewound === 'rollback', String(m?.modelRewound));
  check(`the struck message still fits the 375px viewport (h=${m?.rbH})`, m?.rbInViewport === true, m);
}

// ── ④ the tool-granular run set ─────────────────────────────────────────────
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const cards = [...v._messageList.querySelectorAll('[data-tool-id]')];
    const ids = cards.map((c) => c.dataset.toolId);
    v._onToolsInProgress([ids[0]]);
    await sleep(80);
    const marked = cards.map((c) => c.classList.contains('chat-tool-inflight'));
    const dot = cards[0].querySelector('.chat-tool-label') ? getComputedStyle(cards[0].querySelector('.chat-tool-label'), '::after').content : '(no label)';
    v._onToolsInProgress([]);
    await sleep(60);
    const cleared = cards.map((c) => c.classList.contains('chat-tool-inflight'));
    return { n: cards.length, ids, marked, cleared, dot };
  })()`);
  check(`the fixture has two pending tool cards (${m?.n})`, m?.n === 2, m);
  check('only the tool the harness says is EXECUTING is marked — a pending card is not a running one (it may be sitting on a permission prompt)', JSON.stringify(m?.marked) === '[true,false]', m);
  check('…and the resolved set is authoritative: an empty set clears every mark (a delta record, a resolved view)', JSON.stringify(m?.cleared) === '[false,false]', m);
}

// ── ⑤ EVERY per-element mark survives EVERY rebuild ─────────────────────────
//    Round-2 finding, reproduced here before the fix: a mark written straight
//    to the DOM at its origin (`_applyRewound`, `_onToolsInProgress`) died at
//    the next element REPLACEMENT, and three code paths build an element for a
//    message. The claude tombstone case ALWAYS gets one — the message it
//    retracts is a streaming partial, and MessageManager._finalizeStreaming
//    emits `{op:'edit', fields:{status:'complete'}}` for exactly that message
//    at the next `result`. Measured as COMPUTED STYLE (the no-global-.hidden
//    law: never by the class being present), at 375×667, with two negative
//    controls that must stay unmarked through all of it.
{
  const m = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.__v;
    const assts = v._messages.filter((x) => x.role === 'assistant');
    const users = v._messages.filter((x) => x.role === 'user');
    const supId = assts[assts.length - 1].id;   // marked 'superseded' in leg ③
    const rbId = users[users.length - 1].id;    // marked 'rollback' in leg ③
    const ctrlId = assts[0].id;                 // NEGATIVE CONTROL: never retracted
    const cards = [...v._messageList.querySelectorAll('[data-tool-id]')];
    const msgA = cards[0].dataset.msgId, msgB = cards[1].dataset.msgId;
    v._onToolsInProgress([cards[0].dataset.toolId]); // A executes, B only pends
    await sleep(80);
    const styleOf = (id) => {
      const el = v._elements.get(id); if (!el) return { gone: true };
      const cs = getComputedStyle(el);
      return { display: cs.display, opacity: Number(cs.opacity), tags: el.querySelectorAll('.chat-rewound-tag').length };
    };
    const dotOf = (id) => {
      const el = v._elements.get(id); if (!el) return { gone: true };
      const lab = el.querySelector('.chat-tool-label');
      const af = lab ? getComputedStyle(lab, '::after') : null;
      return { cls: el.classList.contains('chat-tool-inflight'), content: af ? af.content : '(no label)', w: af ? af.width : '(no label)' };
    };
    const shot = () => ({ sup: styleOf(supId), rb: styleOf(rbId), ctrl: styleOf(ctrlId), toolA: dotOf(msgA), toolB: dotOf(msgB) });
    const s0 = shot();
    // ① the status-transition re-render inside _onEditMessage
    for (const id of [supId, rbId, ctrlId, msgA, msgB]) v._onOp({ op: 'edit', id, fields: { status: 'complete' } });
    await sleep(160);
    const s1 = shot();
    // ② _rerenderVisible — the full rebuild a compact-mode toggle runs
    v._rerenderVisible();
    await sleep(160);
    const s2 = shot();
    // ③ the CREATE path — page out and back in, exactly what a trim followed
    //    by _extendTop does (_renderDetached → _onCreateMessage)
    v._loadingHistory = true;
    for (const id of [supId, rbId, ctrlId, msgA, msgB]) {
      const el = v._elements.get(id), msg = v._messages.find((x) => x.id === id);
      const anchor = el.nextSibling;
      v._renderedMsgIds.delete(id); v._elements.delete(id); el.remove();
      const fresh = v._renderDetached(msg);
      if (fresh) v._messageList.insertBefore(fresh, anchor);
    }
    v._loadingHistory = false;
    await sleep(160);
    const s3 = shot();
    return { s0, s1, s2, s3, inflightStillHeld: !!(v._inFlightTools && v._inFlightTools.has(cards[0].dataset.toolId)) };
  })()`);
  const stages = m ? [m.s0, m.s1, m.s2, m.s3] : [];
  const names = ['before any rebuild', 'after the _onEditMessage status re-render', 'after _rerenderVisible', 'after a page-out/page-in (create path)'];
  const supHidden = stages.map((s) => s?.sup?.display);
  check(`the tombstoned partial stays REMOVED through all three rebuilds (computed display: ${JSON.stringify(supHidden)}) — an edit op used to bring a retracted answer back on screen`, supHidden.length === 4 && supHidden.every((d) => d === 'none'), JSON.stringify(m?.s1?.sup));
  const rbOk = stages.map((s) => s?.rb).every((r) => r && r.display !== 'none' && r.opacity > 0 && r.opacity < 1 && r.tags === 1);
  check(`…and the rollback stays struck: dimmed, exactly one tag, at every stage (${JSON.stringify(stages.map((s) => [s?.rb?.opacity, s?.rb?.tags]))})`, rbOk, JSON.stringify(stages.map((s) => s?.rb)));
  const dotOk = stages.map((s) => s?.toolA).every((d) => d && d.cls === true && d.w === '6px');
  check(`the EXECUTING tool keeps its dot through all three rebuilds (computed ::after width: ${JSON.stringify(stages.map((s) => s?.toolA?.w))}) — for a long-running tool no second delta ever comes`, dotOk, JSON.stringify(stages.map((s) => s?.toolA)));
  check('…and the view still holds the id, so the dot is re-derived from state, not remembered by an element', m?.inflightStillHeld === true, JSON.stringify(m?.inflightStillHeld));
  const ctrlOk = stages.map((s) => s?.ctrl).every((c) => c && c.display !== 'none' && c.opacity === 1 && c.tags === 0);
  check(`NEGATIVE CONTROL: a message that was never retracted is untouched by every rebuild (${JSON.stringify(stages.map((s) => [s?.ctrl?.display, s?.ctrl?.opacity, s?.ctrl?.tags]))})`, ctrlOk, JSON.stringify(stages.map((s) => s?.ctrl)));
  const ctrlDotOk = stages.map((s) => s?.toolB).every((d) => d && d.cls === false && d.w !== '6px');
  check(`NEGATIVE CONTROL: the PENDING-but-not-executing tool never gains a dot on a rebuild (${JSON.stringify(stages.map((s) => s?.toolB?.w))}) — re-deriving must not mark everything`, ctrlDotOk, JSON.stringify(stages.map((s) => s?.toolB)));
}

check('no uncaught page exceptions during the measurement', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done();
