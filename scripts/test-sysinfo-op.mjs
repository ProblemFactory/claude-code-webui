#!/usr/bin/env node
// The sysinfo device op (2.314.0, CS separation): local and remote machine
// snapshots share ONE implementation (src/sysinfo.js) — the daemon bundles it
// and runs it where the facts live. This was a missed twin-set: the local
// panel and the ssh script each interpreted "used memory" separately, and the
// interpretations DRIFTED (the false-100% incident: raw memory.current vs
// working set). Pins: (1) the op returns the module's own shape byte-
// compatible with the local read; (2) the capability gates an old daemon;
// (3) the ssh-script fallback's parse still yields the same field names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sysop-'));
process.env.HOME = home;
process.env.VIBESPACE_AGENTD_ROOT = path.join(home, 'agentd-root');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sysop-data-'));

const { DeviceManager } = require(REPO + '/src/agentd/client.js');
const dm = new DeviceManager({ dataDir, bundlePath: path.join(REPO, 'data/bin/vibespace-agentd.js'), version: '0.0.0-t', nodeModules: path.join(REPO, 'node_modules'), log: () => { } });
await dm.connect();

// 1. capability advertised + op works against a REAL daemon
const conn = await dm.connect();
ok(conn.info?.capabilities?.includes?.('sysinfo'), 'daemon advertises the sysinfo capability');
const r = await dm.sysinfo();
ok(r && r.mem && Number.isFinite(r.mem.used) && Number.isFinite(r.mem.limit), `op returns mem used/limit (${Math.round((r?.mem?.used || 0) / 1048576)}M / ${Math.round((r?.mem?.limit || 0) / 1073741824)}Gi)`);
ok(Number.isFinite(r.mem.pct), 'mem.pct computed');
ok(Array.isArray(r.load) && r.load.length === 3, 'loadavg triple');
ok(Number.isFinite(r.cpus) && r.cpus > 0, 'cpu count');
ok(Array.isArray(r.procs) && r.procs.length > 0 && r.procs.every((p) => p.pid && Number.isFinite(p.rss)), 'top procs with pid+rss');

// 2. SAME implementation: the op's numbers come from the module the server
// itself runs — mem.limit must agree exactly (same cgroup/host source).
const sysinfo = require(REPO + '/src/sysinfo.js');
const local = await sysinfo.read(process.cwd());
ok(r.mem.limit === local.mem.limit, `op limit === local module limit (one source: ${r.mem.source})`);
ok(r.mem.source === local.mem.source, `same source tag both sides (${r.mem.source})`);

// 3. drift guard: the ssh fallback script must keep producing the SAME field
// names the route serves, or a daemon-less host silently changes shape.
const srv = fs.readFileSync(path.join(REPO, 'src/server/sysinfo-wiring.js'), 'utf-8'); // moved in decomposition #3
ok(/REMOTE_SYSINFO_SCRIPT[\s\S]{0,200}FALLBACK RUNG/i.test(srv) || /fallback rung/i.test(srv.slice(srv.indexOf('REMOTE_SYSINFO_SCRIPT') - 800, srv.indexOf('REMOTE_SYSINFO_SCRIPT'))), 'script is documented as the fallback rung');
ok(/dm\.sysinfo\(\)/.test(srv), 'remoteSysinfo tries the device op first');
const cli = fs.readFileSync(path.join(REPO, 'src/agentd/client.js'), 'utf-8');
ok(/daemon lacks sysinfo \(capabilities gate\)/.test(cli), 'client refuses old daemons via the capability gate');

// 4. proc-list op (2.354.0, the process manager): capability + full-table
// shape + the same-module parity that keeps local and remote in one truth.
ok(conn.info?.capabilities?.includes?.('proc-list'), 'daemon advertises the proc-list capability');
const pl = await dm.procList();
ok(Array.isArray(pl.procs) && pl.procs.length > 5, `proc-list returns a real table (${pl.procs?.length} rows of ${pl.total})`);
ok(pl.procs.every((p) => Number.isFinite(p.pid) && typeof p.user === 'string' && Number.isFinite(p.rss) && typeof p.cmd === 'string' && typeof p.state === 'string'), 'rows carry pid/user/rss/cmd/state');
ok(Number.isFinite(pl.total) && pl.total >= pl.procs.length, 'total count >= transported rows');
const localPl = await sysinfo.listProcs();
const localKeys = Object.keys(localPl.procs[0] || {}).filter((k) => k !== 'pcpuNow').sort().join(',');
const opKeys = Object.keys(pl.procs[0] || {}).filter((k) => k !== 'pcpuNow').sort().join(',');
ok(localKeys === opKeys && localKeys.length > 0, `op row shape === local module row shape (${opKeys})`);
// second call gives sampleProcCpu its delta baseline → live CPU% appears
const pl2 = await dm.procList();
ok(pl2.sampled === true && pl2.procs.some((p) => p.pcpuNow != null), 'second call carries live-sampled CPU% (linux delta)');
ok(/daemon lacks proc-list \(capabilities gate\)/.test(cli), 'proc-list client method is capability-gated');

// 5. the shared parser + cap (the ssh fallback rung's interpretation)
// the probe must never list ITSELF (owner report: a 200% `ps` topped the CPU
// sort forever — ps computes %CPU over its own ~10ms lifetime and its pid is
// new every poll, so the live-delta correction never applies)
const withProbe = sysinfo.parsePsProcs(`me 50 1 200 0.0 6000 R+ 00:00 ps axo ${sysinfo.PS_COLUMNS}\nme 51 1 150 0.0 2000 S+ 00:00 sh -c ps axo ${sysinfo.PS_COLUMNS}\nme 52 1 1.0 0.0 3000 S+ 05:00 ps aux\n`);
ok(withProbe.length === 1 && withProbe[0].pid === 52, 'own probe rows (incl. sh -c wrapper) are dropped; a user ps aux stays');
const livePl = await sysinfo.listProcs();
ok(!livePl.procs.some((p) => p.cmd.includes(sysinfo.PS_COLUMNS)), 'live table carries no self-probe row');
const parsed = sysinfo.parsePsProcs('root     1     0  0.1  0.2  1234 Ss   10:33 /sbin/init splash\nme   22 1 99.5 1.0 2048 R+ 1-02:03:04 node server.js --flag\n\nbadline\n');
ok(parsed.length === 2 && parsed[0].pid === 1 && parsed[0].user === 'root' && parsed[0].rss === 1234 * 1024, 'parsePsProcs: fields land (pid/user/rss)');
ok(parsed[1].pcpu === 99.5 && parsed[1].etime === '1-02:03:04' && parsed[1].cmd === 'node server.js --flag', 'parsePsProcs: cpu/etime/multi-word cmd');
const many = Array.from({ length: 500 }, (_, i) => ({ pid: i + 1, rss: i, pcpu: i === 3 ? 99 : 0 }));
const capped = sysinfo.capProcs(many, 100);
ok(capped.length === 100 && capped.some((p) => p.pid === 4), 'capProcs keeps the CPU-hot row even when RSS-cold');
// review pins (2.354.0): a LIVE-hot process must survive the cap even when
// its lifetime pcpu is flatlined at 0 — pcpuNow participates in the rank
const live = Array.from({ length: 500 }, (_, i) => ({ pid: i + 1, rss: i, pcpu: 0, pcpuNow: i === 7 ? 98 : 0 }));
ok(sysinfo.capProcs(live, 100).some((p) => p.pid === 8), 'capProcs ranks by live pcpuNow, not just the flatlined lifetime average');
ok(sysinfo.capProcs(many, -5).length > 0 && sysinfo.capProcs(many, 3.7).length >= 20, 'capProcs clamps a hostile max');
const siSrc = fs.readFileSync(path.join(REPO, 'src/sysinfo.js'), 'utf-8');
ok(siSrc.indexOf('sampleProcCpu(all)') !== -1 && siSrc.indexOf('sampleProcCpu(all)') < siSrc.indexOf('capProcs(all, max)'), 'listProcs samples the WHOLE table before capping (cap-by-flatlined-pcpu bug)');
// THE SIGNAL VERDICT'S EXISTENCE PROBE (B-3185 r6). It used to be spelled
// `ps -p ${pid}` at BOTH sites, pinned here as "never kill -0" — and that pin
// was half a truth: a BARE `kill -0` really would report every
// permission-denied kill as "no such process" (kill(2) with sig 0 runs the
// same permission check), but `ps -p` has no `-p` under busybox at all, so on
// such a host the post-signal aliveness check answered OK-GONE for a LIVE
// process and signalProc returned `{ok:true, gone:true}` — a manufactured
// success, not a mislabel. Both sites now call the SHARED `vs_alive` ladder
// (src/cli-identity.js), in which a `kill -0` FAILURE is handed to
// `[ -d /proc/N ]` and then `ps -p N` rather than believed. The functional
// legs (busybox, live pids, negative controls) are test-writer-sweep §17;
// these are the structural pins that keep this file's copy honest.
const { signalVerdictScript } = require(REPO + '/src/server/sysinfo-wiring.js');
const sigText = signalVerdictScript(4242, 'TERM');
ok(!/else if kill -0 \d/.test(sigText) && !/if kill -0 \d/.test(sigText),
  'signal verdict never uses a BARE kill -0 as the EPERM/ESRCH split (its failure is ambiguous)');
ok(!/ps -p \d+/.test(sigText) && !/ps -p \$\{pid\}/.test(srv),
  'signal verdict carries no bare `ps -p <pid>` existence test (busybox `ps` has no -p)');
ok(sigText.includes(require(REPO + '/src/cli-identity.js').pidAliveShellFn()),
  'signal verdict embeds the SHARED vs_alive ladder verbatim — one probe, one author, no per-site reason to get wrong');

try { await dm.stop?.(); } catch { }
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
