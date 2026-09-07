'use strict';
/**
 * ONE way to reach the OpenCode serve on ANY machine (S9 remainder piece (e),
 * B-eac2). ORCH tier: it owns only the DISPATCH — which transport reaches the
 * machine named by `hostId` — while the op names/shapes live in the SHARED
 * table src/opencode-remote.js and the work itself runs where the store is.
 *
 *   hostId falsy      → this machine's own facts singleton (the shared module,
 *                       in-process; the local rung is not a special case, it is
 *                       just the transport with zero hops)
 *   paired device     → the `opencode-serve` agentd op (the daemon bundles the
 *                       same module and calls the same runOpencodeOp)
 *   ssh host          → data/bin/vibespace-opencode-op, the shipped fallback
 *
 * The CS law it exists to keep: `hostId` is a PARAMETER, never a branch. Every
 * route and ws case below takes it and passes it through; nothing downstream
 * asks "is this remote?" again.
 *
 * TWO NORMALISATIONS live here because they must be identical on every rung:
 *   • `read` — the ssh rung ships the RAW v1 message payload (a checkout-less
 *     host has no messagesToAcpRecords), so the records are synthesised HERE
 *     with the SHARED function. One synthesis implementation, three rungs.
 *   • `pty-open` — the serve's ws url + auth header are SERVER-SIDE ONLY. They
 *     are stripped from anything returned to a caller that might reach a
 *     browser; the ws-create bridge asks for them through `openPtyBridge`.
 */
const { runOpencodeOp, OPENCODE_OP_NAMES } = require('../opencode-remote');
const { messagesToAcpRecords, facts: localFacts } = require('../opencode-serve');

/** Ops that only work where the SERVER can reach the serve's loopback ws.
 *  On a remote machine that socket is not reachable from here (the ssh rung
 *  says so itself; a paired device would need the port-forward data plane) —
 *  refuse LOUDLY rather than open a terminal window that never fills. */
const LOCAL_ONLY_OPS = new Set(['pty-open', 'pty-close', 'pty-resize']);

let installed = null;

/** The wired access layer. ws-handler / ws-create reach it through this
 *  getter instead of a server.js cross (the file is bootstrap-sized and
 *  ratcheted); an unwired process gets a LOUD refusal, never a no-op. */
function access() {
  return installed || {
    call: async () => { throw new Error('the OpenCode access layer is not wired on this instance'); },
    readConversation: async () => { throw new Error('the OpenCode access layer is not wired on this instance'); },
    openPtyBridge: async () => { throw new Error('the OpenCode access layer is not wired on this instance'); },
    publicView: (_op, r) => r,
  };
}

/** Wire it ONCE from server.js: builds the layer, mounts the action routes and
 *  publishes the singleton. Returns the layer. */
function create({ app = null, hosts = null, facts = null, broadcast = null, log = console } = {}) {
  const factsOf = () => (facts || localFacts());

  /** Run one op on the machine named by hostId. Throws with the machine-side
   *  reason on every failure (no silent failures law). */
  async function call(hostId, op, params = {}) {
    if (!OPENCODE_OP_NAMES.includes(op)) throw new Error(`unknown opencode op '${op}'`);
    if (!hostId) return runOpencodeOp(factsOf(), op, params);
    if (LOCAL_ONLY_OPS.has(op)) throw new Error(`"${op}" only works on this machine — the OpenCode terminal is served over a loopback websocket the hub cannot reach on ${hostId}`);
    if (!hosts?.opencodeOp) throw new Error('remote machines are not configured on this instance');
    return hosts.opencodeOp(hostId, op, params);
  }

  /** {session, records} for a conversation on any machine. */
  async function readConversation(hostId, id) {
    const r = await call(hostId, 'read', { id });
    if (Array.isArray(r?.records)) return { session: r.session || null, records: r.records };
    // ssh rung: raw v1 messages → the SHARED synthesis, here, once
    return { session: r?.session || null, records: messagesToAcpRecords(Array.isArray(r?.messages) ? r.messages : [], r?.session || {}) };
  }

  /** The pty bridge payload — url + auth INCLUDED. Only ws-create calls this,
   *  and what it returns never leaves the server process. */
  async function openPtyBridge({ cwd = null, title = null, command = null, args = null } = {}) {
    const r = await call(null, 'pty-open', { cwd, title, command, args });
    if (!r?.url) throw new Error('OpenCode returned no terminal stream url');
    return r;
  }

  /** Everything a ROUTE may hand back: the same result with the transport
   *  secrets removed. */
  function publicView(op, result) {
    if (op !== 'pty-open') return result;
    const { url, auth, ...rest } = result || {};
    return rest;
  }

  const layer = { call, readConversation, openPtyBridge, publicView, LOCAL_ONLY_OPS, log };
  installed = layer;
  if (app) {
    const { router, setup } = require('../routes/opencode');
    setup({ access: layer, broadcast });
    app.use(router);
  }
  return layer;
}

module.exports = { create, access, LOCAL_ONLY_OPS };
