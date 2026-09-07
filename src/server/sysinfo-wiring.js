'use strict';
// SYSINFO WIRING (decomposition #3): the remote machine snapshot ladder —
// device op first, ssh script fallback. Extracted verbatim; `hosts` arrives
// lazily (created later in boot order). ORCH tier.
const sysinfo = require('../sysinfo');
const { pidAliveShellFn } = require('../cli-identity');

// Signal a process — the ONE user-facing kill path for every machine. sig is
// enum-whitelisted and pid integer-validated BEFORE any shell string is built.
const PROC_SIGS = new Set(['TERM', 'KILL', 'INT', 'HUP', 'STOP', 'CONT']);

/** THE remote signal verdict: signal → settle → report, one script for both
 *  remote rungs. Module-level and EXPORTED so the suite drives the shipped
 *  bytes rather than a copy (the (p) lesson: a control that cannot reach the
 *  code it guards is not a control).
 *
 *  EXISTENCE IS `vs_alive`, NEVER `ps -p` (B-3185 r6, found by review).
 *  Both questions this script asks — "is it still there after the signal
 *  landed?" and "why did the signal fail?" — used to be spelled
 *  `ps -p N >/dev/null 2>&1`, and busybox `ps` has NO `-p` (measured here,
 *  busybox 1.37.0: `ps: invalid option -- 'p'` + usage to stderr, exit 1,
 *  stdout empty). On a host whose shell lives in busybox that made BOTH
 *  answers wrong, and the first one is not a mislabel but a manufactured
 *  outcome:
 *    · SUCCESS branch — a live process that ignores SIGTERM (`trap "" TERM`,
 *      measured) reported `OK-GONE` ⇒ `{ok:true, gone:true}`: the process
 *      table flipped the row to gone while the process kept running.
 *    · FAILURE branch — a pid we may not signal reported `ESRCH` ⇒ "no such
 *      process (already gone)" instead of "permission denied" (measured).
 *  r5 enumerated this file as a sibling of `hosts.js killPidShell` and left
 *  the probe alone on the reason that its `ps -p` "sits on the FAILURE branch
 *  of a kill that was already attempted" — true of the SECOND call, and the
 *  script has two. The ladder is now shared text (src/cli-identity.js), so
 *  there is no per-site reason left to get wrong.
 *
 *  `kill -0` alone would NOT do: it fails EPERM exactly as the real kill did,
 *  so on the failure branch every permission-denied kill would read "no such
 *  process". That was r4's objection and it stands — which is why `vs_alive`
 *  hands a `kill -0` FAILURE down to `[ -d /proc/N ]` and `ps -p N` instead of
 *  believing it, and only a silent ladder means "gone".
 *
 *  Exit status: every branch ends in an `echo`, so the script exits 0 and
 *  `_ssh` (which rejects a non-zero exit) never sees a verdict as a failure. */
function signalVerdictScript(pid, sig) {
  const p = Number(pid);
  // validated HERE, at the one place that builds the shell text — never
  // "the caller checked it".
  if (!Number.isInteger(p) || p <= 1) throw new Error('invalid pid');
  if (!PROC_SIGS.has(sig)) throw new Error('unsupported signal');
  return `${pidAliveShellFn()}
if kill -${sig} ${p} 2>/dev/null; then `
    + (sig === 'STOP' || sig === 'CONT' ? 'echo OK; '
      : `sleep 0.5; if vs_alive ${p}; then echo OK-ALIVE; else echo OK-GONE; fi; `)
    + `else if vs_alive ${p}; then echo EPERM; else echo ESRCH; fi; fi`;
}

function create({ getHosts }) {
  const hostsProxy = new Proxy({}, { get: (_, k) => { const h = getHosts(); return typeof h[k] === 'function' ? h[k].bind(h) : h[k]; } });
  const hosts = hostsProxy;
// Remote machine snapshot for the System panel's machine switcher.
// ONE IMPLEMENTATION (2.314.0, CS separation — this was a missed twin-set):
// the daemon bundles src/sysinfo.js and the `sysinfo` op runs it ON the
// machine, so local and remote share one interpretation of "used memory"
// (working set). The interpretation had already drifted once between the two
// copies — the local panel read raw memory.current (page cache included) and
// pinned at a false 100% while this script correctly used MemTotal −
// MemAvailable. The script below is now only the FALLBACK RUNG for
// daemon-less ssh hosts; its raw-host semantics (MemTotal = limit, no
// cgroup awareness) are the fallback's known limitation, not the contract.
// History stays LOCAL-only — the sampler runs in this server.
const REMOTE_SYSINFO_SCRIPT = `
U=$(uname)
if [ "$U" = Darwin ]; then
  T=$(sysctl -n hw.memsize 2>/dev/null)
  P=$(sysctl -n vm.pagesize 2>/dev/null || echo 4096)
  W=$(vm_stat 2>/dev/null | awk -v p="$P" '/Pages (active|wired down|occupied by compressor)/ {gsub("\\\\.","",$NF); s+=$NF} END {print s*p}')
  echo "MEM \${W:-0} \${T:-0}"
  echo "LOAD $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
  echo "CPUS $(sysctl -n hw.ncpu 2>/dev/null)"
  df -k "$HOME" 2>/dev/null | tail -1 | awk '{print "DISK", $3*1024, ($3+$4)*1024}'
  ps ax -o rss=,pid=,command= 2>/dev/null | sort -k1,1 -rn | head -8 | sed 's/^ */PROC /'
else
  awk '/MemTotal/{t=$2*1024} /MemAvailable/{a=$2*1024} END{print "MEM", t-a, t}' /proc/meminfo
  echo "LOAD $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "CPUS $(nproc 2>/dev/null || echo 1)"
  df -k "$HOME" 2>/dev/null | tail -1 | awk '{print "DISK", $3*1024, ($3+$4)*1024}'
  ps ax -o rss=,pid=,args= --sort=-rss 2>/dev/null | head -8 | sed 's/^ */PROC /'
fi`;
async function remoteSysinfo(hostId) {
  const h = hosts.get(hostId);
  if (!h) throw new Error('unknown machine');
  // Ladder: device op (the shared module, run where the facts live) → ssh
  // script (daemon-less hosts) — the per-op fallback pattern every other
  // device op follows. Capability-gated: an old daemon is never asked.
  try {
    const dm = await hosts.deviceBounded(hostId, 6000);
    const r = await dm.sysinfo();
    if (r?.mem) return { host: hostId, ...r };
  } catch { /* fall through to the ssh script */ }
  const out = await hosts._hostShell(h, REMOTE_SYSINFO_SCRIPT, { timeoutMs: 8000 });
  const r = { host: hostId, procs: [] };
  for (const line of String(out).split('\n')) {
    const m = line.match(/^([A-Z]+) (.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'MEM') { const [u, t] = v.trim().split(/\s+/).map(Number); if (t > 0) r.mem = { used: u, limit: t, pct: Math.round(u / t * 100) }; }
    else if (k === 'DISK') { const [u, t] = v.trim().split(/\s+/).map(Number); if (t > 0) r.disk = { used: u, total: t, pct: Math.round(u / t * 100) }; }
    else if (k === 'LOAD') { const l = v.trim().split(/\s+/).slice(0, 3).filter(Boolean); if (l.length) r.load = l; }
    else if (k === 'CPUS') { const n = parseInt(v, 10); if (n > 0) r.cpus = n; }
    else if (k === 'PROC') { const pm = v.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); if (pm && r.procs.length < 8) r.procs.push({ rss: Number(pm[1]) * 1024, pid: Number(pm[2]), cmd: pm[3].slice(0, 400) }); }
  }
  if (!r.mem && !r.load && !r.procs.length) throw new Error('probe returned nothing usable');
  return r;
}
// ── Process manager (2.354.0, btop-like): full table + signal, same ladder ──
// The table's interpretation lives in ONE place (src/sysinfo.js): locally the
// server calls listProcs(), a daemon machine runs the same module via the
// proc-list op, and the ssh fallback rung runs the same `ps axo` line with
// parsePsProcs() interpreting the output orchestrator-side.
async function remoteProcs(hostId) {
  const h = hosts.get(hostId);
  if (!h) throw new Error('unknown machine');
  try {
    const dm = await hosts.deviceBounded(hostId, 6000);
    const r = await dm.procList();
    if (r?.procs) return { host: hostId, ...r };
  } catch { /* fall through to the ssh rung */ }
  const out = await hosts._hostShell(h, 'ps axo ' + sysinfo.PS_COLUMNS, { timeoutMs: 10000 });
  const all = sysinfo.parsePsProcs(out);
  if (!all.length) throw new Error('process listing returned nothing usable');
  // no CPU sampling on the ssh rung (stateless per call) — ps lifetime % only
  return { host: hostId, procs: sysinfo.capProcs(all), total: all.length, sampled: false };
}

// The ONE user-facing kill path for every machine — `hostId` is a parameter.
// The shell text it sends is built by signalVerdictScript (module level, so
// the suite can drive the shipped bytes).
async function signalProc(hostId, pidRaw, sigRaw) {
  const sig = String(sigRaw || 'TERM').toUpperCase().replace(/^SIG/, '');
  const pid = parseInt(pidRaw, 10);
  if (!PROC_SIGS.has(sig)) throw new Error('unsupported signal');
  if (!Number.isFinite(pid) || pid <= 1) throw new Error('invalid pid');
  if (!hostId) {
    if (pid === process.pid) throw new Error('that is the VibeSpace server itself — restart it via Update / systemctl, not a kill');
    try { process.kill(pid, 'SIG' + sig); } catch (e) {
      if (e.code === 'ESRCH') throw new Error('no such process (already gone)');
      if (e.code === 'EPERM') throw new Error("permission denied (another user's process)");
      throw e;
    }
    if (sig === 'STOP' || sig === 'CONT') return { ok: true };
    await new Promise((r) => setTimeout(r, 450));
    let gone = false;
    try { process.kill(pid, 0); } catch { gone = true; }
    return { ok: true, gone };
  }
  const h = hosts.get(hostId);
  if (!h) throw new Error('unknown machine');
  const script = signalVerdictScript(pid, sig);
  let out = '';
  // rung choice happens at CONNECT time only: once a device link exists, a
  // runCmd failure must NOT fall through to ssh — the signal may already have
  // landed and a blind re-send double-signals the process. Honesty over retry.
  let dm = null;
  try { dm = await hosts.deviceBounded(hostId, 6000); } catch { }
  if (dm) {
    try { out = String((await dm.runCmd('sh', ['-c', script], { timeoutMs: 8000 })).stdout || ''); }
    catch (e) { throw new Error('device link failed mid-signal (it may or may not have landed) — check the table and retry: ' + e.message); }
  } else out = String(await hosts._hostShell(h, script, { timeoutMs: 10000 }));
  if (out.includes('EPERM')) throw new Error("permission denied (another user's process)");
  if (out.includes('ESRCH')) throw new Error('no such process (already gone)');
  if (out.includes('OK-GONE')) return { ok: true, gone: true };
  if (out.includes('OK-ALIVE')) return { ok: true, gone: false };
  if (out.includes('OK')) return { ok: true };
  throw new Error('signal verdict unreadable: ' + out.slice(0, 120));
}

  return { sysinfo, remoteSysinfo, remoteProcs, signalProc };
}
module.exports = { create, signalVerdictScript, PROC_SIGS };
