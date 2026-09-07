#!/usr/bin/env node
// 375x667 measurement of the Session Properties ORIGIN rows (B-6b6d): the
// value AND where it came from must BOTH be readable on a phone — the origin
// is the last thing on the line, so a nowrap+ellipsis value would eat exactly
// the part these rows exist for (measured: Effort goes 18px -> 32px, unclipped).
// ROUND 2 adds the second scenario: a session that PREDATES the stated origin
// (modelOrigin/effortOrigin null, no saved pick) must show the VALUE with NO
// parenthetical at all rather than asserting "(instance default)" — measured
// here as "the row is shorter and carries no '(' ", on the same phone.
// Run: node scripts/dbg-session-props-mobile.mjs
// Throwaway worktree server + headless chrome, exactly the test-ui-scale idiom.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }
const PORT = 3993, CDP_PORT = 9343;
const wt = '/tmp/vs-b6b6d-smoke';
const SHOTS = '/tmp/vs-b6b6d-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + e : ''}`); } };

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
try { execSync('git worktree prune', { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu',
  '--window-size=375,667', '--user-data-dir=/tmp/vs-b6b6d-chrome', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync('/tmp/vs-b6b6d-chrome', { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { await sleep(250); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

try {
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2000);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  await sleep(600);

  const res = await evalJs(`(async () => {
    const s = {
      backend: 'codex', sessionId: 'th-b6b6d', backendSessionId: 'th-b6b6d', sessionKey: 'codex:th-b6b6d',
      cwd: '/w', name: 'van conversation', status: 'live', webuiId: 'sess-x', webuiMode: 'chat',
      startedAt: Date.now() - 60000,
      spawnModel: 'gpt-6-astra', effort: 'ultra', modelOrigin: 'conversation', effortOrigin: 'conversation',
      outputStyle: 'pragmatic',
    };
    app.sidebar._allSessions = [...(app.sidebar._allSessions || []), s];
    const key = app.sidebar._getSessionStateKey(s);
    app.replayOpenSpec({ action: 'openSessionProps', sessionKey: key, cwd: s.cwd, name: s.name });
    await new Promise((r) => setTimeout(r, 800));
    const win = [...app.wm.windows.values()].find((w) => w._sessionPropsKey);
    if (!win) return { error: 'no props window' };
    const root = win.content.querySelector('.session-props');
    const rows = [...root.querySelectorAll('.session-detail-row')].map((el) => {
      const v = el.querySelector('.session-detail-value');
      return {
        label: el.querySelector('.session-detail-label')?.textContent || '',
        text: el.textContent.replace(/\\s+/g, ' ').trim(),
        h: Math.round(el.getBoundingClientRect().height),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        // is the VALUE (the thing that carries the origin) clipped?
        valClipped: v ? (v.scrollWidth > v.clientWidth + 1) : null,
        valW: v ? v.clientWidth : null, valScrollW: v ? v.scrollWidth : null,
      };
    });
    const w = win.element.getBoundingClientRect();
    return {
      viewport: { w: innerWidth, h: innerHeight },
      window: { w: Math.round(w.width), h: Math.round(w.height), left: Math.round(w.left), top: Math.round(w.top) },
      contentOverflowX: root.scrollWidth - root.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows: rows.filter((r) => /Model|Effort|Response style|Saved/.test(r.label)),
      allLabels: rows.map((r) => r.label),
    };
  })()`);
  console.log(JSON.stringify(res, null, 2));
  check('a props window opened', !res.error);
  check('Model row states value + origin', res.rows?.some((r) => /Model/.test(r.label) && /gpt-6-astra/.test(r.text) && /own value/.test(r.text)), JSON.stringify(res.rows));
  check('Effort row states value + origin', res.rows?.some((r) => /Effort/.test(r.label) && /ultra/.test(r.text) && /own value/.test(r.text)));
  check('no horizontal overflow inside the panel at 375px', res.contentOverflowX <= 0, 'overflowX=' + res.contentOverflowX);
  check('no horizontal overflow of the document at 375px', res.docOverflowX <= 0, 'docOverflowX=' + res.docOverflowX);
  check('every measured row fits in the 375px viewport width', (res.rows || []).every((r) => r.scrollW <= r.clientW + 1), JSON.stringify((res.rows || []).map((r) => [r.label, r.scrollW, r.clientW])));
  check('the ORIGIN is readable — no row clips its value at 375px', (res.rows || []).every((r) => !r.valClipped), JSON.stringify((res.rows || []).map((r) => [r.label, r.valClipped, r.valScrollW, r.valW])));
  const png = await cdp('Page.captureScreenshot', {});
  fs.writeFileSync(path.join(SHOTS, 'session-props-375x667.png'), Buffer.from(png.data, 'base64'));
  console.log('screenshot: ' + path.join(SHOTS, 'session-props-375x667.png'));

  // ── ROUND 2: a session that predates the stated origin ──────────────────
  const res2 = await evalJs(`(async () => {
    const s = {
      backend: 'codex', sessionId: 'th-b6b6d-old', backendSessionId: 'th-b6b6d-old', sessionKey: 'codex:th-b6b6d-old',
      cwd: '/w', name: 'a session from before the field', status: 'live', webuiId: 'sess-old', webuiMode: 'chat',
      startedAt: Date.now() - 60000,
      spawnModel: 'gpt-6-astra', effort: 'ultra', modelOrigin: null, effortOrigin: null,
    };
    app.sidebar._allSessions = [...(app.sidebar._allSessions || []), s];
    const key = app.sidebar._getSessionStateKey(s);
    app.replayOpenSpec({ action: 'openSessionProps', sessionKey: key, cwd: s.cwd, name: s.name });
    await new Promise((r) => setTimeout(r, 800));
    const wins = [...app.wm.windows.values()].filter((w) => w._sessionPropsKey);
    const win = wins[wins.length - 1];
    if (!win) return { error: 'no props window' };
    const root = win.content.querySelector('.session-props');
    const rows = [...root.querySelectorAll('.session-detail-row')].map((el) => {
      const v = el.querySelector('.session-detail-value');
      return {
        label: el.querySelector('.session-detail-label')?.textContent || '',
        text: el.textContent.replace(/\\s+/g, ' ').trim(),
        h: Math.round(el.getBoundingClientRect().height),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        valClipped: v ? (v.scrollWidth > v.clientWidth + 1) : null,
        // the ORIGIN and the "(saved: …)" note are the ONLY dim spans on these
        // rows — a text-level '(' check would trip on effortDisplay's own
        // "ultra (multi-agent · reasoning xhigh)" label
        dimSpans: [...el.querySelectorAll('.chat-status-dim')].map((x) => x.textContent),
      };
    });
    return {
      contentOverflowX: root.scrollWidth - root.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows: rows.filter((r) => /Model|Effort/.test(r.label)),
    };
  })()`);
  console.log(JSON.stringify(res2, null, 2));
  const mRow = (res2.rows || []).find((r) => /Model/.test(r.label));
  const eRow = (res2.rows || []).find((r) => /Effort/.test(r.label));
  check('r2: a session predating the stated origin still shows the VALUE', !!mRow && /gpt-6-astra/.test(mRow.text) && !!eRow && /ultra/.test(eRow.text), JSON.stringify(res2.rows));
  check('r2: …and NO origin parenthetical — the panel does not invent "(instance default)"',
    !!mRow && mRow.dimSpans.length === 0 && !!eRow && eRow.dimSpans.length === 0,
    JSON.stringify((res2.rows || []).map((r) => [r.label, r.text, r.dimSpans])));
  const oldM = (res.rows || []).find((r) => /Model/.test(r.label));
  check('r2: the origin-less row is no taller than the stated one (it can only be shorter at 375px)',
    !!mRow && !!oldM && mRow.h <= oldM.h, JSON.stringify({ stated: oldM && oldM.h, unknown: mRow && mRow.h }));
  check('r2: no horizontal overflow at 375px either', res2.contentOverflowX <= 0 && res2.docOverflowX <= 0, JSON.stringify([res2.contentOverflowX, res2.docOverflowX]));
  const png2 = await cdp('Page.captureScreenshot', {});
  fs.writeFileSync(path.join(SHOTS, 'session-props-375x667-no-origin.png'), Buffer.from(png2.data, 'base64'));
  console.log('screenshot: ' + path.join(SHOTS, 'session-props-375x667-no-origin.png'));

  // ── ROUND 2: what the REAL client actually puts on the wire ─────────────
  // The unit suite pins the two lines and the PURE rule; this runs them in the
  // browser, through the real `createSession`, so a scope/typo bug in the
  // composition cannot pass as green prose (the unstaged-wiring lesson).
  // `ws.send` is SWALLOWED for the duration, so nothing reaches the server and
  // no agent is ever spawned; only the windows this chain created are closed.
  const wire = await evalJs(`(async () => {
    const sent = [];
    const realSend = app.ws.send.bind(app.ws);
    const realDefaults = app._getBackendSessionDefaults.bind(app);
    const before = new Set(app.wm.windows.keys());
    app.ws.send = (m) => { sent.push(typeof m === 'string' ? JSON.parse(m) : m); };
    app._getBackendSessionDefaults = () => ({ model: 'gpt-5.6-sol', permission: '', effort: 'xhigh', extraArgs: '' });
    let err = null;
    try {
      app.createSession({ backend: 'codex', cwd: '/tmp', mode: 'chat', name: 'wire-auto', model: '', effort: '' });
      app.createSession({ backend: 'codex', cwd: '/tmp', mode: 'chat', name: 'wire-none' });
      app.createSession({ backend: 'codex', cwd: '/tmp', mode: 'chat', name: 'wire-resume', resumeId: 'th-wire', model: '', effort: '' });
    } catch (e) { err = String(e && e.message || e); }
    app.ws.send = realSend; app._getBackendSessionDefaults = realDefaults;
    for (const id of [...app.wm.windows.keys()]) if (!before.has(id)) { try { app.wm.closeWindow(id); } catch {} }
    const creates = sent.filter((m) => m && m.type === 'create');
    return { err, creates: creates.map((m) => ({ name: m.sessionName, hasModel: 'model' in m, model: m.model, hasEffort: 'effort' in m, effort: m.effort, resumeId: m.resumeId })) };
  })()`);
  console.log(JSON.stringify(wire, null, 2));
  const byName = (n) => (wire.creates || []).find((c) => c.name === n);
  check('r2 wire: createSession did not throw', !wire.err, wire.err);
  check('r2 wire: a NEW create carries the STATED empty verbatim (an explicit "Auto" is a choice)',
    !!byName('wire-auto') && byName('wire-auto').hasModel && byName('wire-auto').model === '' && byName('wire-auto').hasEffort && byName('wire-auto').effort === '',
    JSON.stringify(byName('wire-auto')));
  check('r2 wire: a NEW create that supplied nothing still carries the instance defaults',
    !!byName('wire-none') && byName('wire-none').model === 'gpt-5.6-sol' && byName('wire-none').effort === 'xhigh',
    JSON.stringify(byName('wire-none')));
  check('r2 wire: a CONTINUATION still sends neither key (the server ladder reads the conversation)',
    !!byName('wire-resume') && byName('wire-resume').model === undefined && byName('wire-resume').effort === undefined,
    JSON.stringify(byName('wire-resume')));
} catch (e) {
  failed++; console.error('measurement failed: ' + e.message);
}
process.exit(failed ? 1 : 0);
