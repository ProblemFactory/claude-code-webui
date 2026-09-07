'use strict';
/**
 * THE OpenCode-serve OP TABLE — one definition of "what can be asked of the
 * OpenCode serve on a machine", so the three transports cannot drift
 * (S9 remainder piece (e), B-eac2; the CS separation law: `hostId` is a
 * PARAMETER, never a branch).
 *
 * SHARED tier: imports NOTHING but the facts object it is handed. It runs
 *   • in the server process, against the local `facts()` singleton;
 *   • inside `agentd` on a paired device (the daemon bundles src/opencode-serve.js
 *     and builds its own facts there — the SAME code, executed where the store is);
 *   • mirrored by data/bin/vibespace-opencode-op, the shipped single file for
 *     checkout-less ssh hosts (the documented "shipped scanner" exception —
 *     an ssh host has no checkout, so it cannot require this module; the
 *     parity suite scripts/test-opencode-remote.mjs pins the op names,
 *     required params and result keys on both sides).
 *
 * WHY A TABLE AND NOT A METHOD PER TRANSPORT: the 2.276.0 twin-set lesson.
 * Every "reach the serve" caller names an op from OPENCODE_OPS and passes a
 * hostId; adding an op is ONE row plus one mirror line in the shipped script,
 * and the parity suite fails a one-sided edit.
 *
 * The RESULT of every op is plain JSON (it crosses a device link / an ssh
 * pipe), and every FAILURE is an Error whose message names the machine-side
 * cause — a rung that swallows a failure would leave the user's action
 * silently undone.
 */

/** op name → { member, required[], build(params) → args[], result(v) → json }
 *  `member` is the facts method; `build` maps the wire params onto its
 *  arguments; `result` normalises the return so all three rungs agree. */
const OPENCODE_OPS = {
  state: {
    member: 'state', required: [], build: () => [],
    result: (v) => ({
      installed: !!v?.installed, ready: !!v?.ready, parked: !!v?.parked, parkedKind: v?.parkedKind || null,
      version: v?.version || null, port: v?.port || null, caps: v?.caps || null,
      liveLaneHealthy: !!v?.liveLaneHealthy, pendingQuestions: v?.pendingQuestions || 0,
      busySessions: v?.busySessions || 0, lastError: v?.lastError || null,
    }),
  },
  discover: {
    member: 'discover', required: [], build: (p) => [{ activeSessions: new Map(), budgetMs: p?.budgetMs || undefined }],
    result: (v) => ({ sessions: Array.isArray(v) ? v : [] }),
  },
  read: {
    member: 'readConversation', required: ['id'], build: (p) => [String(p.id), {}],
    // the records ARE the payload (the reader replays them); messages are dropped
    // on the wire — they are the same facts, twice, and the big half
    result: (v) => ({ session: v?.session || null, records: Array.isArray(v?.records) ? v.records : [] }),
  },
  revert: {
    member: 'revertTo', required: ['id', 'messageID'],
    build: (p) => [String(p.id), { messageID: String(p.messageID), partID: p.partID || null, cwd: p.cwd || null }],
    result: (v) => ({ session: v || null }),
  },
  unrevert: {
    member: 'unrevert', required: ['id'], build: (p) => [String(p.id), { cwd: p.cwd || null }],
    result: (v) => ({ session: v || null }),
  },
  questions: {
    member: 'pendingQuestions', required: [],
    build: (p) => [{ sessionId: p?.sessionId || null, refresh: p?.refresh !== false }],
    result: (v) => ({ questions: Array.isArray(v) ? v : [] }),
  },
  answer: {
    member: 'answerQuestion', required: ['requestId', 'answers'],
    build: (p) => [String(p.requestId), p.answers],
    result: (v) => ({ ok: !!v?.ok, sessionID: v?.sessionID || null, answers: v?.answers || null }),
  },
  reject: {
    member: 'rejectQuestion', required: ['requestId'], build: (p) => [String(p.requestId), {}],
    result: (v) => ({ ok: !!v?.ok, sessionID: v?.sessionID || null }),
  },
  'pty-open': {
    member: 'openPty', required: [],
    build: (p) => [{ cwd: p?.cwd || null, command: p?.command || null, args: Array.isArray(p?.args) ? p.args : null, title: p?.title || null }],
    // NOTE the deliberate asymmetry: `url`/`auth` are how the SERVER connects
    // to the serve's ws. They are returned across a device link (which is
    // already the trusted control plane) and are stripped before anything
    // reaches a browser — see src/server/opencode-access.js.
    result: (v) => ({ pty: v?.pty || null, url: v?.url || null, auth: v?.auth || null, ticketed: !!v?.ticketed }),
  },
  'pty-close': {
    member: 'closePty', required: ['ptyId'], build: (p) => [String(p.ptyId), { cwd: p?.cwd || null }],
    result: (v) => ({ ok: !!v?.ok }),
  },
  'pty-resize': {
    member: 'resizePty', required: ['ptyId'],
    build: (p) => [String(p.ptyId), { rows: Number(p.rows) || 24, cols: Number(p.cols) || 80, cwd: p?.cwd || null }],
    result: (v) => ({ ok: !!v?.ok }),
  },
  status: {
    member: 'statusMap', required: [], build: () => [{}],
    result: (v) => ({ statuses: v && typeof v === 'object' ? v : {} }),
  },
  todos: {
    member: 'todos', required: ['id'], build: (p) => [String(p.id), {}],
    result: (v) => ({ todos: Array.isArray(v) ? v : [] }),
  },
};

// DELIBERATELY ABSENT: `fork`. The harness descriptor's own `store.forkSession`
// owns forking, and ws-create takes that path only for a LOCAL conversation
// (an explicit `!data.hostId` guard) — a remote fork is refused today, not
// silently done on the wrong machine. A row here that nothing can reach is a
// dead row, and scripts/test-opencode-s9.mjs fails one.
const OPENCODE_OP_NAMES = Object.freeze(Object.keys(OPENCODE_OPS));

/** Validate + normalise wire params for an op. PURE; throws with the op name
 *  and the missing key so a rung never fails as an unexplained 500. */
function checkOpParams(op, params) {
  const def = OPENCODE_OPS[op];
  if (!def) throw new Error(`unknown opencode op '${op}' (known: ${OPENCODE_OP_NAMES.join(', ')})`);
  const p = params && typeof params === 'object' ? params : {};
  for (const k of def.required) {
    const v = p[k];
    if (v === undefined || v === null || v === '') throw new Error(`opencode op '${op}' needs '${k}'`);
  }
  return p;
}

/** Execute one op against a facts object. This is the WHOLE machine-side
 *  implementation: the daemon handler and the local rung both call it, so
 *  "runs where the facts live" is literally the same function. */
async function runOpencodeOp(facts, op, params = {}) {
  const def = OPENCODE_OPS[op];
  const p = checkOpParams(op, params);
  if (typeof facts?.[def.member] !== 'function') throw new Error(`opencode op '${op}' is not available on this machine (no ${def.member})`);
  const out = await facts[def.member](...def.build(p));
  return def.result(out);
}

module.exports = { OPENCODE_OPS, OPENCODE_OP_NAMES, checkOpParams, runOpencodeOp };
