'use strict';
/**
 * Shared discovery FACT extractors (CS separation, 2.278.0;
 * docs/design-cs-unification.md row "Session discovery facts").
 *
 * Discovery has three fact collectors — the local sweep (routes/sessions.js,
 * hot-path optimized: async parallel probes, B-2104 procStart verification,
 * tmux), the device daemon's discovery-snapshot (agentd.js, bundled by
 * esbuild), and the ssh script (hosts.js, the no-daemon fallback). The
 * COLLECTORS legitimately differ in transport and richness; what must never
 * differ is the INTERPRETATION of the same bytes. It did:
 *
 *  - naming: local took the FIRST LINE of the first real user message; the
 *    remote parser whitespace-collapsed the WHOLE message — the same session
 *    could be named differently depending on which machine it ran on;
 *  - tail-ids: three implementations (session-store full list / agentd
 *    uniq+last-8 / ssh grep|uniq|tail-8) feeding ONE consumer (claimJsonls)
 *    with subtly different mention windows;
 *  - the daemon's lock scan verified only pid LIVENESS — a recycled pid on a
 *    device produced a phantom "running" session, the exact hole the local
 *    sweep closed years ago ("verify process is actually claude").
 *
 * This module is deliberately tiny (fs/child_process only) so the daemon
 * bundle can carry it: the agentd bundle is built by esbuild from src/, so —
 * unlike the ssh one-file scanner — it CAN share code. Every rule below has
 * exactly one home.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const zlib = require('zlib');

const NAME_MAX = 80;

// ── zstd rollouts (codex ≥0.153 may write rollout-*.jsonl.zst; S3) ──
// Node ≥22.15 ships zlib.zstd*; older runtimes (a remote host's node) simply
// cannot read compressed rollouts — every reader degrades to "unreadable"
// with ZSTD_SUPPORTED false, never a crash. Bounded by construction: callers
// pass maxOutputLength and a truncated compressed PREFIX still decompresses
// to whatever plain text it covers (verified on this runtime), so head reads
// never inflate a whole archive.
const ZSTD_SUPPORTED = typeof zlib.zstdDecompressSync === 'function';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const isZstPath = (fp) => /\.zst$/i.test(String(fp || ''));
const isZstBuffer = (buf) => Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
/** Skippable frames (magic 0x184D2A5?) carry no data — step over them. */
const isSkippableFrame = (buf, at) => buf.length - at >= 8 && (buf[at] & 0xf0) === 0x50 && buf[at + 1] === 0x2a && buf[at + 2] === 0x4d && buf[at + 3] === 0x18;

/** Decompress EVERY frame of a zstd buffer (zlib.zstdDecompressSync stops
 *  after the first — a rollout appended frame-by-frame would silently lose
 *  its tail). Output capped at maxOutputLength: exceeding it throws a coded
 *  error (EZSTBIG) instead of a >512MB string. A truncated final frame (a
 *  bounded prefix read, or a file mid-write) yields its partial text. */
function zstdDecompressFrames(buf, { maxOutputLength = 256 * 1024 * 1024 } = {}) {
  if (!ZSTD_SUPPORTED) throw Object.assign(new Error('zstd unsupported on this node (need ≥22.15)'), { code: 'EZSTUNSUPPORTED' });
  const parts = [];
  let at = 0, total = 0;
  while (at < buf.length) {
    if (isSkippableFrame(buf, at)) { at += 8 + buf.readUInt32LE(at + 4); continue; }
    if (!isZstBuffer(buf.subarray(at))) break; // trailing garbage / cut mid-header
    let r;
    try { r = zlib.zstdDecompressSync(buf.subarray(at), { info: true, maxOutputLength: maxOutputLength - total }); }
    catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw Object.assign(new Error(`zstd output exceeds ${maxOutputLength} bytes`), { code: 'EZSTBIG' });
      break; // truncated frame: keep what earlier frames gave us
    }
    parts.push(r.buffer);
    total += r.buffer.length;
    const consumed = Number(r.engine && r.engine.bytesWritten) || 0;
    if (consumed <= 0) break;
    at += consumed;
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

/** At least `plainBytes` of PLAIN text out of a zstd buffer, without ever
 *  materializing the whole archive. A truncated compressed PREFIX decompresses
 *  to whatever plain text it covers, so the head read BISECTS over prefix
 *  sizes under a fixed output cap instead of one-shotting the whole buffer
 *  under a RATIO GUESS. The guess was the bug (2.369.x): `maxOutputLength =
 *  max(plainBytes*4, 1MiB)` threw EZSTBIG for every rollout that compresses
 *  better than ~4× — 7 of 40 REAL rollouts on the dev box — and readHeadText
 *  turned the throw into an EMPTY head, so extractCodexThreadMeta produced an
 *  empty threadId and the thread VANISHED from the session list.
 *  Returns ≥ plainBytes of plain text unless the input itself covers less. */
function zstdDecompressHead(buf, plainBytes, { maxOutputLength } = {}) {
  const cap = Math.max(Number(maxOutputLength) || 0, plainBytes * 4, 1024 * 1024);
  let lo = 0;                 // largest compressed prefix known to fit under cap
  let hi = buf.length + 1;    // smallest compressed prefix known to overflow it
  let take = buf.length;      // start with everything we were handed
  let best = Buffer.alloc(0);
  for (let i = 0; i < 32 && take > lo && take > 0; i++) {
    let out;
    try { out = zstdDecompressFrames(buf.subarray(0, take), { maxOutputLength: cap }); }
    catch (e) {
      if (e && e.code === 'EZSTBIG') { hi = take; take = Math.floor((lo + hi) / 2); continue; }
      throw e; // unsupported runtime / genuinely broken input — never a silent ''
    }
    if (out.length > best.length) best = out;
    if (best.length >= plainBytes || take >= buf.length) return best;
    lo = take;                                   // need MORE input for a full head
    take = Math.floor((lo + Math.min(hi, buf.length + 1)) / 2);
  }
  return best;
}

/** The first `plainBytes` of a transcript's TEXT, plain or zstd (by extension
 *  OR magic — a remote .zst cached under a .jsonl name still reads). For zstd
 *  the read is bounded on the COMPRESSED side too (a prefix of plainBytes
 *  compressed bytes; ratio ≥1 in practice), never the whole archive, and the
 *  DECOMPRESSION is bounded by zstdDecompressHead's bisection rather than a
 *  ratio guess. Cut-off last line dropped like every other head reader.
 *  THROWS (coded: EZSTUNSUPPORTED / whatever zlib raised) when a compressed
 *  head cannot be read — an unreadable head is NOT an empty transcript, and
 *  every caller's catch must be free to treat it as a failed extraction
 *  (adapters/codex's `extractFailed` — a failure cached by mtime hides the
 *  thread forever). */
function readHeadText(fp, plainBytes) {
  const st = fs.statSync(fp);
  const fd = fs.openSync(fp, 'r');
  try {
    const want = Math.min(st.size, plainBytes);
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, 0);
    const raw = buf.subarray(0, n);
    if (!(isZstPath(fp) || isZstBuffer(raw))) {
      let head = raw.toString('utf-8');
      if (n < st.size) head = head.slice(0, head.lastIndexOf('\n') + 1);
      return head;
    }
    const plain = zstdDecompressHead(raw, plainBytes);
    // A compressed input that yields NO plain text at all is a failed read
    // (corrupt/garbage frame — zstdDecompressFrames breaks out of a broken
    // frame by design so bounded prefixes work), never "an empty transcript".
    // Saying '' here is what let adapters/codex cache an empty meta by mtime.
    if (!plain.length && raw.length) throw Object.assign(new Error(`unreadable compressed head: ${path.basename(fp)}`), { code: 'EZSTHEAD' });
    let head = plain.toString('utf-8', 0, Math.min(plain.length, plainBytes));
    if (plain.length > plainBytes || n < st.size) head = head.slice(0, head.lastIndexOf('\n') + 1);
    return head;
  } finally { fs.closeSync(fd); }
}

/** sessionIds appearing in a transcript's TAIL text, uniq-collapsed by run
 *  (records from one session are consecutive), last `max` runs. The LAST id
 *  is the current writer; earlier ones are mentions. Matches the ssh script's
 *  `grep -o | uniq | tail -8` exactly. */
function extractTailIds(text, max = 8) {
  const ids = [];
  const re = /"sessionId":"([\w-]+)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (ids[ids.length - 1] !== m[1]) ids.push(m[1]);
  }
  return ids.slice(-max);
}

/** The ONE naming rule: first non-empty LINE of a real user message, trimmed,
 *  ≤80 chars; injected <…>-tag context/reminders and slash-command echoes are
 *  not names. Takes a PARSED user record. Returns string|null. */
function nameFromUserRecord(d) {
  const msg = d?.message;
  if (!msg || !msg.content) return null;
  const content = Array.isArray(msg.content)
    ? (msg.content.find((c) => c && c.type === 'text')?.text || '')
    : String(msg.content);
  return nameFromText(content);
}

function nameFromText(text) {
  const firstLine = String(text || '').split('\n').find((l) => l.trim()) || '';
  const cand = firstLine.trim().slice(0, NAME_MAX).trim();
  if (!cand || cand.startsWith('<') || cand.startsWith('/')) return null;
  return cand;
}

/** Same rule over a RAW JSONL line that may be TRUNCATED (the ssh script caps
 *  N lines at ~1500-2000 bytes, so JSON.parse can fail) — full parse first,
 *  regex fallback for cut lines. */
function nameFromUserLine(line) {
  const s = String(line || '');
  try { return nameFromUserRecord(JSON.parse(s)); } catch { }
  // Truncated lines: prefer a properly closed string, but a cut that lands
  // MID-STRING leaves no closing quote — the old parser's regex required one
  // and silently named nothing. The first line is all we need, so an
  // unterminated tail is fine.
  const m = s.match(/"content":"((?:[^"\\]|\\.)*)"/) || s.match(/"text":"((?:[^"\\]|\\.)*)"/)
    || s.match(/"content":"((?:[^"\\]|\\.)*)/) || s.match(/"text":"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  let frag = m[1].replace(/\\$/, ''); // a cut mid-escape leaves a lone backslash
  let text;
  try { text = JSON.parse('"' + frag + '"'); }
  catch { text = frag.replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"'); }
  return nameFromText(text);
}

/** THE codex naming rule (moved here verbatim from adapters/codex.js in S3
 *  so the ssh script's NC lines and the daemon snapshot name a thread exactly
 *  like the local listing): first line that is not an injected instruction
 *  block (AGENTS.md, <environment_context>, <recommended_plugins>…), ≤120
 *  chars; a message that IS an injected block names nothing. */
function deriveCodexSessionName(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const lowerValue = value.toLowerCase();
  const injectedBlockMarkers = [
    '# agents.md instructions for ',
    '<instructions>',
    '<environment_context>',
    '<permissions instructions>',
    '<apps_instructions>',
    '<skills_instructions>',
    '<plugins_instructions>',
    '<recommended_plugins>', // 0.153.x injects an uninstalled-plugins roster as the FIRST user message — it became the session name (2.369.18 e2e)
    '### available skills',
    '### available plugins',
  ];
  if (injectedBlockMarkers.some((marker) => lowerValue.includes(marker))) return '';
  const instructionMarkers = new Set([
    '<INSTRUCTIONS>',
    '</INSTRUCTIONS>',
    '<environment_context>',
    '</environment_context>',
    '<permissions instructions>',
    '</permissions instructions>',
    '<apps_instructions>',
    '</apps_instructions>',
    '<skills_instructions>',
    '</skills_instructions>',
    '<collaboration_mode>',
    '</collaboration_mode>',
  ]);
  const ignoreLine = (line) => (
    !line
    || line.startsWith('# AGENTS.md instructions')
    || line.startsWith('<system>')
    || instructionMarkers.has(line)
    || /^<(environment_context|permissions instructions|apps_instructions|skills_instructions|plugins_instructions|recommended_plugins|collaboration_mode)/.test(line)
    || /^<\/(environment_context|permissions instructions|apps_instructions|skills_instructions|plugins_instructions|recommended_plugins|collaboration_mode)/.test(line)
    || /^## (JavaScript REPL|Skills|Plugins)\b/.test(line)
    || /^<\/?[A-Z_]+>$/.test(line)
  );
  const firstLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => !ignoreLine(line)) || '';
  return firstLine.slice(0, 120);
}

/** A codex user record (`response_item` message role user) → name via the
 *  codex rule, over a RAW rollout line that may be TRUNCATED (the ssh script
 *  caps NC lines at 2000 bytes): full parse first, then every "text":"…"
 *  fragment (closed or cut) unescaped — the first one that names wins,
 *  exactly like extractCodexThreadMeta's `find` over input_text blocks. */
function nameFromCodexUserLine(line) {
  const s = String(line || '');
  try {
    const d = JSON.parse(s);
    if (d?.type !== 'response_item' || d.payload?.type !== 'message' || d.payload?.role !== 'user') return null;
    const content = Array.isArray(d.payload.content) ? d.payload.content : [];
    for (const c of content) {
      if (!c || (c.type !== 'input_text' && c.type !== 'text')) continue;
      const n = deriveCodexSessionName(c.text || '');
      if (n) return n;
    }
    return null;
  } catch { }
  if (!/"role":"user"/.test(s)) return null;
  const re = /"text":"((?:[^"\\]|\\.)*)(?:"|$)/g;
  let m;
  while ((m = re.exec(s))) {
    const frag = m[1].replace(/\\$/, '');
    let text;
    try { text = JSON.parse('"' + frag + '"'); }
    catch { text = frag.replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"'); }
    const n = deriveCodexSessionName(text);
    if (n) return n;
  }
  return null;
}

/** Rollout files held OPEN by a codex process on THIS machine — the codex
 *  liveness fact (codex has no lock files; an open `rollout-*.jsonl[.zst]`
 *  fd IS the running thread). /proc on Linux (zero fork), `lsof +D` elsewhere.
 *  ONE implementation for the local listing (codex-session-store), the
 *  daemon snapshot (CO lines) and — mirrored in shell — the ssh script.
 *  Returns absolute paths; callers derive thread ids with CODEX_TID_RE. */
function listOpenCodexRolloutPaths({ sessionsDir } = {}) {
  const root = sessionsDir || path.join(require('os').homedir(), '.codex', 'sessions');
  const out = new Set();
  if (process.platform === 'linux' && fs.existsSync('/proc/self')) {
    let procEntries = [];
    try { procEntries = fs.readdirSync('/proc', { withFileTypes: true }); } catch { return [...out]; }
    for (const entry of procEntries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = entry.name;
      let cmdline = '';
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8'); } catch { continue; }
      if (!isCodexCommandLine(cmdline)) continue;
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let target = '';
        try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (!target.startsWith(root) || !CODEX_ROLLOUT_RE.test(path.basename(target))) continue;
        out.add(target);
      }
    }
    return [...out];
  }
  try {
    const output = execFileSync('lsof', ['-Fpcn', '+D', root], {
      encoding: 'utf-8', timeout: 4000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let cmd = '';
    for (const line of output.split('\n')) {
      if (line.startsWith('c')) { cmd = line.slice(1); continue; }
      if (!line.startsWith('n')) continue;
      const fp = line.slice(1).trim();
      if (!/codex/.test(cmd) || !CODEX_ROLLOUT_RE.test(path.basename(fp))) continue;
      out.add(fp);
    }
  } catch { }
  return [...out];
}

/** "does this cmdline belong to the codex CLI" — moved from
 *  codex-session-store (one rule for liveness everywhere). */
function isCodexCommandLine(cmdline = '') {
  const value = String(cmdline || '');
  return (
    /(^|\0|[\/\s])codex(\0|\s|$)/.test(value)
    || value.includes('/@openai/codex/')
    || value.includes('/codex-linux-')
  );
}

/** rollout-<ts>-<threadId>.jsonl[.zst] — the ONE thread-id-from-filename rule. */
const CODEX_TID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const CODEX_ROLLOUT_RE = /^rollout-.*\.jsonl(?:\.zst)?$/i;
const codexThreadIdOf = (fp) => { const m = CODEX_TID_RE.exec(String(fp || '')); return m ? m[1] : null; };

/** Portable "is this pid actually claude" — /proc on Linux (zero fork),
 *  `ps -o comm=` elsewhere. The verification the local sweep has had since
 *  the PID-reuse fix and the daemon snapshot never had. */
function pidLooksClaude(pid) {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    if (comm) return comm.includes('claude') || cmdlineLooksClaude(pid);
  } catch { }
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 2000 }).trim();
    return cmd === 'claude' || cmd.includes('claude');
  } catch { return false; }
}

function cmdlineLooksClaude(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes('claude'); } catch { return false; }
}


/**
 * interpretDiscoveryLines — the ONE interpretation of the discovery fact
 * lines (LOCK/J/H/N/T/C/HC/K) into resumable session cards. It was ~120 lines
 * inline in hosts.discoverSessions; extracting it (R5 step 2 of
 * docs/design-three-tier.md) lets the DEVICE compute its own claims (the
 * `discovery.v2` op) with the byte-identical logic the server used to run
 * centrally — the orchestrator then only merges across machines. `claimJsonls`
 * is INJECTED (it lives in session-store, which this tiny module must not
 * pull in); the daemon passes its bundled copy, the server passes its own.
 * Pure: `out` string + descriptor in, plain session array out.
 */
function interpretDiscoveryLines(out, { hostId, hostName, claimJsonls }) {
  const locks = [];
  const keeperBySession = new Map(); // claudeSessionId → {sid} (live keeper sessions)
  const jsonls = [];
  const heads = new Map(); // jsonl path -> first record (cwd source)
  const codexRollouts = []; // B-10ed: codex rollout files on the host
  const codexCwd = new Map(); // rollout path -> cwd
  const codexNames = new Map(); // rollout path -> name (S3: NC lines, codex naming rule)
  const codexOpen = new Set(); // thread ids held open by a codex process (S3: CO lines)
  const tailIds = new Map(); // jsonl path -> [sessionIds in tail, last = current writer]
  for (const line of out.split('\n')) {
    if (line.startsWith('K ')) {
      // keeper meta: '<sid>\t<json>' — index by claude session id when known
      try {
        const ti = line.indexOf('\t');
        const ksid = line.slice(2, ti).trim();
        const km = JSON.parse(line.slice(ti + 1));
        if (ksid && km && km.exited === undefined) {
          const key = km.claudeSessionId || km.resumeId;
          if (key) keeperBySession.set(key, { sid: ksid, childPid: km.childPid });
        }
      } catch { }
      continue;
    }
    if (line.startsWith('LOCK ')) { try { locks.push(JSON.parse(line.slice(5))); } catch {} }
    else if (line.startsWith('J ')) {
      const m = line.match(/^J ([\d.]+) (\d+) (.+)$/);
      if (m) jsonls.push({ mtime: parseFloat(m[1]) * 1000, size: +m[2], path: m[3] });
    } else if (line.startsWith('C ')) {
      // codex rollout (B-10ed): "C <mtime> <size> <path>"
      const m = line.match(/^C ([\d.]+) (\d+) (.+)$/);
      if (m) codexRollouts.push({ mtime: parseFloat(m[1]) * 1000, size: +m[2], path: m[3] });
    } else if (line.startsWith('HC ')) {
      const t = line.indexOf('\t');
      const m = t > 3 && line.slice(t + 1).match(/^"cwd":"([^"]*)"/);
      if (m) codexCwd.set(line.slice(3, t), m[1]);
    } else if (line.startsWith('NC ')) {
      // codex early user record (S3): "NC <path>\t<raw line, may be cut at
      // 2000B>" — the codex naming rule skips injected blocks, so the first
      // NC line that names wins (extractCodexThreadMeta's exact behaviour)
      const t = line.indexOf('\t');
      if (t > 3) {
        const fp = line.slice(3, t);
        if (!codexNames.has(fp)) {
          const name = nameFromCodexUserLine(line.slice(t + 1));
          if (name) codexNames.set(fp, name);
        }
      }
    } else if (line.startsWith('CO ')) {
      // rollout held OPEN by a codex process (S3): "CO <path>" — the thread
      // is RUNNING there (resume must not put a second app-server on it)
      const tid = codexThreadIdOf(line.slice(3).trim());
      if (tid) codexOpen.add(tid.toLowerCase());
    } else if (line.startsWith('T ')) {
      const t = line.indexOf('\t');
      if (t > 2) {
        const ids = line.slice(t + 1).split(',').map(s => s.trim()).filter(s => /^[\w-]+$/.test(s));
        if (ids.length) tailIds.set(line.slice(2, t), ids);
      }
    } else if (line.startsWith('H ')) {
      const t = line.indexOf('\t');
      const m = t > 2 && line.slice(t + 1).match(/^"cwd":"([^"]*)"/);
      if (m) heads.set(line.slice(2, t), { ...(heads.get(line.slice(2, t)) || {}), cwd: m[1] });
    } else if (line.startsWith('N ')) {
      const t = line.indexOf('\t');
      if (t > 2) {
        const fp = line.slice(2, t);
        // first user record → session name (same rule as local naming);
        // content is either a plain string ("content":"...") or an array of
        // blocks ("content":[{"type":"text","text":"..."}]) — support both.
        // The line may be truncated at 1500 bytes.
        // ONE naming rule (discovery-facts, 2.278.0) — this parser used to
        // whitespace-collapse the whole message while local took the first
        // line: the same session named differently local vs remote.
        const name = nameFromUserLine(line.slice(t + 1));
        if (name && !heads.get(fp)?.name) heads.set(fp, { ...(heads.get(fp) || {}), name });
      }
    }
  }
  // lock-first claim per project dir — shared claimJsonls (same algorithm as
  // local /api/sessions): exact id (lock.sessionId = filename for non-resumed
  // sessions) → tail ids (resumed: records carry the CURRENT id while the
  // filename keeps the ORIGINAL) → mtime fallback. The old "newest JSONL in
  // the lock's dir" attributed files arbitrarily with N parallel sessions in
  // one cwd (real incident: 4 running read as 5; kill → wrong id stopped).
  const encode = (cwd) => (cwd || '').replace(/[/._]/g, '-');
  const byDir = new Map(); // projDirName -> { locks: [], jsonls: [] }
  const dirGroup = (d) => {
    if (!byDir.has(d)) byDir.set(d, { locks: [], jsonls: [] });
    return byDir.get(d);
  };
  for (const j of jsonls) dirGroup(path.basename(path.dirname(j.path))).jsonls.push(j);
  for (const lock of locks) dirGroup(encode(lock.cwd)).locks.push(lock);
  const claimed = new Set(); // jsonl paths
  const runningIds = new Set();
  const sessions = [];
  for (const [, g] of byDir) {
    if (!g.locks.length) continue;
    const jmetas = g.jsonls.map(j => ({ id: path.basename(j.path, '.jsonl'), mtime: j.mtime, path: j.path }));
    const claims = claimJsonls(
      g.locks.map(l => ({ sessionId: l.sessionId || null, exactOnly: false, lock: l })),
      jmetas,
      (j) => tailIds.get(j.path) || null,
    );
    const matchedLocks = new Set();
    for (const [jid, w] of claims) {
      const jm = jmetas.find(j => j.id === jid);
      claimed.add(jm.path);
      runningIds.add(jid);
      matchedLocks.add(w.lock);
      // pid rides to the card so Terminate can reach killRemotePid (2.191.0
      // — without it the EXTERNAL card's confirm ended in a silent no-op)
      sessions.push({ sessionId: jid, cwd: w.lock.cwd, status: 'remote-running', host: hostId, hostName: hostName, mtime: jm.mtime, pid: Number(w.lock.pid) || undefined, keeperSid: (keeperBySession.get(jid) || keeperBySession.get(w.lock.sessionId))?.sid });
    }
    // Locks with no JSONL yet (brand-new session, nothing flushed): list by
    // the lock's own sessionId instead of dropping them (or, before this fix,
    // stealing another session's transcript) — parity with local Step 3.
    for (const l of g.locks) {
      if (matchedLocks.has(l) || !l.sessionId || runningIds.has(l.sessionId)) continue;
      runningIds.add(l.sessionId);
      sessions.push({ sessionId: l.sessionId, cwd: l.cwd || null, status: 'remote-running', host: hostId, hostName: hostName, mtime: l.startedAt || Date.now(), pid: Number(l.pid) || undefined, keeperSid: keeperBySession.get(l.sessionId)?.sid });
    }
  }
  for (const j of jsonls) {
    if (claimed.has(j.path)) continue;
    const sid = path.basename(j.path, '.jsonl');
    if (runningIds.has(sid)) continue; // already listed via a lock
    const head = heads.get(j.path);
    sessions.push({ sessionId: sid, cwd: head?.cwd || null, name: head?.name || null, projDir: path.basename(path.dirname(j.path)), status: 'remote-stopped', host: hostId, hostName: hostName, mtime: j.mtime });
  }
  // Codex rollouts → resumable cards (B-10ed). threadId = the uuid tail of
  // the rollout filename (CODEX_TID_RE, .jsonl or .jsonl.zst — the same rule
  // codex-session-store uses). S3: a rollout held OPEN by a codex process on
  // the host (CO line) is RUNNING there → 'remote-running' (the client shows
  // it EXTERNAL and Resume refuses to double-write); names come from the NC
  // lines through the codex naming rule.
  // A .jsonl and its .jsonl.zst TWIN list ONCE, and the PLAIN twin's facts
  // win: "first in mtime order" (both producers sort newest-first —
  // hosts.js `sort -rn`, agentd.js `b.mtimeMs - a.mtimeMs`) actually picked
  // the COMPRESSED twin, because compression happens AFTER the last write, so
  // the .zst is always the newer file. The ssh scanner can only read a
  // compressed head where the host has zstd(1), so the card silently lost the
  // cwd/name its plain twin's HC/NC lines carried. Facts are MERGED (either
  // twin fills what the other lacks) and mtime is the newer of the two — the
  // pair is one thread.
  const byTid = new Map(); // tid(lower) -> merged rollout facts
  for (const r of codexRollouts) {
    const tid = codexThreadIdOf(r.path);
    if (!tid) continue;
    const key = tid.toLowerCase();
    const plain = !isZstPath(r.path);
    const cwd = codexCwd.get(r.path) || null;
    const name = codexNames.get(r.path) || null;
    const cur = byTid.get(key);
    if (!cur) { byTid.set(key, { tid, plain, cwd, name, mtime: r.mtime }); continue; }
    cur.mtime = Math.max(cur.mtime, r.mtime);
    if (plain && !cur.plain) { cur.plain = true; cur.tid = tid; if (cwd) cur.cwd = cwd; if (name) cur.name = name; }
    if (!cur.cwd && cwd) cur.cwd = cwd;
    if (!cur.name && name) cur.name = name;
  }
  for (const [key, r] of byTid) {
    const running = codexOpen.has(key);
    sessions.push({ sessionId: r.tid, backend: 'codex', cwd: r.cwd || null, name: r.name || null, status: running ? 'remote-running' : 'remote-stopped', host: hostId, hostName: hostName, mtime: r.mtime });
  }
  return sessions;
}


/**
 * synthesizeDiscoveryLines — device SNAPSHOT (raw facts) → the LOCK/J/H/N/T/
 * C/HC line format interpretDiscoveryLines consumes. It was inline in
 * hosts.discoverSessions; extracted with the interpreter (R5) so the whole
 * chain (snapshot → synthesize → interpret) can run ON the device — the
 * `discovery.v2` op — with byte-identical logic. The ssh script emits these
 * same lines directly, which is why the format is the seam.
 */
function synthesizeDiscoveryLines(snap) {
  const lines = [];
  for (const l of (snap?.locks || [])) lines.push('LOCK ' + JSON.stringify(l));
  for (const j of (snap?.jsonls || [])) {
    const fp = `/HOME/.claude/projects/${j.projDir}/${j.file}`;
    lines.push(`J ${(j.mtimeMs / 1000).toFixed(4)} ${j.size} ${fp}`);
    if (j.headCwd !== undefined) lines.push(`H ${fp}\t"cwd":"${j.headCwd || ''}"`);
    for (const u of j.userLines || []) lines.push(`N ${fp}\t${u}`);
    if (j.tailIds) lines.push(`T ${fp}\t${j.tailIds.join(',')},`);
  }
  for (const r of (snap?.codexRollouts || [])) {
    lines.push(`C ${(r.mtimeMs / 1000).toFixed(4)} ${r.size} ${r.path}`);
    if (r.headCwd) lines.push(`HC ${r.path}\t"cwd":"${r.headCwd}"`);
    for (const u of r.userLines || []) lines.push(`NC ${r.path}\t${u}`); // S3: name candidates
  }
  for (const p of (snap?.codexOpen || [])) lines.push(`CO ${p}`); // S3: open rollouts = running threads
  return lines.join('\n');
}

module.exports = {
  extractTailIds, nameFromUserRecord, nameFromUserLine, nameFromText, pidLooksClaude, interpretDiscoveryLines, synthesizeDiscoveryLines, NAME_MAX,
  // S3 (codex facts + zstd rollouts)
  deriveCodexSessionName, nameFromCodexUserLine, listOpenCodexRolloutPaths, isCodexCommandLine, CODEX_TID_RE, CODEX_ROLLOUT_RE, codexThreadIdOf,
  ZSTD_SUPPORTED, isZstPath, isZstBuffer, zstdDecompressFrames, zstdDecompressHead, readHeadText,
};
