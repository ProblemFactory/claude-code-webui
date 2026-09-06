#!/usr/bin/env node
// Incident-capture contract smoke (2.238.0): POST /api/incident writes a
// bundle with client rings + server state, append attaches a follow-up,
// /api/incidents lists, and pruning keeps the newest 30.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3993, wt = '/tmp/vs-incident-smoke';
let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? ' — ' + e : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: repo, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js']) execSync(`rm -rf ${wt}/${f} && cp -r ${repo}/${f} ${wt}/${f}`);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), VIBESPACE_SKIP_AGENT_HOOKS: '1' }, stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {}; try { execSync(`git worktree remove --force ${wt}`, { cwd: repo, stdio: 'ignore' }); } catch {} });
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const post = async (url, body) => (await fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const r = await post('/api/incident', { note: 'test note 现场', version: '0.0.0', rings: { action: [{ t: 1, k: 'ptr', el: 'div#x' }], ws: [], console: [{ t: 1, l: 'error', m: 'boom' }] }, snapshot: { windows: [], sessions: [] } });
check('capture returns an inc- id', /^inc-[a-z0-9-]+$/.test(r.id || ''), JSON.stringify(r));
const bundle = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'incidents', r.id, 'bundle.json'), 'utf8'));
check('bundle holds note + client rings', bundle.note === 'test note 现场' && bundle.client.rings.action[0].el === 'div#x');
check('bundle holds server state (sessions + console ring + uptime)', Array.isArray(bundle.server.sessions) && Array.isArray(bundle.server.console) && bundle.server.uptimeS >= 0);
const a = await post(`/api/incident/${r.id}/append`, { rings: { action: [] }, snapshot: {} });
check('follow-up append ok', a.ok === true && fs.existsSync(path.join(wt, 'data', 'incidents', r.id, 'followup.json')));
const bad = await post('/api/incident/inc-../../etc/append', {});
check('append rejects a traversal id', bad.error != null);
// prune: fabricate 35 old incidents → capture → ≤30 remain
for (let i = 0; i < 35; i++) {
  const d = path.join(wt, 'data', 'incidents', `inc-0aaa${String(i).padStart(2, '0')}-test`);
  fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'bundle.json'), '{"id":"x","at":"","note":""}');
}
await post('/api/incident', { note: 'prune trigger', rings: {}, snapshot: {} });
const left = fs.readdirSync(path.join(wt, 'data', 'incidents')).filter((d) => d.startsWith('inc-'));
check(`prune keeps ≤30 (${left.length})`, left.length <= 30);
const list = await (await fetch(`http://127.0.0.1:${PORT}/api/incidents`)).json();
check('list returns newest incidents with notes', Array.isArray(list.incidents) && list.incidents.length > 0 && 'note' in list.incidents[0]);

// ── FREEZE THE SCENE (2.239.0): the volatile facts a user's own
// troubleshooting would destroy must be copied out, asynchronously, and the
// pending marker must clear when the freeze completes.
const dir = path.join(wt, 'data', 'incidents', r.id);
// plant a session meta + a fake transcript so the freeze has something to grab
const metaDir = path.join(wt, 'data', 'session-meta');
fs.mkdirSync(metaDir, { recursive: true });
fs.writeFileSync(path.join(metaDir, 'cw-99-test.json'), JSON.stringify({ sessionId: 'sess-99-test', name: 'frozen probe' }));
const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const cacheDir = path.join(wt, 'data', 'remote-jsonl', 'host-test');
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, CID + '.jsonl'), '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"u2"}\n');
const r2 = await post('/api/incident', { note: 'freeze test', rings: {}, snapshot: { sessions: [{ id: CID, host: 'host-test' }] } });
const dir2 = path.join(wt, 'data', 'incidents', r2.id);
check('pending marker written immediately', fs.existsSync(path.join(dir2, 'env.json.pending')) || fs.existsSync(path.join(dir2, 'env.json')));
for (let i = 0; i < 60 && !fs.existsSync(path.join(dir2, 'env.json')); i++) await sleep(500);
check('env.json produced by the async freeze', fs.existsSync(path.join(dir2, 'env.json')));
const env = JSON.parse(fs.readFileSync(path.join(dir2, 'env.json'), 'utf8'));
check('process table captured (the kill-erases-it evidence)', Array.isArray(env.local.processes) && env.local.processes.length > 0);
check('session metas frozen as real copies', fs.existsSync(path.join(dir2, 'frozen', 'session-meta', 'cw-99-test.json'))
  && JSON.parse(fs.readFileSync(path.join(dir2, 'frozen', 'session-meta', 'cw-99-test.json'), 'utf8')).name === 'frozen probe');
const tr = env.local.transcripts?.[CID];
check('transcript fingerprinted (sha256 + size) for the referenced conversation', Array.isArray(tr) && tr.length > 0 && /^[0-9a-f]{64}$/.test(tr[0].sha256 || ''), JSON.stringify(tr));
check('transcript tail frozen to disk', fs.readdirSync(path.join(dir2, 'frozen', 'transcripts')).some((f) => f.startsWith(CID)));
check('targets include the referenced host', (env.targets?.hostIds || []).includes('host-test'));
// the meta a later kill would clobber: prove the frozen copy is independent
fs.writeFileSync(path.join(metaDir, 'cw-99-test.json'), JSON.stringify({ sessionId: null, name: 'CLOBBERED' }));
check('frozen copy survives the original being clobbered',
  JSON.parse(fs.readFileSync(path.join(dir2, 'frozen', 'session-meta', 'cw-99-test.json'), 'utf8')).name === 'frozen probe');
check('pending marker cleared after freeze', !fs.existsSync(path.join(dir2, 'env.json.pending')));

// ── B-8ebb (last row): the freeze reaches CODEX rollouts too — through the
// harness registry's store.locate (never a codex ternary in incident.js).
// A codex thread id referenced by the report, its rollout in the remote-jsonl
// cache (the local ~/.codex tree is the real user's — untouched), must land in
// env.local.transcripts with identity + a frozen tail, tagged with its harness.
const TID = '01a07000-0000-7000-8000-0000000000ee';
const cxCache = path.join(wt, 'data', 'remote-jsonl', 'host-test', 'codex');
fs.mkdirSync(cxCache, { recursive: true });
fs.writeFileSync(path.join(cxCache, TID + '.jsonl'), '{"timestamp":"2026-09-05T10:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"' + TID + '","cwd":"/w","cli_version":"0.153.4"}}\n{"timestamp":"2026-09-05T10:00:01.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"frozen codex probe"}]}}\n');
const r3 = await post('/api/incident', { note: 'codex freeze', rings: {}, snapshot: { sessions: [{ id: TID, backend: 'codex', host: 'host-test' }, { id: CID, host: 'host-test' }] } });
const dir3 = path.join(wt, 'data', 'incidents', r3.id);
for (let i = 0; i < 60 && !fs.existsSync(path.join(dir3, 'env.json')); i++) await sleep(500);
const env3 = JSON.parse(fs.readFileSync(path.join(dir3, 'env.json'), 'utf8'));
const cx = env3.local.transcripts?.[TID];
check('codex rollout fingerprinted through the harness store (sha256 + size + harness tag)', Array.isArray(cx) && cx.length === 1 && /^[0-9a-f]{64}$/.test(cx[0].sha256 || '') && cx[0].harness === 'codex' && cx[0].size > 0, JSON.stringify(cx));
check('codex rollout tail frozen to disk (.tail.jsonl named by its cache dir)', fs.readdirSync(path.join(dir3, 'frozen', 'transcripts')).some((f) => f.startsWith(TID) && f.endsWith('.tail.jsonl')));
check('the frozen codex tail is the real bytes', fs.readFileSync(path.join(dir3, 'frozen', 'transcripts', fs.readdirSync(path.join(dir3, 'frozen', 'transcripts')).find((f) => f.startsWith(TID))), 'utf8').includes('frozen codex probe'));
check('the claude conversation in the same report still freezes exactly once (locate dedups against the scan)', Array.isArray(env3.local.transcripts?.[CID]) && env3.local.transcripts[CID].length === 1);
// the remote probe is built from every harness's store.remoteFind — claude's line unchanged, codex's added
const inc = (await import(path.join(repo, 'src', 'incident.js'))).default || (await import('node:module')).createRequire(import.meta.url)(path.join(repo, 'src', 'incident.js'));
const probe = inc.buildRemoteTranscriptProbe([CID, TID]);
check('remote probe: claude find line = the pre-B-8ebb expression', probe.includes(`find "$HOME"/.claude/projects -maxdepth 2 -name "${CID}.jsonl" 2>/dev/null | head -3); do probe_transcript "$f" "claude"; done`), probe.slice(0, 300));
check('remote probe: codex rollouts (.jsonl and .jsonl.zst) probed under $HOME/.codex/sessions', probe.includes(`rollout-*${TID}.jsonl.zst`) && probe.includes('"$HOME"/.codex/sessions') && probe.includes('probe_transcript "$f" "codex"'), probe.slice(-400));
check('REMOTE_SCRIPT defines probe_transcript once and embeds the per-harness lines', (() => { const s = inc.REMOTE_SCRIPT([CID]); return s.includes('probe_transcript() {') && s.includes('probe_transcript "$f" "claude"') && !s.includes('$HOME/.claude/projects -maxdepth 2 -name "$cid.jsonl"'); })());
check('incident.js carries no backend id branch (the registry is the only harness knowledge)', !/['"]codex['"]\s*\?|backend === ['"]codex['"]|=== ['"]claude['"]/.test(fs.readFileSync(path.join(repo, 'src', 'incident.js'), 'utf8')));

// ── 2.239.1: the dialog must actually render its submit button (the boss's
// "怎么提交" screenshot — shell.footer was undefined, appendChild threw, no
// button). Drive the REAL dialog in headless chrome and click through it.
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (CHROME) {
  const { spawn: sp } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const WebSocket = createRequire(import.meta.url)('ws');
  const chrome = sp(CHROME, ['--headless=new', '--remote-debugging-port=9341', '--no-first-run', '--disable-gpu', '--user-data-dir=/tmp/vs-inc-chrome', 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {}; try { fs.rmSync('/tmp/vs-inc-chrome', { recursive: true, force: true }); } catch {} });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9341/json')).json()).find((x) => x.type === 'page'); } catch { await sleep(250); }
  }
  const cws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => cws.on('open', r));
  let seq = 0; const pend = new Map();
  cws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); cws.send(JSON.stringify({ id, method, params })); });
  const evaljs = async (expr) => {
    const rr = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (rr.result?.exceptionDetails) throw new Error(JSON.stringify(rr.result.exceptionDetails).slice(0, 300));
    return rr.result?.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 60; i++) { if (await evaljs('!!(window.app && window.app.captureIncident)').catch(() => false)) break; await sleep(400); }
  const ui = await evaljs(`(async () => {
    window.app.captureIncident();
    await new Promise((r) => setTimeout(r, 300));
    // scope to the NEWEST overlay — a fresh instance also shows the
    // onboarding dialog, and document-order querySelector grabs that one
    const ovs = document.querySelectorAll('.dialog-overlay');
    const ov = ovs[ovs.length - 1];
    const btn = ov?.querySelector('.dialog-actions .btn-create');
    const ta = ov?.querySelector('.dialog-body textarea');
    if (!btn || !ta) return { ok: false, btn: !!btn, ta: !!ta };
    ta.value = 'ui e2e note';
    btn.click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const idEl = ov?.querySelector('.dialog-body .mono');
      if (idEl && /^inc-/.test(idEl.textContent.trim())) return { ok: true, id: idEl.textContent.trim() };
    }
    return { ok: false, stuck: document.querySelector('.dialog-body')?.textContent?.slice(0, 120) };
  })()`);
  check('dialog renders the Capture button AND click-through yields an inc- id', ui?.ok === true, JSON.stringify(ui));
  if (ui?.ok) {
    const b2 = JSON.parse(fs.readFileSync(path.join(wt, 'data', 'incidents', ui.id, 'bundle.json'), 'utf8'));
    check('UI-driven capture wrote the note from the textarea', b2.note === 'ui e2e note');
  }
  cws.close();
} else console.log('  (chrome absent — dialog render check skipped)');

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
