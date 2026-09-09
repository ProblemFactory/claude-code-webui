#!/usr/bin/env node
// Desktop-preview drop resolves the target desktop by the preview's OWN id,
// NOT by DOM index (task #165, real report: dropping a window on a preview
// landed it on the desktop to the RIGHT). Root cause: the Stage preview also
// carries `.desktop-preview` and sits BEFORE the real ones, so
// querySelectorAll('.desktop-preview').indexOf(target) was off by one.
// This proves: (a) every real desktop preview carries dataset.desktopId ===
// its desktop, in order; (b) with a stage-preview present in the NodeList, the
// OLD index map is wrong while the id read is right.
// Runs a throwaway worktree server + headless chrome. Run: node scripts/test-desktop-drop.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { freePorts, scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no chrome/chromium'); process.exit(0); }

const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('deskdrop-smoke');
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + JSON.stringify(e) : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) { execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`); }
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });

const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--disable-background-timer-throttling', `--user-data-dir=${scratch('deskdrop-chrome')}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { srv.kill('SIGKILL'); } catch {}
  try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(scratch('deskdrop-chrome'), { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 40 && !target; i++) { try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = list.find((t) => t.type === 'page'); } catch { await sleep(250); } }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };

try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  await evalJs('window.app ? app.ready : Promise.reject(new Error("no app"))');
  await sleep(600);

  // create 2 more desktops (→ 3), then re-render the switcher
  await evalJs(`(async () => { const dm = app.desktopManager; dm.createDesktop && dm.createDesktop(); dm.createDesktop && dm.createDesktop(); dm.renderSwitcher ? dm.renderSwitcher() : dm._renderSwitcher && dm._renderSwitcher(); })()`);
  await sleep(500);

  const n = await evalJs(`app.desktopManager.desktops.length`);
  check('created 3 desktops', n >= 3, n);

  // every real desktop preview carries dataset.desktopId === its desktop, in order
  const mapping = await evalJs(`(() => {
    const dm = app.desktopManager;
    const reals = [...document.querySelectorAll('.desktop-preview:not(.stage-preview)')];
    return { ok: reals.length === dm.desktops.length && reals.every((p, i) => p.dataset.desktopId === dm.desktops[i].id),
             ids: reals.map(p => p.dataset.desktopId), deskIds: dm.desktops.map(d => d.id) };
  })()`);
  check('every real preview has dataset.desktopId matching its desktop (in order)', mapping.ok, mapping);

  // simulate the Stage preview: prepend a `.desktop-preview.stage-preview` into
  // the switcher container, then prove the OLD index map is off by one while
  // the NEW id read is correct — for the drop target = the 2nd real desktop.
  const result = await evalJs(`(() => {
    const dm = app.desktopManager;
    const reals = [...document.querySelectorAll('.desktop-preview:not(.stage-preview)')];
    const container = reals[0].parentElement;
    const fakeStage = document.createElement('div');
    fakeStage.className = 'desktop-preview stage-preview';
    container.insertBefore(fakeStage, reals[0]);
    const targetPreview = reals[1];            // user drops on the 2nd desktop
    const intended = dm.desktops[1].id;
    // OLD (buggy) resolution: index into the full .desktop-preview NodeList
    const all = [...document.querySelectorAll('.desktop-preview')];
    const oldIdx = all.indexOf(targetPreview);
    const oldResolved = dm.desktops[oldIdx] ? dm.desktops[oldIdx].id : null;
    // NEW resolution: read the id off the preview
    const newResolved = targetPreview.dataset.desktopId;
    fakeStage.remove();
    return { intended, oldResolved, newResolved, oldIdx };
  })()`);
  check('OLD index map lands one desktop to the RIGHT (reproduces the bug)', result.oldResolved !== result.intended, result);
  check('NEW id read resolves to the intended desktop', result.newResolved === result.intended, result);
} catch (e) {
  failed++; console.error('  ✗ threw:', e.stack || e.message);
} finally {
  ws.close();
}
console.log(failed ? `\n${failed} FAILED` : '\ndesktop-drop test passed');
process.exit(failed ? 1 : 0);
