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
 *  Returns { frameFile, peerMessage, inputQueue, caps, reason: 'ok'|'no-caps'|'no-sidecar', startedAt, pid }.
 *  inputQueue (2026-09-06): the RUNNING wrapper publishes `queue_changed` and
 *  serves the `queue-op` stdin verb. backend-caps says what the HARNESS can do;
 *  this says what THIS process can do — a codex session spawned before the
 *  queue/steer release wears the harness capability but would drop the frame
 *  silently (the 2.361.1/2.364.1 skew class), so both gates must pass. */
function wrapperCaps(BUFFERS_DIR, id, sockPath) {
  const { sidecar } = resolveWrapperFiles(BUFFERS_DIR, id, sockPath);
  let m;
  try { m = JSON.parse(fs.readFileSync(sidecar, 'utf-8')); } catch { return { frameFile: false, peerMessage: false, inputQueue: false, caps: null, reason: 'no-sidecar', startedAt: null, pid: null }; }
  const caps = (m && m.caps && typeof m.caps === 'object') ? m.caps : null;
  return { frameFile: !!(caps && caps.frameFile), peerMessage: !!(caps && caps.peerMessage), inputQueue: !!(caps && caps.inputQueue), caps, reason: caps ? 'ok' : 'no-caps', startedAt: (m && m.startedAt) || null, pid: (m && m.pid) || null };
}

module.exports = { resolveWrapperFiles, wrapperCaps };
