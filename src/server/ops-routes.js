'use strict';
// OPS ROUTES (decomposition #11): version/update visibility, the detached
// UI-driven self-update op, and maintenance mode. Extracted VERBATIM. ORCH tier.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

function create({ app, rootDir, wss, WS_OPEN }) {
// ── Version / update visibility (⚙ menu shows current + latest at the Update entry) ──
// Latest = the canonical repo's master package.json — fetched LAZILY on
// request only (never a background timer), cached 6h, best-effort: offline
// instances just show the local version.
const versionInfo = { fetchedAt: 0, latest: null, commit: null };
// ── UI-driven self-update (2.111.21): the update runs as a DETACHED op with
// its output in data/update.log; the client shows a progress dialog, keeps
// polling across the restart (KillMode=process / the container supervisor
// leave the detached script alive), and reloads when /api/version changes.
// Replaced the "suddenly opens a terminal that just sits there" flow.
let _selfUpdate = null; // { pid, startedAt }
const _updateLogPath = path.join(rootDir, 'data', 'update.log');
app.post('/api/self-update', (req, res) => {
  try {
    if (!fs.existsSync(path.join(rootDir, 'scripts', 'update.sh'))) return res.status(400).json({ error: 'update script not found' });
    if (_selfUpdate) { try { process.kill(_selfUpdate.pid, 0); return res.json({ success: true, already: true }); } catch { _selfUpdate = null; } }
    // The pid map dies with the server (the update's own restart!) while the
    // DETACHED script keeps running — unlinking its live log here sent the
    // first run's remaining output to an unlinked inode and spawned a second
    // concurrent update.sh. A recent log without the exit sentinel = a run
    // still in flight; hand the dialog the existing log instead. (update.sh
    // also flocks data/.update.lock as the hard guard.)
    try {
      const st = fs.statSync(_updateLogPath);
      if (Date.now() - st.mtimeMs < 10 * 60 * 1000) {
        const fd = fs.openSync(_updateLogPath, 'r');
        const len = Math.min(st.size, 4000);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        if (!buf.toString('utf8').includes('__UPDATE_EXIT:')) return res.json({ success: true, already: true });
      }
    } catch {}
    try { fs.unlinkSync(_updateLogPath); } catch {}
    const fd = fs.openSync(_updateLogPath, 'a');
    // Run the LATEST update script, not the checkout's (2.368.11, the history-
    // rewrite stranding): a fix to update logic rides the very update that is
    // broken — the old script could never pull it (chicken-and-egg; the miku
    // fleet froze exactly this way). origin/master's script is the same trust
    // domain as the code the update is about to pull and run anyway; fetch
    // failure (offline) falls back to the checkout's copy.
    const child = spawn('bash', ['-c',
      'UP=scripts/update.sh; ' +
      'if git fetch origin master --quiet 2>/dev/null && git show origin/master:scripts/update.sh > data/.update-latest.sh 2>/dev/null && [ -s data/.update-latest.sh ]; then UP=data/.update-latest.sh; fi; ' +
      'bash "$UP"; echo "__UPDATE_EXIT:$?"'], {
      cwd: rootDir, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, VIBESPACE_SUPERVISED: process.env.VIBESPACE_SUPERVISED || '1' },
    });
    fs.closeSync(fd);
    child.unref();
    _selfUpdate = { pid: child.pid, startedAt: Date.now() };
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/self-update/status', (req, res) => {
  let log = '';
  try {
    const st = fs.statSync(_updateLogPath);
    const fd = fs.openSync(_updateLogPath, 'r');
    const len = Math.min(st.size, 6000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    log = buf.toString('utf8');
  } catch {}
  let running = false;
  if (_selfUpdate) { try { process.kill(_selfUpdate.pid, 0); running = true; } catch {} }
  res.json({ running, log });
});

// ── Maintenance mode (2.189.0): operator-onsite transparency ──
// When someone (an admin / a support agent) is actively connected to this
// instance troubleshooting it, a persistent banner tells the user so. State
// survives server restarts (troubleshooting often restarts the server) and
// AUTO-EXPIRES (default 2h, max 24h) so a forgotten toggle can't linger.
const MAINT_FILE = path.join(rootDir, 'data', 'maintenance.json');
let _maintenance = null;
try { _maintenance = JSON.parse(fs.readFileSync(MAINT_FILE, 'utf-8')); } catch {}
function maintState() {
  if (_maintenance?.active && _maintenance.until && Date.now() > _maintenance.until) _maintenance = { active: false };
  return _maintenance?.active ? _maintenance : { active: false };
}
app.get('/api/maintenance', (req, res) => res.json(maintState()));
app.post('/api/maintenance', (req, res) => {
  const b = req.body || {};
  if (b.update != null && _maintenance?.active) {
    // live progress line ("checking the transcript cache…") — the banner shows
    // the latest one and keeps a timeline; each update EXTENDS the expiry
    // (active troubleshooting must not expire mid-work; hard cap 24h from start)
    const upd = { ts: Date.now(), text: String(b.update).slice(0, 300) };
    _maintenance.updates = [...(_maintenance.updates || []), upd].slice(-50);
    _maintenance.until = Math.min((_maintenance.since || Date.now()) + 24 * 3600e3,
      Math.max(_maintenance.until || 0, Date.now() + 3600e3));
  } else if (b.on) {
    const hours = Math.min(24, Math.max(0.25, Number(b.hours) || 2));
    _maintenance = {
      active: true,
      message: String(b.message || '').slice(0, 300),
      by: String(b.by || '').slice(0, 80),
      since: Date.now(),
      until: Date.now() + hours * 3600e3,
      updates: [],
    };
  } else {
    _maintenance = { active: false };
  }
  try { fs.writeFileSync(MAINT_FILE, JSON.stringify(_maintenance)); } catch {}
  const json = JSON.stringify({ type: 'maintenance-updated', maintenance: maintState() });
  wss.clients.forEach((c) => { if (c.readyState === WS_OPEN) { try { c.send(json); } catch {} } });
  res.json({ success: true, maintenance: maintState() });
});

// ── HEAVY RELEASE-GATE RESULTS (2026-09-07, the fast/heavy gate split) ──
// The pre-push hook runs the FAST tier and then launches the HEAVY tier
// detached (scripts/ci.mjs --heavy), which writes data/ci-heavy/<sha>.{green,
// red}. That verdict lands minutes after the developer walked away, so it
// needs a place a human can find it without knowing the file layout: the
// ⚙ → Diagnostics report reads this route (and `npm run ci:status` prints the
// same records at the terminal). Read-only, tiny local JSON files, no git —
// "is HEAD blocked?" is an ancestry question and belongs to the CLI.
const CI_HEAVY_DIR = path.join(rootDir, 'data', 'ci-heavy');
app.get('/api/ci-heavy', (req, res) => {
  const runs = [], running = [];
  try {
    for (const f of fs.readdirSync(CI_HEAVY_DIR)) {
      const m = /^([0-9a-f]{7,40})\.(green|red|pid)$/.exec(f);
      if (!m) continue;
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(path.join(CI_HEAVY_DIR, f), 'utf-8')); } catch {}
      const row = { sha: rec.sha || m[1], result: m[2] === 'pid' ? 'running' : m[2], startedAt: rec.startedAt || 0, endedAt: rec.endedAt || 0, ms: rec.ms || 0, suites: rec.suites || 0, failed: Array.isArray(rec.failed) ? rec.failed.slice(0, 20) : [], flaky: Array.isArray(rec.flaky) ? rec.flaky.slice(0, 20) : [], pid: rec.pid || 0 };
      if (m[2] === 'pid') { let live = false; try { process.kill(row.pid, 0); live = true; } catch {} if (live) running.push(row); }
      else runs.push(row);
    }
  } catch { /* no directory yet = no runs; not an error */ }
  runs.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  res.json({ runs: runs.slice(0, 12), running });
});

app.get('/api/version', async (req, res) => {
  if (versionInfo.commit === null) {
    try { versionInfo.commit = execFileSync('git', ['-C', rootDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8', timeout: 3000 }).trim(); }
    catch { versionInfo.commit = ''; }
  }
  // 15min TTL (was 6h — during active release evenings the gear menu showed
  // "no update" for hours; real report). ?fresh=1 (the update dialog / menu
  // open) bypasses the cache with a 60s floor so clicks can't hammer GitHub.
  const _verTtl = req.query.fresh ? 60 * 1000 : 15 * 60 * 1000;
  if (Date.now() - versionInfo.fetchedAt > _verTtl) {
    versionInfo.fetchedAt = Date.now(); // stamped even on failure — no hammering while offline
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch('https://raw.githubusercontent.com/ProblemFactory/vibespace/master/package.json', { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) versionInfo.latest = (await r.json()).version || null;
    } catch {}
  }
  res.json({ version: require(require('path').join(rootDir, 'package.json')).version, commit: versionInfo.commit || null, latest: versionInfo.latest });
});

// Changelog diff for the update-confirm dialog (user directive: clicking
// Update shows every change between the running and latest versions first).
// Canonical repo's CHANGELOG.md, lazily fetched + cached like /api/version.
function versionNewerThan(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
app.get('/api/changelog-diff', async (req, res) => {
  const cur = require(require('path').join(rootDir, 'package.json')).version;
  if (Date.now() - (versionInfo.clFetchedAt || 0) > (req.query.fresh ? 60 * 1000 : 15 * 60 * 1000)) {
    versionInfo.clFetchedAt = Date.now(); // stamped even on failure — offline-safe
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch('https://raw.githubusercontent.com/ProblemFactory/vibespace/master/CHANGELOG.md', { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) versionInfo.changelog = await r.text();
    } catch {}
  }
  const all = [];
  for (const block of String(versionInfo.changelog || '').split(/\n## /).slice(1)) {
    const nl = block.indexOf('\n');
    const head = (nl < 0 ? block : block.slice(0, nl)).trim();
    const ver = (head.match(/^(\d+\.\d+\.\d+)/) || [])[1];
    if (!ver) continue;
    all.push({ version: ver, head, body: nl < 0 ? '' : block.slice(nl + 1).trim() });
  }
  const entries = all.filter((e) => versionNewerThan(e.version, cur));
  // Already on the latest? Show the CURRENT version's own changelog entry
  // (matched, else the newest) instead of an empty dialog (user request).
  const atLatest = entries.length === 0;
  if (atLatest && all.length) entries.push(all.find((e) => e.version === cur) || all[0]);
  res.json({ current: cur, latest: versionInfo.latest || null, entries, atLatest });
});


  return { versionInfo, maintState };
}
module.exports = { create };
