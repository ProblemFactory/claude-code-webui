'use strict';
/**
 * usage-cache-write.js — THE ONE WRITE PATH for data/usage-cache/*.json
 * (docs/design-account-hardening.md §4.2 / P4, with the typed model of
 * src/quota-model.js).
 *
 * WHAT IT REPLACES. Nine producers wrote this store, each with its own
 * read-modify-write and its own idea of what a snapshot is:
 *
 *   statusline ingest (shipped tool) · on-demand `claude -p /usage` panel ·
 *   bare-token ⟳ · rate_limit_event capture (+ its sibling fan-out) ·
 *   the wall/limit-banner mark · the codex live app-server push ·
 *   the codex rollout-tail summariser · the remote host-* harvest ·
 *   the repair migration
 *
 * Every one of them rebuilt the whole object, so the store's history is a list
 * of fields that were silently lost because ONE of the nine forgot to carry
 * them forward: `scopedWeekly`, the org identity, `spend`, `corroborated`, and
 * — the one that replayed a live incident — the established window (which is
 * why that fact now lives in a SIDECAR no producer writes). And because the
 * object could hold exactly one set of buckets, codex's three concurrent limits
 * collapsed into whichever pushed last (B-9213).
 *
 * WHAT IT GUARANTEES.
 *  1. **Per-limit merge, never last-writer-wins.** A producer that knows about
 *     one limit updates one limit; the others are carried forward untouched.
 *  2. **The legacy snapshot is a DERIVED VIEW.** `fiveHour` / `sevenDay` /
 *     `scopedWeekly` / `overage` are PROJECTED from the merged `limits` after
 *     every write, so a reader that has not migrated yet still sees a
 *     consistent object — and sees the PLAN limit's numbers, deterministically,
 *     instead of whichever limit spoke last.
 *  3. **A malformed set never lands.** The validator runs on what we are about
 *     to persist; our own producer being wrong is a bug we refuse to write, a
 *     corrupt file already on disk is a fact we heal past (its limits are
 *     dropped, loudly, and the new reading proceeds).
 *  4. **Provenance per limit.** `source` and `fetchedAt` are stamped on the
 *     LIMIT, not only on the file, so a panel showing three limits side by side
 *     can say who produced each number and how old it is.
 *
 * WHAT IT DOES NOT DO. It does not decide WHICH key a reading belongs to. That
 * is the slot/window question and it already has an owner: the caller resolves
 * the key (`readingSlotFor`) and may hand us a `guard` (the engine's
 * `guardReadingTarget`, i.e. src/reading-lag.js ②) which we call before
 * touching anything. Composing, never forking — a second answer to "whose
 * numbers are these" is exactly the defect class this store has already
 * suffered five times.
 *
 * SHARED tier: fs/path + the PURE model + the harness parsers. The daemon can
 * bundle it, and the shipped statusline tool mirrors the RULES it needs
 * (src/reading-lag.js's sentinels) rather than requiring this file.
 */
const fs = require('fs');
const path = require('path');
const quotaModel = require('./quota-model.js');

/** THE cache filename rule, in ONE place. Every producer spelled this inline;
 *  a key that sanitises differently in two places is two different accounts. */
function cacheFileFor(cacheDir, key) {
  return path.join(cacheDir, String(key).replace(/[^\w.-]/g, '_') + '.json');
}

/** Is this directory entry a usage-cache SNAPSHOT? (Not `__models__.json`, not
 *  a `.window-`/`.slot-` sidecar — those deliberately carry no `.json`.) */
function isCacheFileName(fn) { return /\.json$/.test(fn) && !fn.startsWith('__models__'); }

function readCacheObject(cacheDir, key) {
  try { return JSON.parse(fs.readFileSync(cacheFileFor(cacheDir, key), 'utf-8')) || null; } catch { return null; }
}

// ── lifting a stored object into the typed model ────────────────────────────

/** Which harness shape is this legacy object? By its FIELDS, never by the key
 *  name — `__global_codex__` is a convention, `limitId` + `windowMinutes` is
 *  evidence. A claude snapshot never carries `limitId`. */
function backendOfCacheObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.limitId !== undefined || obj.rateLimitReachedType !== undefined || obj.spendControlReached !== undefined) return 'codex';
  if (obj.scopedWeekly !== undefined || obj.overallStatus !== undefined || obj.spend !== undefined) return 'claude';
  if (obj.fiveHour && typeof obj.fiveHour === 'object' && obj.fiveHour.windowMinutes) return 'codex';
  return 'claude'; // the historical default: this store was claude-only for a year
}

/** A stored cache object → a typed LimitSet. Uses the canonical `limits` array
 *  when the file already has one; otherwise lifts the legacy view (which is
 *  what every file written before this module holds).
 *
 *  `familyOf` is INJECTED (src/model-family.js) — quota-model is PURE and this
 *  module must not decide the family vocabulary either. */
function liftCacheObject(obj, { identity = null, backend = null, familyOf = null, measuredAt = null } = {}) {
  if (!obj || typeof obj !== 'object') return quotaModel.makeLimitSet({ identity });
  if (Array.isArray(obj.limits)) {
    return quotaModel.makeLimitSet({ identity, fetchedAt: obj.fetchedAt, source: obj.source, limits: obj.limits });
  }
  const be = backend || backendOfCacheObject(obj);
  const at = Number(measuredAt) || Number(obj.fetchedAt) || null;
  if (be === 'codex') {
    const { limitSetFromSnapshot } = require('./harnesses/codex-quota.js');
    return limitSetFromSnapshot({ ...obj, fetchedAt: at || obj.fetchedAt }, { identity, source: obj.source || null })
      || quotaModel.makeLimitSet({ identity, fetchedAt: obj.fetchedAt, source: obj.source });
  }
  const { CLAUDE_EXTRA_KEYS } = require('./harnesses/claude-quota.js');
  return quotaModel.fromLegacy(obj, {
    identity, source: obj.source || null, fetchedAt: at, limitId: 'plan', familyOf, extraKeys: CLAUDE_EXTRA_KEYS,
  });
}

/** THE READ-SIDE ENTRY every consumer uses: a cache object (whatever era it
 *  was written in) → the typed set the accessors take. Exported so readers do
 *  not each re-invent "does this file have `limits` yet". */
function limitsOfCache(obj, opts = undefined) { return liftCacheObject(obj, opts); }

// ── the write ───────────────────────────────────────────────────────────────

/** Fields the derived view OWNS. Everything else on the object the producer
 *  computed is carried through verbatim (identity, planType, resetCredits,
 *  corroborated, scopedFetchedAt, …) — this module projects the buckets, it
 *  does not curate the rest. */
const DERIVED_KEYS = ['fiveHour', 'sevenDay', 'scopedWeekly', 'overage'];

function atomicWrite(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

/**
 * THE write. `obj` is the legacy-shaped snapshot the producer computed (it
 * keeps whatever preserve-merge rules it already had); we lift it, merge its
 * limits into the file's, project the buckets back, and persist.
 *
 * @param {string} cacheDir
 * @param {string} key            the identity this reading is filed on (already resolved)
 * @param {object} obj            the producer's snapshot
 * @param {object} [set]          the TYPED set, when the producer built one (preferred —
 *                                a single-limit push must not be inferred from a
 *                                collapsed legacy object)
 * @param {number} [measuredAt]   when the WINDOWS were measured (ms). Separate from
 *                                `obj.fetchedAt` on purpose: the sibling fan-out marks a
 *                                bucket without promoting the file to "freshest", and a
 *                                window measured now must not lose the merge to an older file.
 * @param {string} [source]       the producer's own name (stamped per limit)
 * @param {function} [familyOf]   model-family resolver for scoped buckets
 * @param {string} [backend]      'claude' | 'codex' — shape hint for the lift
 * @param {function} [onRefuse]   called with (why, errors) when we refuse to write
 * @param {boolean} [replace]     REPLACE the file's limits instead of merging into them.
 *                                Exactly ONE caller may ask for this: the repair
 *                                migration, whose whole job is to remove a bucket
 *                                that is provably not this account's. Merging there
 *                                would resurrect what it just archived — so the
 *                                exception is NAMED rather than smuggled in by
 *                                writing the file behind this module's back.
 * @returns {{ok:boolean, why?:string, errors?:string[], limits?:Array, file?:string}}
 */
function writeCacheObject({ cacheDir, key, obj, set = null, measuredAt = null, source = null, familyOf = null, backend = null, onRefuse = null, replace = false }) {
  if (!cacheDir || !key) return { ok: false, why: 'no cacheDir/key' };
  const file = cacheFileFor(cacheDir, key);
  const at = Number(measuredAt) || Number(obj && obj.fetchedAt) || Date.now();
  let next = set;
  if (!next) next = liftCacheObject(obj, { identity: key, backend, familyOf, measuredAt: at });
  // Stamp the producer's name on every limit this write carries. A producer WE
  // SHIP always names itself — "unknown source, printed verbatim" is a rule for
  // producers we have never seen, and using it on our own is the honesty
  // feature telling a lie (2026-09-07 r3).
  if (source) {
    next = quotaModel.makeLimitSet({
      ...next,
      source,
      limits: next.limits.map((l) => ({ ...l, source: l.source || source })),
    });
  }
  const vNext = quotaModel.validateLimitSet(next);
  if (!vNext.ok) {
    const why = `refusing to write ${key}: the producer's limit set is malformed`;
    try { console.error('[usage-write]', why, vNext.errors.join('; ')); } catch { }
    try { onRefuse && onRefuse(why, vNext.errors); } catch { }
    return { ok: false, why, errors: vNext.errors };
  }
  let prevObj = null;
  if (!replace) { try { prevObj = JSON.parse(fs.readFileSync(file, 'utf-8')) || null; } catch { prevObj = null; } }
  let prevSet = quotaModel.makeLimitSet({ identity: key });
  if (prevObj) {
    prevSet = liftCacheObject(prevObj, { identity: key, backend, familyOf });
    const vPrev = quotaModel.validateLimitSet(prevSet);
    if (!vPrev.ok) {
      // A file already on disk being malformed must NEVER block a new reading —
      // that would make one bad write permanent. Drop its limits, say so, and
      // let this write re-establish the canonical half.
      try { console.warn('[usage-write] stored limits for', key, 'are malformed — rebuilding from this reading:', vPrev.errors.join('; ')); } catch { }
      prevSet = quotaModel.makeLimitSet({ identity: key });
    }
  }
  const merged = quotaModel.mergeLimitSets(prevSet, next);
  const view = quotaModel.toLegacyView(merged);
  const out = { ...(obj && typeof obj === 'object' ? obj : {}) };
  // THE DERIVED VIEW WINS over whatever the producer computed for the bucket
  // fields — that is the whole point: the producer knows about its own limit,
  // the projection knows about all of them. Non-bucket fields are the
  // producer's and are untouched.
  for (const k of DERIVED_KEYS) {
    if (view[k] !== undefined) out[k] = view[k];
    else if (k !== 'overage') delete out[k]; // never leave a stale bucket the model does not carry
  }
  out.limits = merged.limits;
  // `fetchedAt` IS NEVER INVENTED HERE. It means "this file was promoted to
  // freshest at t", the producers own that decision (the sibling fan-out
  // deliberately withholds it), and the repair writes an identity-only remnant
  // whose entire point is that NOTHING on it claims to be a reading.
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    atomicWrite(file, JSON.stringify(out));
  } catch (e) {
    return { ok: false, why: 'write failed: ' + e.message };
  }
  return { ok: true, file, limits: merged.limits, object: out };
}

/** The typed entry: a producer that built a LimitSet hands it here and never
 *  spells the legacy shape at all. `extras` are the non-bucket fields it wants
 *  persisted (identity, planType, …). */
function writeReading({ cacheDir, key, set, extras = null, source = null, familyOf = null, backend = null, onRefuse = null }) {
  const base = { ...(extras && typeof extras === 'object' ? extras : {}) };
  if (set && set.fetchedAt) base.fetchedAt = set.fetchedAt;
  if (source || (set && set.source)) base.source = source || set.source;
  if (set && set.extra) for (const [k, v] of Object.entries(set.extra)) if (base[k] === undefined) base[k] = v;
  return writeCacheObject({ cacheDir, key, obj: base, set, source: source || (set && set.source) || null, familyOf, backend, onRefuse });
}

/** A SIDECAR beside the cache (`.window-<key>`, `.slot-<id>`, …). Deliberately
 *  here: these files live in the same directory and must be written with the
 *  same atomicity, and the write-path census would otherwise have to allow
 *  arbitrary writers into the directory to serve them. Never `.json` — every
 *  usage-cache scanner filters on that suffix. */
function writeSidecar(cacheDir, name, payload) {
  if (/\.json$/.test(String(name))) throw new Error('a usage-cache sidecar must not end in .json — every scanner would pick it up');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    atomicWrite(path.join(cacheDir, name), typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  } catch { return false; }
}

module.exports = {
  cacheFileFor, isCacheFileName, readCacheObject,
  backendOfCacheObject, liftCacheObject, limitsOfCache,
  writeCacheObject, writeReading, writeSidecar,
  DERIVED_KEYS,
};
