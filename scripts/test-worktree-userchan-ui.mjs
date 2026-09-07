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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';

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

// ── 2. BROWSER leg ──
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

ws.close();
cleanup();
console.log(fail ? `\nFAIL (${fail}) — ${pass} passed` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
