'use strict';
// STDOUT CONSUMER REGISTRY (harness S5, docs/design-harness-plugins.md §2.4).
// ONE consumer per declared stream protocol: the harness descriptor NAMES the
// protocol (caps.streamProtocol — the backend-caps row, pinned identical by
// test-harness-contract), this map resolves it to the parse pipeline, and
// session-stdout's setupSessionPty does nothing but look it up and attach.
// The consumers stay ORCH (they consume the pool/quota engine, the machine
// handle, the ledger, the delivery ladder — none of which the daemon has), so
// a SHARED descriptor cannot carry them; the design's "descriptor.stream.parse"
// is realised as descriptor-names-it + registry-resolves-it.
//
// Contract of a consumer module: `create(deps)` → `{ protocol, attach(session,
// id, ptyProcess, helpers) }`. deps = the orchestrator singletons the branch
// used through session-stdout's create (engine, activeSessions, stream-type
// breadcrumbs, goal sync, model registries, sbSeenFirst, lazy hosts/ledger/
// deliver); helpers = session-stdout's own per-engine closures (feedLive, the
// two broadcasts, the session-meta store, the todo helpers). A module whose
// `protocol` disagrees with its registry key is a wiring bug and throws at
// boot. Unknown protocols resolve to null here — session-stdout reports them
// LOUDLY at session start (console.error + telemetry, raw passthrough); a
// chat backend is never silently parsed as stream-json.
// scripts/test-stdout-registry.mjs drives every consumer on a fake pty;
// test-harness-contract pins that every chat harness's protocol has a row here.
const CONSUMERS = Object.freeze({
  'stream-json': require('./claude-stream-json.js'),
  'codex-events': require('./codex-events.js'),
  'acp-events': require('./acp-events.js'),
});
const PROTOCOLS = Object.freeze(Object.keys(CONSUMERS));

/** Pure lookup (no deps needed): does a registered consumer exist for this protocol? */
function hasConsumer(protocol) {
  return typeof protocol === 'string' && Object.prototype.hasOwnProperty.call(CONSUMERS, protocol);
}

/** Build every consumer once with the orchestrator deps. */
function createStdoutRegistry(deps) {
  const built = new Map();
  for (const [proto, mod] of Object.entries(CONSUMERS)) {
    if (mod.protocol !== proto) throw new Error(`stdout consumer registered under '${proto}' declares protocol '${mod.protocol}' — registry key and module must agree`);
    const c = mod.create(deps);
    if (!c || c.protocol !== proto || typeof c.attach !== 'function') throw new Error(`stdout consumer for '${proto}' must return { protocol: '${proto}', attach() } (got ${c && c.protocol})`);
    built.set(proto, c);
  }
  return {
    get: (proto) => built.get(proto) || null,   // null = no consumer; the caller reports it loudly
    has: (proto) => built.has(proto),
    protocols: () => [...built.keys()],
  };
}

module.exports = { CONSUMERS, PROTOCOLS, hasConsumer, createStdoutRegistry };
