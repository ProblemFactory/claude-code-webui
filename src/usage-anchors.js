// Quota dead-reckoning DATA FOUNDATION (user-designed, 2026-08-09): record
// every ground-truth usage reading (anchor) together with the ledger cost
// consumed since the previous anchor — the complete training set for the
// prediction system, improvable OFFLINE forever (rates/models re-derivable
// from raw pairs; we never store only a lossy EWMA). Zero API calls: anchors
// are whatever the passive statusline / human ⟳ / get_usage / limit banner
// already wrote; cost deltas come from the local usage-history ledger.
//
// PRIMARY KEY = IDENTITY KEY, not the minted account id (user requirement:
// tracking must survive remove + re-add of a subscription — a re-add mints a
// fresh sub-<hex> id). Precedence: Anthropic orgUuid (baked into usage-cache
// by the ⟳ roles fetch) > lowercased email (account record / cache) > the
// account id as last resort. Files: data/usage-anchors/anchors-<slug>.ndjson.
const fs = require('fs');
const path = require('path');

function identityKeyFor({ accountId, cache, email }) {
  if (cache?.orgUuid) return 'org:' + String(cache.orgUuid).toLowerCase();
  const em = email || cache?.orgEmail || cache?.email || null;
  if (em) return 'email:' + String(em).trim().toLowerCase();
  return 'acct:' + (accountId || '__global__');
}

class UsageAnchors {
  constructor({ dataDir }) {
    this.dir = path.join(dataDir, 'usage-anchors');
    this._last = new Map(); // identityKey → last recorded fetchedAt (dedup)
  }
  _file(key) { return path.join(this.dir, 'anchors-' + key.replace(/[^\w.@-]/g, '_').slice(0, 80) + '.ndjson'); }
  // Last recorded anchor for a key (tail line) — used by the engine to compute
  // the cost delta window and by future prediction code as the base point.
  lastAnchor(key) {
    try {
      const data = fs.readFileSync(this._file(key), 'utf-8');
      const nl = data.lastIndexOf('\n', data.length - 2);
      return JSON.parse(data.slice(nl + 1));
    } catch { return null; }
  }
  // Record one ground-truth reading. Dedup by fetchedAt (statusline rewrites
  // the same snapshot every 8s while a terminal runs). costSince = ledger cost
  // between the previous anchor's fetchedAt and this one, split by model
  // family so scoped-bucket (Fable) rates stay derivable offline.
  maybeRecord({ identityKey, accountId, cache, costSince, calib = null, accountIds = null, dark = null }) {
    if (!cache || !cache.fetchedAt) return false;
    const seen = this._last.get(identityKey) ?? this.lastAnchor(identityKey)?.fetchedAt ?? 0;
    if (cache.fetchedAt <= seen) { this._last.set(identityKey, seen); return false; }
    const prev = this.lastAnchor(identityKey);
    const rec = {
      ts: Date.now(), fetchedAt: cache.fetchedAt, source: cache.source || 'unknown',
      accountId: accountId || null, identityKey,
      // OFFLINE-BIAS honesty (2.297.0): hosts that were ACTIVE-DARK while this
      // reading's interval accrued — Δu is real but their cost is missing, so
      // learning must void pairs touching this record (extractPairs). Kept in
      // the raw record forever like everything else (models re-derive offline).
      ...(Array.isArray(dark) && dark.length ? { dark } : {}),
      buckets: {
        // status 'unknown' = a FABRICATED placeholder (data/bin/vibespace-usage
        // writes {utilization:0, status:'unknown', resetsAt:0} when a window is
        // absent from the payload) — anchoring it once and pairing with the
        // next real reading forged a du=+full pair that inflated the learned
        // rate ~6× (verifier repro). Record as no-bucket instead.
        fiveHour: cache.fiveHour && cache.fiveHour.status !== 'unknown' ? { u: cache.fiveHour.utilization, resetsAt: cache.fiveHour.resetsAt } : null,
        sevenDay: cache.sevenDay && cache.sevenDay.status !== 'unknown' ? { u: cache.sevenDay.utilization, resetsAt: cache.sevenDay.resetsAt } : null,
        // asOf: scoped readings only refresh via ⟳ (preserve-merged into
        // fresher caches) — record WHEN the reading was true so estimation
        // starts its cost window there, not at the anchor write.
        scopedWeekly: (cache.scopedWeekly || []).map((s) => ({ name: s.name, u: s.utilization, resetsAt: s.resetsAt, asOf: cache.scopedFetchedAt || undefined })),
      },
      prevFetchedAt: prev?.fetchedAt || null,
      elapsedSec: prev ? Math.round((cache.fetchedAt - prev.fetchedAt) / 1000) : null,
      costSince: costSince || null, // {total, byFamily:{fable,opus,sonnet,other}, requests}
    };
    // Calibration record (2.263.0): predicted-vs-actual per bucket, computed
    // by the caller from the PREVIOUS anchor + current learned rates. Lives in
    // the anchor itself so prediction quality is offline-analyzable forever.
    if (calib) rec.calib = calib;
    if (Array.isArray(accountIds) && accountIds.length > 1) rec.accountIds = accountIds;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this._file(identityKey), JSON.stringify(rec) + '\n');
      this._last.set(identityKey, cache.fetchedAt);
      return true;
    } catch { return false; }
  }
}

// Ledger cost between two times for one account id, split by model family —
// the "odometer reading" of the dead-reckoning pair.
function costBetween(usageHistory, accountId, fromMs, toMs) {
  return costBetweenMulti(usageHistory, [accountId || '__global__'], fromMs, toMs);
}
// Multi-id variant (one ledger pass): a single IDENTITY can span several
// account ids — the org-merge case (__global__ + the named sub are the same
// login) and remove+re-add (fresh sub-<hex> id, same identity). Cost must sum
// across all of them or the odometer under-reads.
// INTERVAL MEMO (2.369.36, inc-mtox23xw): learnRates asks for the cost of
// every historical anchor pair on every recompute (thousands of pairs, several
// recomputes a minute — one per new anchor) — the pairs never change, only
// the ledger grows. Key = ids + interval + the count of events at or before
// `to` (a late backfill INTO the interval changes that count ⇒ recompute)
// + the PRICE-TABLE token.
//
// PRICING IS PART OF THE VERSION (2.369.43): a pricing edit (a tier rate or a
// per-account discount, POST /api/usage-stats/pricing or a config import)
// changes every historical cost while the event count is untouched — without
// the token the memo served pre-edit dollars forever, so the learned rates and
// every anchor's costSince kept quoting the old price table (reproduced: a 10×
// tier edit AND a 50% account discount both returned the pre-edit total). No
// token available ⇒ NO memo: an un-versionable cost is never cached.
//
// ONE MEMO PER LEDGER (2.369.43): it hangs off the UsageHistory instance
// (WeakMap), so two ledgers can never read each other's costs through a key
// that names neither.
//
// RANDOM VICTIM, NOT FIFO (2.369.43): learnRates walks one identity's anchor
// pairs in the SAME order on every recompute — a cyclic reference string, the
// one access pattern where FIFO *and* LRU fall off a CLIFF rather than
// degrading (measured on this code: a 20000-key working set hits 100%, 21000
// hits 0.0%, and the per-pair ledger walk comes back). Anchor files are
// append-only forever (real production data: 5124 pairs over 28 days across 8
// identities, ~180 new pairs/day), so the cap IS reached — with a random
// victim the hit rate then decays as cap/working-set instead of vanishing.
const _costMemos = new WeakMap(); // UsageHistory → { map, keys }
const COST_MEMO_MAX = 20000;      // ≈10MB at ~530 bytes/entry (measured)
function _memoFor(usageHistory) {
  let m = _costMemos.get(usageHistory);
  if (!m) { m = { map: new Map(), keys: [] }; _costMemos.set(usageHistory, m); }
  return m;
}
function _memoPut(m, key, val) {
  // map and keys move in lockstep (only a MISS inserts, so `key` is new); the
  // length check keeps a future divergence from growing the map without bound
  if (m.map.size >= COST_MEMO_MAX && m.keys.length) {
    const j = Math.floor(Math.random() * m.keys.length);
    m.map.delete(m.keys[j]);
    m.keys[j] = m.keys[m.keys.length - 1];
    m.keys.pop();
  }
  m.map.set(key, val);
  m.keys.push(key);
}
function costBetweenMulti(usageHistory, accountIds, fromMs, toMs) {
  const want = new Set((accountIds || []).map((a) => a || '__global__'));
  const versioned = typeof usageHistory?._evCountUpTo === 'function' && typeof usageHistory?.pricingToken === 'function';
  const memo = versioned ? _memoFor(usageHistory) : null;
  const memoKey = versioned ? `${[...want].sort().join(',')}|${fromMs}|${toMs}|${usageHistory._evCountUpTo(toMs || Infinity)}|${usageHistory.pricingToken()}` : null;
  if (memoKey) { const hit = memo.map.get(memoKey); if (hit) return { ...hit, byFamily: { ...hit.byFamily }, byClass: { ...hit.byClass } }; }
  const out = { total: 0, byFamily: { fable: 0, opus: 0, sonnet: 0, haiku: 0, other: 0 }, byClass: { cw: 0, cr: 0, other: 0 }, requests: 0 };
  try {
    for (const ev of usageHistory._events(fromMs, toMs)) {
      // Same keying as the ledger aggregate: the two CLIs' machine logins are
      // DIFFERENT identities. The old bare '__global__' default silently
      // counted codex CLI-login events into the CLAUDE global identity's cost
      // (and starved '__global_codex__' of its own) — found wiring codex into
      // the estimator (P1, 2.368.18).
      const acct = ev.acct || (ev.be === 'codex' ? '__global_codex__' : '__global__');
      if (!want.has(acct)) continue;
      // Remote events RESOLVED to a real account (2.294.0 attribution) COUNT:
      // quota is a per-account global fact, and excluding another machine's
      // spend from the odometer is precisely the 1/7-coverage bias this
      // stack self-learns around — worse, after 2.294.0 the estimate ROSE
      // during a remote burn (live ring) then DROPPED when the harvest landed
      // (mid-excluded from the ring, host-excluded here: the spend visibly
      // un-counted itself). Only UNRESOLVED host-bucket events stay out —
      // 'that machine's own login' is not an estimable identity.
      if (ev.host && ev.atype === 'host') continue;
      if (ev.ts < fromMs || ev.ts > toMs) continue;
      const c = usageHistory._cost(ev);
      out.total += c; out.requests++;
      const m = String(ev.model || '').toLowerCase();
      const fam = m.includes('fable') ? 'fable' : m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : 'other';
      out.byFamily[fam] += c;
      // TOKEN-CLASS split (B-536b; 3-class since 2.268.1): the 5h bucket's
      // internal weighting differs per token class from our $ pricing —
      // cache WRITES burn ~half per $, cache READS are nearly free (real-data
      // fit: cw-full ~$443, cr-full ~$2556, fresh ~$185). cw and cr priced
      // alone; other = fresh input + output.
      const cw = usageHistory._cost({ ...ev, i: 0, o: 0, cr: 0 });
      const cr = usageHistory._cost({ ...ev, i: 0, o: 0, cw5: 0, cw1: 0 });
      out.byClass.cw += cw; out.byClass.cr += cr; out.byClass.other += Math.max(0, c - cw - cr);
    }
  } catch { }
  out.total = Math.round(out.total * 10000) / 10000;
  for (const k of Object.keys(out.byFamily)) out.byFamily[k] = Math.round(out.byFamily[k] * 10000) / 10000;
  for (const k of Object.keys(out.byClass)) out.byClass[k] = Math.round(out.byClass[k] * 10000) / 10000;
  if (memoKey) _memoPut(memo, memoKey, { ...out, byFamily: { ...out.byFamily }, byClass: { ...out.byClass } });
  return out;
}

module.exports = { UsageAnchors, identityKeyFor, costBetween, costBetweenMulti };
