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
const { AUTO_RESUME_FORMS, NO_AUTO_RESUME, deriveAutoResume } = require('../backend-caps');

const QUOTA_PROBE_RUNGS = Object.freeze(['cli-usage', 'rpc-rate-limits', null]);
const REQUIRED = ['id', 'label', 'kind', 'caps', 'Adapter', 'adapterConfig', 'wrapper'];

/** Can this harness's QuotaSignalSource ever CLASSIFY a limit? NULL_QUOTA is
 *  the frozen, shared "honest nothing" (shell, and every ACP agent), so a
 *  source that IS it — or that merely re-uses its classifier — has no limit
 *  signal. Asked by identity rather than by a declared boolean on purpose: a
 *  capability a harness could hand-set is a capability it can lie about, and
 *  this one gates unattended spending. */
function hasLimitSignal(quota) {
  if (!quota || typeof quota.signalFromStream !== 'function') return false;
  if (quota === NULL_QUOTA) return false;
  return quota.signalFromStream !== NULL_QUOTA.signalFromStream;
}

/** AUTO-RESUME'S RESUME VERB (owner ruling 2026-09-08). `null` is a valid
 *  DECLARATION ("there is no way to restart a turn here" — shell). Anything
 *  else must be a real `{form, deliver}`; an undeclared form or a missing
 *  deliver THROWS at registration, so a harness cannot inherit a verb it has
 *  not implemented and no surface can offer a control nothing serves. */
function assertResumeContract(id, resume) {
  if (resume == null) return null;
  if (typeof resume !== 'object') throw new Error(`harness '${id}': resume must be {form, deliver} or null`);
  if (!AUTO_RESUME_FORMS.includes(resume.form)) throw new Error(`harness '${id}': resume.form must be one of ${AUTO_RESUME_FORMS.join('|')} (got ${JSON.stringify(resume.form)})`);
  if (typeof resume.deliver !== 'function') throw new Error(`harness '${id}': resume.deliver(session, text, deps) must be a function`);
  return resume;
}

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
  assertResumeContract(h.id, h.resume);
  // THE AUTO-RESUME CAPS ROW IS DERIVED HERE, from what the descriptor really
  // implements — never hand-set on the caps literal (which carries the honest
  // NO_AUTO_RESUME placeholder so an unregistered id still answers). `h.caps`
  // IS the BACKEND_CAPS row object (test-harness-contract pins that identity),
  // so `capsOf(id).autoResume` and the client mirror see this the moment the
  // registry loads. A contributed harness gets the same treatment.
  if (h.caps && typeof h.caps === 'object') {
    h.caps.autoResume = deriveAutoResume({
      hasLimitSignal: hasLimitSignal(h.quota),
      resumeForm: h.resume ? h.resume.form : null,
    });
  }
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

/** The auto-resume caps row for one harness id — the ONE reader every surface
 *  and the engine use, so "can this session be armed / continued" is never a
 *  backend-id branch. Unknown id = the honest nothing (never a throw: this is
 *  asked about live sessions whose backend may predate the registry). */
function autoResumeCaps(id) {
  try { return get(id).caps.autoResume || NO_AUTO_RESUME; } catch { return NO_AUTO_RESUME; }
}
/** The harness's own resume verb `{form, deliver}` — null when it has none.
 *  auto-resume's fire path calls THIS; the ORCH channel arrives in `deps`. */
function resumeVerb(id) {
  try { return get(id).resume || null; } catch { return null; }
}

module.exports = { HARNESSES, harnessOf, harnessIds, chatHarnessIds, REQUIRED_DESCRIPTOR_KEYS: REQUIRED, get, has, list, ids, register, unregister, assertQuotaContract, QUOTA_PROBE_RUNGS, NULL_QUOTA,
  hasLimitSignal, assertResumeContract, autoResumeCaps, resumeVerb, AUTO_RESUME_FORMS, NO_AUTO_RESUME };
