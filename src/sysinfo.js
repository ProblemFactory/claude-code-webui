// System info + memory-pressure watch (2.216.0 — userL's instance was
// OOMKilled at its 32Gi pod limit after a week of process accumulation; the
// pod-level kill takes EVERY dtach session with it, and nothing warned).
// read() = container-aware snapshot for the System rail panel; startWatch()
// = cheap cgroup poll that broadcasts a `sysinfo-alert` (amber ≥80% of the
// limit, red ≥92%) with the top RSS consumers, so the user can kill the
// culprit BEFORE the kernel kills everything.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Container-aware memory: cgroup v2 → v1 → host meminfo. /sys reads are
// kernel-backed and never hang (unlike FUSE paths — safe to read sync).
//
// ⚠ WHAT "USED" MEANS (2.312.0, a fleet user's false 100% alarm): a cgroup's
// `memory.current` COUNTS THE PAGE CACHE. A pod that merely reads big files
// (transcripts, a dataset pass) parks tens of GB of reclaimable file cache
// there and sits pinned at the limit forever — memory.events showed `max 770`
// reclaim events and `oom_kill 0`, i.e. the kernel calmly reclaiming, while
// the panel screamed 100% and every process together held 2.7 GB. Reporting
// raw `current` is therefore not "conservative", it is WRONG: the number never
// falls, so the one alert that matters (a real leak) can never stand out.
// We report the WORKING SET (`current − inactive_file`) — the same definition
// kubectl top / cadvisor use and the one Kubernetes evicts on — and carry the
// raw + cache figures alongside so the UI can explain the difference.
// NOTE this is also what the REMOTE host probe already computed (MemTotal −
// MemAvailable, which excludes reclaimable cache): the local twin had drifted.
/** key→number over a "<key> <num>[ unit]" file — covers BOTH cgroup
 *  memory.stat ("anon 1659514880") and /proc/meminfo ("MemAvailable: 12 kB",
 *  aligned with spaces and unit-suffixed; a naive first-space split yields NaN
 *  there). Units are NOT converted — callers know their file. */
function memStat(file) {
  const m = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const mm = /^(\S+?):?\s+(\d+)/.exec(line);
      if (mm) m.set(mm[1], Number(mm[2]));
    }
  } catch { }
  return m;
}

function memInfo() {
  try { // cgroup v2
    const raw = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'), 10);
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const limit = maxRaw === 'max' ? 0 : parseInt(maxRaw, 10);
    if (Number.isFinite(raw)) {
      const st = memStat('/sys/fs/cgroup/memory.stat');
      const inactiveFile = st.get('inactive_file') || 0;
      const cache = st.get('file') || 0;
      const anon = st.get('anon') || 0;
      const used = Math.max(0, raw - inactiveFile);
      return { used, limit: limit || os.totalmem(), raw, cache, anon, source: 'cgroup2' };
    }
  } catch { }
  try { // cgroup v1
    const raw = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'), 10);
    let limit = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'), 10);
    if (!Number.isFinite(limit) || limit > os.totalmem() * 4) limit = 0; // "unlimited" sentinel
    if (Number.isFinite(raw)) {
      const st = memStat('/sys/fs/cgroup/memory/memory.stat');
      const inactiveFile = st.get('total_inactive_file') ?? st.get('inactive_file') ?? 0;
      const cache = st.get('total_cache') ?? st.get('cache') ?? 0;
      const anon = st.get('total_rss') ?? st.get('rss') ?? 0;
      const used = Math.max(0, raw - inactiveFile);
      return { used, limit: limit || os.totalmem(), raw, cache, anon, source: 'cgroup1' };
    }
  } catch { }
  // Bare host: os.freemem() also ignores reclaimable cache — prefer
  // MemAvailable, the kernel's own "can be handed out without swapping".
  const total = os.totalmem();
  const mi = memStat('/proc/meminfo'); // kB values
  const avail = (mi.get('MemAvailable') || 0) * 1024;
  const raw = total - os.freemem();
  return { used: avail ? Math.max(0, total - avail) : raw, limit: total, raw, source: 'host' };
}

// macOS has no /proc and no cgroups: the working-set analogue is vm_stat's
// active + wired + compressor pages (what the old remote SCRIPT computed —
// its interpretation moved here when the script became the fallback rung).
// Async because vm_stat is a child process; the sync memInfo() stays the
// cheap /sys path for the Linux watch loop.
function memInfoDarwin() {
  return new Promise((resolve) => {
    execFile('sysctl', ['-n', 'hw.memsize', 'vm.pagesize'], { timeout: 4000 }, (e1, out1) => {
      const [total, pageRaw] = String(out1 || '').split('\n').map((x) => parseInt(x, 10));
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 4096;
      if (e1 || !Number.isFinite(total) || !total) return resolve(null);
      execFile('vm_stat', [], { timeout: 4000 }, (e2, out2) => {
        if (e2) return resolve(null);
        let pages = 0;
        for (const ln of String(out2).split('\n')) {
          const m = /^Pages (active|wired down|occupied by compressor):\s+(\d+)/.exec(ln);
          if (m) pages += Number(m[2]);
        }
        resolve({ used: pages * page, limit: total, raw: pages * page, source: 'darwin' });
      });
    });
  });
}

async function memInfoAsync() {
  if (process.platform === 'darwin') {
    const d = await memInfoDarwin();
    if (d) return d;
  }
  return memInfo();
}

// `ps` output is unbounded by process count AND argv length: a busy dev box
// (2463 processes, one `claude -p <29 KB prompt>`) produced 4.4 MB of `ps aux`,
// past the old 4 MiB maxBuffer — execFile then fails and topProcs answered []
// (the sysinfo op shipped an EMPTY top-procs list and the release gate went red,
// 2.369.68). 32 MiB bounds ~100k such rows; width flags (--cols) are GNU-only
// and would break the BSD/macOS rung, so the bound lives on the buffer.
const PS_MAX_BUFFER = 32 * 1024 * 1024;

function topProcs(n = 8) {
  return new Promise((resolve) => {
    execFile('ps', ['aux', '--sort=-rss'], { timeout: 5000, maxBuffer: PS_MAX_BUFFER }, (err, out) => {
      const parse = (text) => text.split('\n').slice(1).filter(Boolean).map((ln) => {
        const f = ln.trim().split(/\s+/);
        // USER PID %CPU %MEM VSZ RSS TTY STAT START TIME CMD…
        return { pid: parseInt(f[1], 10), pcpu: parseFloat(f[2]) || 0, rss: (parseInt(f[5], 10) || 0) * 1024, cmd: f.slice(10).join(' ').slice(0, 400) };
      }).filter((p) => p.pid);
      if (!err) return resolve(parse(out).slice(0, n));
      // BSD ps (no --sort): sort ourselves
      execFile('ps', ['aux'], { timeout: 5000, maxBuffer: PS_MAX_BUFFER }, (e2, out2) => {
        if (e2) return resolve([]);
        resolve(parse(out2).sort((a, b) => b.rss - a.rss).slice(0, n));
      });
    });
  });
}

// ── Full process table (2.354.0, the btop-like process manager) ──
// ONE implementation for every machine: the server runs it for machine #0,
// the daemon bundles it and serves the `proc-list` op, and the ssh fallback
// rung runs the same `ps axo` line remotely with parsePsProcs() interpreting
// orchestrator-side — the columns and their meaning live HERE only.
const PS_COLUMNS = 'user=,pid=,ppid=,pcpu=,pmem=,rss=,stat=,etime=,args=';

/** Parse `ps axo ${PS_COLUMNS}` output: 8 whitespace fields + args rest.
 *  (unix usernames have no whitespace; stat/etime are single tokens) */
function parsePsProcs(text) {
  const rows = [];
  for (const ln of String(text || '').split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    // drop OUR OWN probe (owner report: "永远有个ps在最顶端" at 200%): ps
    // lists itself, and its %CPU = lifetime-cpu / elapsed — a process alive
    // for ~10ms that burned ~20ms across threads reads as 200%, and its pid
    // is new every poll so the live-delta correction never applies. Matching
    // our exact column string hides only the probe (its `sh -c` wrapper on
    // the remote rung too), never a user's own `ps aux`.
    if (t.includes(PS_COLUMNS)) continue;
    const f = t.split(/\s+/);
    if (f.length < 9) continue;
    const pid = parseInt(f[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({
      user: f[0], pid, ppid: parseInt(f[2], 10) || 0,
      pcpu: parseFloat(f[3]) || 0, pmem: parseFloat(f[4]) || 0,
      rss: (parseInt(f[5], 10) || 0) * 1024, state: f[6], etime: f[7],
      cmd: f.slice(8).join(' ').slice(0, 400),
    });
  }
  return rows;
}

/** Transport cap: top-by-RSS ∪ top-by-CPU, so a CPU-sorted client still has
 *  the hot processes even when the table is truncated. CPU rank uses the
 *  LIVE sample when present (review-confirmed: ps %CPU is a lifetime average
 *  that shows 0.0 for a long-lived process that JUST started spinning — for
 *  a 10-day-old process it takes ~14min of burn to even reach 0.1, so ranking
 *  by it alone dropped exactly the runaway the panel exists to catch). */
function capProcs(all, max = 350) {
  max = Math.max(20, Math.min(2000, Math.floor(Number(max) || 350))); // clamp — a negative/fractional max breaks the slice math
  if (all.length <= max) return all;
  const cpu = (p) => Math.max(p.pcpu || 0, p.pcpuNow || 0);
  const byRss = [...all].sort((a, b) => b.rss - a.rss).slice(0, Math.floor(max * 0.75));
  const chosen = new Set(byRss.map((p) => p.pid));
  const byCpu = [...all].sort((a, b) => cpu(b) - cpu(a)).filter((p) => !chosen.has(p.pid)).slice(0, max - byRss.length);
  return byRss.concat(byCpu);
}

// Instantaneous CPU% (what btop shows; ps %CPU is a LIFETIME average that
// flatlines long-running processes): delta of /proc/<pid>/stat utime+stime
// between successive calls. Keyed pid:starttime so a recycled pid never
// inherits the old sample (the counter-capture class). /proc reads are
// kernel-backed and never hang (same justification as memInfo's /sys reads).
// First call has no baseline → callers fall back to ps %CPU; the 5s panel
// poll makes every later call a good sample. macOS/BSD: no /proc — ps only.
const _procCpu = new Map(); // 'pid:starttime' → { ticks, at }
function sampleProcCpu(rows) {
  if (process.platform !== 'linux') return false;
  const now = Date.now();
  const seen = new Set();
  let any = false;
  for (const r of rows) {
    try {
      const st = fs.readFileSync('/proc/' + r.pid + '/stat', 'utf8');
      const close = st.lastIndexOf(')'); // comm may contain spaces/parens
      if (close < 0) continue;
      const rest = st.slice(close + 2).split(' ');
      // fields after comm: [0]=state(3) … utime(14)→[11], stime(15)→[12], starttime(22)→[19]
      const ticks = (parseInt(rest[11], 10) || 0) + (parseInt(rest[12], 10) || 0);
      const key = r.pid + ':' + rest[19];
      seen.add(key);
      const prev = _procCpu.get(key);
      _procCpu.set(key, { ticks, at: now });
      if (prev && now > prev.at) {
        // % of ONE core (btop convention — multithreaded may exceed 100)
        r.pcpuNow = Math.max(0, Math.round(((ticks - prev.ticks) / 100) / ((now - prev.at) / 1000) * 1000) / 10);
        any = true;
      }
    } catch { /* exited between ps and the sample */ }
  }
  if (_procCpu.size > 2000) for (const k of _procCpu.keys()) if (!seen.has(k)) _procCpu.delete(k);
  return any;
}

/** The full table for the System panel's process manager.
 *  Returns { procs, total, sampled } — `sampled` says pcpuNow is live. */
function listProcs({ max = 350 } = {}) {
  return new Promise((resolve) => {
    execFile('ps', ['axo', PS_COLUMNS], { timeout: 8000, maxBuffer: PS_MAX_BUFFER }, (err, out) => {
      if (err) return resolve({ procs: [], total: 0, sampled: false, error: String(err.message || err).slice(0, 200) });
      const all = parsePsProcs(out);
      // sample the WHOLE table BEFORE capping (review-confirmed ordering bug:
      // capping first meant both cap membership and sampling were chosen by
      // the flatlined lifetime %CPU, so a newly-hot low-RSS process on a
      // >max-proc machine never got sampled and never shipped; a full sweep
      // is ~7ms for ~1000 /proc stat reads)
      const sampled = sampleProcCpu(all);
      const procs = capProcs(all, max);
      resolve({ procs, total: all.length, sampled });
    });
  });
}

function diskInfo(dir) {
  return new Promise((resolve) => {
    execFile('df', ['-kP', dir], { timeout: 8000 }, (err, out) => {
      if (err) return resolve(null);
      const f = (out.split('\n')[1] || '').trim().split(/\s+/);
      const total = (parseInt(f[1], 10) || 0) * 1024, used = (parseInt(f[2], 10) || 0) * 1024;
      resolve(total ? { total, used, pct: Math.round(used / total * 100), path: dir } : null);
    });
  });
}

async function read(dataDir) {
  const mem = await memInfoAsync();
  const [disk, procs] = await Promise.all([diskInfo(dataDir || process.cwd()), topProcs()]);
  return {
    mem: { ...mem, pct: mem.limit ? Math.round(mem.used / mem.limit * 100) : 0 },
    load: os.loadavg().map((v) => Math.round(v * 100) / 100),
    cpus: os.cpus().length,
    disk,
    procs,
    ts: Date.now(),
  };
}

// ── Resource HISTORY (2.223.0, user request: the admin panel's CPU/memory
// charts, self-contained in the instance): every watch tick samples container
// CPU (cgroup usage delta → cores) + memory into two rings — 24h at the 45s
// cadence and 7d at 15min — persisted to data/sysinfo-history.json (atomic,
// debounced) so charts survive restarts. No Prometheus dependency: works on
// bare Docker/self-hosted the same as in the fleet.
let _cpuPrev = null; // { usec, at }
function cpuUsageUsec() {
  try { // cgroup v2
    const m = /usage_usec (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'));
    if (m) return Number(m[1]);
  } catch { }
  try { // cgroup v1 (ns)
    return Number(fs.readFileSync('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8')) / 1000;
  } catch { }
  try { // host fallback: aggregate cpu times (ms → usec)
    const cpus = os.cpus();
    let busy = 0;
    for (const c of cpus) busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
    return busy * 1000;
  } catch { return null; }
}
function sampleCpuCores() {
  const usec = cpuUsageUsec();
  const at = Date.now();
  if (usec == null) return null;
  const prev = _cpuPrev; _cpuPrev = { usec, at };
  if (!prev || usec < prev.usec || at <= prev.at) return null;
  return Math.round(((usec - prev.usec) / ((at - prev.at) * 1000)) * 100) / 100;
}
const _hist = { fine: [], coarse: [], loadedFrom: null }; // fine: 45s×24h, coarse: 15min×7d
const FINE_MAX = Math.ceil(24 * 3600 / 45), COARSE_MAX = Math.ceil(7 * 24 * 4);
let _histDirty = false, _histFile = null, _lastCoarseAt = 0;
function loadHistory(dataDir) {
  _histFile = path.join(dataDir, 'sysinfo-history.json');
  try {
    const d = JSON.parse(fs.readFileSync(_histFile, 'utf8'));
    if (Array.isArray(d.fine)) _hist.fine = d.fine.slice(-FINE_MAX);
    if (Array.isArray(d.coarse)) _hist.coarse = d.coarse.slice(-COARSE_MAX);
  } catch { }
}
function persistHistory() {
  if (!_histFile || !_histDirty) return;
  _histDirty = false;
  try {
    const tmp = _histFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ fine: _hist.fine, coarse: _hist.coarse }));
    fs.renameSync(tmp, _histFile);
  } catch { }
}
let _lastLoopLag = 0; // most recent 500ms-drift sample, folded into history
function recordSample(mem, cores) {
  const pt = { t: Date.now(), m: mem.used, l: mem.limit, c: cores, e: _lastLoopLag };
  _hist.fine.push(pt);
  if (_hist.fine.length > FINE_MAX) _hist.fine.splice(0, _hist.fine.length - FINE_MAX);
  if (pt.t - _lastCoarseAt >= 15 * 60 * 1000) { // 15-min ring: max-mem + avg-cpu over the window
    const winFrom = pt.t - 15 * 60 * 1000;
    const win = _hist.fine.filter((x) => x.t >= winFrom);
    const cs = win.map((x) => x.c).filter((v) => v != null);
    _hist.coarse.push({
      t: pt.t, l: pt.l,
      m: Math.max(...win.map((x) => x.m), 0),
      c: cs.length ? Math.round(cs.reduce((a, b) => a + b, 0) / cs.length * 100) / 100 : null,
      e: Math.max(...win.map((x) => x.e || 0), 0), // worst loop lag in the window (B-bb68)
    });
    if (_hist.coarse.length > COARSE_MAX) _hist.coarse.splice(0, _hist.coarse.length - COARSE_MAX);
    _lastCoarseAt = pt.t;
  }
  _histDirty = true;
}
function history(rangeMs) {
  const from = Date.now() - rangeMs;
  // fine ring covers ≤24h; longer ranges serve the coarse ring
  const src = rangeMs <= 24 * 3600 * 1000 ? _hist.fine : _hist.coarse;
  return src.filter((p) => p.t >= from);
}

// Memory-pressure watch: amber ≥80%, red ≥92% of the container limit.
// Re-alerts on ESCALATION immediately, otherwise once per 30min per level;
// fully clears below 75% so a later climb alerts again.
function startWatch({ broadcast, dataDir, intervalMs = 45000 } = {}) {
  let lastLevel = 0, lastAlertAt = 0;
  // ── Event-loop lag watch (2.235.0, userL "卡了2h但CPU不高" incident): the
  // ONE metric that caught that degradation was loop lag, and it lived only in
  // telemetry (visible after the fact). Sample drift every 500ms, keep a
  // 3-min window, alert on SUSTAINED degradation: median >300ms amber /
  // >800ms red (median, not max — a single big GC pause must not page anyone).
  // Same cooldown discipline as the memory watch.
  const lagWin = [];
  let lastLag = Date.now(), lagLevel = 0, lagAlertAt = 0;
  const lagT = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - lastLag - 500);
    lastLag = now;
    lagWin.push({ t: now, lag });
    while (lagWin.length && lagWin[0].t < now - 3 * 60 * 1000) lagWin.shift();
    _lastLoopLag = lag; // picked up by recordSample into history
    if (lagWin.length < 60) return; // need a real window before judging
    const sorted = lagWin.map((x) => x.lag).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const level = med >= 800 ? 2 : med >= 300 ? 1 : 0;
    if (level === 0) { if (med < 150) lagLevel = 0; return; }
    const cooldown = level > lagLevel ? 0 : 30 * 60 * 1000;
    if (now - lagAlertAt < cooldown) return;
    lagAlertAt = now; lagLevel = level;
    console.warn(`[sysinfo] event-loop degradation: median lag ${med}ms over 3min (level ${level}) — the server thread is saturated (big parses / sync work), machine CPU% will NOT show this`);
    global.__vsEvent?.('evloop-degraded', { detail: `median ${med}ms level${level}` });
    broadcast?.({ type: 'sysinfo-alert', kind: 'evloop', level, lagMs: med });
  }, 500);
  lagT.unref?.();
  if (dataDir) loadHistory(dataDir);
  sampleCpuCores(); // prime the delta baseline
  const persistT = setInterval(persistHistory, 5 * 60 * 1000);
  persistT.unref?.();
  const t = setInterval(async () => {
    try {
      const mem = memInfo();
      recordSample(mem, sampleCpuCores());
      const pct = mem.limit ? (mem.used / mem.limit) * 100 : 0;
      global.__vsMetric?.('srv-container-mem-pct', Math.round(pct));
      const level = pct >= 92 ? 2 : pct >= 80 ? 1 : 0;
      if (level === 0) { if (pct < 75) lastLevel = 0; return; }
      const cooldown = level > lastLevel ? 0 : 30 * 60 * 1000;
      if (Date.now() - lastAlertAt < cooldown) return;
      lastAlertAt = Date.now(); lastLevel = level;
      const procs = await topProcs(5);
      console.warn(`[sysinfo] memory pressure: ${Math.round(pct)}% of ${Math.round(mem.limit / 1073741824)}Gi (level ${level}) — top: ${procs.slice(0, 3).map((p) => `${Math.round(p.rss / 1048576)}M ${p.cmd.slice(0, 60)}`).join(' | ')}`);
      global.__vsEvent?.('memory-pressure', { detail: `${Math.round(pct)}% level${level}` });
      broadcast?.({ type: 'sysinfo-alert', level, pct: Math.round(pct), used: mem.used, limit: mem.limit, procs });
    } catch { }
  }, intervalMs);
  t.unref?.();
  return () => { clearInterval(t); clearInterval(lagT); clearInterval(persistT); persistHistory(); };
}

module.exports = { read, startWatch, memInfo, memInfoAsync, history, persistHistory, listProcs, parsePsProcs, capProcs, PS_COLUMNS };
