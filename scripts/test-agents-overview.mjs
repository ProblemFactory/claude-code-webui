// Agents machine-sectioned account+quota overview (2.245.0) — worktree +
// headless-chrome CDP smoke. Verifies: /api/usage `hostAccounts` (boot-loaded
// from usage-cache/host-<hid>-<aid>.json) + /api/accounts `verdicts` survive;
// the Agents rail panel renders STACKED machine sections (local + one per
// host, no host selector left); the ⟳ Refresh-all button exists, is
// clickable, and a failed target renders an INLINE per-row error (never
// silent); the usage popup lost its Remote-hosts section and gained the
// "Full overview →" door into the Agents panel.
// 2.245.2 regression guards (real screenshot: donut clusters at different x
// per row): with FABRICATED mixed-state rows (fresh w/ scoped bucket / stale
// w/ age / no data / inline refresh error + the CLI-login row) every visible
// cluster's RIGHT EDGE must be equal ±1px at panel widths ~460/340/260, donut
// rendered size equal, and the ≤340px pill swap intact. Plus: the billing
// switcher renders water-level-colored quota (labelHtml) with scoped buckets,
// escHtml'd (a hostile account name must not inject).
// NETWORK SAFETY: every fabricated token is EXPIRED — loggedIn stays true
// (presence-based) but usageToken/getOAuthToken return null, so Refresh-all
// fails fast inline WITHOUT ever contacting Anthropic.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { freePorts, scratch } from './scratch.mjs';
const require = createRequire(new URL('../server.js', import.meta.url));
const repo = process.cwd();
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs) — fixed ports collided across concurrent gates
const wt = scratch('agentsov-test'), fakeHome = scratch('agentsov-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, c) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}`); } };
try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
execSync('npm run build', { cwd: wt, stdio: 'ignore' });
fs.rmSync(fakeHome, { recursive: true, force: true });
fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
// Machine login present-but-EXPIRED: CLI-login row renders (with donuts from
// the seeded cache) while getOAuthToken() stays null (no Anthropic calls).
const expiredCreds = JSON.stringify({ claudeAiOauth: { accessToken: 'expired-test-token', expiresAt: Date.now() - 1000 } });
fs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), expiredCreds);
fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'machine@example.com' } }));
// Seed the usage caches: a machine-login snapshot (so the popup renders its
// claude section → the overview link appears) + a host-held account snapshot
// (exercises the boot loader's host-vs-host-account filename disambiguation).
const cacheDir = path.join(wt, 'data', 'usage-cache');
fs.mkdirSync(cacheDir, { recursive: true });
const mkSnap = (o = {}) => ({ fiveHour: { utilization: 0.42, status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600 }, sevenDay: { utilization: 0.87, status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 86400 }, scopedWeekly: [], overallStatus: 'allowed', fetchedAt: Date.now(), ...o });
fs.writeFileSync(path.join(cacheDir, '__global__.json'), JSON.stringify(mkSnap()));
fs.writeFileSync(path.join(cacheDir, 'host-host-deadbeef-sub-abcdefabcdef.json'), JSON.stringify({ ...mkSnap(), name: 'HeldAcct' }));
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=1280,1000', `--user-data-dir=${scratch('agentsov-chrome')}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {}; try { srv.kill('SIGKILL'); } catch {}; try { execSync(`git worktree remove --force ${wt}`, { stdio: 'ignore' }); } catch {}; try { fs.rmSync(scratch('agentsov-chrome'), { recursive: true, force: true }); } catch {}; try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

// ── server-side asserts ──
const usage = await (await fetch(`http://127.0.0.1:${PORT}/api/usage`)).json();
check('/api/usage has hostAccounts', usage && typeof usage.hostAccounts === 'object');
check('boot loader keyed the held snapshot host:acct', !!usage.hostAccounts?.['host-deadbeef:sub-abcdefabcdef']);
check('held file NOT mis-loaded as a plain host', !usage.hosts?.['host-deadbeef-sub-abcdefabcdef']);
const acc = await (await fetch(`http://127.0.0.1:${PORT}/api/accounts`)).json();
check('/api/accounts still returns verdicts', acc && typeof acc.verdicts === 'object');
let r = await (await fetch(`http://127.0.0.1:${PORT}/api/usage/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'host-x', account: 'BAD id!' }) })).json();
check('refresh {host,account}: bad account id rejected', /bad account id/.test(r?.error || ''));
r = await (await fetch(`http://127.0.0.1:${PORT}/api/usage/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'host-x', account: 'sub-abcdefabcdef' }) })).json();
check('refresh {host,account}: unknown host rejected', /unknown host/.test(r?.error || ''));
// Dead host record → a second machine section that must render honestly.
r = await (await fetch(`http://127.0.0.1:${PORT}/api/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DeadHost', user: 'nobody', host: '127.0.0.1', port: 1 }) })).json();
check('dead host record added', !!r?.success);
// ── fabricate mixed-state subscription accounts (2.245.2 alignment guard) ──
const mkSub = async (name) => (await (await fetch(`http://127.0.0.1:${PORT}/api/accounts/subscription`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json());
const A = await mkSub('Fresh Max'), B = await mkSub('Stale Max'), C = await mkSub('NoData Max'), D = await mkSub('Err Max'), E = await mkSub('Ev<il> & "Max"');
for (const s of [A, B, C, D, E]) fs.writeFileSync(path.join(wt, 'data', 'subs', s.id, '.credentials.json'), expiredCreds);
fs.writeFileSync(path.join(cacheDir, A.id + '.json'), JSON.stringify(mkSnap({ scopedWeekly: [{ name: 'Fable', utilization: 0.41, resetsAt: 0 }], scopedFetchedAt: Date.now() })));
fs.writeFileSync(path.join(cacheDir, B.id + '.json'), JSON.stringify(mkSnap({ fetchedAt: Date.now() - 2 * 3600e3 })));
fs.writeFileSync(path.join(cacheDir, D.id + '.json'), JSON.stringify(mkSnap()));

// ── UI asserts (CDP) ──
const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 40 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = l.find((t) => t.type === 'page'); } catch { await sleep(250); } }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res) => ws.on('open', res));
let seq = 0; const pend = new Map(); const jsErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') jsErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
});
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (e) => { const rr = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (rr.exceptionDetails) throw new Error(rr.exceptionDetails.exception?.description || 'threw'); return rr.result.value; };
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await evalJs('new Promise(r => { const t = setInterval(() => { if (window.app) { clearInterval(t); r(); } }, 100); })');
await evalJs('app.ready'); await sleep(1500);
await evalJs(`localStorage.setItem('vibespace.quotaRefreshAck', '1'); 1`);
// Open the Agents rail panel
await evalJs(`(() => { app.sidebar.toggle(true); const it = document.querySelector('.rail-item[data-rail="agents"]'); if (!it) throw new Error('no agents rail item'); it.click(); return 1; })()`);
// Local section fills fast; the dead host's ssh probes fail within seconds.
await sleep(6000);
const st1 = await evalJs(`(() => ({
  secs: document.querySelectorAll('.agents-machine-sec').length,
  localGlobalRow: !!document.querySelector('.agents-machine-sec[data-host=""] .acct-key-row[data-id="__global__"]'),
  refreshAll: !!document.querySelector('.agents-refresh-all'),
  oldSelector: !!document.querySelector('.agents-host-select'),
  hostSec: !!document.querySelector('.agents-machine-sec:not([data-host=""])'),
}))()`);
// 2.262.0 tabs: default = Accounts (the LOCAL roster only); hosts moved to
// the Machines tab's accordion (asserted after the tab switch below).
check('accounts tab renders exactly the local section', st1.secs === 1 && !st1.hostSec);
check('local section has the CLI-login row', st1.localGlobalRow);
check('⟳ Refresh-all button present', st1.refreshAll);
check('host selector is gone', !st1.oldSelector);
check('tab bar renders', await evalJs(`document.querySelectorAll('.agents-tab').length === 3`));
// ── donut-column alignment (2.245.2 regression guard, real pixels) ──
// Inject the inline refresh-error DOM shape into one row (same markup the
// real fan-out failure path appends), then sweep panel widths.
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.agents-machine-sec[data-host=""] .acct-key-row')];
  const row = rows.find(r => r.querySelector('.acct-key-name')?.textContent === 'Err Max');
  if (!row) throw new Error('Err Max row missing');
  const e = document.createElement('span'); e.className = 'acct-refresh-err usage-warn';
  e.textContent = '⚠ refresh failed (rate-limited or offline) — kept last-known';
  row.querySelector('.acct-key-main').appendChild(e);
  return 1;
})()`);
const measureRows = () => evalJs(`(() => {
  const out = [];
  for (const row of document.querySelectorAll('.agents-machine-sec[data-host=""] .acct-key-row')) {
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    const cluster = row.querySelector('.acct-usage');
    const mini = row.querySelector('.acct-usage-mini');
    const rect = (el) => { const r = el.getBoundingClientRect(); return { r: r.right, w: r.width, h: r.height }; };
    const donuts = [...row.querySelectorAll('.acct-usage-donut')].filter(vis).map(rect);
    out.push({
      name: row.querySelector('.acct-key-name')?.textContent || row.dataset.id,
      clusterR: vis(cluster) ? rect(cluster).r : null,
      miniR: vis(mini) ? rect(mini).r : null,
      donuts,
    });
  }
  return out;
})()`);
// sidebar width = rail strip (44px) + panel; 504/384/304 ⇒ panel ≈460/340/260
for (const [sbw, panel, mode] of [[504, 460, 'donut'], [384, 340, 'pill'], [304, 260, 'pill']]) {
  await evalJs(`(() => { app.sidebar.el.style.width='${sbw}px'; app.sidebar._applySidebarLayoutWidth?.(); return 1; })()`);
  await sleep(500);
  const rows = await measureRows();
  const key = mode === 'donut' ? 'clusterR' : 'miniR';
  const edges = rows.map((x) => x[key]).filter((v) => v != null);
  const spread = edges.length ? Math.max(...edges) - Math.min(...edges) : 999;
  check(`panel ~${panel}px: ≥4 rows show a ${mode} cluster (got ${edges.length})`, edges.length >= 4);
  check(`panel ~${panel}px: cluster right edges aligned ±1px (spread ${spread.toFixed(1)}px)`, spread <= 1);
  if (mode === 'donut') {
    const sizes = rows.flatMap((x) => x.donuts).flatMap((d) => [d.w, d.h]);
    const sspread = sizes.length ? Math.max(...sizes) - Math.min(...sizes) : 999;
    check(`panel ~${panel}px: donut sizes equal across rows (spread ${sspread.toFixed(1)}px)`, sizes.length >= 8 && sspread <= 0.5);
    check(`panel ~${panel}px: pill hidden in donut mode`, rows.every((x) => x.miniR == null));
  } else {
    check(`panel ~${panel}px: donuts hidden in pill mode (swap intact)`, rows.every((x) => x.clusterR == null));
  }
}
await evalJs(`(() => { app.sidebar.el.style.width=''; app.sidebar._applySidebarLayoutWidth?.(); return 1; })()`);
// 2.262.0 tabs: host sections live under the Machines tab (single host
// auto-expands its accordion card).
await evalJs(`(() => { [...document.querySelectorAll('.agents-tab')].find((b) => /Machines|机器/.test(b.textContent))?.click(); return 1; })()`);
await sleep(800);
check('machines tab shows the accordion card', await evalJs(`!!document.querySelector('.agents-mach-acc[data-host]')`));
// Wait out the dead host's probe failures, then check honest state.
for (let i = 0; i < 20; i++) { if (await evalJs(`!document.querySelector('.agents-machine-sec:not([data-host=""]) .ob-loading')`)) break; await sleep(1000); }
const st2 = await evalJs(`(() => {
  const sec = document.querySelector('.agents-machine-sec:not([data-host=""])');
  return { filled: !sec.querySelector('.ob-loading'), globalRow: !!sec.querySelector('.acct-key-row[data-id="__global__"]') };
})()`);
check('dead host section filled (probe failure did not wedge it)', st2.filled);
check('dead host section has its CLI-login row', st2.globalRow);
// Refresh-all: clickable; every target holds an EXPIRED token (or a dead
// host), so each must FAIL INLINE on its row — and never contact Anthropic.
await evalJs(`(() => { const b = document.querySelector('.agents-refresh-all'); b.click(); return 1; })()`);
for (let i = 0; i < 25; i++) { if (await evalJs(`!!document.querySelector('.agents-machine-sec:not([data-host=""]) .acct-refresh-err')`)) break; await sleep(1000); }
check('failed refresh target rendered an inline per-row error (dead host)', await evalJs(`!!document.querySelector('.agents-machine-sec:not([data-host=""]) .acct-refresh-err')`));
// LOCAL rows live on the Accounts tab now — switch, re-click (throttled
// replies also render inline, which is the honest surface here).
await evalJs(`(() => { [...document.querySelectorAll('.agents-tab')].find((b) => /Accounts|账号/.test(b.textContent))?.click(); return 1; })()`);
await sleep(1200);
await evalJs(`(() => { const b = document.querySelector('.agents-refresh-all'); b.click(); return 1; })()`);
for (let i = 0; i < 25; i++) { if (await evalJs(`document.querySelectorAll('.agents-machine-sec[data-host=""] .acct-refresh-err').length >= 2`)) break; await sleep(1000); }
check('failed LOCAL targets rendered inline errors too', await evalJs(`document.querySelectorAll('.agents-machine-sec[data-host=""] .acct-refresh-err').length >= 2`));
// ── billing switcher: labelHtml quota preview (2.245.2) ──
await evalJs(`(() => { app.showBillingSwitcher({ backend: 'claude', backendSessionId: null, name: 'T' }, { x: 300, y: 200 }); return 1; })()`);
await sleep(400);
const sw = await evalJs(`(() => {
  const m = document.querySelector('.context-menu');
  if (!m) return { menu: false };
  return {
    menu: true,
    coloredPcts: m.querySelectorAll('.context-menu-item span[style*="color"]').length,
    hasScoped: /Fa\\s*\\d+%/.test(m.textContent),
    evilLiteral: m.textContent.includes('Ev<il> & "Max"'),
    injected: !!m.querySelector('il, img'),
  };
})()`);
check('billing switcher menu opens', sw.menu);
check('switcher rows carry water-level-colored percentages', sw.coloredPcts >= 4);
check('scoped bucket (Fa) appears in the preview', sw.hasScoped);
check('hostile account name renders as literal text (escHtml)', sw.evilLiteral && !sw.injected);
await evalJs(`(() => { document.querySelector('.context-menu')?.remove(); return 1; })()`);
// Usage popup: Remote-hosts section gone, Full-overview door present.
await evalJs(`(() => { document.getElementById('taskbar-usage').click(); return 1; })()`);
await sleep(600);
const st3 = await evalJs(`(() => { const p = document.getElementById('usage-popup'); return {
  open: !p.classList.contains('hidden'),
  hostRefresh: !!p.querySelector('.usage-host-refresh'),
  overview: !!p.querySelector('.usage-overview-link'),
}; })()`);
check('usage popup opens', st3.open);
check('popup Remote-hosts section removed', !st3.hostRefresh);
check('popup has the Full-overview door', st3.overview);
await evalJs(`(() => { document.querySelector('#usage-popup .usage-overview-link').click(); return 1; })()`);
await sleep(800);
const st4 = await evalJs(`(() => ({
  popupHidden: document.getElementById('usage-popup').classList.contains('hidden'),
  agentsActive: !!document.querySelector('.rail-item[data-rail="agents"].active'),
}))()`);
check('overview door closes the popup', st4.popupHidden);
check('overview door lands on the Agents rail panel', st4.agentsActive);
// ── Add-subscription flow opens the login terminal (inc-mslfbdjv regression:
// a dialog-scope `refresh()` called from the standalone method threw a
// ReferenceError BEFORE openShellTerminal — the click was a silent no-op).
// Drive the REAL flow: method → name dialog → confirm → a terminal window.
const winsBefore = await evalJs(`app.wm.windows.size`);
await evalJs(`(() => { app._addSubscription(); return 1; })()`);
await sleep(500);
const dlgOk = await evalJs(`(() => {
  const ovs = [...document.querySelectorAll('.dialog-overlay')];
  const ov = ovs[ovs.length - 1];
  const inp = ov?.querySelector('input, textarea');
  if (!inp) return false;
  inp.value = 'Smoke Sub';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  // the confirm button carries the confirmText ('Continue') — click by text,
  // never by class (the shell's button classes are not part of this contract)
  const btn = [...ov.querySelectorAll('button')].find((b) => /continue|确定|OK/i.test(b.textContent || ''));
  btn?.click();
  return !!btn;
})()`);
check('add-subscription name dialog confirmed', dlgOk);
await sleep(2500);
const addRes = await evalJs(`(() => ({
  wins: app.wm.windows.size,
  hasTerminal: [...app.wm.windows.values()].some((w) => w.type === 'terminal'),
}))()`);
check(`login terminal opened (windows ${winsBefore} → ${addRes.wins})`, addRes.wins > winsBefore && addRes.hasTerminal);

const realErrors = jsErrors.filter((e) => !/favicon|net::|Failed to load resource/.test(e));
check('no JS errors', realErrors.length === 0);
if (realErrors.length) console.error('   errors:', realErrors.slice(0, 5));
const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 460, height: 1000, scale: 1.5 } });
fs.writeFileSync('/tmp/agents-overview.png', Buffer.from(shot.data, 'base64'));
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
