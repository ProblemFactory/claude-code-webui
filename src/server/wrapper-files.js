// Resolve the CHAT WRAPPER's actual buffer/sidecar file pair for a session
// (2.339.2, the 设备运维大师 stuck-thinking incident). The expected pair is
// <BUFFERS_DIR>/<id>.{buf,json} — but sessions born in the 2.302.0
// counter-collision window carry a DIFFERENT id inside the wrapper argv/env
// than their socket/meta filename (7/15 fleet sessions measured back then),
// so the sidecar the wrapper actually maintains lives under the OTHER id and
// every restart silently restored nothing for them: streaming state, goal,
// todos, running-agent watchers and the buffer replay all vanished into a
// catch{}. Fallback: the dtach MASTER process of the session's socket carries
// the wrapper argv, and argv[2] IS the buffer path — read it out of /proc
// (Linux; best-effort, returns the expected pair when anything fails).
const fs = require('fs');
const path = require('path');

function resolveWrapperFiles(BUFFERS_DIR, id, sockPath) {
  const expected = { buf: path.join(BUFFERS_DIR, id + '.buf'), sidecar: path.join(BUFFERS_DIR, id + '.json') };
  try {
    if (fs.existsSync(expected.sidecar)) return expected;
    if (!sockPath) return expected;
    for (const pidDir of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pidDir)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(path.join('/proc', pidDir, 'cmdline'), 'utf-8'); } catch { continue; }
      // the dtach MASTER: `dtach -c <sockPath> … chat-wrapper.js <buf> <sidecar> …`
      if (!cmd.includes(sockPath) || !cmd.includes('dtach\0-c\0') || !/(chat|acp)-wrapper\.js/.test(cmd)) continue; // claude/codex chat wrappers + the ACP wrapper (S8)
      const argv = cmd.split('\0');
      const buf = argv.find((a) => a.endsWith('.buf'));
      if (buf) {
        console.log(`[restore] ${id}: wrapper files resolved via /proc (counter-collision session) → ${path.basename(buf)}`);
        return { buf, sidecar: buf.replace(/\.buf$/, '.json') };
      }
    }
  } catch { }
  return expected;
}

/** The wrapper's self-reported CAPABILITIES (2.364.1). The caps marker lives
 *  in the wrapper SIDECAR (<BUFFERS_DIR>/<id>.json — the file chat-wrapper.js
 *  itself writes at boot), looked up through the same collision-aware
 *  resolver as every other sidecar read. NEVER read it from data/session-meta:
 *  that is the SERVER's record and carries no caps — the 2.361.1 gate did
 *  exactly that, so every wrapper tested "old", every >1MB paste was refused
 *  for two releases, and the refusal text sent users to Terminate+Resume
 *  sessions that were already new (owner: three restarts + an update for
 *  nothing). STATELESS by design — callers must not cache a negative verdict
 *  (a wrapper resuming a huge transcript may not have written its sidecar yet).
 *  Returns { frameFile, peerMessage, inputQueue, responseStyle, permissionRules, caps, reason: 'ok'|'no-caps'|'no-sidecar', startedAt, pid }.
 *  permissionRules (owner ruling 10): the RUNNING wrapper serves the READ-ONLY
 *  `read-permission-rules` stdin verb. Same two-gate rule again — the harness
 *  caps row (`permissionRules.liveVerb`) says this KIND of agent answers over
 *  the session, this says THIS process does; a wrapper spawned before the verb
 *  existed would drop the frame without a word (2.361.1/2.364.1).
 *  responseStyle (2.369.58): the RUNNING wrapper serves the `set-response-style`
 *  stdin verb (codex: thread/settings/update). Same two-gate rule as inputQueue —
 *  the harness caps row says the KIND of agent can do it live, this says THIS
 *  process can.
 *  inputQueue (2026-09-06): the RUNNING wrapper publishes `queue_changed` and
 *  serves the `queue-op` stdin verb. backend-caps says what the HARNESS can do;
 *  this says what THIS process can do — a codex session spawned before the
 *  queue/steer release wears the harness capability but would drop the frame
 *  silently (the 2.361.1/2.364.1 skew class), so both gates must pass.
 *  queueVerbs (verb table, design-harness-features §2.1): WHICH queue verbs
 *  this process serves. A wrapper that adverts `inputQueue` but no list is a
 *  2.369.55-or-older build — it serves exactly LEGACY_QUEUE_VERBS, so the new
 *  verbs are refused for it with a reason while remove/steer keep working
 *  (the skew rule again: an old process must never be asked for a verb it
 *  would drop, and must never lose the verbs it does serve). */
// What a wrapper that adverts `inputQueue` WITHOUT a verb list serves: the
// three verbs that existed before the verb table (2.369.55 and older). The
// list itself lives in the PURE module — the CLIENT applies the same mapping
// to a verb-less in-band publication, and two hand-kept copies of "what an old
// wrapper serves" is how the two ends came to disagree (round-2 verifier).
const { LEGACY_QUEUE_VERBS } = require('../backend-caps.js');

/** The longest text a queue `edit` may carry. The WRAPPER's own limit (it
 *  publishes `text` — i.e. offers the edit control at all — only for items at
 *  or under this, `QUEUE_EDIT_MAX_CHARS` in data/bin/codex-chat-wrapper.js,
 *  parity-pinned by scripts/test-queue-steer.mjs), mirrored here because the
 *  queue-op frame goes to the wrapper over RAW PTY STDIN with no frame-file
 *  bypass: an unbounded `text` is the shredding class the bypass exists to
 *  prevent (kb-bugfix-invariants, the 79928a2b/c1206711 line). A wrapper that
 *  never offered the control cannot be handed a megabyte through it. */
const QUEUE_EDIT_MAX_CHARS = 20000;

/** …and the transport ceiling for ANY queue-op frame: the pty-stdin write path
 *  is only safe below the same 64KiB the `input` case uses to decide it needs
 *  the frame file. JSON escaping can multiply a string by six (control chars →
 *  \uXXXX), so the char cap above does not imply this one — both are checked,
 *  and neither is silent. */
const QUEUE_OP_MAX_BYTES = 64 * 1024;

function wrapperCaps(BUFFERS_DIR, id, sockPath) {
  const { sidecar } = resolveWrapperFiles(BUFFERS_DIR, id, sockPath);
  let m;
  try { m = JSON.parse(fs.readFileSync(sidecar, 'utf-8')); } catch { return { frameFile: false, peerMessage: false, inputQueue: false, queueVerbs: [], responseStyle: false, permissionRules: false, caps: null, reason: 'no-sidecar', startedAt: null, pid: null }; }
  const caps = (m && m.caps && typeof m.caps === 'object') ? m.caps : null;
  const inputQueue = !!(caps && caps.inputQueue);
  const queueVerbs = Array.isArray(caps && caps.queueVerbs)
    ? caps.queueVerbs.map((v) => String(v))
    : (inputQueue ? LEGACY_QUEUE_VERBS.slice() : []);
  return { frameFile: !!(caps && caps.frameFile), peerMessage: !!(caps && caps.peerMessage), inputQueue, queueVerbs, responseStyle: !!(caps && caps.responseStyle), permissionRules: !!(caps && caps.permissionRules), caps, reason: caps ? 'ok' : 'no-caps', startedAt: (m && m.startedAt) || null, pid: (m && m.pid) || null };
}

module.exports = { resolveWrapperFiles, wrapperCaps, LEGACY_QUEUE_VERBS, QUEUE_EDIT_MAX_CHARS, QUEUE_OP_MAX_BYTES };
