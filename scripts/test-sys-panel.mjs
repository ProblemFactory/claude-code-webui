import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { freePorts, scratch } from './scratch.mjs';
const require = createRequire(new URL('../server.js', import.meta.url));
const repo = process.cwd();
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('syspanel-test'), fakeHome = scratch('syspanel-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}`); } };
try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });
fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
fs.rmSync(fakeHome, { recursive: true, force: true }); fs.mkdirSync(fakeHome, { recursive: true });
// seed 90min of fake samples so charts render immediately
const now = Date.now(), fine = [];
for (let i = 90 * 60; i >= 0; i -= 45) fine.push({ t: now - i * 1000, m: (0.5 + 0.3 * Math.sin(i / 600)) * 2 ** 30, l: 4 * 2 ** 30, c: 1.5 + Math.cos(i / 400) });
fs.writeFileSync(path.join(wt, 'data', 'sysinfo-history.json'), JSON.stringify({ fine, coarse: fine.filter((_, i) => i % 20 === 0) }));
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', `--user-data-dir=${scratch('syspanel-chrome')}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {}; try { srv.kill('SIGKILL'); } catch {}; try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}; try { fs.rmSync(scratch('syspanel-chrome'), { recursive: true, force: true }); } catch {}; try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 40 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = l.find((t) => t.type === 'page'); } catch { await sleep(250); } }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw'); return r.result.value; };
await cdp('Page.enable'); await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await evalJs('new Promise(r => { const t = setInterval(() => { if (window.app) { clearInterval(t); r(); } }, 100); })');
await evalJs('app.ready'); await sleep(2500);
// open the System rail panel
await evalJs(`(() => { app.sidebar.toggle(true); const it = document.querySelector('.rail-item[data-rail="system"]'); if (!it) throw new Error('no system rail item'); it.click(); return 1; })()`);
await sleep(2500);
const st1 = await evalJs(`(() => ({
  canvases: document.querySelectorAll('.sys-hist-chart').length,
  charts: (app.sidebar._railSysCharts || []).length,
  chips: document.querySelectorAll('.sys-range-chip').length,
  bars: document.querySelectorAll('.sys-bar').length,
}))()`);
check('hist markup built (3 canvases)', st1.canvases === 3); // mem/cpu/loop-lag (2.243.0)
check('2 Chart instances live', st1.charts === 2);
check('3 range chips', st1.chips === 3);
check('live zone rendered (bars>0)', st1.bars > 0);
// range chip click
await evalJs(`(() => { document.querySelector('.sys-range-chip[data-r="1h"]').click(); return 1; })()`);
await sleep(1200);
check('range switch keeps 2 charts', await evalJs(`(app.sidebar._railSysCharts || []).length`) === 2);
// THE regression: switch away must not throw/brick
const sw = await evalJs(`(() => { try { document.querySelector('.rail-item[data-rail="folders"]').click(); return { ok: true }; } catch (e) { return { ok: false, err: String(e) }; } })()`);
await sleep(800);
check('switch away from System does not throw', sw.ok);
const st2 = await evalJs(`(() => ({ charts: (app.sidebar._railSysCharts || []).length, foldersActive: !!document.querySelector('.rail-item[data-rail="folders"].active, .rail-item[data-rail="folders"].on') }))()`);
check('charts destroyed on leave', st2.charts === 0);
// switch back
await evalJs(`(() => { document.querySelector('.rail-item[data-rail="system"]').click(); return 1; })()`);
await sleep(2500);
check('re-entry renders charts again', await evalJs(`(app.sidebar._railSysCharts || []).length`) === 2);
const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 330, height: 700, scale: 2 } });
fs.writeFileSync('/tmp/sys-panel.png', Buffer.from(shot.data, 'base64'));
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
