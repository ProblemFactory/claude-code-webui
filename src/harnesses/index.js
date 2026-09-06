'use strict';
// HARNESS REGISTRY (S1 + S4 of docs/design-harness-plugins.md §2, 2.369.18).
// ONE object per agent harness = everything "a backend" means, declared in one
// place: identity, capabilities, the adapter class + its config mapping, the
// normalizer class, the chat wrapper file, the store/locator functions and the
// QuotaSignalSource. Consumers (adapter registry, normalizer registry, the
// pool/quota engine, the conformance suite) read THIS; a new harness adds a
// descriptor file (built-in) or calls register() (plugin tier-5), never an
// if-chain. Unknown ids fail LOUDLY — the gemini-as-claude fallthrough class
// is a bug we already paid for once; nothing here ever defaults to claude.
// The live stdout PARSE for a chat harness is NOT on the descriptor (it needs
// orchestrator deps a daemon lacks): caps.streamProtocol NAMES it and
// src/server/stdout/index.js RESOLVES it (S5) — test-harness-contract pins that
// every chat harness's protocol has a registered consumer and that no
// stdout/stream twin of caps.streamProtocol exists here.
const { NULL_QUOTA } = require('./null-quota');

const QUOTA_PROBE_RUNGS = Object.freeze(['cli-usage', 'rpc-rate-limits', null]);
const REQUIRED = ['id', 'label', 'kind', 'caps', 'Adapter', 'adapterConfig', 'wrapper'];

/** The quota contract every harness carries (S4): the engine reaches quota
 *  behaviour through this object, never through a backend-id branch. */
function assertQuotaContract(id, quota) {
  if (!quota || typeof quota !== 'object') throw new Error(`harness '${id}': quota contract missing (use NULL_QUOTA for a harness without quota)`);
  for (const fn of ['normalize', 'signalFromStream', 'classifyAuthFailure']) {
    if (typeof quota[fn] !== 'function') throw new Error(`harness '${id}': quota.${fn} must be a function`);
  }
  if (!QUOTA_PROBE_RUNGS.includes(quota.probe)) throw new Error(`harness '${id}': quota.probe must be one of ${QUOTA_PROBE_RUNGS.map(String).join('|')} (got ${String(quota.probe)})`);
}

/** Built-ins must declare every key (null is a valid declaration for a
 *  terminal-only harness: wrapper/Normalizer/store); chat-capable ones must
 *  fill them. Contributed harnesses (register) need id + quota at minimum —
 *  the plugin loader validates the rest against the tier it grants. */
function validate(h, { full = true } = {}) {
  if (!h || typeof h !== 'object') throw new Error('harness descriptor must be an object');
  if (typeof h.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(h.id)) throw new Error(`harness id must be a lowercase slug (got ${JSON.stringify(h.id)})`);
  if (full) {
    const missing = REQUIRED.filter((k) => !(k in h));
    if (missing.length) throw new Error(`harness "${h.id}" descriptor is missing: ${missing.join(', ')}`);
    if (h.kind === 'chat') {
      for (const k of ['wrapper', 'Normalizer', 'store']) if (!h[k]) throw new Error(`harness "${h.id}" is chat-capable but declares no ${k}`);
    }
  }
  assertQuotaContract(h.id, h.quota);
  return h;
}

const REGISTRY = new Map();
const BUILTIN = new Set();
// opencode = the first ACP v1 harness (S8): acpHarness({...}) in ./opencode.js —
// the generic wrapper/adapter/normalizer are shared by every ACP agent.
for (const h of [require('./claude'), require('./codex'), require('./shell'), require('./opencode')]) {
  REGISTRY.set(validate(h).id, h);
  BUILTIN.add(h.id);
}
/** The built-in descriptors (frozen view; registries that build at load time — adapters, normalizers — iterate this). */
const HARNESSES = Object.freeze(Object.fromEntries([...REGISTRY].filter(([id]) => BUILTIN.has(id))));

/** Look a harness up. Unknown/empty id THROWS — callers that can tolerate
 *  absence use has() first. */
function get(id) {
  if (!id) throw new Error('harness id required (a session/account without a backend is a bug, not a claude)');
  const h = REGISTRY.get(id);
  if (!h) throw new Error(`unknown harness '${id}' — register it in src/harnesses/ (built-in descriptor) or via register() (plugin); core never falls through to claude`);
  return h;
}
const harnessOf = get;
function has(id) { return !!id && REGISTRY.has(id); }
function list() { return [...REGISTRY.values()]; }
function ids() { return [...REGISTRY.keys()]; }
const harnessIds = ids;
/** Chat-capable harnesses only (shell is terminal-only). */
function chatHarnessIds() { return ids().filter((id) => REGISTRY.get(id).kind === 'chat'); }

/** Register a contributed harness (plugin tier-5 in the design; tests). A
 *  built-in id can never be replaced; a duplicate contributed id needs
 *  {replace:true} — silent shadowing is how twins are born. */
function register(h, { replace = false } = {}) {
  validate(h, { full: false });
  if (BUILTIN.has(h.id)) throw new Error(`harness '${h.id}' is built-in and cannot be replaced`);
  if (REGISTRY.has(h.id) && !replace) throw new Error(`harness '${h.id}' already registered (pass {replace:true} to override)`);
  REGISTRY.set(h.id, h);
  return h;
}
function unregister(id) {
  if (BUILTIN.has(id)) throw new Error(`harness '${id}' is built-in and cannot be unregistered`);
  return REGISTRY.delete(id);
}

module.exports = { HARNESSES, harnessOf, harnessIds, chatHarnessIds, REQUIRED_DESCRIPTOR_KEYS: REQUIRED, get, has, list, ids, register, unregister, assertQuotaContract, QUOTA_PROBE_RUNGS, NULL_QUOTA };
