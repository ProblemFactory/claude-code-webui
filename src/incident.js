/**
 * incident.js — FREEZE THE SCENE (2.239.0, the admin's correction to 2.238.0:
 * "他为了修复这个问题可能自己跑去机器里试图 resume、kill，现场就被破坏了").
 *
 * The panic button's value is not the UI timeline — it is that everything a
 * user's own troubleshooting DESTROYS is copied out first:
 *   · session metas + wrapper metas (clobbered by every kill/respawn)
 *   · dtach socket + process table (a kill erases the whole tree)
 *   · claude lock files (deleted on exit) — LOCAL and on every referenced host
 *   · transcript IDENTITY: size + mtime + sha256 (a manual `--resume` of a
 *     live id double-writes or forks; the hash proves divergence afterwards)
 *   · remote process table (the "is it actually still running" question that
 *     took a whole investigation to answer for userN's session)
 * Everything here is READ-ONLY and bounded: child processes with timeouts (a
 * hung mount must never wedge a capture — §2.108.3), size-capped file copies,
 * per-host probe caps, and every step individually try/caught so a dead host
 * degrades the bundle instead of failing it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// The harness registry names where each harness's conversations live
// (store.locate / store.remoteFind) — the freeze iterates it instead of
// knowing any backend (B-8ebb). Lazy: incident.js stays importable alone.
const listHarnesses = () => require('./harnesses').list();

const MAX_HOSTS = 6;
const MAX_CIDS = 12;
const META_COPY_MAX = 64 * 1024;      // per session-meta / wrapper-meta file
const BUF_TAIL = 256 * 1024;          // per session buffer tail
const TRANSCRIPT_TAIL = 512 * 1024;   // per local transcript tail

function sh(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => resolve(String(stdout || '') + (err && stderr ? '\n[stderr] ' + stderr : '')));
    } catch (e) { resolve('[failed] ' + e.message); }
  });
}

function statOf(fp) {
  try {
    const st = fs.statSync(fp);
    return { size: st.size, mtime: new Date(st.mtimeMs).toISOString(), mode: (st.mode & 0o777).toString(8), uid: st.uid };
  } catch (e) { return { error: e.code || e.message }; }
}

function sha256Head(fp, bytes = 0) {
  try {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(fp, 'r');
    try {
      const st = fs.fstatSync(fd);
      const len = bytes ? Math.min(bytes, st.size) : st.size;
      const CH = 1024 * 1024;
      const buf = Buffer.alloc(Math.min(CH, len || 1));
      let pos = 0;
      while (pos < len) {
        const n = fs.readSync(fd, buf, 0, Math.min(CH, len - pos), pos);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
        pos += n;
      }
      return h.digest('hex');
    } finally { fs.closeSync(fd); }
  } catch (e) { return 'err:' + (e.code || e.message); }
}

function copyCapped(src, dest, cap) {
  try {
    const st = fs.statSync(src);
    const fd = fs.openSync(src, 'r');
    try {
      const start = st.size > cap ? st.size - cap : 0;
      const buf = Buffer.alloc(Math.min(cap, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      fs.writeFileSync(dest, buf.subarray(0, n));
      return { bytes: n, truncatedFrom: st.size > cap ? st.size : null };
    } finally { fs.closeSync(fd); }
  } catch (e) { return { error: e.code || e.message }; }
}

/** LOCAL scene — everything a kill/respawn/restart would erase. */
async function captureLocal(dir, { dataDir, cids }) {
  const frozen = path.join(dir, 'frozen');
  fs.mkdirSync(frozen, { recursive: true });
  const out = { at: new Date().toISOString(), host: os.hostname(), uptimeS: Math.round(os.uptime()) };

  // process table: the whole session tree (dtach / wrappers / claude / codex /
  // node) — a user's kill erases it and it is THE liveness evidence
  out.processes = (await sh('ps', ['-eo', 'pid,ppid,lstart,etime,rss,stat,args'], 10000))
    .split('\n').filter((l) => /dtach|chat-wrapper|pty-wrapper|claude|codex|agentd|node server\.js|PID/.test(l))
    .slice(0, 400).map((l) => l.slice(0, 400));

  // dtach sockets (the session anchors) + buffer/meta files
  const sockDir = path.join(dataDir, 'sockets');
  out.sockets = {};
  try { for (const f of fs.readdirSync(sockDir)) out.sockets[f] = statOf(path.join(sockDir, f)); } catch (e) { out.sockets = { error: e.message }; }

  // FREEZE session metas + wrapper metas verbatim — these are rewritten by
  // every create/kill/id-capture, so a later look sees the post-mortem state
  const metaDir = path.join(dataDir, 'session-meta');
  out.sessionMetas = {};
  try {
    fs.mkdirSync(path.join(frozen, 'session-meta'), { recursive: true });
    for (const f of fs.readdirSync(metaDir).slice(0, 200)) {
      const src = path.join(metaDir, f);
      out.sessionMetas[f] = statOf(src);
      copyCapped(src, path.join(frozen, 'session-meta', f), META_COPY_MAX);
    }
  } catch (e) { out.sessionMetas = { error: e.message }; }

  const bufDir = path.join(dataDir, 'session-buffers');
  out.buffers = {};
  try {
    fs.mkdirSync(path.join(frozen, 'buffers'), { recursive: true });
    const names = fs.readdirSync(bufDir);
    for (const f of names.filter((n) => n.endsWith('.json')).slice(0, 200)) {
      copyCapped(path.join(bufDir, f), path.join(frozen, 'buffers', f), META_COPY_MAX); // wrapper meta = streaming/remote state
    }
    for (const f of names.slice(0, 400)) out.buffers[f] = statOf(path.join(bufDir, f));
  } catch (e) { out.buffers = { error: e.message }; }

  // claude's OWN lock files — deleted the moment a CLI exits, so a user's
  // kill destroys the proof of what was running
  const lockDir = path.join(os.homedir(), '.claude', 'sessions');
  out.claudeLocks = {};
  try {
    for (const f of fs.readdirSync(lockDir).slice(0, 120)) {
      try { out.claudeLocks[f] = JSON.parse(fs.readFileSync(path.join(lockDir, f), 'utf8')); }
      catch { out.claudeLocks[f] = statOf(path.join(lockDir, f)); }
    }
  } catch (e) { out.claudeLocks = { error: e.message }; }

  // TRANSCRIPT IDENTITY for every referenced conversation: size+mtime+sha256.
  // A manual `claude --resume` on a live id double-writes or forks — the hash
  // taken NOW is what proves (later) that the file diverged after capture.
  out.transcripts = {};
  const projRoot = path.join(os.homedir(), '.claude', 'projects');
  const cacheRoot = path.join(dataDir, 'remote-jsonl');
  fs.mkdirSync(path.join(frozen, 'transcripts'), { recursive: true });
  for (const cid of (cids || []).slice(0, MAX_CIDS)) {
    if (!/^[\w-]{6,64}$/.test(String(cid))) continue;
    const hits = [];
    try {
      for (const d of fs.readdirSync(projRoot)) {
        const fp = path.join(projRoot, d, cid + '.jsonl');
        if (fs.existsSync(fp)) hits.push(fp);
      }
    } catch {}
    try {
      for (const h of fs.readdirSync(cacheRoot)) {
        const fp = path.join(cacheRoot, h, cid + '.jsonl');
        if (fs.existsSync(fp)) hits.push(fp);
      }
    } catch {}
    // HARNESS STORES (B-8ebb's last row): every registered harness's
    // `store.locate(id)` names where ITS conversation lives — codex rollouts
    // (rollout-*-<tid>.jsonl or .jsonl.zst, local tree or the remote-jsonl
    // cache) join the freeze with the same identity + frozen tail; claude's
    // locate resolves to the path the scan above already found (deduped).
    // Never a codex ternary here — a third harness freezes by registering a
    // store. Iterated through the registry, per harness try/caught.
    const harnessOfPath = new Map();
    try {
      for (const h of listHarnesses()) {
        const locate = h.store && typeof h.store.locate === 'function' ? h.store.locate : null;
        if (!locate) continue;
        let fp = null;
        try { fp = locate(cid) || null; } catch { fp = null; }
        // A NUL-prefixed "path" is an opaque HANDLE, never a real file
        // (transcript-service's DEVICE_HANDLE convention). Spelled as an
        // escape rather than the raw byte it used to be: one control
        // character makes the whole source file binary to grep/ripgrep,
        // and nothing in it can be found by search after that.
        if (!fp || typeof fp !== 'string' || fp.startsWith('\u0000')) continue;
        if (!hits.includes(fp)) { try { if (fs.existsSync(fp)) hits.push(fp); } catch { } }
        if (hits.includes(fp)) harnessOfPath.set(fp, h.id);
      }
    } catch (e) { out.transcriptsHarnessError = String(e.message || e).slice(0, 200); }
    out.transcripts[cid] = hits.map((fp) => {
      // a .jsonl.zst rollout freezes its raw tail (identity evidence: size +
      // mtime + sha256 are what prove later divergence); flagged so a reader
      // knows the tail bytes are compressed, not lines
      const compressed = /\.zst$/i.test(fp);
      const ext = compressed ? '.jsonl.zst' : '.jsonl';
      return {
        path: fp, ...statOf(fp), sha256: sha256Head(fp),
        ...(harnessOfPath.has(fp) ? { harness: harnessOfPath.get(fp) } : {}),
        ...(compressed ? { compressed: true } : {}),
        frozenTail: copyCapped(fp, path.join(frozen, 'transcripts', `${cid}__${path.basename(path.dirname(fp))}.tail${ext}`), TRANSCRIPT_TAIL),
      };
    });
  }

  // storage + fs pressure (a full disk explains a whole class of weirdness)
  out.df = (await sh('df', ['-h', dataDir, os.homedir()], 6000)).slice(0, 2000);
  out.mounts = (await sh('sh', ['-c', 'grep -E "fuse|ceph|nfs" /proc/mounts | head -40'], 6000)).slice(0, 4000);
  return out;
}

/** The remote transcript probe lines, ONE per (conversation × harness) from
 *  each registered harness's `store.remoteFind(id)` ({root, findExpr} — the
 *  same expressions hosts.fetchTranscript uses): claude's `$HOME/.claude/projects
 *  -maxdepth 2 -name "<id>.jsonl"` exactly as before, codex's
 *  `$HOME/.codex/sessions … rollout-*<id>.jsonl(.zst)` now (B-8ebb). A
 *  harness without remoteFind contributes nothing. Ids are pre-validated
 *  ([\\w-]{6,64}) and JSON-quoted inside findExpr by the descriptors. */
function buildRemoteTranscriptProbe(cids) {
  const lines = [];
  let harnesses = [];
  try { harnesses = listHarnesses(); } catch { harnesses = []; }
  for (const cid of cids || []) {
    for (const h of harnesses) {
      let rf = null;
      try { rf = h.store && typeof h.store.remoteFind === 'function' ? h.store.remoteFind(cid) : null; } catch { rf = null; }
      if (!rf || typeof rf.root !== 'string' || typeof rf.findExpr !== 'string') continue;
      lines.push(`for f in $(find ${rf.root} ${rf.findExpr} 2>/dev/null | head -3); do probe_transcript "$f" ${JSON.stringify(h.id)}; done`);
    }
  }
  return lines.join('\n');
}

/** REMOTE scene per host — one bounded read-only probe over the SAME channel
 *  the roster/status probes use (ssh or dial), so it works for both. */
const REMOTE_SCRIPT = (cids) => `
probe_transcript() {
  echo "--- $1 [$2]"
  stat -c 'size=%s mtime=%y' "$1" 2>/dev/null || stat -f 'size=%z mtime=%Sm' "$1" 2>/dev/null
  echo "lines=$(wc -l < "$1" 2>/dev/null)"
  echo "sha256=$( (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1" 2>/dev/null) | awk '{print $1}')"
  echo "lastts=$(tail -c 20000 "$1" 2>/dev/null | grep -ao '"timestamp":"[^"]*"' | tail -3 | tr '\\n' ' ')"
}
echo "== uptime"; uptime 2>/dev/null | head -1
echo "== whoami"; id -un 2>/dev/null
echo "== claude/dtach/keeper processes"
ps -eo pid,ppid,lstart,etime,rss,args 2>/dev/null | grep -E "claude|dtach|vibespace-|codex" | grep -v grep | head -40 | cut -c1-320
echo "== claude locks"
for f in $HOME/.claude/sessions/*.json; do [ -f "$f" ] && echo "--- $f" && head -c 400 "$f" && echo; done 2>/dev/null | head -80
echo "== keeper run dir"; ls -la $HOME/.vibespace/run/ 2>/dev/null | head -20
echo "== agentd"; ls -la $HOME/.vibespace/ 2>/dev/null | head -20
echo "== transcripts"
${buildRemoteTranscriptProbe(cids)}
echo "== project dirs"; ls $HOME/.claude/projects 2>/dev/null | head -30
echo "== codex sessions"; ls $HOME/.codex/sessions 2>/dev/null | head -10
echo "== disk"; df -h $HOME 2>/dev/null | tail -2
echo "== versions"; (claude --version 2>/dev/null || echo "claude: not on PATH"); (codex --version 2>/dev/null || echo "codex: not on PATH"); node --version 2>/dev/null
`;

async function captureRemote({ hosts, hostIds, cids }) {
  const out = {};
  const ids = [...new Set(hostIds)].filter(Boolean).slice(0, MAX_HOSTS);
  const safeCids = (cids || []).filter((c) => /^[\w-]{6,64}$/.test(String(c))).slice(0, MAX_CIDS);
  await Promise.all(ids.map(async (hid) => {
    const t0 = Date.now();
    try {
      const h = hosts.get?.(hid) || (hosts.list?.() || []).find((x) => x.id === hid);
      if (!h) { out[hid] = { error: 'unknown host' }; return; }
      const text = await hosts._hostShell(h, REMOTE_SCRIPT(safeCids), { timeoutMs: 25000 });
      out[hid] = { name: h.name, transport: h.transport === 'dial' ? 'dial' : 'ssh', tookMs: Date.now() - t0, probe: String(text).slice(0, 60000) };
    } catch (e) {
      out[hid] = { error: String(e.message || e).slice(0, 300), tookMs: Date.now() - t0 };
    }
  }));
  return out;
}

module.exports = { captureLocal, captureRemote, buildRemoteTranscriptProbe, REMOTE_SCRIPT };
